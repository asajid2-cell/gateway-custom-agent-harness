import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  activeGeneration,
  appendRotationDecision,
  readRotationRecords,
  type RotationRecord,
} from './journal.js'

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

export type ActivationReason =
  | 'unknown-family'
  | 'no-generation'
  | 'no-scribe'
  | 'scribe-unhealthy'
  | 'rotation-pending'

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
    at: String(row.at),
  }
}

export type RotationCompletion = {
  ok: true
  family_id: string
  from_generation: string
  to_generation: string
  at: string
}

/**
 * Record that a rotation finished.
 *
 * The swap is a rotation row carrying the new generation, which is what fences
 * the old one: the writer takes the active generation from the last admission,
 * rotation or import_admission, so from this row onward every commit stamped
 * with `fromGeneration` is refused. It refuses to run unless the caller passes
 * the result of the cold-reconstruction check - a launch is not a proof, so an
 * unverified swap cannot be expressed here.
 */
export async function completeRotation(input: {
  vaultRoot: string
  familyId: string
  toGeneration: string
  fromGeneration: string
  reconstruction: { ok: boolean; checked: string[]; reasons?: string[] }
}): Promise<RotationCompletion> {
  if (!input.reconstruction.ok) {
    throw new Error(
      `rotation refused: the replacement did not reconstruct the family (${(input.reconstruction.reasons ?? []).join('; ') || 'no reason given'})`,
    )
  }
  const records = await readRotationRecords(input.vaultRoot, input.familyId)
  if (!rotationPending(records)) {
    throw new Error('rotation refused: there is no pending rotation intent for this family')
  }
  const { appended } = await appendRotationDecision(input.vaultRoot, input.familyId, current => {
    if (!rotationPending(current)) return null
    return {
      kind: 'rotation',
      generation_id: input.toGeneration,
      from_generation: input.fromGeneration,
      reconstruction: input.reconstruction,
    }
  })
  const row = appended[0]
  if (!row) throw new Error('rotation refused: the intent was completed by another writer')
  return {
    ok: true,
    family_id: input.familyId,
    from_generation: String(row.from_generation),
    to_generation: String(row.generation_id),
    at: String(row.at),
  }
}
