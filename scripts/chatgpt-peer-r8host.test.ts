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
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  /**
   * R10-F3: the next send PUTS THE NODE ON THE PAGE but reports
   * `reason: 'ambiguous'` - it cannot prove the post either way, so it never
   * fires `accepted`. This is the driver's new refusal to re-click Send.
   */
  ambiguousSend: string | null = null
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
      if (this.ambiguousSend) {
        // The node landed, but the driver will not claim it: no `accepted`
        // event, and the reply says the post is unproven.
        const error = this.ambiguousSend
        this.ambiguousSend = null
        if (!this.noAnswer) this.appendNode(threadId, 'assistant', this.answer)
        this.signal = { phase: this.noAnswer ? 'streaming' : 'complete', threadId, at: Date.now() }
        return { ok: false, op, reason: 'ambiguous', error, threadId }
      }
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
  textMatchAnywhere: (conversation: unknown, text: string, ours: ReadonlySet<string>, exclude: ReadonlySet<string>, postedMs: number) => string | null
  bodyContainedIn: (conversation: unknown, text: string, ours: ReadonlySet<string>, exclude: ReadonlySet<string>, postedMs: number, afterId: string | null) => string | null
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
  let messageId = ''
  try {
    // The page keeps generating: the answer comes later, so the node this send
    // became is the only thing on the page for now.
    driver.noAnswer = true
    driver.wedgeAfterSend = true
    const receipt = await sender.send(alpha.sessionId, body, 'r8 host turn', undefined, 'inquiry', true) as { id: string }
    messageId = receipt.id
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
    // DETERMINISM: the acknowledgement is fire-and-forget, so whether the crash
    // beat it is a race, not a property of the fix. Model the worst case the
    // crash window can leave - the record still QUEUED with a posted job - so
    // the restart always starts from the state a kill in the accept window
    // leaves behind. (The ack's actual state is asserted below.)
    if (messageId) await forceInboxQueued(dir, alpha.sessionId, messageId)
  }
}

/** The inbox file one session owns, read and written the way the transport does. */
async function forceInboxQueued(dir: string, sessionId: string, messageId: string): Promise<void> {
  const path = join(sessionsDir(dir), `${sessionId}.inbox`)
  const inbox = JSON.parse(await readFile(path, 'utf8')) as {
    records: { message: { id: string }; state: string }[]
    history?: { direction: string; message: { id: string }; status?: string }[]
  }
  const record = inbox.records.find(item => item.message.id === messageId)
  // The record always exists: it was delivered into this inbox. If the ack did
  // land it says 'delivered'; the crash window says 'queued'. Force the window.
  if (!record) throw new Error(`no inbox record for ${messageId}`)
  record.state = 'queued'
  for (const entry of inbox.history ?? []) {
    if (entry.direction === 'received' && entry.message.id === messageId) entry.status = 'queued'
  }
  await writeFile(path, JSON.stringify(inbox))
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
      // The restart state is EXPLICIT, not a race: the inbound is queued (the
      // kill-before-ack window, forced by `crashLiveTurn`) and the job is
      // posted with no anchor. A drain must not start a second turn from it.
      const inbox = JSON.parse(await readFile(join(sessionsDir(dir), `${alpha.sessionId}.inbox`), 'utf8')) as {
        records: { message: { id: string }; state: string }[]
      }
      expect(inbox.records.find(item => item.message.id === messageId)!.state).toBe('queued')
      expect(turn.postedAt).not.toBeNull()
      expect(turn.anchorNodeId ?? null).toBeNull()
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
      // The crash window: the wedged send never returned true, so no ack left,
      // and the inbound is still `queued` while its job is posted - exactly the
      // state a kill between accept and ack leaves. Forced so a drain that starts
      // a second page turn for this record cannot hide behind a lucky ack.
      await forceInboxQueued(dir, alpha.sessionId, messageId)
      // The page finishes; the send node loses its clock; the live cursor moves
      // PAST it (the live state). Only the record's own anchor can name it.
      driver.faultError = null
      const answerNode = driver.appendNode(THREAD_A, 'assistant', 'the answer under the anchored node')
      driver.setNodeCreateTime(THREAD_A, sendNode, null)
      const moved = await readBridge(dir, alpha.sessionId)
      moved.cursor = answerNode
      await saveJson(join(dir, 'bridges', `${alpha.sessionId}.json`), moved)
      // The durable record as the crash left it, read from disk rather than from
      // the restarted host: the recovery is allowed to settle or retire it, and
      // neither may change the inputs of the probe below.
      const record = moved.pendingTurns.find(item => item.messageId === messageId)!
      expect(record.postedAt).not.toBeNull()
      expect(record.anchorNodeId).toBe(earlier)
      // The live send above is already on `driver.calls`; only a NEW one matters.
      const sendsBefore = sendCount(driver)
      const host2 = await startHost(dir, driver)
      try {
        const read = await internals(host2).readConversation(THREAD_A) as { conversation: unknown }
        // The positional branch, asked both ways with ownership held out of the
        // argument: the record's own anchor names the node, the live cursor
        // (which moved past it) cannot.
        const noOne = new Set<string>()
        expect(internals(host2).ownUserNodeOf(
          read.conversation, record.text, Date.parse(record.postedAt!), noOne, true, new Set(), true, record.anchorNodeId,
        )).toBe(sendNode)
        expect(internals(host2).ownUserNodeOf(
          read.conversation, record.text, Date.parse(record.postedAt!), noOne, true, new Set(), true, moved.cursor,
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

/** The shared matcher, loaded per test: on a base without it the test, not the file, goes red. */
const promptMatchesOf = async (): Promise<(sent: string, seen: string) => boolean> =>
  (await import('./chatgpt-peer/threads.ts')).promptMatches

/** A hand-built conversation on one visible path, root first. */
function visibleConversation(nodes: { id: string; parent: string | null; role: 'user' | 'assistant'; text: string; createTime?: number | null }[]): Conversation {
  const mapping: Record<string, unknown> = {}
  for (const node of nodes) {
    mapping[node.id] = {
      id: node.id,
      parent: node.parent,
      children: [],
      message: {
        id: node.id,
        author: { role: node.role },
        create_time: node.createTime === undefined ? null : node.createTime,
        end_turn: node.role === 'assistant' ? true : null,
        status: 'finished_successfully',
        content: { content_type: 'text', parts: [node.text] },
      },
    }
  }
  return { current_node: nodes.at(-1)!.id, mapping } as unknown as Conversation
}

describe('R8-A2: the whole-body recovery matcher', () => {
  test('a node holding only a 512+ char PARTIAL run in its middle is still not a match', async () => {
    const prompt = longBody()
    const quotedText = `Quoted before the paste. ${prompt.slice(1_000, 1_800)} And quoted after it.`
    const quoted = visibleConversation([
      { id: 'u1', parent: null, role: 'user', text: quotedText, createTime: Date.now() / 1000 },
    ])
    const none = new Set<string>()
    // A pure text comparison: no host state is read, so the node is otherwise
    // perfectly eligible (fresh) and still refused - the run is partial.
    const host = Object.create(ChatGptHost.prototype) as ChatGptHost
    expect(internals(host).bodyContainedIn(quoted, prompt, none, none, Date.now(), null)).toBeNull()
    expect(internals(host).textMatchAnywhere(quoted, prompt, none, none, Date.now())).toBeNull()
    const promptMatches = await promptMatchesOf()
    expect(promptMatches(prompt, quotedText)).toBe(false)
  })

  test('containment needs UNIQUENESS and TEMPORAL eligibility (R9-F2)', () => {
    const prompt = longBody()
    const none = new Set<string>()
    const host = Object.create(ChatGptHost.prototype) as ChatGptHost
    const nowMs = Date.now()
    const nowSec = nowMs / 1000
    const check = (conversation: Conversation, postedMs = nowMs, afterId: string | null = null): string | null =>
      internals(host).bodyContainedIn(conversation, prompt, none, none, postedMs, afterId)

    // Two in-window carriers: uniqueness fails closed even though both are fresh.
    const two = visibleConversation([
      { id: 'u1', parent: null, role: 'user', text: `${prompt} first`, createTime: nowSec },
      { id: 'a1', parent: 'u1', role: 'assistant', text: 'an answer', createTime: nowSec },
      { id: 'u2', parent: 'a1', role: 'user', text: `second ${prompt}`, createTime: nowSec },
    ])
    expect(check(two)).toBeNull()

    // Exactly one fresh carrier inside the posting window: named.
    const one = visibleConversation([
      { id: 'u1', parent: null, role: 'user', text: `before ${prompt} after`, createTime: nowSec },
    ])
    expect(check(one)).toBe('u1')

    // R9-F2: the same text an HOUR before the post is a historical quote, not
    // our send. It fails `ownUserNodeOf`'s window and containment's copy of it.
    const old = visibleConversation([
      { id: 'u1', parent: null, role: 'user', text: `before ${prompt} after`, createTime: nowSec - 3_600 },
    ])
    expect(check(old)).toBeNull()

    // An undated carrier is eligible only AFTER the preserved positional anchor.
    const undated = visibleConversation([
      { id: 'anchor', parent: null, role: 'assistant', text: 'the cursor when we posted', createTime: nowSec },
      { id: 'u1', parent: 'anchor', role: 'user', text: `before ${prompt} after` },
    ])
    expect(check(undated, nowMs, 'anchor')).toBe('u1')
    // ... with no anchor at all there is no positional evidence: refused.
    expect(check(undated, nowMs, null)).toBeNull()
    // ... and a node BEFORE the anchor cannot be the send: refused.
    const preAnchor = visibleConversation([
      { id: 'u1', parent: null, role: 'user', text: `before ${prompt} after` },
      { id: 'anchor', parent: 'u1', role: 'assistant', text: 'the cursor when we posted', createTime: nowSec },
    ])
    expect(check(preAnchor, nowMs, 'anchor')).toBeNull()
  })

  test('the live doubled node is named on the recovery path and its answer is delivered exactly once, nothing typed', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.observable = true
    const { transport: sender, id: senderId } = await busPeer(dir, 'sender')
    try {
      driver.appendNode(THREAD_A, 'user', 'an earlier question')
      driver.appendNode(THREAD_A, 'assistant', 'an earlier answer')
      const prompt = longBody()
      // The live shape: the driver pasted the body twice into one composer, so
      // the node starts mid-prompt, holds the WHOLE body, then the rest.
      const cut = prompt.indexOf('section 5:')
      expect(cut).toBeGreaterThan(0)
      const doubled = prompt.slice(0, cut) + prompt + prompt.slice(cut)
      expect(doubled.length).toBeGreaterThan(prompt.length)
      expect(doubled.includes(prompt)).toBe(true)
      // The live node `aaee556a`: create_time 1793400052.371 against a post at
      // 1793400053.214 - DATED but ~0.84s BEFORE the post, inside the 30s window.
      const sendNode = driver.appendNode(THREAD_A, 'user', doubled, { createTime: Date.now() / 1000 - 0.843 })
      const answerNode = driver.appendNode(THREAD_A, 'assistant', 'the answer the doubled prompt earned')
      // Live state: the cursor sits on the answer, past the send node.
      alpha.cursor = answerNode
      const messageId = randomUUID()
      postedTurn(alpha, { messageId, senderSessionId: senderId, text: prompt })
      await saveJson(join(dir, 'bridges', `${alpha.sessionId}.json`), alpha)
      const record = (await readBridge(dir, alpha.sessionId)).pendingTurns.find(item => item.messageId === messageId)!
      const host = await startHost(dir, driver)
      try {
        const read = await internals(host).readConversation(THREAD_A) as { conversation: Conversation }
        const none = new Set<string>()
        // Premise: the legacy record has no anchor, the send node's clock is
        // INSIDE the posting window, the cursor is past it, and equal-or-prefix
        // still rejects the doubling.
        expect(record.anchorNodeId ?? null).toBeNull()
        expect(internals(host).ownUserNodeOf(
          read.conversation, record.text, Date.parse(record.postedAt!), none, true, none, true, alpha.cursor,
        )).toBeNull()
        expect(internals(host).textMatchAnywhere(read.conversation, record.text, none, none, Date.parse(record.postedAt!))).toBeNull()
        const promptMatches = await promptMatchesOf()
        expect(promptMatches(record.text, doubled)).toBe(false)
        // ... so containment is the only path left, and it accepts this node on
        // BOTH counts: whole body and inside the posting window (R9-F2). R10-F1:
        // the gate keys on the PRESERVED anchor (null here), never the cursor -
        // the live cursor sits PAST this node and must not read as "before it".
        expect(internals(host).bodyContainedIn(
          read.conversation, record.text, none, none, Date.parse(record.postedAt!), record.anchorNodeId ?? null,
        )).toBe(sendNode)
        await host.pollOnce()
        await waitFor(() => (repliesTo(sender, messageId).length >= 1 ? true : undefined), 15_000)
        await new Promise(resolve => setTimeout(resolve, 300))
        expect(repliesTo(sender, messageId).length).toBe(1)
        expect(repliesTo(sender, messageId)[0]).toContain('the answer the doubled prompt earned')
        expect(sendCount(driver)).toBe(0)
        const state = await readBridge(dir, alpha.sessionId)
        expect(state.pendingTurns.some(item => item.messageId === messageId)).toBe(false)
        expect(state.ourNodeIds).toContain(sendNode)
        // Ownership is the barrier; the cursor is untouched.
        expect(state.cursor).toBe(answerNode)
        expect((await audits(dir)).some(line => /no completed answer within/.test(line.result))).toBe(false)
        expect((await audits(dir)).some(line => line.op === 'human' || line.op === 'unprompted')).toBe(false)
      } finally {
        await host.stop()
      }
    } finally {
      await sender.close()
      await cleanup()
    }
  }, 60_000)

  test('R9-F2: a historical message quoting the whole prompt is never adopted or answered (reviewer repro)', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.observable = true
    const { transport: sender, id: senderId } = await busPeer(dir, 'sender')
    try {
      const prompt = longBody()
      const dayAgo = Date.now() / 1000 - 24 * 3_600
      // A person discussed the prompt a day earlier, quoting it in full.
      const oldUser = driver.appendNode(THREAD_A, 'user', `Here is the full prompt I received: ${prompt}`, { createTime: dayAgo })
      driver.appendNode(THREAD_A, 'assistant', 'the historical answer to the quoted prompt', { createTime: dayAgo + 5 })
      const messageId = randomUUID()
      postedTurn(alpha, { messageId, senderSessionId: senderId, text: prompt })
      await saveJson(join(dir, 'bridges', `${alpha.sessionId}.json`), alpha)
      const host = await startHost(dir, driver)
      try {
        const live = internals(host).bridges.get(alpha.sessionId)!
        const read = await internals(host).readConversation(THREAD_A) as { conversation: Conversation }
        const none = new Set<string>()
        const job = live.state.pendingTurns.find(item => item.messageId === messageId)
        const postedMs = Date.parse(job?.postedAt ?? new Date().toISOString())
        // The verdict, deterministic: containment refuses the historical node
        // because it falls far outside the posting window.
        expect(internals(host).bodyContainedIn(read.conversation, prompt, none, none, postedMs, null)).toBeNull()
        // Let recovery run. It may legitimately re-post (the send never landed),
        // but it must never adopt the historical node or forward its answer.
        await new Promise(resolve => setTimeout(resolve, 1_500))
        expect(repliesTo(sender, messageId).some(text => text.includes('the historical answer'))).toBe(false)
        const state = await readBridge(dir, alpha.sessionId)
        expect(state.ourNodeIds).not.toContain(oldUser)
      } finally {
        await host.stop()
      }
    } finally {
      await sender.close()
      await cleanup()
    }
  }, 60_000)

  test('promptMatches stays strictly equal-or-prefix (containment does not leak into it)', async () => {
    const promptMatches = await promptMatchesOf()
    const body = longBody()
    expect(promptMatches(body, body)).toBe(true)
    expect(promptMatches(body, `${body} appended`)).toBe(true)
    expect(promptMatches(`${body} appended`, body)).toBe(true)
    // A mid-string run is neither equality nor a prefix.
    expect(promptMatches(body, `xx${body}yy`)).toBe(false)
    // A prefix shorter than the floor is a guess, not a match.
    expect(promptMatches(body, body.slice(0, 511))).toBe(false)
    expect(promptMatches('short', 'short')).toBe(true)
  })
})

describe('R9: a send refused acceptance amid two new user nodes', () => {
  test('the observation pass still settles it by identity and never adopts the stranger', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.observable = true
    const { transport: sender, id: senderId } = await busPeer(dir, 'sender')
    try {
      const prompt = 'POSTED PROMPT: two new user nodes must not strand this turn'
      driver.appendNode(THREAD_A, 'user', 'an earlier question')
      const anchor = driver.appendNode(THREAD_A, 'assistant', 'an earlier answer')
      alpha.cursor = anchor
      // The send went out while a person typed, so TWO new user nodes sit after
      // the anchor. The driver refuses to call either one "the accepted send",
      // and the host records the job as posted with no node id and no ack.
      const clock = Date.now() / 1000
      const stranger = driver.appendNode(THREAD_A, 'user', 'a person typed this during the send', { createTime: clock - 0.5 })
      driver.appendNode(THREAD_A, 'assistant', 'the page answer to the person', { createTime: clock - 0.4 })
      const sendNode = driver.appendNode(THREAD_A, 'user', prompt, { createTime: clock - 0.2 })
      driver.appendNode(THREAD_A, 'assistant', 'the answer our sender is owed', { createTime: clock - 0.1 })
      const messageId = randomUUID()
      postedTurn(alpha, { messageId, senderSessionId: senderId, text: prompt })
      // The post-time anchor is the cursor when the send went out.
      alpha.pendingTurns[alpha.pendingTurns.length - 1]!.anchorNodeId = anchor
      await saveJson(join(dir, 'bridges', `${alpha.sessionId}.json`), alpha)
      const record = (await readBridge(dir, alpha.sessionId)).pendingTurns.find(item => item.messageId === messageId)!
      // The refusal's shape: posted, no node id, the anchor preserved.
      expect(record.postedAt).not.toBeNull()
      expect(record.userNodeId).toBeNull()
      expect(record.anchorNodeId).toBe(anchor)
      const host = await startHost(dir, driver)
      try {
        await host.pollOnce()
        await waitFor(() => (repliesTo(sender, messageId).length >= 1 ? true : undefined), 15_000)
        await new Promise(resolve => setTimeout(resolve, 300))
        // Ours by identity/text: delivered once, and nothing was typed again.
        expect(repliesTo(sender, messageId).length).toBe(1)
        expect(repliesTo(sender, messageId)[0]).toContain('the answer our sender is owed')
        expect(repliesTo(sender, messageId).join('\n')).not.toContain('the page answer to the person')
        expect(sendCount(driver)).toBe(0)
        const state = await readBridge(dir, alpha.sessionId)
        expect(state.pendingTurns.some(item => item.messageId === messageId)).toBe(false)
        expect(state.ourNodeIds).toContain(sendNode)
        // The unrelated human node is neither adopted nor marked ours.
        expect(state.ourNodeIds).not.toContain(stranger)
        expect((await audits(dir)).some(line => /no completed answer within/.test(line.result))).toBe(false)
        expect((await audits(dir)).some(line => line.op === 'unprompted')).toBe(false)
      } finally {
        await host.stop()
      }
    } finally {
      await sender.close()
      await cleanup()
    }
  }, 60_000)
})

describe('R10-F1: a dated candidate before a RESOLVED preserved anchor', () => {
  test('the reviewer repro: an in-window quote before the anchor is refused on position', () => {
    const prompt = longBody()
    const none = new Set<string>()
    const host = Object.create(ChatGptHost.prototype) as ChatGptHost
    const check = (conversation: Conversation, anchor: string | null, postedMs = Date.now()): string | null =>
      internals(host).bodyContainedIn(conversation, prompt, none, none, postedMs, anchor)
    const nowMs = Date.now()
    const nowSec = nowMs / 1000
    // T-5s: a person quotes the whole prompt with an intro line, so neither
    // equality nor prefix matches. T-4s: the page answers, and THAT assistant
    // node is the record's pre-send anchor. At T our send never lands.
    const quoteBeforeAnchor = visibleConversation([
      { id: 'quote', parent: null, role: 'user', text: `Here is the prompt: ${prompt}`, createTime: nowSec - 5 },
      { id: 'anchor', parent: 'quote', role: 'assistant', text: 'the answer to the quoted prompt', createTime: nowSec - 4 },
    ])
    // R9-F2 alone would adopt it: it is dated and inside the 30 s window.
    expect(check(quoteBeforeAnchor, null)).toBe('quote')
    // R10-F1: with the preserved anchor resolved, position refuses it.
    expect(check(quoteBeforeAnchor, 'anchor')).toBeNull()
    // A dated candidate AFTER the anchor is still admissible ...
    const afterAnchor = visibleConversation([
      { id: 'anchor', parent: null, role: 'assistant', text: 'the cursor when we posted', createTime: nowSec - 5 },
      { id: 'send', parent: 'anchor', role: 'user', text: `before ${prompt} after`, createTime: nowSec - 0.8 },
    ])
    expect(check(afterAnchor, 'anchor')).toBe('send')
    // ... but uniqueness still fails closed after the anchor.
    const two = visibleConversation([
      { id: 'anchor', parent: null, role: 'assistant', text: 'the cursor when we posted', createTime: nowSec - 5 },
      { id: 'u1', parent: 'anchor', role: 'user', text: `${prompt} one`, createTime: nowSec - 0.9 },
      { id: 'u2', parent: 'u1', role: 'user', text: `${prompt} two`, createTime: nowSec - 0.8 },
    ])
    expect(check(two, 'anchor')).toBeNull()
  })
})

describe('R10-F2: dated text matches are bounded by the posting window', () => {
  test('a days-old dated prefix is not this send; the undated reach is unchanged', async () => {
    const prompt = longBody()
    const none = new Set<string>()
    const host = Object.create(ChatGptHost.prototype) as ChatGptHost
    const nowMs = Date.now()
    const nowSec = nowMs / 1000
    // Equality/prefix both hold; only the DATE says this is old text.
    const seen = `${prompt}\nAdditional context`
    const promptMatches = await promptMatchesOf()
    expect(promptMatches(prompt, seen)).toBe(true)
    const old = visibleConversation([
      { id: 'u1', parent: null, role: 'user', text: seen, createTime: nowSec - 2 * 24 * 3_600 },
    ])
    expect(internals(host).textMatchAnywhere(old, prompt, none, none, nowMs)).toBeNull()
    // A fresh dated carrier is still named.
    const fresh = visibleConversation([
      { id: 'u1', parent: null, role: 'user', text: seen, createTime: nowSec - 5 },
    ])
    expect(internals(host).textMatchAnywhere(fresh, prompt, none, none, nowMs)).toBe('u1')
    // An UNDATED carrier makes no time claim, so its reach stays as wide as it
    // was (the R8-B live record had no create_time at all).
    const undated = visibleConversation([
      { id: 'u1', parent: null, role: 'user', text: seen },
    ])
    expect(internals(host).textMatchAnywhere(undated, prompt, none, none, nowMs)).toBe('u1')
  })
})

describe('R10-F1/F2: recovery never adopts old text as the send', () => {
  test('an in-window quote sitting BEFORE the preserved anchor is never answered', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.observable = true
    const { transport: sender, id: senderId } = await busPeer(dir, 'sender')
    try {
      const prompt = longBody()
      const fiveAgo = Date.now() / 1000 - 5
      // The reviewer repro: a person quoted the whole prompt at T-5s with an
      // intro line, the page answered at T-4s, and that answer is the anchor.
      const quote = driver.appendNode(THREAD_A, 'user', `Here is the prompt: ${prompt}`, { createTime: fiveAgo })
      const anchor = driver.appendNode(THREAD_A, 'assistant', 'the answer to the quoted prompt', { createTime: fiveAgo + 1 })
      alpha.cursor = anchor
      const messageId = randomUUID()
      postedTurn(alpha, { messageId, senderSessionId: senderId, text: prompt })
      alpha.pendingTurns[alpha.pendingTurns.length - 1]!.anchorNodeId = anchor
      await saveJson(join(dir, 'bridges', `${alpha.sessionId}.json`), alpha)
      const host = await startHost(dir, driver)
      try {
        // The observation pass is where recovery attributes a node; drive it.
        await host.pollOnce()
        await new Promise(resolve => setTimeout(resolve, 300))
        expect(repliesTo(sender, messageId).some(text => text.includes('the answer to the quoted prompt'))).toBe(false)
        const state = await readBridge(dir, alpha.sessionId)
        expect(state.ourNodeIds).not.toContain(quote)
      } finally {
        await host.stop()
      }
    } finally {
      await sender.close()
      await cleanup()
    }
  }, 60_000)

  test('a days-old DATED post carrying the whole body is never answered', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.observable = true
    const { transport: sender, id: senderId } = await busPeer(dir, 'sender')
    try {
      const prompt = longBody()
      const daysAgo = Date.now() / 1000 - 2 * 24 * 3_600
      // F2 repro: `prompt` is a 512+ char prefix of this old post, so equality/
      // prefix says "match" and only the timestamp says "not our send".
      const old = driver.appendNode(THREAD_A, 'user', `${prompt}\nAdditional context`, { createTime: daysAgo })
      driver.appendNode(THREAD_A, 'assistant', 'the days-old answer', { createTime: daysAgo + 5 })
      const messageId = randomUUID()
      postedTurn(alpha, { messageId, senderSessionId: senderId, text: prompt })
      await saveJson(join(dir, 'bridges', `${alpha.sessionId}.json`), alpha)
      const host = await startHost(dir, driver)
      try {
        await host.pollOnce()
        await new Promise(resolve => setTimeout(resolve, 300))
        expect(repliesTo(sender, messageId).some(text => text.includes('the days-old answer'))).toBe(false)
        const state = await readBridge(dir, alpha.sessionId)
        expect(state.ourNodeIds).not.toContain(old)
      } finally {
        await host.stop()
      }
    } finally {
      await sender.close()
      await cleanup()
    }
  }, 60_000)
})

describe('R10-F3: an ambiguous send is never treated as "not posted"', () => {
  test('it keeps postedAt, types nothing more, and settles once by identity', async () => {
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
        const prompt = 'POSTED PROMPT: the driver could not prove this post either way'
        // The driver puts the node on the page but will not claim `accepted`.
        driver.ambiguousSend = 'the send is ambiguous: the prompt may have landed'
        const record: PendingRecord = {
          threadId: THREAD_A, userNodeId: null, ourText: prompt, text: prompt,
          senderSessionId: senderId, messageId: randomUUID(), kind: 'inquiry', postedAt: new Date().toISOString(),
        }
        // Swallowed: the send MAY have landed, so the turn stays queued.
        await expect(internals(host).postRecordedTurn(live, record)).resolves.toBe(false)
        expect(sendCount(driver)).toBe(1)
        const posted = await readBridge(dir, alpha.sessionId)
        const turn = posted.pendingTurns.find(item => item.messageId === record.messageId)!
        // NOT "never posted": the record still claims the post.
        expect(turn.postedAt).not.toBeNull()
        expect(turn.userNodeId).toBeNull()
        // The node the page took is ours by identity; the next pass delivers.
        await host.pollOnce()
        await waitFor(() => (repliesTo(sender, record.messageId).length >= 1 ? true : undefined), 15_000)
        expect(repliesTo(sender, record.messageId).length).toBe(1)
        expect(repliesTo(sender, record.messageId)[0]).toContain('answered on the page')
        // Never typed a second time, and settled once.
        expect(sendCount(driver)).toBe(1)
        const settled = await readBridge(dir, alpha.sessionId)
        expect(settled.pendingTurns.some(item => item.messageId === record.messageId)).toBe(false)
      } finally {
        await host.stop()
      }
    } finally {
      await sender.close()
      await cleanup()
    }
  }, 40_000)
})
