/**
 * Shared, cross-process cache for the subscription quotas the footer reads.
 *
 * Every `cc` launch spawns its own model gateway, so N sessions are N gateway
 * processes polling one account. Before this module each process cached the
 * provider's answer privately, which is why the same subscription was asked
 * over and over until the provider answered 429. A file per provider/account
 * under a user cache directory is shared by every gateway on the machine, so
 * one poll serves them all and one 429 makes them all back off together.
 *
 * The file is a plain JSON snapshot. It holds a normalized quota (0-100 used
 * percentages) and never a credential: `writeSharedQuota` copies a fixed field
 * list, so a caller cannot leak a token through it even by accident, and the
 * file is keyed by provider and account NUMBER rather than by key.
 *
 * This module is pure policy over the filesystem: the routes own the upstream
 * calls, the module owns when a cached answer may be reused and when an
 * upstream call is forbidden because the provider is in backoff.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

// How long a cached answer may be served without asking upstream. Anthropic's
// endpoint is the one that rate-limits hardest, so it is allowed the longest
// leash; OpenCode and Codex are cheap enough to re-read a minute apart.
export const QUOTA_TTL_MS = {
  anthropic: 120_000,
  opencode: 60_000,
  codex: 60_000,
  commandcode: 60_000,
  mistral: 60_000,
}

/**
 * Where the shared snapshots live. `MODEL_GATEWAY_QUOTA_CACHE_DIR` overrides it
 * so tests can point several gateway processes at one temp directory without
 * touching the real user cache.
 */
export function quotaCacheDir(env = process.env) {
  if (env.MODEL_GATEWAY_QUOTA_CACHE_DIR) return env.MODEL_GATEWAY_QUOTA_CACHE_DIR
  if (process.platform === 'win32') {
    const base = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    return path.join(base, 'Gateway', 'quota-cache')
  }
  const base = env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache')
  return path.join(base, 'gateway', 'quota-cache')
}

/** The cache key for one provider account. Account is a number, never a key. */
export function quotaKey(provider, account = 1) {
  const number = Number.isSafeInteger(account) && account > 0 ? account : 1
  return `${provider}-${number}`
}

function quotaCachePath(key, env) {
  // The key is built from a provider name and a number, but it is sanitized
  // anyway so a bad caller cannot escape the cache directory with `..` or a
  // path separator.
  const safe = String(key).toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 64)
  return path.join(quotaCacheDir(env), `${safe}.json`)
}

// The only fields a snapshot may hold. `windows` carries the normalized
// `{ H?, W?, M? }` figures; `account` is the OpenCode key number serving, if
// known. No field here is ever a credential.
const CACHE_FIELDS = ['asof', 'windows', 'account', 'nextAllowedAt', 'backoffMs']

function sanitizeEntry(entry) {
  const out = {}
  for (const field of CACHE_FIELDS) {
    if (entry?.[field] !== undefined) out[field] = entry[field]
  }
  return out
}

/** The shared snapshot for a key, or null when there is none or it is corrupt. */
export async function readSharedQuota(key, env = process.env) {
  try {
    const parsed = JSON.parse(await fs.readFile(quotaCachePath(key, env), 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    if (typeof parsed.asof !== 'number' || !Number.isFinite(parsed.asof)) return null
    if (parsed.windows !== undefined && (typeof parsed.windows !== 'object' || parsed.windows === null)) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

/**
 * Write a snapshot atomically: a temp file beside it, then a rename, so a
 * reader never sees a half-written file and two writers cannot interleave.
 * Returns false rather than throwing - a cache that cannot be written must not
 * fail the request that is only trying to report a number.
 */
export async function writeSharedQuota(key, entry, env = process.env) {
  const file = quotaCachePath(key, env)
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(temp, JSON.stringify(sanitizeEntry(entry)))
    await fs.rename(temp, file)
    return true
  } catch {
    await fs.unlink(temp).catch(() => {})
    return false
  }
}

/** Remove a snapshot. Used by tests; not part of the serving path. */
export async function clearSharedQuota(key, env = process.env) {
  await fs.unlink(quotaCachePath(key, env)).catch(() => {})
}

/** True when a snapshot is present and younger than the provider's TTL. */
export function quotaIsFresh(entry, ttlMs, now = Date.now()) {
  return Boolean(entry) &&
    typeof entry.asof === 'number' &&
    Number.isFinite(entry.asof) &&
    now - entry.asof < ttlMs
}

/** True while a recorded backoff forbids an upstream call. */
export function quotaIsBackedOff(entry, now = Date.now()) {
  return Boolean(entry) &&
    typeof entry.nextAllowedAt === 'number' &&
    Number.isFinite(entry.nextAllowedAt) &&
    now < entry.nextAllowedAt
}

/**
 * The wire shape a route returns. `stale` is set by the caller: a fresh answer
 * is not stale, an answer served from the cache or from a fallback is.
 */
export function quotaPayload(entry, stale) {
  if (!entry || !entry.windows) return null
  const payload = { windows: entry.windows, asof: entry.asof, stale: Boolean(stale) }
  if (typeof entry.account === 'number') payload.account = entry.account
  return payload
}

// One upstream call per key per process, shared by every request that asks for
// the same key while it is in flight. Cross-process sharing is the cache file's
// job; this only removes the thundering herd inside one gateway.
const inFlight = new Map()

export function quotaInFlight(key, factory) {
  const existing = inFlight.get(key)
  if (existing) return existing
  const pending = Promise.resolve().then(factory).finally(() => {
    if (inFlight.get(key) === pending) inFlight.delete(key)
  })
  inFlight.set(key, pending)
  return pending
}

export function resetQuotaInFlight() {
  inFlight.clear()
}

/**
 * Read one provider's quota through the shared cache.
 *
 * `read` is the upstream call. It returns `{ windows, account? }` for a fresh
 * answer (an empty `windows` means the provider had no figure to report), or
 * `{ windows: null, backoffMs }` when it could not answer. A `read` that throws
 * counts as the latter.
 *
 * The policy, in order:
 *  - a shared answer younger than `ttlMs` is served as-is, with no upstream call
 *  - while a recorded backoff is live the last good answer is served `stale`,
 *    and no upstream call is made
 *  - otherwise one upstream call is made per key; concurrent callers share it
 *  - a fresh answer is written back and clears any backoff
 *  - a failed call records its backoff and serves the last good answer `stale`
 *
 * Returns the ProviderQuota payload, or null when there is nothing to report.
 */
export async function readQuotaThroughCache({ key, ttlMs, read, env = process.env, now = Date.now }) {
  const shared = await readSharedQuota(key, env)
  if (quotaIsFresh(shared, ttlMs, now())) {
    const fresh = quotaPayload(shared, false)
    if (fresh) return fresh
  }
  if (quotaIsBackedOff(shared, now())) {
    return quotaPayload(shared, true)
  }

  return quotaInFlight(key, async () => {
    // A caller that was waiting behind the in-flight call re-reads the file:
    // the call it waited on may already have refreshed the snapshot.
    const latest = await readSharedQuota(key, env)
    if (quotaIsFresh(latest, ttlMs, now())) {
      const fresh = quotaPayload(latest, false)
      if (fresh) return fresh
    }
    if (quotaIsBackedOff(latest, now())) {
      return quotaPayload(latest, true)
    }

    let result
    try {
      result = await read()
    } catch {
      result = { windows: null }
    }

    if (result && result.windows) {
      // A fresh answer clears any backoff the previous failure recorded.
      const entry = { asof: now(), windows: result.windows, nextAllowedAt: null, backoffMs: 0 }
      if (typeof result.account === 'number') entry.account = result.account
      await writeSharedQuota(key, entry, env)
      return quotaPayload(entry, false)
    }

    const backoffMs = Number.isFinite(result?.backoffMs) ? Math.max(0, result.backoffMs) : 0
    const lastGood = latest ?? shared
    // A failed read is not an answer, so it must not look fresh: a fresh empty
    // snapshot would be served as the reading on the next poll and the backoff
    // below would never be consulted. When there is no prior good value to
    // carry, the failure's `asof` is placed a hair past the TTL so freshness is
    // provably false regardless of the clock's magnitude - `0` would read as
    // fresh under a small injected clock, and `now()` under any clock.
    const entry = sanitizeEntry({
      ...(lastGood ?? { asof: now() - ttlMs - 1, windows: {} }),
      nextAllowedAt: backoffMs > 0 ? now() + backoffMs : (lastGood?.nextAllowedAt ?? null),
      backoffMs,
    })
    await writeSharedQuota(key, entry, env)
    return quotaPayload(lastGood, true)
  })
}
