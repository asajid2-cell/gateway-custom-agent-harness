import { getGlobalConfig, saveGlobalConfig } from '../config.js'
import type { ModelOption } from './modelOptions.js'

const OPENROUTER_MODELS_URL =
  process.env.OPENROUTER_MODELS_URL || 'https://openrouter.ai/api/v1/models'

export type OpenRouterModel = {
  id: string
  name?: string
  description?: string
  context_length?: number
  supported_parameters?: string[]
  supported_efforts?: unknown
  supportedEfforts?: unknown
  effort_levels?: unknown
  effortLevels?: unknown
  reasoning?: {
    supported_efforts?: unknown
    supportedEfforts?: unknown
  }
  pricing?: {
    prompt?: string
    completion?: string
  }
  architecture?: {
    modality?: string
  }
}

function modelAlias(id: string): string {
  return `claude-openrouter-${Buffer.from(id, 'utf8').toString('base64url')}`
}

const OPENROUTER_EFFORT_LEVELS = ['low', 'medium', 'high', 'max'] as const

function explicitEffortLevels(model: OpenRouterModel): readonly string[] {
  const candidates = [
    model.supported_efforts,
    model.supportedEfforts,
    model.effort_levels,
    model.effortLevels,
    model.reasoning?.supported_efforts,
    model.reasoning?.supportedEfforts,
  ]
  const value = candidates.find(candidate => Array.isArray(candidate))
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((level): level is typeof OPENROUTER_EFFORT_LEVELS[number] =>
    typeof level === 'string' &&
    (OPENROUTER_EFFORT_LEVELS as readonly string[]).includes(level),
  ))]
}

export function openRouterModelOption(model: OpenRouterModel): ModelOption {
  const name = typeof model.name === 'string' && model.name.trim()
    ? model.name.trim()
    : model.id
  const context = Number.isFinite(model.context_length)
    ? `, ${Number(model.context_length).toLocaleString()} context`
    : ''
  const effortLevels = explicitEffortLevels(model)
  return {
    value: modelAlias(model.id),
    label: `OpenRouter: ${name}`,
    description: `${model.id}${context}`,
    descriptionForModel: `OpenRouter model ${model.id}`,
    // supported_parameters only proves that a reasoning parameter exists. It
    // does not identify the model's accepted enum, so expose effort only when
    // the catalog provides an explicit allowlist.
    ...(effortLevels.length
      ? { effortLevels }
      : {}),
  }
}

export function openRouterModelIdFromAlias(value: string): string | null {
  const prefix = 'claude-openrouter-'
  if (!value.startsWith(prefix)) return null
  try {
    return Buffer.from(value.slice(prefix.length), 'base64url').toString('utf8') || null
  } catch {
    return null
  }
}

export function getSavedOpenRouterModelOptions(): ModelOption[] {
  return getGlobalConfig().gatewayOpenRouterModels ?? []
}

export function saveOpenRouterModelOption(option: ModelOption): void {
  saveGlobalConfig(current => {
    const existing = current.gatewayOpenRouterModels ?? []
    if (existing.some(item => item.value === option.value)) return current
    return { ...current, gatewayOpenRouterModels: [...existing, option] }
  })
}

export function removeOpenRouterModel(value: string): boolean {
  let removed = false
  saveGlobalConfig(current => {
    const existing = current.gatewayOpenRouterModels ?? []
    const next = existing.filter(item => {
      const keep = item.value !== value
      if (!keep) removed = true
      return keep
    })
    return next.length === existing.length
      ? current
      : { ...current, gatewayOpenRouterModels: next }
  })
  return removed
}

export async function fetchOpenRouterModels(): Promise<OpenRouterModel[]> {
  const response = await fetch(OPENROUTER_MODELS_URL, {
    headers: { accept: 'application/json', 'user-agent': 'gateway-openrouter-models/1.0' },
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) {
    throw new Error(`OpenRouter model catalog returned HTTP ${response.status}`)
  }
  const payload = await response.json() as { data?: OpenRouterModel[] }
  if (!Array.isArray(payload.data)) {
    throw new Error('OpenRouter model catalog returned malformed JSON')
  }
  return payload.data.filter(model => typeof model?.id === 'string' && model.id.length > 0)
}
