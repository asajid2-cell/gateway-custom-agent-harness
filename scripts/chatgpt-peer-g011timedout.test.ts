/**
 * G-011 acceptance fixture: a send that times out while the page finishes.
 *
 * The shape is the live r206 one: the driver answers `send` with
 * `{ ok: false, timedOut: true, state: 'generating' }` (its own budget ran out)
 * and the page goes on to finish the turn. The host must
 *
 *   1. keep the turn owed (the pending record intact),
 *   2. send the sender NO failure line at that moment,
 *   3. deliver the real answer when the observation pass reads it, and
 *   4. never tell the sender "no answer was produced" when no answer arrives.
 *
 * Host-side only: the page is the frozen line-JSON protocol in memory. No
 * network, no browser, no child, no live host.
 */
import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GatewaySessionTransport } from '../src/utils/gatewaySessionTransport.js'
import { ChatGptHost } from './chatgpt-peer.ts'
import type { DriverChild, DriverReply } from './chatgpt-peer/driver.ts'
import { newBridgeState, newHostState, saveJson, type BridgeState } from './chatgpt-peer/state.ts'

const THREAD_A = '11111111-1111-4111-8111-111111111111'
const THREAD_B = '22222222-2222-4222-8222-222222222222'

type Call = Record<string, unknown>

/** The frozen child protocol, in memory. One page, one active thread. */
class FakeDriver {
  readonly calls: Call[] = []
  threads = [{ id: THREAD_A, title: 'Existing work' }, { id: THREAD_B, title: 'Other work' }]
  killed = false
  answer = 'answered on the page'
  sendText = 'answered on the page'
  sendTextFor: ((request: Call) => string) | undefined
  answerFor: ((request: Call) => string | undefined) | undefined
  evidence = 'state-complete'
  readError: string | null = null
  readCalls = 0
  signal: { phase: string | null; threadId: string | null; at: number | null } = { phase: 'complete', threadId: null, at: null }
  generating = false
  refuseSend = false
  busyUntil = 0
  readonly sentAtMs: number[] = []
  stallFor: ((request: Call) => boolean) | undefined
  landOn: string | null = null
  sendError: string | null = null
  private readonly listeners = new Set<(event: Record<string, unknown>) => void>()
  private current: string | null = null
  observable = false
  readonly deleted = new Set<string>()
  conversationReads = 0
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

  private grow(threadId: string, role: 'user' | 'assistant', text: string): string {
    const tree = this.treeOf(threadId)
    const id = randomUUID()
    tree.mapping[id] = { id, parent: tree.current, children: [], message: { id, author: { role }, create_time: this.clock++, end_turn: role === 'assistant' ? true : null, status: 'finished_successfully', content: { content_type: 'text', parts: [text] } } }
    tree.mapping[tree.current].children.push(id)
    tree.current = id
    return id
  }

  /** The page going on to finish a turn the send gave up on. */
  finish(text: string, threadId = THREAD_A): void {
    this.grow(threadId, 'assistant', text)
    this.signal = { phase: 'complete', threadId, at: Date.now() }
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
      if (!this.threads.some(thread => thread.id === threadId)) {
        return { ok: false, op, error: `the page landed on no thread instead of the requested thread ${threadId}` }
      }
      this.current = threadId
      return { ok: true, op, threadId, url: `https://chatgpt.com/c/${threadId}`, adopted: true }
    }
    if (op === 'reload') {
      const threadId = String(request.threadId ?? '')
      this.current = threadId || this.current
      return { ok: true, op, threadId: this.current }
    }
    if (op === 'send') {
      if (this.sendError) return { ok: false, op, error: this.sendError }
      if (this.generating || this.refuseSend) {
        return { ok: false, op, reason: 'busy', state: 'generating', threadId: this.current, error: 'the page is mid-turn; your message was not typed' }
      }
      const requested = typeof request.threadId === 'string' ? request.threadId : null
      const threadId = this.landOn ?? requested ?? (request.newChat ? randomUUID() : this.current)
      if (!threadId) return { ok: false, op, error: 'no thread is open' }
      this.current = threadId
      this.answer = this.answerFor?.(request) ?? this.answer
      const stalls = this.stallFor?.(request) === true
      this.grow(threadId, 'user', String(request.text ?? ''))
      if (!stalls) this.grow(threadId, 'assistant', this.answer)
      this.signal = { phase: stalls ? 'streaming' : 'complete', threadId, at: Date.now() }
      this.sentAtMs.push(Date.now())
      onAccepted?.(String(request.id ?? ''))
      // The child's own budget ran out while the page kept working: this is the
      // r206 reply the host must treat as a state, not a failure.
      if (request.wait === true && stalls) return { ok: false, op, reason: 'timeout', timedOut: true, state: 'generating', threadId }
      return { ok: true, op, text: this.sendTextFor?.(request) ?? this.answer, threadId, model: 'GPT-6', effort: 'High' }
    }
    if (op === 'read') {
      this.readCalls++
      if (this.readError) return { ok: false, op, error: this.readError }
      return { ok: true, op, threadId: this.current, text: this.answer, evidence: this.evidence }
    }
    if (op === 'conversation' && this.observable) {
      this.conversationReads++
      const threadId = String(request.threadId ?? '')
      if (this.deleted.has(threadId)) return { ok: false, op, status: 404, error: 'conversation not found' }
      const tree = this.treeOf(threadId)
      return { ok: true, op, conversation: { current_node: tree.current, mapping: structuredClone(tree.mapping) } }
    }
    if (op === 'conversations' && this.observable) {
      const offset = Number(request.offset ?? 0)
      const limit = Number(request.limit ?? 100)
      return { ok: true, op, items: this.threads.filter(thread => !this.deleted.has(thread.id)).slice(offset, offset + limit) }
    }
    if (op === 'unload') { this.current = null; return { ok: true, op, state: 'unloaded' } }
    if (op === 'status') {
      const asked = typeof request.threadId === 'string' ? request.threadId : ''
      if (!asked) return { ok: true, op, threadId: this.current, model: 'GPT-6', effort: 'High' }
      const pushed = this.pushedFor(asked)
      const at = this.signal.at === null ? null : new Date(this.signal.at).toISOString()
      if (request.deep !== true) {
        return {
          ok: true, op, cost: 'push', threadId: asked,
          pushedThreadId: this.signal.threadId,
          matchesThread: this.signal.threadId === null ? null : this.signal.threadId === asked,
          state: pushed, phase: this.signal.phase,
          ageMs: this.signal.at === null ? null : Date.now() - this.signal.at, at,
        }
      }
      const tree = this.treeOf(asked)
      const node = newestAnswerNode(tree)
      const text = node ? String(node.message?.content?.parts?.[0] ?? '') : ''
      return {
        ok: true, op, cost: 'conversation', threadId: asked,
        state: pushed, phase: this.signal.phase,
        ageMs: this.signal.at === null ? null : Date.now() - this.signal.at, at,
        matchesThread: this.signal.threadId === null ? null : this.signal.threadId === asked,
        latestAssistant: node ? { nodeId: node.id, complete: node.message?.end_turn === true, chars: text.length, files: [] } : null,
        files: [],
      }
    }
    if (op === 'file') {
      const outPath = String(request.outPath ?? '')
      if (!request.fileId && !(request.threadId && request.messageId && request.sandboxPath)) return { ok: false, op, reason: 'bad-id' }
      const body = `bytes of ${String(request.fileId ?? request.sandboxPath)}`
      try { await writeFile(outPath, body, { flag: 'wx' }) }
      catch (error) { return { ok: false, op, reason: (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'exists' : 'io' } }
      return { ok: true, op, path: outPath, bytes: Buffer.byteLength(body), sha256: sha256(body) }
    }
    return { ok: false, op, error: `unknown op ${op}` }
  }

  private pushedFor(threadId: string): 'generating' | 'idle' | 'failed' | 'unknown' {
    if (this.generating || Date.now() < this.busyUntil) return 'generating'
    if (this.signal.threadId && this.signal.threadId !== threadId) return 'unknown'
    if (this.signal.phase === 'streaming') return 'generating'
    if (this.signal.phase === 'complete') return 'idle'
    return 'unknown'
  }

  async kill(): Promise<void> { this.killed = true }
  reopen(): void { this.killed = false }
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
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-peer-g011t-'))
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

async function waitFor<T>(probe: () => Promise<T | undefined> | T | undefined, timeoutMs = 10_000): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the host')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const bridgeNamed = (name: string, threadId: string | null): BridgeState =>
  newBridgeState({ sessionId: randomUUID(), name, threadId })

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

const primerSha = async (): Promise<string> =>
  sha256(await readFile(join(import.meta.dir, 'chatgpt-peer', 'primer.md'), 'utf8'))

async function readBridge(dir: string, sessionId: string): Promise<BridgeState> {
  return JSON.parse(await readFile(join(dir, 'bridges', `${sessionId}.json`), 'utf8')) as BridgeState
}

async function hostAudit(dir: string): Promise<{ op: string; target: string | null; result: string; messageId?: string }[]> {
  const state = JSON.parse(await readFile(join(dir, 'peer.json'), 'utf8')) as { audit: { op: string; target: string | null; result: string; messageId?: string }[] }
  return state.audit
}

/** A primed bridge: its primer is already posted, so a call log starts empty. */
async function primed(name: string, threadId: string): Promise<BridgeState> {
  const bridge = bridgeNamed(name, threadId)
  bridge.primedThreadId = threadId
  bridge.primerSha256 = await primerSha()
  return bridge
}

/** A real bus peer in the scratch directory, addressed by a live registration. */
async function busPeer(dir: string, name: string): Promise<GatewaySessionTransport> {
  const transport = new GatewaySessionTransport({
    directory: sessionsDir(dir),
    sessionId: randomUUID(),
    name,
    cwd: dir,
    purpose: 'test peer',
    policy: 'accept',
  })
  await transport.start()
  return transport
}

type PeerMessage = { id: string; replyTo?: string; fromSessionId: string; toSessionId: string; text: string; summary: string }

const inboxMessages = (transport: GatewaySessionTransport): PeerMessage[] =>
  transport.inbox().map(record => record.message as unknown as PeerMessage)

const repliesTo = (sender: GatewaySessionTransport, messageId: string): PeerMessage[] =>
  inboxMessages(sender).filter(message => message.replyTo === messageId)

/** A live inbound on the bus: the host runs it as the sender's own turn. */
async function sendInbound(
  sender: GatewaySessionTransport, to: string, text: string, summary: string,
): Promise<string> {
  const receipt = await sender.send(to, text, summary, undefined, 'inquiry', true) as { id?: string }
  if (!receipt?.id) throw new Error('the sender got no message id')
  return receipt.id
}

interface TimedOutTurn {
  dir: string
  cleanup: () => Promise<void>
  alpha: BridgeState
  sender: GatewaySessionTransport
  driver: FakeDriver
  host: ChatGptHost
  messageId: string
}

/**
 * Drive one turn whose `send` reply is `timedOut` and stop at the moment the
 * host has recognised it (the give-up audit line is written). The page is
 * left "streaming": it has our user node and no answer yet.
 */
async function timedOutTurn(): Promise<TimedOutTurn> {
  const { dir, cleanup } = await scratch()
  const alpha = await primed('alpha', THREAD_A)
  await seedHost(dir, [alpha])
  const sender = await busPeer(dir, 'sender')
  const driver = new FakeDriver()
  driver.observable = true
  // Only the seed post runs with wait:true; it is the one that times out.
  driver.stallFor = request => request.wait === true
  const host = await startHost(dir, driver)
  const messageId = await sendInbound(sender, alpha.sessionId, 'count the peers', 'g011 timed out send')
  await waitFor(() => driver.calls.some(call => call.op === 'send' && call.wait === true), 8_000)
  await waitFor(async () => (await hostAudit(dir)).find(entry =>
    entry.op === 'turn' && entry.messageId === messageId && /still generating/.test(entry.result)), 8_000)
  await delay(150)
  return { dir, cleanup, alpha, sender, driver, host, messageId }
}

async function closeTurn(turn: TimedOutTurn): Promise<void> {
  await turn.sender.close().catch(() => {})
  await turn.host.stop().catch(() => {})
  await turn.cleanup()
}

describe('G-011: a timedOut send while the page finishes the turn', () => {
  // Row 1: no failure line, the turn stays owed ------------------------------
  test('1. a timedOut reply sends the sender nothing and keeps the turn owed', async () => {
    const turn = await timedOutTurn()
    try {
      // No reply at all was sent at the moment the send gave up.
      expect(repliesTo(turn.sender, turn.messageId).length).toBe(0)
      // The pending record is intact and still names the post.
      const stored = await readBridge(turn.dir, turn.alpha.sessionId)
      const record = stored.pendingTurns.find(item => item.messageId === turn.messageId)
      expect(record).toBeDefined()
      expect(record!.postedAt).not.toBeNull()
    } finally {
      await closeTurn(turn)
    }
  }, 30_000)

  // Row 2: the observation pass delivers the answer --------------------------
  test('2. the observation pass delivers the finished answer and retires the record', async () => {
    const turn = await timedOutTurn()
    try {
      expect(repliesTo(turn.sender, turn.messageId).length).toBe(0)
      // The page finishes on its own, after the send gave up.
      turn.driver.finish('the answer landed after the timeout')
      await turn.host.pollOnce()
      const reply = await waitFor(() => repliesTo(turn.sender, turn.messageId)[0], 10_000)
      expect(reply.text).toContain('the answer landed after the timeout')
      await delay(200)
      expect(repliesTo(turn.sender, turn.messageId).length).toBe(1)
      const stored = await readBridge(turn.dir, turn.alpha.sessionId)
      expect(stored.pendingTurns.some(item => item.messageId === turn.messageId)).toBe(false)
    } finally {
      await closeTurn(turn)
    }
  }, 30_000)

  // Row 3: the audit does not accuse the driver ------------------------------
  test('3. the give-up audit line does not claim a driver failure', async () => {
    const turn = await timedOutTurn()
    try {
      const lines = (await hostAudit(turn.dir))
        .filter(entry => entry.op === 'turn' && entry.messageId === turn.messageId)
        .map(entry => entry.result)
      expect(lines.length).toBeGreaterThan(0)
      // It must say the page was still generating: that is the honest state.
      expect(lines.join('\n')).toContain('still generating')
      // A timedOut reply says nothing about the driver, so the audit must not
      // blame it. (#46 owns the exact replacement wording.)
      expect(lines.join('\n')).not.toMatch(/driver fail/i)
    } finally {
      await closeTurn(turn)
    }
  }, 30_000)

  // Row 4: a page that never answers is never called answerless ---------------
  test('4. a timedOut send whose page never answers is never told "no answer was produced"', async () => {
    const turn = await timedOutTurn()
    try {
      for (let pass = 0; pass < 5; pass += 1) {
        await turn.host.pollOnce()
        await delay(80)
      }
      const mine = repliesTo(turn.sender, turn.messageId)
      for (const reply of mine) expect(reply.text).not.toContain('no answer was produced')
      // Staying owed is the correct end state: the sender is waiting, and the
      // record is still there for a later observation.
      expect(mine.length).toBe(0)
      const stored = await readBridge(turn.dir, turn.alpha.sessionId)
      const record = stored.pendingTurns.find(item => item.messageId === turn.messageId)
      expect(record).toBeDefined()
      expect(record!.postedAt).not.toBeNull()
    } finally {
      await closeTurn(turn)
    }
  }, 40_000)
})
