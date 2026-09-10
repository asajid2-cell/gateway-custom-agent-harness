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

export function getCompactionTimeoutMs(): number {
  const configured = Number.parseInt(
    process.env.CLAUDE_CODE_COMPACTION_TIMEOUT_MS ?? '',
    10,
  )
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_COMPACTION_TIMEOUT_MS
}

/**
 * Gives compaction its own deadline-bound child controller.
 *
 * A compaction request can involve hooks, a forked query, provider streaming,
 * and post-compaction restoration. Aborting the main controller on timeout
 * would cancel the user's entire session, so only the child is aborted here.
 */
export function createCompactionContext(context: ToolUseContext): {
  context: ToolUseContext
  didTimeout: () => boolean
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

  return {
    context: {
      ...context,
      abortController,
      setResponseLength: update => {
        const nextLength = typeof update === 'function' ? update(responseLength) : update
        if (nextLength > responseLength && !abortController.signal.aborted) timer.refresh()
        responseLength = nextLength
        context.setResponseLength?.(update)
      },
    },
    didTimeout: () => timedOut,
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
