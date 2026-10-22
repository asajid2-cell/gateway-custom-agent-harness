import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { lstat, mkdir, open, readdir, readFile, rename, rm, stat, unlink } from 'node:fs/promises'
import { createConnection, createServer, type Server } from 'node:net'
import { join } from 'node:path'
import { isProcessRunning } from './genericProcessUtils.js'
import { getSessionId } from '../bootstrap/state.js'
import { lock } from './lockfile.js'
import {
  GATEWAY_SESSION_PROTOCOL, MAX_PEER_MESSAGE_BYTES, MAX_PEER_QUEUE, MAX_PEER_HISTORY,
  gatewayPeerSchema, gatewayPeerMessageSchema, gatewayInboxSchema, parsePeerMessage, parseGatewayPeer,
  peerMessageExpectsReply,
  type GatewayPeer, type GatewayPeerMessage, type GatewayInboxRecord, type GatewayPeerHistoryEntry,
  type GatewayInboundPolicy, type PeerMessageKind,
} from './gatewaySessionProtocol.js'
import { readTranscriptSlice, type TranscriptSlice } from './transcriptRead.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import type { GatewayPeerRoute } from './gatewaySessionProtocol.js'

const execFileAsync = promisify(execFile)

/**
 * The sender of a request that carried this session's own token, but whose
 * registration could not be resolved - the sender is not on the bus.
 *
 * Worth naming separately from a refusal: the request proved it could read our
 * registration, so the only thing wrong is that the sender has none of its own,
 * which is exactly the state a session is in when its own registration failed or
 * was reaped, and which a generic "unauthorized" hides behind a transport bug.
 */
class UnregisteredSenderError extends Error {}

/**
 * The registration being read is not on disk at all.
 *
 * Kept apart from the other read failures because it is not one: it is the
 * ordinary state of a session that has been deregistered - by its own close, by
 * a restart that has not published yet, or by a listing that proved it dead -
 * and a caller whose job is to remove or replace that registration needs to
 * tell "already gone" apart from "unreadable".
 */
class NoRegistrationError extends Error {}

const directoryChecks = new Map<string, Promise<void>>()
function validatePrivateDirectory(directory: string): Promise<void> {
  const pending = directoryChecks.get(directory)
  if (pending) return pending
  const check = checkPrivateDirectory(directory).finally(() => { directoryChecks.delete(directory) })
  directoryChecks.set(directory, check)
  return check
}

/** How one PowerShell ACL probe can fail, as `execFile` reports it. */
type AclProbeFault = Error & {
  code?: number | string | null
  killed?: boolean
  signal?: NodeJS.Signals | null
  syscall?: string
  stderr?: string
}

const ACL_PROBE_TIMEOUT_MS = 10_000
/**
 * How many times a probe that ran out of time is tried again.
 *
 * A spawn that did not finish inside the timeout says nothing about the
 * directory: the machine was busy, which is the ordinary way this happens and
 * is exactly the case that must not be read as a verdict. One retry covers it.
 */
const ACL_PROBE_ATTEMPTS = 2

/**
 * Say what went wrong with a PowerShell probe in its own terms.
 *
 * The ACL check is a spawn, and everything that can go wrong with one - no
 * `powershell.exe` on PATH, a machine too busy to start one inside the timeout,
 * output too large for the buffer, a probe that died of its own error - has to
 * be told apart from the verdict the probe exists to produce. The check used to
 * read all of them as its own answer, so a session whose peers were perfectly
 * well protected was told "Session directory must have a private Windows ACL":
 * a statement about the directory made by a process that never read it.
 */
function describePowerShellFault(fault: AclProbeFault): string {
  if (fault.killed === true || fault.signal) return `it did not finish within ${ACL_PROBE_TIMEOUT_MS / 1000}s (${fault.signal ?? 'timed out'})`
  const stderr = (fault.stderr ?? '').trim().split('\n')[0]?.slice(0, 300)
  const code = fault.code === undefined || fault.code === null ? 'no exit code' : String(fault.code)
  return `it failed with ${code}${fault.syscall ? ` (${fault.syscall})` : ''}${stderr ? `: ${stderr}` : ''}`
}

/**
 * Run one PowerShell ACL step, retrying a run that only ran out of time.
 *
 * Shared by the check and by the creation of a new directory, because both are
 * the same spawn and both used to answer for its failures with a claim about the
 * directory. A retry is safe for either: reading an ACL and setting one are both
 * idempotent.
 */
async function runAclPowerShell(script: string, directory: string): Promise<{ kind: 'ok' } | { kind: 'fault'; fault: AclProbeFault }> {
  for (let attempt = 1; ; attempt++) {
    try {
      await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        env: { ...process.env, GATEWAY_DIRECTORY_CHECK: directory }, timeout: ACL_PROBE_TIMEOUT_MS, maxBuffer: 4096, windowsHide: true,
      })
      return { kind: 'ok' }
    } catch (error) {
      const fault = error as AclProbeFault
      if (attempt < ACL_PROBE_ATTEMPTS && (fault.killed === true || fault.signal != null)) continue
      return { kind: 'fault', fault }
    }
  }
}

/**
 * Run one ACL probe and say which of three things happened.
 *
 * Only the probe's own exit codes are a verdict about the directory: 2 is
 * another account owning it, 3 an allow rule for an account that is not this
 * user, SYSTEM or Administrators. Everything else is the check failing to run,
 * and a check that cannot run must still fail closed - an unverified directory
 * is not a trusted one - but it fails saying so, not with the verdict it never
 * reached.
 */
async function probeDirectoryAcl(script: string, directory: string): Promise<{ kind: 'ok' } | { kind: 'verdict' } | { kind: 'unavailable'; detail: string }> {
  const run = await runAclPowerShell(script, directory)
  if (run.kind === 'ok') return { kind: 'ok' }
  if (run.fault.code === 2 || run.fault.code === 3) return { kind: 'verdict' }
  return { kind: 'unavailable', detail: describePowerShellFault(run.fault) }
}

async function checkPrivateDirectory(directory: string): Promise<void> {
  const stat = await lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid session directory')
  if (process.platform !== 'win32') {
    if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error('Session directory must be private')
    return
  }
  const script = `$ErrorActionPreference='Stop'; $acl=Get-Acl -LiteralPath $env:GATEWAY_DIRECTORY_CHECK; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; if($owner -ne $sid){exit 2}; foreach($rule in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) { if($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @($sid,'S-1-5-18','S-1-5-32-544')) {exit 3} }`
  const probe = await probeDirectoryAcl(script, directory)
  if (probe.kind === 'verdict') throw new Error('Session directory must have a private Windows ACL')
  if (probe.kind === 'unavailable') throw new Error(`Could not check the session directory's permissions: ${probe.detail}`)
}

export async function sendGatewayHookMessage(env: NodeJS.ProcessEnv, toSessionId: string, text: string): Promise<unknown> {
  const directory = env.GATEWAY_PEER_DIRECTORY
  const sessionId = env.GATEWAY_PEER_SESSION
  const runtimeId = env.GATEWAY_PEER_RUNTIME
  const token = env.GATEWAY_PEER_TOKEN
  if (!directory || !sessionId || !runtimeId || !token) throw new Error('No parent runtime capability')
  const sender = await readRegistration(directory, sessionId)
  const supplied = Buffer.from(token)
  const expected = Buffer.from(sender.token)
  if (sender.peer.runtimeId !== runtimeId || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('Parent capability expired')
  const target = await readRegistration(directory, toSessionId)
  const message = gatewayPeerMessageSchema.parse({ id: randomUUID(), fromSessionId: sessionId, fromRuntimeId: runtimeId, toSessionId, text, summary: text.slice(0, 200), createdAt: new Date().toISOString() })
  try {
    return await callGatewayPeer(target.peer.endpoint, { type: 'message', token: target.token, senderToken: token, message })
  } catch {
    return { ok: false, state: 'unknown', id: message.id, reason: 'Acknowledgement unavailable; check receipt before sending another copy.' }
  }
}

// JSON can expand one control character to six ASCII bytes (\\u0000).
const RESPONSE_TIMEOUT_MS = 15000
/**
 * How long a listing waits for one peer's liveness probe.
 *
 * A probe is not a request the peer has to work on: a healthy transport answers
 * it off its own loop in single-digit milliseconds. The wait only has to cover a
 * peer whose event loop is busy, so it is far shorter than a request's timeout -
 * and a listing is on the path of every send and every panel refresh, so the
 * short wait is what keeps a peer that is hung, frozen or foreign from holding
 * the whole registry open. Timing out is safe in that direction: a peer that
 * connected but did not answer stays listed as busy rather than being declared
 * gone.
 */
const PROBE_TIMEOUT_MS = 5000
const MAX_FRAME = MAX_PEER_MESSAGE_BYTES * 6 + 8192
/**
 * How much of a transcript one peer read may carry.
 *
 * A read reply is a JSON frame like any other and has to fit `MAX_FRAME` after
 * escaping, so the transcript text is capped well below it: a peer asking to see
 * what another is doing needs the shape of the work, not a whole rollout.
 */
const MAX_PEER_READ_CHARS = 12_000
const MAX_INBOX_BYTES = (MAX_PEER_QUEUE * 2 + MAX_PEER_HISTORY) * MAX_FRAME
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Windows refuses a rename whose destination another process holds open without
 * sharing. That is the ordinary way a scanner, the search indexer or a backup
 * agent touches a file, and it lasts milliseconds, so the refusal is transient
 * and has nothing to do with this code. It matters here because both files this
 * writes are rewritten often - the registration on every status change, the
 * inbox on every message - and because a refused publish is not a small loss: a
 * registration that never lands marks the session's start failed for the rest of
 * its life, and the session is then unreachable on the peer bus while it runs
 * perfectly well. Retrying briefly is the whole fix; the holder always lets go.
 *
 * Only Windows retries. On the other platforms these codes are not a sharing
 * refusal - EACCES there is a directory permission, which retrying cannot fix -
 * so a failure is reported at once rather than paid for with a delay.
 */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])
const RENAME_ATTEMPTS = 6

async function renameWithRetry(from: string, to: string): Promise<void> {
  const attempts = process.platform === 'win32' ? RENAME_ATTEMPTS : 1
  for (let attempt = 1; ; attempt++) {
    try { return await rename(from, to) }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= attempts || code === undefined || !TRANSIENT_RENAME_CODES.has(code)) throw error
      await new Promise(resolve => setTimeout(resolve, 20 * attempt))
    }
  }
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    try {
      await handle.writeFile(JSON.stringify(value))
      await handle.sync()
    } finally { await handle.close() }
    await renameWithRetry(temporary, path)
  } finally { await unlink(temporary).catch(() => {}) }
}

export async function callGatewayPeer(endpoint: string, request: unknown, timeoutMs = RESPONSE_TIMEOUT_MS): Promise<unknown> {
  const frame = Buffer.from(`${JSON.stringify(request)}\n`)
  if (frame.length > MAX_FRAME) throw new Error('Peer message exceeds the transport size limit')
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint)
    let response = Buffer.alloc(0)
    // Whether the request frame ever left this process. A registration file
    // outlives the session that wrote it, so the common way a peer looks
    // reachable and is not is a stale registration whose endpoint no longer
    // exists; connecting to one fails with ENOENT. That is a definite failure
    // and must not be reported the same way as a lost acknowledgement, where
    // the peer did receive the request and only the reply went missing.
    let connected = false
    const fail = () => {
      socket.destroy()
      const error = new Error('Gateway session is unavailable') as Error & { peerConnected?: boolean }
      error.peerConnected = connected
      reject(error)
    }
    socket.setTimeout(timeoutMs, fail)
    socket.on('error', fail)
    socket.on('connect', () => { connected = true; socket.write(frame) })
    socket.on('data', chunk => {
      response = Buffer.concat([response, chunk])
      if (response.length > MAX_FRAME) return fail()
      const end = response.indexOf(10)
      if (end < 0) return
      socket.destroy()
      try { resolve(JSON.parse(response.subarray(0, end).toString('utf8'))) }
      catch { reject(new Error('Invalid Gateway peer response')) }
    })
    socket.on('end', () => { if (response.indexOf(10) < 0) fail() })
  })
}

// ---------------------------------------------------------------------------
// Route health: whether the recipient's next model call can actually be served
// ---------------------------------------------------------------------------

/**
 * How long a pre-delivery health probe may take before it stops being an answer.
 *
 * The probe is a loopback GET against the recipient's own gateway, which
 * normally answers in single-digit milliseconds. The ceiling is for the case
 * where it does not answer at all: a wedged gateway must not hold a send open,
 * and a probe that ran out of time is `unknown` - never healthy, and never a
 * refusal. Only a withheld delivery depends on an answer; a delivery does not.
 */
const ROUTE_PROBE_TIMEOUT_MS = 1500

/**
 * How long a refusal waits before asking a second time.
 *
 * Only a send that is about to be withheld pays this. The window is what makes
 * the second probe a reload rather than a repeat: a keysafe child healing the
 * gateway, or a session switching its selected account, lands in that time.
 */
const ROUTE_RECHECK_DELAY_MS = 150

const ROUTE_HEALTH_STATES = new Set(['serving', 'exhausted', 'unauthorized', 'unknown'])

/**
 * What the recipient's gateway last observed about the route its next call spends.
 *
 * `state` is the POOL's ability, not the selected credential's. That distinction
 * is the whole defect this replaced: the gateway rotates on exactly the reply
 * that marks one credential unusable, so a pool with a dead first key and a live
 * second key serves fine while the first key reads `exhausted`.
 *
 * The selected credential's own verdict travels alongside instead of deciding,
 * because it is still the most useful thing to tell a sender: `number` is what
 * the recipient advertised it would select, `numberState` is what that one key
 * last did, and `reason`/`http` carry its evidence (today's message named
 * `http_400_insufficient_credits`, which is why it was actionable).
 */
export type PeerRouteHealth = {
  /** The pool's ability: serving if any credential serves, else the worst proven state. */
  state: 'serving' | 'exhausted' | 'unauthorized' | 'unknown'
  /** The evidence behind `numberState` when it has one; otherwise `fleet_<state>`. */
  reason: string
  provider?: string
  /** The credential the recipient advertised it would select first. */
  number?: number
  /** That one credential's own verdict, when the answer carried it. */
  numberState?: 'serving' | 'exhausted' | 'unauthorized' | 'unknown'
  /** How many credentials the pool had when it was asked. */
  size?: number
  /** The upstream status behind the credential verdict, when the reason names one. */
  http?: number
}

const UNKNOWN_ROUTE_HEALTH: PeerRouteHealth = { state: 'unknown', reason: 'health_unavailable' }

/**
 * The origin of a loopback gateway URL, or undefined for anything else.
 *
 * A registration is a file, and a file can say any URL at all. The sender is
 * the process that fetches it, so validating here is what keeps an advertised
 * route from turning a peer message into a request to an arbitrary host. Only
 * plain http on the loopback interface is a Gateway: a gateway is never remote,
 * and a peer that claims otherwise gets `unknown`, which delivers.
 */
export function loopbackGatewayOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  let url: URL
  try { url = new URL(value) } catch { return undefined }
  if (url.protocol !== 'http:') return undefined
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)) return undefined
  return url.origin
}

/** The upstream status a health reason names, when it names one. */
function healthHttp(reason: unknown): number | undefined {
  // `http_400_insufficient_credits` is one token, so a word boundary after the
  // digits would never match: `_` is a word character. Only a following digit
  // disqualifies the status.
  const match = typeof reason === 'string' ? /^http_(\d{3})(?![0-9])/.exec(reason) : null
  return match ? Number(match[1]) : undefined
}

/**
 * Ask the gateway that would serve a recipient's next call what it last saw.
 *
 * The health bit is kept by the process that served the traffic, so the only
 * process that can answer for a recipient is the recipient's own gateway. A
 * peer that advertised no route (an older build, or a session launched outside
 * the Gateway launcher) is `unknown` without a request being made.
 *
 * Every failure mode - no route, a non-loopback URL, a non-200, a body this
 * build does not recognise, a timeout, a dead gateway - is `unknown`. That is a
 * deliberate asymmetry: the gate withholds only on a positive report of
 * exhaustion or rejection, so an unanswerable probe must degrade to delivery
 * rather than to a refusal a sender cannot act on.
 */
export async function probePeerRoute(route: GatewayPeerRoute | undefined): Promise<PeerRouteHealth> {
  const origin = loopbackGatewayOrigin(route?.baseUrl)
  if (!route || !origin) return { ...UNKNOWN_ROUTE_HEALTH }
  // Ask about the POOL, naming no credential. The gateway fails over past a
  // credential it has just marked unusable, so the selected credential's verdict
  // is not the route's - asking by number is what reported a working session as
  // dead.
  const fleet = await readRouteHealth(origin, new URLSearchParams({ provider: route.provider }))
  if (fleet && ROUTE_HEALTH_STATES.has(fleet.fleet)) {
    const entries: any[] = Array.isArray(fleet.numbers) ? fleet.numbers : []
    const own = entries.find(entry => entry?.number === route.number)
    const numberState = own && ROUTE_HEALTH_STATES.has(own.state) ? own.state : undefined
    const numberReason = typeof own?.reason === 'string' && own.reason ? own.reason : undefined
    const http = healthHttp(numberReason)
    return {
      state: fleet.fleet,
      reason: numberReason ?? `fleet_${fleet.fleet}`,
      provider: typeof fleet.provider === 'string' ? fleet.provider : route.provider,
      number: route.number,
      ...(numberState ? { numberState } : {}),
      ...(Number.isSafeInteger(fleet.size) ? { size: fleet.size } : {}),
      ...(http !== undefined ? { http } : {}),
    }
  }
  // A gateway that predates the fleet question answers the per-number form (and
  // 400s on a missing number). Falling back keeps a mixed fleet on the old
  // gate - which is narrower, but is the only verdict that build can give.
  const single = await readRouteHealth(origin, new URLSearchParams({ provider: route.provider, number: String(route.number) }))
  if (!single || !ROUTE_HEALTH_STATES.has(single.state)) return { ...UNKNOWN_ROUTE_HEALTH }
  const reason = typeof single.reason === 'string' && single.reason ? single.reason : 'health_unavailable'
  const http = healthHttp(reason)
  return {
    state: single.state,
    reason,
    provider: typeof single.provider === 'string' ? single.provider : route.provider,
    number: Number.isSafeInteger(single.number) ? single.number : route.number,
    numberState: single.state,
    ...(http !== undefined ? { http } : {}),
  }
}

/** One route-health read, or undefined for anything that is not a JSON answer. */
async function readRouteHealth(origin: string, query: URLSearchParams): Promise<any | undefined> {
  const response = await fetch(new URL(`/gateway/route-health?${query.toString()}`, origin), {
    signal: AbortSignal.timeout(ROUTE_PROBE_TIMEOUT_MS),
  }).catch(() => undefined)
  if (!response || !response.ok) return undefined
  try { return await response.json() } catch { return undefined }
}

/** `<model>/<effort>` for a refusal, when the recipient advertised the model. */
export function describePeerRoute(route: GatewayPeerRoute | undefined): string | undefined {
  if (!route?.model) return undefined
  return route.effort ? `${route.model}/${route.effort}` : route.model
}

/** The preference file a provider's account selection is read from, when it has one. */
const ROUTE_PREFERENCE_FILES: Record<string, string> = {
  commandcode: 'commandcode-account.json',
  'opencode-go': 'opencode-account.json',
  'opencode-zen': 'opencode-account.json',
}

/**
 * The credential number this session's pool would select for a provider.
 *
 * Single-key providers always select 1. Pooled providers persist their global
 * default in a preference file the gateway itself reads, and that file is what a
 * fresh launch would follow - so reading it here advertises the same account the
 * next call would spend. A session pinned to a different account in memory is
 * the one case this cannot see; the probe then answers about the advertised
 * number, and the report names that limitation rather than guessing.
 */
async function routeCredentialNumber(provider: string): Promise<number> {
  const preference = ROUTE_PREFERENCE_FILES[provider]
  if (!preference) return 1
  try {
    const saved = JSON.parse(await readFile(join(getClaudeConfigHomeDir(), preference), 'utf8'))
    return Number.isSafeInteger(saved?.number) && saved.number > 0 ? saved.number : 1
  } catch {
    return 1
  }
}

/**
 * The route this session would spend on, as its registration advertises it.
 *
 * Undefined whenever the answer would be a guess: no Gateway base URL (this
 * session was launched outside the launcher), a model whose backend this build
 * cannot name, or an unreadable preference. A session that advertises nothing
 * reads as `unknown` on the sending side, which delivers - the same failure
 * direction as a probe that could not answer.
 */
async function describeOwnRoute(): Promise<GatewayPeerRoute | undefined> {
  const baseUrl = loopbackGatewayOrigin(process.env.CLAUDE_CODE_GATEWAY_BASE_URL?.trim())
  if (!baseUrl) return undefined
  try {
    // The model is read the same way `getMainLoopModel` reads it in Gateway
    // mode - the in-session `/model` override, else MODEL_GATEWAY_MODEL, which
    // every launcher sets - but without importing `model.ts`. That module costs
    // about five seconds to load cold, and `start()` would pay it before
    // publishing a registration. A session with neither source advertises no
    // route, which is the same `unknown` a probe that could not answer gets.
    const [{ getMainLoopModelOverride }, { resolveModelBackend }] = await Promise.all([
      import('../bootstrap/state.js'),
      import('../utils/model/gatewayBackend.js'),
    ])
    const override = getMainLoopModelOverride()
    const model = typeof override === 'string' && override.trim()
      ? override.trim()
      : process.env.MODEL_GATEWAY_MODEL?.trim()
    if (!model) return undefined
    const provider = resolveModelBackend(model)
    if (provider === 'unknown') return undefined
    const number = await routeCredentialNumber(provider)
    let effort: string | undefined
    try {
      const { resolveAppliedEffort } = await import('../utils/effort.js')
      const applied = resolveAppliedEffort(model, undefined)
      // A numeric effort is still a route label; the advertisement carries it
      // as text because that is all a refusal needs to name.
      effort = applied === undefined ? undefined : String(applied)
    } catch {
      // Effort only decorates the refusal; a route without it is still exact.
    }
    return { provider, number, baseUrl, model, ...(effort ? { effort } : {}) }
  } catch {
    return undefined
  }
}

async function readRegistration(directory: string, sessionId: string): Promise<{ peer: GatewayPeer; token: string }> {
  if (!idPattern.test(sessionId)) throw new Error('Invalid session ID')
  await validatePrivateDirectory(directory)
  return readRegistrationUnchecked(directory, sessionId)
}

/**
 * The registration read without the directory ACL check. Validation costs a
 * PowerShell spawn on Windows and is per-directory, not per-file, so callers
 * that read many registrations validate once up front instead of paying it for
 * every peer in the directory.
 */
async function readRegistrationUnchecked(directory: string, sessionId: string): Promise<{ peer: GatewayPeer; token: string }> {
  const path = join(directory, `${sessionId}.json`)
  // A missing registration is the ordinary "that session is not live" case, not
  // a corrupt one. Reporting the raw ENOENT leaked a config path and read as a
  // transport bug, which is why session comms looked broken.
  let before
  try { before = await lstat(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new NoRegistrationError(`No live session ${sessionId}; run /sessions list to see current peers`)
    throw error
  }
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Invalid session registration')
  const handle = await open(path, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > 16384 || (process.platform !== 'win32' && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))) throw new Error('Invalid session registration')
    const value = JSON.parse(await handle.readFile('utf8'))
    // Read with the wire's tolerance: a registration written by a newer build
    // carries fields this one does not know, and a strict read drops that peer
    // from discovery entirely rather than dropping the field. See `parseGatewayPeer`.
    const peer = parseGatewayPeer(value.peer)
    if (peer.sessionId !== sessionId || typeof value.token !== 'string' || !/^[a-f0-9]{64}$/.test(value.token)) throw new Error('Invalid session registration')
    const expectedEndpoint = process.platform === 'win32'
      ? `\\\\.\\pipe\\gateway-${peer.runtimeId}`
      : join(directory, `${peer.runtimeId}.sock`)
    if (peer.endpoint !== expectedEndpoint) throw new Error('Invalid session endpoint')
    return { peer, token: value.token }
  } finally { await handle.close() }
}

export async function listGatewayPeers(directory: string): Promise<GatewayPeer[]> {
  let entries: string[]
  try { entries = await readdir(directory) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  const candidates = entries.filter(entry => entry.endsWith('.json') && idPattern.test(entry.slice(0, -5)))
  // Tombstones are swept, never listed. The suffix is deliberately not `.json`
  // with a UUID stem, so a record of a death cannot be read as a claim of life:
  // discovery filters on exactly that shape, and so does every other reader of
  // this directory. The sweep is here because the listing is the only routine
  // that reads the registry; it runs before the early return so a directory
  // holding nothing but expired tombstones still empties.
  const expiredTombstones = entries.filter(entry => entry.endsWith(TOMBSTONE_SUFFIX) && idPattern.test(entry.slice(0, -TOMBSTONE_SUFFIX.length)))
  if (candidates.length === 0 && expiredTombstones.length === 0) return []
  // Validate the directory once for the whole listing. A stale registration is
  // the common case here, and the check is a PowerShell spawn on Windows: doing
  // it per file made discovery cost ~350ms per registration on disk.
  //
  // A failed check propagates rather than reading as an empty registry. The two
  // are not the same answer: an empty list is a claim that nothing is live, and
  // resolution turns that claim into "no live session named X" - a false
  // statement about a peer that is running, produced by a check that could not
  // be run. Only a missing directory means an empty registry.
  await validatePrivateDirectory(directory)
  await Promise.all(expiredTombstones.map(async entry => {
    const path = join(directory, entry)
    try { if (Date.now() - (await stat(path)).mtimeMs > TOMBSTONE_TTL_MS) await unlink(path) }
    catch { /* Gone already, or unreadable: the next listing tries again. */ }
  }))
  if (candidates.length === 0) return []
  // Probes run together, and the answer keeps the directory's order. One at a
  // time made the listing cost the sum of every probe, so a single hung, frozen
  // or foreign endpoint stalled the whole registry for its timeout - on the path
  // of every send and every panel refresh. Waiting on them together bounds the
  // listing by the slowest one instead. The result is collected by position
  // rather than by completion, so a listing is still a stable answer and the
  // callers that index into it see the same order on every call.
  const probes = candidates.map(async entry => {
    const sessionId = entry.slice(0, -5)
    // Kept outside the try so the sweep can run after a failure. A peer that is
    // gone usually fails the ping by rejecting rather than by answering
    // something unrecognisable - the endpoint does not exist any more - so a
    // sweep that only ran on a mismatch would never run at all. An unreadable
    // registration leaves this unset, and nothing is deleted on a guess.
    let peer: GatewayPeer | undefined
    let answered = false
    // A peer whose endpoint accepted the connection and then produced no answer
    // is busy, not gone. The registration's endpoint exists and something behind
    // it is listening; only a failure to connect proves the session that wrote
    // the registration has exited. The sweep below already refuses to delete on a
    // silent endpoint because "a silent endpoint is not proof of anything" - but
    // the listing still dropped it, and resolution reads a drop as proof of
    // death. That is what made a peer vanish from the bus while it was mid-turn
    // and be refused as "exited or crashed without deregistering".
    let connected = false
    try {
      const registration = await readRegistrationUnchecked(directory, sessionId)
      peer = registration.peer
      const response = await callGatewayPeer(peer.endpoint, { type: 'ping', token: registration.token }, PROBE_TIMEOUT_MS) as { runtimeId?: string }
      answered = response.runtimeId === peer.runtimeId
    } catch (error) {
      connected = (error as { peerConnected?: boolean }).peerConnected === true
    }
    if (peer && !answered && !connected) await reapIfDead(directory, sessionId, peer)
    return answered || connected ? peer : undefined
  })
  const peers: GatewayPeer[] = []
  for (const peer of await Promise.all(probes)) if (peer) peers.push(peer)
  return peers
}

/**
 * What a running session says about itself when asked directly.
 *
 * The third source of identity, after the registration file and the process
 * scan: a registration can be stale, unreadable, or written by a build that knew
 * no other fields, and a session that is running can always answer for itself.
 */
export type GatewayPeerIdentity = {
  sessionId: string
  runtimeId: string
  name: string
  cwd: string
  status: string
  purpose: string
  startedAt: string
  buildId?: string
  /**
   * The answering process's pid, filled from the registration it answered over.
   *
   * The identify reply itself cannot carry a pid the receiver would be asserting
   * about itself, but the registration already holds its own and is what the
   * call was addressed through - so a sweep can record the *observed* session's
   * process rather than its own. Absent means the registration was unreadable,
   * which reads as UNKNOWN.
   */
  pid?: number
}

/**
 * Ask every registered session to identify itself (C3).
 *
 * The sweep reads files first and asks second, because the file is cheap and
 * usually right - a registration that answers a ping is already proof the
 * session behind it is running. `identify` is for the rest: a session whose
 * registration is missing or unreadable but whose process is alive can still
 * say who it is, which is exactly the case a ledger built on files alone reads
 * as UNKNOWN. A session that does not answer is left out rather than guessed at.
 */
export async function broadcastIdentify(directory: string, asker?: { sessionId: string; token?: string }): Promise<{ identities: readonly GatewayPeerIdentity[]; asked: readonly string[] }> {
  // Two tokens, and swapping them is the whole difficulty of this call. The
  // `token` on the wire is the *receiver's*, read from its registration - the
  // same handshake every other request makes, and the only proof the asker may
  // talk to it at all. The asker's own token travels as `senderToken`, because
  // the receiver resolves the sender's registration to attribute the request;
  // an identify carrying only the asker's token is refused as an unregistered
  // sender, which is correct, since it proved nothing about the receiver.
  const self = await (async () => {
    const id = asker?.sessionId ?? getSessionId()
    if (asker?.token) return { sessionId: id, token: asker.token }
    // Read the asker's own token from its registration when the caller does not
    // already hold it: the token never has to leave the transport, and a caller
    // cannot ask in another session's name by supplying a foreign id.
    try {
      return { sessionId: id, token: (await readRegistrationUnchecked(directory, id)).token }
    } catch {
      return undefined
    }
  })()
  if (!self) return { identities: [], asked: [] }
  const candidates = await listGatewayPeers(directory)
  // The asker is on the list too, and it knows who it is - asking it is a round
  // trip to learn something already in hand, and a sweep that recorded the
  // questioner as one of its own answers would be reporting on the wrong subject.
  const asked = candidates.filter(peer => peer.sessionId !== self.sessionId)
  const answers = await Promise.all(asked.map(async peer => {
    try {
      const target = await readRegistrationUnchecked(directory, peer.sessionId)
      const answer = await callGatewayPeer(
        peer.endpoint,
        { type: 'identify', token: target.token, senderToken: self.token, fromSessionId: self.sessionId },
        PROBE_TIMEOUT_MS,
      ) as Partial<GatewayPeerIdentity> & { ok?: boolean }
      if (answer?.ok !== true || answer.sessionId !== peer.sessionId) return undefined
      // The pid travels from the registration this call addressed, not from the
      // reply, so a caller building a session's history attributes liveness to
      // the session that answered rather than to itself.
      return { ...(answer as GatewayPeerIdentity), ...(peer.pid !== undefined ? { pid: peer.pid } : {}) }
    } catch {
      // An older build answers a ping but not an identify. That is not a
      // failure of the session, so its file answer stands in - with no buildId,
      // which reads as UNKNOWN rather than as a guess.
      return undefined
    }
  }))
  // The asked ids are returned alongside so a caller measuring how many peers
  // refused to answer does not have to list the registry a second time - a
  // second listing is a second probe of every peer, which is the costliest part
  // of a sweep and the part a busy machine turns into a timeout.
  return { identities: answers.filter((identity): identity is GatewayPeerIdentity => identity !== undefined), asked: asked.map(peer => peer.sessionId) }
}

/**
 * How long a reaped registration is kept before a listing lets it go.
 *
 * A registration is not only a liveness advertisement: a session that restarts
 * reads it back to keep the intent it had already declared and the topics it had
 * already been working on, which is what stops a resumed session reappearing as
 * an unnamed stranger. Reaping therefore cannot simply delete the file - that
 * would throw the intent away at the exact moment it becomes useful. Instead the
 * dead registration is moved aside to a tombstone, where a restart can still find
 * it, and swept a day later, long after any crash-restart has had its chance.
 */
const TOMBSTONE_TTL_MS = 86_400_000

/**
 * The tombstone suffix deliberately makes the name fail the discovery filter,
 * which only accepts `<uuid>.json`. A tombstone must never be probed, listed, or
 * mistaken for a live session; it is dead by construction. Its only two readers
 * are `listGatewayPeers`, which expires it, and `readPriorIntent`, which recovers
 * the intent of a session starting up again.
 */
const TOMBSTONE_SUFFIX = '.dead.json'

function tombstonePath(directory: string, sessionId: string): string {
  return join(directory, `${sessionId}${TOMBSTONE_SUFFIX}`)
}

/**
 * The intent a restarted session left behind: its declared purpose and the
 * topics it had been working on.
 *
 * The prior record can be in either of two places. A session that closed cleanly
 * unlinks its registration and has no intent to recover; one that crashed or was
 * killed had its record moved to a tombstone by the reaper, so looking only at
 * the live path would restore intent in exactly the case that does not occur and
 * lose it in exactly the case that does. The live path is still read first,
 * because a session can restart before the bus has reaped it.
 *
 * A tombstone past its TTL is not read: by then it is the abandoned history of a
 * session nobody resumed, and adopting it would give this launch a stale name and
 * someone else's topics. Fields are validated here rather than trusted, because
 * a tombstone can be any file left by any build.
 */
async function readPriorIntent(directory: string, sessionId: string): Promise<{ purpose?: string; topics?: string[] }> {
  const sources = [join(directory, `${sessionId}.json`)]
  try {
    if (Date.now() - (await stat(tombstonePath(directory, sessionId))).mtimeMs <= TOMBSTONE_TTL_MS) sources.push(tombstonePath(directory, sessionId))
  } catch { /* No tombstone: there is only the live path to try. */ }
  for (const path of sources) {
    try {
      const raw = JSON.parse(await readFile(path, 'utf8')) as { peer?: { purpose?: unknown; topics?: unknown } }
      const purpose = typeof raw?.peer?.purpose === 'string' ? raw.peer.purpose.slice(0, 1000) : undefined
      const topics = Array.isArray(raw?.peer?.topics)
        ? raw.peer.topics.filter((topic): topic is string => typeof topic === 'string' && topic.length >= 1 && topic.length <= 120).slice(0, 8)
        : undefined
      if (purpose !== undefined || (topics !== undefined && topics.length > 0)) return { purpose, topics }
    } catch { /* Missing or unreadable: the next source may still hold the intent. */ }
  }
  return {}
}

/**
 * Retire a registration the bus has proven dead, instead of only filtering it
 * out of the answer.
 *
 * A filtered listing was correct and still left the problem behind: the file
 * stayed on disk advertising a name, a cwd and a pid for a session that had
 * exited, so anything reading the directory directly - a person, a process
 * scanner, a diagnosis of a pile-up, or the sender that refuses to talk to it -
 * kept being told about sessions that no longer existed. The listing is the only
 * routine that reads every registration, so it is also the only place that can
 * let them go. Reaping is the bus's job, not the dead session's: a session that
 * was Ctrl-C'd or killed cannot deregister itself, and should not have to.
 *
 * Two independent signals are required before acting. The caller has already
 * established that the endpoint did not answer; this function additionally
 * requires that the recorded pid is gone. A busy peer can miss a ping, and a
 * recycled pid reads as alive, while reaping a live session's registration would
 * make it unreachable until it happened to write one again. Being wrong in the
 * other direction only leaves a stale file, which is what happens today anyway -
 * lingering is the safe failure.
 *
 * The registration is re-read immediately before the move and must still carry
 * the same pid AND runtimeId that was listed. A session that rebound its own
 * record between the probe and the rename (same pid, new runtime) is alive and
 * must not have that record consumed; the reap is abandoned instead.
 */
async function reapIfDead(directory: string, sessionId: string, peer: GatewayPeer): Promise<void> {
  if (isProcessRunning(peer.pid)) return
  const live = join(directory, `${sessionId}.json`)
  try {
    const current = await readRegistrationUnchecked(directory, sessionId)
    if (current.peer.pid !== peer.pid || current.peer.runtimeId !== peer.runtimeId) return
  } catch { return }
  try {
    await renameWithRetry(live, tombstonePath(directory, sessionId))
  } catch { return }
  // The dead session's own registration lock is worthless now; anything that
  // acquires it would be locking a path that no longer holds a live record.
  await rm(`${live}.lock`, { recursive: true, force: true }).catch(() => {})
}

export class GatewaySessionTransport {
  readonly peer: GatewayPeer
  private readonly token = randomBytes(32).toString('hex')
  private server: Server | undefined
  private closing: Promise<void> | undefined
  private starting: Promise<void> | undefined
  private isClosing = false
  private records: GatewayInboxRecord[] = []
  private history: import('./gatewaySessionProtocol.js').GatewayPeerHistoryEntry[] = []
  private chain: Promise<unknown> = Promise.resolve()
  private policy: GatewayInboundPolicy
  private readonly bursts = new Map<string, number[]>()
  private readonly idleSubscribers = new Map<string, string>()
  /**
   * Timers this session has been asked to fire, keyed by the timer token that
   * identifies them. In memory because a timer wakes a live process that is
   * merely idle: the process that owns the turn is the one that must own the
   * clock. The state files beside the inbox are what `gateway-wake --status`
   * reads, and `close()` clears both.
   */
  private readonly wakeTimers = new Map<string, { handle: NodeJS.Timeout; token: string; label?: string; intervalMs?: number; at: number; createdAt: string; fires: number }>()

  constructor(private readonly options: {
    directory: string
    sessionId: string
    name: string
    cwd: string
    purpose?: string
    policy?: GatewayInboundPolicy
    onInboxChanged?: () => void
    /**
     * Called when a wake timer fires, in this process. The runtime turns it
     * into a synthetic user turn; the transport never touches the queue.
     */
    onWake?: (timer: { token: string; label?: string; intervalMs?: number; at: string }) => void
  }) {
    const runtimeId = randomUUID()
    // The build this process is running, as the build's own timestamp. The dist
    // rebuilds on launch, so two live sessions can differ in behaviour with
    // nothing on the wire saying so; this is what makes "is that fix live?"
    // a lookup rather than a guess. Absent under a test or a stubbed build,
    // which reads as unknown rather than as old.
    const buildId = typeof MACRO !== 'undefined' && MACRO.BUILD_TIME ? MACRO.BUILD_TIME : undefined
    this.peer = gatewayPeerSchema.parse({
      protocol: GATEWAY_SESSION_PROTOCOL, sessionId: options.sessionId, runtimeId,
      name: options.name, cwd: options.cwd, purpose: options.purpose ?? '',
      pid: process.pid, startedAt: new Date().toISOString(), status: 'idle',
      endpoint: process.platform === 'win32' ? `\\\\.\\pipe\\gateway-${runtimeId}` : join(options.directory, `${runtimeId}.sock`),
      ...(buildId ? { buildId } : {}),
    })
    this.policy = options.policy ?? 'accept'
  }

  private get registrationPath(): string { return join(this.options.directory, `${this.peer.sessionId}.json`) }
  private get inboxPath(): string { return join(this.options.directory, `${this.peer.sessionId}.inbox`) }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    if (this.isClosing) return Promise.reject(new Error('Gateway transport is closing or closed'))
    const next = this.chain.then(operation, operation)
    this.chain = next.catch(() => {})
    return next
  }
  private async persist(records = this.records, policy = this.policy, history = this.history): Promise<void> {
    await atomicJson(this.inboxPath, { policy, records, history })
  }

  historyEntries(): readonly GatewayPeerHistoryEntry[] { return structuredClone(this.history) }

  private addHistory(entry: GatewayPeerHistoryEntry): void {
    this.history = [...this.history, entry].slice(-MAX_PEER_HISTORY)
  }

  /**
   * Where one timer's state lives.
   *
   * A sibling of the session directory, keyed by a filename-safe encoding of
   * the timer token: tokens are caller-chosen and may contain separators, so
   * the encoded form is what keeps two timers from overwriting one file. The
   * session id is inside the record, so `--status` can filter without parsing
   * names.
   */
  private get wakeDirectory(): string { return join(this.options.directory, '..', 'gateway-timers') }
  private wakeStatePath(token: string): string {
    const safe = Buffer.from(token, 'utf8').toString('hex').slice(0, 160)
    return join(this.wakeDirectory, `${safe}.json`)
  }
  private async persistWakeState(timer: { token: string; label?: string; intervalMs?: number; at: number; createdAt: string; fires: number }): Promise<void> {
    await mkdir(this.wakeDirectory, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
    await atomicJson(this.wakeStatePath(timer.token), {
      token: timer.token,
      sessionId: this.peer.sessionId,
      ...(timer.label ? { label: timer.label } : {}),
      ...(timer.intervalMs === undefined ? {} : { intervalMs: timer.intervalMs }),
      at: new Date(timer.at).toISOString(),
      createdAt: timer.createdAt,
      fires: timer.fires,
    })
  }
  private async clearWakeState(token: string): Promise<void> {
    await unlink(this.wakeStatePath(token)).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error })
  }

  private scheduleWake(timer: { token: string; label?: string; intervalMs?: number; at: number; createdAt: string; fires: number }): void {
    this.clearWakeTimer(timer.token)
    // setTimeout's delay is a 32-bit signed int; anything longer fires on the
    // next tick, so cap it and let the fire path reschedule if the deadline is
    // still in the future.
    const delay = Math.max(0, Math.min(timer.at - Date.now(), 2_147_483_647))
    const handle = setTimeout(() => this.fireWake(timer), delay)
    handle.unref?.()
    this.wakeTimers.set(timer.token, { ...timer, handle })
  }

  private fireWake(timer: { token: string; label?: string; intervalMs?: number; at: number; createdAt: string; fires: number }): void {
    this.wakeTimers.delete(timer.token)
    if (this.isClosing) return
    // A capped delay can land before a distant deadline; wait again rather
    // than injecting a turn early.
    if (timer.at > Date.now() + 1_000) {
      this.scheduleWake(timer)
      return
    }
    const firedAt = new Date().toISOString()
    this.options.onWake?.({
      token: timer.token,
      ...(timer.label ? { label: timer.label } : {}),
      ...(timer.intervalMs === undefined ? {} : { intervalMs: timer.intervalMs }),
      at: firedAt,
    })
    const next = { ...timer, fires: timer.fires + 1 }
    if (timer.intervalMs === undefined) {
      // One-shot timers have no state left to describe after they fire.
      void this.clearWakeState(timer.token).catch(() => {})
      return
    }
    next.at = Date.now() + timer.intervalMs
    this.scheduleWake(next)
    void this.persistWakeState(next).catch(() => {})
  }

  private clearWakeTimer(token: string): boolean {
    const existing = this.wakeTimers.get(token)
    if (!existing) return false
    clearTimeout(existing.handle)
    this.wakeTimers.delete(token)
    return true
  }

  /**
   * Set, replace, or cancel a timer. The token is the identity: a re-set with
   * the same token replaces the schedule rather than adding a second one.
   */
  async setWakeTimer(timer: { token: string; label?: string; intervalMs?: number; at: number }): Promise<void> {
    const next = { ...timer, createdAt: new Date().toISOString(), fires: 0 }
    // Persist before arming: a schedule that cannot be described to `--status`
    // is a schedule the caller was told about but cannot see, and a rejected
    // write must not leave a live timer behind.
    await this.persistWakeState(next)
    this.scheduleWake(next)
  }

  async stopWakeTimer(token: string): Promise<boolean> {
    const stopped = this.clearWakeTimer(token)
    await this.clearWakeState(token)
    return stopped
  }

  private async handleWake(request: any): Promise<unknown> {
    // The wake request carries the timer token in `token`, which is why it is
    // authenticated by `auth` instead of the usual field. A caller that reads
    // this session's registration can already speak to it; a caller that
    // cannot read it has no business scheduling turns in it.
    const supplied = Buffer.from(typeof request.auth === 'string' ? request.auth : '')
    const expected = Buffer.from(this.token)
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('Unauthorized')
    if (request.reason !== 'timer') throw new Error('Unsupported wake reason')
    const token = typeof request.token === 'string' ? request.token.trim() : ''
    if (!token || token.length > 200) throw new Error('Wake requires a timer token of 1-200 characters')
    if (request.stop === true) return { ok: true, token, stopped: await this.stopWakeTimer(token), sessionId: this.peer.sessionId }
    const at = typeof request.at === 'string' ? Date.parse(request.at) : NaN
    if (!Number.isFinite(at)) throw new Error('Wake requires a valid `at` timestamp')
    if (at < Date.now() - 60_000) throw new Error('Wake `at` is in the past')
    const intervalMs = request.intervalMs
    if (intervalMs !== undefined && (!Number.isInteger(intervalMs) || intervalMs <= 0)) throw new Error('Wake interval must be a positive integer of milliseconds')
    const label = typeof request.label === 'string' ? request.label.slice(0, 200) : undefined
    await this.setWakeTimer({ token, ...(label ? { label } : {}), ...(intervalMs === undefined ? {} : { intervalMs }), at })
    return { ok: true, token, ...(label ? { label } : {}), ...(intervalMs === undefined ? {} : { intervalMs }), at: new Date(at).toISOString(), sessionId: this.peer.sessionId }
  }

  start(): Promise<void> {
    if (this.isClosing) return Promise.reject(new Error('Gateway transport is closing or closed'))
    return this.starting ??= this.startOnce()
  }

  private async startOnce(): Promise<void> {
    let created = false
    try {
      await mkdir(this.options.directory, { mode: 0o700 })
      created = true
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    if (created && process.platform === 'win32') {
      const script = `$ErrorActionPreference='Stop'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule); Set-Acl -LiteralPath $env:GATEWAY_DIRECTORY_CHECK -AclObject $acl`
      const run = await runAclPowerShell(script, this.options.directory)
      if (run.kind === 'fault') throw new Error(`Could not make the session directory private: ${describePowerShellFault(run.fault)}`)
    }
    await validatePrivateDirectory(this.options.directory)
    // A live registration is never overwritten. The exclusive claim also
    // prevents two launches from racing between discovery and publication.
    const releaseClaim = await lock(this.registrationPath, {
      realpath: false, stale: 10000, retries: { retries: 3, minTimeout: 100, maxTimeout: 500 },
    })
    try {
      const existing = await listGatewayPeers(this.options.directory)
      if (existing.some(peer => peer.sessionId === this.peer.sessionId)) throw new Error('Gateway session is already running')
      try {
        const handle = await open(this.inboxPath, 'r')
        let raw: unknown
        try {
          const stat = await handle.stat()
          if (!stat.isFile() || stat.size > MAX_INBOX_BYTES) throw new Error('Invalid inbox size')
          raw = JSON.parse(await handle.readFile('utf8'))
        } finally { await handle.close() }
        const parsed = gatewayInboxSchema.safeParse(raw)
        // A store this build cannot read is reported as one line naming the
        // first issue, not as the raw issue array: this reason is surfaced
        // verbatim on the comms surfaces, and a wall of JSON is unreadable
        // where a person needs a reason.
        if (!parsed.success) {
          const [first] = parsed.error.issues
          const at = first?.path.join('.') ?? 'store'
          const count = parsed.error.issues.length
          throw new Error(`Inbox store is invalid at ${at}: ${first?.message ?? 'unknown'} (${count} issue${count === 1 ? '' : 's'})`)
        }
        const inbox = parsed.data
        if (inbox.records.some(record => record.message.toSessionId !== this.peer.sessionId) || new Set(inbox.records.map(record => record.message.id)).size !== inbox.records.length) throw new Error('Invalid inbox records')
        this.records = inbox.records
        this.policy = inbox.policy
        this.history = inbox.history ?? []
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      // A session that restarts keeps the intent it already declared or derived.
      // Without this the registration is rewritten blank on every launch, so a
      // stated purpose silently disappeared the moment the session reconnected.
      const prior = await readPriorIntent(this.options.directory, this.peer.sessionId)
      if (prior.purpose !== undefined) this.peer.purpose = prior.purpose
      if (prior.topics !== undefined && prior.topics.length > 0) this.peer.topics = prior.topics
      this.server = createServer(socket => {
        let buffer = Buffer.alloc(0)
        let handled = false
        socket.setTimeout(2000, () => socket.destroy())
        socket.on('error', () => {})
        socket.on('data', chunk => {
          if (handled) return
          buffer = Buffer.concat([buffer, chunk])
          if (buffer.length > MAX_FRAME) { handled = true; socket.destroy(); return }
          const newline = buffer.indexOf(10)
          if (newline < 0) return
          handled = true
          // A complete request may wait behind durable inbox writes. The short
          // timeout above applies only while receiving its frame.
          socket.setTimeout(RESPONSE_TIMEOUT_MS)
          let request: any
          try { request = JSON.parse(buffer.subarray(0, newline).toString('utf8')) }
          catch { socket.end(`${JSON.stringify({ ok: false, reason: 'Invalid request' })}\n`); return }
          // The liveness probe is answered out of band, because it is on the path
          // of every listing - and therefore of every send and every panel
          // refresh - while the chain is on the path of every real request. A
          // probe that waits for the chain answers late or not at all while the
          // session is mid-request, and a listing that gets no answer drops the
          // peer. It reads nothing mutable (the runtime id is fixed for the life
          // of the transport), so it does not need the ordering the chain gives.
          // A wake carries no sender registration: the detached CLI is not a
          // peer session. It authenticates with the receiver's own token, read
          // from the registration, so it is answered on this out-of-band path
          // exactly like a probe rather than through `authenticateSender`.
          if (request.type === 'ping' || request.type === 'wake') {
            void this.handle(request).then(
              response => socket.end(`${JSON.stringify(response)}\n`),
              () => socket.end(`${JSON.stringify({ ok: false, reason: 'Invalid or unauthorized peer request' })}\n`),
            )
            return
          }
          // Start registration checks together, but reserve mutation order now.
          // Otherwise every queued message pays for a separate PowerShell ACL check.
          const sender = this.authenticateSender(request).then(value => ({ value, fault: undefined as Error | undefined }), (error: unknown) => ({ value: undefined, fault: error instanceof Error ? error : new Error('Invalid sender') }))
          void this.serial(async () => {
            let response: unknown
            try {
              const authenticated = await sender
              if (!authenticated.value) {
                if (authenticated.fault instanceof UnregisteredSenderError) throw authenticated.fault
                throw new Error('Invalid sender')
              }
              response = await this.handle(request, authenticated.value)
            }
            catch (error) {
              // The specific reason reaches the sender. A blanket "invalid or
              // unauthorized peer request" made every rejection look like the
              // same transport fault, so a sender whose own registration had
              // been replaced under it - the one case it could actually fix -
              // could not tell that from addressing itself or holding a stale
              // token, and retried the same message unchanged.
              response = error instanceof UnregisteredSenderError
                ? { ok: false, reason: `The sender is not registered on this bus, so its message cannot be attributed: ${error.message}` }
                : { ok: false, reason: `Rejected by the receiving session: ${error instanceof Error ? error.message : 'invalid request'}` }
            }
            socket.end(`${JSON.stringify(response)}\n`)
          }).catch(() => socket.destroy())
        })
      })
      await new Promise<void>((resolve, reject) => {
        this.server!.once('error', reject)
        this.server!.listen(this.peer.endpoint, resolve)
      })
      // Advertise the route before publishing. A registration is what a sender
      // reads to decide whether a message can be answered, and a peer that
      // appears without a route is one every sender has to treat as unknown.
      const route = await describeOwnRoute()
      if (route) this.peer.route = route
      await atomicJson(this.registrationPath, { peer: this.peer, token: this.token })
    } catch (error) {
      this.server?.close()
      throw error
    } finally { await releaseClaim() }
  }

  private async authenticateSender(request: any): Promise<{ peer: GatewayPeer; token: string } | undefined> {
    if (typeof request?.token !== 'string' || request.token !== this.token) throw new Error('Unauthorized')
    if (request.type === 'ping') return undefined
    const senderId = request.type === 'message' ? request.message?.fromSessionId : request.fromSessionId
    try {
      return await readRegistration(this.options.directory, senderId)
    } catch (error) {
      // The token was ours, so this is not an unknown caller: it is a session
      // whose own registration is missing or unreadable. In a leaf family that
      // is a specific, fixable state - the sender can say where it is and be
      // re-registered - and calling it unauthorized sends the two sessions
      // looking for a transport fault that is not there.
      throw new UnregisteredSenderError(error instanceof Error ? error.message : 'the sender has no registration')
    }
  }

  private async handle(request: any, authenticatedSender?: { peer: GatewayPeer; token: string }): Promise<unknown> {
    // `token` is the timer's identity on a wake, not this session's secret, so
    // it is read on its own path. `handleWake` validates `auth` itself.
    if (request?.type === 'wake') return this.handleWake(request)
    if (typeof request?.token !== 'string') throw new Error('Unauthorized')
    const supplied = Buffer.from(request.token)
    const expected = Buffer.from(this.token)
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('Unauthorized')
    if (request.type === 'ping') return { ok: true, runtimeId: this.peer.runtimeId }
    // Identify (C3): the file is the first answer, this is the second. A
    // registration can be stale, unreadable, or written by an older build that
    // knew no other field, and a session that is *running* can always say who it
    // is and what it is doing right now. Answered from the live process, so it
    // is a statement about a running session rather than a file that may outlive
    // one. It carries the receiver's token as `token` like every other request,
    // and the asker's as `senderToken` + `fromSessionId`, so an anonymous caller
    // is refused exactly as it is for a message.
    if (request.type === 'identify') {
      const sender = authenticatedSender ?? await readRegistration(this.options.directory, request.fromSessionId)
      if (sender.peer.sessionId !== request.fromSessionId || sender.token !== request.senderToken) throw new Error('Invalid sender')
      return {
        ok: true,
        runtimeId: this.peer.runtimeId,
        sessionId: this.peer.sessionId,
        name: this.peer.name,
        cwd: this.peer.cwd,
        status: this.peer.status,
        purpose: this.peer.purpose,
        startedAt: this.peer.startedAt,
        ...(this.peer.buildId ? { buildId: this.peer.buildId } : {}),
      }
    }
    if (request.type === 'watch_idle') {
      const sender = authenticatedSender ?? await readRegistration(this.options.directory, request.fromSessionId)
      if (sender.peer.runtimeId !== request.fromRuntimeId || sender.token !== request.senderToken || sender.peer.sessionId === this.peer.sessionId) throw new Error('Invalid subscriber')
      if (this.peer.status === 'idle') return { ok: true, state: 'already-idle' }
      if (this.idleSubscribers.size >= MAX_PEER_QUEUE && !this.idleSubscribers.has(sender.peer.sessionId)) throw new Error('Subscription limit')
      this.idleSubscribers.set(sender.peer.sessionId, sender.peer.runtimeId)
      return { ok: true, state: 'watching', runtimeId: this.peer.runtimeId }
    }
    if (request.type === 'receipt') {
      const sender = authenticatedSender ?? await readRegistration(this.options.directory, request.fromSessionId)
      if (sender.peer.runtimeId !== request.fromRuntimeId || sender.token !== request.senderToken) throw new Error('Invalid sender')
      const record = this.records.find(record => record.message.id === request.id && record.message.fromSessionId === sender.peer.sessionId)
      return { ok: true, id: request.id, state: record?.state ?? 'unknown', meaning: 'delivered means transcript-persisted, not task completion' }
    }
    // A read is served by the session being read, from its own file. It is the
    // only party that knows where its transcript lives, so no caller has to
    // guess a project directory from a session id - and because the answer is a
    // bounded file read rather than a turn, a busy session answers it as
    // readily as an idle one.
    if (request.type === 'read') {
      const sender = authenticatedSender ?? await readRegistration(this.options.directory, request.fromSessionId)
      if (sender.peer.runtimeId !== request.fromRuntimeId || sender.token !== request.senderToken || sender.peer.sessionId === this.peer.sessionId) throw new Error('Invalid reader')
      try {
        const { getTranscriptPath } = await import('./sessionStorage.js')
        const slice = await readTranscriptSlice(getTranscriptPath(), this.peer.sessionId, {
          ...(typeof request.tail === 'number' ? { tail: request.tail } : {}),
          ...(typeof request.since === 'string' ? { since: request.since } : {}),
          maxChars: MAX_PEER_READ_CHARS,
        })
        return { ok: true, slice }
      } catch {
        return { ok: false, reason: 'This session has no readable transcript yet' }
      }
    }
    if (request.type !== 'message') throw new Error('Unsupported request')
    const message = parsePeerMessage(request.message)
    if (message.toSessionId !== this.peer.sessionId || message.fromSessionId === this.peer.sessionId) throw new Error('Invalid recipient')
    const sender = authenticatedSender ?? await readRegistration(this.options.directory, message.fromSessionId)
    if (sender.peer.runtimeId !== message.fromRuntimeId || request.senderToken !== sender.token) throw new Error('Invalid sender')
    const previous = this.records.find(record => record.message.id === message.id)
    if (previous) {
      if (JSON.stringify(previous.message) !== JSON.stringify(message)) throw new Error('Message ID collision')
      return { ok: true, state: previous.state, id: message.id }
    }
    if (this.policy === 'refuse') return { ok: false, reason: 'Recipient refuses messages' }
    const now = Date.now()
    const recent = (this.bursts.get(message.fromRuntimeId) ?? []).filter(time => time > now - 60_000)
    if (recent.length >= 10) return { ok: false, reason: 'Rate limit reached; do not resend immediately' }
    if (this.records.filter(record => record.state === 'queued' || record.state === 'held').length >= MAX_PEER_QUEUE) return { ok: false, reason: 'Recipient inbox is full' }
    if (Buffer.byteLength(message.text, 'utf8') > MAX_PEER_MESSAGE_BYTES) throw new Error('Message too large')
    // The receiver checks its own route before accepting mail as deliverable.
    // It is the only party that can: the health bit lives in the gateway that
    // would serve its next call, and a sender's probe is second-hand evidence.
    // A message that cannot be answered is stored, not delivered - `held` is
    // exactly that state here, because the Stop hook claims only `queued`, so
    // it is never handed to a model that cannot answer, while
    // `outstandingReplies` still counts it, so the sender's request is not
    // lost. Under an `accept` policy a held record is therefore exactly the mail
    // this gate withheld, which is what `releaseRouteHeld` acts on; under a
    // `hold` policy it is the operator's, and is left alone.
    //
    // The state asked about is the POOL's, not the advertised number's: the
    // gateway fails over past a dead credential on the very refusal that marks
    // it dead, so a session whose #1 is exhausted and whose #2 serves is a
    // session that answers. Gating on the advertised number held mail from
    // sessions that were serving at the time - the field defect this fixed.
    const ownHealth = await probePeerRoute(this.peer.route)
    const heldForRoute = ownHealth.state === 'exhausted' || ownHealth.state === 'unauthorized'
    const state = heldForRoute || this.policy === 'hold' ? 'held' : 'queued'
    const record: GatewayInboxRecord = { message, senderName: sender.peer.name, state, receivedAt: new Date().toISOString() }
    const completed = this.records.filter(item => item.state === 'delivered' || item.state === 'refused').slice(-MAX_PEER_QUEUE)
    const next = [...completed, ...this.records.filter(item => item.state === 'queued' || item.state === 'held'), record]
    const previousHistory = this.history
    this.addHistory({ direction: 'received', status: state, message, peerName: sender.peer.name, recordedAt: new Date().toISOString() })
    try {
      await this.persist(next)
    } catch (error) {
      this.history = previousHistory
      throw error
    }
    this.records = next
    for (const [runtimeId, times] of this.bursts) {
      if (!times.some(time => time > now - 60_000)) this.bursts.delete(runtimeId)
    }
    recent.push(now)
    this.bursts.set(message.fromRuntimeId, recent)
    this.options.onInboxChanged?.()
    // A message only reaches this branch when the sender's probe did not report
    // the route as exhausted or rejected, so this is the moment route-held mail
    // can be released if the gateway has since seen the credential serve.
    if (!heldForRoute) void this.releaseRouteHeld().catch(() => {})
    return { ok: true, state: record.state, id: message.id }
  }

  /**
   * Release mail that was withheld because this session's route could not serve.
   *
   * A route-held record is not the operator's hold: it exists because a sender
   * found this session's credential exhausted or rejected, and it must come
   * back on its own once the credential serves again - otherwise the sender is
   * told the message is owed and nothing ever delivers it. The sender cannot
   * watch the recovery (it would need to poll this session forever), and this
   * session is the only one whose gateway holds the bit, so the check is made
   * here, on the boundaries that already exist: a status change and the arrival
   * of the next message.
   *
   * `serving` and `unknown` release. `unknown` is a non-answer, not a bad one:
   * holding mail forever because a probe could not run would strand work that a
   * later turn could have done, and the gate withholds only on a positive
   * report. A deliberate inbound policy of `hold` is untouched.
   *
   * Under an `accept` policy a held record can only be one this gate withheld:
   * the policy path writes `queued`, and lifting a hold promotes every held
   * record, so nothing else is left in that state. That is why the record needs
   * no reason field - and why a persisted reason would have been a schema
   * change with a downgrade hazard for no gain.
   */
  private async releaseRouteHeld(): Promise<void> {
    if (this.policy !== 'accept') return
    if (!this.records.some(record => record.state === 'held')) return
    const health = await probePeerRoute(this.peer.route)
    if (health.state !== 'serving' && health.state !== 'unknown') return
    await this.serial(async () => {
      const releasing = new Set(this.records.filter(record => record.state === 'held').map(record => record.message.id))
      if (releasing.size === 0) return
      const next: GatewayInboxRecord[] = this.records.map(record => releasing.has(record.message.id)
        ? { ...record, state: 'queued' as const }
        : record)
      const history = this.history.map(entry => entry.direction === 'received' && releasing.has(entry.message.id) ? { ...entry, status: 'queued' as const } : entry)
      await this.persist(next, this.policy, history)
      this.records = next
      this.history = history
      this.options.onInboxChanged?.()
    })
  }

  hookEnvironment(): NodeJS.ProcessEnv {
    return { GATEWAY_PEER_DIRECTORY: this.options.directory, GATEWAY_PEER_SESSION: this.peer.sessionId, GATEWAY_PEER_RUNTIME: this.peer.runtimeId, GATEWAY_PEER_TOKEN: this.token }
  }

  inbox(): readonly GatewayInboxRecord[] { return structuredClone(this.records) }

  /**
   * Inbound requests this session has not answered yet.
   *
   * The defect this closes: a message could be read and understood, and then
   * simply never answered, with nothing anywhere recording that a reply was
   * owed. A request that arrived with `replyTo` set is itself a reply and owes
   * nothing, and a request that arrived with `expectReply: false` is the sender
   * saying no answer is wanted - both are excluded. This exists to surface the
   * first turn of a conversation, not to make two agents acknowledge each other
   * forever, nor to make an informational note look unanswered.
   */
  outstandingReplies(): readonly { toMessageId: string; toSessionId: string; summary: string; receivedAt: string }[] {
    const answered = new Set(this.history.filter(entry => entry.direction === 'sent').map(entry => entry.message.replyTo).filter(Boolean) as string[])
    return this.records
      // `expectReply: false` is the sender saying no answer is owed, so it is
      // settled on arrival and never re-surfaced. Absent still means owed:
      // silence about intent is not a statement that no reply is wanted.
      .filter(record => record.message.replyTo === undefined && peerMessageExpectsReply(record.message) && !answered.has(record.message.id))
      .map(record => ({
        toMessageId: record.message.id,
        toSessionId: record.message.fromSessionId,
        summary: record.message.summary,
        receivedAt: record.receivedAt,
      }))
  }

  async send(toSessionId: string, text: string, summary: string, replyTo?: string, kind?: PeerMessageKind, expectReply?: boolean): Promise<unknown> {
    // A session addressing itself is a real mistake - an ID read off a listing
    // and mistaken for the peer's - and the receiver rejects it anyway, as a
    // request it cannot attribute. Saying so here keeps the sender from reading
    // its own address as a transport fault and retrying it unchanged.
    if (toSessionId === this.peer.sessionId) throw new Error('That is this session; a session cannot send a message to itself')
    const target = await readRegistration(this.options.directory, toSessionId)
    // Ask what the recipient's next model call would spend before handing it
    // anything. Acceptance at the transport is not answerability, and a receipt
    // that says "queued" for a message nobody can answer is the defect this
    // gate closes. Only a positive report of exhaustion or rejection withholds;
    // everything else - including an older peer with no advertised route - is
    // `unknown` and delivers.
    let advertised = target.peer.route
    let health = await probePeerRoute(advertised)
    // A refusal is a claim about a POOL, and a pool changes without this process
    // being told: a key can be injected into the gateway, and the recipient
    // refreshes its advertisement at every turn boundary. So before withholding
    // mail, re-read the registration and ask once more. Both halves are a real
    // reload - the gateway re-derives its credential set from the environment and
    // the key overlay on every request, and the registration on disk is the
    // recipient's current answer - so this is a second question, not a repeat of
    // the first. No restart is involved: `/gateway/reload-keys` exits the
    // gateway for a supervisor to respawn, which is not something a send may do,
    // and a probe never fabricates a credential.
    if (health.state === 'exhausted' || health.state === 'unauthorized') {
      await new Promise(resolve => setTimeout(resolve, ROUTE_RECHECK_DELAY_MS))
      const refreshed = await readRegistration(this.options.directory, toSessionId).catch(() => undefined)
      if (refreshed?.peer.route) advertised = refreshed.peer.route
      health = await probePeerRoute(advertised)
    }
    const routeUnavailable = health.state === 'exhausted' || health.state === 'unauthorized'
    const message: GatewayPeerMessage = gatewayPeerMessageSchema.parse({
      id: randomUUID(), fromSessionId: this.peer.sessionId, fromRuntimeId: this.peer.runtimeId,
      toSessionId, text, summary, replyTo, ...(kind ? { kind } : {}), ...(expectReply === undefined ? {} : { expectReply }), createdAt: new Date().toISOString(),
    })
    // Persist the identity before sending: a lost acknowledgement must not
    // turn a retry into a new task with a different message ID.
    await this.serial(async () => {
      const history = [...this.history, { direction: 'sent' as const, status: 'unknown' as const, message, peerName: target.peer.name, recordedAt: new Date().toISOString() }].slice(-MAX_PEER_HISTORY)
      await this.persist(this.records, this.policy, history)
      this.history = history
    })
    let receipt: any
    try {
      receipt = await callGatewayPeer(target.peer.endpoint, { type: 'message', token: target.token, senderToken: this.token, message })
      if (receipt?.ok !== false && (receipt?.ok !== true || receipt.id !== message.id || !['held', 'queued', 'delivered', 'refused'].includes(receipt.state))) throw new Error('Invalid receipt')
    } catch (error) {
      // Never connected: the peer is gone, and the request was not handed over.
      // Saying so is what makes a dead peer cheap to discover - otherwise the
      // caller is told to check a receipt for a session that cannot have one,
      // and reads the failure as a transport bug rather than an exited peer.
      if ((error as { peerConnected?: boolean }).peerConnected === false) {
        await this.serial(async () => {
          const history = this.history.map(entry => entry.direction === 'sent' && entry.message.id === message.id ? { ...entry, status: 'failed' as const, error: 'Peer is not reachable' } : entry)
          await this.persist(this.records, this.policy, history)
          this.history = history
        }).catch(() => {})
        return {
          ok: false, alive: false, state: 'failed', id: message.id,
          reason: `Session ${toSessionId} is not reachable: its registration is on disk but nothing is listening. That session has exited or crashed without deregistering. Do not retry it; use /sessions list for peers that are live.`,
        }
      }
      return { ok: false, state: 'unknown', id: message.id, reason: 'Delivery acknowledgement unavailable. Check receipt before taking further action; do not send a new copy.' }
    }
    let historySaved = true
    try {
      await this.serial(async () => {
        const history = this.history.map(entry => entry.direction === 'sent' && entry.message.id === message.id ? { ...entry, status: receipt.ok === false ? 'refused' as const : receipt.state, ...(receipt.ok === false ? { error: String(receipt.reason ?? 'refused').slice(0, 500) } : {}) } : entry)
        await this.persist(this.records, this.policy, history)
        this.history = history
      })
    } catch { historySaved = false }
    // The recipient stores a message it cannot answer as `held`, and that
    // receipt is a success at the transport level - the message is durable and
    // owed. It is not a delivery, and reporting it as one is the defect this
    // gate closes: the sender would stop looking for an answer that cannot
    // come. `routeState` is the POOL's verdict, because that is what decides
    // whether the recipient can answer at all; the advertised number and its own
    // verdict ride along because they are what the sender would have to change.
    if (routeUnavailable && receipt?.ok === true && receipt.state === 'held') {
      return {
        ok: false,
        // The receipt is the recipient's own: it is alive, it stored the mail,
        // and it is only its credential that cannot serve.
        alive: true,
        delivered: false,
        state: 'held',
        reason: 'route_unavailable',
        routeState: health.state,
        id: message.id,
        historySaved,
        recipient: toSessionId,
        ...(advertised ? {
          provider: advertised.provider,
          number: advertised.number,
          ...(describePeerRoute(advertised) ? { route: describePeerRoute(advertised) } : {}),
        } : {}),
        ...(health.numberState ? { numberState: health.numberState } : {}),
        ...(health.size !== undefined ? { size: health.size } : {}),
        ...(health.http !== undefined ? { http: health.http } : {}),
        detail: health.reason,
        meaning: 'Held in the recipient inbox and still owed; it was not handed to a model.',
      }
    }
    return {
      ...receipt,
      id: message.id,
      alive: true,
      historySaved,
      routeState: health.state,
      // A recipient can still refuse for its own reasons; the gate is only a
      // statement about the route, never a substitute for the receipt.
      delivered: receipt?.ok !== false,
      meaning: 'queued/held means inbox acceptance; delivered means transcript-persisted, not task completion',
    }
  }

  async receipt(toSessionId: string, id: string): Promise<unknown> {
    if (!idPattern.test(id)) throw new Error('Invalid message ID')
    const target = await readRegistration(this.options.directory, toSessionId)
    const receipt = await callGatewayPeer(target.peer.endpoint, { type: 'receipt', token: target.token, senderToken: this.token, fromSessionId: this.peer.sessionId, fromRuntimeId: this.peer.runtimeId, id }) as any
    if (receipt?.ok !== true || receipt.id !== id || !['unknown', 'held', 'queued', 'delivered', 'refused'].includes(receipt.state)) throw new Error('Invalid receipt')
    if (receipt.state !== 'unknown') await this.serial(async () => {
      const history = this.history.map(entry => entry.direction === 'sent' && entry.message.id === id && entry.message.toSessionId === toSessionId ? { ...entry, status: receipt.state, error: undefined } : entry)
      await this.persist(this.records, this.policy, history)
      this.history = history
    })
    return receipt
  }

  async watchIdle(toSessionId: string): Promise<unknown> {
    const target = await readRegistration(this.options.directory, toSessionId)
    return callGatewayPeer(target.peer.endpoint, { type: 'watch_idle', token: target.token, senderToken: this.token, fromSessionId: this.peer.sessionId, fromRuntimeId: this.peer.runtimeId })
  }

  /**
   * Read what a peer has been doing, without disturbing it.
   *
   * The target serves the reply from its own transcript, so a peer that is
   * mid-turn - or closed, or archived - still answers: nothing is asked of its
   * model, and the read never competes with the work it is watching. `since`
   * takes the cursor a previous read returned, so following along costs only the
   * turns that are new.
   */
  async readPeer(toSessionId: string, options: { tail?: number; since?: string } = {}): Promise<TranscriptSlice> {
    const target = await readRegistration(this.options.directory, toSessionId)
    if (target.peer.sessionId === this.peer.sessionId) throw new Error('That is this session; its own turns are already in front of you')
    const response = await callGatewayPeer(target.peer.endpoint, {
      type: 'read', token: target.token, senderToken: this.token,
      fromSessionId: this.peer.sessionId, fromRuntimeId: this.peer.runtimeId,
      ...(options.tail !== undefined ? { tail: options.tail } : {}),
      ...(options.since ? { since: options.since } : {}),
    }) as { ok?: boolean; slice?: TranscriptSlice; reason?: string }
    if (response?.ok !== true || !response.slice) throw new Error(String(response?.reason ?? 'Peer read returned nothing'))
    return response.slice
  }

  async setPolicy(policy: GatewayInboundPolicy, withdraw?: () => { ids: ReadonlySet<string>; rollback: () => void; commit: () => void }): Promise<void> {
    await this.serial(async () => {
      if (!['accept', 'hold', 'refuse'].includes(policy)) throw new Error('Invalid inbound policy')
      const withdrawal = policy === 'accept' ? undefined : withdraw?.()
      const next: GatewayInboxRecord[] = this.records.map(record => record.state !== 'held' && !(record.state === 'queued' && withdrawal?.ids.has(record.message.id)) ? record : {
        ...record, state: policy === 'accept' ? 'queued' : policy === 'refuse' ? 'refused' : 'held',
      })
      const states = new Map(next.map(record => [record.message.id, record.state]))
      const history = this.history.map(entry => entry.direction === 'received' && states.has(entry.message.id) ? { ...entry, status: states.get(entry.message.id)! } : entry)
      try { await this.persist(next, policy, history) }
      catch (error) { withdrawal?.rollback(); throw error }
      this.records = next
      this.history = history
      this.policy = policy
      withdrawal?.commit()
      this.options.onInboxChanged?.()
    })
  }

  async acknowledge(id: string): Promise<void> {
    await this.serial(async () => {
      const record = this.records.find(record => record.message.id === id)
      if (!record || record.state !== 'queued') return
      const next: GatewayInboxRecord[] = this.records.map(item => item === record ? { ...item, state: 'delivered' } : item)
      const history = this.history.map(entry => entry.direction === 'received' && entry.message.id === id ? { ...entry, status: 'delivered' as const } : entry)
      await this.persist(next, this.policy, history)
      this.records = next
      this.history = history
    })
  }

  setCompactionCounts(counts: { compactBoundaryCount: number; microcompactBoundaryCount: number } | undefined): void {
    if (counts) {
      this.peer.compactBoundaryCount = counts.compactBoundaryCount
      this.peer.microcompactBoundaryCount = counts.microcompactBoundaryCount
    } else {
      delete this.peer.compactBoundaryCount
      delete this.peer.microcompactBoundaryCount
    }
  }

  async update(values: Partial<Pick<GatewayPeer, 'name' | 'purpose' | 'status' | 'topics' | 'compactBoundaryCount' | 'microcompactBoundaryCount'>>): Promise<void> {
    // A session that switches model or account mid-life spends on the new route,
    // and a registration that keeps advertising the launch-time credential
    // would let a sender withhold mail for a key that is no longer in use. A
    // status change is the ordinary boundary at which that can be true - it
    // happens at every turn start and end - so it is where the advertisement is
    // refreshed.
    const route = await describeOwnRoute()
    const subscribers = await this.serial(async () => {
      const next = gatewayPeerSchema.parse({ ...this.peer, ...(route ? { route } : {}), ...values })
      await atomicJson(this.registrationPath, { peer: next, token: this.token })
      const becameIdle = this.peer.status !== 'idle' && next.status === 'idle'
      Object.assign(this.peer, next)
      const subscribers = becameIdle ? [...this.idleSubscribers] : []
      if (becameIdle) this.idleSubscribers.clear()
      return subscribers
    })
    // Outbound requests must not hold the inbox chain: peers can notify each other.
    for (const [sessionId, runtimeId] of subscribers) {
      try {
        const target = await readRegistration(this.options.directory, sessionId)
        if (target.peer.runtimeId === runtimeId) await this.send(sessionId, `Session ${this.peer.sessionId} is now idle. This one-shot subscription has ended.`, 'Session became idle')
      } catch { /* Offline subscribers are not resumed or retried automatically. */ }
    }
    // A turn boundary is also when a credential that was exhausted may have been
    // rotated or replenished, so any mail held for the old verdict is offered
    // back to the model.
    void this.releaseRouteHeld().catch(() => {})
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.isClosing = true
    // A closed session can no longer start a turn, so its timers are dead
    // schedules and its state files would lie to `--status`. Stop both.
    for (const token of [...this.wakeTimers.keys()]) {
      this.clearWakeTimer(token)
      void this.clearWakeState(token).catch(() => {})
    }
    this.closing = (async () => {
      await this.starting?.catch(() => {})
      await new Promise<void>(resolve => this.server ? this.server.close(() => resolve()) : resolve())
      await this.chain
      try {
        const current = await readRegistration(this.options.directory, this.peer.sessionId)
        if (current.peer.runtimeId === this.peer.runtimeId) await unlink(this.registrationPath)
      } catch (error) {
        // A registration that is already gone is the outcome this is reaching
        // for, not a failure, so it must not be reported as one. The check here
        // used to be for ENOENT, which readRegistration never emits: it turns a
        // missing file into its own error. So closing a session whose
        // registration had been removed threw, and the throw landed in teardown
        // - where it turns a clean shutdown into a failure - and in the
        // start-failure path, where it replaced the reason the start failed.
        // A genuinely unreadable registration is still surfaced.
        if (!(error instanceof NoRegistrationError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    })()
    return this.closing
  }
}
