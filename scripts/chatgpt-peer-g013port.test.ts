/**
 * G-013 port half: the half the six-row oracle does not isolate.
 *
 * The contract makes a lock stale only when BOTH halves are gone: the recorded
 * pid is dead AND the recorded health port is silent. The six-row fixture at
 * a56f1cc (scripts/chatgpt-peer-g013lock.test.ts) never exercises the port
 * half independently - every verdict there is equally explained by the pid
 * alone, so an implementation that ignored `healthPort` entirely would pass
 * all six.
 *
 * This file is exactly that half, and it is paired with its control so the
 * refusal row cannot be satisfied by "always refuse":
 *
 *   (a) a lock naming a DEAD pid whose recorded port answers as a gateway host
 *       is refused, the message names the pid and the port, and the lock is
 *       byte-identical afterwards; then
 *   (b) the SAME lock bytes, once that port is silent, are taken over and the
 *       host serves.
 *
 * Expected: RED at base 774208f (no lock exists, so nothing refuses), GREEN at
 * ba7bee1.
 *
 * LOCK SHAPE ASSUMED: a JSON object at `<statePath>.lock` with `pid` (number),
 * `hostId` (string) and `healthPort` (number), plus a cosmetic `at`. If the
 * implementation reads different key names this fails for format rather than
 * behaviour - that divergence is the finding, not a flaky fixture.
 */
import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo, Socket } from 'node:net'
import { ChatGptHost } from './chatgpt-peer.ts'
import type { DriverChild, DriverReply } from './chatgpt-peer/driver.ts'
import { newHostState, saveJson } from './chatgpt-peer/state.ts'

const INSTANCE = 'test'

/** The frozen child protocol reduced to what `start()` touches. */
class FakeDriver {
  async call(request: Record<string, unknown>): Promise<DriverReply> {
    return { ok: true, op: String(request.op ?? '') }
  }
  onEvent(_handler: (event: Record<string, unknown>) => void): () => void { return () => {} }
  async kill(): Promise<void> {}
  reopen(): void {}
}

async function scratch(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'g013-port-'))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

const peerPath = (dir: string): string => join(dir, 'peer.json')
const lockPath = (dir: string): string => `${peerPath(dir)}.lock`

function makeHost(dir: string): ChatGptHost {
  return new ChatGptHost({
    home: dir,
    statePath: peerPath(dir),
    driverPath: join(dir, 'unused.mjs'),
    profile: join(dir, 'profile'),
    instanceId: INSTANCE,
    healthPort: 0,
    idleUnloadMinutes: 0,
    number: 1,
    pollSeconds: 0,
    titlesEvery: 0,
    turnTimeoutMs: 5_000,
    waitPollMs: 20,
    directory: join(dir, 'gateway-sessions'),
    privateHome: join(dir, 'private'),
  }, new FakeDriver() as unknown as DriverChild)
}

/** A host that has run before: peer.json with a host id, no bridges. */
async function seedHost(dir: string): Promise<void> {
  await mkdir(join(dir, 'bridges'), { recursive: true })
  await saveJson(peerPath(dir), newHostState({
    profile: join(dir, 'profile'), healthPort: 0, idleUnloadMinutes: 0, instanceId: INSTANCE,
  }))
}

/** A pid that is certainly gone: its process exited before this resolves. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
  const pid = child.pid ?? 0
  await new Promise<void>(resolve => child.once('exit', () => resolve()))
  return pid
}

/**
 * A loopback port that answers the way a gateway host does on the same route
 * the fleet uses, so the owner's probe classifies it as a host rather than an
 * unrelated listener. Sockets are tracked because the probe opens one, and a
 * keep-alive connection would make `close()` wait.
 */
async function gatewayPort(): Promise<{ server: Server; port: number; sockets: Set<Socket> }> {
  const sockets = new Set<Socket>()
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"provider":"chatgpt-web","ok":true}')
  })
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  return { server, port: (server.address() as AddressInfo).port, sockets }
}

async function closeServer(target: { server: Server; sockets: Set<Socket> }): Promise<void> {
  for (const socket of target.sockets) socket.destroy()
  if (!target.server.listening) return
  await new Promise<void>(resolve => target.server.close(() => resolve()))
}

/** Run `start()` and report how it ended, without letting the test decide yet. */
async function attempt(host: ChatGptHost): Promise<{ started: boolean; message: string }> {
  try {
    await host.start()
    return { started: true, message: '' }
  } catch (error) {
    return { started: false, message: String((error as Error)?.message ?? error) }
  }
}

/** `the host serves`: its own unauthenticated route answers 200. */
async function health(port: number): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${port}/gateway/route-health?provider=chatgpt-web`)
  return response.status
}

describe('G-013 port half: a silent port is part of what makes a lock stale', () => {
  test('a dead pid whose port still answers is refused; the same bytes, port silent, are taken over', async () => {
    const { dir, cleanup } = await scratch()
    const answerer = await gatewayPort()
    const holder = makeHost(dir)
    const taker = makeHost(dir)
    let holderStarted = false
    let takerStarted = false
    try {
      await seedHost(dir)
      const gone = await deadPid()
      const body = JSON.stringify({
        pid: gone,
        hostId: 'another-host',
        healthPort: answerer.port,
        at: new Date().toISOString(),
      })
      await writeFile(lockPath(dir), body)
      const writtenBytes = Buffer.from(body, 'utf8')

      // (a) pid gone, but the recorded address still answers: not stale.
      const refused = await attempt(holder)
      holderStarted = refused.started
      const afterRefusal = await readFile(lockPath(dir)).catch(() => null)

      // (b) the same bytes, with the answerer gone: now stale, and taken over.
      await closeServer(answerer)
      const bytesAtTakeover = await readFile(lockPath(dir)).catch(() => null)
      const takeover = await attempt(taker)
      takerStarted = takeover.started

      expect({
        refused: refused.started,
        refusalNamesPid: refused.message.includes(String(gone)),
        refusalNamesPort: refused.message.includes(String(answerer.port)),
        lockUnchangedByRefusal: afterRefusal !== null && afterRefusal.equals(writtenBytes),
        takenOver: takeover.started,
        takeoverMessage: takeover.message,
        port: taker.port > 0,
        serving: takeover.started ? await health(taker.port) : 0,
        lockUnchangedBeforeTakeover: bytesAtTakeover !== null && bytesAtTakeover.equals(writtenBytes),
      }).toEqual({
        refused: false,
        refusalNamesPid: true,
        refusalNamesPort: true,
        lockUnchangedByRefusal: true,
        takenOver: true,
        takeoverMessage: '',
        port: true,
        serving: 200,
        lockUnchangedBeforeTakeover: true,
      })
    } finally {
      if (takerStarted) await taker.stop().catch(() => {})
      if (holderStarted) await holder.stop().catch(() => {})
      await closeServer(answerer).catch(() => {})
      await cleanup()
    }
  }, 40_000)
})
