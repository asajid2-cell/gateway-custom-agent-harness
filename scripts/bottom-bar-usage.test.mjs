import { strict as assert } from 'node:assert'
import test from 'node:test'

import {
  formatBottomBarUsage,
  formatSessionResumeCommand,
  getAnthropicRemainingPercent,
  getContextUsageValues,
  getGatewayProviderLabel,
  getWeeklyRemainingPercent,
  isAnthropicGatewayModel,
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

test('an Anthropic route reports the subscription limit the way Codex does', () => {
  assert.equal(getGatewayProviderLabel('gateway-claude-opus-5-5'), 'Anthropic')
  assert.equal(isAnthropicGatewayModel('gateway-claude-opus-5-5'), true)
  assert.equal(isAnthropicGatewayModel('gateway-gpt-luna'), false)
  assert.equal(isAnthropicGatewayModel('opus'), false)

  // The window nearest its limit is the one that governs, and each figure is a
  // fraction of the limit that has been used - the scale the endpoint actually
  // answers (`five_hour.utilization = 0.05` for five percent) and the one the
  // reply headers carry.
  assert.equal(
    getAnthropicRemainingPercent({ five_hour: { utilization: 0.37 } }),
    63,
  )
  assert.equal(
    getAnthropicRemainingPercent({
      five_hour: { utilization: 0.12 },
      seven_day: { utilization: 0.88 },
    }),
    12,
  )
  // A figure read at the wrong scale is the bug this pins: 0.05 used is 95%
  // left, not 100% left.
  assert.equal(
    getAnthropicRemainingPercent({
      five_hour: { utilization: 0.05 },
      seven_day: { utilization: 0.01 },
    }),
    95,
  )
  // Nothing to report must read as nothing, not as an empty limit.
  assert.equal(getAnthropicRemainingPercent({}), null)
  assert.equal(getAnthropicRemainingPercent(null), null)
  assert.equal(getAnthropicRemainingPercent(undefined), null)
  assert.equal(
    getAnthropicRemainingPercent({ five_hour: { utilization: null } }),
    null,
  )
  assert.equal(
    getAnthropicRemainingPercent({ five_hour: { utilization: 1.4 } }),
    0,
  )

  assert.match(
    formatBottomBarUsage('gateway-claude-opus-5-5', null, 200_000, undefined, {
      remainingPercent: 63,
    }),
    /^(model gateway-claude-opus-5-5 · )?Anthropic remaining 63% · /,
  )
  // The label names the model's provider, so a quota handed to a route from a
  // different provider is not printed under someone else's name.
  assert.doesNotMatch(
    formatBottomBarUsage('gateway-ds-flash', null, 200_000, undefined, {
      remainingPercent: 63,
    }),
    /remaining 63%/,
  )
})
