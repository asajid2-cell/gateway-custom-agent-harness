import React, { useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
import { Select } from './CustomSelect/select.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { useRegisterOverlay } from '../context/overlayContext.js'
import {
  averageTtftMs,
  averageTokPerSecond,
  buildUsageReport,
  cachedShare,
  dayKey,
  dayStartMs,
  parseDay,
  readTokenLedger,
  totalTokens,
  type UsagePeriod,
  type UsageReport,
  type UsageSeriesPoint,
  type UsageTotals,
} from '../utils/tokenUsageReport.js'
import { chatLabel, loadSessionTitles } from '../utils/sessionTitles.js'
import {
  axisInterval,
  clip,
  renderBars,
  renderAxis,
  renderColumns,
  renderShare,
  sparkline,
} from '../utils/terminalCharts.js'
import { tokenLedgerDirectory } from '../utils/tokenLedger.js'

/**
 * The `/usage` surface: a menu over the token ledger.
 *
 * Bare `/usage` opens this, matching `/leaf` - the command arguments remain the
 * passthrough, so `--period`, `--session` and the rest still work for scripting.
 *
 * Everything shown is measured. The report separates "nothing was recorded" from
 * "nothing was spent", because a chart that cannot tell those apart is worse than
 * no chart: an empty day and a day the recorder missed look identical.
 */

const PERIOD_LABEL: Record<UsagePeriod, string> = {
  today: 'Today',
  week: 'This week',
  month: 'This month',
  all: 'All time',
}

const PERIODS: readonly UsagePeriod[] = ['today', 'week', 'month', 'all']

type Screen =
  | 'home'
  | 'models'
  | 'sessions'
  | 'backends'
  | 'trend'
  | 'composition'
  | 'speed'
  | 'range'

/** An explicit window, inclusive on both ends, as local `YYYY-MM-DD` days. */
type Range = { from?: string; to?: string }

function tokens(value: number): string {
  if (value >= 1e12) return `${(value / 1e12).toFixed(2)}T`
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`
  return String(value)
}

function exact(value: number): string {
  return value.toLocaleString('en-US')
}

function money(value: number): string {
  return value > 0 ? `$${value.toFixed(4)}` : '—'
}

function share(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`
}

function rate(value: number | null): string {
  return value === null ? '—' : `${(Math.round(value * 10) / 10).toFixed(1)} tok/s`
}

function millis(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '—'
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`
}

/** A one-line summary used at the top of every screen so the window is never implied. */
function SummaryLine({ report, windowLabel }: { report: UsageReport; windowLabel: string }): React.ReactNode {
  const totals = report.totals
  return (
    <Box flexDirection="column">
      <Text bold>{`Usage — ${windowLabel}`}</Text>
      <Text dimColor>
        {`${exact(totals.requests)} requests · ${tokens(totalTokens(totals))} tokens · ${exact(totals.sessions)} chat${totals.sessions === 1 ? '' : 's'} · ${money(totals.costUSD)}`}
      </Text>
      <Text dimColor>
        {`in ${tokens(totals.input)} · out ${tokens(totals.output)} · cache read ${tokens(totals.cacheRead)} · cache write ${tokens(totals.cacheWrite)} · ${share(cachedShare(totals))} cached`}
      </Text>
      <Text dimColor>
        {`${rate(averageTokPerSecond(totals))} over ${exact(totals.speedRows)} measured response${totals.speedRows === 1 ? '' : 's'}`}
      </Text>
    </Box>
  )
}

function EmptyLedger({ directory }: { directory: string }): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Text bold>Usage</Text>
      <Text>No usage has been recorded yet.</Text>
      <Text dimColor>{`Ledger: ${directory}`}</Text>
      <Text dimColor>
        Every API response writes one row here. Run a session with any model, then open this again.
      </Text>
    </Box>
  )
}

/**
 * A horizontal bar per group, with the token count beside it. Bars are scaled
 * against the largest group rather than an absolute maximum, so a quiet period
 * still shows its shape instead of a row of empty bars.
 */
function BarSection({
  title,
  groups,
  width,
  limit,
  detailOf,
}: {
  title: string
  groups: UsageReport['byModel']
  width: number
  limit: number
  detailOf: (totals: UsageTotals) => string
}): React.ReactNode {
  const shown = groups.slice(0, limit)
  if (shown.length === 0) {
    return (
      <Box flexDirection="column">
        <Text bold>{title}</Text>
        <Text dimColor>Nothing recorded in this window</Text>
      </Box>
    )
  }
  const labelWidth = Math.min(30, Math.max(...shown.map(group => group.key.length)))
  const bars = renderBars(
    shown.map(group => ({
      label: group.key,
      value: totalTokens(group.totals),
      detail: detailOf(group.totals),
    })),
    width,
    { labelWidth },
  )
  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      {bars.map((bar, index) => (
        <Text key={shown[index]!.key}>
          {bar.label}
          {'  '}
          <Text color="success">{bar.primary}</Text>
          {bar.secondary.length > 0 ? <Text color="warning">{bar.secondary}</Text> : null}
          {bar.pad}
          {bar.detail ? `  ${bar.detail}` : ''}
        </Text>
      ))}
      {groups.length > shown.length ? (
        <Text dimColor>{`… ${groups.length - shown.length} more`}</Text>
      ) : null}
    </Box>
  )
}

/**
 * Merge totals without double-counting sessions.
 *
 * Coarsening a series groups several days into one column. Token figures add
 * up, but a chat that spent on two of those days is still one chat, so summing
 * `sessions` would invent chats. The trend does not show a session count, so
 * the merged value is left at zero rather than being a wrong number.
 */
function mergeTotals(values: readonly UsageTotals[]): UsageTotals {
  const merged: UsageTotals = {
    requests: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costUSD: 0,
    sessions: 0,
    speedRows: 0,
    speedOutput: 0,
    speedMs: 0,
    ttftRows: 0,
    ttftMs: 0,
  }
  for (const value of values) {
    merged.requests += value.requests
    merged.input += value.input
    merged.output += value.output
    merged.cacheRead += value.cacheRead
    merged.cacheWrite += value.cacheWrite
    merged.costUSD += value.costUSD
    merged.speedRows += value.speedRows
    merged.speedOutput += value.speedOutput
    merged.speedMs += value.speedMs
    merged.ttftRows += value.ttftRows
    merged.ttftMs += value.ttftMs
  }
  return merged
}

/** Fit a series into the terminal by grouping adjacent points, never by dropping them. */
function coarsen(
  points: readonly UsageSeriesPoint[],
  maxPoints: number,
): UsageSeriesPoint[] {
  if (points.length <= maxPoints) return [...points]
  const size = Math.ceil(points.length / maxPoints)
  const out: UsageSeriesPoint[] = []
  for (let index = 0; index < points.length; index += size) {
    const chunk = points.slice(index, index + size)
    out.push({
      key: chunk[0]!.key,
      totals: mergeTotals(chunk.map(point => point.totals)),
    })
  }
  return out
}

/**
 * Token columns and a throughput line over the counted window.
 *
 * The columns are as wide as the labels need, because an axis that does not sit
 * under its columns is decoration, and a fixed three-cell axis clipped every
 * date to its first character - a row of identical stubs that reads as data.
 * When the terminal is too narrow for both, the columns keep the full value and
 * the axis is replaced by an explicit range rather than by clipped labels.
 */
function TrendSection({ report, width }: { report: UsageReport; width: number }): React.ReactNode {
  const series = report.series
  const maxPoints = Math.max(8, Math.min(60, Math.floor(width / 2)))
  const points = coarsen(series.points, maxPoints)
  const values = points.map(point => totalTokens(point.totals))
  const peak = Math.max(0, ...values)
  const height = 8
  const columnWidth = Math.max(1, Math.min(3, Math.floor(width / Math.max(1, points.length))))
  const labelled = columnWidth >= 3
  const columns = renderColumns(values, height, columnWidth)
  const cellWidth = columnWidth
  const interval = axisInterval(points.length, cellWidth, width)
  // Day of month fits the column; a week or month key is already short.
  const labels = points.map(point =>
    /^\d{4}-\d{2}-\d{2}$/.test(point.key) ? point.key.slice(5) : point.key,
  )
  const speeds = points.map(point => averageTokPerSecond(point.totals))
  const measured = speeds.map(value => value ?? 0)
  const peakSpeed = Math.max(0, ...measured)

  if (peak === 0) {
    return (
      <Box flexDirection="column">
        <Text bold>{`Trend — ${series.unit}`}</Text>
        <Text dimColor>No tokens recorded in this window.</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Text bold>{`Trend — ${points.length} ${series.unit}${points.length === 1 ? '' : 's'}`}</Text>
      <Text dimColor>{`peak ${tokens(peak)} tokens on ${points[values.indexOf(peak)]!.key}`}</Text>
      {columns.map((line, index) => (
        <Text key={index} color="success">
          {line}
        </Text>
      ))}
      <Text dimColor>
        {labelled
          ? renderAxis(labels, interval, cellWidth)
          : `${points[0]!.key} … ${points.at(-1)!.key}`}
      </Text>
      <Text dimColor>{sparkline(values)}</Text>
      {peakSpeed > 0 ? (
        <>
          <Text> </Text>
          <Text bold>Throughput</Text>
          <Text dimColor>
            {`peak ${rate(peakSpeed)} in ${points[measured.indexOf(peakSpeed)]!.key} · ${rate(averageTokPerSecond(report.totals))} across the window`}
          </Text>
          <Text color="warning">{sparkline(measured)}</Text>
          <Text dimColor>
            {`measured responses only; a ${series.unit} with none is a gap, not a zero`}
          </Text>
        </>
      ) : (
        <Text dimColor>No response in this window measured its generation time.</Text>
      )}
    </Box>
  )
}

/** Where the volume went: input vs output vs cache, and cache read vs write. */
function CompositionSection({ report, width }: { report: UsageReport; width: number }): React.ReactNode {
  const totals = report.totals
  if (totalTokens(totals) === 0) {
    return (
      <Box flexDirection="column">
        <Text bold>Where the tokens went</Text>
        <Text dimColor>Nothing recorded in this window</Text>
      </Box>
    )
  }
  const overall = renderShare(
    [
      { label: 'input', value: totals.input },
      { label: 'output', value: totals.output },
      { label: 'cache read', value: totals.cacheRead },
      { label: 'cache write', value: totals.cacheWrite },
    ],
    Math.max(20, width - 8),
  )
  const cache = renderShare(
    [
      { label: 'cache read', value: totals.cacheRead },
      { label: 'cache write', value: totals.cacheWrite },
    ],
    Math.max(20, width - 8),
  )
  return (
    <Box flexDirection="column">
      <Text bold>Where the tokens went</Text>
      <Text>{overall.bar}</Text>
      <Text dimColor>{overall.legend}</Text>
      <Text> </Text>
      <Text bold>Cache traffic</Text>
      <Text>{cache.bar}</Text>
      <Text dimColor>{cache.legend}</Text>
      <Text> </Text>
      <Text bold>Time</Text>
      <Text dimColor>
        {`${rate(averageTokPerSecond(totals))} output · first token ${millis(averageTtftMs(totals) ?? undefined)} · ${exact(totals.speedRows)} of ${exact(totals.requests)} responses measured`}
      </Text>
      <Text dimColor>
        {`Cost ${money(totals.costUSD)} over ${exact(totals.requests)} requests · ${totals.costUSD > 0 ? `$${(totals.costUSD / Math.max(1, totals.requests)).toFixed(4)} per request` : 'no cost reported'}`}
      </Text>
      <Text dimColor>
        Lifetime to date: {tokens(totalTokens(report.lifetime))} tokens across {exact(report.lifetime.requests)} requests, {exact(report.lifetime.sessions)} chats.
      </Text>
    </Box>
  )
}

/**
 * Throughput, read from the responses that measured it.
 *
 * A token count says how much was spent; it does not say whether the wait was
 * the provider, the prompt, or the tool. `genMs` is the span between the first
 * and last streamed token, so the rate here is the model's own output speed,
 * and rows without that measurement are left out rather than counted as zero.
 */
function SpeedSection({
  report,
  titles,
  width,
}: {
  report: UsageReport
  titles: ReadonlyMap<string, string>
  width: number
}): React.ReactNode {
  const overall = averageTokPerSecond(report.totals)
  if (report.totals.speedRows === 0) {
    return (
      <Box flexDirection="column">
        <Text bold>Throughput</Text>
        <Text dimColor>
          No response in this window recorded a generation window. Speed is
          measured from the first to the last streamed token, so older ledger
          rows and replayed fixtures have none.
        </Text>
      </Box>
    )
  }

  const measured = report.measured
    .filter(row => typeof row.tokPerSec === 'number' && row.tokPerSec > 0)
    .sort((a, b) => (a.tokPerSec ?? 0) - (b.tokPerSec ?? 0))
  const slowest = measured.slice(0, 8)
  const fastest = measured.slice(-3).reverse()
  const byBackend = report.byBackend
    .map(group => ({
      key: group.key,
      speed: averageTokPerSecond(group.totals),
      rows: group.totals.speedRows,
    }))
    .filter(group => group.speed !== null)
    .sort((a, b) => (b.speed ?? 0) - (a.speed ?? 0))

  const line = (row: (typeof measured)[number]): string => {
    const when = row.at.slice(0, 16).replace('T', ' ')
    const chat = clip(chatLabel(row.session, titles), Math.max(18, width - 62))
    return `${when}  ${chat}  ${clip(row.model, 24)}  ${rate(row.tokPerSec ?? null)}  gen ${millis(row.genMs)}  ttft ${millis(row.ttftMs)}`
  }

  return (
    <Box flexDirection="column">
      <Text bold>Throughput</Text>
      <Text>
        {`${rate(overall)} overall · ${exact(report.totals.speedRows)} of ${exact(report.totals.requests)} responses measured`}
      </Text>
      <Text dimColor>
        {`fastest ${rate(measured.at(-1)?.tokPerSec ?? null)} · slowest ${rate(measured[0]?.tokPerSec ?? null)}`}
      </Text>
      <Text> </Text>
      <Text bold>By upstream</Text>
      {byBackend.length === 0 ? (
        <Text dimColor>Nothing measured</Text>
      ) : (
        byBackend.map(group => (
          <Text key={group.key}>
            {`${clip(group.key, 16).padEnd(16)}  ${rate(group.speed).padStart(10)}  ${exact(group.rows)} measured`}
          </Text>
        ))
      )}
      <Text> </Text>
      <Text bold>Slowest responses</Text>
      {slowest.map((row, index) => (
        <Text key={`slow-${index}`}>{line(row)}</Text>
      ))}
      <Text> </Text>
      <Text bold>Fastest responses</Text>
      {fastest.map((row, index) => (
        <Text key={`fast-${index}`}>{line(row)}</Text>
      ))}
    </Box>
  )
}

function ExcludedNote({ report }: { report: UsageReport }): React.ReactNode {
  const notes: string[] = []
  if (report.excluded.replay > 0) notes.push(`${exact(report.excluded.replay)} replayed fixture rows`)
  if (report.excluded.otherPeriod > 0) notes.push(`${exact(report.excluded.otherPeriod)} outside this window`)
  if (report.excluded.sessionFiltered > 0) notes.push(`${exact(report.excluded.sessionFiltered)} filtered out`)
  if (report.excluded.undated > 0) notes.push(`${exact(report.excluded.undated)} without a readable timestamp`)
  if (report.excluded.malformed > 0) notes.push(`${exact(report.excluded.malformed)} malformed lines`)
  if (notes.length === 0) return null
  return <Text dimColor>{`Not counted: ${notes.join(', ')}`}</Text>
}

export function UsageMenu({ onDone, initialPeriod = 'all' }: { onDone: (result?: string) => void; initialPeriod?: UsagePeriod }): React.ReactNode {
  useRegisterOverlay('usage-menu', true)
  const { columns } = useTerminalSize()
  const [screen, setScreen] = useState<Screen>('home')
  const [period, setPeriod] = useState<UsagePeriod>(initialPeriod)
  const [sessionPrefix, setSessionPrefix] = useState<string | undefined>(undefined)
  const [range, setRange] = useState<Range | null>(null)
  const [rangeDraft, setRangeDraft] = useState<{ from: string; to: string }>({
    from: '',
    to: '',
  })
  const [rangeField, setRangeField] = useState<'from' | 'to'>('from')
  const [rangeError, setRangeError] = useState<string | null>(null)
  const [titles, setTitles] = useState<ReadonlyMap<string, string>>(new Map())

  // Names live in the transcripts, not the ledger, so they arrive asynchronously.
  // Until they do the report shows short ids, which is the same fallback a chat
  // with no title gets - never a blank line.
  useEffect(() => {
    let live = true
    void loadSessionTitles().then(map => {
      if (live) setTitles(map)
    })
    return () => {
      live = false
    }
  }, [])

  const directory = tokenLedgerDirectory()
  // Read once per mount: the ledger is append-only, and re-reading it on every
  // period switch would be disk work for a change that only re-filters in memory.
  const ledger = useMemo(() => readTokenLedger(), [])
  const report = useMemo(
    () =>
      buildUsageReport({
        period,
        from: range?.from,
        to: range?.to,
        sessionPrefix,
        rows: ledger.rows,
        malformed: ledger.malformed,
      }),
    [period, range, sessionPrefix, ledger],
  )
  const empty = report.lifetime.requests === 0 && report.excluded.replay === 0
  const windowLabel = range
    ? `${range.from ?? 'start'} → ${range.to ?? 'now'}`
    : PERIOD_LABEL[period]
  const chatName = (id: string): string =>
    id === '(no session)' ? id : chatLabel(id, titles)

  const applyRange = (): void => {
    const from = rangeDraft.from.trim()
    const to = rangeDraft.to.trim()
    if (!from && !to) {
      setRange(null)
      setRangeError(null)
      setScreen('home')
      return
    }
    try {
      if (from) parseDay(from)
      if (to) parseDay(to)
    } catch (error) {
      setRangeError(error instanceof Error ? error.message : 'Not a day')
      return
    }
    if (from && to && dayStartMs(from) > dayStartMs(to)) {
      setRangeError('The start is after the end')
      return
    }
    setRange({ ...(from ? { from } : {}), ...(to ? { to } : {}) })
    setRangeError(null)
    setScreen('home')
  }

  const presetRange = (days: number): Range => {
    const to = new Date()
    const from = new Date(to.getFullYear(), to.getMonth(), to.getDate())
    from.setDate(from.getDate() - (days - 1))
    return { from: dayKey(from.getTime()), to: dayKey(to.getTime()) }
  }

  // Escape backs out one level before leaving, so a mis-click on a sub-screen
  // does not close the whole thing. At home it closes the report: the empty
  // ledger renders no Select, so without this there was no way out at all on a
  // machine that had not recorded a turn yet.
  //
  // The range screen owns the keyboard while it is up: it is a text field, not a
  // Select, so digits and dashes must reach it instead of being swallowed.
  useInput((input, key) => {
    if (screen === 'range') {
      if (key.escape) {
        setScreen('home')
        setRangeError(null)
        return
      }
      if (key.tab) {
        setRangeField(field => (field === 'from' ? 'to' : 'from'))
        return
      }
      if (key.return) {
        applyRange()
        return
      }
      if (key.backspace || key.delete) {
        setRangeDraft(draft => ({
          ...draft,
          [rangeField]: draft[rangeField].slice(0, -1),
        }))
        return
      }
      if (input && /^[0-9-]+$/.test(input)) {
        setRangeDraft(draft => ({
          ...draft,
          [rangeField]: (draft[rangeField] + input).slice(0, 10),
        }))
      }
      return
    }
    if (!key.escape) return
    if (screen !== 'home') {
      setScreen('home')
      return
    }
    onDone()
  })

  const width = Math.max(40, columns - 4)

  if (empty) {
    return (
      <Box flexDirection="column" paddingX={2}>
        <EmptyLedger directory={directory} />
        <Text dimColor>Esc closes this report.</Text>
      </Box>
    )
  }

  if (screen === 'models') {
    return (
      <Box flexDirection="column" paddingX={2}>
        <SummaryLine report={report} windowLabel={windowLabel} />
        <Text> </Text>
        <BarSection
          title="Tokens by model"
          groups={report.byModel}
          width={width}
          limit={15}
          detailOf={totals => `${tokens(totalTokens(totals))} · ${exact(totals.requests)} req · ${share(cachedShare(totals))} cached · ${money(totals.costUSD)}`}
        />
        <Text> </Text>
        <ExcludedNote report={report} />
        <Text dimColor>Esc returns to the menu.</Text>
      </Box>
    )
  }

  if (screen === 'sessions') {
    // The bar label carries the name and the short id; the Select value stays
    // the full id, because that is what the filter and --session accept.
    const groups = report.bySession.map(group => ({
      ...group,
      key: chatLabel(group.key, titles, 18),
    }))
    return (
      <Box flexDirection="column" paddingX={2}>
        <SummaryLine report={report} windowLabel={windowLabel} />
        <Text> </Text>
        <BarSection
          title="Tokens by chat"
          groups={groups}
          width={width}
          limit={20}
          detailOf={totals => `${tokens(totalTokens(totals))} · ${exact(totals.requests)} req · ${rate(averageTokPerSecond(totals))} · ${money(totals.costUSD)}`}
        />
        <Text> </Text>
        <Text dimColor>Enter on a chat filters the whole report to it.</Text>
        <Select
          options={[
            ...report.bySession.slice(0, 20).map(group => ({
              value: `filter:${group.key}`,
              label: `Filter to ${clip(chatName(group.key), 24)}`,
              description: `${tokens(totalTokens(group.totals))} tokens · ${exact(group.totals.requests)} requests`,
            })),
            ...(sessionPrefix
              ? [{ value: 'clear', label: 'Clear the chat filter', description: 'Show every chat again' }]
              : []),
            { value: 'back', label: 'Back', description: 'Return to the usage menu' },
          ]}
          visibleOptionCount={8}
          onCancel={() => setScreen('home')}
          onChange={(value: string) => {
            if (value === 'back') { setScreen('home'); return }
            if (value === 'clear') { setSessionPrefix(undefined); return }
            setSessionPrefix(value.slice('filter:'.length))
          }}
        />
        <Text> </Text>
        <ExcludedNote report={report} />
        <Text dimColor>Esc returns to the menu.</Text>
      </Box>
    )
  }

  if (screen === 'backends') {
    return (
      <Box flexDirection="column" paddingX={2}>
        <SummaryLine report={report} windowLabel={windowLabel} />
        <Text> </Text>
        <BarSection
          title="Tokens by upstream"
          groups={report.byBackend}
          width={width}
          limit={15}
          detailOf={totals => `${tokens(totalTokens(totals))} · ${exact(totals.requests)} req · ${exact(totals.sessions)} chats · ${money(totals.costUSD)}`}
        />
        <Text> </Text>
        <Text dimColor>Attribution comes from the Gateway catalog, so the two OpenCode providers are kept apart.</Text>
        <ExcludedNote report={report} />
        <Text dimColor>Esc returns to the menu.</Text>
      </Box>
    )
  }

  if (screen === 'trend') {
    return (
      <Box flexDirection="column" paddingX={2}>
        <SummaryLine report={report} windowLabel={windowLabel} />
        <Text> </Text>
        <TrendSection report={report} width={width} />
        <Text> </Text>
        <Text dimColor>Every point in the window is drawn, including ones with no usage.</Text>
        <Text dimColor>Esc returns to the menu.</Text>
      </Box>
    )
  }

  if (screen === 'composition') {
    return (
      <Box flexDirection="column" paddingX={2}>
        <SummaryLine report={report} windowLabel={windowLabel} />
        <Text> </Text>
        <CompositionSection report={report} width={width} />
        <Text> </Text>
        <ExcludedNote report={report} />
        <Text dimColor>Esc returns to the menu.</Text>
      </Box>
    )
  }

  if (screen === 'speed') {
    return (
      <Box flexDirection="column" paddingX={2}>
        <SummaryLine report={report} windowLabel={windowLabel} />
        <Text> </Text>
        <SpeedSection report={report} titles={titles} width={width} />
        <Text> </Text>
        <ExcludedNote report={report} />
        <Text dimColor>Esc returns to the menu.</Text>
      </Box>
    )
  }

  if (screen === 'range') {
    const field = (name: 'from' | 'to', label: string): React.ReactNode => (
      <Text>
        <Text bold>{`${label}  `}</Text>
        <Text color={rangeField === name ? 'suggestion' : undefined}>
          {rangeDraft[name] || 'YYYY-MM-DD'}
        </Text>
        {rangeField === name ? <Text color="suggestion">▏</Text> : null}
      </Text>
    )
    return (
      <Box flexDirection="column" paddingX={2}>
        <Text bold>Custom range</Text>
        <Text dimColor>
          Local days, inclusive. Leave one side empty for "since" or "up to".
        </Text>
        <Text> </Text>
        {field('from', 'From')}
        {field('to', 'To')}
        <Text> </Text>
        {rangeError ? (
          <Text color="error">{rangeError}</Text>
        ) : (
          <Text dimColor>Tab switches field · Enter applies · Esc cancels</Text>
        )}
        <Text> </Text>
        <Text dimColor>
          {`Example: 2026-10-01 → 2026-10-31, or just a start. Today is ${dayKey(Date.now())}.`}
        </Text>
      </Box>
    )
  }

  const topModel = report.byModel[0]
  const options: Array<{ value: string; label: string; description?: string }> = [
    ...PERIODS.map<{ value: string; label: string; description: string }>(value => ({
      value: `period:${value}`,
      label: `${value === period && !range ? '● ' : '○ '}${PERIOD_LABEL[value]}`,
      description:
        value === period && !range ? 'Currently shown' : 'Switch the window',
    })),
    { value: 'screen:trend', label: 'Trend over time', description: 'Tokens and throughput across the selected window' },
    { value: 'screen:speed', label: 'Throughput (tok/s)', description: 'Measured output speed, slowest responses first' },
    { value: 'screen:range', label: range ? `Custom range: ${windowLabel}` : 'Custom range…', description: 'Type any two dates' },
    { value: 'screen:sessions', label: 'Tokens by chat', description: 'Every recorded session, heaviest first' },
    { value: 'screen:models', label: 'Tokens by model', description: 'Which models your usage goes to' },
    { value: 'screen:backends', label: 'Tokens by upstream', description: 'Codex, DeepSeek, OpenCode, Command Code, or direct' },
    { value: 'screen:composition', label: 'Where the tokens went', description: 'Input vs output vs cache, and cost per request' },
    { value: 'preset:7', label: 'Last 7 days', description: 'A quick custom window' },
    { value: 'preset:30', label: 'Last 30 days', description: 'A quick custom window' },
    { value: 'preset:90', label: 'Last 90 days', description: 'A quick custom window' },
    ...(range
      ? [{ value: 'range:clear', label: 'Clear the custom range', description: 'Go back to a calendar period' }]
      : []),
    { value: 'exit', label: 'Close', description: 'Leave the usage report' },
  ]

  return (
    <Box flexDirection="column" paddingX={2}>
      <SummaryLine report={report} windowLabel={windowLabel} />
      <Text> </Text>
      <Text dimColor>
        {topModel
          ? `Heaviest model: ${topModel.key} at ${tokens(totalTokens(topModel.totals))} tokens (${exact(topModel.totals.requests)} requests).`
          : 'Nothing recorded in this window.'}
      </Text>
      <Text dimColor>{`Ledger: ${directory}`}</Text>
      {sessionPrefix ? <Text>{`Filtered to chat ${chatName(sessionPrefix)}`}</Text> : null}
      <Text> </Text>
      <Select
        options={options}
        visibleOptionCount={14}
        onChange={(value: string) => {
          if (value === 'exit') { onDone(); return }
          if (value.startsWith('period:')) {
            const next = value.slice('period:'.length) as UsagePeriod
            // A period is a window of its own; leaving a custom range in place
            // would keep overriding the choice the user just made.
            if (PERIODS.includes(next)) { setRange(null); setPeriod(next) }
            return
          }
          if (value.startsWith('preset:')) {
            setRange(presetRange(Number(value.slice('preset:'.length))))
            return
          }
          if (value === 'range:clear') { setRange(null); return }
          if (value === 'screen:range') {
            setRangeDraft({ from: range?.from ?? '', to: range?.to ?? '' })
            setRangeField('from')
            setRangeError(null)
            setScreen('range')
            return
          }
          setScreen(value.slice('screen:'.length) as Screen)
        }}
      />
      <Text> </Text>
      <Text dimColor>
        A chat started before midnight local counts in the day it ran. Weeks begin on Monday.
      </Text>
    </Box>
  )
}
