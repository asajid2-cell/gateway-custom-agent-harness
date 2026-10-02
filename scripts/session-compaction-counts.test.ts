import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, appendFile, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  appendCompactionBoundaryForTesting,
  commitSessionCompactionBoundary,
  loadSessionCompactionCounts,
  prepareSessionCompactionBoundaries,
  subscribeSessionCompactionCounts,
} from '../src/utils/sessionCompactionCounts.ts'
import { formatGatewayPeerLine, gatewayPeerSchema } from '../src/utils/gatewaySessionProtocol.ts'

// The checkpoint module honors the same persistence gates as the transcript
// writer, and under `bun test` NODE_ENV is 'test' — the tests that exercise
// durable counting therefore have to opt in explicitly.
async function withPersistence<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.TEST_ENABLE_SESSION_PERSISTENCE
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    else process.env.TEST_ENABLE_SESSION_PERSISTENCE = previous
  }
}

const boundaryLine = (subtype: string, uuid: string) => `${JSON.stringify({ type: 'system', subtype, uuid })}\n`

test('a full boundary increments only the full count and a micro boundary only the micro count', { timeout: 30000 }, async () => {
  await withPersistence(async () => {
    const root = await mkdtemp(join(tmpdir(), 'compaction-counts-'))
    const sessionId = randomUUID()
    const transcript = join(root, `${sessionId}.jsonl`)
    try {
      assert.deepEqual(await loadSessionCompactionCounts(sessionId, transcript), { compactBoundaryCount: 0, microcompactBoundaryCount: 0 })
      await appendCompactionBoundaryForTesting(sessionId, transcript, { uuid: randomUUID(), kind: 'full' })
      assert.deepEqual(await loadSessionCompactionCounts(sessionId, transcript), { compactBoundaryCount: 1, microcompactBoundaryCount: 0 })
      await appendCompactionBoundaryForTesting(sessionId, transcript, { uuid: randomUUID(), kind: 'micro' })
      assert.deepEqual(await loadSessionCompactionCounts(sessionId, transcript), { compactBoundaryCount: 1, microcompactBoundaryCount: 1 })
      await appendCompactionBoundaryForTesting(sessionId, transcript, { uuid: randomUUID(), kind: 'micro' })
      assert.deepEqual(await loadSessionCompactionCounts(sessionId, transcript), { compactBoundaryCount: 1, microcompactBoundaryCount: 2 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

test('a boundary UUID is counted once however many times it is offered', { timeout: 30000 }, async () => {
  await withPersistence(async () => {
    const root = await mkdtemp(join(tmpdir(), 'compaction-dedupe-'))
    const sessionId = randomUUID()
    const transcript = join(root, `${sessionId}.jsonl`)
    const uuid = randomUUID()
    try {
      await appendCompactionBoundaryForTesting(sessionId, transcript, { uuid, kind: 'full' })
      // The same UUID arriving again - a replayed insert after resume - must not
      // move the number.
      await prepareSessionCompactionBoundaries(sessionId, transcript, [{ uuid, kind: 'full' }])
      await commitSessionCompactionBoundary(sessionId, transcript, uuid)
      assert.deepEqual(await loadSessionCompactionCounts(sessionId, transcript), { compactBoundaryCount: 1, microcompactBoundaryCount: 0 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

test('counts survive a resume and are recovered when the writer died between append and commit', { timeout: 30000 }, async () => {
  await withPersistence(async () => {
    const root = await mkdtemp(join(tmpdir(), 'compaction-resume-'))
    const sessionId = randomUUID()
    const transcript = join(root, `${sessionId}.jsonl`)
    try {
      await appendCompactionBoundaryForTesting(sessionId, transcript, { uuid: randomUUID(), kind: 'full' })
      // The crash window: the boundary is recorded as pending and its line is
      // written, but the process exits before the commit updates the checkpoint.
      const pending = { uuid: randomUUID(), kind: 'micro' as const }
      await prepareSessionCompactionBoundaries(sessionId, transcript, [pending])
      await appendFile(transcript, boundaryLine('microcompact_boundary', pending.uuid))
      const checkpoint = JSON.parse(await readFile(`${transcript}.compactions.json`, 'utf8'))
      assert.deepEqual(checkpoint.pending.map((item: { uuid: string }) => item.uuid), [pending.uuid], 'the boundary is pending until it is observed on disk')
      // Loading is the resume: it observes the landed line, commits it once and
      // clears the pending entry so the count cannot be applied twice.
      assert.deepEqual(await loadSessionCompactionCounts(sessionId, transcript), { compactBoundaryCount: 1, microcompactBoundaryCount: 1 })
      const recovered = JSON.parse(await readFile(`${transcript}.compactions.json`, 'utf8'))
      assert.deepEqual(recovered.pending, [])
      assert.equal(recovered.microcompactBoundaryCount, 1)
      assert.deepEqual(await loadSessionCompactionCounts(sessionId, transcript), { compactBoundaryCount: 1, microcompactBoundaryCount: 1 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

test('a boundary whose line never reached the transcript does not count', { timeout: 30000 }, async () => {
  await withPersistence(async () => {
    const root = await mkdtemp(join(tmpdir(), 'compaction-unlanded-'))
    const sessionId = randomUUID()
    const transcript = join(root, `${sessionId}.jsonl`)
    try {
      await appendCompactionBoundaryForTesting(sessionId, transcript, { uuid: randomUUID(), kind: 'full' })
      // Prepared, never appended: the enqueue was lost with the process.
      await prepareSessionCompactionBoundaries(sessionId, transcript, [{ uuid: randomUUID(), kind: 'full' }])
      assert.deepEqual(await loadSessionCompactionCounts(sessionId, transcript), { compactBoundaryCount: 1, microcompactBoundaryCount: 0 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

test('a transcript that predates the checkpoint stays unknown instead of being scanned', { timeout: 30000 }, async () => {
  await withPersistence(async () => {
    const root = await mkdtemp(join(tmpdir(), 'compaction-unknown-'))
    const sessionId = randomUUID()
    const transcript = join(root, `${sessionId}.jsonl`)
    try {
      await writeFile(transcript, boundaryLine('compact_boundary', randomUUID()))
      assert.equal(await loadSessionCompactionCounts(sessionId, transcript), undefined)
      await prepareSessionCompactionBoundaries(sessionId, transcript, [{ uuid: randomUUID(), kind: 'micro' }])
      assert.equal(await loadSessionCompactionCounts(sessionId, transcript), undefined)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

test('disabled session persistence publishes no counts at all', { timeout: 30000 }, async () => {
  const previous = process.env.TEST_ENABLE_SESSION_PERSISTENCE
  delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
  const root = await mkdtemp(join(tmpdir(), 'compaction-disabled-'))
  const sessionId = randomUUID()
  const transcript = join(root, `${sessionId}.jsonl`)
  try {
    await appendCompactionBoundaryForTesting(sessionId, transcript, { uuid: randomUUID(), kind: 'full' })
    assert.equal(await loadSessionCompactionCounts(sessionId, transcript), undefined)
    await assert.rejects(readFile(`${transcript}.compactions.json`, 'utf8'), /ENOENT/)
  } finally {
    if (previous !== undefined) process.env.TEST_ENABLE_SESSION_PERSISTENCE = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('committing a boundary publishes the new counts to listeners', { timeout: 30000 }, async () => {
  await withPersistence(async () => {
    const root = await mkdtemp(join(tmpdir(), 'compaction-listen-'))
    const sessionId = randomUUID()
    const transcript = join(root, `${sessionId}.jsonl`)
    const seen: Array<{ sessionId: string; counts: unknown }> = []
    const unsubscribe = subscribeSessionCompactionCounts((id, counts) => seen.push({ sessionId: id, counts }))
    try {
      await appendCompactionBoundaryForTesting(sessionId, transcript, { uuid: randomUUID(), kind: 'full' })
      assert.deepEqual(seen, [{ sessionId, counts: { compactBoundaryCount: 1, microcompactBoundaryCount: 0 } }])
    } finally {
      unsubscribe()
      await rm(root, { recursive: true, force: true })
    }
  })
})

test('an older registration without compaction fields still parses, and the line omits them', () => {
  const base = {
    protocol: 1, sessionId: randomUUID(), runtimeId: randomUUID(), name: 'Legacy peer',
    cwd: 'Z:/work', purpose: 'doing things', pid: 4242, endpoint: '\\\\.\\pipe\\gateway-legacy',
    status: 'idle', startedAt: new Date().toISOString(),
  }
  const legacy = gatewayPeerSchema.parse(base)
  assert.equal(legacy.compactBoundaryCount, undefined)
  assert.equal(formatGatewayPeerLine(legacy).includes('compactions:'), false)

  const current = gatewayPeerSchema.parse({ ...base, compactBoundaryCount: 3, microcompactBoundaryCount: 7 })
  assert.ok(formatGatewayPeerLine(current).includes('compactions: 3 full, 7 micro'))
})
