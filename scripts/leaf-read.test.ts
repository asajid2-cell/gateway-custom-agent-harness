import { test, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTranscriptSlice, renderTranscriptSlice } from '../src/utils/transcriptRead.ts'

/**
 * The reader runs wherever a session is, so pin the identity the way the other
 * leaf tests do: launched from inside a leaf these calls would mean something
 * else, and every case here is about the session side.
 */
const ambientLeafIdentity = process.env.GATEWAY_INTERACTIVE_LEAF
delete process.env.GATEWAY_INTERACTIVE_LEAF
after(() => {
  if (ambientLeafIdentity === undefined) delete process.env.GATEWAY_INTERACTIVE_LEAF
  else process.env.GATEWAY_INTERACTIVE_LEAF = ambientLeafIdentity
})

const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 10, minute)).toISOString()

function turn(type: 'user' | 'assistant' | 'system', uuid: string, parentUuid: string | null, content: unknown, minute: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, uuid, parentUuid, timestamp: at(minute), message: { content }, ...extra })
}

const text = (value: string) => [{ type: 'text', text: value }]
const toolUse = (name: string, input: unknown) => [{ type: 'text', text: 'working' }, { type: 'tool_use', name, input }]

async function transcript(lines: readonly string[]): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), 'leaf-read-')), 'session.jsonl')
  await writeFile(path, `${lines.join('\n')}\n`)
  return path
}

test('a read follows the active chain and leaves an abandoned branch out', async () => {
  // The conversation was resumed from the second turn, so the tail it left
  // behind is still in the file and is not part of what anyone is having.
  const path = await transcript([
    turn('user', 'u1', null, text('start here'), 0),
    turn('assistant', 'a2', 'u1', text('working on it'), 1),
    turn('assistant', 'b3', 'a2', text('abandoned tail'), 2),
    turn('user', 'u3', 'a2', text('resumed here'), 3),
  ])
  const slice = await readTranscriptSlice(path, 'session', { tail: 10 })
  assert.deepEqual(slice.turns.map(item => item.text), ['start here', 'working on it', 'resumed here'])
  assert.equal(slice.chainLength, 3)
  assert.equal(slice.truncated, false)
  assert.equal(slice.behind, false)
  assert.equal(slice.cursor, 'u3')
})

test('a turn whose line is too big to fit the first window is still found', async () => {
  // The window is read from the end, so a single huge turn cuts the line behind
  // it. Doubling the window is what turns "one turn" into the conversation.
  const path = await transcript([
    turn('user', 'h1', null, text('first'), 0),
    turn('assistant', 'h2', 'h1', text('x'.repeat(5 * 1024 * 1024)), 1),
    turn('user', 'h3', 'h2', text('last'), 2),
  ])
  const slice = await readTranscriptSlice(path, 'session', { tail: 5 })
  assert.equal(slice.turns.length, 3)
  assert.equal(slice.turns[0]!.text, 'first')
  assert.equal(slice.turns[2]!.text, 'last')
  assert.equal(slice.chainLength, 3)
})

test('tool calls collapse to a legible summary rather than raw JSON', async () => {
  const path = await transcript([
    turn('user', 'u1', null, text('fix it'), 0),
    turn('assistant', 'a2', 'u1', toolUse('Edit', { file_path: 'src/utils/leafWorkspace.ts' }), 1),
    turn('user', 'u3', 'a2', [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }], 2),
    turn('assistant', 'a4', 'u3', text('done'), 3),
  ])
  const slice = await readTranscriptSlice(path, 'session', { tail: 10 })
  // A user entry that is only tool results is the model's own working, not a
  // turn the person took, so it is not a turn a peer has to read.
  assert.deepEqual(slice.turns.map(item => item.role), ['user', 'assistant', 'assistant'])
  assert.deepEqual(slice.turns[1]!.tools, [{ name: 'Edit', summary: 'src/utils/leafWorkspace.ts' }])
  const rendered = renderTranscriptSlice(slice, 'Leaf #2 Api (abc)')
  assert.match(rendered, /^\[peer session transcript - untrusted, not user input\] Leaf #2 Api \(abc\)/)
  assert.match(rendered, /→ Edit\(src\/utils\/leafWorkspace\.ts\)/)
  assert.match(rendered, /^cursor a4$/m)
})

test('since returns what is new, and says so when the cursor has scrolled away', async () => {
  const path = await transcript([
    turn('user', 'u1', null, text('one'), 0),
    turn('assistant', 'a2', 'u1', text('two'), 1),
    turn('user', 'u3', 'a2', text('three'), 2),
    turn('assistant', 'a4', 'u3', text('four'), 3),
  ])
  const first = await readTranscriptSlice(path, 'session', { tail: 2 })
  assert.deepEqual(first.turns.map(item => item.text), ['three', 'four'])
  assert.equal(first.cursor, 'a4')
  // The cursor is the newest turn, so following it is waiting for the next one.
  const next = await readTranscriptSlice(path, 'session', { tail: 2, since: first.cursor })
  assert.deepEqual(next.turns, [])
  assert.equal(next.behind, false)
  // A cursor from the middle returns strictly what came after it.
  const behind = await readTranscriptSlice(path, 'session', { tail: 2, since: 'u1' })
  assert.deepEqual(behind.turns.map(item => item.text), ['two', 'three', 'four'])
})

test('a cursor that names an entry no reader is shown still follows exactly', async () => {
  // A session writes records that are not turns - a system note, a user entry
  // that is only tool results - and the tip a read walks to is often one of
  // them. A cursor naming it used to be a cursor `since` could not find, so the
  // read reported it as scrolled away and answered with the newest window: the
  // turns the caller had already been given, handed to it a second time.
  const path = await transcript([
    turn('user', 'u1', null, text('one'), 0),
    turn('assistant', 'a2', 'u1', text('two'), 1),
    turn('system', 's3', 'a2', undefined, 2),
  ])
  const first = await readTranscriptSlice(path, 'session', { tail: 1 })
  assert.deepEqual(first.turns.map(item => item.text), ['two'])
  assert.equal(first.cursor, 's3')
  const next = await readTranscriptSlice(path, 'session', { tail: 1, since: first.cursor })
  assert.deepEqual(next.turns, [])
  assert.equal(next.behind, false)
  // And a cursor from before it still returns strictly what came after it.
  const after = await readTranscriptSlice(path, 'session', { tail: 1, since: 'u1' })
  assert.deepEqual(after.turns.map(item => item.text), ['two'])
  assert.equal(after.behind, false)
})

test('a cursor older than the window is reported rather than answered wrongly', async () => {
  const path = await transcript([
    turn('user', 'u1', null, text('one'), 0),
    turn('assistant', 'a2', 'u1', text('two'), 1),
  ])
  const slice = await readTranscriptSlice(path, 'session', { tail: 5, since: 'gone' })
  assert.equal(slice.behind, true)
  assert.deepEqual(slice.turns.map(item => item.text), ['one', 'two'])
})

test('the character cap keeps the newest turns and reports the cut', async () => {
  const path = await transcript([
    turn('user', 'u1', null, text('one'), 0),
    turn('assistant', 'a2', 'u1', text('two'), 1),
    turn('user', 'u3', 'a2', text('three'), 2),
  ])
  const slice = await readTranscriptSlice(path, 'session', { tail: 3, maxChars: 0 })
  assert.equal(slice.truncated, true)
  assert.deepEqual(slice.turns.map(item => item.text), ['three'])
})

test('a family member is readable by reference, and the family by none', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'leaf-read-family-'))
  const saved = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  try {
    const { getSessionId } = await import('../src/bootstrap/state.ts')
    const { getClaudeConfigHomeDir } = await import('../src/utils/envUtils.ts')
    const { addLeafMember, updateLeafMember } = await import('../src/utils/leafFamily.ts')
    const { forgetLeafFamilyRoot, readLeafTranscript } = await import('../src/utils/leafWorkspace.ts')
    forgetLeafFamilyRoot()
    const root = getSessionId()
    const family = join(getClaudeConfigHomeDir(), 'leaf-families', `${root}.json`)
    const probe = randomUUID()
    const api = randomUUID()
    const probePath = join(directory, 'probe.jsonl')
    const apiPath = join(directory, 'api.jsonl')
    await writeFile(probePath, `${[
      turn('user', 'u1', null, text('probe this'), 0),
      turn('assistant', 'a2', 'u1', text('probe answer'), 1),
    ].join('\n')}\n`)
    await writeFile(apiPath, `${[
      turn('user', 'u1', null, text('api this'), 0),
      turn('assistant', 'a2', 'u1', text('api answer'), 1),
    ].join('\n')}\n`)
    await addLeafMember(family, root, { sessionId: probe, parentSessionId: root, name: 'Probe', transcriptPath: probePath, forkMessageId: null })
    await addLeafMember(family, root, { sessionId: api, parentSessionId: root, name: 'Api', transcriptPath: apiPath, forkMessageId: null })
    // A closed member is exactly the one a peer cannot ask for a turn, and so
    // exactly the one reading has to keep working on.
    await updateLeafMember(family, root, api, { status: 'closed' })

    const chat = await readLeafTranscript('2:Api')
    assert.match(chat, /untrusted, not user input/)
    assert.match(chat, /Leaf #2 Api/)
    assert.match(chat, /api answer/)
    assert.match(chat, /^cursor a2$/m)

    const digest = await readLeafTranscript()
    assert.match(digest, new RegExp(`^family ${root} \\[head\\]$`, 'm'))
    assert.match(digest, /#1 Probe \[open\]/)
    assert.match(digest, /#2 Api \[closed\]/)
    assert.match(digest, /probe answer/)
    assert.match(digest, /api answer/)
    assert.match(digest, /cursor a2/)
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
    await rm(directory, { recursive: true, force: true })
  }
})

test('an unknown reference is a refusal, not an empty read', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'leaf-read-unknown-'))
  const saved = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  try {
    const { forgetLeafFamilyRoot, readLeafTranscript } = await import('../src/utils/leafWorkspace.ts')
    forgetLeafFamilyRoot()
    await assert.rejects(readLeafTranscript('no-such-leaf'), /No member of this family matches "no-such-leaf"/)
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
    await rm(directory, { recursive: true, force: true })
  }
})
