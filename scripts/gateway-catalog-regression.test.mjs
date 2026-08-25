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
