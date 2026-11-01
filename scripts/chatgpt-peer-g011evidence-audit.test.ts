/**
 * G-011 evidence audit: every audit line built from a still-owed error must say
 * WHO failed - the page or the driver.
 *
 * The sweep (2026-11-01) of every `audit()` result built from a `GeneratingTurn`
 * or a `PageUnproven` found the two live sites the (a) gate already covers
 * (`chatgpt-peer.ts:4718` direct, `:3026` observation) and one that does not:
 * the `promptForTest` catch at `chatgpt-peer.ts:1415-1419`, which audits every
 * `GeneratingTurn` as
 *
 *   "still generating; the page turn is running, not refused"
 *
 * regardless of `childStated` / `driverFault`. That is true for a child-stated
 * turn (the r206 shape: the child's own send budget ran out while the page kept
 * working) and false for a driver fault the host wrapped as `GeneratingTurn` -
 * in that case the host knows nothing about the page, and the audit asserts a
 * page state the driver never observed.
 *
 * Rows:
 *   1. a driver fault (unobservedNote's "no evidence: the driver failed, not
 *      the page") - RED at base 4916115;
 *   2. a child-stated turn keeps its honest "still generating" wording - GREEN
 *      at base, and must stay green: the fix for row 1 must not relabel a
 *      healthy child that merely stopped waiting.
 *
 * `promptForTest` is the in-process seam the dispatcher never routes to (see
 * "test seams" at `chatgpt-peer.ts:1382`), so row 1 is not live-reachable. It
 * is still a real audit emitter in the host's own audit log, which is what the
 * sweep was asked to enumerate.
 */
import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatGptHost } from './chatgpt-peer.ts'
import type { DriverChild, DriverReply } from './chatgpt-peer/driver.ts'
import { newBridgeState, newHostState, saveJson, type BridgeState } from './chatgpt-peer/state.ts'

const THREAD_A = '11111111-1111-4111-8111-111111111111'

type Call = Record<string, unknown>

/** The frozen line-JSON protocol, in memory. Only the ops these rows touch. */
class FakeDriver {
  readonly calls: Call[] = []
  threads = [{ id: THREAD_A, title: 'Existing work' }]
  sendReply: DriverReply = { ok: true, op: 'send', threadId: THREAD_A, model: 'GPT-6', effort: 'High' }

  async call(request: Call): Promise<DriverReply> {
    const op = String(request.op ?? '')
    if (op === 'ping') return { ok: true, op }
    this.calls.push({ ...request })
    if (op === 'threads') return { ok: true, op, threadId: THREAD_A, threads: this.threads }
    if (op === 'use') return { ok: true, op, threadId: String(request.threadId ?? THREAD_A), url: `https://chatgpt.com/c/${THREAD_A}`, adopted: true }
    if (op === 'reload') return { ok: true, op, threadId: THREAD_A }
    if (op === 'status') {
      return {
        ok: true, op, state: 'idle', threadId: THREAD_A, phase: 'complete', ageMs: 0,
        at: new Date().toISOString(), matchesThread: true,
      }
    }
    if (op === 'conversation') return { ok: true, op, threadId: THREAD_A, conversation: { mapping: {} } }
    if (op === 'conversations') return { ok: true, op, items: this.threads }
    if (op === 'read') return { ok: true, op, threadId: THREAD_A, text: 'fixture answer', evidence: 'state-complete' }
    if (op === 'send') return this.sendReply
    return { ok: false, op, error: `unknown op ${op}` }
  }

  onEvent(_handler: (event: Record<string, unknown>) => void): () => void {
    return () => {}
  }

  async kill(): Promise<void> {}
  reopen(): void {}
}

async function scratch(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-peer-g011e-'))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

const sessionsDir = (dir: string): string => join(dir, 'gateway-sessions')
const privateHome = (dir: string): string => join(dir, 'private')
const profileDir = (dir: string): string => join(dir, 'profile')

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

async function primerSha(): Promise<string> {
  return sha256(await readFile(join(import.meta.dir, 'chatgpt-peer', 'primer.md'), 'utf8'))
}

/** A bridge whose primer is already posted, so no primer turn is spent. */
async function primed(name: string, threadId: string): Promise<BridgeState> {
  const bridge = newBridgeState({ sessionId: randomUUID(), name, threadId })
  bridge.primedThreadId = threadId
  bridge.primerSha256 = await primerSha()
  return bridge
}

async function seedHost(dir: string, bridges: BridgeState[]): Promise<void> {
  await mkdir(join(dir, 'bridges'), { recursive: true })
  await saveJson(join(dir, 'peer.json'), newHostState({
    profile: profileDir(dir), healthPort: 0, idleUnloadMinutes: 0, instanceId: 'test',
  }))
  for (const bridge of bridges) await saveJson(join(dir, 'bridges', `${bridge.sessionId}.json`), bridge)
}

async function startHost(dir: string, driver: FakeDriver): Promise<ChatGptHost> {
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
    turnTimeoutMs: 5_000,
    waitPollMs: 20,
    directory: sessionsDir(dir),
    privateHome: privateHome(dir),
  }, driver as unknown as DriverChild)
  await host.start()
  return host
}

type AuditLine = { op: string; target: string | null; result: string; messageId?: string }

async function hostAudit(dir: string): Promise<AuditLine[]> {
  const state = JSON.parse(await readFile(join(dir, 'peer.json'), 'utf8')) as { audit: AuditLine[] }
  return state.audit
}

/** The `turn` audit lines written by one call, never the host's startup ones. */
async function turnLinesSince(dir: string, before: number): Promise<string[]> {
  return (await hostAudit(dir)).slice(before)
    .filter(entry => entry.op === 'turn')
    .map(entry => entry.result)
}

interface Rig {
  dir: string
  cleanup: () => Promise<void>
  alpha: BridgeState
  driver: FakeDriver
  host: ChatGptHost
}

async function rig(): Promise<Rig> {
  const { dir, cleanup } = await scratch()
  const alpha = await primed('alpha', THREAD_A)
  await seedHost(dir, [alpha])
  const driver = new FakeDriver()
  const host = await startHost(dir, driver)
  return { dir, cleanup, alpha, driver, host }
}

async function closeRig(one: Rig): Promise<void> {
  await one.host.stop().catch(() => {})
  await one.cleanup()
}

describe('G-011: an audit line from a still-owed turn names the right failure', () => {
  // Row 1: a driver fault is not a page state --------------------------------
  test('1. a driver fault is audited as no evidence about the page, not "the page turn is running"', async () => {
    const one = await rig()
    try {
      // The driver's own deadline fires: nothing was observed about the page.
      one.driver.sendReply = { ok: false, op: 'send', reason: 'timeout', error: 'driver timed out' }
      const before = (await hostAudit(one.dir)).length
      const result = await one.host.promptForTest(one.alpha.sessionId, { text: 'a faulting driver' })
      expect(result.status).toBe(200)
      const line = (await turnLinesSince(one.dir, before)).join('\n')
      expect(line.length).toBeGreaterThan(0)
      // The host's own wording for this case (unobservedNote, and the direct
      // path's give-up line): the driver failed, not the page.
      expect(line).toMatch(/not the page/i)
      // And it must not assert a running page the driver never saw.
      expect(line).not.toMatch(/the page turn is running/i)
    } finally {
      await closeRig(one)
    }
  }, 30_000)

  // Row 2: a child-stated turn keeps the honest wording -----------------------
  test('2. a child that stopped waiting keeps "still generating", not a driver blame', async () => {
    const one = await rig()
    try {
      // The r206 shape: the CHILD's budget ran out while the page kept working.
      one.driver.sendReply = {
        ok: false, op: 'send', reason: 'timeout', timedOut: true, state: 'generating', threadId: THREAD_A,
      }
      const before = (await hostAudit(one.dir)).length
      const result = await one.host.promptForTest(one.alpha.sessionId, { text: 'a slow page' })
      expect(result.status).toBe(200)
      const line = (await turnLinesSince(one.dir, before)).join('\n')
      expect(line.length).toBeGreaterThan(0)
      expect(line).toMatch(/still generating/i)
      // The child named the page; the host must not turn that into a fault.
      expect(line).not.toMatch(/driver fail/i)
      expect(line).not.toMatch(/not the page/i)
    } finally {
      await closeRig(one)
    }
  }, 30_000)
})
