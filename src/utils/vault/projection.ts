import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { readJournal, type JournalEvent } from './journal.js'

/**
 * The journal is the truth; this is a cache of it.
 *
 * Everything here can be deleted and rebuilt, which is the only property that
 * makes it safe to have at all. Each family records the sequence it has applied,
 * so a restart resumes rather than re-reading, and a rebuild is the same code
 * path from zero - there is no second writer and no divergent state.
 */

export function projectionPath(vaultRoot: string): string {
  return join(vaultRoot, 'db', 'gateway.db')
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  family_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  kind TEXT,
  topic_id TEXT,
  status TEXT,
  authority TEXT,
  class TEXT,
  recorded_at TEXT,
  summary TEXT,
  body TEXT,
  content_hash TEXT NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (family_id, sequence)
);
CREATE INDEX IF NOT EXISTS events_by_event_id ON events (event_id);
CREATE INDEX IF NOT EXISTS events_by_topic ON events (family_id, topic_id);
`

export type Projection = { db: Database; path: string }

export async function openProjection(vaultRoot: string): Promise<Projection> {
  const path = projectionPath(vaultRoot)
  await mkdir(dirname(path), { recursive: true })
  const db = new Database(path, { create: true })
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(SCHEMA)
  return { db, path }
}

export function closeProjection(projection: Projection): void {
  projection.db.close()
}

function metaKey(familyId: string): string {
  return `last_applied_sequence:${familyId}`
}

export function lastApplied(projection: Projection, familyId: string): number {
  const row = projection.db.query('SELECT value FROM meta WHERE key = ?').get(metaKey(familyId)) as
    | { value: string }
    | null
  return row ? Number(row.value) || 0 : 0
}

function field(event: Record<string, unknown>, name: string): string | null {
  const value = event[name]
  return typeof value === 'string' ? value : value === undefined || value === null ? null : String(value)
}

function insertEvent(projection: Projection, familyId: string, event: JournalEvent): void {
  const record = event as unknown as Record<string, unknown>
  projection.db
    .query(
      `INSERT OR REPLACE INTO events
        (family_id, sequence, event_id, kind, topic_id, status, authority, class, recorded_at, summary, body, content_hash, json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      familyId,
      Number(event.sequence),
      String(event.event_id),
      field(record, 'kind'),
      field(record, 'topic_id'),
      field(record, 'status'),
      field(record, 'authority'),
      field(record, 'class'),
      field(record, 'recorded_at'),
      field(record, 'summary'),
      field(record, 'body'),
      String(event.content_hash ?? ''),
      JSON.stringify(event),
    )
}

/**
 * Apply what the journal has and the projection does not. Returns how far it
 * moved and how far behind the journal it was when it started - the lag number
 * the acceptance test bounds rather than pretending it is zero.
 */
export async function applyFamily(
  projection: Projection,
  vaultRoot: string,
  familyId: string,
): Promise<{ applied: number; from: number; watermark: number; journalWatermark: number }> {
  const journal = await readJournal(vaultRoot, familyId)
  if (journal.tornTail) {
    throw new Error(`journal for ${familyId} ends with a torn line; repair it before projecting`)
  }
  const from = lastApplied(projection, familyId)
  const pending = journal.events.filter(event => Number(event.sequence) > from)
  if (pending.length > 0) {
    projection.db.exec('BEGIN')
    try {
      for (const event of pending) insertEvent(projection, familyId, event)
      projection.db
        .query('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
        .run(metaKey(familyId), String(journal.watermark))
      projection.db.exec('COMMIT')
    } catch (error) {
      projection.db.exec('ROLLBACK')
      throw error
    }
  }
  return { applied: pending.length, from, watermark: lastApplied(projection, familyId), journalWatermark: journal.watermark }
}

export async function listedFamilies(vaultRoot: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises')
  try {
    const entries = await readdir(join(vaultRoot, 'families'), { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export async function applyAll(
  projection: Projection,
  vaultRoot: string,
): Promise<Array<{ familyId: string; applied: number; lag: number }>> {
  const results = []
  for (const familyId of await listedFamilies(vaultRoot)) {
    const result = await applyFamily(projection, vaultRoot, familyId)
    results.push({ familyId, applied: result.applied, lag: result.journalWatermark - result.from })
  }
  return results
}

/** Drop everything and re-apply from zero. The only way a projection "repairs". */
export async function rebuild(projection: Projection, vaultRoot: string): Promise<void> {
  projection.db.exec('DELETE FROM events')
  projection.db.exec('DELETE FROM meta')
  await applyAll(projection, vaultRoot)
}

/**
 * A digest of the projected rows in journal order. Two projections built by
 * different paths - incremental and from zero - are equivalent exactly when
 * this matches, which is what the parity test compares.
 */
export function projectionDigest(projection: Projection): string {
  const rows = projection.db
    .query('SELECT family_id, sequence, event_id, content_hash FROM events ORDER BY family_id, sequence')
    .all()
  return `sha256:${createHash('sha256').update(JSON.stringify(rows)).digest('hex')}`
}

export async function parity(vaultRoot: string, scratchDir: string): Promise<{
  equal: boolean
  incremental: string
  rebuilt: string
  incrementalRows: number
  rebuiltRows: number
}> {
  const incremental = await openProjection(vaultRoot)
  await applyAll(incremental, vaultRoot)
  const incrementalDigest = projectionDigest(incremental)
  const incrementalRows = (incremental.db.query('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n
  closeProjection(incremental)

  const scratch = await openProjection(scratchDir)
  await rebuild(scratch, vaultRoot)
  const rebuiltDigest = projectionDigest(scratch)
  const rebuiltRows = (scratch.db.query('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n
  closeProjection(scratch)

  return {
    equal: incrementalDigest === rebuiltDigest && incrementalRows === rebuiltRows,
    incremental: incrementalDigest,
    rebuilt: rebuiltDigest,
    incrementalRows,
    rebuiltRows,
  }
}
