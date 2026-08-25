import assert from 'node:assert/strict'
import test from 'node:test'
import { appendCompactBoundary } from '../src/utils/compactView.ts'

function user(uuid, text) {
  return {
    type: 'user',
    uuid,
    isMeta: false,
    message: { role: 'user', content: text },
  }
}

function boundary(uuid) {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    uuid,
    content: 'Conversation compacted',
    isMeta: false,
    timestamp: new Date(0).toISOString(),
    level: 'info',
    compactMetadata: { trigger: 'auto', preTokens: 100 },
  }
}

test('compaction appends a boundary without replacing the active session history', () => {
  const before = [user('u1', 'first'), user('u2', 'second')]
  const after = appendCompactBoundary(before, boundary('b1'))

  assert.deepEqual(after.map(message => message.uuid), ['u1', 'u2', 'b1'])
  assert.deepEqual(before.map(message => message.uuid), ['u1', 'u2'])
})

test('repeated compaction retains every boundary and historical message', () => {
  const previousBoundary = boundary('b1')
  const before = [
    previousBoundary,
    user('u2', 'post-compact work'),
    user('u3', 'more work'),
  ]
  const after = appendCompactBoundary(before, boundary('b2'))

  assert.deepEqual(after.map(message => message.uuid), ['b1', 'u2', 'u3', 'b2'])
  assert.equal(after[0], previousBoundary)
})
