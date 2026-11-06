import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MISTRAL_MAX_IMAGES,
  MISTRAL_ROUTES,
  anthropicToMistralChat,
  capMistralImages,
  mistralEndpoint,
  mistralGatewayId,
  mistralHeaders,
  mistralRouteVariants,
} from './mistral.mjs'
import {
  MISTRAL_EFFORT_LEVELS,
  GATEWAY_MODEL_ALIAS_MAP,
  GATEWAY_MODEL_OPTIONS,
} from './effort-capabilities.mjs'
import { relayOpenCodeChatResponse } from './opencode-go.mjs'
import { getGatewayModelContextWindow } from '../src/utils/model/gatewayModelIds.ts'
import {
  createMistralRouteCredentials,
  mistralCredentialPool,
  mistralVibeCredentialPool,
} from './model-gateway.mjs'
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

test('Mistral Vibe and Studio are separate picker entries', () => {
  const vibe = 'gateway-mistral-vibe-deepseek-v4.1-flash'
  const api = 'gateway-mistral-api-deepseek-v4.1-flash'
  assert.ok(GATEWAY_MODEL_OPTIONS.some(option => option.value === vibe))
  assert.ok(GATEWAY_MODEL_OPTIONS.some(option => option.value === api))
  // The unsuffixed id is a legacy alias of the Vibe route, not a second picker
  // entry; existing transcripts spend the same budget they did before.
  assert.equal(
    GATEWAY_MODEL_OPTIONS.some(
      option => option.value === 'gateway-mistral-deepseek-v4.1-flash',
    ),
    false,
  )
  assert.deepEqual(GATEWAY_MODEL_ALIAS_MAP['mistral/deepseek-v4-1-flash-1017'], vibe)
  assert.deepEqual(GATEWAY_MODEL_ALIAS_MAP['mistral-deepseek-v4-1-flash-1017'], vibe)
  assert.deepEqual(GATEWAY_MODEL_ALIAS_MAP['mistral-deepseek-v4.1-flash'], vibe)
  assert.deepEqual(
    GATEWAY_MODEL_ALIAS_MAP['mistral-api/deepseek-v4-1-flash-1017'],
    api,
  )
})

test('each Mistral route carries its own accounting window', () => {
  // The Vibe plan is accounted at 480k; the Studio route gets the model's full
  // 1M. Auto-compaction derives its trigger from these windows, so the two
  // routes compact at the same default fraction as every other route.
  assert.equal(
    getGatewayModelContextWindow('gateway-mistral-vibe-deepseek-v4.1-flash'),
    480_000,
  )
  assert.equal(
    getGatewayModelContextWindow('gateway-mistral-api-deepseek-v4.1-flash'),
    1_048_576,
  )
})

test('one provider model yields Vibe, API and legacy routes', () => {
  assert.deepEqual(mistralRouteVariants('deepseek-v4-1-flash-1017'), [
    { id: 'gateway-mistral-vibe-deepseek-v4.1-flash', credential: 'vibe' },
    { id: 'gateway-mistral-api-deepseek-v4.1-flash', credential: 'api' },
    { id: 'gateway-mistral-deepseek-v4.1-flash', credential: 'auto' },
  ])
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

test('a request with more than 20 images drops the oldest, not the newest', () => {
  // Probed live 2026-11-06: the API answers 20 images, and 21 images with
  // HTTP 503 "Service unavailable" at any payload size. A harness history that
  // accumulates screenshots therefore bricks the route once it holds 21 - the
  // condition has to be handled at the translation boundary.
  assert.equal(MISTRAL_MAX_IMAGES, 20)
  const image = () => ({
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
  })
  const messages = [{ role: 'user', content: [image()] }]
  for (let i = 1; i < 21; i += 1) {
    messages.push({ role: 'user', content: [image()] })
    messages[0].content.push({ type: 'text', text: `turn ${i}` })
  }
  const request = anthropicToMistralChat(
    { messages, max_tokens: 16, stream: false },
    'deepseek-v4-1-flash-1017',
    '',
  )
  const images = request.messages.flatMap(message =>
    Array.isArray(message.content)
      ? message.content.filter(block => block.type === 'image_url')
      : [],
  )
  assert.equal(images.length, 20)
  // The first turn's image is the one that became a marker; the rest of its
  // content, and every later image, is untouched.
  const first = request.messages[1].content
  assert.equal(first[0].type, 'text')
  assert.match(first[0].text, /at most 20 images/)
  assert.equal(first[1].text, 'turn 1')
  assert.equal(request.messages.at(-1).content[0].type, 'image_url')
})

test('exactly 20 images are left alone', () => {
  const request = {
    messages: [{
      role: 'user',
      content: Array.from({ length: 20 }, () => ({
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' },
      })),
    }],
  }
  assert.equal(capMistralImages(request), request)
})

test('an image inside a tool result counts toward the cap', () => {
  // Tool-result images are hoisted into their own user message by the shared
  // converter, so the cap has to run after conversion, where they are
  // ordinary image_url blocks.
  const imageBlock = {
    type: 'tool_result',
    tool_use_id: 't',
    content: [{
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
    }],
  }
  const messages = [{ role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] }]
  messages.push({ role: 'user', content: [imageBlock] })
  for (let i = 0; i < 20; i += 1) messages.push({ role: 'user', content: [imageBlock] })
  const request = anthropicToMistralChat({ messages, max_tokens: 16, stream: false }, 'deepseek-v4-1-flash-1017', '')
  const count = request.messages.flatMap(message =>
    Array.isArray(message.content) ? message.content.filter(block => block.type === 'image_url') : [],
  ).length
  assert.equal(count, 20)
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
  // Vibe plan keys are a separate credential type, not a Mistral API slot.
  // `mistralvibe` is the console spelling; the hyphenated form also resolves.
  assert.equal(envVarForRecord('mistralvibe'), 'MISTRAL_VIBE_KEY')
  assert.equal(envVarForRecord('mistralvibe3'), 'MISTRAL_VIBE_KEY3')
  assert.equal(envVarForRecord('mistral-vibe'), 'MISTRAL_VIBE_KEY')
  assert.equal(envVarForRecord('mistral-vibe3'), 'MISTRAL_VIBE_KEY3')
  assert.equal(envVarForRecord('mistralvibe1'), null)
})

test('Vibe keys are spent before Studio keys and never revisited after failure', () => {
  const vibe = mistralVibeCredentialPool({
    MISTRAL_VIBE_KEY: 'vibe-one',
    MISTRAL_VIBE_KEY2: 'vibe-two',
  })
  const api = mistralCredentialPool({
    MISTRAL_API_KEY: 'api-one',
    MISTRAL_API_KEY2: 'api-two',
  })
  const failed = new Set()
  const credentials = createMistralRouteCredentials(vibe, api, failed)

  assert.equal(credentials.key, 'vibe-one')
  assert.equal(credentials.number, 1)
  assert.deepEqual(credentials.numbers, [1, 2, 1001, 1002])

  credentials.advance()
  assert.deepEqual([...failed], [1])
  assert.equal(credentials.key, 'vibe-two')
  credentials.markServed()
  assert.equal(credentials.lastServed, 2)

  // The second Vibe key fails too: the Studio pool takes over and its numbers
  // sit above the Vibe range so health cannot confuse the two.
  credentials.advance()
  assert.equal(credentials.key, 'api-one')
  assert.equal(credentials.number, 1001)
  credentials.markServed()
  assert.equal(credentials.lastServed, 1001)

  credentials.advance()
  assert.equal(credentials.key, 'api-two')
  // No wrap back to Vibe: an exhausted plan budget is not retried every turn.
  assert.equal(failed.has(1), true)
  assert.equal(failed.has(2), true)
})

test('without a Vibe key the route is the Studio pool alone', () => {
  const vibe = mistralVibeCredentialPool({})
  const api = mistralCredentialPool({ MISTRAL_API_KEY: 'api-one' })
  const credentials = createMistralRouteCredentials(vibe, api)
  assert.equal(credentials.size, 1)
  assert.equal(credentials.key, 'api-one')
  assert.equal(credentials.number, 1001)
  assert.deepEqual(credentials.numbers, [1001])
})

test('the keysafe chain injects every Mistral record', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mistral-keysafe-'))
  const vault = join(home, '.keysafe')
  await mkdir(vault)
  for (const name of [
    'mistralvibe.cred',
    'mistralvibe2.cred',
    'mistral-vibe.cred',
    'mistral.cred',
    'mistral2.cred',
    'mistral3.cred',
    'ds.cred',
  ]) {
    await writeFile(join(vault, name), '')
  }
  const providers = listKeysafeProviders(home).filter(entry => entry.envVar.startsWith('MISTRAL'))
  // Vibe records are injected before Studio records. The hyphenated duplicate
  // of slot 1 collapses onto the canonical record rather than injecting
  // MISTRAL_VIBE_KEY twice.
  assert.deepEqual(providers, [
    { credential: 'mistralvibe', envVar: 'MISTRAL_VIBE_KEY' },
    { credential: 'mistralvibe2', envVar: 'MISTRAL_VIBE_KEY2' },
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
