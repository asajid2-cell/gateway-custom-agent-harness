import { isGatewayMode } from './model/providers.js'
import type { ProviderQuota, QuotaWindow, QuotaWindowKind } from './bottomBarUsage.js'

const ANTHROPIC_USAGE_TIMEOUT_MS = 5_000

const WINDOW_KINDS: QuotaWindowKind[] = ['H', 'W', 'M']

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value))
}

/** A window from the normalized ProviderQuota the gateway serves. */
function normalizedWindow(value: unknown): QuotaWindow | null {
  if (!isObject(value)) return null
  const usedPercent = finiteNumber(value.usedPercent)
  if (usedPercent === null) return null
  return { usedPercent: clampPercent(usedPercent), resetsAt: finiteNumber(value.resetsAt) }
}

/**
 * Reduce a `/gateway/anthropic-usage` reply to the one normalized shape.
 *
 * The gateway reads the subscription's usage endpoint and normalizes it, so the
 * client consumes only `windows` - each window's `usedPercent` is already the
 * percent *used* (0-100) and its reset is epoch ms. Reading the raw utilization
 * object here is what let the unit ambiguity through: a fraction (0-1) and a
 * percentage (0-100) cannot be told apart client-side, so the gateway resolves
 * it instead and the client never sees it.
 */
export function anthropicQuotaFromPayload(payload: unknown): ProviderQuota | null {
  if (!isObject(payload)) return null
  const windows: ProviderQuota['windows'] = {}
  if (!isObject(payload.windows)) return null

  for (const kind of WINDOW_KINDS) {
    const window = normalizedWindow((payload.windows as Record<string, unknown>)[kind])
    if (window) windows[kind] = window
  }
  if (Object.keys(windows).length === 0) return null
  return {
    windows,
    asof: finiteNumber(payload.asof) ?? Date.now(),
    stale: payload.stale === true,
  }
}

/**
 * The subscription's limits, as the gateway reports them.
 *
 * The client cannot ask Anthropic for this itself: a gateway session is
 * deliberately barred from reading Claude.ai auth state (utils/auth.ts), and
 * the account's credential belongs to the gateway process rather than to this
 * one. So the gateway reads the subscription's usage endpoint and serves the
 * figure back here - current whenever it is asked, and for no tokens, so the
 * readout is filled at session start rather than only after a turn.
 *
 * A gateway that has nothing to report answers an empty payload, which is not a
 * limit: this returns null so the session shows no figure rather than a
 * fabricated one. A gateway that cannot be reached at all *throws*, so the
 * caller can tell "no figure" apart from "could not read" and keep the last
 * good figure instead of dropping it.
 */
export async function readAnthropicQuota(): Promise<ProviderQuota | null> {
  const baseUrl = process.env.CLAUDE_CODE_GATEWAY_BASE_URL?.trim()
  if (!isGatewayMode() || !baseUrl) throw new Error('anthropic quota needs a gateway base URL')
  const response = await fetch(new URL('/gateway/anthropic-usage', baseUrl), {
    signal: AbortSignal.timeout(ANTHROPIC_USAGE_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`anthropic usage answered ${response.status}`)
  return anthropicQuotaFromPayload(await response.json())
}
