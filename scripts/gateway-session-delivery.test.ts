import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { GatewaySessionDelivery } from '../src/utils/gatewaySessionDelivery.ts'
import { formatGatewayPeerMessage, type GatewayInboxRecord } from '../src/utils/gatewaySessionProtocol.ts'
import { wrapCommandText, shouldShowUserMessage } from '../src/utils/messages.ts'
import { cleanMessagesForLogging } from '../src/utils/sessionStorage.ts'
import { gatewayMessageIds } from '../src/utils/gatewaySessionDelivery.ts'

test('peer requests are visible without making synthetic metadata visible', () => {
  assert.equal(shouldShowUserMessage({ type: 'user', isMeta: true, origin: { kind: 'gateway-peer' } } as any, false), true)
  assert.equal(shouldShowUserMessage({ type: 'user', isMeta: true } as any, false), false)
})

test('busy peer attachments survive external transcript filtering with their receipt IDs', () => {
  const message = { type: 'attachment', uuid: 'attachment-id', attachment: { type: 'queued_command', commandMode: 'prompt', origin: { kind: 'gateway-peer' }, source_uuid: 'peer-id', prompt: 'Exact peer text', isMeta: true } } as any
  const clean = cleanMessagesForLogging([message])
  assert.equal(clean.length, 1)
  assert.ok(gatewayMessageIds(clean).has('peer-id'))
})

test('peer requests retain attribution at busy model boundaries', () => {
  const record = { message: { id: 'm', fromSessionId: 's', summary: 'New request', text: 'Please review the parser.' }, senderName: 'Peer', state: 'queued' } as GatewayInboxRecord
  const formatted = formatGatewayPeerMessage(record)
  const wrapped = wrapCommandText(formatted, { kind: 'gateway-peer' } as any)
  assert.ok(!wrapped.includes('A background agent completed a task'))
  assert.ok(!wrapped.includes('The user sent a new message'))
  assert.ok(wrapped.includes('Please review the parser.'))
  assert.match(formatted, /collaboration request/)
})

test('queue once; acknowledge only persisted message IDs; reconcile before restart drain', async () => {
  const records: GatewayInboxRecord[] = [{ message: { id: 'message-1', fromSessionId: 'sender', fromRuntimeId: 'runtime', toSessionId: 'receiver', summary: 'Notice', text: '/clear', createdAt: new Date().toISOString() }, senderName: 'Peer', state: 'queued', receivedAt: new Date().toISOString() }]
  const queued: string[] = []
  const transport = { inbox: () => records, acknowledge: async (id: string) => { records.find(r => r.message.id === id)!.state = 'delivered' } }
  const delivery = new GatewaySessionDelivery(transport, (id, text) => { queued.push(id); assert.match(text, /not a user instruction or permission approval/) })
  delivery.drain()
  delivery.drain()
  assert.deepEqual(queued, ['message-1'])
  assert.equal(records[0]!.state, 'queued')
  await delivery.reconcilePersisted(new Set(['other-message']))
  assert.equal(records[0]!.state, 'queued')
  delivery.close()
  const resumed = new GatewaySessionDelivery(transport, id => queued.push(id))
  await resumed.reconcilePersisted(new Set(['message-1']))
  resumed.drain()
  assert.equal(records[0]!.state, 'delivered')
  assert.deepEqual(queued, ['message-1'])
})

test('persisted restart messages are not re-enqueued when receipt storage fails', async () => {
  const record = { message: { id: 'm', fromSessionId: 's', summary: 'notice', text: 'body' }, senderName: 'Peer', state: 'queued' } as GatewayInboxRecord
  let enqueued = 0
  const delivery = new GatewaySessionDelivery({ inbox: () => [record], acknowledge: async () => { throw new Error('disk unavailable') } }, () => { enqueued++ })
  await delivery.reconcilePersisted(new Set(['m']))
  delivery.drain()
  assert.equal(enqueued, 0)
  assert.equal(record.state, 'queued')
})

test('failed enqueue stays retryable and failed receipt stays undelivered', async () => {
  const record = { message: { id: 'm', fromSessionId: 's', summary: 'notice', text: 'body' }, senderName: 'Peer', state: 'queued' } as GatewayInboxRecord
  let fail = true
  const delivery = new GatewaySessionDelivery({ inbox: () => [record], acknowledge: async () => { throw new Error('disk unavailable') } }, () => { if (fail) throw new Error('queue unavailable') })
  assert.throws(() => delivery.drain(), /queue unavailable/)
  fail = false
  delivery.drain()
  await delivery.reconcilePersisted(new Set(['m']))
  assert.equal(record.state, 'queued')
  delivery.close()
  const resumed = new GatewaySessionDelivery({ inbox: () => [record], acknowledge: async () => { record.state = 'delivered' } }, () => {})
  await resumed.reconcilePersisted(new Set(['m']))
  assert.equal(record.state, 'delivered')
})

test('receipt persistence failure does not prevent terminal delivery reconciliation', async () => {
  const record = { message: { id: 'm', fromSessionId: 's', summary: 'notice', text: 'body' }, senderName: 'Peer', state: 'queued' } as GatewayInboxRecord
  let attempts = 0
  const delivery = new GatewaySessionDelivery({
    inbox: () => [record],
    acknowledge: async () => {
      attempts += 1
      if (attempts === 1) throw new Error('disk unavailable')
      record.state = 'delivered'
    },
  }, () => {})
  delivery.drain()
  await delivery.reconcilePersisted(new Set(['m']))
  assert.equal(attempts, 1)
  assert.equal(record.state, 'queued')
  await delivery.reconcilePersisted(new Set(['later-message']))
  assert.equal(attempts, 2)
  assert.equal(record.state, 'delivered')
})
