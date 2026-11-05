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

/**
 * The writer's identity on every committed line. A constant rather than a pid:
 * it names the authority that validated the event, which is what the record
 * needs to prove the scribe did not author its own verdict. It can never equal
 * a `proposed_by` session id.
 */
export const WRITER_IDENTITY = 'writer:gateway-vault/1'

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

export type TornTailRepair =
  | { repaired: false; reason: 'clean' | 'missing' }
  | {
      repaired: true
      /** Byte offset where the dropped tail began (the end of the last complete line). */
      offset: number
      byteCount: number
      sha256: string
      quarantinedTo: string
      watermark: number
    }

/**
 * Cut a torn tail off the journal, preserving exactly what was cut.
 *
 * A crash can leave a partial final line; the complete lines before it are
 * still authoritative, so the repair truncates to the last newline. The dropped
 * bytes are written to a quarantine file first and described in
 * quarantine.jsonl, so nothing is discarded silently and the operation can be
 * audited later. Running it twice is a no-op - there is nothing left to cut.
 *
 * A corrupt line that is NOT at the tail is a different failure: the ordering
 * after it cannot be trusted, so this refuses and leaves the file untouched for
 * an explicit rebuild.
 */
export async function repairTornTail(vaultRoot: string, familyId: string): Promise<TornTailRepair> {
  const journalPath = familyJournalPath(vaultRoot, familyId)
  const dir = dirname(journalPath)
  return withVaultLock(dir, async () => {
    let buffer: Buffer
    try {
      buffer = await readFile(journalPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { repaired: false, reason: 'missing' } as const
      throw error
    }
    if (buffer.length === 0) return { repaired: false, reason: 'clean' } as const
    const lastNewline = buffer.lastIndexOf(0x0a)
    if (lastNewline === buffer.length - 1) return { repaired: false, reason: 'clean' } as const

    const offset = lastNewline + 1
    const dropped = buffer.subarray(offset)
    // Before cutting anything, prove nothing else in the file is broken: a
    // torn tail is the only damage this call is allowed to repair.
    const complete = buffer.subarray(0, offset).toString('utf8')
    for (const [index, line] of complete.split('\n').entries()) {
      if (line.trim() === '') continue
      try {
        JSON.parse(line)
      } catch (error) {
        throw new Error(
          `journal ${journalPath} has a corrupt line ${index + 1} that is not a torn tail; ` +
            `repair refuses and the file is untouched: ${(error as Error).message}`,
        )
      }
    }

    const hash = createHash('sha256').update(dropped).digest('hex')
    const quarantineDir = join(vaultRoot, 'quarantine', familyId)
    await mkdir(quarantineDir, { recursive: true })
    const quarantinedTo = join(quarantineDir, `tail-${Date.now()}-${dropped.length}-${hash.slice(0, 12)}.bin`)
    const bytes = await open(quarantinedTo, 'wx')
    try {
      await bytes.writeFile(dropped)
      await bytes.sync()
    } finally {
      await bytes.close()
    }
    const record = {
      kind: 'tail_recovered',
      family_id: familyId,
      at: new Date().toISOString(),
      offset,
      byteCount: dropped.length,
      sha256: hash,
      quarantinedTo,
    }
    const auditPath = join(vaultRoot, 'quarantine', 'quarantine.jsonl')
    const audit = await open(auditPath, 'a')
    try {
      await audit.writeFile(`${JSON.stringify(record)}\n`)
      await audit.sync()
    } finally {
      await audit.close()
    }

    const handle = await open(journalPath, 'r+')
    try {
      await handle.truncate(offset)
      await handle.sync()
    } finally {
      await handle.close()
    }

    const kept = complete.split('\n').filter(line => line.trim() !== '')
    const watermark = kept.reduce((max, line) => Math.max(max, Number(JSON.parse(line).sequence) || 0), 0)
    return { repaired: true, offset, byteCount: dropped.length, sha256: hash, quarantinedTo, watermark }
  })
}

export type JournalVerification =
  | { ok: true; checked: number; watermark: number }
  | {
      ok: false
      checked: number
      watermark: number
      mismatches: Array<{ line: number; event_id?: string; expected?: string; actual?: string; reason?: string }>
      tornTail: boolean
    }

/**
 * Re-hash every committed line and compare it to the hash it carries.
 *
 * The check parses the line and hashes the canonical form of the parsed object,
 * never the raw text: a line that was re-serialized with different spacing is
 * still the same event, and a line whose content changed is not.
 */
export async function verifyJournal(vaultRoot: string, familyId: string): Promise<JournalVerification> {
  const path = familyJournalPath(vaultRoot, familyId)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, checked: 0, watermark: 0 }
    throw error
  }
  const tornTail = raw.length > 0 && !raw.endsWith('\n')
  const lines = raw.split('\n')
  if (tornTail) lines.pop()
  const mismatches: Array<{ line: number; event_id?: string; expected?: string; actual?: string; reason?: string }> = []
  let checked = 0
  let watermark = 0
  lines.forEach((line, index) => {
    if (line.trim() === '') return
    let event: Record<string, unknown>
    try {
      event = JSON.parse(line)
    } catch (error) {
      mismatches.push({ line: index + 1, reason: `not JSON: ${(error as Error).message}` })
      return
    }
    checked += 1
    watermark = Math.max(watermark, Number(event.sequence) || 0)
    const stored = typeof event.content_hash === 'string' ? event.content_hash : undefined
    const actual = contentHash(event)
    if (stored !== actual) {
      mismatches.push({ line: index + 1, event_id: String(event.event_id ?? ''), expected: stored, actual })
    }
  })
  return mismatches.length === 0
    ? { ok: true, checked, watermark }
    : { ok: false, checked, watermark, mismatches, tornTail }
}

/** Events after a watermark, in committed order - the projection's replay input. */
export async function replayFrom(
  vaultRoot: string,
  familyId: string,
  after = 0,
): Promise<JournalEvent[]> {
  const journal = await readJournalFile(familyJournalPath(vaultRoot, familyId))
  if (journal.tornTail) {
    throw new Error('journal ends with a torn line; run repairTornTail before replaying')
  }
  return journal.events
    .filter(event => Number(event.sequence) > after)
    .sort((left, right) => Number(left.sequence) - Number(right.sequence))
}

/**
 * The active generation for a family, read from the rotation journal. `null`
 * means no generation has been admitted yet, and nothing may be committed
 * until one is - a missing generation is not a default, it is a refusal.
 */
export type AdmissionKind = 'admission' | 'rotation' | 'import_admission'

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
    // An import fence sets the active generation exactly like an admission, or
    // imported families could never commit; it is not an activation and never
    // counts toward rotation.
    if (
      record.kind === 'admission' ||
      record.kind === 'rotation' ||
      record.kind === 'import_admission'
    ) {
      if (typeof record.generation_id === 'string') active = record.generation_id
    }
  }
  return active
}

export type RotationRecord = Record<string, unknown> & { kind?: string; generation_id?: string }

/**
 * Decide and append one rotation record under the family's vault lock.
 *
 * The read and the append have to happen under the same lock: an admission's
 * ordinal is "how many admissions exist", and computing it outside the lock is
 * how two concurrent activations both receive the same ordinal and both count
 * as the first. `decide` returns the record to append, or null to write
 * nothing and leave the file untouched.
 */
type RotationDecision = Record<string, unknown> | readonly Record<string, unknown>[] | null

export async function appendRotationDecision(
  vaultRoot: string,
  familyId: string,
  // Awaited so a decision can do work that belongs in the same critical
  // section: an admission writes the obligation it owes here, and the row it
  // returns has to be able to name that obligation or the error that stopped
  // it. Synchronous decisions are unaffected.
  decide: (records: RotationRecord[]) => RotationDecision | Promise<RotationDecision>,
): Promise<{ appended: RotationRecord[] }> {
  const dir = dirname(familyRotationPath(vaultRoot, familyId))
  await mkdir(dir, { recursive: true })
  return withVaultLock(dir, async () => {
    const path = familyRotationPath(vaultRoot, familyId)
    const records = await readRotationRecords(vaultRoot, familyId)
    const decision = await decide(records)
    if (!decision) return { appended: [] }
    // A decision can be more than one row - the fifth admission and the rotation
    // intent it triggers have to land in the same critical section, or a crash
    // between them leaves a counted invocation with no intent.
    const at = new Date().toISOString()
    const written = (Array.isArray(decision) ? decision : [decision]).map(entry => ({
      ...entry,
      family_id: familyId,
      at,
    }))
    if (written.length === 0) return { appended: [] }
    const line = written.map(entry => `${JSON.stringify(entry)}\n`).join('')
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
    return { appended: written }
  })
}

/** Every rotation-journal record for a family, in file order. Malformed lines are skipped. */
export async function readRotationRecords(vaultRoot: string, familyId: string): Promise<RotationRecord[]> {
  let raw: string
  try {
    raw = await readFile(familyRotationPath(vaultRoot, familyId), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const records: RotationRecord[] = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try {
      records.push(JSON.parse(line) as RotationRecord)
    } catch {
      continue
    }
  }
  return records
}

export async function admitGeneration(
  vaultRoot: string,
  familyId: string,
  record: Record<string, unknown> & { generation_id: string; kind: AdmissionKind },
): Promise<void> {
  if (record.kind === 'import_admission') {
    // An unexplained state change is not auditable, and an invocation id would
    // let a rebuild advance the rotation counter.
    if (typeof record.reason !== 'string' || record.reason.trim() === '') {
      throw new Error('an import_admission must carry a reason')
    }
    if ('invocation_id' in record || 'invocationId' in record) {
      throw new Error('an import_admission must not carry an invocation id; it is not an activation')
    }
  }
  await appendRotationDecision(vaultRoot, familyId, () => record)
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
  return withVaultLock(dir, () => appendEventsLocked(vaultRoot, familyId, proposals, options))
}

/**
 * The commit body without the lock, for callers that already hold it. Taking
 * the lock twice in one process is a deadlock, not a re-entrant lock, so the
 * submit seam calls this rather than the exported wrapper.
 */
export async function appendEventsLocked(
  vaultRoot: string,
  familyId: string,
  proposals: readonly ProposedEvent[],
  options: { schemaVersion?: number } = {},
): Promise<AppendResult> {
  {
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
      if ('content_hash' in proposal) {
        // Only the writer computes a hash, and only after it assigns sequence.
        // A proposal carrying one is either confused or trying to fix its own
        // identity, so it is refused rather than trusted or overwritten.
        rejected.push({ event_id: eventId, reason: 'content_hash is writer-owned and must not be proposed' })
        continue
      }
      if ('status' in proposal) {
        // Validation is the writer's verdict, not the scribe's claim: an event
        // is 'validated' because the writer checked it, never because it said so.
        rejected.push({ event_id: eventId, reason: 'status is writer-owned and must not be proposed' })
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
        // Writer-owned fields come last so a proposal cannot claim a family, a
        // position, or its own validation.
        schema_version: options.schemaVersion ?? 1,
        family_id: familyId,
        sequence,
        status: 'validated',
        committed_by: WRITER_IDENTITY,
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
  }
}
