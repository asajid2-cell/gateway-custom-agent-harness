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

export function mistralEffortLevels(model) {
  return effortLevelsForMistralModel(model)
}

export function mistralEndpoint() {
  return `${MISTRAL_BASE_URL.replace(/\/$/, '')}/chat/completions`
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
  return anthropicToOpenCodeChat(
    body,
    upstreamModel,
    querySource,
    {},
    { assistantReasoning: 'content-blocks' },
  )
}
