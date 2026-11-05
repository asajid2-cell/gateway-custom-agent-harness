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
 * Revision 2 adds the two refusal classes (backlog with its presupposed rows,
 * unknown family with a genuinely absent file), restores exact folds now that
 * the fold carries the id's preimage fields, and adds cr-13, the retry case.
 * cr-13 needs a code change that is held behind the release freeze; see the
 * PENDING map. Nothing in this file is relaxed - a case either runs or is
 * named as pending with the commit it waits for.
 */
const FIXTURE_SHA256 = '6e00d2e7de5a8e91289503ef2edcd6ea0dffbce8b9cec33e8b479599a29913fa'
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'obligation-creation.jsonl')
const FAMILY = 'fam-htv'

/**
 * Cases whose assertions cannot pass until a named commit lands. Kept explicit
 * so the set can only shrink: the fixture-integrity test asserts this exact
 * map, so a new skip cannot be added quietly.
 */
const PENDING: Record<string, string> = {
  'cr-13': 'the retry ruling: a duplicate admission that supplies the turn must create. Held behind the release freeze at be49df8; lands immediately after the artifact digests.',
}

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
  assert.equal(table.length, 13)
  assert.deepEqual(Object.keys(PENDING), ['cr-13'], 'a case may only be pending for a named commit')
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
    } catch (error) {
      failures.push(`${entry.case_id} (${entry.title}): ${(error as Error).message}`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
  assert.deepEqual(failures, [], `${failures.length} creation row(s) disagree with the fixture`)
})
