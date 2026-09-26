import { formatGatewayPeerMessage, isGatewayPeerHeaderText } from './gatewaySessionProtocol.js'
import type { GatewaySessionTransport } from './gatewaySessionTransport.js'
import { getCommandQueue, removeByFilter } from './messageQueueManager.js'

/**
 * Peer requests sitting in the command queue, keyed by message ID.
 *
 * The queue is what makes "has this been delivered yet" decidable without
 * keeping a second ledger. A peer request reaches a session three ways: the
 * queue wakes an idle session, the mid-turn drain takes it between tool calls,
 * and this hook injects at a turn boundary. The queue is the one place all
 * three can see, so a request still in it at a turn boundary is one neither
 * queue path has run - the turn had no further tool iteration to drain at - and
 * the turn boundary is therefore where it belongs.
 *
 * Read as bus traffic, not as "any command from another session": the leaf wire
 * stamps its own turns on the same origin, and a leaf's handed-over turn has no
 * inbox record here, so claiming one would only strand it.
 */
export function queuedGatewayPeerIds(): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const command of getCommandQueue()) {
    if (command.origin?.kind === 'gateway-peer' && command.uuid && typeof command.value === 'string' && isGatewayPeerHeaderText(command.value)) ids.add(command.uuid)
  }
  return ids
}

/**
 * Delivery of a peer request the mid-turn drain could not reach.
 *
 * The command queue is the primary path: a peer message is enqueued like any
 * other prompt and drained between tool calls, so it is seen right after the
 * tool call in flight instead of at the end of the turn. That is the live
 * channel, and it renders with peer framing because the body opens with the
 * peer header.
 *
 * This hook covers the gap: a turn that has no further tool iteration never
 * reaches that drain again, so a message arriving late in such a turn would sit
 * in the queue until the session went idle. A Stop hook fires at exactly that
 * boundary, and because a hook has no way to speak from a callback that allows
 * the stop, it blocks - the injected text is its `errorMessage` - and the
 * continuation turn becomes the answer.
 *
 * The two therefore partition the space rather than race: whatever the drain
 * consumed is gone from the queue, and the hook claims only what is still
 * there.
 *
 * Two-phase acknowledgement, and why it is required:
 *
 * The naive version injects the pending records and acknowledges them
 * immediately. If the process dies between the injection and the transcript
 * write, the message is gone - the sender believes it was delivered and the
 * receiver never saw it. The opposite failure is worse: not acknowledging means
 * every turn end re-injects the same text, and the model answers the same
 * request forever.
 *
 * So the injection is acknowledged one turn LATER. At each Stop hook firing the
 * messages injected at the previous firing are acknowledged, because the turn
 * that contained them has now ended and the transcript holds them. A crash
 * before that leaves the record `queued`, so the worst case is a repeated
 * message - observable, and the text carries its own Message ID - rather than a
 * silently dropped one.
 */
export type PeerInjectionSource = Pick<GatewaySessionTransport, 'inbox' | 'acknowledge'>

export class GatewayPeerInjection {
  /** Injected at the previous firing; acknowledged at the next one. */
  private awaitingAcknowledgement = new Set<string>()
  /** Text produced for the most recent injection, read by the hook's errorMessage. */
  private lastInjection = ''

  constructor(private readonly source: PeerInjectionSource) {}

  /**
   * Records this hook should deliver now: queued in the inbox, still waiting in
   * the command queue, and not already injected by an earlier firing that has
   * yet to be acknowledged.
   *
   * `awaitingAcknowledgement` is the guard that keeps a blocking hook from
   * answering itself. The force-continued turn ends with the record still
   * `queued` in the inbox, so without this exclusion every firing would claim
   * the text it just injected and pay another continuation turn for it.
   */
  private claimable(pending: ReadonlySet<string>): string[] {
    return this.source
      .inbox()
      .filter(record => record.state === 'queued' && pending.has(record.message.id) && !this.awaitingAcknowledgement.has(record.message.id))
      .map(record => record.message.id)
  }

  /**
   * Run at a Stop hook firing.
   *
   * `undefined` when nothing is owed and the turn should be allowed to end: the
   * common case, where every turn end pays an inbox read and nothing more.
   * Otherwise the text to inject.
   */
  async next(pending: ReadonlySet<string>): Promise<string | undefined> {
    // Retire the previous injection first: that turn has ended, so its text is
    // in the transcript and the sender no longer needs it redelivered.
    for (const id of [...this.awaitingAcknowledgement]) {
      try {
        await this.source.acknowledge(id)
        this.awaitingAcknowledgement.delete(id)
      } catch {
        // Leave it outstanding; the next firing retries rather than dropping it.
      }
    }

    const ids = this.claimable(pending)
    if (ids.length === 0) return undefined

    const records = this.source.inbox().filter(record => ids.includes(record.message.id))
    this.lastInjection = records.map(formatGatewayPeerMessage).join('\n\n')
    for (const id of ids) this.awaitingAcknowledgement.add(id)
    // Take the request out of the command queue in the same breath as injecting
    // it. Leaving it there would let the idle-wake path run it a second time as
    // a user prompt - the exact rendering this hook exists to replace - and the
    // model would answer the same peer twice.
    removeByFilter(command => command.uuid !== undefined && ids.includes(command.uuid))
    return this.lastInjection
  }

  /** The text produced by the most recent successful `next`. */
  injectionText(): string {
    return this.lastInjection
  }

  close(): void {
    this.awaitingAcknowledgement.clear()
    this.lastInjection = ''
  }
}
