import { useEffect, useRef } from 'react'
import { getSessionId } from '../bootstrap/state.js'
import type { Message } from '../types/message.js'
import { useAppState, useSetAppState } from '../state/AppState.js'
import { useMainLoopModel } from './useMainLoopModel.js'
import { isInteractiveLeaf, registerLeafTerminalControls, requestLeafWorkspace, sendLeafTerminal, writeLeafInput } from '../utils/leafTerminal.js'
import { PASTE_END, PASTE_START } from '../ink/termio/csi.js'
import { flushSessionStorage, getTranscriptPath, recordTranscript, saveSessionName } from '../utils/sessionStorage.js'
import { parseEffortValue } from '../utils/effort.js'
import { registerLeafContextReturn } from '../utils/leafWorkspace.js'

export function useLeafTerminalSession(messages: Message[], draft: string, status: 'idle' | 'busy' | 'waiting', interrupt: () => void, canCheckpoint: () => boolean, setMessages: (update: (previous: Message[]) => Message[]) => void): void {
  const latest = useRef({ messages, draft, status, interrupt, canCheckpoint, setMessages })
  latest.current = { messages, draft, status, interrupt, canCheckpoint, setMessages }
  const setAppState = useSetAppState()
  const model = useMainLoopModel()
  const effort = useAppState(state => state.effortValue)
  const sessionId = getSessionId()
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
          if (latest.current.status !== 'idle') throw new Error('Leaf is not idle')
          writeLeafInput(prompt.includes('\n') ? `${PASTE_START}${prompt}${PASTE_END}\r` : `${prompt}\r`)
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
  useEffect(() => {
    if (isInteractiveLeaf()) void requestLeafWorkspace('settings', [getSessionId(), { model, effort }]).catch(() => {})
  }, [model, effort])
}
