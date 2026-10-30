/**
 * R-LIVE-8: a driver wedge is not a page failure.
 *
 * The live incident: a turn was reported to its sender as
 * "the ChatGPT page could not answer: driver was replaced after r27 timed out".
 * The driver had wedged, been replaced, and the page in fact kept generating
 * and finished the answer afterwards - but the debt was settled as a definite
 * negative and the turn retired, so that answer was never delivered.
 *
 * The fake-driver harness is copied from the r5c lane deliberately: this file
 * stays separate so the lanes never interleave on a merge.
 *
 * One real host per test: the bus is a real GatewaySessionTransport in a
 * scratch directory and the page is the frozen line-JSON fake the bridge suite
 * uses.
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

const THREAD_A = '11111111-1111-4111-8111-111111111111'

type Call = Record<string, unknown>

/** The frozen child protocol, in memory. One page, one active thread. */
class FakeDriver {
  readonly calls: Call[] = []
  threads = [{ id: THREAD_A, title: 'Existing work' }]
  killed = false
  /** Set by a test to make every later call fail, as a dead child does. */
  dead = false
  answer = 'answered on the page'
  sendText = 'answered on the page'
  sendTextFor: ((request: Call) => string) | undefined
  evidence = 'state-complete'
  signal: { phase: string | null; threadId: string | null; at: number | null } = { phase: 'complete', threadId: null, at: null }
  generating = false
  refuseSend = false
  busyUntil = 0
  readonly sentAtMs: number[] = []
  fileBytes: number | null = null
  /** Answer the next file op with EEXIST, as a stale target on disk would. */
  fileExistsOnce = false
  /** Delay every file write, so two requests for the same entry overlap. */
  fileDelayMs = 0
  /** Succeed without naming the file in the reply, so the caller must know its own path. */
  omitFilePath = false
  stallFor: ((request: Call) => boolean) | undefined
  readonly fileCalls: { fileId?: string; sandboxPath?: string; outPath?: string }[] = []
  conversationReads = 0
  /** Fail the conversation read, as a page that cannot be read at all. */
  conversationFails = false
  answerFor: ((request: Call) => string | undefined) | undefined
  private readonly listeners = new Set<(event: Record<string, unknown>) => void>()
  private current: string | null = null
  observable = false
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

  private append(threadId: string, role: 'user' | 'assistant', text: string, files: { id?: string; name?: string; mime?: string; size?: number }[] = []): string {
    const tree = this.treeOf(threadId)
    const id = randomUUID()
    tree.mapping[id] = {
      id,
      parent: tree.current,
      children: [],
      message: {
        id,
        author: { role },
        create_time: this.clock++,
        end_turn: role === 'assistant' ? true : null,
        status: 'finished_successfully',
        content: { content_type: 'text', parts: [text] },
        ...(files.length
          ? { metadata: { attachments: files.map(file => ({ id: file.id, name: file.name ?? '', mime_type: file.mime ?? '', size: file.size ?? 0 })) } }
          : {}),
      },
    }
    tree.mapping[tree.current]!.children.push(id)
    tree.current = id
    return id
  }

  private grow(threadId: string, role: 'user' | 'assistant', text: string): string {
    return this.append(threadId, role, text)
  }

  /** The person types in the thread directly; the model answers. Returns the user node id. */
  humanTypes(threadId: string, text: string, answer: string, files: { id?: string; name?: string; mime?: string; size?: number }[] = []): string {
    const id = this.grow(threadId, 'user', text)
    this.append(threadId, 'assistant', answer, files)
    return id
  }

  /** A finished answer node on the branch, carrying the files the page says. */
  pageNode(threadId: string, text: string, files: { id?: string; name?: string; mime?: string; size?: number }[] = []): string {
    return this.append(threadId, 'assistant', text, files)
  }

  openThread(threadId: string | null): void { this.current = threadId }

  /** Set the page's clock, so a node can be placed before or after a bind. */
  setClock(seconds: number): void { this.clock = seconds }

  onEvent(handler: (event: Record<string, unknown>) => void): () => void {
    this.listeners.add(handler)
    return () => { this.listeners.delete(handler) }
  }

  emit(event: Record<string, unknown>): void { for (const listener of this.listeners) listener(event) }

  async call(request: Call, options?: number | { onAccepted?: (id: string) => void }): Promise<DriverReply> {
    if (String(request.op ?? '') === 'ping') return { ok: true, op: 'ping' }
    if (this.dead) return { ok: false, op: String(request.op ?? ''), error: 'the driver is gone' }
    if (this.faultError) return { ok: false, op: String(request.op ?? ''), reason: 'timeout', error: this.faultError }
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
      if (!this.lags) {
        this.grow(threadId, 'user', String(request.text ?? ''))
        if (!stalls) this.grow(threadId, 'assistant', this.answer)
      }
      this.signal = { phase: stalls ? 'streaming' : 'complete', threadId, at: Date.now() }
      this.sentAtMs.push(Date.now())
      // The page has the text; now the driver goes away. Every later call
      // faults until finishAnswer(), exactly the live shape.
      if (this.wedgeAfterSend) {
        this.wedgeAfterSend = false
        this.faultError = 'driver was replaced after r27 timed out'
      }
      onAccepted?.(String(request.id ?? ''))
      return { ok: true, op, text: this.sendTextFor?.(request) ?? this.sendText, threadId, model: 'GPT-6', effort: 'High' }
    }
    if (op === 'read') {
      return { ok: true, op, threadId: this.current, text: this.answer, evidence: this.evidence }
    }
    if (op === 'conversation' && this.observable) {
      if (this.conversationFails) return { ok: false, op, error: 'the page did not answer the read' }
      this.conversationReads++
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
      this.fileCalls.push({ fileId: request.fileId as string | undefined, sandboxPath: request.sandboxPath as string | undefined, outPath: request.outPath as string | undefined })
      if (!request.fileId && !(request.threadId && request.messageId && request.sandboxPath)) return { ok: false, op, reason: 'bad-id' }
      if (this.fileDelayMs > 0) await new Promise(resolve => setTimeout(resolve, this.fileDelayMs))
      if (this.fileExistsOnce) { this.fileExistsOnce = false; return { ok: false, op, reason: 'exists' } }
      const outPath = String(request.outPath ?? '')
      const body = `bytes of ${String(request.fileId ?? request.sandboxPath)}`
      try { await writeFile(outPath, body, { flag: 'wx' }) }
      catch (error) { return { ok: false, op, reason: (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'exists' : 'io' } }
      const bytes = this.fileBytes ?? Buffer.byteLength(body)
      return { ok: true, op, bytes, sha256: sha256(body), name: basenameOf(outPath), ...(this.omitFilePath ? {} : { path: outPath }) }
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

  // Fields the host touches but these tests do not exercise directly.
  pageFailed = false
  sendError: string | null = null
  landOn: string | null = null
  lags = false
  /**
   * While set, every later call fails the way a replaced child does. This is
   * `isDriverFaultReply` true, so it says nothing about the page.
   */
  faultError: string | null = null
  /** The next successful send wedges the driver: everything after it faults. */
  wedgeAfterSend = false

  /**
   * The page finishes the turn after the wedge: the driver is back and the
   * assistant node exists on the branch. The eventual answer is real.
   */
  finishAnswer(text: string): void {
    this.faultError = null
    const threadId = this.current ?? THREAD_A
    this.grow(threadId, 'assistant', text)
    this.signal = { phase: 'complete', threadId, at: Date.now() }
  }
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

const basenameOf = (path: string): string => path.replace(/\\/g, '/').split('/').pop() ?? ''

async function scratch(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-peer-r4b-'))
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
    turnTimeoutMs: options.turnTimeoutMs ?? 5_000,
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
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

const bridgeNamed = (name: string, threadId: string | null): BridgeState => newBridgeState({ sessionId: randomUUID(), name, threadId })

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

const rendered = (fields: Record<string, unknown>): string => 'gateway\n' + JSON.stringify(fields)

const primerSha = async (): Promise<string> =>
  sha256(await readFile(join(import.meta.dir, 'chatgpt-peer', 'primer.md'), 'utf8'))

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

/** A primed, observable bridge. */
async function primedBridge(): Promise<{ alpha: BridgeState }> {
  const alpha = bridgeNamed('alpha', THREAD_A)
  alpha.primedThreadId = THREAD_A
  alpha.primerSha256 = await primerSha()
  return { alpha }
}
const sendCount = (driver: FakeDriver): number => driver.calls.filter(call => call.op === 'send').length

describe('R-LIVE-8: a driver wedge is not a page failure', () => {
  test('a wedge mid-turn sends no failure line, keeps the turn owed, and its late answer is delivered once', async () => {
    const { dir, cleanup } = await scratch()
    const { alpha } = await primedBridge()
    await seedHost(dir, [alpha])
    const sender = await busPeer(dir, 'sender')
    const driver = new FakeDriver()
    driver.observable = true
    // The page takes the text and says it is generating; the driver then goes
    // away and answers nothing. This is the live r27 shape.
    driver.stallFor = () => true
    driver.wedgeAfterSend = true
    const host = await startHost(dir, driver, { turnTimeoutMs: 1_500 })
    try {
      const receipt = await sender.send(alpha.sessionId, 'unit ping', 'unit ping', undefined, 'inquiry', true) as { id: string }
      await waitFor(() => (driver.faultError ? true : undefined), 10_000)
      // Let the turn's own clock pass while the driver is gone. A wedge must not
      // become a page failure just because watching stopped.
      await new Promise(resolve => setTimeout(resolve, 2_500))

      // (a) the sender is told NOTHING: the driver failed, so the page is unproven.
      const replies = () => sender.inbox().filter(record => (record.message as unknown as { replyTo?: string }).replyTo === receipt.id)
      expect(replies().length).toBe(0)

      // (b) the turn is still owed on disk: not retired, still posted.
      const owed = (await readBridge(dir, alpha.sessionId)).pendingTurns.find(turn => turn.messageId === receipt.id)
      expect(owed).toBeTruthy()
      expect(owed!.postedAt).not.toBe(null)

      // (c) the page finishes after the wedge; the owed answer is delivered once.
      driver.finishAnswer('the answer that survived the wedge')
      await host.pollOnce()
      await waitFor(() => (replies().length >= 1 ? true : undefined), 15_000)
      await new Promise(resolve => setTimeout(resolve, 300))
      expect(replies().length).toBe(1)
      expect(String((replies()[0]!.message as unknown as { text: string }).text)).toContain('the answer that survived the wedge')
      // The prompt was typed exactly once: no re-post on recovery.
      expect(sendCount(driver)).toBe(1)
    } finally {
      await host.stop()
      await sender.close()
      await cleanup()
    }
  }, 40_000)
})

describe('R-LIVE-9: a turn the bus already answered is retired, never failed at TTL', () => {
  test('a recorded turn whose node was already attributed and whose reply is on the bus is retired with no send', async () => {
    const { dir, cleanup } = await scratch()
    const { alpha } = await primedBridge()
    await seedHost(dir, [alpha])
    const sender = await busPeer(dir, 'sender')
    const driver = new FakeDriver()
    driver.observable = true
    const repliesTo = (id: string) =>
      sender.inbox().filter(record => (record.message as unknown as { replyTo?: string }).replyTo === id)
    let receipt: { id: string } = { id: '' }
    const host = await startHost(dir, driver)
    try {
      receipt = await sender.send(alpha.sessionId, 'unit ping', 'unit ping', undefined, 'inquiry', true) as { id: string }
      // The turn completes normally: the answer is delivered, the seen user
      // node is adopted into ourNodeIds, and the transport history holds the
      // sent reply (the R-LIVE-9 precondition).
      await waitFor(() => (repliesTo(receipt.id).length >= 1 ? true : undefined), 15_000)
    } finally {
      await host.stop()
      await new Promise(resolve => setTimeout(resolve, 120))
    }
    try {
      const bridge = await readBridge(dir, alpha.sessionId)
      // The page node is ours already and its completed answer is on the branch.
      expect(bridge.ourNodeIds.length).toBeGreaterThan(0)
      // The exact prompt the page saw, so the seeded record names the node that
      // ourNodeIds already holds.
      const prompt = String((driver.calls.find(call => call.op === 'send') ?? {}).text ?? '')
      expect(prompt.length).toBeGreaterThan(0)
      // The stale record a host that died mid-turn leaves behind: posted, no
      // node id, and old enough that the 6h TTL branch would fire on the next
      // pass. The reply is already on the bus.
      await saveJson(join(dir, 'bridges', `${alpha.sessionId}.json`), {
        ...bridge,
        pendingTurns: [{
          threadId: THREAD_A,
          userNodeId: null,
          ourText: prompt.slice(0, 4096),
          text: prompt,
          senderSessionId: sender.peer.sessionId,
          messageId: receipt.id,
          kind: 'inquiry',
          postedAt: new Date(Date.now() - 7 * 3600_000).toISOString(),
        }],
      })
      const sentBefore = sendCount(driver)
      expect(repliesTo(receipt.id).length).toBe(1)

      const host2 = await startHost(dir, driver)
      try {
        await host2.pollOnce()
        await new Promise(resolve => setTimeout(resolve, 300))
        const after = await readBridge(dir, alpha.sessionId)
        // Retired: the turn is gone rather than waiting to fail at the 6h TTL.
        expect(after.pendingTurns.some(turn => turn.messageId === receipt.id)).toBe(false)
        // No page turn was typed and no second line reached the sender. On the
        // base tree the TTL branch fires here and sends a false failure line
        // for a question the bus already answered.
        expect(sendCount(driver)).toBe(sentBefore)
        expect(repliesTo(receipt.id).length).toBe(1)
      } finally {
        await host2.stop()
      }
    } finally {
      await sender.close()
      await cleanup()
    }
  }, 40_000)
})

describe('R-LIVE-9: identical text never binds two turns to one node', () => {
  test('two owed turns with the same text each get their own node and their own answer, once', async () => {
    const { dir, cleanup } = await scratch()
    const senderA = await busPeer(dir, 'sender-a')
    const senderB = await busPeer(dir, 'sender-b')
    const driver = new FakeDriver()
    driver.observable = true
    // The same question asked twice: two user nodes with identical text, each
    // with its own answer, in page order.
    const text = 'status?'
    const n1 = driver.humanTypes(THREAD_A, text, 'answer one')
    const n2 = driver.humanTypes(THREAD_A, text, 'answer two')
    const messageA = randomUUID()
    const messageB = randomUUID()
    const alpha = bridgeNamed('alpha', THREAD_A)
    alpha.primedThreadId = THREAD_A
    alpha.primerSha256 = await primerSha()
    // The crash shape: both turns posted and unbound, and both page nodes were
    // already adopted into ourNodeIds by an earlier pass. Only the per-turn
    // claim (not `ours`) can tell them apart.
    alpha.ourNodeIds = [n1, n2]
    alpha.pendingTurns = [
      { threadId: THREAD_A, userNodeId: null, ourText: text, text, senderSessionId: senderA.peer.sessionId, messageId: messageA, kind: 'inquiry', postedAt: new Date(Date.now() - 10 * 60_000).toISOString() },
      { threadId: THREAD_A, userNodeId: null, ourText: text, text, senderSessionId: senderB.peer.sessionId, messageId: messageB, kind: 'inquiry', postedAt: new Date(Date.now() - 5 * 60_000).toISOString() },
    ]
    await seedHost(dir, [alpha])
    const host = await startHost(dir, driver)
    try {
      await host.pollOnce()
      const replies = (sender: typeof senderA, id: string) =>
        sender.inbox()
          .filter(record => (record.message as unknown as { replyTo?: string }).replyTo === id)
          .map(record => String((record.message as unknown as { text: string }).text))
      const gotA = replies(senderA, messageA)
      const gotB = replies(senderB, messageB)
      expect(gotA.length).toBe(1)
      expect(gotB.length).toBe(1)
      // Each sender hears only its own turn's answer.
      expect(gotA[0]).toContain('answer one')
      expect(gotA[0]).not.toContain('answer two')
      expect(gotB[0]).toContain('answer two')
      expect(gotB[0]).not.toContain('answer one')
      // Neither was delivered twice, and both turns are settled.
      expect(gotA.length + gotB.length).toBe(2)
      const after = await readBridge(dir, alpha.sessionId)
      expect(after.pendingTurns.length).toBe(0)
    } finally {
      await host.stop()
      await senderA.close()
      await senderB.close()
      await cleanup()
    }
  }, 30_000)
})
