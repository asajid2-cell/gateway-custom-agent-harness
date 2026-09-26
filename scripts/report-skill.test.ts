import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseReportArgs,
  renderEvidence,
  resolveReportDir,
  registerReportSkill,
} from '../src/skills/bundled/report.ts'
import { clearBundledSkills, getBundledSkills } from '../src/skills/bundledSkills.ts'
import type {
  ResolvedSession,
  TranscriptEvidence,
} from '../src/utils/sessionReport.ts'

/**
 * The /report skill is the contract a fresh session reads.
 *
 * Two things are being tested, and only one of them is parsing. The parse and
 * the directory precedence are ordinary argument handling and are asserted as
 * such. The prompt is different: it is the document that tells a model which
 * labels it may use and forbids it from promoting anything to [PROVEN] without a
 * test run. Those are the sentences that keep a handoff from overstating what
 * was done, so they are asserted by name rather than by length, and the evidence
 * block is asserted to say "unknown" instead of guessing when a section is
 * empty.
 */

const SESSION_ID = '11111111-1111-4111-8111-111111111111'

const user = (text: string) =>
  JSON.stringify({
    type: 'user',
    uuid: 'u' + Math.random().toString(36).slice(2),
    timestamp: '2026-09-26T10:00:00.000Z',
    cwd: 'C:\\proj',
    gitBranch: 'main',
    version: '1.0.0',
    message: { role: 'user', content: text },
  })

async function withTranscript(
  lines: string[],
): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'report-skill-'))
  const dir = join(root, 'projects', 'C--proj')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${SESSION_ID}.jsonl`), lines.join('\n') + '\n', 'utf-8')
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) }
}

async function withEnv(
  vars: Record<string, string | undefined>,
  run: () => Promise<void>,
): Promise<void> {
  const saved = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    await run()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** The registered command, looked up the way the harness looks it up. */
function reportCommand() {
  clearBundledSkills()
  registerReportSkill()
  const command = getBundledSkills().find(s => s.name === 'report')
  assert.ok(command, 'the report skill registers itself')
  // The union only carries getPromptForCommand on its prompt variant, and the
  // narrowing is also the assertion that a prompt skill is what got registered.
  if (command.type !== 'prompt') throw new Error('report must register as a prompt skill')
  return command
}

const prompt = async (args: string): Promise<string> => {
  const blocks = await reportCommand().getPromptForCommand(args, {} as never)
  return blocks.map(b => (b.type === 'text' ? b.text : '')).join('\n')
}

/**
 * Prompt-shape tests need a readable transcript behind the named session: with
 * no --session the skill reports on THIS session, and a test process has no
 * transcript on disk to condense, so the prompt comes back as an error string
 * instead of a document.
 */
async function promptForDepth(depth: string): Promise<string> {
  const t = await withTranscript([user('Rework the installer to use tar.')])
  try {
    let text = ''
    await withEnv(
      { CLAUDE_CONFIG_DIR: t.root, GATEWAY_REPORT_DIR: undefined },
      async () => {
        text = await prompt(`${depth} --session ${SESSION_ID}`)
      },
    )
    return text
  } finally {
    await t.cleanup()
  }
}

function evidenceOf(over: Partial<TranscriptEvidence> = {}): TranscriptEvidence {
  return {
    sessionId: SESSION_ID,
    cwd: 'C:\\proj',
    gitBranch: 'main',
    version: '1.0.0',
    firstAt: '2026-09-26T10:00:00.000Z',
    lastAt: '2026-09-26T10:05:00.000Z',
    fileSize: 4096,
    bytesRead: 4096,
    truncated: false,
    skippedOversizedLine: false,
    counts: { user: 3, assistant: 2, system: 1, toolCalls: 4, toolErrors: 1, sidechain: 0 },
    userTurns: [],
    files: [],
    commands: [],
    tests: [],
    toolCounts: [],
    compactBoundaries: [],
    subagentTranscripts: 0,
    subagentIds: [],
    omitted: { userTurns: 0, commands: 0 },
    ...over,
  }
}

const SESSION: ResolvedSession = {
  sessionId: SESSION_ID,
  filePath: `C:\\proj\\${SESSION_ID}.jsonl`,
  projectPath: undefined,
  fileSize: 4096,
}

test('the skill is user-invocable but hidden from the model', () => {
  const command = reportCommand()
  assert.equal(command.type, 'prompt')
  assert.equal(command.userInvocable, true)
  assert.equal(command.isHidden, false, 'a user must be able to type /report')
  // A model that could invoke this could also decide mid-task that the project
  // deserved a 15,000-word document.
  assert.equal(command.disableModelInvocation, true)
  assert.match(command.argumentHint ?? '', /checkpoint\|handoff\|seed\|list/)
  assert.equal(command.source, 'bundled')
})

test('a bare invocation is a checkpoint, and a bare word is the session', () => {
  // `/report handoff <id>` is how the command is actually typed, so requiring a
  // flag for the common case would be a papercut repeated every time.
  assert.deepEqual(parseReportArgs(''), {
    command: 'checkpoint', session: undefined, out: undefined, maxBytes: undefined,
  })
  assert.deepEqual(parseReportArgs('handoff'), {
    command: 'handoff', session: undefined, out: undefined, maxBytes: undefined,
  })
  const bare = parseReportArgs('handoff abc-def')
  assert.equal(bare.command, 'handoff')
  assert.equal(bare.session, 'abc-def')
})

test('flags override the positionals and a bad byte budget is ignored', () => {
  assert.equal(parseReportArgs('--session xyz').session, 'xyz')
  assert.equal(parseReportArgs('-s xyz').session, 'xyz')
  assert.equal(parseReportArgs('--out D:\\r').out, 'D:\\r')
  assert.equal(parseReportArgs('-o D:\\r').out, 'D:\\r')
  assert.equal(parseReportArgs('seed --max-bytes 4096').maxBytes, 4096)
  // A non-numeric or non-positive budget must not become NaN downstream.
  assert.equal(parseReportArgs('seed --max-bytes nope').maxBytes, undefined)
  assert.equal(parseReportArgs('seed --max-bytes 0').maxBytes, undefined)
  assert.equal(parseReportArgs('seed --max-bytes -5').maxBytes, undefined)
})

test('the output directory is a flag, then the environment, then the archive', async () => {
  // A one-off destination never needs a config change and a standing destination
  // never needs a flag.
  const out = resolveReportDir({ command: 'seed', out: 'D:\\one-off' })
  assert.equal(out, 'D:\\one-off')

  await withEnv({ GATEWAY_REPORT_DIR: 'D:\\standing' }, async () => {
    assert.equal(resolveReportDir({ command: 'seed' }), 'D:\\standing')
    assert.equal(
      resolveReportDir({ command: 'seed', out: 'D:\\one-off' }),
      'D:\\one-off',
      'the flag still beats the environment',
    )
  })

  await withEnv({ GATEWAY_REPORT_DIR: undefined }, async () => {
    // Nothing may default to a location inside ~/.claude/projects, because a
    // report is planning material and must not be able to land in a product tree.
    const fallback = resolveReportDir({ command: 'seed' })
    assert.match(fallback, /archaeology-artifacts[\\/]reports$/)
  })
})

test('the evidence block states facts and names every gap', () => {
  const rendered = renderEvidence(
    SESSION,
    evidenceOf({
      userTurns: [{ at: '2026-09-26T10:00:00.000Z', text: 'Rework the installer.' }],
      files: [{ path: 'src/a.ts', writes: 1, edits: 2, reads: 0 }],
      commands: [
        { at: '2026-09-26T10:00:01.000Z', command: 'git status --short', failed: false, excerpt: ' M src/a.ts' },
        { at: '2026-09-26T10:00:02.000Z', command: 'bun run build', failed: undefined, excerpt: '' },
      ],
      toolCounts: [{ name: 'Bash', count: 2 }],
    }),
  )
  assert.match(rendered, /SESSION\n {2}id: 11111111/)
  assert.match(rendered, /transcript: C:\\proj\\11111111/)
  assert.match(rendered, /records read: 3 user, 2 assistant, 1 system/)
  assert.match(rendered, /tool calls: 4 \(1 returned an error\)/)
  assert.match(rendered, /\[1\] 2026-09-26T10:00:00.000Z\n {6}Rework the installer\./)
  assert.match(rendered, /src\/a\.ts\b[^\n]*writes=1 edits=2 reads=0/)
  assert.match(rendered, /\[ok\] git status --short/)
  // An interrupted command is not a passing one, and the report has to say so
  // rather than leave the reader to assume.
  assert.match(rendered, /NO RESULT SEEN\] bun run build/)
  assert.match(rendered, /Bash: 2/)
})

test('an empty test section forbids the PROVEN label outright', () => {
  const rendered = renderEvidence(SESSION, evidenceOf())
  assert.match(rendered, /TEST RUNS DETECTED \(0\)[^\n]*the only rows eligible for a PROVEN label/)
  assert.match(rendered, /no test evidence exists, so nothing may be labelled PROVEN/)
})

test('elision, truncation, and skipped records are all announced', () => {
  // A report that does not say history was dropped reads as complete when it is not.
  const rendered = renderEvidence(
    SESSION,
    evidenceOf({
      truncated: true,
      skippedOversizedLine: true,
      compactBoundaries: [
        { at: '2026-09-26T10:00:05.000Z', trigger: 'auto', preTokens: 150000, messagesSummarized: 42 },
      ],
      subagentTranscripts: 3,
      subagentIds: ['a', 'b', 'c'],
    }),
  )
  assert.match(rendered, /HISTORY ELIDED[^\n]*1 compaction\(s\)/)
  assert.match(rendered, /trigger=auto preTokens=150000 messagesSummarized=42/)
  assert.match(rendered, /READ TRUNCATED/)
  assert.match(rendered, /OVERSIZED RECORDS SKIPPED/)
  assert.match(rendered, /subagent transcripts recorded: 3 \(3 distinct agents\)/)
})

test('the evidence is bounded even when the session is not', () => {
  // The evidence is pasted into a prompt. A real 447 MiB session rendered to
  // 574 KB unbounded - more context than the report is worth, and enough that
  // the prompt could not be sent. The ceiling has to hold at the collection caps,
  // not merely on a quiet session.
  const huge = evidenceOf({
    counts: { user: 900, assistant: 900, system: 30, toolCalls: 5000, toolErrors: 400, sidechain: 0 },
    userTurns: Array.from({ length: 800 }, (_, i) => ({
      at: `2026-09-26T10:${String(i % 60).padStart(2, '0')}:00.000Z`,
      text: 'instruction '.repeat(400),
    })),
    files: Array.from({ length: 500 }, (_, i) => ({ path: `src/deep/nested/f${i}.ts`, writes: 1, edits: 1, reads: 1 })),
    commands: Array.from({ length: 400 }, () => ({
      at: '2026-09-26T10:00:00.000Z',
      command: 'bun test scripts/a-very-long-test-name.test.ts --reporter=verbose',
      failed: false,
      excerpt: 'result line '.repeat(50),
    })),
    tests: Array.from({ length: 400 }, () => ({
      at: '2026-09-26T10:00:00.000Z',
      command: 'bun test scripts/a-very-long-test-name.test.ts',
      ok: true,
      summary: 'assertion output '.repeat(50),
    })),
    omitted: { userTurns: 100, commands: 1000 },
    truncated: true,
  })
  const rendered = renderEvidence(SESSION, huge)
  assert.ok(rendered.length < 200_000, `evidence is ${rendered.length} characters`)
  // The bound must be paid for by naming the gaps, not by dropping rows quietly.
  assert.match(rendered, /instruction\(s\) elided for length/)
  assert.match(rendered, /command\(s\) elided for length/)
  assert.match(rendered, /test run\(s\) elided for length/)
  assert.match(rendered, /file\(s\) elided for length/)
  // A clipped value says so, so a short-looking instruction is never mistaken
  // for a short one.
  assert.match(rendered, /more characters\]/)
})

test('a short session renders whole, with no elision noise', () => {
  // The bound must not cost a small report its completeness or its readability.
  const rendered = renderEvidence(
    SESSION,
    evidenceOf({
      userTurns: [{ at: '2026-09-26T10:00:00.000Z', text: 'Short.' }],
      commands: [{ at: '2026-09-26T10:00:01.000Z', command: 'ls', failed: false, excerpt: '' }],
      tests: [{ at: '2026-09-26T10:00:02.000Z', command: 'bun test', ok: true, summary: ' 1 pass' }],
    }),
  )
  assert.ok(!rendered.includes('elided for length'), 'nothing is elided from a short session')
  assert.ok(!rendered.includes('more characters]'), 'nothing is clipped either')
  assert.match(rendered, /INSTRUCTIONS GIVEN \(1 shown, 1 read\)/)
})

test('the checkpoint prompt requires the delta sections and the seed', async () => {
  const text = await promptForDepth('checkpoint')
  assert.match(text, /REPORT TYPE: CHECKPOINT/)
  assert.match(text, /a session that already knows this project/)
  for (const section of [
    'Goal', 'Phase', 'Since the last checkpoint', 'Proven vs not proven',
    'Repository state', 'Open defects and limitations', 'Next work', 'Blockers',
    'Latest decisions', 'Continuation', 'Persist seed',
  ])
    assert.ok(text.includes(section), `checkpoint names "${section}"`)
  assert.match(text, /PERSIST SEED SPECIFICATION/)
})

test('the handoff prompt is the zero-context document', async () => {
  const text = await promptForDepth('handoff')
  assert.match(text, /REPORT TYPE: HANDOFF/)
  assert.match(text, /a session with no prior context whatsoever/)
  assert.match(text, /zero history can read this and plan correct work/)
  for (const section of [
    'Executive orientation', 'Architecture evolution', 'Invariants',
    'Repository inventory', 'Implementation status', 'Evidence ledger',
    'Current working state', 'Current workstream', 'Roadmap', 'Risks and unresolved decisions',
    'Development environment', 'Operations and release', 'Do not regress',
  ])
    assert.ok(text.includes(section), `handoff names "${section}"`)
})

test('the seed prompt is a seed only, and its tail is the durable part', async () => {
  const text = await promptForDepth('seed')
  assert.match(text, /This is a SEED ONLY/)
  assert.ok(!text.includes('REQUIRED SECTIONS'), 'a seed does not carry the full section list')
  // A persisting session is nudged with the END of its goal, so the completion
  // condition and the immediate next action have to be the last thing in it.
  const now = text.indexOf('NOW:')
  const done = text.indexOf('DONE WHEN:')
  assert.ok(now >= 0 && done > now, 'the seed ends with NOW then DONE WHEN')
  assert.match(text, /\/persist plan task <seed>/)
})

test('every depth shares the labels and the verbatim-evidence rule', async () => {
  for (const depth of ['checkpoint', 'handoff', 'seed']) {
    const text = await promptForDepth(depth)
    for (const label of ['[FACT]', '[PROVEN]', '[IMPLEMENTED]', '[DESIGN]', '[OPEN]', '[BLOCKED]', '[SUPERSEDED]', '[CONFLICT]'])
      assert.ok(text.includes(label), `${depth} carries ${label}`)
    assert.match(text, /\[PROVEN\] requires a PASS row in TEST RUNS DETECTED/)
    assert.match(text, /Never invent state/)
    assert.match(text, /Do not present a compaction summary as a user instruction/)
    // The evidence is the only part a reader can check independently, so every
    // depth has to reproduce it untouched.
    assert.match(text, /Reproduce the EVIDENCE section verbatim/)
    assert.match(text, /## Raw evidence/)
    assert.match(text, /EVIDENCE[^\n]*machine-gathered\. Reproduce verbatim/)
  }
})

test('list names candidate sessions without opening one', async () => {
  const t = await withTranscript([user('Some work.')])
  try {
    await withEnv({ CLAUDE_CONFIG_DIR: t.root, GATEWAY_REPORT_DIR: undefined }, async () => {
      const text = await prompt('list')
      assert.match(text, /Sessions available to report on/)
      assert.ok(text.includes(SESSION_ID), 'the candidate is named by id')
      assert.match(text, /\/report handoff --session/)
      assert.ok(!text.includes('## Raw evidence'), 'listing is discovery, not a report')
    })
  } finally {
    await t.cleanup()
  }
})

test('list is empty rather than wrong when nothing is on the machine', async () => {
  const root = await mkdtemp(join(tmpdir(), 'report-skill-empty-'))
  try {
    await withEnv({ CLAUDE_CONFIG_DIR: root }, async () => {
      const text = await prompt('list')
      assert.match(text, /No sessions were found/)
      assert.ok(!text.includes(SESSION_ID))
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a named session is condensed and the report lands in the configured directory', async () => {
  const t = await withTranscript([
    user('Rework the installer to use tar instead of Expand-Archive.'),
    JSON.stringify({
      type: 'assistant',
      uuid: 'a1',
      timestamp: '2026-09-26T10:00:02.000Z',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'bun test scripts/x.test.ts' } }] },
    }),
    JSON.stringify({
      type: 'user',
      uuid: 'u2',
      timestamp: '2026-09-26T10:00:03.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: ' 4 pass\n 0 fail' }] },
    }),
  ])
  const out = await mkdtemp(join(tmpdir(), 'report-skill-out-'))
  try {
    await withEnv(
      { CLAUDE_CONFIG_DIR: t.root, GATEWAY_REPORT_DIR: out },
      async () => {
        const text = await prompt(`handoff --session ${SESSION_ID}`)
        // The outside-perspective path: this session is reporting on a session
        // that is not this one, found only by its transcript.
        assert.match(text, new RegExp(`Target session: ${SESSION_ID}`))
        assert.match(text, /Rework the installer to use tar/)
        // The row carries the call's timestamp, because a test row is created
        // when the command is issued and filled in when its result arrives.
        assert.match(text, /PASS 2026-09-26T10:00:02\.000Z bun test scripts\/x\.test\.ts/)
        // The destination is quoted so the model writes exactly there.
        assert.ok(text.includes(out), 'the skill names the configured directory')
        assert.match(text, /confirm in one line where the report was written/)
      },
    )
  } finally {
    await t.cleanup()
    await rm(out, { recursive: true, force: true })
  }
})

test('an unknown session is refused rather than resolved to the wrong one', async () => {
  // A report on the wrong session is confidently wrong and the reader cannot tell.
  const root = await mkdtemp(join(tmpdir(), 'report-skill-miss-'))
  try {
    await withEnv({ CLAUDE_CONFIG_DIR: root }, async () => {
      const text = await prompt('handoff --session 99999999-9999-4999-8999-999999999999')
      assert.match(text, /No session matched/)
      assert.ok(!text.includes('## Raw evidence'), 'nothing is condensed when the target is unknown')
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
