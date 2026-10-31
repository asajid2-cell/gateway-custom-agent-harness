/**
 * R13: one way in, one way out.
 *
 * The operator surface and the peer bus must not be two doors onto the same
 * page. The operator drives lifecycle only; a peer reaches the page by sending
 * a message on the bus, and the page's answer comes back as a bus reply tied to
 * that message. This suite pins the CONTRACT (not any fix):
 *
 *  1. `prompt` is gone from `/operator`: 410, an error naming the bus and the
 *     bridge's own session id, and no Send is ever tapped.
 *  2. `wait` and `files` are gone the same way: 410, no Send, no bus message to
 *     any peer.
 *  3. The old aliases (`send`, `ask`, `turn`, `read`, `reply`) are refused with
 *     the allowed-op list, never executed as bus commands.
 *  4. Every op the operator still accepts is enumerated: none may type into a
 *     peer thread, and an attach may only travel into the bridge's OWN thread.
 *  5. A bus inquiry gets exactly one reply addressed to the sender, carrying
 *     the page's words (not a gist-only stub for a short answer).
 *  6. A page that refuses - live, or through the pending-TTL path - still
 *     answers the sender exactly once. Silence is the defect.
 *
 * No network, no browser. The page driver is a fake that answers the frozen
 * line-JSON ops in memory; every bus registration is real, in a scratch
 * directory.
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
const THREAD_C = '33333333-3333-4333-8333-333333333333'

type Call = Record<string, unknown>

/** The frozen child protocol, in memory. One page, one active thread. */
class FakeDriver {
  readonly calls: Call[] = []
  threads = [{ id: THREAD_A, title: 'Existing work' }, { id: THREAD_B, title: 'Other work' }]
  killed = false
  answer = 'answered on the page'
  sendText = 'answered on the page'
  sendTextFor: ((request: Call) => string) | undefined
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
  answerFor: ((request: Call) => string | undefined) | undefined
  private readonly listeners = new Set<(event: Record<string, unknown>) => void>()
  private current: string | null = null
  observable = false
  readonly deleted = new Set<string>()
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

  /** The person types in the thread directly; the model answers. Returns the user node id. */
  humanTypes(threadId: string, text: string, answer: string): string {
    const id = this.grow(threadId, 'user', text)
    this.grow(threadId, 'assistant', answer)
    return id
  }

  userNodes(threadId: string): { id: string; text: string }[] {
    return Object.values(this.treeOf(threadId).mapping)
      .filter((node: any) => node.message?.author.role === 'user')
      .map((node: any) => ({ id: node.id, text: String(node.message.content.parts[0]) }))
  }

  newestId(threadId: string): string { return this.treeOf(threadId).current }

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
      // `wait:true` promises the answer on this request. A turn that is still
      // streaming has none: the real child reports `timedOut` instead of
      // returning stale text, so the host must leave the turn owed.
      if (request.wait === true && stalls) return { ok: false, op, reason: 'timeout', timedOut: true, state: 'generating', threadId }
      return { ok: true, op, text: this.sendTextFor?.(request) ?? this.answer, threadId, model: 'GPT-6', effort: 'High' }
    }
    if (op === 'read') {
      this.readCalls++
      if (this.readError) return { ok: false, op, error: this.readError }
      return { ok: true, op, threadId: this.current, text: this.answer, evidence: this.evidence }
    }
    if (op === 'conversation' && this.observable) {
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

/** The newest assistant node on the visible branch, skipping thought/recap nodes. */
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
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-peer-r13-'))
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

async function credentials(dir: string): Promise<{ token: string; sessionIds: string[] }> {
  const body = JSON.parse(await readFile(join(privateHome(dir), 'instances', 'test.json'), 'utf8')) as { token: string; sessionIds?: string[] }
  return { token: body.token, sessionIds: body.sessionIds ?? [] }
}

async function operator(host: ChatGptHost, token: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const response = await fetch(`http://127.0.0.1:${host.port}/operator`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

async function operatorState(host: ChatGptHost, token: string): Promise<any> {
  const response = await fetch(`http://127.0.0.1:${host.port}/operator/state`, { headers: { authorization: `Bearer ${token}` } })
  return response.json()
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

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const bridgeNamed = (name: string, threadId: string | null): BridgeState =>
  newBridgeState({ sessionId: randomUUID(), name, threadId })

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

const primerSha = async (): Promise<string> =>
  sha256(await readFile(join(import.meta.dir, 'chatgpt-peer', 'primer.md'), 'utf8'))

async function readBridge(dir: string, sessionId: string): Promise<BridgeState> {
  return JSON.parse(await readFile(join(dir, 'bridges', `${sessionId}.json`), 'utf8')) as BridgeState
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

describe('R13 operator surface: one path in', () => {
  // Row 1 -------------------------------------------------------------------
  test('1. prompt is gone from /operator: 410 naming the bus and the bridge, never a Send', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primed('alpha', THREAD_A)
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    const host = await startHost(dir, driver)
    try {
      const { token } = await credentials(dir)
      const before = driver.calls.length
      const result = await operator(host, token, { op: 'prompt', bridge: alpha.sessionId, text: 'say hello' })

      expect(result.status).toBe(410)
      const error = String(result.body?.error ?? '')
      // The refusal names the bus and the one address a peer may use.
      expect(error).toMatch(/gateway/i)
      expect(error).toContain(alpha.sessionId)
      // It never reads like a turn that happened.
      expect(JSON.stringify(result.body)).not.toContain('page answered')

      // The old door never tapped the composer.
      expect(sendsIn(driver, before).length).toBe(0)
    } finally {
      await host.stop()
      await cleanup()
    }
  })

  // Row 2 -------------------------------------------------------------------
  test('2. wait and files are gone too: 410 each, no Send, no bus message for any peer', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primed('alpha', THREAD_A)
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    const host = await startHost(dir, driver)
    const listener = await busPeer(dir, 'listener')
    try {
      const { token } = await credentials(dir)
      const before = driver.calls.length
      const bodies = [
        { op: 'wait', bridge: alpha.sessionId, timeoutMs: 1000 },
        { op: 'files', bridge: alpha.sessionId, to: listener.peer.sessionId },
      ]
      for (const body of bodies) {
        const result = await operator(host, token, body)
        expect(result.status).toBe(410)
        expect(String(result.body?.error ?? '')).toMatch(/gateway/i)
        expect(JSON.stringify(result.body)).not.toContain('page answered')
      }
      // Neither op typed into the page.
      expect(sendsIn(driver, before).length).toBe(0)
      // And neither left a message on any peer's bus.
      expect(inboxMessages(listener).length).toBe(0)
      const state = await operatorState(host, token)
      const view = state.bridges.find((bridge: any) => bridge.sessionId === alpha.sessionId)
      expect(view?.inbox ?? []).toEqual([])
    } finally {
      await listener.close()
      await host.stop()
      await cleanup()
    }
  })

  // Row 3 -------------------------------------------------------------------
  test('3. the old aliases are refused with the real op list, never run as bus commands', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primed('alpha', THREAD_A)
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    const host = await startHost(dir, driver)
    const listener = await busPeer(dir, 'listener')
    try {
      const { token } = await credentials(dir)
      const before = driver.calls.length
      const allowed = ['threads', 'adopt', 'newBridge', 'remove', 'status', 'recover', 'thread', 'attachTranscript', 'attachFile']
      for (const op of ['send', 'ask', 'turn', 'read', 'reply']) {
        const result = await operator(host, token, { op, bridge: alpha.sessionId })
        expect(result.status).toBe(400)
        const error = String(result.body?.error ?? '')
        // The refusal names the bus...
        expect(error).toMatch(/bus/i)
        // ...and lists what the operator really accepts.
        const named = allowed.filter(name => error.includes(name))
        expect(named.length).toBeGreaterThanOrEqual(2)
      }
      // No alias reached the page or the bus.
      expect(sendsIn(driver, before).length).toBe(0)
      expect(inboxMessages(listener).length).toBe(0)
    } finally {
      await listener.close()
      await host.stop()
      await cleanup()
    }
  })

  // Row 4 -------------------------------------------------------------------
  test('4. every op still accepted is enumerated: none types into a peer thread; an attach only reaches its own', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primed('alpha', THREAD_A)
    const beta = await primed('beta', THREAD_B)
    const gamma = bridgeNamed('gamma', null)
    await seedHost(dir, [alpha, beta, gamma])
    const driver = new FakeDriver()
    driver.threads.push({ id: THREAD_C, title: 'Third work' })
    // A rollout for alpha so attachTranscript has something real to upload, and
    // a small file for attachFile.
    await mkdir(join(dir, 'projects', 'proj'), { recursive: true })
    await writeFile(join(dir, 'projects', 'proj', `${alpha.sessionId}.jsonl`), '{"type":"summary"}\n')
    const notePath = join(dir, 'note.txt')
    await writeFile(notePath, 'attachment body\n')
    const host = await startHost(dir, driver)
    try {
      const { token } = await credentials(dir)
      const ops: { label: string; body: Record<string, unknown> }[] = [
        { label: 'threads', body: { op: 'threads' } },
        { label: 'status', body: { op: 'status', bridge: alpha.sessionId } },
        { label: 'recover', body: { op: 'recover', bridge: alpha.sessionId } },
        { label: 'thread', body: { op: 'thread', bridge: alpha.sessionId, action: 'list' } },
        { label: 'attachTranscript', body: { op: 'attachTranscript', bridge: alpha.sessionId, peer: alpha.sessionId } },
        { label: 'attachFile', body: { op: 'attachFile', bridge: alpha.sessionId, path: notePath } },
        { label: 'adopt', body: { op: 'adopt', threadId: THREAD_C, name: 'third' } },
        { label: 'newBridge', body: { op: 'newBridge', name: 'fresh' } },
        { label: 'remove', body: { op: 'remove', sessionId: gamma.sessionId } },
      ]
      const foreignSends: Call[] = []
      for (const { label, body } of ops) {
        const before = driver.calls.length
        await operator(host, token, body)
        const fresh = sendsIn(driver, before)
        // No op may type into ANOTHER peer's conversation.
        foreignSends.push(...fresh.filter(send => send.threadId === THREAD_B))
        if (label === 'attachTranscript' || label === 'attachFile') {
          // An attach is a push into the bridge's own thread and nowhere else.
          for (const send of fresh) expect(send.threadId).toBe(THREAD_A)
        }
      }
      expect(foreignSends).toEqual([])
      // The bridge under test never moved off its own thread.
      expect((await readBridge(dir, alpha.sessionId)).threadId).toBe(THREAD_A)
      expect((await readBridge(dir, beta.sessionId)).threadId).toBe(THREAD_B)
    } finally {
      await host.stop()
      await cleanup()
    }
  })
})

describe('R13 bus replies: one path out', () => {
  // Row 5 -------------------------------------------------------------------
  test('5. one inquiry yields exactly one reply to that sender, carrying the page answer', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primed('alpha', THREAD_A)
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.observable = true
    driver.answer = 'The answer is forty-two.'
    const host = await startHost(dir, driver)
    const sender = await busPeer(dir, 'sender')
    try {
      const receipt = (await sender.send(alpha.sessionId, 'what is the answer?', 'answer?', undefined, 'inquiry', true)) as { id: string }
      const inboundId = receipt.id
      expect(typeof inboundId).toBe('string')

      await waitFor(() => inboxMessages(sender).find(message => message.replyTo === inboundId), 8_000)
      // Let any duplicate delivery settle before counting.
      await delay(200)
      const mine = inboxMessages(sender).filter(message => message.replyTo === inboundId)
      expect(mine.length).toBe(1)
      expect(mine[0]!.fromSessionId).toBe(alpha.sessionId)
      expect(mine[0]!.text).toContain('forty-two')
      // A short answer is handed over whole, never as a gist with a file path.
      expect(mine[0]!.text).not.toContain('Full answer:')
      expect(mine[0]!.text.trim().length).toBeGreaterThan(0)
    } finally {
      await sender.close()
      await host.stop()
      await cleanup()
    }
  })

  // Row 6 -------------------------------------------------------------------
  test('6. a refused or unanswered turn still replies exactly once; silence never wins', async () => {
    // 6a - the page refuses the send outright.
    const live = await scratch()
    {
      const alpha = await primed('alpha', THREAD_A)
      await seedHost(live.dir, [alpha])
      const driver = new FakeDriver()
      driver.sendError = 'the page refused this send'
      const host = await startHost(live.dir, driver)
      const sender = await busPeer(live.dir, 'sender')
      try {
        const receipt = (await sender.send(alpha.sessionId, 'please answer', 'please answer', undefined, 'inquiry', true)) as { id: string }
        const failure = await waitFor(() => inboxMessages(sender).find(message => message.replyTo === receipt.id), 8_000)
        expect(failure.text).toMatch(/could not answer/i)
        await delay(200)
        const mine = inboxMessages(sender).filter(message => message.replyTo === receipt.id)
        expect(mine.length).toBe(1)
      } finally {
        await sender.close()
        await host.stop()
        await live.cleanup()
      }
    }

    // 6b - a turn that was posted and never answered, driven through the TTL.
    const ttl = await scratch()
    {
      const driver = new FakeDriver()
      driver.observable = true
      const sender = await busPeer(ttl.dir, 'sender')
      const alpha = await primed('alpha', THREAD_A)
      const messageId = randomUUID()
      alpha.pendingTurns = [{
        threadId: THREAD_A,
        userNodeId: null,
        ourText: 'a question that got no answer',
        text: 'a question that got no answer',
        kind: 'inquiry',
        postedAt: new Date(Date.now() - 7 * 3600_000).toISOString(),
        senderSessionId: sender.peer.sessionId,
        messageId,
      } as any]
      await seedHost(ttl.dir, [alpha])
      const host = await startHost(ttl.dir, driver)
      try {
        await host.pollOnce()
        await host.pollOnce()
        const inbox = inboxMessages(sender)
        expect(inbox.length).toBe(1)
        expect(inbox[0]!.replyTo).toBe(messageId)
        expect(inbox[0]!.text).toMatch(/could not answer/i)
        // A second pass does not leave an extra line, and never zero.
        await host.pollOnce()
        expect(inboxMessages(sender).length).toBe(1)
        expect((await readBridge(ttl.dir, alpha.sessionId)).pendingTurns).toEqual([])
      } finally {
        await sender.close()
        await host.stop()
        await ttl.cleanup()
      }
    }
  })
})
