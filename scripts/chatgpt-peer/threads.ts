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
    /** Attachments live here on this account: `{id:"file_<hex>", name, size, mime_type}`. */
    metadata?: { attachments?: unknown[] } | null
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

/** The text of one node, exported: the delivery path reads the answer itself. */
export function nodeTextOf(node: ConversationNode | null | undefined): string {
  return node ? textOf(node) : ''
}

// ------------------------------------------------------------------- files
//
// A file's identity is the id in `metadata.attachments[].id` (observed live as
// `file_<32 hex>`); `content.parts[]` asset pointers are the secondary source.
// Index is the only handle, and it always means "the Nth file of THIS node".

const FILE_ID = /^(?:file_[0-9a-f]{16,64}|libfile_[A-Za-z0-9]{8,64})$/i
const POINTER_PREFIX = /^(?:sediment|file-service):\/\//i

/** A file id from a bare id, a pointer, or nothing. Pure; the one regex. */
export function fileIdOf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim().replace(POINTER_PREFIX, '')
  return FILE_ID.test(text) ? text : null
}

export type NodeFile = { index: number; fileId: string; name: string; mime: string; size: number }

/**
 * A file the PAGE produced: it has no attachment id at all.
 *
 * A page-made file shows up only as a link to `sandbox:/mnt/data/<name>` in the
 * answer's text (proven live 2026-10-30: `review-r1.md`, 10,371 bytes, read
 * back through the interpreter endpoint). So it is addressed by the node that
 * links it plus that sandbox path, never by an id we do not have.
 */
export type SandboxFile = { index: number; sandboxPath: string; name: string }

/** One file of a node, whichever way the page named it. Index is `index`. */
export type NodeFileRef =
  | { index: number; kind: 'attachment'; fileId: string; name: string; mime: string; size: number }
  | { index: number; kind: 'sandbox'; sandboxPath: string; name: string }

const SANDBOX_POINTER = /sandbox:(\/mnt\/data\/[^\s)"'<>\]]+)/gi

/** The sandbox paths one node's text links, first occurrence first, by name. */
export function sandboxFilesOf(node: ConversationNode | null | undefined): SandboxFile[] {
  const files: SandboxFile[] = []
  const seen = new Set<string>()
  const text = node ? textOf(node) : ''
  for (const match of text.matchAll(SANDBOX_POINTER)) {
    const sandboxPath = match[1]!
    if (seen.has(sandboxPath)) continue
    seen.add(sandboxPath)
    files.push({ index: files.length, sandboxPath, name: sandboxPath.split('/').at(-1) ?? sandboxPath })
  }
  return files
}

/**
 * Every file a node carries, in one index space: attachments first, then the
 * page's own sandbox links, with a name already used by an attachment skipped.
 */
export function nodeFilesOf(node: ConversationNode | null | undefined): NodeFileRef[] {
  const files: NodeFileRef[] = []
  for (const file of filePartsOf(node)) {
    files.push({ index: files.length, kind: 'attachment', fileId: file.fileId, name: file.name, mime: file.mime, size: file.size })
  }
  const named = new Set(files.map(file => file.name.toLowerCase()).filter(Boolean))
  for (const file of sandboxFilesOf(node)) {
    if (named.has(file.name.toLowerCase())) continue
    files.push({ index: files.length, kind: 'sandbox', sandboxPath: file.sandboxPath, name: file.name })
  }
  return files
}

/**
 * The files one node carries, in a stable order: attachments first, then asset
 * pointers in the parts. Duplicates (the same id in both places) collapse.
 *
 * Nothing here comes from the node's prose. A URL written in the text is text,
 * never a file; that is why this reads `metadata` and structured parts only.
 */
export function filePartsOf(node: ConversationNode | null | undefined): NodeFile[] {
  const files: NodeFile[] = []
  const seen = new Set<string>()
  const push = (value: unknown, name: unknown, mime: unknown, size: unknown): void => {
    const fileId = fileIdOf(value)
    if (!fileId || seen.has(fileId)) return
    seen.add(fileId)
    files.push({
      index: files.length,
      fileId,
      name: typeof name === 'string' ? name : '',
      mime: typeof mime === 'string' ? mime : '',
      size: typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : 0,
    })
  }
  const message = node?.message
  for (const entry of message?.metadata?.attachments ?? []) {
    if (!entry || typeof entry !== 'object') continue
    const attachment = entry as Record<string, unknown>
    push(attachment.id ?? attachment.file_id, attachment.name ?? attachment.file_name, attachment.mime_type ?? attachment.mimeType, attachment.size ?? attachment.size_bytes)
  }
  for (const part of message?.content?.parts ?? []) {
    if (typeof part === 'string') { push(part, '', '', 0); continue }
    if (!part || typeof part !== 'object') continue
    const record = part as Record<string, unknown>
    push(record.asset_pointer ?? record.file_id ?? record.id ?? record.pointer, record.name ?? record.file_name, record.mime_type ?? record.mimeType, record.size_bytes ?? record.size)
  }
  return files
}

const REASONING_TYPE = /^(thoughts|reasoning_recap|reasoning)$/i

/**
 * A thought/recap node: an assistant node that is NOT the answer.
 *
 * The page renders these with `author.role === 'assistant'` and a content type
 * of `thoughts` or `reasoning_recap`; treating one as "the newest answer" is how
 * a status line can be mistaken for an answer. Pure.
 */
export function isReasoningNode(node: ConversationNode | null | undefined): boolean {
  const type = node?.message?.content?.content_type
  return typeof type === 'string' && REASONING_TYPE.test(type)
}

/** Fail-safe completion: only explicit finishing evidence counts. */
export function nodeComplete(node: ConversationNode | null | undefined): boolean {
  // A thought/recap is never an answer, however finished it looks.
  if (isReasoningNode(node)) return false
  const message = node?.message
  const status = typeof message?.status === 'string' ? message.status : null
  return status === 'finished_successfully' || status === 'complete' || message?.end_turn === true
}

/**
 * The assistant node a user node got as its answer: the child on the visible
 * branch when there is one, otherwise the newest child by create_time.
 */
export function answerAfter(conversation: Conversation, userNodeId: string): ConversationNode | null {
  const user = conversation.mapping[userNodeId]
  if (!user) return null
  const path = new Set(pathOf(conversation))
  const children = (user.children ?? []).map(id => conversation.mapping[id]).filter((n): n is ConversationNode => !!n)
  const answers = children.filter(child => child.message?.author.role === 'assistant' && !isReasoningNode(child))
  if (answers.length === 0) return null
  const onPath = answers.find(child => path.has(child.id))
  if (onPath) return onPath
  return answers.slice().sort((a, b) => (a.message?.create_time ?? 0) - (b.message?.create_time ?? 0)).at(-1) ?? null
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

/**
 * The user node an answer belongs to: the first user ancestor above it.
 *
 * This is the attribution rule for a pending job. Two jobs can be outstanding on
 * one thread, so "the latest answer" decides nothing; the parent chain names the
 * one sender the answer belongs to.
 */
export function askerOf(conversation: Conversation, answerNodeId: string): string | null {
  let id = conversation.mapping[answerNodeId]?.parent ?? null
  const seen = new Set<string>()
  while (id && !seen.has(id)) {
    seen.add(id)
    const node = conversation.mapping[id]
    if (!node) return null
    if (node.message?.author.role === 'user') return node.id
    id = node.parent
  }
  return null
}

/** The visible conversation as turns: user messages and finished answers, oldest first. */
export function chainOf(conversation: Conversation): Turn[] {
  const turns: Turn[] = []
  for (const id of pathOf(conversation)) {
    const node = conversation.mapping[id]!
    const role = node.message?.author.role
    if (role === 'user' || (role === 'assistant' && node.message?.end_turn === true && !isReasoningNode(node))) {
      turns.push({ id, role, createTime: node.message?.create_time ?? null, text: textOf(node) })
    }
  }
  return turns
}

export function nodeIdsOf(conversation: Conversation): Set<string> {
  return new Set(Object.keys(conversation.mapping))
}

/**
 * The newest assistant node on the visible branch, whatever its status.
 *
 * `chainOf` only keeps answer nodes the page has explicitly finished, which is
 * right for replaying a conversation and wrong for asking "is the answer in
 * front of me done yet" - an unfinished node is exactly what that question is
 * about. Completion is decided by `nodeComplete`, never by presence here.
 */
export function latestAssistantOf(conversation: Conversation): ConversationNode | null {
  const path = pathOf(conversation)
  for (let index = path.length - 1; index >= 0; index--) {
    const node = conversation.mapping[path[index]!]
    if (node?.message?.author.role === 'assistant' && !isReasoningNode(node)) return node ?? null
  }
  return null
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
