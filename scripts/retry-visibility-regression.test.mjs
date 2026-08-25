import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const component = await readFile(
  new URL('../src/components/messages/SystemAPIErrorMessage.tsx', import.meta.url),
  'utf8',
)
const errorUtils = await readFile(
  new URL('../src/services/api/errorUtils.ts', import.meta.url),
  'utf8',
)

test('connection retry messages are visible before the ordinary retry threshold', () => {
  assert.match(component, /isAPIConnectionError\(error\)/)
  assert.match(
    component,
    /const hidden = !isAPIConnectionError\(error\) && retryAttempt < 4/,
  )
})

test('connection classification covers live and resumed error shapes', () => {
  assert.match(errorUtils, /error instanceof APIConnectionError/)
  assert.match(errorUtils, /candidate\.message === 'Connection error\.'/)
  assert.match(errorUtils, /details\?\.code === 'ECONNREFUSED'/)
  assert.match(errorUtils, /details\?\.code === 'ECONNRESET'/)
  assert.match(errorUtils, /details\?\.code === 'EPIPE'/)
})
