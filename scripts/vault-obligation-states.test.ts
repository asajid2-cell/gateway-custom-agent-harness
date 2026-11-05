import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { admitGeneration } from '../src/utils/vault/journal.js'
import {
  obligationBacklog,
  obligationsPath,
  readObligations,
  summarizeObligations,
} from '../src/utils/vault/obligations.js'
import { submitProposals, type Proposal } from '../src/utils/vault/submit.js'

/**
 * The obligation-state fixture, run as a table with its lines unchanged.
 *
 * Provenance: copied from the spec side's
 * `Z:\328\CMPUT328-A2\codexworks\301\sndo\fixtures\obligation-states.jsonl`
 * on 2026-11-04, pinned by sha256. Every time-dependent case carries an
 * explicit `as_of`, so nothing here ages into failure; a case that needed the
 * wall clock would be a fixture defect.
 */
const FIXTURE_SHA256 = '0bf2311609aa257146d29f6b614782c153f50781d572512b013df74f46a4a1dd'
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'obligation-states.jsonl')
const FAMILY = 'fam-obligation-states'

type Row = {
  obligation_id: string
  kind?: string
  state: string
  created_at?: string
  source_message_id?: string
}

type Case = {
  case_id: string
  title: string
  purpose?: string
  lines?: string[]
  file?: 'absent'
  as_of?: string
  overdue_hours?: number
  max_pending?: number | null
  submit?: { obligationIds: string[]; committed_event_id: string; note?: string }
  expect: {
    rows?: Row[]
    pending?: string[]
    overdue?: string[]
    backlog?: { pending: number; overdue: number; over: boolean }
    satisfied?: string[]
    not_closable?: Array<{ obligation_id: string; reason: string }>
  }
}

async function cases(): Promise<Case[]> {
  const bytes = await readFile(FIXTURE)
  return bytes
    .toString('utf8')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as Case)
}

function proposal(eventId: string, obligationIds: string[]): Proposal {
  return {
    event_id: eventId,
    kind: 'decision',
    topic_id: 'topic-1',
    actor: 'sess-1',
    authority: 'user_ruling',
    evidence_status: 'direct',
    summary: 'closes what the fixture says it closes',
    recorded_at: '2026-11-05T00:00:00.000Z',
    capture_version: 'scribe-0.1.0',
    proposed_by: 'sess-scribe-1',
    obligationIds,
  } as Proposal
}

test('the state fixture is the one that was pinned', async () => {
  const bytes = await readFile(FIXTURE)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), FIXTURE_SHA256)
  const table = await cases()
  assert.equal(table.length, 18)
  assert.ok(table.some(entry => entry.case_id === 'obs-03'), 'terminal-wins must be in the table')
  assert.ok(table.some(entry => entry.case_id === 'obs-18'), 'the substring trap must be in the table')
})

test('every obligation-state case behaves as the fixture says', async () => {
  const failures: string[] = []
  for (const entry of await cases()) {
    const root = await mkdtemp(path.join(tmpdir(), 'vault-obligation-state-'))
    try {
      await admitGeneration(root, FAMILY, { kind: 'admission', generation_id: 'gen-1' })
      if (entry.file !== 'absent') {
        await writeFile(obligationsPath(root, FAMILY), `${(entry.lines ?? []).join('\n')}\n`)
      }
      const rows = await readObligations(root, FAMILY)
      if (entry.expect.rows) {
        // JSON normalisation drops `undefined` fields the fold left absent, which
        // is the same shape the fixture publishes.
        assert.deepEqual(JSON.parse(JSON.stringify(rows)), entry.expect.rows, `${entry.case_id}: rows`)
      }
      const summary = summarizeObligations(rows, { asOf: entry.as_of, overdueHours: entry.overdue_hours })
      if (entry.expect.pending) {
        assert.deepEqual(summary.pending.map(row => row.obligation_id), entry.expect.pending, `${entry.case_id}: pending`)
      }
      if (entry.expect.overdue) {
        assert.deepEqual(summary.overdue.map(row => row.obligation_id), entry.expect.overdue, `${entry.case_id}: overdue`)
      }
      if (entry.expect.backlog) {
        const backlog = obligationBacklog(rows, {
          asOf: entry.as_of,
          overdueHours: entry.overdue_hours,
          maxPending: entry.max_pending ?? null,
        })
        assert.deepEqual(
          { pending: backlog.pending, overdue: backlog.overdue, over: backlog.over },
          entry.expect.backlog,
          `${entry.case_id}: backlog`,
        )
      }
      if (entry.submit) {
        const result = await submitProposals({
          vaultRoot: root,
          familyId: FAMILY,
          generation: 'gen-1',
          proposals: [proposal(entry.submit.committed_event_id, entry.submit.obligationIds)],
        })
        if (entry.expect.satisfied) {
          assert.deepEqual(result.obligationsSatisfied, entry.expect.satisfied, `${entry.case_id}: satisfied`)
        }
        if (entry.expect.not_closable) {
          assert.deepEqual(result.obligationsNotClosable, entry.expect.not_closable, `${entry.case_id}: not_closable`)
        }
      }
    } catch (error) {
      failures.push(`${entry.case_id} (${entry.title}): ${(error as Error).message}`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
  assert.deepEqual(failures, [], `${failures.length} obligation-state row(s) disagree with the fixture`)
})
