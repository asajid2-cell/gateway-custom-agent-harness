import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { createConnection } from 'node:net'
import { mkdtemp, rm, mkdir, rename, readFile, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setCommandLifecycleListener, subscribeCommandLifecycle, notifyCommandLifecycle } from '../src/utils/commandLifecycle.ts'
import { GatewaySessionTransport, callGatewayPeer, listGatewayPeers } from '../src/utils/gatewaySessionTransport.ts'

test('a ping is answered without waiting for the transport chain', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-peer-ping-'))
  const directory = join(root, 'private')
  const peer = new GatewaySessionTransport({ directory, sessionId: randomUUID(), name: 'Probed peer', cwd: root })
  // Every listing probes every registration, so the ping is on the path of
  // every send and every panel refresh. It used to be served from inside the
  // transport's serial chain, so a peer that was mid-request answered late or
  // not at all - and a listing that gets no answer drops the peer and then
  // reports it as exited. The probe reads no mutable state, so it must not
  // queue behind work that does.
  const order: string[] = []
  const exchange = (tag: string, request: unknown) => new Promise<void>((resolve, reject) => {
    const socket = createConnection(peer.peer.endpoint)
    let buffer = Buffer.alloc(0)
    socket.setTimeout(15000, () => { socket.destroy(); reject(new Error(`${tag} timed out`)) })
    socket.on('error', reject)
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`))
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.indexOf(10) < 0) return
      socket.destroy()
      order.push(tag)
      resolve()
    })
  })
  try {
    await peer.start()
    const token = peer.hookEnvironment().GATEWAY_PEER_TOKEN!
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const blocked = (peer as any).serial(async () => { entered(); await gate })
    await started
    const blocker = exchange('message', {
      type: 'message', token, senderToken: token,
      message: {
        id: randomUUID(), fromSessionId: randomUUID(), fromRuntimeId: randomUUID(),
        toSessionId: peer.peer.sessionId, text: 'busy', summary: 'busy', createdAt: new Date().toISOString(),
      },
    })
    try {
      await exchange('ping', { type: 'ping', token })
      assert.deepEqual(order, ['ping'], 'ping completes while the mutation chain is blocked')
    } finally {
      release()
    }
    await Promise.all([blocked, blocker])
    assert.deepEqual(order, ['ping', 'message'], 'the probe is answered before the request that holds the chain')
  } finally {
    await peer.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('a rejected request names the fault instead of one blanket reason', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-peer-reason-'))
  const directory = join(root, 'private')
  const a = new GatewaySessionTransport({ directory, sessionId: randomUUID(), name: 'Sender', cwd: root })
  const b = new GatewaySessionTransport({ directory, sessionId: randomUUID(), name: 'Receiver', cwd: root })
  try {
    await a.start()
    await b.start()
    const token = b.hookEnvironment().GATEWAY_PEER_TOKEN!
    // The sender is registered, so this is not an unattributable caller: the
    // receiver can name it and still refuses it, because the token in the
    // request is not the one its registration carries. That is a sender that has
    // been re-registered under a stale copy of itself - the one rejection the
    // sender can act on - and it used to arrive as the same blanket string as a
    // malformed request or a wrong token, so the sender retried it unchanged.
    const response = await callGatewayPeer(b.peer.endpoint, {
      type: 'message', token, senderToken: 'c'.repeat(64),
      message: {
        id: randomUUID(), fromSessionId: a.peer.sessionId, fromRuntimeId: a.peer.runtimeId,
        toSessionId: b.peer.sessionId, text: 'stale', summary: 'stale', createdAt: new Date().toISOString(),
      },
    }) as { ok?: boolean; reason?: string }
    assert.equal(response.ok, false)
    assert.match(String(response.reason), /Invalid sender/)
    assert.doesNotMatch(String(response.reason), /Invalid or unauthorized peer request/)
    // A session addressing itself is told that, rather than being handed the
    // receiver's refusal of a request it cannot attribute.
    await assert.rejects(a.send(a.peer.sessionId, 'self note', 'self note'), /cannot send a message to itself/)
  } finally {
    await a.close()
    await b.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('closed transport cannot recreate registration or mutate inbox', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-peer-closed-'))
  const directory = join(root, 'private')
  const peer = new GatewaySessionTransport({ directory, sessionId: randomUUID(), name: 'Closing peer', cwd: root })
  try {
    await peer.start()
    await peer.close()
    await assert.rejects(peer.update({ name: 'Resurrected' }), /closed|closing/)
    await assert.rejects(peer.setPolicy('accept'), /closed|closing/)
    await assert.rejects(readFile(join(directory, `${peer.peer.sessionId}.json`)), { code: 'ENOENT' })
  } finally { await peer.close(); await rm(root, { recursive: true, force: true }) }
})

test('concurrent start and close cannot leave a listening registration', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-peer-start-close-'))
  const directory = join(root, 'private')
  const peer = new GatewaySessionTransport({ directory, sessionId: randomUUID(), name: 'Race peer', cwd: root })
  try {
    const first = peer.start()
    assert.equal(peer.start(), first)
    await Promise.all([first, peer.close()])
    await assert.rejects(peer.start(), /closed|closing/)
    assert.deepEqual(await listGatewayPeers(directory), [])
    await assert.rejects(readFile(join(directory, `${peer.peer.sessionId}.json`)), { code: 'ENOENT' })
  } finally { await peer.close(); await rm(root, { recursive: true, force: true }) }
})

test('valid escaped payloads fit transport and receipts track persistence', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-peer-integrity-'))
  const directory = join(root, 'private')
  const a = new GatewaySessionTransport({ directory, sessionId: randomUUID(), name: 'Sender', cwd: root })
  const b = new GatewaySessionTransport({ directory, sessionId: randomUUID(), name: 'Receiver', cwd: root })
  try {
    await a.start()
    await b.start()
    const payload = '\\"\n\t'.repeat(15000)
    assert.ok(Buffer.byteLength(payload) <= 64 * 1024)
    const receipt = await a.send(b.peer.sessionId, payload, 'Escaped payload') as any
    assert.equal(receipt.state, 'queued')
    assert.equal(b.inbox()[0]!.message.text, payload)
    await b.acknowledge(receipt.id)
    assert.equal(b.historyEntries().find(entry => entry.message.id === receipt.id)?.status, 'delivered')
    assert.equal((await a.receipt(b.peer.sessionId, receipt.id) as any).state, 'delivered')
    assert.equal(a.historyEntries().find(entry => entry.message.id === receipt.id)?.status, 'delivered')
    assert.equal((await a.receipt(b.peer.sessionId, randomUUID()) as any).state, 'unknown')
  } finally {
    await a.close()
    await b.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('lost acknowledgement is unknown, recoverable by ID, and never reported as definite failure', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-peer-timeout-'))
  const directory = join(root, 'private')
  const a = new GatewaySessionTransport({ directory, sessionId: randomUUID(), name: 'Sender', cwd: root })
  const b = new GatewaySessionTransport({ directory, sessionId: randomUUID(), name: 'Receiver', cwd: root })
  try {
    await a.start()
    await b.start()
    const original = (b as any).handle.bind(b)
    ;(b as any).handle = async (request: any) => {
      const response = await original(request)
      if (request.type === 'message') await new Promise(resolve => setTimeout(resolve, 16000))
      return response
    }
    const sent = await a.send(b.peer.sessionId, 'Exactly one request', 'Lost acknowledgement') as any
    assert.equal(sent.state, 'unknown')
    assert.ok(sent.id)
    assert.equal(b.inbox().length, 1)
    assert.equal(a.historyEntries()[0]!.status, 'unknown')
    assert.equal((await a.receipt(b.peer.sessionId, sent.id) as any).state, 'queued')
    assert.equal(a.historyEntries()[0]!.status, 'queued')
    assert.equal(b.inbox().length, 1)
  } finally {
    await a.close()
    await b.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('sender history failure after acceptance preserves the authoritative receipt', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-peer-sender-disk-'))
  const directory = join(root, 'private')
  const a = new GatewaySessionTransport({ directory, sessionId: randomUUID(), name: 'Sender', cwd: root })
  const b = new GatewaySessionTransport({ directory, sessionId: randomUUID(), name: 'Receiver', cwd: root })
  try {
    await a.start()
    await b.start()
    const persist = (a as any).persist.bind(a)
    let writes = 0
    ;(a as any).persist = async (...args: any[]) => {
      if (++writes === 2) throw new Error('Fixture disk failure')
      return persist(...args)
    }
    const sent = await a.send(b.peer.sessionId, 'Accepted despite sender disk failure', 'Disk failure') as any
    assert.equal(sent.ok, true)
    assert.equal(sent.state, 'queued')
    assert.equal(sent.historySaved, false)
    assert.equal(b.inbox()[0]!.message.id, sent.id)
    assert.equal((await a.receipt(b.peer.sessionId, sent.id) as any).state, 'queued')
  } finally {
    await a.close()
    await b.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('stress concurrent senders, backpressure, restart, and duplicate delivery', { timeout: 180000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-peer-stress-'))
  const directory = join(root, 'private')
  const receiverId = randomUUID()
  let receiver = new GatewaySessionTransport({ directory, sessionId: receiverId, name: 'Stress receiver', cwd: root, policy: 'hold' })
  const senders = Array.from({ length: 6 }, (_, i) => new GatewaySessionTransport({ directory, sessionId: randomUUID(), name: `Sender ${i}`, cwd: root }))
  try {
    await receiver.start()
    for (const sender of senders) await sender.start()
    const started = performance.now()
    const attempts = await Promise.all(senders.flatMap((sender, index) => Array.from({ length: 10 }, async (_, sequence) => {
      const payload = `sender=${index};sequence=${sequence}\n${'café 世界 \\"\\n'.repeat(256)}`
      const receipt = await sender.send(receiverId, payload, `Burst ${index}/${sequence}`) as any
      return { sender, payload, receipt }
    })))
    // A ping is serialized behind prior incoming operations, so it is a drain barrier.
    const registration = JSON.parse(await readFile(join(directory, `${receiverId}.json`), 'utf8'))
    await callGatewayPeer(receiver.peer.endpoint, { type: 'ping', token: registration.token })
    const records = receiver.inbox()
    assert.equal(records.length, 50, 'Queue bound must hold under concurrent senders')
    assert.equal(new Set(records.map(record => record.message.id)).size, 50)
    for (const record of records) assert.equal(record.message.text, attempts.find(attempt => attempt.receipt.id === record.message.id)?.payload)
    const unknown = attempts.filter(attempt => attempt.receipt.state === 'unknown').length
    const refused = attempts.filter(attempt => attempt.receipt.ok === false && attempt.receipt.state !== 'unknown').length
    console.log(JSON.stringify({ stress: 'concurrent-burst', attempted: 60, accepted: records.length, unknown, refused, durationMs: Math.round(performance.now() - started) }))
    assert.equal(unknown, 0, 'Normal bounded bursts must not lose acknowledgements')
    assert.equal(refused, 10)
    await receiver.close()
    receiver = new GatewaySessionTransport({ directory, sessionId: receiverId, name: 'Restarted receiver', cwd: root })
    await receiver.start()
    assert.deepEqual(receiver.inbox().map(record => record.message.id), records.map(record => record.message.id))
    await receiver.setPolicy('accept')
    for (const record of records) await receiver.acknowledge(record.message.id)
    assert.ok(receiver.inbox().every(record => record.state === 'delivered'))
    const record = records[0]!
    const sender = senders.find(sender => sender.peer.sessionId === record.message.fromSessionId)!
    const senderRegistration = JSON.parse(await readFile(join(directory, `${sender.peer.sessionId}.json`), 'utf8'))
    const target = JSON.parse(await readFile(join(directory, `${receiverId}.json`), 'utf8'))
    const replay = await callGatewayPeer(receiver.peer.endpoint, { type: 'message', token: target.token, senderToken: senderRegistration.token, message: record.message }) as any
    assert.equal(replay.state, 'delivered')
    assert.equal(receiver.inbox().length, 50)
    console.log(JSON.stringify({ stress: 'restart-and-replay', preserved: 50, delivered: 50, duplicateInboxRecords: 0 }))
  } finally {
    await receiver.close()
    for (const sender of senders) await sender.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('stress maximum escaped payloads remain readable after restart', { timeout: 180000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-peer-max-stress-'))
  const directory = join(root, 'private')
  const receiverId = randomUUID()
  let receiver = new GatewaySessionTransport({ directory, sessionId: receiverId, name: 'Receiver', cwd: root, policy: 'hold' })
  const senders: GatewaySessionTransport[] = []
  try {
    await receiver.start()
    const payload = '\u0000'.repeat(65536)
    for (let round = 0; round < 5; round++) {
      const sender = new GatewaySessionTransport({ directory, sessionId: randomUUID(), name: `Sender ${round}`, cwd: root })
      senders.push(sender)
      await sender.start()
      for (let index = 0; index < 10; index++) {
        const sent = await sender.send(receiverId, payload, `Maximum ${round}/${index}`) as any
        assert.equal(sent.state, 'held')
      }
      await sender.close()
    }
    const before = receiver.inbox().map(record => record.message.id)
    await receiver.close()
    receiver = new GatewaySessionTransport({ directory, sessionId: receiverId, name: 'Receiver resumed', cwd: root })
    await receiver.start()
    assert.deepEqual(receiver.inbox().map(record => record.message.id), before)
    assert.ok(receiver.inbox().every(record => record.message.text === payload))
    assert.equal(receiver.inbox().length, 50)
    console.log(JSON.stringify({ stress: 'maximum-escaped-inbox', messages: 50, decodedBytesPerMessage: 65536, encodedInboxBytes: Buffer.byteLength(await readFile(join(directory, `${receiverId}.inbox`), 'utf8')), restartExact: true }))
  } finally {
    await receiver.close()
    for (const sender of senders) await sender.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('receipt observers coexist with the bridge lifecycle listener and unsubscribe', () => {
  const events: string[] = []
  setCommandLifecycleListener((id, state) => events.push(`bridge:${id}:${state}`))
  const unsubscribe = subscribeCommandLifecycle((id, state) => events.push(`receipt:${id}:${state}`))
  try {
    notifyCommandLifecycle('one', 'started')
    unsubscribe()
    notifyCommandLifecycle('two', 'completed')
    assert.deepEqual(events, ['bridge:one:started', 'receipt:one:started', 'bridge:two:completed'])
  } finally {
    unsubscribe()
    setCommandLifecycleListener(null)
  }
})

test('reciprocal idle subscriptions deliver before both updates complete without blocking inboxes', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-mutual-idle-'))
  const directory = join(root, 'private')
  const a = new GatewaySessionTransport({ directory, sessionId: randomUUID(), name: 'First peer', cwd: root, policy: 'accept' })
  const b = new GatewaySessionTransport({ directory, sessionId: randomUUID(), name: 'Second peer', cwd: root, policy: 'accept' })
  try {
    await a.start()
    await b.start()
    await Promise.all([a.update({ status: 'running' }), b.update({ status: 'running' })])
    await Promise.all([a.watchIdle(b.peer.sessionId), b.watchIdle(a.peer.sessionId)])
    await Promise.all([a.update({ status: 'idle' }), b.update({ status: 'idle' })])
    for (const peer of [a, b]) {
      assert.equal(peer.inbox().filter(record => record.message.summary === 'Session became idle').length, 1, 'Each reciprocal subscriber must receive its notification before update completes')
    }
    await Promise.all([a.update({ status: 'running' }), b.update({ status: 'running' })])
    await Promise.all([a.update({ status: 'idle' }), b.update({ status: 'idle' })])
    assert.equal(a.inbox().length, 1)
    assert.equal(b.inbox().length, 1)
  } finally {
    await Promise.all([a.close(), b.close()])
    await rm(root, { recursive: true, force: true })
  }
})

test('independent peers authenticate, discover, hold, release, acknowledge and persist messages', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-peers-'))
  const directory = join(root, 'private')
  if (process.platform === 'win32') {
    const insecure = new GatewaySessionTransport({ directory: root, sessionId: randomUUID(), name: 'Unsafe registry', cwd: root })
    await assert.rejects(insecure.start(), /private Windows ACL/)
  }
  const a = new GatewaySessionTransport({ directory, sessionId: randomUUID(), name: 'Sender', cwd: directory, policy: 'accept' })
  const b = new GatewaySessionTransport({ directory, sessionId: randomUUID(), name: 'Receiver', cwd: directory, policy: 'hold' })
  await a.start()
  await b.start()
  try {
    assert.equal((await listGatewayPeers(directory)).length, 2)
    await b.update({ status: 'running' })
    assert.equal((await a.watchIdle(b.peer.sessionId) as any).state, 'watching')
    await b.update({ status: 'idle' })
    assert.equal(a.inbox().filter(r => r.message.summary === 'Session became idle').length, 1)
    await b.update({ status: 'running' })
    await b.update({ status: 'idle' })
    assert.equal(a.inbox().filter(r => r.message.summary === 'Session became idle').length, 1)
    const denied = await callGatewayPeer(b.peer.endpoint, { type: 'ping', token: 'not-authorized' }) as any
    assert.equal(denied.ok, false)
    await assert.rejects(a.send(b.peer.sessionId, '界'.repeat(22000), 'Oversize Unicode'), /byte limit/)
    const sent = await a.send(b.peer.sessionId, 'Schema changed', 'Schema notice') as any
    assert.equal(sent.state, 'held')
    assert.equal(b.inbox()[0]?.senderName, 'Sender')
    const senderRegistration = JSON.parse(await readFile(join(directory, `${a.peer.sessionId}.json`), 'utf8'))
    const receiverRegistration = JSON.parse(await readFile(join(directory, `${b.peer.sessionId}.json`), 'utf8'))
    const originalMessage = b.inbox()[0]!.message
    const request = { type: 'message', token: receiverRegistration.token, senderToken: senderRegistration.token, message: originalMessage }
    assert.equal((await callGatewayPeer(b.peer.endpoint, request) as any).state, 'held')
    assert.equal(b.inbox().length, 1)
    assert.equal((await callGatewayPeer(b.peer.endpoint, { ...request, message: { ...originalMessage, text: 'Altered replay' } }) as any).ok, false)
    // The kind rides the envelope and survives the wire, which is what lets the
    // receiver tell work it is expected to do from a question it only has to
    // answer.
    const directive = { ...originalMessage, id: randomUUID(), kind: 'directive' }
    assert.equal((await callGatewayPeer(b.peer.endpoint, { ...request, message: directive }) as any).state, 'held')
    assert.equal(b.inbox().find(record => record.message.id === directive.id)?.message.kind, 'directive')
    // A field this build has never heard of must not refuse the message. A
    // fleet is restarted session by session, so a newer sender and an older
    // receiver coexisting is the normal state during a rollout, and refusing
    // the whole message turns a forward-compatible field into a delivery
    // failure the sender reads as the bus being flaky. The unknown key is
    // dropped and every field this build knows is still validated.
    const fromAFutureBuild = { ...originalMessage, id: randomUUID(), kind: 'inquiry', aFieldFromAFutureBuild: 'ignored' }
    assert.equal((await callGatewayPeer(b.peer.endpoint, { ...request, message: fromAFutureBuild }) as any).state, 'held')
    const arrived = b.inbox().find(record => record.message.id === fromAFutureBuild.id)?.message as any
    assert.equal(arrived?.kind, 'inquiry')
    assert.equal(arrived?.aFieldFromAFutureBuild, undefined)
    const inboxPath = join(directory, `${b.peer.sessionId}.inbox`)
    const savedPath = `${inboxPath}.saved`
    await rename(inboxPath, savedPath)
    await mkdir(inboxPath)
    try {
      await assert.rejects(b.setPolicy('accept'))
      assert.equal(b.inbox()[0]?.state, 'held', 'failed persistence must not release held messages')
    } finally {
      await rm(inboxPath, { recursive: true })
      await rename(savedPath, inboxPath)
    }
    await b.setPolicy('accept')
    assert.equal(b.inbox()[0]?.state, 'queued')
    await rename(inboxPath, savedPath)
    await mkdir(inboxPath)
    try {
      await assert.rejects(b.acknowledge(sent.id))
      assert.equal(b.inbox()[0]?.state, 'queued', 'failed persistence must not acknowledge delivery')
    } finally {
      await rm(inboxPath, { recursive: true })
      await rename(savedPath, inboxPath)
    }
    await b.acknowledge(sent.id)
    assert.equal(b.inbox()[0]?.state, 'delivered')
    await b.setPolicy('refuse')
    assert.equal((await a.send(b.peer.sessionId, 'Do not accept', 'Refusal test') as any).ok, false)
    await a.update({ name: 'Renamed sender' })
    assert.equal((await listGatewayPeers(directory)).find(peer => peer.sessionId === a.peer.sessionId)?.name, 'Renamed sender')
    const registrationPath = join(directory, `${a.peer.sessionId}.json`)
    const registration = await readFile(registrationPath, 'utf8')
    const tampered = JSON.parse(registration)
    tampered.peer.endpoint = b.peer.endpoint
    await writeFile(registrationPath, JSON.stringify(tampered))
    try {
      await assert.rejects(b.send(a.peer.sessionId, 'Private message', 'Endpoint substitution'), /endpoint/)
    } finally {
      await writeFile(registrationPath, registration)
    }
    const duplicate = new GatewaySessionTransport({ directory, sessionId: a.peer.sessionId, name: 'Duplicate', cwd: directory })
    await assert.rejects(duplicate.start(), /already running/)
    await b.close()
    const restored = new GatewaySessionTransport({ directory, sessionId: b.peer.sessionId, name: 'Restored receiver', cwd: directory })
    await restored.start()
    try {
      assert.notEqual(restored.peer.runtimeId, b.peer.runtimeId)
      assert.equal(restored.inbox()[0]?.message.id, sent.id)
      assert.equal(restored.inbox()[0]?.state, 'delivered')
      assert.equal((await a.send(restored.peer.sessionId, 'Still refused', 'Persisted policy') as any).ok, false)
      await restored.setPolicy('accept')
      const pending = await a.send(restored.peer.sessionId, 'Pending across restart', 'Pending') as any
      assert.equal(pending.state, 'queued')
    } finally {
      await restored.close()
    }
  } finally {
    await a.close()
    await b.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('a peer read is served from the target transcript, and never asks the target for a turn', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-peer-read-'))
  const directory = join(root, 'private')
  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  const a = new GatewaySessionTransport({ directory, sessionId: randomUUID(), name: 'Reader', cwd: root })
  const b = new GatewaySessionTransport({ directory, sessionId: randomUUID(), name: 'Read target', cwd: root })
  try {
    await a.start()
    await b.start()
    const { getTranscriptPath } = await import('../src/utils/sessionStorage.ts')
    const transcript = getTranscriptPath()
    await mkdir(dirname(transcript), { recursive: true })
    const turn = (uuid: string, parentUuid: string | null, text: string) => JSON.stringify({ type: 'user', uuid, parentUuid, sessionId: b.peer.sessionId, isSidechain: false, message: { role: 'user', content: text }, timestamp: '2026-09-29T00:00:00.000Z' })
    await writeFile(transcript, `${turn('t1', null, 'PEER_WORK')}\n${turn('t2', 't1', 'MORE_PEER_WORK')}\n`)

    const slice = await a.readPeer(b.peer.sessionId)
    assert.deepEqual(slice.turns.map(item => item.text), ['PEER_WORK', 'MORE_PEER_WORK'])
    assert.equal(slice.cursor, 't2')
    assert.equal(slice.chainLength, 2)
    // The reply came from the file: the target took no message and ran no turn.
    assert.equal(b.inbox().length, 0)
    assert.equal(b.historyEntries().length, 0)
    // Following along costs only the turns that are new.
    await writeFile(transcript, `${turn('t1', null, 'PEER_WORK')}\n${turn('t2', 't1', 'MORE_PEER_WORK')}\n${turn('t3', 't2', 'NEWEST')}\n`)
    const next = await a.readPeer(b.peer.sessionId, { since: slice.cursor })
    assert.deepEqual(next.turns.map(item => item.text), ['NEWEST'])
    // A reader has to be a registered peer, exactly as a sender does.
    const denied = await callGatewayPeer(b.peer.endpoint, { type: 'read', token: b.token, senderToken: 'not-a-token', fromSessionId: a.peer.sessionId, fromRuntimeId: a.peer.runtimeId }) as { ok?: boolean }
    assert.equal(denied.ok, false)
    await assert.rejects(a.readPeer(a.peer.sessionId), /this session/)
    await assert.rejects(a.readPeer(randomUUID()), /No live session/)
  } finally {
    await a.close()
    await b.close()
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
    await rm(root, { recursive: true, force: true })
  }
})

test('a listing lets go of registrations that are provably dead, and only those', { timeout: 30000 }, async () => {
  // A registration file outlives the process that wrote it. Filtering the answer
  // was never enough: the file stayed, so anything reading the directory - a
  // person, a process scanner, a diagnosis of a pile-up - was still told about a
  // session that had exited. Deleting is the risky half, so this pins every
  // direction: an abandoned one goes; one behind a live pid stays, because a busy
  // peer can miss a ping; and one that died a moment ago stays, because a session
  // being restarted reads its own registration back for the intent it declared.
  const root = await mkdtemp(join(tmpdir(), 'gateway-peer-stale-'))
  const directory = join(root, 'private')
  const seed = new GatewaySessionTransport({ directory, sessionId: randomUUID(), name: 'Seed', cwd: root })
  const abandonedId = randomUUID()
  const crashedId = randomUUID()
  const aliveId = randomUUID()
  const write = async (sessionId: string, pid: number) => {
    const runtimeId = randomUUID()
    const path = join(directory, `${sessionId}.json`)
    await writeFile(path, JSON.stringify({
      peer: {
        protocol: 1, sessionId, runtimeId, name: 'Fabricated', cwd: root, purpose: '',
        pid, startedAt: new Date().toISOString(), status: 'idle',
        endpoint: `\\\\.\\pipe\\gateway-${runtimeId}`,
      },
      token: 'a'.repeat(64),
    }))
    return path
  }
  try {
    // Creates the directory with its private ACL, which the listing validates.
    await seed.start()
    await seed.close()
    const exited = spawnSync(process.execPath, ['-e', ''], { windowsHide: true })
    assert.ok(exited.pid && exited.pid > 0)
    const abandoned = await write(abandonedId, exited.pid!)
    const crashed = await write(crashedId, exited.pid!)
    await write(aliveId, process.pid)
    const twoHoursAgo = new Date(Date.now() - 7_200_000)
    await utimes(abandoned, twoHoursAgo, twoHoursAgo)

    assert.deepEqual(await listGatewayPeers(directory), [], 'no endpoint here is listening')
    await assert.rejects(readFile(abandoned), { code: 'ENOENT' })
    // Its process is gone, but a restart is still plausible, so it keeps the
    // intent it declared until the window closes.
    assert.ok((await readFile(crashed, 'utf8')).includes(`"pid":${exited.pid}`))
    // Its pid answers a probe, so a silent endpoint is not proof of anything.
    assert.ok((await readFile(join(directory, `${aliveId}.json`), 'utf8')).includes(`"pid":${process.pid}`))
  } finally {
    await seed.close()
    await rm(root, { recursive: true, force: true })
  }
})
