// Regression: publishing the transcript queue gauges must not re-serialize the
// queued entries.
//
// transcriptQueuedEntries / transcriptQueuedPayloadChars were computed by
// walking every per-file write queue and jsonStringify-ing every queued entry,
// and that walk ran from enqueueWrite - i.e. on every enqueue. Cost per enqueue
// was therefore proportional to the queue's depth, so a backed-up queue was
// self-reinforcing: each enqueue blocked the event loop longer than the last,
// the 100ms drain timer could not fire on time, the queue grew further, and the
// discarded serialization allocation ran into tens of GB. A session whose queue
// stayed shallow never noticed, which is why only some sessions ballooned, and
// why the spike was transient - it collapsed as soon as the queue drained.
//
// The fix maintains the totals incrementally. This test pins the cost: enqueue N
// entries and count how often an entry is serialized. Correct is one per
// enqueue; the old shape serialized the whole backlog, i.e. the triangle number
// N(N+1)/2.
import { test, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const N = 200

let root: string | undefined
after(async () => {
  delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
  if (root) await rm(root, { recursive: true, force: true })
})

test('enqueuing N entries serializes each once, not once per queued entry', async () => {
  root = await mkdtemp(join(tmpdir(), 'transcript-queue-'))
  // Persistence is suppressed by default under the test runner, which would
  // make appendEntry return before it ever reaches the queue.
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'

  const telemetry = await import('../src/utils/gatewayMemoryTelemetry.ts')
  const storage = await import('../src/utils/sessionStorage.ts')

  // The gauges are computed only while telemetry is on, so the old whole-queue
  // walk ran only in that state - i.e. in every real session, which collects
  // telemetry from startup.
  const close = await telemetry.startGatewayMemoryTelemetry(root, 'fixture-build')
  assert.ok(close, 'telemetry must start for the gauges to be computed')

  storage.resetProjectForTesting()
  storage.setSessionFileForTesting(join(root, 'transcript.jsonl'))
  assert.equal(
    storage.isTranscriptPersistenceEnabled(),
    true,
    'test must enable transcript persistence to reach the queue',
  )

  let serializations = 0
  // JSON.stringify calls toJSON on nested values, so this counts how often the
  // queued entry is serialized without needing the private enqueueWrite.
  const snapshot = {
    files: [],
    toJSON() {
      serializations++
      return { files: [] }
    },
  } as never

  for (let i = 0; i < N; i++) {
    void storage.recordFileHistorySnapshot(`message-${i}`, snapshot, false)
  }
  const atEnqueue = serializations
  // Let the 100ms flush timer drain the queue and serialize each entry once.
  await new Promise(resolve => setTimeout(resolve, 250))
  const afterDrain = serializations

  assert.equal(
    atEnqueue,
    N,
    `each enqueue must serialize its own entry once; got ${atEnqueue} for ${N} enqueues (quadratic shape is ${(N * (N + 1)) / 2})`,
  )
  assert.ok(
    afterDrain <= 2 * N,
    `draining ${N} entries must serialize each once more; got ${afterDrain}`,
  )

  await close()
})
