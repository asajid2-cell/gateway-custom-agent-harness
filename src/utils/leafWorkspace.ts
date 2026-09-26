import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getSessionId, getSessionResumeDirectory } from '../bootstrap/state.js'
import { asSessionId } from '../types/ids.js'
import { getCwd } from './cwd.js'
import { checkHasTrustDialogAccepted } from './config.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { createFork } from '../commands/branch/branch.js'
import { flushSessionStorage, getCurrentSessionTitle, getProjectDir, getTranscriptPath, getTranscriptPathForSession, saveSessionName } from './sessionStorage.js'
import { addLeafMember, readLeafFamily, resolveLeafMember, updateLeafMember, type LeafFamily, type LeafMember } from './leafFamily.js'
import { LeafProcess, isLeafProcessAlive } from './leafProcess.js'
import { LeafTakenError } from './leafChannel.js'
import { leafColorEnv } from './leafColor.js'
import { registerCleanup } from './cleanupRegistry.js'
import { lock } from './lockfile.js'
import { getLeafSnapshot, isInteractiveLeaf, requestLeafWorkspace, subscribeLeafSnapshot, type LeafTerminalMessage } from './leafTerminal.js'
import { focusLeafTerminal, renderLeafTerminal } from './leafTerminalHost.js'
import { LEAF_PEER_PROMPT_PREFIX } from './gatewaySessionProtocol.js'

export type LeafView = { rootSessionId: string; member: LeafMember; process: Pick<LeafProcess, 'getState' | 'checkpoint' | 'setModel' | 'setEffort'>; draft: string }
type OwnedLeafView = LeafView & { process: LeafProcess }
const views = new Map<string, OwnedLeafView>()
const ownerReleases = new Map<string, () => Promise<void>>()
const listeners = new Set<() => void>()
const selected = new Map<string, string>()
const launches = new Map<string, Promise<OwnedLeafView>>()
export function selectedLeafId(): string | undefined { return isInteractiveLeaf() ? getSessionId() : selected.get(getSessionId()) }
export function getLeafRootName(): string {
  const snapshot = getLeafSnapshot()
  if (snapshot) return snapshot.rootName
  if (familyRootSync() === getSessionId()) return getCurrentSessionTitle(getSessionId()) || 'Original'
  return resolvedRoot?.pointer?.rootName || 'Original'
}

/**
 * The label for the session on screen, which is the carousel's first entry.
 *
 * Usually that is the family root, but a member hosting the family after its
 * parent was closed is its own first entry - labelling it with the root's name
 * would offer a switch to the session you are already in.
 */
export function getLeafHostName(): string {
  const snapshot = getLeafSnapshot()
  if (snapshot) return snapshot.rootName
  if (familyRootSync() === getSessionId()) return getLeafRootName()
  return getCurrentSessionTitle(getSessionId()) || 'This session'
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
let contextReturn: ((id: string, text: string) => Promise<string>) | undefined
export function registerLeafContextReturn(handler: (id: string, text: string) => Promise<string>): () => void {
  contextReturn = handler
  return () => { if (contextReturn === handler) contextReturn = undefined }
}
let contextNotify: ((id: string, text: string) => Promise<string>) | undefined
/** Register how the original session receives a message from one of its leaves. */
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
  const snapshot = { rootSessionId: root, rootName: getLeafRootName(), members: getLeafViews().map(view => ({ member: view.member, state: view.process.getState() })) }
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
    process: { getState: () => state, checkpoint: (name?: string) => requestLeafWorkspace('checkpoint', [member.sessionId, name]), setModel: (model: string) => requestLeafWorkspace('model', [member.sessionId, model]), setEffort: (effort: string) => requestLeafWorkspace('effort', [member.sessionId, effort]) },
  }))
  const root = familyRootSync()
  // The parent session can be hosted as a child of one of its own leaves, but it
  // is the family's root rather than one of its leaves: it is the carousel's
  // first entry, not an entry in the list of leaves.
  return [...views.values()].filter(view => view.rootSessionId === root && view.member.number > 0)
}

/**
 * The sessions the carousel can switch to: the leaves, plus the parent when a
 * member is hosting it. Kept apart from `getLeafViews`, which is also the roster
 * published to children - a leaf has no parent row to offer.
 */
export function getLeafCarouselViews(): LeafView[] {
  const parent = views.get(familyRootSync())
  return parent ? [parent, ...getLeafViews()] : getLeafViews()
}

/**
 * A member's pointer back to the family it belongs to.
 *
 * The family file is named after the root's session id, and until now the only
 * way to learn that id was to be started by the session that owns it. That made
 * membership depend on the parent being up: a leaf resumed on its own was an
 * orphan with an empty family, and closing the parent closed the family. Each
 * member now carries its own pointer, written by the root's process (the only
 * one that knows its transcript path and directory), so any member can find the
 * family and reopen the rest of it - including the parent.
 */
type LeafFamilyPointer = { rootSessionId: string; rootName?: string; rootTranscriptPath?: string; rootCwd?: string }
let resolvedRoot: { forSession: string; sessionId: string; pointer?: LeafFamilyPointer } | undefined

function familyPath(root: string): string { return join(getClaudeConfigHomeDir(), 'leaf-families', `${root}.json`) }
function familyIndexDir(): string { return join(getClaudeConfigHomeDir(), 'leaf-families', 'index') }
function familyPointerPath(sessionId: string): string { return join(familyIndexDir(), `${sessionId}.json`) }

async function readLeafFamilyPointer(sessionId: string): Promise<LeafFamilyPointer | undefined> {
  try {
    const parsed = JSON.parse(await readFile(familyPointerPath(sessionId), 'utf8')) as LeafFamilyPointer
    return parsed && typeof parsed.rootSessionId === 'string' ? parsed : undefined
  } catch { return undefined }
}

/** Written like the family file itself: temp file, then a rename that Windows may refuse while a reader holds the target. */
async function writeLeafFamilyPointer(sessionId: string, pointer: LeafFamilyPointer): Promise<void> {
  await mkdir(familyIndexDir(), { recursive: true, mode: 0o700 })
  const target = familyPointerPath(sessionId)
  const temporary = `${target}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(pointer), { mode: 0o600 })
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

/** What a member needs to find the family, and to open its parent again. */
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
 * Record which family each member belongs to, so membership outlives the parent
 * process that created it. Failures are swallowed: a pointer that cannot be
 * written costs a member its standalone discovery, never the family it is
 * already in.
 */
function indexLeafMembers(root: string, members: readonly LeafMember[]): Promise<void> {
  const pointer = rootPointerInfo(root)
  return Promise.all(members.map(member => writeLeafFamilyPointer(member.sessionId, pointer).catch(() => {}))).then(() => {})
}

/**
 * The session that owns this family's file and children.
 *
 * At the root this is the session itself. For a member - a leaf resumed on its
 * own, or one hosting the family after its parent was closed - it is the root
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

/** Test seam: drop the cached resolution so a pointer written afterwards is read. */
export function forgetLeafFamilyRoot(): void { resolvedRoot = undefined }

/**
 * The family's parent session as a member row, when this session is not it.
 *
 * The parent is a member of its own family in every sense that matters - it can
 * be listed, opened, closed and messaged - but it has no entry in the family
 * file, which is keyed by its id: recording it as a member of itself would be a
 * cycle. It is synthesized here from the pointer its own process wrote.
 */
export async function leafParentMember(): Promise<LeafMember | undefined> {
  const root = await familyRootSessionId()
  if (root === getSessionId()) return undefined
  const pointer = resolvedRoot?.pointer
  return {
    sessionId: root,
    parentSessionId: root,
    number: 0,
    name: pointer?.rootName || 'Original',
    transcriptPath: pointer?.rootTranscriptPath ?? getTranscriptPathForSession(root),
    forkMessageId: null,
    createdAt: new Date(0).toISOString(),
    status: 'open',
    ...(pointer?.rootCwd ? { cwd: pointer.rootCwd } : {}),
  }
}

/** Whether the parent session is currently hosted here, so the menu can offer to close it. */
export function leafParentIsOpen(): boolean {
  const view = views.get(familyRootSync())
  return Boolean(view && isLeafProcessAlive(view.process.getState()))
}

/** How a member is named in a result or an error, where number 0 is the parent. */
function memberLabel(member: LeafMember): string {
  return member.number === 0 ? `the parent session ${member.name}` : `Leaf #${member.number} ${member.name}`
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
  const self = getSessionId()
  // A member reading its family is looking for the others: itself is the session
  // already on screen, and offering it as a target would start a second copy of
  // the conversation you are in.
  return (await currentFamily()).members.filter(member => member.sessionId !== self)
}

/**
 * Resolve a leaf reference (session ID, number, `N:name`, or name) against the
 * current family. Deterministic and side-effect free, so callers never need an
 * agent turn to locate a leaf.
 */
export async function resolveLeafRef(reference: string): Promise<LeafMember | undefined> {
  // `original`/`root`/`parent` name the conversation the family was forked from.
  // At the root that is the session asking, which is not a target; from inside a
  // member it is the parent session, which is.
  if (rootReference(reference)) return leafParentMember()
  return resolveLeafMember(await listLeafMembers(), reference)
}

/** Names every member can use for the conversation the family was forked from. */
export function rootReference(reference: string): boolean {
  const ref = reference.trim().toLowerCase()
  return ref === 'original' || ref === 'root' || ref === 'parent'
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
 * parent and its siblings and the original can address any leaf.
 */
export async function familyRoster(): Promise<string> {
  const members = await listLeafMembers()
  const root = getLeafRootSessionId()
  const states = new Map(getLeafViews().map(view => [view.member.sessionId, view.process.getState()]))
  const lines = [`root ${getLeafRootName()} [${root === getSessionId() ? 'this session' : 'parent'}] ${root}`]
  for (const member of members) {
    const state = states.get(member.sessionId) ?? member.status
    const settings = [member.model ? `model ${member.model}` : '', member.effort ? `effort ${member.effort}` : ''].filter(Boolean).join(' ')
    lines.push(`#${member.number} ${member.name} [${state}] ${member.sessionId}${settings ? ` ${settings}` : ''}`)
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

export const LEAF_EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode'] as const

async function requireLeafView(reference: string): Promise<{ member: LeafMember; view: OwnedLeafView }> {
  const member = await resolveLeafRef(reference)
  if (!member) throw new Error('Unknown or ambiguous leaf reference')
  const root = familyRootSync()
  let view = views.get(member.sessionId)
  if (view && view.rootSessionId !== root) view = undefined
  if (!view || !isLeafProcessAlive(view.process.getState())) {
    if (member.status !== 'open') throw new Error(`${memberLabel(member)} is ${member.status}`)
    view = await launch(member, root)
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

/** Hand a leaf a turn. Runs in the leaf's own REPL; the parent stays put. */
export async function sendLeafMessage(reference: string, text: string, origin?: LeafSendOrigin): Promise<string> {
  const message = text.trim()
  if (!message) throw new Error('Message required')
  if (message.length > 64000) throw new Error('Message too large')
  // A leaf naming its parent reaches the parent's conversation, not a sibling.
  if (isInteractiveLeaf() && rootReference(reference)) return notifyLeafParent(message)
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

export async function checkpointLeaf(reference: string, name?: string): Promise<string> {
  if (isInteractiveLeaf()) {
    const member = await resolveLeafRef(reference)
    if (!member) throw new Error('Unknown or ambiguous leaf reference')
    return requestLeafWorkspace<string>('checkpoint', [member.sessionId, name])
  }
  const { member, view } = await requireLeafView(reference)
  await view.process.checkpoint(name)
  return `Checkpointed ${memberLabel(member)}.`
}

export async function configureLeaf(reference: string, patch: { model?: string; effort?: string }): Promise<string> {
  if (patch.effort !== undefined && !(LEAF_EFFORT_LEVELS as readonly string[]).includes(patch.effort)) throw new Error('Invalid effort')
  if (patch.model === undefined && patch.effort === undefined) throw new Error('Model or effort required')
  if (isInteractiveLeaf()) {
    const member = await resolveLeafRef(reference)
    if (!member) throw new Error('Unknown or ambiguous leaf reference')
    return requestLeafWorkspace<string>('configure', [member.sessionId, patch])
  }
  const { member, view } = await requireLeafView(reference)
  if (view.process.getState() !== 'idle') throw new Error('Leaf must be idle before its settings change')
  if (patch.model !== undefined) await view.process.setModel(patch.model)
  if (patch.effort !== undefined) await view.process.setEffort(patch.effort)
  await saveLeafSettings(member.sessionId, patch.model !== undefined ? { model: patch.model } : { effort: patch.effort as LeafMember['effort'] })
  const applied = patch.model !== undefined ? `model ${patch.model}` : `effort ${patch.effort}`
  // The parent has no family entry to store settings in, so nothing survives a
  // restart of it - say so rather than promising a restart it cannot honour.
  return member.number === 0
    ? `${memberLabel(member)} ${applied} updated for this run.`
    : `${memberLabel(member)} ${applied} updated and saved for restart.`
}

/**
 * Hand the original session a turn from inside a leaf. Symmetric with
 * `sendLeafMessage`: the parent can drive a leaf, and a leaf can report back to
 * the parent without waiting for the human to copy anything across.
 */
export async function notifyLeafParent(text: string): Promise<string> {
  const message = text.trim()
  if (!message) throw new Error('Message required')
  if (message.length > 64000) throw new Error('Message too large')
  if (!isInteractiveLeaf()) throw new Error('Only a leaf can message its parent')
  return requestLeafWorkspace<string>('notify', [getSessionId(), message])
}

/** Pull selected context from a leaf into the original session transcript. */
export async function returnLeafContext(reference: string, text: string): Promise<string> {
  const member = await resolveLeafRef(reference)
  if (!member) throw new Error('Unknown or ambiguous leaf reference')
  if (isInteractiveLeaf()) return requestLeafWorkspace<string>('return', [member.sessionId, text])
  if (!contextReturn) throw new Error('Original session unavailable')
  return contextReturn(member.sessionId, text)
}

/**
 * How a member names itself to its own model. The parent is not "Leaf 0": it is
 * the conversation the family came from, and telling it otherwise would have it
 * believe it was one of its own leaves.
 */
function leafSelfLabel(member: LeafMember, rootSessionId: string): string {
  return member.number === 0
    ? `The original session ${member.name} (family root ${rootSessionId})`
    : `Leaf ${member.number}: ${member.name} (of session ${rootSessionId})`
}

function launch(member: LeafMember, rootSessionId: string): Promise<OwnedLeafView> {
  const pending = launches.get(member.sessionId)
  if (pending) return pending
  const launching = launchOnce(member, rootSessionId).finally(() => launches.delete(member.sessionId))
  launches.set(member.sessionId, launching)
  return launching
}

async function launchOnce(member: LeafMember, rootSessionId: string): Promise<OwnedLeafView> {
  const existing = views.get(member.sessionId)
  if (existing && !['closed', 'failed'].includes(existing.process.getState())) return existing
  let release: () => Promise<void>
  try { release = await lock(`${member.transcriptPath}.leaf-owner`, { realpath: false, stale: 10000, retries: 0 }) }
  // A collision means a second member is being started for one transcript right
  // now, which is the one thing that must not happen. It is only that: a member
  // that is already up holds nothing here, so opening a running leaf is an
  // attach, not a refusal.
  catch { throw new Error(`${memberLabel(member)} is already open in another window; close it there before opening it here`) }
  // The parent session always has a transcript - it is the conversation the
  // family was forked from - so it is always resumed. Starting it under
  // `--session-id` would shadow the real conversation with an empty one.
  let hasTranscript = member.number === 0 || member.forkMessageId !== null
  if (!hasTranscript) {
    try { hasTranscript = (await readFile(member.transcriptPath, 'utf8')).split('\n').filter(line => line.trim()).some(line => { const entry = JSON.parse(line); return entry.type === 'user' || entry.type === 'assistant' }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { await release(); throw error } }
  }
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
    // Without it a leaf would derive its intent from the parent transcript it
    // was forked from and believe it was that session.
    GATEWAY_LEAF_LABEL: leafSelfLabel(member, rootSessionId),
    GATEWAY_LEAF_DRAFT: existing?.draft ?? member.draft ?? '',
    GATEWAY_LEAF_COLUMNS: String(process.stdout.columns || 80), GATEWAY_LEAF_ROWS: String(process.stdout.rows || 24),
    // The leaf's own stdout is a pipe, so chalk would resolve to "no colour"
    // there and the leaf would render black and white. Its bytes are drawn by
    // THIS terminal, so hand down the depth that is actually going to render.
    ...leafColorEnv(),
  }, interactive: true,
    // The member's own address, which is how any session reaches it - including
    // one that outlives this process, and this one after it has been closed and
    // reopened. It is not a parent handle: nothing here is held open for the
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
    if (error instanceof LeafTakenError) throw new Error(`${memberLabel(member)} is already open in another window; close it there before opening it here`)
    throw error
  }
  finally {
    // The claim covers the start, not the member's life. Once it is listening
    // it refuses a second session on its own, and a file that outlives the
    // session that took it would go stale and start reading as "nobody is
    // holding this" while the member is still running under it.
    await release().catch(() => {})
  }
  publish()
  return view
}

/**
 * Report a finished turn back to everyone who asked for it.
 *
 * The senders are recorded when the message is dispatched; this runs when the
 * leaf reaches idle, reads the answer out of the turn that just ended, and hands
 * it to each sender through the channel that sender already has - a parent
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

/** The text of the turn that just finished, so a reply can be quoted, not guessed. */
async function lastLeafTurnText(view: OwnedLeafView): Promise<string | undefined> {
  try {
    const lines = (await readFile(view.member.transcriptPath, 'utf8')).split('\n').filter(line => line.trim())
    for (let index = lines.length - 1; index >= 0; index--) {
      const entry = JSON.parse(lines[index]!)
      if (entry.type !== 'assistant') continue
      const content = entry.message?.content
      const text = (Array.isArray(content) ? content : []).filter((part: any) => part?.type === 'text' && typeof part.text === 'string').map((part: any) => part.text).join('\n').trim()
      if (text) return text.length > 4000 ? `${text.slice(0, 4000)}…` : text
    }
  } catch { /* No transcript yet means nothing to report. */ }
  return undefined
}

/**
 * Route one reply to the session that asked for it.
 *
 * Inside a leaf both directions are the leaf wire: a sibling's answer is handed
 * back as a turn in this leaf's own REPL, and the root answers as a report to
 * the parent. At the root the same two cases are a sibling's plain turn and a
 * report appended to this conversation, because the root has no input channel.
 */
async function reportLeafReply(item: { source: string; root: string; message: string }, view: OwnedLeafView, answer: string): Promise<void> {
  const text = `Reply from Leaf ${view.member.number} ${view.member.name} (${view.member.sessionId}) to "${item.message.slice(0, 200)}":\n\n${answer}`
  if (isInteractiveLeaf()) {
    if (item.source === getSessionId()) return
    if (rootReference(item.source) || item.source === getLeafRootSessionId()) return void await notifyLeafParent(text)
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
        if (!contextReturn) throw new Error('Original session unavailable')
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
      case 'change': await changeLeaf(id, value); break
      case 'file': await fileLeaf(id, value); break
      case 'goal': result = await setLeafGoal(id, value); break
      // A leaf reporting its own model/effort only persists them. Applying
      // settings must go through 'configure' so the parent drives the child
      // rather than the child echoing a control request back to itself.
      case 'settings': await saveLeafSettings(id, value); break
      case 'configure': result = await configureLeaf(id, value); break
      // `sourceId` is the requesting leaf, not this process. Passing it is what
      // routes the answer back to the leaf that asked instead of to the root.
      case 'send': result = await sendLeafMessage(id, value, { sessionId: sourceId }); break
      case 'roster': result = await familyRoster(); break
      // A leaf addressing the root hands it a turn on the message channel the
      // root already uses for its leaves, so awareness runs both directions:
      // the parent drives a leaf with 'send', a leaf reaches its parent here.
      case 'notify': {
        if (!contextNotify) throw new Error('Original session cannot receive messages')
        result = await contextNotify(sourceId, String(value))
        break
      }
      case 'interrupt': result = await interruptLeaf(id); break
      case 'list': result = await listLeaves(); break
      case 'renamed': {
        const view = views.get(sourceId)!
        view.member = await updateLeafMember(familyPath(root), root, sourceId, { name: String(id) })
        publish()
        break
      }
      case 'checkpoint': case 'model': case 'effort': {
        const view = getLeafViews().find(item => item.member.sessionId === id)
        if (!view) throw new Error('Unknown leaf')
        if (message.action === 'checkpoint') await view.process.checkpoint(value)
        else if (message.action === 'model') await view.process.setModel(value)
        else await view.process.setEffort(value)
        break
      }
      default: throw new Error('Unknown workspace action')
    }
    child.terminal({ type: 'leaf-response', id: message.id, ok: true, value: result })
  } catch (error) {
    // A refusal the requester cannot read is a refusal it cannot act on: a bad
    // reference, a busy target and an unavailable parent all arrived as the same
    // silent `ok: false`, so the leaf could only report that something failed.
    // The reason travels back with the refusal, single-lined and bounded.
    const reason = error instanceof Error ? error.message.replace(/\s+/g, ' ').trim().slice(0, 300) : ''
    try { child.terminal({ type: 'leaf-response', id: message.id, ok: false, value: reason || undefined }) } catch { /* Closing the originating session needs no reply. */ }
  }
}

/**
 * Which conversation a new leaf copies.
 *
 * Selection is the source of truth: forking the root while a leaf is on screen
 * silently discarded the leaf's context, which is what made "fork this" fork
 * the wrong conversation. `original`/`root` still force the root explicitly.
 * Kept pure so the rule is testable without spawning anything.
 */
export function resolveLeafSource(explicit: string | undefined, root: string, selected: string | undefined): string {
  if (explicit) return rootReference(explicit) ? root : explicit
  return selected ?? root
}

export async function createLeaf(name?: string, parentSessionId?: string, worktree?: string, options: { fresh?: boolean; model?: string; effort?: LeafMember['effort']; requestedBy?: string } = {}): Promise<LeafView> {
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
        setModel: (model: string) => requestLeafWorkspace('model', [member.sessionId, model]),
        setEffort: (effort: string) => requestLeafWorkspace('effort', [member.sessionId, effort]),
      },
    }
  }
  const self = getSessionId()
  const root = await familyRootSessionId()
  const resolvedParentId = resolveLeafSource(parentSessionId, root, selectedLeafId())
  // At the root, "the root" is this session and its live conversation is the
  // fork source. From a member, the root is a session on disk - or one hosted
  // here - so its transcript is what gets forked, never this conversation.
  const fromSelf = resolvedParentId === root && root === self
  const hosted = views.get(resolvedParentId)
  const parent = !fromSelf && hosted && hosted.rootSessionId === root ? hosted : undefined
  // A source that is not an open leaf is still forkable: any session whose
  // transcript exists on disk can seed a leaf. Refusing it here is what made
  // "fork this session into a leaf" unreliable for anything but a live leaf.
  let source: { sessionId: string; transcriptPath: string } | undefined
  if (!fromSelf && !parent) {
    const transcriptPath = resolvedParentId === root ? (await leafParentMember())?.transcriptPath ?? getTranscriptPathForSession(resolvedParentId) : getTranscriptPathForSession(resolvedParentId)
    try { await access(transcriptPath) }
    catch { throw new Error(`No session or open leaf matches ${resolvedParentId}`) }
    source = { sessionId: resolvedParentId, transcriptPath }
  }
  let cwd = parent?.member.cwd ?? getCwd()
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
  const selfFork = parent?.member.sessionId === options.requestedBy
  if (parent && !options.fresh && !selfFork) await parent.process.checkpoint()
  const freshId = randomUUID()
  const fork = options.fresh ? undefined : await createFork(undefined, parent ? { sessionId: parent.member.sessionId, transcriptPath: parent.member.transcriptPath } : source)
  if (getSessionId() !== self) throw new Error('Session changed before leaf creation')
  const member = await addLeafMember(familyPath(root), root, {
    sessionId: fork?.sessionId ?? freshId, parentSessionId: parent?.member.sessionId ?? root,
    name: name || (options.fresh ? 'New conversation' : parent?.member.name || getLeafRootName()),
    transcriptPath: fork?.forkPath ?? join(getProjectDir(cwd), `${freshId}.jsonl`), forkMessageId: fork?.serializedMessages.at(-1)?.uuid ?? null,
    cwd, model: options.model ?? parent?.member.model, effort: options.effort ?? parent?.member.effort,
  })
  saveSessionName(asSessionId(member.sessionId), `Leaf ${member.number}: ${member.name}`, member.transcriptPath)
  // The new member gets its pointer now, so it can find this family if it is
  // ever resumed on its own.
  void indexLeafMembers(root, [member])
  const view = await launch(member, root)
  if (familyRootSync() === root) selectLeaf(member.sessionId)
  return view
}

let hostRelease: (() => Promise<void>) | undefined
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
async function claimHostOwnership(): Promise<void> {
  if (hostRelease) return
  try { hostRelease = await lock(`${getTranscriptPath()}.leaf-owner`, { realpath: false, stale: 10000, retries: 0 }) }
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
  // Only the root knows its own transcript path and directory, so only the root
  // writes the pointers its members will read. A member re-indexes with what it
  // read: nothing new, unless the roster grew while it was hosting.
  await indexLeafMembers(root, family.members)
  await claimHostOwnership()
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
  await launch(member, root)
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

export async function changeLeaf(sessionId: string, patch: Pick<Partial<LeafMember>, 'name' | 'status'>): Promise<void> {
  if (isInteractiveLeaf()) return requestLeafWorkspace('change', [sessionId, patch])
  const root = await familyRootSessionId()
  if (sessionId === root) return changeParent(patch)
  const self = getSessionId()
  const view = views.get(sessionId)
  if (view && view.rootSessionId !== root) throw new Error('Leaf belongs to another family')
  if (patch.status === 'promoted' && view && view.process.getState() !== 'idle') throw new Error('Wait for the leaf turn before promoting')
  if (patch.name && view && !['closed', 'failed'].includes(view.process.getState()) && (!patch.status || patch.status === 'open')) {
    const name = patch.name.trim()
    if (!name || name.length > 200) throw new Error('Name must contain 1–200 characters')
    await view.process.checkpoint(`Leaf ${view.member.number}: ${name}`)
    view.member = await updateLeafMember(familyPath(root), root, sessionId, { name })
    publish()
    return
  }
  if (patch.status && patch.status !== 'open' && view) {
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
  if (patch.status === 'open') await launch(member, root)
  publish()
}

/**
 * Close or reopen the family's parent session from inside one of its members.
 *
 * The parent has no family entry to update - it *is* the family - so closing it
 * stops the process hosting the family here, and reopening it starts the same
 * session again from the transcript its pointer names. It cannot be archived or
 * promoted, and it cannot be renamed from here: it is the permanent member, and
 * it is what names the family.
 */
async function changeParent(patch: Pick<Partial<LeafMember>, 'name' | 'status'>): Promise<void> {
  const self = getSessionId()
  const root = familyRootSync()
  if (self === root) throw new Error('This is the parent session; it ends when you leave it')
  if (patch.name) throw new Error('The parent session keeps its own name')
  if (patch.status && patch.status !== 'open' && patch.status !== 'closed') throw new Error("The parent session cannot be archived or promoted; it is this family's permanent session")
  const view = views.get(root)
  if (patch.status !== 'open') {
    if (!view) return
    await saveLeafDraft(view)
    await view.process.close()
    await ownerReleases.get(root)?.()
    ownerReleases.delete(root)
    views.delete(root)
    if (selected.get(self) === root) selected.delete(self)
    publish()
    return
  }
  const member = await leafParentMember()
  if (!member) throw new Error('This session is the parent')
  if (!view || !isLeafProcessAlive(view.process.getState())) await launch(member, root)
  publish()
}

export async function fileLeaf(sessionId: string, tag: string): Promise<void> {
  if (isInteractiveLeaf()) return requestLeafWorkspace('file', [sessionId, tag])
  const { recursivelySanitizeUnicode } = await import('./sanitization.js')
  const normalized = recursivelySanitizeUnicode(tag).trim()
  if (!normalized || normalized.length > 200) throw new Error('Tag must contain 1–200 characters')
  const root = await familyRootSessionId()
  const family = await readLeafFamily(familyPath(root), root)
  const member = family.members.find(item => item.sessionId === sessionId)
  if (!member) throw new Error('Unknown leaf')
  const view = getLeafViews().find(item => item.member.sessionId === sessionId)
  if (view && view.process.getState() !== 'idle') throw new Error('Wait for the leaf turn before filing')
  if (view) await changeLeaf(sessionId, { status: 'closed' })
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
}

export async function setLeafGoal(sessionId: string, args: string): Promise<string> {
  if (isInteractiveLeaf()) return requestLeafWorkspace('goal', [sessionId, args])
  const { parsePersistArgs } = await import('../skills/bundled/persist.js')
  const { readPersistSessionRecord, writePersistSessionRecord } = await import('./sessionStorage.js')
  const parsed = parsePersistArgs(args)
  if (parsed.kind === 'error') throw new Error(parsed.message)
  const root = await familyRootSessionId()
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
  // The parent keeps its own settings: there is no family entry to record them
  // in, and its own session is where they belong.
  if (view.member.number === 0) return
  view.member = await updateLeafMember(familyPath(view.rootSessionId), view.rootSessionId, sessionId, patch)
  publish()
}

export async function saveLeafDraft(view: LeafView): Promise<void> {
  const owned = views.get(view.member.sessionId)
  if (owned && !['closed', 'failed'].includes(owned.process.getState())) await owned.process.syncDraft()
  // A hosted parent has no family entry to store a draft in.
  if (view.member.number === 0) return
  view.member = await updateLeafMember(familyPath(view.rootSessionId), view.rootSessionId, view.member.sessionId, { draft: view.draft })
}

registerCleanup(async () => {
  // This session leaving is not the family leaving. A member is its own
  // process, so it is detached and keeps running - which is what lets a person
  // close the session they are in and carry on in a leaf, and what stops the
  // session that happened to start a leaf being its reason to exist. Closing a
  // leaf for good is `changeLeaf`, and only a person does that.
  await Promise.all([...views.values()].map(async view => {
    try { await saveLeafDraft(view) } catch { /* The member may already be gone. */ }
    view.process.detach()
  }))
  // Release the claims this session took, so what it was holding can be picked
  // up straight away instead of waiting for the lock to go stale.
  for (const release of [...ownerReleases.values()]) await release().catch(() => {})
  ownerReleases.clear()
  await hostRelease?.().catch(() => {})
})
