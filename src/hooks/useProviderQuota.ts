import { useEffect, useState } from 'react'
import { readAnthropicQuota } from '../utils/anthropicUsage.js'
import { readOpenCodeQuota } from '../utils/opencodeUsage.js'
import { readCodexQuota } from '../utils/codexRateLimits.js'
import type { ProviderName, ProviderQuota } from '../utils/bottomBarUsage.js'

// The gateway is asked on a local surface that answers immediately, so the
// figure can move every ten seconds without a provider turn - the cadence the
// three per-provider hooks already polled at.
const QUOTA_REFRESH_MS = 10_000

// The distinction the readout needs: a reading (which may be "nothing to
// report"), or a failure. A failure keeps the last good figure rather than
// dropping it, which is what made the readout flicker to nothing on a 429.
type QuotaRead = { ok: true; quota: ProviderQuota | null } | { ok: false }

async function readProviderQuota(provider: ProviderName): Promise<QuotaRead> {
  try {
    if (provider === 'Anthropic') return { ok: true, quota: await readAnthropicQuota() }
    if (provider === 'OpenCode') return { ok: true, quota: await readOpenCodeQuota() }
    // All three are read from the gateway's normalized endpoints now; Codex no
    // longer spawns a local app-server.
    return { ok: true, quota: await readCodexQuota() }
  } catch {
    return { ok: false }
  }
}

/**
 * The selected provider's subscription limits, or null when there is nothing to
 * show. The state is tagged with the provider it was read for, so switching
 * models never shows one provider's figure under another's name - the returned
 * quota is only the one matching the provider asked for.
 */
export function useProviderQuota(provider: ProviderName | null): ProviderQuota | null {
  const [state, setState] = useState<{ provider: ProviderName; quota: ProviderQuota | null } | null>(null)

  useEffect(() => {
    let cancelled = false
    let inFlight = false

    if (!provider) {
      setState(null)
      return () => {
        cancelled = true
      }
    }

    const refresh = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const result = await readProviderQuota(provider)
        if (cancelled) return
        setState(previous => {
          if (!result.ok) {
            if (previous && previous.provider === provider && previous.quota) {
              return { provider, quota: { ...previous.quota, stale: true } }
            }
            return { provider, quota: null }
          }
          return { provider, quota: result.quota }
        })
      } finally {
        inFlight = false
      }
    }
    void refresh()
    const interval = setInterval(() => void refresh(), QUOTA_REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [provider])

  return state && state.provider === provider ? state.quota : null
}
