import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const gatewayScript = path.join(root, 'scripts', 'model-gateway.mjs')
const cli = path.join(root, 'dist', 'cli.js')
const bun = process.env.BUN_EXECUTABLE ||
  (process.platform === 'win32' ? 'bun.exe' : 'bun')
const timeoutMs = Number(process.env.OPENCODE_REPLAY_TIMEOUT_MS || 12_000)
const model = 'gateway-opencode-glm-5.3-flash'
let replayState = null

function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function chatStream(res, chunks) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    connection: 'keep-alive',
  })
  for (const chunk of chunks) sse(res, { choices: [chunk] })
  res.end('data: [DONE]\n\n')
}

function textChunk(text, finish_reason = null) {
  return { delta: { content: text }, finish_reason }
}

function toolChunk(index, id, name, args, finish_reason = null) {
  return {
    delta: {
      tool_calls: [{
        index,
        id,
        type: 'function',
        function: { name, arguments: args },
      }],
    },
    finish_reason,
  }
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function userText(body) {
  const messages = (body?.messages || [])
    .filter(message => message?.role === 'user')
    .map(message => {
      if (typeof message.content === 'string') return message.content
      if (!Array.isArray(message.content)) return ''
      return message.content
        .map(block => typeof block === 'string' ? block : block?.text || '')
        .join('\n')
    })
  return messages.join('\n')
}

function lastUserText(body) {
  const messages = (body?.messages || [])
    .filter(message => message?.role === 'user')
    .map(message => {
      if (typeof message.content === 'string') return message.content
      if (!Array.isArray(message.content)) return ''
      return message.content
        .map(block => typeof block === 'string' ? block : block?.text || '')
        .join('\n')
    })
  return messages.at(-1) || ''
}

// This belongs to the synthetic provider fixture, not the Gateway. The
// production boundary uses the native query-source header and never classifies
// compaction by scanning prompt/history text.
function isSyntheticCompactionPromptText(value) {
  const text = String(value || '').toLowerCase()
  return text.includes(
    'critical: respond with text only. do not call any tools.',
  ) && text.includes('<summary>') && text.includes('summar')
}

function observer(child) {
  let stdout = ''
  let stderr = ''
  let remainder = ''
  let childError = null
  const parsed = []
  const consume = chunk => {
    stdout += chunk
    remainder += chunk
    const lines = remainder.split(/\r?\n/)
    remainder = lines.pop() || ''
    for (const line of lines) {
      if (!line) continue
      try {
        const value = JSON.parse(line)
        if (value && typeof value === 'object') parsed.push(value)
      } catch {
        // Keep non-JSON diagnostics in stdout for the failure report.
      }
    }
  }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', consume)
  child.stderr.on('data', chunk => { stderr += chunk })
  child.once('error', error => {
    childError = error
    stderr += `${String(error?.stack || error)}\n`
  })

  async function waitFor(predicate, label) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const match = parsed.find(predicate)
      if (match) return match
      if (childError) {
        throw new Error(`${label} failed to start or run: ${stderr}`)
      }
      if (child.exitCode !== null) throw new Error(`${label} before child exit ${child.exitCode}`)
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error(
      `${label} timed out after ${timeoutMs}ms; ` +
      `parsedTail=${JSON.stringify(parsed.slice(-8))}; ` +
      `stdoutTail=${JSON.stringify(stdout.slice(-2000))}; ` +
      `providerState=${JSON.stringify(replayState)}`,
    )
  }

  return {
    parsed,
    get stdout() { return stdout },
    get stderr() { return stderr },
    waitFor,
  }
}

function prompt(child, text) {
  child.stdin.write(JSON.stringify({
    type: 'user',
    session_id: '',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
  }) + '\n')
}

async function main() {
  const state = {
    requests: 0,
    malformedResponses: 0,
    toolRequests: 0,
    toolResults: 0,
    compactionRequests: 0,
    postCompactionToolCounts: [],
    missingToolCatalog: false,
    requestKinds: [],
  }
  replayState = state
  const provider = createServer(async (req, res) => {
    const body = await readJson(req)
    state.requests += 1
    const serialized = JSON.stringify(body)
    const lastText = lastUserText(body).toLowerCase()
    const hasToolResult = Array.isArray(body?.messages) &&
      body.messages.some(message => message?.role === 'tool')
    if (hasToolResult) state.toolResults += 1

    const isCompaction = isSyntheticCompactionPromptText(lastText)
    const hasTools = Array.isArray(body?.tools) && body.tools.length > 0
    state.requestKinds.push({
      roles: (body?.messages || []).map(message => message?.role),
      lastUserText: lastText.slice(0, 160),
      hasTools: Array.isArray(body?.tools) && body.tools.length > 0,
      hasToolResult,
      isCompaction,
    })
    if (isCompaction) {
      state.compactionRequests += 1
      chatStream(res, [textChunk('OpenCode summary preserved.', 'stop')])
      return
    }

    if (hasToolResult) {
      chatStream(res, [textChunk('OPENCODE_TOOL_CONTINUATION_OK', 'stop')])
      return
    }

    if (state.compactionRequests > 0) {
      state.postCompactionToolCounts.push(hasTools ? body.tools.length : 0)
      if (!hasTools) {
        state.missingToolCatalog = true
        chatStream(res, [textChunk('POST_COMPACT_NO_TOOLS', 'stop')])
      } else {
        chatStream(res, [textChunk('POST_COMPACT_OK', 'stop')])
      }
      return
    }

    if (!serialized.includes('"tools"')) {
      chatStream(res, [textChunk('POST_COMPACT_OK', 'stop')])
      return
    }

    state.toolRequests += 1
    if (state.malformedResponses === 0) {
      state.malformedResponses += 1
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('data: {"choices":[\n\n')
      return
    }

    chatStream(res, [
      toolChunk(0, 'call-read-replay', 'Read', JSON.stringify({ file_path: 'README.md' })),
      toolChunk(1, 'call-shell-replay', 'Bash', JSON.stringify({ command: 'echo OPENCODE_SHELL_OK' })),
      { delta: {}, finish_reason: 'tool_calls' },
    ])
  })
  await new Promise((resolve, reject) => {
    provider.once('error', reject)
    provider.listen(0, '127.0.0.1', resolve)
  })

  const config = await mkdtemp(path.join(os.tmpdir(), 'opencode-replay-config-'))
  const sessionId = randomUUID()
  await writeFile(
    path.join(config, '.claude.json'),
    JSON.stringify({
      theme: 'dark',
      hasCompletedOnboarding: true,
      projects: {
        [root.replace(/\\/g, '/')]: {
          hasTrustDialogAccepted: true,
          hasCompletedProjectOnboarding: true,
        },
      },
    }),
  )
  const gateway = spawn(process.execPath, [gatewayScript, '--port', '0'], {
    cwd: root,
    // A console-less parent would otherwise have Windows hand this child a fresh
    // visible console, which Windows Terminal opens as a tab and focuses.
    windowsHide: true,
    env: {
      ...process.env,
      OPENCODE_API_KEY: 'replay-key',
      OPENCODE_GO_CHAT_COMPLETIONS_URL:
        `http://127.0.0.1:${provider.address().port}/chat/completions`,
      MODEL_GATEWAY_UPSTREAM_RETRIES: '1',
      MODEL_GATEWAY_UPSTREAM_RETRY_BASE_MS: '10',
      MODEL_GATEWAY_UPSTREAM_TIMEOUT_MS: '2000',
      MODEL_GATEWAY_RETRY_ATTEMPT_TIMEOUT_MS: '1000',
      MODEL_GATEWAY_CONSUMER_TIMEOUT_MS: '5000',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let gatewayStderr = ''
  let gatewayError = null
  gateway.stderr.setEncoding('utf8')
  gateway.stderr.on('data', chunk => { gatewayStderr += chunk })
  gateway.once('error', error => {
    gatewayError = error
    gatewayStderr += `${String(error?.stack || error)}\n`
  })
  const startupDeadline = Date.now() + 5_000
  let port = null
  while (Date.now() < startupDeadline) {
    const match = gatewayStderr.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)
    if (match) {
      port = Number(match[1])
      break
    }
    if (gatewayError) throw new Error(`gateway could not start: ${gatewayStderr}`)
    if (gateway.exitCode !== null) throw new Error(`gateway exited: ${gatewayStderr}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  if (!port) throw new Error(`gateway startup timed out: ${gatewayStderr}`)

  const child = spawn(bun, [
    cli,
    '--dangerously-skip-permissions',
    '--session-id',
    sessionId,
    '--model',
    model,
    '--print',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
  ], {
    cwd: root,
    windowsHide: true,
    env: {
      ...process.env,
      CLAUDE_CODE_GATEWAY_BASE_URL: `http://127.0.0.1:${port}`,
      CLAUDE_CODE_GATEWAY_TOKEN: 'local-gateway',
      ANTHROPIC_AUTH_TOKEN: undefined,
      ANTHROPIC_API_KEY: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      CLAUDE_CODE_USE_GATEWAY: '1',
      CLAUDE_GATEWAY_ALLOW_LOOPBACK: '1',
      CLAUDE_CONFIG_DIR: config,
      MODEL_GATEWAY_EFFORT_CAPABILITIES: JSON.stringify({
        [model]: ['low', 'high', 'max'],
      }),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const seen = observer(child)

  try {
    prompt(child, 'Use Read on README.md and Bash to run echo OPENCODE_SHELL_OK, then report both results.')
    await seen.waitFor(value => value.type === 'system' && value.subtype === 'init', 'stream-json init')
    await seen.waitFor(value =>
      value.type === 'result' &&
      String(value.result || '').includes('OPENCODE_TOOL_CONTINUATION_OK'),
    'tool continuation')

    const toolNames = seen.parsed
      .filter(value => value.type === 'assistant')
      .flatMap(value => value.message?.content || [])
      .filter(block => block?.type === 'tool_use')
      .map(block => block.name)

    prompt(child, '/compact')
    await seen.waitFor(value => value.type === 'system' && value.subtype === 'compact_boundary', 'compact boundary')
    prompt(child, 'Reply with exactly POST_COMPACT_OK.')
    await seen.waitFor(value =>
      value.type === 'result' &&
      String(value.result || '').includes('POST_COMPACT_OK'),
    'post-compaction continuation')
    child.stdin.end()
    await new Promise(resolve => child.once('exit', resolve))

    const retryLines = gatewayStderr
      .split(/\r?\n/)
      .filter(line => line.includes('model-gateway retry provider=OpenCode-Go'))
    const report = {
      result: child.exitCode === 0 &&
        toolNames.includes('Read') &&
        toolNames.includes('Bash') &&
        state.malformedResponses === 1 &&
        state.toolRequests >= 2 &&
        state.toolResults >= 1 &&
        state.compactionRequests >= 1 &&
        state.postCompactionToolCounts.length >= 1 &&
        state.postCompactionToolCounts.every(count => count > 0) &&
        !state.missingToolCatalog &&
        retryLines.length >= 1
        ? 'pass'
        : 'fail',
      childExitCode: child.exitCode,
      toolNames,
      state,
      retryCount: retryLines.length,
      gatewayDiagnostics: gatewayStderr
        .split(/\r?\n/)
        .filter(line => /^model-gateway (retry|stream-error|timing)/.test(line))
        .map(line => line.replace(/model-gateway timing .*/, 'model-gateway timing [redacted]'))
        .slice(-20),
      outputTail: seen.stdout.split(/\r?\n/).slice(-20),
      stderrTail: seen.stderr.split(/\r?\n/).slice(-10),
    }
    console.log(JSON.stringify(report))
    process.exitCode = report.result === 'pass' ? 0 : 1
  } finally {
    if (child.exitCode === null) child.kill()
    if (gateway.exitCode === null) gateway.kill()
    await Promise.all([
      new Promise(resolve => provider.close(resolve)),
      rm(config, { recursive: true, force: true }),
    ])
  }
}

main().catch(error => {
  console.log(JSON.stringify({
    result: 'fail',
    error: String(error?.stack || error),
  }))
  process.exitCode = 1
})
