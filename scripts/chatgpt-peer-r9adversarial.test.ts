/**
 * Round 9, independent repros: F1 (driver acceptance) and F2 (recovery adopts a
 * historical node). Written from the defect reports alone, against the tree at
 * `32dd8cf`. Each reported defect has a test that is red on this base for its
 * own stated reason; the "must still work" contrasts are guards.
 *
 *   R9-F1  `waitForAcceptance` accepts ANY new user node when the composer no
 *          longer holds our text (`... || !state.composerHolds`). A swallowed
 *          send plus someone else's new turn, or a page that clears the box, is
 *          then reported as `accepted` and the host waits out the reply timeout
 *          on a prompt that never left.
 *
 *          The driver's `send` op needs a live Chrome, so this test drives the
 *          acceptance check the way the driver itself exports it: `waitForAcceptance`
 *          is exported "so the guard logic can be proven without a live page"
 *          (see the export block in `chatgpt-peer/fixtures/chatgpt-driver.mjs`).
 *          The page stub answers `page.evaluate` with exactly the observable
 *          states the report names: ten turns already on screen (in both the
 *          count baseline and the node-identity baseline), then an eleventh;
 *          and a composer that no longer holds our prompt. A genuine eleventh
 *          turn must still carry P for acceptance.
 *
 *   R9-F2  `bodyContainedIn` matches a user node carrying the whole body with
 *          NO time and NO position constraint. So a node dated days before the
 *          post - e.g. `Here is the full prompt I received: <P>` - is adopted
 *          as this send's own node, and its old answer is delivered to the
 *          pending sender. The fix must bound containment to the same evidence
 *          the anchored matcher uses: inside the post's 30 s window when the
 *          node is dated, and after the positional anchor when it is not.
 *
 * Self-contained on purpose: neighbouring lanes' suites register at import
 * time, so their harnesses cannot be imported without running them.
 */
import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { GatewaySessionTransport } from '../src/utils/gatewaySessionTransport.js'
import { ChatGptHost } from './chatgpt-peer.ts'
import type { DriverChild, DriverReply } from './chatgpt-peer/driver.js'
import { newBridgeState, newHostState, saveJson, type BridgeState } from './chatgpt-peer/state.ts'

const THREAD_A = '11111111-1111-4111-8111-111111111111'

// --------------------------------------------------------------- R9-F1 page

type PageUser = { id: string; text: string }
type PageState = { users: PageUser[]; composer: string }

/**
 * One user turn as the DOM exposes it: its text, and a stable identity so a
 * node that was already on screen can never look new. The acceptance check
 * passes `[selector, needle-or-count]` to `page.evaluate`; its function reads
 * the `document` global exactly as it does in the browser, so the stub installs
 * one for the call.
 */
function userNode(user: PageUser): { innerText: string; id: string; getAttribute: (name: string) => string | null; closest: (selector: string) => unknown } {
  const attributes: Record<string, string> = { 'data-message-id': user.id }
  const node = {
    innerText: user.text,
    id: `el-${user.id}`,
    getAttribute: (name: string): string | null => attributes[name] ?? null,
    closest: (selector: string): unknown => (selector === '[data-message-id]' ? node : null),
  }
  return node
}

function pageStub(state: PageState): { evaluate: (fn: (arg: [string, string]) => unknown, args: [string, string]) => Promise<unknown> } {
  return {
    async evaluate(fn, args) {
      const document = {
        querySelector: (_selector: string) => ({ innerText: state.composer }),
        querySelectorAll: (_selector: string) => state.users.map(userNode),
      }
      const holder = globalThis as { document?: unknown }
      const previous = holder.document
      holder.document = document
      try {
        return fn(args)
      } finally {
        if (previous === undefined) delete holder.document
        else holder.document = previous
      }
    },
  }
}

/** Ten turns already on screen before the click - present in both the count and the identity baseline. */
const F1_BASELINE: PageUser[] = Array.from({ length: 10 }, (_, index) => ({ id: `u${index + 1}`, text: `an earlier question ${index + 1}` }))
const F1_BEFORE = { users: F1_BASELINE.length, answers: 4, dom: F1_BASELINE.map(user => user.id) }

const F1_PROMPT = `R9-F1: prove the send landed before reporting acceptance ${'p'.repeat(160)}`

/**
 * The vendored driver, resolved as a URL and imported through a computed
 * specifier: tsc does not try to find declarations for a path it cannot fold,
 * and the events suite resolves its vendored driver the same way.
 */
const DRIVER_MODULE = pathToFileURL(join(import.meta.dir, 'chatgpt-peer', 'fixtures', 'chatgpt-driver.mjs')).href

describe('R9-F1: acceptance is the send\'s own node, never any new user node', () => {
  test('a NEW user node that is NOT our prompt, with the composer emptied, is NOT accepted', async () => {
    // The shipped driver reads CHATGPT_PROFILE at import time.
    process.env.CHATGPT_PROFILE = process.env.CHATGPT_PROFILE || join(tmpdir(), 'r9-driver-profile')
    const { waitForAcceptance } = await import(DRIVER_MODULE)
    expect(typeof waitForAcceptance).toBe('function')
    // Pre-click baseline: ten turns, our prompt in the composer. After the
    // click: eleven turns, the newest is somebody else's words, the composer is
    // no longer holding ours. A swallowed send looks exactly like this.
    const page = pageStub({
      users: [...F1_BASELINE, { id: 'u11', text: 'unrelated message' }],
      composer: '',
    })
    const accepted = await waitForAcceptance(page, F1_BEFORE, F1_PROMPT, 700)
    // The count delta alone is not identity: our send never landed.
    expect(accepted).toBe(false)
  }, 10_000)

  test('a genuine NEW node carrying our prompt is still accepted', async () => {
    process.env.CHATGPT_PROFILE = process.env.CHATGPT_PROFILE || join(tmpdir(), 'r9-driver-profile')
    const { waitForAcceptance } = await import(DRIVER_MODULE)
    const page = pageStub({
      users: [...F1_BASELINE, { id: 'u11', text: F1_PROMPT }],
      composer: '',
    })
    const accepted = await waitForAcceptance(page, F1_BEFORE, F1_PROMPT, 2_000)
    expect(accepted).toBe(true)
  }, 10_000)
})

// ------------------------------------------------------------- R9-F2 harness

type Call = Record<string, unknown>
type CallOptions = { onAccepted?: (id: string) => void }

/** The frozen child protocol, in memory. One page, one active thread. */
class FakeDriver {
  readonly calls: Call[] = []
  threads = [{ id: THREAD_A, title: 'Existing work' }]
  observable = false
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

  /** Append one node. `createTime: null` is a node with no stamp; `undefined` means "now". */
  appendNode(threadId: string, role: 'user' | 'assistant', text: string, options: { id?: string; createTime?: number | null } = {}): string {
    const tree = this.treeOf(threadId)
    const id = options.id ?? randomUUID()
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
    return id
  }

  onEvent(handler: (event: Record<string, unknown>) => void): () => void {
    this.listeners.add(handler)
    return () => { this.listeners.delete(handler) }
  }

  async call(request: Call, options: CallOptions = {}): Promise<DriverReply> {
    const op = String(request.op ?? '')
    if (op === 'ping') return { ok: true, op }
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
      if (options.onAccepted) options.onAccepted(String(request.id ?? ''))
      this.appendNode(threadId, 'assistant', 'answered on the page')
      return { ok: true, op, text: 'answered on the page', threadId, model: 'GPT-6', effort: 'High' }
    }
    if (op === 'read') return { ok: true, op, threadId: this.current, text: '', evidence: 'state-complete' }
    if (op === 'conversation' && this.observable) {
      const threadId = String(request.threadId ?? '')
      const tree = this.treeOf(threadId)
      return { ok: true, op, conversation: { current_node: tree.current, mapping: structuredClone(tree.mapping) } }
    }
    if (op === 'conversations' && this.observable) {
      const offset = Number(request.offset ?? 0)
      const limit = Number(request.limit ?? 100)
      return { ok: true, op, items: this.threads.slice(offset, offset + limit) }
    }
    if (op === 'status') {
      const asked = typeof request.threadId === 'string' ? request.threadId : ''
      return { ok: true, op, cost: 'push', threadId: asked, state: 'idle', phase: 'complete', ageMs: 1_000, at: new Date().toISOString() }
    }
    return { ok: false, op, error: `unknown op ${op}` }
  }

  async kill(): Promise<void> {}
  reopen(): void {}
}

async function scratch(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-peer-r9-'))
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
    turnTimeoutMs: 900,
    waitPollMs: 20,
    directory: sessionsDir(dir),
    privateHome: privateHome(dir),
  }, driver as unknown as DriverChild)
  await host.start()
  return host
}

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
  bridge.primerSha256 = createHash('sha256')
    .update(await readFile(join(import.meta.dir, 'chatgpt-peer', 'primer.md'), 'utf8'), 'utf8')
    .digest('hex')
  return bridge
}

/** A pending turn as a crash leaves it: posted, no node id, the whole body kept. */
function postedTurn(bridge: BridgeState, options: {
  messageId: string
  senderSessionId: string
  text: string
  postedAt: string
  anchorNodeId?: string | null
}): void {
  bridge.pendingTurns.push({
    threadId: bridge.threadId,
    userNodeId: null,
    ourText: options.text.slice(0, 4096),
    text: options.text,
    senderSessionId: options.senderSessionId,
    messageId: options.messageId,
    kind: 'inquiry',
    postedAt: options.postedAt,
    ...(options.anchorNodeId ? { anchorNodeId: options.anchorNodeId } : {}),
  })
}

const sendCount = (driver: FakeDriver): number => driver.calls.filter(call => call.op === 'send').length

const repliesTo = (transport: GatewaySessionTransport, id: string): string[] =>
  transport.inbox()
    .filter(record => (record.message as unknown as { replyTo?: string }).replyTo === id)
    .map(record => String((record.message as unknown as { text: string }).text))

type AuditLine = { op: string; target: string | null; result: string; messageId?: string | null }
async function audits(dir: string): Promise<AuditLine[]> {
  const state = JSON.parse(await readFile(join(dir, 'peer.json'), 'utf8')) as { audit: AuditLine[] }
  return state.audit
}

const linesFor = async (dir: string, messageId: string): Promise<AuditLine[]> =>
  (await audits(dir)).filter(line => line.messageId === messageId)

/** >512 normalized chars: the containment floor. */
const r9Body = (): string =>
  Array.from({ length: 20 }, (_, index) => `r9 section ${index}: ${'w'.repeat(60)}`).join('\n\n')

/** The live doubled node: the whole body embedded so it is neither equal nor a prefix. */
function doubled(body: string): string {
  const cut = body.indexOf('r9 section 5:')
  expect(cut).toBeGreaterThan(0)
  return body.slice(0, cut) + body + body.slice(cut)
}

describe('R9-F2: a historical node is never adopted as this send\'s own', () => {
  test('a node dated days before the post, carrying the body, is refused; the turn stays owed', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.observable = true
    const { transport: sender, id: senderId } = await busPeer(dir, 'sender')
    try {
      const body = r9Body()
      expect(body.length).toBeGreaterThan(512)
      // A node from days ago that quotes the whole body. It is neither equal to
      // nor a prefix of what was posted (the quote leads), so only containment
      // can name it - and containment must not.
      const historical = Math.floor(Date.now() / 1000) - 3 * 86_400
      const historicalNode = driver.appendNode(THREAD_A, 'user', `Here is the full prompt I received: ${body}`, { createTime: historical })
      driver.appendNode(THREAD_A, 'assistant', 'the historical answer about the old prompt')
      const messageId = randomUUID()
      // The post happens now, long after that node was written.
      postedTurn(alpha, { messageId, senderSessionId: senderId, text: body, postedAt: new Date().toISOString() })
      await seedHost(dir, [alpha])
      const host = await startHost(dir, driver)
      try {
        await host.pollOnce()
        await host.stop()
        // The old answer is NOT delivered to the pending sender...
        expect(repliesTo(sender, messageId)).toEqual([])
        // ... and nothing was typed: recovery does not re-post.
        expect(sendCount(driver)).toBe(0)
        // The turn stays unresolved and unadopted (`present`).
        const state = await readBridge(dir, alpha.sessionId)
        const kept = state.pendingTurns.find(item => item.messageId === messageId)
        expect(kept).toBeDefined()
        expect(kept!.userNodeId).toBeNull()
        expect(state.ourNodeIds).not.toContain(historicalNode)
        // The observation pass declines to name a node here and makes no
        // absence claim, so it writes no per-pass line (absence explanations
        // live in the settle path). What it must NOT do is claim delivery, send
        // a failure/TTL line, or run the old turn as a person's.
        const turnLines = await linesFor(dir, messageId)
        expect(turnLines.some(line => /delivered the observed answer|failure line|no completed answer within/.test(line.result))).toBe(false)
        // Nothing was run as a person's turn or as page speech either.
        expect((await audits(dir)).some(line => line.op === 'human' || line.op === 'unprompted')).toBe(false)
      } finally {
        await host.stop()
      }
    } finally {
      await sender.close()
      await cleanup()
    }
  }, 40_000)

  test('guard: the real live doubled node, dated ~1 s before the post, is still adopted and delivered once', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.observable = true
    const { transport: sender, id: senderId } = await busPeer(dir, 'sender')
    try {
      driver.appendNode(THREAD_A, 'user', 'an earlier question')
      driver.appendNode(THREAD_A, 'assistant', 'an earlier answer')
      const body = r9Body()
      const pageNode = doubled(body)
      // The live relationship, kept relative so the 6 h TTL never rots the
      // guard: the real node was create_time 1793400052.371 against postedAt
      // 1793400053.214, i.e. 0.843 s BEFORE the post and well inside 30 s.
      const postedAt = new Date().toISOString()
      const createTime = Date.parse(postedAt) / 1000 - 0.843
      const sendNode = driver.appendNode(THREAD_A, 'user', pageNode, { createTime })
      const answerNode = driver.appendNode(THREAD_A, 'assistant', 'the answer the doubled prompt earned')
      // The cursor sits on the answer, past the send node.
      alpha.cursor = answerNode
      const messageId = randomUUID()
      postedTurn(alpha, { messageId, senderSessionId: senderId, text: body, postedAt })
      await seedHost(dir, [alpha])
      const host = await startHost(dir, driver)
      try {
        await host.pollOnce()
        const replies = repliesTo(sender, messageId)
        expect(replies.length).toBe(1)
        expect(replies[0]).toContain('the answer the doubled prompt earned')
        expect(sendCount(driver)).toBe(0)
        const state = await readBridge(dir, alpha.sessionId)
        expect(state.pendingTurns.some(item => item.messageId === messageId)).toBe(false)
        expect(state.ourNodeIds).toContain(sendNode)
      } finally {
        await host.stop()
      }
    } finally {
      await sender.close()
      await cleanup()
    }
  }, 40_000)

  test('an UNDATED node sitting before the positional anchor is refused', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.observable = true
    const { transport: sender, id: senderId } = await busPeer(dir, 'sender')
    try {
      const body = r9Body()
      // An undated node carrying the body, then the node the bridge had already
      // handled when it posted. Only `after the anchor` can make a node with no
      // clock this send's own; this one is behind the anchor.
      const offside = driver.appendNode(THREAD_A, 'user', doubled(body), { createTime: null })
      const anchor = driver.appendNode(THREAD_A, 'assistant', 'the anchor answer')
      alpha.cursor = anchor
      const messageId = randomUUID()
      postedTurn(alpha, { messageId, senderSessionId: senderId, text: body, postedAt: new Date().toISOString(), anchorNodeId: anchor })
      await seedHost(dir, [alpha])
      const host = await startHost(dir, driver)
      try {
        await host.pollOnce()
        await host.stop()
        // The answer that followed the undated node is not this send's answer.
        expect(repliesTo(sender, messageId)).toEqual([])
        expect(sendCount(driver)).toBe(0)
        const state = await readBridge(dir, alpha.sessionId)
        const kept = state.pendingTurns.find(item => item.messageId === messageId)
        expect(kept).toBeDefined()
        expect(kept!.userNodeId).toBeNull()
        expect(state.ourNodeIds).not.toContain(offside)
        // Same true negatives as the dated case: the observation pass keeps the
        // turn without claiming delivery, without a failure/TTL line, and
        // without classifying the node as a person's.
        const turnLines = await linesFor(dir, messageId)
        expect(turnLines.some(line => /delivered the observed answer|failure line|no completed answer within/.test(line.result))).toBe(false)
        expect((await audits(dir)).some(line => line.op === 'human' || line.op === 'unprompted')).toBe(false)
      } finally {
        await host.stop()
      }
    } finally {
      await sender.close()
      await cleanup()
    }
  }, 40_000)

  test('guard: an UNDATED node after the anchor is adopted and delivered once', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.observable = true
    const { transport: sender, id: senderId } = await busPeer(dir, 'sender')
    try {
      const body = r9Body()
      // The anchor the bridge had handled, then the undated send node that
      // appeared after it, then its answer.
      const anchor = driver.appendNode(THREAD_A, 'assistant', 'the anchor answer')
      const sendNode = driver.appendNode(THREAD_A, 'user', doubled(body), { createTime: null })
      driver.appendNode(THREAD_A, 'assistant', 'the answer after the anchor')
      alpha.cursor = anchor
      const messageId = randomUUID()
      postedTurn(alpha, { messageId, senderSessionId: senderId, text: body, postedAt: new Date().toISOString(), anchorNodeId: anchor })
      await seedHost(dir, [alpha])
      const host = await startHost(dir, driver)
      try {
        await host.pollOnce()
        const replies = repliesTo(sender, messageId)
        expect(replies.length).toBe(1)
        expect(replies[0]).toContain('the answer after the anchor')
        expect(sendCount(driver)).toBe(0)
        const state = await readBridge(dir, alpha.sessionId)
        expect(state.pendingTurns.some(item => item.messageId === messageId)).toBe(false)
        expect(state.ourNodeIds).toContain(sendNode)
      } finally {
        await host.stop()
      }
    } finally {
      await sender.close()
      await cleanup()
    }
  }, 40_000)
})
