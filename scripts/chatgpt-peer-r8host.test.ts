/**
 * Round 8, host half: H1, H2, H3 and the addendum, against the tree at
 * `eac9038`. Every test is red on that base for the reason its describe states.
 *
 *   H1a  identity is the text we SENT, not the 4,096-char matcher slot. The
 *        live turn (bridge 3b362ea4, thread 6ae4bfc0, pending 3846f0da) held a
 *        9,642-char body in `text` and only its prefix in `ourText`; with no
 *        `pendingAttribution` left, `ownUserNodeOf` was the only way back to
 *        page node aaee556a and it compared the wrong side.
 *   H1b  one normalizer for every text match: whitespace runs collapse, and a
 *        512+ char strict prefix stands for a truncated record.
 *   H1c  ownership beats classification: a user node carrying a pending send's
 *        text is never a human turn, and the cursor never moves past it.
 *   H1d  `absent` is only honest when NO user node exists in the window; a
 *        near-miss is `present` plus one diagnostic carrying the divergence.
 *   add. a node with no `create_time` is invisible to every time matcher while
 *        `pendingHumanTurns` still sees it by position; it is found by position.
 *   H2   the delivery reads the answer node the caller already has; a failed
 *        second read used to fabricate "a command block only; nothing was sent".
 *   H3   acceptance is the send's own fact: `postedAt` survives ANY exception
 *        once the driver took the text, including a thrown `recordOurs`.
 *
 * Self-contained on purpose: neighbouring lanes' test files register suites at
 * import time, so their harnesses cannot be imported without running them.
 */
import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GatewaySessionTransport } from '../src/utils/gatewaySessionTransport.js'
import { ChatGptHost } from './chatgpt-peer.ts'
import type { DriverChild, DriverReply } from './chatgpt-peer/driver.js'
import { newBridgeState, newHostState, saveJson, type BridgeState } from './chatgpt-peer/state.ts'
import { chainOf, newPageAnswers, type Conversation } from './chatgpt-peer/threads.ts'

const THREAD_A = '11111111-1111-4111-8111-111111111111'

type Call = Record<string, unknown>
type CallOptions = { timeoutMs?: number; onAccepted?: (id: string) => void }

/** The frozen child protocol, in memory. One page, one active thread. */
class FakeDriver {
  readonly calls: Call[] = []
  threads = [{ id: THREAD_A, title: 'Existing work' }]
  answer = 'answered on the page'
  signal: { phase: string | null; threadId: string | null; at: number | null } = { phase: 'complete', threadId: null, at: null }
  /** Every call fails from the first send on: the driver is gone, the page is not. */
  faultError: string | null = null
  wedgeAfterSend = false
  /** Do not grow an assistant node on send: the turn stays unfinished. */
  noAnswer = false
  /** The 1-based conversation read that fails. */
  failConversationAt = Number.POSITIVE_INFINITY
  conversationReads = 0
  lastUserNode: string | null = null
  observable = false
  readonly accepted: string[] = []
  private readonly listeners = new Set<(event: Record<string, unknown>) => void>()
  private current: string | null = null
  readonly trees = new Map<string, { current: string; mapping: Record<string, any> }>()
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

  /** Append one node. `createTime: null` is the live page shape that has no stamp. */
  appendNode(threadId: string, role: 'user' | 'assistant', text: string, options: { createTime?: number | null } = {}): string {
    const tree = this.treeOf(threadId)
    const id = randomUUID()
    tree.mapping[id] = {
      id,
      parent: tree.current,
      children: [],
      message: {
        id,
        author: { role },
        create_time: options.createTime === undefined ? this.clock++ : options.createTime,
        end_turn: role === 'assistant' ? true : null,
        status: 'finished_successfully',
        content: { content_type: 'text', parts: [text] },
      },
    }
    tree.mapping[tree.current]!.children.push(id)
    tree.current = id
    if (role === 'user') this.lastUserNode = id
    return id
  }

  /** A node on an abandoned branch: `current` does not move to it. */
  branchNode(threadId: string, parent: string, role: 'user' | 'assistant', text: string): string {
    const tree = this.treeOf(threadId)
    const id = randomUUID()
    tree.mapping[id] = {
      id,
      parent,
      children: [],
      message: {
        id,
        author: { role },
        create_time: this.clock++,
        end_turn: role === 'assistant' ? true : null,
        status: 'finished_successfully',
        content: { content_type: 'text', parts: [text] },
      },
    }
    tree.mapping[parent]!.children.push(id)
    return id
  }

  /** The open branch, root first. */
  visiblePath(threadId: string): string[] {
    const tree = this.treeOf(threadId)
    const path: string[] = []
    let id: string | null = tree.current
    while (id && tree.mapping[id]) {
      path.push(id)
      id = tree.mapping[id]!.parent
    }
    return path.reverse()
  }

  setNodeText(threadId: string, id: string, text: string): void {
    this.treeOf(threadId).mapping[id]!.message.content.parts = [text]
  }

  setNodeCreateTime(threadId: string, id: string, value: number | null): void {
    this.treeOf(threadId).mapping[id]!.message.create_time = value
  }

  /** The page finishes the turn after a wedge. */
  finishAnswer(text: string): void {
    this.faultError = null
    this.appendNode(this.current ?? THREAD_A, 'assistant', text)
    this.signal = { phase: 'complete', threadId: this.current ?? THREAD_A, at: Date.now() }
  }

  onEvent(handler: (event: Record<string, unknown>) => void): () => void {
    this.listeners.add(handler)
    return () => { this.listeners.delete(handler) }
  }

  emit(event: Record<string, unknown>): void { for (const listener of this.listeners) listener(event) }

  async call(request: Call, options: CallOptions = {}): Promise<DriverReply> {
    const op = String(request.op ?? '')
    if (op === 'ping') return { ok: true, op }
    if (this.faultError) return { ok: false, op, reason: 'timeout', error: this.faultError }
    this.calls.push({ ...request })
    if (op === 'threads') return { ok: true, op, threadId: this.current, threads: this.threads }
    if (op === 'use') {
      const threadId = String(request.threadId ?? '')
      this.current = threadId
      return { ok: true, op, threadId, url: `https://chatgpt.com/c/${threadId}`, adopted: true }
    }
    if (op === 'send') {
      const threadId = this.current ?? THREAD_A
      const text = String(request.text ?? '')
      this.appendNode(threadId, 'user', text)
      // The child reports acceptance as an event, before the call returns.
      if (options.onAccepted) { this.accepted.push(text.slice(0, 32)); options.onAccepted(String(request.id ?? '')) }
      if (!this.noAnswer) this.appendNode(threadId, 'assistant', this.answer)
      this.signal = { phase: this.noAnswer ? 'streaming' : 'complete', threadId, at: Date.now() }
      if (this.wedgeAfterSend) {
        this.wedgeAfterSend = false
        this.faultError = 'driver was replaced after r28 timed out'
      }
      return { ok: true, op, text: this.answer, threadId, model: 'GPT-6', effort: 'High' }
    }
    if (op === 'read') return { ok: true, op, threadId: this.current, text: this.answer, evidence: 'state-complete' }
    if (op === 'conversation' && this.observable) {
      this.conversationReads++
      if (this.conversationReads >= this.failConversationAt) {
        // The live shape: the read is throttled while the page holds the answer.
        return { ok: false, op, error: 'rate limited' }
      }
      const threadId = String(request.threadId ?? '')
      const tree = this.treeOf(threadId)
      return { ok: true, op, conversation: { current_node: tree.current, mapping: structuredClone(tree.mapping) } }
    }
    if (op === 'conversations' && this.observable) {
      const offset = Number(request.offset ?? 0)
      const limit = Number(request.limit ?? 100)
      return { ok: true, op, items: this.threads.slice(offset, offset + limit) }
    }
    if (op === 'unload') { this.current = null; return { ok: true, op, state: 'unloaded' } }
    if (op === 'status') {
      const asked = typeof request.threadId === 'string' ? request.threadId : ''
      if (!asked) return { ok: true, op, threadId: this.current, model: 'GPT-6', effort: 'High' }
      const at = this.signal.at === null ? null : new Date(this.signal.at).toISOString()
      return {
        ok: true, op, cost: 'push', threadId: asked,
        pushedThreadId: this.signal.threadId,
        matchesThread: this.signal.threadId === null ? null : this.signal.threadId === asked,
        state: this.pushedFor(asked), phase: this.signal.phase,
        ageMs: this.signal.at === null ? null : Date.now() - this.signal.at, at,
      }
    }
    return { ok: false, op, error: `unknown op ${op}` }
  }

  private pushedFor(threadId: string): 'generating' | 'idle' | 'failed' | 'unknown' {
    if (this.signal.threadId && this.signal.threadId !== threadId) return 'unknown'
    if (this.signal.phase === 'streaming') return 'generating'
    if (this.signal.phase === 'complete') return 'idle'
    return 'unknown'
  }

  async kill(): Promise<void> {}
  reopen(): void {}
}

async function scratch(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-peer-r8host-'))
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

async function startHost(dir: string, driver: FakeDriver, options: { turnTimeoutMs?: number } = {}): Promise<ChatGptHost> {
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
    turnTimeoutMs: options.turnTimeoutMs ?? 900,
    waitPollMs: 20,
    directory: sessionsDir(dir),
    privateHome: privateHome(dir),
  }, driver as unknown as DriverChild)
  await host.start()
  return host
}

async function waitFor<T>(probe: () => Promise<T | undefined> | T | undefined, timeoutMs = 15_000): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the host')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

const primerSha = async (): Promise<string> =>
  sha256(await readFile(join(import.meta.dir, 'chatgpt-peer', 'primer.md'), 'utf8'))

async function readBridge(dir: string, sessionId: string): Promise<BridgeState> {
  return JSON.parse(await readFile(join(dir, 'bridges', `${sessionId}.json`), 'utf8')) as BridgeState
}

async function busPeer(dir: string, name: string): Promise<{ transport: GatewaySessionTransport; id: string }> {
  const id = randomUUID()
  const transport = new GatewaySessionTransport({
    directory: sessionsDir(dir), sessionId: id, name, cwd: dir, purpose: 'test sender', policy: 'accept',
  })
  await transport.start()
  return { transport, id }
}

async function primedBridge(threadId = THREAD_A): Promise<BridgeState> {
  const bridge = newBridgeState({ sessionId: randomUUID(), name: 'alpha', threadId })
  bridge.primedThreadId = threadId
  bridge.primerSha256 = await primerSha()
  return bridge
}

/** A pending turn as a crash leaves it: posted, no node id, the whole body kept. */
function postedTurn(bridge: BridgeState, options: {
  messageId?: string
  senderSessionId: string
  text: string
  postedAt?: string
}): void {
  bridge.pendingTurns.push({
    threadId: bridge.threadId,
    userNodeId: null,
    ourText: options.text.slice(0, 4096),
    text: options.text,
    senderSessionId: options.senderSessionId,
    messageId: options.messageId ?? randomUUID(),
    kind: 'inquiry',
    postedAt: options.postedAt ?? new Date().toISOString(),
  })
}

const sendCount = (driver: FakeDriver): number => driver.calls.filter(call => call.op === 'send').length

const repliesTo = (transport: GatewaySessionTransport, id: string): string[] =>
  transport.inbox()
    .filter(record => (record.message as unknown as { replyTo?: string }).replyTo === id)
    .map(record => String((record.message as unknown as { text: string }).text))

type PendingRecord = { threadId: string | null; userNodeId: string | null; ourText: string; text: string; senderSessionId: string; messageId: string; kind: string; postedAt: string | null; anchorNodeId?: string | null }
type LiveBridge = {
  state: BridgeState
  removed: boolean
  stopping: boolean
  transport?: { send: (...args: unknown[]) => Promise<unknown>; historyEntries(): unknown[]; inbox(): unknown[] }
}
type Internals = {
  bridges: Map<string, LiveBridge>
  settling: Set<string>
  readConversation: (threadId: string) => Promise<unknown>
  ownUserNodeOf: (
    conversation: unknown, text: string, sinceMs: number, ours: ReadonlySet<string>,
    includeOwned?: boolean, exclude?: ReadonlySet<string>, earliest?: boolean, afterId?: string | null,
  ) => string | null
  postRecordedTurn: (bridge: LiveBridge, record: PendingRecord, locked?: boolean) => Promise<boolean>
  recordOurs: (bridge: LiveBridge, before: Set<string>, sent: string) => Promise<string[]>
  settlePostedTurn: (bridge: LiveBridge, job: PendingRecord, claimed: Set<string>) => Promise<'delivered' | 'present' | 'absent' | 'unreadable'>
}
const internals = (host: ChatGptHost): Internals => host as unknown as Internals

type AuditLine = { op: string; target: string | null; result: string; messageId?: string | null }
async function audits(dir: string): Promise<AuditLine[]> {
  const state = JSON.parse(await readFile(join(dir, 'peer.json'), 'utf8')) as { audit: AuditLine[] }
  return state.audit
}

/** ~9,600 chars of plain prose: longer than the 4,096-char matcher slot. */
const longBody = (): string =>
  Array.from({ length: 60 }, (_, index) => `section ${index}: ${'z'.repeat(150)}`).join('\n\n')

/** Crash one live turn whose page node is then named by `mutate`, and restart. */
async function crashLiveTurn(options: {
  dir: string
  alpha: BridgeState
  sender: GatewaySessionTransport
  body: string
  driver: FakeDriver
}): Promise<{ messageId: string; userNode: string }> {
  const { dir, alpha, sender, body, driver } = options
  const host = await startHost(dir, driver)
  try {
    // The page keeps generating: the answer comes later, so the node this send
    // became is the only thing on the page for now.
    driver.noAnswer = true
    driver.wedgeAfterSend = true
    const receipt = await sender.send(alpha.sessionId, body, 'r8 host turn', undefined, 'inquiry', true) as { id: string }
    // The driver is wedged after the send: the page took the text, the record
    // keeps `postedAt` and no node id, and no failure line is sent.
    await waitFor(() => (driver.faultError ? true : undefined), 15_000)
    await waitFor(async () => {
      const state = await readBridge(dir, alpha.sessionId)
      const turn = state.pendingTurns.find(item => item.messageId === receipt.id)
      return turn && turn.postedAt !== null && turn.userNodeId === null ? true : undefined
    }, 15_000)
    await new Promise(resolve => setTimeout(resolve, 200))
    return { messageId: receipt.id, userNode: driver.lastUserNode! }
  } finally {
    await host.stop()
  }
}

describe('R8-H1a: the sent body is the identity, not its 4,096-char slot', () => {
  test('a ~9,600-char prompt is matched through ownUserNodeOf alone and its answer delivered once', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.observable = true
    const { transport: sender, id: senderId } = await busPeer(dir, 'sender')
    try {
      const body = longBody()
      const { messageId, userNode } = await crashLiveTurn({ dir, alpha, sender, body, driver })
      const crashed = await readBridge(dir, alpha.sessionId)
      const turn = crashed.pendingTurns.find(item => item.messageId === messageId)!
      // The live shape: the body is longer than the matcher slot.
      expect(turn.text.length).toBeGreaterThan(4096)
      expect(turn.ourText.length).toBe(4096)
      // The live state at 22:53:49Z: the attribution entry had expired, so
      // adoption cannot rescue this turn - ownUserNodeOf is the only path.
      crashed.pendingAttribution = []
      await saveJson(join(dir, 'bridges', `${alpha.sessionId}.json`), crashed)
      // The page finishes after the wedge.
      driver.finishAnswer('the answer the long prompt earned')
      const sendsBefore = sendCount(driver)
      const host2 = await startHost(dir, driver)
      try {
        await waitFor(() => (repliesTo(sender, messageId).length >= 1 ? true : undefined), 15_000)
        await new Promise(resolve => setTimeout(resolve, 300))
        expect(repliesTo(sender, messageId).length).toBe(1)
        expect(repliesTo(sender, messageId)[0]).toContain('the answer the long prompt earned')
        expect(repliesTo(sender, messageId).join('\n')).not.toMatch(/could not answer|command block only|model turn failed/)
        // Nothing typed again: the prompt is on the page exactly once.
        expect(sendCount(driver)).toBe(sendsBefore)
        expect(driver.lastUserNode).toBe(userNode)
        const settled = await readBridge(dir, alpha.sessionId)
        expect(settled.pendingTurns.some(item => item.messageId === messageId)).toBe(false)
      } finally {
        await host2.stop()
      }
    } finally {
      await sender.close()
      await cleanup()
    }
  }, 60_000)
})

describe('R8-H1b: one normalizer for every text match', () => {
  test('the shared normalizer collapses whitespace runs and accepts a 512+ char prefix only', async () => {
    // Imported here, not at the top: on the base these do not exist, and a
    // module-level import would fail the whole file instead of this test.
    const mod = await import('./chatgpt-peer/threads.ts') as unknown as {
      normalizePromptText?: (value: string) => string
      promptMatches?: (sent: string, seen: string) => boolean
    }
    expect(typeof mod.normalizePromptText).toBe('function')
    expect(typeof mod.promptMatches).toBe('function')
    const normalize = mod.normalizePromptText!
    const matches = mod.promptMatches!
    const sent = `first paragraph\n\n   second\t\tparagraph ${'w'.repeat(600)}`
    const seen = `first paragraph second paragraph ${'w'.repeat(600)}`
    expect(normalize(sent)).toBe(normalize(seen))
    expect(matches(sent, seen)).toBe(true)
    // A long prefix stands for a truncated record, a short one never does.
    expect(matches('z'.repeat(4096), `${'z'.repeat(4096)} tail`)).toBe(true)
    expect(matches('short', 'short tail')).toBe(false)
    // A mid-string common section is never a match.
    expect(matches(`prelude ${'a'.repeat(600)}`, `epilogue ${'a'.repeat(600)}`)).toBe(false)
  })

  test('a node re-wrapped by the page is delivered, not left for a re-post', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.observable = true
    const { transport: sender, id: senderId } = await busPeer(dir, 'sender')
    try {
      const sent = `question one\n\n   question two\t${'q'.repeat(600)}`
      const seen = `question one question two ${'q'.repeat(600)}`
      driver.appendNode(THREAD_A, 'user', seen)
      driver.appendNode(THREAD_A, 'assistant', 'the answer to the re-wrapped question')
      const messageId = randomUUID()
      postedTurn(alpha, { messageId, senderSessionId: senderId, text: sent })
      await saveJson(join(dir, 'bridges', `${alpha.sessionId}.json`), alpha)
      const host = await startHost(dir, driver)
      try {
        await host.pollOnce()
        await waitFor(() => (repliesTo(sender, messageId).length >= 1 ? true : undefined), 15_000)
        expect(repliesTo(sender, messageId)[0]).toContain('the answer to the re-wrapped question')
        expect(sendCount(driver)).toBe(0)
      } finally {
        await host.stop()
      }
    } finally {
      await sender.close()
      await cleanup()
    }
  }, 40_000)

  test('a record holding only the 4,096-char prefix matches the page holding the whole body', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.observable = true
    const { transport: sender, id: senderId } = await busPeer(dir, 'sender')
    try {
      // Deterministic: the record's text is exactly the page's first 4,096
      // chars, and the page holds a longer body that starts with it.
      const prefix = 'z'.repeat(4096)
      const full = `${prefix} tail ${'q'.repeat(2000)}`
      driver.appendNode(THREAD_A, 'user', full)
      driver.appendNode(THREAD_A, 'assistant', 'the answer to the truncated record')
      const messageId = randomUUID()
      postedTurn(alpha, { messageId, senderSessionId: senderId, text: prefix })
      await saveJson(join(dir, 'bridges', `${alpha.sessionId}.json`), alpha)
      const host = await startHost(dir, driver)
      try {
        await host.pollOnce()
        await waitFor(() => (repliesTo(sender, messageId).length >= 1 ? true : undefined), 15_000)
        expect(repliesTo(sender, messageId)[0]).toContain('the answer to the truncated record')
        expect(sendCount(driver)).toBe(0)
      } finally {
        await host.stop()
      }
    } finally {
      await sender.close()
      await cleanup()
    }
  }, 40_000)
})

describe('R8-H1c: ownership beats classification', () => {
  test('a user node carrying a pending send\'s text is held, never run as a human turn', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.observable = true
    const { transport: sender, id: senderId } = await busPeer(dir, 'sender')
    try {
      // A thread with one earlier turn, so the cursor has a real position.
      driver.appendNode(THREAD_A, 'user', 'an earlier question')
      const earlier = driver.appendNode(THREAD_A, 'assistant', 'an earlier answer')
      alpha.cursor = earlier
      const prompt = 'POSTED PROMPT: the send whose node the page stamped with the wrong clock'
      // The page stamped the send's node BEFORE the post: outside the window,
      // so every time-based matcher must reject it - while `pendingHumanTurns`
      // still sees it by position.
      driver.appendNode(THREAD_A, 'user', prompt, { createTime: Math.floor(Date.now() / 1000) - 3_600 })
      driver.appendNode(THREAD_A, 'assistant', 'the answer the sender is owed')
      const messageId = randomUUID()
      postedTurn(alpha, { messageId, senderSessionId: senderId, text: prompt })
      await saveJson(join(dir, 'bridges', `${alpha.sessionId}.json`), alpha)
      const host = await startHost(dir, driver)
      try {
        // A live turn is still attached to this record, so the observation pass
        // skips it while the human walk runs - the exact window `holdForPendingTurn`
        // exists for (R8-B would otherwise name the node in `resumePendingTurns`
        // before classification ever sees it).
        internals(host).settling.add(messageId)
        await host.pollOnce()
        internals(host).settling.delete(messageId)
        const held = (await audits(dir)).filter(line => /held for pending turn/.test(line.result))
        expect(held.length).toBe(1)
        expect(held[0]!.result).toContain('is not a human turn')
        // It was never classified as a person typing.
        expect((await audits(dir)).some(line => line.op === 'human')).toBe(false)
        expect(repliesTo(sender, messageId).length).toBe(0)
        expect(sendCount(driver)).toBe(0)
        // The next pass delivers the answer the node always carried.
        await host.pollOnce()
        await waitFor(() => (repliesTo(sender, messageId).length >= 1 ? true : undefined), 15_000)
        expect(repliesTo(sender, messageId)[0]).toContain('the answer the sender is owed')
        expect(repliesTo(sender, messageId).length).toBe(1)
        expect(sendCount(driver)).toBe(0)
      } finally {
        await host.stop()
      }
    } finally {
      await sender.close()
      await cleanup()
    }
  }, 40_000)
})

describe('R8-H1d: a near-miss proves presence, never absence', () => {
  test('a mis-matched owed turn is present with a first-divergence diagnostic and is not re-posted', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.observable = true
    const { transport: sender, id: senderId } = await busPeer(dir, 'sender')
    try {
      const body = longBody()
      const { messageId, userNode } = await crashLiveTurn({ dir, alpha, sender, body, driver })
      // The driver recovered; the page is readable again.
      driver.faultError = null
      // The page re-rendered the node with one character changed deep inside
      // the prompt we sent: same window, same role, not the text we sent.
      const sentPrompt = (await readBridge(dir, alpha.sessionId)).pendingTurns.find(item => item.messageId === messageId)!.text
      driver.setNodeText(THREAD_A, userNode, `${sentPrompt.slice(0, 5_000)}X${sentPrompt.slice(5_001)}`)
      const sendsBefore = sendCount(driver)
      const host2 = await startHost(dir, driver)
      try {
        await waitFor(async () => ((await audits(dir)).some(line => /was not accepted \(text mismatch\)/.test(line.result)) ? true : undefined), 15_000)
        const line = (await audits(dir)).find(item => /was not accepted \(text mismatch\)/.test(item.result))!
        expect(line.result).toMatch(/first divergence at \d+/)
        // Both lengths are on the line, and the divergence is a real index.
        expect(line.result).toMatch(/sent \d+ chars, node \d+ chars/)
        expect(Number(/first divergence at (\d+)/.exec(line.result)![1])).toBeGreaterThan(0)
        // The verdict itself, from the method that decides re-posting.
        const live = internals(host2).bridges.get(alpha.sessionId)!
        const job = live.state.pendingTurns.find(item => item.messageId === messageId)!
        expect(await internals(host2).settlePostedTurn(live, job as unknown as PendingRecord, new Set())).toBe('present')
        await new Promise(resolve => setTimeout(resolve, 300))
        // Nothing typed: the prompt is not posted a second time.
        expect(sendCount(driver)).toBe(sendsBefore)
        const state = await readBridge(dir, alpha.sessionId)
        expect(state.pendingTurns.some(item => item.messageId === messageId)).toBe(true)
      } finally {
        await host2.stop()
      }
    } finally {
      await sender.close()
      await cleanup()
    }
  }, 60_000)
})

describe('R8 addendum: a node with no create_time is found by position', () => {
  test('a null-create_time node carrying a pending turn\'s text plus a complete answer is delivered once', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.observable = true
    const { transport: sender, id: senderId } = await busPeer(dir, 'sender')
    try {
      driver.appendNode(THREAD_A, 'user', 'an earlier question')
      const earlier = driver.appendNode(THREAD_A, 'assistant', 'an earlier answer')
      alpha.cursor = earlier
      const prompt = 'POSTED PROMPT: the page did not stamp this node with a create_time'
      // The live asymmetry: no create_time at all, after the cursor.
      driver.appendNode(THREAD_A, 'user', prompt, { createTime: null })
      const answerNode = driver.appendNode(THREAD_A, 'assistant', 'the answer under the unstamped node')
      const messageId = randomUUID()
      postedTurn(alpha, { messageId, senderSessionId: senderId, text: prompt })
      await saveJson(join(dir, 'bridges', `${alpha.sessionId}.json`), alpha)
      const host = await startHost(dir, driver)
      try {
        await host.pollOnce()
        await waitFor(() => (repliesTo(sender, messageId).length >= 1 ? true : undefined), 15_000)
        await new Promise(resolve => setTimeout(resolve, 200))
        expect(repliesTo(sender, messageId).length).toBe(1)
        expect(repliesTo(sender, messageId)[0]).toContain('the answer under the unstamped node')
        expect(sendCount(driver)).toBe(0)
        // It was never classified as a person typing.
        expect((await audits(dir)).some(line => line.op === 'human')).toBe(false)
        // The cursor is at the answer, never past it: delivering in this very
        // pass is what proves the human path (which advances the cursor before
        // it runs) never touched the node.
        const state = await readBridge(dir, alpha.sessionId)
        expect(state.cursor).toBe(answerNode)
      } finally {
        await host.stop()
      }
    } finally {
      await sender.close()
      await cleanup()
    }
  }, 40_000)
})

describe('R8-H2: delivery reads the node the caller already has', () => {
  test('a failed second read never fabricates "a command block only; nothing was sent"', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.observable = true
    // The pass read succeeds; the delivery's own re-read is throttled.
    driver.failConversationAt = 2
    const { transport: sender, id: senderId } = await busPeer(dir, 'sender')
    try {
      const prompt = 'POSTED PROMPT: whose answer is already on the page'
      driver.appendNode(THREAD_A, 'user', prompt)
      driver.appendNode(THREAD_A, 'assistant', 'the prose answer that exists')
      const messageId = randomUUID()
      postedTurn(alpha, { messageId, senderSessionId: senderId, text: prompt })
      await saveJson(join(dir, 'bridges', `${alpha.sessionId}.json`), alpha)
      const host = await startHost(dir, driver)
      try {
        await host.pollOnce()
        await waitFor(() => (repliesTo(sender, messageId).length >= 1 ? true : undefined), 15_000)
        const reply = repliesTo(sender, messageId)[0]!
        expect(reply).toContain('the prose answer that exists')
        expect(reply).not.toContain('command block only')
        expect(sendCount(driver)).toBe(0)
        const state = await readBridge(dir, alpha.sessionId)
        expect(state.pendingTurns.some(item => item.messageId === messageId)).toBe(false)
      } finally {
        await host.stop()
      }
    } finally {
      await sender.close()
      await cleanup()
    }
  }, 40_000)
})

describe('R8-A/B: the live shape - cursor already past the send node', () => {
  test('a null-create_time node behind the cursor is found by its full text and delivered once', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.observable = true
    const { transport: sender, id: senderId } = await busPeer(dir, 'sender')
    try {
      // The live state at 22:43Z: the send node has NO create_time, the cursor
      // was advanced to the send node's first assistant successor by an old
      // human pass, and `ourNodeIds` does not contain it. The anchored matcher
      // is therefore false on both counts - the full text is the only evidence.
      driver.appendNode(THREAD_A, 'user', 'an earlier question')
      driver.appendNode(THREAD_A, 'assistant', 'an earlier answer')
      const prompt = longBody()
      const sendNode = driver.appendNode(THREAD_A, 'user', prompt, { createTime: null })
      const answerNode = driver.appendNode(THREAD_A, 'assistant', 'the answer that was sitting on the page')
      alpha.cursor = answerNode
      const messageId = randomUUID()
      postedTurn(alpha, { messageId, senderSessionId: senderId, text: prompt })
      await saveJson(join(dir, 'bridges', `${alpha.sessionId}.json`), alpha)
      const host = await startHost(dir, driver)
      try {
        await host.pollOnce()
        await waitFor(() => (repliesTo(sender, messageId).length >= 1 ? true : undefined), 15_000)
        await new Promise(resolve => setTimeout(resolve, 300))
        expect(repliesTo(sender, messageId).length).toBe(1)
        expect(repliesTo(sender, messageId)[0]).toContain('the answer that was sitting on the page')
        // No second page turn, and no TTL failure for a turn the page answered.
        expect(sendCount(driver)).toBe(0)
        expect((await audits(dir)).some(line => /no completed answer within/.test(line.result))).toBe(false)
        // The send was never read as a person, and the answer never as page speech.
        expect((await audits(dir)).some(line => line.op === 'human' || line.op === 'unprompted')).toBe(false)
        const state = await readBridge(dir, alpha.sessionId)
        expect(state.pendingTurns.some(item => item.messageId === messageId)).toBe(false)
        expect(state.ourNodeIds).toContain(sendNode)
        expect(state.cursor).toBe(answerNode)
      } finally {
        await host.stop()
      }
    } finally {
      await sender.close()
      await cleanup()
    }
  }, 60_000)
})

describe('R8-A: the post-time anchor outlives the cursor', () => {
  test('a record posted with an anchor matches after the live cursor moved past its node', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.observable = true
    const { transport: sender, id: senderId } = await busPeer(dir, 'sender')
    try {
      driver.appendNode(THREAD_A, 'user', 'an earlier question')
      const earlier = driver.appendNode(THREAD_A, 'assistant', 'an earlier answer')
      alpha.cursor = earlier
      await saveJson(join(dir, 'bridges', `${alpha.sessionId}.json`), alpha)
      const prompt = 'POSTED PROMPT: whose anchor outlives the cursor that moved past it'
      // Post for real: the durable record must carry the post-time cursor.
      driver.noAnswer = true
      driver.wedgeAfterSend = true
      const host = await startHost(dir, driver)
      let messageId: string
      let sendNode: string
      try {
        const receipt = await sender.send(alpha.sessionId, prompt, 'r8 anchor', undefined, 'inquiry', true) as { id: string }
        messageId = receipt.id
        await waitFor(async () => {
          const state = await readBridge(dir, alpha.sessionId)
          const turn = state.pendingTurns.find(item => item.messageId === messageId)
          return turn && turn.postedAt !== null && turn.userNodeId === null ? true : undefined
        }, 15_000)
        sendNode = driver.lastUserNode!
        const posted = (await readBridge(dir, alpha.sessionId)).pendingTurns.find(item => item.messageId === messageId)!
        // R8-A: the anchor is the cursor at post time, not whatever it becomes.
        expect(posted.anchorNodeId).toBe(earlier)
      } finally {
        await host.stop()
      }
      // The page finishes; the send node loses its clock; the live cursor moves
      // PAST it (the live state). Only the record's own anchor can name it.
      driver.faultError = null
      const answerNode = driver.appendNode(THREAD_A, 'assistant', 'the answer under the anchored node')
      driver.setNodeCreateTime(THREAD_A, sendNode, null)
      const moved = await readBridge(dir, alpha.sessionId)
      moved.cursor = answerNode
      await saveJson(join(dir, 'bridges', `${alpha.sessionId}.json`), moved)
      // The live send above is already on `driver.calls`; only a NEW one matters.
      const sendsBefore = sendCount(driver)
      const host2 = await startHost(dir, driver)
      try {
        const live = internals(host2).bridges.get(alpha.sessionId)!
        const read = await internals(host2).readConversation(THREAD_A) as { conversation: unknown }
        const job = live.state.pendingTurns.find(item => item.messageId === messageId)!
        // The positional branch, asked both ways with ownership held out of the
        // argument: the record's own anchor names the node, the live cursor
        // (which moved past it) cannot.
        const noOne = new Set<string>()
        expect(internals(host2).ownUserNodeOf(
          read.conversation, job.text, Date.parse(job.postedAt!), noOne, true, new Set(), true, job.anchorNodeId,
        )).toBe(sendNode)
        expect(internals(host2).ownUserNodeOf(
          read.conversation, job.text, Date.parse(job.postedAt!), noOne, true, new Set(), true, live.state.cursor,
        )).toBeNull()
        await host2.pollOnce()
        await waitFor(() => (repliesTo(sender, messageId).length >= 1 ? true : undefined), 15_000)
        await new Promise(resolve => setTimeout(resolve, 200))
        expect(repliesTo(sender, messageId).length).toBe(1)
        expect(repliesTo(sender, messageId)[0]).toContain('the answer under the anchored node')
        expect(sendCount(driver)).toBe(sendsBefore)
      } finally {
        await host2.stop()
      }
    } finally {
      await sender.close()
      await cleanup()
    }
  }, 60_000)
})

describe('R8-B: the live cursor is not on the visible branch', () => {
  test('a cursor naming an abandoned sibling still ends in a whole-chain delivery', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.observable = true
    const { transport: sender, id: senderId } = await busPeer(dir, 'sender')
    try {
      driver.appendNode(THREAD_A, 'user', 'an earlier question')
      const earlier = driver.appendNode(THREAD_A, 'assistant', 'an earlier answer')
      const prompt = longBody()
      const sendNode = driver.appendNode(THREAD_A, 'user', prompt, { createTime: null })
      const answerNode = driver.appendNode(THREAD_A, 'assistant', 'the answer under the off-branch anchor')
      // The cursor names a REGENERATED sibling of the earlier answer: it is in
      // the mapping but not on the visible path, so `chainOf` has no index for
      // it and the positional branch cannot fire at all.
      const orphan = driver.branchNode(THREAD_A, earlier, 'assistant', 'an earlier answer, regenerated')
      alpha.cursor = orphan
      expect(driver.visiblePath(THREAD_A)).not.toContain(orphan)
      const messageId = randomUUID()
      postedTurn(alpha, { messageId, senderSessionId: senderId, text: prompt })
      await saveJson(join(dir, 'bridges', `${alpha.sessionId}.json`), alpha)
      const host = await startHost(dir, driver)
      try {
        const read = await internals(host).readConversation(THREAD_A) as { conversation: Conversation }
        const job = internals(host).bridges.get(alpha.sessionId)!.state.pendingTurns.find(item => item.messageId === messageId)!
        // The premise: this is exactly the state the cursor is in.
        expect(chainOf(read.conversation).findIndex(turn => turn.id === orphan)).toBe(-1)
        // ... and the anchored matcher therefore reaches nothing.
        expect(internals(host).ownUserNodeOf(
          read.conversation, job.text, Date.parse(job.postedAt!), new Set(), true, new Set(), true, orphan,
        )).toBeNull()
        await host.pollOnce()
        await waitFor(() => (repliesTo(sender, messageId).length >= 1 ? true : undefined), 15_000)
        await new Promise(resolve => setTimeout(resolve, 300))
        expect(repliesTo(sender, messageId).length).toBe(1)
        expect(repliesTo(sender, messageId)[0]).toContain('the answer under the off-branch anchor')
        expect(sendCount(driver)).toBe(0)
        const state = await readBridge(dir, alpha.sessionId)
        expect(state.ourNodeIds).toContain(sendNode)
        expect(state.pendingTurns.some(item => item.messageId === messageId)).toBe(false)
      } finally {
        await host.stop()
      }
    } finally {
      await sender.close()
      await cleanup()
    }
  }, 60_000)
})

describe('R8-C: ownership alone stops the second pass', () => {
  test('a second observation after a whole-chain delivery re-handles nothing', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.observable = true
    const { transport: sender, id: senderId } = await busPeer(dir, 'sender')
    try {
      driver.appendNode(THREAD_A, 'user', 'an earlier question')
      driver.appendNode(THREAD_A, 'assistant', 'an earlier answer')
      const prompt = 'POSTED PROMPT: whose delivery the second pass must leave alone'
      const sendNode = driver.appendNode(THREAD_A, 'user', prompt, { createTime: null })
      const answerNode = driver.appendNode(THREAD_A, 'assistant', 'the answer the second pass must not repeat')
      const messageId = randomUUID()
      postedTurn(alpha, { messageId, senderSessionId: senderId, text: prompt })
      await saveJson(join(dir, 'bridges', `${alpha.sessionId}.json`), alpha)
      const host = await startHost(dir, driver)
      try {
        await host.pollOnce()
        await waitFor(() => (repliesTo(sender, messageId).length >= 1 ? true : undefined), 15_000)
        await new Promise(resolve => setTimeout(resolve, 200))
        const before = (await audits(dir)).length
        const state = await readBridge(dir, alpha.sessionId)
        // The cursor was NOT moved by the recovery; ownership is the barrier.
        expect(state.ourNodeIds).toContain(sendNode)
        await host.pollOnce()
        await new Promise(resolve => setTimeout(resolve, 200))
        // No second reply, no human turn for the send node, no page answer.
        expect(repliesTo(sender, messageId).length).toBe(1)
        const fresh = (await audits(dir)).slice(before)
        expect(fresh.some(line => line.op === 'human' && line.target === sendNode)).toBe(false)
        expect(fresh.some(line => line.op === 'unprompted')).toBe(false)
        const read = await internals(host).readConversation(THREAD_A) as { conversation: Conversation }
        const answers = newPageAnswers(read.conversation, { ours: new Set(state.ourNodeIds), cursor: state.cursor })
        expect(answers.some(item => item.nodeId === answerNode)).toBe(false)
        expect(sendCount(driver)).toBe(0)
      } finally {
        await host.stop()
      }
    } finally {
      await sender.close()
      await cleanup()
    }
  }, 40_000)
})

describe('R8-C: ownership does not swallow a person', () => {
  test('a person\'s node after our send is still a human turn', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.observable = true
    const { transport: sender, id: senderId } = await busPeer(dir, 'sender')
    try {
      driver.appendNode(THREAD_A, 'user', 'an even earlier question')
      const earlier = driver.appendNode(THREAD_A, 'assistant', 'an even earlier answer')
      alpha.cursor = earlier
      // After the old cursor: a person's turn (with its own answer, so the human
      // pass CAN handle it), then our undated send, then the answer we owe.
      const personNode = driver.appendNode(THREAD_A, 'user', 'the person typed this while the host was down')
      driver.appendNode(THREAD_A, 'assistant', 'the page answered the person')
      const prompt = 'POSTED PROMPT: whose recovery must not swallow the person'
      driver.appendNode(THREAD_A, 'user', prompt, { createTime: null })
      driver.appendNode(THREAD_A, 'assistant', 'the answer our sender is owed')
      const messageId = randomUUID()
      postedTurn(alpha, { messageId, senderSessionId: senderId, text: prompt })
      await saveJson(join(dir, 'bridges', `${alpha.sessionId}.json`), alpha)
      const host = await startHost(dir, driver)
      try {
        await host.pollOnce()
        await waitFor(() => (repliesTo(sender, messageId).length >= 1 ? true : undefined), 15_000)
        await new Promise(resolve => setTimeout(resolve, 300))
        expect(repliesTo(sender, messageId).length).toBe(1)
        expect(repliesTo(sender, messageId)[0]).toContain('the answer our sender is owed')
        const human = (await audits(dir)).filter(line => line.op === 'human')
        expect(human.some(line => line.target === personNode)).toBe(true)
        const state = await readBridge(dir, alpha.sessionId)
        expect(state.ourNodeIds).not.toContain(personNode)
        expect(sendCount(driver)).toBe(0)
      } finally {
        await host.stop()
      }
    } finally {
      await sender.close()
      await cleanup()
    }
  }, 40_000)
})

describe('R8-H3: acceptance survives a thrown ledger write', () => {
  test('an accepted send whose recordOurs throws keeps postedAt and is never typed again', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.observable = true
    const { transport: sender, id: senderId } = await busPeer(dir, 'sender')
    try {
      const host = await startHost(dir, driver)
      try {
        const live = internals(host).bridges.get(alpha.sessionId)!
        // The post-send ledger write fails AFTER the driver took the text.
        const real = internals(host).recordOurs
        internals(host).recordOurs = async () => { throw new Error('the delivered-node ledger could not be written') }
        driver.accepted.length = 0
        const prompt = 'POSTED PROMPT: whose post-send ledger write throws'
        const record: PendingRecord = {
          threadId: THREAD_A, userNodeId: null, ourText: prompt, text: prompt,
          senderSessionId: senderId, messageId: randomUUID(), kind: 'inquiry', postedAt: null,
        }
        await expect(internals(host).postRecordedTurn(live, record)).rejects.toThrow(/ledger could not be written/)
        // The driver did accept the send: this is the acceptance the catch must trust.
        expect(driver.accepted.length).toBe(1)
        internals(host).recordOurs = real
        const posted = await readBridge(dir, alpha.sessionId)
        const turn = posted.pendingTurns.find(item => item.messageId === record.messageId)!
        // R8-H3: the post survives, so a recovery settles from evidence instead
        // of typing the same prompt a second time.
        expect(turn.postedAt).not.toBeNull()
        expect(turn.userNodeId).toBeNull()
        // The attribution entry and the pending turn still agree: the entry was
        // never dropped (the throw came first), so the restart adopts the same
        // node and names the same pending record.
        expect(posted.pendingAttribution.length).toBe(1)
        const sendsBefore = sendCount(driver)
        // The page finished the turn; the next observation delivers it.
        await host.pollOnce()
        await waitFor(() => (repliesTo(sender, record.messageId).length >= 1 ? true : undefined), 15_000)
        expect(repliesTo(sender, record.messageId)[0]).toContain('answered on the page')
        expect(sendCount(driver)).toBe(sendsBefore)
      } finally {
        await host.stop()
      }
    } finally {
      await sender.close()
      await cleanup()
    }
  }, 40_000)
})
