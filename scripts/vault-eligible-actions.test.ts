import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { eligibleActions } from '../src/utils/vault/eligibleActions.js'

/**
 * The predicate fixture, run as a table with its rows unchanged.
 *
 * Provenance: copied from the spec side's
 * `Z:\328\CMPUT328-A2\codexworks\301\sndo\fixtures\obligation-predicates.jsonl`
 * on 2026-11-04. The copy is pinned by sha256 so an edit here is caught, and a
 * revised fixture arrives as a new hash rather than as a quiet retune. A row
 * that disagrees with the detector is reported to the fixture's owner; the row
 * is never edited to match the code.
 *
 * Revision 2 (sha256 dd4c8007...): the owner reclassified ev-04 - a bare
 * copula is not decidable as a correction on its own - and added ev-04b, the
 * self-contained spelling. The detector lost its copula rule rather than the
 * row moving to meet it.
 */
const FIXTURE_SHA256 = 'dd4c8007d047555de7e791c045f57055f11c5ccb43f056ac8e09010ec5c6168f'
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'obligation-predicates.jsonl')

type Row = {
  case_id: string
  source: 'user' | 'peer'
  source_excerpt: string
  expected_eligible: boolean
  kind: 'decision' | 'handoff' | 'external_evidence' | 'correction' | 'question' | null
  rationale: string
  context_turn?: string
}

async function rows(): Promise<Row[]> {
  const bytes = await readFile(FIXTURE)
  return bytes
    .toString('utf8')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as Row)
}

test('the fixture is the one that was pinned, not a reshaped copy', async () => {
  const bytes = await readFile(FIXTURE)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), FIXTURE_SHA256)
  const table = await rows()
  assert.equal(table.length, 24)
  assert.equal(table.filter(row => row.expected_eligible).length, 15)
  assert.equal(table.filter(row => !row.expected_eligible).length, 9)
  assert.ok(
    table.some(row => row.case_id === 'no-06' && row.expected_eligible === false),
    'the negation trap must stay in the table; a suite without it has stopped testing what bites',
  )
  assert.ok(
    table.some(row => row.case_id === 'ev-04' && row.expected_eligible === false),
    'a bare copula is not a correction on its own; ev-04b is the self-contained spelling',
  )
})

test('every predicate row classifies as the fixture says, with its kind', async () => {
  const failures: string[] = []
  for (const row of await rows()) {
    const verdict = eligibleActions({ text: row.source_excerpt, source: row.source, context: row.context_turn })
    if (verdict.eligible !== row.expected_eligible || verdict.kind !== row.kind) {
      failures.push(
        `${row.case_id}: expected eligible=${row.expected_eligible} kind=${String(row.kind)}, ` +
          `got eligible=${verdict.eligible} kind=${String(verdict.kind)} (${verdict.reason}) :: ${row.source_excerpt}`,
      )
    }
  }
  assert.deepEqual(failures, [], `${failures.length} row(s) disagree with the fixture`)
})

test('a copula is a correction only when the context names the claim it corrects', () => {
  const text = 'thereal devicetest is a testflight demo build'
  assert.equal(eligibleActions({ text }).eligible, false)
  assert.equal(
    eligibleActions({ text, context: 'Earlier I recorded that devicetest was the release build.' }).kind,
    'correction',
    'the context names the prior claim, so the correction target is no longer implicit',
  )
})

test('a row that needs its context is not decided without it', async () => {
  const table = await rows()
  const hold = table.find(row => row.case_id === 'dec-04')!
  assert.equal(eligibleActions({ text: hold.source_excerpt, context: hold.context_turn }).eligible, true)
  assert.equal(
    eligibleActions({ text: hold.source_excerpt }).eligible,
    false,
    'a bare "hold" with no turn to stop is ambiguous and must not be counted',
  )
})
