import React, { useMemo, useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
import { Select } from './CustomSelect/select.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { useRegisterOverlay } from '../context/overlayContext.js'
import {
  buildUsageReport,
  cachedShare,
  dailyPoints,
  readTokenLedger,
  totalTokens,
  type UsagePeriod,
  type UsageReport,
  type UsageTotals,
} from '../utils/tokenUsageReport.js'
import {
  axisInterval,
  clip,
  renderBars,
  renderAxis,
  renderColumns,
  renderShare,
  sparkline,
} from '../utils/terminalCharts.js'
import { tokenLedgerDirectory, type TokenLedgerRow } from '../utils/tokenLedger.js'

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

type Screen = 'home' | 'models' | 'sessions' | 'backends' | 'trend' | 'composition'

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

/** A one-line summary used at the top of every screen so the window is never implied. */
function SummaryLine({ report, period }: { report: UsageReport; period: UsagePeriod }): React.ReactNode {
  const totals = report.totals
  return (
    <Box flexDirection="column">
      <Text bold>{`Usage — ${PERIOD_LABEL[period]}`}</Text>
      <Text dimColor>
        {`${exact(totals.requests)} requests · ${tokens(totalTokens(totals))} tokens · ${exact(totals.sessions)} chat${totals.sessions === 1 ? '' : 's'} · ${money(totals.costUSD)}`}
      </Text>
      <Text dimColor>
        {`in ${tokens(totals.input)} · out ${tokens(totals.output)} · cache read ${tokens(totals.cacheRead)} · cache write ${tokens(totals.cacheWrite)} · ${share(cachedShare(totals))} cached`}
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
 * Daily token columns with a date axis under them.
 *
 * The columns are as wide as the labels need, because an axis that does not sit
 * under its columns is decoration, and a fixed three-cell axis clipped every
 * date to its first character - a row of identical stubs that reads as data.
 * When the terminal is too narrow for both, the columns keep the full value and
 * the axis is replaced by an explicit range rather than by clipped labels.
 */
function TrendSection({ rows, width }: { rows: readonly TokenLedgerRow[]; width: number }): React.ReactNode {
  const points = useMemo(() => dailyPoints(rows, 30), [rows])
  const values = points.map(point => totalTokens(point.totals))
  const peak = Math.max(0, ...values)
  const height = 8
  const columnWidth = Math.max(1, Math.min(3, Math.floor(width / Math.max(1, points.length))))
  const labelled = columnWidth >= 3
  const columns = renderColumns(values, height, columnWidth)
  const cellWidth = columnWidth
  const interval = axisInterval(points.length, cellWidth, width)
  // Day of month: two characters fit the column, and the month boundary is named
  // in the peak line, which carries the full date.
  const labels = points.map(point => point.date.slice(8))

  if (peak === 0) {
    return (
      <Box flexDirection="column">
        <Text bold>Last 30 days</Text>
        <Text dimColor>No tokens recorded in the last 30 days.</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Text bold>Last 30 days</Text>
      <Text dimColor>{`peak ${tokens(peak)} tokens on ${points[values.indexOf(peak)]!.date}`}</Text>
      {columns.map((line, index) => (
        <Text key={index} color="success">
          {line}
        </Text>
      ))}
      <Text dimColor>
        {labelled
          ? renderAxis(labels, interval, cellWidth)
          : `${points[0]!.date} … ${points.at(-1)!.date}`}
      </Text>
      <Text dimColor>{sparkline(values)}</Text>
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
      <Text dimColor>
        {`Cost ${money(totals.costUSD)} over ${exact(totals.requests)} requests · ${totals.costUSD > 0 ? `$${(totals.costUSD / Math.max(1, totals.requests)).toFixed(4)} per request` : 'no cost reported'}`}
      </Text>
      <Text dimColor>
        Lifetime to date: {tokens(totalTokens(report.lifetime))} tokens across {exact(report.lifetime.requests)} requests, {exact(report.lifetime.sessions)} chats.
      </Text>
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

  const directory = tokenLedgerDirectory()
  // Read once per mount: the ledger is append-only, and re-reading it on every
  // period switch would be disk work for a change that only re-filters in memory.
  const ledger = useMemo(() => readTokenLedger(), [])
  const report = useMemo(
    () => buildUsageReport({ period, sessionPrefix, rows: ledger.rows, malformed: ledger.malformed }),
    [period, sessionPrefix, ledger],
  )
  const empty = report.lifetime.requests === 0 && report.excluded.replay === 0

  // Escape backs out one level before leaving, so a mis-click on a sub-screen
  // does not close the whole thing. At home it closes the report: the empty
  // ledger renders no Select, so without this there was no way out at all on a
  // machine that had not recorded a turn yet.
  useInput((_input, key) => {
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
        <SummaryLine report={report} period={period} />
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
    const labelWidth = 12
    const groups = report.bySession.map(group => ({
      ...group,
      key: clip(group.key, labelWidth),
    }))
    return (
      <Box flexDirection="column" paddingX={2}>
        <SummaryLine report={report} period={period} />
        <Text> </Text>
        <BarSection
          title="Tokens by chat"
          groups={groups}
          width={width}
          limit={20}
          detailOf={totals => `${tokens(totalTokens(totals))} · ${exact(totals.requests)} req · ${money(totals.costUSD)}`}
        />
        <Text> </Text>
        <Text dimColor>Enter on a chat filters the whole report to it.</Text>
        <Select
          options={[
            ...report.bySession.slice(0, 20).map(group => ({
              value: `filter:${group.key}`,
              label: `Filter to ${clip(group.key, 20)}`,
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
        <SummaryLine report={report} period={period} />
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
        <SummaryLine report={report} period={period} />
        <Text> </Text>
        <TrendSection rows={ledger.rows} width={width} />
        <Text> </Text>
        <Text dimColor>Every day in the range is drawn, including days with no usage.</Text>
        <Text dimColor>Esc returns to the menu.</Text>
      </Box>
    )
  }

  if (screen === 'composition') {
    return (
      <Box flexDirection="column" paddingX={2}>
        <SummaryLine report={report} period={period} />
        <Text> </Text>
        <CompositionSection report={report} width={width} />
        <Text> </Text>
        <ExcludedNote report={report} />
        <Text dimColor>Esc returns to the menu.</Text>
      </Box>
    )
  }

  const topModel = report.byModel[0]
  const options: Array<{ value: string; label: string; description?: string }> = [
    ...PERIODS.map<{ value: string; label: string; description: string }>(value => ({
      value: `period:${value}`,
      label: `${value === period ? '● ' : '○ '}${PERIOD_LABEL[value]}`,
      description: value === period ? 'Currently shown' : 'Switch the window',
    })),
    { value: 'screen:trend', label: 'Trend over time', description: 'Daily tokens for the last 30 days' },
    { value: 'screen:models', label: 'Tokens by model', description: 'Which models your usage goes to' },
    { value: 'screen:backends', label: 'Tokens by upstream', description: 'Codex, DeepSeek, OpenCode, Command Code, or direct' },
    { value: 'screen:sessions', label: 'Tokens by chat', description: 'Every recorded session, heaviest first' },
    { value: 'screen:composition', label: 'Where the tokens went', description: 'Input vs output vs cache, and cost per request' },
    { value: 'exit', label: 'Close', description: 'Leave the usage report' },
  ]

  return (
    <Box flexDirection="column" paddingX={2}>
      <SummaryLine report={report} period={period} />
      <Text> </Text>
      <Text dimColor>
        {topModel
          ? `Heaviest model: ${topModel.key} at ${tokens(totalTokens(topModel.totals))} tokens (${exact(topModel.totals.requests)} requests).`
          : 'Nothing recorded in this window.'}
      </Text>
      <Text dimColor>{`Ledger: ${directory}`}</Text>
      {sessionPrefix ? <Text>{`Filtered to chat ${sessionPrefix}`}</Text> : null}
      <Text> </Text>
      <Select
        options={options}
        visibleOptionCount={12}
        onChange={(value: string) => {
          if (value === 'exit') { onDone(); return }
          if (value.startsWith('period:')) {
            const next = value.slice('period:'.length) as UsagePeriod
            if (PERIODS.includes(next)) setPeriod(next)
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
