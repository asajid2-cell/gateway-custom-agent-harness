import { createHash } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { readJournal, withVaultLock } from './journal.js'

/**
 * The capture queue: the scribe's inbox.
 *
 * A capture is a POINTER to a transcript span, never a copy of the text. Text
 * in the queue would be a second source of truth, and the envelope's
 * `evidence[]` already says an event is a span of the original rather than a
 * copy of it. The pointer is verifiable instead: re-read the span, hash it,
 * compare with `span_sha256`.
 *
 * Paths are relative to a NAMED root (`transcript_root`), never absolute. A
 * transcript archive that moves is then a settings change rather than tens of
 * thousands of dangling pointers, and the hash still proves the span after the
 * move.
 *
 * The file is append-only with two record kinds - `capture` and `captured` - so
 * "was this turn captured" and "what captured it" are the same lookup, and a
 * completeness count does not need a join nobody runs.
 */

export type CapturePointer = {
  session_id: string
  message_id: string
  /** The name of a configured transcript root, not a filesystem path. */
  transcript_root: string
  /** Path inside that root. Absolute paths and `..` are refused. */
  relative_path: string
  span_sha256: string
  observed_at: string
}

export type CaptureEntry = CapturePointer & {
  capture_id: string
  family_id: string
  at: string
  /** Set once a committed event cites this span. */
  captured_by?: { event_id: string; at: string }
}

export type CaptureRefusal =
  | { ok: false; reason: 'absolute-path' | 'parent-path' | 'missing-field' | 'unknown-capture'; message: string }

export type CaptureAccepted = { ok: true; capture_id: string; duplicate: boolean; family_id: string }

type Line = Record<string, unknown> & { kind?: string; capture_id?: string }

export function captureIdFor(familyId: string, pointer: CapturePointer): string {
  const digest = createHash('sha256')
    .update(
      [familyId, pointer.session_id, pointer.message_id, pointer.transcript_root, pointer.relative_path, pointer.span_sha256].join('\u0000'),
      'utf8',
    )
    .digest('hex')
  return `cap:${digest.slice(0, 32)}`
}

function capturesPath(vaultRoot: string, familyId: string): string {
  return join(vaultRoot, 'families', familyId, 'captures.jsonl')
}

function validate(pointer: Partial<CapturePointer>): CaptureRefusal | null {
  const required: (keyof CapturePointer)[] = [
    'session_id',
    'message_id',
    'transcript_root',
    'relative_path',
    'span_sha256',
    'observed_at',
  ]
  for (const key of required) {
    const value = pointer[key]
    if (typeof value !== 'string' || value.trim() === '') {
      return { ok: false, reason: 'missing-field', message: `capture pointer is missing ${key}` }
    }
  }
  const relative = pointer.relative_path as string
  if (isAbsolute(relative) || /^[A-Za-z]:[\\/]/.test(relative) || relative.startsWith('\\\\')) {
    return {
      ok: false,
      reason: 'absolute-path',
      message: 'relative_path must be relative to transcript_root; an absolute path dangles when the root moves',
    }
  }
  if (relative.split(/[\\/]/).includes('..')) {
    return { ok: false, reason: 'parent-path', message: 'relative_path must not contain ..; a capture must not escape its root' }
  }
  return null
}

async function readLines(vaultRoot: string, familyId: string): Promise<Line[]> {
  let raw: string
  try {
    raw = await readFile(capturesPath(vaultRoot, familyId), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const lines: Line[] = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try {
      lines.push(JSON.parse(line) as Line)
    } catch {
      continue
    }
  }
  return lines
}

async function appendLines(vaultRoot: string, familyId: string, records: Line[]): Promise<void> {
  const path = capturesPath(vaultRoot, familyId)
  await mkdir(dirname(path), { recursive: true })
  const text = records.map(record => `${JSON.stringify(record)}\n`).join('')
  const handle = await open(path, 'a')
  try {
    await handle.writeFile(text)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** Fold the append-only file into entries with their captured marker applied. */
export function foldCaptures(lines: Line[]): Map<string, CaptureEntry> {
  const entries = new Map<string, CaptureEntry>()
  for (const line of lines) {
    const id = typeof line.capture_id === 'string' ? line.capture_id : null
    if (!id) continue
    if (line.kind === 'captured') {
      const entry = entries.get(id)
      if (entry) entry.captured_by = { event_id: String(line.event_id ?? ''), at: String(line.at ?? '') }
      continue
    }
    if (line.kind !== 'capture') continue
    const { kind: _kind, ...rest } = line
    void _kind
    entries.set(id, { ...(rest as unknown as CaptureEntry), family_id: String(line.family_id ?? '') })
  }
  return entries
}

export async function capturePointer(input: {
  vaultRoot: string
  familyId: string
  pointer: CapturePointer
}): Promise<CaptureAccepted | CaptureRefusal> {
  const refusal = validate(input.pointer)
  if (refusal) return refusal
  const captureId = captureIdFor(input.familyId, input.pointer)
  return withVaultLock(join(input.vaultRoot, 'families', input.familyId), async () => {
    const lines = await readLines(input.vaultRoot, input.familyId)
    if (lines.some(line => line.kind === 'capture' && line.capture_id === captureId)) {
      return { ok: true, capture_id: captureId, duplicate: true, family_id: input.familyId }
    }
    await appendLines(input.vaultRoot, input.familyId, [
      {
        kind: 'capture',
        capture_id: captureId,
        family_id: input.familyId,
        ...input.pointer,
        at: new Date().toISOString(),
      },
    ])
    return { ok: true, capture_id: captureId, duplicate: false, family_id: input.familyId }
  })
}

/**
 * Mark a capture as committed, naming the event that cites it. The event id is
 * the point: a boolean would answer "was this captured" but not "by what", and
 * the second question is the one an audit asks.
 */
export async function markCaptured(input: {
  vaultRoot: string
  familyId: string
  captureId: string
  eventId: string
}): Promise<CaptureAccepted | CaptureRefusal> {
  if (!input.eventId.trim()) {
    return { ok: false, reason: 'missing-field', message: 'markCaptured needs the committed event_id' }
  }
  return withVaultLock(join(input.vaultRoot, 'families', input.familyId), async () => {
    const entries = foldCaptures(await readLines(input.vaultRoot, input.familyId))
    const entry = entries.get(input.captureId)
    if (!entry) {
      return { ok: false, reason: 'unknown-capture', message: `no capture ${input.captureId} in family ${input.familyId}` }
    }
    if (entry.captured_by) {
      return { ok: true, capture_id: input.captureId, duplicate: true, family_id: input.familyId }
    }
    await appendLines(input.vaultRoot, input.familyId, [
      {
        kind: 'captured',
        capture_id: input.captureId,
        family_id: input.familyId,
        event_id: input.eventId,
        at: new Date().toISOString(),
      },
    ])
    return { ok: true, capture_id: input.captureId, duplicate: false, family_id: input.familyId }
  })
}

export async function listCaptures(
  vaultRoot: string,
  familyId: string,
  options: { pendingOnly?: boolean } = {},
): Promise<CaptureEntry[]> {
  const entries = [...foldCaptures(await readLines(vaultRoot, familyId)).values()]
  const filtered = options.pendingOnly ? entries.filter(entry => !entry.captured_by) : entries
  return filtered.sort((left, right) => left.capture_id.localeCompare(right.capture_id))
}

/**
 * Close the loop after a commit: every pending capture whose span a committed
 * event cites is marked with that event's id.
 *
 * Matching is by `span_sha256` only. A message id alone does not prove the span
 * is the same one, and marking on a weaker match would make the queue claim a
 * capture that was never verified - the queue's whole value is that its marks
 * are true. An evidence entry with no span hash therefore marks nothing.
 */
export async function markCapturedBySpans(input: {
  vaultRoot: string
  familyId: string
  eventId: string
  spanSha256: readonly string[]
}): Promise<{ marked: number }> {
  const wanted = new Set(input.spanSha256.filter(value => value.trim() !== ''))
  if (wanted.size === 0) return { marked: 0 }
  return withVaultLock(join(input.vaultRoot, 'families', input.familyId), async () => {
    const entries = foldCaptures(await readLines(input.vaultRoot, input.familyId))
    const pending = [...entries.values()].filter(entry => !entry.captured_by && wanted.has(entry.span_sha256))
    if (pending.length === 0) return { marked: 0 }
    const at = new Date().toISOString()
    await appendLines(
      input.vaultRoot,
      input.familyId,
      pending.map(entry => ({
        kind: 'captured',
        capture_id: entry.capture_id,
        family_id: input.familyId,
        event_id: input.eventId,
        at,
      })),
    )
    return { marked: pending.length }
  })
}

export type CaptureCompleteness = {
  captured: number
  pending: number
  total: number
  committed_events: number
  /** Whether anything has ever appended a capture for this family. */
  producer: 'connected' | 'absent'
  /**
   * `healthy` means captures exist, so the counts mean something. `no-captures`
   * means the family has committed events and never captured one - a zero that
   * must not be read as coverage. `idle` means neither exists yet.
   */
  state: 'healthy' | 'no-captures' | 'idle'
  note?: string
}

/**
 * A completeness count with its precondition attached.
 *
 * `captured: 0, pending: 0` is a clean bill of health on a family where nothing
 * is being recorded, which is the most dangerous way a metric can be wrong. The
 * family's committed events tell us which zero this is: events with no captures
 * is a defect to surface, not an empty success.
 */
export async function captureCompleteness(
  vaultRoot: string,
  familyId: string,
): Promise<CaptureCompleteness> {
  const entries = [...foldCaptures(await readLines(vaultRoot, familyId)).values()]
  const captured = entries.filter(entry => entry.captured_by).length
  const total = entries.length
  const journal = await readJournal(vaultRoot, familyId)
  const committed = journal.events.length
  const producer: CaptureCompleteness['producer'] = total > 0 ? 'connected' : 'absent'
  if (total === 0 && committed > 0) {
    return {
      captured,
      pending: 0,
      total,
      committed_events: committed,
      producer,
      state: 'no-captures',
      note: `${committed} events committed but no capture has ever been recorded; completeness is 0 of nothing, not coverage`,
    }
  }
  if (total === 0 && committed === 0) {
    return { captured, pending: 0, total, committed_events: committed, producer, state: 'idle' }
  }
  return {
    captured,
    pending: total - captured,
    total,
    committed_events: committed,
    producer,
    state: 'healthy',
  }
}
