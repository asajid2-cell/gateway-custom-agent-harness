import { getAnthropicRemainingPercent, type ProviderQuotaRemaining } from './bottomBarUsage.js'
import { isGatewayMode } from './model/providers.js'

const ANTHROPIC_USAGE_TIMEOUT_MS = 5_000

/**
 * The subscription's remaining limit, as the gateway reports it.
 *
 * The client cannot ask Anthropic for this itself: a gateway session is
 * deliberately barred from reading Claude.ai auth state (utils/auth.ts), and
 * the account's credential belongs to the gateway process rather than to this
 * one. So the gateway reads the subscription's usage endpoint and serves the
 * figure back here - current whenever it is asked, and for no tokens, so the
 * readout is filled at session start rather than only after a turn.
 *
 * A gateway that cannot read the account reports an empty object, and an empty
 * object is not a limit: rather than a fabricated figure, such a session shows
 * none.
 */
export async function readAnthropicQuota(): Promise<ProviderQuotaRemaining | null> {
  const baseUrl = process.env.CLAUDE_CODE_GATEWAY_BASE_URL?.trim()
  if (!isGatewayMode() || !baseUrl) return null

  let utilization: unknown
  try {
    const response = await fetch(new URL('/gateway/anthropic-usage', baseUrl), {
      signal: AbortSignal.timeout(ANTHROPIC_USAGE_TIMEOUT_MS),
    })
    if (!response.ok) return null
    utilization = await response.json()
  } catch {
    return null
  }

  const remainingPercent = getAnthropicRemainingPercent(
    utilization as Parameters<typeof getAnthropicRemainingPercent>[0],
  )
  return remainingPercent === null ? null : { remainingPercent }
}
