/**
 * R5 delivery lane: the operator `files` path and a page-pushed uplink share one
 * per-bridge delivery lock, so at-most-once delivery is an invariant of the
 * bridge rather than a property of one entry point.
 *
 * This file is deliberately self-contained: `chatgpt-peer-r4b-host.test.ts`
 * registers its own suites at import time, so its harness cannot be imported
 * here without also running its tests. The few helpers below are duplicated
 * verbatim from that file on 317c129.
 *
 * Both tests are RED on 317c129 with the uplink fold reverted: the uplink
 * downloads the same entry a second time (`fileCalls.length` 3, not 1).
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
  /** Delay every file write, so two requests for the same entry overlap. */
  fileDelayMs = 0
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

  /** The newest node on the branch: the answer a human turn just produced. */
  latestNodeId(threadId: string): string {
    return this.treeOf(threadId).current
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
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-peer-r5deliv-'))
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
    turnTimeoutMs: 5_000,
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

const listenerTexts = (transport: GatewaySessionTransport): string[] =>
  transport.inbox().map(item => String((item.message as unknown as { text: string }).text))

/** A human turn whose answer asks the page to uplink a file from that answer. */
function pageUplink(driver: FakeDriver, text: string): string {
  const files = [{ id: `file_${randomUUID().replace(/-/g, '')}`, name: 'artifact.txt', mime: 'text/plain', size: 10 }]
  driver.humanTypes(THREAD_A, 'relay this', rendered({ uplink: true, to: 'listener', text, files: [0] }), files)
  return driver.latestNodeId(THREAD_A)
}

describe('NEW-1 follow-up: operator and uplink share one delivery', () => {
  test('only one path downloads the entry, and the other reports it already delivered', async () => {
    const { dir, cleanup } = await scratch()
    const { alpha } = await primedBridge()
    await seedHost(dir, [alpha])
    const listener = await busPeer(dir, 'listener')
    const driver = new FakeDriver()
    driver.observable = true
    // Hold the download so both paths are in flight at once.
    driver.fileDelayMs = 700
    const host = await startHost(dir, driver)
    try {
      // Baseline the cursor so the turn below is work, not history.
      await host.pollOnce()
      const answerNode = pageUplink(driver, 'here is the artifact')
      const { token } = await credentials(dir)

      // Started together: one observation pass (which relays the uplink) and
      // one operator request for the same (node, index).
      const [, delivered] = await Promise.all([
        host.pollOnce(),
        operator(host, token, { op: 'files', bridge: alpha.sessionId, to: 'listener', nodeId: answerNode, indexes: [0] }),
      ])

      // One download, no sibling retry, one durable record.
      expect(driver.fileCalls.length).toBe(1)
      const state = await readBridge(dir, alpha.sessionId)
      expect(state.deliveredFiles.filter(entry => entry.nodeId === answerNode && entry.index === 0).length).toBe(1)

      const texts = listenerTexts(listener)
      // Exactly one message actually carries the file: the other path did not
      // collect it a second time.
      expect(texts.filter(text => /FILES \(1\):/.test(text)).length).toBe(1)
      // And the losing path says so, whether it was the operator's refused list
      // or the uplink's FILES REFUSED block.
      expect(`${texts.join('\n')}\n${delivered.body.refused.join('\n')}`).toContain('already delivered')
    } finally {
      await listener.close()
      await host.stop()
      await cleanup()
    }
  }, 30_000)

  test('both paths in flight together finish on a bounded clock (no deadlock)', async () => {
    const { dir, cleanup } = await scratch()
    const { alpha } = await primedBridge()
    await seedHost(dir, [alpha])
    const listener = await busPeer(dir, 'listener')
    const driver = new FakeDriver()
    driver.observable = true
    driver.fileDelayMs = 500
    const host = await startHost(dir, driver)
    try {
      await host.pollOnce()
      const answerNode = pageUplink(driver, 'here is the artifact')
      const { token } = await credentials(dir)

      // The operator takes the delivery lock first; the uplink, already inside
      // pageLock, then waits for it. pageLock -> deliveryLock must release
      // rather than form a cycle with the operator's delivery-only path.
      const requested = operator(host, token, { op: 'files', bridge: alpha.sessionId, to: 'listener', nodeId: answerNode, indexes: [0] })
      await new Promise(resolve => setTimeout(resolve, 120))
      const observed = host.pollOnce()
      let timer: NodeJS.Timeout | undefined
      const bounded = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('deadlock: the operator and the uplink did not both finish')), 10_000)
      })
      try {
        await Promise.race([Promise.all([requested, observed]), bounded])
      } finally {
        if (timer) clearTimeout(timer)
      }
      // Both completed, and the entry went out exactly once.
      expect(driver.fileCalls.length).toBe(1)
      expect(listenerTexts(listener).filter(text => /FILES \(1\):/.test(text)).length).toBe(1)
    } finally {
      await listener.close()
      await host.stop()
      await cleanup()
    }
  }, 30_000)
})
