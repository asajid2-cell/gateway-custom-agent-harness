import { tokenLedgerDirectory } from './tokenLedger.js'
import {
  buildUsageReport,
  cachedShare,
  totalTokens,
  type UsagePeriod,
  type UsageReport,
  type UsageTotals,
} from './tokenUsageReport.js'
import {
  renderBarLines,
  renderColumns,
  renderShare,
  sparkline,
} from './terminalCharts.js'

/**
 * The text form of the usage report, shared by `/usage <args>` and by
 * `bun scripts/token-usage.mjs`.
 *
 * One implementation rather than two: a CLI that spawned the script and a script
 * that re-implemented the tables would drift, and the drift would be invisible
 * until the numbers disagreed. The script is a thin shim over this module.
 */

export interface UsageCliOptions {
  format: 'text' | 'json'
  period: UsagePeriod
  directory?: string
  sessionPrefix?: string
  model?: string
  backend?: string
  includeReplay: boolean
  top: number
  /** `--help` was asked for; the report is the help text instead. */
  help: boolean
}

export const USAGE_HELP = `Token usage report over the harness token ledger.

Usage: /usage [options]          (bare /usage opens the menu)
       bun scripts/token-usage.mjs [options]

Options:
  --dir DIR            Ledger directory (default: $GATEWAY_TOKEN_LEDGER_DIR or ~/.claude/token-ledger)
  --period WHEN        today | week | month | all        (default: all)
  --session PREFIX     Only rows whose session id starts with PREFIX
  --model SUBSTRING    Only rows whose model contains SUBSTRING (case-insensitive)
  --backend NAME       Only rows for one backend (codex, deepseek, opencode-go, ...)
  --include-replay     Count replayed fixture rows too
  --top N              Rows listed per section (default: 25)
  --json               Emit one JSON object instead of tables
  --help               This text

Text output has tables for the totals, the trend, per model, per chat, per
upstream, and where the volume went.
`

export class UsageArgumentError extends Error {}

const PERIODS: readonly UsagePeriod[] = ['today', 'week', 'month', 'all']

/**
 * Argv parsing is shared with the command, so a flag accepted by the script is
 * accepted after `/usage` and vice versa. Unknown input throws rather than being
 * ignored: silently dropping `--sesion` would print a report of the wrong scope,
 * which is the one failure mode a usage report cannot afford.
 */
export function parseUsageArgs(argv: readonly string[]): UsageCliOptions {
  const options: UsageCliOptions = {
    format: 'text',
    period: 'all',
    includeReplay: false,
    top: 25,
    help: false,
  }
  const valueOf = (index: number, flag: string): string => {
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new UsageArgumentError(`Missing value for ${flag}`)
    }
    return value
  }

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    if (arg === '--dir') options.directory = valueOf(index++, '--dir')
    else if (arg === '--period') {
      const period = valueOf(index++, '--period').toLowerCase() as UsagePeriod
      if (!PERIODS.includes(period)) {
        throw new UsageArgumentError(`--period must be one of: ${PERIODS.join(', ')}`)
      }
      options.period = period
    } else if (arg === '--since' || arg === '--until') {
      // Kept as a loud failure rather than silently ignored: these were
      // advertised once and removed, and a user who still types them should be
      // told the window moved to --period rather than shown an unscoped report.
      throw new UsageArgumentError(
        `${arg} was replaced by --period (today | week | month | all)`,
      )
    } else if (arg === '--session') options.sessionPrefix = valueOf(index++, '--session')
    else if (arg === '--model') options.model = valueOf(index++, '--model')
    else if (arg === '--backend') options.backend = valueOf(index++, '--backend')
    else if (arg === '--include-replay') options.includeReplay = true
    else if (arg === '--json') options.format = 'json'
    else if (arg === '--top') {
      const parsed = Number(valueOf(index++, '--top'))
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new UsageArgumentError('--top needs a positive integer')
      }
      options.top = parsed
    } else if (arg === '--help' || arg === '-h') {
      // Help wins outright rather than only when the rest of the line parses:
      // `--help` next to a typo should print the surface, not the typo.
      return { ...options, help: true }
    } else if (arg.startsWith('--')) {
      throw new UsageArgumentError(`Unknown option: ${arg}`)
    } else if (PERIODS.includes(arg.toLowerCase() as UsagePeriod)) {
      // `usage week` reads better than `usage --period week` for the common case.
      options.period = arg.toLowerCase() as UsagePeriod
    } else {
      throw new UsageArgumentError(`Unexpected argument: ${arg}`)
    }
  }
  return options
}

function num(value: number): string {
  return value.toLocaleString('en-US')
}

function tokens(value: number): string {
  if (value >= 1e12) return `${(value / 1e12).toFixed(2)}T`
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`
  return String(value)
}

function money(value: number): string {
  return value > 0 ? `$${value.toFixed(4)}` : '—'
}

function share(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`
}

function tableRow(totals: UsageTotals): string {
  return [
    num(totals.requests).padStart(6),
    tokens(totals.input).padStart(9),
    tokens(totals.output).padStart(9),
    tokens(totals.cacheRead).padStart(11),
    tokens(totals.cacheWrite).padStart(11),
    tokens(totalTokens(totals)).padStart(10),
    share(cachedShare(totals)).padStart(7),
  ].join('  ')
}

const TABLE_HEADER = [
  '  rows',
  '    input',
  '   output',
  ' cache read',
  'cache write',
  '     total',
  ' cached',
].join('  ')

function barSection(
  title: string,
  groups: readonly { key: string; totals: UsageTotals }[],
  limit: number,
  width: number,
): string {
  const shown = groups.slice(0, limit)
  const lines = [title]
  if (shown.length === 0) {
    lines.push('  nothing recorded')
    return lines.join('\n')
  }
  const labelWidth = Math.min(30, Math.max(...shown.map(group => group.key.length)))
  // The detail is self-describing rather than a slice of the TOTAL table: the
  // full seven-column row does not fit beside a label and a bar at 100 columns,
  // and squeezing it in wrapped every line past the terminal edge.
  for (const line of renderBarLines(
    shown.map(group => ({
      label: group.key,
      value: totalTokens(group.totals),
      detail:
        `${tokens(totalTokens(group.totals))} · ${share(cachedShare(group.totals))} cached` +
        ` · ${num(group.totals.requests)} req · ${money(group.totals.costUSD)}`,
    })),
    Math.max(40, width),
    { labelWidth },
  )) {
    lines.push(line)
  }
  if (groups.length > shown.length) lines.push(`  … ${groups.length - shown.length} more`)
  return lines.join('\n')
}

/**
 * Bucket keys under a trend, separated rather than aligned to columns.
 *
 * Deliberately not positioned under the bars: the bars are one character each,
 * so lining up ten-character dates requires either an axis wider than the
 * terminal or a row of clipped stubs that reads as data. Labels are thinned to
 * fit and the last bucket is always named, so the end of the window is never
 * implied. A period with no usage shows up as a jump in the keys.
 */
function labelLine(labels: readonly string[], width: number): string {
  const separator = ' · '
  const longest = Math.max(...labels.map(label => label.length))
  const budget = Math.max(1, Math.floor(width / labels.length))
  const stride = Math.max(1, Math.ceil((longest + separator.length) / budget))
  const chosen: string[] = []
  for (let index = 0; index < labels.length; index += stride) chosen.push(labels[index]!)
  if (chosen.at(-1) !== labels.at(-1)) chosen.push(labels.at(-1)!)
  return `  ${chosen.join(separator)}`
}

export function renderUsageText(options: Partial<UsageCliOptions> = {}): string {
  const resolved: UsageCliOptions = {
    format: 'text',
    period: 'all',
    includeReplay: false,
    top: 25,
    help: false,
    ...options,
  }
  if (resolved.help) return USAGE_HELP

  const report = buildUsageReport({
    directory: resolved.directory,
    period: resolved.period,
    sessionPrefix: resolved.sessionPrefix,
    model: resolved.model,
    backend: resolved.backend,
    includeReplay: resolved.includeReplay,
  })

  if (resolved.format === 'json') return renderUsageJson(report, resolved)

  const width = 100
  const lines: string[] = []
  lines.push(`Token ledger ${resolved.directory ?? tokenLedgerDirectory()}`)
  lines.push(
    `  window ${resolved.period} · ${num(report.totals.requests)} requests · ${num(report.totals.sessions)} chats`,
  )
  if (report.window.from && report.window.to) {
    lines.push(`  recorded between ${report.window.from} and ${report.window.to}`)
  }
  const aside: string[] = []
  if (report.excluded.replay > 0) aside.push(`${num(report.excluded.replay)} replayed fixture row(s)`)
  if (report.excluded.otherPeriod > 0) aside.push(`${num(report.excluded.otherPeriod)} row(s) outside this window`)
  if (report.excluded.sessionFiltered > 0) aside.push(`${num(report.excluded.sessionFiltered)} row(s) filtered out`)
  if (report.excluded.undated > 0) aside.push(`${num(report.excluded.undated)} row(s) without a readable timestamp`)
  if (report.excluded.malformed > 0) aside.push(`${num(report.excluded.malformed)} malformed line(s)`)
  if (aside.length > 0) lines.push(`  not counted: ${aside.join(', ')}`)
  lines.push('')

  lines.push(`TOTAL`)
  lines.push(TABLE_HEADER)
  lines.push(tableRow(report.totals))
  if (report.totals.requests === 0) {
    lines.push('')
    lines.push('No usage recorded in this window.')
    return `${lines.join('\n')}\n`
  }
  lines.push('')

  if (report.buckets.length > 0) {
    const values = report.buckets.map(bucket => totalTokens(bucket.totals))
    lines.push(`TREND (${report.buckets.length} bucket${report.buckets.length === 1 ? '' : 's'}, oldest first)`)
    lines.push(`  ${sparkline(values)}`)
    // Columns need something to compare: one bucket draws six identical rows of
    // one block, which reads as data when it is only a scale with nothing on it.
    if (values.length > 1) {
      for (const line of renderColumns(values, 6)) lines.push(`  ${line}`)
    }
    lines.push(labelLine(report.buckets.map(bucket => bucket.key), width))
    lines.push('')
  }

  const composition = renderShare(
    [
      { label: 'input', value: report.totals.input },
      { label: 'output', value: report.totals.output },
      { label: 'cache read', value: report.totals.cacheRead },
      { label: 'cache write', value: report.totals.cacheWrite },
    ],
    Math.max(20, width - 20),
  )
  lines.push('WHERE THE TOKENS WENT')
  lines.push(`  ${composition.bar}  cost ${money(report.totals.costUSD)}`)
  lines.push(`  ${composition.legend}`)
  lines.push(
    `  lifetime: ${tokens(totalTokens(report.lifetime))} tokens across ${num(report.lifetime.requests)} requests, ${num(report.lifetime.sessions)} chats`,
  )
  lines.push('')

  lines.push(barSection('BY MODEL', report.byModel, resolved.top, width))
  lines.push('')
  lines.push(barSection('BY CHAT', report.bySession, resolved.top, width))
  lines.push('')
  lines.push(barSection('BY UPSTREAM', report.byBackend, report.byBackend.length, width))
  lines.push('')
  lines.push(
    'input, output, cache read and cache write are the four figures the provider reported and\n' +
      'do not overlap. "cached" is the share of the total spent re-reading cache.',
  )
  return `${lines.join('\n')}\n`
}

function renderUsageJson(report: UsageReport, options: UsageCliOptions): string {
  return `${JSON.stringify(
    {
      ledger: options.directory ?? tokenLedgerDirectory(),
      period: options.period,
      window: report.window,
      totals: report.totals,
      lifetime: report.lifetime,
      excluded: report.excluded,
      byModel: report.byModel,
      byBackend: report.byBackend,
      bySession: report.bySession,
      buckets: report.buckets,
    },
    null,
    2,
  )}\n`
}
