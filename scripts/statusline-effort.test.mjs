import { strict as assert } from 'node:assert'
import test from 'node:test'

// StatusLine.tsx reads MACRO.VERSION, which the bundler injects via --define.
// Stub it before the module graph loads so the builder can run under bun test.
globalThis.MACRO = { VERSION: 'test' }

const { buildStatusLineCommandInput } = await import(
  '../src/components/StatusLine.tsx'
)
const {
  getSessionResumeDirectory,
  setCwdState,
  setOriginalCwd,
  setSessionResumeDirectory,
} = await import('../src/bootstrap/state.ts')
const { recordSpeedSample, resetSpeedForTests } = await import('../src/utils/speed.ts')

const settings = { statusLine: { type: 'command', command: 'noop' } }

function statuslineInput(model, effortValue) {
  return buildStatusLineCommandInput(
    'default',
    false,
    settings,
    [],
    [],
    model,
    effortValue,
  )
}

test('statusline reports the effort level the session actually sends', () => {
  // The launcher passes --effort for models with a native ladder, so a fresh
  // gateway session appState is a concrete level and it must surface verbatim.
  assert.equal(
    statuslineInput('gateway-gpt-luna', 'medium').effort?.level,
    'medium',
  )
  assert.equal(
    statuslineInput('claude-sonnet-4-6', 'low').effort?.level,
    'low',
  )
})

test('statusline reports auto instead of the configured fallback level', () => {
  // No level selected and no model default: no effort param is sent, so the
  // provider default governs. Reporting the configured `effortLevel` here is
  // the frozen "high" the built-in indicator used to show.
  assert.equal(
    statuslineInput('gateway-gpt-luna', undefined).effort?.level,
    'auto',
  )
  assert.notEqual(
    statuslineInput('gateway-gpt-luna', undefined).effort?.level,
    'high',
  )
})

test('statusline omits effort for models that have no effort ladder', () => {
  // OpenCode models without a native ladder never send the param; the key is
  // absent so the command falls back to its own configured value.
  assert.equal(
    Object.hasOwn(statuslineInput('gateway-opencode-minimax-m3', 'high'), 'effort'),
    false,
  )
})

test('statusline tracks a mid-session effort change', () => {
  const before = statuslineInput('gateway-gpt-luna', 'medium').effort?.level
  const after = statuslineInput('gateway-gpt-luna', 'xhigh').effort?.level
  assert.equal(before, 'medium')
  assert.equal(after, 'xhigh')
})

test('statusline carries the measured output rate, or omits the key', () => {
  resetSpeedForTests()
  assert.equal(
    Object.hasOwn(
      statuslineInput('gateway-mistral-deepseek-v4.1-flash', undefined),
      'speed',
    ),
    false,
  )
  recordSpeedSample({
    model: 'gateway-mistral-deepseek-v4.1-flash',
    outputTokens: 200,
    startedAt: 10_000,
    firstTokenAt: 11_000,
    endedAt: 13_000,
  })
  const input = statuslineInput('gateway-mistral-deepseek-v4.1-flash', undefined)
  assert.equal(input.speed.output_tokens_per_second, 100)
  assert.equal(input.speed.session_output_tokens_per_second, 100)
  assert.equal(input.speed.output_tokens, 200)
  assert.equal(input.speed.generation_ms, 2_000)
  assert.equal(input.speed.ttft_ms, 1_000)
  assert.ok(input.speed.measured_at)
})

test('statusline names the session directory rather than the live shell cwd', () => {
  // The status line's directory token is the one place the live cwd used to
  // reach the footer: `cd` into a git checkout and it grew a branch and changed
  // its name. The session directory is the chat's own, so it is what the row
  // prints - and it is the directory the resume command names, so the row tells
  // you where the conversation can be resumed from rather than where you stand.
  setSessionResumeDirectory('C:\\Users\\Ahmed')
  setCwdState('Z:\\328\\CMPUT328-A2\\codexworks\\301\\WorkRepo\\gateway')
  const input = statuslineInput('gateway-gpt-luna', 'high')
  assert.equal(input.workspace.session_dir, 'C:\\Users\\Ahmed')
  // The live cwd is still reported, so a status line that genuinely wants it
  // keeps working; it is just no longer what the directory token means.
  assert.equal(
    input.workspace.current_dir,
    'Z:\\328\\CMPUT328-A2\\codexworks\\301\\WorkRepo\\gateway',
  )
})

test('a mid-session cwd move leaves the session directory alone', () => {
  // EnterWorktreeTool, a teleport and an SSH session all move originalCwd, and
  // the resume directory used to follow it because setOriginalCwd wrote both.
  // The chat's origin never moves, so neither may the row.
  setSessionResumeDirectory('C:\\Users\\Ahmed')
  setOriginalCwd('Z:\\328\\CMPUT328-A2\\codexworks\\301\\WorkRepo\\gateway')
  assert.equal(getSessionResumeDirectory(), 'C:\\Users\\Ahmed')
})
