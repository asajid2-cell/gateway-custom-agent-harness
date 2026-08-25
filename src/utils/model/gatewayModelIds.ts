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
  return model
}

export function isCanonicalGatewayModelId(model: string): boolean {
  return model.toLowerCase().startsWith('gateway-')
}
