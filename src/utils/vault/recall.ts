import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import {
  applyFamily,
  closeProjection,
  openProjection,
  type Projection,
} from './projection.js'

/**
 * Recall returns evidence, not prose, and it orders that evidence with a fixed
 * tuple so two runs - and two implementations - cannot disagree. There is no
 * recency term: a durable decision outranks yesterday's speculation.
 */

export type RecallFilters = {
  /** ISO instant the answer is asked at. Expired observations fall out of `current`. */
  asOf?: string
  kinds?: string[]
  scope?: string
  limit?: number
}

export type RecallItem = {
  event_id: string
  sequence: number
  kind: string | null
  status: string | null
  class: string | null
  authority: string | null
  scope: string | null
  topic_id: string | null
  summary: string | null
  recorded_at: string | null
  relations: unknown[]
  citations: string[]
  /** On a history item: the events that supersede it, so a gate need not guess. */
  superseded_by?: string[]
}

export type ObligationRow = {
  obligation_id: string
  kind?: string
  state: string
  created_at?: string
  age_hours?: number
  source_message_id?: string
}

export type RecallPacket = {
  query: string
  family_id: string
  as_of: string
  current: RecallItem[]
  /** Term matches that do not answer the question. They are not answers. */
  candidates: RecallItem[]
  history: RecallItem[]
  nothing_recorded: boolean
  obligations: { pending: ObligationRow[]; overdue: ObligationRow[] }
  notes: string[]
}

const AUTHORITY_RANK: Record<string, number> = {
  user_ruling: 4,
  verified_artifact: 3,
  agent_inference: 2,
  unverified: 1,
}

const SCOPE_RANK: Record<string, number> = { task: 4, driver: 3, family: 2, global: 1 }

/**
 * A word that carries no answer by itself. Removing these is what lets
 * "what is the p99 relay latency" be judged on p99/relay/latency rather than on
 * the question's grammar.
 */
const STOPWORDS = new Set([
  'a', 'about', 'all', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'before', 'by', 'can',
  'could', 'did', 'do', 'does', 'for', 'from', 'get', 'go', 'going', 'got', 'had', 'has', 'have', 'how',
  'i', 'if', 'in', 'into', 'is', 'it', 'its', 'know', 'made', 'make', 'me', 'my', 'need', 'no', 'not',
  'of', 'on', 'or', 'our', 'put', 'said', 'say', 'should', 'so', 'take', 'taken', 'that', 'the',
  'their', 'them', 'then', 'there', 'these', 'they', 'this', 'to', 'was', 'we', 'were', 'what', 'when',
  'where', 'which', 'who', 'why', 'will', 'with', 'would', 'you', 'your',
])

export function significantTerms(query: string): string[] {
  const raw =
    query
      .toLowerCase()
      .replace(/[\u2019']s\b/g, '')
      .match(/[a-z0-9][a-z0-9_.:/-]*/g) ?? []
  return [...new Set(raw.filter(term => term.length >= 2 && !STOPWORDS.has(term)))]
}

function coversTerm(text: string, term: string): boolean {
  if (text.includes(term)) return true
  // Plural tolerance without a stemmer: compare on a stripped trailing s.
  const stem = term.replace(/s$/, '')
  return stem.length >= 3 && text.includes(stem)
}

type Row = {
  sequence: number
  event_id: string
  json: string
}

function asRecord(row: Row): Record<string, unknown> {
  try {
    return JSON.parse(row.json) as Record<string, unknown>
  } catch {
    return {}
  }
}

function text(record: Record<string, unknown>, name: string): string | null {
  const value = record[name]
  return typeof value === 'string' ? value : null
}

/**
 * FTS5 treats several characters as syntax. Every term is quoted and its own
 * quotes doubled, so a query can never inject into the expression.
 */
export function ftsExpression(query: string): string {
  // Significant terms only: "the" OR "is" OR "what" makes the result set
  // near-global and lets BM25 rank on the question's grammar. Coverage is the
  // gate that separates answers from candidates; the expression only has to
  // build a sane candidate set.
  const terms = significantTerms(query)
  if (terms.length === 0) return ''
  return terms.map(term => `"${term.replace(/"/g, '""')}"`).join(' OR ')
}

function identifiersIn(query: string): string[] {
  return [
    ...new Set(
      (query.match(/[A-Za-z0-9][A-Za-z0-9_.:/-]{4,}/g) ?? []).filter(token => /[0-9._:/-]/.test(token)),
    ),
  ]
}

function supersession(
  records: Array<{ event_id: string; record: Record<string, unknown> }>,
): { superseded: Set<string>; supersededBy: Map<string, string[]> } {
  const superseded = new Set<string>()
  const supersededBy = new Map<string, string[]>()
  for (const { event_id, record } of records) {
    const relations = Array.isArray(record.relations) ? record.relations : []
    for (const relation of relations) {
      if (!relation || typeof relation !== 'object') continue
      const entry = relation as { type?: unknown; target_event_id?: unknown }
      if (entry.type === 'supersedes' && typeof entry.target_event_id === 'string') {
        superseded.add(entry.target_event_id)
        const list = supersededBy.get(entry.target_event_id) ?? []
        list.push(String(record.event_id ?? event_id))
        supersededBy.set(entry.target_event_id, list)
      }
    }
    if (record.status === 'superseded') superseded.add(String(record.event_id ?? event_id))
  }
  return { superseded, supersededBy }
}

function citationsFor(familyId: string, record: Record<string, unknown>): string[] {
  const citations = [`journal:${familyId}#${String(record.sequence ?? '')}`]
  const evidence = Array.isArray(record.evidence) ? record.evidence : []
  for (const entry of evidence) {
    if (!entry || typeof entry !== 'object') continue
    const span = entry as { path?: unknown; revision?: unknown; message_id?: unknown; span_sha256?: unknown }
    const where = typeof span.path === 'string' ? span.path : typeof span.message_id === 'string' ? `msg:${span.message_id}` : null
    if (where) citations.push(span.span_sha256 ? `${where}@${String(span.span_sha256)}` : where)
  }
  return citations
}

function toItem(familyId: string, row: Row, itemClass: string | null): RecallItem {
  const record = asRecord(row)
  return {
    event_id: String(record.event_id ?? row.event_id),
    sequence: Number(record.sequence ?? row.sequence),
    kind: text(record, 'kind'),
    status: text(record, 'status'),
    class:
      itemClass ??
      text(record, 'class') ??
      (record.live && typeof record.live === 'object' ? 'live' : null),
    authority: text(record, 'authority'),
    scope: text(record, 'scope'),
    topic_id: text(record, 'topic_id'),
    summary: text(record, 'summary'),
    recorded_at: text(record, 'recorded_at'),
    relations: Array.isArray(record.relations) ? (record.relations as unknown[]) : [],
    citations: citationsFor(familyId, record),
  }
}

function expired(record: Record<string, unknown>, asOf: number): boolean {
  // Expiry lives in the live block, which is where the schema puts it for every
  // observation; a top-level expires_at is not part of the envelope.
  const live = record.live && typeof record.live === 'object' ? (record.live as Record<string, unknown>) : null
  const expires = live ? text(live, 'expires_at') : null
  if (!expires) return false
  const at = Date.parse(expires)
  return Number.isFinite(at) && at <= asOf
}

function validAt(record: Record<string, unknown>, asOf: number): boolean {
  const from = text(record, 'valid_from')
  if (from) {
    const at = Date.parse(from)
    if (Number.isFinite(at) && at > asOf) return false
  }
  const until = text(record, 'valid_until')
  if (until) {
    const at = Date.parse(until)
    if (Number.isFinite(at) && at <= asOf) return false
  }
  return true
}

function aliasMap(db: Database, familyId: string): { map: Map<string, string>; blobs: Map<string, string> } {
  const map = new Map<string, string>()
  const blobs = new Map<string, string>()
  const rows = db
    .query("SELECT json FROM events WHERE family_id = ? AND kind = 'topic' ORDER BY sequence")
    .all(familyId) as Array<{ json: string }>
  const addBlob = (topicId: string, part: string | null) => {
    if (!part) return
    blobs.set(topicId, `${blobs.get(topicId) ?? ''} ${part.toLowerCase()}`)
  }
  for (const row of rows) {
    const record = JSON.parse(row.json) as Record<string, unknown>
    const op = text(record, 'topic_op')
    const topicId = text(record, 'topic_id') ?? text(record, 'event_id')
    if (!topicId) continue
    if (op === 'create') {
      addBlob(topicId, text(record, 'definition'))
      addBlob(topicId, topicId)
      map.set(topicId.toLowerCase(), topicId)
    }
    if (op === 'alias' && Array.isArray(record.aliases)) {
      for (const alias of record.aliases) {
        if (typeof alias === 'string') {
          map.set(alias.toLowerCase(), topicId)
          addBlob(topicId, alias)
        }
      }
    }
    if (op === 'merge') {
      const into = text(record, 'merged_into')
      if (into) map.set(topicId.toLowerCase(), into)
    }
  }
  return { map, blobs }
}

async function obligationsFor(
  vaultRoot: string,
  familyId: string,
  asOf: number,
): Promise<{ pending: ObligationRow[]; overdue: ObligationRow[] }> {
  let raw = ''
  try {
    raw = await readFile(join(vaultRoot, 'families', familyId, 'obligations.jsonl'), 'utf8')
  } catch {
    return { pending: [], overdue: [] }
  }
  const state = new Map<string, ObligationRow>()
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    let record: Record<string, unknown>
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    const id = text(record, 'obligation_id')
    if (!id) continue
    const current = state.get(id)
    const nextState = text(record, 'state')
    if (!current || nextState === 'satisfied' || nextState === 'exempt' || nextState === 'failed') {
      state.set(id, {
        obligation_id: id,
        kind: text(record, 'kind') ?? current?.kind,
        state: nextState ?? current?.state ?? 'pending',
        created_at: text(record, 'created_at') ?? current?.created_at,
        source_message_id: text(record, 'source_message_id') ?? current?.source_message_id,
      })
    }
  }
  const pending: ObligationRow[] = []
  const overdue: ObligationRow[] = []
  for (const row of state.values()) {
    if (row.state !== 'pending') continue
    const created = row.created_at ? Date.parse(row.created_at) : NaN
    const ageHours = Number.isFinite(created) ? (asOf - created) / 3_600_000 : undefined
    const enriched = { ...row, ...(ageHours === undefined ? {} : { age_hours: Number(ageHours.toFixed(2)) }) }
    pending.push(enriched)
    if (ageHours !== undefined && ageHours > 24) overdue.push(enriched)
  }
  return { pending, overdue }
}

export type RecallRequest = {
  vaultRoot: string
  familyId: string
  query: string
  filters?: RecallFilters
}

export async function recall(request: RecallRequest): Promise<RecallPacket> {
  const { vaultRoot, familyId, query } = request
  const filters = request.filters ?? {}
  const asOfIso = filters.asOf ?? new Date().toISOString()
  const asOfMs = Date.parse(asOfIso)
  const asOf = Number.isFinite(asOfMs) ? asOfMs : Date.now()

  const projection: Projection = await openProjection(vaultRoot)
  try {
    await applyFamily(projection, vaultRoot, familyId)
    const expression = ftsExpression(query)
    const identifiers = identifiersIn(query)
    const { map: aliases, blobs: topicBlobs } = aliasMap(projection.db, familyId)
    const queryTopics = new Set<string>()
    const lowered = query.toLowerCase()
    for (const term of lowered.match(/[a-z0-9_.:/-]+/g) ?? []) {
      const mapped = aliases.get(term)
      if (mapped) queryTopics.add(mapped)
    }
    // A multi-word alias has to be looked up as a phrase, not a token.
    for (const [alias, topicId] of aliases) {
      if (alias.length >= 4 && lowered.includes(alias)) queryTopics.add(topicId)
    }
    const terms = significantTerms(query)

    let rows: Array<Row & { rank?: number }> = []
    if (expression) {
      rows = projection.db
        .query(
          `SELECT e.sequence, e.event_id, e.json, bm25(events_fts) AS rank
             FROM events_fts JOIN events e
               ON e.event_id = events_fts.event_id AND e.family_id = events_fts.family_id
            WHERE events_fts MATCH ? AND e.family_id = ?
            ORDER BY rank ASC, e.sequence ASC
            LIMIT 200`,
        )
        .all(expression, familyId) as Array<Row & { rank?: number }>
    } else {
      rows = projection.db
        .query('SELECT sequence, event_id, json FROM events WHERE family_id = ? ORDER BY sequence ASC LIMIT 200')
        .all(familyId) as Row[]
    }

    // The canonical topic layer is searched before history: a query that names
    // a topic pulls its decisions even when none of them repeats the words.
    if (queryTopics.size > 0) {
      const placeholders = [...queryTopics].map(() => '?').join(',')
      const members = projection.db
        .query(
          `SELECT sequence, event_id, json FROM events
            WHERE family_id = ? AND topic_id IN (${placeholders})
            ORDER BY sequence ASC LIMIT 200`,
        )
        .all(familyId, ...queryTopics) as Row[]
      const seen = new Set(rows.map(row => row.event_id))
      for (const member of members) if (!seen.has(member.event_id)) rows.push(member)
    }

    const all = rows.map(row => ({ row, record: asRecord(row) }))
    // Supersession is a property of the family, not of the result set: a target
    // whose superseder does not match the query must still be known to be
    // superseded, or it is served as current state.
    const relationRows = projection.db
      .query(
        "SELECT event_id, json FROM events WHERE family_id = ? AND json LIKE '%supersedes%'",
      )
      .all(familyId) as Array<{ event_id: string; json: string }>
    const { superseded, supersededBy } = supersession(
      relationRows.map(row => ({ event_id: row.event_id, record: JSON.parse(row.json) as Record<string, unknown> })),
    )

    const scored = all
      .filter(entry => {
        if (!validAt(entry.record, asOf)) return false
        if (filters.kinds && filters.kinds.length > 0) {
          if (!filters.kinds.includes(String(entry.record.kind ?? ''))) return false
        }
        if (filters.scope && String(entry.record.scope ?? '') !== filters.scope) return false
        // Topic events exist to maintain the taxonomy, not to answer questions.
        if (entry.record.kind === 'topic') return false
        return true
      })
      .map(entry => {
        const record = entry.record
        const summary = String(record.summary ?? '')
        const body = String(record.body ?? '')
        const topicId = String(record.topic_id ?? '')
        const textBlob = `${summary}\n${body}`.toLowerCase()
        const identifierHit = identifiers.some(identifier => textBlob.includes(identifier.toLowerCase()))
        // An answer must be *about* the question, not merely share a word with
        // it. Coverage of every significant term, an exact identifier, or a
        // named topic whose definition carries the terms - anything less is a
        // candidate and never appears in current[].
        const coveredByText = terms.length > 0 && terms.every(term => coversTerm(textBlob, term))
        const coveredByTopic =
          terms.length > 0 &&
          queryTopics.has(topicId) &&
          terms.every(term => coversTerm(topicBlobs.get(topicId) ?? '', term))
        const answers = identifierHit || coveredByText || coveredByTopic
        return {
          entry,
          answers,
          score: [
            queryTopics.has(topicId) ? 1 : 0,
            identifierHit ? 1 : 0,
            AUTHORITY_RANK[String(record.authority ?? '')] ?? 0,
            record.status === 'validated' && record.kind === 'decision' ? 1 : 0,
            SCOPE_RANK[String(record.scope ?? '')] ?? 0,
            -(entry.row.rank ?? 0),
            -Number(record.sequence ?? entry.row.sequence),
          ],
        }
      })

    const compare = (a: (typeof scored)[number], b: (typeof scored)[number]): number => {
      for (let index = 0; index < a.score.length; index += 1) {
        const delta = (b.score[index] ?? 0) - (a.score[index] ?? 0)
        if (delta !== 0) return delta
      }
      return String(a.entry.row.event_id).localeCompare(String(b.entry.row.event_id))
    }
    scored.sort(compare)

    const limit = filters.limit && filters.limit > 0 ? filters.limit : 10
    const current: RecallItem[] = []
    const candidates: RecallItem[] = []
    const history: RecallItem[] = []
    for (const entry of scored) {
      const record = entry.entry.record
      const isSuperseded = superseded.has(String(record.event_id ?? entry.entry.row.event_id))
      const isExpired = expired(record, asOf)
      // The answer test comes first: an event that does not answer the question
      // is a candidate, never history. Otherwise a weak term match that happens
      // to be superseded enters history and makes an unanswerable question look
      // like it has an answer.
      if (!entry.answers) {
        if (candidates.length < limit) candidates.push(toItem(familyId, entry.entry.row, null))
        continue
      }
      if (isSuperseded) {
        const item = toItem(familyId, entry.entry.row, null)
        const by = supersededBy.get(item.event_id)
        if (by && by.length > 0) item.superseded_by = [...new Set(by)]
        history.push(item)
        continue
      }
      if (isExpired) {
        history.push(toItem(familyId, entry.entry.row, 'expired'))
        continue
      }
      if (current.length >= limit) continue
      current.push(toItem(familyId, entry.entry.row, null))
    }

    // A supersession packet is closed over the relation, not over term
    // coverage: follow `supersedes` from the events that answered and put those
    // targets in history with a back-link. Only an answering event's own
    // relations can pull something in, so this does not reopen the leak where a
    // weak term match filled history.
    const inHistory = new Set(history.map(item => item.event_id))
    const targets: string[] = []
    for (const item of current) {
      for (const relation of item.relations) {
        if (!relation || typeof relation !== 'object') continue
        const entry = relation as { type?: unknown; target_event_id?: unknown }
        if (entry.type === 'supersedes' && typeof entry.target_event_id === 'string') {
          if (!inHistory.has(entry.target_event_id)) targets.push(entry.target_event_id)
        }
      }
    }
    for (const targetId of [...new Set(targets)]) {
      const row = projection.db
        .query('SELECT sequence, event_id, json FROM events WHERE family_id = ? AND event_id = ?')
        .get(familyId, targetId) as Row | null
      if (!row) continue
      const record = asRecord(row)
      if (!validAt(record, asOf)) continue
      const item = toItem(familyId, row, expired(record, asOf) ? 'expired' : null)
      item.superseded_by = [...new Set([...(item.superseded_by ?? []), ...(supersededBy.get(targetId) ?? [])])]
      history.push(item)
      inHistory.add(targetId)
    }

    const obligations = await obligationsFor(vaultRoot, familyId, asOf)
    return {
      query,
      family_id: familyId,
      as_of: new Date(asOf).toISOString(),
      current,
      candidates,
      history,
      nothing_recorded: current.length === 0 && history.length === 0,
      obligations,
      notes: [],
    }
  } finally {
    closeProjection(projection)
  }
}
