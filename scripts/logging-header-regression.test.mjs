import assert from 'node:assert/strict'
import test from 'node:test'
import { getHeaderNames } from '../src/utils/httpHeaders.ts'

test('normalizes Fetch Headers without throwing', () => {
  assert.deepEqual(
    getHeaderNames(new Headers({ 'X-Gateway': 'opencode' })),
    ['x-gateway'],
  )
})

test('normalizes iterable SDK header objects', () => {
  assert.deepEqual(
    getHeaderNames({
      entries: () => [['X-Request-ID', 'request-1'], ['Retry-After', '1']],
    }),
    ['x-request-id', 'retry-after'],
  )
})

test('normalizes arrays and plain objects', () => {
  assert.deepEqual(
    getHeaderNames([['X-One', '1'], ['X-Two', '2']]),
    ['x-one', 'x-two'],
  )
  assert.deepEqual(
    getHeaderNames({ 'X-One': '1', 'X-Two': '2' }),
    ['x-one', 'x-two'],
  )
})

test('ignores malformed header metadata instead of throwing', () => {
  assert.deepEqual(getHeaderNames({ forEach: undefined }), ['foreach'])
  assert.deepEqual(
    getHeaderNames({
      forEach() {
        throw new Error('malformed header object')
      },
    }),
    [],
  )
  assert.deepEqual(getHeaderNames('not headers'), [])
})
