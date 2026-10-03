/**
 * The durable cross-session ledger: ownership that is looked up, and a session
 * history that outlives the process that wrote it.
 *
 * The defect this exists to close is the stale-ledger failure class: a claim
 * about which session owns what, held in someone's context, that is neither
 * durable nor checked. A coordinator that guesses ownership from a name - or
 * from a task list that a session switch can lose - will eventually hand work
 * to the wrong lane or to nobody, and nothing anywhere will contradict it.
 *
 * Identity here is always `(familyRootSessionId, sessionId)`. It is deliberately
 * NOT a seat: the family already is the durable identity of a session (its root
 * outlives the member), so a seat would be a second identity that can disagree
 * with the first. Do not reintroduce one.
 *
 * Storage is append-only JSONL under `<config-home>/zenith-ledger/`:
 *
 *   - `sessions.jsonl`     observations of live sessions (C1): a dated history.
 *                          A session with no record is UNKNOWN, never assumed.
 *   - `assignments.jsonl`  workKey ownership events (C2): who took what, when,
 *                          and what ended it. State is a fold over the file.
 *   - `index.json`         a derived, never-authoritative cache (P6 speedup).
 *                          Everything it says is reproducible from the JSONL;
 *                          a disagreement resolves in favour of the JSONL.
 *
 * Append-only is what makes the file a history rather than a snapshot: the fold
 * is the current state, so a lost index costs a rebuild and never data, and two
 * writers that both appended are both represented rather than one winning.
 *
 * Cross-process appends are serialized with the repo's own `lock` (proper-
 * lockfile) because `O_APPEND` atomicity is not something to rely on across
 * processes on Windows - and this machine runs many sessions against one config
 * home. A lock also gives the fold a stable read, so an owner lookup cannot read
 * half of a line.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { getSessionId } from '../bootstrap/state.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { lock } from './lockfile.js'
import { isProcessRunning } from './genericProcessUtils.js'

/** Where the ledger lives. One directory per config home, like every other index. */
export function zenithLedgerDir(): string {
  return join(getClaudeConfigHomeDir(), 'zenith-ledger')
}

function ledgerPath(name: 'sessions' | 'assignments'): string {
  return join(zenithLedgerDir(), `${name}.jsonl`)
}

/**
 * An observation of one live session, at one time (C1).
 *
 * Dated on write and never rewritten: the history of a session is the sequence
 * of observations about it, and the latest one is what it is as of. `pid` and
 * `processStartedAt` are carried for the same reason the Zenith claim carries
 * them - a pid alone cannot say whether the session that wrote this is still
 * there, because pids are recycled.
 */
const sessionObservationSchema = z.object({
  version: z.literal(1),
  sessionId: z.string().uuid(),
  familyRootSessionId: z.string().uuid(),
  name: z.string().min(1).max(400),
  pid: z.number().int().nonnegative().optional(),
  processStartedAt: z.string().datetime().optional(),
  observedAt: z.string().datetime(),
  /** The build this session was running, when it could say. Absent is UNKNOWN. */
  buildId: z.string().min(1).max(100).optional(),
}).strict()

export type SessionObservation = z.infer<typeof sessionObservationSchema>

/**
 * One event in a workKey's life (C2).
 *
 * `assign` opens an ownership, `release` and `reassign` close it. The current
 * owner is the last event for the key that has not been closed - a fold, not a
 * field, so the file is the truth and the index is only ever a cache. `reassign`
 * is modelled as a close plus an open in the same event so the history stays one
 * line per decision rather than two that can be read apart.
 */
const assignmentEventSchema = z.discriminatedUnion('event', [
  z.object({
    version: z.literal(1),
    event: z.literal('assign'),
    workKey: z.string().min(1).max(400),
    sessionId: z.string().uuid(),
    familyRootSessionId: z.string().uuid(),
    at: z.string().datetime(),
    summary: z.string().max(2000).optional(),
  }).strict(),
  z.object({
    version: z.literal(1),
    event: z.literal('release'),
    workKey: z.string().min(1).max(400),
    sessionId: z.string().uuid(),
    at: z.string().datetime(),
    reason: z.string().max(2000).optional(),
  }).strict(),
])

export type AssignmentEvent = z.infer<typeof assignmentEventSchema>

/** Why an assignment row was read the way it was. */
export type Ownership =
  | { state: 'owned'; workKey: string; sessionId: string; familyRootSessionId: string; since: string; summary?: string; ownerLive: boolean | 'unknown' }
  | { state: 'orphaned'; workKey: string; sessionId: string; familyRootSessionId: string; since: string; summary?: string }
  | { state: 'unowned'; workKey: string }

/**
 * Read a JSONL file into records, skipping anything that does not parse.
 *
 * A torn last line is the expected shape of a crash mid-append, and refusing
 * the whole file over one bad line would make a single interrupted write
 * destroy a ledger that is otherwise intact - the opposite of what append-only
 * is for. Only whole lines that parse are history; the rest is reported by
 * `ledgerHealth` rather than thrown.
 */
async function readJsonl<T>(path: string, schema: z.ZodType<T>): Promise<{ records: T[]; skipped: number }> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records: [], skipped: 0 }
    throw error
  }
  const records: T[] = []
  let skipped = 0
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      records.push(schema.parse(JSON.parse(line)))
    } catch {
      skipped++
    }
  }
  return { records, skipped }
}

/**
 * Append one record under a lock.
 *
 * The lock is taken on a sibling `.lock` target rather than on the JSONL itself,
 * because `proper-lockfile` locks by creating a directory next to the file and
 * refuses to lock a path that does not exist - and the first append is exactly
 * when it does not. A single lock per ledger serializes every appender, which is
 * what makes the fold safe to read.
 */
async function appendRecord(path: string, record: unknown): Promise<void> {
  await mkdir(zenithLedgerDir(), { recursive: true, mode: 0o700 })
  const lockTarget = `${path}.lock`
  // The lock target must exist for proper-lockfile to lock it; a zero-byte
  // placeholder is enough, and it is never read.
  await writeFile(lockTarget, '', { flag: 'a', mode: 0o600 }).catch(() => {})
  const release = await lock(lockTarget, { realpath: false, stale: 15000, retries: { retries: 8, minTimeout: 50, maxTimeout: 400 } })
  try {
    await writeFile(path, `${JSON.stringify(record)}\n`, { flag: 'a', mode: 0o600 })
  } finally {
    await release().catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// C1: the session history
// ---------------------------------------------------------------------------

/**
 * Record that a session was observed live, right now.
 *
 * Idempotent in effect but append-only in form: observing the same session twice
 * writes two lines, and the later one is what it is as of. That is deliberate -
 * "when was this session last seen, and by whom" is a question a history can
 * answer and a mutable row cannot.
 */
export async function recordSessionObservation(input: {
  sessionId: string
  familyRootSessionId: string
  name: string
  buildId?: string
  /**
   * The pid of the session being *observed*, when the caller can name it.
   *
   * This must never default to the recorder's own pid: an observation is about
   * another session, and writing `process.pid` here made every row claim the
   * observer's process - so `ownerOf` asked whether the *ledger writer* was
   * running and answered a question about a session that was never recorded.
   * A sweep that observed a killed chat then read it as live, because the
   * coordinator doing the observing was alive. Absent means UNKNOWN, which is
   * the honest answer for an observation that cannot name its subject's process.
   */
  pid?: number
  processStartedAt?: string
}): Promise<SessionObservation> {
  const observation = sessionObservationSchema.parse({
    version: 1,
    sessionId: input.sessionId,
    familyRootSessionId: input.familyRootSessionId,
    name: input.name,
    ...(input.pid !== undefined ? { pid: input.pid } : {}),
    ...(input.processStartedAt !== undefined
      ? { processStartedAt: input.processStartedAt }
      : input.pid !== undefined
        ? { processStartedAt: new Date().toISOString() }
        : {}),
    observedAt: new Date().toISOString(),
    ...(input.buildId ? { buildId: input.buildId } : {}),
  })
  await appendRecord(ledgerPath('sessions'), observation)
  return observation
}

/**
 * What the ledger knows about one session, and for how long.
 *
 * `unknown` is a first-class answer rather than an empty one: a session nobody
 * has observed is not "probably idle" or "probably gone", it is unqueried. The
 * doneWhen requires that distinction, because assuming an unqueried session has
 * some state is how a coordinator acts on a session it never checked.
 */
export type SessionHistory =
  | { state: 'known'; sessionId: string; familyRootSessionId: string; observations: readonly SessionObservation[]; firstSeen: string; lastSeen: string }
  | { state: 'unknown'; sessionId: string }

export async function sessionHistory(sessionId: string): Promise<SessionHistory> {
  const { records } = await readJsonl(ledgerPath('sessions'), sessionObservationSchema)
  const mine = records.filter(record => record.sessionId === sessionId)
  if (mine.length === 0) return { state: 'unknown', sessionId }
  return {
    state: 'known',
    sessionId,
    familyRootSessionId: mine[0]!.familyRootSessionId,
    observations: mine,
    firstSeen: mine[0]!.observedAt,
    lastSeen: mine[mine.length - 1]!.observedAt,
  }
}

/** Every session the ledger has ever observed, latest observation per session. */
export async function knownSessions(): Promise<readonly SessionObservation[]> {
  const { records } = await readJsonl(ledgerPath('sessions'), sessionObservationSchema)
  const latest = new Map<string, SessionObservation>()
  for (const record of records) latest.set(record.sessionId, record)
  return [...latest.values()]
}

/**
 * The family a session belongs to, read from the family files (C3).
 *
 * A member's family is recorded on disk in two places, and this reads them in
 * the order that answers fastest: the member's own pointer names its root
 * directly, and the family file named after a root lists every member. The
 * pointer is the member's own claim about where it belongs; the family file is
 * the family's own claim about who is in it, and it is the fallback for a
 * session that is a member without being the one asked.
 *
 * The pid on a peer registration is deliberately NOT used to infer an ancestor.
 * On Windows the parent of a launched session is a launcher, not the family's
 * root, so an inferred family would be a relationship no file states - which is
 * the whole failure class this ledger exists to close.
 *
 * A session no file places falls back to itself. A family of one is a true
 * statement about a session nothing has claimed, and `familyRootFor` has to
 * answer something: refusing would only mean the caller invented a substitute.
 */
export async function familyRootFor(sessionId: string): Promise<string> {
  const { familyIndexDir } = await import('./leafWorkspace.js')
  const { readLeafFamily } = await import('./leafFamily.js')
  const index = familyIndexDir()
  // The pointer: this session's own record of the family it was launched into.
  try {
    const pointer = JSON.parse(await readFile(join(index, `${sessionId}.json`), 'utf8')) as { rootSessionId?: string }
    if (pointer && typeof pointer.rootSessionId === 'string' && pointer.rootSessionId) return pointer.rootSessionId
  } catch {
    // No pointer is the ordinary state of a session that began its own family.
  }
  // The family files: for a session that is a member but is not the asker.
  let entries: string[]
  try {
    entries = await readdir(join(getClaudeConfigHomeDir(), 'leaf-families'))
  } catch {
    return sessionId
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const root = entry.slice(0, -'.json'.length)
    try {
      const family = await readLeafFamily(join(getClaudeConfigHomeDir(), 'leaf-families', entry), root)
      if (family.members.some(member => member.sessionId === sessionId)) return root
    } catch {
      // A family file that will not parse is not evidence of membership.
    }
  }
  return sessionId
}

/**
 * The broadcast-identify sweep (C3): record only the sessions that answer.
 *
 * Who is live is answered by the processes themselves rather than by the
 * registration files, which outlive their writers - most of the registrations on
 * this machine ping dead. So this asks each registered session to identify
 * itself and records only the ones that answered. A session that did not answer
 * is not recorded as absent: it stays UNKNOWN, because a silent peer is equally
 * a peer on an older build and one that just exited, and the ledger cannot tell
 * those apart. Writing a guess here would be worse than writing nothing, since a
 * ledger row reads as an observation.
 *
 * The identify RPC is second after the file reads because a round trip per live
 * session is cheap but not free; but for a session the files do not place, it is
 * the only source that is a statement about a running process.
 */
export async function sweepSessions(options: { directory?: string; asker?: { sessionId: string; token?: string } } = {}): Promise<{ recorded: number; answered: number; asked: number }> {
  const { broadcastIdentify, listGatewayPeers } = await import('./gatewaySessionTransport.js')
  const directory = options.directory ?? join(getClaudeConfigHomeDir(), 'gateway-sessions')
  // The asker is not asked (it already knows who it is), so it is not counted:
  // `asked` is how many sessions were put the question, not how many are
  // registered, and a caller comparing it against `answered` is measuring how
  // many peers refused to say who they are.
  const registered = await listGatewayPeers(directory).catch(() => [])
  const asked = registered.filter(peer => peer.sessionId !== options.asker?.sessionId).length
  // The asker has to be a registered session and has to be named on the wire,
  // so a coordinator sweeping on behalf of the bus passes its own registration.
  // Without one there is nobody to attribute the questions to and the answers
  // are empty, which is a truthful "none asked" rather than a sweep that found
  // no sessions.
  const identities = await broadcastIdentify(directory, options.asker)
  let recorded = 0
  for (const identity of identities) {
    // The observed session's pid, never this process's. `broadcastIdentify`
    // fills it from the registration it addressed, so the row says which
    // process is behind the session - and `ownerOf` then resolves liveness
    // against the owner rather than against whoever ran the sweep.
    await recordSessionObservation({
      sessionId: identity.sessionId,
      familyRootSessionId: await familyRootFor(identity.sessionId),
      name: identity.name,
      ...(identity.pid !== undefined ? { pid: identity.pid } : {}),
      ...(identity.buildId ? { buildId: identity.buildId } : {}),
    })
    recorded++
  }
  return { recorded, answered: identities.length, asked }
}

// ---------------------------------------------------------------------------
// C2: assignments - ownership looked up, never inferred
// ---------------------------------------------------------------------------

/**
 * Fold the event file into current ownership for one workKey.
 *
 * The fold is the read path, so the index is only ever an optimization and a
 * disagreement between the two resolves for the file. `orphaned` is computed
 * here rather than polled (P4): a session whose process is gone, or that was
 * never observed live in this ledger, is not an owner in any sense that protects
 * the work, and saying so at read time is what keeps a poll from becoming the
 * load.
 */
export function foldOwnership(events: readonly AssignmentEvent[], workKey: string): Ownership {
  let current: Extract<AssignmentEvent, { event: 'assign' }> | undefined
  for (const event of events) {
    if (event.workKey !== workKey) continue
    if (event.event === 'assign') current = event
    else if (current && current.sessionId === event.sessionId) current = undefined
  }
  if (!current) return { state: 'unowned', workKey }
  return {
    state: 'owned',
    workKey,
    sessionId: current.sessionId,
    familyRootSessionId: current.familyRootSessionId,
    since: current.at,
    ...(current.summary ? { summary: current.summary } : {}),
    ownerLive: 'unknown',
  }
}

/**
 * Whether an owner is still there, resolved from the session history.
 *
 * `unknown` is honest: a session the ledger has never observed cannot be called
 * live or dead from this file, and guessing either way is the failure the ledger
 * is for. A session observed with a pid that is no longer running is gone; a pid
 * that is running belongs to *a* process, which on Windows is as far as this can
 * go without a start-time comparison, so it reads live.
 */
async function resolveOwnerLiveness(sessionId: string): Promise<boolean | 'unknown'> {
  const history = await sessionHistory(sessionId)
  if (history.state === 'unknown') return 'unknown'
  const last = history.observations[history.observations.length - 1]!
  if (last.pid === undefined) return 'unknown'
  return isProcessRunning(last.pid)
}

/**
 * The owner of a workKey (P1).
 *
 * This is the primitive that replaces inference: it reads the durable file and
 * returns either a named owner (with its family) or `unowned`, and it never
 * consults a task list or a name. An owner whose process is gone reads as
 * `orphaned`, which is a different answer from `unowned` on purpose - one means
 * "someone has to release it", the other means "nobody has taken it".
 */
export async function ownerOf(workKey: string, options: { now?: () => Promise<boolean | 'unknown'> } = {}): Promise<Ownership> {
  const { records } = await readJsonl(ledgerPath('assignments'), assignmentEventSchema)
  const folded = foldOwnership(records, workKey)
  if (folded.state !== 'owned') return folded
  const live = await (options.now ? options.now() : resolveOwnerLiveness(folded.sessionId))
  if (live === false) {
    const { ownerLive: _drop, ...rest } = folded
    return { ...rest, state: 'orphaned' }
  }
  return { ...folded, ownerLive: live }
}

/** Assign a workKey (P3). One owner per key; a live holder is not displaced. */
export type AssignOutcome =
  | { ok: true; ownership: Extract<Ownership, { state: 'owned' }> }
  | { ok: false; reason: 'held'; ownership: Ownership }
  | { ok: false; reason: 'not-zenith'; holder: string | undefined }

/**
 * Take a workKey, unless a live holder has it.
 *
 * `force` is the user's decision expressed, exactly as it is for the Zenith
 * claim: reassigning live work is a decision about who is doing what, not a side
 * effect of a second session deciding it wants the work. A holder whose process
 * is gone never blocks an assignment - nothing is running to displace - so a
 * genuinely dead lane can be recovered without the user.
 */
export async function assign(
  workKey: string,
  options: { sessionId?: string; familyRootSessionId: string; summary?: string; force?: boolean; recoverDead?: boolean; now?: () => Promise<boolean | 'unknown'>; zenith?: string | false },
): Promise<AssignOutcome> {
  const sessionId = options.sessionId ?? getSessionId()
  // Only the Zenith holder assigns (P7). This is not bookkeeping: an assignment
  // is the record that says who is doing what, and a second session that can
  // write it can quietly claim a lane's work and make the ledger disagree with
  // the fleet. The claim checked is the CALLER's, not the assignee's - a
  // coordinator hands work to a lane that is not Zenith, so gating on the
  // target would refuse every legitimate hand-off and permit a rogue write.
  // A displaced Zenith finds out here rather than by succeeding once more.
  if (options.zenith !== false && options.zenith !== '') {
    const caller = getSessionId()
    const { holdsZenith, readZenithClaim } = await import('./zenithRole.js')
    if (!(await holdsZenith(caller))) {
      const claim = await readZenithClaim()
      return { ok: false, reason: 'not-zenith', holder: claim?.zenithSessionId }
    }
  }
  const existing = await ownerOf(workKey, options.now ? { now: options.now } : {})
  // Three cases, and conflating them is the bug this whole layer exists to stop:
  // a live holder blocks (needs `force`); a proven-dead holder blocks only when
  // recovery was not asked for (`recoverDead`, so a crashed lane can be picked
  // up without the user); and an owner the ledger has never seen is UNKNOWN -
  // not dead - so it blocks like a live one, because taking work on an unknown
  // is how a running lane's job is reassigned out from under it.
  if (existing.state === 'owned' && !options.force) return { ok: false, reason: 'held', ownership: existing }
  if (existing.state === 'orphaned' && !options.force && !options.recoverDead) return { ok: false, reason: 'held', ownership: existing }
  const event: AssignmentEvent = {
    version: 1,
    event: 'assign',
    workKey,
    sessionId,
    familyRootSessionId: options.familyRootSessionId,
    at: new Date().toISOString(),
    ...(options.summary?.trim() ? { summary: options.summary.trim() } : {}),
  }
  await appendRecord(ledgerPath('assignments'), event)
  return {
    ok: true,
    ownership: { state: 'owned', workKey, sessionId, familyRootSessionId: options.familyRootSessionId, since: event.at, ...(event.event === 'assign' && event.summary ? { summary: event.summary } : {}), ownerLive: true },
  }
}

/**
 * Give a workKey up, but only if this session is the one holding it.
 *
 * Gated on the caller holding Zenith (P7) for the same reason `assign` is: a
 * release is an ownership write, and a session that does not hold the role must
 * not be able to erase the record of who is doing what any more than it could
 * have written it. The check is on the caller, not on the row's sessionId, so a
 * coordinator can release on a lane's behalf when the lane has gone.
 */
export async function release(workKey: string, options: { sessionId?: string; reason?: string; zenith?: string | false } = {}): Promise<boolean> {
  const caller = getSessionId()
  if (options.zenith !== false && options.zenith !== '') {
    const { holdsZenith } = await import('./zenithRole.js')
    // The holder releasing its own row needs no role: a lane giving its work
    // back is not a coordination act, and refusing it would strand the row.
    // Any other release - a coordinator on a lane's behalf - needs Zenith.
    const releasingForSomeoneElse = options.sessionId !== undefined && options.sessionId !== caller
    if (releasingForSomeoneElse && !(await holdsZenith(caller))) return false
  }
  const existing = await ownerOf(workKey)
  // The row names its owner, so that is the session a release closes. Falling
  // back to the caller made a bare `release <key>` a no-op for the coordinator
  // who assigned it - and would let a live lane's row be closed by anyone the
  // gate did not catch, because the comparison then read the caller's own id
  // against a row that was never theirs.
  if (existing.state !== 'owned') return false
  const closing = options.sessionId ?? existing.sessionId
  if (closing !== existing.sessionId) return false
  await appendRecord(ledgerPath('assignments'), {
    version: 1,
    event: 'release',
    workKey,
    sessionId: closing,
    at: new Date().toISOString(),
    ...(options.reason?.trim() ? { reason: options.reason.trim() } : {}),
  } satisfies AssignmentEvent)
  return true
}

/** Hand a workKey to another session, which is a decision and needs `force`. */
export async function reassign(workKey: string, options: { to: string; familyRootSessionId: string; summary?: string; force?: boolean }): Promise<AssignOutcome> {
  const existing = await ownerOf(workKey)
  if (existing.state === 'owned' && !options.force) return { ok: false, reason: 'held', ownership: existing }
  if (existing.state === 'owned') {
    await appendRecord(ledgerPath('assignments'), {
      version: 1, event: 'release', workKey, sessionId: existing.sessionId, at: new Date().toISOString(), reason: `reassigned to ${options.to}`,
    } satisfies AssignmentEvent)
  }
  return assign(workKey, { sessionId: options.to, familyRootSessionId: options.familyRootSessionId, ...(options.summary ? { summary: options.summary } : {}) })
}

/**
 * Every current assignment, as a fold over the whole file (P6).
 *
 * This is the task ledger: `TaskList` is per-session state that a session switch
 * can lose, while this is one file every session folds the same way, so losing a
 * task list stops mattering. Orphaned rows are reported as such rather than
 * hidden, because who has to release them is exactly what a reader needs.
 */
export async function currentAssignments(): Promise<readonly Ownership[]> {
  const { records } = await readJsonl(ledgerPath('assignments'), assignmentEventSchema)
  const keys = new Set(records.map(record => record.workKey))
  const rows: Ownership[] = []
  for (const key of keys) {
    const folded = foldOwnership(records, key)
    if (folded.state !== 'owned') continue
    const live = await resolveOwnerLiveness(folded.sessionId)
    if (live === false) {
      const { ownerLive: _drop, ...rest } = folded
      rows.push({ ...rest, state: 'orphaned' })
    } else rows.push({ ...folded, ownerLive: live })
  }
  return rows
}

/**
 * The ambiguity detector (P5): the ways identity can collide, reported rather
 * than resolved.
 *
 * Three collisions are possible here, and each one has already cost something on
 * this machine: one id answering to several names (a rename that left the old
 * row), one name naming several ids (family-local leaf labels), and one workKey
 * claimed by more than one open owner (which the fold cannot even represent, so
 * it is reported from the raw events). Detecting is not fixing: the caller
 * decides, because a tool that picks silently is the defect, not the fix.
 */
export type Ambiguity =
  | { kind: 'id-multi-name'; sessionId: string; names: readonly string[] }
  | { kind: 'name-multi-id'; name: string; sessionIds: readonly string[] }
  | { kind: 'workkey-multi-claimant'; workKey: string; sessionIds: readonly string[] }

export async function ambiguities(): Promise<readonly Ambiguity[]> {
  // The whole history, not the latest row per session: a rename is exactly the
  // case one id answers to two names, and reading only the newest observation
  // would hide the older name that a stale reference still resolves against.
  const { records } = await readJsonl(ledgerPath('sessions'), sessionObservationSchema)
  const found: Ambiguity[] = []
  const namesById = new Map<string, Set<string>>()
  const idsByName = new Map<string, Set<string>>()
  for (const observation of records) {
    if (!namesById.has(observation.sessionId)) namesById.set(observation.sessionId, new Set())
    namesById.get(observation.sessionId)!.add(observation.name)
    if (!idsByName.has(observation.name)) idsByName.set(observation.name, new Set())
    idsByName.get(observation.name)!.add(observation.sessionId)
  }
  for (const [sessionId, names] of namesById) if (names.size > 1) found.push({ kind: 'id-multi-name', sessionId, names: [...names] })
  for (const [name, ids] of idsByName) if (ids.size > 1) found.push({ kind: 'name-multi-id', name, sessionIds: [...ids] })

  const { records: events } = await readJsonl(ledgerPath('assignments'), assignmentEventSchema)
  // The fold keeps one owner; the check is whether the raw history ever opened
  // the same key for two sessions without a release between them, which the
  // index cannot represent and a caller has to be told about.
  const claimed = new Map<string, Set<string>>()
  const live = new Map<string, Set<string>>()
  for (const event of events) {
    if (!claimed.has(event.workKey)) claimed.set(event.workKey, new Set())
    if (!live.has(event.workKey)) live.set(event.workKey, new Set())
    if (event.event === 'assign') live.get(event.workKey)!.add(event.sessionId)
    else live.get(event.workKey)!.delete(event.sessionId)
    for (const id of live.get(event.workKey)!) claimed.get(event.workKey)!.add(id)
  }
  for (const [workKey, sessionIds] of claimed) if (sessionIds.size > 1) found.push({ kind: 'workkey-multi-claimant', workKey, sessionIds: [...sessionIds] })
  return found
}

/**
 * Ledger health: how many lines are unreadable, per file.
 *
 * A skip is not an error - a torn line is what a crash mid-append looks like -
 * but it is not silence either. Reporting it is what keeps "the ledger has no
 * owner for this key" distinguishable from "the ledger could not be read".
 */
export async function ledgerHealth(): Promise<{ sessions: { records: number; skipped: number }; assignments: { records: number; skipped: number } }> {
  const sessions = await readJsonl(ledgerPath('sessions'), sessionObservationSchema)
  const assignments = await readJsonl(ledgerPath('assignments'), assignmentEventSchema)
  return {
    sessions: { records: sessions.records.length, skipped: sessions.skipped },
    assignments: { records: assignments.records.length, skipped: assignments.skipped },
  }
}

/**
 * Rebuild the derived index from the JSONL.
 *
 * The index is never authoritative, so this exists to make that checkable rather
 * than asserted: anything the index says is reproducible here, and a caller that
 * finds a disagreement should trust the JSONL. The write is the repo's usual
 * temp-then-rename, which Windows may refuse while a reader holds the target.
 */
export async function rebuildIndex(): Promise<{ assignments: readonly Ownership[]; sessions: number }> {
  const index = {
    rebuiltAt: new Date().toISOString(),
    assignments: await currentAssignments(),
    sessions: await knownSessions(),
  }
  const target = join(zenithLedgerDir(), 'index.json')
  await mkdir(zenithLedgerDir(), { recursive: true, mode: 0o700 })
  const temporary = `${target}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(index), { mode: 0o600 })
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temporary, target)
      break
    } catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '') || attempt >= 5) {
        await unlink(temporary).catch(() => {})
        throw error
      }
      await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)))
    }
  }
  return { assignments: index.assignments, sessions: index.sessions.length }
}
