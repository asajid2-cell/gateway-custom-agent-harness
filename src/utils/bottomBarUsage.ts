import { calculateContextPercentages } from './context.js'
import { quotePowerShellLiteral } from './shell/powershellQuote.js'
import { formatTokens } from './format.js'

export type CurrentUsage = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
}

export type WeeklyUtilization = {
  utilization: number
}

/**
 * A subscription's limits, normalized to the one shape every provider's quota
 * is reduced to before it reaches the readout: per-window usage as the percent
 * that has been *used*, and the epoch-ms time each window resets.
 *
 * `H` is the hourly window (Codex's 5-hour window, Anthropic's `five_hour`,
 * OpenCode's `rolling`), `W` the weekly, `M` the monthly. A provider reports
 * only the windows it has; one it omits is simply not shown, rather than
 * printed as a zero.
 */
export type QuotaWindowKind = 'H' | 'W' | 'M' | 'V' | 'A'
export type QuotaWindow = {
  /** Percent of the window's limit that has been used, 0-100. */
  usedPercent: number
  /** Epoch ms when the window resets, or null when the provider does not say. */
  resetsAt: number | null
}
export type ProviderName = 'Codex' | 'Anthropic' | 'OpenCode' | 'Command Code' | 'Mistral'
export type ProviderQuota = {
  windows: Partial<Record<QuotaWindowKind, QuotaWindow>>
  /** Epoch ms when the upstream last answered. */
  asof: number
  /** Served from a fallback or an older reading rather than a fresh one. */
  stale: boolean
  /** The OpenCode key number actually serving, when the provider reports it. */
  account?: number
}

/**
 * The windows each provider has, in the order a click cycles them. Weekly
 * leads, so it is what the readout shows until a click moves it on.
 */
export const QUOTA_CYCLE: Record<ProviderName, QuotaWindowKind[]> = {
  Codex: ['W', 'H'],
  Anthropic: ['W', 'H'],
  OpenCode: ['W', 'H', 'M'],
  'Command Code': ['W', 'H', 'M'],
  // Vibe leads because it is the budget the route spends first.
  Mistral: ['V', 'A'],
}

/**
 * The window's name in the readout. `H`/`W`/`M` are the compact hour, week and
 * month windows the existing providers print; `V`/`A` name Mistral's two
 * budgets so neither is mistaken for a time window.
 */
export const QUOTA_WINDOW_LABEL: Record<QuotaWindowKind, string> = {
  H: 'H',
  W: 'W',
  M: 'M',
  V: 'vibe',
  A: 'api',
}

/**
 * The windows a provider actually reported, in cycle order. A window the
 * provider omitted is left out rather than shown as a zero, so this is the
 * list both the shown window and every click step are drawn from.
 */
export function availableQuotaKinds(
  provider: ProviderName,
  quota: ProviderQuota,
): QuotaWindowKind[] {
  return QUOTA_CYCLE[provider].filter(kind => quota.windows[kind])
}

/**
 * The window a click moves to: the one after `current` in the provider's
 * reported windows, wrapping back to the first. The first window is what a
 * fresh control shows, and a window that vanished between readings falls back
 * to it. With fewer than two windows there is nothing to cycle to, so the same
 * window comes back.
 */
export function nextQuotaKind(
  provider: ProviderName,
  quota: ProviderQuota,
  current: QuotaWindowKind | null,
): QuotaWindowKind | null {
  const available = availableQuotaKinds(provider, quota)
  if (available.length === 0) return null
  const index = current === null ? -1 : available.indexOf(current)
  if (index < 0) return available[0]
  return available[(index + 1) % available.length]
}

/**
 * This run's charged-token totals, keyed by model. Structural rather than the
 * bootstrap ModelUsage type so the formatter stays free of that import.
 */
export type SessionTokenTotals = {
  [model: string]: {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
  }
}

/** Every token the provider billed for: input, output and both cache figures. */
export function getSessionChargedTokens(totals: SessionTokenTotals): number {
  let total = 0
  for (const usage of Object.values(totals)) {
    total +=
      usage.inputTokens +
      usage.outputTokens +
      usage.cacheReadInputTokens +
      usage.cacheCreationInputTokens
  }
  return total
}

/**
 * The one number the bottom bar shows for the session: a plain total, with no
 * model name and no split - the breakdown lives behind a click.
 */
export function formatSessionTokenTotal(totals: SessionTokenTotals): string {
  return `${formatTokens(getSessionChargedTokens(totals))} total`
}

export function getContextUsageValues(
  usage: CurrentUsage | null,
  contextWindowSize: number,
): {
  usedTokens: number | null
  remainingTokens: number | null
  usedPercent: number | null
  remainingPercent: number | null
} {
  if (!usage) {
    return {
      usedTokens: null,
      remainingTokens: null,
      usedPercent: null,
      remainingPercent: null,
    }
  }

  const usedTokens =
    usage.input_tokens +
    usage.cache_creation_input_tokens +
    usage.cache_read_input_tokens
  const percentages = calculateContextPercentages(usage, contextWindowSize)

  return {
    usedTokens,
    remainingTokens: Math.max(0, contextWindowSize - usedTokens),
    usedPercent: percentages.used,
    remainingPercent: percentages.remaining,
  }
}

export function getWeeklyRemainingPercent(
  weekly: WeeklyUtilization | undefined,
): number | null {
  if (!weekly || !Number.isFinite(weekly.utilization)) return null
  return Math.round(Math.max(0, Math.min(1, 1 - weekly.utilization)) * 100)
}

export function getGatewayProviderLabel(model: string): ProviderName | 'Gateway' {
  const lower = model.toLowerCase()
  if (lower.includes('opencode')) return 'OpenCode'
  if (lower.includes('commandcode')) return 'Command Code'
  if (lower.includes('mistral')) return 'Mistral'
  if (lower.includes('gateway-claude-')) return 'Anthropic'
  if (lower.includes('gateway-gpt-')) return 'Codex'
  return 'Gateway'
}

export function isAnthropicGatewayModel(model: string): boolean {
  return model.toLowerCase().includes('gateway-claude-')
}

// A session can be resumed by id or by name: `cc --resume <name>` resolves the
// same transcript by exact custom title, so a name replaces the id as the
// target. It is quoted because a name is free text - spaces and apostrophes are
// both legal in one - and absent when the session has no name, which leaves the
// id form.
export function formatSessionResumeCommand(
  directory: string,
  sessionId: string,
  name?: string | null,
): string {
  const target = name ? quotePowerShellLiteral(name) : sessionId
  return `cd ${quotePowerShellLiteral(directory)}; & cc --resume ${target}`
}

/**
 * One window of a provider's quota as the readout prints it: which provider,
 * which window, and how much of that window is left. A window the provider did
 * not report prints nothing, and a figure served from a fallback says so.
 */
export function formatProviderQuota(
  provider: ProviderName,
  quota: ProviderQuota,
  kind: QuotaWindowKind,
): string | null {
  const window = quota.windows[kind]
  if (!window) return null
  const remaining = Math.round(Math.max(0, Math.min(100, 100 - window.usedPercent)))
  return `${provider} ${QUOTA_WINDOW_LABEL[kind]} remaining ${remaining}%${quota.stale ? ' (stale)' : ''}`
}

export function formatBottomBarUsage(
  model: string,
  usage: CurrentUsage | null,
  contextWindowSize: number,
  weekly?: WeeklyUtilization,
  options?: { includeModel?: boolean },
): string {
  const context = getContextUsageValues(usage, contextWindowSize)
  const weeklyRemaining = getWeeklyRemainingPercent(weekly)
  const parts: string[] = []

  // The provider used to lead this readout as its own part ("OpenCode"), which
  // named the provider a second time: the model id carries it already, and a
  // custom status line prints the model next door on the same row. The model is
  // the fact worth the columns, so the bare label is the part that goes.
  //
  // A custom status line already prints the model, so repeating it here would
  // be the second copy of it on the same row. Callers that have no status line
  // pass includeModel - there this readout is the only place the model shows.
  if (options?.includeModel !== false) {
    parts.push(`model ${model}`)
  }

  // The provider quota used to be a part of this string. It is its own element
  // now (ProviderQuotaControl), because it is the one part a click changes, so
  // the readout is only the model, the tokens, the context and the weekly share.

  if (usage) {
    parts.push(
      `usage ${formatTokens(usage.input_tokens)} in · ${formatTokens(usage.output_tokens)} out`,
    )
  } else {
    parts.push('usage unavailable')
  }

  if (context.usedTokens !== null) {
    parts.push(
      `context ${formatTokens(context.usedTokens)}/${formatTokens(contextWindowSize)} (${context.usedPercent}%) · ${formatTokens(context.remainingTokens!)} left`,
    )
  } else {
    parts.push('context unavailable')
  }

  if (weeklyRemaining !== null) {
    parts.push(`weekly ${weeklyRemaining}% left`)
  }

  return parts.join(' · ')
}
