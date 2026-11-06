import { readAnthropicQuota } from './anthropicUsage.js'
import { readOpenCodeQuota } from './opencodeUsage.js'
import { readCommandCodeQuota } from './commandCodeUsage.js'
import { readMistralQuota } from './mistralUsage.js'
import { readCodexQuota } from './codexRateLimits.js'
import type { ProviderName, ProviderQuota } from './bottomBarUsage.js'

/**
 * Read one provider's subscription limits.
 *
 * The readers are kept apart because each speaks to a different upstream
 * endpoint through the gateway, but every caller - the bottom bar and the
 * `/limit` report - needs the same one-line answer, so the mapping lives here
 * rather than in each of them.
 *
 * An unreadable provider throws; the caller decides whether that means "no
 * figure" (as `/limit` does) or "keep the last good one" (as the 10-second
 * bottom-bar poll does).
 */
export function readQuotaForProvider(provider: ProviderName): Promise<ProviderQuota | null> {
  if (provider === 'Anthropic') return readAnthropicQuota()
  if (provider === 'OpenCode') return readOpenCodeQuota()
  if (provider === 'Command Code') return readCommandCodeQuota()
  if (provider === 'Mistral') return readMistralQuota()
  return readCodexQuota()
}
