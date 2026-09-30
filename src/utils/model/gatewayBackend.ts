import catalog from '../../../scripts/effort-capabilities.json'
import { normalizeGatewayModelId } from './gatewayModelIds.js'

/**
 * Which upstream a model actually spends tokens on.
 *
 * Derived from the same generated catalog the Gateway itself validates its
 * routes against, not from the model's name. The name is not enough:
 * `gateway-opencode-*` covers two different providers, and a prefix heuristic
 * files all of OpenCode's traffic under one of them. Attribution is the whole
 * point of a usage ledger, so it is looked up rather than guessed.
 *
 * `anthropic` is the subscription's own provider. It covers a first-party model
 * that never reaches a Gateway, and equally the `gateway-claude-*` routes, which
 * reach that same provider on the same credential - either way the spend lands
 * on one Anthropic account.
 */
export type ModelBackend =
  | 'anthropic'
  | 'codex'
  | 'deepseek'
  | 'opencode-go'
  | 'opencode-zen'
  | 'commandcode'
  | 'amd-radeon'
  | 'unknown'

type Catalog = {
  opencodeGo?: Record<string, unknown>
  opencodeZen?: Record<string, unknown>
}

const OPENCODE_GO_MODELS = new Set(
  Object.keys((catalog as Catalog).opencodeGo ?? {}).map(id =>
    id.toLowerCase(),
  ),
)
const OPENCODE_ZEN_MODELS = new Set(
  Object.keys((catalog as Catalog).opencodeZen ?? {}).map(id =>
    id.toLowerCase(),
  ),
)

const OPENCODE_PREFIX = 'gateway-opencode-'

export function resolveModelBackend(model: string): ModelBackend {
  const canonical = normalizeGatewayModelId(model)
  const lower = canonical.toLowerCase()

  // Anything without the Gateway namespace never reaches a backend.
  if (!lower.startsWith('gateway-')) return 'anthropic'

  // The two OpenCode backends share one Gateway prefix, so the upstream id -
  // which the catalog lists per backend - is the only thing that separates them.
  if (lower.startsWith(OPENCODE_PREFIX)) {
    const upstream = lower.slice(OPENCODE_PREFIX.length)
    if (OPENCODE_GO_MODELS.has(upstream)) return 'opencode-go'
    if (OPENCODE_ZEN_MODELS.has(upstream)) return 'opencode-zen'
    return 'unknown'
  }

  if (lower.startsWith('gateway-commandcode-')) return 'commandcode'
  if (lower.startsWith('gateway-amd-')) return 'amd-radeon'
  if (lower.startsWith('gateway-ds-')) return 'deepseek'
  if (lower.startsWith('gateway-gpt-')) return 'codex'
  // The subscription's own models, reached through the Gateway rather than
  // directly. Same provider, same credential, same account.
  if (lower.startsWith('gateway-claude-')) return 'anthropic'

  // A Gateway route this build does not know about. Reported as unknown rather
  // than folded into a neighbour's total.
  return 'unknown'
}
