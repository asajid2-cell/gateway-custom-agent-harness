// The bottom bar's token counter is a spend figure for the run, not a
// context-occupancy gauge and not the session's stored history. These tests pin
// the three things that follow from that: every billed token counts (input,
// output and both cache figures), the bar prints one plain number, and a
// restarted session starts at zero even though its cumulative model usage is
// restored from the transcript.
process.env.GATEWAY_TOKEN_LEDGER = '0'

import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  addToSessionTokenTotals,
  getSessionTokenTotals,
  getTotalInputTokens,
  resetSessionTokenTotals,
  setCostStateForRestore,
  subscribeSessionTokenTotals,
} from '../src/bootstrap/state.ts'
import { addToTotalSessionCost, resetCostState } from '../src/cost-tracker.ts'
import {
  formatSessionTokenTotal,
  getSessionChargedTokens,
} from '../src/utils/bottomBarUsage.ts'

type UsageFixture = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

function usage(input: number, output: number, cacheRead: number, cacheWrite: number): UsageFixture {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
  }
}

test('every billed token counts, not just the visible ones', () => {
  resetCostState()
  addToTotalSessionCost(0, usage(100, 20, 300, 40) as never, 'model-a')
  const totals = getSessionTokenTotals()
  assert.equal(getSessionChargedTokens(totals), 460, 'input + output + cache read + cache write')
  assert.deepEqual(totals['model-a'] && {
    input: totals['model-a'].inputTokens,
    output: totals['model-a'].outputTokens,
    cacheRead: totals['model-a'].cacheReadInputTokens,
    cacheWrite: totals['model-a'].cacheCreationInputTokens,
  }, { input: 100, output: 20, cacheRead: 300, cacheWrite: 40 })
})

test('the total accumulates across responses and across models', () => {
  resetCostState()
  addToTotalSessionCost(0, usage(10, 1, 0, 0) as never, 'model-a')
  addToTotalSessionCost(0, usage(20, 2, 0, 0) as never, 'model-a')
  addToTotalSessionCost(0, usage(7, 3, 0, 0) as never, 'model-b')
  const totals = getSessionTokenTotals()
  assert.equal(totals['model-a']?.inputTokens, 30, 'same model keeps adding up')
  assert.equal(getSessionChargedTokens(totals), 43, 'the total spans every model')
})

test('the bar shows one plain number and nothing else', () => {
  assert.equal(formatSessionTokenTotal({}), '0 total')
  assert.equal(
    formatSessionTokenTotal({
      'model-a': { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 300, cacheCreationInputTokens: 40 },
    }),
    '460 total',
    'no model name, no in/out split, no unit suffix on the split',
  )
  assert.equal(
    formatSessionTokenTotal({
      'model-a': { inputTokens: 99_950_000, outputTokens: 50_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    }),
    '100m total',
    'compact notation matches the rest of the readout',
  )
})

test('a restarted session starts the counter at zero', () => {
  resetCostState()
  addToTotalSessionCost(0, usage(500, 500, 0, 0) as never, 'model-a')
  assert.equal(getSessionChargedTokens(getSessionTokenTotals()), 1000)

  // A restart restores the transcript's cumulative usage into the model totals,
  // which is exactly why the run counter cannot be part of them.
  resetCostState()
  setCostStateForRestore({
    totalCostUSD: 12,
    totalAPIDuration: 0,
    totalAPIDurationWithoutRetries: 0,
    totalToolDuration: 0,
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    lastDuration: undefined,
    modelUsage: {
      'model-a': {
        inputTokens: 5_000_000,
        outputTokens: 40_000,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 12,
        contextWindow: 200000,
        maxOutputTokens: 8192,
      },
    },
  })
  assert.equal(getTotalInputTokens(), 5_000_000, 'the cumulative usage did come back')
  assert.equal(getSessionChargedTokens(getSessionTokenTotals()), 0, 'the run counter did not')
  assert.equal(formatSessionTokenTotal(getSessionTokenTotals()), '0 total')
})

test('resetCostState clears the run counter', () => {
  resetCostState()
  addToSessionTokenTotals('model-a', { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 })
  assert.equal(getSessionChargedTokens(getSessionTokenTotals()), 10)
  resetCostState()
  assert.equal(getSessionChargedTokens(getSessionTokenTotals()), 0)
})

test('subscribers are told when the total moves so the bar can repaint', () => {
  resetCostState()
  let notifications = 0
  const unsubscribe = subscribeSessionTokenTotals(() => { notifications++ })
  addToSessionTokenTotals('model-a', { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 })
  assert.equal(notifications, 1)
  unsubscribe()
  addToSessionTokenTotals('model-a', { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 })
  assert.equal(notifications, 1, 'an unsubscribed listener is left alone')
})
