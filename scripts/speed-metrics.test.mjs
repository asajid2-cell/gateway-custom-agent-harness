import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  formatTokensPerSecond,
  getAverageSpeed,
  getSpeedSample,
  outputTokensPerSecond,
  recordSpeedSample,
  resetSpeedForTests,
  speedKey,
  speedStatusLineField,
} from '../src/utils/speed.ts'
import {
  recordTokenUsage,
  resetTokenLedgerForTests,
} from '../src/utils/tokenLedger.ts'
import {
  averageTokPerSecond,
  buildUsageReport,
  readTokenLedger,
} from '../src/utils/tokenUsageReport.ts'
import { formatBottomBarUsage } from '../src/utils/bottomBarUsage.ts'

test('the rate is output tokens per generation second, never a zero-speed answer', () => {
  assert.equal(outputTokensPerSecond(100, 2_000), 50)
  assert.equal(outputTokensPerSecond(1, 1_000), 1)
  assert.equal(outputTokensPerSecond(0, 1_000), null)
  assert.equal(outputTokensPerSecond(100, 0), null)
  assert.equal(outputTokensPerSecond(100, -5), null)
  assert.equal(outputTokensPerSecond(Number.NaN, 1_000), null)
})

test('a sample excludes prompt processing and keeps both clocks', () => {
  resetSpeedForTests()
  const sample = recordSpeedSample({
    model: 'gateway-mistral-deepseek-v4.1-flash',
    outputTokens: 200,
    startedAt: 10_000,
    firstTokenAt: 12_000,
    endedAt: 14_000,
  })
  assert.ok(sample)
  assert.equal(sample.ttftMs, 2_000)
  assert.equal(sample.generationMs, 2_000)
  assert.equal(sample.totalMs, 4_000)
  assert.equal(sample.tokPerSec, 100)
  assert.equal(getSpeedSample('gateway-mistral-deepseek-v4.1-flash')?.tokPerSec, 100)
})

test('the sample is keyed by the canonical route, so aliases share one figure', () => {
  assert.equal(
    speedKey('mistral/deepseek-v4-1-flash-1017'),
    'gateway-mistral-deepseek-v4.1-flash',
  )
  assert.equal(speedKey('gateway-claude-opus-4-6[1m]'), 'gateway-claude-opus-4-6')
  resetSpeedForTests()
  recordSpeedSample({
    model: 'mistral/deepseek-v4-1-flash-1017',
    outputTokens: 10,
    startedAt: 0,
    firstTokenAt: 1_000,
    endedAt: 2_000,
  })
  assert.equal(getSpeedSample('gateway-mistral-deepseek-v4.1-flash')?.tokPerSec, 10)
  assert.equal(getSpeedSample('mistral-deepseek-v4.1-flash')?.tokPerSec, 10)
})

test('the status line gets last-response and weighted session figures', () => {
  resetSpeedForTests()
  assert.equal(speedStatusLineField('gateway-mistral-deepseek-v4.1-flash'), null)
  recordSpeedSample({
    model: 'gateway-mistral-deepseek-v4.1-flash',
    outputTokens: 3,
    startedAt: 0,
    firstTokenAt: 1_000,
    endedAt: 1_003,
  })
  recordSpeedSample({
    model: 'gateway-mistral-deepseek-v4.1-flash',
    outputTokens: 300,
    startedAt: 10_000,
    firstTokenAt: 11_000,
    endedAt: 13_000,
  })
  const field = speedStatusLineField('gateway-mistral-deepseek-v4.1-flash')
  assert.ok(field)
  assert.equal(field.speed.output_tokens_per_second, 150)
  // (3 + 300) tokens over (3 + 2000) ms, not the mean of 1000 and 150.
  assert.equal(Math.round(field.speed.session_output_tokens_per_second), 151)
  assert.equal(field.speed.output_tokens, 300)
  assert.equal(field.speed.generation_ms, 2_000)
  assert.equal(field.speed.ttft_ms, 1_000)
  assert.equal(getAverageSpeed('mistral/deepseek-v4-1-flash-1017') > 150, true)
})

test('the current figure prints with one decimal', () => {
  assert.equal(formatTokensPerSecond(42.34), '42.3')
  assert.equal(formatTokensPerSecond(0), '0')
})

test('the footer readout carries the current rate and omits it when unmeasured', () => {
  const usage = {
    input_tokens: 10,
    output_tokens: 20,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  }
  assert.match(
    formatBottomBarUsage('gateway-mistral-deepseek-v4.1-flash', usage, 1_000, undefined, {
      speedTokPerSec: 42.34,
    }),
    /42\.3 tok\/s/,
  )
  assert.doesNotMatch(
    formatBottomBarUsage('gateway-mistral-deepseek-v4.1-flash', usage, 1_000, undefined, {
      speedTokPerSec: null,
    }),
    /tok\/s/,
  )
})

test('a ledger row keeps the speed clocks and /usage averages them weighted', () => {
  const directory = mkdtempSync(join(tmpdir(), 'speed-ledger-'))
  const previous = process.env.GATEWAY_TOKEN_LEDGER_DIR
  process.env.GATEWAY_TOKEN_LEDGER_DIR = directory
  delete process.env.GATEWAY_TOKEN_LEDGER
  resetTokenLedgerForTests()
  try {
    recordTokenUsage({
      session: 'session-a',
      model: 'gateway-mistral-deepseek-v4.1-flash',
      usage: { input: 10, output: 100, cacheRead: 0, cacheWrite: 0 },
      costUSD: 0,
      speed: { ttftMs: 500, generationMs: 2_000, totalMs: 2_500 },
    })
    recordTokenUsage({
      session: 'session-a',
      model: 'gateway-mistral-deepseek-v4.1-flash',
      usage: { input: 10, output: 300, cacheRead: 0, cacheWrite: 0 },
      costUSD: 0,
      speed: { ttftMs: 500, generationMs: 2_000, totalMs: 2_500 },
    })
    // A replay has no honest window; it must not dilute the average.
    recordTokenUsage({
      session: 'session-a',
      model: 'gateway-mistral-deepseek-v4.1-flash',
      usage: { input: 10, output: 9999, cacheRead: 0, cacheWrite: 0 },
      costUSD: 0,
      source: 'replay',
    })

    const read = readTokenLedger(directory)
    assert.equal(read.rows.length, 3)
    assert.equal(read.rows[0].tokPerSec, 50)
    assert.equal(read.rows[0].genMs, 2_000)
    assert.equal(read.rows[1].tokPerSec, 150)
    assert.equal(read.rows[2].tokPerSec, undefined)

    const report = buildUsageReport({ directory, period: 'all' })
    assert.equal(report.totals.speedRows, 2)
    // (100 + 300) tokens over 4 seconds, not the mean of 50 and 150 alone.
    assert.equal(Math.round(averageTokPerSecond(report.totals) * 10) / 10, 100)
    const model = report.byModel.find(group => group.key.includes('mistral'))
    assert.equal(Math.round(averageTokPerSecond(model.totals) * 10) / 10, 100)
  } finally {
    resetTokenLedgerForTests()
    if (previous === undefined) delete process.env.GATEWAY_TOKEN_LEDGER_DIR
    else process.env.GATEWAY_TOKEN_LEDGER_DIR = previous
    rmSync(directory, { recursive: true, force: true })
  }
})
