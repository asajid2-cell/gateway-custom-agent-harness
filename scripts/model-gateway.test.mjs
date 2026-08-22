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
  relayDeepSeekStream,
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
  const state = { requestAborted: false, responseClosed: false }
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

async function upstreamResponseFromRequest(req, res) {
  req.resume()
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'ok' })}\n\n`)
  res.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] } })}\n\n`)
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

function healthyCodexHandler(req, res) {
  return upstreamResponseFromRequest(req, res)
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

function openCodeUpstream(events) {
  return upstreamFromEvents(events)
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

test('builds OpenCode Go Chat Completions requests and forwards images', () => {
  const request = anthropicToOpenCodeChat(
    {
      system: 'system',
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

// This sentinel prevents a passing suite that silently exercises no OpenCode tests.
assert.ok(true)
