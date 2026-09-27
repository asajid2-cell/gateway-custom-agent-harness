import { strict as assert } from 'node:assert'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
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
  registerPersistSkill,
  restorePersistForCurrentSession,
  settlePersistDelivery,
  type PersistState,
} from '../src/skills/bundled/persist.ts'
import {
  advanceDelivery,
  parseDeliveryReview,
  validateDeliveryCheckpoint,
} from '../src/skills/bundled/persistDelivery.ts'
import { clearBundledSkills, getBundledSkills } from '../src/skills/bundledSkills.ts'
import type { SessionHooksState } from '../src/utils/hooks/sessionHooks.ts'
import { readPersistSessionRecord } from '../src/utils/sessionStorage.ts'

const MAX_STALLED_HEARTBEATS = 3

const VALID = {
  kind: 'advanced',
  phase: 'implement',
  outcome: 'the connected workflow runs end to end',
  doneWhen: 'the real journey is verified on the target device',
  next: 'connect the second half of the journey',
  deferred: 'peripheral hardening',
  evidence: 'the end-to-end test passed',
}

function makeState(overrides: Partial<PersistState> = {}): PersistState {
  return {
    task: 'finish the connected workflow',
    mode: 'work',
    taskMode: 'bounded',
    nudgesRemaining: 1,
    nudgesSent: 0,
    hookId: 'persist-stress',
    initialPlanningResponseAllowed: false,
    ...overrides,
  }
}

function toolWork(id: string) {
  return createAssistantMessage({
    content: [{ type: 'tool_use' as const, id, name: 'Read', input: { file_path: 'src/index.ts' } }],
  })
}

/** What a heartbeat looks like when the model answers with a review instead of work. */
function reviewAttempt(id: string) {
  return createAssistantMessage({
    content: [{ type: 'tool_use' as const, id, name: 'Skill', input: { skill: 'persist-review', args: 'checkpoint {"phase":"integrate"}' } }],
  })
}

/** A turn that promised to stop and added nothing at all. */
function proseTurn() {
  return createAssistantMessage({
    content: [{ type: 'text' as const, text: 'Stopping here for now.' }],
  })
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
  const currentHook = () => {
    const hook = getHooks()[0]?.hook
    assert.ok(hook?.type === 'function')
    return hook
  }
  return { command, review, app, setAppState, getHooks, currentHook }
}

function makeContext(harness: ReturnType<typeof createHarness>, path: string, chainId: string) {
  const chain = { chainId, depth: 1, stopHookActive: true }
  return {
    chain,
    context: { setAppState: harness.setAppState, transcriptPath: path, queryTracking: chain } as unknown as ToolUseContext,
  }
}

/**
 * Every argument a session has been seen to send, plus the shapes a JSON parser
 * invites. None may throw, none may produce the two messages that made a session
 * believe its goal was already closed, and each one must reach a stated outcome.
 */
const ADVERSARIAL_ARGS = [
  '',
  '   ',
  '{}',
  '[]',
  'null',
  '42',
  '"a string"',
  '{',
  'not json at all',
  'checkpoint',
  'checkpoint ',
  'checkpoint:',
  'checkpoint  {"kind":"advanced"}',
  'checkpoint: {"kind":"advanced"}',
  'checkpoint: not json',
  `checkpoint: ${JSON.stringify(VALID)}`,
  'continue',
  'unrelated',
  'complete',
  'blocked',
  JSON.stringify(VALID),
  JSON.stringify({ ...VALID, kind: 'checkpoint' }),
  JSON.stringify({ ...VALID, kind: 'continue' }),
  JSON.stringify({ ...VALID, kind: 'delivered' }),
  JSON.stringify({ ...VALID, phase: 'harden' }),
  JSON.stringify({ ...VALID, phase: 'nonsense' }),
  JSON.stringify({ ...VALID, outcome: 7 }),
  JSON.stringify({ ...VALID, outcome: 'x'.repeat(2000) }),
  JSON.stringify({ kind: 'advanced' }),
  JSON.stringify({ kind: 'blocked' }),
  JSON.stringify({ kind: 'blocked', blocker: 'authorization', canProceedWithoutUser: false, next: 'wait', evidence: 'the user has not authorized more work' }),
  JSON.stringify({ kind: 'blocked', blocker: 'nonsense', canProceedWithoutUser: false, next: 'wait', evidence: 'reason' }),
  JSON.stringify({ kind: 'complete' }),
  JSON.stringify({ kind: 'unrelated' }),
  JSON.stringify([VALID]),
  JSON.stringify(null),
  'x'.repeat(17000),
  `checkpoint ${'y'.repeat(17000)}`,
  '{"kind":"advanced","phase":"implement","outcome":"o","doneWhen":"d","next":"n","deferred":"","evidence":"e","extra":{"nested":[1,2,3]}}',
]

test('no review payload can make the channel lie, throw, or leave the goal ambiguous', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'persist-stress-payloads-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const harness = createHarness()
  t.after(clearBundledSkills)

  for (const [index, args] of ADVERSARIAL_ARGS.entries()) {
    const path = join(directory, `payload-${index}.jsonl`)
    const { context } = makeContext(harness, path, `payload-${index}`)
    await harness.command.getPromptForCommand('task finish the connected workflow', context)
    assert.equal(harness.getHooks().length, 1, 'arming a goal installs exactly one heartbeat')

    const result = await harness.review.getPromptForCommand(args, context)
    const text = result[0]?.type === 'text' ? result[0].text : JSON.stringify(result)
    await drainPersistWrites()

    assert.ok(text.length > 0, `payload ${index} answered with nothing`)
    // The two phrases that produced the field incident: one claimed a stop had
    // been authorized, the other claimed no goal existed. Neither may ever
    // appear while a goal is armed.
    assert.doesNotMatch(text, /No continuation authorized/, `payload ${index} claimed a stop was authorized`)
    assert.doesNotMatch(text, /requires an active main-session goal/, `payload ${index} denied the armed goal`)

    const record = await readPersistSessionRecord(path)
    const settled = /blocked and retained/.test(text) || /Completed persist task/.test(text)
    assert.ok(
      settled ? harness.getHooks().length === 0 : harness.getHooks().length === 1,
      `payload ${index} left the heartbeat in the wrong state: ${text.slice(0, 120)}`,
    )
    assert.ok(record, `payload ${index} left no sidecar`)
    assert.equal(record?.task, 'finish the connected workflow', `payload ${index} rewrote the goal`)

    await harness.command.getPromptForCommand('clear', context)
  }
})

test('a heartbeat answered only by failed reviews is retired on every payload that records nothing', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'persist-stress-terminates-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const harness = createHarness()
  t.after(clearBundledSkills)

  // Each of these records nothing. Whatever the model does with the refusal -
  // retry it, rephrase it, ignore it - the heartbeat must stop asking.
  const barren = [
    'checkpoint {"phase":"integrate"}',
    'checkpoint {"kind":"advanced","phase":"harden","outcome":"o","doneWhen":"d","next":"n","deferred":"","evidence":"e"}',
    '{"phase":"integrate"}',
    'not json',
    '{}',
    '',
  ]

  for (const [index, args] of barren.entries()) {
    const path = join(directory, `terminate-${index}.jsonl`)
    const { chain, context } = makeContext(harness, path, `terminate-${index}`)
    await harness.command.getPromptForCommand('task --nudges 1 finish the connected workflow', context)

    let messages: Parameters<typeof decidePersistStop>[1] = []
    let allowedAfter = -1
    for (let turn = 0; turn < 12; turn += 1) {
      await harness.review.getPromptForCommand(args, context)
      messages = [...messages, reviewAttempt(`toolu_barren_${index}_${turn}`)]
      const allowed = await harness.currentHook().callback(messages, undefined, chain)
      if (allowed) { allowedAfter = turn + 1; break }
      await settlePersistDelivery(getSessionId(), chain.chainId, true)
    }

    assert.ok(allowedAfter > 0, `payload ${index} ("${args.slice(0, 30)}") never stopped the heartbeat`)
    assert.ok(allowedAfter <= 5, `payload ${index} asked for ${allowedAfter} heartbeats`)
    assert.equal(harness.getHooks().length, 0, `payload ${index} left the hook installed`)
    await drainPersistWrites()
    const record = await readPersistSessionRecord(path)
    assert.equal(record?.status, 'stalled', `payload ${index} did not park the goal`)
    assert.equal(record?.task, 'finish the connected workflow', `payload ${index} lost the goal`)
    assert.match(getPersistGoalContext() ?? '', /Do not automatically pursue it/)

    await harness.command.getPromptForCommand('clear', context)
  }
})

test('a kept goal declined at every stop is parked, not nagged once per turn forever', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'persist-stress-keep-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const harness = createHarness()
  t.after(clearBundledSkills)

  const path = join(directory, 'keep.jsonl')
  const { chain, context } = makeContext(harness, path, 'keep-declined')
  await harness.command.getPromptForCommand('keep --nudges 1 release notes current', context)

  // A kept goal is asked to review itself before the heartbeat will continue.
  // A session that answers by stopping again with nothing recorded is answering
  // a reminder with nothing, so it counts on the same ceiling as a task
  // heartbeat - which is what stops a kept goal nagging once per turn forever.
  let messages: Parameters<typeof decidePersistStop>[1] = []
  assert.equal(await harness.currentHook().callback(messages, undefined, chain), false, 'the kept goal was never asked to review')
  for (let turn = 0; turn <= MAX_STALLED_HEARTBEATS; turn += 1) {
    messages = [...messages, proseTurn()]
    assert.equal(await harness.currentHook().callback(messages, undefined, chain), true, `declining stop ${turn} was not allowed`)
  }
  await drainPersistWrites()
  assert.equal(harness.getHooks().length, 0, 'the parked kept goal left its hook installed')
  const record = await readPersistSessionRecord(path)
  assert.equal(record?.status, 'stalled')
  assert.equal(record?.task, 'release notes current')
  assert.equal(record?.nudgesSent, 0)
  assert.match(getPersistGoalContext() ?? '', /Do not automatically pursue it/)

  await harness.command.getPromptForCommand('clear', context)
})

test('sixty heartbeats of real work never trip the ceiling', () => {
  const context = { chainId: 'stress-work', depth: 1, stopHookActive: true }
  const state = makeState({ taskMode: 'task', nudgesRemaining: 0 })
  // The ceiling is a limit on heartbeats that do nothing, never on the work.
  let messages: Parameters<typeof decidePersistStop>[1] = []
  for (let i = 0; i < 60; i += 1) {
    messages = [...messages, toolWork(`toolu_stress_${i}`)]
    assert.equal(decidePersistStop(state, messages, undefined, context).kind, 'nudge', `heartbeat ${i} was not a nudge`)
    assert.equal(state.stalledHeartbeats, 0, `heartbeat ${i} was counted as a stall`)
  }
  assert.equal(state.nudgesSent, 60)
  assert.equal(state.status, undefined)
})

test('the budget still bounds bounded mode and never bounds a continuation mode', () => {
  const context = { chainId: 'stress-budget', depth: 1, stopHookActive: true }
  const bounded = makeState({ taskMode: 'bounded', nudgesRemaining: 2 })
  assert.equal(decidePersistStop(bounded, [], undefined, context).kind, 'nudge')
  assert.equal(decidePersistStop(bounded, [], undefined, context).kind, 'nudge')
  assert.deepEqual(decidePersistStop(bounded, [], undefined, context), { kind: 'allow', reason: 'budget-exhausted' })
  assert.equal(bounded.status, 'exhausted')

  // A continuation mode treats the budget as an opening reminder count only:
  // spending it must never exhaust the goal.
  for (const taskMode of ['keep', 'task'] as const) {
    const state = makeState({ taskMode, nudgesRemaining: 0 })
    assert.equal(decidePersistStop(state, [], undefined, context).kind, 'nudge', `${taskMode} exhausted on budget`)
    assert.equal(state.status, undefined, `${taskMode} was marked exhausted`)
  }

  // With real work arriving each turn a continuation mode never parks, however
  // many heartbeats it has sent and however long its budget has been spent.
  for (const taskMode of ['keep', 'task'] as const) {
    const state = makeState({ taskMode, nudgesRemaining: 0 })
    const messages: ReturnType<typeof toolWork>[] = []
    for (let i = 0; i < 40; i += 1) {
      messages.push(toolWork(`toolu_${taskMode}_${i}`))
      assert.equal(decidePersistStop(state, messages, undefined, context).kind, 'nudge', `${taskMode} disarmed at heartbeat ${i}`)
    }
    assert.equal(state.status, undefined)
    assert.equal(state.stalledHeartbeats, 0)
  }

  // With no work at all it is the stall ceiling that ends it, not the budget,
  // and the goal is parked rather than marked out of budget.
  const barren = makeState({ taskMode: 'keep', nudgesRemaining: 0 })
  for (let i = 0; i < MAX_STALLED_HEARTBEATS; i += 1) {
    assert.equal(decidePersistStop(barren, [], undefined, context).kind, 'nudge', `barren heartbeat ${i}`)
  }
  assert.deepEqual(decidePersistStop(barren, [], undefined, context), { kind: 'allow', reason: 'no-progress' })
  assert.equal(barren.status, 'stalled')

  // A bounded goal with no budget left never nudges, however much work it saw.
  const spent = makeState({ taskMode: 'bounded', nudgesRemaining: 0 })
  assert.deepEqual(decidePersistStop(spent, [toolWork('toolu_spent')], undefined, context), { kind: 'allow', reason: 'budget-exhausted' })
})

test('every exit path leaves one coherent state, and the sidecar is what restore reads', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'persist-stress-exits-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const harness = createHarness()
  t.after(clearBundledSkills)

  const run = async (name: string, body: (context: ToolUseContext) => Promise<void>) => {
    const path = join(directory, `${name}.jsonl`)
    const { context } = makeContext(harness, path, name)
    await body(context)
    await harness.command.getPromptForCommand('clear', context)
    assert.equal(harness.getHooks().length, 0, `${name} left a hook installed after clear`)
  }

  // Task mode closes only with a delivery behind it.
  await run('complete-no-delivery', async context => {
    await harness.command.getPromptForCommand('task finish the connected workflow', context)
    const refused = await harness.review.getPromptForCommand('complete it is done now', context)
    assert.match(refused[0].type === 'text' ? refused[0].text : '', /meaningful delivery checkpoint/)
    assert.equal(harness.getHooks().length, 1)
  })

  await run('complete-with-delivery', async context => {
    await harness.command.getPromptForCommand('task finish the connected workflow', context)
    await harness.review.getPromptForCommand(JSON.stringify({ ...VALID, kind: 'delivered' }), context)
    const closed = await harness.review.getPromptForCommand('complete the end-to-end journey passed on the target device', context)
    assert.match(closed[0].type === 'text' ? closed[0].text : '', /Completed the persist task/)
    assert.equal(harness.getHooks().length, 0)
  })

  await run('blocked-task', async context => {
    await harness.command.getPromptForCommand('task finish the connected workflow', context)
    const parked = await harness.review.getPromptForCommand(JSON.stringify({ kind: 'blocked', blocker: 'authorization', canProceedWithoutUser: false, next: 'wait for authorization', evidence: 'the user has not authorized further work' }), context)
    assert.match(parked[0].type === 'text' ? parked[0].text : '', /blocked and retained/)
    assert.equal(harness.getHooks().length, 0)
  })

  await run('blocked-keep-prose', async context => {
    await harness.command.getPromptForCommand('keep --nudges 2 finish the connected workflow', context)
    const parked = await harness.review.getPromptForCommand('blocked the signing key is not available on this machine', context)
    assert.match(parked[0].type === 'text' ? parked[0].text : '', /blocked and retained/)
    assert.equal(harness.getHooks().length, 0)
  })

  await run('pause-resume', async context => {
    await harness.command.getPromptForCommand('task finish the connected workflow', context)
    await harness.command.getPromptForCommand('pause', context)
    assert.equal(harness.getHooks().length, 0)
    await harness.command.getPromptForCommand('resume', context)
    assert.equal(harness.getHooks().length, 1)
    const paused = makeState({ status: 'paused' })
    assert.deepEqual(decidePersistStop(paused, [], undefined, { chainId: 'x', depth: 1, stopHookActive: true }), { kind: 'allow', reason: 'inactive' })
  })

  await run('manual-complete', async context => {
    await harness.command.getPromptForCommand('task finish the connected workflow', context)
    await harness.command.getPromptForCommand('complete', context)
    assert.equal(harness.getHooks().length, 0)
  })
})

test('restoring a goal is idempotent and a parked goal comes back quiet', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'persist-stress-restore-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const harness = createHarness()
  t.after(clearBundledSkills)
  const path = join(directory, 'restore.jsonl')
  const { chain, context } = makeContext(harness, path, 'restore')

  await harness.command.getPromptForCommand('task --nudges 1 finish the connected workflow', context)
  await drainPersistWrites()
  assert.equal(harness.getHooks().length, 1)
  // Restoring twice must not install a second heartbeat.
  await restorePersistForCurrentSession(harness.setAppState, path)
  await restorePersistForCurrentSession(harness.setAppState, path)
  assert.equal(harness.getHooks().length, 1)

  // Drive it to a stall, then restore: the goal survives and the hook does not.
  let messages: Parameters<typeof decidePersistStop>[1] = []
  for (let turn = 0; turn < 6; turn += 1) {
    messages = [...messages, reviewAttempt(`toolu_restore_${turn}`)]
    const allowed = await harness.currentHook().callback(messages, undefined, chain)
    if (allowed) break
    await settlePersistDelivery(getSessionId(), chain.chainId, true)
  }
  await drainPersistWrites()
  assert.equal((await readPersistSessionRecord(path))?.status, 'stalled')
  clearBundledSkills()
  registerPersistSkill()
  await restorePersistForCurrentSession(harness.setAppState, path)
  assert.equal(harness.getHooks().length, 0, 'a parked goal must not reinstall the heartbeat')
  assert.match(getPersistGoalContext() ?? '', /finish the connected workflow/)
  await harness.command.getPromptForCommand('clear', context)
})

test('concurrent reviews serialise without losing or corrupting the goal', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'persist-stress-concurrent-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const harness = createHarness()
  t.after(clearBundledSkills)
  const path = join(directory, 'concurrent.jsonl')
  const { context } = makeContext(harness, path, 'concurrent')
  await harness.command.getPromptForCommand('task finish the connected workflow', context)

  const [first, second, third] = await Promise.all([
    harness.review.getPromptForCommand(JSON.stringify({ ...VALID, kind: 'delivered' }), context),
    harness.review.getPromptForCommand('continue connecting the second half', context),
    harness.review.getPromptForCommand(JSON.stringify(VALID), context),
  ])
  for (const result of [first, second, third]) {
    const text = result[0]?.type === 'text' ? result[0].text : ''
    assert.doesNotMatch(text, /No continuation authorized/)
    assert.doesNotMatch(text, /Session or goal changed during review/)
  }
  await drainPersistWrites()
  const record = await readPersistSessionRecord(path)
  assert.equal(record?.task, 'finish the connected workflow')
  assert.equal(record?.status, 'active')
  // The recorded checkpoint is one the delivery rules would accept, not a
  // half-written blend of the three.
  assert.ok(record?.delivery, 'no delivery recorded')
  assert.equal(record?.delivery?.outcome, VALID.outcome)
  assert.equal(harness.getHooks().length, 1)
  await harness.command.getPromptForCommand('clear', context)
})

test('the delivery rules refuse every shortcut and accept the honest sequence', () => {
  // Nothing may begin anywhere but implementation.
  for (const phase of ['integrate', 'harden'] as const) {
    for (const kind of ['advanced', 'learned', 'delivered', 'detoured'] as const) {
      assert.throws(() => advanceDelivery(undefined, { ...VALID, phase, kind }), /Begin with an implementation outcome/)
    }
  }
  // `advanceDelivery` trusts its input, so a phase or kind that never came from
  // the parser is the parser's to refuse - and it does, before any state moves.
  assert.throws(() => parseDeliveryReview(JSON.stringify({ ...VALID, phase: 'nonsense' })), /Invalid delivery review kind or phase/)
  assert.throws(() => parseDeliveryReview(JSON.stringify({ ...VALID, kind: 'nonsense' })), /Invalid delivery review kind or phase/)

  const implemented = advanceDelivery(undefined, { ...VALID, kind: 'delivered' })
  assert.equal(implemented.phase, 'implement')
  assert.equal(implemented.reviewsSinceDelivery, 0)

  // A phase may only move one step, and only by delivering.
  assert.throws(() => advanceDelivery(implemented, { ...VALID, phase: 'harden', kind: 'advanced' }), /Advance phase only after delivering/)
  assert.throws(() => advanceDelivery(implemented, { ...VALID, phase: 'harden', kind: 'delivered' }), /Advance phase only after delivering/)
  assert.throws(() => advanceDelivery(implemented, { ...VALID, phase: 'integrate', kind: 'advanced' }), /Advance phase only after delivering/)

  // An undelivered review may not rewrite the outcome or the acceptance test.
  assert.throws(() => advanceDelivery(implemented, { ...VALID, outcome: 'something narrower' }), /Keep the selected outcome/)
  assert.throws(() => advanceDelivery(implemented, { ...VALID, doneWhen: 'a weaker bar' }), /Keep the selected outcome/)
  const delivered = advanceDelivery(implemented, { ...VALID, phase: 'integrate', kind: 'delivered', outcome: 'the next outcome' })
  assert.equal(delivered.phase, 'integrate')

  // A delivered review clears the trajectory counters; anything else advances
  // the review count. A review that carries new evidence and a new next step is
  // progress, so the detour count stays where it was.
  assert.equal(delivered.reviewsSinceDelivery, 0)
  assert.equal(delivered.detours, 0)
  const advanced = advanceDelivery(delivered, { ...VALID, phase: 'integrate', outcome: delivered.outcome, next: 'wire the second half of the journey', evidence: 'the first half landed and the second is opened' })
  assert.equal(advanced.reviewsSinceDelivery, 1)
  assert.equal(advanced.detours, 0, 'a review with fresh evidence and a fresh next step was called a detour')

  const detoured = advanceDelivery(advanced, { ...VALID, phase: 'integrate', outcome: advanced.outcome, kind: 'detoured', next: 'probe the flaky edge', evidence: 'the probe was inconclusive' })
  assert.equal(detoured.reviewsSinceDelivery, 2)
  assert.equal(detoured.detours, 1)

  // Repeating the same evidence and next is a detour even without saying so.
  const repeated = advanceDelivery(detoured, { ...detoured, kind: 'advanced' })
  assert.equal(repeated.detours, 2)

  // The leniency is only in the kind: an absent one, or the skill's verb, reads
  // as the conservative review and never as a delivery.
  for (const kind of [undefined, 'checkpoint', 'continue']) {
    const review = parseDeliveryReview(JSON.stringify({ ...VALID, kind }))
    assert.equal(review.kind, 'advanced')
    const next = advanceDelivery(advanced, { ...review, phase: 'integrate', outcome: advanced.outcome, next: `advance after ${kind ?? 'an absent kind'}`, evidence: `evidence after ${kind ?? 'an absent kind'}` })
    assert.equal(next.reviewsSinceDelivery, 2)
    assert.equal(next.detours, 0)
  }

  // Field validation still holds.
  for (const field of ['outcome', 'doneWhen', 'next', 'evidence'] as const) {
    assert.throws(() => parseDeliveryReview(JSON.stringify({ ...VALID, [field]: '' })), /Invalid delivery field/)
    assert.throws(() => parseDeliveryReview(JSON.stringify({ ...VALID, [field]: 'x'.repeat(1201) })), /Invalid delivery field/)
    assert.throws(() => parseDeliveryReview(JSON.stringify({ ...VALID, [field]: 5 })), /Invalid delivery field/)
  }
  assert.throws(() => parseDeliveryReview(JSON.stringify({ ...VALID, deferred: 5 })), /Invalid delivery field/)
  assert.throws(() => parseDeliveryReview('x'.repeat(16001)), /too large/)

  // `deferred` is the one field a review may leave out. A live session omitted
  // it, was refused for a rule the skill never stated, and spent a turn on it -
  // so an absent field reads as empty rather than failing the whole review.
  const { deferred: _omitted, ...withoutDeferred } = VALID
  const omitted = parseDeliveryReview(JSON.stringify(withoutDeferred))
  assert.equal(omitted.deferred, '')
  assert.equal(omitted.outcome, VALID.outcome)
  assert.equal(omitted.phase, VALID.phase)
  assert.deepEqual(parseDeliveryReview(JSON.stringify({ ...VALID, deferred: '' })).deferred, '')
})

test('a checkpoint survives the round trip through the sidecar that restore reads', () => {
  const checkpoint = advanceDelivery(undefined, { ...VALID, kind: 'delivered' })
  const stored = JSON.parse(JSON.stringify(checkpoint))
  assert.deepEqual(validateDeliveryCheckpoint(stored), checkpoint)
  // Anything half-written is dropped rather than trusted.
  assert.equal(validateDeliveryCheckpoint({ broken: true }), undefined)
  assert.equal(validateDeliveryCheckpoint({ ...stored, reviewsSinceDelivery: -1 }), undefined)
  assert.equal(validateDeliveryCheckpoint({ ...stored, detours: 1.5 }), undefined)
  assert.equal(validateDeliveryCheckpoint({ ...stored, phase: 'nonsense' }), undefined)
  assert.equal(validateDeliveryCheckpoint(null), undefined)
  assert.equal(validateDeliveryCheckpoint([]), undefined)
})
