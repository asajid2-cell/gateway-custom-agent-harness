#!/usr/bin/env node
/**
 * jarvis-say.mjs - say one thing to a bus session and print its reply.
 *
 * The iMessage relay used to shell out to `hermes chat --oneshot` and read the
 * answer off stdout. Hermes is gone; the brain is now the JARVIS family on this
 * mini's gateway bus. This is the seam that replaces that shell-out: it joins
 * the local bus as a throwaway peer for the life of one exchange, sends the
 * prompt, waits for the reply, prints it, and leaves.
 *
 * It speaks the gateway transport directly and depends on nothing in the
 * harness - the same shape as gateway-bridge.mjs - so the relay does not have to
 * know how a session delivers a message.
 *
 *   node jarvis-say.mjs --to JARVIS --text "are you up" [--timeout 180]
 *   node jarvis-say.mjs --to JARVIS --text-file -    (read text from stdin)
 *
 * Exit 0 and the reply on stdout, or exit 1 with the reason on stderr.
 */
import { createServer, createConnection } from 'node:net'
import { readdir, readFile, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID, randomBytes } from 'node:crypto'
import { homedir, platform } from 'node:os'

const argv = process.argv.slice(2)
const opt = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const TO = opt('--to') ?? 'JARVIS'
const TIMEOUT_MS = Number(opt('--timeout') ?? 180) * 1000
const DIR = opt('--dir') ?? join(homedir(), '.claude', 'gateway-sessions')
const isWin = platform() === 'win32'

async function readText () {
  const file = opt('--text-file')
  if (file === '-' || (file === undefined && !opt('--text'))) {
    const chunks = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    return Buffer.concat(chunks).toString('utf8').trim()
  }
  if (file) return (await readFile(file, 'utf8')).trim()
  return String(opt('--text')).trim()
}

async function findTarget (name) {
  const entries = await readdir(DIR)
  const wanted = name.toLowerCase()
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    try {
      const raw = JSON.parse(await readFile(join(DIR, entry), 'utf8'))
      const peer = raw?.peer
      if (!peer) continue
      const sessionId = entry.slice(0, -5)
      if (sessionId.toLowerCase() === wanted) return { sessionId, peer, token: raw.token }
      if (String(peer.name || '').toLowerCase() === wanted) return { sessionId, peer, token: raw.token }
      // A session named JARVIS but whose cwd is the jarvis workspace.
      if (String(peer.cwd || '').toLowerCase().endsWith(`/${wanted}`)) return { sessionId, peer, token: raw.token }
    } catch { /* unreadable registration: skip */ }
  }
  return undefined
}

function callPeer (endpoint, request, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint)
    let buffer = ''
    let settled = false
    const done = (fn, value) => { if (settled) return; settled = true; try { socket.destroy() } catch {}; fn(value) }
    socket.setEncoding('utf8')
    socket.setTimeout(timeoutMs, () => done(reject, new Error('timed out talking to the session')))
    socket.on('error', error => done(reject, error))
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`))
    socket.on('data', chunk => {
      buffer += chunk
      const nl = buffer.indexOf('\n')
      if (nl < 0) return
      try { done(resolve, JSON.parse(buffer.slice(0, nl))) } catch { done(reject, new Error('invalid reply')) }
    })
    socket.on('end', () => done(reject, new Error('session closed without answering')))
  })
}

async function main () {
  const text = await readText()
  if (!text) { process.stderr.write('jarvis-say: no text\n'); process.exit(1) }

  const target = await findTarget(TO)
  if (!target) { process.stderr.write(`jarvis-say: no live session named ${TO}\n`); process.exit(1) }

  const sessionId = randomUUID()
  const runtimeId = randomUUID()
  const token = randomBytes(32).toString('hex')
  const endpoint = isWin ? `\\\\.\\pipe\\gateway-${runtimeId}` : join(DIR, `${runtimeId}.sock`)

  let resolveReply
  const reply = new Promise(resolve => { resolveReply = resolve })
  const server = createServer(socket => {
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('error', () => {})
    socket.on('data', chunk => {
      buffer += chunk
      const nl = buffer.indexOf('\n')
      if (nl < 0) return
      let frame
      try { frame = JSON.parse(buffer.slice(0, nl)) } catch { socket.end('{"ok":false,"reason":"invalid frame"}\n'); return }
      if (frame?.token !== token) { socket.end('{"ok":false,"reason":"unauthorized"}\n'); return }
      // The liveness probe is on the path of every listing, and therefore of the
      // target's reply-send back to this peer: the harness pings the registration
      // and drops (and sweeps) any peer that does not answer with its runtimeId.
      // Answering only `message` made this peer read as a stale registration, so
      // the reply had nowhere to land. See listGatewayPeers in
      // gatewaySessionTransport.ts.
      if (frame.type === 'ping') { socket.end(`${JSON.stringify({ ok: true, runtimeId })}\n`); return }
      if (frame.type === 'message' && frame.message) {
        socket.end(`${JSON.stringify({ ok: true, state: 'delivered', id: frame.message.id })}\n`)
        resolveReply(String(frame.message.text ?? ''))
        return
      }
      socket.end('{"ok":false,"reason":"unsupported"}\n')
    })
  })
  server.on('error', error => { process.stderr.write(`jarvis-say: ${error.message}\n`); process.exit(1) })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve) })

  await writeFile(join(DIR, `${sessionId}.json`), JSON.stringify({
    peer: {
      protocol: 1, sessionId, runtimeId, name: 'iMessage relay',
      cwd: process.cwd(), purpose: 'relay exchange', pid: process.pid,
      startedAt: new Date().toISOString(), status: 'running', endpoint,
    },
    token,
  }), { mode: 0o600 })

  const message = {
    id: randomUUID(), fromSessionId: sessionId, fromRuntimeId: runtimeId,
    toSessionId: target.sessionId, text, summary: text.slice(0, 200),
    createdAt: new Date().toISOString(),
  }

  const cleanup = async () => {
    try { server.close() } catch {}
    try { await unlink(join(DIR, `${sessionId}.json`)) } catch {}
    try { if (!isWin) await unlink(endpoint) } catch {}
  }

  let receipt
  try {
    receipt = await callPeer(target.peer.endpoint, { type: 'message', token: target.token, senderToken: token, message }, 15000)
  } catch (error) {
    await cleanup()
    process.stderr.write(`jarvis-say: could not reach ${TO}: ${error.message}\n`)
    process.exit(1)
  }
  if (receipt?.ok === false) {
    await cleanup()
    process.stderr.write(`jarvis-say: ${TO} refused: ${receipt.reason ?? 'unknown'}\n`)
    process.exit(1)
  }

  const answered = await Promise.race([
    reply,
    new Promise(resolve => setTimeout(() => resolve(undefined), TIMEOUT_MS)),
  ])
  await cleanup()
  if (answered === undefined) { process.stderr.write(`jarvis-say: ${TO} did not answer within ${TIMEOUT_MS / 1000}s\n`); process.exit(1) }
  process.stdout.write(`${answered}\n`)
}

main().catch(error => { process.stderr.write(`jarvis-say: ${error?.message || error}\n`); process.exit(1) })
