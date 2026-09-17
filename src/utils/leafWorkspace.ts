import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getSessionId } from '../bootstrap/state.js'
import { asSessionId } from '../types/ids.js'
import { getCwd } from './cwd.js'
import { checkHasTrustDialogAccepted } from './config.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { createFork } from '../commands/branch/branch.js'
import { flushSessionStorage, getCurrentSessionTitle, getProjectDir, getTranscriptPathForSession, saveSessionName } from './sessionStorage.js'
import { addLeafMember, readLeafFamily, resolveLeafMember, updateLeafMember, type LeafFamily, type LeafMember } from './leafFamily.js'
import { LeafProcess } from './leafProcess.js'
import { registerCleanup } from './cleanupRegistry.js'
import { lock } from './lockfile.js'
import { getLeafSnapshot, isInteractiveLeaf, requestLeafWorkspace, subscribeLeafSnapshot, type LeafTerminalMessage } from './leafTerminal.js'
import { focusLeafTerminal, renderLeafTerminal } from './leafTerminalHost.js'

export type LeafView = { rootSessionId: string; member: LeafMember; process: Pick<LeafProcess, 'getState' | 'checkpoint' | 'setModel' | 'setEffort'>; draft: string }
type OwnedLeafView = LeafView & { process: LeafProcess }
const views = new Map<string, OwnedLeafView>()
const ownerReleases = new Map<string, () => Promise<void>>()
const listeners = new Set<() => void>()
const selected = new Map<string, string>()
const launches = new Map<string, Promise<OwnedLeafView>>()
export function selectedLeafId(): string | undefined { return isInteractiveLeaf() ? getSessionId() : selected.get(getSessionId()) }
export function getLeafRootName(): string { return getLeafSnapshot()?.rootName || getCurrentSessionTitle(getSessionId()) || 'Original' }
export function selectLeaf(sessionId?: string): void {
  if (isInteractiveLeaf()) { void requestLeafWorkspace('select', [sessionId]).catch(() => {}); return }
  const root = getSessionId()
  const view = sessionId ? views.get(sessionId) : undefined
  if (sessionId && (!view || view.rootSessionId !== root)) throw new Error('Unknown leaf')
  if (sessionId) selected.set(root, sessionId)
  else selected.delete(root)
  focusLeafTerminal(view?.process)
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
  const snapshot = { rootSessionId: getSessionId(), rootName: getLeafRootName(), members: getLeafViews().map(view => ({ member: view.member, state: view.process.getState() })) }
  for (const view of views.values()) {
    if (view.rootSessionId === getSessionId() && !['closed', 'failed'].includes(view.process.getState())) {
      try { view.process.snapshot(snapshot) } catch { /* The child may still be spawning. */ }
    }
  }
}
subscribeLeafSnapshot(() => { revision++; for (const listener of listeners) listener() })
export function subscribeLeafWorkspace(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } }
export function leafWorkspaceRevision(): number { return revision }
export function getLeafViews(): LeafView[] {
  if (isInteractiveLeaf()) return (getLeafSnapshot()?.members ?? []).map(({ member, state }) => ({
    rootSessionId: getLeafSnapshot()!.rootSessionId, member, draft: member.draft ?? '',
    process: { getState: () => state, checkpoint: (name?: string) => requestLeafWorkspace('checkpoint', [member.sessionId, name]), setModel: (model: string) => requestLeafWorkspace('model', [member.sessionId, model]), setEffort: (effort: string) => requestLeafWorkspace('effort', [member.sessionId, effort]) },
  }))
  return [...views.values()].filter(view => view.rootSessionId === getSessionId())
}
function familyPath(root: string): string { return join(getClaudeConfigHomeDir(), 'leaf-families', `${root}.json`) }

async function currentFamily(): Promise<LeafFamily> {
  const root = getSessionId()
  return readLeafFamily(familyPath(root), root)
}

/** Members of the current family, from the parent's file or a leaf's snapshot. */
export async function listLeafMembers(): Promise<LeafMember[]> {
  if (isInteractiveLeaf()) return (getLeafSnapshot()?.members ?? []).map(entry => entry.member)
  return (await currentFamily()).members
}

/**
 * Resolve a leaf reference (session ID, number, `N:name`, or name) against the
 * current family. Deterministic and side-effect free, so callers never need an
 * agent turn to locate a leaf.
 */
export async function resolveLeafRef(reference: string): Promise<LeafMember | undefined> {
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
  return getLeafSnapshot()?.rootSessionId ?? getSessionId()
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
  let view = views.get(member.sessionId)
  if (view && view.rootSessionId !== getSessionId()) view = undefined
  if (!view || ['closed', 'failed'].includes(view.process.getState())) {
    if (member.status !== 'open') throw new Error(`Leaf #${member.number} ${member.name} is ${member.status}`)
    view = await launch(member, getSessionId())
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
 */
export const PEER_PROMPT_PREFIX = '[message from another session, not the user]\n'

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
      ? `Message to leaf #${member.number} ${member.name} was not run; the leaf ended before its turn finished`
      : `Leaf #${member.number} ${member.name} did not take the message; it was not run`)
  }
  return busy
    // Refusing here dropped the message and left the sender to guess when to
    // retry, which is how a mid-turn send died. A running leaf's own queue takes
    // it and runs it at the next step boundary, so only a leaf sitting on a
    // permission dialog actually waits; the reply is reported separately, as
    // soon as the answer exists rather than when the turn ends.
    ? `Queued for leaf #${member.number} ${member.name} (${member.sessionId}); ${state === 'awaiting-approval' ? 'it is waiting for permission, so it holds the message until the dialog is answered' : 'it is mid-turn, so it takes the message at its next step boundary - expect the reply before the turn ends'}.`
    : `Delivered to leaf #${member.number} ${member.name} (${member.sessionId}).`
}

export async function interruptLeaf(reference: string): Promise<string> {
  if (isInteractiveLeaf()) {
    const member = await resolveLeafRef(reference)
    if (!member) throw new Error('Unknown or ambiguous leaf reference')
    return requestLeafWorkspace<string>('interrupt', [member.sessionId])
  }
  const { member, view } = await requireLeafView(reference)
  await view.process.interrupt()
  return `Interrupted leaf #${member.number} ${member.name}.`
}

export async function checkpointLeaf(reference: string, name?: string): Promise<string> {
  if (isInteractiveLeaf()) {
    const member = await resolveLeafRef(reference)
    if (!member) throw new Error('Unknown or ambiguous leaf reference')
    return requestLeafWorkspace<string>('checkpoint', [member.sessionId, name])
  }
  const { member, view } = await requireLeafView(reference)
  await view.process.checkpoint(name)
  return `Checkpointed leaf #${member.number} ${member.name}.`
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
  return `Leaf #${member.number} ${member.name} ${patch.model !== undefined ? `model ${patch.model}` : `effort ${patch.effort}`} updated and saved for restart.`
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
  const release = await lock(`${member.transcriptPath}.leaf-owner`, { realpath: false, stale: 10000, retries: 0 })
  let releasePromise: Promise<void> | undefined
  const releaseOwner = () => releasePromise ??= release()
  ownerReleases.set(member.sessionId, releaseOwner)
  let hasTranscript = member.forkMessageId !== null
  if (!hasTranscript) {
    try { hasTranscript = (await readFile(member.transcriptPath, 'utf8')).split('\n').filter(line => line.trim()).some(line => { const entry = JSON.parse(line); return entry.type === 'user' || entry.type === 'assistant' }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { await releaseOwner(); ownerReleases.delete(member.sessionId); throw error } }
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
    // A leaf does not register on the shared peer bus (see useGatewaySession),
    // so this label is not an advertisement: it names the leaf to itself.
    // Without it a leaf would derive its intent from the parent transcript it
    // was forked from and believe it was that session.
    GATEWAY_LEAF_LABEL: `Leaf ${member.number}: ${member.name} (of session ${rootSessionId})`,
    GATEWAY_LEAF_DRAFT: existing?.draft ?? member.draft ?? '',
    GATEWAY_LEAF_COLUMNS: String(process.stdout.columns || 80), GATEWAY_LEAF_ROWS: String(process.stdout.rows || 24),
  }, interactive: true,
    onQueued: () => publish(),
    onState: () => {
      const current = [...views.values()].find(view => view.process === child)
      if (current && child.getState() === 'idle') void reportLeafReplies(current, child)
      publish()
    },
    onExit: () => {
      const current = [...views.values()].find(view => view.process === child)
      const id = current?.member.sessionId ?? member.sessionId
      if (selected.get(rootSessionId) === id && getSessionId() === rootSessionId) selectLeaf()
      void (ownerReleases.get(id)?.() ?? releaseOwner()).catch(() => {})
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
  catch (error) { await child.close(); await releaseOwner(); ownerReleases.delete(member.sessionId); publish(); throw error }
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
  if (item.root !== getSessionId()) return
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
    if (getSessionId() !== root || !source || source.rootSessionId !== root) throw new Error('Leaf family changed')
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
        const view = await createLeaf(id, value, third, fourth)
        result = view.member
        break
      }
      case 'return':
        if (!contextReturn) throw new Error('Original session unavailable')
        result = await contextReturn(id, value)
        break
      case 'restore': await restoreLeafWorkspace(); break
      case 'open': result = await openLeaf(String(id)); break
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
  } catch {
    try { child.terminal({ type: 'leaf-response', id: message.id, ok: false }) } catch { /* Closing the originating session needs no reply. */ }
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

export async function createLeaf(name?: string, parentSessionId?: string, worktree?: string, options: { fresh?: boolean; model?: string; effort?: LeafMember['effort'] } = {}): Promise<LeafView> {
  if (isInteractiveLeaf()) {
    const member = await requestLeafWorkspace<LeafMember>('create', [name, parentSessionId ?? getSessionId(), worktree, options])
    return getLeafViews().find(view => view.member.sessionId === member.sessionId)!
  }
  const root = getSessionId()
  const resolvedParentId = resolveLeafSource(parentSessionId, root, selectedLeafId())
  const fromRoot = resolvedParentId === root
  const parent = fromRoot ? undefined : getLeafViews().find(view => view.member.sessionId === resolvedParentId)
  // A source that is not an open leaf is still forkable: any session whose
  // transcript exists on disk can seed a leaf. Refusing it here is what made
  // "fork this session into a leaf" unreliable for anything but a live leaf.
  let source: { sessionId: string; transcriptPath: string } | undefined
  if (!fromRoot && !parent) {
    const transcriptPath = getTranscriptPathForSession(resolvedParentId)
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
  if (parent && !options.fresh) await parent.process.checkpoint()
  const freshId = randomUUID()
  const fork = options.fresh ? undefined : await createFork(undefined, parent ? { sessionId: parent.member.sessionId, transcriptPath: parent.member.transcriptPath } : source)
  if (getSessionId() !== root) throw new Error('Session changed before leaf creation')
  const member = await addLeafMember(familyPath(root), root, {
    sessionId: fork?.sessionId ?? freshId, parentSessionId: parent?.member.sessionId ?? root,
    name: name || (options.fresh ? 'New conversation' : parent?.member.name || getCurrentSessionTitle(root) || 'Conversation'),
    transcriptPath: fork?.forkPath ?? join(getProjectDir(cwd), `${freshId}.jsonl`), forkMessageId: fork?.serializedMessages.at(-1)?.uuid ?? null,
    cwd, model: options.model ?? parent?.member.model, effort: options.effort ?? parent?.member.effort,
  })
  saveSessionName(asSessionId(member.sessionId), `Leaf ${member.number}: ${member.name}`, member.transcriptPath)
  const view = await launch(member, root)
  if (getSessionId() === root) selectLeaf(member.sessionId)
  return view
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
  const root = getSessionId()
  await readLeafFamily(familyPath(root), root)
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
  return `Leaf #${member.number} ${member.name} opened.`
}

export async function changeLeaf(sessionId: string, patch: Pick<Partial<LeafMember>, 'name' | 'status'>): Promise<void> {
  if (isInteractiveLeaf()) return requestLeafWorkspace('change', [sessionId, patch])
  const root = getSessionId()
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
    if (selected.get(root) === sessionId) selected.delete(root)
  }
  if (patch.status === 'open') await launch(member, root)
  publish()
}

export async function fileLeaf(sessionId: string, tag: string): Promise<void> {
  if (isInteractiveLeaf()) return requestLeafWorkspace('file', [sessionId, tag])
  const { recursivelySanitizeUnicode } = await import('./sanitization.js')
  const normalized = recursivelySanitizeUnicode(tag).trim()
  if (!normalized || normalized.length > 200) throw new Error('Tag must contain 1–200 characters')
  const root = getSessionId()
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
  const root = getSessionId()
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
  const view = getLeafViews().find(item => item.member.sessionId === sessionId)
  if (!view) throw new Error('Unknown leaf')
  view.member = await updateLeafMember(familyPath(view.rootSessionId), view.rootSessionId, sessionId, patch)
  publish()
}

export async function saveLeafDraft(view: LeafView): Promise<void> {
  const owned = views.get(view.member.sessionId)
  if (owned && !['closed', 'failed'].includes(owned.process.getState())) await owned.process.syncDraft()
  view.member = await updateLeafMember(familyPath(view.rootSessionId), view.rootSessionId, view.member.sessionId, { draft: view.draft })
}

registerCleanup(async () => { await Promise.all([...views.values()].map(async view => {
  try { await saveLeafDraft(view) } finally { await view.process.close() }
})) })
