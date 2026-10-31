/**
 * Round 7, host half: six findings a reviewer filed against the merged tree
 * (`d9836b6`). Each test drives the real host against the frozen line-JSON
 * page fake, and each one is red on that base.
 *
 *   F1  recovery must ask the same "is this node ours?" question the
 *       observation pass asks. A posted turn whose node was already adopted
 *       into `ourNodeIds` used to read as `absent` and be typed a second time.
 *   F2  the job record is kept until the reply has actually left. (a) the live
 *       turn's failed send, (b) the observation path's failed send.
 *   F3  a send that typed and THEN faulted is still posted. Clearing
 *       `postedAt` made recovery type the same prompt again.
 *   F4  the removal re-check sits at the last point before the driver is
 *       called, after the snapshot read yields.
 *   F7  the delivered-node ledger is permanent: a count bound silently forgot
 *       the oldest delivery and re-created its file.
 *   F8  inbound-run markers are retained by turn lifetime, not by count: a
 *       count bound evicted the marker of an inbound still owed.
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

const THREAD_A = '11111111-1111-4111-8111-111111111111'

type Call = Record<string, unknown>

/** The frozen child protocol, in memory. One page, one active thread. */
class FakeDriver {
  readonly calls: Call[] = []
  threads = [{ id: THREAD_A, title: 'Existing work' }]
  killed = false
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
  fileExistsOnce = false
  fileDelayMs = 0
  omitFilePath = false
  stallFor: ((request: Call) => boolean) | undefined
  /** The node a send created, so a test can name it in `ourNodeIds`. */
  lastUserNode: string | null = null
  /**
   * F3's shape: the page takes the text (the user node exists) and the driver
   * then fails the call itself. A timeout or a replacement, never a refusal.
   */
  typeThenFault: { reason?: string; error?: string } | null = null
  /** Called on every conversation read, before the tree is returned. */
  onConversation: ((request: Call) => void) | undefined
  readonly fileCalls: { fileId?: string; sandboxPath?: string; outPath?: string }[] = []
  conversationReads = 0
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
    if (role === 'user') this.lastUserNode = id
    return id
  }

  private grow(threadId: string, role: 'user' | 'assistant', text: string): string {
    return this.append(threadId, role, text)
  }

  humanTypes(threadId: string, text: string, answer: string): string {
    const id = this.grow(threadId, 'user', text)
    this.append(threadId, 'assistant', answer)
    return id
  }

  pageNode(threadId: string, text: string, files: { id?: string; name?: string; mime?: string; size?: number }[] = []): string {
    return this.append(threadId, 'assistant', text, files)
  }

  setClock(seconds: number): void { this.clock = seconds }

  /** The page finishes the turn: the answer node exists on the branch. */
  finishAnswer(text: string): void {
    this.faultError = null
    const threadId = this.current ?? THREAD_A
    this.grow(threadId, 'assistant', text)
    this.signal = { phase: 'complete', threadId, at: Date.now() }
  }

  onEvent(handler: (event: Record<string, unknown>) => void): () => void {
    this.listeners.add(handler)
    return () => { this.listeners.delete(handler) }
  }

  emit(event: Record<string, unknown>): void { for (const listener of this.listeners) listener(event) }

  async call(request: Call): Promise<DriverReply> {
    if (String(request.op ?? '') === 'ping') return { ok: true, op: 'ping' }
    if (this.dead) return { ok: false, op: String(request.op ?? ''), error: 'the driver is gone' }
    if (this.faultError) return { ok: false, op: String(request.op ?? ''), reason: 'timeout', error: this.faultError }
    this.calls.push({ ...request })
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
      const threadId = this.current ?? THREAD_A
      this.answer = this.answerFor?.(request) ?? this.answer
      const stalls = this.stallFor?.(request) === true
      this.grow(threadId, 'user', String(request.text ?? ''))
      const fault = this.typeThenFault
      if (fault) {
        // The text is ON the page; the call itself fails after typing.
        this.typeThenFault = null
        this.signal = { phase: 'generating', threadId, at: Date.now() }
        return { ok: false, op, reason: fault.reason ?? 'timeout', error: fault.error ?? 'driver timed out after 45s', threadId }
      }
      if (!stalls) this.grow(threadId, 'assistant', this.answer)
      this.signal = { phase: stalls ? 'streaming' : 'complete', threadId, at: Date.now() }
      this.sentAtMs.push(Date.now())
      if (this.wedgeAfterSend) {
        this.wedgeAfterSend = false
        this.faultError = 'driver was replaced after r27 timed out'
      }
      return { ok: true, op, text: this.sendTextFor?.(request) ?? this.sendText, threadId, model: 'GPT-6', effort: 'High' }
    }
    if (op === 'read') return { ok: true, op, threadId: this.current, text: this.answer, evidence: this.evidence }
    if (op === 'conversation' && this.observable) {
      this.onConversation?.(request)
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
      return {
        ok: true, op, cost: 'push', threadId: asked,
        pushedThreadId: this.signal.threadId,
        matchesThread: this.signal.threadId === null ? null : this.signal.threadId === asked,
        state: pushed, phase: this.signal.phase,
        ageMs: this.signal.at === null ? null : Date.now() - this.signal.at, at,
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

  pageFailed = false
  sendError: string | null = null
  landOn: string | null = null
  lags = false
  faultError: string | null = null
  /** The next successful send wedges the driver: everything after it faults. */
  wedgeAfterSend = false
}

const basenameOf = (path: string): string => path.replace(/\\/g, '/').split('/').pop() ?? ''

async function scratch(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-peer-r7host-'))
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

async function waitFor<T>(probe: () => Promise<T | undefined> | T | undefined, timeoutMs = 15_000): Promise<T> {
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

const primerSha = async (): Promise<string> =>
  sha256(await readFile(join(import.meta.dir, 'chatgpt-peer', 'primer.md'), 'utf8'))

async function readBridge(dir: string, sessionId: string): Promise<BridgeState> {
  return JSON.parse(await readFile(join(dir, 'bridges', `${sessionId}.json`), 'utf8')) as BridgeState
}

const bridgePath = (dir: string, sessionId: string): string => join(dir, 'bridges', `${sessionId}.json`)

async function busPeer(dir: string, name: string): Promise<GatewaySessionTransport> {
  const transport = new GatewaySessionTransport({
    directory: sessionsDir(dir), sessionId: randomUUID(), name, cwd: dir, purpose: 'test sender', policy: 'accept',
  })
  await transport.start()
  return transport
}

async function primedBridge(): Promise<BridgeState> {
  const alpha = bridgeNamed('alpha', THREAD_A)
  alpha.primedThreadId = THREAD_A
  alpha.primerSha256 = await primerSha()
  return alpha
}

const sendCount = (driver: FakeDriver): number => driver.calls.filter(call => call.op === 'send').length

type LiveBridge = {
  state: BridgeState
  removed: boolean
  stopping: boolean
  transport?: { send: (...args: unknown[]) => Promise<unknown>; historyEntries(): unknown[]; inbox(): unknown[] }
}
type Internals = {
  bridges: Map<string, LiveBridge>
  executeCommand: (bridge: LiveBridge, command: Record<string, unknown>, by: 'model' | 'operator', messageId?: string, ordinal?: number) => Promise<{ line: string; replied: boolean }>
}
const internals = (host: ChatGptHost): Internals => host as unknown as Internals

/** Make the next reply send fail, as a host killed in that window would. */
function failNextReply(bridge: LiveBridge): { armed: () => boolean } {
  const transport = bridge.transport!
  const real = transport.send.bind(transport)
  let armed = true
  transport.send = async (...args: unknown[]) => {
    if (armed) { armed = false; throw new Error('the host died before the reply left') }
    return real(...args)
  }
  return { armed: () => armed }
}

const repliesTo = (transport: GatewaySessionTransport, id: string): string[] =>
  transport.inbox()
    .filter(record => (record.message as unknown as { replyTo?: string }).replyTo === id)
    .map(record => String((record.message as unknown as { text: string }).text))

describe('R7-F1: recovery finds a send node that is already ours', () => {
  test('a posted turn whose node was adopted into ourNodeIds is settled, never typed again', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.observable = true
    // The page takes the text and then the driver dies: the live r27 shape.
    driver.stallFor = () => true
    driver.wedgeAfterSend = true
    const sender = await busPeer(dir, 'sender')
    const host = await startHost(dir, driver, { turnTimeoutMs: 800 })
    let receipt: { id: string } = { id: '' }
    try {
      receipt = await sender.send(alpha.sessionId, 'unit ping', 'unit ping', undefined, 'inquiry', true) as { id: string }
      await waitFor(() => (driver.faultError ? true : undefined), 10_000)
      // The turn ends as "no evidence": the job stays posted with no node id.
      await waitFor(async () => {
        const state = await readBridge(dir, alpha.sessionId)
        const turn = state.pendingTurns.find(item => item.messageId === receipt.id)
        return turn && turn.postedAt !== null ? true : undefined
      }, 10_000)
      await new Promise(resolve => setTimeout(resolve, 300))
    } finally {
      await host.stop()
    }
    try {
      const userNode = driver.lastUserNode
      expect(typeof userNode).toBe('string')
      // The page finishes the turn after the wedge.
      driver.finishAnswer('the answer that was already on the page')
      const state = await readBridge(dir, alpha.sessionId)
      // The crash shape: posted, no node id, and an earlier pass already adopted
      // the send's node into ourNodeIds.
      await saveJson(bridgePath(dir, alpha.sessionId), {
        ...state,
        ourNodeIds: [...new Set([...state.ourNodeIds, userNode!])],
        pendingTurns: state.pendingTurns.map(turn => turn.messageId === receipt.id
          ? { ...turn, userNodeId: null }
          : turn),
      })
      const sendsBefore = sendCount(driver)
      const host2 = await startHost(dir, driver)
      try {
        await waitFor(() => (repliesTo(sender, receipt.id).length >= 1 ? true : undefined), 15_000)
        await new Promise(resolve => setTimeout(resolve, 300))
        // Delivered from the page, not re-typed: F1's whole claim.
        expect(repliesTo(sender, receipt.id).length).toBe(1)
        expect(repliesTo(sender, receipt.id)[0]).toContain('the answer that was already on the page')
        expect(sendCount(driver)).toBe(sendsBefore)
      } finally {
        await host2.stop()
      }
    } finally {
      await sender.close()
      await cleanup()
    }
  }, 40_000)
})

describe('R7-F2: the job record outlives an unsent reply', () => {
  test('a failed reply send leaves the record; the restart delivers it without a second page turn', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.observable = true
    const sender = await busPeer(dir, 'sender')
    const host = await startHost(dir, driver)
    let receipt: { id: string } = { id: '' }
    try {
      const live = internals(host).bridges.get(alpha.sessionId)!
      const fault = failNextReply(live)
      receipt = await sender.send(alpha.sessionId, 'unit ping', 'unit ping', undefined, 'inquiry', true) as { id: string }
      // The reply could not leave; the bus still lists this message as owed.
      await waitFor(() => (fault.armed() ? undefined : true), 10_000)
      await new Promise(resolve => setTimeout(resolve, 300))
      expect(repliesTo(sender, receipt.id).length).toBe(0)
      // The durable record is still the only thing that knows this answer.
      const afterFault = await readBridge(dir, alpha.sessionId)
      expect(afterFault.pendingTurns.some(turn => turn.messageId === receipt.id)).toBe(true)
    } finally {
      await host.stop()
    }
    try {
      const sendsBefore = sendCount(driver)
      const host2 = await startHost(dir, driver)
      try {
        await waitFor(() => (repliesTo(sender, receipt.id).length >= 1 ? true : undefined), 15_000)
        await new Promise(resolve => setTimeout(resolve, 300))
        // One reply, and the page was never asked to run the prompt again.
        expect(repliesTo(sender, receipt.id).length).toBe(1)
        expect(sendCount(driver)).toBe(sendsBefore)
        const settled = await readBridge(dir, alpha.sessionId)
        expect(settled.pendingTurns.some(turn => turn.messageId === receipt.id)).toBe(false)
      } finally {
        await host2.stop()
      }
    } finally {
      await sender.close()
      await cleanup()
    }
  }, 40_000)

  test('the observation path also keeps the record when its send fails, and the next pass delivers', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.observable = true
    // Host 1: the page takes the text and never finishes it (a wedge), so the
    // turn is left owed with the user node on the page.
    driver.stallFor = () => true
    driver.wedgeAfterSend = true
    const sender = await busPeer(dir, 'sender')
    const host = await startHost(dir, driver, { turnTimeoutMs: 800 })
    let receipt: { id: string } = { id: '' }
    try {
      receipt = await sender.send(alpha.sessionId, 'unit ping', 'unit ping', undefined, 'inquiry', true) as { id: string }
      await waitFor(async () => {
        const state = await readBridge(dir, alpha.sessionId)
        const turn = state.pendingTurns.find(item => item.messageId === receipt.id)
        return turn && turn.postedAt !== null ? true : undefined
      }, 10_000)
      await new Promise(resolve => setTimeout(resolve, 300))
    } finally {
      await host.stop()
    }
    try {
      // The page finishes while the host is down; recovery is the observation
      // path's `deliverSolicited`, and its send fails once.
      driver.finishAnswer('the answer the seller finally gave')
      const host2 = await startHost(dir, driver)
      try {
        const live = internals(host2).bridges.get(alpha.sessionId)!
        const fault = failNextReply(live)
        await waitFor(() => (fault.armed() ? undefined : true), 15_000)
        await new Promise(resolve => setTimeout(resolve, 300))
        expect(repliesTo(sender, receipt.id).length).toBe(0)
        // The record was not deleted before the send.
        const afterFault = await readBridge(dir, alpha.sessionId)
        expect(afterFault.pendingTurns.some(turn => turn.messageId === receipt.id)).toBe(true)
        // The next pass delivers the answer the page already gave.
        await host2.pollOnce()
        await waitFor(() => (repliesTo(sender, receipt.id).length >= 1 ? true : undefined), 15_000)
        await new Promise(resolve => setTimeout(resolve, 200))
        expect(repliesTo(sender, receipt.id).length).toBe(1)
        expect(repliesTo(sender, receipt.id)[0]).toContain('the answer the seller finally gave')
        expect(sendCount(driver)).toBe(1)
      } finally {
        await host2.stop()
      }
    } finally {
      await sender.close()
      await cleanup()
    }
  }, 40_000)
})

describe('R7-F2 residual: a failure line that could not be sent keeps the record', () => {
  test('a failed failure-line send does not delete the record, so the restart cannot re-post the prompt', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.observable = true
    // Host 1: the page takes the text and the driver then goes away, so the
    // turn ends as "no evidence" and stays owed with its user node on the page.
    driver.stallFor = () => true
    driver.wedgeAfterSend = true
    const sender = await busPeer(dir, 'sender')
    const host = await startHost(dir, driver, { turnTimeoutMs: 800 })
    let receipt: { id: string } = { id: '' }
    try {
      receipt = await sender.send(alpha.sessionId, 'unit ping', 'unit ping', undefined, 'inquiry', true) as { id: string }
      await waitFor(async () => {
        const state = await readBridge(dir, alpha.sessionId)
        const turn = state.pendingTurns.find(item => item.messageId === receipt.id)
        return turn && turn.postedAt !== null ? true : undefined
      }, 10_000)
      await new Promise(resolve => setTimeout(resolve, 300))
    } finally {
      await host.stop()
    }
    try {
      // Past the 6h TTL, so the observation pass takes the failure branch.
      const state = await readBridge(dir, alpha.sessionId)
      await saveJson(bridgePath(dir, alpha.sessionId), {
        ...state,
        pendingTurns: state.pendingTurns.map(turn => turn.messageId === receipt.id
          ? { ...turn, postedAt: new Date(Date.now() - 7 * 3600_000).toISOString() }
          : turn),
      })
      // The driver is back and the page is readable, but it never finished the
      // turn: the TTL branch is what reports it.
      driver.faultError = null
      const sendsBefore = sendCount(driver)
      const host2 = await startHost(dir, driver)
      try {
        const live = internals(host2).bridges.get(alpha.sessionId)!
        const fault = failNextReply(live)
        // The failure line's send throws. The record must not be deleted:
        // deleting it loses `postedAt`, and the restart types the prompt again.
        await host2.pollOnce()
        await waitFor(() => (fault.armed() ? undefined : true), 10_000)
        await new Promise(resolve => setTimeout(resolve, 300))
        expect(repliesTo(sender, receipt.id).length).toBe(0)
        const afterFault = await readBridge(dir, alpha.sessionId)
        expect(afterFault.pendingTurns.some(turn => turn.messageId === receipt.id)).toBe(true)
        // The next pass retries the line (never a second page turn).
        await host2.pollOnce()
        await waitFor(() => (repliesTo(sender, receipt.id).length >= 1 ? true : undefined), 15_000)
        expect(repliesTo(sender, receipt.id).length).toBe(1)
        expect(repliesTo(sender, receipt.id)[0]).toContain('could not answer')
        expect(sendCount(driver)).toBe(sendsBefore)
        const settled = await readBridge(dir, alpha.sessionId)
        expect(settled.pendingTurns.some(turn => turn.messageId === receipt.id)).toBe(false)
      } finally {
        await host2.stop()
      }
    } finally {
      await sender.close()
      await cleanup()
    }
  }, 40_000)
})

describe('R7-F2 residual [regression guard]: a message that expected no reply is retired, not answered', () => {
  // Green on base by construction: the base deleted this record at
  // `markAnswered`, which is why an unwanted answer never showed. It exists to
  // keep the corrected conditional retire from over-retiring non-expecting work.
  test('a directive with expectReply=false leaves no record for the observation pass to answer', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.observable = true
    const sender = await busPeer(dir, 'sender')
    const host = await startHost(dir, driver)
    try {
      const receipt = await sender.send(alpha.sessionId, 'for your information', 'fyi', undefined, 'directive', false) as { id: string }
      await waitFor(async () => {
        const state = await readBridge(dir, alpha.sessionId)
        return state.pendingTurns.some(turn => turn.messageId === receipt.id) ? undefined : true
      }, 15_000)
      // One more pass must find nothing to deliver: no reply to a sender that
      // asked for none.
      await host.pollOnce()
      await new Promise(resolve => setTimeout(resolve, 300))
      expect(repliesTo(sender, receipt.id).length).toBe(0)
      const after = await readBridge(dir, alpha.sessionId)
      expect(after.pendingTurns.some(turn => turn.messageId === receipt.id)).toBe(false)
    } finally {
      await sender.close()
      await host.stop()
      await cleanup()
    }
  }, 30_000)
})

describe('R7-F3: a send that typed and then faulted is still posted', () => {

  test('the record keeps postedAt, so the page answer is delivered instead of the prompt re-typed', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.observable = true
    driver.typeThenFault = { reason: 'timeout', error: 'driver timed out after 45s' }
    const host = await startHost(dir, driver, { turnTimeoutMs: 1_500 })
    const sender = await busPeer(dir, 'sender')
    try {
      const receipt = await sender.send(alpha.sessionId, 'unit ping', 'unit ping', undefined, 'inquiry', true) as { id: string }
      const posted = await waitFor(async () => {
        const state = await readBridge(dir, alpha.sessionId)
        return state.pendingTurns.find(turn => turn.messageId === receipt.id)
      }, 10_000)
      // The send typed the prompt; "never posted" would be a lie.
      expect(posted.postedAt).not.toBe(null)
      expect(repliesTo(sender, receipt.id).length).toBe(0)
      // The page then finishes. The turn must be settled from what it typed.
      driver.pageNode(THREAD_A, 'the answer after the failed call')
      await host.pollOnce()
      await waitFor(() => (repliesTo(sender, receipt.id).length >= 1 ? true : undefined), 15_000)
      await new Promise(resolve => setTimeout(resolve, 200))
      expect(repliesTo(sender, receipt.id).length).toBe(1)
      expect(repliesTo(sender, receipt.id)[0]).toContain('the answer after the failed call')
      expect(sendCount(driver)).toBe(1)
    } finally {
      await sender.close()
      await host.stop()
      await cleanup()
    }
  }, 40_000)
})

describe('R7-F4: removal is re-checked at the last point before the send', () => {
  test('a bridge removed during the snapshot read is not typed into', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.observable = true
    const host = await startHost(dir, driver)
    const sender = await busPeer(dir, 'sender')
    try {
      const live = internals(host).bridges.get(alpha.sessionId)!
      // The snapshot read is the last await before the driver call. Removal
      // lands exactly in that window.
      driver.onConversation = () => { live.removed = true }
      const receipt = await sender.send(alpha.sessionId, 'do not type this', 'do not type this', undefined, 'inquiry', true) as { id: string }
      await waitFor(() => (live.removed ? true : undefined), 10_000)
      await new Promise(resolve => setTimeout(resolve, 300))
      // The endpoint was never called: nothing was typed into a removed bridge.
      expect(driver.calls.filter(call => call.op === 'send').length).toBe(0)
      expect(repliesTo(sender, receipt.id).length).toBe(0)
    } finally {
      await sender.close()
      await host.stop()
      await cleanup()
    }
  }, 30_000)
})

describe('R7-F7: the delivered-node ledger is permanent', () => {
  test('delivering one more node does not evict the oldest, so its file stays at-most-once', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    // A host that has already delivered 4096 distinct nodes: the old count cap.
    alpha.deliveredNodes = Array.from({ length: 4096 }, (_, index) => ({ nodeId: `seeded-${index}`, bytes: 0, indexes: [] as number[] }))
    await seedHost(dir, [alpha])
    const listener = await busPeer(dir, 'listener')
    const driver = new FakeDriver()
    driver.observable = true
    const host = await startHost(dir, driver)
    try {
      const { token } = await credentials(dir)
      const node = driver.pageNode(THREAD_A, 'the newest delivery', [{
        id: `file_${randomUUID().replace(/-/g, '')}`, name: 'artifact.txt', mime: 'text/plain', size: 10,
      }])
      const delivered = await operator(host, token, { op: 'files', bridge: alpha.sessionId, to: 'listener', nodeId: node, indexes: [0] })
      expect(delivered.body.files.length).toBe(1)
      const state = await readBridge(dir, alpha.sessionId)
      // The new node is in the ledger AND the oldest one was not forgotten:
      // forgetting it is what re-creates its file.
      expect(state.deliveredNodes.length).toBe(4097)
      expect(state.deliveredNodes.some(entry => entry.nodeId === 'seeded-0')).toBe(true)
    } finally {
      await listener.close()
      await host.stop()
      await cleanup()
    }
  }, 60_000)
})

describe('R7-F8: inbound-run markers are retained by turn lifetime', () => {
  test('a busy host does not evict the marker of an inbound whose command already ran', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.observable = true
    const host = await startHost(dir, driver)
    try {
      const live = internals(host).bridges.get(alpha.sessionId)!
      const original = randomUUID()
      const at = new Date().toISOString()
      // The original inbound already ran; 199 newer inbounds followed, all
      // still inside the turn lifetime. A count cap of 200 keeps exactly these
      // 200 and drops the next-oldest on the next append - the original.
      live.state.inboundRuns = [
        { messageId: original, results: [], at },
        ...Array.from({ length: 199 }, (_, index) => ({ messageId: `filler-${index}`, results: [], at })),
      ]
      const fresh = randomUUID()
      await internals(host).executeCommand(live, { op: 'list' }, 'model', fresh)
      const after = await readBridge(dir, alpha.sessionId)
      // Lifetime, not count: the original marker survived the append.
      expect(after.inboundRuns.some(run => run.messageId === original)).toBe(true)
      // And the point of keeping it: a replay of that inbound, even with
      // different command text, executes nothing.
      const replay = await internals(host).executeCommand(live, { op: 'inbox' }, 'model', original)
      expect(replay.line).toMatch(/replay notice/)
    } finally {
      await host.stop()
      await cleanup()
    }
  }, 30_000)
})

async function credentials(dir: string): Promise<{ token: string }> {
  const body = JSON.parse(await readFile(join(privateHome(dir), 'instances', 'test.json'), 'utf8')) as { token: string }
  return { token: body.token }
}

async function operator(host: ChatGptHost, token: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  // Peer work is HTTP-free now; the seam runs the same host code the removed
  // `files` op used to call, so these rows assert unchanged.
  if (body.op === 'files') return host.deliverFilesForTest(body.bridge, body)
  const response = await fetch(`http://127.0.0.1:${host.port}/operator`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}
