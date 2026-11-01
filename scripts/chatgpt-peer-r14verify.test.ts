/**
 * R14 verification: independent checks of the landed settle path at 80ce9f9.
 *
 * Written from the defect report and the behaviour it states, NOT from the
 * fix. Three shapes:
 *
 *  1. ROUND 2 IS A REAL PAGE TURN. A deferred job (postedAt null, carrying its
 *     turnNonce) whose page answer is one permitted command must not settle by
 *     re-reading the answered node. The command result lines go back to the
 *     page as a SECOND page send, and the sender gets the round-2 prose plus
 *     the receipt. Round 1 costs exactly one page turn.
 *  2. A STALE NONCE IS REFUSED BY NAME ON THE SETTLE PATH. A deferred answer
 *     whose command carries a different nonce runs nothing, and the sender's
 *     reply names the refusal - never a neutral "nothing was sent", never the
 *     fence text.
 *  3. RETIRE NEEDS A SENT ENTRY. A reply whose transport send throws is not a
 *     delivery: the pending turn stays in `pendingTurns` and the next pass
 *     settles it from page evidence (a retry, not a re-post) exactly once.
 *
 * The page driver is the frozen line-JSON protocol, in memory. No network, no
 * browser, no live host.
 */
import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GatewaySessionTransport } from '../src/utils/gatewaySessionTransport.js'
import { ChatGptHost } from './chatgpt-peer.ts'
import type { DriverChild, DriverReply } from './chatgpt-peer/driver.ts'
import { newBridgeState, newHostState, saveJson, type BridgeState } from './chatgpt-peer/state.ts'

const THREAD_A = '11111111-1111-4111-8111-111111111111'
const THREAD_B = '22222222-2222-4222-8222-222222222222'

type Call = Record<string, unknown>

/** The frozen child protocol, in memory. One page, one active thread. */
class FakeDriver {
  readonly calls: Call[] = []
  threads = [{ id: THREAD_A, title: 'Existing work' }, { id: THREAD_B, title: 'Other work' }]
  killed = false
  answer = 'answered on the page'
  sendText = 'answered on the page'
  sendTextFor: ((request: Call) => string) | undefined
  answerFor: ((request: Call) => string | undefined) | undefined
  evidence = 'state-complete'
  readError: string | null = null
  readCalls = 0
  signal: { phase: string | null; threadId: string | null; at: number | null } = { phase: 'complete', threadId: null, at: null }
  generating = false
  refuseSend = false
  busyUntil = 0
  readonly sentAtMs: number[] = []
  stallFor: ((request: Call) => boolean) | undefined
  landOn: string | null = null
  sendError: string | null = null
  private readonly listeners = new Set<(event: Record<string, unknown>) => void>()
  private current: string | null = null
  observable = false
  readonly deleted = new Set<string>()
  conversationReads = 0
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

  emit(event: Record<string, unknown>): void { for (const listener of this.listeners) listener(event) }

  async call(request: Call, options?: number | { onAccepted?: (id: string) => void }): Promise<DriverReply> {
    if (String(request.op ?? '') === 'ping') return { ok: true, op: 'ping' }
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
    if (op === 'reload') {
      const threadId = String(request.threadId ?? '')
      this.current = threadId || this.current
      return { ok: true, op, threadId: this.current }
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
      this.grow(threadId, 'user', String(request.text ?? ''))
      if (!stalls) this.grow(threadId, 'assistant', this.answer)
      this.signal = { phase: stalls ? 'streaming' : 'complete', threadId, at: Date.now() }
      this.sentAtMs.push(Date.now())
      onAccepted?.(String(request.id ?? ''))
      if (request.wait === true && stalls) return { ok: false, op, reason: 'timeout', timedOut: true, state: 'generating', threadId }
      return { ok: true, op, text: this.sendTextFor?.(request) ?? this.answer, threadId, model: 'GPT-6', effort: 'High' }
    }
    if (op === 'read') {
      this.readCalls++
      if (this.readError) return { ok: false, op, error: this.readError }
      return { ok: true, op, threadId: this.current, text: this.answer, evidence: this.evidence }
    }
    if (op === 'conversation' && this.observable) {
      this.conversationReads++
      const threadId = String(request.threadId ?? '')
      if (this.deleted.has(threadId)) return { ok: false, op, status: 404, error: 'conversation not found' }
      const tree = this.treeOf(threadId)
      return { ok: true, op, conversation: { current_node: tree.current, mapping: structuredClone(tree.mapping) } }
    }
    if (op === 'conversations' && this.observable) {
      const offset = Number(request.offset ?? 0)
      const limit = Number(request.limit ?? 100)
      return { ok: true, op, items: this.threads.filter(thread => !this.deleted.has(thread.id)).slice(offset, offset + limit) }
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
      const outPath = String(request.outPath ?? '')
      if (!request.fileId && !(request.threadId && request.messageId && request.sandboxPath)) return { ok: false, op, reason: 'bad-id' }
      const body = `bytes of ${String(request.fileId ?? request.sandboxPath)}`
      try { await writeFile(outPath, body, { flag: 'wx' }) }
      catch (error) { return { ok: false, op, reason: (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'exists' : 'io' } }
      return { ok: true, op, path: outPath, bytes: Buffer.byteLength(body), sha256: sha256(body) }
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

async function scratch(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-peer-r14v-'))
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
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const bridgeNamed = (name: string, threadId: string | null): BridgeState =>
  newBridgeState({ sessionId: randomUUID(), name, threadId })

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

const primerSha = async (): Promise<string> =>
  sha256(await readFile(join(import.meta.dir, 'chatgpt-peer', 'primer.md'), 'utf8'))

async function readBridge(dir: string, sessionId: string): Promise<BridgeState> {
  return JSON.parse(await readFile(join(dir, 'bridges', `${sessionId}.json`), 'utf8')) as BridgeState
}

async function hostAudit(dir: string): Promise<{ op: string; target: string | null; result: string; messageId?: string }[]> {
  const state = JSON.parse(await readFile(join(dir, 'peer.json'), 'utf8')) as { audit: { op: string; target: string | null; result: string; messageId?: string }[] }
  return state.audit
}

/** A primed bridge: its primer is already posted, so a call log starts empty. */
async function primed(name: string, threadId: string): Promise<BridgeState> {
  const bridge = bridgeNamed(name, threadId)
  bridge.primedThreadId = threadId
  bridge.primerSha256 = await primerSha()
  return bridge
}

/** A real bus peer in the scratch directory, addressed by a live registration. */
async function busPeer(dir: string, name: string): Promise<GatewaySessionTransport> {
  const transport = new GatewaySessionTransport({
    directory: sessionsDir(dir),
    sessionId: randomUUID(),
    name,
    cwd: dir,
    purpose: 'test peer',
    policy: 'accept',
  })
  await transport.start()
  return transport
}

type PeerMessage = { id: string; replyTo?: string; fromSessionId: string; toSessionId: string; text: string; summary: string }

const inboxMessages = (transport: GatewaySessionTransport): PeerMessage[] =>
  transport.inbox().map(record => record.message as unknown as PeerMessage)

const sendsIn = (driver: FakeDriver, from: number): Call[] =>
  driver.calls.slice(from).filter(call => call.op === 'send')

const replyFor = (sender: GatewaySessionTransport, messageId: string): PeerMessage | undefined =>
  inboxMessages(sender).find(message => message.replyTo === messageId)

/** The rendered command block the page hands back: label line, then the object. */
const rendered = (fields: Record<string, unknown>): string => 'gateway\n' + JSON.stringify(fields)

/** A deferred job: written down before the page was asked, never typed. */
function deferredJob(args: {
  messageId: string
  senderSessionId: string
  nonce: string
  text?: string
}): Record<string, unknown> {
  return {
    threadId: THREAD_A,
    userNodeId: null,
    ourText: args.text ?? 'count the peers',
    text: args.text ?? 'count the peers',
    senderSessionId: args.senderSessionId,
    messageId: args.messageId,
    kind: 'inquiry',
    postedAt: null,
    turnNonce: args.nonce,
  }
}

describe('R14 verification: the settle path at 80ce9f9', () => {
  // Row 1: round 2 is a real page turn --------------------------------------
  test('1. a deferred command turn sends round 2 as a new page turn and delivers the round-2 prose', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primed('alpha', THREAD_A)
    const sender = await busPeer(dir, 'sender')
    const messageId = randomUUID()
    const nonce = 'c0ffee42'
    // Round 1: the page asks for one permitted command.
    const firstAnswer = `checking the bus.\n\ngateway\n${JSON.stringify({ nonce, op: 'list' })}`
    // Round 2: the result lines came back; the model continues in prose.
    const secondAnswer = 'Round two: the peer list is in and there is nothing else to do.'
    const isFirstPost = (request: Call): boolean => String(request.text ?? '') === 'count the peers'
    alpha.pendingTurns = [deferredJob({ messageId, senderSessionId: sender.peer.sessionId, nonce })] as any
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.observable = true
    driver.answerFor = request => isFirstPost(request) ? firstAnswer : secondAnswer
    driver.sendTextFor = request => isFirstPost(request) ? firstAnswer : secondAnswer
    const host = await startHost(dir, driver)
    try {
      const before = driver.calls.length
      await host.pollOnce()

      const sends = sendsIn(driver, before)
      // Round 1 costs exactly ONE page turn - the deferred job itself - and
      // round 2 is a REAL new page turn carrying the result lines. A path that
      // re-reads the round-1 answer to feed round 2 produces one send and the
      // loop then refuses the repeat as "already ran".
      expect(sends.length).toBe(2)
      expect(sends.filter(call => String(call.text) === 'count the peers').length).toBe(1)
      expect(String(sends[1]!.text)).toMatch(/^BUS RESULT/)
      expect(String(sends[1]!.text)).toContain('sender')

      const reply = await waitFor(() => replyFor(sender, messageId), 8_000)
      // The sender gets the model's follow-up prose, beside the receipt.
      expect(reply.text).toContain('Round two')
      expect(reply.text).toContain('(from the page')
      await delay(200)
      expect(inboxMessages(sender).filter(message => message.replyTo === messageId).length).toBe(1)
      expect((await readBridge(dir, alpha.sessionId)).pendingTurns).toEqual([])
    } finally {
      await sender.close().catch(() => {})
      await host.stop().catch(() => {})
      await cleanup()
    }
  }, 30_000)

  // Row 2: stale nonce on the settle path -----------------------------------
  test('2. a stale nonce in a deferred answer runs nothing and the sender is told why', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primed('alpha', THREAD_A)
    const sender = await busPeer(dir, 'sender')
    const messageId = randomUUID()
    // The job carries its own credential; the page answers with a block quoting
    // a DIFFERENT one, which must never execute.
    const nonce = 'c0ffee42'
    const stale = rendered({ nonce: 'deadbeef', op: 'schedule', label: 'r14v-stale-deferred', inSeconds: 600 })
    alpha.pendingTurns = [deferredJob({ messageId, senderSessionId: sender.peer.sessionId, nonce, text: 'quote an old block' })] as any
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.observable = true
    // The page repeats the stale block on every round of the turn, so the last
    // thing it produced is still an action that could not run.
    driver.answerFor = () => stale
    driver.sendTextFor = () => stale
    const host = await startHost(dir, driver)
    try {
      await host.pollOnce()
      const reply = await waitFor(() => replyFor(sender, messageId), 8_000)
      // Exactly one reply, and it is a refusal - not the neutral body, not the
      // fence the model printed.
      await delay(200)
      const mine = inboxMessages(sender).filter(message => message.replyTo === messageId)
      expect(mine.length).toBe(1)
      expect(reply.text).not.toContain('command block only')
      expect(reply.text).not.toContain('"nonce":"deadbeef"')
      // It names the refusal, which is the nonce it would not accept.
      expect(reply.text.toLowerCase()).toContain('nonce')
      // Nothing ran.
      const stored = await readBridge(dir, alpha.sessionId)
      expect(stored.schedules.map(schedule => schedule.label)).not.toContain('r14v-stale-deferred')
      const audit = await hostAudit(dir)
      expect(audit.some(entry => entry.op === 'schedule' && entry.messageId === messageId)).toBe(false)
    } finally {
      await sender.close().catch(() => {})
      await host.stop().catch(() => {})
      await cleanup()
    }
  }, 40_000)

  // Row 3: durability - retire only after a sent entry ----------------------
  test('3. a reply that cannot be sent stays pending and is retried, without a re-post', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primed('alpha', THREAD_A)
    const sender = await busPeer(dir, 'sender')
    const messageId = randomUUID()
    const nonce = 'c0ffee42'
    alpha.pendingTurns = [deferredJob({ messageId, senderSessionId: sender.peer.sessionId, nonce, text: 'answer this later' })] as any
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.observable = true
    driver.answerFor = () => 'the deferred page answer'
    driver.sendTextFor = () => 'the deferred page answer'
    const host = await startHost(dir, driver)
    // The host's own transport is the only way a reply can leave. Hold it
    // closed until the test says otherwise.
    const bridge = [...(host as unknown as { bridges: Map<string, { transport: GatewaySessionTransport }> }).bridges.values()][0]!
    const transport = bridge.transport!
    const realSend = transport.send.bind(transport)
    let allowSend = false
    transport.send = (async (...args: Parameters<GatewaySessionTransport['send']>) => {
      if (!allowSend) throw new Error('simulated transport failure')
      return realSend(...args)
    }) as GatewaySessionTransport['send']
    try {
      const before = driver.calls.length
      await host.pollOnce()

      // The post happened (one page turn) but the reply did not leave, so the
      // turn is still owed: no bus entry for it and the job is still on disk.
      expect(sendsIn(driver, before).length).toBe(1)
      expect(replyFor(sender, messageId)).toBeUndefined()
      const stuck = await readBridge(dir, alpha.sessionId)
      expect(stuck.pendingTurns.map(turn => turn.messageId)).toContain(messageId)

      // Clear the fault. The next pass must settle from the page's evidence -
      // not type the prompt again - and retire only once the sent entry exists.
      allowSend = true
      await host.pollOnce()
      const reply = await waitFor(() => replyFor(sender, messageId), 8_000)
      expect(reply.text).toBe('the deferred page answer')
      await delay(200)
      expect(inboxMessages(sender).filter(message => message.replyTo === messageId).length).toBe(1)
      expect((await readBridge(dir, alpha.sessionId)).pendingTurns).toEqual([])
      // One page turn for the whole job: the retry read the page, it did not
      // post the prompt a second time.
      expect(sendsIn(driver, before).length).toBe(1)
    } finally {
      await sender.close().catch(() => {})
      await host.stop().catch(() => {})
      await cleanup()
    }
  }, 30_000)
})
