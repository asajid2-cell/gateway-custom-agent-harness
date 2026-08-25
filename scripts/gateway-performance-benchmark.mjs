import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const gatewayScript = path.join(root, 'scripts', 'model-gateway.mjs')
const cli = path.join(root, 'dist', 'cli.js')
const codexBinary =
  process.env.PERF_CODEX_BINARY ||
  path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'OpenAI',
    'Codex',
    'bin',
    'codex.exe',
  )

async function selectedCodexAccount() {
  if (process.env.PERF_CODEX_ACCOUNT) return process.env.PERF_CODEX_ACCOUNT
  try {
    const selection = (
      await readFile(
        path.join(os.homedir(), '.codex-accounts', 'current.txt'),
        'utf8',
      )
    ).trim()
    return selection || 'default'
  } catch {
    return 'default'
  }
}

const account = await selectedCodexAccount()
const nativeModel = process.env.PERF_NATIVE_MODEL || 'gpt-5.6-luna'
const gatewayModel = process.env.PERF_GATEWAY_MODEL || 'gateway-gpt-luna'
const efforts = (process.env.PERF_EFFORTS || 'low')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean)
const repetitions = Math.max(1, Number(process.env.PERF_REPS || 3))
const timeoutMs = Math.max(10_000, Number(process.env.PERF_TIMEOUT_MS || 120_000))
const skipLoopback = process.env.PERF_SKIP_LOOPBACK === '1'
const skipLive = process.env.PERF_SKIP_LIVE === '1'
const debugEnabled = process.env.PERF_DEBUG === '1'
const liveModels = (process.env.PERF_MODELS || nativeModel)
  .split(',')
  .map(value => value.trim())
  .filter(Boolean)

function accountHomeFor(name) {
  return name === 'default'
    ? path.join(os.homedir(), '.codex')
    : path.join(os.homedir(), '.codex-accounts', name)
}

const accountHome = accountHomeFor(account)

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function debug(message) {
  if (!debugEnabled) return
  process.stderr.write(`[gateway-perf] ${message}\n`)
}

function percentile(values, fraction) {
  const numbers = values
    .filter(value => Number.isFinite(value))
    .slice()
    .sort((a, b) => a - b)
  if (!numbers.length) return null
  const index = Math.min(
    numbers.length - 1,
    Math.max(0, Math.ceil(fraction * numbers.length) - 1),
  )
  return numbers[index]
}

function summarize(values) {
  return {
    n: values.filter(value => Number.isFinite(value)).length,
    minMs: percentile(values, 0.01),
    p50Ms: percentile(values, 0.50),
    p95Ms: percentile(values, 0.95),
    maxMs: percentile(values, 1),
  }
}

function parseKeyValueLine(line, prefix) {
  if (!line.startsWith(prefix)) return null
  return Object.fromEntries(
    line
      .slice(prefix.length)
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(field => {
        const separator = field.indexOf('=')
        return separator < 0
          ? [field, '']
          : [field.slice(0, separator), field.slice(separator + 1)]
      }),
  )
}

function numeric(value) {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function errorCategory(error) {
  const message = String(error?.message || error || '').toLowerCase()
  if (message.includes('timed out') || message.includes('timeout')) return 'timeout'
  if (
    message.includes('econnrefused') ||
    message.includes('connection') ||
    message.includes('socket')
  ) return 'connection'
  if (message.includes('context')) return 'context-window'
  if (message.includes('malformed') || message.includes('empty')) return 'malformed-response'
  return 'error'
}

function observeProcess(child) {
  let stdout = ''
  let stderr = ''
  let stdoutRemainder = ''
  let stderrRemainder = ''
  const parsed = []
  const stderrLines = []
  const waiters = new Set()
  let processError = null

  const notify = () => {
    for (const waiter of waiters) waiter()
  }

  const consumeJson = chunk => {
    stdout += chunk
    stdoutRemainder += chunk
    const lines = stdoutRemainder.split(/\r?\n/)
    stdoutRemainder = lines.pop() || ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const value = JSON.parse(line)
        if (value && typeof value === 'object') parsed.push(value)
      } catch {
        // Keep diagnostics in stdout, but do not let them break event parsing.
      }
    }
    notify()
  }

  const consumeStderr = chunk => {
    stderr += chunk
    stderrRemainder += chunk
    const lines = stderrRemainder.split(/\r?\n/)
    stderrRemainder = lines.pop() || ''
    stderrLines.push(...lines.filter(Boolean))
    notify()
  }

  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', consumeJson)
  child.stderr?.on('data', consumeStderr)
  child.once('error', error => {
    processError = error
    notify()
  })

  async function waitFor(predicate, label, waitMs = timeoutMs) {
    const deadline = Date.now() + waitMs
    for (;;) {
      const match = parsed.find(predicate)
      if (match) return match
      if (processError) {
        throw new Error(`${label} failed: ${processError.message}`)
      }
      if (child.exitCode !== null) {
        throw new Error(`${label} saw child exit ${child.exitCode}`)
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        const recentTypes = parsed
          .slice(-12)
          .map(value => `${value.type || value.method || 'object'}:${value.subtype || ''}`)
          .join(',')
        throw new Error(
          `${label} timed out after ${waitMs}ms ` +
          `(parsed=${parsed.length}, recent=${recentTypes || 'none'}, ` +
          `stdout_bytes=${Buffer.byteLength(stdout)}, stderr_lines=${stderrLines.length})`,
        )
      }
      await new Promise(resolve => {
        const timer = setTimeout(() => {
          waiters.delete(onData)
          resolve()
        }, Math.min(remaining, 100))
        const onData = () => {
          clearTimeout(timer)
          waiters.delete(onData)
          resolve()
        }
        waiters.add(onData)
      })
    }
  }

  return {
    parsed,
    get stdout() {
      return stdout
    },
    get stderr() {
      return stderr
    },
    get stderrLines() {
      return stderrLines
    },
    waitFor,
  }
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return
  try {
    child.stdin?.destroy()
  } catch {}

  const waitForExit = (waitMs) => new Promise(resolve => {
    if (child.exitCode !== null) {
      resolve(true)
      return
    }
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.removeListener('exit', finish)
      child.removeListener('error', finish)
      resolve(true)
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.removeListener('exit', finish)
      child.removeListener('error', finish)
      resolve(false)
    }, waitMs)
    child.once('exit', finish)
    child.once('error', finish)
  })

  if (process.platform === 'win32') {
    const killer = spawn(
      'taskkill.exe',
      ['/PID', String(child.pid), '/T', '/F'],
      { windowsHide: true, stdio: 'ignore' },
    )
    await new Promise(resolve => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        resolve()
      }
      killer.once('close', finish)
      killer.once('error', finish)
      setTimeout(finish, 3_000)
    })
  } else {
    child.kill('SIGTERM')
  }

  if (!(await waitForExit(3_000)) && child.exitCode === null) {
    try {
      child.kill('SIGKILL')
    } catch {}
    await waitForExit(2_000)
  }
}

async function removeTempTree(target) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(target, {
        recursive: true,
        force: true,
        maxRetries: 2,
        retryDelay: 250,
      })
      return
    } catch (error) {
      const code = error?.code
      if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY') {
        throw error
      }
      await sleep(250 * (attempt + 1))
    }
  }
  await rm(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 })
}

function sseFrame(value) {
  return `data: ${JSON.stringify(value)}\n\n`
}

function makeCodexResponse(text = 'PERF_OK') {
  return {
    id: `perf-${Date.now()}`,
    status: 'completed',
    output: [{
      type: 'message',
      content: [{ type: 'output_text', text }],
    }],
    usage: {
      input_tokens: 120,
      output_tokens: 8,
      total_tokens: 128,
    },
  }
}

async function readRequestBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks)
}

async function startFakeCodex() {
  const state = { requests: 0, requestBytes: [] }
  const server = http.createServer(async (req, res) => {
    const body = await readRequestBody(req)
    state.requests += 1
    state.requestBytes.push(body.length)
    if (req.method !== 'POST') {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      connection: 'keep-alive',
    })
    res.write(sseFrame({
      type: 'response.output_text.delta',
      delta: 'PERF_OK',
    }))
    res.end(sseFrame({
      type: 'response.completed',
      response: makeCodexResponse(),
    }))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}/responses`,
    state,
  }
}

async function waitForGateway(child, observer) {
  const line = await new Promise((resolve, reject) => {
    const deadline = Date.now() + 10_000
    const poll = () => {
      const match = observer.stderr.match(
        /model-gateway listening on http:\/\/127\.0\.0\.1:(\d+)/,
      )
      if (match) {
        resolve(Number(match[1]))
        return
      }
      if (child.exitCode !== null) {
        reject(new Error(`Gateway exited before startup: ${observer.stderr}`))
        return
      }
      if (Date.now() >= deadline) {
        reject(new Error(`Gateway startup timed out: ${observer.stderr}`))
        return
      }
      setTimeout(poll, 20)
    }
    poll()
  })
  return line
}

async function measureHttp(url, body) {
  const started = performance.now()
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: body.stream === true
        ? 'text/event-stream'
        : 'application/json',
    },
    body: JSON.stringify(body),
  })
  const headersMs = performance.now() - started
  const reader = response.body?.getReader()
  let firstBodyMs = null
  let bytes = 0
  let raw = ''
  if (reader) {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      if (firstBodyMs == null) firstBodyMs = performance.now() - started
      bytes += next.value.byteLength
      raw += new TextDecoder().decode(next.value, { stream: true })
    }
  } else {
    raw = await response.text()
    firstBodyMs = performance.now() - started
    bytes = Buffer.byteLength(raw, 'utf8')
  }
  return {
    status: response.status,
    contentType: response.headers.get('content-type') || '',
    headersMs,
    firstBodyMs,
    completionMs: performance.now() - started,
    bytes,
    hasMarker: raw.includes('PERF_OK'),
  }
}

function anthropicProbeBody(stream, effort) {
  return {
    model: 'gateway-gpt-luna',
    stream,
    system: 'Synthetic performance probe system.',
    output_config: { effort },
    messages: [{
      role: 'user',
      content: 'Reply with exactly PERF_OK and nothing else.',
    }],
  }
}

async function runLoopbackBenchmark() {
  const { anthropicToCodex } = await import('./model-gateway.mjs')
  const fake = await startFakeCodex()
  const authHome = await mkdtemp(path.join(os.tmpdir(), 'gateway-perf-auth-'))
  await writeFile(
    path.join(authHome, 'auth.json'),
    JSON.stringify({
      tokens: {
        access_token: 'synthetic-perf-access-token',
        account_id: 'synthetic-perf-account',
      },
    }),
  )

  const gateway = spawn(process.execPath, [gatewayScript, '--port', '0'], {
    cwd: root,
    env: {
      ...process.env,
      CODEX_HOME: authHome,
      CODEX_RESPONSES_URL: fake.url,
      MODEL_GATEWAY_UPSTREAM_RETRIES: '0',
      MODEL_GATEWAY_UPSTREAM_TIMEOUT_MS: '10000',
      MODEL_GATEWAY_CONSUMER_TIMEOUT_MS: '10000',
      MODEL_GATEWAY_LOG_TIMING: '1',
      MODEL_GATEWAY_LOG_SHAPE: '0',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  const gatewayObserver = observeProcess(gateway)
  const port = await waitForGateway(gateway, gatewayObserver)
  const gatewayUrl = `http://127.0.0.1:${port}/v1/messages`
  const reports = []

  try {
    for (const stream of [true, false]) {
      const direct = []
      const gatewayClient = []
      const gatewayTrace = []
      const timingStart = gatewayObserver.stderrLines.filter(line =>
        line.startsWith('model-gateway timing '),
      ).length

      const warmBody = anthropicProbeBody(stream, 'low')
      const warmRequest = anthropicToCodex(warmBody, 'gpt-5.6-luna', 'normal')
      await measureHttp(fake.url, warmRequest)
      await measureHttp(gatewayUrl, warmBody)

      for (let i = 0; i < repetitions; i += 1) {
        const body = anthropicProbeBody(stream, 'low')
        const request = anthropicToCodex(body, 'gpt-5.6-luna', 'normal')
        direct.push(await measureHttp(fake.url, request))
        gatewayClient.push(await measureHttp(gatewayUrl, body))

        const lineIndex = timingStart + i + 1
        const deadline = Date.now() + 5_000
        while (
          gatewayObserver.stderrLines.filter(line =>
            line.startsWith('model-gateway timing '),
          ).length < lineIndex &&
          Date.now() < deadline
        ) {
          await sleep(10)
        }
        const timingLine = gatewayObserver.stderrLines
          .filter(line => line.startsWith('model-gateway timing '))
          .at(lineIndex - 1)
        const timing = parseKeyValueLine(timingLine || '', 'model-gateway timing ')
        if (timing) {
          gatewayTrace.push({
            upstreamConnectMs: numeric(timing.upstream_connect_ms),
            firstByteMs: numeric(timing.first_byte_ms),
            firstOutputMs: numeric(timing.first_output_ms),
            completionMs: numeric(timing.completion_ms),
          })
        }
      }

      reports.push({
        stream,
        direct: {
          headers: summarize(direct.map(item => item.headersMs)),
          firstBody: summarize(direct.map(item => item.firstBodyMs)),
          completion: summarize(direct.map(item => item.completionMs)),
        },
        gatewayClient: {
          headers: summarize(gatewayClient.map(item => item.headersMs)),
          firstBody: summarize(gatewayClient.map(item => item.firstBodyMs)),
          completion: summarize(gatewayClient.map(item => item.completionMs)),
        },
        gatewayTrace: {
          upstreamConnect: summarize(gatewayTrace.map(item => item.upstreamConnectMs)),
          firstByte: summarize(gatewayTrace.map(item => item.firstByteMs)),
          firstOutput: summarize(gatewayTrace.map(item => item.firstOutputMs)),
          completion: summarize(gatewayTrace.map(item => item.completionMs)),
        },
        completionOverheadMs: summarize(
          gatewayClient.map((item, index) =>
            item.completionMs - direct[index].completionMs,
          ),
        ),
        allSuccessful:
          direct.every(item => item.status === 200 && item.hasMarker) &&
          gatewayClient.every(item => item.status === 200 && item.hasMarker),
      })
    }
  } finally {
    await stopProcess(gateway)
    await new Promise(resolve => fake.server.close(resolve))
    await removeTempTree(authHome)
  }

  return {
    repetitions,
    reports,
    providerRequests: fake.state.requests,
  }
}

function writeJsonLine(child, value) {
  child.stdin.write(`${JSON.stringify(value)}\n`)
}

async function startNativeAppServer(fixture) {
  const started = performance.now()
  debug(`native spawn model=${nativeModel}`)
  const child = spawn(codexBinary, ['app-server', '--listen', 'stdio://'], {
    cwd: fixture,
    env: {
      ...process.env,
      CODEX_HOME: accountHome,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const observer = observeProcess(child)
  writeJsonLine(child, {
    method: 'initialize',
    id: 1,
    params: {
      clientInfo: {
        name: 'gateway-performance-benchmark',
        title: 'Gateway performance benchmark',
        version: '1.0.0',
      },
    },
  })
  await observer.waitFor(value => value.id === 1 && value.result, 'native initialize')
  debug('native initialized')
  writeJsonLine(child, { method: 'initialized', params: {} })
  writeJsonLine(child, {
    method: 'thread/start',
    id: 2,
    params: {
      model: nativeModel,
      cwd: fixture,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      ephemeral: true,
    },
  })
  const threadResponse = await observer.waitFor(
    value => value.id === 2 && value.result,
    'native thread start',
  )
  const threadId =
    threadResponse.result.thread?.id ||
    threadResponse.result.threadId ||
    threadResponse.result.id
  assert.equal(typeof threadId, 'string')
  debug('native thread started')
  return {
    child,
    observer,
    threadId,
    startupMs: performance.now() - started,
  }
}

async function runNativeTurns(fixture, effort) {
  const native = await startNativeAppServer(fixture)
  const reports = []
  let sequence = 0
  try {
    for (let i = 0; i < repetitions; i += 1) {
      debug(`native turn start effort=${effort} index=${i}`)
      const marker = `PERF_NATIVE_${effort}_${sequence++}`
      const started = performance.now()
      const eventStart = native.observer.parsed.length
      writeJsonLine(native.child, {
        method: 'turn/start',
        id: 100 + i,
        params: {
          threadId: native.threadId,
          input: [{
            type: 'text',
            text: `Reply with exactly ${marker} and nothing else.`,
          }],
          model: nativeModel,
          effort,
          approvalPolicy: 'never',
          sandboxPolicy: { type: 'dangerFullAccess' },
        },
      })
      await native.observer.waitFor(
        value =>
          value.method === 'turn/completed' &&
          native.observer.parsed.indexOf(value) >= eventStart,
        `native ${effort} turn ${i + 1}`,
      )
      const events = native.observer.parsed.slice(eventStart)
      const completion = events.find(value => value.method === 'turn/completed')
      const markerSeen = JSON.stringify(events).includes(marker)
      const completionStatus = completion?.params?.turn?.status || null
      reports.push({
        effort,
        index: i,
        elapsedMs: performance.now() - started,
        markerSeen,
        eventCount: events.length,
        completionStatus,
        successful: markerSeen && completionStatus === 'completed',
      })
      debug(`native turn complete effort=${effort} index=${i}`)
    }
  } finally {
    await stopProcess(native.child)
  }
  return {
    startupMs: native.startupMs,
    turns: reports,
  }
}

async function startCompiledGateway(fixture, effort, model) {
  debug(`gateway start model=${model} effort=${effort}`)
  const started = performance.now()
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'gateway-perf-config-'))
  await writeFile(
    path.join(configDir, '.claude.json'),
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

  let gateway = null
  let gatewayObserver = null
  let child = null
  let observer = null
  try {
    gateway = spawn(process.execPath, [gatewayScript, '--port', '0'], {
      cwd: root,
      env: {
        ...process.env,
        CODEX_HOME: accountHome,
        MODEL_GATEWAY_LOG_TIMING: '1',
        MODEL_GATEWAY_LOG_SHAPE: process.env.PERF_GATEWAY_LOG_SHAPE || '1',
        MODEL_GATEWAY_UPSTREAM_RETRIES: process.env.PERF_GATEWAY_RETRIES || '0',
        MODEL_GATEWAY_UPSTREAM_TIMEOUT_MS:
          process.env.PERF_GATEWAY_UPSTREAM_TIMEOUT_MS || String(timeoutMs),
        MODEL_GATEWAY_CONSUMER_TIMEOUT_MS:
          process.env.PERF_GATEWAY_CONSUMER_TIMEOUT_MS || String(timeoutMs),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    gatewayObserver = observeProcess(gateway)
    const port = await waitForGateway(gateway, gatewayObserver)
    debug(`gateway listening port=${port}`)
    child = spawn(
      process.env.BUN_EXECUTABLE || 'bun.exe',
      [
        cli,
        '--bare',
        '--dangerously-skip-permissions',
        '--session-id',
        randomUUID(),
        '--model',
        model,
        '--effort',
        effort,
        '--print',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
      ],
      {
        cwd: fixture,
        env: {
          ...process.env,
          CODEX_HOME: accountHome,
          CLAUDE_CODE_GATEWAY_BASE_URL: `http://127.0.0.1:${port}`,
          CLAUDE_CODE_GATEWAY_TOKEN: 'local-gateway',
          CLAUDE_CODE_USE_GATEWAY: '1',
          CLAUDE_GATEWAY_ALLOW_LOOPBACK: '1',
          CLAUDE_CONFIG_DIR: configDir,
          MODEL_GATEWAY_EFFORT_CAPABILITIES: JSON.stringify({
            [model]: ['low', 'medium', 'high', 'xhigh', 'max'],
          }),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
    observer = observeProcess(child)
    const warmupMarker = `PERF_INIT_${randomUUID()}`
    debug('gateway cli spawned; seeding warmup')
    writeJsonLine(child, {
      type: 'user',
      session_id: '',
      message: {
        role: 'user',
        content: `Reply with exactly ${warmupMarker} and nothing else.`,
      },
      parent_tool_use_id: null,
    })
    await observer.waitFor(
      value => value.type === 'system' && value.subtype === 'init',
      'compiled Gateway init',
    )
    debug('gateway cli init received')
    const startupMs = performance.now() - started
    const warmupStarted = performance.now()
    await observer.waitFor(
      value =>
        value.type === 'result' &&
        String(value.result || '').includes(warmupMarker),
      'compiled Gateway warmup',
    )
    debug('gateway warmup complete')
    return {
      child,
      observer,
      gateway,
      gatewayObserver,
      configDir,
      startupMs,
      warmupMs: performance.now() - warmupStarted,
    }
  } catch (error) {
    const timingLines = gatewayObserver?.stderrLines.filter(line =>
      line.startsWith('model-gateway timing '),
    ) || []
    const timingSummary = timingLines
      .map(line => parseKeyValueLine(line, 'model-gateway timing '))
      .filter(Boolean)
      .map(timing => [
        timing.status || '-',
        timing.outcome || '-',
        timing.error_class || '-',
        timing.upstream_connect_ms || '-',
        timing.first_byte_ms || '-',
        timing.completion_ms || '-',
      ].join('/'))
      .join(';') || 'none'
    const timingCount = timingLines.length
    const retryCount = gatewayObserver?.stderrLines.filter(line =>
      line.startsWith('model-gateway retry '),
    ).length || 0
    const gatewayErrorClasses = gatewayObserver?.stderrLines
      .filter(line =>
        line.startsWith('model-gateway codex stream-error ') ||
        line.startsWith('model-gateway codex-stream-error '),
      )
      .map(line => line.match(/class=([^\s]+)/)?.[1] || 'unknown')
      .join(',') || 'none'
    const eventTypes = observer?.parsed
      .slice(-12)
      .map(value => `${value.type || value.method || 'object'}:${value.subtype || ''}`)
      .join(',') || 'none'
    debug(
      `gateway startup failure category=${errorCategory(error)} ` +
      `events=${eventTypes} timing_lines=${timingCount} retries=${retryCount} ` +
      `gateway_errors=${gatewayErrorClasses} timings=${timingSummary}`,
    )
    await stopProcess(child)
    await stopProcess(gateway)
    await removeTempTree(configDir)
    throw error
  }
}

async function runCompiledGatewayTurns(fixture, effort, model) {
  const gateway = await startCompiledGateway(fixture, effort, model)
  const reports = []
  try {
    for (let i = 0; i < repetitions; i += 1) {
      debug(`gateway turn start effort=${effort} index=${i}`)
      const marker = `PERF_GATEWAY_${effort}_${i}`
      const started = performance.now()
      const eventStart = gateway.observer.parsed.length
      const timingStart = gateway.gatewayObserver.stderrLines.filter(line =>
        line.startsWith('model-gateway timing '),
      ).length
      writeJsonLine(gateway.child, {
        type: 'user',
        session_id: '',
        message: {
          role: 'user',
          content: `Reply with exactly ${marker} and nothing else.`,
        },
        parent_tool_use_id: null,
      })
      const result = await gateway.observer.waitFor(
        value =>
          value.type === 'result' &&
          gateway.observer.parsed.indexOf(value) >= eventStart,
        `Gateway ${effort} turn ${i + 1}`,
      )
      const timingDeadline = Date.now() + 5_000
      while (
        gateway.gatewayObserver.stderrLines.filter(line =>
          line.startsWith('model-gateway timing '),
        ).length <= timingStart &&
        Date.now() < timingDeadline
      ) {
        await sleep(10)
      }
      const timingLine = gateway.gatewayObserver.stderrLines
        .filter(line => line.startsWith('model-gateway timing '))
        .at(-1)
      const timing = parseKeyValueLine(
        timingLine || '',
        'model-gateway timing ',
      )
      const timingCompletionMs = numeric(timing?.completion_ms)
      reports.push({
        effort,
        index: i,
        elapsedMs: performance.now() - started,
        resultDurationMs: numeric(result.duration_ms),
        resultApiMs: numeric(result.duration_api_ms),
        markerSeen: String(result.result || '').includes(marker),
        resultSubtype: result.subtype || null,
        isError: result.is_error === true,
        successful:
          String(result.result || '').includes(marker) &&
          result.subtype === 'success' &&
          result.is_error !== true,
        timing: timing
          ? {
              upstreamConnectMs: numeric(timing.upstream_connect_ms),
              firstByteMs: numeric(timing.first_byte_ms),
              firstOutputMs: numeric(timing.first_output_ms),
              completionMs: timingCompletionMs,
              localPostUpstreamMs:
                timingCompletionMs == null
                  ? null
                  : Math.max(0, performance.now() - started - timingCompletionMs),
            }
          : null,
      })
      debug(`gateway turn complete effort=${effort} index=${i}`)
    }
  } finally {
    await stopProcess(gateway.child)
    await stopProcess(gateway.gateway)
    await removeTempTree(gateway.configDir)
  }
  return {
    startupMs: gateway.startupMs,
    warmupMs: gateway.warmupMs,
    turns: reports,
  }
}

async function runLiveBenchmark() {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'gateway-perf-fixture-'))
  await writeFile(
    path.join(fixture, 'perf.txt'),
    'Synthetic performance fixture.\n',
  )
  const reports = []
  try {
    for (const model of liveModels) {
      const gatewayModelForNative = model === 'gpt-5.6-luna'
        ? 'gateway-gpt-luna'
        : model === 'gpt-5.6-sol'
          ? 'gateway-gpt-sol'
          : `gateway-${model.replace(/^gpt-5\\.6-/, '')}`
      for (const effort of efforts) {
        debug(`case start model=${model} effort=${effort}`)
        const nativeBefore = performance.now()
        let native = []
        let nativeError = null
        try {
          native = await runNativeTurns(fixture, effort)
        } catch (error) {
          nativeError = String(error?.message || error)
        }
        const nativeElapsedMs = performance.now() - nativeBefore
        debug(`native case done ms=${Math.round(nativeElapsedMs)} error=${nativeError ? 'yes' : 'no'}`)

        const gatewayBefore = performance.now()
        let gateway = []
        let gatewayError = null
        try {
          gateway = await runCompiledGatewayTurns(
            fixture,
            effort,
            gatewayModelForNative,
          )
        } catch (error) {
          gatewayError = errorCategory(error)
        }
        const gatewayElapsedMs = performance.now() - gatewayBefore
        debug(`gateway case done ms=${Math.round(gatewayElapsedMs)} error=${gatewayError ? 'yes' : 'no'}`)

        reports.push({
          model,
          gatewayModel: gatewayModelForNative,
          effort,
          native: {
            startupPlusTurnsMs: nativeElapsedMs,
            startupMs: native.startupMs ?? null,
            turns: native.turns || [],
            completion: summarize((native.turns || []).map(item => item.elapsedMs)),
            allSuccessful: (native.turns || []).length === repetitions &&
              (native.turns || []).every(item => item.successful),
            error: nativeError,
          },
          gateway: {
            startupPlusTurnsMs: gatewayElapsedMs,
            startupMs: gateway.startupMs ?? null,
            warmupMs: gateway.warmupMs ?? null,
            turns: gateway.turns || [],
            completion: summarize((gateway.turns || []).map(item => item.elapsedMs)),
            api: summarize((gateway.turns || []).map(item => item.resultApiMs)),
            firstOutput: summarize(
              (gateway.turns || [])
                .map(item => item.timing?.firstOutputMs)
                .filter(value => value != null),
            ),
            allSuccessful: (gateway.turns || []).length === repetitions &&
              (gateway.turns || []).every(item => item.successful),
            error: gatewayError,
          },
          completionDeltaMs: summarize(
            (gateway.turns || [])
              .map((item, index) =>
                item.elapsedMs - (native.turns?.[index]?.elapsedMs ?? Number.NaN),
              ),
          ),
        })
      }
    }
  } finally {
    await removeTempTree(fixture)
  }
  return {
    account,
    accountHome,
    nativeModel,
    liveModels,
    efforts,
    repetitions,
    reports,
  }
}

async function main() {
  const started = performance.now()
  const report = {
    result: 'pass',
    generatedAt: new Date().toISOString(),
    scope: {
      account,
      nativeModel,
      gatewayModel,
      efforts,
      repetitions,
      note:
        'Timing artifacts contain only phases, durations, counts, and status. Prompts, bodies, headers, credentials, and provider responses are excluded.',
    },
    loopback: null,
    live: null,
  }

  if (!skipLoopback) {
    report.loopback = await runLoopbackBenchmark()
  }
  if (!skipLive) {
    report.live = await runLiveBenchmark()
  }
  report.elapsedMs = Math.round(performance.now() - started)
  report.result = [
    ...(report.loopback?.reports || []).map(item => item.allSuccessful),
    ...(report.live?.reports || []).flatMap(item => [
      item.native.allSuccessful,
      item.gateway.allSuccessful,
    ]),
  ].every(Boolean)
    ? 'pass'
    : 'partial'
  console.log(JSON.stringify(report))
}

main().catch(error => {
  console.log(JSON.stringify({
    result: 'fail',
    error: String(error?.stack || error),
  }))
  process.exitCode = 1
})
