import { strict as assert } from 'node:assert'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  ASTRA_EFFORT_LEVELS,
  GPT56_EFFORT_LEVELS,
  GPT61_SOL_EFFORT_LEVELS,
  GPT_LUNA_EFFORT_LEVELS,
  GPT_SOL_EFFORT_LEVELS,
  GPT_TERRA_EFFORT_LEVELS,
  NATIVE_EFFORT_LEVELS,
  OPENCODE_GO_EFFORT_LEVELS,
  effortLevelsForOpenCodeModel,
  effortLevelsForOpenCodeZenModel,
} from './effort-capabilities.mjs'
import { OPENCODE_GO_MODEL_IDS } from './opencode-go.mjs'
import { OPENCODE_ZEN_MODEL_IDS } from './opencode-zen.mjs'
import {
  getGatewayNativeEffortLevels,
} from '../src/utils/model/gatewayEffortCapabilities.ts'

const catalog = JSON.parse(
  await readFile(new URL('./effort-capabilities.json', import.meta.url), 'utf8'),
)

test('shared effort catalog preserves model-specific GPT ladders', () => {
  assert.deepEqual(catalog.gpt56, ['none', 'low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(GPT56_EFFORT_LEVELS, catalog.gpt56)
  assert.deepEqual(GPT_LUNA_EFFORT_LEVELS, catalog.gatewayAliases['gateway-gpt-luna'])
  assert.deepEqual(GPT_SOL_EFFORT_LEVELS, catalog.gatewayAliases['gateway-gpt-sol'])
  assert.deepEqual(GPT_TERRA_EFFORT_LEVELS, catalog.gatewayAliases['gateway-gpt-terra'])
  assert.deepEqual(GPT_SOL_EFFORT_LEVELS, ['none', 'low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(GPT_TERRA_EFFORT_LEVELS, ['none', 'low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(ASTRA_EFFORT_LEVELS, ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(ASTRA_EFFORT_LEVELS, catalog.gatewayAliases['gateway-gpt-astra'])
  assert.equal(GPT_SOL_EFFORT_LEVELS.includes('ultra'), false)
  assert.equal(GPT_TERRA_EFFORT_LEVELS.includes('ultra'), false)
  assert.equal(ASTRA_EFFORT_LEVELS.includes('ultra'), false)
  // The point release is the one Sol that cannot take `none`, so it shares
  // astra's ladder rather than the 5.6/6-sol one.
  assert.deepEqual(GPT61_SOL_EFFORT_LEVELS, ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(
    GPT61_SOL_EFFORT_LEVELS,
    catalog.gatewayAliases['gateway-gpt-6.1-sol'],
  )
  assert.equal(GPT61_SOL_EFFORT_LEVELS.includes('none'), false)
  assert.equal(GPT61_SOL_EFFORT_LEVELS.includes('minimal'), false)
  assert.equal(GPT61_SOL_EFFORT_LEVELS.includes('ultra'), false)
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

test('every OpenCode Zen route has explicit capability metadata', () => {
  assert.deepEqual(
    Object.keys(catalog.opencodeZen).sort(),
    [...OPENCODE_ZEN_MODEL_IDS].sort(),
  )
  for (const model of OPENCODE_ZEN_MODEL_IDS) {
    assert.deepEqual(effortLevelsForOpenCodeZenModel(model), catalog.opencodeZen[model])
  }
})

test('gateway aliases mirror the provider capability contract', () => {
  for (const [alias, levels] of Object.entries(catalog.gatewayAliases)) {
    assert.ok(Array.isArray(levels), `${alias} must have an array of levels`)
    assert.ok(
      levels.every(level => NATIVE_EFFORT_LEVELS.includes(level)),
      `${alias} contains an unknown effort level`,
    )
  }
  assert.deepEqual(
    catalog.gatewayAliases['gateway-opencode-deepseek-v4-pro'],
    catalog.opencodeGo['deepseek-v4-pro'],
  )
  assert.deepEqual(
    catalog.gatewayAliases['gateway-opencode-glm-5.3-flash'],
    catalog.opencodeGo['glm-5.3-flash'],
  )
  assert.deepEqual(
    catalog.gatewayAliases['gateway-opencode-mimo-v2.5-free'],
    catalog.opencodeZen['mimo-v2.5-free'],
  )
  assert.deepEqual(
    catalog.gatewayModelAliases['gateway-opencode-glm-5.3-flash'],
    ['opencode-go/glm-5.3-flash', 'claude-opencode-glm-5.3-flash'],
  )
  assert.deepEqual(
    catalog.gatewayModelAliases['gateway-opencode-mimo-v2.5-free'],
    ['opencode-zen/mimo-v2.5-free', 'claude-opencode-mimo-v2.5-free'],
  )
  assert.deepEqual(
    catalog.legacyAliases['claude-opencode-mimo-v2.5-free'],
    ['opencode-zen/mimo-v2.5-free'],
  )
  assert.deepEqual(
    catalog.legacyAliases['claude-opencode-deepseek-v4-pro'],
    catalog.opencodeGo['deepseek-v4-pro'],
  )
  for (const model of OPENCODE_ZEN_MODEL_IDS) {
    assert.deepEqual(
      catalog.gatewayAliases[`gateway-opencode-${model}`],
      catalog.opencodeZen[model],
    )
    assert.ok(catalog.legacyAliases[`claude-opencode-${model}`])
  }
})

test('compiled client fallback resolves provider-qualified gateway effort levels', () => {
  assert.deepEqual(getGatewayNativeEffortLevels('gateway-gpt-luna'), catalog.gpt56)
  assert.deepEqual(getGatewayNativeEffortLevels('gateway-gpt-6-luna'), catalog.gpt56)
  assert.deepEqual(getGatewayNativeEffortLevels('gateway-gpt-sol'), catalog.gpt56)
  assert.deepEqual(getGatewayNativeEffortLevels('gateway-gpt-6-sol'), catalog.gpt56)
  assert.deepEqual(
    getGatewayNativeEffortLevels('gateway-gpt-astra'),
    ASTRA_EFFORT_LEVELS,
  )
  assert.deepEqual(
    getGatewayNativeEffortLevels('claude-gpt-astra'),
    ASTRA_EFFORT_LEVELS,
  )
  assert.deepEqual(
    getGatewayNativeEffortLevels('gateway-opencode-gpt-5.6-luna'),
    catalog.opencodeGo['gpt-5.6-luna'],
  )
  assert.deepEqual(
    getGatewayNativeEffortLevels('gateway-opencode-glm-5.3-flash'),
    catalog.opencodeGo['glm-5.3-flash'],
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
