import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readJournal, readRotationRecords, verifyJournal } from './journal.js'

/**
 * The cold-reconstruction check for a rotation.
 *
 * It is deliberately computed here, from the journal alone, and never accepted
 * from the caller. A verdict supplied by the generation being replaced is that
 * generation grading its own homework - the exact shape §12.1 exists to stop,
 * one layer up. `completeRotation` calls this and refuses when it fails.
 *
 * What it can prove from the vault, and what it cannot, is stated in the result
 * rather than implied: there is no charter record in the vault yet, so the
 * charter invariant is reported as `not-recorded` instead of being counted as
 * passed. A check that silently ignores an invariant is worse than one that
 * names it absent.
 */

/**
 * The family's charter, as the harness writes it at admission. It is vault
 * data, not a caller's verdict: the check reads the file and compares it to the
 * family's own admission history and, when the caller has it, to the live
 * family pointer.
 *
 * Kept deliberately small. Every field here is one a fresh scribe has to be
 * able to state before it may replace the one that recorded it.
 */
export type CharterRecord = {
  family_id?: string
  root_session_id?: string
  root_name?: string
  head_session_id?: string
  /** The generation in force when the charter was written. */
  generation_id?: string
  created_at?: string
}

/** The subset of the leaf-family pointer the charter is compared against. */
export type CharterPointer = {
  rootSessionId?: string
  rootName?: string
  patriarchSessionId?: string
}

export function charterPath(vaultRoot: string, familyId: string): string {
  return join(vaultRoot, 'families', familyId, 'charter.json')
}

export async function readCharter(vaultRoot: string, familyId: string): Promise<CharterRecord | null> {
  let raw: string
  try {
    raw = await readFile(charterPath(vaultRoot, familyId), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as CharterRecord) : null
  } catch {
    return null
  }
}

export type ReconstructionCheck = {
  ok: boolean
  checker: 'gateway-vault/reconstruction-1'
  family_id: string
  /** Last sequence the journal reports: what a replacement has to have drained. */
  watermark: number
  /** Current decisions at or below the watermark, excluding superseded ones. */
  current_decisions: number
  superseded_decisions: number
  /** Current decisions whose evidence span list is empty. Reported, not fatal. */
  decisions_without_evidence: number
  /** Topics a current decision names that no topic event creates. Fatal. */
  missing_topics: string[]
  unresolved_obligations: number
  /**
   * `not-recorded` stays a distinct value even once charters exist, so a family
   * that never had one - an import - keeps the omission visible instead of
   * passing by absence.
   */
  charter: 'not-recorded' | 'verified' | 'mismatch'
  checked: string[]
  reasons: string[]
  checked_at: string
}

type Record_ = Record<string, unknown>

function asRecord(value: unknown): Record_ {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record_) : {}
}

/** Topic ids created by `kind: topic` + `topic_op: create` events. */
export function createdTopics(events: Record_[]): Set<string> {
  const topics = new Set<string>()
  for (const event of events) {
    if (event.kind !== 'topic') continue
    if (event.topic_op !== 'create') continue
    const id = typeof event.topic_id === 'string' ? event.topic_id : typeof event.event_id === 'string' ? event.event_id : null
    if (id) topics.add(id)
  }
  return topics
}

/** Event ids named as superseded by any `supersedes` relation, plus status rows. */
export function supersededIds(events: Record_[]): Set<string> {
  const superseded = new Set<string>()
  for (const event of events) {
    if (event.status === 'superseded' && typeof event.event_id === 'string') superseded.add(event.event_id)
    const relations = Array.isArray(event.relations) ? event.relations : []
    for (const relation of relations) {
      const entry = asRecord(relation)
      if (entry.type === 'supersedes' && typeof entry.target_event_id === 'string') {
        superseded.add(entry.target_event_id)
      }
    }
  }
  return superseded
}

async function unresolvedObligations(vaultRoot: string, familyId: string): Promise<number> {
  let raw = ''
  try {
    raw = await readFile(join(vaultRoot, 'families', familyId, 'obligations.jsonl'), 'utf8')
  } catch {
    return 0
  }
  const state = new Map<string, string>()
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    let record: Record_
    try {
      record = JSON.parse(line) as Record_
    } catch {
      continue
    }
    const id = typeof record.obligation_id === 'string' ? record.obligation_id : null
    if (!id) continue
    const next = typeof record.state === 'string' ? record.state : state.get(id) ?? 'pending'
    state.set(id, next)
  }
  let pending = 0
  for (const value of state.values()) if (value === 'pending') pending += 1
  return pending
}

export async function verifyReconstruction(
  vaultRoot: string,
  familyId: string,
  options: { pointer?: CharterPointer } = {},
): Promise<ReconstructionCheck> {
  const reasons: string[] = []
  const checked: string[] = []

  const journal = await readJournal(vaultRoot, familyId)
  if (journal.tornTail) reasons.push('journal ends with a torn line; the family is not drainable')
  const events = journal.events as unknown as Record_[]

  const verification = await verifyJournal(vaultRoot, familyId)
  checked.push('journal-hash')
  if (!verification.ok) {
    const detail = verification.mismatches
      .slice(0, 3)
      .map(mismatch => `line ${mismatch.line}${mismatch.event_id ? ` (${mismatch.event_id})` : ''}`)
      .join(', ')
    reasons.push(`journal verification failed${detail ? `: ${detail}` : ''}`)
  }
  const watermark = Number(verification.watermark ?? 0)
  const journalWatermark = events.reduce((max, event) => Math.max(max, Number(event.sequence ?? 0)), 0)
  checked.push('watermark')
  if (watermark !== journalWatermark) {
    reasons.push(`watermark disagrees with the journal: verify=${watermark}, read=${journalWatermark}`)
  }

  const superseded = supersededIds(events)
  const topics = createdTopics(events)
  let currentDecisions = 0
  let supersededDecisions = 0
  let withoutEvidence = 0
  const missingTopics = new Set<string>()
  for (const event of events) {
    if (event.kind !== 'decision') continue
    const id = typeof event.event_id === 'string' ? event.event_id : ''
    if (superseded.has(id)) {
      supersededDecisions += 1
      continue
    }
    currentDecisions += 1
    const evidence = Array.isArray(event.evidence) ? event.evidence : []
    if (evidence.length === 0) withoutEvidence += 1
    const topicId = typeof event.topic_id === 'string' ? event.topic_id : ''
    if (topicId && !topics.has(topicId)) missingTopics.add(topicId)
  }
  checked.push('decisions')
  if (missingTopics.size > 0) {
    reasons.push(`topics referenced by a current decision do not exist: ${[...missingTopics].sort().join(', ')}`)
  }

  const obligations = await unresolvedObligations(vaultRoot, familyId)
  checked.push('obligations')

  checked.push('charter')
  const charter = await checkCharter(vaultRoot, familyId, options.pointer, reasons)

  return {
    ok: reasons.length === 0,
    checker: 'gateway-vault/reconstruction-1',
    family_id: familyId,
    watermark,
    current_decisions: currentDecisions,
    superseded_decisions: supersededDecisions,
    decisions_without_evidence: withoutEvidence,
    missing_topics: [...missingTopics].sort(),
    unresolved_obligations: obligations,
    charter,
    checked,
    reasons,
    checked_at: new Date().toISOString(),
  }
}

/**
 * §12.4(a). The charter is vault data; the pointer is the live claim. When a
 * charter exists it must agree with the family it sits in, name the generation
 * it was written under, and - when the caller can supply the pointer - agree
 * with it field for field. A missing charter is `not-recorded`, never a pass.
 */
async function checkCharter(
  vaultRoot: string,
  familyId: string,
  pointer: CharterPointer | undefined,
  reasons: string[],
): Promise<'not-recorded' | 'verified' | 'mismatch'> {
  const charter = await readCharter(vaultRoot, familyId)
  if (!charter) return 'not-recorded'
  let ok = true
  const fail = (reason: string) => {
    ok = false
    reasons.push(reason)
  }

  if (charter.family_id !== familyId) {
    fail(`charter names family ${String(charter.family_id)}, not ${familyId}`)
  }
  if (typeof charter.root_session_id !== 'string' || charter.root_session_id.trim() === '') {
    fail('charter has no root_session_id')
  }
  if (typeof charter.generation_id === 'string' && charter.generation_id !== '') {
    const generations = new Set(
      (await readRotationRecords(vaultRoot, familyId)).map(record => record.generation_id),
    )
    if (!generations.has(charter.generation_id)) {
      fail(`charter names generation ${charter.generation_id}, which no admission in this family recorded`)
    }
  }

  if (pointer) {
    if (pointer.rootSessionId !== undefined && charter.root_session_id !== pointer.rootSessionId) {
      fail(`charter root_session_id ${String(charter.root_session_id)} disagrees with the pointer's ${pointer.rootSessionId}`)
    }
    if (pointer.rootName !== undefined && charter.root_name !== pointer.rootName) {
      fail(`charter root_name ${String(charter.root_name)} disagrees with the pointer's ${pointer.rootName}`)
    }
    if (
      pointer.patriarchSessionId !== undefined &&
      charter.head_session_id !== undefined &&
      charter.head_session_id !== pointer.patriarchSessionId
    ) {
      fail(`charter head_session_id ${String(charter.head_session_id)} disagrees with the pointer's ${pointer.patriarchSessionId}`)
    }
  }

  return ok ? 'verified' : 'mismatch'
}
