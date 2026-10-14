import React, { useEffect, useState, useSyncExternalStore } from 'react'
import { Box, Text } from '../ink.js'
import {
  answerQuestion,
  closeQuestion,
  getQuestionRailSnapshot,
  hydrateQuestionRailFromTranscript,
  reopenQuestion,
  subscribeToQuestionRail,
} from '../utils/questionRail.js'

/**
 * The Questions pill for the bottom nav, beside the leaf bar. It shows how many
 * questions are still waiting and, when it has any, expands into the rail list
 * so a question can be answered, closed or reopened without leaving the prompts
 * the agent already asked. Answers injected here re-enter as ordinary turns.
 *
 * The list expands in place rather than opening a modal: the pill already lives
 * in the pinned bottom chrome, so a row below it needs no overlay registration
 * or REPL wiring - the same shape the leaf carousel uses for its own list.
 */
export function QuestionRailBar(): React.ReactNode {
  const items = useSyncExternalStore(subscribeToQuestionRail, getQuestionRailSnapshot)
  const [expanded, setExpanded] = useState(false)
  // A resumed session brings back the questions that were still open when it
  // was left; the reader is a no-op once the rail holds live items.
  useEffect(() => {
    void hydrateQuestionRailFromTranscript()
  }, [])
  if (items.length === 0) return null
  const openCount = items.filter(item => item.state === 'open').length
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
          {items.map(item => <QuestionRailRow key={item.id} item={item} />)}
          <Box onClick={() => setExpanded(false)}><Text dimColor>Close list</Text></Box>
        </Box>
      )}
    </Box>
  )
}

/** One rail item: its text, its state, and the actions its state allows. */
function QuestionRailRow({ item }: { item: ReturnType<typeof getQuestionRailSnapshot>[number] }): React.ReactNode {
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
        {item.state === 'open' &&
          <Box onClick={() => closeQuestion(item.id)}><Text dimColor>Close</Text></Box>}
        {item.state !== 'open' &&
          <Box onClick={() => reopenQuestion(item.id)}><Text dimColor>Reopen</Text></Box>}
      </Box>
    </Box>
  )
}
