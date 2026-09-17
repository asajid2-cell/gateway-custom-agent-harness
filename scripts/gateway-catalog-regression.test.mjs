import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  GATEWAY_MODEL_ALIAS_MAP,
  GATEWAY_MODEL_OPTIONS,
  gatewayCatalogDrift,
} from './effort-capabilities.mjs'
import { modelsResponse } from './model-gateway.mjs'

const catalog = JSON.parse(
  await readFile(new URL('./effort-capabilities.json', import.meta.url), 'utf8'),
)
const optionIds = catalog.gatewayModelOptions.map(option => option.value)

test('shared catalog exports the exact visible Gateway picker metadata', () => {
  assert.deepEqual(GATEWAY_MODEL_OPTIONS, catalog.gatewayModelOptions)
  assert.equal(new Set(optionIds).size, optionIds.length)
  assert.ok(optionIds.every(id => id.startsWith('gateway-')))
  assert.deepEqual(
    catalog.gatewayModelOptions.find(option => option.value === 'gateway-gpt-astra'),
    {
      value: 'gateway-gpt-astra',
      label: 'GPT-6-Astra',
      description: 'Our most capable model for complex, demanding work.',
    },
  )
})

test('every visible Gateway route is represented by the shared catalog', () => {
  const discovered = modelsResponse().models
  assert.deepEqual([...discovered].sort(), [...optionIds].sort())
  assert.deepEqual(
    gatewayCatalogDrift(discovered),
    {
      missingRoutes: [],
      missingCatalogEntries: [],
      unknownAliases: [],
    },
  )
})

test('catalog aliases resolve only to visible Gateway routes', () => {
  const aliases = Object.entries(catalog.gatewayModelAliases)
  assert.deepEqual(catalog.gatewayModelAliases['gateway-gpt-astra'], [
    'gpt-6-astra',
    'claude-gpt-astra',
  ])
  const flattened = aliases.flatMap(([, values]) => values)
  assert.equal(
    new Set(flattened.map(alias => alias.toLowerCase())).size,
    flattened.length,
  )
  for (const [canonical, values] of aliases) {
    assert.ok(optionIds.includes(canonical), `${canonical} needs a picker route`)
    for (const alias of values) {
      assert.equal(GATEWAY_MODEL_ALIAS_MAP[alias.toLowerCase()], canonical)
    }
  }
})

test('catalog drift verifier is discriminating', () => {
  const incomplete = optionIds.slice(1)
  const drift = gatewayCatalogDrift(incomplete)
  assert.ok(drift.missingRoutes.includes(optionIds[0]))
  assert.deepEqual(gatewayCatalogDrift(optionIds).missingRoutes, [])
})

test('Command Code routes stay grouped and carry provider-native upstream ids', () => {
  const commandCode = optionIds.filter(id => id.startsWith('gateway-commandcode-'))
  assert.deepEqual(commandCode, [
    'gateway-commandcode-deepseek-v4.1-flash',
    'gateway-commandcode-longcat-2.0-free',
    'gateway-commandcode-laguna-s-2.1-free',
    'gateway-commandcode-ling-3.0-flash-sante-free',
  ])
  // The user asked for these to sit near each other in the picker, so the
  // block must be contiguous rather than merely present.
  const start = optionIds.indexOf(commandCode[0])
  assert.deepEqual(
    optionIds.slice(start, start + commandCode.length),
    commandCode,
  )

  const data = modelsResponse().data
  const upstreamByGatewayId = {
    'gateway-commandcode-deepseek-v4.1-flash': 'deepseek/deepseek-v4.1-flash',
    'gateway-commandcode-longcat-2.0-free': 'meituan/LongCat-2.0:free',
    'gateway-commandcode-laguna-s-2.1-free': 'poolside/laguna-s-2.1-free',
    'gateway-commandcode-ling-3.0-flash-sante-free':
      'inclusionai/ling-3.0-flash-sante:free',
  }
  for (const [id, upstream] of Object.entries(upstreamByGatewayId)) {
    const entry = data.find(model => model.id === id)
    assert.ok(entry, `${id} must be discoverable`)
    assert.equal(entry.owned_by, 'commandcode')
    // Provider-native ids keep their case and punctuation: Command Code's
    // namespace (`meituan/LongCat-2.0:free`) is not reconstructible from a
    // Gateway id, so the upstream string has to survive verbatim.
    assert.equal(entry.display_name, upstream)
    // Probe-verified against the live provider: it accepts exactly these five
    // values and answers 400 for none/minimal/ultra, so an empty ladder here
    // would both under-report the model and (because the harness appends its
    // own `ultracode` control) leave the picker showing ultracode alone.
    assert.deepEqual(entry.effort_levels, ['low', 'medium', 'high', 'xhigh', 'max'])
  }
})
