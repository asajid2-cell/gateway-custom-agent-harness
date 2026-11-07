import { strict as assert } from 'node:assert'
import test, { after } from 'node:test'
import { modelSupportsThinking } from '../src/utils/thinking.ts'

// `modelSupportsThinking` decides whether a request carries `thinking` at all.
// A Gateway Claude route reaches Anthropic on the subscription's own credential,
// but its id is namespaced (`gateway-claude-haiku-5-5`), so the name-based
// checks do not recognise it. Getting this wrong is silent: the turn answers
// normally and simply never thinks, which is what made Haiku 5.5 look like a
// model that cannot.
const saved = process.env.CLAUDE_CODE_USE_GATEWAY
after(() => {
  if (saved === undefined) delete process.env.CLAUDE_CODE_USE_GATEWAY
  else process.env.CLAUDE_CODE_USE_GATEWAY = saved
})

test('every Gateway Claude route is asked for thinking', () => {
  process.env.CLAUDE_CODE_USE_GATEWAY = '1'
  const routes = [
    'gateway-claude-haiku-5-5',
    'gateway-claude-sonnet-5-5',
    'gateway-claude-opus-5-5',
    'gateway-claude-opus-4-6',
    'gateway-claude-sonnet-4-5-20250929',
    'gateway-claude-haiku-4-5-20251001',
  ]
  for (const model of routes) {
    assert.equal(modelSupportsThinking(model), true, model)
  }
})

test('a Gateway route on another backend is not claimed as a Claude route', () => {
  process.env.CLAUDE_CODE_USE_GATEWAY = '1'
  // These backends stream their reasoning on their own; the predicate is about
  // which requests carry the Anthropic thinking parameter, so it must not
  // start answering for them.
  assert.equal(modelSupportsThinking('gateway-commandcode-deepseek-v4.1-flash'), false)
  assert.equal(modelSupportsThinking('gateway-mistral-vibe-deepseek-v4.1-flash'), false)
})
