import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  clearCommandQueue,
  dequeue,
  enqueue,
  enqueuePendingNotification,
  enqueueUserPrompt,
  getCommandQueue,
  isUserPrompt,
  MAX_QUEUED_PROMPTS,
  popAllEditable,
  popNewestEditable,
  queuedPromptCount,
} from '../src/utils/messageQueueManager.ts'
import { processQueueIfReady } from '../src/utils/queueProcessor.ts'

test('the queue holds a bounded number of the user\'s own messages', () => {
  clearCommandQueue()
  // A burst is written without waiting for a reply, so the cap is what keeps
  // the list readable and editable. The fourth message is the last one taken.
  for (let i = 1; i <= MAX_QUEUED_PROMPTS; i++) {
    assert.equal(enqueueUserPrompt({ value: `message ${i}`, mode: 'prompt' }), true)
  }
  assert.equal(queuedPromptCount(), MAX_QUEUED_PROMPTS)
  assert.equal(getCommandQueue().length, MAX_QUEUED_PROMPTS)

  // A message over the cap is refused outright: it must not be enqueued, and
  // the messages already waiting must not be disturbed to make room for it.
  assert.equal(enqueueUserPrompt({ value: 'one too many', mode: 'prompt' }), false)
  assert.equal(queuedPromptCount(), MAX_QUEUED_PROMPTS)
  assert.deepEqual(getCommandQueue().map(cmd => cmd.value), ['message 1', 'message 2', 'message 3', 'message 4'])

  clearCommandQueue()
  assert.equal(queuedPromptCount(), 0)
})

test('a full user queue never refuses what the app queues for itself', () => {
  clearCommandQueue()
  for (let i = 1; i <= MAX_QUEUED_PROMPTS; i++) {
    enqueueUserPrompt({ value: `message ${i}`, mode: 'prompt' })
  }
  assert.equal(enqueueUserPrompt({ value: 'refused', mode: 'prompt' }), false)

  // A notification is not the user's message: it must not be refused because
  // the user filled the queue, and it must not consume a slot the user was
  // promised. It waits behind the prompts, not among them.
  enqueuePendingNotification({ value: 'background task finished', mode: 'prompt', isMeta: true })
  assert.equal(queuedPromptCount(), MAX_QUEUED_PROMPTS)
  assert.equal(getCommandQueue().length, MAX_QUEUED_PROMPTS + 1)

  // Draining the prompts leaves the notification in place.
  for (let i = 0; i < MAX_QUEUED_PROMPTS; i++) {
    assert.equal(dequeue(isUserPrompt)?.value, `message ${i + 1}`)
  }
  assert.equal(queuedPromptCount(), 0)
  assert.deepEqual(getCommandQueue().map(cmd => cmd.value), ['background task finished'])

  clearCommandQueue()
})

test('the queue counts only what the keyboard wrote', () => {
  clearCommandQueue()
  // A prompt from the keyboard counts.
  assert.equal(isUserPrompt({ value: 'hello', mode: 'prompt' }), true)
  // A bash command counts: it is the user's line too.
  assert.equal(isUserPrompt({ value: '!ls', mode: 'bash' }), true)
  // App-queued text does not, however it is shaped.
  assert.equal(isUserPrompt({ value: 'tick', mode: 'prompt', isMeta: true }), false)
  assert.equal(isUserPrompt({ value: 'subagent notice', mode: 'prompt', agentId: 'a1' as any }), false)
  assert.equal(isUserPrompt({ value: 'notification', mode: 'task-notification' }), false)
  clearCommandQueue()
})

test('messages are sent in the order they were written', () => {
  clearCommandQueue()
  // Tab then Tab then Tab: each lands after the one before it.
  enqueueUserPrompt({ value: 'first', mode: 'prompt' })
  enqueueUserPrompt({ value: 'second', mode: 'prompt' })
  enqueueUserPrompt({ value: 'third', mode: 'prompt' })
  // A notification queued in between must not jump the line.
  enqueuePendingNotification({ value: 'notice', mode: 'prompt', isMeta: true })

  assert.deepEqual(
    [dequeue()?.value, dequeue()?.value, dequeue()?.value, dequeue()?.value],
    ['first', 'second', 'third', 'notice'],
  )
  assert.equal(dequeue(), undefined)
  clearCommandQueue()
})

test('up-arrow hands back one message and leaves the rest waiting', () => {
  clearCommandQueue()
  enqueueUserPrompt({ value: 'first', mode: 'prompt' })
  enqueueUserPrompt({ value: 'second', mode: 'prompt' })
  enqueueUserPrompt({ value: 'third', mode: 'prompt' })

  // The newest one comes back for editing, with the draft the user is holding
  // kept below it - the same shape the input takes when a message is written.
  const newest = popNewestEditable('draft', 5)
  assert.equal(newest?.text, 'third\ndraft')
  assert.equal(newest?.cursorOffset, 'third'.length + 1 + 5)
  // Exactly one left the queue, so pressing up again reaches the one before it.
  assert.deepEqual(getCommandQueue().map(cmd => cmd.value), ['first', 'second'])

  const next = popNewestEditable('', 0)
  assert.equal(next?.text, 'second')
  assert.deepEqual(getCommandQueue().map(cmd => cmd.value), ['first'])

  const last = popNewestEditable('', 0)
  assert.equal(last?.text, 'first')
  assert.equal(getCommandQueue().length, 0)

  // Nothing waiting means nothing to hand back, so history can take the key.
  assert.equal(popNewestEditable('', 0), undefined)
  clearCommandQueue()
})

test('a message the app queued is not offered for editing', () => {
  clearCommandQueue()
  enqueueUserPrompt({ value: 'mine', mode: 'prompt' })
  enqueuePendingNotification({ value: 'tick', mode: 'prompt', isMeta: true })

  // Up reaches the user's own message, skipping past the system one rather
  // than dropping raw XML into the composer.
  assert.equal(popNewestEditable('', 0)?.text, 'mine')
  assert.deepEqual(getCommandQueue().map(cmd => cmd.value), ['tick'])
  assert.equal(popNewestEditable('', 0), undefined)
  clearCommandQueue()
})

test('escape still hands back every message at once', () => {
  clearCommandQueue()
  enqueueUserPrompt({ value: 'first', mode: 'prompt' })
  enqueueUserPrompt({ value: 'second', mode: 'prompt' })

  // Escape is "give me my words back", so the whole queue comes back joined -
  // unlike up-arrow, which walks them one at a time.
  const all = popAllEditable('draft', 5)
  assert.equal(all?.text, 'first\nsecond\ndraft')
  assert.equal(getCommandQueue().length, 0)
  clearCommandQueue()
})

test('an image queued with a message comes back with it', () => {
  clearCommandQueue()
  const image = { id: 41, type: 'image' as const, content: 'AAAA', mediaType: 'image/png' as const, filename: 'shot.png' }
  enqueueUserPrompt({ value: 'look at this', mode: 'prompt', pastedContents: { 41: image } })
  enqueueUserPrompt({ value: 'and this', mode: 'prompt' })

  // The older message is not the one pulled back, so its image stays put.
  const newest = popNewestEditable('', 0)
  assert.equal(newest?.text, 'and this')
  assert.deepEqual(newest?.images, [])

  const withImage = popNewestEditable('', 0)
  assert.equal(withImage?.text, 'look at this')
  assert.deepEqual(withImage?.images, [image])
  clearCommandQueue()
})

test('a message enqueued by another route still waits behind the user', () => {
  clearCommandQueue()
  // Enter mid-turn takes the plain enqueue path, so it is a user message too,
  // and the cap sees it.
  enqueue({ value: 'from enter', mode: 'prompt' })
  for (let i = 0; i < MAX_QUEUED_PROMPTS - 1; i++) {
    assert.equal(enqueueUserPrompt({ value: `extra ${i}`, mode: 'prompt' }), true)
  }
  assert.equal(queuedPromptCount(), MAX_QUEUED_PROMPTS)
  assert.equal(enqueueUserPrompt({ value: 'refused', mode: 'prompt' }), false)
  clearCommandQueue()
})

// A Tab-queued prompt is a real queue entry, not a second Enter. The
// between-turn drain must leave it alone until the session has rested, and a
// mid-turn drain (query.ts) must never see it at all.
test('a Tab-queued prompt waits for the rest, not for the next idle tick', () => {
  clearCommandQueue()
  enqueueUserPrompt({ value: 'held', mode: 'prompt', deferred: true })

  const drained: string[] = []
  const executeInput = async (commands: any[]) => {
    for (const cmd of commands) drained.push(cmd.value)
  }

  // The ordinary between-turn drain does not release it.
  assert.deepEqual(processQueueIfReady({ executeInput }), { processed: false })
  assert.deepEqual(drained, [])
  assert.deepEqual(getCommandQueue().map(cmd => cmd.value), ['held'])

  // The rested drain does, and it goes through the normal prompt path.
  assert.deepEqual(
    processQueueIfReady({ executeInput, includeDeferred: true }),
    { processed: true },
  )
  assert.deepEqual(drained, ['held'])
  assert.equal(getCommandQueue().length, 0)
  clearCommandQueue()
})

test('a held prompt never blocks what is behind it', () => {
  clearCommandQueue()
  enqueueUserPrompt({ value: 'held', mode: 'prompt', deferred: true })
  enqueuePendingNotification({ value: 'notice', mode: 'prompt', isMeta: true })

  const drained: string[] = []
  const executeInput = async (commands: any[]) => {
    for (const cmd of commands) drained.push(cmd.value)
  }

  // The notification drains now; the held prompt is still waiting.
  assert.deepEqual(processQueueIfReady({ executeInput }), { processed: true })
  assert.deepEqual(drained, ['notice'])
  assert.deepEqual(getCommandQueue().map(cmd => cmd.value), ['held'])
  clearCommandQueue()
})

test('held prompts are released one per rest, in the order written', () => {
  clearCommandQueue()
  enqueueUserPrompt({ value: 'first', mode: 'prompt', deferred: true })
  enqueueUserPrompt({ value: 'second', mode: 'prompt', deferred: true })

  const drained: string[] = []
  const executeInput = async (commands: any[]) => {
    for (const cmd of commands) drained.push(cmd.value)
  }

  processQueueIfReady({ executeInput, includeDeferred: true })
  assert.deepEqual(drained, ['first'])
  assert.deepEqual(getCommandQueue().map(cmd => cmd.value), ['second'])

  processQueueIfReady({ executeInput, includeDeferred: true })
  assert.deepEqual(drained, ['first', 'second'])
  assert.equal(getCommandQueue().length, 0)
  clearCommandQueue()
})

test('an Enter-queued prompt still drains immediately and steers', () => {
  clearCommandQueue()
  // Enter mid-turn does not set `deferred`, so the mid-turn drain in query.ts
  // (and this between-turn drain) both see it right away.
  enqueueUserPrompt({ value: 'steer', mode: 'prompt' })

  const drained: string[] = []
  const executeInput = async (commands: any[]) => {
    for (const cmd of commands) drained.push(cmd.value)
  }

  assert.deepEqual(processQueueIfReady({ executeInput }), { processed: true })
  assert.deepEqual(drained, ['steer'])
  assert.equal(getCommandQueue().length, 0)
  clearCommandQueue()
})
