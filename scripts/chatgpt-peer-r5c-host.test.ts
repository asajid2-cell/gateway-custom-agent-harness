/**
 * R5c review-fix lane: recovery on restart (R-LIVE-6 / R-LIVE-7).
 *
 * One real host per test: the bus is a real GatewaySessionTransport in a
 * scratch directory and the page is the frozen line-JSON fake the bridge suite
 * uses. The fake-driver harness is copied from the r4b host lane deliberately -
 * this file must stay separate so the two lanes never interleave on a merge.
 *
 *   R-LIVE-6  the restart looked at the page before re-posting a turn, and
 *             posts only when the evidence says the send never landed.
 *   R-LIVE-7  an inbound the bus already has a reply for is not re-run, and a
 *             write-ahead "answered" mark is not a delivery.
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
  /** Every attempt, refused ones included: what the watch cadence is measured on. */
  conversationAttempts = 0
  /** Answer the next N conversation reads with a 429, then answer normally. */
  conversation429 = 0
  /** How many reads were refused with a 429. */
  refusedReads = 0
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
      this.sendConcurrency += 1
      this.maxSendConcurrency = Math.max(this.maxSendConcurrency, this.sendConcurrency)
      try {
        if (this.sendDelayMs) await new Promise(resolve => setTimeout(resolve, this.sendDelayMs))
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
          // A page that reports the render fault has not drawn the answer; the
          // test supplies it with `pageNode` once the page can draw again.
          if (!stalls && !this.pageLoadAccepted) this.grow(threadId, 'assistant', this.answer)
        }
        // The render fault the driver reports AFTER a 2xx send POST: the text is
        // on the page, the page just cannot draw the thread.
        if (this.pageLoadAccepted) {
          this.sentAtMs.push(Date.now())
          return { ok: false, op, reason: 'page-load-error', accepted: true, threadId, error: 'the page could not load the messages' }
        }
        this.signal = { phase: stalls ? 'streaming' : 'complete', threadId, at: Date.now() }
        this.sentAtMs.push(Date.now())
        onAccepted?.(String(request.id ?? ''))
        // `wait:true` promises the answer on this request. A turn that is still
        // streaming has none: the real child reports `timedOut` instead of
        // returning stale text, so the host must leave the turn owed.
        if (request.wait === true && stalls) return { ok: false, op, reason: 'timeout', timedOut: true, state: 'generating', threadId }
        return { ok: true, op, text: this.sendTextFor?.(request) ?? this.answer, threadId, model: 'GPT-6', effort: 'High' }
      } finally {
        this.sendConcurrency -= 1
      }
    }
    if (op === 'read') {
      return { ok: true, op, threadId: this.current, text: this.answer, evidence: this.evidence }
    }
    if (op === 'conversation' && this.observable) {
      this.conversationAttempts++
      if (this.conversation429 > 0) {
        this.conversation429--
        this.refusedReads++
        return { ok: false, op, status: 429, error: 'too many requests' }
      }
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
  /** The driver reports a render fault AFTER a 2xx send POST (the text landed). */
  pageLoadAccepted = false
  /** How long one send holds the page; lets a test see whether two overlap. */
  sendDelayMs = 0
  sendConcurrency = 0
  maxSendConcurrency = 0
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

async function startHost(dir: string, driver: FakeDriver, options: { turnTimeoutMs?: number; pendingWatchGapsMs?: number[]; pendingWatchTailMs?: number; readBackoffBaseMs?: number } = {}): Promise<ChatGptHost> {
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
    pendingWatchGapsMs: options.pendingWatchGapsMs,
    pendingWatchTailMs: options.pendingWatchTailMs,
    readBackoffBaseMs: options.readBackoffBaseMs,
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
/**
 * Park one inbound after the page has taken it but before it was answered.
 *
 * The host is stopped the moment the job is on disk as POSTED, which is the
 * state a crash leaves behind: the sender is owed, the page may already hold
 * the turn. Returns the sender's message id.
 */
async function postedThenStopped(dir: string, driver: FakeDriver, bridge: BridgeState, sender: GatewaySessionTransport, text = 'ask the page'): Promise<string> {
  const host = await startHost(dir, driver)
  const sendsBefore = driver.sentAtMs.length
  try {
    const receipt = await sender.send(bridge.sessionId, text, text, undefined, 'inquiry', true) as { id: string }
    // The crash shape is "the page took the text, the host died before the
    // answer". The write-ahead record is written BEFORE the send, so waiting on
    // `postedAt` alone can stop the host between the record and the type. Wait
    // for the durable post AND the page having received the send, then stop
    // inside the wait for an answer.
    //
    // The inbound is deliberately left UNACKNOWLEDGED: with `wait:true` the
    // acknowledgement is deferred until the first answer round, so a crash
    // mid-turn leaves it queued - exactly the live record. The pending job is
    // what tells the next host this inbound is already posted, so `drain` must
    // not re-run it as new.
    //
    // With `wait:true` a send that outlives its wait carries no node id, so a
    // crash mid-turn may leave `userNodeId` null: the page took the text but
    // the record names no node. Recovery must find it by identity, which is
    // exactly what these tests exercise.
    const live = (host as unknown as { bridges: Map<string, { state: BridgeState; transport?: GatewaySessionTransport }> }).bridges.get(bridge.sessionId)!
    await waitFor(() => {
      const job = live.state.pendingTurns.find(turn => turn.messageId === receipt.id)
      if (!job || job.postedAt === null) return undefined
      if (driver.sentAtMs.length <= sendsBefore) return undefined
      return true
    }, 15_000)
    return receipt.id
  } finally {
    await host.stop()
    // The stopped host's turn ends on its own `stopping` check; let its finally
    // persist land before the next host reads the same files.
    await new Promise(resolve => setTimeout(resolve, 120))
  }
}

const sendCount = (driver: FakeDriver): number => driver.calls.filter(call => call.op === 'send').length

describe('R-LIVE-6: a restart reads the page before re-posting a turn', () => {
  test('a turn the page already answered is settled after the restart, with no second post', async () => {
    const { dir, cleanup } = await scratch()
    const { alpha } = await primedBridge()
    await seedHost(dir, [alpha])
    const sender = await busPeer(dir, 'sender')
    const driver = new FakeDriver()
    driver.observable = true
    // The page takes the text (its user node becomes real) but does not finish
    // while this host watches: the host dies between "posted" and "answered".
    driver.stallFor = () => true
    try {
      const messageId = await postedThenStopped(dir, driver, alpha, sender)
      const job = (await readBridge(dir, alpha.sessionId)).pendingTurns.find(turn => turn.messageId === messageId)!
      expect(job.postedAt).not.toBe(null)
      // The page took the text; a send that outlived its wait carries no node
      // id, so recovery must find the node by identity below.
      expect(driver.sentAtMs.length).toBe(1)
      // The page finishes the turn after the crash. This is exactly the live
      // shape: the answer is on the page, the sender is still owed.
      driver.pageNode(THREAD_A, 'the answer that was already on the page')
      driver.reopen()
      driver.stallFor = undefined
      expect(sendCount(driver)).toBe(1)

      const host = await startHost(dir, driver)
      try {
        await waitFor(() => (sender.inbox().length >= 1 ? true : undefined), 15_000)
        await new Promise(resolve => setTimeout(resolve, 300))
        expect(sender.inbox().length).toBe(1)
        expect(String((sender.inbox()[0]!.message as unknown as { text: string }).text)).toContain('the answer that was already on the page')
        // THE defect: the recovering host typed the whole prompt again.
        expect(sendCount(driver)).toBe(1)
      } finally {
        await host.stop()
      }
    } finally {
      await sender.close()
      await cleanup()
    }
  }, 40_000)

  test('a turn the page is still generating is not posted again, and its later answer is delivered once', async () => {
    const { dir, cleanup } = await scratch()
    const { alpha } = await primedBridge()
    await seedHost(dir, [alpha])
    const sender = await busPeer(dir, 'sender')
    const driver = new FakeDriver()
    driver.observable = true
    driver.stallFor = () => true
    try {
      await postedThenStopped(dir, driver, alpha, sender)
      driver.reopen()
      driver.stallFor = undefined
      expect(sendCount(driver)).toBe(1)

      const host = await startHost(dir, driver)
      try {
        // Our node is on the page but no answer yet: possibly still generating,
        // so the restart must not type the prompt in again.
        await new Promise(resolve => setTimeout(resolve, 600))
        expect(sender.inbox().length).toBe(0)
        expect(sendCount(driver)).toBe(1)

        // The page finishes; the next observation settles the owed turn.
        driver.pageNode(THREAD_A, 'the late answer')
        await host.pollOnce()
        await waitFor(() => (sender.inbox().length >= 1 ? true : undefined), 15_000)
        await new Promise(resolve => setTimeout(resolve, 300))
        expect(sender.inbox().length).toBe(1)
        expect(String((sender.inbox()[0]!.message as unknown as { text: string }).text)).toContain('the late answer')
        expect(sendCount(driver)).toBe(1)
      } finally {
        await host.stop()
      }
    } finally {
      await sender.close()
      await cleanup()
    }
  }, 40_000)

  test('a turn whose post never landed is posted after the restart, once', async () => {
    const { dir, cleanup } = await scratch()
    const { alpha } = await primedBridge()
    await seedHost(dir, [alpha])
    const sender = await busPeer(dir, 'sender')
    const driverA = new FakeDriver()
    driverA.observable = true
    // `lags` is the page accepting the send and rendering nothing: the crash
    // leaves a record that says POSTED but a thread with no node of ours.
    driverA.lags = true
    try {
      const messageId = await postedThenStopped(dir, driverA, alpha, sender)
      const job = (await readBridge(dir, alpha.sessionId)).pendingTurns.find(turn => turn.messageId === messageId)!
      expect(job.postedAt).not.toBe(null)
      expect(job.userNodeId).toBe(null)

      // A new process over the same page: the page holds no node of ours, so
      // the send provably never landed and the turn is the restart's to post.
      const driverB = new FakeDriver()
      driverB.observable = true
      const host = await startHost(dir, driverB)
      try {
        await waitFor(() => (sender.inbox().length >= 1 ? true : undefined), 20_000)
        await new Promise(resolve => setTimeout(resolve, 300))
        expect(sender.inbox().length).toBe(1)
        expect(sendCount(driverB)).toBe(1)
      } finally {
        await host.stop()
      }
    } finally {
      await sender.close()
      await cleanup()
    }
  }, 40_000)

  test('a turn from a sender that no longer exists is retired, not replayed', async () => {
    const { dir, cleanup } = await scratch()
    const { alpha } = await primedBridge()
    await seedHost(dir, [alpha])
    const sender = await busPeer(dir, 'sender')
    const driverA = new FakeDriver()
    driverA.observable = true
    try {
      const senderId = sender.peer.sessionId
      const messageId = await postedThenStopped(dir, driverA, alpha, sender)
      // The sender exits and its registration goes with it, which is what a
      // synthetic sender leaves behind. Nobody is left to receive a reply, so a
      // restart must neither read the page for it nor type it again.
      await sender.close()
      await rm(join(sessionsDir(dir), `${senderId}.json`), { force: true })

      const driverB = new FakeDriver()
      driverB.observable = true
      const host = await startHost(dir, driverB)
      try {
        await waitFor(async () => {
          const bridge = await readBridge(dir, alpha.sessionId)
          return bridge.pendingTurns.some(turn => turn.messageId === messageId) ? undefined : true
        }, 15_000)
        await new Promise(resolve => setTimeout(resolve, 300))
        // Nothing was typed into the page for a turn nobody can be paid for.
        expect(sendCount(driverB)).toBe(0)
      } finally {
        await host.stop()
      }
      // The retirement is recorded, so an operator can see why a turn was not
      // answered rather than finding it silently missing.
      const state = JSON.parse(await readFile(join(dir, 'peer.json'), 'utf8')) as { audit: { result: string }[] }
      expect(state.audit.some(entry => entry.result.includes('the sender is gone from the bus; not replayed'))).toBe(true)
    } finally {
      await sender.close()
      await cleanup()
    }
  }, 40_000)

  test('a reply the bus refuses for a vanished sender is retired once, not retried', async () => {
    const { dir, cleanup } = await scratch()
    const { alpha } = await primedBridge()
    await seedHost(dir, [alpha])
    const sender = await busPeer(dir, 'sender')
    const driver = new FakeDriver()
    driver.observable = true
    // The page takes the text and holds the answer until the sender is gone,
    // so the ONE live run reaches the send and hears the bus refuse it.
    driver.stallFor = () => true
    const host = await startHost(dir, driver, { pendingWatchGapsMs: [200] })
    try {
      const senderId = sender.peer.sessionId
      const receipt = await sender.send(alpha.sessionId, 'ask the page', 'ask the page', undefined, 'inquiry', true) as { id: string }
      await waitFor(() => (driver.sentAtMs.length >= 1 ? true : undefined), 15_000)

      // The sender exits; its registration goes with it. The answer lands
      // afterwards, so the host has something to deliver to nobody.
      await sender.close()
      await rm(join(sessionsDir(dir), `${senderId}.json`), { force: true })
      driver.stallFor = undefined
      driver.pageNode(THREAD_A, 'an answer nobody can receive')

      const sendsBefore = driver.calls.filter(call => call.op === 'send').length
      await host.pollOnce()
      await waitFor(async () => {
        const bridge = await readBridge(dir, alpha.sessionId)
        return bridge.pendingTurns.some(turn => turn.messageId === receipt.id) ? undefined : true
      }, 15_000)
      // A second pass must find nothing left to retry.
      await host.pollOnce()
      expect(driver.calls.filter(call => call.op === 'send').length).toBe(sendsBefore)
      const state = JSON.parse(await readFile(join(dir, 'peer.json'), 'utf8')) as { audit: { result: string }[] }
      expect(state.audit.some(entry => entry.result.includes('sender gone; reply not delivered'))).toBe(true)
    } finally {
      await host.stop()
      await sender.close().catch(() => {})
      await cleanup()
    }
  }, 40_000)

  test('two bridges turning at once still type one page turn at a time', async () => {
    const THREAD_B = '22222222-2222-4222-8222-222222222222'
    const { dir, cleanup } = await scratch()
    const alpha = bridgeNamed('alpha', THREAD_A)
    alpha.primedThreadId = THREAD_A
    alpha.primerSha256 = await primerSha()
    const beta = bridgeNamed('beta', THREAD_B)
    beta.primedThreadId = THREAD_B
    beta.primerSha256 = alpha.primerSha256
    await seedHost(dir, [alpha, beta])
    const senderA = await busPeer(dir, 'sender-a')
    const senderB = await busPeer(dir, 'sender-b')
    const driver = new FakeDriver()
    driver.observable = true
    // Each send holds the page for a moment, so overlapping turns are visible.
    driver.sendDelayMs = 150
    const host = await startHost(dir, driver, { pendingWatchGapsMs: [200] })
    try {
      // Both land within a moment of each other; each send only waits on the
      // bus accepting it, not on the host's answer.
      const receiptA = await senderA.send(alpha.sessionId, 'ask alpha', 'ask alpha', undefined, 'inquiry', true) as { id: string }
      const receiptB = await senderB.send(beta.sessionId, 'ask beta', 'ask beta', undefined, 'inquiry', true) as { id: string }
      await waitFor(() => (senderA.inbox().length >= 1 && senderB.inbox().length >= 1 ? true : undefined), 20_000)
      // Both were answered, and no two sends were ever in flight together.
      expect(driver.maxSendConcurrency).toBe(1)
      expect(driver.sentAtMs.length).toBe(2)
      expect(senderA.inbox()[0]!.message.replyTo).toBe(receiptA.id)
      expect(senderB.inbox()[0]!.message.replyTo).toBe(receiptB.id)
    } finally {
      await host.stop()
      await senderA.close().catch(() => {})
      await senderB.close().catch(() => {})
      await cleanup()
    }
  }, 40_000)

  test('a render fault after the send POST is never posted a second time', async () => {
    const { dir, cleanup } = await scratch()
    const { alpha } = await primedBridge()
    await seedHost(dir, [alpha])
    const sender = await busPeer(dir, 'sender')
    const driver = new FakeDriver()
    driver.observable = true
    // The text landed (the fake grows the user node), the page then reports it
    // cannot draw the thread. One inbound, one POST.
    driver.pageLoadAccepted = true
    const host = await startHost(dir, driver, { pendingWatchGapsMs: [200] })
    try {
      const receipt = await sender.send(alpha.sessionId, 'ask the page', 'ask the page', undefined, 'inquiry', true) as { id: string }
      await waitFor(() => (driver.sentAtMs.length >= 1 ? true : undefined), 15_000)
      // The record keeps POSTED, so no pass may type it again.
      const job = (await readBridge(dir, alpha.sessionId)).pendingTurns.find(turn => turn.messageId === receipt.id)!
      expect(job.postedAt).not.toBe(null)
      await host.pollOnce()
      expect(sendCount(driver)).toBe(1)
      // The page draws the answer it already had; it is delivered exactly once.
      driver.pageLoadAccepted = false
      driver.pageNode(THREAD_A, 'the answer the page finally drew')
      await host.pollOnce()
      await waitFor(() => (sender.inbox().length >= 1 ? true : undefined), 15_000)
      await new Promise(resolve => setTimeout(resolve, 300))
      expect(sender.inbox().length).toBe(1)
      expect(String((sender.inbox()[0]!.message as unknown as { text: string }).text)).toContain('the answer the page finally drew')
      expect(sendCount(driver)).toBe(1)
    } finally {
      await host.stop()
      await sender.close().catch(() => {})
      await cleanup()
    }
  }, 40_000)

  test('a posted turn survives a 429 storm: the watch waits the window out, then delivers', async () => {
    const { dir, cleanup } = await scratch()
    const { alpha } = await primedBridge()
    await seedHost(dir, [alpha])
    const sender = await busPeer(dir, 'sender')
    try {
      // The page takes the text and keeps generating, so the send ends owed.
      const text = 'ask under a storm'
      const driver = new FakeDriver()
      driver.observable = true
      driver.stallFor = () => true
      // The first reads of the turn are throttled, which is the live 2026-11-06
      // shape: a posted turn, a 429 window, and the watch's ladder spent inside
      // that window.
      driver.conversation429 = 2
      const host = await startHost(dir, driver, {
        pendingWatchGapsMs: [10, 10],
        pendingWatchTailMs: 20,
        readBackoffBaseMs: 40,
      })
      try {
        await sender.send(alpha.sessionId, text, text, undefined, 'inquiry', true)
        await waitFor(async () => {
          const bridge = await readBridge(dir, alpha.sessionId)
          return bridge.pendingTurns.some(turn => turn.postedAt !== null) ? true : undefined
        }, 10_000)
        // The answer arrives while the reads are still being refused. The two
        // ladder rungs (20 ms) are spent before a refused read can succeed, so
        // only the slow tail can deliver this turn; before the tail existed it
        // waited for the reconcile pass, up to five minutes.
        driver.stallFor = undefined
        driver.pageNode(THREAD_A, 'the answer after the storm')
        await waitFor(() => (sender.inbox().length >= 1 ? true : undefined), 15_000)
        expect(sender.inbox().length).toBe(1)
        expect(String((sender.inbox()[0]!.message as unknown as { text: string }).text)).toContain('the answer after the storm')
        // Every read that was allowed to happen either got the 429 or delivered
        // the turn; a tick inside the window spends no read at all, and one
        // delivery means the extra attempts stayed bounded.
        expect(driver.refusedReads).toBe(2)
        expect(driver.conversationAttempts).toBeLessThanOrEqual(6)
        // An empty render is not a reason to reload a page that reads over the
        // backend API - a reload is another full page load against the account.
        expect(driver.calls.filter(call => String(call.op) === 'reload').length).toBe(0)
      } finally {
        await host.stop()
      }
    } finally {
      await sender.close()
      await cleanup()
    }
  }, 40_000)

  test('a page that cannot be read at startup is not posted to blindly', async () => {
    const { dir, cleanup } = await scratch()
    const { alpha } = await primedBridge()
    await seedHost(dir, [alpha])
    const sender = await busPeer(dir, 'sender')
    const driver = new FakeDriver()
    driver.observable = true
    driver.stallFor = () => true
    try {
      await postedThenStopped(dir, driver, alpha, sender)
      driver.pageNode(THREAD_A, 'the answer behind a failed read')
      driver.reopen()
      driver.stallFor = undefined
      // The driver cannot answer a conversation read at startup.
      driver.conversationFails = true
      expect(sendCount(driver)).toBe(1)

      const host = await startHost(dir, driver)
      try {
        // Unproven is not "never landed": nothing may be typed.
        await new Promise(resolve => setTimeout(resolve, 600))
        expect(sender.inbox().length).toBe(0)
        expect(sendCount(driver)).toBe(1)

        // The read recovers; the turn is still owed and is settled from the page.
        driver.conversationFails = false
        await host.pollOnce()
        await waitFor(() => (sender.inbox().length >= 1 ? true : undefined), 15_000)
        await new Promise(resolve => setTimeout(resolve, 300))
        expect(sender.inbox().length).toBe(1)
        expect(String((sender.inbox()[0]!.message as unknown as { text: string }).text)).toContain('the answer behind a failed read')
        expect(sendCount(driver)).toBe(1)
      } finally {
        await host.stop()
      }
    } finally {
      await sender.close()
      await cleanup()
    }
  }, 40_000)
})

describe('R-LIVE-7: the bus decides what is owed, and a mark is not a delivery', () => {
  test('a queued inbound the bus already has a reply for is not re-run after a restart', async () => {
    const { dir, cleanup } = await scratch()
    const { alpha } = await primedBridge()
    await seedHost(dir, [alpha])
    const sender = await busPeer(dir, 'sender')
    // The bridge's own transport takes the inbound and answers it, but is never
    // acknowledged: the record stays queued, exactly as when the live host was
    // killed before its fire-and-forget ack was persisted.
    const bridgePeer = new GatewaySessionTransport({
      directory: sessionsDir(dir), sessionId: alpha.sessionId, name: 'alpha', cwd: dir, purpose: 'bridge', policy: 'accept',
    })
    await bridgePeer.start()
    try {
      const sent = await sender.send(alpha.sessionId, 'already answered', 'already answered', undefined, 'inquiry', true) as { id: string }
      const inbound = await waitFor(() => bridgePeer.inbox().find(record => record.message.id === sent.id), 10_000)
      await bridgePeer.send(inbound.message.fromSessionId, 'the answer that was already sent', 'Re: already', sent.id, 'inquiry', false)
    } finally {
      await bridgePeer.close()
    }

    const driver = new FakeDriver()
    driver.observable = true
    const host = await startHost(dir, driver)
    try {
      await new Promise(resolve => setTimeout(resolve, 800))
      // The transport says this inbound is answered; re-running it would type
      // the prompt a second time and answer the sender twice.
      expect(sendCount(driver)).toBe(0)
      expect(sender.inbox().filter(record => record.message.replyTo === undefined).length).toBe(0)
    } finally {
      await host.stop()
      await sender.close()
      await cleanup()
    }
  }, 40_000)

  test('a write-ahead answered mark does not suppress the only delivery', async () => {
    const { dir, cleanup } = await scratch()
    const { alpha } = await primedBridge()
    await seedHost(dir, [alpha])
    const sender = await busPeer(dir, 'sender')
    const driver = new FakeDriver()
    driver.observable = true
    driver.stallFor = () => true
    try {
      const messageId = await postedThenStopped(dir, driver, alpha, sender)
      const state = await readBridge(dir, alpha.sessionId)
      // The crashed process wrote the answer-obtained mark BEFORE sending. With
      // `wait:true` a mid-turn crash names no node, so the write-ahead key is
      // the message's own (`m:`) key. The bus has no reply for it, so the
      // sender is still owed one.
      state.answeredTurns = [...state.answeredTurns, `m:${messageId}`]
      await saveJson(join(dir, 'bridges', `${alpha.sessionId}.json`), state)

      driver.pageNode(THREAD_A, 'the answer the write-ahead mark hid')
      driver.reopen()
      driver.stallFor = undefined
      // The startup read fails, so recovery leaves the turn owed - the same
      // sequence as "our node present but the answer is not complete yet".
      driver.conversationFails = true
      expect(sendCount(driver)).toBe(1)

      const host = await startHost(dir, driver)
      try {
        await new Promise(resolve => setTimeout(resolve, 600))
        expect(sender.inbox().length).toBe(0)

        // The observation pass is the only delivery this turn will ever get.
        // The write-ahead mark must not retire it into silence.
        driver.conversationFails = false
        await host.pollOnce()
        await waitFor(() => (sender.inbox().length >= 1 ? true : undefined), 15_000)
        await new Promise(resolve => setTimeout(resolve, 300))
        expect(sender.inbox().length).toBe(1)
        expect(String((sender.inbox()[0]!.message as unknown as { text: string }).text)).toContain('the answer the write-ahead mark hid')
        expect(sendCount(driver)).toBe(1)
      } finally {
        await host.stop()
      }
    } finally {
      await sender.close()
      await cleanup()
    }
  }, 40_000)
})

type LiveBridge = { state: BridgeState; removed: boolean; stopping: boolean }

const liveBridge = (host: ChatGptHost, sessionId: string): LiveBridge =>
  (host as unknown as { bridges: Map<string, LiveBridge> }).bridges.get(sessionId)!

const pendingJob = (kind: 'inquiry' | 'directive' = 'inquiry') => ({
  threadId: THREAD_A,
  userNodeId: null as string | null,
  ourText: 'unit ping',
  text: 'unit ping',
  senderSessionId: randomUUID(),
  messageId: randomUUID(),
  kind,
  postedAt: null as string | null,
})

describe('R1-F8: a removed bridge is not posted to after the status read', () => {
  test('a post whose bridge is removed while the status read is in flight types nothing', async () => {
    const { dir, cleanup } = await scratch()
    const { alpha } = await primedBridge()
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.observable = true
    const host = await startHost(dir, driver)
    const live = liveBridge(host, alpha.sessionId)
    try {
      const job = pendingJob()
      // The page is idle, so the gate would let the post through. The removal
      // lands DURING the read: only a re-check after it can stop the send.
      const patched = host as unknown as { cheapStatus: (threadId: string) => Promise<unknown> }
      const realCheap = patched.cheapStatus.bind(host)
      patched.cheapStatus = async (threadId: string) => {
        live.removed = true
        live.stopping = true
        return realCheap(threadId)
      }
      await expect((host as unknown as { postPendingTurn: (b: LiveBridge, j: unknown, ms?: number) => Promise<boolean> }).postPendingTurn(live, job, 1_000)).rejects.toThrow(/removed/)
      expect(sendCount(driver)).toBe(0)
    } finally {
      live.removed = false
      live.stopping = false
      await host.stop()
      await cleanup()
    }
  }, 40_000)
})

describe('NEW-2: a later failure does not erase a send the page already took', () => {
  test('a transient error after the page took the text leaves the turn recorded as posted', async () => {
    const { dir, cleanup } = await scratch()
    const { alpha } = await primedBridge()
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.observable = true
    const host = await startHost(dir, driver)
    const live = liveBridge(host, alpha.sessionId)
    try {
      const job = pendingJob()
      const patched = host as unknown as {
        notePendingTurn: (bridge: unknown, record: unknown) => Promise<void>
      }
      const realNote = patched.notePendingTurn.bind(host)
      let thrown = false
      // The write-ahead record (postedAt set, no node yet) must succeed; the
      // post-send record (both set) is the step that throws. That is exactly a
      // transient failure AFTER the page accepted the text.
      patched.notePendingTurn = async (bridge: unknown, record: unknown) => {
        const entry = record as { postedAt: string | null; userNodeId: string | null }
        if (!thrown && entry.postedAt !== null && entry.userNodeId !== null) {
          thrown = true
          throw new Error('the bridge file could not be written')
        }
        return realNote(bridge, record)
      }
      await expect((host as unknown as { postRecordedTurn: (b: LiveBridge, j: unknown) => Promise<boolean> }).postRecordedTurn(live, job)).rejects.toThrow(/could not be written/)
      expect(driver.sentAtMs.length).toBe(1)
      const persisted = (await readBridge(dir, alpha.sessionId)).pendingTurns.find(turn => turn.messageId === job.messageId)!
      // THE defect: the blanket catch said "never posted", so recovery re-types.
      expect(persisted.postedAt).not.toBe(null)
      expect(typeof persisted.userNodeId).toBe('string')
    } finally {
      await host.stop()
      await cleanup()
    }
  }, 40_000)
})
