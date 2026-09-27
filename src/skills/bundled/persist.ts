import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { getSessionId, onSessionSwitch } from '../../bootstrap/state.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import {
  addFunctionHook,
  removeFunctionHook,
} from '../../utils/hooks/sessionHooks.js'
import type { SetAppState } from '../../utils/messageQueueManager.js'
import {
  getUserMessageText,
  isToolUseRequestMessage,
} from '../../utils/messages.js'
import { plural } from '../../utils/stringUtils.js'
import {
  getTranscriptPath,
  readPersistSessionRecord,
  writePersistSessionRecord,
} from '../../utils/sessionStorage.js'
import type {
  PersistSessionRecord,
  PersistSessionStatus,
  PersistTaskMode,
} from '../../utils/sessionStorage.js'
import { escapeXml } from '../../utils/xml.js'
import { registerBundledSkill } from '../bundledSkills.js'
import { logForDebugging } from '../../utils/debug.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { advanceDelivery, deliveryDirection, parseDeliveryReview, type DeliveryCheckpoint } from './persistDelivery.js'

export type { PersistSessionRecord, PersistSessionStatus }

const DEFAULT_NUDGES = 1
const MAX_NUDGES = 3
// A heartbeat that produces no tool work is not pushing anything forward, and
// continuation modes never disarm on the nudge budget, so a session that answers
// every heartbeat with the same sentence arms another one forever. Measured in
// the field as 1,239 heartbeats against one session, each a full round trip for
// no work, filling the transcript. One stop without tools can be honest - the
// model reasoned and yielded - so the heartbeat is allowed a short run before
// the loop is called what it is.
const MAX_STALLED_HEARTBEATS = 3
const MAX_TASK_CONTEXT_LENGTH = 2000
const MAX_USER_CONTEXT_LENGTH = 1000
const TASK_BLOCKER_REVIEW_GUIDANCE = 'In task mode, hypotheses, reversible tests, and diagnosis uncertainty are not blockers: use persist-review checkpoint or continue and keep working. A blocked review must be JSON {kind:\'blocked\', blocker:\'user-input\'|\'authorization\'|\'safety\'|\'external-dependency\'|\'provider-failure\', canProceedWithoutUser:false, next:string, evidence:string} proving a hard stop condition.'

type PersistMode = 'work' | 'plan'
type TaskBlockerKind = 'user-input' | 'authorization' | 'safety' | 'external-dependency' | 'provider-failure'
type TaskBlocker = {
  kind: 'blocked'
  blocker: TaskBlockerKind
  canProceedWithoutUser: false
  next: string
  evidence: string
}

function parseTaskBlocker(input: string): TaskBlocker | undefined {
  try {
    const value: unknown = JSON.parse(input)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const candidate = value as Record<string, unknown>
    const blockers: TaskBlockerKind[] = ['user-input', 'authorization', 'safety', 'external-dependency', 'provider-failure']
    if (
      candidate.kind !== 'blocked' ||
      !blockers.includes(candidate.blocker as TaskBlockerKind) ||
      candidate.canProceedWithoutUser !== false ||
      typeof candidate.next !== 'string' ||
      typeof candidate.evidence !== 'string'
    ) return undefined
    const next = candidate.next.trim()
    const evidence = candidate.evidence.trim()
    if (!next || !evidence || next.length > 1200 || evidence.length > 1200) return undefined
    return {
      kind: 'blocked',
      blocker: candidate.blocker as TaskBlockerKind,
      canProceedWithoutUser: false,
      next,
      evidence,
    }
  } catch {
    return undefined
  }
}

/**
 * Runtime state for a persisted task. The hook ID is deliberately kept out
 * of PersistSessionRecord: callbacks and React state setters are ephemeral.
 * The optional fields preserve compatibility with callers constructing the
 * pre-redesign state directly in unit tests.
 */
export type PersistState = {
  task: string
  mode: PersistMode
  keep?: boolean
  taskMode?: PersistTaskMode
  nudgesRemaining: number
  nudgesSent: number
  hookId: string
  initialPlanningResponseAllowed: boolean
  status?: PersistSessionStatus
  reviewEvidence?: string
  delivery?: DeliveryCheckpoint
  // In-process progress tracking for the heartbeat, never persisted:
  // recordFromState copies explicit fields only, so these stay out of the
  // sidecar and a resumed session re-measures progress from scratch.
  workMark?: string
  stalledHeartbeats?: number
}

type PersistRuntime = {
  state: PersistState
  setAppState: SetAppState
  hookId: string
  transcriptPath: string
  pendingNudges: WeakMap<Message[], string>
  reviewedChain?: string
  reviewOutcome?: 'continue' | 'unrelated' | 'blocked'
  requestedReviewChain?: string
  pendingDelivery?: { chainId: string; next: PersistState }
}

type PersistCommandContext = ToolUseContext & { transcriptPath?: string }

function getRuntimeTranscriptPath(context: PersistCommandContext): string {
  return context.transcriptPath ?? getTranscriptPath()
}

const persistRecords = new Map<string, PersistSessionRecord>()
const persistListeners = new Set<() => void>()
export function subscribePersist(listener: () => void): () => void {
  persistListeners.add(listener)
  return () => { persistListeners.delete(listener) }
}
export function getCurrentPersistRecord(): PersistSessionRecord | undefined {
  return persistRecords.get(getSessionId())
}
export function getPersistGoalContext(): string | undefined {
  const record = getCurrentPersistRecord()
  if (!record || record.status === 'completed' || record.status === 'cleared') return undefined
  if (record.status === 'paused' || record.status === 'blocked' || record.status === 'stalled') return `Stored goal (${record.status}): ${escapeXml(record.task)}. Do not automatically pursue it. Wait for /persist resume; the current conversation takes precedence.`
  const taskMode = record.taskMode
  const continuation = taskMode === 'task'
    ? `Task mode uses the in-process Stop-hook heartbeat and does not stop at the nudge budget. Keep doing useful work until the goal-wide doneWhen condition has concrete completion evidence. ${TASK_BLOCKER_REVIEW_GUIDANCE}`
    : taskMode === 'keep'
      ? 'Keep mode retains goal custody until explicit completion or release.'
      : 'Bounded mode stops automatic continuation when its reminder budget is exhausted.'
  return `Durable session goal (${record.status}, ${taskMode}):\n<goal>\n${escapeXml(record.task)}\n</goal>\n${continuation} The latest user instruction takes precedence. Side conversations do not erase this goal. Check completion criteria and verification evidence before declaring completion. Do not spend reminders on unrelated discussion. At meaningful checkpoints or attempted stops use the persist-review skill with checkpoint, continue, unrelated, blocked, or complete followed by concrete evidence. This is self-assessment, not independent verification. Review unrelated for side conversations, blocked when user input is needed, and complete only when completion criteria are met. Goal controls: /persist status, /persist pause, /persist complete, /persist clear.\n${deliveryDirection(record.delivery)}`
}
function publishPersist(): void {
  for (const listener of persistListeners) listener()
}
onSessionSwitch(publishPersist)
const persistRuntime = new Map<string, PersistRuntime>()
const persistWrites = new Map<string, Promise<void>>()
const persistOperations = new Map<string, Promise<unknown>>()

function serializePersistOperation<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
  const next = (persistOperations.get(sessionId) ?? Promise.resolve()).catch(() => {}).then(operation)
  persistOperations.set(sessionId, next)
  void next.finally(() => {
    if (persistOperations.get(sessionId) === next) persistOperations.delete(sessionId)
  }).catch(() => {})
  return next
}

export async function drainPersistWrites(): Promise<void> {
  while (persistWrites.size > 0 || persistOperations.size > 0) {
    await Promise.all([...persistOperations.values(), ...persistWrites.values()])
  }
}
registerCleanup(drainPersistWrites)

function getPersistHookId(sessionId: string): string {
  return `persist-${sessionId}`
}

function getStateStatus(state: PersistState): PersistSessionStatus {
  return state.status ?? 'active'
}

function getTaskMode(state: PersistState): PersistTaskMode {
  return state.taskMode ?? (state.keep ? 'keep' : 'bounded')
}

function isContinuationMode(state: PersistState): boolean {
  return getTaskMode(state) !== 'bounded'
}

function recordFromState(state: PersistState): PersistSessionRecord {
  const taskMode = getTaskMode(state)
  return {
    version: 1,
    task: state.task,
    mode: state.mode,
    keep: taskMode === 'keep',
    taskMode,
    nudgesRemaining: Math.max(0, state.nudgesRemaining),
    nudgesSent: Math.max(0, state.nudgesSent),
    status: getStateStatus(state),
    initialPlanningResponseAllowed: state.initialPlanningResponseAllowed,
    ...(state.reviewEvidence ? { reviewEvidence: state.reviewEvidence } : {}),
    ...(state.delivery ? { delivery: state.delivery } : {}),
  }
}

function stateFromRecord(
  record: PersistSessionRecord,
  hookId: string,
): PersistState {
  return {
    task: record.task,
    mode: record.mode,
    keep: record.taskMode === 'keep',
    taskMode: record.taskMode,
    nudgesRemaining: record.nudgesRemaining,
    nudgesSent: record.nudgesSent,
    hookId,
    initialPlanningResponseAllowed: record.initialPlanningResponseAllowed,
    status: record.status,
    ...(record.reviewEvidence ? { reviewEvidence: record.reviewEvidence } : {}),
    ...(record.delivery ? { delivery: record.delivery } : {}),
  }
}

function cacheState(
  sessionId: string,
  state: PersistState,
): PersistSessionRecord {
  const record = recordFromState(state)
  persistRecords.set(sessionId, record)
  publishPersist()
  return record
}

function queuePersistWrite(
  sessionId: string,
  record: PersistSessionRecord,
  transcriptPath: string,
): Promise<void> {
  const previous = persistWrites.get(sessionId) ?? Promise.resolve()
  const next = previous
    .catch(error => {
      logForDebugging('Persist sidecar write failed; goal state was not confirmed durable.')
    })
    .then(() =>
      writePersistSessionRecord(
        { ...record },
        transcriptPath,
      ),
    )
  let tracked: Promise<void>
  tracked = next.finally(() => {
    if (persistWrites.get(sessionId) === tracked) {
      persistWrites.delete(sessionId)
    }
  })
  persistWrites.set(sessionId, tracked)
  return tracked
}

async function flushPersistWrites(sessionId: string): Promise<void> {
  const pending = persistWrites.get(sessionId)
  if (!pending) return
  try {
    await pending
  } catch (error) {
    logForDebugging('Persist sidecar write failed; goal state was not confirmed durable.')
  }
}

function detachPersistRuntime(sessionId: string): void {
  const runtime = persistRuntime.get(sessionId)
  if (!runtime) return
  removeFunctionHook(runtime.setAppState, sessionId, 'Stop', runtime.hookId)
  persistRuntime.delete(sessionId)
}

function detachOtherPersistRuntimes(sessionId: string): void {
  for (const runtimeSessionId of persistRuntime.keys()) {
    if (runtimeSessionId !== sessionId) {
      detachPersistRuntime(runtimeSessionId)
    }
  }
}

function clearActiveSession(): void {
  // A session switch only releases the outgoing callback. Its sidecar and
  // cached durable record belong to that session and must survive the switch.
  const currentSessionId = getSessionId()
  for (const sessionId of persistRuntime.keys()) {
    if (sessionId !== currentSessionId) {
      detachPersistRuntime(sessionId)
    }
  }
}

onSessionSwitch(clearActiveSession)

export type PersistOptions = {
  task: string
  mode: PersistMode
  keep: boolean
  taskMode: PersistTaskMode
  nudges: number
}

export type PersistStopDecision =
  | {
      kind: 'allow'
      reason:
        | 'inactive'
        | 'planning-response'
        | 'budget-exhausted'
        | 'completed'
        | 'cleared'
        | 'cancelled'
        | 'no-progress'
    }
  | { kind: 'nudge'; message: string; nudgesRemaining: number }

function tail(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(-maxLength) : value
}

function getLastUserText(messages: Message[]): string {
  const message = messages.findLast(item => item.type === 'user' && !item.isMeta)
  return message ? (getUserMessageText(message)?.trim() ?? '') : ''
}

/**
 * How much tool work the conversation contains. The heartbeat exists to drive
 * tool work, so a heartbeat that leaves this number unchanged did not move the
 * goal. Comparing counts rather than inspecting the tail keeps it cheap and
 * treats a shorter array (a fresh chain) as progress rather than a stall.
 */
function countWork(messages: Message[]): number {
  let count = 0
  for (const message of messages) {
    if (isToolUseRequestMessage(message)) count += 1
  }
  return count
}

/**
 * Everything a heartbeat can point to as progress: tool work in the
 * conversation, and the review state the goal has recorded. Reviewing counts
 * because a session may legitimately advance a checkpoint without a tool call
 * in the same turn, and treating that as a stall would disarm a goal that is
 * being worked. A heartbeat that adds none of it moved nothing.
 */
function progressSignature(state: PersistState, messages: Message[]): string {
  return `${countWork(messages)}|${state.reviewEvidence ?? ''}|${state.delivery ? JSON.stringify(state.delivery) : ''}`
}

function parseNudges(value: string | undefined): number | undefined {
  if (!value) return DEFAULT_NUDGES
  if (!/^\d+;?$/.test(value)) return undefined
  const nudges = Number(value.replace(/;$/, ''))
  if (!Number.isInteger(nudges) || nudges < 1 || nudges > MAX_NUDGES) {
    return undefined
  }
  return nudges
}

export function parsePersistArgs(args: string):
  | { kind: 'status' }
  | { kind: 'clear' }
  | { kind: 'complete' }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'task'; options: PersistOptions }
  | { kind: 'error'; message: string } {
  let input = args.trim()
  const command = input.toLowerCase()
  if (!input || command === 'status') return { kind: 'status' }
  if (command === 'pause') return { kind: 'pause' }
  if (command === 'resume') return { kind: 'resume' }
  if (command === 'clear') return { kind: 'clear' }
  if (command === 'complete' || command === 'done') return { kind: 'complete' }

  let mode: PersistMode = 'work'
  let taskMode: PersistTaskMode = 'bounded'
  let nudges = DEFAULT_NUDGES

  while (input) {
    const legacyPlan = input.match(/^plan\s*;\s*/i)
    if (legacyPlan) {
      mode = 'plan'
      input = input.slice(legacyPlan[0].length).trim()
      continue
    }

    const modifier = input.match(/^(plan|keep|task|--task)(?:\s+|$)/i)
    if (modifier) {
      const value = modifier[1]?.toLowerCase()
      if (value === 'plan') mode = 'plan'
      else {
        const nextTaskMode = value === 'keep' ? 'keep' : 'task'
        if (taskMode !== 'bounded' && taskMode !== nextTaskMode) {
          return {
            kind: 'error',
            message: 'Choose either task mode or keep mode, not both.',
          }
        }
        taskMode = nextTaskMode
      }
      input = input.slice(modifier[0].length).trim()
      continue
    }

    if (/^--nudges(?:\s|$)/i.test(input)) {
      const nudgePrefix = input.match(/^--nudges\s*/i)?.[0] ?? ''
      const nudgeValue = input
        .slice(nudgePrefix.length)
        .match(/^(\S+)(?:\s+|$)/)?.[1]
      const parsed = parseNudges(nudgeValue)
      if (!nudgeValue || parsed === undefined) {
        return {
          kind: 'error',
          message: `Nudge count must be an integer from 1 to ${MAX_NUDGES}.`,
        }
      }
      nudges = parsed
      input = input
        .slice(nudgePrefix.length + nudgeValue.length)
        .trim()
      continue
    }

    break
  }

  if (!input) {
    return {
      kind: 'error',
      message:
        'Usage: /persist task [plan] [--nudges N] <goal> | [plan] [keep] [--nudges N] <task> | status | pause | resume | clear | complete',
    }
  }

  return {
    kind: 'task',
    options: {
      task: input,
      mode,
      keep: taskMode === 'keep',
      taskMode,
      nudges,
    },
  }
}

export function decidePersistStop(
  state: PersistState | undefined,
  messages: Message[],
  signal?: AbortSignal,
  context?: { chainId?: string; depth?: number; stopHookActive: boolean },
): PersistStopDecision {
  if (!state) return { kind: 'allow', reason: 'inactive' }
  if (signal?.aborted) {
    return { kind: 'allow', reason: 'cancelled' }
  }

  const status = getStateStatus(state)
  if (status === 'paused' || status === 'blocked') return { kind: 'allow', reason: 'inactive' }
  if (status === 'completed') return { kind: 'allow', reason: 'completed' }
  if (status === 'cleared') return { kind: 'allow', reason: 'cleared' }
  if (status === 'exhausted') {
    return { kind: 'allow', reason: 'budget-exhausted' }
  }
  // The heartbeat already gave up on this goal. Reaching here means the hook
  // survived a disarm it should not have - the status arm below is what stops
  // the loop, and this keeps the two ends consistent.
  if (status === 'stalled') return { kind: 'allow', reason: 'no-progress' }

  if (!context?.chainId) return { kind: 'allow', reason: 'inactive' }

  if (state.initialPlanningResponseAllowed) {
    state.initialPlanningResponseAllowed = false
    return { kind: 'allow', reason: 'planning-response' }
  }

  if (!context.stopHookActive) {
    return { kind: 'allow', reason: 'inactive' }
  }

  // Continuation modes use the nudge budget only as an initial reminder count.
  // Unlike bounded mode, reaching zero never disarms the in-process Stop hook.
  const taskMode = getTaskMode(state)
  if (state.nudgesRemaining === 0 && taskMode === 'bounded') {
    state.status = 'exhausted'
    return { kind: 'allow', reason: 'budget-exhausted' }
  }

  // Continuation modes have no budget ceiling, so the only thing standing
  // between a session that answers every heartbeat with prose and an unbounded
  // loop is a progress check. A heartbeat that finds no more progress than the
  // last one did is not driving anything; after a short run of those the loop
  // is what it is and the goal goes back to waiting for the user.
  if (isContinuationMode(state)) {
    const workMark = progressSignature(state, messages)
    state.stalledHeartbeats =
      state.workMark !== undefined && workMark === state.workMark
        ? (state.stalledHeartbeats ?? 0) + 1
        : 0
    state.workMark = workMark
    if (state.stalledHeartbeats >= MAX_STALLED_HEARTBEATS) {
      state.status = 'stalled'
      return { kind: 'allow', reason: 'no-progress' }
    }
  }

  if (state.nudgesRemaining > 0) state.nudgesRemaining -= 1
  state.nudgesSent += 1
  const lastUser = getLastUserText(messages)
  const task = tail(state.task, MAX_TASK_CONTEXT_LENGTH)
  const userContext = lastUser
    ? ` Latest user context: ${tail(lastUser, MAX_USER_CONTEXT_LENGTH)}`
    : ''
  const countText = isContinuationMode(state)
    ? `${state.nudgesSent}`
    : `${state.nudgesSent} of ${state.nudgesSent + state.nudgesRemaining}`
  const continuationText = taskMode === 'task'
    ? ' Task heartbeat remains armed beyond the initial nudge budget. Continue through useful implementation, integration, and verification work. Do not yield after a small step or claim completion without goal-wide doneWhen evidence recorded through persist-review complete. Stop for explicit pause, complete, or clear; abort or provider/API failure; persist-review blocked; or a genuine unworkable blocker.'
    : taskMode === 'keep'
      ? ' This task remains active until explicit completion through persist-review complete with evidence or /persist complete; do not infer completion from prose.'
      : ' Stop normally only if the task is genuinely complete or all remaining work has an unworkable blocker requiring user input or access.'
  const message = `Persist ${taskMode === 'task' ? 'task heartbeat' : 'reminder'} (${countText}). Active task: ${task}.${userContext} ${deliveryDirection(state.delivery)}${continuationText}`
  return {
    kind: 'nudge',
    nudgesRemaining: state.nudgesRemaining,
    message,
  }
}

async function loadPersistRecord(
  sessionId: string,
  transcriptPath?: string,
): Promise<PersistSessionRecord | null> {
  await flushPersistWrites(sessionId)
  const record = await readPersistSessionRecord(transcriptPath ?? getTranscriptPath())
  if (record) persistRecords.set(sessionId, record)
  else persistRecords.delete(sessionId)
  publishPersist()
  return record
}

function statusText(record: PersistSessionRecord | undefined): string {
  if (!record) return 'No persist task recorded in this session.'
  const status = record.status
  const taskMode = record.taskMode
  const task = record.task
  if (status === 'paused' || status === 'blocked') return `Persist goal ${status} (${taskMode}, task retained): ${task}`
  if (status === 'stalled') {
    return `Persist goal stalled (${taskMode}, task retained): ${task}\nAutomatic heartbeats stopped after ${MAX_STALLED_HEARTBEATS} that produced no work. Use /persist resume when you want the heartbeat re-armed.`
  }
  if (status === 'completed') return `Completed persist task (${taskMode}): ${task}`
  if (status === 'cleared') return `Cleared persist task (${taskMode}): ${task}`
  if (status === 'exhausted') {
    return `Persist task reminder budget exhausted (${record.mode}, bounded, task retained): ${task}`
  }
  const budget = taskMode === 'bounded'
    ? `${record.nudgesRemaining} ${plural(record.nudgesRemaining, 'nudge')} remaining`
    : `${record.nudgesRemaining} initial ${plural(record.nudgesRemaining, 'nudge')} remaining; continuation stays armed`
  return `Active persist task (${record.mode}, ${taskMode}, ${budget}): ${task}${record.delivery ? `\n${deliveryDirection(record.delivery)}` : ''}`
}

async function clearPersist(
  sessionId: string,
  transcriptPath?: string,
): Promise<string> {
  const runtime = persistRuntime.get(sessionId)
  const resolvedTranscriptPath =
    transcriptPath ?? runtime?.transcriptPath ?? getTranscriptPath()
  const record = await loadPersistRecord(sessionId, resolvedTranscriptPath)
  if (!record) return 'No persist task recorded in this session.'
  if (record.status === 'cleared') return 'No active persist task in this session.'

  const cleared: PersistSessionRecord = {
    ...record,
    status: 'cleared',
    initialPlanningResponseAllowed: false,
  }
  await queuePersistWrite(sessionId, cleared, resolvedTranscriptPath)
  detachPersistRuntime(sessionId)
  persistRecords.set(sessionId, cleared)
  publishPersist()
  return 'Cleared and released the persist task for this session.'
}

async function completePersist(
  sessionId: string,
  transcriptPath?: string,
): Promise<string> {
  const runtime = persistRuntime.get(sessionId)
  const resolvedTranscriptPath =
    transcriptPath ?? runtime?.transcriptPath ?? getTranscriptPath()
  const record = await loadPersistRecord(sessionId, resolvedTranscriptPath)
  if (!record) return 'No persist task recorded in this session.'
  if (record.status === 'completed') return 'The persist task is already complete.'
  if (record.status === 'cleared') return 'No active persist task in this session.'

  const completed: PersistSessionRecord = {
    ...record,
    status: 'completed',
    initialPlanningResponseAllowed: false,
  }
  await queuePersistWrite(sessionId, completed, resolvedTranscriptPath)
  detachPersistRuntime(sessionId)
  persistRecords.set(sessionId, completed)
  publishPersist()
  return 'Completed the persist task for this session.'
}

async function installPersistRuntime(
  record: PersistSessionRecord,
  sessionId: string,
  setAppState: SetAppState,
  transcriptPath: string,
): Promise<void> {
  const hookId = getPersistHookId(sessionId)
  // Remove both the runtime entry and any stale hook carrying the stable ID.
  // This makes resume restoration idempotent even after a partial prior setup.
  detachPersistRuntime(sessionId)
  removeFunctionHook(setAppState, sessionId, 'Stop', hookId)

  const state = stateFromRecord(record, hookId)
  const pendingNudges = new WeakMap<Message[], string>()
  let evaluating = false
  const evaluate = async (messages: Message[], signal?: AbortSignal, context?: { chainId?: string; depth?: number; stopHookActive: boolean }) => {
    const runtime = persistRuntime.get(sessionId)
    if (!runtime || runtime.pendingNudges !== pendingNudges) return true

    if (context?.chainId && runtime.state.initialPlanningResponseAllowed && !signal?.aborted) {
      const planned = { ...runtime.state, initialPlanningResponseAllowed: false }
      await queuePersistWrite(sessionId, recordFromState(planned), transcriptPath)
      if (persistRuntime.get(sessionId) !== runtime) return true
      runtime.state = planned
      cacheState(sessionId, planned)
      return true
    }
    if (context?.chainId) {
      const requiresReviewAuthorization = getTaskMode(runtime.state) === 'keep'
      if (requiresReviewAuthorization && runtime.reviewedChain !== context.chainId && runtime.requestedReviewChain !== context.chainId && !signal?.aborted) {
        runtime.requestedReviewChain = context.chainId
        pendingNudges.set(messages, `Review the kept goal using persist-review checkpoint JSON at a meaningful checkpoint; continue when useful work remains, unrelated for this conversation, blocked with a genuine dependency, or complete only with goal-wide verification evidence. Do not review after every tiny edit. Latest user instructions take precedence. ${deliveryDirection(runtime.state.delivery)}`)
        return false
      }
      if (requiresReviewAuthorization && (runtime.reviewedChain !== context.chainId || runtime.reviewOutcome !== 'continue')) return true
      context = { ...context, stopHookActive: true }
    }
    const nextState = { ...runtime.state }
    const decision = decidePersistStop(nextState, messages, signal, context)
    if (decision.kind === 'allow') {
      const currentRecord = recordFromState(nextState)
      if (
        decision.reason === 'budget-exhausted' ||
        decision.reason === 'no-progress' ||
        decision.reason === 'completed' ||
        decision.reason === 'cleared'
      ) {
        await queuePersistWrite(sessionId, currentRecord, transcriptPath)
        detachPersistRuntime(sessionId)
      } else if (decision.reason === 'planning-response') {
        await queuePersistWrite(sessionId, currentRecord, transcriptPath)
      }
      runtime.state = nextState
      cacheState(sessionId, nextState)
      return true
    }

    if (signal?.aborted || runtime.pendingDelivery) return true
    runtime.pendingDelivery = { chainId: context!.chainId!, next: nextState }
    runtime.reviewOutcome = undefined
    pendingNudges.set(messages, decision.message)
    return false
  }

  const callback: typeof evaluate = async (...args) => {
    if (evaluating) return true
    evaluating = true
    try {
      return await serializePersistOperation(sessionId, () => evaluate(...args))
    } finally {
      evaluating = false
    }
  }

  const installedHookId = addFunctionHook(
    setAppState,
    sessionId,
    'Stop',
    '',
    callback,
    messages =>
      pendingNudges.get(messages) ??
      'Persist task is no longer active. Stop normally.',
    { id: hookId },
  )
  persistRuntime.set(sessionId, {
    state: { ...state, hookId: installedHookId },
    setAppState,
    hookId: installedHookId,
    transcriptPath,
    pendingNudges,
  })
}

/**
 * Restore the current session's durable task and recreate its runtime hook.
 * Safe to call more than once during resume: a stable hook ID is removed
 * before the callback is installed.
 */
export async function restorePersistForCurrentSession(
  setAppState: SetAppState,
  transcriptPath = getTranscriptPath(),
): Promise<PersistSessionRecord | null> {
  const sessionId = getSessionId()
  return serializePersistOperation(sessionId, async () => {
  detachOtherPersistRuntimes(sessionId)
  const record = await loadPersistRecord(sessionId, transcriptPath)
  if (getSessionId() !== sessionId) return record
  if (!record || record.status !== 'active') {
    detachPersistRuntime(sessionId)
    removeFunctionHook(setAppState, sessionId, 'Stop', getPersistHookId(sessionId))
    return record
  }
  await installPersistRuntime(record, sessionId, setAppState, transcriptPath)
  return record
  })
}

export async function controlPersistGoal(action: 'pause' | 'resume' | 'complete' | 'clear', setAppState: SetAppState): Promise<void> {
  const sessionId = getSessionId()
  const transcriptPath = getTranscriptPath()
  return serializePersistOperation(sessionId, async () => {
  if (action === 'complete') { await completePersist(sessionId, transcriptPath); return }
  if (action === 'clear') { await clearPersist(sessionId, transcriptPath); return }
  const record = await loadPersistRecord(sessionId, transcriptPath)
  if (!record || record.status === 'completed' || record.status === 'cleared') return
  const next: PersistSessionRecord = { ...record, status: action === 'pause' ? 'paused' : 'active' }
  await queuePersistWrite(sessionId, next, transcriptPath)
  persistRecords.set(sessionId, next)
  detachPersistRuntime(sessionId)
  if (next.status === 'active' && getSessionId() === sessionId) await installPersistRuntime(next, sessionId, setAppState, transcriptPath)
  publishPersist()
  })
}

export async function settlePersistDelivery(sessionId: string, chainId: string | undefined, delivered: boolean): Promise<void> {
  await serializePersistOperation(sessionId, async () => {
    const runtime = persistRuntime.get(sessionId)
    const pending = runtime?.pendingDelivery
    if (!runtime || !pending || pending.chainId !== chainId) return
    if (delivered) {
      await queuePersistWrite(sessionId, recordFromState(pending.next), runtime.transcriptPath)
      runtime.state = pending.next
      cacheState(sessionId, runtime.state)
    }
    runtime.pendingDelivery = undefined
  })
}

export function registerPersistSkill(): void {
  registerBundledSkill({
    name: 'persist-review',
    description: `At meaningful checkpoints or attempted stops use checkpoint JSON: {kind: advanced|learned|delivered|detoured, phase: implement|integrate|harden, outcome, doneWhen, next, deferred, evidence}. All other fields are strings. delivered means a milestone, not goal completion. Alternatively use continue, unrelated, blocked, or complete followed by evidence. ${TASK_BLOCKER_REVIEW_GUIDANCE} Do not review after every edit.`,
    userInvocable: true,
    async getPromptForCommand(args, context) {
      const match = args.trim().match(/^(checkpoint|continue|unrelated|blocked|complete)\s+([\s\S]+)$/)
      const sessionId = getSessionId()
      const reviewTranscriptPath = getRuntimeTranscriptPath(context)
      const reviewedGoal = persistRecords.get(sessionId)
      const reviewedRuntime = persistRuntime.get(sessionId)
      return serializePersistOperation<ContentBlockParam[]>(sessionId, async () => {
      if (getSessionId() !== sessionId || persistRecords.get(sessionId)?.task !== reviewedGoal?.task || (reviewedRuntime && persistRuntime.get(sessionId) !== reviewedRuntime)) {
        return [{ type: 'text', text: 'Goal changed before review; review the current goal instead.' }]
      }
      let runtime = persistRuntime.get(sessionId)
      if (!context.agentId && !runtime && match?.[2]?.trim() && context.queryTracking?.chainId) {
        const record = persistRecords.get(sessionId)
        if (record?.status === 'exhausted' && (match[1] === 'complete' || match[1] === 'blocked')) {
          await installPersistRuntime(record, sessionId, context.setAppState, reviewTranscriptPath)
          runtime = persistRuntime.get(sessionId)
        }
      }
      if (context.agentId || !runtime || !match || !match[2]?.trim() || !context.queryTracking?.chainId) {
        return [{ type: 'text', text: 'Goal review requires an active main-session goal, query identity, outcome and evidence.' }]
      }
      let delivery = runtime.state.delivery
      if (match[1] === 'checkpoint') {
        try {
          delivery = advanceDelivery(delivery, parseDeliveryReview(match[2]!))
        } catch {
          return [{ type: 'text', text: 'Invalid checkpoint. Supply JSON with kind (advanced|learned|delivered|detoured), phase (implement|integrate|harden), outcome, doneWhen, next, deferred, evidence. Keep outcome and doneWhen until delivered; advance at most one phase on delivery. No continuation authorized.' }]
        }
      } else if (match[1] === 'continue' && delivery) {
        delivery = advanceDelivery(delivery, { ...delivery, kind: 'advanced', evidence: match[2]!.trim().slice(0, 1200) })
      }
      const reviewedState = { ...runtime.state, delivery, reviewEvidence: match[2]!.trim().slice(0, 8000) }
      await queuePersistWrite(sessionId, recordFromState(reviewedState), runtime.transcriptPath)
      if (persistRuntime.get(sessionId) !== runtime || getSessionId() !== sessionId) {
        return [{ type: 'text', text: 'Session or goal changed during review; no continuation authorized.' }]
      }
      runtime.state = reviewedState
      cacheState(sessionId, reviewedState)
      if (match[1] === 'complete') {
        if (getTaskMode(runtime.state) === 'task' && !runtime.state.delivery) {
          return [{
            type: 'text',
            text: 'Task mode completion needs a meaningful delivery checkpoint with a substantial outcome, doneWhen condition, and concrete evidence. Record it with persist-review checkpoint, or use /persist complete as an explicit manual override. The task heartbeat remains active.',
          }]
        }
        return [{ type: 'text', text: await completePersist(sessionId, runtime.transcriptPath) }]
      }
      if (match[1] === 'blocked') {
        if (getTaskMode(runtime.state) === 'task') {
          const blocker = parseTaskBlocker(match[2]!)
          if (!blocker) {
            return [{ type: 'text', text: `Task mode remains active. ${TASK_BLOCKER_REVIEW_GUIDANCE}` }]
          }
          runtime.state = { ...runtime.state, reviewEvidence: JSON.stringify(blocker) }
        }
        const record = { ...recordFromState(runtime.state), status: 'blocked' as const }
        await queuePersistWrite(sessionId, record, runtime.transcriptPath)
        persistRecords.set(sessionId, record)
        detachPersistRuntime(sessionId)
        publishPersist()
        return [{ type: 'text', text: 'Goal blocked and retained. Use /persist resume when the blocker is resolved.' }]
      }
      runtime.reviewedChain = context.queryTracking.chainId
      runtime.reviewOutcome = match[1] === 'checkpoint' ? 'continue' : match[1] as 'continue' | 'unrelated' | 'blocked'
      return [{ type: 'text' as const, text: `Goal review recorded: ${match[1]}. Original goal retained.` }]
      })
    },
  })
  registerBundledSkill({
    name: 'persist',
    description:
      'Keep a bounded reminder, retain a kept goal, or run an ordinary task with in-process continuation until verified completion.',
    argumentHint:
      'task [plan] [--nudges N] <goal> | [plan] [keep] [--nudges N] <task> | status | pause | resume | clear | complete',
    userInvocable: true,
    async getPromptForCommand(args, context) {
      if (context.agentId) {
        return [
          {
            type: 'text',
            text: '/persist is available only in the main session.',
          },
        ]
      }
      // Any session may hold a goal, a leaf included, and either side can arm
      // one: the person types this, or a model invokes it on their instruction so
      // the heartbeat keeps that agent driving to completion. A subagent is
      // refused above and a peer's message is queued with slash commands skipped,
      // so a goal is only ever armed deliberately inside a session, never
      // injected from outside it. A leaf's work is bounded by the message that
      // started it only until a goal says otherwise.

      const sessionId = getSessionId()
      const parsed = parsePersistArgs(args)
      const transcriptPath = getRuntimeTranscriptPath(context)
      return serializePersistOperation<ContentBlockParam[]>(sessionId, async () => {

      if (parsed.kind === 'pause' || parsed.kind === 'resume') {
        const record = await loadPersistRecord(sessionId, transcriptPath)
        if (!record || record.status === 'completed' || record.status === 'cleared') {
          return [{ type: 'text', text: 'No unfinished goal to change.' }]
        }
        const next: PersistSessionRecord = { ...record, status: parsed.kind === 'pause' ? 'paused' : 'active' }
        await queuePersistWrite(sessionId, next, transcriptPath)
        persistRecords.set(sessionId, next)
        detachPersistRuntime(sessionId)
        if (next.status === 'active' && getSessionId() === sessionId) await installPersistRuntime(next, sessionId, context.setAppState, transcriptPath)
        publishPersist()
        return [{ type: 'text', text: `Goal ${next.status}; original task retained.` }]
      }
      if (parsed.kind === 'status') {
        const record = await loadPersistRecord(sessionId, transcriptPath)
        return [{ type: 'text', text: statusText(record ?? undefined) }]
      }
      if (parsed.kind === 'clear') {
        return [
          {
            type: 'text',
            text: await clearPersist(sessionId, transcriptPath),
          },
        ]
      }
      if (parsed.kind === 'complete') {
        return [
          {
            type: 'text',
            text: await completePersist(sessionId, transcriptPath),
          },
        ]
      }
      if (parsed.kind === 'error') {
        return [{ type: 'text', text: parsed.message }]
      }

      const record: PersistSessionRecord = {
        version: 1,
        task: parsed.options.task,
        mode: parsed.options.mode,
        keep: parsed.options.keep,
        taskMode: parsed.options.taskMode,
        nudgesRemaining: parsed.options.nudges,
        nudgesSent: 0,
        status: 'active',
        initialPlanningResponseAllowed: parsed.options.mode === 'plan',
      }
      await queuePersistWrite(sessionId, record, transcriptPath)
      persistRecords.set(sessionId, record)
      publishPersist()
      if (getSessionId() !== sessionId) return [{ type: 'text', text: 'Goal saved to the original session.' }]
      await installPersistRuntime(
        record,
        sessionId,
        context.setAppState,
        transcriptPath,
      )

      let planText = 'Begin working on the task now.'
      if (parsed.options.mode === 'plan') {
        planText =
          'Your first response must define the persistent goal, describe the current state, and list concrete completion criteria before work begins. Ask the user only questions that materially affect the work. This lightweight planning step does not enter the CLI plan mode; after the user responds, execute the task.'
      }
      const modeText = parsed.options.taskMode === 'task'
        ? ` This is task mode. The in-process Stop-hook heartbeat is armed now and restored on session resume. It continues beyond the initial ${parsed.options.nudges}-${plural(parsed.options.nudges, 'nudge')} budget while useful work remains, rather than yielding after a small step. Define a substantial outcome and doneWhen condition, work through implementation and integration, and use persist-review at meaningful checkpoints—not after every tiny edit. Complete only with concrete goal-wide verification evidence. Explicit /persist pause, /persist complete, /persist clear, persist-review blocked, aborts, provider/API failures, and genuine unworkable blockers stop continuation.`
        : parsed.options.taskMode === 'keep'
          ? ' This is a kept goal: it remains active until explicit completion through persist-review complete with evidence or /persist complete. Do not infer completion or clear it from prose. --nudges sets the initial reminder count, not a keep-mode limit.'
          : ` This goal is stored durably across restart and resume. Automatic follow-up is bounded to ${parsed.options.nudges} ${plural(parsed.options.nudges, 'nudge')}; exhaustion retains the goal without further automatic reminders.`
      return [
        {
          type: 'text',
          text: `# Active persist task (${parsed.options.taskMode})\n\nTask:\n<user_task>\n${escapeXml(parsed.options.task)}\n</user_task>\n\n${planText} Keep this task in mind across the current turn. ${deliveryDirection()}${modeText} For every mode, record completion with evidence or record a genuine blocker using persist-review. Continuation modes proceed automatically only while useful work remains and the latest user instruction permits it.`,
        },
      ]
      })
    },
  })
}
