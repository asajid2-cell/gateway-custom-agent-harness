/**
 * Everything the host must remember between launches.
 *
 * There are two kinds of memory and they are deliberately separate files:
 *
 * - `peer.json` is the HOST: the instance slug, the loopback port, the Chrome
 *   profile, the page's idle policy, the rolling audit, and the host's own
 *   identity (`hostId`). None of it belongs to a thread, so none of it moves
 *   when a bridge is adopted or removed.
 * - `bridges/<sessionId>.json` is one BUS PEER: the address that peer answers
 *   on, the thread it is bound to, the primer it was primed with, what it owes,
 *   its timers, and the model/effort the page last reported. One bridged thread
 *   is one peer, so these files come and go independently.
 *
 * The bus registration itself still lives in the harness directory and is
 * rewritten on every start; these files are the host's own memory.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
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
/** A single token: the address another peer types. Never a display label. */
export const BRIDGE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * The pre-split file: one host, one thread, one peer.
 *
 * It is kept read-only for migration. Nothing writes this shape any more; a
 * file in it is turned into one bridge with the SAME session id, so the address
 * every other peer already knows never changes.
 */
export const peerStateSchema = z.object({
  sessionId: z.string().uuid(),
  /** Which signed-in browser instance this host owns. Defaults to `default`. */
  instanceId: z.string().regex(INSTANCE_ID_PATTERN),
  threadId: z.string().uuid().nullable(),
  /**
   * The thread the recorded primer sha actually belongs to. A thread selected
   * with `use` has no primer of ours in it, so the sha alone cannot say that
   * thread is primed - this pairing can.
   */
  primedThreadId: z.string().uuid().nullable().default(null),
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

/** Host-level memory. Ownership here is the process and the Chrome profile. */
export const hostStateSchema = z.object({
  /** Stable for the life of this state file; never a bus address. */
  hostId: z.string().uuid(),
  instanceId: z.string().regex(INSTANCE_ID_PATTERN),
  healthPort: z.number().int(),
  idleUnloadMinutes: z.number(),
  profile: z.string().max(4096),
  audit: z.array(auditEntrySchema).max(200),
}).strict()

export type HostState = z.infer<typeof hostStateSchema>

/** Per-bridge memory: one bridged thread, one bus peer. */
export const bridgeStateSchema = z.object({
  sessionId: z.string().uuid(),
  name: z.string().regex(BRIDGE_NAME_PATTERN),
  threadId: z.string().uuid().nullable(),
  primedThreadId: z.string().uuid().nullable(),
  primerSha256: z.string().max(64).nullable(),
  owed: z.array(owedEntrySchema).max(50),
  schedules: z.array(scheduleSchema).max(8),
  model: z.string().max(100).nullable(),
  effort: z.string().max(40).nullable(),
  createdAt: z.string(),
  title: z.string().max(200).optional(),
  /**
   * The page's node ids for the user messages this host posted. "Ours" is
   * decided by id, never by what a message says, so a person typing
   * "INBOUND from ..." is still a person.
   */
  ourNodeIds: z.array(z.string().max(64)).max(200).default([]),
  /** The last node of the thread the host has handled; null until first observed. */
  cursor: z.string().max(64).nullable().default(null),
  /** When the page last answered 404 for the bound thread; cleared when it answers again. */
  threadMissingAt: z.string().nullable().default(null),
  /**
   * When this bridge last relayed an uplink, newest last. The host refuses past
   * 20 an hour: the page is a signed-in account talking to the bus, and a loop
   * there would spend someone else's turns.
   */
  uplinkTimes: z.array(z.string().max(40)).max(50).default([]),
  /**
   * The page answer nodes this bridge has relayed or decided to relay, newest
   * last. Written BEFORE the send, so a crash mid-relay loses one message
   * rather than posting it twice; a node found here after a restart is never
   * sent again.
   */
  uplinkNodeIds: z.array(z.string().max(64)).max(200).default([]),
}).strict()

export type BridgeState = z.infer<typeof bridgeStateSchema>

const RETIRED_BRIDGE_KEYS = ['bootstrapSha256', 'bootstrapBurnedAt', 'lastArmedSha256'] as const

export function newState(options: { profile: string; healthPort: number; idleUnloadMinutes: number; instanceId?: string }): PeerState {
  return {
    sessionId: randomUUID(),
    instanceId: options.instanceId ?? 'default',
    threadId: null,
    primedThreadId: null,
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

export function newHostState(options: { profile: string; healthPort: number; idleUnloadMinutes: number; instanceId?: string }): HostState {
  return {
    hostId: randomUUID(),
    instanceId: options.instanceId ?? 'default',
    healthPort: options.healthPort,
    idleUnloadMinutes: options.idleUnloadMinutes,
    profile: options.profile,
    audit: [],
  }
}

export function newBridgeState(options: {
  sessionId: string
  name: string
  threadId?: string | null
  title?: string
  model?: string | null
  effort?: string | null
  createdAt?: string
}): BridgeState {
  return {
    sessionId: options.sessionId,
    name: options.name,
    threadId: options.threadId ?? null,
    primedThreadId: null,
    primerSha256: null,
    owed: [],
    schedules: [],
    model: options.model ?? null,
    effort: options.effort ?? null,
    createdAt: options.createdAt ?? new Date().toISOString(),
    ...(options.title ? { title: options.title } : {}),
    ourNodeIds: [],
    cursor: null,
    threadMissingAt: null,
    uplinkTimes: [],
    uplinkNodeIds: [],
  }
}

/** The legacy single-bridge file as exactly one bridge, keeping its address. */
export function bridgeFromLegacy(legacy: PeerState, name: string, createdAt = new Date().toISOString()): BridgeState {
  return {
    sessionId: legacy.sessionId,
    name,
    threadId: legacy.threadId,
    primedThreadId: legacy.primedThreadId,
    primerSha256: legacy.primerSha256,
    owed: legacy.owed,
    schedules: legacy.schedules,
    model: legacy.model,
    effort: legacy.effort,
    createdAt,
    ourNodeIds: [],
    cursor: null,
    threadMissingAt: null,
    uplinkTimes: [],
    uplinkNodeIds: [],
  }
}

/**
 * Read the host file, or start from defaults when it is absent.
 *
 * A file in the pre-split shape is recognised and returned alongside the host
 * state (`legacy`), so the caller can turn it into one bridge before the host
 * file is rewritten. A file this build cannot read is reported rather than
 * silently replaced: it holds the host id and the profile binding.
 */
export async function loadHostState(
  path: string,
  defaults: () => HostState,
): Promise<{ state: HostState; legacy?: PeerState; fresh: boolean }> {
  let raw: string
  try { raw = await readFile(path, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: defaults(), fresh: true }
    throw error
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) }
  catch (error) { throw new Error(`peer.json is invalid JSON at ${path}: ${(error as Error).message}`) }
  const host = hostStateSchema.safeParse(parsed)
  if (host.success) return { state: host.data, fresh: false }
  const legacy = peerStateSchema.safeParse(parsed)
  if (legacy.success) {
    return {
      state: {
        hostId: randomUUID(),
        instanceId: legacy.data.instanceId,
        healthPort: legacy.data.healthPort,
        idleUnloadMinutes: legacy.data.idleUnloadMinutes,
        profile: legacy.data.profile,
        audit: legacy.data.audit,
      },
      legacy: legacy.data,
      fresh: false,
    }
  }
  const [first] = host.error.issues
  throw new Error(`peer.json is invalid at ${first?.path.join('.') ?? 'root'}: ${first?.message ?? 'unknown'}`)
}

/** Read one bridge file. A file this build cannot read is reported, not skipped. */
export async function loadBridgeState(path: string): Promise<BridgeState> {
  const raw = await readFile(path, 'utf8')
  let parsed: unknown
  try { parsed = JSON.parse(raw) }
  catch (error) { throw new Error(`bridge state is invalid JSON at ${path}: ${(error as Error).message}`) }
  // The operator page's join token and arm memory (builds up to 9dd33dc).
  // They meant nothing without the page; a file that still carries them loads.
  if (parsed && typeof parsed === 'object') for (const key of RETIRED_BRIDGE_KEYS) delete (parsed as Record<string, unknown>)[key]
  const result = bridgeStateSchema.safeParse(parsed)
  if (!result.success) {
    const [first] = result.error.issues
    throw new Error(`bridge state is invalid at ${path} (${first?.path.join('.') ?? 'root'}): ${first?.message ?? 'unknown'}`)
  }
  return result.data
}

/** Every bridge file in the directory, oldest name first. */
export async function listBridgeStates(directory: string): Promise<{ path: string; state: BridgeState }[]> {
  let entries: string[]
  try { entries = await readdir(directory) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const states: { path: string; state: BridgeState }[] = []
  for (const entry of entries.filter(name => name.endsWith('.json')).sort()) {
    const path = join(directory, entry)
    const state = await loadBridgeState(path)
    // The name is the address; a file named for a different session would be
    // loaded under an id nothing can reach, so it is a refusal.
    if (`${state.sessionId}.json` !== entry) throw new Error(`bridge state ${path} names session ${state.sessionId}; the file must be named for it`)
    states.push({ path, state })
  }
  return states
}

/**
 * Saves are serialized per path and serialized eagerly.
 *
 * Two overlapping saves each write their own temporary and rename it; whichever
 * rename lands last wins, so an older snapshot can overwrite a newer one (a
 * cancelled schedule's timer reappears after a restart). Serializing the JSON
 * at call time and queueing the writes makes the last call the last word.
 */
const saving = new Map<string, Promise<void>>()

export function saveJson(path: string, value: unknown): Promise<void> {
  const payload = JSON.stringify(value, null, 2)
  const previous = saving.get(path) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(async () => {
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${randomUUID()}.tmp`
    await writeFile(temporary, payload, 'utf8')
    await rename(temporary, path)
  })
  saving.set(path, next)
  next.catch(() => {}).finally(() => { if (saving.get(path) === next) saving.delete(path) })
  return next
}

/** Kept for the legacy state tests; the host and bridges both use saveJson. */
export function saveState(path: string, state: PeerState): Promise<void> {
  return saveJson(path, state)
}

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

/** Append one audit line, keeping the rolling cap. */
export function audit(state: { audit: z.infer<typeof auditEntrySchema>[] }, entry: { op: string; target?: string | null; result: string; messageId?: string | null }): void {
  state.audit = [...state.audit, {
    at: new Date().toISOString(),
    op: entry.op.slice(0, 40),
    target: entry.target === undefined || entry.target === null ? null : String(entry.target).slice(0, 200),
    result: entry.result.slice(0, 300),
    messageId: entry.messageId === undefined || entry.messageId === null ? null : String(entry.messageId).slice(0, 64),
  }].slice(-200)
}
