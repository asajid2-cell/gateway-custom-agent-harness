/**
 * R15: a turn that cannot be typed tells its sender, once.
 *
 * A page that cannot take text (a signed-out tab, a composer that never
 * appears) left the inbound queued and logged, and the sender waited forever.
 * The observation pass now tells that sender ONE line - the reason and that the
 * turn stays queued - after the turn has stayed unposted for the span of the
 * pending-watch ladder. A page that is merely MID-TURN is not this case: it
 * posts at the next idle transition, so it is never told anything.
 *
 * The bus, the host and the state files are real; the page is an in-memory
 * driver. Thresholds come from `pendingWatchGapsMs`, so a test's ladder is the
 * only clock involved - there is no second timer to wait on.
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

type Call = Record<string, unknown>

/** The frozen child protocol, in memory: one page, one thread, one mode. */
class FakeDriver {
  readonly calls: Call[] = []
  threads = [{ id: THREAD_A, title: 'Existing work' }]
  answer = 'answered on the page'
  /** The page cannot take text at all (a signed-out tab). */
  signOut = false
  /** The page is running a turn: a post must wait, and will succeed later. */
  generating = false
  observable = false
  conversationReads = 0
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

  private grow(threadId: string, role: 'user' | 'assistant', text: string): string {
    const tree = this.treeOf(threadId)
    const id = randomUUID()
    tree.mapping[id] = { id, parent: tree.current, children: [], message: { id, author: { role }, create_time: this.clock++, end_turn: role === 'assistant' ? true : null, status: 'finished_successfully', content: { content_type: 'text', parts: [text] } } }
    tree.mapping[tree.current].children.push(id)
    tree.current = id
    return id
  }

  onEvent(handler: (event: Record<string, unknown>) => void): () => void {
    this.listeners.add(handler)
    return () => { this.listeners.delete(handler) }
  }

  async call(request: Call): Promise<DriverReply> {
    if (String(request.op ?? '') === 'ping') return { ok: true, op: 'ping' }
    this.calls.push({ ...request })
    const op = String(request.op ?? '')
    if (op === 'threads') return { ok: true, op, threadId: this.current, threads: this.threads }
    if (op === 'use') {
      const threadId = String(request.threadId ?? '')
      if (!this.threads.some(thread => thread.id === threadId)) return { ok: false, op, error: `the page landed on no thread instead of the requested thread ${threadId}` }
      this.current = threadId
      return { ok: true, op, threadId, url: `https://chatgpt.com/c/${threadId}`, adopted: true }
    }
    if (op === 'send') {
      if (this.signOut) {
        // A definite refusal: the page never took the text.
        return { ok: false, op, reason: 'not-posted', error: 'not-posted: the page is signed out' }
      }
      if (this.generating) {
        return { ok: false, op, reason: 'busy', state: 'generating', threadId: this.current, error: 'the page is mid-turn; your message was not typed' }
      }
      const requested = typeof request.threadId === 'string' ? request.threadId : null
      const threadId = requested ?? this.current
      if (!threadId) return { ok: false, op, error: 'no thread is open' }
      this.current = threadId
      this.grow(threadId, 'user', String(request.text ?? ''))
      this.grow(threadId, 'assistant', this.answer)
      return { ok: true, op, text: this.answer, threadId, model: 'GPT-6', effort: 'High' }
    }
    if (op === 'read') return { ok: true, op, threadId: this.current, text: this.answer, evidence: 'state-complete' }
    if (op === 'conversation' && this.observable) {
      this.conversationReads++
      const threadId = String(request.threadId ?? '')
      const tree = this.treeOf(threadId)
      return { ok: true, op, conversation: { current_node: tree.current, mapping: structuredClone(tree.mapping) } }
    }
    if (op === 'conversations' && this.observable) return { ok: true, op, items: this.threads }
    if (op === 'unload') { this.current = null; return { ok: true, op, state: 'unloaded' } }
    if (op === 'status') {
      const asked = typeof request.threadId === 'string' ? request.threadId : ''
      if (!asked) return { ok: true, op, threadId: this.current, model: 'GPT-6', effort: 'High' }
      const state = this.generating ? 'generating' : 'idle'
      return {
        ok: true, op, cost: 'push', threadId: asked, pushedThreadId: this.current,
        matchesThread: this.current === null ? null : this.current === asked,
        state, phase: state === 'generating' ? 'streaming' : 'complete',
        ageMs: 0, at: new Date().toISOString(),
      }
    }
    if (op === 'file') return { ok: false, op, error: 'no files in this fake' }
    return { ok: false, op, error: `unknown op ${op}` }
  }

  async kill(): Promise<void> {}
  reopen(): void {}
}

async function scratch(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-peer-r15-'))
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

async function startHost(dir: string, driver: FakeDriver, gaps: number[]): Promise<ChatGptHost> {
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
    turnTimeoutMs: 2_000,
    waitPollMs: 20,
    pendingWatchGapsMs: gaps,
    directory: sessionsDir(dir),
    privateHome: privateHome(dir),
  }, driver as unknown as DriverChild)
  await host.start()
  return host
}

async function primedBridge(): Promise<BridgeState> {
  const alpha = newBridgeState({ sessionId: randomUUID(), name: 'alpha', threadId: THREAD_A })
  alpha.primedThreadId = THREAD_A
  alpha.primerSha256 = sha256(await readFile(join(import.meta.dir, 'chatgpt-peer', 'primer.md'), 'utf8'))
  return alpha
}

async function busPeer(dir: string, name: string): Promise<GatewaySessionTransport> {
  const transport = new GatewaySessionTransport({
    directory: sessionsDir(dir), sessionId: randomUUID(), name, cwd: dir, purpose: 'test sender', policy: 'accept',
  })
  await transport.start()
  return transport
}

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function readBridge(dir: string, sessionId: string): Promise<BridgeState> {
  return JSON.parse(await readFile(join(dir, 'bridges', `${sessionId}.json`), 'utf8')) as BridgeState
}

type PeerMessage = { id: string; replyTo?: string; fromSessionId: string; toSessionId: string; text: string; summary: string }
const inboxMessages = (transport: GatewaySessionTransport): PeerMessage[] =>
  transport.inbox().map(record => record.message as unknown as PeerMessage)

/** A deferred job: written down, never typed (the page could not take it). */
function deferredTurn(sender: GatewaySessionTransport, messageId: string): any {
  return {
    threadId: THREAD_A,
    userNodeId: null,
    ourText: 'deferred question',
    text: 'deferred question',
    senderSessionId: sender.peer.sessionId,
    messageId,
    kind: 'inquiry',
    postedAt: null,
  }
}

async function hostStatus(host: ChatGptHost, dir: string): Promise<any> {
  const body = JSON.parse(await readFile(join(privateHome(dir), 'instances', 'test.json'), 'utf8')) as { token: string }
  const response = await fetch(`http://127.0.0.1:${host.port}/operator/state`, { headers: { authorization: `Bearer ${body.token}` } })
  return response.json()
}

// A ladder short enough to reach in a test; its SPAN is the notice threshold.
const GAPS = [5, 5, 5] // 15 ms
const PAST = 40

describe('R15: a queued turn gets one notice', () => {
  test('(a) the sender is told once after the ladder has passed, and never twice', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    const sender = await busPeer(dir, 'sender')
    const messageId = randomUUID()
    alpha.pendingTurns = [deferredTurn(sender, messageId)]
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.observable = true
    driver.signOut = true
    const host = await startHost(dir, driver, GAPS)
    try {
      // First pass: the post fails for a definite reason, which records the
      // queue time. The notice has not aged past the ladder yet.
      await host.pollOnce()
      expect(inboxMessages(sender).length).toBe(0)
      const first = await readBridge(dir, alpha.sessionId)
      expect(typeof first.pendingTurns[0]!.queuedSince).toBe('string')
      expect(first.pendingTurns[0]!.queuedNoticeAt).toBeUndefined()

      await delay(PAST)
      await host.pollOnce()
      const told = inboxMessages(sender).filter(message => message.replyTo === messageId)
      expect(told.length).toBe(1)
      expect(told[0]!.fromSessionId).toBe(alpha.sessionId)
      expect(told[0]!.text).toContain('still queued')
      expect(told[0]!.text).toContain('signed out')
      expect(told[0]!.text).toContain('only notice')
      // Nothing was cancelled or re-posted: the job is still owed.
      const after = await readBridge(dir, alpha.sessionId)
      expect(after.pendingTurns.length).toBe(1)
      expect(after.pendingTurns[0]!.postedAt).toBeNull()
      expect(typeof after.pendingTurns[0]!.queuedNoticeAt).toBe('string')
      expect(after.queuedNotices).toBe(1)

      // (d) an already-told sender is not told again on the next passes.
      await delay(PAST)
      await host.pollOnce()
      await host.pollOnce()
      expect(inboxMessages(sender).filter(message => message.replyTo === messageId).length).toBe(1)
      expect((await readBridge(dir, alpha.sessionId)).queuedNotices).toBe(1)

      // The counter is measurable from the host status.
      const status = await hostStatus(host, dir)
      expect(status.queuedNotices).toBe(1)
      expect(status.bridges.find((bridge: any) => bridge.sessionId === alpha.sessionId)?.queuedNotices).toBe(1)
    } finally {
      await sender.close()
      await host.stop()
      await cleanup()
    }
  }, 20_000)

  test('(b) a turn that posts before the threshold is never noticed', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    const sender = await busPeer(dir, 'sender')
    const messageId = randomUUID()
    alpha.pendingTurns = [deferredTurn(sender, messageId)]
    await seedHost(dir, [alpha])
    // A ladder long enough that the recovery below is unambiguously inside it.
    const gaps = [5_000, 5_000]
    const driver = new FakeDriver()
    driver.observable = true
    driver.signOut = true
    const host = await startHost(dir, driver, gaps)
    try {
      // The first pass has a definite "not posted", which starts the queue
      // clock - but the ladder span has not elapsed.
      await host.pollOnce()
      const queued = await readBridge(dir, alpha.sessionId)
      expect(typeof queued.pendingTurns[0]!.queuedSince).toBe('string')

      // The page recovers and takes the text well before the threshold.
      driver.signOut = false
      await host.pollOnce()
      const messages = inboxMessages(sender).filter(message => message.replyTo === messageId)
      expect(messages.length).toBe(1)
      expect(messages[0]!.text).toContain(driver.answer)
      expect(messages[0]!.text).not.toContain('still queued')
      const after = await readBridge(dir, alpha.sessionId)
      expect(after.pendingTurns.length).toBe(0)
      expect(after.queuedNotices).toBe(0)
    } finally {
      await sender.close()
      await host.stop()
      await cleanup()
    }
  }, 20_000)

  test('(c) a page that is merely mid-turn is never told anything, and posts at the idle transition', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    const sender = await busPeer(dir, 'sender')
    const messageId = randomUUID()
    alpha.pendingTurns = [deferredTurn(sender, messageId)]
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.observable = true
    driver.generating = true
    const host = await startHost(dir, driver, GAPS)
    try {
      await host.pollOnce()
      await delay(PAST)
      await host.pollOnce()
      // Mid-turn is transient: no queue record, no notice, however long it runs.
      expect(inboxMessages(sender).length).toBe(0)
      const waiting = await readBridge(dir, alpha.sessionId)
      expect(waiting.pendingTurns[0]!.queuedSince).toBeUndefined()
      expect(waiting.queuedNotices).toBe(0)

      // The turn ended: the deferred job posts and the sender gets the answer.
      driver.generating = false
      await host.pollOnce()
      const messages = inboxMessages(sender).filter(message => message.replyTo === messageId)
      expect(messages.length).toBe(1)
      expect(messages[0]!.text).toContain(driver.answer)
      expect(messages[0]!.text).not.toContain('still queued')
      expect((await readBridge(dir, alpha.sessionId)).queuedNotices).toBe(0)
    } finally {
      await sender.close()
      await host.stop()
      await cleanup()
    }
  }, 20_000)

  test('(d) a restarted host does not re-send the notice', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    const sender = await busPeer(dir, 'sender')
    const messageId = randomUUID()
    alpha.pendingTurns = [deferredTurn(sender, messageId)]
    await seedHost(dir, [alpha])
    try {
      const firstDriver = new FakeDriver()
      firstDriver.observable = true
      firstDriver.signOut = true
      const first = await startHost(dir, firstDriver, GAPS)
      await first.pollOnce()
      await delay(PAST)
      await first.pollOnce()
      expect(inboxMessages(sender).filter(message => message.replyTo === messageId).length).toBe(1)
      await first.stop()

      // A fresh process on the same durable state: the mark, not memory, is
      // what stops a second notice.
      const secondDriver = new FakeDriver()
      secondDriver.observable = true
      secondDriver.signOut = true
      const second = await startHost(dir, secondDriver, GAPS)
      await second.pollOnce()
      await delay(PAST)
      await second.pollOnce()
      await second.pollOnce()
      await second.stop()
      expect(inboxMessages(sender).filter(message => message.replyTo === messageId).length).toBe(1)
      expect((await readBridge(dir, alpha.sessionId)).queuedNotices).toBe(1)
    } finally {
      await sender.close()
      await cleanup()
    }
  }, 30_000)
})
