import { readFileSync } from 'node:fs'

const CATALOG = JSON.parse(
  readFileSync(new URL('./effort-capabilities.json', import.meta.url), 'utf8'),
)

export const NATIVE_EFFORT_LEVELS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]

export const GPT56_EFFORT_LEVELS = [...CATALOG.gpt56]
export const GPT_LUNA_EFFORT_LEVELS = [...CATALOG.gatewayAliases['gateway-gpt-luna']]
export const GPT_SOL_EFFORT_LEVELS = [...CATALOG.gatewayAliases['gateway-gpt-sol']]
export const GPT_TERRA_EFFORT_LEVELS = [...CATALOG.gatewayAliases['gateway-gpt-terra']]
export const ASTRA_EFFORT_LEVELS = [...CATALOG.gatewayAliases['gateway-gpt-astra']]
export const GPT61_SOL_EFFORT_LEVELS = [...CATALOG.gatewayAliases['gateway-gpt-6.1-sol']]
// The Anthropic subscription models do not share one effort ladder. A 2026-09-30
// sweep against the live endpoint - one deliberately invalid level per model,
// whose rejection names that model's own accepted set - showed the provider
// rejects a level a model does not implement with a 400, so a single shared
// ladder sends values that fail on the next model over: `xhigh` is accepted by
// opus-5-5, sonnet-5-5, opus-5, sonnet-5, opus-4-8 and opus-4-7, but opus-4-6
// and sonnet-4-6 answer "'xhigh' is not supported ... Supported levels: high,
// low, max, medium", and opus-4-5-20251101 rejects both `xhigh` and `max`
// ("high, low, medium"). Each route's ladder is therefore declared per model in
// `gatewayAliases` and read here, so the catalog stays the single declaration
// surface. The two 4.5-generation models reject the effort parameter outright
// and declare an empty ladder; the two fable models answer 429 "Usage credits
// are required for this model" to every request, so their ladder could not be
// probed and stays at the CLI's own conservative first-party default.
export const ANTHROPIC_EFFORT_LEVELS_BY_MODEL = Object.freeze(
  Object.fromEntries(
    Object.entries(CATALOG.gatewayAliases)
      .filter(([routeId]) => routeId.startsWith('gateway-claude-'))
      .map(([routeId, levels]) => [routeId.slice('gateway-'.length), [...levels]]),
  ),
)

export const GATEWAY_MODEL_OPTIONS = Object.freeze(
  (Array.isArray(CATALOG.gatewayModelOptions)
    ? CATALOG.gatewayModelOptions
    : []
  ).map(option => Object.freeze({ ...option })),
)

export const GATEWAY_MODEL_ALIAS_MAP = Object.freeze(
  Object.fromEntries(
    Object.entries(CATALOG.gatewayModelAliases || {}).flatMap(
      ([canonical, aliases]) =>
        (Array.isArray(aliases) ? aliases : []).map(alias => [
          alias.toLowerCase(),
          canonical,
        ]),
    ),
  ),
)

export function gatewayCatalogDrift(routeIds) {
  const routedModelIds = new Set(routeIds)
  const catalogModelIds = new Set(
    GATEWAY_MODEL_OPTIONS.map(option => option.value),
  )
  return {
    missingRoutes: [...catalogModelIds].filter(
      model => !routedModelIds.has(model),
    ),
    missingCatalogEntries: [...routedModelIds].filter(
      model => !catalogModelIds.has(model),
    ),
    unknownAliases: Object.entries(GATEWAY_MODEL_ALIAS_MAP)
      .filter(([, canonical]) => !routedModelIds.has(canonical))
      .map(([alias, canonical]) => `${alias}->${canonical}`),
  }
}

// OpenCode publishes a generic variant vocabulary, but its model catalog is
// authoritative per model. Keep this table explicit so a route cannot
// accidentally advertise every level just because its wire protocol supports
// a reasoning field. Entries marked conservatively can be expanded after a
// live model-catalog or request smoke test confirms the provider accepts it.
export const OPENCODE_GO_EFFORT_LEVELS = Object.fromEntries(
  Object.entries(CATALOG.opencodeGo).map(([model, levels]) => [model, [...levels]]),
)

export const OPENCODE_ZEN_EFFORT_LEVELS = Object.fromEntries(
  Object.entries(CATALOG.opencodeZen || {}).map(([model, levels]) => [model, [...levels]]),
)

export function effortLevelsForOpenCodeModel(model) {
  const levels = OPENCODE_GO_EFFORT_LEVELS[model]
  return levels ? [...levels] : []
}

export function effortLevelsForOpenCodeZenModel(model) {
  const levels = OPENCODE_ZEN_EFFORT_LEVELS[model]
  return levels ? [...levels] : []
}

export const COMMANDCODE_EFFORT_LEVELS = Object.fromEntries(
  Object.entries(CATALOG.commandcode || {}).map(([model, levels]) => [model, [...levels]]),
)

export function effortLevelsForCommandCodeModel(model) {
  const levels = COMMANDCODE_EFFORT_LEVELS[model]
  return levels ? [...levels] : []
}

// Mistral validates reasoning_effort against one closed enum for every model
// (probed live 2026-11-04: 422 naming none|minimal|low|medium|high|xhigh|max),
// so a route there can offer the whole ladder. Kept per model anyway: a future
// non-reasoning Mistral route declares an empty ladder rather than advertising
// a knob the model cannot use.
export const MISTRAL_EFFORT_LEVELS = Object.fromEntries(
  Object.entries(CATALOG.mistral || {}).map(([model, levels]) => [model, [...levels]]),
)

export function effortLevelsForMistralModel(model) {
  const levels = MISTRAL_EFFORT_LEVELS[model]
  return levels ? [...levels] : []
}

export function effortWireMapForOpenCodeModel(model) {
  if (model === 'hy3') return { none: 'no_think' }
  return {}
}

export function effortWireMapForOpenCodeZenModel(model) {
  if (model === 'hy3-free') return { none: 'no_think' }
  return {}
}
