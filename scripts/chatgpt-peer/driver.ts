/**
 * The page driver as a child process.
 *
 * Playwright stays out of this repository: the child owns Chrome and the
 * selectors, and speaks one JSON object per line. The host keeps the bus, which
 * is the part that must not drift from the harness.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

export type DriverReply = { ok: boolean; op?: string; [key: string]: unknown }

export class DriverChild {
  private child?: ChildProcessWithoutNullStreams
  private pending: ((reply: DriverReply) => void)[] = []
  private accepted: (() => void) | undefined
  private closed = false

  constructor(private readonly options: {
    script: string
    profile?: string
    log?: (line: string) => void
    timeoutMs?: number
  }) {}

  /** Called when the page has taken a message into the thread. */
  onAccepted(handler: (() => void) | undefined): void {
    this.accepted = handler
  }

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.child && this.child.exitCode === null && !this.closed) return this.child
    const env = { ...process.env, ...(this.options.profile ? { CHATGPT_PROFILE: this.options.profile } : {}) }
    const child = spawn(process.execPath, [this.options.script, 'serve'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    createInterface({ input: child.stdout }).on('line', line => {
      const trimmed = line.trim()
      if (!trimmed) return
      let message: Record<string, unknown>
      try { message = JSON.parse(trimmed) } catch { this.options.log?.(`driver: unparsable line ${trimmed.slice(0, 120)}`); return }
      if (message.event === 'accepted') { this.accepted?.(); return }
      if (message.event) return
      const resolve = this.pending.shift()
      if (resolve) resolve(message as DriverReply)
    })
    createInterface({ input: child.stderr }).on('line', line => {
      if (line.trim()) this.options.log?.(`driver: ${line.trim().slice(0, 400)}`)
    })
    child.on('exit', code => {
      const reason = `driver exited (code ${code ?? 'null'})`
      this.options.log?.(reason)
      this.child = undefined
      for (const resolve of this.pending.splice(0)) resolve({ ok: false, error: reason })
    })
    child.stdin.on('error', () => {})
    this.child = child
    return child
  }

  async call(request: Record<string, unknown>, timeoutMs = this.options.timeoutMs ?? 600_000): Promise<DriverReply> {
    const child = this.ensure()
    return await new Promise<DriverReply>(resolve => {
      const timer = setTimeout(() => {
        const index = this.pending.indexOf(settle)
        if (index >= 0) this.pending.splice(index, 1)
        resolve({ ok: false, error: `driver timed out after ${Math.round(timeoutMs / 1000)}s` })
      }, timeoutMs)
      const settle = (reply: DriverReply) => { clearTimeout(timer); resolve(reply) }
      this.pending.push(settle)
      child.stdin.write(`${JSON.stringify(request)}\n`)
    })
  }

  /** Stop the child and, with it, the page. */
  async kill(): Promise<void> {
    const child = this.child
    this.child = undefined
    this.closed = true
    if (!child || child.exitCode !== null) return
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { child.kill(); resolve() }, 5_000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
      try { child.stdin.write(`${JSON.stringify({ op: 'quit' })}\n`) } catch { child.kill() }
    })
  }

  reopen(): void { this.closed = false }
}
