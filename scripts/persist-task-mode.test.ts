import { strict as assert } from 'node:assert'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppState } from '../src/state/AppState.ts'
import type { ToolUseContext } from '../src/Tool.ts'
import { getSessionId } from '../src/bootstrap/state.ts'
import { createAssistantMessage } from '../src/utils/messages.ts'
import {
  decidePersistStop,
  drainPersistWrites,
  getPersistGoalContext,
  parsePersistArgs,
  registerPersistSkill,
  restorePersistForCurrentSession,
  settlePersistDelivery,
  type PersistState,
} from '../src/skills/bundled/persist.ts'
import { clearBundledSkills, getBundledSkills } from '../src/skills/bundledSkills.ts'
import type { SessionHooksState } from '../src/utils/hooks/sessionHooks.ts'
import {
  getPersistSessionPath,
  readPersistSessionRecord,
  writePersistSessionRecord,
} from '../src/utils/sessionStorage.ts'

function makeState(overrides: Partial<PersistState> = {}): PersistState {
  return {
    task: 'finish the connected workflow',
    mode: 'work',
    taskMode: 'bounded',
    nudgesRemaining: 1,
    nudgesSent: 0,
    hookId: 'persist-task-test',
    initialPlanningResponseAllowed: false,
    ...overrides,
  }
}

function createHarness() {
  clearBundledSkills()
  registerPersistSkill()
  const command = getBundledSkills().find(skill => skill.name === 'persist')
  const review = getBundledSkills().find(skill => skill.name === 'persist-review')
  assert.ok(command?.type === 'prompt' && review?.type === 'prompt')
  const app = { sessionHooks: new Map() } as unknown as AppState
  const setAppState = (update: (state: AppState) => AppState) => { update(app) }
  const getHooks = () => [...(app.sessionHooks as SessionHooksState).values()]
    .flatMap(store => (store.hooks.Stop ?? []).flatMap(matcher => matcher.hooks))
  return { command, review, app, setAppState, getHooks }
}

test('task mode parses primary and flag syntax without changing bounded or keep parsing', () => {
  assert.deepEqual(parsePersistArgs('task finish the release'), {
    kind: 'task',
    options: { task: 'finish the release', mode: 'work', keep: false, taskMode: 'task', nudges: 1 },
  })
  assert.deepEqual(parsePersistArgs('--task --nudges 2 plan finish the release'), {
    kind: 'task',
    options: { task: 'finish the release', mode: 'plan', keep: false, taskMode: 'task', nudges: 2 },
  })
  assert.deepEqual(parsePersistArgs('ordinary bounded goal'), {
    kind: 'task',
    options: { task: 'ordinary bounded goal', mode: 'work', keep: false, taskMode: 'bounded', nudges: 1 },
  })
  assert.deepEqual(parsePersistArgs('keep --nudges 2 retained goal'), {
    kind: 'task',
    options: { task: 'retained goal', mode: 'work', keep: true, taskMode: 'keep', nudges: 2 },
  })
  assert.equal(parsePersistArgs('task keep ambiguous goal').kind, 'error')
})

test('a model may arm a goal while a subagent still cannot', async () => {
  const harness = createHarness()
  try {
    // This carried disableModelInvocation, so a person who asked an agent to
    // start a persist campaign got "Skill persist cannot be used with Skill
    // tool". The model path is open now; a subagent is still refused.
    assert.notEqual(harness.command.disableModelInvocation, true)
    const refused = await harness.command.getPromptForCommand('task finish the release', { agentId: 'sub-1' } as unknown as ToolUseContext)
    assert.match(refused[0]?.type === 'text' ? refused[0].text : '', /only in the main session/i)
  } finally {
    clearBundledSkills()
  }
})

test('task mode persists, restores, and normalizes legacy sidecars', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'persist-task-restore-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'session.jsonl')
  const taskRecord = {
    version: 1 as const,
    task: 'restore the task heartbeat',
    mode: 'work' as const,
    keep: false,
    taskMode: 'task' as const,
    nudgesRemaining: 0,
    nudgesSent: 4,
    status: 'active' as const,
    initialPlanningResponseAllowed: false,
  }
  await writePersistSessionRecord(taskRecord, path)
  assert.deepEqual(await readPersistSessionRecord(path), taskRecord)

  const harness = createHarness()
  t.after(clearBundledSkills)
  await restorePersistForCurrentSession(harness.setAppState, path)
  assert.equal(harness.getHooks().length, 1)
  assert.equal((await readPersistSessionRecord(path))?.taskMode, 'task')

  const legacy = { ...taskRecord, task: 'legacy kept goal', keep: true }
  delete (legacy as Partial<typeof taskRecord>).taskMode
  await writeFile(getPersistSessionPath(path), JSON.stringify(legacy))
  assert.equal((await readPersistSessionRecord(path))?.taskMode, 'keep')
})

test('task mode continues after budget exhaustion while bounded exhausts and keep regresses safely', () => {
  const context = { chainId: 'task-chain', depth: 1, stopHookActive: true }
  const task = makeState({ taskMode: 'task', nudgesRemaining: 0 })
  const taskDecision = decidePersistStop(task, [], undefined, context)
  assert.equal(taskDecision.kind, 'nudge')
  assert.equal(task.nudgesSent, 1)
  assert.equal(task.status, undefined)
  assert.match(taskDecision.kind === 'nudge' ? taskDecision.message : '', /task heartbeat remains armed/i)

  const bounded = makeState({ taskMode: 'bounded', nudgesRemaining: 0 })
  assert.deepEqual(decidePersistStop(bounded, [], undefined, context), {
    kind: 'allow', reason: 'budget-exhausted',
  })
  assert.equal(bounded.status, 'exhausted')

  const keep = makeState({ taskMode: 'keep', keep: true, nudgesRemaining: 0 })
  assert.equal(decidePersistStop(keep, [], undefined, context).kind, 'nudge')
})

function toolWork(id: string) {
  return createAssistantMessage({
    content: [{ type: 'tool_use' as const, id, name: 'Read', input: { file_path: 'src/index.ts' } }],
  })
}

test('a continuation heartbeat disarms after repeated tool-free stops', () => {
  const context = { chainId: 'stall-chain', depth: 1, stopHookActive: true }
  const state = makeState({ taskMode: 'task', nudgesRemaining: 0 })
  // The field flood verbatim: the same sentence and no tool call, heartbeat
  // after heartbeat, so nothing about the conversation changes between them.
  const stalled = [createAssistantMessage({ content: 'Complete. Standing by for your input.' })]

  // Bounded mode disarms on its budget. A continuation heartbeat is armed
  // forever, so this is the only ceiling that ends the loop.
  const decisions = [0, 1, 2].map(() => decidePersistStop(state, stalled, undefined, context))
  assert.deepEqual(decisions.map(decision => decision.kind), ['nudge', 'nudge', 'nudge'])
  assert.equal(state.nudgesSent, 3)
  // The first heartbeat asks for work. Once a heartbeat has produced nothing
  // the nudge stops asking and names the exits instead - closing the goal is
  // the model's job, and the flood is what happened when nothing ever said so.
  const texts = decisions.map(decision => (decision.kind === 'nudge' ? decision.message : ''))
  assert.match(texts[0]!, /task heartbeat remains armed/i)
  assert.doesNotMatch(texts[0]!, /close the loop now/i)
  assert.match(texts[1]!, /no progress 1 of 3/)
  assert.match(texts[1]!, /close the loop now with persist-review complete/)
  assert.match(texts[1]!, /persist-review blocked/)
  assert.match(texts[2]!, /no progress 2 of 3/)
  assert.match(texts[2]!, /parked and the heartbeat stops/)
  assert.deepEqual(decidePersistStop(state, stalled, undefined, context), {
    kind: 'allow',
    reason: 'no-progress',
  })
  // Retained rather than cleared, and the disarmed status holds on the next
  // heartbeat too, so a stale hook cannot restart the loop.
  assert.equal(state.status, 'stalled')
  assert.equal(state.task, 'finish the connected workflow')
  assert.deepEqual(decidePersistStop(state, stalled, undefined, context), {
    kind: 'allow',
    reason: 'no-progress',
  })
})

test('one tool call between heartbeats clears the stall count', () => {
  const context = { chainId: 'stall-reset', depth: 1, stopHookActive: true }
  const state = makeState({ taskMode: 'task', nudgesRemaining: 0 })
  const idle = [createAssistantMessage({ content: 'Standing by.' })]
  // The first heartbeat only sets the mark; each later one that finds the same
  // mark is what counts as a no-progress heartbeat.
  decidePersistStop(state, idle, undefined, context)
  assert.equal(state.stalledHeartbeats, 0)
  decidePersistStop(state, idle, undefined, context)
  decidePersistStop(state, idle, undefined, context)
  assert.equal(state.stalledHeartbeats, 2)

  // A heartbeat that produced real tool work moved the goal, so the count
  // starts over and the heartbeat stays armed.
  const worked = [...idle, toolWork('toolu_stall_reset')]
  assert.equal(decidePersistStop(state, worked, undefined, context).kind, 'nudge')
  assert.equal(state.stalledHeartbeats, 0)

  // Counting resumes from the new mark rather than from the old one.
  decidePersistStop(state, worked, undefined, context)
  assert.equal(state.stalledHeartbeats, 1)
})

test('real work keeps the heartbeat armed well past the stall window', () => {
  const context = { chainId: 'work-chain', depth: 1, stopHookActive: true }
  const state = makeState({ taskMode: 'task', nudgesRemaining: 0 })
  // The stall window is a ceiling on heartbeats that do nothing, never on the
  // work itself: a session that keeps producing tool work is nudged past it.
  let messages: Parameters<typeof decidePersistStop>[1] = []
  for (let i = 0; i < 6; i += 1) {
    messages = [...messages, toolWork(`toolu_work_${i}`)]
    assert.equal(decidePersistStop(state, messages, undefined, context).kind, 'nudge')
    assert.equal(state.stalledHeartbeats, 0)
  }
  assert.equal(state.nudgesSent, 6)
})

test('a stalled heartbeat retires the hook and keeps the goal', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'persist-task-stall-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'session.jsonl')
  const harness = createHarness()
  t.after(clearBundledSkills)
  const chain = { chainId: 'stall-runtime', depth: 1, stopHookActive: true }
  const context = { setAppState: harness.setAppState, transcriptPath: path, queryTracking: chain } as unknown as ToolUseContext
  const currentHook = () => {
    const hook = harness.getHooks()[0]?.hook
    assert.ok(hook?.type === 'function')
    return hook
  }
  try {
    await harness.command.getPromptForCommand('task --nudges 1 finish the stalled delivery', context)
    // One turn of real work, then the loop: the same tool-free answer repeated.
    const worked = [toolWork('toolu_stall_runtime')]
    assert.equal(await currentHook().callback(worked, undefined, chain), false)
    await settlePersistDelivery(getSessionId(), chain.chainId, true)

    const idle = [...worked, createAssistantMessage({ content: 'Complete. Standing by for your input.' })]
    assert.equal(await currentHook().callback(idle, undefined, chain), false)
    await settlePersistDelivery(getSessionId(), chain.chainId, true)
    assert.equal(await currentHook().callback(idle, undefined, chain), false)
    await settlePersistDelivery(getSessionId(), chain.chainId, true)
    assert.equal(await currentHook().callback(idle, undefined, chain), true)

    // The loop is over because the hook is gone, not because a message was
    // merely withheld, and the goal survives for /persist resume.
    assert.equal(harness.getHooks().length, 0)
    await drainPersistWrites()
    const record = await readPersistSessionRecord(path)
    assert.equal(record?.status, 'stalled')
    assert.equal(record?.task, 'finish the stalled delivery')
    assert.match(getPersistGoalContext() ?? '', /Do not automatically pursue it/)
  } finally {
    await harness.command.getPromptForCommand('clear', context)
  }
})

test('task mode rejects speculative blockers but accepts a hard blocker', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'persist-task-blocker-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'session.jsonl')
  const harness = createHarness()
  t.after(async () => {
    if (harness.getHooks().length > 0) await harness.command.getPromptForCommand('clear', { setAppState: harness.setAppState, transcriptPath: path } as unknown as ToolUseContext)
    clearBundledSkills()
  })
  const context = { setAppState: harness.setAppState, transcriptPath: path, queryTracking: { chainId: 'task-blocker', depth: 1, stopHookActive: true } } as unknown as ToolUseContext
  await harness.command.getPromptForCommand('task investigate the minting failure', context)
  const speculative = await harness.review.getPromptForCommand('blocked The country explanation is uncertain; try resetting the queue', context)
  assert.match(speculative[0]?.type === 'text' ? speculative[0].text : '', /must be JSON|not blockers/i)
  assert.equal((await readPersistSessionRecord(path))?.status, 'active')
  assert.equal(harness.getHooks().length, 1)

  const hard = await harness.review.getPromptForCommand(`blocked ${JSON.stringify({ kind: 'blocked', blocker: 'user-input', canProceedWithoutUser: false, next: 'Ask the user for the missing credential', evidence: 'The required credential is unavailable and no authorized alternative exists.' })}`, context)
  assert.match(hard[0]?.type === 'text' ? hard[0].text : '', /blocked and retained/i)
  assert.equal((await readPersistSessionRecord(path))?.status, 'blocked')
  assert.equal(harness.getHooks().length, 0)
})

test('task completion review requires delivery evidence unless explicitly overridden', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'persist-task-evidence-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'session.jsonl')
  const harness = createHarness()
  t.after(async () => {
    await harness.command.getPromptForCommand('clear', { setAppState: harness.setAppState, transcriptPath: path } as unknown as ToolUseContext)
    clearBundledSkills()
  })
  const chain = { chainId: 'task-evidence', depth: 1, stopHookActive: true }
  const context = { setAppState: harness.setAppState, transcriptPath: path, queryTracking: chain } as unknown as ToolUseContext
  await harness.command.getPromptForCommand('task verify meaningful completion', context)
  const rejected = await harness.review.getPromptForCommand('complete Only a tiny edit was made', context)
  assert.match(rejected[0]?.type === 'text' ? rejected[0].text : '', /meaningful delivery checkpoint/i)
  assert.equal((await readPersistSessionRecord(path))?.status, 'active')
  assert.equal(harness.getHooks().length, 1)
  await harness.command.getPromptForCommand('complete', context)
  assert.equal((await readPersistSessionRecord(path))?.status, 'completed')
  assert.equal(harness.getHooks().length, 0)
})

test('task mode continues across query chains while keep mode still requires review authorization', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'persist-task-chain-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'session.jsonl')
  const harness = createHarness()
  t.after(clearBundledSkills)
  const context = (chainId: string) => ({
    setAppState: harness.setAppState,
    transcriptPath: path,
    queryTracking: { chainId, depth: 1, stopHookActive: true },
  } as unknown as ToolUseContext)
  const currentHook = () => {
    const hook = harness.getHooks()[0]?.hook
    assert.ok(hook?.type === 'function')
    return hook
  }
  try {
    await harness.command.getPromptForCommand('task --nudges 1 continue the connected delivery', context('task-start'))
    const firstTaskMessages: never[] = []
    assert.equal(await currentHook().callback(firstTaskMessages, undefined, { chainId: 'task-first', depth: 1, stopHookActive: true }), false)
    assert.match(typeof currentHook().errorMessage === 'function' ? currentHook().errorMessage(firstTaskMessages) : currentHook().errorMessage, /task heartbeat/i)
    await settlePersistDelivery(getSessionId(), 'task-first', true)

    const secondTaskMessages: never[] = []
    assert.equal(await currentHook().callback(secondTaskMessages, undefined, { chainId: 'task-second', depth: 1, stopHookActive: true }), false)
    assert.match(typeof currentHook().errorMessage === 'function' ? currentHook().errorMessage(secondTaskMessages) : currentHook().errorMessage, /task heartbeat/i)
    await settlePersistDelivery(getSessionId(), 'task-second', true)

    await harness.command.getPromptForCommand('clear', context('task-second'))
    await harness.command.getPromptForCommand('keep --nudges 1 retain the connected delivery', context('keep-start'))
    const keepMessages: never[] = []
    assert.equal(await currentHook().callback(keepMessages, undefined, { chainId: 'keep-first', depth: 1, stopHookActive: true }), false)
    assert.match(typeof currentHook().errorMessage === 'function' ? currentHook().errorMessage(keepMessages) : currentHook().errorMessage, /kept goal/i)
    assert.equal(await currentHook().callback(keepMessages, undefined, { chainId: 'keep-first', depth: 1, stopHookActive: true }), true)
    await harness.command.getPromptForCommand('clear', context('keep-first'))
  }
  finally {
    if (harness.getHooks().length > 0) await harness.command.getPromptForCommand('clear', context('cleanup'))
  }
})

test('task runtime continues after budget, restores, and stops on pause, block, or completion', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'persist-task-runtime-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'session.jsonl')
  const harness = createHarness()
  t.after(async () => {
    await harness.command.getPromptForCommand('clear', { setAppState: harness.setAppState, transcriptPath: path } as unknown as ToolUseContext)
    clearBundledSkills()
  })
  const chain = { chainId: 'task-runtime', depth: 1, stopHookActive: true }
  const context = { setAppState: harness.setAppState, transcriptPath: path, queryTracking: chain } as unknown as ToolUseContext
  const start = await harness.command.getPromptForCommand('task --nudges 1 finish runtime delivery', context)
  assert.match(start[0]?.type === 'text' ? start[0].text : '', /in-process Stop-hook heartbeat is armed/i)
  assert.equal((await readPersistSessionRecord(path))?.taskMode, 'task')

  const currentHook = () => {
    const hook = harness.getHooks()[0]?.hook
    assert.ok(hook?.type === 'function')
    return hook
  }
  const checkpoint = JSON.stringify({
    kind: 'advanced', phase: 'implement', outcome: 'Runtime delivery works',
    doneWhen: 'Focused runtime acceptance passes', next: 'Run the focused runtime path',
    deferred: '', evidence: 'Implementation connected',
  })
  await harness.review.getPromptForCommand(`checkpoint ${checkpoint}`, context)
  assert.equal(await currentHook().callback([], undefined, chain), false)
  await settlePersistDelivery(getSessionId(), chain.chainId, true)
  assert.equal((await readPersistSessionRecord(path))?.nudgesRemaining, 0)

  await harness.review.getPromptForCommand('continue integration remains', context)
  assert.equal(await currentHook().callback([], undefined, chain), false)
  await settlePersistDelivery(getSessionId(), chain.chainId, true)
  assert.equal((await readPersistSessionRecord(path))?.status, 'active')
  assert.equal(harness.getHooks().length, 1)

  await drainPersistWrites()
  await restorePersistForCurrentSession(harness.setAppState, path)
  assert.equal(harness.getHooks().length, 1)
  await harness.command.getPromptForCommand('pause', context)
  assert.equal((await readPersistSessionRecord(path))?.status, 'paused')
  assert.equal(harness.getHooks().length, 0)
  await harness.command.getPromptForCommand('resume', context)
  assert.equal(harness.getHooks().length, 1)
  await harness.review.getPromptForCommand(`blocked ${JSON.stringify({ kind: 'blocked', blocker: 'user-input', canProceedWithoutUser: false, next: 'Ask the user for the required credential', evidence: 'The required credential is unavailable and no authorized alternative exists.' })}`, context)
  assert.equal((await readPersistSessionRecord(path))?.status, 'blocked')
  assert.equal(harness.getHooks().length, 0)

  await harness.command.getPromptForCommand('resume', context)
  assert.equal(harness.getHooks().length, 1)
  await harness.review.getPromptForCommand('complete Focused runtime acceptance passed with the connected workflow and stop conditions', context)
  assert.equal((await readPersistSessionRecord(path))?.status, 'completed')
  assert.equal(harness.getHooks().length, 0)
})

/**
 * A leaf is a session the person drives, so the goal it is given is its own.
 * The rule that refused one made the command a dead end in exactly the place
 * people work: /persist answered with a refusal instead of starting the task,
 * and a goal written by the parent's menu was never read back by the leaf it
 * was written for. Injecting the goal is also what fixes the failure that
 * retired the rule - a leaf heartbeating a goal its own transcript never
 * showed, because nothing ever told the leaf about it.
 */
test('a leaf holds, injects, and restores its own durable goal', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'persist-leaf-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'leaf.jsonl')
  const savedLeaf = process.env.GATEWAY_INTERACTIVE_LEAF
  const harness = createHarness()
  t.after(clearBundledSkills)

  // A goal record written for the leaf by its parent's menu.
  await writePersistSessionRecord({
    version: 1, task: 'testing leafs', mode: 'work', keep: false, taskMode: 'task',
    nudgesRemaining: 0, nudgesSent: 5, status: 'active', initialPlanningResponseAllowed: false,
  }, path)

  try {
    process.env.GATEWAY_INTERACTIVE_LEAF = '1'

    // The heartbeat is the leaf's, and the goal text reaches the leaf, so it
    // cannot work toward something its own conversation never mentions.
    await restorePersistForCurrentSession(harness.setAppState, path)
    assert.equal(harness.getHooks().length, 1, 'a leaf restores the stop hook of its goal')
    assert.match(getPersistGoalContext() ?? '', /testing leafs/)

    // The command a person types in the leaf arms the goal and starts the work.
    const armed = await harness.command.getPromptForCommand('keep --nudges 2 finish the leaf work', { setAppState: harness.setAppState, transcriptPath: path } as unknown as ToolUseContext)
    assert.match(JSON.stringify(armed), /Active persist task \(keep\)/)
    assert.equal(harness.getHooks().length, 1)
    await drainPersistWrites()
    assert.equal((await readPersistSessionRecord(path))?.task, 'finish the leaf work')
    assert.equal((await readPersistSessionRecord(path))?.nudgesRemaining, 2)
    assert.match(getPersistGoalContext() ?? '', /finish the leaf work/)

    // Reviewing it is the leaf's own review, against the goal it now holds.
    const review = await harness.review.getPromptForCommand('checkpoint {"kind":"learned","phase":"implement","outcome":"x","doneWhen":"y","next":"z","deferred":"none","evidence":"e"}', { setAppState: harness.setAppState, transcriptPath: path, queryTracking: { chainId: 'leaf-chain', depth: 1, stopHookActive: true } } as unknown as ToolUseContext)
    assert.match(JSON.stringify(review), /Goal review recorded: checkpoint/)
  } finally {
    if (savedLeaf === undefined) delete process.env.GATEWAY_INTERACTIVE_LEAF
    else process.env.GATEWAY_INTERACTIVE_LEAF = savedLeaf
  }

  // A leaf's goal is a session goal like any other: the same record restores and
  // injects in an ordinary session too.
  const ordinary = createHarness()
  await restorePersistForCurrentSession(ordinary.setAppState, path)
  assert.equal(ordinary.getHooks().length, 1)
  assert.match(getPersistGoalContext() ?? '', /finish the leaf work/)
})
