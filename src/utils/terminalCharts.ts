/**
 * Terminal chart primitives for the usage report.
 *
 * These return plain strings rather than JSX for two reasons: they can be tested
 * without a renderer, and a chart is easier to reason about as rows of
 * characters than as nested components. The caller decides colour; these
 * functions only decide layout, so the same bar can be dimmed, highlighted, or
 * measured in a test without changing.
 *
 * Every renderer answers for degenerate input - no data, one point, all-zero
 * values, a one-column terminal - because that is where terminal charts usually
 * break rather than where they usually get used.
 */

/** Eight-step vertical ramp, low to high. */
export const SPARK_CHARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const

/** Partial blocks, so a bar can end mid-cell instead of rounding away. */
const PARTIALS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'] as const

export interface BarRow {
  label: string
  value: number
  /** Optional second series stacked on the same bar, e.g. cache beside input. */
  secondary?: number
  detail?: string
}

/**
 * One laid-out bar row, split into spans.
 *
 * Structure rather than a pre-joined string, because the caller colours each
 * span differently and a renderer that returned one string would force it to
 * re-parse its own output. `barsToLines` does the joining for tests and for any
 * caller that wants plain text.
 */
export interface BarLayout {
  label: string
  /** The main series, filled blocks. */
  primary: string
  /** The second series, stacked on top of the first. */
  secondary: string
  /** Trailing padding out to the bar width, so columns line up. */
  pad: string
  detail: string
}

/**
 * Horizontal bars scaled against the largest value in the set.
 *
 * Scaling is relative, not absolute: the point is comparing models or sessions
 * against each other, and a fixed scale would draw every bar empty in a quiet
 * week and every bar full in a busy one.
 */
export function renderBars(
  rows: readonly BarRow[],
  width: number,
  options: { labelWidth?: number } = {},
): BarLayout[] {
  if (rows.length === 0) return []
  const labelWidth =
    options.labelWidth ??
    Math.min(28, Math.max(...rows.map(row => row.label.length)))
  // The bar takes what is left after the label, a two-space gutter on each side
  // of it, and the widest detail. Reserving the detail column is what keeps a
  // row inside `width`: without it the numbers run past the terminal and wrap,
  // which silently breaks the one thing a tabular report is for.
  const detailWidth = Math.max(0, ...rows.map(row => (row.detail ?? '').length))
  const barWidth = Math.max(1, width - labelWidth - 4 - detailWidth)
  const max = Math.max(...rows.map(row => row.value + (row.secondary ?? 0)))

  return rows.map(row => {
    const label = clip(row.label, labelWidth).padEnd(labelWidth)
    const detail = row.detail ?? ''
    if (max <= 0) {
      return { label, primary: '', secondary: '', pad: ' '.repeat(barWidth), detail }
    }

    const total = row.value + (row.secondary ?? 0)
    const exact = (total / max) * barWidth
    const whole = Math.min(barWidth, Math.floor(exact))
    const partial = whole < barWidth
      ? PARTIALS[Math.min(PARTIALS.length - 1, Math.floor((exact - whole) * PARTIALS.length))] ?? ''
      : ''
    const filled = '█'.repeat(whole) + partial

    // A single-series bar is entirely primary; a stacked one is split at the
    // primary series, which may round to zero cells and is then simply absent
    // rather than drawn as a stray block.
    const primaryCells = row.secondary
      ? Math.min(filled.length, Math.max(0, Math.round((row.value / total) * filled.length)))
      : filled.length
    const primary = filled.slice(0, primaryCells)
    const secondary = filled.slice(primaryCells)
    return {
      label,
      primary,
      secondary,
      pad: ' '.repeat(Math.max(0, barWidth - filled.length)),
      detail,
    }
  })
}

/** Joins laid-out bars into text lines, for tests and plain output. */
export function barsToLines(bars: readonly BarLayout[]): string[] {
  return bars.map(bar =>
    [
      bar.label,
      '  ',
      bar.primary,
      bar.secondary,
      bar.pad,
      bar.detail ? `  ${bar.detail}` : '',
    ].join('').trimEnd(),
  )
}

/** Convenience: bars laid out and joined in one call. */
export function renderBarLines(
  rows: readonly BarRow[],
  width: number,
  options: { labelWidth?: number } = {},
): string[] {
  return barsToLines(renderBars(rows, width, options))
}

/** A single row of sparkline characters, one per value. */
export function sparkline(values: readonly number[], max = 0): string {
  if (values.length === 0) return ''
  const peak = max > 0 ? max : Math.max(...values)
  if (peak <= 0) return SPARK_CHARS[0]!.repeat(values.length)
  return values
    .map(value => {
      if (value <= 0) return SPARK_CHARS[0]!
      const index = Math.min(
        SPARK_CHARS.length - 1,
        Math.max(0, Math.ceil((value / peak) * SPARK_CHARS.length) - 1),
      )
      return SPARK_CHARS[index]!
    })
    .join('')
}

/**
 * Vertical columns, one per bucket, with a shared scale.
 *
 * Height is capped by `height`; a bucket taller than the cap is drawn full and
 * its exact value rides in the axis line, so a clipped column is never mistaken
 * for a measured one.
 */
export function renderColumns(
  values: readonly number[],
  height: number,
  columnWidth = 1,
): string[] {
  if (values.length === 0) return []
  const peak = Math.max(...values)
  const rows: string[] = []
  for (let level = height; level >= 1; level--) {
    let line = ''
    for (const value of values) {
      const filled = peak > 0 ? Math.ceil((value / peak) * height) : 0
      const on = filled >= level
      line += (on ? '█' : ' ').repeat(columnWidth)
    }
    rows.push(line)
  }
  return rows
}

/**
 * Tick labels along a column chart. `every` thins them so labels do not collide
 * on a narrow terminal; the last bucket is always labelled, so the reader can
 * always see where the series ends.
 *
 * `cellWidth` must be at least the label length, or a date is clipped down to
 * its first character and the axis reads as a row of identical stubs - which is
 * worse than no axis, because it looks like data.
 */
export function renderAxis(labels: readonly string[], every = 1, cellWidth = 3): string {
  if (labels.length === 0) return ''
  const step = Math.max(1, every)
  const width = Math.max(2, cellWidth)
  const cells = labels.map((label, index) => {
    if (index % step !== 0 && index !== labels.length - 1) return ' '.repeat(width)
    return clip(label, width - 1).padEnd(width)
  })
  return cells.join('').trimEnd()
}

/** Chooses a tick interval that keeps labels from overlapping at this width. */
export function axisInterval(count: number, cellWidth: number, width: number): number {
  if (count <= 1) return 1
  const perLabel = Math.max(1, cellWidth)
  const fit = Math.max(1, Math.floor(width / perLabel))
  if (count <= fit) return 1
  return Math.ceil(count / fit)
}

/**
 * Percentage split bar with a legend, for composition questions ("how much of
 * this model's volume is cache re-reads").
 */
export function renderShare(
  parts: ReadonlyArray<{ label: string; value: number }>,
  width: number,
): { bar: string; legend: string } {
  const total = parts.reduce((sum, part) => sum + Math.max(0, part.value), 0)
  if (total <= 0) {
    return { bar: '░'.repeat(Math.max(1, width)), legend: 'no tokens recorded' }
  }
  const glyphs = ['█', '▓', '▒', '░']
  let bar = ''
  let used = 0
  const legend: string[] = []
  parts.forEach((part, index) => {
    const share = Math.max(0, part.value) / total
    const cells = index === parts.length - 1
      ? Math.max(0, width - used)
      : Math.round(share * width)
    used += cells
    bar += (glyphs[index] ?? '░').repeat(cells)
    legend.push(`${glyphs[index] ?? '░'} ${part.label} ${(share * 100).toFixed(1)}%`)
  })
  return { bar, legend: legend.join('   ') }
}

/** Clips to a width, marking truncation so a clipped label is not read as full. */
export function clip(value: string, width: number): string {
  if (width <= 0) return ''
  if (value.length <= width) return value
  if (width === 1) return '…'
  return `${value.slice(0, width - 1)}…`
}
