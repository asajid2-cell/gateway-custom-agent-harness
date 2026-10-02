import { randomBytes } from 'node:crypto'
import { appendFile, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

export type SessionCompactionCounts = {
  compactBoundaryCount: number
  microcompactBoundaryCount: number
}

export type CompactionBoundary = {
  uuid: string
  kind: 'full' | 'micro'
}

type Checkpoint = {
  version: 1
  sessionId: string
  known: boolean
  compactBoundaryCount?: number
  microcompactBoundaryCount?: number
  offset: number
  seenBoundaryUuids: string[]
  pending: CompactionBoundary[]
}

const listeners = new Set<(sessionId: string, counts: SessionCompactionCounts) => void>()
const writes = new Map<string, Promise<unknown>>()

function checkpointPath(transcriptPath: string): string {
  return `${transcriptPath}.compactions.json`
}

function serial<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = writes.get(path) ?? Promise.resolve()
  const next = previous.then(operation, operation)
  writes.set(path, next.catch(() => {}))
  return next
}

async function transcriptSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
}

async function readCheckpoint(path: string, sessionId: string): Promise<Checkpoint | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const value = raw as Record<string, unknown>
    if (
      value.version !== 1 || value.sessionId !== sessionId ||
      typeof value.known !== 'boolean' || !Number.isSafeInteger(value.offset) ||
      (value.offset as number) < 0 || !Array.isArray(value.seenBoundaryUuids) ||
      !value.seenBoundaryUuids.every(uuid => typeof uuid === 'string') ||
      !Array.isArray(value.pending) || !value.pending.every(item =>
        !!item && typeof item === 'object' && typeof item.uuid === 'string' &&
        (item.kind === 'full' || item.kind === 'micro'),
      ) ||
      (value.known && (
        !Number.isSafeInteger(value.compactBoundaryCount) ||
        (value.compactBoundaryCount as number) < 0 ||
        !Number.isSafeInteger(value.microcompactBoundaryCount) ||
        (value.microcompactBoundaryCount as number) < 0
      ))
    ) return null
    return value as unknown as Checkpoint
  } catch {
    return null
  }
}

async function writeCheckpoint(path: string, checkpoint: Checkpoint): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tempPath = `${path}.${process.pid}.${Date.now()}.${randomBytes(8).toString('hex')}.tmp`
  try {
    const handle = await open(tempPath, 'wx', 0o600)
    try {
      await handle.writeFile(JSON.stringify(checkpoint))
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tempPath, path)
  } catch (error) {
    await unlink(tempPath).catch(() => {})
    throw error
  }
}

function countsOf(checkpoint: Checkpoint): SessionCompactionCounts | undefined {
  if (!checkpoint.known) return undefined
  return {
    compactBoundaryCount: checkpoint.compactBoundaryCount!,
    microcompactBoundaryCount: checkpoint.microcompactBoundaryCount!,
  }
}

function publish(sessionId: string, checkpoint: Checkpoint): void {
  const counts = countsOf(checkpoint)
  if (!counts) return
  for (const listener of listeners) listener(sessionId, counts)
}

async function recoverPending(transcriptPath: string, checkpoint: Checkpoint): Promise<Checkpoint> {
  if (!checkpoint.pending.length) return checkpoint

  const pending = new Map(checkpoint.pending.map((boundary, index) => [boundary.uuid, { ...boundary, index }]))
  const observed = new Map<string, { boundary: CompactionBoundary; endOffset: number }>()
  const size = await transcriptSize(transcriptPath)
  if (size > checkpoint.offset) {
    const { createReadStream } = await import('node:fs')
    const stream = createReadStream(transcriptPath, { start: checkpoint.offset })
    let carry = Buffer.alloc(0)
    let cursor = checkpoint.offset
    for await (const chunk of stream) {
      carry = Buffer.concat([carry, chunk as Buffer])
      let newline = carry.indexOf(0x0a)
      while (newline >= 0) {
        const line = carry.subarray(0, newline).toString('utf8')
        cursor += newline + 1
        carry = carry.subarray(newline + 1)
        if (line.includes('"uuid"')) {
          try {
            const entry = JSON.parse(line) as { type?: unknown; subtype?: unknown; uuid?: unknown }
            if (entry.type === 'system' && typeof entry.uuid === 'string') {
              const expected = pending.get(entry.uuid)
              const kind = entry.subtype === 'compact_boundary' ? 'full' : entry.subtype === 'microcompact_boundary' ? 'micro' : undefined
              if (expected && expected.kind === kind && !observed.has(entry.uuid)) {
                observed.set(entry.uuid, { boundary: expected, endOffset: cursor })
              }
            }
          } catch { /* Ignore malformed transcript rows. */ }
        }
        newline = carry.indexOf(0x0a)
      }
      if (observed.size === pending.size) break
    }
  }

  let committedCount = 0
  let offset = checkpoint.offset
  for (const boundary of checkpoint.pending) {
    const found = observed.get(boundary.uuid)
    if (!found) break
    offset = found.endOffset
    committedCount++
  }
  if (!committedCount) return checkpoint

  const committed = checkpoint.pending.slice(0, committedCount)
  const next: Checkpoint = {
    ...checkpoint,
    offset,
    pending: checkpoint.pending.slice(committedCount),
    seenBoundaryUuids: [...checkpoint.seenBoundaryUuids, ...committed.map(boundary => boundary.uuid)],
  }
  for (const boundary of committed) {
    if (boundary.kind === 'full') next.compactBoundaryCount!++
    else next.microcompactBoundaryCount!++
  }
  await writeCheckpoint(checkpointPath(transcriptPath), next)
  return next
}

function persistenceDisabled(): boolean {
  return process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY === '1' ||
    process.env.CLAUDE_CODE_DISABLE_SESSION_PERSISTENCE === '1' ||
    (process.env.NODE_ENV === 'test' && process.env.TEST_ENABLE_SESSION_PERSISTENCE !== '1') ||
    Number(process.env.CLAUDE_CODE_CLEANUP_PERIOD_DAYS) === 0
}

export async function markSessionCompactionCountsUnknown(sessionId: string, transcriptPath: string): Promise<void> {
  await serial(checkpointPath(transcriptPath), async () => {
    const size = await transcriptSize(transcriptPath)
    await writeCheckpoint(checkpointPath(transcriptPath), {
      version: 1,
      sessionId,
      known: false,
      offset: size,
      seenBoundaryUuids: [],
      pending: [],
    })
  })
}

export async function loadSessionCompactionCounts(sessionId: string, transcriptPath: string): Promise<SessionCompactionCounts | undefined> {
  if (persistenceDisabled()) return undefined

  return serial(checkpointPath(transcriptPath), async () => {
    const path = checkpointPath(transcriptPath)
    const size = await transcriptSize(transcriptPath)
    let checkpoint = await readCheckpoint(path, sessionId)
    if (!checkpoint) {
      if (size > 0) return undefined
      checkpoint = {
        version: 1,
        sessionId,
        known: true,
        compactBoundaryCount: 0,
        microcompactBoundaryCount: 0,
        offset: 0,
        seenBoundaryUuids: [],
        pending: [],
      }
      await writeCheckpoint(path, checkpoint)
      return countsOf(checkpoint)
    }
    if (!checkpoint.known) return undefined
    if (checkpoint.pending.length) checkpoint = await recoverPending(transcriptPath, checkpoint)
    return countsOf(checkpoint)
  })
}

export async function prepareSessionCompactionBoundaries(
  sessionId: string,
  transcriptPath: string,
  boundaries: readonly CompactionBoundary[],
): Promise<void> {
  if (!boundaries.length || persistenceDisabled()) return
  await serial(checkpointPath(transcriptPath), async () => {
    const path = checkpointPath(transcriptPath)
    let checkpoint = await readCheckpoint(path, sessionId)
    if (!checkpoint) {
      const size = await transcriptSize(transcriptPath)
      checkpoint = {
        version: 1,
        sessionId,
        known: size === 0,
        ...(size === 0 ? { compactBoundaryCount: 0, microcompactBoundaryCount: 0 } : {}),
        offset: size,
        seenBoundaryUuids: [],
        pending: [],
      }
    }
    if (!checkpoint.known) {
      await writeCheckpoint(path, checkpoint)
      return
    }
    const seen = new Set(checkpoint.seenBoundaryUuids)
    const pending = new Set(checkpoint.pending.map(boundary => boundary.uuid))
    const newBoundaries = boundaries.filter(boundary => !seen.has(boundary.uuid) && !pending.has(boundary.uuid))
    if (!newBoundaries.length) return
    checkpoint.pending = [...checkpoint.pending, ...newBoundaries]
    await writeCheckpoint(path, checkpoint)
  })
}

export async function commitSessionCompactionBoundary(
  sessionId: string,
  transcriptPath: string,
  uuid: string,
): Promise<void> {
  if (persistenceDisabled()) return
  await serial(checkpointPath(transcriptPath), async () => {
    const path = checkpointPath(transcriptPath)
    const checkpoint = await readCheckpoint(path, sessionId)
    if (!checkpoint?.known || !checkpoint.pending.some(boundary => boundary.uuid === uuid)) return
    const next = await recoverPending(transcriptPath, checkpoint)
    if (next === checkpoint) return
    await publish(sessionId, next)
  })
}

export function subscribeSessionCompactionCounts(listener: (sessionId: string, counts: SessionCompactionCounts) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export async function appendCompactionBoundaryForTesting(
  sessionId: string,
  transcriptPath: string,
  boundary: CompactionBoundary,
): Promise<void> {
  await prepareSessionCompactionBoundaries(sessionId, transcriptPath, [boundary])
  await mkdir(dirname(transcriptPath), { recursive: true, mode: 0o700 })
  const subtype = boundary.kind === 'full' ? 'compact_boundary' : 'microcompact_boundary'
  await appendFile(transcriptPath, `${JSON.stringify({ type: 'system', subtype, uuid: boundary.uuid })}\n`, { mode: 0o600 })
  await commitSessionCompactionBoundary(sessionId, transcriptPath, boundary.uuid)
}
