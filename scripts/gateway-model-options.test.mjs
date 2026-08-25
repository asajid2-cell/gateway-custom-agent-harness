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

test('gateway model options fail closed outside gateway mode and on malformed JSON', async () => {
  assert.deepEqual(await loadWithEnv('{bad-json'), [])
  assert.deepEqual(await loadWithEnv(JSON.stringify([{ value: 'x' }]), '0'), [])
})
