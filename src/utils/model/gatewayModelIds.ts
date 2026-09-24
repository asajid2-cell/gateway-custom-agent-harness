import catalog from '../../../scripts/effort-capabilities.json'

const EXACT_GATEWAY_ALIASES: Record<string, string> = Object.fromEntries(
  Object.entries(
    catalog.gatewayModelAliases as Record<string, string[]>,
  ).flatMap(([canonical, aliases]) =>
    aliases.map(alias => [alias.toLowerCase(), canonical]),
  ),
)

/**
 * Translate historical/provider-native IDs to the canonical Gateway namespace.
 * Unknown IDs are preserved so a configured custom Gateway route can still be
 * diagnosed by the upstream rather than being silently rewritten.
 */
export function normalizeGatewayModelId(model: string): string {
  const exact = EXACT_GATEWAY_ALIASES[model.toLowerCase()]
  if (exact) return exact

  const lower = model.toLowerCase()
  if (lower.startsWith('claude-opencode-')) {
    return `gateway-opencode-${model.slice('claude-opencode-'.length)}`
  }
  if (lower.startsWith('opencode-go/')) {
    return `gateway-opencode-${model.slice('opencode-go/'.length)}`
  }
  if (lower.startsWith('opencode-zen/')) {
    return `gateway-opencode-${model.slice('opencode-zen/'.length)}`
  }
  return model
}

export function isCanonicalGatewayModelId(model: string): boolean {
  return model.toLowerCase().startsWith('gateway-')
}

const GATEWAY_MODEL_CONTEXT_WINDOWS = new Map(
  Object.entries(
    catalog.gatewayModelMetadata as Record<
      string,
      { contextWindow?: unknown } | undefined
    >,
  )
    .filter(([, meta]) => typeof meta?.contextWindow === 'number')
    .map(([canonical, meta]) => [
      canonical.toLowerCase(),
      meta!.contextWindow as number,
    ]),
)

/**
 * The accounting context window for a Gateway route, resolved through the alias
 * fold so every spelling of one route reports the same value. Returns null for
 * anything the catalog does not describe, leaving the caller to fall back.
 */
export function getGatewayModelContextWindow(model: string): number | null {
  const canonical = normalizeGatewayModelId(model)
  return GATEWAY_MODEL_CONTEXT_WINDOWS.get(canonical.toLowerCase()) ?? null
}

const GATEWAY_MODEL_DISPLAY_NAMES = new Map(
  (catalog.gatewayModelOptions as Array<{ value?: unknown; label?: unknown }>)
    .filter(
      option =>
        typeof option.value === 'string' &&
        typeof option.label === 'string' &&
        option.value.length > 0 &&
        option.label.length > 0,
    )
    .map(option => [option.value!.toLowerCase(), option.label as string]),
)

export function getGatewayModelDisplayName(model: string): string | null {
  const canonical = normalizeGatewayModelId(model)
  return GATEWAY_MODEL_DISPLAY_NAMES.get(canonical.toLowerCase()) ?? null
}
