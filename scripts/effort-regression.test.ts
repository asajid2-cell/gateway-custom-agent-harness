import { strict as assert } from 'node:assert'
import test from 'node:test'
import { regenerateSessionId } from '../src/bootstrap/state.ts'
import type { AppState } from '../src/state/AppState.ts'
import type { ToolUseContext } from '../src/Tool.ts'
import {
  modelSupportsEffort,
  modelSupportsMaxEffort,
  getSupportedEffortLevels,
  resolveAppliedEffort,
  resolveProviderEffort,
} from '../src/utils/effort.ts'
import { openRouterModelOption } from '../src/utils/model/openRouterModels.ts'
import { createStore } from '../src/state/store.ts'
import {
  clearBundledSkills,
  getBundledSkills,
} from '../src/skills/bundledSkills.ts'
import {
  decidePersistStop,
  parsePersistArgs,
  registerPersistSkill,
  type PersistState,
} from '../src/skills/bundled/persist.ts'
import type { SessionHooksState } from '../src/utils/hooks/sessionHooks.ts'

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

test('persist parses bounded work and planning tasks', () => {
  assert.deepEqual(parsePersistArgs('finish the UI and test it'), {
    kind: 'task',
    options: { task: 'finish the UI and test it', mode: 'work', nudges: 1 },
  })
  assert.deepEqual(parsePersistArgs('plan; --nudges 3 connect the UI and backend'), {
    kind: 'task',
    options: { task: 'connect the UI and backend', mode: 'plan', nudges: 3 },
  })
  assert.deepEqual(parsePersistArgs('status'), { kind: 'status' })
  assert.deepEqual(parsePersistArgs('clear'), { kind: 'clear' })
  assert.equal(parsePersistArgs('--nudges 4 keep going').kind, 'error')
  assert.equal(parsePersistArgs('--nudges nope keep going').kind, 'error')
})

test('persist nudges are bounded and cancellation is allowed', () => {
  const state: PersistState = {
    task: 'finish and verify',
    mode: 'work',
    nudgesRemaining: 2,
    nudgesSent: 0,
    hookId: 'persist-test',
    initialPlanningResponseAllowed: false,
  }
  const messages: Parameters<typeof decidePersistStop>[1] = []
  const first = decidePersistStop(state, messages)
  assert.equal(first.kind, 'nudge')
  assert.equal(state.nudgesRemaining, 1)
  const second = decidePersistStop(state, messages)
  assert.equal(second.kind, 'nudge')
  assert.equal(state.nudgesRemaining, 0)
  assert.deepEqual(decidePersistStop(state, messages), {
    kind: 'allow',
    reason: 'budget-exhausted',
  })

  const abortController = new AbortController()
  abortController.abort()
  assert.deepEqual(decidePersistStop(state, messages, abortController.signal), {
    kind: 'allow',
    reason: 'cancelled',
  })
})

test('persist planning allows the initial clarification response', () => {
  const state: PersistState = {
    task: 'clarify the acceptance criteria',
    mode: 'plan',
    nudgesRemaining: 1,
    nudgesSent: 0,
    hookId: 'persist-plan-test',
    initialPlanningResponseAllowed: true,
  }
  assert.deepEqual(decidePersistStop(state, []), {
    kind: 'allow',
    reason: 'planning-response',
  })
  assert.equal(state.initialPlanningResponseAllowed, false)
  assert.equal(decidePersistStop(state, []).kind, 'nudge')
})

test('persist registers, replaces, nudges, and clears its session hook', async t => {
  clearBundledSkills()
  registerPersistSkill()
  const command = getBundledSkills().find(skill => skill.name === 'persist')
  assert.ok(command && command.type === 'prompt')

  const appState = {
    sessionHooks: new Map(),
  } as unknown as AppState
  const setAppState = (updater: (prev: AppState) => AppState): void => {
    const next = updater(appState)
    assert.equal(next, appState)
  }
  const context = { setAppState } as unknown as ToolUseContext
  t.after(async () => {
    await command.getPromptForCommand('clear', context)
    appState.sessionHooks.clear()
    clearBundledSkills()
  })

  const firstPrompt = await command.getPromptForCommand(
    '--nudges 1 finish integration',
    context,
  )
  assert.match(
    firstPrompt[0]?.type === 'text' ? firstPrompt[0].text : '',
    /Active persist task/,
  )

  const getStopHooks = () => {
    const stores = [...(appState.sessionHooks as SessionHooksState).values()]
    return stores.flatMap(store =>
      (store.hooks.Stop ?? []).flatMap(matcher => matcher.hooks),
    )
  }
  assert.equal(getStopHooks().length, 1)

  await command.getPromptForCommand('--nudges 1 replacement task', context)
  const hooks = getStopHooks()
  assert.equal(hooks.length, 1)
  const hook = hooks[0]?.hook
  assert.equal(hook?.type, 'function')
  if (!hook || hook.type !== 'function') return

  const cancelled = new AbortController()
  cancelled.abort()
  assert.equal(await hook.callback([], cancelled.signal), true)
  assert.equal(getStopHooks().length, 1)

  const messages: Parameters<typeof decidePersistStop>[1] = []
  assert.equal(await hook.callback(messages), false)
  assert.match(
    typeof hook.errorMessage === 'function'
      ? hook.errorMessage(messages)
      : hook.errorMessage,
    /replacement task/,
  )
  assert.equal(await hook.callback(messages), true)
  assert.equal(getStopHooks().length, 0)
  assert.equal(appState.sessionHooks.size, 0)

  const status = await command.getPromptForCommand('status', context)
  assert.match(
    status[0]?.type === 'text' ? status[0].text : '',
    /No active persist task/,
  )

  await command.getPromptForCommand('task interrupted by session clear', context)
  assert.equal(getStopHooks().length, 1)
  regenerateSessionId()
  assert.equal(getStopHooks().length, 0)
  assert.equal(appState.sessionHooks.size, 0)

  await command.getPromptForCommand('task to clear', context)
  assert.equal(getStopHooks().length, 1)
  const cleared = await command.getPromptForCommand('clear', context)
  assert.match(
    cleared[0]?.type === 'text' ? cleared[0].text : '',
    /Cleared the active persist task/,
  )
  assert.equal(getStopHooks().length, 0)
  assert.equal(appState.sessionHooks.size, 0)
})

test('persist stays unavailable to background agents', async t => {
  clearBundledSkills()
  registerPersistSkill()
  t.after(clearBundledSkills)
  const command = getBundledSkills().find(skill => skill.name === 'persist')
  assert.ok(command && command.type === 'prompt')
  const result = await command.getPromptForCommand('', {
    agentId: 'agent-test',
  } as unknown as ToolUseContext)
  assert.match(
    result[0]?.type === 'text' ? result[0].text : '',
    /only in the main session/,
  )
})

test('gateway reasoning capabilities are truthful', () => {
  assert.equal(modelSupportsEffort('claude-gpt-luna'), true)
  assert.equal(modelSupportsMaxEffort('claude-gpt-luna'), true)
  assert.equal(modelSupportsEffort('claude-gpt-sol'), true)
  assert.equal(modelSupportsMaxEffort('claude-gpt-sol'), true)
  assert.equal(modelSupportsEffort('claude-gpt-terra'), true)
  assert.equal(modelSupportsMaxEffort('claude-gpt-terra'), true)
  assert.equal(modelSupportsEffort('claude-ds-pro'), true)
  assert.equal(modelSupportsMaxEffort('claude-ds-pro'), false)
  assert.equal(modelSupportsEffort('claude-ds-flash'), true)
  assert.equal(modelSupportsMaxEffort('claude-ds-flash'), false)
  assert.equal(modelSupportsEffort('gateway-opencode-glm-5.3-flash'), true)
  assert.equal(modelSupportsMaxEffort('gateway-opencode-glm-5.3-flash'), true)
  assert.equal(modelSupportsEffort('claude-openrouter-anthropic%2Fclaude'), true)
  assert.equal(modelSupportsEffort('claude-ultracode'), true)
})

test('gateway preserves max effort on GPT 5.6 aliases', () => {
  assert.equal(resolveAppliedEffort('claude-gpt-luna', 'max'), 'max')
  assert.equal(resolveAppliedEffort('claude-gpt-sol', 'max'), 'max')
  assert.equal(resolveAppliedEffort('claude-gpt-terra', 'max'), 'max')
  assert.equal(resolveAppliedEffort('claude-gpt-luna', 'ultracode'), 'ultracode')
})

test('DeepSeek exposes only its real effort levels', () => {
  assert.deepEqual(
    getSupportedEffortLevels('deepseek-v4-pro'),
    ['low', 'medium', 'high', 'ultracode'],
  )
  assert.deepEqual(
    getSupportedEffortLevels('deepseek-v4-flash'),
    ['low', 'medium', 'high', 'ultracode'],
  )
  assert.deepEqual(
    getSupportedEffortLevels('claude-ds-pro'),
    ['low', 'medium', 'high', 'ultracode'],
  )
  assert.deepEqual(
    getSupportedEffortLevels('gateway-opencode-glm-5.3-flash'),
    ['low', 'high', 'max', 'ultracode'],
  )
  assert.equal(modelSupportsEffort('gateway-opencode-glm-5.3-flash'), true)
  assert.equal(getSupportedEffortLevels('gateway-opencode-glm-5.3-flash').includes('medium'), false)
  assert.deepEqual(
    getSupportedEffortLevels('gateway-opencode-mimo-v2.5'),
    ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
  )
  assert.deepEqual(getSupportedEffortLevels('opencode-go/mimo-v2.5'), ['ultracode'])
  assert.equal(resolveAppliedEffort('gateway-opencode-glm-5.3-flash', 'ultracode'), 'ultracode')
  assert.equal(resolveAppliedEffort('gateway-opencode-mimo-v2.5', 'ultracode'), 'ultracode')
  assert.equal(resolveProviderEffort('gateway-opencode-glm-5.3-flash', 'ultracode'), 'max')
  assert.equal(resolveProviderEffort('gateway-opencode-mimo-v2.5', 'ultracode'), 'max')
  assert.equal(resolveProviderEffort('claude-ultracode', 'ultracode'), 'high')

  assert.equal(resolveAppliedEffort('gateway-gpt-luna', 'medium'), 'medium')
  assert.equal(resolveAppliedEffort('gateway-gpt-sol', 'low'), 'low')
  assert.equal(resolveAppliedEffort('gateway-gpt-terra', 'high'), 'high')

  assert.deepEqual(getSupportedEffortLevels('opencode-go/qwen3.7-max'), ['ultracode'])
  assert.deepEqual(
    getSupportedEffortLevels('claude-ultracode'),
    ['low', 'medium', 'high', 'ultracode'],
  )
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
