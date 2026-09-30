import type { ProviderQuotaRemaining } from './bottomBarUsage.js'
import { isGatewayMode } from './model/providers.js'
import { getSessionId } from '../bootstrap/state.js'

export function getOpenCodeRemainingPercent(payload: unknown): number | null {
  const usage = (payload as { usage?: Record<string, { percent?: unknown }> } | null)?.usage
  if (!usage) return null
  const used = ['rolling', 'weekly', 'monthly']
    .map(name => usage[name]?.percent)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  return used.length === 0 ? null : Math.round(Math.max(0, Math.min(100, 100 - Math.max(...used))))
}

export async function readOpenCodeQuota(): Promise<ProviderQuotaRemaining | null> {
  const baseUrl = process.env.CLAUDE_CODE_GATEWAY_BASE_URL?.trim()
  if (!isGatewayMode() || !baseUrl) return null
  try {
    const url = new URL('/gateway/opencode-usage', baseUrl)
    url.searchParams.set('sessionId', getSessionId())
    const response = await fetch(url, {
      signal: AbortSignal.timeout(5_000),
    })
    if (!response.ok) return null
    const remainingPercent = getOpenCodeRemainingPercent(await response.json())
    return remainingPercent === null ? null : { remainingPercent }
  } catch {
    return null
  }
}
