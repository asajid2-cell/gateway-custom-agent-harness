import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const gatewayScript = path.join(root, 'scripts', 'model-gateway.mjs')
const compiledCli = path.join(root, 'dist', 'cli.js')
const codexBinary =
  process.env.WARM_CODEX_BINARY ||
  path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'OpenAI',
    'Codex',
    'bin',
    'codex.exe',
  )
const account = process.env.WARM_CODEX_ACCOUNT || 'freedock'
const accountHome = path.join(os.homedir(), '.codex-accounts', account)
const nativeModel = process.env.WARM_NATIVE_MODEL || 'gpt-6-sol'
const gatewayModel = process.env.WARM_GATEWAY_MODEL || 'gateway-gpt-6-sol'
const effort = process.env.WARM_EFFORT || 'low'
const toolMode = process.env.MODEL_GATEWAY_CODEX_TOOL_MODE || 'compact'
const bareGateway = process.env.WARM_BARE !== '0'
const timeoutMs = Number(process.env.WARM_TIMEOUT_MS || 180_000)

const turns = [
  {
    id: 'text-1',
    marker: 'WARM_TEXT_ONE_OK',
    prompt: 'Reply with exactly WARM_TEXT_ONE_OK and nothing else.',
  },
  {
    id: 'tool-1',
    marker: 'WARM_TOOL_ONE_OK',
    prompt:
      'Use the command-execution tool to run a command in the current workspace that prints exactly WARM_TOOL_ONE_OK. Do not answer before the tool runs; after the tool result, reply with exactly WARM_TOOL_ONE_OK and nothing else.',
  },
  {
    id: 'tool-2',
    marker: 'WARM_TOOL_TWO_OK',
    prompt:
      'Use the command-execution tool to run a command in the current workspace that prints exactly WARM_TOOL_TWO_OK. Do not answer before the tool runs; after the tool result, reply with exactly WARM_TOOL_TWO_OK and nothing else.',
  },
  {
    id: 'text-2',
    marker: 'WARM_TEXT_TWO_OK',
    prompt: 'Reply with exactly WARM_TEXT_TWO_OK and nothing else.',
  },
]

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function stopTree(child) {
  if (!child || child.exitCode !== null) return
  const exited = new Promise(resolve => {
    if (child.exitCode !== null) {
      resolve()
      return
    }
    const finish = () => {
      clearTimeout(timer)
      child.removeListener('exit', finish)
      child.removeListener('error', finish)
      resolve()
    }
    const timer = setTimeout(finish, 5_000)
    child.once('exit', finish)
    child.once('error', finish)
  })
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    })
    await new Promise(resolve => {
      killer.once('close', resolve)
      killer.once('error', resolve)
      setTimeout(resolve, 3_000)
    })
  } else {
    child.kill('SIGTERM')
  }
  await exited
}

function parseJsonLines(stdout) {
  return stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .flatMap(line => {
      try {
        const value = JSON.parse(line)
        return value && typeof value === 'object' ? [value] : []
      } catch {
        return []
      }
    })
}

function observe(child) {
  let stdout = ''
  let stderr = ''
  let stdoutRemainder = ''
  const events = []
  const waiters = new Set()
  let processError = null

  const notify = () => {
    for (const waiter of waiters) waiter()
  }

  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', chunk => {
    stdout += chunk
    stdoutRemainder += chunk
    const lines = stdoutRemainder.split(/\r?\n/)
    stdoutRemainder = lines.pop() || ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const value = JSON.parse(line)
        if (value && typeof value === 'object') events.push(value)
      } catch {}
    }
    notify()
  })
  child.stderr?.on('data', chunk => {
    stderr += chunk
    notify()
  })
  child.once('error', error => {
    processError = error
    notify()
  })

  async function waitFor(predicate, label) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const match = events.find(predicate)
      if (match) return match
      if (processError) throw new Error(`${label}: ${processError.message}`)
      if (child.exitCode !== null) throw new Error(`${label}: child exited ${child.exitCode}`)
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        throw new Error(`${label}: timeout; recent=${events.slice(-8).map(event => event.type || event.method).join(',')}`)
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
    events,
    get stdout() {
      return stdout
    },
    get stderr() {
      return stderr
    },
    waitFor,
  }
}

async function waitForText(observer, pattern, label) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (pattern.test(observer.stderr)) return
    if (Date.now() >= deadline) {
      throw new Error(`${label}: timeout; stderr_tail=${observer.stderr.slice(-1000)}`)
    }
    await sleep(25)
  }
}

function sendJson(child, value) {
  child.stdin.write(`${JSON.stringify(value)}\n`)
}

function parseTiming(line) {
  if (!line.startsWith('model-gateway timing ')) return null
  return Object.fromEntries(
    line
      .slice('model-gateway timing '.length)
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(field => {
        const index = field.indexOf('=')
        return index < 0
          ? [field, '']
          : [field.slice(0, index), field.slice(index + 1)]
      }),
  )
}

function number(value) {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function nativeTurnSummary(events, marker, elapsedMs) {
  const serialized = JSON.stringify(events)
  const toolEvents = events.filter(event => {
    const item = event.item || event.params?.item || event.params?.turn?.item
    return (
      ['command_execution', 'file_change', 'mcp_tool_call', 'computer_call'].includes(item?.type) ||
      serialized.includes('"commandExecution"') ||
      serialized.includes('"command_execution"')
    )
  })
  const completion = events.find(event =>
    event.method === 'turn/completed' ||
    event.type === 'turn.completed',
  )
  const status =
    completion?.params?.turn?.status ||
    completion?.turn?.status ||
    null
  const usageEvent = events
    .filter(event =>
      event.method === 'thread/tokenUsage/updated' ||
      event.type === 'thread.tokenUsage.updated',
    )
    .at(-1)
  const usage =
    usageEvent?.params?.tokenUsage ||
    usageEvent?.params?.usage ||
    usageEvent?.tokenUsage ||
    usageEvent?.usage ||
    null
  const errors = events
    .filter(event => event.error || event.type === 'error' || event.method === 'error')
    .map(event => event.error?.message || event.message || event.params?.error?.message || '')
    .filter(Boolean)
  return {
    elapsedMs,
    markerPresent: serialized.includes(marker),
    success: serialized.includes(marker) && status === 'completed',
    eventCount: events.length,
    toolCount: toolEvents.length,
    toolTypes: toolEvents.length ? ['command_execution'] : [],
    completionStatus: status,
    usage,
    errors,
    eventTypes: [...new Set(events.map(event => event.method || event.type).filter(Boolean))],
  }
}

function gatewayTurnSummary(events, marker, elapsedMs, timing) {
  const result = events.filter(event => event.type === 'result').at(-1)
  const assistant = events
    .filter(event => event.type === 'assistant')
    .flatMap(event => event.message?.content || [])
  const toolBlocks = assistant.filter(block => block?.type === 'tool_use')
  const finalText = typeof result?.result === 'string' ? result.result : ''
  return {
    elapsedMs,
    resultDurationMs: number(result?.duration_ms),
    resultApiMs: number(result?.duration_api_ms),
    markerPresent: finalText.includes(marker),
    success:
      result?.subtype === 'success' &&
      result?.is_error !== true &&
      finalText.includes(marker),
    eventCount: events.length,
    toolCount: toolBlocks.length,
    toolTypes: [...new Set(toolBlocks.map(block => block.name))],
    usage: result?.usage || null,
    timing: timing
      ? {
          upstreamConnectMs: number(timing.upstream_connect_ms),
          firstOutputMs: number(timing.first_output_ms),
          completionMs: number(timing.completion_ms),
          bytes: number(timing.bytes),
        }
      : null,
  }
}

async function startNative(fixture) {
  const started = performance.now()
  const child = spawn(codexBinary, ['app-server', '--listen', 'stdio://'], {
    cwd: fixture,
    env: { ...process.env, CODEX_HOME: accountHome },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const observer = observe(child)
  sendJson(child, {
    method: 'initialize',
    id: 1,
    params: {
      clientInfo: {
        name: 'warm-tool-parity',
        title: 'Warm tool parity',
        version: '1.0.0',
      },
    },
  })
  await observer.waitFor(value => value.id === 1 && value.result, 'native initialize')
  sendJson(child, { method: 'initialized', params: {} })
  sendJson(child, {
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
  const thread = await observer.waitFor(value => value.id === 2 && value.result, 'native thread')
  const threadId =
    thread.result.thread?.id ||
    thread.result.threadId ||
    thread.result.id
  assert.equal(typeof threadId, 'string')
  return {
    child,
    observer,
    threadId,
    startupMs: Math.round(performance.now() - started),
  }
}

async function runNative(fixture) {
  const session = await startNative(fixture)
  const reports = []
  try {
    for (let index = 0; index < turns.length; index += 1) {
      const item = turns[index]
      const eventStart = session.observer.events.length
      const started = performance.now()
      sendJson(session.child, {
        method: 'turn/start',
        id: 100 + index,
        params: {
          threadId: session.threadId,
          input: [{ type: 'text', text: item.prompt }],
          model: nativeModel,
          effort,
          approvalPolicy: 'never',
          sandboxPolicy: { type: 'dangerFullAccess' },
        },
      })
      await session.observer.waitFor(
        value =>
          value.method === 'turn/completed' &&
          session.observer.events.indexOf(value) >= eventStart,
        `native turn ${item.id}`,
      )
      reports.push(nativeTurnSummary(
        session.observer.events.slice(eventStart),
        item.marker,
        Math.round(performance.now() - started),
      ))
    }
  } finally {
    await stopTree(session.child)
  }
  return { startupMs: session.startupMs, turns: reports }
}

async function startGateway(fixture) {
  const started = performance.now()
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'warm-gateway-config-'))
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

  const gateway = spawn(process.execPath, [gatewayScript, '--port', '0'], {
    cwd: root,
    // A console-less parent would otherwise have Windows hand this child a fresh
    // visible console, which Windows Terminal opens as a tab and focuses.
    windowsHide: true,
    env: {
      ...process.env,
      CODEX_HOME: accountHome,
      MODEL_GATEWAY_CODEX_TOOL_MODE: toolMode,
      MODEL_GATEWAY_LOG_TIMING: '1',
      MODEL_GATEWAY_LOG_SHAPE: '1',
      MODEL_GATEWAY_UPSTREAM_RETRIES: '0',
      MODEL_GATEWAY_UPSTREAM_TIMEOUT_MS: String(timeoutMs),
      MODEL_GATEWAY_CONSUMER_TIMEOUT_MS: String(timeoutMs),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  const gatewayObserver = observe(gateway)
  await waitForText(
    gatewayObserver,
    /model-gateway listening on http:\/\/127\.0\.0\.1:\d+/,
    'gateway startup',
  )
  const port = Number(
    gatewayObserver.stderr.match(/model-gateway listening on http:\/\/127\.0\.0\.1:(\d+)/)?.[1],
  )
  assert.ok(port > 0)

  const child = spawn(
    process.env.BUN_EXECUTABLE || 'bun.exe',
    [
      compiledCli,
      ...(bareGateway ? ['--bare'] : []),
      '--dangerously-skip-permissions',
      '--session-id',
      randomUUID(),
      '--model',
      gatewayModel,
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
        MODEL_GATEWAY_CODEX_TOOL_MODE: toolMode,
        MODEL_GATEWAY_LOG_TIMING: '1',
        MODEL_GATEWAY_LOG_SHAPE: '1',
        MODEL_GATEWAY_EFFORT_CAPABILITIES: JSON.stringify({
          [gatewayModel]: ['low', 'medium', 'high', 'xhigh', 'max'],
        }),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  )
  const observer = observe(child)
  const initStart = observer.events.length
  sendJson(child, {
    type: 'user',
    session_id: '',
    message: {
      role: 'user',
      content: 'Reply with exactly WARM_INIT_OK and nothing else.',
    },
    parent_tool_use_id: null,
  })
  await observer.waitFor(
    value => value.type === 'system' && value.subtype === 'init',
    'gateway init',
  )
  await observer.waitFor(
    value =>
      value.type === 'result' &&
      String(value.result || '').includes('WARM_INIT_OK'),
    'gateway warmup',
  )
  return {
    child,
    observer,
    gateway,
    gatewayObserver,
    configDir,
    startupMs: Math.round(performance.now() - started),
    initEventCount: observer.events.length - initStart,
  }
}

async function runGateway(fixture) {
  const session = await startGateway(fixture)
  const reports = []
  try {
    for (const item of turns) {
      const eventStart = session.observer.events.length
      const timingStart = session.gatewayObserver.stderr
        .split(/\r?\n/)
        .filter(line => line.startsWith('model-gateway timing ')).length
      const started = performance.now()
      sendJson(session.child, {
        type: 'user',
        session_id: '',
        message: { role: 'user', content: item.prompt },
        parent_tool_use_id: null,
      })
      await session.observer.waitFor(
        value =>
          value.type === 'result' &&
          session.observer.events.indexOf(value) >= eventStart,
        `gateway turn ${item.id}`,
      )
      const deadline = Date.now() + 5_000
      let timingLines = []
      while (Date.now() < deadline) {
        timingLines = session.gatewayObserver.stderr
          .split(/\r?\n/)
          .filter(line => line.startsWith('model-gateway timing '))
        if (timingLines.length > timingStart) break
        await sleep(10)
      }
      reports.push(gatewayTurnSummary(
        session.observer.events.slice(eventStart),
        item.marker,
        Math.round(performance.now() - started),
        parseTiming(timingLines.at(-1) || ''),
      ))
    }
  } finally {
    await stopTree(session.child)
    await stopTree(session.gateway)
    await rm(session.configDir, { recursive: true, force: true })
  }
  return {
    startupMs: session.startupMs,
    initEventCount: session.initEventCount,
    turns: reports,
    shapeLines: session.gatewayObserver.stderr
      .split(/\r?\n/)
      .filter(line => line.startsWith('model-gateway shape '))
      .slice(-20),
  }
}

async function main() {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'warm-tool-parity-'))
  await writeFile(path.join(fixture, 'warm-marker.txt'), 'warm benchmark fixture\n', 'utf8')
  try {
    const native = await runNative(fixture)
    const gateway = await runGateway(fixture)
    const report = {
      result:
        native.turns.length === turns.length &&
        gateway.turns.length === turns.length &&
        native.turns.every(turn => turn.success) &&
        gateway.turns.every(turn => turn.success)
          ? 'pass'
          : 'partial',
      account,
      nativeModel,
      gatewayModel,
      effort,
      toolMode,
      turns: turns.map((item, index) => ({
        id: item.id,
        marker: item.marker,
        native: native.turns[index],
        gateway: gateway.turns[index],
      })),
      nativeStartupMs: native.startupMs,
      gatewayStartupMs: gateway.startupMs,
      gatewayInitEventCount: gateway.initEventCount,
      gatewayShapeLines: gateway.shapeLines,
    }
    console.log(JSON.stringify(report))
    process.exitCode = report.result === 'pass' ? 0 : 1
  } finally {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await rm(fixture, { recursive: true, force: true })
        break
      } catch (error) {
        if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error?.code) || attempt === 7) {
          throw error
        }
        await sleep(250 * (attempt + 1))
      }
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
