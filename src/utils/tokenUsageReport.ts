import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tokenLedgerDirectory, type TokenLedgerRow } from './tokenLedger.js'

/**
 * Aggregation over the token ledger, kept free of React so the arithmetic can be
 * tested without a terminal - the same reason `parseForkRequest` is separate
 * from the leaf menu.
 *
 * The numbers here are the provider's own, as recorded per response. Nothing is
 * estimated and nothing is inferred: a figure a provider did not report is 0, and
 * zero is displayed as zero rather than smoothed over.
 *
 * `replay` rows (recorded responses replayed from fixtures) are excluded by
 * default. They are real rows describing spend that never happened, so counting
 * them overstates usage, and dropping them silently would hide that the ledger is
 * not the whole story. They are surfaced as a count instead.
 */

export type UsagePeriod = 'today' | 'week' | 'month' | 'all'

export const USAGE_PERIODS: readonly UsagePeriod[] = [
  'today',
  'week',
  'month',
  'all',
]

export interface UsageTotals {
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  costUSD: number
  sessions: number
}

export interface UsageGroup {
  key: string
  totals: UsageTotals
}

export interface UsageBucket {
  /** Sortable key: `YYYY-MM-DD`, `YYYY-Www` or `YYYY-MM`. */
  key: string
  label: string
  totals: UsageTotals
}

export interface UsageReport {
  totals: UsageTotals
  byModel: UsageGroup[]
  byBackend: UsageGroup[]
  bySession: UsageGroup[]
  buckets: UsageBucket[]
  /** Rows the ledger held but the report did not count, with the reason. */
  excluded: {
    replay: number
    malformed: number
    undated: number
    otherPeriod: number
    sessionFiltered: number
  }
  /** Oldest and newest counted row, so a window is never implied by silence. */
  window: { from: string | null; to: string | null }
  /** Top-level cost of ownership: every session ever recorded, not just this window. */
  lifetime: UsageTotals
}

export interface LoadOptions {
  directory?: string
  period?: UsagePeriod
  /** Only rows whose session id starts with this prefix. */
  sessionPrefix?: string
  /** Only rows whose model id contains this substring, case-insensitive. */
  model?: string
  /** Only rows for this backend. */
  backend?: string
  includeReplay?: boolean
  now?: Date
  /**
   * Rows already read from disk. A caller rendering several views of the same
   * ledger should read once and pass them here rather than re-reading per view.
   */
  rows?: readonly TokenLedgerRow[]
  /** Malformed-line count from that same read, reported in `excluded`. */
  malformed?: number
}

function emptyTotals(): UsageTotals {
  return {
    requests: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costUSD: 0,
    sessions: 0,
  }
}

/**
 * Session counting cannot be done by incrementing a field: the same session
 * appears in many rows, and the number of distinct sessions in a group is not
 * the number of rows in it.
 */
function countSessions(rows: readonly TokenLedgerRow[]): number {
  const seen = new Set<string>()
  for (const row of rows) if (row.session) seen.add(row.session)
  return seen.size
}

export function addRow(totals: UsageTotals, row: TokenLedgerRow): void {
  totals.requests += 1
  totals.input += row.input
  totals.output += row.output
  totals.cacheRead += row.cacheRead
  totals.cacheWrite += row.cacheWrite
  totals.costUSD += row.costUSD
}

export function totalTokens(totals: UsageTotals): number {
  return totals.input + totals.output + totals.cacheRead + totals.cacheWrite
}

/** Share of the token total spent re-reading cache, 0..1, or null when empty. */
export function cachedShare(totals: UsageTotals): number | null {
  const total = totalTokens(totals)
  return total > 0 ? (totals.cacheRead + totals.cacheWrite) / total : null
}

function toLedgerRow(raw: unknown): TokenLedgerRow | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  const num = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0
      ? Math.trunc(value)
      : 0
  return {
    v: 1,
    at: typeof row.at === 'string' ? row.at : '',
    session: typeof row.session === 'string' ? row.session : '',
    cwd: typeof row.cwd === 'string' ? row.cwd : '',
    model: typeof row.model === 'string' ? row.model : 'unknown',
    backend: (typeof row.backend === 'string'
      ? row.backend
      : 'unknown') as TokenLedgerRow['backend'],
    input: num(row.input),
    output: num(row.output),
    cacheRead: num(row.cacheRead),
    cacheWrite: num(row.cacheWrite),
    costUSD: typeof row.costUSD === 'number' && Number.isFinite(row.costUSD)
      ? row.costUSD
      : 0,
    src:
      row.src === 'advisor' || row.src === 'replay' ? row.src : 'response',
  }
}

export interface LedgerRead {
  rows: TokenLedgerRow[]
  malformed: number
  files: string[]
}

/**
 * Reads the live ledger plus its single rotation. A rotated file is older, so it
 * is read first and row order stays chronological.
 */
export function readTokenLedger(directory?: string): LedgerRead {
  const dir = directory ?? tokenLedgerDirectory()
  if (!existsSync(dir)) return { rows: [], malformed: 0, files: [] }

  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return { rows: [], malformed: 0, files: [] }
  }
  const files = names
    .filter(name => name === 'tokens.jsonl' || name.startsWith('tokens.jsonl.'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map(name => join(dir, name))

  const rows: TokenLedgerRow[] = []
  let malformed = 0
  for (const file of files) {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (line.length === 0) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        malformed++
        continue
      }
      const row = toLedgerRow(parsed)
      if (row) rows.push(row)
      else malformed++
    }
  }
  return { rows, malformed, files }
}

/**
 * Midnight local on the day `now` falls in. Periods are calendar periods in the
 * user's own timezone - "today" has to mean the day they are living in, and the
 * ledger stamps are UTC, so the comparison is done on parsed times rather than
 * on the ISO strings.
 */
export function periodStart(period: UsagePeriod, now: Date): number | null {
  if (period === 'all') return null
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (period === 'week') {
    // Weeks start on Monday: a "this week" that splits the weekend reads wrong.
    const weekday = (start.getDay() + 6) % 7
    start.setDate(start.getDate() - weekday)
  } else if (period === 'month') {
    start.setDate(1)
  }
  return start.getTime()
}

function periodEnd(period: UsagePeriod, now: Date): number | null {
  if (period !== 'today' && period !== 'week' && period !== 'month') return null
  const start = periodStart(period, now)
  if (start === null) return null
  const end = new Date(start)
  if (period === 'today') end.setDate(end.getDate() + 1)
  else if (period === 'week') end.setDate(end.getDate() + 7)
  else end.setMonth(end.getMonth() + 1)
  return end.getTime()
}

export function isPeriod(period: UsagePeriod): boolean {
  return USAGE_PERIODS.includes(period)
}

const DAY_MS = 86_400_000

function bucketKey(at: number, unit: 'day' | 'week' | 'month'): string {
  const date = new Date(at)
  if (unit === 'day') {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  }
  if (unit === 'month') {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`
  }
  // ISO week, so a week that spans a month or year boundary stays one bucket.
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const weekday = (start.getDay() + 6) % 7
  start.setDate(start.getDate() - weekday)
  return `${start.getFullYear()}-W${pad(isoWeek(start))}`
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function isoWeek(date: Date): number {
  const thursday = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  thursday.setDate(thursday.getDate() + 3 - ((thursday.getDay() + 6) % 7))
  const firstThursday = new Date(thursday.getFullYear(), 0, 4)
  firstThursday.setDate(
    firstThursday.getDate() + 3 - ((firstThursday.getDay() + 6) % 7),
  )
  return (
    1 +
    Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * DAY_MS))
  )
}

/** Day / week / month buckets, chosen from how much history is on hand. */
export function bucketUnitFor(rows: readonly TokenLedgerRow[]): 'day' | 'week' | 'month' {
  const times = rows
    .map(row => Date.parse(row.at))
    .filter(value => !Number.isNaN(value))
  if (times.length === 0) return 'day'
  const span = Math.max(...times) - Math.min(...times)
  if (span <= 21 * DAY_MS) return 'day'
  if (span <= 180 * DAY_MS) return 'week'
  return 'month'
}

function groupRows(
  rows: readonly TokenLedgerRow[],
  keyOf: (row: TokenLedgerRow) => string,
): UsageGroup[] {
  const groups = new Map<string, TokenLedgerRow[]>()
  for (const row of rows) {
    const key = keyOf(row)
    const bucket = groups.get(key)
    if (bucket) bucket.push(row)
    else groups.set(key, [row])
  }
  return [...groups.entries()]
    .map(([key, members]) => ({
      key,
      totals: summarize(members),
    }))
    .sort((a, b) => totalTokens(b.totals) - totalTokens(a.totals))
}

export function summarize(rows: readonly TokenLedgerRow[]): UsageTotals {
  const totals = emptyTotals()
  for (const row of rows) addRow(totals, row)
  totals.sessions = countSessions(rows)
  return totals
}

export function buildUsageReport(options: LoadOptions = {}): UsageReport {
  const now = options.now ?? new Date()
  const period = options.period ?? 'all'
  const read = options.rows
    ? { rows: [...options.rows], malformed: options.malformed ?? 0 }
    : readTokenLedger(options.directory)
  const { rows, malformed } = read
  const excluded = {
    replay: 0,
    malformed,
    undated: 0,
    otherPeriod: 0,
    sessionFiltered: 0,
  }

  const datable: Array<{ row: TokenLedgerRow; at: number }> = []
  for (const row of rows) {
    if (row.src === 'replay' && !options.includeReplay) {
      excluded.replay++
      continue
    }
    const at = Date.parse(row.at)
    if (Number.isNaN(at)) {
      excluded.undated++
      continue
    }
    datable.push({ row, at })
  }

  const start = periodStart(period, now)
  const end = periodEnd(period, now)
  const filtered: TokenLedgerRow[] = []
  for (const entry of datable) {
    if (start !== null && entry.at < start) {
      excluded.otherPeriod++
      continue
    }
    if (end !== null && entry.at >= end) {
      excluded.otherPeriod++
      continue
    }
    if (options.sessionPrefix && !entry.row.session.startsWith(options.sessionPrefix)) {
      excluded.sessionFiltered++
      continue
    }
    if (
      options.model &&
      !entry.row.model.toLowerCase().includes(options.model.toLowerCase())
    ) {
      excluded.sessionFiltered++
      continue
    }
    if (
      options.backend &&
      entry.row.backend.toLowerCase() !== options.backend.toLowerCase()
    ) {
      excluded.sessionFiltered++
      continue
    }
    filtered.push(entry.row)
  }

  const counted = datable.map(entry => entry.row)
  const times = filtered
    .map(row => Date.parse(row.at))
    .filter(value => !Number.isNaN(value))
    .sort((a, b) => a - b)

  const unit = bucketUnitFor(filtered)
  const buckets = new Map<string, TokenLedgerRow[]>()
  for (const row of filtered) {
    const key = bucketKey(Date.parse(row.at), unit)
    const bucket = buckets.get(key)
    if (bucket) bucket.push(row)
    else buckets.set(key, [row])
  }

  return {
    totals: summarize(filtered),
    byModel: groupRows(filtered, row => row.model),
    byBackend: groupRows(filtered, row => row.backend),
    bySession: groupRows(filtered, row => row.session || '(no session)'),
    buckets: [...buckets.entries()]
      .map(([key, members]) => ({
        key,
        label: key,
        totals: summarize(members),
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    excluded,
    window: {
      from: times.length > 0 ? new Date(times[0]!).toISOString() : null,
      to: times.length > 0 ? new Date(times.at(-1)!).toISOString() : null,
    },
    lifetime: summarize(counted),
  }
}

/**
 * The most recent `days` calendar days as contiguous points, oldest first.
 * Days with no usage are present and zero rather than missing, so a gap in a
 * chart means "nothing recorded", not "the series skipped it".
 */
export function dailyPoints(
  rows: readonly TokenLedgerRow[],
  days: number,
  now: Date = new Date(),
): Array<{ date: string; totals: UsageTotals }> {
  const byDate = new Map<string, TokenLedgerRow[]>()
  for (const row of rows) {
    const at = Date.parse(row.at)
    if (Number.isNaN(at)) continue
    const date = new Date(at)
    const key = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    const bucket = byDate.get(key)
    if (bucket) bucket.push(row)
    else byDate.set(key, [row])
  }

  const points: Array<{ date: string; totals: UsageTotals }> = []
  const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  cursor.setDate(cursor.getDate() - (days - 1))
  for (let index = 0; index < days; index++) {
    const key = `${cursor.getFullYear()}-${pad(cursor.getMonth() + 1)}-${pad(cursor.getDate())}`
    points.push({ date: key, totals: summarize(byDate.get(key) ?? []) })
    cursor.setDate(cursor.getDate() + 1)
  }
  return points
}
