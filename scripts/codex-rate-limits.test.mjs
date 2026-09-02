import { strict as assert } from 'node:assert'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  isCodexGatewayModel,
  quotaFromRateLimits,
  readCodexQuotaFromRollouts,
} from '../src/utils/codexRateLimits.ts'
import { formatBottomBarUsage } from '../src/utils/bottomBarUsage.ts'


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
    assert.match(
      formatBottomBarUsage(
        'gateway-gpt-luna',
        null,
        200_000,
        undefined,
        quota,
      ),
      /Codex remaining 63%/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
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
