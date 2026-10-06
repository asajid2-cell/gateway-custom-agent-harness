import { isGatewayMode } from './model/providers.js'
import type { ProviderQuota, QuotaWindow, QuotaWindowKind } from './bottomBarUsage.js'

const CODEX_USAGE_TIMEOUT_MS = 5_000

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
 * Reduce a `/gateway/codex-usage` reply to the one normalized shape.
 *
 * The gateway keeps the long-lived Codex app-server and normalizes its rate
 * limits - the window's duration decides whether it is H, W or M - so the
 * client consumes only `windows`. It no longer spawns `codex app-server` here
 * and no longer scrapes rollout JSONL: both were a per-tick process cost and a
 * stale figure, and the gateway now owns the read.
 */
export function codexQuotaFromPayload(payload: unknown): ProviderQuota | null {
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
 * The Codex account's limits, as the gateway reports them.
 *
 * The gateway holds one long-lived `codex app-server` per gateway and serves
 * its current rate limits, so the client no longer spawns a process per poll.
 * An empty payload is "no figure" and returns null, while a gateway that cannot
 * be reached throws so the caller keeps the last good figure instead of
 * flickering to nothing.
 */
export async function readCodexQuota(): Promise<ProviderQuota | null> {
  const baseUrl = process.env.CLAUDE_CODE_GATEWAY_BASE_URL?.trim()
  if (!isGatewayMode() || !baseUrl) throw new Error('codex quota needs a gateway base URL')
  const response = await fetch(new URL('/gateway/codex-usage', baseUrl), {
    signal: AbortSignal.timeout(CODEX_USAGE_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`codex usage answered ${response.status}`)
  return codexQuotaFromPayload(await response.json())
}
