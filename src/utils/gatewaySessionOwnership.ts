import { mkdir, readFile, rm } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { lock } from './lockfile.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { isProcessRunning } from './genericProcessUtils.js'
import { registerCleanup } from './cleanupRegistry.js'

/**
 * The outcome of one acquisition: the release when the lock was taken, or the
 * reason it was refused.
 *
 * The refusal lives *in* the resolved value rather than in a side map, because a
 * side map has one slot per path and no idea how many callers are waiting on it.
 * The previous shape recorded the failure once and deleted it for the first
 * waiter, so every later caller awaiting the same attempt fell through to a bare
 * "Writer claim was not taken" - two callers refused by one held lock learned
 * different things. A value cannot be consumed by one reader.
 */
type WriterClaim = { release?: () => Promise<void>; refused?: unknown }

/**
 * The writer claims this process holds, keyed by the lock path each was taken on.
 *
 * A refusal is folded into the stored value at the point it is made rather than
 * left to propagate, because this map is read by the cleanup registry - which can
 * run long after the config home a claim was taken in has been deleted, and a
 * stored promise that rejects there is reported as an unhandled rejection rather
 * than as the caller's business.
 */
const claims = new Map<string, Promise<WriterClaim>>()

/**
 * Say what refused the claim and what to do, not just that it was refused.
 *
 * The underlying ELOCKED text ("Lock file is already being held") names the
 * state but not the actor or the move. It is carried inside the sentence rather
 * than replaced, because it is the phrase the lock's own callers and the
 * registration-failure report both read.
 */
function writerClaimRefusal(sessionId: string, refused: unknown): Error {
  const reason = refused instanceof Error
    ? refused.message
    : refused ? String(refused) : 'the writer lock is already being held'
  return new Error(`Another session is writing ${sessionId}'s record right now (${reason}). Retry once that writer releases its lock.`)
}

/**
 * Whether an endpoint positively refuses connections, which is proof that
 * nothing is listening there any more.
 *
 * Only a refusal counts. A timeout is not a refusal - an endpoint that accepted
 * the connection and then produced nothing is busy, and a busy owner is alive -
 * so the caller must not read this as death just because the probe ran out of
 * patience. Neither is an error of any other kind: a permission failure or a
 * transient resource error says nothing about whether the owner exists.
 */
async function endpointRefuses(endpoint: string): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    let settled = false
    const socket = createConnection(endpoint)
    const finish = (refused: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(refused)
    }
    socket.setTimeout(1000, () => finish(false))
    socket.once('connect', () => finish(false))
    socket.once('error', error => {
      const code = (error as NodeJS.ErrnoException).code
      finish(code === 'ECONNREFUSED' || code === 'ENOENT')
    })
  })
}

/**
 * Clear a writer claim left behind by a session that provably no longer exists.
 *
 * `proper-lockfile` locks are directories, and a directory outlives the process
 * that created it. When a session is Ctrl-C'd or killed while it holds the claim,
 * the claim survives, and the next launch is refused by its own corpse: the lock
 * is only cleared once its 30s stale window has elapsed, so a reopen that should
 * be instant instead waits out a corpse. The bus can prove the corpse is a corpse,
 * and this is the one case where removing someone else's claim is safe.
 *
 * Both signals are required, and both must be positive proofs: the registration
 * must name a pid that is gone AND an endpoint that refuses connections. A
 * missing or unreadable registration leaves the claim alone (the session may be
 * publishing right now), a live pid leaves it alone, and a busy endpoint leaves
 * it alone. Being wrong here would hand a live session's record to a second
 * writer, which is exactly what the claim exists to prevent; waiting 30s for an
 * empty lock is the safe failure.
 */
async function clearDeadWriterClaim(sessionId: string, claimPath: string): Promise<void> {
  let registration: { peer?: { pid?: unknown; endpoint?: unknown } }
  try {
    registration = JSON.parse(await readFile(join(getClaudeConfigHomeDir(), 'gateway-sessions', `${sessionId}.json`), 'utf8')) as typeof registration
  } catch { return }
  const pid = registration?.peer?.pid
  const endpoint = registration?.peer?.endpoint
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return
  if (typeof endpoint !== 'string' || endpoint.length === 0) return
  if (isProcessRunning(pid)) return
  if (!(await endpointRefuses(endpoint))) return
  await rm(`${claimPath}.lock`, { recursive: true, force: true }).catch(() => {})
}

/**
 * Take the writer claim for a session, or hand back the one already held.
 */
export async function claimGatewaySessionWriter(sessionId: string): Promise<void> {
  if (process.env.CLAUDE_CODE_USE_GATEWAY !== '1') return
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error('Invalid session identity')
  const directory = join(getClaudeConfigHomeDir(), 'gateway-writers')
  const path = join(directory, sessionId)
  let entry = claims.get(path)
  if (!entry) {
    entry = (async (): Promise<WriterClaim> => {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      try {
        return { release: await lock(path, { realpath: false, stale: 30000, retries: 0 }) }
      } catch (refused) {
        // A refusal normally means a live process is writing this record and must
        // be left alone. It also happens when the previous owner died holding the
        // claim, where the 30s stale window makes a reopen wait on a process that
        // no longer exists. Clearing a provably dead owner's claim is the only
        // case worth retrying; everything else keeps the refusal verbatim.
        await clearDeadWriterClaim(sessionId, path)
        try {
          return { release: await lock(path, { realpath: false, stale: 30000, retries: 0 }) }
        } catch (again) {
          return { refused: again }
        }
      }
    })()
    claims.set(path, entry)
  }
  const claim = await entry
  if (!claim.release) {
    // The attempt is retired so the next caller retries the lock instead of
    // replaying a refusal that may no longer hold. Waiters already awaiting this
    // entry each read the refusal from their own resolved value, so retiring it
    // takes nothing away from them.
    if (claims.get(path) === entry) claims.delete(path)
    throw writerClaimRefusal(sessionId, claim.refused)
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
 * claim that was never acquired (a refusal) has nothing to release.
 */
async function dropClaim(path: string, claim: Promise<WriterClaim>): Promise<void> {
  try {
    const outcome = await claim
    if (outcome.release) await outcome.release()
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
