import { strict as assert } from 'node:assert'
import test from 'node:test'
import { detectGateway } from '../src/services/api/logging.ts'

test('gateway error logging accepts Fetch Headers and plain header records', () => {
  assert.equal(
    detectGateway({
      headers: new Headers({ 'x-litellm-call-id': 'synthetic' }),
    }),
    'litellm',
  )
  assert.equal(
    detectGateway({
      headers: { 'X-LiteLLM-Call-ID': 'synthetic' },
    }),
    'litellm',
  )
  assert.doesNotThrow(() => {
    detectGateway({ headers: { 'content-type': 'application/json' } })
  })
})
