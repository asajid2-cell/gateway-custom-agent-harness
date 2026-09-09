import { describe, expect, test } from 'bun:test'
import { lineWidth } from '../src/ink/line-width-cache.ts'
import Output from '../src/ink/output.ts'
import { computeSliceStart, type SliceAnchor } from '../src/components/Messages.tsx'
import { CharPool, HyperlinkPool, StylePool, createScreen, cellAt, resetScreen } from '../src/ink/screen.ts'

function fixture() {
  const styles = new StylePool()
  const screen = createScreen(100, 2, styles, new CharPool(), new HyperlinkPool())
  const output = new Output({ width: 100, height: 2, stylePool: styles, screen })
  return { output, screen }
}

function cacheWeight(output: Output) {
  // Inspect retained data, not RSS: allocator/GC timing must not decide correctness.
  const cache = (output as unknown as { charCache: Iterable<[string, unknown[]]> }).charCache
  let weight = 0
  for (const [line, characters] of cache) weight += line.length + characters.length
  return weight
}

describe('inline message rendering budget', () => {
  test('long messages evict mounted history before the count cap', () => {
    const messages = Array.from({ length: 60 }, (_, i) => ({ uuid: String(i) }))
    const anchor = { current: null as SliceAnchor }
    expect(computeSliceStart(messages, anchor, 200, 50, () => 1200)).toBe(59)
    expect(messages).toHaveLength(60)
  })

  test('text window advances in batches and never loses the newest message', () => {
    const messages = Array.from({ length: 10 }, (_, i) => ({ uuid: String(i) }))
    const anchor = { current: null as SliceAnchor }
    expect(computeSliceStart(messages, anchor, 200, 50, () => 200)).toBe(0)
    messages.push({ uuid: '10' })
    expect(computeSliceStart(messages, anchor, 200, 50, () => 200)).toBe(0)
    messages.push({ uuid: '11' }, { uuid: '12' })
    expect(computeSliceStart(messages, anchor, 200, 50, () => 200)).toBe(3)
    expect(computeSliceStart(messages, anchor, 200, 50, () => 200)).toBe(3)
    expect(computeSliceStart(messages, anchor, 200, 50, () => 10000)).toBe(12)
  })

  test('legacy count cap and lost anchors remain stable', () => {
    const messages = Array.from({ length: 260 }, (_, i) => ({ uuid: String(i) }))
    const anchor = { current: null as SliceAnchor }
    expect(computeSliceStart(messages, anchor)).toBe(60)
    messages[60] = { uuid: 'replacement' }
    expect(computeSliceStart(messages, anchor)).toBe(60)
    expect(computeSliceStart([], anchor)).toBe(0)
    expect(anchor.current).toBeNull()
  })
})

describe('renderer screen allocation', () => {
  test('streaming growth amortizes buffer allocations', () => {
    const { screen } = fixture()
    let allocations = 0
    for (let height = 3; height <= 1000; height++) {
      const previous = screen.cells.buffer
      resetScreen(screen, 100, height)
      if (previous !== screen.cells.buffer) allocations++
      expect(screen.cells64.length).toBeGreaterThanOrEqual(100 * height)
    }
    expect(allocations).toBeLessThan(25)
  })

  test('small size oscillations reuse capacity and clear active cells', () => {
    const { output, screen } = fixture()
    output.reset(100, 100, screen)
    const buffer = screen.cells.buffer
    output.write(0, 0, 'visible')
    output.get()
    output.reset(100, 90, screen)
    expect(screen.cells.buffer).toBe(buffer)
    expect(cellAt(screen, 0, 0)?.char).toBe(' ')
    expect(cellAt(screen, 0, 90)).toBeUndefined()
    output.reset(100, 100, screen)
    expect(screen.cells.buffer).toBe(buffer)
    expect(cellAt(screen, 0, 99)?.char).toBe(' ')
  })

  test('large old screens are released after the content shrinks', () => {
    const { screen } = fixture()
    resetScreen(screen, 120, 20000)
    resetScreen(screen, 120, 40)
    expect(screen.cells64.byteLength + screen.noSelect.byteLength + screen.softWrap.byteLength).toBeLessThan(128 * 1024)
    expect(cellAt(screen, 0, 0)?.char).toBe(' ')
  })
})

describe('renderer character cache memory', () => {
  test('oversized lines render without being retained', () => {
    const { output, screen } = fixture()
    output.write(0, 0, 'z'.repeat(300 * 1024))
    output.get()
    expect(cellAt(screen, 99, 0)?.char).toBe('z')
    expect(cacheWeight(output)).toBe(0)
  })

  test('width caching preserves empty, styled, wide and oversized measurements', () => {
    for (let pass = 0; pass < 2; pass++) {
      expect(lineWidth('')).toBe(0)
      expect(lineWidth('\x1b[31mhello\x1b[0m')).toBe(5)
      expect(lineWidth('界')).toBe(2)
      expect(lineWidth('x'.repeat(300 * 1024))).toBe(300 * 1024)
    }
  })

  test('long changing lines have a retained-data budget, even within one frame', () => {
    const { output } = fixture()
    for (let i = 0; i < 256; i++) output.write(0, 0, `line ${i}: ${'x'.repeat(8192)}`)
    output.get()
    expect(cacheWeight(output)).toBeLessThanOrEqual(256 * 1024)
  })

  test('successive frames remain bounded and cache hits preserve output', () => {
    const { output, screen } = fixture()
    for (let i = 0; i < 400; i++) {
      output.reset(100, 2, screen)
      output.write(0, 0, `frame ${i}: ${'y'.repeat(1024)}`)
      output.get()
    }
    expect(cacheWeight(output)).toBeLessThanOrEqual(256 * 1024)
    output.reset(100, 2, screen)
    output.write(0, 0, '\x1b[31mA\x1b[0m\tB')
    output.get()
    expect(cellAt(screen, 0, 0)?.char).toBe('A')
    expect(cellAt(screen, 8, 0)?.char).toBe('B')
    const first = Array.from(screen.cells)
    output.reset(100, 2, screen)
    output.write(0, 0, '\x1b[31mA\x1b[0m\tB')
    output.get()
    expect(Array.from(screen.cells)).toEqual(first)
  })
})
