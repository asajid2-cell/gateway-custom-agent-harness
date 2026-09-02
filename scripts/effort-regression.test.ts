import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  modelSupportsEffort,
  modelSupportsMaxEffort,
  getSupportedEffortLevels,
  resolveAppliedEffort,
  resolveProviderEffort,
} from '../src/utils/effort.ts'
import { openRouterModelOption } from '../src/utils/model/openRouterModels.ts'
import { createStore } from '../src/state/store.ts'

test('effort selections remain independent between session stores', () => {
  const sessionOne = createStore<{ effortValue: 'low' | 'medium' | 'high' | undefined }>({ effortValue: 'low' })
  const sessionTwo = createStore<{ effortValue: 'low' | 'medium' | 'high' | undefined }>({ effortValue: 'medium' })

  sessionOne.setState(prev => ({ ...prev, effortValue: 'high' }))
  assert.equal(sessionOne.getState().effortValue, 'high')
  assert.equal(sessionTwo.getState().effortValue, 'medium')

  sessionOne.setState(prev => ({ ...prev, effortValue: undefined }))
  assert.equal(sessionOne.getState().effortValue, undefined)
  assert.equal(sessionTwo.getState().effortValue, 'medium')
})

test('settings changes do not define the runtime effort value', () => {
  const session = createStore<{ effortValue: 'low' | undefined; settings: { effortLevel: string } }>({
    effortValue: 'low',
    settings: { effortLevel: 'medium' },
  })

  session.setState(prev => ({
    ...prev,
    settings: { effortLevel: 'high' },
  }))

  assert.equal(session.getState().effortValue, 'low')
})


test('gateway reasoning capabilities are truthful', () => {
  assert.equal(modelSupportsEffort('claude-gpt-luna'), true)
  assert.equal(modelSupportsMaxEffort('claude-gpt-luna'), true)
  assert.equal(modelSupportsEffort('claude-gpt-sol'), true)
  assert.equal(modelSupportsMaxEffort('claude-gpt-sol'), true)
  assert.equal(modelSupportsEffort('claude-gpt-terra'), true)
  assert.equal(modelSupportsMaxEffort('claude-gpt-terra'), false)
  assert.equal(modelSupportsEffort('claude-ds-pro'), true)
  assert.equal(modelSupportsMaxEffort('claude-ds-pro'), true)
  assert.equal(modelSupportsEffort('claude-ds-flash'), true)
  assert.equal(modelSupportsMaxEffort('claude-ds-flash'), true)
  assert.equal(modelSupportsEffort('gateway-opencode-glm-5.3-flash'), true)
  assert.equal(modelSupportsMaxEffort('gateway-opencode-glm-5.3-flash'), true)
  assert.equal(modelSupportsEffort('claude-openrouter-anthropic%2Fclaude'), true)
  assert.equal(modelSupportsEffort('claude-ultracode'), true)
})

test('gateway preserves max effort on Luna and clamps it on Terra', () => {
  assert.equal(resolveAppliedEffort('claude-gpt-luna', 'max'), 'max')
  assert.equal(resolveAppliedEffort('claude-gpt-sol', 'max'), 'max')
  assert.equal(resolveAppliedEffort('claude-gpt-terra', 'max'), 'high')
  assert.equal(resolveAppliedEffort('claude-gpt-luna', 'ultracode'), 'ultracode')
})

test('DeepSeek exposes only its real effort levels', () => {
  assert.deepEqual(
    getSupportedEffortLevels('deepseek-v4-pro'),
    ['low', 'high', 'max', 'ultracode'],
  )
  assert.deepEqual(
    getSupportedEffortLevels('deepseek-v4-flash'),
    ['low', 'high', 'max', 'ultracode'],
  )
  assert.deepEqual(
    getSupportedEffortLevels('claude-ds-pro'),
    ['low', 'high', 'max', 'ultracode'],
  )
  assert.deepEqual(
    getSupportedEffortLevels('gateway-opencode-glm-5.3-flash'),
    ['low', 'high', 'max', 'ultracode'],
  )
  assert.equal(modelSupportsEffort('gateway-opencode-glm-5.3-flash'), true)
  assert.equal(getSupportedEffortLevels('gateway-opencode-glm-5.3-flash').includes('medium'), false)
  assert.deepEqual(
    getSupportedEffortLevels('opencode-go/mimo-v2.5'),
    ['low', 'medium', 'high', 'ultracode'],
  )
  assert.equal(resolveAppliedEffort('gateway-opencode-glm-5.3-flash', 'ultracode'), 'ultracode')
  assert.equal(resolveAppliedEffort('opencode-go/mimo-v2.5', 'ultracode'), 'ultracode')
  assert.equal(resolveProviderEffort('gateway-opencode-glm-5.3-flash', 'ultracode'), 'max')
  assert.equal(resolveProviderEffort('opencode-go/mimo-v2.5', 'ultracode'), 'high')
  assert.equal(resolveProviderEffort('claude-ultracode', 'ultracode'), undefined)

  assert.equal(resolveAppliedEffort('gateway-gpt-luna', 'medium'), 'medium')
  assert.equal(resolveAppliedEffort('gateway-gpt-sol', 'low'), 'low')
  assert.equal(resolveAppliedEffort('gateway-gpt-terra', 'high'), 'high')

  assert.deepEqual(
    getSupportedEffortLevels('opencode-go/qwen3.7-max'),
    ['low', 'medium', 'high', 'ultracode'],
  )
  assert.deepEqual(getSupportedEffortLevels('claude-ultracode'), ['ultracode'])
})

test('OpenRouter requires explicit effort metadata', () => {
  const parameterOnly = openRouterModelOption({
    id: 'provider/parameter-only',
    supported_parameters: ['reasoning', 'reasoning_effort'],
  })
  assert.equal(parameterOnly.effortLevels, undefined)

  const explicit = openRouterModelOption({
    id: 'provider/explicit',
    supported_parameters: ['reasoning_effort'],
    supported_efforts: ['max', 'high', 'high', 'bogus'],
  })
  assert.deepEqual(explicit.effortLevels, ['max', 'high'])

  const nestedExplicit = openRouterModelOption({
    id: 'provider/nested',
    supported_parameters: ['reasoning'],
    reasoning: { supported_efforts: ['low', 'medium'] },
  })
  assert.deepEqual(nestedExplicit.effortLevels, ['low', 'medium'])

  const unknown = openRouterModelOption({
    id: 'provider/unknown',
    supported_parameters: ['include_reasoning'],
    effort_levels: ['xhigh', 'minimal'],
  })
  assert.equal(unknown.effortLevels, undefined)
})
