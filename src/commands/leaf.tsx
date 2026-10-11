import React from 'react'
import { LEAF_CREATOR_ALIASES, LEAF_HEAD_ALIASES } from '../utils/leafAliases.js'
import type { Command } from '../commands.js'
import type { ToolUseContext } from '../Tool.js'
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../types/command.js'

const USAGE = '[list|status|new [name]|new fork <session-or-leaf> [name]|fork [session-or-leaf] [name]|send <leaf> <message>|interrupt <leaf>|read [leaf] [tail=N] [since=<cursor>]|checkpoint <leaf> [label]|checkpoints [leaf]|checkpoint-drop <#n|label>|checkpoint-purge <#n|label>|seed [source] [name]|seedling <leaf> [name]|merge <seedling> [full|ledger]|compact <leaf>|model <leaf> <model>|effort <leaf> <level>|return <leaf> <selected context>|rename <leaf> <name>|head <leaf>|heir <leaf>|driver <leaf> [leaf...]|close [leaf|me]|reopen|archive <leaf>|promote <leaf>|file <leaf> <tag>|goal <leaf> [task|status|pause|resume|complete|clear]|worktree <JSON path,name,parentSessionId>]'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Names for the family's head conversation, which createLeaf already accepts as
 * a source. They must be resolved as references before the family lookup: a
 * bare word that matches no leaf is otherwise treated as the new leaf's NAME,
 * and createLeaf then fills the absent source with the CURRENT session - so
 * `fork original` run from inside a leaf forked the leaf instead of the family's
 * head. `patriarch` is the same reference the workspace accepts, so the grammar
 * and the workspace agree on every name for it. The set comes from the one
 * exported alias constant rather than a second copy, so the grammar cannot drift
 * from what the workspace resolves.
 */
const ROOT_REFS = new Set<string>([...LEAF_CREATOR_ALIASES, ...LEAF_HEAD_ALIASES])

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

/**
 * The `read` grammar: an optional leaf reference, plus `tail=N` and
 * `since=<cursor>` in any order. A bare `read` is the family digest. Kept pure
 * so the grammar is testable without a live workspace.
 */
export function parseReadRequest(input: string): { reference?: string; options: { tail?: number; since?: string } } | null {
  if (input !== 'read' && !input.startsWith('read ')) return null
  const request: { reference?: string; options: { tail?: number; since?: string } } = { options: {} }
  for (const token of input.slice(4).trim().split(/\s+/).filter(Boolean)) {
    const tail = token.match(/^tail=(\d+)$/)
    if (tail) { request.options.tail = Number(tail[1]); continue }
    const since = token.match(/^since=(\S+)$/)
    if (since) { request.options.since = since[1]!; continue }
    // One reference: a second bare token is a mistake, not another leaf.
    if (request.reference) throw new Error(`Usage: /leaf ${USAGE}`)
    request.reference = token
  }
  return request
}

/**
 * The `merge` grammar: a seedling, plus an optional fidelity. Only `full` and
 * `ledger` are accepted, and a rejected word is refused here rather than being
 * passed on as a name. Kept pure so the grammar is testable without a live
 * workspace.
 */
export function parseMergeRequest(input: string): { seedling: string; fidelity?: 'full' | 'ledger' } | null {
  if (input !== 'merge' && !input.startsWith('merge ')) return null
  const [seedling, fidelity, ...rest] = input.slice(6).trim().split(/\s+/).filter(Boolean)
  if (!seedling || rest.length) throw new Error(`Usage: /leaf ${USAGE}`)
  if (fidelity && fidelity !== 'full' && fidelity !== 'ledger') throw new Error('Merge fidelity must be full or ledger')
  return { seedling, ...(fidelity ? { fidelity: fidelity as 'full' | 'ledger' } : {}) }
}

/**
 * The `seedling` grammar: the seed to fork, plus its name. Kept pure so the
 * grammar is testable without a live workspace.
 */
export function parseSeedlingRequest(input: string): { seed: string; name?: string } | null {
  if (!input.startsWith('seedling ')) return null
  const [seed, ...tail] = input.slice(9).trim().split(/\s+/)
  if (!seed) throw new Error(`Usage: /leaf ${USAGE}`)
  return { seed, ...(tail.length ? { name: tail.join(' ') } : {}) }
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
      const promoted = await workspace.fileLeaf(member.sessionId, filing[2]!)
      onDone(`Leaf filed by tag in session history and closed in this workspace; transcript and identity retained.${promoted ? ` ${promoted}` : ''}`, { display: 'system' })
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

    // A seed is a fork that is also a merge target, and a seedling is a bounded
    // fork of one. Both are ordinary leaves once made, so the grammar only has to
    // name the source; the role travels with the member and is what a merge reads.
    // As with `fork`, a token that answers to no leaf or session is the name, not
    // the source, so `seed my-seed` names a fork of the current conversation.
    const seedling = parseSeedlingRequest(input)
    if (seedling) {
      const view = await workspace.createSeedling(seedling.seed, seedling.name)
      onDone(`Leaf #${view.member.number} ${view.member.name} is a seedling of its seed; merge it back with /leaf merge ${view.member.number}.`, { display: 'system' })
      return null
    }

    if (input === 'seed' || input.startsWith('seed ')) {
      const rest = input.slice(4).trim()
      const [first, ...tail] = rest ? rest.split(/\s+/) : []
      const source = first && await isLeafReference(first, workspace.resolveLeafRef) ? first : undefined
      const view = await workspace.createSeed(source, source ? tail.join(' ').trim() || undefined : rest || undefined)
      onDone(`Leaf #${view.member.number} ${view.member.name} is a seed; /leaf seedling ${view.member.number} forks a bounded job off it.`, { display: 'system' })
      return null
    }

    const merge = parseMergeRequest(input)
    if (merge) {
      onDone(await workspace.mergeSeedling(merge.seedling, merge.fidelity ? { fidelity: merge.fidelity } : {}), { display: 'system' })
      return null
    }

    const compacting = input.match(/^compact\s+(\S+)$/)
    if (compacting) { onDone(await workspace.compactLeaf(compacting[1]!), { display: 'system' }); return null }

    const checkpoint = input.match(/^checkpoint\s+(\S+)(?:\s+([\s\S]+))?$/)
    if (checkpoint) { onDone(await workspace.checkpointLeaf(checkpoint[1]!, checkpoint[2]?.trim() || undefined), { display: 'system' }); return null }

    const checkpoints = input.match(/^checkpoints(?:\s+(\S+))?$/)
    if (checkpoints) { onDone(await workspace.listLeafCheckpoints(checkpoints[1]), { display: 'system' }); return null }

    const checkpointChange = input.match(/^checkpoint-(drop|purge)\s+(#?\S+)$/)
    if (checkpointChange) {
      onDone(
        checkpointChange[1] === 'drop'
          ? await workspace.dropLeafCheckpoint(checkpointChange[2]!)
          : await workspace.purgeLeafCheckpoint(checkpointChange[2]!),
        { display: 'system' },
      )
      return null
    }

    const head = input.match(/^head\s+(\S+)$/)
    if (head) {
      const member = await workspace.resolveLeafRef(head[1]!)
      if (!member) throw new Error('Unknown or ambiguous leaf reference')
      onDone(await workspace.conferPatriarch(member.sessionId), { display: 'system' })
      return null
    }

    const heir = input.match(/^heir\s+(\S+)$/)
    if (heir) {
      const member = await workspace.resolveLeafRef(heir[1]!)
      if (!member) throw new Error('Unknown or ambiguous leaf reference')
      onDone(await workspace.conferHeir(member.sessionId), { display: 'system' })
      return null
    }

    // `driver <driver-leaf> [leaf...]`: one command names the driver and the
    // leaves it drives, so the role and its scope are written together. A bare
    // `driver <driver-leaf>` clears the scope, leaving a driver that drives
    // nothing yet.
    const driver = input.match(/^driver\s+(\S+)((?:\s+\S+)*)$/)
    if (driver) {
      const member = await workspace.resolveLeafRef(driver[1]!)
      if (!member) throw new Error('Unknown or ambiguous leaf reference')
      const leafIds: string[] = []
      for (const reference of driver[2]!.trim().split(/\s+/).filter(Boolean)) {
        const driven = await workspace.resolveLeafRef(reference)
        if (!driven) throw new Error(`Unknown or ambiguous leaf reference: ${reference}`)
        leafIds.push(driven.sessionId)
      }
      onDone(await workspace.conferDriver(member.sessionId, leafIds), { display: 'system' })
      return null
    }

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
      const self = getSessionId()
      // The dedupe record belongs to the family, and the family file is named
      // after its creator - a stable family id, not the session running this
      // return, which may be any member that opened the family.
      const root = await workspace.familyRootSessionId()
      const text = transfer[2]!.trim()
      if (text.length > 64000) throw new Error('Context return too large')
      const hash = createHash('sha256').update(`${root}\0${member.sessionId}\0${text}`).digest('hex')
      const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
      const message = createUserMessage({ uuid: id, content: `Explicit context return from Leaf ${member.number}: ${member.name} (${member.sessionId}). Source ancestry is retained; this is a selected note, not a transcript merge or permission grant.\n\n${text}`, isMeta: true, origin: { kind: 'task-notification' } })
      const { doesMessageExistInSession, recordTranscript, flushSessionStorage, isTranscriptPersistenceEnabled } = await import('../utils/sessionStorage.js')
      if (!isTranscriptPersistenceEnabled()) throw new Error('Context return requires transcript persistence')
      if (await doesMessageExistInSession(self as import('node:crypto').UUID, message.uuid)) {
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
      if (getSessionId() !== self) throw new Error('Session changed during context return')
      context.setMessages(previous => previous.some(item => item.uuid === id) ? previous : [...previous, message])
      onDone('Selected leaf context saved to the original transcript; identical returns are deduplicated across restart and compaction.', { display: 'system' })
      return null
    }

    // Closing the session you are in, which is the one close a leaf reference
    // cannot address: `me` names this session, and a bare `close` is the same
    // request. What it does is decided by the session asking rather than by the
    // grammar - the family moves to the next leaf, or the session just leaves.
    if (input === 'close' || input === 'close me' || input === 'close self') {
      const { getSessionId } = await import('../bootstrap/state.js')
      onDone(await workspace.changeLeaf(getSessionId(), { status: 'closed' }) ?? '', { display: 'system' })
      return null
    }

    const change = input.match(/^(rename|close|archive|promote|reopen)\s+(\S+)(?:\s+([\s\S]+))?$/)
    if (change) {
      const action = change[1]!
      if (action === 'rename' && !change[3]?.trim()) throw new Error('Name required')
      // Closing may name the session you are in, which no other verb here may.
      const member = action === 'close'
        ? await workspace.resolveCloseTarget(change[2]!)
        : await workspace.resolveLeafRef(change[2]!)
      if (!member) throw new Error('Unknown or ambiguous leaf reference')
      const promoted = await workspace.changeLeaf(member.sessionId, action === 'rename' ? { name: change[3]!.trim() } : { status: action === 'close' ? 'closed' : action === 'archive' ? 'archived' : action === 'reopen' ? 'open' : 'promoted', ...(change[3]?.trim() ? { name: change[3].trim() } : {}) })
      onDone(`Leaf ${action} recorded; transcript and ancestry retained.${promoted ? ` ${promoted}` : ''}`, { display: 'system' })
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

    const reading = parseReadRequest(input)
    if (reading) {
      onDone(await workspace.readLeafTranscript(reading.reference, reading.options), { display: 'system' })
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
        // `#2` and a checkpoint label name a frozen point rather than a live
        // conversation. A token that answers to neither is the new leaf's name,
        // which is what makes `fork my-new-leaf` fork the current session.
        const source = await isLeafReference(first!, workspace.resolveLeafRef) || await workspace.isCheckpointReference(first!)
        if (source) await workspace.createLeaf(tail.join(' ').trim() || undefined, first, undefined, options)
        else await workspace.createLeaf(forkRequest, undefined, undefined, options)
      }
    } else if (input === 'new' || input.startsWith('new ')) {
      await workspace.createLeaf(input.slice(3).trim() || undefined, undefined, undefined, { ...options, fresh: true })
    } else if (!input) {
      // Bare `/leaf` is the guided surface: it loads the roster but starts no
      // process, so opening one stays a deliberate click. `/leaf <args>` below
      // is unchanged - the argument grammar is the passthrough.
      await workspace.restoreLeafWorkspace()
      const { LeafMenu } = await import('../components/LeafWorkspaceDialog.js')
      return <LeafMenu onDone={result => onDone(result ?? '', { display: 'system' })} model={options.model} effort={options.effort} />
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
