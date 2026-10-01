import { strict as assert } from 'node:assert'
import test from 'node:test'

import {
  INITIAL_STATE,
  expectStandardCursorPosition,
  parseMultipleKeypresses,
} from '../src/ink/parse-keypress.ts'

/**
 * The inline mouse calibration probe (`calibrateInlineMouse`, ink.tsx) is a
 * cursor-position round trip: on Windows the app writes `CSI ?6n` and `CSI 6n`
 * together and the reply's row/col become the bounded block's origin.
 *
 * A relay/mux client strips the *plain* reply out of xterm's own onData but
 * lets the DEC-private form through. So the private reply is the one that has
 * to resolve the probe - if it did not, every session under that client would
 * time out, latch `inlineProbeFailed`, and lose both app-owned wheel scrolling
 * and the bottom bar until a resize or a leaf handoff forced a recalibration.
 * These cases pin that the private form is accepted, and that the plain form
 * is only accepted while the probe is actually waiting for it (otherwise
 * Shift+F3 would be swallowed as a response).
 */
function parse(input) {
  const [parsed] = parseMultipleKeypresses({ ...INITIAL_STATE }, input)
  return parsed
}

test('the DEC-private CPR a mux client preserves resolves as a cursor position', () => {
  const parsed = parse('\x1b[?2;1R')
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].kind, 'response')
  assert.deepEqual(parsed[0].response, { type: 'cursorPosition', row: 2, col: 1 })
})

test('the ConPTY page parameter on a private CPR is absorbed', () => {
  const parsed = parse('\x1b[?5;12;1R')
  assert.equal(parsed[0].kind, 'response')
  assert.deepEqual(parsed[0].response, { type: 'cursorPosition', row: 5, col: 12 })
})

test('the plain CPR the probe also sends is recognized while the probe waits', () => {
  expectStandardCursorPosition(true)
  try {
    const parsed = parse('\x1b[2;1R')
    assert.equal(parsed[0].kind, 'response')
    assert.deepEqual(parsed[0].response, { type: 'cursorPosition', row: 2, col: 1 })
  } finally {
    expectStandardCursorPosition(false)
  }
})

test('a plain CPR that collides with a function key stays a key when no probe waits', () => {
  // Shift+F3 is CSI 1;2 R - the one standard CPR shape a real key produces.
  const parsed = parse('\x1b[1;2R')
  assert.equal(parsed[0].kind, 'key')
})
