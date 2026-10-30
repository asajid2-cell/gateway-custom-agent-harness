/**
 * R-LIVE-5, host half: a failed status read is "no evidence yet".
 *
 * `unknown` is the driver saying NOTHING - a timeout, a replacement - not the
 * page saying anything. The answer loop used to take that unknown as a page
 * word: it replaced the page's last known `generating`, reset the turn's clock
 * on every flip, and handed the sender a failure the page never produced.
 *
 * The bus, the host and the state files here are real; only the page is the
 * frozen line-JSON driver, driven by this file.
 */
import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GatewaySessionTransport } from '../src/utils/gatewaySessionTransport.js'
import { ChatGptHost } from './chatgpt-peer.ts'
import type { DriverChild, DriverReply } from './chatgpt-peer/driver.ts'
import { newBridgeState, newHostState, saveJson, type BridgeState } from './chatgpt-peer/state.ts'

const THREAD_A = '11111111-1111-4111-8111-111111111111'
const REPLACED = 'driver was replaced after r27 timed out'

type Call = Record<string, unknown>

/** The frozen child protocol, in memory: one page, one thread, one mode. */
class FakeDriver {
  readonly calls: Call[] = []
  threads = [{ id: THREAD_A, title: 'Existing work' }]
  /** The page's pushed word while a turn runs. */
  signal: 'generating' | 'idle' = 'generating'
  /** The one signal timestamp: it must not move by itself, or it is a "progress". */
  readonly at = new Date().toISOString()
  /** From this status call on, the DRIVER fails instead of answering. */
  faultStatusFrom = Number.POSITIVE_INFINITY
  statusCalls = 0
  observable = false
  answer = 'answered on the page'
  private readonly listeners = new Set<(event: Record<string, unknown>) => void>()
  private current: string | null = null

  onEvent(handler: (event: Record<string, unknown>) => void): () => void {
    this.listeners.add(handler)
    return () => { this.listeners.delete(handler) }
  }

  async call(request: Call): Promise<DriverReply> {
    const op = String(request.op ?? '')
    if (op === 'ping') return { ok: true, op }
    this.calls.push({ ...request })
    if (op === 'threads') return { ok: true, op, threadId: this.current, threads: this.threads }
    if (op === 'use') return { ok: true, op, threadId: String(request.threadId ?? ''), url: `https://chatgpt.com/c/${String(request.threadId ?? '')}`, adopted: true }
    if (op === 'send') {
      this.current = typeof request.threadId === 'string' ? request.threadId : this.current
      return { ok: true, op, text: this.answer, threadId: this.current, model: 'GPT-6', effort: 'High' }
    }
    if (op === 'status') {
      this.statusCalls++
      if (this.statusCalls >= this.faultStatusFrom) {
        // The live fact: the driver's own replacement failed a request. It says
        // nothing about the page.
        return { ok: false, op, reason: 'timeout', error: REPLACED }
      }
      const asked = String(request.threadId ?? '')
      // The first question is the post gate: the page is idle, so the job is
      // typed. Every later one is the turn's own wait, and the page generates.
      const state = this.statusCalls === 1 ? 'idle' : this.signal
      return {
        ok: true, op, cost: 'push', threadId: asked,
        pushedThreadId: asked, matchesThread: true,
        state, phase: state === 'generating' ? 'streaming' : 'complete',
        ageMs: 0, at: this.at,
      }
    }
    if (op === 'read') return { ok: false, op, error: 'no read in this fake' }
    if (op === 'conversation' && this.observable) return { ok: false, op, error: 'no conversation in this fake' }
    if (op === 'unload') { this.current = null; return { ok: true, op, state: 'unloaded' } }
    return { ok: false, op, error: `unknown op ${op}` }
  }

  async kill(): Promise<void> {}
  reopen(): void {}
}

async function scratch(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-peer-r4c-'))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

const sessionsDir = (dir: string): string => join(dir, 'gateway-sessions')
const privateHome = (dir: string): string => join(dir, 'private')
const profileDir = (dir: string): string => join(dir, 'profile')
const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

async function seedHost(dir: string, bridges: BridgeState[] = []): Promise<void> {
  await mkdir(join(dir, 'bridges'), { recursive: true })
  await saveJson(join(dir, 'peer.json'), newHostState({
    profile: profileDir(dir), healthPort: 0, idleUnloadMinutes: 0, instanceId: 'test',
  }))
  for (const bridge of bridges) await saveJson(join(dir, 'bridges', `${bridge.sessionId}.json`), bridge)
}

async function startHost(dir: string, driver: FakeDriver, turnTimeoutMs: number): Promise<ChatGptHost> {
  process.env.CLAUDE_CONFIG_DIR = dir
  const host = new ChatGptHost({
    home: dir,
    statePath: join(dir, 'peer.json'),
    driverPath: join(dir, 'unused.mjs'),
    profile: profileDir(dir),
    instanceId: 'test',
    healthPort: 0,
    idleUnloadMinutes: 0,
    number: 1,
    pollSeconds: 0,
    titlesEvery: 0,
    turnTimeoutMs,
    waitPollMs: 20,
    directory: sessionsDir(dir),
    privateHome: privateHome(dir),
  }, driver as unknown as DriverChild)
  await host.start()
  return host
}

async function waitFor<T>(probe: () => Promise<T | undefined> | T | undefined, timeoutMs = 10_000): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the host')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

async function busPeer(dir: string, name: string): Promise<GatewaySessionTransport> {
  const transport = new GatewaySessionTransport({
    directory: sessionsDir(dir), sessionId: randomUUID(), name, cwd: dir, purpose: 'test sender', policy: 'accept',
  })
  await transport.start()
  return transport
}

async function primedBridge(): Promise<BridgeState> {
  const alpha = newBridgeState({ sessionId: randomUUID(), name: 'alpha', threadId: THREAD_A })
  alpha.primedThreadId = THREAD_A
  alpha.primerSha256 = sha256(await readFile(join(import.meta.dir, 'chatgpt-peer', 'primer.md'), 'utf8'))
  return alpha
}

async function hostAudit(dir: string): Promise<{ op: string; target: string | null; result: string }[]> {
  const state = JSON.parse(await readFile(join(dir, 'peer.json'), 'utf8')) as { audit: { op: string; target: string | null; result: string }[] }
  return state.audit
}

describe('R-LIVE-5: a driver fault is not the page\'s word', () => {
  test('a status read that fails mid-turn keeps the page\'s last word and never fails the turn as a model turn', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    // Call 1 is the post gate (the page is idle, so the job posts), call 2 is
    // the first poll (generating), and every later one is the driver failing.
    driver.faultStatusFrom = 3
    const host = await startHost(dir, driver, 2_000)
    const sender = await busPeer(dir, 'sender')
    try {
      await sender.send(alpha.sessionId, 'do the thing', 'do the thing', undefined, 'inquiry', true)
      const entry = await waitFor(async () => {
        const audit = await hostAudit(dir)
        return audit.find(item => item.op === 'turn' && /generating|failed/.test(item.result))
      }, 10_000)
      // The budget ended, and the honest outcome is "still generating": the
      // driver's failure is not evidence about the page, so it cannot become
      // the turn's failure reason.
      expect(entry.result).toMatch(/still generating/)
      expect(entry.result).not.toMatch(/driver was replaced/)
      const answered = await waitFor(() => (sender.inbox().length > 0 ? sender.inbox() : undefined), 5_000)
      const text = JSON.stringify(answered)
      expect(text).not.toMatch(/model turn failed/)
      expect(text).not.toMatch(/driver was replaced/)
    } finally {
      await sender.close()
      await host.stop()
      await cleanup()
    }
  }, 20_000)
})
