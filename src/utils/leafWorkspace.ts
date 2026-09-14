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

/** Hand a leaf a turn. Runs in the leaf's own REPL; the parent stays put. */
export async function sendLeafMessage(reference: string, text: string): Promise<string> {
  const message = text.trim()
  if (!message) throw new Error('Message required')
  if (message.length > 64000) throw new Error('Message too large')
  if (isInteractiveLeaf()) {
    const member = await resolveLeafRef(reference)
    if (!member) throw new Error('Unknown or ambiguous leaf reference')
    return requestLeafWorkspace<string>('send', [member.sessionId, message])
  }
  const { member, view } = await requireLeafView(reference)
  const state = view.process.getState()
  if (state === 'running') throw new Error(`Leaf #${member.number} ${member.name} is running; wait for its turn to finish`)
  if (state === 'awaiting-approval') throw new Error(`Leaf #${member.number} ${member.name} is waiting for permission`)
  await view.process.deliver(message)
  return `Delivered to leaf #${member.number} ${member.name} (${member.sessionId}).`
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
    // A leaf registers on the same peer bus as any session. Without a label it
    // would advertise its source transcript's opening prompt and look like a
    // duplicate of its parent; this says what it actually is and who owns it.
    GATEWAY_LEAF_LABEL: `Leaf ${member.number}: ${member.name} (of session ${rootSessionId})`,
    GATEWAY_LEAF_DRAFT: existing?.draft ?? member.draft ?? '',
    GATEWAY_LEAF_COLUMNS: String(process.stdout.columns || 80), GATEWAY_LEAF_ROWS: String(process.stdout.rows || 24),
  }, interactive: true,
    onState: publish,
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
      case 'change': await changeLeaf(id, value); break
      case 'file': await fileLeaf(id, value); break
      case 'goal': result = await setLeafGoal(id, value); break
      // A leaf reporting its own model/effort only persists them. Applying
      // settings must go through 'configure' so the parent drives the child
      // rather than the child echoing a control request back to itself.
      case 'settings': await saveLeafSettings(id, value); break
      case 'configure': result = await configureLeaf(id, value); break
      case 'send': result = await sendLeafMessage(id, value); break
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

export async function createLeaf(name?: string, parentSessionId?: string, worktree?: string, options: { fresh?: boolean; model?: string; effort?: LeafMember['effort'] } = {}): Promise<LeafView> {
  if (isInteractiveLeaf()) {
    const member = await requestLeafWorkspace<LeafMember>('create', [name, parentSessionId ?? getSessionId(), worktree, options])
    return getLeafViews().find(view => view.member.sessionId === member.sessionId)!
  }
  const root = getSessionId()
  const fromRoot = !parentSessionId || parentSessionId === 'original' || parentSessionId === root
  const parent = fromRoot ? undefined : getLeafViews().find(view => view.member.sessionId === parentSessionId)
  // A source that is not an open leaf is still forkable: any session whose
  // transcript exists on disk can seed a leaf. Refusing it here is what made
  // "fork this session into a leaf" unreliable for anything but a live leaf.
  let source: { sessionId: string; transcriptPath: string } | undefined
  if (!fromRoot && !parent) {
    const transcriptPath = getTranscriptPathForSession(parentSessionId!)
    try { await access(transcriptPath) }
    catch { throw new Error(`No session or open leaf matches ${parentSessionId}`) }
    source = { sessionId: parentSessionId!, transcriptPath }
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

export async function restoreLeafWorkspace(): Promise<void> {
  if (isInteractiveLeaf()) return
  const root = getSessionId()
  const family = await readLeafFamily(familyPath(root), root)
  const failures: unknown[] = []
  for (const member of family.members) if (member.status === 'open') {
    try { await launch(member, root) } catch (error) { failures.push(error) }
  }
  if (failures.length) throw new Error('Some saved leaves could not reopen')
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
