/**
 * Round 10, adversarial: three rows, each written from the reviewer's defect
 * report against the tree at `4f16c8c`, and each red on that base for the
 * reason its describe states.
 *
 *   F1  host, `chatgpt-peer.ts:2216-2224` (`bodyContainedIn`). A DATED node
 *       sitting inside the 30 s posting window but BEFORE the preserved anchor
 *       is eligible today, because the dated branch checks only the clock and
 *       ignores position. A historical quotation ("here is the prompt: ...")
 *       written five seconds before the post is therefore adopted as the
 *       send's own node. It must not be: a dated candidate has the same
 *       after-the-anchor requirement an undated one already has. Guard: the
 *       same doubled body dated ~0.84 s before the post but AFTER the anchor is
 *       still adopted and answered once.
 *
 *   F2  host, `chatgpt-peer.ts:2167-2177` (`textMatchAnywhere`). The whole-chain
 *       text retry has no time and no position bound, so a days-old DATED node
 *       whose text is our body plus a suffix (`<body>\nAdditional context` -
 *       equal-or-prefix under `promptMatches`) is adopted as this send's node.
 *       It must not be. Guard: the R8-B shape (send node `create_time: null`,
 *       no stored anchor, cursor past it) must still be recovered, so the fix
 *       may not bound UNdated text matches.
 *
 *   F3  driver (`scripts/chatgpt-peer/fixtures/chatgpt-driver.mjs`). The
 *       acceptance verdict requires EXACTLY one new user node. When a second,
 *       unrelated user node appears inside the same acceptance window, the
 *       genuine send is refused: `ask` clicks send a second time and then
 *       reports `not-posted`. The effect under test is on the fake page - click
 *       count, not a log string.
 *
 * F1 and F2 are hosted through the same in-memory child protocol the R8 host
 * suite uses. F3 drives the vendored fixture's exported `ask` against a fake
 * page with a fake clock, so no browser and no 30 s wait is involved.
 *
 * Self-contained on purpose: neighbouring lanes' test files register suites at
 * import time, so their harnesses cannot be imported without running them.
 */
import { describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { GatewaySessionTransport } from '../src/utils/gatewaySessionTransport.js'
import { ChatGptHost } from './chatgpt-peer.ts'
import type { DriverChild, DriverReply } from './chatgpt-peer/driver.js'
import { newBridgeState, newHostState, saveJson, type BridgeState } from './chatgpt-peer/state.ts'

const THREAD_A = '11111111-1111-4111-8111-111111111111'
const DRIVER_MODULE = pathToFileURL(join(import.meta.dir, 'chatgpt-peer', 'fixtures', 'chatgpt-driver.mjs')).href

type Call = Record<string, unknown>
type CallOptions = { timeoutMs?: number; onAccepted?: (id: string) => void }

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
      this.appendNode(threadId, 'user', String(request.text ?? ''))
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
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-peer-r10-'))
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

/** >512 normalized chars: the containment/prefix floor, and <4096. */
const r10Body = (): string =>
  Array.from({ length: 22 }, (_, index) => `r10 section ${index}: ${'q'.repeat(55)}`).join('\n\n')

/** The live doubled node: the whole body embedded so it is neither equal nor a prefix. */
function doubled(body: string): string {
  const cut = body.indexOf('r10 section 5:')
  expect(cut).toBeGreaterThan(0)
  return body.slice(0, cut) + body + body.slice(cut)
}

/** Every true negative a refused turn must show. */
async function expectRefused(
  dir: string,
  alpha: BridgeState,
  sender: GatewaySessionTransport,
  messageId: string,
  carrier: string,
): Promise<void> {
  expect(repliesTo(sender, messageId)).toEqual([])
  const state = await readBridge(dir, alpha.sessionId)
  const kept = state.pendingTurns.find(item => item.messageId === messageId)
  expect(kept).toBeDefined()
  expect(kept!.userNodeId).toBeNull()
  expect(state.ourNodeIds).not.toContain(carrier)
  const turnLines = await linesFor(dir, messageId)
  expect(turnLines.some(line => /delivered the observed answer|failure line|no completed answer within/.test(line.result))).toBe(false)
  expect((await audits(dir)).some(line => line.op === 'human' || line.op === 'unprompted')).toBe(false)
}

// --------------------------------------------------------------------- F1
describe('R10-F1: a dated node inside the window but BEFORE the anchor is not this send', () => {
  test('a quotation dated 5 s before the post, ahead of the anchor, is refused; the turn stays owed', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.observable = true
    const { transport: sender, id: senderId } = await busPeer(dir, 'sender')
    try {
      const body = r10Body()
      expect(body.length).toBeGreaterThan(512)
      const nowMs = Date.now()
      // A historical quotation written 5 s BEFORE the post: inside the 30 s
      // window, so the dated branch of `bodyContainedIn` calls it eligible. It
      // carries the whole body as a contiguous run, so containment names it.
      const historicalNode = driver.appendNode(THREAD_A, 'user', `Here is the prompt: ${body}`, {
        createTime: nowMs / 1000 - 5,
      })
      // The preserved anchor: the node the bridge had handled when it posted. It
      // sits AFTER the quotation, so a positional rule refuses the quotation.
      const anchor = driver.appendNode(THREAD_A, 'assistant', 'the answer to the quotation', {
        createTime: nowMs / 1000 - 4,
      })
      alpha.cursor = anchor
      const messageId = randomUUID()
      // The post itself: posted now, no send node on the page.
      postedTurn(alpha, { messageId, senderSessionId: senderId, text: body, postedAt: new Date(nowMs).toISOString(), anchorNodeId: anchor })
      await seedHost(dir, [alpha])
      const host = await startHost(dir, driver)
      try {
        await host.pollOnce()
        // The quotation's answer is NOT this send's answer.
        await expectRefused(dir, alpha, sender, messageId, historicalNode)
        // Nothing was typed: recovery never re-posts.
        expect(sendCount(driver)).toBe(0)
      } finally {
        await host.stop()
      }
    } finally {
      await sender.close()
      await cleanup()
    }
  }, 40_000)

  test('guard: the doubled body dated ~0.84 s before the post but AFTER the anchor is adopted once', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.observable = true
    const { transport: sender, id: senderId } = await busPeer(dir, 'sender')
    try {
      const body = r10Body()
      const anchor = driver.appendNode(THREAD_A, 'assistant', 'the anchor answer')
      // AFTER the anchor, dated 0.84 s before the post (the live relationship),
      // and neither equal nor a prefix - only containment can name it. The fix
      // must keep it eligible.
      const postedAt = new Date().toISOString()
      const sendNode = driver.appendNode(THREAD_A, 'user', doubled(body), {
        createTime: Date.parse(postedAt) / 1000 - 0.843,
      })
      driver.appendNode(THREAD_A, 'assistant', 'the answer the doubled prompt earned')
      alpha.cursor = anchor
      const messageId = randomUUID()
      postedTurn(alpha, { messageId, senderSessionId: senderId, text: body, postedAt, anchorNodeId: anchor })
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
})

// --------------------------------------------------------------------- F2
describe('R10-F2: an untimed text match does not adopt a days-old node', () => {
  test('a DATED node from days ago whose text is our body plus a suffix is refused', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.observable = true
    const { transport: sender, id: senderId } = await busPeer(dir, 'sender')
    try {
      const body = r10Body()
      expect(body.length).toBeGreaterThan(512)
      // OUR body plus a suffix: equal-or-prefix under `promptMatches`, so it is
      // the whole-chain text retry - which today has no time bound - that names
      // it. It was written days ago and cannot be this send.
      const historical = Math.floor(Date.now() / 1000) - 3 * 86_400
      const oldNode = driver.appendNode(THREAD_A, 'user', `${body}\nAdditional context`, { createTime: historical })
      driver.appendNode(THREAD_A, 'assistant', 'the old answer about the old prompt')
      const messageId = randomUUID()
      postedTurn(alpha, { messageId, senderSessionId: senderId, text: body, postedAt: new Date().toISOString() })
      await seedHost(dir, [alpha])
      const host = await startHost(dir, driver)
      try {
        await host.pollOnce()
        await expectRefused(dir, alpha, sender, messageId, oldNode)
        expect(sendCount(driver)).toBe(0)
      } finally {
        await host.stop()
      }
    } finally {
      await sender.close()
      await cleanup()
    }
  }, 40_000)

  test('guard: the R8-B undated send node, no anchor, cursor past it, is still recovered once', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.observable = true
    const { transport: sender, id: senderId } = await busPeer(dir, 'sender')
    try {
      const body = r10Body()
      // The live R8-B shape: the send node has no create_time, the record kept
      // no anchor, and the cursor already moved past it to its answer. Only an
      // UNtimed, position-free text match can recover it - so the fix must not
      // bound undated candidates.
      const sendNode = driver.appendNode(THREAD_A, 'user', body, { createTime: null })
      const answerNode = driver.appendNode(THREAD_A, 'assistant', 'the answer the recovered send earned')
      alpha.cursor = answerNode
      const messageId = randomUUID()
      postedTurn(alpha, { messageId, senderSessionId: senderId, text: body, postedAt: new Date().toISOString() })
      await seedHost(dir, [alpha])
      const host = await startHost(dir, driver)
      try {
        await host.pollOnce()
        const replies = repliesTo(sender, messageId)
        expect(replies.length).toBe(1)
        expect(replies[0]).toContain('the answer the recovered send earned')
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

// --------------------------------------------------------------------- F3
//
// The fake page below answers only what `ask` actually reads on the happy
// acceptance path: the composer, the send control, the DOM user-node list, the
// busy indicators, and the assistant count. Clicks are counted on the page.

type FakeNode = {
  innerText: string
  id: string
  getAttribute(name: string): string | null
  closest(selector: string): FakeNode | null
}

function userNode(id: string, text: string): FakeNode {
  const node: FakeNode = {
    innerText: text,
    id: `el-${id}`,
    getAttribute: (name: string) => (name === 'data-message-id' ? id : null),
    closest: () => node,
  }
  return node
}

describe('R10-F3: an unrelated user node in the acceptance window does not strand the send', () => {
  test('the driver clicks send once and does not report not-posted', async () => {
    const { dir, cleanup } = await scratch()
    const sentText = r10Body()
    const state = {
      userNodes: [userNode('u1', 'an earlier question'), userNode('u2', 'an earlier answer')],
      // What the page gained on the first click: our node AND an unrelated one.
      appended: [] as string[],
    }
    let clicks = 0

    const send = {
      isVisible: async () => true,
      isDisabled: async () => false,
      getAttribute: async (_name: string) => null,
      click: async () => {
        clicks += 1
        if (clicks === 1) {
          state.userNodes.push(userNode('ours', sentText))
          state.userNodes.push(userNode('other', 'an unrelated message that landed at the same moment'))
          state.appended.push(sentText, 'an unrelated message that landed at the same moment')
        }
      },
    }
    const composer = {
      innerText: '',
      textContent: '',
      isVisible: async () => true,
      click: async () => {},
      fill: async (value: string) => { composer.innerText = value; composer.textContent = value },
      evaluate: async (fn: (el: unknown) => unknown) => fn(composer),
    }
    const assistantDummy = { innerText: async () => '' }

    const locatorOf = (nodes: unknown[]) => ({
      count: async () => nodes.length,
      nth: (index: number) => nodes[index],
      last: () => nodes[nodes.length - 1] ?? assistantDummy,
    })

    const page = {
      url: () => `https://chatgpt.com/c/${THREAD_A}`,
      locator: (selector: string) => {
        if (/prompt-textarea|contenteditable/i.test(selector)) return locatorOf([composer])
        if (/send-button|Send/i.test(selector)) return locatorOf([send])
        if (/data-message-author-role="user"/i.test(selector)) return locatorOf(state.userNodes)
        return locatorOf([])
      },
      keyboard: {
        press: async () => {},
        insertText: async () => {},
      },
      evaluate: async (fn: (arg?: unknown) => unknown, arg?: unknown) => fn(arg),
    }

    // A fake DOM for the evaluate-based readers (`readDomUserTurns`, `busyState`,
    // the progressbar probe). No stop button, no streaming state, no upload.
    const fakeDocument = {
      querySelectorAll: (selector: string) => (/data-message-author-role/.test(selector) ? state.userNodes : []),
      querySelector: (_selector: string) => null,
    }
    const realDocument = (globalThis as any).document
    const realGetComputedStyle = (globalThis as any).getComputedStyle
    ;(globalThis as any).document = fakeDocument
    ;(globalThis as any).getComputedStyle = () => ({ visibility: 'visible', display: 'block', opacity: '1' })

    // A fake clock: `waitForAcceptance` would otherwise sit out 30 s per read
    // attempt. Advancing time on every setTimeout keeps the loop bounded without
    // a real wait.
    const realNow = Date.now
    const realSetTimeout = globalThis.setTimeout
    let fakeNow = realNow()
    Date.now = () => fakeNow
    ;(globalThis as any).setTimeout = ((fn: (...args: any[]) => void, ms?: number, ...args: any[]) => {
      fakeNow += Math.max(0, Number(ms) || 0)
      return realSetTimeout(fn, 0, ...args)
    }) as unknown as typeof setTimeout

    // The fixture refuses to load without a profile, and its log lives under the
    // home directory: point both at scratch so nothing touches the real one.
    const priorProfile = process.env.CHATGPT_PROFILE
    const priorHome = process.env.USERPROFILE
    process.env.CHATGPT_PROFILE = join(dir, 'driver-profile')
    process.env.USERPROFILE = join(dir, 'driver-home')

    let result: any = null
    let thrown: any = null
    try {
      const driver = await import(DRIVER_MODULE) as { ask: (page: any, text: string, opts?: Record<string, unknown>) => Promise<any> }
      try {
        result = await driver.ask(page, sentText, { wait: false })
      } catch (error) {
        thrown = error
      }
    } finally {
      Date.now = realNow
      ;(globalThis as any).setTimeout = realSetTimeout
      ;(globalThis as any).document = realDocument
      ;(globalThis as any).getComputedStyle = realGetComputedStyle
      if (priorProfile === undefined) delete process.env.CHATGPT_PROFILE
      else process.env.CHATGPT_PROFILE = priorProfile
      if (priorHome === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = priorHome
      await cleanup()
    }

    // The page really did present the interleaving: two fresh user nodes, one of
    // them ours.
    expect(state.appended).toHaveLength(2)
    expect(state.appended.filter(text => text === sentText)).toHaveLength(1)
    // The defect: a second send click and `not-posted`. Neither may happen.
    expect(thrown).toBeNull()
    expect(clicks).toBe(1)
    expect(result?.state).toBe('generating')
    expect(String(result?.url ?? '')).toContain(THREAD_A)
  }, 60_000)
})
