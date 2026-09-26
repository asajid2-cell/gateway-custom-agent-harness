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

export type CodexQuotaDisplay = {
  remainingPercent: number
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
  if (lower.includes('gateway-gpt-')) return 'Codex'
  return 'Gateway'
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
  codexQuota?: CodexQuotaDisplay | null,
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

  if (codexQuota && getGatewayProviderLabel(model) === 'Codex') {
    parts.push(`Codex remaining ${codexQuota.remainingPercent}%`)
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
