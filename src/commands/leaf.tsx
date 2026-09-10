import React from 'react'
import type { Command } from '../commands.js'
import type { ToolUseContext } from '../Tool.js'
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../types/command.js'

export async function call(onDone: LocalJSXCommandOnDone, context: ToolUseContext & LocalJSXCommandContext, args: string): Promise<React.ReactNode> {
  if (context.agentId) { onDone('Leaf workspace is available only in the main terminal.', { display: 'system' }); return null }
  try {
    const { createLeaf, restoreLeafWorkspace, changeLeaf } = await import('../utils/leafWorkspace.js')
    const input = args.trim()
    const filing = input.match(/^file\s+(\S+)\s+([\s\S]+)$/)
    if (filing) {
      const { fileLeaf } = await import('../utils/leafWorkspace.js')
      await fileLeaf(filing[1]!, filing[2]!)
      onDone('Leaf filed by tag in session history and closed in this workspace; transcript and identity retained.', { display: 'system' })
      return null
    }
    const goal = input.match(/^goal\s+(\S+)(?:\s+([\s\S]+))?$/)
    if (goal) {
      const { setLeafGoal } = await import('../utils/leafWorkspace.js')
      onDone(await setLeafGoal(goal[1]!, goal[2] ?? 'status'), { display: 'system' })
      return null
    }
    const setting = input.match(/^(model|effort)\s+(\S+)\s+(\S+)$/)
    if (setting) {
      const { getLeafViews } = await import('../utils/leafWorkspace.js')
      const view = getLeafViews().find(item => item.member.sessionId === setting[2])
      if (!view || view.process.getState() !== 'idle') throw new Error('Leaf must be idle')
      if (setting[1] === 'model') await view.process.setModel(setting[3]!)
      else {
        if (!['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode'].includes(setting[3]!)) throw new Error('Invalid effort')
        await view.process.setEffort(setting[3]!)
      }
      const { saveLeafSettings } = await import('../utils/leafWorkspace.js')
      await saveLeafSettings(view.member.sessionId, setting[1] === 'model' ? { model: setting[3]! } : { effort: setting[3] as NonNullable<typeof view.member.effort> })
      onDone(`Leaf ${setting[1]} updated and saved for restart.`, { display: 'system' })
      return null
    }
    const transfer = input.match(/^return\s+(\S+)\s+([\s\S]+)$/)
    if (transfer) {
      const { getSessionId } = await import('../bootstrap/state.js')
      const { getClaudeConfigHomeDir } = await import('../utils/envUtils.js')
      const { readLeafFamily } = await import('../utils/leafFamily.js')
      const { join } = await import('node:path')
      const { createHash } = await import('node:crypto')
      const { createUserMessage } = await import('../utils/messages.js')
      const root = getSessionId()
      const family = await readLeafFamily(join(getClaudeConfigHomeDir(), 'leaf-families', `${root}.json`), root)
      const member = family.members.find(item => item.sessionId === transfer[1])
      if (!member) throw new Error('Unknown leaf')
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
      await changeLeaf(change[2]!, action === 'rename' ? { name: change[3]!.trim() } : { status: action === 'close' ? 'closed' : action === 'archive' ? 'archived' : action === 'reopen' ? 'open' : 'promoted', ...(change[3]?.trim() ? { name: change[3].trim() } : {}) })
      onDone(`Leaf ${action} recorded; transcript and ancestry retained.`, { display: 'system' })
      return null
    }
    if (input.startsWith('worktree ')) {
      const selection = JSON.parse(input.slice(9)) as { path?: unknown; name?: unknown; parentSessionId?: unknown }
      if (typeof selection.path !== 'string' || (selection.name !== undefined && typeof selection.name !== 'string') || (selection.parentSessionId !== undefined && typeof selection.parentSessionId !== 'string')) throw new Error('Invalid worktree selection')
      await createLeaf(selection.name as string | undefined, selection.parentSessionId as string | undefined, selection.path)
      onDone('Worktree leaf ready. Select it in the session bar.', { display: 'system' })
      return null
    }
    const nested = input.match(/^fork\s+(\S+)(?:\s+([\s\S]+))?$/)
    const options = { model: context.options?.mainLoopModel, effort: context.getAppState?.().effortValue as import('../utils/leafFamily.js').LeafMember['effort'] }
    if (nested) await createLeaf(nested[2]?.trim(), nested[1] === 'original' ? undefined : nested[1], undefined, options)
    else if (input === 'fork') await createLeaf(undefined, undefined, undefined, options)
    else if (input === 'new' || input.startsWith('new ')) await createLeaf(input.slice(3).trim() || undefined, undefined, undefined, { ...options, fresh: true })
    else if (!input || input === 'list') {
      await restoreLeafWorkspace()
      const { LeafCreateMenu } = await import('../components/LeafWorkspaceDialog.js')
      return <LeafCreateMenu onDone={() => onDone()} model={options.model} effort={options.effort} />
    }
    else { onDone('Usage: /leaf [new [name]|fork <parent-id> [name]|worktree <JSON path,name,parentSessionId>|list|goal <id> [task|status|pause|resume|complete|clear]|rename <id> <name>|close <id>|reopen <id>|archive <id>|file <id> <tag>|promote <id>|return <id> <selected context>]', { display: 'system' }); return null }
    onDone('Leaf ready. Select it in the session bar.', { display: 'system' })
    return null
  } catch {
    onDone('Leaf could not start. Its saved transcript is retained; no completion or successful launch is assumed.', { display: 'system' })
    return null
  }
}

export default { type: 'local-jsx', name: 'leaf', description: 'Open independent concurrent leaf chats', argumentHint: '[new [name]|fork <parent-id> [name]|worktree <JSON path,name,parentSessionId>|list|goal <id> [task|status|pause|resume|complete|clear]|rename <id> <name>|close <id>|reopen <id>|archive <id>|file <id> <tag>|promote <id>|return <id> <selected context>]', load: async () => ({ call }) } satisfies Command
