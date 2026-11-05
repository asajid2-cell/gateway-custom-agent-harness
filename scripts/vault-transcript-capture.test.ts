import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { captureTranscript } from '../src/utils/vault/capture.js'
import { captureTranscriptTurn, PROJECTS_ROOT } from '../src/utils/vault/transcriptCapture.js'

/**
 * The producer that rides `recordTranscript`.
 *
 * Every case drives the same three preconditions a turn meets: is there a vault,
 * is there a family, and is the pointer's path inside the one named root. The
 * states are asserted exactly, because "not applicable" and "nothing recorded
 * yet" are the two zeros that a monitoring surface must not add together.
 */

const SESSION = 'sess-1'
const FAMILY = 'root-1'

async function scratch(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'vault-transcript-capture-'))
}

function transcriptPath(configHome: string): string {
  return path.join(configHome, PROJECTS_ROOT, 'proj', `${SESSION}.jsonl`)
}

function userMessage(uuid: string, text: string): Record<string, unknown> {
  return { uuid, type: 'user', timestamp: '2026-11-05T00:00:00.000Z', message: { role: 'user', content: text } }
}

async function captureRows(vaultRoot: string, familyId = FAMILY): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(path.join(vaultRoot, 'families', familyId, 'captures.jsonl'), 'utf8').catch(() => '')
  return raw
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

test('a machine with no vault root records nothing, and the capture does not create one', async () => {
  const home = await scratch()
  try {
    const vaultRoot = path.join(home, 'vaults', 'main')
    const outcome = await captureTranscriptTurn({
      sessionId: SESSION,
      transcriptPath: transcriptPath(home),
      messages: [userMessage('m1', 'hello')],
      configHome: home,
      settings: { vaultRoot },
      resolveFamilyRoot: async () => FAMILY,
      familyFileExists: async () => true,
    })
    assert.equal(outcome.ok, false)
    if (outcome.ok === false && outcome.reason !== 'failed') {
      assert.equal(outcome.reason, 'vault-root-absent')
      assert.equal(outcome.state, 'no-captures')
      assert.match(outcome.note, /does not create one/)
    } else {
      assert.fail('an absent vault root must be reported as a skip, not a failure')
    }
    assert.equal(existsSync(vaultRoot), false, 'capture must never provision a vault')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a session with no family records nothing and says why', async () => {
  const home = await scratch()
  try {
    const vaultRoot = path.join(home, 'vault')
    await mkdir(vaultRoot, { recursive: true })
    const outcome = await captureTranscriptTurn({
      sessionId: SESSION,
      transcriptPath: transcriptPath(home),
      messages: [userMessage('m1', 'hello')],
      configHome: home,
      settings: { vaultRoot },
      resolveFamilyRoot: async () => SESSION,
      familyFileExists: async () => false,
    })
    assert.equal(outcome.ok, false)
    if (outcome.ok === false && outcome.reason !== 'failed') {
      assert.equal(outcome.reason, 'no-family')
      assert.equal(outcome.state, 'no-captures')
    } else {
      assert.fail('a session with no family must be reported as a skip')
    }
    assert.equal(existsSync(path.join(vaultRoot, 'families')), false, 'nothing may be written without an owner')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a family turn records one pointer per message that has a span, and a replay adds none', async () => {
  const home = await scratch()
  try {
    const vaultRoot = path.join(home, 'vault')
    await mkdir(vaultRoot, { recursive: true })
    const messages = [
      userMessage('m1', 'hello'),
      { uuid: 'm2', type: 'assistant', message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } },
      { uuid: 'm3', type: 'assistant', message: { content: [] } },
      { type: 'progress', message: { content: 'no id, not a span' } },
    ]
    const input = {
      sessionId: SESSION,
      transcriptPath: transcriptPath(home),
      messages,
      configHome: home,
      settings: { vaultRoot },
      resolveFamilyRoot: async () => FAMILY,
      familyFileExists: async () => true,
    }
    const first = await captureTranscriptTurn(input)
    assert.equal(first.ok, true)
    if (first.ok) assert.deepEqual(first.result, { appended: 2, duplicates: 0, skipped: 2 })

    const rows = await captureRows(vaultRoot)
    assert.equal(rows.length, 2)
    for (const row of rows) {
      assert.equal(row.kind, 'capture')
      assert.equal(row.transcript_root, PROJECTS_ROOT)
      assert.equal(row.relative_path, 'proj/sess-1.jsonl', 'forward-slashed, below the named root')
      assert.equal(row.session_id, SESSION)
      assert.match(String(row.span_sha256), /^sha256:[0-9a-f]{64}$/)
    }

    const second = await captureTranscriptTurn(input)
    assert.equal(second.ok, true)
    if (second.ok) assert.deepEqual(second.result, { appended: 0, duplicates: 2, skipped: 2 })
    assert.equal((await captureRows(vaultRoot)).length, 2, 'a replay is idempotent')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('the hook and the file tailer derive the same capture for the same message', async () => {
  const home = await scratch()
  try {
    const vaultRoot = path.join(home, 'vault')
    await mkdir(vaultRoot, { recursive: true })
    const file = transcriptPath(home)
    await mkdir(path.dirname(file), { recursive: true })
    const message = userMessage('m1', 'hello')
    await writeFile(file, `${JSON.stringify(message)}\n`)

    // The tailer reads the committed line; the hook holds the same message in
    // memory. One text definition means one capture, not two that happen to
    // share an id today.
    const tailer = await captureTranscript({
      vaultRoot,
      familyId: FAMILY,
      transcriptRoot: PROJECTS_ROOT,
      transcriptPath: file,
      relativePath: 'proj/sess-1.jsonl',
      sessionId: SESSION,
    })
    assert.equal(tailer.appended, 1)

    const hook = await captureTranscriptTurn({
      sessionId: SESSION,
      transcriptPath: file,
      messages: [message],
      configHome: home,
      settings: { vaultRoot },
      resolveFamilyRoot: async () => FAMILY,
      familyFileExists: async () => true,
    })
    assert.equal(hook.ok, true)
    if (hook.ok) assert.deepEqual(hook.result, { appended: 0, duplicates: 1, skipped: 0 })
    assert.equal((await captureRows(vaultRoot)).length, 1)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a transcript outside the named root is refused rather than pointed at', async () => {
  const home = await scratch()
  try {
    const vaultRoot = path.join(home, 'vault')
    await mkdir(vaultRoot, { recursive: true })
    const outcome = await captureTranscriptTurn({
      sessionId: SESSION,
      transcriptPath: path.join(home, 'elsewhere', `${SESSION}.jsonl`),
      messages: [userMessage('m1', 'hello')],
      configHome: home,
      settings: { vaultRoot },
      resolveFamilyRoot: async () => FAMILY,
      familyFileExists: async () => true,
    })
    assert.equal(outcome.ok, false)
    assert.equal(outcome.ok === false ? outcome.reason : '', 'failed')
    assert.match(outcome.ok === false && outcome.reason === 'failed' ? outcome.message : '', /not below/)
    assert.equal(existsSync(path.join(vaultRoot, 'families')), false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
