import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  createAssistantMessage,
  createUserMessage,
} from '../src/utils/messages.ts'
import { getStopHookMessage } from '../src/utils/hooks.ts'
import {
  getSessionId,
  getSessionProjectDir,
  getSessionResumeDirectory,
  onSessionSwitch,
  regenerateSessionId,
  switchSession,
} from '../src/bootstrap/state.ts'
import { asSessionId } from '../src/types/ids.ts'
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
  restorePersistForCurrentSession,
  drainPersistWrites,
  settlePersistDelivery,
  type PersistState,
} from '../src/skills/bundled/persist.ts'
import type { SessionHooksState } from '../src/utils/hooks/sessionHooks.ts'
import { getContextWindowForModel } from '../src/utils/context.ts'
import {
  getPersistSessionPath,
  readPersistSessionRecord,
  writePersistSessionRecord,
} from '../src/utils/sessionStorage.ts'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function humanMessage(content: string) {
  return createUserMessage({ content })
}

function backgroundMessage(content: string) {
  return createUserMessage({
    content,
    isMeta: true,
    origin: { kind: 'task-notification' },
  })
}

function makePersistState(overrides: Partial<PersistState> = {}): PersistState {
  return {
    task: 'finish and verify',
    mode: 'work',
    nudgesRemaining: 2,
    nudgesSent: 0,
    hookId: 'persist-test',
    initialPlanningResponseAllowed: false,
    ...overrides,
  }
}

test('planning allowance requires authoritative query identity', () => {
  const state = makePersistState({ initialPlanningResponseAllowed: true })
  assert.deepEqual(decidePersistStop(state, []), { kind: 'allow', reason: 'inactive' })
  assert.equal(state.initialPlanningResponseAllowed, true)
  assert.deepEqual(decidePersistStop(state, [], undefined, {
    chainId: 'planning-turn', stopHookActive: false,
  }), { kind: 'allow', reason: 'planning-response' })
  assert.equal(state.initialPlanningResponseAllowed, false)
})

function persistFeedback(task: string): ReturnType<typeof createUserMessage> {
  return createUserMessage({
    content: getStopHookMessage({
      blockingError: `Persist reminder (1). Active task: ${task}.`,
      command: 'persist-test',
    }),
    isMeta: true,
  })
}

function persistChain(task = 'finish and verify') {
  return [
    createUserMessage({
      content: `<command-name>/persist</command-name><command-message>persist</command-message><command-args>${task}</command-args>`,
    }),
    createAssistantMessage({ content: 'I inspected the implementation.' }),
    persistFeedback(task),
  ]
}

test('session identity updates atomically for resumed sessions', () => {
  const resumedId = asSessionId('12345678-1234-1234-1234-123456789abc')
  let notifications = 0
  const unsubscribe = onSessionSwitch(() => {
    notifications++
  })

  try {
    switchSession(
      resumedId,
      'C:\\Users\\Ahmed\\.claude\\projects\\encoded-project',
      'Z:\\Work Repo\\gateway-worktree',
    )
    assert.equal(getSessionId(), resumedId)
    assert.equal(
      getSessionProjectDir(),
      'C:\\Users\\Ahmed\\.claude\\projects\\encoded-project',
    )
    assert.equal(
      getSessionResumeDirectory(),
      'Z:\\Work Repo\\gateway-worktree',
    )
    assert.equal(notifications, 1)
  } finally {
    unsubscribe()
    regenerateSessionId()
  }
})

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
    options: {
      task: 'finish the UI and test it',
      mode: 'work',
      keep: false,
      taskMode: 'bounded',
      nudges: 1,
    },
  })
  assert.deepEqual(parsePersistArgs('plan; --nudges 3 connect the UI and backend'), {
    kind: 'task',
    options: {
      task: 'connect the UI and backend',
      mode: 'plan',
      keep: false,
      taskMode: 'bounded',
      nudges: 3,
    },
  })
  assert.deepEqual(parsePersistArgs('--nudges 2 keep plan reorder modifiers'), {
    kind: 'task',
    options: {
      task: 'reorder modifiers',
      mode: 'plan',
      keep: true,
      taskMode: 'keep',
      nudges: 2,
    },
  })
  assert.deepEqual(parsePersistArgs('keep --nudges 2 plan another ordering'), {
    kind: 'task',
    options: {
      task: 'another ordering',
      mode: 'plan',
      keep: true,
      taskMode: 'keep',
      nudges: 2,
    },
  })
  assert.deepEqual(parsePersistArgs('status'), { kind: 'status' })
  assert.deepEqual(parsePersistArgs('clear'), { kind: 'clear' })
  assert.deepEqual(parsePersistArgs('complete'), { kind: 'complete' })
  assert.deepEqual(parsePersistArgs('done'), { kind: 'complete' })
  assert.equal(parsePersistArgs('--nudges 4 keep going').kind, 'error')
  assert.equal(parsePersistArgs('--nudges nope keep going').kind, 'error')
})

test('persist sidecar survives writes and ignores corrupt state', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-persist-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const transcriptPath = join(directory, 'session.jsonl')
  const record = {
    version: 1 as const,
    task: 'finish and verify',
    mode: 'work' as const,
    keep: true,
    taskMode: 'keep' as const,
    nudgesRemaining: 2,
    nudgesSent: 1,
    status: 'active' as const,
    initialPlanningResponseAllowed: false,
  }

  const runtimeRecord = { ...record, hookId: 'must-not-persist', runtimeToken: 'SECRET_SENTINEL' }
  await writePersistSessionRecord(runtimeRecord, transcriptPath)
  assert.deepEqual(await readPersistSessionRecord(transcriptPath), record)
  const stored = await readFile(getPersistSessionPath(transcriptPath), 'utf8')
  assert.equal(stored.includes('must-not-persist'), false)
  assert.equal(stored.includes('SECRET_SENTINEL'), false)

  for (const patch of [
    { version: 2 }, { status: 'unknown' }, { keep: 'true' },
    { nudgesRemaining: -1 }, { nudgesRemaining: 4 },
    { nudgesSent: 0.5 }, { initialPlanningResponseAllowed: null },
  ]) {
    await writeFile(getPersistSessionPath(transcriptPath), JSON.stringify({ ...record, ...patch }))
    assert.equal(await readPersistSessionRecord(transcriptPath), null)
  }
  await writePersistSessionRecord(record, transcriptPath)
  await writePersistSessionRecord({ ...record, status: 'completed' }, transcriptPath)
  assert.equal((await readPersistSessionRecord(transcriptPath))?.status, 'completed')

  await mkdir(directory, { recursive: true })
  await writeFile(getPersistSessionPath(transcriptPath), '{invalid')
  assert.equal(await readPersistSessionRecord(transcriptPath), null)
})

test('persist nudges are bounded and cancellation is allowed', () => {
  const state = makePersistState()
  const messages = persistChain()
  const first = decidePersistStop(state, messages, undefined, { chainId: 'test', stopHookActive: true })
  assert.equal(first.kind, 'nudge')
  assert.equal(state.nudgesRemaining, 1)
  const second = decidePersistStop(state, messages, undefined, { chainId: 'test', stopHookActive: true })
  assert.equal(second.kind, 'nudge')
  assert.equal(state.nudgesRemaining, 0)
  assert.deepEqual(decidePersistStop(state, messages, undefined, { chainId: 'test', stopHookActive: true }), {
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

test('persist ignores unrelated human and system interactions', () => {
  const state = makePersistState({ nudgesRemaining: 3 })
  const initial = { ...state }

  assert.deepEqual(
    decidePersistStop(state, [humanMessage('steer the work elsewhere')]),
    { kind: 'allow', reason: 'inactive' },
  )
  assert.deepEqual(state, initial)

  const unrelatedSystemTurn = [
    ...persistChain(),
    backgroundMessage('A background agent completed a task.'),
    humanMessage('This is a separate follow-up.'),
  ]
  assert.deepEqual(decidePersistStop(state, unrelatedSystemTurn), {
    kind: 'allow',
    reason: 'inactive',
  })
  assert.deepEqual(state, initial)

  const feedbackOnlyWithSystemMessage = [
    ...persistChain(),
    backgroundMessage('A background agent completed a task.'),
  ]
  assert.equal(
    decidePersistStop(state, feedbackOnlyWithSystemMessage, undefined, { chainId: 'test', stopHookActive: true }).kind,
    'nudge',
  )
  assert.equal(state.nudgesRemaining, 2)
  assert.equal(state.nudgesSent, 1)
})

test('persist planning allows the initial clarification response', () => {
  const state = makePersistState({
    task: 'clarify the acceptance criteria',
    mode: 'plan',
    nudgesRemaining: 1,
    initialPlanningResponseAllowed: true,
  })
  assert.deepEqual(decidePersistStop(state, [], undefined, { chainId: 'plan', stopHookActive: false }), {
    kind: 'allow',
    reason: 'planning-response',
  })
  assert.equal(state.initialPlanningResponseAllowed, false)
  assert.equal(decidePersistStop(state, persistChain(state.task), undefined, { chainId: 'test', stopHookActive: true }).kind, 'nudge')
})

test('persist keeps consuming recursive continuation nudges after feedback', () => {
  const state = makePersistState({ nudgesRemaining: 2 })
  const firstChain = persistChain()
  assert.equal(decidePersistStop(state, firstChain, undefined, { chainId: 'test', stopHookActive: true }).kind, 'nudge')

  const secondChain = [
    ...firstChain,
    createAssistantMessage({ content: 'I continued the task.' }),
    persistFeedback(state.task),
  ]
  assert.equal(decidePersistStop(state, secondChain, undefined, { chainId: 'test', stopHookActive: true }).kind, 'nudge')
  assert.equal(state.nudgesRemaining, 0)
  assert.equal(state.nudgesSent, 2)
})

test('persist registers, replaces, nudges, and clears its session hook', async t => {
  clearBundledSkills()
  registerPersistSkill()
  const command = getBundledSkills().find(skill => skill.name === 'persist')
  assert.ok(command && command.type === 'prompt')

  const appState = {
    sessionHooks: new Map(),
  } as unknown as AppState
  const commandDirectory = await mkdtemp(
    join(tmpdir(), 'gateway-persist-command-'),
  )
  const commandTranscriptPath = join(commandDirectory, 'session.jsonl')
  t.after(() => rm(commandDirectory, { recursive: true, force: true }))
  const setAppState = (updater: (prev: AppState) => AppState): void => {
    const next = updater(appState)
    assert.equal(next, appState)
  }
  const context = {
    setAppState,
    transcriptPath: commandTranscriptPath,
  } as unknown as ToolUseContext
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

  const activation = createUserMessage({
    content: '<command-name>/persist</command-name><command-message>persist</command-message>',
  })
  const feedback = persistFeedback('replacement task')
  const messages: Parameters<typeof decidePersistStop>[1] = [
    activation,
    createAssistantMessage({ content: 'I inspected the replacement task.' }),
    feedback,
  ]
  const goalReview = getBundledSkills().find(skill => skill.name === 'persist-review')
  assert.ok(goalReview && goalReview.type === 'prompt')
  const chainContext = { chainId: 'replacement', depth: 1, stopHookActive: true }
  await goalReview.getPromptForCommand('continue remaining verification', { ...context, queryTracking: chainContext })
  assert.equal(await hook.callback(messages, undefined, chainContext), false)
  assert.equal((await readPersistSessionRecord(commandTranscriptPath))?.nudgesRemaining, 1)
  await settlePersistDelivery(getSessionId(), chainContext.chainId, true)
  assert.match(
    typeof hook.errorMessage === 'function'
      ? hook.errorMessage(messages)
      : hook.errorMessage,
    /replacement task/,
  )
  const exhaustedMessages = [
    ...messages,
    createAssistantMessage({ content: 'I continued the replacement task.' }),
    persistFeedback('replacement task'),
  ]
  await goalReview.getPromptForCommand('continue final verification', { ...context, queryTracking: chainContext })
  assert.equal(await hook.callback(exhaustedMessages, undefined, chainContext), true)
  assert.equal(getStopHooks().length, 0)
  assert.equal(appState.sessionHooks.size, 0)

  const status = await command.getPromptForCommand('status', context)
  assert.match(
    status[0]?.type === 'text' ? status[0].text : '',
    /reminder budget exhausted.*task retained/i,
  )
  assert.deepEqual(
    await readPersistSessionRecord(commandTranscriptPath),
    {
      version: 1,
      task: 'replacement task',
      reviewEvidence: 'final verification',
      mode: 'work',
      keep: false,
      taskMode: 'bounded',
      nudgesRemaining: 0,
      nudgesSent: 1,
      status: 'exhausted',
      initialPlanningResponseAllowed: false,
    },
  )
  assert.equal(getStopHooks().length, 0)

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
    /Cleared and released the persist task/,
  )
  assert.equal(getStopHooks().length, 0)
  assert.equal(appState.sessionHooks.size, 0)

  await command.getPromptForCommand('keep --nudges 1 explicit completion task', context)
  assert.equal(getStopHooks().length, 1)
  const keepHook = getStopHooks()[0]?.hook
  assert.equal(keepHook?.type, 'function')
  if (!keepHook || keepHook.type !== 'function') return
  const keepFeedback = persistFeedback('explicit completion task')
  const keepMessages: Parameters<typeof decidePersistStop>[1] = [
    activation,
    keepFeedback,
  ]
  await goalReview.getPromptForCommand('continue more goal work remains', { ...context, queryTracking: chainContext })
  assert.equal(await keepHook.callback(keepMessages, undefined, chainContext), false)
  await settlePersistDelivery(getSessionId(), chainContext.chainId, true)
  await goalReview.getPromptForCommand('continue next verification step', { ...context, queryTracking: chainContext })
  assert.equal(await keepHook.callback(keepMessages, undefined, chainContext), false)
  await settlePersistDelivery(getSessionId(), chainContext.chainId, true)
  assert.equal(getStopHooks().length, 1)

  await drainPersistWrites()
  await restorePersistForCurrentSession(setAppState, commandTranscriptPath)
  await restorePersistForCurrentSession(setAppState, commandTranscriptPath)
  assert.equal(getStopHooks().length, 1)
  await command.getPromptForCommand('pause', context)
  assert.equal((await readPersistSessionRecord(commandTranscriptPath))?.status, 'paused')
  assert.equal(getStopHooks().length, 0)
  await command.getPromptForCommand('resume', context)
  assert.equal(getStopHooks().length, 1)
  const review = getBundledSkills().find(skill => skill.name === 'persist-review')
  assert.ok(review && review.type === 'prompt')
  const reviewedContext = { ...context, queryTracking: { chainId: 'goal-chain', depth: 0 } }
  const resumedHook = getStopHooks()[0].hook
  assert.ok(resumedHook.type === 'function')
  assert.equal(await resumedHook.callback([], undefined, { chainId: 'side-chat', depth: 0, stopHookActive: false }), false)
  assert.equal(await resumedHook.callback([], undefined, { chainId: 'side-chat', depth: 1, stopHookActive: true }), true)
  await review.getPromptForCommand('unrelated answering a side question', reviewedContext)
  assert.equal(await resumedHook.callback([], undefined, { chainId: 'goal-chain', depth: 0, stopHookActive: false }), true)
  await review.getPromptForCommand('continue integration tests still need completion', reviewedContext)
  const overlappingStops = await Promise.all([
    resumedHook.callback([], undefined, { chainId: 'goal-chain', depth: 1, stopHookActive: false }),
    resumedHook.callback([], undefined, { chainId: 'goal-chain', depth: 1, stopHookActive: false }),
  ])
  assert.deepEqual(overlappingStops, [false, true])
  const beforeRefund = await readPersistSessionRecord(commandTranscriptPath)
  await settlePersistDelivery(getSessionId(), 'goal-chain', false)
  const refunded = await readPersistSessionRecord(commandTranscriptPath)
  assert.equal(refunded?.nudgesSent, beforeRefund!.nudgesSent)
  await settlePersistDelivery(getSessionId(), 'goal-chain', false)
  assert.deepEqual(await readPersistSessionRecord(commandTranscriptPath), refunded)

  await review.getPromptForCommand('continue verification still remains', reviewedContext)
  assert.equal(await resumedHook.callback([], undefined, { chainId: 'goal-chain', stopHookActive: false }), false)
  const beforeRestart = await readPersistSessionRecord(commandTranscriptPath)
  const querySource = await readFile(new URL('../src/query.ts', import.meta.url), 'utf8')
  const start = querySource.indexOf('      const { getSessionId: getPersistSessionId }')
  const end = querySource.indexOf('      if (stopHookResult.preventContinuation) {', start)
  assert.ok(start >= 0 && end > start)
  const boundary = querySource.slice(start, end)
    .replace("await import('./bootstrap/state.js')", 'bootstrap')
    .replaceAll("await import('./skills/bundled/persist.js')", 'persist')
  const createBoundary = new Function('bootstrap', 'persist', 'handleStopHooks', 'toolUseContext',
    `return async function* () {
      const messagesForQuery=[], assistantMessages=[], systemPrompt=[], userContext={}, systemContext={}, querySource='sdk', stopHookActive=false;
      ${boundary}
    }`)
  const boundaryContext = { ...context, queryTracking: { chainId: 'goal-chain' }, abortController: new AbortController() }
  const cancelledBoundary = createBoundary({ getSessionId }, { settlePersistDelivery }, async function* () {
    yield { type: 'user' }
    return { preventContinuation: false, blockingErrors: [{}] }
  }, boundaryContext)()
  await cancelledBoundary.next()
  await cancelledBoundary.return()
  await settlePersistDelivery(getSessionId(), 'goal-chain', true)
  assert.deepEqual(await readPersistSessionRecord(commandTranscriptPath), beforeRestart)
  await restorePersistForCurrentSession(setAppState, commandTranscriptPath)
  await settlePersistDelivery(getSessionId(), 'goal-chain', true)
  assert.deepEqual(await readPersistSessionRecord(commandTranscriptPath), beforeRestart)

  const completed = await command.getPromptForCommand('done', context)
  assert.match(
    completed[0]?.type === 'text' ? completed[0].text : '',
    /Completed the persist task/,
  )
  assert.equal(getStopHooks().length, 0)
  assert.equal(appState.sessionHooks.size, 0)
  await Promise.all([
    command.getPromptForCommand('keep first queued goal', context),
    command.getPromptForCommand('keep final queued goal', context),
    command.getPromptForCommand('pause', context),
  ])
  const queued = await readPersistSessionRecord(commandTranscriptPath)
  assert.equal(queued?.task, 'final queued goal')
  assert.equal(queued?.status, 'paused')
  assert.equal(getStopHooks().length, 0)
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
  assert.equal(modelSupportsEffort('claude-gpt-astra'), true)
  assert.equal(modelSupportsMaxEffort('claude-gpt-astra'), true)
  assert.equal(modelSupportsEffort('claude-ds-pro'), true)
  assert.equal(modelSupportsMaxEffort('claude-ds-pro'), true)
  assert.equal(modelSupportsEffort('claude-ds-flash'), true)
  assert.equal(modelSupportsMaxEffort('claude-ds-flash'), true)
  assert.equal(modelSupportsEffort('gateway-opencode-glm-5.3-flash'), true)
  assert.equal(modelSupportsMaxEffort('gateway-opencode-glm-5.3-flash'), true)
  assert.equal(modelSupportsEffort('claude-openrouter-anthropic%2Fclaude'), true)
  assert.equal(modelSupportsEffort('claude-ultracode'), true)
})

test('Astra aliases use the supported client accounting window', () => {
  assert.equal(getContextWindowForModel('gateway-gpt-astra'), 272_000)
  assert.equal(getContextWindowForModel('gpt-6-astra'), 272_000)
  assert.equal(getContextWindowForModel('claude-gpt-astra'), 272_000)
})

test('gateway preserves native effort levels on GPT aliases', () => {
  assert.equal(resolveAppliedEffort('claude-gpt-luna', 'max'), 'max')
  assert.equal(resolveAppliedEffort('claude-gpt-sol', 'max'), 'max')
  assert.equal(resolveAppliedEffort('claude-gpt-terra', 'max'), 'max')
  assert.equal(resolveAppliedEffort('claude-gpt-astra', 'ultra'), 'ultra')
  assert.equal(resolveAppliedEffort('claude-gpt-luna', 'ultracode'), 'ultracode')
  assert.equal(resolveProviderEffort('claude-gpt-sol', 'ultracode'), 'max')
  assert.equal(resolveProviderEffort('claude-gpt-terra', 'ultracode'), 'max')
  assert.equal(resolveProviderEffort('claude-gpt-astra', 'ultracode'), 'ultra')
  assert.equal(resolveProviderEffort('claude-gpt-luna', 'ultracode'), 'max')
  assert.equal(resolveProviderEffort('claude-gpt-astra', 'ultra'), 'ultra')
  assert.equal(resolveProviderEffort('claude-gpt-luna', 'ultra'), undefined)
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
    ['low', 'high', 'max', 'ultracode'],
  )
  assert.deepEqual(
    getSupportedEffortLevels('claude-ds-flash'),
    ['low', 'high', 'max', 'ultracode'],
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
  assert.equal(resolveProviderEffort('gateway-gpt-astra', 'ultracode'), 'ultra')
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
