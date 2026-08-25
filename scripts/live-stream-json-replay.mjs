import { spawn } from 'node:child_process'

const timeoutMs = Number(process.env.STREAM_REPLAY_TIMEOUT_MS || 180_000)
const cc = process.env.CC_PATH || 'C:\\Users\\Ahmed\\.local\\bin\\cc.cmd'
const args = [
  '--dangerously-skip-permissions',
  '--print',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
]

const prompts = (process.env.STREAM_REPLAY_PROMPTS || 'STREAM_ONE_OK,STREAM_TWO_OK')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean)

const input = prompts
  .map(expected => JSON.stringify({
    type: 'user',
    session_id: '',
    message: {
      role: 'user',
      content: `Reply with exactly ${expected} and nothing else.`,
    },
    parent_tool_use_id: null,
  }))
  .join('\n') + '\n'

const child = spawn('cmd.exe', ['/d', '/s', '/c', cc, ...args], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe'],
})

let stdout = ''
let stderr = ''
let killedByTimeout = false
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', chunk => { stdout += chunk })
child.stderr.on('data', chunk => { stderr += chunk })

const timer = setTimeout(() => {
  killedByTimeout = true
  child.kill()
}, timeoutMs)
child.stdin.end(Buffer.from(input, 'utf8'))

const exitCode = await new Promise(resolve => {
  child.once('exit', code => resolve(code ?? 1))
})
clearTimeout(timer)

const outputLines = stdout.split(/\r?\n/).filter(Boolean)
const parsedOutput = outputLines.flatMap(line => {
  try {
    const value = JSON.parse(line)
    return value && typeof value === 'object' ? [value] : []
  } catch {
    return []
  }
})
const terminalResult = [...parsedOutput]
  .reverse()
  .find(value => value.type === 'result')
const expectsErrorResult = Boolean(process.env.EXPECT_ERROR_RESULT)
const exitContractSatisfied = expectsErrorResult
  ? exitCode !== 0
  : exitCode === 0
const compactLines = outputLines.filter(line =>
  /compact|compacting|summary|STREAM_ONE_OK|STREAM_TWO_OK/i.test(line),
)
const errorLines = stderr
  .split(/\r?\n/)
  .filter(Boolean)
  .slice(-40)
  .map(line => line.replace(/model-gateway timing .*/, 'model-gateway timing [redacted]'))

const result = {
  result: exitContractSatisfied &&
    outputLines.length > 0 &&
    (!expectsErrorResult ||
      (terminalResult?.subtype === 'error_during_execution' &&
        terminalResult?.is_error === true &&
        Array.isArray(terminalResult?.errors) &&
        terminalResult.errors.length > 0))
    ? 'pass'
    : 'fail',
  exitCode,
  timedOut: killedByTimeout,
  outputLineCount: outputLines.length,
  terminalResult: terminalResult
    ? {
        subtype: terminalResult.subtype,
        is_error: terminalResult.is_error,
        errors: terminalResult.errors,
      }
    : null,
  outputTail: outputLines.slice(-12),
  compactLines: compactLines.slice(-40),
  stderr: errorLines,
}
console.log(JSON.stringify(result))
process.exitCode = result.result === 'pass' ? 0 : 1
