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
  let serializedChars = 0
  const PAYLOAD_CHARS = 1024
  // JSON.stringify calls toJSON on nested values, so this counts how often the
  // queued entry is serialized without needing the private enqueueWrite. The
  // payload is realistic-sized so the byte total is the allocation volume the
  // enqueue path really produced.
  const snapshot = {
    files: [],
    toJSON() {
      serializations++
      const payload = { files: ['x'.repeat(PAYLOAD_CHARS)] }
      serializedChars += JSON.stringify(payload).length
      return payload
    },
  } as never

  for (let i = 0; i < N; i++) {
    void storage.recordFileHistorySnapshot(`message-${i}`, snapshot, false)
  }
  const atEnqueue = serializations
  const charsAtEnqueue = serializedChars
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
  // The resource claim, in bytes: allocation volume on the enqueue path must be
  // linear in what was enqueued. The old shape allocated the triangle number of
  // payloads - at this size ~20 MB for 200 enqueues, and GB at live queue depths.
  assert.ok(
    charsAtEnqueue <= 4 * N * PAYLOAD_CHARS,
    `enqueue must not allocate with queue depth; serialized ${charsAtEnqueue} bytes for ${N} enqueues (quadratic shape is ${Math.round((N * (N + 1) * PAYLOAD_CHARS) / 2)} bytes)`,
  )

  await close()
})

test('the queue gauges count the queue, not every entry ever enqueued', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'transcript-queue-drift-'))
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  try {
    const telemetry = await import('../src/utils/gatewayMemoryTelemetry.ts')
    const storage = await import('../src/utils/sessionStorage.ts')
    const close = await telemetry.startGatewayMemoryTelemetry(dir, 'fixture-build')
    assert.ok(close, 'telemetry must start')
    storage.resetProjectForTesting()
    storage.setSessionFileForTesting(join(dir, 'transcript.jsonl'))

    const snapshot = { files: ['x'.repeat(256)] } as never
    // Fill and drain a deep queue.
    for (let i = 0; i < N; i++) {
      void storage.recordFileHistorySnapshot(`m-${i}`, snapshot, false)
    }
    await new Promise(resolve => setTimeout(resolve, 250))

    // The gauges are published on enqueue (the moment the depth matters), so
    // this one entry is what makes the settled counter visible: it must read 1.
    // A counter that never decremented would publish N+1 here, and one that
    // never incremented would publish 0.
    void storage.recordFileHistorySnapshot('m-tail', snapshot, false)
    await close()

    const { readdir, readFile } = await import('node:fs/promises')
    const names = (await readdir(dir)).filter(name => name.endsWith('.jsonl'))
    const rows = (await readFile(join(dir, names[0]!), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const shutdown = rows.at(-1)
    assert.equal(shutdown.reason, 'shutdown')
    assert.equal(
      shutdown.caches.transcriptQueuedEntries,
      1,
      `a drained queue must not still count its old depth (got ${shutdown.caches.transcriptQueuedEntries}, deep batch was ${N})`,
    )
    const payloadChars = shutdown.caches.transcriptQueuedPayloadChars
    assert.ok(payloadChars > 0 && payloadChars < 400, `the payload gauge must track the queued entry, got ${payloadChars}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
