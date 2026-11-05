import { mkdir, open, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  appendEventsLocked,
  contentHash,
  readJournal,
  withVaultLock,
  type AppendResult,
  type JournalEvent,
  type ProposedEvent,
} from './journal.js'
import { markCapturedBySpans } from './capture.js'
import { obligationsPath, readObligations } from './obligations.js'

/**
 * The scribe's only way in. A proposal is an opinion; the writer decides.
 *
 * Everything here is deterministic on purpose: an LLM never commits, never
 * assigns a sequence, and never decides whether a capture was owed. What it can
 * do is propose, and the writer validates the shape, stamps the generation it
 * was given, and refuses anything that cannot be trusted.
 */

export type Proposal = Record<string, unknown> & {
  event_id: string
  /** Optional here: the request's `generation` is stamped when it is absent. */
  generation_id?: string
  obligationIds?: string[]
}

export type SubmitRequest = {
  vaultRoot: string
  familyId: string
  /** The writer-enforced fence. Absent or blank refuses the whole submission. */
  generation: string
  /** Retry key for a whole batch; a repeat returns the original commit. */
  idempotencyKey?: string
  proposals: readonly Proposal[]
}

export type SubmitResult = {
  committed: JournalEvent[]
  duplicates: string[]
  rejected: Array<{ event_id: string; reason: string }>
  watermark: number
  /** True when the idempotency key had already been committed. */
  replayed: boolean
  obligationsSatisfied: string[]
  /**
   * Obligations a committed event asked to close that could not be closed, with
   * why. Reported rather than dropped: silently ignoring the request is how a
   * proposer learns to believe an obligation was discharged.
   */
  obligationsNotClosable: Array<{ obligation_id: string; reason: string }>
  /** Pending captures whose span a committed event cited, marked by this call. */
  capturesMarked: number
  /** A capture-mark failure never un-commits an event; it is reported here. */
  captureErrors: string[]
}

const KINDS = new Set([
  'decision',
  'finding',
  'evidence',
  'handoff',
  'question',
  'correction',
  'observation',
  'topic',
])
const AUTHORITIES = new Set(['user_ruling', 'verified_artifact', 'agent_inference', 'unverified'])
const EVIDENCE_STATUS = new Set(['direct', 'corroborated', 'inferred', 'unverified'])
const TOPIC_OPS = new Set(['create', 'alias', 'merge', 'split'])

const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''

/**
 * Structural validation only. It answers "is this a record the journal can
 * carry", never "is this true" - truth is the validator's separate concern and
 * the scribe's proposal is the input, not the verdict.
 */
export function validateProposal(proposal: Proposal): string[] {
  const reasons: string[] = []
  if (!isText(proposal.event_id)) reasons.push('event_id is required')
  if (!KINDS.has(String(proposal.kind))) reasons.push(`kind must be one of ${[...KINDS].join('|')}`)
  // A topic event is the one kind whose shape depends on its operation.
  if (proposal.kind === 'topic') {
    if (!TOPIC_OPS.has(String(proposal.topic_op))) {
      reasons.push(`topic_op must be one of ${[...TOPIC_OPS].join('|')} for kind topic`)
    }
    if (proposal.topic_op === 'create' && !isText(proposal.definition)) {
      reasons.push('a topic create needs a definition')
    }
    if (proposal.topic_op === 'merge' && !isText(proposal.merged_into)) {
      reasons.push('a topic merge needs merged_into')
    }
    if (proposal.topic_op === 'split' && !Array.isArray(proposal.split_into)) {
      reasons.push('a topic split needs split_into[]')
    }
    if (proposal.topic_op === 'alias' && !Array.isArray(proposal.aliases)) {
      reasons.push('a topic alias needs aliases[]')
    }
  } else if (!isText(proposal.topic_id)) {
    reasons.push('topic_id is required')
  }
  if (!isText(proposal.actor)) reasons.push('actor is required')
  if (!AUTHORITIES.has(String(proposal.authority))) {
    reasons.push(`authority must be one of ${[...AUTHORITIES].join('|')}`)
  }
  if (!EVIDENCE_STATUS.has(String(proposal.evidence_status))) {
    reasons.push(`evidence_status must be one of ${[...EVIDENCE_STATUS].join('|')}`)
  }
  if (!isText(proposal.summary)) reasons.push('summary is required')
  if (!isText(proposal.recorded_at)) reasons.push('recorded_at is required')
  // Provenance of the capture itself. These are the scribe's facts, not the
  // writer's: which extractor version produced the proposal, and which session
  // proposed it. `committed_by` and `status` are the writer's, and are stamped.
  if (!isText(proposal.capture_version)) reasons.push('capture_version is required')
  if (!isText(proposal.proposed_by)) reasons.push('proposed_by is required')
  return reasons
}

function submissionsPath(vaultRoot: string, familyId: string): string {
  return join(vaultRoot, 'families', familyId, 'submissions.jsonl')
}

type Submission = { key: string; event_ids: string[]; at: string }

async function findSubmission(path: string, key: string): Promise<Submission | undefined> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  let found: Submission | undefined
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try {
      const record = JSON.parse(line) as Submission
      if (record.key === key) found = record
    } catch {
      continue
    }
  }
  return found
}

async function appendLine(path: string, line: string): Promise<void> {
  const handle = await open(path, 'a')
  try {
    await handle.writeFile(line)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function submitProposals(request: SubmitRequest): Promise<SubmitResult> {
  const { vaultRoot, familyId, proposals } = request
  const dir = dirname(join(vaultRoot, 'families', familyId, 'journal.jsonl'))
  await mkdir(dir, { recursive: true })

  const generation = typeof request.generation === 'string' ? request.generation.trim() : ''
  const empty: SubmitResult = {
    committed: [],
    duplicates: [],
    rejected: [],
    watermark: 0,
    replayed: false,
    obligationsSatisfied: [],
    obligationsNotClosable: [],
    capturesMarked: 0,
    captureErrors: [],
  }
  if (!generation) {
    // Absent at the request level is the same refusal as absent per event: a
    // retired scribe whose fence logic went stale must not commit by omission.
    return {
      ...empty,
      rejected: proposals.map(proposal => ({
        event_id: String(proposal.event_id ?? ''),
        reason: 'generation is required',
      })),
    }
  }

  const key = request.idempotencyKey?.trim()
  const result = await withVaultLock(dir, async () => {
    if (key) {
      const previous = await findSubmission(submissionsPath(vaultRoot, familyId), key)
      if (previous) {
        const replay = await readJournal(vaultRoot, familyId)
        return {
          committed: [],
          duplicates: previous.event_ids,
          rejected: [],
          watermark: replay.watermark,
          replayed: true,
          obligationsSatisfied: [],
          obligationsNotClosable: [],
          capturesMarked: 0,
          captureErrors: [] as string[],
        }
      }
    }

    const accepted: ProposedEvent[] = []
    const rejected: Array<{ event_id: string; reason: string }> = []
    for (const proposal of proposals) {
      const eventId = String(proposal.event_id ?? '')
      const reasons = validateProposal(proposal)
      if (proposal.generation_id !== undefined && proposal.generation_id !== generation) {
        reasons.push(`generation ${String(proposal.generation_id)} does not match the submitted generation ${generation}`)
      }
      if (reasons.length > 0) {
        rejected.push({ event_id: eventId, reason: reasons.join('; ') })
        continue
      }
      accepted.push({ ...proposal, generation_id: generation })
    }

    let appended: AppendResult = { committed: [], duplicates: [], rejected: [], watermark: 0 }
    if (accepted.length > 0) {
      appended = await appendEventsLocked(vaultRoot, familyId, accepted)
    }
    const allRejected = [...rejected, ...appended.rejected]

    // Closure is decided from the folded state, not from a substring of the
    // file. `raw.includes('"<id>"')` used to match an id appearing anywhere -
    // including inside another record's `committed_event_ids` - so a record
    // could "close" an obligation merely by naming it.
    const satisfied: string[] = []
    const notClosable: Array<{ obligation_id: string; reason: string }> = []
    if (appended.committed.length > 0) {
      const known = new Map((await readObligations(vaultRoot, familyId)).map(row => [row.obligation_id, row]))
      const closedInBatch = new Set<string>()
      for (const event of appended.committed) {
        const ids = Array.isArray((event as { obligationIds?: unknown }).obligationIds)
          ? ((event as { obligationIds?: unknown[] }).obligationIds as unknown[]).map(String)
          : []
        for (const obligationId of ids) {
          if (closedInBatch.has(obligationId)) {
            notClosable.push({ obligation_id: obligationId, reason: 'closed-by-batch' })
            continue
          }
          const row = known.get(obligationId)
          if (!row) {
            notClosable.push({ obligation_id: obligationId, reason: 'unknown' })
            continue
          }
          if (row.state !== 'pending') {
            notClosable.push({ obligation_id: obligationId, reason: `already-${row.state}` })
            continue
          }
          satisfied.push(obligationId)
          closedInBatch.add(obligationId)
          await appendLine(
            obligationsPath(vaultRoot, familyId),
            `${JSON.stringify({
              obligation_id: obligationId,
              state: 'satisfied',
              committed_event_ids: [event.event_id],
              event_hash: contentHash(event),
              at: new Date().toISOString(),
            })}\n`,
          )
        }
      }
    }

    if (key && appended.committed.length > 0) {
      await appendLine(
        submissionsPath(vaultRoot, familyId),
        `${JSON.stringify({
          key,
          event_ids: appended.committed.map(event => event.event_id),
          at: new Date().toISOString(),
        })}\n`,
      )
    }

    return {
      committed: appended.committed,
      duplicates: appended.duplicates,
      rejected: allRejected,
      watermark: appended.watermark,
      replayed: false,
      obligationsSatisfied: satisfied,
      obligationsNotClosable: notClosable,
      capturesMarked: 0,
      captureErrors: [] as string[],
    }
  })
  // The queue join runs after the vault lock is released: the commit is
  // already durable, and a capture bookkeeping failure must not undo it.
  if (result.committed.length > 0) {
    try {
      for (const event of result.committed) {
        const evidence = Array.isArray((event as { evidence?: unknown }).evidence)
          ? ((event as { evidence?: unknown[] }).evidence as unknown[])
          : []
        const spans = evidence
          .map(entry => (entry && typeof entry === 'object' ? (entry as { span_sha256?: unknown }).span_sha256 : undefined))
          .filter((value): value is string => typeof value === 'string' && value !== '')
        if (spans.length === 0) continue
        const marked = await markCapturedBySpans({
          vaultRoot,
          familyId,
          eventId: event.event_id,
          spanSha256: spans,
        })
        result.capturesMarked += marked.marked
      }
    } catch (error) {
      result.captureErrors.push((error as Error).message)
    }
  }
  return result
}
