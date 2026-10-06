/**
 * The Codex subscription's rate limits, read from the live app-server.
 *
 * The client used to scrape these from the rollout corpus: read the tail of the
 * newest rollouts, hope the newest one carried a limit, and collapse whatever
 * it found to a single "remaining" figure. That read the wrong thing - the
 * rollout's `primary`/`secondary` were never labelled as an hourly or weekly
 * window - and it cost a spawn per poll.
 *
 * The app-server is the authority instead. One long-lived
 * `codex app-server --listen stdio://` per gateway answers
 * `account/rateLimits/read`, and pushes `account/rateLimits/updated` whenever
 * the account's limits change, so a re-read is only a backstop. The child is
 * started on the first request, killed after a spell with no requests, and
 * respawned with a backoff if it dies.
 *
 * This module returns the shared ProviderQuota windows: `{ H?, W?, M? }` of
 * `{ usedPercent, resetsAt }`, used 0-100 and reset as epoch ms. The window
 * kind comes from each window's own duration, never its position.
 */
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

// A backstop only: the app-server pushes `account/rateLimits/updated` when the
// limits change, so a minute between re-reads is enough to catch a missed push.
const CODEX_READ_INTERVAL_MS = 60_000
// No request for this long and the child is stopped; the next request starts a
// fresh one. Long enough that an idle session still shows a live figure.
const CODEX_IDLE_MS = 5 * 60_000
// The first read is bounded so a wedged app-server cannot hold the route open.
const CODEX_READY_TIMEOUT_MS = 10_000
// A child that dies without ever answering is retried, doubling from five
// seconds to five minutes, and the backoff clears on the first good read.
const CODEX_BACKOFF_BASE_MS = 5_000
const CODEX_BACKOFF_MAX_MS = 5 * 60_000

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** A used percentage clamped to 0-100, or null when it is not a number. */
function clampUsedPercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(100, value))
}

/**
 * A reset instant as epoch milliseconds. The app-server reports seconds, but a
 * value already in milliseconds is left alone rather than multiplied again.
 */
function resetToEpochMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.round(value < 1e12 ? value * 1000 : value)
}

/**
 * The window kind a duration names: a day or less is the short window, up to a
 * fortnight is weekly, anything longer is monthly. The app-server labels its two
 * buckets only `primary` and `secondary`, so position says nothing about which
 * window a figure describes - the duration is the only honest label.
 */
function windowKindForMins(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return null
  if (minutes <= 1440) return 'H'
  if (minutes <= 20160) return 'W'
  return 'M'
}

/**
 * The account's own windows from a `rateLimits` object. Only `primary` and
 * `secondary` are read: `rateLimitsByLimitId` repeats the same buckets under
 * model ids and credits are not a window, so either would only duplicate or
 * mislead. A window with no usable duration is dropped rather than guessed at.
 */
export function codexQuotaWindows(rateLimits) {
  const windows = {}
  if (!rateLimits || typeof rateLimits !== 'object') return windows
  for (const position of ['primary', 'secondary']) {
    const window = rateLimits[position]
    if (!window || typeof window !== 'object') continue
    const used = clampUsedPercent(finiteNumber(window.usedPercent ?? window.used_percent))
    if (used === null) continue
    const kind = windowKindForMins(finiteNumber(window.windowDurationMins ?? window.window_minutes))
    if (!kind) continue
    windows[kind] = {
      usedPercent: used,
      resetsAt: resetToEpochMs(finiteNumber(window.resetsAt ?? window.resets_at)),
    }
  }
  return windows
}

function getCodexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
}

/**
 * How to start the app-server. `MODEL_GATEWAY_CODEX_APP_SERVER` points at a
 * script run under this node, which is the test seam - production always runs
 * the real `codex`.
 */
function codexSpawnSpec() {
  const fake = process.env.MODEL_GATEWAY_CODEX_APP_SERVER
  if (fake) return { command: process.execPath, args: [fake], shell: false }
  const command = process.platform === 'win32'
    ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm', 'codex.cmd')
    : 'codex'
  return {
    command,
    args: ['app-server', '--listen', 'stdio://'],
    // On Windows the spawn is a shell hop into `codex.cmd`, so it is the one
    // console in the subtree: hide it here and every tool the app-server starts
    // below inherits that hidden console instead of asking for one of its own.
    shell: process.platform === 'win32',
  }
}

/**
 * Kill the child and everything below it. `child.kill()` is TerminateProcess on
 * Windows and leaves the `node`/`codex.exe` behind the `cmd` hop orphaned, so
 * the tree is taken down by pid there.
 */
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32' && child.pid) {
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } catch {
      // Best effort: closing stdin below also ends the app-server.
    }
    return
  }
  child.kill()
}

// The newest reading, kept across a child death so a dead app-server still
// serves the last figure - marked stale - rather than nothing.
let snapshot = null
let session = null
let backoffMs = 0
let nextAttemptAt = 0

function send(state, message) {
  try {
    state.child.stdin.write(`${JSON.stringify(message)}\n`)
  } catch {
    // The child is gone; its exit handler tears the session down.
  }
}

function applyRateLimits(rateLimits) {
  const windows = codexQuotaWindows(rateLimits)
  if (Object.keys(windows).length === 0) return
  snapshot = { windows, asof: Date.now() }
  backoffMs = 0
  if (session?.resolveReady) {
    session.resolveReady(true)
    session.resolveReady = null
  }
}

function handleMessage(state, message) {
  if (!message || typeof message !== 'object') return
  if (message.method === 'account/rateLimits/updated') {
    const params = message.params
    const rateLimits = params && typeof params === 'object'
      ? (params.rateLimits && typeof params.rateLimits === 'object' ? params.rateLimits : params)
      : null
    applyRateLimits(rateLimits)
    return
  }
  if (message.id === 1) {
    // The handshake's reply: confirm it, then ask for the limits once.
    send(state, { method: 'initialized', params: {} })
    send(state, { method: 'account/rateLimits/read', id: state.nextId, params: {} })
    state.nextId += 1
    return
  }
  if (typeof message.id === 'number' && message.result && typeof message.result === 'object') {
    applyRateLimits(message.result.rateLimits)
  }
}

function handleStdout(state, chunk) {
  state.buffer += chunk.toString()
  let newline = state.buffer.indexOf('\n')
  while (newline >= 0) {
    const line = state.buffer.slice(0, newline).trim()
    state.buffer = state.buffer.slice(newline + 1)
    newline = state.buffer.indexOf('\n')
    if (!line) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    handleMessage(state, message)
  }
}

function clearTimers(state) {
  if (state.idleTimer) clearTimeout(state.idleTimer)
  if (state.readTimer) clearInterval(state.readTimer)
  state.idleTimer = null
  state.readTimer = null
}

function teardown(state, reason) {
  if (state.closed) return
  state.closed = true
  clearTimers(state)
  if (state.resolveReady) {
    state.resolveReady(false)
    state.resolveReady = null
  }
  killTree(state.child)
  if (session === state) session = null
  // A child that never answered is retried with a growing wait; one that
  // answered and then died is simply restarted on the next request.
  if (!snapshot || snapshot.asof < state.startedAt) {
    backoffMs = backoffMs > 0 ? Math.min(backoffMs * 2, CODEX_BACKOFF_MAX_MS) : CODEX_BACKOFF_BASE_MS
    nextAttemptAt = Date.now() + backoffMs
  }
  process.stderr.write(`model-gateway codex app-server ${reason}\n`)
}

function touchIdle(state) {
  if (state.idleTimer) clearTimeout(state.idleTimer)
  state.idleTimer = setTimeout(() => {
    if (session === state) {
      session = null
      state.closed = true
      clearTimers(state)
      killTree(state.child)
    }
  }, CODEX_IDLE_MS)
  state.idleTimer.unref?.()
}

function startSession() {
  const spec = codexSpawnSpec()
  const child = spawn(spec.command, spec.args, {
    shell: spec.shell,
    env: { ...process.env, CODEX_HOME: getCodexHome() },
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  })
  const state = {
    child,
    buffer: '',
    nextId: 2,
    closed: false,
    startedAt: Date.now(),
    idleTimer: null,
    readTimer: null,
    resolveReady: null,
  }
  state.ready = new Promise(resolve => { state.resolveReady = resolve })
  // Bound the first read: if nothing arrives in time, the route reports what it
  // has rather than waiting on a wedged app-server.
  const readyTimer = setTimeout(() => {
    if (state.resolveReady) {
      state.resolveReady(false)
      state.resolveReady = null
    }
  }, CODEX_READY_TIMEOUT_MS)
  readyTimer.unref?.()
  child.on('error', () => teardown(state, 'failed to start'))
  child.on('exit', () => teardown(state, 'exited'))
  child.stdout.on('data', chunk => handleStdout(state, chunk))
  state.readTimer = setInterval(() => {
    if (!state.closed) send(state, { method: 'account/rateLimits/read', id: state.nextId++, params: {} })
  }, CODEX_READ_INTERVAL_MS)
  state.readTimer.unref?.()
  send(state, {
    method: 'initialize',
    id: 1,
    params: {
      clientInfo: {
        name: 'gateway-footer',
        title: 'Gateway footer quota reader',
        version: '1.0.0',
      },
    },
  })
  return state
}

function ensureSession() {
  if (session && !session.closed) return session
  if (Date.now() < nextAttemptAt) return null
  session = startSession()
  return session
}

/**
 * The Codex subscription's limits as the shared ProviderQuota shape. The first
 * call starts the app-server and waits, bounded, for its answer; later calls
 * return the current snapshot at once, `stale` once it is older than the
 * backstop interval.
 */
export async function readCodexQuota() {
  const state = ensureSession()
  if (state) {
    touchIdle(state)
    if (!snapshot) await state.ready
  }
  if (snapshot) {
    return {
      windows: snapshot.windows,
      asof: snapshot.asof,
      stale: Date.now() - snapshot.asof >= CODEX_READ_INTERVAL_MS,
    }
  }
  return { windows: {}, asof: Date.now(), stale: true }
}

/** Stop the app-server, if one is running. Called on gateway exit. */
export function stopCodexQuota() {
  if (session) teardown(session, 'stopped')
}
