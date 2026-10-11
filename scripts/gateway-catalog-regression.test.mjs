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
  // The newest Sol point release leads the picker; the rest keep their order.
  assert.equal(optionIds[0], 'gateway-gpt-6.1-sol')
  assert.deepEqual(
    catalog.gatewayModelOptions.find(option => option.value === 'gateway-gpt-6.1-sol'),
    {
      value: 'gateway-gpt-6.1-sol',
      label: 'GPT-6.1-Sol',
      description: 'Latest workhorse model for coding and everyday work.',
    },
  )
  assert.deepEqual(
    catalog.gatewayModelOptions.find(option => option.value === 'gateway-gpt-astra'),
    {
      value: 'gateway-gpt-astra',
      label: 'GPT-6-Astra',
      description: 'Our most capable model for complex, demanding work.',
    },
  )
  assert.deepEqual(
    catalog.gatewayModelOptions.find(option => option.value === 'gateway-gpt-luna'),
    {
      value: 'gateway-gpt-luna',
      label: 'GPT-5.6-Luna',
      description: 'Gateway - GPT-5.6 Luna',
    },
  )
  assert.deepEqual(
    catalog.gatewayModelOptions.find(option => option.value === 'gateway-gpt-6-luna'),
    {
      value: 'gateway-gpt-6-luna',
      label: 'GPT-6-Luna',
      description: 'Gateway - GPT-6 Luna',
    },
  )
  assert.deepEqual(
    catalog.gatewayModelOptions.find(option => option.value === 'gateway-gpt-sol'),
    {
      value: 'gateway-gpt-sol',
      label: 'GPT-5.6-Sol',
      description: 'Gateway - GPT-5.6 Sol',
    },
  )
  assert.deepEqual(
    catalog.gatewayModelOptions.find(option => option.value === 'gateway-gpt-6-sol'),
    {
      value: 'gateway-gpt-6-sol',
      label: 'GPT-6-Sol',
      description: 'Gateway - GPT-6 Sol',
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
  // Both generations are served at once, so a versioned id folds only onto the
  // route that runs the same upstream. The versionless Gateway names and the
  // legacy `claude-` spelling stay pinned to the generation they always meant.
  assert.deepEqual(catalog.gatewayModelAliases['gateway-gpt-luna'], [
    'gpt-5.6-luna',
    'claude-gpt-luna',
  ])
  assert.deepEqual(catalog.gatewayModelAliases['gateway-gpt-6-luna'], ['gpt-6-luna'])
  assert.deepEqual(catalog.gatewayModelAliases['gateway-gpt-sol'], [
    'gpt-5.6-sol',
    'claude-gpt-sol',
  ])
  assert.deepEqual(catalog.gatewayModelAliases['gateway-gpt-6-sol'], ['gpt-6-sol'])
  // A point release, not a generation: the versioned id alone, no `claude-`
  // legacy spelling (that convention stopped at the 5.6 line) and no
  // versionless Gateway name that could float onto another generation.
  assert.deepEqual(catalog.gatewayModelAliases['gateway-gpt-6.1-sol'], ['gpt-6.1-sol'])
  assert.deepEqual(catalog.gatewayModelAliases['gateway-gpt-terra'], [
    'gpt-5.6-terra',
    'claude-gpt-terra',
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

test('each GPT route names its own generation upstream and offers only accepted levels', () => {
  const data = modelsResponse().data
  const upstreamByGatewayId = {
    'gateway-gpt-astra': 'gpt-6-astra',
    'gateway-gpt-luna': 'gpt-5.6-luna',
    'gateway-gpt-6-luna': 'gpt-6-luna',
    'gateway-gpt-sol': 'gpt-5.6-sol',
    'gateway-gpt-6-sol': 'gpt-6-sol',
    'gateway-gpt-terra': 'gpt-5.6-terra',
    'gateway-gpt-6.1-sol': 'gpt-6.1-sol',
  }
  for (const [id, upstream] of Object.entries(upstreamByGatewayId)) {
    const entry = data.find(model => model.id === id)
    assert.ok(entry, `${id} must be discoverable`)
    assert.equal(entry.owned_by, 'codex')
    assert.equal(entry.display_name, upstream)
  }
  // The point release dropped `none` along with `ultra`: the provider answers
  // "'none' is not supported with the 'gpt-6.1-sol' model" while 5.6-sol and
  // 6-sol accept it, so the older ladder cannot be copied onto it.
  const pointRelease = data.find(model => model.id === 'gateway-gpt-6.1-sol')
  assert.deepEqual(pointRelease.effort_levels, ['low', 'medium', 'high', 'xhigh', 'max'])
  // The provider enumerates none/minimal/low/medium/high/xhigh/max for the
  // whole generation and rejects `ultra` by name, so no GPT-6 route may offer
  // it - a level the endpoint 400s is a failed turn, not a capability.
  for (const id of Object.keys(upstreamByGatewayId)) {
    const entry = data.find(model => model.id === id)
    assert.equal(entry.effort_levels.includes('ultra'), false, `${id} must not offer ultra`)
  }
})

test('no alias folds a route onto a different generation', () => {
  const data = modelsResponse().data
  const generation = id => {
    const match = id.toLowerCase().match(/gpt-(\d+(?:\.\d+)?)-/)
    return match ? match[1] : null
  }
  for (const [canonical, aliases] of Object.entries(catalog.gatewayModelAliases)) {
    const entry = data.find(model => model.id === canonical)
    if (!entry) continue
    const routeGeneration = generation(entry.display_name)
    if (routeGeneration === null) continue
    for (const alias of aliases) {
      const aliasGeneration = generation(alias)
      if (aliasGeneration === null) continue
      assert.equal(
        aliasGeneration,
        routeGeneration,
        `${alias} names GPT-${aliasGeneration} but folds onto ${canonical} (${entry.display_name})`,
      )
    }
  }
})

test('catalog drift verifier is discriminating', () => {
  const incomplete = optionIds.slice(1)
  const drift = gatewayCatalogDrift(incomplete)
  assert.ok(drift.missingRoutes.includes(optionIds[0]))
  assert.deepEqual(gatewayCatalogDrift(optionIds).missingRoutes, [])
})

test('Anthropic routes sit below the GPT block and carry the subscription ladders', () => {
  const anthropic = optionIds.filter(id => id.startsWith('gateway-claude-'))
  assert.equal(anthropic.length, 14)
  // The subscription models were deliberately left at the bottom of the picker.
  assert.deepEqual(optionIds.slice(-anthropic.length), anthropic)

  const data = modelsResponse().data
  // The advertised ladder is per model: the provider 400s a level the model does
  // not implement, so the route may only offer the set that model accepts.
  const ladderByRoute = {
    'gateway-claude-opus-5-5': ['low', 'medium', 'high', 'xhigh', 'max'],
    'gateway-claude-sonnet-5-5': ['low', 'medium', 'high', 'xhigh', 'max'],
    'gateway-claude-haiku-5-5': ['low', 'medium', 'high', 'xhigh', 'max'],
    'gateway-claude-fable-5-1': ['low', 'medium', 'high'],
    'gateway-claude-opus-5': ['low', 'medium', 'high', 'xhigh', 'max'],
    'gateway-claude-sonnet-5': ['low', 'medium', 'high', 'xhigh', 'max'],
    'gateway-claude-fable-5': ['low', 'medium', 'high'],
    'gateway-claude-opus-4-8': ['low', 'medium', 'high', 'xhigh', 'max'],
    'gateway-claude-opus-4-7': ['low', 'medium', 'high', 'xhigh', 'max'],
    'gateway-claude-sonnet-4-6': ['low', 'medium', 'high', 'max'],
    'gateway-claude-opus-4-6': ['low', 'medium', 'high', 'max'],
    'gateway-claude-opus-4-5-20251101': ['low', 'medium', 'high'],
    'gateway-claude-haiku-4-5-20251001': [],
    'gateway-claude-sonnet-4-5-20250929': [],
  }
  for (const id of anthropic) {
    const entry = data.find(model => model.id === id)
    assert.ok(entry, `${id} must be discoverable`)
    assert.equal(entry.owned_by, 'anthropic')
    // `upstream` is the provider's own id and the passthrough forwards the body
    // as-is, so the rewritten model string must be exactly what Anthropic
    // serves - the Gateway id minus its prefix.
    assert.equal(entry.display_name, id.slice('gateway-'.length))
    assert.deepEqual(entry.effort_levels, ladderByRoute[id], `${id} ladder`)
  }

  // The native spellings stay routable for direct callers and stale
  // transcripts, but must not appear in discovery beside their visible route.
  const discoveredIds = new Set(data.map(model => model.id))
  for (const id of anthropic) {
    assert.equal(
      discoveredIds.has(id.slice('gateway-'.length)),
      false,
      `${id} native alias must stay hidden`,
    )
  }
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
