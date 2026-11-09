import React, { useEffect, useState, useSyncExternalStore } from 'react'
import { useRegisterOverlay } from '../context/overlayContext.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { Box, Text } from '../ink.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { useSetAppState } from '../state/AppState.js'
import type { QuestionRailItem } from '../utils/questionRail.js'
import {
  addQuestionNote,
  answerQuestion,
  clearFinishedQuestions,
  closeQuestion,
  finishedQuestionCount,
  getQuestionRailSnapshot,
  hydrateQuestionRailFromTranscript,
  reopenQuestion,
  subscribeToQuestionRail,
} from '../utils/questionRail.js'
import { registerQuestionRailStopHook } from '../utils/questionRailStopHook.js'
import TextInput from './TextInput.js'

/**
 * The Questions pill for the bottom nav, beside the leaf bar. It shows how many
 * questions are still waiting and, when it has any, expands into the rail list
 * so a question can be answered, chatted about, closed or reopened without
 * leaving the prompts the agent already asked.
 *
 * Answers and notes are injected as harness traffic rather than as user
 * prompts: the rail store stamps them with its own origin and a Stop hook
 * delivers them at a turn boundary, the same way session comms arrive. Nothing
 * typed here can jump the queue the person is writing into.
 *
 * The list expands in place rather than opening a modal: the pill already lives
 * in the pinned bottom chrome, so a row below it needs no overlay registration
 * or REPL wiring - the same shape the leaf carousel uses for its own list. The
 * one exception is the chat input, which has to take the keyboard away from the
 * composer while it is open, so it registers as a modal overlay for exactly as
 * long as it is mounted.
 */
export function QuestionRailBar(): React.ReactNode {
  const items = useSyncExternalStore(subscribeToQuestionRail, getQuestionRailSnapshot)
  const setAppState = useSetAppState()
  const [expanded, setExpanded] = useState(false)
  const [chattingId, setChattingId] = useState<string | undefined>(undefined)
  // A resumed session brings back the questions that were still open when it
  // was left; the reader is a no-op once the rail holds live items.
  useEffect(() => {
    void hydrateQuestionRailFromTranscript()
  }, [])
  // The turn-boundary half of delivery. The queue half is the enqueue in the
  // store; without this an answer that lands after a turn's last tool call
  // waits for the session to go idle instead of reaching the model now.
  useEffect(() => registerQuestionRailStopHook(setAppState), [setAppState])
  if (items.length === 0) return null
  const openCount = items.filter(item => item.state === 'open').length
  const finishedCount = finishedQuestionCount()
  return (
    <Box flexDirection="column" flexShrink={0} width="100%" paddingX={2}>
      <Box>
        <Box onClick={() => setExpanded(value => !value)}>
          <Text bold={openCount > 0} dimColor={expanded}>{`Questions(${openCount})`}</Text>
        </Box>
      </Box>
      {expanded && (
        <Box flexDirection="column" flexShrink={0} borderStyle="single" paddingX={1}>
          <Text bold>Questions waiting for you</Text>
          {items.map(item => (
            <QuestionRailRow
              key={item.id}
              item={item}
              chatting={chattingId === item.id}
              onStartChat={() => setChattingId(item.id)}
              onStopChat={() => setChattingId(undefined)}
            />
          ))}
          <Box gap={2}>
            {finishedCount > 0 && (
              <Box onClick={() => clearFinishedQuestions()}>
                <Text dimColor>{`Clear finished (${finishedCount})`}</Text>
              </Box>
            )}
            <Box onClick={() => setExpanded(false)}><Text dimColor>Close list</Text></Box>
          </Box>
        </Box>
      )}
    </Box>
  )
}

/** One rail item: its text, its state, what was said about it, and the actions
 *  its state allows. */
function QuestionRailRow({ item, chatting, onStartChat, onStopChat }: {
  item: QuestionRailItem
  chatting: boolean
  onStartChat: () => void
  onStopChat: () => void
}): React.ReactNode {
  const [answering, setAnswering] = useState(false)
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>{`[${item.id}] `}</Text>
        <Text>{item.question}</Text>
        <Text dimColor>{` (${item.header}) - ${item.state}`}</Text>
      </Box>
      {item.state === 'answered' && item.answer !== undefined &&
        <Text color="inactive">{`    answered: ${item.answer}`}</Text>}
      {item.thread?.map((note, index) => (
        <Text key={index} color="inactive">{`    you: ${note}`}</Text>
      ))}
      <Box gap={2}>
        {item.state === 'open' && !answering &&
          <Box onClick={() => setAnswering(true)}><Text dimColor>Answer</Text></Box>}
        {item.state === 'open' && answering &&
          item.options.map(option => (
            <Box key={option.label} onClick={() => { answerQuestion(item.id, option.label); setAnswering(false) }}>
              <Text>{`[${option.label}]`}</Text>
            </Box>
          ))}
        {item.state === 'open' && answering &&
          <Box onClick={() => setAnswering(false)}><Text dimColor>Cancel</Text></Box>}
        {!chatting &&
          <Box onClick={onStartChat}><Text dimColor>Chat</Text></Box>}
        {item.state === 'open' &&
          <Box onClick={() => closeQuestion(item.id)}><Text dimColor>Close</Text></Box>}
        {item.state !== 'open' &&
          <Box onClick={() => reopenQuestion(item.id)}><Text dimColor>Reopen</Text></Box>}
      </Box>
      {chatting && <QuestionRailChat item={item} onDone={onStopChat} />}
    </Box>
  )
}

/**
 * The thread input for one question.
 *
 * Registering as a modal overlay is what hands the keyboard over: while this is
 * mounted the composer is unfocused, so a keystroke lands in exactly one input
 * instead of both. Submitting clears the box rather than closing it, because
 * saying more about a question is the point - Escape closes it.
 */
function QuestionRailChat({ item, onDone }: { item: QuestionRailItem; onDone: () => void }): React.ReactNode {
  useRegisterOverlay('question-rail-chat', true)
  useKeybinding('confirm:no', onDone, { context: 'Settings' })
  const { columns } = useTerminalSize()
  const [value, setValue] = useState('')
  const [cursorOffset, setCursorOffset] = useState(0)
  const submit = (text: string): void => {
    addQuestionNote(item.id, text)
    setValue('')
    setCursorOffset(0)
  }
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Box borderStyle="round" borderDimColor paddingLeft={1}>
        <TextInput
          showCursor
          value={value}
          onChange={setValue}
          onSubmit={submit}
          placeholder={`Add detail about ${item.id}`}
          columns={Math.max(20, columns - 10)}
          cursorOffset={cursorOffset}
          onChangeCursorOffset={setCursorOffset}
          disableEscapeDoublePress
        />
      </Box>
      <Text dimColor>Enter to send · Esc to close</Text>
    </Box>
  )
}
