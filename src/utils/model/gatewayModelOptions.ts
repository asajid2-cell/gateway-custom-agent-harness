import type { ModelOption } from './modelOptions.js'
import {
  isCanonicalGatewayModelId,
  normalizeGatewayModelId,
} from './gatewayModelIds.js'

type GatewayModelOptionInput = {
  value?: unknown
  label?: unknown
  description?: unknown
}

/**
 * The launcher supplies the gateway catalog as metadata, not as a model
 * override. Keeping this parser defensive prevents a malformed environment
 * value from breaking ordinary model-picker startup.
 */
export function getGatewayModelOptions(): ModelOption[] {
  if (process.env.CLAUDE_CODE_USE_GATEWAY !== '1') return []
  const raw = process.env.MODEL_GATEWAY_MODEL_OPTIONS
  if (!raw) return []

  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []

    const seen = new Set<string>()
    const options: ModelOption[] = []
    for (const entry of parsed as GatewayModelOptionInput[]) {
      if (typeof entry?.value !== 'string' || entry.value.length === 0) {
        continue
      }
      const value = normalizeGatewayModelId(entry.value)
      // Gateway owns the picker namespace. Known legacy aliases are
      // normalized above; arbitrary Claude/Anthropic IDs are stale state and
      // must not become fresh Gateway choices.
      if (!isCanonicalGatewayModelId(value)) continue
      if (seen.has(value)) continue
      seen.add(value)
      const label =
        typeof entry.label === 'string' && entry.label.length > 0
          ? entry.label
          : value
      const description =
        typeof entry.description === 'string' && entry.description.length > 0
          ? entry.description
          : 'Gateway model'
      options.push({
        value,
        label,
        description,
      })
    }
    return options
  } catch {
    return []
  }
}
