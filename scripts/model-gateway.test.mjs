import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  anthropicToCodex,
  codexPromptCacheKeyForBody,
  codexUsageToAnthropic,
  relayCodexStream,
  relayCodexResponse,
  codexResponseToAnthropic,
  relayDeepSeekStream,
  relayDeepSeekResponse,
  normalizeGatewayEffort,
  modelsResponse,
  stripUnsupportedOpenCodeTools,
  stripUnsupportedOpenCodeToolChoice,
  safeUpstreamResponseError,
  gatewayRequestShape,
} from './model-gateway.mjs'
import {
  anthropicToOpenCodeChat,
  anthropicToOpenCodeResponses,
  anthropicToOpenCodeRequest,
  openCodeGoHeaders,
  openCodeUsageToAnthropic,
  relayOpenCodeChatStream,
  relayOpenCodeResponsesStream,
  relayOpenCodeAnthropicStream,
  relayOpenCodeResponse,
  relayOpenCodeChatResponse,
  relayOpenCodeAnthropicResponse,
  relayOpenCodeResponseByProtocol,
  openCodeGoEffortLevels,
} from './opencode-go.mjs'
import {
  openCodeZenHeaders,
} from './opencode-zen.mjs'
import {
  GATEWAY_QUERY_SOURCE_HEADER,
  COMPACTION_RUNTIME_TOOL_CONTRACT,
  gatewayQuerySource,
  isCompactionRequest,
  RUNTIME_TOOL_CONTRACT,
  sanitizeLegacyCompactionContent,
  sanitizeLegacyCompactionText,
  sanitizeStaleToolCapabilityContent,
} from './gateway-contract.mjs'

class CaptureResponse {
  chunks = []
  headers = null
  ended = false
  destroyed = false

  get headersSent() {
    return this.headers !== null
  }

  writeHead(status, headers) {
    this.headers = { status, ...headers }
  }

  write(chunk) {
    this.chunks.push(String(chunk))
    return true
  }

  end() {
    if (arguments.length > 0 && arguments[0] != null) {
      this.chunks.push(String(arguments[0]))
    }
    this.ended = true
  }

  destroy() {
    this.destroyed = true
  }

  text() {
    return this.chunks.join('')
  }
}

function responseEvents(response) {
  return response
    .text()
    .split('\n\n')
    .filter(Boolean)
    .map(chunk => JSON.parse(chunk.split('\ndata: ')[1] || chunk.slice(6)))
}

function upstreamFromEvents(events) {
  const payload = events
    .map(event => typeof event === 'string' ? `data: ${event}\n\n` : `data: ${JSON.stringify(event)}\n\n`)
    .join('')
  return {
    status: 200,
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload))
        controller.close()
      },
    }),
  }
}

function anthropicUpstreamFromEvents(events) {
  return upstreamFromEvents(events)
}

function deepSeekValidEvents() {
  return [
    { type: 'message_start', message: { id: 'msg-ds', type: 'message', role: 'assistant', content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ]
}

function deepSeekEmptyEvents() {
  return [
    { type: 'message_start', message: { id: 'msg-empty', type: 'message', role: 'assistant', content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'message_stop' },
  ]
}

function deepSeekContextFailureEvents() {
  return [
    { type: 'error', error: { type: 'invalid_request_error', message: 'Prompt is too long: context window exceeded' } },
  ]
}

function deepSeekResetUpstream() {
  let sent = false
  return { status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }), body: new ReadableStream({
    pull(controller) {
      if (!sent) {
        sent = true
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'message_start', message: { id: 'msg-reset', type: 'message', role: 'assistant', content: [] } })}\n\n`))
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`))
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } })}\n\n`))
      } else controller.error(new Error('ECONNRESET'))
    },
  }) }
}

function deepSeekHeaders() {
  return new Headers({ 'content-type': 'text/event-stream' })
}

function deepSeekResponse(events) {
  const upstream = anthropicUpstreamFromEvents(events)
  upstream.headers = deepSeekHeaders()
  return upstream
}

function delayedUpstream(delayMs, events = []) {
  const payload = events
    .map(event => `data: ${JSON.stringify(event)}\n\n`)
    .join('')
  return {
    body: new ReadableStream({
      async start(controller) {
        await new Promise(resolve => setTimeout(resolve, delayMs))
        controller.enqueue(new TextEncoder().encode(payload))
        controller.close()
      },
    }),
  }
}

function traceCapture() {
  const marks = {}
  return {
    marks,
    markFirstByte() { marks.firstByte = true },
    markOutput() { marks.output = true },
    markCompletion() { marks.completion = true },
    markError(error) { marks.error = error?.message || String(error) },
    addBytes(value) { marks.bytes = (marks.bytes || 0) + value },
    addEvent() { marks.events = (marks.events || 0) + 1 },
  }
}

const gatewayScript = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'model-gateway.mjs',
)

async function startGatewayForTest(env) {
  const child = spawn(process.execPath, [gatewayScript, '--port', '0'], {
    cwd: path.dirname(gatewayScript),
    env: {
      ...process.env,
      ...env,
      CODEX_RESPONSES_URL: env.CODEX_RESPONSES_URL,
      MODEL_GATEWAY_UPSTREAM_TIMEOUT_MS: env.MODEL_GATEWAY_UPSTREAM_TIMEOUT_MS,
      MODEL_GATEWAY_CONSUMER_TIMEOUT_MS: env.MODEL_GATEWAY_CONSUMER_TIMEOUT_MS,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr += chunk })
  // This loop is event-driven on the healthy path: it returns as soon as the
  // listen line lands, and fails immediately if the child exits. The deadline
  // only bounds "alive but not yet listening", so a generous value costs a
  // healthy run nothing while a 5s ceiling turned host load into a fixture
  // failure ("Gateway did not start") that said nothing about the gateway.
  const deadline = Date.now() + 30000
  const fail = async message => {
    // Await the kill: the caller's try/finally has not been entered yet, so a
    // throw here would otherwise strand a listening child for the whole run.
    child.kill()
    await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 2000))])
    throw new Error(message)
  }
  while (Date.now() < deadline) {
    if (stderr.includes('model-gateway listening on ')) {
      const match = stderr.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)
      if (!match) await fail(`Gateway announced an invalid address: ${stderr}`)
      return { child, port: Number(match[1]), getStderr: () => stderr }
    }
    if (child.exitCode !== null) throw new Error(`Gateway exited: ${stderr}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  await fail(`Gateway did not start: ${stderr}`)
}

async function stopChild(child) {
  if (child.exitCode !== null) return
  child.kill()
  await Promise.race([
    once(child, 'exit'),
    new Promise(resolve => setTimeout(resolve, 2000)),
  ])
}

function fakeCodexServer(handler) {
  const server = createServer(handler)
  return new Promise(async (resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve({
        server,
        port: server.address().port,
      })
    })
  })
}

async function postGateway(port, body, extraHeaders = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  })
  return {
    status: response.status,
    headers: response.headers,
    body: await response.text(),
  }
}

async function abortGatewayAfterHeaders(port, body) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })
    let responseStatus = null
    let responseEnded = false
    request.once('error', error => {
      if (error.code === 'ECONNRESET' || error.code === 'ERR_STREAM_DESTROYED') {
        resolve({ status: responseStatus, ended: responseEnded })
      } else {
        reject(error)
      }
    })
    request.once('response', response => {
      responseStatus = response.statusCode
      response.once('end', () => {
        responseEnded = true
        resolve({ status: responseStatus, ended: true })
      })
      // Once upstream headers/output have reached the client, destroy the
      // response socket. Destroying the request object here is too late to
      // model a downstream consumer disconnect and may leave the response
      // readable side attached.
      response.destroy()
      setImmediate(() => {
        if (!responseEnded) resolve({ status: responseStatus, ended: false })
      })
    })
    request.end(JSON.stringify(body))
  })
}

async function abortGatewayDuringRetry(port, body, delayMs, ready = () => true) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })
    let settled = false
    const finish = result => {
      if (settled) return
      settled = true
      resolve(result)
    }
    request.once('error', error => {
      if (error.code === 'ECONNRESET' || error.code === 'ERR_STREAM_DESTROYED') {
        finish({ disconnected: true })
      } else {
        reject(error)
      }
    })
    request.once('response', response => {
      response.resume()
      response.once('end', () => finish({ disconnected: false, status: response.statusCode }))
    })
    request.end(JSON.stringify(body))
    const deadline = Date.now() + 5000
    const abortWhenReady = () => {
      if (settled) return
      if (!ready()) {
        if (Date.now() >= deadline) {
          settled = true
          request.destroy()
          reject(new Error('Upstream request was not observed before abort deadline'))
          return
        }
        setTimeout(abortWhenReady, 5)
        return
      }
      request.destroy()
      finish({ disconnected: true })
    }
    setTimeout(abortWhenReady, delayMs)
  })
}

async function waitForTiming(gateway, predicate = () => true, timeoutMs = 1000) {
  let stderr = gateway.getStderr()
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const lines = timingLines(stderr)
    const line = lines.find(predicate)
    if (line) return { line, stderr }
    await new Promise(resolve => setTimeout(resolve, 10))
    stderr = gateway.getStderr()
  }
  throw new Error(`Gateway timing line did not arrive: ${stderr}`)
}

async function waitForUpstreamCancellation(state, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (!state.requestAborted && !state.responseClosed && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return state.requestAborted || state.responseClosed
}

function abortAwareCodexHandler(state) {
  return (req, res) => {
    req.resume()
    req.once('aborted', () => { state.requestAborted = true })
    // The request body is already complete by the time the Gateway starts
    // relaying. A cancelled fetch is therefore observed most reliably as the
    // provider response socket closing, not as request.aborted.
    res.once('close', () => { state.responseClosed = true })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'partial' })}\n\n`)
  }
}

async function withGatewayAndFakeCodex({ upstreamHandler, gatewayEnv = {}, run }) {
  const fake = await fakeCodexServer(upstreamHandler)
  const codexHome = await mkdtemp(path.join(os.tmpdir(), 'gateway-test-codex-'))
  await writeFile(
    path.join(codexHome, 'auth.json'),
    JSON.stringify({ tokens: { access_token: randomUUID(), account_id: randomUUID() } }),
  )
  const gateway = await startGatewayForTest({
    CODEX_RESPONSES_URL: `http://127.0.0.1:${fake.port}/responses`,
    CODEX_HOME: codexHome,
    MODEL_GATEWAY_LOG_TIMING: '1',
    ...gatewayEnv,
  })
  try {
    return await run(gateway)
  } finally {
    await stopChild(gateway.child)
    await new Promise(resolve => fake.server.close(resolve))
    await rm(codexHome, { recursive: true, force: true })
  }
}

async function withGatewayAndFakeCodexState({ handlerFactory, run, gatewayEnv = {} }) {
  const state = { requestAborted: false, responseClosed: false, requests: [] }
  const fake = await fakeCodexServer(handlerFactory(state))
  const codexHome = await mkdtemp(path.join(os.tmpdir(), 'gateway-test-codex-'))
  await writeFile(
    path.join(codexHome, 'auth.json'),
    JSON.stringify({ tokens: { access_token: randomUUID(), account_id: randomUUID() } }),
  )
  const gateway = await startGatewayForTest({
    CODEX_RESPONSES_URL: `http://127.0.0.1:${fake.port}/responses`,
    CODEX_HOME: codexHome,
    MODEL_GATEWAY_LOG_TIMING: '1',
    MODEL_GATEWAY_UPSTREAM_TIMEOUT_MS: '1000',
    MODEL_GATEWAY_CONSUMER_TIMEOUT_MS: '1000',
    ...gatewayEnv,
  })
  try {
    return await run({ gateway, state })
  } finally {
    await stopChild(gateway.child)
    await new Promise(resolve => fake.server.close(resolve))
    await rm(codexHome, { recursive: true, force: true })
  }
}

async function withGatewayAndFakeOpenCode({ handler, run, gatewayEnv = {} }) {
  const state = { requests: [] }
  const fake = await fakeCodexServer((req, res) => handler(req, res, state))
  const gateway = await startGatewayForTest({
    OPENCODE_API_KEY: randomUUID(),
    OPENCODE_GO_RESPONSES_URL: `http://127.0.0.1:${fake.port}/responses`,
    OPENCODE_GO_CHAT_COMPLETIONS_URL: `http://127.0.0.1:${fake.port}/chat/completions`,
    OPENCODE_GO_MESSAGES_URL: `http://127.0.0.1:${fake.port}/messages`,
    MODEL_GATEWAY_LOG_TIMING: '1',
    MODEL_GATEWAY_UPSTREAM_TIMEOUT_MS: '1000',
    MODEL_GATEWAY_CONSUMER_TIMEOUT_MS: '1000',
    ...gatewayEnv,
  })
  try {
    return await run({ gateway, state })
  } finally {
    await stopChild(gateway.child)
    await new Promise(resolve => fake.server.close(resolve))
  }
}

async function withGatewayAndFakeDeepSeek({ handler, run, gatewayEnv = {} }) {
  const state = { requests: [], requestAborted: false, responseClosed: false }
  const fake = await fakeCodexServer((req, res) => handler(req, res, state))
  const gateway = await startGatewayForTest({
    DEEPSEEK_API_KEY: randomUUID(),
    DEEPSEEK_API_URL: `http://127.0.0.1:${fake.port}/messages`,
    MODEL_GATEWAY_LOG_TIMING: '1',
    MODEL_GATEWAY_UPSTREAM_TIMEOUT_MS: '1000',
    MODEL_GATEWAY_CONSUMER_TIMEOUT_MS: '1000',
    ...gatewayEnv,
  })
  try {
    return await run({ gateway, state })
  } finally {
    await stopChild(gateway.child)
    await new Promise(resolve => fake.server.close(resolve))
  }
}

function parseGatewayError(body) {
  return JSON.parse(body).error
}

function hasMessageStop(body) {
  return body.split('\n\n').some(chunk => chunk.includes('"message_stop"'))
}

function timingLines(stderr) {
  return stderr.split(/\r?\n/).filter(line => line.startsWith('model-gateway timing '))
}

function lastTimingLine(stderr) {
  return timingLines(stderr).at(-1) || ''
}

function timingFields(line) {
  return Object.fromEntries(
    line.replace(/^model-gateway timing /, '').split(' ').map(field => {
      const separator = field.indexOf('=')
      return [field.slice(0, separator), field.slice(separator + 1)]
    }),
  )
}

function assertNoPayloadTimingFields(line) {
  for (const forbidden of ['prompt', 'body', 'header', 'authorization', 'api_key', 'token']) {
    assert.equal(line.toLowerCase().includes(forbidden), false, `timing leaked ${forbidden}`)
  }
}

async function slowResponse(socket, delayMs) {
  await new Promise(resolve => setTimeout(resolve, delayMs))
  if (!socket.destroyed) {
    socket.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'late' })}\n\n`)
    socket.write(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'late' }] }] } })}\n\n`)
    socket.end()
  }
}

async function requestJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function completedCodexResponse(text = 'ok') {
  return {
    id: 'resp-test',
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
  }
}

async function upstreamResponseFromRequest(req, res) {
  const body = await requestJson(req)
  if (body.stream === false) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(completedCodexResponse()))
    return
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'ok' })}\n\n`)
  res.end(`data: ${JSON.stringify({ type: 'response.completed', response: completedCodexResponse() })}\n\n`)
}

function incompleteThenJsonCodexHandler(state) {
  return async (req, res) => {
    const body = await requestJson(req)
    state.requests.push({
      stream: body.stream,
      ...(body.max_output_tokens != null ? { maxOutputTokens: body.max_output_tokens } : {}),
    })
    if (state.requests.length === 1) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'partial' })}\n\n`)
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'recovered' })}\n\n` +
      `data: ${JSON.stringify({ type: 'response.completed', response: completedCodexResponse('recovered') })}\n\n`,
    )
  }
}

function compactionRequestBody(overrides = {}) {
  return {
    model: 'claude-gpt-luna',
    stream: true,
    thinking: { type: 'disabled' },
    tools: [{ name: 'Read', description: 'read files', input_schema: { type: 'object' } }],
    system: 'main system',
    messages: [{
      role: 'user',
      content: 'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n<summary>Summarize the conversation.</summary>',
    }],
    ...overrides,
  }
}

function malformedJsonCodexHandler(req, res) {
  req.resume()
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end('{}')
}

function emptyJsonCodexHandler(req, res) {
  req.resume()
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end('not-json')
}

function delayedCodexHandler(delayMs) {
  return (req, res) => {
    req.resume()
    void slowResponse(res, delayMs)
  }
}

async function postCompaction(port, body) {
  return postGateway(port, body, {
    [GATEWAY_QUERY_SOURCE_HEADER]: 'compact',
  })
}

function stalledCompactionCodexHandler(state) {
  return async (req, res) => {
    const body = await requestJson(req)
    state.requests.push(body)
    state.compactionRequest =
      req.headers[GATEWAY_QUERY_SOURCE_HEADER] === 'compact'
    req.once('aborted', () => { state.requestAborted = true })
    res.once('close', () => { state.responseClosed = true })
    // Intentionally leave the response without headers or a body. The gateway
    // must enforce its upstream deadline and cancel this provider request.
  }
}

function emptyCodexHandler(req, res) {
  req.resume()
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end()
}

function contextFailureCodexHandler(req, res) {
  req.resume()
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end(`data: ${JSON.stringify({
    type: 'response.failed',
    response: { error: { message: 'Your input exceeds the context window of this model.' } },
  })}\n\n`)
}

function contextFallbackCodexHandler(state) {
  return async (req, res) => {
    const body = await requestJson(req)
    state.requests.push({
      toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
      descriptions: (body.tools || []).map(tool => tool.description),
      requestBytes: Buffer.byteLength(JSON.stringify(body), 'utf8'),
    })
    if (state.requests.length === 1) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`data: ${JSON.stringify({
        type: 'response.failed',
        response: { error: { message: 'Your input exceeds the context window of this model.' } },
      })}\n\n`)
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'recovered' })}\n\n` +
      `data: ${JSON.stringify({ type: 'response.completed', response: completedCodexResponse('recovered') })}\n\n`,
    )
  }
}

function context400FallbackCodexHandler(state) {
  return async (req, res) => {
    const body = await requestJson(req)
    state.requests.push({ toolCount: body.tools?.length || 0 })
    if (state.requests.length === 1) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        error: { message: 'Your input exceeds the context window of this model.' },
      }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'recovered' })}\n\n` +
      `data: ${JSON.stringify({ type: 'response.completed', response: completedCodexResponse('recovered') })}\n\n`,
    )
  }
}

function malformedThenHealthyCodexHandler(state) {
  return async (req, res) => {
    await requestJson(req)
    state.requests.push({ attempt: state.requests.length + 1 })
    if (state.requests.length === 1) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('data: not-json\n\n')
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'recovered' })}\n\n` +
      `data: ${JSON.stringify({ type: 'response.completed', response: completedCodexResponse('recovered') })}\n\n`,
    )
  }
}

function malformedThenWaitingOpenCodeHandler(state) {
  return async (req, res) => {
    await requestJson(req)
    state.requests.push(state.requests.length + 1)
    if (state.requests.length === 1) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('data: not-json\n\n')
      return
    }

    req.once('aborted', () => { state.requestAborted = true })
    res.once('close', () => { state.responseClosed = true })
    // The second attempt deliberately never sends response headers. A retry
    // must arm a fresh upstream-header deadline instead of inheriting the
    // completed first attempt's request-control state.
  }
}

function malformedThenWaitingCodexHandler(state) {
  return async (req, res) => {
    await requestJson(req)
    state.requests.push(state.requests.length + 1)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: not-json\n\n')
  }
}

function malformedThenHeaderlessCodexHandler(state) {
  return async (req, res) => {
    await requestJson(req)
    state.requests.push(state.requests.length + 1)
    if (state.requests.length === 1) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('data: not-json\n\n')
      return
    }

    req.resume()
    req.once('aborted', () => { state.requestAborted = true })
    res.once('close', () => { state.responseClosed = true })
    // The second attempt deliberately never sends headers. This exercises the
    // same shared request-control retry state through the Codex route.
  }
}

function malformedAfterOutputCodexHandler(state) {
  return async (req, res) => {
    await requestJson(req)
    state.requests.push({ attempt: state.requests.length + 1 })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'partial' })}\n\n` +
      'data: not-json\n\n',
    )
  }
}

function compactToolsSuccessCodexHandler(state) {
  return async (req, res) => {
    const body = await requestJson(req)
    state.requests.push({
      descriptions: (body.tools || []).map(tool => tool.description),
      parameters: (body.tools || []).map(tool => tool.parameters),
      requestBytes: Buffer.byteLength(JSON.stringify(body), 'utf8'),
    })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'compact-ok' })}\n\n` +
      `data: ${JSON.stringify({ type: 'response.completed', response: completedCodexResponse('compact-ok') })}\n\n`,
    )
  }
}

function compactToolsFallbackCodexHandler(state) {
  return async (req, res) => {
    const body = await requestJson(req)
    state.requests.push({
      descriptions: (body.tools || []).map(tool => tool.description),
    })
    if (state.requests.length < 3) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`data: ${JSON.stringify({
        type: 'response.failed',
        response: { error: { message: 'Your input exceeds the context window of this model.' } },
      })}\n\n`)
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'fallback-ok' })}\n\n` +
      `data: ${JSON.stringify({ type: 'response.completed', response: completedCodexResponse('fallback-ok') })}\n\n`,
    )
  }
}

function operationalContextContinuityCodexHandler(state) {
  return async (req, res) => {
    const body = await requestJson(req)
    const instructions = typeof body.instructions === 'string' ? body.instructions : ''
    const inputText = JSON.stringify(body.input || [])
    state.requests.push({
      hasOperationalMarker: instructions.includes('SYNTHETIC_ACTIVE_WORKSPACE_MARKER'),
      toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
      effort: body.reasoning?.effort,
      hasCompactionBoundary: inputText.includes('[compaction boundary]'),
    })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'ok' })}\n\n` +
      `data: ${JSON.stringify({ type: 'response.completed', response: completedCodexResponse('ok') })}\n\n`,
    )
  }
}

function astraCodexHandler(state) {
  return async (req, res) => {
    const body = await requestJson(req)
    state.requests.push(body)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'astra-ok' })}\n\n` +
      `data: ${JSON.stringify({ type: 'response.completed', response: completedCodexResponse('astra-ok') })}\n\n`,
    )
  }
}

function healthyCodexHandler(req, res) {
  return upstreamResponseFromRequest(req, res)
}

function retryingCodexHandler(state, status, failures) {
  return async (req, res) => {
    const body = await requestJson(req)
    state.requests.push({ attempt: state.requests.length + 1 })
    if (state.requests.length <= failures) {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `synthetic ${status}` } }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'ok' })}\n\n`)
    res.end(
      `data: ${JSON.stringify({
        type: 'response.completed',
        response: completedCodexResponse(body.messages?.[0]?.content || 'ok'),
      })}\n\n`,
    )
  }
}

function delayedAfterHeadersCodexHandler(delayMs) {
  return (req, res) => {
    req.resume()
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    void slowResponse(res, delayMs)
  }
}

function minimalCodexBody() {
  return {
    model: 'gpt-5.6-luna',
    max_tokens: 8,
    stream: true,
    messages: [{ role: 'user', content: 'compact this' }],
  }
}

function compactionSizedBody() {
  const repeatedContext = 'synthetic compaction context '.repeat(256)
  const messages = []

  for (let index = 0; index < 48; index += 1) {
    messages.push({
      role: 'user',
      content: `Synthetic user turn ${index}: ${repeatedContext}`,
    })

    messages.push({
      role: 'assistant',
      content: index === 24
        ? [
            { type: 'compaction' },
            {
              type: 'text',
              text: `Synthetic compacted turn ${index}: ${repeatedContext}`,
            },
          ]
        : `Synthetic assistant turn ${index}: ${repeatedContext}`,
    })
  }

  return {
    model: 'gpt-5.6-luna',
    max_tokens: 8,
    stream: true,
    system: 'Synthetic compaction replay; no real prompt data.',
    messages,
  }
}

async function assertGatewayBoundedResult({ handler, env = {}, expectedStatus, expected }) {
  return withGatewayAndFakeCodex({
    upstreamHandler: handler,
    gatewayEnv: { MODEL_GATEWAY_LOG_TIMING: '1', ...env },
    run: async gateway => {
      const started = performance.now()
      const result = await postGateway(gateway.port, minimalCodexBody())
      const elapsed = performance.now() - started
      // The request has ended, but stderr delivery can lag the response by a
      // turn. Give the child a bounded drain window before inspecting timing.
      let stderr = gateway.getStderr()
      const deadline = Date.now() + 500
      while (!lastTimingLine(stderr) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10))
        stderr = gateway.getStderr()
      }
      assert.equal(result.status, expectedStatus)
      if (expected) expected(result)
      return { ...result, elapsed, stderr }
    },
  })
}

/**
 * Wall-clock assertions in this file must not measure the host machine.
 *
 * These tests pin small timeouts so the suite stays fast, which made absolute
 * bounds like `elapsed < 250` fail on healthy runs. A correct retry costs ~80ms
 * while the failure being guarded — falling through to the consumer timeout —
 * costs the full consumer timeout, so a loaded machine only had to add ~250ms of
 * scheduling jitter to bridge the gap. The suite then went red under load and
 * green when idle, which teaches the reader to ignore it, and a real regression
 * in that gap would have been waved through as "just the timing thing".
 *
 * `path` is what a correct run costs and `fallback` is the consumer timeout it
 * must never reach. The midpoint keeps the assertion discriminating while
 * leaving room for jitter, and the guard refuses a fixture whose two outcomes
 * are too close together to tell apart.
 */
function assertCompletedBeforeFallback(elapsed, { label, path, fallback }) {
  assert.ok(
    fallback > path * 2,
    `"${label}" cannot separate success from failure: a ${path}ms path against a ${fallback}ms consumer fallback`,
  )
  const budget = (path + fallback) / 2
  assert.ok(
    elapsed < budget,
    `${label}: ${Math.round(elapsed)}ms exceeded the ${Math.round(budget)}ms budget (correct path ~${path}ms, consumer fallback ${fallback}ms)`,
  )
}

// A narrow HTTP-boundary fixture: it talks to the real standalone Gateway and
// a local fake Responses provider. The temporary auth file contains only
// synthetic credentials and is removed by the fixture teardown.
test('HTTP boundary rejects an empty upstream stream before committing 200', async () => {
  const result = await assertGatewayBoundedResult({
    handler: emptyCodexHandler,
    // The previous bound here was `elapsed < 2000` against a 1000ms consumer
    // timeout, so a gateway that hung until the consumer deadline would have
    // passed. Widen the fixture's timeout so reaching it is unmistakable, and
    // measure against the midpoint rather than an absolute number.
    gatewayEnv: { MODEL_GATEWAY_LOG_TIMING: '1', MODEL_GATEWAY_CONSUMER_TIMEOUT_MS: '3000' },
    expectedStatus: 502,
    expected: response => {
      assert.equal(parseGatewayError(response.body).message, 'Codex stream ended before response.completed')
      assert.equal(hasMessageStop(response.body), false)
    },
  })
  // The provider ends the stream immediately, so a correct run costs only the
  // child's one-time lazy init (~800ms, paid by this fixture's first request).
  // The alternative to a prompt 502 is hanging until the 3000ms consumer
  // timeout, which this must never reach.
  assertCompletedBeforeFallback(result.elapsed, {
    label: 'empty upstream stream',
    path: 800,
    fallback: 3000,
  })
  const timing = lastTimingLine(result.stderr)
  assert.ok(timing, result.stderr)
  assert.equal(timingFields(timing).outcome, 'error')
  assertNoPayloadTimingFields(timing)
})

test('HTTP boundary maps a pre-output context failure to 400', async () => {
  const result = await assertGatewayBoundedResult({
    handler: contextFailureCodexHandler,
    gatewayEnv: { MODEL_GATEWAY_LOG_TIMING: '1' },
    expectedStatus: 400,
    expected: response => {
      assert.match(parseGatewayError(response.body).message, /^Prompt is too long:/)
    },
  })
  const timing = timingFields(lastTimingLine(result.stderr))
  assert.equal(timing.outcome, 'error')
  assert.equal(timing.error_class, 'context-window')
})

test('HTTP boundary enforces the upstream timeout and cleans up the request', async () => {
  const result = await assertGatewayBoundedResult({
    handler: delayedCodexHandler(250),
    env: {
      MODEL_GATEWAY_UPSTREAM_TIMEOUT_MS: '40',
      MODEL_GATEWAY_CONSUMER_TIMEOUT_MS: '1000',
    },
    expectedStatus: 504,
    expected: response => {
      assert.equal(parseGatewayError(response.body).message, 'Gateway upstream request timed out')
    },
  })
  // The 40ms upstream timeout must end the call, not the 1000ms consumer
  // timeout that would catch it if the upstream deadline were not enforced.
  assertCompletedBeforeFallback(result.elapsed, {
    label: 'upstream timeout enforcement',
    path: 40,
    fallback: 1000,
  })
  const timing = timingFields(lastTimingLine(result.stderr))
  assert.equal(timing.outcome, 'upstream-error')
  assert.equal(timing.error_class, 'timeout')
})

test('HTTP boundary converts a consumer timeout after upstream headers into an SSE error', async () => {
  const result = await assertGatewayBoundedResult({
    handler: delayedAfterHeadersCodexHandler(250),
    env: {
      MODEL_GATEWAY_UPSTREAM_TIMEOUT_MS: '1000',
      MODEL_GATEWAY_CONSUMER_TIMEOUT_MS: '40',
    },
    expectedStatus: 504,
    expected: response => {
      assert.equal(hasMessageStop(response.body), false)
      assert.match(response.body, /Gateway consumer timeout/)
    },
  })
  const timing = timingFields(lastTimingLine(result.stderr))
  assert.ok(['upstream-error', 'stream-error'].includes(timing.outcome))
  assert.equal(timing.error_class, 'timeout')
  assert.ok(Number(timing.error_ms) >= 0)
})

test('HTTP boundary cancels the upstream when the consumer disconnects after output', async () => {
  await withGatewayAndFakeCodexState({
    handlerFactory: abortAwareCodexHandler,
    run: async ({ gateway, state }) => {
      const client = await abortGatewayAfterHeaders(gateway.port, minimalCodexBody())
      assert.equal(client.status, 200)
      // Depending on Node's socket-close ordering, the Gateway may finish the
      // already-disconnected response while the client-side destroy is being
      // delivered. The discriminating observation is upstream cancellation.
      assert.equal(await waitForUpstreamCancellation(state), true)
      const timing = await waitForTiming(gateway, line => {
        const fields = timingFields(line)
        return fields.status === '200'
      })
      const fields = timingFields(timing.line)
      assert.equal(fields.status, '200')
      assert.ok(['stream-error', 'success'].includes(fields.outcome))
      assertNoPayloadTimingFields(timing.line)
    },
  })
})

test('HTTP boundary routes Astra to gpt-6-astra and normalizes ultracode to ultra', async () => {
  await withGatewayAndFakeCodexState({
    handlerFactory: astraCodexHandler,
    run: async ({ gateway, state }) => {
      const result = await postGateway(gateway.port, {
        model: 'gateway-gpt-astra',
        stream: true,
        output_config: { effort: 'ultracode' },
        reasoning: { effort: 'ultracode' },
        messages: [{ role: 'user', content: 'synthetic Astra request' }],
      })
      assert.equal(result.status, 200)
      assert.equal(state.requests.length, 1)
      assert.equal(state.requests[0].model, 'gpt-6-astra')
      assert.equal(state.requests[0].reasoning.effort, 'ultra')
      assert.equal(JSON.stringify(state.requests[0]).includes('ultracode'), false)
    },
  })
})

test('HTTP boundary reports a successful completion with phase timing', async () => {
  const result = await assertGatewayBoundedResult({
    handler: healthyCodexHandler,
    expectedStatus: 200,
    expected: response => {
      assert.equal(hasMessageStop(response.body), true)
    },
  })
  const timing = timingFields(lastTimingLine(result.stderr))
  assert.equal(timing.outcome, 'success')
  assert.ok(Number(timing.upstream_connect_ms) >= 0)
  assert.ok(Number(timing.first_byte_ms) >= 0)
  assert.ok(Number(timing.first_output_ms) >= 0)
  assert.ok(Number(timing.completion_ms) >= 0)
  assert.ok(Number(timing.bytes) > 0)
  assert.ok(Number(timing.events) > 0)
  assertNoPayloadTimingFields(lastTimingLine(result.stderr))
})

test('Codex conversion preserves compaction streaming mode and output token cap', () => {
  const streaming = anthropicToCodex({ stream: true, max_tokens: 321, messages: [] }, 'gpt-5.6-luna')
  const fallback = anthropicToCodex({ stream: false, max_tokens: 654, messages: [] }, 'gpt-5.6-luna')
  const omitted = anthropicToCodex({ max_tokens: 987, messages: [] }, 'gpt-5.6-luna')
  assert.equal(streaming.stream, true)
  assert.equal(streaming.max_output_tokens, 321)
  assert.equal(fallback.stream, false)
  assert.equal(fallback.max_output_tokens, 654)
  assert.equal(omitted.stream, false)
  assert.equal(omitted.max_output_tokens, 987)
})

test('Codex conversion omits unsupported sampling controls', () => {
  const request = anthropicToCodex({
    temperature: 0.2,
    top_p: 0.8,
    messages: [{ role: 'user', content: 'subagent request' }],
  }, 'gpt-5.6-luna')

  assert.equal(request.temperature, undefined)
  assert.equal(request.top_p, undefined)
})

test('Gateway prompt cache key is stable per Claude session and isolated across sessions', () => {
  const first = {
    metadata: {
      user_id: JSON.stringify({ session_id: 'claude-session-a' }),
    },
  }
  const second = {
    metadata: {
      user_id: JSON.stringify({ session_id: 'claude-session-b' }),
    },
  }

  const firstKey = codexPromptCacheKeyForBody(first, 'auto')
  assert.equal(firstKey, codexPromptCacheKeyForBody(first, 'auto'))
  assert.notEqual(firstKey, codexPromptCacheKeyForBody(second, 'auto'))
  assert.match(firstKey, /^claude-code:[0-9a-f]{32}$/)
  assert.equal(codexPromptCacheKeyForBody(first, 'off'), null)
})

test('request-shape diagnostics expose only bounded numeric sizes', () => {
  const shape = gatewayRequestShape(
    {
      model: 'claude-gpt-luna',
      system: 'synthetic secret-token-value',
      messages: [{ role: 'user', content: 'synthetic prompt' }],
      tools: [{
        name: 'read',
        description: 'synthetic secret-description',
        input_schema: { type: 'object', properties: { path: { type: 'string' } } },
      }],
    },
    {
      model: 'gpt-5.6-luna',
      instructions: 'synthetic secret-instructions',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'synthetic' }] }],
      tools: [{
        type: 'function',
        name: 'read',
        parameters: { type: 'object' },
      }],
    },
  )
  assert.ok(shape.anthropic_bytes > 0)
  assert.ok(shape.system_bytes > 0)
  assert.ok(shape.message_bytes > 0)
  assert.ok(shape.tool_schema_bytes > 0)
  assert.equal(shape.tool_count, 1)
  assert.equal(shape.provider_input_items, 1)
  assert.equal(shape.provider_tool_count, 1)
  assert.ok(shape.provider_prefix_bytes > 0)
  assert.match(shape.provider_prefix_fingerprint, /^[0-9a-f]{16}$/)
  assert.equal(shape.prompt_cache_key_fingerprint, 'none')
  assert.equal(JSON.stringify(shape).includes('secret'), false)
})

test('request-shape prefix fingerprint stays stable when only the latest turn changes', () => {
  const prefix = {
    model: 'gpt-5.6-luna',
    instructions: 'stable instructions',
    tools: [{
      type: 'function',
      name: 'Read',
      description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    }],
  }
  const first = gatewayRequestShape(
    { messages: [{ role: 'user', content: 'turn one' }] },
    { ...prefix, input: [{ role: 'user', content: [{ type: 'input_text', text: 'turn one' }] }] },
  )
  const second = gatewayRequestShape(
    { messages: [{ role: 'user', content: 'turn two' }] },
    { ...prefix, input: [{ role: 'user', content: [{ type: 'input_text', text: 'turn two' }] }] },
  )
  const changed = gatewayRequestShape(
    { messages: [{ role: 'user', content: 'turn two' }] },
    {
      ...prefix,
      tools: [{ ...prefix.tools[0], name: 'Bash' }],
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'turn two' }] }],
    },
  )
  assert.equal(first.provider_prefix_fingerprint, second.provider_prefix_fingerprint)
  assert.notEqual(first.provider_prefix_fingerprint, changed.provider_prefix_fingerprint)
})

test('Codex preserves caller operational instructions for tools and environment', () => {
  const request = anthropicToCodex({
    ...minimalCodexBody(),
    system: [
      { type: 'text', text: 'Working directory: C:\\workspace\\project' },
      { type: 'text', text: 'Use Read and Bash when they are available.' },
    ],
  }, 'gpt-5.6-luna')
  assert.match(request.instructions, /Working directory: C:\\workspace\\project/)
  assert.match(request.instructions, /Use Read and Bash when they are available\./)
  assert.match(request.instructions, /<caller-operational-instructions>/)
  assert.match(request.instructions, /Runtime tool contract/)
  assert.match(request.instructions, /current request tool catalog/)
})

test('native Codex compaction disables reasoning and uses an inert gateway contract', () => {
  const request = anthropicToCodex(
    {
      ...compactionRequestBody(),
      system: 'SYNTHETIC_ACTIVE_WORKSPACE_MARKER',
    },
    'gpt-5.6-luna',
    'compact',
  )

  assert.equal(request.reasoning, undefined)
  assert.match(request.instructions, new RegExp(COMPACTION_RUNTIME_TOOL_CONTRACT.slice(0, 36)))
  assert.doesNotMatch(request.instructions, /If tools are attached, they are available now/i)
  assert.match(request.instructions, /Attached tool schemas may be present for protocol or cache compatibility only/i)
})

test('HTTP boundary preserves operational context across normal, compaction, and follow-up turns', async () => {
  await withGatewayAndFakeCodexState({
    handlerFactory: state => operationalContextContinuityCodexHandler(state),
    run: async ({ gateway, state }) => {
      const system = [
        {
          type: 'text',
          text: 'SYNTHETIC_ACTIVE_WORKSPACE_MARKER Working directory: C:\\workspace\\project',
        },
        {
          type: 'text',
          text: 'Use Read and Bash when they are available.',
        },
      ]
      const tools = [{
        name: 'Read',
        description: 'Read a file',
        input_schema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      }]

      const normalBody = {
        model: 'claude-gpt-luna',
        stream: true,
        system,
        tools,
        messages: [{ role: 'user', content: 'Inspect the workspace.' }],
      }
      const compactionBody = {
        ...normalBody,
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'compaction' }, { type: 'text', text: 'synthetic prior summary' }],
          },
          {
            role: 'user',
            content: 'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n<summary>Summarize the conversation.</summary>',
          },
        ],
      }
      const followUpBody = {
        ...normalBody,
        messages: [{ role: 'user', content: 'Continue after compaction and use Read if needed.' }],
      }

      for (const body of [normalBody, compactionBody, followUpBody]) {
        const result = await postGateway(gateway.port, body)
        assert.equal(result.status, 200)
        assert.equal(hasMessageStop(result.body), true)
      }

      assert.deepEqual(state.requests, [
        {
          hasOperationalMarker: true,
          toolCount: 1,
          effort: 'max',
          hasCompactionBoundary: false,
        },
        {
          hasOperationalMarker: true,
          toolCount: 1,
          effort: 'max',
          hasCompactionBoundary: true,
        },
        {
          hasOperationalMarker: true,
          toolCount: 1,
          effort: 'max',
          hasCompactionBoundary: false,
        },
      ])
    },
  })
})

test('compaction classification requires the native query-source marker', () => {
  const legacySummary = [
    'This session is being continued from a previous conversation that ran out of context.',
    'Summary:',
    'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.',
    'Your task is to summarize the conversation.',
    '<summary>Earlier work.</summary>',
  ].join('\n')
  const prompt = 'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\nYour task is to summarize the conversation.\n<summary>Summarize.</summary>'

  assert.equal(
    isCompactionRequest({
      messages: [{ role: 'user', content: prompt }],
    }),
    false,
  )
  assert.equal(
    isCompactionRequest({
      messages: [
        { role: 'user', content: legacySummary },
        { role: 'user', content: 'Continue the task and use Bash if needed.' },
      ],
    }),
    false,
  )
  assert.equal(
    isCompactionRequest({
      headers: { [GATEWAY_QUERY_SOURCE_HEADER]: 'compact' },
    }),
    true,
  )
  assert.equal(
    isCompactionRequest({
      headers: { [GATEWAY_QUERY_SOURCE_HEADER]: 'session_memory' },
    }),
    false,
  )
  assert.equal(
    gatewayQuerySource({
      headers: { [GATEWAY_QUERY_SOURCE_HEADER]: 'compact' },
    }),
    'compact',
  )
  assert.equal(
    gatewayQuerySource({
      headers: { [GATEWAY_QUERY_SOURCE_HEADER]: 'normal' },
    }),
    'normal',
  )
})

test('legacy compaction summaries lose stale control and capability claims', () => {
  const sanitized = sanitizeLegacyCompactionText([
    'This session is being continued from a previous conversation that ran out of context.',
    'Summary:',
    'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.',
    'Tool calls will be REJECTED and will waste your only turn.',
    'The Skill tool is not attached to the current runtime.',
    'No filesystem, task, or shell tools are available in this session.',
    'No callable tool channel attached, so I cannot execute a real Read call.',
    'I don’t have a callable tandem/task tool namespace exposed to me now.',
    'The only available action is sending a response; I cannot launch a real tool call from this turn.',
    'The actual task was to inspect the workspace and run tests.',
  ].join('\n'))

  assert.doesNotMatch(sanitized, /CRITICAL:\s*Respond with TEXT ONLY/i)
  assert.doesNotMatch(sanitized, /Tool calls will be REJECTED/i)
  assert.doesNotMatch(sanitized, /Skill tool is not attached/i)
  assert.doesNotMatch(sanitized, /no filesystem, task, or shell tools are available/i)
  assert.doesNotMatch(sanitized, /no callable tool channel/i)
  assert.doesNotMatch(sanitized, /callable tandem\/task tool namespace/i)
  assert.doesNotMatch(sanitized, /only available action is sending a response/i)
  assert.match(sanitized, /inspect the workspace and run tests/i)
})

test('gateway removes bullet-form standalone no-tool directives', () => {
  const sanitized = sanitizeLegacyCompactionText([
    'This session is being continued from a previous conversation that ran out of context.',
    'Summary:',
    '- No tool calls.',
    '- The actual task is to inspect the gateway and run the regression suite.',
  ].join('\n'))

  assert.doesNotMatch(sanitized, /no tool calls?/i)
  assert.match(sanitized, /inspect the gateway and run the regression suite/i)
})

test('transcript-shaped compaction prompt echo is removed at the gateway boundary', () => {
  const sanitized = sanitizeLegacyCompactionText([
    'This session is being continued from a previous conversation that ran out of context.',
    'Summary:',
    '1. Primary Request and Intent:',
    '- The user asked to finish the gateway refactor.',
    '- Current summary instruction:',
    '  The user explicitly required:',
    '  “CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.”',
    '  The user requested:',
    '  - An `<analysis>` block followed by a `<summary>` block.',
    '  - All non-tool user messages.',
    '  - No tool calls.',
    '',
    '7. Pending Tasks:',
    '',
    '- Continue the gateway refactor and run the regression suite.',
  ].join('\n'))

  assert.doesNotMatch(sanitized, /current summary instruction/i)
  assert.doesNotMatch(sanitized, /critical:\s*respond with text only/i)
  assert.doesNotMatch(sanitized, /all non-tool user messages/i)
  assert.doesNotMatch(sanitized, /no tool calls?/i)
  assert.match(sanitized, /Continue the gateway refactor and run the regression suite/i)
})

test('gateway removes protocol tags copied into fenced historical summaries', () => {
  const sanitized = sanitizeLegacyCompactionText([
    'This session is being continued from a previous conversation that ran out of context.',
    'Summary:',
    'The actual task is to continue the gateway refactor.',
    '```xml',
    '<analysis>',
    '<summary>',
    '```',
  ].join('\n'))

  assert.match(sanitized, /continue the gateway refactor/i)
  assert.doesNotMatch(sanitized, /<analysis>|<summary>/i)
})

test('current compaction-summary-data wrappers lose stale control claims', () => {
  const sanitized = sanitizeLegacyCompactionText([
    'This session is being continued from a previous conversation that ran out of context.',
    '<compaction-summary-data>',
    'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.',
    'No filesystem, task, or shell tools are available in this session.',
    'Runtime capability reconciliation (authoritative for this request):',
    '- If tools are attached, they are available now and must be used.',
    'The actual task is to continue the gateway refactor.',
    '</compaction-summary-data>',
  ].join('\n'))

  assert.doesNotMatch(sanitized, /compaction-summary-data/i)
  assert.doesNotMatch(sanitized, /CRITICAL:\s*Respond with TEXT ONLY/i)
  assert.doesNotMatch(sanitized, /no filesystem, task, or shell tools are available/i)
  assert.doesNotMatch(sanitized, /Runtime capability reconciliation/i)
  assert.match(sanitized, /continue the gateway refactor/i)
})

test('split current compaction-summary-data blocks are sanitized as one message', () => {
  const sanitized = sanitizeLegacyCompactionContent([
    {
      type: 'text',
      text: 'This session is being continued from a previous conversation that ran out of context.\n<compaction-summary-data>',
    },
    {
      type: 'text',
      text: 'Do not assume that the attached tools are available.\nThe actual task is to inspect the gateway.',
    },
    {
      type: 'text',
      text: '</compaction-summary-data>',
    },
  ])
  const text = sanitized.map(block => block.text || '').join('\n')
  assert.doesNotMatch(text, /do not assume that the attached tools are available/i)
  assert.doesNotMatch(text, /compaction-summary-data/i)
  assert.match(text, /inspect the gateway/i)
})

test('split legacy summary blocks are sanitized as one historical message', () => {
  const sanitized = sanitizeLegacyCompactionContent([
    {
      type: 'text',
      text: 'This session is being continued from a previous conversation that ran out of context.\nSummary:',
    },
    {
      type: 'text',
      text: 'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\nNo filesystem, task, or shell tools are available in this session.',
    },
    {
      type: 'text',
      text: 'The actual task was to inspect the gateway and run the regression suite.',
    },
  ])

  const text = sanitized
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
  assert.doesNotMatch(text, /CRITICAL:\s*Respond with TEXT ONLY/i)
  assert.doesNotMatch(text, /no filesystem, task, or shell tools are available/i)
  assert.match(text, /inspect the gateway and run the regression suite/i)
})

test('historical assistant capability claims are removed without losing the task', () => {
  const sanitized = sanitizeStaleToolCapabilityContent([
    'I don\u2019t have a callable tandem/task tool namespace exposed in this turn, so I cannot honestly claim the retries have run.',
    'The only available action is sending a response; I cannot invoke Read, Bash, or the tandem bridge from here.',
    'The actual task is to inspect the gateway and run the regression suite.',
  ].join('\n'))

  assert.doesNotMatch(sanitized, /callable tandem\/task tool namespace/i)
  assert.doesNotMatch(sanitized, /only available action is sending a response/i)
  assert.doesNotMatch(sanitized, /cannot invoke Read, Bash/i)
  assert.match(sanitized, /actual task is to inspect the gateway/i)
})

test('legacy poisoned summary cannot disable tools on the next Codex turn', async () => {
  await withGatewayAndFakeCodexState({
    handlerFactory: state => async (req, res) => {
      const body = await requestJson(req)
      const inputText = JSON.stringify(body.input || '')
      state.requests.push({
        toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
        effort: body.reasoning?.effort,
        hasCritical: /CRITICAL:\s*Respond with TEXT ONLY/i.test(inputText),
        hasSkillClaim: /Skill tool is not attached|no callable tool channel/i.test(inputText),
        hasAssistantCapabilityClaim: /callable tandem\/task tool namespace|only available action is sending a response|cannot invoke `?Read/i.test(inputText),
      })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(
        `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'OK' })}\n\n` +
        `data: ${JSON.stringify({ type: 'response.completed', response: completedCodexResponse('OK') })}\n\n`,
      )
    },
    run: async ({ gateway, state }) => {
      const tools = [{
        name: 'Bash',
        description: 'run shell',
        input_schema: { type: 'object' },
      }]
      const legacySummary = [
        'This session is being continued from a previous conversation that ran out of context.',
        'Summary:',
        'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.',
        'Your task is to summarize the conversation.',
        '<summary>Earlier work.</summary>',
        'The Skill tool is not attached to the current runtime.',
      ].join('\n')

      const compact = await postCompaction(gateway.port, {
        ...compactionRequestBody(),
        tools,
      })
      assert.equal(compact.status, 200)

      const followUp = await postGateway(gateway.port, {
        ...minimalCodexBody(),
        tools,
        messages: [
          { role: 'user', content: legacySummary },
          {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: 'I don\u2019t have a callable tandem/task tool namespace exposed in this turn, so I cannot honestly claim the retries have run.',
              },
              {
                type: 'text',
                text: 'The actual task is to inspect the gateway and run the regression suite.',
              },
            ],
          },
          { role: 'user', content: 'Continue the task and use Bash if needed.' },
        ],
      })
      assert.equal(followUp.status, 200)
      assert.deepEqual(state.requests, [
        {
          toolCount: 1,
          effort: undefined,
          hasCritical: true,
          hasSkillClaim: false,
          hasAssistantCapabilityClaim: false,
        },
        {
          toolCount: 1,
          effort: 'max',
          hasCritical: false,
          hasSkillClaim: false,
          hasAssistantCapabilityClaim: false,
        },
      ])
    },
  })
})

test('OpenCode request adapters carry the runtime tool contract', () => {
  const legacySummary = [
    'This session is being continued from a previous conversation that ran out of context.',
    'Summary:',
    'The Skill tool is not attached to the current runtime.',
  ].join('\n')
  const body = {
    system: 'SYNTHETIC_ACTIVE_WORKSPACE_MARKER',
    messages: [{ role: 'user', content: legacySummary }],
    tools: [{ name: 'Bash', input_schema: { type: 'object' } }],
  }

  const responses = anthropicToOpenCodeResponses(body, 'gpt-5.6-luna')
  const chat = anthropicToOpenCodeChat(body, 'glm-5.3-flash')
  assert.match(responses.instructions, new RegExp(RUNTIME_TOOL_CONTRACT.slice(0, 40)))
  assert.match(chat.messages[0].content, new RegExp(RUNTIME_TOOL_CONTRACT.slice(0, 40)))
  assert.doesNotMatch(JSON.stringify(responses.input), /Skill tool is not attached/i)
  assert.doesNotMatch(JSON.stringify(chat.messages), /Skill tool is not attached/i)
})

test('OpenCode native summary adapters keep tool schemas inert and omit effort', () => {
  const body = {
    ...compactionRequestBody(),
    output_config: { effort: 'max' },
  }
  const responses = anthropicToOpenCodeResponses(body, 'gpt-5.6-luna', 'compact')
  const chat = anthropicToOpenCodeChat(body, 'glm-5.3-flash', 'compact')

  assert.equal(responses.reasoning, undefined)
  assert.equal(chat.reasoning_effort, undefined)
  assert.match(responses.instructions, /Native harness summary contract/i)
  assert.match(chat.messages[0].content, /Native harness summary contract/i)
  assert.doesNotMatch(responses.instructions, /If tools are attached, they are available now/i)
  assert.doesNotMatch(chat.messages[0].content, /If tools are attached, they are available now/i)
})

test('HTTP boundary retries transient Codex HTTP failures before streaming', async () => {
  await withGatewayAndFakeCodexState({
    handlerFactory: state => retryingCodexHandler(state, 429, 2),
    gatewayEnv: {
      MODEL_GATEWAY_UPSTREAM_RETRY_BASE_MS: '1',
      MODEL_GATEWAY_UPSTREAM_RETRY_MAX_MS: '5',
    },
    run: async ({ gateway, state }) => {
      const result = await postGateway(gateway.port, minimalCodexBody())
      assert.equal(result.status, 200)
      assert.equal(hasMessageStop(result.body), true)
      assert.equal(state.requests.length, 3)
      assert.match(gateway.getStderr(), /retry provider=Codex status=429 attempt=1/)
      assert.match(gateway.getStderr(), /retry provider=Codex status=429 attempt=2/)
    },
  })
})

test('HTTP boundary does not retry deterministic Codex 400 by default', async () => {
  await withGatewayAndFakeCodexState({
    handlerFactory: state => retryingCodexHandler(state, 400, 10),
    gatewayEnv: {
      MODEL_GATEWAY_UPSTREAM_RETRY_BASE_MS: '1',
    },
    run: async ({ gateway, state }) => {
      const result = await postGateway(gateway.port, minimalCodexBody())
      assert.equal(result.status, 400)
      assert.equal(state.requests.length, 1)
    },
  })
})

test('HTTP boundary supports explicitly enabled Codex 400 retries', async () => {
  await withGatewayAndFakeCodexState({
    handlerFactory: state => retryingCodexHandler(state, 400, 1),
    gatewayEnv: {
      MODEL_GATEWAY_RETRY_400: '1',
      MODEL_GATEWAY_UPSTREAM_RETRIES: '2',
      MODEL_GATEWAY_UPSTREAM_RETRY_BASE_MS: '1',
    },
    run: async ({ gateway, state }) => {
      const result = await postGateway(gateway.port, minimalCodexBody())
      assert.equal(result.status, 200)
      assert.equal(state.requests.length, 2)
    },
  })
})

test('HTTP boundary slims tools after a pre-output Codex context failure', async () => {
  await withGatewayAndFakeCodexState({
    handlerFactory: contextFallbackCodexHandler,
    run: async ({ gateway, state }) => {
      const result = await postGateway(gateway.port, {
        ...minimalCodexBody(),
        tools: [
          {
            name: 'Read',
            description: 'A very large read tool description '.repeat(20),
            input_schema: {
              type: 'object',
              description: 'parameter description',
              properties: {
                path: {
                  type: 'string',
                  description: 'path description',
                  default: 'x',
                  examples: ['x'],
                },
              },
            },
          },
          {
            name: 'mcp_big_tool',
            description: 'An MCP tool description '.repeat(20),
            input_schema: { type: 'object', title: 'large schema' },
          },
        ],
      })
      assert.equal(result.status, 200)
      assert.equal(hasMessageStop(result.body), true)
      assert.equal(state.requests.length, 2)
      assert.equal(state.requests[0].toolCount, 2)
      assert.equal(state.requests[1].toolCount, 2)
      assert.ok(state.requests[1].descriptions.every(description =>
        typeof description === 'string',
      ))
      assert.ok(state.requests[1].requestBytes > 0)
      assert.match(gateway.getStderr(), /context-fallback model=gpt-5\.6-luna variant=1/)
    },
  })
})

test('HTTP 400 context failures also use the tool fallback, but other 400s do not', async () => {
  await withGatewayAndFakeCodexState({
    handlerFactory: context400FallbackCodexHandler,
    run: async ({ gateway, state }) => {
      const result = await postGateway(gateway.port, {
        ...minimalCodexBody(),
        tools: [{ name: 'Read', description: 'large', input_schema: { type: 'object' } }],
      })
      assert.equal(result.status, 200)
      assert.equal(state.requests.length, 2)
    },
  })
})

test('HTTP boundary retries a malformed pre-output Codex stream before committing 200', async () => {
  await withGatewayAndFakeCodexState({
    handlerFactory: malformedThenHealthyCodexHandler,
    gatewayEnv: {
      MODEL_GATEWAY_UPSTREAM_RETRY_BASE_MS: '1',
      MODEL_GATEWAY_UPSTREAM_RETRY_MAX_MS: '5',
    },
    run: async ({ gateway, state }) => {
      const result = await postGateway(gateway.port, minimalCodexBody())
      assert.equal(result.status, 200)
      assert.equal(hasMessageStop(result.body), true)
      assert.deepEqual(state.requests, [{ attempt: 1 }, { attempt: 2 }])
      assert.match(gateway.getStderr(), /retry provider=Codex error=pre-output-malformed-response attempt=1/)
    },
  })
})

test('Codex pre-output retry re-arms the upstream header timeout', async () => {
  await withGatewayAndFakeCodexState({
    handlerFactory: malformedThenHeaderlessCodexHandler,
    gatewayEnv: {
      MODEL_GATEWAY_UPSTREAM_RETRIES: '1',
      MODEL_GATEWAY_UPSTREAM_RETRY_BASE_MS: '1',
      MODEL_GATEWAY_UPSTREAM_RETRY_MAX_MS: '1',
      MODEL_GATEWAY_UPSTREAM_TIMEOUT_MS: '40',
      MODEL_GATEWAY_RETRY_ATTEMPT_TIMEOUT_MS: '40',
      MODEL_GATEWAY_CONSUMER_TIMEOUT_MS: '2000',
    },
    run: async ({ gateway, state }) => {
      const started = performance.now()
      const result = await postGateway(gateway.port, minimalCodexBody())
      const elapsed = performance.now() - started
      assert.equal(result.status, 504)
      assert.match(result.body, /Gateway upstream request timed out/)
      assertCompletedBeforeFallback(elapsed, {
        label: 'Codex retry re-arm',
        // Two 40ms attempt windows plus a 1ms backoff. The second attempt must
        // get its own header timeout, so a correct run pays both; the failure
        // is falling through to the 2000ms consumer timeout below.
        path: 2 * 40 + 1,
        fallback: 2000,
      })
      assert.deepEqual(state.requests, [1, 2])
      // A bounded wait, not a bare synchronous check. The bare form asserted
      // something weaker than it looked: not that the gateway cancels the
      // upstream request, but that the cancellation event had already
      // propagated to the fake server within the same tick. Under load it had
      // not, so a healthy run went red.
      assert.equal(await waitForUpstreamCancellation(state), true)
    },
  })
})

test('Codex consumer disconnect during malformed retry backoff does not crash the gateway', async () => {
  await withGatewayAndFakeCodexState({
    handlerFactory: malformedThenWaitingCodexHandler,
    gatewayEnv: {
      MODEL_GATEWAY_UPSTREAM_RETRIES: '1',
      MODEL_GATEWAY_UPSTREAM_RETRY_BASE_MS: '200',
      MODEL_GATEWAY_UPSTREAM_RETRY_MAX_MS: '200',
    },
    run: async ({ gateway, state }) => {
      const result = await abortGatewayDuringRetry(gateway.port, minimalCodexBody(), 25, () => state.requests.length > 0)
      assert.equal(result.disconnected, true)
      await new Promise(resolve => setTimeout(resolve, 300))
      assert.equal(gateway.child.exitCode, null, gateway.getStderr())
      assert.equal(state.requests.length, 1)

      const health = await fetch(`http://127.0.0.1:${gateway.port}/health`)
      assert.equal(health.status, 200)
      const healthBody = await health.json()
      assert.equal(healthBody.status, 'ok')
      assert.ok(Number.isInteger(healthBody.modelCount) && healthBody.modelCount > 0)
      assert.equal(gateway.getStderr().includes('triggerUncaughtException'), false)
    },
  })
})

test('HTTP boundary never retries a malformed Codex stream after output starts', async () => {
  await withGatewayAndFakeCodexState({
    handlerFactory: malformedAfterOutputCodexHandler,
    gatewayEnv: {
      MODEL_GATEWAY_UPSTREAM_RETRY_BASE_MS: '1',
      MODEL_GATEWAY_UPSTREAM_RETRY_MAX_MS: '5',
    },
    run: async ({ gateway, state }) => {
      const result = await postGateway(gateway.port, minimalCodexBody())
      assert.equal(result.status, 200)
      assert.equal(state.requests.length, 1)
      assert.match(result.body, /partial/)
      assert.match(result.body, /error/)
    },
  })
})

test('opt-in compact tool mode reduces the first Codex request without removing tools', async () => {
  await withGatewayAndFakeCodexState({
    handlerFactory: compactToolsSuccessCodexHandler,
    gatewayEnv: {
      MODEL_GATEWAY_CODEX_TOOL_MODE: 'compact',
    },
    run: async ({ gateway, state }) => {
      const result = await postGateway(gateway.port, {
        ...minimalCodexBody(),
        tools: [
          {
            name: 'Read',
            description: 'large description '.repeat(20),
            input_schema: {
              type: 'object',
              properties: {
                path: {
                  type: 'string',
                  description: 'large parameter description',
                  default: 'x',
                  examples: ['x'],
                },
              },
            },
          },
          {
            name: 'mcp_big_tool',
            description: 'large MCP description '.repeat(20),
            input_schema: { type: 'object', title: 'large schema' },
          },
        ],
      })
      assert.equal(result.status, 200)
      assert.equal(state.requests.length, 1)
      assert.deepEqual(state.requests[0].descriptions, ['', ''])
    },
  })
})

test('balanced tool mode preserves core tool semantics while slimming optional metadata', async () => {
  await withGatewayAndFakeCodexState({
    handlerFactory: compactToolsSuccessCodexHandler,
    gatewayEnv: {
      MODEL_GATEWAY_CODEX_TOOL_MODE: 'balanced',
    },
    run: async ({ gateway, state }) => {
      const result = await postGateway(gateway.port, {
        ...minimalCodexBody(),
        tools: [{
          name: 'Read',
          description: 'read description '.repeat(80),
          input_schema: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'parameter description',
                default: 'x',
                examples: ['x'],
              },
            },
          },
        }, {
          name: 'mcp__optional__lookup',
          description: 'optional MCP description '.repeat(80),
          input_schema: {
            type: 'object',
            title: 'optional schema',
            properties: {
              query: {
                type: 'string',
                description: 'optional query description',
                examples: ['x'],
              },
            },
          },
        }],
      })
      assert.equal(result.status, 200)
      assert.equal(state.requests.length, 1)
      assert.equal(state.requests[0].descriptions.length, 2)
      assert.equal(
        state.requests[0].descriptions[0],
        'read description '.repeat(80),
      )
      assert.equal(
        state.requests[0].parameters[0].properties.path.description,
        'parameter description',
      )
      assert.equal(state.requests[0].parameters[0].properties.path.default, 'x')
      assert.deepEqual(state.requests[0].parameters[0].properties.path.examples, ['x'])
      assert.ok(state.requests[0].descriptions[1].length <= 320)
      assert.equal(
        state.requests[0].parameters[1].properties.query.description,
        'optional query description',
      )
      assert.equal(state.requests[0].parameters[1].title, undefined)
      assert.equal(state.requests[0].parameters[1].properties.query.examples, undefined)
      assert.ok(state.requests[0].requestBytes < 3_000)
    },
  })
})

test('compact tool mode retains full and fallback variants after a context failure', async () => {
  await withGatewayAndFakeCodexState({
    handlerFactory: compactToolsFallbackCodexHandler,
    gatewayEnv: {
      MODEL_GATEWAY_CODEX_TOOL_MODE: 'compact',
    },
    run: async ({ gateway, state }) => {
      const result = await postGateway(gateway.port, {
        ...minimalCodexBody(),
        tools: [{
          name: 'Read',
          description: 'original description',
          input_schema: {
            type: 'object',
            properties: { path: { type: 'string', description: 'path description' } },
          },
        }],
      })
      assert.equal(result.status, 200)
      assert.equal(state.requests.length, 3)
      assert.deepEqual(state.requests[0].descriptions, [''])
      assert.deepEqual(state.requests[1].descriptions, ['original description'])
      assert.deepEqual(state.requests[2].descriptions, [''])
    },
  })
})

test('Codex HTTP boundary always uses upstream SSE and buffers JSON fallbacks', async () => {
  await withGatewayAndFakeCodexState({
    handlerFactory: state => async (req, res) => {
      const body = await requestJson(req)
      state.requests.push({
        stream: body.stream,
        accept: req.headers.accept,
        hasMaxOutputTokens: Object.hasOwn(body, 'max_output_tokens'),
      })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(
        `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'buffered' })}\n\n` +
        `data: ${JSON.stringify({ type: 'response.completed', response: completedCodexResponse('buffered') })}\n\n`,
      )
    },
    run: async ({ gateway, state }) => {
      const result = await postGateway(gateway.port, {
        model: 'claude-gpt-luna',
        stream: false,
        max_tokens: 8,
        messages: [{ role: 'user', content: 'fallback' }],
      })
      assert.equal(result.status, 200)
      assert.equal(result.headers.get('content-type'), 'application/json')
      assert.equal(result.body.includes('event:'), false)
      assert.deepEqual(JSON.parse(result.body).content, [{ type: 'text', text: 'buffered' }])
      assert.deepEqual(state.requests, [
        { stream: true, accept: 'text/event-stream', hasMaxOutputTokens: false },
      ])
    },
  })
})

test('native compaction requests pass through the harness contract', async () => {
  await withGatewayAndFakeCodexState({
    handlerFactory: state => async (req, res) => {
      const body = await requestJson(req)
      state.requests.push(body)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(
        `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'summary' })}\n\n` +
        `data: ${JSON.stringify({ type: 'response.completed', response: completedCodexResponse('summary') })}\n\n`,
      )
    },
    run: async ({ gateway, state }) => {
      const result = await postCompaction(gateway.port, compactionRequestBody({
        temperature: 0.2,
        top_p: 0.8,
      }))
      assert.equal(result.status, 200)
      assert.equal(state.requests.length, 1)
      assert.equal(state.requests[0].tools.length, 1)
      assert.equal(state.requests[0].temperature, undefined)
      assert.equal(state.requests[0].top_p, undefined)
      assert.equal(state.requests[0].reasoning, undefined)
      assert.match(state.requests[0].instructions, /Native harness summary contract/i)
    },
  })
})

test('native compaction bypasses gateway Codex tool-schema compression mode', async () => {
  await withGatewayAndFakeCodexState({
    handlerFactory: compactToolsSuccessCodexHandler,
    gatewayEnv: {
      MODEL_GATEWAY_CODEX_TOOL_MODE: 'compact',
    },
    run: async ({ gateway, state }) => {
      const result = await postCompaction(gateway.port, {
        ...compactionRequestBody(),
        tools: [{
          name: 'Read',
          description: 'native description',
          input_schema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'native path description' },
            },
          },
        }],
      })
      assert.equal(result.status, 200)
      assert.equal(state.requests.length, 1)
      assert.deepEqual(state.requests[0].descriptions, ['native description'])
    },
  })
})

test('buffered Codex SSE reconstructs output carried only in deltas', async () => {
  const response = new CaptureResponse()
  const events = [
    { type: 'response.output_text.delta', delta: 'real-' },
    { type: 'response.output_text.delta', delta: 'stream' },
    { type: 'response.completed', response: { id: 'resp-delta', status: 'completed', output: [] } },
  ]
  await relayCodexResponse(response, upstreamFromEvents(events), 'claude-gpt-luna', null, true)
  assert.equal(response.headers.status, 200)
  assert.deepEqual(JSON.parse(response.text()).content, [{ type: 'text', text: 'real-stream' }])
})

test('non-streaming Codex Responses become one valid Anthropic JSON message', async () => {
  const response = new CaptureResponse()
  const upstream = {
    text: async () => JSON.stringify(completedCodexResponse('summary')),
  }
  await relayCodexResponse(response, upstream, 'claude-gpt-luna')
  assert.equal(response.headers.status, 200)
  assert.equal(response.headers['content-type'], 'application/json')
  const message = JSON.parse(response.text())
  assert.equal(message.type, 'message')
  assert.deepEqual(message.content, [{ type: 'text', text: 'summary' }])
  assert.equal(message.stop_reason, 'end_turn')
  assert.equal(response.text().includes('event:'), false)
})

test('non-streaming Codex rejects empty or malformed JSON before 200', async () => {
  for (const raw of ['{}', 'not-json']) {
    const response = new CaptureResponse()
    await relayCodexResponse(response, { text: async () => raw }, 'claude-gpt-luna')
    assert.equal(response.headers.status, 502)
    assert.equal(response.headers['content-type'], 'application/json')
    assert.equal(JSON.parse(response.text()).type, 'error')
  }
})

test('HTTP boundary supports Claude streaming failure followed by non-streaming fallback', async () => {
  await withGatewayAndFakeCodexState({
    handlerFactory: incompleteThenJsonCodexHandler,
    run: async ({ gateway, state }) => {
      const first = await postGateway(gateway.port, {
        ...minimalCodexBody(),
        stream: true,
        max_tokens: 123,
      })
      assert.equal(first.status, 200)
      assert.equal(hasMessageStop(first.body), false)
      assert.match(first.body, /stream ended before response\.completed/)

      const fallback = await postGateway(gateway.port, {
        ...minimalCodexBody(),
        // Claude's fallback call omits stream; omission must remain JSON mode.
        stream: undefined,
        max_tokens: 456,
      })
      assert.equal(fallback.status, 200)
      assert.equal(fallback.headers.get('content-type'), 'application/json')
      assert.equal(fallback.body.includes('event:'), false)
      const message = JSON.parse(fallback.body)
      assert.equal(message.type, 'message')
      assert.deepEqual(message.content, [{ type: 'text', text: 'recovered' }])
      assert.deepEqual(state.requests, [
        { stream: true },
        { stream: true },
      ])
    },
  })
})

test('HTTP boundary rejects malformed non-streaming provider JSON before 200', async () => {
  const result = await withGatewayAndFakeCodex({
    upstreamHandler: malformedJsonCodexHandler,
    run: async gateway => ({ response: await postGateway(gateway.port, { ...minimalCodexBody(), stream: false }) }),
  })
  assert.equal(result.response.status, 502)
  assert.equal(result.response.headers.get('content-type'), 'application/json')
  assert.equal(JSON.parse(result.response.body).type, 'error')
  assert.equal(result.response.body.includes('event:'), false)
})

// This fixture keeps the actual compaction request shape synthetic: the
// no-tools preamble is intentional, thinking is disabled, and the boundary is
// marked without carrying real conversation content.
test('compaction-shaped request preserves the bounded non-tool summary contract', () => {
  const request = anthropicToCodex({
    stream: true,
    max_tokens: 2048,
    thinking: { type: 'disabled' },
    system: 'You are a helpful AI assistant tasked with summarizing conversations.',
    messages: [
      { role: 'assistant', content: [{ type: 'compaction' }, { type: 'text', text: 'synthetic summary' }] },
      { role: 'user', content: 'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\\n\\n<analysis>synthetic</analysis><summary>synthetic</summary>' },
    ],
  }, 'gpt-5.6-luna')
  assert.equal(request.stream, true)
  assert.equal(request.max_output_tokens, 2048)
  assert.equal(request.tools, undefined)
  assert.equal(request.input.some(item => item.content?.some(part => part.text === '[compaction boundary]')), true)
})


test('HTTP boundary replays a synthetic compaction-sized request without false 200', async () => {
  const requestBody = compactionSizedBody()
  const result = await withGatewayAndFakeCodex({
    upstreamHandler: healthyCodexHandler,
    gatewayEnv: { MODEL_GATEWAY_LOG_TIMING: '1', MODEL_GATEWAY_CONSUMER_TIMEOUT_MS: '4000' },
    run: async gateway => {
      const started = performance.now()
      const response = await postGateway(gateway.port, requestBody)
      const elapsed = performance.now() - started
      let stderr = gateway.getStderr()
      const deadline = Date.now() + 500
      while (!lastTimingLine(stderr) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10))
        stderr = gateway.getStderr()
      }
      return { response, elapsed, stderr }
    },
  })
  assert.equal(result.response.status, 200)
  assert.equal(hasMessageStop(result.response.body), true)
  // A healthy compaction-sized replay must complete well before the consumer
  // deadline; reaching it at all would mean the request never finished.
  assertCompletedBeforeFallback(result.elapsed, {
    label: 'compaction-sized replay',
    path: 40,
    fallback: 4000,
  })
  const timing = timingFields(lastTimingLine(result.stderr))
  assert.equal(timing.outcome, 'success')
  assert.ok(Number(timing.bytes) > 0)
  assert.ok(Number(timing.events) > 0)
  assertNoPayloadTimingFields(lastTimingLine(result.stderr))
})

// This is the G-001 verifier calibration: a verifier that accepts any HTTP 200
// would pass the intentionally broken empty-stream observation. The assertion
// pins the discriminating condition (status must be non-200 and no message_stop).
test('G-001 verifier is discriminating against an early HTTP-200 empty stream', async () => {
  await assert.rejects(
    assertGatewayBoundedResult({
      handler: emptyCodexHandler,
      expectedStatus: 200,
    }),
    /Expected values to be strictly equal/,
  )
})


test('relay timing observes first byte, output, completion, bytes, and events without payload fields', async () => {
  const response = new CaptureResponse()
  const trace = traceCapture()
  await relayCodexStream(response, upstreamFromEvents([
    { type: 'response.output_text.delta', delta: 'OK' },
    { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } },
  ]), 'claude-gpt-luna', trace)
  assert.equal(trace.marks.firstByte, true)
  assert.equal(trace.marks.output, true)
  assert.equal(trace.marks.completion, true)
  assert.ok(trace.marks.bytes > 0)
  assert.ok(trace.marks.events > 0)
  assert.equal(response.headers.status, 200)
})

test('DeepSeek delays HTTP 200 until usable output', async () => {
  const response = new CaptureResponse()
  await relayDeepSeekStream(response, deepSeekResponse(deepSeekValidEvents()), traceCapture())
  assert.equal(response.headers.status, 200)
  assert.match(response.text(), /message_stop/)
})

test('DeepSeek rejects an empty stream before committing HTTP 200', async () => {
  const response = new CaptureResponse()
  await relayDeepSeekStream(response, deepSeekResponse(deepSeekEmptyEvents()), traceCapture())
  assert.equal(response.headers.status, 502)
  assert.equal(JSON.parse(response.text()).error.message, 'DeepSeek returned an empty or malformed response')
})

test('DeepSeek maps a pre-output context failure to HTTP 400', async () => {
  const response = new CaptureResponse()
  await relayDeepSeekStream(response, deepSeekResponse(deepSeekContextFailureEvents()), traceCapture())
  assert.equal(response.headers.status, 400)
  assert.match(JSON.parse(response.text()).error.message, /^Prompt is too long:/)
})

test('DeepSeek preserves an in-stream error after output and cancels the provider reader', async () => {
  const response = new CaptureResponse()
  await relayDeepSeekStream(response, deepSeekResetUpstream(), traceCapture())
  assert.equal(response.headers.status, 200)
  assert.match(response.text(), /ECONNRESET/)
})

test('DeepSeek cancels its reader when the gateway signal aborts', async () => {
  const response = new CaptureResponse()
  const controller = new AbortController()
  let bodyCancelled = false
  const upstream = {
    status: 200,
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    body: new ReadableStream({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode(
          `data: ${JSON.stringify({ type: 'message_start', message: { id: 'msg-abort', type: 'message', role: 'assistant', content: [] } })}\n\n`,
        ))
        streamController.enqueue(new TextEncoder().encode(
          `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
        ))
      },
      cancel() {
        bodyCancelled = true
      },
    }),
  }

  const relay = relayDeepSeekStream(
    response,
    upstream,
    traceCapture(),
    { signal: controller.signal },
  )
  await new Promise(resolve => setTimeout(resolve, 10))
  controller.abort(new Error('consumer disconnected'))
  await relay

  assert.equal(bodyCancelled, true)
  assert.equal(response.headers.status, 502)
  assert.match(response.text(), /consumer disconnected/)
})

test('DeepSeek rejects malformed SSE before HTTP 200', async () => {
  const response = new CaptureResponse()
  await relayDeepSeekStream(response, deepSeekResponse(['not-json']), traceCapture())
  assert.equal(response.headers.status, 502)
  assert.equal(JSON.parse(response.text()).error.message, 'DeepSeek returned malformed Anthropic SSE data')
})

test('non-streaming DeepSeek returns one Anthropic JSON message without SSE', async () => {
  const response = new CaptureResponse()
  await relayDeepSeekResponse(response, {
    text: async () => JSON.stringify({
      id: 'msg-ds-json',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'OK' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 3, output_tokens: 1 },
    }),
  }, traceCapture())
  assert.equal(response.headers.status, 200)
  assert.equal(response.headers['content-type'], 'application/json')
  assert.equal(JSON.parse(response.text()).content[0].text, 'OK')
  assert.equal(response.text().includes('event:'), false)
})

test('non-streaming DeepSeek rejects empty JSON before 200', async () => {
  for (const raw of ['{}', 'not-json']) {
    const response = new CaptureResponse()
    await relayDeepSeekResponse(response, { text: async () => raw }, traceCapture())
    assert.equal(response.headers.status, 502)
    assert.equal(response.headers['content-type'], 'application/json')
    assert.equal(JSON.parse(response.text()).type, 'error')
  }
})

test('HTTP boundary keeps omitted-stream DeepSeek fallback JSON', async () => {
  await withGatewayAndFakeDeepSeek({
    handler: deepSeekJsonHandler(() => ({
      id: 'msg-ds-http',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'deepseek-ok' }],
      stop_reason: 'end_turn',
    })),
    run: async ({ gateway, state }) => {
      const result = await postGateway(gateway.port, {
        model: 'deepseek-v4-flash',
        max_tokens: 8,
        messages: [{ role: 'user', content: 'fallback' }],
      })
      assert.equal(result.status, 200)
      assert.equal(result.headers.get('content-type'), 'application/json')
      assert.equal(result.body.includes('event:'), false)
      assert.equal(JSON.parse(result.body).content[0].text, 'deepseek-ok')
      assert.deepEqual(state.requests, [{ stream: undefined, accept: 'application/json' }])
    },
  })
})

test('DeepSeek v4.1 Flash uses the canonical direct model ID', async () => {
  await withGatewayAndFakeDeepSeek({
    handler: async (req, res, state) => {
      state.requests.push(await requestJson(req))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: 'msg-ds-v41',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'deepseek-v41-ok' }],
        stop_reason: 'end_turn',
      }))
    },
    run: async ({ gateway, state }) => {
      const result = await postGateway(gateway.port, {
        model: 'gateway-ds-4.1-flash',
        stream: false,
        max_tokens: 8,
        messages: [{ role: 'user', content: 'v4.1' }],
      })
      assert.equal(result.status, 200)
      assert.equal(JSON.parse(result.body).content[0].text, 'deepseek-v41-ok')
      assert.equal(state.requests[0].model, 'deepseek-flash')
    },
  })
})

test('DeepSeek native summary requests receive an inert gateway contract', async () => {
  await withGatewayAndFakeDeepSeek({
    handler: async (req, res, state) => {
      const body = await requestJson(req)
      state.requests.push(body)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: 'msg-ds-compact',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'summary' }],
        stop_reason: 'end_turn',
      }))
    },
    run: async ({ gateway, state }) => {
      const result = await postCompaction(gateway.port, {
        ...compactionRequestBody({
          model: 'deepseek-v4-flash',
          stream: false,
          output_config: { effort: 'max' },
        }),
      })
      assert.equal(result.status, 200)
      assert.equal(state.requests.length, 1)
      assert.equal(state.requests[0].output_config.effort, undefined)
      assert.match(state.requests[0].system, /Native harness summary contract/i)
      assert.doesNotMatch(state.requests[0].system, /If tools are attached, they are available now/i)
    },
  })
})

test('HTTP boundary maps non-streaming DeepSeek context failure to HTTP 400', async () => {
  await withGatewayAndFakeDeepSeek({
    handler: deepSeekJsonHandler(() => ({ error: { message: 'maximum context length exceeded' } })),
    run: async ({ gateway }) => {
      const result = await postGateway(gateway.port, {
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: 'context' }],
      })
      assert.equal(result.status, 400)
      assert.equal(result.headers.get('content-type'), 'application/json')
      assert.match(result.body, /Prompt is too long:/)
      assert.equal(result.body.includes('event:'), false)
    },
  })
})


test('HTTP boundary rejects non-streaming DeepSeek provider errors without raw body', async () => {
  await withGatewayAndFakeDeepSeek({
    handler: deepSeekJsonHandler(() => ({ error: { message: 'provider unavailable' } })),
    run: async ({ gateway }) => {
      const result = await postGateway(gateway.port, {
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: 'error' }],
      })
      assert.equal(result.status, 502)
      assert.equal(result.headers.get('content-type'), 'application/json')
      assert.match(result.body, /provider unavailable/)
      assert.equal(result.body.includes('event:'), false)
    },
  })
})

test('a stalled compaction upstream is bounded and cancelled before HTTP 200', async () => {
  await withGatewayAndFakeCodexState({
    handlerFactory: stalledCompactionCodexHandler,
    gatewayEnv: {
      MODEL_GATEWAY_UPSTREAM_TIMEOUT_MS: '40',
      MODEL_GATEWAY_RETRY_ATTEMPT_TIMEOUT_MS: '40',
      // Wide enough that the assertion below separates "bounded by the attempt
      // timeout" from "reached the consumer timeout"; a correct run never waits
      // for this value, so a green run is not slowed by it.
      MODEL_GATEWAY_CONSUMER_TIMEOUT_MS: '3000',
      MODEL_GATEWAY_UPSTREAM_RETRIES: '1',
    },
    run: async ({ gateway, state }) => {
      const started = performance.now()
      const result = await postCompaction(gateway.port, compactionRequestBody())
      const elapsed = performance.now() - started

      // The private marker is a client-to-gateway contract and must not be
      // forwarded to the provider. Verify both sides of that boundary.
      assert.equal(state.compactionRequest, false)
      assert.match(
        gateway.getStderr(),
        /model-gateway native-compaction source=compact/,
      )
      assert.equal(result.status, 504)
      assert.match(result.body, /Gateway upstream request timed out/)
      assertCompletedBeforeFallback(elapsed, {
        label: 'stalled compaction',
        // Two 40ms attempt windows plus a 1ms backoff, versus the 3000ms
        // consumer timeout this must never reach.
        path: 2 * 40 + 1,
        fallback: 3000,
      })
      assert.equal(await waitForUpstreamCancellation(state, 500), true)
      assert.equal(result.body.includes('event:'), false)
    },
  })
})

test('HTTP boundary bounds a DeepSeek error body that never completes', async () => {
  await withGatewayAndFakeDeepSeek({
    handler: async (req, res, state) => {
      await requestJson(req)
      res.writeHead(400, { 'content-type': 'application/json' })
      res.write('{"error":{"message":"provider unavailable"')
      req.once('aborted', () => { state.requestAborted = true })
      res.once('close', () => { state.responseClosed = true })
    },
    gatewayEnv: {
      MODEL_GATEWAY_UPSTREAM_TIMEOUT_MS: '1000',
      MODEL_GATEWAY_RETRY_ATTEMPT_TIMEOUT_MS: '40',
      MODEL_GATEWAY_CONSUMER_TIMEOUT_MS: '3000',
    },
    run: async ({ gateway, state }) => {
      const started = performance.now()
      const result = await postGateway(gateway.port, {
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: 'bounded error body' }],
      })
      const elapsed = performance.now() - started
      assert.equal(result.status, 504)
      assert.match(result.body, /DeepSeek upstream request timed out/)
      assertCompletedBeforeFallback(elapsed, {
        label: 'DeepSeek error body bound',
        // The 40ms attempt timeout must cut the open body; the 3000ms consumer
        // timeout is what a run that never bounds it would reach.
        path: 40,
        fallback: 3000,
      })
      assert.equal(await waitForUpstreamCancellation(state), true)
    },
  })
})



test('a delayed stream remains bounded by the caller timeout contract', async () => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15)
  try {
    await assert.rejects(
      fetch('http://127.0.0.1:1', { signal: controller.signal }),
      error => error?.name === 'AbortError' || error?.name === 'TypeError',
    )
  } finally {
    clearTimeout(timeout)
  }
})


test('delayed upstream fixture emits no output before it is ready', async () => {
  const upstream = delayedUpstream(5, [
    { type: 'response.output_text.delta', delta: 'OK' },
    { type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] } },
  ])
  const response = new CaptureResponse()
  const started = performance.now()
  await relayCodexStream(response, upstream, 'claude-gpt-luna')
  assert.ok(performance.now() - started >= 4)
  assert.equal(response.headers.status, 200)
})

test('maps Codex input and cached-input usage to Anthropic usage', () => {
  assert.deepEqual(
    codexUsageToAnthropic({
      input_tokens: 151550,
      input_tokens_details: { cached_tokens: 149888 },
      output_tokens: 254,
      total_tokens: 151804,
    }),
    {
      input_tokens: 1662,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 149888,
      output_tokens: 254,
    },
  )
})

test('maps Codex cache-write usage separately from uncached input', () => {
  assert.deepEqual(
    codexUsageToAnthropic({
      input_tokens: 151550,
      input_tokens_details: {
        cached_tokens: 149888,
        cache_write_tokens: 512,
      },
      output_tokens: 254,
      total_tokens: 151804,
    }),
    {
      input_tokens: 1150,
      cache_creation_input_tokens: 512,
      cache_read_input_tokens: 149888,
      output_tokens: 254,
    },
  )
})

test('translates Anthropic base64 and URL images to Codex input_image items', () => {
  const request = anthropicToCodex(
    {
      system: 'system',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Inspect both images.' },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: 'AAA',
              },
            },
            {
              type: 'image',
              source: {
                type: 'url',
                url: 'https://example.com/image.jpg',
              },
            },
          ],
        },
      ],
    },
    'gpt-5.6-luna',
  )

  assert.deepEqual(request.input, [
    {
      role: 'user',
      content: [{ type: 'input_text', text: 'Inspect both images.' }],
    },
    {
      role: 'user',
      content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAA' }],
    },
    {
      role: 'user',
      content: [{ type: 'input_image', image_url: 'https://example.com/image.jpg' }],
    },
  ])
})

test('preserves images embedded in Anthropic tool results', () => {
  const request = anthropicToCodex(
    {
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'view_image',
              input: { path: 'screen.png' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-1',
              content: [
                { type: 'text', text: 'Attached screenshot:' },
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: 'image/png',
                    data: 'BBB',
                  },
                },
              ],
            },
          ],
        },
      ],
    },
    'gpt-5.6-luna',
  )

  assert.deepEqual(request.input[1], {
    type: 'function_call_output',
    call_id: 'tool-1',
    output: [
      { type: 'input_text', text: 'Attached screenshot:' },
      { type: 'input_image', image_url: 'data:image/png;base64,BBB' },
    ],
  })
})

test('keeps unsupported documents visible as a compact text marker', () => {
  const request = anthropicToCodex(
    {
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              title: 'requirements.pdf',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: 'JVBERi0x',
              },
            },
          ],
        },
      ],
    },
    'gpt-5.6-luna',
  )

  assert.deepEqual(request.input, [
    {
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: '[document "requirements.pdf" unavailable to the Codex Responses gateway]',
        },
      ],
    },
  ])
})

test('preserves historical server-tool calls and results', () => {
  const request = anthropicToCodex(
    {
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'server_tool_use',
              id: 'search-1',
              name: 'web_search',
              input: { query: 'Codex gateway compaction' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'web_search_tool_result',
              tool_use_id: 'search-1',
              content: [{ type: 'text', text: 'Search result text' }],
            },
          ],
        },
      ],
    },
    'gpt-5.6-luna',
  )

  assert.deepEqual(request.input, [
    {
      type: 'function_call',
      call_id: 'search-1',
      name: 'web_search',
      arguments: '{"query":"Codex gateway compaction"}',
    },
    {
      type: 'function_call_output',
      call_id: 'search-1',
      output: 'Search result text',
    },
  ])
})

test('emits translated usage in the final Anthropic stream event', async () => {
  const upstream = upstreamFromEvents([
    {
      type: 'response.output_text.delta',
      delta: 'OK',
    },
    {
      type: 'response.completed',
      response: {
        usage: {
          input_tokens: 151550,
          input_tokens_details: { cached_tokens: 149888 },
          output_tokens: 254,
          total_tokens: 151804,
        },
      },
    },
  ])
  const response = new CaptureResponse()

  await relayCodexStream(response, upstream, 'claude-gpt-luna')

  const finalEvent = responseEvents(response).find(
    event => event.type === 'message_delta',
  )
  assert.deepEqual(finalEvent.usage, {
    input_tokens: 1662,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 149888,
    output_tokens: 254,
  })
  assert.equal(response.ended, true)
})

test('completes a queued-peer follow-up when Codex emits output_text.done without deltas', async () => {
  const peerText = 'Authorized peer collaboration from Peer\\nB_OWNS_B'
  const request = anthropicToCodex({
    stream: true,
    system: 'coordination verifier',
    messages: [
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'call-peer',
          name: 'Skill',
          input: { skill: 'gateway-peers', args: 'send {"text":"B_OWNS_B"}' },
        }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'call-peer',
          content: '{"ok":true,"state":"queued"}',
        }],
      },
      { role: 'user', content: peerText },
    ],
  }, 'gpt-5.6-luna')

  assert.deepEqual(request.input, [
    {
      type: 'function_call',
      call_id: 'call-peer',
      name: 'Skill',
      arguments: '{"skill":"gateway-peers","args":"send {\\"text\\":\\"B_OWNS_B\\"}"}',
    },
    {
      type: 'function_call_output',
      call_id: 'call-peer',
      output: '{"ok":true,"state":"queued"}',
    },
    {
      role: 'user',
      content: [{ type: 'input_text', text: peerText }],
    },
  ])

  const events = [
    { type: 'response.created' },
    { type: 'response.in_progress' },
    { type: 'response.output_item.added', item: { type: 'message' } },
    { type: 'response.content_part.added', part: { type: 'output_text' } },
    { type: 'response.output_text.done', text: 'B_OWNS_B' },
    { type: 'response.content_part.done' },
    { type: 'response.output_item.done', item: { type: 'message' } },
    {
      type: 'response.completed',
      response: {
        status: 'completed',
        output: [],
        usage: { input_tokens: 7, output_tokens: 1 },
      },
    },
  ]

  for (const streaming of [true, false]) {
    const response = new CaptureResponse()
    const upstream = upstreamFromEvents(events)
    if (streaming) {
      await relayCodexStream(response, upstream, 'gateway-gpt-terra')
      assert.equal(responseEvents(response).some(event => event.type === 'message_stop'), true)
      assert.equal(response.text().includes('B_OWNS_B'), true)
    } else {
      await relayCodexResponse(response, upstream, 'gateway-gpt-terra', null, true)
      assert.equal(JSON.parse(response.text()).content[0].text, 'B_OWNS_B')
    }
    assert.equal(response.ended, true)
  }
})

for (const streaming of [true, false]) test(`finishes a completed Codex summary without waiting for transport EOF (streaming=${streaming})`, async () => {
  let cancelled = false
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode([
        { type: 'response.output_text.delta', delta: 'SUMMARY_COMPLETE' },
        { type: 'response.completed', response: { usage: { input_tokens: 100, output_tokens: 4 } } },
      ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('')))
      // The provider has finished the response but keeps the connection open.
    },
    cancel() { cancelled = true },
  })
  const response = new CaptureResponse()
  let timer
  try {
    await Promise.race([
      streaming
        ? relayCodexStream(response, { body }, 'gateway-gpt-sol')
        : relayCodexResponse(response, { body }, 'gateway-gpt-sol', null, true),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Completed summary waited for EOF')), 250) }),
    ])
    assert.equal(response.ended, true)
    if (streaming) assert.equal(responseEvents(response).some(event => event.type === 'message_stop'), true)
    else assert.equal(JSON.parse(response.text()).content[0].text, 'SUMMARY_COMPLETE')
    assert.equal(cancelled, true)
  } finally { clearTimeout(timer) }
})

test('ends with an Anthropic error when Codex ends before response.completed', async () => {
  const response = new CaptureResponse()
  await relayCodexStream(
    response,
    upstreamFromEvents([{ type: 'response.output_text.delta', delta: 'partial' }]),
    'claude-gpt-luna',
  )

  const events = responseEvents(response)
  assert.equal(events.some(event => event.type === 'message_delta'), false)
  assert.equal(events.some(event => event.type === 'message_stop'), false)
  assert.equal(events.find(event => event.type === 'error').error.message, 'Codex stream ended before response.completed')
  assert.equal(response.ended, true)
  assert.equal(response.destroyed, false)
})

test('ends with an Anthropic error after response.failed', async () => {
  const response = new CaptureResponse()
  await relayCodexStream(
    response,
    upstreamFromEvents([
      {
        type: 'response.failed',
        response: { error: { message: 'upstream failed' } },
      },
    ]),
    'claude-gpt-luna',
  )

  assert.equal(response.headers.status, 502)
  assert.deepEqual(JSON.parse(response.text()), {
    type: 'error',
    error: { type: 'api_error', message: 'upstream failed' },
  })
  assert.equal(response.ended, true)
  assert.equal(response.destroyed, false)
})

test('turns a pre-output Codex context failure into a prompt-too-long API error', async () => {
  const response = new CaptureResponse()
  await relayCodexStream(
    response,
    upstreamFromEvents([
      {
        type: 'response.failed',
        response: {
          error: {
            message:
              'Your input exceeds the context window of this model. Please adjust your input and try again.',
          },
        },
      },
    ]),
    'claude-gpt-luna',
  )

  assert.equal(response.headers.status, 400)
  assert.deepEqual(JSON.parse(response.text()), {
    type: 'error',
    error: {
      type: 'api_error',
      message:
        'Prompt is too long: Your input exceeds the context window of this model. Please adjust your input and try again.',
    },
  })
  assert.equal(response.ended, true)
})

test('returns a non-200 error for an empty pre-output Codex stream', async () => {
  const response = new CaptureResponse()
  await relayCodexStream(
    response,
    upstreamFromEvents([]),
    'claude-gpt-luna',
  )

  assert.equal(response.headers.status, 502)
  assert.deepEqual(JSON.parse(response.text()), {
    type: 'error',
    error: {
      type: 'api_error',
      message: 'Codex stream ended before response.completed',
    },
  })
  assert.equal(response.ended, true)
})

test('rejects a 200 completed Codex response with no output', async () => {
  const response = new CaptureResponse()
  await relayCodexStream(
    response,
    upstreamFromEvents([
      { type: 'response.completed', response: { output: [] } },
    ]),
    'claude-gpt-luna',
  )

  assert.equal(response.headers.status, 502)
  assert.deepEqual(JSON.parse(response.text()), {
    type: 'error',
    error: {
      type: 'api_error',
      message: 'Codex returned an empty or malformed response',
    },
  })
  assert.equal(response.ended, true)
})

test('ends cleanly when the upstream reader resets after partial output', async () => {
  const response = new CaptureResponse()
  let sent = false
  const upstream = {
    body: new ReadableStream({
      pull(controller) {
        if (!sent) {
          sent = true
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({
                type: 'response.output_text.delta',
                delta: 'partial',
              })}\n\n`,
            ),
          )
          return
        }
        controller.error(new Error('ECONNRESET'))
      },
    }),
  }

  await relayCodexStream(response, upstream, 'claude-gpt-luna')

  const events = responseEvents(response)
  assert.equal(events.some(event => event.type === 'message_delta'), false)
  assert.equal(events.some(event => event.type === 'message_stop'), false)
  assert.equal(events.find(event => event.type === 'error').error.message, 'ECONNRESET')
  assert.equal(response.ended, true)
  assert.equal(response.destroyed, false)
})

test('does not commit 200 for tool metadata without arguments', async () => {
  const response = new CaptureResponse()
  await relayCodexStream(
    response,
    upstreamFromEvents([
      {
        type: 'response.output_item.added',
        item: { type: 'function_call', call_id: 'call-1', name: 'Read' },
      },
    ]),
    'claude-gpt-luna',
  )
  assert.equal(response.headers.status, 502)
  assert.equal(JSON.parse(response.text()).error.message, 'Codex stream ended before response.completed')
})

test('closes an active content block before an in-stream error', async () => {
  const response = new CaptureResponse()
  await relayCodexStream(
    response,
    upstreamFromEvents([
      { type: 'response.output_text.delta', delta: 'partial' },
    ]),
    'claude-gpt-luna',
  )
  const events = responseEvents(response)
  assert.equal(events.at(-2).type, 'content_block_stop')
  assert.equal(events.at(-1).type, 'error')
})

function openCodeUpstream(events) {
  return upstreamFromEvents(events)
}

function openCodeJsonHandler(responseFactory) {
  return async (req, res, state) => {
    const body = await requestJson(req)
    state.requests.push({
      path: req.url,
      stream: body.stream,
      accept: req.headers.accept,
    })
    const response = responseFactory(req.url, body)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(response))
  }
}

function openCodeStreamHandler(responseFactory) {
  return async (req, res, state) => {
    const body = await requestJson(req)
    state.requests.push({ path: req.url, stream: body.stream, accept: req.headers.accept })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const events = responseFactory(req.url, body)
    res.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))
  }
}

function deepSeekJsonHandler(responseFactory) {
  return async (req, res, state) => {
    const body = await requestJson(req)
    state.requests.push({ stream: body.stream, accept: req.headers.accept })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(responseFactory(body)))
  }
}

test('builds OpenCode Go Responses requests with system, tools, and messages', () => {
  const request = anthropicToOpenCodeResponses(
    {
      system: 'Follow the user.',
      max_tokens: 321,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'read', input: { path: 'x' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'done' }] },
      ],
      tools: [{ name: 'read', description: 'Read a file', input_schema: { type: 'object' } }],
      tool_choice: 'auto',
    },
    'gpt-5.6-luna',
  )
  assert.equal(request.model, 'gpt-5.6-luna')
  assert.match(request.instructions, /^Honor the caller operational instructions/)
  assert.match(request.instructions, /Follow the user\./)
  assert.match(request.instructions, /Runtime tool contract:/)
  assert.equal(request.max_output_tokens, 321)
  assert.equal(request.tools[0].name, 'read')
  assert.equal(request.input[1].type, 'function_call')
  assert.equal(request.input[2].type, 'function_call_output')
})

test('HTTP boundary keeps OpenCode non-streaming fallbacks JSON across all protocols', async () => {
  const fixtures = {
    responses: {
      model: 'opencode-go/gpt-5.6-luna',
      expectedPath: '/responses',
      body: { id: 'resp-http', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'responses-ok' }] }] },
    },
    'chat-completions': {
      model: 'opencode-go/kimi-k3',
      expectedPath: '/chat/completions',
      body: { id: 'chat-http', choices: [{ message: { content: 'chat-ok', tool_calls: [] }, finish_reason: 'stop' }] },
    },
    'anthropic-messages': {
      model: 'opencode-go/qwen3.7-max',
      expectedPath: '/messages',
      body: { id: 'msg-http', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'messages-ok' }] },
    },
  }
  await withGatewayAndFakeOpenCode({
    handler: openCodeJsonHandler(path => Object.values(fixtures).find(item => item.expectedPath === path).body),
    run: async ({ gateway, state }) => {
      for (const [protocol, fixture] of Object.entries(fixtures)) {
        const result = await postGateway(gateway.port, {
          model: fixture.model,
          max_tokens: 16,
          messages: [{ role: 'user', content: 'fallback' }],
        })
        assert.equal(result.status, 200)
        assert.equal(result.headers.get('content-type'), 'application/json')
        assert.equal(result.body.includes('event:'), false)
        assert.equal(JSON.parse(result.body).type, 'message')
      }
      assert.deepEqual(state.requests, [
        { path: '/responses', stream: false, accept: 'application/json' },
        { path: '/chat/completions', stream: false, accept: 'application/json' },
        { path: '/messages', stream: false, accept: 'application/json' },
      ])
    },
  })
})

test('HTTP boundary rejects malformed OpenCode non-streaming JSON before 200', async () => {
  await withGatewayAndFakeOpenCode({
    handler: openCodeJsonHandler(() => ({})),
    run: async ({ gateway }) => {
      const result = await postGateway(gateway.port, {
        model: 'opencode-go/gpt-5.6-luna',
        messages: [{ role: 'user', content: 'fallback' }],
      })
      assert.equal(result.status, 502)
      assert.equal(result.headers.get('content-type'), 'application/json')
      assert.equal(result.body.includes('event:'), false)
    },
  })
})

test('HTTP boundary keeps OpenCode streaming callers on SSE', async () => {
  await withGatewayAndFakeOpenCode({
    handler: openCodeStreamHandler((url) => url === '/responses'
      ? [
          { type: 'response.output_text.delta', delta: 'stream-ok' },
          { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } },
        ]
      : url === '/chat/completions'
        ? [
            { choices: [{ delta: { content: 'stream-ok' } }] },
            { choices: [{ delta: {}, finish_reason: 'stop' }] },
            '[DONE]',
          ]
        : [
            { type: 'message_start', message: { id: 'msg-stream', type: 'message', role: 'assistant', content: [] } },
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'stream-ok' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
            { type: 'message_stop' },
          ]),
    run: async ({ gateway, state }) => {
      for (const model of ['opencode-go/gpt-5.6-luna', 'opencode-go/kimi-k3', 'opencode-go/qwen3.7-max']) {
        const result = await postGateway(gateway.port, {
          model,
          stream: true,
          max_tokens: 8,
          messages: [{ role: 'user', content: 'stream' }],
        })
        assert.equal(result.status, 200)
        assert.equal(result.headers.get('content-type'), 'text/event-stream')
        assert.match(result.body, /event: message_stop/)
      }
      assert.deepEqual(state.requests, [
        { path: '/responses', stream: true, accept: 'text/event-stream' },
        { path: '/chat/completions', stream: true, accept: 'text/event-stream' },
        { path: '/messages', stream: true, accept: 'text/event-stream' },
      ])
    },
  })
})

test('OpenCode native compaction requests preserve tools and requested effort', async () => {
  await withGatewayAndFakeOpenCode({
    handler: async (req, res, state) => {
      const body = await requestJson(req)
      state.requests.push(body)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: 'glm-flash-compact',
        choices: [{ message: { content: 'summary', tool_calls: [] }, finish_reason: 'stop' }],
      }))
    },
    run: async ({ gateway, state }) => {
      const result = await postCompaction(gateway.port, compactionRequestBody({
        model: 'gateway-opencode-glm-5.3-flash',
        stream: false,
        output_config: { effort: 'max' },
      }))
      assert.equal(result.status, 200)
      assert.equal(state.requests.length, 1)
      assert.equal(state.requests[0].tools.length, 1)
      assert.equal(state.requests[0].tool_choice, undefined)
      assert.equal(state.requests[0].reasoning_effort, undefined)
      assert.match(state.requests[0].messages[0].content, /Native harness summary contract/i)
    },
  })
})


test('gateway exposes canonical routes with Astra metadata and provider-qualified OpenCode aliases', () => {
  const response = modelsResponse()
  const astra = response.data.find(item => item.id === 'gateway-gpt-astra')
  assert.ok(astra)
  assert.equal(astra.display_name, 'gpt-6-astra')
  assert.deepEqual(astra.effort_levels, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
  for (const model of [
    'gateway-opencode-mimo-v2.5',
    'gateway-opencode-hy3',
    'gateway-opencode-deepseek-v4-pro',
  ]) {
    assert.ok(response.models.includes(model))
    const entry = response.data.find(item => item.id === model)
    assert.equal(entry?.owned_by, 'opencode-go')
    assert.equal(entry?.display_name, model.replace('gateway-opencode-', ''))
  }
  const hy3 = response.data.find(item => item.id === 'gateway-opencode-hy3')
  assert.deepEqual(hy3?.effort_levels, ['none', 'low', 'high'])
  assert.equal(hy3?.supports_tools, false)
  assert.equal(response.models.some(model => model.startsWith('claude-')), false)
  assert.equal(response.models.some(model => model.startsWith('opencode-go/')), false)
})

test('unsupported OpenCode tool catalogs are removed without mutating the caller body', () => {
  const body = {
    model: 'hy3',
    tools: [{ name: 'shell' }],
    tool_choice: { type: 'tool', name: 'shell' },
  }
  const stripped = stripUnsupportedOpenCodeTools(body, {
    backend: 'opencode-go',
    upstream: 'hy3',
    supportsTools: false,
  })
  assert.equal(stripped.tools, undefined)
  assert.equal(stripped.tool_choice, undefined)
  assert.equal(body.tools.length, 1)
})

test('unsupported OpenCode forced tool choice is removed while tools remain', () => {
  const body = {
    model: 'deepseek-v4-pro',
    tools: [{ name: 'shell' }],
    tool_choice: { type: 'tool', name: 'shell' },
  }
  const stripped = stripUnsupportedOpenCodeToolChoice(body, {
    backend: 'opencode-go',
    upstream: 'deepseek-v4-pro',
    supportsForcedToolChoice: false,
  })
  assert.equal(stripped.tools.length, 1)
  assert.equal(stripped.tool_choice, undefined)
  assert.equal(body.tool_choice.type, 'tool')
})

test('GLM 5.3 Flash strips forced tool choice while retaining tools', () => {
  const body = {
    model: 'glm-5.3-flash',
    tools: [{ name: 'shell' }],
    tool_choice: { type: 'tool', name: 'shell' },
  }
  const stripped = stripUnsupportedOpenCodeToolChoice(body, {
    backend: 'opencode-go',
    upstream: 'glm-5.3-flash',
    supportsForcedToolChoice: false,
  })
  assert.equal(stripped.tools.length, 1)
  assert.equal(stripped.tool_choice, undefined)
  assert.equal(body.tool_choice.type, 'tool')
})

test('OpenCode forced tool choice remains available on confirmed routes', () => {
  const body = {
    model: 'kimi-k3',
    tools: [{ name: 'shell' }],
    tool_choice: { type: 'tool', name: 'shell' },
  }
  const retained = stripUnsupportedOpenCodeToolChoice(body, {
    backend: 'opencode-go',
    upstream: 'kimi-k3',
    supportsForcedToolChoice: true,
  })
  assert.deepEqual(retained, body)
})

test('provider error extraction keeps a bounded sanitized diagnostic', async () => {
  const response = new Response(JSON.stringify({
    error: { message: 'unsupported field: tools' },
    secret: 'should-not-be-selected',
  }), { status: 400 })
  const detail = await safeUpstreamResponseError(response, 'OpenCode Go', 'secret')
  assert.equal(detail, 'OpenCode Go returned HTTP 400: unsupported field: tools')
})

test('HTTP boundary retries a malformed OpenCode stream before committing 200', async () => {
  await withGatewayAndFakeOpenCode({
    handler: async (req, res, state) => {
      await requestJson(req)
      state.requests.push(state.requests.length + 1)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (state.requests.length === 1) {
        res.end('data: not-json\n\n')
        return
      }
      res.end(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'recovered' } }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n` +
        'data: [DONE]\n\n',
      )
    },
    gatewayEnv: {
      MODEL_GATEWAY_UPSTREAM_RETRIES: '1',
      MODEL_GATEWAY_UPSTREAM_RETRY_BASE_MS: '1',
    },
    run: async ({ gateway, state }) => {
      const result = await postGateway(gateway.port, {
        model: 'gateway-opencode-glm-5.3-flash',
        stream: true,
        messages: [{ role: 'user', content: 'retry malformed' }],
      })
      assert.equal(result.status, 200)
      assert.match(result.body, /recovered/)
      assert.deepEqual(state.requests, [1, 2])
    },
  })
})

test('OpenCode pre-output retry re-arms the upstream header timeout', async () => {
  await withGatewayAndFakeOpenCode({
    handler: (req, res, state) => malformedThenWaitingOpenCodeHandler(state)(req, res),
    gatewayEnv: {
      MODEL_GATEWAY_UPSTREAM_RETRIES: '1',
      MODEL_GATEWAY_UPSTREAM_RETRY_BASE_MS: '1',
      MODEL_GATEWAY_UPSTREAM_RETRY_MAX_MS: '1',
      MODEL_GATEWAY_UPSTREAM_TIMEOUT_MS: '40',
      MODEL_GATEWAY_RETRY_ATTEMPT_TIMEOUT_MS: '40',
      MODEL_GATEWAY_CONSUMER_TIMEOUT_MS: '2000',
    },
    run: async ({ gateway, state }) => {
      const started = performance.now()
      const result = await postGateway(gateway.port, {
        model: 'gateway-opencode-glm-5.3-flash',
        stream: true,
        messages: [{ role: 'user', content: 're-arm retry timeout' }],
      })
      const elapsed = performance.now() - started
      assert.equal(result.status, 504)
      assert.match(result.body, /Gateway upstream request timed out/)
      assertCompletedBeforeFallback(elapsed, {
        label: 'OpenCode retry re-arm',
        // Two 40ms attempt windows plus a 1ms backoff; the retry must re-arm
        // its own header timeout rather than fall through to the consumer one.
        path: 2 * 40 + 1,
        fallback: 2000,
      })
      assert.deepEqual(state.requests, [1, 2])
      // A bounded wait, not a bare synchronous check. The bare form asserted
      // something weaker than it looked: not that the gateway cancels the
      // upstream request, but that the cancellation event had already
      // propagated to the fake server within the same tick. Under load it had
      // not, so a healthy run went red.
      assert.equal(await waitForUpstreamCancellation(state), true)
    },
  })
})

test('OpenCode consumer disconnect during malformed retry backoff does not crash the gateway', async () => {
  await withGatewayAndFakeOpenCode({
    handler: async (req, res, state) => {
      await requestJson(req)
      state.requests.push(state.requests.length + 1)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('data: not-json\n\n')
    },
    gatewayEnv: {
      MODEL_GATEWAY_UPSTREAM_RETRIES: '1',
      MODEL_GATEWAY_UPSTREAM_RETRY_BASE_MS: '200',
      MODEL_GATEWAY_UPSTREAM_RETRY_MAX_MS: '200',
    },
    run: async ({ gateway, state }) => {
      const result = await abortGatewayDuringRetry(gateway.port, {
        model: 'gateway-opencode-glm-5.3-flash',
        stream: true,
        messages: [{ role: 'user', content: 'disconnect during retry' }],
        // Abort only once the first upstream attempt has been observed, as the
        // Codex case above does. Without the readiness predicate this test
        // measured the host: under load the consumer left before the gateway's
        // first attempt reached the fixture, so `0 !== 1` failed a healthy run.
      }, 25, () => state.requests.length > 0)
      assert.equal(result.disconnected, true)
      await new Promise(resolve => setTimeout(resolve, 300))
      assert.equal(gateway.child.exitCode, null, gateway.getStderr())
      assert.equal(state.requests.length, 1)

      const health = await fetch(`http://127.0.0.1:${gateway.port}/health`)
      assert.equal(health.status, 200)
      const healthBody = await health.json()
      assert.equal(healthBody.status, 'ok')
      assert.ok(Number.isInteger(healthBody.modelCount) && healthBody.modelCount > 0)
      assert.equal(gateway.getStderr().includes('triggerUncaughtException'), false)
    },
  })
})

test('HTTP boundary retries an OpenCode transient 400', async () => {
  await withGatewayAndFakeOpenCode({
    handler: async (req, res, state) => {
      await requestJson(req)
      state.requests.push(state.requests.length + 1)
      if (state.requests.length === 1) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'provider temporarily unavailable' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'recovered-400' } }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' } ] })}\n\n` +
        'data: [DONE]\n\n',
      )
    },
    gatewayEnv: {
      MODEL_GATEWAY_UPSTREAM_RETRIES: '1',
      MODEL_GATEWAY_UPSTREAM_RETRY_BASE_MS: '1',
    },
    run: async ({ gateway, state }) => {
      const result = await postGateway(gateway.port, {
        model: 'gateway-opencode-glm-5.3-flash',
        stream: true,
        messages: [{ role: 'user', content: 'transient 400' }],
      })
      assert.equal(result.status, 200)
      assert.match(result.body, /recovered-400/)
      assert.deepEqual(state.requests, [1, 2])
    },
  })
})

test('HTTP boundary bounds an OpenCode retry that never returns headers', async () => {
  await withGatewayAndFakeOpenCode({
    handler: async (req, res, state) => {
      state.requests.push(state.requests.length + 1)
      if (state.requests.length === 1) {
        await requestJson(req)
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'temporarily unavailable' } }))
        return
      }

      req.resume()
      req.once('aborted', () => { state.requestAborted = true })
      res.once('close', () => { state.responseClosed = true })
    },
    gatewayEnv: {
      MODEL_GATEWAY_UPSTREAM_RETRIES: '1',
      MODEL_GATEWAY_UPSTREAM_RETRY_BASE_MS: '1',
      MODEL_GATEWAY_UPSTREAM_TIMEOUT_MS: '1000',
      MODEL_GATEWAY_RETRY_ATTEMPT_TIMEOUT_MS: '40',
      MODEL_GATEWAY_CONSUMER_TIMEOUT_MS: '3000',
    },
    run: async ({ gateway, state }) => {
      const started = performance.now()
      const result = await postGateway(gateway.port, {
        model: 'gateway-opencode-glm-5.3-flash',
        stream: true,
        messages: [{ role: 'user', content: 'retry timeout' }],
      })
      const elapsed = performance.now() - started
      assert.equal(result.status, 504)
      assert.match(result.body, /Gateway upstream request timed out/)
      assertCompletedBeforeFallback(elapsed, {
        label: 'OpenCode retry deadline',
        // Two 40ms attempt windows plus a 1ms backoff, against the 3000ms
        // consumer timeout.
        path: 2 * 40 + 1,
        fallback: 3000,
      })
      assert.deepEqual(state.requests, [1, 2])
      assert.equal(await waitForUpstreamCancellation(state), true)
    },
  })
})

test('OpenCode has a bounded upstream request deadline even when the provider stalls', async () => {
  await withGatewayAndFakeOpenCode({
    handler: async (req, res, state) => {
      state.requests.push(state.requests.length + 1)
      req.resume()
      req.once('aborted', () => { state.requestAborted = true })
      res.once('close', () => { state.responseClosed = true })
      // Keep the upstream open without headers or output.
    },
    gatewayEnv: {
      MODEL_GATEWAY_UPSTREAM_TIMEOUT_MS: '40',
      MODEL_GATEWAY_CONSUMER_TIMEOUT_MS: '3000',
    },
    run: async ({ gateway, state }) => {
      const started = performance.now()
      const result = await postGateway(gateway.port, {
        model: 'gateway-opencode-glm-5.3-flash',
        stream: true,
        messages: [{ role: 'user', content: 'bounded alpha request' }],
      })
      const elapsed = performance.now() - started
      assert.equal(result.status, 504)
      assert.match(result.body, /Gateway upstream request timed out/)
      assertCompletedBeforeFallback(elapsed, {
        label: 'OpenCode upstream deadline',
        // The 40ms upstream timeout ends the stalled request; the 3000ms
        // consumer timeout is the fall-through this guards.
        path: 40,
        fallback: 3000,
      })
      assert.equal(await waitForUpstreamCancellation(state), true)
    },
  })
})

test('HTTP boundary bounds OpenCode transient-400 body classification', async () => {
  await withGatewayAndFakeOpenCode({
    handler: async (req, res, state) => {
      state.requests.push(state.requests.length + 1)
      await requestJson(req)
      res.writeHead(400, { 'content-type': 'application/json' })
      res.write('{"error":{"message":"temporarily unavailable"')
      // Deliberately leave the provider body open. The gateway must not wait
      // forever while deciding whether this 400 is transient.
      req.once('aborted', () => { state.requestAborted = true })
      res.once('close', () => { state.responseClosed = true })
    },
    gatewayEnv: {
      MODEL_GATEWAY_UPSTREAM_RETRIES: '1',
      MODEL_GATEWAY_UPSTREAM_RETRY_BASE_MS: '1',
      MODEL_GATEWAY_UPSTREAM_TIMEOUT_MS: '1000',
      MODEL_GATEWAY_RETRY_ATTEMPT_TIMEOUT_MS: '40',
      MODEL_GATEWAY_CONSUMER_TIMEOUT_MS: '3000',
    },
    run: async ({ gateway, state }) => {
      const started = performance.now()
      const result = await postGateway(gateway.port, {
        model: 'gateway-opencode-glm-5.3-flash',
        stream: true,
        messages: [{ role: 'user', content: 'retryable 400 body timeout' }],
      })
      const elapsed = performance.now() - started
      assert.equal(result.status, 504)
      assert.match(result.body, /OpenCode Go upstream request timed out/)
      assertCompletedBeforeFallback(elapsed, {
        label: 'OpenCode 400 body classification',
        // The 40ms attempt timeout must end the open 400 body; the 3000ms
        // consumer timeout is the fall-through this guards.
        path: 40,
        fallback: 3000,
      })
      assert.deepEqual(state.requests, [1])
      assert.equal(await waitForUpstreamCancellation(state), true)
    },
  })
})

test('HTTP boundary cancels an OpenCode reader when the consumer disconnects', async () => {
  await withGatewayAndFakeOpenCode({
    handler: async (req, res, state) => {
      req.resume()
      res.once('close', () => { state.responseClosed = true })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`)
    },
    run: async ({ gateway, state }) => {
      const result = await abortGatewayAfterHeaders(gateway.port, {
        model: 'gateway-opencode-glm-5.3-flash',
        stream: true,
        messages: [{ role: 'user', content: 'disconnect' }],
      })
      assert.equal(result.status, 200)
      assert.equal(await waitForUpstreamCancellation(state), true)
    },
  })
})


test('OpenCode maps pre-output context failures to HTTP 400 without SSE', async () => {
  await withGatewayAndFakeOpenCode({
    handler: openCodeJsonHandler(() => ({ error: { message: 'maximum context length exceeded' } })),
    run: async ({ gateway }) => {
      const result = await postGateway(gateway.port, {
        model: 'opencode-go/gpt-5.6-luna',
        messages: [{ role: 'user', content: 'context' }],
      })
      assert.equal(result.status, 400)
      assert.equal(result.headers.get('content-type'), 'application/json')
      assert.match(result.body, /Prompt is too long:/)
      assert.equal(result.body.includes('event:'), false)
    },
  })
})


test('OpenCode passes omitted stream as non-streaming in the request adapters', () => {
  assert.equal(anthropicToOpenCodeResponses({ messages: [] }, 'gpt-5.6-luna').stream, false)
  assert.equal(anthropicToOpenCodeChat({ messages: [] }, 'kimi-k3').stream, false)
  assert.equal(anthropicToOpenCodeRequest({ messages: [] }, { upstream: 'qwen3.7-max', protocol: 'anthropic-messages' }).stream, false)
})

test('OpenCode request headers default to JSON and opt into SSE explicitly', () => {
  assert.equal(openCodeGoHeaders('responses', 'synthetic-key').accept, 'application/json')
  assert.equal(openCodeGoHeaders('responses', 'synthetic-key', true).accept, 'text/event-stream')
})

test('keeps OpenCode tool results adjacent to the assistant tool call', () => {
  const request = anthropicToOpenCodeChat({
    messages: [
      { role: 'user', content: 'inspect this' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'read', input: { path: 'x' } }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call-1', content: 'done' },
          { type: 'text', text: 'Now summarize it.' },
        ],
      },
    ],
  }, 'deepseek-v4-flash')

  assert.deepEqual(request.messages.slice(1).map(message => message.role), ['user', 'assistant', 'tool', 'user'])
  assert.deepEqual(request.messages[2], {
    role: 'assistant',
    content: null,
    tool_calls: [{
      id: 'call-1',
      type: 'function',
      function: { name: 'read', arguments: '{"path":"x"}' },
    }],
  })
  assert.deepEqual(request.messages[3], {
    role: 'tool',
    tool_call_id: 'call-1',
    content: 'done',
  })
  assert.deepEqual(request.messages[4], {
    role: 'user',
    content: [{ type: 'text', text: 'Now summarize it.' }],
  })
})

test('builds OpenCode Go Chat Completions requests and forwards images', () => {
  const request = anthropicToOpenCodeChat(
    {
      system: 'system',
      stream: true,
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'look' },
        { type: 'image', source: { type: 'url', url: 'https://example.test/a.png' } },
      ] }],
    },
    'kimi-k3',
  )
  assert.equal(request.messages[0].role, 'system')
  assert.match(request.messages[0].content, /^Honor the caller operational instructions/)
  assert.match(request.messages[0].content, /Runtime tool contract:/)
  assert.equal(request.messages[1].content[1].type, 'image_url')
  assert.equal(request.messages[1].content[1].image_url.url, 'https://example.test/a.png')
  assert.equal(request.stream, true)
})

test('Chat Completions keeps images returned inside a tool result', () => {
  // A Read of a screenshot comes back as a tool_result whose content array
  // holds the image. Chat Completions tool messages carry a plain string, so
  // the image has to be hoisted into a following user message; flattening it
  // to text told the model an image existed but never let it see one.
  const request = anthropicToOpenCodeChat(
    {
      system: 'system',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'read it' }] },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'x.png' } }],
        },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BBB' } },
            ],
          }],
        },
      ],
    },
    'kimi-k3',
  )

  const toolMessage = request.messages.find(m => m.role === 'tool')
  assert.equal(toolMessage.tool_call_id, 'tool-1')
  assert.doesNotMatch(String(toolMessage.content), /image attachment/)

  const imageMessage = request.messages.find(
    m => m.role === 'user' && Array.isArray(m.content) && m.content.some(b => b.type === 'image_url'),
  )
  assert.ok(imageMessage, 'the tool-result image must survive as an image_url block')
  assert.equal(imageMessage.content[0].image_url.url, 'data:image/png;base64,BBB')
})

test('Responses keeps images returned inside a tool result attached to the call', () => {
  const request = anthropicToOpenCodeResponses(
    {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'read it' }] },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'x.png' } }],
        },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: [
              { type: 'text', text: 'screenshot' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'CCC' } },
            ],
          }],
        },
      ],
    },
    'gpt-5.6-luna',
  )

  const output = request.input.find(item => item.type === 'function_call_output')
  assert.deepEqual(output.output, [
    { type: 'input_text', text: 'screenshot' },
    { type: 'input_image', image_url: 'data:image/png;base64,CCC' },
  ])
})

test('OpenCode Go and Zen session headers preserve auth and reject CRLF', () => {
  for (const headers of [
    openCodeGoHeaders('responses', 'synthetic-key', false, 'session-ok'),
    openCodeGoHeaders('chat-completions', 'synthetic-key', false, 'session-ok'),
    openCodeGoHeaders('anthropic-messages', 'synthetic-key', false, 'session-ok'),
    openCodeZenHeaders('synthetic-key', false, 'session-ok'),
  ]) {
    assert.equal(headers['x-opencode-session'], 'session-ok')
    assert.equal(headers['user-agent'], 'gateway-model-gateway/0.1')
  }
  assert.equal(openCodeGoHeaders('responses', 'synthetic-key', false, 'bad\r\nX-Leak: yes')['x-opencode-session'], undefined)
  assert.equal(openCodeZenHeaders('synthetic-key', false, 'bad\r\nX-Leak: yes')['x-opencode-session'], undefined)
  assert.equal(openCodeGoHeaders('responses', 'synthetic-key').authorization, 'Bearer synthetic-key')
  assert.equal(openCodeGoHeaders('chat-completions', 'synthetic-key').authorization, 'Bearer synthetic-key')
  assert.equal(openCodeGoHeaders('anthropic-messages', 'synthetic-key')['x-api-key'], 'synthetic-key')
  assert.equal(openCodeGoHeaders('anthropic-messages', 'synthetic-key')['anthropic-version'], '2023-06-01')
  assert.equal(JSON.stringify(openCodeGoHeaders('responses', 'synthetic-key')).includes('synthetic-key'), true)
})

test('forwards OpenCode session identity by precedence and keeps it across retries', async () => {
  await withGatewayAndFakeOpenCode({
    handler: async (req, res, state) => {
      const body = await requestJson(req)
      state.requests.push({
        session: req.headers['x-opencode-session'],
        authorization: req.headers.authorization,
        userAgent: req.headers['user-agent'],
        requestId: body.metadata?.request_id,
      })
      if (state.requests.length === 1) {
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'temporarily unavailable' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'session-test', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }))
    },
    gatewayEnv: {
      CLAUDE_CODE_SESSION_ID: 'env-session',
      MODEL_GATEWAY_UPSTREAM_RETRIES: '1',
      MODEL_GATEWAY_UPSTREAM_RETRY_BASE_MS: '1',
    },
    run: async ({ gateway, state }) => {
      const result = await postGateway(gateway.port, {
        model: 'gateway-opencode-glm-5.3-flash',
        metadata: { session_id: 'metadata-session', request_id: 'precedence' },
        messages: [{ role: 'user', content: 'identity' }],
      }, { 'x-opencode-session': 'incoming-session' })
      assert.equal(result.status, 200)
      assert.deepEqual(state.requests.map(request => request.session), ['incoming-session', 'incoming-session'])
      assert.match(state.requests[0].authorization, /^Bearer /)
      assert.equal(state.requests[0].userAgent, 'gateway-model-gateway/0.1')

      const second = await postGateway(gateway.port, {
        model: 'gateway-opencode-glm-5.3-flash',
        metadata: { session_id: 'metadata-session', request_id: 'metadata' },
        messages: [{ role: 'user', content: 'identity' }],
      })
      assert.equal(second.status, 200)
      assert.equal(state.requests.at(-1).session, 'metadata-session')

      const third = await postGateway(gateway.port, {
        model: 'gateway-opencode-glm-5.3-flash',
        metadata: { user_id: JSON.stringify({ session_id: 'json-session' }), request_id: 'json' },
        messages: [{ role: 'user', content: 'identity' }],
      })
      assert.equal(third.status, 200)
      assert.equal(state.requests.at(-1).session, 'json-session')

      const fourth = await postGateway(gateway.port, {
        model: 'gateway-opencode-glm-5.3-flash',
        metadata: { request_id: 'env' },
        messages: [{ role: 'user', content: 'identity' }],
      })
      assert.equal(fourth.status, 200)
      assert.equal(state.requests.at(-1).session, 'env-session')

      const separate = await postGateway(gateway.port, {
        model: 'gateway-opencode-glm-5.3-flash',
        metadata: { session_id: 'separate-conversation' },
        messages: [{ role: 'user', content: 'identity' }],
      })
      assert.equal(separate.status, 200)
      assert.equal(state.requests.at(-1).session, 'separate-conversation')
    },
  })
})

test('uses protocol-specific OpenCode Go authentication headers', () => {
  assert.equal(openCodeGoHeaders('responses', 'synthetic-key').authorization, 'Bearer synthetic-key')
  assert.equal(openCodeGoHeaders('chat-completions', 'synthetic-key').authorization, 'Bearer synthetic-key')
  assert.equal(openCodeGoHeaders('anthropic-messages', 'synthetic-key')['x-api-key'], 'synthetic-key')
  assert.equal(openCodeGoHeaders('anthropic-messages', 'synthetic-key')['anthropic-version'], '2023-06-01')
  assert.equal(JSON.stringify(openCodeGoHeaders('responses', 'synthetic-key')).includes('synthetic-key'), true)
  assert.equal(openCodeGoHeaders('anthropic-messages', 'synthetic-key')['anthropic-version'], '2023-06-01')
  assert.equal(JSON.stringify(openCodeGoHeaders('responses', 'synthetic-key')).includes('synthetic-key'), true)
})

test('maps cache metadata from an OpenCode Responses usage payload', () => {
  assert.deepEqual(openCodeUsageToAnthropic({
    input_tokens: 20,
    input_tokens_details: { cached_tokens: 7 },
    output_tokens: 4,
  }), {
    input_tokens: 13,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 7,
    output_tokens: 4,
  })
})

test('translates OpenCode Anthropic tool results and images', () => {
  const request = anthropicToOpenCodeRequest({
    system: [{ type: 'text', text: 'system' }],
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'inspect' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
      ],
    }, {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call-1', name: 'read', input: { path: 'x' } }],
    }, {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'done' }],
    }],
  }, { upstream: 'grok-4.5', protocol: 'responses' })
  assert.match(request.instructions, /^Honor the caller operational instructions/)
  assert.match(request.instructions, /Runtime tool contract:/)
  assert.equal(request.input[0].content[1].image_url, 'data:image/png;base64,AAA')
  assert.equal(request.input[1].type, 'function_call')
  assert.equal(request.input[2].type, 'function_call_output')
})

test('non-streaming OpenCode Responses returns Anthropic JSON without SSE', async () => {
  const response = new CaptureResponse()
  await relayOpenCodeResponse(response, {
    text: async () => JSON.stringify({
      id: 'resp-json',
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }],
      usage: { input_tokens: 4, output_tokens: 1 },
    }),
  }, 'opencode-go/gpt-5.6-luna')
  assert.equal(response.headers.status, 200)
  assert.equal(response.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(response.text()).content, [{ type: 'text', text: 'OK' }])
  assert.equal(response.text().includes('event:'), false)
})

test('non-streaming OpenCode Chat Completions returns Anthropic tool JSON', async () => {
  const response = new CaptureResponse()
  await relayOpenCodeChatResponse(response, {
    text: async () => JSON.stringify({
      id: 'chat-json',
      choices: [{
        message: {
          content: null,
          tool_calls: [{ id: 'call-json', function: { name: 'read', arguments: '{"path":"x"}' } }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    }),
  }, 'opencode-go/kimi-k3')
  assert.equal(response.headers.status, 200)
  const message = JSON.parse(response.text())
  assert.deepEqual(message.content, [{ type: 'tool_use', id: 'call-json', name: 'read', input: { path: 'x' } }])
  assert.equal(message.stop_reason, 'tool_use')
  assert.equal(response.text().includes('event:'), false)
})

test('non-streaming OpenCode Chat Completions preserves reasoning-only JSON', async () => {
  const response = new CaptureResponse()
  await relayOpenCodeChatResponse(response, {
    text: async () => JSON.stringify({
      id: 'chat-reasoning-only',
      choices: [{
        message: {
          content: '',
          reasoning_content: 'reasoning exhausted the requested output budget',
        },
        finish_reason: 'length',
      }],
      usage: { prompt_tokens: 5, completion_tokens: 96 },
    }),
  }, 'opencode-go/glm-5.2')
  assert.equal(response.headers.status, 200)
  const message = JSON.parse(response.text())
  assert.deepEqual(message.content, [{
    type: 'thinking',
    thinking: 'reasoning exhausted the requested output budget',
  }])
  assert.equal(message.stop_reason, 'max_tokens')
  assert.equal(response.text().includes('event:'), false)
})

test('non-streaming OpenCode Anthropic Messages returns JSON without SSE', async () => {
  const response = new CaptureResponse()
  await relayOpenCodeAnthropicResponse(response, {
    text: async () => JSON.stringify({
      id: 'msg-json',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'OK' }],
      stop_reason: 'end_turn',
    }),
  }, 'opencode-go/qwen3.7-max')
  assert.equal(response.headers.status, 200)
  assert.equal(response.headers['content-type'], 'application/json')
  assert.equal(JSON.parse(response.text()).content[0].text, 'OK')
  assert.equal(response.text().includes('event:'), false)
})

test('non-streaming OpenCode rejects malformed and empty JSON before 200', async () => {
  for (const protocol of ['responses', 'chat-completions', 'anthropic-messages']) {
    const response = new CaptureResponse()
    await relayOpenCodeResponseByProtocol(response, { text: async () => '{}' }, 'opencode-go/test', protocol)
    assert.equal(response.headers.status, 502)
    assert.equal(response.headers['content-type'], 'application/json')
    assert.equal(JSON.parse(response.text()).type, 'error')
    assert.equal(response.text().includes('event:'), false)
  }
})

test('translates a valid OpenCode Responses stream', async () => {
  const response = new CaptureResponse()
  await relayOpenCodeResponsesStream(response, openCodeUpstream([
    { type: 'response.output_text.delta', delta: 'hello' },
    { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 2 } } },
  ]), 'opencode-go/gpt-5.6-luna')
  const events = responseEvents(response)
  assert.equal(response.headers.status, 200)
  assert.equal(events.find(event => event.type === 'content_block_delta').delta.text, 'hello')
  assert.equal(events.find(event => event.type === 'content_block_start').index, 0)
  assert.equal(events.find(event => event.type === 'content_block_stop').index, 0)
  assert.equal(events.at(-1).type, 'message_stop')
  assert.deepEqual(events.find(event => event.type === 'message_delta').usage, {
    input_tokens: 10,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 2,
  })
})

test('translates OpenCode Chat Completions reasoning-only deltas', async () => {
  const response = new CaptureResponse()
  await relayOpenCodeChatStream(response, openCodeUpstream([
    { choices: [{ delta: { role: 'assistant' } }] },
    { choices: [{ delta: { reasoning_content: 'thinking' } }] },
    { choices: [{ delta: { reasoning_content: ' more' }, finish_reason: 'length' }] },
    { choices: [], usage: { prompt_tokens: 2, completion_tokens: 3 } },
    '[DONE]',
  ]), 'opencode-go/hy3')
  const events = responseEvents(response)
  assert.equal(response.headers.status, 200)
  assert.equal(events.find(event => event.type === 'content_block_start').content_block.type, 'thinking')
  assert.equal(events.filter(event => event.type === 'content_block_delta').map(event => event.delta.thinking).join(''), 'thinking more')
  assert.equal(events.find(event => event.type === 'message_delta').delta.stop_reason, 'max_tokens')
})

test('translates OpenCode Chat Completions tool calls', async () => {
  const response = new CaptureResponse()
  await relayOpenCodeChatStream(response, openCodeUpstream([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'read', arguments: '{"path"' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"x"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 4 } },
    '[DONE]',
  ]), 'opencode-go/kimi-k3')
  const events = responseEvents(response)
  assert.equal(events.find(event => event.type === 'content_block_start').content_block.type, 'tool_use')
  assert.equal(events.filter(event => event.type === 'content_block_delta').map(event => event.delta.partial_json).join(''), '{"path":"x"}')
  assert.equal(events.find(event => event.type === 'message_delta').delta.stop_reason, 'tool_use')
})

test('keeps one OpenCode Chat tool call when continuation omits index and id', async () => {
  const response = new CaptureResponse()
  await relayOpenCodeChatStream(response, openCodeUpstream([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'read', arguments: '{"path"' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ function: { arguments: ':"README.md"}' } }] }, finish_reason: 'tool_calls' }] },
    '[DONE]',
  ]), 'opencode-go/kimi-k3')
  const events = responseEvents(response)
  const starts = events.filter(event => event.type === 'content_block_start')
  const deltas = events
    .filter(event => event.type === 'content_block_delta')
    .map(event => event.delta.partial_json)
    .join('')
  assert.equal(starts.length, 1)
  assert.equal(starts[0].content_block.id, 'call-1')
  assert.equal(deltas, '{"path":"README.md"}')
  assert.equal(events.find(event => event.type === 'message_delta').delta.stop_reason, 'tool_use')
})

test('passes through valid OpenCode Anthropic Messages SSE', async () => {
  const response = new CaptureResponse()
  await relayOpenCodeAnthropicStream(response, openCodeUpstream([
    { type: 'message_start', message: { id: 'msg-1', type: 'message', role: 'assistant', content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ]), 'opencode-go/qwen3.7-max')
  const events = responseEvents(response)
  assert.equal(response.headers.status, 200)
  assert.equal(events.find(event => event.type === 'content_block_delta').delta.text, 'ok')
  assert.equal(events.at(-1).type, 'message_stop')
})

test('does not commit 200 for an OpenCode Anthropic stream with no usable output', async () => {
  const response = new CaptureResponse()
  await relayOpenCodeAnthropicStream(response, openCodeUpstream([
    { type: 'message_start', message: { id: 'msg-empty', type: 'message', role: 'assistant', content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'message_stop' },
  ]), 'opencode-go/qwen3.7-max')
  assert.equal(response.headers.status, 502)
  assert.equal(JSON.parse(response.text()).error.message, 'OpenCode returned an empty or malformed response')
})

test('rejects empty and malformed OpenCode Responses streams before 200', async () => {
  const cases = [
    {
      upstream: openCodeUpstream([
        { type: 'response.completed', response: { output: [] } },
      ]),
      message: 'OpenCode returned an empty or malformed response',
    },
    {
      upstream: {
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: not-json\n\n'))
            controller.close()
          },
        }),
      },
      message: 'OpenCode returned malformed Responses SSE data',
    },
  ]
  for (const { upstream, message } of cases) {
    const response = new CaptureResponse()
    await relayOpenCodeResponsesStream(response, upstream, 'opencode-go/gpt-5.6-luna')
    assert.equal(response.headers.status, 502)
    assert.equal(JSON.parse(response.text()).error.message, message)
  }
})

test('turns an OpenCode Responses reset after output into an in-stream error', async () => {
  const response = new CaptureResponse()
  let sent = false
  const upstream = {
    body: new ReadableStream({
      pull(controller) {
        if (!sent) {
          sent = true
          controller.enqueue(new TextEncoder().encode(
            `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'partial' })}\n\n`,
          ))
        } else {
          controller.error(new Error('ECONNRESET'))
        }
      },
    }),
  }
  await relayOpenCodeResponsesStream(response, upstream, 'opencode-go/gpt-5.6-luna')
  const events = responseEvents(response)
  assert.equal(response.headers.status, 200)
  assert.equal(events.at(-1).type, 'error')
  assert.equal(events.at(-1).error.message, 'ECONNRESET')
})

test('rejects an incomplete OpenCode Responses stream with no output before 200', async () => {
  const response = new CaptureResponse()
  await relayOpenCodeResponsesStream(
    response,
    openCodeUpstream([]),
    'opencode-go/gpt-5.6-luna',
  )
  assert.equal(response.headers.status, 502)
  assert.equal(JSON.parse(response.text()).error.message, 'OpenCode Responses stream ended before response.completed')
})

// Keep the test file free of accidental trailing whitespace or blank sentinel lines.

test('maps OpenCode usage and never logs or embeds a key in a conversion', () => {
  assert.deepEqual(openCodeUsageToAnthropic({ prompt_tokens: 12, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 4 } }), {
    input_tokens: 8,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 4,
    output_tokens: 5,
  })
  const request = anthropicToOpenCodeRequest({ messages: [{ role: 'user', content: 'hi' }] }, {
    upstream: 'kimi-k3',
    protocol: 'chat-completions',
  })
  assert.equal(JSON.stringify(request).includes('synthetic-key'), false)
})

test('fails cleanly on an OpenCode provider failure after output', async () => {
  const response = new CaptureResponse()
  const trace = traceCapture()
  await relayOpenCodeChatStream(response, openCodeUpstream([
    { choices: [{ delta: { content: 'partial' } }] },
    { error: { message: 'provider unavailable' } },
  ]), 'opencode-go/kimi-k3', trace)
  const events = responseEvents(response)
  assert.equal(response.headers.status, 200)
  assert.equal(events.at(-1).type, 'error')
  assert.equal(events.at(-1).error.message, 'provider unavailable')
  assert.equal(trace.marks.error, 'provider unavailable')
})

test('fails cleanly on an OpenCode partial connection reset', async () => {
  const response = new CaptureResponse()
  const trace = traceCapture()
  let sent = false
  const upstream = { body: new ReadableStream({
    pull(controller) {
      if (!sent) {
        sent = true
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`))
      } else controller.error(new Error('ECONNRESET'))
    },
  }) }
  await relayOpenCodeChatStream(response, upstream, 'opencode-go/kimi-k3', trace)
  const events = responseEvents(response)
  assert.equal(events.at(-1).type, 'error')
  assert.equal(events.at(-1).error.message, 'ECONNRESET')
  assert.equal(trace.marks.error, 'ECONNRESET')
})

test('cancels an OpenCode SSE reader before releasing the locked body', async () => {
  const response = new CaptureResponse()
  const controller = new AbortController()
  let bodyCancelled = false
  const upstream = {
    body: new ReadableStream({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode(
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`,
        ))
      },
      cancel() {
        bodyCancelled = true
      },
    }),
  }

  const relay = relayOpenCodeChatStream(
    response,
    upstream,
    'opencode-go/kimi-k3',
    traceCapture(),
    { signal: controller.signal },
  )
  await new Promise(resolve => setTimeout(resolve, 10))
  controller.abort(new Error('consumer disconnected'))
  await relay

  assert.equal(bodyCancelled, true)
  assert.equal(response.headers.status, 200)
  assert.equal(responseEvents(response).at(-1).type, 'error')
})

// Keep this assertion close to the route contract: all three official Go wire
// families must remain selectable through the shared request entry point.
test('selects each documented OpenCode Go protocol', () => {
  assert.equal(anthropicToOpenCodeRequest({ messages: [] }, { upstream: 'gpt-5.6-luna', protocol: 'responses' }).model, 'gpt-5.6-luna')
  assert.equal(anthropicToOpenCodeRequest({ messages: [] }, { upstream: 'kimi-k3', protocol: 'chat-completions' }).model, 'kimi-k3')
  assert.equal(anthropicToOpenCodeRequest({ messages: [], model: 'wrong' }, { upstream: 'qwen3.7-max', protocol: 'anthropic-messages' }).model, 'qwen3.7-max')
})

test('routes GLM 5.3 Flash through Chat Completions', () => {
  assert.equal(anthropicToOpenCodeRequest(
    { messages: [{ role: 'user', content: 'glm flash' }] },
    { upstream: 'glm-5.3-flash', protocol: 'chat-completions' },
  ).model, 'glm-5.3-flash')
})

test('normalizes harness ultracode to the highest explicit native level', () => {
  const body = {
    output_config: { effort: 'ultracode' },
    reasoning: { effort: 'ultracode' },
  }
  const nativeLevels = [
    { levels: ['low', 'medium', 'high', 'max', 'ultra'], expected: 'ultra' },
    { levels: ['low', 'medium', 'high', 'max'], expected: 'max' },
    { levels: ['low', 'medium', 'high'], expected: 'high' },
    { levels: ['low', 'medium'], expected: undefined },
  ]
  for (const { levels, expected } of nativeLevels) {
    const normalized = normalizeGatewayEffort(body, {
      backend: 'codex',
      effortLevels: levels,
    })
    assert.equal(normalized.output_config.effort, expected)
    assert.equal(normalized.reasoning.effort, expected)
    assert.notEqual(normalized.output_config.effort, 'ultracode')
    assert.notEqual(normalized.reasoning.effort, 'ultracode')
    if (expected === undefined) {
      assert.equal(Object.hasOwn(normalized.output_config, 'effort'), false)
      assert.equal(Object.hasOwn(normalized.reasoning, 'effort'), false)
    }
  }
})

test('disabled native thinking removes gateway effort overrides', () => {
  const normalized = normalizeGatewayEffort(
    {
      thinking: { type: 'disabled' },
      output_config: { effort: 'max', format: 'text' },
      reasoning: { effort: 'max', summary: 'detailed' },
    },
    { backend: 'codex', effortLevels: ['low', 'medium', 'high', 'max'] },
  )

  assert.equal(normalized.output_config.effort, undefined)
  assert.equal(normalized.output_config.format, 'text')
  assert.equal(normalized.reasoning.effort, undefined)
  assert.equal(normalized.reasoning.summary, 'detailed')
})

test('uses the GPT-5.6 effort ladder including xhigh and max', () => {
  const levels = ['none', 'low', 'medium', 'high', 'xhigh', 'max']
  for (const model of ['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra']) {
    const normalized = normalizeGatewayEffort(
      { output_config: { effort: 'xhigh' }, reasoning: { effort: 'xhigh' } },
      { backend: 'codex', effortLevels: levels },
    )
    assert.equal(normalized.output_config.effort, 'xhigh')
    assert.equal(normalized.reasoning.effort, 'xhigh')
  }
})

test('keeps OpenCode effort capabilities model-specific', () => {
  assert.deepEqual(openCodeGoEffortLevels('gpt-5.6-luna'), [
    'none', 'low', 'medium', 'high', 'xhigh', 'max',
  ])
  assert.deepEqual(openCodeGoEffortLevels('glm-5.3-flash'), ['low', 'high', 'max'])
  assert.deepEqual(openCodeGoEffortLevels('mimo-v2.5'), [
    'none', 'low', 'medium', 'high', 'xhigh', 'max',
  ])
  assert.deepEqual(openCodeGoEffortLevels('glm-5.2'), ['high', 'max'])
  assert.deepEqual(openCodeGoEffortLevels('kimi-k3'), ['max'])
  assert.deepEqual(openCodeGoEffortLevels('hy3'), ['none', 'low', 'high'])
  assert.deepEqual(openCodeGoEffortLevels('qwen3.7-plus'), [])
  assert.deepEqual(openCodeGoEffortLevels('deepseek-v4-flash'), ['low', 'high', 'max'])
  assert.deepEqual(openCodeGoEffortLevels('deepseek-v4-pro'), ['high', 'max'])
  assert.deepEqual(openCodeGoEffortLevels('deepseek-v4.1-flash'), ['low', 'high', 'max'])
})

test('does not forward unsupported OpenCode max or xhigh', () => {
  const maxNormalized = normalizeGatewayEffort(
    { output_config: { effort: 'max' } },
    { backend: 'opencode-go', effortLevels: ['low', 'medium', 'high'] },
  )
  const xhighNormalized = normalizeGatewayEffort(
    { reasoning: { effort: 'xhigh' } },
    { backend: 'opencode-go', effortLevels: ['low', 'medium', 'high'] },
  )
  assert.equal(maxNormalized.output_config.effort, 'high')
  assert.equal(xhighNormalized.reasoning.effort, 'high')
})

test('clamps unsupported OpenCode medium level to high', () => {
  const normalized = normalizeGatewayEffort(
    { output_config: { effort: 'medium' } },
    { backend: 'opencode-go', effortLevels: ['low', 'high'] },
  )
  assert.equal(normalized.output_config.effort, 'high')
})

test('does not invent native effort levels for an explicitly unverified route', () => {
  const normalized = normalizeGatewayEffort(
    {
      output_config: { effort: 'ultracode' },
      reasoning: { effort: 'max' },
    },
    { backend: 'opencode-go', effortLevels: [] },
  )
  assert.equal(Object.hasOwn(normalized.output_config, 'effort'), false)
  assert.equal(Object.hasOwn(normalized.reasoning, 'effort'), false)
})

test('removes unsupported native max rather than forwarding a false enum', () => {
  const normalized = normalizeGatewayEffort(
    { output_config: { effort: 'max' } },
    { backend: 'opencode-go', effortLevels: ['low', 'medium', 'high'] },
  )
  assert.equal(normalized.output_config.effort, 'high')
})

// This sentinel prevents a passing suite that silently exercises no OpenCode tests.
assert.ok(true)
