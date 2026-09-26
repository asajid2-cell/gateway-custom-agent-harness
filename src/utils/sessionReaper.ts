import { logForDiagnosticsNoPII } from './diagLogs.js'
import { isEnvTruthy } from './envUtils.js'
import { gracefulShutdown } from './gracefulShutdown.js'
import { isInteractiveLeaf, isLeafClientAttached, leafIdleMs, leafLabel, leafSessionId } from './leafTerminal.js'
import { getSessionIdleMs, isSessionBusy } from './sessionActivity.js'

/**
 * Closing a session that nothing is using.
 *
 * A Windows session has no way to learn that its terminal is gone: the SIGHUP
 * and revoked-TTY detection in gracefulShutdown are POSIX-only, and a session
 * launched console-less never had a console to lose. Leaves are worse - they are
 * detached on purpose so they can outlive the session that forked them, and
 * nothing ever picked them back up. The result was a machine accumulating bun
 * processes nobody could attribute and nothing would close.
 *
 * This is the missing arm. It is deliberately two rules rather than one, because
 * the two roles have different evidence available:
 *
 * - A leaf knows exactly whether anyone is watching (its channel's attach and
 *   detach callbacks). Nobody attached and nothing running is unambiguous, so a
 *   short window is enough - but it must be long enough that a leaf handed
 *   between owners is not closed in the gap.
 * - A root session has no such signal, so it is closed only on a hard fact: the
 *   launcher that owns it is gone. That is checked as a signal-0 probe against
 *   the parent, and a probe that cannot tell (EPERM) counts as alive. On top of
 *   that the window is long, because the cost of being wrong is closing a
 *   session a person is still using, and the cost of waiting is a process idling
 *   for a while longer.
 *
 * Both rules refuse to act while any work is in flight. "Nothing running" is the
 * floor under every decision here.
 */

/** How often the policy is evaluated. A refcount read and a signal-0 probe. */
const CHECK_INTERVAL_MS = 30_000

/**
 * A leaf with nobody attached. Two minutes, because the gap between a parent
 * detaching and the next owner attaching is seconds, and a leaf that is closed
 * while a turn is queued loses work that was already paid for. Busy leaves are
 * excluded regardless of the clock.
 */
const LEAF_IDLE_EXIT_MS = 120_000

/**
 * A root session whose launcher is gone. Thirty minutes: the shortest window
 * that is clearly "has not been used recently at all" rather than "paused for a
 * moment". A session whose launcher died reads the same whether it is five
 * minutes or eighteen hours stale, so there is nothing to gain by reaping early.
 */
const ORPHAN_IDLE_EXIT_MS = 1_800_000

export type ReapRole = 'leaf' | 'root'

export type ReapInput = {
  role: ReapRole
  /** api_call or tool_exec is bracketed right now. */
  busy: boolean
  /** Ms since the last unit of work ended; 0 while busy. */
  idleMs: number
  /** Leaf: a session is attached to this leaf's endpoint. */
  attached: boolean
  /** Root: the launcher process that owns this session still exists. */
  launcherAlive: boolean
  limits: { leafIdleMs: number; rootIdleMs: number }
}

export type ReapDecision =
  | { reap: false; reason: 'busy' | 'attached' | 'launcher-alive' | 'idle-within-window' }
  | { reap: true; reason: 'unattached-leaf-idle' | 'orphaned-root-idle'; idleMs: number }

/**
 * The whole policy, as a pure function, so every branch can be exercised without
 * timers, processes or a live session. Exported for testing.
 */
export function decideReap(input: ReapInput): ReapDecision {
  if (input.busy) return { reap: false, reason: 'busy' }
  if (input.role === 'leaf') {
    if (input.attached) return { reap: false, reason: 'attached' }
    if (input.idleMs < input.limits.leafIdleMs) return { reap: false, reason: 'idle-within-window' }
    return { reap: true, reason: 'unattached-leaf-idle', idleMs: input.idleMs }
  }
  if (input.launcherAlive) return { reap: false, reason: 'launcher-alive' }
  if (input.idleMs < input.limits.rootIdleMs) return { reap: false, reason: 'idle-within-window' }
  return { reap: true, reason: 'orphaned-root-idle', idleMs: input.idleMs }
}

/**
 * Whether the process that launched this session is still running.
 *
 * A root session runs in the foreground of its launcher for its whole life, so a
 * live launcher means a live terminal, and a dead one means nobody can reach
 * this session any more. EPERM is reported as alive: it means the process exists
 * but is not ours to signal, and the unsafe direction here is calling a live
 * launcher dead. A probe that cannot see the parent at all (pid 0 or 1) is dead.
 */
export function isLauncherAlive(pid: number = process.ppid): boolean {
  if (!pid || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function envMs(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  // A non-numeric or non-positive override is ignored rather than honoured: a
  // window of zero would close idle sessions immediately, which is the opposite
  // of what a mistyped threshold should do.
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

let stopCurrent: (() => void) | undefined

export type ReaperOptions = {
  /** Evaluation period. Tests shorten it; there is no reason to in production. */
  intervalMs?: number
  limits?: Partial<{ leafIdleMs: number; rootIdleMs: number }>
  /** Which rule applies. Defaults to what this process actually is. */
  role?: ReapRole
  /** The evidence, read fresh on every check. */
  snapshot?: () => Omit<ReapInput, 'role' | 'limits'>
  /** What to do once the decision is to reap. Defaults to a graceful shutdown. */
  onReap?: (decision: Extract<ReapDecision, { reap: true }>) => void
}

/**
 * Arm the idle reaper for this process, once. Returns the stop function.
 *
 * Called by the session runtime, so it applies to every role that registers on
 * the bus - a root session, a leaf, and a headless session alike - and stops
 * with the runtime rather than outliving it. The timer is unref'd: it must never
 * be the reason a process stays up, only the reason it goes down.
 *
 * The options exist so the real timer, the real policy and the real decision can
 * be driven in a test without a live terminal or a dead launcher; production
 * callers pass nothing.
 */
export function startSessionReaper(options: ReaperOptions = {}): () => void {
  if (stopCurrent) return stopCurrent
  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_IDLE_REAP)) return () => {}
  const role: ReapRole = options.role ?? (isInteractiveLeaf() ? 'leaf' : 'root')
  // A leaf that never opened its own endpoint is unreachable by any session, so
  // "nobody attached" would be true for its whole life and the rule would be
  // acting on a signal it cannot observe. Such a leaf is its launcher's to close.
  if (role === 'leaf' && !leafSessionId()) return () => {}
  const limits = {
    leafIdleMs: options.limits?.leafIdleMs ?? envMs('CLAUDE_CODE_LEAF_IDLE_EXIT_MS', LEAF_IDLE_EXIT_MS),
    rootIdleMs: options.limits?.rootIdleMs ?? envMs('CLAUDE_CODE_SESSION_IDLE_EXIT_MS', ORPHAN_IDLE_EXIT_MS),
  }
  const snapshot = options.snapshot ?? (() => ({
    busy: isSessionBusy(),
    idleMs: role === 'leaf' ? leafIdleMs() : getSessionIdleMs(),
    attached: role === 'leaf' && isLeafClientAttached(),
    launcherAlive: role === 'root' && isLauncherAlive(),
  }))
  const onReap = options.onReap ?? (() => { void gracefulShutdown(0, 'other') })
  let timer: ReturnType<typeof setInterval> | undefined
  const stop = () => {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
    if (stopCurrent === stop) stopCurrent = undefined
  }
  timer = setInterval(() => {
    const evidence = snapshot()
    const decision = decideReap({ role, limits, ...evidence })
    logForDiagnosticsNoPII('debug', 'session_reap_check', {
      role,
      reap: decision.reap,
      reason: decision.reason,
      idle_ms: Math.round(decision.reap ? decision.idleMs : evidence.idleMs),
      label: leafLabel() ?? null,
    })
    if (!decision.reap) return
    stop()
    logForDiagnosticsNoPII('info', 'session_reap', {
      role,
      reason: decision.reason,
      idle_ms: Math.round(decision.idleMs),
      label: leafLabel() ?? null,
    })
    onReap(decision)
  }, options.intervalMs ?? CHECK_INTERVAL_MS)
  timer.unref()
  stopCurrent = stop
  return stop
}
