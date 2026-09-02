import { spawn } from 'node:child_process'
import { once } from 'node:events'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const gatewayScript = path.join(root, 'scripts', 'model-gateway.mjs')
const allCases = [
  ['claude-gpt-luna', ['low', 'medium', 'high', 'max', 'ultracode']],
  ['claude-gpt-sol', ['low', 'medium', 'high', 'max', 'ultracode']],
  ['claude-gpt-terra', ['low', 'medium', 'high', 'ultracode']],
  ['gateway-opencode-glm-5.3-flash', ['low', 'high', 'max', 'ultracode']],
  ['opencode-go/gpt-5.6-luna', ['low', 'medium', 'high', 'ultracode']],
  ['opencode-go/mimo-v2.5', ['low', 'medium', 'high', 'ultracode']],
  ['opencode-go/minimax-m3', ['low', 'medium', 'high', 'ultracode']],
]
const selectedModels = process.env.GATEWAY_SMOKE_MODELS?.split(',').filter(Boolean)
const cases = selectedModels?.length
  ? allCases.filter(([model]) => selectedModels.includes(model))
  : allCases

const gateway = spawn(process.execPath, [gatewayScript, '--port', '0'], {
  cwd: root,
  env: {
    ...process.env,
    MODEL_GATEWAY_LOG_TIMING: '1',
    MODEL_GATEWAY_UPSTREAM_TIMEOUT_MS: '90000',
    MODEL_GATEWAY_CONSUMER_TIMEOUT_MS: '120000',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
})

let stderr = ''
gateway.stderr.setEncoding('utf8')
gateway.stderr.on('data', chunk => { stderr += chunk })

try {
  const deadline = Date.now() + 15_000
  let port = null
  while (Date.now() < deadline) {
    const match = stderr.match(/model-gateway listening on http:\/\/127\.0\.0\.1:(\d+)/)
    if (match) {
      port = Number(match[1])
      break
    }
    if (gateway.exitCode !== null) throw new Error(stderr)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  if (!port) throw new Error(`Gateway did not start: ${stderr}`)

  const results = []
  for (const [model, efforts] of cases) {
    for (const effort of efforts) {
      const started = performance.now()
      let response
      let body = ''
      try {
        response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer local-gateway',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model,
            stream: false,
            max_tokens: 16,
            output_config: { effort },
            messages: [{ role: 'user', content: 'Reply with exactly OK.' }],
          }),
          signal: AbortSignal.timeout(120_000),
        })
        body = await response.text()
        results.push({
          model,
          effort,
          status: response.status,
          ok: response.ok,
          elapsed_ms: Math.round(performance.now() - started),
          provider_error: !response.ok ? body.slice(0, 240) : undefined,
        })
      } catch (error) {
        results.push({
          model,
          effort,
          status: response?.status ?? null,
          ok: false,
          elapsed_ms: Math.round(performance.now() - started),
          provider_error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
  console.log(JSON.stringify({
    results,
    gateway_timing: stderr
      .split(/\r?\n/)
      .filter(line => line.includes('model-gateway timing'))
      .slice(-results.length),
  }, null, 2))
  process.exitCode = results.every(result => result.ok) ? 0 : 1
} finally {
  if (gateway.exitCode === null) {
    gateway.kill()
    await Promise.race([
      once(gateway, 'exit'),
      new Promise(resolve => setTimeout(resolve, 2_000)),
    ])
  }
}
