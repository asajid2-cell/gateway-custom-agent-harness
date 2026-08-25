import assert from 'node:assert/strict'
import test from 'node:test'
import {
  resolveKey,
  resolveKeyWithChordState,
} from '../src/keybindings/resolver.ts'

function key(overrides = {}) {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    wheelUp: false,
    wheelDown: false,
    home: false,
    end: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    fn: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    super: false,
    ...overrides,
  }
}

function binding(context, keyName, action) {
  return {
    context,
    action,
    chord: [
      {
        key: keyName,
        ctrl: false,
        alt: false,
        shift: false,
        meta: false,
        super: false,
      },
    ],
  }
}

const bindings = [
  binding('MessageSelector', 'enter', 'messageSelector:select'),
  binding('MessageSelector', 'down', 'messageSelector:down'),
  binding('Chat', 'enter', 'chat:submit'),
  binding('Chat', 'down', 'history:next'),
]

test('active modal context wins over global chat bindings', () => {
  assert.deepEqual(
    resolveKey('', key({ return: true }), ['MessageSelector', 'Chat', 'Global'], bindings),
    { type: 'match', action: 'messageSelector:select' },
  )
  assert.deepEqual(
    resolveKey('', key({ downArrow: true }), ['MessageSelector', 'Chat', 'Global'], bindings),
    { type: 'match', action: 'messageSelector:down' },
  )
})

test('chord-aware resolution also preserves active modal priority', () => {
  assert.deepEqual(
    resolveKeyWithChordState('', key({ return: true }), ['MessageSelector', 'Chat', 'Global'], bindings, null),
    { type: 'match', action: 'messageSelector:select' },
  )
  assert.deepEqual(
    resolveKeyWithChordState('', key({ downArrow: true }), ['MessageSelector', 'Chat', 'Global'], bindings, null),
    { type: 'match', action: 'messageSelector:down' },
  )
})
