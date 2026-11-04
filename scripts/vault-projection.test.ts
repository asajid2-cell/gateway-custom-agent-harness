import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { admitGeneration, appendEvents } from '../src/utils/vault/journal.js'
import {
  applyAll,
  applyFamily,
  closeProjection,
  lastApplied,
  openProjection,
  parity,
  projectionDigest,
  projectionPath,
  rebuild,
} from '../src/utils/vault/projection.js'

const FAMILY = 'fam-1'

async function seeded(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'vault-projection-'))
  await admitGeneration(root, FAMILY, { kind: 'admission', generation_id: 'gen-1' })
  return root
}

async function commit(root: string, count: number, prefix = 'e'): Promise<void> {
  await appendEvents(
    root,
    FAMILY,
    Array.from({ length: count }, (_, index) => ({
      event_id: `${prefix}-${index}`,
      generation_id: 'gen-1',
      kind: 'finding',
      topic_id: 't1',
      summary: `row ${index}`,
      recorded_at: '2026-11-05T00:00:00.000Z',
    })),
  )
}

test('applying twice applies once and the watermark tracks the journal', async () => {
  const root = await seeded()
  try {
    await commit(root, 3)
    const projection = await openProjection(root)
    try {
      const first = await applyFamily(projection, root, FAMILY)
      assert.equal(first.applied, 3)
      assert.equal(first.watermark, 3)
      const second = await applyFamily(projection, root, FAMILY)
      assert.equal(second.applied, 0)
      assert.equal(lastApplied(projection, FAMILY), 3)
      const rows = projection.db.query('SELECT COUNT(*) AS n FROM events').get() as { n: number }
      assert.equal(rows.n, 3)
    } finally {
      closeProjection(projection)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a projection behind the journal reports its lag and then catches up', async () => {
  const root = await seeded()
  try {
    await commit(root, 2)
    const projection = await openProjection(root)
    try {
      await applyFamily(projection, root, FAMILY)
      await commit(root, 3, 'late')
      const catchUp = await applyAll(projection, root)
      const family = catchUp.find(entry => entry.familyId === FAMILY)!
      assert.equal(family.applied, 3)
      assert.equal(family.lag, 3, 'lag is measured from the applied watermark, not invented')
      assert.equal(lastApplied(projection, FAMILY), 5)
    } finally {
      closeProjection(projection)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a full rebuild from the journal equals the incremental projection', async () => {
  const root = await seeded()
  const scratch = await mkdtemp(path.join(tmpdir(), 'vault-projection-scratch-'))
  try {
    await commit(root, 4)
    const first = await parity(root, path.join(scratch, 'a'))
    assert.equal(first.equal, true)
    assert.equal(first.incrementalRows, 4)

    await commit(root, 2, 'more')
    const second = await parity(root, path.join(scratch, 'b'))
    assert.equal(second.equal, true)
    assert.equal(second.incrementalRows, 6)
    assert.equal(second.rebuiltRows, 6)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(scratch, { recursive: true, force: true })
  }
})

test('deleting the database and rebuilding reproduces the same digest', async () => {
  const root = await seeded()
  try {
    await commit(root, 3)
    const before = await openProjection(root)
    await applyAll(before, root)
    const digestBefore = projectionDigest(before)
    closeProjection(before)

    await rm(projectionPath(root), { force: true })
    const after = await openProjection(root)
    try {
      assert.equal((after.db.query('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n, 0)
      await rebuild(after, root)
      assert.equal(projectionDigest(after), digestBefore)
    } finally {
      closeProjection(after)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a torn journal is refused by the projection instead of being partially applied', async () => {
  const root = await seeded()
  try {
    await commit(root, 1)
    const { appendFile } = await import('node:fs/promises')
    const { familyJournalPath } = await import('../src/utils/vault/journal.js')
    await appendFile(familyJournalPath(root, FAMILY), '{"half":')
    const projection = await openProjection(root)
    try {
      await assert.rejects(() => applyFamily(projection, root, FAMILY), /torn line/)
      assert.equal((projection.db.query('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n, 0)
    } finally {
      closeProjection(projection)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
