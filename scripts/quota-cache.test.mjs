import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  QUOTA_TTL_MS,
  clearSharedQuota,
  quotaCacheDir,
  quotaIsBackedOff,
  quotaIsFresh,
  quotaKey,
  quotaPayload,
  readQuotaThroughCache,
  readSharedQuota,
  resetQuotaInFlight,
  writeSharedQuota,
} from './quota-cache.mjs'

async function tempEnv() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quota-cache-'))
  return { env: { MODEL_GATEWAY_QUOTA_CACHE_DIR: dir }, dir }
}

test('a cache key is the provider and account number, never a credential', () => {
  assert.equal(quotaKey('anthropic'), 'anthropic-1')
  assert.equal(quotaKey('opencode', 3), 'opencode-3')
  // A non-number or non-positive account falls back to 1 rather than reaching
  // the filesystem as something surprising.
  assert.equal(quotaKey('codex', 0), 'codex-1')
  assert.equal(quotaKey('codex', -2), 'codex-1')
  assert.equal(quotaKey('codex', 1.5), 'codex-1')
})

test('the cache directory honors the override, then the platform default', () => {
  assert.equal(quotaCacheDir({ MODEL_GATEWAY_QUOTA_CACHE_DIR: '/tmp/x' }), '/tmp/x')
  const windows = quotaCacheDir({ LOCALAPPDATA: 'C:/Local' })
  const posix = quotaCacheDir({ XDG_CACHE_HOME: '/home/u/.cache' })
  if (process.platform === 'win32') {
    assert.match(windows, /quota-cache$/)
  } else {
    assert.equal(posix, '/home/u/.cache/gateway/quota-cache')
  }
})

test('a snapshot round-trips and never carries a credential-shaped field', async () => {
  const { env, dir } = await tempEnv()
  try {
    await writeSharedQuota(
      'opencode-2',
      {
        asof: 1_000,
        windows: { W: { usedPercent: 37, resetsAt: 2_000 } },
        account: 2,
        nextAllowedAt: null,
        // A caller mistake must not become a leak.
        key: 'sk-do-not-store',
        authorization: 'Bearer secret',
      },
      env,
    )
    const entry = await readSharedQuota('opencode-2', env)
    assert.deepEqual(entry, {
      asof: 1_000,
      windows: { W: { usedPercent: 37, resetsAt: 2_000 } },
      account: 2,
      nextAllowedAt: null,
    })
    const raw = await readFile(path.join(dir, 'opencode-2.json'), 'utf8')
    assert.doesNotMatch(raw, /do-not-store/)
    assert.doesNotMatch(raw, /Bearer/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an atomic write leaves no temp files behind', async () => {
  const { env, dir } = await tempEnv()
  try {
    await writeSharedQuota('anthropic-1', { asof: 1, windows: {} }, env)
    await writeSharedQuota('anthropic-1', { asof: 2, windows: {} }, env)
    assert.deepEqual((await readdir(dir)).sort(), ['anthropic-1.json'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('freshness and backoff are read from the snapshot', () => {
  const now = 10_000
  assert.equal(quotaIsFresh({ asof: 9_000 }, 2_000, now), true)
  assert.equal(quotaIsFresh({ asof: 7_000 }, 2_000, now), false)
  assert.equal(quotaIsFresh(null, 2_000, now), false)
  assert.equal(quotaIsBackedOff({ nextAllowedAt: 11_000 }, now), true)
  assert.equal(quotaIsBackedOff({ nextAllowedAt: 9_000 }, now), false)
  assert.equal(quotaIsBackedOff(null, now), false)
})

test('the payload drops the account when it is not a number', () => {
  assert.deepEqual(quotaPayload({ asof: 5, windows: {} }, true), {
    windows: {},
    asof: 5,
    stale: true,
  })
  assert.equal(quotaPayload(null, false), null)
  assert.equal(quotaPayload({ asof: 5 }, false), null)
})

test('two gateways sharing a cache directory make one upstream call within the TTL', async () => {
  const { env, dir } = await tempEnv()
  let clock = 1_000
  let upstream = 0
  const read = async () => {
    upstream += 1
    return { windows: { W: { usedPercent: 12, resetsAt: null } } }
  }
  try {
    const first = await readQuotaThroughCache({ key: 'anthropic-1', ttlMs: QUOTA_TTL_MS.anthropic, read, env, now: () => clock })
    assert.equal(upstream, 1)
    assert.equal(first.stale, false)
    assert.equal(first.asof, 1_000)

    // A second gateway process: no in-process state, same file on disk.
    resetQuotaInFlight()
    clock += QUOTA_TTL_MS.anthropic - 1
    const second = await readQuotaThroughCache({ key: 'anthropic-1', ttlMs: QUOTA_TTL_MS.anthropic, read, env, now: () => clock })
    assert.equal(upstream, 1, 'a fresh snapshot must not cost a second upstream call')
    assert.equal(second.stale, false)

    // Past the TTL the provider is asked again.
    clock += 2
    resetQuotaInFlight()
    await readQuotaThroughCache({ key: 'anthropic-1', ttlMs: QUOTA_TTL_MS.anthropic, read, env, now: () => clock })
    assert.equal(upstream, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a failed read serves the last good value stale and then backs off', async () => {
  const { env, dir } = await tempEnv()
  let clock = 5_000
  let upstream = 0
  let failing = false
  const read = async () => {
    upstream += 1
    if (failing) return { windows: null, backoffMs: 60_000 }
    return { windows: { H: { usedPercent: 40, resetsAt: 9_000 } } }
  }
  try {
    const good = await readQuotaThroughCache({ key: 'anthropic-1', ttlMs: 120_000, read, env, now: () => clock })
    assert.equal(good.stale, false)
    assert.equal(upstream, 1)

    // Past the TTL the call fails; the last good figure is served, marked stale,
    // and a backoff is recorded.
    failing = true
    clock += 120_001
    resetQuotaInFlight()
    const stale = await readQuotaThroughCache({ key: 'anthropic-1', ttlMs: 120_000, read, env, now: () => clock })
    assert.equal(upstream, 2)
    assert.equal(stale.stale, true)
    assert.deepEqual(stale.windows, { H: { usedPercent: 40, resetsAt: 9_000 } })

    // While the backoff is live no upstream call is made at all - this is what
    // stops N gateways from hammering a 429.
    clock += 1_000
    resetQuotaInFlight()
    const backedOff = await readQuotaThroughCache({ key: 'anthropic-1', ttlMs: 120_000, read, env, now: () => clock })
    assert.equal(upstream, 2, 'a live backoff must forbid the upstream call')
    assert.equal(backedOff.stale, true)

    // After the backoff expires the provider is tried again, and a success
    // clears it.
    failing = false
    clock += 120_000
    resetQuotaInFlight()
    const recovered = await readQuotaThroughCache({ key: 'anthropic-1', ttlMs: 120_000, read, env, now: () => clock })
    assert.equal(upstream, 3)
    assert.equal(recovered.stale, false)
    const entry = await readSharedQuota('anthropic-1', env)
    assert.equal(entry.nextAllowedAt, null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a failure with no prior value is not cached as a fresh empty reading', async () => {
  // A failed read is not an answer. Stamping `asof` at the failure instant
  // would make the empty snapshot look fresh for the whole TTL, so with no
  // backoff recorded the next poll would be served that empty "fresh" reading
  // instead of trying the provider again.
  const { env, dir } = await tempEnv()
  let clock = 1_000
  let upstream = 0
  const read = async () => {
    upstream += 1
    return { windows: null }
  }
  try {
    resetQuotaInFlight()
    const first = await readQuotaThroughCache({ key: 'codex-1', ttlMs: 60_000, read, env, now: () => clock })
    assert.equal(first, null)
    assert.equal(upstream, 1)

    // No backoff was recorded, so the next poll must actually try again rather
    // than treat the failure as a reading cached for the TTL.
    clock += 1_000
    resetQuotaInFlight()
    await readQuotaThroughCache({ key: 'codex-1', ttlMs: 60_000, read, env, now: () => clock })
    assert.equal(upstream, 2, 'a backoff-less failure must not be cached as fresh')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('concurrent callers in one process share a single upstream call', async () => {
  const { env, dir } = await tempEnv()
  let upstream = 0
  let release
  const gate = new Promise(resolve => { release = resolve })
  const read = async () => {
    upstream += 1
    await gate
    return { windows: { W: { usedPercent: 1, resetsAt: null } } }
  }
  try {
    resetQuotaInFlight()
    const a = readQuotaThroughCache({ key: 'opencode-1', ttlMs: 60_000, read, env })
    const b = readQuotaThroughCache({ key: 'opencode-1', ttlMs: 60_000, read, env })
    release()
    const [first, second] = await Promise.all([a, b])
    assert.equal(upstream, 1)
    assert.deepEqual(first, second)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a read that throws is treated as a failure, not a crash', async () => {
  const { env, dir } = await tempEnv()
  try {
    resetQuotaInFlight()
    const payload = await readQuotaThroughCache({
      key: 'codex-1',
      ttlMs: 60_000,
      read: async () => { throw new Error('upstream exploded') },
      env,
    })
    assert.equal(payload, null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('clearSharedQuota removes the snapshot without failing when absent', async () => {
  const { env, dir } = await tempEnv()
  try {
    await writeSharedQuota('anthropic-1', { asof: 1, windows: {} }, env)
    await clearSharedQuota('anthropic-1', env)
    assert.equal(await readSharedQuota('anthropic-1', env), null)
    await clearSharedQuota('anthropic-1', env)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
