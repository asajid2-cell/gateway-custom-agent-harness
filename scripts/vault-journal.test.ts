import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  activeGeneration,
  admitGeneration,
  appendEvents,
  canonicalJson,
  contentHash,
  familyJournalPath,
  readJournal,
} from '../src/utils/vault/journal.js'

const FAMILY = 'fam-1'

async function scratch(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'vault-journal-'))
}

async function seeded(): Promise<string> {
  const root = await scratch()
  await admitGeneration(root, FAMILY, { kind: 'admission', generation_id: 'gen-1' })
  return root
}

test('canonical JSON sorts keys, drops whitespace and hashes stably', () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}')
  const first = contentHash({ z: 1, a: 2, kind: 'decision' })
  const second = contentHash({ kind: 'decision', a: 2, z: 1 })
  assert.equal(first, second)
  assert.match(first, /^sha256:[0-9a-f]{64}$/)
  // The hash covers the body without content_hash, so re-hashing a committed
  // event reproduces its own value instead of chasing itself.
  const body = { z: 1, a: 2, kind: 'decision' }
  assert.equal(contentHash({ ...body, content_hash: contentHash(body) }), contentHash(body))
})

test('append assigns contiguous sequences and a verifiable hash', async () => {
  const root = await seeded()
  try {
    const first = await appendEvents(root, FAMILY, [
      { event_id: 'e1', generation_id: 'gen-1', kind: 'decision', body: 'one' },
      { event_id: 'e2', generation_id: 'gen-1', kind: 'finding', body: 'two' },
    ])
    assert.deepEqual(first.committed.map(event => event.sequence), [1, 2])
    assert.equal(first.watermark, 2)
    for (const event of first.committed) assert.equal(event.content_hash, contentHash(event))

    const second = await appendEvents(root, FAMILY, [
      { event_id: 'e3', generation_id: 'gen-1', kind: 'finding', body: 'three' },
    ])
    assert.deepEqual(second.committed.map(event => event.sequence), [3])

    const journal = await readJournal(root, FAMILY)
    assert.deepEqual(journal.events.map(event => event.event_id), ['e1', 'e2', 'e3'])
    assert.equal(journal.watermark, 3)
    assert.equal(journal.tornTail, false)
    const raw = await readFile(familyJournalPath(root, FAMILY), 'utf8')
    assert.equal(raw.split('\n').filter(Boolean).length, 3)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a repeated event id commits once and is reported as a duplicate', async () => {
  const root = await seeded()
  try {
    await appendEvents(root, FAMILY, [{ event_id: 'dup', generation_id: 'gen-1', body: 'x' }])
    const again = await appendEvents(root, FAMILY, [
      { event_id: 'dup', generation_id: 'gen-1', body: 'x' },
      { event_id: 'fresh', generation_id: 'gen-1', body: 'y' },
    ])
    assert.deepEqual(again.duplicates, ['dup'])
    assert.deepEqual(again.committed.map(event => event.event_id), ['fresh'])
    assert.equal((await readJournal(root, FAMILY)).events.length, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an absent generation is refused rather than defaulted', async () => {
  const root = await seeded()
  try {
    const result = await appendEvents(root, FAMILY, [{ event_id: 'nogen', body: 'x' } as never])
    assert.equal(result.committed.length, 0)
    assert.match(result.rejected[0]?.reason ?? '', /generation_id is required/)
    assert.equal((await readJournal(root, FAMILY)).watermark, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a fenced generation cannot write and changes nothing', async () => {
  const root = await seeded()
  try {
    await admitGeneration(root, FAMILY, { kind: 'rotation', generation_id: 'gen-1' })
    assert.equal(await activeGeneration(root, FAMILY), 'gen-1')
    const result = await appendEvents(root, FAMILY, [
      { event_id: 'old', generation_id: 'gen-0', body: 'retired' },
    ])
    assert.equal(result.committed.length, 0)
    assert.match(result.rejected[0]?.reason ?? '', /is fenced; active is gen-1/)
    assert.equal((await readJournal(root, FAMILY)).events.length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('no admitted generation means nothing may be committed', async () => {
  const root = await scratch()
  try {
    const result = await appendEvents(root, FAMILY, [{ event_id: 'x', generation_id: 'gen-1', body: 'y' }])
    assert.equal(result.committed.length, 0)
    assert.match(result.rejected[0]?.reason ?? '', /no active generation/)
    await admitGeneration(root, FAMILY, { kind: 'admission', generation_id: 'gen-1' })
    const after = await appendEvents(root, FAMILY, [{ event_id: 'x', generation_id: 'gen-1', body: 'y' }])
    assert.equal(after.committed.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a torn tail is reported and refuses appends until recovery', async () => {
  const root = await seeded()
  try {
    const journalPath = familyJournalPath(root, FAMILY)
    await writeFile(journalPath, '{"event_id":"half","sequence":1')
    const journal = await readJournal(root, FAMILY)
    assert.equal(journal.tornTail, true)
    await assert.rejects(
      () => appendEvents(root, FAMILY, [{ event_id: 'new', generation_id: 'gen-1', body: 'x' }]),
      /torn line/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('concurrent appends in one process keep the sequence contiguous', async () => {
  const root = await seeded()
  try {
    const batches = Array.from({ length: 8 }, (_, index) =>
      appendEvents(root, FAMILY, [
        { event_id: `p-${index}`, generation_id: 'gen-1', kind: 'finding', body: `${index}` },
      ]),
    )
    const results = await Promise.all(batches)
    const sequences = results.flatMap(result => result.committed.map(event => event.sequence)).sort((a, b) => a - b)
    assert.deepEqual(sequences, [1, 2, 3, 4, 5, 6, 7, 8])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('concurrent appends from two processes keep the sequence contiguous and unique', async () => {
  const root = await seeded()
  const worker = path.join(import.meta.dirname, 'vault-journal-worker.ts')
  try {
    const spawnOne = (tag: string) =>
      new Promise<{ status: number | null; stderr: string }>(resolve => {
        const child = spawnSync(process.execPath, [worker, root, FAMILY, tag, '10'], {
          encoding: 'utf8',
          timeout: 120_000,
        })
        resolve({ status: child.status, stderr: `${child.stdout}\n${child.stderr}` })
      })
    const [a, b] = await Promise.all([spawnOne('a'), spawnOne('b')])
    assert.equal(a.status, 0, a.stderr)
    assert.equal(b.status, 0, b.stderr)
    const journal = await readJournal(root, FAMILY)
    assert.equal(journal.events.length, 20)
    const sequences = journal.events.map(event => event.sequence).sort((x, y) => x - y)
    assert.deepEqual(sequences, Array.from({ length: 20 }, (_, index) => index + 1))
    const ids = new Set(journal.events.map(event => event.event_id))
    assert.equal(ids.size, 20)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
