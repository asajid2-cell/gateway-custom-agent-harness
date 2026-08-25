import { strict as assert } from 'node:assert'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  GPT56_EFFORT_LEVELS,
  OPENCODE_GO_EFFORT_LEVELS,
  effortLevelsForOpenCodeModel,
} from './effort-capabilities.mjs'
import { OPENCODE_GO_MODEL_IDS } from './opencode-go.mjs'
import {
  getGatewayNativeEffortLevels,
} from '../src/utils/model/gatewayEffortCapabilities.ts'

const catalog = JSON.parse(
  await readFile(new URL('./effort-capabilities.json', import.meta.url), 'utf8'),
)

test('shared effort catalog preserves the GPT-5.6 ladder', () => {
  assert.deepEqual(catalog.gpt56, ['none', 'low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(GPT56_EFFORT_LEVELS, catalog.gpt56)
})

test('every OpenCode Go route has explicit capability metadata', () => {
  assert.deepEqual(
    Object.keys(OPENCODE_GO_EFFORT_LEVELS).sort(),
    [...OPENCODE_GO_MODEL_IDS].sort(),
  )
  for (const model of OPENCODE_GO_MODEL_IDS) {
    assert.deepEqual(effortLevelsForOpenCodeModel(model), catalog.opencodeGo[model])
  }
})

test('gateway aliases mirror the provider capability contract', () => {
  for (const [alias, levels] of Object.entries(catalog.gatewayAliases)) {
    assert.ok(Array.isArray(levels), `${alias} must have an array of levels`)
    assert.ok(
      levels.every(level => GPT56_EFFORT_LEVELS.includes(level) || level === 'minimal'),
      `${alias} contains an unknown effort level`,
    )
  }
  assert.deepEqual(
    catalog.gatewayAliases['gateway-opencode-deepseek-v4-pro'],
    catalog.opencodeGo['deepseek-v4-pro'],
  )
  assert.deepEqual(
    catalog.gatewayAliases['gateway-ox-alpha'],
    catalog.opencodeGo['ox-alpha-free'],
  )
  assert.deepEqual(
    catalog.legacyAliases['claude-opencode-deepseek-v4-pro'],
    catalog.opencodeGo['deepseek-v4-pro'],
  )
})

test('compiled client fallback resolves provider-qualified gateway effort levels', () => {
  assert.deepEqual(getGatewayNativeEffortLevels('gateway-gpt-luna'), catalog.gpt56)
  assert.deepEqual(
    getGatewayNativeEffortLevels('gateway-opencode-gpt-5.6-luna'),
    catalog.opencodeGo['gpt-5.6-luna'],
  )
  assert.deepEqual(
    getGatewayNativeEffortLevels('gateway-ox-alpha'),
    catalog.opencodeGo['ox-alpha-free'],
  )
  assert.deepEqual(
    getGatewayNativeEffortLevels('gateway-opencode-mimo-v2.5'),
    catalog.opencodeGo['mimo-v2.5'],
  )
  assert.deepEqual(
    getGatewayNativeEffortLevels('claude-gpt-luna'),
    catalog.gpt56,
  )
  assert.equal(getGatewayNativeEffortLevels('unknown-gateway-model'), undefined)
})
