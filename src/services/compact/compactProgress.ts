import type { ToolUseContext } from '../../Tool.js'
import { createChildAbortController } from '../../utils/abortController.js'

export type CompactProgressPhase = 'pre_hooks' | 'summarizing' | 'post_hooks'

export type CompactProgressEvent =
  | {
      type: 'hooks_start'
      hookType: 'pre_compact' | 'post_compact' | 'session_start'
    }
  | { type: 'compact_start' }
  | {
      type: 'compact_progress'
      phase: CompactProgressPhase
      elapsedMs: number
      attempt?: number
    }
  | { type: 'compact_end' }

export type CompactProgressContext = Pick<
  ToolUseContext,
  'onCompactProgress' | 'setSDKStatus' | 'setStreamMode' | 'setResponseLength'
>

export const COMPACT_PROGRESS_INTERVAL_MS = 5_000
export const DEFAULT_COMPACTION_TIMEOUT_MS = 5 * 60 * 1_000
export const ERROR_MESSAGE_COMPACTION_TIMEOUT =
  'Compaction timed out before it completed. Please try again.'

const COMPACTION_REFUSAL_PREFIX =
  'The model provider refused the summarization request'

/**
 * The route was refusing the summarization request, so the cause is capacity,
 * not a stalled stream — saying "timed out" would send the user back to the
 * same refusing route.
 */
export function compactionRefusalMessage(status: number): string {
  return `${COMPACTION_REFUSAL_PREFIX} (HTTP ${status}) — the conversation was not compacted. Try again, or switch models.`
}

/** The HTTP status a provider gave us, unwrapping a retry wrapper. */
export function errorStatus(error: unknown): number | null {
  const cause =
    (error as { originalError?: unknown } | null)?.originalError ?? error
  const status = (cause as { status?: unknown } | null)?.status
  return typeof status === 'number' ? status : null
}

function isCompactionRefusal(error: unknown): boolean {
  const message = (error as { message?: unknown } | null)?.message
  return (
    typeof message === 'string' && message.startsWith(COMPACTION_REFUSAL_PREFIX)
  )
}

/**
 * The route answered, and the answer was "not now". Those failures come back
 * in seconds and the provider recovers on its own, so they are not the
 * irreversible failure (the context itself is over the limit) that the
 * auto-compact circuit breaker exists to stop retrying.
 *
 * A stall is deliberately not included: nothing answered, each attempt costs
 * the whole compaction deadline, and a stall that repeats is what the breaker
 * is for.
 */
export function isTransientCompactionFailure(error: unknown): boolean {
  if (isCompactionRefusal(error)) return true
  const status = errorStatus(error)
  return status === 429 || (status !== null && status >= 500)
}

export function getCompactionTimeoutMs(): number {
  const configured = Number.parseInt(
    process.env.CLAUDE_CODE_COMPACTION_TIMEOUT_MS ?? '',
    10,
  )
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_COMPACTION_TIMEOUT_MS
}

/** A provider failure that arrived before the summary produced any output. */
export type CompactionRefusal = {
  status: number
  message: string
}

/**
 * Gives compaction its own deadline-bound child controller.
 *
 * A compaction request can involve hooks, a forked query, provider streaming,
 * and post-compaction restoration. Aborting the main controller on timeout
 * would cancel the user's entire session, so only the child is aborted here.
 *
 * The deadline measures *silence*, not wall clock: it is refreshed whenever
 * the provider shows it is working. Summarizing a long conversation is slow -
 * routes that reason before answering can spend minutes on that and the first
 * visible token may only arrive near the end - so counting those minutes as a
 * stall would abort a compaction that was never in trouble. Refreshing on
 * anything the provider emits, and on text the summary streams, keeps the
 * deadline aimed at the failure it exists for: a request nothing is serving.
 * A refusal never streams anything, so it is recorded here to explain an
 * expiry that would otherwise read as a stall.
 */
export function createCompactionContext(context: ToolUseContext): {
  context: ToolUseContext
  didTimeout: () => boolean
  noteActivity: () => void
  noteRefusal: (refusal: CompactionRefusal) => void
  lastRefusal: () => CompactionRefusal | null
  cleanup: () => void
} {
  const abortController = createChildAbortController(context.abortController)
  const timeoutMs = getCompactionTimeoutMs()
  let timedOut = false
  const expire = () => {
    timedOut = true
    abortController.abort(new Error(ERROR_MESSAGE_COMPACTION_TIMEOUT))
  }
  const timer = setTimeout(expire, timeoutMs)
  const hardTimer = setTimeout(expire, timeoutMs * 3)
  timer.unref?.()
  hardTimer.unref?.()
  let responseLength = 0
  let refusal: CompactionRefusal | null = null
  const refresh = () => {
    if (!abortController.signal.aborted) timer.refresh()
  }

  return {
    context: {
      ...context,
      abortController,
      setResponseLength: update => {
        const nextLength = typeof update === 'function' ? update(responseLength) : update
        if (nextLength > responseLength) refresh()
        responseLength = nextLength
        context.setResponseLength?.(update)
      },
    },
    didTimeout: () => timedOut,
    // Anything the provider sent - a delta, a block boundary, a keepalive it
    // emitted while it works on an answer the client cannot see yet - is
    // evidence the request is being served.
    noteActivity: refresh,
    // Output in hand means the clock was being refreshed, so a refusal seen
    // after it is not what ran the deadline down.
    noteRefusal: next => {
      if (responseLength === 0 && !abortController.signal.aborted) refusal = next
    },
    lastRefusal: () => refusal,
    cleanup: () => { clearTimeout(timer); clearTimeout(hardTimer) },
  }
}

export function startCompactProgressHeartbeat(
  context: CompactProgressContext,
  intervalMs = COMPACT_PROGRESS_INTERVAL_MS,
) {
  const startedAt = Date.now()
  let phase: CompactProgressPhase = 'pre_hooks'
  let attempt: number | undefined

  const emit = () => {
    context.onCompactProgress?.({
      type: 'compact_progress',
      phase,
      elapsedMs: Date.now() - startedAt,
      ...(attempt === undefined ? {} : { attempt }),
    })
  }

  const timer = setInterval(emit, intervalMs)
  timer.unref?.()
  return {
    setPhase(nextPhase: CompactProgressPhase, nextAttempt?: number) {
      phase = nextPhase
      attempt = nextAttempt
      emit()
    },
    stop() {
      clearInterval(timer)
    },
  }
}
