import type { GatewayCredentialName } from '../../utils/gatewayCredentials.js'

/** `new` is the account-provider flow that picks the next free slot. */
export type LoginAction = 'save' | 'new' | 'status' | 'remove'

/** Providers whose credential is an API key held in the vault. */
export type KeyProviderName =
  | 'opencode'
  | 'commandcode'
  | 'mistral'
  | 'mistralvibe'
  | 'deepseek'
  | 'openrouter'

/**
 * Providers that sign in through their own flow and keep their own credential
 * file: Claude Code (Anthropic OAuth -> credentials.json) and Codex (ChatGPT
 * login -> codex auth.json). The gateway reads both files directly, so these
 * are not vault keys.
 */
export type HostProviderName = 'claude' | 'codex'

export type ProviderName = HostProviderName | KeyProviderName

export const PROVIDER_CREDENTIALS: Record<KeyProviderName, GatewayCredentialName> = {
  opencode: 'opencode-go',
  commandcode: 'commandcode',
  mistral: 'mistral',
  mistralvibe: 'mistralvibe',
  deepseek: 'ds',
  openrouter: 'openrouter',
}

export const KEY_PROVIDERS = Object.keys(PROVIDER_CREDENTIALS) as KeyProviderName[]

/**
 * Picker order: the two host sign-ins first, because they are the ones an
 * operator reaches for on a fresh machine and they were previously only
 * reachable off-gateway.
 */
export const PROVIDERS: ProviderName[] = ['claude', 'codex', ...KEY_PROVIDERS]

/** Spelling variants an operator is likely to type (and the module accepts). */
const ALIASES: Record<string, ProviderName> = {
  anthropic: 'claude',
  chatgpt: 'codex',
  openai: 'codex',
  'mistral-vibe': 'mistralvibe',
}

export function isKeyProvider(name: ProviderName): name is KeyProviderName {
  return Object.hasOwn(PROVIDER_CREDENTIALS, name)
}

export const PICKER_LABELS: Record<ProviderName, string> = {
  claude: 'Claude Code (Anthropic sign-in)',
  codex: 'Codex (ChatGPT sign-in)',
  opencode: 'OpenCode Go',
  commandcode: 'Command Code',
  mistral: 'Mistral Studio',
  mistralvibe: 'Mistral Vibe',
  deepseek: 'DeepSeek',
  openrouter: 'OpenRouter (stored only; no gateway route yet)',
}

export type LoginPlan =
  | { kind: 'pick'; action: 'save' | 'status' | 'remove' }
  | { kind: 'provider'; provider: ProviderName; action: LoginAction }
  | { kind: 'error'; message: string }

function providerWords(provider: ProviderName): string {
  return isKeyProvider(provider)
    ? 'new, status, or remove'
    : 'status or remove (no argument signs in)'
}

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

  const provider = (ALIASES[first] ?? first) as ProviderName
  if (!PROVIDERS.includes(provider)) {
    return {
      kind: 'error',
      message: `Unknown provider: ${first}. Use ${PROVIDERS.join(', ')}, or /login for a picker.`,
    }
  }

  if (words.length === 1) return { kind: 'provider', provider, action: 'save' }
  if (words.length > 2) {
    return { kind: 'error', message: `/${first} takes ${providerWords(provider)}.` }
  }

  const action = words[1]!
  if (action !== 'new' && action !== 'status' && action !== 'remove') {
    return { kind: 'error', message: `/${first} takes ${providerWords(provider)}.` }
  }
  // Host sign-ins have no numbered account slots; `new` is just "sign in".
  const effective: LoginAction = !isKeyProvider(provider) && action === 'new' ? 'save' : action
  return { kind: 'provider', provider, action: effective }
}
