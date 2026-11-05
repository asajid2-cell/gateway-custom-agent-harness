import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  conferDriverAdmission,
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
