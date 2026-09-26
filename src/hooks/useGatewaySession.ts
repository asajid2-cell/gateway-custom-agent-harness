import { useEffect, useRef } from 'react'
import { getSessionId } from '../bootstrap/state.js'
import { getCwd } from '../utils/cwd.js'
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
    const runtime = new GatewaySessionRuntime(sessionId, getCwd(), name)
    let disposed = false
    const started = closing.current.then(async () => {
      if (disposed) return
      await runtime.start(gatewayMessageIds(sessionMessages ?? []))
      if (disposed || getSessionId() !== sessionId) return
      runtimeRef.current = runtime
      // The Stop hook is the turn-boundary half of delivery. The queue half is
      // already live inside the runtime; without this a busy session only sees
      // peer traffic mid-turn, as injection this hook exists to replace.
      const stopHook = registerGatewayPeerStopHook(setAppState, runtime)
      if (disposed) {
        stopHook.remove()
        return
      }
      stopHookRef.current = stopHook
      // Seed intent only while it is unstated. An explicit declaration outranks
      // the derived one, and a later name/status refresh must never clobber it.
      const purpose = runtime.transport.peer.purpose.trim() ? runtime.transport.peer.purpose : sessionPurposeSeed(sessionMessages, name)
      await runtime.transport.update({ name: latest.current.name, status: latest.current.status === 'busy' ? 'running' : latest.current.status === 'waiting' ? 'awaiting-approval' : 'idle', purpose })
    }).catch(() => { logForDebugging('Gateway session communication could not start.') })
    const close = async () => {
      disposed = true
      // Before the transport closes: a turn ending mid-shutdown would otherwise
      // fire the callback against a closed inbox.
      stopHookRef.current?.remove()
      stopHookRef.current = undefined
      runtime.delivery.close()
      await started
      if (runtimeRef.current === runtime) runtimeRef.current = undefined
      await runtime.close().catch(() => { logForDebugging('Gateway session communication cleanup failed.') })
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
