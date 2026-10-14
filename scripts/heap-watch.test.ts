import { test, expect, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as unknown as { MACRO: unknown }).MACRO = {
  VERSION: 'test',
  BUILD_TIME: 'test',
}

const { startHeapWatch } = await import('../src/utils/heapDumpService.js')

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'heap-watch-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  delete process.env.GATEWAY_HEAP_WATCH
  delete process.env.GATEWAY_HEAP_WATCH_DIR
  delete process.env.GATEWAY_HEAP_WATCH_MB
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/**
 * The watchdog is opt-in and its whole point is a heap snapshot written while a
 * session is leaking. Neither half has ever been observed: the /heapdump command
 * is the only caller of the snapshot writer, and the growth-triggered path was
 * dead code. These tests arm it directly and check what lands on disk.
 */
test('does nothing unless GATEWAY_HEAP_WATCH is set', () => {
  const dir = tmp()
  process.env.GATEWAY_HEAP_WATCH_DIR = dir
  startHeapWatch()
  expect(readdirSync(dir)).toEqual([])
})

test('writes a series and a snapshot when heapUsed crosses a threshold', () => {
  const dir = tmp()
  process.env.GATEWAY_HEAP_WATCH = '1'
  process.env.GATEWAY_HEAP_WATCH_DIR = dir
  // 1MB is crossed on the very first sample in any real process, so the
  // snapshot path runs without waiting on the interval.
  process.env.GATEWAY_HEAP_WATCH_MB = '1'

  startHeapWatch()

  const series = readdirSync(dir).find(f => f.endsWith('.jsonl'))
  expect(series).toBeDefined()
  const line = readFileSync(join(dir, series as string), 'utf8').trim().split('\n')[0]
  const row = JSON.parse(line) as { heapMb: number; rssMb: number }
  expect(row.heapMb).toBeGreaterThan(0)
  expect(row.rssMb).toBeGreaterThan(0)

  // writeHeapSnapshot is synchronous under Bun, so the file is on disk already.
  expect(existsSync(join(dir, `${series?.replace('.jsonl', '')}-1.heapsnapshot`))).toBe(
    true,
  )
})
