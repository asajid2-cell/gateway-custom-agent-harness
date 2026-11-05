import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readJournal, verifyJournal } from './journal.js'

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
  /** §12.4(a) needs a charter record; there is none in the vault yet. */
  charter: 'not-recorded'
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

export async function verifyReconstruction(vaultRoot: string, familyId: string): Promise<ReconstructionCheck> {
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

  // §12.4(a) is not checkable until a charter is recorded in the vault. Saying
  // so is the honest option; counting it as passed would be the dishonesty.
  checked.push('charter')

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
    charter: 'not-recorded',
    checked,
    reasons,
    checked_at: new Date().toISOString(),
  }
}
