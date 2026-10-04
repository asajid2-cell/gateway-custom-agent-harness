import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { lock } from './lockfile.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { registerCleanup } from './cleanupRegistry.js'

/**
 * The writer claims this process holds, keyed by the lock path each was taken on.
 *
 * The value is the *acquisition*, resolved to a release when the lock was taken
 * and to `undefined` when it was not. Both outcomes are kept rather than the
 * rejection being left to propagate, because this map is read by the cleanup
 * registry - which can run long after the config home a claim was taken in has
 * been deleted, and a stored promise that rejects there is reported as an
 * unhandled rejection rather than as the caller's business.
 */
const claims = new Map<string, Promise<(() => Promise<void>) | undefined>>()

/** Why an acquisition failed, so the caller that cared can still see the throw. */
const claimFailures = new Map<string, unknown>()

/**
 * Take the writer claim for a session, or hand back the one already held.
 *
 * Acquisition failure is folded into the stored value at the point it is made:
 * a caller awaiting this sees a real throw, while the map holds no rejecting
 * promise for cleanup to trip over.
 */
export async function claimGatewaySessionWriter(sessionId: string): Promise<void> {
  if (process.env.CLAUDE_CODE_USE_GATEWAY !== '1') return
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error('Invalid session identity')
  const directory = join(getClaudeConfigHomeDir(), 'gateway-writers')
  const path = join(directory, sessionId)
  let entry = claims.get(path)
  if (!entry) {
    const attempt = (async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      return lock(path, { realpath: false, stale: 30000, retries: 0 })
    })()
    entry = attempt.then(
      release => release,
      error => {
        claimFailures.set(path, error)
        return undefined
      },
    )
    claims.set(path, entry)
  }
  const release = await entry
  if (release === undefined) {
    const error = claimFailures.get(path)
    claimFailures.delete(path)
    throw error ?? new Error('Writer claim was not taken')
  }
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
 * The map entry is dropped either way so a spent claim is never retried, and a
 * claim that was never acquired (`undefined`) has nothing to release.
 */
async function dropClaim(path: string, claim: Promise<(() => Promise<void>) | undefined>): Promise<void> {
  try {
    const release = await claim
    if (release) await release()
  } catch {
    // Already released, or its lock/home is gone: released all the same.
  } finally {
    if (claims.get(path) === claim) claims.delete(path)
    claimFailures.delete(path)
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
