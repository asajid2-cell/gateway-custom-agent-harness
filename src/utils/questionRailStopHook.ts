import { getSessionId } from '../bootstrap/state.js'
import { addFunctionHook, removeFunctionHook } from './hooks/sessionHooks.js'
import type { SetAppState } from './messageQueueManager.js'
import { takeQueuedQuestionRailInjections } from './questionRailInjection.js'

/**
 * The Questions-rail Stop hook, registered once per session.
 *
 * An answer or a note has to reach the model even when the turn that was
 * running when it was written has no further tool iteration to drain at, and
 * the only channel from a Stop hook to the model is a blocking error - a hook
 * that allows the stop has no way to say anything. So the callback blocks
 * exactly when rail text is owed and allows the stop otherwise, which keeps the
 * cost to the turns that actually carry an answer instead of every turn end.
 *
 * This is the same mechanism session comms use (gatewayPeerStopHook.ts); the
 * two coexist as separate hooks and each claims only its own origin.
 */

/** Long enough to cover a queue scan and a remove, which are synchronous. */
const QUESTION_RAIL_INJECTION_TIMEOUT_MS = 30_000

/**
 * Spinner label. The hook is registered whether or not an answer is in flight,
 * so without a label a turn ending normally would advertise anonymous hook
 * machinery for the instant the queue scan takes.
 */
const QUESTION_RAIL_INJECTION_STATUS = 'question answer'

const QUESTION_RAIL_HOOK_ID = 'question-rail-inject'

export function registerQuestionRailStopHook(setAppState: SetAppState): () => void {
  const sessionId = getSessionId()
  // Text this firing produced, read by the hook's errorMessage. A Stop hook has
  // no other way to speak, so the claim and the message must agree.
  let lastInjection = ''

  // Adding is not deduplicated, and an effect can mount twice (a strict-mode
  // double invoke, or a remount after a session switch). Removing first makes
  // registration idempotent instead of leaving a second callback that would
  // block a turn it has nothing to inject into.
  removeFunctionHook(setAppState, sessionId, 'Stop', QUESTION_RAIL_HOOK_ID)
  addFunctionHook(
    setAppState,
    sessionId,
    'Stop',
    '', // No matcher - applies to every turn end for this session.
    async () => {
      // Returns true (stop allowed) when nothing is owed, which is the common
      // case: every turn end pays a queue scan and nothing more.
      const text = takeQueuedQuestionRailInjections()
      lastInjection = text ?? ''
      return text === undefined
    },
    () => lastInjection || 'A question answer is waiting.',
    {
      id: QUESTION_RAIL_HOOK_ID,
      timeout: QUESTION_RAIL_INJECTION_TIMEOUT_MS,
      statusMessage: QUESTION_RAIL_INJECTION_STATUS,
    },
  )

  return () => {
    // Scoped to the session it registered for, so a session switch cannot
    // remove a hook another session owns.
    removeFunctionHook(setAppState, sessionId, 'Stop', QUESTION_RAIL_HOOK_ID)
  }
}
