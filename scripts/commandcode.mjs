import { effortLevelsForCommandCodeModel } from './effort-capabilities.mjs'

// Command Code fronts third-party models behind one key. Its model namespace is
// provider-native (`deepseek/deepseek-v4.1-flash`, `meituan/LongCat-2.0:free`),
// so the upstream id is never derived from the Gateway id: it is carried
// verbatim, case included.
//
// Verified live 2026-09-16: the Anthropic Messages endpoint at
// /provider/v1/messages rejects every OSS model with "not supported on this
// endpoint. Use /provider/v1/chat/completions for OpenAI and OSS models", so
// this backend speaks chat completions and reuses the OpenCode conversion and
// relay path rather than the Anthropic passthrough. Auth is a Bearer token —
// not Anthropic's x-api-key — on both endpoints.
export const COMMANDCODE_BASE_URL =
  process.env.COMMANDCODE_BASE_URL || 'https://api.commandcode.ai/provider/v1'

export const COMMANDCODE_ROUTES = {
  'deepseek/deepseek-v4.1-flash': 'chat-completions',
  'meituan/LongCat-2.0:free': 'chat-completions',
  'poolside/laguna-s-2.1-free': 'chat-completions',
  'inclusionai/ling-3.0-flash-sante:free': 'chat-completions',
}

export const COMMANDCODE_MODEL_IDS = Object.keys(COMMANDCODE_ROUTES)

/**
 * Gateway id for a provider-native model id.
 *
 * The provider namespace uses `/` for the publisher and `:` for a tier
 * (`meituan/LongCat-2.0:free`), neither of which belongs in a Gateway model id,
 * so the publisher prefix is dropped and the remainder is lowercased with runs
 * of other punctuation collapsed to one `-`. The suffix stays readable —
 * `gateway-commandcode-longcat-2.0-free` — and every id in the shared catalog
 * is written out with the same rule.
 */
export function commandCodeGatewayId(model) {
  const bare = model.slice(model.lastIndexOf('/') + 1)
  return `gateway-commandcode-${bare
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '')}`
}

export function commandCodeEffortLevels(model) {
  return effortLevelsForCommandCodeModel(model)
}

export function commandCodeEndpoint() {
  return `${COMMANDCODE_BASE_URL.replace(/\/$/, '')}/chat/completions`
}

export function commandCodeHeaders(apiKey, stream = false) {
  return {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
    accept: stream ? 'text/event-stream' : 'application/json',
    'user-agent': 'gateway-model-gateway/0.1',
  }
}
