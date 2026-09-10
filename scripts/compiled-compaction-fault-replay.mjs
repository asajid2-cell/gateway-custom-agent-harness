import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const gatewayScript = path.join(root, 'scripts', 'model-gateway.mjs')
const cli = process.env.COMPACTION_REPLAY_CLI || path.join(root, 'dist', 'cli.js')
const bunExecutable = process.env.BUN_EXECUTABLE ||
  (process.platform === 'win32' ? 'bun.exe' : 'bun')
const timeoutMs = Number(process.env.COMPACTION_FAULT_REPLAY_TIMEOUT_MS || 8_000)
const manualMode = process.env.COMPACTION_FAULT_REPLAY_MODE === 'manual'
const manualSuccessMode =
  process.env.COMPACTION_FAULT_REPLAY_MODE === 'manual-success'
const toolMode = process.env.COMPACTION_FAULT_REPLAY_MODE === 'tool'
const toolPoisonMode =
  process.env.COMPACTION_FAULT_REPLAY_MODE === 'tool-poison'
const sessionMemoryMode =
  process.env.COMPACTION_FAULT_REPLAY_MODE === 'session-memory'
const overflowMode = process.env.COMPACTION_FAULT_REPLAY_MODE === 'overflow'
const ttyMode = process.env.COMPACTION_FAULT_REPLAY_MODE === 'tty'
const partialTtyMode =
  process.env.COMPACTION_FAULT_REPLAY_MODE === 'partial-tty'
const sessionMemoryMarker = 'SESSION_MEMORY_REPLAY_MARKER'

function completedResponse(text, inputTokens = 45_000) {
  return {
    id: `resp-${Date.now()}`,
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
    // The large input count forces the next turn through auto-compaction when
    // CLAUDE_CODE_AUTO_COMPACT_WINDOW is reduced for this replay.
    usage: {
      input_tokens: inputTokens,
      output_tokens: 2,
      total_tokens: inputTokens + 2,
    },
  }
}

function sendNormalResponse(res, text = 'FIRST_OK', inputTokens = 45_000) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(`data: ${JSON.stringify({
    type: 'response.output_text.delta',
    delta: text,
  })}\n\n`)
  res.end(`data: ${JSON.stringify({
    type: 'response.completed',
    response: completedResponse(text, inputTokens),
  })}\n\n`)
}

function sendToolResponse(res, inputTokens = 45_000) {
  const argumentsText = JSON.stringify({
    command: 'echo TOOL_OK',
    description: 'Emit the tool replay marker.',
  })
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(`data: ${JSON.stringify({
    type: 'response.output_item.added',
    item: {
      type: 'function_call',
      call_id: 'call-tool-replay',
      name: 'Bash',
    },
  })}\n\n`)
  res.write(`data: ${JSON.stringify({
    type: 'response.function_call_arguments.delta',
    delta: argumentsText,
  })}\n\n`)
  res.write(`data: ${JSON.stringify({
    type: 'response.output_item.done',
    item: {
      type: 'function_call',
      call_id: 'call-tool-replay',
      name: 'Bash',
      arguments: argumentsText,
    },
  })}\n\n`)
  res.end(`data: ${JSON.stringify({
    type: 'response.completed',
      response: {
      ...completedResponse('', inputTokens),
      output: [{
        type: 'function_call',
        call_id: 'call-tool-replay',
        name: 'Bash',
        arguments: argumentsText,
      }],
    },
  })}\n\n`)
}

function responseInputText(item) {
  const content = item?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(part => {
    if (typeof part === 'string') return part
    return typeof part?.text === 'string' ? part.text : ''
  }).join('\n')
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function waitForListening(child, pattern, label) {
  let stderr = ''
  let childError = null
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr += chunk })
  child.once('error', error => {
    childError = error
    stderr += `${String(error?.stack || error)}\n`
  })
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const match = stderr.match(pattern)
    if (match) return { port: Number(match[1]), stderr: () => stderr }
    if (childError) {
      throw new Error(`${label} could not start:\n${stderr}`)
    }
    if (child.exitCode !== null) {
      throw new Error(`${label} exited before startup:\n${stderr}`)
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`${label} startup timed out:\n${stderr}`)
}

function writeStreamJsonPrompt(child, prompt) {
  child.stdin.write(JSON.stringify({
    type: 'user',
    session_id: '',
    message: { role: 'user', content: prompt },
    parent_tool_use_id: null,
  }) + '\n')
}

function observeChild(child) {
  let stdout = ''
  let stderr = ''
  let stdoutRemainder = ''
  let childError = null
  const parsed = []
  const waiters = new Set()

  const notify = () => {
    for (const waiter of waiters) waiter()
  }

  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    stdout += chunk
    stdoutRemainder += chunk
    const lines = stdoutRemainder.split(/\r?\n/)
    stdoutRemainder = lines.pop() ?? ''
    for (const line of lines) {
      if (!line) continue
      try {
        const value = JSON.parse(line)
        if (value && typeof value === 'object') parsed.push(value)
      } catch {
        // Non-JSON diagnostics remain available in the raw output.
      }
    }
    notify()
  })
  child.stderr.on('data', chunk => { stderr += chunk })
  child.once('error', error => {
    childError = error
    stderr += `${String(error?.stack || error)}\n`
    notify()
  })

  async function waitFor(predicate, deadlineMs, label) {
    const deadline = Date.now() + deadlineMs
    for (;;) {
      const match = parsed.find(predicate)
      if (match) return match
      if (childError) {
        throw new Error(`${label} failed to start or run:\n${stderr}`)
      }
      if (child.exitCode !== null) {
        throw new Error(
          `${label} was not observed before child exit ${child.exitCode}`,
        )
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        throw new Error(`${label} timed out after ${deadlineMs}ms`)
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
    get stdout() {
      return stdout
    },
    get stderr() {
      return stderr
    },
    get parsed() {
      return parsed
    },
    waitFor,
  }
}

async function collectChild(child, observer, deadlineMs) {
  const started = performance.now()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, deadlineMs)
  const exitCode = await new Promise(resolve => {
    child.once('exit', code => resolve(code ?? 1))
  })
  clearTimeout(timer)
  return {
    exitCode,
    timedOut,
    elapsedMs: Math.round(performance.now() - started),
    stdout: observer.stdout,
    stderr: observer.stderr,
  }
}

async function main() {
  const state = {
    totalRequests: 0,
    compactionRequests: 0,
    compactionAborted: false,
    responseClosed: false,
    toolCalls: 0,
    toolResults: 0,
    reconciliationSeen: false,
    poisonSeen: false,
    sessionMemorySeen: false,
    postCompactionToolCounts: [],
    missingToolCatalog: false,
    promptTooLongResponses: 0,
    successfulNormalResponses: 0,
  }
  const provider = createServer(async (req, res) => {
    const body = await readJson(req)
    state.totalRequests += 1
    const serializedBody = JSON.stringify(body)
    const inputItems = Array.isArray(body?.input) ? body.input : []
    if (serializedBody.includes(sessionMemoryMarker)) {
      state.sessionMemorySeen = true
    }
    const hasToolResult = inputItems.some(
      item => item?.type === 'function_call_output',
    )
    if (hasToolResult) state.toolResults += 1
    // The Responses request carries ordinary system instructions that may
    // mention compaction. Only the dedicated user summary prompt is a
    // compaction request; classify it by role and its exact contract.
    const terminalInput = inputItems.at(-1)
    const compaction = terminalInput?.role === 'user' &&
      (() => {
        const text = responseInputText(terminalInput).toLowerCase()
        return text.includes(
          'critical: respond with text only. do not call any tools.',
        ) && text.includes('<summary>') && text.includes('summariz')
      })()
    const toolCount = Array.isArray(body?.tools) ? body.tools.length : 0

    if (!compaction) {
      if (
        overflowMode &&
        state.successfulNormalResponses === 1 &&
        state.compactionRequests === 0
      ) {
        state.promptTooLongResponses += 1
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          error: {
            type: 'invalid_request_error',
            message: 'Prompt is too long: 71000 tokens > 70000 maximum',
          },
        }))
        return
      }
      if (overflowMode && state.compactionRequests > 0) {
        state.successfulNormalResponses += 1
        sendNormalResponse(res, 'SECOND_OK', 100)
        return
      }
      if (toolPoisonMode && state.compactionRequests > 0) {
        const staleControl = [
          'Runtime capability reconciliation',
          'compaction-summary-data',
          'CRITICAL: Respond with TEXT ONLY',
          'No filesystem, task, or shell tools are available',
          'Do not assume that the attached tools are available',
          'tool calls will be rejected',
        ].some(marker => serializedBody.includes(marker))
        if (staleControl) state.poisonSeen = true
        state.postCompactionToolCounts.push(toolCount)
        if (staleControl || toolCount === 0) {
          if (toolCount === 0) state.missingToolCatalog = true
          sendNormalResponse(res, 'POST_COMPACT_NO_TOOLS', 100)
        } else if (state.toolCalls === 0) {
          state.toolCalls += 1
          sendToolResponse(res, 100)
        } else if (hasToolResult) {
          sendNormalResponse(res, 'TOOL_OK', 100)
        } else {
          sendNormalResponse(res, 'SECOND_OK')
        }
        return
      }
      if (
        partialTtyMode &&
        serializedBody.includes('Third turn.')
      ) {
        sendNormalResponse(res, 'THIRD_OK', 100)
        return
      }
      if (
        toolMode &&
        serializedBody.includes('Reply with exactly SECOND_OK and nothing else.')
      ) {
        sendNormalResponse(res, 'SECOND_OK')
        return
      }
      if (toolMode && state.toolCalls === 0) {
        if (toolCount === 0) state.missingToolCatalog = true
        state.toolCalls += 1
        sendToolResponse(res)
        return
      }
      if (toolMode && hasToolResult) {
        sendNormalResponse(res, 'TOOL_OK')
        return
      }
      if (overflowMode) state.successfulNormalResponses += 1
      sendNormalResponse(
        res,
        state.successfulNormalResponses === 1 || state.totalRequests === 1
          ? 'FIRST_OK'
          : 'SECOND_OK',
        partialTtyMode ? 100 : overflowMode ? 30_000 : 45_000,
      )
      return
    }

    state.compactionRequests += 1
    if (partialTtyMode) {
      setTimeout(() => {
        if (!res.destroyed) {
          sendNormalResponse(res, 'Partial summary preserved.', 100)
        }
      }, 500)
      return
    }
    if (manualSuccessMode) {
      if (process.env.COMPACTION_REPLAY_KEEP_STREAM_OPEN === '1') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ type: 'response.completed', response: completedResponse('Manual summary preserved.', 100) })}\n\n`)
      } else {
        sendNormalResponse(res, 'Manual summary preserved.', 100)
      }
      return
    }
    if (overflowMode) {
      sendNormalResponse(res, 'Overflow recovery summary preserved.', 100)
      return
    }
    if (toolPoisonMode) {
      sendNormalResponse(
        res,
        [
          'Historical note: the assistant previously claimed that filesystem and shell tools were unavailable.',
          'The prior claim may have been caused by a tool wiring failure.',
          'Continue from the summary and do not assume tools are available.',
        ].join('\n'),
        100,
      )
      return
    }
    if (ttyMode) {
      setTimeout(() => {
        if (!res.destroyed) {
          sendNormalResponse(res, 'Summary preserved.', 100)
        }
      // Keep the provider response safely beyond the five-second heartbeat
      // interval so the TTY verifier must observe an actual progress frame.
      }, 7_000)
      return
    }
    req.once('aborted', () => { state.compactionAborted = true })
    res.once('close', () => { state.responseClosed = true })
    // No headers and no body: only a real compaction timeout/cancellation can
    // terminate this request.
  })
  await new Promise((resolve, reject) => {
    provider.once('error', reject)
    provider.listen(0, '127.0.0.1', resolve)
  })

  const codexHome = await mkdtemp(path.join(os.tmpdir(), 'gateway-compact-fault-'))
  const claudeConfig = await mkdtemp(
    path.join(os.tmpdir(), 'gateway-compact-claude-'),
  )
  const sessionId = randomUUID()
  if (ttyMode) {
    await writeFile(
      path.join(claudeConfig, '.claude.json'),
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
  }
  if (sessionMemoryMode) {
    const sanitizedCwd = root.replace(/[^a-zA-Z0-9]/g, '-')
    const memoryDir = path.join(
      claudeConfig,
      'projects',
      sanitizedCwd,
      sessionId,
      'session-memory',
    )
    await mkdir(memoryDir, { recursive: true })
    await writeFile(
      path.join(memoryDir, 'summary.md'),
      [
        '# Session Memory',
        '',
        '## Current State',
        sessionMemoryMarker,
        '',
        '## Important Instructions',
        'Preserve this marker during the replay.',
      ].join('\n'),
    )
  }
  await writeFile(
    path.join(codexHome, 'auth.json'),
    JSON.stringify({ tokens: { access_token: 'test-token', account_id: 'test-account' } }),
  )

  const gateway = spawn(process.execPath, [gatewayScript, '--port', '0'], {
    cwd: root,
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      CODEX_RESPONSES_URL: `http://127.0.0.1:${provider.address().port}/responses`,
      MODEL_GATEWAY_UPSTREAM_RETRIES: '0',
      MODEL_GATEWAY_UPSTREAM_TIMEOUT_MS:
        ttyMode || partialTtyMode ? '8000' : '300',
      MODEL_GATEWAY_RETRY_ATTEMPT_TIMEOUT_MS:
        ttyMode || partialTtyMode ? '8000' : '300',
      MODEL_GATEWAY_CONSUMER_TIMEOUT_MS:
        ttyMode || partialTtyMode ? '12000' : '1000',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })

  let gatewayInfo
  let cliChild
  try {
    gatewayInfo = await waitForListening(
      gateway,
      /listening on http:\/\/127\.0\.0\.1:(\d+)/,
      'gateway',
    )
    const commonCliEnv = {
      ...process.env,
      CLAUDE_CODE_GATEWAY_BASE_URL: `http://127.0.0.1:${gatewayInfo.port}`,
      CLAUDE_CODE_GATEWAY_TOKEN: 'local-gateway',
      ANTHROPIC_AUTH_TOKEN: undefined,
      ANTHROPIC_API_KEY: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      MODEL_GATEWAY_MODEL: 'gateway-gpt-luna',
      CLAUDE_CODE_USE_GATEWAY: '1',
      CLAUDE_GATEWAY_ALLOW_LOOPBACK: '1',
      CLAUDE_CONFIG_DIR: claudeConfig,
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '70000',
      CLAUDE_CODE_COMPACTION_TIMEOUT_MS:
        ttyMode || partialTtyMode ? '10000' : '80',
      ...(sessionMemoryMode
        ? { ENABLE_CLAUDE_CODE_SM_COMPACT: '1' }
        : {}),
      CODEX_HOME: codexHome,
      MODEL_GATEWAY_EFFORT_CAPABILITIES: JSON.stringify({
        'gateway-gpt-luna': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      }),
    }
    if (ttyMode || partialTtyMode) {
      const capture = spawn('python', [
        path.join(root, 'scripts', 'conpty-compaction-capture.py'),
        bunExecutable,
        cli,
        '--dangerously-skip-permissions',
        '--session-id',
        sessionId,
        '--model',
        'gateway-gpt-luna',
      ], {
        cwd: root,
        env: {
          ...commonCliEnv,
          COMPACTION_DEBUG_TRACE: '1',
          COMPACTION_TTY_SESSION_ID: sessionId,
          COMPACTION_TTY_SCENARIO: partialTtyMode
            ? 'partial'
            : 'automatic',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const result = await collectChild(
        capture,
        observeChild(capture),
        timeoutMs + 15_000,
      )
      let captureReport
      try {
        captureReport = JSON.parse(
          result.stdout.split(/\r?\n/).filter(Boolean).at(-1) ?? '',
        )
      } catch {
        captureReport = {
          result: 'fail',
          error: 'ConPTY capture did not emit a JSON report',
        }
      }
      const report = {
        result:
          !result.timedOut &&
          result.exitCode === 0 &&
          captureReport.result === 'pass' &&
          captureReport.sawResumeFooter &&
          captureReport.sawProgress &&
          captureReport.sawSecond &&
          (!partialTtyMode ||
            (captureReport.sawPartial && captureReport.sawThird)) &&
          state.compactionRequests === 1
            ? 'pass'
            : 'fail',
        mode: partialTtyMode ? 'partial-tty' : 'tty',
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        elapsedMs: result.elapsedMs,
        provider: state,
        capture: captureReport,
        captureStdoutTail: result.stdout.split(/\r?\n/).slice(-80),
        captureStderrTail: result.stderr.split(/\r?\n/).slice(-20),
        gatewayStderrTail: gatewayInfo.stderr().split(/\r?\n/).slice(-20),
      }
      console.log(JSON.stringify(report))
      process.exitCode = report.result === 'pass' ? 0 : 1
      return
    }
    cliChild = spawn(bunExecutable, [
      cli,
      '--dangerously-skip-permissions',
      '--session-id',
      sessionId,
      '--model',
      'gateway-gpt-luna',
      '--print',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
    ], {
      cwd: root,
      env: commonCliEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const observer = observeChild(cliChild)
    writeStreamJsonPrompt(
      cliChild,
      toolMode
        ? 'Use the Bash tool to run echo TOOL_OK, then report the result.'
        : toolPoisonMode
          ? 'Use the Bash tool after compaction to run echo TOOL_OK, then report the result.'
        : 'Reply with exactly FIRST_OK and nothing else.',
    )
    await observer.waitFor(
      value => value.type === 'system' && value.subtype === 'init',
      timeoutMs,
      'stream-json init',
    )
    await observer.waitFor(
      value =>
        value.type === 'result' &&
        (toolMode
          ? String(value.result || '').includes('TOOL_OK')
          : String(value.result || '').includes('FIRST_OK')),
      timeoutMs,
      'first terminal result',
    )

    if (manualSuccessMode) {
      writeStreamJsonPrompt(cliChild, '/compact')
      await observer.waitFor(
        value =>
          value.type === 'system' && value.subtype === 'compact_boundary',
        timeoutMs,
        'manual compact boundary',
      )
      writeStreamJsonPrompt(
        cliChild,
        'Reply with exactly SECOND_OK and nothing else.',
      )
    } else {
      writeStreamJsonPrompt(
        cliChild,
        manualMode
          ? '/compact'
          : 'Reply with exactly SECOND_OK and nothing else.',
      )
    }
    cliChild.stdin.end()

    const result = await collectChild(cliChild, observer, timeoutMs)
    const outputLines = result.stdout.split(/\r?\n/).filter(Boolean)
    const parsed = observer.parsed
    const terminalResults = parsed.filter(value => value.type === 'result')
    const statusValues = parsed
      .filter(value => value.type === 'system' && value.subtype === 'status')
      .map(value => value.status)
    const sawCompacting = statusValues.includes('compacting')
    const sawStatusClear = statusValues.includes(null)
    const successfulContinuation = terminalResults.some(value =>
      value.subtype === 'success' &&
      value.is_error === false &&
      String(value.result || '').includes('SECOND_OK'),
    )
    const successfulToolContinuation = terminalResults.some(value =>
      value.subtype === 'success' &&
      value.is_error === false &&
      String(value.result || '').includes('TOOL_OK'),
    )
    const timedOutExecutionError = terminalResults.some(value =>
      value.subtype === 'error_during_execution' &&
      value.is_error === true &&
      Array.isArray(value.errors) &&
      value.errors.some(error => String(error).includes('Compaction timed out')),
    )
    const toolContinuation = toolMode &&
      state.toolCalls >= 1 &&
      state.toolResults >= 1 &&
      outputLines.some(line =>
        line.includes('TOOL_OK') &&
        line.includes('"name":"Bash"') &&
        !line.includes('No such tool available'),
      )
    const poisonedToolContinuation = toolPoisonMode &&
      state.toolCalls >= 1 &&
      state.toolResults >= 1 &&
      state.postCompactionToolCounts.length >= 1 &&
      state.postCompactionToolCounts.every(count => count > 0) &&
      !state.poisonSeen &&
      !state.missingToolCatalog &&
      outputLines.some(line =>
        line.includes('TOOL_OK') &&
        line.includes('"name":"Bash"') &&
        !line.includes('No such tool available'),
      )
    const successfulPoisonedContinuation = terminalResults.some(value =>
      value.subtype === 'success' &&
      value.is_error === false &&
      String(value.result || '').includes('TOOL_OK'),
    )
    const sessionMemoryContinuation =
      sessionMemoryMode &&
      state.compactionRequests === 1 &&
      !state.sessionMemorySeen &&
      successfulContinuation
    const compactSignals = `${result.stdout}\n${result.stderr}`.match(
      /compact|compacting|Compaction timed out/gi,
    ) || []
    const compactionBoundaryTerminated = sessionMemoryMode
      ? state.compactionRequests === 1
      : manualSuccessMode
        ? state.compactionRequests === 1
        : overflowMode
          ? state.compactionRequests === 1 && state.promptTooLongResponses >= 1
          : toolPoisonMode
            ? state.compactionRequests === 1
            : state.compactionRequests >= 1 &&
              (state.compactionAborted || state.responseClosed)

    const report = {
      result: !result.timedOut &&
        compactionBoundaryTerminated &&
        sawCompacting &&
        sawStatusClear &&
        (manualMode
          ? timedOutExecutionError
          : manualSuccessMode
            ? successfulContinuation
            : overflowMode
              ? successfulContinuation
              : toolMode
                ? toolContinuation &&
                  successfulToolContinuation &&
                  successfulContinuation
                : toolPoisonMode
                  ? poisonedToolContinuation &&
                    successfulToolContinuation &&
                    successfulPoisonedContinuation
                  : sessionMemoryMode
                    ? sessionMemoryContinuation
                    : successfulContinuation)
        ? 'pass'
        : 'fail',
      ...result,
      stdout: undefined,
      stderr: undefined,
      outputTail: outputLines.slice(-20),
      terminalResults: terminalResults.slice(-4).map(value => ({
        subtype: value.subtype,
        is_error: value.is_error,
        errors: value.errors,
      })),
      statusValues,
      sawCompacting,
      sawStatusClear,
      successfulContinuation,
      successfulToolContinuation,
      timedOutExecutionError,
      toolContinuation,
      poisonedToolContinuation,
      successfulPoisonedContinuation,
      reconciliationSeen: state.reconciliationSeen,
      poisonSeen: state.poisonSeen,
      sessionMemoryContinuation,
      compactSignalCount: compactSignals.length,
      provider: state,
      mode: manualMode
        ? 'manual'
        : manualSuccessMode
          ? 'manual-success'
          : overflowMode
            ? 'overflow'
            : toolMode
              ? 'tool'
              : toolPoisonMode
                ? 'tool-poison'
                : sessionMemoryMode
                  ? 'session-memory'
                  : 'automatic',
      gatewayStderrTail: gatewayInfo.stderr().split(/\r?\n/).slice(-20),
      cliStderrTail: result.stderr.split(/\r?\n/).slice(-20),
    }
    console.log(JSON.stringify(report))
    process.exitCode = report.result === 'pass' ? 0 : 1
  } finally {
    if (cliChild?.exitCode === null) cliChild.kill()
    if (gateway.exitCode === null) gateway.kill()
    await Promise.all([
      new Promise(resolve => provider.close(resolve)),
      rm(codexHome, { recursive: true, force: true }),
      rm(claudeConfig, { recursive: true, force: true }),
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
