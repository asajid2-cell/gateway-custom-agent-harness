import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { admitGeneration } from '../src/utils/vault/journal.js'
import {
  captureCompleteness,
  capturePointer,
  listCaptures,
  markCaptured,
  type CapturePointer,
} from '../src/utils/vault/capture.js'

const FAMILY = 'fam-capture'

function pointer(overrides: Partial<CapturePointer> = {}): CapturePointer {
  return {
    session_id: 'sess-1',
    message_id: 'msg-1',
    transcript_root: 'claude-projects',
    relative_path: 'C--Users-Ahmed/6e54a075.jsonl',
    span_sha256: 'sha256:abc123',
    observed_at: '2026-11-05T00:00:00.000Z',
    ...overrides,
  }
}

async function vault(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'vault-capture-'))
  await admitGeneration(root, FAMILY, { kind: 'admission', generation_id: 'gen-1' })
  return root
}

test('a span is captured once and the second identical capture is a duplicate', async () => {
  const root = await vault()
  try {
    const first = await capturePointer({ vaultRoot: root, familyId: FAMILY, pointer: pointer() })
    assert.equal(first.ok, true)
    assert.equal(first.ok && first.duplicate, false)
    const again = await capturePointer({ vaultRoot: root, familyId: FAMILY, pointer: pointer() })
    assert.equal(again.ok, true)
    assert.equal(again.ok && again.duplicate, true)
    assert.equal(again.ok && first.ok && again.capture_id, first.capture_id)
    assert.equal((await listCaptures(root, FAMILY)).length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an absolute or escaping path is refused, because a moved root would dangle it', async () => {
  const root = await vault()
  try {
    const absolute = await capturePointer({
      vaultRoot: root,
      familyId: FAMILY,
      pointer: pointer({ relative_path: 'C:/Users/Ahmed/x.jsonl' }),
    })
    assert.equal(absolute.ok, false)
    assert.equal(absolute.ok === false ? absolute.reason : '', 'absolute-path')

    const escaping = await capturePointer({
      vaultRoot: root,
      familyId: FAMILY,
      pointer: pointer({ relative_path: '../outside.jsonl' }),
    })
    assert.equal(escaping.ok, false)
    assert.equal(escaping.ok === false ? escaping.reason : '', 'parent-path')

    const unixAbsolute = await capturePointer({
      vaultRoot: root,
      familyId: FAMILY,
      pointer: pointer({ relative_path: '/tmp/x.jsonl' }),
    })
    assert.equal(unixAbsolute.ok, false)
    assert.equal(unixAbsolute.ok === false ? unixAbsolute.reason : '', 'absolute-path')
    assert.equal((await listCaptures(root, FAMILY)).length, 0, 'a refusal writes nothing')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('marking a capture names the event that cited it, and is idempotent', async () => {
  const root = await vault()
  try {
    const captured = await capturePointer({ vaultRoot: root, familyId: FAMILY, pointer: pointer() })
    assert.ok(captured.ok)
    const captureId = captured.ok ? captured.capture_id : ''
    assert.deepEqual(await captureCompleteness(root, FAMILY), { captured: 0, pending: 1 })

    const marked = await markCaptured({ vaultRoot: root, familyId: FAMILY, captureId, eventId: 'evt-1' })
    assert.equal(marked.ok, true)
    assert.equal(marked.ok && marked.duplicate, false)

    const entries = await listCaptures(root, FAMILY)
    assert.equal(entries[0]?.captured_by?.event_id, 'evt-1', 'the event id is recorded, not just a boolean')
    assert.deepEqual(await captureCompleteness(root, FAMILY), { captured: 1, pending: 0 })
    assert.deepEqual(await listCaptures(root, FAMILY, { pendingOnly: true }), [])

    const again = await markCaptured({ vaultRoot: root, familyId: FAMILY, captureId, eventId: 'evt-2' })
    assert.equal(again.ok, true)
    assert.equal(again.ok && again.duplicate, true)
    assert.equal((await listCaptures(root, FAMILY))[0]?.captured_by?.event_id, 'evt-1', 'a second mark does not rewrite history')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('marking a capture that was never recorded is refused', async () => {
  const root = await vault()
  try {
    const result = await markCaptured({ vaultRoot: root, familyId: FAMILY, captureId: 'cap:nope', eventId: 'evt-1' })
    assert.equal(result.ok, false)
    assert.equal(result.ok === false ? result.reason : '', 'unknown-capture')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a different span is a different capture, and the queue is append-only', async () => {
  const root = await vault()
  try {
    await capturePointer({ vaultRoot: root, familyId: FAMILY, pointer: pointer({ span_sha256: 'sha256:one' }) })
    await capturePointer({ vaultRoot: root, familyId: FAMILY, pointer: pointer({ span_sha256: 'sha256:two' }) })
    await capturePointer({ vaultRoot: root, familyId: FAMILY, pointer: pointer({ message_id: 'msg-2' }) })
    assert.equal((await listCaptures(root, FAMILY)).length, 3)
    assert.equal((await listCaptures(root, FAMILY, { pendingOnly: true })).length, 3)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
