/**
 * G-008: one lost reply must not disable child recovery for the child's life.
 *
 * Live incident (2026-11-01): the child accepted `r206`, ran the turn to
 * completion, and never sent its reply. `wedged()` treated any unsettled
 * accepted id as work in flight, so the host kept "leaving it running" through
 * `r207`-`r213` and only an out-of-band Stop-Process released the child 24
 * minutes later. The accepted map is now bounded by age: an accepted id older
 * than the send ceiling plus a margin is a LOST reply, not in-flight work.
 *
 * The child here is a real OS process speaking the frozen line-JSON protocol:
 * it accepts the first request and withholds its reply forever, and it withholds
 * a reply for `hold` requests so they time out exactly like the incident's
 * status polls. All other requests are answered.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DriverChild } from './chatgpt-peer/driver.ts'

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * A child that accepts the FIRST request and never replies to it, and never
 * replies to `hold`. Everything else is answered at once.
 */
const CHILD = `
const readline = require('node:readline')
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n')
const rl = readline.createInterface({ input: process.stdin })
let accepted = false
emit({ event: 'ready', pid: process.pid })
rl.on('line', line => {
  const trimmed = line.trim()
  if (!trimmed) return
  let request
  try { request = JSON.parse(trimmed) } catch { return }
  if (request.op === 'quit') { emit({ ok: true, op: 'quit', id: request.id }); process.exit(0) }
  if (!accepted) { accepted = true; emit({ event: 'accepted', id: request.id }); return }
  if (request.op === 'hold') return
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

type Settled = { done: boolean; reply?: { ok: boolean; error?: string; id?: string } }
const track = (promise: Promise<any>): Settled => {
  const box: Settled = { done: false }
  void promise.then(reply => { box.done = true; box.reply = reply })
  return box
}

const lostLog = (logs: string[]): string[] => logs.filter(line => /the reply was lost, not a plain timeout/.test(line))

describe('G-008: a lost accepted reply is bounded by age', () => {
  test('(i)-(iii) no replacement before the bound, then a distinct replacement naming the lost id and age', async () => {
    const { dir, cleanup } = await scratch()
    const logs: string[] = []
    // The send ceiling is 600ms and the margin 100ms, so an accepted id is
    // presumed lost after 700ms. The per-call timeout for the lost send stays
    // long so its OWN timer cannot be what triggers recovery - only the age
    // bound may.
    const driver = new DriverChild({ script: await fakeChild(dir), timeoutMs: 600, wedgeMs: 600_000, lostReplyMarginMs: 100, log: line => logs.push(line) })
    let lostId = ''
    const send = track(driver.call({ op: 'send', text: 'the long turn' }, { timeoutMs: 60_000, onAccepted: id => { lostId = id } }))
    try {
      await waitFor(() => lostId || undefined)
      expect(lostId).toMatch(/^r\d+$/)

      // (i) A later request times out while the accepted id is still young:
      // the child keeps running and no lost-reply verdict is logged.
      const young = await driver.call({ op: 'hold' }, { timeoutMs: 40 })
      expect(young.reason).toBe('timeout')
      expect(send.done).toBe(false)
      expect(lostLog(logs)).toEqual([])
      expect(logs.some(line => new RegExp(`accepted work in flight: ${lostId}`).test(line))).toBe(true)

      // (ii)+(iii) Past the ceiling plus margin, the next timeout replaces the
      // child with a DISTINCT line that names the id and how long it waited.
      await delay(760)
      const old = await driver.call({ op: 'hold' }, { timeoutMs: 40 })
      expect(old.reason).toBe('timeout')
      await waitFor(() => send.done || undefined)

      const lost = lostLog(logs)
      expect(lost.length).toBe(1)
      expect(lost[0]!).toContain(lostId)
      expect(lost[0]!).toMatch(/accepted \d+\.\d+s ago/)
      // Distinct from a plain timeout replacement.
      expect(logs.some(line => /timed out; replacing the child/.test(line))).toBe(false)
      expect(String(send.reply?.error ?? '')).toContain('driver was replaced')
    } finally {
      await driver.terminate()
      await delay(20)
      await cleanup()
    }
  }, 20_000)

  test('(iv) a genuinely in-flight long turn still suppresses replacement within the bound', async () => {
    const { dir, cleanup } = await scratch()
    const logs: string[] = []
    // A five-second ceiling: the accepted turn below is young by that scale,
    // and must be treated as real work, not a lost reply.
    const driver = new DriverChild({ script: await fakeChild(dir), timeoutMs: 5_000, wedgeMs: 600_000, lostReplyMarginMs: 100, log: line => logs.push(line) })
    let acceptedId = ''
    const turn = track(driver.call({ op: 'send', text: 'a long but honest turn' }, { timeoutMs: 60_000, onAccepted: id => { acceptedId = id } }))
    try {
      await waitFor(() => acceptedId || undefined)
      await delay(300)

      const missed = await driver.call({ op: 'hold' }, { timeoutMs: 40 })
      expect(missed.reason).toBe('timeout')
      expect(turn.done).toBe(false)
      expect(lostLog(logs)).toEqual([])
      expect(logs.some(line => new RegExp(`accepted work in flight: ${acceptedId}`).test(line))).toBe(true)
    } finally {
      await driver.terminate()
      await delay(20)
      await cleanup()
    }
  }, 20_000)
})
