import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { admitGeneration } from '../src/utils/vault/journal.js'
import { submitProposals } from '../src/utils/vault/submit.js'
import {
  captureCompleteness,
  capturePointer,
  captureTranscript,
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
    const before = await captureCompleteness(root, FAMILY)
    assert.equal(before.captured, 0)
    assert.equal(before.pending, 1)
    assert.equal(before.state, 'healthy')
    assert.equal(before.producer, 'absent', 'a hand-recorded span does not mean the hook is running')

    const marked = await markCaptured({ vaultRoot: root, familyId: FAMILY, captureId, eventId: 'evt-1' })
    assert.equal(marked.ok, true)
    assert.equal(marked.ok && marked.duplicate, false)

    const entries = await listCaptures(root, FAMILY)
    assert.equal(entries[0]?.captured_by?.event_id, 'evt-1', 'the event id is recorded, not just a boolean')
    const after = await captureCompleteness(root, FAMILY)
    assert.equal(after.captured, 1)
    assert.equal(after.pending, 0)
    assert.equal(after.state, 'healthy')
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

test('a commit that cites a span closes the capture, naming the event', async () => {
  const root = await vault()
  try {
    await capturePointer({ vaultRoot: root, familyId: FAMILY, pointer: pointer({ span_sha256: 'sha256:cited' }) })
    await capturePointer({ vaultRoot: root, familyId: FAMILY, pointer: pointer({ span_sha256: 'sha256:notcited' }) })

    const result = await submitProposals({
      vaultRoot: root,
      familyId: FAMILY,
      generation: 'gen-1',
      proposals: [
        {
          event_id: 'evt-cited',
          kind: 'decision',
          topic_id: 'relay',
          actor: 'sess-1',
          authority: 'user_ruling',
          evidence_status: 'direct',
          summary: 'a decision that cites the recorded span',
          recorded_at: '2026-11-05T00:00:00.000Z',
          capture_version: 'scribe-0.1.0',
          proposed_by: 'sess-1',
          evidence: [{ message_id: 'msg-1', span_sha256: 'sha256:cited' }],
        } as never,
      ],
    })
    assert.equal(result.committed.length, 1)
    assert.equal(result.capturesMarked, 1)

    const entries = await listCaptures(root, FAMILY)
    const cited = entries.find(entry => entry.span_sha256 === 'sha256:cited')!
    const untouched = entries.find(entry => entry.span_sha256 === 'sha256:notcited')!
    assert.equal(cited.captured_by?.event_id, 'evt-cited')
    assert.equal(untouched.captured_by, undefined, 'an unrelated span stays pending')
    const completeness = await captureCompleteness(root, FAMILY)
    assert.equal(completeness.captured, 1)
    assert.equal(completeness.pending, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a family that commits events with no captures says so instead of reading complete', async () => {
  const root = await vault()
  try {
    const idle = await captureCompleteness(root, FAMILY)
    assert.equal(idle.state, 'idle', 'nothing committed and nothing captured is not a defect')

    await submitProposals({
      vaultRoot: root,
      familyId: FAMILY,
      generation: 'gen-1',
      proposals: [
        {
          event_id: 'evt-uncaptured',
          kind: 'decision',
          topic_id: 'relay',
          actor: 'sess-1',
          authority: 'user_ruling',
          evidence_status: 'direct',
          summary: 'an event whose span was never queued',
          recorded_at: '2026-11-05T00:00:00.000Z',
          capture_version: 'scribe-0.1.0',
          proposed_by: 'sess-1',
          evidence: [{ message_id: 'msg-x', span_sha256: 'sha256:never-queued' }],
        } as never,
      ],
    })

    const without = await captureCompleteness(root, FAMILY)
    assert.equal(without.state, 'no-captures')
    assert.equal(without.producer, 'absent')
    assert.equal(without.committed_events, 1)
    assert.equal(without.captured, 0)
    assert.match(without.note ?? '', /0 of nothing/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the producer reads a transcript once, and a restart appends nothing twice', async () => {
  const root = await vault()
  const scratch = await mkdtemp(path.join(tmpdir(), 'transcript-'))
  try {
    const transcript = path.join(scratch, 'session.jsonl')
    const lines = [
      { type: 'user', uuid: 'm1', timestamp: '2026-11-05T00:00:00.000Z', message: { role: 'user', content: 'ship build 30' } },
      {
        type: 'assistant',
        uuid: 'm2',
        timestamp: '2026-11-05T00:01:00.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'the relay moves' }] },
      },
      { type: 'progress', note: 'no uuid and no text' },
    ]
    await writeFile(transcript, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`)

    const first = await captureTranscript({
      vaultRoot: root,
      familyId: FAMILY,
      transcriptRoot: 'claude-projects',
      transcriptPath: transcript,
      relativePath: 'C--Users-Ahmed/session.jsonl',
      sessionId: 'sess-1',
    })
    assert.deepEqual(first, { appended: 2, duplicates: 0, skipped: 1 })

    const entries = await listCaptures(root, FAMILY)
    assert.equal(entries.length, 2)
    assert.ok(entries.every(entry => entry.by === 'capture-hook'), 'the hook is named on the record')
    const completeness = await captureCompleteness(root, FAMILY)
    assert.equal(completeness.producer, 'connected', 'connected means the hook appended, not that something exists')
    assert.equal(completeness.pending, 2)

    const again = await captureTranscript({
      vaultRoot: root,
      familyId: FAMILY,
      transcriptRoot: 'claude-projects',
      transcriptPath: transcript,
      relativePath: 'C--Users-Ahmed/session.jsonl',
      sessionId: 'sess-1',
    })
    assert.deepEqual(again, { appended: 0, duplicates: 2, skipped: 1 }, 'a restart appends nothing twice')
    assert.equal((await listCaptures(root, FAMILY)).length, 2)
  } finally {
    await rm(scratch, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test('a hand-recorded capture does not make the producer look connected', async () => {
  const root = await vault()
  try {
    await capturePointer({ vaultRoot: root, familyId: FAMILY, pointer: pointer() })
    assert.equal((await captureCompleteness(root, FAMILY)).producer, 'absent')
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
