import { useEffect, useRef } from 'react'
import { getSessionId, getSessionResumeDirectory } from '../bootstrap/state.js'
import { GatewaySessionRuntime } from '../utils/gatewaySessionRuntime.js'
import { gatewayMessageIds } from '../utils/gatewaySessionDelivery.js'
import { registerGatewayPeerStopHook, type PeerStopHookHandle } from '../utils/gatewayPeerStopHook.js'
import { useSetAppState } from '../state/AppState.js'
import { appendSessionTopic, deriveSessionPurpose, deriveSessionTopic } from '../utils/gatewaySessionProtocol.js'
import type { Message } from '../types/message.js'
import { logForDebugging } from '../utils/debug.js'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import { leafLabel as leafLaunchLabel } from '../utils/leafTerminal.js'

/** The leaf's own name for itself, or nothing when this session is not a leaf. */
function leafLabel(): string | undefined {
  const label = leafLaunchLabel()?.replace(/\s+/g, ' ').trim()
  return label || undefined
}

/**
 * A leaf announces itself on the shared bus instead of looking like a stray
 * sibling session. The label wins outright rather than falling back to the
 * transcript: a forked leaf carries its parent's history, so deriving from
 * messages would advertise the parent's opening prompt and make the leaf
 * indistinguishable from the session it was forked from.
 *
 * The label is the advertised name as well as the intent, because it is what a
 * session listing another family's leaf has to go on: `Leaf 2: api (of session
 * …)` says which leaf it is and which conversation it belongs to, in one string
 * that cannot collide with the parent's title.
 */
function sessionPeerName(name: string): string {
  return (leafLabel() ?? name).slice(0, 200)
}

function sessionPurposeSeed(messages: Message[] | undefined, name: string): string {
  return leafLabel()?.slice(0, 1000) ?? deriveSessionPurpose(messages, name)
}

/**
 * How long to wait before re-attempting the bus registration, and so how many
 * re-attempts to make.
 *
 * The failure this exists for is a writer lock left behind by a process that is
 * gone: proper-lockfile keeps treating it as held until its 30-second staleness
 * window passes, and no attempt made inside that window can succeed. The waits
 * accumulate, so what has to outlast the window is their total rather than any
 * single one: the last attempt happens 42 seconds in, with the whole sequence
 * still completing inside the life of the session trying to register itself.
 */
const GATEWAY_REGISTRATION_RETRY_MS = [2_000, 10_000, 30_000]

/**
 * How long to wait between attempts once the fast schedule above is spent.
 *
 * The fast schedule is the retry for the one failure that heals inside its own
 * window. A blocker that outlives the window is what a session could not survive:
 * when the schedule ran out the registration stopped for good, so a session that
 * was alive and writing its transcript the whole time sat off the bus until a
 * second process for the same id replaced it. The long cadence is what makes the
 * retry outlast the blocker instead of the blocker outliving the retry. It is
 * slower than the fast schedule on purpose: by then the blocker is not a lock
 * about to expire but something that has to be cleared by hand.
 */
const GATEWAY_REGISTRATION_SLOW_RETRY_MS = 30_000

/**
 * The wait before the next registration attempt.
 *
 * Never undefined, and so never an instruction to stop: the schedule continues
 * for as long as the session lives. Exported because that property - not the
 * particular numbers - is the one a test can hold the loop to.
 */
export function gatewayRegistrationRetryDelay(attempt: number): number {
  return GATEWAY_REGISTRATION_RETRY_MS[attempt] ?? GATEWAY_REGISTRATION_SLOW_RETRY_MS
}

export function useGatewaySession(name: string, status: 'idle' | 'busy' | 'waiting', sessionMessages: Message[] | undefined): void {
  const sessionId = getSessionId()
  const peerName = sessionPeerName(name)
  const latest = useRef({ name: peerName, status })
  latest.current = { name: peerName, status }
  const runtimeRef = useRef<GatewaySessionRuntime | undefined>(undefined)
  const stopHookRef = useRef<PeerStopHookHandle | undefined>(undefined)
  const closing = useRef<Promise<void>>(Promise.resolve())
  // Stable across renders, so registering the hook cannot re-run the effect.
  const setAppState = useSetAppState()
  useEffect(() => {
    // A leaf is a live session like any other: it registers so a session outside
    // its family - another family's leaf included - can find it and message it
    // by ID or by the label it advertises here, and so it can answer. Family
    // traffic keeps its own channel and does not depend on this bus; the label
    // is what stops a forked leaf from being mistaken for the session it copied.
    if (process.env.CLAUDE_CODE_USE_GATEWAY !== '1') return
    // The registration advertises where this conversation is resumed from, not
    // the live cwd: the cwd moves with the worktree you are working in, so a
    // listing that read it could name a directory this session cannot be
    // resumed from. This effect re-runs on every session switch, so a resume
    // picks up the directory that switch just set.
    let disposed = false
    // The runtime the attempt loop currently owns. Held here rather than only in
    // the ref because a failed attempt is discarded and replaced, and cleanup has
    // to close whichever one exists then - including none, between attempts.
    let active: GatewaySessionRuntime | undefined
    // Ends the backoff below early, so that closing never waits out a retry.
    let wake: (() => void) | undefined
    const started = closing.current.then(async () => {
      // Registration used to be a single attempt whose failure went to a debug
      // log that is a no-op outside debug mode, so a session that lost the writer
      // claim - or was refused because a lock a crashed process left behind still
      // looked fresh - stayed off the bus for its whole life with nothing
      // anywhere saying so. The attempt is retried over a window longer than that
      // lock's own staleness, which is the failure that heals itself: the lock
      // becomes acquirable the moment the window passes. Past that window the
      // retry does not stop, because the blockers that outlive it - a lock still
      // refreshed by a live holder that will release it, a probe that timed out
      // once, a registration the next attempt will find dead - heal later than any
      // schedule can predict. Stopping there was the defect: the session was alive
      // and writing its transcript while absent from the bus, and only a new
      // process ever put it back.
      for (let attempt = 0; !disposed; attempt++) {
        if (getSessionId() !== sessionId) return
        const runtime = new GatewaySessionRuntime(sessionId, getSessionResumeDirectory(), name)
        active = runtime
        try {
          await runtime.start(gatewayMessageIds(sessionMessages ?? []))
        } catch (error) {
          if (active === runtime) active = undefined
          await runtime.close().catch(() => {})
          if (disposed) return
          // Logged once, when the fast schedule is spent and the long cadence
          // takes over, so a session that cannot register keeps a reason a person
          // can read without the cadence writing it every half minute.
          if (attempt === GATEWAY_REGISTRATION_RETRY_MS.length) {
            logForDebugging(`Gateway session communication could not start, retrying on a long cadence: ${error instanceof Error ? error.message : String(error)}`)
          }
          await new Promise<void>(resolve => {
            const timer = setTimeout(() => { wake = undefined; resolve() }, gatewayRegistrationRetryDelay(attempt))
            wake = () => { clearTimeout(timer); wake = undefined; resolve() }
          })
          continue
        }
        if (disposed || getSessionId() !== sessionId) {
          if (active === runtime) active = undefined
          await runtime.close().catch(() => {})
          return
        }
        runtimeRef.current = runtime
        // The Stop hook is the turn-boundary half of delivery. The queue half is
        // already live inside the runtime; without this a busy session only sees
        // peer traffic mid-turn, as injection this hook exists to replace.
        const stopHook = registerGatewayPeerStopHook(setAppState, runtime)
        if (disposed) {
          stopHook.remove()
          if (active === runtime) active = undefined
          await runtime.close().catch(() => {})
          return
        }
        stopHookRef.current = stopHook
        // Seed intent only while it is unstated. An explicit declaration outranks
        // the derived one, and a later name/status refresh must never clobber it.
        const purpose = runtime.transport.peer.purpose.trim() ? runtime.transport.peer.purpose : sessionPurposeSeed(sessionMessages, name)
        await runtime.transport.update({ name: latest.current.name, status: latest.current.status === 'busy' ? 'running' : latest.current.status === 'waiting' ? 'awaiting-approval' : 'idle', purpose }).catch(() => { logForDebugging('Gateway session status update failed.') })
        return
      }
    }).catch(() => { logForDebugging('Gateway session communication could not start.') })
    const close = async () => {
      disposed = true
      wake?.()
      // Before the transport closes: a turn ending mid-shutdown would otherwise
      // fire the callback against a closed inbox.
      stopHookRef.current?.remove()
      stopHookRef.current = undefined
      active?.delivery.close()
      await started
      if (runtimeRef.current === active) runtimeRef.current = undefined
      await active?.close().catch(() => { logForDebugging('Gateway session communication cleanup failed.') })
    }
    const unregister = registerCleanup(close)
    return () => {
      unregister()
      closing.current = close()
    }
  }, [sessionId])
  useEffect(() => {
    void runtimeRef.current?.transport.update({ name: peerName, status: status === 'busy' ? 'running' : status === 'waiting' ? 'awaiting-approval' : 'idle' }).catch(() => { logForDebugging('Gateway session status update failed.') })
  }, [peerName, status])
  // Refresh the advertised topics as the session takes new work. Purpose is
  // frozen at the opening prompt by design, so without this a session that
  // moves on (a stack question becoming a 2D-platformer discussion) stayed
  // discoverable only under the topic it had already finished. Guarded on the
  // derived topic changing, so this writes once per real request rather than
  // once per render.
  const lastTopic = useRef('')
  useEffect(() => {
    const runtime = runtimeRef.current
    if (!runtime) return
    const topic = deriveSessionTopic(sessionMessages)
    if (!topic || topic === lastTopic.current) return
    lastTopic.current = topic
    const next = appendSessionTopic(runtime.transport.peer.topics, topic)
    void runtime.transport.update({ topics: next }).catch(() => { logForDebugging('Gateway session topic update failed.') })
  }, [sessionMessages])
}
