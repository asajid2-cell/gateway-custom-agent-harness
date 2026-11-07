/**
 * The answer must descend from the user node this send created.
 *
 * Measured 2026-11-07: a bridge whose primer was still finishing answered its
 * first inbound with the primer's own acknowledgement, because the newest
 * assistant node in the thread was the primer's. These rows pin the pure
 * predicate that refuses that, and the two-turn case that must keep working.
 */
import { describe, expect, test } from 'bun:test'
import os from 'node:os'
import path from 'node:path'

// The driver refuses to load without a profile, and its CLI entry only runs
// when it IS the main module. Point it at a scratch profile and import seams.
process.env.CHATGPT_PROFILE ||= path.join(os.tmpdir(), 'attribution-fixture-profile')
const { answerBelongs, sendUserIdOf } = await import('./chatgpt.mjs')

const PRIMER = 'I understand the session bus protocol and will follow its memory.'
const T1 = 'INBOUND from another live session on the bus.\n\n--- text ---\nReply with the single word: s1t1'
const A1 = 's1t1'
const T2 = 'INBOUND from another live session on the bus.\n\n--- text ---\nReply with the single word: s1t2'
const A2 = 's1t2'

const thread = () => ([
  { role: 'user', id: 'u-primer', text: PRIMER },
  { role: 'assistant', id: 'a-primer', text: 'Understood. I will follow the bus protocol exactly.' },
])

describe('sendUserIdOf', () => {
  test('reads the id the app mints into messages[0].id', () => {
    expect(sendUserIdOf(JSON.stringify({ action: 'next', messages: [{ id: 'u-123', content: { parts: ['hi'] } }] }))).toBe('u-123')
  })

  test('junk, empty or a missing id is null, never a guess', () => {
    expect(sendUserIdOf('')).toBeNull()
    expect(sendUserIdOf('not json')).toBeNull()
    expect(sendUserIdOf(JSON.stringify({ messages: [] }))).toBeNull()
    expect(sendUserIdOf(JSON.stringify({ messages: [{ content: {} }] }))).toBeNull()
    expect(sendUserIdOf(JSON.stringify({ messages: [{ id: 7 }] }))).toBeNull()
  })
})

describe('answerBelongs', () => {
  test('the primer finishing after t1 was posted is not t1\'s answer', () => {
    const rows = [...thread(), { role: 'user', id: 'u-t1', text: T1 }]
    expect(answerBelongs(rows, 'Understood. I will follow the bus protocol exactly.', T1, 'u-t1').proven).toBe(false)
  })

  test('t1\'s own answer, later in the same thread, is t1\'s', () => {
    const rows = [...thread(), { role: 'user', id: 'u-t1', text: T1 }, { role: 'assistant', id: 'a-t1', text: A1 }]
    expect(answerBelongs(rows, A1, T1, 'u-t1')).toEqual({ proven: true, why: 'the reply asks after user node u-t1' })
    // And the primer answer is still refused with the same rows present.
    expect(answerBelongs(rows, 'Understood. I will follow the bus protocol exactly.', T1, 'u-t1').proven).toBe(false)
  })

  test('two sequential turns each answer their own asker, even if turn 1 was still streaming when turn 2 posted', () => {
    const rows = [
      ...thread(),
      { role: 'user', id: 'u-t1', text: T1 }, { role: 'assistant', id: 'a-t1', text: A1 },
      { role: 'user', id: 'u-t2', text: T2 }, { role: 'assistant', id: 'a-t2', text: A2 },
    ]
    expect(answerBelongs(rows, A1, T1, 'u-t1').proven).toBe(true)
    expect(answerBelongs(rows, A2, T2, 'u-t2').proven).toBe(true)
    // The answer to t1 must not be delivered as t2's.
    expect(answerBelongs(rows, A1, T2, 'u-t2').proven).toBe(false)
  })

  test('without a captured id the asker text alone proves it, and only when it matches', () => {
    const rows = [...thread(), { role: 'user', id: 'u-t1', text: T1 }, { role: 'assistant', id: 'a-t1', text: A1 }]
    expect(answerBelongs(rows, A1, T1, '').proven).toBe(true)
    expect(answerBelongs(rows, A1, T2, '').proven).toBe(false)
  })

  test('a reply whose node is not rendered is never accepted', () => {
    expect(answerBelongs(thread(), 'an answer no node carries', T1, 'u-t1').proven).toBe(false)
  })
})
