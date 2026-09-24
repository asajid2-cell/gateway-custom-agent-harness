import { strict as assert } from 'node:assert'
import test from 'node:test'

async function loadWithEnv(raw, useGateway = '1') {
  const previousRaw = process.env.MODEL_GATEWAY_MODEL_OPTIONS
  const previousGateway = process.env.CLAUDE_CODE_USE_GATEWAY
  if (raw === undefined) delete process.env.MODEL_GATEWAY_MODEL_OPTIONS
  else process.env.MODEL_GATEWAY_MODEL_OPTIONS = raw
  process.env.CLAUDE_CODE_USE_GATEWAY = useGateway
  try {
    const module = await import(`../src/utils/model/gatewayModelOptions.ts?case=${Date.now()}-${Math.random()}`)
    return module.getGatewayModelOptions()
  } finally {
    if (previousRaw === undefined) delete process.env.MODEL_GATEWAY_MODEL_OPTIONS
    else process.env.MODEL_GATEWAY_MODEL_OPTIONS = previousRaw
    if (previousGateway === undefined) delete process.env.CLAUDE_CODE_USE_GATEWAY
    else process.env.CLAUDE_CODE_USE_GATEWAY = previousGateway
  }
}

test('gateway model options parse and deduplicate provider-qualified entries', async () => {
  const options = await loadWithEnv(JSON.stringify([
    { value: 'claude-gpt-luna', label: 'GPT 5.6 Luna', description: 'Regular gateway' },
    { value: 'claude-opencode-deepseek-v4-pro', label: 'OpenCode DeepSeek', description: 'OpenCode' },
    { value: 'claude-opus-4-6', label: 'stale Anthropic model', description: 'must be ignored' },
    { value: 'claude-opencode-deepseek-v4-pro', label: 'duplicate' },
    { value: '', label: 'ignored' },
    { value: 42, label: 'ignored' },
  ]))
  assert.deepEqual(options, [
    { value: 'gateway-gpt-luna', label: 'GPT 5.6 Luna', description: 'Regular gateway' },
    { value: 'gateway-opencode-deepseek-v4-pro', label: 'OpenCode DeepSeek', description: 'OpenCode' },
  ])
})

test('gateway model options normalize OpenCode Zen aliases', async () => {
  const options = await loadWithEnv(JSON.stringify([
    { value: 'opencode-zen/mimo-v2.5-free', label: 'Mimo Free' },
  ]))
  assert.deepEqual(options, [
    { value: 'gateway-opencode-mimo-v2.5-free', label: 'Mimo Free', description: 'Gateway model' },
  ])
})

test('gateway display labels preserve Gateway identities and normalize provider IDs', async () => {
  const { getGatewayModelDisplayName } = await import(
    `../src/utils/model/gatewayModelIds.ts?display=${Date.now()}-${Math.random()}`,
  )
  assert.equal(getGatewayModelDisplayName('gateway-gpt-terra'), 'GPT-5.6-Terra')
  // Both generations are served at once, so a spelling only ever resolves onto
  // the route that runs the model its name says. Nothing may display one
  // generation while routing to another.
  assert.equal(getGatewayModelDisplayName('gateway-gpt-sol'), 'GPT-5.6-Sol')
  assert.equal(getGatewayModelDisplayName('gpt-5.6-sol'), 'GPT-5.6-Sol')
  assert.equal(getGatewayModelDisplayName('claude-gpt-sol'), 'GPT-5.6-Sol')
  assert.equal(getGatewayModelDisplayName('gateway-gpt-6-sol'), 'GPT-6-Sol')
  assert.equal(getGatewayModelDisplayName('gpt-6-sol'), 'GPT-6-Sol')
  assert.equal(getGatewayModelDisplayName('gateway-gpt-luna'), 'GPT-5.6-Luna')
  assert.equal(getGatewayModelDisplayName('gpt-5.6-luna'), 'GPT-5.6-Luna')
  assert.equal(getGatewayModelDisplayName('claude-gpt-luna'), 'GPT-5.6-Luna')
  assert.equal(getGatewayModelDisplayName('gateway-gpt-6-luna'), 'GPT-6-Luna')
  assert.equal(getGatewayModelDisplayName('gpt-6-luna'), 'GPT-6-Luna')
  assert.equal(getGatewayModelDisplayName('gateway-gpt-astra'), 'GPT-6-Astra')
  assert.equal(getGatewayModelDisplayName('gpt-6-astra'), 'GPT-6-Astra')
  assert.equal(getGatewayModelDisplayName('claude-gpt-astra'), 'GPT-6-Astra')
  assert.equal(
    getGatewayModelDisplayName('opencode-go/glm-5.3-flash'),
    'OpenCode GLM 5.3 Flash',
  )
  assert.equal(
    getGatewayModelDisplayName('opencode-zen/mimo-v2.5-free'),
    'OpenCode Mimo v2.5 Free',
  )
})

test('gateway model options fail closed outside gateway mode and on malformed JSON', async () => {
  assert.deepEqual(await loadWithEnv('{bad-json'), [])
  assert.deepEqual(await loadWithEnv(JSON.stringify([{ value: 'x' }]), '0'), [])
})
