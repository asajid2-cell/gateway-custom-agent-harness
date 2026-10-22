#!/usr/bin/env node
/**
 * Set, inspect, or cancel a timer that wakes a live Gateway session.
 *
 * A driver/head delegates to leaves, the leaves finish and end their turn, and
 * the head has no way to come back on its own: a blocking wait only holds a
 * live turn, and a self-addressed peer message is refused by the transport. So
 * the timer lives in the receiving session (which is merely idle, not gone) and
 * the wake arrives as a synthetic `[heartbeat]` turn. This script is the
 * detached way to set that timer; it does not stay running.
 *
 * Usage:
 *   gateway-wake.mjs --session <id> [--every 20m] [--label driver]
 *   gateway-wake.mjs --session <id> --after 90s
 *   gateway-wake.mjs --session <id> --stop [--token <token> | --label driver]
 *   gateway-wake.mjs --status [--session <id>]
 *
 * Durations are `<number>[ms|s|m|h]`; a bare number is milliseconds. `--after`
 * sets the first fire, `--every` sets the cadence. With neither, the timer is
 * `--every 20m`, the long-horizon driver cadence. Omit `--every` for a one-shot.
 */
import { randomUUID } from 'node:crypto'
import { readFile, readdir, unlink } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'

const USAGE = `usage:
  gateway-wake.mjs --session <id> [--every <ms|Nm|Nh>] [--after <ms|Nm|Nh>] [--label <text>] [--token <token>]
  gateway-wake.mjs --session <id> --stop [--token <token> | --label <text>]
  gateway-wake.mjs --status [--session <id>]

Durations accept a ms/s/m/h suffix; a bare number is milliseconds.
No --every means one-shot. With neither --after nor --every the cadence is 20m.`

function fail(message) {
  console.error(`gateway-wake: ${message}`)
  process.exit(2)
}

function parseArgs(argv) {
  const options = { stop: false, status: false }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const take = () => {
      const value = argv[++index]
      if (value === undefined || value.startsWith('--')) fail(`${arg} requires a value`)
      return value
    }
    switch (arg) {
      case '--session': options.session = take(); break
      case '--after': options.after = take(); break
      case '--every': options.every = take(); break
      case '--label': options.label = take(); break
      case '--token': options.token = take(); break
      case '--stop': options.stop = true; break
      case '--status': options.status = true; break
      case '--help': case '-h': console.log(USAGE); process.exit(0); break
      default: fail(`unknown argument ${arg}\n\n${USAGE}`)
    }
  }
  return options
}

function parseDuration(value, flag) {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(String(value).trim())
  if (!match) fail(`${flag} expects <number>[ms|s|m|h], got ${JSON.stringify(value)}`)
  const factor = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match[2] ?? 'ms']
  const duration = Math.round(Number(match[1]) * factor)
  if (!Number.isFinite(duration) || duration <= 0) fail(`${flag} must be a positive duration`)
  return duration
}

const configHome = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
const sessionsDirectory = join(configHome, 'gateway-sessions')
const timersDirectory = join(configHome, 'gateway-timers')

/** Same encoding the receiving transport uses, so both agree on one file per token. */
function timerPath(token) {
  return join(timersDirectory, `${Buffer.from(token, 'utf8').toString('hex').slice(0, 160)}.json`)
}

/** The timer token for a request: explicit, else derived from the label so a re-set replaces. */
function resolveToken(options, { required }) {
  if (options.token) return options.token
  if (options.label) return `label:${options.label}`
  if (required) fail('a timer needs --token or --label so a re-set can replace it')
  return `timer:${randomUUID()}`
}

async function readRegistration(sessionId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
    fail(`--session expects a full session ID, got ${JSON.stringify(sessionId)}`)
  }
  let raw
  try {
    raw = JSON.parse(await readFile(join(sessionsDirectory, `${sessionId}.json`), 'utf8'))
  } catch (error) {
    fail(`could not read the registration for ${sessionId} (${error.code ?? error.message}); is that session live?`)
  }
  if (!raw?.peer?.endpoint || typeof raw.token !== 'string') fail(`the registration for ${sessionId} has no endpoint or token`)
  return raw
}

function call(endpoint, request, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint)
    let response = Buffer.alloc(0)
    const finish = error => {
      socket.destroy()
      if (error) reject(error)
    }
    socket.setTimeout(timeoutMs, () => finish(new Error('the session did not answer the wake request')))
    socket.on('error', finish)
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`))
    socket.on('data', chunk => {
      response = Buffer.concat([response, chunk])
      const end = response.indexOf(10)
      if (end < 0) return
      socket.destroy()
      try { resolve(JSON.parse(response.subarray(0, end).toString('utf8'))) }
      catch { reject(new Error('the session returned an invalid response')) }
    })
    socket.on('end', () => { if (response.indexOf(10) < 0) finish(new Error('the session closed without answering')) })
  })
}

async function listTimers(sessionId) {
  let names
  try { names = await readdir(timersDirectory) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
  const timers = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const timer = JSON.parse(await readFile(join(timersDirectory, name), 'utf8'))
      if (!sessionId || timer.sessionId === sessionId) timers.push(timer)
    } catch { /* A half-written or foreign file is not a timer; skip it. */ }
  }
  return timers.sort((a, b) => String(a.at).localeCompare(String(b.at)))
}

async function main() {
  const options = parseArgs(process.argv.slice(2))

  if (options.status) {
    const timers = await listTimers(options.session)
    for (const timer of timers) {
      const cadence = timer.intervalMs === undefined ? 'once' : `every ${timer.intervalMs}ms`
      console.log(`${timer.token}  session=${timer.sessionId}  ${cadence}  at=${timer.at}  fires=${timer.fires ?? 0}${timer.label ? `  label=${timer.label}` : ''}`)
    }
    if (timers.length === 0) console.log('no timers')
    return
  }

  if (!options.session) fail(`--session is required\n\n${USAGE}`)
  const registration = await readRegistration(options.session)
  const sessionId = registration.peer.sessionId

  if (options.stop) {
    const token = resolveToken(options, { required: true })
    let response
    try {
      response = await call(registration.peer.endpoint, { type: 'wake', token, auth: registration.token, reason: 'timer', stop: true })
    } catch (error) {
      // The schedule lived in that process; if it cannot be reached, no timer
      // will fire, so the state file is stale and must not be reported as live.
      await unlink(timerPath(token)).catch(() => {})
      console.error(`gateway-wake: could not reach ${sessionId} (${error.message}); removed the stale timer state`)
      process.exitCode = 1
      return
    }
    if (response?.ok !== true) fail(`the session refused the stop: ${response?.reason ?? 'no reason given'}`)
    await unlink(timerPath(token)).catch(() => {})
    console.log(JSON.stringify({ ok: true, stopped: response.stopped === true, token, sessionId }))
    return
  }

  const everyMs = options.every === undefined ? (options.after === undefined ? 20 * 60_000 : undefined) : parseDuration(options.every, '--every')
  const afterMs = options.after === undefined ? (everyMs ?? 0) : parseDuration(options.after, '--after')
  const token = resolveToken(options, { required: false })
  const at = new Date(Date.now() + afterMs).toISOString()

  const response = await call(registration.peer.endpoint, {
    type: 'wake',
    token,
    auth: registration.token,
    reason: 'timer',
    ...(options.label ? { label: options.label } : {}),
    ...(everyMs === undefined ? {} : { intervalMs: everyMs }),
    at,
  })
  if (response?.ok !== true) fail(`the session refused the timer: ${response?.reason ?? 'no reason given'}`)
  // The receiver persisted the state file before answering, so `--status` reads
  // it from here on; this process does not stay alive to own anything.
  console.log(JSON.stringify({ ok: true, token, sessionId, ...(options.label ? { label: options.label } : {}), ...(everyMs === undefined ? {} : { intervalMs: everyMs }), at }))
}

await main()
