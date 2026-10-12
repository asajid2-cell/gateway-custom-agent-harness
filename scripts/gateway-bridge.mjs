#!/usr/bin/env node
/**
 * gateway-bridge.mjs - a voluntary transport between two hosts' gateway session
 * buses.
 *
 * The gateway bus is host-local by construction. A registration records its
 * endpoint as a Unix socket (`<dir>/<runtimeId>.sock`) or a Windows named pipe
 * (`\\.\pipe\gateway-<runtimeId>`), and a reader rejects any registration whose
 * endpoint does not match the reader's own platform
 * (gatewaySessionTransport.ts:298-301). So a session on one host is invisible to
 * a session on another, and neither can reach the other, by design rather than
 * by accident.
 *
 * This bridge is the opt-in join. It does NOT merge the buses: each host keeps
 * its own directory, its own registrations, its own liveness. The bridge carries
 * ADDRESSED FRAMES between them, over a single authenticated ssh channel, and
 * makes each side's sessions appear reachable on the other by writing a MIRROR
 * registration whose endpoint is rewritten to a socket the bridge itself listens
 * on. A frame that arrives on a mirror listener is forwarded to the peer half,
 * which delivers it to the real endpoint; the reply travels back the same way.
 *
 * Identity caveat, stated plainly: the protocol authenticates a sender by
 * reading the sender's registration from the RECEIVER's directory and comparing
 * a 64-hex token. For a cross-host sender to be accepted at all, that token must
 * be present on the receiving side - so the bridge carries session tokens
 * between the two hosts. The mirror is only as trustworthy as the host the token
 * came from, which is why the channel is ssh and the whole feature is opt-in.
 *
 * Usage:
 *   host side:   node gateway-bridge.mjs --peer-host <ssh-host> [--remote-script <path>] [--dir <dir>]
 *   remote side: node gateway-bridge.mjs --remote [--dir <dir>]
 *
 * The host side spawns `ssh <peer-host> node <remote-script> --remote` and speaks
 * a newline-delimited JSON protocol over that child's stdio. The remote side
 * speaks the same protocol over its own stdin/stdout. Both sides run the same
 * local logic; only the transport differs.
 */
import { createServer, createConnection } from 'node:net'
import { readdir, readFile, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { homedir, platform } from 'node:os'

const argv = process.argv.slice(2)
const opt = name => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const REMOTE = argv.includes('--remote')
const PEER_HOST = opt('--peer-host')
const REMOTE_SCRIPT = opt('--remote-script') ?? '$HOME/gateway-bridge.mjs'
const DIR = opt('--dir') ?? join(homedir(), '.claude', 'gateway-sessions')
// The peer's bus directory is not this host's: each side defaults to its own
// home. Only pass it through when the peer's differs from its default.
const PEER_DIR = opt('--peer-dir')
const INTERVAL_MS = Number(opt('--interval') ?? 3000)
const DELIVER_TIMEOUT_MS = Number(opt('--deliver-timeout') ?? 15000)
const isWin = platform() === 'win32'

if (!REMOTE && !PEER_HOST) {
  process.stderr.write('gateway-bridge: --peer-host <ssh-host> is required on the host side\n')
  process.exit(2)
}

const idRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const endpointFor = runtimeId => isWin ? `\\\\.\\pipe\\gateway-${runtimeId}` : join(DIR, `${runtimeId}.sock`)
const log = message => process.stderr.write(`gateway-bridge[${REMOTE ? 'remote' : 'host'}] ${message}\n`)

// ---------------------------------------------------------------------------
// The peer channel: one newline-delimited JSON stream, in both directions.
// ---------------------------------------------------------------------------
let peerWrite = () => {}
let peerUp = false

function send (obj) {
  if (!peerUp) return
  try { peerWrite(`${JSON.stringify(obj)}\n`) } catch { /* the close handler reconnects */ }
}

function onPeerLine (line) {
  if (!line.trim()) return
  let message
  try { message = JSON.parse(line) } catch { return }
  handle(message).catch(error => log(`handle failed: ${error?.message || error}`))
}

// State:
//  mirrored   - sessions that belong to the PEER, for which we hold a mirror file
//               and a listener. Never pushed back.
//  published  - the JSON of the last `add` we sent for our OWN sessions, so we
//               only re-send on change.
//  awaiting   - a local mirror listener's connection, awaiting the peer's reply.
const mirrored = new Map() // sessionId -> { runtimeId, server, tokenJson, peer }
const published = new Map() // sessionId -> signature
const awaiting = new Map() // frameId -> socket
let frameSeq = 0

async function handle (message) {
  switch (message.op) {
    case 'add': return addMirror(message.sessionId, message.peer, message.token)
    case 'del': return removeMirror(message.sessionId)
    case 'frame': return onPeerFrame(message)
    case 'reply': {
      const socket = awaiting.get(message.id)
      awaiting.delete(message.id)
      if (socket) { try { socket.end(`${JSON.stringify(message.response)}\n`) } catch {} }
      return
    }
    default: return
  }
}

// ---------------------------------------------------------------------------
// The peer's sessions, made reachable here.
// ---------------------------------------------------------------------------
async function addMirror (sessionId, peer, token) {
  const runtimeId = peer.runtimeId
  const existing = mirrored.get(sessionId)
  const signature = JSON.stringify({ runtimeId, token, endpoint: peer.endpoint })
  if (existing && existing.signature === signature) return
  if (existing) await removeMirror(sessionId)

  // The mirror keeps the peer's real runtimeId and token - the receiver
  // authenticates the sender by both - but its endpoint is rewritten to a local
  // socket this bridge answers on. The registration's own platform check is on
  // the READER (this host), so the rewritten endpoint must be this host's kind.
  const mirrorPeer = { ...peer, endpoint: endpointFor(runtimeId) }
  const file = join(DIR, `${sessionId}.json`)
  await writeFile(file, JSON.stringify({ peer: mirrorPeer, token }), { mode: 0o600 })

  const server = createServer(socket => {
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('error', () => {})
    socket.on('data', chunk => {
      buffer += chunk
      const nl = buffer.indexOf('\n')
      if (nl < 0) return
      const text = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      let frame
      try { frame = JSON.parse(text) } catch { socket.end('{"ok":false,"reason":"bridge: invalid frame"}\n'); return }
      const id = ++frameSeq
      awaiting.set(id, socket)
      setTimeout(() => {
        if (awaiting.delete(id)) { try { socket.end('{"ok":false,"state":"unknown","reason":"bridge: peer did not answer"}\n') } catch {} }
      }, DELIVER_TIMEOUT_MS).unref?.()
      send({ op: 'frame', id, target: sessionId, frame })
    })
  })
  server.on('error', error => log(`mirror listener for ${sessionId} failed: ${error.message}`))
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(mirrorPeer.endpoint, resolve)
  }).catch(error => log(`mirror ${sessionId} not listening: ${error.message}`))

  mirrored.set(sessionId, { runtimeId, server, tokenJson: token, peer, signature })
  log(`mirror + ${sessionId} (${peer.name || '?'}) -> ${mirrorPeer.endpoint}`)
}

async function removeMirror (sessionId) {
  const entry = mirrored.get(sessionId)
  if (!entry) return
  mirrored.delete(sessionId)
  try { entry.server?.close() } catch {}
  try { await unlink(join(DIR, `${sessionId}.json`)) } catch {}
  log(`mirror - ${sessionId}`)
}

// ---------------------------------------------------------------------------
// Our own sessions, advertised to the peer, and frames the peer sends us.
// ---------------------------------------------------------------------------
async function publishLocal () {
  let entries
  try { entries = await readdir(DIR) } catch { return }
  const seen = new Set()
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const sessionId = entry.slice(0, -5)
    if (!idRe.test(sessionId)) continue
    if (mirrored.has(sessionId)) continue // the peer's own session, mirrored here: never echo back
    let raw
    try { raw = JSON.parse(await readFile(join(DIR, entry), 'utf8')) } catch { continue }
    const peer = raw?.peer
    const token = raw?.token
    if (!peer?.runtimeId || typeof token !== 'string') continue
    seen.add(sessionId)
    const signature = JSON.stringify({ runtimeId: peer.runtimeId, token })
    if (published.get(sessionId) === signature) continue
    published.set(sessionId, signature)
    send({ op: 'add', sessionId, peer, token })
  }
  for (const sessionId of [...published.keys()]) {
    if (!seen.has(sessionId)) { published.delete(sessionId); send({ op: 'del', sessionId }) }
  }
}

async function onPeerFrame (message) {
  if (mirrored.has(message.target)) {
    // A target that is itself a mirror would be a loop between the two bridges.
    send({ op: 'reply', id: message.id, response: { ok: false, state: 'failed', reason: 'bridge: loop' } })
    return
  }
  const response = await deliverLocal(message.target, message.frame)
  send({ op: 'reply', id: message.id, response })
}

async function deliverLocal (sessionId, frame) {
  let raw
  try { raw = JSON.parse(await readFile(join(DIR, `${sessionId}.json`), 'utf8')) } catch {
    return { ok: false, state: 'failed', reason: `bridge: no live session ${sessionId} on this host` }
  }
  const endpoint = raw?.peer?.endpoint
  if (!endpoint) return { ok: false, state: 'failed', reason: 'bridge: target has no endpoint' }
  return new Promise(resolve => {
    const socket = createConnection(endpoint)
    let buffer = ''
    let connected = false
    let done = false
    const finish = value => { if (done) return; done = true; try { socket.destroy() } catch {}; resolve(value) }
    socket.setEncoding('utf8')
    socket.setTimeout(DELIVER_TIMEOUT_MS, () => finish({ ok: false, state: 'failed', reason: 'bridge: deliver timeout' }))
    socket.on('error', () => finish({
      ok: false, state: 'failed',
      reason: connected ? 'bridge: acknowledgement lost' : `bridge: ${sessionId} is not reachable on this host`,
    }))
    socket.on('connect', () => { connected = true; socket.write(`${JSON.stringify(frame)}\n`) })
    socket.on('data', chunk => {
      buffer += chunk
      const nl = buffer.indexOf('\n')
      if (nl < 0) return
      try { finish(JSON.parse(buffer.slice(0, nl))) } catch { finish({ ok: false, state: 'failed', reason: 'bridge: invalid reply' }) }
    })
    socket.on('end', () => { if (!done) finish({ ok: false, state: 'failed', reason: 'bridge: no reply' }) })
  })
}

// ---------------------------------------------------------------------------
// Transport wiring.
// ---------------------------------------------------------------------------
function readLines (stream) {
  let buffer = ''
  stream.setEncoding('utf8')
  stream.on('data', chunk => {
    buffer += chunk
    let nl
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      onPeerLine(line)
    }
    if (buffer.length > 8 * 1024 * 1024) buffer = ''
  })
}

function startHostTransport () {
  const remoteCmd = `$HOME/.local/bin/node ${REMOTE_SCRIPT} --remote` + (PEER_DIR ? ` --dir ${JSON.stringify(PEER_DIR)}` : '')
  const child = spawn('ssh', [
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'ExitOnForwardFailure=yes',
    PEER_HOST, remoteCmd,
  ], { stdio: ['pipe', 'pipe', 'inherit'] })
  peerWrite = line => child.stdin.write(line)
  peerUp = true
  readLines(child.stdout)
  child.on('exit', (code, signal) => {
    peerUp = false
    log(`ssh to ${PEER_HOST} exited code=${code} signal=${signal || 'none'}; retrying in 5s`)
    setTimeout(() => { if (!REMOTE) startHostTransport() }, 5000)
  })
  child.on('error', error => log(`ssh spawn failed: ${error.message}`))
}

function startRemoteTransport () {
  peerWrite = line => process.stdout.write(line)
  peerUp = true
  readLines(process.stdin)
  process.stdin.on('end', () => { process.exit(0) })
}

if (REMOTE) startRemoteTransport()
else startHostTransport()

setInterval(() => { publishLocal().catch(() => {}) }, INTERVAL_MS).unref?.()
publishLocal().catch(() => {})
log(`dir=${DIR} platform=${platform()}`)
