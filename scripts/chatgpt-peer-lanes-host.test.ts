/**
 * Lane routing through the host: who types where, and what may overlap.
 *
 * The bus, the host and the state files are real; the page children are in
 * memory, one per lane, handed out by a real LaneManager. That makes the test
 * about the routing and the serialization, not about Chrome.
 */
import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GatewaySessionTransport } from '../src/utils/gatewaySessionTransport.js'
import { ChatGptHost } from './chatgpt-peer.ts'
import type { DriverChild, DriverReply } from './chatgpt-peer/driver.ts'
import { LaneManager } from './chatgpt-peer/lanes.ts'
import { newBridgeState, newHostState, saveJson, type BridgeState } from './chatgpt-peer/state.ts'

const THREAD_A = '11111111-1111-4111-8111-111111111111'
const THREAD_B = '22222222-2222-4222-8222-222222222222'

type Call = Record<string, unknown>

/** Resolves when `need` different arrivals have happened at once. */
class Gate {
  private count = 0
  private readonly waiters: (() => void)[] = []
  private opened = false
  overlap = false
  constructor(private readonly need: number) {}
  arrive(): Promise<void> {
    this.count += 1
    if (this.count >= this.need) {
      this.opened = true
      for (const release of this.waiters.splice(0)) release()
    }
    if (this.opened) { this.overlap = true; return Promise.resolve() }
    return new Promise<void>(resolve => this.waiters.push(resolve))
  }
}

class Page {
  readonly calls: Call[] = []
  active = 0
  maxActive = 0
  gate?: Gate
  emptyAnswer = false
  constructor(readonly answer = 'answered on the page') {}
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
    tree.mapping[id] = {
      id, parent: tree.current, children: [],
      message: {
        id, author: { role }, create_time: this.clock++,
        end_turn: role === 'assistant' ? true : null,
        status: 'finished_successfully',
        content: { content_type: 'text', parts: [text] },
      },
    }
    tree.mapping[tree.current].children.push(id)
    tree.current = id
    return id
  }

  async call(request: Call): Promise<DriverReply> {
    const op = String(request.op ?? '')
    if (op === 'ping') return { ok: true, op }
    this.calls.push({ ...request })
    if (op === 'send') {
      this.active += 1
      this.maxActive = Math.max(this.maxActive, this.active)
      try {
        if (this.gate) await this.gate.arrive()
        const threadId = String(request.threadId ?? '')
        this.grow(threadId, 'user', String(request.text ?? ''))
        this.grow(threadId, 'assistant', this.emptyAnswer ? '' : this.answer)
        return { ok: true, op, text: this.emptyAnswer ? '' : this.answer, threadId, model: 'GPT-6', effort: 'High' }
      } finally { this.active -= 1 }
    }
    if (op === 'conversation') {
      const threadId = String(request.threadId ?? '')
      const tree = this.treeOf(threadId)
      return { ok: true, op, conversation: { current_node: tree.current, mapping: structuredClone(tree.mapping) } }
    }
    if (op === 'read') return { ok: true, op, threadId: String(request.threadId ?? ''), text: this.answer, evidence: 'state-complete' }
    if (op === 'status') {
      const asked = String(request.threadId ?? '')
      return {
        ok: true, op, cost: 'push', threadId: asked, pushedThreadId: null,
        matchesThread: null, state: 'idle', phase: 'complete',
        ageMs: 0, at: new Date().toISOString(),
      }
    }
    if (op === 'warm') return { ok: true, op, signedIn: true, plan: 'plus' }
    if (op === 'unload') return { ok: true, op }
    if (op === 'threads') return { ok: true, op, threads: [] }
    return { ok: false, op, error: `unknown op ${op}` }
  }
  onEvent(): () => void { return () => {} }
  async kill(): Promise<void> {}
  async terminate(): Promise<void> {}
  reopen(): void {}
}

async function scratch(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-lanes-host-'))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

const sessionsDir = (dir: string): string => join(dir, 'gateway-sessions')
const privateHome = (dir: string): string => join(dir, 'private')
const profileDir = (dir: string): string => join(dir, 'profile')
const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

async function seedHost(dir: string, bridges: BridgeState[]): Promise<void> {
  await mkdir(join(dir, 'bridges'), { recursive: true })
  await saveJson(join(dir, 'peer.json'), newHostState({
    profile: profileDir(dir), healthPort: 0, idleUnloadMinutes: 0, instanceId: 'test',
  }))
  for (const bridge of bridges) await saveJson(join(dir, 'bridges', `${bridge.sessionId}.json`), bridge)
}

async function primedBridge(name: string, threadId: string): Promise<BridgeState> {
  const state = newBridgeState({ sessionId: randomUUID(), name, threadId })
  state.primedThreadId = threadId
  state.primerSha256 = sha256(await readFile(join(import.meta.dir, 'chatgpt-peer', 'primer.md'), 'utf8'))
  return state
}

type Built = { host: ChatGptHost; manager: LaneManager; pages: Map<string, Page>; master: Page }

async function startHost(dir: string, bridges: BridgeState[], master: Page, buildPage: (laneId: string) => Page): Promise<Built> {
  process.env.CLAUDE_CONFIG_DIR = dir
  const pages = new Map<string, Page>()
  const manager = new LaneManager({
    driverScript: join(dir, 'unused.mjs'),
    root: join(dir, 'lanes'),
    sourcePort: 9222,
    basePort: 26_000 + Math.floor(Math.random() * 20_000),
    maxLanes: 8,
    idleMs: 60_000,
    syncCookies: false,
    spawnLane: lane => {
      const page = buildPage(lane.laneId)
      pages.set(lane.laneId, page)
      return page as unknown as DriverChild
    },
    log: () => {},
  })
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
    turnTimeoutMs: 20_000,
    waitPollMs: 20,
    directory: sessionsDir(dir),
    privateHome: privateHome(dir),
    lanes: true,
    laneManager: manager,
  }, master as unknown as DriverChild)
  await host.start()
  return { host, manager, pages, master }
}

async function busPeer(dir: string, name: string): Promise<GatewaySessionTransport> {
  const transport = new GatewaySessionTransport({
    directory: sessionsDir(dir), sessionId: randomUUID(), name, cwd: dir, purpose: 'test sender', policy: 'accept',
  })
  await transport.start()
  return transport
}

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function replyFor(sender: GatewaySessionTransport, messageId: string, ms = 5_000): Promise<any | null> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const found = sender.inbox().map(record => record.message as any).find(message => message.replyTo === messageId)
    if (found) return found
    await delay(20)
  }
  return null
}

describe('lane routing', () => {
  test('two writers get two windows and their turns run at the same time', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge('alpha', THREAD_A)
    const beta = await primedBridge('beta', THREAD_B)
    await seedHost(dir, [alpha, beta])
    const gate = new Gate(2)
    const master = new Page()
    const built = await startHost(dir, [alpha, beta], master, () => { const page = new Page(); page.gate = gate; return page })
    const one = await busPeer(dir, 'writer-one')
    const two = await busPeer(dir, 'writer-two')
    try {
      const sentOne = await one.send(alpha.sessionId, 'question from one', 'q1', undefined, 'inquiry', true) as { id?: string }
      const sentTwo = await two.send(beta.sessionId, 'question from two', 'q2', undefined, 'inquiry', true) as { id?: string }

      const replyOne = await replyFor(one, sentOne.id!)
      const replyTwo = await replyFor(two, sentTwo.id!)
      expect(replyOne?.text).toContain('answered on the page')
      expect(replyTwo?.text).toContain('answered on the page')
      // Both sends were in flight before either finished: lanes are parallel.
      expect(gate.overlap).toBe(true)
      expect(built.pages.size).toBe(2)
      const laneOne = built.pages.get(one.peer.sessionId)!
      const laneTwo = built.pages.get(two.peer.sessionId)!
      expect(laneOne.calls.filter(call => call.op === 'send').length).toBe(1)
      expect(laneTwo.calls.filter(call => call.op === 'send').length).toBe(1)
      expect(laneOne.calls.find(call => call.op === 'send')?.text).toContain('question from one')
      expect(laneTwo.calls.find(call => call.op === 'send')?.text).toContain('question from two')
      // The master window never typed.
      expect(master.calls.some(call => call.op === 'send')).toBe(false)
    } finally {
      await one.close()
      await two.close()
      await built.host.stop()
      await cleanup()
    }
  }, 30_000)

  test('one writer on two bridges keeps one window and serializes its turns', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge('alpha', THREAD_A)
    const beta = await primedBridge('beta', THREAD_B)
    await seedHost(dir, [alpha, beta])
    const master = new Page()
    const built = await startHost(dir, [alpha, beta], master, () => new Page())
    const writer = await busPeer(dir, 'single-writer')
    try {
      const first = await writer.send(alpha.sessionId, 'first', 'first', undefined, 'inquiry', true) as { id?: string }
      const second = await writer.send(beta.sessionId, 'second', 'second', undefined, 'inquiry', true) as { id?: string }
      expect((await replyFor(writer, first.id!))?.text).toContain('answered')
      expect((await replyFor(writer, second.id!))?.text).toContain('answered')
      // One sender id -> one lane, even across two bridges.
      expect(built.pages.size).toBe(1)
      const page = built.pages.get(writer.peer.sessionId)!
      expect(page.calls.filter(call => call.op === 'send').length).toBe(2)
      expect(page.maxActive).toBe(1)
    } finally {
      await writer.close()
      await built.host.stop()
      await cleanup()
    }
  }, 30_000)

  test('an empty completed answer keeps the no-answer line and recycles the lane', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge('alpha', THREAD_A)
    await seedHost(dir, [alpha])
    const master = new Page()
    const built = await startHost(dir, [alpha], master, () => { const page = new Page(); page.emptyAnswer = true; return page })
    const writer = await busPeer(dir, 'empty-writer')
    try {
      const sent = await writer.send(alpha.sessionId, 'anything', 'empty', undefined, 'inquiry', true) as { id?: string }
      const reply = await replyFor(writer, sent.id!)
      expect(reply?.text).toContain('no answer was produced for this message')
      // The bad window is gone, not kept for the next turn.
      for (let i = 0; i < 200 && built.manager.size > 0; i++) await delay(10)
      expect(built.manager.status().some(lane => lane.laneId === writer.peer.sessionId)).toBe(false)
      const page = built.pages.get(writer.peer.sessionId)!
      expect(page.calls.some(call => call.op === 'unload')).toBe(true)
    } finally {
      await writer.close()
      await built.host.stop()
      await cleanup()
    }
  }, 30_000)

  test('the route-health lane report comes from memory and names the live lanes', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge('alpha', THREAD_A)
    await seedHost(dir, [alpha])
    const master = new Page()
    const built = await startHost(dir, [alpha], master, () => new Page())
    const writer = await busPeer(dir, 'writer')
    try {
      const sent = await writer.send(alpha.sessionId, 'hello', 'hello', undefined, 'inquiry', true) as { id?: string }
      await replyFor(writer, sent.id!)
      const response = await fetch(`http://127.0.0.1:${built.host.port}/gateway/route-health?provider=chatgpt-web`)
      const body = await response.json() as any
      expect(body.lanes.max).toBe(8)
      expect(body.lanes.queued).toBe(0)
      expect(body.lanes.active.some((lane: any) => lane.laneId === writer.peer.sessionId)).toBe(true)
    } finally {
      await writer.close()
      await built.host.stop()
      await cleanup()
    }
  }, 30_000)
})
