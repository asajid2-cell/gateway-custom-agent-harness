import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { admitGeneration } from '../src/utils/vault/journal.js'
import { conferDriverAdmission, scribePath } from '../src/utils/vault/activation.js'
import {
  obligationIdFor,
  obligationsPath,
  readObligations,
  recordObligation,
  summarizeObligations,
  type ObligationCreationInput,
} from '../src/utils/vault/obligations.js'

/**
 * The obligation-creation fixture, run as a table with its lines unchanged.
 *
 * Provenance: copied from the spec side's
 * `Z:\328\CMPUT328-A2\codexworks\301\sndo\fixtures\obligation-creation.jsonl`
 * on 2026-11-05, pinned by sha256. Rows are never edited to match the code.
 *
 * Revision 3 adds cr-14: a repaired obligation is dated when it was owed, not
 * when it was repaired, so a lost write shows its lag instead of improving the
 * metric. It runs against `createdAt` taken from the admission's own `at`.
 * Nothing in this file is relaxed - a case either runs or is named as pending
 * with the commit it waits for.
 */
const FIXTURE_SHA256 = '9984633f64ce0839cb1c319af7840e138772698a42b3cc296e206d877b304260'
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'obligation-creation.jsonl')
const FAMILY = 'fam-htv'

/**
 * Cases whose assertions cannot pass until a named commit lands. Kept explicit
 * so the set can only shrink: the fixture-integrity test asserts this exact
 * map, so a new skip cannot be added quietly. Empty now: the retry landed in
 * the post-cut commit and cr-13 is green.
 */
const PENDING: Record<string, string> = {}

type Call = {
  driver_session_id: string
  turn_boundary: string
  kind: 'decision' | 'handoff' | 'external_evidence' | 'correction'
  created_at: string
  source_message_id?: string
}

type Seam = {
  mode: 'refused' | 'monitor' | 'admitted'
  refusal?: string
  max_pending?: number | null
  family_id: string
  driver_session_id: string
  turn_boundary: string
  turn?: { text: string; context?: string; sourceMessageId?: string }
}

type Case = {
  case_id: string
  title: string
  purpose?: string
  prior?: string[]
  corrupt?: string
  calls?: Call[]
  seam?: Seam
  retry?: Seam
  /** Pins the admission's own time so a case is about the rule, not the wall clock. */
  clock?: { admission_at: string; retry_at: string }
  as_of?: string
  overdue_hours?: number
  ids?: { family_id: string; driver_session_id: string; turn_boundary: string; obligation_id: string; invocation_id: string }
  expect: {
    calls?: Array<Record<string, unknown>>
    file?: 'absent' | 'not-a-regular-file'
    file_rows?: Array<Record<string, unknown>>
    file_rows_count?: number
    absent_ids?: string[]
    fold?: Array<Record<string, unknown>> | 'unreadable'
    fold_omits?: string[]
    seam?: { admitted?: boolean; reason?: string; would_refuse?: string | null }
    seam_result?: Record<string, unknown>
    retry_result?: Record<string, unknown>
    pending?: string[]
    overdue?: string[]
    relation?: string
    record_has_family_id?: boolean
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

async function rawRows(root: string, family: string): Promise<Array<Record<string, unknown>>> {
  let raw: string
  try {
    raw = await readFile(obligationsPath(root, family), 'utf8')
  } catch {
    return []
  }
  return raw
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

function input(root: string, family: string, call: Call): ObligationCreationInput {
  return {
    vaultRoot: root,
    familyId: family,
    driverSessionId: call.driver_session_id,
    turnBoundary: call.turn_boundary,
    kind: call.kind,
    createdAt: call.created_at,
    sourceMessageId: call.source_message_id,
  }
}

async function runSeam(root: string, seam: Seam): Promise<Record<string, unknown> & { ok: boolean }> {
  return conferDriverAdmission({
    vaultRoot: root,
    familyId: seam.family_id,
    driverSessionId: seam.driver_session_id,
    turnBoundary: seam.turn_boundary,
    mode: seam.mode === 'monitor' ? 'monitor' : 'enforce',
    maxPending: seam.max_pending ?? null,
    turn: seam.turn,
  }) as Promise<Record<string, unknown> & { ok: boolean }>
}

function omit(rows: Array<Record<string, unknown>>, keys: readonly string[] = []): Array<Record<string, unknown>> {
  return rows.map(row => {
    const copy = { ...row }
    for (const key of keys) delete copy[key]
    return copy
  })
}

test('the creation fixture is the one that was pinned, and the pending set is explicit', async () => {
  const bytes = await readFile(FIXTURE)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), FIXTURE_SHA256)
  const table = await cases()
  assert.equal(table.length, 14)
  assert.deepEqual(Object.keys(PENDING), [], 'a case may only be pending for a named commit')
  assert.ok(table.some(entry => entry.case_id === 'cr-13' && entry.retry), 'the retry case must stay in the table')
})

test('every creation case behaves as the fixture says', async () => {
  const failures: string[] = []
  for (const entry of await cases()) {
    if (PENDING[entry.case_id]) continue
    const root = await mkdtemp(path.join(tmpdir(), 'vault-obligation-creation-'))
    const family = entry.seam?.family_id ?? entry.ids?.family_id ?? FAMILY
    try {
      await admitGeneration(root, FAMILY, { kind: 'admission', generation_id: 'gen-1' })
      if (entry.corrupt && entry.corrupt.includes('directory')) {
        await mkdir(obligationsPath(root, family), { recursive: true })
      } else if (entry.prior) {
        await writeFile(obligationsPath(root, family), `${entry.prior.join('\n')}\n`)
      }

      if (entry.calls) {
        const results = []
        for (const call of entry.calls) results.push(await recordObligation(input(root, family, call)))
        for (const [index, expected] of (entry.expect.calls ?? []).entries()) {
          const actual = results[index] as Record<string, unknown>
          if (expected.ok === false) {
            assert.equal(actual.ok, false, `${entry.case_id} call ${index}: expected refusal`)
            assert.match(String(actual.message ?? ''), new RegExp(String(expected.message_contains)), `${entry.case_id} call ${index}: message`)
          } else {
            assert.equal(actual.ok, true, `${entry.case_id} call ${index}: expected success`)
            assert.equal(actual.obligation_id, expected.obligation_id, `${entry.case_id} call ${index}: id`)
            assert.equal(actual.duplicate, expected.duplicate, `${entry.case_id} call ${index}: duplicate`)
          }
        }
      }

      if (entry.seam) {
        // An unknown family has no directory to put a scribe in, and the gate
        // refuses it before any health check.
        if (existsSync(path.join(root, 'families', family))) {
          await writeFile(scribePath(root, family), `${JSON.stringify({ session_id: 'scribe-1', generation_id: 'gen-1' })}\n`)
        }
        const result = await runSeam(root, entry.seam)
        const expectSeam = entry.expect.seam ?? {}
        if (expectSeam.admitted !== undefined) {
          assert.equal(result.ok, expectSeam.admitted, `${entry.case_id}: admitted`)
        }
        if (expectSeam.reason !== undefined) {
          assert.equal(result.ok === false ? result.reason : '', expectSeam.reason, `${entry.case_id}: reason`)
        }
        if ('would_refuse' in expectSeam) {
          assert.equal(result.ok ? result.would_refuse : undefined, expectSeam.would_refuse, `${entry.case_id}: would_refuse`)
        }
        const expectResult = entry.expect.seam_result ?? {}
        if (typeof expectResult.obligation_id === 'string' && expectResult.obligation_id !== 'absent') {
          assert.equal(result.ok ? result.obligation_id : undefined, expectResult.obligation_id, `${entry.case_id}: seam obligation id`)
        }
        if (expectResult.obligation_id === 'absent') {
          assert.equal(result.ok ? result.obligation_id : undefined, undefined, `${entry.case_id}: no obligation`)
        }
        if (expectResult.obligation_error_present === true) {
          assert.ok(
            result.ok && typeof result.obligation_error === 'string' && result.obligation_error.length > 0,
            `${entry.case_id}: obligation_error must be reported`,
          )
        }
      }

      if (entry.clock) {
        // The seam stamps a real admission with the wall clock, so a case about
        // which clock a repair reads cannot be written against it directly.
        // Pinning the admission's own `at` is enough: the repair is supposed to
        // take that value, and the retry's clock is never consulted.
        const rotationPath = path.join(root, 'families', family, 'rotation.jsonl')
        const pinned = (await readFile(rotationPath, 'utf8'))
          .split('\n')
          .filter(line => line.trim() !== '')
          .map(line => JSON.parse(line) as Record<string, unknown>)
          .map(record => (record.kind === 'admission' ? { ...record, at: entry.clock!.admission_at } : record))
        await writeFile(rotationPath, `${pinned.map(record => JSON.stringify(record)).join('\n')}\n`)
      }

      if (entry.retry) {
        // The retry is the same seam called a second time, after the first call
        // has already recorded its admission. It runs before the file and fold
        // assertions because its whole point is what those files then contain.
        const result = await runSeam(root, entry.retry)
        assert.equal(result.ok, true, `${entry.case_id}: the retry is a duplicate admission, not a refusal`)
        const expectRetry = entry.expect.retry_result ?? {}
        if (expectRetry.obligation_id === 'absent') {
          assert.equal(result.obligation_id, undefined, `${entry.case_id}: the retry must not create`)
        } else if (typeof expectRetry.obligation_id === 'string') {
          assert.equal(result.obligation_id, expectRetry.obligation_id, `${entry.case_id}: retry obligation id`)
        }
        if (expectRetry.created === true) {
          assert.equal(result.created, true, `${entry.case_id}: the retry must report it wrote the row`)
        }
        // The fixture calls the duplicate flag `duplicate_admission`; the seam
        // has one duplicate notion and calls it `duplicate`.
        if (expectRetry.duplicate_admission === true) {
          assert.equal(result.duplicate, true, `${entry.case_id}: the retry must be the same admission`)
        }
      }

      if (entry.ids) {
        assert.equal(
          obligationIdFor(entry.ids.family_id, entry.ids.driver_session_id, entry.ids.turn_boundary),
          entry.ids.obligation_id,
          `${entry.case_id}: ids.obligation_id is not derived from the (family, driver, turn) preimage`,
        )
        assert.equal(entry.ids.obligation_id, `ob:${entry.ids.invocation_id.slice(4)}`, `${entry.case_id}: relation`)
        if (entry.expect.record_has_family_id) {
          await recordObligation({
            vaultRoot: root,
            familyId: entry.ids.family_id,
            driverSessionId: entry.ids.driver_session_id,
            turnBoundary: entry.ids.turn_boundary,
            kind: 'decision',
            createdAt: '2026-11-05T00:00:00.000Z',
          })
          const written = await rawRows(root, entry.ids.family_id)
          assert.equal(written[0]?.family_id, entry.ids.family_id, `${entry.case_id}: the creation row carries family_id`)
        }
      }

      if (entry.expect.file === 'absent') {
        assert.equal(existsSync(obligationsPath(root, family)), false, `${entry.case_id}: the obligations path must not exist`)
      }
      if (entry.expect.file === 'not-a-regular-file') {
        const info = await stat(obligationsPath(root, family)).catch(() => null)
        assert.ok(info !== null && !info.isFile(), `${entry.case_id}: a failed creation must not leave a regular file`)
      }
      if (entry.expect.file_rows) {
        assert.deepEqual(await rawRows(root, family), entry.expect.file_rows, `${entry.case_id}: file rows`)
      }
      if (entry.expect.file_rows_count !== undefined) {
        assert.equal((await rawRows(root, family)).length, entry.expect.file_rows_count, `${entry.case_id}: file row count`)
      }
      if (entry.expect.absent_ids) {
        const present = new Set((await rawRows(root, family)).map(row => row.obligation_id))
        for (const id of entry.expect.absent_ids) {
          assert.equal(present.has(id), false, `${entry.case_id}: ${id} must not be in the file`)
        }
      }
      if (entry.expect.fold === 'unreadable') {
        await assert.rejects(readObligations(root, family), `${entry.case_id}: the fold must report the unreadable file`)
      } else if (entry.expect.fold) {
        const actual = omit(
          JSON.parse(JSON.stringify(await readObligations(root, family))) as Array<Record<string, unknown>>,
          entry.expect.fold_omits,
        )
        assert.deepEqual(actual, omit(entry.expect.fold, entry.expect.fold_omits), `${entry.case_id}: fold`)
      }
      if (entry.expect.pending || entry.expect.overdue) {
        // The rule, not just the field: the same fold the metric reads is asked
        // what is open at `as_of`. A repaired row dated by the retry clock can
        // still carry the right id and read as fresh, which is the failure this
        // assertion exists to catch.
        const summary = summarizeObligations(await readObligations(root, family), {
          asOf: entry.as_of,
          overdueHours: entry.overdue_hours,
        })
        if (entry.expect.pending) {
          assert.deepEqual(summary.pending.map(row => row.obligation_id), entry.expect.pending, `${entry.case_id}: pending`)
        }
        if (entry.expect.overdue) {
          assert.deepEqual(summary.overdue.map(row => row.obligation_id), entry.expect.overdue, `${entry.case_id}: overdue`)
        }
      }
    } catch (error) {
      failures.push(`${entry.case_id} (${entry.title}): ${(error as Error).message}`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
  assert.deepEqual(failures, [], `${failures.length} creation row(s) disagree with the fixture`)
})
