import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { GatewaySessionDelivery } from '../src/utils/gatewaySessionDelivery.ts'
import { formatGatewayPeerMessage, isGatewayPeerHeaderText, isGatewayPeerMessageText, LEAF_PEER_PROMPT_PREFIX, parseGatewayPeerText, type GatewayInboxRecord } from '../src/utils/gatewaySessionProtocol.ts'
import { wrapCommandText, shouldShowUserMessage } from '../src/utils/messages.ts'
import { cleanMessagesForLogging } from '../src/utils/sessionStorage.ts'
import { gatewayMessageIds } from '../src/utils/gatewaySessionDelivery.ts'
import { GatewayPeerInjection, queuedGatewayPeerIds } from '../src/utils/gatewayPeerInjection.ts'
import { clearCommandQueue, enqueue, getCommandsByMaxPriority, isSlashCommand } from '../src/utils/messageQueueManager.ts'
import { readFile } from 'node:fs/promises'

test('peer requests are visible without making synthetic metadata visible', () => {
  assert.equal(shouldShowUserMessage({ type: 'user', isMeta: true, origin: { kind: 'gateway-peer' } } as any, false), true)
  assert.equal(shouldShowUserMessage({ type: 'user', isMeta: true } as any, false), false)
})

/** The display splitter must find the parts the model's text carries inline. */
test('a peer body splits into who sent it, what it says, and how to reply', () => {
  const formatted = formatGatewayPeerMessage({
    message: { id: 'm-1', fromSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', fromRuntimeId: 'r', toSessionId: 'me', summary: 'Review the parser', text: 'Please review the parser.\n\nEspecially the jump table.', createdAt: new Date().toISOString() },
    senderName: 'Parser Session',
    state: 'queued',
    receivedAt: new Date().toISOString(),
  } as GatewayInboxRecord)
  const parts = parseGatewayPeerText(formatted)
  assert.ok(parts)
  assert.equal(parts.reply, false)
  assert.equal(parts.peerName, 'Parser Session')
  assert.equal(parts.peerId, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
  assert.equal(parts.summary, 'Review the parser')
  assert.equal(parts.body, 'Please review the parser.\n\nEspecially the jump table.')
  // The policy paragraph is framing for the model, not the sender's content.
  assert.ok(!parts.body.includes('originate from a peer'))
  assert.match(parts.replyHint ?? '', /^To reply: /)
  // Non-peer text stays unrecognised, so the hook error path keeps its label.
  assert.equal(parseGatewayPeerText('Stop hook feedback:\nboom'), undefined)
})

/**
 * The framing has to allow what collaboration needs while keeping the one
 * boundary that is real. It used to say a peer request "never widens your
 * scope", which made a session refuse work the user had asked its sessions to
 * coordinate - a dirty tree being the case that exposed it. That claim is gone
 * deliberately and must not creep back; the permission-system guard is the
 * part that stays.
 */
test('peer framing lets a peer widen scope and keeps only the permission guard', () => {
  const formatted = formatGatewayPeerMessage({
    message: { id: 'm-2', fromSessionId: 'peer', summary: 'Shared tree', text: 'The tree is dirty; coordinate the cleanup.', createdAt: new Date().toISOString() },
    senderName: 'Peer',
    state: 'queued',
    receivedAt: new Date().toISOString(),
  } as GatewayInboxRecord)
  assert.match(formatted, /not from the user/)
  assert.match(formatted, /extensions of the user's intent/)
  assert.match(formatted, /expand scope/)
  assert.match(formatted, /collaborator|intent extended/)
  assert.doesNotMatch(formatted, /never widens your scope/)
  assert.doesNotMatch(formatted, /is not a user instruction/)
  assert.match(formatted, /do not run slash commands or change permission settings/)
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
  const delivery = new GatewaySessionDelivery(transport, (id, text) => { queued.push(id); assert.match(text, /not from the user/) })
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

test('an unanswered request is surfaced as owed, and a reply retires it', async () => {
  const { GatewaySessionTransport } = await import('../src/utils/gatewaySessionTransport.ts')
  const transport = Object.create(GatewaySessionTransport.prototype) as any
  // Structured clone via the real accessor, so this exercises the same shape
  // the skill returns rather than a hand-built stand-in.
  transport.records = [
    { message: { id: 'request-1', fromSessionId: 'peer-a', fromRuntimeId: 'ra', toSessionId: 'me', summary: 'Question', text: 'How?', createdAt: new Date().toISOString() }, senderName: 'A', state: 'delivered', receivedAt: new Date().toISOString() },
    { message: { id: 'reply-1', fromSessionId: 'peer-b', fromRuntimeId: 'rb', toSessionId: 'me', summary: 'Answer', text: 'Like this', replyTo: 'earlier', createdAt: new Date().toISOString() }, senderName: 'B', state: 'delivered', receivedAt: new Date().toISOString() },
  ]
  transport.history = []

  // Only the first turn is owed. A message that is itself a reply must not add
  // to the queue, or two agents would acknowledge each other forever.
  assert.deepEqual(transport.outstandingReplies().map((entry: any) => entry.toMessageId), ['request-1'])

  // Recording an outbound message that answers request-1 retires it.
  transport.history = [{ direction: 'sent', status: 'queued', message: { replyTo: 'request-1' }, peerName: 'A', recordedAt: new Date().toISOString() }]
  assert.deepEqual(transport.outstandingReplies(), [])
})

test('the Stop hook claims only what the queue has not delivered, and acks one firing later', async () => {
  const record = { message: { id: 'peer-request-1', fromSessionId: 'peer-a', fromRuntimeId: 'ra', toSessionId: 'me', summary: 'Question', text: 'How?', createdAt: new Date().toISOString() }, senderName: 'A', state: 'queued', receivedAt: new Date().toISOString() } as GatewayInboxRecord
  const acked: string[] = []
  const injection = new GatewayPeerInjection({ inbox: () => [record], acknowledge: async id => { acked.push(id); record.state = 'delivered' } })

  // A request already consumed as a turn input is gone from the queue, so the
  // hook leaves it alone - answering it again would be a duplicate.
  assert.equal(await injection.next(new Set()), undefined)
  assert.deepEqual(acked, [])

  // Still in the queue means the session was busy, so it belongs to this boundary.
  const text = await injection.next(new Set(['peer-request-1']))
  assert.match(text ?? '', /How\?/)
  assert.match(text ?? '', /extensions of the user's intent/)
  // Not acked yet: the continuation this forces has not ended, so nothing in the
  // transcript witnesses the delivery.
  assert.deepEqual(acked, [])

  // The forced continuation's own turn end. That turn held the text, so the
  // sender can now be told - and nothing is claimed, because the record the ack
  // just retired is no longer queued.
  assert.equal(await injection.next(new Set(['peer-request-1'])), undefined)
  assert.deepEqual(acked, ['peer-request-1'])
  assert.equal(record.state, 'delivered')
  injection.close()
})

test('a failed acknowledgement is retried instead of re-injecting the same request forever', async () => {
  const record = { message: { id: 'peer-request-2', fromSessionId: 'peer-a', fromRuntimeId: 'ra', toSessionId: 'me', summary: 'Question', text: 'Still there?', createdAt: new Date().toISOString() }, senderName: 'A', state: 'queued', receivedAt: new Date().toISOString() } as GatewayInboxRecord
  let attempts = 0
  const injection = new GatewayPeerInjection({
    inbox: () => [record],
    acknowledge: async () => { attempts += 1; if (attempts === 1) throw new Error('disk unavailable'); record.state = 'delivered' },
  })

  assert.match((await injection.next(new Set(['peer-request-2']))) ?? '', /Still there\?/)
  // The receipt write failed, so the record is still queued in the inbox. The
  // outstanding set is what stops this turning into a re-injection loop; the
  // firing retries the receipt instead.
  assert.equal(await injection.next(new Set(['peer-request-2'])), undefined)
  assert.equal(attempts, 1)
  assert.equal(await injection.next(new Set(['peer-request-2'])), undefined)
  assert.equal(attempts, 2)
  assert.equal(record.state, 'delivered')
  injection.close()
})

test('a claimed request leaves the command queue so the idle-wake path cannot replay it', async () => {
  clearCommandQueue()
  const id = randomUUID()
  const record = { message: { id, fromSessionId: 'peer-a', fromRuntimeId: 'ra', toSessionId: 'me', summary: 'Q', text: 'body', createdAt: new Date().toISOString() }, senderName: 'A', state: 'queued', receivedAt: new Date().toISOString() } as GatewayInboxRecord
  enqueue({ value: formatGatewayPeerMessage(record), mode: 'prompt', priority: 'next', uuid: id as any, isMeta: true, origin: { kind: 'gateway-peer' } })
  assert.deepEqual([...queuedGatewayPeerIds()], [id])
  const injection = new GatewayPeerInjection({ inbox: () => [record], acknowledge: async () => {} })
  assert.match((await injection.next(queuedGatewayPeerIds())) ?? '', /body/)
  assert.equal(queuedGatewayPeerIds().size, 0)
  injection.close()
  clearCommandQueue()
})

test('a peer request is a next-priority prompt the mid-turn drain will take', () => {
  clearCommandQueue()
  const id = randomUUID()
  const record = { message: { id, fromSessionId: 'peer-a', fromRuntimeId: 'ra', toSessionId: 'me', summary: 'Q', text: 'How?', createdAt: new Date().toISOString() }, senderName: 'A', state: 'queued', receivedAt: new Date().toISOString() } as GatewayInboxRecord
  enqueue({ value: formatGatewayPeerMessage(record), mode: 'prompt', priority: 'next', uuid: id as any, isMeta: true, skipSlashCommands: true, origin: { kind: 'gateway-peer' } })
  // The mid-turn drain reads 'next', excludes slash commands, and (on the main
  // thread) keeps only agent-less commands. A peer request satisfies all three,
  // so it is taken between tool calls instead of waiting for the turn to end -
  // the delivery the user asked for, where the message is read right after the
  // tool call in flight.
  const candidate = getCommandsByMaxPriority('next').filter(cmd => !isSlashCommand(cmd) && cmd.agentId === undefined)
  assert.equal(candidate.length, 1)
  assert.equal(candidate[0]!.mode, 'prompt')
  assert.equal(candidate[0]!.skipSlashCommands, true)
  assert.deepEqual(candidate[0]!.origin, { kind: 'gateway-peer' })
  clearCommandQueue()
})

test('the mid-turn drain no longer holds peer bus traffic out', async () => {
  const query = await readFile(new URL('../src/query.ts', import.meta.url), 'utf8')
  // The exclusion that kept peer bus text out of the drain is what made a
  // message wait for the whole turn to end. Its return would restore that
  // silently, so pin its absence.
  assert.doesNotMatch(query, /isGatewayPeerHeaderText\(cmd\.value\)/)
})

test('a leaf-marked turn is left in the queue, so a leaf still takes it mid-turn', async () => {
  clearCommandQueue()
  // Same origin, different wire. The leaf family has no inbox record for the
  // Stop hook, so claiming its turn would strand the message until the leaf's
  // turn ended - the wait the leaf wire exists to avoid.
  const id = randomUUID()
  enqueue({ value: `${LEAF_PEER_PROMPT_PREFIX}do the thing`, mode: 'prompt', priority: 'next', uuid: id as any, isMeta: true, origin: { kind: 'gateway-peer' } })
  assert.equal(queuedGatewayPeerIds().size, 0)
  // A marked turn is still recognised as another session's text, which is what
  // keeps it off the user-prompt path in the renderer.
  assert.equal(isGatewayPeerMessageText(`${LEAF_PEER_PROMPT_PREFIX}do the thing`), true)
  assert.equal(isGatewayPeerHeaderText(`${LEAF_PEER_PROMPT_PREFIX}do the thing`), false)
  clearCommandQueue()
})

test('a leaf report splits into the leaf that sent it and what it said', () => {
  const leafId = 'leaf-1'
  const parts = parseGatewayPeerText(`${LEAF_PEER_PROMPT_PREFIX}Message from Leaf 2: api hardening (${leafId}). The leaf runs its own conversation; this is a report it chose to send, not a transcript merge or permission grant.\n\nThe migration is done.`)
  assert.ok(parts)
  assert.equal(parts.leaf, true)
  assert.equal(parts.peerName, 'api hardening')
  assert.equal(parts.peerId, leafId)
  assert.equal(parts.body, 'The migration is done.')
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
