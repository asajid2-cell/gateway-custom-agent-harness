/**
 * Round-8 independent reproduction suite.
 *
 * Five cases, one per defect, written from the defect statements alone. Each is
 * RED at the base (main @ eac9038) for the reason the statement names, and each
 * is written to go green under a fix this file is not allowed to see. The page
 * is the frozen line-JSON driver, in memory; the bus is a real
 * GatewaySessionTransport in a scratch directory; the durable state is real
 * files the real host loads and writes. No source file and no other test file
 * is edited. Nothing here mocks the code under test.
 *
 * The cases:
 *   D1  a prompt longer than 4096 chars loses its recovery identity: `ourText`
 *       is capped at 4096 while `text` holds the whole prompt, and the whole-
 *       text matcher can never match the page's node, so recovery re-posts.
 *   D2a the whole-text matcher misses a live node whose text differs from ours
 *       only the way a page may alter it (an appended footer). The host's own
 *       node then reads back as a person typing. This is a robustness
 *       requirement, NOT the live cause: the live turn's node was nominally
 *       text-identical, so the open question is the null `create_time` (D2b).
 *   D2b the same visible failure from a different cause: the node's
 *       `create_time` is null, which both matchers require to be a number but
 *       the human-turn pass does not. This is the live-cause candidate.
 *   D3  a failed SECOND conversation read turns a verified answer into a false
 *       terminal reply ("a command block only; nothing was sent").
 *   D4  a generic exception after the page accepted, but before `posted` was
 *       assigned, clears `postedAt`, so a restart types the prompt again. The
 *       finding names "any post-acceptance error", so this raises the host's own
 *       `threadGone` (see the D4 test); it is deliberately NOT the literal
 *       `recordOurs` persist path, whose non-critical persist swallows save
 *       errors at eac9038 and so cannot throw.
 *   D6  the live shape: the cursor has already moved PAST the pending send node
 *       (it was mis-classified as a human turn on an earlier pass), so every
 *       anchored matcher misses it by construction. The finished answer is
 *       never solicited; the page drops it as plain prose, and the TTL branch
 *       later tells the sender the question failed. Unlike D1/D2, whose anchor
 *       is BEFORE the send node, here it is after.
 *
 * F4 is driver-side and belongs to lane #44; its host-side consequence cannot be
 * asserted without editing the driver, so no test is written for it here.
 *
 * `private` is compile-time only in Bun; the tests read and set the host's real
 * fields (bridges, attachedTurns, a bridge's `stopping`) to model a killed or
 * shutting-down process, exactly as the r7 harness models a killed one with
 * `removed`.
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
const THREAD_B = '22222222-2222-4222-8222-222222222222'

type Call = Record<string, unknown>

/** The frozen child protocol, in memory. One page, one active thread. */
class FakeDriver {
  readonly calls: Call[] = []
  threads = [{ id: THREAD_A, title: 'Existing work' }, { id: THREAD_B, title: 'Another thread' }]
  dead = false
  /** The assistant text a send produces (read back through the conversation). */
  answer = 'answered on the page'
  sendText = 'answered on the page'
  signal: { phase: string | null; threadId: string | null; at: number | null } = { phase: 'complete', threadId: null, at: null }
  generating = false
  refuseSend = false
  sendError: string | null = null
  /** Force the send to land on this thread id (used to trigger threadGone). */
  landOn: string | null = null
  /** Every send is appended as a user node; the assistant answer with it. */
  lags = false
  stallFor: ((request: Call) => boolean) | undefined
  /** The page takes the text, the driver call then fails with a timeout. */
  failSendAfterAccept = false
  /** Runs inside the send op, before the reply is returned (models a shutdown). */
  onSend: ((request: Call) => void) | undefined
  observable = false
  /** 1-based index of the conversation read that should fail (429). 0 disables. */
  conversationFailAt = 0
  conversationAttempts = 0
  readonly sentAtMs: number[] = []
  faultError: string | null = null
  killed = false
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

  /**
   * Append one node. `createTime: null` reproduces a page node with no time.
   * `parent` attaches under an explicit node WITHOUT moving the branch tip (a
   * regeneration sibling); omit it to append at the tip and advance it.
   */
  appendNode(threadId: string, role: 'user' | 'assistant', text: string, options: { id?: string; createTime?: number | null; parent?: string; endTurn?: boolean } = {}): string {
    const tree = this.treeOf(threadId)
    const id = options.id ?? randomUUID()
    const createTime = 'createTime' in options ? options.createTime : this.clock++
    const parent = options.parent ?? tree.current
    tree.mapping[id] = {
      id,
      parent,
      children: [],
      message: {
        id,
        author: { role },
        create_time: createTime,
        end_turn: role === 'assistant' ? (options.endTurn ?? true) : null,
        status: 'finished_successfully',
        content: { content_type: 'text', parts: [text] },
      },
    }
    tree.mapping[parent]!.children.push(id)
    if (options.parent === undefined) tree.current = id
    return id
  }

  /** Point the visible branch at a chosen node (e.g. a regenerated sibling). */
  setCurrent(threadId: string, id: string): void { this.treeOf(threadId).current = id }

  /** A page user node under a chosen id, with its finished answer beneath it. */
  seedUserTurn(threadId: string, userId: string, text: string, answer: string): string {
    this.appendNode(threadId, 'user', text, { id: userId })
    this.appendNode(threadId, 'assistant', answer)
    return userId
  }

  openThread(threadId: string | null): void { this.current = threadId }

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
      const stalls = this.stallFor?.(request) === true
      if (!this.lags) {
        this.appendNode(threadId, 'user', String(request.text ?? ''))
        if (!stalls) this.appendNode(threadId, 'assistant', this.answer)
      }
      this.signal = { phase: stalls ? 'streaming' : 'complete', threadId, at: Date.now() }
      this.sentAtMs.push(Date.now())
      this.onSend?.(request)
      if (this.failSendAfterAccept) {
        this.failSendAfterAccept = false
        onAccepted?.(String(request.id ?? ''))
        return { ok: false, op, reason: 'timeout', error: 'driver timed out after 600s', threadId }
      }
      onAccepted?.(String(request.id ?? ''))
      return { ok: true, op, text: this.sendText, threadId, model: 'GPT-6', effort: 'High' }
    }
    if (op === 'read') return { ok: true, op, threadId: this.current, text: this.answer, evidence: 'state-complete' }
    if (op === 'conversation' && this.observable) {
      this.conversationAttempts += 1
      if (this.conversationFailAt > 0 && this.conversationAttempts === this.conversationFailAt) {
        return { ok: false, op, status: 429, error: 'the page rate-limited the read' }
      }
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
      const tree = this.treeOf(asked)
      const node = newestAnswerNode(tree)
      const text = node ? String(node.message?.content?.parts?.[0] ?? '') : ''
      return {
        ok: true, op, cost: request.deep === true ? 'conversation' : 'push', threadId: asked,
        pushedThreadId: this.signal.threadId,
        matchesThread: this.signal.threadId === null ? null : this.signal.threadId === asked,
        state: pushed, phase: this.signal.phase,
        ageMs: this.signal.at === null ? null : Date.now() - this.signal.at, at,
        latestAssistant: node ? { nodeId: node.id, complete: node.message?.end_turn === true, chars: text.length, files: [] } : null,
        files: [],
      }
    }
    return { ok: false, op, error: `unknown op ${op}` }
  }

  private pushedFor(threadId: string): 'generating' | 'idle' | 'failed' | 'unknown' {
    if (this.generating) return 'generating'
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

// ------------------------------------------------------------------ harness

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')
const sessionsDir = (dir: string): string => join(dir, 'gateway-sessions')
const privateHome = (dir: string): string => join(dir, 'private')
const profileDir = (dir: string): string => join(dir, 'profile')

async function scratch(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-peer-r8-'))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

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
    await delay(50)
  }
}

const bridgeNamed = (name: string, threadId: string | null): BridgeState => newBridgeState({ sessionId: randomUUID(), name, threadId })

async function primerSha(): Promise<string> {
  return sha256(await readFile(join(import.meta.dir, 'chatgpt-peer', 'primer.md'), 'utf8'))
}

async function primedBridge(): Promise<{ alpha: BridgeState }> {
  const alpha = bridgeNamed('alpha', THREAD_A)
  alpha.primedThreadId = THREAD_A
  alpha.primerSha256 = await primerSha()
  return { alpha }
}

async function readBridge(dir: string, sessionId: string): Promise<BridgeState> {
  return JSON.parse(await readFile(join(dir, 'bridges', `${sessionId}.json`), 'utf8')) as BridgeState
}

async function writeBridge(dir: string, state: BridgeState): Promise<void> {
  await saveJson(join(dir, 'bridges', `${state.sessionId}.json`), state)
}

async function readHostAudit(dir: string): Promise<{ op: string; target: string | null; result: string }[]> {
  const state = JSON.parse(await readFile(join(dir, 'peer.json'), 'utf8')) as { audit?: { op: string; target: string | null; result: string }[] }
  return state.audit ?? []
}

async function busPeer(dir: string, name: string): Promise<GatewaySessionTransport> {
  const transport = new GatewaySessionTransport({
    directory: sessionsDir(dir), sessionId: randomUUID(), name, cwd: dir, purpose: 'test sender', policy: 'accept',
  })
  await transport.start()
  return transport
}

/** The session id a transport registered under (its `options` is private only at compile time). */
const sessionIdOf = (transport: GatewaySessionTransport): string =>
  (transport as unknown as { options: { sessionId: string } }).options.sessionId

const sendCount = (driver: FakeDriver): number => driver.calls.filter(call => call.op === 'send').length
const textOf = (record: { message: unknown }): string => String((record.message as { text?: unknown }).text ?? '')
const replyToOf = (record: { message: unknown }): string | undefined => (record.message as { replyTo?: string }).replyTo

async function acknowledged(dir: string, sessionId: string, messageId: string): Promise<boolean> {
  try {
    const raw = JSON.parse(await readFile(join(sessionsDir(dir), `${sessionId}.inbox`), 'utf8')) as { records?: { message: { id: string }; state: string }[] }
    return (raw.records ?? []).some(record => record.message.id === messageId && record.state === 'delivered')
  } catch { return false }
}

type AnyBridge = {
  state: { pendingTurns: any[]; cursor: string | null; threadId: string | null; ourNodeIds: string[] }
  transport?: { acknowledge(id: string): Promise<void> }
  stopping?: boolean
  removed?: boolean
}
type HostInternals = {
  bridges: Map<string, AnyBridge>
  attachedTurns: Set<string>
  freshTurns: Set<string>
  settling: Set<string>
}
const internalsOf = (host: ChatGptHost): HostInternals => host as unknown as HostInternals

/**
 * After a host is stopped, model a killed process: mark the bridge removed (the
 * one switch the host honours for not writing it again) and wait for the
 * interrupted turn to leave its sets, so the next host starts on a file that can
 * no longer change under it. Same discipline as r7's crash helper.
 */
async function quiesce(host: ChatGptHost, sessionId: string): Promise<void> {
  const internals = internalsOf(host)
  const bridge = internals.bridges.get(sessionId)
  if (bridge) bridge.removed = true
  await waitFor(() => (internals.attachedTurns.size === 0 && internals.freshTurns.size === 0 ? true : undefined), 10_000)
  await new Promise(resolve => setImmediate(resolve))
}

// --------------------------------------------------------------------- D1

describe('R8-D1: a prompt longer than 4096 loses its recovery identity', () => {
  test('a >4096 prompt is settled from the page on restart, never re-typed', async () => {
    const { dir, cleanup } = await scratch()
    const { alpha } = await primedBridge()
    await seedHost(dir, [alpha])
    const sender = await busPeer(dir, 'sender')
    const BODY = `D1-recovery-identity: ${'x'.repeat(4200)}`
    const ANSWER = 'the long prompt was answered before the crash'
    const driverA = new FakeDriver()
    driverA.observable = true
    // The page takes the text (a user node exists); the driver call then fails
    // with a timeout, so postRecordedTurn keeps postedAt and clears userNodeId.
    driverA.failSendAfterAccept = true
    const hostA = await startHost(dir, driverA, { turnTimeoutMs: 3_000 })
    let messageId = ''
    try {
      const receipt = await sender.send(alpha.sessionId, BODY, 'r8 probe', undefined, 'inquiry', true) as { id: string }
      messageId = receipt.id
      await waitFor(() => (sendCount(driverA) >= 1 ? true : undefined), 15_000)
      // The ack keeps the record out of the startup drain; recoverOwed is the
      // path under test. Driven here (not left to the fire-and-forget host ack).
      await internalsOf(hostA).bridges.get(alpha.sessionId)!.transport!.acknowledge(messageId)
      expect(await acknowledged(dir, alpha.sessionId, messageId)).toBe(true)
    } finally {
      await hostA.stop()
      driverA.dead = true
      await quiesce(hostA, alpha.sessionId)
    }

    // What the page was actually typed, and the durable shape left behind.
    const typed = String(driverA.calls.find(call => call.op === 'send')!.text)
    expect(typed.length).toBeGreaterThan(4096)
    const durable = await readBridge(dir, alpha.sessionId)
    const kept = durable.pendingTurns.find(item => item.messageId === messageId)
    expect(kept).toBeTruthy()
    // Named preconditions: the crash was after acceptance (postedAt set) and the
    // per-turn node was never written back (userNodeId null).
    expect(kept!.postedAt).not.toBe(null)
    expect(kept!.userNodeId).toBe(null)
    expect(kept!.text).toBe(typed)
    // The truncation that loses the identity: ourText is the 4096-char prefix.
    expect(kept!.ourText.length).toBe(4096)
    expect(sendCount(driverA)).toBe(1)

    const driverB = new FakeDriver()
    driverB.observable = true
    driverB.answer = 'a re-typed answer that must not be produced'
    // The page kept the turn's own node (the FULL prompt) and finished it.
    driverB.seedUserTurn(THREAD_A, randomUUID(), typed, ANSWER)
    const hostB = await startHost(dir, driverB)
    try {
      const replies = () => sender.inbox().filter(record => replyToOf(record) === messageId)
      await waitFor(() => (replies().length >= 1 ? true : undefined), 20_000)
      await delay(400)
      expect(replies().length).toBe(1)
      // RED at eac9038: ownUserNodeOf matches ourText (the 4096 prefix) by exact
      // trim equality, never the full prompt, so settlePostedTurn returns
      // 'absent' and recoverOwed re-posts the whole prompt a second time.
      expect(sendCount(driverB)).toBe(0)
      const delivered = textOf(replies()[0]!)
      expect(delivered).toContain(ANSWER)
      expect(delivered).not.toContain('a re-typed answer')
      expect((await readBridge(dir, alpha.sessionId)).pendingTurns.some(item => item.messageId === messageId)).toBe(false)
    } finally {
      await hostB.stop()
    }

    await sender.close()
    await cleanup()
  }, 60_000)
})

// --------------------------------------------------------------------- D2

/**
 * The visible failure D2a and D2b share: the host's own user node (carrying the
 * pending turn's own text) is reported as a HUMAN turn, the pending turn is left
 * silently owed, and the page's finished answer is never delivered.
 *
 * Why the final cursor value is not asserted: when a pass leaves no pending
 * human turns it legitimately advances the cursor to the last node on the branch
 * (the answer). A correct fix therefore ends with `cursor === answer`. The
 * observable invariants that a fix must hold are: no 'human' audit for the node,
 * the answer delivered exactly once, and the turn not left silently owed.
 */
describe('R8-D2a: a page-appended footer defeats the whole-text matcher', () => {
  test('our own node reads back as a human turn and its answer is starved', async () => {
    const { dir, cleanup } = await scratch()
    const { alpha } = await primedBridge()
    await seedHost(dir, [alpha])
    const sender = await busPeer(dir, 'sender')
    const BODY = 'D2 whitespace probe'
    const ANSWER = 'the page answered the probe'
    const driverA = new FakeDriver()
    driverA.observable = true
    // Page takes the text; no answer yet; driver call then times out, leaving
    // postedAt set, userNodeId null. Short prompt: ourText === text, so the ONLY
    // mismatch at restart is the footer the page appends.
    driverA.failSendAfterAccept = true
    driverA.stallFor = () => true
    const hostA = await startHost(dir, driverA, { turnTimeoutMs: 3_000 })
    let messageId = ''
    let typed = ''
    try {
      // expectReply false: startup recovery leaves the record to the observation
      // pass this test drives, instead of re-posting it first.
      const receipt = await sender.send(alpha.sessionId, BODY, 'r8 probe', undefined, 'inquiry', false) as { id: string }
      messageId = receipt.id
      await waitFor(() => (sendCount(driverA) >= 1 ? true : undefined), 15_000)
      await internalsOf(hostA).bridges.get(alpha.sessionId)!.transport!.acknowledge(messageId)
      expect(await acknowledged(dir, alpha.sessionId, messageId)).toBe(true)
    } finally {
      await hostA.stop()
      driverA.dead = true
      await quiesce(hostA, alpha.sessionId)
    }
    typed = String(driverA.calls.find(call => call.op === 'send')!.text)
    const kept = (await readBridge(dir, alpha.sessionId)).pendingTurns.find(item => item.messageId === messageId)
    expect(kept).toBeTruthy()
    expect(kept!.postedAt).not.toBe(null)
    expect(kept!.userNodeId).toBe(null)
    expect(kept!.ourText).toBe(typed)

    const driverB = new FakeDriver()
    driverB.observable = true
    // The page's node carries the same words plus a footer it appended. This is
    // a difference a page can introduce; trim equality cannot see past it.
    const anchor = driverB.appendNode(THREAD_A, 'assistant', 'history before the turn')
    const userNode = driverB.appendNode(THREAD_A, 'user', `${typed}\n\n(footer the page appended)`)
    driverB.appendNode(THREAD_A, 'assistant', ANSWER)
    // The host had observed up to the anchor before the crashed send.
    await writeBridge(dir, { ...(await readBridge(dir, alpha.sessionId)), cursor: anchor })

    const hostB = await startHost(dir, driverB)
    try {
      await hostB.pollOnce()
      await delay(300)
      const audit = await readHostAudit(dir)
      // RED at eac9038: resolvePendingAttribution does not adopt the node and
      // resumePendingTurns does not match it, so pendingHumanTurns classes our
      // OWN node as a person typing and personTurn audits op 'human'.
      expect(audit.filter(entry => entry.op === 'human' && entry.target === userNode)).toEqual([])
      const replies = () => sender.inbox().filter(record => replyToOf(record) === messageId)
      // RED: the answer was never delivered - the turn was silently consumed.
      expect(replies().filter(record => textOf(record).includes(ANSWER)).length).toBe(1)
      // RED: and it is still owed, so no later pass can pick it up either.
      expect((await readBridge(dir, alpha.sessionId)).pendingTurns.some(item => item.messageId === messageId)).toBe(false)
    } finally {
      await hostB.stop()
    }

    await sender.close()
    await cleanup()
  }, 60_000)
})

describe('R8-D2b: a null create_time hides the node from both matchers', () => {
  test('a node with no create_time reads back as a human turn and its answer is starved', async () => {
    const { dir, cleanup } = await scratch()
    const { alpha } = await primedBridge()
    await seedHost(dir, [alpha])
    const sender = await busPeer(dir, 'sender')
    const BODY = 'D2 null-time probe'
    const ANSWER = 'the page answered the null-time probe'
    const driverA = new FakeDriver()
    driverA.observable = true
    driverA.failSendAfterAccept = true
    driverA.stallFor = () => true
    const hostA = await startHost(dir, driverA, { turnTimeoutMs: 3_000 })
    let messageId = ''
    try {
      const receipt = await sender.send(alpha.sessionId, BODY, 'r8 probe', undefined, 'inquiry', false) as { id: string }
      messageId = receipt.id
      await waitFor(() => (sendCount(driverA) >= 1 ? true : undefined), 15_000)
      await internalsOf(hostA).bridges.get(alpha.sessionId)!.transport!.acknowledge(messageId)
      expect(await acknowledged(dir, alpha.sessionId, messageId)).toBe(true)
    } finally {
      await hostA.stop()
      driverA.dead = true
      await quiesce(hostA, alpha.sessionId)
    }
    const typed = String(driverA.calls.find(call => call.op === 'send')!.text)
    const kept = (await readBridge(dir, alpha.sessionId)).pendingTurns.find(item => item.messageId === messageId)
    expect(kept).toBeTruthy()
    expect(kept!.postedAt).not.toBe(null)
    expect(kept!.userNodeId).toBe(null)
    expect(kept!.ourText).toBe(typed)

    const driverB = new FakeDriver()
    driverB.observable = true
    const anchor = driverB.appendNode(THREAD_A, 'assistant', 'history before the turn')
    // EXACT same text; the only difference is create_time, which both matchers
    // require to be a number and pendingHumanTurns does not.
    const userNode = driverB.appendNode(THREAD_A, 'user', typed, { createTime: null })
    driverB.appendNode(THREAD_A, 'assistant', ANSWER)
    await writeBridge(dir, { ...(await readBridge(dir, alpha.sessionId)), cursor: anchor })

    const hostB = await startHost(dir, driverB)
    try {
      await hostB.pollOnce()
      await delay(300)
      const audit = await readHostAudit(dir)
      // RED at eac9038: ownUserNodeOf and resolvePendingAttribution both reject a
      // node whose createTime is not a number; the human-turn pass has no such
      // requirement and reports it as a person.
      expect(audit.filter(entry => entry.op === 'human' && entry.target === userNode)).toEqual([])
      const replies = () => sender.inbox().filter(record => replyToOf(record) === messageId)
      expect(replies().filter(record => textOf(record).includes(ANSWER)).length).toBe(1)
      expect((await readBridge(dir, alpha.sessionId)).pendingTurns.some(item => item.messageId === messageId)).toBe(false)
    } finally {
      await hostB.stop()
    }

    await sender.close()
    await cleanup()
  }, 60_000)
})

// --------------------------------------------------------------------- D3

describe('R8-D3: a failed second read turns a verified answer into a false line', () => {
  test('the sender is never told "a command block only" and the turn stays owed', async () => {
    const { dir, cleanup } = await scratch()
    const { alpha } = await primedBridge()
    await seedHost(dir, [alpha])
    const sender = await busPeer(dir, 'sender')
    const BODY = 'D3 second read probe'
    const ANSWER = 'the real observed answer, delivered on the retry'
    const driverA = new FakeDriver()
    driverA.observable = true
    // The page takes the text and never finishes (streaming), so the live turn
    // hangs and the host is stopped with the record posted.
    driverA.stallFor = () => true
    const hostA = await startHost(dir, driverA, { turnTimeoutMs: 60_000 })
    let messageId = ''
    let typed = ''
    let userId = ''
    try {
      // expectReply false: startup recovery leaves the record to the observation
      // pass this test drives.
      const receipt = await sender.send(alpha.sessionId, BODY, 'r8 probe', undefined, 'inquiry', false) as { id: string }
      messageId = receipt.id
      const turn = await waitFor(async () => {
        const state = await readBridge(dir, alpha.sessionId)
        const found = state.pendingTurns.find(item => item.messageId === messageId)
        return found && found.postedAt !== null && found.userNodeId !== null ? found : undefined
      }, 15_000)
      typed = turn.text as string
      userId = turn.userNodeId as string
      await internalsOf(hostA).bridges.get(alpha.sessionId)!.transport!.acknowledge(messageId)
      expect(await acknowledged(dir, alpha.sessionId, messageId)).toBe(true)
    } finally {
      await hostA.stop()
      driverA.dead = true
      await quiesce(hostA, alpha.sessionId)
    }

    const driverB = new FakeDriver()
    driverB.observable = true
    driverB.seedUserTurn(THREAD_A, userId, typed, ANSWER)
    // The pass's own conversation read (attempt 1) succeeds and carries the
    // finished answer; the immediately following read inside answerNodeById
    // (attempt 2) is rate-limited.
    driverB.conversationFailAt = 2

    const hostB = await startHost(dir, driverB)
    try {
      const replies = () => sender.inbox().filter(record => replyToOf(record) === messageId)
      await hostB.pollOnce()
      await delay(300)
      // RED at eac9038: deliverSolicited got the answer from the pass read, then
      // answerNodeById's second read fails, node is null, and the delivery path
      // sends the false "command block only; nothing was sent" terminal line.
      expect(replies().some(record => /command block only/.test(textOf(record)))).toBe(false)
      // RED: that false line is recorded as a sent reply, so the turn is retired
      // and the real answer is lost.
      expect((await readBridge(dir, alpha.sessionId)).pendingTurns.some(item => item.messageId === messageId)).toBe(true)

      // A later pass (the fault gone) must deliver the page's real answer once.
      driverB.conversationFailAt = 0
      await hostB.pollOnce()
      await waitFor(() => (replies().some(record => textOf(record).includes(ANSWER)) ? true : undefined), 10_000)
      expect(replies().filter(record => textOf(record).includes(ANSWER)).length).toBe(1)
    } finally {
      await hostB.stop()
    }

    await sender.close()
    await cleanup()
  }, 60_000)
})

// --------------------------------------------------------------------- D4

describe('R8-D4: a generic exception after acceptance still clears postedAt', () => {
  test('postedAt survives and a restart does not type the prompt again', async () => {
    const { dir, cleanup } = await scratch()
    const { alpha } = await primedBridge()
    await seedHost(dir, [alpha])
    const sender = await busPeer(dir, 'sender')
    const BODY = 'D4 post-acceptance probe'
    const ANSWER = 'the answer the page gave after accepting'
    const driverA = new FakeDriver()
    driverA.observable = true
    // The page accepts the send but lands on a DIFFERENT thread, so the host's
    // own landed callback throws a generic threadGone error - after reply.ok was
    // true and after the user node was created, before `posted` is assigned.
    // This is a reachable generic post-acceptance error, which is what the
    // finding names. It is NOT the literal `recordOurs` persist path: that
    // persist is non-critical and swallows save errors at eac9038, so it could
    // not throw here.
    driverA.landOn = THREAD_B
    const hostA = await startHost(dir, driverA, { turnTimeoutMs: 3_000 })
    const internals = internalsOf(hostA)
    let messageId = ''
    try {
      // The host is shutting down as the page takes the text: a real
      // bridge.stopping (set by stop()) is what makes the outer handler leave
      // the job owed instead of failing it terminally. Model it inside the send.
      driverA.onSend = () => {
        const bridge = internals.bridges.get(alpha.sessionId)
        if (bridge) bridge.stopping = true
      }
      const receipt = await sender.send(alpha.sessionId, BODY, 'r8 probe', undefined, 'inquiry', true) as { id: string }
      messageId = receipt.id
      await waitFor(() => (sendCount(driverA) >= 1 ? true : undefined), 15_000)
      await waitFor(() => (internals.attachedTurns.has(messageId) || internals.freshTurns.has(messageId) ? undefined : true), 10_000)
      await internals.bridges.get(alpha.sessionId)!.transport!.acknowledge(messageId)
      expect(await acknowledged(dir, alpha.sessionId, messageId)).toBe(true)
    } finally {
      await hostA.stop()
      driverA.dead = true
      await quiesce(hostA, alpha.sessionId)
    }

    const typed = String(driverA.calls.find(call => call.op === 'send')!.text)
    const durable = await readBridge(dir, alpha.sessionId)
    const kept = durable.pendingTurns.find(item => item.messageId === messageId)
    // The host shut down mid-turn, so the record survives for the restart.
    expect(kept).toBeTruthy()
    // RED at eac9038: the generic error was not GeneratingTurn/PageUnproven, so
    // postRecordedTurn's else branch cleared postedAt, claiming the send never
    // landed even though the page took it.
    expect(kept!.postedAt).not.toBe(null)
    expect(kept!.userNodeId).toBe(null)
    expect(kept!.text).toBe(typed)
    expect(sendCount(driverA)).toBe(1)

    const driverB = new FakeDriver()
    driverB.observable = true
    driverB.answer = 'a re-typed answer that must not be produced'
    driverB.seedUserTurn(THREAD_A, randomUUID(), typed, ANSWER)
    const hostB = await startHost(dir, driverB)
    try {
      const replies = () => sender.inbox().filter(record => replyToOf(record) === messageId)
      await waitFor(() => (replies().length >= 1 ? true : undefined), 20_000)
      await delay(400)
      // RED: postedAt was cleared, the record looks never-posted, and the
      // restart types the whole prompt again.
      expect(sendCount(driverB)).toBe(0)
      const delivered = textOf(replies()[0]!)
      expect(delivered).toContain(ANSWER)
      expect(delivered).not.toContain('a re-typed answer')
    } finally {
      await hostB.stop()
    }

    await sender.close()
    await cleanup()
  }, 60_000)
})

// --------------------------------------------------------------------- D6

/**
 * The live shape, told from the durable bridge (bridge 3b362ea4 at eac9038):
 *
 *   pendingTurns[0]  messageId 3846f0da, postedAt set, userNodeId null,
 *                    ourText 4,096 chars (the capped matcher), text 9,644
 *                    chars (the whole envelope + prompt).
 *   page              user node aaee556a carries that exact 9,644-char text but
 *                    with `create_time: null`; its first answer f4432464 is an
 *                    abandoned branch, and the answer the page kept is the
 *                    regenerated sibling 5c04999d (plain prose).
 *   cursor           f4432464 - the send node's first assistant successor,
 *                    i.e. AFTER aaee556a. An earlier pass had wrongly classed
 *                    aaee556a as a human turn and moved the cursor onto its
 *                    answer (pendingHumanTurns, threads.ts:331-346), so the
 *                    whole-text/anchored matchers miss the send node by
 *                    construction.
 *
 * D1/D2 exercise a cursor BEFORE the send node, where the positional branch
 * accepts the node. Here the cursor is already past it - the live shape.
 *
 * Expected (green against #45's fix): exactly one solicited reply with
 * replyTo=3846f0da carrying the answer, nothing typed into the page, no outbound
 * whose text is the answer without that replyTo, and the turn retired.
 * Red at 984e03a: no such reply exists and the turn stays owed.
 *
 * The TTL line ("no completed answer within 6h") is NOT asserted. Driving it
 * needs a postedAt already past the 6h TTL, but that same pass retires the turn
 * on the failure line, which contradicts the "turn stays owed" fact; and the
 * brief forbids sleeping. The two delivery facts above are the failure mode.
 */
describe('R8-D6: a cursor past the send node makes recovery unrecoverable', () => {
  test('the finished answer is solicited with replyTo, never typed again', async () => {
    const D6_USER = 'aaee556a-0000-4000-8000-000000000000'
    const D6_FIRST = 'f4432464-0000-4000-8000-000000000000'
    const D6_ANSWER_NODE = '5c04999d-0000-4000-8000-000000000000'
    const D6_MESSAGE = '3846f0da-0000-4000-8000-000000000000'
    const { dir, cleanup } = await scratch()
    const { alpha } = await primedBridge()
    await seedHost(dir, [alpha])
    const sender = await busPeer(dir, 'sender')
    const ANSWER = 'the page finished this long prompt before the cursor ran past it'
    // Exactly the live envelope length: >4096 so ourText is the 4,096 prefix.
    const USER_TEXT = `D6-live-shape ${'y'.repeat(9644 - 'D6-live-shape '.length)}`

    const driverB = new FakeDriver()
    driverB.observable = true
    driverB.appendNode(THREAD_A, 'assistant', 'history before the turn')
    driverB.appendNode(THREAD_A, 'user', USER_TEXT, { id: D6_USER, createTime: null })
    // The first answer, now an abandoned branch: this is what the cursor names.
    driverB.appendNode(THREAD_A, 'assistant', 'an abandoned first answer the page replaced', { id: D6_FIRST, parent: D6_USER })
    // The answer the page kept, a regenerated sibling on the visible branch.
    const kept = driverB.appendNode(THREAD_A, 'assistant', ANSWER, { id: D6_ANSWER_NODE, parent: D6_USER })
    driverB.setCurrent(THREAD_A, kept)

    // The durable shape: cursor already past the send node, our node unknown.
    const durable = await readBridge(dir, alpha.sessionId)
    await writeBridge(dir, {
      ...durable,
      ourNodeIds: [],
      answeredTurns: [],
      cursor: D6_FIRST,
      pendingTurns: [{
        threadId: THREAD_A,
        userNodeId: null,
        ourText: USER_TEXT.slice(0, 4096),
        text: USER_TEXT,
        senderSessionId: sessionIdOf(sender),
        messageId: D6_MESSAGE,
        kind: 'inquiry',
        postedAt: new Date().toISOString(),
      }],
    })

    const hostB = await startHost(dir, driverB)
    try {
      await hostB.pollOnce()
      await delay(300)
      const replies = sender.inbox().filter(record => replyToOf(record) === D6_MESSAGE)
      // RED at 984e03a: no solicited reply is ever sent - the anchored matcher
      // misses aaee556a (null create_time, cursor past it) and the page answer
      // is dropped as plain prose.
      expect(replies.length).toBe(1)
      expect(textOf(replies[0]!)).toContain(ANSWER)
      // Nothing is typed into the page: recovery must never re-post the prompt.
      expect(sendCount(driverB)).toBe(0)
      // The failure is a wrong or missing delivery, never page speech carrying
      // the answer without this turn's replyTo.
      const bare = sender.inbox().filter(record => replyToOf(record) !== D6_MESSAGE && textOf(record).includes(ANSWER))
      expect(bare).toEqual([])
      // The turn is retired once delivered, not left owed for the TTL branch.
      expect((await readBridge(dir, alpha.sessionId)).pendingTurns.some(item => item.messageId === D6_MESSAGE)).toBe(false)
    } finally {
      await hostB.stop()
    }

    await sender.close()
    await cleanup()
  }, 60_000)
})
