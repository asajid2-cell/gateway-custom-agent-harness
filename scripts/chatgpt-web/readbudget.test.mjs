/**
 * The account read budget: 3/min, burst 2, and the last token is the
 * delivery read's.
 *
 * The wall is real (2026-11-07: four reads answered, the fifth refused for
 * 48 s), so what this fixture pins is the pacing, not the wall itself. A
 * deterministic clock keeps every row exact.
 */
import { describe, expect, test } from 'bun:test'
import { createReadBudget } from './readbudget.mjs'

function clock(start = 1_000_000) {
  let at = start
  return { now: () => at, advance: ms => { at += ms } }
}

describe('the read budget', () => {
  test('a rate of zero is unlimited', () => {
    const budget = createReadBudget({ perMinute: 0 })
    expect(budget.unlimited).toBe(true)
    for (let index = 0; index < 50; index += 1) expect(budget.take()).toBe(true)
    expect(budget.waitMs()).toBe(0)
  })

  test('a burst of two: one observation, but a delivery still gets the last token', () => {
    const time = clock()
    const budget = createReadBudget({ perMinute: 3, burst: 2, now: time.now })
    expect(budget.take('observation')).toBe(true)
    // The last token is reserved: an observation may not take it.
    expect(budget.take('observation')).toBe(false)
    // A delivery read may.
    expect(budget.take('delivery')).toBe(true)
    expect(budget.take('delivery')).toBe(false)
  })

  test('tokens refill at the rate, and waitMs names the wait', () => {
    const time = clock()
    const budget = createReadBudget({ perMinute: 3, burst: 2, now: time.now })
    expect(budget.take('delivery')).toBe(true)
    expect(budget.take('delivery')).toBe(true)
    // Empty: twenty seconds at three a minute is exactly one token.
    expect(budget.waitMs('delivery')).toBe(20_000)
    time.advance(10_000)
    expect(budget.waitMs('delivery')).toBe(10_000)
    time.advance(10_000)
    expect(budget.take('delivery')).toBe(true)
    expect(budget.take('delivery')).toBe(false)
  })

  test('the balance never exceeds the burst', () => {
    const time = clock()
    const budget = createReadBudget({ perMinute: 3, burst: 2, now: time.now })
    expect(budget.take('delivery')).toBe(true)
    time.advance(10 * 60_000)
    expect(budget.balance()).toBe(2)
  })
})
