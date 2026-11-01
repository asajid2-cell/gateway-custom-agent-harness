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
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
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

/**
 * The longest send text a pending record can hold. Longer text cannot be
 * matched by equality, so it is not recorded at all (the host logs that);
 * the snapshot path still has it.
 */
export const PENDING_ATTRIBUTION_TEXT_MAX = 65536

/**
 * A send the page had not shown us yet when we looked for it.
 *
 * The snapshot path - the node ids before a send versus after it - is exact,
 * but it depends on the page's own conversation read being up to date. When
 * that read lags, our user node is missing from both snapshots, so it is never
 * recorded as ours and later reads back as a person typing (which asks the page
 * to run our own prompt). This record is written BEFORE the page is called, so
 * it survives a failed snapshot AND a host that dies mid-send: the next
 * observation that sees a user node with this exact text, created within the
 * window, adopts it as ours.
 */
export const pendingAttributionSchema = z.object({
  /** Exactly what we sent; the match is by text. */
  text: z.string().max(PENDING_ATTRIBUTION_TEXT_MAX),
  /** When the page was asked, ISO. The match window and the expiry are from here. */
  sentAt: z.string(),
  /** The thread we sent into, for the audit line. Null for a brand-new chat. */
  threadId: z.string().uuid().nullable(),
}).strict()

export type PendingAttribution = z.infer<typeof pendingAttributionSchema>

/** How many unresolved sends one bridge may hold; a send is rare, so this is slack. */
export const PENDING_ATTRIBUTION_MAX = 16

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

/**
 * One file the host delivered to the bus, by node and index.
 *
 * The pair is the identity: the page may re-state the same node's parts on
 * every read, and a node's index order never changes, so `(nodeId, index)` is
 * what makes a file at-most-once. It is written BEFORE the bus send.
 *
 * `bytes` is the size we actually recorded. A `null` is UNKNOWN, never zero: a
 * state file written before this field was recorded carries no size, and a
 * node whose prior total is unknown must be treated as already at the cap
 * rather than as empty (N3a).
 */
export const deliveredFileSchema = z.object({ nodeId: z.string().max(64), index: z.number().int().min(0), bytes: z.number().int().min(0).nullable().default(null) }).strict()

export type DeliveredFile = z.infer<typeof deliveredFileSchema>

/**
 * The per-file detail is a rolling window. It bounds the audit trail, never
 * the at-most-once set or the per-node byte total: those live in
 * `deliveredNodes`, which outlives this window (N3b).
 */
export const DELIVERED_FILES_MAX = 200

/**
 * One node's durable delivery ledger.
 *
 * `bytes` is the total ever delivered from the node; `null` means at least one
 * delivery recorded no size, so the total cannot be proven. `indexes` is the
 * delivered set needed for at-most-once, kept apart from the 200-entry
 * `deliveredFiles` window so revisiting an evicted node still dedups and still
 * counts against the cumulative cap.
 *
 * The node list is NOT evicted by count (R7-F7). A count bound silently
 * forgets the oldest delivery after enough newer nodes, and re-requesting that
 * node then produces a second sibling file - the at-most-once promise cannot be
 * a rolling window. Nothing prunes it: a delivered node can be requested for as
 * long as the thread exists. The per-node index list stays capped because the
 * per-request file cap is 5.
 */
export const DELIVERED_NODE_INDEXES_MAX = 256

export const deliveredNodeSchema = z.object({
  nodeId: z.string().max(64),
  bytes: z.number().int().min(0).nullable().default(null),
  indexes: z.array(z.number().int().min(0)).max(DELIVERED_NODE_INDEXES_MAX).default([]),
}).strict()

export type DeliveredNode = z.infer<typeof deliveredNodeSchema>

/**
 * A durable receipt for one model command, written BEFORE the side effect.
 *
 * Keyed by `${messageId}:${sha256(commandWithoutNonce)}` so a replay on a
 * fresh process-local handled set is a no-op: the key is already present and
 * the dispatch is skipped.
 */
export const commandReceiptSchema = z.object({
  key: z.string().max(200),
  line: z.string().max(500),
  replied: z.boolean().default(false),
  repliedTo: z.string().max(80).optional(),
}).strict()

export const COMMAND_RECEIPTS_MAX = 200

/**
 * One inbound's execution transcript, written BEFORE its first side effect.
 *
 * A per-command receipt is keyed on the command's own text, and a page that
 * regenerates a turn can word the same command differently - a new key, a
 * second dispatch, a doubled side effect (R1-F9). The run marker is keyed on
 * the INBOUND alone, so once a turn from that inbound has executed anything,
 * a replay of the inbound executes nothing.
 */
export const inboundRunSchema = z.object({
  messageId: z.string().max(80),
  /** The result lines of the commands this turn already ran, oldest first. */
  results: z.array(z.string().max(500)).max(20).default([]),
  at: z.string().max(40),
}).strict()

/**
 * The per-inbound run marker is retained by TURN LIFETIME, not by count
 * (R7-F8): a count bound evicted the marker of an inbound that was still owed
 * after 200 newer inbounds, and a replay of it - whose command the page may
 * have worded differently - then dispatched a second time. Pruning is by age
 * and never touches an outstanding inbound; see `pruneInboundRuns`.
 */

/**
 * An inbound turn the host has posted but not yet answered (D5b).
 *
 * The turn is a JOB: the record is written BEFORE the send, and the answer is
 * delivered from the synchronous `wait:true` reply when the page finishes
 * inside the send's own wait. Only a send that outlives its wait (the page is
 * still generating) leaves the turn owed, to the turn's own loop while this
 * process lives or to the observation pass after a restart. It is never
 * dropped without a delivery or a failure line.
 */
export const pendingTurnSchema = z.object({
  /** Null only for a brand-new chat: the page has not named a thread yet. */
  threadId: z.string().uuid().nullable().default(null),
  /** Our own user node, once the page has shown it. Null until then. */
  userNodeId: z.string().max(64).nullable().default(null),
  /**
   * The exact text we posted, capped; the fallback match after a restart. The
   * cap is a MATCHER: a longer text cannot be matched by equality, so only the
   * full `text` below is authoritative for what was (or still must be) posted.
   */
  ourText: z.string().max(4096),
  /** The body itself, exactly as it must be posted. */
  text: z.string().max(65536).default(''),
  senderSessionId: z.string().uuid(),
  messageId: z.string().max(64),
  kind: z.enum(['inquiry', 'directive']),
  /**
   * When the page was asked, ISO - null while the job is DEFERRED. A deferred
   * job was never typed (the page was mid-turn, and ChatGPT steers text typed
   * then into the running turn), so it is posted on the next idle transition.
   */
  postedAt: z.string().nullable().default(null),
  /**
   * R8-A: the bridge cursor AT POST TIME - the last node this host had handled
   * when it typed. The positional matcher needs a boundary that the live cursor
   * cannot move: the cursor advances as the page is walked, and a record whose
   * node has no `create_time` is otherwise lost behind it. Null/absent only for
   * records written before this field existed, which fall back to the cursor.
   */
  anchorNodeId: z.string().max(64).nullable().optional(),
  /**
   * The turn's command nonce, as minted when this inbound began. Every answer to
   * this turn - direct, deferred (the page was mid-turn), or recovered after a
   * restart - must be parsed against the SAME nonce, so a deferred or recovered
   * answer runs its commands exactly like a direct one. Absent only on records
   * written before this field existed; such a turn refuses a command block by
   * name (nonce mismatch) rather than swallowing it.
   */
  turnNonce: z.string().max(64).optional(),
  /**
   * When a post attempt first failed for a reason that is NOT "the page is
   * mid-turn" (ISO). A mid-turn deferral is transient and will post at the next
   * idle transition, so it never sets this; a definite failure - a signed-out
   * tab, a refused send with no composer - does. The observation pass tells the
   * sender once this is older than the pending-watch ladder.
   */
  queuedSince: z.string().max(40).optional(),
  /** The last definite not-posted reason, for the one notice the sender gets. */
  queuedReason: z.string().max(200).optional(),
  /**
   * When the sender was told this turn stays queued (ISO). Written BEFORE the
   * notice is sent, so a restart never sends it again: one bounded notice per
   * turn, not per pass.
   */
  queuedNoticeAt: z.string().max(40).optional(),
}).strict()

export const PENDING_TURNS_MAX = 8
export const PENDING_TURN_TTL_MS = 6 * 3600_000
export const ANSWERED_TURNS_MAX = 200

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
  /**
   * Sends whose own user node we have not seen yet, oldest first. Written
   * before each send and resolved by text on the next observation; see
   * `pendingAttributionSchema`.
   */
  pendingAttribution: z.array(pendingAttributionSchema).max(PENDING_ATTRIBUTION_MAX).default([]),
  /** The last node of the thread the host has handled; null until first observed. */
  cursor: z.string().max(64).nullable().default(null),
  /**
   * When this bridge was bound to its current thread, until the first
   * observation commits a cursor.
   *
   * The first observation must tell history from what a person typed AFTER the
   * bind. Kept in bridge state, not in memory, so a restart between the bind
   * and that first read cannot swallow the person's turn as history (R1-F10).
   * Cleared as soon as the initial cursor is committed.
   */
  boundAt: z.string().max(40).nullable().default(null),
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
  /**
   * Files already delivered to the bus, by node and index. Written BEFORE the
   * send (same discipline as `uplinkNodeIds`): a duplicate spends no quota and
   * a restart does not post the same file twice.
   */
  deliveredFiles: z.array(deliveredFileSchema).max(DELIVERED_FILES_MAX).default([]),
  /**
   * The durable per-node delivery ledger. It survives the `deliveredFiles`
   * window and is what dedup and the cumulative byte cap are decided from.
   */
  // R7-F7: no count bound - see DELIVERED_NODE_INDEXES_MAX's comment.
  deliveredNodes: z.array(deliveredNodeSchema).default([]),
  /** Inbound turns posted but not yet answered; see `pendingTurnSchema`. */
  pendingTurns: z.array(pendingTurnSchema).max(PENDING_TURNS_MAX).default([]),
  /** Turn keys already answered, written BEFORE the reply goes out. */
  answeredTurns: z.array(z.string().max(80)).max(ANSWERED_TURNS_MAX).default([]),
  /**
   * Durable receipts for model commands, written BEFORE their side effects.
   *
   * A replay on a fresh process-local handled set finds the key here and skips
   * the dispatch, making every model command at-most-once across host restarts.
   */
  commandReceipts: z.array(commandReceiptSchema).max(COMMAND_RECEIPTS_MAX).default([]),
  /**
   * Inbounds that already executed a model command, newest last. Written before
   * the first side effect; a replay of that inbound after a restart runs none.
   */
  // R7-F8: no count bound - retention is by turn lifetime (see above).
  inboundRuns: z.array(inboundRunSchema).default([]),
  /**
   * How many "your turn stays queued" notices this bridge has sent. Durable and
   * exposed in the host status so the silence is measurable.
   */
  queuedNotices: z.number().int().min(0).default(0),
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
    pendingAttribution: [],
    cursor: null,
    boundAt: null,
    threadMissingAt: null,
    uplinkTimes: [],
    uplinkNodeIds: [],
    deliveredFiles: [],
    deliveredNodes: [],
    pendingTurns: [],
    answeredTurns: [],
    commandReceipts: [],
    inboundRuns: [],
    queuedNotices: 0,
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
    pendingAttribution: [],
    cursor: null,
    boundAt: null,
    threadMissingAt: null,
    uplinkTimes: [],
    uplinkNodeIds: [],
    deliveredFiles: [],
    deliveredNodes: [],
    pendingTurns: [],
    answeredTurns: [],
    commandReceipts: [],
    inboundRuns: [],
    queuedNotices: 0,
  }
}

/**
 * Fold the rolling per-file window into the durable per-node ledger.
 *
 * A bridge file written before the ledger existed has only `deliveredFiles`;
 * a file written by this build has both, consistently. For each file record
 * whose `(nodeId, index)` the ledger does not already hold, add it - and its
 * bytes, or `null` when the record carries no size. An entry the ledger
 * already holds is not counted twice.
 */
function foldDeliveredLedger(state: BridgeState): BridgeState {
  if (state.deliveredFiles.length === 0) return state
  const ledger = new Map(state.deliveredNodes.map(node => [node.nodeId, { nodeId: node.nodeId, bytes: node.bytes, indexes: [...node.indexes] }]))
  for (const entry of state.deliveredFiles) {
    const node = ledger.get(entry.nodeId)
    if (!node) {
      ledger.set(entry.nodeId, { nodeId: entry.nodeId, bytes: entry.bytes, indexes: [entry.index] })
      continue
    }
    if (node.indexes.includes(entry.index)) continue
    node.indexes.push(entry.index)
    node.bytes = node.bytes === null || entry.bytes === null ? null : node.bytes + entry.bytes
  }
  // R7-F7: the ledger is permanent - folding the rolling detail in must never
  // evict the oldest node, or at-most-once becomes a window again.
  state.deliveredNodes = [...ledger.values()]
  return state
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
  return foldDeliveredLedger(result.data)
}

/**
 * Every readable bridge file in the directory, oldest name first.
 *
 * One bad file must not stop the others: a truncated write, a future schema, or
 * a file named for a session it does not contain is quarantined (reported and
 * skipped) so every healthy bridge still registers and only the affected
 * identity is refused. `onQuarantine` receives each rejected path; by default
 * the reason goes to stderr, because the host loads every bridge through here
 * at startup and a silent skip would hide the broken file.
 */
export async function listBridgeStates(
  directory: string,
  onQuarantine?: (problem: { path: string; error: Error }) => void,
): Promise<{ path: string; state: BridgeState }[]> {
  let entries: string[]
  try { entries = await readdir(directory) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const states: { path: string; state: BridgeState }[] = []
  for (const entry of entries.filter(name => name.endsWith('.json')).sort()) {
    const path = join(directory, entry)
    try {
      const state = await loadBridgeState(path)
      // The name is the address; a file named for a different session would be
      // loaded under an id nothing can reach, so it is a refusal.
      if (`${state.sessionId}.json` !== entry) throw new Error(`bridge state ${path} names session ${state.sessionId}; the file must be named for it`)
      states.push({ path, state })
    } catch (error) {
      const problem = { path, error: error instanceof Error ? error : new Error(String(error)) }
      if (onQuarantine) onQuarantine(problem)
      else console.error(`bridge state quarantined: ${problem.path}: ${problem.error.message}`)
    }
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

/**
 * Delays between rename attempts when Windows refuses the replace.
 *
 * A read handle on the target - any process, Node or Bun, a plain `open(path,
 * 'r')` is enough - blocks the replace and surfaces as EPERM; a rename that
 * races another rename surfaces as EBUSY. Both are transient holds that last a
 * few milliseconds, so a save retries instead of being lost. Those are the
 * only two codes retried: a real permission problem or a missing directory
 * must fail on the first attempt. One initial attempt plus one per entry, so
 * the whole budget is ~375 ms.
 */
const RENAME_BACKOFF_MS = [25, 100, 250]
const RETRYABLE_RENAME = new Set(['EPERM', 'EBUSY'])

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try { await rename(from, to); return }
    catch (error) {
      const wait = RENAME_BACKOFF_MS[attempt]
      if (wait === undefined || !RETRYABLE_RENAME.has(String((error as NodeJS.ErrnoException).code ?? ''))) throw error
      await new Promise(resolve => setTimeout(resolve, wait))
    }
  }
}

export function saveJson(path: string, value: unknown): Promise<void> {
  const payload = JSON.stringify(value, null, 2)
  const previous = saving.get(path) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(async () => {
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${randomUUID()}.tmp`
    await writeFile(temporary, payload, 'utf8')
    let renamed = false
    try { await renameWithRetry(temporary, path); renamed = true }
    finally {
      // A successful rename consumed the temporary. A failed one must not
      // leave it behind: with a reader that never closes, every save would
      // otherwise add one more file to the directory.
      if (!renamed) await rm(temporary, { force: true }).catch(() => {})
    }
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
