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
 * The one figure a provider quota contributes to the readout: how much of the
 * subscription's limit is left. Codex answers from its rollout rate limits and
 * Anthropic from the utilization endpoint, but both reduce to a percentage, so
 * the formatter takes this shape rather than either provider's own type.
 */
export type ProviderQuotaRemaining = {
  remainingPercent: number
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

export function getGatewayProviderLabel(model: string): string {
  const lower = model.toLowerCase()
  if (lower.includes('opencode')) return 'OpenCode'
  if (lower.includes('gateway-claude-')) return 'Anthropic'
  if (lower.includes('gateway-gpt-')) return 'Codex'
  return 'Gateway'
}

export function isAnthropicGatewayModel(model: string): boolean {
  return model.toLowerCase().includes('gateway-claude-')
}

/**
 * The subscription's own limit as `/gateway/anthropic-usage` reports it: the
 * session window and the weekly window, each a fraction of its limit that has
 * been used. The readout carries one number, so it reports the window nearest
 * its limit - the same reduction the Codex reader applies across its windows.
 *
 * `utilization` is a fraction, not a percentage: the provider answers
 * `five_hour.utilization = 0.05` for five percent used, the same scale the
 * `anthropic-ratelimit-unified-*-utilization` reply headers carry, and the same
 * scale the rest of this client assumes - StatusLine and rateLimitMessages both
 * multiply it by 100 to display it.
 */
export function getAnthropicRemainingPercent(
  utilization:
    | {
        five_hour?: { utilization: number | null } | null
        seven_day?: { utilization: number | null } | null
      }
    | null
    | undefined,
): number | null {
  if (!utilization) return null
  const used = [utilization.five_hour, utilization.seven_day]
    .map(window => window?.utilization)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  if (used.length === 0) return null
  return Math.round(Math.max(0, Math.min(100, (1 - Math.max(...used)) * 100)))
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

export function formatBottomBarUsage(
  model: string,
  usage: CurrentUsage | null,
  contextWindowSize: number,
  weekly?: WeeklyUtilization,
  providerQuota?: ProviderQuotaRemaining | null,
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

  // Both providers report one remaining figure, so the label is what tells
  // them apart - and it is only ever printed for the provider the model
  // belongs to, because the caller reads the quota of that same provider.
  if (providerQuota) {
    const provider = getGatewayProviderLabel(model)
    if (provider === 'Codex' || provider === 'Anthropic' || provider === 'OpenCode') {
      parts.push(`${provider} remaining ${providerQuota.remainingPercent}%`)
    }
  }

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
