import { strict as assert } from 'node:assert'
import test from 'node:test'

import {
  OPENCODE_ZEN_ROUTES,
  openCodeZenEndpoint,
  openCodeZenHeaders,
  isOpenCodeZenProtocol,
  isOpenCodeZenSessionId,
  mintOpenCodeZenSessionId,
  ensureOpenCodeZenReadTool,
} from './opencode-zen.mjs'


test('OpenCode Zen routes use the separate free-model endpoint', () => {
  assert.equal(openCodeZenEndpoint('chat-completions'), 'https://opencode.ai/zen/v1/chat/completions')
  assert.equal(openCodeZenEndpoint('responses'), 'https://opencode.ai/zen/v1/responses')
  assert.deepEqual(Object.keys(OPENCODE_ZEN_ROUTES), [
    'big-pickle',
    'beam-free',
    'll-alpha-free',
    'mimo-v2.6-flash-free',
    'muse-spark-1.2-contributor-free',
    'muse-spark-1.3-contributor-free',
    'nemotron-3.5-super-vl-free',
    'nemotron-3.5-lightning-free',
    'longcat-2.5-preview-free',
    'deepseek-v4.1-flash-free',
    'glm-5.3-flash-free',
    'space-bunny-free',
  ])
})

test('the Zen client fingerprint adds a lowercase read tool when missing', () => {
  const chat = { tools: [{ type: 'function', function: { name: 'Read' } }] }
  const withRead = ensureOpenCodeZenReadTool(chat, 'chat-completions')
  assert.equal(withRead.tools.length, 2)
  assert.equal(withRead.tools[1].type, 'function')
  assert.equal(withRead.tools[1].function.name, 'read')
  assert.equal(withRead.tools[0].function.name, 'Read')

  // The fingerprint is name presence: a request that already carries `read` is
  // returned untouched, so no duplicate is appended.
  const already = { tools: [{ type: 'function', function: { name: 'read' } }] }
  assert.equal(ensureOpenCodeZenReadTool(already, 'chat-completions'), already)

  // The name is required by the fingerprint, so it is added even when the
  // caller sent no tools at all - a request without it is refused outright.
  assert.equal(ensureOpenCodeZenReadTool({ tools: [] }, 'chat-completions').tools.length, 1)
  assert.equal(ensureOpenCodeZenReadTool({}, 'chat-completions').tools[0].function.name, 'read')
  // A route declared incapable of tools is left alone, since sending one would
  // contradict the capability the caller's tools were already stripped against.
  assert.deepEqual(ensureOpenCodeZenReadTool({}, 'chat-completions', false), {})

  // The responses protocol declares tools flat instead of under `function`.
  const responses = ensureOpenCodeZenReadTool(
    { tools: [{ type: 'function', name: 'Read' }] },
    'responses',
  )
  assert.equal(responses.tools[1].name, 'read')
  assert.equal(responses.tools[1].function, undefined)
})

test('OpenCode Zen headers use bearer authentication and requested response type', () => {
  assert.equal(openCodeZenHeaders('synthetic-key').authorization, 'Bearer synthetic-key')
  assert.equal(openCodeZenHeaders('synthetic-key').accept, 'application/json')
  assert.equal(openCodeZenHeaders('synthetic-key', true).accept, 'text/event-stream')
  assert.equal(isOpenCodeZenProtocol('responses'), true)
  assert.equal(isOpenCodeZenProtocol('chat-completions'), true)
  assert.equal(isOpenCodeZenProtocol('anthropic-messages'), false)
})

test('OpenCode Zen presents the harness agent and a session the free tier accepts', () => {
  const headers = openCodeZenHeaders('synthetic-key')
  // The free tier answers 426 below 1.18.0 and 403 for any other agent.
  assert.equal(headers['user-agent'], 'opencode/1.18.31')
  assert.equal(isOpenCodeZenSessionId(headers['x-opencode-session']), true)
})

test('the session id passes through when it conforms and is minted when it does not', () => {
  const real = 'ses_eba07c2f6ffehMsa2VeZgaZmlr'
  assert.equal(openCodeZenHeaders('k', false, real)['x-opencode-session'], real)

  // A Claude session id is not a Zen session id, so one is derived from it.
  const derived = openCodeZenHeaders('k', false, '6e54a075-82e2-4cf2-a496-510cd27ef459')
  assert.notEqual(derived['x-opencode-session'], '6e54a075-82e2-4cf2-a496-510cd27ef459')
  assert.equal(isOpenCodeZenSessionId(derived['x-opencode-session']), true)

  // Derivation is stable, so a conversation keeps one prompt-cache namespace
  // across every request and every retry of one request.
  assert.equal(
    mintOpenCodeZenSessionId('conversation'),
    mintOpenCodeZenSessionId('conversation'),
  )
  assert.notEqual(mintOpenCodeZenSessionId('a'), mintOpenCodeZenSessionId('b'))
})

test('minted session ids carry the shape the free tier reads', () => {
  assert.equal(isOpenCodeZenSessionId('ses_ffffffffffffffffffffffffff'), true)
  for (let i = 0; i < 200; i++) {
    const id = mintOpenCodeZenSessionId(`seed-${i}`)
    assert.equal(isOpenCodeZenSessionId(id), true)
    assert.equal(id.length, 30)
    assert.equal(id.slice(4, 16), id.slice(4, 16).toLowerCase())
    assert.equal(id[13], 'f')
    assert.equal('cdef'.includes(id[14]), true)
  }

  // The two fixed nibbles are load-bearing: a well-formed id whose tenth
  // character is not `f`, or whose eleventh is outside `cdef`, is refused.
  assert.equal(isOpenCodeZenSessionId(`ses_${'a'.repeat(9)}ef${'a'.repeat(15)}`), false)
  assert.equal(isOpenCodeZenSessionId(`ses_${'a'.repeat(9)}fb${'a'.repeat(15)}`), false)
  // So is a missing session, a short one, and one with a non-hex head.
  assert.equal(isOpenCodeZenSessionId(''), false)
  assert.equal(isOpenCodeZenSessionId(`ses_${'f'.repeat(25)}`), false)
  assert.equal(isOpenCodeZenSessionId(`ses_${'z'.repeat(9)}fc${'a'.repeat(15)}`), false)
})

test('OpenCode Zen route model IDs remain distinct from Go routes', () => {
  assert.equal(Object.keys(OPENCODE_ZEN_ROUTES).some(model => model === 'glm-5.3-flash'), false)
})

export {}
