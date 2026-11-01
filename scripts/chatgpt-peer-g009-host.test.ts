/**
 * G-009: a still-generating turn must not be reported to the sender as
 * "no answer was produced for this message".
 *
 * The live ordering (cnow, turn 79554a20, 2026-11-01):
 *
 *  05:52:03  the host logged "the page was still generating ... when the host
 *            stopped watching ... left for the observation pass" (driver fault:
 *            no line was sent, the job stayed owed);
 *  05:52:08  the observation pass resolved the send's own node, found an
 *            assistant node the completion test ACCEPTS but which carried no
 *            text, and settled it empty;
 *  05:52:08  the sender was told "no answer was produced for this message" and
 *            the job was retired - so the answer that arrived on the page
 *            afterwards was never delivered.
 *
 * The first row reproduces that ordering and is RED at 6d574ce: the observation
 * pass sends the false negative and retires the turn before the real answer
 * exists. The second row is the other half of the rule: a genuinely empty
 * answer on an IDLE page is still allowed to say so.
 *
 * Self-contained on purpose: neighbouring lanes' files register suites at
 * import time and cannot be imported without running them.
 */
import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GatewaySessionTransport } from '../src/utils/gatewaySessionTransport.js'
import { ChatGptHost } from './chatgpt-peer.ts'
import type { DriverChild, DriverReply } from './chatgpt-peer/driver.js'
import { newBridgeState, newHostState, saveJson, type BridgeState } from './chatgpt-peer/state.ts'

const THREAD_A = '11111111-1111-4111-8111-111111111111'

type Call = Record<string, unknown>
type CallOptions = { timeoutMs?: number; onAccepted?: (id: string) => void }

/** The frozen child protocol, in memory. One page, one active thread. */
class FakeDriver {
  readonly calls: Call[] = []
  threads = [{ id: THREAD_A, title: 'Existing work' }]
  /** The send waits out its budget while the page generates. */
  holdSend = false
  /** The text an accepted send returns on the same request (`null` = no text). */
  sendText: string | null = 'answered on the page'
  signal: { phase: 'streaming' | 'complete'; threadId: string | null; at: number } = { phase: 'complete', threadId: null, at: 0 }
  lastUserNode: string | null = null
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

  private append(threadId: string, parent: string, role: 'user' | 'assistant', text: string | string[]): string {
    const tree = this.treeOf(threadId)
    const id = randomUUID()
    const parts = typeof text === 'string' ? [text] : text
    tree.mapping[id] = {
      id,
      parent,
      children: [],
      message: {
        id,
        author: { role },
        create_time: this.clock++,
        end_turn: role === 'assistant' ? true : null,
        status: 'finished_successfully',
        content: { content_type: 'text', parts },
      },
    }
    tree.mapping[parent]!.children.push(id)
    tree.current = id
    if (role === 'user') this.lastUserNode = id
    return id
  }

  /**
   * The live page shape the incident turned on: an assistant node the
   * completion test accepts (`finished_successfully`, `end_turn: true`) whose
   * text parts are empty. `answerFor` names it, `nodeTextOf` is ''.
   */
  placeholder(threadId: string, parent: string): string { return this.append(threadId, parent, 'assistant', []) }

  /** The real answer, a newer sibling under the same send (the page's newest). */
  realAnswer(threadId: string, parent: string, text: string): string {
    const id = this.append(threadId, parent, 'assistant', text)
    this.signal = { phase: 'complete', threadId, at: Date.now() }
    return id
  }

  /** `create_time` for a node, so a test can name the send's own node. */
  nodeOf(threadId: string): string | null { return this.lastUserNode }

  onEvent(): () => void { return () => {} }
  emit(): void {}

  async call(request: Call, options: CallOptions = {}): Promise<DriverReply> {
    const op = String(request.op ?? '')
    if (op === 'ping') return { ok: true, op }
    this.calls.push({ ...request })
    if (op === 'threads') return { ok: true, op, threadId: this.current, threads: this.threads }
    if (op === 'use') {
      const threadId = String(request.threadId ?? '')
      this.current = threadId
      return { ok: true, op, threadId, url: `https://chatgpt.com/c/${threadId}`, adopted: true }
    }
    if (op === 'send') {
      const threadId = this.current ?? THREAD_A
      if (options.onAccepted) options.onAccepted(String(request.id ?? ''))
      const userNode = this.append(threadId, this.treeOf(threadId).current, 'user', String(request.text ?? ''))
      if (this.holdSend) {
        // The page generates; a node exists under the send that the completion
        // test accepts but that carries no text yet.
        this.placeholder(threadId, userNode)
        this.signal = { phase: 'streaming', threadId, at: Date.now() }
        // The DRIVER's own deadline, in the shape driver.ts actually produces
        // (`reason: 'timeout'`, no `timedOut` flag). The flag means the CHILD
        // stated the timeout instead - a different attribution (G-011).
        return { ok: false, op, reason: 'timeout', error: 'driver timed out after 900ms', state: 'generating', threadId }
      }
      this.signal = { phase: 'complete', threadId, at: Date.now() }
      if (request.wait === true) {
        return { ok: true, op, text: this.sendText ?? '', threadId, model: 'GPT-6', effort: 'High' }
      }
      return { ok: true, op, threadId, model: 'GPT-6', effort: 'High' }
    }
    if (op === 'read') return { ok: true, op, threadId: this.current, text: this.sendText ?? '', evidence: 'state-complete' }
    if (op === 'conversation') {
      const threadId = String(request.threadId ?? '')
      const tree = this.treeOf(threadId)
      return { ok: true, op, conversation: { current_node: tree.current, mapping: structuredClone(tree.mapping) } }
    }
    if (op === 'conversations') {
      const offset = Number(request.offset ?? 0)
      const limit = Number(request.limit ?? 100)
      return { ok: true, op, items: this.threads.slice(offset, offset + limit) }
    }
    if (op === 'unload') { this.current = null; return { ok: true, op, state: 'unloaded' } }
    if (op === 'status') {
      const asked = typeof request.threadId === 'string' ? request.threadId : ''
      if (!asked) return { ok: true, op, threadId: this.current, model: 'GPT-6', effort: 'High' }
      const at = this.signal.at === 0 ? null : new Date(this.signal.at).toISOString()
      return {
        ok: true, op, cost: 'push', threadId: asked,
        pushedThreadId: this.signal.threadId,
        matchesThread: this.signal.threadId === null ? null : this.signal.threadId === asked,
        state: this.pushedFor(asked), phase: this.signal.phase === 'streaming' ? 'streaming' : 'complete',
        ageMs: this.signal.at === 0 ? null : Date.now() - this.signal.at, at,
      }
    }
    return { ok: false, op, error: `unknown op ${op}` }
  }

  private pushedFor(threadId: string): 'generating' | 'idle' | 'unknown' {
    if (this.signal.threadId && this.signal.threadId !== threadId) return 'unknown'
    return this.signal.phase === 'streaming' ? 'generating' : 'idle'
  }

  async kill(): Promise<void> {}
  reopen(): void {}
}

async function scratch(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-peer-g009-'))
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
    observeEvery: 0,
    titlesEvery: 0,
    turnTimeoutMs: 900,
    waitPollMs: 20,
    pendingWatchGapsMs: [60_000, 120_000],
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

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

const primerSha = async (): Promise<string> =>
  sha256(await readFile(join(import.meta.dir, 'chatgpt-peer', 'primer.md'), 'utf8'))

async function readBridge(dir: string, sessionId: string): Promise<BridgeState> {
  return JSON.parse(await readFile(join(dir, 'bridges', `${sessionId}.json`), 'utf8')) as BridgeState
}

async function audits(dir: string): Promise<{ op: string; target: string | null; result: string; messageId?: string | null }[]> {
  const state = JSON.parse(await readFile(join(dir, 'peer.json'), 'utf8')) as { audit: { op: string; target: string | null; result: string; messageId?: string | null }[] }
  return state.audit
}

async function busPeer(dir: string, name: string): Promise<{ transport: GatewaySessionTransport; id: string }> {
  const id = randomUUID()
  const transport = new GatewaySessionTransport({
    directory: sessionsDir(dir), sessionId: id, name, cwd: dir, purpose: 'test sender', policy: 'accept',
  })
  await transport.start()
  return { transport, id }
}

async function primedBridge(threadId = THREAD_A): Promise<BridgeState> {
  const bridge = newBridgeState({ sessionId: randomUUID(), name: 'alpha', threadId })
  bridge.primedThreadId = threadId
  bridge.primerSha256 = await primerSha()
  // A real node on the branch: classification is by position after the cursor.
  bridge.cursor = `root-${threadId}`
  return bridge
}

const repliesTo = (transport: GatewaySessionTransport, id: string): string[] =>
  transport.inbox()
    .filter(record => (record.message as unknown as { replyTo?: string }).replyTo === id)
    .map(record => String((record.message as unknown as { text: string }).text))

const sendCount = (driver: FakeDriver): number => driver.calls.filter(call => call.op === 'send').length

describe('G-009: a still-generating turn is never told it produced no answer', () => {
  test('the observation pass holds a text-empty answer node while the page is generating and delivers the real answer later', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.holdSend = true
    const host = await startHost(dir, driver)
    const sender = await busPeer(dir, 'sender')
    try {
      const receipt = await sender.transport.send(alpha.sessionId, 'a question the page answers later', 'g009', undefined, 'inquiry', true) as { id: string }
      const messageId = receipt.id

      // The direct turn ends "still generating" with a driver fault: nothing is
      // sent and the job stays owed (the live 05:52:03 line).
      const turnLine = await waitFor(async () => {
        const audit = await audits(dir)
        return audit.find(entry => entry.op === 'turn' && entry.messageId === messageId && /still generating/.test(entry.result))
      })
      expect(turnLine.result).toContain('no evidence')
      expect(repliesTo(sender.transport, messageId)).toEqual([])

      // The observation pass finds the send's own node and an accepted but
      // TEXT-EMPTY assistant node under it. The page still says generating.
      await host.pollOnce()

      // THE DEFECT SITE: the sender must not be told there was no answer while
      // the page is still working, and the turn must stay owed so the answer
      // that arrives later is delivered.
      expect(repliesTo(sender.transport, messageId)).toEqual([])
      const owed = await readBridge(dir, alpha.sessionId)
      expect(owed.pendingTurns.some(turn => turn.messageId === messageId)).toBe(true)

      // The page finishes: the real answer is a newer sibling under the send.
      const userNode = driver.nodeOf(THREAD_A)!
      driver.realAnswer(THREAD_A, userNode, 'the real answer, delivered late')
      await host.pollOnce()

      const replies = repliesTo(sender.transport, messageId)
      expect(replies.length).toBe(1)
      expect(replies[0]).toContain('the real answer, delivered late')
      expect(replies.join('\n')).not.toContain('no answer was produced')
      // The turn was never re-posted, and it is retired only after delivery.
      expect(sendCount(driver)).toBe(1)
      expect((await readBridge(dir, alpha.sessionId)).pendingTurns.some(turn => turn.messageId === messageId)).toBe(false)
    } finally {
      await sender.transport.close()
      await host.stop()
      await cleanup()
    }
  }, 30_000)
})

describe('G-009: a genuinely empty answer on an idle page still says so', () => {
  test('an idle page whose completed answer is empty keeps the no-answer line', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.sendText = ''
    const host = await startHost(dir, driver)
    const sender = await busPeer(dir, 'sender')
    try {
      const receipt = await sender.transport.send(alpha.sessionId, 'an empty answer, please', 'g009', undefined, 'inquiry', true) as { id: string }
      const replies = await waitFor(() => {
        const found = repliesTo(sender.transport, receipt.id)
        return found.length > 0 ? found : undefined
      })
      // The page is idle and its completed answer carries nothing: the sender
      // is told so, exactly once. This is the allowed half of the rule.
      expect(replies.length).toBe(1)
      expect(replies[0]).toContain('no answer was produced for this message')
      expect(sendCount(driver)).toBe(1)
    } finally {
      await sender.transport.close()
      await host.stop()
      await cleanup()
    }
  }, 30_000)
})
