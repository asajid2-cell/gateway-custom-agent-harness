/**
 * Page events as a trigger, and the upstream half of the event channel.
 *
 * The page pushes `turn`/`navigated`/`page-ready`/`page-lost`. Each of these
 * must cost at most one observation, never a queue of them, and a missed one
 * must cost only latency. The second half exercises the child protocol itself:
 * per-request acceptance, a late reply that is dropped rather than delivered,
 * and a quit that drains instead of dropping what is queued.
 *
 * No network and no browser: the driver is an in-memory fake, or a tiny child
 * process speaking the line-JSON protocol.
 */
import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GatewaySessionTransport } from '../src/utils/gatewaySessionTransport.js'
import { ChatGptHost } from './chatgpt-peer.ts'
import { DriverChild, type DriverReply } from './chatgpt-peer/driver.ts'
import { newBridgeState, newHostState, saveJson, type BridgeState } from './chatgpt-peer/state.ts'

const THREAD_A = '11111111-1111-4111-8111-111111111111'
const THREAD_B = '22222222-2222-4222-8222-222222222222'

type Call = Record<string, unknown>

const rendered = (fields: Record<string, unknown>): string => 'gateway\n' + JSON.stringify(fields)

/** The page's own tree and the event channel, in memory. */
class FakeDriver {
  readonly calls: Call[] = []
  threads = [{ id: THREAD_A, title: 'Existing work' }, { id: THREAD_B, title: 'Other work' }]
  observable = true
  killed = false
  /** Makes the next `conversation` read wait, so a pass can be held open. */
  private blocker: Promise<void> | null = null
  private readonly listeners = new Set<(event: Record<string, unknown>) => void>()
  private current: string | null = THREAD_A
  private readonly trees = new Map<string, { current: string; mapping: Record<string, any> }>()
  private clock = 1000

  private treeOf(threadId: string): { current: string; mapping: Record<string, any> } {
    let tree = this.trees.get(threadId)
    if (!tree) {
      const root = this.rootId(threadId)
      tree = { current: root, mapping: { [root]: { id: root, parent: null, children: [], message: null } } }
      this.trees.set(threadId, tree)
    }
    return tree
  }

  rootId(threadId: string): string { return `root-${threadId}` }

  private grow(threadId: string, role: 'user' | 'assistant', text: string): string {
    const tree = this.treeOf(threadId)
    const id = randomUUID()
    tree.mapping[id] = { id, parent: tree.current, children: [], message: { id, author: { role }, create_time: this.clock++, end_turn: role === 'assistant' ? true : null, status: 'finished_successfully', content: { content_type: 'text', parts: [text] } } }
    tree.mapping[tree.current].children.push(id)
    tree.current = id
    return id
  }

  humanTypes(threadId: string, text: string, answer: string): string {
    const id = this.grow(threadId, 'user', text)
    this.grow(threadId, 'assistant', answer)
    return id
  }

  newestId(threadId: string): string { return this.treeOf(threadId).current }

  /** Hold the next conversation read on a promise the test releases. */
  blockNextConversation(): { release: () => void; released: Promise<void> } {
    let release!: () => void
    const released = new Promise<void>(resolve => { release = resolve })
    this.blocker = released
    return { release, released }
  }

  onEvent(handler: (event: Record<string, unknown>) => void): () => void {
    this.listeners.add(handler)
    return () => { this.listeners.delete(handler) }
  }

  emit(event: Record<string, unknown>): void { for (const listener of this.listeners) listener(event) }

  conversationReads(): number { return this.calls.filter(call => call.op === 'conversation').length }

  async call(request: Call, _options?: number | { onAccepted?: (id: string) => void }): Promise<DriverReply> {
    // `ping` is liveness, not page work: the host sends it at boot to bring the
    // child (and its event channel) up, so it is not recorded as a page call.
    if (String(request.op ?? '') === 'ping') return { ok: true, op: 'ping' }
    this.calls.push({ ...request })
    const op = String(request.op ?? '')
    if (op === 'threads') return { ok: true, op, threadId: this.current, threads: this.threads }
    if (op === 'conversation' && this.observable) {
      const threadId = String(request.threadId ?? '')
      const blocker = this.blocker
      if (blocker) { this.blocker = null; await blocker }
      const tree = this.treeOf(threadId)
      return { ok: true, op, conversation: { current_node: tree.current, mapping: structuredClone(tree.mapping) } }
    }
    if (op === 'conversations' && this.observable) {
      const offset = Number(request.offset ?? 0)
      const limit = Number(request.limit ?? 100)
      return { ok: true, op, items: this.threads.slice(offset, offset + limit) }
    }
    if (op === 'read') return { ok: true, op, threadId: this.current, text: 'ok', evidence: 'state-complete' }
    if (op === 'send') return { ok: true, op, threadId: this.current, text: 'ok', model: 'GPT-6', effort: 'High' }
    if (op === 'status') return { ok: true, op, threadId: this.current, model: 'GPT-6', effort: 'High' }
    return { ok: false, op, error: `unknown op ${op}` }
  }

  async kill(): Promise<void> { this.killed = true }
  reopen(): void { this.killed = false }
}

async function scratch(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-peer-events-'))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

const sessionsDir = (dir: string): string => join(dir, 'gateway-sessions')
const privateHome = (dir: string): string => join(dir, 'private')
const profileDir = (dir: string): string => join(dir, 'profile')

const bridgeNamed = (name: string, threadId: string | null): BridgeState =>
  newBridgeState({ sessionId: randomUUID(), name, threadId })

const primerSha = async (): Promise<string> =>
  createHash('sha256').update(await readFile(join(import.meta.dir, 'chatgpt-peer', 'primer.md'), 'utf8'), 'utf8').digest('hex')

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
    directory: sessionsDir(dir),
    privateHome: privateHome(dir),
  }, driver as unknown as InstanceType<typeof DriverChild>)
  await host.start()
  return host
}

async function readBridge(dir: string, sessionId: string): Promise<BridgeState> {
  return JSON.parse(await readFile(join(dir, 'bridges', `${sessionId}.json`), 'utf8')) as BridgeState
}

async function hostAudit(dir: string): Promise<{ op: string; target: string | null; result: string }[]> {
  const state = JSON.parse(await readFile(join(dir, 'peer.json'), 'utf8')) as { audit: { op: string; target: string | null; result: string }[] }
  return state.audit
}

async function listenerPeer(dir: string, name = 'listener'): Promise<{ transport: GatewaySessionTransport; close: () => Promise<void> }> {
  const transport = new GatewaySessionTransport({
    directory: sessionsDir(dir), sessionId: randomUUID(), name, cwd: process.cwd(), purpose: 'test recipient', policy: 'accept',
  })
  await transport.start()
  return { transport, close: () => transport.close() }
}

async function observedHost(dir: string, driver: FakeDriver): Promise<{ host: ChatGptHost; alpha: BridgeState }> {
  const alpha = bridgeNamed('alpha', THREAD_A)
  alpha.primedThreadId = THREAD_A
  alpha.primerSha256 = await primerSha()
  await seedHost(dir, [alpha])
  const host = await startHost(dir, driver)
  return { host, alpha }
}

describe('page events trigger observation', () => {
  test('C1: a streaming burst costs exactly one observation, on complete', async () => {
    const { dir, cleanup } = await scratch()
    const driver = new FakeDriver()
    const { host, alpha } = await observedHost(dir, driver)
    try {
      await host.pollOnce()
      const before = driver.conversationReads()
      driver.emit({ event: 'signal', threadId: THREAD_A, phase: 'streaming' })
      driver.emit({ event: 'signal', threadId: THREAD_A, phase: 'streaming' })
      driver.emit({ event: 'signal', threadId: THREAD_A, phase: 'complete' })
      await host.flushTriggers()
      expect(driver.conversationReads() - before).toBe(1)
    } finally {
      await host.stop()
      await cleanup()
    }
  })

  test('C2: an event while a pass is in flight makes exactly one coalesced follow-up', async () => {
    const { dir, cleanup } = await scratch()
    const driver = new FakeDriver()
    const { host } = await observedHost(dir, driver)
    try {
      await host.pollOnce()
      const before = driver.conversationReads()
      const block = driver.blockNextConversation()
      const pass = host.pollOnce()
      // Wait until the pass is inside its read, then fire a burst at it.
      while (driver.conversationReads() - before < 1) await new Promise(resolve => setTimeout(resolve, 5))
      for (let index = 0; index < 5; index++) host.triggerObserve('turn', { threadId: THREAD_A })
      await host.flushTriggers()
      block.release()
      await pass
      // One read for the pass, one for the single follow-up - never five.
      expect(driver.conversationReads() - before).toBe(2)
    } finally {
      await host.stop()
      await cleanup()
    }
  })

  test('C3: an event for a thread no bridge owns costs no driver call', async () => {
    const { dir, cleanup } = await scratch()
    const driver = new FakeDriver()
    const { host } = await observedHost(dir, driver)
    try {
      await host.pollOnce()
      const before = driver.conversationReads()
      driver.emit({ event: 'signal', threadId: THREAD_B, phase: 'complete' })
      driver.emit({ event: 'navigated', threadId: THREAD_B })
      await host.flushTriggers()
      expect(driver.conversationReads()).toBe(before)
    } finally {
      await host.stop()
      await cleanup()
    }
  })

  test('C3: with no bridge bound at all, a page event does nothing', async () => {
    const { dir, cleanup } = await scratch()
    const driver = new FakeDriver()
    await seedHost(dir, [])
    const host = await startHost(dir, driver)
    try {
      driver.emit({ event: 'signal', threadId: THREAD_A, phase: 'complete' })
      driver.emit({ event: 'page-ready' })
      await host.flushTriggers()
      // No bridge to look at: page-ready may walk the thread list, but it must
      // not read a conversation.
      expect(driver.conversationReads()).toBe(0)
      expect(driver.calls.every(call => call.op === 'conversations')).toBe(true)
    } finally {
      await host.stop()
      await cleanup()
    }
  })

  test('C6: a long answer\'s event storm collapses to one pass', async () => {
    const { dir, cleanup } = await scratch()
    const driver = new FakeDriver()
    const { host } = await observedHost(dir, driver)
    try {
      await host.pollOnce()
      const before = driver.conversationReads()
      for (let index = 0; index < 50; index++) driver.emit({ event: 'signal', threadId: THREAD_A, phase: index % 2 ? 'streaming' : 'complete' })
      await host.flushTriggers()
      expect(driver.conversationReads() - before).toBe(1)
    } finally {
      await host.stop()
      await cleanup()
    }
  })

  test('C7: page-lost does not spin; page-ready runs one recovery pass', async () => {
    const { dir, cleanup } = await scratch()
    const driver = new FakeDriver()
    const { host } = await observedHost(dir, driver)
    try {
      await host.pollOnce()
      const before = driver.conversationReads()
      driver.emit({ event: 'page-lost' })
      await host.flushTriggers()
      await new Promise(resolve => setTimeout(resolve, 400))
      expect(driver.conversationReads()).toBe(before)
      driver.emit({ event: 'page-ready' })
      await host.flushTriggers()
      expect(driver.conversationReads() - before).toBe(1)
    } finally {
      await host.stop()
      await cleanup()
    }
  })

  test('C12: a trigger during pollOnce never starts a second concurrent pass', async () => {
    const { dir, cleanup } = await scratch()
    const driver = new FakeDriver()
    const { host } = await observedHost(dir, driver)
    try {
      await host.pollOnce()
      const before = driver.conversationReads()
      const block = driver.blockNextConversation()
      const pass = host.pollOnce()
      while (driver.conversationReads() - before < 1) await new Promise(resolve => setTimeout(resolve, 5))
      // A second pollOnce while the first is running is a no-op, not a second pass.
      const second = host.pollOnce()
      host.triggerObserve('turn', { threadId: THREAD_A })
      await host.flushTriggers()
      block.release()
      await Promise.all([pass, second])
      expect(driver.conversationReads() - before).toBe(2)
    } finally {
      await host.stop()
      await cleanup()
    }
  })
})

describe('uplink is relayed at most once', () => {
  test('C4: duplicate complete events and a repeat pass relay one message', async () => {
    const { dir, cleanup } = await scratch()
    const driver = new FakeDriver()
    const { host, alpha } = await observedHost(dir, driver)
    const listener = await listenerPeer(dir)
    try {
      await host.pollOnce()
      driver.humanTypes(THREAD_A, 'tell the other agent', rendered({ uplink: true, to: 'listener', text: 'the build is green' }))
      driver.emit({ event: 'signal', threadId: THREAD_A, phase: 'complete' })
      driver.emit({ event: 'signal', threadId: THREAD_A, phase: 'complete' })
      await host.flushTriggers()
      await host.pollOnce()
      const inbox = listener.transport.inbox().map(record => record.message.text)
      expect(inbox.filter(text => text.includes('the build is green')).length).toBe(1)
      const sent = (await hostAudit(dir)).filter(entry => entry.op === 'uplink' && entry.result.startsWith('sent '))
      expect(sent.length).toBe(1)
      expect((await readBridge(dir, alpha.sessionId)).uplinkNodeIds.length).toBeGreaterThan(0)
    } finally {
      await listener.close()
      await host.stop()
      await cleanup()
    }
  })

  test('C5: a node recorded before a crash is not posted again after restart', async () => {
    const { dir, cleanup } = await scratch()
    const driver = new FakeDriver()
    driver.humanTypes(THREAD_A, 'tell the other agent', rendered({ uplink: true, to: 'listener', text: 'only once' }))
    const answerId = driver.newestId(THREAD_A)
    const alpha = bridgeNamed('alpha', THREAD_A)
    alpha.primedThreadId = THREAD_A
    alpha.primerSha256 = await primerSha()
    // The crash window: the send was decided and written down, but the cursor
    // was never advanced past the answer.
    alpha.cursor = driver.rootId(THREAD_A)
    alpha.uplinkNodeIds = [answerId]
    await seedHost(dir, [alpha])
    const listener = await listenerPeer(dir)
    const host = await startHost(dir, driver)
    try {
      await host.pollOnce()
      expect(listener.transport.inbox().length).toBe(0)
      const audit = await hostAudit(dir)
      expect(audit.some(entry => entry.op === 'uplink' && entry.result.includes('already relayed'))).toBe(true)
      expect((await readBridge(dir, alpha.sessionId)).cursor).toBe(answerId)
    } finally {
      await listener.close()
      await host.stop()
      await cleanup()
    }
  })
})

describe('driver child protocol', () => {
  test('C8: two sends in flight each hear only about their own acceptance', async () => {
    const { dir, cleanup } = await scratch()
    const script = join(dir, 'accepted.js')
    await writeFile(script, `
const readline = require('node:readline')
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n')
const rl = readline.createInterface({ input: process.stdin })
emit({ event: 'ready', pid: process.pid })
rl.on('line', line => {
  const request = JSON.parse(line)
  if (request.op === 'quit') { emit({ ok: true, op: 'quit', id: request.id }); process.exit(0) }
  setTimeout(() => {
    emit({ event: 'accepted', threadId: 'thread-1', id: request.id })
    setTimeout(() => emit({ ok: true, op: request.op, id: request.id, text: 'echo:' + (request.text || '') }), 40)
  }, 40)
})
`, 'utf8')
    const child = new DriverChild({ script, log: () => {} })
    try {
      const first: string[] = []
      const second: string[] = []
      const [a, b] = await Promise.all([
        child.call({ op: 'send', text: 'first' }, { onAccepted: id => first.push(id) }),
        child.call({ op: 'send', text: 'second' }, { onAccepted: id => second.push(id) }),
      ])
      expect(a.ok).toBe(true)
      expect(b.ok).toBe(true)
      expect(first.length).toBe(1)
      expect(second.length).toBe(1)
      expect(first[0]).not.toBe(second[0])
    } finally {
      await child.kill()
      await cleanup()
    }
  })

  test('C9: a late reply is dropped, never handed to an event handler', async () => {
    const { dir, cleanup } = await scratch()
    const script = join(dir, 'slow.js')
    await writeFile(script, `
const readline = require('node:readline')
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n')
const rl = readline.createInterface({ input: process.stdin })
let held = null
emit({ event: 'ready', pid: process.pid })
rl.on('line', line => {
  const request = JSON.parse(line)
  if (request.op === 'quit') { emit({ ok: true, op: 'quit', id: request.id }); process.exit(0) }
  if (request.op === 'hold') { held = request; return }
  if (request.op === 'release') {
    if (held) emit({ ok: true, op: 'hold', id: held.id, text: 'answer-for-the-abandoned-turn' })
    held = null
    emit({ ok: true, op: 'release', id: request.id })
    return
  }
  emit({ ok: true, op: request.op, id: request.id, text: 'echo:' + (request.text || '') })
})
`, 'utf8')
    const events: Record<string, unknown>[] = []
    const child = new DriverChild({ script, log: () => {} })
    child.onEvent(event => events.push(event))
    try {
      const timedOut = await child.call({ op: 'hold' }, 150)
      expect(timedOut.ok).toBe(false)
      const next = await child.call({ op: 'send', text: 'the next inbound' })
      expect(next.text).toBe('echo:the next inbound')
      const released = await child.call({ op: 'release' })
      expect(released.text).toBeUndefined()
      // The abandoned turn's answer never became an event.
      expect(events.some(event => event.op === 'hold')).toBe(false)
    } finally {
      await child.kill()
      await cleanup()
    }
  })

  test('C10: quit refuses new work, drains what is queued, then answers', async () => {
    const { dir, cleanup } = await scratch()
    const script = join(dir, 'drain.js')
    await writeFile(script, `
const readline = require('node:readline')
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n')
const rl = readline.createInterface({ input: process.stdin })
let chain = Promise.resolve()
let outstanding = 0
emit({ event: 'ready', pid: process.pid })
rl.on('line', line => {
  const request = JSON.parse(line)
  if (request.op === 'quit') {
    rl.close()
    emit({ event: 'draining', queued: outstanding })
    chain.then(() => { emit({ ok: true, op: 'quit', id: request.id }); process.exit(0) })
    return
  }
  outstanding += 1
  chain = chain.then(() => new Promise(resolve => setTimeout(resolve, 300))).then(() => {
    outstanding -= 1
    emit({ ok: true, op: request.op, id: request.id, text: 'slow:' + request.op })
  })
})
`, 'utf8')
    const order: string[] = []
    const child = new DriverChild({ script, log: () => {} })
    child.onEvent(event => { if (event.event === 'draining') order.push(`draining:${event.queued}`) })
    try {
      const slow = child.call({ op: 'wait' }).then(reply => { order.push(`reply:${reply.ok ? 'ok' : 'fail'}`); return reply })
      // Give the child the request before quitting, so it is genuinely queued.
      await new Promise(resolve => setTimeout(resolve, 50))
      await child.kill()
      const reply = await slow
      expect(reply.ok).toBe(true)
      expect(reply.text).toBe('slow:wait')
      expect(order[0]).toBe('draining:1')
      expect(order[1]).toBe('reply:ok')
    } finally {
      await cleanup()
    }
  })
})
