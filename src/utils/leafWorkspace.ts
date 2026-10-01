import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:net'
import { access, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getSessionId, getSessionResumeDirectory } from '../bootstrap/state.js'
import { asSessionId } from '../types/ids.js'
import { getCwd } from './cwd.js'
import { checkHasTrustDialogAccepted } from './config.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { createFork } from '../commands/branch/branch.js'
import { flushSessionStorage, getCurrentSessionTitle, getProjectDir, getTranscriptPath, getTranscriptPathForSession, saveSessionName } from './sessionStorage.js'
import { addLeafMember, ensureCreatorMember, markLeafElder, readLeafFamily, resolveLeafMember, updateLeafMember, type LeafFamily, type LeafMember } from './leafFamily.js'
import { LeafProcess, isLeafProcessAlive } from './leafProcess.js'
import { LeafTakenError } from './leafChannel.js'
import { leafColorEnv } from './leafColor.js'
import { registerCleanup } from './cleanupRegistry.js'
import { lock } from './lockfile.js'
import { withResolvers } from './withResolvers.js'
import { isProcessRunning } from './genericProcessUtils.js'
import { launchPartner, partnerStartupTimeoutMs, type PartnerHandle } from './partnerLeaf.js'
import { getLeafSnapshot, isInteractiveLeaf, leafSessionId, requestLeafSelfClose, requestLeafWorkspace, subscribeLeafSnapshot, type LeafTerminalMessage } from './leafTerminal.js'
import { focusLeafTerminal, renderLeafTerminal } from './leafTerminalHost.js'
import { LEAF_PEER_PROMPT_PREFIX } from './gatewaySessionProtocol.js'
import { readFileTail, readTranscriptSlice, renderTranscriptSlice, TRANSCRIPT_TAIL_WINDOW, type TranscriptReadOptions } from './transcriptRead.js'
import {
  checkpointTranscriptPath, defaultCheckpointLabel, dropCheckpoint, findCheckpoint, listCheckpoints,
  purgeCheckpoint, recordCheckpoint, renderCheckpoints, sizeLabel, slugLabel, type LeafCheckpoint,
} from './leafCheckpoints.js'

export type LeafView = { rootSessionId: string; member: LeafMember; process: Pick<LeafProcess, 'getState' | 'checkpoint' | 'compact' | 'setModel' | 'setEffort'>; draft: string }
type OwnedLeafView = LeafView & { process: LeafProcess }
const views = new Map<string, OwnedLeafView>()
const ownerReleases = new Map<string, () => Promise<void>>()
const listeners = new Set<() => void>()
const selected = new Map<string, string>()
/**
 * One launch, in two halves.
 *
 * `view` is the member as a row and as something to enter, and it is ready as
 * soon as the member is recorded. `started` is the member actually listening,
 * which takes as long as a cold session takes to reach its input loop. They are
 * split because they are waited on by different callers: whoever opened the
 * member on the person's behalf has nothing to do with the second half, and
 * awaiting it held this session's input loop shut for the whole boot. A caller
 * whose answer depends on the member being up - it is about to send it
 * something, or to refuse because another window already has it - awaits
 * `started`.
 *
 * A refusal, which is a transcript another window is writing, reaches both
 * halves, so either await reports it.
 */
type Launching = { view: Promise<OwnedLeafView>; started: Promise<void> }
const launches = new Map<string, Launching>()
export function selectedLeafId(): string | undefined {
  if (isInteractiveLeaf()) return getSessionId()
  // Nothing chosen is the session on screen - which is a member whenever this
  // session came in through a member's own address rather than as its creator.
  return selected.get(getSessionId()) ?? selfLeafMemberId()
}

/**
 * The member designated as the family's patriarch, as last read.
 *
 * The designation lives on disk so that every session in the family reads the
 * same one, which means a render path cannot await it. Each public operation
 * refreshes this before it works, so conferring the title is visible as soon as
 * the next operation runs.
 */
let designatedPatriarch: { sessionId: string; name: string } | undefined

/**
 * Members that have held the patriarch role and given it up, as last read.
 *
 * The designation names the holder; this names the ones who gave it up, so that
 * the elder fact is durable at the moment the role moves rather than at a second
 * write an interruption can skip. Cached and published for the same reason the
 * designation is: a roster is a render path and cannot await the disk, so a
 * member reads it from the snapshot the host publishes.
 */
let formerPatriarchIds: readonly string[] = []

/** Which member the family's patriarch is right now: the designated one, else the creator. */
export function getLeafPatriarchSessionId(): string {
  return getLeafSnapshot()?.patriarchSessionId ?? designatedPatriarch?.sessionId ?? familyRootSync()
}

/**
 * The member the family is raising to be its next patriarch, as last read.
 *
 * A designation, like the patriarch's: it says what the family says a member IS,
 * not what the member is doing, so it lives on disk where every member reads the
 * same one and is cached here for the sync render paths. A member reads it from
 * the snapshot the matriarch publishes; the matriarch resolves it from the
 * designation it last read. Absent means the family is raising no one.
 */
let designatedHeir: string | undefined

/** Which member the family is raising as its next patriarch, if any. */
export function getLeafHeirSessionId(): string | undefined {
  return getLeafSnapshot()?.heirSessionId ?? designatedHeir
}

/** Members that have held the patriarch role and given it up, in the order they held it. */
export function getLeafFormerPatriarchIds(): readonly string[] {
  return getLeafSnapshot()?.formerPatriarchIds ?? formerPatriarchIds
}

/**
 * The family's name, which is the name of the member designated as its patriarch.
 *
 * Conferring the title renames the family, so this cannot be the creator's title.
 * A member reads it from the snapshot the session hosting the family publishes;
 * the matriarch resolves it from the designation it last read.
 */
export function getLeafPatriarchName(): string {
  const snapshot = getLeafSnapshot()
  if (snapshot) return snapshot.patriarchName
  const self = getSessionId()
  const patriarchId = getLeafPatriarchSessionId()
  if (patriarchId === self) return getCurrentSessionTitle(self) || 'Original'
  return views.get(patriarchId)?.member.name ?? (designatedPatriarch?.name ?? (resolvedRoot?.pointer?.rootName ?? 'Original'))
}

/**
 * The label for the carousel's first entry, which is the session it leaves for.
 *
 * A leaf draws the bar exactly as the window that owns the family draws it, and
 * there the first entry is the way back out of the leaf - so from a leaf it is
 * named after the session hosting the family, because that is the session the
 * entry switches to. The family's own name is a different fact: it is the name
 * of the member designated as the patriarch, and conferring that title or a
 * promotion moves it to another session while the matriarch stays where it is -
 * so answering with the family's name offered a switch to the matriarch under a
 * label belonging to someone else. Only in the window itself is the first entry
 * the session on screen, and then it is that session's own name. A leaf's own
 * name is getLeafSelfName()'s question, not this one.
 */
export function getLeafMatriarchName(): string {
  const snapshot = getLeafSnapshot()
  if (!snapshot) return getLeafSelfName()
  return snapshot.matriarchName
}

/**
 * The label for the session on screen itself: the session a new leaf forks when
 * no other source is chosen.
 */
export function getLeafSelfName(): string {
  const snapshot = getLeafSnapshot()
  if (snapshot) return snapshot.members.find(entry => entry.member.sessionId === leafSessionId())?.member.name ?? snapshot.patriarchName
  return getCurrentSessionTitle(getSessionId()) || 'Original'
}

export function selectLeaf(sessionId?: string): void {
  if (isInteractiveLeaf()) { void requestLeafWorkspace('select', [sessionId]).catch(() => {}); return }
  const self = getSessionId()
  const view = sessionId ? views.get(sessionId) : undefined
  if (sessionId && (!view || view.rootSessionId !== familyRootSync())) throw new Error('Unknown leaf')
  // Taking the terminal is the precondition for being selected, not a side
  // effect of it: a leaf that cannot take it stays unselected, so nothing points
  // at a session that is not on screen.
  if (!focusLeafTerminal(view?.process)) return
  if (sessionId) selected.set(self, sessionId)
  else selected.delete(self)
  publish()
}
let matriarchHandoff: { prepare: () => Promise<void>; resume: (member: LeafMember) => Promise<void>; exit: () => Promise<void> | void } | undefined
let closingMatriarch: Promise<string | undefined> | undefined
let pendingMatriarchClose: (() => Promise<void>) | undefined
const retiringMembers = new Set<string>()
let ownerServer: Server | undefined
let ownerEndpoint: string | undefined
let ownerStarting: Promise<void> | undefined
const ownerToken = randomUUID()

function ensureLeafOwnerEndpoint(): Promise<void> {
  return ownerStarting ??= (async () => {
    const id = randomUUID()
    ownerEndpoint = process.platform === 'win32' ? `\\\\.\\pipe\\gateway-leaf-owner-${id}` : join(familyIndexDir(), `${id}.owner.sock`)
    await mkdir(familyIndexDir(), { recursive: true, mode: 0o700 })
    const server = createServer(socket => {
      socket.on('error', () => {})
      socket.end(`${ownerToken}\n`)
    })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(ownerEndpoint!, resolve) })
    server.unref()
    ownerServer = server
  })()
}

/**
 * The partner sessions this session owns.
 *
 * A partner is a session, not a member of the family: it has its own address on
 * the peer bus and its own lifetime, bound here to *this* process by the owner
 * pipe it was launched with. The handle is kept so a partner can be closed and
 * so the roster can say which ones this session holds - not because the partner
 * needs a parent, which is what it deliberately does not have.
 */
const partners = new Map<string, { handle: PartnerHandle; label: string }>()

/**
 * The endpoint and token a partner is launched with.
 *
 * `ensureLeafOwnerEndpoint` is the ownership primitive: it is the address the
 * partner polls, and answering the token on it is what says the owner is alive.
 * A session that has never opened a leaf has never needed one - convening a
 * partner is the moment a plain session becomes an owner, so the pipe is
 * created here rather than assumed.
 */
export async function leafOwnerCredentials(): Promise<{ endpoint: string; token: string }> {
  await ensureLeafOwnerEndpoint()
  return { endpoint: ownerEndpoint!, token: ownerToken }
}

/**
 * How a partner names its owner on the bus: the roster row the owner shows.
 *
 * The name is the whole point of the identity half of this feature - an
 * anonymous partner is indistinguishable from any other headless session, and
 * the roster could not say whose it is or what it was convened for. Falling
 * back to the session id keeps the name true for a session with no readable
 * family rather than inventing an owner.
 */
async function partnerOwnerLabel(): Promise<string> {
  const self = getSessionId()
  try {
    const own = (await currentFamily()).members.find(member => member.sessionId === self)
    if (own) return memberLabel(own)
  } catch { /* A session with no family it can read still owns its partner. */ }
  return `session ${self}`
}

/**
 * Convene a partner: a headless session this one owns and works with.
 *
 * The launch is the only thing added here - enrollment, the peer bus and
 * turn-boundary delivery are what print mode already does once
 * `CLAUDE_CODE_USE_GATEWAY` is set, and the owner pipe is what binds the
 * partner's lifetime to this one. Both are wired by `launchPartner`, and the
 * refusal past the per-leaf cap comes from there rather than from a second
 * count kept here that could disagree with it.
 */
export async function createPartner(options: { purpose?: string; model?: string; effort?: string } = {}): Promise<string> {
  const owner = selfLeafMemberId() ?? getSessionId()
  const credentials = await leafOwnerCredentials()
  const sessionId = randomUUID()
  const purpose = options.purpose?.trim()
  const label = `partner of ${await partnerOwnerLabel()}${purpose ? `: ${purpose}` : ''}`
  const handle = await launchPartner({
    sessionId,
    ownerSessionId: owner,
    cwd: getCwd(),
    label,
    ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { effort: options.effort } : {}),
  }, credentials)
  partners.set(sessionId, { handle, label })
  // Wait for the handshake the launch sent, bounded by the launcher's own startup
  // budget. Convening is only useful if the partner can then be talked to, so the
  // result is written from an answer rather than from an assumption: a caller
  // told it is on the peer bus can message it, and one told it is not is not
  // misled into trying. A launch that fails answers this at once instead of
  // waiting out the bound, so a failure reads as a failure and not as slowness;
  // only a session that is up and never answers spends the whole budget.
  await handle.waitUntilReady(partnerStartupTimeoutMs())
  const state = handle.getState()
  const reach = state === 'ready'
    ? 'It is on the peer bus under that id, and it ends when this session does.'
    : state === 'failed'
      ? 'It never answered on its input loop, so it is not on the peer bus; it was killed and its slot released.'
      : 'It has not answered yet, so treat it as unreachable until action partners reports it ready.'
  return `Convened ${label} as ${sessionId} [${state}]. ${reach}`
}

/** The partners this session holds, with the state each is in. */
export function partnerRoster(): string {
  if (!partners.size) return 'No partners convened. Use action partner to start one.'
  const lines = ['partners']
  for (const [sessionId, entry] of partners) {
    // A partner that ended, or never came up, is shown as it is rather than
    // hidden: the row is the record that this session held it, and `closed` and
    // `failed` are both the truth about it.
    lines.push(`${entry.label} [${entry.handle.getState()}] ${sessionId}`)
  }
  return lines.join('\n')
}

/** Close one partner by a reference to it. The rest are untouched. */
export async function closePartner(reference: string): Promise<string> {
  const id = reference.trim()
  const entry = partners.get(id)
  if (!entry) throw new Error(`This session holds no partner ${id}; list them with action partners`)
  await entry.handle.close()
  partners.delete(id)
  return `Closed ${entry.label} (${id}).`
}

export function registerLeafMatriarchHandoff(handler: NonNullable<typeof matriarchHandoff>): () => void {
  matriarchHandoff = handler
  return () => { if (matriarchHandoff === handler) matriarchHandoff = undefined }
}

let contextReturn: ((id: string, text: string) => Promise<string>) | undefined
export function registerLeafContextReturn(handler: (id: string, text: string) => Promise<string>): () => void {
  contextReturn = handler
  return () => { if (contextReturn === handler) contextReturn = undefined }
}
let contextNotify: ((id: string, text: string) => Promise<string>) | undefined
/** Register how the session hosting the family receives a message from one of its leaves. */
export function registerLeafContextNotify(handler: (id: string, text: string) => Promise<string>): () => void {
  contextNotify = handler
  return () => { if (contextNotify === handler) contextNotify = undefined }
}

/**
 * Where a message to a leaf came from, and what was asked.
 *
 * A send is not finished when the leaf takes it; it finishes when the leaf
 * answers. Recording the sender and the question at dispatch time is what lets
 * the answer be routed back to whoever asked - including a sibling leaf, which
 * could otherwise only learn the outcome by reading its own transcript and
 * hoping. Deepest-first, so a chain of sends unwinds in the order it was made.
 */
const senders = new Map<string, { source: string; root: string; message: string }[]>()
function expectLeafReply(view: LeafView, message: string, origin?: string): void {
  const pending = senders.get(view.member.sessionId) ?? []
  pending.push({ source: origin ?? getSessionId(), root: view.rootSessionId, message })
  senders.set(view.member.sessionId, pending)
}
function forgetExpectedReply(sessionId: string, message: string): void {
  const pending = senders.get(sessionId)
  if (!pending) return
  const index = pending.map(item => item.message).lastIndexOf(message)
  if (index >= 0) pending.splice(index, 1)
  if (!pending.length) senders.delete(sessionId)
}

/**
 * Take one outstanding question off the books, so a reply that has already been
 * delivered mid-turn is not delivered a second time when the turn ends.
 */
function takeExpectedReply(sessionId: string, message: string): { source: string; root: string; message: string } | undefined {
  const pending = senders.get(sessionId)
  if (!pending) return undefined
  const index = pending.map(item => item.message).lastIndexOf(message)
  if (index < 0) return undefined
  const [taken] = pending.splice(index, 1)
  if (!pending.length) senders.delete(sessionId)
  return taken
}

/** What this session was told about a leaf, so a reply can be addressed back. */
export function pendingLeafSends(sessionId: string): string[] {
  return (senders.get(sessionId) ?? []).map(item => item.message)
}

/** Test seam: how many sends are outstanding for a leaf. */
export function pendingLeafSendCount(sessionId: string): number {
  return senders.get(sessionId)?.length ?? 0
}

/** Test seam: which sessions a leaf still owes an answer to, and for what. */
export function pendingLeafSendSources(sessionId: string): { source: string; message: string }[] {
  return (senders.get(sessionId) ?? []).map(({ source, message }) => ({ source, message }))
}

/**
 * Test seam: publish a view for an already-built member so dispatch and reply
 * routing can be exercised without spawning a CLI. Registering a view is the
 * only way in; every production path still goes through `launch`, so this
 * cannot be mistaken for a supported way to start a leaf.
 */
export function registerLeafViewForTesting(view: LeafView): () => void {
  views.set(view.member.sessionId, view as OwnedLeafView)
  publish()
  return () => { views.delete(view.member.sessionId); publish() }
}

/**
 * Test seam: drive the real leaf-request dispatch - the same entry point a
 * leaf's `leaf-request` message takes in production. Calling the workspace
 * functions directly would bypass the relay and hide exactly the wiring this
 * seam exists to cover.
 */
export function dispatchLeafRequestForTesting(
  sessionId: string,
  root: string,
  action: string,
  args: unknown[],
): Promise<void> {
  const view = views.get(sessionId)
  if (!view) return Promise.reject(new Error('Unknown leaf'))
  return handleLeafRequest(view.process, sessionId, root, { type: 'leaf-request', id: randomUUID(), action, args })
}

/**
 * Test seam: route the answer a leaf reports mid-turn through the same function
 * the leaf's `leaf-answered` message reaches in production. Calling
 * `reportLeafReply` directly would bypass the matching and the bookkeeping that
 * are the point of the early answer.
 */
export function deliverLeafAnswerForTesting(sessionId: string, question: string, answer: string): Promise<void> {
  const view = views.get(sessionId)
  if (!view) return Promise.reject(new Error('Unknown leaf'))
  return reportEarlyLeafAnswers(view, question, answer)
}
let revision = 0
function publish(): void {
  revision++
  for (const listener of listeners) listener()
  if (isInteractiveLeaf()) return
  const root = familyRootSync()
  const snapshot = { rootSessionId: root, patriarchName: getLeafPatriarchName(), patriarchSessionId: getLeafPatriarchSessionId(), heirSessionId: getLeafHeirSessionId(), formerPatriarchIds: getLeafFormerPatriarchIds(), matriarchSessionId: getLeafMatriarchSessionId(), matriarchName: getLeafSelfName(), members: getLeafViews().map(view => ({ member: view.member, state: view.process.getState() })) }
  for (const view of views.values()) {
    if (view.rootSessionId === root && !['closed', 'failed'].includes(view.process.getState())) {
      try { view.process.snapshot(snapshot) } catch { /* The child may still be spawning. */ }
    }
  }
}
subscribeLeafSnapshot(() => { revision++; for (const listener of listeners) listener() })
export function subscribeLeafWorkspace(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } }
export function leafWorkspaceRevision(): number { return revision }

/**
 * The session bar lives in the layout, below the prompt, so it cannot reach the
 * leaf menu by rendering it: the menu is a prompt overlay that has to float
 * above the clipped bottom slot. It asks for the menu by name instead, and
 * whichever component already owns that overlay slot opens it. Kept separate
 * from the workspace listeners so a menu request never re-renders every leaf
 * consumer.
 */
const menuListeners = new Set<() => void>()
export function requestLeafMenu(): void { for (const listener of menuListeners) listener() }
export function subscribeLeafMenuRequest(listener: () => void): () => void { menuListeners.add(listener); return () => { menuListeners.delete(listener) } }
export function getLeafViews(): LeafView[] {
  if (isInteractiveLeaf()) return (getLeafSnapshot()?.members ?? []).map(({ member, state }) => ({
    rootSessionId: getLeafSnapshot()!.rootSessionId, member, draft: member.draft ?? '',
    process: { getState: () => state, checkpoint: (name?: string) => requestLeafWorkspace('checkpoint', [member.sessionId, name]), compact: () => requestLeafWorkspace('compact', [member.sessionId]), setModel: (model: string) => requestLeafWorkspace('model', [member.sessionId, model]), setEffort: (effort: string) => requestLeafWorkspace('effort', [member.sessionId, effort]) },
  }))
  const root = familyRootSync()
  // Every member of the family is a leaf, the creator included: it has an
  // ordinary row now, so the roster a child reads and the sessions the bar can
  // switch to are the same list.
  return [...views.values()].filter(view => view.rootSessionId === root)
}

/**
 * The sessions the carousel can switch to. Its own name because the bar asks
 * for the switchable set rather than the roster; the carousel then filters on
 * liveness before it renders, so the two can diverge without either lying.
 */
export function getLeafCarouselViews(): LeafView[] {
  return getLeafViews()
}

/**
 * A member's pointer back to the family it belongs to.
 *
 * The family file is named after the root's session id, and until now the only
 * way to learn that id was to be started by the session that owns it. That made
 * membership depend on the patriarch being up: a leaf resumed on its own was an
 * orphan with an empty family, and closing the patriarch closed the family. Each
 * member now carries its own pointer, written by the root's process (the only
 * one that knows its transcript path and directory), so any member can find the
 * family and reopen the rest of it - including the patriarch.
 */
type LeafFamilyPointer = { rootSessionId: string; rootName?: string; rootTranscriptPath?: string; rootCwd?: string; patriarchSessionId?: string; heirSessionId?: string; formerPatriarchIds?: string[]; fromCheckpointId?: string; role?: 'leaf' | 'seed' | 'seedling'; seedOf?: string }
let resolvedRoot: { forSession: string; sessionId: string; pointer?: LeafFamilyPointer } | undefined

function familyPath(root: string): string { return join(getClaudeConfigHomeDir(), 'leaf-families', `${root}.json`) }
export function familyIndexDir(): string { return join(getClaudeConfigHomeDir(), 'leaf-families', 'index') }
function familyPointerPath(sessionId: string): string { return join(familyIndexDir(), `${sessionId}.json`) }

async function readLeafFamilyPointer(sessionId: string): Promise<LeafFamilyPointer | undefined> {
  try {
    const parsed = JSON.parse(await readFile(familyPointerPath(sessionId), 'utf8')) as LeafFamilyPointer
    return parsed && typeof parsed.rootSessionId === 'string' ? parsed : undefined
  } catch { return undefined }
}

async function writeLeafFamilyPointer(sessionId: string, pointer: LeafFamilyPointer): Promise<void> {
  await writeIndexFile(familyPointerPath(sessionId), pointer)
}

/**
 * Written like the family file itself: temp file, then a rename that Windows may
 * refuse while a reader holds the target. Shared with the LED store, which keeps
 * its own file in this directory and has the same reason to write it this way.
 */
export async function writeIndexFile(target: string, value: unknown): Promise<void> {
  await mkdir(familyIndexDir(), { recursive: true, mode: 0o700 })
  const temporary = `${target}.${randomUUID()}.tmp`
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
 * Which session manages this family, and what it holds open.
 *
 * One manager at a time: two windows both driving the family would each launch
 * their own copy of the same leaf and only discover each other by colliding over
 * it. The most recently opened session takes the lease - the person who just
 * opened the family is the one looking at it - and the previous holder learns it
 * was displaced the next time it reads the claim, rather than by failing
 * mid-action.
 *
 * A pid alone cannot say whether the holder is still there: pids are recycled,
 * so a dead host's claim would read as live. The process's own start time is
 * recorded with it and compared where the platform can be asked cheaply, which
 * is the same pair the peer roster uses. Nothing that matters rests on the
 * answer - an inherited member is verified against its own endpoint before
 * anything is launched - so a wrong answer costs a stale line in the menu.
 */
type LeafMatriarchClaim = {
  familyId: string
  matriarchSessionId: string
  pid: number
  processStartedAt: string
  token: string
  generation: number
  openMemberIds: string[]
}

function matriarchPath(familyId: string): string { return join(familyIndexDir(), `${familyId}.host.json`) }

/** This process's own start, which is what a claim written here records. */
const matriarchProcessStartedAt = new Date(Date.now() - process.uptime() * 1000).toISOString()

let matriarchState: { forSession: string; familyId: string; token: string; generation: number; matriarchSessionId: string; displaced: boolean; external: string[] } | undefined

async function readLeafMatriarchClaim(familyId: string): Promise<LeafMatriarchClaim | undefined> {
  try {
    const parsed = JSON.parse(await readFile(matriarchPath(familyId), 'utf8')) as LeafMatriarchClaim
    return parsed && typeof parsed.matriarchSessionId === 'string' && Number.isSafeInteger(parsed.generation) ? parsed : undefined
  } catch { return undefined }
}

/**
 * Whether the process that wrote a claim is still running.
 *
 * On Linux the process's start time is read from `/proc` and compared with the
 * claim's, so a recycled pid is caught. Windows has no cheap equivalent, so only
 * the pid is checked there - the limit the peer roster also has, and why the
 * members themselves are verified rather than trusted.
 */
async function matriarchProcessAlive(claim: LeafMatriarchClaim): Promise<boolean> {
  if (!isProcessRunning(claim.pid)) return false
  if (process.platform !== 'linux') return true
  try {
    const stat = await readFile(`/proc/${claim.pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const boot = (await readFile('/proc/stat', 'utf8')).split('\n').find(line => line.startsWith('btime '))?.split(' ')[1]
    if (!boot) return true
    return Math.abs(Number(boot) * 1000 + Number(fields[19]) * 10 - Date.parse(claim.processStartedAt)) < 2000
  } catch { return true }
}

/**
 * Take the family's lease, or renew the one this session already holds.
 *
 * A member the previous host had open is inherited rather than launched: it is
 * still running in that window, and starting a second copy is the one thing a
 * family must never do. An inherited member whose host is gone is not inherited
 * at all - nothing is running to leave alone - so the new host is free to open it.
 */
async function claimMatriarch(familyId: string): Promise<void> {
  const self = getSessionId()
  const previous = await readLeafMatriarchClaim(familyId)
  // Reading the family is not opening it. The lease goes to the window opened
  // most recently and stays there: the roster is loaded again every time the
  // menu is opened, and a restore that took the family back would have the
  // windows trade it on every repaint, so the one that manages it would be
  // whichever asked last rather than the one opened last. A claim whose host is
  // gone is the exception - nothing manages the family then, and the window
  // that is here takes it.
  const mine = matriarchState?.forSession === self && matriarchState.familyId === familyId
  const rival = previous !== undefined && previous.matriarchSessionId !== self && await matriarchProcessAlive(previous)
  if (mine && rival) {
    if (!matriarchState!.displaced) {
      matriarchState = { ...matriarchState!, displaced: true, matriarchSessionId: previous!.matriarchSessionId }
      publish()
    }
    return
  }
  if (mine) {
    const generation = previous && previous.matriarchSessionId !== self ? previous.generation + 1 : previous?.generation ?? matriarchState!.generation
    matriarchState = { ...matriarchState!, generation, displaced: false, matriarchSessionId: self }
    await writeLeafMatriarchClaim(familyId, {
      familyId, matriarchSessionId: self, pid: process.pid, processStartedAt: matriarchProcessStartedAt,
      token: matriarchState.token, generation, openMemberIds: heldMemberIds(familyId),
    }).catch(() => {})
    return
  }
  const inherited = rival ? previous!.openMemberIds : []
  const token = randomUUID()
  const generation = (previous?.generation ?? 0) + 1
  matriarchState = { forSession: self, familyId, token, generation, matriarchSessionId: self, displaced: false, external: inherited }
  await writeLeafMatriarchClaim(familyId, {
    familyId, matriarchSessionId: self, pid: process.pid, processStartedAt: matriarchProcessStartedAt, token, generation,
    openMemberIds: [...new Set([...heldMemberIds(familyId), ...inherited])],
  }).catch(() => {})
}

async function writeLeafMatriarchClaim(familyId: string, claim: LeafMatriarchClaim): Promise<void> {
  await writeIndexFile(matriarchPath(familyId), claim)
}

/** The members this session has a live process for. */
function heldMemberIds(familyId: string): string[] {
  return [...views.values()].filter(view => view.rootSessionId === familyId && !['closed', 'failed'].includes(view.process.getState())).map(view => view.member.sessionId)
}

/** Re-read the lease, so a host that was displaced learns it before its next action. */
async function refreshMatriarch(familyId: string): Promise<void> {
  const self = getSessionId()
  if (matriarchState?.forSession !== self || matriarchState.familyId !== familyId) return
  const claim = await readLeafMatriarchClaim(familyId)
  // An absent claim is not a rival: it is the file this window itself wrote, gone
  // for whatever reason, and nobody else is holding the family. Reading that as a
  // takeover would refuse this window the family it is the only manager of.
  //
  // A claim whose host has since exited is not a rival either. The lease is held
  // on behalf of a window that is no longer there, and a family nobody manages
  // can never be closed, opened or renamed again - the reading is right, the host
  // it names is not, and only a restart would clear it. Taking the lease back
  // through the path that takes a family at all is what rewrites the file, so
  // the windows that read it next see one live host instead of each reading the
  // dead one and believing the family to be its own.
  if (claim !== undefined && claim.matriarchSessionId !== self && !(await matriarchProcessAlive(claim))) {
    const wasDisplaced = matriarchState.displaced
    await claimMatriarch(familyId)
    if (wasDisplaced) publish()
    return
  }
  const displaced = claim !== undefined && claim.matriarchSessionId !== self
  const matriarchSessionId = displaced ? claim!.matriarchSessionId : self
  if (matriarchState.displaced === displaced && matriarchState.matriarchSessionId === matriarchSessionId) return
  matriarchState.displaced = displaced
  matriarchState.matriarchSessionId = matriarchSessionId
  // The leaves already attached learn the family moved the moment this window
  // does, rather than at whatever unrelated repaint comes next.
  publish()
}

/**
 * The manage-the-family gate.
 *
 * A displaced session keeps the terminals it already attached and can still talk
 * to them; what it must not do is drive the family, because the window that took
 * the lease is the one holding it. Refusing here is what stops two windows from
 * opening the same leaf twice.
 */
async function requireMatriarch(familyId: string): Promise<void> {
  await refreshMatriarch(familyId)
  if (matriarchState?.forSession === getSessionId() && matriarchState.displaced) throw new Error(`The family moved to another window (${matriarchState.matriarchSessionId}); it manages the leaves now`)
}

/**
 * Re-read the lease on behalf of a surface that is about to show it.
 *
 * The management gate refreshes before it acts, which is enough to refuse, but
 * not enough to *say so*: a menu that only read the lease at claim time drew the
 * managing rows for a family another window had already taken, and the person
 * found out by picking one and being refused. Asking on open is what makes the
 * menu report the family moved before a row is chosen.
 */
export async function refreshLeafMatriarch(): Promise<void> {
  if (isInteractiveLeaf()) return
  try { await refreshMatriarch(await familyRootSessionId()) } catch { /* No family to manage is not a failure to report. */ }
}

/** Whether this session is the one managing the family it is in. */
export function isFamilyMatriarch(): boolean { return !matriarchState || matriarchState.forSession !== getSessionId() || !matriarchState.displaced }
/** The session managing this family: this one, or the window it moved to. */
export function getLeafMatriarchSessionId(): string { return getLeafSnapshot()?.matriarchSessionId ?? (matriarchState?.forSession === getSessionId() ? matriarchState.matriarchSessionId : getSessionId()) }
/** Members another window is holding open, which this one must not start again. */
export function externallyHeldLeafIds(): readonly string[] { return matriarchState?.forSession === getSessionId() ? matriarchState.external : [] }

/**
 * Whether a member can still hold a designation.
 *
 * The question is the filing, not liveness. `open` is what the succession paths
 * already mean by a member that can take the role - `promoteNextPatriarch` and
 * `closeMatriarch` both pick the next patriarch with `status === 'open'` and
 * nothing else - and the other three filings are ways of having left: `closed`
 * and `archived` are put away, `promoted` stands on its own. A member whose
 * process merely is not running is still `open` and still acts, which is what
 * "records what a leaf was doing when we last saw it, not an instruction to
 * boot" means. Liveness is deliberately not consulted: it is not durable, and a
 * designation is a fact about the family that outlives any one process.
 */
function memberCanHoldRole(member: LeafMember): boolean {
  return member.status === 'open'
}

/** The family's members if its file can be read, undefined otherwise: a read is never a new failure here. */
async function familyMembersForRead(familyId: string): Promise<readonly LeafMember[] | undefined> {
  try { return (await readLeafFamily(familyPath(familyId), familyId)).members } catch { return undefined }
}

/**
 * The acting patriarch: the designated member while it can hold the role, else
 * the member the person listed first that can.
 *
 * A designation is a fact about a member, and a member that cannot hold the role
 * is not one every reader can resolve to. Without this a family whose patriarch
 * was filed away - which `onExit` does the moment its process dies, and a
 * deliberate close does on purpose - keeps naming a conversation that is not
 * there, and every reader decides from it: the roster marks it,
 * `promoteNextPatriarch`'s guard never promotes, `closeMatriarch`'s guard never
 * moves the matriarch, and `indexLeafMembers` republishes it into every member
 * pointer. Reading the designation as a preference rather than as the answer is
 * what makes an interrupted succession heal by being read instead of by being
 * repaired - and repairing on read is what would race the writer it is trying to
 * fix.
 *
 * Nothing is written here, deliberately: no pointer write, no elder mark, no
 * designation move. The designation is left exactly where the writer put it, so
 * this stays idempotent and side-effect free, and the family pointer stays the
 * authority. `indexLeafMembers` publishes THIS answer into the member copies,
 * which is safe only because no read path treats a member copy's
 * `patriarchSessionId` as authority - the family pointer keyed by the family id
 * is what every reader here goes through.
 *
 * The terminal answer is the designation the pointer already holds: when no
 * member can act, the last member the family designated is still what the family
 * says it is - a family with nothing open is dormant, not nameless. Only a family
 * that never designated anyone falls back to the family id, which is who the
 * patriarch was before anyone could designate one. That terminus is a name rather
 * than an acting member, and it is only reached when no member can act - which a
 * session that is itself reading cannot observe, because the reading session's
 * own row is open.
 */
async function actingPatriarch(familyId: string, designated: string): Promise<string> {
  const members = await familyMembersForRead(familyId)
  if (!members) return designated
  if (members.some(member => member.sessionId === designated && memberCanHoldRole(member))) return designated
  return members.filter(memberCanHoldRole).sort((a, b) => a.number - b.number)[0]?.sessionId ?? designated
}

/**
 * The designation exactly as the pointer holds it.
 *
 * For the write paths that decide whether to MOVE the designation. They ask
 * whether the member leaving is the one the family designated, which is a
 * question about the pointer rather than about who can act, so they read it
 * directly. `familyPatriarchSessionId` answers the other question, for readers.
 * The two cannot be conflated, and the reason is ordering rather than taste: a
 * deliberate close files the member `closed` (see `changeLeaf` and
 * `pendingMatriarchClose`) BEFORE asking whether the designation should move, so
 * a moving question asked of the derived answer would see the successor already
 * acting and never move the designation or its titles at all.
 */
async function designatedPatriarchSessionId(familyId: string): Promise<string> {
  return (await readLeafFamilyPointer(familyId))?.patriarchSessionId ?? familyId
}

/**
 * Which member is the family's patriarch.
 *
 * The family file never moves - it is named after the creator's session id and
 * that name is treated as a stable family id - so the designation cannot live
 * there without a format change every older reader would have to understand. It
 * lives in the creator's own pointer instead, which is read loosely and whose
 * extra field an older reader ignores. Absent, the family id is the patriarch,
 * which is exactly what the patriarch was before anyone could designate one.
 *
 * The pointer names the member the family DESIGNATED. The answer here is the
 * member that can actually act as it; see `actingPatriarch` for why the two come
 * apart and why nothing is written to put them back together.
 */
async function familyPatriarchSessionId(familyId: string): Promise<string> {
  return actingPatriarch(familyId, await designatedPatriarchSessionId(familyId))
}

/**
 * Which member the family is raising as its next patriarch, if any.
 *
 * Read from the same loose pointer the patriarch designation lives in, so a
 * reader that does not know about heirs simply ignores the extra field. A raise
 * is a fact about a member the family is training, and only a member that can
 * still act can be trained: an heir that was filed away is no heir and resolves
 * to none rather than to a session that is not there. Singular by construction -
 * there is no next in line to fall to, because ascension is a decision and not a
 * fallback - so this is the same rule as the patriarch's, not a second one.
 */
async function familyHeirSessionId(familyId: string): Promise<string | undefined> {
  const designated = (await readLeafFamilyPointer(familyId))?.heirSessionId
  if (!designated) return undefined
  const members = await familyMembersForRead(familyId)
  if (!members) return designated
  return members.some(member => member.sessionId === designated && memberCanHoldRole(member)) ? designated : undefined
}

/**
 * What part a member plays in its family.
 *
 * A member is an ordinary leaf unless it was made as something else. A seed is a
 * merge target - a fork of a leaf that other forks are pointed at - and a
 * seedling is a bounded fork of a seed that is meant to come back to it, so a
 * seedling names the seed it belongs to. The role lives in the loose pointer for
 * the same reason the patriarch designation does: the family file is strict and
 * shared with older readers, and anything a role needs to say is about one
 * session, not about the family's shape.
 *
 * Absent is the whole of the fallback. A pointer that cannot be read, or one
 * written before roles existed, is a leaf - which is what every member was.
 */
export async function leafMemberRole(sessionId: string): Promise<{ role: 'leaf' | 'seed' | 'seedling'; seedOf?: string }> {
  const pointer = await readLeafFamilyPointer(sessionId)
  return { role: pointer?.role ?? 'leaf', seedOf: pointer?.seedOf }
}

/**
 * The designated patriarch as a member row.
 *
 * A designation naming a session that is not (or no longer) in the family is
 * ignored rather than honoured: a patriarch that is not a member cannot be opened,
 * renamed or have the title conferred, and every reader would have to special-case it. The
 * creator is the fallback, so the answer is never "no patriarch at all".
 */
async function familyPatriarchMember(members: readonly LeafMember[], familyId: string): Promise<LeafMember | undefined> {
  const designated = await familyPatriarchSessionId(familyId)
  return members.find(member => member.sessionId === designated) ?? members.find(member => member.sessionId === familyId)
}

/**
 * Write the designation where every member reads it, keeping the pointer's other fields.
 *
 * This is the one place the patriarch moves, so it is also the one place a member
 * becomes an elder: whoever the designation is moving away from has held the role
 * and does not hold it now.
 *
 * Who that is comes from the caller when the caller knows, because the caller is
 * the one that decided the move and the raw pointer can disagree with it. A
 * reader resolves a designation to a member that can act
 * (`familyPatriarchSessionId`), so with a stale designation the member being
 * displaced - the one whose title this write demotes - is not the member the
 * pointer still names. The caller passes the member its own decision is about
 * (`current` in `conferPatriarch`, `leaving` in `promoteNextPatriarch`, `self` in
 * `pendingMatriarchClose`), so the demotion and the record name one member rather
 * than two.
 *
 * The raw read stays as the fallback, and the family id after it: a path that
 * bootstraps a family which never had a designation writes none of its own and
 * must still record that the creator held the role, which is the patriarch a
 * family has before anyone could designate one.
 */
export async function writePatriarchDesignation(familyId: string, patriarchSessionId: string, displacedSessionId?: string): Promise<void> {
  const current = await readLeafFamilyPointer(familyId)
  const previous = displacedSessionId ?? current?.patriarchSessionId ?? familyId
  const base = current?.rootSessionId === familyId ? current : rootPointerInfo(familyId)
  // The heir designation describes a raise that is in progress UNDER THE CURRENT
  // patriarch: the member was being trained by whoever holds the role. When the
  // role moves - to the heir itself, to a third member, or nowhere but away - the
  // raise is over, because the member that was training it has left the chair. So
  // the designation is cleared in the same write that moves the role, which is
  // the same rule as the elder: it belongs to the patriarch moving, and ascension
  // is one instance of it rather than a special case. A write that does not move
  // the role leaves the raise in place.
  const heirSessionId = previous === patriarchSessionId ? current?.heirSessionId : undefined
  // The elder fact is recorded in THIS write rather than in the mark that
  // follows it. The mark is a second write, and an interruption between the two
  // loses the fact for good: nothing on disk would name the member that held the
  // role, and no read can invent a fact that was never written. The pointer is
  // the write that cannot be skipped, because it is the one that moves the role,
  // so the outgoing holder is named here. Whoever the role moved away from has
  // held it, which is the whole of the elder concept - the mark still runs, and
  // is what a reader that only knows the row field goes on reading.
  const formerPatriarchIds = previous === patriarchSessionId
    ? current?.formerPatriarchIds ?? []
    : [...new Set([...(current?.formerPatriarchIds ?? []), previous])]
  await writeLeafFamilyPointer(familyId, { ...base, patriarchSessionId, heirSessionId, formerPatriarchIds })
  if (previous !== patriarchSessionId) await markLeafElder(familyPath(familyId), familyId, previous)
}

/** Re-read the designation and keep it where sync render paths can name the family. */
async function refreshDesignatedPatriarch(): Promise<LeafMember | undefined> {
  const root = await familyRootSessionId()
  const members = await ensureCreatorRow(root, (await currentFamily()).members)
  const member = await familyPatriarchMember(members, root)
  designatedPatriarch = member ? { sessionId: member.sessionId, name: member.name } : undefined
  designatedHeir = await familyHeirSessionId(root)
  formerPatriarchIds = (await readLeafFamilyPointer(root))?.formerPatriarchIds ?? []
  return member
}

/**
 * Hand the family to the next member in line when its patriarch leaves.
 *
 * A patriarch that is closed, archived, or gone from its window has taken the
 * family's name and its `patriarch`/`root` references with it, and a designation
 * naming a session that is no longer a member is ignored by every reader - so
 * the family would keep the name of a conversation that is no longer in it and
 * `patriarch` would resolve to nothing. The designation therefore moves down to the
 * lowest-numbered member still in the family, which is the member the person
 * listed first and the row the menu shows at the top.
 *
 * The titles move with it, exactly as a conferral moves them: the next member
 * becomes the bare name the family is called by, and the member that is leaving
 * takes the leaf naming. A member leaving ITSELF is left out of that second half
 * - it is the conversation running this, writing a title onto the transcript it
 * is about to stop writing.
 *
 * Nothing happens unless the member leaving IS the patriarch, and that is settled
 * from the designation alone before the family file is opened - so this is safe
 * to call on every departure, which is where it runs.
 *
 * KNOWN LIMITATION, and deliberate: the heir designation does NOT influence this
 * choice. A family that raised a successor and then lost the patriarch it was
 * raising it under does not hand the role to that successor - the member the
 * person listed first takes it, and the heir must be promoted deliberately. An
 * automatic hand-to-the-heir is the mechanism the family model exists without:
 * ascension is a decision someone makes, not a fallback a lost session triggers.
 * The raise is over the moment the patriarch moves, so what is passed over here
 * is a member that is no longer being raised at all.
 */
async function promoteNextPatriarch(root: string, leaving: string): Promise<LeafMember | undefined> {
  // The designation is read as the pointer holds it, not as `actingPatriarch`
  // resolves it: the member leaving is filed away before this runs, so asking
  // who can act would already answer with its successor and nothing would move.
  if ((await designatedPatriarchSessionId(root)) !== leaving) return undefined
  const members = await ensureCreatorRow(root, (await readLeafFamily(familyPath(root), root)).members)
  const current = members.find(member => member.sessionId === leaving)
  if (!current) return undefined
  const next = members
    .filter(member => member.sessionId !== leaving && member.status === 'open' &&
      (member.sessionId === getSessionId() || isLeafProcessAlive(views.get(member.sessionId)?.process.getState() ?? 'closed')))
    .sort((a, b) => a.number - b.number)[0]
  if (!next) return undefined
  // A title is an append to a transcript, and the successor is very often a leaf
  // that is working - the whole reason a family has members. A member mid-turn is
  // writing its own transcript, so it keeps the row name it already has (which is
  // what the family is named by) and is not appended to from underneath.
  const successor = views.get(next.sessionId)
  if (!successor || ['idle', 'closed', 'failed'].includes(successor.process.getState())) saveSessionName(asSessionId(next.sessionId), next.name, next.transcriptPath)
  if (leaving !== getSessionId()) saveSessionName(asSessionId(leaving), `Leaf ${current.number}: ${current.name}`, current.transcriptPath)
  await writePatriarchDesignation(root, next.sessionId, leaving)
  // Every pointer is rewritten with the patriarch the family has now, so a leaf
  // resumed on its own later reads the family it actually belongs to.
  await indexLeafMembers(root, members)
  await refreshDesignatedPatriarch()
  return next
}

/** What a member needs to find the family, and to open its patriarch again. */
function rootPointerInfo(root: string): LeafFamilyPointer {
  if (root === getSessionId()) return {
    rootSessionId: root,
    rootName: getCurrentSessionTitle(getSessionId()) || 'Original',
    rootTranscriptPath: getTranscriptPath(),
    rootCwd: getSessionResumeDirectory(),
  }
  const pointer = resolvedRoot?.pointer
  return { rootSessionId: root, rootName: pointer?.rootName, rootTranscriptPath: pointer?.rootTranscriptPath, rootCwd: pointer?.rootCwd }
}

/**
 * Record which family each member belongs to, so membership outlives the patriarch
 * process that created it. Failures are swallowed: a pointer that cannot be
 * written costs a member its standalone discovery, never the family it is
 * already in.
 */
function indexLeafMembers(root: string, members: readonly LeafMember[], extra?: Partial<LeafFamilyPointer>): Promise<void> {
  return (async () => {
    // The designation is read before it is written: the family-id pointer is
    // the authority, and re-indexing must republish it rather than drop it.
    //
    // A member copy is republished with the ACTING patriarch, so it can disagree
    // with the family pointer, which holds the designation as written. That is
    // safe only because no read path treats a member copy's `patriarchSessionId`
    // as authority - `familyPatriarchSessionId` always reads the family pointer
    // keyed by the family id - so the next reader to add a lookup here must read
    // the family pointer, not the copy.
    //
    // The root is a member, so its own entry IS the family pointer: it is the one
    // that must keep the designation as written. Writing the acting answer there
    // would heal the pointer on every ordinary mount, and the raw designation is
    // the only record of who was displaced - so a mount would silently undo the
    // succession record that the designation exists to keep. Only the copies get
    // the acting answer, which is the whole reason they exist: a member resumed on
    // its own must not be told to resolve to a session that cannot act.
    const base = { ...rootPointerInfo(root), heirSessionId: await familyHeirSessionId(root), formerPatriarchIds: (await readLeafFamilyPointer(root))?.formerPatriarchIds ?? [], ...extra }
    const acting = await familyPatriarchSessionId(root)
    const designated = await designatedPatriarchSessionId(root)
    await Promise.all(members.map(member => writeLeafFamilyPointer(member.sessionId, { ...base, patriarchSessionId: member.sessionId === root ? designated : acting }).catch(() => {})))
  })()
}

/**
 * The session that owns this family's file and children.
 *
 * At the root this is the session itself. For a member - a leaf resumed on its
 * own, or one hosting the family after its patriarch was closed - it is the root
 * its pointer names, so every member reads the same family and can reopen the
 * rest of it. A pointer whose family file is gone is ignored rather than
 * resurrected into a family of one.
 */
export async function familyRootSessionId(): Promise<string> {
  const self = getSessionId()
  if (resolvedRoot?.forSession === self) return resolvedRoot.sessionId
  // A member learns the family from the session watching it while one is
  // watching. With nobody attached there is no snapshot to read, and a member
  // must still know where it belongs - so the pointer it wrote on its own way in
  // is the fallback, for a member exactly as for a leaf someone resumed by hand.
  const watching = isInteractiveLeaf() ? getLeafSnapshot()?.rootSessionId : undefined
  if (watching) {
    resolvedRoot = { forSession: self, sessionId: watching }
    return watching
  }
  const pointer = await readLeafFamilyPointer(self)
  if (pointer && pointer.rootSessionId !== self) {
    try {
      await access(familyPath(pointer.rootSessionId))
      resolvedRoot = { forSession: self, sessionId: pointer.rootSessionId, pointer }
      return pointer.rootSessionId
    } catch { /* The family is gone; this session stands alone. */ }
  }
  resolvedRoot = { forSession: self, sessionId: self }
  return self
}

/** The same root, for render paths that cannot await. Populated by the restore. */
export function familyRootSync(): string {
  const self = getSessionId()
  if (resolvedRoot?.forSession === self) return resolvedRoot.sessionId
  return getLeafSnapshot()?.rootSessionId ?? self
}

/**
 * The member this session is, when the family's own records say it is one.
 *
 * A member is an entry point in its own right, and the address the leaf menu
 * prints for one - `cc --resume <leaf id>` - carries none of the launch
 * environment a spawn carries. The window it opens is therefore not a leaf by
 * `isInteractiveLeaf()`, and knows only its own session id; what makes it a
 * member is the pointer it wrote on its way into the family, since a pointer
 * naming another session's family is the record of belonging to one.
 *
 * Without this the window read as the family's host with nothing selected, and
 * every question about "the session on screen" was answered with the family's
 * patriarch: the roster offered the window its own row as somebody else's to close,
 * and the create wizard - which takes the session on screen as the conversation
 * a new leaf copies - forked the patriarch rather than the leaf the person had
 * opened.
 */
export function selfLeafMemberId(): string | undefined {
  const self = getSessionId()
  if (isInteractiveLeaf()) return self
  return resolvedRoot?.forSession === self && resolvedRoot.sessionId !== self ? self : undefined
}

/** Test seam: drop the cached resolution so a pointer written afterwards is read. */
export function forgetLeafFamilyRoot(): void { resolvedRoot = undefined }

/**
 * Test seam: forget which family this session manages, so a case that opens one
 * starts from a window that has never seen it.
 *
 * The lease is module state, and a test process runs a whole file in one of them
 * - so a case about opening a family would otherwise inherit the lease an earlier
 * case took and read the opening as a re-open. Production has no equivalent: a
 * process opens a family once and stays the window that manages it.
 */
export function clearMatriarchClaimForTesting(): void { matriarchState = undefined }

/**
 * What a member knows about the family's creator.
 *
 * The creator's own process knows its transcript path and directory; a member
 * that resolved the family from its pointer has them cached; and any member
 * carries the same pointer on disk. One of the three always answers.
 */
async function creatorPointer(root: string, members: readonly LeafMember[]): Promise<LeafFamilyPointer> {
  if (root === getSessionId()) return rootPointerInfo(root)
  if (resolvedRoot?.pointer?.rootSessionId === root) return resolvedRoot.pointer
  for (const member of members) {
    const pointer = await readLeafFamilyPointer(member.sessionId)
    if (pointer?.rootSessionId === root) return pointer
  }
  return { rootSessionId: root }
}

/**
 * Give a family that predates the creator's row one, from whatever is known.
 *
 * The creator used to exist only as the family's identity - the file is keyed by
 * its id - so every reader synthesized a row for it and the patriarch was a
 * structural role rather than a member. It is an ordinary row now, and any
 * session that opens the family can write it; `ensureCreatorMember` is
 * idempotent, so this costs a read once and nothing afterwards.
 */
async function ensureCreatorRow(root: string, members: readonly LeafMember[]): Promise<readonly LeafMember[]> {
  if (members.some(member => member.sessionId === root)) return members
  const pointer = await creatorPointer(root, members)
  await ensureCreatorMember(familyPath(root), root, {
    name: pointer.rootName || 'Original',
    transcriptPath: pointer.rootTranscriptPath ?? getTranscriptPathForSession(root),
    ...(pointer.rootCwd ? { cwd: pointer.rootCwd } : {}),
  })
  return (await readLeafFamily(familyPath(root), root)).members
}

/**
 * The family's creator - the session the family file is named after - as a
 * member row.
 *
 * Undefined from the creator itself: the session on screen is not a target, and
 * offering it would start a second copy of the conversation you are in.
 */
export async function leafCreatorMember(): Promise<LeafMember | undefined> {
  const root = await familyRootSessionId()
  if (root === getSessionId()) return undefined
  const family = await currentFamily()
  return (await ensureCreatorRow(root, family.members)).find(member => member.sessionId === root)
}

/**
 * The member designated as the family's patriarch, as a row.
 *
 * Undefined from the patriarch itself: the session on screen is not a target, and
 * offering it would start a second copy of the conversation you are in.
 */
export async function leafPatriarchMember(): Promise<LeafMember | undefined> {
  const member = await refreshDesignatedPatriarch()
  if (!member || member.sessionId === getSessionId()) return undefined
  return member
}

/** How a member is named in a result or an error. */
function memberLabel(member: LeafMember): string {
  return `Leaf #${member.number} ${member.name}`
}

async function currentFamily(): Promise<LeafFamily> {
  const root = await familyRootSessionId()
  return readLeafFamily(familyPath(root), root)
}

/** Members of the current family, from the family file or a leaf's snapshot. */
export async function listLeafMembers(): Promise<LeafMember[]> {
  // A leaf's snapshot is the LIVE roster: the session hosting the family only
  // publishes members it holds a process for. A closed leaf - and an archived
  // one, which has no process at all - is missing from it, which is exactly the
  // set the archive screen exists to offer, so the leaf asks the host to read
  // the family file instead. The snapshot stays the fallback: an orphaned leaf
  // whose host is gone still knows the siblings it was last told about.
  if (isInteractiveLeaf()) {
    try { return await requestLeafWorkspace<LeafMember[]>('members') }
    catch { return (getLeafSnapshot()?.members ?? []).map(entry => entry.member) }
  }
  // Reading the family is where the designation is refreshed, so the roster the
  // menu shows and the patriarch every reference resolves to cannot disagree.
  await refreshDesignatedPatriarch()
  const self = getSessionId()
  // A member reading its family is looking for the others: itself is the session
  // already on screen, and offering it as a target would start a second copy of
  // the conversation you are in.
  return (await currentFamily()).members.filter(member => member.sessionId !== self)
}

/**
 * The roster as the menu shows it: the targets, plus the session on screen.
 *
 * A roster is a list of targets, and the conversation you are in is not one -
 * the menu drops that row itself, which is also why it can say which member the
 * window is showing. That works only while the session asking can be named: a
 * leaf relays the family file, which carries every member including the leaf, but
 * a window opened on a member's own address runs the read for itself and has no
 * launch environment to exclude with. The member it was showing was therefore
 * already missing from what it read, so the menu could not name the session it
 * was in and the create wizard - which offers the sessions a leaf can be forked
 * from - had no row for it, and fell back to naming the family's patriarch.
 */
export async function listLeafMenuMembers(): Promise<LeafMember[]> {
  const members = await listLeafMembers()
  // Inside a leaf the relayed roster already carries the leaf: the host filters
  // out only itself.
  if (isInteractiveLeaf()) return members
  const self = getSessionId()
  if (members.some(member => member.sessionId === self)) return members
  const own = (await currentFamily()).members.find(member => member.sessionId === self)
  return own ? [...members, own] : members
}

/**
 * Resolve a leaf reference (session ID, number, `N:name`, or name) against the
 * current family. Deterministic and side-effect free, so callers never need an
 * agent turn to locate a leaf.
 *
 * Real members are matched before aliases, so a member actually named `patriarch`
 * is the one that answers. The aliases then split: `original` is the family's
 * creator - its ancestral beginning, which does not move - while `patriarch` and
 * `root` are the member designated as the family's head now, and `matriarch` is
 * the session holding its terminal.
 */
export async function resolveLeafRef(reference: string): Promise<LeafMember | undefined> {
  const members = await listLeafMembers()
  const direct = resolveLeafMember(members, reference)
  if (direct) return direct
  const ref = reference.trim().toLowerCase()
  if (ref === 'matriarch') {
    const family = isInteractiveLeaf() ? await requestLeafWorkspace<LeafMember[]>('members') : (await currentFamily()).members
    return family.find(member => member.sessionId === getLeafMatriarchSessionId())
  }
  if (ref === 'original') return leafCreatorMember()
  if (ref === 'patriarch' || ref === 'root') return leafPatriarchMember()
  return undefined
}

/**
 * Resolve the target of a `close`, which is the one verb that may name the
 * session you are in.
 *
 * Every other verb acts on a member from the outside, and the session on screen
 * is deliberately not in the list those references resolve against: offering it
 * would let `open` start a second copy of the conversation you are typing into.
 * Closing is the exception - it is the one act that can be turned on the
 * conversation on screen, and the family file carries that conversation as an
 * ordinary member row. So this resolves like any other reference and then, only
 * when nothing else matched, accepts the session you are in, by the same four
 * forms every other member answers to: its session id, its number, `N:name`, or
 * its name. Reading the family is what makes that row available, and a session
 * with no family to read has nothing to close.
 */
export async function resolveCloseTarget(reference: string): Promise<LeafMember | undefined> {
  const member = await resolveLeafRef(reference)
  if (member) return member
  const self = getSessionId()
  try {
    const own = (await currentFamily()).members.find(entry => entry.sessionId === self)
    return own && resolveLeafMember([own], reference) ? own : undefined
  } catch { return undefined }
}

/** Names every member can use for the conversation the family came from. */
export function rootReference(reference: string): boolean {
  const ref = reference.trim().toLowerCase()
  return ref === 'original' || ref === 'root' || ref === 'patriarch'
}

/**
 * Whether a reference can only mean a member of this leaf family rather than a
 * live session on the global bus.
 *
 * Peer addressing uses exact session IDs, which are always UUIDs, so a
 * reference that is not a UUID has no peer meaning at all. Anything else is a
 * leaf number, a `N:name`, a leaf name or a root alias, and failing to resolve
 * it is a wrong address - not an invitation to look the same string up among
 * unrelated live sessions.
 */
export function leafFamilyReference(reference: string): boolean {
  const ref = reference.trim()
  if (!ref) return false
  if (rootReference(ref)) return true
  return !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)
}

/** The root's session ID as seen from inside the family. */
export function getLeafRootSessionId(): string {
  return getLeafSnapshot()?.rootSessionId ?? familyRootSync()
}

/**
 * One line per member as a leaf sees it, including the conversation everyone
 * was forked from. Every member gets the same view, so a leaf can address its
 * patriarch and its siblings and the original can address any leaf.
 */
export async function familyRoster(): Promise<string> {
  const members = await listLeafMembers()
  const root = getLeafRootSessionId()
  // The family is named by its id, which never moves. Which member is the
  // patriarch does move, so the mark follows the designation rather than the id.
  const patriarchId = getLeafPatriarchSessionId()
  const heirId = getLeafHeirSessionId()
  // The elder is read from the row AND from the pointer's record of who held the
  // role. The row mark is a second write that an interruption can skip, so the
  // record is what makes the fact survive one; a member is an elder if either
  // says so, and neither is ever cleared.
  const elderIds = new Set(getLeafFormerPatriarchIds())
  const states = new Map(getLeafViews().map(view => [view.member.sessionId, view.process.getState()]))
  const lines = [`family ${root}`]
  for (const member of members) {
    const state = states.get(member.sessionId) ?? member.status
    const settings = [member.model ? `model ${member.model}` : '', member.effort ? `effort ${member.effort}` : ''].filter(Boolean).join(' ')
    const role = `${member.sessionId === patriarchId ? ' [patriarch]' : ''}${member.sessionId === heirId ? ' [heir]' : ''}${member.eldership || elderIds.has(member.sessionId) ? ' [elder]' : ''}${member.sessionId === getLeafMatriarchSessionId() ? ' [matriarch]' : ''}`
    lines.push(`#${member.number} ${member.name} [${state}]${role} ${member.sessionId}${settings ? ` ${settings}` : ''}`)
  }
  return lines.join('\n')
}

/** Human/model readable family listing with live process state where known. */
export async function listLeaves(): Promise<string> {
  const members = await listLeafMembers()
  if (!members.length) return 'No leafs in this family.'
  const states = new Map(getLeafViews().map(view => [view.member.sessionId, view.process.getState()]))
  return members.map(member => {
    const state = states.get(member.sessionId) ?? member.status
    const settings = [member.model ? `model ${member.model}` : '', member.effort ? `effort ${member.effort}` : ''].filter(Boolean).join(' ')
    return `#${member.number} ${member.name} [${state}] ${member.sessionId}${settings ? ` ${settings}` : ''}`
  }).join('\n')
}

export type LeafReadOptions = TranscriptReadOptions

/** One line of prose for a digest row; a transcript line is not a paragraph. */
function singleLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat
}

/**
 * A member a `read` can be aimed at, resolved against the whole family.
 *
 * `resolveLeafRef` is the reference rule everywhere else, and it is deliberately
 * blind to this session - the session on screen is not a target to open. A read
 * is not an open, though, and the caller asking is usually a leaf reading *up*:
 * the creator arrives here as `original`, and refusing it would leave a leaf
 * unable to see the conversation its family came from. So the full member list
 * answers, and the aliases are resolved against it.
 */
function resolveReadTarget(members: readonly LeafMember[], reference: string): LeafMember | undefined {
  const direct = resolveLeafMember(members, reference)
  if (direct) return direct
  const ref = reference.trim().toLowerCase()
  if (ref === 'original') return members.find(member => member.sessionId === familyRootSync())
  if (ref === 'patriarch' || ref === 'root') return members.find(member => member.sessionId === designatedPatriarch?.sessionId)
  return undefined
}

/**
 * Every member at a glance: who they are, what they are doing, and the last
 * thing each of them said.
 *
 * One bounded read per member (a tail window, never the file), so the cost is
 * the window times the family size rather than the family's total bytes. It
 * works for a closed or archived member too: the transcript is on disk whether
 * or not a process is behind it, which is the whole reason reading can be
 * instant and never has to wait on a peer's turn.
 */
async function familyDigest(members: readonly LeafMember[]): Promise<string> {
  const self = getSessionId()
  const states = new Map(getLeafViews().map(view => [view.member.sessionId, view.process.getState()]))
  const lines = [`family ${familyRootSync()}`]
  for (const member of members) {
    const state = states.get(member.sessionId) ?? member.status
    const marks = [member.sessionId === self ? 'you' : '', member.sessionId === designatedPatriarch?.sessionId ? 'patriarch' : ''].filter(Boolean)
    const head = `#${member.number} ${member.name} [${state}]${marks.length ? ` (${marks.join(', ')})` : ''} ${member.sessionId}`
    try {
      const slice = await readTranscriptSlice(member.transcriptPath, member.sessionId, { tail: 1, maxChars: 1600 })
      const last = slice.turns.at(-1)
      const when = last?.at ? `${last.at.slice(5, 16).replace('T', ' ')} ` : ''
      const kind = !last ? '' : last.meta ? 'peer ' : last.role === 'assistant' ? '' : `${last.role} `
      const count = slice.chainLength === undefined ? '' : `${slice.chainLength} turns · `
      lines.push(`${head}\n  ${count}${last ? `${when}${kind}${singleLine(last.text)}` : '(no turns)'} — cursor ${slice.cursor}`)
    } catch {
      lines.push(`${head}\n  (transcript unavailable)`)
    }
  }
  return lines.join('\n')
}

/** The host's half of `read`, where every member's transcript path is known. */
async function readFamilyTranscript(reference: string | undefined, options: LeafReadOptions): Promise<string> {
  await refreshDesignatedPatriarch()
  const members = (await currentFamily()).members
  if (!reference) return familyDigest(members)
  const member = resolveReadTarget(members, reference)
  if (!member) throw new Error('Unknown or ambiguous leaf reference')
  const slice = await readTranscriptSlice(member.transcriptPath, member.sessionId, options)
  return renderTranscriptSlice(slice, `${memberLabel(member)} (${member.sessionId})`)
}

/**
 * Read what a member of this family has been doing, on demand.
 *
 * With a reference this is that member's own chat, newest turns last, bounded
 * and chain-correct. With none it is the family at a glance - one summary line
 * and a cursor per member - which is what "stay on top of five leaves" costs
 * when you do not yet know which one matters.
 *
 * It is a file read and never a turn: a busy member cannot take a peer message,
 * but its transcript is append-only and readable, so nothing here waits for, or
 * interrupts, the work being watched. What comes back is peer-authored text, and
 * it is labelled as such when rendered.
 */
export async function readLeafTranscript(reference?: string, options: LeafReadOptions = {}): Promise<string> {
  const ref = reference?.trim()
  // Inside a leaf the host holds the member list and the transcript paths; the
  // leaf holds a snapshot of neither. Same split as `list`, `roster` and
  // `members`, and the answer is rendered host-side either way.
  if (isInteractiveLeaf()) return requestLeafWorkspace<string>('read', [ref || undefined, options])
  return readFamilyTranscript(ref || undefined, options)
}

export const LEAF_EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode'] as const

async function requireLeafView(reference: string): Promise<{ member: LeafMember; view: OwnedLeafView }> {
  const member = await resolveLeafRef(reference)
  if (!member) throw new Error('Unknown or ambiguous leaf reference')
  const root = familyRootSync()
  let view = views.get(member.sessionId)
  if (view && view.rootSessionId !== root) view = undefined
  if (!view || !isLeafProcessAlive(view.process.getState())) {
    if (member.status !== 'open') throw new Error(`${memberLabel(member)} is ${member.status}`)
    const launched = launch(member, root)
    // This view is about to be sent input, so it has to be listening first.
    await launched.started
    view = await launched.view
  }
  return { member, view }
}

/**
 * The label on a turn that arrived from another session over the leaf wire.
 *
 * Delivered text enters the child's REPL through its normal input, which is the
 * only way to give it a turn - but that made a peer's instruction structurally
 * identical to something the person typed, so a leaf reading its own transcript
 * could not tell them apart. The prefix travels with the text, so the
 * distinction survives into the transcript and into what the leaf reads.
 *
 * Defined beside the gateway markers and re-exported rather than copied: the
 * renderer recognises the whole peer family by reading the text, so a second
 * copy here could drift from the one it tests and silently stop matching.
 */
export const PEER_PROMPT_PREFIX = LEAF_PEER_PROMPT_PREFIX

/** Structural view of a leaf transcript message; avoids importing the Message type here. */
export type LeafTranscriptMessage = {
  type?: string
  uuid?: string
  attachment?: { source_uuid?: string }
  message?: { content?: unknown }
}

/** A peer question this leaf has been handed and not yet answered. */
export type PendingPeerQuestion = { uuid: string; question: string }

/**
 * The answer a leaf has produced to the oldest question a peer is waiting on.
 *
 * The question is located by the id it arrived under, never by its text. Delivery
 * goes through the session's own queue, and the turn boundary then re-frames a
 * queued message as this session's context - so the peer marker is no longer at
 * the front of what the model sees, and searching for it finds nothing. The id
 * survives both arrival shapes: an idle leaf normalises the message to a user
 * turn carrying that uuid, and a running leaf drains it as a queued_command
 * attachment carrying it as source_uuid.
 *
 * Only prose the leaf wrote after being asked counts as an answer. A message
 * that also calls a tool is the leaf still working on it, and the end-of-turn
 * report covers the case where it never stops to reply in prose.
 */
export function peerAnswerFor(
  messages: readonly LeafTranscriptMessage[],
  pending: readonly PendingPeerQuestion[],
): { uuid: string; question: string; answer: string } | undefined {
  const oldest = pending[0]
  if (!oldest) return undefined
  const arrivedAt = messages.findIndex(message =>
    message?.attachment?.source_uuid === oldest.uuid ||
    (message?.type === 'user' && message.uuid === oldest.uuid))
  if (arrivedAt < 0) return undefined
  for (let index = arrivedAt + 1; index < messages.length; index++) {
    const message = messages[index]!
    if (message.type !== 'assistant') continue
    const blocks = Array.isArray(message.message?.content) ? message.message!.content as { type?: string; text?: string }[] : []
    const answer = blocks.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text!).join('\n').trim()
    if (!answer || blocks.some(block => block?.type === 'tool_use')) continue
    return { uuid: message.uuid ?? '', question: oldest.question, answer }
  }
  return undefined
}

/**
 * Where the message came from. A sibling leaf's send is relayed by the root
 * process, so `getSessionId()` is the root on that path even though the root
 * never asked; recording the relay instead of the asker sent the answer to a
 * conversation with no question in it and left the asking leaf waiting.
 */
export type LeafSendOrigin = { sessionId: string }

/** Hand a leaf a turn. Runs in the leaf's own REPL; the matriarch stays put. */
export async function sendLeafMessage(reference: string, text: string, origin?: LeafSendOrigin): Promise<string> {
  const message = text.trim()
  if (!message) throw new Error('Message required')
  if (message.length > 64000) throw new Error('Message too large')
  // A leaf naming its matriarch reaches the matriarch's conversation, not a sibling.
  if (isInteractiveLeaf() && rootReference(reference)) return notifyLeafMatriarch(message)
  if (isInteractiveLeaf()) {
    const member = await resolveLeafRef(reference)
    if (!member) throw new Error('Unknown or ambiguous leaf reference')
    return requestLeafWorkspace<string>('send', [member.sessionId, message])
  }
  const { member, view } = await requireLeafView(reference)
  const state = view.process.getState()
  const busy = state === 'running' || state === 'awaiting-approval'
  // The record of what was asked stays the sender's own text; only the turn the
  // leaf receives is labelled, so the reply can quote the question as asked.
  expectLeafReply(view, message, origin?.sessionId)
  const delivered = await view.process.deliver(`${PEER_PROMPT_PREFIX}${message}`)
  if (!delivered) {
    forgetExpectedReply(view.member.sessionId, message)
    throw new Error(busy
      ? `Message to ${memberLabel(member)} was not run; it ended before its turn finished`
      : `${memberLabel(member)} did not take the message; it was not run`)
  }
  return busy
    // Refusing here dropped the message and left the sender to guess when to
    // retry, which is how a mid-turn send died. A running leaf's own queue takes
    // it and runs it at the next step boundary, so only a leaf sitting on a
    // permission dialog actually waits; the reply is reported separately, as
    // soon as the answer exists rather than when the turn ends.
    ? `Queued for ${memberLabel(member)} (${member.sessionId}); ${state === 'awaiting-approval' ? 'it is waiting for permission, so it holds the message until the dialog is answered' : 'it is mid-turn, so it takes the message at its next step boundary - expect the reply before the turn ends'}.`
    : `Delivered to ${memberLabel(member)} (${member.sessionId}).`
}

export async function interruptLeaf(reference: string): Promise<string> {
  if (isInteractiveLeaf()) {
    const member = await resolveLeafRef(reference)
    if (!member) throw new Error('Unknown or ambiguous leaf reference')
    return requestLeafWorkspace<string>('interrupt', [member.sessionId])
  }
  const { member, view } = await requireLeafView(reference)
  await view.process.interrupt()
  return `Interrupted ${memberLabel(member)}.`
}

/**
 * Freeze a member's conversation as a named checkpoint.
 *
 * A live member is flushed first - its own process holds the write queue, and
 * the copy has to be of the conversation as it stands, not of the conversation
 * as it stood before its last turn. A member snapshotting itself is the one case
 * that cannot flush: its turn is this request, so what is on disk is everything
 * up to its last turn boundary, which is all a mid-turn copy can honestly hold.
 */
async function recordLeafCheckpoint(reference: string, label: string | undefined, requestedBy?: string): Promise<{ checkpoint: LeafCheckpoint; existed: boolean }> {
  const root = await familyRootSessionId()
  await requireMatriarch(root)
  const member = await resolveLeafRef(reference)
  if (!member) throw new Error('Unknown or ambiguous leaf reference')
  const view = views.get(member.sessionId)
  if (view && isLeafProcessAlive(view.process.getState())) {
    try { await view.process.checkpoint() }
    catch (error) { if (requestedBy !== member.sessionId) throw error }
  }
  const slice = await readTranscriptSlice(member.transcriptPath, member.sessionId, { tail: 1 })
  if (!slice.cursor) throw new Error(`${memberLabel(member)} has nothing to checkpoint yet`)
  return recordCheckpoint({
    familyId: root, sourceSessionId: member.sessionId, sourceName: member.name,
    sourceTip: slice.cursor, sourceTipAt: slice.turns.at(-1)?.at ?? null, turns: slice.chainLength ?? null,
    transcriptPath: member.transcriptPath,
    label: label?.trim() ? slugLabel(label) : defaultCheckpointLabel(member.name),
  })
}

function describeCheckpoint(result: { checkpoint: LeafCheckpoint; existed: boolean }): string {
  const { checkpoint, existed } = result
  const scale = `${checkpoint.turns === null ? '' : `${checkpoint.turns} turns · `}${sizeLabel(checkpoint.bytes)}`
  if (existed) return `Checkpoint #${checkpoint.ordinal} ${checkpoint.label} already covers this conversation; nothing new was saved.`
  return `Checkpoint #${checkpoint.ordinal} ${checkpoint.label} taken from ${checkpoint.sourceName} (${scale}). Branch it any time with \`/leaf fork #${checkpoint.ordinal}\`.`
}

export async function checkpointLeaf(reference: string, label?: string): Promise<string> {
  if (isInteractiveLeaf()) {
    const member = await resolveLeafRef(reference)
    if (!member) throw new Error('Unknown or ambiguous leaf reference')
    // The host holds the member list and the transcript paths, and it is the
    // party that can flush the member being snapshotted.
    return requestLeafWorkspace<string>('checkpoint', [member.sessionId, label])
  }
  return describeCheckpoint(await recordLeafCheckpoint(reference, label, getSessionId()))
}

/** The checkpoints a family has taken, or the ones a single member produced. */
export async function listLeafCheckpoints(reference?: string): Promise<string> {
  const root = await familyRootSessionId()
  const ref = reference?.trim()
  if (!ref) return renderCheckpoints(await listCheckpoints(root), root)
  const member = await resolveLeafRef(ref)
  if (!member) throw new Error('Unknown or ambiguous leaf reference')
  return renderCheckpoints(await listCheckpoints(root, member.sessionId), root)
}

/** Stop offering a checkpoint; its bytes, and every branch from it, stay. */
export async function dropLeafCheckpoint(reference: string): Promise<string> {
  const checkpoint = await dropCheckpoint(await familyRootSessionId(), reference)
  return `Checkpoint #${checkpoint.ordinal} ${checkpoint.label} dropped. Its bytes are kept: branches taken from it still work, and it can still be purged.`
}

/** Delete a checkpoint's bytes, leaving every branch from it alone. */
export async function purgeLeafCheckpoint(reference: string): Promise<string> {
  const checkpoint = await purgeCheckpoint(await familyRootSessionId(), reference)
  return `Checkpoint #${checkpoint.ordinal} ${checkpoint.label} purged. Branches taken from it are untouched.`
}

/**
 * The conversation a branch from a checkpoint starts at.
 *
 * Returned as a fork source - the frozen copy and the tip it froze - so a branch
 * copies the checkpoint's bytes rather than whatever the member has said since.
 */
export async function checkpointSource(reference: string): Promise<{ checkpoint: LeafCheckpoint; sessionId: string; transcriptPath: string }> {
  const root = await familyRootSessionId()
  const checkpoint = await findCheckpoint(root, reference, { includeDropped: true })
  if (!checkpoint) throw new Error('Unknown checkpoint')
  return { checkpoint, sessionId: checkpoint.sourceSessionId, transcriptPath: checkpointTranscriptPath(root, checkpoint.id) }
}

/**
 * Whether a reference names a checkpoint rather than a live conversation.
 *
 * A grammar that has to tell "fork this" from "fork a branch of this" asks this
 * first, because a label looks exactly like a leaf name and only the store knows
 * whether anything answers to it. An ambiguous label refuses here rather than
 * being read as a name to fork the current session under.
 */
export async function isCheckpointReference(reference: string): Promise<boolean> {
  const ref = reference.trim()
  if (!ref) return false
  return Boolean(await findCheckpoint(await familyRootSessionId(), ref))
}

export async function configureLeaf(reference: string, patch: { model?: string; effort?: string }): Promise<string> {
  if (patch.effort !== undefined && !(LEAF_EFFORT_LEVELS as readonly string[]).includes(patch.effort)) throw new Error('Invalid effort')
  if (patch.model === undefined && patch.effort === undefined) throw new Error('Model or effort required')
  if (isInteractiveLeaf()) {
    const member = await resolveLeafRef(reference)
    if (!member) throw new Error('Unknown or ambiguous leaf reference')
    return requestLeafWorkspace<string>('configure', [member.sessionId, patch])
  }
  await requireMatriarch(await familyRootSessionId())
  const { member, view } = await requireLeafView(reference)
  if (view.process.getState() !== 'idle') throw new Error('Leaf must be idle before its settings change')
  if (patch.model !== undefined) await view.process.setModel(patch.model)
  if (patch.effort !== undefined) await view.process.setEffort(patch.effort)
  await saveLeafSettings(member.sessionId, patch.model !== undefined ? { model: patch.model } : { effort: patch.effort as LeafMember['effort'] })
  const applied = patch.model !== undefined ? `model ${patch.model}` : `effort ${patch.effort}`
  return `${memberLabel(member)} ${applied} updated and saved for restart.`
}

/**
 * Ask a member to compact its own conversation.
 *
 * The summary is built from the messages the member is holding and installed
 * with the member's own `setMessages`; the host holds neither, so it cannot
 * compact on a member's behalf. What it can do is ask, and the member answers by
 * running its own `/compact` - the same command the person would type, through
 * the same path, so microcompaction, session-memory summarization and the
 * post-compact cleanup all apply. The host only confirms the request was taken:
 * the command queues, and a compaction cannot be dropped into the middle of a
 * turn, so the member refuses while it is busy rather than aborting work.
 */
export async function compactLeaf(reference: string, requester?: string): Promise<string> {
  if (isInteractiveLeaf()) {
    const member = await resolveLeafRef(reference)
    if (!member) throw new Error('Unknown or ambiguous leaf reference')
    return requestLeafWorkspace<string>('compact', [member.sessionId])
  }
  await requireMatriarch(await familyRootSessionId())
  const { member, view } = await requireLeafView(reference)
  // A leaf asking the host to compact it is busy awaiting this very answer, so
  // the idle gate below could never pass and the refusal would blame a turn that
  // is not the reason. Say what is actually wrong instead.
  if (requester && member.sessionId === requester) throw new Error(`${memberLabel(member)} is the session asking: a leaf cannot ask the host to compact itself. Type /compact at its own prompt.`)
  if (view.process.getState() !== 'idle') throw new Error(`Wait for ${memberLabel(member)} to finish its turn before compacting it`)
  await view.process.compact()
  return `${memberLabel(member)} was asked to compact its conversation; the summary replaces the turns once its REPL is next idle.`
}

/**
 * Hand the family's matriarch a turn from inside a leaf. Symmetric with
 * `sendLeafMessage`: the matriarch can drive a leaf, and a leaf can report back
 * to the matriarch without waiting for the human to copy anything across. The
 * message goes to whichever session is hosting the family - the matriarch -
 * never to the patriarch, which is a title and may not be open at all.
 */
export async function notifyLeafMatriarch(text: string): Promise<string> {
  const message = text.trim()
  if (!message) throw new Error('Message required')
  if (message.length > 64000) throw new Error('Message too large')
  if (!isInteractiveLeaf()) throw new Error('Only a leaf can message its matriarch')
  return requestLeafWorkspace<string>('notify', [getSessionId(), message])
}

/** Pull selected context from a leaf into the matriarch's transcript. */
export async function returnLeafContext(reference: string, text: string): Promise<string> {
  const member = await resolveLeafRef(reference)
  if (!member) throw new Error('Unknown or ambiguous leaf reference')
  if (isInteractiveLeaf()) return requestLeafWorkspace<string>('return', [member.sessionId, text])
  await requireMatriarch(await familyRootSessionId())
  if (!contextReturn) throw new Error('The matriarch is unavailable')
  return contextReturn(member.sessionId, text)
}

/**
 * How a member names itself to its own model.
 *
 * The creator is an ordinary member, but it is also the conversation the family
 * came from: naming it "of session <its own id>" is noise, and calling it a leaf
 * had it derive its intent from being one of its own leaves.
 *
 * Every other member names the session it was forked FROM, which is the row's
 * `parentSessionId` - its ancestry, and the member whose conversation it is a
 * continuation of. The family's root is not that answer: a leaf forked from a
 * leaf is not "of" the top level, and saying so had it treat the original as its
 * parent, fork the original where it meant to fork itself, and answer to a name
 * that belongs to the conversation behind it.
 */
function leafSelfLabel(member: LeafMember, rootSessionId: string): string {
  return member.sessionId === rootSessionId
    ? `The original session ${member.name} (family root ${rootSessionId})`
    : `Leaf ${member.number}: ${member.name} (of session ${member.parentSessionId})`
}

/** A transcript entry that means the conversation has been started. */
function holdsTurn(line: string): boolean {
  if (!line.trim()) return false
  const entry = JSON.parse(line) as { type?: string }
  return entry.type === 'user' || entry.type === 'assistant'
}

/**
 * How much of a transcript is read while looking for its first turn.
 *
 * The question is whether the conversation was ever started, and the answer is
 * in its first records, so this reads a head window and stops at the first
 * turn. The whole file was read to ask it - ~185 ms and a 237 MB allocation on
 * the path that opens a leaf - to look at data that cannot be past the start.
 */
const TRANSCRIPT_SCAN_WINDOW = 256 * 1024

async function transcriptHasTurn(path: string): Promise<boolean> {
  const handle = await open(path, 'r')
  const decoder = new StringDecoder('utf8')
  try {
    const buffer = Buffer.allocUnsafe(TRANSCRIPT_SCAN_WINDOW)
    // A read boundary can fall inside a line, and inside a character with it;
    // the decoder holds the partial character and `carry` holds the partial line
    // so neither is mistaken for an entry of its own.
    let carry = ''
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      const lines = (carry + decoder.write(buffer.subarray(0, bytesRead))).split('\n')
      carry = lines.pop() ?? ''
      if (lines.some(holdsTurn)) return true
      if (bytesRead === 0) return holdsTurn(carry)
    }
  } finally { await handle.close() }
}

function launch(member: LeafMember, rootSessionId: string): Launching {
  const pending = launches.get(member.sessionId)
  if (pending) return pending
  const halves = { view: withResolvers<OwnedLeafView>(), started: withResolvers<void>() }
  const launching: Launching = { view: halves.view.promise, started: halves.started.promise }
  // Registered before the first await, so two opens in the same tick join one
  // launch instead of racing each other for the transcript.
  launches.set(member.sessionId, launching)
  const settle = () => { if (launches.get(member.sessionId) === launching) launches.delete(member.sessionId) }
  // The entry lives until the member is listening, not until its row exists:
  // inside that window a second open has to join this launch rather than start
  // a rival member for one transcript.
  void launching.started.then(settle, settle)
  // Neither half is always awaited, and an unhandled rejection is a process
  // warning rather than a report, so both are claimed here.
  void halves.view.promise.catch(() => {})
  void launchOnce(member, rootSessionId, halves)
  return launching
}

async function launchOnce(
  member: LeafMember,
  rootSessionId: string,
  halves: { view: PromiseWithResolvers<OwnedLeafView>; started: PromiseWithResolvers<void> },
): Promise<void> {
  const refuse = (error: unknown) => { halves.view.reject(error); halves.started.reject(error) }
  const existing = views.get(member.sessionId)
  if (existing && !['closed', 'failed'].includes(existing.process.getState())) {
    halves.view.resolve(existing)
    halves.started.resolve(undefined)
    return
  }
  let release: () => Promise<void>
  try { release = await lock(`${member.transcriptPath}.leaf-owner`, { realpath: false, stale: 10000, retries: 0 }) }
  // A collision means a second member is being started for one transcript right
  // now, which is the one thing that must not happen. It is only that: a member
  // that is already up holds nothing here, so opening a running leaf is an
  // attach, not a refusal.
  catch { refuse(new Error(`${memberLabel(member)} is already open in another window; close it there before opening it here`)); return }
  // A member with a fork point is always resumed. A fresh member - and the
  // family's creator, which has no fork point - is resumed when its transcript
  // already holds a turn, and started under `--session-id` when it does not:
  // resuming a conversation with nothing in it would shadow it with an empty one.
  let hasTranscript = member.forkMessageId !== null
  if (!hasTranscript) {
    try { hasTranscript = await transcriptHasTurn(member.transcriptPath) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { await release(); refuse(error); return }
    }
  }
  await ensureLeafOwnerEndpoint()
  const processArgs = [process.argv[1]!, ...(hasTranscript ? ['--resume', member.sessionId] : ['--session-id', member.sessionId])]
  if (member.model) processArgs.push('--model', member.model)
  if (member.effort) processArgs.push('--effort', member.effort)
  const child = new LeafProcess({ executable: process.execPath, args: processArgs, cwd: member.cwd ?? getCwd(), env: {
    ...process.env, GATEWAY_LEAF_SESSION: member.sessionId, GATEWAY_INTERACTIVE_LEAF: '1',
    GATEWAY_LEAF_TRANSCRIPT: member.transcriptPath,
    // The leaf inherits this session's trust decision; it cannot answer a
    // dialog before it mounts, so an unanswered trust prompt would wedge start.
    GATEWAY_LEAF_TRUSTED: checkHasTrustDialogAccepted() ? '1' : '0',
    // What a leaf advertises and names itself by: it is the leaf's identity to
    // itself and, on the shared peer bus, to any other session that lists it.
    // Without it a leaf would derive its intent from the transcript it
    // was forked from and believe it was that session.
    GATEWAY_LEAF_LABEL: leafSelfLabel(member, rootSessionId),
    GATEWAY_LEAF_OWNER_ENDPOINT: ownerEndpoint,
    GATEWAY_LEAF_OWNER_TOKEN: ownerToken,
    GATEWAY_LEAF_DRAFT: existing?.draft ?? member.draft ?? '',
    GATEWAY_LEAF_COLUMNS: String(process.stdout.columns || 80), GATEWAY_LEAF_ROWS: String(process.stdout.rows || 24),
    // The leaf's own stdout is a pipe, so chalk would resolve to "no colour"
    // there and the leaf would render black and white. Its bytes are drawn by
    // THIS terminal, so hand down the depth that is actually going to render.
    ...leafColorEnv(),
  }, interactive: true,
    // The member's own address, which is how any session reaches it - including
    // one that outlives this process, and this one after it has been closed and
    // reopened. It is not a patriarch handle: nothing here is held open for the
    // member, and the member is not held open by anything here.
    sessionId: member.sessionId,
    onQueued: () => publish(),
    onState: () => {
      const current = [...views.values()].find(view => view.process === child)
      if (current && child.getState() === 'idle') void reportLeafReplies(current, child)
      publish()
    },
    onExit: () => {
      const current = [...views.values()].find(view => view.process === child)
      const id = current?.member.sessionId ?? member.sessionId
      if (selected.get(getSessionId()) === id) selectLeaf()
      // A member that was handed a new identity took a fresh claim on the
      // transcript it moved to, and that one is still held here. The claim taken
      // to start a member was released the moment it reached its endpoint, so
      // there is nothing else to give back.
      void ownerReleases.get(id)?.().catch(() => {})
      // The view is what the session bar offers to enter, so a view kept past
      // its process left an entry into a leaf that was gone. The draft is not
      // written here: a deliberate close saves it before closing, and a leaf on
      // its way out reports its composer as empty, so saving it here replaced a
      // stored draft with that empty value.
      if (current) views.delete(current.member.sessionId)
      if (current && !retiringMembers.has(id)) {
        void updateLeafMember(familyPath(rootSessionId), rootSessionId, id, { status: 'closed' }).then(() => publish()).catch(() => {})
      }
      publish()
    },
    onEvent: () => {},
    onTerminal: message => {
      if (message.type === 'leaf-output') renderLeafTerminal(child, message.epoch, message.data)
      if (message.type === 'leaf-state' && message.draft !== undefined) {
        const view = [...views.values()].find(view => view.process === child)
        if (view) view.draft = message.draft
      }
      if (message.type === 'leaf-answered') {
        const view = [...views.values()].find(view => view.process === child)
        if (view) void reportEarlyLeafAnswers(view, message.question, message.answer)
        return
      }
      if (message.type === 'leaf-request') void handleLeafRequest(child, member.sessionId, rootSessionId, message)
    },
  })
  const view: OwnedLeafView = { rootSessionId, member, process: child, draft: existing?.draft ?? member.draft ?? '' }
  views.set(member.sessionId, view)
  publish()
  // The row exists from here on; the member behind it does not yet. Whoever
  // only needs the row stops waiting now.
  halves.view.resolve(view)
  try {
    await child.start()
    if (member.model) await child.setModel(member.model)
    if (member.effort) await child.setEffort(member.effort)
  }
  catch (error) {
    await child.close()
    // A leaf that never reached its input loop owns no process, so its view
    // must not stay behind as an entry into a session that cannot be opened.
    views.delete(member.sessionId)
    publish()
    // Naming the member is the whole value of this error: "that session is
    // already open" leaves a person to guess which one they asked for.
    halves.started.reject(error instanceof LeafTakenError ? new Error(`${memberLabel(member)} is already open in another window; close it there before opening it here`) : error)
    return
  }
  finally {
    // The claim covers the start, not the member's life. Once it is listening
    // it refuses a second session on its own, and a file that outlives the
    // session that took it would go stale and start reading as "nobody is
    // holding this" while the member is still running under it.
    await release().catch(() => {})
  }
  publish()
  halves.started.resolve(undefined)
}

/**
 * Report a finished turn back to everyone who asked for it.
 *
 * The senders are recorded when the message is dispatched; this runs when the
 * leaf reaches idle, reads the answer out of the turn that just ended, and hands
 * it to each sender through the channel that sender already has - the matriarch
 * appends a marked user turn, a sibling leaf is handed its own turn. Without
 * this the reply is only visible to whoever happens to open the leaf next.
 */
async function reportLeafReplies(view: OwnedLeafView, child: LeafProcess): Promise<void> {
  const id = view.member.sessionId
  const pending = senders.get(id)
  if (!pending?.length || reportsInFlight.has(id)) return
  reportsInFlight.add(id)
  try {
    const answer = await lastLeafTurnText(view)
    if (!answer) return
    for (const item of [...pending]) {
      if (child.getState() !== 'idle') return
      try { await reportLeafReply(item, view, answer) }
      catch { /* A sender that cannot be reached is reported on its own next turn. */ }
    }
    senders.delete(id)
  } finally { reportsInFlight.delete(id) }
}
const reportsInFlight = new Set<string>()

/**
 * Hand the answer to the question the leaf just answered, as soon as it answers.
 *
 * A leaf reaches idle only when everything it was already doing is finished, so
 * reporting only then made a peer wait for the entire turn to answer a question
 * about one thing. The leaf now reports the answer the moment it stops working
 * on the question, and this routes it to whoever asked.
 *
 * The question travels with the answer and is matched by text. Several questions
 * can be outstanding at once now that a running leaf takes them immediately, and
 * the leaf may answer them out of order, so "the oldest one still owed" would
 * answer the wrong asker. Falling back to the oldest outstanding question keeps
 * the reply from being dropped if the leaf paraphrased instead of quoting.
 *
 * The question leaves the books here, so the end-of-turn report cannot answer it
 * a second time.
 */
async function reportEarlyLeafAnswers(view: OwnedLeafView, question: string, answer: string): Promise<void> {
  const id = view.member.sessionId
  if (reportsInFlight.has(id)) return
  const pending = senders.get(id)
  if (!pending?.length) return
  const item = pending.find(candidate => candidate.message.includes(question)) ?? pending[0]!
  reportsInFlight.add(id)
  try {
    await reportLeafReply(item, view, answer)
    takeExpectedReply(id, item.message)
  } catch {
    // The sender is unreachable now, but the turn-end report still owns the
    // question, so it stays on the books rather than being silently dropped.
  } finally { reportsInFlight.delete(id) }
}

/** The text of the last assistant message in these lines, as a reply writes it. */
function lastAssistantText(lines: readonly string[]): string | undefined {
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!
    if (!line.trim()) continue
    let entry: { type?: string; message?: { content?: unknown } }
    // A window's first line was cut mid-line, so an unparseable line is skipped
    // rather than treated as the end of the transcript.
    try { entry = JSON.parse(line) as typeof entry } catch { continue }
    if (entry.type !== 'assistant') continue
    const content = entry.message?.content
    const text = (Array.isArray(content) ? content : [])
      .filter((part: { type?: string; text?: string }) => part?.type === 'text' && typeof part.text === 'string')
      .map(part => part.text!)
      .join('\n')
      .trim()
    if (text) return text.length > 4000 ? `${text.slice(0, 4000)}…` : text
  }
  return undefined
}

/**
 * The text of the turn that just finished, so a reply can be quoted, not guessed.
 *
 * Read from the end, because the turn's own words are in the last records.
 * Reading the whole transcript for them cost ~152 ms and a 237 MB allocation in
 * the process the person is typing into, and this runs every time a member
 * reports a finished turn. The whole file is still read when the tail holds no
 * assistant text, so a reply is never lost to the shorter read.
 */
async function lastLeafTurnText(view: OwnedLeafView): Promise<string | undefined> {
  const path = view.member.transcriptPath
  try {
    const fromTail = lastAssistantText((await readFileTail(path, TRANSCRIPT_TAIL_WINDOW)).split('\n'))
    if (fromTail) return fromTail
  } catch { /* An unreadable tail is retried whole below. */ }
  try {
    return lastAssistantText((await readFile(path, 'utf8')).split('\n'))
  } catch { /* No transcript yet means nothing to report. */ }
  return undefined
}

/**
 * Route one reply to the session that asked for it.
 *
 * Inside a leaf both directions are the leaf wire: a sibling's answer is handed
 * back as a turn in this leaf's own REPL, and the root answers as a report to
 * the matriarch. At the root the same two cases are a sibling's plain turn and a
 * report appended to this conversation, because the root has no input channel.
 */
async function reportLeafReply(item: { source: string; root: string; message: string }, view: OwnedLeafView, answer: string): Promise<void> {
  const text = `Reply from Leaf ${view.member.number} ${view.member.name} (${view.member.sessionId}) to "${item.message.slice(0, 200)}":\n\n${answer}`
  if (isInteractiveLeaf()) {
    if (item.source === getSessionId()) return
    if (rootReference(item.source) || item.source === getLeafRootSessionId()) return void await notifyLeafMatriarch(text)
    await requestLeafWorkspace<string>('send', [item.source, text])
    return
  }
  if (item.source === getSessionId()) {
    // The root asked, so the answer belongs in the conversation that will read it.
    if (!contextNotify) return
    await contextNotify(item.source, text)
    return
  }
  if (item.root !== familyRootSync()) return
  // A sibling reads this as a turn in its own REPL, so it goes back through the
  // same send path - which labels it, since the reply is a peer message too.
  await sendLeafMessage(item.source, text)
}

const requestQueues = new WeakMap<LeafProcess, Promise<void>>()
function handleLeafRequest(child: LeafProcess, sourceId: string, root: string, message: Extract<LeafTerminalMessage, { type: 'leaf-request' }>): Promise<void> {
  const request = (requestQueues.get(child) ?? Promise.resolve()).then(() => executeLeafRequest(child, sourceId, root, message))
  requestQueues.set(child, request.catch(() => {}))
  return request
}
async function executeLeafRequest(child: LeafProcess, sourceId: string, root: string, message: Extract<LeafTerminalMessage, { type: 'leaf-request' }>): Promise<void> {
  try {
    const source = [...views.values()].find(view => view.process === child)
    if (familyRootSync() !== root || !source || source.rootSessionId !== root) throw new Error('Leaf family changed')
    sourceId = source.member.sessionId
    const [id, value, third, fourth] = message.args as any[]
    let result: unknown
    switch (message.action) {
      case 'identity': {
        if (id === sourceId) break
        if (typeof id !== 'string' || typeof value !== 'string' || id === root || views.has(id)) throw new Error('Session already open')
        const release = await lock(`${value}.leaf-owner`, { realpath: false, stale: 10000, retries: 0 })
        try {
          const family = await readLeafFamily(familyPath(root), root)
          const member = family.members.some(member => member.sessionId === id)
            ? await updateLeafMember(familyPath(root), root, id, { status: 'open' })
            : await addLeafMember(familyPath(root), root, {
              sessionId: id, parentSessionId: sourceId, name: source.member.name,
              transcriptPath: value, forkMessageId: null, cwd: source.member.cwd,
              model: source.member.model, effort: source.member.effort,
            })
          await updateLeafMember(familyPath(root), root, sourceId, { status: 'closed' })
          await ownerReleases.get(sourceId)?.()
          ownerReleases.delete(sourceId)
          views.delete(sourceId)
          source.member = member
          views.set(id, source)
          let released: Promise<void> | undefined
          ownerReleases.set(id, () => released ??= release())
          if (selected.get(root) === sourceId) selected.set(root, id)
          publish()
        } catch (error) { await release(); throw error }
        break
      }
      case 'select': selectLeaf(id); break
      case 'create': {
        // `sourceId` is the leaf that asked. It matters to the fork: a leaf
        // forking itself is mid-turn by construction, and a mid-turn leaf
        // cannot be checkpointed.
        const view = await createLeaf(id, value, third, { ...(fourth ?? {}), requestedBy: sourceId })
        result = view.member
        break
      }
      case 'return':
        if (!contextReturn) throw new Error('The matriarch is unavailable')
        result = await contextReturn(id, value)
        break
      case 'restore': await restoreLeafWorkspace(); break
      case 'open': result = await openLeaf(String(id)); break
      case 'open-once': result = await openLeafOnce(String(id)); break
      // Read here rather than through `listLeafMembers`, which inside a leaf
      // asks the host - and the host is this process, or the session that hosts
      // this one. Answering with the file stops the question going back up the
      // chain. The roster is complete: a leaf looks for itself in it, because
      // forking itself is the one thing it does to itself.
      case 'members': result = (await currentFamily()).members; break
      // `sourceId` is the leaf that asked. The refusal is about the session that
      // asked, not about this one: a leaf closing the matriarch is closing a member
      // the leaf is not, which is allowed, while a leaf asking to close itself is
      // not - and the host holds a view for the asker, so the view alone cannot
      // tell those two cases apart.
      case 'change': result = await changeLeaf(id, value, sourceId); break
      case 'patriarch': result = await conferPatriarch(String(id)); break
      case 'heir': result = await conferHeir(String(id)); break
      case 'file': result = await fileLeaf(id, value); break
      case 'goal': result = await setLeafGoal(id, value); break
      // A leaf reporting its own model/effort only persists them. Applying
      // settings must go through 'configure' so the matriarch drives the child
      // rather than the child echoing a control request back to itself.
      case 'settings': await saveLeafSettings(id, value); break
      case 'configure': result = await configureLeaf(id, value); break
      // `sourceId` is the requesting leaf, not this process. Passing it is what
      // routes the answer back to the leaf that asked instead of to the root.
      case 'send': result = await sendLeafMessage(id, value, { sessionId: sourceId }); break
      case 'roster': result = await familyRoster(); break
      // A leaf addressing the root hands it a turn on the message channel the
      // root already uses for its leaves, so awareness runs both directions:
      // the matriarch drives a leaf with 'send', a leaf reaches its matriarch here.
      case 'notify': {
        if (!contextNotify) throw new Error('The matriarch cannot receive messages')
        result = await contextNotify(sourceId, String(value))
        break
      }
      case 'interrupt': result = await interruptLeaf(id); break
      case 'list': result = await listLeaves(); break
      // Reading is served here for the same reason `members` is: the host is the
      // party holding every member's transcript path. It touches no member's
      // process, so a busy sibling is read rather than interrupted.
      case 'read':
        result = await readFamilyTranscript(typeof id === 'string' && id.trim() ? id : undefined, (value ?? {}) as LeafReadOptions)
        break
      // A leaf renamed itself at its own prompt. `sourceId` is the leaf that
      // asked, and `id` is the name it chose: the row that follows is the
      // asker's own, never another member's.
      case 'renamed': await applyLeafRename(root, sourceId, String(id)); break
      // A checkpoint taken from inside a leaf is taken here: the host holds the
      // member's transcript path, and it is the party that can flush the member
      // whose conversation is being copied.
      case 'checkpoint':
        result = describeCheckpoint(await recordLeafCheckpoint(String(id), typeof value === 'string' ? value : undefined, sourceId))
        break
      // Checkpoints belong to the family, not to a window: any member can list,
      // branch, drop or purge them, and none of it needs the family lease.
      case 'checkpoints': result = await listLeafCheckpoints(typeof id === 'string' ? id : undefined); break
      case 'checkpoint-drop': result = await dropLeafCheckpoint(String(id)); break
      case 'checkpoint-purge': result = await purgeLeafCheckpoint(String(id)); break
      // The merge lands in the seed, which is a member of this window, so it is
      // asked here for the same reason a checkpoint is: the host holds the seed's
      // process and the transcript that has to witness the merge.
      case 'merge': result = await mergeSeedling(String(id), (value ?? {}) as { fidelity?: 'full' | 'ledger' }, sourceId); break
      // Compaction runs where the conversation is: the host holds the member's
      // process, not its messages, so the member's own REPL does the work here
      // too, and a leaf asking for it is relayed to this window.
      case 'compact': result = await compactLeaf(String(id), sourceId); break
      case 'model': case 'effort': {
        const view = getLeafViews().find(item => item.member.sessionId === id)
        if (!view) throw new Error('Unknown leaf')
        if (message.action === 'model') await view.process.setModel(value)
        else await view.process.setEffort(value)
        break
      }
      default: throw new Error('Unknown workspace action')
    }
    // The reply is best-effort; the close it asked for is not. A leaf that asked
    // to close the matriarch and then died before the answer was written
    // still asked, and the handoff it requested must not be lost with the
    // channel that would have carried the receipt.
    try { child.terminal({ type: 'leaf-response', id: message.id, ok: true, value: result }) } catch { /* The asker is gone; the close still stands. */ }
    if (pendingMatriarchClose) setTimeout(() => { void finishMatriarchClose() }, 0)
  } catch (error) {
    // A refusal the requester cannot read is a refusal it cannot act on: a bad
    // reference, a busy target and an unavailable matriarch all arrived as the same
    // silent `ok: false`, so the leaf could only report that something failed.
    // The reason travels back with the refusal, single-lined and bounded.
    const reason = error instanceof Error ? error.message.replace(/\s+/g, ' ').trim().slice(0, 300) : ''
    try { child.terminal({ type: 'leaf-response', id: message.id, ok: false, value: reason || undefined }) } catch { /* Closing the originating session needs no reply. */ }
  }
}

/**
 * Which conversation a new leaf copies.
 *
 * Selection is the source of truth: forking one family member while another is
 * on screen silently discarded the one on screen, which is what made "fork
 * this" fork the wrong conversation. With nothing selected the source is the
 * session asking, so a leaf opened on its own opens new leaves from itself
 * rather than from the conversation behind it. `original` forces the family's
 * creator and `patriarch`/`root` force the designated patriarch. Kept pure so the
 * rule is testable without spawning anything.
 */
export function resolveLeafSource(explicit: string | undefined, family: { creator: string; patriarch: string; self: string }, selected: string | undefined): string {
  if (explicit) {
    const ref = explicit.trim().toLowerCase()
    if (ref === 'original') return family.creator
    if (ref === 'patriarch' || ref === 'root') return family.patriarch
    return explicit
  }
  return selected ?? family.self
}

export async function createLeaf(name?: string, parentSessionId?: string, worktree?: string, options: { fresh?: boolean; model?: string; effort?: LeafMember['effort']; requestedBy?: string; role?: 'seed' | 'seedling'; seedOf?: string } = {}): Promise<LeafView> {
  if (isInteractiveLeaf()) {
    // A fork copies this leaf's transcript FILE, and the fork is made by the
    // session hosting the family, which cannot flush another process's storage
    // queue. Land this process's own writes first, or a leaf forks itself from a
    // transcript that is missing the turns it just wrote.
    await flushSessionStorage()
    const member = await requestLeafWorkspace<LeafMember>('create', [name, parentSessionId ?? getSessionId(), worktree, options])
    // The new leaf runs in the session that made it, not here: this process
    // hosts no child of its own, so there is no view to find. Its row is built
    // from the reply instead, which is everything the asking menu reads - the
    // leaf's number and name land in the sentence it reports back.
    return {
      rootSessionId: familyRootSync(), member, draft: member.draft ?? '',
      process: {
        getState: () => getLeafSnapshot()?.members.find(entry => entry.member.sessionId === member.sessionId)?.state ?? 'idle',
        checkpoint: (label?: string) => requestLeafWorkspace('checkpoint', [member.sessionId, label]),
        compact: () => requestLeafWorkspace('compact', [member.sessionId]),
        setModel: (model: string) => requestLeafWorkspace('model', [member.sessionId, model]),
        setEffort: (effort: string) => requestLeafWorkspace('effort', [member.sessionId, effort]),
      },
    }
  }
  const self = getSessionId()
  const root = await familyRootSessionId()
  await requireMatriarch(root)
  // The designation is read here, not only in the roster: a new leaf is created
  // relative to whichever member is the family's patriarch right now.
  await refreshDesignatedPatriarch()
  const resolvedSourceId = resolveLeafSource(parentSessionId, { creator: root, patriarch: getLeafPatriarchSessionId(), self }, selectedLeafId())
  // The session asking is the source when nothing else is named, so its own live
  // conversation is what gets copied - from a member that is that member, which
  // is what makes "open a leaf from the leaf I am in" copy the leaf rather than
  // the conversation behind it.
  const fromSelf = resolvedSourceId === self
  const hosted = views.get(resolvedSourceId)
  const sourceView = !fromSelf && hosted && hosted.rootSessionId === root ? hosted : undefined
  // A source that is not an open leaf is still forkable: any session whose
  // transcript exists on disk can seed a leaf. Refusing it here is what made
  // "fork this session into a leaf" unreliable for anything but a live leaf.
  let source: { sessionId: string; transcriptPath: string } | undefined
  // A checkpoint is the third thing a source can be: not a live member and not a
  // session on disk, but a frozen conversation of its own. It is only consulted
  // when nothing live answers, so a leaf named `auth-split` wins over a
  // checkpoint labelled `auth-split` - the live thing is the one being pointed at.
  let checkpointBranch: LeafCheckpoint | undefined
  if (!fromSelf && !sourceView) {
    const transcriptPath = resolvedSourceId === root
      ? (await leafCreatorMember())?.transcriptPath ?? getTranscriptPathForSession(resolvedSourceId)
      : getTranscriptPathForSession(resolvedSourceId)
    try { await access(transcriptPath); source = { sessionId: resolvedSourceId, transcriptPath } }
    catch {
      checkpointBranch = await findCheckpoint(root, resolvedSourceId)
      if (!checkpointBranch) throw new Error(`No session or open leaf matches ${resolvedSourceId}`)
      source = { sessionId: checkpointBranch.sourceSessionId, transcriptPath: checkpointTranscriptPath(root, checkpointBranch.id) }
    }
  }
  // The member a branch comes from, as a family row. A source this window hosts
  // is `sourceView`; anything else - a closed sibling, a session on disk, or the
  // member a checkpoint was taken from - has no view but is still the member the
  // branch belongs to. Reading its row is what keeps a branch of a leaf named and
  // placed after that leaf instead of after the family's patriarch, and what puts a
  // branch of a checkpoint back in the directory the conversation it branches
  // came from.
  const sourceMember = (await currentFamily()).members.find(member => member.sessionId === (checkpointBranch?.sourceSessionId ?? resolvedSourceId))
  let cwd = sourceView?.member.cwd ?? sourceMember?.cwd ?? getCwd()
  if (worktree) {
    const git = promisify(execFile)
    const options = { timeout: 10000, maxBuffer: 65536, windowsHide: true }
    const source = await git('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], options)
    const target = await git('git', ['-C', resolve(worktree), 'rev-parse', '--path-format=absolute', '--git-common-dir'], options)
    const sourceRoot = await git('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], options)
    const targetRoot = await git('git', ['-C', resolve(worktree), 'rev-parse', '--show-toplevel'], options)
    if (source.stdout.trim() !== target.stdout.trim() || sourceRoot.stdout.trim() === targetRoot.stdout.trim()) throw new Error('Select a separate worktree of the same repository')
    cwd = targetRoot.stdout.trim()
  }
  await flushSessionStorage()
  // A leaf forking itself cannot be checkpointed: its own turn is the one making
  // the request, and a member refuses a checkpoint of a running turn, so asking
  // for one turned "fork this leaf" into an opaque failure. Its transcript was
  // written at its last turn boundary, and a conversation copied as it stood
  // there is all that a mid-turn fork can honestly copy. Asking anything else
  // to checkpoint still goes through: a busy source is a refusal, not a bug.
  const selfFork = sourceView?.member.sessionId === options.requestedBy
  if (sourceView && !options.fresh && !selfFork) await sourceView.process.checkpoint()
  const freshId = randomUUID()
  const fork = options.fresh ? undefined : await createFork(undefined, sourceView ? { sessionId: sourceView.member.sessionId, transcriptPath: sourceView.member.transcriptPath } : source)
  if (getSessionId() !== self) throw new Error('Session changed before leaf creation')
  const member = await addLeafMember(familyPath(root), root, {
    sessionId: fork?.sessionId ?? freshId,
    // A branch of a checkpoint belongs to the member the checkpoint was taken
    // from: the checkpoint is a point in that member's conversation, so the
    // member plus the checkpoint id - on the new member's pointer - is the
    // provenance pair, and the family file keeps its shape.
    parentSessionId: sourceView?.member.sessionId ?? checkpointBranch?.sourceSessionId ?? resolvedSourceId,
    name: name || (options.fresh ? 'New conversation' : sourceView?.member.name || sourceMember?.name || getLeafPatriarchName()),
    transcriptPath: fork?.forkPath ?? join(getProjectDir(cwd), `${freshId}.jsonl`), forkMessageId: fork?.serializedMessages.at(-1)?.uuid ?? null,
    cwd, model: options.model ?? sourceView?.member.model, effort: options.effort ?? sourceView?.member.effort,
  })
  saveSessionName(asSessionId(member.sessionId), `Leaf ${member.number}: ${member.name}`, member.transcriptPath)
  // The new member gets its pointer now, so it can find this family if it is
  // ever resumed on its own.
  void indexLeafMembers(root, [member], {
    ...(checkpointBranch ? { fromCheckpointId: checkpointBranch.id } : {}),
    ...(options.role ? { role: options.role } : {}),
    ...(options.seedOf ? { seedOf: options.seedOf } : {}),
  })
  const launched = launch(member, root)
  const view = await launched.view
  // Entering the member is deferred to the moment its process is listening:
  // the pane can only be drawn once there is a terminal behind it, and the
  // member takes as long to reach its input loop as a cold session does. The
  // row is up either way, so a leaf opened from here no longer holds this
  // session's input shut for the length of that boot.
  void launched.started.then(() => {
    if (familyRootSync() === root && views.has(member.sessionId)) selectLeaf(member.sessionId)
  }, () => {})
  return view
}

/**
 * A seed: a fork of a member kept as the place a merge lands.
 *
 * A seedling is a fork of the seed that does one bounded job and comes back.
 * Merging it injects what it produced into the seed rather than into the
 * conversation the family is actually having, so a short-lived fork cannot
 * rewrite the context that the durable leaf is going to keep working from. In
 * every other way the seed is an ordinary member - listed, read, closed,
 * forked - and its role is only what tells a merge where to land.
 */
export async function createSeed(source?: string, name?: string): Promise<LeafView> {
  const origin = source ? await resolveLeafRef(source) : undefined
  return createLeaf(name ?? (origin ? `${origin.name} seed` : 'Seed'), origin?.sessionId ?? source, undefined, { role: 'seed' })
}

/** A seedling: a bounded fork of a seed, meant to be merged back into it. */
export async function createSeedling(seed: string, name?: string): Promise<LeafView> {
  const target = await resolveLeafRef(seed)
  if (!target) throw new Error(`No open leaf matches ${seed}`)
  // The seed is where the merge will land, and the whole point of a seed is that
  // it is not the conversation the family is keeping - so the target has to be
  // one. Taking any member would let a merge write straight into the durable
  // line the seed exists to insulate, and taking the family's creator would make
  // a seedling no merge can ever reach, since the window holding the family has
  // no process for it.
  const role = await leafMemberRole(target.sessionId)
  if (role.role !== 'seed') throw new Error(`${memberLabel(target)} is not a seed, so a merge would have nowhere to land; /leaf seed ${target.number} makes it one`)
  return createLeaf(name ?? `${target.name} seedling`, target.sessionId, undefined, { role: 'seedling', seedOf: target.sessionId })
}

/** How much of a merged conversation is carried, and how long a merge waits to be witnessed. */
const MERGE_PAYLOAD_CHARS = 12_000
const MERGE_WITNESS_MS = 30_000
const MERGE_POLL_MS = 300
/** The merge id is written at the very end, so a small tail always holds it. */
const MERGE_WITNESS_WINDOW = 256 * 1024

/**
 * What a merge hands the seed, marked with the id that has to come back.
 *
 * The id is not decoration. Delivery only says the seed accepted the message;
 * the turn it becomes runs in the seed's own REPL, which is a different process
 * and writes to its own transcript, so the only proof the merge actually landed
 * is finding the id in that transcript afterwards.
 */
async function mergePayload(from: LeafMember, mergeId: string, fidelity: 'full' | 'ledger'): Promise<string> {
  const header = `Merge ${mergeId} from seedling ${from.name} (${from.sessionId}).`
  if (fidelity === 'ledger') {
    // The ledger is the cheap path: the seedling's own closing report, without
    // the working that produced it. It is what a merge wants when the seedling
    // was a scratch fork whose steps do not matter, only its conclusion. A
    // seedling that compacted itself has no closing prose turn left - its
    // conversation now ends at the summary that replaced it - so the summary is
    // what a ledger carries rather than reporting that nothing was produced.
    // The report is the whole subject of a ledger, so the per-turn cap is lifted
    // to the payload budget: a read that windows many turns wants a digest, but a
    // read carrying one closing report must not hand the seed its first 1200
    // characters and a sentence that stops in the middle.
    const slice = await readTranscriptSlice(from.transcriptPath, from.sessionId, { tail: 6, maxChars: MERGE_PAYLOAD_CHARS, turnChars: MERGE_PAYLOAD_CHARS })
    const turns = [...slice.turns].reverse()
    const report = turns.find(turn => turn.role === 'assistant' && !turn.meta) ?? turns.find(turn => turn.summary)
    return `${header}\nThe seedling's final report follows. Take it as the result of the work and continue.\n\n${report ? report.text : '(the seedling produced no report)'}`
  }
  // Full fidelity carries the seedling's own active chain, so the seed keeps the
  // reasoning and not only the answer. The chain is the same one resume uses, so
  // a branch the seedling abandoned never comes along.
  const slice = await readTranscriptSlice(from.transcriptPath, from.sessionId, { tail: 60, maxChars: MERGE_PAYLOAD_CHARS })
  return `${header}\nThe seedling's conversation follows, ending at its last turn. Take it as the result of the work and continue.\n\n${renderTranscriptSlice(slice, `seedling ${from.name}`)}`
}

/** Wait for the merge id to appear in the seed's transcript, which is the only proof it landed. */
async function witnessMerge(path: string, mergeId: string): Promise<boolean> {
  const deadline = Date.now() + MERGE_WITNESS_MS
  for (;;) {
    const tail = await readFileTail(path, MERGE_WITNESS_WINDOW).catch(() => '')
    if (tail.includes(mergeId)) return true
    if (Date.now() >= deadline) return false
    await new Promise(resolve => setTimeout(resolve, MERGE_POLL_MS))
  }
}

/**
 * Merge a seedling back into the seed it was forked from.
 *
 * The merge is an injected turn, never an edit to a transcript file: a live
 * session's context is its in-memory messages, which it does not re-read, so
 * appending foreign records to its `.jsonl` would leave the conversation
 * unchanged and an orphan branch on disk. The one safe path is the same
 * host-to-leaf delivery every other peer message uses, which is why a merge
 * needs the seed open and idle - a merge is a whole turn's worth of context, not
 * a nudge to slip into one already running.
 */
export async function mergeSeedling(seedling: string, options: { fidelity?: 'full' | 'ledger' } = {}, requester?: string): Promise<string> {
  // Only the window holding the seed's process can hand it a turn, and a leaf
  // holding a family of its own would be a different family - so a leaf asking
  // for a merge is relayed to its host, exactly as its checkpoint is.
  if (isInteractiveLeaf()) return requestLeafWorkspace<string>('merge', [seedling, options])
  const fidelity = options.fidelity ?? 'full'
  const root = await familyRootSessionId()
  await requireMatriarch(root)
  const from = await resolveLeafRef(seedling)
  if (!from) throw new Error(`No open leaf matches ${seedling}`)
  const role = await leafMemberRole(from.sessionId)
  if (role.role !== 'seedling' || !role.seedOf) throw new Error(`${from.name} is not a seedling, so it has no seed to merge into`)
  // A seedling handing itself back is the one merge that can never run: it is
  // the session asking, so it is busy awaiting this answer, and the turn it
  // would hand over is the one it is in the middle of. The seed's own message
  // would blame the seedling's work instead, which is not what is wrong.
  if (requester && from.sessionId === requester) throw new Error(`${from.name} is the session asking: a seedling cannot merge itself. Ask the window holding its seed to run the merge.`)
  const into = views.get(role.seedOf)
  if (!into || into.rootSessionId !== root) {
    // The seed is the member that is missing, so it is the one to name - the
    // seedling is the member the person just addressed.
    const seed = (await listLeafMembers()).find(member => member.sessionId === role.seedOf)
    throw new Error(`The seed ${seed?.name ?? role.seedOf} that ${from.name} was forked from is not open`)
  }
  if (into.process.getState() !== 'idle') throw new Error(`Wait for ${into.member.name} to finish its turn before merging into it`)
  if (!from.transcriptPath) throw new Error(`${from.name} has no transcript to merge`)
  // The seedling's own newest work may still be sitting in its storage queue, so
  // land those writes first - the same reason a fork checkpoints its source.
  const fromView = views.get(from.sessionId)
  if (fromView) {
    if (fromView.process.getState() !== 'idle') throw new Error(`Wait for ${from.name} to finish its turn before merging it`)
    await fromView.process.checkpoint().catch(() => {})
  }
  const mergeId = randomUUID()
  const payload = await mergePayload(from, mergeId, fidelity)
  if (!(await into.process.deliver(payload))) throw new Error(`${into.member.name} dropped the merge without taking it`)
  if (!(await witnessMerge(into.member.transcriptPath, mergeId))) throw new Error(`The merge was handed to ${into.member.name} but never reached its transcript`)
  return `Merged ${from.name} into ${into.member.name} (${fidelity}, merge ${mergeId.slice(0, 8)}).`
}

let matriarchRelease: (() => Promise<void>) | undefined
/**
 * Hold this session's own transcript for the process that is on screen.
 *
 * A member of a family can now be opened from any other member, which means a
 * session that is already live in one window could be started again in another.
 * Two writers on one transcript interleave into it and neither of them is the
 * conversation, so a top-level session claims its own transcript and `launch`
 * collides with that claim. Best-effort: resuming the same session twice is a
 * person's choice, not corruption this can prevent.
 */
async function claimMatriarchOwnership(): Promise<void> {
  if (matriarchRelease) return
  try { matriarchRelease = await lock(`${getTranscriptPath()}.leaf-owner`, { realpath: false, stale: 10000, retries: 0 }) }
  catch { /* Another window already owns this session; it still works. */ }
}

/**
 * Rebuild the in-memory view of this family WITHOUT starting any leaf.
 *
 * `status: 'open'` records what a leaf was doing when we last saw it; it is not
 * an instruction to boot. Launching every open member here is what made leaves
 * reappear as background sessions on every mount and session switch. Leaves now
 * start only when a person opens one, from the menu or `openLeaf`.
 */
export async function restoreLeafWorkspace(): Promise<void> {
  if (isInteractiveLeaf()) return
  const root = await familyRootSessionId()
  const family = await readLeafFamily(familyPath(root), root)
  // A family written before the creator had a row gains one here, on the first
  // touch by any session that opens it.
  const members = await ensureCreatorRow(root, family.members)
  // Reading the designation before re-indexing is what carries a conferral
  // through: the pointers are rewritten with the patriarch the family has now.
  await refreshDesignatedPatriarch()
  // Only the root knows its own transcript path and directory, so only the root
  // writes the pointers its members will read. A member re-indexes with what it
  // read: nothing new, unless the roster grew while it was hosting.
  await indexLeafMembers(root, members)
  await claimMatriarchOwnership()
  // Opening the family is what takes its lease: the session looking at it is
  // the one that manages it, and any window that had it becomes a follower.
  await claimMatriarch(root)
  publish()
}

/**
 * Start a saved leaf on purpose. The only path that creates a leaf process for
 * a member that already exists; requires an explicit reference.
 */
export async function openLeaf(reference: string): Promise<string> {
  const member = await resolveLeafRef(reference)
  if (!member) throw new Error('Unknown or ambiguous leaf reference')
  if (isInteractiveLeaf()) return requestLeafWorkspace<string>('open', [member.sessionId])
  // `changeLeaf` already launches on `status: 'open'`, so asking it to set the
  // status covers both cases: a closed leaf reopens, and an already-open leaf
  // whose process died gets a fresh one. Launching here as well would double it.
  await changeLeaf(member.sessionId, { status: 'open' })
  selectLeaf(member.sessionId)
  return `${memberLabel(member)} opened.`
}

/**
 * Start an archived leaf WITHOUT taking it out of the archive.
 *
 * Filing a leaf away is meant to shorten the family list, not to put it out of
 * reach: a person who needs to look something up in an old leaf should not have
 * to unfile it first. Nothing here writes a status, so the leaf files itself
 * back the moment its process exits - and reviving stays a deliberate choice
 * rather than a side effect of having opened something once.
 */
export async function openLeafOnce(reference: string): Promise<string> {
  const member = await resolveLeafRef(reference)
  if (!member) throw new Error('Unknown or ambiguous leaf reference')
  if (isInteractiveLeaf()) return requestLeafWorkspace<string>('open-once', [member.sessionId])
  const root = familyRootSync()
  await requireMatriarch(root)
  // "Opened" is the claim this returns, and a member another window is already
  // writing is a refusal rather than an opening - so this waits for the member
  // to be up instead of only for its row.
  await launch(member, root).started
  if (familyRootSync() === root) selectLeaf(member.sessionId)
  return `${memberLabel(member)} opened. It stays in the archive; close it and it is filed away again.`
}

/**
 * Put an archived leaf back in the ordinary list without starting it.
 *
 * Reviving is filing, not opening: the leaf returns to the family list and stays
 * closed until someone opens it, which makes "I archived that by mistake" one
 * step to undo instead of a relaunch.
 */
export async function reviveLeaf(reference: string): Promise<string> {
  const member = await resolveLeafRef(reference)
  if (!member) throw new Error('Unknown or ambiguous leaf reference')
  await changeLeaf(member.sessionId, { status: 'closed' })
  return `${memberLabel(member)} is back in the leaf list. It stays closed until you open it.`
}

export async function changeLeaf(sessionId: string, patch: Pick<Partial<LeafMember>, 'name' | 'status'>, requestedBy?: string): Promise<string | undefined> {
  if (isInteractiveLeaf()) {
    // A leaf closing itself is the one close it performs rather than asks for:
    // the process that would be stopped is the one typing, so the leaving runs
    // here and the family's record is written by the session hosting it when
    // this one exits.
    if (sessionId === getSessionId() && patch.status === 'closed') {
      await requestLeafSelfClose()
      return 'Leaving this leaf; its transcript is retained and its place in the family is kept.'
    }
    return requestLeafWorkspace<string | undefined>('change', [sessionId, patch])
  }
  const root = await familyRootSessionId()
  await requireMatriarch(root)
  // A rename of the patriarch renames the family, so the designation is re-read
  // before and after: the name this session publishes is never a stale one.
  await refreshDesignatedPatriarch()
  const self = getSessionId()
  const view = views.get(sessionId)
  // Closing the matriarch is the one close that hands the family on rather than
  // stopping a process: the terminal this session holds is the one the family
  // runs on. It is the same door for a leaf asking for that terminal and for
  // this session asking to close itself, and the asker's id is the difference -
  // `closeMatriarch` reads it to tell a refusal from a departure.
  if (sessionId === self && patch.status === 'closed') {
    const result = await closeMatriarch(requestedBy)
    // The reply is owed before the terminal changes hands. A leaf's request is
    // answered by `handleLeafRequest`; this session's own is answered here, so
    // the handoff is deferred past it.
    if (!requestedBy && pendingMatriarchClose) setTimeout(() => { void finishMatriarchClose() }, 0)
    return result
  }
  // Only the session that ASKED is refused, and only for itself: it is the
  // conversation being typed into, and closing it is leaving it - there is no
  // process to stop from inside the request that is asking. Every other member is
  // ordinary, so a leaf may close the matriarch it belongs to and the matriarch
  // may close any of its leaves. `requestedBy` is the leaf behind a request,
  // because a leaf asks through the session hosting its family - and that
  // session is usually the very member the leaf is trying to close, so comparing
  // the target with this process refused every one of them.
  //
  // Leaving is not a refusal to be worked around: it is the other door to the
  // same outcome. The family hands itself to the next member in line here when
  // any member leaves, and from `registerCleanup` and `onExit` when the session
  // that leaves is this one.
  if (sessionId === (requestedBy ?? self)) throw new Error('That is the session you are in; it ends when you leave it, and the family passes to the next member then')
  if (view && view.rootSessionId !== root) throw new Error('Leaf belongs to another family')
  if (patch.status === 'promoted' && view && view.process.getState() !== 'idle') throw new Error('Wait for the leaf turn before promoting')
  if (patch.name && view && !['closed', 'failed'].includes(view.process.getState()) && (!patch.status || patch.status === 'open')) {
    const name = patch.name.trim()
    if (!name || name.length > 200) throw new Error('Name must contain 1–200 characters')
    await view.process.checkpoint(`Leaf ${view.member.number}: ${name}`)
    view.member = await updateLeafMember(familyPath(root), root, sessionId, { name })
    await refreshDesignatedPatriarch()
    publish()
    return
  }
  if (patch.status && patch.status !== 'open' && view) {
    // A member's row exists before the member is listening, so the close a
    // person types straight after making a leaf arrives while its CLI is still
    // booting. Waiting for the launch here is what makes that close land on the
    // member it names: without it the close has no channel to ask, and a member
    // that cannot be asked is left running while the roster calls it closed -
    // the one outcome a close must never produce. A launch that failed has
    // nothing to wait for and nothing to stop, which is the same shape a reopen
    // takes.
    await launches.get(sessionId)?.started.catch(() => {})
    await saveLeafDraft(view)
    await view.process.close()
    await ownerReleases.get(sessionId)?.()
    ownerReleases.delete(sessionId)
  }
  const { claimGatewaySessionWriter, releaseGatewaySessionWriter } = await import('./gatewaySessionOwnership.js')
  const exclusive = Boolean(patch.name) || patch.status === 'promoted'
  if (exclusive) await claimGatewaySessionWriter(sessionId)
  let member: LeafMember
  try {
    member = await updateLeafMember(familyPath(root), root, sessionId, patch)
    if (patch.name || patch.status === 'promoted') saveSessionName(asSessionId(sessionId), member.status === 'promoted' ? member.name : `Leaf ${member.number}: ${member.name}`, member.transcriptPath)
  } finally {
    if (exclusive) await releaseGatewaySessionWriter(sessionId)
  }
  if (view) view.member = member
  if (patch.status && patch.status !== 'open') {
    views.delete(sessionId)
    if (selected.get(self) === sessionId) selected.delete(self)
  }
  // A reopen is asked for by reference, so a member another window already has
  // is a refusal this call owes the person who typed it: await the start.
  if (patch.status === 'open') await launch(member, root).started
  // A member leaving is the only thing that moves the designation, and it moves
  // it before this call publishes - so the family is never briefly named after a
  // member that has just gone.
  const promoted = patch.status === 'closed' || patch.status === 'archived' ? await promoteNextPatriarch(root, sessionId) : undefined
  await refreshDesignatedPatriarch()
  publish()
  return promoted ? `${memberLabel(promoted)} is now the family patriarch.` : undefined
}

/**
 * Close the session that holds the family's terminal, handing it to a successor.
 *
 * The matriarch is not the patriarch: one is whichever session is actually
 * holding this terminal, the other is the lineage's designation. Closing the
 * matriarch used to mean the family lost its terminal - the conversation ended,
 * the leaves kept running with nobody driving them, and the next launch found a
 * family whose patriarch was a session that no longer existed. Here the
 * successor's conversation is resumed into this very process, so the terminal,
 * the writer claim, the matriarch lease and the leaves all move together.
 *
 * A leaf reaches this by asking to close the matriarch; the matriarch reaches
 * it by asking to close itself. The asker's id is what tells the two apart, and
 * only a leaf's request is refused when there is no successor - a session
 * leaving itself is leaving, not asking for a terminal nobody can give it.
 */
async function closeMatriarch(requestedBy?: string): Promise<string | undefined> {
  if (closingMatriarch) return closingMatriarch
  closingMatriarch = (async () => {
    if (!matriarchHandoff) throw new Error('Matriarch handoff is unavailable')
    const self = getSessionId()
    const root = await familyRootSessionId()
    const members = await ensureCreatorRow(root, (await currentFamily()).members)
    const next = members.filter(member => member.sessionId !== self && member.status === 'open' &&
      views.get(member.sessionId)?.rootSessionId === root &&
      isLeafProcessAlive(views.get(member.sessionId)!.process.getState()))
      .sort((a, b) => a.number - b.number)[0]
    // A leaf asking for a handoff there is nobody to give it is a refusal: it
    // asked for the terminal, and ending this session instead would leave the
    // asker with no family at all.
    if (!next && requestedBy) throw new Error('No live leaf to take the matriarch; open one first')
    // This session leaving with no leaf to take the family is not a refusal but
    // the end of its terminal: it leaves the way Ctrl-C leaves, and the family
    // keeps its leaves and its files.
    if (!next) {
      const leave = matriarchHandoff.exit
      pendingMatriarchClose = async () => { await leave() }
      return 'Leaving this session; the family keeps its leaves and its files.'
    }
    await matriarchHandoff.prepare()
    const successor = views.get(next.sessionId)!
    if (successor.process.getState() !== 'idle') throw new Error('Wait for the next leaf turn before closing the matriarch')
    await saveLeafDraft(successor)
    await successor.process.checkpoint()
    const handler = matriarchHandoff
    // Deferred past the reply so the leaf is told its request was accepted before
    // the terminal it asked about changes hands. `handleLeafRequest` runs this
    // once the response has been written.
    pendingMatriarchClose = async () => {
      retiringMembers.add(next.sessionId)
      try {
        selectLeaf()
        await successor.process.close()
        views.delete(next.sessionId)
        await matriarchRelease?.()
        matriarchRelease = undefined
        await handler.resume({ ...next, draft: successor.draft })
        if (getSessionId() !== next.sessionId) throw new Error('Successor did not take the session terminal')
        await updateLeafMember(familyPath(root), root, self, { status: 'closed' })
        // As in promoteNextPatriarch: `self` was filed `closed` on the line above,
        // so the moving question is asked of the pointer, not of who can act.
        if (await designatedPatriarchSessionId(root) === self) await writePatriarchDesignation(root, next.sessionId, self)
        matriarchState = undefined
        forgetLeafFamilyRoot()
        await restoreLeafWorkspace()
        publish()
      } catch (error) {
        // The terminal never moved, so this session is still the matriarch and has
        // to go on being one: the successor it closed is started again rather
        // than left as a member with no process behind it.
        if (getSessionId() === self) {
          await claimMatriarchOwnership()
          await launch(next, root).started
        }
        throw error
      } finally {
        retiringMembers.delete(next.sessionId)
        closingMatriarch = undefined
      }
    }
    return `${memberLabel(next)} will take the matriarch's terminal.`
  })().catch(error => { closingMatriarch = undefined; throw error })
  return closingMatriarch
}

async function finishMatriarchClose(): Promise<void> {
  const finish = pendingMatriarchClose
  pendingMatriarchClose = undefined
  if (!finish) return
  try { await finish() }
  catch (error) {
    const { logError } = await import('./log.js')
    logError(error instanceof Error ? error : new Error(String(error)))
  }
}

/**
 * Write a member's new name where the whole family reads it.
 *
 * One implementation for both directions of the report: a leaf sends the name
 * to the session hosting its family, and that session - or a session hosting
 * its own - lands here. The designation is re-read because the member that was
 * just renamed may be the patriarch, and the patriarch's name is the family's name.
 */
async function applyLeafRename(root: string, sessionId: string, name: string): Promise<void> {
  const member = await updateLeafMember(familyPath(root), root, sessionId, { name })
  const view = views.get(sessionId)
  if (view) view.member = member
  await refreshDesignatedPatriarch()
  publish()
}

/**
 * Carry a name typed at the prompt into the family.
 *
 * A rename writes the new name to the session's own transcript and nothing
 * else, but everything the family calls a member by - the carousel label, the
 * roster, and the label a relaunched child is opened with - comes from the
 * member row. A rename that stops at the transcript therefore reopens under the
 * name the member had before. A leaf reports the rename to the session hosting
 * its family; a session that hosts its own family writes its row directly.
 *
 * Best-effort by construction, and never a rejection: the transcript already
 * holds the new name, so a family that cannot be reached must not turn a
 * successful rename into a failed one. The member's native title is deliberately
 * left alone - it is the name that was just chosen, not one to decorate.
 */
export async function reportSessionRename(name: string): Promise<void> {
  const trimmed = name.trim()
  if (!trimmed || trimmed.length > 200) return
  try {
    if (isInteractiveLeaf()) { await requestLeafWorkspace('renamed', [trimmed]); return }
    await applyLeafRename(await familyRootSessionId(), getSessionId(), trimmed)
  } catch { /* The transcript is the record; the family was not reachable. */ }
}

export async function fileLeaf(sessionId: string, tag: string): Promise<string | undefined> {
  if (isInteractiveLeaf()) return requestLeafWorkspace<string | undefined>('file', [sessionId, tag])
  const { recursivelySanitizeUnicode } = await import('./sanitization.js')
  const normalized = recursivelySanitizeUnicode(tag).trim()
  if (!normalized || normalized.length > 200) throw new Error('Tag must contain 1–200 characters')
  const root = await familyRootSessionId()
  await requireMatriarch(root)
  const family = await readLeafFamily(familyPath(root), root)
  const member = family.members.find(item => item.sessionId === sessionId)
  if (!member) throw new Error('Unknown leaf')
  const view = getLeafViews().find(item => item.member.sessionId === sessionId)
  if (view && view.process.getState() !== 'idle') throw new Error('Wait for the leaf turn before filing')
  // Filing closes the member, so a filed patriarch hands the family on like any
  // other departure; the sentence comes back to whoever asked for the file.
  const promoted = view ? await changeLeaf(sessionId, { status: 'closed' }) : undefined
  const { claimGatewaySessionWriter, releaseGatewaySessionWriter } = await import('./gatewaySessionOwnership.js')
  const { saveTag } = await import('./sessionStorage.js')
  let claimed = false
  let filed = false
  let canReopen = false
  try {
    await claimGatewaySessionWriter(sessionId)
    claimed = true
    canReopen = true
    await saveTag(sessionId as import('node:crypto').UUID, normalized, member.transcriptPath)
    filed = true
  } finally {
    try {
      if (claimed) await releaseGatewaySessionWriter(sessionId)
    } finally {
      if (!filed && view) {
        if (canReopen) await changeLeaf(sessionId, { status: 'open' })
        else await updateLeafMember(familyPath(root), root, sessionId, { status: 'open' })
      }
    }
  }
  return promoted
}

/**
 * Make another member the family's patriarch.
 *
 * The designation is organizational: the family file keeps the name and the
 * history it was born with, and the member that becomes the patriarch is an
 * ordinary row either way. What moves is which member the family is named
 * after, which member `patriarch` and `root` resolve to, and which session title
 * reads as the family rather than as a leaf of it.
 *
 * Refused for the member that is already the patriarch, for a reference that is
 * not in this family, and for a target whose turn is in flight: both titles are
 * rewritten, so a member mid-turn is left to finish first. A member that is
 * merely running is not a refusal - being up is the ordinary state of a leaf
 * you would want to name the family after. Nothing about numbering or
 * context-return receipts changes - a confer the title on creates no member and
 * invalidates no dedupe.
 */
export async function conferPatriarch(sessionId: string): Promise<string> {
  if (isInteractiveLeaf()) return requestLeafWorkspace<string>('patriarch', [sessionId])
  const root = await familyRootSessionId()
  await requireMatriarch(root)
  const members = await ensureCreatorRow(root, (await readLeafFamily(familyPath(root), root)).members)
  const target = members.find(member => member.sessionId === sessionId)
  if (!target) throw new Error('Unknown leaf')
  const current = await familyPatriarchMember(members, root)
  if (!current) throw new Error('The family patriarch is unavailable')
  if (current.sessionId === target.sessionId) throw new Error(`${memberLabel(target)} is already the family patriarch`)
  const view = views.get(target.sessionId)
  if (view && !['idle', 'closed', 'failed'].includes(view.process.getState())) throw new Error('Wait for the leaf turn before conferring the title')
  // Only the displayed titles move; the rows keep the names they were given.
  // The new patriarch's title becomes its bare name, which is what makes the
  // family read as that conversation; the old patriarch takes the leaf naming
  // every other member already uses.
  //
  // A title is an append to the target's transcript, and a running session holds
  // that transcript's writer lock for as long as it lives - so claiming it first
  // refused every conferral of a leaf that is up, which is the ordinary case and
  // the whole point of designating one. The append is what the leaf does to
  // itself, and two appends do not corrupt a transcript, so nothing is claimed
  // here. What a conferral must not do is rewrite a title while the member it is
  // renaming is mid-turn, and that is the check above.
  saveSessionName(asSessionId(target.sessionId), target.name, target.transcriptPath)
  saveSessionName(asSessionId(current.sessionId), `Leaf ${current.number}: ${current.name}`, current.transcriptPath)
  await writePatriarchDesignation(root, target.sessionId, current.sessionId)
  // Every pointer is rewritten with the patriarch the family has now, so a leaf
  // resumed on its own later reads the family it actually belongs to.
  await indexLeafMembers(root, members)
  await refreshDesignatedPatriarch()
  publish()
  return `${memberLabel(target)} is now the family patriarch; ${memberLabel(current)} is a leaf of it.`
}

/**
 * Name the member the family is raising to be its next patriarch.
 *
 * A designation, like the patriarch's: it changes what the family says a member
 * IS, not what the member does, so the member stays an ordinary leaf and keeps
 * its name and its turn. It is singular - one heir at a time - and it is written
 * where the patriarch designation is written, so every member reads the same
 * one and a reader that does not know about heirs ignores it.
 *
 * Refused for the member that is already the patriarch, for a reference that is
 * not in this family, and for a target whose turn is in flight: raising an heir
 * is a conversation the person holds with that member through the matriarch, and
 * a member mid-turn is left to finish first. A member that is merely running is
 * not a refusal - being up is the ordinary state of a member you would raise.
 *
 * A member cannot name itself: the write runs on the matriarch, and a member
 * that asks is always mid-turn - it is running this very command - so the
 * turn check above refuses it. The lease gate (`requireMatriarch`) is about
 * which window manages the family; the turn check is what a self-naming member
 * actually hits, and it is what makes self-naming unreachable in practice.
 */
export async function conferHeir(sessionId: string): Promise<string> {
  if (isInteractiveLeaf()) return requestLeafWorkspace<string>('heir', [sessionId])
  const root = await familyRootSessionId()
  await requireMatriarch(root)
  const members = await ensureCreatorRow(root, (await readLeafFamily(familyPath(root), root)).members)
  const target = members.find(member => member.sessionId === sessionId)
  if (!target) throw new Error('Unknown leaf')
  const patriarch = await familyPatriarchMember(members, root)
  if (patriarch?.sessionId === target.sessionId) throw new Error(`${memberLabel(target)} is already the family patriarch`)
  const current = await readLeafFamilyPointer(root)
  if (current?.heirSessionId === target.sessionId) throw new Error(`${memberLabel(target)} is already the family heir`)
  const view = views.get(target.sessionId)
  if (view && !['idle', 'closed', 'failed'].includes(view.process.getState())) throw new Error('Wait for the leaf turn before naming it the heir')
  // The title is not rewritten: raising an heir is not renaming the family. Only
  // the designation moves, in the same pointer the patriarch's lives in.
  const base = current?.rootSessionId === root ? current : rootPointerInfo(root)
  await writeLeafFamilyPointer(root, { ...base, heirSessionId: target.sessionId })
  // Every pointer is rewritten with the heir the family has now, so a leaf
  // resumed on its own later reads the family it actually belongs to.
  await indexLeafMembers(root, members)
  await refreshDesignatedPatriarch()
  publish()
  return `${memberLabel(target)} is now the family heir.`
}

export async function setLeafGoal(sessionId: string, args: string): Promise<string> {
  if (isInteractiveLeaf()) return requestLeafWorkspace('goal', [sessionId, args])
  const { parsePersistArgs } = await import('../skills/bundled/persist.js')
  const { readPersistSessionRecord, writePersistSessionRecord } = await import('./sessionStorage.js')
  const parsed = parsePersistArgs(args)
  if (parsed.kind === 'error') throw new Error(parsed.message)
  const root = await familyRootSessionId()
  await requireMatriarch(root)
  const family = await readLeafFamily(familyPath(root), root)
  const member = family.members.find(item => item.sessionId === sessionId)
  if (!member) throw new Error('Unknown leaf')
  if (parsed.kind === 'status') {
    const record = await readPersistSessionRecord(member.transcriptPath)
    return record ? `${record.status}: ${record.task}` : 'No saved leaf goal.'
  }
  const view = getLeafViews().find(item => item.member.sessionId === sessionId)
  if (!view || view.process.getState() !== 'idle') throw new Error('Leaf must be open and idle')
  await changeLeaf(sessionId, { status: 'closed' })
  const { claimGatewaySessionWriter, releaseGatewaySessionWriter } = await import('./gatewaySessionOwnership.js')
  let claimed = false
  try {
    await claimGatewaySessionWriter(sessionId)
    claimed = true
    const previous = await readPersistSessionRecord(member.transcriptPath)
    if (parsed.kind === 'task') {
      await writePersistSessionRecord({ version: 1, task: parsed.options.task, mode: parsed.options.mode, keep: parsed.options.keep, taskMode: parsed.options.taskMode, nudgesRemaining: parsed.options.nudges, nudgesSent: 0, status: 'active', initialPlanningResponseAllowed: parsed.options.mode === 'plan' }, member.transcriptPath)
    } else {
      if (!previous) throw new Error('No saved leaf goal')
      if (parsed.kind === 'resume' && (previous.status === 'completed' || previous.status === 'cleared')) throw new Error('Create a new goal instead of resuming a finished goal')
      await writePersistSessionRecord({ ...previous, status: parsed.kind === 'pause' ? 'paused' : parsed.kind === 'resume' ? 'active' : parsed.kind === 'complete' ? 'completed' : 'cleared' }, member.transcriptPath)
    }
  } finally {
    try {
      if (claimed) await releaseGatewaySessionWriter(sessionId)
    } finally {
      if (claimed) await changeLeaf(sessionId, { status: 'open' })
      else await updateLeafMember(familyPath(root), root, sessionId, { status: 'open' })
    }
  }
  return 'Leaf goal saved; the same leaf was reopened with its draft and transcript retained.'
}

export async function saveLeafSettings(sessionId: string, patch: Pick<Partial<LeafMember>, 'model' | 'effort'>): Promise<void> {
  if (isInteractiveLeaf()) return requestLeafWorkspace('settings', [sessionId, patch])
  const view = views.get(sessionId)
  if (!view) throw new Error('Unknown leaf')
  view.member = await updateLeafMember(familyPath(view.rootSessionId), view.rootSessionId, sessionId, patch)
  publish()
}

export async function saveLeafDraft(view: LeafView): Promise<void> {
  const owned = views.get(view.member.sessionId)
  // A member that has not connected yet has nothing to ask, and reaching for its
  // channel anyway is what failed a close with "Leaf terminal is not running"
  // while the leaf was still booting: `starting` passes a state check, but every
  // control needs a channel that does not exist yet. The draft in the roster is
  // already this member's draft, so skipping the sync loses nothing.
  if (owned && owned.process.canReceive()) await owned.process.syncDraft()
  view.member = await updateLeafMember(familyPath(view.rootSessionId), view.rootSessionId, view.member.sessionId, { draft: view.draft })
}

registerCleanup(async () => {
  // This session leaving takes the leaves it owns with it. A leaf belongs to the
  // session holding the family's terminal, so a session that crashes, is
  // Ctrl-C'd, or whose terminal closes must not leave them running with nobody
  // driving the family - the family passes to the next member on the paths that
  // leave deliberately, and this is the path where there is no next member to
  // hand to. Losing a watching session is still not this: that is a detach on
  // the leaf's own channel, and the leaf carries on.
  await Promise.all([...views.values()].map(async view => {
    try { await saveLeafDraft(view) } catch { /* The member may already be gone. */ }
    await view.process.close().catch(() => {})
  }))
  // Release the claims this session took, so what it was holding can be picked
  // up straight away instead of waiting for the lock to go stale.
  for (const release of [...ownerReleases.values()]) await release().catch(() => {})
  ownerReleases.clear()
  await matriarchRelease?.().catch(() => {})
})
