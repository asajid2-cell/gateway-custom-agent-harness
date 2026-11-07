import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  chatLabel,
  cleanTitle,
  titleFromSessionInfo,
} from '../src/utils/sessionTitles.ts'

// A chat name is decoration over a session id, and the id is the machine key.
// These are the rules that keep a name from hiding the key it belongs to.

test('a title is collapsed to one line and clipped, not dropped', () => {
  assert.equal(cleanTitle('  a\n  b\t c  '), 'a b c')
  assert.equal(cleanTitle(undefined), '')
  const long = 'x'.repeat(200)
  const clipped = cleanTitle(long)
  assert.equal(clipped.length, 72)
  assert.ok(clipped.endsWith('…'), 'a shortened title is visibly shortened')
})

test('the name falls back in the order the CLI already uses', () => {
  const base = { sessionId: 's', summary: '', lastModified: 0 }
  assert.equal(
    titleFromSessionInfo({ ...base, customTitle: 'mine', summary: 'auto', firstPrompt: 'first' }),
    'mine',
  )
  assert.equal(
    titleFromSessionInfo({ ...base, summary: 'auto', firstPrompt: 'first' }),
    'auto',
  )
  assert.equal(titleFromSessionInfo({ ...base, firstPrompt: 'first' }), 'first')
  assert.equal(titleFromSessionInfo(base), '')
})

test('a chat label keeps the short id even when a name exists', () => {
  const titles = new Map([['cb41b4cd-466e-4b69-bf9c-410eddc6e812', 'Queue work']])
  // Two chats can share a name, and --session takes the id, so the id is never
  // hidden behind the name.
  assert.equal(chatLabel('cb41b4cd-466e-4b69-bf9c-410eddc6e812', titles), 'Queue work (cb41b4cd)')
  assert.equal(chatLabel('deadbeef-0000-0000-0000-000000000000', titles), 'deadbeef')
  assert.equal(
    chatLabel('cb41b4cd-466e-4b69-bf9c-410eddc6e812', titles, 4),
    'Que… (cb41b4cd)',
  )
})
