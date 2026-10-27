/**
 * The command channel between the ChatGPT web model and this host.
 *
 * The model acts by emitting fenced blocks whose info string names a nonce the
 * host minted for that turn. Two locks keep a peer from acting through the
 * model: only the newest assistant turn is parsed (the host never parses peer
 * text), and a block carrying any other nonce is refused. A peer that copies a
 * command block out of an older turn therefore holds a dead nonce.
 */

export const MAX_COMMANDS_PER_TURN = 8
export const MAX_MODEL_ROUNDS = 4
export const MAX_MESSAGE_BYTES = 64 * 1024
/** The largest file the host will hand to the page, counted on decoded bytes. */
export const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024

/**
 * The one sentence for an over-envelope attachment, or undefined when it fits.
 *
 * Both numbers are named so the thread, the audit and the HTTP reply agree, and
 * the caller can refuse on the stat size before the file is ever opened.
 */
export function attachmentRefusal(size: number, max = MAX_ATTACHMENT_BYTES): string | undefined {
  return size > max ? `attachment refused: ${size} bytes exceeds the 64 MiB host envelope` : undefined
}

export const COMMAND_OPS = [
  'list',
  'inbox',
  'receipt',
  'send',
  'reply',
  'schedule',
  'cancelSchedule',
  'watchIdle',
  'requestContext',
  'read',
] as const

export type CommandOp = (typeof COMMAND_OPS)[number]
export type PeerMessageKind = 'inquiry' | 'directive'

export type Command =
  | { op: 'list' }
  | { op: 'inbox' }
  | { op: 'receipt'; to: string; messageId: string }
  | { op: 'send'; to: string; text: string; summary: string; kind?: PeerMessageKind; expectReply?: boolean }
  | { op: 'reply'; toMessageId: string; text: string; summary?: string; kind?: PeerMessageKind; expectReply?: boolean }
  | { op: 'schedule'; label: string; inSeconds?: number; at?: string }
  | { op: 'cancelSchedule'; label: string }
  | { op: 'watchIdle'; to: string }
  | { op: 'requestContext'; to: string; topic: string; question: string }
  | { op: 'read'; peer: string; tail?: number; since?: string }

export type Extraction = { commands: Command[]; problems: string[] }

export type ParseResult = { ok: true; command: Command } | { ok: false; error: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value : undefined

const kind = (value: unknown): PeerMessageKind | undefined =>
  value === 'inquiry' || value === 'directive' ? value : undefined

const bool = (value: unknown): boolean | undefined => typeof value === 'boolean' ? value : undefined

/**
 * Validate one JSON object as an op this host will run.
 *
 * Every rejection is a sentence, because it is shown back to the model as a
 * result line: a refusal it cannot read is an act it will retry unchanged.
 */
export function parseCommand(raw: unknown): ParseResult {
  if (!isRecord(raw)) return { ok: false, error: 'command is not a JSON object' }
  const op = raw.op
  if (typeof op !== 'string') return { ok: false, error: 'missing op' }
  if (!(COMMAND_OPS as readonly string[]).includes(op)) return { ok: false, error: `unknown op ${op}` }

  if (op === 'list' || op === 'inbox') return { ok: true, command: { op } }

  if (op === 'requestContext') {
    const to = text(raw.to)
    const topic = text(raw.topic)
    const question = text(raw.question)
    if (!to) return { ok: false, error: 'requestContext requires to' }
    if (!topic) return { ok: false, error: 'requestContext requires topic' }
    if (!question) return { ok: false, error: 'requestContext requires question' }
    if (Buffer.byteLength(question, 'utf8') > MAX_MESSAGE_BYTES) return { ok: false, error: 'requestContext question exceeds 64 KiB' }
    return { ok: true, command: { op: 'requestContext', to, topic: topic.slice(0, 200), question } }
  }

  if (op === 'read') {
    // The cheap peek. It is a capped snapshot for orientation - the transport
    // owns the cap (12 turns / 1200 chars per turn / 20000 total) and this host
    // never widens it. `tail` is clamped to 40, silently.
    const peer = text(raw.peer)
    if (!peer) return { ok: false, error: 'read requires peer' }
    const tail = typeof raw.tail === 'number' && Number.isInteger(raw.tail) && raw.tail > 0 ? Math.min(raw.tail, 40) : undefined
    const since = text(raw.since)
    return { ok: true, command: { op: 'read', peer, ...(tail ? { tail } : {}), ...(since ? { since: since.slice(0, 200) } : {}) } }
  }

  if (op === 'receipt') {
    const to = text(raw.to)
    const messageId = text(raw.messageId)
    if (!to) return { ok: false, error: 'receipt requires to' }
    if (!messageId) return { ok: false, error: 'receipt requires messageId' }
    return { ok: true, command: { op: 'receipt', to, messageId } }
  }

  if (op === 'send') {
    const to = text(raw.to)
    const body = text(raw.text)
    if (!to) return { ok: false, error: 'send requires to' }
    if (!body) return { ok: false, error: 'send requires text' }
    if (Buffer.byteLength(body, 'utf8') > MAX_MESSAGE_BYTES) return { ok: false, error: 'send text exceeds 64 KiB' }
    const summary = text(raw.summary) ?? body.replace(/\s+/g, ' ').trim().slice(0, 200)
    return {
      ok: true,
      command: {
        op: 'send', to, text: body, summary: summary.slice(0, 200),
        ...(kind(raw.kind) ? { kind: kind(raw.kind) } : {}),
        ...(bool(raw.expectReply) === undefined ? {} : { expectReply: bool(raw.expectReply) }),
      },
    }
  }

  if (op === 'reply') {
    const toMessageId = text(raw.toMessageId)
    const body = text(raw.text)
    if (!toMessageId) return { ok: false, error: 'reply requires toMessageId' }
    if (!body) return { ok: false, error: 'reply requires text' }
    if (Buffer.byteLength(body, 'utf8') > MAX_MESSAGE_BYTES) return { ok: false, error: 'reply text exceeds 64 KiB' }
    return {
      ok: true,
      command: {
        op: 'reply', toMessageId, text: body,
        ...(text(raw.summary) ? { summary: text(raw.summary)!.slice(0, 200) } : {}),
        ...(kind(raw.kind) ? { kind: kind(raw.kind) } : {}),
        ...(bool(raw.expectReply) === undefined ? {} : { expectReply: bool(raw.expectReply) }),
      },
    }
  }

  if (op === 'schedule') {
    const label = text(raw.label)
    if (!label) return { ok: false, error: 'schedule requires label' }
    const inSeconds = raw.inSeconds
    const at = text(raw.at)
    if (typeof inSeconds !== 'number' && !at) return { ok: false, error: 'schedule requires inSeconds or at' }
    if (typeof inSeconds === 'number') {
      if (!Number.isFinite(inSeconds) || inSeconds <= 0) return { ok: false, error: 'inSeconds must be positive' }
      if (inSeconds > 24 * 3600) return { ok: false, error: 'schedule is limited to 24 hours ahead' }
    }
    if (at) {
      const when = Date.parse(at)
      if (!Number.isFinite(when)) return { ok: false, error: 'at is not a valid timestamp' }
      if (when < Date.now() - 60_000) return { ok: false, error: 'at is in the past' }
      if (when > Date.now() + 24 * 3600_000) return { ok: false, error: 'schedule is limited to 24 hours ahead' }
    }
    return { ok: true, command: { op: 'schedule', label, ...(typeof inSeconds === 'number' ? { inSeconds } : {}), ...(at ? { at } : {}) } }
  }

  if (op === 'cancelSchedule') {
    const label = text(raw.label)
    if (!label) return { ok: false, error: 'cancelSchedule requires label' }
    return { ok: true, command: { op: 'cancelSchedule', label } }
  }

  if (op === 'watchIdle') {
    const to = text(raw.to)
    if (!to) return { ok: false, error: 'watchIdle requires to' }
    return { ok: true, command: { op: 'watchIdle', to } }
  }

  return { ok: false, error: `unknown op ${op}` }
}

type Block = { info: string; body: string; line: number }

/** Split fenced blocks out of one assistant turn. Returns every block seen. */
export function readFences(source: string): Block[] {
  const lines = source.split(/\r?\n/)
  const blocks: Block[] = []
  let open: { info: string; body: string[]; line: number } | undefined
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const fence = /^ {0,3}```(.*)$/.exec(line)
    if (!fence) {
      if (open) open.body.push(line)
      continue
    }
    if (open) {
      blocks.push({ info: open.info, body: open.body.join('\n'), line: open.line })
      open = undefined
      continue
    }
    open = { info: fence[1].trim(), body: [], line: index + 1 }
  }
  // A model that forgets the closing fence still emitted a block. Dropping it
  // silently meant its command vanished and its text leaked as prose, so the
  // open block runs to end-of-text and is returned like any other.
  if (open) blocks.push({ info: open.info, body: open.body.join('\n'), line: open.line })
  return blocks
}

/**
 * Read the commands out of one assistant turn.
 *
 * Only fences labelled `gateway` are considered. A `gateway` fence whose nonce
 * does not match becomes one refusal line rather than an exception, so the
 * model learns why nothing happened and the other blocks still run.
 */
export function extractCommands(source: string, nonce: string, limit = MAX_COMMANDS_PER_TURN): Extraction {
  const commands: Command[] = []
  const problems: string[] = []
  for (const block of readFences(source)) {
    if (!/^gateway\b/i.test(block.info)) continue
    const info = block.info.replace(/^gateway\s*/i, '').trim()
    if (info !== nonce) {
      problems.push(`line ${block.line}: refused: nonce mismatch`)
      continue
    }
    let parsed: unknown
    try { parsed = JSON.parse(block.body) }
    catch (error) { problems.push(`line ${block.line}: refused: invalid JSON (${(error as Error).message})`); continue }
    const result = parseCommand(parsed)
    if (!result.ok) { problems.push(`line ${block.line}: refused: ${result.error}`); continue }
    if (commands.length >= limit) { problems.push(`line ${block.line}: refused: command budget (${limit} per turn)`); continue }
    commands.push(result.command)
  }
  return { commands, problems }
}

/**
 * Split a finished turn into the prose a peer may receive and whether the turn
 * was really an action.
 *
 * A command block is never an answer. A complete fence is stripped; so is an
 * unterminated one, which runs to end-of-text - an open fence is still an
 * action and must not leak to a peer as prose. `commandShaped` is true when the
 * only thing left is a fence, or when the page dropped the backticks and left
 * `gateway <nonce>` over a JSON object, or a bare JSON command object.
 */
export function proseFromTurn(source: string): { prose: string; commandShaped: boolean } {
  const hadFence = /```[ \t]*gateway\b/i.test(source)
  const visible = source
    .replace(/```[ \t]*gateway[^\n]*\n?[\s\S]*?```/gi, '')
    .replace(/```[ \t]*gateway[^\n]*\n?[\s\S]*$/i, '')
    .trim()
  const bareAction = /(^|\n)[ \t]*gateway\b[^\n]*\n[ \t]*\{/i.test(source)
  const jsonAction = visible.trimStart().startsWith('{') && /\{\s*"op"\s*:/.test(visible)
  return { prose: visible, commandShaped: bareAction || jsonAction || (!visible && hadFence) }
}

/**
 * Break any fence a peer smuggled into its own text.
 *
 * The nonce already makes such a block unexecutable, but a model can quote it
 * back and a broken fence costs nothing. A zero-width space keeps the text
 * readable while ensuring nothing downstream sees a closing fence.
 */
export function sanitizePeerText(source: string): string {
  return source.replace(/```/g, '```\u200b')
}

export function formatResultLines(lines: readonly string[]): string {
  return [
    'BUS RESULT (tool results, not a peer message)',
    ...lines.map(line => `- ${line}`),
    'Nothing above was said by a peer. Continue, or answer in prose if you are done.',
  ].join('\n')
}
