/**
 * Everything the host must remember between launches, in one file.
 *
 * The bus registration lives in the harness directory and is rewritten on every
 * start; this file is the host's own memory - which thread is current, what the
 * page was set to, which timers are pending, what it owed and what it did.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod/v4'

export const auditEntrySchema = z.object({
  at: z.string(),
  op: z.string().max(40),
  target: z.string().max(200).nullable(),
  result: z.string().max(300),
  messageId: z.string().max(64).nullable(),
}).strict()

export const owedEntrySchema = z.object({
  messageId: z.string().max(64),
  from: z.string().max(64),
  kind: z.enum(['inquiry', 'directive']),
  expectReply: z.boolean(),
  receivedAt: z.string(),
}).strict()

export const scheduleSchema = z.object({ label: z.string().max(80), at: z.string() }).strict()

/** A slug, not a sentence: it names one browser instance on disk. */
export const INSTANCE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

export const peerStateSchema = z.object({
  sessionId: z.string().uuid(),
  /** Which signed-in browser instance this host owns. Defaults to `default`. */
  instanceId: z.string().regex(INSTANCE_ID_PATTERN),
  threadId: z.string().uuid().nullable(),
  model: z.string().max(100).nullable(),
  effort: z.string().max(40).nullable(),
  profile: z.string().max(4096),
  primerSha256: z.string().max(64).nullable(),
  idleUnloadMinutes: z.number(),
  healthPort: z.number().int(),
  schedules: z.array(scheduleSchema).max(8),
  owed: z.array(owedEntrySchema).max(50),
  audit: z.array(auditEntrySchema).max(200),
}).strict()

export type PeerState = z.infer<typeof peerStateSchema>

export function newState(options: { profile: string; healthPort: number; idleUnloadMinutes: number; instanceId?: string }): PeerState {
  return {
    sessionId: randomUUID(),
    instanceId: options.instanceId ?? 'default',
    threadId: null,
    model: null,
    effort: null,
    profile: options.profile,
    primerSha256: null,
    idleUnloadMinutes: options.idleUnloadMinutes,
    healthPort: options.healthPort,
    schedules: [],
    owed: [],
    audit: [],
  }
}

/**
 * Read the file, or start from defaults when it is absent.
 *
 * A file this build cannot read is reported rather than silently replaced: it
 * holds the session id, and minting a new one would silently change the address
 * every peer already has.
 */
export async function loadState(path: string, defaults: () => PeerState): Promise<PeerState> {
  let raw: string
  try { raw = await readFile(path, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaults()
    throw error
  }
  const parsed = peerStateSchema.safeParse(JSON.parse(raw))
  if (!parsed.success) {
    const [first] = parsed.error.issues
    throw new Error(`peer.json is invalid at ${first?.path.join('.') ?? 'root'}: ${first?.message ?? 'unknown'}`)
  }
  return parsed.data
}

export async function saveState(path: string, state: PeerState): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(state, null, 2), 'utf8')
  await rename(temporary, path)
}

/** Append one audit line, keeping the rolling cap. */
export function audit(state: PeerState, entry: { op: string; target?: string | null; result: string; messageId?: string | null }): void {
  state.audit = [...state.audit, {
    at: new Date().toISOString(),
    op: entry.op.slice(0, 40),
    target: entry.target === undefined || entry.target === null ? null : String(entry.target).slice(0, 200),
    result: entry.result.slice(0, 300),
    messageId: entry.messageId === undefined || entry.messageId === null ? null : String(entry.messageId).slice(0, 64),
  }].slice(-200)
}
