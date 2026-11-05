import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  DEFAULT_OVERDUE_HOURS,
  foldObligations,
  obligationBacklog,
  obligationsPath,
  readObligations,
  summarizeObligations,
} from '../src/utils/vault/obligations.js'

const FAMILY = 'fam-obligations'

function line(record: Record<string, unknown>): string {
  return JSON.stringify(record)
}

test('a terminal record is final: a later pending does not reopen the obligation', () => {
  const rows = foldObligations([
    line({ obligation_id: 'ob-1', state: 'pending' }),
    line({ obligation_id: 'ob-1', state: 'satisfied' }),
    line({ obligation_id: 'ob-1', state: 'pending' }),
  ])
  assert.equal(rows.get('ob-1')?.state, 'satisfied')
})

test('closure is final whichever order the records arrive in', () => {
  const rows = foldObligations([
    line({ obligation_id: 'ob-1', state: 'satisfied', committed_event_ids: ['e1'] }),
    line({ obligation_id: 'ob-1', state: 'pending' }),
  ])
  assert.equal(rows.get('ob-1')?.state, 'satisfied')
})

test('a record naming an unknown state is ignored rather than read as closed', () => {
  const rows = foldObligations([
    line({ obligation_id: 'ob-1', state: 'pending' }),
    line({ obligation_id: 'ob-1', state: 'done-ish' }),
  ])
  assert.equal(rows.get('ob-1')?.state, 'pending')
})

test('a creation record with no state is pending, and keeps its metadata', () => {
  const rows = foldObligations([
    line({ obligation_id: 'ob-1', kind: 'decision', created_at: '2026-11-01T00:00:00.000Z', source_message_id: 'm1' }),
    line({ obligation_id: 'ob-1', state: 'satisfied' }),
  ])
  const row = rows.get('ob-1')!
  assert.equal(row.state, 'satisfied')
  assert.equal(row.kind, 'decision')
  assert.equal(row.created_at, '2026-11-01T00:00:00.000Z')
  assert.equal(row.source_message_id, 'm1')
})

test('the overdue threshold is the configured one, and age_unknown is never overdue', () => {
  const rows = [
    { obligation_id: 'old', state: 'pending' as const, created_at: '2026-11-01T00:00:00.000Z' },
    { obligation_id: 'undated', state: 'pending' as const },
  ]
  const asOf = Date.parse('2026-11-04T00:00:00.000Z')
  assert.deepEqual(summarizeObligations(rows, { asOf, overdueHours: 24 }).overdue.map(row => row.obligation_id), ['old'])
  assert.deepEqual(summarizeObligations(rows, { asOf, overdueHours: 24 * 7 }).overdue, [])
  assert.deepEqual(
    summarizeObligations(rows, { asOf, overdueHours: 24 }).pending.map(row => row.obligation_id),
    ['old', 'undated'],
    'undated is still owed, it just cannot be aged',
  )
})

test('an over-cap backlog is named with all three counts, and null means the cap is off', () => {
  const rows = [
    { obligation_id: 'a', state: 'pending' as const, created_at: '2026-11-01T00:00:00.000Z' },
    { obligation_id: 'b', state: 'pending' as const, created_at: '2026-11-01T00:00:00.000Z' },
    { obligation_id: 'c', state: 'satisfied' as const, created_at: '2026-11-01T00:00:00.000Z' },
  ]
  const asOf = Date.parse('2026-11-04T00:00:00.000Z')
  const over = obligationBacklog(rows, { asOf, overdueHours: 24, maxPending: 1 })
  assert.deepEqual(over, { pending: 2, overdue: 2, maxPending: 1, overdueHours: 24, over: true })

  const atCap = obligationBacklog(rows, { asOf, overdueHours: 24, maxPending: 2 })
  assert.equal(atCap.over, false, 'exactly at the cap is not over it')

  const off = obligationBacklog(rows, { asOf, overdueHours: 24, maxPending: null })
  assert.equal(off.over, false, 'null is the cap switched off, not a cap of zero')
})

test('a missing file is an empty set, and rows come back sorted by id', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vault-obligations-'))
  try {
    assert.deepEqual(await readObligations(root, FAMILY), [])
    await mkdir(path.dirname(obligationsPath(root, FAMILY)), { recursive: true })
    await writeFile(
      obligationsPath(root, FAMILY),
      [
        line({ obligation_id: 'z', state: 'pending' }),
        line({ obligation_id: 'a', state: 'pending' }),
        line({ obligation_id: 'm', state: 'satisfied' }),
      ].join('\n') + '\n',
    )
    assert.deepEqual((await readObligations(root, FAMILY)).map(row => row.obligation_id), ['a', 'm', 'z'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the default overdue window is a single named constant', () => {
  assert.equal(DEFAULT_OVERDUE_HOURS, 24)
  assert.equal(obligationBacklog([], {}).overdueHours, DEFAULT_OVERDUE_HOURS)
})
