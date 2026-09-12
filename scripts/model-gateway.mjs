import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  OPENCODE_GO_ROUTES,
  OPENCODE_GO_MODEL_IDS,
  openCodeGoEffortLevels,
  openCodeGoEffortWireMap,
  isOpenCodeGoProtocol,
  anthropicToOpenCodeRequest,
  openCodeGoEndpoint,
  openCodeGoHeaders,
  redactSecret,
  relayOpenCodeStream,
  relayOpenCodeResponseByProtocol,
} from './opencode-go.mjs'
import {
  OPENCODE_ZEN_ROUTES,
  OPENCODE_ZEN_MODEL_IDS,
  openCodeZenEffortLevels,
  openCodeZenEffortWireMap,
  openCodeZenEndpoint,
  openCodeZenHeaders,
  isOpenCodeZenProtocol,
} from './opencode-zen.mjs'
import {
  gatewayCatalogDrift,
  ASTRA_EFFORT_LEVELS,
  GPT_LUNA_EFFORT_LEVELS,
  GPT_SOL_EFFORT_LEVELS,
  GPT_TERRA_EFFORT_LEVELS,
  NATIVE_EFFORT_LEVELS,
} from './effort-capabilities.mjs'
import {
  appendRuntimeToolContract,
  gatewayQuerySource,
  isCompactionRequest,
  isNativeSummaryRequest,
  rewriteGatewaySystemPrompt,
  RUNTIME_TOOL_CONTRACT,
  sanitizeLegacyCompactionContent,
  sanitizeStaleToolCapabilityContent,
} from './gateway-contract.mjs'

const HOST = '127.0.0.1'
const CODEX_ENDPOINT =
  process.env.CODEX_RESPONSES_URL || 'https://chatgpt.com/backend-api/codex/responses'
const DEEPSEEK_ENDPOINT =
  process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/anthropic/v1/messages'
const CODEX_REASONING_EFFORT =
  process.env.MODEL_GATEWAY_CODEX_REASONING_EFFORT || 'max'
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
const UPSTREAM_RETRY_BASE_MS = durationEnvironment(
  'MODEL_GATEWAY_UPSTREAM_RETRY_BASE_MS',
  250,
)
const UPSTREAM_RETRY_MAX_MS = durationEnvironment(
  'MODEL_GATEWAY_UPSTREAM_RETRY_MAX_MS',
  5_000,
)
const RETRY_ATTEMPT_TIMEOUT_MS = durationEnvironment(
  'MODEL_GATEWAY_RETRY_ATTEMPT_TIMEOUT_MS',
  30_000,
)
const RETRY_RESPONSE_TIMEOUT_MS = RETRY_ATTEMPT_TIMEOUT_MS > 0
  ? Math.min(UPSTREAM_TIMEOUT_MS, RETRY_ATTEMPT_TIMEOUT_MS)
  : UPSTREAM_TIMEOUT_MS
const RETRY_400 = process.env.MODEL_GATEWAY_RETRY_400 === '1'
const CODEX_TOOL_MODE = process.env.MODEL_GATEWAY_CODEX_TOOL_MODE || 'fallback'
const CODEX_PROMPT_CACHE_KEY_MODE =
  process.env.MODEL_GATEWAY_CODEX_PROMPT_CACHE_KEY_MODE || 'off'
const LOG_REQUEST_SHAPE = process.env.MODEL_GATEWAY_LOG_SHAPE === '1'
const LOG_EVENT_SHAPE = process.env.MODEL_GATEWAY_LOG_EVENT_SHAPE === '1'

if (!['fallback', 'balanced', 'compact'].includes(CODEX_TOOL_MODE)) {
  throw new Error(
    'MODEL_GATEWAY_CODEX_TOOL_MODE must be fallback, balanced, or compact',
  )
}
if (!['off', 'auto'].includes(CODEX_PROMPT_CACHE_KEY_MODE)) {
  throw new Error(
    'MODEL_GATEWAY_CODEX_PROMPT_CACHE_KEY_MODE must be off or auto',
  )
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

const DEFAULT_MODELS = {
  // Provider-native IDs remain routable for old scripts and direct callers,
  // but are deliberately hidden from Gateway discovery and the /model picker.
  'gpt-5.6-luna': { backend: 'codex', upstream: 'gpt-5.6-luna', effortLevels: GPT_LUNA_EFFORT_LEVELS, hidden: true },
  'gpt-5.6-sol': { backend: 'codex', upstream: 'gpt-5.6-sol', effortLevels: GPT_SOL_EFFORT_LEVELS, hidden: true },
  'gpt-5.6-terra': { backend: 'codex', upstream: 'gpt-5.6-terra', effortLevels: GPT_TERRA_EFFORT_LEVELS, hidden: true },
  'gpt-6-astra': { backend: 'codex', upstream: 'gpt-6-astra', effortLevels: ASTRA_EFFORT_LEVELS, hidden: true },
  'deepseek-flash': { backend: 'deepseek', upstream: 'deepseek-flash', effortLevels: ['low', 'high', 'max'], hidden: true },
  'deepseek-v4-flash': { backend: 'deepseek', upstream: 'deepseek-v4-flash', effortLevels: ['low', 'high', 'max'], hidden: true },
  'deepseek-v4-pro': { backend: 'deepseek', upstream: 'deepseek-v4-pro', effortLevels: ['low', 'high', 'max'], hidden: true },
  'deepseek-v4.1-flash': { backend: 'deepseek', upstream: 'deepseek-flash', effortLevels: ['low', 'high', 'max'], hidden: true },
  ...Object.fromEntries(
    OPENCODE_GO_MODEL_IDS.map(model => [
      `opencode-go/${model}`,
      {
        backend: 'opencode-go',
        upstream: model,
        protocol: OPENCODE_GO_ROUTES[model],
        effortLevels: openCodeGoEffortLevels(model),
        effortWireMap: openCodeGoEffortWireMap(model),
        hidden: true,
        ...(model === 'hy3' ? { supportsTools: false } : {}),
        ...(['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4.1-flash', 'qwen3.8-max', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-plus'].includes(model)
          ? { supportsForcedToolChoice: false }
          : {}),
      },
    ]),
  ),
  // Gateway-visible aliases make the provider boundary explicit in /model and
  // /v1/models. The raw opencode-go/* IDs remain supported for direct callers.
  ...Object.fromEntries(
    OPENCODE_ZEN_MODEL_IDS.map(model => [
      `opencode-zen/${model}`,
      {
        backend: 'opencode-zen',
        upstream: model,
        protocol: OPENCODE_ZEN_ROUTES[model],
        effortLevels: openCodeZenEffortLevels(model),
        effortWireMap: openCodeZenEffortWireMap(model),
        hidden: true,
        ...(model === 'hy3-free' ? { supportsTools: false } : {}),
      },
    ]),
  ),
  ...Object.fromEntries(
    OPENCODE_ZEN_MODEL_IDS.map(model => [
      `gateway-opencode-${model}`,
      {
        backend: 'opencode-zen',
        upstream: model,
        protocol: OPENCODE_ZEN_ROUTES[model],
        effortLevels: openCodeZenEffortLevels(model),
        effortWireMap: openCodeZenEffortWireMap(model),
        ...(model === 'hy3-free' ? { supportsTools: false } : {}),
      },
    ]),
  ),
  ...Object.fromEntries(
    OPENCODE_GO_MODEL_IDS.map(model => [
      `gateway-opencode-${model}`,
      {
        backend: 'opencode-go',
        upstream: model,
        protocol: OPENCODE_GO_ROUTES[model],
        effortLevels: openCodeGoEffortLevels(model),
        effortWireMap: openCodeGoEffortWireMap(model),
        ...(model === 'hy3' ? { supportsTools: false } : {}),
        ...(['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4.1-flash', 'qwen3.8-max', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-plus'].includes(model)
          ? { supportsForcedToolChoice: false }
          : {}),
      },
    ]),
  ),
  'gateway-gpt-luna': { backend: 'codex', upstream: 'gpt-5.6-luna', effortLevels: GPT_LUNA_EFFORT_LEVELS },
  'gateway-gpt-sol': { backend: 'codex', upstream: 'gpt-5.6-sol', effortLevels: GPT_SOL_EFFORT_LEVELS },
  'gateway-gpt-terra': { backend: 'codex', upstream: 'gpt-5.6-terra', effortLevels: GPT_TERRA_EFFORT_LEVELS },
  'gateway-gpt-astra': { backend: 'codex', upstream: 'gpt-6-astra', effortLevels: ASTRA_EFFORT_LEVELS },
  'gateway-ds-flash': { backend: 'deepseek', upstream: 'deepseek-v4-flash', effortLevels: ['low', 'high', 'max'] },
  'gateway-ds-pro': { backend: 'deepseek', upstream: 'deepseek-v4-pro', effortLevels: ['low', 'high', 'max'] },
  'gateway-ds-4.1-flash': { backend: 'deepseek', upstream: 'deepseek-flash', effortLevels: ['low', 'high', 'max'] },
  // Legacy aliases for existing transcripts and direct callers. They remain
  // routable but hidden so a new session cannot accidentally select a Claude-
  // named route.
  'claude-gpt-luna': { backend: 'codex', upstream: 'gpt-5.6-luna', effortLevels: GPT_LUNA_EFFORT_LEVELS, hidden: true },
  'claude-gpt-sol': { backend: 'codex', upstream: 'gpt-5.6-sol', effortLevels: GPT_SOL_EFFORT_LEVELS, hidden: true },
  'claude-gpt-terra': { backend: 'codex', upstream: 'gpt-5.6-terra', effortLevels: GPT_TERRA_EFFORT_LEVELS, hidden: true },
  'claude-gpt-astra': { backend: 'codex', upstream: 'gpt-6-astra', effortLevels: ASTRA_EFFORT_LEVELS, hidden: true },
  'claude-ds-flash': { backend: 'deepseek', upstream: 'deepseek-v4-flash', effortLevels: ['low', 'high', 'max'], hidden: true },
  'claude-ds-pro': { backend: 'deepseek', upstream: 'deepseek-v4-pro', effortLevels: ['low', 'high', 'max'], hidden: true },
  'claude-ds-4.1-flash': { backend: 'deepseek', upstream: 'deepseek-flash', effortLevels: ['low', 'high', 'max'], hidden: true },
  ...Object.fromEntries(
    OPENCODE_ZEN_MODEL_IDS.map(model => [
      `claude-opencode-${model}`,
      {
        backend: 'opencode-zen',
        upstream: model,
        protocol: OPENCODE_ZEN_ROUTES[model],
        effortLevels: openCodeZenEffortLevels(model),
        effortWireMap: openCodeZenEffortWireMap(model),
        hidden: true,
        ...(model === 'hy3-free' ? { supportsTools: false } : {}),
      },
    ]),
  ),
  ...Object.fromEntries(
    OPENCODE_GO_MODEL_IDS.map(model => [
      `claude-opencode-${model}`,
      {
        backend: 'opencode-go',
        upstream: model,
        protocol: OPENCODE_GO_ROUTES[model],
        effortLevels: openCodeGoEffortLevels(model),
        effortWireMap: openCodeGoEffortWireMap(model),
        hidden: true,
        ...(model === 'hy3' ? { supportsTools: false } : {}),
        ...(['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4.1-flash', 'qwen3.8-max', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-plus'].includes(model)
          ? { supportsForcedToolChoice: false }
          : {}),
      },
    ]),
  ),
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
      value.backend !== 'opencode-zen'
    ) {
      throw new Error(`MODEL_GATEWAY_MODELS entry ${name} has an invalid backend`)
    }
    if (typeof (value.upstream || name) !== 'string') {
      throw new Error(`MODEL_GATEWAY_MODELS entry ${name} needs a string upstream model`)
    }
    if (
      value.backend === 'opencode-go' &&
      !isOpenCodeGoProtocol(value.protocol)
    ) {
      throw new Error(`MODEL_GATEWAY_MODELS entry ${name} needs a valid OpenCode Go protocol`)
    }
    if (
      value.backend === 'opencode-zen' &&
      !isOpenCodeZenProtocol(value.protocol)
    ) {
      throw new Error(`MODEL_GATEWAY_MODELS entry ${name} needs a valid OpenCode Zen protocol`)
    }
    const previous = models[name]
    models[name] = {
      backend: value.backend,
      ...(typeof value.upstream === 'string' && value.upstream
        ? { upstream: value.upstream }
        : value.backend === 'codex' ||
            value.backend === 'opencode-go' ||
            value.backend === 'opencode-zen'
          ? { upstream: name }
          : {}),
      ...(value.backend === 'opencode-go' || value.backend === 'opencode-zen'
        ? { protocol: value.protocol }
        : {}),
      ...(Array.isArray(value.effortLevels)
        ? { effortLevels: value.effortLevels.filter(level => NATIVE_EFFORT_LEVELS.includes(level)) }
        : {}),
      ...(value.effortWireMap && typeof value.effortWireMap === 'object' && !Array.isArray(value.effortWireMap)
        ? { effortWireMap: { ...value.effortWireMap } }
        : {}),
      ...(typeof value.supportsTools === 'boolean'
        ? { supportsTools: value.supportsTools }
        : {}),
      ...(typeof value.supportsForcedToolChoice === 'boolean'
        ? { supportsForcedToolChoice: value.supportsForcedToolChoice }
        : {}),
      ...(typeof value.hidden === 'boolean'
        ? { hidden: value.hidden }
        : typeof previous?.hidden === 'boolean'
          ? { hidden: previous.hidden }
          : {}),
    }
  }
  return models
}

const MODELS = loadModels()
const MODEL_NAMES = Object.keys(MODELS)
const DISCOVERABLE_MODEL_NAMES = MODEL_NAMES.filter(
  model => MODELS[model].hidden !== true,
)

function validateGatewayCatalog() {
  const routedModelIds = Object.entries(DEFAULT_MODELS)
    .filter(([, route]) => route.hidden !== true)
    .map(([model]) => model)
  const drift = gatewayCatalogDrift(routedModelIds)
  if (
    drift.missingRoutes.length > 0 ||
    drift.missingCatalogEntries.length > 0 ||
    drift.unknownAliases.length > 0
  ) {
    throw new Error(
      `Gateway catalog/runtime drift: missing_routes=${drift.missingRoutes.join(',') || 'none'} ` +
      `missing_catalog_entries=${drift.missingCatalogEntries.join(',') || 'none'} ` +
      `unknown_aliases=${drift.unknownAliases.join(',') || 'none'}`,
    )
  }
}

validateGatewayCatalog()

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
  const eventTypeCounts = new Map()
  let completionShape = null
  let errorClass = null
  let usage = null
  let finished = false

  const eventTypeSummary = () => {
    if (eventTypeCounts.size === 0) return 'none'
    return [...eventTypeCounts.entries()]
      .map(([type, count]) => `${safeLogValue(type).slice(0, 80)}:${count}`)
      .join(',')
  }

  const completionShapeSummary = () => {
    if (!completionShape) return {
      status: 'none',
      outputCount: -1,
      outputTypes: 'none',
    }
    return completionShape
  }

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
    addEventType(type) {
      const key = typeof type === 'string' && type ? type : 'missing'
      if (!eventTypeCounts.has(key) && eventTypeCounts.size >= 64) return
      eventTypeCounts.set(key, (eventTypeCounts.get(key) || 0) + 1)
    },
    setCompletionShape(response) {
      const output = Array.isArray(response?.output) ? response.output : []
      completionShape = {
        status: safeLogValue(response?.status || 'missing'),
        outputCount: output.length,
        outputTypes: output.length === 0
          ? 'none'
          : output.map(item => safeLogValue(item?.type || 'missing').slice(0, 40)).join(',').slice(0, 240),
      }
    },
    setUsage(value) {
      usage = value && typeof value === 'object' ? value : null
    },
    eventTypeSummary,
    completionShapeSummary,
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
      const {
        inputTokens,
        cachedInputTokens,
        cacheWriteInputTokens,
      } = codexUsageTokenCounts(usage)
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
        `input_count=${inputTokens}`,
        `cache_read_count=${cachedInputTokens}`,
        `cache_write_count=${cacheWriteInputTokens}`,
        `output_count=${nonNegativeInteger(usage?.output_tokens)}`,
        `status=${status == null ? -1 : status}`,
        `outcome=${safeLogValue(outcome)}`,
        `error_class=${safeLogValue(errorClass || 'none')}`,
        `provider_event_types=${safeLogValue(eventTypeSummary())}`,
        ...Object.entries(completionShapeSummary()).map(([key, value]) => `completion_${key}=${safeLogValue(value)}`),
      ]
      process.stderr.write(`model-gateway timing ${fields.join(' ')}\n`)
    },
    get finished() { return finished },
  }
}

function createRequestControl(req, res, trace, options = {}) {
  const upstreamTimeoutMs = options.upstreamTimeoutMs ?? UPSTREAM_TIMEOUT_MS
  const consumerTimeoutMs = options.consumerTimeoutMs ?? CONSUMER_TIMEOUT_MS
  const totalTimeoutMs = options.totalTimeoutMs ?? 0
  const controller = new AbortController()
  let closed = false
  let upstreamTimer = null
  let consumerTimer = null
  let totalTimer = null
  let upstreamStarted = false
  let streamErrorFinalizer = null
  const abort = (message, status = 504) => {
    if (closed) return
    closed = true
    const error = new Error(message)
    error.gatewayStatus = status
    if (status === 504) trace.markTimeout(message)
    else trace.markError(error)
    controller.abort(error)
    if (res.destroyed || res.writableEnded) return
    if (!res.headersSent) {
      anthropicError(res, status, message)
    } else {
      streamErrorFinalizer?.()
      finishAnthropicStreamWithError(res, error)
    }
  }
  const abortUpstream = (reason, status = 504) => {
    if (controller.signal.aborted) return
    const error = reason instanceof Error ? reason : new Error(String(reason || 'Gateway upstream request timed out'))
    error.gatewayStatus = status
    if (status === 504) trace.markTimeout(error.message)
    else trace.markError(error)
    controller.abort(error)
  }
  const armTotalTimeout = () => {
    if (totalTimer || totalTimeoutMs <= 0) return
    totalTimer = setTimeout(
      () => abort('Gateway total request timeout', 504),
      totalTimeoutMs,
    )
  }
  const armUpstreamTimeout = (timeoutMs = upstreamTimeoutMs) => {
    if (upstreamStarted || upstreamTimeoutMs <= 0) return
    upstreamStarted = true
    upstreamTimer = setTimeout(() => abort('Gateway upstream request timed out', 504), timeoutMs)
  }
  const armConsumerTimeout = () => {
    if (consumerTimeoutMs <= 0 || consumerTimer) return
    consumerTimer = setTimeout(() => abort('Gateway consumer timeout', 504), consumerTimeoutMs)
  }

  const onRequestAborted = () => abort('Gateway request was aborted', 499)
  const onResponseClose = () => {
    // `close` commonly arrives with `destroyed === true`; that is exactly the
    // signal that the upstream must be cancelled. Normal completion has
    // `writableEnded === true` and is ignored.
    if (!res.writableEnded) abort('Gateway consumer disconnected', 499)
  }
  if (req && typeof req.once === 'function') req.once('aborted', onRequestAborted)
  if (res && typeof res.once === 'function') res.once('close', onResponseClose)

  return {
    signal: controller.signal,
    startUpstream() {
      armTotalTimeout()
      armUpstreamTimeout()
      armConsumerTimeout()
    },
    upstreamConnected() {
      if (upstreamTimer) {
        clearTimeout(upstreamTimer)
        upstreamTimer = null
      }
      // Header acquisition completes one upstream attempt. Outer relay
      // retries must be treated as a new attempt, even when the first fetch
      // returned a response before its body proved usable.
      upstreamStarted = false
    },
    retryUpstream() {
      if (upstreamTimer) clearTimeout(upstreamTimer)
      upstreamTimer = null
      upstreamStarted = false
      armUpstreamTimeout(
        RETRY_ATTEMPT_TIMEOUT_MS > 0
          ? Math.min(upstreamTimeoutMs, RETRY_ATTEMPT_TIMEOUT_MS)
          : upstreamTimeoutMs,
      )
    },
    abortUpstream,
    upstreamActivity() {
      if (closed || consumerTimeoutMs <= 0) return
      if (consumerTimer) clearTimeout(consumerTimer)
      consumerTimer = null
      armConsumerTimeout()
    },
    setStreamErrorFinalizer(finalizer) {
      streamErrorFinalizer = typeof finalizer === 'function' ? finalizer : null
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
      if (totalTimer) clearTimeout(totalTimer)
      if (req && typeof req.removeListener === 'function') req.removeListener('aborted', onRequestAborted)
      if (res && typeof res.removeListener === 'function') res.removeListener('close', onResponseClose)
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

  input.push({
    type: 'function_call',
    call_id: callId,
    name: block.name || block.type || 'tool',
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

function rewriteCodexSystemPrompt(system, querySource) {
  // Keep the harness-provided operational context. Dropping it makes the
  // model lose cwd, tool, skill, plan, and environment instructions after a
  // long turn or compaction even though the tool schemas are still present.
  return rewriteGatewaySystemPrompt(
    system,
    CODEX_SYSTEM_INSTRUCTION,
    querySource,
  )
}

function metadataSessionId(metadata) {
  if (!metadata || typeof metadata !== 'object') return ''
  if (typeof metadata.session_id === 'string' && metadata.session_id.trim()) {
    return metadata.session_id.trim()
  }

  if (typeof metadata.user_id !== 'string') return ''
  try {
    const user = JSON.parse(metadata.user_id)
    return typeof user?.session_id === 'string' ? user.session_id.trim() : ''
  } catch {
    return ''
  }
}

function validHeaderValue(value) {
  return typeof value === 'string' && value.length > 0 && /^[\u0020-\u007e\u0080-\u00ff]+$/.test(value)
}

function upstreamSessionId(req, body) {
  const incoming = req?.headers?.['x-opencode-session']
  const candidate = Array.isArray(incoming) ? incoming[0] : incoming
  const sessionId = validHeaderValue(candidate?.trim?.() || '')
    ? candidate.trim()
    : metadataSessionId(body?.metadata) || String(process.env.CLAUDE_CODE_SESSION_ID || '').trim()
  return validHeaderValue(sessionId) ? sessionId : ''
}

export function codexPromptCacheKeyForBody(
  body,
  mode = CODEX_PROMPT_CACHE_KEY_MODE,
) {
  if (mode !== 'auto') return null

  const sessionId =
    metadataSessionId(body?.metadata) ||
    String(process.env.CLAUDE_CODE_SESSION_ID || '').trim()
  if (!sessionId) return null

  // Keep the provider key opaque while making it stable for this Claude
  // session. The key namespaces a cache; it does not change the prompt.
  return `claude-code:${createHash('sha256')
    .update(sessionId)
    .digest('hex')
    .slice(0, 32)}`
}

function codexPromptCacheKey(body) {
  return codexPromptCacheKeyForBody(body)
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
  const sanitizedContent = role === 'assistant'
    ? sanitizeStaleToolCapabilityContent(message.content)
    : sanitizeLegacyCompactionContent(message.content)
  const content =
    typeof sanitizedContent === 'string'
      ? [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: sanitizedContent }]
      : Array.isArray(sanitizedContent)
        ? sanitizedContent
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

export function normalizeGatewayEffort(body, route, querySource) {
  if (
    isNativeSummaryRequest(querySource) ||
    body?.thinking?.type === 'disabled'
  ) {
    const outputConfig = body.output_config
      ? { ...body.output_config }
      : undefined
    const reasoning = body.reasoning
      ? { ...body.reasoning }
      : undefined
    if (outputConfig) delete outputConfig.effort
    if (reasoning) delete reasoning.effort
    return {
      ...body,
      ...(outputConfig ? { output_config: outputConfig } : {}),
      ...(reasoning ? { reasoning } : {}),
    }
  }

  const requested = body?.output_config?.effort || body?.reasoning?.effort
  if (!requested) return body

  const levels = Array.isArray(route?.effortLevels)
    ? route.effortLevels
    : ['low', 'medium', 'high']
  let effort = requested
  if (requested === 'ultracode') {
    effort = levels.includes('ultra')
      ? 'ultra'
      : levels.includes('max')
        ? 'max'
        : levels.includes('high')
          ? 'high'
          : undefined
  } else if (!levels.includes(requested)) {
    effort = levels.includes('high') ? 'high' : undefined
  }

  const outputConfig = body.output_config
    ? { ...body.output_config }
    : undefined
  if (outputConfig) {
    if (effort) outputConfig.effort = effort
    else delete outputConfig.effort
  }
  const reasoning = body.reasoning ? { ...body.reasoning } : undefined
  if (reasoning) {
    if (effort) reasoning.effort = effort
    else delete reasoning.effort
  }
  return {
    ...body,
    ...(outputConfig ? { output_config: outputConfig } : {}),
    ...(reasoning ? { reasoning } : {}),
  }
}

export function stripUnsupportedOpenCodeTools(body, route) {
  if (
    !['opencode-go', 'opencode-zen'].includes(route?.backend) ||
    route.supportsTools !== false ||
    !Array.isArray(body?.tools) ||
    body.tools.length === 0
  ) {
    return body
  }

  process.stderr.write(
    `model-gateway tools-disabled model=${safeLogValue(route.upstream || 'unknown')} reason=provider-capability\n`,
  )
  const next = { ...body }
  delete next.tools
  delete next.tool_choice
  return next
}

function isForcedToolChoice(choice) {
  return choice === 'any' ||
    choice === 'required' ||
    (choice && typeof choice === 'object' && choice.type === 'tool' && typeof choice.name === 'string')
}

export function stripUnsupportedOpenCodeToolChoice(body, route) {
  if (
    !['opencode-go', 'opencode-zen'].includes(route?.backend) ||
    route.supportsForcedToolChoice !== false ||
    !isForcedToolChoice(body?.tool_choice)
  ) {
    return body
  }

  process.stderr.write(
    `model-gateway tool-choice-disabled model=${safeLogValue(route.upstream || 'unknown')} reason=provider-capability\n`,
  )
  const next = { ...body }
  delete next.tool_choice
  return next
}

export function anthropicToCodex(body, upstreamModel, querySource) {
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
    instructions: rewriteCodexSystemPrompt(body.system, querySource),
  }
  const promptCacheKey = codexPromptCacheKey(body)
  if (promptCacheKey) request.prompt_cache_key = promptCacheKey

  // Native harness compaction explicitly disables thinking. Do not invent a
  // provider reasoning request for that turn: the gateway is an adapter, not
  // a second compaction/effort policy.
  if (
    !isNativeSummaryRequest(querySource) &&
    body.thinking?.type !== 'disabled'
  ) {
    request.reasoning = {
      effort: body.output_config?.effort || body.reasoning?.effort || CODEX_REASONING_EFFORT,
      summary: 'detailed',
    }
  }

  if (body.max_tokens != null) request.max_output_tokens = body.max_tokens
  // Codex Responses rejects sampling controls for the GPT-5 reasoning route.
  // Claude's subagent requests may set these even when the parent request does
  // not, so forwarding them makes Agent calls fail while the parent succeeds.
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

  process.stderr.write(
    'model-gateway codex effort=' +
    String(request.reasoning?.effort || 'disabled') +
    '\n',
  )
  return request
}

const CORE_TOOL_NAME_PATTERN =
  /^(read|write|edit|bash|glob|grep|skill|task|agent|todo|askuser)/i

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

function boundedToolDescription(value, limit = 320) {
  const description = String(value || '').replace(/\s+/g, ' ').trim()
  return description.length > limit
    ? `${description.slice(0, Math.max(0, limit - 3))}...`
    : description
}

function safeCodexSchema(value) {
  if (Array.isArray(value)) return value.map(safeCodexSchema)
  if (!value || typeof value !== 'object') return value

  const result = {}
  for (const [key, child] of Object.entries(value)) {
    // These fields do not change the callable contract. Keep descriptions,
    // enums, required fields, defaults that matter to the model, and all
    // structural constraints intact so balanced mode remains quality-safe.
    if (
      key === 'title' ||
      key === 'examples' ||
      key === 'example' ||
      key === '$comment'
    ) continue
    result[key] = safeCodexSchema(child)
  }
  return result
}

function balancedCodexTools(request) {
  return request.tools.map(tool => {
    const isCoreTool = CORE_TOOL_NAME_PATTERN.test(String(tool.name || ''))
    return {
      ...tool,
      // Built-in tools are the model's primary action vocabulary. Preserve
      // their complete descriptions and schemas. Optional/MCP tools still
      // receive bounded descriptions and metadata-only schema compression.
      description: isCoreTool
        ? String(tool.description || '')
        : boundedToolDescription(tool.description),
      parameters: isCoreTool
        ? tool.parameters
        : safeCodexSchema(tool.parameters),
    }
  })
}

function codexRequestVariants(request, nativeCompaction = false) {
  // Native harness compaction deliberately carries the canonical tool catalog
  // for cache/protocol compatibility. Do not let a gateway-side schema mode or
  // context fallback rewrite that request and create a second compact policy.
  if (nativeCompaction) return [request]

  if (
    CODEX_TOOL_MODE === 'fallback' ||
    !Array.isArray(request.tools) ||
    request.tools.length === 0
  ) {
    return [request, ...contextFallbackRequests(request)]
  }

  const compressedTools = CODEX_TOOL_MODE === 'balanced'
    ? balancedCodexTools(request)
    : compactCodexTools(request)
  const compactRequest = {
    ...request,
    tools: compressedTools,
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

function fingerprint(value) {
  return createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value) || '')
    .digest('hex')
    .slice(0, 16)
}

function providerPrefixMaterial(providerRequest) {
  return JSON.stringify({
    instructions: providerRequest?.instructions || '',
    tools: Array.isArray(providerRequest?.tools)
      ? providerRequest.tools
      : [],
  })
}

const cachePrefixObservations = new Map()

function cachePrefixState(body, model, querySource, prefixFingerprint) {
  const sessionId =
    metadataSessionId(body?.metadata) ||
    String(process.env.CLAUDE_CODE_SESSION_ID || '').trim()
  const observationKey = `${model}|${querySource || 'normal'}|${sessionId || 'anonymous'}`
  const previous = cachePrefixObservations.get(observationKey)
  cachePrefixObservations.set(observationKey, prefixFingerprint)
  if (!previous) return 'first'
  return previous === prefixFingerprint ? 'reuse' : 'changed'
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

function codexUsageTokenCounts(usage) {
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
  const remainingInputTokens = Math.max(0, inputTokens - cachedInputTokens)
  const cacheWriteInputTokens = Math.min(
    remainingInputTokens,
    nonNegativeInteger(
      usage?.input_tokens_details?.cache_write_tokens ??
        usage?.input_tokens_details?.cache_creation_input_tokens ??
        usage?.cache_write_input_tokens ??
        usage?.cache_write_tokens ??
        usage?.cache_creation_input_tokens,
    ),
  )

  return {
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    uncachedInputTokens: remainingInputTokens - cacheWriteInputTokens,
  }
}

/**
 * Codex reports cached input as a subset of input_tokens. Anthropic exposes
 * that subset separately, so subtract it before forwarding input_tokens or
 * Claude Code's context footer would count cached tokens twice.
 */
export function codexUsageToAnthropic(usage) {
  const {
    cachedInputTokens,
    cacheWriteInputTokens,
    uncachedInputTokens,
  } = codexUsageTokenCounts(usage)

  return {
    input_tokens: uncachedInputTokens,
    cache_creation_input_tokens: cacheWriteInputTokens,
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

function codexOutputText(item) {
  if (item?.type !== 'message' || !Array.isArray(item.content)) return ''
  return item.content
    .filter(part => part?.type === 'output_text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('')
}

function codexEventShape(event) {
  if (LOG_EVENT_SHAPE !== true) return
  const type = event?.type
  if (![
    'response.output_item.added',
    'response.content_part.added',
    'response.output_text.done',
    'response.content_part.done',
    'response.output_item.done',
    'response.completed',
    'response.failed',
  ].includes(type)) return

  const keys = value => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).sort().join(',') || 'none'
    : 'none'
  const types = value => Array.isArray(value)
    ? value.map(item => safeLogValue(item?.type || typeof item).slice(0, 40)).join(',') || 'none'
    : 'none'
  const text = value => typeof value === 'string'
    ? `string:${Buffer.byteLength(value, 'utf8')}`
    : safeLogValue(value == null ? 'missing' : typeof value)
  const item = event?.item
  const response = event?.response
  const fields = [
    `type=${safeLogValue(type)}`,
    `keys=${keys(event)}`,
    `response_keys=${keys(response)}`,
    `response_output_count=${Array.isArray(response?.output) ? response.output.length : -1}`,
    `response_output_types=${types(response?.output)}`,
    `item_keys=${keys(item)}`,
    `item_content_count=${Array.isArray(item?.content) ? item.content.length : -1}`,
    `item_content_types=${types(item?.content)}`,
    `text=${text(event?.text)}`,
    `delta=${text(event?.delta)}`,
    `part_keys=${keys(event?.part)}`,
    `part_text=${text(event?.part?.text)}`,
    `output_text_keys=${keys(event?.output_text)}`,
    `output_text_text=${text(event?.output_text?.text)}`,
    `content_keys=${keys(event?.content)}`,
    `content_text=${text(event?.content?.text)}`,
    `content_part_keys=${keys(event?.content_part)}`,
    `content_part_text=${text(event?.content_part?.text)}`,
    `output_item_keys=${keys(event?.output_item)}`,
  ]
  process.stderr.write(`model-gateway event-shape ${fields.join(' ')}\n`)
}

function codexOutputMessageFromEvent(event) {
  if (event?.type === 'response.output_text.done') {
    if (typeof event.text === 'string') return event.text
    if (typeof event.part?.text === 'string') return event.part.text
    if (typeof event.content?.text === 'string') return event.content.text
  }
  if (event?.type === 'response.output_item.done') {
    return codexOutputText(event.item)
  }
  return ''
}

function codexOutputMessageFromResponse(response) {
  if (!response || typeof response !== 'object') return ''
  if (typeof response.output_text === 'string') return response.output_text
  if (typeof response.text === 'string') return response.text
  if (Array.isArray(response.content)) {
    const text = response.content
      .filter(part => part?.type === 'output_text' && typeof part.text === 'string')
      .map(part => part.text)
      .join('')
    if (text) return text
  }
  return ''
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
  let reader = null
  try {
    let response
    const contentType = upstream.headers?.get?.('content-type') || ''
    if (forceStream || contentType.includes('text/event-stream')) {
      reader = upstream.body?.getReader()
      if (!reader) throw new Error('Codex returned an empty response body')
      const decoder = new TextDecoder()
      let buffer = ''
      let completed = null
      let text = ''
      const toolCalls = new Map()
      const handleEvent = event => {
        codexEventShape(event)
        if (event.type === 'response.output_text.delta') {
          const delta = typeof event.delta === 'string'
            ? event.delta
            : typeof event.part?.text === 'string'
              ? event.part.text
              : ''
          text += delta
          return
        }
        if (event.type === 'response.output_text.done') {
          if (!text) text = codexOutputMessageFromEvent(event)
          return
        }
        if (event.type === 'response.output_item.done' && event.item?.type === 'message') {
          if (!text) text = codexOutputMessageFromEvent(event)
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
          const event = JSON.parse(data)
          trace?.addEventType?.(event?.type)
          handleEvent(event)
          if (completed) {
            trace?.setCompletionShape?.(completed)
            break
          }
        }
        if (completed) {
          await cancelUpstreamReader(reader, upstream)
          break
        }
      }
      if (!completed && buffer.startsWith('data: ')) {
        const data = buffer.slice(6)
        if (data && data !== '[DONE]') {
          trace?.addEvent()
          const event = JSON.parse(data)
          trace?.addEventType?.(event?.type)
          handleEvent(event)
          if (completed) trace?.setCompletionShape?.(completed)
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
      trace?.setCompletionShape?.(response)
      if (Array.isArray(response?.output)) {
        for (const item of response.output) trace?.addEventType?.(`output.${item?.type || 'missing'}`)
      }
    }
    trace?.setUsage?.(response?.usage)
    const message = codexResponseToAnthropic(response, model)
    trace?.markOutput()
    trace?.markCompletion()
    json(res, 200, message)
    return true
  } catch (error) {
    trace?.markError(error)
    if (options.throwPreOutput) {
      await cancelUpstreamReader(reader, upstream)
      throw error
    }
    if (isContextWindowFailure(error)) {
      finishAnthropicPromptTooLongError(res, error)
    } else {
      anthropicError(res, 502, errorMessage(error))
    }
    return false
  } finally {
    reader?.releaseLock?.()
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

export async function safeUpstreamResponseError(response, provider, secret = '', options = {}) {
  return safeUpstreamResponseErrorBounded(response, provider, secret, options)
}

async function readResponseCloneText(response, {
  signal = null,
  timeoutMs = 0,
  onTimeout = null,
} = {}) {
  const clone = response.clone()
  const textPromise = clone.text()
  // A timed-out race leaves the body promise pending until cancellation or
  // the provider closes it. Attach a rejection handler so that cleanup does
  // not create an unhandled rejection.
  textPromise.catch(() => {})
  if ((!signal || typeof signal.addEventListener !== 'function') && timeoutMs <= 0) {
    return textPromise
  }

  let timer = null
  let abortHandler = null
  let timedOut = false
  try {
    const races = [textPromise]
    if (signal && typeof signal.addEventListener === 'function') {
      races.push(new Promise((_, reject) => {
        abortHandler = () => reject(signal.reason || new Error('Gateway request aborted'))
        if (signal.aborted) abortHandler()
        else signal.addEventListener('abort', abortHandler, { once: true })
      }))
    }
    if (timeoutMs > 0) {
      races.push(new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true
          const error = new Error('Gateway upstream response body timed out')
          error.gatewayStatus = 504
          onTimeout?.(error)
          reject(error)
        }, timeoutMs)
      }))
    }
    return await Promise.race(races)
  } finally {
    if (timer) clearTimeout(timer)
    if (signal && abortHandler) signal.removeEventListener('abort', abortHandler)
    if (timedOut) await clone.body?.cancel?.().catch(() => {})
  }
}

async function safeUpstreamResponseErrorBounded(
  response,
  provider,
  secret = '',
  options = {},
) {
  let detail = ''
  try {
    const raw = await readResponseCloneText(response, options)
    if (raw) {
      const parsed = JSON.parse(raw)
      const candidates = []
      const collect = value => {
        if (typeof value === 'string') {
          const text = value.trim()
          if (text) candidates.push(text)
        } else if (Array.isArray(value)) {
          for (const item of value) collect(item)
        } else if (value && typeof value === 'object') {
          for (const item of Object.values(value)) collect(item)
        }
      }
      collect(parsed?.error?.message ?? parsed?.message ?? parsed)
      detail = candidates
        .sort((a, b) => a.length - b.length)
        .find(value => value.length <= 500) || ''
    }
  } catch (error) {
    if (options?.signal?.aborted) {
      throw options.signal.reason || error
    }
    // Keep the generic status when the provider body is not safe JSON.
  }
  const suffix = detail ? `: ${redactSecret(detail, secret)}` : ''
  return `${provider} returned HTTP ${response.status}${suffix}`
}

async function cancelUpstreamReader(reader, upstream) {
  if (reader && typeof reader.cancel === 'function') {
    try {
      await reader.cancel()
      return
    } catch {
      // Fall through to the body-level cancellation attempt.
    }
  }
  await Promise.resolve(upstream?.body?.cancel?.()).catch(() => {})
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

async function retryableResponse(provider, response, control = null) {
  if (retryableStatus(response.status)) return true
  if (response.status !== 400 || !String(provider).toLowerCase().includes('opencode')) {
    return false
  }

  try {
    const body = (await readResponseCloneText(response, {
      signal: control?.signal,
      timeoutMs: RETRY_RESPONSE_TIMEOUT_MS,
      onTimeout: error => control?.abortUpstream?.(error),
    })).toLowerCase()
    return [
      'temporarily unavailable',
      'try again',
      'overloaded',
      'upstream timeout',
      'gateway timeout',
      'provider timeout',
      'capacity',
      'rate limit',
    ].some(marker => body.includes(marker))
  } catch {
    if (control?.signal?.aborted) throw control.signal.reason
    return false
  }
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
      const response = await fetch(url, options)
      trace.markUpstreamConnect()
      control.upstreamConnected()
      if (response.ok || !(await retryableResponse(provider, response, control)) || attempt > UPSTREAM_RETRIES) {
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
  let reader = null
  let sawCompletion = false
  let buffer = ''
  let streamStarted = false
  let pendingTool = null

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
      name: item.name || 'tool',
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
    const hasToolIdentity = item &&
      typeof item === 'object' &&
      (item.call_id || item.id || item.name)
    const tool = hasToolIdentity ? item : pendingTool
    if (!tool) return false
    openTool(tool)
    pendingTool = null
    if (argumentsDelta) {
      sendEvent(res, 'content_block_delta', {
        index: contentIndex,
        delta: { type: 'input_json_delta', partial_json: argumentsDelta },
      })
    }
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
    codexEventShape(event)
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
    if (type === 'response.output_text.done') {
      if (!activeText && typeof event.text === 'string' && event.text) {
        openText()
        sendEvent(res, 'content_block_delta', {
          index: contentIndex,
          delta: { type: 'text_delta', text: event.text },
        })
      }
      return
    }
    if (type === 'response.output_item.done' && event.item?.type === 'message') {
      if (!activeText) {
        const text = codexOutputText(event.item)
        if (text) {
          openText()
          sendEvent(res, 'content_block_delta', {
            index: contentIndex,
            delta: { type: 'text_delta', text },
          })
        }
      }
      return
    }
    if (type === 'response.function_call_arguments.delta') {
      const delta = typeof event.delta === 'string' ? event.delta : ''
      if (!delta) return
      if (!activeTool) {
        openPendingTool(event.item || {}, delta)
      } else {
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
      }
      closeActive()
      contentIndex += 1
      return
    }
    if (type === 'response.completed') {
      sawCompletion = true
      trace?.setCompletionShape?.(event.response || event)
      usage = event.response?.usage || event.usage || null
      trace?.setUsage?.(usage)
      emitCompletedOutputFallback(event.response)
      return
    }
    if (type === 'response.failed') {
      throw new Error(event.response?.error?.message || 'Codex response failed')
    }
  }

  try {
    const decoder = new TextDecoder()
    reader = upstream.body?.getReader()
    if (!reader) throw new Error('Codex returned an empty response body')

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
        const event = JSON.parse(data)
        trace?.addEventType?.(event?.type)
        handleEvent(event)
        if (sawCompletion) {
          trace?.setCompletionShape?.(event.response || event)
          break
        }
      }
      if (sawCompletion) {
        await cancelUpstreamReader(reader, upstream)
        break
      }
    }

    if (!sawCompletion && buffer.startsWith('data: ')) {
      const data = buffer.slice(6)
      if (data && data !== '[DONE]') {
        const event = JSON.parse(data)
        trace?.addEventType?.(event?.type)
        handleEvent(event)
        if (sawCompletion) trace?.setCompletionShape?.(event.response || event)
      }
    }

    if (!sawCompletion) {
      throw new Error('Codex stream ended before response.completed')
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
      await cancelUpstreamReader(reader, upstream)
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
  } finally {
    reader?.releaseLock?.()
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

export async function relayDeepSeekStream(
  res,
  upstream,
  trace = null,
  options = {},
) {
  let streamStarted = false
  let sawOutput = false
  let sawMessageStop = false
  let pending = ''
  let buffer = ''
  let reader = null
  const signal = options.signal
  let aborted = false
  let onAbort = null
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
    onAbort = () => {
      aborted = true
      void cancelUpstreamReader(reader, upstream)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const decoder = new TextDecoder()
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        if (aborted || signal?.aborted) {
          throw signal?.reason || new Error('Gateway request aborted')
        }
        break
      }
      if (aborted || signal?.aborted) {
        throw signal?.reason || new Error('Gateway request aborted')
      }
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
    await cancelUpstreamReader(reader, upstream)
    if (!streamStarted) {
      if (isContextWindowFailure(error)) finishAnthropicPromptTooLongError(res, error)
      else anthropicError(res, 502, errorMessage(error))
    } else {
      finishAnthropicStreamWithError(res, error)
    }
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort)
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

export async function relayDeepSeekResponse(res, upstream, trace = null) {
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
    if (isContextWindowFailure(error)) finishAnthropicPromptTooLongError(res, error)
    else anthropicError(res, 502, errorMessage(error))
  }
}

async function handleCodex(body, req, res, modelName, route) {
  const trace = createGatewayTrace({ model: modelName, backend: 'codex', protocol: 'responses' })
  const control = createRequestControl(req, res, trace)
  const querySource = gatewayQuerySource(req)
  const nativeCompaction = isCompactionRequest(req)
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
    const normalizedBody = normalizeGatewayEffort(body, route, querySource)
    request = anthropicToCodex(normalizedBody, route.upstream, querySource)
    // The Codex Responses endpoint requires SSE even when the Anthropic caller
    // requested a buffered JSON response. Buffering back to JSON happens in
    // relayCodexResponse.
    request.stream = true
    // The current Codex Responses endpoint rejects both max_tokens and
    // max_output_tokens. Keep the caller's cap in the Anthropic contract, but
    // omit the unsupported field from the upstream request.
    delete request.max_output_tokens
    // Compaction is owned by the native harness. The gateway only translates
    // the request protocol; it must not infer or invent a second compaction
    // contract from the prompt contents.
    if (nativeCompaction) {
      process.stderr.write(
        `model-gateway native-compaction source=${safeLogValue(querySource)}\n`,
      )
    }
  } catch (error) {
    trace.markError(error)
    anthropicError(res, 400, error instanceof Error ? error.message : 'Unsupported request')
    trace.finish('invalid-request', error, 400)
    control.cleanup()
    return
  }

  const wantsStream = body.stream === true
  const requests = codexRequestVariants(request, nativeCompaction)
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
      logRequestShape({
        body,
        providerRequest: variant,
        model: modelName,
        backend: 'codex',
        protocol: 'responses',
        querySource,
        variant: variantIndex,
      })

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
                'user-agent': 'gateway-model-gateway/0.1',
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

        if (!upstream.ok) {
          const contextFailure = await responseIsContextWindowFailure(upstream)
          const detail = await safeUpstreamResponseError(
            upstream,
            'Codex',
            '',
            {
              signal: control.signal,
              timeoutMs: RETRY_RESPONSE_TIMEOUT_MS,
              onTimeout: error => control.abortUpstream(error),
            },
          )
          await upstream.body?.cancel().catch(() => {})
          if (contextFailure && variantIndex < requests.length - 1) {
            requestError = new Error('Prompt is too long: Codex context window exceeded')
            break
          }
          const status = upstream.status >= 500 ? 502 : upstream.status
          const error = contextFailure
            ? new Error('Prompt is too long: Codex context window exceeded')
            : new Error(detail)
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
  } catch (error) {
    requestError ||= error
    trace.markError(error)
    // A downstream disconnect can abort a retry backoff or an in-flight
    // fetch. That is expected request cancellation, not a gateway crash.
    // Never attempt to write a second response after the client is gone.
    if (!control.signal.aborted && !res.headersSent && !res.destroyed && !res.writableEnded) {
      anthropicError(res, 502, error instanceof Error ? error.message : 'Codex request failed')
    } else if (
      !control.signal.aborted &&
      res.headersSent &&
      wantsStream &&
      !res.destroyed &&
      !res.writableEnded
    ) {
      finishAnthropicStreamWithError(res, error)
    }
    if (!trace.finished) {
      trace.finish(
        control.signal.aborted ? 'cancelled' : 'request-error',
        error,
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
  const sessionId = upstreamSessionId(req, body)
  const trace = createGatewayTrace({ model: modelName, backend: 'opencode-go', protocol: route.protocol })
  const control = createRequestControl(req, res, trace)
  const querySource = gatewayQuerySource(req)
  const apiKey = process.env.OPENCODE_API_KEY
  if (!apiKey) {
    anthropicError(res, 401, 'OpenCode Go API key is not configured')
    trace.finish('auth-error', null, 401)
    control.cleanup()
    return
  }

  let request
  try {
    const toolSafeBody = stripUnsupportedOpenCodeToolChoice(
      stripUnsupportedOpenCodeTools(body, route),
      route,
    )
    const normalizedBody = normalizeGatewayEffort(toolSafeBody, route, querySource)
    // The native harness owns compaction semantics, including tool denial and
    // summary construction. OpenCode receives the same request shape as any
    // other turn; only provider capability adapters may alter it.
    if (isCompactionRequest(req)) {
      process.stderr.write(
        `model-gateway native-compaction source=${safeLogValue(querySource)}\n`,
      )
    }
    request = anthropicToOpenCodeRequest(normalizedBody, route, querySource)
    logRequestShape({
      body: normalizedBody,
      providerRequest: request,
      model: modelName,
      backend: 'opencode-go',
      protocol: route.protocol,
      querySource,
    })
  } catch (error) {
    anthropicError(res, 400, error instanceof Error ? error.message : 'Unsupported request')
    trace.finish('invalid-request', error, 400)
    control.cleanup()
    return
  }

  try {
    let relayAttempt = 0
    while (true) {
      let upstream
      control.startUpstream()
      try {
        upstream = await fetchWithRetry({
          provider: 'OpenCode Go',
          url: openCodeGoEndpoint(route.protocol),
          options: {
            method: 'POST',
            headers: openCodeGoHeaders(route.protocol, apiKey, wantsStream, sessionId),
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
        const detail = await safeUpstreamResponseError(
          upstream,
          'OpenCode Go',
          apiKey,
          {
            signal: control.signal,
            timeoutMs: RETRY_RESPONSE_TIMEOUT_MS,
            onTimeout: error => control.abortUpstream(error),
          },
        )
        await upstream.body?.cancel().catch(() => {})
        const contextFailure = upstream.status === 400 &&
          isContextWindowFailure(new Error(detail))
        const status = contextFailure
          ? 400
          : upstream.status >= 500
            ? 502
            : upstream.status
        if (contextFailure) {
          finishAnthropicPromptTooLongError(res, new Error(detail))
        } else {
          anthropicError(res, status, detail)
        }
        trace.finish('upstream-http-error', null, status)
        return
      }

      try {
        const relayOptions = {
          signal: control.signal,
          throwPreOutput: true,
        }
        if (wantsStream) {
          await relayOpenCodeStream(res, upstream, modelName, route.protocol, trace, relayOptions)
        } else {
          await relayOpenCodeResponseByProtocol(res, upstream, modelName, route.protocol, trace, relayOptions)
        }
        break
      } catch (error) {
        if (
          !res.headersSent &&
          !control.signal.aborted &&
          retryablePreOutputRelayError(error) &&
          relayAttempt < UPSTREAM_RETRIES
        ) {
          relayAttempt += 1
          const delay = retryDelayMs(relayAttempt, null)
          trace.clearError?.()
          process.stderr.write(
            `model-gateway retry provider=OpenCode-Go error=pre-output-${safeLogValue(classifyGatewayError(error))} attempt=${relayAttempt} delay_ms=${delay}\n`,
          )
          await waitForRetry(delay, control.signal)
          continue
        }
        if (!res.headersSent) {
          if (isContextWindowFailure(error)) finishAnthropicPromptTooLongError(res, error)
          else anthropicError(res, 502, redactSecret(errorMessage(error), apiKey))
        } else if (wantsStream) {
          finishAnthropicStreamWithError(res, error)
        }
        break
      }
    }
    trace.finish(res.headersSent && res.statusCode === 200 ? 'success' : 'error', null, res.statusCode)
  } catch (error) {
    trace.markError(error)
    if (!res.headersSent) {
      anthropicError(res, 502, error instanceof Error ? error.message : 'OpenCode Go request failed')
    } else if (wantsStream) {
      finishAnthropicStreamWithError(res, error)
    }
    trace.finish('request-error', error, res.statusCode)
  } finally {
    control.cleanup()
  }
}

async function handleOpenCodeZen(body, req, res, modelName, route) {
  const wantsStream = body.stream === true
  const sessionId = upstreamSessionId(req, body)
  const trace = createGatewayTrace({ model: modelName, backend: 'opencode-zen', protocol: route.protocol })
  const control = createRequestControl(req, res, trace)
  const querySource = gatewayQuerySource(req)
  const apiKey = process.env.OPENCODE_API_KEY
  if (!apiKey) {
    anthropicError(res, 401, 'OpenCode Zen API key is not configured')
    trace.finish('auth-error', null, 401)
    control.cleanup()
    return
  }

  let request
  try {
    const toolSafeBody = stripUnsupportedOpenCodeToolChoice(
      stripUnsupportedOpenCodeTools(body, route),
      route,
    )
    const normalizedBody = normalizeGatewayEffort(toolSafeBody, route, querySource)
    request = anthropicToOpenCodeRequest(normalizedBody, route, querySource)
    logRequestShape({
      body: normalizedBody,
      providerRequest: request,
      model: modelName,
      backend: 'opencode-zen',
      protocol: route.protocol,
      querySource,
    })
  } catch (error) {
    anthropicError(res, 400, error instanceof Error ? error.message : 'Unsupported request')
    trace.finish('invalid-request', error, 400)
    control.cleanup()
    return
  }

  try {
    control.startUpstream()
    const upstream = await fetchWithRetry({
      provider: 'OpenCode Zen',
      url: openCodeZenEndpoint(route.protocol),
      options: {
        method: 'POST',
        headers: openCodeZenHeaders(apiKey, wantsStream, sessionId),
        body: JSON.stringify(request),
        signal: control.signal,
      },
      control,
      trace,
    })
    if (!upstream.ok) {
      const detail = await safeUpstreamResponseError(
        upstream,
        'OpenCode Zen',
        apiKey,
        { signal: control.signal, timeoutMs: RETRY_RESPONSE_TIMEOUT_MS },
      )
      await upstream.body?.cancel().catch(() => {})
      const status = upstream.status >= 500 ? 502 : upstream.status
      anthropicError(res, status, detail)
      trace.finish('upstream-http-error', null, status)
      return
    }

    const relayOptions = { signal: control.signal, throwPreOutput: true }
    if (wantsStream) {
      await relayOpenCodeStream(res, upstream, modelName, route.protocol, trace, relayOptions)
    } else {
      await relayOpenCodeResponseByProtocol(res, upstream, modelName, route.protocol, trace, relayOptions)
    }
    trace.finish(res.headersSent && res.statusCode === 200 ? 'success' : 'error', null, res.statusCode)
  } catch (error) {
    trace.markError(error)
    if (!res.headersSent) {
      const status = control.signal.aborted ? control.statusFor(error) : 502
      anthropicError(res, status, control.signal.aborted ? 'OpenCode Zen upstream request timed out' : redactSecret(errorMessage(error), apiKey))
    } else if (wantsStream) {
      finishAnthropicStreamWithError(res, error)
    }
    trace.finish('request-error', error, res.statusCode)
  } finally {
    control.cleanup()
  }
}

async function handleDeepSeek(req, res, requestUrl, rawBody, modelName) {
  const querySource = gatewayQuerySource(req)
  let body
  try {
    body = JSON.parse(rawBody.toString('utf8'))
  } catch (error) {
    anthropicError(res, 400, error instanceof Error ? error.message : 'Invalid JSON')
    return
  }
  body = normalizeGatewayEffort({
    ...body,
    system: appendRuntimeToolContract(body.system, querySource),
    messages: Array.isArray(body.messages)
      ? body.messages.map(message => ({
          ...message,
          content: message.role === 'assistant'
            ? sanitizeStaleToolCapabilityContent(message.content)
            : sanitizeLegacyCompactionContent(message.content),
        }))
      : body.messages,
  }, MODELS[modelName], querySource)
  rawBody = Buffer.from(JSON.stringify(body))
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

  let upstream
  logRequestShape({
    body,
    providerRequest: body,
    model: modelName,
    backend: 'deepseek',
    protocol: 'anthropic-messages',
    querySource,
  })
  control.startUpstream()
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
    control.cleanup()
    return
  }

  if (!upstream.ok) {
    const status = upstream.status >= 500 ? 502 : upstream.status
    let detail
    try {
      detail = await safeUpstreamResponseError(
        upstream,
        'DeepSeek',
        apiKey,
        {
          signal: control.signal,
          timeoutMs: RETRY_RESPONSE_TIMEOUT_MS,
          onTimeout: error => control.abortUpstream(error),
        },
      )
    } catch (error) {
      const boundedStatus = control.signal.aborted ? control.statusFor(error) : status
      anthropicError(
        res,
        boundedStatus,
        boundedStatus === 504
          ? 'DeepSeek upstream request timed out'
          : 'DeepSeek provider error',
      )
      trace.finish('upstream-http-error', error, boundedStatus)
      control.cleanup()
      return
    }
    await upstream.body?.cancel().catch(() => {})
    anthropicError(res, status, detail)
    trace.finish('upstream-http-error', null, status)
    control.cleanup()
    return
  }

  try {
    if (wantsStream) {
      await relayDeepSeekStream(res, upstream, trace, {
        signal: control.signal,
      })
    } else {
      await relayDeepSeekResponse(res, upstream, trace)
    }
    trace.markCompletion()
    trace.finish('success', null, res.statusCode)
  } catch (error) {
    trace.markError(error)
    if (!res.headersSent) {
      anthropicError(res, 502, error instanceof Error ? error.message : 'DeepSeek stream failed')
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

function byteLength(value) {
  if (value == null) return 0
  try {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value)
    return Buffer.byteLength(serialized == null ? '' : serialized, 'utf8')
  } catch {
    return 0
  }
}

export function gatewayRequestShape(body, providerRequest) {
  const system = body?.system
  const messages = body?.messages
  const tools = Array.isArray(body?.tools) ? body.tools : []
  const input = Array.isArray(providerRequest?.input)
    ? providerRequest.input
    : []
  const providerTools = Array.isArray(providerRequest?.tools)
    ? providerRequest.tools
    : []
  const prefix = providerPrefixMaterial(providerRequest)
  const lastInput = input.at(-1)
  const promptCacheKey = providerRequest?.prompt_cache_key
  return {
    anthropic_bytes: byteLength(body),
    system_bytes: byteLength(system),
    message_bytes: byteLength(messages),
    tool_schema_bytes: byteLength(tools),
    system_block_count: Array.isArray(system) ? system.length : (system ? 1 : 0),
    message_count: Array.isArray(messages) ? messages.length : 0,
    tool_count: tools.length,
    provider_input_items: input.length,
    provider_input_bytes: byteLength(input),
    provider_instructions_bytes: byteLength(providerRequest?.instructions),
    provider_tool_count: providerTools.length,
    provider_tool_schema_bytes: byteLength(providerTools),
    provider_request_bytes: byteLength(providerRequest),
    provider_last_input_bytes: byteLength(lastInput),
    provider_prefix_bytes: Buffer.byteLength(prefix, 'utf8'),
    provider_prefix_fingerprint: fingerprint(prefix),
    prompt_cache_key_present:
      typeof promptCacheKey === 'string' ? 1 : 0,
    prompt_cache_key_fingerprint:
      typeof promptCacheKey === 'string' ? fingerprint(promptCacheKey) : 'none',
  }
}

function logRequestShape({
  body,
  providerRequest,
  model,
  backend,
  protocol,
  querySource,
  variant = 0,
}) {
  if (!LOG_REQUEST_SHAPE) return
  const shape = gatewayRequestShape(body, providerRequest)
  const prefixState = cachePrefixState(
    body,
    model,
    querySource,
    shape.provider_prefix_fingerprint,
  )
  const fields = [
    `model=${safeLogValue(model)}`,
    `backend=${safeLogValue(backend)}`,
    `protocol=${safeLogValue(protocol || 'none')}`,
    `query_source=${safeLogValue(querySource || 'normal')}`,
    `variant=${Number.isInteger(variant) ? variant : 0}`,
    `stream=${body?.stream === true ? 'sse' : 'json'}`,
    `effort=${safeLogValue(body?.output_config?.effort || body?.reasoning?.effort || 'disabled')}`,
    `cache_prefix_state=${prefixState}`,
    `cache_key_mode=${safeLogValue(CODEX_PROMPT_CACHE_KEY_MODE)}`,
    ...Object.entries(shape).map(([key, value]) => `${key}=${safeLogValue(value)}`),
  ]
  process.stderr.write(`model-gateway shape ${fields.join(' ')}\n`)
}

function logRoute(requestUrl, modelName, backend, body = null) {
  const tools = Array.isArray(body?.tools) ? body.tools : []
  const mcpToolCount = tools.filter(tool =>
    typeof tool?.name === 'string' && tool.name.startsWith('mcp__'),
  ).length
  process.stderr.write(
    `model-gateway route path=${requestUrl.pathname} model=${safeLogValue(modelName)} backend=${backend}` +
    ` stream=${body?.stream === true ? 'sse' : 'json'}` +
    ` tool_count=${tools.length} mcp_tool_count=${mcpToolCount}\n`,
  )
}

export function modelsResponse() {
  const data = DISCOVERABLE_MODEL_NAMES.map(id => {
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
            : backend === 'opencode-zen'
              ? 'opencode-zen'
              : 'opencode-go',
      display_name: upstream,          // Claude Code's gateway discovery labels entries by this
      effort_levels: Array.isArray(MODELS[id].effortLevels)
        ? [...MODELS[id].effortLevels]
        : [],
      ...(MODELS[id].supportsTools === false ? { supports_tools: false } : {}),
    }
  })
  return {
    object: 'list',
    data,
    models: DISCOVERABLE_MODEL_NAMES,
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

  logRoute(requestUrl, modelName, route.backend, body)
  if (route.backend === 'codex') {
    await handleCodex(body, req, res, modelName, route)
    return
  }
  if (route.backend === 'opencode-go') {
    await handleOpenCodeGo(body, req, res, modelName, route)
    return
  }
  if (route.backend === 'opencode-zen') {
    await handleOpenCodeZen(body, req, res, modelName, route)
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
      `model-gateway listening on http://${HOST}:${boundPort} models=${DISCOVERABLE_MODEL_NAMES.join(',')}\n`,
    )
  })
}
