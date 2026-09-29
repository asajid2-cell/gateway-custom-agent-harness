import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { lstat, mkdir, open, readdir, readFile, rename, stat, unlink } from 'node:fs/promises'
import { createConnection, createServer, type Server } from 'node:net'
import { join } from 'node:path'
import { isProcessRunning } from './genericProcessUtils.js'
import { lock } from './lockfile.js'
import {
  GATEWAY_SESSION_PROTOCOL, MAX_PEER_MESSAGE_BYTES, MAX_PEER_QUEUE, MAX_PEER_HISTORY,
  gatewayPeerSchema, gatewayPeerMessageSchema, gatewayInboxSchema, parsePeerMessage,
  type GatewayPeer, type GatewayPeerMessage, type GatewayInboxRecord, type GatewayPeerHistoryEntry,
  type GatewayInboundPolicy, type PeerMessageKind,
} from './gatewaySessionProtocol.js'
import { readTranscriptSlice, type TranscriptSlice } from './transcriptRead.js'

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

async function checkPrivateDirectory(directory: string): Promise<void> {
  const stat = await lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid session directory')
  if (process.platform !== 'win32') {
    if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error('Session directory must be private')
    return
  }
  const script = `$ErrorActionPreference='Stop'; $acl=Get-Acl -LiteralPath $env:GATEWAY_DIRECTORY_CHECK; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; if($owner -ne $sid){exit 2}; foreach($rule in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) { if($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @($sid,'S-1-5-18','S-1-5-32-544')) {exit 3} }`
  try {
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, GATEWAY_DIRECTORY_CHECK: directory }, timeout: 10000, maxBuffer: 4096, windowsHide: true,
    })
  } catch { throw new Error('Session directory must have a private Windows ACL') }
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

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    try {
      await handle.writeFile(JSON.stringify(value))
      await handle.sync()
    } finally { await handle.close() }
    await rename(temporary, path)
  } finally { await unlink(temporary).catch(() => {}) }
}

export async function callGatewayPeer(endpoint: string, request: unknown): Promise<unknown> {
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
    socket.setTimeout(RESPONSE_TIMEOUT_MS, fail)
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
    const peer = gatewayPeerSchema.parse(value.peer)
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
  if (candidates.length === 0) return []
  // Validate the directory once for the whole listing. A stale registration is
  // the common case here, and the check is a PowerShell spawn on Windows: doing
  // it per file made discovery cost ~350ms per registration on disk.
  try { await validatePrivateDirectory(directory) } catch { return [] }
  const peers: GatewayPeer[] = []
  for (const entry of candidates) {
    const sessionId = entry.slice(0, -5)
    // Kept outside the try so the sweep can run after a failure. A peer that is
    // gone usually fails the ping by rejecting rather than by answering
    // something unrecognisable - the endpoint does not exist any more - so a
    // sweep that only ran on a mismatch would never run at all. An unreadable
    // registration leaves this unset, and nothing is deleted on a guess.
    let peer: GatewayPeer | undefined
    let answered = false
    try {
      const registration = await readRegistrationUnchecked(directory, sessionId)
      peer = registration.peer
      const response = await callGatewayPeer(peer.endpoint, { type: 'ping', token: registration.token }) as { runtimeId?: string }
      answered = response.runtimeId === peer.runtimeId
      if (answered) peers.push(peer)
    } catch { /* Stale or inaccessible registrations are not live sessions. */ }
    if (peer && !answered) await unlinkIfDead(directory, sessionId, peer.pid)
  }
  return peers
}

/**
 * How long a dead registration is kept before a listing lets it go.
 *
 * Not zero, because a registration is not only a liveness advertisement: a
 * session that restarts reads it back to keep the intent it had already declared
 * and the topics it had already been working on, which is what stops a resumed
 * session reappearing as an unnamed stranger. A session that crashed and is about
 * to be resumed is dead for exactly that moment, so deleting on the first dead
 * listing would quietly throw that intent away. An hour is far longer than any
 * crash-restart and short enough that an abandoned fleet empties within the day.
 */
const DEAD_REGISTRATION_GRACE_MS = 3_600_000

/**
 * Delete a registration that is provably dead and no longer needed, rather than
 * only filtering it out of the answer.
 *
 * A filtered listing was correct and still left the problem behind: the file
 * stayed on disk advertising a name, a cwd and a pid for a session that had
 * exited, so anything reading the directory directly - a person, a process
 * scanner, a diagnosis of a pile-up - kept being told about sessions that no
 * longer existed. The listing is the only routine that reads every registration,
 * so it is also the only place that can let them go.
 *
 * Two independent signals are required before deleting. The endpoint must have
 * failed to answer AND the recorded pid must be gone: a busy peer can miss a
 * ping, and a recycled pid reads as alive, while deleting a live session's
 * registration would make it unreachable until it happened to write one again.
 * Being wrong in the other direction only leaves a stale file, which is what
 * happens today anyway.
 */
async function unlinkIfDead(directory: string, sessionId: string, pid: number): Promise<void> {
  if (isProcessRunning(pid)) return
  const path = join(directory, `${sessionId}.json`)
  try {
    if (Date.now() - (await stat(path)).mtimeMs < DEAD_REGISTRATION_GRACE_MS) return
  } catch { return }
  // A live process may have written a fresh registration since the read above;
  // only remove the one that was actually proven dead.
  try {
    const current = await readRegistrationUnchecked(directory, sessionId)
    if (current.peer.pid !== pid) return
  } catch { return }
  await unlink(path).catch(() => {})
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

  constructor(private readonly options: {
    directory: string
    sessionId: string
    name: string
    cwd: string
    purpose?: string
    policy?: GatewayInboundPolicy
    onInboxChanged?: () => void
  }) {
    const runtimeId = randomUUID()
    this.peer = gatewayPeerSchema.parse({
      protocol: GATEWAY_SESSION_PROTOCOL, sessionId: options.sessionId, runtimeId,
      name: options.name, cwd: options.cwd, purpose: options.purpose ?? '',
      pid: process.pid, startedAt: new Date().toISOString(), status: 'idle',
      endpoint: process.platform === 'win32' ? `\\\\.\\pipe\\gateway-${runtimeId}` : join(options.directory, `${runtimeId}.sock`),
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
      try {
        await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
          env: { ...process.env, GATEWAY_DIRECTORY_CHECK: this.options.directory }, timeout: 10000, maxBuffer: 4096, windowsHide: true,
        })
      } catch { throw new Error('Could not create private session directory') }
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
        const inbox = gatewayInboxSchema.parse(raw)
        if (inbox.records.some(record => record.message.toSessionId !== this.peer.sessionId) || new Set(inbox.records.map(record => record.message.id)).size !== inbox.records.length) throw new Error('Invalid inbox records')
        this.records = inbox.records
        this.policy = inbox.policy
        this.history = inbox.history ?? []
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      // A session that restarts keeps the intent it already declared or derived.
      // Without this the registration is rewritten blank on every launch, so a
      // stated purpose silently disappeared the moment the session reconnected.
      try {
        const raw = JSON.parse(await readFile(this.registrationPath, 'utf8')) as { peer?: { purpose?: unknown } }
        if (typeof raw?.peer?.purpose === 'string') this.peer.purpose = raw.peer.purpose.slice(0, 1000)
      } catch { /* No prior registration, or it is unreadable: intent starts empty. */ }
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
          // Start registration checks together, but reserve mutation order now.
          // Otherwise every queued message pays for a separate PowerShell ACL check.
          const sender = this.authenticateSender(request).then(value => ({ value, fault: undefined as Error | undefined }), (error: unknown) => ({ value: undefined, fault: error instanceof Error ? error : new Error('Invalid sender') }))
          void this.serial(async () => {
            let response: unknown
            try {
              const authenticated = await sender
              if (request.type !== 'ping' && !authenticated.value) {
                if (authenticated.fault instanceof UnregisteredSenderError) throw authenticated.fault
                throw new Error('Invalid sender')
              }
              response = await this.handle(request, authenticated.value)
            }
            catch (error) {
              response = error instanceof UnregisteredSenderError
                ? { ok: false, reason: `The sender is not registered on this bus, so its message cannot be attributed: ${error.message}` }
                : { ok: false, reason: 'Invalid or unauthorized peer request' }
            }
            socket.end(`${JSON.stringify(response)}\n`)
          }).catch(() => socket.destroy())
        })
      })
      await new Promise<void>((resolve, reject) => {
        this.server!.once('error', reject)
        this.server!.listen(this.peer.endpoint, resolve)
      })
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
    if (typeof request?.token !== 'string') throw new Error('Unauthorized')
    const supplied = Buffer.from(request.token)
    const expected = Buffer.from(this.token)
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('Unauthorized')
    if (request.type === 'ping') return { ok: true, runtimeId: this.peer.runtimeId }
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
    const state = this.policy === 'hold' ? 'held' : 'queued'
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
    return { ok: true, state: record.state, id: message.id }
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
   * nothing, so it is excluded - this exists to surface the first turn of a
   * conversation, not to make two agents acknowledge each other forever.
   */
  outstandingReplies(): readonly { toMessageId: string; toSessionId: string; summary: string; receivedAt: string }[] {
    const answered = new Set(this.history.filter(entry => entry.direction === 'sent').map(entry => entry.message.replyTo).filter(Boolean) as string[])
    return this.records
      .filter(record => record.message.replyTo === undefined && !answered.has(record.message.id))
      .map(record => ({
        toMessageId: record.message.id,
        toSessionId: record.message.fromSessionId,
        summary: record.message.summary,
        receivedAt: record.receivedAt,
      }))
  }

  async send(toSessionId: string, text: string, summary: string, replyTo?: string, kind?: PeerMessageKind): Promise<unknown> {
    const target = await readRegistration(this.options.directory, toSessionId)
    const message: GatewayPeerMessage = gatewayPeerMessageSchema.parse({
      id: randomUUID(), fromSessionId: this.peer.sessionId, fromRuntimeId: this.peer.runtimeId,
      toSessionId, text, summary, replyTo, ...(kind ? { kind } : {}), createdAt: new Date().toISOString(),
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
          ok: false, state: 'failed', id: message.id,
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
    return { ...receipt, id: message.id, historySaved, meaning: 'queued/held means inbox acceptance; delivered means transcript-persisted, not task completion' }
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

  async update(values: Partial<Pick<GatewayPeer, 'name' | 'purpose' | 'status' | 'topics'>>): Promise<void> {
    const subscribers = await this.serial(async () => {
      const next = gatewayPeerSchema.parse({ ...this.peer, ...values })
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
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.isClosing = true
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
