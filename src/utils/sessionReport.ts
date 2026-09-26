import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { listSessionsImpl, type SessionInfo } from './listSessionsImpl.js'
import {
  resolveSessionFilePath,
  validateUuid,
} from './sessionStoragePortable.js'

/**
 * Discovery and condensation for handoff reports.
 *
 * Two jobs, and they are deliberately separate from the skill that renders a
 * report: finding a session that may not be the current one, and turning its
 * transcript into a small, accurate set of facts. The skill decides what a
 * report should say; this module decides only what is true.
 *
 * The condensation never materialises the transcript. Sessions in this harness
 * reach multiple gigabytes, and a report needs the shape of a conversation, not
 * its bytes: which instructions were given, which files were touched, which
 * commands ran and whether they passed, where history was elided. So records are
 * projected into derived rows as they stream past and the originals are dropped
 * before the next chunk is read. Peak memory is the size of the summary, which
 * is why the row caps below can be generous without the process paying for them.
 */

/** How much of a transcript is worth reading. Derived rows are cheap, but a
 *  multi-gigabyte file still costs real time to stream, and a report is a
 *  best-effort document rather than a byte-exact audit. */
const DEFAULT_MAX_BYTES = 128 * 1024 * 1024

/** A single record can be enormous (a pasted file, a screenshot, a giant tool
 *  result). Past this the line is abandoned rather than buffered: one record is
 *  never worth the whole budget, and an unbounded carry buffer is how a stream
 *  reader turns a big file into an out-of-memory crash. */
const MAX_LINE_BYTES = 16 * 1024 * 1024

/** Collection caps. These bound memory, not the rendered document: rows are held
 *  for the renderer, which applies its own, tighter budget, so these can be
 *  generous without a prompt paying for them. User instructions are the reason a
 *  report exists, so they get the most room. */
const MAX_USER_TURNS = 800
const MAX_COMMANDS = 400
const USER_TEXT_LIMIT = 4000
const COMMAND_LIMIT = 600
const RESULT_EXCERPT_LIMIT = 500

/** A command that plausibly runs a test suite. Kept broad on purpose: missing a
 *  test run costs the report its evidence, while a false positive merely adds a
 *  row a reader can ignore. */
const TEST_COMMAND_RE =
  /\b(bun|npm|npx|pnpm|yarn|pytest|python3?\s+-m\s+pytest|go|cargo|dotnet|mvn|gradle|ctest)\b[^\n]*\b(test|spec|check|lint)\b/i

/** Failing counts as the runners actually print them. A zero is not a failure —
 *  "5 pass, 0 fail" is a green run, and a pattern that counts the zero would
 *  report every passing suite as broken. The presence of any non-zero failure
 *  count decides the verdict outright, because a suite that reports both a pass
 *  and a fail count (a partial run, a skipped file) is still red. */
const FAIL_RE = /([1-9]\d*)\s+(?:tests?\s+)?fail/i

export type ResolvedSession = {
  sessionId: string
  filePath: string
  projectPath: string | undefined
  fileSize: number
  info?: SessionInfo
}

export type UserTurn = { at: string; text: string; compactSummary?: boolean }
export type FileTouch = {
  path: string
  writes: number
  edits: number
  reads: number
}
export type CommandRun = {
  at: string
  command: string
  /** Undefined when no result was seen — the turn may have been interrupted. */
  failed?: boolean
  excerpt: string
}
export type TestRun = { at: string; command: string; ok: boolean; summary: string }
export type CompactBoundary = {
  at: string
  trigger?: string
  preTokens?: number
  messagesSummarized?: number
}

export type TranscriptEvidence = {
  sessionId: string
  cwd?: string
  gitBranch?: string
  version?: string
  firstAt?: string
  lastAt?: string
  fileSize: number
  bytesRead: number
  /** True when the byte budget ran out before the end of the file. */
  truncated: boolean
  /** True when a record exceeded the per-line ceiling and was skipped. */
  skippedOversizedLine: boolean
  counts: {
    user: number
    assistant: number
    system: number
    toolCalls: number
    toolErrors: number
    sidechain: number
  }
  userTurns: UserTurn[]
  files: FileTouch[]
  commands: CommandRun[]
  tests: TestRun[]
  toolCounts: { name: string; count: number }[]
  compactBoundaries: CompactBoundary[]
  /** Subagent transcripts recorded beside this one, if any. */
  subagentTranscripts: number
  subagentIds: string[]
  /** Rows dropped by the caps, so a reader knows the summary is partial. */
  omitted: {
    userTurns: number
    commands: number
  }
}

/**
 * Find sessions to report on.
 *
 * With no directory this is every session on the machine, because the point of
 * an outside-perspective report is that it need not be the session asking.
 */
export async function listReportTargets(
  opts: { dir?: string; limit?: number } = {},
): Promise<SessionInfo[]> {
  return listSessionsImpl({ dir: opts.dir, limit: opts.limit ?? 50 })
}

/**
 * Resolve one session from a query that may be an id, a title fragment, a path,
 * or a word from the opening prompt.
 *
 * An exact id wins outright. Anything else is a search, and the search is
 * deliberately shallow — newest first among matches — because a report on the
 * wrong session is worse than a report that refuses to guess. Callers are
 * expected to show the candidates when the match is ambiguous.
 */
export async function resolveSessionTarget(
  query: string,
  opts: { dir?: string } = {},
): Promise<ResolvedSession | undefined> {
  const trimmed = query.trim()
  if (!trimmed) return undefined

  const uuid = validateUuid(trimmed)
  if (uuid) {
    const found = await resolveSessionFilePath(uuid, opts.dir)
    if (!found) return undefined
    return {
      sessionId: uuid,
      filePath: found.filePath,
      projectPath: found.projectPath,
      fileSize: found.fileSize,
    }
  }

  const needle = trimmed.toLowerCase()
  const candidates = await listReportTargets({ dir: opts.dir, limit: 500 })
  const matches = candidates.filter(info => {
    if (info.sessionId.toLowerCase().startsWith(needle)) return true
    if (info.customTitle?.toLowerCase().includes(needle)) return true
    if (info.summary?.toLowerCase().includes(needle)) return true
    if (info.firstPrompt?.toLowerCase().includes(needle)) return true
    if (info.cwd?.toLowerCase().includes(needle)) return true
    return false
  })
  if (matches.length === 0) return undefined
  const best = matches.reduce(
    (a, b) => (b.lastModified > a.lastModified ? b : a),
    matches[0]!,
  )
  const found = await resolveSessionFilePath(best.sessionId, best.cwd ?? opts.dir)
  if (!found) return undefined
  return {
    sessionId: best.sessionId,
    filePath: found.filePath,
    projectPath: found.projectPath,
    fileSize: found.fileSize,
    info: best,
  }
}

type PendingCall = { name: string; at: string; command?: string; testIndex?: number }

/**
 * Turn a transcript into evidence.
 *
 * The stream is projected, never retained: each line is parsed, reduced to the
 * rows above, and released. Ordering is by file order, which is the order the
 * session actually happened in; the parent chain is not walked because a report
 * describes a sequence of work rather than reconstructing a branch topology, and
 * a truncated or compacted file can have a broken chain.
 */
export async function condenseTranscript(
  filePath: string,
  opts: { maxBytes?: number; maxLineBytes?: number; fileSize?: number } = {},
): Promise<TranscriptEvidence> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const maxLineBytes = opts.maxLineBytes ?? MAX_LINE_BYTES
  const fileSize = opts.fileSize ?? (await stat(filePath)).size

  const evidence: TranscriptEvidence = {
    sessionId: basename(filePath, '.jsonl'),
    fileSize,
    bytesRead: 0,
    truncated: false,
    skippedOversizedLine: false,
    counts: {
      user: 0,
      assistant: 0,
      system: 0,
      toolCalls: 0,
      toolErrors: 0,
      sidechain: 0,
    },
    userTurns: [],
    files: [],
    commands: [],
    tests: [],
    toolCounts: [],
    compactBoundaries: [],
    subagentTranscripts: 0,
    subagentIds: [],
    omitted: { userTurns: 0, commands: 0 },
  }

  const byPath = new Map<string, FileTouch>()
  const toolCounts = new Map<string, number>()
  const pending = new Map<string, PendingCall>()
  const pendingByCommand = new Map<string, CommandRun>()
  const subagents = new Set<string>()

  const noteUserTurn = (turn: UserTurn) => {
    if (evidence.userTurns.length < MAX_USER_TURNS) evidence.userTurns.push(turn)
    else evidence.omitted.userTurns += 1
  }
  const touch = (path: string, kind: 'write' | 'edit' | 'read') => {
    let entry = byPath.get(path)
    if (!entry) {
      entry = { path, writes: 0, edits: 0, reads: 0 }
      byPath.set(path, entry)
    }
    if (kind === 'write') entry.writes += 1
    else if (kind === 'edit') entry.edits += 1
    else entry.reads += 1
  }

  const handleToolUse = (block: Record<string, unknown>, at: string) => {
    const name = typeof block.name === 'string' ? block.name : 'unknown'
    const id = typeof block.id === 'string' ? block.id : undefined
    toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1)
    evidence.counts.toolCalls += 1

    const input = (block.input ?? {}) as Record<string, unknown>
    const filePathValue =
      typeof input.file_path === 'string'
        ? input.file_path
        : typeof input.notebook_path === 'string'
          ? input.notebook_path
          : undefined

    if (name === 'Write' && filePathValue) touch(filePathValue, 'write')
    else if (
      (name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit') &&
      filePathValue
    )
      touch(filePathValue, 'edit')
    else if (name === 'Read' && filePathValue) touch(filePathValue, 'read')

    const command =
      name === 'Bash' && typeof input.command === 'string'
        ? input.command
        : undefined

    let testIndex: number | undefined
    if (command) {
      // The test row is created here and filled in by the result, because the
      // result is the only place a pass or fail is stated. Holding its index
      // rather than re-matching on command text keeps a repeated command from
      // overwriting an earlier run's verdict.
      if (TEST_COMMAND_RE.test(command)) {
        testIndex = evidence.tests.length
        evidence.tests.push({
          at,
          command: command.slice(0, COMMAND_LIMIT),
          ok: false,
          summary: '',
        })
      }
      const run: CommandRun = {
        at,
        command: command.slice(0, COMMAND_LIMIT),
        excerpt: '',
      }
      if (evidence.commands.length < MAX_COMMANDS) {
        evidence.commands.push(run)
        if (id) pendingByCommand.set(id, run)
      } else {
        evidence.omitted.commands += 1
      }
    }

    if (id) pending.set(id, { name, at, command, testIndex })
  }

  const handleToolResult = (
    block: Record<string, unknown>,
    at: string,
  ) => {
    const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined
    const failed = block.is_error === true
    if (failed) evidence.counts.toolErrors += 1
    const text = blockText(block.content)
    if (id) {
      const run = pendingByCommand.get(id)
      if (run) {
        run.failed = failed
        run.excerpt = text.slice(0, RESULT_EXCERPT_LIMIT)
      }
      const call = pending.get(id)
      if (call?.testIndex !== undefined) {
        const test = evidence.tests[call.testIndex]
        if (test) {
          test.ok = !failed && !FAIL_RE.test(text)
          test.summary = text.slice(0, RESULT_EXCERPT_LIMIT)
        }
      }
      pending.delete(id)
      pendingByCommand.delete(id)
    }
  }

  const handleRecord = (rec: Record<string, unknown>) => {
    const type = rec.type
    const at = typeof rec.timestamp === 'string' ? rec.timestamp : ''
    if (rec.isSidechain === true) evidence.counts.sidechain += 1
    if (typeof rec.agentId === 'string') subagents.add(rec.agentId)

    if (!evidence.cwd && typeof rec.cwd === 'string') evidence.cwd = rec.cwd
    if (!evidence.gitBranch && typeof rec.gitBranch === 'string')
      evidence.gitBranch = rec.gitBranch
    if (!evidence.version && typeof rec.version === 'string')
      evidence.version = rec.version
    if (at) {
      if (!evidence.firstAt) evidence.firstAt = at
      evidence.lastAt = at
    }

    if (type === 'system') {
      evidence.counts.system += 1
      if (rec.subtype === 'compact_boundary') {
        const meta = (rec.compactMetadata ?? {}) as Record<string, unknown>
        evidence.compactBoundaries.push({
          at,
          trigger: typeof meta.trigger === 'string' ? meta.trigger : undefined,
          preTokens: typeof meta.preTokens === 'number' ? meta.preTokens : undefined,
          messagesSummarized:
            typeof meta.messagesSummarized === 'number'
              ? meta.messagesSummarized
              : undefined,
        })
      }
      return
    }

    if (type !== 'user' && type !== 'assistant') return
    const message = rec.message
    if (!message || typeof message !== 'object') return
    const blocks = contentBlocks((message as Record<string, unknown>).content)

    if (type === 'assistant') {
      // Only the tool calls are kept. What the assistant said about them is the
      // part a report is written from rather than built out of: prose about
      // intent cannot be derived from a transcript, and 200 truncated excerpts
      // of it would cost more context than they carry. The record is counted,
      // because "how much work happened" is a fact the report can use.
      evidence.counts.assistant += 1
      for (const block of blocks) {
        if (block.type === 'tool_use') handleToolUse(block, at)
      }
      return
    }

    // A user record is either a real instruction or a container for tool
    // results; the two are told apart by the blocks, not by the record type.
    evidence.counts.user += 1
    let instruction = ''
    for (const block of blocks) {
      if (block.type === 'tool_result') handleToolResult(block, at)
      else if (block.type === 'text' && typeof block.text === 'string')
        instruction += (instruction ? '\n' : '') + block.text
    }
    const trimmedInstruction = instruction.trim()
    if (!trimmedInstruction) return
    // Meta and transcript-only records are harness bookkeeping; a compact
    // summary is kept but marked, because it stands in for elided history and
    // a report that quotes it as an instruction would misattribute it.
    if (rec.isMeta === true || rec.isVisibleInTranscriptOnly === true) return
    noteUserTurn({
      at,
      text: trimmedInstruction.slice(0, USER_TEXT_LIMIT),
      compactSummary: rec.isCompactSummary === true ? true : undefined,
    })
  }

  // Byte-aware streaming. readline would hide byte counts, and the byte budget
  // is the only thing standing between this and an unbounded read.
  //
  // The budget is spent per line rather than per chunk: a chunk boundary has
  // nothing to do with the transcript's size, so charging a whole chunk would
  // let a small file overshoot the budget entirely and make the limit
  // untestable.
  const stream = createReadStream(filePath, { encoding: 'utf8', highWaterMark: 1 << 20 })
  let carry = ''
  let skipping = false
  let bytesRead = 0
  let consumed = 0
  try {
    for await (const chunk of stream) {
      const text = chunk as string
      bytesRead += Buffer.byteLength(text)
      evidence.bytesRead = bytesRead
      carry += text

      let index = carry.indexOf('\n')
      while (index >= 0) {
        const line = carry.slice(0, index)
        carry = carry.slice(index + 1)
        consumed += Buffer.byteLength(line) + 1
        if (line) {
          if (Buffer.byteLength(line) > maxLineBytes) {
            // A single record can be enormous — a pasted file, a screenshot —
            // and it is never worth the whole budget.
            evidence.skippedOversizedLine = true
          } else if (!skipping) {
            parseLine(line, handleRecord)
          }
        }
        // The fragment of an abandoned record ends at the first newline, so
        // exactly one line is discarded before parsing resumes.
        skipping = false
        if (consumed >= maxBytes) {
          evidence.truncated = true
          break
        }
        index = carry.indexOf('\n')
      }
      if (evidence.truncated) break

      // A partial line already past the ceiling cannot be completed within it:
      // drop it and resynchronise instead of growing the carry buffer with the
      // record.
      if (index < 0 && Buffer.byteLength(carry) > maxLineBytes) {
        carry = ''
        skipping = true
        evidence.skippedOversizedLine = true
      }
    }
    if (!evidence.truncated && !skipping && carry) parseLine(carry, handleRecord)
  } finally {
    stream.destroy()
  }

  evidence.files = [...byPath.values()].sort(
    (a, b) => b.writes + b.edits + b.reads - (a.writes + a.edits + a.reads),
  )
  evidence.toolCounts = [...toolCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
  evidence.subagentIds = [...subagents]
  evidence.subagentTranscripts = await countSubagentTranscripts(filePath)
  return evidence
}

/**
 * Records are newline-delimited JSON written by many versions of this program,
 * so a line that fails to parse is expected rather than exceptional and is
 * skipped. Failing the whole report over one bad line would be the wrong trade:
 * the rest of the transcript is still true.
 */
function parseLine(line: string, handle: (rec: Record<string, unknown>) => void): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
    handle(parsed as Record<string, unknown>)
}

/** Message content is a plain string in older records and a block array in
 *  newer ones; both appear in the same file, so both must be readable. */
function contentBlocks(content: unknown): Record<string, unknown>[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return []
  return content.filter(
    (block): block is Record<string, unknown> =>
      !!block && typeof block === 'object' && !Array.isArray(block),
  )
}

/** Tool results are a string or a block array depending on the tool. */
function blockText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => {
      if (typeof block === 'string') return block
      if (block && typeof block === 'object' && 'text' in block)
        return String((block as { text?: unknown }).text ?? '')
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

/**
 * A session that spawned subagents leaves their transcripts in a directory
 * beside its own. Their content is not condensed — a report about a session
 * should mention that delegated work happened, and a delegated transcript is
 * its own session's business.
 */
async function countSubagentTranscripts(filePath: string): Promise<number> {
  const sessionId = basename(filePath, '.jsonl')
  const dir = join(dirname(filePath), sessionId, 'subagents')
  try {
    const entries = await readdir(dir)
    return entries.filter(name => name.endsWith('.jsonl')).length
  } catch {
    return 0
  }
}

