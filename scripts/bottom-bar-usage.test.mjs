import { strict as assert } from 'node:assert'
import test from 'node:test'

import {
  formatBottomBarUsage,
  formatSessionResumeCommand,
  getContextUsageValues,
  getGatewayProviderLabel,
  getWeeklyRemainingPercent,
} from '../src/utils/bottomBarUsage.ts'

test('context usage exposes used and remaining tokens and percentages', () => {
  assert.deepEqual(
    getContextUsageValues(
      {
        input_tokens: 20_000,
        output_tokens: 1_000,
        cache_creation_input_tokens: 5_000,
        cache_read_input_tokens: 10_000,
      },
      100_000,
    ),
    {
      usedTokens: 35_000,
      remainingTokens: 65_000,
      usedPercent: 35,
      remainingPercent: 65,
    },
  )
})

test('weekly remaining is only derived from valid provider utilization', () => {
  assert.equal(getWeeklyRemainingPercent({ utilization: 0.37 }), 63)
  assert.equal(getWeeklyRemainingPercent(undefined), null)
  assert.equal(getWeeklyRemainingPercent({ utilization: Number.NaN }), null)
})

test('session resume command keeps the directory and session ID copyable', () => {
  assert.equal(
    formatSessionResumeCommand(
      'Z:\\Work Repo\\gateway',
      '0bffad12-00fb-420d-95b3-09e5a3390a63',
    ),
    "cd 'Z:\\Work Repo\\gateway'; & cc --resume 0bffad12-00fb-420d-95b3-09e5a3390a63",
  )
  assert.equal(
    formatSessionResumeCommand(
      "C:\\Ahmed's Work",
      '12345678-1234-1234-1234-123456789abc',
    ),
    "cd 'C:\\Ahmed''s Work'; & cc --resume 12345678-1234-1234-1234-123456789abc",
  )
})

test('bottom bar identifies Gateway providers without inventing quota data', () => {
  assert.equal(getGatewayProviderLabel('gateway-gpt-luna'), 'Codex')
  assert.equal(getGatewayProviderLabel('gateway-opencode-mimo-v2.5-free'), 'OpenCode')
  assert.match(
    formatBottomBarUsage('gateway-gpt-luna', null, 200_000),
    /Codex · model gateway-gpt-luna · usage unavailable · context unavailable$/,
  )
  assert.match(
    formatBottomBarUsage(
      'gateway-gpt-luna',
      {
        input_tokens: 10_000,
        output_tokens: 500,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      200_000,
      { utilization: 0.2 },
    ),
    /weekly 80% left$/,
  )
})
