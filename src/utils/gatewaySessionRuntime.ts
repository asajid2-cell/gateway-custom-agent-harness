import type { UUID } from 'crypto'
import { onSessionWillSwitch } from '../bootstrap/state.js'
import { join } from 'path'
import { GatewaySessionTransport, listGatewayPeers } from './gatewaySessionTransport.js'
import { GatewaySessionDelivery } from './gatewaySessionDelivery.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { logForDebugging } from './debug.js'
import { enqueue, removeByFilter } from './messageQueueManager.js'
import { isInteractiveLeaf } from './leafTerminal.js'
import { startSessionReaper } from './sessionReaper.js'
import type { GatewayPeer, GatewayInboundPolicy } from './gatewaySessionProtocol.js'
import { loadSessionCompactionCounts, subscribeSessionCompactionCounts } from './sessionCompactionCounts.js'
import { getTranscriptPathForSession } from './sessionStorage.js'

const runtimes = new Map<string, GatewaySessionRuntime>()
export function getGatewaySessionRuntime(sessionId: string): GatewaySessionRuntime | undefined { return runtimes.get(sessionId) }

/**
 * Why a session's bus registration is not live, when it has tried and failed.
 *
 * Registration is attempted once per session id from the REPL's mount effect,
 * and every failure used to be swallowed into a debug log that is a no-op unless
 * debug mode is on. A session that never reached the bus therefore looked
 * exactly like one that had: `/sessions`, the panel and the peer skill all said
 * "unavailable", and a peer that tried to reach it was told the session had
 * exited. The reason is kept here so those surfaces can say what actually
 * happened, and so the answer survives the runtime that failed.
 */
const startFailures = new Map<string, string>()

/** What the comms surfaces should say about a session that has no runtime. */
export type GatewaySessionCommsState =
  | { state: 'live' }
  | { state: 'starting' }
  | { state: 'failed'; reason: string }
  | { state: 'disabled'; reason: string }

export function gatewaySessionCommsState(sessionId: string): GatewaySessionCommsState {
  if (runtimes.has(sessionId)) return { state: 'live' }
  // Checked before the recorded failure: the env gate is why no attempt was
  // made at all. A session launched outside the launcher that sets it (a
  // hand-run cli, a probe build) never registers, and nothing about its own
  // configuration says so - this is the only place that can name the reason.
  if (process.env.CLAUDE_CODE_USE_GATEWAY !== '1') {
    return { state: 'disabled', reason: 'this session was launched without peer comms enabled (CLAUDE_CODE_USE_GATEWAY is not 1)' }
  }
  const reason = startFailures.get(sessionId)
  return reason === undefined ? { state: 'starting' } : { state: 'failed', reason }
}

/**
 * One line a surface can show when it has found no runtime for this session.
 *
 * Undefined only when the session really is live, so a caller that already knows
 * it is not can report the reason without deciding which case it is in.
 */
export function gatewaySessionCommsProblem(sessionId: string): string | undefined {
  const state = gatewaySessionCommsState(sessionId)
  if (state.state === 'live') return undefined
  return state.state === 'starting' ? 'this session is still registering on the peer bus' : state.reason
}

export class GatewaySessionRuntime {
  readonly transport: GatewaySessionTransport
  readonly delivery: GatewaySessionDelivery
  private readonly pendingIds = new Set<string>()
  private unsubscribeSwitch: (() => void) | undefined
  private closing: Promise<void> | undefined
  private ready = false
  private stopReaper: (() => void) | undefined
  private unsubscribeCounts: (() => void) | undefined
  constructor(sessionId: string, cwd: string, name: string) {
    this.transport = new GatewaySessionTransport({
      directory: join(getClaudeConfigHomeDir(), 'gateway-sessions'), sessionId, cwd, name,
      onInboxChanged: () => { if (this.ready) this.delivery.drain() },
    })
    this.delivery = new GatewaySessionDelivery(this.transport, (id, text) => {
      this.pendingIds.add(id)
      enqueue({ value: text, mode: 'prompt', priority: 'next', uuid: id as UUID, skipSlashCommands: true, isMeta: true, origin: { kind: 'gateway-peer' } })
      // A leaf nobody is watching is paused, so its queue drains only once its
      // REPL renders again. A peer message is not the person typing, so it
      // cannot wait for the person to look: wake the input the same way the
      // family channel does. Nothing is written to it.
      if (isInteractiveLeaf()) {
        void import('./leafTerminal.js').then(leaf => leaf.wakeLeafInput()).catch(() => {})
      }
    }, id => { this.pendingIds.delete(id) })
  }
  private starting: Promise<void> | undefined
  start(persistedIds: ReadonlySet<string>): Promise<void> {
    if (this.closing) return Promise.reject(new Error('Gateway runtime is closed'))
    if (this.starting) return this.starting
    this.unsubscribeSwitch = onSessionWillSwitch(id => {
      if (id === this.transport.peer.sessionId) void this.close().catch(() => {})
    })
    this.starting = (async () => {
      try {
        await (await import('./gatewaySessionOwnership.js')).claimGatewaySessionWriter(this.transport.peer.sessionId)
        if (this.closing) return
        // Compaction counts are decoration on the peer record, not a
        // registration precondition: a fault reading the checkpoint (an IO
        // error on the transcript, a corrupt checkpoint the reader surfaces
        // rather than swallows) must not take the session off the bus. Degrade
        // to "no counts" and let the rest of start() stay strict - the claim,
        // the publish and the reconcile below are what registration is.
        try {
          const counts = await loadSessionCompactionCounts(this.transport.peer.sessionId, getTranscriptPathForSession(this.transport.peer.sessionId))
          this.transport.setCompactionCounts(counts)
        } catch (error) {
          logForDebugging(`[gateway] compaction counts unavailable for ${this.transport.peer.sessionId} · ${error instanceof Error ? error.message : String(error)}`, { level: 'warn' })
        }
        if (this.closing) return
        await this.transport.start()
        if (this.closing) return
        this.unsubscribeCounts = subscribeSessionCompactionCounts((id, nextCounts) => {
          if (id !== this.transport.peer.sessionId || this.closing) return
          this.transport.setCompactionCounts(nextCounts)
          void this.transport.update(nextCounts).catch(() => {})
        })
        await this.delivery.reconcilePersisted(persistedIds)
        if (this.closing) return
        runtimes.set(this.transport.peer.sessionId, this)
        startFailures.delete(this.transport.peer.sessionId)
        this.ready = true
        // Registered is the moment this process becomes something nobody can
        // attribute and nothing closes, so it is also the moment the idle rules
        // start watching it. Started after publication so a session that fails
        // to register does not leave a timer behind.
        this.stopReaper = startSessionReaper()
        this.delivery.drain()
      } catch (error) {
        // The attempt is not retried by this runtime - its transport is closed -
        // so the reason has to outlive it for the surfaces to be able to report
        // it. The caller may well build a fresh runtime and succeed. Recorded
        // before the teardown below, because teardown is best-effort: an error
        // about the cleanup must not be able to replace the reason this start
        // failed, or leave the session reading as "still registering" forever.
        startFailures.set(this.transport.peer.sessionId, error instanceof Error ? error.message : String(error))
        this.unsubscribeSwitch?.()
        this.unsubscribeSwitch = undefined
        this.delivery.close()
        await this.transport.close().catch(() => {})
        throw error
      }
    })()
    return this.starting
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.stopReaper?.()
    this.stopReaper = undefined
    this.unsubscribeSwitch?.()
    this.unsubscribeSwitch = undefined
    this.unsubscribeCounts?.()
    this.unsubscribeCounts = undefined
    if (runtimes.get(this.transport.peer.sessionId) === this) runtimes.delete(this.transport.peer.sessionId)
    this.delivery.close()
    removeByFilter(command => command.uuid !== undefined && this.pendingIds.has(command.uuid))
    // Release the writer claim the runtime took when it started. Without this the
    // claim lives in the ownership map until process cleanup, which runs after
    // the config home it was taken in may be gone - and a release that stats a
    // vanished lock throws. Closing is when the runtime stops being the writer,
    // so it is where the claim should end.
    this.closing = (this.starting ?? Promise.resolve()).catch(() => {})
      .then(() => this.transport.close())
      .then(async () => { await (await import('./gatewaySessionOwnership.js')).releaseGatewaySessionWriter(this.transport.peer.sessionId) })
      .catch(() => {})
    return this.closing
  }
  list(): Promise<GatewayPeer[]> { return listGatewayPeers(join(getClaudeConfigHomeDir(), 'gateway-sessions')) }
  setPolicy(policy: GatewayInboundPolicy): Promise<void> {
    return this.transport.setPolicy(policy, () => {
      const withdrawn = removeByFilter(command => command.uuid !== undefined && this.pendingIds.has(command.uuid))
      const ids = new Set(withdrawn.map(command => command.uuid!))
      return {
        ids,
        rollback: () => { for (const command of withdrawn) enqueue(command) },
        commit: () => { this.delivery.releaseQueued(ids); for (const id of ids) this.pendingIds.delete(id) },
      }
    })
  }
}
