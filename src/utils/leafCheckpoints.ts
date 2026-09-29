import { createHash } from 'node:crypto'
import { mkdir, copyFile, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { lock } from './lockfile.js'

/**
 * A named point a conversation can be branched from later.
 *
 * A checkpoint is a *copy* of a member's transcript as it stood at a tip, plus
 * the label that makes it recognizable months later. It is deliberately not a
 * session: it never appears in a roster, never gets a resume command and never
 * shows in the reader, because it is not a conversation anyone is having - it is
 * a question the family may ask again, and a branch made from it is the answer.
 * The copy is immutable and the label is not, so a checkpoint can be renamed or
 * dropped and every branch already taken from it is untouched.
 *
 * The store is a separate collection under `leaf-families/checkpoints/<family>/`
 * rather than a flag on a family member, which is what keeps the family file
 * schema - and every older reader of it - unchanged.
 */
export type LeafCheckpoint = {
  version: 1
  /** Deterministic on the tip, so a repeated snapshot is the same checkpoint. */
  id: string
  familyId: string
  /** The identity; the label is only the mnemonic and may repeat. */
  ordinal: number
  label: string
  sourceSessionId: string
  sourceName: string
  sourceTip: string
  sourceTipAt: string | null
  /** The whole chain's turns, when the snapshot could count them cheaply. */
  turns: number | null
  createdAt: string
  bytes: number
  droppedAt?: string
}

export type CheckpointIndex = { version: 1; nextOrdinal: number; entries: LeafCheckpoint[] }

export type RecordCheckpointInput = {
  familyId: string
  sourceSessionId: string
  sourceName: string
  sourceTip: string
  sourceTipAt?: string | null
  turns?: number | null
  transcriptPath: string
  label: string
}

const DEFAULT_LIST_WIDTH = 20
const MAX_LABEL = 40

export function checkpointDir(familyId: string): string {
  return join(getClaudeConfigHomeDir(), 'leaf-families', 'checkpoints', familyId)
}

/** The frozen copy of the conversation a branch from this checkpoint starts at. */
export function checkpointTranscriptPath(familyId: string, id: string): string {
  return join(checkpointDir(familyId), `${id}.jsonl`)
}

function checkpointMetadataPath(familyId: string, id: string): string {
  return join(checkpointDir(familyId), `${id}.json`)
}

function checkpointIndexPath(familyId: string): string {
  return join(checkpointDir(familyId), `${familyId}.index.json`)
}

/**
 * Label or no label, a checkpoint is addressed by its ordinal, and the id is
 * derived from what was snapshotted. Snapshotting the same tip twice therefore
 * finds the checkpoint it already made instead of making a second copy of the
 * same conversation under a new number.
 */
export function checkpointId(input: Pick<RecordCheckpointInput, 'familyId' | 'sourceSessionId' | 'sourceTip' | 'label'>): string {
  return createHash('sha1').update(`${input.familyId}\0${input.sourceSessionId}\0${input.sourceTip}\0${input.label}`).digest('hex').slice(0, 16)
}

/** A label that can be typed back: no spaces to quote, no path or shell letters. */
export function slugLabel(label: string): string {
  const slug = label.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return slug.slice(0, MAX_LABEL)
}

/** A default label: which leaf it came from, and when it was taken. */
export function defaultCheckpointLabel(name: string, at = new Date()): string {
  const month = `${at.getMonth() + 1}`.padStart(2, '0')
  const day = `${at.getDate()}`.padStart(2, '0')
  const hour = `${at.getHours()}`.padStart(2, '0')
  const minute = `${at.getMinutes()}`.padStart(2, '0')
  return `${slugLabel(name) || 'leaf'} ${month}-${day} ${hour}:${minute}`
}

/**
 * Written like the family file: temp file, then a rename that Windows may
 * refuse while a reader holds the target.
 */
async function writeAtomic(target: string, value: unknown): Promise<void> {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  const temporary = `${target}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 })
  for (let attempt = 0; ; attempt++) {
    try { await rename(temporary, target); return }
    catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '') || attempt >= 5) {
        await unlink(temporary).catch(() => {})
        throw error
      }
      await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)))
    }
  }
}

/**
 * The index, or an empty one.
 *
 * An unreadable index is treated as empty rather than fatal, for the same reason
 * a family file is: a store that cannot be listed must not take the family down
 * with it. The bytes on disk are the durable part; this is the summary.
 */
export async function readCheckpointIndex(familyId: string): Promise<CheckpointIndex> {
  try {
    const parsed = JSON.parse(await readFile(checkpointIndexPath(familyId), 'utf8')) as CheckpointIndex
    if (parsed && Array.isArray(parsed.entries) && Number.isSafeInteger(parsed.nextOrdinal)) return { version: 1, nextOrdinal: parsed.nextOrdinal, entries: parsed.entries }
  } catch { /* No checkpoints yet, or the summary is unreadable. */ }
  return { version: 1, nextOrdinal: 1, entries: [] }
}

/**
 * Where ordinals are handed out.
 *
 * The lock target has to exist before it can be locked, and it must not be a file
 * any reader needs - so it is a marker beside the index. Everything that changes
 * the index takes this lock, which is what keeps numbering monotonic: an ordinal
 * is allocated once and never reused, so `#3` names one conversation forever,
 * even after `#3` is dropped.
 */
async function lockIndex(familyId: string): Promise<() => Promise<void>> {
  const dir = checkpointDir(familyId)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const target = join(dir, '.index')
  await writeFile(target, '', { flag: 'a' })
  return lock(target, { realpath: false, retries: { retries: 20, minTimeout: 10, maxTimeout: 100 } })
}

/**
 * Freeze a conversation and number it.
 *
 * The order is the one that cannot lie: the copy lands, then the metadata that
 * describes it, then the index that lists it. A crash between any two leaves
 * bytes nobody points at rather than a listing that points at nothing - and
 * nothing here ever deletes the source, which is the member's own transcript.
 */
export async function recordCheckpoint(input: RecordCheckpointInput): Promise<{ checkpoint: LeafCheckpoint; existed: boolean }> {
  const label = input.label
  const id = checkpointId({ ...input, label })
  const already = (await readCheckpointIndex(input.familyId)).entries.find(entry => entry.id === id)
  if (already) return { checkpoint: already, existed: true }
  const release = await lockIndex(input.familyId)
  try {
    // Read again under the lock: a second snapshot of the same tip that started
    // while this one copied is the same checkpoint, not a new number for it.
    const index = await readCheckpointIndex(input.familyId)
    const found = index.entries.find(entry => entry.id === id)
    if (found) return { checkpoint: found, existed: true }
    const transcript = checkpointTranscriptPath(input.familyId, id)
    await copyFile(input.transcriptPath, transcript)
    const checkpoint: LeafCheckpoint = {
      version: 1, id, familyId: input.familyId, ordinal: index.nextOrdinal, label,
      sourceSessionId: input.sourceSessionId, sourceName: input.sourceName, sourceTip: input.sourceTip,
      sourceTipAt: input.sourceTipAt ?? null, turns: input.turns ?? null,
      createdAt: new Date().toISOString(), bytes: (await stat(transcript)).size,
    }
    await writeAtomic(checkpointMetadataPath(input.familyId, id), checkpoint)
    await writeAtomic(checkpointIndexPath(input.familyId), { version: 1, nextOrdinal: index.nextOrdinal + 1, entries: [...index.entries, checkpoint] })
    return { checkpoint, existed: false }
  } finally { await release() }
}

/** Live checkpoints, oldest first; a dropped one is history, not a target. */
export async function listCheckpoints(familyId: string, sourceSessionId?: string): Promise<LeafCheckpoint[]> {
  const index = await readCheckpointIndex(familyId)
  return index.entries
    .filter(entry => !entry.droppedAt)
    .filter(entry => !sourceSessionId || entry.sourceSessionId === sourceSessionId)
    .sort((left, right) => left.ordinal - right.ordinal)
}

/**
 * Which entry a reference names, or a refusal.
 *
 * An ordinal is the identity and a label is only a name, so an ambiguous label
 * is refused rather than guessed - the same rule leaf references follow.
 */
function matchIndex(entries: readonly LeafCheckpoint[], reference: string): number {
  const ref = reference.trim().replace(/^#/, '')
  if (!ref) return -1
  if (/^\d+$/.test(ref)) return entries.findIndex(entry => entry.ordinal === Number(ref))
  const matches = entries.map((entry, index) => ({ entry, index })).filter(item => item.entry.label.toLowerCase() === ref.toLowerCase())
  if (matches.length > 1) throw new Error(`Ambiguous checkpoint ${reference}; use its number`)
  return matches[0]?.index ?? -1
}

/** Find one checkpoint by `#3`, `3`, or label. */
export async function findCheckpoint(familyId: string, reference: string, options: { includeDropped?: boolean } = {}): Promise<LeafCheckpoint | undefined> {
  const entries = (await readCheckpointIndex(familyId)).entries.filter(entry => options.includeDropped || !entry.droppedAt)
  const at = matchIndex(entries, reference)
  return at < 0 ? undefined : entries[at]
}

/** Change one entry of the index, or drop it from the index with `undefined`. */
async function mutateCheckpoint(familyId: string, reference: string, mutate: (entry: LeafCheckpoint) => LeafCheckpoint | undefined): Promise<LeafCheckpoint> {
  const release = await lockIndex(familyId)
  try {
    const index = await readCheckpointIndex(familyId)
    const at = matchIndex(index.entries, reference)
    if (at < 0) throw new Error('Unknown checkpoint')
    const entry = index.entries[at]!
    const next = mutate(entry)
    if (next) index.entries[at] = next
    else index.entries.splice(at, 1)
    await writeAtomic(checkpointIndexPath(familyId), { version: 1, nextOrdinal: index.nextOrdinal, entries: index.entries })
    return next ?? entry
  } finally { await release() }
}

/**
 * Stop offering a checkpoint, and keep its bytes.
 *
 * Dropping is what a person means by "I do not need this any more", and it is
 * not the same as deleting: a branch taken from it must keep working, and a
 * snapshot that is merely hidden can be purged - deliberately, and only then.
 */
export async function dropCheckpoint(familyId: string, reference: string): Promise<LeafCheckpoint> {
  const checkpoint = await findCheckpoint(familyId, reference, { includeDropped: true })
  if (!checkpoint) throw new Error('Unknown checkpoint')
  if (checkpoint.droppedAt) return checkpoint
  return mutateCheckpoint(familyId, reference, entry => ({ ...entry, droppedAt: new Date().toISOString() }))
}

/**
 * Delete a checkpoint's bytes.
 *
 * Only after the metadata has been read back and matches: a purge that runs
 * ahead of a half-written save would delete the copy a listing still names. If
 * the metadata cannot be verified, nothing is deleted.
 */
export async function purgeCheckpoint(familyId: string, reference: string): Promise<LeafCheckpoint> {
  const checkpoint = await findCheckpoint(familyId, reference, { includeDropped: true })
  if (!checkpoint) throw new Error('Unknown checkpoint')
  const metadata = JSON.parse(await readFile(checkpointMetadataPath(familyId, checkpoint.id), 'utf8')) as LeafCheckpoint
  if (metadata?.id !== checkpoint.id) throw new Error('Checkpoint metadata does not match; nothing was deleted')
  await unlink(checkpointTranscriptPath(familyId, checkpoint.id)).catch(() => {})
  await unlink(checkpointMetadataPath(familyId, checkpoint.id)).catch(() => {})
  return mutateCheckpoint(familyId, reference, () => undefined)
}

export function sizeLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** The list a person or a model reads: ordinal first, because that is the name. */
export function renderCheckpoints(entries: readonly LeafCheckpoint[], familyId: string): string {
  if (!entries.length) return `No checkpoints for family ${familyId}.`
  const width = Math.min(DEFAULT_LIST_WIDTH, Math.max(...entries.map(entry => entry.label.length)))
  const lines = [`checkpoints for family ${familyId}`]
  for (const entry of entries) {
    const when = `${entry.createdAt.slice(5, 10)} ${entry.createdAt.slice(11, 16)}`
    const turns = entry.turns === null ? '' : `${entry.turns} turns · `
    lines.push(`#${entry.ordinal} ${entry.label.padEnd(width)}  ${when}  ${turns}${sizeLabel(entry.bytes)}  ${entry.sourceName}`)
  }
  return lines.join('\n')
}
