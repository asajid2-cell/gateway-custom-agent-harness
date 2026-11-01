/**
 * G-010: the send CALL's deadline follows the child's own advertised total send
 * ceiling instead of the twenty-minute turn timeout.
 *
 * The child's `SEND_TIMEOUT_MS` is the budget of waiting for a reply AFTER
 * acceptance; its expiry is a defined reply, not a hang. A send's total child
 * time is the compose/click/acceptance budget (up to ~60 s) PLUS that reply
 * budget, so the ceiling the child advertises on `ready` is the total, and the
 * host waits total + transport margin. Setting the host deadline to the reply
 * budget alone would fire before the child's own reply on every slow accept.
 *
 * Three facts are proved here:
 *
 *  - the driver records the advertised ceiling per child and drops the claim
 *    when that child is replaced, exits, or is closed;
 *  - the host's send call uses ceiling + margin when it has one, and the turn
 *    timeout unchanged when it does not;
 *  - a replacement's new advertisement is the one used, and before it
 *    advertises the fallback applies.
 *
 * Self-contained on purpose: neighbouring lanes' files register suites at
 * import time and cannot be imported without running them.
 */
import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DriverChild } from './chatgpt-peer/driver.ts'
import { ChatGptHost } from './chatgpt-peer.ts'
import { GatewaySessionTransport } from '../src/utils/gatewaySessionTransport.js'
import type { DriverChild as DriverChildType, DriverReply } from './chatgpt-peer/driver.js'
import { newBridgeState, newHostState, saveJson, type BridgeState } from './chatgpt-peer/state.ts'

const THREAD_A = '11111111-1111-4111-8111-111111111111'

type Call = Record<string, unknown>
type CallOptions = { timeoutMs?: number; onAccepted?: (id: string) => void }

/**
 * The fixture child: it advertises a ceiling on startup (optionally late, like
 * a just-replaced child), accepts every send, and never replies to one. A send
 * therefore ends exactly the way the live 240 s ceiling ends it - accepted,
 * unfinished, the child's own reply never coming.
 */
const CHILD_SCRIPT = `
const ceiling = process.env.G010_CEILING
const delay = Number(process.env.G010_READY_DELAY_MS || 0)
function ready() {
  const line = { event: 'ready' }
  if (ceiling !== undefined && ceiling !== '' && Number.isFinite(Number(ceiling))) line.sendCeilingMs = Number(ceiling)
  process.stdout.write(JSON.stringify(line) + '\\n')
}
if (delay > 0) setTimeout(ready, delay); else ready()
process.stdin.setEncoding('utf8')
let buffer = ''
process.stdin.on('data', chunk => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (!line.trim()) continue
    let request
    try { request = JSON.parse(line) } catch { continue }
    if (request.op === 'quit') process.exit(0)
    if (request.op === 'send') {
      process.stdout.write(JSON.stringify({ event: 'accepted', id: request.id }) + '\\n')
    } else if (request.op === 'ping') {
      process.stdout.write(JSON.stringify({ ok: true, op: 'ping', id: request.id }) + '\\n')
    }
  }
})
`

async function scratch(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-peer-g010-'))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

async function childScript(dir: string): Promise<string> {
  const path = join(dir, 'g010-child.mjs')
  await writeFile(path, CHILD_SCRIPT, 'utf8')
  return path
}

async function waitFor<T>(probe: () => T | undefined | Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the driver')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describe('G-010: the driver owns the child-advertised send ceiling', () => {
  test('a send with no reply settles at the deadline the caller set, not the construction timeout', async () => {
    const { dir, cleanup } = await scratch()
    process.env.G010_CEILING = '120'
    delete process.env.G010_READY_DELAY_MS
    try {
      const driver = new DriverChild({ script: await childScript(dir), timeoutMs: 5_000 })
      try {
        // The driver spawns lazily; one ping brings the child up and its
        // advertisement arrives on the `ready` line before the ping's reply.
        expect((await driver.call({ op: 'ping' })).ok).toBe(true)
        expect(await waitFor(() => driver.sendCeilingMs ?? undefined)).toBe(120)
        const started = Date.now()
        const reply = await driver.call({ op: 'send', text: 'held open' }, 200)
        const elapsed = Date.now() - started
        expect(reply.reason).toBe('timeout')
        expect(elapsed).toBeGreaterThanOrEqual(150)
        // Nowhere near the 5 s construction timeout.
        expect(elapsed).toBeLessThan(3_000)
      } finally {
        await driver.kill()
      }
      // Closed: the next child must advertise for itself.
      expect(driver.sendCeilingMs).toBeNull()
    } finally {
      delete process.env.G010_CEILING
      await cleanup()
    }
  }, 20_000)

  test('a child that advertises nothing leaves the ceiling unknown', async () => {
    const { dir, cleanup } = await scratch()
    delete process.env.G010_CEILING
    delete process.env.G010_READY_DELAY_MS
    try {
      const driver = new DriverChild({ script: await childScript(dir), timeoutMs: 5_000 })
      try {
        expect((await driver.call({ op: 'ping' })).ok).toBe(true)
        expect(driver.sendCeilingMs).toBeNull()
      } finally {
        await driver.kill()
      }
    } finally {
      await cleanup()
    }
  }, 20_000)

  test('a replacement drops the old claim and the new advertisement is recorded', async () => {
    const { dir, cleanup } = await scratch()
    // The old child advertises a LARGE number, so a stale claim would be easy
    // to notice; the replacement advertises a small one.
    process.env.G010_CEILING = '800'
    delete process.env.G010_READY_DELAY_MS
    try {
      const driver = new DriverChild({ script: await childScript(dir), timeoutMs: 5_000 })
      try {
        expect((await driver.call({ op: 'ping' })).ok).toBe(true)
        expect(await waitFor(() => driver.sendCeilingMs ?? undefined)).toBe(800)
        // Accepted and unanswered: the timeout replaces this child, and a
        // replacement owns no claim until it speaks.
        expect((await driver.call({ op: 'send', text: 'held open' }, 150)).reason).toBe('timeout')
        expect(driver.sendCeilingMs).toBeNull()

        // The next spawn advertises late (a replacement still starting).
        process.env.G010_CEILING = '120'
        process.env.G010_READY_DELAY_MS = '250'
        expect((await driver.call({ op: 'ping' })).ok).toBe(true)
        // It answered the ping but has not advertised yet: unknown, not 800.
        expect(driver.sendCeilingMs).toBeNull()
        expect(await waitFor(() => driver.sendCeilingMs ?? undefined)).toBe(120)
      } finally {
        await driver.kill()
      }
    } finally {
      delete process.env.G010_CEILING
      delete process.env.G010_READY_DELAY_MS
      await cleanup()
    }
  }, 20_000)
})

/** A page whose sends are accepted and never answered, with a settable claim. */
class FakeDriver {
  readonly calls: Call[] = []
  /** What this "child" advertises on ready; null = nothing advertised. */
  sendCeilingMs: number | null = null
  /** The deadline the host asked this send call to use. */
  lastSendTimeoutMs: number | null = null
  /**
   * How long an unanswered send actually waits. Defaults to the deadline it was
   * given; a row may shorten it so an over-budget advertisement stays fast.
   */
  replyAfterMs: number | null = null
  /**
   * G-011: the child answers the send itself, at once, with the reply its own
   * send budget produces - `{ ok: false, timedOut: true, state: 'generating' }`.
   * The child is healthy; the host was simply blind behind the running send.
   */
  childTimesOut = false
  threads = [{ id: THREAD_A, title: 'Existing work' }]
  private current: string | null = THREAD_A
  /** The page reports `generating` only while a send is actually in flight. */
  private sending = false
  private tree = { current: `root-${THREAD_A}`, mapping: { [`root-${THREAD_A}`]: { id: `root-${THREAD_A}`, parent: null, children: [], message: null } } as Record<string, any> }
  private clock = Math.floor(Date.now() / 1000)

  private append(parent: string, role: 'user' | 'assistant', text: string): string {
    const id = randomUUID()
    this.tree.mapping[id] = {
      id, parent, children: [],
      message: {
        id, author: { role }, create_time: this.clock++,
        end_turn: role === 'assistant' ? true : null, status: 'finished_successfully',
        content: { content_type: 'text', parts: [text] },
      },
    }
    this.tree.mapping[parent]!.children.push(id)
    this.tree.current = id
    return id
  }

  onEvent(): () => void { return () => {} }
  emit(): void {}

  async call(request: Call, options: CallOptions = {}): Promise<DriverReply> {
    const op = String(request.op ?? '')
    this.calls.push({ ...request })
    if (op === 'ping') return { ok: true, op }
    if (op === 'threads') return { ok: true, op, threadId: this.current, threads: this.threads }
    if (op === 'use') return { ok: true, op, threadId: String(request.threadId ?? ''), url: `https://chatgpt.com/c/${request.threadId}`, adopted: true }
    if (op === 'send') {
      const budget = typeof options.timeoutMs === 'number' ? options.timeoutMs : null
      this.lastSendTimeoutMs = budget
      this.sending = true
      try {
        if (options.onAccepted) options.onAccepted(String(request.id ?? ''))
        this.append(this.tree.current, 'user', String(request.text ?? ''))
        if (this.childTimesOut) {
          // The child's own wait expired while the page was still generating.
          return { ok: false, op, timedOut: true, state: 'generating', threadId: this.current }
        }
        // Accepted, never answered: the call ends exactly when its own deadline
        // says so, which is the deadline this test is measuring.
        await sleep(this.replyAfterMs ?? budget ?? 0)
        return { ok: false, op, reason: 'timeout', timedOut: true, state: 'generating', threadId: this.current }
      } finally {
        this.sending = false
      }
    }
    if (op === 'read') return { ok: true, op, threadId: this.current, text: '', evidence: 'state-complete' }
    if (op === 'conversation') return { ok: true, op, conversation: { current_node: this.tree.current, mapping: structuredClone(this.tree.mapping) } }
    if (op === 'conversations') return { ok: true, op, items: this.threads }
    if (op === 'unload') { this.current = null; return { ok: true, op, state: 'unloaded' } }
    if (op === 'status') return { ok: true, op, threadId: this.current, model: 'GPT-6', effort: 'High', state: this.sending ? 'generating' : 'idle', phase: this.sending ? 'streaming' : null, ageMs: 0 }
    return { ok: false, op, error: `unknown op ${op}` }
  }

  async kill(): Promise<void> {}
  reopen(): void {}
}

const sessionsDir = (dir: string): string => join(dir, 'gateway-sessions')
const privateDir = (dir: string): string => join(dir, 'private')
const profileDir = (dir: string): string => join(dir, 'profile')

async function seedHost(dir: string, bridges: BridgeState[] = []): Promise<void> {
  await mkdir(join(dir, 'bridges'), { recursive: true })
  await saveJson(join(dir, 'peer.json'), newHostState({
    profile: profileDir(dir), healthPort: 0, idleUnloadMinutes: 0, instanceId: 'test',
  }))
  for (const bridge of bridges) await saveJson(join(dir, 'bridges', `${bridge.sessionId}.json`), bridge)
}

async function startHost(dir: string, driver: FakeDriver, extra: Record<string, unknown> = {}): Promise<ChatGptHost> {
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
    directory: sessionsDir(dir),
    privateHome: privateDir(dir),
    ...extra,
  }, driver as unknown as DriverChildType)
  await host.start()
  return host
}

const primerSha = async (): Promise<string> =>
  createHash('sha256').update(await readFile(join(import.meta.dir, 'chatgpt-peer', 'primer.md'), 'utf8'), 'utf8').digest('hex')

async function primedBridge(threadId = THREAD_A): Promise<BridgeState> {
  const bridge = newBridgeState({ sessionId: randomUUID(), name: 'alpha', threadId })
  bridge.primedThreadId = threadId
  bridge.primerSha256 = await primerSha()
  bridge.cursor = `root-${threadId}`
  return bridge
}

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

const repliesTo = (transport: GatewaySessionTransport, id: string): string[] =>
  transport.inbox()
    .filter(record => (record.message as unknown as { replyTo?: string }).replyTo === id)
    .map(record => String((record.message as unknown as { text: string }).text))

describe('G-010: the host send call follows ceiling + margin, else the turn timeout', () => {
  test('an advertised ceiling sets the call deadline to ceiling + margin', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.sendCeilingMs = 150
    const host = await startHost(dir, driver, { turnTimeoutMs: 3_000, sendCeilingMarginMs: 50 })
    try {
      const started = Date.now()
      const result = await host.promptForTest(alpha.sessionId, { text: 'a slow page' })
      const elapsed = Date.now() - started
      // 150 + 50; not the 3000 ms turn timeout.
      expect(driver.lastSendTimeoutMs).toBe(200)
      expect(elapsed).toBeGreaterThanOrEqual(170)
      expect(elapsed).toBeLessThan(1_500)
      expect(result.body.state).toBe('generating')
      expect(result.body.timedOut).toBe(true)
    } finally {
      await host.stop()
      await cleanup()
    }
  }, 20_000)

  test('without an advertisement the call keeps the turn timeout', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.sendCeilingMs = null
    const host = await startHost(dir, driver, { turnTimeoutMs: 400, sendCeilingMarginMs: 50 })
    try {
      const started = Date.now()
      const result = await host.promptForTest(alpha.sessionId, { text: 'an old child' })
      const elapsed = Date.now() - started
      expect(driver.lastSendTimeoutMs).toBe(400)
      expect(elapsed).toBeGreaterThanOrEqual(350)
      expect(elapsed).toBeLessThan(2_000)
      expect(result.body.state).toBe('generating')
    } finally {
      await host.stop()
      await cleanup()
    }
  }, 20_000)

  test('an advertisement larger than the turn timeout is honored, not clipped', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    // A future child may advertise more than the turn budget; clipping it would
    // cut that child's own (longer) reply off.
    driver.sendCeilingMs = 5_000
    driver.replyAfterMs = 10
    const host = await startHost(dir, driver, { turnTimeoutMs: 250, sendCeilingMarginMs: 50 })
    try {
      await host.promptForTest(alpha.sessionId, { text: 'an overlong claim' })
      expect(driver.lastSendTimeoutMs).toBe(5_050)
    } finally {
      await host.stop()
      await cleanup()
    }
  }, 20_000)

  test('each send reads the current child: a replacement falls back until it advertises, then its own number applies', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.sendCeilingMs = 120
    const host = await startHost(dir, driver, { turnTimeoutMs: 600, sendCeilingMarginMs: 40 })
    const budgets: (number | null)[] = []
    try {
      await host.promptForTest(alpha.sessionId, { text: 'first child' })
      budgets.push(driver.lastSendTimeoutMs)
      // The child is replaced and has not advertised: the fallback is used.
      driver.sendCeilingMs = null
      await host.promptForTest(alpha.sessionId, { text: 'replacement, not ready' })
      budgets.push(driver.lastSendTimeoutMs)
      // The replacement advertises its own ceiling.
      driver.sendCeilingMs = 250
      await host.promptForTest(alpha.sessionId, { text: 'replacement, ready' })
      budgets.push(driver.lastSendTimeoutMs)

      expect(budgets).toEqual([160, 600, 290])
    } finally {
      await host.stop()
      await cleanup()
    }
  }, 30_000)
})

/**
 * G-011: the child answering `{ ok: false, timedOut: true, state: 'generating' }`
 * after its own send budget is not a driver failure. The child is healthy; the
 * host is blind because every status read queues behind the running send on the
 * child's one operation chain. The turn must stay owed with no line to the
 * sender - and the audit must not claim a driver failure, because that is the
 * line incident triage reads.
 */
describe('G-011: a child-reported send timeout is attributed honestly', () => {
  test('the turn stays owed with no reply, and the audit names no driver failure', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.childTimesOut = true
    const host = await startHost(dir, driver, { turnTimeoutMs: 3_000, sendCeilingMarginMs: 50 })
    const sender = await busPeer(dir, 'sender')
    try {
      const receipt = await sender.transport.send(alpha.sessionId, 'a question the child times out on', 'g011', undefined, 'inquiry', true) as { id: string }
      const turnLine = await waitFor(async () => {
        const audit = await audits(dir)
        return audit.find(entry => entry.op === 'turn' && entry.messageId === receipt.id)
      })
      // (iii) The state is named honestly: no observation, reads queued behind
      // the send - not "the driver failed".
      expect(turnLine.result).toContain('still generating')
      expect(turnLine.result).toContain('no observation')
      expect(turnLine.result).not.toContain('driver failed')
      expect(turnLine.result).not.toContain('no evidence')
      // (i) Nothing is sent to the sender.
      expect(repliesTo(sender.transport, receipt.id)).toEqual([])
      // (ii) The turn is still owed, so the observation pass owns the answer.
      const bridge = await readBridge(dir, alpha.sessionId)
      expect(bridge.pendingTurns.some(turn => turn.messageId === receipt.id)).toBe(true)
    } finally {
      await sender.transport.close()
      await host.stop()
      await cleanup()
    }
  }, 30_000)
})
