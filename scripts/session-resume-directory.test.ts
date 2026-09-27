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
import { join } from 'node:path'
import {
  loadAllLogsFromSessionFile,
  loadTranscriptFromFile,
} from '../src/utils/sessionStorage.ts'

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
