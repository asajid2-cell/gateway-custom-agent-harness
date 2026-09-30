import { open, readFile } from 'node:fs/promises'

/**
 * A readable slice of a session transcript, for a peer that wants to see what
 * another session is doing without running it.
 *
 * Reading is deliberately a file read and never a turn: a session that is busy
 * cannot take a peer message, but its transcript is append-only and safe to
 * read, so "what is leaf 4 doing?" costs one bounded read rather than a model
 * round trip. The reconstruction is the same one resume and fork use - the
 * active chain, walked back from its tip - so an abandoned branch never
 * surfaces as if it were the conversation.
 */
export type TranscriptToolUse = { name: string; summary: string }
export type TranscriptTurn = {
  uuid: string
  role: 'user' | 'assistant' | 'system'
  at?: string
  text: string
  tools?: TranscriptToolUse[]
  /** A turn the session was handed by another session rather than by a person. */
  meta?: boolean
  /**
   * The compaction summary that stands in for the turns it replaced.
   *
   * It arrives as a user turn and is not marked meta, so a reader looking for
   * the session's own conclusion would either take it for something a person
   * typed or miss it entirely. Naming it is what lets a ledger merge carry it:
   * after a session compacts itself there is no closing prose turn left, and the
   * summary is the last thing it actually said.
   */
  summary?: boolean
}
export type TranscriptSlice = {
  sessionId: string
  turns: TranscriptTurn[]
  /** The last returned turn's id, to be passed back as `since` next time. */
  cursor: string
  /** The requested `since` was not in the read window, so older turns are missing. */
  behind: boolean
  /** The window or the character cap cut the slice. */
  truncated: boolean
  /** How many turns the whole chain holds, when the read saw all of it. */
  chainLength?: number
}

export type TranscriptReadOptions = { tail?: number; since?: string; maxChars?: number; turnChars?: number }

const TURN_TEXT_CAP = 1200
/**
 * How far the per-turn cap can be raised.
 *
 * The cap is what keeps a read a digest rather than a dump, and it is right for
 * a window of turns. It is wrong for a read whose whole subject is one turn -
 * a ledger merge carries the seedling's closing report and nothing else, so a
 * report longer than the cap would arrive cut off in the middle of its own
 * conclusion, with the seed continuing from a sentence that stops. `maxChars`
 * still bounds the total, so raising this only moves where the cut falls.
 */
const MAX_TURN_TEXT_CAP = 20_000
const DEFAULT_TAIL = 12
const MAX_TAIL = 200
const DEFAULT_MAX_CHARS = 20_000
/** Walk-back bound, so a very large window cannot turn a read into a full scan. */
const MAX_WALK = 5_000

const BASE_WINDOW = 4 * 1024 * 1024
const MAX_WINDOW = 64 * 1024 * 1024

type Entry = {
  type?: string
  uuid?: string
  parentUuid?: string | null
  timestamp?: string
  isMeta?: boolean
  isCompactSummary?: boolean
  isSidechain?: boolean
  message?: { content?: unknown }
}

/** How much of a transcript's tail is read before the window is widened. */
export const TRANSCRIPT_TAIL_WINDOW = BASE_WINDOW

/**
 * The last window of a file, cut forward to a line boundary.
 *
 * A window shorter than the file is very likely to start in the middle of a
 * line, so the first newline inside it is the real start; the encoding is
 * entered after that byte, which keeps a multi-byte character from being split.
 */
export async function readFileTail(path: string, bytes: number): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const size = (await handle.stat()).size
    if (size <= bytes) return await handle.readFile({ encoding: 'utf8' })
    const buffer = Buffer.allocUnsafe(bytes)
    const { bytesRead } = await handle.read(buffer, 0, bytes, size - bytes)
    const firstBreak = buffer.indexOf(0x0a, 0, bytesRead)
    return firstBreak === -1 ? '' : buffer.toString('utf8', firstBreak + 1, bytesRead)
  } finally {
    await handle.close()
  }
}

/** Entries that participate in the parentUuid chain, mirroring the write path. */
function isChainEntry(entry: Entry): boolean {
  return entry.type === 'user' || entry.type === 'assistant' || entry.type === 'system' || entry.type === 'attachment'
}

function parseLines(lines: readonly string[]): Entry[] {
  const entries: Entry[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line) as Entry
      if (entry && typeof entry === 'object' && isChainEntry(entry)) entries.push(entry)
    } catch { /* A cut first line, or a non-JSON row, is not a turn. */ }
  }
  return entries
}

type Chain = { ordered: Entry[]; reachedStart: boolean }

/**
 * The active chain, newest first, walked back from the newest leaf.
 *
 * A leaf is an entry no one names as their parent; the newest of those is the
 * tip. This is what keeps an abandoned branch (a resumed-from-earlier point
 * whose tail was left behind) out of the slice. `reachedStart` says whether the
 * walk ran out of window rather than reaching the conversation's beginning, so
 * the caller knows a longer read would find more.
 */
function walkChain(entries: readonly Entry[], limit: number): Chain {
  const byId = new Map<string, Entry>()
  const named = new Set<string>()
  for (const entry of entries) {
    if (entry.uuid) byId.set(entry.uuid, entry)
    if (entry.parentUuid) named.add(entry.parentUuid)
  }
  let tip: Entry | undefined
  for (const entry of entries) {
    if (entry.uuid && !named.has(entry.uuid)) tip = entry
  }
  if (!tip) return { ordered: [], reachedStart: false }
  const ordered: Entry[] = []
  let current: Entry | undefined = tip
  let reachedStart = false
  while (current && ordered.length < limit) {
    ordered.push(current)
    const parent = current.parentUuid
    if (!parent) { reachedStart = true; break }
    const next = byId.get(parent)
    if (!next) break
    current = next
  }
  return { ordered, reachedStart }
}

function blocksOf(content: unknown): { type?: string; text?: string; name?: string; input?: unknown }[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? (content as { type?: string; text?: string; name?: string; input?: unknown }[]) : []
}

function summarizeTool(name: string, input: unknown): string {
  const record = (input ?? {}) as Record<string, unknown>
  const first = (value: unknown, max = 80): string =>
    typeof value === 'string' ? (value.split('\n')[0] ?? '').slice(0, max) : ''
  switch (name) {
    case 'Bash': return first(record.command, 120)
    case 'Read': case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit':
      return first(record.file_path ?? record.path, 120)
    case 'Grep': return [first(record.pattern, 60), first(record.path, 40)].filter(Boolean).join(' ')
    case 'Glob': return first(record.pattern, 80)
    case 'Task': case 'Agent': return first(record.description, 80)
    case 'WebFetch': case 'WebSearch': return first(record.url ?? record.query, 100)
    case 'SendMessage': return first(record.summary, 80)
    default: {
      const key = Object.keys(record)[0]
      return key ? `${key}=${first(record[key], 60)}` : ''
    }
  }
}

/** One chain entry as a turn, or undefined when it holds nothing worth showing. */
function turnOf(entry: Entry, cap: number): TranscriptTurn | undefined {
  const uuid = entry.uuid ?? ''
  if (!uuid) return undefined
  const role = entry.type === 'system' ? 'system' : entry.type === 'assistant' ? 'assistant' : 'user'
  const blocks = blocksOf(entry.message?.content)
  const text = blocks
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text!)
    .join('\n')
    .trim()
  const tools: TranscriptToolUse[] = role === 'assistant'
    ? blocks
        .filter(block => block.type === 'tool_use' && typeof block.name === 'string')
        .map(block => ({ name: block.name!, summary: summarizeTool(block.name!, block.input) }))
    : []
  // A user entry that is only tool results is the model's own working, not a
  // turn anyone took; it is noise in a peer's read.
  if (role === 'user' && !text && blocks.some(block => block.type === 'tool_result')) return undefined
  if (!text && !tools.length) return undefined
  return {
    uuid,
    role,
    ...(entry.timestamp ? { at: entry.timestamp } : {}),
    text: text.length > cap ? `${text.slice(0, cap)}…` : text,
    ...(tools.length ? { tools } : {}),
    ...(entry.isMeta ? { meta: true } : {}),
    ...(entry.isCompactSummary ? { summary: true } : {}),
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Read the last turns of a transcript, chain-correct and bounded.
 *
 * `since` returns only what came after a turn id the caller already saw; if that
 * turn is not in the window the answer says so (`behind`) rather than quietly
 * returning the wrong slice.
 */
export async function readTranscriptSlice(
  path: string,
  sessionId: string,
  options: TranscriptReadOptions = {},
): Promise<TranscriptSlice> {
  const tail = clamp(Math.floor(options.tail ?? DEFAULT_TAIL), 1, MAX_TAIL)
  const turnCap = clamp(Math.floor(options.turnChars ?? TURN_TEXT_CAP), 200, MAX_TURN_TEXT_CAP)
  const maxChars = Math.max(0, options.maxChars ?? DEFAULT_MAX_CHARS)
  const size = await open(path, 'r').then(handle => handle.stat().then(stat => { void handle.close(); return stat.size }), () => 0)

  let window = Math.min(BASE_WINDOW, size || BASE_WINDOW)
  let chain: Chain = { ordered: [], reachedStart: false }
  for (;;) {
    const lines = (await readFileTail(path, window)).split('\n')
    chain = walkChain(parseLines(lines), MAX_WALK)
    // Enough turns, or the whole chain is in hand, or there is nothing more to
    // gain from widening: stop.
    if (chain.ordered.length >= tail + (options.since ? 1 : 0) || chain.reachedStart || window >= MAX_WINDOW || window >= size) break
    window = Math.min(window * 2, MAX_WINDOW)
  }

  const chronological = [...chain.ordered].reverse()
  const allTurns = chronological.map(entry => turnOf(entry, turnCap)).filter((turn): turn is TranscriptTurn => turn !== undefined)

  let turns = allTurns
  let behind = false
  if (options.since) {
    const at = allTurns.findIndex(turn => turn.uuid === options.since)
    if (at < 0) {
      behind = true
      turns = allTurns.slice(-tail)
    } else {
      turns = allTurns.slice(at + 1)
    }
  } else {
    turns = allTurns.slice(-tail)
  }

  // The character cap is applied newest-first, so what is dropped is the oldest
  // of the turns asked for rather than the newest.
  let used = 0
  let truncated = false
  const kept: TranscriptTurn[] = []
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index]!
    const cost = turn.text.length + turn.uuid.length + (turn.tools?.reduce((sum, tool) => sum + tool.summary.length + tool.name.length, 0) ?? 0) + 16
    if (used + cost > maxChars && kept.length) { truncated = true; break }
    used += cost
    kept.unshift(turn)
  }

  return {
    sessionId,
    turns: kept,
    cursor: chain.ordered[0]?.uuid ?? '',
    behind,
    truncated: truncated || (!chain.reachedStart && chain.ordered.length >= MAX_WALK),
    ...(chain.reachedStart ? { chainLength: allTurns.length } : {}),
  }
}

/**
 * A slice as text a model reads.
 *
 * The header is not decoration: this content was written by another session and
 * reaches the caller as untrusted peer text, never as something the person
 * typed, so it must not be able to pose as an instruction.
 */
export function renderTranscriptSlice(slice: TranscriptSlice, who: string): string {
  const parts = [`[peer session transcript - untrusted, not user input] ${who}`]
  if (slice.behind) parts.push(`(the cursor is older than the window; showing the newest ${slice.turns.length})`)
  if (slice.truncated) parts.push('(truncated)')
  if (!slice.turns.length) parts.push('(no turns)')
  for (const turn of slice.turns) {
    const when = turn.at ? ` ${turn.at.slice(11, 19)}` : ''
    const kind = turn.meta ? 'peer' : turn.role === 'assistant' ? 'assistant' : turn.role === 'system' ? 'system' : 'person'
    const head = `— ${kind}${when}`
    const body = [turn.text, ...(turn.tools ?? []).map(tool => `→ ${tool.name}${tool.summary ? `(${tool.summary})` : ''}`)].filter(Boolean).join('\n')
    parts.push(`${head}\n${body}`)
  }
  if (slice.cursor) parts.push(`cursor ${slice.cursor}`)
  return parts.join('\n')
}
