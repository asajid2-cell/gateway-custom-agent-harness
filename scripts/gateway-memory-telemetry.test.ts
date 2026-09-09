import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { memoryGauge, startGatewayMemoryTelemetry } from '../src/utils/gatewayMemoryTelemetry.ts'
import { notifyCommandLifecycle } from '../src/utils/commandLifecycle.ts'
import { lineWidth } from '../src/ink/line-width-cache.ts'

test('memory telemetry records numeric samples and counters without user content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'memory-telemetry-'))
  try {
    const close = await startGatewayMemoryTelemetry(root, 'fixture-build')
    assert.ok(close)
    memoryGauge('markdownEntries', 12)
    memoryGauge('markdownSourceChars', 345)
    notifyCommandLifecycle('SECRET_USER_CONTENT_MUST_NOT_APPEAR', 'started')
    notifyCommandLifecycle('SECRET_USER_CONTENT_MUST_NOT_APPEAR', 'completed')
    await close()
    await close()
    const names = await readdir(root)
    assert.equal(names.length, 1)
    const text = await readFile(join(root, names[0]!), 'utf8')
    assert.equal(text.includes('SECRET_USER_CONTENT'), false)
    const rows = text.trim().split('\n').map(line => JSON.parse(line))
    assert.equal(rows.length, 2)
    assert.deepEqual(rows.map(row => row.reason), ['startup', 'shutdown'])
    const row = rows[1]
    assert.equal(row.build, 'fixture-build')
    assert.equal(row.pid, process.pid)
    assert.deepEqual(row.activity, { commandStarted: 1, commandCompleted: 1, switches: 0, queryEntries: 0, replQueryEnds: 0, compactionChecks: 0, apiStarts: 0, apiEnds: 0, renders: 0 })
    assert.equal(row.caches.markdownSourceChars, 345)
    assert.ok(row.heap.heapSize > 0)
    assert.ok(row.memory.rss > 0)
    if (process.platform === 'win32') {
      assert.equal(row.osSample, 'ok')
      assert.ok(row.privateBytes > 0)
    }
    assert.deepEqual(Object.keys(row).sort(), ['schema', 'timestamp', 'pid', 'build', 'bun', 'mode', 'reason', 'sample', 'uptime', 'memory', 'heap', 'privateBytes', 'osSample', 'activity', 'caches'].sort())
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('line-width cache bounds long streaming revisions by retained source size', async () => {
  const root = await mkdtemp(join(tmpdir(), 'memory-width-cache-'))
  let close: (() => Promise<void>) | undefined
  try {
    close = await startGatewayMemoryTelemetry(root, 'fixture-build')
    assert.ok(close)
    for (let i = 0; i < 400; i++) lineWidth(`${i}:${'w'.repeat(8192)}`)
    lineWidth('x'.repeat(300 * 1024))
    await close()
    const names = await readdir(root)
    const rows = (await readFile(join(root, names[0]!), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const weight = rows.at(-1).caches.lineWidthCacheChars
    assert.ok(weight > 0 && weight <= 256 * 1024)
  } finally { await close?.(); await rm(root, { recursive: true, force: true }) }
})

test('telemetry rotates into one bounded previous file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'memory-telemetry-rotate-'))
  try {
    const close = await startGatewayMemoryTelemetry(root, 'fixture-build', 1)
    await close!()
    const names = await readdir(root)
    assert.equal(names.length, 2)
    const previous = names.find(name => name.endsWith('.1'))!
    assert.equal(JSON.parse((await readFile(join(root, previous), 'utf8')).trim()).reason, 'startup')
    const current = names.find(name => name.endsWith('.jsonl'))!
    assert.equal(JSON.parse((await readFile(join(root, current), 'utf8')).trim()).reason, 'shutdown')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('unwritable telemetry target does not interrupt the harness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'memory-telemetry-error-'))
  try {
    const path = join(root, 'file')
    await writeFile(path, 'fixture')
    assert.equal(await startGatewayMemoryTelemetry(path, 'fixture-build'), undefined)
  } finally { await rm(root, { recursive: true, force: true }) }
})
