import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * A partner leaf: a headless session a co-engineer leaf owns and works with.
 *
 * This is the capability `tandem` existed to provide, built on parts the harness
 * already has rather than on a launcher that wraps it. Three of the four pieces
 * were already here and are reused unchanged:
 *
 *  - enrollment: print mode already builds a `GatewaySessionRuntime` and registers
 *    its turn-boundary Stop hook (`cli/print.ts`), gated on
 *    `CLAUDE_CODE_USE_GATEWAY`, which `cc.ps1` sets;
 *  - ownership: the leaf-owner pipe (`leafTerminal.ts`), a private endpoint the
 *    owner answers with a secret and the leaf polls, so a partner ends when its
 *    leaf does;
 *  - warming: `cc.ps1 --prewarm`, a build-only entry point that exits before
 *    credentials and the harness.
 *
 * What is added here is the launch itself: spawn a headless session with the
 * owner's endpoint and token, its own identity, and framed stream-json input;
 * hand it the SDK's initialize handshake, whose answer is the only
 * turn-independent proof that it reached its input loop; and bound both the warm
 * build and the startup that follows it, so a launch can neither lose its first
 * prompt to a build nor hold a slot forever behind a session that never comes up.
 *
 * A partner is deliberately NOT a `LeafProcess`. That class is built around an
 * interactive member reached at its own address, and its headless branch still
 * performs a control handshake no print-mode CLI is known to answer - a path with
 * no caller today. Reusing it would mean trusting an unexercised handshake to
 * carry the feature; this spawns the process it actually needs instead.
 */

/**
 * Where `cc.ps1` lives.
 *
 * Resolved the same way the interactive leaf launcher resolves this CLI - from
 * `process.argv[1]` - so there is one rule for "where is this install" rather
 * than a second one that can disagree. `GATEWAY_CC_SCRIPT` overrides it for a
 * layout that does not put the script beside the bundle.
 */
function ccScriptPath(): string {
  const override = process.env.GATEWAY_CC_SCRIPT
  if (override) return override
  return join(dirname(process.argv[1] ?? process.execPath), '..', 'scripts', 'cc.ps1')
}

/**
 * The largest delay `setTimeout` honours.
 *
 * Above this Node clamps the delay to 1ms, so a policy that said anything larger
 * would fire the deadline the instant it was armed and refuse every launch - a
 * bound that fails closed is worse than no bound, because it looks like a real
 * timeout. This is a ceiling on what a policy may claim, not a budget of ours.
 */
const MAX_TIMER_MS = 2_147_483_647

/**
 * How much of an unterminated line is held while waiting for its newline.
 *
 * One frame of this protocol is a small JSON object; a megabyte of output with
 * no newline in it is not this protocol, and holding it would grow memory for as
 * long as the partner runs.
 */
const MAX_LINE_BYTES = 1024 * 1024

/**
 * A millisecond budget, read from the launcher's own policy file.
 *
 * Read from disk beside `cc.ps1` rather than imported at build time, which is the
 * same convention the effort catalogue uses and the reason the launcher and the
 * harness can share one number without a rebuild to change it: the budget is a
 * launch parameter, not a program constant, and two copies of it that drift are
 * exactly how a deadline stops being a deadline.
 *
 * Which is why there is no fallback here. A policy that is missing or malformed
 * is an install whose launch parameters are unknown, and inventing a budget for
 * it would be this file holding the second copy the paragraph above warns about -
 * silently, and only on the machines where the install is already broken. It
 * refuses instead, naming the file and the field, before anything is spawned.
 *
 * Both budgets are validated the same way because both fail the same way: a
 * non-integer, a zero or negative, or a value past what a timer honours is not a
 * deadline. Above `MAX_TIMER_MS` Node clamps the delay to 1ms, so such a policy
 * would fire the instant it was armed and refuse every launch - a bound that
 * fails closed while looking exactly like a real timeout.
 */
function policyMilliseconds(field: 'prewarmTimeoutMs' | 'partnerStartupTimeoutMs', what: string): number {
  const path = join(dirname(ccScriptPath()), 'launcher-policy.json')
  let policy: Record<string, unknown>
  try {
    policy = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch (error) {
    throw new Error(`cannot read the launcher policy at ${path}: ${(error as Error).message}. No partner can be launched without a bounded ${what}`)
  }
  const value = policy[field]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_MS) {
    throw new Error(`${path} must set ${field} to a whole number of milliseconds between 1 and ${MAX_TIMER_MS}; it says ${JSON.stringify(value)}. A ${what} with no usable deadline is refused rather than run`)
  }
  return value
}

/** The bound on the whole warm build, before the partner session itself is started. */
export function prewarmTimeoutMs(): number {
  return policyMilliseconds('prewarmTimeoutMs', 'warm build')
}

/**
 * The bound on a real partner reaching its input loop.
 *
 * The warm build's deadline covers the build; this one covers the session that
 * follows it, so a child that starts and then never gets anywhere cannot sit
 * there holding an admission slot and a name on the roster forever. Nobody has to
 * opt into that protection by asking for a wait - the launch arms it itself, the
 * same way it arms the prewarm - and the budget is the launcher's for the same
 * reason the warm budget is: it is a property of this install, not of the caller.
 *
 * It is a *startup* bound and nothing more. A partner that has answered is a
 * collaborator that may legitimately sit idle between turns for as long as its
 * leaf keeps it, so there is no lifetime or idle timeout here; that is a
 * different decision, and a wrong one to make implicitly.
 */
export function partnerStartupTimeoutMs(): number {
  return policyMilliseconds('partnerStartupTimeoutMs', 'partner startup')
}

/**
 * How many partners one leaf may hold at once.
 *
 * A cap is a decision a leaf states, not a global constant: the value is read
 * per launch so a leaf that legitimately needs more can raise it, and the refusal
 * past the cap names the number rather than failing opaquely. Paired partners
 * that can each spawn partners are unbounded fan-out, which is the shape that
 * takes a machine down rather than the shape that gets work done.
 */
export function maxPartnersPerLeaf(): number {
  const raw = Number(process.env.GATEWAY_PARTNER_LIMIT)
  return Number.isInteger(raw) && raw > 0 ? raw : 2
}

/** The partners each owner session currently holds, so the cap is per owner and not per process. */
const livePartners = new Map<string, Set<string>>()

export function partnerCount(ownerSessionId: string): number {
  return livePartners.get(ownerSessionId)?.size ?? 0
}

/**
 * Take one of the owner's partner slots, or refuse.
 *
 * Synchronous on purpose, and called before the warm build is awaited. The warm
 * build is the first thing that yields, so a cap checked on the far side of it
 * is checked against a count two launches can both have read as empty: a leaf
 * with a cap of one would spawn two partners, and the second would register a
 * set of its own over the first and lose the tracking of it. Reserving here
 * makes the cap a fact about the launch rather than a fact about its timing.
 *
 * The returned release is the only way a slot is given back, so every failure
 * path - a refused warm build, a spawn that throws - returns the slot and leaves
 * the owner exactly as it was found.
 */
function reservePartnerSlot(spec: PartnerSpec): () => void {
  const existing = livePartners.get(spec.ownerSessionId)
  if (existing?.has(spec.sessionId)) {
    throw new Error(`session ${spec.sessionId} is already held as a partner of this leaf`)
  }
  const cap = maxPartnersPerLeaf()
  if ((existing?.size ?? 0) >= cap) {
    throw new Error(`This leaf already holds ${cap} partners; close one before starting another (limit: GATEWAY_PARTNER_LIMIT)`)
  }
  const held = existing ?? new Set<string>()
  held.add(spec.sessionId)
  if (!existing) livePartners.set(spec.ownerSessionId, held)
  return () => {
    held.delete(spec.sessionId)
    if (!held.size) livePartners.delete(spec.ownerSessionId)
  }
}

export type PartnerOwner = { endpoint: string; token: string }

export type PartnerSpec = {
  /** The partner's own session id; it is a session, not a child conversation. */
  sessionId: string
  ownerSessionId: string
  cwd: string
  /** What the roster shows: names the owning leaf and what the partner is for. */
  label: string
  model?: string
  effort?: string
}

export type PartnerHandle = {
  sessionId: string
  /**
   * Where the partner is: `starting` until it answers the launch handshake,
   * `ready` once it has, `failed` if it never did or the process could not be
   * started, `closed` once it has ended. `failed` is kept rather than reset, so a
   * launch that did not come up is still visible after it has been cleaned up.
   */
  getState: () => 'starting' | 'ready' | 'closed' | 'failed'
  /**
   * Wait for the partner to answer the launch handshake, bounded.
   *
   * The launch deliberately does not block on this - a partner reaches its input
   * loop in about as long as any cold session, and holding the caller for that
   * is the stall the non-blocking launch exists to avoid. So the wait is offered
   * rather than imposed: a caller that must not proceed on an unstarted partner
   * bounds it here, and a caller that is content to talk over the bus does not.
   *
   * It answers `false` as soon as the launch is known to have failed, rather than
   * waiting out the caller's bound: a failed partner is not a slow one.
   */
  waitUntilReady: (timeoutMs: number) => Promise<boolean>
  /** Send one framed user message. Resolves true when it was written. */
  deliver: (text: string) => Promise<boolean>
  /** Ask the partner to stop, then make sure it did. */
  close: () => Promise<void>
}

/**
 * Whether an event is the partner answering the handshake this launch sent.
 *
 * The answer to *our* request has to carry *our* request id: that is what makes
 * it proof that this process read a framed request off the input stream and
 * answered it. Nothing weaker will do. A `system/init` frame is the tempting
 * choice and the wrong one — it is emitted per query turn, so a print-mode
 * partner produces it only once the first prompt arrives, which is the moment
 * readiness stops being useful. Anything else on stdout is some other session's
 * output or an unrelated event, and reading it as readiness would declare a
 * partner talkable that has not yet reached its loop.
 *
 * Success is not required, only identity. A refusal still means the request
 * arrived, was parsed, and was answered by the session it was sent to.
 */
function isHandshakeAnswer(event: { type?: string; response?: { request_id?: string } }, requestId: string): boolean {
  return event.type === 'control_response' && event.response?.request_id === requestId
}

/**
 * Kill a process tree, and wait for it.
 *
 * The same containment the interactive launcher uses, for the same reason: a
 * process this one started can leave descendants behind, and a kill that only
 * takes the parent turns a failed launch into an orphan that holds the port and
 * the transcript. `taskkill /T` on Windows, `tree-kill` elsewhere.
 */
async function killTree(pid: number | undefined): Promise<void> {
  if (!pid) return
  await new Promise<void>(resolve => {
    if (process.platform === 'win32') {
      execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { timeout: 10_000, windowsHide: true }, () => resolve())
      return
    }
    void import('tree-kill').then(({ default: kill }) => kill(pid, () => resolve())).catch(() => resolve())
  })
}

/**
 * Warm the bundle before the partner is spawned, or refuse to spawn at all.
 *
 * A cold first dispatch is a build and a session competing for the same window,
 * and the prompt is already on stdin by the time the build finishes. What that
 * costs downstream has not been measured here, so the reason this exists is
 * stated as the guarantee it provides rather than as a diagnosed failure: the
 * input written at launch is not lost to a build that is still running, and the
 * build's deadline is its own - it is answered here, with a number and a
 * failure, instead of being left to surface later as a partner that never took
 * its first turn.
 *
 * The deadline bounds the whole awaited subprocess, not a downstream service, and
 * it comes from the launcher's own policy file so there is one budget rather than
 * a magic number in each side. On expiry the build tree is killed and the launch
 * is refused: a partner spawned over a build that did not finish is exactly the
 * case this exists to prevent.
 */
export async function prewarm(options: { cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }): Promise<void> {
  const timeoutMs = options.timeoutMs ?? prewarmTimeoutMs()
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.env.ComSpec ? 'powershell.exe' : 'pwsh',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ccScriptPath(), '--prewarm'],
      { cwd: options.cwd, env: options.env ?? process.env, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true },
    )
    let settled = false
    const finish = async (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) await killTree(child.pid)
      error ? reject(error) : resolve()
    }
    const timer = setTimeout(() => { void finish(new Error(`prewarm exceeded ${timeoutMs}ms; the build tree was killed and no partner was started`)) }, timeoutMs)
    child.on('error', error => { void finish(new Error(`prewarm could not start: ${error.message}`)) })
    child.on('exit', code => { void finish(code === 0 ? undefined : new Error(`prewarm exited with code ${code ?? 'none'}; no partner was started`)) })
  })
}

/**
 * Launch a partner leaf owned by `owner`, warming first and refusing on failure.
 *
 * Resolves once the process is up and the handshake has been written - not once
 * the partner has answered. A partner is a session: it takes as long to reach
 * its input loop as any cold session, and holding the caller for that is the
 * stall the launch exists to avoid. Readiness is observable instead (`getState`,
 * `waitUntilReady`), so a caller that must not proceed on an unstarted partner
 * can bound the wait rather than discover it later.
 *
 * Reaching that loop is itself bounded, and nobody has to ask for it. A child
 * spawned by this function arms the launcher's startup budget and, if the
 * deadline passes with no answer, is marked failed, has its tree killed, and
 * gives its admission slot back - because a partner that never answers is
 * otherwise a name on the roster and a slot held for as long as the leaf lives,
 * which is a state no caller should have to opt out of.
 */
export async function launchPartner(spec: PartnerSpec, owner: PartnerOwner): Promise<PartnerHandle> {
  // Read before the slot is taken and before the warm build, for the same reason
  // the warm budget is read there: an install whose startup parameters are
  // unknown is refused before anything is spawned, and before a slot is held for
  // a launch that cannot be bounded.
  const startupTimeoutMs = partnerStartupTimeoutMs()
  const release = reservePartnerSlot(spec)

  let child: ChildProcess
  try {
    await prewarm({ cwd: spec.cwd })

    const args = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ccScriptPath(),
      '--print', '--verbose',
      // Framed input, stated rather than inferred: the sender writes stream-json
      // user records, which is a different input mode from a bare prompt argument.
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--session-id', spec.sessionId,
    ]
    if (spec.model) args.push('--model', spec.model)
    if (spec.effort) args.push('--effort', spec.effort)

    child = spawn(
      process.env.ComSpec ? 'powershell.exe' : 'pwsh',
      args,
      {
        cwd: spec.cwd,
        env: {
          ...process.env,
          // The partner is a leaf of the session that started it, so it carries the
          // owner's endpoint and token and runs the same watchdog. It is NOT an
          // interactive leaf: it has no terminal to draw into, and saying otherwise
          // would make it install one it has no audience for.
          GATEWAY_LEAF_SESSION: spec.sessionId,
          GATEWAY_LEAF_LABEL: spec.label,
          GATEWAY_LEAF_OWNER_ENDPOINT: owner.endpoint,
          GATEWAY_LEAF_OWNER_TOKEN: owner.token,
          // The partner is not a leaf of the *terminal* family, so the interactive
          // flag is cleared explicitly rather than merely omitted: inherited from an
          // owning leaf it would be set, and the partner would come up interactive.
          GATEWAY_INTERACTIVE_LEAF: '',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
  } catch (error) {
    // The slot was taken before the first await, so a refusal has to give it back
    // or the leaf would carry a partner it never got.
    release()
    throw error
  }

  let state: 'starting' | 'ready' | 'closed' | 'failed' = 'starting'
  // Readiness and death are separate signals on purpose. A caller waiting on a
  // partner has to be told "no" the moment the launch is known to have failed,
  // rather than at the end of its own bound - otherwise a failed launch reads as
  // a slow one until the caller gives up on it.
  let readySignal: () => void = () => {}
  let settledSignal: () => void = () => {}
  const reported = new Promise<void>(resolve => { readySignal = resolve })
  const settled = new Promise<void>(resolve => { settledSignal = resolve })
  // The handshake this launch sends, so its answer can be told from anything else
  // the session writes.
  const initializeRequestId = randomUUID()
  // Armed at the spawn and never before: the prewarm has its own deadline, and
  // this one is for the session that follows it. Declared here because the stdout
  // handler clears it, and data can arrive before the timer is armed.
  let startupTimer: ReturnType<typeof setTimeout> | undefined
  const clearStartup = () => { if (startupTimer) { clearTimeout(startupTimer); startupTimer = undefined } }
  const onStartupDeadline = async () => {
    if (state !== 'starting') return
    // The failure is kept, not erased: a caller that convened a partner which
    // never came up must be able to see that it failed rather than find the
    // roster quietly empty. The tree goes with it - a session that never reached
    // its input loop can still have left a build or a service running.
    //
    // The state is published before the kill so nothing can still read this as a
    // starting child, but the failure is not *settled* until the tree is gone:
    // `taskkill /T` takes a moment, and a caller told "failed" acts on it - it
    // reports the partner as killed and may end the leaf that owned it - so
    // settling first would let that report, and that exit, race the kill and
    // leave the orphan behind.
    state = 'failed'
    release()
    await killTree(child.pid)
    settledSignal()
  }
  let buffer = ''

  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    buffer += chunk
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!line.trim()) continue
      // Only the parse is guarded, and only for this: a torn line is not a reason
      // to fail the launch. The readiness check is outside it deliberately, so a
      // fault in the readiness path surfaces instead of being swallowed by the
      // same catch that forgives a half-written frame.
      let event: { type?: string; response?: { request_id?: string } }
      try { event = JSON.parse(line) as typeof event } catch { continue }
      if (state === 'starting' && isHandshakeAnswer(event, initializeRequestId)) {
        state = 'ready'
        clearStartup()
        readySignal()
      }
    }
    // Output that never carries a newline - or a stream that is not this protocol
    // at all - would otherwise accumulate here for as long as the partner runs,
    // which is unbounded in the one path that is meant to be cheap. A line past
    // the bound is not a record this protocol produces, so its prefix is dropped;
    // the tail is kept because the newline ending it is what resyncs the reader.
    if (buffer.length > MAX_LINE_BYTES) buffer = buffer.slice(-MAX_LINE_BYTES)
  })
  child.stderr?.on('data', () => {}) // Provider errors can carry credentials; never forward raw stderr.

  // A write to a process that has gone away raises EPIPE on the stream, and an
  // unhandled 'error' on a stream is an uncaught exception in the session that
  // owns the partner - so the failure is taken here and reported by deliver()
  // rather than thrown out of a send.
  let stdinBroken = false
  child.stdin?.on('error', () => { stdinBroken = true })

  child.on('error', () => { clearStartup(); state = 'failed'; release(); settledSignal() })
  child.on('exit', () => {
    clearStartup()
    if (state !== 'failed') state = 'closed'
    stdinBroken = true
    release()
    settledSignal()
  })

  // The first frame is the SDK's initialize handshake, and it does two jobs at
  // once. It is the data a print-mode launcher needs on stdin before it starts
  // the CLI at all - `cc.ps1` refuses an empty pipe - and its answer is the only
  // turn-independent proof that the partner reached its input loop, which is what
  // `deliver` needs and what the startup deadline below is measured against.
  child.stdin?.write(`${JSON.stringify({ type: 'control_request', request_id: initializeRequestId, request: { subtype: 'initialize' } })}\n`)

  startupTimer = setTimeout(() => { void onStartupDeadline() }, startupTimeoutMs)

  return {
    sessionId: spec.sessionId,
    getState: () => state,
    waitUntilReady: (timeoutMs: number) => new Promise<boolean>(resolve => {
      if (state === 'ready') return resolve(true)
      // A failed partner is not answered for until the kill it started has
      // finished. The caller acts on this answer - it reports the partner as
      // killed and may end the leaf that owned it - so answering while the tree
      // is still going would let that report, and that exit, race the kill.
      if (state === 'failed') return void settled.then(() => resolve(false))
      if (state === 'closed') return resolve(false)
      const timer = setTimeout(() => resolve(false), timeoutMs)
      void reported.then(() => { clearTimeout(timer); resolve(true) })
      void settled.then(() => { clearTimeout(timer); resolve(false) })
    }),
    deliver: (text: string) => new Promise<boolean>(resolve => {
      if (state === 'closed' || state === 'failed' || stdinBroken) return resolve(false)
      const stdin = child.stdin
      if (!stdin || stdin.destroyed || stdin.writableEnded) return resolve(false)
      // Resolved from the write callback, not from the call returning: the write
      // is buffered, so returning true here would report a message as delivered
      // that the stream then fails to flush.
      stdin.write(
        `${JSON.stringify({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: spec.sessionId })}\n`,
        error => resolve(!error),
      )
    }),
    close: async () => {
      clearStartup()
      // Already gone - a partner that ended on its own - so there is nothing to
      // end and nothing to wait for. Waiting on an exit that already happened
      // would spend the whole grace period before reporting it as a kill.
      if (child.exitCode !== null || child.signalCode !== null) {
        release()
        state = state === 'failed' ? 'failed' : 'closed'
        return
      }
      child.stdin?.end()
      const graceful = await Promise.race([
        new Promise<boolean>(resolve => child.once('exit', () => resolve(true))),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 5_000)),
      ])
      if (!graceful) await killTree(child.pid)
      release()
      // A partner that failed at startup stays failed after being closed: closing
      // it is cleanup, and cleanup must not rewrite why it ended.
      state = state === 'failed' ? 'failed' : 'closed'
    },
  }
}
