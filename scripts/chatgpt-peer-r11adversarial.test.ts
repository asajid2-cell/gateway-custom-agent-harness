/**
 * Round 11, adversarial: two findings from the round-10 verdict, written from
 * the verdict alone against gateway main at `c58d8ec`.
 *
 *   F1  host, `scripts/chatgpt-peer.ts:2229-2239` (`textMatchAnywhere`). Its
 *       DATED branch is bounded by the posting window and the preserved anchor,
 *       but its UNDATED branch ignores a resolved preserved anchor entirely. A
 *       person posted `body` with no `create_time`; the page answered it and
 *       that answer is the bridge's preserved pre-send anchor; a later send of
 *       the same `body` did not land. At startup `ownUserNodeOf` rejects the old
 *       node on position, `textMatchAnywhere` accepts it on text alone, and the
 *       historical answer is delivered. It must be refused.
 *
 *       Guard: the same undated node with NO stored `anchorNodeId` (the R8-B
 *       shape: cursor past it, text identity the only evidence) is still
 *       adopted and delivered once.
 *
 *   F2  driver, the vendored fixture's zero-new-node window. A readable DOM
 *       window with ZERO new user nodes is treated as proof the click did not
 *       submit, so `submitTurn` clicks Send again. But the DOM selector can stop
 *       exposing new nodes while the first click HAS landed in the conversation
 *       tree; the retry then posts a second copy. Here the page's tree DOES hold
 *       the sent text after the single click - a POSITIVE tree sighting - so
 *       under the round-12 contract the send is ACCEPTED (one click, one copy),
 *       never a second click and never `ambiguous`.
 *
 *       THIS ROW IS RED AGAINST THE VENDORED FIXTURE AT THIS BASE and goes green
 *       once the driver fix is vendored. It drives the exported `ask` so the
 *       effect (click count, tree copies, acceptance) is asserted on the fake
 *       page, not a log string.
 *
 * Self-contained: neighbouring lanes' test files register suites at import
 * time, so their harnesses cannot be imported without running them.
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
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-peer-r11-'))
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

/** >700 normalized chars: the F1 body. */
const r11Body = (): string =>
  Array.from({ length: 24 }, (_, index) => `r11 section ${index}: ${'k'.repeat(55)}`).join('\n\n')

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
  // Scope the person-turn guard to the carrier: `human` names the person's node
  // in `target`. A correct refusal must never run the CARRIER as a person's turn.
  expect((await audits(dir)).some(line => (line.op === 'human' || line.op === 'unprompted') && line.target === carrier)).toBe(false)
}

// --------------------------------------------------------------------- F1
describe('R11-F1: an undated text match does not ignore the preserved anchor', () => {
  test('an undated exact-text user node BEFORE the preserved anchor is refused; the turn stays owed', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.observable = true
    const { transport: sender, id: senderId } = await busPeer(dir, 'sender')
    try {
      const body = r11Body()
      expect(body.length).toBeGreaterThan(700)
      // A person posted `body` with no create_time, and the page answered it.
      const oldNode = driver.appendNode(THREAD_A, 'user', body, { createTime: null })
      const answer = driver.appendNode(THREAD_A, 'assistant', 'the answer the human post earned')
      // That answer is the bridge's preserved pre-send anchor.
      alpha.cursor = answer
      const messageId = randomUUID()
      // A later send of the same body did not land: posted, anchored, no node.
      postedTurn(alpha, {
        messageId,
        senderSessionId: senderId,
        text: body,
        postedAt: new Date().toISOString(),
        anchorNodeId: answer,
      })
      await seedHost(dir, [alpha])
      const host = await startHost(dir, driver)
      try {
        await host.pollOnce()
        // ownUserNodeOf rejects on position; textMatchAnywhere must too.
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

  test('guard: the identical undated node with NO stored anchor (R8-B) is adopted once', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.observable = true
    const { transport: sender, id: senderId } = await busPeer(dir, 'sender')
    try {
      const body = r11Body()
      // The R8-B shape: no create_time, no stored anchorNodeId, and the cursor
      // already past the send node. Text identity is the only evidence, so this
      // must keep working.
      const sendNode = driver.appendNode(THREAD_A, 'user', body, { createTime: null })
      const answer = driver.appendNode(THREAD_A, 'assistant', 'the answer the recovered send earned')
      alpha.cursor = answer
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

// --------------------------------------------------------------------- F2
//
// The fake page below answers only what `ask` reads on this path: the composer,
// the send control, the DOM user-node list (which never gains a node), and the
// conversation tree fetched by `backendGetOn`. Clicks are counted on the page,
// and each click appends a user turn to the TREE - the send landing where the
// DOM selector cannot see it.

type FakeNode = {
  innerText: string
  id: string
  getAttribute(name: string): string | null
  closest(selector: string): FakeNode | null
}

function domUserNode(id: string, text: string): FakeNode {
  const node: FakeNode = {
    innerText: text,
    id: `el-${id}`,
    getAttribute: (name: string) => (name === 'data-message-id' ? id : null),
    closest: () => node,
  }
  return node
}

describe('R11-F2: a zero-new-node DOM window is not proof the send did not land', () => {
  test('one click, one copy, and the positive tree sighting accepts the send', async () => {
    const { dir, cleanup } = await scratch()
    const sentText = r11Body()
    // The DOM selector exposes the baseline turns and never the new one.
    const domUsers = [domUserNode('u1', 'an earlier question'), domUserNode('u2', 'an earlier answer')]
    // Every click that submits appends a user turn to the THREAD TREE.
    const treeUserTexts: string[] = []
    let clicks = 0

    const send = {
      isVisible: async () => true,
      isDisabled: async () => false,
      getAttribute: async (_name: string) => null,
      click: async () => {
        clicks += 1
        treeUserTexts.push(sentText)
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
        if (/data-message-author-role="user"/i.test(selector)) return locatorOf(domUsers)
        return locatorOf([])
      },
      keyboard: {
        press: async () => {},
        insertText: async () => {},
      },
      evaluate: async (fn: (arg?: unknown) => unknown, arg?: unknown) => fn(arg),
    }

    // The conversation tree `readUserTreeOnPage` fetches: the baseline turns,
    // plus one user turn per click that submitted.
    const treeBody = () => {
      let seq = 0
      const mapping: Record<string, unknown> = {
        root: { id: 'root', parent: null, children: [], message: null },
      }
      const add = (role: string, text: string) => {
        const id = `node${seq++}`
        mapping[id] = {
          id, parent: 'root', children: [],
          message: { id, author: { role }, create_time: null, content: { content_type: 'text', parts: [text] } },
        }
      }
      add('user', 'an earlier question')
      add('assistant', 'an earlier answer')
      for (const text of treeUserTexts) add('user', text)
      return { current_node: 'root', mapping }
    }

    const fakeDocument = {
      querySelectorAll: (selector: string) => (/data-message-author-role/.test(selector) ? domUsers : []),
      querySelector: (_selector: string) => null,
    }
    const realFetch = globalThis.fetch
    const realDocument = (globalThis as any).document
    const realGetComputedStyle = (globalThis as any).getComputedStyle
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input)
      if (url.includes('/api/auth/session')) return { ok: true, status: 200, json: async () => ({ accessToken: 'test-token' }) }
      if (url.includes('/backend-api/conversation/')) return { ok: true, status: 200, json: async () => treeBody() }
      return { ok: false, status: 404, json: async () => ({}) }
    }) as unknown as typeof fetch
    ;(globalThis as any).document = fakeDocument
    ;(globalThis as any).getComputedStyle = () => ({ visibility: 'visible', display: 'block', opacity: '1' })

    const priorProfile = process.env.CHATGPT_PROFILE
    const priorHome = process.env.USERPROFILE
    const priorAcceptance = process.env.CHATGPT_ACCEPTANCE_MS
    process.env.CHATGPT_PROFILE = join(dir, 'driver-profile')
    process.env.USERPROFILE = join(dir, 'driver-home')
    // Read once at module load: a short window keeps the test fast without a
    // fake clock. The poll interval is 250 ms, so 300 ms is one or two reads.
    process.env.CHATGPT_ACCEPTANCE_MS = '300'

    let result: unknown = null
    let thrown: any = null
    try {
      const driver = await import(DRIVER_MODULE) as { ask: (page: any, text: string, opts?: Record<string, unknown>) => Promise<unknown> }
      try {
        result = await driver.ask(page, sentText, { wait: false })
      } catch (error) {
        thrown = error
      }
    } finally {
      globalThis.fetch = realFetch
      ;(globalThis as any).document = realDocument
      ;(globalThis as any).getComputedStyle = realGetComputedStyle
      if (priorProfile === undefined) delete process.env.CHATGPT_PROFILE
      else process.env.CHATGPT_PROFILE = priorProfile
      if (priorHome === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = priorHome
      if (priorAcceptance === undefined) delete process.env.CHATGPT_ACCEPTANCE_MS
      else process.env.CHATGPT_ACCEPTANCE_MS = priorAcceptance
      await cleanup()
    }

    // The click count is asserted first so a base run reports the extra click.
    expect(clicks).toBe(1)
    // The send really did land once in the tree, and the DOM exposed none of it.
    expect(treeUserTexts.filter(text => text === sentText)).toHaveLength(1)
    expect(domUsers).toHaveLength(2)
    // The round-12 contract: a NEW tree user turn carrying the sent text is the
    // positive sighting, so the send is accepted - one click, one copy, no throw
    // and no ambiguous "possible duplicate" report.
    expect(thrown).toBeNull()
    expect(result).not.toBeNull()
    expect((result as { state?: string }).state).toBe('generating')
  }, 60_000)
})
