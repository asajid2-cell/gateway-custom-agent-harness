/**
 * The page driver as a child process.
 *
 * Playwright stays out of this repository: the child owns Chrome and the
 * selectors, and speaks one JSON object per line. The host keeps the bus, which
 * is the part that must not drift from the harness.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

export type DriverReply = { ok: boolean; op?: string; id?: string; [key: string]: unknown }

export class DriverChild {
  private child?: ChildProcessWithoutNullStreams
  /**
   * Responses are matched by request id, never by arrival order.
   *
   * A timed-out request is not cancelled: the child keeps working on it and
   * answers whenever it finishes. With a FIFO queue that late answer would be
   * handed to whichever request is now waiting - the next inbound would be
   * settled with the previous inbound's text. An id makes a late reply
   * identifiable and safe to drop.
   */
  private readonly pending = new Map<string, (reply: DriverReply) => void>()
  private accepted: ((id: string) => void) | undefined
  private closed = false
  private sequence = 0

  constructor(private readonly options: {
    script: string
    profile?: string
    log?: (line: string) => void
    timeoutMs?: number
  }) {}

  /** Called when the page has taken a message into the thread. Carries the request id. */
  onAccepted(handler: ((id: string) => void) | undefined): void {
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
      const id = typeof message.id === 'string' ? message.id : ''
      if (message.event === 'accepted') { this.accepted?.(id); return }
      if (message.event) return
      if (!id) { this.options.log?.(`driver: reply without a request id: ${trimmed.slice(0, 120)}`); return }
      const settle = this.pending.get(id)
      if (!settle) { this.options.log?.(`driver: late reply for ${id} dropped (that request already timed out)`); return }
      this.pending.delete(id)
      settle(message as DriverReply)
    })
    createInterface({ input: child.stderr }).on('line', line => {
      if (line.trim()) this.options.log?.(`driver: ${line.trim().slice(0, 400)}`)
    })
    child.on('exit', code => {
      const reason = `driver exited (code ${code ?? 'null'})`
      this.options.log?.(reason)
      this.child = undefined
      for (const settle of this.pending.values()) settle({ ok: false, error: reason })
      this.pending.clear()
    })
    child.stdin.on('error', () => {})
    this.child = child
    return child
  }

  async call(request: Record<string, unknown>, timeoutMs = this.options.timeoutMs ?? 600_000): Promise<DriverReply> {
    const child = this.ensure()
    const id = `r${++this.sequence}`
    return await new Promise<DriverReply>(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ ok: false, id, error: `driver timed out after ${Math.round(timeoutMs / 1000)}s` })
      }, timeoutMs)
      this.pending.set(id, reply => { clearTimeout(timer); resolve(reply) })
      child.stdin.write(`${JSON.stringify({ ...request, id })}\n`, error => {
        if (!error) return
        if (!this.pending.delete(id)) return
        clearTimeout(timer)
        resolve({ ok: false, id, error: `could not write to the driver: ${error.message}` })
      })
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
