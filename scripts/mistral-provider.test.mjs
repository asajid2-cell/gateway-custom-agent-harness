import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MISTRAL_ROUTES,
  anthropicToMistralChat,
  mistralEndpoint,
  mistralGatewayId,
  mistralHeaders,
} from './mistral.mjs'
import {
  MISTRAL_EFFORT_LEVELS,
  GATEWAY_MODEL_ALIAS_MAP,
  GATEWAY_MODEL_OPTIONS,
} from './effort-capabilities.mjs'
import { relayOpenCodeChatResponse } from './opencode-go.mjs'
import { mistralCredentialPool } from './model-gateway.mjs'
import { envVarForRecord } from './keysafe-vault.mjs'
import { listKeysafeProviders } from './gateway-keysafe.mjs'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function fakeResponse() {
  return {
    headersSent: false,
    statusCode: 200,
    writableEnded: false,
    destroyed: false,
    body: '',
    writeHead(status) { this.statusCode = status; this.headersSent = true },
    write(chunk) { this.body += String(chunk); return true },
    end(chunk) { if (chunk !== undefined) this.body += String(chunk); this.writableEnded = true },
    destroy() { this.destroyed = true },
  }
}

test('Mistral routes carry the provider-native id and a friendly Gateway id', () => {
  assert.deepEqual(Object.keys(MISTRAL_ROUTES), ['deepseek-v4-1-flash-1017'])
  assert.equal(
    mistralGatewayId('deepseek-v4-1-flash-1017'),
    'gateway-mistral-deepseek-v4.1-flash',
  )
  // An unrouted model still gets a deterministic, readable id.
  assert.equal(
    mistralGatewayId('Mistral-Large-4'),
    'gateway-mistral-mistral-large-4',
  )
})

test('Mistral speaks OpenAI chat completions with Bearer auth', () => {
  assert.equal(
    mistralEndpoint(),
    'https://api.mistral.ai/v1/chat/completions',
  )
  const headers = mistralHeaders('secret-token', true)
  assert.equal(headers.authorization, 'Bearer secret-token')
  assert.equal(headers.accept, 'text/event-stream')
  assert.equal('x-api-key' in headers, false)
})

test('Mistral advertises the closed reasoning_effort enum it validates', () => {
  // Probed live 2026-11-04: the API validates the generic enum, but this model
  // answers 400 naming its own subset - no `minimal`, no `medium`.
  assert.deepEqual(MISTRAL_EFFORT_LEVELS['deepseek-v4-1-flash-1017'], [
    'none',
    'low',
    'high',
    'xhigh',
    'max',
  ])
})

test('the Mistral route is a first-class picker entry with aliases', () => {
  const id = 'gateway-mistral-deepseek-v4.1-flash'
  assert.ok(GATEWAY_MODEL_OPTIONS.some(option => option.value === id))
  assert.deepEqual(GATEWAY_MODEL_ALIAS_MAP['mistral/deepseek-v4-1-flash-1017'], id)
  assert.deepEqual(GATEWAY_MODEL_ALIAS_MAP['mistral-deepseek-v4-1-flash-1017'], id)
  assert.deepEqual(GATEWAY_MODEL_ALIAS_MAP['mistral-deepseek-v4.1-flash'], id)
})

test('assistant reasoning is echoed as a thinking block, never reasoning_content', () => {
  const request = anthropicToMistralChat(
    {
      system: 'sys',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'because' },
            { type: 'text', text: 'the answer' },
          ],
        },
        { role: 'user', content: 'next' },
      ],
      output_config: { effort: 'high' },
      stream: false,
    },
    'deepseek-v4-1-flash-1017',
    '',
  )
  const assistant = request.messages.find(message => message.role === 'assistant')
  assert.deepEqual(assistant.content, [
    { type: 'thinking', thinking: [{ type: 'text', text: 'because' }], closed: true },
    { type: 'text', text: 'the answer' },
  ])
  assert.equal('reasoning_content' in assistant, false)
  assert.equal(request.model, 'deepseek-v4-1-flash-1017')
  assert.equal(request.reasoning_effort, 'high')
})

test('Mistral multi-key pool rotates and promotes a key added mid-cycle', () => {
  const env = { MISTRAL_API_KEY: 'key-one', MISTRAL_API_KEY2: 'key-two' }
  const pool = mistralCredentialPool(env)
  assert.deepEqual(pool.numbers, [1, 2])
  assert.equal(pool.key, 'key-one')
  pool.advance()
  assert.equal(pool.key, 'key-two')
  pool.advance()
  assert.equal(pool.key, 'key-one')

  // A numbered key that appears after the pool was built is tried next and
  // twice before rotation resumes, the same promotion contract as OpenCode and
  // Command Code.
  const late = { MISTRAL_API_KEY: 'key-one' }
  const live = mistralCredentialPool(late)
  assert.equal(live.key, 'key-one')
  late.MISTRAL_API_KEY3 = 'key-three'
  assert.equal(live.key, 'key-three')
  assert.equal(live.pending?.number, 3)
  live.advance()
  assert.equal(live.key, 'key-three')
  live.advance()
  assert.equal(live.key, 'key-one')
})

test('Mistral records map to numbered environment slots', () => {
  assert.equal(envVarForRecord('mistral'), 'MISTRAL_API_KEY')
  assert.equal(envVarForRecord('mistral2'), 'MISTRAL_API_KEY2')
  assert.equal(envVarForRecord('mistral9'), 'MISTRAL_API_KEY9')
  assert.equal(envVarForRecord('mistral1'), null)
})

test('the keysafe chain injects every Mistral record', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mistral-keysafe-'))
  const vault = join(home, '.keysafe')
  await mkdir(vault)
  for (const name of ['mistral.cred', 'mistral2.cred', 'mistral3.cred', 'ds.cred']) {
    await writeFile(join(vault, name), '')
  }
  const providers = listKeysafeProviders(home).filter(entry => entry.envVar.startsWith('MISTRAL'))
  assert.deepEqual(providers, [
    { credential: 'mistral', envVar: 'MISTRAL_API_KEY' },
    { credential: 'mistral2', envVar: 'MISTRAL_API_KEY2' },
    { credential: 'mistral3', envVar: 'MISTRAL_API_KEY3' },
  ])
})

test('a reasoning reply sent as content blocks keeps thinking and text', async () => {
  const upstream = new Response(JSON.stringify({
    id: 'cmpl_1',
    model: 'deepseek-v4-1-flash-1017',
    choices: [{
      finish_reason: 'stop',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: [{ type: 'text', text: 'why' }], closed: true },
          { type: 'text', text: '391' },
        ],
      },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
  const res = fakeResponse()
  await relayOpenCodeChatResponse(res, upstream, 'gateway-mistral-deepseek-v4.1-flash')
  const message = JSON.parse(res.body)
  assert.deepEqual(message.content, [
    { type: 'thinking', thinking: 'why' },
    { type: 'text', text: '391' },
  ])
  assert.equal(message.stop_reason, 'end_turn')
})
