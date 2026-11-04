import assert from 'node:assert/strict'
import test from 'node:test'
import { isModifierPressed } from './modifiers.js'

const realPlatform = process.platform

function asPlatform<T>(value: string, run: () => T): T {
  Object.defineProperty(process, 'platform', { value, configurable: true })
  try {
    return run()
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
  }
}

test('a platform without the native module reports no modifier', () => {
  assert.equal(asPlatform('linux', () => isModifierPressed('shift')), false)
})

test('darwin degrades to no modifier when the module is absent or a stub', () => {
  // The build materializes a stub exporting an object, and a packaged macOS
  // build may carry no module at all. Neither may throw at the input path.
  assert.equal(asPlatform('darwin', () => isModifierPressed('shift')), false)
})
