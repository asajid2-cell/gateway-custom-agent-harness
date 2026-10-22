import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { mkdirSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getClaudeConfigHomeDir } from './envUtils.js'

/**
 * The wire a leaf and any session that wants to watch it talk over.
 *
 * A leaf used to be a child process whose only channel was the IPC pipe to
 * whoever spawned it. That pipe *is* the parent's process lifetime: when the
 * parent exits the pipe closes, and the leaf has nowhere left to draw. So a leaf
 * could not outlive the session it was forked from, and closing the parent took
 * the whole family with it - which is why "close the parent and carry on in a
 * leaf" was impossible rather than merely unimplemented.
 *
 * The carrier is a named endpoint instead (a pipe on Windows, a socket
 * elsewhere), so a member's liveness is its own. A session connects, the member
 * says who it is, and the session either takes ownership of it (attach) or only
 * asks and leaves (probe). Framing is the same newline-delimited JSON the child
 * channel carried, so no message shape had to change.
 */
const MAX_FRAME = 8 * 1024 * 1024
const HANDSHAKE_TIMEOUT_MS = 10_000

export type LeafIdentity = {
  sessionId: string
  pid: number
  label?: string
  rootSessionId?: string
  state?: string
}

export type LeafChannel = {
  send: (message: unknown) => void
  close: () => void
}

export type LeafChannelHandlers = {
  onMessage?: (message: any) => void
  onClose?: () => void
}

/**
 * The member is there and somebody else is driving it.
 *
 * Distinct from "nothing answered" because the two have opposite answers - one
 * means start a member, the other means leave the live one alone - and a caller
 * that can only see "it did not work" would pick the wrong one. It is also
 * distinct from a transport fault, so a caller can name the member it knows the
 * person asked for instead of reporting the address.
 */
export class LeafTakenError extends Error {}

/**
 * Where a member listens. Keyed by session id, so a resumed member is reachable
 * at the same address it had before and nothing has to be discovered first.
 */
export function leafEndpoint(sessionId: string): string {
  // Windows pipe names are a flat namespace; a session id is already unique, so
  // nothing else is needed to keep two families apart.
  if (process.platform === 'win32') return `\\\\.\\pipe\\gateway-leaf-${sessionId}`
  return join(getClaudeConfigHomeDir(), 'leaf-families', 'run', `${sessionId}.sock`)
}

/** One newline-terminated JSON frame at a time, refusing an unbounded line. */
function frames(socket: Socket, onFrame: (message: any) => void, onBadFrame: () => void): void {
  let buffer = Buffer.alloc(0)
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk])
    if (buffer.length > MAX_FRAME) { buffer = Buffer.alloc(0); onBadFrame(); return }
    let newline: number
    while ((newline = buffer.indexOf(10)) >= 0) {
      const line = buffer.subarray(0, newline).toString('utf8')
      buffer = buffer.subarray(newline + 1)
      if (!line.trim()) continue
      try { onFrame(JSON.parse(line)) } catch { onBadFrame(); return }
    }
  })
}

function write(socket: Socket, message: unknown): void {
  if (socket.destroyed || socket.writableEnded) return
  socket.write(`${JSON.stringify(message)}\n`)
}

/**
 * Serve a member's own endpoint.
 *
 * `onAttach` fires when a session takes the member over, `onDetach` when that
 * session goes away - including by dying, which is the case that used to take
 * the member down with it. The member stays up either way; detaching only means
 * nobody is watching, so it stops drawing and waits to be picked up again.
 *
 * One session owns a member at a time. Two sessions driving one REPL would
 * interleave keystrokes into a single conversation, so a second attach is told
 * the member is taken rather than quietly sharing it.
 */
export function serveLeafChannel(options: {
  sessionId: string
  identify: () => LeafIdentity
  onMessage: (message: any) => void
  onAttach?: (channel: LeafChannel) => void
  onDetach?: () => void
}): { close: () => void } {
  const endpoint = leafEndpoint(options.sessionId)
  // A socket file outlives the process that made it, and binding to a leftover
  // one fails with EADDRINUSE. Windows pipes have no such file to clean up.
  if (process.platform !== 'win32') {
    try {
      mkdirSync(dirname(endpoint), { recursive: true, mode: 0o700 })
      unlinkSync(endpoint)
    } catch { /* Nothing was there, which is the ordinary case. */ }
  }
  const sockets = new Set<Socket>()
  let owner: Socket | undefined
  const server: Server = createServer(socket => {
    sockets.add(socket)
    socket.on('error', () => { /* A session vanishing mid-frame is a detach, not a member failure. */ })
    socket.on('close', () => {
      sockets.delete(socket)
      if (owner !== socket) return
      owner = undefined
      options.onDetach?.()
    })
    // The member names itself before anything else, so a session can tell a live
    // member of the right identity from a stale endpoint or a foreign process.
    write(socket, { type: 'leaf-identity', ...options.identify() })
    frames(socket, message => {
      if (message?.type === 'leaf-attach') {
        // Re-attaching from the socket that already owns it is a no-op rather
        // than a refusal, so a client that lost its attach reply can retry.
        if (owner === socket) return
        if (owner) { write(socket, { type: 'leaf-taken' }); socket.end(); return }
        owner = socket
        write(socket, { type: 'leaf-attached' })
        options.onAttach?.({ send: outgoing => write(socket, outgoing), close: () => socket.destroy() })
        return
      }
      // An unattached socket may only ask who the member is. A client that
      // skipped the handshake would otherwise drive a REPL it does not own.
      if (owner !== socket) return
      options.onMessage(message)
    }, () => socket.destroy())
  })
  server.on('error', () => { /* Endpoints here are per-user; a bind failure must not crash the member. */ })
  server.listen(endpoint)
  server.unref()
  return { close: () => { for (const socket of sockets) socket.destroy(); server.close() } }
}

/**
 * Ask a member whether it is there, without taking it over.
 *
 * The identity frame is written before anything else, so a live member answers
 * and a member that is gone does not: on Windows a missing pipe fails with
 * ENOENT, and elsewhere a stale socket file refuses the connection. The socket
 * is closed at the identity frame, before `leaf-attach` is ever sent, so this
 * never becomes an owner and cannot disturb a window that is already driving the
 * member - which is what makes it usable as a liveness check rather than an
 * attach.
 *
 * A timeout is `false`: the caller is asking whether a process answers, and one
 * that does not answer within the window is, for that question, not answering.
 */
export function probeLeafChannel(sessionId: string, timeoutMs = 500): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false
    const socket = createConnection(leafEndpoint(sessionId))
    const finish = (answer: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(answer)
    }
    socket.on('error', () => finish(false))
    socket.on('close', () => finish(false))
    socket.setTimeout(timeoutMs, () => finish(false))
    frames(socket, message => {
      finish(message?.type === 'leaf-identity' && message.sessionId === sessionId)
    }, () => finish(false))
  })
}

/**
 * Reach a member and take it over, if one is listening.
 *
 * Resolves undefined when nothing answers, which is the ordinary "nobody has
 * opened this member" case rather than a fault - the caller's move is to start
 * one. Throws when a member is there but already owned, because that is a
 * different situation with a different answer, and reporting both as "absent"
 * is what would put a second writer on a live session's transcript.
 */
export function connectLeafChannel(
  sessionId: string,
  handlers?: LeafChannelHandlers,
): Promise<{ channel: LeafChannel; identity: LeafIdentity } | undefined> {
  return new Promise((resolve, reject) => {
    let phase: 'identity' | 'attach' | 'owned' = 'identity'
    let done = false
    let identity: LeafIdentity | undefined
    const socket = createConnection(leafEndpoint(sessionId))
    const succeed = (value: { channel: LeafChannel; identity: LeafIdentity } | undefined) => {
      if (done) return
      done = true
      resolve(value)
    }
    const fail = (error: Error) => { if (!done) { done = true; socket.destroy(); reject(error) } }
    const handle = (message: any) => {
      if (phase === 'identity') {
        if (message?.type !== 'leaf-identity') return fail(new Error('Unexpected reply from a leaf endpoint'))
        if (message.sessionId !== sessionId) return fail(new Error('Leaf endpoint belongs to another session'))
        identity = message
        phase = 'attach'
        write(socket, { type: 'leaf-attach' })
        return
      }
      if (phase === 'attach') {
        if (message?.type === 'leaf-attached') {
          phase = 'owned'
          socket.setTimeout(0)
          return succeed({ channel: { send: outgoing => write(socket, outgoing), close: () => socket.destroy() }, identity: identity! })
        }
        if (message?.type === 'leaf-taken') return fail(new LeafTakenError('That session is already open in another window; close it there before opening it here'))
        return
      }
      handlers?.onMessage?.(message)
    }
    socket.on('error', (error: NodeJS.ErrnoException) => {
      // Past the handshake the socket is the member: it closing is the member
      // ending, whether that was asked for or not.
      if (phase === 'owned') { handlers?.onClose?.(); return }
      // A missing endpoint answers ENOENT, or ECONNREFUSED where it is a socket
      // file. Both mean "no member here", not a fault worth surfacing.
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') return succeed(undefined)
      fail(error)
    })
    socket.on('close', () => {
      if (phase === 'owned') { handlers?.onClose?.(); return }
      // Closing before identifying is not an absent member: the endpoint was
      // there and something answered it.
      fail(new Error('Leaf endpoint closed before it identified itself'))
    })
    socket.setTimeout(HANDSHAKE_TIMEOUT_MS, () => fail(new Error('Leaf did not answer; it may still be starting')))
    frames(socket, handle, () => fail(new Error('Leaf frame exceeded the limit')))
  })
}
