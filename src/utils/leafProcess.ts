import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import killTree from 'tree-kill'

export type LeafPermission = { id: string; tool: string; input: Record<string, unknown> }
export type LeafProcessState = 'starting' | 'idle' | 'running' | 'awaiting-approval' | 'closed' | 'failed'

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
  constructor(private readonly options: {
    executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv
    onEvent: (event: Record<string, unknown>) => void
    onState: (state: LeafProcessState) => void
    onExit?: () => void
  }) {}

  private setState(state: LeafProcessState): void { this.state = state; this.options.onState(state) }
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
    const child = spawn(this.options.executable, this.options.args, { cwd: this.options.cwd, env: this.options.env, stdio: 'pipe', windowsHide: true })
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
      const timer = setTimeout(() => { this.controls.delete(id); reject(new Error('Leaf control timed out')); this.fail() }, 60000)
      this.controls.set(id, { resolve, reject, timer })
      try { this.write({ type: 'control_request', request_id: id, request }) }
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

  send(text: string): void {
    if (this.state !== 'idle') throw new Error('Leaf is not idle')
    this.write({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' })
    this.setState('running')
  }

  approve(id: string, allow: boolean): void {
    const permission = this.permissions.get(id)
    if (!permission) throw new Error('Unknown or expired leaf permission')
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: id, response: allow ? { behavior: 'allow', updatedInput: permission.input } : { behavior: 'deny', message: 'Denied by user in leaf workspace' } } })
    this.permissions.delete(id)
    this.setState(this.permissions.size ? 'awaiting-approval' : 'running')
  }

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
}
