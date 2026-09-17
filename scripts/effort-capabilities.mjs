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

export function effortWireMapForOpenCodeModel(model) {
  if (model === 'hy3') return { none: 'no_think' }
  return {}
}

export function effortWireMapForOpenCodeZenModel(model) {
  if (model === 'hy3-free') return { none: 'no_think' }
  return {}
}
