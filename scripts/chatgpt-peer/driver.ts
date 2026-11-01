/**
 * The page driver as a child process.
 *
 * Playwright stays out of this repository: the child owns Chrome and the
 * selectors, and speaks one JSON object per line. The host keeps the bus, which
 * is the part that must not drift from the harness.
 *
 * Three kinds of line arrive on stdout:
 *
 * - a reply, carrying the `id` of the request it answers;
 * - `{event:'accepted', id}`, saying a page turn took that request's message;
 * - `{event:...}` of any other kind, a push the page volunteered.
 *
 * They are routed by ID, never by arrival order. A timed-out request is not
 * cancelled: the child keeps working on it and answers whenever it finishes.
 * With a FIFO queue that late answer would be handed to whichever request is
 * now waiting - the next inbound would be settled with the previous inbound's
 * text. An id makes a late reply identifiable and safe to drop, and it keeps
 * an event from ever settling a request that is not its own.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

export type DriverReply = { ok: boolean; op?: string; id?: string; [key: string]: unknown }
export type DriverEvent = { event: string; [key: string]: unknown }
export type CallOptions = { timeoutMs?: number; onAccepted?: (id: string) => void }

/**
 * How long a graceful shutdown lets an in-progress page operation run before
 * the child is forced. The drain honours the in-flight operation's own
 * deadline, so a twenty-minute page turn is not cut short. When nothing is in
 * flight the floor keeps a wedged child from holding a shutdown open
 * indefinitely. terminate() is the always-forced path.
 */
const MIN_DRAIN_MS = 10_000

/**
 * How long a graceful drain may run: the latest in-flight operation's own
 * deadline, floored at MIN_DRAIN_MS when nothing is in flight. A fixed
 * five-minute ceiling used to cut a twenty-minute page turn in half; the
 * operation's deadline is already bounded, so it is the bound. A deadline
 * that has already passed falls back to the floor rather than never firing.
 */
export function drainGraceMs(latestDeadline: number, nowMs: number = Date.now()): number {
  if (!(latestDeadline > 0)) return MIN_DRAIN_MS
  return Math.max(MIN_DRAIN_MS, latestDeadline - nowMs)
}

/**
 * How long a child may emit NOTHING before a timeout counts as a wedge.
 *
 * A page turn is budgeted at twenty minutes and the host polls its status
 * every couple of seconds, so a child that has said nothing at all for two
 * minutes is not slow - it is stuck. This is the explicit, defensible
 * interval the replacement decision uses; a child that is still talking
 * (status replies, page pushes, an `accepted` line) is never replaced on the
 * strength of one slow request.
 */
export const DEFAULT_WEDGE_MS = 120_000

/**
 * How long PAST the send ceiling an accepted request may stay unanswered before
 * its reply is presumed lost rather than still coming.
 *
 * The child accepts a send, works, and answers on the same request. A reply
 * that never arrives while the child keeps answering LATER requests is not work
 * in flight - it is a lost frame (the live incident: `r206` ran to completion
 * and its reply never reached the host, which then suppressed replacement for
 * 24 minutes because the accepted id counted as "busy"). Age separates the two:
 * an accepted id older than the ceiling plus this margin cannot still be a
 * legitimate turn, so it stops blocking recovery.
 */
export const DEFAULT_LOST_REPLY_MARGIN_MS = 60_000

/** A log-friendly age: minutes for the live scale, tenths of a second in tests. */
const humanAge = (ms: number): string =>
  ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.max(0, ms / 1000).toFixed(1)}s`

/**
 * A reply that failed because the DRIVER failed - it timed out, was replaced,
 * or was closed - says nothing about the page. Callers must treat it as "no
 * evidence yet" and keep their own clock, never as a page refusal or a model
 * failure.
 */
export function isDriverFault(text: string): boolean {
  return /driver (was replaced|is closed|exited|timed out)|could not write to the driver/i.test(text)
}

/**
 * The same judgement on a whole reply, which is the form `call()` returns.
 *
 * The driver states `reason: 'timeout'` structurally for its own deadline, so a
 * timeout is classified by shape and not by the wording of `error`; the text
 * check still covers a replacement, a closed driver, or a wrapped error string.
 */
export function isDriverFaultReply(reply: { ok?: unknown; reason?: unknown; error?: unknown; [key: string]: unknown }): boolean {
  return reply.reason === 'timeout' || isDriverFault(String(reply.error ?? ''))
}

export class DriverChild {
  private child?: ChildProcessWithoutNullStreams
  /**
   * A waiter belongs to the child generation that accepted the request. If a
   * forced kill or a reopen replaces the child before an old one exits, that
   * old exit must settle only its own requests - never the new child's.
   */
  private readonly pending = new Map<string, { generation: number; finish: (reply: DriverReply) => void }>()
  /**
   * The acceptor for a request is held until that request's `accepted` line
   * arrives, so two sends in flight each hear about their own message. An id
   * with no live waiter (a request that already timed out, or a turn from a
   * previous turn that is still finishing) is dropped rather than handed to
   * whoever happens to be waiting now.
   */
  private readonly acceptors = new Map<string, (id: string) => void>()
  /**
   * Requests the page told us it took, by id, the child generation that took
   * them, and when. Used to name the work a timeout recovery abandons; the
   * timestamp is what separates a long turn from a LOST REPLY - the live defect
   * where one lost frame kept the accepted id "in flight" for the child's whole
   * life. An id leaves this set when it is settled or its child exits.
   */
  private readonly accepted = new Map<string, { generation: number; at: number }>()
  /**
   * The bound timer for each accepted id: when it fires, the id is past its own
   * deadline plus the margin with no reply, so the reply was LOST. One lost
   * frame must not wait for some later request to time out - the live incident
   * had no later request for four minutes, and none at all would have meant the
   * child never recovered. Cleared when the id settles, its child exits, or the
   * child is replaced.
   */
  private readonly lostTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** When each in-flight request's own deadline falls, for a graceful drain. */
  private readonly deadlines = new Map<string, number>()
  /**
   * When the child last emitted ANY line: a reply, an `accepted`, a push. It is
   * the evidence that the child is alive, so a request timing out next to a
   * talking child is that request's problem, not the child's.
   */
  private lastLineAt = 0
  private readonly listeners = new Set<(event: DriverEvent) => void>()
  private closed = false
  private sequence = 0
  /** Bumped for every spawn; a line or exit from an older generation is stale. */
  private generation = 0

  constructor(private readonly options: {
    script: string
    profile?: string
    log?: (line: string) => void
    timeoutMs?: number
    /** How long the child may be silent before a timeout is treated as a wedge. */
    wedgeMs?: number
    /**
     * How long past the send ceiling an accepted reply may be overdue before it
     * is presumed lost and no longer suppresses replacement. Tests shorten it.
     */
    lostReplyMarginMs?: number
  }) {}

  /**
   * Called for every non-`accepted` event line. Returns an unsubscribe so a
   * reloading host does not stack handlers.
   */
  onEvent(handler: (event: DriverEvent) => void): () => void {
    this.listeners.add(handler)
    return () => { this.listeners.delete(handler) }
  }

  private log(line: string): void {
    this.options.log?.(line)
  }

  private get wedgeMs(): number {
    const configured = this.options.wedgeMs
    return typeof configured === 'number' && configured >= 0 ? configured : DEFAULT_WEDGE_MS
  }

  private lostReplyMargin(): number {
    const configured = this.options.lostReplyMarginMs
    return typeof configured === 'number' && configured >= 0 ? configured : DEFAULT_LOST_REPLY_MARGIN_MS
  }

  /**
   * When an accepted id's reply is presumed lost.
   *
   * The id's OWN request deadline is the honest ceiling when it is still known:
   * `call()` records it in `deadlines` and deletes it on settle, so a send made
   * with a shorter per-call timeout is bounded by that timeout, not by the
   * construction default. An accepted id with no live waiter (its request had
   * already timed out when the page announced it) has no deadline left - that is
   * the leak the live incident hung on - so it falls back to the construction
   * timeout. The margin is added either way.
   */
  private lostReplyBoundAt(id: string, acceptedAt: number): number {
    const deadline = this.deadlines.get(id)
    const ceilingAt = typeof deadline === 'number' && deadline > 0 ? deadline : acceptedAt + (this.options.timeoutMs ?? 600_000)
    return ceilingAt + this.lostReplyMargin()
  }

  /** Arm (or re-arm) the timer that presumes `id` lost at its own bound. */
  private armLostReplyTimer(id: string, generation: number, delayMs?: number): void {
    const entry = this.accepted.get(id)
    if (!entry || entry.generation !== generation) return
    const delay = delayMs ?? this.lostReplyBoundAt(id, entry.at) - Date.now()
    this.clearLostReplyTimer(id)
    const timer = setTimeout(() => this.lostReplyTimerFired(id, generation), Math.max(0, delay))
    const unref = (timer as unknown as { unref?: () => void }).unref
    if (unref) unref.call(timer)
    this.lostTimers.set(id, timer)
  }

  private clearLostReplyTimer(id: string): void {
    const timer = this.lostTimers.get(id)
    if (!timer) return
    clearTimeout(timer)
    this.lostTimers.delete(id)
  }

  private clearLostReplyTimers(): void {
    for (const id of [...this.lostTimers.keys()]) this.clearLostReplyTimer(id)
  }

  /**
   * The bound passed with no reply, and no request had to time out to say so.
   *
   * This is the QUIET shape: an accepted id that never settles is exactly the
   * live incident, where nothing else was in flight for four minutes and the
   * child would otherwise have gone unreplaced for its whole life. It takes the
   * same distinct lost-reply replacement path as the timeout trigger.
   *
   * The young-id rule still holds: a DIFFERENT accepted id that is still inside
   * its own bound is genuine work in flight, so this overdue reply does not get
   * to kill the child under it. The timer looks again when that id's own bound
   * falls.
   */
  private lostReplyTimerFired(id: string, generation: number): void {
    this.lostTimers.delete(id)
    if (generation !== this.generation) return
    const entry = this.accepted.get(id)
    if (!entry || entry.generation !== generation) return
    const now = Date.now()
    const young = [...this.accepted]
      .filter(([other, otherEntry]) => otherEntry.generation === generation && other !== id && now <= this.lostReplyBoundAt(other, otherEntry.at))
      .map(([other, otherEntry]) => ({ id: other, boundAt: this.lostReplyBoundAt(other, otherEntry.at) }))
    if (young.length > 0) {
      const next = Math.min(...young.map(one => one.boundAt))
      this.log(`driver: no reply for ${id} (accepted ${humanAge(now - entry.at)} ago), but accepted work is still in flight: ${young.map(one => one.id).join(', ')}; leaving it running`)
      this.armLostReplyTimer(id, generation, Math.max(25, next - now + 25))
      return
    }
    const lost = [...this.accepted]
      .filter(([other, otherEntry]) => otherEntry.generation === generation && (other === id || now > this.lostReplyBoundAt(other, otherEntry.at)))
      .map(([other, otherEntry]) => ({ id: other, ageMs: now - otherEntry.at }))
    this.logLost(lost)
    this.replaceChild(generation, `driver was replaced after the reply to ${id} was lost`)
  }

  /** The one distinct line a lost reply is reported with, from either trigger. */
  private logLost(lost: { id: string; ageMs: number }[]): void {
    const named = lost.map(one => `${one.id} (accepted ${humanAge(one.ageMs)} ago)`).join(', ')
    this.log(`driver: no reply arrived for ${named}; the reply was lost, not a plain timeout - replacing the child`)
  }

  /**
   * Kill the generation's child, fail its waiters, and forget its accepted ids
   * and their bound timers. Shared by both replacement triggers so a lost reply
   * and a wedged timeout leave the bus in the same state.
   */
  private replaceChild(generation: number, reason: string): void {
    const child = this.child
    this.child = undefined
    if (child && child.exitCode === null) { try { child.kill() } catch { /* already gone */ } }
    for (const [id, waiter] of [...this.pending]) {
      if (waiter.generation !== generation) continue
      waiter.finish({ ok: false, id, error: reason })
    }
    for (const [id, entry] of [...this.accepted]) {
      if (entry.generation !== generation) continue
      this.accepted.delete(id)
      this.clearLostReplyTimer(id)
    }
  }

  private ensure(): ChildProcessWithoutNullStreams {
    // After kill() the driver is closed for good: a new child is reachable only
    // through an explicit reopen(), never as a side effect of a late call.
    if (this.closed) throw new Error('driver is closed')
    if (this.child && this.child.exitCode === null) return this.child
    const generation = ++this.generation
    const env = { ...process.env, ...(this.options.profile ? { CHATGPT_PROFILE: this.options.profile } : {}) }
    const child = spawn(process.execPath, [this.options.script, 'serve'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env })
    // A fresh child counts as having spoken at the moment it was spawned: the
    // wedge clock measures silence, and launching is not silence.
    this.lastLineAt = Date.now()
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    createInterface({ input: child.stdout }).on('line', line => this.handleLine(line, generation))
    createInterface({ input: child.stderr }).on('line', line => {
      if (line.trim()) this.log(`driver: ${line.trim().slice(0, 400)}`)
    })
    child.on('exit', code => {
      const reason = `driver exited (code ${code ?? 'null'})`
      this.log(reason)
      // Only the current child may clear the current child. An old child that
      // exits after reopen()/timeout recovery left this.child pointing at its
      // replacement, and clearing it here would orphan that replacement.
      if (this.child === child) this.child = undefined
      // Settle this generation's waiters only; they carry the generation.
      for (const [id, waiter] of [...this.pending]) {
        if (waiter.generation !== generation) continue
        waiter.finish({ ok: false, id, error: reason })
        this.acceptors.delete(id)
      }
      for (const [id, entry] of [...this.accepted]) {
        if (entry.generation !== generation) continue
        this.accepted.delete(id)
        this.clearLostReplyTimer(id)
      }
    })
    child.stdin.on('error', () => {})
    this.child = child
    return child
  }

  private handleLine(line: string, generation: number): void {
    // A line from a child that has been replaced is stale: it can neither
    // settle a newer request nor push an event on behalf of the current page.
    if (generation !== this.generation) {
      if (line.trim()) this.log(`driver: stale line from an older child: ${line.trim().slice(0, 120)}`)
      return
    }
    // ANY line from the current child - a reply, an `accepted`, a page push,
    // even one this host cannot parse - is proof the child is alive. Only
    // silence counts towards a wedge.
    this.lastLineAt = Date.now()
    const trimmed = line.trim()
    if (!trimmed) return
    let message: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        this.log(`driver: line is not an object ${trimmed.slice(0, 120)}`)
        return
      }
      message = parsed as Record<string, unknown>
    } catch {
      this.log(`driver: unparsable line ${trimmed.slice(0, 120)}`)
      return
    }
    const id = typeof message.id === 'string' ? message.id : ''
    const event = typeof message.event === 'string' ? message.event : ''
    if (event) {
      if (event === 'accepted') {
        // Remember acceptance even without a callback: it is what the timeout
        // recovery has to account for as accepted-but-unfinished work, and its
        // age is what tells a slow turn from a lost reply.
        if (id) {
          this.accepted.set(id, { generation, at: Date.now() })
          // The reply may never come and no later request may ever time out to
          // notice; the bound has to fire on its own.
          this.armLostReplyTimer(id, generation)
        }
        const accept = id ? this.acceptors.get(id) : undefined
        if (!accept) {
          this.log(`driver: accepted for ${id || 'no id'} has no live waiter; dropped`)
          return
        }
        this.acceptors.delete(id)
        try { accept(id) } catch (error) { this.log(`driver: accepted handler threw: ${(error as Error).message}`) }
        return
      }
      this.dispatch({ ...message, event })
      return
    }
    if (!id) {
      this.log(`driver: reply without a request id: ${trimmed.slice(0, 120)}`)
      return
    }
    const waiter = this.pending.get(id)
    if (!waiter) {
      this.log(`driver: late reply for ${id} dropped (that request already timed out)`)
      return
    }
    // `finish` owns the cleanup: it deletes the pending entry and the acceptor
    // together, so a request is settled exactly once from either path.
    this.acceptors.delete(id)
    waiter.finish(message as DriverReply)
  }

  private dispatch(event: DriverEvent): void {
    for (const listener of this.listeners) {
      try { listener(event) } catch (error) { this.log(`driver: event handler threw: ${(error as Error).message}`) }
    }
  }

  async call(request: Record<string, unknown>, options: number | CallOptions = this.options.timeoutMs ?? 600_000): Promise<DriverReply> {
    if (this.closed) return { ok: false, error: 'driver is closed' }
    const settings = typeof options === 'number' ? { timeoutMs: options } : options
    const timeoutMs = settings.timeoutMs ?? this.options.timeoutMs ?? 600_000
    const child = this.ensure()
    const generation = this.generation
    const id = `r${++this.sequence}`
    return await new Promise<DriverReply>(resolve => {
      let done = false
      const finish = (reply: DriverReply): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        if (!this.pending.delete(id)) return
        this.acceptors.delete(id)
        this.accepted.delete(id)
        this.clearLostReplyTimer(id)
        this.deadlines.delete(id)
        resolve(reply)
      }
      const timer = setTimeout(() => {
        // `reason:'timeout'` is part of the contract: a caller must be able to
        // tell "no answer came" from "the page said no", and the two lead to
        // opposite decisions (wait longer vs. stop). `recover` still gets the
        // child's channel back for the requests behind this one.
        const wasAccepted = this.accepted.has(id)
        finish({ ok: false, id, reason: 'timeout', error: `driver timed out after ${Math.round(timeoutMs / 1000)}s` })
        this.recover(generation, id, wasAccepted)
      }, timeoutMs)
      this.pending.set(id, { generation, finish })
      this.deadlines.set(id, Date.now() + timeoutMs)
      if (settings.onAccepted) this.acceptors.set(id, settings.onAccepted)
      child.stdin.write(`${JSON.stringify({ ...request, id })}\n`, error => {
        if (!error) return
        finish({ ok: false, id, error: `could not write to the driver: ${error.message}` })
      })
    })
  }

  /**
   * A timed-out request is either the child's fault or its own.
   *
   * R2-F6 was right that an operation the child ACCEPTED and never finished
   * cannot be left in front of the queue, and R-LIVE-5 was right that a slow
   * read beside a working page is not that. The distinction is evidence:
   *
   * - an accepted id that has outlived the send ceiling plus the margin is a
   *   LOST reply (G-008): the child is answering later requests, so the frame
   *   was not merely slow. It is replaced and named in a distinct log;
   * - any OTHER young accepted request of this generation means the child is
   *   busy with real work, so one slow read is not a wedge - the live page
   *   keeps generating and its turn must not be killed under it;
   * - otherwise a request the child accepted and did not answer is exactly
   *   R2-F6's stuck head of the queue;
   * - otherwise the child is wedged only after emitting NOTHING for the
   *   explicit wedge interval. A child that answers nothing at all for the
   *   whole timeout is still replaced (R2-F6's "answers nothing" case).
   */
  private wedged(generation: number, timedOutId: string, wasAccepted: boolean): {
    wedged: boolean
    quietMs: number
    otherAccepted: string[]
    /** Accepted ids far past the send ceiling: their replies never came. */
    lostAccepted: { id: string; ageMs: number }[]
  } {
    const now = Date.now()
    const quietMs = now - this.lastLineAt
    const mine = [...this.accepted].filter(([id, entry]) => entry.generation === generation && id !== timedOutId)
    // A slow turn is genuinely in flight only until its ceiling plus the
    // margin. Past that the reply is not late, it is lost - and a lost reply
    // must not disable recovery for the child's whole life.
    const lostAccepted = mine
      .filter(([id, entry]) => now > this.lostReplyBoundAt(id, entry.at))
      .map(([id, entry]) => ({ id, ageMs: now - entry.at }))
    const otherAccepted = mine
      .filter(([id, entry]) => now <= this.lostReplyBoundAt(id, entry.at))
      .map(([id]) => id)
    if (lostAccepted.length > 0) return { wedged: true, quietMs, otherAccepted, lostAccepted }
    if (otherAccepted.length > 0) return { wedged: false, quietMs, otherAccepted, lostAccepted }
    return { wedged: wasAccepted || quietMs >= this.wedgeMs, quietMs, otherAccepted, lostAccepted }
  }

  /**
   * Replace the child a timed-out operation was monopolising, when it is
   * actually wedged.
   *
   * The host-side waiter alone was removed before, so the child kept working on
   * an operation nobody would read and every later request queued behind it. A
   * timeout on a WEDGED child still replaces it: the abandoned work is named in
   * the log (accepted-but-unfinished ids), the generation is left behind so its
   * late lines and exit cannot touch the replacement, and any other waiter of
   * the same generation is failed rather than left to time out behind the stuck
   * op. A child that is still talking, or still working on accepted work, keeps
   * running: only the timed-out waiter is settled.
   */
  private recover(generation: number, timedOutId: string, wasAccepted: boolean): void {
    if (generation !== this.generation) return
    const decision = this.wedged(generation, timedOutId, wasAccepted)
    if (!decision.wedged) {
      // R-LIVE-5: the page was generating and the child was answering it; a
      // read that missed its own deadline says nothing about the child. Killing
      // it here failed the live turn with "driver was replaced", which is a
      // driver fact, never a model failure.
      this.log(`driver: ${timedOutId} timed out, but the child is alive (last line ${Math.round(decision.quietMs / 1000)}s ago${decision.otherAccepted.length ? `, accepted work in flight: ${decision.otherAccepted.join(', ')}` : ''}); leaving it running`)
      return
    }
    if (decision.lostAccepted.length > 0) {
      // Distinct from a plain timeout: the child is healthy enough to answer
      // other requests, but one accepted id's reply never arrived. Name it and
      // how long it has been outstanding, because that is the evidence a later
      // reader needs to tell a lost frame from a slow turn.
      this.logLost(decision.lostAccepted)
    } else {
      const unfinished = [
        ...(wasAccepted ? [timedOutId] : []),
        ...decision.otherAccepted,
      ]
      this.log(`driver: ${timedOutId} timed out; replacing the child (accepted but unfinished: ${unfinished.join(', ') || 'none'})`)
    }
    this.replaceChild(generation, `driver was replaced after ${timedOutId} timed out`)
  }

  /**
   * Graceful shutdown: refuse new work, detach the child so a later reopen()
   * starts a new generation, ask it to quit, and let an in-flight page
   * operation reach its own bounded deadline before forcing it. A fixed 10 s
   * forced kill used to cut a page turn short mid-operation.
   */
  async kill(): Promise<void> {
    // A shutting-down driver must not have its drain cut short by a bound
    // timer replacing the child mid-operation.
    this.clearLostReplyTimers()
    const child = this.child
    this.child = undefined
    this.closed = true
    if (!child || child.exitCode !== null) return
    const latest = [...this.deadlines.values()].reduce((max, at) => Math.max(max, at), 0)
    const grace = drainGraceMs(latest, Date.now())
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { try { child.kill() } catch { /* already gone */ } ; resolve() }, grace)
      child.once('exit', () => { clearTimeout(timer); resolve() })
      try { child.stdin.write(`${JSON.stringify({ op: 'quit' })}\n`) } catch { try { child.kill() } catch { /* already gone */ }; resolve() }
    })
    if (this.child === child) this.child = undefined
  }

  /** Forced shutdown: kill now, ignoring any operation's deadline. */
  async terminate(): Promise<void> {
    this.clearLostReplyTimers()
    this.closed = true
    const child = this.child
    this.child = undefined
    if (!child || child.exitCode !== null) return
    await new Promise<void>(resolve => {
      child.once('exit', () => resolve())
      try { child.kill() } catch { resolve() }
    })
  }

  reopen(): void { this.closed = false }
}
