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
  type ObligationCreationInput,
} from '../src/utils/vault/obligations.js'

/**
 * The obligation-creation fixture, run as a table with its lines unchanged.
 *
 * Provenance: copied from the spec side's
 * `Z:\328\CMPUT328-A2\codexworks\301\sndo\fixtures\obligation-creation.jsonl`
 * on 2026-11-05, pinned by sha256. Rows are never edited to match the code.
 *
 * Three assertions in the fixture cannot hold as written, and they are listed
 * in CONFLICTS below with the reason each is unsatisfiable rather than quietly
 * relaxed: an `obligation-backlog` refusal requires existing pending rows, so
 * the file cannot be absent; the `corrupt` mechanism creates the file path as a
 * directory, so the path exists; and five `fold` rows predate the widening this
 * fixture's own cr-11 requires. Everything else is compared exactly.
 */
const FIXTURE_SHA256 = '83113c93dbcbd5c69d5f9aa16bda5f2c09aeb9ad1fc7332c3178148a99d9c50f'
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'obligation-creation.jsonl')
const FAMILY = 'fam-htv'

const CONFLICTS: Record<string, { skip: 'file' | 'fold' | 'file+fold'; why: string }> = {
  'cr-01': { skip: 'fold', why: 'the fold now surfaces family_id/driver_session_id/turn_boundary (cr-11 requires it); this expected fold predates that' },
  'cr-02': { skip: 'fold', why: 'same widening as cr-01' },
  'cr-03': { skip: 'fold', why: 'same widening as cr-01' },
  'cr-04': { skip: 'fold', why: 'same widening as cr-01' },
  'cr-06': { skip: 'fold', why: 'same widening as cr-01' },
  'cr-05': { skip: 'file+fold', why: 'an obligation-backlog refusal requires existing pending rows, so the file cannot be absent and the fold cannot be empty' },
  'cr-08': { skip: 'file', why: 'the corrupt mechanism makes obligations.jsonl a directory, so the path exists' },
}

type Call = {
  driver_session_id: string
  turn_boundary: string
  kind: 'decision' | 'handoff' | 'external_evidence' | 'correction'
  created_at: string
  source_message_id?: string
}

type Case = {
  case_id: string
  title: string
  purpose?: string
  prior?: string[]
  corrupt?: string
  calls?: Call[]
  seam?: {
    mode: 'refused' | 'monitor' | 'admitted'
    refusal?: string
    family_id: string
    driver_session_id: string
    turn_boundary: string
    turn: { text: string; context?: string; sourceMessageId?: string }
  }
  ids?: { family_id: string; driver_session_id: string; turn_boundary: string; obligation_id: string; invocation_id: string }
  expect: {
    calls?: Array<Record<string, unknown>>
    file?: 'absent'
    file_rows?: Array<Record<string, unknown>>
    file_rows_count?: number
    fold?: Array<Record<string, unknown>>
    seam?: { admitted?: boolean; reason?: string; would_refuse?: string | null }
    seam_result?: Record<string, unknown>
    relation?: string
    record_has_family_id?: boolean
  }
  blocked_on?: string
}

async function cases(): Promise<Case[]> {
  const bytes = await readFile(FIXTURE)
  return bytes
    .toString('utf8')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as Case)
}

async function rawRows(root: string): Promise<Array<Record<string, unknown>>> {
  let raw: string
  try {
    raw = await readFile(obligationsPath(root, FAMILY), 'utf8')
  } catch {
    return []
  }
  return raw
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

function input(root: string, call: Call): ObligationCreationInput {
  return {
    vaultRoot: root,
    familyId: FAMILY,
    driverSessionId: call.driver_session_id,
    turnBoundary: call.turn_boundary,
    kind: call.kind,
    createdAt: call.created_at,
    sourceMessageId: call.source_message_id,
  }
}

function subsetPossible(skip: string | undefined, what: 'file' | 'fold'): boolean {
  return skip !== what && skip !== 'file+fold'
}

test('the creation fixture is the one that was pinned', async () => {
  const bytes = await readFile(FIXTURE)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), FIXTURE_SHA256)
  assert.equal((await cases()).length, 11)
})

test('every creation case behaves as the fixture says', async () => {
  const failures: string[] = []
  for (const entry of await cases()) {
    const root = await mkdtemp(path.join(tmpdir(), 'vault-obligation-creation-'))
    const conflict = CONFLICTS[entry.case_id]
    try {
      await admitGeneration(root, FAMILY, { kind: 'admission', generation_id: 'gen-1' })
      if (entry.corrupt && entry.corrupt.includes('directory')) {
        await mkdir(obligationsPath(root, FAMILY), { recursive: true })
      } else if (entry.prior) {
        await writeFile(obligationsPath(root, FAMILY), `${entry.prior.join('\n')}\n`)
      }

      if (entry.calls) {
        const results = []
        for (const call of entry.calls) results.push(await recordObligation(input(root, call)))
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
        await writeFile(scribePath(root, FAMILY), `${JSON.stringify({ session_id: 'scribe-1', generation_id: 'gen-1' })}\n`)
        let maxPending: number | null = null
        if (entry.seam.refusal === 'obligation-backlog') {
          const backlog = ['ob-b1', 'ob-b2', 'ob-b3'].map(id => ({
            obligation_id: id,
            kind: 'decision',
            created_at: '2026-01-01T00:00:00.000Z',
          }))
          await writeFile(obligationsPath(root, FAMILY), `${backlog.map(row => JSON.stringify(row)).join('\n')}\n`)
          maxPending = 2
        }
        const mode = entry.seam.mode === 'monitor' ? 'monitor' : 'enforce'
        const result = await conferDriverAdmission({
          vaultRoot: root,
          familyId: FAMILY,
          driverSessionId: entry.seam.driver_session_id,
          turnBoundary: entry.seam.turn_boundary,
          mode,
          maxPending,
          turn: entry.seam.turn,
        })
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
          assert.ok((result.ok ? result.obligation_error : '')?.length, `${entry.case_id}: obligation_error must be reported`)
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
          const written = await rawRows(root)
          assert.equal(written[0]?.family_id, entry.ids.family_id, `${entry.case_id}: the creation row carries family_id`)
        }
      }

      if (entry.expect.file === 'absent' && subsetPossible(conflict?.skip, 'file')) {
        assert.equal(existsSync(obligationsPath(root, FAMILY)), false, `${entry.case_id}: the obligations file must not exist`)
      }
      if (entry.corrupt) {
        // Whatever the fixture says, the mechanism must have left no regular file.
        const info = await stat(obligationsPath(root, FAMILY)).catch(() => null)
        assert.ok(info === null || info.isDirectory(), `${entry.case_id}: a failed creation must not leave a regular obligations file`)
      }
      if (entry.expect.file_rows) {
        assert.deepEqual(await rawRows(root), entry.expect.file_rows, `${entry.case_id}: file rows`)
      }
      if (entry.expect.file_rows_count !== undefined) {
        assert.equal((await rawRows(root)).length, entry.expect.file_rows_count, `${entry.case_id}: file row count`)
      }
      if (entry.expect.fold && subsetPossible(conflict?.skip, 'fold')) {
        assert.deepEqual(
          JSON.parse(JSON.stringify(await readObligations(root, FAMILY))),
          entry.expect.fold,
          `${entry.case_id}: fold`,
        )
      }
    } catch (error) {
      failures.push(`${entry.case_id} (${entry.title}): ${(error as Error).message}`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
  assert.deepEqual(failures, [], `${failures.length} creation row(s) disagree with the fixture`)
})
