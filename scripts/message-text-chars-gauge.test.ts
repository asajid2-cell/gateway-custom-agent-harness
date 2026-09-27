// The messageTextChars gauge must not re-walk settled messages.
//
// recordMessageGauges runs from the useLogMessages effect on every messages
// change (~20x/turn). It used to walk the whole message object graph each time,
// which measured at ~30ms per walk and ~600ms per turn on a 40k-message
// session - blocked event loop for a diagnostic, which also delayed the
// transcript queue drain. The incremental helper keeps a running total and only
// re-measures the streaming tail.
//
// Two things are pinned here: the value stays exactly what a full walk reports
// across append, tail growth, shrink and compaction, and the work per call is
// proportional to what changed, not to the session size.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  messageTextCharsIncremental,
  type MessageTextCharsState,
} from '../src/hooks/useLogMessages.ts'

type Probe = { visited: number; messages: unknown[] }

// A message whose nested content is an enumerable getter, so counting getter
// invocations counts how many messages a call actually walked.
function probe(): Probe {
  return { visited: 0, messages: [] }
}

function message(probe: Probe, uuid: string, text: string) {
  const msg: Record<string, unknown> = { uuid, sessionId: 's', type: 'user' }
  // Enumerable getter: Object.values(message) invokes it exactly once per walk.
  Object.defineProperty(msg, 'message', {
    enumerable: true,
    configurable: true,
    get() {
      probe.visited++
      return { role: 'user', content: [{ type: 'text', text }] }
    },
  })
  probe.messages.push(msg)
  return msg as never
}

// The value a full walk would report, for comparison.
function fullWalk(messages: unknown[]): number {
  let chars = 0
  const seen = new WeakSet<object>()
  const walk = (v: unknown): number => {
    if (typeof v === 'string') return v.length
    if (typeof v !== 'object' || v === null) return 0
    if (seen.has(v)) return 0
    seen.add(v)
    let c = 0
    for (const child of Object.values(v as object)) c += walk(child)
    return c
  }
  for (const m of messages) chars += walk(m)
  return chars
}

test('the incremental gauge matches a full walk and only measures what changed', () => {
  const p = probe()
  const text = 'z'.repeat(500)
  for (let i = 0; i < 2000; i++) message(p, `uuid-${i}`, text)

  let state: MessageTextCharsState = { settledCount: 0, settledChars: 0, firstUuid: undefined }
  const measure = (messages: unknown[]) => {
    const before = p.visited
    const out = messageTextCharsIncremental(state, messages as never)
    state = out.state
    return { chars: out.chars, walked: p.visited - before }
  }

  // First call: nothing is settled yet, so it must walk everything.
  const first = measure(p.messages)
  assert.equal(first.chars, fullWalk(p.messages), 'first measurement must match a full walk')
  assert.ok(first.walked >= 2000, `first call settles the array; walked ${first.walked}`)

  // The hot case: the same array again (a re-render, no new message). Only the
  // tail may be re-measured.
  const repeat = measure(p.messages)
  assert.equal(repeat.chars, fullWalk(p.messages), 'repeat measurement must match a full walk')
  assert.ok(repeat.walked <= 3, `an unchanged array must not be re-walked; walked ${repeat.walked}`)

  // Append: the old tail becomes final, one new message streams.
  message(p, 'uuid-2000', text)
  const appended = measure(p.messages)
  assert.equal(appended.chars, fullWalk(p.messages), 'append must match a full walk')
  assert.ok(appended.walked <= 4, `append must walk the delta only; walked ${appended.walked}`)

  // Streaming tail growth: the last message's text keeps changing. The tail is
  // re-measured every call, so the value must follow it.
  const grown = 'z'.repeat(900)
  Object.defineProperty(p.messages[2000]!, 'message', {
    enumerable: true,
    configurable: true,
    get() {
      p.visited++
      return { role: 'user', content: [{ type: 'text', text: grown }] }
    },
  })
  const streaming = measure(p.messages)
  assert.equal(streaming.chars, fullWalk(p.messages), 'tail growth must be picked up')
  assert.ok(streaming.walked <= 3, `tail growth walks the tail only; walked ${streaming.walked}`)

  // Same-head shrink (tombstone/rewind): the settled prefix reaches past the
  // new tail, so the running total must be rebuilt, not trusted.
  p.messages.length = 1500
  const shrunk = measure(p.messages)
  assert.equal(shrunk.chars, fullWalk(p.messages), 'shrink must be recomputed, not trusted')

  // Compaction: a new head uuid replaces the array.
  const compacted: unknown[] = []
  const p2 = probe()
  for (let i = 0; i < 10; i++) compacted.push(message(p2, `cb-${i}`, text))
  const rebuilt = messageTextCharsIncremental(state, compacted as never)
  assert.equal(rebuilt.chars, fullWalk(compacted), 'compaction must be recomputed')

  // Empty array.
  const empty = messageTextCharsIncremental(rebuilt.state, [] as never)
  assert.equal(empty.chars, 0, 'an empty array has no text chars')
})
