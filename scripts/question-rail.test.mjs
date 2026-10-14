import { strict as assert } from 'node:assert'
import test from 'node:test'

// Persistence is a no-op under NODE_ENV=test (sessionStorage.shouldSkipPersistence),
// so these tests exercise the rail without writing transcripts. Set it explicitly
// so the outcome does not depend on how the runner was invoked.
process.env.NODE_ENV = 'test'

import {
  answerQuestion,
  closeQuestion,
  enqueueQuestion,
  getQuestionRail,
  getQuestionRailSnapshot,
  hydrateQuestionRail,
  openQuestionCount,
  questionPillLabel,
  reopenQuestion,
  resetQuestionRail,
  subscribeToQuestionRail,
} from '../src/utils/questionRail.ts'
import {
  clearCommandQueue,
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
  // answer as an ordinary turn.
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
