/**
 * Multi-bridge host: one bridged thread is one bus peer.
 *
 * No network, no browser. The page driver is a fake that answers the frozen
 * line-JSON ops in memory; every bus registration is real, in a scratch
 * directory, so the proof is the set of registration files the host writes.
 */
import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GatewaySessionTransport } from '../src/utils/gatewaySessionTransport.js'
import { ChatGptHost } from './chatgpt-peer.ts'
import type { DriverChild, DriverReply } from './chatgpt-peer/driver.ts'
import { newBridgeState, newHostState, newState, saveJson, saveState, type BridgeState } from './chatgpt-peer/state.ts'

const THREAD_A = '11111111-1111-4111-8111-111111111111'
const THREAD_B = '22222222-2222-4222-8222-222222222222'

type Call = Record<string, unknown>

/** The frozen child protocol, in memory. One page, one active thread. */
class FakeDriver {
  readonly calls: Call[] = []
  threads = [{ id: THREAD_A, title: 'Existing work' }, { id: THREAD_B, title: 'Other work' }]
  killed = false
  private accepted: ((id: string) => void) | undefined
  private current: string | null = null

  onAccepted(handler: ((id: string) => void) | undefined): void { this.accepted = handler }

  async call(request: Call): Promise<DriverReply> {
    this.calls.push({ ...request })
    const op = String(request.op ?? '')
    if (op === 'threads') return { ok: true, op, threadId: this.current, threads: this.threads }
    if (op === 'use') {
      const threadId = String(request.threadId ?? '')
      if (!threadId) return { ok: false, op, error: 'threadId required' }
      if (!this.threads.some(thread => thread.id === threadId)) {
        return { ok: false, op, error: `the page landed on no thread instead of the requested thread ${threadId}` }
      }
      this.current = threadId
      return { ok: true, op, threadId, url: `https://chatgpt.com/c/${threadId}`, adopted: true }
    }
    if (op === 'send') {
      const requested = typeof request.threadId === 'string' ? request.threadId : null
      const threadId = requested ?? (request.newChat ? randomUUID() : this.current)
      if (!threadId) return { ok: false, op, error: 'no thread is open' }
      this.current = threadId
      this.accepted?.(String(request.id ?? ''))
      return { ok: true, op, text: 'answered on the page', threadId, model: 'GPT-6', effort: 'High' }
    }
    if (op === 'unload') { this.current = null; return { ok: true, op, state: 'unloaded' } }
    if (op === 'status') return { ok: true, op, threadId: this.current, model: 'GPT-6', effort: 'High' }
    return { ok: false, op, error: `unknown op ${op}` }
  }

  async kill(): Promise<void> { this.killed = true }
  reopen(): void { this.killed = false }
}

async function scratch(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-peer-bridge-'))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

const sessionsDir = (dir: string): string => join(dir, 'sessions')
const privateHome = (dir: string): string => join(dir, 'private')
const profileDir = (dir: string): string => join(dir, 'profile')

/** A host that already has its state file, so start() does not mint a default. */
async function seedHost(dir: string, bridges: BridgeState[] = []): Promise<void> {
  await mkdir(join(dir, 'bridges'), { recursive: true })
  await saveJson(join(dir, 'peer.json'), newHostState({
    profile: profileDir(dir), healthPort: 0, idleUnloadMinutes: 0, instanceId: 'test',
  }))
  for (const bridge of bridges) await saveJson(join(dir, 'bridges', `${bridge.sessionId}.json`), bridge)
}

async function startHost(dir: string, driver: FakeDriver): Promise<ChatGptHost> {
  process.env.CLAUDE_CONFIG_DIR = join(dir, 'claude')
  const host = new ChatGptHost({
    home: dir,
    statePath: join(dir, 'peer.json'),
    driverPath: join(dir, 'unused.mjs'),
    profile: profileDir(dir),
    instanceId: 'test',
    healthPort: 0,
    idleUnloadMinutes: 0,
    number: 1,
    directory: sessionsDir(dir),
    privateHome: privateHome(dir),
  }, driver as unknown as DriverChild)
  await host.start()
  return host
}

async function credentials(dir: string): Promise<{ token: string; sessionIds: string[] }> {
  const body = JSON.parse(await readFile(join(privateHome(dir), 'instances', 'test.json'), 'utf8')) as { token: string; sessionIds?: string[] }
  return { token: body.token, sessionIds: body.sessionIds ?? [] }
}

async function operator(host: ChatGptHost, token: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const response = await fetch(`http://127.0.0.1:${host.port}/operator`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

async function operatorState(host: ChatGptHost, token: string): Promise<any> {
  const response = await fetch(`http://127.0.0.1:${host.port}/operator/state`, { headers: { authorization: `Bearer ${token}` } })
  return response.json()
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(info => info.isFile()).catch(() => false)
}

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the host')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

const bridgeNamed = (name: string, threadId: string | null): BridgeState =>
  newBridgeState({ sessionId: randomUUID(), name, threadId })

describe('multi-bridge host', () => {
  test('N bridges register N distinct session ids, each with the page route', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = bridgeNamed('alpha', THREAD_A)
    const beta = bridgeNamed('beta', THREAD_B)
    await seedHost(dir, [alpha, beta])
    const driver = new FakeDriver()
    const host = await startHost(dir, driver)
    try {
      expect(await exists(join(sessionsDir(dir), `${alpha.sessionId}.json`))).toBe(true)
      expect(await exists(join(sessionsDir(dir), `${beta.sessionId}.json`))).toBe(true)
      const first = JSON.parse(await readFile(join(sessionsDir(dir), `${alpha.sessionId}.json`), 'utf8')) as any
      const second = JSON.parse(await readFile(join(sessionsDir(dir), `${beta.sessionId}.json`), 'utf8')) as any
      expect(first.peer.sessionId).toBe(alpha.sessionId)
      expect(second.peer.sessionId).toBe(beta.sessionId)
      expect(first.peer.runtimeId).not.toBe(second.peer.runtimeId)
      expect(first.peer.route).toEqual({ provider: 'chatgpt-web', number: 1, baseUrl: `http://127.0.0.1:${host.port}` })
      const state = await operatorState(host, (await credentials(dir)).token)
      expect(state.bridges.map((bridge: any) => bridge.sessionId).sort()).toEqual([alpha.sessionId, beta.sessionId].sort())
    } finally {
      await host.stop()
      await cleanup()
    }
  })

  test('per-bridge state: changing one bridge file never touches another', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = bridgeNamed('alpha', THREAD_A)
    const beta = bridgeNamed('beta', THREAD_B)
    await seedHost(dir, [alpha, beta])
    const host = await startHost(dir, new FakeDriver())
    try {
      const { token } = await credentials(dir)
      const result = await operator(host, token, { op: 'thread', bridge: alpha.sessionId, action: 'new' })
      expect(result.status).toBe(200)
      const alphaState = JSON.parse(await readFile(join(dir, 'bridges', `${alpha.sessionId}.json`), 'utf8')) as BridgeState
      const betaState = JSON.parse(await readFile(join(dir, 'bridges', `${beta.sessionId}.json`), 'utf8')) as BridgeState
      expect(alphaState.threadId).toBeNull()
      expect(betaState.threadId).toBe(THREAD_B)
      expect(alphaState.name).toBe('alpha')
      expect(betaState.name).toBe('beta')
    } finally {
      await host.stop()
      await cleanup()
    }
  })

  test('adopt binds a thread, posts the primer into it, and returns the send line', async () => {
    const { dir, cleanup } = await scratch()
    await seedHost(dir, [])
    const driver = new FakeDriver()
    const host = await startHost(dir, driver)
    try {
      const { token, sessionIds } = await credentials(dir)
      expect(sessionIds).toEqual([])
      const result = await operator(host, token, { op: 'adopt', threadId: THREAD_A, name: 'research' })
      expect(result.status).toBe(200)
      expect(result.body.ok).toBe(true)
      expect(result.body.name).toBe('research')
      expect(result.body.threadId).toBe(THREAD_A)
      expect(result.body.line).toBe(`gateway-peers send JSON ${JSON.stringify({ toSessionId: result.body.sessionId, text: '...', summary: '...' })}`)

      // The page was asked to adopt that thread, then the primer went INTO it.
      expect(driver.calls.some(call => call.op === 'use' && call.threadId === THREAD_A)).toBe(true)
      const primer = driver.calls.find(call => call.op === 'send' && typeof call.text === 'string' && (call.text as string).includes('a peer on a local session bus'))
      expect(primer?.threadId).toBe(THREAD_A)
      expect(primer?.newChat).toBeUndefined()

      const bridge = JSON.parse(await readFile(join(dir, 'bridges', `${result.body.sessionId}.json`), 'utf8')) as BridgeState
      expect(bridge.threadId).toBe(THREAD_A)
      expect(bridge.primedThreadId).toBe(THREAD_A)
      expect(bridge.primerSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(bridge.title).toBe('Existing work')
      expect(await exists(join(sessionsDir(dir), `${result.body.sessionId}.json`))).toBe(true)
      expect((await credentials(dir)).sessionIds).toEqual([result.body.sessionId])
    } finally {
      await host.stop()
      await cleanup()
    }
  })

  test('new bridge mints a thread through newChat and binds it', async () => {
    const { dir, cleanup } = await scratch()
    await seedHost(dir, [])
    const driver = new FakeDriver()
    const host = await startHost(dir, driver)
    try {
      const { token } = await credentials(dir)
      const result = await operator(host, token, { op: 'newBridge', name: 'fresh' })
      expect(result.status).toBe(200)
      expect(result.body.name).toBe('fresh')
      expect(result.body.threadId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
      const primer = driver.calls.find(call => call.op === 'send')
      expect(primer?.newChat).toBe(true)
      const bridge = JSON.parse(await readFile(join(dir, 'bridges', `${result.body.sessionId}.json`), 'utf8')) as BridgeState
      expect(bridge.threadId).toBe(result.body.threadId)
      expect(bridge.primedThreadId).toBe(result.body.threadId)
      expect(await exists(join(sessionsDir(dir), `${result.body.sessionId}.json`))).toBe(true)
    } finally {
      await host.stop()
      await cleanup()
    }
  })

  test('a legacy peer.json becomes exactly one bridge with its session id preserved', async () => {
    const { dir, cleanup } = await scratch()
    const legacy = newState({ profile: profileDir(dir), healthPort: 0, idleUnloadMinutes: 0, instanceId: 'test' })
    legacy.threadId = THREAD_A
    legacy.primedThreadId = THREAD_A
    legacy.primerSha256 = 'a'.repeat(64)
    legacy.model = 'GPT-6'
    legacy.effort = 'High'
    await saveState(join(dir, 'peer.json'), legacy)
    const driver = new FakeDriver()
    const host = await startHost(dir, driver)
    try {
      const bridge = JSON.parse(await readFile(join(dir, 'bridges', `${legacy.sessionId}.json`), 'utf8')) as BridgeState
      expect(bridge.sessionId).toBe(legacy.sessionId)
      expect(bridge.name).toBe('chatgpt-web')
      expect(bridge.threadId).toBe(THREAD_A)
      expect(bridge.primedThreadId).toBe(THREAD_A)
      expect(bridge.model).toBe('GPT-6')
      expect(bridge.effort).toBe('High')
      // The host file was rewritten in the split shape and no longer names a thread.
      const hostFile = JSON.parse(await readFile(join(dir, 'peer.json'), 'utf8')) as Record<string, unknown>
      expect(typeof hostFile.hostId).toBe('string')
      expect(hostFile.threadId).toBeUndefined()
      expect(hostFile.sessionId).toBeUndefined()
      expect(await exists(join(sessionsDir(dir), `${legacy.sessionId}.json`))).toBe(true)
      const state = await operatorState(host, (await credentials(dir)).token)
      expect(state.bridges.length).toBe(1)
      expect(state.bridges[0].sessionId).toBe(legacy.sessionId)
      // Migration must not start a page turn of its own.
      expect(driver.calls.filter(call => call.op === 'send').length).toBe(0)
    } finally {
      await host.stop()
      await cleanup()
    }
  })

  test('removing one bridge leaves the others registered and the thread untouched', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = bridgeNamed('alpha', THREAD_A)
    const beta = bridgeNamed('beta', THREAD_B)
    await seedHost(dir, [alpha, beta])
    const host = await startHost(dir, new FakeDriver())
    try {
      const { token } = await credentials(dir)
      const result = await operator(host, token, { op: 'remove', sessionId: alpha.sessionId })
      expect(result.status).toBe(200)
      expect(result.body.ok).toBe(true)
      expect(await exists(join(sessionsDir(dir), `${alpha.sessionId}.json`))).toBe(false)
      expect(await exists(join(sessionsDir(dir), `${beta.sessionId}.json`))).toBe(true)
      expect(await exists(join(dir, 'bridges', `${alpha.sessionId}.json`))).toBe(false)
      expect(await exists(join(dir, 'bridges', `${beta.sessionId}.json`))).toBe(true)
      const state = await operatorState(host, token)
      expect(state.bridges.map((bridge: any) => bridge.sessionId)).toEqual([beta.sessionId])
    } finally {
      await host.stop()
      await cleanup()
    }
  })

  test('an inbound for bridge A never lands in bridge B', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = bridgeNamed('alpha', null)
    const beta = bridgeNamed('beta', null)
    await seedHost(dir, [alpha, beta])
    const driver = new FakeDriver()
    const host = await startHost(dir, driver)
    const sender = new GatewaySessionTransport({
      directory: sessionsDir(dir),
      sessionId: randomUUID(),
      name: 'sender',
      cwd: dir,
      purpose: 'test sender',
      policy: 'accept',
    })
    try {
      await sender.start()
      await sender.send(alpha.sessionId, 'message for A only', 'A only', undefined, 'inquiry', false)
      const { token } = await credentials(dir)
      const delivered = await waitFor(async () => {
        const state = await operatorState(host, token)
        const a = state.bridges.find((bridge: any) => bridge.sessionId === alpha.sessionId)
        const b = state.bridges.find((bridge: any) => bridge.sessionId === beta.sessionId)
        const record = a?.inbox?.[0]
        return record && record.state === 'delivered' ? { a, b } : undefined
      })
      expect(delivered.b.inbox).toEqual([])
      const inboundTurns = driver.calls.filter(call => typeof call.text === 'string' && (call.text as string).includes('INBOUND from another live session'))
      expect(inboundTurns.length).toBe(1)
      expect((inboundTurns[0]!.text as string)).toContain('message for A only')
      // Only bridge A's thread was primed: B never took a page turn.
      const primers = driver.calls.filter(call => typeof call.text === 'string' && (call.text as string).includes('a peer on a local session bus'))
      expect(primers.length).toBe(1)
    } finally {
      await sender.close().catch(() => {})
      await host.stop()
      await cleanup()
    }
  })

  test('the page stays shared: two bridges start without racing the browser', async () => {
    const { dir, cleanup } = await scratch()
    await seedHost(dir, [bridgeNamed('alpha', null), bridgeNamed('beta', null), bridgeNamed('gamma', null)])
    const driver = new FakeDriver()
    const host = await startHost(dir, driver)
    try {
      const registrations = (await readdir(sessionsDir(dir))).filter(name => name.endsWith('.json'))
      expect(registrations.length).toBe(3)
      // Startup never wakes the page.
      expect(driver.calls.length).toBe(0)
    } finally {
      await host.stop()
      await cleanup()
    }
  })
})
