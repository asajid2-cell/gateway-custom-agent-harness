/**
 * Round-7 independent reproduction suite.
 *
 * Each case reconstructs one durable shape that a crash (or a later append)
 * leaves behind, restarts a REAL host over it, and asserts the property the
 * Round-7 review claims is violated. The page is the frozen line-JSON fake the
 * r5live8 lane uses, and the bus is a real GatewaySessionTransport in a scratch
 * directory, so the tests exercise the same code paths production does.
 *
 * This file is deliberately self-contained: it edits no source and no other
 * test file, so the lane that owns chatgpt-peer.ts can move without a conflict.
 *
 * State the suite pushes past a durable cap (R7-6, R7-7) cannot be SEEDED past
 * that cap: the zod schema refuses a bridge file with more than
 * DELIVERED_NODES_MAX / INBOUND_RUNS_MAX entries and the whole bridge is
 * quarantined. Both cases therefore seed exactly the cap and then perform the
 * one real append that makes the ledger/list cross it at runtime - which is the
 * same slice that evicts the oldest entry, and the only reachable way to
 * produce the failure described.
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
  readonly fileCalls: { fileId?: string; sandboxPath?: string; outPath?: string }[] = []
  conversationReads = 0
  conversationFails = false
  answerFor: ((request: Call) => string | undefined) | undefined
  private readonly listeners = new Set<(event: Record<string, unknown>) => void>()
  private current: string | null = null
  observable = false
  private readonly trees = new Map<string, { current: string; mapping: Record<string, any> }>()
  private clock = Math.floor(Date.now() / 1000)

  pageFailed = false
  sendError: string | null = null
  landOn: string | null = null
  lags = false
  faultError: string | null = null
  wedgeAfterSend = false
  /** The next send types the text, then the driver call itself times out. */
  failSendAfterAccept = false
  /**
   * While set, the next `conversation` read blocks on it. Used to remove the
   * bridge during the last await before a send.
   */
  blockConversation: Promise<void> | null = null
  conversationBlocked: (() => void) | null = null

  private treeOf(threadId: string): { current: string; mapping: Record<string, any> } {
    let tree = this.trees.get(threadId)
    if (!tree) {
      const root = `root-${threadId}`
      tree = { current: root, mapping: { [root]: { id: root, parent: null, children: [], message: null } } }
      this.trees.set(threadId, tree)
    }
    return tree
  }

  private append(threadId: string, role: 'user' | 'assistant', text: string, files: { id?: string; name?: string; mime?: string; size?: number }[] = [], exactId?: string): string {
    const tree = this.treeOf(threadId)
    const id = exactId ?? randomUUID()
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

  /** A person's turn plus the model's answer. Returns the user node id. */
  humanTypes(threadId: string, text: string, answer: string, files: { id?: string; name?: string; mime?: string; size?: number }[] = []): string {
    const id = this.append(threadId, 'user', text)
    this.append(threadId, 'assistant', answer, files)
    return id
  }

  /** A finished answer node on the branch. */
  pageNode(threadId: string, text: string, files: { id?: string; name?: string; mime?: string; size?: number }[] = []): string {
    return this.append(threadId, 'assistant', text, files)
  }

  /** Recreate a durable user node under the exact id a crashed host recorded. */
  seedUserTurn(threadId: string, userId: string, text: string, answer: string): string {
    this.append(threadId, 'user', text, [], userId)
    this.append(threadId, 'assistant', answer)
    return userId
  }

  openThread(threadId: string | null): void { this.current = threadId }
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
        this.append(threadId, 'user', String(request.text ?? ''))
        if (!stalls) this.append(threadId, 'assistant', this.answer)
      }
      this.signal = { phase: stalls ? 'streaming' : 'complete', threadId, at: Date.now() }
      this.sentAtMs.push(Date.now())
      if (this.wedgeAfterSend) {
        this.wedgeAfterSend = false
        this.faultError = 'driver was replaced after r27 timed out'
      }
      if (this.failSendAfterAccept) {
        // The page took the text; the DRIVER call then failed. This is the
        // shape R7-4 is about: the send landed, but no reply came back.
        this.failSendAfterAccept = false
        onAccepted?.(String(request.id ?? ''))
        return { ok: false, op, reason: 'timeout', error: 'driver timed out after 600s', threadId }
      }
      onAccepted?.(String(request.id ?? ''))
      return { ok: true, op, text: this.sendTextFor?.(request) ?? this.sendText, threadId, model: 'GPT-6', effort: 'High' }
    }
    if (op === 'read') {
      return { ok: true, op, threadId: this.current, text: this.answer, evidence: this.evidence }
    }
    if (op === 'conversation' && this.observable) {
      if (this.blockConversation) {
        const gate = this.blockConversation
        this.blockConversation = null
        this.conversationBlocked?.()
        await gate
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

  finishAnswer(text: string): void {
    this.faultError = null
    const threadId = this.current ?? THREAD_A
    this.append(threadId, 'assistant', text)
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
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-peer-r7-'))
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

async function writeBridge(dir: string, state: BridgeState): Promise<void> {
  await saveJson(join(dir, 'bridges', `${state.sessionId}.json`), state)
}

async function busPeer(dir: string, name: string): Promise<GatewaySessionTransport> {
  const transport = new GatewaySessionTransport({
    directory: sessionsDir(dir), sessionId: randomUUID(), name, cwd: dir, purpose: 'test sender', policy: 'accept',
  })
  await transport.start()
  return transport
}

/** A bus peer with a CHOSEN session id: the bridge's, so senders can post to it. */
async function transportFor(dir: string, sessionId: string, name: string): Promise<GatewaySessionTransport> {
  const transport = new GatewaySessionTransport({
    directory: sessionsDir(dir), sessionId, name, cwd: dir, purpose: 'test bridge inbox', policy: 'accept',
  })
  await transport.start()
  return transport
}

async function primedBridge(): Promise<{ alpha: BridgeState }> {
  const alpha = bridgeNamed('alpha', THREAD_A)
  alpha.primedThreadId = THREAD_A
  alpha.primerSha256 = await primerSha()
  return { alpha }
}

const sendCount = (driver: FakeDriver): number => driver.calls.filter(call => call.op === 'send').length

const textOf = (record: { message: unknown }): string => String((record.message as { text?: unknown }).text ?? '')
const replyToOf = (record: { message: unknown }): string | undefined => (record.message as { replyTo?: string }).replyTo

/** The bus inbox says this message was acknowledged (not merely queued). */
async function acknowledged(dir: string, sessionId: string, messageId: string): Promise<boolean> {
  try {
    const raw = JSON.parse(await readFile(join(sessionsDir(dir), `${sessionId}.inbox`), 'utf8')) as { records?: { message: { id: string }; state: string }[] }
    return (raw.records ?? []).some(record => record.message.id === messageId && record.state === 'delivered')
  } catch { return false }
}

async function credentials(dir: string): Promise<{ token: string }> {
  const body = JSON.parse(await readFile(join(privateHome(dir), 'instances', 'test.json'), 'utf8')) as { token: string }
  return { token: body.token }
}

async function operator(host: ChatGptHost, token: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const response = await fetch(`http://127.0.0.1:${host.port}/operator`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

/**
 * Crash one host mid-turn and leave the inbound owed on the bus.
 *
 * The page takes the prompt (a user node exists), the driver then stalls, and
 * the host is stopped before its own turn clock runs out: the durable record
 * survives exactly as a killed process leaves it.
 */
async function crashMidTurn(dir: string, alpha: BridgeState, driver: FakeDriver, text: string, sender: GatewaySessionTransport): Promise<{ messageId: string; turn: any }> {
  const host = await startHost(dir, driver, { turnTimeoutMs: 60_000 })
  let messageId = ''
  try {
    const receipt = await sender.send(alpha.sessionId, text, text, undefined, 'inquiry', true) as { id: string }
    messageId = receipt.id
    await waitFor(() => (sendCount(driver) >= 1 ? true : undefined), 15_000)
    const turn = await waitFor(async () => {
      const state = await readBridge(dir, alpha.sessionId)
      const found = state.pendingTurns.find(item => item.messageId === receipt.id)
      return found && found.postedAt !== null && found.userNodeId !== null ? found : undefined
    }, 15_000)
    // The ack is what keeps the record out of the drain path on restart; the
    // recoverOwed path is the one under test.
    await waitFor(async () => (await acknowledged(dir, alpha.sessionId, receipt.id) ? true : undefined), 10_000)
    return { messageId, turn }
  } finally {
    await host.stop()
    driver.dead = true
  }
}

describe('R7-1: settlePostedTurn is symmetric with resumePendingTurns', () => {
  test('a posted turn whose node is already in ourNodeIds is settled from the page, never re-posted', async () => {
    const { dir, cleanup } = await scratch()
    const { alpha } = await primedBridge()
    await seedHost(dir, [alpha])
    const sender = await busPeer(dir, 'sender')
    const driverA = new FakeDriver()
    driverA.observable = true
    driverA.stallFor = () => true
    let messageId = ''
    let turn: any = null
    try {
      const crashed = await crashMidTurn(dir, alpha, driverA, 'symmetry probe', sender)
      messageId = crashed.messageId
      turn = crashed.turn
    } finally {
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    try {
      // The page finished the turn after the crash. Its user node was already
      // adopted into ourNodeIds by the crashed host; only the per-turn node id
      // was never written back (the exact R7-1 shape).
      const driverB = new FakeDriver()
      driverB.observable = true
      const nodeId = driverB.humanTypes(THREAD_A, turn.ourText, 'the page answered while nobody watched')
      const durable = await readBridge(dir, alpha.sessionId)
      await writeBridge(dir, { ...durable, ourNodeIds: [nodeId], pendingTurns: [{ ...turn, userNodeId: null }] })

      const hostB = await startHost(dir, driverB)
      try {
        const replies = () => sender.inbox().filter(record => replyToOf(record) === messageId)
        await waitFor(() => (replies().length >= 1 ? true : undefined), 20_000)
        await new Promise(resolve => setTimeout(resolve, 400))
        expect(replies().length).toBe(1)
        // RED on d9836b6: the includeOwned=false lookup treats the already-ours
        // node as absent, recoverOwed re-posts, and the driver sees a second send.
        expect(sendCount(driverB)).toBe(0)
        // The answer came from the page's finished turn, not from a re-typed prompt.
        expect(textOf(replies()[0]!)).toContain('the page answered while nobody watched')
        expect((await readBridge(dir, alpha.sessionId)).pendingTurns.some(item => item.messageId === messageId)).toBe(false)
      } finally {
        await hostB.stop()
      }
    } finally {
      await sender.close()
      await cleanup()
    }
  }, 60_000)
})

describe('R7-2: a crash after markAnswered but before the reply', () => {
  test('the marked answer is delivered exactly once from the page and nothing is typed', async () => {
    const { dir, cleanup } = await scratch()
    const { alpha } = await primedBridge()
    await seedHost(dir, [alpha])
    const sender = await busPeer(dir, 'sender')
    const driverA = new FakeDriver()
    driverA.observable = true
    driverA.stallFor = () => true
    let messageId = ''
    let turn: any = null
    try {
      const crashed = await crashMidTurn(dir, alpha, driverA, 'marked but unsent', sender)
      messageId = crashed.messageId
      turn = crashed.turn
    } finally {
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    try {
      const driverB = new FakeDriver()
      driverB.observable = true
      driverB.seedUserTurn(THREAD_A, turn.userNodeId, turn.ourText, 'the answer obtained before the crash')
      const durable = await readBridge(dir, alpha.sessionId)
      // The write-ahead mark is on disk; the transport history has NO sent
      // reply for this message (the crash landed between the two).
      await writeBridge(dir, {
        ...durable,
        answeredTurns: [...durable.answeredTurns, `m:${messageId}`, `u:${turn.userNodeId}`],
        pendingTurns: [turn],
      })

      const hostB = await startHost(dir, driverB)
      try {
        const replies = () => sender.inbox().filter(record => replyToOf(record) === messageId)
        await waitFor(() => (replies().length >= 1 ? true : undefined), 20_000)
        await new Promise(resolve => setTimeout(resolve, 400))
        // Delivered once, from the page, with no second page turn.
        expect(replies().length).toBe(1)
        expect(textOf(replies()[0]!)).toContain('the answer obtained before the crash')
        expect(sendCount(driverB)).toBe(0)
        expect((await readBridge(dir, alpha.sessionId)).pendingTurns.some(item => item.messageId === messageId)).toBe(false)
      } finally {
        await hostB.stop()
      }
    } finally {
      await sender.close()
      await cleanup()
    }
  }, 60_000)
})

describe('R7-3: a crash after the reply but before the turn was retired', () => {
  test('an already-sent turn is retired on restart with no second send and no second line', async () => {
    const { dir, cleanup } = await scratch()
    const { alpha } = await primedBridge()
    await seedHost(dir, [alpha])
    const sender = await busPeer(dir, 'sender')
    const driverA = new FakeDriver()
    driverA.observable = true
    let messageId = ''
    let promptText = ''
    const hostA = await startHost(dir, driverA)
    try {
      const receipt = await sender.send(alpha.sessionId, 'answered then retired', 'answered then retired', undefined, 'inquiry', true) as { id: string }
      messageId = receipt.id
      const replies = () => sender.inbox().filter(record => replyToOf(record) === messageId)
      await waitFor(() => (replies().length >= 1 ? true : undefined), 20_000)
      promptText = String((driverA.calls.find(call => call.op === 'send') ?? {}).text ?? '')
      expect(promptText.length).toBeGreaterThan(0)
    } finally {
      await hostA.stop()
    }
    try {
      const durable = await readBridge(dir, alpha.sessionId)
      // Reconstruct the crash shape: the sent reply is on the bus, the mark is
      // durable, and an older write still carries the pending turn.
      await writeBridge(dir, {
        ...durable,
        pendingTurns: [{
          threadId: THREAD_A,
          userNodeId: null,
          ourText: promptText.slice(0, 4096),
          text: promptText,
          senderSessionId: sender.peer.sessionId,
          messageId,
          kind: 'inquiry',
          postedAt: new Date(Date.now() - 60_000).toISOString(),
        }],
      })
      const driverB = new FakeDriver()
      driverB.observable = true
      const hostB = await startHost(dir, driverB)
      try {
        await hostB.pollOnce()
        await new Promise(resolve => setTimeout(resolve, 400))
        const replies = () => sender.inbox().filter(record => replyToOf(record) === messageId)
        expect(replies().length).toBe(1)
        expect(sendCount(driverB)).toBe(0)
        expect((await readBridge(dir, alpha.sessionId)).pendingTurns.some(item => item.messageId === messageId)).toBe(false)
      } finally {
        await hostB.stop()
      }
    } finally {
      await sender.close()
      await cleanup()
    }
  }, 60_000)
})

describe('R7-4: a driver fault after the send must not erase postedAt', () => {
  test('the accepted send keeps postedAt and is typed exactly once', async () => {
    const { dir, cleanup } = await scratch()
    const { alpha } = await primedBridge()
    await seedHost(dir, [alpha])
    const sender = await busPeer(dir, 'sender')
    const driver = new FakeDriver()
    driver.observable = true
    driver.failSendAfterAccept = true
    let messageId = ''
    const host = await startHost(dir, driver, { turnTimeoutMs: 2_000 })
    try {
      const receipt = await sender.send(alpha.sessionId, 'typed then the driver timed out', 'typed then the driver timed out', undefined, 'inquiry', true) as { id: string }
      messageId = receipt.id
      await waitFor(() => (sendCount(driver) >= 1 ? true : undefined), 15_000)
      const owed = await waitFor(async () => {
        const state = await readBridge(dir, alpha.sessionId)
        return state.pendingTurns.find(item => item.messageId === messageId)
      }, 10_000)
      await new Promise(resolve => setTimeout(resolve, 500))
      const after = await readBridge(dir, alpha.sessionId)
      const persisted = after.pendingTurns.find(item => item.messageId === messageId)!
      expect(persisted).toBeTruthy()
      // RED on d9836b6: postRecordedTurn treats "pageTurnAsync threw" as "never
      // posted" and clears postedAt, so the recovery path re-types the prompt.
      expect(persisted.postedAt).not.toBe(null)
      // The page took the text once; a fault after the send does not re-type it.
      expect(sendCount(driver)).toBe(1)
      expect(owed.messageId).toBe(messageId)
    } finally {
      await host.stop()
      await sender.close()
      await cleanup()
    }
  }, 40_000)
})

describe('R7-5: removal at the last await before the send', () => {
  test('a bridge removed during the pre-send read types nothing', async () => {
    const { dir, cleanup } = await scratch()
    const { alpha } = await primedBridge()
    await seedHost(dir, [alpha])
    const sender = await busPeer(dir, 'sender')
    const driver = new FakeDriver()
    driver.observable = true
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    let entered: () => void = () => {}
    const blocked = new Promise<void>(resolve => { entered = resolve })
    driver.blockConversation = gate
    driver.conversationBlocked = entered
    const host = await startHost(dir, driver)
    try {
      const token = (await credentials(dir)).token
      await sender.send(alpha.sessionId, 'remove me before the send', 'remove me before the send', undefined, 'inquiry', true)
      await waitFor(() => Promise.resolve(driver.conversationReads > 0 ? true : undefined), 15_000).catch(() => undefined)
      // Wait until the pre-send read is actually blocked.
      await blocked
      const removed = await operator(host, token, { op: 'remove', sessionId: alpha.sessionId })
      expect(removed.status).toBe(200)
      release()
      await new Promise(resolve => setTimeout(resolve, 800))
      // RED on d9836b6: the removal check runs before the snapshot read, so the
      // send still reaches the driver after the bridge is gone.
      expect(sendCount(driver)).toBe(0)
    } finally {
      release()
      await host.stop()
      await sender.close()
      await cleanup()
    }
  }, 40_000)
})

describe('R7-6: the delivery ledger is permanent past its cap', () => {
  test('the oldest delivered index is still refused after the ledger crosses its cap', async () => {
    const { dir, cleanup } = await scratch()
    const { alpha } = await primedBridge()
    const driver = new FakeDriver()
    driver.observable = true
    driver.openThread(THREAD_A)
    const target = driver.pageNode(THREAD_A, 'the old answer', [{ id: 'file_0123456789abcdef', name: 'target.txt' }])
    const extra = driver.pageNode(THREAD_A, 'a newer answer', [{ id: 'file_fedcba9876543210', name: 'extra.txt' }])
    // The durable ledger is exactly at its schema cap, with the target oldest.
    const ledger = [{ nodeId: target, bytes: 11, indexes: [0] }]
    for (let index = 0; index < 4095; index++) ledger.push({ nodeId: `d${index}`, bytes: 1, indexes: [0] })
    alpha.deliveredNodes = ledger as any
    alpha.deliveredFiles = []
    await seedHost(dir, [alpha])
    const listener = await busPeer(dir, 'listener')
    const host = await startHost(dir, driver)
    try {
      const token = (await credentials(dir)).token
      // One more real delivery: this is the append that crosses the cap and
      // drops the oldest ledger entry at recordDelivered.
      const first = await operator(host, token, { op: 'files', bridge: alpha.sessionId, to: listener.peer.sessionId, nodeId: extra, indexes: [0] })
      expect(first.status).toBe(200)
      expect(first.body.files.length).toBe(1)

      const second = await operator(host, token, { op: 'files', bridge: alpha.sessionId, to: listener.peer.sessionId, nodeId: target, indexes: [0] })
      expect(second.status).toBe(200)
      // RED on d9836b6: the ledger was trimmed, so the pair is not remembered:
      // the file is fetched again and delivered a second time (a new sibling).
      expect(String(second.body.refused.join(' '))).toContain('already delivered')
      expect(second.body.files.length).toBe(0)
      expect(driver.fileCalls.filter(call => call.fileId === 'file_0123456789abcdef').length).toBe(0)
    } finally {
      await host.stop()
      await listener.close()
      await cleanup()
    }
  }, 60_000)
})

describe('R7-7: the inbound run marker survives the inbound-runs cap', () => {
  test('a replay of an inbound whose marker was evicted by a later turn runs no command', async () => {
    const { dir, cleanup } = await scratch()
    const { alpha } = await primedBridge()
    await seedHost(dir, [alpha])
    const sender = await busPeer(dir, 'sender')
    const listener = await busPeer(dir, 'listener')

    // Deliver two inbounds into the bridge's own inbox and acknowledge both, so
    // the restart handles them through recoverOwed (in inbox order), not drain.
    const alphaInbox = await transportFor(dir, alpha.sessionId, 'alpha')
    let firstId = ''
    let originalId = ''
    try {
      const first = await sender.send(alpha.sessionId, 'FIRST-INBOUND: run the first one', 'FIRST-INBOUND', undefined, 'inquiry', true) as { id: string }
      const original = await sender.send(alpha.sessionId, 'ORIGINAL-INBOUND: already ran once', 'ORIGINAL-INBOUND', undefined, 'inquiry', true) as { id: string }
      firstId = first.id
      originalId = original.id
      await alphaInbox.acknowledge(firstId)
      await alphaInbox.acknowledge(originalId)
    } finally {
      await alphaInbox.close()
    }

    // The maximum representable state: the original's run marker plus 199 newer
    // (the schema caps inboundRuns at 200, so a 201-entry file is refused).
    const runs = [{ messageId: originalId, results: [], at: new Date().toISOString() }]
    for (let index = 0; index < 199; index++) runs.push({ messageId: randomUUID(), results: [], at: new Date().toISOString() })
    const durable = await readBridge(dir, alpha.sessionId)
    await writeBridge(dir, { ...durable, pendingTurns: [], inboundRuns: runs as any })

    const driver = new FakeDriver()
    driver.observable = true
    // The regenerated command carries a NEW nonce, so only the inbound-run
    // marker can refuse it - the per-command receipt key cannot (R1-F9).
    driver.answerFor = request => {
      const text = String(request.text ?? '')
      const nonce = /"nonce":"([0-9a-f]{8})"/.exec(text)?.[1]
      if (!nonce) return 'done'
      if (text.includes('FIRST-INBOUND')) return rendered({ nonce, op: 'send', to: 'listener', text: 'first side effect' })
      if (text.includes('ORIGINAL-INBOUND')) return rendered({ nonce, op: 'send', to: 'listener', text: 'original side effect' })
      return 'done'
    }
    const host = await startHost(dir, driver)
    try {
      const replies = (id: string) => sender.inbox().filter(record => replyToOf(record) === id)
      await waitFor(() => (replies(firstId).length >= 1 && replies(originalId).length >= 1 ? true : undefined), 30_000)
      await new Promise(resolve => setTimeout(resolve, 400))
      const effects = listener.inbox().map(textOf)
      // The first inbound runs: the flow is live.
      expect(effects.some(text => text.includes('first side effect'))).toBe(true)
      // RED on d9836b6: the first turn's append pushes the marker out of the
      // 200-entry cap, so the original's replay looks brand new and dispatches.
      expect(effects.some(text => text.includes('original side effect'))).toBe(false)
    } finally {
      await host.stop()
      await sender.close()
      await listener.close()
      await cleanup()
    }
  }, 60_000)
})
