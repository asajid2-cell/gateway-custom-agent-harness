import { strict as assert } from 'node:assert'
import test from 'node:test'

import {
  availableQuotaKinds,
  formatBottomBarUsage,
  formatProviderQuota,
  formatSessionResumeCommand,
  getContextUsageValues,
  getGatewayProviderLabel,
  getWeeklyRemainingPercent,
  isAnthropicGatewayModel,
  nextQuotaKind,
  QUOTA_CYCLE,
} from '../src/utils/bottomBarUsage.ts'

import { openCodeQuotaFromPayload } from '../src/utils/opencodeUsage.ts'

const quota = (windows, extra = {}) => ({ windows, asof: 1_000, stale: false, ...extra })
const win = (usedPercent = 0) => ({ usedPercent, resetsAt: null })

test('the quota cycle lists each provider windows in click order', () => {
  assert.deepEqual(QUOTA_CYCLE.Codex, ['W', 'H'])
  assert.deepEqual(QUOTA_CYCLE.Anthropic, ['W', 'H'])
  assert.deepEqual(QUOTA_CYCLE.OpenCode, ['W', 'H', 'M'])
})

test('the available windows are the reported ones, in cycle order', () => {
  assert.deepEqual(availableQuotaKinds('Codex', quota({ W: win(1) })), ['W'])
  assert.deepEqual(
    availableQuotaKinds('OpenCode', quota({ W: win(), H: win(), M: win() })),
    ['W', 'H', 'M'],
  )
  // A window the provider omitted is skipped, not shown as a zero.
  assert.deepEqual(
    availableQuotaKinds('OpenCode', quota({ H: win(), M: win() })),
    ['H', 'M'],
  )
  assert.deepEqual(availableQuotaKinds('Anthropic', quota({})), [])
})

test('a click steps to the next reported window and wraps', () => {
  const codex = quota({ W: win(), H: win() })
  assert.equal(nextQuotaKind('Codex', codex, null), 'W')
  assert.equal(nextQuotaKind('Codex', codex, 'W'), 'H')
  assert.equal(nextQuotaKind('Codex', codex, 'H'), 'W')

  const opencode = quota({ W: win(), H: win(), M: win() })
  assert.equal(nextQuotaKind('OpenCode', opencode, null), 'W')
  assert.equal(nextQuotaKind('OpenCode', opencode, 'W'), 'H')
  assert.equal(nextQuotaKind('OpenCode', opencode, 'H'), 'M')
  assert.equal(nextQuotaKind('OpenCode', opencode, 'M'), 'W')

  // A missing window is skipped rather than shown empty: hourly -> monthly -> hourly.
  const noWeekly = quota({ H: win(), M: win() })
  assert.equal(nextQuotaKind('OpenCode', noWeekly, null), 'H')
  assert.equal(nextQuotaKind('OpenCode', noWeekly, 'H'), 'M')
  assert.equal(nextQuotaKind('OpenCode', noWeekly, 'M'), 'H')

  // One window has nothing to cycle to, so the same window comes back.
  const one = quota({ W: win() })
  assert.equal(nextQuotaKind('Anthropic', one, null), 'W')
  assert.equal(nextQuotaKind('Anthropic', one, 'W'), 'W')

  // Nothing reported is nothing to show, and a window that vanished between
  // readings falls back to the first available.
  assert.equal(nextQuotaKind('Codex', quota({}), null), null)
  assert.equal(nextQuotaKind('Codex', codex, 'M'), 'W')
})

test('a quota window prints the provider, the window and what is left', () => {
  const codex = quota({
    H: { usedPercent: 0, resetsAt: null },
    W: { usedPercent: 23, resetsAt: null },
  })
  assert.equal(formatProviderQuota('Codex', codex, 'W'), 'Codex W remaining 77%')
  assert.equal(formatProviderQuota('Codex', codex, 'H'), 'Codex H remaining 100%')
  // A window the provider did not report prints nothing rather than a zero.
  assert.equal(formatProviderQuota('Codex', codex, 'M'), null)
})

test('a stale figure says so and a wild used percent is clamped', () => {
  assert.equal(
    formatProviderQuota(
      'OpenCode',
      quota({ M: { usedPercent: 100, resetsAt: null } }, { stale: true }),
      'M',
    ),
    'OpenCode M remaining 0% (stale)',
  )
  assert.equal(
    formatProviderQuota('Anthropic', quota({ H: { usedPercent: 140, resetsAt: null } }), 'H'),
    'Anthropic H remaining 0%',
  )
  assert.equal(
    formatProviderQuota('Anthropic', quota({ H: { usedPercent: -20, resetsAt: null } }), 'H'),
    'Anthropic H remaining 100%',
  )
})

test('OpenCode keeps each normalized window rather than collapsing them', () => {
  const parsed = openCodeQuotaFromPayload({
    windows: {
      H: { usedPercent: 0, resetsAt: null },
      W: { usedPercent: 0, resetsAt: null },
      M: { usedPercent: 100, resetsAt: null },
    },
    asof: 7,
    account: 3,
  })
  // The monthly window is exhausted, but it no longer dominates the others:
  // each window keeps its own figure instead of one collapsed number reading 0%.
  assert.deepEqual(parsed.windows.H, { usedPercent: 0, resetsAt: null })
  assert.deepEqual(parsed.windows.W, { usedPercent: 0, resetsAt: null })
  assert.deepEqual(parsed.windows.M, { usedPercent: 100, resetsAt: null })
  assert.equal(parsed.asof, 7)
  assert.equal(parsed.account, 3)
  assert.equal(formatProviderQuota('OpenCode', parsed, 'M'), 'OpenCode M remaining 0%')
  assert.equal(formatProviderQuota('OpenCode', parsed, 'W'), 'OpenCode W remaining 100%')
  // The legacy usage object is no longer accepted; the gateway owns that mapping.
  assert.equal(openCodeQuotaFromPayload({
    usage: { rolling: { percent: 0 }, weekly: { percent: 0 }, monthly: { percent: 100 } },
  }), null)
  // Nothing to report reads as nothing, not as an empty limit.
  assert.equal(openCodeQuotaFromPayload({}), null)
  assert.equal(openCodeQuotaFromPayload({ windows: {} }), null)
})

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
  assert.equal(getGatewayProviderLabel('gateway-claude-opus-5-5'), 'Anthropic')
  // A model that routes through no subscription provider has no label to show.
  assert.equal(getGatewayProviderLabel('gateway-ds-flash'), 'Gateway')
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
    formatBottomBarUsage('gateway-gpt-luna', null, 200_000, undefined, {
      includeModel: false,
    }),
    /^usage unavailable · context unavailable$/,
  )
  assert.doesNotMatch(
    formatBottomBarUsage('gateway-gpt-luna', null, 200_000, undefined, {
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

test('the readout no longer carries a provider remaining part', () => {
  const usage = {
    input_tokens: 10_000,
    output_tokens: 500,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  }
  // The provider figure is its own element now; the readout string must not
  // carry a `remaining` part at all, whatever the model routes through.
  assert.doesNotMatch(formatBottomBarUsage('gateway-claude-opus-5-5', usage, 200_000), /remaining/)
  assert.doesNotMatch(formatBottomBarUsage('gateway-opencode-deepseek-v4.1-flash', usage, 200_000), /remaining/)
  assert.match(formatBottomBarUsage('gateway-claude-opus-5-5', usage, 200_000), /^model gateway-claude-opus-5-5 · usage .* · context /)
})

test('isAnthropicGatewayModel recognises only the Anthropic route', () => {
  assert.equal(isAnthropicGatewayModel('gateway-claude-opus-5-5'), true)
  assert.equal(isAnthropicGatewayModel('gateway-gpt-luna'), false)
  assert.equal(isAnthropicGatewayModel('opus'), false)
})
