import { effortLevelsForMistralModel } from './effort-capabilities.mjs'
import { anthropicToOpenCodeChat } from './opencode-go.mjs'

// Mistral AI's public API is OpenAI-compatible on /v1/chat/completions, and it
// also hosts third-party open-weight models under the same key. Those are the
// routes this backend carries: the provider-native id is authoritative and is
// never derived from the Gateway id, because the two do not share a spelling
// (`deepseek-v4-1-flash-1017` is the API id; the picker shows a friendlier
// version).
//
// Probed live 2026-11-04 against api.mistral.ai:
//   - Bearer auth; `reasoning_effort` accepts none|minimal|low|medium|high|xhigh|max
//     and answers 422 with that enum for anything else.
//   - A reasoning reply returns `message.content` as content blocks
//     (`{type:"thinking",thinking:[{type:"text",text}]}` and `{type:"text"}`)
//     rather than a string, and streams the same blocks per delta.
//   - An assistant turn rejects `reasoning_content` as an extra input
//     (`extra_forbidden`), but accepts the thinking blocks back inside
//     `content`, which is how reasoning is echoed on a follow-up turn.
export const MISTRAL_BASE_URL =
  process.env.MISTRAL_BASE_URL || 'https://api.mistral.ai/v1'

export const MISTRAL_ROUTES = {
  'deepseek-v4-1-flash-1017': 'chat-completions',
}

export const MISTRAL_MODEL_IDS = Object.keys(MISTRAL_ROUTES)

/**
 * Gateway id for a provider-native model id.
 *
 * The catalog spells this one out: the API keeps DeepSeek's dated build suffix
 * (`-1017`) while the picker and Gateway namespace carry the generation. Adding
 * a model means adding its row here and in the shared catalog; a model with no
 * row still gets a deterministic id so a live `/v1/models` entry can be
 * inspected without a code change.
 */
const MISTRAL_GATEWAY_IDS = {
  'deepseek-v4-1-flash-1017': 'gateway-mistral-deepseek-v4.1-flash',
}

export function mistralGatewayId(model) {
  const mapped = MISTRAL_GATEWAY_IDS[model]
  if (mapped) return mapped
  return `gateway-mistral-${model
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '')}`
}

/**
 * The Gateway ids for one provider model. Vibe and Studio are separate
 * credential types - the key decides which budget a request spends - so the
 * picker exposes one route per budget instead of a single route whose cost
 * depends on hidden fallback state. The unsuffixed id stays routable for
 * existing transcripts and direct callers, and keeps its old Vibe-first
 * behaviour; it is hidden from discovery.
 */
export function mistralRouteVariants(model) {
  const base = mistralGatewayId(model).replace(/^gateway-mistral-/, '')
  return [
    { id: `gateway-mistral-vibe-${base}`, credential: 'vibe' },
    { id: `gateway-mistral-api-${base}`, credential: 'api' },
    { id: mistralGatewayId(model), credential: 'auto' },
  ]
}

export function mistralEffortLevels(model) {
  return effortLevelsForMistralModel(model)
}

export function mistralEndpoint() {
  return `${MISTRAL_BASE_URL.replace(/\/$/, '')}/chat/completions`
}

/**
 * The Conversations API. Chat completions refuses the `web_search` connector
 * for this account and model ("WebSearchTool connector is not supported" /
 * "does not support builtin connectors"), but the same key runs it here -
 * probed live 2026-11-07 on both the Vibe and the Studio key, with a
 * Mistral-hosted model.
 */
export function mistralConversationsEndpoint() {
  return `${MISTRAL_BASE_URL.replace(/\/$/, '')}/conversations`
}

/** The Mistral-hosted model the search route runs on. */
export function mistralSearchModel() {
  return process.env.MODEL_GATEWAY_MISTRAL_SEARCH_MODEL || 'mistral-small-latest'
}

export function mistralHeaders(apiKey, stream = false) {
  return {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
    accept: stream ? 'text/event-stream' : 'application/json',
    'user-agent': 'gateway-model-gateway/0.1',
  }
}

/**
 * The Anthropic request as Mistral chat completions.
 *
 * Reuses the shared converter so tools, images and usage behave exactly like
 * the other chat-completions routes. The one difference is how an assistant
 * turn's reasoning is echoed: Mistral refuses `reasoning_content` as an extra
 * input, so thinking is re-sent as a `thinking` content block instead.
 */
export function anthropicToMistralChat(body, upstreamModel, querySource) {
  return capMistralImages(
    anthropicToOpenCodeChat(
      body,
      upstreamModel,
      querySource,
      {},
      { assistantReasoning: 'content-blocks' },
    ),
  )
}

/**
 * Mistral accepts at most 20 images in one chat request. The 21st is not
 * rejected with a validation error: the API answers HTTP 503 "Service
 * unavailable" (probed live 2026-11-06: 20 images pass, 21 fail, at any
 * payload size or placement). That is fatal for a harness whose history
 * accumulates screenshots - once a conversation holds 21, every later turn
 * re-sends all of them and the route is permanently unusable.
 *
 * The newest images are the ones the turn is about, so older ones become a
 * text marker. The block stays in place, which keeps message order and role
 * alternation exactly as the provider would otherwise receive them.
 */
export const MISTRAL_MAX_IMAGES = 20

export function capMistralImages(request, limit = MISTRAL_MAX_IMAGES) {
  let total = 0
  for (const message of request.messages || []) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block?.type === 'image_url') total += 1
    }
  }
  if (total <= limit) return request

  let drop = total - limit
  const messages = request.messages.map(message => {
    if (drop <= 0 || !Array.isArray(message.content)) return message
    const content = message.content.map(block => {
      if (block?.type !== 'image_url' || drop <= 0) return block
      drop -= 1
      return {
        type: 'text',
        text: `[image omitted: Mistral accepts at most ${limit} images per request]`,
      }
    })
    return { ...message, content }
  })
  return { ...request, messages }
}
