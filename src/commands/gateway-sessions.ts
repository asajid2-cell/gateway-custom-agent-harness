import React from 'react'
import type { Command } from '../commands.js'
import type { ToolUseContext } from '../Tool.js'
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../types/command.js'
import { getSessionId } from '../bootstrap/state.js'
import { getGatewaySessionRuntime } from '../utils/gatewaySessionRuntime.js'

export async function call(onDone: LocalJSXCommandOnDone, context: ToolUseContext & LocalJSXCommandContext, args: string): Promise<React.ReactNode> {
  const runtime = getGatewaySessionRuntime(getSessionId())
  if (!runtime || context.agentId) {
    onDone('Gateway session communication is unavailable in this runtime.', { display: 'system' })
    return null
  }
  const input = args.trim()
  try {
    if (input === 'panel') {
      const { GatewaySessionsDialog } = await import('../components/GatewaySessionsDialog.js')
      return React.createElement(GatewaySessionsDialog, { onDone: () => onDone() })
    }
    let result: string
    if (!input || input === 'list') {
      const peers = await runtime.list()
      result = peers.map(p => `${p.sessionId}  ${JSON.stringify(p.name)}  ${p.status}  ${JSON.stringify(p.cwd)}`).join('\n') || 'No live sessions.'
    } else if (input === 'start' || input.startsWith('start ')) {
      if (runtime.transport.peer.status !== 'idle') throw new Error('Wait for the current turn before starting a session')
      const name = input.slice(5).trim()
      if (name.length > 200) throw new Error('Session name too long')
      const { flushSessionStorage, saveSessionName, getTranscriptPath } = await import('../utils/sessionStorage.js')
      const { clearConversation } = await import('./clear/conversation.js')
      await flushSessionStorage()
      await clearConversation(context)
      if (name) saveSessionName(getSessionId(), name, getTranscriptPath())
      result = `Started ${getSessionId()} in this terminal. The previous transcript is retained; use /sessions resume <id> to return.`
    } else if (input.startsWith('history ')) {
      const { searchSessionsByCustomTitle, getSessionIdFromLog } = await import('../utils/sessionStorage.js')
      const logs = await searchSessionsByCustomTitle(input.slice(8), { limit: 20 })
      result = logs.map(log => `${getSessionIdFromLog(log)}  ${JSON.stringify(log.customTitle)}  historical (not live discovery)`).join('\n') || 'No matching historical titles in this repository.'
    } else if (/^resume\s+\S+$/.test(input)) {
      if (runtime.transport.peer.status !== 'idle') throw new Error('Wait for the current turn before resuming a session')
      const id = input.split(/\s+/)[1]!
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('Exact session ID required')
      if ((await runtime.list()).some(peer => peer.sessionId === id)) {
        result = 'Session is already active. Use its existing terminal or send it a message; no second writer was started.'
      } else {
        const resume = await import('./resume/resume.js')
        return await resume.call(onDone, context, id)
      }
    } else if (/^watch-idle\s+\S+$/.test(input)) {
      result = JSON.stringify(await runtime.transport.watchIdle(input.split(/\s+/)[1]!))
    } else if (/^receipt\s+\S+\s+\S+$/.test(input)) {
      const [, peerId, messageId] = input.split(/\s+/)
      result = JSON.stringify(await runtime.transport.receipt(peerId!, messageId!))
    } else if (input === 'inbox') {
      result = runtime.transport.inbox().map(r => `${r.message.id}  ${r.state}  from ${JSON.stringify(r.senderName)} (${r.message.fromSessionId})\n${r.message.summary}\n${r.message.text}`).join('\n\n') || 'Inbox is empty.'
    } else if (input === 'messages' || input.startsWith('messages ')) {
      const peerId = input.slice(8).trim()
      const history = runtime.transport.historyEntries().filter(entry => !peerId || entry.message.fromSessionId === peerId || entry.message.toSessionId === peerId)
      result = history.map(entry => `${entry.recordedAt}  ${entry.direction}  ${entry.status}  ${entry.message.id}  ${entry.peerName}\n${entry.message.summary}\n${entry.message.text}${entry.error ? `\nerror: ${entry.error}` : ''}`).join('\n\n') || 'No peer message history.'
    } else if (['accept', 'hold', 'refuse'].includes(input)) {
      await runtime.setPolicy(input as 'accept' | 'hold' | 'refuse')
      result = `Inbound message policy: ${input}.`
    } else {
      const send = input.match(/^send\s+(\S+)\s+([\s\S]+)$/)
      if (!send) result = 'Usage: /sessions [list|panel|start [name]|history <title>|resume <id>|inbox|messages [peer-id]|accept|hold|refuse|watch-idle <id>|receipt <peer-id> <message-id>|send <id> <message>]'
      else result = JSON.stringify(await runtime.transport.send(send[1]!, send[2]!, send[2]!.slice(0, 200)))
    }
    onDone(result, { display: 'system' })
  } catch {
    onDone('Session operation failed. Check the exact session ID, peer availability and message size; no delivery is assumed.', { display: 'system' })
  }
  return null
}

export default {
  type: 'local-jsx', name: 'sessions', description: 'Discover Gateway sessions and control peer messaging', immediate: true,
  argumentHint: '[list|panel|start [name]|history <title>|resume <id>|inbox|messages [peer-id]|accept|hold|refuse|watch-idle <id>|receipt <peer-id> <message-id>|send <id> <message>]',
  load: async () => ({ call }),
} satisfies Command
