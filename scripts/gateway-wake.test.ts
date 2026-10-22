import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  formatGatewayPeerMessage,
  formatWakeInjection,
  formatWakeInterval,
  gatewayPeerMessageSchema,
  isGatewayWakeText,
  parseGatewayPeerText,
  peerMessageExpectsReply,
  type GatewayInboxRecord,
} from '../src/utils/gatewaySessionProtocol.ts'
import { GatewaySessionTransport, callGatewayPeer } from '../src/utils/gatewaySessionTransport.ts'

/** A real transport in a scratch config home, so the timer runs in a real process. */
async function withTransport<T>(run: (transport: GatewaySessionTransport, home: string, directory: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'gateway-wake-'))
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = home
  const directory = join(home, 'gateway-sessions')
  const transport = new GatewaySessionTransport({ directory, sessionId: randomUUID(), name: 'wake test', cwd: home })
  try {
    await transport.start()
    return await run(transport, home, directory)
  } finally {
    await transport.close()
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    await rm(home, { recursive: true, force: true })
  }
}

async function waitFor(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the timer to fire')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

function timerFile(home: string, token: string): string {
  return join(home, 'gateway-timers', `${Buffer.from(token, 'utf8').toString('hex').slice(0, 160)}.json`)
}

test('expectReply is optional, boolean, and reads as owed when absent', () => {
  const base = { id: randomUUID(), fromSessionId: randomUUID(), fromRuntimeId: randomUUID(), toSessionId: randomUUID(), summary: 'Note', text: 'Body', createdAt: new Date().toISOString() }
  const absent = gatewayPeerMessageSchema.parse(base)
  const yes = gatewayPeerMessageSchema.parse({ ...base, expectReply: true })
  const no = gatewayPeerMessageSchema.parse({ ...base, expectReply: false })
  assert.equal(absent.expectReply, undefined)
  assert.equal(peerMessageExpectsReply(absent), true)
  assert.equal(peerMessageExpectsReply(yes), true)
  assert.equal(peerMessageExpectsReply(no), false)
  // Only a boolean is a statement of intent; a string is a writer error, not a
  // second way to say no.
  assert.throws(() => gatewayPeerMessageSchema.parse({ ...base, expectReply: 'no' }))
})

test('the injected hint says whether a reply is owed, and the default keeps its wording', () => {
  const format = (expectReply?: boolean) => formatGatewayPeerMessage({
    message: { id: randomUUID(), fromSessionId: randomUUID(), summary: 'Status', text: 'The build is green.', ...(expectReply === undefined ? {} : { expectReply }), createdAt: new Date().toISOString() },
    senderName: 'Peer',
    state: 'queued',
    receivedAt: new Date().toISOString(),
  } as GatewayInboxRecord)

  const defaulted = format()
  const explicitYes = format(true)
  const no = format(false)
  for (const formatted of [defaulted, explicitYes]) {
    assert.match(formatted, /Reply expected\. To reply: gateway-peers reply with toMessageId=/)
    // The older tail opening is still read, so mixed-version traffic renders.
    assert.equal(parseGatewayPeerText(formatted)?.body, 'The build is green.')
    assert.match(parseGatewayPeerText(formatted)?.replyHint ?? '', /^Reply expected\. To reply: /)
  }
  assert.match(no, /No reply needed\. This is informational; do not send an acknowledgement\./)
  assert.doesNotMatch(no, /To reply:/)
  assert.equal(parseGatewayPeerText(no)?.body, 'The build is green.')
  assert.match(parseGatewayPeerText(no)?.replyHint ?? '', /^No reply needed\./)
})

test('outstandingReplies counts only what is owed: no expectReply:false, no replies, no answered requests', async () => {
  const { GatewaySessionTransport: Transport } = await import('../src/utils/gatewaySessionTransport.ts')
  const transport = Object.create(Transport.prototype) as any
  const received = (id: string, extra: Record<string, unknown> = {}) => ({
    message: { id, fromSessionId: 'peer-a', fromRuntimeId: 'ra', toSessionId: 'me', summary: 'Q', text: 'Body', createdAt: new Date().toISOString(), ...extra },
    senderName: 'A', state: 'delivered', receivedAt: new Date().toISOString(),
  })
  transport.records = [
    received('owed-1'),
    received('owed-2', { expectReply: true }),
    received('info-1', { expectReply: false }),
    received('reply-1', { replyTo: randomUUID() }),
  ]
  transport.history = []
  assert.deepEqual(transport.outstandingReplies().map((entry: any) => entry.toMessageId), ['owed-1', 'owed-2'])

  transport.history = [{ direction: 'sent', status: 'queued', message: { replyTo: 'owed-1' }, peerName: 'A', recordedAt: new Date().toISOString() }]
  assert.deepEqual(transport.outstandingReplies().map((entry: any) => entry.toMessageId), ['owed-2'])
})

test('a one-shot wake fires once and deletes its state file', async () => {
  await withTransport(async (transport, home, directory) => {
    const fired: { token: string; at: string }[] = []
    ;(transport as any).options.onWake = (timer: { token: string; at: string }) => fired.push(timer)
    const registration = JSON.parse(await readFile(join(directory, `${transport.peer.sessionId}.json`), 'utf8'))
    const at = new Date(Date.now() + 100).toISOString()
    const receipt = await callGatewayPeer(transport.peer.endpoint, { type: 'wake', token: 'once-1', auth: registration.token, reason: 'timer', label: 'driver', at }) as any
    assert.equal(receipt.ok, true)
    assert.equal(receipt.token, 'once-1')
    // The receiver persisted the schedule before answering, so --status can read it.
    const persisted = JSON.parse(await readFile(timerFile(home, 'once-1'), 'utf8'))
    assert.equal(persisted.sessionId, transport.peer.sessionId)
    assert.equal(persisted.at, at)

    await waitFor(() => fired.length === 1)
    await new Promise(resolve => setTimeout(resolve, 200)) // the state delete is fire-and-forget
    assert.equal(fired[0]!.token, 'once-1')
    assert.match(fired[0]!.at, /^\d{4}-\d{2}-\d{2}T/)
    await assert.rejects(readFile(timerFile(home, 'once-1'), 'utf8'), /ENOENT/)
  })
})

test('a recurring wake rewrites its state, and stop ends it', async () => {
  await withTransport(async (transport, home, directory) => {
    const fired: string[] = []
    ;(transport as any).options.onWake = (timer: { token: string }) => fired.push(timer.token)
    const registration = JSON.parse(await readFile(join(directory, `${transport.peer.sessionId}.json`), 'utf8'))
    const receipt = await callGatewayPeer(transport.peer.endpoint, { type: 'wake', token: 'every-1', auth: registration.token, reason: 'timer', intervalMs: 80, at: new Date(Date.now() + 50).toISOString() }) as any
    assert.equal(receipt.ok, true)
    assert.equal(receipt.intervalMs, 80)

    await waitFor(() => fired.length >= 2)
    const rewritten = JSON.parse(await readFile(timerFile(home, 'every-1'), 'utf8'))
    assert.ok(rewritten.fires >= 1)
    assert.equal(rewritten.intervalMs, 80)

    const stopped = await callGatewayPeer(transport.peer.endpoint, { type: 'wake', token: 'every-1', auth: registration.token, reason: 'timer', stop: true }) as any
    assert.equal(stopped.ok, true)
    assert.equal(stopped.stopped, true)
    await assert.rejects(readFile(timerFile(home, 'every-1'), 'utf8'), /ENOENT/)
    const count = fired.length
    await new Promise(resolve => setTimeout(resolve, 250))
    assert.equal(fired.length, count)
  })
})

test('a re-set with the same token replaces rather than duplicates', async () => {
  await withTransport(async (transport, home, directory) => {
    const fired: string[] = []
    ;(transport as any).options.onWake = (timer: { token: string }) => fired.push(timer.token)
    const registration = JSON.parse(await readFile(join(directory, `${transport.peer.sessionId}.json`), 'utf8'))
    const request = (at: number) => callGatewayPeer(transport.peer.endpoint, { type: 'wake', token: 'reset-1', auth: registration.token, reason: 'timer', at: new Date(at).toISOString() })
    await request(Date.now() + 60_000)
    await request(Date.now() + 60)
    await waitFor(() => fired.length === 1)
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.deepEqual(fired, ['reset-1'])
  })
})

test('a wake with the wrong receiver token is refused and schedules nothing', async () => {
  await withTransport(async (transport, home) => {
    const receipt = await callGatewayPeer(transport.peer.endpoint, { type: 'wake', token: 'bad-1', auth: 'not-the-token', reason: 'timer', at: new Date(Date.now() + 1000).toISOString() }) as any
    assert.equal(receipt.ok, false)
    assert.match(receipt.reason, /unauthorized/i)
    await assert.rejects(readFile(timerFile(home, 'bad-1'), 'utf8'), /ENOENT/)
  })
})

test('the injected line carries the label, cadence, and time, and is recognisable as a wake', () => {
  const line = formatWakeInjection({ token: 'label:driver', label: 'driver', intervalMs: 20 * 60_000, at: '2026-10-22T10:00:00.000Z' })
  assert.equal(line, '[heartbeat] The timer you set (label=driver, every 20m) passed at 2026-10-22T10:00:00.000Z. Reassess: read your leaves, check in-flight work, message whoever is stuck.')
  assert.equal(isGatewayWakeText(line), true)
  assert.equal(isGatewayWakeText('ordinary prompt'), false)
  assert.equal(formatWakeInterval(90_000), '90s')
  const once = formatWakeInjection({ token: 'timer:abc', intervalMs: undefined, at: '2026-10-22T10:00:00.000Z' })
  assert.match(once, /label=timer:abc, once\)/)
})
