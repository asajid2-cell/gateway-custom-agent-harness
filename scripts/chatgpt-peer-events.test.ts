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
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer, type Socket } from 'node:net'
import { createInterface } from 'node:readline'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { GatewaySessionTransport } from '../src/utils/gatewaySessionTransport.js'
import { ChatGptHost } from './chatgpt-peer.ts'
import { DriverChild, type DriverReply } from './chatgpt-peer/driver.ts'
import { newBridgeState, newHostState, saveJson, type BridgeState } from './chatgpt-peer/state.ts'

const THREAD_A = '11111111-1111-4111-8111-111111111111'
const THREAD_B = '22222222-2222-4222-8222-222222222222'

/**
 * The shipped driver, resolved exactly the way the host resolves it: the same
 * environment variables, the same defaults (`CHATGPT_WEB_HOME` or
 * `~/chatgpt-web`, then `chatgpt.mjs`). C10 runs it for real; it is not a stand-in.
 */
const SHIPPED_DRIVER = process.env.CHATGPT_WEB_DRIVER
  ?? join(process.env.CHATGPT_WEB_HOME ?? join(homedir(), 'chatgpt-web'), 'chatgpt.mjs')
const SHIPPED_DRIVER_MISSING = !existsSync(SHIPPED_DRIVER)
if (SHIPPED_DRIVER_MISSING) {
  console.warn(`[C10 skipped] the shipped driver is not at ${SHIPPED_DRIVER}; set CHATGPT_WEB_DRIVER (or CHATGPT_WEB_HOME) to the real chatgpt.mjs`)
}

/**
 * A byte-for-byte snapshot of the shipped driver (chatgpt.mjs @ d5-async,
 * commit 50e85ba), vendored so the quit-drain test always runs against the real
 * `serve` protocol instead of being skipped on a machine without the deployed
 * copy. C10v below drives THIS file as a real child; the R3-F8 mutation (revert
 * `serve`'s drain) must fail it. C10 separately drives the deployed copy when
 * one is present.
 */
const VENDORED_DRIVER = join(import.meta.dir, 'chatgpt-peer', 'fixtures', 'chatgpt-driver.mjs')

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

  test('C5: an uplink is recorded before it is sent, so a crash at the send boundary never posts it twice', async () => {
    const { dir, cleanup } = await scratch()
    const driver = new FakeDriver()
    const { host, alpha } = await observedHost(dir, driver)
    const listener = await listenerPeer(dir)
    let reborn: ChatGptHost | undefined
    try {
      await host.pollOnce()
      // The shipped host hands the message to the real bus transport. Wrap that
      // one call so the disk is read at the exact moment the recipient is about
      // to have it: at-most-once is only sound if the record is already there.
      const bridge = (host as unknown as {
        bridges: Map<string, { transport: { send: (...args: unknown[]) => Promise<unknown> } }>
      }).bridges.get(alpha.sessionId)!
      const realSend = bridge.transport.send.bind(bridge.transport)
      let recordedAtSend: string[] | null = null
      let sends = 0
      bridge.transport.send = async (...args: unknown[]) => {
        sends += 1
        recordedAtSend = (await readBridge(dir, alpha.sessionId)).uplinkNodeIds
        const receipt = await realSend(...args)
        // Die at the send boundary: the recipient has the message and the host
        // never reaches its own post-send bookkeeping.
        if (sends === 1) throw new Error('injected failure at the send boundary')
        return receipt
      }

      driver.humanTypes(THREAD_A, 'tell the other agent', rendered({ uplink: true, to: 'listener', text: 'recorded before send' }))
      const answerId = driver.newestId(THREAD_A)
      driver.emit({ event: 'signal', threadId: THREAD_A, phase: 'complete' })
      await host.flushTriggers()
      await host.pollOnce()

      // At the instant the recipient was handed the message, the answer node
      // was already durable on disk.
      expect(recordedAtSend).not.toBeNull()
      expect(recordedAtSend!).toContain(answerId)
      const delivered = (): number => listener.transport.inbox().filter(record => record.message.text.includes('recorded before send')).length
      // The recipient has it exactly once, and the recorded node is that answer.
      expect(delivered()).toBe(1)
      expect((await readBridge(dir, alpha.sessionId)).uplinkNodeIds.at(-1)).toBe(answerId)

      // Restart as a crash would: the process is gone and its in-memory cursor
      // with it. Only the pre-send record on disk can stop a second delivery.
      await host.stop()
      const stored = await readBridge(dir, alpha.sessionId)
      await saveJson(join(dir, 'bridges', `${alpha.sessionId}.json`), { ...stored, cursor: driver.rootId(THREAD_A) })
      reborn = await startHost(dir, driver)
      await reborn.pollOnce()
      expect(delivered()).toBe(1)
      const audit = await hostAudit(dir)
      expect(audit.some(entry => entry.op === 'uplink' && entry.result.includes('already relayed'))).toBe(true)
    } finally {
      await reborn?.stop()
      await listener.close()
      await host.stop()
      await cleanup()
    }
  })

  // R3-F10: C5 dies AFTER the bus took the message. The other half of the
  // write-ahead window is death BETWEEN the durable record and the send. The
  // record is already on disk, so a restart must not retry: the uplink is lost,
  // never duplicated. There was no fault injection at this boundary at all.
  test('C5b: a crash between the write-ahead record and the send loses one uplink, never posts it twice', async () => {
    const { dir, cleanup } = await scratch()
    const driver = new FakeDriver()
    const { host, alpha } = await observedHost(dir, driver)
    const listener = await listenerPeer(dir)
    let reborn: ChatGptHost | undefined
    try {
      await host.pollOnce()
      const bridge = (host as unknown as {
        bridges: Map<string, { transport: { send: (...args: unknown[]) => Promise<unknown> } }>
      }).bridges.get(alpha.sessionId)!
      let recordedAtCrash: string[] | null = null
      bridge.transport.send = async () => {
        // The process dies here: the write-ahead record exists, the bus was
        // never asked to take the message. Snapshot the disk at that instant.
        recordedAtCrash = (await readBridge(dir, alpha.sessionId)).uplinkNodeIds
        throw new Error('injected process death between persist and send')
      }

      driver.humanTypes(THREAD_A, 'tell the other agent', rendered({ uplink: true, to: 'listener', text: 'lost at the persist boundary' }))
      const answerId = driver.newestId(THREAD_A)
      driver.emit({ event: 'signal', threadId: THREAD_A, phase: 'complete' })
      await host.flushTriggers()
      await host.pollOnce()

      // The durable record existed before the send was attempted...
      expect(recordedAtCrash).not.toBeNull()
      expect(recordedAtCrash!).toContain(answerId)
      // ...and the recipient never got it, because the send never completed.
      const delivered = (): number => listener.transport.inbox().filter(record => record.message.text.includes('lost at the persist boundary')).length
      expect(delivered()).toBe(0)

      // Restart from disk. The pre-send record must suppress a retry: at most
      // one delivery, and here exactly zero (a loss, not a duplicate).
      await host.stop()
      const stored = await readBridge(dir, alpha.sessionId)
      await saveJson(join(dir, 'bridges', `${alpha.sessionId}.json`), { ...stored, cursor: driver.rootId(THREAD_A) })
      reborn = await startHost(dir, driver)
      await reborn.pollOnce()
      expect(delivered()).toBe(0)
      const audit = await hostAudit(dir)
      expect(audit.some(entry => entry.op === 'uplink' && entry.result.includes('already relayed'))).toBe(true)
    } finally {
      await reborn?.stop()
      await listener.close()
      await host.stop()
      await cleanup()
    }
  })
})

/**
 * Drive one real driver process through the quit drain.
 *
 * A loopback socket accepts and never replies. The driver's page-free deep
 * status read reaches for CDP through it and is held for the read's own 1.5 s
 * abort, so there is a genuine in-flight request when `quit` lands - with no
 * Chrome, no CDP and no page anywhere. The frames are returned in arrival
 * order; the caller asserts the drain ordering.
 */
async function drainThroughQuit(driverPath: string, dir: string): Promise<{ frames: Record<string, unknown>[]; code: number | null }> {
  const sockets = new Set<Socket>()
  const hole = createServer(socket => { sockets.add(socket) })
  await new Promise<void>(resolve => hole.listen(0, '127.0.0.1', resolve))
  const port = (hole.address() as { port: number }).port
  const frames: Record<string, unknown>[] = []
  const child = spawn(process.execPath, [driverPath, 'serve'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    // Isolate the driver's own log dir (~/.chatgpt-web) from the real one.
    env: { ...process.env, HOME: dir, USERPROFILE: dir, CHATGPT_PROFILE: join(dir, 'chrome-profile'), CHATGPT_CDP_PORT: String(port) },
  })
  const exited = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)))
  createInterface({ input: child.stdout }).on('line', line => {
    const trimmed = line.trim()
    if (!trimmed) return
    try { frames.push(JSON.parse(trimmed) as Record<string, unknown>) } catch { /* not a frame */ }
  })
  child.stderr.resume()
  const waitFor = async (predicate: () => boolean, ms = 15_000): Promise<void> => {
    const until = Date.now() + ms
    while (Date.now() < until) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)) }
    throw new Error(`timed out waiting for the driver at ${driverPath}`)
  }
  try {
    await waitFor(() => frames.some(frame => frame.event === 'ready'))
    // A real page-free request: no page, no Chrome; it blocks only on the
    // loopback socket above.
    child.stdin.write(`${JSON.stringify({ op: 'status', threadId: THREAD_A, deep: true, id: 'in-flight' })}\n`)
    // Let the driver read that request before the quit, so it is queued.
    await new Promise(resolve => setTimeout(resolve, 150))
    child.stdin.write(`${JSON.stringify({ op: 'quit' })}\n`)
    const code = await exited
    return { frames, code }
  } finally {
    try { child.kill() } catch { /* already gone */ }
    for (const socket of sockets) socket.destroy()
    hole.close()
  }
}

/** The drain must be announced, the queued answer must go out, then the quit. */
function expectDrained(frames: Record<string, unknown>[], code: number | null): void {
  expect(code).toBe(0)
  const index = (predicate: (frame: Record<string, unknown>) => boolean): number => frames.findIndex(predicate)
  const draining = index(frame => frame.event === 'draining')
  const answered = index(frame => frame.op === 'status' && frame.id === 'in-flight')
  const quit = index(frame => frame.op === 'quit')
  // The in-flight request was answered...
  expect(answered).toBeGreaterThan(-1)
  expect(frames[answered]!.cost).toBe('conversation')
  // ...in the shipped order: the drain is announced, then the queued answer,
  // and only then does the quit answer go out.
  expect(draining).toBeGreaterThan(-1)
  expect(frames[draining]!.queued).toBe(1)
  expect(draining).toBeLessThan(answered)
  expect(answered).toBeLessThan(quit)
}

describe('driver child protocol', () => {
  test('C8: two sends in flight each hear only about their own acceptance', async () => {
    const { dir, cleanup } = await scratch()
    const script = join(dir, 'accepted.js')
    await writeFile(script, `
const readline = require('node:readline')
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n')
const rl = readline.createInterface({ input: process.stdin })
let seen = 0
emit({ event: 'ready', pid: process.pid })
rl.on('line', line => {
  const request = JSON.parse(line)
  if (request.op === 'quit') { emit({ ok: true, op: 'quit', id: request.id }); process.exit(0) }
  // Which id the driver actually gave this request's text.
  emit({ event: 'seen', text: request.text, id: request.id })
  const mine = seen++
  // Inversion: the FIRST request's acceptance is held back so the SECOND's
  // reaches the host first. Routing by arrival order would misattribute them.
  const delay = mine === 0 ? 150 : 0
  setTimeout(() => {
    emit({ event: 'accepted', threadId: 'thread-1', id: request.id })
    setTimeout(() => emit({ ok: true, op: request.op, id: request.id, text: 'echo:' + (request.text || '') }), 30)
  }, delay)
})
`, 'utf8')
    const ids = new Map<string, string>()
    const child = new DriverChild({ script, log: () => {} })
    child.onEvent(event => { if (event.event === 'seen') ids.set(String(event.text), String(event.id)) })
    try {
      const first: string[] = []
      const second: string[] = []
      const [a, b] = await Promise.all([
        child.call({ op: 'send', text: 'first' }, { onAccepted: id => first.push(id) }),
        child.call({ op: 'send', text: 'second' }, { onAccepted: id => second.push(id) }),
      ])
      expect(a.ok).toBe(true)
      expect(b.ok).toBe(true)
      // Each reply is the answer to its OWN request, not the other's.
      expect(a.text).toBe('echo:first')
      expect(b.text).toBe('echo:second')
      expect(first.length).toBe(1)
      expect(second.length).toBe(1)
      // Each callback heard about the id of ITS OWN request, even though the
      // second acceptance arrived first.
      expect(ids.get('first')).toBeTruthy()
      expect(ids.get('second')).toBeTruthy()
      expect(first[0]).toBe(ids.get('first')!)
      expect(second[0]).toBe(ids.get('second')!)
      expect(first[0]).not.toBe(second[0])
    } finally {
      await child.kill()
      await cleanup()
    }
  })

  test('C8b: a request whose acceptance never arrives is not settled by another request\'s acceptance', async () => {
    const { dir, cleanup } = await scratch()
    const script = join(dir, 'lost-acceptance.js')
    await writeFile(script, `
const readline = require('node:readline')
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n')
const rl = readline.createInterface({ input: process.stdin })
emit({ event: 'ready', pid: process.pid })
rl.on('line', line => {
  const request = JSON.parse(line)
  if (request.op === 'quit') { emit({ ok: true, op: 'quit', id: request.id }); process.exit(0) }
  emit({ event: 'seen', text: request.text, id: request.id })
  // Only the 'ok' request is ever accepted; 'lost' is answered with no acceptance.
  const delay = request.text === 'ok' ? 20 : 120
  setTimeout(() => {
    if (request.text === 'ok') emit({ event: 'accepted', threadId: 'thread-1', id: request.id })
    setTimeout(() => emit({ ok: true, op: request.op, id: request.id, text: 'echo:' + (request.text || '') }), 30)
  }, delay)
})
`, 'utf8')
    const ids = new Map<string, string>()
    const child = new DriverChild({ script, log: () => {} })
    child.onEvent(event => { if (event.event === 'seen') ids.set(String(event.text), String(event.id)) })
    try {
      const lost: string[] = []
      const ok: string[] = []
      const [a, b] = await Promise.all([
        child.call({ op: 'send', text: 'lost' }, { onAccepted: id => lost.push(id) }),
        child.call({ op: 'send', text: 'ok' }, { onAccepted: id => ok.push(id) }),
      ])
      expect(a.ok).toBe(true)
      expect(b.ok).toBe(true)
      // The one acceptance that arrived named the 'ok' request, so it must
      // settle that callback and never the one that had no acceptance.
      expect(ok.length).toBe(1)
      expect(ok[0]).toBe(ids.get('ok')!)
      expect(lost.length).toBe(0)
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

  test.skipIf(SHIPPED_DRIVER_MISSING)('C10: the shipped driver refuses new work, drains what is queued, then answers', async () => {
    const { dir, cleanup } = await scratch()
    try {
      const { frames, code } = await drainThroughQuit(SHIPPED_DRIVER, dir)
      expectDrained(frames, code)
    } finally {
      await cleanup()
    }
  })

  // R3-F8: C10 is skipped whenever the deployed driver is absent, so a revert
  // of its quit-drain passed as a green. This runs the vendored copy of the
  // shipped driver - the real `serve` protocol, as a real OS child - and so it
  // can never be skipped. Revert `serve`'s drain in that file and it fails.
  test('C10v: the vendored shipped driver refuses new work, drains what is queued, then answers', async () => {
    const { dir, cleanup } = await scratch()
    try {
      const { frames, code } = await drainThroughQuit(VENDORED_DRIVER, dir)
      expectDrained(frames, code)
    } finally {
      await cleanup()
    }
  })
})
