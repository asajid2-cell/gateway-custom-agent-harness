import { strict as assert } from 'node:assert'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppState } from '../src/state/AppState.ts'
import type { ToolUseContext } from '../src/Tool.ts'
import { getSessionId } from '../src/bootstrap/state.ts'
import {
  canHoldPersistGoal,
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
 * A leaf is a scoped work conversation its parent owns, not a second main
 * session. Observed failure: a leaf whose parent had NO goal of its own still
 * ran five "Persist task heartbeat" stop hooks against a goal ("testing leafs")
 * that appears nowhere in the conversation the person had with it.
 */
test('a leaf cannot hold, inject, or restore a durable goal', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'persist-leaf-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'leaf.jsonl')
  const savedLeaf = process.env.GATEWAY_INTERACTIVE_LEAF
  const harness = createHarness()
  t.after(clearBundledSkills)

  // A goal record set for the leaf by its parent - the legitimate direction.
  await writePersistSessionRecord({
    version: 1, task: 'testing leafs', mode: 'work', keep: false, taskMode: 'task',
    nudgesRemaining: 0, nudgesSent: 5, status: 'active', initialPlanningResponseAllowed: false,
  }, path)

  try {
    process.env.GATEWAY_INTERACTIVE_LEAF = '1'
    assert.equal(canHoldPersistGoal(), false)

    // No stop-hook heartbeat, and no goal text in the leaf's system prompt.
    await restorePersistForCurrentSession(harness.setAppState, path)
    assert.equal(harness.getHooks().length, 0, 'a leaf must not arm a persist stop hook')
    assert.equal(getPersistGoalContext(), undefined, 'a leaf must not inject a durable goal')

    // Neither skill can start one from inside the leaf.
    const command = await harness.command.getPromptForCommand('task testing leafs', { setAppState: harness.setAppState, transcriptPath: path } as unknown as ToolUseContext)
    assert.match(JSON.stringify(command), /does not hold a durable goal/)
    const review = await harness.review.getPromptForCommand('checkpoint {"kind":"learned","phase":"implement","outcome":"x","doneWhen":"y","next":"z","deferred":[],"evidence":"e"}', { setAppState: harness.setAppState, transcriptPath: path, queryTracking: { chainId: 'leaf-chain', depth: 1, stopHookActive: true } } as unknown as ToolUseContext)
    assert.match(JSON.stringify(review), /holds no durable goal to review/)
    assert.equal(harness.getHooks().length, 0, 'a refused review must not arm a hook either')
    // The parent's own record is untouched by the leaf refusing to use it.
    assert.equal((await readPersistSessionRecord(path))?.nudgesSent, 5)
  } finally {
    if (savedLeaf === undefined) delete process.env.GATEWAY_INTERACTIVE_LEAF
    else process.env.GATEWAY_INTERACTIVE_LEAF = savedLeaf
  }

  // The same record in an ordinary session still restores and injects, so the
  // guard is about leaves and not about goals written for a leaf.
  const ordinary = createHarness()
  await restorePersistForCurrentSession(ordinary.setAppState, path)
  assert.equal(ordinary.getHooks().length, 1)
  assert.match(getPersistGoalContext() ?? '', /testing leafs/)
})
