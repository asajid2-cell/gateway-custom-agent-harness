/**
 * Durability of a peer registration, and the explicit OPEN request.
 *
 * A leaf family's matriarch is the family's entry point: a session that other
 * sessions address when they want the family brought back. Ordinary leaves and
 * non-matriarch heads are NOT durable. The rule is deliberately mechanical and
 * lives here rather than in the transport, because the transport must never
 * read leaf-families: the one place the answer is computed is where the
 * session's own session id is already known.
 *
 * Two things in this module are not registration work:
 *
 *  - Liveness of a durable entry. It is decided ONLY by `pid alive AND endpoint
 *    present`. A route-health probe is never evidence about liveness, and
 *    `health_unavailable` is never a reason to call a peer closed or dead.
 *  - The OPEN request. It is the only thing that may start a durable session,
 *    and it reports a three-way outcome it can prove.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { lstat, open, readFile, readdir, stat, unlink } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { cleanLeafOwnerEnv } from './deepLink/terminalLauncher.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { isProcessRunning } from './genericProcessUtils.js'
import { parseGatewayPeer, type DurableState, type GatewayPeer, type GatewayPeerRoute } from './gatewaySessionProtocol.js'

/** Where a family's records live, given a config home. */
export function leafFamilyPaths(configHome: string, familyId: string): {
  hostClaim: string
  familyRecord: string
  openLock: string
} {
  const index = join(configHome, 'leaf-families', 'index')
  return {
    hostClaim: join(index, `${familyId}.host.json`),
    familyRecord: join(configHome, 'leaf-families', `${familyId}.json`),
    openLock: join(index, `${familyId}.host.open.lock`),
  }
}

export type DurableIdentity = {
  /** True only for the family matriarch. Absent/false is the fail-safe default. */
  durable: boolean
  familyId?: string
}

/**
 * Whether a session is a family's durable matriarch.
 *
 * The authority is `index/<familyId>.host.json`; only a `matriarchSessionId`
 * equal to this session id makes it durable. The deprecated
 * `index/<familyId>.json#patriarchSessionId` alias is read ONLY for a family
 * that has no host claim at all - a legacy family. If a host claim exists it
 * wins outright, which is what keeps a non-matriarch head from being made
 * durable by an alias the family no longer treats as its entry point.
 *
 * The family record `leaf-families/<familyId>.json` is what makes an id a
 * FAMILY at all, so it is required on both paths. That is the same definition
 * the registry reaper uses, and the two must not disagree: a claim naming a
 * family that does not exist cannot make a session the entry point of one,
 * because the next listing would retire its registration as an entry point to
 * nothing. Requiring it here is what stops a live session from publishing a
 * durable claim the bus then acts on.
 *
 * Two things used to make that happen together. Every family member gets its
 * own pointer copy at `index/<memberSessionId>.json`, and a copy carries the
 * family's `patriarchSessionId` as it stood when it was written. Scanning the
 * index for that field therefore matched a MEMBER's copy and returned the
 * copy's own filename - a session id - as the family id. `rootSessionId` is
 * the family, so a legacy alias counts only for the file that IS the family's
 * root pointer (`rootSessionId === stem`), which excludes every member copy.
 *
 * Exported for testing. Never throws: an unreadable index is "not durable",
 * the direction that cannot make an ordinary peer immortal.
 */
export async function resolveDurableIdentity(
  sessionId: string,
  configHome: string = getClaudeConfigHomeDir(),
): Promise<DurableIdentity> {
  const index = join(configHome, 'leaf-families', 'index')
  let entries: string[]
  try { entries = await readdir(index) } catch { return { durable: false } }
  const familyExists = async (familyId: string): Promise<boolean> => {
    try { await stat(leafFamilyPaths(configHome, familyId).familyRecord); return true } catch { return false }
  }
  const hostClaims = new Set<string>()
  for (const entry of entries) {
    if (!entry.endsWith('.host.json')) continue
    const familyId = entry.slice(0, -'.host.json'.length)
    if (!familyId) continue
    hostClaims.add(familyId)
    try {
      const claim = JSON.parse(await readFile(join(index, entry), 'utf8')) as { matriarchSessionId?: unknown }
      if (claim?.matriarchSessionId !== sessionId) continue
      if (await familyExists(familyId)) return { durable: true, familyId }
    } catch { /* An unreadable claim is not a claim. */ }
  }
  // Legacy fallback. A family that HAS a host claim is not read here: its claim
  // already answered, and a stale patriarchal alias must not contradict it.
  for (const entry of entries) {
    if (!entry.endsWith('.json') || entry.endsWith('.host.json')) continue
    const familyId = entry.slice(0, -'.json'.length)
    if (!familyId || hostClaims.has(familyId)) continue
    try {
      const pointer = JSON.parse(await readFile(join(index, entry), 'utf8')) as { rootSessionId?: unknown; patriarchSessionId?: unknown }
      if (pointer?.patriarchSessionId !== sessionId) continue
      // A member's copy is not the family's root pointer: it names the root in
      // `rootSessionId` while living under the member's own session id.
      if (pointer.rootSessionId !== familyId) continue
      if (await familyExists(familyId)) return { durable: true, familyId }
    } catch { /* An unreadable pointer is not a pointer. */ }
  }
  return { durable: false }
}

export type EndpointProbe = 'present' | 'absent' | 'unknown'

/**
 * Whether an endpoint exists right now.
 *
 * A named pipe cannot be stat'd, so the check is a connect: a listener accepts,
 * a pipe whose process is gone refuses with ENOENT. `unknown` is the honest
 * answer for anything else (including a connect that hung), and it is NOT a
 * liveness verdict - the caller must not turn it into `closed`.
 */
export async function probeEndpoint(endpoint: string, timeoutMs = 400): Promise<EndpointProbe> {
  if (process.platform !== 'win32') {
    try { await lstat(endpoint); return 'present' }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      return code === 'ENOENT' ? 'absent' : 'unknown'
    }
  }
  return new Promise<EndpointProbe>(resolve => {
    const socket = createConnection(endpoint)
    let settled = false
    const done = (value: EndpointProbe) => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch { /* already gone */ }
      resolve(value)
    }
    socket.setTimeout(timeoutMs, () => done('unknown'))
    socket.once('connect', () => done('present'))
    socket.once('error', (error: NodeJS.ErrnoException) => {
      // Only a code that names the pipe as gone is proof of absence. Any other
      // connect error is a probe that could not be evaluated, which is `unknown`
      // - never evidence that the peer is closed.
      done(error.code === 'ENOENT' || error.code === 'ECONNREFUSED' ? 'absent' : 'unknown')
    })
  })
}

/**
 * Liveness of a durable entry, from the only two facts that decide it.
 *
 * `open` = the pid is alive AND the endpoint is present. `closed` = either is
 * gone. `unknown` = the probe itself could not be evaluated (which a caller
 * must render as unknown, never as dead).
 *
 * The injectable probe exists so a test can drive the throwing branch without
 * a machine that can force a socket probe to fail.
 */
export async function durableLiveness(
  peer: Pick<GatewayPeer, 'pid' | 'endpoint'>,
  probe: (endpoint: string) => Promise<EndpointProbe> = probeEndpoint,
): Promise<DurableState> {
  try {
    if (!isProcessRunning(peer.pid)) return 'closed'
    const state = await probe(peer.endpoint)
    return state === 'present' ? 'open' : state === 'absent' ? 'closed' : 'unknown'
  } catch {
    return 'unknown'
  }
}

// ---------------------------------------------------------------------------
// Explicit OPEN request
// ---------------------------------------------------------------------------

export type OpenCheck = 'pid-not-alive' | 'pipe-absent' | 'generation-not-advanced' | 'claim-stale-raced' | 'not-durable'
export type OpenOutcome =
  | { state: 'opened'; sessionId: string; pid: number; generation: number }
  | { state: 'already-open'; sessionId: string; pid: number; generation: number }
  | { state: 'failed'; check: OpenCheck }

/** One output line, exactly as the gateway-peers skill and its SKILL.md read it. */
export function formatOpenOutcome(outcome: OpenOutcome): string {
  if (outcome.state === 'opened') return `opened: ${outcome.sessionId} (pid ${outcome.pid}, generation ${outcome.generation})`
  if (outcome.state === 'already-open') return `already-open: writer ${outcome.sessionId} (pid ${outcome.pid}, generation ${outcome.generation})`
  return `failed: ${outcome.check}; retry ${outcome.check === 'claim-stale-raced' ? 'safe-once' : 'unsafe'}`
}

type HostClaim = { familyId?: string; matriarchSessionId: string; pid: number; processStartedAt?: string; generation: number }
type OpenLock = { sessionId: string; pid: number; token: string; createdAt: string }

async function readHostClaim(path: string): Promise<HostClaim | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as HostClaim
    if (!parsed || typeof parsed.matriarchSessionId !== 'string' || !Number.isSafeInteger(parsed.generation) || !Number.isSafeInteger(parsed.pid)) return undefined
    return parsed
  } catch { return undefined }
}

async function readRegistrationPeer(directory: string, sessionId: string): Promise<GatewayPeer | undefined> {
  try {
    const raw = JSON.parse(await readFile(join(directory, `${sessionId}.json`), 'utf8')) as { peer?: unknown }
    return parseGatewayPeer(raw.peer)
  } catch { return undefined }
}

export type OpenOptions = {
  /** The launcher seam. Tests MUST inject this; the default opens a real tab. */
  launcher?: (session: {
    sessionId: string
    cwd: string
    familyId: string
    route?: GatewayPeerRoute
  }) => Promise<{ ok: boolean }>
  configHome?: string
  postOpenTimeoutMs?: number
  pollMs?: number
  probeEndpoint?: (endpoint: string) => Promise<EndpointProbe>
  now?: () => number
  /** A lock older than this, or with a dead pid, is stale and may be replaced. */
  staleClaimMs?: number
  /**
   * Test seam: runs after a stale lock is removed and just before the retry.
   * It is how the losing half of a stale-claim race can be driven for real
   * rather than asserted from a hardcoded branch.
   */
  onStaleClaimRemoved?: () => Promise<void>
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * Ask a durable peer to open, truthfully.
 *
 * Delivery never opens a peer; this is the only path that does, and it is
 * explicit. The winner is decided by an atomic exclusive create beside the
 * family record (the CAS), and a live claim is reported as `already-open`
 * WITHOUT the launcher being invoked. `opened` is reported only when all three
 * post-open checks pass: the host claim generation advanced, its pid is alive,
 * and the target's endpoint is present.
 */
export async function requestDurablePeerOpen(
  directory: string,
  sessionId: string,
  options: OpenOptions = {},
): Promise<OpenOutcome> {
  const configHome = options.configHome ?? getClaudeConfigHomeDir()
  const now = options.now ?? Date.now
  const probe = options.probeEndpoint ?? probeEndpoint
  const timeoutMs = options.postOpenTimeoutMs ?? 30_000
  const pollMs = options.pollMs ?? 100
  const staleClaimMs = options.staleClaimMs ?? 60_000

  const failed = (check: OpenCheck): OpenOutcome => ({ state: 'failed', check })

  const peer = await readRegistrationPeer(directory, sessionId)
  if (!peer || peer.durable !== true || !peer.durableFamilyId) return failed('not-durable')
  const familyId = peer.durableFamilyId
  const paths = leafFamilyPaths(configHome, familyId)
  const hostBefore = await readHostClaim(paths.hostClaim)
  if (!hostBefore) return failed('not-durable')
  const baseline = hostBefore.generation

  // (a) PRIMARY. The peer row alone is not evidence of open: a dead process
  // leaves a stale row until the reaper runs. A live pid AND a present pipe is.
  if (await durableLiveness(peer, probe) === 'open') {
    return { state: 'already-open', sessionId, pid: peer.pid, generation: baseline }
  }
  // (b) The family host claim. A live holder is the writer; nothing is opened.
  if (isProcessRunning(hostBefore.pid)) {
    return { state: 'already-open', sessionId: hostBefore.matriarchSessionId, pid: hostBefore.pid, generation: baseline }
  }

  // The CAS: one opener at a time, decided by O_EXCL. A lock whose pid is dead,
  // or that is older than the window, is stale - a crashed opener must not
  // deadlock the next one.
  const lock: OpenLock = { sessionId, pid: process.pid, token: randomBytes(16).toString('hex'), createdAt: new Date(now()).toISOString() }
  let handle
  let raced = false
  try {
    handle = await open(paths.openLock, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    let existing: OpenLock | undefined
    try { existing = JSON.parse(await readFile(paths.openLock, 'utf8')) as OpenLock } catch { existing = undefined }
    const stale = !existing
      || !isProcessRunning(existing.pid)
      || now() - Date.parse(existing.createdAt) > staleClaimMs
    if (!stale) {
      return { state: 'already-open', sessionId: existing!.sessionId, pid: existing!.pid, generation: baseline }
    }
    await unlink(paths.openLock).catch(() => {})
    if (options.onStaleClaimRemoved) await options.onStaleClaimRemoved()
    try { handle = await open(paths.openLock, 'wx', 0o600) }
    catch (retryError) {
      if ((retryError as NodeJS.ErrnoException).code !== 'EEXIST') throw retryError
      raced = true
    }
  }
  if (raced || !handle) return failed('claim-stale-raced')

  try {
    await handle.writeFile(JSON.stringify(lock))
    await handle.sync()
    await handle.close()
    handle = undefined

    // Re-read after taking the CAS. A live claim that advanced while we were
    // acquiring is someone else's open, not ours.
    const hostAfterLock = await readHostClaim(paths.hostClaim)
    if (hostAfterLock && hostAfterLock.generation !== baseline && isProcessRunning(hostAfterLock.pid)) {
      return { state: 'already-open', sessionId: hostAfterLock.matriarchSessionId, pid: hostAfterLock.pid, generation: hostAfterLock.generation }
    }

    try {
      await (options.launcher ?? launchDurableSession)({ sessionId, cwd: peer.cwd, familyId, route: peer.route })
    } catch { /* The post-open checks decide, not the launcher's exit. */ }

    return await waitForOpen()
  } finally {
    await handle?.close().catch(() => {})
    await unlink(paths.openLock).catch(() => {})
  }

  async function waitForOpen(): Promise<OpenOutcome> {
    let host = await readHostClaim(paths.hostClaim)
    let latest = await readRegistrationPeer(directory, sessionId)
    const deadline = now() + timeoutMs
    // Evaluate once even on a zero window, so a launcher that already finished
    // the work is not reported as a timeout.
    for (;;) {
      const generationAdvanced = host !== undefined && host.generation > baseline
      const pidAlive = host !== undefined && isProcessRunning(host.pid)
      const endpoint = latest?.endpoint
      const pipePresent = endpoint !== undefined && await probe(endpoint) === 'present'
      if (generationAdvanced && pidAlive && pipePresent) {
        return { state: 'opened', sessionId, pid: host!.pid, generation: host!.generation }
      }
      if (now() >= deadline) {
        if (!generationAdvanced) return failed('generation-not-advanced')
        if (!pidAlive) return failed('pid-not-alive')
        if (!pipePresent) return failed('pipe-absent')
        return failed('generation-not-advanced')
      }
      await sleep(Math.min(pollMs, Math.max(0, deadline - now())))
      host = await readHostClaim(paths.hostClaim) ?? host
      latest = await readRegistrationPeer(directory, sessionId) ?? latest
    }
  }
}

/**
 * The argv for one durable launch, as a pure function.
 *
 * It is pure so the pinning can be tested without spawning a terminal, and so
 * there is exactly one place the shape is written. `-w 0` is the EXISTING
 * window; `-w new` is never used. `--resume <sessionId>` is always present -
 * the launched tab IS this session, and that is what makes its registration
 * authoritative. The route is pinned with `--model`/`--effort` when the peer
 * advertised them: a resumed session on a default route would spend a different
 * account than the one the address was resolved against. Absent route fields
 * add neither flag; no default is invented here.
 */
export function durableLaunchArgs(session: {
  entry: string
  cwd: string
  sessionId: string
  route?: GatewayPeerRoute
}): string[] {
  const pinned: string[] = []
  if (session.route?.model) pinned.push('--model', session.route.model)
  if (session.route?.effort) pinned.push('--effort', session.route.effort)
  return ['-w', '0', 'nt', '-d', session.cwd, '--', session.entry, '--resume', session.sessionId, ...pinned]
}

/**
 * The real launcher: one tab in the EXISTING Windows Terminal window.
 *
 * The tab inherits the launched session's own cwd, and the leaf-owner
 * variables are removed so the resumed session does not come up as a headless
 * leaf. Start-Process is never used for the `-d` path because it re-quotes and
 * breaks it.
 */
export async function launchDurableSession(session: {
  sessionId: string
  cwd: string
  route?: GatewayPeerRoute
}): Promise<{ ok: boolean }> {
  if (process.platform !== 'win32') return { ok: false }
  const entry = process.argv[1]
  if (!entry) return { ok: false }
  return new Promise<{ ok: boolean }>(resolve => {
    const child = spawn('wt.exe', durableLaunchArgs({ entry, cwd: session.cwd, sessionId: session.sessionId, route: session.route }), {
      cwd: session.cwd,
      detached: true,
      stdio: 'ignore',
      env: cleanLeafOwnerEnv(),
      windowsHide: true,
    })
    child.once('error', () => resolve({ ok: false }))
    child.once('spawn', () => { child.unref(); resolve({ ok: true }) })
  })
}
