import type { GatewayCredentialName } from '../../utils/gatewayCredentials.js'

/** `new` is the account-provider flow that picks the next free slot. */
export type LoginAction = 'save' | 'new' | 'switch' | 'status' | 'remove'

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
 * login -> one auth.json per account home). The gateway reads those files
 * directly, so they are not vault keys.
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
 * Providers with numbered accounts: the numbered key slots the gateway rotates
 * through, plus Codex account homes. Only these accept `switch`.
 */
export const ACCOUNT_PROVIDERS: ProviderName[] = ['claude', 'codex', 'opencode', 'commandcode', 'mistral']

/**
 * Picker order: the host sign-ins first, because they are the ones an operator
 * reaches for on a fresh machine, then the provider keys.
 */
export const PROVIDERS: ProviderName[] = ['claude', 'codex', ...KEY_PROVIDERS]

/** Spelling variants an operator is likely to type (and the module accepts). */
const ALIASES: Record<string, ProviderName> = {
  anthropic: 'claude',
  chatgpt: 'codex',
  openai: 'codex',
  'mistral-vibe': 'mistralvibe',
}

export const CODEX_ACCOUNT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function isKeyProvider(name: ProviderName): name is KeyProviderName {
  return Object.hasOwn(PROVIDER_CREDENTIALS, name)
}

export function isAccountProvider(name: ProviderName): boolean {
  return ACCOUNT_PROVIDERS.includes(name)
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
  | {
      kind: 'provider'
      provider: ProviderName
      action: LoginAction
      /** Exactly what the provider handler receives after the provider word. */
      args: string
      /** Account number or name for switch/remove, name for new. */
      target?: string
      scope?: 'session' | 'global'
    }
  | { kind: 'error'; message: string }

function error(message: string): LoginPlan {
  return { kind: 'error', message }
}

function providerWords(provider: ProviderName): string {
  if (provider === 'codex') {
    return 'new [name], switch <number|name> [session|global], status, or remove <number|name>'
  }
  if (provider === 'claude') {
    return 'new [name], switch <number|name|email> [session|global], status, or remove <number|name|email>'
  }
  if (isAccountProvider(provider)) {
    return 'new, switch <number> [session|global], status, or remove'
  }
  return 'new, status, or remove'
}

/** Host and Claude accounts may be named; the key providers are numbered. */
function namedTargets(provider: ProviderName): boolean {
  return provider === 'codex' || provider === 'claude'
}

/**
 * `/login` is usable with no argument: the picker supplies the provider. A
 * provider may also be named directly with an optional action; `status` or
 * `remove` alone open the picker in that mode.
 *
 * Account providers accept the same `switch <number> [session|global]` grammar
 * the gateway has always understood, and Codex accepts an account name as well
 * because its homes are named.
 */
export function planLogin(args: string): LoginPlan {
  const words = args.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return { kind: 'pick', action: 'save' }

  const first = words[0]!.toLowerCase()
  if ((first === 'status' || first === 'remove') && words.length === 1) {
    return { kind: 'pick', action: first }
  }

  const provider = (ALIASES[first] ?? first) as ProviderName
  if (!PROVIDERS.includes(provider)) {
    return error(`Unknown provider: ${first}. Use ${PROVIDERS.join(', ')}, or /login for a picker.`)
  }

  const rest = words.slice(1)
  if (rest.length === 0) return { kind: 'provider', provider, action: 'save', args: '' }

  const action = rest[0]!.toLowerCase()
  const argsText = rest.join(' ')

  if (action === 'switch') {
    if (!isAccountProvider(provider)) {
      return error(`${provider} has no accounts to switch. Use /login ${provider} to manage its key.`)
    }
    const target = rest[1]
    if (!target) {
      return error(`Use /login ${provider} ${providerWords(provider)}.`)
    }
    if (rest.length > 3) return error(`Use /login ${provider} ${providerWords(provider)}.`)
    const scopeWord = rest[2]?.toLowerCase()
    if (scopeWord && scopeWord !== 'session' && scopeWord !== 'global') {
      return error(`Switch scope is session or global, not ${scopeWord}.`)
    }
    if (!namedTargets(provider) && !/^[1-9][0-9]*$/.test(target)) {
      return error(`${provider} accounts are numbered; use /login ${provider} switch <number> [session|global].`)
    }
    return {
      kind: 'provider',
      provider,
      action: 'switch',
      args: argsText,
      target,
      scope: scopeWord === 'global' ? 'global' : 'session',
    }
  }

  if (action === 'new') {
    if (rest.length > 2) return error(`Use /login ${provider} ${providerWords(provider)}.`)
    const name = rest[1]
    if (name && !namedTargets(provider)) {
      return error(`Only a Claude or Codex account takes a name; use /login ${provider} new.`)
    }
    if (name && !CODEX_ACCOUNT_NAME.test(name)) {
      return error(`Account names use letters, digits, dot, dash, or underscore: ${name}`)
    }
    return {
      kind: 'provider',
      provider,
      action: 'new',
      args: name ? `new ${name}` : 'new',
      ...(name ? { target: name } : {}),
    }
  }

  if (action === 'remove') {
    if (rest.length > 2) return error(`Use /login ${provider} ${providerWords(provider)}.`)
    const target = rest[1]
    if (target && !namedTargets(provider)) {
      return error(`/login ${provider} remove targets the active key; it takes no account.`)
    }
    if (namedTargets(provider) && !target) {
      return error(`Name the ${provider} account to remove: /login ${provider} remove <number|name${provider === 'claude' ? '|email' : ''}>.`)
    }
    return {
      kind: 'provider',
      provider,
      action: 'remove',
      args: target ? `remove ${target}` : 'remove',
      ...(target ? { target } : {}),
    }
  }

  if (action === 'status') {
    if (rest.length > 1) return error(`/login ${provider} status takes no argument.`)
    return { kind: 'provider', provider, action: 'status', args: 'status' }
  }

  return error(`/login ${provider} takes ${providerWords(provider)}.`)
}
