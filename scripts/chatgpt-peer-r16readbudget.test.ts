/**
 * R16: a page-ready event pays only for the threads it is about.
 *
 * A cross-thread turn send navigates the tab, and the new document emits
 * `page-ready` naming the navigated thread (reason `document`). Licensing every
 * bound bridge for that costs one tab navigation AND one conversation read per
 * bridge - six of each with six bridges - and under throttling those reads 429.
 * The host must scope a `document` event to the one thread a live bridge owns.
 *
 * Frozen contract (driver side lands independently): `page-ready` carries
 * `reason: 'attach' | 'document'`, and a MISSING reason means `attach`. The
 * catch-up cases - attach, no reason, unknown thread - keep the old wide pass.
 *
 * Assertions are on the driver's own reads, not just the licence number: a
 * full pass WOULD read every owed thread here (none is baselined yet), so only
 * real scoping keeps the other threads at zero.
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
const THREAD_B = '22222222-2222-4222-8222-222222222222'
const THREAD_C = '33333333-3333-4333-8333-333333333333'

type Call = Record<string, unknown>

/** The frozen child protocol, in memory. Reads are counted per thread. */
class FakeDriver {
  readonly calls: Call[] = []
  threads = [
    { id: THREAD_A, title: 'Alpha work' },
    { id: THREAD_B, title: 'Beta work' },
    { id: THREAD_C, title: 'Gamma work' },
  ]
  observable = true
  /** Every conversation read is refused with a 429, as a throttled account does. */
  throttled = false
  /** Conversation reads per thread, so scoping is measured at the driver. */
  readonly conversationReads = new Map<string, number>()
  private readonly listeners = new Set<(event: Record<string, unknown>) => void>()
  private current: string | null = null
  private readonly trees = new Map<string, { current: string; mapping: Record<string, any> }>()
  private clock = Math.floor(Date.now() / 1000)

  private treeOf(threadId: string): { current: string; mapping: Record<string, any> } {
    let tree = this.trees.get(threadId)
    if (!tree) {
      const root = `root-${threadId}`
      tree = { current: root, mapping: { [root]: { id: root, parent: null, children: [], message: null } } }
      this.trees.set(threadId, tree)
    }
    return tree
  }

  readsOf(threadId: string): number {
    return this.conversationReads.get(threadId) ?? 0
  }

  onEvent(handler: (event: Record<string, unknown>) => void): () => void {
    this.listeners.add(handler)
    return () => { this.listeners.delete(handler) }
  }

  emit(event: Record<string, unknown>): void {
    for (const listener of this.listeners) listener(event)
  }

  async call(request: Call): Promise<DriverReply> {
    if (String(request.op ?? '') === 'ping') return { ok: true, op: 'ping' }
    this.calls.push({ ...request })
    const op = String(request.op ?? '')
    if (op === 'threads') return { ok: true, op, threadId: this.current, threads: this.threads }
    if (op === 'use') {
      const threadId = String(request.threadId ?? '')
      this.current = threadId
      return { ok: true, op, threadId, url: `https://chatgpt.com/c/${threadId}`, adopted: true }
    }
    if (op === 'conversation' && this.observable) {
      const threadId = String(request.threadId ?? '')
      this.conversationReads.set(threadId, this.readsOf(threadId) + 1)
      if (this.throttled) return { ok: false, op, status: 429, error: 'too many requests' }
      const tree = this.treeOf(threadId)
      return { ok: true, op, conversation: { current_node: tree.current, mapping: structuredClone(tree.mapping) } }
    }
    if (op === 'conversations' && this.observable) return { ok: true, op, items: this.threads }
    if (op === 'unload') { this.current = null; return { ok: true, op, state: 'unloaded' } }
    if (op === 'status') {
      const asked = typeof request.threadId === 'string' ? request.threadId : ''
      return {
        ok: true, op, cost: 'push', threadId: asked, pushedThreadId: this.current,
        matchesThread: this.current === null ? null : this.current === asked,
        state: 'idle', phase: 'complete', ageMs: 0, at: new Date().toISOString(),
      }
    }
    if (op === 'file') return { ok: false, op, error: 'no files in this fake' }
    return { ok: false, op, error: `unknown op ${op}` }
  }

  async kill(): Promise<void> {}
  reopen(): void {}
}

async function scratch(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-peer-r16-'))
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

async function startHost(dir: string, driver: FakeDriver, options: { readStormLimit?: number; readBackoffBaseMs?: number } = {}): Promise<ChatGptHost> {
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
    readStormLimit: options.readStormLimit,
    readBackoffBaseMs: options.readBackoffBaseMs,
    directory: sessionsDir(dir),
    privateHome: privateHome(dir),
  }, driver as unknown as DriverChild)
  await host.start()
  return host
}

/** A primed bridge bound to a thread: no primer work, no cursor yet (owed). */
async function primed(name: string, threadId: string): Promise<BridgeState> {
  const bridge = newBridgeState({ sessionId: randomUUID(), name, threadId })
  bridge.primedThreadId = threadId
  bridge.primerSha256 = sha256(await readFile(join(import.meta.dir, 'chatgpt-peer', 'primer.md'), 'utf8'))
  return bridge
}

type Gate = { licence: number; attempted: number; idleSkips: number; skipped: number }
const gateOf = (host: ChatGptHost, sessionId: string): Gate =>
  (host as any).bridges.get(sessionId).reads as Gate

const gatesOf = (host: ChatGptHost, bridges: BridgeState[]): Gate[] =>
  bridges.map(bridge => gateOf(host, bridge.sessionId))

async function mounted(): Promise<{
  dir: string
  bridges: BridgeState[]
  driver: FakeDriver
  host: ChatGptHost
  cleanup: () => Promise<void>
}> {
  const { dir, cleanup } = await scratch()
  const bridges = [await primed('alpha', THREAD_A), await primed('beta', THREAD_B), await primed('gamma', THREAD_C)]
  await seedHost(dir, bridges)
  const driver = new FakeDriver()
  const host = await startHost(dir, driver)
  return { dir, bridges, driver, host, cleanup: async () => { await host.stop(); await cleanup() } }
}

describe('a throttled account pauses every bridge, not one bridge at a time', () => {
  test('consecutive 429s open one host-wide window; the next bridge never asks', async () => {
    const { dir, cleanup } = await scratch()
    const bridges = [await primed('alpha', THREAD_A), await primed('beta', THREAD_B), await primed('gamma', THREAD_C)]
    await seedHost(dir, bridges)
    const driver = new FakeDriver()
    driver.throttled = true
    // Two refusals is not a transient; a third read would be us adding load.
    const host = await startHost(dir, driver, { readStormLimit: 2, readBackoffBaseMs: 1_000 })
    try {
      const reads = () => [...driver.conversationReads.values()].reduce((total, count) => total + count, 0)
      const before = reads()
      await host.pollOnce()
      expect(reads() - before).toBe(2)
      // The third bridge's read was refused by the host, not by the account.
      expect(gatesOf(host, bridges).some(gate => gate.skipped > 0)).toBe(true)
      // And a second pass inside the window asks nobody at all.
      const afterFirst = reads()
      await host.pollOnce()
      expect(reads()).toBe(afterFirst)
    } finally {
      await host.stop()
      await cleanup()
    }
  }, 20_000)
})

describe('R16: a document page-ready pays for one thread', () => {
  test('1. document + a known thread licenses only that bridge and reads only that thread', async () => {
    const { bridges, driver, host, cleanup } = await mounted()
    try {
      driver.emit({ event: 'page-ready', reason: 'document', threadId: THREAD_A })

      // The licence is scoped at the moment the event is handled.
      const [alpha, beta, gamma] = gatesOf(host, bridges)
      expect(alpha!.licence).toBe(1)
      expect(beta!.licence).toBe(0)
      expect(gamma!.licence).toBe(0)

      await host.flushTriggers()

      // Every bridge is owed a read (no cursor), so a FULL pass would read all
      // three: zero here is the scope, not an idle skip.
      expect(driver.readsOf(THREAD_A)).toBe(1)
      expect(driver.readsOf(THREAD_B)).toBe(0)
      expect(driver.readsOf(THREAD_C)).toBe(0)

      const after = gatesOf(host, bridges)
      expect(after[0]!.attempted).toBe(1)
      expect(after[1]!.attempted).toBe(0)
      expect(after[2]!.attempted).toBe(0)
    } finally {
      await cleanup()
    }
  }, 20_000)

  test('2. attach licenses every live bridge and reads every thread', async () => {
    const { bridges, driver, host, cleanup } = await mounted()
    try {
      driver.emit({ event: 'page-ready', reason: 'attach', threadId: THREAD_A })
      expect(gatesOf(host, bridges).map(gate => gate.licence)).toEqual([1, 1, 1])

      await host.flushTriggers()

      expect(driver.readsOf(THREAD_A)).toBe(1)
      expect(driver.readsOf(THREAD_B)).toBe(1)
      expect(driver.readsOf(THREAD_C)).toBe(1)
    } finally {
      await cleanup()
    }
  }, 20_000)

  test('3. a missing reason behaves exactly like attach', async () => {
    const { bridges, driver, host, cleanup } = await mounted()
    try {
      driver.emit({ event: 'page-ready', threadId: THREAD_A })
      expect(gatesOf(host, bridges).map(gate => gate.licence)).toEqual([1, 1, 1])

      await host.flushTriggers()

      expect(driver.readsOf(THREAD_A)).toBe(1)
      expect(driver.readsOf(THREAD_B)).toBe(1)
      expect(driver.readsOf(THREAD_C)).toBe(1)
    } finally {
      await cleanup()
    }
  }, 20_000)

  test('4. document with an unknown or absent thread falls back to the full licence', async () => {
    const { bridges, driver, host, cleanup } = await mounted()
    try {
      // Unknown thread: no bridge owns it, so the wide catch-up still runs.
      driver.emit({ event: 'page-ready', reason: 'document', threadId: randomUUID() })
      expect(gatesOf(host, bridges).map(gate => gate.licence)).toEqual([1, 1, 1])
      await host.flushTriggers()
      expect(driver.readsOf(THREAD_A)).toBe(1)
      expect(driver.readsOf(THREAD_B)).toBe(1)
      expect(driver.readsOf(THREAD_C)).toBe(1)

      // Absent thread: same fallback.
      driver.emit({ event: 'page-ready', reason: 'document' })
      expect(gatesOf(host, bridges).map(gate => gate.licence)).toEqual([1, 1, 1])
      await host.flushTriggers()
      expect(driver.readsOf(THREAD_A)).toBe(2)
      expect(driver.readsOf(THREAD_B)).toBe(2)
      expect(driver.readsOf(THREAD_C)).toBe(2)
    } finally {
      await cleanup()
    }
  }, 20_000)
})
