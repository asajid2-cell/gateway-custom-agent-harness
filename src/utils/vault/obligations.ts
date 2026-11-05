import { createHash } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { withVaultLock } from './journal.js'
import type { EligibleActionKind } from './eligibleActions.js'

/**
 * Obligations, folded in one place.
 *
 * `obligations.jsonl` is append-only, so its meaning is a fold over the lines.
 * Three modules used to fold it three different ways - recall (terminal-wins),
 * reconstruction (last-wins) and submit (a substring test over the whole file) -
 * and three folds of one file is how one file comes to mean three things.
 *
 * The rule here is terminal-wins: the first `satisfied | exempt | failed` record
 * is final and a later `pending` does not reopen it, because closure is a fact
 * rather than a status. A reopen would be an explicit record kind, not an
 * inference from line order. (Spec §4; the capture queue's "a second mark does
 * not rewrite history" is the same rule one layer over.)
 */

export type ObligationState = 'pending' | 'satisfied' | 'exempt' | 'failed'

export type ObligationRow = {
  obligation_id: string
  kind?: string
  state: ObligationState
  created_at?: string
  source_message_id?: string
  /** Filled by `summarizeObligations`, so the fold itself stays time-independent. */
  age_hours?: number
}

/** The one default. Recall and the activation gate both read this constant. */
export const DEFAULT_OVERDUE_HOURS = 24

const TERMINAL: ReadonlySet<string> = new Set(['satisfied', 'exempt', 'failed'])
const STATES: ReadonlySet<string> = new Set(['pending', 'satisfied', 'exempt', 'failed'])

export function obligationsPath(vaultRoot: string, familyId: string): string {
  return join(vaultRoot, 'families', familyId, 'obligations.jsonl')
}

/**
 * Fold the file's lines into one row per obligation.
 *
 * A record with no `state` is a creation record and reads as `pending`. A
 * record naming a state this module does not know is ignored rather than
 * guessed at: an unrecognised word must not silently become "closed".
 */
export function foldObligations(lines: readonly string[]): Map<string, ObligationRow> {
  const rows = new Map<string, ObligationRow>()
  for (const line of lines) {
    if (line.trim() === '') continue
    let record: Record<string, unknown>
    try {
      record = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const id = typeof record.obligation_id === 'string' ? record.obligation_id.trim() : ''
    if (!id) continue
    const state = typeof record.state === 'string' ? record.state.trim() : 'pending'
    if (!STATES.has(state)) continue
    const current = rows.get(id)
    if (current && TERMINAL.has(current.state)) continue
    rows.set(id, {
      obligation_id: id,
      state: state as ObligationState,
      kind: typeof record.kind === 'string' ? record.kind : current?.kind,
      created_at: typeof record.created_at === 'string' ? record.created_at : current?.created_at,
      source_message_id:
        typeof record.source_message_id === 'string' ? record.source_message_id : current?.source_message_id,
    })
  }
  return rows
}

/**
 * The family's obligations, one row per id, sorted by id so two runs cannot
 * disagree about order. A missing file is an empty set, not an error: a family
 * that has never owed anything is not broken.
 */
export async function readObligations(vaultRoot: string, familyId: string): Promise<ObligationRow[]> {
  let raw: string
  try {
    raw = await readFile(obligationsPath(vaultRoot, familyId), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return [...foldObligations(raw.split('\n')).values()].sort((left, right) =>
    left.obligation_id.localeCompare(right.obligation_id),
  )
}

export type ObligationSummary = { pending: ObligationRow[]; overdue: ObligationRow[] }

/**
 * Split the pending rows into all and overdue. An obligation with no readable
 * `created_at` is pending but never overdue: age is unknown, and guessing it
 * would invent an alarm.
 */
export function summarizeObligations(
  rows: readonly ObligationRow[],
  options: { asOf?: number | string; overdueHours?: number } = {},
): ObligationSummary {
  const parsed = options.asOf === undefined ? Date.now() : typeof options.asOf === 'number' ? options.asOf : Date.parse(options.asOf)
  const asOf = Number.isFinite(parsed) ? parsed : Date.now()
  const overdueHours = options.overdueHours ?? DEFAULT_OVERDUE_HOURS
  const pending: ObligationRow[] = []
  const overdue: ObligationRow[] = []
  for (const row of rows) {
    if (row.state !== 'pending') continue
    const created = row.created_at ? Date.parse(row.created_at) : NaN
    const ageHours = Number.isFinite(created) ? (asOf - created) / 3_600_000 : undefined
    const enriched = ageHours === undefined ? { ...row } : { ...row, age_hours: Number(ageHours.toFixed(2)) }
    pending.push(enriched)
    if (ageHours !== undefined && ageHours > overdueHours) overdue.push(enriched)
  }
  return { pending, overdue }
}

/**
 * The obligation's identity, from the same triple that identifies an
 * admission: (family, driver, turn). It deliberately does NOT include the kind:
 * one turn owes one thing, and a detector whose opinion changes later is a
 * correction event, not a second obligation. If `eligibleActions` ever returns
 * more than one kind for a turn, this preimage must gain the kind, or the first
 * kind would swallow the second.
 */
export function obligationIdFor(familyId: string, driverSessionId: string, turnBoundary: string): string {
  const digest = createHash('sha256')
    .update(`${familyId}\u0000${driverSessionId}\u0000${turnBoundary}`, 'utf8')
    .digest('hex')
  return `ob:${digest.slice(0, 32)}`
}

export type ObligationCreated = { ok: true; obligation_id: string; duplicate: boolean }
export type ObligationRefusal = { ok: false; obligation_id: string; message: string }

/**
 * Record that a turn owed something. This is the only creation writer.
 *
 * It never refuses for policy reasons: refusing creation would delete the
 * evidence that something was owed, which is the one property the completeness
 * metric rests on. `created_at` is required here even though the fold tolerates
 * a row without it - without an age the obligation can never become overdue,
 * and `overdueHours` would be decoration.
 *
 * A second call for the same turn appends nothing: the id is derived, so a
 * crash-and-retry or a re-evaluation is idempotent, and an obligation that is
 * already terminal keeps its state.
 */
export async function recordObligation(input: {
  vaultRoot: string
  familyId: string
  driverSessionId: string
  turnBoundary: string
  kind: EligibleActionKind
  createdAt: string
  sourceMessageId?: string
}): Promise<ObligationCreated | ObligationRefusal> {
  const obligationId = obligationIdFor(input.familyId, input.driverSessionId, input.turnBoundary)
  if (!input.createdAt.trim()) {
    return { ok: false, obligation_id: obligationId, message: 'recordObligation needs created_at; an obligation with no age can never be overdue' }
  }
  return withVaultLock(join(input.vaultRoot, 'families', input.familyId), async () => {
    if (foldObligations((await readRaw(input.vaultRoot, input.familyId)).split('\n')).has(obligationId)) {
      return { ok: true, obligation_id: obligationId, duplicate: true }
    }
    const path = obligationsPath(input.vaultRoot, input.familyId)
    await mkdir(dirname(path), { recursive: true })
    const row = {
      obligation_id: obligationId,
      family_id: input.familyId,
      kind: input.kind,
      created_at: input.createdAt,
      driver_session_id: input.driverSessionId,
      turn_boundary: input.turnBoundary,
      ...(input.sourceMessageId ? { source_message_id: input.sourceMessageId } : {}),
    }
    const handle = await open(path, 'a')
    try {
      await handle.writeFile(`${JSON.stringify(row)}\n`)
      await handle.sync()
    } finally {
      await handle.close()
    }
    return { ok: true, obligation_id: obligationId, duplicate: false }
  })
}

async function readRaw(vaultRoot: string, familyId: string): Promise<string> {
  try {
    return await readFile(obligationsPath(vaultRoot, familyId), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

export type ObligationBacklog = {
  pending: number
  overdue: number
  maxPending: number | null
  overdueHours: number
  /** True only when a cap is configured and the pending count exceeds it. */
  over: boolean
}

/**
 * The backlog an activation would start work against. `maxPending: null` is the
 * cap switched off, and `null` really means off - it is not a zero that refuses
 * everything.
 */
export function obligationBacklog(
  rows: readonly ObligationRow[],
  options: { asOf?: number | string; overdueHours?: number; maxPending?: number | null } = {},
): ObligationBacklog {
  const overdueHours = options.overdueHours ?? DEFAULT_OVERDUE_HOURS
  const summary = summarizeObligations(rows, { asOf: options.asOf, overdueHours })
  const maxPending = options.maxPending ?? null
  const pending = summary.pending.length
  return {
    pending,
    overdue: summary.overdue.length,
    maxPending,
    overdueHours,
    over: maxPending !== null && pending > maxPending,
  }
}
