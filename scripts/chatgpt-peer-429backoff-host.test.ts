/**
 * Directive C, host half: no idle reads, a 429 backs off per bridge, and a
 * delivery read never waits behind another bridge's window.
 *
 * The three rows, in the order the directive names them:
 *
 *   (1) an idle host puts NOTHING on the page - no conversation read, no
 *       status read, no title walk - across many reconcile ticks, and the four
 *       bridges the operator named (review, chatgpt-web, cnow, round12-retro)
 *       read zero until a turn is posted on them;
 *   (2) one 429 spaces the next read on that bridge by its backoff (honouring
 *       a Retry-After the driver reports) and every read inside the window is
 *       refused WITHOUT touching the driver - the 18:5x burst cannot recur;
 *   (3) a delivery read (an answer a sender is owed) on one bridge is served
 *       while another bridge is inside its 429 window, and the backing-off
 *       bridge is not read just because someone else was.
 *
 * No network, no browser: the page driver answers the frozen line-JSON ops in
 * memory and counts the reads by thread, so the proof is the driver's own
 * record rather than a grep of a log.
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
const THREAD_B = '22222222-2222-4222-8222-222222222222'
const IDLE_THREADS = [
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555',
  '66666666-6666-4666-8666-666666666666',
]

type Call = Record<string, unknown>

/** The frozen child protocol, in memory. One page, one active thread. */
class FakeDriver {
  readonly calls: Call[] = []
  threads = [{ id: THREAD_A, title: 'Existing work' }, { id: THREAD_B, title: 'Other work' }]
  killed = false
  answer = 'answered on the page'
  sendText = 'answered on the page'
  evidence = 'state-complete'
  signal: { phase: string | null; threadId: string | null; at: number | null } = { phase: 'complete', threadId: null, at: null }
  generating = false
  refuseSend = false
  busyUntil = 0
  private readonly listeners = new Set<(event: Record<string, unknown>) => void>()
  private current: string | null = null
  /** Serve the read-only thread ops (and the tree) from memory. */
  observable = false
  /** Every conversation read, per thread: the number the directive is about. */
  private readonly conversationCalls = new Map<string, number>()
  /** Threads whose conversation read answers 429, and how long Retry-After asks. */
  private readonly throttled = new Map<string, number>()
  /** Threads the page no longer has: absent from the list and a 404 on read. */
  private readonly vanished = new Set<string>()
  private readonly trees = new Map<string, { current: string; mapping: Record<string, any> }>()
  private clock = Math.floor(Date.now() / 1000)

  readsOf(threadId: string): number { return this.conversationCalls.get(threadId) ?? 0 }

  /** The page throttles every conversation read of this thread for `retryAfterMs`. */
  rateLimit(threadId: string, retryAfterMs = 0): void { this.throttled.set(threadId, retryAfterMs) }

  /** The page answers again (the removal helper for `rateLimit`). */
  clearRateLimit(threadId: string): void { this.throttled.delete(threadId) }

  /** The thread is deleted on the page: out of the list, and a 404 on read. */
  vanish(threadId: string): void {
    this.vanished.add(threadId)
    this.threads = this.threads.filter(thread => thread.id !== threadId)
  }

  /** The thread is back on the page (same tree, same id). */
  reappear(threadId: string, title = 'Existing work'): void {
    this.vanished.delete(threadId)
    if (!this.threads.some(thread => thread.id === threadId)) this.threads = [...this.threads, { id: threadId, title }]
  }

  private treeOf(threadId: string): { current: string; mapping: Record<string, any> } {
    let tree = this.trees.get(threadId)
    if (!tree) {
      const root = `root-${threadId}`
      tree = { current: root, mapping: { [root]: { id: root, parent: null, children: [], message: null } } }
      this.trees.set(threadId, tree)
    }
    return tree
  }

  private grow(threadId: string, role: 'user' | 'assistant', text: string): string {
    const tree = this.treeOf(threadId)
    const id = randomUUID()
    tree.mapping[id] = {
      id, parent: tree.current, children: [],
      message: {
        id, author: { role }, create_time: this.clock++,
        end_turn: role === 'assistant' ? true : null,
        status: 'finished_successfully',
        content: { content_type: 'text', parts: [text] },
      },
    }
    tree.mapping[tree.current]!.children.push(id)
    tree.current = id
    return id
  }

  /** A person types in the thread and the model answers. Returns the user node id. */
  humanTypes(threadId: string, text: string, answer: string): string {
    const id = this.grow(threadId, 'user', text)
    this.grow(threadId, 'assistant', answer)
    return id
  }

  onEvent(handler: (event: Record<string, unknown>) => void): () => void {
    this.listeners.add(handler)
    return () => { this.listeners.delete(handler) }
  }

  emit(event: Record<string, unknown>): void { for (const listener of this.listeners) listener(event) }

  async call(request: Call, options?: number | { onAccepted?: (id: string) => void }): Promise<DriverReply> {
    if (String(request.op ?? '') === 'ping') return { ok: true, op: 'ping' }
    this.calls.push({ ...request })
    const onAccepted = typeof options === 'object' && options ? options.onAccepted : undefined
    const op = String(request.op ?? '')
    if (op === 'threads') return { ok: true, op, threadId: this.current, threads: this.threads }
    if (op === 'use') {
      const threadId = String(request.threadId ?? '')
      if (!threadId) return { ok: false, op, error: 'threadId required' }
      this.current = threadId
      return { ok: true, op, threadId, url: `https://chatgpt.com/c/${threadId}`, adopted: true }
    }
    if (op === 'send') {
      if (this.generating || this.refuseSend) {
        return { ok: false, op, reason: 'busy', state: 'generating', threadId: this.current, error: 'the page is mid-turn; your message was not typed' }
      }
      const threadId = typeof request.threadId === 'string' ? request.threadId : this.current
      if (!threadId) return { ok: false, op, error: 'no thread is open' }
      this.current = threadId
      this.grow(threadId, 'user', String(request.text ?? ''))
      this.grow(threadId, 'assistant', this.answer)
      this.signal = { phase: 'complete', threadId, at: Date.now() }
      onAccepted?.(String(request.id ?? ''))
      return { ok: true, op, text: this.sendText, threadId, model: 'GPT-6', effort: 'High' }
    }
    if (op === 'read') {
      return { ok: true, op, threadId: this.current, text: this.answer, evidence: this.evidence }
    }
    if (op === 'conversation' && this.observable) {
      const threadId = String(request.threadId ?? '')
      this.conversationCalls.set(threadId, this.readsOf(threadId) + 1)
      if (this.vanished.has(threadId)) return { ok: false, op, status: 404, error: 'conversation not found' }
      if (this.throttled.has(threadId)) {
        const retryAfterMs = this.throttled.get(threadId)!
        return { ok: false, op, status: 429, error: 'too many requests', ...(retryAfterMs > 0 ? { retryAfterMs } : {}) }
      }
      const tree = this.treeOf(threadId)
      return { ok: true, op, conversation: { current_node: tree.current, mapping: structuredClone(tree.mapping) } }
    }
    if (op === 'conversations' && this.observable) {
      const offset = Number(request.offset ?? 0)
      const limit = Number(request.limit ?? 100)
      // `update_time` moves when a thread grows a node, as the real child
      // reports it; the host licenses one read of a thread whose value moved.
      const items = this.threads
        .slice(offset, offset + limit)
        .map(thread => ({ ...thread, update_time: Object.keys(this.treeOf(thread.id).mapping).length }))
      return { ok: true, op, items }
    }
    if (op === 'unload') { this.current = null; return { ok: true, op, state: 'unloaded' } }
    if (op === 'status') {
      const asked = typeof request.threadId === 'string' ? request.threadId : ''
      if (!asked) return { ok: true, op, threadId: this.current, model: 'GPT-6', effort: 'High' }
      const at = this.signal.at === null ? null : new Date(this.signal.at).toISOString()
      const state = this.generating || Date.now() < this.busyUntil
        ? 'generating'
        : this.signal.threadId && this.signal.threadId !== asked
          ? 'unknown'
          : this.signal.phase === 'complete' ? 'idle' : 'unknown'
      if (request.deep !== true) {
        return {
          ok: true, op, cost: 'push', threadId: asked,
          pushedThreadId: this.signal.threadId,
          matchesThread: this.signal.threadId === null ? null : this.signal.threadId === asked,
          state, phase: this.signal.phase,
          ageMs: this.signal.at === null ? null : Date.now() - this.signal.at, at,
        }
      }
      const tree = this.treeOf(asked)
      const node = newestAnswerNode(tree)
      const text = node ? String(node.message?.content?.parts?.[0] ?? '') : ''
      return {
        ok: true, op, cost: 'conversation', threadId: asked,
        state, phase: this.signal.phase,
        ageMs: this.signal.at === null ? null : Date.now() - this.signal.at, at,
        matchesThread: this.signal.threadId === null ? null : this.signal.threadId === asked,
        latestAssistant: node ? { nodeId: node.id, complete: node.message?.end_turn === true, chars: text.length, files: [] } : null,
        files: [],
      }
    }
    return { ok: false, op, error: `unknown op ${op}` }
  }

  async kill(): Promise<void> { this.killed = true }
  reopen(): void { this.killed = false }

  // Fields the host touches but these rows do not exercise directly.
  pageFailed = false
  sendError: string | null = null
  landOn: string | null = null
  lags = false
}

const newestAnswerNode = (tree: { mapping: Record<string, any>; current: string }): any => {
  let node: any = tree.mapping[tree.current]
  const seen = new Set<string>()
  while (node && !seen.has(node.id)) {
    seen.add(node.id)
    const role = node.message?.author?.role
    const type = String(node.message?.content?.content_type ?? '')
    if (role === 'assistant' && !/^(thoughts|reasoning_recap|reasoning)$/i.test(type)) return node
    node = node.parent ? tree.mapping[node.parent] : null
  }
  return null
}

async function scratch(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-peer-429-'))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

const sessionsDir = (dir: string): string => join(dir, 'gateway-sessions')
const privateHome = (dir: string): string => join(dir, 'private')
const profileDir = (dir: string): string => join(dir, 'profile')

async function seedHost(dir: string, bridges: BridgeState[] = []): Promise<void> {
  await mkdir(join(dir, 'bridges'), { recursive: true })
  await saveJson(join(dir, 'peer.json'), newHostState({
    profile: profileDir(dir), healthPort: 0, idleUnloadMinutes: 0, instanceId: 'test',
  }))
  for (const bridge of bridges) await saveJson(join(dir, 'bridges', `${bridge.sessionId}.json`), bridge)
}

async function startHost(dir: string, driver: FakeDriver, options: { readBackoffBaseMs?: number; titlesEvery?: number } = {}): Promise<ChatGptHost> {
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
    titlesEvery: options.titlesEvery ?? 0,
    turnTimeoutMs: 5_000,
    waitPollMs: 20,
    readBackoffBaseMs: options.readBackoffBaseMs ?? 50,
    directory: sessionsDir(dir),
    privateHome: privateHome(dir),
  }, driver as unknown as DriverChild)
  await host.start()
  return host
}

async function credentials(dir: string): Promise<{ token: string }> {
  const body = JSON.parse(await readFile(join(privateHome(dir), 'instances', 'test.json'), 'utf8')) as { token: string }
  return { token: body.token }
}

async function operator(host: ChatGptHost, token: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const response = await fetch(`http://127.0.0.1:${host.port}/operator`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

const bridgeNamed = (name: string, threadId: string | null): BridgeState => newBridgeState({ sessionId: randomUUID(), name, threadId })

async function readBridge(dir: string, sessionId: string): Promise<BridgeState> {
  return JSON.parse(await readFile(join(dir, 'bridges', `${sessionId}.json`), 'utf8')) as BridgeState
}

async function busPeer(dir: string, name: string): Promise<GatewaySessionTransport> {
  const transport = new GatewaySessionTransport({
    directory: sessionsDir(dir), sessionId: randomUUID(), name, cwd: dir, purpose: 'test sender', policy: 'accept',
  })
  await transport.start()
  return transport
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 8_000): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = probe()
    if (value !== undefined) return value
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

/** The page's own block shape, exactly as a person would see it in the answer. */
const rendered = (fields: Record<string, unknown>): string => 'gateway\n' + JSON.stringify(fields)

/** The host's rolling audit, read off the state file it persists. */
async function hostAudit(dir: string): Promise<{ op: string; target: string | null; result: string }[]> {
  const state = JSON.parse(await readFile(join(dir, 'peer.json'), 'utf8')) as { audit: { op: string; target: string | null; result: string }[] }
  return state.audit
}

/** The in-memory bridge, for the gate fields the status line rounds to seconds. */
const liveBridge = (host: ChatGptHost, sessionId: string): {
  reads: { licence: number; backoffUntil: number; rateLimited: number }
  pendingWatch?: unknown
} => (host as unknown as {
  bridges: Map<string, { reads: { licence: number; backoffUntil: number; rateLimited: number }; pendingWatch?: unknown }>
}).bridges.get(sessionId)!

const primerSha = async (): Promise<string> =>
  sha256(await readFile(join(import.meta.dir, 'chatgpt-peer', 'primer.md'), 'utf8'))

/**
 * A baselined bridge: bound to a thread it has already read once. Nothing is
 * owed, which is exactly the idle state directive C is about.
 */
async function baselinedBridge(name: string, threadId: string, cursor?: string): Promise<BridgeState> {
  const bridge = bridgeNamed(name, threadId)
  bridge.primedThreadId = threadId
  bridge.primerSha256 = await primerSha()
  bridge.cursor = cursor ?? `seed-${name}`
  return bridge
}

/** Every per-thread read a reconcile pass could make. */
const perThreadReads = (driver: FakeDriver): Call[] =>
  driver.calls.filter(call => ['conversation', 'status', 'read'].includes(String(call.op)))

/** Every account-wide list walk. */
const listWalks = (driver: FakeDriver): Call[] =>
  driver.calls.filter(call => String(call.op) === 'conversations')

describe('directive C: an idle host reads nothing per thread', () => {
  test('ten ticks at the production titles interval read no thread, and the interval itself gates the account-wide walk', async () => {
    const { dir, cleanup } = await scratch()
    const names = ['review', 'chatgpt-web', 'cnow', 'round12-retro']
    const bridges = await Promise.all(names.map((name, index) => baselinedBridge(name, IDLE_THREADS[index]!)))
    await seedHost(dir, bridges)
    const driver = new FakeDriver()
    driver.observable = true
    // `titlesEvery` is in SECONDS (the CLI default is 120), and this is the
    // production number: ten ticks inside one interval pay for one walk.
    const host = await startHost(dir, driver, { titlesEvery: 120 })
    try {
      for (let tick = 0; tick < 10; tick++) {
        await host.pollOnce()
        // The timer path as well as the reconcile pass: both go through the
        // interval, so ten ticks inside one interval pay for one walk.
        await host.pollTitles()
      }
      // No conversation read, no status read, no `read` op - for any thread.
      expect(perThreadReads(driver)).toEqual([])
      for (const threadId of IDLE_THREADS) expect(driver.readsOf(threadId)).toBe(0)
      // The account-wide walk itself is NOT gated on anything being owed: it
      // runs once, on the first tick, and the interval coalesces the rest. That
      // is the only page traffic an idle host makes.
      expect(listWalks(driver).length).toBe(1)

      // The numbers ride the operator's status line, read-only, so reads/min is
      // reportable from the host. Asking status is the operator's own explicit
      // act; the ticks above are what the line must show as zero.
      const { token } = await credentials(dir)
      const status = await operator(host, token, { op: 'status', bridge: bridges[0]!.sessionId })
      expect(status.status).toBe(200)
      expect(String(status.body.line)).toContain('reads 0 attempted')
      // The list walk is instrumented too, so its cost is never invisible.
      expect(String(status.body.line)).toContain('list 1 attempted')
      // And it says why: every pass was skipped while the bridge owed nothing.
      expect(String(status.body.line)).toMatch(/[1-9]\d* idle/)
    } finally {
      await host.stop()
      await cleanup()
    }

    // Phase two, the gate itself: with a one-second interval, two walks in the
    // same second are ONE read, and a walk after the interval is a second. The
    // idle-phase numbers must not depend on the interval being long.
    const fast = await scratch()
    const fastBridges = await Promise.all(names.map((name, index) => baselinedBridge(name, IDLE_THREADS[index]!)))
    await seedHost(fast.dir, fastBridges)
    const fastDriver = new FakeDriver()
    fastDriver.observable = true
    const quick = await startHost(fast.dir, fastDriver, { titlesEvery: 1 })
    try {
      await quick.pollTitles()
      await quick.pollTitles()
      expect(listWalks(fastDriver).length).toBe(1)
      await new Promise(resolve => setTimeout(resolve, 1_100))
      await quick.pollTitles()
      expect(listWalks(fastDriver).length).toBe(2)
      // Both phases: the interval gates the LIST, never a per-thread read.
      expect(perThreadReads(fastDriver)).toEqual([])
      for (const threadId of IDLE_THREADS) expect(fastDriver.readsOf(threadId)).toBe(0)
    } finally {
      await quick.stop()
      await fast.cleanup()
    }
  }, 30_000)
})

describe('directive C: one 429 spaces every later read on that bridge', () => {
  test('the Retry-After window refuses later reads without a driver call, then reopens', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = bridgeNamed('alpha', THREAD_A)
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.observable = true
    // The page's own number: the host must treat it as a floor on the backoff.
    driver.rateLimit(THREAD_A, 1_200)
    const host = await startHost(dir, driver, { readBackoffBaseMs: 50 })
    try {
      // Baseline is owed exactly one read; the page throttles it.
      await host.pollOnce()
      expect(driver.readsOf(THREAD_A)).toBe(1)

      // Two more passes inside the window: refused by the gate, so the driver
      // is never asked. This is the shape the 18:5x burst could not have.
      await host.pollOnce()
      await host.pollOnce()
      expect(driver.readsOf(THREAD_A)).toBe(1)
      expect(driver.calls.filter(call => call.op === 'conversation').length).toBe(1)

      const { token } = await credentials(dir)
      const line = String((await operator(host, token, { op: 'status', bridge: alpha.sessionId })).body.line)
      expect(line).toContain('1 attempted')
      expect(line).toContain('1 x429')
      expect(line).toContain('2 skipped')
      expect(line).toMatch(/backoff \d+s/)

      // Once the page answers again and the window has passed, the read is
      // allowed and the guard resets.
      driver.clearRateLimit(THREAD_A)
      await new Promise(resolve => setTimeout(resolve, 1_300))
      await host.pollOnce()
      expect(driver.readsOf(THREAD_A)).toBe(2)
      const after = String((await operator(host, token, { op: 'status', bridge: alpha.sessionId })).body.line)
      expect(after).toContain('2 attempted')
      expect(after).not.toMatch(/backoff \d+s/)
    } finally {
      await host.stop()
      await cleanup()
    }
  }, 30_000)
})

describe('directive C: a delivery read outranks another bridge\'s backoff', () => {
  test('a turn is answered on one bridge while a second bridge is inside its 429 window', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await baselinedBridge('alpha', THREAD_A)
    const beta = bridgeNamed('beta', THREAD_B)
    await seedHost(dir, [alpha, beta])
    const driver = new FakeDriver()
    driver.observable = true
    driver.rateLimit(THREAD_B, 5_000)
    const host = await startHost(dir, driver, { readBackoffBaseMs: 50 })
    try {
      // Only the un-baselined bridge reads; it is throttled into its window.
      await host.pollOnce()
      expect(driver.readsOf(THREAD_B)).toBe(1)
      // The idle bridge next door paid nothing to put beta into backoff.
      expect(driver.readsOf(THREAD_A)).toBe(0)

      // A sender's turn on alpha is a DELIVERY read (the pre-send snapshot, at
      // minimum) and it is served while beta is backing off. The window is per
      // bridge, so alpha cannot be delayed by beta's.
      const delivered = await host.promptForTest(alpha.sessionId, { text: 'what is on the page?' })
      expect(delivered.status).toBe(200)
      expect(delivered.body.ok).toBe(true)
      expect(String(delivered.body.line)).toContain('page answered')
      expect(driver.readsOf(THREAD_A)).toBeGreaterThanOrEqual(1)

      const { token } = await credentials(dir)
      const alphaLine = String((await operator(host, token, { op: 'status', bridge: alpha.sessionId })).body.line)
      const betaLine = String((await operator(host, token, { op: 'status', bridge: beta.sessionId })).body.line)
      expect(alphaLine).toContain('delivery')
      expect(betaLine).toContain('x429')
      expect(betaLine).toMatch(/backoff \d+s/)

      // Another reconcile pass does not sneak a read into beta either.
      await host.pollOnce()
      expect(driver.readsOf(THREAD_B)).toBe(1)
    } finally {
      await host.stop()
      await cleanup()
    }
  }, 30_000)
})

describe('directive C follow-up: a discovery licence survives a refused read', () => {
  // The list walk advances its update_time baseline BEFORE the read it just
  // licensed happens. If that read is refused (the page throttles it, or this
  // bridge's own window refuses it before the driver is even asked) and the
  // licence is spent anyway, the change is never noticed again: the human turn
  // is LOST, not delayed. The licence must go back so the next pass - which the
  // 30 s interval keeps from doing its own list walk - is the one that reads it.
  test('a human turn noticed by the list walk is not lost when the page throttles the licensed read', async () => {
    const { dir, cleanup } = await scratch()
    // A cursor that is a real node on the branch: classification is by position
    // after the cursor, so a fabricated one would make the turn invisible to
    // the very path this row is about.
    const alpha = await baselinedBridge('alpha', THREAD_A, `root-${THREAD_A}`)
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.observable = true
    const listener = await busPeer(dir, 'listener')
    const host = await startHost(dir, driver, { titlesEvery: 30, readBackoffBaseMs: 10 })
    try {
      // The first walk is a baseline: nothing owed, no thread read.
      await host.pollTitles(true)
      expect(driver.readsOf(THREAD_A)).toBe(0)

      // The page throttles this thread. Its Retry-After is a FLOOR on the
      // window, so "inside the window" below is not a race against 10 ms of
      // jitter and this platform's `Date.now()` resolution. The base itself is
      // the directive's 10 ms.
      driver.rateLimit(THREAD_A, 300)
      driver.humanTypes(THREAD_A, 'while you were away', rendered({ uplink: true, to: 'listener', text: 'the late turn' }))

      // The walk sees update_time move and licenses exactly one read.
      await host.pollTitles(true)
      const walksBefore = listWalks(driver).length
      await host.flushTriggers()
      // That one read reached the page and was refused: exactly one driver call
      // and the bridge is inside the window the 429 opened.
      expect(driver.readsOf(THREAD_A)).toBe(1)
      const gate = liveBridge(host, alpha.sessionId).reads
      expect(gate.rateLimited).toBe(1)
      expect(Date.now()).toBeLessThan(gate.backoffUntil)
      // The licence was NOT spent. `threadUpdated` has already advanced past
      // this change, so without the restore it is never licensed again.
      expect(gate.licence).toBe(1)

      // The page answers again; wait out the window.
      driver.clearRateLimit(THREAD_A)
      await new Promise(resolve => setTimeout(resolve, 400))

      // NO forced walk: pollOnce's own pollTitles is coalesced by the 30 s
      // interval, so a second read can only come from the restored licence.
      await host.pollOnce()
      expect(listWalks(driver).length).toBe(walksBefore)
      // Exactly one MORE read, and the human turn was handled by it.
      expect(driver.readsOf(THREAD_A)).toBe(2)

      const inbox = listener.inbox().filter(record => String(record.message.text).includes('the late turn'))
      expect(inbox.length).toBe(1)
      const humans = (await hostAudit(dir)).filter(entry => entry.op === 'human')
      expect(humans.length).toBe(1)
      const stored = await readBridge(dir, alpha.sessionId)
      expect(stored.pendingTurns).toEqual([])
      expect(stored.pendingAttribution).toEqual([])
      await new Promise(resolve => setTimeout(resolve, 200))
      expect(liveBridge(host, alpha.sessionId).pendingWatch).toBeUndefined()
    } finally {
      await listener.close()
      await host.stop()
      await cleanup()
    }
  }, 30_000)
})

describe('directive C follow-up: a thread that reappears is read again', () => {
  // A vanished thread is marked missing from the 404 on the thread itself. When
  // the list shows it again, the walk must license the read that clears that
  // marker; without it the bridge stays wedged on a thread that is visibly back.
  test('the missing marker is cleared by the successful read the list walk licenses', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await baselinedBridge('alpha', THREAD_A)
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.observable = true
    const host = await startHost(dir, driver, { titlesEvery: 30, readBackoffBaseMs: 10 })
    try {
      await host.pollTitles(true)
      expect(driver.readsOf(THREAD_A)).toBe(0)

      // Deleted on the page: out of the list, and a 404 on the thread itself.
      driver.vanish(THREAD_A)
      await host.pollTitles(true)
      await host.flushTriggers()
      expect(driver.readsOf(THREAD_A)).toBe(1)
      expect((await readBridge(dir, alpha.sessionId)).threadMissingAt).not.toBeNull()

      // The marker stops the walk repeating that read every interval.
      await host.pollTitles(true)
      await host.flushTriggers()
      expect(driver.readsOf(THREAD_A)).toBe(1)

      // Back on the page: exactly one more read, and it is the successful one
      // that clears the marker - nothing else does.
      driver.reappear(THREAD_A)
      await host.pollTitles(true)
      await host.flushTriggers()
      expect(driver.readsOf(THREAD_A)).toBe(2)
      expect((await readBridge(dir, alpha.sessionId)).threadMissingAt).toBeNull()

      // And the bridge is usable again, not wedged on the old 404.
      const prompted = await host.promptForTest(alpha.sessionId, { text: 'is this thread back?' })
      expect(prompted.status).toBe(200)
      expect(prompted.body.ok).toBe(true)
    } finally {
      await host.stop()
      await cleanup()
    }
  }, 30_000)
})

describe('directive C: a delivery read refused by its OWN window stays owed', () => {
  // The window bounds the READ, not the turn. A bridge throttled while a
  // sender is waiting must not answer that sender with an error, must not post
  // the turn a second time, and must deliver exactly once when the window
  // closes. This is the same-bridge half of row (3): the per-bridge window can
  // never be confused with a failure of the page.
  test('the turn waits out its own window, then answers once with no error reply', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await baselinedBridge('alpha', THREAD_A)
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.observable = true
    const host = await startHost(dir, driver, { readBackoffBaseMs: 50 })
    const sender = await busPeer(dir, 'sender-own')
    try {
      // Baseline: the idle bridge has nothing owed, so the first tick reads no
      // thread. Only the account-wide list walk runs.
      await host.pollOnce()
      expect(driver.readsOf(THREAD_A)).toBe(0)

      // The page throttles this bridge for a known window.
      driver.rateLimit(THREAD_A, 700)

      const sent = (await sender.send(alpha.sessionId, 'what is on the page?', 'new', undefined, 'inquiry', true)) as { id?: string }
      const m1 = sent.id ?? ''
      expect(m1).not.toBe('')

      // The post-send delivery read is the one the page refuses; it is asked
      // exactly once and then the gate, not the page, answers.
      await waitFor(() => (driver.readsOf(THREAD_A) >= 1 ? true : undefined))
      expect(driver.readsOf(THREAD_A)).toBe(1)

      // Inside the window: still owed, no reply yet, and another pass does not
      // ask the driver a second time.
      await host.pollOnce()
      expect(driver.readsOf(THREAD_A)).toBe(1)
      const owed = await readBridge(dir, alpha.sessionId)
      expect(owed.pendingTurns.length).toBeGreaterThan(0)
      expect(sender.inbox().filter(item => (item.message as unknown as { replyTo?: string }).replyTo === m1).length).toBe(0)

      // The window closes: the read is allowed and the SAME turn is delivered.
      driver.clearRateLimit(THREAD_A)
      const reply = await waitFor(() => sender.inbox().find(item => (item.message as unknown as { replyTo?: string }).replyTo === m1))
      const text = String((reply.message as unknown as { text: string }).text)
      expect(text).toContain('answered on the page')
      // No error to the sender, one reply, and one send on the page.
      expect(text).not.toContain('could not answer')
      expect(sender.inbox().filter(item => (item.message as unknown as { replyTo?: string }).replyTo === m1).length).toBe(1)
      expect(driver.calls.filter(call => String(call.op) === 'send').length).toBe(1)
    } finally {
      await sender.close()
      await host.stop()
      await cleanup()
    }
  }, 30_000)
})
