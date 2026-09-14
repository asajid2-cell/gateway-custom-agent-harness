import React from 'react'
import type { Command } from '../commands.js'
import type { ToolUseContext } from '../Tool.js'
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../types/command.js'

const USAGE = '[list|status|new [name]|new fork <session-or-leaf> [name]|fork [session-or-leaf] [name]|send <leaf> <message>|interrupt <leaf>|checkpoint <leaf> [name]|model <leaf> <model>|effort <leaf> <level>|return <leaf> <selected context>|rename <leaf> <name>|close|reopen|archive|promote <leaf>|file <leaf> <tag>|goal <leaf> [task|status|pause|resume|complete|clear]|worktree <JSON path,name,parentSessionId>]'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Names for the root conversation, which createLeaf already accepts as a
 * parent. They must be resolved as references before the family lookup: a
 * bare word that matches no leaf is otherwise treated as the new leaf's NAME,
 * and createLeaf then fills the absent parent with the CURRENT session - so
 * `fork original` run from inside a leaf forked the leaf instead of the root.
 */
const ROOT_REFS = new Set(['original', 'root'])

/** A leaf reference resolves inside the family; a UUID is also a session ref. */
async function isLeafReference(token: string, resolveLeafRef: (ref: string) => Promise<unknown>): Promise<boolean> {
  if (ROOT_REFS.has(token.toLowerCase())) return true
  if (UUID.test(token)) return true
  return Boolean(await resolveLeafRef(token))
}

/**
 * Returns the fork source argument for `fork` / `new fork`, `''` for a bare
 * fork of the current session, or null when the input is not a fork request.
 * Kept pure so the command grammar is testable without a live workspace.
 */
export function parseForkRequest(input: string): string | null {
  if (input === 'fork') return ''
  if (input.startsWith('fork ')) return input.slice(4).trim()
  if (input === 'new fork') return ''
  if (input.startsWith('new fork ')) return input.slice(8).trim()
  return null
}

export async function call(onDone: LocalJSXCommandOnDone, context: ToolUseContext & LocalJSXCommandContext, args: string): Promise<React.ReactNode> {
  if (context.agentId) { onDone('Leaf workspace is available only in the main terminal.', { display: 'system' }); return null }
  try {
    const workspace = await import('../utils/leafWorkspace.js')
    const input = args.trim()
    const options = { model: context.options?.mainLoopModel, effort: context.getAppState?.().effortValue as import('../utils/leafFamily.js').LeafMember['effort'] }

    const filing = input.match(/^file\s+(\S+)\s+([\s\S]+)$/)
    if (filing) {
      const member = await workspace.resolveLeafRef(filing[1]!)
      if (!member) throw new Error('Unknown or ambiguous leaf reference')
      await workspace.fileLeaf(member.sessionId, filing[2]!)
      onDone('Leaf filed by tag in session history and closed in this workspace; transcript and identity retained.', { display: 'system' })
      return null
    }

    const goal = input.match(/^goal\s+(\S+)(?:\s+([\s\S]+))?$/)
    if (goal) {
      const member = await workspace.resolveLeafRef(goal[1]!)
      if (!member) throw new Error('Unknown or ambiguous leaf reference')
      onDone(await workspace.setLeafGoal(member.sessionId, goal[2] ?? 'status'), { display: 'system' })
      return null
    }

    const send = input.match(/^send\s+(\S+)\s+([\s\S]+)$/)
    if (send) { onDone(await workspace.sendLeafMessage(send[1]!, send[2]!), { display: 'system' }); return null }

    const interrupt = input.match(/^interrupt\s+(\S+)$/)
    if (interrupt) { onDone(await workspace.interruptLeaf(interrupt[1]!), { display: 'system' }); return null }

    const checkpoint = input.match(/^checkpoint\s+(\S+)(?:\s+([\s\S]+))?$/)
    if (checkpoint) { onDone(await workspace.checkpointLeaf(checkpoint[1]!, checkpoint[2]?.trim() || undefined), { display: 'system' }); return null }

    const setting = input.match(/^(model|effort)\s+(\S+)\s+(\S+)$/)
    if (setting) {
      onDone(await workspace.configureLeaf(setting[2]!, setting[1] === 'model' ? { model: setting[3]! } : { effort: setting[3]! }), { display: 'system' })
      return null
    }

    const transfer = input.match(/^return\s+(\S+)\s+([\s\S]+)$/)
    if (transfer) {
      const { isInteractiveLeaf } = await import('../utils/leafTerminal.js')
      if (isInteractiveLeaf()) {
        onDone(await workspace.returnLeafContext(transfer[1]!, transfer[2]!), { display: 'system' })
        return null
      }
      const { getSessionId } = await import('../bootstrap/state.js')
      const { getClaudeConfigHomeDir } = await import('../utils/envUtils.js')
      const { createHash } = await import('node:crypto')
      const { createUserMessage } = await import('../utils/messages.js')
      const { join } = await import('node:path')
      const member = await workspace.resolveLeafRef(transfer[1]!)
      if (!member) throw new Error('Unknown or ambiguous leaf reference')
      const root = getSessionId()
      const text = transfer[2]!.trim()
      if (text.length > 64000) throw new Error('Context return too large')
      const hash = createHash('sha256').update(`${root}\0${member.sessionId}\0${text}`).digest('hex')
      const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
      const message = createUserMessage({ uuid: id, content: `Explicit context return from Leaf ${member.number}: ${member.name} (${member.sessionId}). Source ancestry is retained; this is a selected note, not a transcript merge or permission grant.\n\n${text}`, isMeta: true, origin: { kind: 'task-notification' } })
      const { doesMessageExistInSession, recordTranscript, flushSessionStorage, isTranscriptPersistenceEnabled } = await import('../utils/sessionStorage.js')
      if (!isTranscriptPersistenceEnabled()) throw new Error('Context return requires transcript persistence')
      if (await doesMessageExistInSession(root as import('node:crypto').UUID, message.uuid)) {
        onDone('This selected context was already returned; no duplicate was added.', { display: 'system' })
        return null
      }
      const { recordLeafContextReturn } = await import('../utils/leafFamily.js')
      const added = await recordLeafContextReturn(join(getClaudeConfigHomeDir(), 'leaf-families', `${root}.json`), root, id, async () => {
        await recordTranscript([...context.messages, message])
        await flushSessionStorage()
      })
      if (!added) {
        onDone('This selected context was already returned; no duplicate was added.', { display: 'system' })
        return null
      }
      if (getSessionId() !== root) throw new Error('Session changed during context return')
      context.setMessages(previous => previous.some(item => item.uuid === id) ? previous : [...previous, message])
      onDone('Selected leaf context saved to the original transcript; identical returns are deduplicated across restart and compaction.', { display: 'system' })
      return null
    }

    const change = input.match(/^(rename|close|archive|promote|reopen)\s+(\S+)(?:\s+([\s\S]+))?$/)
    if (change) {
      const action = change[1]!
      if (action === 'rename' && !change[3]?.trim()) throw new Error('Name required')
      const member = await workspace.resolveLeafRef(change[2]!)
      if (!member) throw new Error('Unknown or ambiguous leaf reference')
      await workspace.changeLeaf(member.sessionId, action === 'rename' ? { name: change[3]!.trim() } : { status: action === 'close' ? 'closed' : action === 'archive' ? 'archived' : action === 'reopen' ? 'open' : 'promoted', ...(change[3]?.trim() ? { name: change[3].trim() } : {}) })
      onDone(`Leaf ${action} recorded; transcript and ancestry retained.`, { display: 'system' })
      return null
    }

    if (input.startsWith('worktree ')) {
      const selection = JSON.parse(input.slice(9)) as { path?: unknown; name?: unknown; parentSessionId?: unknown }
      if (typeof selection.path !== 'string' || (selection.name !== undefined && typeof selection.name !== 'string') || (selection.parentSessionId !== undefined && typeof selection.parentSessionId !== 'string')) throw new Error('Invalid worktree selection')
      await workspace.createLeaf(selection.name as string | undefined, selection.parentSessionId as string | undefined, selection.path)
      onDone('Worktree leaf ready. Select it in the session bar.', { display: 'system' })
      return null
    }

    if (input === 'list' || input === 'status' || input === 'ls') {
      onDone(await workspace.listLeaves(), { display: 'system' })
      return null
    }

    // `new fork <ref> [name]` and `fork <ref> [name]` both fork an existing
    // session or leaf; bare `fork` forks the current session. A token that is
    // not a leaf/session reference is treated as the new leaf's name.
    const forkRequest = parseForkRequest(input)
    if (forkRequest !== null) {
      if (!forkRequest) await workspace.createLeaf(undefined, undefined, undefined, options)
      else {
        const [first, ...tail] = forkRequest.split(/\s+/)
        if (await isLeafReference(first!, workspace.resolveLeafRef)) await workspace.createLeaf(tail.join(' ').trim() || undefined, first, undefined, options)
        else await workspace.createLeaf(forkRequest, undefined, undefined, options)
      }
    } else if (input === 'new' || input.startsWith('new ')) {
      await workspace.createLeaf(input.slice(3).trim() || undefined, undefined, undefined, { ...options, fresh: true })
    } else if (!input) {
      await workspace.restoreLeafWorkspace()
      const { LeafCreateMenu } = await import('../components/LeafWorkspaceDialog.js')
      return <LeafCreateMenu onDone={() => onDone()} model={options.model} effort={options.effort} />
    } else {
      onDone(`Usage: /leaf ${USAGE}`, { display: 'system' })
      return null
    }
    onDone('Leaf ready. Select it in the session bar.', { display: 'system' })
    return null
  } catch (error) {
    // The previous blanket catch hid the real cause behind one generic line,
    // which made unreliable starts impossible to diagnose. Error messages here
    // are locally generated (spawn/fs/control failures), never model output.
    const reason = error instanceof Error ? error.message.replace(/\s+/g, ' ').trim().slice(0, 300) : ''
    onDone(reason ? `Leaf operation failed: ${reason}` : 'Leaf operation failed. Its saved transcript is retained; no completion or successful launch is assumed.', { display: 'system' })
    return null
  }
}

export default { type: 'local-jsx', name: 'leaf', description: 'Open independent concurrent leaf chats', immediate: true, argumentHint: USAGE, load: async () => ({ call }) } satisfies Command
