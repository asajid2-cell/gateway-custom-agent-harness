import { createHash } from 'node:crypto'
import { open, readFile, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { mkdir } from 'node:fs/promises'

/**
 * The authoritative journal for one family.
 *
 * Everything here exists to make one promise hold: an event that was
 * acknowledged is on disk, in order, exactly once. The lock is what makes the
 * sequence monotonic across processes, the generation fence is what stops a
 * retired scribe from writing into a rotated family, and the hash is what lets
 * a replay prove it read the same bytes the writer committed.
 */

/** Canonical JSON: sorted keys, no whitespace, stable for hashing. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error('canonicalJson: non-finite number')
    }
    if (value === undefined) throw new Error('canonicalJson: undefined is not representable')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalJson(item === undefined ? null : item)).join(',')}]`
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).filter(key => record[key] !== undefined).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

/**
 * `sha256:` + hex over the canonical body with `content_hash` omitted, so a
 * writer and a checker that never met compute the same value.
 */
export function contentHash(body: Record<string, unknown>): string {
  const { content_hash: _ignored, ...rest } = body
  void _ignored
  return `sha256:${createHash('sha256').update(canonicalJson(rest), 'utf8').digest('hex')}`
}

export type JournalEvent = {
  schema_version: number
  sequence: number
  event_id: string
  content_hash: string
  generation_id: string
  family_id: string
  [key: string]: unknown
}

/** What a scribe may submit: the writer owns sequence and content_hash. */
export type ProposedEvent = Record<string, unknown> & {
  event_id: string
  generation_id: string
}

export type AppendRejection = { event_id: string; reason: string }
export type AppendResult = {
  committed: JournalEvent[]
  duplicates: string[]
  rejected: AppendRejection[]
  watermark: number
}

export function familyJournalPath(vaultRoot: string, familyId: string): string {
  return join(vaultRoot, 'families', familyId, 'journal.jsonl')
}

export function familyRotationPath(vaultRoot: string, familyId: string): string {
  return join(vaultRoot, 'families', familyId, 'rotation.jsonl')
}

export type LockOptions = { timeoutMs?: number; staleMs?: number; pollMs?: number }

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * A cross-process lock built on exclusive create. Node has no flock, so the
 * file's existence is the lock; a lock older than `staleMs` is assumed dead and
 * is taken over, which is the only recovery a crashed writer leaves behind.
 */
export async function withVaultLock<T>(
  dir: string,
  fn: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10_000
  const staleMs = options.staleMs ?? 30_000
  const pollMs = options.pollMs ?? 30
  const lockPath = join(dir, 'writer.lock')
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  await mkdir(dir, { recursive: true })

  const deadline = Date.now() + timeoutMs
  let handle: Awaited<ReturnType<typeof open>> | null = null
  for (;;) {
    try {
      handle = await open(lockPath, 'wx')
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const age = await stat(lockPath).then(info => Date.now() - info.mtimeMs).catch(() => 0)
      if (age > staleMs) {
        await unlink(lockPath).catch(() => undefined)
        continue
      }
      if (Date.now() > deadline) {
        throw new Error(`vault lock ${lockPath} is still held after ${timeoutMs}ms`)
      }
      await sleep(pollMs)
    }
  }

  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, nonce, at: new Date().toISOString() }))
    await handle.sync().catch(() => undefined)
    await handle.close()
    handle = null
    return await fn()
  } finally {
    if (handle) await handle.close().catch(() => undefined)
    await unlink(lockPath).catch(() => undefined)
  }
}

type ReadJournal = { events: JournalEvent[]; watermark: number; tornTail: boolean }

async function readJournalFile(path: string): Promise<ReadJournal> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { events: [], watermark: 0, tornTail: false }
    throw error
  }
  if (raw === '') return { events: [], watermark: 0, tornTail: false }
  const tornTail = !raw.endsWith('\n')
  const lines = raw.split('\n')
  if (tornTail) lines.pop()
  const events: JournalEvent[] = []
  for (const line of lines) {
    if (line.trim() === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      // A malformed middle line is not something a writer may paper over; the
      // repair path (recovery) decides, never the append path.
      throw new Error(`journal ${path} has a corrupt line: ${(error as Error).message}`)
    }
    events.push(parsed as JournalEvent)
  }
  const watermark = events.reduce((max, event) => Math.max(max, Number(event.sequence) || 0), 0)
  return { events, watermark, tornTail }
}

export async function readJournal(vaultRoot: string, familyId: string): Promise<ReadJournal> {
  return readJournalFile(familyJournalPath(vaultRoot, familyId))
}

/**
 * The active generation for a family, read from the rotation journal. `null`
 * means no generation has been admitted yet, and nothing may be committed
 * until one is - a missing generation is not a default, it is a refusal.
 */
export async function activeGeneration(vaultRoot: string, familyId: string): Promise<string | null> {
  let raw: string
  try {
    raw = await readFile(familyRotationPath(vaultRoot, familyId), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  let active: string | null = null
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    let record: { kind?: string; generation_id?: string }
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (record.kind === 'admission' || record.kind === 'rotation') {
      if (typeof record.generation_id === 'string') active = record.generation_id
    }
  }
  return active
}

export async function admitGeneration(
  vaultRoot: string,
  familyId: string,
  record: Record<string, unknown> & { generation_id: string; kind: 'admission' | 'rotation' },
): Promise<void> {
  const dir = dirname(familyRotationPath(vaultRoot, familyId))
  await mkdir(dir, { recursive: true })
  await withVaultLock(dir, async () => {
    const path = familyRotationPath(vaultRoot, familyId)
    const line = `${JSON.stringify({ ...record, at: new Date().toISOString() })}\n`
    let needsNewline = false
    try {
      const existing = await readFile(path, 'utf8')
      needsNewline = existing.length > 0 && !existing.endsWith('\n')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const handle = await open(path, 'a')
    try {
      await handle.writeFile(`${needsNewline ? '\n' : ''}${line}`)
      await handle.sync()
    } finally {
      await handle.close()
    }
  })
}

/**
 * Commit proposals. Under the lock the writer: reads the journal, rejects
 * anything whose generation is not the active one or missing, skips ids it has
 * already committed, assigns the next sequences, hashes each body, appends the
 * lines, and fsyncs once before returning.
 */
export async function appendEvents(
  vaultRoot: string,
  familyId: string,
  proposals: readonly ProposedEvent[],
  options: { schemaVersion?: number } = {},
): Promise<AppendResult> {
  const dir = dirname(familyJournalPath(vaultRoot, familyId))
  await mkdir(dir, { recursive: true })
  return withVaultLock(dir, async () => {
    const active = await activeGeneration(vaultRoot, familyId)
    const journal = await readJournalFile(familyJournalPath(vaultRoot, familyId))
    if (journal.tornTail) {
      throw new Error('journal ends with a torn line; run recovery before appending')
    }
    const seen = new Set(journal.events.map(event => String(event.event_id)))
    const committed: JournalEvent[] = []
    const duplicates: string[] = []
    const rejected: AppendRejection[] = []
    let sequence = journal.watermark

    for (const proposal of proposals) {
      const eventId = typeof proposal.event_id === 'string' ? proposal.event_id : ''
      if (!eventId) {
        rejected.push({ event_id: '', reason: 'event_id is required' })
        continue
      }
      if (seen.has(eventId)) {
        duplicates.push(eventId)
        continue
      }
      const generation = proposal.generation_id
      if (typeof generation !== 'string' || generation.trim() === '') {
        // Absent is a refusal, never a default: a retired scribe with stale
        // fence logic must not be able to commit by omission.
        rejected.push({ event_id: eventId, reason: 'generation_id is required' })
        continue
      }
      if (active === null) {
        rejected.push({ event_id: eventId, reason: 'no active generation for this family' })
        continue
      }
      if (generation !== active) {
        rejected.push({ event_id: eventId, reason: `generation ${generation} is fenced; active is ${active}` })
        continue
      }
      sequence += 1
      const body: Record<string, unknown> = {
        ...proposal,
        schema_version: options.schemaVersion ?? 1,
        sequence,
      }
      const event = { ...body, content_hash: contentHash(body) } as JournalEvent
      committed.push(event)
      seen.add(eventId)
    }

    if (committed.length > 0) {
      const path = familyJournalPath(vaultRoot, familyId)
      const lines = committed.map(event => `${JSON.stringify(event)}\n`).join('')
      const handle = await open(path, 'a')
      try {
        await handle.writeFile(lines)
        await handle.sync()
      } finally {
        await handle.close()
      }
    }

    return { committed, duplicates, rejected, watermark: sequence }
  })
}
