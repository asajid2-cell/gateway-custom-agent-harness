import assert from 'node:assert/strict'
import test from 'node:test'

import {
  COMMANDCODE_ROUTES,
  commandCodeEndpoint,
  commandCodeGatewayId,
  commandCodeHeaders,
} from './commandcode.mjs'
import { COMMANDCODE_EFFORT_LEVELS } from './effort-capabilities.mjs'

test('Command Code gateway ids are derived from the provider-native id', () => {
  assert.deepEqual(
    Object.keys(COMMANDCODE_ROUTES).map(commandCodeGatewayId),
    [
      'gateway-commandcode-deepseek-v4.1-flash',
      'gateway-commandcode-longcat-2.0-free',
      'gateway-commandcode-laguna-s-2.1-free',
      'gateway-commandcode-ling-3.0-flash-sante-free',
    ],
  )
  // The publisher prefix is dropped and punctuation that a Gateway id cannot
  // carry (`:`, `/`) collapses to `-`, lowercase.
  assert.equal(
    commandCodeGatewayId('meituan/LongCat-2.0:free'),
    'gateway-commandcode-longcat-2.0-free',
  )
})

test('every Command Code route speaks chat completions with Bearer auth', () => {
  for (const protocol of Object.values(COMMANDCODE_ROUTES)) {
    // The Anthropic Messages endpoint rejects these models by name, which is
    // why the provider module never routes them there.
    assert.equal(protocol, 'chat-completions')
  }
  assert.equal(
    commandCodeEndpoint(),
    'https://api.commandcode.ai/provider/v1/chat/completions',
  )
  const headers = commandCodeHeaders('secret-token', true)
  assert.equal(headers.authorization, 'Bearer secret-token')
  assert.equal(headers.accept, 'text/event-stream')
  assert.equal('x-api-key' in headers, false)
})

test('Command Code advertises the effort ladder upstream actually accepts', () => {
  // Probed live 2026-09-17 on all four routes: the endpoint validates
  // reasoning_effort against a closed enum and answers 400 for anything else
  // ("Invalid option: expected one of low|medium|high|xhigh|max"). An empty
  // ladder would under-report the model and, because the harness appends its
  // own `ultracode` control, leave the picker showing ultracode alone.
  assert.deepEqual(Object.values(COMMANDCODE_EFFORT_LEVELS), [
    ['low', 'medium', 'high', 'xhigh', 'max'],
    ['low', 'medium', 'high', 'xhigh', 'max'],
    ['low', 'medium', 'high', 'xhigh', 'max'],
    ['low', 'medium', 'high', 'xhigh', 'max'],
  ])
  // `none`/`minimal`/`ultra` are rejected by name, so they must not be offered.
  for (const levels of Object.values(COMMANDCODE_EFFORT_LEVELS)) {
    for (const unsupported of ['none', 'minimal', 'ultra']) {
      assert.equal(levels.includes(unsupported), false)
    }
  }
})
