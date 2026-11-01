/**
 * G-008: one lost reply must not disable child recovery for the child's life.
 *
 * Live incident (2026-11-01): the child accepted `r206`, ran the turn to
 * completion, and never sent its reply. `wedged()` treated any unsettled
 * accepted id as work in flight, so the host kept "leaving it running" through
 * `r207`-`r213` and only an out-of-band Stop-Process released the child 24
 * minutes later. The accepted map is now bounded by age: an accepted id older
 * than ITS OWN request deadline plus a margin is a LOST reply, not in-flight
 * work. The deadline is the one `call()` recorded in `deadlines`; an id whose
 * request already timed out before the page announced acceptance keeps it
 * (the incident's shape) and falls back to the construction ceiling.
 *
 * The bound also fires on its own timer. The incident had no later request for
 * four minutes; with none at all, waiting for one to time out would never
 * release the child. The QUIET row below accepts a send, never replies, issues
 * NO further requests, and still expects the child replaced at the bound.
 *
 * The child here is a real OS process speaking the frozen line-JSON protocol:
 * a `send` announces acceptance after `acceptAfterMs` (after the host's own
 * deadline when that is short) and never replies, and a `hold` never replies.
 * Everything else is answered at once.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DriverChild } from './chatgpt-peer/driver.ts'

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * `send` announces acceptance after `acceptAfterMs` and never replies; `hold`
 * never replies; `quit` replies and exits; everything else is answered.
 */
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
    const after = Number(request.acceptAfterMs || 0)
    setTimeout(() => emit({ event: 'accepted', id: request.id }), after)
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
const deferredBoundLog = (logs: string[]): string[] => logs.filter(line => /no reply for .*accepted work is still in flight/.test(line))

describe('G-008: a lost accepted reply is bounded by age', () => {
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

  test('(ii) QUIET shape: no reply, no further request - the bound timer replaces the child with the distinct line', async () => {
    const { dir, cleanup } = await scratch()
    const logs: string[] = []
    // The construction ceiling is 300 ms and the margin 100 ms, so an accepted
    // id with no live waiter is presumed lost 400 ms after it is announced. The
    // page announces acceptance AFTER the send's own 150 ms deadline: that is
    // the incident's shape, an accepted id whose request already went away, and
    // the bound that has to fire without any later request.
    const driver = new DriverChild({ script: await fakeChild(dir), timeoutMs: 300, wedgeMs: 600_000, lostReplyMarginMs: 100, log: line => logs.push(line) })
    const send = track(driver.call({ op: 'send', text: 'a reply that never comes', acceptAfterMs: 300 }, { timeoutMs: 150 }))
    try {
      await waitFor(() => send.done || undefined)
      expect(send.reply?.reason).toBe('timeout')
      // Its own deadline passing is a plain timeout, not a lost reply: nothing
      // has been announced yet, and no replacement may happen on that account.
      expect(lostLog(logs)).toEqual([])
      // From here NOTHING is sent. The bound alone must release the child.
      await waitFor(() => lostLog(logs).length > 0 || undefined, 5_000)
      const lost = lostLog(logs)
      expect(lost.length).toBe(1)
      expect(lost[0]!).toMatch(/r\d+/)
      expect(lost[0]!).toMatch(/accepted \d+\.\d+s ago/)
      expect(plainTimeoutLog(logs)).toEqual([])
    } finally {
      await driver.terminate()
      await delay(20)
      await cleanup()
    }
  }, 20_000)

  test('(iii) the young-id rule holds in the timer path too: real accepted work is not killed under an overdue one', async () => {
    const { dir, cleanup } = await scratch()
    const logs: string[] = []
    const driver = new DriverChild({ script: await fakeChild(dir), timeoutMs: 300, wedgeMs: 600_000, lostReplyMarginMs: 100, log: line => logs.push(line) })
    // An honest, young turn: accepted at once, its own deadline 60 s away.
    let honestId = ''
    const honest = track(driver.call({ op: 'send', text: 'an honest long turn' }, { timeoutMs: 60_000, onAccepted: id => { honestId = id } }))
    // A leaked accepted id: announced after its request already timed out, so
    // its bound is the 300 ms construction ceiling plus the 100 ms margin.
    track(driver.call({ op: 'send', text: 'a lost send', acceptAfterMs: 300 }, { timeoutMs: 150 }))
    try {
      await waitFor(() => honestId || undefined)
      await waitFor(() => deferredBoundLog(logs).length > 0 || undefined, 5_000)
      // The overdue id did NOT replace the child: the young turn is still work.
      expect(lostLog(logs)).toEqual([])
      expect(honest.done).toBe(false)
      expect(deferredBoundLog(logs)[0]!).toContain(honestId)
      expect(deferredBoundLog(logs)[0]!).toMatch(/no reply for r\d+ \(accepted \d+\.\d+s ago\)/)
    } finally {
      await driver.terminate()
      await delay(20)
      await cleanup()
    }
  }, 20_000)
})
