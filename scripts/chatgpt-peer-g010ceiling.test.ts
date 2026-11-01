/**
 * G-010 acceptance fixture, HOST layer: the send deadline follows the child.
 *
 * The layer decision (2026-11-01, head) puts the send deadline in the host:
 * `ChatGptHost.sendCallTimeout` reads the ceiling the child advertised on
 * `ready` and passes `ceiling + margin` as the send call's `timeoutMs`. The
 * driver only records the claim per child generation and drops it when that
 * child is replaced, exits, is killed or terminated, or re-announces itself
 * without it. A caller owns its own deadline; the driver must never invent one.
 *
 * CONTRACT under test (host half; the child half is #44's):
 *
 *  - a send call's deadline is `sendCeilingMs + sendCeilingMarginMs`;
 *  - there is NO cap at `turnTimeout`: a ceiling larger than it wins, and the
 *    host logs a warning instead of clipping the child's own reply;
 *  - the fallback is `turnTimeout` when `sendCeilingMs` is absent, non-finite,
 *    or <= 0;
 *  - the ceiling belongs to the generation that advertised it;
 *  - an attachment adds `sendAttachCreditMs` ONCE per attached file:
 *    `ceiling + margin + credit × attachCount`, and an absent credit is 0.
 *
 * Every row drives the real `ChatGptHost` through a real bus inbound (the only
 * way peer work reaches a send) and a real `DriverChild` spawning a real OS
 * child that speaks the frozen line-JSON protocol. The only thing this fixture
 * adds to the driver is a recorder of the `timeoutMs` the host handed it, which
 * is exactly the host-level decision under test; the timer, the child and the
 * protocol are the production ones. No mock, no live host, no real browser.
 *
 * Slack: spawn and event-loop overhead are not part of the deadline, so every
 * timing assertion allows +2_000 ms over the semantic deadline and requires the
 * settle to be strictly before the alternative whenever the two are
 * distinguishable.
 *
 * MEASURED, same command both sides (`bun test
 * scripts/chatgpt-peer-g010ceiling.test.ts`, the file run alone):
 *
 *  - base `782b646`: 2 pass / 5 fail, 31.43 s, 33.35 s and 33.53 s (three
 *    identical runs). RED rows 1, 4, 5, 6 and 7 - the whole deadline, the
 *    driver claim row 4 starts with, the no-cap rule, the replacement bound,
 *    and every attach clause; rows 2 and 3 GREEN, because the fallback really
 *    is the turn timeout at both layers. Rows 2/3 are here so that fallback
 *    cannot silently become "no deadline at all" once the ceiling path lands.
 *  - `2f56920` (#46's host half on top of the child's advertised credit):
 *    7 pass / 0 fail, 49 `expect()` calls, 42.15 s and 42.59 s from two
 *    independently produced runs in this lane (the head's own worktree at the
 *    same sha reports 7/0 in 39.63 s). Per-row wall time: 1 2.84 s, 2 2.29 s,
 *    3 14.13 s (six hosts), 4 7.25 s, 5 7.71 s, 6 2.45 s, 7 4.73 s. Observed
 *    deadlines: row 1 armed 500 / settled 502 ms; row 2 200 / 200; row 3 all
 *    200 / 200-202; row 4 phase A 500 / 501 and phase B 3 000 / 3 002;
 *    row 5 5 200 / 5 201; row 6 500 / 501 with `replacing the child (accepted
 *    but unfinished: r4)`; row 7 500 vs 300 500 with the credit, 500 / 500
 *    without it.
 *
 * This is the acceptance gate for G-010. It is not the fixture that produced
 * the original driver-level measurement (`chatgpt-g010ceiling` @ `fc5663d`).
 */
import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GatewaySessionTransport } from '../src/utils/gatewaySessionTransport.js'
import { ChatGptHost } from './chatgpt-peer.ts'
import { DriverChild, type CallOptions, type DriverReply } from './chatgpt-peer/driver.ts'
import { newBridgeState, newHostState, saveJson, type BridgeState } from './chatgpt-peer/state.ts'

const THREAD = '11111111-1111-4111-8111-111111111111'

/** The text marker this fixture's child treats as "accept it, then go quiet". */
const STALL = 'hold-this-send'

/** The ceiling and margin every chatty row advertises / configures. */
const CEILING = 300
const MARGIN = 200
/** #44's advertised attach credit (180 s input + 120 s chip poll). */
const CREDIT = 300_000
const SLACK_MS = 2_000

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

// ---------------------------------------------------------------- fake page

/**
 * The fake page, as a real child process on the frozen line-JSON protocol.
 *
 * `ceiling`/`credit` are JS expressions spliced into the ready line, so `0`,
 * `-5`, `'abc'`, `'Infinity'` and `null` can all be advertised literally. With
 * `firstOnly`, only the first process reads the counter file, so a replacement
 * child announces itself with no claim at all.
 *
 * A send whose text contains `STALL` is accepted and never answered (a lost
 * reply). Anything else is accepted and answered at once. An `advertise` op
 * re-emits this child's ready line; `advertise-none` emits one with no claim,
 * which is how a live child can be made to drop a claim it made earlier.
 */
function childSource(spec: {
  ceiling: string | null
  credit?: string | null
  counter?: string | null
  firstOnly?: boolean
}): string {
  const fields = [
    spec.ceiling === null ? '' : `sendCeilingMs: ${spec.ceiling}`,
    spec.credit == null ? '' : `sendAttachCreditMs: ${spec.credit}`,
  ].filter(Boolean).join(', ')
  const ready = `{ event: 'ready', pid: process.pid${fields ? `, ${fields}` : ''} }`
  const announce = spec.firstOnly
    ? `if (seen === 0) emit(${ready})\nelse emit({ event: 'ready', pid: process.pid })`
    : `emit(${ready})`
  return `
const fs = require('node:fs')
const readline = require('node:readline')
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n')
const COUNTER = ${JSON.stringify(spec.counter ?? null)}
const THREAD = ${JSON.stringify(THREAD)}
const STALL = ${JSON.stringify(STALL)}
let seen = 0
if (COUNTER) {
  try { seen = fs.existsSync(COUNTER) ? fs.readFileSync(COUNTER, 'utf8').split('\\n').filter(Boolean).length : 0 } catch { seen = 0 }
  try { fs.appendFileSync(COUNTER, 'x\\n') } catch {}
}
${announce}
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', line => {
  let request
  try { request = JSON.parse(line) } catch { return }
  const id = request.id
  const op = String(request.op || '')
  if (op === 'quit') { emit({ ok: true, op, id }); process.exit(0) }
  if (op === 'bye') { emit({ ok: true, op, id }); setTimeout(() => process.exit(0), 5); return }
  if (op === 'advertise') { emit(${ready}); emit({ ok: true, op, id }); return }
  if (op === 'advertise-none') { emit({ event: 'ready', pid: process.pid }); emit({ ok: true, op, id }); return }
  if (op === 'ping') { emit({ ok: true, op, id }); return }
  if (op === 'threads') { emit({ ok: true, op, id, threadId: THREAD, threads: [{ id: THREAD, title: 'fixture' }] }); return }
  if (op === 'use') { emit({ ok: true, op, id, threadId: String(request.threadId || THREAD), url: 'https://chatgpt.com/c/' + THREAD, adopted: true }); return }
  if (op === 'reload') { emit({ ok: true, op, id, threadId: String(request.threadId || THREAD) }); return }
  if (op === 'status') { emit({ ok: true, op, id, state: 'idle', threadId: String(request.threadId || THREAD), phase: null }); return }
  if (op === 'conversation') { emit({ ok: true, op, id, threadId: String(request.threadId || THREAD), conversation: { mapping: {} } }); return }
  if (op === 'read') { emit({ ok: true, op, id, threadId: THREAD, text: 'fixture answer', evidence: 'state-complete' }); return }
  if (op === 'send') {
    const text = String(request.text || '')
    const held = text.indexOf(STALL) !== -1
    setTimeout(() => emit({ event: 'accepted', id }), Number(request.acceptAfterMs || 0))
    if (held) return
    setTimeout(() => emit({ ok: true, op, id, text: 'fixture answer', threadId: String(request.threadId || THREAD), model: 'GPT-6', effort: 'High' }), 5)
    return
  }
  emit({ ok: true, op, id })
})
`
}

// ------------------------------------------------------------- the recorder

interface CallRecord {
  op: string
  request: Record<string, unknown>
  /** The deadline the HOST handed the driver. This is the contract under test. */
  timeoutMs: number
  at: number
  settledAt?: number
  reply?: DriverReply
}

/**
 * The real `DriverChild`, plus a record of the deadline each call was handed.
 *
 * The host is the party that decides a send's deadline now, so the value it
 * passes is the thing to assert; the timer, child and protocol are the real
 * ones and the call really does settle at that deadline.
 */
class RecordingDriver extends DriverChild {
  readonly calls: CallRecord[] = []

  constructor(options: ConstructorParameters<typeof DriverChild>[0] & { log: (line: string) => void }) {
    super(options)
  }

  override async call(request: Record<string, unknown>, options: number | CallOptions = 600_000): Promise<DriverReply> {
    const settings = typeof options === 'number' ? { timeoutMs: options } : options
    const record: CallRecord = {
      op: String(request.op ?? ''),
      request,
      timeoutMs: settings.timeoutMs ?? 600_000,
      at: Date.now(),
    }
    this.calls.push(record)
    const reply = super.call(request, options)
    void reply.then(
      value => { record.settledAt = Date.now(); record.reply = value },
      () => { record.settledAt = Date.now() },
    )
    return reply
  }
}

const ceilingOf = (driver: DriverChild): number | null =>
  (driver as unknown as { sendCeilingMs?: number | null }).sendCeilingMs ?? null

const generationOf = (driver: DriverChild): number =>
  (driver as unknown as { generation: number }).generation

/** Wait for a call's own timer to fire, failing fast with a readable message. */
async function settled(call: CallRecord, boundMs: number, label: string): Promise<number> {
  const started = Date.now()
  while (call.settledAt === undefined) {
    if (Date.now() - started > boundMs) {
      throw new Error(`${label}: the send did not settle within ${boundMs} ms (the host armed it at ${call.timeoutMs} ms)`)
    }
    await delay(5)
  }
  return call.settledAt - call.at
}

// ------------------------------------------------------------------ scratch

async function scratch(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'g010-host-'))
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

async function startHost(dir: string, driver: DriverChild, turnTimeoutMs: number): Promise<ChatGptHost> {
  process.env.CLAUDE_CONFIG_DIR = dir
  const host = new ChatGptHost({
    home: dir,
    statePath: join(dir, 'peer.json'),
    driverPath: join(dir, 'unused-child.mjs'),
    profile: profileDir(dir),
    instanceId: 'test',
    healthPort: 0,
    idleUnloadMinutes: 0,
    number: 1,
    pollSeconds: 0,
    observeEvery: 0,
    titlesEvery: 0,
    turnTimeoutMs,
    // Ignored by a base build; the knob the host layer adds.
    sendCeilingMarginMs: MARGIN,
    waitPollMs: 20,
    directory: sessionsDir(dir),
    privateHome: privateHome(dir),
  } as never, driver)
  await host.start()
  return host
}

async function waitFor<T>(probe: () => Promise<T | undefined> | T | undefined, timeoutMs = 10_000): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the host')
    await delay(25)
  }
}

const bridgeNamed = (name: string, threadId: string | null): BridgeState =>
  newBridgeState({ sessionId: randomUUID(), name, threadId })

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

const primerSha = async (): Promise<string> =>
  sha256(await readFile(join(import.meta.dir, 'chatgpt-peer', 'primer.md'), 'utf8'))

/** A bridge whose primer is already posted, so a turn starts with its own send. */
async function primed(name: string, threadId: string): Promise<BridgeState> {
  const bridge = bridgeNamed(name, threadId)
  bridge.primedThreadId = threadId
  bridge.primerSha256 = await primerSha()
  return bridge
}

/** A real bus peer in the scratch directory (the sender of every turn). */
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

const repliesTo = (sender: GatewaySessionTransport, messageId: string): PeerMessage[] =>
  inboxMessages(sender).filter(message => message.replyTo === messageId)

async function sendInbound(sender: GatewaySessionTransport, to: string, text: string, summary: string): Promise<string> {
  const receipt = await sender.send(to, text, summary, undefined, 'inquiry', true) as { id?: string }
  if (!receipt?.id) throw new Error('the sender got no message id')
  return receipt.id
}

/** Capture the host's own audit/warning lines (`log` writes to stderr). */
function captureHostLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const stream = process.stderr as any
  const original = stream.write
  stream.write = function (chunk: any, ...rest: any[]): boolean {
    lines.push(typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk))
    return original.apply(stream, [chunk, ...rest])
  }
  return { lines, restore: () => { stream.write = original } }
}

// --------------------------------------------------------------- one turn

interface StalledTurn {
  dir: string
  cleanup: () => Promise<void>
  bridge: BridgeState
  driver: RecordingDriver
  host: ChatGptHost
  sender: GatewaySessionTransport
  messageId: string
  /** The send call the host issued for the inbound message. */
  call: CallRecord
}

async function stalledTurn(options: {
  turnTimeoutMs: number
  ceiling: string | null
  credit?: string | null
  firstOnly?: boolean
  logs?: string[]
}): Promise<StalledTurn> {
  const { dir, cleanup } = await scratch()
  const bridge = await primed('alpha', THREAD)
  await seedHost(dir, [bridge])
  const sender = await busPeer(dir, 'sender')
  const script = join(dir, 'page-child.js')
  await writeFile(script, childSource({
    ceiling: options.ceiling,
    credit: options.credit ?? null,
    counter: options.firstOnly ? join(dir, 'spawns.txt') : null,
    firstOnly: options.firstOnly === true,
  }))
  const logs = options.logs ?? []
  const driver = new RecordingDriver({
    script,
    wedgeMs: 600_000,
    lostReplyMarginMs: 100,
    log: (line: string) => { logs.push(line) },
  })
  const host = await startHost(dir, driver, options.turnTimeoutMs)
  // The host pings at boot; the ready line is written before the child reads
  // stdin, so a settled ping proves this generation's claim has been recorded.
  await waitFor(() => driver.calls.some(call => call.op === 'ping' && call.settledAt !== undefined), 5_000)
  const messageId = await sendInbound(sender, bridge.sessionId, `please ${STALL} this page`, 'g010 send')
  const call = await waitFor(
    () => driver.calls.find(item => item.op === 'send' && String(item.request.text ?? '').includes(STALL)),
    8_000,
  )
  return { dir, cleanup, bridge, driver, host, sender, messageId, call }
}

async function closeTurn(turn: StalledTurn): Promise<void> {
  await turn.sender.close().catch(() => {})
  await turn.host.stop().catch(() => {})
  await turn.cleanup()
}

describe('G-010 host: the send deadline follows the child ceiling', () => {
  // Row 1: the ceiling is honoured -------------------------------------------
  test('1. a stalled send settles at ceiling + margin, strictly before the turn timeout', async () => {
    const turn = await stalledTurn({ turnTimeoutMs: 60_000, ceiling: String(CEILING) })
    try {
      const elapsed = await settled(turn.call, CEILING + MARGIN + SLACK_MS, 'ROW 1 (ceiling honoured)')
      console.log(`[G-010] row 1: host armed ${turn.call.timeoutMs} ms; settled ${elapsed} ms after the send (ceiling ${CEILING} + margin ${MARGIN}; turnTimeout 60 000)`)
      expect(turn.call.timeoutMs).toBe(CEILING + MARGIN)
      expect(elapsed).toBeGreaterThanOrEqual(CEILING)
      expect(elapsed).toBeLessThan(CEILING + MARGIN + SLACK_MS)
      expect(elapsed).toBeLessThan(60_000)
      expect(turn.call.reply?.reason).toBe('timeout')
    } finally {
      await closeTurn(turn)
    }
  }, 20_000)

  // Row 2: no ceiling -> the turn timeout -------------------------------------
  test('2. a child that advertises no ceiling is bounded by turnTimeout', async () => {
    const turn = await stalledTurn({ turnTimeoutMs: 200, ceiling: null })
    try {
      const elapsed = await settled(turn.call, 4_000, 'ROW 2 (fallback absent)')
      console.log(`[G-010] row 2: host armed ${turn.call.timeoutMs} ms; settled ${elapsed} ms (turnTimeout 200)`)
      expect(turn.call.timeoutMs).toBe(200)
      expect(turn.call.reply?.reason).toBe('timeout')
      expect(elapsed).toBeGreaterThanOrEqual(120)
      expect(elapsed).toBeLessThan(200 + SLACK_MS)
    } finally {
      await closeTurn(turn)
    }
  }, 20_000)

  // Row 3: junk ceilings fall back --------------------------------------------
  test('3. a ceiling that is 0, negative, non-numeric or non-finite falls back to turnTimeout', async () => {
    const cases: Array<{ label: string; ceiling: string }> = [
      { label: 'zero', ceiling: '0' },
      { label: 'negative', ceiling: '-5' },
      { label: 'non-numeric', ceiling: "'abc'" },
      { label: 'NaN-string', ceiling: "'NaN'" },
      { label: 'Infinity-string', ceiling: "'Infinity'" },
      // JSON has no Infinity: a child sending the JS value puts null on the wire.
      { label: 'null', ceiling: 'null' },
    ]
    for (const one of cases) {
      const turn = await stalledTurn({ turnTimeoutMs: 200, ceiling: one.ceiling })
      try {
        const elapsed = await settled(turn.call, 4_000, `ROW 3 (${one.label})`)
        console.log(`[G-010] row 3 ${one.label} (sendCeilingMs: ${one.ceiling}): host armed ${turn.call.timeoutMs} ms; settled ${elapsed} ms`)
        expect(turn.call.timeoutMs).toBe(200)
        expect(turn.call.reply?.reason).toBe('timeout')
        expect(elapsed).toBeGreaterThanOrEqual(120)
        expect(elapsed).toBeLessThan(200 + SLACK_MS)
      } finally {
        await closeTurn(turn)
      }
    }
  }, 60_000)

  // Row 4: the claim dies with its generation --------------------------------
  test('4. the claim dies with its child (driver) and does not bound the replacement (host)', async () => {
    // --- phase 0: driver-level clear sites ----------------------------------
    const direct = await scratch()
    const script = join(direct.dir, 'ceiling-child.js')
    await writeFile(script, childSource({ ceiling: '300' }))
    const logs: string[] = []
    const driver = new RecordingDriver({ script, wedgeMs: 600_000, lostReplyMarginMs: 100, log: (line: string) => { logs.push(line) } })
    try {
      await driver.call({ op: 'ping' }, 5_000)
      await waitFor(() => ceilingOf(driver) !== null, 5_000)
      expect(ceilingOf(driver)).toBe(300)
      // A ready that OMITS the field clears the claim rather than inheriting it.
      await driver.call({ op: 'advertise-none' }, 5_000)
      await waitFor(() => ceilingOf(driver) === null, 5_000)
      // ...and one that states it again re-establishes it.
      await driver.call({ op: 'advertise' }, 5_000)
      await waitFor(() => ceilingOf(driver) === 300, 5_000)
      // kill() and terminate() clear it: the claim belongs to the child it
      // described, so a closed driver must not hand it to a later child.
      await driver.kill()
      expect(ceilingOf(driver)).toBeNull()
      driver.reopen()
      await driver.call({ op: 'ping' }, 5_000)
      await waitFor(() => ceilingOf(driver) === 300, 5_000)
      await driver.terminate()
      expect(ceilingOf(driver)).toBeNull()
    } finally {
      await driver.terminate().catch(() => {})
      await direct.cleanup()
    }

    // --- phase A: the host honours the first child's claim -------------------
    const turn = await stalledTurn({ turnTimeoutMs: 3_000, ceiling: String(CEILING), firstOnly: true })
    try {
      const firstElapsed = await settled(turn.call, CEILING + MARGIN + SLACK_MS, 'ROW 4 phase A (first child honours 300+200)')
      // Phase A is a PRECONDITION: a red here means the ceiling was never
      // honoured at all, so phase B's scoping assertion would be meaningless.
      // Phase B (below) is the actual scoping assertion.
      if (turn.call.timeoutMs !== CEILING + MARGIN) {
        throw new Error(`ROW 4 phase A: the host armed ${turn.call.timeoutMs} ms, not the advertised ${CEILING}+${MARGIN} ms (settled at ${firstElapsed} ms)`)
      }
      expect(firstElapsed).toBeLessThan(CEILING + MARGIN + SLACK_MS)

      // The timeout was on an accepted id, so the driver replaced that child.
      // A replacement announces itself with no claim (firstOnly), and the old
      // claim must not survive it.
      await waitFor(() => ceilingOf(turn.driver) === null, 3_000)
      expect(ceilingOf(turn.driver)).toBeNull()
      const generationAfterFirst = generationOf(turn.driver)

      // --- phase B: the stale 500 ms does not bound the next send -----------
      await sendInbound(turn.sender, turn.bridge.sessionId, `please ${STALL} it again`, 'g010 send two')
      const second = await waitFor(
        () => turn.driver.calls.find(item => item.op === 'send' && item.at > turn.call.at && String(item.request.text ?? '').includes(STALL)),
        8_000,
      )
      const secondElapsed = await settled(second, 3_000 + SLACK_MS, 'ROW 4 phase B (replacement keeps the fallback)')
      console.log(`[G-010] row 4: phase A armed ${turn.call.timeoutMs} ms (settled ${firstElapsed} ms); phase B armed ${second.timeoutMs} ms (settled ${secondElapsed} ms, turnTimeout 3 000)`)
      expect(second.timeoutMs).toBe(3_000)
      expect(secondElapsed).toBeGreaterThanOrEqual(CEILING + MARGIN)
      await turn.driver.call({ op: 'ping' }, 5_000)
      expect(generationOf(turn.driver)).toBeGreaterThan(generationAfterFirst)
    } finally {
      await closeTurn(turn)
    }
  }, 40_000)

  // Row 5: no cap at turnTimeout ---------------------------------------------
  test('5. a ceiling larger than turnTimeout wins and the host logs a warning', async () => {
    const capture = captureHostLog()
    let turn: StalledTurn | undefined
    try {
      turn = await stalledTurn({ turnTimeoutMs: 1_000, ceiling: '5000' })
      const elapsed = await settled(turn.call, 5_200 + SLACK_MS, 'ROW 5 (no cap)')
      console.log(`[G-010] row 5: host armed ${turn.call.timeoutMs} ms; settled ${elapsed} ms (ceiling 5 000 + margin ${MARGIN}; turnTimeout 1 000)`)
      // deadline = 5000 + 200; the turnTimeout of 1 000 must NOT clamp it.
      expect(turn.call.timeoutMs).toBe(5_200)
      expect(elapsed).toBeGreaterThanOrEqual(4_000)
      expect(elapsed).toBeLessThan(5_200 + SLACK_MS)
      // The contract asks the HOST to warn when the ceiling exceeds its budget.
      const warning = capture.lines.find(line => /send ceiling/i.test(line) && /longer than/i.test(line))
      if (!warning) throw new Error(`ROW 5: the host logged no over-budget warning; captured: ${capture.lines.filter(line => /chatgpt-peer/.test(line)).slice(-5).join(' | ')}`)
    } finally {
      capture.restore()
      if (turn) await closeTurn(turn)
    }
  }, 30_000)

  // Row 6: G-008's recovery is shortened by the ceiling ----------------------
  test('6. an accepted, never-answered send is replaced at ceiling + margin, not at turnTimeout', async () => {
    const logs: string[] = []
    const turn = await stalledTurn({ turnTimeoutMs: 60_000, ceiling: String(CEILING), logs })
    try {
      const elapsed = await settled(turn.call, CEILING + MARGIN + SLACK_MS, 'ROW 6 (accepted, no reply)')
      console.log(`[G-010] row 6: host armed ${turn.call.timeoutMs} ms; settled ${elapsed} ms; replacement: ${logs.filter(line => /replacing the child|reply was lost/i.test(line)).join(' | ') || '(none)'}`)
      expect(turn.call.timeoutMs).toBe(CEILING + MARGIN)
      expect(elapsed).toBeLessThan(CEILING + MARGIN + SLACK_MS)
      // The replacement decision must be taken on the ceiling, not 60 s later.
      const replacement = await waitFor(() => logs.find(line => /replacing the child|the reply was lost/i.test(line)), 3_000)
      expect(replacement).toMatch(/accepted but unfinished|reply was lost/i)
      expect(elapsed).toBeLessThan(60_000)
    } finally {
      await closeTurn(turn)
    }
  }, 30_000)

  // Row 7: the attachment credit ----------------------------------------------
  test('7. an attachment adds the child credit; no attachment, or no credit, does not', async () => {
    // The three clauses are collected, not short-circuited, so a base run names
    // EVERY failing clause in one line instead of stopping at the first.
    const failures: string[] = []

    // (a) credit advertised + one attachment -> ceiling + margin + credit
    // (b) credit advertised + no attachment  -> ceiling + margin
    const withCredit = await attachTurn({ ceiling: String(CEILING), credit: String(CREDIT) })
    try {
      console.log(`[G-010] row 7 (a/b): no attachment armed ${withCredit.plain.timeoutMs} ms; attachment armed ${withCredit.attach.timeoutMs} ms (ceiling ${CEILING} + margin ${MARGIN} + credit ${CREDIT})`)
      if (withCredit.plain.timeoutMs !== CEILING + MARGIN) {
        failures.push(`(b) no attachment: armed ${withCredit.plain.timeoutMs} ms, expected ${CEILING + MARGIN}`)
      }
      if (withCredit.attach.timeoutMs !== CEILING + MARGIN + CREDIT) {
        failures.push(`(a) one attachment: armed ${withCredit.attach.timeoutMs} ms, expected ${CEILING + MARGIN + CREDIT}`)
      }
      if (withCredit.attach.timeoutMs - withCredit.plain.timeoutMs !== CREDIT) {
        failures.push(`(a) the credit term: attach - plain = ${withCredit.attach.timeoutMs - withCredit.plain.timeoutMs} ms, expected ${CREDIT}`)
      }
    } finally {
      await closeAttachTurn(withCredit)
    }

    // (c) credit omitted -> the fallback, indistinguishable from absent (0)
    const omitted = await attachTurn({ ceiling: String(CEILING), credit: null })
    try {
      console.log(`[G-010] row 7 (c): no attachment armed ${omitted.plain.timeoutMs} ms; attachment armed ${omitted.attach.timeoutMs} ms (credit omitted)`)
      if (omitted.plain.timeoutMs !== CEILING + MARGIN) {
        failures.push(`(c) no attachment, no credit: armed ${omitted.plain.timeoutMs} ms, expected ${CEILING + MARGIN}`)
      }
      if (omitted.attach.timeoutMs !== CEILING + MARGIN) {
        failures.push(`(c) attachment, no credit: armed ${omitted.attach.timeoutMs} ms, expected ${CEILING + MARGIN}`)
      }
    } finally {
      await closeAttachTurn(omitted)
    }

    expect(failures).toEqual([])
  }, 40_000)
})

// -------------------------------------------------------------- attachment

interface AttachTurn {
  dir: string
  cleanup: () => Promise<void>
  bridge: BridgeState
  driver: RecordingDriver
  host: ChatGptHost
  sender: GatewaySessionTransport
  /** A send with no attachment (answered at once). */
  plain: CallRecord
  /** The operator's attachFile send. */
  attach: CallRecord
}

async function attachTurn(options: { ceiling: string; credit: string | null }): Promise<AttachTurn> {
  const { dir, cleanup } = await scratch()
  const bridge = await primed('alpha', THREAD)
  await seedHost(dir, [bridge])
  const sender = await busPeer(dir, 'sender')
  const script = join(dir, 'page-child.js')
  await writeFile(script, childSource({ ceiling: options.ceiling, credit: options.credit }))
  const driver = new RecordingDriver({ script, wedgeMs: 600_000, lostReplyMarginMs: 100, log: () => {} })
  const host = await startHost(dir, driver, 60_000)
  await waitFor(() => driver.calls.some(call => call.op === 'ping' && call.settledAt !== undefined), 5_000)

  // A plain inbound send first: it is the "no attachment" half of the
  // comparison and it must be answered, so the page lock is free for the
  // operator's upload.
  const messageId = await sendInbound(sender, bridge.sessionId, 'say hello to the page', 'g010 plain send')
  const plain = await waitFor(
    () => driver.calls.find(item => item.op === 'send' && item.request.attach === undefined),
    8_000,
  )
  await settled(plain, 5_000, 'ROW 7 plain send')
  await waitFor(() => repliesTo(sender, messageId)[0], 8_000)

  // The operator's attachFile is the only public attach path.
  const attachment = join(dir, 'note.txt')
  await writeFile(attachment, 'the attachment bytes')
  const instance = JSON.parse(await readFile(join(privateHome(dir), 'instances', 'test.json'), 'utf8')) as { token: string }
  const response = await fetch(`http://127.0.0.1:${host.port}/operator`, {
    method: 'POST',
    headers: { authorization: `Bearer ${instance.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'attachFile', path: attachment, bridge: bridge.sessionId }),
  })
  const answer = await response.json() as { ok?: boolean; error?: string }
  if (answer.ok !== true) throw new Error(`the operator refused the attachment: ${answer.error ?? JSON.stringify(answer)}`)

  const attach = await waitFor(
    () => driver.calls.find(item => item.op === 'send' && item.request.attach !== undefined),
    8_000,
  )
  return { dir, cleanup, bridge, driver, host, sender, plain, attach }
}

async function closeAttachTurn(turn: AttachTurn): Promise<void> {
  await turn.sender.close().catch(() => {})
  await turn.host.stop().catch(() => {})
  await turn.cleanup()
}
