import assert from 'node:assert/strict'
import test from 'node:test'
import {
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
