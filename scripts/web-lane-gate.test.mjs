/**
 * The lane-open gate: four concurrent opens never overlap, all finish, and a
 * failed open does not wedge the queue behind it.
 */
import { describe, expect, test } from 'bun:test'
import { createLaneGate } from './web-lane-gate.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function tracker() {
  let live = 0
  let peak = 0
  return {
    async enter(ms) {
      live += 1
      peak = Math.max(peak, live)
      await sleep(ms)
      live -= 1
    },
    get peak() { return peak },
    get live() { return live },
  }
}

describe('the lane-open gate', () => {
  test('four concurrent opens run one at a time and all complete', async () => {
    const serial = createLaneGate()
    const state = tracker()
    const order = []
    const opens = Array.from({ length: 4 }, (_, index) =>
      serial(async () => { order.push(index); await state.enter(30); return index }))
    const results = await Promise.all(opens)
    expect(results).toEqual([0, 1, 2, 3])
    expect(order).toEqual([0, 1, 2, 3])
    expect(state.peak).toBe(1)
    expect(state.live).toBe(0)
  })

  test('a failed open does not block the next one', async () => {
    const serial = createLaneGate()
    const failed = serial(async () => { throw new Error('tab refused') })
    const after = serial(async () => 'opened')
    await expect(failed).rejects.toThrow('tab refused')
    expect(await after).toBe('opened')
  })
})
