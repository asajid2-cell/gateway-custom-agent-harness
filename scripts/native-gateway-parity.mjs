import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ccScript = path.join(root, 'scripts', 'cc.ps1')
const accountManager = path.join(
  process.env.USERPROFILE || 'C:\\Users\\Ahmed',
  '.codex',
  'codex-account-manager.ps1',
)
const nativeAccount = process.env.PARITY_CODEX_ACCOUNT || 'freedock'
const nativeModel = process.env.PARITY_NATIVE_MODEL || 'gpt-5.6-luna'
const gatewayModel = process.env.PARITY_GATEWAY_MODEL || 'gateway-gpt-luna'
const effort = process.env.PARITY_EFFORT || 'low'
const timeoutMs = Number(process.env.PARITY_TIMEOUT_MS || 120_000)
const artifactPath = process.env.PARITY_ARTIFACT ||
  path.join(
    root,
    'scripts',
    'live-evidence',
    `native-gateway-parity-${Date.now()}.json`,
  )

const cases = [
  {
    id: 'text',
    marker: 'PARITY_TEXT_OK',
    prompt: 'Reply with exactly PARITY_TEXT_OK and nothing else.',
  },
  {
    id: 'reasoning',
    marker: 'PARITY_REASONING_OK',
    prompt:
      'Evaluate this arithmetic exactly: (17 * 19) + 3 = 326. Reply with exactly PARITY_REASONING_OK and nothing else.',
  },
  {
    id: 'tool',
    marker: 'PARITY_TOOL_OK',
    prompt:
      'Use an available tool to read package.json. It contains the project name @anthropic-ai/claude-code. Do not guess or answer before the tool result; after reading it, reply with exactly PARITY_TOOL_OK and nothing else.',
  },
  {
    id: 'tool-shell',
    marker: 'PARITY_SHELL_OK',
    prompt:
      'Use the shell or command-execution tool to run a command in the current workspace that prints exactly PARITY_SHELL_OK. Do not answer before the tool runs; after the tool result, reply with exactly PARITY_SHELL_OK and nothing else.',
  },
]
const selectedCases = process.env.PARITY_CASES
  ? cases.filter(item =>
      process.env.PARITY_CASES.split(',').map(value => value.trim()).includes(item.id),
    )
  : cases

function classifyFailure(stdout, stderr, timedOut) {
  if (timedOut) return 'timeout'
  const text = `${stdout}\n${stderr}`.toLowerCase()
  if (text.includes('econnrefused') || text.includes('unable to connect')) {
    return 'connection'
  }
  if (text.includes('429') || text.includes('rate limit')) return 'rate-limit'
  if (text.includes('400') || text.includes('bad request')) return 'bad-request'
  if (text.includes('context')) return 'context-window'
  return 'process-failure'
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

function numericField(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function totalInputTokens(inputTokens, cachedInputTokens, harness) {
  if (inputTokens == null) return null
  if (harness === 'gateway-cc') {
    return inputTokens + (cachedInputTokens || 0)
  }
  return inputTokens
}

function eventTimestamp(event) {
  const value = event?.timestamp || event?.created_at || event?.createdAt
  if (typeof value !== 'string') return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

function eventDurationMs(events, startType, endType) {
  const start = events.find(event => event.type === startType)
  const end = [...events].reverse().find(event => event.type === endType)
  const startMs = eventTimestamp(start)
  const endMs = eventTimestamp(end)
  if (startMs == null || endMs == null || endMs < startMs) return null
  return endMs - startMs
}

function stopTree(child) {
  if (child.exitCode !== null) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
    } catch {}
  } else {
    child.kill('SIGTERM')
  }
}

async function runBounded(executable, args, options = {}) {
  const started = performance.now()
  const child = spawn(executable, args, {
    cwd: options.cwd || root,
    env: { ...process.env, ...(options.env || {}) },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    stopTree(child)
  }, timeoutMs)

  if (options.input != null) {
    child.stdin.end(options.input)
  } else {
    child.stdin.end()
  }

  const [exitCode] = await new Promise(resolve => {
    child.once('exit', (code, signal) => resolve([code, signal]))
    child.once('error', error => {
      stderr += `process-error:${error.name}\n`
      resolve([null, null])
    })
  })
  clearTimeout(timer)

  return {
    exitCode,
    timedOut,
    wallMs: Math.round(performance.now() - started),
    stdout,
    stderr,
  }
}

function summarizeNative(run, marker) {
  const events = parseJsonLines(run.stdout)
  const usage = events.find(event => event.type === 'turn.completed')?.usage || {}
  const messages = events
    .filter(event => event.type === 'item.completed')
    .map(event => event.item)
    .filter(item => item?.type === 'agent_message')
  const toolItems = events
    .map(event => event.item)
    .filter(item =>
      item?.type === 'command_execution' ||
      item?.type === 'file_change' ||
      item?.type === 'mcp_tool_call' ||
      item?.type === 'computer_call',
    )
  const finalText = messages.at(-1)?.text || ''
  const turnMs = eventDurationMs(events, 'turn.started', 'turn.completed')
  const threadMs = eventDurationMs(events, 'thread.started', 'turn.completed')
  return {
    harness: 'native-codex',
    model: nativeModel,
    effort,
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    wallMs: run.wallMs,
    turnMs,
    launchOverheadMs:
      turnMs == null ? null : Math.max(0, run.wallMs - turnMs),
    threadMs,
    success: run.exitCode === 0 && !run.timedOut && finalText.includes(marker),
    markerPresent: finalText.includes(marker),
    finalTextLength: finalText.length,
    toolCount: toolItems.length,
    toolTypes: [...new Set(toolItems.map(item => item.type))],
    inputTokens: usage.input_tokens ?? null,
    cachedInputTokens: usage.cached_input_tokens ?? null,
    totalInputTokens: totalInputTokens(
      usage.input_tokens ?? null,
      usage.cached_input_tokens ?? null,
      'native-codex',
    ),
    outputTokens: usage.output_tokens ?? null,
    reasoningOutputTokens: usage.reasoning_output_tokens ?? null,
    totalTokens:
      usage.input_tokens != null && usage.output_tokens != null
        ? totalInputTokens(
            usage.input_tokens,
            usage.cached_input_tokens ?? null,
            'native-codex',
          ) + usage.output_tokens
        : null,
    failureClass:
      run.exitCode === 0 && !run.timedOut
        ? null
        : classifyFailure(run.stdout, run.stderr, run.timedOut),
  }
}

function summarizeGateway(run, marker) {
  const events = parseJsonLines(run.stdout)
  const result = events
    .filter(event => event.type === 'result')
    .at(-1)
  const assistantMessages = events
    .filter(event => event.type === 'assistant')
    .map(event => event.message)
  const toolBlocks = assistantMessages
    .flatMap(message => message?.content || [])
    .filter(block => block?.type === 'tool_use')
  const finalText = typeof result?.result === 'string' ? result.result : ''
  const usage = result?.usage || {}
  const diagnosticStderr = `${run.stderr}\n${run.gatewayStderr || ''}`
  const timingLines = diagnosticStderr
    .split(/\r?\n/)
    .map(line => parseKeyValueLine(line, 'model-gateway timing '))
    .filter(Boolean)
  const shapeLines = diagnosticStderr
    .split(/\r?\n/)
    .map(line => parseKeyValueLine(line, 'model-gateway shape '))
    .filter(Boolean)
  const timing = timingLines.at(-1) || null
  const shapes = shapeLines.map(shape => ({
    model: shape.model || null,
    backend: shape.backend || null,
    protocol: shape.protocol || null,
    querySource: shape.query_source || null,
    variant: numericField(shape.variant),
    stream: shape.stream || null,
    effort: shape.effort || null,
    anthropicBytes: numericField(shape.anthropic_bytes),
    systemBytes: numericField(shape.system_bytes),
    messageBytes: numericField(shape.message_bytes),
    toolSchemaBytes: numericField(shape.tool_schema_bytes),
    systemBlockCount: numericField(shape.system_block_count),
    messageCount: numericField(shape.message_count),
    toolCount: numericField(shape.tool_count),
    providerInputItems: numericField(shape.provider_input_items),
    providerInputBytes: numericField(shape.provider_input_bytes),
    providerInstructionsBytes: numericField(shape.provider_instructions_bytes),
    providerToolCount: numericField(shape.provider_tool_count),
    providerToolSchemaBytes: numericField(shape.provider_tool_schema_bytes),
    providerRequestBytes: numericField(shape.provider_request_bytes),
    providerLastInputBytes: numericField(shape.provider_last_input_bytes),
    providerPrefixBytes: numericField(shape.provider_prefix_bytes),
    providerPrefixFingerprint: shape.provider_prefix_fingerprint || null,
    promptCacheKeyPresent: numericField(shape.prompt_cache_key_present),
    promptCacheKeyFingerprint: shape.prompt_cache_key_fingerprint || null,
    cachePrefixState: shape.cache_prefix_state || null,
    cacheKeyMode: shape.cache_key_mode || null,
  }))
  const harnessMs = numericField(result?.duration_ms)
  const apiMs = numericField(result?.duration_api_ms)
  return {
    harness: 'gateway-cc',
    model: gatewayModel,
    effort,
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    wallMs: run.wallMs,
    apiMs,
    harnessMs,
    launchOverheadMs:
      harnessMs == null ? null : Math.max(0, run.wallMs - harnessMs),
    timing: timing
      ? {
          upstreamConnectMs: numericField(timing.upstream_connect_ms),
          firstByteMs: numericField(timing.first_byte_ms),
          firstOutputMs: numericField(timing.first_output_ms),
          completionMs: numericField(timing.completion_ms),
          errorMs: numericField(timing.error_ms),
          bytes: numericField(timing.bytes),
          events: numericField(timing.events),
          status: numericField(timing.status),
          outcome: timing.outcome || null,
          errorClass: timing.error_class || null,
        }
      : null,
    requestShapes: shapes,
    success:
      run.exitCode === 0 &&
      !run.timedOut &&
      result?.subtype === 'success' &&
      result?.is_error === false &&
      finalText.includes(marker),
    markerPresent: finalText.includes(marker),
    finalTextLength: finalText.length,
    toolCount: toolBlocks.length,
    toolTypes: [...new Set(toolBlocks.map(block => block.name))],
    inputTokens: usage.input_tokens ?? null,
    cachedInputTokens: usage.cache_read_input_tokens ?? null,
    totalInputTokens: totalInputTokens(
      usage.input_tokens ?? null,
      usage.cache_read_input_tokens ?? null,
      'gateway-cc',
    ),
    outputTokens: usage.output_tokens ?? null,
    reasoningOutputTokens: usage.reasoning_output_tokens ?? null,
    totalTokens:
      usage.input_tokens != null && usage.output_tokens != null
        ? totalInputTokens(
            usage.input_tokens,
            usage.cache_read_input_tokens ?? null,
            'gateway-cc',
          ) + usage.output_tokens
        : null,
    failureClass:
      run.exitCode === 0 && !run.timedOut
        ? null
        : classifyFailure(run.stdout, run.stderr, run.timedOut),
  }
}

async function runNative(fixture, prompt) {
  return runBounded(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      accountManager,
      'exec',
      nativeAccount,
      '--ephemeral',
      '--json',
      '--model',
      nativeModel,
      '--config',
      `model_reasoning_effort=${effort}`,
      '--cd',
      fixture,
      '--dangerously-bypass-approvals-and-sandbox',
    ],
    { cwd: fixture, input: `${prompt}\n` },
  )
}

async function runGateway(fixture, prompt) {
  const run = await runBounded(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      ccScript,
      '--print',
      '--model',
      gatewayModel,
      '--effort',
      effort,
      '--output-format',
      'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      prompt,
    ],
    {
      cwd: fixture,
      env: {
        MODEL_GATEWAY_LOG_SHAPE: '1',
        MODEL_GATEWAY_LOG_TIMING: '1',
        MODEL_GATEWAY_KEEP_LOGS: '1',
      },
    },
  )
  const gatewayLogs = []
  for (const line of run.stderr.split(/\r?\n/)) {
    const match = line.match(/^cc gateway stderr log=(.+)$/)
    if (!match) continue
    const logPath = match[1].trim()
    try {
      const absolutePath = path.resolve(logPath)
      const tempRoot = path.resolve(os.tmpdir())
      if (
        absolutePath === tempRoot ||
        !absolutePath.toLowerCase().startsWith(`${tempRoot.toLowerCase()}${path.sep}`)
      ) {
        continue
      }
      gatewayLogs.push(await readFile(absolutePath, 'utf8'))
      await rm(absolutePath, { force: true })
    } catch {
      // Diagnostics are optional; the consumer result remains authoritative.
    }
  }
  return {
    ...run,
    gatewayStderr: gatewayLogs.join('\n'),
  }
}

async function main() {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'gateway-native-parity-'))
  await writeFile(
    path.join(fixture, 'parity.txt'),
    'PARITY_TOOL_OK\n',
    'utf8',
  )
  await writeFile(
    path.join(fixture, 'package.json'),
    await readFile(path.join(root, 'package.json'), 'utf8'),
    'utf8',
  )

  const casesReport = []
  try {
    for (const item of selectedCases) {
      const nativeRun = await runNative(fixture, item.prompt)
      const gatewayRun = await runGateway(fixture, item.prompt)
      casesReport.push({
        id: item.id,
        marker: item.marker,
        native: summarizeNative(nativeRun, item.marker),
        gateway: summarizeGateway(gatewayRun, item.marker),
      })
    }

    const report = {
      result: casesReport.every(item => item.native.success && item.gateway.success)
        ? 'pass'
        : 'partial',
      account: nativeAccount,
      nativeModel,
      gatewayModel,
      effort,
      cases: casesReport,
      notes: [
        'Gateway input usage includes the Claude harness system prompt, skills, and tool catalog.',
        'Native input usage is Codex-native and is not directly equal to Gateway input usage.',
        'Gateway input_tokens is uncached input; totalInputTokens adds cache_read_input_tokens for a comparable prompt-total view.',
        'Wall time includes CLI startup; launchOverheadMs is a cold-process approximation, not an in-session measurement.',
        'Gateway requestShapes contain sizes and counts only; system_bytes includes the harness system prompt and embedded skills.',
        'Native JSON events expose no timestamps or turn duration in this environment, so native provider latency cannot be isolated from CLI wall time.',
      ],
    }
    await writeFile(artifactPath, JSON.stringify(report, null, 2) + '\n', 'utf8')
    console.log(JSON.stringify(report))
    process.exitCode = report.result === 'pass' ? 0 : 1
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.log(JSON.stringify({
    result: 'fail',
    failureClass: error?.name || 'Error',
  }))
  process.exitCode = 1
})
