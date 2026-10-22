import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GatewaySessionTransport, loopbackGatewayOrigin } from '../src/utils/gatewaySessionTransport.ts'
import { GatewaySessionDelivery } from '../src/utils/gatewaySessionDelivery.ts'

/**
 * The pre-delivery route gate, end to end.
 *
 * Every piece here is real: a real model-gateway child process, a real
 * synthetic upstream that answers key 1 with the exact live quota refusal, real
 * peer transports over their own loopback sockets, and a real account
 * preference file that the advertisement is resolved from. Nothing about the
 * probe is stubbed - if the gate is wrong, the gateway's own health bit is what
 * says so.
 */

const gatewayScript = fileURLToPath(new URL('./model-gateway.mjs', import.meta.url))
const MODEL = 'gateway-commandcode-longcat-2.0-free'

type RunningGateway = { child: ChildProcess; port: number; stderr: () => string }

async function startGateway(env: NodeJS.ProcessEnv): Promise<RunningGateway> {
  const child = spawn(process.execPath, [gatewayScript, '--port', '0'], {
    cwd: path.dirname(gatewayScript),
    windowsHide: true,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr!.setEncoding('utf8')
  child.stderr!.on('data', chunk => { stderr += chunk })
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const match = stderr.match(/model-gateway listening on http:\/\/127\.0\.0\.1:(\d+)/)
    if (match) return { child, port: Number(match[1]), stderr: () => stderr }
    if (child.exitCode !== null) throw new Error(`Gateway exited: ${stderr}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  child.kill()
  throw new Error(`Gateway did not start: ${stderr}`)
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  child.kill()
  await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 2_000))])
}

function fakeUpstream(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; port: number }> {
  const server = createServer(handler)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as any).port }))
  })
}

async function postGateway(port: number, body: unknown): Promise<{ status: number; body: string }> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.text() }
}

async function getJson(port: number, pathname: string): Promise<any> {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`)
  assert.equal(response.status, 200, `${pathname} answered ${response.status}`)
  return response.json()
}

async function selectGlobalAccount(port: number, number: number): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/gateway/commandcode-account`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'route-gate-select', number, scope: 'global' }),
  })
  assert.equal(response.status, 200, await response.text())
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return false
}

test('only a loopback gateway URL is probed; anything else is unknown', () => {
  // A registration is a file, and the sender is what fetches the URL it names.
  // Anything that is not a local Gateway is not a route this machine can ask
  // about, and calling it would turn a peer message into a request to an
  // arbitrary host.
  assert.equal(loopbackGatewayOrigin('http://127.0.0.1:4011'), 'http://127.0.0.1:4011')
  assert.equal(loopbackGatewayOrigin('http://localhost:4011/'), 'http://localhost:4011')
  for (const unsafe of [
    'https://127.0.0.1:4011',
    'http://10.0.0.5:4011',
    'http://example.com:4011',
    'file:///etc/passwd',
    'not a url',
    '',
    undefined,
  ]) {
    assert.equal(loopbackGatewayOrigin(unsafe), undefined, `${String(unsafe)} must not be probed`)
  }
})

test('a peer message is gated on the recipient route and held, not lost, when it cannot serve', { timeout: 120_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gateway-route-gate-'))
  const directory = path.join(dir, 'gateway-sessions')
  const keys = ['cc-first', 'cc-second', 'cc-third']
  const seen: string[] = []
  // Weak (lifetime-bound) self-signed upstream is not needed: the gateway is
  // pointed at this server explicitly for the CommandCode backend.
  let keyOneServes = false
  const upstream = await fakeUpstream((req, res) => {
    const authorization = String(req.headers.authorization ?? '')
    seen.push(authorization)
    if (authorization === `Bearer ${keys[2]}`) {
      // A key the provider rejects outright. A 401 is the gateway's own
      // `unauthorized` verdict, which is a different fact from exhaustion: no
      // amount of waiting makes it serve, only a new credential does.
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { type: 'authentication_error', message: 'Invalid API key' } }))
      return
    }
    if (authorization === `Bearer ${keys[0]}` && !keyOneServes) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { type: 'api_error', message: 'You have insufficient credits to make this request' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }))
  })
  let gateway: RunningGateway | undefined
  const transports: GatewaySessionTransport[] = []
  const envBefore = {
    CLAUDE_CODE_USE_GATEWAY: process.env.CLAUDE_CODE_USE_GATEWAY,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    CLAUDE_CODE_GATEWAY_BASE_URL: process.env.CLAUDE_CODE_GATEWAY_BASE_URL,
    MODEL_GATEWAY_MODEL: process.env.MODEL_GATEWAY_MODEL,
  }
  try {
    gateway = await startGateway({
      CLAUDE_CONFIG_DIR: dir,
      COMMANDCODE_API_KEY: keys[0]!,
      COMMANDCODE_API_KEY2: keys[1]!,
      COMMANDCODE_API_KEY3: keys[2]!,
      COMMANDCODE_BASE_URL: `http://127.0.0.1:${upstream.port}/provider/v1`,
    })

    // Drive the real gateway until key 1 reports the exact live refusal. This is
    // the traffic that produces the health bit the gate reads - nothing is
    // injected or reset through a test hook.
    const first = await postGateway(gateway.port, {
      model: MODEL, stream: false, max_tokens: 8,
      messages: [{ role: 'user', content: 'hello' }],
    })
    assert.equal(first.status, 200, first.body)
    assert.deepEqual(seen, [`Bearer ${keys[0]}`, `Bearer ${keys[1]}`])

    const exhausted = await getJson(gateway.port, '/gateway/route-health?provider=commandcode&number=1')
    assert.equal(exhausted.state, 'exhausted')
    assert.equal(exhausted.reason, 'http_400_insufficient_credits')
    assert.equal((await getJson(gateway.port, '/gateway/route-health?provider=commandcode&number=2')).state, 'serving')
    // Key 3 is loaded but has never answered, and 4 is not loaded at all. Both
    // are unknown: a credential that merely exists is not a credential that
    // serves, so health needs evidence and never defaults to healthy.
    assert.equal((await getJson(gateway.port, '/gateway/route-health?provider=commandcode&number=3')).state, 'unknown')
    assert.equal((await getJson(gateway.port, '/gateway/route-health?provider=commandcode&number=4')).state, 'unknown')

    // The session-side env is what a launched session has: the launcher's
    // gateway URL and the model it was started on.
    process.env.CLAUDE_CODE_USE_GATEWAY = '1'
    process.env.CLAUDE_CONFIG_DIR = dir
    process.env.CLAUDE_CODE_GATEWAY_BASE_URL = `http://127.0.0.1:${gateway.port}`
    process.env.MODEL_GATEWAY_MODEL = MODEL

    const preference = path.join(dir, 'commandcode-account.json')
    const makePeer = async (number: number, name: string): Promise<GatewaySessionTransport> => {
      await writeFile(preference, JSON.stringify({ number }))
      const transport = new GatewaySessionTransport({ directory, sessionId: randomUUID(), name, cwd: dir })
      await transport.start()
      transports.push(transport)
      return transport
    }
    const sender = new GatewaySessionTransport({ directory, sessionId: randomUUID(), name: 'route-gate-sender', cwd: dir })
    await sender.start()
    transports.push(sender)

    // (a) exhausted: the sender is refused, and the message is stored as owed.
    const blocked = await makePeer(1, 'route-gate-exhausted') as GatewaySessionTransport
    assert.deepEqual(
      { provider: blocked.peer.route?.provider, number: blocked.peer.route?.number, baseUrl: blocked.peer.route?.baseUrl },
      { provider: 'commandcode', number: 1, baseUrl: `http://127.0.0.1:${gateway.port}` },
      'the registration advertises the credential number the session would spend',
    )
    const registration = JSON.parse(await readFile(path.join(directory, `${blocked.peer.sessionId}.json`), 'utf8'))
    assert.equal(registration.peer.route.model, MODEL, 'the advertised route names the model the refusal reports')

    const refusal: any = await sender.send(
      blocked.peer.sessionId, 'Please review the parser.', 'Review the parser', undefined, 'directive', true,
    )
    assert.equal(refusal.ok, false)
    assert.equal(refusal.alive, true, 'the session is alive; its credential is what cannot serve')
    assert.equal(refusal.delivered, false)
    assert.equal(refusal.reason, 'route_unavailable')
    assert.equal(refusal.routeState, 'exhausted')
    assert.equal(refusal.state, 'held')
    assert.equal(refusal.provider, 'commandcode')
    assert.equal(refusal.number, 1)
    assert.equal(refusal.http, 400)
    assert.equal(refusal.detail, 'http_400_insufficient_credits')
    assert.equal(refusal.recipient, blocked.peer.sessionId)

    const heldInbox = blocked.inbox()
    assert.equal(heldInbox.length, 1)
    assert.equal(heldInbox[0]!.state, 'held')
    assert.deepEqual(
      blocked.outstandingReplies().map(reply => reply.toMessageId),
      [heldInbox[0]!.message.id],
      'the refused message is still counted as owed',
    )
    // A held record is not injected, so no model that cannot answer is asked.
    const deliveredToModel: string[] = []
    const delivery = new GatewaySessionDelivery(blocked, id => deliveredToModel.push(id))
    delivery.drain()
    assert.deepEqual(deliveredToModel, [])
    delivery.close()

    // (c) unknown: a credential nothing has exercised delivers, and the receipt
    // says so rather than implying health.
    const unknown = await makePeer(4, 'route-gate-unknown')
    const unverified: any = await sender.send(unknown.peer.sessionId, 'Status?', 'Status', undefined, 'inquiry', true)
    assert.equal(unverified.ok, true)
    assert.equal(unverified.alive, true)
    assert.equal(unverified.delivered, true)
    assert.equal(unverified.routeState, 'unknown')
    assert.equal(unverified.state, 'queued')
    assert.equal(unknown.inbox()[0]!.state, 'queued')

    // An older build advertises no route at all. That reads as `unknown` - never
    // healthy - and must deliver rather than shut the peer out of the bus.
    const legacyPath = path.join(directory, `${unknown.peer.sessionId}.json`)
    const legacyRegistration = JSON.parse(await readFile(legacyPath, 'utf8'))
    delete legacyRegistration.peer.route
    await writeFile(legacyPath, JSON.stringify(legacyRegistration))
    const legacy: any = await sender.send(unknown.peer.sessionId, 'No route advertised', 'No route', undefined, 'inquiry', true)
    assert.equal(legacy.ok, true)
    assert.equal(legacy.alive, true)
    assert.equal(legacy.delivered, true)
    assert.equal(legacy.routeState, 'unknown')

    // (e) unauthorized: a credential the provider rejects is withheld on the same
    // path as exhaustion, but reported as its own state - waiting changes nothing,
    // so the move is the credential, not a retry.
    await selectGlobalAccount(gateway.port, 3)
    const rejected = await postGateway(gateway.port, {
      model: MODEL, stream: false, max_tokens: 8,
      messages: [{ role: 'user', content: 'who am i' }],
    })
    assert.equal(rejected.status, 200, rejected.body)
    const rejectedHealth = await getJson(gateway.port, '/gateway/route-health?provider=commandcode&number=3')
    assert.equal(rejectedHealth.state, 'unauthorized')
    assert.equal(rejectedHealth.reason, 'http_401')

    const unauthorized = await makePeer(3, 'route-gate-unauthorized')
    assert.equal(unauthorized.peer.route?.number, 3, 'the advertisement follows the account the pool would select')
    const denied: any = await sender.send(unauthorized.peer.sessionId, 'Please review the parser.', 'Review the parser', undefined, 'directive', true)
    assert.equal(denied.ok, false)
    assert.equal(denied.alive, true, 'the recipient answered; only its credential is unusable')
    assert.equal(denied.delivered, false)
    assert.equal(denied.reason, 'route_unavailable')
    assert.equal(denied.routeState, 'unauthorized')
    assert.equal(denied.state, 'held')
    assert.equal(denied.provider, 'commandcode')
    assert.equal(denied.number, 3)
    assert.equal(denied.http, 401)
    assert.equal(denied.detail, 'http_401')
    assert.equal(denied.recipient, unauthorized.peer.sessionId)
    assert.equal(unauthorized.inbox()[0]!.state, 'held')
    assert.deepEqual(unauthorized.outstandingReplies().map(reply => reply.toMessageId), [denied.id])

    // Nor is that hold released by a status change: only `serving` releases, and a
    // rejected credential is not serving however many turns go by.
    await unauthorized.update({ status: 'idle' })
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.equal(unauthorized.inbox()[0]!.state, 'held')

    // (f) liveness is a separate axis from route health. A registration whose
    // session is gone refuses with a dead-peer verdict and no route verdict at
    // all - the credential of a session that is not there is not a fact.
    const dead = await makePeer(2, 'route-gate-dead')
    const deadPath = path.join(directory, `${dead.peer.sessionId}.json`)
    const deadRegistration = JSON.parse(await readFile(deadPath, 'utf8'))
    await dead.close()
    // Put the registration back, exactly as a session that crashed without
    // deregistering would leave it: the file says a peer, nothing is listening.
    await writeFile(deadPath, JSON.stringify(deadRegistration))
    const gone: any = await sender.send(dead.peer.sessionId, 'Are you there?', 'Are you there', undefined, 'inquiry', true)
    assert.equal(gone.ok, false)
    assert.equal(gone.alive, false)
    assert.equal(gone.state, 'failed')
    assert.equal(gone.routeState, undefined, 'a dead peer has no route verdict')
    assert.equal(gone.delivered, undefined)
    assert.match(gone.reason, /not reachable/)

    // (d) serving: the same path delivers, and the receipt carries the verdict.
    const serving = await makePeer(2, 'route-gate-serving')
    const good: any = await sender.send(serving.peer.sessionId, 'Please review the parser.', 'Review the parser', undefined, 'directive', true)
    assert.equal(good.ok, true)
    assert.equal(good.alive, true)
    assert.equal(good.delivered, true)
    assert.equal(good.routeState, 'serving')
    assert.equal(good.state, 'queued')
    assert.equal(serving.inbox()[0]!.state, 'queued')

    // (b) recovery: the credential serves again, and the held mail is released
    // by the recipient itself - the sender is not asked to re-send.
    keyOneServes = true
    await selectGlobalAccount(gateway.port, 1)
    const recovered = await postGateway(gateway.port, {
      model: MODEL, stream: false, max_tokens: 8,
      messages: [{ role: 'user', content: 'hello again' }],
    })
    assert.equal(recovered.status, 200, recovered.body)
    assert.equal((await getJson(gateway.port, '/gateway/route-health?provider=commandcode&number=1')).state, 'serving')

    await writeFile(preference, JSON.stringify({ number: 1 }))
    await blocked.update({ status: 'idle' })
    assert.ok(
      await waitFor(() => blocked.inbox()[0]?.state === 'queued'),
      'the held message is released once the route serves',
    )
    const released = blocked.inbox()[0]!
    assert.equal(released.message.id, heldInbox[0]!.message.id, 'the same message, not a new copy')
    assert.deepEqual(blocked.outstandingReplies().map(reply => reply.toMessageId), [released.message.id])

    // The released record is now ordinary queued mail: the delivery adapter
    // takes it to the model.
    const releasedToModel: string[] = []
    const resumed = new GatewaySessionDelivery(blocked, id => releasedToModel.push(id))
    resumed.drain()
    assert.deepEqual(releasedToModel, [released.message.id])
    resumed.close()
  } finally {
    for (const transport of transports) await transport.close().catch(() => {})
    if (gateway) await stopChild(gateway.child)
    upstream.server.closeAllConnections()
    await new Promise(resolve => upstream.server.close(resolve))
    await rm(dir, { recursive: true, force: true })
    for (const [key, value] of Object.entries(envBefore)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
