import catalog from '../../../scripts/effort-capabilities.json'
import { normalizeGatewayModelId } from './gatewayModelIds.js'

/**
 * Whether a Gateway model's own backend executes Anthropic's server-side
 * web_search tool.
 *
 * Anthropic's WebSearch is a *server-side* tool: the harness declares
 * `{ type: 'web_search_20250305', name: 'web_search' }` on the request and the
 * provider runs the search on its own infrastructure, streaming back
 * `server_tool_use` + `web_search_tool_result` blocks. The model in the outer
 * conversation therefore does not need any search ability of its own - but the
 * provider endpoint it is addressed to does have to execute that schema.
 *
 * Probed route by route (2026-11-07, re-probed live through the Gateway):
 *   - `gateway-claude-haiku-*` SERVES - Anthropic passthrough; the subscription
 *                                   runs the tool and streams real
 *                                   `web_search_tool_result` blocks with URLs.
 *                                   Listed FIRST because it is the cheapest route
 *                                   that returns citable URLs, and because the
 *                                   search is its own request: a DeepSeek session
 *                                   on Command Code or Mistral searches here
 *                                   without a Codex or Anthropic subagent.
 *   - `gateway-gpt-*`   SERVES      - Codex hosted `{type:'web_search'}`,
 *                                   translated in `anthropicToCodex`. No URLs in
 *                                   `annotations` (always empty), so the answer
 *                                   text carries the citations
 *   - `gateway-amd-*`   rejects     - HTTP 400 "does not support native web search"
 *   - commandcode/mistral/opencode - emit a `tool_use` named `web_search` that
 *                                   nothing executes; opencode-zen is 403
 *                                   ("free tier can only be used inside OpenCode")
 *
 * The `gateway-ds-*` routes served this until their credential left the vault;
 * they are no longer listed, because a listed route that answers 401 is a
 * redirect target that can never serve a search. Command Code was re-checked the
 * same day and has no hosted tool to map onto (its API accepts only
 * `{"type":"function"}` declarations), and Mistral refuses the connector on
 * chat completions (`WebSearchTool connector is not supported`) and on its
 * hosted DeepSeek model ("does not support builtin connectors"); its
 * Conversations API does serve `web_search`, which is the route to add when that
 * path is built.
 *
 * Only the backends that actually run the search are listed. Note this says
 * nothing about whether a *session* on the model can search - see
 * `gatewayWebSearchAvailability` for that.
 */
export function gatewayModelSupportsWebSearch(model: string): boolean {
  const entries = catalog.gatewayWebSearch?.serverToolModels
  if (!Array.isArray(entries)) return false
  const canonical = normalizeGatewayModelId(model)
  return entries.some(entry => entry.toLowerCase() === canonical.toLowerCase())
}

/**
 * Whether a Gateway session on this model can web-search at all.
 *
 * This is deliberately *not* the same question as `gatewayModelSupportsWebSearch`.
 * WebSearchTool runs the search as its own nested request, so a session can
 * search whenever *some* route can - the request is simply addressed there. A
 * Command-Code- or Codex-routed session that never executes the server tool
 * still gets real search results, because the nested request lands on DeepSeek.
 *
 * Withholding the tool from those sessions (the natural reading of a per-model
 * capability check) would hide a working capability behind an unrelated
 * limitation, which is the defect this whole change exists to remove.
 *
 * False only when the catalog lists no serviceable backend, in which case the
 * redirect has nowhere to go and offering the tool would fail at call time.
 */
export function gatewayWebSearchAvailability(_model: string): boolean {
  const entries = catalog.gatewayWebSearch?.serverToolModels
  return (
    Array.isArray(entries) &&
    entries.some(entry => typeof entry === 'string' && entry.length > 0)
  )
}

/**
 * The Gateway model the search request should actually be sent to.
 *
 * The search runs as its own nested request, so the model running the outer
 * conversation does not have to be the model that searches - and in practice it
 * often cannot be: a Command-Code- or OpenCode-routed session has no backend
 * that executes the server tool. Sending the search to the requested model when
 * it can search, and otherwise to the first listed one, is what makes WebSearch
 * work in any Gateway session. With the Claude haiku route first, that redirect
 * lands on the cheapest route that returns citable URLs, so a DeepSeek session
 * on Command Code or Mistral never needs a subagent to search.
 *
 * Falls back to the requested model when nothing is listed, so a misconfigured
 * catalog degrades to the previous behaviour instead of silently picking some
 * unrelated route.
 */
export function resolveGatewayWebSearchModel(requested: string): string {
  if (gatewayModelSupportsWebSearch(requested)) return requested
  const entries = catalog.gatewayWebSearch?.serverToolModels
  const first = Array.isArray(entries)
    ? entries.find(entry => typeof entry === 'string' && entry.length > 0)
    : undefined
  return first ?? requested
}

/**
 * The backends a search can be run on, in preference order.
 *
 * This is the *choice* surface: the tool's `provider`/`providers` inputs name
 * one of these ids, and the order here is what `auto` follows. It is kept next
 * to the catalog lookup rather than in the tool so a route becomes offered (and
 * a label becomes accurate) in one place.
 *
 * A route is offered only once its backend is judged able to execute the server
 * tool, so the Mistral Conversations route appears here automatically when its
 * model is added to `serverToolModels`.
 */
export type GatewaySearchProvider = 'haiku' | 'luna' | 'mistral'

export type GatewaySearchRoute = {
  id: GatewaySearchProvider
  /** What the user and the model see, so a run names who served it. */
  label: string
  model: string
}

const SEARCH_ROUTES: readonly GatewaySearchRoute[] = [
  { id: 'haiku', label: 'Claude Haiku 5.5', model: 'gateway-claude-haiku-5-5' },
  { id: 'luna', label: 'Codex Luna', model: 'gateway-gpt-6-luna' },
  { id: 'mistral', label: 'Mistral web search', model: 'gateway-mistral-search' },
]

export function gatewaySearchRoutes(): GatewaySearchRoute[] {
  return SEARCH_ROUTES.filter(route => gatewayModelSupportsWebSearch(route.model))
}

export function gatewaySearchRoute(
  id: GatewaySearchProvider,
): GatewaySearchRoute | undefined {
  return gatewaySearchRoutes().find(route => route.id === id)
}

/** The human label for a route, for the tool result line. */
export function gatewaySearchLabel(model: string): string {
  const route = SEARCH_ROUTES.find(
    candidate => candidate.model.toLowerCase() === model.toLowerCase(),
  )
  return route?.label ?? model
}
