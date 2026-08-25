import { randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = process.cwd()
const cc = process.env.CC_PATH || 'C:\\Users\\Ahmed\\.local\\bin\\cc.cmd'
const timeoutMs = Number(process.env.LIVE_COMPACTION_REPLAY_TIMEOUT_MS || 120_000)
const model = 'gateway-gpt-luna'
const preMarker = 'LIVE_PRE_COMPACT_TOOL_OK'
const postMarker = 'LIVE_POST_COMPACT_TOOL_OK'

function writePrompt(child, content) {
  child.stdin.write(`${JSON.stringify({
    type: 'user',
    session_id: '',
    message: { role: 'user', content },
    parent_tool_use_id: null,
  })}\n`)
}

function terminate(child) {
  if (child.exitCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
    })
  } else {
    child.kill('SIGTERM')
  }
}

function observe(child) {
  let stdout = ''
  let stderr = ''
  let remainder = ''
  const parsed = []
  const waiters = new Set()

  const notify = () => {
    for (const waiter of waiters) waiter()
  }

  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    stdout += chunk
    remainder += chunk
    const lines = remainder.split(/\r?\n/)
    remainder = lines.pop() || ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const value = JSON.parse(line)
        if (value && typeof value === 'object') parsed.push(value)
      } catch {
        // PowerShell/launcher diagnostics are kept out of the JSON protocol.
      }
    }
    notify()
  })
  child.stderr.on('data', chunk => {
    stderr += chunk
    notify()
  })

  async function waitFor(predicate, label) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const match = parsed.find(predicate)
      if (match) return match
      if (child.exitCode !== null) {
        throw new Error(`${label} was not observed before exit ${child.exitCode}`)
      }
      if (Date.now() >= deadline) {
        throw new Error(`${label} timed out after ${timeoutMs}ms`)
      }
      await new Promise(resolve => {
        const timer = setTimeout(() => {
          waiters.delete(onNotify)
          resolve()
        }, 100)
        const onNotify = () => {
          clearTimeout(timer)
          waiters.delete(onNotify)
          resolve()
        }
        waiters.add(onNotify)
      })
    }
  }

  return {
    parsed,
    get stdout() { return stdout },
    get stderr() { return stderr },
    waitFor,
  }
}

function resultText(value) {
  return String(value?.result || '')
}

function toolNames(parsed) {
  return parsed
    .filter(value => value.type === 'assistant')
    .flatMap(value => value.message?.content || [])
    .filter(block => block?.type === 'tool_use')
    .map(block => block.name)
}

async function main() {
  const sessionId = randomUUID()
  const child = spawn('cmd.exe', [
    '/d',
    '/s',
    '/c',
    cc,
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
    env: {
      ...process.env,
      MODEL_GATEWAY_DEFAULT: 'gpt-5.6-luna',
      MODEL_GATEWAY_EFFORT: 'low',
      MODEL_GATEWAY_KEEP_LOGS: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const seen = observe(child)
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    terminate(child)
  }, timeoutMs)

  try {
    // cc.ps1 validates --print input during launch, so seed the pipe before
    // waiting for the first protocol event.
    writePrompt(
      child,
      `Use the Bash tool to run "echo ${preMarker}", then reply with exactly ${preMarker} and nothing else.`,
    )
    await seen.waitFor(
      value => value.type === 'system' && value.subtype === 'init',
      'initialization',
    )

    await seen.waitFor(
      value => value.type === 'result' && resultText(value).includes(preMarker),
      'pre-compaction tool result',
    )

    writePrompt(child, '/compact')
    await seen.waitFor(
      value => value.type === 'system' && value.subtype === 'status' && value.status === 'compacting',
      'compaction start status',
    )
    await seen.waitFor(
      value => value.type === 'system' && value.subtype === 'compact_boundary',
      'native compact boundary',
    )

    writePrompt(
      child,
      `After compaction, use the Bash tool to run "echo ${postMarker}", then reply with exactly ${postMarker} and nothing else.`,
    )
    await seen.waitFor(
      value => value.type === 'result' && resultText(value).includes(postMarker),
      'post-compaction tool result',
    )

    child.stdin.end()
    const exitCode = await new Promise(resolve => {
      child.once('exit', code => resolve(code ?? 1))
    })
    clearTimeout(timer)

    const logPath = seen.stderr
      .match(/cc gateway stderr log=([^\r\n]+)/)?.[1]
      ?.trim()
    let gatewayStderr = ''
    if (logPath) {
      try {
        gatewayStderr = await readFile(logPath, 'utf8')
      } finally {
        const tempRoot = path.resolve(os.tmpdir()) + path.sep
        if (path.resolve(logPath).startsWith(tempRoot)) {
          await rm(logPath, { force: true })
        }
      }
    }
    const statuses = seen.parsed
      .filter(value => value.type === 'system' && value.subtype === 'status')
      .map(value => value.status)
    const boundaries = seen.parsed.filter(
      value => value.type === 'system' && value.subtype === 'compact_boundary',
    ).length
    const names = toolNames(seen.parsed)
    const gatewayMarkerSeen = gatewayStderr.includes(
      'model-gateway native-compaction source=compact',
    )
    const poisonedTextSeen = /no tools available|tools are unavailable|tool access is unavailable/i
      .test(seen.stdout)

    const report = {
      result: !timedOut &&
        exitCode === 0 &&
        statuses.includes('compacting') &&
        statuses.includes(null) &&
        boundaries === 1 &&
        names.includes('Bash') &&
        gatewayMarkerSeen &&
        !poisonedTextSeen
        ? 'pass'
        : 'fail',
      model,
      effort: 'low',
      exitCode,
      compactBoundaries: boundaries,
      statuses,
      toolNames: names,
      nativeGatewayMarker: gatewayMarkerSeen,
      poisonedCapabilityText: poisonedTextSeen,
      eventCount: seen.parsed.length,
      gatewayDiagnostics: gatewayStderr
        .split(/\r?\n/)
        .filter(line => /^model-gateway (native-compaction|retry|stream-error)/.test(line))
        .slice(-20),
    }
    if (report.result !== 'pass') {
      throw new Error(JSON.stringify(report))
    }

    console.log(JSON.stringify(report))
  } finally {
    clearTimeout(timer)
    terminate(child)
  }
}

main().catch(error => {
  console.log(JSON.stringify({
    result: 'fail',
    error: String(error?.message || error),
    diagnostics: String(error?.stderr || ''),
  }))
  process.exitCode = 1
})
