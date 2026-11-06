import { getModelUsage } from '../../bootstrap/state.js'
import type { LocalCommandCall } from '../../types/command.js'
import { formatRelativeTime, formatTokens } from '../../utils/format.js'
import {
  QUOTA_WINDOW_LABEL,
  availableQuotaKinds,
  getGatewayProviderDisplayName,
  getGatewayProviderLabel,
  preferredQuotaKind,
  type ProviderName,
  type ProviderQuota,
  type QuotaWindowKind,
} from '../../utils/bottomBarUsage.js'
import { isGatewayMode } from '../../utils/model/providers.js'
import { readQuotaForProvider } from '../../utils/providerQuota.js'

/**
 * The windows in the order the report reads them: the route's own budget first
 * (Mistral's Vibe or API pool), then the rest in the cycle order the bottom bar
 * clicks through.
 */
function orderedKinds(provider: ProviderName, model: string, quota: ProviderQuota): QuotaWindowKind[] {
  const kinds = availableQuotaKinds(provider, quota)
  const preferred = preferredQuotaKind(model)
  if (!preferred || !kinds.includes(preferred)) return kinds
  return [preferred, ...kinds.filter(kind => kind !== preferred)]
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}

function windowLine(kind: QuotaWindowKind, quota: ProviderQuota, now: Date): string {
  const window = quota.windows[kind]!
  const used = clampPercent(window.usedPercent)
  const left = 100 - used
  const reset =
    window.resetsAt === null
      ? 'no reset time'
      : `resets ${formatRelativeTime(new Date(window.resetsAt), { now })}`
  const stale = quota.stale ? ' (stale)' : ''
  return `  ${QUOTA_WINDOW_LABEL[kind].padEnd(8)} ${String(used).padStart(3)}% used · ${String(left).padStart(3)}% left · ${reset}${stale}`
}

/** This run's charged tokens per model, heaviest first. */
function sessionRows(): { model: string; tokens: number }[] {
  return Object.entries(getModelUsage())
    .map(([model, usage]) => ({
      model,
      tokens:
        usage.inputTokens +
        usage.outputTokens +
        usage.cacheReadInputTokens +
        usage.cacheCreationInputTokens,
    }))
    .filter(row => row.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
}

function sessionLines(): string[] {
  const rows = sessionRows()
  if (rows.length === 0) return ['This chat: no tokens charged yet.']
  const total = rows.reduce((sum, row) => sum + row.tokens, 0)
  const nameWidth = Math.min(40, Math.max(...rows.map(row => row.model.length)))
  return [
    `This chat: ${formatTokens(total)} tokens across ${rows.length} model${rows.length === 1 ? '' : 's'}`,
    ...rows.map(row => `  ${row.model.padEnd(nameWidth)}  ${formatTokens(row.tokens)}`),
  ]
}

export const call: LocalCommandCall = async (args, context) => {
  const json = /(^|\s)--json(\s|$)/.test(args)
  const model = context.options.mainLoopModel
  const gateway = isGatewayMode()
  const provider = getGatewayProviderLabel(model)

  // Not a route with subscription windows: report that plainly rather than
  // printing an empty table that reads like a zero.
  if (!gateway || provider === 'Gateway') {
    const value = gateway
      ? `No subscription limit for ${model}: this route is not one of the metered providers (${getGatewayProviderDisplayName(model)}).`
      : 'This session is not in gateway mode, so there is no upstream limit to report.'
    return {
      type: 'text',
      value: json ? JSON.stringify({ model, provider: null, gateway, quota: null }, null, 2) : value,
    }
  }

  let read: ProviderQuota | null
  try {
    read = await readQuotaForProvider(provider)
  } catch (error) {
    const value = `Could not read ${provider} limits: ${error instanceof Error ? error.message : String(error)}`
    return {
      type: 'text',
      value: json
        ? JSON.stringify(
            { model, provider, gateway, quota: null, error: error instanceof Error ? error.message : String(error) },
            null,
            2,
          )
        : value,
    }
  }

  const quota = read
  if (!quota) {
    const value = `${provider} reported no limit for ${model}. The route is reachable; the upstream has no window to show.`
    return {
      type: 'text',
      value: json ? JSON.stringify({ model, provider, gateway, quota: null }, null, 2) : value,
    }
  }

  if (json) {
    return {
      type: 'text',
      value: JSON.stringify(
        {
          model,
          provider,
          gateway,
          quota,
          session: { totalTokens: sessionRows().reduce((sum, row) => sum + row.tokens, 0), models: sessionRows() },
        },
        null,
        2,
      ),
    }
  }

  const now = new Date()
  const lines = [
    `${getGatewayProviderDisplayName(model)} limits - ${model}`,
    ...orderedKinds(provider, model, quota).map(kind => windowLine(kind, quota, now)),
  ]
  if (quota.account !== undefined) lines.push(`  Account: key ${quota.account}`)
  lines.push(`  Read ${formatRelativeTime(new Date(quota.asof), { now })}`)
  lines.push('', ...sessionLines())
  return { type: 'text', value: lines.join('\n') }
}
