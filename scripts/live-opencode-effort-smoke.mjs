import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const gatewayScript = path.join(root, 'scripts', 'model-gateway.mjs')
const model = process.env.OPENCODE_EFFORT_MODEL
const levels = (process.env.OPENCODE_EFFORT_LEVELS || 'low,medium,high,max')
  .split(',')
  .map(level => level.trim())
  .filter(Boolean)
const timeoutMs = Number(process.env.OPENCODE_EFFORT_TIMEOUT_MS || 60_000)

function fail(message) {
  throw new Error(message)
}

async function waitForGateway(child, stderr) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const match = stderr.value.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)
    if (match) return Number(match[1])
    if (child.exitCode !== null) fail('gateway exited before startup')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  fail('gateway startup timed out')
}

async function request(port, effort) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        max_tokens: 96,
        messages: [{ role: 'user', content: `Reply with exactly OK for effort ${effort}.` }],
        output_config: { effort },
      }),
      signal: controller.signal,
    })
    const raw = await response.text()
    let parsed = null
    try {
      parsed = JSON.parse(raw)
    } catch {
      // Keep the result sanitized; the body is intentionally not emitted.
    }
    return {
      effort,
      status: response.status,
      ok: response.status === 200 && Array.isArray(parsed?.content) && parsed.content.length > 0,
      errorClass: response.status === 200 ? null : `http-${response.status}`,
      errorMessage: typeof parsed?.error?.message === 'string'
        ? parsed.error.message.slice(0, 500)
        : '',
      textLength: Array.isArray(parsed?.content)
        ? parsed.content.filter(block => block?.type === 'text').reduce((n, block) => n + String(block.text || '').length, 0)
        : 0,
    }
  } catch (error) {
    return {
      effort,
      status: 0,
      ok: false,
      errorClass: error?.name === 'AbortError' ? 'timeout' : 'transport-error',
      textLength: 0,
    }
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  if (!model) fail('OPENCODE_EFFORT_MODEL is required')
  if (!process.env.OPENCODE_API_KEY) fail('OPENCODE_API_KEY must be injected by keysafe')

  const stderr = { value: '' }
  const child = spawn(process.execPath, [gatewayScript, '--port', '0'], {
    cwd: root,
    env: {
      ...process.env,
      MODEL_GATEWAY_UPSTREAM_RETRIES: '1',
      MODEL_GATEWAY_UPSTREAM_RETRY_BASE_MS: '100',
      MODEL_GATEWAY_UPSTREAM_TIMEOUT_MS: String(timeoutMs),
      MODEL_GATEWAY_CONSUMER_TIMEOUT_MS: String(timeoutMs),
      MODEL_GATEWAY_LOG_TIMING: '1',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr.value += chunk })

  let port
  try {
    port = await waitForGateway(child, stderr)
    const results = []
    for (const level of levels) {
      results.push(await request(port, level))
    }
    const diagnostics = stderr.value
      .split(/\r?\n/)
      .filter(line => /^model-gateway (retry|timing|stream-error)/.test(line))
      .map(line => line.replace(/model-gateway timing .*/, 'model-gateway timing [redacted]'))
    const passed = results.every(result => result.ok)
    console.log(JSON.stringify({ result: passed ? 'pass' : 'fail', model, checks: results, diagnostics }))
    if (!passed) process.exitCode = 1
  } finally {
    if (child.exitCode === null) {
      child.kill()
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
}

main().catch(error => {
  console.log(JSON.stringify({ result: 'fail', errorClass: 'soak-failure', message: String(error?.message || error) }))
  process.exitCode = 1
})
