import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  runCompactionCacheSharingAttempt,
  startCompactProgressHeartbeat,
} from '../src/services/compact/compact.ts'

test('compaction progress heartbeat reports phases and stops cleanly', async () => {
  const events: string[] = []
  const progress = startCompactProgressHeartbeat(
    {
      onCompactProgress: event => events.push(event.type),
    },
    5,
  )

  progress.setPhase('summarizing', 1)
  await new Promise(resolve => setTimeout(resolve, 10))
  progress.stop()
  const eventCount = events.length
  await new Promise(resolve => setTimeout(resolve, 10))

  assert.ok(events.length >= 2)
  assert.equal(events.length, eventCount)
  assert.ok(events.every(event => event === 'compact_progress'))
})

test('compaction cache-sharing attempts abort when the provider never resolves', async () => {
  const parent = new AbortController()
  let aborted = false

  await assert.rejects(
    runCompactionCacheSharingAttempt(
      parent,
      async controller =>
        new Promise((_resolve, reject) => {
          controller.signal.addEventListener(
            'abort',
            () => {
              aborted = true
              reject(controller.signal.reason)
            },
            { once: true },
          )
        }),
      15,
    ),
    /Compaction cache-sharing timeout/,
  )

  assert.equal(aborted, true)
  assert.equal(parent.signal.aborted, false)
})

test('compaction cache-sharing retains a response that keeps producing output', async () => {
  const parent = new AbortController()
  const result = await runCompactionCacheSharingAttempt(
    parent,
    async (_controller, onOutput) => {
      for (let i = 0; i < 5; i++) {
        await new Promise(resolve => setTimeout(resolve, 10))
        onOutput()
      }
      return 'complete summary'
    },
    30,
  )
  assert.equal(result, 'complete summary')
  assert.equal(parent.signal.aborted, false)
})

test('compaction cache-sharing deadlines return even if the operation ignores abort', async () => {
  const parent = new AbortController()
  const started = performance.now()

  await assert.rejects(
    runCompactionCacheSharingAttempt(
      parent,
      async () => new Promise(() => {}),
      15,
    ),
    /Compaction cache-sharing timeout/,
  )

  assert.ok(performance.now() - started < 500)
  assert.equal(parent.signal.aborted, false)
})
