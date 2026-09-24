import { execFile, spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import killTree from 'tree-kill'
import type { LeafTerminalMessage, LeafSnapshot } from './leafTerminal.js'
import { connectLeafChannel, LeafTakenError, type LeafChannel } from './leafChannel.js'

export type LeafPermission = { id: string; tool: string; input: Record<string, unknown> }
export type LeafProcessState = 'starting' | 'idle' | 'running' | 'awaiting-approval' | 'closed' | 'failed'

/**
 * How long a session waits for a member it has just started to answer.
 *
 * A member is not listening the moment it is spawned: it has a whole CLI to
 * evaluate before it binds, which is seconds on an idle machine and a great deal
 * longer on a busy one. Reaching it is therefore a wait rather than a single
 * attempt - one try loses that race every time and reports a member that is
 * starting perfectly well as one that failed to start.
 */
const MEMBER_START_TIMEOUT_MS = 60_000
const MEMBER_START_POLL_MS = 250

/**
 * Whether a leaf in this state still owns a process.
 *
 * `closed` and `failed` are the two states a leaf does not come back from, so
 * neither the terminal nor a turn can be handed to it.
 */
export function isLeafProcessAlive(state: LeafProcessState): boolean {
  return state !== 'closed' && state !== 'failed'
}

/**
 * Whether a reported state is one this process knows how to be in.
 *
 * A member reports what it was doing when a session reached it, and that report
 * arrives over a socket rather than from a value this process made. Trusting it
 * to be one of the six states would put a word from the wire straight into the
 * state machine; this is the check that keeps it a state.
 */
export function isLeafProcessState(value: unknown): value is LeafProcessState {
  return typeof value === 'string' && ['starting', 'idle', 'running', 'awaiting-approval', 'closed', 'failed'].includes(value)
}

/** A leaf owns its CLI process and permission requests; no parent queue or bootstrap state is shared. */
export class LeafProcess {
  private child: ChildProcess | undefined
  // The headless transport: a CLI this process still holds by the pipe it was
  // started with. Kept apart from `child` because an interactive member has no
  // such pipe - it is reached at its own address - and a write to it is a
  // different act from a write down this one.
  private piped: ChildProcessWithoutNullStreams | undefined
  private closed: Promise<void> = Promise.resolve()
  private closing = false
  private closePromise: Promise<void> | undefined
  private termination: Promise<void> | undefined
  // Interactive leaves talk over their own endpoint rather than a pipe to this
  // process, so identity and pid are recorded here instead of read off a child
  // handle that may not exist at all when an already-running member is adopted.
  private channel: LeafChannel | undefined
  private pid: number | undefined
  private settleClosed: (() => void) | undefined
  private ended = false
  private exiting = false
  private detached = false
  private buffer = ''
  private readonly decoder = new StringDecoder('utf8')
  private readonly permissions = new Map<string, LeafPermission>()
  private readonly controls = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private state: LeafProcessState = 'closed'
  // Messages handed to a leaf whose input is not free, in arrival order. A leaf
  // mid-turn takes them directly, so this holds only what a permission dialog
  // blocked; dropping a message loses work quietly, so it is handed in exactly
  // once when the input frees up.
  private readonly inbox: { text: string; resolve: (queued: boolean) => void }[] = []
  private pumping = false
  constructor(private readonly options: {
    executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv
    onEvent: (event: Record<string, unknown>) => void
    onState: (state: LeafProcessState) => void
    onQueued?: (text: string) => void
    onExit?: () => void
    interactive?: boolean
    onTerminal?: (message: LeafTerminalMessage) => void
    /**
     * Interactive only: the session whose endpoint this leaf serves.
     *
     * A member that is already listening there is taken over rather than
     * started a second time, so naming the address is the whole of "reach this
     * leaf" - there is no separate adopt path to keep in step with the one that
     * spawns.
     */
    sessionId?: string
  }) {}

  private setState(state: LeafProcessState): void {
    this.state = state
    this.options.onState(state)
    // A closed or failed leaf will never run a held message, so its senders are
    // told now rather than left waiting on a promise that cannot settle.
    if (state === 'closed' || state === 'failed') this.drainInbox()
    // A held message runs at the next moment the leaf can take one, and both
    // idle and running qualify: a running leaf's own REPL accepts text mid-turn
    // and runs it at its next step boundary, so a held message is answered
    // without waiting for the whole turn. Only `awaiting-approval` is excluded -
    // a permission prompt owns the input and the text would go to the dialog.
    // Pumping from every transition (rather than only from the result event)
    // also covers a leaf that resumed while a permission was outstanding.
    else if (state === 'idle' || state === 'running') this.pump()
  }
  getPendingCount(): number { return this.inbox.length }
  getPending(): string[] { return this.inbox.map(item => item.text) }
  getState(): LeafProcessState { return this.state }
  getPermissions(): LeafPermission[] { return structuredClone([...this.permissions.values()]) }

  private needsStreamJsonBootstrap(): boolean {
    const { args } = this.options
    const print = args.some(arg => arg === '-p' || arg === '--print')
    const streamJsonInput = args.some((arg, index) =>
      arg === '--input-format=stream-json' ||
      (arg === '--input-format' && args[index + 1] === 'stream-json'),
    )
    return print && streamJsonInput
  }

  async start(): Promise<void> {
    if (this.closing) throw new Error('Leaf is closing or closed')
    if (this.child || this.channel) throw new Error('Leaf process already started')
    this.setState('starting')
    if (this.options.interactive) return this.startInteractive()
    const child = spawn(this.options.executable, this.options.args, { cwd: this.options.cwd, env: this.options.env, stdio: 'pipe', windowsHide: true }) as ChildProcessWithoutNullStreams
    this.child = child
    this.piped = child
    this.pid = child.pid
    this.closed = new Promise(resolve => child.once('close', resolve))
    child.stderr.on('data', () => {}) // Provider exceptions can contain credentials; never forward raw stderr.
    child.stdin.on('error', () => this.fail())
    child.on('error', () => this.fail())
    child.on('exit', (code, signal) => {
      // Recorded before anything else can ask: a handle whose process is gone
      // has nothing left to terminate.
      this.ended = true
      this.rejectControls(new Error(`Leaf process ended (code ${code ?? 'none'}, signal ${signal ?? 'none'})`))
      this.permissions.clear()
      this.setState(this.state === 'failed' ? 'failed' : code === 0 ? 'closed' : 'failed')
      this.options.onExit?.()
    })
    // Some print-mode launchers require redirected stdin to contain data before
    // they start the child CLI. keep_alive is a valid stream-json input frame
    // that the CLI ignores, so it unblocks that check without initializing a
    // user turn before the control handshake.
    if (this.needsStreamJsonBootstrap()) this.write({ type: 'keep_alive' })
    child.stdout.on('data', chunk => {
      this.buffer += this.decoder.write(chunk)
      if (Buffer.byteLength(this.buffer) > 8 * 1024 * 1024) { this.fail(); return }
      let newline: number
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline)
        this.buffer = this.buffer.slice(newline + 1)
        if (!line.trim()) continue
        try { this.handle(JSON.parse(line)) }
        catch { this.fail(); return }
      }
    })
    await this.control({ subtype: 'initialize' })
    if (this.state === 'starting') this.setState('idle')
  }

  /**
   * Reach a running member, or start one and reach that.
   *
   * Spawning is detached, with no IPC channel and no shared stdio. An IPC
   * channel *is* the launching process's lifetime - it closes when that process
   * exits - so keeping one would recreate the coupling this replaces. The member
   * answers at its own address instead, which is why closing the session you are
   * in no longer closes the rest of the family, and why a member that is already
   * up is adopted rather than started a second time.
   */
  private async startInteractive(): Promise<void> {
    const sessionId = this.options.sessionId
    if (!sessionId) throw new Error('Interactive leaf has no session address')
    const handlers = {
      onMessage: (message: any) => this.handleTerminalMessage(message),
      onClose: () => this.memberEnded(),
    }
    // Armed before the first attempt, because a member reached by address may
    // end at any moment - including between the attach and the handshake - and a
    // close nobody is waiting on yet would leave the waiters to time out.
    this.closed = new Promise(resolve => { this.settleClosed = resolve })
    // Reaching a running member comes first, and needs no gate: the member
    // itself refuses a second attach, so whatever is already there is the
    // answer and starting a copy of it would only be a second writer.
    let connected = await connectLeafChannel(sessionId, handlers)
    if (!connected) {
      // A member has to outlive this session, so it cannot share this session's
      // console: the console closing takes every process attached to it with it.
      // Being detached costs the member its console, and a console-less process
      // makes the system build a fresh console for every console tool below it -
      // which Windows 11 hands to Windows Terminal as a visible window that
      // takes the foreground. Tools therefore have to ask for their console to
      // be hidden (`windowsHide`); that hidden console is then inherited by
      // everything they start, so the hiding has to hold at the top of a
      // factory rather than at every leaf of it.
      //
      // Dropping `detached` to give the member a hidden console of its own was
      // tried and measured: the member does not outlive this session without it
      // (the leaf harness fails on exactly that), while `windowsHide` beside a
      // detached spawn does nothing, because `DETACHED_PROCESS` wins over
      // `CREATE_NO_WINDOW`. Outliving the session is the contract; the console
      // is a Windows side effect, so it is the side effect that gives way.
      const child = spawn(this.options.executable, this.options.args, {
        cwd: this.options.cwd, env: this.options.env, detached: true, windowsHide: true, stdio: 'ignore',
      })
      // Neither process keeps the other alive: this handle does not wait on the
      // member and does not hold the loop open for it.
      child.unref()
      // A start that never becomes a process - a missing interpreter - is known
      // the moment it happens, so it is not worth waiting out the deadline for.
      let dead = false
      child.on('error', () => { dead = true; this.fail() })
      child.on('exit', () => { dead = true })
      this.child = child
      this.pid = child.pid
      const deadline = Date.now() + MEMBER_START_TIMEOUT_MS
      while (!connected && !dead && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, MEMBER_START_POLL_MS))
        try { connected = await connectLeafChannel(sessionId, handlers) }
        catch (error) {
          // Taken between the start and the reach: the member is somebody
          // else's now, so it is not ours to clean up and the refusal travels out.
          if (error instanceof LeafTakenError) throw error
          // Anything else is a start still in progress.
        }
      }
      if (!connected) {
        // A member we started but can never reach is ours to clean up: nothing
        // would ever show it, and it is holding the transcript it was told to
        // resume.
        await this.terminate().catch(() => {})
        throw new Error('Leaf session did not open its endpoint; it may have failed to start')
      }
    }
    this.channel = connected.channel
    this.pid = connected.identity.pid ?? this.pid
    // A member that was already running may be mid-turn; a freshly started one
    // has reported nothing yet, and the handshake below settles which it is.
    if (isLeafProcessState(connected.identity.state)) this.setState(connected.identity.state)
    await this.control({ subtype: 'initialize' })
    if (this.state === 'starting') this.setState('idle')
  }

  private handleTerminalMessage(raw: unknown): void {
    if (this.state === 'closed' || this.state === 'failed') return
    const message = raw as LeafTerminalMessage
    if (!message || typeof message !== 'object') return
    // The member says goodbye on its way out. A detached process's exit status
    // is only ever reported to its parent, and its parent is deliberately not
    // us, so this message is the one reliable way to tell a session that
    // finished tidily from one that was killed.
    if (message.type === 'leaf-exit') { this.exiting = true; return }
    if (message.type === 'leaf-state') this.setState(message.state)
    if (message.type === 'leaf-control-response') {
      const pending = this.controls.get(message.id)
      if (pending) {
        clearTimeout(pending.timer)
        this.controls.delete(message.id)
        if (message.ok) pending.resolve()
        else pending.reject(new Error('Leaf rejected control request'))
      }
    }
    this.options.onTerminal?.(message)
  }

  /**
   * The member's endpoint closed: it exited, or it was killed.
   *
   * `closing` means this handle asked for it; a goodbye message means the member
   * chose it. Anything else is an unexplained end and is reported as a failure
   * rather than quietly recorded as a tidy close.
   */
  private memberEnded(): void {
    // The socket we closed ourselves on the way out. The member is still
    // running, so its endpoint closing is this session letting go, not the
    // member failing.
    if (this.detached) return
    this.ended = true
    this.channel = undefined
    this.settleClosed?.()
    this.rejectControls(new Error('Leaf session ended'))
    this.permissions.clear()
    const clean = this.closing || this.exiting
    this.setState(this.state === 'failed' || !clean ? 'failed' : 'closed')
    this.options.onExit?.()
  }

  private write(message: unknown): void {
    const child = this.piped
    if (this.closing || !child || child.stdin.destroyed || child.stdin.writableEnded || ['closed', 'failed'].includes(this.state)) throw new Error('Leaf is closing or not running')
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private control(request: Record<string, unknown>, whileClosing = false): Promise<void> {
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      // A bare "timed out" made a wedged leaf indistinguishable from a slow one.
      // The first handshake only stalls when the REPL never mounted, which in a
      // leaf means a startup dialog is still waiting for a terminal that has none.
      const timeout = this.options.interactive && request.subtype === 'initialize'
        ? 'Leaf did not reach its input loop; a startup dialog may be waiting (is this workspace trusted?)'
        : 'Leaf control timed out'
      const timer = setTimeout(() => { this.controls.delete(id); reject(new Error(timeout)); this.fail() }, 60000)
      this.controls.set(id, { resolve, reject, timer })
      try {
        if (this.options.interactive) this.terminal({ type: 'leaf-control', id, request: request as import('./leafTerminal.js').LeafTerminalControl }, whileClosing)
        else this.write({ type: 'control_request', request_id: id, request })
      }
      catch (error) { clearTimeout(timer); this.controls.delete(id); reject(error) }
    })
  }

  private handle(event: any): void {
    if (this.state === 'failed' || this.state === 'closed') return
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') throw new Error('Invalid leaf event')
    if (event.type === 'control_response') {
      const pending = this.controls.get(event.response?.request_id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.controls.delete(event.response.request_id)
      if (event.response.subtype === 'success') pending.resolve()
      else pending.reject(new Error('Leaf rejected control request'))
      return
    }
    if (event.type === 'control_cancel_request') {
      this.permissions.delete(event.request_id)
      if (!this.permissions.size) this.setState('running')
      return
    }
    if (event.type === 'control_request') {
      const request = event.request
      if (typeof event.request_id !== 'string' || request?.subtype !== 'can_use_tool' || typeof request.tool_name !== 'string' || !request.input || typeof request.input !== 'object' || Array.isArray(request.input)) {
        this.write({ type: 'control_response', response: { subtype: 'error', request_id: event.request_id, error: 'Unsupported leaf control request' } })
        return
      }
      this.permissions.set(event.request_id, { id: event.request_id, tool: request.tool_name, input: request.input })
      this.setState('awaiting-approval')
    }
    if (event.type === 'assistant' && !this.permissions.size) this.setState('running')
    this.options.onEvent(event)
    if (event.type === 'result') this.setState(this.permissions.size ? 'awaiting-approval' : 'idle')
  }

  /**
   * `closing` stops ordinary traffic to a member that is on its way out, but the
   * request that performs the close has to get through that very flag - otherwise
   * the member is never asked to stop and can only be killed, and a killed member
   * never gives its writer claim back.
   */
  terminal(message: LeafTerminalMessage, whileClosing = false): void {
    if ((this.closing && !whileClosing) || !this.channel || ['closed', 'failed'].includes(this.state)) throw new Error('Leaf terminal is not running')
    this.channel.send(message)
  }
  focus(active: boolean, epoch: number, columns: number, rows: number): void { this.terminal({ type: 'leaf-focus', active, epoch, columns, rows }) }
  input(data: string): void { this.terminal({ type: 'leaf-input', data }) }
  snapshot(snapshot: LeafSnapshot): void { this.terminal({ type: 'leaf-snapshot', snapshot }) }

  send(text: string): void {
    if (this.options.interactive) throw new Error('Interactive leaves receive terminal input, not headless messages')
    this.write({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' })
    this.setState('running')
  }

  /**
   * Hand a message to a leaf that cannot take one right now, to be delivered
   * the moment it can.
   *
   * A leaf waiting on a permission cannot take a second message, but refusing
   * it loses the message: the sender is told to "try again later" and nothing
   * remembers to. Holding it here keeps arrival order, survives the approval
   * prompt (a leaf waiting on a permission is still a leaf that will finish),
   * and reports whether the message ran or was dropped, so the sender can be
   * told.
   */
  private queue(text: string): Promise<boolean> {
    if (['closed', 'failed'].includes(this.state) || this.closing) return Promise.resolve(false)
    return new Promise<boolean>(resolve => {
      this.inbox.push({ text, resolve })
      this.options.onQueued?.(text)
      this.pump()
    })
  }

  /**
   * Deliver held messages one at a time, as soon as the leaf can take one.
   * A running leaf qualifies: its REPL accepts the text mid-turn and runs it at
   * its next step boundary, so a held message is answered without waiting for
   * the whole turn to end. `pumping` guards against re-entering while this
   * message's own dispatch flips the state.
   */
  private pump(): void {
    if (this.pumping || this.closing || !this.canTakeMessage()) return
    const next = this.inbox.shift()
    if (!next) return
    this.pumping = true
    void (async () => {
      let sent = false
      try {
        await this.control({ subtype: 'leaf_prompt', prompt: next.text })
        sent = true
      } catch {
        // The leaf was interrupted or died before the held message ran. A
        // queued message is a request to deliver later, not a guarantee the
        // leaf lives that long, so this is a dropped message and not an error.
      } finally {
        this.pumping = false
        next.resolve(sent)
      }
      this.pump()
    })()
  }

  /**
   * Whether the leaf's input can take a peer message right now.
   *
   * Idle and running both can: a running leaf's REPL queues the text and its
   * own turn drains it at the next step boundary. `awaiting-approval` cannot -
   * the permission dialog owns the keyboard, so text written now would answer
   * the dialog rather than become a turn.
   */
  private canTakeMessage(): boolean {
    return this.state === 'idle' || this.state === 'running'
  }

  /**
   * Release every held message when the leaf can no longer take one. Without
   * this a leaf that dies mid-turn leaves its senders awaiting a promise that
   * can never settle, which reads as a hang rather than a dropped message.
   */
  private drainInbox(): void {
    for (const held of this.inbox.splice(0)) held.resolve(false)
  }

  /**
   * Deliver a message to a leaf. Headless leaves receive a stream-json user
   * turn; interactive leaves receive the text through their own REPL input so
   * the turn runs inside the leaf instead of a parent-owned queue. Unlike
   * `input`, delivery is not gated on terminal focus. Resolves true once the
   * leaf has taken the message, or false if it was dropped without running.
   */
  deliver(text: string): Promise<boolean> {
    if (!this.options.interactive) { this.send(text); return Promise.resolve(true) }
    // A message handed to a running leaf is not held: the leaf's own queue takes
    // it now and its next step boundary runs it, which is what makes a peer
    // answer mid-turn instead of after the whole turn.
    if (!this.canTakeMessage()) return this.queue(text)
    this.pumping = true
    return this.control({ subtype: 'leaf_prompt', prompt: text }).then(() => true, () => false).finally(() => { this.pumping = false; this.pump() })
  }

  approve(id: string, allow: boolean): void {
    const permission = this.permissions.get(id)
    if (!permission) throw new Error('Unknown or expired leaf permission')
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: id, response: allow ? { behavior: 'allow', updatedInput: permission.input } : { behavior: 'deny', message: 'Denied by user in leaf workspace' } } })
    this.permissions.delete(id)
    this.setState(this.permissions.size ? 'awaiting-approval' : 'running')
  }

  syncDraft(): Promise<void> { return this.control({ subtype: 'leaf_draft' }) }
  checkpoint(name?: string): Promise<void> { return this.control({ subtype: 'leaf_checkpoint', name }) }
  setModel(model: string): Promise<void> { return this.control({ subtype: 'set_model', model }) }
  setEffort(effort: string): Promise<void> { return this.control({ subtype: 'apply_flag_settings', settings: { effortLevel: effort } }) }
  interrupt(): Promise<void> { return this.control({ subtype: 'interrupt' }) }
  private rejectControls(error = new Error('Leaf process ended')): void {
    for (const pending of this.controls.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.controls.clear()
  }
  /**
   * Kill the process tree by pid.
   *
   * For an interactive member this is a last resort rather than the normal
   * close: the member is not our child, so nothing can be reaped if it ignores
   * the request to stop, and the pid recorded when we reached it is all we have.
   */
  private terminate(): Promise<void> {
    if (this.termination) return this.termination
    const pid = this.pid
    if (!pid) return Promise.resolve()
    // Already gone: taskkill would report a failure for the outcome we wanted.
    if (this.ended) return Promise.resolve()
    const child = this.child
    if (child && (child.exitCode !== null || child.signalCode !== null)) return Promise.resolve()
    this.termination = new Promise<void>((resolve, reject) => {
      const done = (error: Error | null | undefined) => {
        if (error && !this.ended) {
          const timer = setTimeout(() => reject(new Error('Could not terminate leaf process tree')), 5000)
          void this.closed.then(() => { clearTimeout(timer); resolve() })
        } else resolve()
      }
      if (process.platform === 'win32') {
        execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { timeout: 10000, maxBuffer: 65536, windowsHide: true }, done)
      } else killTree(pid, done)
    })
    return this.termination
  }
  private fail(): void {
    this.setState('failed')
    this.rejectControls()
    void this.terminate().catch(() => {})
  }
  /**
   * Let go of a running member without stopping it.
   *
   * This is what a session does on its way out. A member is its own process, so
   * the session watching it is a viewer and leaving is a viewer leaving: the
   * member pauses with nobody attached and is picked up again by whoever opens
   * it next. Only `close` asks a member to stop, and only a person closes a leaf
   * on purpose.
   */
  detach(): void {
    if (!this.options.interactive || this.detached || this.ended || !this.channel) return
    this.detached = true
    this.ended = true
    const channel = this.channel
    this.channel = undefined
    this.settleClosed?.()
    this.rejectControls(new Error('Leaf session detached, not closed'))
    this.permissions.clear()
    // Dropping the socket is the whole detach: the member sees a detach and
    // stops drawing, and nothing is written to it on the way out.
    channel.close()
    this.setState('closed')
  }

  close(): Promise<void> {
    this.closing = true
    return this.closePromise ??= this.closeOnce()
  }
  private async closeOnce(): Promise<void> {
    if (this.options.interactive) return this.closeInteractive()
    const child = this.piped
    if (!child) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      if (child.exitCode === null && child.signalCode === null) child.stdin.end()
      const graceful = await Promise.race([
        this.closed.then(() => true),
        new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 2000) }),
      ])
      if (!graceful) {
        await this.terminate()
        clearTimeout(timer)
        await Promise.race([
          this.closed,
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Leaf process pipes did not close after termination')), 5000) }),
        ])
      }
      await this.termination
    } finally { clearTimeout(timer) }
  }

  /**
   * Ask the member to stop, then make sure it did.
   *
   * The wait is longer than the child path's because a member on its way out is
   * flushing its own transcript, and a detached process cannot be reaped - so
   * cutting that short would corrupt the very conversation being closed.
   */
  private async closeInteractive(): Promise<void> {
    if (!this.channel) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      try { await this.control({ subtype: 'shutdown' }, true) } catch { /* It ended before it could answer. */ }
      const graceful = await Promise.race([
        this.closed.then(() => true),
        new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 5000) }),
      ])
      if (!graceful) await this.terminate()
    } finally { clearTimeout(timer) }
  }
}
