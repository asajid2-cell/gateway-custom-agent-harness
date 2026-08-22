import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  OPENCODE_GO_ROUTES,
  OPENCODE_GO_MODEL_IDS,
  isOpenCodeGoProtocol,
  anthropicToOpenCodeRequest,
  openCodeGoEndpoint,
  openCodeGoHeaders,
  redactSecret,
  relayOpenCodeStream,
} from './opencode-go.mjs'

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
  'claude-ds-flash': { backend: 'deepseek', upstream: 'deepseek-v4-flash' },
  'claude-ds-pro': { backend: 'deepseek', upstream: 'deepseek-v4-pro' },
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
      value.backend !== 'opencode-go'
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
  if (message.includes('empty') || message.includes('malformed')) return 'malformed-response'
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
      armUpstreamTimeout()
      armConsumerTimeout()
    },
    upstreamConnected() {
      if (upstreamTimer) {
        clearTimeout(upstreamTimer)
        upstreamTimer = null
      }
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

function rewriteCodexSystemPrompt(system) {
  // Claude Code sends a large Claude-specific prompt. Replace it entirely so
  // the Codex model follows the actual user conversation instead.
  void systemText(system)
  return CODEX_SYSTEM_INSTRUCTION
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

export function anthropicToCodex(body, upstreamModel) {
  logFeatureSignals(body)

  const input = []
  for (const message of body.messages || []) {
    appendAnthropicMessage(input, message)
  }

  const request = {
    model: upstreamModel,
    stream: true,
    store: false,
    input,
    reasoning: {
      effort: body.output_config?.effort || body.reasoning?.effort || CODEX_REASONING_EFFORT,
      summary: 'detailed',
    },
    instructions: rewriteCodexSystemPrompt(body.system),
  }

  if (body.temperature != null) request.temperature = body.temperature
  if (body.top_p != null) request.top_p = body.top_p
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

function isContextWindowFailure(error) {
  const message = errorMessage(error).toLowerCase()
  return (
    message.includes('prompt is too long') ||
    message.includes('exceeds the context window') ||
    message.includes('context window limit')
  )
}

function finishAnthropicPromptTooLongError(res, error) {
  const detail = errorMessage(error)
  const message = detail.toLowerCase().startsWith('prompt is too long')
    ? detail
    : `Prompt is too long: ${detail}`
  anthropicError(res, 400, message)
}

export async function relayCodexStream(res, upstream, model, trace = null) {
  let contentIndex = 0
  let activeText = false
  let activeTool = null
  let sawOutput = false
  let toolCallSeen = false
  let usage = null
  let sawCompletion = false
  let buffer = ''
  let streamStarted = false

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
      openTool(event.item)
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
      if (!activeTool) openTool(event.item || {})
      sendEvent(res, 'content_block_delta', {
        index: contentIndex,
        delta: { type: 'input_json_delta', partial_json: event.delta || '' },
      })
      return
    }
    if (type === 'response.output_item.done' && event.item?.type === 'function_call') {
      if (!activeTool) openTool(event.item)
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

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
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
  } catch (error) {
    process.stderr.write(
      `model-gateway codex stream-error model=${safeLogValue(model)} class=${safeLogValue(classifyGatewayError(error))}\n`,
    )
    trace?.markError(error)
    if (!streamStarted) {
      if (isContextWindowFailure(error)) {
        finishAnthropicPromptTooLongError(res, error)
      } else {
        anthropicError(res, 502, errorMessage(error))
      }
      return
    }
    finishAnthropicStreamWithError(res, error)
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

export async function relayDeepSeekStream(res, upstream, trace = null) {
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
    request = anthropicToCodex(body, route.upstream)
  } catch (error) {
    trace.markError(error)
    anthropicError(res, 400, error instanceof Error ? error.message : 'Unsupported request')
    trace.finish('invalid-request', error, 400)
    control.cleanup()
    return
  }

  let upstream
  control.startUpstream()
  try {
    upstream = await fetch(CODEX_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        'chatgpt-account-id': auth.accountId,
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'user-agent': 'claudex-model-gateway/0.1',
      },
      body: JSON.stringify(request),
      signal: control.signal,
    })
    trace.markUpstreamConnect()
    control.upstreamConnected()
  } catch (error) {
    trace.markError(error)
    const status = control.signal.aborted ? control.statusFor(error) : 502
    anthropicError(res, status, status === 504 ? 'Codex upstream request timed out' : 'Codex connection failed')
    trace.finish('upstream-error', error, status)
    control.cleanup()
    return
  }

  if (!upstream.ok) {
    await upstream.body?.cancel().catch(() => {})
    const status = upstream.status >= 500 ? 502 : upstream.status
    anthropicError(res, status, safeUpstreamError(upstream.status, 'Codex'))
    trace.finish('upstream-http-error', null, status)
    control.cleanup()
    return
  }

  try {
    await relayCodexStream(res, upstream, modelName, trace)
    trace.finish(res.headersSent && res.statusCode === 200 ? 'success' : 'error', null, res.statusCode)
  } catch (error) {
    trace.markError(error)
    if (!res.headersSent) {
      anthropicError(res, 502, error instanceof Error ? error.message : 'Codex stream failed')
    } else {
      process.stderr.write(
        `model-gateway codex-stream-error model=${safeLogValue(modelName)} class=${safeLogValue(classifyGatewayError(error))}\n`,
      )
      finishAnthropicStreamWithError(res, error)
    }
    trace.finish('stream-error', error, res.statusCode)
  } finally {
    control.cleanup()
  }
}

function deepSeekHeaders(req, apiKey) {
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
  ])
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value == null || hopByHop.has(name.toLowerCase())) continue
    headers.set(name, Array.isArray(value) ? value.join(', ') : value)
  }
  headers.set('x-api-key', apiKey)
  if (!headers.has('content-type')) headers.set('content-type', 'application/json')
  return headers
}

async function handleOpenCodeGo(body, req, res, modelName, route) {
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

  let upstream
  control.startUpstream()
  try {
    upstream = await fetch(openCodeGoEndpoint(route.protocol), {
      method: 'POST',
      headers: openCodeGoHeaders(route.protocol, apiKey),
      body: JSON.stringify(request),
      signal: control.signal,
    })
    trace.markUpstreamConnect()
    control.upstreamConnected()
  } catch (error) {
    trace.markError(error)
    const status = control.signal.aborted ? control.statusFor(error) : 502
    anthropicError(res, status, status === 504 ? 'OpenCode Go upstream request timed out' : 'OpenCode Go connection failed')
    trace.finish('upstream-error', error, status)
    control.cleanup()
    return
  }

  if (!upstream.ok) {
    await upstream.body?.cancel().catch(() => {})
    const status = upstream.status >= 500 ? 502 : upstream.status
    anthropicError(res, status, redactSecret(safeUpstreamError(upstream.status, 'OpenCode Go'), apiKey))
    trace.finish('upstream-http-error', null, status)
    control.cleanup()
    return
  }

  try {
    await relayOpenCodeStream(res, upstream, modelName, route.protocol, trace)
    trace.finish(res.headersSent && res.statusCode === 200 ? 'success' : 'error', null, res.statusCode)
  } catch (error) {
    trace.markError(error)
    if (!res.headersSent) {
      anthropicError(res, 502, error instanceof Error ? error.message : 'OpenCode Go stream failed')
    } else {
      finishAnthropicStreamWithError(res, error)
    }
    trace.finish('stream-error', error, res.statusCode)
  } finally {
    control.cleanup()
  }
}

async function handleDeepSeek(req, res, requestUrl, rawBody, modelName) {
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
  control.startUpstream()
  try {
    upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: deepSeekHeaders(req, apiKey),
      body: rawBody,
      signal: control.signal,
    })
    trace.markUpstreamConnect()
    control.upstreamConnected()
  } catch (error) {
    trace.markError(error)
    const status = control.signal.aborted ? control.statusFor(error) : 502
    anthropicError(res, status, status === 504 ? 'DeepSeek upstream request timed out' : 'DeepSeek connection failed')
    trace.finish('upstream-error', error, status)
    control.cleanup()
    return
  }

  if (!upstream.ok) {
    await upstream.body?.cancel().catch(() => {})
    const status = upstream.status >= 500 ? 502 : upstream.status
    anthropicError(res, status, safeUpstreamError(upstream.status, 'DeepSeek'))
    trace.finish('upstream-http-error', null, status)
    control.cleanup()
    return
  }

  try {
    await relayDeepSeekStream(res, upstream, trace)
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

  logRoute(requestUrl, modelName, route.backend)
  if (route.backend === 'codex') {
    await handleCodex(body, req, res, modelName, route)
    return
  }
  if (route.backend === 'opencode-go') {
    await handleOpenCodeGo(body, req, res, modelName, route)
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
