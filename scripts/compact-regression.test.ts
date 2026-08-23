import { strict as assert } from 'node:assert'
import test from 'node:test'
import { startCompactionProgress } from '../src/commands/compact/compact.ts'
import { runCompactionCacheSharingAttempt } from '../src/services/compact/compact.ts'

test('manual compaction reports progress before preflight work starts', async () => {
  const events: string[] = []
  const context = {
    setSDKStatus: (status: string | null) => events.push(`status:${status}`),
    setStreamMode: (mode: string) => events.push(`mode:${mode}`),
    setResponseLength: () => events.push('response:reset'),
    onCompactProgress: (event: { type: string }) => events.push(event.type),
  } as never

  const stop = startCompactionProgress(context)
  assert.deepEqual(events.slice(0, 5), [
    'status:compacting',
    'mode:requesting',
    'response:reset',
    'compact_start',
    'compact_end',
  ].slice(0, 4))

  await new Promise(resolve => setTimeout(resolve, 5))
  stop()
  assert.equal(events.at(-1), 'status:null')
  assert.equal(events.filter(event => event === 'compact_end').length, 1)
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
