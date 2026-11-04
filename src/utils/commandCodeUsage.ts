import { isGatewayMode } from './model/providers.js'
import { getSessionId } from '../bootstrap/state.js'
import type { ProviderQuota, QuotaWindow, QuotaWindowKind } from './bottomBarUsage.js'

const COMMANDCODE_USAGE_TIMEOUT_MS = 5_000

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
 * Reduce a `/gateway/commandcode-usage` reply to the one normalized shape.
 *
 * The gateway reads the Command Code credits and subscription endpoints and
 * normalizes them - five-hour -> H, weekly -> W, monthly credits -> M - so the
 * client consumes only `windows`.
 */
export function commandCodeQuotaFromPayload(payload: unknown): ProviderQuota | null {
  if (!isObject(payload)) return null
  const windows: ProviderQuota['windows'] = {}
  if (!isObject(payload.windows)) return null

  for (const kind of WINDOW_KINDS) {
    const window = normalizedWindow((payload.windows as Record<string, unknown>)[kind])
    if (window) windows[kind] = window
  }
  if (Object.keys(windows).length === 0) return null
  const account = finiteNumber(payload.account)
  return {
    windows,
    asof: finiteNumber(payload.asof) ?? Date.now(),
    stale: payload.stale === true,
    ...(account === null ? {} : { account }),
  }
}

/**
 * The Command Code subscription's limits, as the gateway reports them. The
 * credential pool is keyed by session, so the request carries the session id
 * the gateway should read for. An empty payload is "no figure" and returns
 * null, while a gateway that cannot be reached throws so the caller keeps the
 * last good figure instead of flickering to nothing.
 */
export async function readCommandCodeQuota(): Promise<ProviderQuota | null> {
  const baseUrl = process.env.CLAUDE_CODE_GATEWAY_BASE_URL?.trim()
  if (!isGatewayMode() || !baseUrl) throw new Error('commandcode quota needs a gateway base URL')
  const url = new URL('/gateway/commandcode-usage', baseUrl)
  url.searchParams.set('sessionId', getSessionId())
  const response = await fetch(url, {
    signal: AbortSignal.timeout(COMMANDCODE_USAGE_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`commandcode usage answered ${response.status}`)
  return commandCodeQuotaFromPayload(await response.json())
}
