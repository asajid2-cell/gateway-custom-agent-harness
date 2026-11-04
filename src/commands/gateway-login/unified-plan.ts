import type { GatewayCredentialName } from '../../utils/gatewayCredentials.js'

/** `new` is the account-provider flow that picks the next free slot. */
export type LoginAction = 'save' | 'new' | 'status' | 'remove'

export type ProviderName = 'opencode' | 'commandcode' | 'deepseek' | 'openrouter'

export const PROVIDER_CREDENTIALS: Record<ProviderName, GatewayCredentialName> = {
  opencode: 'opencode-go',
  commandcode: 'commandcode',
  deepseek: 'ds',
  openrouter: 'openrouter',
}

export const PROVIDERS = Object.keys(PROVIDER_CREDENTIALS) as ProviderName[]

export const PICKER_LABELS: Record<ProviderName, string> = {
  opencode: 'OpenCode Go',
  commandcode: 'Command Code',
  deepseek: 'DeepSeek',
  openrouter: 'OpenRouter (stored only; no gateway route yet)',
}

export type LoginPlan =
  | { kind: 'pick'; action: 'save' | 'status' | 'remove' }
  | { kind: 'provider'; provider: ProviderName; action: LoginAction }
  | { kind: 'error'; message: string }

/**
 * `/login` is usable with no argument: the picker supplies the provider. A
 * provider may also be named directly with an optional action; `status` or
 * `remove` alone open the picker in that mode.
 */
export function planLogin(args: string): LoginPlan {
  const words = args.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return { kind: 'pick', action: 'save' }

  const first = words[0]!.toLowerCase()
  if (first === 'status' || first === 'remove') {
    if (words.length > 1) return { kind: 'error', message: `/${first} takes no further argument.` }
    return { kind: 'pick', action: first }
  }

  if (!(first in PROVIDER_CREDENTIALS)) {
    return {
      kind: 'error',
      message: `Unknown provider: ${first}. Use ${PROVIDERS.join(', ')}, or /login for a picker.`,
    }
  }

  const provider = first as ProviderName
  if (words.length === 1) return { kind: 'provider', provider, action: 'save' }
  if (words.length > 2) return { kind: 'error', message: `/${first} takes new, status, or remove.` }

  const action = words[1]!
  if (action !== 'new' && action !== 'status' && action !== 'remove') {
    return { kind: 'error', message: `/${first} takes new, status, or remove.` }
  }
  return { kind: 'provider', provider, action }
}
