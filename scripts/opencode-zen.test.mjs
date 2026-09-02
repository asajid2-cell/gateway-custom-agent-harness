import { strict as assert } from 'node:assert'
import test from 'node:test'

import {
  OPENCODE_ZEN_ROUTES,
  openCodeZenEndpoint,
  openCodeZenHeaders,
  isOpenCodeZenProtocol,
} from './opencode-zen.mjs'


test('OpenCode Zen routes use the separate free-model endpoint', () => {
  assert.equal(openCodeZenEndpoint('chat-completions'), 'https://opencode.ai/zen/v1/chat/completions')
  assert.equal(openCodeZenEndpoint('responses'), 'https://opencode.ai/zen/v1/responses')
  assert.deepEqual(Object.keys(OPENCODE_ZEN_ROUTES), [
    'big-pickle',
    'mimo-v2.5-free',
    'hy3-free',
    'nemotron-3-ultra-free',
    'nemotron-3.5-lightning-free',
    'muse-spark-1.2-contributor-free',
  ])
})

test('OpenCode Zen headers use bearer authentication and requested response type', () => {
  assert.equal(openCodeZenHeaders('synthetic-key').authorization, 'Bearer synthetic-key')
  assert.equal(openCodeZenHeaders('synthetic-key').accept, 'application/json')
  assert.equal(openCodeZenHeaders('synthetic-key', true).accept, 'text/event-stream')
  assert.equal(isOpenCodeZenProtocol('responses'), true)
  assert.equal(isOpenCodeZenProtocol('chat-completions'), true)
  assert.equal(isOpenCodeZenProtocol('anthropic-messages'), false)
})

test('OpenCode Zen route model IDs remain distinct from Go routes', () => {
  assert.equal(Object.keys(OPENCODE_ZEN_ROUTES).some(model => model === 'glm-5.3-flash'), false)
})

export {}
