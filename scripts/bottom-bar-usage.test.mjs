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

test('session resume command can target the session by name instead of its ID', () => {
  assert.equal(
    formatSessionResumeCommand(
      'Z:\\Work Repo\\gateway',
      '0bffad12-00fb-420d-95b3-09e5a3390a63',
      'Release triage',
    ),
    "cd 'Z:\\Work Repo\\gateway'; & cc --resume 'Release triage'",
  )
  // A name is free text, so the same quoting has to escape an apostrophe in it.
  assert.equal(
    formatSessionResumeCommand(
      "C:\\Ahmed's Work",
      '12345678-1234-1234-1234-123456789abc',
      "Ahmed's session",
    ),
    "cd 'C:\\Ahmed''s Work'; & cc --resume 'Ahmed''s session'",
  )
  // An unnamed session has no second target, so the ID is what it resumes by.
  assert.equal(
    formatSessionResumeCommand(
      'Z:\\Work Repo\\gateway',
      '0bffad12-00fb-420d-95b3-09e5a3390a63',
      null,
    ),
    "cd 'Z:\\Work Repo\\gateway'; & cc --resume 0bffad12-00fb-420d-95b3-09e5a3390a63",
  )
})

test('bottom bar identifies Gateway providers without inventing quota data', () => {
  assert.equal(getGatewayProviderLabel('gateway-gpt-luna'), 'Codex')
  assert.equal(getGatewayProviderLabel('gateway-opencode-mimo-v2.5-free'), 'OpenCode')
  // The readout leads with the model, not with the provider label: the label
  // named the provider a second time on a row that already says it.
  assert.match(
    formatBottomBarUsage('gateway-gpt-luna', null, 200_000),
    /^model gateway-gpt-luna · usage unavailable · context unavailable$/,
  )
  assert.doesNotMatch(
    formatBottomBarUsage('gateway-gpt-luna', null, 200_000),
    /^Codex ·/,
  )
  // With a status line on the same row the model is already printed once, so
  // the readout must not print it again - nor the provider label that stood in
  // for it.
  assert.match(
    formatBottomBarUsage('gateway-gpt-luna', null, 200_000, undefined, null, {
      includeModel: false,
    }),
    /^usage unavailable · context unavailable$/,
  )
  assert.doesNotMatch(
    formatBottomBarUsage('gateway-gpt-luna', null, 200_000, undefined, null, {
      includeModel: false,
    }),
    /gateway-gpt-luna/,
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
