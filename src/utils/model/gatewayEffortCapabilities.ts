import catalog from '../../../scripts/effort-capabilities.json'

/**
 * The gateway launcher injects this catalog at runtime, but the compiled
 * client also needs a deterministic fallback for direct launches and stale
 * launcher environments. Keep the fallback sourced from the same JSON file.
 */
export function getGatewayNativeEffortLevels(
  model: string,
): string[] | undefined {
  const aliases = {
    ...(catalog.gatewayAliases as Record<string, unknown>),
    ...(catalog.legacyAliases as Record<string, unknown>),
  }
  const match = Object.entries(aliases).find(
    ([alias]) => alias.toLowerCase() === model.toLowerCase(),
  )
  if (!match || !Array.isArray(match[1])) return undefined
  return [...new Set(match[1].filter(level => typeof level === 'string'))]
}
