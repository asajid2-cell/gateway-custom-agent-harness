import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  compactionFailureError,
  ERROR_MESSAGE_PROMPT_TOO_LONG,
  runCompactionCacheSharingAttempt,
  startCompactProgressHeartbeat,
} from '../src/services/compact/compact.ts'
import {
  compactionRefusalMessage,
  createCompactionContext,
  ERROR_MESSAGE_COMPACTION_TIMEOUT,
  isTransientCompactionFailure,
} from '../src/services/compact/compactProgress.ts'

const read = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), 'utf8')

test('the summarization request runs under a compaction-sized retry budget', () => {
  const compactSource = read('../src/services/compact/compact.ts')
  const apiSource = read('../src/services/api/claude.ts')

  // A saturated route does not recover inside a compaction deadline, so the
  // summary request narrows the foreground retry budget and reports a refusal
  // as a refusal instead of letting the deadline relabel it a stall.
  assert.match(compactSource, /const COMPACT_MAX_RETRIES = 2/)
  assert.match(compactSource, /maxRetries: COMPACT_MAX_RETRIES/)
  assert.match(compactSource, /operation\.noteRefusal\(/)
  // A provider that is working can send nothing the caller can read - reasoning,
  // a keepalive, a block boundary - and that silence is not a stall. The stream
  // loop has to count every event it receives as activity, not just the prose.
  assert.match(compactSource, /operation\.noteActivity\(\)/)
  assert.match(compactSource, /compactionFailureError\(operation, error\)/)
  // A provider that genuinely stalls records no refusal, so it must keep
  // reading as a timeout rather than being attributed to a refusal.
  assert.match(compactSource, /compactionRefusalMessage\(refusal\.status\)/)
  assert.match(compactSource, /new Error\(ERROR_MESSAGE_COMPACTION_TIMEOUT\)/)

  // ...and the API layer has to honour that budget for it to mean anything.
  assert.match(apiSource, /maxRetries: options\.maxRetries/)
  assert.match(apiSource, /maxRetries: retryOptions\.maxRetries/)
})

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

test('compaction names a provider refusal instead of a stall', () => {
  const operation = createCompactionContext({
    abortController: new AbortController(),
  })
  const refusal = { status: 429, message: 'rate limited' }
  operation.noteRefusal(refusal)

  // The retry budget ran out before the deadline: the route refused the
  // summary, so report the refusal rather than a timeout.
  const refused = compactionFailureError(operation, {
    originalError: { status: 429 },
  })
  assert.ok(refused instanceof Error)
  assert.match(refused.message, /429/)
  assert.match(refused.message, /refused/)

  // A different failure is left alone — the recorded refusal did not cause it.
  const unrelated = new Error('boom')
  assert.equal(compactionFailureError(operation, unrelated), unrelated)

  operation.cleanup()
})

test('compaction keeps the timeout text when the provider never refused', async () => {
  const previous = process.env.CLAUDE_CODE_COMPACTION_TIMEOUT_MS
  process.env.CLAUDE_CODE_COMPACTION_TIMEOUT_MS = '10'
  const operation = createCompactionContext({
    abortController: new AbortController(),
  })
  try {
    await new Promise(resolve => setTimeout(resolve, 25))
    const mapped = compactionFailureError(operation, new Error('stalled'))
    assert.ok(mapped instanceof Error)
    assert.match(mapped.message, /Compaction timed out/)
    assert.doesNotMatch(mapped.message, /refused/)
  } finally {
    operation.cleanup()
    if (previous === undefined) delete process.env.CLAUDE_CODE_COMPACTION_TIMEOUT_MS
    else process.env.CLAUDE_CODE_COMPACTION_TIMEOUT_MS = previous
  }
})

test('a route that refuses the summary does not trip the breaker', () => {
  const autoCompactSource = read('../src/services/compact/autoCompact.ts')
  assert.match(autoCompactSource, /isTransientCompactionFailure\(error\)/)

  // The route answered "not now", which it recovers from on its own.
  assert.equal(
    isTransientCompactionFailure(new Error(compactionRefusalMessage(429))),
    true,
  )
  assert.equal(
    isTransientCompactionFailure({ originalError: { status: 429 } }),
    true,
  )
  assert.equal(isTransientCompactionFailure({ status: 502 }), true)

  // Nothing answered: each attempt costs the whole deadline, so a stall that
  // repeats is exactly what the breaker is for.
  assert.equal(
    isTransientCompactionFailure(new Error(ERROR_MESSAGE_COMPACTION_TIMEOUT)),
    false,
  )
  // A conversation the provider cannot accept will fail again identically.
  assert.equal(
    isTransientCompactionFailure(new Error(ERROR_MESSAGE_PROMPT_TOO_LONG)),
    false,
  )
  assert.equal(isTransientCompactionFailure({ status: 400 }), false)
  assert.equal(isTransientCompactionFailure(new Error('boom')), false)
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
