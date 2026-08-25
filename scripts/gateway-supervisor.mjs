import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const gatewayArgIndex = args.indexOf('--gateway')
const gatewayPath = gatewayArgIndex >= 0
  ? path.resolve(args[gatewayArgIndex + 1])
  : path.join(root, 'model-gateway.mjs')

if (gatewayArgIndex >= 0) {
  args.splice(gatewayArgIndex, 2)
}

// A supervised session must not become permanently disconnected because a
// provider/runtime crash happened several times in one turn. Set a positive
// limit only for diagnostics; zero means unlimited restarts.
const restartLimit = Number(process.env.MODEL_GATEWAY_SUPERVISOR_MAX_RESTARTS || 0)
const restartWindowMs = Number(process.env.MODEL_GATEWAY_SUPERVISOR_WINDOW_MS || 60_000)
const baseDelayMs = Number(process.env.MODEL_GATEWAY_SUPERVISOR_RESTART_BASE_MS || 250)
const maxDelayMs = Number(process.env.MODEL_GATEWAY_SUPERVISOR_RESTART_MAX_MS || 5_000)

if (
  !Number.isInteger(restartLimit) ||
  restartLimit < 0 ||
  !Number.isFinite(restartWindowMs) ||
  restartWindowMs < 0 ||
  !Number.isFinite(baseDelayMs) ||
  baseDelayMs < 0 ||
  !Number.isFinite(maxDelayMs) ||
  maxDelayMs < 0
) {
  throw new Error('Invalid gateway supervisor restart configuration')
}

let child = null
let stopping = false
let restartTimes = []
let restartNumber = 0
let restartTimer = null
let childStartedAt = 0

function log(message) {
  process.stderr.write(`model-gateway supervisor ${message}\n`)
}

function stopChild() {
  if (!child || child.exitCode !== null) return
  child.kill()
}

function shutdown(signal) {
  if (stopping) return
  stopping = true
  if (restartTimer) clearTimeout(restartTimer)
  log(`shutdown signal=${signal}`)
  stopChild()
  if (!child || child.exitCode !== null) process.exit(0)
}

process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGTERM', () => shutdown('SIGTERM'))

function startChild() {
  childStartedAt = Date.now()
  child = spawn(process.execPath, [gatewayPath, ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  })

  child.once('error', error => {
    if (stopping) return
    log(`child-error class=${error?.code || error?.name || 'unknown'}`)
  })

  child.once('exit', (code, signal) => {
    if (stopping) {
      process.exit(0)
      return
    }

    const now = Date.now()
    // A child that stayed healthy for a full restart window starts a new
    // failure epoch. This keeps backoff and diagnostics from accumulating
    // across unrelated transient failures in a long-lived session.
    if (childStartedAt > 0 && now - childStartedAt > restartWindowMs) {
      restartTimes = []
      restartNumber = 0
    }
    restartTimes = restartTimes.filter(timestamp => now - timestamp <= restartWindowMs)
    if (restartLimit > 0 && restartTimes.length >= restartLimit) {
      log(`restart-limit-exhausted attempts=${restartTimes.length}`)
      process.exit(code || 1)
      return
    }

    restartTimes.push(now)
    restartNumber += 1
    const delay = Math.min(maxDelayMs, baseDelayMs * (2 ** Math.max(0, restartNumber - 1)))
    log(
      `child-exit code=${code ?? 'null'} signal=${signal || 'none'} ` +
      `restart=${restartNumber}/${restartLimit} delay_ms=${delay}`,
    )
    restartTimer = setTimeout(() => {
      restartTimer = null
      if (!stopping) startChild()
    }, delay)
  })
}

log(`starting gateway=${path.basename(gatewayPath)}`)
startChild()
