// The directory a session reports for `cc --resume` is the one it was started
// in, and that is the directory its transcript file is stored under - so it is
// the directory the command actually has to be run from. A session that
// compacted or forked while its shell was sitting somewhere else used to be
// reported in terms of that other directory instead: the conversation chain
// starts at the compaction boundary, and the cwd on that record is wherever the
// session happened to be at the moment, which no project directory of this
// session contains.
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  getProjectDir,
  loadAllLogsFromSessionFile,
  loadTranscriptFromFile,
} from '../src/utils/sessionStorage.ts'
import { resolveResumeDirectory } from '../src/utils/sessionRestore.ts'
import { leafResumeCommand } from '../src/utils/leafWorkspace.ts'
import { formatSessionResumeCommand } from '../src/utils/bottomBarUsage.ts'

const SESSION = '4d2a7c1e-5f60-4a3b-9c8d-1e2f3a4b5c6d'
const ORIGIN = 'C:\\Users\\Ahmed'
const ELSEWHERE = 'C:\\Users\\Ahmed\\muxdiag\\titleprobe'

function envelope(record: Record<string, unknown>): string {
  return JSON.stringify({
    isSidechain: false,
    userType: 'external',
    entrypoint: 'cli',
    version: '1.0.0',
    sessionId: SESSION,
    gitBranch: 'HEAD',
    ...record,
  })
}

/**
 * A compaction boundary opens a chain with no parent, so the conversation the
 * session holds now begins at the last boundary rather than at its first turn.
 */
function boundary(uuid: string, cwd: string, timestamp: string): string {
  return envelope({
    parentUuid: null,
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    isMeta: false,
    level: 'info',
    compactMetadata: { trigger: 'auto', preTokens: 1000 },
    cwd,
    uuid,
    timestamp,
  })
}

function turn(
  uuid: string,
  parentUuid: string,
  cwd: string,
  timestamp: string,
): string {
  return envelope({
    parentUuid,
    type: 'user',
    message: { role: 'user', content: `turn ${uuid}` },
    cwd,
    uuid,
    timestamp,
  })
}

function answer(
  uuid: string,
  parentUuid: string,
  cwd: string,
  timestamp: string,
): string {
  return envelope({
    parentUuid,
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: `answer ${uuid}` }],
    },
    cwd,
    uuid,
    timestamp,
  })
}

async function writeTranscript(lines: readonly string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'session-resume-directory-'))
  const path = join(dir, `${SESSION}.jsonl`)
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8')
  return path
}

/**
 * The first turn was taken in ORIGIN; the session then compacted while its
 * shell sat in ELSEWHERE, so the chain the session holds now is the tail that
 * follows that boundary.
 */
function compactedWhileElsewhere(): string[] {
  return [
    boundary('00000000-0000-4000-8000-000000000001', ORIGIN, '2026-09-26T00:00:00.000Z'),
    turn('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', ORIGIN, '2026-09-26T00:00:01.000Z'),
    answer('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000002', ORIGIN, '2026-09-26T00:00:02.000Z'),
    boundary('00000000-0000-4000-8000-000000000004', ELSEWHERE, '2026-09-26T00:10:00.000Z'),
    turn('00000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000004', ELSEWHERE, '2026-09-26T00:10:01.000Z'),
    answer('00000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-000000000005', ELSEWHERE, '2026-09-26T00:10:02.000Z'),
  ]
}

test('a compacted session reports the directory it was started in', async () => {
  const path = await writeTranscript(compactedWhileElsewhere())
  try {
    const log = await loadTranscriptFromFile(path)
    assert.equal(log.projectPath, ORIGIN, 'the resume directory is where the chat started')
    // The chain root really is the mid-file boundary, so this is not passing by
    // accident: reading the chain root is what reported ELSEWHERE.
    assert.equal((log.messages[0] as { cwd?: string }).cwd, ELSEWHERE)

    const [fromIndex] = await loadAllLogsFromSessionFile(path)
    assert.equal(fromIndex?.projectPath, ORIGIN)
  } finally {
    await rm(join(path, '..'), { recursive: true, force: true })
  }
})

// The printed resume command must cd into a directory whose project folder is
// the one the transcript actually lives in, or `cc --resume <id>` run from it
// finds nothing. A recorded worktree that no longer holds the file used to win
// over the transcript's own folder, so the footer named a directory the session
// could not be resumed from.
test('the resume command cds to the transcript folder, not a stale worktree', () => {
  const transcriptPath = join(getProjectDir(ORIGIN), `${SESSION}.jsonl`)
  const staleWorktree = 'C:\\Users\\Ahmed\\tmp\\.agent\\runs\\choralus-acceptance'
  const directory = resolveResumeDirectory({
    transcriptPath,
    worktreePath: staleWorktree,
    projectPath: ORIGIN,
    fallback: ELSEWHERE,
  })
  const printed = formatSessionResumeCommand(directory, SESSION)
  assert.equal(directory, ORIGIN)
  assert.equal(printed, `cd '${ORIGIN}'; & cc --resume ${SESSION}`)
  assert.ok(!printed.includes('choralus-acceptance'), 'the stale worktree is not named')
  // The outcome: the directory the command cds into is the one holding the file.
  assert.equal(getProjectDir(directory), dirname(transcriptPath))
})

// A member living under a worktree project dir must get a command that carries
// that directory, so it resumes correctly even when run from an unrelated cwd.
// A bare `cc --resume <id>` typed anywhere else finds nothing.
test('a member command carries the member directory and resumes from anywhere', () => {
  const memberId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const memberCwd = 'C:\\Users\\Ahmed\\repo-worktrees\\lane-a'
  const unset = leafResumeCommand({ sessionId: memberId, cwd: undefined })
  assert.equal(unset, `cc --resume ${memberId}`, 'no directory on record leaves the bare form')

  const command = leafResumeCommand({ sessionId: memberId, cwd: memberCwd })
  assert.equal(command, `cd '${memberCwd}'; & cc --resume ${memberId}`)
  assert.notEqual(command, `cc --resume ${memberId}`)
  // The command cds into the member's own project folder, which is the folder
  // the member's transcript lives in - so the lookup succeeds from any cwd.
  assert.equal(getProjectDir(memberCwd), dirname(join(getProjectDir(memberCwd), `${memberId}.jsonl`)))
})
