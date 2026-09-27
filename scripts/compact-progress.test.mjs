import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compactionRefusalMessage,
  createCompactionContext,
  startCompactProgressHeartbeat,
} from '../src/services/compact/compactProgress.ts'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

test('compact heartbeat emits elapsed progress and phase/attempt changes', async () => {
  const events = []
  const heartbeat = startCompactProgressHeartbeat(
    { onCompactProgress: event => events.push(event) },
    10,
  )

  await wait(25)
  heartbeat.setPhase('summarizing', 2)
  await wait(15)
  heartbeat.stop()

  const progress = events.filter(event => event.type === 'compact_progress')
  assert.ok(progress.length >= 2)
  assert.equal(progress.some(event => event.phase === 'pre_hooks'), true)
  assert.equal(
    progress.some(
      event =>
        event.phase === 'summarizing' &&
        event.attempt === 2 &&
        event.elapsedMs >= 0,
    ),
    true,
  )
})

test('compact heartbeat stop prevents emissions after completion', async () => {
  const events = []
  const heartbeat = startCompactProgressHeartbeat(
    { onCompactProgress: event => events.push(event) },
    10,
  )

  await wait(15)
  heartbeat.stop()
  const countAfterStop = events.length
  await wait(30)

  assert.equal(events.length, countAfterStop)
})

test('real output progress extends compaction idle deadline, heartbeat does not', async () => {
  const previous = process.env.CLAUDE_CODE_COMPACTION_TIMEOUT_MS
  process.env.CLAUDE_CODE_COMPACTION_TIMEOUT_MS = '30'
  const parent = new AbortController()
  const operation = createCompactionContext({ abortController: parent, setResponseLength: () => {} })
  try {
    for (let i = 0; i < 5; i++) {
      await wait(10)
      operation.context.setResponseLength(length => length + 1)
    }
    assert.equal(operation.didTimeout(), false)
    await wait(45)
    assert.equal(operation.didTimeout(), true)
    assert.equal(parent.signal.aborted, false)
  } finally {
    operation.cleanup()
    if (previous === undefined) delete process.env.CLAUDE_CODE_COMPACTION_TIMEOUT_MS
    else process.env.CLAUDE_CODE_COMPACTION_TIMEOUT_MS = previous
  }
})

test('activity that is not summary text still extends the compaction deadline', async () => {
  const previous = process.env.CLAUDE_CODE_COMPACTION_TIMEOUT_MS
  process.env.CLAUDE_CODE_COMPACTION_TIMEOUT_MS = '100'
  const operation = createCompactionContext({
    abortController: new AbortController(),
  })
  try {
    // A provider reasoning past the deadline without having written a word of
    // the summary is still serving the request. The deadline has to hold on
    // every pulse it sends, or it is measuring "no prose arrived yet" and
    // aborting work that is under way.
    for (let i = 0; i < 6; i++) {
      await wait(10)
      operation.noteActivity()
    }
    assert.equal(operation.didTimeout(), false)

    // Nothing pulsing any more, so the deadline means what it says again.
    await wait(150)
    assert.equal(operation.didTimeout(), true)
  } finally {
    operation.cleanup()
    if (previous === undefined) delete process.env.CLAUDE_CODE_COMPACTION_TIMEOUT_MS
    else process.env.CLAUDE_CODE_COMPACTION_TIMEOUT_MS = previous
  }
})

test('continuous output still reaches the compaction hard deadline', async () => {
  const previous = process.env.CLAUDE_CODE_COMPACTION_TIMEOUT_MS
  process.env.CLAUDE_CODE_COMPACTION_TIMEOUT_MS = '20'
  const operation = createCompactionContext({ abortController: new AbortController() })
  const output = setInterval(() => operation.context.setResponseLength(length => length + 1), 5)
  try {
    await wait(85)
    assert.equal(operation.didTimeout(), true)
  } finally {
    clearInterval(output)
    operation.cleanup()
    if (previous === undefined) delete process.env.CLAUDE_CODE_COMPACTION_TIMEOUT_MS
    else process.env.CLAUDE_CODE_COMPACTION_TIMEOUT_MS = previous
  }
})

test('a refusal seen before any output survives the deadline and explains it', async () => {
  const previous = process.env.CLAUDE_CODE_COMPACTION_TIMEOUT_MS
  process.env.CLAUDE_CODE_COMPACTION_TIMEOUT_MS = '10'
  const operation = createCompactionContext({
    abortController: new AbortController(),
  })
  try {
    operation.noteRefusal({ status: 429, message: 'rate limited' })
    assert.deepEqual(operation.lastRefusal(), {
      status: 429,
      message: 'rate limited',
    })

    await wait(25)
    assert.equal(operation.didTimeout(), true)
    assert.equal(operation.lastRefusal()?.status, 429)
  } finally {
    operation.cleanup()
    if (previous === undefined) delete process.env.CLAUDE_CODE_COMPACTION_TIMEOUT_MS
    else process.env.CLAUDE_CODE_COMPACTION_TIMEOUT_MS = previous
  }
})

test('a refusal seen after the summary streamed is not the deadline cause', () => {
  const operation = createCompactionContext({
    abortController: new AbortController(),
  })
  try {
    operation.context.setResponseLength(5)
    operation.noteRefusal({ status: 429, message: 'rate limited' })
    assert.equal(operation.lastRefusal(), null)
  } finally {
    operation.cleanup()
  }
})

test('the refusal message names the status and points off the refusing route', () => {
  const message = compactionRefusalMessage(429)
  assert.match(message, /429/)
  assert.match(message, /refused/)
  assert.match(message, /switch models/)
})

test('compaction timeout aborts only the child context and cleans up', async () => {
  const previous = process.env.CLAUDE_CODE_COMPACTION_TIMEOUT_MS
  process.env.CLAUDE_CODE_COMPACTION_TIMEOUT_MS = '10'
  try {
    const parent = new AbortController()
    const operation = createCompactionContext({
      abortController: parent,
    })

    await wait(25)
    assert.equal(operation.didTimeout(), true)
    assert.equal(operation.context.abortController.signal.aborted, true)
    assert.equal(parent.signal.aborted, false)

    operation.cleanup()
    const reason = operation.context.abortController.signal.reason
    assert.match(String(reason?.message ?? reason), /Compaction timed out/)
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_CODE_COMPACTION_TIMEOUT_MS
    } else {
      process.env.CLAUDE_CODE_COMPACTION_TIMEOUT_MS = previous
    }
  }
})
