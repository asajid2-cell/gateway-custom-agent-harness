import {
  effortLevelsForOpenCodeZenModel,
  effortWireMapForOpenCodeZenModel,
} from './effort-capabilities.mjs'

export const OPENCODE_ZEN_BASE_URL =
  process.env.OPENCODE_ZEN_BASE_URL || 'https://opencode.ai/zen/v1'

export const OPENCODE_ZEN_ROUTES = {
  'big-pickle': 'chat-completions',
  'mimo-v2.5-free': 'chat-completions',
  'hy3-free': 'chat-completions',
  'nemotron-3-ultra-free': 'chat-completions',
  'nemotron-3.5-lightning-free': 'chat-completions',
  'muse-spark-1.2-contributor-free': 'responses',
}

export const OPENCODE_ZEN_MODEL_IDS = Object.keys(OPENCODE_ZEN_ROUTES)

export function openCodeZenEffortLevels(model) {
  return effortLevelsForOpenCodeZenModel(model)
}

export function openCodeZenEffortWireMap(model) {
  return effortWireMapForOpenCodeZenModel(model)
}

export function openCodeZenEndpoint(protocol) {
  return `${OPENCODE_ZEN_BASE_URL.replace(/\/$/, '')}/${protocol === 'responses'
    ? 'responses'
    : 'chat/completions'}`
}

export function openCodeZenHeaders(apiKey, stream = false) {
  return {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
    accept: stream ? 'text/event-stream' : 'application/json',
    'user-agent': 'gateway-model-gateway/0.1',
  }
}

export function isOpenCodeZenProtocol(value) {
  return value === 'responses' || value === 'chat-completions'
}
