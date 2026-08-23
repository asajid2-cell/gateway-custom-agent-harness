import { isRunningOnHomespace } from './envUtils.js'

export const ANTHROPIC_API_KEY_ENV_VAR = 'ANTHROPIC_API_KEY'
export const DEEPSEEK_API_KEY_ENV_VAR = 'DEEPSEEK_API_KEY'
export const DEEPSEEK_ANTHROPIC_BASE_URL =
  'https://api.deepseek.com/anthropic'
export const DEEPSEEK_V4_PRO_MODEL = 'deepseek-v4-pro'
export const DEEPSEEK_V4_PRO_1M_MODEL = `${DEEPSEEK_V4_PRO_MODEL}[1m]`
export const DEEPSEEK_V4_FLASH_MODEL = 'deepseek-v4-flash'
export const DEEPSEEK_DEFAULT_MODEL = DEEPSEEK_V4_PRO_1M_MODEL
export const DEEPSEEK_SMALL_FAST_MODEL = DEEPSEEK_V4_FLASH_MODEL

export type DirectApiKeySource =
  | typeof ANTHROPIC_API_KEY_ENV_VAR
  | typeof DEEPSEEK_API_KEY_ENV_VAR

export function isDeepSeekProfileRequested(): boolean {
  return (
    process.env.CLAUDEX_PROVIDER?.toLowerCase() === 'deepseek' ||
    process.env.CLAUDEX_DEEPSEEK_MODE?.toLowerCase() === 'true' ||
    process.env.CLAUDEX_DEEPSEEK_MODE === '1'
  )
}

export function getDirectApiKeyFromEnvironment():
  | {
      key: string
      source: DirectApiKeySource
    }
  | null {
  if (
    process.env.DEEPSEEK_API_KEY &&
    (isDeepSeekProfileRequested() ||
      isDeepSeekBaseUrl(process.env.ANTHROPIC_BASE_URL))
  ) {
    return {
      key: process.env.DEEPSEEK_API_KEY,
      source: DEEPSEEK_API_KEY_ENV_VAR,
    }
  }

  const anthropicApiKey = isRunningOnHomespace()
    ? undefined
    : process.env.ANTHROPIC_API_KEY

  if (anthropicApiKey) {
    return {
      key: anthropicApiKey,
      source: ANTHROPIC_API_KEY_ENV_VAR,
    }
  }

  return null
}

export function isDeepSeekBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) {
    return false
  }

  try {
    const url = new URL(baseUrl)
    return (
      url.hostname === 'api.deepseek.com' &&
      (url.pathname === '/anthropic' ||
        url.pathname.startsWith('/anthropic/'))
    )
  } catch {
    return false
  }
}

export function isDeepSeekCompatibleMode(): boolean {
  return (
    isDeepSeekProfileRequested() ||
    isDeepSeekBaseUrl(process.env.ANTHROPIC_BASE_URL)
  )
}

export function getResolvedAnthropicBaseUrl(): string | undefined {
  return (
    process.env.ANTHROPIC_BASE_URL ||
    (isDeepSeekCompatibleMode() ? DEEPSEEK_ANTHROPIC_BASE_URL : undefined)
  )
}

export function stripDeepSeekContextSuffix(model: string): string {
  return model.replace(/\[(1|2)m\]$/i, '')
}

export function isDeepSeekModel(model: string): boolean {
  return stripDeepSeekContextSuffix(model).toLowerCase().startsWith('deepseek-')
}
