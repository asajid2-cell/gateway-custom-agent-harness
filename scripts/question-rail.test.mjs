import { strict as assert } from 'node:assert'
import test from 'node:test'

// Persistence is a no-op under NODE_ENV=test (sessionStorage.shouldSkipPersistence),
// so these tests exercise the rail without writing transcripts. Set it explicitly
// so the outcome does not depend on how the runner was invoked.
process.env.NODE_ENV = 'test'

import {
  addQuestionNote,
  answerQuestion,
  clearFinishedQuestions,
  closeQuestion,
  enqueueQuestion,
  finishedQuestionCount,
  getQuestionRail,
  getQuestionRailSnapshot,
  hydrateQuestionRail,
  openQuestionCount,
  questionPillLabel,
  reopenQuestion,
  resetQuestionRail,
  subscribeToQuestionRail,
} from '../src/utils/questionRail.ts'
import { takeQueuedQuestionRailInjections } from '../src/utils/questionRailInjection.ts'
import {
  clearCommandQueue,
  enqueue,
  getCommandQueue,
  resetCommandQueue,
} from '../src/utils/messageQueueManager.ts'

const shipInput = {
  questions: [
    {
      question: 'Ship it?',
      header: 'Ship',
      options: [
        { label: 'Yes', description: 'ship' },
        { label: 'No', description: 'hold' },
      ],
      multiSelect: false,
    },
  ],
}

// A local REPL context: interactive, no channels, no bridge.
const localCtx = () => ({
  options: { isNonInteractiveSession: false },
  getAppState: () => ({}),
})

// A remote/channel context: not the local REPL surface.
const remoteCtx = () => ({
  options: { isNonInteractiveSession: true },
  getAppState: () => ({}),
})

async function tool() {
  return (await import('../src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx'))
    .AskUserQuestionTool
}

test('a question enqueues without blocking: the agent proceeds and the pill counts it', async () => {
  resetQuestionRail()
  resetCommandQueue()
  const ask = await tool()

  // R1: the tool call settles with a queued result instead of an answer, so
  // the agent's next turn proceeds with no user input.
  const result = await ask.call(shipInput, localCtx())
  assert.equal(result.data.queued, true)
  assert.deepEqual(result.data.answers, {})
  assert.equal(result.data.queuedIds.length, 1)

  // The tool_result the model reads says the question is waiting, not answered.
  const block = ask.mapToolResultToToolResultBlockParam(result.data, 'tu_1')
  assert.match(block.content, /^Question queued \(id q1\)\. It is in the Questions rail/)
  assert.match(block.content, /Continue with your work\.$/)
  assert.doesNotMatch(block.content, /User has answered/)

  // The visible outcome, part 1: one question is waiting, and the pill says so.
  assert.equal(openQuestionCount(), 1)
  assert.equal(questionPillLabel(), 'Questions(1)')

  // The visible outcome, part 2: answering clears the count and injects the
  // answer as harness traffic, not as a prompt.
  const answered = answerQuestion('q1', 'Yes')
  assert.equal(answered?.state, 'answered')
  assert.equal(openQuestionCount(), 0)
  assert.equal(questionPillLabel(), 'Questions(0)')

  const queued = getCommandQueue()
  assert.equal(queued.length, 1)
  assert.equal(queued[0].mode, 'prompt')
  assert.match(
    String(queued[0].value),
    /The user answered your queued question "Ship it\?": Yes/,
  )

  // Injected the way session comms arrive: meta (so Escape cannot pull it into
  // the composer and it does not spend the user-message budget), mid-turn
  // priority, and stamped with the rail's own origin so the Stop hook and the
  // system-reminder wrapper can tell it apart from anything a person typed.
  assert.equal(queued[0].isMeta, true)
  assert.equal(queued[0].skipSlashCommands, true)
  assert.equal(queued[0].priority, 'next')
  assert.equal(queued[0].origin?.kind, 'question-rail')
})

test('a note about a question is kept on the item and injected with it', () => {
  resetQuestionRail()
  resetCommandQueue()

  const item = enqueueQuestion({
    question: 'Ship it?',
    header: 'Ship',
    options: [
      { label: 'Yes', description: 'ship' },
      { label: 'No', description: 'hold' },
    ],
  })
  clearCommandQueue()

  const noted = addQuestionNote(item.id, '  only after the gate is green  ')
  assert.deepEqual(noted?.thread, ['only after the gate is green'])
  // The question is still open: a note is not an answer.
  assert.equal(noted?.state, 'open')
  assert.equal(openQuestionCount(), 1)

  const queued = getCommandQueue()
  assert.equal(queued.length, 1)
  assert.match(
    String(queued[0].value),
    /The user added context to your queued question "Ship it\?": only after the gate is green/,
  )
  assert.equal(queued[0].origin?.kind, 'question-rail')

  // A blank note is not a message and must not reach the model.
  assert.equal(addQuestionNote(item.id, '   '), undefined)
  assert.equal(getCommandQueue().length, 1)
})

test('the turn-boundary hook claims only rail traffic, and only while it is queued', () => {
  resetQuestionRail()
  resetCommandQueue()

  const item = enqueueQuestion({
    question: 'Ship it?',
    header: 'Ship',
    options: [
      { label: 'Yes', description: 'ship' },
      { label: 'No', description: 'hold' },
    ],
  })
  clearCommandQueue()

  // Nothing owed: the hook allows the stop and the turn is not extended.
  assert.equal(takeQueuedQuestionRailInjections(), undefined)

  answerQuestion(item.id, 'Yes')
  addQuestionNote(item.id, 'and ship it behind the flag')

  // A message the person typed is not rail traffic and is left alone.
  enqueue({ value: 'not rail traffic', mode: 'prompt' })

  const text = takeQueuedQuestionRailInjections()
  assert.match(text, /answered your queued question "Ship it\?": Yes/)
  assert.match(text, /added context to your queued question "Ship it\?": and ship it behind the flag/)
  // Claiming takes it out of the queue, so the idle-wake path cannot run the
  // same answer a second time as a prompt.
  assert.deepEqual(getCommandQueue().map(cmd => String(cmd.value)), ['not rail traffic'])
  assert.equal(takeQueuedQuestionRailInjections(), undefined)

  clearCommandQueue()
})

test('clearing finished questions drops history and keeps what is still open', () => {
  resetQuestionRail()
  resetCommandQueue()

  const first = enqueueQuestion({
    question: 'Ship it?',
    header: 'Ship',
    options: [
      { label: 'Yes', description: 'ship' },
      { label: 'No', description: 'hold' },
    ],
  })
  const second = enqueueQuestion({
    question: 'Tag it?',
    header: 'Tag',
    options: [
      { label: 'Yes', description: 'tag' },
      { label: 'No', description: 'skip' },
    ],
  })
  answerQuestion(first.id, 'Yes')
  closeQuestion(second.id)
  clearCommandQueue()

  // Both are finished, so the rail offers to clear them.
  assert.equal(finishedQuestionCount(), 2)
  assert.equal(clearFinishedQuestions(), 2)
  assert.equal(getQuestionRail().length, 0)
  assert.equal(finishedQuestionCount(), 0)

  // Open questions are never cleared: they are not history.
  const third = enqueueQuestion({
    question: 'Deploy now?',
    header: 'Deploy',
    options: [
      { label: 'Yes', description: 'go' },
      { label: 'No', description: 'wait' },
    ],
  })
  assert.equal(clearFinishedQuestions(), 0)
  assert.equal(getQuestionRail().length, 1)
  assert.equal(third.state, 'open')

  // Ids keep advancing past a cleared one, so a later answer cannot name a
  // question that is no longer on the rail.
  const fourth = enqueueQuestion({
    question: 'And then?',
    header: 'Next',
    options: [
      { label: 'A', description: 'a' },
      { label: 'B', description: 'b' },
    ],
  })
  assert.equal(fourth.id, 'q4')
})

test('only one surface owns a question: the local REPL, never both', async () => {
  resetQuestionRail()
  resetCommandQueue()
  const ask = await tool()

  // R5, the failing half before the change: a remote/channel context keeps the
  // blocking dialog (behavior 'ask') and must NOT also put the question on the
  // rail, or two surfaces would own it.
  const remotePerm = await ask.checkPermissions(shipInput, remoteCtx())
  assert.equal(remotePerm.behavior, 'ask')
  const remoteResult = await ask.call(shipInput, remoteCtx())
  assert.notEqual(remoteResult.data.queued, true)
  assert.equal(openQuestionCount(), 0)

  // The local REPL owns it instead: no blocking prompt, question on the rail.
  const localPerm = await ask.checkPermissions(shipInput, localCtx())
  assert.equal(localPerm.behavior, 'allow')
  const localResult = await ask.call(shipInput, localCtx())
  assert.equal(localResult.data.queued, true)
  assert.equal(openQuestionCount(), 1)
})

test('an interrupt does not drop open rail items', () => {
  resetQuestionRail()
  resetCommandQueue()

  // R7: ESC/interrupt clears the command queue. The rail is not the queue, so
  // a question that was still open stays open.
  enqueueQuestion({
    question: 'Keep going?',
    header: 'Continue',
    options: [
      { label: 'Yes', description: 'go' },
      { label: 'No', description: 'stop' },
    ],
  })
  assert.equal(openQuestionCount(), 1)

  clearCommandQueue()

  assert.equal(getCommandQueue().length, 0)
  assert.equal(openQuestionCount(), 1)
  assert.equal(questionPillLabel(), 'Questions(1)')
})

test('rail state is folded last-wins on restore: answered stays answered, open stays open', () => {
  resetQuestionRail()
  const entry = (id, state, answer) => ({
    type: 'question-rail',
    sessionId: '00000000-0000-4000-8000-000000000000',
    id,
    question: `Question ${id}?`,
    header: 'H',
    options: [{ label: 'A', description: 'a' }],
    multiSelect: false,
    state,
    createdAt: Number(id.slice(1)),
    ...(answer !== undefined && { answer }),
    timestamp: new Date().toISOString(),
  })

  // One record per transition; the last for q1 wins.
  hydrateQuestionRail([
    entry('q1', 'open'),
    entry('q2', 'open'),
    entry('q1', 'answered', 'Yes'),
  ])

  const byId = Object.fromEntries(getQuestionRail().map(item => [item.id, item]))
  assert.equal(byId.q1.state, 'answered')
  assert.equal(byId.q1.answer, 'Yes')
  assert.equal(byId.q2.state, 'open')
  assert.equal(openQuestionCount(), 1)
})

test('a cleared item stays cleared on restore, and its id stays spent', () => {
  resetQuestionRail()
  const entry = (id, state, extra = {}) => ({
    type: 'question-rail',
    sessionId: '00000000-0000-4000-8000-000000000000',
    id,
    question: `Question ${id}?`,
    header: 'H',
    options: [{ label: 'A', description: 'a' }],
    multiSelect: false,
    state,
    createdAt: Number(id.slice(1)),
    timestamp: new Date().toISOString(),
    ...extra,
  })

  // q1 answered then cleared; q2 answered and left alone. The tombstone is the
  // last record for q1, so "clear" wins over the earlier transitions instead of
  // the item reappearing on --resume.
  hydrateQuestionRail([
    entry('q1', 'open'),
    entry('q1', 'answered', { answer: 'Yes', thread: ['ship behind the flag'] }),
    entry('q2', 'answered', { answer: 'No', thread: ['only after the gate'] }),
    entry('q1', 'answered', { answer: 'Yes', cleared: true }),
  ])

  assert.deepEqual(getQuestionRail().map(item => item.id), ['q2'])
  // What was said about the surviving item is restored with it.
  assert.deepEqual(getQuestionRail()[0].thread, ['only after the gate'])

  // The cleared id is not handed out again.
  assert.equal(
    enqueueQuestion({
      question: 'Next?',
      header: 'N',
      options: [
        { label: 'A', description: 'a' },
        { label: 'B', description: 'b' },
      ],
    }).id,
    'q3',
  )
})

test('the Stop hook blocks only while a rail answer is owed, then unregisters', async () => {
  resetQuestionRail()
  resetCommandQueue()
  const { getSessionId } = await import('../src/bootstrap/state.ts')
  const { registerQuestionRailStopHook } = await import(
    '../src/utils/questionRailStopHook.ts'
  )

  // The smallest AppState the session-hook store touches: a Map it can set on.
  const state = { sessionHooks: new Map() }
  const setAppState = updater => {
    const next = updater(state)
    if (next !== state) Object.assign(state, next)
  }

  const unregister = registerQuestionRailStopHook(setAppState)
  const sessionId = getSessionId()
  const matchers = state.sessionHooks.get(sessionId).hooks.Stop
  assert.equal(matchers.length, 1)
  const hook = matchers[0].hooks[0].hook
  assert.equal(hook.id, 'question-rail-inject')
  assert.equal(hook.statusMessage, 'question answer')

  // Nothing owed: the stop is allowed, so a turn ending normally pays a scan.
  assert.equal(await hook.callback([], undefined, { stopHookActive: false }), true)

  const item = enqueueQuestion({
    question: 'Ship it?',
    header: 'Ship',
    options: [
      { label: 'Yes', description: 'ship' },
      { label: 'No', description: 'hold' },
    ],
  })
  answerQuestion(item.id, 'Yes')

  // Owed: the hook blocks and the text it blocks with is the answer.
  assert.equal(await hook.callback([], undefined, { stopHookActive: false }), false)
  assert.match(hook.errorMessage([]), /answered your queued question "Ship it\?": Yes/)
  // The claim is one-shot: the follow-up turn ends without paying again.
  assert.equal(await hook.callback([], undefined, { stopHookActive: true }), true)

  unregister()
  assert.equal(state.sessionHooks.has(sessionId), false)
  clearCommandQueue()
})

test('a subscriber is notified on every rail transition', () => {
  resetQuestionRail()
  let notified = 0
  const unsubscribe = subscribeToQuestionRail(() => { notified += 1 })

  const item = enqueueQuestion({
    question: 'Notify?',
    header: 'N',
    options: [
      { label: 'A', description: 'a' },
      { label: 'B', description: 'b' },
    ],
  })
  assert.equal(notified, 1)
  assert.equal(getQuestionRailSnapshot().length, 1)

  closeQuestion(item.id)
  assert.equal(notified, 2)
  reopenQuestion(item.id)
  assert.equal(notified, 3)
  assert.equal(getQuestionRailSnapshot()[0].state, 'open')

  unsubscribe()
})
