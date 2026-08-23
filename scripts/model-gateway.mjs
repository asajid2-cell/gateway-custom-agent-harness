import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  OPENCODE_GO_ROUTES,
  OPENCODE_GO_MODEL_IDS,
  OPENCODE_GO_STANDARD_EFFORT_LEVELS,
  OPENCODE_GO_EFFORT_LEVELS,
  isOpenCodeGoProtocol,
  anthropicToOpenCodeRequest,
  openCodeGoEndpoint,
  openCodeGoHeaders,
  redactSecret,
  relayOpenCodeStream,
  relayOpenCodeResponseByProtocol,
} from './opencode-go.mjs'

const HOST = '127.0.0.1'
const CODEX_ENDPOINT =
  process.env.CODEX_RESPONSES_URL || 'https://chatgpt.com/backend-api/codex/responses'
const DEEPSEEK_ENDPOINT =
  process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/anthropic/v1/messages'
const OPENROUTER_ENDPOINT =
  process.env.OPENROUTER_API_URL || 'https://openrouter.ai/api/v1/chat/completions'
const CODEX_REASONING_EFFORT =
  process.env.MODEL_GATEWAY_CODEX_REASONING_EFFORT || 'high'
const CODEX_SYSTEM_INSTRUCTION =
  process.env.MODEL_GATEWAY_CODEX_INSTRUCTION ||
  'You are a general-purpose GPT coding assistant. Follow the user instructions directly, use the provided tools when useful, and answer the user request. Do not adopt a product-specific persona or discuss the gateway.'
const MAX_BODY_SIZE = 50 * 1024 * 1024
const TRACE_MAX_BYTES = 10 * 1024 * 1024
const TRACE_MAX_EVENTS = 100_000

function durationEnvironment(name, fallback) {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number of milliseconds`)
  }
  return Math.trunc(value)
}

const UPSTREAM_TIMEOUT_MS = durationEnvironment(
  'MODEL_GATEWAY_UPSTREAM_TIMEOUT_MS',
  120_000,
)
const CONSUMER_TIMEOUT_MS = durationEnvironment(
  'MODEL_GATEWAY_CONSUMER_TIMEOUT_MS',
  180_000,
)
const UPSTREAM_RETRIES = integerEnvironment(
  'MODEL_GATEWAY_UPSTREAM_RETRIES',
  2,
)
const OPENCODE_RETRIES = integerEnvironment(
  'MODEL_GATEWAY_OPENCODE_RETRIES',
  Math.max(UPSTREAM_RETRIES, 4),
)
const UPSTREAM_RETRY_BASE_MS = durationEnvironment(
  'MODEL_GATEWAY_UPSTREAM_RETRY_BASE_MS',
  250,
)
const UPSTREAM_RETRY_MAX_MS = durationEnvironment(
  'MODEL_GATEWAY_UPSTREAM_RETRY_MAX_MS',
  5_000,
)
const RETRY_400 = process.env.MODEL_GATEWAY_RETRY_400 === '1'
const CODEX_TOOL_MODE = process.env.MODEL_GATEWAY_CODEX_TOOL_MODE || 'fallback'

if (!['fallback', 'compact'].includes(CODEX_TOOL_MODE)) {
  throw new Error('MODEL_GATEWAY_CODEX_TOOL_MODE must be fallback or compact')
}

function integerEnvironment(name, fallback) {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`)
  }
  return value
}

function loadSavedOpenRouterModels() {
  const home = process.env.CLAUDE_CONFIG_DIR || os.homedir()
  const candidates = [
    path.join(home, '.claude.json'),
    path.join(home, '.config.json'),
  ]
  for (const filename of candidates) {
    try {
      const config = JSON.parse(readFileSync(filename, 'utf8'))
      const selections = Array.isArray(config?.gatewayOpenRouterModels)
        ? config.gatewayOpenRouterModels
        : []
      return Object.fromEntries(
        selections.flatMap(option => {
          const value = typeof option?.value === 'string' ? option.value : ''
          const prefix = 'claude-openrouter-'
          if (!value.startsWith(prefix)) return []
          let upstream
          try {
            upstream = Buffer.from(value.slice(prefix.length), 'base64url').toString('utf8')
          } catch {
            return []
          }
          if (!upstream) return []
          const effortLevels = Array.isArray(option?.effortLevels)
            ? option.effortLevels.filter(level =>
                ['low', 'medium', 'high', 'max', 'ultracode'].includes(level),
              )
            : []
          return [[value, {
            backend: 'openrouter',
            upstream,
            ...(effortLevels.length ? { effortLevels } : {}),
          }]]
        }),
      )
    } catch {
      // The config may not exist yet or may be temporarily mid-write.
    }
  }
  return {}
}

const DEFAULT_MODELS = {
  'gpt-5.6-luna': { backend: 'codex', upstream: 'gpt-5.6-luna' },
  'gpt-5.6-sol': { backend: 'codex', upstream: 'gpt-5.6-sol' },
  'gpt-5.6-terra': { backend: 'codex', upstream: 'gpt-5.6-terra' },
  'deepseek-v4-flash': { backend: 'deepseek', upstream: 'deepseek-v4-flash' },
  'deepseek-v4-pro': { backend: 'deepseek', upstream: 'deepseek-v4-pro' },
  ...Object.fromEntries(
    OPENCODE_GO_MODEL_IDS.map(model => [
      `opencode-go/${model}`,
      { backend: 'opencode-go', upstream: model, protocol: OPENCODE_GO_ROUTES[model] },
    ]),
  ),
  // claude-* aliases so Claude Code's GATEWAY MODEL DISCOVERY lists them in /model:
  // the discovery filter only surfaces IDs starting with "claude"/"anthropic". Each alias
  // routes to its real backend via `upstream`. Add/remove entries freely; MODEL_GATEWAY_MODELS
  // can override the whole map at launch.
  'claude-gpt-luna': { backend: 'codex', upstream: 'gpt-5.6-luna' },
  'claude-gpt-sol': { backend: 'codex', upstream: 'gpt-5.6-sol' },
  'claude-gpt-terra': { backend: 'codex', upstream: 'gpt-5.6-terra' },
  'claude-ox-alpha': { backend: 'opencode-go', upstream: 'ox-alpha-free', protocol: 'chat-completions' },
  'claude-opencode-ox-alpha': { backend: 'opencode-go', upstream: 'ox-alpha-free', protocol: 'chat-completions' },
  'claude-opencode-ds-pro': { backend: 'opencode-go', upstream: 'deepseek-v4-pro', protocol: 'chat-completions' },
  'claude-opencode-ds-flash': { backend: 'opencode-go', upstream: 'deepseek-v4-flash', protocol: 'chat-completions' },
  'claude-ds-flash': { backend: 'deepseek', upstream: 'deepseek-v4-flash' },
  'claude-ds-pro': { backend: 'deepseek', upstream: 'deepseek-v4-pro' },
  ...loadSavedOpenRouterModels(),
}

function codexSupportsMaxEffort(model) {
  return model === 'gpt-5.6-luna' || model === 'gpt-5.6-sol'
}

function normalizeEffortLevels(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter(level =>
    ['low', 'medium', 'high', 'max', 'ultracode'].includes(level),
  ))]
}

function codexEffortLevels(model) {
  return codexSupportsMaxEffort(model)
    ? ['low', 'medium', 'high', 'max']
    : ['low', 'medium', 'high']
}

function routeEffortLevels(route) {
  const configured = normalizeEffortLevels(route?.effortLevels)
  if (configured.length) {
    return [...configured.filter(level => level !== 'ultracode'), 'ultracode']
  }
  if (route?.backend === 'codex') return [...codexEffortLevels(route.upstream), 'ultracode']
  if (route?.backend === 'deepseek') return ['low', 'high', 'max', 'ultracode']
  if (route?.backend === 'opencode-go') {
    return [
      ...normalizeEffortLevels(
      OPENCODE_GO_EFFORT_LEVELS[route.upstream] ||
      OPENCODE_GO_STANDARD_EFFORT_LEVELS,
      ),
      'ultracode',
    ]
  }
  return ['ultracode']
}

function resolveRouteEffort(requested, route) {
  if (!requested) return undefined
  const levels = routeEffortLevels(route)
  const nativeLevels = levels.filter(level => level !== 'ultracode')
  if (requested === 'ultracode') {
    return nativeLevels.includes('max')
      ? 'max'
      : nativeLevels.includes('high')
        ? 'high'
        : undefined
  }
  if (nativeLevels.includes(requested)) return requested
  return nativeLevels.includes('high') ? 'high' : nativeLevels.at(-1)
}

function withRouteEffort(body, route) {
  const requested = body.output_config?.effort || body.reasoning?.effort
  const resolved = resolveRouteEffort(requested, route)
  if (!requested) return body
  const next = { ...body }
  if (!resolved) {
    if (next.output_config && typeof next.output_config === 'object') {
      const outputConfig = { ...next.output_config }
      delete outputConfig.effort
      next.output_config = outputConfig
    }
    if (next.reasoning && typeof next.reasoning === 'object') {
      const reasoning = { ...next.reasoning }
      delete reasoning.effort
      next.reasoning = reasoning
    }
  } else {
    if (body.output_config) {
      next.output_config = { ...body.output_config, effort: resolved }
    }
    if (body.reasoning) {
      next.reasoning = { ...body.reasoning, effort: resolved }
    }
  }
  if (requested === 'ultracode') {
    const marker = 'Ultracode is on: use the strongest available reasoning and prioritize rigorous coding execution.'
    const system = typeof next.system === 'string'
      ? `${next.system}\n\n${marker}`
      : Array.isArray(next.system)
        ? [...next.system, { type: 'text', text: marker }]
        : marker
    next.system = system
  }
  return next
}

function resolveCodexReasoningEffort(body, upstreamModel, supportedLevels = codexEffortLevels(upstreamModel)) {
  const requested =
    body.output_config?.effort ||
    body.reasoning?.effort ||
    CODEX_REASONING_EFFORT
  if (requested === 'ultracode') {
    return supportedLevels.includes('max')
      ? 'max'
      : supportedLevels.includes('high')
        ? 'high'
        : supportedLevels.at(-1)
  }
  if (!supportedLevels.includes(requested)) {
    return 'high'
  }
  return requested
}

function loadModels() {
  const raw = process.env.MODEL_GATEWAY_MODELS
  if (!raw) return { ...DEFAULT_MODELS }

  let override
  try {
    override = JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `MODEL_GATEWAY_MODELS must be valid JSON: ${error instanceof Error ? error.message : 'parse failed'}`,
    )
  }

  if (!override || Array.isArray(override) || typeof override !== 'object') {
    throw new Error('MODEL_GATEWAY_MODELS must be a JSON object')
  }

  const models = { ...DEFAULT_MODELS }
  for (const [name, value] of Object.entries(override)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`MODEL_GATEWAY_MODELS entry ${name} must be an object`)
    }
    if (
      value.backend !== 'codex' &&
      value.backend !== 'deepseek' &&
      value.backend !== 'opencode-go' &&
      value.backend !== 'openrouter'
    ) {
      throw new Error(`MODEL_GATEWAY_MODELS entry ${name} has an invalid backend`)
    }
    if (typeof (value.upstream || name) !== 'string') {
      throw new Error(`MODEL_GATEWAY_MODELS entry ${name} needs a string upstream model`)
    }
    if (value.backend === 'opencode-go' && !isOpenCodeGoProtocol(value.protocol)) {
      throw new Error(`MODEL_GATEWAY_MODELS entry ${name} needs a valid OpenCode Go protocol`)
    }
    models[name] = {
      backend: value.backend,
      ...(typeof value.upstream === 'string' && value.upstream
        ? { upstream: value.upstream }
        : value.backend === 'codex' || value.backend === 'opencode-go'
          ? { upstream: name }
          : {}),
      ...(value.backend === 'opencode-go' ? { protocol: value.protocol } : {}),
      ...(normalizeEffortLevels(value.effortLevels).length
        ? { effortLevels: normalizeEffortLevels(value.effortLevels) }
        : {}),
    }
  }
  return models
}

const MODELS = loadModels()
const MODEL_NAMES = Object.keys(MODELS)

function parsePort(raw, source) {
  if (raw == null || raw === '') return 0
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(`Invalid ${source} port: ${raw}`)
  }
  return value
}

function resolvePort() {
  const args = process.argv.slice(2)
  const portEquals = args.find(value => value.startsWith('--port='))
  if (portEquals) return parsePort(portEquals.slice('--port='.length), '--port')

  const portIndex = args.indexOf('--port')
  if (portIndex >= 0) {
    if (portIndex + 1 >= args.length) throw new Error('--port needs a value')
    return parsePort(args[portIndex + 1], '--port')
  }

  return parsePort(process.env.MODEL_GATEWAY_PORT, 'MODEL_GATEWAY_PORT')
}

const PORT = resolvePort()

function json(res, status, body) {
  if (res.headersSent || res.destroyed || res.writableEnded) return
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

function classifyGatewayError(error) {
  const message = String(error?.message || error || '').toLowerCase()
  if (message.includes('timeout') || message.includes('aborted')) return 'timeout'
  if (
    message.includes('prompt is too long') ||
    message.includes('context window') ||
    message.includes('exceeds the context')
  ) return 'context-window'
  if (
    error instanceof SyntaxError ||
    message.includes('empty') ||
    message.includes('malformed') ||
    message.includes('unexpected token') ||
    message.includes('unexpected end of json')
  ) return 'malformed-response'
  if (message.includes('econnreset') || message.includes('connection reset')) return 'connection-reset'
  if (message.includes('http ')) return 'upstream-http-error'
  return 'upstream-error'
}

function createGatewayTrace({ model, backend, protocol }) {
  const requestStart = new Date().toISOString()
  const started = performance.now()
  const marks = {
    upstreamConnect: null,
    firstByte: null,
    firstOutput: null,
    completion: null,
    error: null,
  }
  let bytes = 0
  let events = 0
  let textChars = 0
  let thinkingChars = 0
  let toolArgumentChars = 0
  let errorClass = null
  let finished = false

  const elapsed = () => Math.round(performance.now() - started)
  const mark = name => {
    if (marks[name] == null) marks[name] = elapsed()
  }

  return {
    markUpstreamConnect() { mark('upstreamConnect') },
    markFirstByte() { mark('firstByte') },
    markOutput() { mark('firstOutput') },
    markCompletion() { mark('completion') },
    markError(error) {
      mark('error')
      if (!errorClass) errorClass = classifyGatewayError(error)
    },
    clearError() {
      errorClass = null
      marks.error = null
    },
    markTimeout(message = 'Gateway request timed out') {
      const error = new Error(message)
      error.gatewayStatus = 504
      mark('error')
      errorClass = 'timeout'
    },
    addBytes(value) {
      const amount = Number(value)
      if (Number.isFinite(amount) && amount > 0) bytes = Math.min(TRACE_MAX_BYTES, bytes + Math.trunc(amount))
    },
    addEvent() {
      events = Math.min(TRACE_MAX_EVENTS, events + 1)
    },
    addTextChars(value) {
      const amount = Number(value)
      if (Number.isFinite(amount) && amount > 0) textChars += Math.trunc(amount)
    },
    addThinkingChars(value) {
      const amount = Number(value)
      if (Number.isFinite(amount) && amount > 0) thinkingChars += Math.trunc(amount)
    },
    addToolArgumentChars(value) {
      const amount = Number(value)
      if (Number.isFinite(amount) && amount > 0) toolArgumentChars += Math.trunc(amount)
    },
    finish(outcome, error = null, status = null) {
      if (finished) return
      if (error) this.markError(error)
      // Relays deliberately consume stream failures so they can emit an
      // Anthropic in-stream error after HTTP 200. Never let the outer handler
      // reclassify that response as a successful request.
      if (outcome === 'success' && errorClass) outcome = 'stream-error'
      finished = true
      if (outcome === 'success') this.markCompletion()
      if (process.env.MODEL_GATEWAY_LOG_TIMING !== '1') return
      const fields = [
        `route=${safeLogValue(backend)}`,
        `model=${safeLogValue(model)}`,
        `protocol=${safeLogValue(protocol || 'none')}`,
        `request_start=${requestStart}`,
        `upstream_connect_ms=${marks.upstreamConnect ?? -1}`,
        `first_byte_ms=${marks.firstByte ?? -1}`,
        `first_output_ms=${marks.firstOutput ?? -1}`,
        `completion_ms=${marks.completion ?? -1}`,
        `error_ms=${marks.error ?? -1}`,
        `bytes=${bytes}`,
        `events=${events}`,
        `text_chars=${textChars}`,
        `thinking_chars=${thinkingChars}`,
        `tool_argument_chars=${toolArgumentChars}`,
        `status=${status == null ? -1 : status}`,
        `outcome=${safeLogValue(outcome)}`,
        `error_class=${safeLogValue(errorClass || 'none')}`,
      ]
      process.stderr.write(`model-gateway timing ${fields.join(' ')}\n`)
    },
    get finished() { return finished },
  }
}

function createRequestControl(req, res, trace) {
  const controller = new AbortController()
  let closed = false
  let upstreamTimer = null
  let consumerTimer = null
  let upstreamStarted = false
  let streamErrorFinalizer = null
  let upstreamCancel = null
  const abort = (message, status = 504) => {
    if (closed) return
    closed = true
    const error = new Error(message)
    error.gatewayStatus = status
    if (status === 504) trace.markTimeout(message)
    else trace.markError(error)
    controller.abort(error)
    if (upstreamCancel) {
      Promise.resolve(upstreamCancel()).catch(() => {})
    }
    if (res.destroyed || res.writableEnded) return
    if (!res.headersSent) {
      anthropicError(res, status, message)
    } else {
      streamErrorFinalizer?.()
      finishAnthropicStreamWithError(res, error)
    }
  }
  const armUpstreamTimeout = () => {
    if (upstreamStarted || UPSTREAM_TIMEOUT_MS <= 0) return
    upstreamStarted = true
    upstreamTimer = setTimeout(() => abort('Gateway upstream request timed out', 504), UPSTREAM_TIMEOUT_MS)
  }
  const armConsumerTimeout = () => {
    if (CONSUMER_TIMEOUT_MS <= 0 || consumerTimer) return
    consumerTimer = setTimeout(() => abort('Gateway consumer timeout', 504), CONSUMER_TIMEOUT_MS)
  }

  const onRequestAborted = () => abort('Gateway request was aborted', 499)
  const onRequestClose = () => {
    // `aborted` is not guaranteed once the request body has been fully read.
    // A client can still destroy the connection while the gateway is buffering
    // upstream output for retry, so observe the request socket as well.
    if (!res.writableEnded && !res.destroyed) {
      abort('Gateway consumer disconnected', 499)
    }
  }
  const onResponseClose = () => {
    // `close` commonly arrives with `destroyed === true`; that is exactly the
    // signal that the upstream must be cancelled. Normal completion has
    // `writableEnded === true` and is ignored.
    if (!res.writableEnded) abort('Gateway consumer disconnected', 499)
  }
  const onConsumerSocketClose = () => {
    if (!res.writableEnded && !res.destroyed) {
      abort('Gateway consumer disconnected', 499)
    }
  }
  if (req && typeof req.once === 'function') req.once('aborted', onRequestAborted)
  if (req && typeof req.once === 'function') req.once('close', onRequestClose)
  if (res && typeof res.once === 'function') res.once('close', onResponseClose)
  const consumerSocket = res?.socket || req?.socket
  if (consumerSocket && typeof consumerSocket.once === 'function') {
    consumerSocket.once('close', onConsumerSocketClose)
  }

  return {
    signal: controller.signal,
    startUpstream() {
      armUpstreamTimeout()
      armConsumerTimeout()
    },
    upstreamConnected() {
      if (upstreamTimer) {
        clearTimeout(upstreamTimer)
        upstreamTimer = null
      }
    },
    retryUpstream() {
      if (upstreamTimer) clearTimeout(upstreamTimer)
      upstreamTimer = null
      upstreamStarted = false
      armUpstreamTimeout()
    },
    upstreamActivity() {
      if (closed || CONSUMER_TIMEOUT_MS <= 0) return
      if (consumerTimer) clearTimeout(consumerTimer)
      consumerTimer = null
      armConsumerTimeout()
    },
    setStreamErrorFinalizer(finalizer) {
      streamErrorFinalizer = typeof finalizer === 'function' ? finalizer : null
    },
    setUpstreamCancellation(cancel) {
      upstreamCancel = typeof cancel === 'function' ? cancel : null
      if (upstreamCancel && controller.signal.aborted) {
        Promise.resolve().then(() => upstreamCancel()).catch(() => {})
      }
    },
    cancelUpstream() {
      return upstreamCancel ? Promise.resolve(upstreamCancel()).catch(() => {}) : Promise.resolve()
    },
    statusFor(error) {
      return Number.isInteger(error?.gatewayStatus)
        ? error.gatewayStatus
        : controller.signal.aborted && trace.finished === false
          ? 504
          : 502
    },
    cleanup() {
      if (upstreamTimer) clearTimeout(upstreamTimer)
      if (consumerTimer) clearTimeout(consumerTimer)
      upstreamCancel = null
      if (req && typeof req.removeListener === 'function') req.removeListener('aborted', onRequestAborted)
      if (req && typeof req.removeListener === 'function') req.removeListener('close', onRequestClose)
      if (res && typeof res.removeListener === 'function') res.removeListener('close', onResponseClose)
      if (consumerSocket && typeof consumerSocket.removeListener === 'function') {
        consumerSocket.removeListener('close', onConsumerSocketClose)
      }
    },
  }
}

function sendEvent(res, type, data) {
  res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
}

function finishAnthropicStreamWithError(res, error) {
  if (res.destroyed || res.writableEnded) return

  const message = error instanceof Error ? error.message : String(error || 'Upstream stream failed')
  try {
    sendEvent(res, 'error', {
      error: {
        type: 'api_error',
        message,
      },
    })
    res.end()
  } catch (writeError) {
    if (!res.destroyed && !res.writableEnded && typeof res.destroy === 'function') {
      res.destroy(writeError instanceof Error ? writeError : undefined)
    }
  }
}

function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => {
      if (typeof block === 'string') return block
      if (block?.type === 'text' || block?.type === 'input_text') {
        return block.text || ''
      }
      if (block?.type === 'image') return '[image]'
      if (block?.type === 'document') return documentMarker(block)
      if (block?.type === 'tool_result') return contentText(block.content)
      return ''
    })
    .join('')
}

function documentMarker(block) {
  const title =
    typeof block?.title === 'string' && block.title.trim()
      ? ` "${block.title.trim()}"`
      : ''
  return `[document${title} unavailable to the Codex Responses gateway]`
}

function anthropicImageUrl(block) {
  const source = block?.source
  if (!source || typeof source !== 'object') {
    throw new Error('Image block is missing its source')
  }

  if (source.type === 'url' && typeof source.url === 'string' && source.url) {
    return source.url
  }

  if (
    source.type === 'base64' &&
    typeof source.media_type === 'string' &&
    source.media_type &&
    typeof source.data === 'string' &&
    source.data
  ) {
    return `data:${source.media_type};base64,${source.data}`
  }

  throw new Error(`Unsupported Anthropic image source: ${String(source.type || 'missing')}`)
}

function serializeBlock(block) {
  try {
    return JSON.stringify(block)
  } catch {
    return String(block)
  }
}

function toolResultBlockText(block) {
  if (typeof block === 'string') return block
  if (block?.type === 'text' || block?.type === 'input_text') {
    return block.text || ''
  }
  if (block?.type === 'image') return '[image attachment]'
  if (block?.type === 'document') return documentMarker(block)
  if (block && typeof block === 'object') {
    return `[${String(block.type || 'tool output')}]\n${serializeBlock(block)}`
  }
  return String(block ?? '')
}

function codexToolResultOutput(content, isError = false) {
  if (typeof content === 'string') {
    return isError ? `[tool error]\n${content}` : content
  }
  if (!Array.isArray(content)) {
    const text = toolResultBlockText(content)
    return isError ? `[tool error]\n${text}` : text
  }

  const items = []
  for (const block of content) {
    if (block?.type === 'image') {
      items.push({ type: 'input_image', image_url: anthropicImageUrl(block) })
      continue
    }
    const text = toolResultBlockText(block)
    if (text) items.push({ type: 'input_text', text })
  }

  if (isError) items.unshift({ type: 'input_text', text: '[tool error]' })
  return items.some(item => item.type === 'input_image')
    ? items
    : items.map(item => item.text).join('')
}

function appendCodexFunctionCall(input, block) {
  const callId = block?.id || block?.tool_use_id
  if (!callId) return false
  if (block?.type === 'tool_use' && !block.name) {
    throw new Error('Anthropic tool call is missing a function name')
  }

  input.push({
    type: 'function_call',
    call_id: callId,
    name: block.name,
    arguments: JSON.stringify(block.input ?? {}),
  })
  return true
}

function appendCodexFunctionCallOutput(input, block) {
  const callId = block?.tool_use_id || block?.id
  if (!callId) return false

  input.push({
    type: 'function_call_output',
    call_id: callId,
    output: codexToolResultOutput(
      block.content ?? block.output ?? block.result ?? '',
      block.is_error === true,
    ),
  })
  return true
}

function systemText(system) {
  return contentText(system)
}

function rewriteCodexSystemPrompt(system) {
  // Claude Code sends a large Claude-specific prompt. Replace it entirely so
  // the Codex model follows the actual user conversation instead.
  const source = systemText(system)
  return source.includes('Ultracode is on:')
    ? `${CODEX_SYSTEM_INSTRUCTION}\n\nUltracode is on: use the strongest available reasoning and prioritize rigorous coding execution.`
    : CODEX_SYSTEM_INSTRUCTION
}

function logFeatureSignals(body) {
  if (process.env.MODEL_GATEWAY_LOG_FEATURE_SIGNALS !== '1') return

  const system = systemText(body.system)
  const messages = (body.messages || [])
    .map(message => contentText(message.content))
    .join('\n')
  const source = messages.includes('Ultracode is on:')
    ? 'messages'
    : system.includes('Ultracode is on:')
      ? 'system'
      : 'none'
  const ultracode = source !== 'none'
    ? 'active'
    : messages.includes('keyword "ultracode"') ||
        system.includes('keyword "ultracode"')
      ? 'keyword'
      : 'absent'
  process.stderr.write(
    `model-gateway feature ultracode=${ultracode} source=${source}\n`,
  )
}

function appendAnthropicMessage(input, message) {
  const role = message.role === 'assistant' ? 'assistant' : 'user'
  const content =
    typeof message.content === 'string'
      ? [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: message.content }]
      : Array.isArray(message.content)
        ? message.content
        : []

  for (const block of content) {
    if (typeof block === 'string') {
      input.push({
        role,
        content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: block }],
      })
      continue
    }

    if (
      block?.type === 'text' ||
      block?.type === 'input_text' ||
      block?.type === 'output_text'
    ) {
      input.push({
        role,
        content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: block.text || '' }],
      })
      continue
    }

    if (block?.type === 'tool_use') {
      appendCodexFunctionCall(input, block)
      continue
    }

    if (block?.type === 'tool_result') {
      appendCodexFunctionCallOutput(input, block)
      continue
    }

    if (block?.type === 'server_tool_use' || block?.type === 'mcp_tool_use') {
      if (!appendCodexFunctionCall(input, block)) {
        input.push({
          role,
          content: [{ type: 'input_text', text: toolResultBlockText(block) }],
        })
      }
      continue
    }

    if (
      block?.type === 'server_tool_result' ||
      block?.type === 'advisor_tool_result' ||
      block?.type === 'mcp_tool_result' ||
      block?.type === 'web_search_tool_result' ||
      block?.type === 'web_fetch_tool_result' ||
      block?.type === 'code_execution_tool_result' ||
      block?.type === 'bash_code_execution_tool_result' ||
      block?.type === 'text_editor_code_execution_tool_result' ||
      block?.type === 'tool_search_tool_result'
    ) {
      if (!appendCodexFunctionCallOutput(input, block)) {
        input.push({
          role,
          content: [{ type: 'input_text', text: toolResultBlockText(block) }],
        })
      }
      continue
    }

    if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
      continue
    }

    if (block?.type === 'image') {
      input.push({
        role,
        content: [{ type: 'input_image', image_url: anthropicImageUrl(block) }],
      })
      continue
    }

    if (block?.type === 'document') {
      input.push({
        role,
        content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: documentMarker(block) }],
      })
      continue
    }

    if (block?.type === 'compaction') {
      input.push({
        role,
        content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: '[compaction boundary]' }],
      })
      continue
    }

    if (block?.type) {
      input.push({
        role,
        content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: toolResultBlockText(block) }],
      })
    }
  }
}

export function anthropicToCodex(body, upstreamModel, supportedLevels) {
  logFeatureSignals(body)

  const input = []
  for (const message of body.messages || []) {
    appendAnthropicMessage(input, message)
  }

  const request = {
    model: upstreamModel,
    stream: body.stream === true,
    store: false,
    input,
    reasoning: {
      effort: resolveCodexReasoningEffort(body, upstreamModel, supportedLevels),
      summary: 'detailed',
    },
    instructions: rewriteCodexSystemPrompt(body.system),
  }

  if (body.max_tokens != null) request.max_output_tokens = body.max_tokens
  // Codex Responses does not accept Anthropic's sampling controls. Claude
  // sends temperature/top_p on some compaction requests, and forwarding them
  // causes a delayed 400 after a prior stream attempt has already failed.
  // Keep the Anthropic-side fields private to the gateway.
  if (body.tools?.length) {
    request.tools = body.tools.map(tool => ({
      type: 'function',
      name: tool.name,
      description: tool.description || '',
      parameters: tool.input_schema || { type: 'object' },
    }))
  }

  if (body.tool_choice === 'auto' || body.tool_choice === 'none' || body.tool_choice === 'any') {
    request.tool_choice = body.tool_choice === 'any' ? 'required' : body.tool_choice
  } else if (body.tool_choice?.type === 'tool' && body.tool_choice.name) {
    request.tool_choice = { type: 'function', name: body.tool_choice.name }
  }

  process.stderr.write('model-gateway codex effort=' + String(request.reasoning.effort) + '\n')
  return request
}

const CORE_TOOL_NAME_PATTERN =
  /^(read|write|edit|bash|powershell|shell|terminal|cmd|glob|grep|skill|task|agent|todo|askuser)/i

function slimCodexSchema(value) {
  if (Array.isArray(value)) return value.map(slimCodexSchema)
  if (!value || typeof value !== 'object') return value

  const result = {}
  for (const [key, child] of Object.entries(value)) {
    if (
      key === 'description' ||
      key === 'title' ||
      key === 'default' ||
      key === 'examples' ||
      key === 'example' ||
      key === '$comment'
    ) continue
    result[key] = slimCodexSchema(child)
  }
  return result
}

function contextFallbackRequests(request) {
  if (!Array.isArray(request.tools) || request.tools.length === 0) return []

  const slimTools = compactCodexTools(request)
  const coreTools = slimTools.filter(tool => CORE_TOOL_NAME_PATTERN.test(tool.name))
  const variants = [{ ...request, tools: slimTools }]
  if (coreTools.length && coreTools.length < slimTools.length) {
    variants.push({ ...request, tools: coreTools })
  }
  return variants
}

function compactCodexTools(request) {
  return request.tools.map(tool => ({
    ...tool,
    description: '',
    parameters: slimCodexSchema(tool.parameters),
  }))
}

function codexRequestVariants(request) {
  if (CODEX_TOOL_MODE !== 'compact' || !Array.isArray(request.tools) || request.tools.length === 0) {
    return [request, ...contextFallbackRequests(request)]
  }

  const compactRequest = {
    ...request,
    tools: compactCodexTools(request),
  }
  return [compactRequest, request, ...contextFallbackRequests(request)]
}

function codexRequestShape(request) {
  return [
    `input_items=${Array.isArray(request.input) ? request.input.length : 0}`,
    `tools=${Array.isArray(request.tools) ? request.tools.length : 0}`,
    `bytes=${Buffer.byteLength(JSON.stringify(request), 'utf8')}`,
  ].join(' ')
}

async function readRawBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_SIZE) throw new Error('Request body is too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

async function readCodexAuth() {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
  const auth = JSON.parse(await fs.readFile(path.join(home, 'auth.json'), 'utf8'))
  const accessToken = auth?.tokens?.access_token
  const accountId = auth?.tokens?.account_id
  if (!accessToken || !accountId) {
    throw new Error('Codex ChatGPT auth is missing or incomplete; run codex login first')
  }
  return { accessToken, accountId }
}

function anthropicError(res, status, message) {
  json(res, status, {
    type: 'error',
    error: { type: 'api_error', message },
  })
}

function nonNegativeInteger(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : 0
}

/**
 * Codex reports cached input as a subset of input_tokens. Anthropic exposes
 * that subset separately, so subtract it before forwarding input_tokens or
 * Claude Code's context footer would count cached tokens twice.
 */
export function codexUsageToAnthropic(usage) {
  const inputTokens = nonNegativeInteger(
    usage?.input_tokens ??
      (nonNegativeInteger(usage?.total_tokens) -
        nonNegativeInteger(usage?.output_tokens)),
  )
  const cachedInputTokens = Math.min(
    inputTokens,
    nonNegativeInteger(
      usage?.input_tokens_details?.cached_tokens ??
        usage?.cached_input_tokens ??
        usage?.cached_tokens ??
        usage?.cache_read_input_tokens,
    ),
  )

  return {
    input_tokens: inputTokens - cachedInputTokens,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cachedInputTokens,
    output_tokens: nonNegativeInteger(usage?.output_tokens),
  }
}

function codexResponseFailure(response) {
  const detail = [
    response?.error?.message,
    response?.response?.error?.message,
    response?.status_details?.reason,
  ]
    .find(value => typeof value === 'string' && value)
  const message = String(detail || '')
  if (isContextWindowFailure(new Error(message))) {
    throw new Error('Prompt is too long: Codex context window exceeded')
  }
  throw new Error('Codex response failed')
}

function parseCodexFunctionArguments(argumentsValue) {
  if (argumentsValue == null || argumentsValue === '') return {}
  if (typeof argumentsValue === 'object' && !Array.isArray(argumentsValue)) {
    return argumentsValue
  }
  if (typeof argumentsValue !== 'string') {
    throw new Error('Codex returned malformed function-call arguments')
  }
  let parsed
  try {
    parsed = JSON.parse(argumentsValue)
  } catch {
    throw new Error('Codex returned malformed function-call arguments')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Codex returned malformed function-call arguments')
  }
  return parsed
}

/**
 * Convert one completed non-streaming Codex Responses object to an Anthropic
 * Messages response. This is deliberately separate from the SSE relay: the
 * Anthropic SDK's streaming fallback requires JSON, not a 200 SSE response.
 */
export function codexResponseToAnthropic(response, model) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error('Codex returned malformed JSON')
  }
  if (response.error || response.response?.error) codexResponseFailure(response)
  if (response.status && response.status !== 'completed') {
    const reason = response.incomplete_details?.reason || response.status
    if (String(reason).toLowerCase().includes('max')) {
      throw new Error('Codex response reached the output token limit')
    }
    throw new Error('Codex response did not complete')
  }

  const content = []
  let hasToolUse = false
  for (const item of Array.isArray(response.output) ? response.output : []) {
    if (item?.type === 'message') {
      for (const part of Array.isArray(item.content) ? item.content : []) {
        if (part?.type === 'output_text' && typeof part.text === 'string' && part.text) {
          content.push({ type: 'text', text: part.text })
        }
      }
    } else if (item?.type === 'function_call') {
      if (!item.call_id && !item.id) throw new Error('Codex returned a function call without an id')
      if (!item.name) throw new Error('Codex returned a function call without a name')
      content.push({
        type: 'tool_use',
        id: item.call_id || item.id,
        name: item.name,
        input: parseCodexFunctionArguments(item.arguments),
      })
      hasToolUse = true
    }
  }

  if (!content.length) throw new Error('Codex returned an empty or malformed response')

  return {
    id: typeof response.id === 'string' && response.id ? response.id : `msg_${randomUUID().replaceAll('-', '')}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: hasToolUse ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: codexUsageToAnthropic(response.usage),
  }
}

export async function relayCodexResponse(
  res,
  upstream,
  model,
  trace = null,
  forceStream = false,
  control = null,
  options = {},
) {
  try {
    let response
    const contentType = upstream.headers?.get?.('content-type') || ''
    if (forceStream || contentType.includes('text/event-stream')) {
      const reader = upstream.body?.getReader()
      if (!reader) throw new Error('Codex returned an empty response body')
      control?.setUpstreamCancellation(() => reader.cancel())
      const decoder = new TextDecoder()
      let buffer = ''
      let completed = null
      let text = ''
      const toolCalls = new Map()
      const handleEvent = event => {
        if (event.type === 'response.output_text.delta') {
          text += typeof event.delta === 'string' ? event.delta : ''
          return
        }
        if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
          const item = {
            type: 'function_call',
            id: event.item.id,
            call_id: event.item.call_id,
            name: event.item.name,
            arguments: '',
          }
          toolCalls.set(item.call_id || item.id, item)
          return
        }
        if (event.type === 'response.function_call_arguments.delta') {
          const key = event.call_id || event.item?.call_id || event.item?.id
          const item = toolCalls.get(key)
          if (item) item.arguments += typeof event.delta === 'string' ? event.delta : ''
          return
        }
        if (event.type === 'response.failed') {
          throw new Error(event.response?.error?.message || 'Codex response failed')
        }
        if (event.type === 'response.completed') {
          completed = event.response || event
        }
      }
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        control?.upstreamActivity?.()
        trace?.markFirstByte()
        trace?.addBytes(value?.byteLength || 0)
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() || ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6)
          if (!data || data === '[DONE]') continue
          trace?.addEvent()
          handleEvent(JSON.parse(data))
        }
      }
      if (buffer.startsWith('data: ')) {
        const data = buffer.slice(6)
        if (data && data !== '[DONE]') {
          trace?.addEvent()
          handleEvent(JSON.parse(data))
        }
      }
      if (!completed) throw new Error('Codex stream ended before response.completed')
      if (!completed.output?.length && (text || toolCalls.size)) {
        completed = {
          ...completed,
          output: [
            ...(text ? [{ type: 'message', content: [{ type: 'output_text', text }] }] : []),
            ...toolCalls.values(),
          ],
        }
      }
      response = completed
    } else {
      const raw = await upstream.text()
      trace?.markFirstByte()
      trace?.addBytes(Buffer.byteLength(raw, 'utf8'))
      trace?.addEvent()
      response = JSON.parse(raw)
    }
    const message = codexResponseToAnthropic(response, model)
    trace?.markOutput()
    trace?.markCompletion()
    json(res, 200, message)
    return true
  } catch (error) {
    trace?.markError(error)
    if (options.throwPreOutput) {
      await upstream.body?.cancel?.().catch(() => {})
      throw error
    }
    if (isContextWindowFailure(error)) {
      finishAnthropicPromptTooLongError(res, error)
    } else {
      anthropicError(res, 502, errorMessage(error))
    }
    return false
  }
}

function writeMessageStart(res, model) {
  const messageId = `msg_${randomUUID().replaceAll('-', '')}`
  sendEvent(res, 'message_start', {
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0,
      },
    },
  })
  sendEvent(res, 'ping', {})
}

function startAnthropicStream(res, model) {
  if (res.headersSent) return
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  writeMessageStart(res, model)
}

function errorMessage(error) {
  return error instanceof Error
    ? error.message
    : String(error || 'Upstream stream failed')
}

function safeUpstreamError(status, provider) {
  return `${provider} returned HTTP ${status}`
}

async function upstreamErrorDetail(response, provider) {
  const fallback = safeUpstreamError(response?.status, provider)
  if (!response?.body) return fallback
  try {
    const raw = await response.text()
    if (!raw) return fallback
    const parsed = JSON.parse(raw)
    const values = []
    const collect = value => {
      if (typeof value === 'string') values.push(value)
      else if (Array.isArray(value)) value.forEach(collect)
      else if (value && typeof value === 'object') Object.values(value).forEach(collect)
    }
    collect(parsed?.error ?? parsed)
    const detail = values.find(value => value.length > 0 && value.length < 500)
    return detail ? `${fallback}: ${detail}` : fallback
  } catch {
    return fallback
  }
}

function retryAfterMs(response) {
  const value = response?.headers?.get?.('retry-after')
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(UPSTREAM_RETRY_MAX_MS, Math.round(seconds * 1000))
  }
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return null
  return Math.max(0, Math.min(UPSTREAM_RETRY_MAX_MS, timestamp - Date.now()))
}

function retryableStatus(status) {
  return (RETRY_400 && status === 400) ||
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    status >= 500
}

function retryableConnectionError(error, signal) {
  if (signal?.aborted) return false
  const code = String(error?.code || '').toUpperCase()
  const message = errorMessage(error).toLowerCase()
  return code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'EPIPE' ||
    message.includes('fetch failed') ||
    message.includes('socket') ||
    message.includes('connection reset')
}

function retryDelayMs(retryNumber, response) {
  const hinted = retryAfterMs(response)
  if (hinted != null) return hinted
  const exponential = UPSTREAM_RETRY_BASE_MS * (2 ** Math.max(0, retryNumber - 1))
  return Math.min(UPSTREAM_RETRY_MAX_MS, exponential)
}

async function waitForRetry(delayMs, signal) {
  if (delayMs <= 0) return
  await new Promise((resolve, reject) => {
    let timer = null
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
    timer = setTimeout(() => {
      cleanup()
      resolve()
    }, delayMs)
    const abort = () => {
      cleanup()
      reject(signal.reason || new Error('Gateway request aborted'))
    }
    if (signal?.aborted) {
      abort()
      return
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

async function fetchWithRetry({
  provider,
  url,
  options,
  control,
  trace,
}) {
  let lastError = null
  for (let attempt = 1; attempt <= UPSTREAM_RETRIES + 1; attempt += 1) {
    if (attempt > 1) control.retryUpstream?.()
    try {
      const response = await gatewayFetch(url, options)
      trace.markUpstreamConnect()
      control.upstreamConnected()
      if (response.ok || !retryableStatus(response.status) || attempt > UPSTREAM_RETRIES) {
        return response
      }

      const delay = retryDelayMs(attempt, response)
      await response.body?.cancel().catch(() => {})
      process.stderr.write(
        `model-gateway retry provider=${safeLogValue(provider)} status=${response.status} attempt=${attempt} delay_ms=${delay}\n`,
      )
      await waitForRetry(delay, control.signal)
    } catch (error) {
      lastError = error
      if (!retryableConnectionError(error, control.signal) || attempt > UPSTREAM_RETRIES) {
        throw error
      }
      const delay = retryDelayMs(attempt, null)
      process.stderr.write(
        `model-gateway retry provider=${safeLogValue(provider)} error=${safeLogValue(error?.code || classifyGatewayError(error))} attempt=${attempt} delay_ms=${delay}\n`,
      )
      await waitForRetry(delay, control.signal)
    }
  }
  throw lastError || new Error(`${provider} upstream request failed`)
}

function isContextWindowFailure(error) {
  const message = errorMessage(error).toLowerCase()
  return (
    message.includes('prompt is too long') ||
    message.includes('exceeds the context window') ||
    message.includes('context window limit') ||
    message.includes('context length') ||
    message.includes('maximum context')
  )
}

/**
 * Bun's fetch implementation can leave an HTTP/1.1 provider socket alive
 * after ReadableStream.cancel(). Keep the gateway's upstream transport on a
 * Node-owned request so aborting or cancelling the body destroys the socket.
 */
export function gatewayFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const transport = target.protocol === 'https:' ? https : http
    const signal = options.signal
    const requestHeaders = options.headers instanceof Headers
      ? Object.fromEntries(options.headers.entries())
      : { ...(options.headers || {}) }
    let request
    let responseSettled = false
    let response = null
    let requestSocket = null
    let responseSocket = null
    let settled = false

    const abortError = () => {
      const reason = signal?.reason
      return reason instanceof Error ? reason : new Error('Gateway upstream request aborted')
    }
    const destroyUpstream = reason => {
      const error = reason instanceof Error ? reason : undefined
      request?.destroy(error)
      response?.destroy(error)
      requestSocket?.destroy(error)
      responseSocket?.destroy(error)
    }
    const onAbort = () => {
      const error = abortError()
      destroyUpstream(error)
      if (!settled) {
        settled = true
        reject(error)
      }
    }
    const cleanupSignal = () => {
      signal?.removeEventListener('abort', onAbort)
    }

    request = transport.request(target, {
      method: options.method || 'GET',
      headers: requestHeaders,
    }, incoming => {
      responseSettled = true
      response = incoming
      responseSocket = incoming.socket
      const headers = new Headers()
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value == null) continue
        headers.set(name, Array.isArray(value) ? value.join(', ') : value)
      }

      const body = new ReadableStream({
        start(controller) {
          incoming.on('data', chunk => {
            controller.enqueue(new Uint8Array(chunk))
          })
          incoming.on('end', () => {
            cleanupSignal()
            controller.close()
          })
          incoming.on('error', error => {
            cleanupSignal()
            controller.error(error)
          })
          incoming.on('aborted', () => {
            cleanupSignal()
            controller.error(new Error('Gateway upstream response was aborted'))
          })
        },
        cancel(reason) {
          cleanupSignal()
          destroyUpstream(reason)
        },
      })

      const readText = async () => {
        const reader = body.getReader()
        const chunks = []
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            chunks.push(Buffer.from(value))
          }
        } finally {
          reader.releaseLock()
        }
        return Buffer.concat(chunks).toString('utf8')
      }

      const result = {
        ok: incoming.statusCode >= 200 && incoming.statusCode < 300,
        status: incoming.statusCode || 0,
        headers,
        body,
        text: readText,
        clone() {
          return { text: readText }
        },
      }
      settled = true
      resolve(result)
    })
    requestSocket = request.socket

    request.once('error', error => {
      cleanupSignal()
      if (!settled) {
        settled = true
        reject(error)
      }
    })
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
      return
    }
    if (options.body != null) request.write(options.body)
    request.end()
  })
}

function retryablePreOutputRelayError(error) {
  const errorClass = classifyGatewayError(error)
  return errorClass === 'malformed-response' ||
    errorClass === 'connection-reset' ||
    errorClass === 'upstream-error'
}

function finishAnthropicPromptTooLongError(res, error) {
  const detail = errorMessage(error)
  const message = detail.toLowerCase().startsWith('prompt is too long')
    ? detail
    : `Prompt is too long: ${detail}`
  anthropicError(res, 400, message)
}

function isCompactionRequest(body) {
  // Compaction prompts are appended as the final user message. Never scan the
  // full history: after a successful compaction, the retained summary can
  // legitimately contain the old no-tools instructions and must not disable
  // tools on the next normal coding turn.
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const currentMessage = [...messages].reverse().find(message => message?.role === 'user')
  const text = contentText(currentMessage?.content)
  const normalized = text.toLowerCase()
  return (
    normalized.includes('respond with text only') &&
    normalized.includes('do not call any tools') &&
    (normalized.includes('<summary>') || normalized.includes('summariz'))
  )
}

export async function relayCodexStream(
  res,
  upstream,
  model,
  trace = null,
  control = null,
  options = {},
) {
  let contentIndex = 0
  let activeText = false
  let activeTool = null
  let sawOutput = false
  let toolCallSeen = false
  let usage = null
  let sawCompletion = false
  let buffer = ''
  let streamStarted = false
  let pendingTool = null
  let pendingToolArguments = ''

  const startStream = () => {
    if (streamStarted) return
    startAnthropicStream(res, model)
    streamStarted = true
  }

  const closeActive = () => {
    if (activeText || activeTool) sendEvent(res, 'content_block_stop', { index: contentIndex })
    activeText = false
    activeTool = null
  }

  const openText = () => {
    if (activeText) return
    startStream()
    closeActive()
    activeText = true
    sawOutput = true
    trace?.markOutput()
    sendEvent(res, 'content_block_start', {
      index: contentIndex,
      content_block: { type: 'text', text: '' },
    })
  }

  const openTool = item => {
    startStream()
    closeActive()
    activeTool = {
      callId: item.call_id || item.id || `call_${randomUUID().replaceAll('-', '')}`,
      name: item.name,
      emittedArguments: 0,
    }
    toolCallSeen = true
    sawOutput = true
    trace?.markOutput()
    sendEvent(res, 'content_block_start', {
      index: contentIndex,
      content_block: {
        type: 'tool_use',
        id: activeTool.callId,
        name: activeTool.name,
        input: {},
      },
    })
  }

  const openPendingTool = (item, argumentsDelta = '') => {
    if (item && typeof item === 'object') {
      pendingTool = { ...(pendingTool || {}), ...item }
    }
    if (argumentsDelta) pendingToolArguments += argumentsDelta
    if (!pendingTool?.name) return false
    openTool(pendingTool)
    const delta = pendingToolArguments.slice(activeTool.emittedArguments)
    if (delta) {
      sendEvent(res, 'content_block_delta', {
        index: contentIndex,
        delta: { type: 'input_json_delta', partial_json: delta },
      })
      activeTool.emittedArguments = pendingToolArguments.length
    }
    pendingTool = null
    pendingToolArguments = ''
    return true
  }

  control?.setStreamErrorFinalizer(() => {
    if (streamStarted) closeActive()
  })

  const emitCompletedOutputFallback = response => {
    if (sawOutput || !response?.output) return
    for (const item of response.output) {
      if (item.type === 'message') {
        for (const part of item.content || []) {
          if (part.type === 'output_text' && part.text) {
            openText()
            sendEvent(res, 'content_block_delta', {
              index: contentIndex,
              delta: { type: 'text_delta', text: part.text },
            })
          }
        }
      } else if (item.type === 'function_call') {
        openTool(item)
        sendEvent(res, 'content_block_delta', {
          index: contentIndex,
          delta: { type: 'input_json_delta', partial_json: item.arguments || '{}' },
        })
      }
    }
  }

  const handleEvent = event => {
    const type = event?.type
    if (type === 'response.output_item.added' && event.item?.type === 'function_call') {
      // Metadata alone is not usable output. Buffer it until arguments arrive
      // so a provider timeout cannot commit an incomplete Anthropic message.
      pendingTool = event.item
      return
    }
    if (type === 'response.output_text.delta') {
      const text = typeof event.delta === 'string' ? event.delta : ''
      if (!text) return
      openText()
      sendEvent(res, 'content_block_delta', {
        index: contentIndex,
        delta: { type: 'text_delta', text },
      })
      return
    }
    if (type === 'response.function_call_arguments.delta') {
      const delta = typeof event.delta === 'string' ? event.delta : ''
      if (!delta) return
      if (!activeTool) {
        openPendingTool(event.item || {}, delta)
      } else {
        activeTool.emittedArguments += delta.length
        sendEvent(res, 'content_block_delta', {
          index: contentIndex,
          delta: { type: 'input_json_delta', partial_json: delta },
        })
      }
      return
    }
    if (type === 'response.output_item.done' && event.item?.type === 'function_call') {
      if (!activeTool) {
        const argumentsValue = typeof event.item.arguments === 'string'
          ? event.item.arguments
          : ''
        openPendingTool(event.item, argumentsValue || '{}')
      } else if (typeof event.item.arguments === 'string') {
        const delta = event.item.arguments.slice(activeTool.emittedArguments)
        if (delta) {
          activeTool.emittedArguments = event.item.arguments.length
          sendEvent(res, 'content_block_delta', {
            index: contentIndex,
            delta: { type: 'input_json_delta', partial_json: delta },
          })
        }
      }
      closeActive()
      contentIndex += 1
      return
    }
    if (type === 'response.completed') {
      sawCompletion = true
      usage = event.response?.usage || event.usage || null
      emitCompletedOutputFallback(event.response)
      return
    }
    if (type === 'response.failed') {
      throw new Error(event.response?.error?.message || 'Codex response failed')
    }
  }

  try {
    const decoder = new TextDecoder()
    const reader = upstream.body?.getReader()
    if (!reader) throw new Error('Codex returned an empty response body')
    control?.setUpstreamCancellation(() => reader.cancel())

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      control?.upstreamActivity?.()
      trace?.markFirstByte()
      trace?.addBytes(value?.byteLength || 0)
      buffer += decoder.decode(value, { stream: true })
      trace?.addEvent()
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6)
        if (!data || data === '[DONE]') continue
        handleEvent(JSON.parse(data))
      }
    }

    if (buffer.startsWith('data: ')) {
      const data = buffer.slice(6)
      if (data && data !== '[DONE]') handleEvent(JSON.parse(data))
    }

    if (!sawCompletion) {
      throw new Error('Codex stream ended before response.completed')
    }
    if (pendingTool && !pendingTool.name) {
      throw new Error('Codex returned a function call without a name')
    }
    if (!sawOutput) {
      throw new Error('Codex returned an empty or malformed response')
    }

    trace?.markCompletion()
    startStream()
    closeActive()
    sendEvent(res, 'message_delta', {
      delta: {
        stop_reason: toolCallSeen ? 'tool_use' : 'end_turn',
        stop_sequence: null,
      },
      usage: {
        ...codexUsageToAnthropic(usage),
      },
    })
    sendEvent(res, 'message_stop', {})
    res.end()
    return true
  } catch (error) {
    process.stderr.write(
      `model-gateway codex stream-error model=${safeLogValue(model)} class=${safeLogValue(classifyGatewayError(error))}\n`,
    )
    trace?.markError(error)
    if (!streamStarted && options.throwPreOutput) {
      await upstream.body?.cancel?.().catch(() => {})
      throw error
    }
    if (!streamStarted) {
      if (isContextWindowFailure(error)) {
        finishAnthropicPromptTooLongError(res, error)
      } else {
        anthropicError(res, 502, errorMessage(error))
      }
      return
    }
    closeActive()
    finishAnthropicStreamWithError(res, error)
    return false
  }
}

async function responseIsContextWindowFailure(response) {
  if (response?.status !== 400 || typeof response.clone !== 'function') return false
  try {
    const raw = await response.clone().text()
    if (!raw) return false
    const values = []
    const collectStrings = value => {
      if (typeof value === 'string') {
        values.push(value)
      } else if (Array.isArray(value)) {
        for (const item of value) collectStrings(item)
      } else if (value && typeof value === 'object') {
        for (const child of Object.values(value)) collectStrings(child)
      }
    }
    collectStrings(JSON.parse(raw))
    return values.some(value => isContextWindowFailure(new Error(value)))
  } catch {
    return false
  }
}

function copyResponseHeaders(upstream, includeStreamHeaders = false) {
  const headers = {}
  for (const name of ['content-type', 'cache-control', 'retry-after', 'x-request-id']) {
    const value = upstream.headers.get(name)
    if (value) headers[name] = value
  }
  if (includeStreamHeaders) {
    headers.connection = 'keep-alive'
    headers['x-accel-buffering'] = 'no'
  }
  return headers
}

function deepSeekEventHasUsableOutput(event) {
  if (event?.type === 'content_block_start') {
    return event.content_block?.type === 'tool_use'
  }
  if (event?.type !== 'content_block_delta') return false
  const delta = event.delta || {}
  if (delta.type === 'text_delta') return typeof delta.text === 'string' && delta.text.length > 0
  if (delta.type === 'input_json_delta') {
    return typeof delta.partial_json === 'string' && delta.partial_json.length > 0
  }
  if (delta.type === 'thinking_delta') {
    return typeof delta.thinking === 'string' && delta.thinking.length > 0
  }
  return false
}

function parseDeepSeekSseFrame(frame) {
  const data = frame
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
    .join('\n')
  if (!data || data === '[DONE]') return null
  try {
    return JSON.parse(data)
  } catch {
    throw new Error('DeepSeek returned malformed Anthropic SSE data')
  }
}

async function writeDeepSeekChunk(res, chunk) {
  if (res.destroyed || res.writableEnded) return
  if (!res.write(chunk)) {
    await new Promise(resolve => res.once('drain', resolve))
  }
}

export async function relayDeepSeekStream(res, upstream, trace = null, options = {}) {
  let streamStarted = false
  let sawOutput = false
  let sawMessageStop = false
  let pending = ''
  let buffer = ''
  let reader = null
  const maxPendingBytes = 1024 * 1024

  const startStream = () => {
    if (streamStarted) return
    res.writeHead(upstream.status, copyResponseHeaders(upstream, true))
    streamStarted = true
    if (pending) {
      res.write(pending)
      pending = ''
    }
  }

  const emitFrame = async frame => {
    const event = parseDeepSeekSseFrame(frame)
    if (event?.type === 'error') {
      throw new Error(event.error?.message || 'DeepSeek Anthropic request failed')
    }
    if (event?.type === 'message_stop') sawMessageStop = true
    if (deepSeekEventHasUsableOutput(event)) {
      sawOutput = true
      trace?.markOutput()
      startStream()
    }
    if (streamStarted) {
      await writeDeepSeekChunk(res, frame)
      return
    }
    pending += frame
    if (Buffer.byteLength(pending, 'utf8') > maxPendingBytes) {
      throw new Error('DeepSeek response exceeded the pre-output buffer')
    }
  }

  try {
    reader = upstream.body?.getReader()
    if (!reader) throw new Error('DeepSeek returned an empty response body')
    options.control?.setUpstreamCancellation?.(() => reader.cancel())
    const decoder = new TextDecoder()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      trace?.markFirstByte()
      trace?.addBytes(value?.byteLength || 0)
      trace?.addEvent()
      buffer += decoder.decode(value, { stream: true })
      const frames = buffer.split(/\r?\n\r?\n/)
      buffer = frames.pop() || ''
      for (const frame of frames) {
        if (frame) await emitFrame(`${frame}\n\n`)
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) await emitFrame(buffer)

    if (!sawOutput) {
      throw new Error(sawMessageStop
        ? 'DeepSeek returned an empty or malformed response'
        : 'DeepSeek stream ended before usable output')
    }
    if (!sawMessageStop) throw new Error('DeepSeek stream ended before message_stop')
    trace?.markCompletion()
    res.end()
  } catch (error) {
    trace?.markError(error)
    await upstream.body?.cancel?.().catch(() => {})
    if (options.throwPreOutput && !res.headersSent) throw error
    if (!streamStarted) {
      if (isContextWindowFailure(error)) finishAnthropicPromptTooLongError(res, error)
      else anthropicError(res, 502, errorMessage(error))
    } else {
      finishAnthropicStreamWithError(res, error)
    }
  } finally {
    reader?.releaseLock()
  }
}

function deepSeekJsonHasUsableOutput(message) {
  return Array.isArray(message?.content) && message.content.some(block => {
    if (block?.type === 'text') return typeof block.text === 'string' && block.text.length > 0
    if (block?.type === 'tool_use') {
      return typeof block.id === 'string' && block.id.length > 0 &&
        typeof block.name === 'string' && block.name.length > 0
    }
    if (block?.type === 'thinking') return typeof block.thinking === 'string' && block.thinking.length > 0
    return false
  })
}

function deepSeekJsonFailure(response) {
  const detail = [
    response?.error?.message,
    response?.message,
    typeof response?.error === 'string' ? response.error : null,
  ].find(value => typeof value === 'string' && value)
  if (detail && isContextWindowFailure(new Error(detail))) {
    throw new Error(`Prompt is too long: ${detail}`)
  }
  throw new Error(detail ? String(detail) : 'DeepSeek response failed')
}

export async function relayDeepSeekResponse(res, upstream, trace = null, options = {}) {
  try {
    const raw = await upstream.text()
    trace?.markFirstByte()
    trace?.addBytes(Buffer.byteLength(raw, 'utf8'))
    trace?.addEvent()
    const response = JSON.parse(raw)
    if (!response || typeof response !== 'object' || Array.isArray(response)) {
      throw new Error('DeepSeek returned malformed JSON')
    }
    if (response.type === 'error' || response.error) deepSeekJsonFailure(response)
    if (response.type !== 'message' || !deepSeekJsonHasUsableOutput(response)) {
      throw new Error('DeepSeek returned an empty or malformed response')
    }
    trace?.markOutput()
    trace?.markCompletion()
    json(res, 200, response)
  } catch (error) {
    trace?.markError(error)
    if (options.throwPreOutput && !res.headersSent) {
      await upstream.body?.cancel?.().catch(() => {})
      throw error
    }
    if (isContextWindowFailure(error)) finishAnthropicPromptTooLongError(res, error)
    else anthropicError(res, 502, errorMessage(error))
  }
}

async function handleCodex(body, req, res, modelName, route) {
  const trace = createGatewayTrace({ model: modelName, backend: 'codex', protocol: 'responses' })
  const control = createRequestControl(req, res, trace)
  let auth
  try {
    auth = await readCodexAuth()
  } catch (error) {
    trace.markError(error)
    anthropicError(res, 401, error instanceof Error ? error.message : 'Codex auth unavailable')
    trace.finish('auth-error', error, 401)
    control.cleanup()
    return
  }

  let request
  try {
    request = anthropicToCodex(body, route.upstream, routeEffortLevels(route))
    // The Codex Responses endpoint requires SSE even when the Anthropic caller
    // requested a buffered JSON response. Buffering back to JSON happens in
    // relayCodexResponse.
    request.stream = true
    // The current Codex Responses endpoint rejects both max_tokens and
    // max_output_tokens. Keep the caller's cap in the Anthropic contract, but
    // omit the unsupported field from the upstream request.
    delete request.max_output_tokens
    const compaction = isCompactionRequest(body)
    if (compaction) {
      // Cache-sharing compaction inherits Claude's tool catalog, but the
      // compaction contract is text-only. Forwarding those tools makes Codex
      // spend time planning tool calls that Claude will reject.
      delete request.tools
      request.tool_choice = 'none'
      request.reasoning.effort = 'low'
    }
    process.stderr.write(
      `model-gateway codex request model=${safeLogValue(modelName)} ` +
      `tools=${Array.isArray(request.tools) ? request.tools.length : 0} ` +
      `tool_choice=${safeLogValue(request.tool_choice || 'unset')} ` +
      `compaction=${compaction ? '1' : '0'}\n`,
    )
  } catch (error) {
    trace.markError(error)
    anthropicError(res, 400, error instanceof Error ? error.message : 'Unsupported request')
    trace.finish('invalid-request', error, 400)
    control.cleanup()
    return
  }

  const wantsStream = body.stream === true
  const requests = codexRequestVariants(request)
  let requestError = null
  let completed = false

  try {
    let variantIndex = 0
    while (variantIndex < requests.length) {
      const variant = requests[variantIndex]
      if (variantIndex > 0) {
        trace.clearError?.()
        process.stderr.write(
          `model-gateway context-fallback model=${safeLogValue(modelName)} variant=${variantIndex} ${codexRequestShape(variant)}\n`,
        )
      }

      let responseRetryAttempt = 0
      let advanceVariant = true
      while (true) {
        control.startUpstream()
        let upstream
        try {
          upstream = await fetchWithRetry({
            provider: 'Codex',
            url: CODEX_ENDPOINT,
            options: {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${auth.accessToken}`,
                'chatgpt-account-id': auth.accountId,
                'content-type': 'application/json',
                accept: 'text/event-stream',
                'user-agent': 'claudex-model-gateway/0.1',
              },
              body: JSON.stringify(variant),
              signal: control.signal,
            },
            control,
            trace,
          })
        } catch (error) {
          requestError = error
          const status = control.signal.aborted ? control.statusFor(error) : 502
          anthropicError(res, status, status === 504 ? 'Codex upstream request timed out' : 'Codex connection failed')
          trace.finish('upstream-error', error, status)
          advanceVariant = false
          variantIndex = requests.length
          break
        }

        control.setUpstreamCancellation(() => upstream.body?.cancel())
        if (!upstream.ok) {
          const detail = await upstreamErrorDetail(upstream, 'Codex')
          const contextFailure = isContextWindowFailure(new Error(detail))
          process.stderr.write(
            `model-gateway codex upstream-error status=${upstream.status} detail=${safeLogValue(detail)}\n`,
          )
          if (contextFailure && variantIndex < requests.length - 1) {
            requestError = new Error('Prompt is too long: Codex context window exceeded')
            break
          }
          const status = upstream.status >= 500 ? 502 : upstream.status
          const error = new Error(detail)
          anthropicError(res, contextFailure ? 400 : status, error.message)
          trace.finish('upstream-http-error', error, contextFailure ? 400 : status)
          advanceVariant = false
          variantIndex = requests.length
          break
        }

        try {
          const throwPreOutput = true
          completed = wantsStream
            ? await relayCodexStream(res, upstream, modelName, trace, control, { throwPreOutput })
            : await relayCodexResponse(res, upstream, modelName, trace, true, control, { throwPreOutput })
          break
        } catch (error) {
          requestError = error
          if (isContextWindowFailure(error) && !res.headersSent && variantIndex < requests.length - 1) {
            break
          }
          if (
            !res.headersSent &&
            retryablePreOutputRelayError(error) &&
            responseRetryAttempt < UPSTREAM_RETRIES
          ) {
            responseRetryAttempt += 1
            const delay = retryDelayMs(responseRetryAttempt, null)
            trace.clearError?.()
            process.stderr.write(
              `model-gateway retry provider=Codex error=pre-output-${safeLogValue(classifyGatewayError(error))} attempt=${responseRetryAttempt} delay_ms=${delay}\n`,
            )
            await waitForRetry(delay, control.signal)
            continue
          }
          if (!res.headersSent) {
            if (isContextWindowFailure(error)) {
              finishAnthropicPromptTooLongError(res, error)
            } else {
              anthropicError(res, 502, error instanceof Error ? error.message : 'Codex request failed')
            }
          } else if (wantsStream) {
            process.stderr.write(
              `model-gateway codex-stream-error model=${safeLogValue(modelName)} class=${safeLogValue(classifyGatewayError(error))}\n`,
            )
            finishAnthropicStreamWithError(res, error)
          }
          advanceVariant = false
          variantIndex = requests.length
          break
        }
      }

      if (completed) break
      if (variantIndex < requests.length - 1 && advanceVariant) {
        variantIndex += 1
      } else if (variantIndex < requests.length) {
        variantIndex += 1
      }
    }

    if (!completed && !res.headersSent && requestError) {
      anthropicError(res, isContextWindowFailure(requestError) ? 400 : 502, errorMessage(requestError))
    }
    if (!trace.finished) {
      trace.finish(
        completed || res.statusCode === 200 ? 'success' : 'error',
        requestError,
        res.statusCode,
      )
    }
  } finally {
    control.cleanup()
  }
}

function deepSeekHeaders(req, apiKey, stream = false) {
  const hopByHop = new Set([
    'connection',
    'content-length',
    'host',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'x-api-key',
    'authorization',
    'accept',
  ])
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value == null || hopByHop.has(name.toLowerCase())) continue
    headers.set(name, Array.isArray(value) ? value.join(', ') : value)
  }
  headers.set('x-api-key', apiKey)
  headers.set('accept', stream ? 'text/event-stream' : 'application/json')
  if (!headers.has('content-type')) headers.set('content-type', 'application/json')
  return headers
}

async function handleOpenCodeGo(body, req, res, modelName, route) {
  const wantsStream = body.stream === true
  const trace = createGatewayTrace({ model: modelName, backend: 'opencode-go', protocol: route.protocol })
  const control = createRequestControl(req, res, trace)
  const apiKey = process.env.OPENCODE_API_KEY
  if (!apiKey) {
    anthropicError(res, 401, 'OpenCode Go API key is not configured')
    trace.finish('auth-error', null, 401)
    control.cleanup()
    return
  }

  let request
  try {
    request = anthropicToOpenCodeRequest(body, route)
  } catch (error) {
    anthropicError(res, 400, error instanceof Error ? error.message : 'Unsupported request')
    trace.finish('invalid-request', error, 400)
    control.cleanup()
    return
  }

  try {
    for (let relayAttempt = 0; ; relayAttempt += 1) {
      if (relayAttempt > 0) control.retryUpstream()
      control.startUpstream()
      let upstream
      try {
        upstream = await fetchWithRetry({
          provider: 'OpenCode Go',
          url: openCodeGoEndpoint(route.protocol),
          options: {
            method: 'POST',
            headers: openCodeGoHeaders(route.protocol, apiKey, wantsStream),
            body: JSON.stringify(request),
            signal: control.signal,
          },
          control,
          trace,
        })
      } catch (error) {
        trace.markError(error)
        const status = control.signal.aborted ? control.statusFor(error) : 502
        anthropicError(res, status, status === 504 ? 'OpenCode Go upstream request timed out' : 'OpenCode Go connection failed')
        trace.finish('upstream-error', error, status)
        return
      }

      if (!upstream.ok) {
        await upstream.body?.cancel().catch(() => {})
        const status = upstream.status >= 500 ? 502 : upstream.status
        anthropicError(res, status, redactSecret(safeUpstreamError(upstream.status, 'OpenCode Go'), apiKey))
        trace.finish('upstream-http-error', null, status)
        return
      }

      control.setUpstreamCancellation(() => upstream.body?.cancel())
      try {
        const options = { throwPreOutput: true, control }
        if (wantsStream) {
          await relayOpenCodeStream(res, upstream, modelName, route.protocol, trace, options)
        } else {
          await relayOpenCodeResponseByProtocol(res, upstream, modelName, route.protocol, trace, options)
        }
        break
      } catch (error) {
        if (
          !res.headersSent &&
          retryablePreOutputRelayError(error) &&
          relayAttempt < OPENCODE_RETRIES
        ) {
          const attempt = relayAttempt + 1
          const delay = retryDelayMs(attempt, null)
          trace.clearError?.()
          process.stderr.write(
            `model-gateway retry provider=OpenCode-Go error=pre-output-${safeLogValue(classifyGatewayError(error))} attempt=${attempt}/${OPENCODE_RETRIES} delay_ms=${delay}\n`,
          )
          await waitForRetry(delay, control.signal)
          continue
        }
        throw error
      }
    }
    trace.finish(res.headersSent && res.statusCode === 200 ? 'success' : 'error', null, res.statusCode)
  } catch (error) {
    trace.markError(error)
    if (!res.headersSent) {
      if (isContextWindowFailure(error)) {
        finishAnthropicPromptTooLongError(res, error)
      } else {
        anthropicError(res, 502, error instanceof Error ? error.message : 'OpenCode Go request failed')
      }
    } else if (wantsStream) {
      finishAnthropicStreamWithError(res, error)
    }
    trace.finish('request-error', error, res.statusCode)
  } finally {
    control.cleanup()
  }
}

function openRouterHeaders(apiKey, stream = false) {
  return {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
    accept: stream ? 'text/event-stream' : 'application/json',
    'user-agent': 'claudex-model-gateway/0.1',
    'http-referer': 'http://127.0.0.1',
    'x-title': 'Claudex Gateway',
  }
}

async function handleOpenRouter(body, req, res, modelName, route) {
  const wantsStream = body.stream === true
  const trace = createGatewayTrace({ model: modelName, backend: 'openrouter', protocol: 'chat-completions' })
  const control = createRequestControl(req, res, trace)
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) {
    anthropicError(res, 401, 'OpenRouter API key is not configured')
    trace.finish('auth-error', null, 401)
    control.cleanup()
    return
  }

  let request
  try {
    request = anthropicToOpenCodeRequest(body, {
      upstream: route.upstream,
      protocol: 'chat-completions',
    })
  } catch (error) {
    anthropicError(res, 400, error instanceof Error ? error.message : 'Unsupported request')
    trace.finish('invalid-request', error, 400)
    control.cleanup()
    return
  }

  try {
    for (let relayAttempt = 0; ; relayAttempt += 1) {
      if (relayAttempt > 0) control.retryUpstream()
      control.startUpstream()
      let upstream
      try {
        upstream = await fetchWithRetry({
          provider: 'OpenRouter',
          url: OPENROUTER_ENDPOINT,
          options: {
            method: 'POST',
            headers: openRouterHeaders(apiKey, wantsStream),
            body: JSON.stringify(request),
            signal: control.signal,
          },
          control,
          trace,
        })
      } catch (error) {
        trace.markError(error)
        const status = control.signal.aborted ? control.statusFor(error) : 502
        anthropicError(res, status, status === 504 ? 'OpenRouter upstream request timed out' : 'OpenRouter connection failed')
        trace.finish('upstream-error', error, status)
        return
      }

      control.setUpstreamCancellation(() => upstream.body?.cancel())
      if (!upstream.ok) {
        await upstream.body?.cancel().catch(() => {})
        const status = upstream.status >= 500 ? 502 : upstream.status
        anthropicError(res, status, redactSecret(safeUpstreamError(upstream.status, 'OpenRouter'), apiKey))
        trace.finish('upstream-http-error', null, status)
        return
      }

      try {
        const options = { throwPreOutput: true, control }
        if (wantsStream) {
          await relayOpenCodeStream(res, upstream, modelName, 'chat-completions', trace, options)
        } else {
          await relayOpenCodeResponseByProtocol(res, upstream, modelName, 'chat-completions', trace, options)
        }
        break
      } catch (error) {
        if (
          !res.headersSent &&
          retryablePreOutputRelayError(error) &&
          relayAttempt < UPSTREAM_RETRIES
        ) {
          const attempt = relayAttempt + 1
          const delay = retryDelayMs(attempt, null)
          trace.clearError?.()
          process.stderr.write(
            `model-gateway retry provider=OpenRouter error=pre-output-${safeLogValue(classifyGatewayError(error))} attempt=${attempt} delay_ms=${delay}\n`,
          )
          await waitForRetry(delay, control.signal)
          continue
        }
        throw error
      }
    }
    trace.finish(res.headersSent && res.statusCode === 200 ? 'success' : 'error', null, res.statusCode)
  } catch (error) {
    trace.markError(error)
    if (!res.headersSent) {
      if (isContextWindowFailure(error)) {
        finishAnthropicPromptTooLongError(res, error)
      } else {
        anthropicError(res, 502, error instanceof Error ? error.message : 'OpenRouter request failed')
      }
    } else if (wantsStream) {
      finishAnthropicStreamWithError(res, error)
    }
    trace.finish('request-error', error, res.statusCode)
  } finally {
    control.cleanup()
  }
}

async function handleDeepSeek(req, res, requestUrl, rawBody, modelName) {
  let body
  try {
    body = JSON.parse(rawBody.toString('utf8'))
  } catch (error) {
    anthropicError(res, 400, error instanceof Error ? error.message : 'Invalid JSON')
    return
  }
  const wantsStream = body.stream === true
  const trace = createGatewayTrace({ model: modelName, backend: 'deepseek', protocol: 'anthropic-messages' })
  const control = createRequestControl(req, res, trace)
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) {
    anthropicError(res, 401, 'DeepSeek API key is not configured')
    trace.finish('auth-error', null, 401)
    control.cleanup()
    return
  }

  const upstreamUrl = new URL(DEEPSEEK_ENDPOINT)
  upstreamUrl.search = requestUrl.search

  try {
    for (let relayAttempt = 0; ; relayAttempt += 1) {
      if (relayAttempt > 0) control.retryUpstream()
      control.startUpstream()
      let upstream
      try {
        upstream = await fetchWithRetry({
          provider: 'DeepSeek',
          url: upstreamUrl,
          options: {
            method: 'POST',
            headers: deepSeekHeaders(req, apiKey, wantsStream),
            body: rawBody,
            signal: control.signal,
          },
          control,
          trace,
        })
      } catch (error) {
        trace.markError(error)
        const status = control.signal.aborted ? control.statusFor(error) : 502
        anthropicError(res, status, status === 504 ? 'DeepSeek upstream request timed out' : 'DeepSeek connection failed')
        trace.finish('upstream-error', error, status)
        return
      }

      if (!upstream.ok) {
        await upstream.body?.cancel().catch(() => {})
        const status = upstream.status >= 500 ? 502 : upstream.status
        anthropicError(res, status, safeUpstreamError(upstream.status, 'DeepSeek'))
        trace.finish('upstream-http-error', null, status)
        return
      }

      control.setUpstreamCancellation(() => upstream.body?.cancel())
      try {
        const options = { throwPreOutput: true, control }
        if (wantsStream) {
          await relayDeepSeekStream(res, upstream, trace, options)
        } else {
          await relayDeepSeekResponse(res, upstream, trace, options)
        }
        break
      } catch (error) {
        if (
          !res.headersSent &&
          retryablePreOutputRelayError(error) &&
          relayAttempt < UPSTREAM_RETRIES
        ) {
          const attempt = relayAttempt + 1
          const delay = retryDelayMs(attempt, null)
          trace.clearError?.()
          process.stderr.write(
            `model-gateway retry provider=DeepSeek error=pre-output-${safeLogValue(classifyGatewayError(error))} attempt=${attempt} delay_ms=${delay}\n`,
          )
          await waitForRetry(delay, control.signal)
          continue
        }
        throw error
      }
    }
    trace.markCompletion()
    trace.finish('success', null, res.statusCode)
  } catch (error) {
    trace.markError(error)
    if (!res.headersSent) {
      if (isContextWindowFailure(error)) {
        finishAnthropicPromptTooLongError(res, error)
      } else {
        anthropicError(res, 502, error instanceof Error ? error.message : 'DeepSeek stream failed')
      }
    } else {
      finishAnthropicStreamWithError(res, error)
    }
    trace.finish('stream-error', error, res.statusCode)
  } finally {
    control.cleanup()
  }
}

function safeLogValue(value) {
  return String(value ?? 'unknown').replace(/[\r\n]/g, ' ')
}

function logRoute(requestUrl, modelName, backend) {
  process.stderr.write(
    `model-gateway route path=${requestUrl.pathname} model=${safeLogValue(modelName)} backend=${backend}\n`,
  )
}

function modelsResponse() {
  const data = MODEL_NAMES.map(id => {
    const backend = MODELS[id].backend
    const upstream = MODELS[id].upstream || id
    return {
      id,
      object: 'model',
      type: 'model',
      created: 0,
      owned_by:
      backend === 'codex'
        ? 'codex'
        : backend === 'deepseek'
          ? 'deepseek'
            : backend === 'openrouter'
              ? 'openrouter'
              : 'opencode-go',
      display_name: upstream,          // Claude Code's gateway discovery labels entries by this
    }
  })
  return {
    object: 'list',
    data,
    models: MODEL_NAMES,
  }
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || '/', `http://${HOST}`)

  if (req.method === 'GET' && requestUrl.pathname === '/health') {
    process.stderr.write('model-gateway route path=/health backend=health\n')
    json(res, 200, { status: 'ok', modelCount: MODEL_NAMES.length })
    return
  }

  if (req.method === 'GET' && requestUrl.pathname === '/v1/models') {
    process.stderr.write('model-gateway route path=/v1/models backend=models\n')
    json(res, 200, modelsResponse())
    return
  }

  if (req.method !== 'POST' || requestUrl.pathname !== '/v1/messages') {
    json(res, 404, { error: 'Not found' })
    return
  }

  let rawBody
  try {
    rawBody = await readRawBody(req)
  } catch (error) {
    logRoute(requestUrl, 'unknown', 'invalid-request')
    anthropicError(res, 400, error instanceof Error ? error.message : 'Invalid request body')
    return
  }

  let body
  try {
    body = JSON.parse(rawBody.toString('utf8'))
  } catch (error) {
    logRoute(requestUrl, 'unknown', 'invalid-request')
    anthropicError(res, 400, error instanceof Error ? error.message : 'Invalid JSON')
    return
  }

  const modelName = typeof body?.model === 'string' ? body.model : ''
  const route = MODELS[modelName]
  if (!route) {
    logRoute(requestUrl, modelName || 'unknown', 'unsupported')
    anthropicError(res, 400, `Unsupported model: ${modelName || 'missing'}`)
    return
  }

  body = withRouteEffort(body, route)
  rawBody = Buffer.from(JSON.stringify(body))
  logRoute(requestUrl, modelName, route.backend)
  if (route.backend === 'codex') {
    await handleCodex(body, req, res, modelName, route)
    return
  }
  if (route.backend === 'opencode-go') {
    await handleOpenCodeGo(body, req, res, modelName, route)
    return
  }
  if (route.backend === 'openrouter') {
    await handleOpenRouter(body, req, res, modelName, route)
    return
  }

  // A claude-* deepseek alias must reach DeepSeek under its REAL model name — the deepseek
  // route forwards the body as-is, so rewrite body.model when the alias differs from upstream.
  if (typeof route.upstream === 'string' && route.upstream !== modelName) {
    try {
      const obj = JSON.parse(rawBody.toString('utf8'))
      obj.model = route.upstream
      rawBody = Buffer.from(JSON.stringify(obj))
    } catch { /* malformed body: let handleDeepSeek surface the real error */ }
  }
  await handleDeepSeek(req, res, requestUrl, rawBody, modelName)
})

server.on('error', error => {
  process.stderr.write(
    `model-gateway error: ${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exitCode = 1
})

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  server.listen(PORT, HOST, () => {
    const address = server.address()
    const boundPort = typeof address === 'object' && address ? address.port : PORT
    process.stderr.write(
      `model-gateway listening on http://${HOST}:${boundPort} models=${MODEL_NAMES.join(',')}\n`,
    )
  })
}
