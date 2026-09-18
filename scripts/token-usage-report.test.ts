import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  buildUsageReport,
  cachedShare,
  dailyPoints,
  periodStart,
  readTokenLedger,
  totalTokens,
} from '../src/utils/tokenUsageReport.ts'
import {
  axisInterval,
  clip,
  renderBarLines,
  renderBars,
  renderColumns,
  renderShare,
  renderAxis,
  sparkline,
} from '../src/utils/terminalCharts.ts'
import {
  UsageArgumentError,
  parseUsageArgs,
  renderUsageText,
} from '../src/utils/tokenUsageText.ts'

type LedgerRow = {
  at: string
  session: string
  model: string
  backend: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  costUSD: number
  src?: string
}

function row(overrides: Partial<LedgerRow> = {}): LedgerRow {
  return {
    at: '2026-09-18T12:00:00.000Z',
    session: 'session-a',
    model: 'gateway-gpt-sol',
    backend: 'codex',
    input: 100,
    output: 10,
    cacheRead: 0,
    cacheWrite: 0,
    costUSD: 0.01,
    ...overrides,
  }
}

async function withLedger(
  rows: readonly unknown[],
  body: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'usage-report-'))
  try {
    await writeFile(
      join(dir, 'tokens.jsonl'),
      `${rows.map(item => JSON.stringify(item)).join('\n')}\n`,
    )
    await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('the report totals every field the ledger recorded', async () => {
  await withLedger(
    [
      row({ input: 100, output: 10, cacheRead: 1000, cacheWrite: 5, costUSD: 0.5 }),
      row({ input: 200, output: 20, cacheRead: 2000, cacheWrite: 7, costUSD: 1.5 }),
    ],
    async dir => {
      const report = buildUsageReport({ directory: dir })
      assert.equal(report.totals.requests, 2)
      assert.equal(report.totals.input, 300)
      assert.equal(report.totals.output, 30)
      assert.equal(report.totals.cacheRead, 3000)
      assert.equal(report.totals.cacheWrite, 12)
      assert.equal(Math.round(report.totals.costUSD * 100) / 100, 2)
      assert.equal(totalTokens(report.totals), 3342)
    },
  )
})

test('sessions inside a group are counted distinctly, not per row', async () => {
  await withLedger(
    [
      row({ session: 'a', model: 'm1' }),
      row({ session: 'a', model: 'm1' }),
      row({ session: 'b', model: 'm1' }),
      row({ session: 'c', model: 'm2' }),
    ],
    async dir => {
      const report = buildUsageReport({ directory: dir })
      assert.equal(report.totals.sessions, 3)
      const m1 = report.byModel.find(group => group.key === 'm1')
      assert.equal(m1?.totals.requests, 3)
      assert.equal(m1?.totals.sessions, 2, 'm1 was used by two distinct sessions')
    },
  )
})

test('groups are ordered by token volume, largest first', async () => {
  await withLedger(
    [
      row({ model: 'small', input: 10 }),
      row({ model: 'large', input: 9000 }),
      row({ model: 'medium', input: 500 }),
    ],
    async dir => {
      const report = buildUsageReport({ directory: dir })
      assert.deepEqual(
        report.byModel.map(group => group.key),
        ['large', 'medium', 'small'],
      )
    },
  )
})

test('replayed fixture rows are excluded and counted, never silently dropped', async () => {
  await withLedger(
    [row({ input: 100 }), row({ input: 999_999, src: 'replay' })],
    async dir => {
      const report = buildUsageReport({ directory: dir })
      assert.equal(report.totals.input, 100)
      assert.equal(report.excluded.replay, 1)

      const included = buildUsageReport({ directory: dir, includeReplay: true })
      assert.equal(included.totals.input, 999_999 + 100)
      assert.equal(included.excluded.replay, 0)
    },
  )
})

test('a period counts only its own window and says how much it set aside', async () => {
  const now = new Date(2026, 8, 18, 12, 0, 0) // Friday 18 Sep 2026, local
  await withLedger(
    [
      row({ at: new Date(2026, 8, 18, 9, 0, 0).toISOString(), input: 10 }), // today
      row({ at: new Date(2026, 8, 17, 9, 0, 0).toISOString(), input: 20 }), // yesterday, this week
      row({ at: new Date(2026, 8, 14, 9, 0, 0).toISOString(), input: 40 }), // Monday, this week
      row({ at: new Date(2026, 8, 13, 9, 0, 0).toISOString(), input: 80 }), // Sunday, last week
      row({ at: new Date(2026, 7, 20, 9, 0, 0).toISOString(), input: 160 }), // last month
    ],
    async dir => {
      const today = buildUsageReport({ directory: dir, period: 'today', now })
      assert.equal(today.totals.input, 10)
      assert.equal(today.excluded.otherPeriod, 4)

      const week = buildUsageReport({ directory: dir, period: 'week', now })
      assert.equal(week.totals.input, 70, 'Monday and later belongs to this week')

      const month = buildUsageReport({ directory: dir, period: 'month', now })
      assert.equal(month.totals.input, 150)

      const all = buildUsageReport({ directory: dir, period: 'all', now })
      assert.equal(all.totals.input, 310)
      assert.equal(all.excluded.otherPeriod, 0)
    },
  )
})

test('weeks start on Monday, so a weekend is not split off from its week', () => {
  const friday = new Date(2026, 8, 18, 12, 0, 0)
  const monday = periodStart('week', friday)
  assert.ok(monday !== null)
  const start = new Date(monday)
  assert.equal(start.getDay(), 1, 'week starts on Monday')
  assert.equal(start.getDate(), 14)

  const sunday = new Date(2026, 8, 20, 23, 0, 0)
  const sundayStart = new Date(periodStart('week', sunday)!)
  assert.equal(sundayStart.getDate(), 14, 'Sunday still belongs to the week that began Monday')
})

test('session, model and backend filters each narrow the report', async () => {
  await withLedger(
    [
      row({ session: 'alpha-1', model: 'gateway-gpt-sol', backend: 'codex', input: 10 }),
      row({ session: 'beta-1', model: 'gateway-ds-pro', backend: 'deepseek', input: 20 }),
    ],
    async dir => {
      const bySession = buildUsageReport({ directory: dir, sessionPrefix: 'alpha' })
      assert.equal(bySession.totals.input, 10)

      const byModel = buildUsageReport({ directory: dir, model: 'DS-PRO' })
      assert.equal(byModel.totals.input, 20, 'model matching is case-insensitive')

      const byBackend = buildUsageReport({ directory: dir, backend: 'codex' })
      assert.equal(byBackend.totals.input, 10)
    },
  )
})

test('lifetime totals ignore the period window', async () => {
  const now = new Date(2026, 8, 18, 12, 0, 0)
  await withLedger(
    [
      row({ at: new Date(2026, 8, 18, 9, 0, 0).toISOString(), input: 10 }),
      row({ at: new Date(2026, 0, 5, 9, 0, 0).toISOString(), input: 5000 }),
    ],
    async dir => {
      const report = buildUsageReport({ directory: dir, period: 'today', now })
      assert.equal(report.totals.input, 10)
      assert.equal(report.lifetime.input, 5010, 'lifetime is not windowed')
    },
  )
})

test('malformed and undated lines are quarantined, not guessed at', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-report-bad-'))
  try {
    await writeFile(
      join(dir, 'tokens.jsonl'),
      [
        JSON.stringify(row({ input: 42 })),
        'not json at all',
        JSON.stringify({ ...row(), at: 'not-a-date', input: 999 }),
      ].join('\n') + '\n',
    )
    const read = readTokenLedger(dir)
    assert.equal(read.rows.length, 2, 'the unparseable line is not a row')
    assert.equal(read.malformed, 1)

    const report = buildUsageReport({ directory: dir })
    assert.equal(report.totals.input, 42)
    assert.equal(report.excluded.undated, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a missing ledger is an empty report, not an error', async () => {
  const report = buildUsageReport({ directory: join(tmpdir(), 'nope-does-not-exist') })
  assert.equal(report.totals.requests, 0)
  assert.equal(report.window.from, null)
  assert.deepEqual(report.byModel, [])
})

test('daily points are contiguous, so a gap means nobody spent anything', () => {
  const now = new Date(2026, 8, 18, 12, 0, 0)
  const rows = [
    {
      ...row({ at: new Date(2026, 8, 18, 9, 0, 0).toISOString(), input: 5 }),
      v: 1 as const,
      cwd: '',
      backend: 'codex' as const,
    },
    {
      ...row({ at: new Date(2026, 8, 15, 9, 0, 0).toISOString(), input: 7 }),
      v: 1 as const,
      cwd: '',
      backend: 'codex' as const,
    },
  ]
  const points = dailyPoints(rows, 7, now)
  assert.equal(points.length, 7)
  assert.equal(points.at(-1)!.date, '2026-09-18')
  assert.equal(points.at(-1)!.totals.input, 5)
  assert.equal(points[3]!.date, '2026-09-15')
  assert.equal(points[3]!.totals.input, 7)
  // The days between the two real rows exist and are zero.
  assert.equal(points[4]!.totals.input, 0)
  assert.equal(points[5]!.totals.input, 0)
})

test('cached share reports cache re-reads as part of the volume', () => {
  assert.equal(cachedShare({ ...empty(), input: 100, cacheRead: 900 }), 0.9)
  assert.equal(cachedShare({ ...empty(), input: 0 }), null, 'no tokens means no share, not zero percent')
})

function empty() {
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

test('bars scale to the largest row, relative to the space available', () => {
  // width 40, label 6, a two-space gutter on each side => 30 cells of bar.
  const bars = renderBarLines(
    [
      { label: 'big', value: 100 },
      { label: 'half', value: 50 },
      { label: 'none', value: 0 },
    ],
    40,
    { labelWidth: 6 },
  )
  assert.equal(bars.length, 3)
  assert.equal((bars[0]!.match(/█/g) ?? []).length, 30, 'the largest fills the bar')
  assert.equal(
    (bars[1]!.match(/█/g) ?? []).length,
    15,
    'half the value draws half the blocks',
  )
  assert.equal((bars[2]!.match(/█/g) ?? []).length, 0)
})

test('a row never exceeds the width it was laid out for', () => {
  const rows = [
    { label: 'a', value: 10, detail: 'short' },
    { label: 'b', value: 5, detail: 'a much longer detail column' },
  ]
  const lines = renderBarLines(rows, 60, { labelWidth: 8 })
  for (const line of lines) {
    assert.ok(line.length <= 60, `"${line}" is ${line.length} columns wide`)
  }
  // The bar shrinks to pay for the detail column, and every detail still begins
  // in the same column - the property a table reader actually relies on.
  assert.equal(lines[0]!.indexOf('short'), lines[1]!.indexOf('a much longer'))
})

test('a stacked bar splits primary and secondary without losing cells', () => {
  const [bar] = renderBars(
    [{ label: 'x', value: 25, secondary: 75 }],
    24,
    { labelWidth: 1 },
  )
  assert.ok(bar)
  assert.equal(bar.primary.length + bar.secondary.length + bar.pad.length, 19)
  assert.ok(bar.primary.length > 0 && bar.secondary.length > 0)
  assert.ok(bar.secondary.length > bar.primary.length, 'the larger series gets more cells')
})

test('all-zero data draws an empty bar instead of dividing by zero', () => {
  const bars = renderBarLines([{ label: 'a', value: 0 }], 20, { labelWidth: 1 })
  assert.equal(bars.length, 1)
  assert.ok(!bars[0]!.includes('█'))
  assert.ok(!bars[0]!.includes('NaN'))
})

test('sparkline maps values onto the ramp and pads a flat series', () => {
  assert.equal(sparkline([0, 1, 2, 3, 4, 5, 6, 7]), '▁▂▃▄▅▆▇█')
  assert.equal(sparkline([0, 0, 0]), '▁▁▁')
  assert.equal(sparkline([]), '')
  assert.equal(sparkline([5], 10), '▄')
})

test('columns respect height and never overflow it', () => {
  const lines = renderColumns([4, 0, 8], 4)
  assert.equal(lines.length, 4)
  assert.equal(lines[0], '  █', 'only the tallest column reaches the top row')
  assert.equal(lines[3], '█ █', 'a half-height column is still present at the bottom')
  assert.equal(renderColumns([0, 0, 0], 3).join(''), ' '.repeat(9), 'an all-zero series draws nothing')
  assert.equal(renderColumns([], 4).length, 0)
})

test('share bars add up to the requested width', () => {
  const { bar, legend } = renderShare(
    [
      { label: 'input', value: 1 },
      { label: 'cache read', value: 3 },
    ],
    20,
  )
  assert.equal(bar.length, 20)
  assert.ok(legend.includes('75.0%'))

  const empty = renderShare([{ label: 'input', value: 0 }], 10)
  assert.equal(empty.bar.length, 10)
  assert.equal(empty.legend, 'no tokens recorded')
})

test('labels clip with a marker so a shortened name is visible as shortened', () => {
  assert.equal(clip('gateway-opencode-deepseek', 8), 'gateway…')
  assert.equal(clip('short', 10), 'short')
  assert.equal(clip('short', 0), '')
})

test('the axis thins ticks as the width shrinks', () => {
  assert.equal(axisInterval(5, 1, 80), 1, 'few buckets need no thinning')
  assert.ok(axisInterval(60, 1, 40) > 1, 'many buckets must thin')
})

test('the axis is sized to its labels, so a date is not clipped to a stub', () => {
  // The regression: a fixed three-cell axis turned every date into "0…", a row
  // of identical stubs that reads as data rather than as labels.
  const axis = renderAxis(['13', '14', '15'], 1, 3)
  assert.equal(axis, '13 14 15')
  assert.ok(!renderAxis(['2026-09-13'], 1, 11).includes('…'))
  assert.ok(renderAxis(['2026-09-13'], 1, 11).includes('2026-09-13'))
  // Skipped cells still occupy the label's width, so thinning keeps alignment,
  // and the final bucket is named even when thinning would have skipped it.
  assert.equal(renderAxis(['13', '14', '15', '16'], 2, 3), '13    15 16')
})

test('an unknown flag is refused instead of silently widening the report', () => {
  assert.throws(() => parseUsageArgs(['--sesion', 'abc']), UsageArgumentError)
  assert.throws(() => parseUsageArgs(['--nope']), UsageArgumentError)
  assert.throws(() => parseUsageArgs(['--period', 'fortnight']), UsageArgumentError)
  assert.throws(() => parseUsageArgs(['--top', '0']), UsageArgumentError)
  assert.throws(() => parseUsageArgs(['--dir']), UsageArgumentError)
  assert.throws(() => parseUsageArgs(['yesterday']), UsageArgumentError)
})

test('the flags the two surfaces share parse identically', () => {
  const options = parseUsageArgs(['week', '--backend', 'Codex', '--top', '5', '--json'])
  assert.equal(options.period, 'week', 'a bare period word is a period, not an argument')
  assert.equal(options.backend, 'Codex')
  assert.equal(options.top, 5)
  assert.equal(options.format, 'json')

  // Removed flags keep failing loudly: a report of the wrong scope is the one
  // failure a usage report cannot afford to be quiet about.
  assert.throws(() => parseUsageArgs(['--since', '2026-09-01']), /--period/)
  assert.equal(parseUsageArgs(['--help']).help, true)
  assert.equal(parseUsageArgs([]).period, 'all')
})

test('the text report renders a window, totals and every section', async () => {
  await withLedger(
    [row({ model: 'gateway-gpt-sol', input: 100 }), row({ model: 'gateway-ds-pro', input: 50 })],
    async dir => {
      const text = renderUsageText({ directory: dir })
      for (const section of ['TOTAL', 'BY MODEL', 'BY CHAT', 'BY UPSTREAM']) {
        assert.ok(text.includes(section), `${section} is part of the report`)
      }
      assert.ok(text.includes('gateway-gpt-sol'))
      assert.ok(text.includes('150'), 'the totals line carries the summed input')
      assert.ok(text.endsWith('\n'), 'the report ends with a newline so a shell prompt does not run into it')

      const json = JSON.parse(renderUsageText({ directory: dir, format: 'json' }))
      assert.equal(json.totals.input, 150)
      assert.equal(json.period, 'all')
    },
  )
})

test('an empty ledger says so rather than printing an empty table', () => {
  const text = renderUsageText({ directory: join(tmpdir(), 'usage-report-empty-none') })
  assert.ok(text.includes('No usage recorded'))
})
