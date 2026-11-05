import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

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
