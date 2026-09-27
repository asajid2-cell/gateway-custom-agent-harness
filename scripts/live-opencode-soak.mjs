import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const gatewayScript = path.join(root, 'scripts', 'model-gateway.mjs')
const model = process.env.OPENCODE_SOAK_MODEL || 'gateway-opencode-glm-5.3-flash'
const timeoutMs = Number(process.env.OPENCODE_SOAK_TIMEOUT_MS || 45_000)
const upstreamTimeoutMs = Number(
  process.env.OPENCODE_SOAK_UPSTREAM_TIMEOUT_MS || timeoutMs,
)
const consumerTimeoutMs = Number(
  process.env.OPENCODE_SOAK_CONSUMER_TIMEOUT_MS || timeoutMs,
)
const omitToolChoice = process.env.OPENCODE_SOAK_OMIT_TOOL_CHOICE === '1'
const compactSimplePrompt = process.env.OPENCODE_SOAK_COMPACT_SIMPLE === '1'
const compactNoSystem = process.env.OPENCODE_SOAK_COMPACT_NO_SYSTEM === '1'
const compactNoEffort = process.env.OPENCODE_SOAK_COMPACT_NO_EFFORT === '1'

function elapsed(start) {
  return Math.round(performance.now() - start)
}

function fail(message) {
  throw new Error(message)
}

async function waitForGateway(child, stderr) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const match = stderr.value.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)
    if (match) return Number(match[1])
    if (child.exitCode !== null) fail(`gateway exited before startup: ${classify(stderr.value)}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  fail(`gateway startup timed out: ${classify(stderr.value)}`)
}

function classify(value) {
  const text = String(value || '').toLowerCase()
  if (text.includes('timeout')) return 'timeout'
  if (text.includes('malformed') || text.includes('unexpected')) return 'malformed-response'
  if (text.includes('401') || text.includes('unauthorized')) return 'auth'
  if (text.includes('429') || text.includes('rate limit')) return 'rate-limit'
  if (text.includes('400')) return 'bad-request'
  if (text.includes('context')) return 'context-window'
  return 'gateway-error'
}

function diagnostics(stderr) {
  return stderr.value
    .split(/\r?\n/)
    .filter(line => /^model-gateway (retry|timing|stream-error|tools-disabled)/.test(line))
    .slice(-40)
    .map(line => line.replace(/model-gateway timing .*/, 'model-gateway timing [redacted]'))
}

async function request(port, body) {
  const started = performance.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const raw = await response.text()
    let parsed = null
    try {
      parsed = JSON.parse(raw)
    } catch {
      // Streaming callers are not used by this soak; keep this branch as a
      // sanitized diagnostic if the gateway accidentally returns SSE.
    }
    return {
      status: response.status,
      elapsedMs: elapsed(started),
      body: parsed,
      rawLength: raw.length,
      errorClass: response.ok ? null : classify(raw),
      errorMessage: typeof parsed?.error?.message === 'string'
        ? parsed.error.message.slice(0, 500)
        : '',
    }
  } catch (error) {
    return {
      status: 0,
      elapsedMs: elapsed(started),
      body: null,
      rawLength: 0,
      errorClass: error?.name === 'AbortError' ? 'timeout' : classify(error?.message),
    }
  } finally {
    clearTimeout(timer)
  }
}

async function requestStream(port, body) {
  const started = performance.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, stream: true }),
      signal: controller.signal,
    })
    const reader = response.body?.getReader()
    const decoder = new TextDecoder()
    let raw = ''
    let chunks = 0
    if (reader) {
      while (chunks < 128) {
        const next = await reader.read()
        if (next.done) break
        chunks += 1
        raw += decoder.decode(next.value, { stream: true })
      }
      raw += decoder.decode()
      await reader.cancel().catch(() => {})
    }
    const events = raw
      .split(/\r?\n\r?\n/)
      .flatMap(frame => {
        const data = frame
          .split(/\r?\n/)
          .find(line => line.startsWith('data:'))
          ?.slice(5)
          .trim()
        if (!data || data === '[DONE]') return []
        try {
          return [JSON.parse(data)]
        } catch {
          return []
        }
      })
    return {
      status: response.status,
      elapsedMs: elapsed(started),
      chunks,
      eventCount: events.length,
      hasStart: events.some(event => event.type === 'message_start'),
      hasStop: events.some(event => event.type === 'message_stop'),
      hasText: events.some(event => event.type === 'content_block_delta' && event.delta?.text),
      errorClass: response.ok ? null : classify(raw),
    }
  } catch (error) {
    return {
      status: 0,
      elapsedMs: elapsed(started),
      chunks: 0,
      eventCount: 0,
      hasStart: false,
      hasStop: false,
      hasText: false,
      errorClass: error?.name === 'AbortError' ? 'timeout' : classify(error?.message),
    }
  } finally {
    clearTimeout(timer)
  }
}

function textContent(message) {
  return (message?.content || [])
    .filter(block => block?.type === 'text')
    .map(block => block.text || '')
    .join('')
}

function toolUses(message) {
  return (message?.content || []).filter(block => block?.type === 'tool_use')
}

function baseBody(overrides = {}) {
  return {
    model,
    stream: false,
    max_tokens: 256,
    messages: [{ role: 'user', content: 'Reply with exactly OK.' }],
    ...overrides,
  }
}

async function main() {
  if (!process.env.OPENCODE_API_KEY) {
    fail('OPENCODE_API_KEY must be injected by keysafe')
  }

  const stderr = { value: '' }
  const child = spawn(process.execPath, [gatewayScript, '--port', '0'], {
    cwd: root,
    windowsHide: true,
    env: {
      ...process.env,
      MODEL_GATEWAY_UPSTREAM_RETRIES: '2',
      MODEL_GATEWAY_UPSTREAM_RETRY_BASE_MS: '100',
      MODEL_GATEWAY_UPSTREAM_TIMEOUT_MS: String(upstreamTimeoutMs),
      MODEL_GATEWAY_CONSUMER_TIMEOUT_MS: String(consumerTimeoutMs),
      MODEL_GATEWAY_LOG_TIMING: '1',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr.value += chunk })

  let port
  const results = []
  try {
    port = await waitForGateway(child, stderr)

    const plain = await request(port, baseBody({
      output_config: { effort: 'low' },
    }))
    results.push({
      name: 'plain-low',
      status: plain.status,
      elapsedMs: plain.elapsedMs,
      errorClass: plain.errorClass,
      errorMessage: plain.errorMessage,
      textLength: textContent(plain.body).length,
    })
    if (plain.status !== 200 || !plain.body?.content?.length) {
      fail(
        `plain-low failed: ${plain.errorClass}; message=${plain.errorMessage || 'none'}; ` +
        `diagnostics=${JSON.stringify(diagnostics(stderr))}`,
      )
    }

    const streamed = await requestStream(port, baseBody({
      output_config: { effort: 'high' },
      messages: [{ role: 'user', content: 'Reply with exactly STREAM_OK.' }],
    }))
    results.push({
      name: 'streamed-text',
      status: streamed.status,
      elapsedMs: streamed.elapsedMs,
      chunks: streamed.chunks,
      eventCount: streamed.eventCount,
      hasStart: streamed.hasStart,
      hasStop: streamed.hasStop,
      hasText: streamed.hasText,
      errorClass: streamed.errorClass,
    })
    if (
      streamed.status !== 200 ||
      !streamed.hasStart ||
      !streamed.hasStop ||
      !streamed.hasText
    ) {
      fail(`streamed-text failed: ${streamed.errorClass || 'invalid-sse'}; diagnostics=${JSON.stringify(diagnostics(stderr))}`)
    }

    const firstTool = await request(port, baseBody({
      tools: [{
        name: 'read_file',
        description: 'Read a named file and return its text.',
        input_schema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      }],
    ...(omitToolChoice ? {} : { tool_choice: { type: 'tool', name: 'read_file' } }),
      messages: [{
        role: 'user',
        content: 'Use read_file on README.md. Do not answer until you call the tool.',
      }],
      output_config: { effort: 'high' },
    }))
    const firstCalls = toolUses(firstTool.body)
    results.push({
      name: 'read-tool-call',
      status: firstTool.status,
      elapsedMs: firstTool.elapsedMs,
      errorClass: firstTool.errorClass,
      errorMessage: firstTool.errorMessage,
      toolCount: firstCalls.length,
      toolNames: firstCalls.map(call => call.name),
    })
    if (firstTool.status !== 200 || firstCalls.length !== 1 || firstCalls[0].name !== 'read_file') {
      fail(`read-tool-call failed: ${firstTool.errorClass || 'tool-call-not-produced'} ${firstTool.errorMessage}; diagnostics=${JSON.stringify(diagnostics(stderr))}`)
    }

    const secondTool = await request(port, baseBody({
      tools: [
        {
          name: 'read_file',
          description: 'Read a named file and return its text.',
          input_schema: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
        {
          name: 'shell',
          description: 'Run a harmless shell command and return its output.',
          input_schema: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command'],
          },
        },
      ],
      ...(omitToolChoice ? {} : { tool_choice: { type: 'tool', name: 'shell' } }),
      messages: [
        {
          role: 'user',
          content: 'Use read_file on README.md, then use shell to run pwd.',
        },
        { role: 'assistant', content: firstTool.body.content },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: firstCalls[0].id,
            content: 'README.md contents: gateway soak fixture.',
          }],
        },
      ],
      output_config: { effort: 'high' },
    }))
    const secondCalls = toolUses(secondTool.body)
    results.push({
      name: 'shell-tool-call',
      status: secondTool.status,
      elapsedMs: secondTool.elapsedMs,
      errorClass: secondTool.errorClass,
      errorMessage: secondTool.errorMessage,
      toolCount: secondCalls.length,
      toolNames: secondCalls.map(call => call.name),
    })
    if (secondTool.status !== 200 || secondCalls.length !== 1 || secondCalls[0].name !== 'shell') {
      fail(`shell-tool-call failed: ${secondTool.errorClass || 'tool-call-not-produced'} ${secondTool.errorMessage}; diagnostics=${JSON.stringify(diagnostics(stderr))}`)
    }

    const multiTool = await request(port, baseBody({
      tools: [
        {
          name: 'read_file',
          description: 'Read a named file and return its text.',
          input_schema: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
        {
          name: 'shell',
          description: 'Run a harmless shell command and return its output.',
          input_schema: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command'],
          },
        },
      ],
      messages: [{
        role: 'user',
        content: 'Call read_file on README.md and shell with pwd. Do not answer until both calls are emitted.',
      }],
      output_config: { effort: 'high' },
    }))
    const multiCalls = toolUses(multiTool.body)
    results.push({
      name: 'multiple-tool-calls',
      status: multiTool.status,
      elapsedMs: multiTool.elapsedMs,
      errorClass: multiTool.errorClass,
      errorMessage: multiTool.errorMessage,
      toolCount: multiCalls.length,
      toolNames: multiCalls.map(call => call.name),
    })
    if (
      multiTool.status !== 200 ||
      multiCalls.length < 2 ||
      !multiCalls.some(call => call.name === 'read_file') ||
      !multiCalls.some(call => call.name === 'shell')
    ) {
      fail(`multiple-tool-calls failed: ${multiTool.errorClass || 'insufficient-tool-calls'} ${multiTool.errorMessage}; diagnostics=${JSON.stringify(diagnostics(stderr))}`)
    }

    const continuation = await request(port, baseBody({
      tools: [
        {
          name: 'shell',
          description: 'Run a harmless shell command and return its output.',
          input_schema: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command'],
          },
        },
      ],
      messages: [
        {
          role: 'user',
          content: 'Use shell to run pwd, then summarize the result in one sentence.',
        },
        { role: 'assistant', content: secondTool.body.content },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: secondCalls[0].id,
            content: 'Z:\\\\328\\\\CMPUT328-A2\\\\codexworks\\\\301\\\\WorkRepo\\\\gateway',
          }],
        },
      ],
      output_config: { effort: 'high' },
    }))
    results.push({
      name: 'post-tool-continuation',
      status: continuation.status,
      elapsedMs: continuation.elapsedMs,
      errorClass: continuation.errorClass,
      errorMessage: continuation.errorMessage,
      textLength: textContent(continuation.body).length,
    })
    if (continuation.status !== 200 || !textContent(continuation.body)) {
      fail(`post-tool-continuation failed: ${continuation.errorClass || 'empty-output'}; diagnostics=${JSON.stringify(diagnostics(stderr))}`)
    }

    const compaction = await request(port, {
      model,
      stream: false,
      ...(compactNoSystem ? {} : { system: 'main system' }),
      ...(compactNoEffort ? {} : { output_config: { effort: 'high' } }),
      ...(compactSimplePrompt
        ? {}
        : { thinking: { type: 'disabled' } }),
      tools: [{
        name: 'read_file',
        description: 'Read a file.',
        input_schema: { type: 'object' },
      }],
      messages: [{
        role: 'user',
        content: compactSimplePrompt
          ? 'Summarize this conversation in one sentence.'
          : 'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n<summary>Summarize the conversation into a compact continuation summary.</summary>',
      }],
    })
    results.push({
      name: 'compaction-shaped',
      status: compaction.status,
      elapsedMs: compaction.elapsedMs,
      errorClass: compaction.errorClass,
      errorMessage: compaction.errorMessage,
      textLength: textContent(compaction.body).length,
    })
    if (compaction.status !== 200 || !textContent(compaction.body)) {
      fail(`compaction-shaped failed: ${compaction.errorClass || 'empty-output'} ${compaction.errorMessage}; diagnostics=${JSON.stringify(diagnostics(stderr))}`)
    }

    console.log(JSON.stringify({
      result: 'pass',
      model,
      checks: results,
      gatewayTimingLines: stderr.value.split(/\r?\n/).filter(line => line.startsWith('model-gateway timing ')).length,
    }))
  } finally {
    if (child.exitCode === null) {
      child.kill()
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
}

main().catch(error => {
  console.log(JSON.stringify({
    result: 'fail',
    errorClass: error?.message?.includes('timeout') ? 'timeout' : 'soak-failure',
    message: String(error?.message || error),
  }))
  process.exitCode = 1
})
