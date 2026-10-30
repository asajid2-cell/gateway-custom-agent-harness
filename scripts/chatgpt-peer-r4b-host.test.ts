/**
 * R4 review-fix lane: the delivery and lifecycle half of the round-4 verdict.
 *
 * Five defects, one file, one real host each: the bus is a real
 * GatewaySessionTransport in a scratch directory and the page is the frozen
 * line-JSON fake the bridge suite uses. Every test below is RED on the base
 * commit for its own stated reason; none of them is a mock manufacturing the
 * assertion.
 *
 *   1. R1-F8 - a removed bridge stops mid-turn: no page send, no reply.
 *   2. R1-F9 - a restart replays side-effecting commands: at most once.
 *   3. R2-F12 - a final-round receipt is not reported as a budget error.
 *   4. N3    - the per-node byte cap is cumulative across deliveries.
 *   5. N4    - a refused uplink leaves nothing behind to block a retry.
 */
import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GatewaySessionTransport } from '../src/utils/gatewaySessionTransport.js'
import { ChatGptHost } from './chatgpt-peer.ts'
import type { DriverChild, DriverReply } from './chatgpt-peer/driver.ts'
import { newBridgeState, newHostState, saveJson, type BridgeState } from './chatgpt-peer/state.ts'

const THREAD_A = '11111111-1111-4111-8111-111111111111'
const MAX_MESSAGE_BYTES = 64 * 1024

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
  /** Succeed without naming the file in the reply, so the caller must know its own path. */
  omitFilePath = false
  stallFor: ((request: Call) => boolean) | undefined
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
      onAccepted?.(String(request.id ?? ''))
      return { ok: true, op, text: this.sendTextFor?.(request) ?? this.sendText, threadId, model: 'GPT-6', effort: 'High' }
    }
    if (op === 'read') {
      return { ok: true, op, threadId: this.current, text: this.answer, evidence: this.evidence }
    }
    if (op === 'conversation' && this.observable) {
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

async function exists(path: string): Promise<boolean> {
  return stat(path).then(info => info.isFile()).catch(() => false)
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

async function hostAudit(dir: string): Promise<{ op: string; target: string | null; result: string }[]> {
  const state = JSON.parse(await readFile(join(dir, 'peer.json'), 'utf8')) as { audit: { op: string; target: string | null; result: string }[] }
  return state.audit
}

async function busPeer(dir: string, name: string): Promise<GatewaySessionTransport> {
  const transport = new GatewaySessionTransport({
    directory: sessionsDir(dir), sessionId: randomUUID(), name, cwd: dir, purpose: 'test sender', policy: 'accept',
  })
  await transport.start()
  return transport
}

async function listFiles(path: string): Promise<string[]> {
  return readdir(path).catch(() => [] as string[])
}

/** A primed, observable bridge. */
async function primedBridge(): Promise<{ alpha: BridgeState }> {
  const alpha = bridgeNamed('alpha', THREAD_A)
  alpha.primedThreadId = THREAD_A
  alpha.primerSha256 = await primerSha()
  return { alpha }
}

describe('R1-F8: a removed bridge stops mid-turn', () => {
  test('removal during the page wait sends nothing to the page and answers nobody', async () => {
    const { dir, cleanup } = await scratch()
    const { alpha } = await primedBridge()
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.observable = true
    // The page is mid-turn for a while: the inbound is accepted but not posted.
    driver.busyUntil = Date.now() + 2_500
    const host = await startHost(dir, driver)
    const sender = await busPeer(dir, 'sender')
    try {
      const { token } = await credentials(dir)
      await sender.send(alpha.sessionId, 'do the thing', 'do the thing', undefined, 'inquiry', true)
      // The status poll proves the turn is inside postPendingTurn's wait loop,
      // after the primer step and before anything is typed.
      await waitFor(() => (driver.calls.some(call => call.op === 'status') ? true : undefined), 8_000)
      const removed = await operator(host, token, { op: 'remove', sessionId: alpha.sessionId })
      expect(removed.status).toBe(200)

      // Long enough for the old wait loop to expire and type the job.
      await new Promise(resolve => setTimeout(resolve, 3_500))
      expect(driver.calls.filter(call => call.op === 'send')).toEqual([])
      expect(sender.inbox().length).toBe(0)
      // The bridge file is gone and stays gone: no state write resurrects it.
      expect(await exists(join(dir, 'bridges', `${alpha.sessionId}.json`))).toBe(false)
    } finally {
      await sender.close()
      await host.stop()
      await cleanup()
    }
  }, 20_000)
})

describe('R1-F9: a restart does not repeat a side effect', () => {
  test('a command executed before a hard stop is not run again by the recovering host', async () => {
    const { dir, cleanup } = await scratch()
    const { alpha } = await primedBridge()
    await seedHost(dir, [alpha])
    const listener = await busPeer(dir, 'listener')
    const sender = await busPeer(dir, 'sender')
    // The page answers an INBOUND with one side-effecting command. The nonce is
    // minted for the turn and lives only in that first prompt; a model on the
    // page remembers it, so the fake carries it forward the same way.
    const scripted = (): ((request: Call) => string | undefined) => {
      let minted: string | null = null
      return request => {
        const text = String(request.text ?? '')
        const found = /"nonce":"([0-9a-f]{8})"/.exec(text)?.[1]
        if (found) minted = found
        if (!text.startsWith('INBOUND from another live session') || !minted) return 'done'
        return rendered({ nonce: minted, op: 'send', to: 'listener', text: 'the side effect' })
      }
    }
    const driverA = new FakeDriver()
    driverA.observable = true
    driverA.answerFor = scripted()
    // The round after the command never settles: it is the turn we crash.
    driverA.stallFor = request => {
      const text = String(request.text ?? '')
      return !text.startsWith('INBOUND from another live session') && text.includes('sent ')
    }
    const hostA = await startHost(dir, driverA)
    try {
      await sender.send(alpha.sessionId, 'do the side effect', 'do the side effect', undefined, 'inquiry', true)
      // Two page sends: the seeded round, then the round that follows the
      // command. The command itself has already reached the listener.
      await waitFor(() => (driverA.calls.filter(call => call.op === 'send').length >= 2 ? true : undefined), 15_000)
      await waitFor(() => (listener.inbox().length >= 1 ? true : undefined), 10_000)
      expect(listener.inbox().length).toBe(1)

      // Hard stop mid-turn: the process-local handled set dies, the page work
      // dies, the transport closes. The state dir is what survives.
      await hostA.stop()
      driverA.dead = true
      // A stop suppresses the turn's audit line - the honest outcome is "still
      // generating when the host stopped watching", not a model failure - so
      // the state file is the barrier: wait for the receipt of the command the
      // host already ran before the crash.
      await waitFor(async () => {
        const state = await readBridge(dir, alpha.sessionId) as { commandReceipts?: { line?: string }[] } | undefined
        return state?.commandReceipts?.some(entry => typeof entry.line === 'string' && entry.line !== 'recorded before the side effect') ? true : undefined
      }, 20_000)
      await new Promise(resolve => setTimeout(resolve, 200))
      // Nothing was answered: the sender is still owed a reply on the bus.
      expect(sender.inbox().length).toBe(0)
      // What survived the crash: the durable receipt, written before the side
      // effect left the host.
      const crashed = await readBridge(dir, alpha.sessionId) as unknown as Record<string, unknown>

      // A second host instance over the same state dir: a fresh process with an
      // empty handled set, which is exactly what recoverOwed replays.
      const driverB = new FakeDriver()
      driverB.observable = true
      driverB.answerFor = scripted()
      const hostB = await startHost(dir, driverB)
      try {
        await waitFor(() => (sender.inbox().length >= 1 ? true : undefined), 15_000)
        await new Promise(resolve => setTimeout(resolve, 300))
        // At most once: the recovering turn produced its answer without
        // repeating the side effect.
        expect(listener.inbox().length).toBe(1)
        // And the reason it did not repeat: the receipt is durable.
        expect(Array.isArray(crashed.commandReceipts)).toBe(true)
        expect((crashed.commandReceipts as unknown[]).length).toBeGreaterThan(0)
      } finally {
        await hostB.stop()
      }
    } finally {
      await sender.close()
      await listener.close()
      await hostA.stop()
      await cleanup()
    }
  }, 40_000)
})

describe('R2-F12: the last round\'s receipt is not a budget error', () => {
  test('a command that ran on the final allowed round is reported as a success with its receipt', async () => {
    const { dir, cleanup } = await scratch()
    const { alpha } = await primedBridge()
    await seedHost(dir, [alpha])
    const listener = await busPeer(dir, 'listener')
    const sender = await busPeer(dir, 'sender')
    const driver = new FakeDriver()
    driver.observable = true
    // Every round emits a distinct command, so the round budget is spent with
    // the last command having actually run.
    let minted: string | null = null
    let round = 0
    driver.answerFor = request => {
      const text = String(request.text ?? '')
      const found = /"nonce":"([0-9a-f]{8})"/.exec(text)?.[1]
      if (found) minted = found
      if (!minted) return 'done'
      round += 1
      return rendered({ nonce: minted, op: 'send', to: 'listener', text: `round receipt ${round}` })
    }
    const host = await startHost(dir, driver)
    try {
      const receipt = await sender.send(alpha.sessionId, 'keep sending', 'keep sending', undefined, 'inquiry', true) as { id?: string }
      await waitFor(() => (listener.inbox().length >= 4 ? true : undefined), 20_000)
      const reply = await waitFor(() => sender.inbox().find(item => item.message.replyTo === receipt.id), 15_000)
      const text = String((reply.message as unknown as { text: string }).text)
      // The side effect happened, so the sender is told what happened and gets
      // the receipt - never "budget exhausted", which invites the retry that
      // would duplicate the send.
      expect(text).not.toMatch(/budget/i)
      expect(text).toMatch(/sent .*to listener/i)
    } finally {
      await sender.close()
      await listener.close()
      await host.stop()
      await cleanup()
    }
  }, 40_000)
})

describe('N3: the per-node byte cap is cumulative', () => {
  test('two deliveries that each fit but together exceed the node cap are refused', async () => {
    const { dir, cleanup } = await scratch()
    const { alpha } = await primedBridge()
    await seedHost(dir, [alpha])
    const listener = await busPeer(dir, 'listener')
    const driver = new FakeDriver()
    driver.observable = true
    driver.fileBytes = 15 * 1024 * 1024
    const attachments = [0, 1, 2].map(index => ({ id: `file_${String(index).repeat(32)}`, name: `f${index}.bin`, mime: 'application/octet-stream', size: 15 * 1024 * 1024 }))
    const node = driver.pageNode(THREAD_A, 'three big files', attachments)
    const host = await startHost(dir, driver)
    try {
      const { token } = await credentials(dir)
      const first = (await operator(host, token, { op: 'files', bridge: alpha.sessionId, to: 'listener', nodeId: node, indexes: [0, 1] })).body
      expect(first.files.length).toBe(2)
      // The bytes are part of the durable receipt, not just the local run.
      const afterFirst = await readBridge(dir, alpha.sessionId)
      expect(afterFirst.deliveredFiles.filter(entry => entry.nodeId === node).every((entry: any) => typeof entry.bytes === 'number')).toBe(true)

      const second = (await operator(host, token, { op: 'files', bridge: alpha.sessionId, to: 'listener', nodeId: node, indexes: [2] })).body
      // 30 MiB already delivered + 15 MiB more is over the 32 MiB node cap.
      expect(second.files.length).toBe(0)
      expect(second.refused.join(' ')).toContain('cap')
    } finally {
      await listener.close()
      await host.stop()
      await cleanup()
    }
  }, 30_000)
})

describe('N4: a refused uplink leaves nothing blocking a retry', () => {
  test('the files collected for an over-limit uplink are not left in the outbox', async () => {
    const { dir, cleanup } = await scratch()
    const { alpha } = await primedBridge()
    await seedHost(dir, [alpha])
    const listener = await busPeer(dir, 'listener')
    const driver = new FakeDriver()
    driver.observable = true
    const host = await startHost(dir, driver)
    try {
      await host.pollOnce()
      // Five long-named attachments so the FILES block alone tips the outbound
      // over the 64 KiB bus limit while the text and stamp stay under it.
      const files = [0, 1, 2, 3, 4].map(index => ({
        id: `file_${String(index).repeat(32)}`,
        name: `${'n'.repeat(60)}-${index}.txt`,
        mime: 'text/plain',
        size: 10,
      }))
      driver.humanTypes(THREAD_A, 'relay this', rendered({ uplink: true, to: 'listener', text: 'x'.repeat(65_000), files: [0, 1, 2, 3, 4] }), files)
      await host.pollOnce()
      await host.pollOnce()

      const audit = await hostAudit(dir)
      expect(audit.some(entry => entry.op === 'uplink' && /exceeds 64 KiB/.test(entry.result))).toBe(true)
      // Nothing was posted, and nothing was stranded on disk.
      expect(listener.inbox().length).toBe(0)
      const outbox = join(dir, 'outbox', 'alpha')
      expect(await listFiles(outbox)).toEqual([])
      // A second look must not read a leftover as "exists" and lose the file.
      expect(audit.some(entry => entry.op === 'file' && /exists/.test(entry.result))).toBe(false)
    } finally {
      await listener.close()
      await host.stop()
      await cleanup()
    }
  }, 30_000)
})

describe('R1-F9 follow-up: the receipt key is positional within the turn', () => {
  test('a receipt key carries the command ordinal, not just the command identity', async () => {
    const { dir, cleanup } = await scratch()
    const { alpha } = await primedBridge()
    await seedHost(dir, [alpha])
    const listener = await busPeer(dir, 'listener')
    const sender = await busPeer(dir, 'sender')
    const driver = new FakeDriver()
    driver.observable = true
    let minted: string | null = null
    // Two distinct commands in one answer so both reach the dispatcher; the
    // ordinal must still appear in each receipt key.
    driver.answerFor = request => {
      const text = String(request.text ?? '')
      const found = /"nonce":"([0-9a-f]{8})"/.exec(text)?.[1]
      if (found) minted = found
      if (!text.startsWith('INBOUND from another live session') || !minted) return 'done'
      const first = rendered({ nonce: minted, op: 'send', to: 'listener', text: 'first' })
      const second = rendered({ nonce: minted, op: 'send', to: 'listener', text: 'second' })
      return `${first}\n${second}`
    }
    const host = await startHost(dir, driver)
    try {
      const inbound = await sender.send(alpha.sessionId, 'two sends', 'two sends', undefined, 'inquiry', true) as { id?: string }
      await waitFor(() => (listener.inbox().length >= 2 ? true : undefined), 20_000)
      const bridge = await readBridge(dir, alpha.sessionId) as unknown as { commandReceipts?: { key: string }[] }
      const receipts = bridge.commandReceipts ?? []
      expect(receipts.length).toBe(2)
      // `<messageId>:<ordinal>:<hash>`: the ordinal is the positional component
      // that keeps command 1 and command 2 apart.
      const parts = receipts.map(entry => entry.key.split(':'))
      expect(parts.every(part => part.length === 3)).toBe(true)
      expect(parts.every(part => part[0] === inbound.id)).toBe(true)
      expect(parts.map(part => part[1]).sort()).toEqual(['0', '1'])
    } finally {
      await sender.close()
      await listener.close()
      await host.stop()
      await cleanup()
    }
  }, 30_000)
})

describe('N4 follow-up: the retry records the path it actually wrote', () => {
  test('after an exists retry whose reply names no path, the FILES line carries the sibling path', async () => {
    const { dir, cleanup } = await scratch()
    const { alpha } = await primedBridge()
    await seedHost(dir, [alpha])
    const listener = await busPeer(dir, 'listener')
    const driver = new FakeDriver()
    driver.observable = true
    driver.fileExistsOnce = true
    driver.omitFilePath = true
    const host = await startHost(dir, driver)
    try {
      await host.pollOnce()
      const files = [{ id: `file_${'a'.repeat(32)}`, name: 'artifact.txt', mime: 'text/plain', size: 10 }]
      driver.humanTypes(THREAD_A, 'relay this', rendered({ uplink: true, to: 'listener', text: 'a small note', files: [0] }), files)
      await host.pollOnce()
      await host.pollOnce()

      await waitFor(() => (listener.inbox().length >= 1 ? true : undefined), 15_000)
      // The first attempt hit the stale target; the retry wrote the sibling.
      expect(driver.fileCalls.length).toBe(2)
      const first = String(driver.fileCalls[0].outPath)
      const sibling = String(driver.fileCalls[1].outPath)
      expect(sibling).not.toBe(first)
      const message = listener.inbox()[0].message as unknown as { text: string }
      // The delivered file is at the sibling; the FILES block must name it, not
      // the stale target it never wrote.
      expect(message.text).toContain(sibling)
    } finally {
      await listener.close()
      await host.stop()
      await cleanup()
    }
  }, 30_000)
})
