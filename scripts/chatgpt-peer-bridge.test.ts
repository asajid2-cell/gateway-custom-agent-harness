/**
 * Multi-bridge host: one bridged thread is one bus peer.
 *
 * No network, no browser. The page driver is a fake that answers the frozen
 * line-JSON ops in memory; every bus registration is real, in a scratch
 * directory, so the proof is the set of registration files the host writes.
 */
import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
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
  /** What the newest assistant turn holds - what `read` returns. */
  answer = 'answered on the page'
  /** What `send` returns at post time; may differ from what the page settles on. */
  sendText = 'answered on the page'
  sendTextFor: ((request: Call) => string) | undefined
  evidence = 'state-complete'
  readError: string | null = null
  readCalls = 0
  /** Derive the settled answer from the prompt that was just sent. */
  answerFor: ((request: Call) => string | undefined) | undefined
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
      this.answer = this.answerFor?.(request) ?? this.answer
      this.accepted?.(String(request.id ?? ''))
      return { ok: true, op, text: this.sendTextFor?.(request) ?? this.sendText, threadId, model: 'GPT-6', effort: 'High' }
    }
    if (op === 'read') {
      this.readCalls++
      if (this.readError) return { ok: false, op, error: this.readError }
      return { ok: true, op, threadId: this.current, text: this.answer, evidence: this.evidence }
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

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

/**
 * What the page returns for a block: the label line, then the object. ChatGPT
 * renders a fence as a widget and keeps only the label word, so this - not
 * markdown - is the text `read` hands back.
 */
const rendered = (fields: Record<string, unknown>): string => 'gateway\n' + JSON.stringify(fields)

async function readBridge(dir: string, sessionId: string): Promise<BridgeState> {
  return JSON.parse(await readFile(join(dir, 'bridges', `${sessionId}.json`), 'utf8')) as BridgeState
}

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

  // ------------------------------------------------------------- increment 2

  test('a bridge file written before the join token existed still loads', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = bridgeNamed('alpha', THREAD_A)
    // Exactly the increment-1 shape: no bootstrap fields at all.
    await seedHost(dir, [{
      sessionId: alpha.sessionId,
      name: 'alpha',
      threadId: THREAD_A,
      primedThreadId: THREAD_A,
      primerSha256: 'a'.repeat(64),
      owed: [],
      schedules: [],
      model: 'GPT-6',
      effort: 'High',
      createdAt: alpha.createdAt,
    } as unknown as BridgeState])
    const host = await startHost(dir, new FakeDriver())
    try {
      expect(await exists(join(sessionsDir(dir), `${alpha.sessionId}.json`))).toBe(true)
      const { token } = await credentials(dir)
      const state = await operatorState(host, token)
      expect(state.bridges.length).toBe(1)
      expect(state.bridges[0].sessionId).toBe(alpha.sessionId)
      // The old file is readable, and the next write normalises it: the three
      // token fields exist as null rather than being rejected as unknown.
      const snippet = await operator(host, token, { op: 'snippet', bridge: alpha.sessionId })
      expect(snippet.status).toBe(200)
      const normalized = await readBridge(dir, alpha.sessionId)
      expect(normalized.bootstrapBurnedAt).toBeNull()
      expect(normalized.lastArmedSha256).toBeNull()
      expect(normalized.bootstrapSha256).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      await host.stop()
      await cleanup()
    }
  })

  test('snippet reveals a one-shot token once and stores only its sha', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = bridgeNamed('alpha', THREAD_A)
    await seedHost(dir, [alpha])
    const host = await startHost(dir, new FakeDriver())
    try {
      const { token } = await credentials(dir)
      const first = await operator(host, token, { op: 'snippet', bridge: alpha.sessionId })
      expect(first.status).toBe(200)
      const text = String(first.body.text)
      const minted = /^gateway\n\{"nonce":"([0-9a-f]{48})"/m.exec(text)?.[1]
      expect(minted).toBeDefined()
      expect(text).toContain('bound to the peer "alpha"')
      expect(text).toContain(alpha.sessionId)
      expect(text).toContain('"op":"send","to":"alpha"')
      // The token is in the body: the page destroys everything on the label line.
      expect(text).toContain(`{"nonce":"${minted}","op":"send"`)
      // The op table is the primer's own, not a second invention.
      expect(text).toContain('{"op":"list"}')
      expect(text).toContain('{"op":"read","peer"')
      expect(text).toContain('ONE-SHOT')

      const stored = await readBridge(dir, alpha.sessionId)
      expect(stored.bootstrapSha256).toBe(sha256(minted!))
      expect(stored.bootstrapBurnedAt).toBeNull()
      // The sha is the only form on disk, and it is never echoed to the page.
      expect(text).not.toContain(stored.bootstrapSha256!)

      const second = await operator(host, token, { op: 'snippet', bridge: alpha.sessionId })
      const mintedAgain = /^gateway\n\{"nonce":"([0-9a-f]{48})"/m.exec(String(second.body.text))?.[1]
      expect(mintedAgain).toBeDefined()
      expect(mintedAgain).not.toBe(minted)
      const replaced = await readBridge(dir, alpha.sessionId)
      expect(replaced.bootstrapSha256).toBe(sha256(mintedAgain!))
      expect(replaced.bootstrapBurnedAt).toBeNull()
    } finally {
      await host.stop()
      await cleanup()
    }
  })

  test('arm burns the bootstrap token before it runs the command', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = bridgeNamed('alpha', THREAD_A)
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    const host = await startHost(dir, driver)
    try {
      const { token } = await credentials(dir)
      const snippet = await operator(host, token, { op: 'snippet', bridge: alpha.sessionId })
      const minted = /^gateway\n\{"nonce":"([0-9a-f]{48})"/m.exec(String(snippet.body.text))![1]
      driver.answer = [
        'Arming.',
        '',
        rendered({ nonce: minted, op: 'schedule', label: 'armed-once', inSeconds: 600 }),
      ].join('\n')

      const armed = await operator(host, token, { op: 'arm', bridge: alpha.sessionId })
      expect(armed.status).toBe(200)
      expect(armed.body.ok).toBe(true)
      expect(armed.body.evidence).toBe('state-complete')
      // The tab was taken deliberately and the page read once.
      expect(driver.calls.some(call => call.op === 'use' && call.threadId === THREAD_A)).toBe(true)
      expect(driver.readCalls).toBe(1)

      const after = await readBridge(dir, alpha.sessionId)
      expect(after.bootstrapBurnedAt).not.toBeNull()
      expect(after.schedules.map(schedule => schedule.label)).toContain('armed-once')

      // The same answer cannot be armed twice through a dead token.
      const again = await operator(host, token, { op: 'arm', bridge: alpha.sessionId })
      expect(again.body.ok).toBe(false)
      expect(again.body.line).toContain('one-shot')
    } finally {
      await host.stop()
      await cleanup()
    }
  })

  test('a bare gateway fence is armed once per answer text', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = bridgeNamed('alpha', THREAD_A)
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    const host = await startHost(dir, driver)
    try {
      const { token } = await credentials(dir)
      driver.evidence = 'stability'
      driver.answer = rendered({ op: 'schedule', label: 'bare-one', inSeconds: 600 })

      const first = await operator(host, token, { op: 'arm', bridge: alpha.sessionId })
      expect(first.body.ok).toBe(true)
      expect(first.body.evidence).toBe('stability')
      const stored = await readBridge(dir, alpha.sessionId)
      expect(stored.lastArmedSha256).toBe(sha256(driver.answer))
      expect(stored.schedules.map(schedule => schedule.label)).toContain('bare-one')

      const second = await operator(host, token, { op: 'arm', bridge: alpha.sessionId })
      expect(second.body.ok).toBe(false)
      expect(second.body.line).toContain('already armed')

      // A newer answer is a new trust decision, so the same click works again.
      driver.answer = rendered({ op: 'schedule', label: 'bare-two', inSeconds: 600 })
      const third = await operator(host, token, { op: 'arm', bridge: alpha.sessionId })
      expect(third.body.ok).toBe(true)
      expect((await readBridge(dir, alpha.sessionId)).schedules.map(schedule => schedule.label)).toContain('bare-two')
    } finally {
      await host.stop()
      await cleanup()
    }
  })

  test('arm refuses with the literal line for every condition', async () => {
    const { dir, cleanup } = await scratch()
    const unbound = bridgeNamed('unbound', null)
    const alpha = bridgeNamed('alpha', THREAD_A)
    await seedHost(dir, [unbound, alpha])
    const driver = new FakeDriver()
    const host = await startHost(dir, driver)
    try {
      const { token } = await credentials(dir)

      const noThread = await operator(host, token, { op: 'arm', bridge: unbound.sessionId })
      expect(noThread.body.ok).toBe(false)
      expect(noThread.body.line).toBe('no thread yet: this bridge is not bound to a ChatGPT thread; adopt a thread or create a bridge first')

      driver.answer = 'Just prose, no fence anywhere.'
      const noFence = await operator(host, token, { op: 'arm', bridge: alpha.sessionId })
      expect(noFence.body.ok).toBe(false)
      expect(noFence.body.line).toBe('nothing to arm: the newest assistant answer contains no gateway command block')

      driver.readError = 'the newest assistant turn is still in progress'
      const writing = await operator(host, token, { op: 'arm', bridge: alpha.sessionId })
      expect(writing.body.line).toBe('the answer is still being written; wait for it to finish, then click "Arm last answer" again')

      driver.readError = 'no assistant turn is on the page'
      const empty = await operator(host, token, { op: 'arm', bridge: alpha.sessionId })
      expect(empty.body.line).toBe('nothing to arm: the page holds no finished assistant answer')

      driver.readError = 'no thread is open'
      const closed = await operator(host, token, { op: 'arm', bridge: alpha.sessionId })
      expect(closed.body.line).toBe('nothing to arm: the page holds no finished assistant answer')

      // A page that cannot prove the turn finished is not armable either.
      driver.readError = null
      driver.evidence = 'provisional'
      driver.answer = rendered({ op: 'list' })
      const unproven = await operator(host, token, { op: 'arm', bridge: alpha.sessionId })
      expect(unproven.body.line).toContain('could not confirm the answer finished')
    } finally {
      await host.stop()
      await cleanup()
    }
  })

  test('an inbound turn extracts commands from the page read, never the send text', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = bridgeNamed('alpha', null)
    await seedHost(dir, [alpha])
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
      let emitted = false
      driver.sendText = 'Working on it.' // the post-time text carries no command
      driver.answerFor = request => {
        const nonce = /"nonce":"([0-9a-f]{8})"/.exec(String(request.text ?? ''))?.[1]
        if (!nonce) return 'Understood.' // the primer
        if (emitted) return 'Done.'
        emitted = true
        return `Working on it.\n\n${rendered({ nonce, op: 'schedule', label: 'from-read', inSeconds: 600 })}`
      }
      await sender.send(alpha.sessionId, 'please run your command', 'run your command', undefined, 'inquiry', false)
      const { token } = await credentials(dir)
      const armed = await waitFor(async () => {
        const state = await operatorState(host, token)
        const bridge = state.bridges.find((item: any) => item.sessionId === alpha.sessionId)
        return bridge?.schedules?.some((schedule: any) => schedule.label === 'from-read') ? bridge : undefined
      })
      expect(armed.schedules.map((schedule: any) => schedule.label)).toContain('from-read')
      expect(driver.readCalls).toBeGreaterThanOrEqual(1)
      expect(driver.sendText).not.toContain('from-read')
    } finally {
      await sender.close().catch(() => {})
      await host.stop()
      await cleanup()
    }
  })

  test('a failed read falls back to the send text and is logged', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = bridgeNamed('alpha', null)
    await seedHost(dir, [alpha])
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
      let emitted = false
      driver.readError = 'the newest assistant turn is still in progress'
      driver.sendTextFor = request => {
        const nonce = /"nonce":"([0-9a-f]{8})"/.exec(String(request.text ?? ''))?.[1]
        if (!nonce || emitted) return 'Working on it.'
        emitted = true
        return `Working on it.\n\n${rendered({ nonce, op: 'schedule', label: 'from-send', inSeconds: 600 })}`
      }
      await sender.send(alpha.sessionId, 'please run your command', 'run your command', undefined, 'inquiry', false)
      const { token } = await credentials(dir)
      const armed = await waitFor(async () => {
        const state = await operatorState(host, token)
        const bridge = state.bridges.find((item: any) => item.sessionId === alpha.sessionId)
        return bridge?.schedules?.some((schedule: any) => schedule.label === 'from-send') ? bridge : undefined
      })
      expect(armed.schedules.map((schedule: any) => schedule.label)).toContain('from-send')
      expect(driver.readCalls).toBeGreaterThanOrEqual(1)
    } finally {
      await sender.close().catch(() => {})
      await host.stop()
      await cleanup()
    }
  })
})
