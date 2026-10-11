/**
 * The family head's ledger: the durable record a head keeps of its own family.
 *
 * What a head needs to remember is not the family's membership - the family file
 * already holds that, strictly, and every member reads it - but the head's own
 * account of the work: what it decided, what it handed to whom, and which
 * correspondences it is still waiting on. That account used to live as a
 * hand-written Markdown document, which meant the record a human read and the
 * record a session could query were the same bytes and neither could be folded,
 * diffed or regenerated. Here the source is structured - append-only JSONL under
 * `leaf-families/ledger/<familyId>/` - and the Markdown is a RENDERED view of it,
 * so the human-facing document is derived rather than authored.
 *
 * It is deliberately a projection, not a second authority. Two things a family
 * already answers are never restated here as if this file owned them: who is in
 * the family (the family file), and who is live and who owns what (the zenith
 * ledger). Both are READ and folded into the rendered view; neither is copied
 * into an event. A ledger that disagreed with those files would be a second
 * source of truth, which is exactly the stale-ledger failure the zenith ledger
 * was built to close.
 *
 * The home is a pure function of the family id, mirroring `checkpoints/<family>/`
 * for the same reason: a separate collection keeps the family file schema - and
 * every older reader of it - unchanged, and the path is derivable without
 * consulting anything, so any member can open the same ledger.
 *
 * Writes are gated on the HEAD designation, which is distinct from the matriarch
 * lease a member holds to run a turn: the head is the member the family
 * designated to act for it, and the head may not even be the session holding the
 * terminal. Reads are ungated - a ledger only the writer can read is a private
 * note, not a ledger.
 */
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { getSessionId } from '../bootstrap/state.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { lock } from './lockfile.js'

/** Where one family's ledger lives: a pure function of the family id. */
export function headLedgerDir(familyId: string): string {
  return join(getClaudeConfigHomeDir(), 'leaf-families', 'ledger', familyId)
}

function eventsPath(familyId: string): string {
  return join(headLedgerDir(familyId), 'ledger.jsonl')
}

/** The rendered human view: written from the JSONL, never read back as source. */
export function headLedgerViewPath(familyId: string): string {
  return join(headLedgerDir(familyId), 'ledger.md')
}

/** Fields every event carries: the format, when, and the session that wrote it. */
const common = {
  version: z.literal(1),
  at: z.string().datetime(),
  by: z.string().uuid(),
}

/**
 * One thing the head recorded, or one thing the watcher observed.
 *
 * The kinds are the head's view of its family, not the family's view of itself:
 * a deliberate note, a settled decision, work handed to a member, a watcher set
 * or cleared, and a watcher firing. A watch event records the STATE OF A WATCH
 * (on/off); a watch-fired event records that a watched condition was met, so the
 * fire survives the process that noticed it and is readable later.
 */
export const headLedgerEventSchema = z.discriminatedUnion('kind', [
  z.object({ ...common, kind: z.literal('note'), text: z.string().min(1).max(4000) }).strict(),
  z.object({ ...common, kind: z.literal('decision'), text: z.string().min(1).max(4000) }).strict(),
  z.object({ ...common, kind: z.literal('handoff'), to: z.string().uuid(), text: z.string().min(1).max(4000) }).strict(),
  z.object({ ...common, kind: z.literal('watch'), to: z.string().uuid(), mode: z.enum(['idle', 'new']), on: z.boolean() }).strict(),
  z.object({ ...common, kind: z.literal('watch-fired'), to: z.string().uuid(), mode: z.enum(['idle', 'new']), detail: z.string().max(2000).optional() }).strict(),
])

export type HeadLedgerEvent = z.infer<typeof headLedgerEventSchema>
export type HeadLedgerKind = HeadLedgerEvent['kind']
export type WatchMode = 'idle' | 'new'

/**
 * Read the ledger's events, in the order they were written.
 *
 * A line that does not parse is dropped rather than failing the read: a torn
 * last line is the expected shape of a crash mid-append, and refusing the whole
 * file over one line would let a single interrupted write destroy a record that
 * is otherwise intact. Parsing is per-line for the same reason the zenith ledger
 * parses per-line.
 */
export async function readHeadLedgerEvents(familyId: string): Promise<HeadLedgerEvent[]> {
  let raw: string
  try {
    raw = await readFile(eventsPath(familyId), 'utf8')
  } catch {
    return []
  }
  const events: HeadLedgerEvent[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = headLedgerEventSchema.safeParse(JSON.parse(trimmed))
      if (parsed.success) events.push(parsed.data)
    } catch {
      // A torn or corrupt line is skipped; the rest of the history stands.
    }
  }
  return events
}

/**
 * Append one event and re-render the Markdown view.
 *
 * Append-only is what makes the file a history rather than a snapshot: the fold
 * over the events is the current state, so a lost view costs a re-render and
 * never data. The append is serialized with the repo's own lock because several
 * members of one family share a config home and `O_APPEND` atomicity is not
 * something to lean on across processes on Windows. The view is rewritten after
 * the append, from the same events, so it never drifts from the source.
 */
export async function appendHeadLedgerEvent(
  familyId: string,
  event: Omit<HeadLedgerEvent, 'version' | 'at' | 'by'> & Partial<Pick<HeadLedgerEvent, 'at' | 'by'>>,
): Promise<HeadLedgerEvent> {
  const record = headLedgerEventSchema.parse({
    version: 1,
    at: event.at ?? new Date().toISOString(),
    by: event.by ?? getSessionId(),
    ...event,
  })
  const directory = headLedgerDir(familyId)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const release = await lock(eventsPath(familyId), { realpath: false, stale: 30000, retries: 5 })
  try {
    const handle = await open(eventsPath(familyId), 'a')
    try {
      await handle.write(JSON.stringify(record) + '\n')
    } finally {
      await handle.close()
    }
  } finally {
    await release()
  }
  await writeHeadLedgerView(familyId)
  return record
}

/** The watchers that are currently on, as a fold over the watch events. */
export function currentWatches(events: readonly HeadLedgerEvent[]): { to: string; mode: WatchMode }[] {
  const state = new Map<string, { to: string; mode: WatchMode; on: boolean }>()
  for (const event of events) {
    if (event.kind !== 'watch') continue
    state.set(`${event.to}:${event.mode}`, { to: event.to, mode: event.mode, on: event.on })
  }
  return [...state.values()].filter(entry => entry.on).map(({ to, mode }) => ({ to, mode }))
}

/**
 * Which watched members just went idle: the flip the head is notified about.
 *
 * Pure so the notification rule can be tested apart from the subscription that
 * feeds it. A member counts as flipped when its previous state was anything but
 * idle and its current state is idle - a member that was already idle is not a
 * second notification, and a member that came up and went straight to running
 * never crossed the line.
 */
export function idleFlips(
  previous: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, string>,
  watched: readonly string[],
): string[] {
  const flipped: string[] = []
  for (const id of watched) {
    if (previous.get(id) !== 'idle' && current.get(id) === 'idle') flipped.push(id)
  }
  return flipped
}

/** Which members are new since last seen: the leaves a new-session watch confirms. */
export function newMembers(previous: ReadonlySet<string>, current: ReadonlySet<string>): string[] {
  return [...current].filter(id => !previous.has(id))
}

/**
 * Regenerate the Markdown view from the events.
 *
 * The document is the rendered view of the source, so it is written and never
 * read back as authority. It carries the head's own record first and the derived
 * projections last, so a reader can tell at a glance which lines are the head's
 * words and which the family and the zenith ledger already know.
 */
export async function writeHeadLedgerView(familyId: string): Promise<void> {
  const events = await readHeadLedgerEvents(familyId)
  const directory = headLedgerDir(familyId)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const markdown = renderHeadLedger(familyId, events)
  const temporary = `${headLedgerViewPath(familyId)}.${process.pid}.tmp`
  await writeFile(temporary, markdown)
  await rename(temporary, headLedgerViewPath(familyId))
}

/** The rendered view as a string, folded from the events. */
export function renderHeadLedger(familyId: string, events: readonly HeadLedgerEvent[]): string {
  const lines: string[] = [`# Head ledger - family ${familyId}`, '']
  if (events.length === 0) {
    lines.push('_No entries yet._', '')
  } else {
    lines.push('## Record', '')
    for (const event of events) {
      if (event.kind === 'watch' || event.kind === 'watch-fired') continue
      const who = event.kind === 'handoff' ? ` -> ${event.to}` : ''
      lines.push(`- ${event.at} [${event.kind}${who}] ${event.text}`)
    }
    lines.push('')
  }
  const watches = currentWatches(events)
  lines.push('## Watchers', '')
  lines.push(watches.length ? watches.map(watch => `- ${watch.mode}: ${watch.to}`).join('\n') : '_None set._')
  lines.push('')
  const fires = events.filter((event): event is Extract<HeadLedgerEvent, { kind: 'watch-fired' }> => event.kind === 'watch-fired')
  if (fires.length) {
    lines.push('## Fired', '')
    lines.push(fires.map(fire => `- ${fire.at} [${fire.mode}] ${fire.to}${fire.detail ? ` - ${fire.detail}` : ''}`).join('\n'))
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * Where a fired watcher is delivered, when the head is running.
 *
 * The watcher records a fire durably either way; this is the PUSH half, so a
 * head that is up is told as it happens rather than finding the fire on its next
 * read. It is a hook rather than a hard dependency because the head may be a
 * window that surfaces notices its own way, or a process that is not there at
 * all - in which case the fire waits in the file, which is the honest place for
 * it.
 */
let headWatchSink: ((familyId: string, notice: string) => void) | undefined

/** Register the sink a fired watcher is pushed to. Returns a remover. */
export function registerHeadWatchSink(sink: (familyId: string, notice: string) => void): () => void {
  headWatchSink = sink
  return () => { if (headWatchSink === sink) headWatchSink = undefined }
}

/**
 * Watch the family and record the two conditions the head asked about.
 *
 * The idle-flip and the new-session watch are the SAME mechanism: on every
 * workspace change, compare each member's state to what it was, and the member
 * set to what it was. A watched member that crossed into idle is a flip; a
 * member that was not there before is new. Both are appended as `watch-fired`
 * events, so the fire outlives the process that noticed it, and both are pushed
 * to the sink when one is registered.
 *
 * The subscription is what makes this a hook rather than a poll: the menu
 * already recomputes every member's state on each change, and this rides that
 * same signal instead of asking the sessions again. Starting it twice is a
 * no-op per family, so a head that sets two watches does not double its
 * notifications.
 */
const runningWatches = new Map<string, () => void>()

export function startHeadWatch(familyId: string): () => void {
  const existing = runningWatches.get(familyId)
  if (existing) return existing
  const states = new Map<string, string>()
  const ids = new Set<string>()
  let primed = false
  let stopped = false
  let unsubscribe = (): void => { /* The subscription is installed asynchronously. */ }

  const advance = (currentStates: Map<string, string>, currentIds: Set<string>): void => {
    states.clear(); for (const [id, state] of currentStates) states.set(id, state)
    ids.clear(); for (const id of currentIds) ids.add(id)
  }

  const tick = async (): Promise<void> => {
    const { getLeafViews } = await import('./leafWorkspace.js')
    const currentStates = new Map<string, string>()
    const currentIds = new Set<string>()
    for (const view of getLeafViews()) {
      if (view.rootSessionId !== familyId) continue
      currentStates.set(view.member.sessionId, view.process.getState())
      currentIds.add(view.member.sessionId)
    }
    // The first pass only primes the baseline: a watcher set now is about what
    // happens NEXT, so the family as it already stands is not a wall of fires.
    if (!primed) {
      primed = true
      advance(currentStates, currentIds)
      return
    }
    const watches = currentWatches(await readHeadLedgerEvents(familyId))
    const idleWatched = watches.filter(watch => watch.mode === 'idle').map(watch => watch.to)
    for (const id of idleFlips(states, currentStates, idleWatched)) {
      await appendHeadLedgerEvent(familyId, { kind: 'watch-fired', to: id, mode: 'idle', detail: `${id} is idle` })
      headWatchSink?.(familyId, `${id} went idle`)
    }
    if (watches.some(watch => watch.mode === 'new')) {
      for (const id of newMembers(ids, currentIds)) {
        await appendHeadLedgerEvent(familyId, { kind: 'watch-fired', to: id, mode: 'new', detail: `new leaf ${id}` })
        headWatchSink?.(familyId, `new leaf ${id}`)
      }
    }
    advance(currentStates, currentIds)
  }

  const stop = (): void => {
    stopped = true
    unsubscribe()
    runningWatches.delete(familyId)
  }
  runningWatches.set(familyId, stop)
  void (async () => {
    const workspace = await import('./leafWorkspace.js')
    // A stop that landed while the module was loading must not leave a live
    // subscription behind.
    if (stopped) return
    unsubscribe = workspace.subscribeLeafWorkspace(() => { void tick() })
  })()
  return stop
}

/** One member's live state, as the two existing sources answer it. */
export type MemberLiveness = {
  sessionId: string
  name: string
  /** The in-process state when this session hosts the member, else null. */
  state: string | null
  /** When the zenith ledger last observed it, else null. */
  lastSeen: string | null
  buildId?: string
}

/**
 * The family's members with their working/idle state, without reading a chat.
 *
 * This is the direct query the head asked for: the same live state the leaf menu
 * renders (`· working`, idle) read programmatically instead of eyeballed, plus
 * the zenith ledger's observation for a member this session does not host. It is
 * a PROJECTION - it reads the family's views and the zenith ledger and restates
 * neither, so it can never disagree with them. A member neither hosted here nor
 * ever observed reads as UNKNOWN (`state` null, `lastSeen` null) rather than
 * being assumed idle.
 */
export async function familyLiveness(familyId: string): Promise<MemberLiveness[]> {
  const { getLeafViews } = await import('./leafWorkspace.js')
  const { knownSessions } = await import('./zenithLedger.js')
  const local = getLeafViews().filter(view => view.rootSessionId === familyId)
  const rows = new Map<string, MemberLiveness>()
  for (const view of local) {
    rows.set(view.member.sessionId, { sessionId: view.member.sessionId, name: view.member.name, state: view.process.getState(), lastSeen: null })
  }
  for (const observation of await knownSessions()) {
    if (observation.familyRootSessionId !== familyId) continue
    const existing = rows.get(observation.sessionId)
    if (existing) existing.lastSeen = observation.observedAt
    else rows.set(observation.sessionId, { sessionId: observation.sessionId, name: observation.name, state: null, lastSeen: observation.observedAt, ...(observation.buildId ? { buildId: observation.buildId } : {}) })
  }
  return [...rows.values()]
}

/** What a `ledger` request carries: the subverb, and the fields it may need. */
export type HeadLedgerRequest = {
  /** show | liveness | note | decision | handoff | watch | unwatch | watchers | fired */
  subverb?: string
  /** The subject leaf for handoff and an idle watch. */
  leaf?: string
  /** The text of a note, decision or handoff. */
  text?: string
  /** The watch mode for watch/unwatch: idle (a member) or new (new leaves). */
  mode?: string
}

/**
 * Run one ledger request for the current family.
 *
 * Reads are ungated - any member may read the record - while the writes that
 * extend it (note, decision, handoff, watch, unwatch) go through `requireHead`,
 * so the ledger is the head's account and everyone can see it.
 */
export async function runHeadLedger(request: HeadLedgerRequest): Promise<string> {
  const { familyRootSessionId, resolveLeafRef } = await import('./leafWorkspace.js')
  const familyId = await familyRootSessionId()
  const subverb = (request.subverb ?? 'show').trim().toLowerCase()
  if (!['show', 'liveness', 'watchers', 'fired'].includes(subverb)) await requireHead()
  switch (subverb) {
    case 'show':
      return renderHeadLedger(familyId, await readHeadLedgerEvents(familyId))
    case 'liveness': {
      const rows = await familyLiveness(familyId)
      return rows.length
        ? rows.map(row => `${row.name} ${row.sessionId} - ${row.state ?? 'unknown'}${row.lastSeen ? `, last seen ${row.lastSeen}` : ''}`).join('\n')
        : 'No members.'
    }
    case 'note':
    case 'decision': {
      const text = request.text?.trim()
      if (!text) throw new Error(`${subverb} needs text`)
      await appendHeadLedgerEvent(familyId, { kind: subverb, text })
      return `Recorded a ${subverb}.`
    }
    case 'handoff': {
      const member = await resolveLeafRef(request.leaf ?? '')
      if (!member) throw new Error('Unknown or ambiguous leaf reference')
      const text = request.text?.trim()
      if (!text) throw new Error('handoff needs text')
      await appendHeadLedgerEvent(familyId, { kind: 'handoff', to: member.sessionId, text })
      return `Recorded a handoff to ${member.name}.`
    }
    case 'watch':
    case 'unwatch': {
      const mode = (request.mode ?? 'idle').trim().toLowerCase()
      if (mode !== 'idle' && mode !== 'new') throw new Error('the watch mode must be idle or new')
      let to = familyId
      let label = 'new leaves in this family'
      if (mode === 'idle') {
        const member = await resolveLeafRef(request.leaf ?? '')
        if (!member) throw new Error('an idle watch needs a leaf')
        to = member.sessionId
        label = member.name
      }
      await appendHeadLedgerEvent(familyId, { kind: 'watch', to, mode, on: subverb === 'watch' })
      if (subverb === 'watch') startHeadWatch(familyId)
      return `${subverb === 'watch' ? 'Watching' : 'Stopped watching'} ${label}.`
    }
    case 'watchers': {
      const watches = currentWatches(await readHeadLedgerEvents(familyId))
      return watches.length ? watches.map(watch => `${watch.mode}: ${watch.to}`).join('\n') : 'No watchers set.'
    }
    case 'fired': {
      const fires = (await readHeadLedgerEvents(familyId)).filter(event => event.kind === 'watch-fired')
      return fires.length ? fires.map(fire => `${fire.at} [${fire.mode}] ${fire.to}${fire.detail ? ` - ${fire.detail}` : ''}`).join('\n') : 'Nothing has fired.'
    }
    default:
      throw new Error(`Unknown ledger subverb "${subverb}". Use show, liveness, note, decision, handoff, watch, unwatch, watchers or fired.`)
  }
}

/**
 * The head-writes gate, distinct from the matriarch lease.
 *
 * Writing the ledger is the head's act, so the check is on the head designation
 * rather than on who holds the terminal: a matriarch that is not the head cannot
 * write the head's record, and the head can write it whether or not it holds the
 * terminal. Reads never call this.
 */
export async function requireHead(): Promise<string> {
  const { getLeafPatriarchSessionId } = await import('./leafWorkspace.js')
  const head = getLeafPatriarchSessionId()
  const self = getSessionId()
  if (self !== head) {
    throw new Error(`Only the family head writes the ledger; the head is ${head}, and any member may read.`)
  }
  return head
}
