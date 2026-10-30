/**
 * R-LIVE-5: a timed-out request is not, by itself, a wedged child.
 *
 * The live incident: a 45 s `conversation` read missed its deadline during a
 * genuinely generating turn, `recover()` replaced the child unconditionally,
 * and the turn failed with "driver was replaced after r27 timed out" - a driver
 * fact reported as the model's failure. R2-F6's replacement and N2's read are
 * each right; the replacement decision was the wrong one.
 *
 * The child here is a real process (scripts/chatgpt-peer-r4c-fake-child.mjs),
 * never a mock: the timers that decide every assertion run in the OS.
 */
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { DriverChild, isDriverFault, isDriverFaultReply } from './chatgpt-peer/driver.ts'

const CHILD = join(import.meta.dir, 'chatgpt-peer-r4c-fake-child.mjs')
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const pidOf = async (child: DriverChild): Promise<number> => {
  const reply = await child.call({ op: 'pid' })
  expect(reply.ok).toBe(true)
  const pid = reply.pid
  expect(typeof pid).toBe('number')
  return pid as number
}

describe('R-LIVE-5 residual: a plain timeout is a driver fault by shape', () => {
  test('the reply reason classifies a timeout, and a page-side error does not', () => {
    // The live r27 was exactly this: the driver's own deadline, not a page word.
    expect(isDriverFaultReply({ ok: false, reason: 'timeout', error: 'driver timed out after 45s' })).toBe(true)
    expect(isDriverFaultReply({ ok: false, reason: 'timeout', error: 'no error text' })).toBe(true)
    expect(isDriverFaultReply({ ok: false, error: 'driver was replaced after r27 timed out' })).toBe(true)
    expect(isDriverFaultReply({ ok: false, error: 'driver is closed' })).toBe(true)
    expect(isDriverFaultReply({ ok: false, error: 'could not write to the driver: EPIPE' })).toBe(true)
    // A wrapped timeout string still classifies without the reply shape.
    expect(isDriverFault('driver timed out after 45s')).toBe(true)
    // The page failed: the driver answered, so this is a read error, not a
    // driver fault, and it must keep backing the reconcile pass off.
    expect(isDriverFaultReply({ ok: false, status: 500, error: 'conversation fetch failed' })).toBe(false)
    expect(isDriverFaultReply({ ok: false, status: 429, error: 'too many requests' })).toBe(false)
  })
})

describe('R-LIVE-5: the replacement decision needs evidence', () => {
  test('a read that times out beside accepted page work leaves the child alive and the turn completes', async () => {
    const lines: string[] = []
    const child = new DriverChild({ script: CHILD, log: line => lines.push(line) })
    try {
      const before = await pidOf(child)
      // The page takes the send (accepted) and is still generating: the send is
      // accepted-but-unfinished work, exactly the live shape.
      const send = child.call({ op: 'send', text: 'hi', delayMs: 900 }, 6_000)
      await sleep(200)
      // A read of the same thread misses its own deadline while that work is in
      // flight. It must be settled alone.
      const read = await child.call({ op: 'conversation', delayMs: 800 }, 300)
      expect(read.ok).toBe(false)
      expect(read.reason).toBe('timeout')
      // The child was not replaced: the same process answers...
      expect(await pidOf(child)).toBe(before)
      // ...and the turn's send still completes with the page's answer.
      const answered = await send
      expect(answered.ok).toBe(true)
      expect(answered.text).toBe('answered:hi')
      expect(await pidOf(child)).toBe(before)
      expect(lines.join('\n')).not.toMatch(/replacing the child/)
      expect(lines.join('\n')).toMatch(/leaving it running/)
    } finally { await child.kill() }
  }, 20_000)

  test('a child that answers nothing at all for the timeout is still replaced', async () => {
    const lines: string[] = []
    // A short, explicit wedge window: the assertion is the rule, not the 2 min.
    const child = new DriverChild({ script: CHILD, log: line => lines.push(line), wedgeMs: 200 })
    try {
      const before = await pidOf(child)
      const silent = await child.call({ op: 'nothing' }, 600)
      expect(silent.ok).toBe(false)
      expect(silent.reason).toBe('timeout')
      // Silence past the wedge window: replaced, and a fresh child answers.
      expect(await pidOf(child)).not.toBe(before)
      expect(lines.join('\n')).toMatch(/replacing the child/)
    } finally { await child.kill() }
  }, 20_000)

  test('silence inside the wedge window is a slow read, not a wedge', async () => {
    const lines: string[] = []
    const child = new DriverChild({ script: CHILD, log: line => lines.push(line), wedgeMs: 5_000 })
    try {
      const before = await pidOf(child)
      const silent = await child.call({ op: 'nothing' }, 300)
      expect(silent.ok).toBe(false)
      expect(silent.reason).toBe('timeout')
      expect(await pidOf(child)).toBe(before)
      expect(lines.join('\n')).not.toMatch(/replacing the child/)
    } finally { await child.kill() }
  }, 20_000)

  test('R2-F6: work the child accepted and never finished still replaces it', async () => {
    const lines: string[] = []
    const child = new DriverChild({ script: CHILD, log: line => lines.push(line) })
    try {
      const before = await pidOf(child)
      const stuck = await child.call({ op: 'stuck' }, 150)
      expect(stuck.ok).toBe(false)
      expect(stuck.reason).toBe('timeout')
      expect(await pidOf(child)).not.toBe(before)
      expect(lines.join('\n')).toMatch(/accepted but unfinished: r\d+/)
    } finally { await child.kill() }
  }, 20_000)

  test('a late answer to a settled read never settles the next request', async () => {
    const child = new DriverChild({ script: CHILD, log: () => {} })
    try {
      const before = await pidOf(child)
      // Times out; the child answers it 300 ms later.
      const read = await child.call({ op: 'conversation', delayMs: 400 }, 150)
      expect(read.ok).toBe(false)
      // The next request is answered by its own reply, not the orphaned one.
      const after = await pidOf(child)
      expect(after).toBe(before)
    } finally { await child.kill() }
  }, 20_000)
})
