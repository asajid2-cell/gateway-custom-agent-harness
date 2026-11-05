import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  activeGeneration,
  appendRotationDecision,
  readRotationRecords,
  type RotationRecord,
} from './journal.js'
import { eligibleActions, type EligibleActionKind } from './eligibleActions.js'
import { obligationBacklog, readObligations, recordObligation, type ObligationBacklog } from './obligations.js'
import { verifyReconstruction, writeCharter } from './reconstruction.js'

/**
 * The activation gate.
 *
 * A driver designation is authority, so it is not something a prompt or a
 * pointer write can grant. This module is the only thing that records one, and
 * it records it only when the family can actually capture what the driver does:
 * a scribe whose generation is the live one. `conferDriver` and the headless
 * CLI both call `conferDriverAdmission`, so there is one gate and two doors.
 *
 * Everything here is decided from the vault alone. Liveness of a process is not
 * consulted: a scribe is healthy when its recorded generation is the family's
 * active generation and it has not been retired. That is the property the gate
 * actually needs - after a rotation the old scribe is fenced whether or not its
 * process is still running - and it is the property a test can construct
 * without a process table.
 */

export type ScribeRegistration =
  | { ok: true; family_id: string; session_id: string; generation_id: string; replaced: boolean }
  | { ok: false; family_id: string; reason: 'unknown-family' | 'no-generation' | 'scribe-healthy'; message: string }

export type ActivationReason =
  | 'unknown-family'
  | 'no-generation'
  | 'no-scribe'
  | 'scribe-unhealthy'
  | 'rotation-pending'
  /** Pending obligations are past `capture.obligations.maxPending`. */
  | 'obligation-backlog'

export type ScribeRecord = {
  session_id?: string
  generation_id?: string
  started_at?: string
  retired_at?: string
}

export type ActivationRequest = {
  vaultRoot: string
  familyId: string
  driverSessionId: string
  /** The turn boundary the admission belongs to. Same boundary, same admission. */
  turnBoundary: string
  /** Whether the caller named that boundary or fell through to the default. */
  boundarySource?: 'explicit' | 'default'
  /** A caller-supplied id, so a replay can be driven from a script. */
  invocationId?: string
  /**
   * `enforce` refuses; `monitor` admits but records why it would have refused.
   * The default is monitor only until a scribe can be created (build step 5);
   * flipping it to enforce is a deliberate, separate change.
   */
  mode?: 'monitor' | 'enforce'
  /** Rotate after this many admitted activations. Spec §12.10 default: 5. */
  rotationEvery?: number
  /**
   * The cap on pending obligations. `null` or absent means the cap is off.
   * Enforced here, at activation, because refusing at creation loses the
   * evidence and refusing at submission is a cap that cannot be cleared by
   * doing the work.
   */
  maxPending?: number | null
  /** What counts as overdue, for the counts carried on a backlog refusal. */
  overdueHours?: number
  /**
   * The turn this activation belongs to. When it is supplied and the turn is an
   * eligible action, this admission creates the obligation it owes. This is the
   * only path that creates one, and a refused activation creates none.
   */
  turn?: { text: string; context?: string; sourceMessageId?: string }
}

export type ActivationAdmitted = {
  ok: true
  family_id: string
  invocation_id: string
  ordinal: number
  generation_id: string
  driver_session_id: string
  /** True when this invocation id was already recorded; nothing was written. */
  duplicate: boolean
  gate: 'monitor' | 'enforce'
  would_refuse: ActivationReason | null
  /** The boundary this admission belongs to, and whether the caller named it. */
  turn_boundary: string
  boundary_source: 'explicit' | 'default'
  /** True when this admission was the one that wrote the rotation intent. */
  rotation_intent: boolean
  /** Present when the backlog gate fired: counts it would have refused on. */
  backlog?: { pending: number; overdue: number; max_pending: number | null }
  /** The obligation this admission created; absent when the turn owed none. */
  obligation_id?: string
  /**
   * A creation failure is reported, never thrown, and never un-admits: the
   * admission is already durable, and the id is derived, so a later evaluation
   * of the same turn retries the same record rather than losing it.
   */
  obligation_error?: string
  at: string
}

export type ActivationRefused = {
  ok: false
  family_id: string
  reason: ActivationReason
  message: string
}

export type ActivationResult = ActivationAdmitted | ActivationRefused

export function scribePath(vaultRoot: string, familyId: string): string {
  return join(vaultRoot, 'families', familyId, 'scribe.json')
}

export async function readScribe(vaultRoot: string, familyId: string): Promise<ScribeRecord | null> {
  let raw: string
  try {
    raw = await readFile(scribePath(vaultRoot, familyId), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as ScribeRecord) : null
  } catch {
    return null
  }
}

/**
 * A scribe is healthy when it exists, has not been retired, and was started
 * against the generation the family is committing under. A scribe from an older
 * generation is stale by construction - that is what rotation means - so it is
 * not a reason to admit work.
 */
/**
 * Record the family's scribe. This is the only writer of `scribe.json` in the
 * harness: a scribe that wrote its own registration would be the capture path
 * declaring itself healthy, so the file is written by whoever holds the role -
 * the gate, at first admission, or a rotation swap - and never by the scribe.
 *
 * A healthy scribe is not replaced by accident: re-registering an existing one
 * is refused unless the caller says `replace`, which is what a rotation does.
 * A stale or retired record is replaced without ceremony, because that is the
 * scribe the generation fence has already retired.
 */
export async function registerScribe(input: {
  vaultRoot: string
  familyId: string
  sessionId: string
  generationId?: string
  replace?: boolean
}): Promise<ScribeRegistration> {
  if (!(await familyExists(input.vaultRoot, input.familyId))) {
    return {
      ok: false,
      family_id: input.familyId,
      reason: 'unknown-family',
      message: `no family ${input.familyId} in this vault`,
    }
  }
  const generation = input.generationId ?? (await activeGeneration(input.vaultRoot, input.familyId))
  if (!generation) {
    return {
      ok: false,
      family_id: input.familyId,
      reason: 'no-generation',
      message: `family ${input.familyId} has no admitted generation; a scribe has nothing to write under`,
    }
  }
  const existing = await readScribe(input.vaultRoot, input.familyId)
  const health = scribeHealth(existing, generation)
  if (health === 'healthy' && !input.replace) {
    return {
      ok: false,
      family_id: input.familyId,
      reason: 'scribe-healthy',
      message: `family ${input.familyId} already has a healthy scribe (${String(existing?.session_id ?? 'unknown')})`,
    }
  }
  const path = scribePath(input.vaultRoot, input.familyId)
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  const record: ScribeRecord = {
    session_id: input.sessionId,
    generation_id: generation,
    started_at: new Date().toISOString(),
  }
  await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temp, path)
  return {
    ok: true,
    family_id: input.familyId,
    session_id: input.sessionId,
    generation_id: generation,
    replaced: existing !== null,
  }
}

export function scribeHealth(
  scribe: ScribeRecord | null,
  generation: string | null,
): 'none' | 'healthy' | 'retired' | 'stale' {
  if (!scribe) return 'none'
  if (typeof scribe.retired_at === 'string' && scribe.retired_at !== '') return 'retired'
  if (!generation) return 'stale'
  return scribe.generation_id === generation ? 'healthy' : 'stale'
}

/**
 * Rotation is pending when the latest rotation intent has no completion after
 * it. While pending, a new activation would race the swap, so it is refused
 * rather than admitted against a generation that is about to be replaced.
 */
export function rotationPending(records: RotationRecord[]): boolean {
  let pending = false
  for (const record of records) {
    if (record.kind === 'rotation_intent') pending = true
    else if (record.kind === 'rotation') pending = false
  }
  return pending
}

function invocationIdFor(familyId: string, driverSessionId: string, turnBoundary: string): string {
  const digest = createHash('sha256')
    .update(`${familyId}\u0000${driverSessionId}\u0000${turnBoundary}`, 'utf8')
    .digest('hex')
  return `inv:${digest.slice(0, 32)}`
}

async function familyExists(vaultRoot: string, familyId: string): Promise<boolean> {
  try {
    return (await stat(join(vaultRoot, 'families', familyId))).isDirectory()
  } catch {
    return false
  }
}

const MESSAGES: Record<ActivationReason, (familyId: string) => string> = {
  'unknown-family': familyId => `no family ${familyId} in this vault`,
  'no-generation': familyId =>
    `family ${familyId} has no admitted generation; nothing may be committed and no driver may be admitted`,
  'no-scribe': familyId => `no healthy scribe for family ${familyId}`,
  'scribe-unhealthy': familyId => `the scribe recorded for family ${familyId} is not on the active generation`,
  'rotation-pending': familyId => `family ${familyId} is mid-rotation; no new activation until it completes`,
  'obligation-backlog': familyId => `family ${familyId} is carrying more pending obligations than capture.obligations.maxPending allows`,
}

function backlogMessage(familyId: string, backlog: ObligationBacklog): string {
  return `${MESSAGES['obligation-backlog'](familyId)}: ${backlog.pending} pending (cap ${backlog.maxPending}), ${backlog.overdue} overdue past ${backlog.overdueHours}h`
}

/**
 * The one place a driver admission is decided and recorded.
 *
 * Every refusal is decided before the writer is touched, so a refused call
 * leaves rotation.jsonl byte-identical. In monitor mode a would-be refusal is
 * admitted and the reason is recorded on the row, so the gate's opinion is
 * observable without enforcing it.
 */
export async function conferDriverAdmission(request: ActivationRequest): Promise<ActivationResult> {
  const result = await decideAdmission(request)
  if (!result.ok) return result
  return recordTurnObligation(request, result)
}

/**
 * The obligation half of an admission.
 *
 * Only an admitted activation reaches this: every refusal returns before it,
 * so a family that could not start work also records nothing as owed. Monitor
 * mode admits, so it creates too - the gate's opinion is not a veto on the
 * evidence.
 */
async function recordTurnObligation(request: ActivationRequest, admitted: ActivationAdmitted): Promise<ActivationAdmitted> {
  if (!request.turn) return admitted
  const verdict = eligibleActions({ text: request.turn.text, context: request.turn.context })
  if (!verdict.eligible || verdict.kind === null) return admitted
  try {
    const created = await recordObligation({
      vaultRoot: request.vaultRoot,
      familyId: request.familyId,
      driverSessionId: request.driverSessionId,
      turnBoundary: request.turnBoundary,
      kind: verdict.kind as EligibleActionKind,
      createdAt: new Date().toISOString(),
      sourceMessageId: request.turn.sourceMessageId,
    })
    if (!created.ok) return { ...admitted, obligation_error: created.message }
    return { ...admitted, obligation_id: created.obligation_id }
  } catch (error) {
    return { ...admitted, obligation_error: (error as Error).message }
  }
}

async function decideAdmission(request: ActivationRequest): Promise<ActivationResult> {
  const { vaultRoot, familyId, driverSessionId } = request
  const mode = request.mode ?? 'monitor'
  const boundarySource = request.boundarySource ?? 'explicit'
  const rotationEvery = request.rotationEvery && request.rotationEvery > 0 ? request.rotationEvery : 5
  const invocationId =
    request.invocationId?.trim() || invocationIdFor(familyId, driverSessionId, request.turnBoundary)

  if (!(await familyExists(vaultRoot, familyId))) {
    return {
      ok: false,
      family_id: familyId,
      reason: 'unknown-family',
      message: MESSAGES['unknown-family'](familyId),
    }
  }

  // A recorded admission is answered before the health checks: a retry of a
  // call that already succeeded must not start failing because the world moved
  // on, and it must not count a second time.
  const existing = await findAdmission(vaultRoot, familyId, invocationId)
  if (existing) {
    return {
      ok: true,
      family_id: familyId,
      invocation_id: invocationId,
      ordinal: Number(existing.ordinal ?? 0),
      generation_id: String(existing.generation_id ?? ''),
      driver_session_id: String(existing.driver_session_id ?? driverSessionId),
      duplicate: true,
      gate: mode,
      would_refuse: null,
      turn_boundary: String(existing.turn_boundary ?? request.turnBoundary),
      boundary_source: (existing.boundary_source as 'explicit' | 'default' | undefined) ?? boundarySource,
      rotation_intent: false,
      at: String(existing.at ?? ''),
    }
  }

  const generation = await activeGeneration(vaultRoot, familyId)
  if (!generation) {
    return {
      ok: false,
      family_id: familyId,
      reason: 'no-generation',
      message: MESSAGES['no-generation'](familyId),
    }
  }

  const records = await readRotationRecords(vaultRoot, familyId)
  if (rotationPending(records)) {
    const refusal: ActivationRefused = {
      ok: false,
      family_id: familyId,
      reason: 'rotation-pending',
      message: MESSAGES['rotation-pending'](familyId),
    }
    if (mode === 'enforce') return refusal
    return admit({
      vaultRoot,
      familyId,
      driverSessionId,
      invocationId,
      turnBoundary: request.turnBoundary,
      boundarySource,
      generation,
      mode,
      rotationEvery,
      wouldRefuse: 'rotation-pending',
    })
  }

  const health = scribeHealth(await readScribe(vaultRoot, familyId), generation)
  if (health !== 'healthy') {
    const reason: ActivationReason = health === 'none' ? 'no-scribe' : 'scribe-unhealthy'
    if (mode === 'enforce') {
      return { ok: false, family_id: familyId, reason, message: MESSAGES[reason](familyId) }
    }
    return admit({
      vaultRoot,
      familyId,
      driverSessionId,
      invocationId,
      turnBoundary: request.turnBoundary,
      boundarySource,
      generation,
      mode,
      rotationEvery,
      wouldRefuse: reason,
    })
  }

  // The backlog gate runs last, on a snapshot of the queue: the counts are a
  // reason to refuse starting new work, not a proof about the next millisecond.
  // A stale count can only make the gate more permissive, and the next
  // activation re-reads it.
  const maxPending = request.maxPending ?? null
  if (maxPending !== null) {
    const backlog = obligationBacklog(await readObligations(vaultRoot, familyId), {
      overdueHours: request.overdueHours,
      maxPending,
    })
    if (backlog.over) {
      if (mode === 'enforce') {
        return { ok: false, family_id: familyId, reason: 'obligation-backlog', message: backlogMessage(familyId, backlog) }
      }
      return admit({
        vaultRoot,
        familyId,
        driverSessionId,
        invocationId,
        turnBoundary: request.turnBoundary,
        boundarySource,
        generation,
        mode,
        rotationEvery,
        wouldRefuse: 'obligation-backlog',
        backlog: { pending: backlog.pending, overdue: backlog.overdue, max_pending: backlog.maxPending },
      })
    }
  }

  return admit({
    vaultRoot,
    familyId,
    driverSessionId,
    invocationId,
    turnBoundary: request.turnBoundary,
    boundarySource,
    generation,
    mode,
    rotationEvery,
    wouldRefuse: null,
  })
}

async function findAdmission(
  vaultRoot: string,
  familyId: string,
  invocationId: string,
): Promise<RotationRecord | null> {
  const records = await readRotationRecords(vaultRoot, familyId)
  for (const record of records) {
    if (record.kind === 'admission' && record.invocation_id === invocationId) return record
  }
  return null
}

type Admitting = {
  vaultRoot: string
  familyId: string
  driverSessionId: string
  invocationId: string
  turnBoundary: string
  boundarySource: 'explicit' | 'default'
  generation: string
  mode: 'monitor' | 'enforce'
  rotationEvery: number
  wouldRefuse: ActivationReason | null
  backlog?: { pending: number; overdue: number; max_pending: number | null }
}

async function admit(input: Admitting): Promise<ActivationAdmitted> {
  // The ordinal is assigned inside the lock. Two concurrent activations must not
  // both read the same count and both call themselves the first.
  const { appended } = await appendRotationDecision(input.vaultRoot, input.familyId, records => {
    const already = records.find(
      record => record.kind === 'admission' && record.invocation_id === input.invocationId,
    )
    if (already) return null
    // Only driver activations carry an invocation id; the generation admission
    // that opens a family is not one, and counting it would make the first
    // driver the second activation.
    const ordinal =
      records.filter(record => record.kind === 'admission' && typeof record.invocation_id === 'string')
        .length + 1
    const row = {
      kind: 'admission',
      generation_id: input.generation,
      invocation_id: input.invocationId,
      ordinal,
      driver_session_id: input.driverSessionId,
      turn_boundary: input.turnBoundary,
      boundary_source: input.boundarySource,
      gate: input.mode,
      ...(input.wouldRefuse ? { would_refuse: input.wouldRefuse } : {}),
      ...(input.backlog ? { backlog: input.backlog } : {}),
    }
    // The fifth admitted activation starts a rotation. The intent is written in
    // the same critical section as the admission that triggered it: a crash
    // between them would leave a counted invocation with no intent, and the
    // counter would silently drift past the threshold.
    if (ordinal % input.rotationEvery === 0) {
      return [row, { kind: 'rotation_intent', generation_id: input.generation, invocation_id: input.invocationId, ordinal }]
    }
    return row
  })
  if (appended.length === 0) {
    const existing = await findAdmission(input.vaultRoot, input.familyId, input.invocationId)
    return {
      ok: true,
      family_id: input.familyId,
      invocation_id: input.invocationId,
      ordinal: Number(existing?.ordinal ?? 0),
      generation_id: String(existing?.generation_id ?? input.generation),
      driver_session_id: String(existing?.driver_session_id ?? input.driverSessionId),
      duplicate: true,
      gate: input.mode,
      would_refuse: null,
      turn_boundary: String(existing?.turn_boundary ?? input.turnBoundary),
      boundary_source: (existing?.boundary_source as 'explicit' | 'default' | undefined) ?? input.boundarySource,
      rotation_intent: false,
      at: String(existing?.at ?? ''),
    }
  }
  const row = appended[0]!
  return {
    ok: true,
    family_id: input.familyId,
    invocation_id: input.invocationId,
    ordinal: Number(row.ordinal),
    generation_id: String(row.generation_id),
    driver_session_id: String(row.driver_session_id),
    duplicate: false,
    gate: input.mode,
    would_refuse: input.wouldRefuse,
    turn_boundary: input.turnBoundary,
    boundary_source: input.boundarySource,
    rotation_intent: appended.length > 1,
    ...(input.backlog ? { backlog: input.backlog } : {}),
    at: String(row.at),
  }
}

/**
 * The designation seam `conferDriver` calls.
 *
 * A family that is not registered in the vault yet is not gated in monitor
 * mode: refusing every designation for a family the vault has never seen is an
 * outage, not a gate, and step 5 is what registers families. Under `enforce`
 * the missing registration IS the refusal, so enforcement cannot be switched on
 * before the families it governs exist.
 */
export async function admitDriverDesignation(input: {
  vaultRoot: string
  familyId: string
  driverSessionId: string
  scope: readonly string[]
  mode: 'monitor' | 'enforce'
  rootName?: string
  headSessionId?: string
  maxPending?: number | null
  overdueHours?: number
}): Promise<ActivationResult | null> {
  if (!(await familyExists(input.vaultRoot, input.familyId))) {
    if (input.mode === 'monitor') return null
    return {
      ok: false,
      family_id: input.familyId,
      reason: 'unknown-family',
      message: MESSAGES['unknown-family'](input.familyId),
    }
  }
  // The identity of a designation is the scope it sets: repeating the same
  // scope is the same authority, changing it is a new one.
  const result = await conferDriverAdmission({
    vaultRoot: input.vaultRoot,
    familyId: input.familyId,
    driverSessionId: input.driverSessionId,
    turnBoundary: `scope:${[...input.scope].sort().join(',')}`,
    boundarySource: 'explicit',
    mode: input.mode,
    maxPending: input.maxPending ?? null,
    overdueHours: input.overdueHours,
  })
  if (!result.ok) return result
  // The charter is written by the gate that just decided the generation was
  // real - never by the capture path, which would let the thing being checked
  // produce what it is checked against.
  const generation = await activeGeneration(input.vaultRoot, input.familyId)
  await writeCharter(input.vaultRoot, input.familyId, {
    family_id: input.familyId,
    root_session_id: input.familyId,
    ...(input.rootName ? { root_name: input.rootName } : {}),
    ...(input.headSessionId ? { head_session_id: input.headSessionId } : {}),
    ...(generation ? { generation_id: generation } : {}),
    created_at: new Date().toISOString(),
  })
  return result
}

export type RotationCompletion = {
  ok: true
  family_id: string
  from_generation: string
  to_generation: string
  /** The verdict the checker produced, echoed so a caller need not re-read the row. */
  reconstruction: import('./reconstruction.js').ReconstructionCheck
  at: string
}

/**
 * Record that a rotation finished.
 *
 * The swap is a rotation row carrying the new generation, which is what fences
 * the old one: the writer takes the active generation from the last admission,
 * rotation or import_admission, so from this row onward every commit stamped
 * with `fromGeneration` is refused. It runs the cold-reconstruction check
 * itself and refuses on a failure - a launch is not a proof, and a verdict from
 * the caller is not one either.
 */
export async function completeRotation(input: {
  vaultRoot: string
  familyId: string
  toGeneration: string
  fromGeneration: string
  /**
   * A verdict may not be supplied. The check is computed here; accepting one
   * from the caller would let the generation being replaced certify itself,
   * which is the thing the whole rotation protocol exists to prevent.
   */
  reconstruction?: never
  /** The live family pointer, when the caller has it, for §12.4(a). */
  pointer?: import('./reconstruction.js').CharterPointer
}): Promise<RotationCompletion> {
  if ('reconstruction' in input && input.reconstruction !== undefined) {
    throw new Error(
      'rotation refused: the reconstruction verdict is computed by the checker, not supplied by the caller',
    )
  }
  const records = await readRotationRecords(input.vaultRoot, input.familyId)
  if (!rotationPending(records)) {
    throw new Error('rotation refused: there is no pending rotation intent for this family')
  }
  const reconstruction = await verifyReconstruction(input.vaultRoot, input.familyId, {
    pointer: input.pointer,
  })
  if (!reconstruction.ok) {
    throw new Error(
      `rotation refused: the replacement did not reconstruct the family (${reconstruction.reasons.join('; ') || 'no reason given'})`,
    )
  }
  const { appended } = await appendRotationDecision(input.vaultRoot, input.familyId, current => {
    if (!rotationPending(current)) return null
    return {
      kind: 'rotation',
      generation_id: input.toGeneration,
      from_generation: input.fromGeneration,
      reconstruction,
    }
  })
  const row = appended[0]
  if (!row) throw new Error('rotation refused: the intent was completed by another writer')
  return {
    ok: true,
    family_id: input.familyId,
    from_generation: String(row.from_generation),
    to_generation: String(row.generation_id),
    reconstruction,
    at: String(row.at),
  }
}
