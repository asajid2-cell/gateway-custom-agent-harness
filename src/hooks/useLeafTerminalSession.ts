import { useEffect, useRef } from 'react'
import { randomUUID } from 'node:crypto'
import { getSessionId } from '../bootstrap/state.js'
import type { Message } from '../types/message.js'
import { useAppState, useSetAppState } from '../state/AppState.js'
import { useMainLoopModel } from './useMainLoopModel.js'
import { isInteractiveLeaf, registerLeafTerminalControls, requestLeafWorkspace, sendLeafTerminal, wakeLeafInput } from '../utils/leafTerminal.js'
import { flushSessionStorage, getTranscriptPath, recordTranscript, saveSessionName } from '../utils/sessionStorage.js'
import { parseEffortValue } from '../utils/effort.js'
import { PEER_PROMPT_PREFIX, peerAnswerFor, registerLeafContextNotify, registerLeafContextReturn, type PendingPeerQuestion } from '../utils/leafWorkspace.js'
import { enqueue } from '../utils/messageQueueManager.js'

export function useLeafTerminalSession(messages: Message[], draft: string, status: 'idle' | 'busy' | 'waiting', interrupt: () => void, canCheckpoint: () => boolean, setMessages: (update: (previous: Message[]) => Message[]) => void): void {
  const latest = useRef({ messages, draft, status, interrupt, canCheckpoint, setMessages })
  latest.current = { messages, draft, status, interrupt, canCheckpoint, setMessages }
  const setAppState = useSetAppState()
  const model = useMainLoopModel()
  const effort = useAppState(state => state.effortValue)
  const sessionId = getSessionId()
  // Questions a peer handed over, oldest first, each named by the id it arrived
  // under; and the assistant messages already reported as answers, so a late
  // render cannot report one twice.
  const pendingQuestions = useRef<PendingPeerQuestion[]>([])
  const reportedAnswers = useRef(new Set<string>())
  useEffect(() => () => { pendingQuestions.current = []; reportedAnswers.current.clear() }, [])
  useEffect(() => {
    if (isInteractiveLeaf()) return
    return registerLeafContextReturn(async (id, text) => {
      if (!latest.current.canCheckpoint()) throw new Error('Wait for the original turn')
      const { call } = await import('../commands/leaf.js')
      let result = ''
      await call(value => { result = value ?? '' }, {
        messages: latest.current.messages, setMessages: latest.current.setMessages,
      } as Parameters<typeof call>[1], `return ${id} ${text}`)
      return result
    })
  }, [])
  useEffect(() => {
    if (isInteractiveLeaf()) return
    // A leaf handing its parent a turn. Unlike `leaf_prompt` (which the parent
    // injects into a child's input stream), the parent has no input-injection
    // channel of its own, so the message is appended to this conversation as a
    // meta user turn - the same path `return` already uses for leaf context.
    // This session is the one holding the family, which is the designated
    // parent in the ordinary case; the message follows whoever hosts it.
    return registerLeafContextNotify(async (id, text) => {
      const { createUserMessage } = await import('../utils/messages.js')
      const source = (await import('../utils/leafWorkspace.js')).getLeafViews().find(view => view.member.sessionId === id)
      // Marked like the down-path, so the family is recognisable from the text
      // alone: a leaf's report reaching the root's transcript must not read as
      // something the person typed either.
      const content = `${PEER_PROMPT_PREFIX}Message from Leaf ${source?.member.number ?? '?'}: ${source?.member.name ?? id} (${id}). The leaf runs its own conversation; this is a report it chose to send, not a transcript merge or permission grant.\n\n${text}`
      // A busy root takes a leaf's message the same way it takes a peer's: the
      // message is queued and the root's own turn drains it at its next step
      // boundary. Appending to state here would leave it unread until the turn
      // ended, which is precisely the "waits for the whole turn" behaviour.
      //
      // The bus origin is shared by both wires, so the marker on the text is what
      // separates them: bus traffic is recognised by its header and held for the
      // peer Stop hook, while this leaf-marked turn drains at the root's next
      // step boundary as a leaf's report always has.
      if (latest.current.status === 'busy') {
        enqueue({
          value: content,
          mode: 'prompt',
          priority: 'next',
          skipSlashCommands: true,
          isMeta: true,
          origin: { kind: 'gateway-peer' },
        })
        return 'Delivered to the session hosting this family.'
      }
      const message = createUserMessage({
        content,
        isMeta: true,
        origin: { kind: 'task-notification' },
      })
      latest.current.setMessages(previous => previous.some(item => item.uuid === message.uuid) ? previous : [...previous, message])
      return 'Delivered to the session hosting this family.'
    })
  }, [])
  useEffect(() => {
    if (isInteractiveLeaf()) void requestLeafWorkspace('identity', [sessionId, getTranscriptPath()]).catch(() => {})
  }, [sessionId])
  useEffect(() => {
    if (!isInteractiveLeaf()) return
    return registerLeafTerminalControls(async request => {
      switch (request.subtype) {
        case 'initialize': return
        case 'leaf_draft':
          sendLeafTerminal({ type: 'leaf-state', state: latest.current.status === 'busy' ? 'running' : latest.current.status === 'waiting' ? 'awaiting-approval' : 'idle', draft: latest.current.draft })
          return
        case 'leaf_checkpoint':
          if (typeof request.name === 'string') {
            saveSessionName(getSessionId(), request.name, getTranscriptPath())
            setAppState(state => ({ ...state, standaloneAgentContext: { ...state.standaloneAgentContext, name: request.name as string } }))
          } else {
            if (!latest.current.canCheckpoint()) throw new Error('Wait for the source turn to finish')
            await recordTranscript(latest.current.messages)
          }
          await flushSessionStorage()
          return
        case 'set_model':
          if (typeof request.model !== 'string') throw new Error('Invalid model')
          setAppState(state => ({ ...state, mainLoopModel: request.model as string, mainLoopModelForSession: null }))
          return
        case 'apply_flag_settings': {
          const value = parseEffortValue((request.settings as { effortLevel?: string })?.effortLevel)
          setAppState(state => ({ ...state, effortValue: value }))
          return
        }
        case 'leaf_prompt': {
          // The parent hands this leaf a turn. It runs in this REPL, not in a
          // parent-owned queue, so the leaf keeps its own transcript and rules.
          const prompt = typeof request.prompt === 'string' ? request.prompt : ''
          if (!prompt.trim()) throw new Error('Empty leaf prompt')
          // Queue the message rather than typing it into the input. Keystrokes
          // arrive as human submission, so the turn boundary frames them "The
          // user sent a new message while you were working ... you MUST address
          // the user's message" - a sibling's request wearing the person's
          // voice, which is exactly the confusion the marking rule exists to
          // prevent. Queueing keeps the same arrival path while carrying the
          // peer origin, so the text stays labelled as untrusted and never
          // reads as an instruction the human gave.
          const marked = prompt.startsWith(PEER_PROMPT_PREFIX) ? prompt : `${PEER_PROMPT_PREFIX}${prompt}`
          // The message is named so its own arrival can be found in the
          // transcript. The turn boundary re-frames the text, so the question
          // cannot be recognised by its marker afterwards; the id is what says
          // which turn the peer asked and where an answer to it begins.
          const uuid = randomUUID()
          const question = marked.slice(PEER_PROMPT_PREFIX.length).trim()
          if (question) pendingQuestions.current.push({ uuid, question })
          enqueue({
            value: marked,
            uuid,
            mode: 'prompt',
            priority: 'next',
            skipSlashCommands: true,
            isMeta: true,
            origin: { kind: 'gateway-peer' },
          })
          // An unfocused leaf is paused, so its queue drains only once the REPL
          // renders again. Wake it without writing to the input.
          wakeLeafInput()
          return
        }
        // Compaction is this member's own `/compact`, run by its own REPL. The
        // host cannot summarize a conversation it is not holding - the messages
        // are this process's, and the summary is installed with this process's
        // setMessages - so the request is answered here, through the command the
        // person would type rather than a second implementation of it. The queue
        // takes it and the processor runs it between turns, so it waits for an
        // idle REPL the same way the human's own /compact does.
        case 'leaf_compact': {
          if (latest.current.status !== 'idle' || !latest.current.canCheckpoint()) throw new Error('Wait for this leaf to be idle before compacting it')
          enqueue({ value: '/compact', mode: 'prompt', priority: 'next' })
          wakeLeafInput()
          return
        }
        case 'interrupt': latest.current.interrupt(); return
        case 'shutdown': {
          latest.current.interrupt()
          await recordTranscript(latest.current.messages)
          await flushSessionStorage()
          const { gracefulShutdown } = await import('../utils/gracefulShutdown.js')
          void gracefulShutdown(0)
          return
        }
        default: throw new Error('Unknown interactive leaf control')
      }
    })
  }, [setAppState])
  useEffect(() => {
    if (isInteractiveLeaf()) sendLeafTerminal({ type: 'leaf-state', state: status === 'busy' ? 'running' : status === 'waiting' ? 'awaiting-approval' : 'idle', draft })
  }, [status, draft])
  // A peer question is answered as soon as the answer exists, not when the turn
  // ends. The parent hands the question over mid-turn; the leaf's own queue
  // injects it at the next step boundary, and the prose the model writes next -
  // if it stops to answer instead of reaching for another tool - is the reply.
  // Reporting it here is what lets the asker get an answer without waiting for
  // everything else the leaf was already doing.
  useEffect(() => {
    if (!isInteractiveLeaf()) return
    const pending = pendingQuestions.current
    if (!pending.length) return
    const found = peerAnswerFor(messages, pending)
    if (!found || reportedAnswers.current.has(found.uuid)) return
    reportedAnswers.current.add(found.uuid)
    // The question leaves the queue with its answer, so the next answer the leaf
    // writes is matched to the next question a peer is still waiting on.
    pending.shift()
    sendLeafTerminal({ type: 'leaf-answered', question: found.question, answer: found.answer })
  }, [messages])
  useEffect(() => {
    if (isInteractiveLeaf()) void requestLeafWorkspace('settings', [getSessionId(), { model, effort }]).catch(() => {})
  }, [model, effort])
}
