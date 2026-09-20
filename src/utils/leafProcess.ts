import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import killTree from 'tree-kill'
import type { LeafTerminalMessage, LeafSnapshot } from './leafTerminal.js'

export type LeafPermission = { id: string; tool: string; input: Record<string, unknown> }
export type LeafProcessState = 'starting' | 'idle' | 'running' | 'awaiting-approval' | 'closed' | 'failed'

/**
 * Whether a leaf in this state still owns a process.
 *
 * `closed` and `failed` are the two states a leaf does not come back from, so
 * neither the terminal nor a turn can be handed to it.
 */
export function isLeafProcessAlive(state: LeafProcessState): boolean {
  return state !== 'closed' && state !== 'failed'
}

/** A leaf owns its CLI process and permission requests; no parent queue or bootstrap state is shared. */
export class LeafProcess {
  private child: ChildProcessWithoutNullStreams | undefined
  private closed: Promise<void> = Promise.resolve()
  private closing = false
  private closePromise: Promise<void> | undefined
  private termination: Promise<void> | undefined
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
    if (this.child) throw new Error('Leaf process already started')
    this.setState('starting')
    const child = spawn(this.options.executable, this.options.args, { cwd: this.options.cwd, env: this.options.env, stdio: this.options.interactive ? ['pipe', 'pipe', 'pipe', 'ipc'] : 'pipe', windowsHide: true }) as ChildProcessWithoutNullStreams
    this.child = child
    this.closed = new Promise(resolve => child.once('close', resolve))
    child.stderr.on('data', () => {}) // Provider exceptions can contain credentials; never forward raw stderr.
    child.stdin.on('error', () => this.fail())
    child.on('error', () => this.fail())
    child.on('exit', (code, signal) => {
      this.rejectControls(new Error(`Leaf process ended (code ${code ?? 'none'}, signal ${signal ?? 'none'})`))
      this.permissions.clear()
      this.setState(this.state === 'failed' ? 'failed' : code === 0 ? 'closed' : 'failed')
      this.options.onExit?.()
    })
    if (this.options.interactive) {
      child.stdout.resume() // Synchronous fd writes during shutdown are not terminal frames.
      child.on('message', (raw: unknown) => {
        if (this.state === 'closed' || this.state === 'failed') return
        const message = raw as LeafTerminalMessage
        if (!message || typeof message !== 'object') return
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
      })
      await this.control({ subtype: 'initialize' })
      if (this.state === 'starting') this.setState('idle')
      return
    }
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

  private write(message: unknown): void {
    if (this.closing || !this.child || this.child.stdin.destroyed || this.child.stdin.writableEnded || ['closed', 'failed'].includes(this.state)) throw new Error('Leaf is closing or not running')
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private control(request: Record<string, unknown>): Promise<void> {
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
        if (this.options.interactive) this.terminal({ type: 'leaf-control', id, request: request as import('./leafTerminal.js').LeafTerminalControl })
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

  terminal(message: LeafTerminalMessage): void {
    if (this.closing || !this.child?.connected || ['closed', 'failed'].includes(this.state)) throw new Error('Leaf terminal is not running')
    this.child.send(message, error => { if (error && !this.closing) this.fail() })
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
  private terminate(): Promise<void> {
    if (this.termination) return this.termination
    const child = this.child
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
    this.termination = new Promise<void>((resolve, reject) => {
      const done = (error: Error | null | undefined) => {
        if (error && child.exitCode === null && child.signalCode === null) {
          const timer = setTimeout(() => reject(new Error('Could not terminate leaf process tree')), 5000)
          void this.closed.then(() => { clearTimeout(timer); resolve() })
        } else resolve()
      }
      if (process.platform === 'win32') {
        execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { timeout: 10000, maxBuffer: 65536, windowsHide: true }, done)
      } else killTree(child.pid!, done)
    })
    return this.termination
  }
  private fail(): void {
    this.setState('failed')
    this.rejectControls()
    void this.terminate().catch(() => {})
  }
  close(): Promise<void> {
    this.closing = true
    return this.closePromise ??= this.closeOnce()
  }
  private async closeOnce(): Promise<void> {
    const child = this.child
    if (!child) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      if (child.exitCode === null && child.signalCode === null) {
        if (this.options.interactive && child.connected) child.send({ type: 'leaf-control', id: randomUUID(), request: { subtype: 'shutdown' } }, () => {})
        else child.stdin.end()
      }
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
}
