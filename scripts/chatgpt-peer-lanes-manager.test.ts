/**
 * LaneManager: the process/lifecycle half of one-window-per-writer.
 *
 * No Chrome and no page: a fake child answers `warm`/`unload`, so the tests
 * prove ports, serialization, the cap and its FIFO queue, the idle kill, the
 * recycle, the registry reaping and the status report without a live rig.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LaneManager, type LaneOptions } from './chatgpt-peer/lanes.ts'
import type { DriverChild, DriverReply } from './chatgpt-peer/driver.ts'

type Call = Record<string, unknown>

class FakeLaneChild {
  readonly calls: Call[] = []
  terminated = false
  warmDelayMs = 0
  warmOk = true
  unloadOk = true
  /** The first N warm attempts answer 429 before the child gives a real login. */
  warmRateLimitAttempts = 0
  private warmCalls = 0
  constructor(readonly laneId: string) {}
  async call(request: Call): Promise<DriverReply> {
    this.calls.push({ ...request })
    const op = String(request.op ?? '')
    if (op === 'warm') {
      this.warmCalls += 1
      if (this.warmDelayMs > 0) await new Promise(resolve => setTimeout(resolve, this.warmDelayMs))
      if (this.warmCalls <= this.warmRateLimitAttempts) return { ok: false, op, error: '429 rate limit: too many requests' }
      if (!this.warmOk) return { ok: false, op, error: 'refused to branch the master login' }
      return { ok: true, op, signedIn: true, plan: 'plus' }
    }
    if (op === 'unload') return this.unloadOk ? { ok: true, op } : { ok: false, op, error: 'unload failed' }
    return { ok: true, op }
  }
  async terminate(): Promise<void> { this.terminated = true }
  onEvent(): () => void { return () => {} }
  async kill(): Promise<void> {}
  reopen(): void {}
}

async function scratch(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-lanes-'))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

/** A port range per test, so parallel test files cannot collide. */
const basePort = (): number => 24_000 + Math.floor(Math.random() * 20_000)

type Built = {
  manager: LaneManager
  children: Map<string, FakeLaneChild>
  envs: Record<string, string>[]
  timers: (() => void)[]
  events: { event: string; laneId: string; detail: string }[]
}

function build(dir: string, overrides: Partial<LaneOptions> = {}): Built {
  const children = new Map<string, FakeLaneChild>()
  const envs: Record<string, string>[] = []
  const timers: (() => void)[] = []
  const events: { event: string; laneId: string; detail: string }[] = []
  const manager = new LaneManager({
    driverScript: join(dir, 'unused.mjs'),
    root: join(dir, 'lanes'),
    sourcePort: 9222,
    basePort: basePort(),
    maxLanes: 8,
    idleMs: 30_000,
    syncCookies: false,
    spawnLane: lane => {
      envs.push(lane.env)
      const child = new FakeLaneChild(lane.laneId)
      children.set(lane.laneId, child)
      return child as unknown as DriverChild
    },
    // A controllable idle timer: the test fires it.
    schedule: work => { timers.push(work); return () => { const at = timers.indexOf(work); if (at >= 0) timers.splice(at, 1) } },
    onEvent: (event, laneId, detail) => events.push({ event, laneId, detail }),
    ...overrides,
  })
  return { manager, children, envs, timers, events }
}

describe('LaneManager', () => {
  test('one lane per id, reused while idle, with a distinct port and profile env', async () => {
    const { dir, cleanup } = await scratch()
    try {
      const { manager, children, envs, timers } = build(dir)
      const first = await manager.acquire('sender-a')
      manager.release('sender-a')
      const second = await manager.acquire('sender-a')
      expect(second.port).toBe(first.port)
      expect(second.profile).toBe(first.profile)
      expect(children.size).toBe(1)
      expect(envs[0]!.CHATGPT_LANE_ID).toBe('sender-a')
      expect(envs[0]!.CHATGPT_CDP_PORT).toBe(String(first.port))
      expect(envs[0]!.CHATGPT_STATE_DIR).toBe(first.stateDir)
      expect(envs[0]!.CHATGPT_LANE_SOURCE_PORT).toBe('9222')
      expect(envs[0]!.CHATGPT_LANE_SYNC_COOKIES).toBe('0')
      expect(children.get('sender-a')!.calls.filter(call => call.op === 'warm').length).toBe(1)
      manager.release('sender-a')
      expect(timers.length).toBe(1)
      await manager.shutdown()
    } finally { await cleanup() }
  })

  test('different writers open different windows and run in parallel', async () => {
    const { dir, cleanup } = await scratch()
    try {
      const { manager, children } = build(dir)
      const [a, b] = await Promise.all([manager.acquire('sender-a'), manager.acquire('sender-b')])
      expect(a.port).not.toBe(b.port)
      expect(children.size).toBe(2)
      manager.release('sender-a')
      manager.release('sender-b')
      await manager.shutdown()
    } finally { await cleanup() }
  })

  test('one writer cannot take its own lane twice; the second waits for release', async () => {
    const { dir, cleanup } = await scratch()
    try {
      const { manager } = build(dir)
      const first = await manager.acquire('sender-a')
      let second = false
      const pending = manager.acquire('sender-a').then(handle => { second = true; return handle })
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(second).toBe(false)
      manager.release('sender-a')
      const handle = await pending
      expect(handle.port).toBe(first.port)
      manager.release('sender-a')
      await manager.shutdown()
    } finally { await cleanup() }
  })

  test('the cap holds, the overflow queues FIFO, and onQueued fires once', async () => {
    const { dir, cleanup } = await scratch()
    try {
      const { manager } = build(dir, { maxLanes: 2 })
      const a = await manager.acquire('sender-a')
      const b = await manager.acquire('sender-b')
      expect(manager.size).toBe(2)
      const queued: string[] = []
      const waiting = ['sender-c', 'sender-d'].map(laneId => manager.acquire(laneId, () => queued.push(laneId)))
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(queued).toEqual(['sender-c', 'sender-d'])
      expect(manager.queued).toBe(2)
      manager.release('sender-a')
      const third = await waiting[0]!
      expect(third.laneId).toBe('sender-c')
      expect(manager.size).toBe(2)
      manager.release('sender-b')
      const fourth = await waiting[1]!
      expect(fourth.laneId).toBe('sender-d')
      // The live lanes never share a port at the same moment.
      const live = manager.status().map(lane => lane.port)
      expect(new Set(live).size).toBe(live.length)
      expect(live).toContain(third.port)
      expect(live).toContain(fourth.port)
      await manager.shutdown()
    } finally { await cleanup() }
  })

  test('an idle lane is killed, its directory removed, and the next acquire opens a fresh one', async () => {
    const { dir, cleanup } = await scratch()
    try {
      const { manager, children, envs, timers } = build(dir)
      const first = await manager.acquire('sender-a')
      manager.release('sender-a')
      expect(timers.length).toBe(1)
      timers[0]!()
      // Wait for the close to finish (unload, terminate, directory removal).
      for (let i = 0; i < 200; i++) {
        const child = children.get('sender-a')!
        if (child.terminated && !(await readFile(join(first.stateDir, 'profile'), 'utf8').then(() => true).catch(() => false))) break
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(manager.size).toBe(0)
      expect(children.get('sender-a')!.calls.some(call => call.op === 'unload')).toBe(true)
      expect(children.get('sender-a')!.terminated).toBe(true)
      await expect(readFile(join(first.stateDir, 'profile'), 'utf8')).rejects.toBeDefined()
      const second = await manager.acquire('sender-a')
      // A freed port is free to reuse; the clean slate is the new profile.
      expect(second.stateDir).not.toBe(first.stateDir)
      // Two spawns, each warmed once: the reopened lane is a fresh process.
      expect(envs.length).toBe(2)
      expect(envs[1]!.CHATGPT_PROFILE).not.toBe(envs[0]!.CHATGPT_PROFILE)
      manager.release('sender-a')
      await manager.shutdown()
    } finally { await cleanup() }
  })

  test('recycle closes now and reports the recycle event', async () => {
    const { dir, cleanup } = await scratch()
    try {
      const { manager, children, events } = build(dir)
      const first = await manager.acquire('sender-a')
      await manager.recycle('sender-a', 'empty answer')
      expect(manager.size).toBe(0)
      expect(children.get('sender-a')!.terminated).toBe(true)
      expect(events.some(entry => entry.event === 'recycle' && entry.laneId === 'sender-a')).toBe(true)
      const second = await manager.acquire('sender-a')
      expect(second.stateDir).not.toBe(first.stateDir)
      manager.release('sender-a')
      await manager.shutdown()
    } finally { await cleanup() }
  })

  test('a refused warm frees its slot and fails only that writer', async () => {
    const { dir, cleanup } = await scratch()
    try {
      const { manager, children } = build(dir)
      const spawned: FakeLaneChild[] = []
      const manager2 = new LaneManager({
        driverScript: join(dir, 'unused.mjs'),
        root: join(dir, 'lanes-2'),
        sourcePort: 9222,
        basePort: basePort(),
        maxLanes: 1,
        idleMs: 30_000,
        syncCookies: false,
        spawnLane: lane => {
          const child = new FakeLaneChild(lane.laneId)
          // Only the first attempt is refused; the slot must then be free.
          child.warmOk = spawned.length > 0
          spawned.push(child)
          return child as unknown as DriverChild
        },
        log: () => {},
      })
      await expect(manager2.acquire('sender-a')).rejects.toThrow(/did not warm/)
      expect(spawned[0]!.terminated).toBe(true)
      expect(manager2.size).toBe(0)
      const good = await manager2.acquire('sender-a')
      expect(good.laneId).toBe('sender-a')
      manager2.release('sender-a')
      await manager2.shutdown()
      await manager.shutdown()
      expect(children.size).toBe(0)
    } finally { await cleanup() }
  })

  test('status reports the live lanes and the queue depth', async () => {
    const { dir, cleanup } = await scratch()
    try {
      const { manager } = build(dir, { maxLanes: 1 })
      const lane = await manager.acquire('sender-a')
      const status = manager.status()
      expect(status.length).toBe(1)
      expect(status[0]!.laneId).toBe('sender-a')
      expect(status[0]!.port).toBe(lane.port)
      expect(status[0]!.state).toBe('active')
      expect(status[0]!.users).toBe(1)
      expect(status[0]!.turns).toBe(1)
      expect(manager.queued).toBe(0)
      manager.release('sender-a')
      expect(manager.status()[0]!.state).toBe('idle')
      await manager.shutdown()
    } finally { await cleanup() }
  })

  test('a lane rotates after its turn budget instead of serving forever', async () => {
    const { dir, cleanup } = await scratch()
    try {
      const { manager, children, envs } = build(dir, { maxTurns: 2, maxAgeMs: 0, idleMs: 60_000 })
      await manager.acquire('sender-a')
      manager.release('sender-a')
      expect(manager.size).toBe(1)
      await manager.acquire('sender-a')
      manager.release('sender-a')
      for (let i = 0; i < 200 && !children.get('sender-a')!.terminated; i++) await new Promise(resolve => setTimeout(resolve, 10))
      expect(manager.size).toBe(0)
      expect(children.get('sender-a')!.terminated).toBe(true)
      // A fresh window, not the same one.
      const again = await manager.acquire('sender-a')
      expect(envs.length).toBe(2)
      expect(again.stateDir).not.toBe(envs[0]!.CHATGPT_STATE_DIR)
      manager.release('sender-a')
      await manager.shutdown()
    } finally { await cleanup() }
  })

  test('a lane rotates after its age budget', async () => {
    const { dir, cleanup } = await scratch()
    let clock = 1_000_000
    try {
      const { manager, children } = build(dir, { maxTurns: 0, maxAgeMs: 1_000, idleMs: 60_000, now: () => clock })
      await manager.acquire('sender-a')
      clock += 1_500
      manager.release('sender-a')
      for (let i = 0; i < 200 && !children.get('sender-a')!.terminated; i++) await new Promise(resolve => setTimeout(resolve, 10))
      expect(manager.size).toBe(0)
      expect(children.get('sender-a')!.terminated).toBe(true)
      await manager.shutdown()
    } finally { await cleanup() }
  })

  test('a 429 at warm is retried with backoff, then the lane opens', async () => {
    const { dir, cleanup } = await scratch()
    try {
      const child = new FakeLaneChild('sender-a')
      child.warmRateLimitAttempts = 2
      const manager = new LaneManager({
        driverScript: join(dir, 'unused.mjs'),
        root: join(dir, 'lanes-429'),
        sourcePort: 9222,
        basePort: basePort(),
        maxLanes: 1,
        idleMs: 30_000,
        syncCookies: false,
        backoffBaseMs: 1,
        spawnLane: () => child as unknown as DriverChild,
        log: () => {},
      })
      const lane = await manager.acquire('sender-a')
      expect(lane.laneId).toBe('sender-a')
      expect(child.calls.filter(call => call.op === 'warm').length).toBe(3)
      manager.release('sender-a')
      await manager.shutdown()
    } finally { await cleanup() }
  })

  test('orphan reaping removes stale lane directories and leaves an unprovable pid alone', async () => {
    const { dir, cleanup } = await scratch()
    try {
      const { manager } = build(dir)
      const laneDir = join(dir, 'lanes', 'orphan')
      await mkdir(join(laneDir, 'profile'), { recursive: true })
      // A pid that is definitely not Chrome (the test runner itself); its
      // command line does not carry the lane profile, so it must not be killed.
      await writeFile(join(laneDir, 'chrome.pid'), String(process.pid))
      await writeFile(join(dir, 'lanes', 'lanes.json'), JSON.stringify({
        rows: [{ laneId: 'orphan', port: 9999, profile: join(laneDir, 'profile'), stateDir: laneDir }],
      }))
      const killed = await manager.reapOrphans()
      expect(killed).toBe(0)
      await expect(readFile(join(laneDir, 'profile'), 'utf8')).rejects.toBeDefined()
      await expect(readFile(join(dir, 'lanes', 'lanes.json'), 'utf8')).rejects.toBeDefined()
      await manager.shutdown()
    } finally { await cleanup() }
  })
})
