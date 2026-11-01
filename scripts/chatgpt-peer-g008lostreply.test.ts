/**
 * G-008: an accepted id must not disable child recovery past its request.
 *
 * Live incident (2026-11-01): `wedged()` treated any unsettled accepted id as
 * work in flight, so the host kept "leaving it running" through `r207`-`r213`
 * and only an out-of-band Stop-Process released the child 24 minutes later.
 * The root is the lifecycle, not the clock: the old code recorded EVERY
 * acceptance, including one whose request had already settled - the live log
 * line `accepted for r194 has no live waiter; dropped` is that shape - and the
 * dead id then suppressed recovery for the child's life. Acceptance is now
 * recorded only while its request is pending, so an accepted id cannot outlive
 * its own deadline. The age bound (`deadline` plus a margin) remains as the
 * backstop that names a lost frame if the lifecycle ever regresses.
 *
 * The child here is a real OS process speaking the frozen line-JSON protocol.
 * A `send` announces acceptance after `acceptAfterMs` and, only when
 * `replyAfterMs` is given, answers after that many ms; otherwise it never
 * replies. A `hold` never replies; everything else is answered at once.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DriverChild } from './chatgpt-peer/driver.ts'

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const CHILD = `
const readline = require('node:readline')
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n')
const rl = readline.createInterface({ input: process.stdin })
emit({ event: 'ready', pid: process.pid })
rl.on('line', line => {
  const trimmed = line.trim()
  if (!trimmed) return
  let request
  try { request = JSON.parse(trimmed) } catch { return }
  if (request.op === 'quit') { emit({ ok: true, op: 'quit', id: request.id }); process.exit(0) }
  if (request.op === 'hold') return
  if (request.op === 'send') {
    const acceptAfter = Number(request.acceptAfterMs || 0)
    setTimeout(() => emit({ event: 'accepted', id: request.id }), acceptAfter)
    if (request.replyAfterMs === undefined) return
    setTimeout(() => emit({ ok: true, op: 'send', id: request.id }), Number(request.replyAfterMs))
    return
  }
  emit({ ok: true, op: request.op, id: request.id })
})
`

async function scratch(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-peer-g008-'))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

async function fakeChild(dir: string): Promise<string> {
  const script = join(dir, 'lost-child.js')
  await writeFile(script, CHILD)
  return script
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 5_000): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = probe()
    if (value !== undefined) return value
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the fake child')
    await delay(5)
  }
}

type Settled = { done: boolean; reply?: { ok: boolean; reason?: string; error?: string; id?: string } }
const track = (promise: Promise<any>): Settled => {
  const box: Settled = { done: false }
  void promise.then(reply => { box.done = true; box.reply = reply })
  return box
}

const lostLog = (logs: string[]): string[] => logs.filter(line => /the reply was lost, not a plain timeout/.test(line))
const plainTimeoutLog = (logs: string[]): string[] => logs.filter(line => /timed out; replacing the child/.test(line))
/** White-box: the child generation only moves when a new process is spawned. */
const generationOf = (driver: DriverChild): number => (driver as unknown as { generation: number }).generation
/** White-box: accepted-but-unfinished ids the recovery decision would see. */
const acceptedIds = (driver: DriverChild): string[] =>
  [...(driver as unknown as { accepted: Map<string, unknown> }).accepted.keys()]

describe('G-008: an accepted id is bounded by its own request', () => {
  test('(i) an accepted id still inside its own deadline suppresses replacement of another timeout', async () => {
    const { dir, cleanup } = await scratch()
    const logs: string[] = []
    // A 60 s per-call deadline: the accepted send is young by a wide margin, so
    // a status-shaped request that misses its own 40 ms deadline says nothing
    // about the child.
    const driver = new DriverChild({ script: await fakeChild(dir), timeoutMs: 600, wedgeMs: 600_000, lostReplyMarginMs: 100, log: line => logs.push(line) })
    let acceptedId = ''
    const send = track(driver.call({ op: 'send', text: 'the long turn' }, { timeoutMs: 60_000, onAccepted: id => { acceptedId = id } }))
    try {
      await waitFor(() => acceptedId || undefined)
      const young = await driver.call({ op: 'hold' }, { timeoutMs: 40 })
      expect(young.reason).toBe('timeout')
      expect(send.done).toBe(false)
      expect(lostLog(logs)).toEqual([])
      expect(plainTimeoutLog(logs)).toEqual([])
      expect(logs.some(line => new RegExp(`accepted work in flight: ${acceptedId}`).test(line))).toBe(true)
    } finally {
      await driver.terminate()
      await delay(20)
      await cleanup()
    }
  }, 20_000)

  test('(ii) an acceptance for an already-settled id is recorded nowhere: its late reply and the bound cost the same healthy child', async () => {
    const { dir, cleanup } = await scratch()
    const logs: string[] = []
    // The construction ceiling is 300 ms and the margin 100 ms; the send's own
    // deadline is 150 ms. The child accepts at 400 ms - AFTER the host gave up -
    // and answers that id at 500 ms. That is the r194 shape: an acceptance for a
    // request the host no longer owes a reply to.
    const driver = new DriverChild({ script: await fakeChild(dir), timeoutMs: 300, wedgeMs: 600_000, lostReplyMarginMs: 100, log: line => logs.push(line) })
    const send = track(driver.call({ op: 'send', text: 'abandoned, then answered', acceptAfterMs: 400, replyAfterMs: 500 }, { timeoutMs: 150 }))
    const generationBefore = generationOf(driver)
    try {
      await waitFor(() => send.done || undefined)
      expect(send.reply?.reason).toBe('timeout')
      // The child really did take the message and really did answer it late.
      await waitFor(() => logs.some(line => /accepted for r\d+ has no live waiter; dropped/.test(line)) || undefined)
      await waitFor(() => logs.some(line => /late reply for r\d+ dropped/.test(line)) || undefined)

      // Advance well past the bound the acceptance WOULD have had (accept at
      // 400 ms + 300 ms ceiling + 100 ms margin = 800 ms from the call).
      await delay(900)
      expect(lostLog(logs)).toEqual([])
      expect(plainTimeoutLog(logs)).toEqual([])
      // Nothing was recorded for the settled id: no dead acceptance is left to
      // suppress a later recovery, and no bound timer is left to kill the child.
      expect(acceptedIds(driver)).toEqual([])

      // The same child still answers: it was never replaced.
      const pong = await driver.call({ op: 'ping' }, 1_000)
      expect(pong.ok).toBe(true)
      expect(generationOf(driver)).toBe(generationBefore)
    } finally {
      await driver.terminate()
      await delay(20)
      await cleanup()
    }
  }, 20_000)
})
