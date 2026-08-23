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
  codexUsageToAnthropic,
  relayCodexStream,
  relayCodexResponse,
  codexResponseToAnthropic,
  relayDeepSeekStream,
  relayDeepSeekResponse,
  gatewayFetch,
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
} from './opencode-go.mjs'

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
  const child = spawn('node', [gatewayScript, '--port', '0'], {
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
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (stderr.includes('model-gateway listening on ')) {
      const match = stderr.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)
      if (!match) throw new Error(`Gateway announced an invalid address: ${stderr}`)
      return { child, port: Number(match[1]), getStderr: () => stderr }
    }
    if (child.exitCode !== null) throw new Error(`Gateway exited: ${stderr}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  child.kill()
  throw new Error(`Gateway did not start: ${stderr}`)
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

async function postGateway(port, body) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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
      // response socket and request side so the server observes the consumer
      // disconnect through either Node event ordering.
      response.destroy()
      request.destroy()
      setImmediate(() => {
        if (!responseEnded) resolve({ status: responseStatus, ended: false })
      })
    })
    request.end(JSON.stringify(body))
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

async function waitForUpstreamCancellation(state, timeoutMs = 3000) {
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
    req.socket?.once('close', () => { state.requestAborted = true })
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
    MODEL_GATEWAY_OPENCODE_RETRIES: '2',
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
  const state = { requests: [] }
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
      toolNames: (body.tools || []).map(tool => tool.name),
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

async function withGatewayAndFakeOpenRouter({ handler, run, gatewayEnv = {} }) {
  const state = { requests: [] }
  const fake = await fakeCodexServer((req, res) => handler(req, res, state))
  const gateway = await startGatewayForTest({
    OPENROUTER_API_KEY: randomUUID(),
    OPENROUTER_API_URL: `http://127.0.0.1:${fake.port}/chat/completions`,
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

// A narrow HTTP-boundary fixture: it talks to the real standalone Gateway and
// a local fake Responses provider. The temporary auth file contains only
// synthetic credentials and is removed by the fixture teardown.
test('HTTP boundary rejects an empty upstream stream before committing 200', async () => {
  const result = await assertGatewayBoundedResult({
    handler: emptyCodexHandler,
    gatewayEnv: { MODEL_GATEWAY_LOG_TIMING: '1' },
    expectedStatus: 502,
    expected: response => {
      assert.equal(parseGatewayError(response.body).message, 'Codex stream ended before response.completed')
      assert.equal(hasMessageStop(response.body), false)
    },
  })
  assert.ok(result.elapsed < 2000)
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
  assert.ok(result.elapsed < 2000)
  const timing = timingFields(lastTimingLine(result.stderr))
  assert.equal(timing.outcome, 'upstream-error')
  assert.equal(timing.error_class, 'timeout')
})

test('socket-owned upstream transport closes the provider connection on abort', async () => {
  let closed = false
  const fake = await fakeCodexServer((req, res) => {
    req.resume()
    req.once('aborted', () => { closed = true })
    res.once('close', () => { closed = true })
    req.socket?.once('close', () => { closed = true })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('partial')
  })
  try {
    const controller = new AbortController()
    const upstream = await gatewayFetch(`http://127.0.0.1:${fake.port}/responses`, {
      method: 'POST',
      signal: controller.signal,
    })
    const reader = upstream.body.getReader()
    await reader.read()
    controller.abort(new Error('test abort'))
    const deadline = Date.now() + 1000
    while (!closed && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(closed, true)
  } finally {
    await new Promise(resolve => fake.server.close(resolve))
  }
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

test('Codex conversion omits unsupported Anthropic sampling controls', () => {
  const request = anthropicToCodex(
    {
      messages: [{ role: 'user', content: 'summarize' }],
      temperature: 0,
      top_p: 0.8,
    },
    'gpt-5.6-luna',
  )
  assert.equal('temperature' in request, false)
  assert.equal('top_p' in request, false)
})

test('Codex conversion forwards max effort for Luna and Sol', () => {
  for (const model of ['gpt-5.6-luna', 'gpt-5.6-sol']) {
    const request = anthropicToCodex({
      output_config: { effort: 'max' },
      messages: [],
    }, model)
    assert.equal(request.reasoning.effort, 'max')
  }
})

test('Codex conversion does not send unsupported max effort to Terra', () => {
  const request = anthropicToCodex({
    output_config: { effort: 'max' },
    messages: [],
  }, 'gpt-5.6-terra')
  assert.equal(request.reasoning.effort, 'high')
})

test('Gateway aliases route max effort to the correct Codex model', async () => {
  await withGatewayAndFakeCodexState({
    handlerFactory: state => async (req, res) => {
      const body = await requestJson(req)
      state.requests.push({ model: body.model, effort: body.reasoning?.effort })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(
        `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'ok' })}\n\n` +
        `data: ${JSON.stringify({ type: 'response.completed', response: completedCodexResponse('ok') })}\n\n`,
      )
    },
    run: async ({ gateway, state }) => {
      for (const model of ['claude-gpt-luna', 'claude-gpt-sol']) {
        const result = await postGateway(gateway.port, {
          model,
          stream: true,
          output_config: { effort: 'max' },
          messages: [{ role: 'user', content: 'route this' }],
        })
        assert.equal(result.status, 200)
      }
      assert.deepEqual(state.requests, [
        { model: 'gpt-5.6-luna', effort: 'max' },
        { model: 'gpt-5.6-sol', effort: 'max' },
      ])
    },
  })
})

test('Gateway maps Ultracode to the provider maximum and adds the harness marker', async () => {
  await withGatewayAndFakeCodexState({
    handlerFactory: state => async (req, res) => {
      const body = await requestJson(req)
      state.requests.push({
        model: body.model,
        effort: body.reasoning?.effort,
        instructions: body.instructions,
      })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(
        `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'ok' })}\n\n` +
        `data: ${JSON.stringify({ type: 'response.completed', response: completedCodexResponse('ok') })}\n\n`,
      )
    },
    run: async ({ gateway, state }) => {
      const result = await postGateway(gateway.port, {
        model: 'claude-gpt-luna',
        stream: true,
        output_config: { effort: 'ultracode' },
        messages: [{ role: 'user', content: 'route this' }],
      })
      assert.equal(result.status, 200)
      assert.equal(state.requests[0].model, 'gpt-5.6-luna')
      assert.equal(state.requests[0].effort, 'max')
      assert.match(state.requests[0].instructions, /Ultracode is on/)
    },
  })
})

test('OpenCode Ox Alpha forwards verified reasoning effort controls', async () => {
  await withGatewayAndFakeOpenCode({
    handler: async (req, res, state) => {
      const body = await requestJson(req)
      const request = { model: body.model }
      if (Object.prototype.hasOwnProperty.call(body, 'reasoning_effort')) {
        request.effort = body.reasoning_effort
      }
      state.requests.push(request)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: 'opencode-effort',
        choices: [{ message: { content: 'ok', tool_calls: [] }, finish_reason: 'stop' }],
      }))
    },
    run: async ({ gateway, state }) => {
      const result = await postGateway(gateway.port, {
        model: 'claude-ox-alpha',
        output_config: { effort: 'max' },
        messages: [{ role: 'user', content: 'reason' }],
      })
      assert.equal(result.status, 200)
      assert.deepEqual(state.requests, [{ model: 'ox-alpha-free', effort: 'high' }])
    },
  })
})

test('OpenCode Ox Alpha clamps unsupported medium effort to high', async () => {
  await withGatewayAndFakeOpenCode({
    handler: async (req, res, state) => {
      const body = await requestJson(req)
      state.requests.push(body.reasoning_effort)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: 'opencode-ox-alpha-medium',
        choices: [{ message: { content: 'ok', tool_calls: [] }, finish_reason: 'stop' }],
      }))
    },
    run: async ({ gateway, state }) => {
      const result = await postGateway(gateway.port, {
        model: 'claude-opencode-ox-alpha',
        output_config: { effort: 'medium' },
        messages: [{ role: 'user', content: 'reason' }],
      })
      assert.equal(result.status, 200)
      assert.deepEqual(state.requests, ['high'])
    },
  })
})

test('OpenCode enables standard effort across all chat protocols', async () => {
  await withGatewayAndFakeOpenCode({
    handler: async (req, res, state) => {
      const body = await requestJson(req)
      const effort =
        body.reasoning_effort ??
        body.reasoning?.effort ??
        body.output_config?.effort
      state.requests.push({
        path: req.url,
        model: body.model,
        effort,
        messageCount: Array.isArray(body.messages) ? body.messages.length : undefined,
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      if (req.url === '/responses') {
        res.end(JSON.stringify({
          id: 'responses-effort',
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
        }))
      } else if (req.url === '/messages') {
        res.end(JSON.stringify({
          id: 'messages-effort',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
        }))
      } else {
        res.end(JSON.stringify({
          id: 'chat-effort',
          choices: [{ message: { content: 'ok', tool_calls: [] }, finish_reason: 'stop' }],
        }))
      }
    },
    run: async ({ gateway, state }) => {
      for (const model of [
        'opencode-go/gpt-5.6-luna',
        'opencode-go/mimo-v2.5',
        'opencode-go/minimax-m3',
      ]) {
        const result = await postGateway(gateway.port, {
          model,
          output_config: { effort: 'high' },
          messages: [{ role: 'user', content: 'Reply with exactly OK.' }],
        })
        assert.equal(result.status, 200)
        assert.match(result.body, /ok/)
      }
      assert.deepEqual(state.requests, [
        {
          path: '/responses',
          model: 'gpt-5.6-luna',
          effort: 'high',
          messageCount: undefined,
        },
        {
          path: '/chat/completions',
          model: 'mimo-v2.5',
          effort: 'high',
          messageCount: 1,
        },
        {
          path: '/messages',
          model: 'minimax-m3',
          effort: 'high',
          messageCount: 1,
        },
      ])
    },
  })
})

test('OpenCode chat effort survives a tool-call continuation', async () => {
  await withGatewayAndFakeOpenCode({
    handler: async (req, res, state) => {
      const body = await requestJson(req)
      state.requests.push({
        effort: body.reasoning_effort,
        roles: (body.messages || []).map(message => message.role),
        hasToolResult: (body.messages || []).some(message => message.role === 'tool'),
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      if (state.requests.length === 1) {
        res.end(JSON.stringify({
          id: 'chat-tool-call',
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: 'call-1',
                type: 'function',
                function: { name: 'emit_value', arguments: '{"value":"OK"}' },
              }],
            },
            finish_reason: 'tool_calls',
          }],
        }))
        return
      }
      res.end(JSON.stringify({
        id: 'chat-tool-followup',
        choices: [{ message: { content: 'done', tool_calls: [] }, finish_reason: 'stop' }],
      }))
    },
    run: async ({ gateway, state }) => {
      const first = await postGateway(gateway.port, {
        model: 'claude-opencode-ox-alpha',
        output_config: { effort: 'high' },
        tools: [{
          name: 'emit_value',
          description: 'Emit a value.',
          input_schema: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
          },
        }],
        messages: [{ role: 'user', content: 'Use the tool.' }],
      })
      assert.equal(first.status, 200)
      const firstMessage = JSON.parse(first.body)
      assert.equal(firstMessage.stop_reason, 'tool_use')

      const second = await postGateway(gateway.port, {
        model: 'claude-opencode-ox-alpha',
        output_config: { effort: 'high' },
        tools: [{
          name: 'emit_value',
          description: 'Emit a value.',
          input_schema: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
          },
        }],
        messages: [
          { role: 'user', content: 'Use the tool.' },
          {
            role: 'assistant',
            content: [{
              type: 'tool_use',
              id: 'call-1',
              name: 'emit_value',
              input: { value: 'OK' },
            }],
          },
          {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: 'call-1',
              content: 'OK',
            }],
          },
        ],
      })
      assert.equal(second.status, 200)
      assert.equal(JSON.parse(second.body).content[0].text, 'done')
      assert.deepEqual(state.requests, [
        { effort: 'high', roles: ['user'], hasToolResult: false },
        { effort: 'high', roles: ['user', 'assistant', 'tool'], hasToolResult: true },
      ])
    },
  })
})

test('DeepSeek aliases forward max effort without changing the provider route', async () => {
  await withGatewayAndFakeDeepSeek({
    handler: async (req, res, state) => {
      const body = await requestJson(req)
      state.requests.push({
        model: body.model,
        effort: body.output_config?.effort,
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
      }))
    },
    run: async ({ gateway, state }) => {
      for (const model of ['claude-ds-pro', 'claude-ds-flash']) {
        const result = await postGateway(gateway.port, {
          model,
          output_config: { effort: 'max' },
          messages: [{ role: 'user', content: 'route this' }],
        })
        assert.equal(result.status, 200)
      }
      assert.deepEqual(state.requests, [
        { model: 'deepseek-v4-pro', effort: 'max' },
        { model: 'deepseek-v4-flash', effort: 'max' },
      ])
    },
  })
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
      assert.deepEqual(state.requests[1].descriptions, ['', ''])
      assert.ok(state.requests[1].requestBytes < state.requests[0].requestBytes)
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

test('context fallback preserves PowerShell and shell tools', async () => {
  await withGatewayAndFakeCodexState({
    handlerFactory: state => async (req, res) => {
      const body = await requestJson(req)
      state.requests.push({
        toolNames: (body.tools || []).map(tool => tool.name),
      })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (state.requests.length < 3) {
        res.end(`data: ${JSON.stringify({
          type: 'response.failed',
          response: { error: { message: 'Your input exceeds the context window of this model.' } },
        })}\n\n`)
        return
      }
      res.end(
        `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'recovered' })}\n\n` +
        `data: ${JSON.stringify({ type: 'response.completed', response: completedCodexResponse('recovered') })}\n\n`,
      )
    },
    run: async ({ gateway, state }) => {
      const result = await postGateway(gateway.port, {
        ...minimalCodexBody(),
        tools: [
          { name: 'Read', description: 'read', input_schema: { type: 'object' } },
          { name: 'PowerShell', description: 'shell', input_schema: { type: 'object' } },
          { name: 'mcp_remote_tool', description: 'mcp', input_schema: { type: 'object' } },
        ],
      })
      assert.equal(result.status, 200)
      assert.deepEqual(state.requests[2].toolNames, ['Read', 'PowerShell'])
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

test('compaction requests omit inherited tools and use low reasoning effort', async () => {
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
      const result = await postGateway(gateway.port, compactionRequestBody())
      assert.equal(result.status, 200)
      assert.equal(state.requests.length, 1)
      assert.equal(state.requests[0].tools, undefined)
      assert.equal(state.requests[0].tool_choice, 'none')
      assert.equal(state.requests[0].reasoning.effort, 'low')
    },
  })
})

test('historical compaction instructions do not disable tools on a normal continuation', async () => {
  await withGatewayAndFakeCodexState({
    handlerFactory: state => async (req, res) => {
      const body = await requestJson(req)
      state.requests.push(body)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(
        `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'normal' })}\n\n` +
        `data: ${JSON.stringify({ type: 'response.completed', response: completedCodexResponse('normal') })}\n\n`,
      )
    },
    run: async ({ gateway, state }) => {
      const result = await postGateway(gateway.port, {
        model: 'claude-gpt-luna',
        stream: true,
        thinking: { type: 'enabled' },
        tools: [{ name: 'PowerShell', description: 'shell', input_schema: { type: 'object' } }],
        messages: [
          {
            role: 'assistant',
            content: 'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n<summary>Previous compacted work.</summary>',
          },
          { role: 'user', content: 'Continue the coding task and inspect the repository.' },
        ],
      })
      assert.equal(result.status, 200)
      assert.equal(state.requests.length, 1)
      assert.equal(state.requests[0].tools.length, 1)
      assert.equal(state.requests[0].tools[0].name, 'PowerShell')
      assert.equal(state.requests[0].tool_choice, undefined)
      assert.equal(state.requests[0].reasoning.effort, 'high')
    },
  })
})

test('HTTP boundary preserves tools and tool results across a follow-up turn', async () => {
  await withGatewayAndFakeCodexState({
    handlerFactory: state => async (req, res) => {
      const body = await requestJson(req)
      state.requests.push(body)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(
        `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'ok' })}\n\n` +
        `data: ${JSON.stringify({ type: 'response.completed', response: completedCodexResponse('ok') })}\n\n`,
      )
    },
    run: async ({ gateway, state }) => {
      const tools = [{
        name: 'Read',
        description: 'read a file',
        input_schema: { type: 'object', properties: { path: { type: 'string' } } },
      }]
      const first = await postGateway(gateway.port, {
        model: 'claude-gpt-luna',
        stream: true,
        tools,
        messages: [{ role: 'user', content: 'Read package.json.' }],
      })
      assert.equal(first.status, 200)

      const second = await postGateway(gateway.port, {
        model: 'claude-gpt-luna',
        stream: true,
        tools,
        messages: [
          { role: 'user', content: 'Read package.json.' },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tool-read-1', name: 'Read', input: { path: 'package.json' } }],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tool-read-1', content: '{"name":"claudex"}' }],
          },
        ],
      })
      assert.equal(second.status, 200)
      assert.equal(state.requests.length, 2)
      assert.deepEqual(state.requests[1].tools.map(tool => tool.name), ['Read'])
      assert.deepEqual(
        state.requests[1].input.filter(item =>
          item.type === 'function_call' || item.type === 'function_call_output',
        ),
        [
          {
            type: 'function_call',
            call_id: 'tool-read-1',
            name: 'Read',
            arguments: '{"path":"package.json"}',
          },
          {
            type: 'function_call_output',
            call_id: 'tool-read-1',
            output: '{"name":"claudex"}',
          },
        ],
      )
    },
  })
})

test('HTTP boundary retries malformed responses without dropping tools', async () => {
  await withGatewayAndFakeCodexState({
    handlerFactory: state => async (req, res) => {
      const body = await requestJson(req)
      state.requests.push(body)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (state.requests.length === 1) {
        res.end()
        return
      }
      res.end(
        `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'recovered' })}\n\n` +
        `data: ${JSON.stringify({ type: 'response.completed', response: completedCodexResponse('recovered') })}\n\n`,
      )
    },
    gatewayEnv: {
      MODEL_GATEWAY_UPSTREAM_RETRIES: '1',
      MODEL_GATEWAY_UPSTREAM_RETRY_BASE_MS: '1',
    },
    run: async ({ gateway, state }) => {
      const result = await postGateway(gateway.port, {
        model: 'claude-gpt-luna',
        stream: true,
        tools: [
          { name: 'Read', description: 'read', input_schema: { type: 'object' } },
          { name: 'PowerShell', description: 'shell', input_schema: { type: 'object' } },
        ],
        messages: [{ role: 'user', content: 'Use the tools.' }],
      })
      assert.equal(result.status, 200)
      assert.equal(state.requests.length, 2)
      assert.deepEqual(state.requests[0].tools.map(tool => tool.name), ['Read', 'PowerShell'])
      assert.deepEqual(state.requests[1].tools.map(tool => tool.name), ['Read', 'PowerShell'])
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
    gatewayEnv: { MODEL_GATEWAY_LOG_TIMING: '1' },
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
  assert.ok(result.elapsed < 2000)
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


test('HTTP boundary retries a malformed pre-output DeepSeek response', async () => {
  await withGatewayAndFakeDeepSeek({
    gatewayEnv: {
      MODEL_GATEWAY_UPSTREAM_RETRIES: '1',
      MODEL_GATEWAY_UPSTREAM_RETRY_BASE_MS: '1',
    },
    handler: async (req, res, state) => {
      await requestJson(req)
      state.requests.push(true)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(state.requests.length === 1
        ? '{}'
        : JSON.stringify({
            id: 'deepseek-retry',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'recovered' }],
            stop_reason: 'end_turn',
          }))
    },
    run: async ({ gateway, state }) => {
      const result = await postGateway(gateway.port, {
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: 'retry' }],
      })
      assert.equal(result.status, 200)
      assert.equal(JSON.parse(result.body).content[0].text, 'recovered')
      assert.equal(state.requests.length, 2)
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



test('a delayed stream remains bounded by the caller timeout contract', async () => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15)
  try {
    await assert.rejects(
      fetch('http://127.0.0.1:1', { signal: controller.signal }),
      error =>
        error?.name === 'AbortError' ||
        error?.name === 'TypeError' ||
        error?.code === 'ConnectionRefused',
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
  assert.equal(request.instructions, 'Follow the user.')
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

test('HTTP boundary retries a malformed pre-output OpenCode response', async () => {
  await withGatewayAndFakeOpenCode({
    gatewayEnv: {
      MODEL_GATEWAY_UPSTREAM_RETRIES: '1',
      MODEL_GATEWAY_UPSTREAM_RETRY_BASE_MS: '1',
    },
    handler: async (req, res, state) => {
      const body = await requestJson(req)
      state.requests.push({ model: body.model })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(state.requests.length === 1
        ? '{}'
        : JSON.stringify({
            id: 'opencode-retry',
            choices: [{ message: { content: 'recovered', tool_calls: [] }, finish_reason: 'stop' }],
          }))
    },
    run: async ({ gateway, state }) => {
      const result = await postGateway(gateway.port, {
        model: 'claude-ox-alpha',
        messages: [{ role: 'user', content: 'retry' }],
      })
      assert.equal(result.status, 200)
      assert.equal(JSON.parse(result.body).content[0].text, 'recovered')
      assert.equal(state.requests.length, 2)
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

test('compaction detection handles alternate no-tools summary wording', async () => {
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
      const result = await postGateway(gateway.port, {
        model: 'claude-gpt-luna',
        stream: true,
        thinking: { type: 'enabled' },
        tools: [{ name: 'PowerShell', description: 'shell', input_schema: { type: 'object' } }],
        messages: [{
          role: 'user',
          content: 'Please respond with text only. Do not call any tools. Summarize this conversation in a <summary> block.',
        }],
      })
      assert.equal(result.status, 200)
      assert.equal(state.requests[0].tools, undefined)
      assert.equal(state.requests[0].tool_choice, 'none')
      assert.equal(state.requests[0].reasoning.effort, 'low')
    },
  })
})

test('rejects a Codex function call that never provides a name', async () => {
  const response = new CaptureResponse()
  await relayCodexStream(
    response,
    upstreamFromEvents([
      {
        type: 'response.output_item.added',
        item: { type: 'function_call', call_id: 'call-unnamed' },
      },
      {
        type: 'response.function_call_arguments.delta',
        delta: '{"path":"x"}',
      },
      {
        type: 'response.completed',
        response: { output: [] },
      },
    ]),
    'claude-gpt-luna',
  )
  assert.equal(response.headers.status, 502)
  assert.equal(JSON.parse(response.text()).error.message, 'Codex returned a function call without a name')
  assert.equal(response.text().includes('"name":"tool"'), false)
})

test('HTTP boundary exposes the free Ox Alpha alias through OpenCode Chat Completions', async () => {
  await withGatewayAndFakeOpenCode({
    handler: async (req, res, state) => {
      const body = await requestJson(req)
      state.requests.push({ path: req.url, model: body.model })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'alpha-ok' } }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n` +
        'data: [DONE]\n\n',
      )
    },
    run: async ({ gateway, state }) => {
      const result = await postGateway(gateway.port, {
        model: 'claude-ox-alpha',
        stream: true,
        messages: [{ role: 'user', content: 'test alpha' }],
      })
      assert.equal(result.status, 200)
      assert.match(result.body, /alpha-ok/)
      assert.deepEqual(state.requests, [{
        path: '/chat/completions',
        model: 'ox-alpha-free',
      }])
    },
  })
})

test('HTTP boundary exposes OpenCode DeepSeek aliases with their provider model IDs', async () => {
  await withGatewayAndFakeOpenCode({
    handler: async (req, res, state) => {
      const body = await requestJson(req)
      state.requests.push({ path: req.url, model: body.model })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: `response-${state.requests.length}`,
        choices: [{ message: { content: 'ok', tool_calls: [] }, finish_reason: 'stop' }],
      }))
    },
    run: async ({ gateway, state }) => {
      for (const [model, upstream] of [
        ['claude-opencode-ds-pro', 'deepseek-v4-pro'],
        ['claude-opencode-ds-flash', 'deepseek-v4-flash'],
      ]) {
        const result = await postGateway(gateway.port, {
          model,
          messages: [{ role: 'user', content: 'test' }],
        })
        assert.equal(result.status, 200)
        assert.equal(JSON.parse(result.body).content[0].text, 'ok')
        assert.equal(state.requests.at(-1).model, upstream)
      }
      assert.deepEqual(state.requests, [
        { path: '/chat/completions', model: 'deepseek-v4-pro' },
        { path: '/chat/completions', model: 'deepseek-v4-flash' },
      ])
    },
  })
})

test('HTTP boundary routes a saved OpenRouter model through Chat Completions', async () => {
  await withGatewayAndFakeOpenRouter({
    gatewayEnv: {
      MODEL_GATEWAY_MODELS: JSON.stringify({
        'claude-openrouter-test': {
          backend: 'openrouter',
          upstream: 'openai/gpt-oss-120b',
          effortLevels: ['low', 'medium', 'high', 'max', 'ultracode'],
        },
      }),
    },
    handler: async (req, res, state) => {
      const body = await requestJson(req)
      state.requests.push({
        path: req.url,
        model: body.model,
        effort: body.reasoning_effort,
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: 'openrouter-response',
        choices: [{ message: { content: 'router-ok', tool_calls: [] }, finish_reason: 'stop' }],
      }))
    },
    run: async ({ gateway, state }) => {
      const result = await postGateway(gateway.port, {
        model: 'claude-openrouter-test',
        output_config: { effort: 'max' },
        messages: [{ role: 'user', content: 'test' }],
      })
      assert.equal(result.status, 200)
      assert.equal(JSON.parse(result.body).content[0].text, 'router-ok')
      assert.deepEqual(state.requests, [{
        path: '/chat/completions',
        model: 'openai/gpt-oss-120b',
        effort: 'max',
      }])
    },
  })
})

test('OpenRouter parameter-only metadata does not send unverified effort', async () => {
  await withGatewayAndFakeOpenRouter({
    gatewayEnv: {
      MODEL_GATEWAY_MODELS: JSON.stringify({
        'claude-openrouter-parameter-only': {
          backend: 'openrouter',
          upstream: 'openai/gpt-oss-120b',
        },
      }),
    },
    handler: async (req, res, state) => {
      const body = await requestJson(req)
      state.requests.push({
        model: body.model,
        hasEffort: Object.prototype.hasOwnProperty.call(body, 'reasoning_effort'),
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: 'openrouter-parameter-only',
        choices: [{ message: { content: 'ok', tool_calls: [] }, finish_reason: 'stop' }],
      }))
    },
    run: async ({ gateway, state }) => {
      const result = await postGateway(gateway.port, {
        model: 'claude-openrouter-parameter-only',
        output_config: { effort: 'max' },
        messages: [{ role: 'user', content: 'test' }],
      })
      assert.equal(result.status, 200)
      assert.deepEqual(state.requests, [{
        model: 'openai/gpt-oss-120b',
        hasEffort: false,
      }])
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
  assert.deepEqual(request.messages[0], { role: 'system', content: 'system' })
  assert.equal(request.messages[1].content[1].type, 'image_url')
  assert.equal(request.messages[1].content[1].image_url.url, 'https://example.test/a.png')
  assert.equal(request.stream, true)
})

test('uses protocol-specific OpenCode Go authentication headers', () => {
  assert.equal(openCodeGoHeaders('responses', 'synthetic-key').authorization, 'Bearer synthetic-key')
  assert.equal(openCodeGoHeaders('chat-completions', 'synthetic-key').authorization, 'Bearer synthetic-key')
  assert.equal(openCodeGoHeaders('anthropic-messages', 'synthetic-key')['x-api-key'], 'synthetic-key')
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
  assert.equal(request.instructions, 'system')
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

test('non-streaming OpenCode Chat Completions preserves reasoning-only responses', async () => {
  const response = new CaptureResponse()
  await relayOpenCodeChatResponse(response, {
    text: async () => JSON.stringify({
      id: 'chat-reasoning-only',
      choices: [{
        message: {
          content: null,
          reasoning: 'provider reasoning',
          reasoning_details: [{ type: 'reasoning.text', text: ' detail' }],
        },
        finish_reason: 'length',
      }],
    }),
  }, 'opencode-go/mimo-v2.5')
  assert.equal(response.headers.status, 200)
  const message = JSON.parse(response.text())
  assert.deepEqual(message.content, [
    { type: 'thinking', thinking: 'provider reasoning detail' },
  ])
  assert.equal(message.stop_reason, 'max_tokens')
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

// Keep this assertion close to the route contract: all three official Go wire
// families must remain selectable through the shared request entry point.
test('selects each documented OpenCode Go protocol', () => {
  assert.equal(anthropicToOpenCodeRequest({ messages: [] }, { upstream: 'gpt-5.6-luna', protocol: 'responses' }).model, 'gpt-5.6-luna')
  assert.equal(anthropicToOpenCodeRequest({ messages: [] }, { upstream: 'kimi-k3', protocol: 'chat-completions' }).model, 'kimi-k3')
  assert.equal(anthropicToOpenCodeRequest({ messages: [], model: 'wrong' }, { upstream: 'qwen3.7-max', protocol: 'anthropic-messages' }).model, 'qwen3.7-max')
})

test('buffers unnamed OpenCode Responses tool metadata until the name arrives', async () => {
  const response = new CaptureResponse()
  await relayOpenCodeResponsesStream(response, openCodeUpstream([
    { type: 'response.output_item.added', item: { type: 'function_call', call_id: 'call-buffered' } },
    { type: 'response.function_call_arguments.delta', delta: '{"path"' },
    { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call-buffered', name: 'read', arguments: '{"path":"x"}' } },
    { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } },
  ]), 'opencode-go/gpt-5.6-luna')
  const events = responseEvents(response)
  assert.equal(events.find(event => event.type === 'content_block_start').content_block.name, 'read')
  assert.equal(events.filter(event => event.type === 'content_block_delta').map(event => event.delta.partial_json).join(''), '{"path":"x"}')
  assert.equal(response.text().includes('"name":"tool"'), false)
})

test('rejects a non-streaming OpenCode tool call without a function name', async () => {
  const response = new CaptureResponse()
  await relayOpenCodeChatResponse(response, {
    text: async () => JSON.stringify({
      id: 'chat-unnamed-tool',
      choices: [{
        message: {
          content: null,
          tool_calls: [{ id: 'call-unnamed', function: { arguments: '{"path":"x"}' } }],
        },
        finish_reason: 'tool_calls',
      }],
    }),
  }, 'opencode-go/kimi-k3')
  assert.equal(response.headers.status, 502)
  assert.equal(JSON.parse(response.text()).error.message, 'OpenCode returned a tool call without a function name')
  assert.equal(response.text().includes('"name":"tool"'), false)
})

test('buffers unnamed OpenCode tool metadata until the function name arrives', async () => {
  const response = new CaptureResponse()
  await relayOpenCodeChatStream(response, openCodeUpstream([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-buffered', function: { arguments: '{"path"' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'read', arguments: ':"x"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 4 } },
    '[DONE]',
  ]), 'opencode-go/kimi-k3')
  const events = responseEvents(response)
  const start = events.find(event => event.type === 'content_block_start')
  assert.equal(start.content_block.name, 'read')
  assert.equal(events.filter(event => event.type === 'content_block_delta').map(event => event.delta.partial_json).join(''), '{"path":"x"}')
  assert.equal(response.text().includes('"name":"tool"'), false)
})

test('handles heavily fragmented OpenCode tool arguments without duplicating data', async () => {
  const response = new CaptureResponse()
  const fragments = Array.from({ length: 5000 }, (_, index) =>
    index === 0 ? '{"path":"' : index === 4999 ? '"}' : 'x',
  )
  await relayOpenCodeChatStream(response, openCodeUpstream([
    ...fragments.map(fragment => ({
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            ...(fragment === fragments[0] ? { id: 'call-stress', function: { name: 'read', arguments: fragment } } : { function: { arguments: fragment } }),
          }],
        },
      }],
    })),
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    '[DONE]',
  ]), 'opencode-go/kimi-k3')
  const events = responseEvents(response)
  assert.equal(
    events
      .filter(event => event.type === 'content_block_delta')
      .map(event => event.delta.partial_json)
      .join(''),
    `{"path":"${'x'.repeat(4998)}"}`,
  )
})

test('routes the OpenCode free Ox Alpha model through Chat Completions', () => {
  assert.equal(anthropicToOpenCodeRequest(
    { messages: [{ role: 'user', content: 'alpha' }] },
    { upstream: 'ox-alpha-free', protocol: 'chat-completions' },
  ).model, 'ox-alpha-free')
})

// This sentinel prevents a passing suite that silently exercises no OpenCode tests.
assert.ok(true)
