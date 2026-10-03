import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { lock } from './lockfile.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { registerCleanup } from './cleanupRegistry.js'

const claims = new Map<string, Promise<() => Promise<void>>>()

export async function claimGatewaySessionWriter(sessionId: string): Promise<void> {
  if (process.env.CLAUDE_CODE_USE_GATEWAY !== '1') return
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error('Invalid session identity')
  const directory = join(getClaudeConfigHomeDir(), 'gateway-writers')
  const path = join(directory, sessionId)
  let claim = claims.get(path)
  if (!claim) {
    claim = (async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      return lock(path, { realpath: false, stale: 30000, retries: 0 })
    })()
    claims.set(path, claim)
    claim.catch(() => { if (claims.get(path) === claim) claims.delete(path) })
  }
  await claim
}

/**
 * Drop one claim, tolerating a release that is already spent.
 *
 * A release is not guaranteed to be the first, nor to find its lock still there.
 * `proper-lockfile`'s release stats the lock file and throws `ECOMPROMISED`
 * (ENOENT) when it has already been removed - which happens whenever a claim
 * outlives the config home it was taken in, including a test that deletes its
 * temp home while the claim is still held. A lock that is gone is released by
 * definition, so a throw here would only turn a completed release into a failure.
 * The map entry is dropped either way so a spent claim is never retried.
 */
async function dropClaim(path: string, claim: Promise<() => Promise<void>>): Promise<void> {
  try {
    await (await claim)()
  } catch {
    // Already released, or its lock/home is gone: released all the same.
  } finally {
    if (claims.get(path) === claim) claims.delete(path)
  }
}

export async function releaseGatewaySessionWriter(sessionId: string): Promise<void> {
  const path = join(getClaudeConfigHomeDir(), 'gateway-writers', sessionId)
  const claim = claims.get(path)
  if (!claim) return
  await dropClaim(path, claim)
}

registerCleanup(async () => {
  await (await import('./sessionStorage.js')).flushSessionStorage()
  // Release by the path each claim was taken on. Iterate a copy: `dropClaim`
  // deletes from the live map.
  for (const [path, claim] of [...claims]) await dropClaim(path, claim)
})
