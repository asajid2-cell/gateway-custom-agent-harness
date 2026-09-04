import { getSessionId, onSessionSwitch } from '../../bootstrap/state.js'
import type { Message } from '../../types/message.js'
import {
  addFunctionHook,
  removeFunctionHook,
} from '../../utils/hooks/sessionHooks.js'
import type { SetAppState } from '../../utils/messageQueueManager.js'
import {
  getAssistantMessageText,
  getLastAssistantMessage,
  getUserMessageText,
} from '../../utils/messages.js'
import { plural } from '../../utils/stringUtils.js'
import { escapeXml } from '../../utils/xml.js'
import { registerBundledSkill } from '../bundledSkills.js'

const DEFAULT_NUDGES = 1
const MAX_NUDGES = 3
const MAX_TASK_CONTEXT_LENGTH = 2000
const MAX_USER_CONTEXT_LENGTH = 1000
const MAX_ASSISTANT_CONTEXT_LENGTH = 500

type PersistMode = 'work' | 'plan'

export type PersistState = {
  task: string
  mode: PersistMode
  nudgesRemaining: number
  nudgesSent: number
  hookId: string
  initialPlanningResponseAllowed: boolean
}

const persistStates = new Map<string, PersistState>()
let activeSession: { id: string; setAppState: SetAppState } | undefined

function clearActiveSession(): void {
  if (!activeSession) return
  const state = persistStates.get(activeSession.id)
  if (state) {
    removeFunctionHook(
      activeSession.setAppState,
      activeSession.id,
      'Stop',
      state.hookId,
    )
  }
  persistStates.clear()
  activeSession = undefined
}

onSessionSwitch(clearActiveSession)

export type PersistOptions = {
  task: string
  mode: PersistMode
  nudges: number
}

export type PersistStopDecision =
  | {
      kind: 'allow'
      reason: 'inactive' | 'planning-response' | 'budget-exhausted' | 'cancelled'
    }
  | { kind: 'nudge'; message: string; nudgesRemaining: number }

function tail(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(-maxLength) : value
}

function getLastUserText(messages: Message[]): string {
  const message = messages.findLast(item => item.type === 'user' && !item.isMeta)
  return message ? (getUserMessageText(message)?.trim() ?? '') : ''
}

function getLastAssistantText(messages: Message[]): string {
  const message = getLastAssistantMessage(messages)
  return message ? (getAssistantMessageText(message)?.trim() ?? '') : ''
}

function parseNudges(value: string | undefined): number | undefined {
  if (!value) return DEFAULT_NUDGES
  const nudges = Number.parseInt(value, 10)
  if (!Number.isInteger(nudges) || nudges < 1 || nudges > MAX_NUDGES) {
    return undefined
  }
  return nudges
}

export function parsePersistArgs(args: string):
  | { kind: 'status' }
  | { kind: 'clear' }
  | { kind: 'task'; options: PersistOptions }
  | { kind: 'error'; message: string } {
  let input = args.trim()
  if (!input || input.toLowerCase() === 'status') return { kind: 'status' }
  if (input.toLowerCase() === 'clear') return { kind: 'clear' }

  let mode: PersistMode = 'work'
  if (/^plan\s*;/i.test(input)) {
    mode = 'plan'
    input = input.replace(/^plan\s*;/i, '').trim()
  }

  let nudges = DEFAULT_NUDGES
  const nudgeMatch = input.match(/^--nudges\s+(\d+)(?:\s+|$)/i)
  if (/^--nudges(?:\s|$)/i.test(input)) {
    const parsed = parseNudges(nudgeMatch?.[1])
    if (!nudgeMatch || parsed === undefined) {
      return {
        kind: 'error',
        message: `Nudge count must be an integer from 1 to ${MAX_NUDGES}.`,
      }
    }
    nudges = parsed
    input = input.slice(nudgeMatch[0].length).trim()
  }

  if (!input) {
    return {
      kind: 'error',
      message: 'Usage: /persist [plan;] [--nudges N] <task>',
    }
  }

  return { kind: 'task', options: { task: input, mode, nudges } }
}

export function decidePersistStop(
  state: PersistState | undefined,
  messages: Message[],
  signal?: AbortSignal,
): PersistStopDecision {
  if (!state) return { kind: 'allow', reason: 'inactive' }
  if (signal?.aborted) {
    return { kind: 'allow', reason: 'cancelled' }
  }
  if (state.initialPlanningResponseAllowed) {
    state.initialPlanningResponseAllowed = false
    return { kind: 'allow', reason: 'planning-response' }
  }
  if (state.nudgesRemaining === 0) {
    return { kind: 'allow', reason: 'budget-exhausted' }
  }

  state.nudgesRemaining -= 1
  state.nudgesSent += 1
  const lastUser = getLastUserText(messages)
  const lastAssistant = getLastAssistantText(messages)
  const task = tail(state.task, MAX_TASK_CONTEXT_LENGTH)
  const userContext = lastUser
    ? ` Latest user context: ${tail(lastUser, MAX_USER_CONTEXT_LENGTH)}`
    : ''
  const assistantContext = lastAssistant
    ? ` Your last response ended with: ${tail(lastAssistant, MAX_ASSISTANT_CONTEXT_LENGTH)}`
    : ''
  const message = `Persist reminder (${state.nudgesSent} of ${state.nudgesSent + state.nudgesRemaining}). Active task: ${task}.${userContext}${assistantContext} Continue only if useful work remains. Check the actual implementation and runtime path, finish remaining verification, and test it. Stop normally if the task is genuinely complete or all remaining work has an unworkable blocker requiring user input or access.`
  return {
    kind: 'nudge',
    nudgesRemaining: state.nudgesRemaining,
    message,
  }
}

function clearPersist(setAppState: SetAppState, sessionId: string): string {
  const state = persistStates.get(sessionId)
  if (!state) return 'No active persist task in this session.'
  removeFunctionHook(setAppState, sessionId, 'Stop', state.hookId)
  persistStates.delete(sessionId)
  if (activeSession?.id === sessionId) activeSession = undefined
  return 'Cleared the active persist task for this session.'
}

function statusText(state: PersistState | undefined): string {
  if (!state) return 'No active persist task in this session.'
  return `Active persist task (${state.mode}, ${state.nudgesRemaining} ${plural(state.nudgesRemaining, 'nudge')} remaining): ${state.task}`
}

export function registerPersistSkill(): void {
  registerBundledSkill({
    name: 'persist',
    description:
      'Keep a bounded reminder on the current task so work does not stop prematurely.',
    argumentHint: '[plan;] [--nudges N] <task> | status | clear',
    userInvocable: true,
    disableModelInvocation: true,
    async getPromptForCommand(args, context) {
      if (context.agentId) {
        return [
          {
            type: 'text',
            text: '/persist is available only in the main session.',
          },
        ]
      }

      const sessionId = getSessionId()
      const parsed = parsePersistArgs(args)

      if (parsed.kind === 'status') {
        return [{ type: 'text', text: statusText(persistStates.get(sessionId)) }]
      }
      if (parsed.kind === 'clear') {
        return [
          {
            type: 'text',
            text: clearPersist(context.setAppState, sessionId),
          },
        ]
      }
      if (parsed.kind === 'error') {
        return [{ type: 'text', text: parsed.message }]
      }

      if (activeSession && activeSession.id !== sessionId) clearActiveSession()
      const existing = persistStates.get(sessionId)
      if (existing) {
        removeFunctionHook(context.setAppState, sessionId, 'Stop', existing.hookId)
      }

      activeSession = { id: sessionId, setAppState: context.setAppState }
      const state: PersistState = {
        task: parsed.options.task,
        mode: parsed.options.mode,
        nudgesRemaining: parsed.options.nudges,
        nudgesSent: 0,
        hookId: '',
        initialPlanningResponseAllowed: parsed.options.mode === 'plan',
      }
      const pendingNudges = new WeakMap<Message[], string>()
      const hookId = addFunctionHook(
        context.setAppState,
        sessionId,
        'Stop',
        '',
        (messages, signal) => {
          const current = persistStates.get(sessionId)
          if (!current || current.hookId !== hookId) return true
          const decision = decidePersistStop(current, messages, signal)
          if (decision.kind === 'allow') {
            if (decision.reason === 'budget-exhausted') {
              persistStates.delete(sessionId)
              if (activeSession?.id === sessionId) activeSession = undefined
              removeFunctionHook(context.setAppState, sessionId, 'Stop', hookId)
            }
            return true
          }
          pendingNudges.set(messages, decision.message)
          return false
        },
        messages =>
          pendingNudges.get(messages) ??
          'Persist task is no longer active. Stop normally.',
      )
      state.hookId = hookId
      persistStates.set(sessionId, state)

      const planText =
        parsed.options.mode === 'plan'
          ? 'First clarify the scope and define concrete completion criteria. Ask the user only questions that materially affect the work. This lightweight planning step does not enter the CLI plan mode; after the user responds, execute the task.'
          : 'Begin working on the task now.'
      return [
        {
          type: 'text',
          text: `# Active persist task\n\nTask:\n<user_task>\n${escapeXml(parsed.options.task)}\n</user_task>\n\n${planText} Keep this task in mind across the current turn. Before stopping, inspect what remains, verify the actual runtime path, and run the relevant tests. This reminder is session-local and bounded to ${parsed.options.nudges} follow-up ${plural(parsed.options.nudges, 'nudge')}; it never runs indefinitely. A genuine completion or an unworkable blocker is a valid stopping point.`,
        },
      ]
    },
  })
}
