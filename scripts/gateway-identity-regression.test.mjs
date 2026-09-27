import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bun = process.env.BUN_EXECUTABLE || process.execPath
const cli = path.join(root, 'dist', 'cli.js')
const launcherRegression = path.join(
  root,
  'scripts',
  'cc-restart-regression.ps1',
)

function makeEnv(overrides = {}) {
  const env = { ...process.env }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key]
    else env[key] = String(value)
  }
  return env
}

function runProcess(command, args, env, timeoutMs = 15_000) {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Every child here is a console program, and the suite may itself be running
      // without a console, so the hiding has to be asked for explicitly.
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    child.once('error', error => {
      clearTimeout(timer)
      resolve({ code: 1, stdout, stderr: `${stderr}${error}\n`, timedOut })
    })
    child.once('exit', code => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, stdout, stderr, timedOut })
    })
  })
}

function lastJsonLine(output) {
  const trimmed = output.trim()
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      // The CLI may surround JSON with diagnostics; fall through to lines.
    }
  }
  for (const line of output.split(/\r?\n/).reverse()) {
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      // Ignore diagnostics around the machine-readable result.
    }
  }
  return null
}

function poisonedGatewayEnv(overrides = {}) {
  return makeEnv({
    CLAUDE_CODE_USE_GATEWAY: '1',
    CLAUDE_CODE_GATEWAY_TOKEN: 'synthetic-gateway-token',
    CLAUDE_CODE_GATEWAY_BASE_URL: 'http://127.0.0.1:9',
    MODEL_GATEWAY_MODEL: 'gateway-gpt-luna',
    ANTHROPIC_API_KEY: 'synthetic-anthropic-key',
    ANTHROPIC_AUTH_TOKEN: 'synthetic-anthropic-auth',
    ANTHROPIC_MODEL: 'claude-opus-4-6',
    ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer synthetic-wrong-token',
    CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-oauth-token',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_USE_VERTEX: '1',
    CLAUDE_CODE_USE_FOUNDRY: '1',
    ...overrides,
  })
}

function writeAnthropicStream(res, model) {
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'msg_gateway_identity',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'GATEWAY_IDENTITY_OK' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: 'message_stop' },
  ]
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    connection: 'close',
  })
  for (const event of events) {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  }
  res.end()
}

// Every test here spawns the compiled CLI, which costs a process start on a
// machine that runs a whole fleet of sessions. The default per-test budget is
// 5s, so a loaded box reported these as product failures while the same run
// passed with a longer budget. Declare one that covers the spawn, as the
// long-running tests below already do.
test('compiled auth status is Gateway-native under poisoned Anthropic state', { timeout: 60_000 }, async () => {
  const result = await runProcess(
    bun,
    [cli, 'auth', 'status', '--json'],
    poisonedGatewayEnv({
      CLAUDE_CODE_USE_GATEWAY: '1',
    }),
  )
  assert.equal(result.timedOut, false, result.stderr)
  assert.equal(result.code, 0, result.stderr)

  const status = lastJsonLine(result.stdout)
  assert.deepEqual(status, {
    loggedIn: true,
    authMethod: 'gateway',
    apiProvider: 'gateway',
  })
})

test('compiled Gateway blocks Anthropic login and logout commands', { timeout: 60_000 }, async () => {
  const env = poisonedGatewayEnv()
  const login = await runProcess(bun, [cli, 'auth', 'login'], env)
  assert.equal(login.timedOut, false, login.stderr)
  assert.notEqual(login.code, 0)
  assert.match(
    `${login.stdout}\n${login.stderr}`,
    /Gateway mode does not use Anthropic or Claude authentication/,
  )

  const logout = await runProcess(bun, [cli, 'auth', 'logout'], env)
  assert.equal(logout.timedOut, false, logout.stderr)
  assert.equal(logout.code, 0, logout.stderr)
  assert.match(
    `${logout.stdout}\n${logout.stderr}`,
    /Gateway mode has no Anthropic or Claude login state/,
  )
})

test('compiled Gateway fails closed when its base URL is missing', { timeout: 60_000 }, async () => {
  const result = await runProcess(
    bun,
    [
      cli,
      '--bare',
      '--dangerously-skip-permissions',
      '--model',
      'gateway-gpt-luna',
      '--print',
      '--output-format',
      'json',
      'Reply with exactly IDENTITY_PROBE.',
    ],
    poisonedGatewayEnv({ CLAUDE_CODE_GATEWAY_BASE_URL: undefined }),
  )
  assert.equal(result.timedOut, false, result.stderr)
  assert.notEqual(result.code, 0)
  assert.ok(
    `${result.stdout}\n${result.stderr}`.includes(
      'Gateway mode requires CLAUDE_CODE_GATEWAY_BASE_URL',
    ),
  )
})

test(
  'compiled Gateway sends the gateway model and token to the gateway endpoint',
  { timeout: 30_000 },
  async () => {
  const requests = []
  const provider = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const rawBody = Buffer.concat(chunks).toString('utf8')
    let body = null
    try {
      body = rawBody ? JSON.parse(rawBody) : null
    } catch {
      // The assertion below will fail with the captured request metadata.
    }
    requests.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body,
    })

    if (req.method !== 'POST') {
      res.writeHead(200, {
        'content-type': 'application/json',
        connection: 'close',
      })
      res.end(JSON.stringify({ data: [] }))
      return
    }

    if (body?.stream) {
      writeAnthropicStream(res, body.model)
      return
    }

    res.writeHead(200, {
      'content-type': 'application/json',
      connection: 'close',
    })
    res.end(
      JSON.stringify({
        id: 'msg_gateway_identity',
        type: 'message',
        role: 'assistant',
        model: body?.model,
        content: [{ type: 'text', text: 'GATEWAY_IDENTITY_OK' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    )
  })
  await new Promise((resolve, reject) => {
    provider.once('error', reject)
    provider.listen(0, '127.0.0.1', resolve)
  })

  try {
    const port = provider.address().port
    const result = await runProcess(
      bun,
      [
        cli,
        '--bare',
        '--dangerously-skip-permissions',
        '--model',
        'gateway-gpt-luna',
        '--print',
        '--output-format',
        'json',
        'Reply with exactly GATEWAY_IDENTITY_OK.',
      ],
      poisonedGatewayEnv({
        CLAUDE_CODE_GATEWAY_BASE_URL: `http://127.0.0.1:${port}`,
      }),
      20_000,
    )
    assert.equal(
      result.timedOut,
      false,
      `${result.stdout}\n${result.stderr}\nrequests=${JSON.stringify(requests)}`,
    )
    assert.equal(
      result.code,
      0,
      `${result.stdout}\n${result.stderr}\nrequests=${JSON.stringify(requests)}`,
    )
    assert.match(result.stdout, /GATEWAY_IDENTITY_OK/)

    const post = requests.find(request => request.method === 'POST')
    assert.ok(post, `No POST request captured: ${JSON.stringify(requests)}`)
    assert.equal(post.headers.authorization, 'Bearer synthetic-gateway-token')
    assert.equal(post.headers['x-api-key'], undefined)
    assert.equal(post.body?.model, 'gateway-gpt-luna')
    assert.equal(String(post.body?.model).startsWith('claude-'), false)
  } finally {
    provider.closeAllConnections?.()
    await new Promise(resolve => provider.close(resolve))
  }
  },
)

test(
  'cc launcher scrubs inherited Anthropic/provider identity before starting a session',
  { timeout: 20_000 },
  async () => {
  const result = await runProcess(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      launcherRegression,
    ],
    poisonedGatewayEnv({
      // Pin the model tier explicitly. cc.ps1 now resolves the launch model as
      // MODEL_GATEWAY_DEFAULT > ~/.claude/gateway-default-model.txt > a built-in
      // default, and that stored file is real per-machine user state. Leaving
      // it unset made this scenario assert whatever the developer last picked
      // in the model picker, so it passed or failed by machine rather than by
      // launcher behaviour. MODEL_GATEWAY_DEFAULT is the tier the cc-* wrappers
      // set, so pinning it exercises the production path deterministically.
      MODEL_GATEWAY_DEFAULT: 'gateway-gpt-luna',
      MODEL_GATEWAY_EFFORT: undefined,
    }),
  )
  assert.equal(result.timedOut, false, result.stderr)
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`)
  const report = lastJsonLine(result.stdout)
  assert.equal(report?.result, 'pass', result.stdout)
  assert.equal(report?.gatewayIdentity, true, result.stdout)
  },
)
