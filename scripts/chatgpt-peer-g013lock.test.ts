/**
 * G-013 second writer: one host per state file.
 *
 * A second host on the same `--state` used to refuse only after `listen` had
 * rewritten `healthPort` and `enforceThreadOwnership` had rewritten the audit
 * array from its own stale copy - it wounded the file on the way to its own
 * refusal. The claim is now taken before anything is loaded or written, so a
 * second launch writes nothing at all, and a claim whose owner is gone is
 * taken over rather than blocking forever.
 *
 * Five rows: the refusal and its no-write guarantee, the stale takeover and
 * the clean-shutdown release, two hosts on one path, the supported two-path
 * case the lock must not close, and the false-alive pair that separates a
 * recycled pid from a live owner.
 */
import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatGptHost } from './chatgpt-peer.ts'
import type { DriverChild, DriverReply } from './chatgpt-peer/driver.ts'
import { newHostState, saveJson, type BridgeState } from './chatgpt-peer/state.ts'

const INSTANCE = 'test'

/** The page is not part of this question: a driver that answers ping and idles. */
class IdleDriver {
  readonly calls: Record<string, unknown>[] = []
  private readonly listeners = new Set<(event: Record<string, unknown>) => void>()

  async call(request: Record<string, unknown>): Promise<DriverReply> {
    this.calls.push({ ...request })
    return { ok: true, op: String(request.op ?? '') }
  }

  onEvent(handler: (event: Record<string, unknown>) => void): () => void {
    this.listeners.add(handler)
    return () => { this.listeners.delete(handler) }
  }

  async kill(): Promise<void> {}
}

async function scratch(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-peer-g013lock-'))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

const sessionsDir = (dir: string): string => join(dir, 'gateway-sessions')
const privateHome = (dir: string): string => join(dir, 'private')
const profileDir = (dir: string): string => join(dir, 'profile')
const statePath = (dir: string): string => join(dir, 'peer.json')
const lockPath = (dir: string): string => join(dir, 'peer.json.lock')
const instancePath = (dir: string): string => join(privateHome(dir), 'instances', `${INSTANCE}.json`)

/** A host file with no bridges: no bus, no page, only the state file and its lock. */
async function seedHost(dir: string, bridges: BridgeState[] = []): Promise<void> {
  await mkdir(join(dir, 'bridges'), { recursive: true })
  await saveJson(statePath(dir), newHostState({
    profile: profileDir(dir), healthPort: 0, idleUnloadMinutes: 0, instanceId: INSTANCE,
  }))
  for (const bridge of bridges) await saveJson(join(dir, 'bridges', `${bridge.sessionId}.json`), bridge)
}

function hostFor(dir: string, driver: IdleDriver): ChatGptHost {
  return new ChatGptHost({
    home: dir,
    statePath: statePath(dir),
    driverPath: join(dir, 'unused.mjs'),
    profile: profileDir(dir),
    instanceId: INSTANCE,
    healthPort: 0,
    idleUnloadMinutes: 0,
    number: 1,
    pollSeconds: 0,
    titlesEvery: 0,
    turnTimeoutMs: 5_000,
    waitPollMs: 20,
    directory: sessionsDir(dir),
    privateHome: privateHome(dir),
  }, driver as unknown as DriverChild)
}

async function startHost(dir: string, driver = new IdleDriver()): Promise<ChatGptHost> {
  const host = hostFor(dir, driver)
  await host.start()
  return host
}

/** What the refusal must leave alone: the bytes, and when they were written. */
async function fingerprint(path: string): Promise<{ text: string; mtimeMs: number }> {
  return { text: await readFile(path, 'utf8'), mtimeMs: (await stat(path)).mtimeMs }
}

interface LockFile { pid: number; startedAt: string; hostId: string | null; instanceId: string; profile: string; healthPort: number }

async function writeLock(dir: string, lock: LockFile): Promise<void> {
  await writeFile(lockPath(dir), `${JSON.stringify(lock, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
}

async function readLock(dir: string): Promise<LockFile> {
  return JSON.parse(await readFile(lockPath(dir), 'utf8')) as LockFile
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true).catch(() => false)
}

async function hostHealthPort(dir: string): Promise<number> {
  return (JSON.parse(await readFile(statePath(dir), 'utf8')) as { healthPort: number }).healthPort
}

async function hostIdOf(dir: string): Promise<string> {
  return (JSON.parse(await readFile(statePath(dir), 'utf8')) as { hostId: string }).hostId
}

/** A pid that HAS been a process and is not one now: the crash-stale owner. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
  const pid = child.pid
  if (pid === undefined) throw new Error('the helper process never started')
  await once(child, 'exit')
  return pid
}

/** A loopback port with nothing on it. */
async function silentPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('the probe server has no port')
  await new Promise<void>(resolve => server.close(() => resolve()))
  return address.port
}

/** Independent of the host's own probe: does a gateway answer on this port? */
function gatewayAnswers(port: number): Promise<boolean> {
  return new Promise(resolve => {
    let reply = ''
    let settled = false
    const socket = connect({ host: '127.0.0.1', port })
    const done = (value: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(1_000, () => done(false))
    socket.on('error', () => done(false))
    socket.on('connect', () => {
      socket.write(`GET /gateway/route-health?provider=chatgpt-web HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`)
    })
    socket.on('data', chunk => { reply += chunk.toString('utf8') })
    socket.on('end', () => done(reply.startsWith('HTTP/1.1 200')))
    socket.on('close', () => done(reply.startsWith('HTTP/1.1 200')))
  })
}

const failureOf = async (work: Promise<unknown>): Promise<Error | undefined> =>
  work.then(() => undefined, (error: Error) => error)

describe('G-013: one writer per state file', () => {
  // Row 1: a live claim refuses, and the refusal writes nothing --------------
  test('1. a live claim refuses the launch and leaves peer.json and the instance file untouched', async () => {
    const { dir, cleanup } = await scratch()
    try {
      await seedHost(dir)
      const instance = instancePath(dir)
      await mkdir(join(privateHome(dir), 'instances'), { recursive: true })
      await writeFile(instance, '{"port":1234,"hostId":"seeded","sessionIds":[]}\n', 'utf8')
      const seededState = await fingerprint(statePath(dir))
      const seededInstance = await fingerprint(instance)
      await writeLock(dir, {
        pid: process.pid, startedAt: new Date().toISOString(), hostId: null,
        instanceId: INSTANCE, profile: profileDir(dir), healthPort: 0,
      })

      const host = hostFor(dir, new IdleDriver())
      const error = await failureOf(host.start())

      expect(error).toBeInstanceOf(Error)
      expect(error!.message).toContain(`another host already owns ${statePath(dir)}`)
      expect(error!.message).toContain(`pid ${process.pid}`)
      expect(error!.message).toContain('recorded port none')
      expect(await fingerprint(statePath(dir))).toEqual(seededState)
      expect(await fingerprint(instance)).toEqual(seededInstance)
      expect((await readLock(dir)).pid).toBe(process.pid)
    } finally {
      await cleanup()
    }
  }, 30_000)

  // Row 2: a crash leaves a claim, the next launch takes it over -------------
  test('2. a claim whose owner is gone is taken over, and a clean stop releases it', async () => {
    const { dir, cleanup } = await scratch()
    try {
      await seedHost(dir)
      await writeLock(dir, {
        pid: await deadPid(), startedAt: new Date().toISOString(), hostId: 'the-crashed-owner',
        instanceId: INSTANCE, profile: profileDir(dir), healthPort: await silentPort(),
      })

      const host = await startHost(dir)
      const replaced = await readLock(dir)
      expect(replaced.pid).toBe(process.pid)
      expect(replaced.hostId).toBe(await hostIdOf(dir))
      expect(replaced.healthPort).toBe(await hostHealthPort(dir))

      await host.stop()
      expect(await exists(lockPath(dir))).toBe(false)
    } finally {
      await cleanup()
    }
  }, 30_000)

  // Row 3: the ordinary accident - a second host on the same file ------------
  test('3. a second host on the same path is refused, writes nothing, and the first keeps serving', async () => {
    const { dir, cleanup } = await scratch()
    try {
      await seedHost(dir)
      const first = await startHost(dir)
      const port = await hostHealthPort(dir)
      const firstId = await hostIdOf(dir)
      const seededState = await fingerprint(statePath(dir))

      const second = hostFor(dir, new IdleDriver())
      const error = await failureOf(second.start())

      expect(error).toBeInstanceOf(Error)
      expect(error!.message).toContain('another host already owns')
      expect(error!.message).toContain(`recorded port ${port}`)
      expect(error!.message).toContain(`127.0.0.1:${port} answers as a gateway host`)
      expect(await hostHealthPort(dir)).toBe(port)
      expect(await fingerprint(statePath(dir))).toEqual(seededState)
      expect((await readLock(dir)).pid).toBe(process.pid)
      expect(await gatewayAnswers(port)).toBe(true)

      await first.stop()
      expect(await hostIdOf(dir)).toBe(firstId)
    } finally {
      await cleanup()
    }
  }, 40_000)

  // Row 4: the supported path - two hosts, two state files -------------------
  test('4. two hosts on different --state paths both start: the key is the path', async () => {
    const left = await scratch()
    const right = await scratch()
    try {
      await seedHost(left.dir)
      await seedHost(right.dir)
      const one = await startHost(left.dir)
      const two = await startHost(right.dir)
      const leftPort = await hostHealthPort(left.dir)
      const rightPort = await hostHealthPort(right.dir)

      expect((await readLock(left.dir)).pid).toBe(process.pid)
      expect((await readLock(right.dir)).pid).toBe(process.pid)
      expect(leftPort).not.toBe(rightPort)
      expect(await gatewayAnswers(leftPort)).toBe(true)
      expect(await gatewayAnswers(rightPort)).toBe(true)

      await one.stop()
      await two.stop()
      expect(await exists(lockPath(left.dir))).toBe(false)
      expect(await exists(lockPath(right.dir))).toBe(false)
    } finally {
      await left.cleanup()
      await right.cleanup()
    }
  }, 40_000)

  // Row 5: a live owner is never taken over, even when its pid is not ours ---
  test('5. a stale pid does not take over a port that still answers, and a silent port with a dead pid does', async () => {
    const answerer = await scratch()
    const target = await scratch()
    try {
      await seedHost(answerer.dir)
      await seedHost(target.dir)
      const live = await startHost(answerer.dir)
      const livePort = await hostHealthPort(answerer.dir)
      const liveId = await hostIdOf(answerer.dir)
      const dead = await deadPid()

      // (i) A live pid whose recorded port answers: refusal, and the claim is
      // left exactly as it was - a refused launch must not "repair" it.
      await writeLock(target.dir, {
        pid: process.pid, startedAt: new Date().toISOString(), hostId: liveId,
        instanceId: INSTANCE, profile: profileDir(target.dir), healthPort: livePort,
      })
      const claimed = await fingerprint(lockPath(target.dir))
      const refused = await failureOf(hostFor(target.dir, new IdleDriver()).start())
      expect(refused).toBeInstanceOf(Error)
      expect(refused!.message).toContain(`127.0.0.1:${livePort} answers as a gateway host`)
      expect(await fingerprint(lockPath(target.dir))).toEqual(claimed)

      // (ii) The same shape with the pid gone: the port still answers, so the
      // owner is not provably dead and the launch stays refused.
      await rm(lockPath(target.dir), { force: true })
      await writeLock(target.dir, {
        pid: dead, startedAt: new Date().toISOString(), hostId: liveId,
        instanceId: INSTANCE, profile: profileDir(target.dir), healthPort: livePort,
      })
      const stillAnswered = await failureOf(hostFor(target.dir, new IdleDriver()).start())
      expect(stillAnswered).toBeInstanceOf(Error)
      expect(stillAnswered!.message).toContain(`127.0.0.1:${livePort} answers as a gateway host`)
      expect((await readLock(target.dir)).pid).toBe(dead)

      // (iii) Both halves gone: takeover.
      await rm(lockPath(target.dir), { force: true })
      await writeLock(target.dir, {
        pid: dead, startedAt: new Date().toISOString(), hostId: liveId,
        instanceId: INSTANCE, profile: profileDir(target.dir), healthPort: await silentPort(),
      })
      const taken = await startHost(target.dir)
      expect((await readLock(target.dir)).pid).toBe(process.pid)
      expect(await gatewayAnswers(await hostHealthPort(target.dir))).toBe(true)

      await taken.stop()
      await live.stop()
    } finally {
      await answerer.cleanup()
      await target.cleanup()
    }
  }, 60_000)
})
