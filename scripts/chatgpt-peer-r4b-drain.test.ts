/**
 * R4 review-fix lane: R2-F7, the graceful drain.
 *
 * A page turn is budgeted at twenty minutes; a shutdown used to force the
 * child at five, cutting a live operation in half. The drain must honour the
 * operation's own deadline, and the no-work case must still end quickly.
 * `terminate()` stays the always-forced path.
 *
 * The child here is a real process (scripts/chatgpt-peer-r4b-fake-child.mjs),
 * never a mock: the deadline timer and the exit both happen in the OS.
 */
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { DriverChild } from './chatgpt-peer/driver.ts'

const CHILD = join(import.meta.dir, 'chatgpt-peer-r4b-fake-child.mjs')

describe('R2-F7: the drain window honours the in-flight deadline', () => {
  test('the window is the latest operation deadline, not a five-minute cap', async () => {
    const mod = await import('./chatgpt-peer/driver.ts') as Record<string, unknown>
    const grace = mod.drainGraceMs as ((latestDeadline: number, now?: number) => number) | undefined
    expect(typeof grace).toBe('function')
    const now = 1_800_000_000_000
    // Nothing in flight: the short floor, so a wedged child cannot hold a
    // shutdown open.
    expect(grace!(0, now)).toBe(10_000)
    // A page turn budgeted at twenty minutes is honoured in full; a five-minute
    // cap would have forced the child halfway through it.
    expect(grace!(now + 20 * 60_000, now)).toBe(20 * 60_000)
    expect(grace!(now + 5 * 60_000, now)).toBe(5 * 60_000)
    // A deadline already gone falls back to the floor rather than never firing.
    expect(grace!(now - 1, now)).toBe(10_000)
  })

  test('kill() asks a real child to quit and does not hang while it finishes', async () => {
    const child = new DriverChild({ script: CHILD, timeoutMs: 60_000 })
    // Accepted, never answered: an operation with a live deadline.
    const pending = child.call({ op: 'work' }, 60_000)
    await new Promise(resolve => setTimeout(resolve, 300))
    const started = Date.now()
    await child.kill()
    expect(Date.now() - started).toBeLessThan(5_000)
    expect((await pending).ok).toBe(false)
  })

  test('terminate() stays the always-forced path', async () => {
    const child = new DriverChild({ script: CHILD, timeoutMs: 60_000 })
    const pending = child.call({ op: 'work' }, 60_000)
    await new Promise(resolve => setTimeout(resolve, 300))
    const started = Date.now()
    await child.terminate()
    expect(Date.now() - started).toBeLessThan(5_000)
    expect((await pending).ok).toBe(false)
  })
})
