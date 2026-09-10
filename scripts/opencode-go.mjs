import { randomUUID } from 'node:crypto'
import {
  effortLevelsForOpenCodeModel,
  effortWireMapForOpenCodeModel,
} from './effort-capabilities.mjs'
import {
  isNativeSummaryRequest,
  rewriteGatewaySystemPrompt,
  sanitizeLegacyCompactionContent,
  sanitizeStaleToolCapabilityContent,
} from './gateway-contract.mjs'

export const OPENCODE_GO_BASE_URL =
  process.env.OPENCODE_GO_BASE_URL || 'https://opencode.ai/zen/go/v1'

const PROTOCOLS = new Set(['responses', 'chat-completions', 'anthropic-messages'])

// The endpoint for a Go model is part of the official model contract. Do not
// infer it from the model name: OpenCode Go deliberately serves three wire
// protocols from the same base URL.
export const OPENCODE_GO_ROUTES = {
  'grok-4.5': 'responses',
  'gpt-5.6-luna': 'responses',
  'muse-spark-1.2-contributor': 'responses',
  'glm-5.3-flash': 'chat-completions',
  'glm-5.3': 'chat-completions',
  'glm-5.2': 'chat-completions',
  'glm-5.1': 'chat-completions',
  'kimi-k3': 'chat-completions',
  'kimi-k2.7-code': 'chat-completions',
  'kimi-k2.6': 'chat-completions',
  'deepseek-v4-pro': 'chat-completions',
  'deepseek-v4-flash': 'chat-completions',
  'mimo-v2.5': 'chat-completions',
  'mimo-v2.5-pro': 'chat-completions',
  'hy3': 'chat-completions',
  'minimax-m3': 'anthropic-messages',
  'minimax-m2.7': 'anthropic-messages',
  'minimax-m2.5': 'anthropic-messages',
  'qwen3.8-max': 'anthropic-messages',
  'qwen3.7-max': 'anthropic-messages',
  'qwen3.7-plus': 'anthropic-messages',
  'qwen3.6-plus': 'anthropic-messages',
}

export const OPENCODE_GO_MODEL_IDS = Object.keys(OPENCODE_GO_ROUTES)

export function openCodeGoEffortLevels(model) {
  return effortLevelsForOpenCodeModel(model)
}

export function openCodeGoEffortWireMap(model) {
  return effortWireMapForOpenCodeModel(model)
}

export function isOpenCodeGoProtocol(value) {
  return PROTOCOLS.has(value)
}

export function openCodeGoEndpoint(protocol) {
  const specific = {
    responses: process.env.OPENCODE_GO_RESPONSES_URL,
    'chat-completions': process.env.OPENCODE_GO_CHAT_COMPLETIONS_URL,
    'anthropic-messages': process.env.OPENCODE_GO_MESSAGES_URL,
  }[protocol]
  if (specific) return specific
  return `${OPENCODE_GO_BASE_URL.replace(/\/$/, '')}/${protocol === 'responses'
    ? 'responses'
    : protocol === 'chat-completions'
      ? 'chat/completions'
      : 'messages'}`
}

export function openCodeGoHeaders(protocol, apiKey, stream = false, sessionId = '') {
  const headers = {
    'content-type': 'application/json',
    accept: stream ? 'text/event-stream' : 'application/json',
    'user-agent': 'gateway-model-gateway/0.1',
  }
  if (typeof sessionId === 'string' && sessionId && /^[\u0020-\u007e\u0080-\u00ff]+$/.test(sessionId)) {
    headers['x-opencode-session'] = sessionId
  }
  if (protocol === 'anthropic-messages') {
    headers['x-api-key'] = apiKey
    headers['anthropic-version'] = '2023-06-01'
  } else {
    headers.authorization = `Bearer ${apiKey}`
  }
  return headers
}

export function redactSecret(value, secret) {
  const text = String(value ?? '')
  if (!secret || typeof secret !== 'string') return text
  return text.split(secret).join('[REDACTED]')
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(block => {
    if (typeof block === 'string') return block
    if (block?.type === 'text' || block?.type === 'input_text' || block?.type === 'output_text') {
      return block.text || ''
    }
    if (block?.type === 'tool_result') return textOf(block.content)
    if (block?.type === 'image') return '[image attachment]'
    if (block?.type === 'document') return '[document attachment]'
    if (block && typeof block === 'object') return `[${String(block.type || 'content')}]`
    return ''
  }).join('')
}

function imageUrl(block) {
  const source = block?.source
  if (source?.type === 'url' && typeof source.url === 'string' && source.url) return source.url
  if (
    source?.type === 'base64' &&
    typeof source.media_type === 'string' &&
    typeof source.data === 'string' &&
    source.media_type &&
    source.data
  ) return `data:${source.media_type};base64,${source.data}`
  throw new Error(`Unsupported Anthropic image source: ${String(source?.type || 'missing')}`)
}

function jsonArguments(value) {
  try {
    return JSON.stringify(value ?? {})
  } catch {
    return '{}'
  }
}

function blockText(block) {
  if (typeof block === 'string') return block
  if (block?.type === 'text' || block?.type === 'input_text' || block?.type === 'output_text') {
    return block.text || ''
  }
  if (block?.type === 'image') return '[image attachment]'
  if (block?.type === 'document') return '[document attachment]'
  if (block && typeof block === 'object') {
    try {
      return `[${String(block.type || 'tool output')}]\n${JSON.stringify(block)}`
    } catch {
      return `[${String(block.type || 'tool output')}]`
    }
  }
  return String(block ?? '')
}

function toolOutput(content, isError = false) {
  const value = Array.isArray(content) ? content.map(blockText).join('') : blockText(content)
  return isError ? `[tool error]\n${value}` : value
}

function responsesContent(role, blocks) {
  const result = []
  for (const block of blocks) {
    if (typeof block === 'string') {
      result.push({ type: role === 'assistant' ? 'output_text' : 'input_text', text: block })
      continue
    }
    if (block?.type === 'text' || block?.type === 'input_text' || block?.type === 'output_text') {
      result.push({ type: role === 'assistant' ? 'output_text' : 'input_text', text: block.text || '' })
      continue
    }
    if (block?.type === 'image') {
      result.push({ type: 'input_image', image_url: imageUrl(block) })
      continue
    }
    if (block?.type === 'document') {
      result.push({ type: role === 'assistant' ? 'output_text' : 'input_text', text: blockText(block) })
    }
  }
  return result
}

function appendResponsesMessage(input, message) {
  const role = message?.role === 'assistant' ? 'assistant' : 'user'
  const sanitizedContent = role === 'assistant'
    ? sanitizeStaleToolCapabilityContent(message?.content)
    : sanitizeLegacyCompactionContent(message?.content)
  const blocks = typeof sanitizedContent === 'string'
    ? [{ type: 'text', text: sanitizedContent }]
    : Array.isArray(sanitizedContent) ? sanitizedContent : []
  let ordinary = []
  const flush = () => {
    if (ordinary.length) {
      input.push({ role, content: responsesContent(role, ordinary) })
      ordinary = []
    }
  }

  for (const block of blocks) {
    if (block?.type === 'tool_use') {
      flush()
      input.push({
        type: 'function_call',
        call_id: block.id || `call_${randomUUID().replaceAll('-', '')}`,
        name: block.name || 'tool',
        arguments: jsonArguments(block.input),
      })
      continue
    }
    if (block?.type === 'tool_result') {
      flush()
      input.push({
        type: 'function_call_output',
        call_id: block.tool_use_id || block.id || `call_${randomUUID().replaceAll('-', '')}`,
        output: toolOutput(block.content ?? block.output ?? '', block.is_error === true),
      })
      continue
    }
    if (
      block?.type === 'thinking' ||
      block?.type === 'redacted_thinking' ||
      block?.type === 'compaction'
    ) continue
    ordinary.push(block)
  }
  flush()
}

function responseTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined
  return tools.map(tool => ({
    type: 'function',
    name: tool.name,
    description: tool.description || '',
    parameters: tool.input_schema || { type: 'object' },
    ...(tool.strict != null ? { strict: Boolean(tool.strict) } : {}),
  }))
}

function responseToolChoice(choice) {
  if (choice === 'auto' || choice === 'none' || choice === 'required') return choice
  if (choice === 'any') return 'required'
  if (choice?.type === 'tool' && choice.name) return { type: 'function', name: choice.name }
  return undefined
}

export function anthropicToOpenCodeResponses(body, upstreamModel, querySource) {
  const input = []
  for (const message of body.messages || []) appendResponsesMessage(input, message)
  const request = {
    model: upstreamModel,
    stream: body.stream === true,
    store: false,
    input,
  }
  request.instructions = rewriteGatewaySystemPrompt(body.system, '', querySource)
  if (body.max_tokens != null) request.max_output_tokens = body.max_tokens
  if (body.temperature != null) request.temperature = body.temperature
  if (body.top_p != null) request.top_p = body.top_p
  const tools = responseTools(body.tools)
  if (tools) request.tools = tools
  const toolChoice = responseToolChoice(body.tool_choice)
  if (toolChoice) request.tool_choice = toolChoice
  const effort = body.output_config?.effort || body.reasoning?.effort
  if (
    effort &&
    !isNativeSummaryRequest(querySource) &&
    body.thinking?.type !== 'disabled'
  ) {
    request.reasoning = { effort }
  }
  return request
}

function chatContent(blocks) {
  const result = []
  for (const block of blocks) {
    if (typeof block === 'string') result.push({ type: 'text', text: block })
    else if (block?.type === 'text' || block?.type === 'input_text' || block?.type === 'output_text') {
      result.push({ type: 'text', text: block.text || '' })
    } else if (block?.type === 'image') {
      result.push({ type: 'image_url', image_url: { url: imageUrl(block) } })
    } else if (block?.type === 'document') {
      result.push({ type: 'text', text: blockText(block) })
    }
  }
  return result
}

function appendChatMessage(messages, message) {
  const role = message?.role === 'assistant' ? 'assistant' : 'user'
  const sanitizedContent = role === 'assistant'
    ? sanitizeStaleToolCapabilityContent(message?.content)
    : sanitizeLegacyCompactionContent(message?.content)
  const blocks = typeof sanitizedContent === 'string'
    ? [{ type: 'text', text: sanitizedContent }]
    : Array.isArray(sanitizedContent) ? sanitizedContent : []
  const content = []
  const toolCalls = []
  const toolResults = []

  for (const block of blocks) {
    if (block?.type === 'tool_use') {
      toolCalls.push({
        id: block.id || `call_${randomUUID().replaceAll('-', '')}`,
        type: 'function',
        function: { name: block.name || 'tool', arguments: jsonArguments(block.input) },
      })
      continue
    }
    if (block?.type === 'tool_result') {
      toolResults.push({
        role: 'tool',
        tool_call_id: block.tool_use_id || block.id || '',
        content: toolOutput(block.content ?? block.output ?? '', block.is_error === true),
      })
      continue
    }
    if (
      block?.type !== 'thinking' &&
      block?.type !== 'redacted_thinking' &&
      block?.type !== 'compaction'
    ) {
      content.push(block)
    }
  }

  // Preserve the provider-required order: an assistant tool-call message must
  // be immediately followed by its tool result(s). Do not emit a synthetic
  // empty user message for Anthropic's tool_result-only user turn.
  if (content.length || toolCalls.length) {
    const converted = { role, content: content.length ? chatContent(content) : null }
    if (toolCalls.length) converted.tool_calls = toolCalls
    messages.push(converted)
  }
  messages.push(...toolResults)
}

function chatToolChoice(choice) {
  if (choice === 'any') return 'required'
  if (choice === 'auto' || choice === 'none' || choice === 'required') return choice
  if (choice?.type === 'tool' && choice.name) {
    return { type: 'function', function: { name: choice.name } }
  }
  return undefined
}

export function anthropicToOpenCodeChat(body, upstreamModel, querySource, effortWireMap = openCodeGoEffortWireMap(upstreamModel)) {
  const messages = []
  const system = rewriteGatewaySystemPrompt(body.system, '', querySource)
  messages.push({ role: 'system', content: system })
  for (const message of body.messages || []) appendChatMessage(messages, message)
  const request = { model: upstreamModel, stream: body.stream === true, messages }
  if (body.max_tokens != null) request.max_tokens = body.max_tokens
  if (body.temperature != null) request.temperature = body.temperature
  if (body.top_p != null) request.top_p = body.top_p
  if (Array.isArray(body.tools) && body.tools.length) {
    request.tools = body.tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: tool.input_schema || { type: 'object' },
      },
    }))
  }
  const toolChoice = chatToolChoice(body.tool_choice)
  if (toolChoice) request.tool_choice = toolChoice
  const effort = body.output_config?.effort || body.reasoning?.effort
  if (
    effort &&
    !isNativeSummaryRequest(querySource) &&
    body.thinking?.type !== 'disabled'
  ) {
    request.reasoning_effort = effortWireMap[effort] || effort
  }
  return request
}

export function anthropicToOpenCodeRequest(body, route, querySource) {
  if (route.protocol === 'responses') {
    return anthropicToOpenCodeResponses(body, route.upstream, querySource)
  }
  if (route.protocol === 'chat-completions') {
    return anthropicToOpenCodeChat(
      body,
      route.upstream,
      querySource,
      route.effortWireMap || openCodeGoEffortWireMap(route.upstream),
    )
  }
  if (route.protocol === 'anthropic-messages') {
    return {
      ...body,
      model: route.upstream,
      system: rewriteGatewaySystemPrompt(body.system, '', querySource),
      messages: Array.isArray(body.messages)
        ? body.messages.map(message => ({
            ...message,
            content: message.role === 'assistant'
              ? sanitizeStaleToolCapabilityContent(message.content)
              : sanitizeLegacyCompactionContent(message.content),
          }))
        : body.messages,
      stream: body.stream === true,
    }
  }
  throw new Error(`Unsupported OpenCode Go protocol: ${String(route.protocol)}`)
}

function nonNegative(value) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0
}

export function openCodeUsageToAnthropic(usage) {
  const input = nonNegative(usage?.input_tokens ?? usage?.prompt_tokens)
  const cached = Math.min(input, nonNegative(
    usage?.input_tokens_details?.cached_tokens ??
    usage?.prompt_tokens_details?.cached_tokens ??
    usage?.cached_tokens,
  ))
  return {
    input_tokens: input - cached,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cached,
    output_tokens: nonNegative(usage?.output_tokens ?? usage?.completion_tokens),
  }
}

function eventLine(res, event) {
  const type = event?.type
  if (!type) throw new Error('OpenCode returned an SSE event without a type')
  res.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`)
}

function startStream(res, model) {
  if (res.headersSent) return
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  const id = `msg_${randomUUID().replaceAll('-', '')}`
  eventLine(res, {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
    },
  })
  eventLine(res, { type: 'ping' })
}

function finishError(res, error) {
  if (res.destroyed || res.writableEnded) return
  const message = error instanceof Error ? error.message : String(error || 'Upstream stream failed')
  if (!res.headersSent) {
    const contextFailure = isContextWindowFailure(error)
    const status = contextFailure ? 400 : 502
    const output = contextFailure && !message.toLowerCase().startsWith('prompt is too long')
      ? `Prompt is too long: ${message}`
      : message
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: output } }))
    return
  }

  try {
    eventLine(res, { type: 'error', error: { type: 'api_error', message } })
    res.end()
  } catch (writeError) {
    if (!res.destroyed && !res.writableEnded && typeof res.destroy === 'function') res.destroy(writeError)
  }
}

async function consumeSse(upstream, onData, trace = null, signal = null) {
  const reader = upstream.body?.getReader()
  if (!reader) throw new Error('OpenCode returned an empty response body')
  const decoder = new TextDecoder()
  let buffer = ''
  let dataLines = []
  let aborted = false
  let completed = false
  let readerCancelled = false
  const cancelReader = async reason => {
    if (readerCancelled) return
    readerCancelled = true
    await reader.cancel(reason).catch(() => {})
  }
  const onAbort = () => {
    aborted = true
    void cancelReader(signal?.reason)
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  const flush = () => {
    if (!dataLines.length) return
    const payload = dataLines.join('\n')
    dataLines = []
    if (payload && payload !== '[DONE]') onData(payload)
    else if (payload === '[DONE]') onData('[DONE]')
  }
  const line = value => {
    if (value.startsWith('data:')) dataLines.push(value.slice(5).trimStart())
    else if (value === '') flush()
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (aborted || signal?.aborted) {
        throw signal?.reason || new Error('Gateway request aborted')
      }
      trace?.markFirstByte()
      trace?.addBytes(value?.byteLength || 0)
      trace?.addEvent()
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ''
      for (const item of lines) line(item)
    }
    buffer += decoder.decode()
    if (buffer) line(buffer)
    flush()
    completed = true
  } catch (error) {
    // The reader owns the lock on the body. Cancel it here, before the lock is
    // released, so failures after partial output cannot turn into a secondary
    // "body is locked" error during outer cleanup.
    await cancelReader(error)
    throw error
  } finally {
    signal?.removeEventListener('abort', onAbort)
    if (!completed) await cancelReader(signal?.reason)
    reader.releaseLock()
  }
}

async function cancelUpstream(upstream) {
  // This is only a fallback for failures that happen before consumeSse gets a
  // reader. Once a reader exists, consumeSse performs the cancellation itself.
  try {
    await upstream?.body?.cancel?.()
  } catch {
    // Cleanup must never mask the provider or stream error.
  }
}

function isContextWindowFailure(error) {
  const message = String(error?.message || error || '').toLowerCase()
  return message.includes('prompt is too long') ||
    message.includes('context window') ||
    message.includes('exceeds the context') ||
    message.includes('context length') ||
    message.includes('maximum context')
}


function responseOutputFallback(response, emitText, emitTool) {
  for (const item of response?.output || []) {
    if (item.type === 'message') {
      for (const part of item.content || []) {
        if (part.type === 'output_text' && part.text) emitText(part.text)
      }
    } else if (item.type === 'function_call') {
      emitTool(item, item.arguments || '{}')
    }
  }
}

function parseFunctionArguments(value) {
  if (value == null || value === '') return {}
  if (typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value !== 'string') throw new Error('OpenCode returned malformed function-call arguments')
  let parsed
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('OpenCode returned malformed function-call arguments')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('OpenCode returned malformed function-call arguments')
  }
  return parsed
}

export function openCodeResponsesToAnthropic(response, model) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error('OpenCode returned malformed JSON')
  }
  if (response.error) {
    const detail = typeof response.error === 'string' ? response.error : response.error.message
    throw new Error(detail ? String(detail) : 'OpenCode Responses request failed')
  }
  if (response.status && response.status !== 'completed') {
    throw new Error('OpenCode Responses request did not complete')
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
      if (!item.call_id && !item.id) throw new Error('OpenCode returned a function call without an id')
      if (!item.name) throw new Error('OpenCode returned a function call without a name')
      content.push({ type: 'tool_use', id: item.call_id || item.id, name: item.name, input: parseFunctionArguments(item.arguments) })
      hasToolUse = true
    }
  }
  if (!content.length) throw new Error('OpenCode returned an empty or malformed response')
  return {
    id: typeof response.id === 'string' && response.id ? response.id : `msg_${randomUUID().replaceAll('-', '')}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: hasToolUse ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: openCodeUsageToAnthropic(response.usage),
  }
}

export async function relayOpenCodeResponse(res, upstream, model, trace = null, options = {}) {
  try {
    const raw = await upstream.text()
    trace?.markFirstByte()
    trace?.addBytes(new TextEncoder().encode(raw).byteLength)
    trace?.addEvent()
    const message = openCodeResponsesToAnthropic(JSON.parse(raw), model)
    trace?.markOutput()
    trace?.markCompletion()
    if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(message))
  } catch (error) {
    trace?.markError(error)
    if (options.throwPreOutput && !res.headersSent) throw error
    finishError(res, error)
  }
}

export async function relayOpenCodeChatResponse(res, upstream, model, trace = null, options = {}) {
  try {
    const raw = await upstream.text()
    trace?.markFirstByte()
    trace?.addBytes(new TextEncoder().encode(raw).byteLength)
    trace?.addEvent()
    const response = JSON.parse(raw)
    if (!response || typeof response !== 'object' || Array.isArray(response)) {
      throw new Error('OpenCode returned malformed JSON')
    }
    if (response.error) {
      const detail = typeof response.error === 'string' ? response.error : response.error.message
      throw new Error(detail ? String(detail) : 'OpenCode Chat Completions request failed')
    }
    const choice = response.choices?.[0]
    const messageContent = choice?.message?.content
    const content = typeof messageContent === 'string' && messageContent
      ? [{ type: 'text', text: messageContent }]
      : []
    const reasoningContent = choice?.message?.reasoning_content ?? choice?.message?.reasoning
    if (typeof reasoningContent === 'string' && reasoningContent) {
      content.unshift({ type: 'thinking', thinking: reasoningContent })
    }
    for (const call of choice?.message?.tool_calls || []) {
      content.push({ type: 'tool_use', id: call.id || `call_${randomUUID().replaceAll('-', '')}`, name: call.function?.name || 'tool', input: parseFunctionArguments(call.function?.arguments) })
    }
    if (!content.length) throw new Error('OpenCode returned an empty or malformed response')
    const message = {
      id: response.id || `msg_${randomUUID().replaceAll('-', '')}`,
      type: 'message',
      role: 'assistant',
      model,
      content,
      stop_reason: content.some(block => block.type === 'tool_use') ? 'tool_use' : choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn',
      stop_sequence: null,
      usage: openCodeUsageToAnthropic(response.usage),
    }
    trace?.markOutput()
    trace?.markCompletion()
    if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(message))
  } catch (error) {
    trace?.markError(error)
    if (options.throwPreOutput && !res.headersSent) throw error
    finishError(res, error)
  }
}

export async function relayOpenCodeAnthropicResponse(res, upstream, model, trace = null, options = {}) {
  try {
    const raw = await upstream.text()
    trace?.markFirstByte()
    trace?.addBytes(new TextEncoder().encode(raw).byteLength)
    trace?.addEvent()
    const message = JSON.parse(raw)
    if (!message || message.type !== 'message' || !Array.isArray(message.content) || !message.content.length) {
      throw new Error('OpenCode returned an empty or malformed response')
    }
    trace?.markOutput()
    trace?.markCompletion()
    if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(message))
  } catch (error) {
    trace?.markError(error)
    if (options.throwPreOutput && !res.headersSent) throw error
    finishError(res, error)
  }
}

export async function relayOpenCodeResponseByProtocol(res, upstream, model, protocol, trace = null, options = {}) {
  if (protocol === 'responses') return relayOpenCodeResponse(res, upstream, model, trace, options)
  if (protocol === 'chat-completions') return relayOpenCodeChatResponse(res, upstream, model, trace, options)
  if (protocol === 'anthropic-messages') return relayOpenCodeAnthropicResponse(res, upstream, model, trace, options)
  throw new Error(`Unsupported OpenCode Go protocol: ${String(protocol)}`)
}

// The JSON response relays are exported for the HTTP-boundary tests and for
// consumers that need to prove the fallback never receives SSE framing.

export async function relayOpenCodeResponsesStream(res, upstream, model, trace = null, options = {}) {
  let streamStarted = false
  let activeText = false
  let activeTool = null
  let contentIndex = 0
  let sawOutput = false
  let sawCompletion = false
  let toolCallSeen = false
  let usage = null
  const start = () => {
    if (!streamStarted) {
      startStream(res, model)
      streamStarted = true
    }
  }
  const close = (advance = true) => {
    if (activeText || activeTool) {
      eventLine(res, { type: 'content_block_stop', index: contentIndex })
      if (advance) contentIndex += 1
    }
    activeText = false
    activeTool = null
  }
  const text = value => {
    if (!value) return
    start()
    if (!activeText) {
      close()
      activeText = true
      sawOutput = true
      trace?.markOutput()
      eventLine(res, { type: 'content_block_start', index: contentIndex, content_block: { type: 'text', text: '' } })
    }
    eventLine(res, { type: 'content_block_delta', index: contentIndex, delta: { type: 'text_delta', text: value } })
  }
  const tool = (item = {}, argumentsDelta = '') => {
    start()
    if (!activeTool || activeTool.callId !== (item.call_id || item.id || activeTool.callId)) {
      close()
      activeTool = {
        callId: item.call_id || item.id || `call_${randomUUID().replaceAll('-', '')}`,
        name: item.name || 'tool',
      }
      toolCallSeen = true
      sawOutput = true
      eventLine(res, {
        type: 'content_block_start',
        index: contentIndex,
        content_block: { type: 'tool_use', id: activeTool.callId, name: activeTool.name, input: {} },
      })
    }
    if (argumentsDelta) eventLine(res, { type: 'content_block_delta', index: contentIndex, delta: { type: 'input_json_delta', partial_json: argumentsDelta } })
  }
  try {
    await consumeSse(upstream, payload => {
      if (payload === '[DONE]') return
      let event
      try { event = JSON.parse(payload) } catch { throw new Error('OpenCode returned malformed Responses SSE data') }
      const type = event?.type
      if (type === 'response.output_text.delta') text(typeof event.delta === 'string' ? event.delta : '')
      else if (type === 'response.output_item.added' && event.item?.type === 'function_call') tool(event.item)
      else if (type === 'response.function_call_arguments.delta') tool(event.item || {}, event.delta || '')
      else if (type === 'response.output_item.done' && event.item?.type === 'function_call') {
        if (!activeTool) tool(event.item)
        else if (event.item.arguments && !event.delta) tool(event.item, event.item.arguments)
        close()
      } else if (type === 'response.completed') {
        sawCompletion = true
        usage = event.response?.usage || event.usage || null
        if (!sawOutput) responseOutputFallback(event.response, text, tool)
      } else if (type === 'response.failed' || type === 'response.incomplete') {
        throw new Error(event.response?.error?.message || event.response?.status_details?.reason || 'OpenCode Responses request failed')
      }
    }, trace, options.signal)
    if (!sawCompletion) throw new Error('OpenCode Responses stream ended before response.completed')
    if (!sawOutput) throw new Error('OpenCode returned an empty or malformed response')
    trace?.markCompletion()
    start()
    close()
    eventLine(res, { type: 'message_delta', delta: { stop_reason: toolCallSeen ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: openCodeUsageToAnthropic(usage) })
    eventLine(res, { type: 'message_stop' })
    res.end()
  } catch (error) {
    trace?.markError(error)
    await cancelUpstream(upstream)
    if (options.throwPreOutput && !res.headersSent) throw error
    finishError(res, error)
  }
}

export async function relayOpenCodeChatStream(res, upstream, model, trace = null, options = {}) {
  let streamStarted = false
  let activeText = false
  let activeThinking = false
  let activeTool = null
  let contentIndex = 0
  let sawOutput = false
  let sawCompletion = false
  let toolCallSeen = false
  let finishReason = null
  let usage = null
  const start = () => {
    if (!streamStarted) {
      startStream(res, model)
      streamStarted = true
    }
  }
  const close = (advance = true) => {
    if (activeText || activeThinking || activeTool) {
      eventLine(res, { type: 'content_block_stop', index: contentIndex })
      if (advance) contentIndex += 1
    }
    activeText = false
    activeThinking = false
    activeTool = null
  }
  const thinking = value => {
    if (!value) return
    start()
    if (!activeThinking) {
      close()
      activeThinking = true
      sawOutput = true
      trace?.markOutput()
      eventLine(res, { type: 'content_block_start', index: contentIndex, content_block: { type: 'thinking', thinking: '' } })
    }
    eventLine(res, { type: 'content_block_delta', index: contentIndex, delta: { type: 'thinking_delta', thinking: value } })
  }
  const text = value => {
    if (!value) return
    start()
    if (!activeText) {
      close()
      activeText = true
      sawOutput = true
      trace?.markOutput()
      eventLine(res, { type: 'content_block_start', index: contentIndex, content_block: { type: 'text', text: '' } })
    }
    eventLine(res, { type: 'content_block_delta', index: contentIndex, delta: { type: 'text_delta', text: value } })
  }
  const tool = call => {
    const fn = call?.function || {}
    start()
    const incomingId =
      typeof call?.id === 'string' && call.id.length > 0 ? call.id : undefined
    const incomingIndex = Number.isInteger(call?.index) ? call.index : undefined
    const continuesActive =
      activeTool &&
      (incomingId !== undefined
        ? activeTool.callId === incomingId
        : incomingIndex !== undefined
          ? activeTool.sourceIndex === incomingIndex
          : true)
    if (!continuesActive) {
      close()
      activeTool = {
        sourceIndex: incomingIndex ?? 0,
        callId: incomingId || `call_${randomUUID().replaceAll('-', '')}`,
        name: fn.name || 'tool',
      }
      toolCallSeen = true
      sawOutput = true
      trace?.markOutput()
      eventLine(res, { type: 'content_block_start', index: contentIndex, content_block: { type: 'tool_use', id: activeTool.callId, name: activeTool.name, input: {} } })
    }
    if (!activeTool) return
    if (fn.arguments) eventLine(res, { type: 'content_block_delta', index: contentIndex, delta: { type: 'input_json_delta', partial_json: fn.arguments } })
  }
  try {
    await consumeSse(upstream, payload => {
      if (payload === '[DONE]') {
        sawCompletion = true
        return
      }
      let chunk
      try { chunk = JSON.parse(payload) } catch { throw new Error('OpenCode returned malformed Chat Completions SSE data') }
      if (chunk?.error) throw new Error(chunk.error.message || 'OpenCode Chat Completions request failed')
      if (chunk?.usage) usage = chunk.usage
      for (const choice of chunk.choices || []) {
        const delta = choice.delta || {}
        if (typeof delta.content === 'string') text(delta.content)
        if (typeof delta.reasoning === 'string') thinking(delta.reasoning)
        if (typeof delta.reasoning_content === 'string') thinking(delta.reasoning_content)
        if (Array.isArray(delta.tool_calls)) for (const call of delta.tool_calls) tool(call)
        if (choice.finish_reason) {
          sawCompletion = true
          finishReason = choice.finish_reason
          if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'function_call') toolCallSeen = true
        }
      }
    }, trace, options.signal)
    if (!sawCompletion) throw new Error('OpenCode Chat Completions stream ended before completion')
    if (!sawOutput) throw new Error('OpenCode returned an empty or malformed response')
    trace?.markCompletion()
    start()
    close()
    eventLine(res, { type: 'message_delta', delta: { stop_reason: toolCallSeen ? 'tool_use' : finishReason === 'length' ? 'max_tokens' : 'end_turn', stop_sequence: null }, usage: openCodeUsageToAnthropic(usage) })
    eventLine(res, { type: 'message_stop' })
    res.end()
  } catch (error) {
    trace?.markError(error)
    await cancelUpstream(upstream)
    if (options.throwPreOutput && !res.headersSent) throw error
    finishError(res, error)
  }
}

export async function relayOpenCodeAnthropicStream(res, upstream, model, trace = null, options = {}) {
  let streamStarted = false
  let sawOutput = false
  let sawCompletion = false
  const pending = []
  const start = () => {
    if (!streamStarted) {
      if (!res.headersSent) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })
      }
      streamStarted = true
      for (const event of pending.splice(0)) eventLine(res, event)
    }
  }
  const emit = (event, usable = false) => {
    if (!streamStarted) {
      if (!usable) {
        pending.push(event)
        return
      }
      start()
    }
    eventLine(res, event)
  }
  try {
    await consumeSse(upstream, payload => {
      if (payload === '[DONE]') return
      let event
      try { event = JSON.parse(payload) } catch { throw new Error('OpenCode returned malformed Anthropic SSE data') }
      if (!event?.type) throw new Error('OpenCode returned an Anthropic SSE event without a type')
      if (event.type === 'message_start') {
        emit(event)
        return
      }
      if (event.type === 'content_block_start') {
        // A text/thinking block start is metadata only. A tool_use block start
        // already carries a usable tool call identity and can commit the stream.
        const usable = event.content_block?.type === 'tool_use'
        if (usable) {
          sawOutput = true
          trace?.markOutput()
        }
        emit(event, usable)
        return
      }
      if (event.type === 'content_block_delta') {
        const deltaType = event.delta?.type
        const usable = deltaType === 'text_delta' ||
          deltaType === 'input_json_delta' ||
          deltaType === 'thinking_delta'
        if (usable) {
          sawOutput = true
          trace?.markOutput()
        }
        emit(event, usable)
        return
      }
      if (event.type === 'message_stop') {
        sawCompletion = true
        emit(event)
        return
      }
      if (event.type === 'error') throw new Error(event.error?.message || 'OpenCode Anthropic request failed')
      emit(event)
    }, trace, options.signal)
    if (!sawCompletion) throw new Error('OpenCode Anthropic stream ended before message_stop')
    if (!sawOutput) throw new Error('OpenCode returned an empty or malformed response')
    trace?.markCompletion()
    res.end()
  } catch (error) {
    trace?.markError(error)
    await cancelUpstream(upstream)
    if (options.throwPreOutput && !res.headersSent) throw error
    finishError(res, error)
  }
}

export async function relayOpenCodeStream(res, upstream, model, protocol, trace = null, options = {}) {
  if (protocol === 'responses') return relayOpenCodeResponsesStream(res, upstream, model, trace, options)
  if (protocol === 'chat-completions') return relayOpenCodeChatStream(res, upstream, model, trace, options)
  if (protocol === 'anthropic-messages') return relayOpenCodeAnthropicStream(res, upstream, model, trace, options)
  const error = new Error(`Unsupported OpenCode Go protocol: ${String(protocol)}`)
  trace?.markError(error)
  throw error
}
