import { strict as assert } from 'node:assert'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  codexQuotaToProviderQuota,
  isCodexGatewayModel,
  quotaFromRateLimits,
  readCodexQuotaFromRollouts,
} from '../src/utils/codexRateLimits.ts'
import { formatProviderQuota } from '../src/utils/bottomBarUsage.ts'


test('Codex quota opt-in covers Gateway Codex model family', () => {
  assert.equal(isCodexGatewayModel('gateway-gpt-luna'), true)
  assert.equal(isCodexGatewayModel('gateway-gpt-sol'), true)
  assert.equal(isCodexGatewayModel('gateway-gpt-terra'), true)
  assert.equal(isCodexGatewayModel('gateway-opencode-glm-5.3-flash'), false)
})



test('Codex RPC rate limits normalize nested limit windows', () => {
  assert.deepEqual(
    quotaFromRateLimits({
      rateLimits: {
        primary: { usedPercent: 58, resetsAt: 1788795032 },
        rateLimitsByLimitId: {
          codex_bengalfox: {
            primary: { usedPercent: 0, resetsAt: 1788393413 },
            secondary: { usedPercent: 0, resetsAt: 1788980213 },
          },
        },
      },
    }, 123),
    {
      remainingPercent: 42,
      primaryUsedPercent: 58,
      secondaryUsedPercent: 0,
      resetsPrimary: 1788795032,
      resetsSecondary: 1788980213,
      asof: 123,
    },
  )
})

test('Codex quota uses the most restrictive primary or secondary window', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-codex-quota-'))
  try {
    await mkdir(join(root, '2026', '09', '02'), { recursive: true })
    await writeFile(
      join(root, '2026', '09', '02', 'rollout-test.jsonl'),
      `${JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: {
        primary: { used_percent: 12, resets_at: 100 },
        secondary: { used_percent: 37, resets_at: 200 },
      } } })}\n`,
    )

    const quota = readCodexQuotaFromRollouts(root)
    assert.deepEqual(quota, {
      remainingPercent: 63,
      primaryUsedPercent: 12,
      secondaryUsedPercent: 37,
      resetsPrimary: 100,
      resetsSecondary: 200,
      asof: quota.asof,
    })
    // The primary 5-hour window is H, the weekly secondary is W, and each keeps
    // its own figure rather than collapsing to the most restrictive one.
    const providerQuota = codexQuotaToProviderQuota(quota)
    assert.equal(formatProviderQuota('Codex', providerQuota, 'H'), 'Codex H remaining 88%')
    assert.equal(formatProviderQuota('Codex', providerQuota, 'W'), 'Codex W remaining 63%')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Codex windows map the primary 5-hour and secondary weekly windows', () => {
  const mapped = codexQuotaToProviderQuota({
    remainingPercent: 42,
    primaryUsedPercent: 58,
    secondaryUsedPercent: 0,
    resetsPrimary: 1_788_795_032,
    resetsSecondary: 1_788_980_213,
    asof: 123,
  })
  // The app-server answers resetsAt in epoch seconds; the shape carries ms.
  assert.deepEqual(mapped.windows.H, { usedPercent: 58, resetsAt: 1_788_795_032_000 })
  assert.deepEqual(mapped.windows.W, { usedPercent: 0, resetsAt: 1_788_980_213_000 })
  assert.equal(mapped.asof, 123)
  assert.equal(mapped.stale, false)
  // A window the reader did not find is simply absent, not a zero.
  const onlyPrimary = codexQuotaToProviderQuota({
    remainingPercent: 42,
    primaryUsedPercent: 58,
    secondaryUsedPercent: null,
    resetsPrimary: null,
    resetsSecondary: null,
    asof: 1,
  })
  assert.deepEqual(Object.keys(onlyPrimary.windows), ['H'])
  assert.equal(formatProviderQuota('Codex', onlyPrimary, 'W'), null)
})

test('Codex quota is unavailable when rollout snapshots have no numeric limits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-codex-quota-'))
  try {
    await writeFile(
      join(root, 'rollout-empty.jsonl'),
      `${JSON.stringify({ type: 'token_count', rate_limits: {
        primary: { used_percent: null },
        secondary: { used_percent: null },
      } })}\n`,
    )
    assert.equal(readCodexQuotaFromRollouts(root), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
