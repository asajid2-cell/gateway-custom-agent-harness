import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  condenseTranscript,
  listReportTargets,
  resolveSessionTarget,
} from '../src/utils/sessionReport.ts'

/**
 * Condensation is the part of a handoff report that must be true rather than
 * well written.
 *
 * The tests below are written against a synthetic transcript because the facts
 * a report leans on are exactly the facts a real session buries: an instruction
 * is not a tool result, a compact summary is not an instruction, "0 fail" is not
 * a failure, and a repeated command must not overwrite an earlier verdict. Each
 * test names the misreading it prevents, since a wrong fact in a handoff is
 * worse than a missing one - the new session cannot tell which it is.
 */

const SESSION_ID = '11111111-1111-4111-8111-111111111111'

/** Records are newline-delimited JSON, and the shapes below are copied from a
 *  real transcript: content is a string in older records and a block array in
 *  newer ones, often in the same file. */
const user = (text: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'user',
    uuid: 'u' + text.length + Math.random().toString(36).slice(2),
    timestamp: '2026-09-26T10:00:00.000Z',
    cwd: 'C:\\proj',
    gitBranch: 'main',
    version: '1.0.0',
    message: { role: 'user', content: text },
    ...extra,
  })

const userBlocks = (blocks: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'user',
    uuid: 'ub' + Math.random().toString(36).slice(2),
    timestamp: '2026-09-26T10:00:01.000Z',
    message: { role: 'user', content: blocks },
    ...extra,
  })

const assistant = (blocks: unknown[]) =>
  JSON.stringify({
    type: 'assistant',
    uuid: 'a' + Math.random().toString(36).slice(2),
    timestamp: '2026-09-26T10:00:02.000Z',
    message: { role: 'assistant', content: blocks },
  })

const toolUse = (id: string, name: string, input: Record<string, unknown>) =>
  assistant([{ type: 'tool_use', id, name, input }])

const toolResult = (id: string, content: string, isError = false) =>
  userBlocks([{ type: 'tool_result', tool_use_id: id, content, is_error: isError }])

const compactBoundary = () =>
  JSON.stringify({
    type: 'system',
    subtype: 'compact_boundary',
    uuid: 'cb1',
    timestamp: '2026-09-26T10:00:05.000Z',
    content: 'Conversation compacted',
    compactMetadata: { trigger: 'auto', preTokens: 150000, messagesSummarized: 42 },
  })

async function withTranscript(
  lines: string[],
  options: { subagents?: number } = {},
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'session-report-'))
  const dir = join(root, 'projects', 'C--proj')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${SESSION_ID}.jsonl`)
  await writeFile(path, lines.join('\n') + '\n', 'utf-8')
  if (options.subagents) {
    const subs = join(dir, SESSION_ID, 'subagents')
    await mkdir(subs, { recursive: true })
    for (let i = 0; i < options.subagents; i += 1)
      await writeFile(join(subs, `agent-${i}.jsonl`), '{}\n', 'utf-8')
  }
  return { path, cleanup: () => rm(root, { recursive: true, force: true }) }
}

test('an instruction is not a tool result, and a compact summary is not an instruction', async () => {
  // The failure this prevents: a report that lists "tool result" or a summary of
  // elided history where the user's actual instruction should be, which teaches
  // a fresh session the wrong task.
  const t = await withTranscript([
    user('Rework the installer to use tar instead of Expand-Archive.'),
    toolUse('t1', 'Bash', { command: 'ls -la' }),
    toolResult('t1', 'total 0'),
    user('Now fix the signing step.', { isMeta: true }),
    user('Compressed history.', { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
  ])
  try {
    const e = await condenseTranscript(t.path)
    assert.equal(e.userTurns.length, 1, 'only the real instruction is a turn')
    assert.match(e.userTurns[0]!.text, /Rework the installer/)
    assert.equal(e.counts.toolCalls, 1)
    // Four records carry type "user": the instruction, the tool result, and the
    // two bookkeeping records. Only the first is a turn.
    assert.equal(e.counts.user, 4)
  } finally {
    await t.cleanup()
  }
})

test('a block-array instruction is read the same as a string one', async () => {
  // Both shapes appear in real transcripts, so reading only one silently drops
  // half the instructions in a long session.
  const t = await withTranscript([
    userBlocks([{ type: 'text', text: 'First line.' }, { type: 'text', text: 'Second line.' }]),
  ])
  try {
    const e = await condenseTranscript(t.path)
    assert.equal(e.userTurns.length, 1)
    assert.match(e.userTurns[0]!.text, /First line\.\nSecond line\./)
  } finally {
    await t.cleanup()
  }
})

test('a green suite is not reported as failing, and a red one is', async () => {
  // The failure this prevents: matching "0 fail" as a failure, which would mark
  // every passing suite broken and send a fresh session chasing a fixed bug.
  const t = await withTranscript([
    toolUse('g1', 'Bash', { command: 'bun test scripts/foo.test.ts' }),
    toolResult('g1', ' 5 pass\n 0 fail\nRan 5 tests'),
    toolUse('r1', 'Bash', { command: 'bun test scripts/bar.test.ts' }),
    toolResult('r1', ' 3 pass\n 2 fail\nRan 5 tests'),
  ])
  try {
    const e = await condenseTranscript(t.path)
    assert.equal(e.tests.length, 2)
    assert.equal(e.tests[0]!.ok, true, '5 pass / 0 fail is green')
    assert.equal(e.tests[1]!.ok, false, '2 fail is red')
    assert.match(e.tests[0]!.summary, /5 pass/)
  } finally {
    await t.cleanup()
  }
})

test('a repeated command does not overwrite an earlier verdict', async () => {
  // The failure this prevents: the same command run twice - once red, once green
  // - reported as a single result, hiding that it was ever broken.
  const t = await withTranscript([
    toolUse('c1', 'Bash', { command: 'bun test scripts/x.test.ts' }),
    toolResult('c1', ' 1 fail'),
    toolUse('c2', 'Bash', { command: 'bun test scripts/x.test.ts' }),
    toolResult('c2', ' 4 pass\n 0 fail'),
  ])
  try {
    const e = await condenseTranscript(t.path)
    assert.equal(e.tests.length, 2, 'two runs are two rows, not one')
    assert.equal(e.tests[0]!.ok, false)
    assert.equal(e.tests[1]!.ok, true)
  } finally {
    await t.cleanup()
  }
})

test('files are attributed by the tool that touched them', async () => {
  // A handoff leans on "what changed"; a read is not a change, and collapsing
  // the two overstates the work.
  const t = await withTranscript([
    toolUse('w1', 'Write', { file_path: 'src/a.ts', content: 'x' }),
    toolUse('e1', 'Edit', { file_path: 'src/a.ts', old_string: 'x', new_string: 'y' }),
    toolUse('e2', 'Edit', { file_path: 'src/a.ts', old_string: 'y', new_string: 'z' }),
    toolUse('r1', 'Read', { file_path: 'src/b.ts' }),
  ])
  try {
    const e = await condenseTranscript(t.path)
    const a = e.files.find(f => f.path === 'src/a.ts')
    const b = e.files.find(f => f.path === 'src/b.ts')
    assert.equal(a?.writes, 1)
    assert.equal(a?.edits, 2)
    assert.equal(b?.reads, 1)
    assert.equal(b?.writes, 0)
    assert.equal(e.files[0]!.path, 'src/a.ts', 'busiest file first')
  } finally {
    await t.cleanup()
  }
})

test('a command result is paired to its call, and an error is visible', async () => {
  const t = await withTranscript([
    toolUse('x1', 'Bash', { command: 'git status --short' }),
    toolResult('x1', ' M src/a.ts'),
    toolUse('x2', 'Bash', { command: 'bun run build' }),
    toolResult('x2', 'error: cannot find module', true),
  ])
  try {
    const e = await condenseTranscript(t.path)
    assert.equal(e.commands.length, 2)
    assert.equal(e.commands[0]!.failed, false)
    assert.equal(e.commands[1]!.failed, true)
    assert.match(e.commands[1]!.excerpt, /cannot find module/)
    assert.equal(e.counts.toolErrors, 1)
  } finally {
    await t.cleanup()
  }
})

test('a compact boundary is recorded so elided history is not silently lost', async () => {
  // A long session's early plan survives only as a summary. A report that does
  // not say so reads as complete when it is not.
  const t = await withTranscript([user('Early instruction.'), compactBoundary(), user('Late instruction.')])
  try {
    const e = await condenseTranscript(t.path)
    assert.equal(e.compactBoundaries.length, 1)
    assert.equal(e.compactBoundaries[0]!.trigger, 'auto')
    assert.equal(e.compactBoundaries[0]!.messagesSummarized, 42)
    assert.equal(e.userTurns.length, 2, 'both sides of the boundary are kept when readable')
  } finally {
    await t.cleanup()
  }
})

test('a malformed line does not cost the report the rest of the transcript', async () => {
  const t = await withTranscript([
    user('Keep me.'),
    '{ this is not json',
    user('And me.'),
  ])
  try {
    const e = await condenseTranscript(t.path)
    assert.equal(e.userTurns.length, 2)
  } finally {
    await t.cleanup()
  }
})

test('the byte budget stops the read and says so', async () => {
  // Sessions reach multiple gigabytes. A report may truncate, but it must never
  // claim completeness it does not have.
  const t = await withTranscript([
    user('A'.repeat(400)),
    user('B'.repeat(400)),
    user('C'.repeat(400)),
  ])
  try {
    const e = await condenseTranscript(t.path, { maxBytes: 500 })
    assert.equal(e.truncated, true)
    assert.ok(e.userTurns.length < 3, 'stopped before the end')
  } finally {
    await t.cleanup()
  }
})

test('an oversized record is skipped rather than buffered', async () => {
  // One enormous tool result must not be able to consume the whole budget and
  // turn a streaming reader into an out-of-memory crash.
  const t = await withTranscript([
    user('Before.'),
    user('X'.repeat(2000)),
    user('After.'),
  ])
  try {
    const e = await condenseTranscript(t.path, { maxBytes: 1 << 30, maxLineBytes: 500 })
    assert.equal(e.skippedOversizedLine, true, 'line ceiling is lower than the byte budget')
    assert.equal(e.userTurns.length, 2, 'the records around it still land')
    assert.match(e.userTurns[1]!.text, /After\./)
  } finally {
    await t.cleanup()
  }
})

test('subagent transcripts beside a session are counted, not parsed', async () => {
  const t = await withTranscript([user('Delegate this.')], { subagents: 3 })
  try {
    const e = await condenseTranscript(t.path)
    assert.equal(e.subagentTranscripts, 3)
  } finally {
    await t.cleanup()
  }
})

test('an arbitrary session is findable by id and by title from outside it', async () => {
  // This is the whole point of an outside-perspective report: the session doing
  // the reporting is not the session being reported on.
  const saved = process.env.CLAUDE_CONFIG_DIR
  const t = await withTranscript([user('Reshape the onboarding flow.')])
  const root = t.path.slice(0, t.path.indexOf(join('projects')))
  process.env.CLAUDE_CONFIG_DIR = root
  try {
    const byId = await resolveSessionTarget(SESSION_ID)
    assert.equal(byId?.sessionId, SESSION_ID, 'an exact id resolves across all projects')
    assert.ok(byId!.fileSize > 0)

    const listed = await listReportTargets()
    assert.equal(listed.length, 1)
    assert.equal(listed[0]!.sessionId, SESSION_ID)
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
    await t.cleanup()
  }
})

test('an unknown query resolves to nothing rather than to the wrong session', async () => {
  // Guessing is the dangerous direction: a report on the wrong session is
  // confidently wrong, and the reader has no way to tell.
  const saved = process.env.CLAUDE_CONFIG_DIR
  const t = await withTranscript([user('Some work.')])
  const root = t.path.slice(0, t.path.indexOf(join('projects')))
  process.env.CLAUDE_CONFIG_DIR = root
  try {
    assert.equal(await resolveSessionTarget('99999999-9999-4999-8999-999999999999'), undefined)
    assert.equal(await resolveSessionTarget('no such title anywhere'), undefined)
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
    await t.cleanup()
  }
})
