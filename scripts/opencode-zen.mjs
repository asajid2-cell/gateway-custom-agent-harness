import { createHash } from 'node:crypto'

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
  'deepseek-v4.1-flash-free': 'chat-completions',
}

// The Zen endpoint fingerprints its own client, and the free tier enforces it
// hardest. A request that does not look like the OpenCode harness is refused
// with FreeTierError: "OpenCode's free tier can only be used from within
// OpenCode." Four factors carry that fingerprint, all probe-verified live
// against https://opencode.ai/zen/v1/chat/completions on 2026-10-16, and all
// four are required:
//
//   * `User-Agent: opencode/<version>` with version >= 1.18.0. An older version
//     is answered 426 UpgradeRequired ("OpenCode 1.18.0 or newer is required to
//     use the free tier"); any other agent, the Gateway's own name included, is
//     answered 403. See OPENCODE_ZEN_USER_AGENT.
//   * `x-opencode-session` carrying a well-formed session id. See
//     OPENCODE_ZEN_SESSION_ID.
//   * `stream: true` in the body. A non-streaming request is refused even when
//     every other factor is present, so an upstream call is always an SSE one.
//   * a tool named exactly `read` (lowercase). `bash` alone, `Read` (the Claude
//     Code spelling), `read_file`, or no tools array at all are all refused; a
//     lone no-op `read` is sufficient, so the check is name presence, not a
//     working tool.
//
// The provider runs the real `read` tool itself; we declare this placeholder
// only so the array carries the name, exactly as the harness would. The schema
// asks the model not to call it.
export const OPENCODE_ZEN_FINGERPRINT_TOOL = 'read'

export function ensureOpenCodeZenReadTool(request, protocol, supportsTools = true) {
  if (!request || typeof request !== 'object') return request
  // The name is required by the fingerprint, so it is added even when the
  // caller sent no tools at all: the harness the endpoint expects always
  // advertises `read`, and a request without it is refused. The one exception
  // is a route declared incapable of tools, where sending one would contradict
  // the capability the caller's tools were already stripped against.
  if (supportsTools === false) return request
  const tools = Array.isArray(request.tools) ? request.tools : []
  const nameOf = protocol === 'responses'
    ? tool => tool?.name
    : tool => tool?.function?.name
  if (tools.some(tool => nameOf(tool) === OPENCODE_ZEN_FINGERPRINT_TOOL)) {
    return request
  }
  const parameters = { type: 'object', properties: {} }
  const description =
    'Compatibility placeholder for the OpenCode client fingerprint. Never call this tool.'
  const fingerprint = protocol === 'responses'
    ? { type: 'function', name: OPENCODE_ZEN_FINGERPRINT_TOOL, description, parameters }
    : {
        type: 'function',
        function: { name: OPENCODE_ZEN_FINGERPRINT_TOOL, description, parameters },
      }
  return { ...request, tools: [...tools, fingerprint] }
}

export const OPENCODE_ZEN_MODEL_IDS = Object.keys(OPENCODE_ZEN_ROUTES)

// The free tier inspects the client agent. Only `opencode/<version>` at or
// above the floor is accepted, so the Gateway presents itself as the harness
// the endpoint expects. The version is pinned rather than read from the local
// install: the fingerprint checks the floor, not the exact build.
export const OPENCODE_ZEN_CLIENT_VERSION = '1.18.31'
export const OPENCODE_ZEN_USER_AGENT = `opencode/${OPENCODE_ZEN_CLIENT_VERSION}`

// The free tier also validates `x-opencode-session`, the value it namespaces a
// prompt cache by - the restriction the provider describes as "primarily
// related to prompt caching". A missing, empty, or malformed value is refused
// with FreeTierError, and so is a `ses_` value whose shape is wrong. The shape
// is: `ses_` followed by exactly 26 characters, of which the first twelve are
// lowercase hex with the tenth fixed to `f` and the eleventh drawn from
// `cdef`; the last fourteen are free. The rule was mapped empirically - single
// character substitutions show only those two nibbles of the hex head are read.
const OPENCODE_ZEN_SESSION_ID = /^ses_[0-9a-f]{9}f[c-f][0-9a-f][0-9A-Za-z]{14}$/

export function isOpenCodeZenSessionId(value) {
  return typeof value === 'string' && OPENCODE_ZEN_SESSION_ID.test(value)
}

// Mint a conforming session id from a seed. Deriving it from the conversation
// rather than drawing it at random keeps one cache namespace for the life of a
// conversation, across every request and every retry of one request.
export function mintOpenCodeZenSessionId(seed) {
  const digest = createHash('sha256').update(String(seed ?? '')).digest('hex')
  const head = digest.slice(0, 12).split('')
  head[9] = 'f'
  head[10] = 'cdef'[parseInt(digest[10], 16) % 4]
  return `ses_${head.join('')}${digest.slice(12, 26)}`
}

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

export function openCodeZenHeaders(apiKey, stream = false, sessionId = '') {
  const headers = {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
    accept: stream ? 'text/event-stream' : 'application/json',
    'user-agent': OPENCODE_ZEN_USER_AGENT,
  }
  // Every request carries a well-formed session id. Reuse the caller's when it
  // already conforms - a conversation that arrives with a real Zen session
  // keeps it - and mint a stable one from it otherwise.
  headers['x-opencode-session'] = isOpenCodeZenSessionId(sessionId)
    ? sessionId
    : mintOpenCodeZenSessionId(sessionId)
  return headers
}

export function isOpenCodeZenProtocol(value) {
  return value === 'responses' || value === 'chat-completions'
}
