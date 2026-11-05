import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  admitDriverDesignation,
  completeRotation,
  conferDriverAdmission,
  readScribe,
  registerScribe,
  scribeHealth,
  scribePath,
  rotationPending,
} from '../src/utils/vault/activation.js'
import {
  activeGeneration,
  admitGeneration,
  appendRotationDecision,
  readRotationRecords,
} from '../src/utils/vault/journal.js'
import { obligationIdFor, readObligations } from '../src/utils/vault/obligations.js'
import { charterPath, readCharter, verifyReconstruction } from '../src/utils/vault/reconstruction.js'
import { submitProposals } from '../src/utils/vault/submit.js'

const FAMILY = 'fam-activation'

async function scratch(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'vault-activation-'))
}

async function seed(root: string, generation = 'gen-1'): Promise<void> {
  await admitGeneration(root, FAMILY, { kind: 'admission', generation_id: generation })
}

async function writeScribe(root: string, record: Record<string, unknown>): Promise<void> {
  await writeFile(scribePath(root, FAMILY), `${JSON.stringify(record)}\n`)
}

async function rotationDigest(root: string): Promise<string> {
  const bytes = await readFile(path.join(root, 'families', FAMILY, 'rotation.jsonl'))
  return createHash('sha256').update(bytes).digest('hex')
}

test('an unknown family is refused by name and nothing is written', async () => {
  const root = await scratch()
  try {
    const result = await conferDriverAdmission({
      vaultRoot: root,
      familyId: 'not-a-family',
      driverSessionId: 'sess-1',
      turnBoundary: 't1',
      mode: 'enforce',
    })
    assert.equal(result.ok, false)
    assert.equal(result.ok === false ? result.reason : '', 'unknown-family')
    assert.equal(result.family_id, 'not-a-family')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a family with no admitted generation refuses: nothing may commit without one', async () => {
  const root = await scratch()
  try {
    // A family directory but no rotation journal at all.
    const { mkdir } = await import('node:fs/promises')
    await mkdir(path.join(root, 'families', FAMILY), { recursive: true })
    const result = await conferDriverAdmission({
      vaultRoot: root,
      familyId: FAMILY,
      driverSessionId: 'sess-1',
      turnBoundary: 't1',
      mode: 'enforce',
    })
    assert.equal(result.ok, false)
    assert.equal(result.ok === false ? result.reason : '', 'no-generation')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('no scribe refuses in enforce mode and leaves the rotation journal byte-identical', async () => {
  const root = await scratch()
  try {
    await seed(root)
    const before = await rotationDigest(root)
    const result = await conferDriverAdmission({
      vaultRoot: root,
      familyId: FAMILY,
      driverSessionId: 'sess-1',
      turnBoundary: 't1',
      mode: 'enforce',
    })
    assert.equal(result.ok, false)
    assert.equal(result.ok === false ? result.reason : '', 'no-scribe')
    assert.match(result.ok === false ? result.message : '', new RegExp(FAMILY))
    assert.equal(await rotationDigest(root), before, 'a refusal must not touch the rotation journal')
    const records = await readRotationRecords(root, FAMILY)
    assert.equal(records.filter(record => record.kind === 'admission').length, 1, 'only the seed admission')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('monitor mode admits but records why it would have refused', async () => {
  const root = await scratch()
  try {
    await seed(root)
    const result = await conferDriverAdmission({
      vaultRoot: root,
      familyId: FAMILY,
      driverSessionId: 'sess-1',
      turnBoundary: 't1',
      mode: 'monitor',
    })
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.gate, 'monitor')
      assert.equal(result.would_refuse, 'no-scribe')
      assert.equal(result.ordinal, 1)
      assert.equal(result.duplicate, false)
      assert.ok(result.invocation_id.length > 0)
    }
    const records = await readRotationRecords(root, FAMILY)
    const row = records.find(record => record.kind === 'admission' && record.ordinal === 1)!
    assert.equal(row.gate, 'monitor')
    assert.equal(row.would_refuse, 'no-scribe')
    assert.equal(row.driver_session_id, 'sess-1')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a scribe on an older generation is not healthy', async () => {
  const root = await scratch()
  try {
    await seed(root, 'gen-2')
    await writeScribe(root, { session_id: 'scribe-1', generation_id: 'gen-1', started_at: '2026-11-04T00:00:00.000Z' })
    const result = await conferDriverAdmission({
      vaultRoot: root,
      familyId: FAMILY,
      driverSessionId: 'sess-1',
      turnBoundary: 't1',
      mode: 'enforce',
    })
    assert.equal(result.ok, false)
    assert.equal(result.ok === false ? result.reason : '', 'scribe-unhealthy')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a retired scribe is not healthy even when its generation is the active one', async () => {
  const root = await scratch()
  try {
    await seed(root, 'gen-1')
    await writeScribe(root, {
      session_id: 'scribe-1',
      generation_id: 'gen-1',
      retired_at: '2026-11-04T01:00:00.000Z',
    })
    const result = await conferDriverAdmission({
      vaultRoot: root,
      familyId: FAMILY,
      driverSessionId: 'sess-1',
      turnBoundary: 't1',
      mode: 'enforce',
    })
    assert.equal(result.ok, false)
    assert.equal(result.ok === false ? result.reason : '', 'scribe-unhealthy')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a healthy scribe admits exactly once, and a replay does not advance the ordinal', async () => {
  const root = await scratch()
  try {
    await seed(root)
    await writeScribe(root, { session_id: 'scribe-1', generation_id: 'gen-1', started_at: '2026-11-04T00:00:00.000Z' })
    const first = await conferDriverAdmission({
      vaultRoot: root,
      familyId: FAMILY,
      driverSessionId: 'sess-1',
      turnBoundary: 't1',
      mode: 'enforce',
    })
    assert.equal(first.ok, true)
    assert.equal(first.ok && first.ordinal, 1)
    assert.equal(first.ok && first.duplicate, false)
    assert.equal(first.ok && first.would_refuse, null)

    const replay = await conferDriverAdmission({
      vaultRoot: root,
      familyId: FAMILY,
      driverSessionId: 'sess-1',
      turnBoundary: 't1',
      mode: 'enforce',
    })
    assert.equal(replay.ok, true)
    assert.equal(replay.ok && replay.duplicate, true)
    assert.equal(replay.ok && replay.ordinal, 1)
    assert.equal(replay.ok && first.ok && replay.invocation_id, first.invocation_id)

    const records = await readRotationRecords(root, FAMILY)
    assert.equal(records.filter(record => record.kind === 'admission').length, 2, 'seed + one activation')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a caller-supplied invocation id replays without needing the same turn', async () => {
  const root = await scratch()
  try {
    await seed(root)
    await writeScribe(root, { session_id: 'scribe-1', generation_id: 'gen-1' })
    const first = await conferDriverAdmission({
      vaultRoot: root,
      familyId: FAMILY,
      driverSessionId: 'sess-1',
      turnBoundary: 't1',
      invocationId: 'inv:fixed',
      mode: 'enforce',
    })
    assert.equal(first.ok, true)
    const second = await conferDriverAdmission({
      vaultRoot: root,
      familyId: FAMILY,
      driverSessionId: 'sess-1',
      turnBoundary: 'a-different-turn',
      invocationId: 'inv:fixed',
      mode: 'enforce',
    })
    assert.equal(second.ok, true)
    assert.equal(second.ok && second.duplicate, true)
    assert.equal(second.ok && second.ordinal, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a pending rotation refuses new activations until it completes', async () => {
  const root = await scratch()
  try {
    await seed(root)
    await writeScribe(root, { session_id: 'scribe-1', generation_id: 'gen-1' })
    await appendRotationDecision(root, FAMILY, () => ({ kind: 'rotation_intent', generation_id: 'gen-1' }))
    const refused = await conferDriverAdmission({
      vaultRoot: root,
      familyId: FAMILY,
      driverSessionId: 'sess-1',
      turnBoundary: 't1',
      mode: 'enforce',
    })
    assert.equal(refused.ok, false)
    assert.equal(refused.ok === false ? refused.reason : '', 'rotation-pending')

    await appendRotationDecision(root, FAMILY, () => ({ kind: 'rotation', generation_id: 'gen-2' }))
    // A rotation retires the old scribe; the replacement is on the new generation.
    await writeScribe(root, { session_id: 'scribe-2', generation_id: 'gen-2' })
    const admitted = await conferDriverAdmission({
      vaultRoot: root,
      familyId: FAMILY,
      driverSessionId: 'sess-1',
      turnBoundary: 't1',
      mode: 'enforce',
    })
    assert.equal(admitted.ok, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a driverScope pointer write confers no commit authority', async () => {
  const root = await scratch()
  try {
    await seed(root)
    // The bypass shape: a pointer claiming a driver, with no admission for it.
    const pointer = path.join(root, 'pointer.json')
    await writeFile(pointer, JSON.stringify({ rootSessionId: 'root', driverScope: { 'sess-1': ['leaf-1'] } }))
    // A commit still needs an active generation, and an activation only exists
    // through the gate. Without a recorded admission the writer refuses.
    const result = await submitProposals({
      vaultRoot: root,
      familyId: FAMILY,
      generation: 'gen-not-admitted',
      proposals: [
        {
          event_id: 'e1',
          kind: 'decision',
          topic_id: 'relay',
          actor: 'sess-1',
          authority: 'user_ruling',
          evidence_status: 'direct',
          summary: 'a bypass attempt',
          recorded_at: '2026-11-04T10:00:00.000Z',
          capture_version: 'scribe-0.1.0',
          proposed_by: 'sess-1',
        } as never,
      ],
    })
    assert.equal(result.committed.length, 0)
    assert.equal(result.rejected.length, 1)
    assert.match(JSON.stringify(result.rejected), /generation/i)
    assert.equal(await activeGeneration(root, FAMILY), 'gen-1')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function fiveAdmissions(root: string): Promise<void> {
  await seed(root)
  await writeScribe(root, { session_id: 'scribe-1', generation_id: 'gen-1' })
  for (let turn = 1; turn <= 5; turn += 1) {
    const result = await conferDriverAdmission({
      vaultRoot: root,
      familyId: FAMILY,
      driverSessionId: 'sess-1',
      turnBoundary: `turn-${turn}`,
      mode: 'enforce',
    })
    assert.equal(result.ok, true, `admission ${turn} should be admitted`)
  }
}

test('the fifth admitted activation writes exactly one rotation intent', async () => {
  const root = await scratch()
  try {
    await fiveAdmissions(root)
    const records = await readRotationRecords(root, FAMILY)
    const intents = records.filter(record => record.kind === 'rotation_intent')
    assert.equal(intents.length, 1)
    assert.equal(intents[0]?.ordinal, 5)
    assert.equal(intents[0]?.generation_id, 'gen-1')
    assert.equal(await activeGeneration(root, FAMILY), 'gen-1', 'the swap has not been recorded yet')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a sixth activation while the intent is unanswered is refused', async () => {
  const root = await scratch()
  try {
    await fiveAdmissions(root)
    const result = await conferDriverAdmission({
      vaultRoot: root,
      familyId: FAMILY,
      driverSessionId: 'sess-1',
      turnBoundary: 'turn-6',
      mode: 'enforce',
    })
    assert.equal(result.ok, false)
    assert.equal(result.ok === false ? result.reason : '', 'rotation-pending')
    const records = await readRotationRecords(root, FAMILY)
    assert.equal(
      records.filter(record => record.kind === 'admission' && typeof record.invocation_id === 'string').length,
      5,
      'a refused activation is not counted',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a caller cannot supply the reconstruction verdict', async () => {
  const root = await scratch()
  try {
    await fiveAdmissions(root)
    const before = await rotationDigest(root)
    await assert.rejects(
      completeRotation({
        vaultRoot: root,
        familyId: FAMILY,
        fromGeneration: 'gen-1',
        toGeneration: 'gen-2',
        reconstruction: { ok: true, checked: [] },
      } as never),
      /computed by the checker/i,
    )
    assert.equal(await rotationDigest(root), before, 'a refused rotation writes nothing')
    assert.equal(await activeGeneration(root, FAMILY), 'gen-1')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an invariant failure refuses the rotation and writes nothing', async () => {
  const root = await scratch()
  try {
    await fiveAdmissions(root)
    // A current decision that names a topic no topic event creates: the
    // reconstruction cannot be true of this family, however the caller feels.
    await submitProposals({
      vaultRoot: root,
      familyId: FAMILY,
      generation: 'gen-1',
      proposals: [
        {
          event_id: 'ghost-topic-decision',
          kind: 'decision',
          topic_id: 'ghost-topic',
          actor: 'sess-1',
          authority: 'user_ruling',
          evidence_status: 'direct',
          summary: 'a decision under a topic that was never created',
          recorded_at: '2026-11-05T00:00:00.000Z',
          capture_version: 'scribe-0.1.0',
          proposed_by: 'scribe-1',
        } as never,
      ],
    })
    const before = await rotationDigest(root)
    await assert.rejects(
      completeRotation({
        vaultRoot: root,
        familyId: FAMILY,
        fromGeneration: 'gen-1',
        toGeneration: 'gen-2',
      }),
      /did not reconstruct/i,
    )
    assert.equal(await rotationDigest(root), before)
    assert.equal(await activeGeneration(root, FAMILY), 'gen-1')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the checker reports what it proved and what it could not', async () => {
  const root = await scratch()
  try {
    await seed(root)
    const check = await verifyReconstruction(root, FAMILY)
    assert.equal(check.ok, true)
    assert.equal(check.checker, 'gateway-vault/reconstruction-1')
    assert.equal(check.charter, 'not-recorded', 'the charter invariant is named absent, not counted as passed')
    assert.ok(check.checked.includes('watermark'))
    assert.ok(check.checked.includes('journal-hash'))
    assert.equal(check.watermark, 0, 'nothing committed under the family yet')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a verified rotation fences the old generation', async () => {
  const root = await scratch()
  try {
    await fiveAdmissions(root)
    const done = await completeRotation({
      vaultRoot: root,
      familyId: FAMILY,
      fromGeneration: 'gen-1',
      toGeneration: 'gen-2',
    })
    assert.equal(done.to_generation, 'gen-2')
    assert.equal(done.reconstruction.ok, true, 'the verdict is echoed, not only written to the row')
    assert.equal(done.reconstruction.charter, 'not-recorded')
    assert.equal(await activeGeneration(root, FAMILY), 'gen-2')

    // The old generation is now fenced: a commit carrying it is refused.
    const fenced = await submitProposals({
      vaultRoot: root,
      familyId: FAMILY,
      generation: 'gen-1',
      proposals: [
        {
          event_id: 'after-rotation',
          kind: 'decision',
          topic_id: 'relay',
          actor: 'sess-1',
          authority: 'user_ruling',
          evidence_status: 'direct',
          summary: 'written by a retired scribe',
          recorded_at: '2026-11-05T00:00:00.000Z',
          capture_version: 'scribe-0.1.0',
          proposed_by: 'scribe-1',
        } as never,
      ],
    })
    assert.equal(fenced.committed.length, 0)
    assert.match(JSON.stringify(fenced.rejected), /generation/i)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the boundary and its provenance are reported on the admission', async () => {
  const root = await scratch()
  try {
    await seed(root)
    await writeScribe(root, { session_id: 'scribe-1', generation_id: 'gen-1' })
    const explicit = await conferDriverAdmission({
      vaultRoot: root,
      familyId: FAMILY,
      driverSessionId: 'sess-1',
      turnBoundary: 'turn-1',
      boundarySource: 'explicit',
      mode: 'enforce',
    })
    assert.equal(explicit.ok, true)
    assert.equal(explicit.ok && explicit.turn_boundary, 'turn-1')
    assert.equal(explicit.ok && explicit.boundary_source, 'explicit')

    const fallback = await conferDriverAdmission({
      vaultRoot: root,
      familyId: FAMILY,
      driverSessionId: 'sess-2',
      turnBoundary: 'manual',
      boundarySource: 'default',
      mode: 'enforce',
    })
    assert.equal(fallback.ok, true)
    assert.equal(fallback.ok && fallback.boundary_source, 'default')
    const records = await readRotationRecords(root, FAMILY)
    const row = records.find(record => record.invocation_id === (fallback.ok ? fallback.invocation_id : ''))!
    assert.equal(row.boundary_source, 'default')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function writeCharter(root: string, record: Record<string, unknown>): Promise<void> {
  await writeFile(charterPath(root, FAMILY), `${JSON.stringify(record)}\n`)
}

test('a charter that agrees with the family verifies, and the rotation proceeds', async () => {
  const root = await scratch()
  try {
    await fiveAdmissions(root)
    await writeCharter(root, {
      family_id: FAMILY,
      root_session_id: 'root-sess',
      root_name: 'root',
      head_session_id: 'head-sess',
      generation_id: 'gen-1',
      created_at: '2026-11-04T00:00:00.000Z',
    })
    const check = await verifyReconstruction(root, FAMILY, {
      pointer: { rootSessionId: 'root-sess', rootName: 'root', patriarchSessionId: 'head-sess' },
    })
    assert.equal(check.charter, 'verified')
    assert.equal(check.ok, true, check.reasons.join('; '))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a charter naming another family is a mismatch, and the rotation is refused', async () => {
  const root = await scratch()
  try {
    await fiveAdmissions(root)
    await writeCharter(root, { family_id: 'someone-else', root_session_id: 'root-sess', generation_id: 'gen-1' })
    const before = await rotationDigest(root)
    await assert.rejects(
      completeRotation({ vaultRoot: root, familyId: FAMILY, fromGeneration: 'gen-1', toGeneration: 'gen-2' }),
      /did not reconstruct/i,
    )
    assert.equal(await rotationDigest(root), before)
    const check = await verifyReconstruction(root, FAMILY)
    assert.equal(check.charter, 'mismatch')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a charter that disagrees with the pointer is refused', async () => {
  const root = await scratch()
  try {
    await fiveAdmissions(root)
    await writeCharter(root, {
      family_id: FAMILY,
      root_session_id: 'root-sess',
      root_name: 'root',
      head_session_id: 'stale-head',
      generation_id: 'gen-1',
    })
    const check = await verifyReconstruction(root, FAMILY, {
      pointer: { rootSessionId: 'root-sess', rootName: 'root', patriarchSessionId: 'the-head' },
    })
    assert.equal(check.charter, 'mismatch')
    assert.equal(check.ok, false)
    assert.match(check.reasons.join(' '), /head_session_id/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a charter naming a generation the family never admitted is refused', async () => {
  const root = await scratch()
  try {
    await fiveAdmissions(root)
    await writeCharter(root, { family_id: FAMILY, root_session_id: 'root-sess', generation_id: 'gen-invented' })
    const check = await verifyReconstruction(root, FAMILY)
    assert.equal(check.charter, 'mismatch')
    assert.match(check.reasons.join(' '), /gen-invented/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an unregistered family is skipped in monitor and refused in enforce', async () => {
  const root = await scratch()
  try {
    const monitored = await admitDriverDesignation({
      vaultRoot: root,
      familyId: 'not-registered',
      driverSessionId: 'sess-1',
      scope: ['leaf-1'],
      mode: 'monitor',
    })
    assert.equal(monitored, null, 'monitor must not turn an unregistered family into an outage')
    const enforced = await admitDriverDesignation({
      vaultRoot: root,
      familyId: 'not-registered',
      driverSessionId: 'sess-1',
      scope: ['leaf-1'],
      mode: 'enforce',
    })
    assert.equal(enforced?.ok, false)
    assert.equal(enforced && enforced.ok === false ? enforced.reason : '', 'unknown-family')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a registered family admits the designation and writes its charter once', async () => {
  const root = await scratch()
  try {
    await seed(root)
    await writeScribe(root, { session_id: 'scribe-1', generation_id: 'gen-1' })
    const result = await admitDriverDesignation({
      vaultRoot: root,
      familyId: FAMILY,
      driverSessionId: 'sess-1',
      scope: ['leaf-1', 'leaf-2'],
      mode: 'enforce',
      rootName: 'root',
      headSessionId: 'head-1',
    })
    assert.equal(result?.ok, true)

    const charter = await readCharter(root, FAMILY)
    assert.ok(charter)
    assert.equal(charter.family_id, FAMILY)
    assert.equal(charter.root_session_id, FAMILY)
    assert.equal(charter.root_name, 'root')
    assert.equal(charter.head_session_id, 'head-1')
    assert.equal(charter.generation_id, 'gen-1')
    assert.equal((await verifyReconstruction(root, FAMILY)).charter, 'verified')

    // A second designation must not rewrite the charter.
    await admitDriverDesignation({
      vaultRoot: root,
      familyId: FAMILY,
      driverSessionId: 'sess-1',
      scope: ['leaf-3'],
      mode: 'enforce',
      rootName: 'someone-else',
    })
    assert.equal((await readCharter(root, FAMILY))?.root_name, 'root')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the same scope is one designation and a changed scope is another', async () => {
  const root = await scratch()
  try {
    await seed(root)
    await writeScribe(root, { session_id: 'scribe-1', generation_id: 'gen-1' })
    const first = await admitDriverDesignation({
      vaultRoot: root, familyId: FAMILY, driverSessionId: 'sess-1', scope: ['b', 'a'], mode: 'enforce',
    })
    const again = await admitDriverDesignation({
      vaultRoot: root, familyId: FAMILY, driverSessionId: 'sess-1', scope: ['a', 'b'], mode: 'enforce',
    })
    const changed = await admitDriverDesignation({
      vaultRoot: root, familyId: FAMILY, driverSessionId: 'sess-1', scope: ['a'], mode: 'enforce',
    })
    assert.equal(first?.ok && first.duplicate, false)
    assert.equal(again?.ok && again.duplicate, true, 'scope order must not matter')
    assert.equal(changed?.ok && changed.duplicate, false)
    assert.equal(changed?.ok && changed.ordinal, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the harness registers the scribe, and only the harness', async () => {
  const root = await scratch()
  try {
    const missing = await registerScribe({ vaultRoot: root, familyId: 'nope', sessionId: 's1' })
    assert.equal(missing.ok, false)
    assert.equal(missing.ok === false ? missing.reason : '', 'unknown-family')

    const { mkdir } = await import('node:fs/promises')
    await mkdir(path.join(root, 'families', FAMILY), { recursive: true })
    const noGeneration = await registerScribe({ vaultRoot: root, familyId: FAMILY, sessionId: 's1' })
    assert.equal(noGeneration.ok, false)
    assert.equal(noGeneration.ok === false ? noGeneration.reason : '', 'no-generation')

    await seed(root)
    const registered = await registerScribe({ vaultRoot: root, familyId: FAMILY, sessionId: 'scribe-1' })
    assert.equal(registered.ok, true)
    assert.equal(registered.ok && registered.generation_id, 'gen-1')
    assert.equal(registered.ok && registered.replaced, false)
    assert.equal((await readScribe(root, FAMILY))?.session_id, 'scribe-1')

    // The gate now has what it needs.
    const admitted = await conferDriverAdmission({
      vaultRoot: root,
      familyId: FAMILY,
      driverSessionId: 'sess-1',
      turnBoundary: 't1',
      mode: 'enforce',
    })
    assert.equal(admitted.ok, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a healthy scribe is not replaced by accident, and a stale one is', async () => {
  const root = await scratch()
  try {
    await seed(root)
    await registerScribe({ vaultRoot: root, familyId: FAMILY, sessionId: 'scribe-1' })
    const refused = await registerScribe({ vaultRoot: root, familyId: FAMILY, sessionId: 'scribe-2' })
    assert.equal(refused.ok, false)
    assert.equal(refused.ok === false ? refused.reason : '', 'scribe-healthy')
    assert.equal((await readScribe(root, FAMILY))?.session_id, 'scribe-1')

    const replaced = await registerScribe({ vaultRoot: root, familyId: FAMILY, sessionId: 'scribe-2', replace: true })
    assert.equal(replaced.ok, true)
    assert.equal((await readScribe(root, FAMILY))?.session_id, 'scribe-2')

    // After a rotation the old record is stale, so a replacement needs no override.
    await appendRotationDecision(root, FAMILY, () => ({ kind: 'rotation', generation_id: 'gen-2' }))
    const afterRotation = await registerScribe({ vaultRoot: root, familyId: FAMILY, sessionId: 'scribe-3' })
    assert.equal(afterRotation.ok, true)
    assert.equal(afterRotation.ok && afterRotation.generation_id, 'gen-2')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('scribe health is a generation question, not a process question', () => {
  assert.equal(scribeHealth(null, 'gen-1'), 'none')
  assert.equal(scribeHealth({ generation_id: 'gen-1' }, 'gen-1'), 'healthy')
  assert.equal(scribeHealth({ generation_id: 'gen-1' }, 'gen-2'), 'stale')
  assert.equal(scribeHealth({ generation_id: 'gen-1', retired_at: '2026-11-04T00:00:00Z' }, 'gen-1'), 'retired')
  assert.equal(scribeHealth({ generation_id: 'gen-1' }, null), 'stale')
})

test('rotation is pending only while the newest intent is unanswered', () => {
  assert.equal(rotationPending([{ kind: 'admission' }]), false)
  assert.equal(rotationPending([{ kind: 'rotation_intent' }]), true)
  assert.equal(rotationPending([{ kind: 'rotation_intent' }, { kind: 'rotation' }]), false)
  assert.equal(rotationPending([{ kind: 'rotation' }, { kind: 'rotation_intent' }]), true)
})

async function writeObligations(root: string, records: Array<Record<string, unknown>>): Promise<void> {
  await writeFile(
    path.join(root, 'families', FAMILY, 'obligations.jsonl'),
    records.map(record => `${JSON.stringify(record)}\n`).join(''),
  )
}

function pendingObligations(count: number, createdAt = '2026-10-01T00:00:00.000Z'): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_value, index) => ({
    obligation_id: `ob-${index + 1}`,
    state: 'pending',
    created_at: createdAt,
  }))
}

test('a family over its pending cap is refused at activation, naming the counts', async () => {
  const root = await scratch()
  try {
    await seed(root)
    await writeScribe(root, { session_id: 'scribe-1', generation_id: 'gen-1' })
    await writeObligations(root, pendingObligations(3))
    const result = await conferDriverAdmission({
      vaultRoot: root,
      familyId: FAMILY,
      driverSessionId: 'sess-1',
      turnBoundary: 't1',
      mode: 'enforce',
      maxPending: 2,
      overdueHours: 24,
    })
    assert.equal(result.ok, false)
    assert.equal(result.ok === false ? result.reason : '', 'obligation-backlog')
    assert.match(result.ok === false ? result.message : '', /3 pending \(cap 2\), 3 overdue past 24h/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('monitor mode admits an over-cap family and records the counts it would refuse on', async () => {
  const root = await scratch()
  try {
    await seed(root)
    await writeScribe(root, { session_id: 'scribe-1', generation_id: 'gen-1' })
    await writeObligations(root, pendingObligations(3))
    const result = await conferDriverAdmission({
      vaultRoot: root,
      familyId: FAMILY,
      driverSessionId: 'sess-1',
      turnBoundary: 't1',
      mode: 'monitor',
      maxPending: 2,
      overdueHours: 24,
    })
    assert.equal(result.ok, true)
    assert.equal(result.ok && result.would_refuse, 'obligation-backlog')
    assert.deepEqual(result.ok ? result.backlog : null, { pending: 3, overdue: 3, max_pending: 2 })
    const rows = await readRotationRecords(root, FAMILY)
    const row = rows.find(record => record.kind === 'admission' && record.turn_boundary === 't1')
    assert.equal(row?.would_refuse, 'obligation-backlog')
    assert.deepEqual(row?.backlog, { pending: 3, overdue: 3, max_pending: 2 })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('exactly at the cap is admitted, and a null cap is switched off rather than zero', async () => {
  const root = await scratch()
  try {
    await seed(root)
    await writeScribe(root, { session_id: 'scribe-1', generation_id: 'gen-1' })
    await writeObligations(root, pendingObligations(2))
    const atCap = await conferDriverAdmission({
      vaultRoot: root,
      familyId: FAMILY,
      driverSessionId: 'sess-1',
      turnBoundary: 't1',
      mode: 'enforce',
      maxPending: 2,
    })
    assert.equal(atCap.ok, true)
    assert.equal(atCap.ok && atCap.would_refuse, null)

    await writeObligations(root, pendingObligations(50))
    const off = await conferDriverAdmission({
      vaultRoot: root,
      familyId: FAMILY,
      driverSessionId: 'sess-2',
      turnBoundary: 't2',
      mode: 'enforce',
      maxPending: null,
    })
    assert.equal(off.ok, true)
    assert.equal(off.ok && off.would_refuse, null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// --- the obligation creation seam -------------------------------------------

async function obligationRows(root: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(path.join(root, 'families', FAMILY, 'obligations.jsonl'), 'utf8').catch(() => '')
  return raw
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

test('the obligation id and the invocation id come from the same preimage', async () => {
  const root = await scratch()
  try {
    await seed(root)
    await writeScribe(root, { session_id: 'scribe-1', generation_id: 'gen-1' })
    const result = await conferDriverAdmission({
      vaultRoot: root,
      familyId: FAMILY,
      driverSessionId: 'sess-1',
      turnBoundary: 't1',
      mode: 'monitor',
      turn: { text: "we're going with build 30" },
    })
    assert.equal(result.ok, true)
    const invocation = result.ok ? result.invocation_id : ''
    const expected = `ob:${createHash('sha256')
      .update(`${FAMILY}\u0000sess-1\u0000t1`, 'utf8')
      .digest('hex')
      .slice(0, 32)}`
    assert.equal(expected, obligationIdFor(FAMILY, 'sess-1', 't1'))
    assert.equal(result.ok ? result.obligation_id : '', expected)
    assert.equal(expected, `ob:${invocation.slice(4)}`, 'a drift between the two mints would show here')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the same turn twice is one obligation that keeps its first kind', async () => {
  const root = await scratch()
  try {
    await seed(root)
    await writeScribe(root, { session_id: 'scribe-1', generation_id: 'gen-1' })
    const first = await conferDriverAdmission({
      vaultRoot: root,
      familyId: FAMILY,
      driverSessionId: 'sess-1',
      turnBoundary: 't1',
      mode: 'monitor',
      turn: { text: "we're going with build 30" },
    })
    // A later, different opinion about the same turn must not add a second row.
    const second = await conferDriverAdmission({
      vaultRoot: root,
      familyId: FAMILY,
      driverSessionId: 'sess-1',
      turnBoundary: 't1',
      mode: 'monitor',
      turn: { text: 'can you also check the docs' },
    })
    assert.equal(first.ok ? first.obligation_id : '', second.ok ? second.obligation_id : '')
    const rows = await obligationRows(root)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.kind, 'decision')
    assert.match(String(rows[0]?.created_at), /^\d{4}-\d{2}-\d{2}T/)
    assert.equal(rows[0]?.source_turn_id, undefined, 'the field is named turn_boundary')
    assert.equal(rows[0]?.turn_boundary, 't1')
    assert.equal(rows[0]?.driver_session_id, 'sess-1')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('re-evaluating a settled obligation does not resurrect it', async () => {
  const root = await scratch()
  try {
    await seed(root)
    await writeScribe(root, { session_id: 'scribe-1', generation_id: 'gen-1' })
    const first = await conferDriverAdmission({
      vaultRoot: root,
      familyId: FAMILY,
      driverSessionId: 'sess-1',
      turnBoundary: 't1',
      mode: 'monitor',
      turn: { text: "we're going with build 30" },
    })
    assert.ok(first.ok && first.obligation_id)
    await writeFile(
      path.join(root, 'families', FAMILY, 'obligations.jsonl'),
      `${JSON.stringify({ obligation_id: first.ok ? first.obligation_id : '', state: 'satisfied', committed_event_ids: ['e1'] })}\n`,
      { flag: 'a' },
    )
    await conferDriverAdmission({
      vaultRoot: root,
      familyId: FAMILY,
      driverSessionId: 'sess-1',
      turnBoundary: 't1',
      mode: 'monitor',
      turn: { text: "we're going with build 30" },
    })
    const rows = await readObligations(root, FAMILY)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.state, 'satisfied')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('two drivers presenting the same boundary are two obligations', async () => {
  const root = await scratch()
  try {
    await seed(root)
    await writeScribe(root, { session_id: 'scribe-1', generation_id: 'gen-1' })
    for (const driver of ['sess-1', 'sess-2']) {
      await conferDriverAdmission({
        vaultRoot: root,
        familyId: FAMILY,
        driverSessionId: driver,
        turnBoundary: 't1',
        mode: 'monitor',
        turn: { text: "we're going with build 30" },
      })
    }
    const rows = await readObligations(root, FAMILY)
    assert.equal(rows.length, 2, 'a shared boundary must not absorb one driver into another')
    assert.deepEqual(rows.map(row => row.obligation_id).sort(), [
      obligationIdFor(FAMILY, 'sess-1', 't1'),
      obligationIdFor(FAMILY, 'sess-2', 't1'),
    ].sort())
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a refused activation creates nothing, and an ineligible turn owes nothing', async () => {
  const root = await scratch()
  try {
    await seed(root)
    // No scribe: enforce refuses before any admission exists.
    const refused = await conferDriverAdmission({
      vaultRoot: root,
      familyId: FAMILY,
      driverSessionId: 'sess-1',
      turnBoundary: 't1',
      mode: 'enforce',
      turn: { text: "we're going with build 30" },
    })
    assert.equal(refused.ok, false)
    assert.deepEqual(await obligationRows(root), [])

    await writeScribe(root, { session_id: 'scribe-1', generation_id: 'gen-1' })
    const chatter = await conferDriverAdmission({
      vaultRoot: root,
      familyId: FAMILY,
      driverSessionId: 'sess-1',
      turnBoundary: 't2',
      mode: 'monitor',
      turn: { text: 'thanks' },
    })
    assert.equal(chatter.ok, true)
    assert.equal(chatter.ok ? chatter.obligation_id : 'x', undefined)
    assert.deepEqual(await obligationRows(root), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a creation failure is reported on the admission, not thrown', async () => {
  const root = await scratch()
  try {
    await seed(root)
    await writeScribe(root, { session_id: 'scribe-1', generation_id: 'gen-1' })
    // A directory where the queue should be makes the append fail.
    await mkdir(path.join(root, 'families', FAMILY, 'obligations.jsonl'), { recursive: true })
    const result = await conferDriverAdmission({
      vaultRoot: root,
      familyId: FAMILY,
      driverSessionId: 'sess-1',
      turnBoundary: 't1',
      mode: 'monitor',
      turn: { text: "we're going with build 30" },
    })
    assert.equal(result.ok, true, 'the admission is durable; creation is bookkeeping')
    assert.equal(result.ok ? result.obligation_id : 'x', undefined)
    assert.ok((result.ok ? result.obligation_error : '')?.length, 'the failure must be reported')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// --- a duplicate admission that supplies the turn ---------------------------
//
// A duplicate is the same admission, not a closed one. If the first call named
// no turn (or its creation failed), a later call that does name one is the
// first evaluation of that turn and must record it. The repair is an
// `admission_update` folded onto the base row, never a rewrite of it.

const DECISION_TURN = { text: "we're going with build 30" }

async function records(root: string): Promise<Array<Record<string, unknown>>> {
  return readRotationRecords(root, FAMILY)
}

test('a duplicate that supplies the turn writes the obligation and an update, not a second admission', async () => {
  const root = await scratch()
  try {
    await seed(root)
    await writeScribe(root, { session_id: 'scribe-1', generation_id: 'gen-1' })
    const first = await conferDriverAdmission({
      vaultRoot: root,
      familyId: FAMILY,
      driverSessionId: 'sess-1',
      turnBoundary: 't1',
      mode: 'monitor',
    })
    assert.equal(first.ok, true)
    assert.equal(first.ok ? first.obligation_id : 'x', undefined, 'no turn, nothing owed')
    assert.deepEqual(await obligationRows(root), [])

    const retry = await conferDriverAdmission({
      vaultRoot: root,
      familyId: FAMILY,
      driverSessionId: 'sess-1',
      turnBoundary: 't1',
      mode: 'monitor',
      turn: DECISION_TURN,
    })
    assert.equal(retry.ok, true)
    assert.equal(retry.ok ? retry.duplicate : '', true, 'it is the same admission')
    assert.equal(retry.ok ? retry.created : undefined, true, 'this call wrote the row')
    assert.equal(retry.ok ? retry.obligation_id : '', obligationIdFor(FAMILY, 'sess-1', 't1'))
    assert.deepEqual((await obligationRows(root)).map(row => row.obligation_id), [
      obligationIdFor(FAMILY, 'sess-1', 't1'),
    ])

    const all = await records(root)
    const invocationId = retry.ok ? retry.invocation_id : ''
    const admissions = all.filter(record => record.kind === 'admission' && record.invocation_id === invocationId)
    assert.equal(admissions.length, 1, 'the base admission is not rewritten or duplicated')
    assert.equal(admissions[0]?.obligation_id, undefined, 'the base row keeps what was decided at admission time')
    const updates = all.filter(record => record.kind === 'admission_update')
    assert.equal(updates.length, 1, 'one update records the repair')
    assert.deepEqual(
      { invocation_id: updates[0]?.invocation_id, obligation_id: updates[0]?.obligation_id },
      { invocation_id: retry.ok ? retry.invocation_id : '', obligation_id: obligationIdFor(FAMILY, 'sess-1', 't1') },
      'the update names the obligation pair and nothing that would re-decide the admission',
    )
    assert.equal(updates[0]?.gate, undefined)
    assert.equal(updates[0]?.generation_id, undefined)
    assert.equal(updates[0]?.would_refuse, undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a retry of an admission that already has its obligation writes no update', async () => {
  const root = await scratch()
  try {
    await seed(root)
    await writeScribe(root, { session_id: 'scribe-1', generation_id: 'gen-1' })
    const first = await conferDriverAdmission({
      vaultRoot: root,
      familyId: FAMILY,
      driverSessionId: 'sess-1',
      turnBoundary: 't1',
      mode: 'monitor',
      turn: DECISION_TURN,
    })
    assert.equal(first.ok ? first.obligation_id : '', obligationIdFor(FAMILY, 'sess-1', 't1'))
    const retry = await conferDriverAdmission({
      vaultRoot: root,
      familyId: FAMILY,
      driverSessionId: 'sess-1',
      turnBoundary: 't1',
      mode: 'monitor',
      turn: DECISION_TURN,
    })
    assert.equal(retry.ok ? retry.obligation_id : '', obligationIdFor(FAMILY, 'sess-1', 't1'))
    assert.equal(retry.ok ? retry.created : true, undefined, 'nothing was written by the retry')
    assert.equal((await records(root)).filter(record => record.kind === 'admission_update').length, 0)
    assert.equal((await obligationRows(root)).length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a retry of a stored creation error writes the row and the folded view drops the error', async () => {
  const root = await scratch()
  try {
    await seed(root)
    await writeScribe(root, { session_id: 'scribe-1', generation_id: 'gen-1' })
    const obligationId = obligationIdFor(FAMILY, 'sess-1', 't1')
    // The failed first attempt left a durable admission carrying its error.
    await appendRotationDecision(root, FAMILY, () => ({
      kind: 'admission',
      generation_id: 'gen-1',
      invocation_id: `inv:${obligationId.slice(3)}`,
      ordinal: 1,
      driver_session_id: 'sess-1',
      turn_boundary: 't1',
      boundary_source: 'explicit',
      gate: 'monitor',
      obligation_error: 'the vault was read-only',
    }))
    const retry = await conferDriverAdmission({
      vaultRoot: root,
      familyId: FAMILY,
      driverSessionId: 'sess-1',
      turnBoundary: 't1',
      mode: 'monitor',
      turn: DECISION_TURN,
    })
    assert.equal(retry.ok, true)
    assert.equal(retry.ok ? retry.obligation_id : '', obligationId)
    assert.equal(retry.ok ? retry.obligation_error : 'still there', undefined, 'the pair is replaced, not merged')
    assert.equal(retry.ok ? retry.created : undefined, true)
    const [row] = await readObligations(root, FAMILY)
    assert.equal(row?.obligation_id, obligationId)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a retry whose creation fails again appends nothing and reports the new error', async () => {
  const root = await scratch()
  try {
    await seed(root)
    await writeScribe(root, { session_id: 'scribe-1', generation_id: 'gen-1' })
    await conferDriverAdmission({
      vaultRoot: root,
      familyId: FAMILY,
      driverSessionId: 'sess-1',
      turnBoundary: 't1',
      mode: 'monitor',
    })
    // A directory where the queue should be makes the append fail again.
    await mkdir(path.join(root, 'families', FAMILY, 'obligations.jsonl'), { recursive: true })
    const retry = await conferDriverAdmission({
      vaultRoot: root,
      familyId: FAMILY,
      driverSessionId: 'sess-1',
      turnBoundary: 't1',
      mode: 'monitor',
      turn: DECISION_TURN,
    })
    assert.equal(retry.ok, true)
    assert.equal(retry.ok ? retry.obligation_id : 'x', undefined)
    assert.ok((retry.ok ? retry.obligation_error : '')?.length)
    assert.equal((await records(root)).filter(record => record.kind === 'admission_update').length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an admission_update moves none of the three counters the rotation protocol reads', async () => {
  const root = await scratch()
  try {
    await seed(root)
    await writeScribe(root, { session_id: 'scribe-1', generation_id: 'gen-1' })
    const first = await conferDriverAdmission({
      vaultRoot: root,
      familyId: FAMILY,
      driverSessionId: 'sess-1',
      turnBoundary: 't1',
      mode: 'monitor',
    })
    assert.equal(first.ok ? first.ordinal : 0, 1)
    const before = {
      generation: await activeGeneration(root, FAMILY),
      pending: rotationPending(await records(root)),
      digest: await rotationDigest(root),
    }

    const retry = await conferDriverAdmission({
      vaultRoot: root,
      familyId: FAMILY,
      driverSessionId: 'sess-1',
      turnBoundary: 't1',
      mode: 'monitor',
      turn: DECISION_TURN,
    })
    assert.equal(retry.ok ? retry.created : undefined, true)

    assert.equal(await activeGeneration(root, FAMILY), before.generation, 'an update is not a generation')
    assert.equal(rotationPending(await records(root)), before.pending, 'an update is not a rotation intent')
    assert.notEqual(await rotationDigest(root), before.digest, 'the file did change; it just changed nothing the protocol reads')

    // The ordinal is still "how many admissions exist": the next activation is
    // the second, not the third.
    const next = await conferDriverAdmission({
      vaultRoot: root,
      familyId: FAMILY,
      driverSessionId: 'sess-1',
      turnBoundary: 't2',
      mode: 'monitor',
    })
    assert.equal(next.ok ? next.ordinal : 0, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
