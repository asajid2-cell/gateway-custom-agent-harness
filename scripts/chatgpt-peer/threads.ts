/**
 * What a thread says, read from the page's own data instead of from our memory.
 *
 * ChatGPT stores a thread as a tree (`mapping`) with a `current_node` leaf; the
 * visible conversation is the path from that leaf to the root. Everything here
 * is a pure function of that tree or of the thread list, so the host can decide
 * "which turns are ours", "did a human type", and "is the answer finished"
 * without trusting marker text or a DOM scrape.
 *
 * Shapes are as observed on 2026-10-29 via /backend-api/conversation/<id> and
 * /backend-api/conversations: the root node has `message: null`; a finished
 * answer is the assistant node with `end_turn: true` (thoughts and
 * reasoning_recap nodes are assistant nodes without it).
 */

export type ConversationNode = {
  id: string
  parent: string | null
  children?: string[]
  message: null | {
    id: string
    author: { role: string | null }
    create_time: number | null
    end_turn?: boolean | null
    status?: string | null
    content?: { content_type?: string; parts?: unknown[] }
  }
}

export type Conversation = { current_node: string | null; mapping: Record<string, ConversationNode> }

export type Turn = { id: string; role: 'user' | 'assistant'; createTime: number | null; text: string }

export type HumanTurn = { userNodeId: string; userText: string; answer: { nodeId: string; text: string } | null }

export type ThreadListItem = { id: string; title?: string | null }

function textOf(node: ConversationNode): string {
  const parts = node.message?.content?.parts ?? []
  return parts.filter((p): p is string => typeof p === 'string').join('\n')
}

/** Every node id from the root to `current_node`, root first. Stops on a cycle or a missing parent. */
export function pathOf(conversation: Conversation): string[] {
  const path: string[] = []
  const seen = new Set<string>()
  let id = conversation.current_node
  while (id && conversation.mapping[id] && !seen.has(id)) {
    seen.add(id)
    path.push(id)
    id = conversation.mapping[id]!.parent
  }
  return path.reverse()
}

/** The visible conversation as turns: user messages and finished answers, oldest first. */
export function chainOf(conversation: Conversation): Turn[] {
  const turns: Turn[] = []
  for (const id of pathOf(conversation)) {
    const node = conversation.mapping[id]!
    const role = node.message?.author.role
    if (role === 'user' || (role === 'assistant' && node.message?.end_turn === true)) {
      turns.push({ id, role, createTime: node.message?.create_time ?? null, text: textOf(node) })
    }
  }
  return turns
}

export function nodeIdsOf(conversation: Conversation): Set<string> {
  return new Set(Object.keys(conversation.mapping))
}

/** The turns strictly after `cursor` on the visible branch, oldest first. */
function turnsAfter(conversation: Conversation, cursor: string): Turn[] {
  const path = pathOf(conversation)
  const turns = chainOf(conversation)
  const index = path.indexOf(cursor)
  if (index >= 0) {
    const later = new Set(path.slice(index + 1))
    return turns.filter(t => later.has(t.id))
  }
  const at = conversation.mapping[cursor]?.message?.create_time
  if (typeof at !== 'number') return []
  return turns.filter(t => typeof t.createTime === 'number' && t.createTime > at)
}

/**
 * User turns the host did not send, after the cursor, each with its finished
 * answer or `null` while the answer is still being written.
 *
 * `ours` holds the node ids of the messages the host itself sent; identity is
 * by node id, never by what the text says. `cursor` is the last node the host
 * has handled. A cursor that is no longer on the current branch (a human
 * edited an earlier message) is replaced by its create_time. No cursor means
 * the thread was just adopted: history is not replayed.
 */
export function pendingHumanTurns(conversation: Conversation, state: { ours: ReadonlySet<string>; cursor: string | null }): HumanTurn[] {
  if (!state.cursor) return []
  const after = turnsAfter(conversation, state.cursor)
  const result: HumanTurn[] = []
  after.forEach((turn, i) => {
    if (turn.role !== 'user' || state.ours.has(turn.id)) return
    const next = after[i + 1]
    result.push({
      userNodeId: turn.id,
      userText: turn.text,
      answer: next && next.role === 'assistant' ? { nodeId: next.id, text: next.text } : null,
    })
  })
  return result
}

/** A finished answer the host has not handled, with the person's question when there was one. */
export type PageAnswer = { nodeId: string; text: string; userNodeId: string | null; userText: string | null }

/**
 * Finished answers after the cursor that the page produced on its own.
 *
 * "Ours" is by node id: an answer whose parent user node is one the host
 * posted belongs to a turn the host started, and the turn loop already owns it.
 * Everything else - an answer to something a person typed, or an answer with
 * no user turn in front of it - is the page speaking for itself, and that is
 * the only thing the uplink path may relay.
 */
export function newPageAnswers(conversation: Conversation, state: { ours: ReadonlySet<string>; cursor: string | null }): PageAnswer[] {
  if (!state.cursor) return []
  return turnsAfter(conversation, state.cursor)
    .filter(turn => turn.role === 'assistant' && !state.ours.has(turn.id))
    .filter(turn => {
      const parent = conversation.mapping[turn.id]?.parent
      return !parent || !state.ours.has(parent)
    })
    .map(turn => {
      const parent = conversation.mapping[turn.id]?.parent
      const asked = parent ? conversation.mapping[parent] : undefined
      const human = asked && asked.message?.author.role === 'user'
      return {
        nodeId: turn.id,
        text: turn.text,
        userNodeId: human ? parent : null,
        userText: human ? textOf(asked) : null,
      }
    })
}

/**
 * Which new user nodes our send created.
 *
 * `before` is the node ids the thread had before we typed. Normally exactly
 * one user node appears and it is ours. If a human typed in the same window,
 * the node whose text is exactly what we sent is ours and the rest are human;
 * if none matches, the newest is taken as ours.
 */
export function attributeSend(before: ReadonlySet<string>, after: Conversation, sentText: string): { ours: string[]; human: string[] } {
  const fresh = Object.values(after.mapping)
    .filter(n => !before.has(n.id) && n.message?.author.role === 'user')
    .sort((a, b) => (a.message?.create_time ?? 0) - (b.message?.create_time ?? 0))
  if (fresh.length <= 1) return { ours: fresh.map(n => n.id), human: [] }
  const matching = fresh.filter(n => textOf(n).trim() === sentText.trim())
  const ours = matching.length > 0 ? [matching[matching.length - 1]!] : [fresh[fresh.length - 1]!]
  return { ours: ours.map(n => n.id), human: fresh.filter(n => !ours.includes(n)).map(n => n.id) }
}

/** New, renamed and vanished threads relative to the previous listing (id -> title). */
export function diffThreadList(previous: ReadonlyMap<string, string>, items: ThreadListItem[]): {
  added: { id: string; title: string }[]
  renamed: { id: string; from: string; to: string }[]
  removed: string[]
} {
  const now = new Map(items.map(i => [i.id, i.title ?? '']))
  const added: { id: string; title: string }[] = []
  const renamed: { id: string; from: string; to: string }[] = []
  for (const [id, title] of now) {
    const was = previous.get(id)
    if (was === undefined) added.push({ id, title })
    else if (was !== title) renamed.push({ id, from: was, to: title })
  }
  const removed = [...previous.keys()].filter(id => !now.has(id))
  return { added, renamed, removed }
}

/**
 * Every thread, paged by offset. `total` is ignored (observed wrong); paging
 * stops on a short page or a page that brought no new ids, and is capped.
 */
export async function listAllThreads<T extends ThreadListItem>(
  fetchPage: (offset: number, limit: number) => Promise<{ items?: T[] }>,
  pageSize = 100,
  maxPages = 50,
): Promise<T[]> {
  const byId = new Map<string, T>()
  for (let page = 0; page < maxPages; page++) {
    const { items = [] } = await fetchPage(page * pageSize, pageSize)
    let fresh = 0
    for (const item of items) if (!byId.has(item.id)) { byId.set(item.id, item); fresh++ }
    if (items.length < pageSize || fresh === 0) break
  }
  return [...byId.values()]
}
