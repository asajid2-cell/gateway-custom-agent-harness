import { strict as assert } from 'node:assert'
import test from 'node:test'

// StatusLine.tsx reads MACRO.VERSION, which the bundler injects via --define.
// Stub it before the module graph loads so the builder can run under bun test.
globalThis.MACRO = { VERSION: 'test' }

const { buildStatusLineCommandInput } = await import(
  '../src/components/StatusLine.tsx'
)

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
