import React from 'react'
import type { Command } from '../commands.js'
import type { ToolUseContext } from '../Tool.js'
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../types/command.js'
import { getSessionId } from '../bootstrap/state.js'
import { getGatewaySessionRuntime } from '../utils/gatewaySessionRuntime.js'
import { formatGatewayPeerLine } from '../utils/gatewaySessionProtocol.js'

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
      const self = peers.find(p => p.sessionId === getSessionId())
      const others = peers.filter(p => p.sessionId !== getSessionId())
      const render = (peer: (typeof peers)[number]) => formatGatewayPeerLine(peer)
      // Purpose leads each entry: it is the field that answers "which session is
      // doing what". Identity alone was never enough to coordinate with anyone.
      result = [
        self ? `This session:\n${render(self)}` : '',
        others.length ? `Other live sessions (${others.length}):\n${others.map(render).join('\n')}` : 'No other live sessions.',
        // Listing sessions is only useful if it leads somewhere. There is no
        // lock service or merge bot behind this: coordination is just talking,
        // so name the next move instead of leaving it implied.
        others.length ? 'Coordination is conversation: /sessions send <id> <message> to talk to one, agree who owns which files before editing shared ones, and cut your own worktree when you would collide.' : '',
      ].filter(Boolean).join('\n\n')
    } else if (input === 'purpose' || input.startsWith('purpose ')) {
      const text = input.slice(7).trim()
      if (!text) {
        result = `This session's stated intent: ${runtime.transport.peer.purpose.trim() || 'none stated'}\nSet it with /sessions purpose <what this session is working on>.`
      } else if (text.length > 1000) {
        throw new Error('Purpose must be 1000 characters or fewer')
      } else {
        await runtime.transport.update({ purpose: text })
        result = `This session now advertises: ${text}\nOther sessions see it via /sessions list.`
      }
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
      // No status pre-check: this command is a local-jsx command, so dispatching
      // it briefly publishes 'running' (isLoading covers queryGuard's dispatching
      // state) and the check would reject the very resume it is performing.
      // resume.call funnels into context.resume, which holds the authoritative
      // mid-turn guard in the REPL.
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
      if (!send) result = 'Usage: /sessions [list|panel|start [name]|history <title>|resume <id>|inbox|messages [peer-id]|accept|hold|refuse|watch-idle <id>|receipt <peer-id> <message-id>|purpose [what this session is working on]|send <id|leaf #|leaf name> <message>]'
      else {
        // Peer transport needs an exact session ID; a leaf number or name is
        // resolved through the family so session comms addresses leaves too.
        const { resolveLeafRef, sendLeafMessage } = await import('../utils/leafWorkspace.js')
        const leaf = await resolveLeafRef(send[1]!).catch(() => undefined)
        result = leaf
          ? await sendLeafMessage(leaf.sessionId, send[2]!)
          : JSON.stringify(await runtime.transport.send(send[1]!, send[2]!, send[2]!.slice(0, 200)))
      }
    }
    onDone(result, { display: 'system' })
  } catch (error) {
    // A blanket catch here reported "peer unavailable" for every failure, so a
    // wrong address, a dead peer and an oversized message were indistinguishable.
    // Peer reasons are locally generated (registration/transport), never model output.
    const reason = error instanceof Error ? error.message.replace(/\s+/g, ' ').trim().slice(0, 300) : ''
    onDone(reason
      ? `Session operation failed: ${reason}`
      : 'Session operation failed. Check the exact session ID, peer availability and message size; no delivery is assumed.', { display: 'system' })
  }
  return null
}

export default {
  type: 'local-jsx', name: 'sessions', description: 'Discover Gateway sessions and control peer messaging', immediate: true,
  argumentHint: '[list|panel|start [name]|history <title>|resume <id>|inbox|messages [peer-id]|accept|hold|refuse|watch-idle <id>|receipt <peer-id> <message-id>|purpose [what this session is working on]|send <id|leaf #|leaf name> <message>]',
  load: async () => ({ call }),
} satisfies Command
