import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const gatewayScript = path.join(root, 'scripts', 'model-gateway.mjs')
const model = process.env.CODEX_SOAK_MODEL || 'gateway-gpt-luna'
const effort = process.env.CODEX_SOAK_EFFORT || 'low'
const timeoutMs = Number(process.env.CODEX_SOAK_TIMEOUT_MS || 45_000)

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function elapsed(start) {
  return Math.round(performance.now() - start)
}

function textBlocks(body) {
  return (body?.content || [])
    .filter(block => block?.type === 'text')
    .map(block => block.text || '')
    .join('')
}

function toolBlocks(body) {
  return (body?.content || []).filter(block => block?.type === 'tool_use')
}

async function waitForGateway(child, stderr) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const match = stderr.value.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)
    if (match) return Number(match[1])
    if (child.exitCode !== null) {
      throw new Error(`gateway exited before startup: ${child.exitCode}`)
    }
    await wait(20)
  }
  throw new Error('gateway startup timed out')
}

async function post(port, body) {
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
    } catch {}
    return {
      status: response.status,
      elapsedMs: elapsed(started),
      body: parsed,
      rawLength: raw.length,
    }
  } finally {
    clearTimeout(timer)
  }
}

async function postStream(port, body) {
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
    while (reader) {
      const next = await reader.read()
      if (next.done) break
      raw += decoder.decode(next.value, { stream: true })
    }
    raw += decoder.decode()
    const events = raw
      .split(/\r?\n\r?\n/)
      .flatMap(frame => {
        const line = frame.split(/\r?\n/).find(item => item.startsWith('data:'))
        const data = line?.slice(5).trim()
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
      eventCount: events.length,
      hasStart: events.some(event => event.type === 'message_start'),
      hasStop: events.some(event => event.type === 'message_stop'),
      hasText: events.some(event => event.type === 'content_block_delta' && event.delta?.text),
    }
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  const stderr = { value: '' }
  const child = spawn(process.execPath, [gatewayScript, '--port', '0'], {
    cwd: root,
    env: {
      ...process.env,
      MODEL_GATEWAY_UPSTREAM_RETRIES: '2',
      MODEL_GATEWAY_UPSTREAM_RETRY_BASE_MS: '100',
      MODEL_GATEWAY_UPSTREAM_TIMEOUT_MS: String(timeoutMs),
      MODEL_GATEWAY_CONSUMER_TIMEOUT_MS: String(timeoutMs),
      MODEL_GATEWAY_LOG_TIMING: '1',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr.value += chunk })

  try {
    const port = await waitForGateway(child, stderr)
    const system = 'SYNTHETIC_ACTIVE_WORKSPACE_MARKER Working directory: C:\\workspace\\project'
    const readTool = {
      name: 'Read',
      description: 'Read a file.',
      input_schema: {
        type: 'object',
        properties: { file_path: { type: 'string' } },
        required: ['file_path'],
      },
    }

    const normal = await post(port, {
      model,
      stream: false,
      system,
      output_config: { effort },
      messages: [{ role: 'user', content: 'Reply with exactly LIVE_LUNA_OK.' }],
    })
    assert.equal(normal.status, 200)
    assert.ok(textBlocks(normal.body))

    const streamed = await postStream(port, {
      model,
      system,
      output_config: { effort },
      messages: [{ role: 'user', content: 'Reply with exactly LIVE_STREAM_OK.' }],
    })
    assert.equal(streamed.status, 200)
    assert.equal(streamed.hasStart, true)
    assert.equal(streamed.hasStop, true)
    assert.equal(streamed.hasText, true)

    const toolTurn = await post(port, {
      model,
      stream: false,
      system,
      tools: [readTool],
      tool_choice: { type: 'tool', name: 'Read' },
      output_config: { effort },
      messages: [{ role: 'user', content: 'Call Read on README.md before answering.' }],
    })
    const calls = toolBlocks(toolTurn.body)
    assert.equal(toolTurn.status, 200)
    assert.equal(calls.length, 1)

    const compact = await post(port, {
      model,
      stream: false,
      system,
      thinking: { type: 'disabled' },
      output_config: { effort },
      tools: [readTool],
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'compaction' }, { type: 'text', text: 'Synthetic prior summary.' }],
        },
        {
          role: 'user',
          content: 'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n<summary>Summarize the conversation.</summary>',
        },
      ],
    })
    assert.equal(compact.status, 200)
    assert.ok(textBlocks(compact.body))

    const followUp = await post(port, {
      model,
      stream: false,
      system,
      tools: [readTool],
      output_config: { effort },
      messages: [
        { role: 'user', content: 'Use Read on README.md.' },
        { role: 'assistant', content: toolTurn.body.content },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: calls[0].id,
            content: 'Synthetic README result.',
          }],
        },
      ],
    })
    assert.equal(followUp.status, 200)
    assert.ok(textBlocks(followUp.body))

    console.log(JSON.stringify({
      result: 'pass',
      model,
      effort,
      checks: [
        { name: 'buffered', status: normal.status, elapsedMs: normal.elapsedMs },
        { name: 'streamed', ...streamed },
        { name: 'tool-call', status: toolTurn.status, elapsedMs: toolTurn.elapsedMs, toolCount: calls.length },
        { name: 'compaction', status: compact.status, elapsedMs: compact.elapsedMs },
        { name: 'post-compaction-continuation', status: followUp.status, elapsedMs: followUp.elapsedMs },
      ],
      timingLines: stderr.value.split(/\r?\n/).filter(line => line.startsWith('model-gateway timing ')).length,
    }))
  } finally {
    if (child.exitCode === null) {
      child.kill()
      await wait(100)
    }
  }
}

main().catch(error => {
  console.log(JSON.stringify({
    result: 'fail',
    error: String(error?.message || error),
  }))
  process.exitCode = 1
})
