import { strict as assert } from 'node:assert'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const gatewayEnvKeys = [
  'CLAUDE_CODE_USE_GATEWAY',
  'CLAUDE_CODE_GATEWAY_BASE_URL',
  'CLAUDE_CODE_GATEWAY_TOKEN',
  'MODEL_GATEWAY_MODEL',
  'MODEL_GATEWAY_DEFAULT_MODEL',
  'MODEL_GATEWAY_OPUS_MODEL',
  'MODEL_GATEWAY_FAST_MODEL',
  'MODEL_GATEWAY_SUBAGENT_MODEL',
  'MODEL_GATEWAY_EFFORT',
  'MODEL_GATEWAY_EFFORT_CAPABILITIES',
  'MODEL_GATEWAY_MODEL_OPTIONS',
]

const spawnUtilsSource = await readFile(
  new URL('../src/utils/swarm/spawnUtils.ts', import.meta.url),
  'utf8',
)
const teammateModelSource = await readFile(
  new URL('../src/utils/swarm/teammateModel.ts', import.meta.url),
  'utf8',
)
const agentModelSource = await readFile(
  new URL('../src/utils/model/agent.ts', import.meta.url),
  'utf8',
)

test('tmux and pane teammates inherit the complete Gateway route', async () => {
  for (const key of gatewayEnvKeys) {
    assert.match(
      spawnUtilsSource,
      new RegExp(`['"]${key}['"]`),
      `${key} is not forwarded by buildInheritedEnvVars`,
    )
  }
})

test('Gateway teammate model resolution is provider-aware', () => {
  assert.match(teammateModelSource, /getAPIProvider\(\)\s*===\s*['"]gateway['"]/)
  assert.match(teammateModelSource, /MODEL_GATEWAY_SUBAGENT_MODEL/)
  assert.match(teammateModelSource, /gateway-gpt-luna/)
  assert.match(agentModelSource, /parseUserSpecifiedModel/)
})
