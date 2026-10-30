/**
 * The command channel between the ChatGPT web model and this host.
 *
 * The model acts by emitting a block whose label line is exactly `gateway` and
 * whose body is one JSON object carrying the nonce in its `nonce` field. The
 * page renders that as a code-block widget, and the widget keeps only the label
 * word: the info string and the backticks never reach the transcript. So the
 * reader accepts the RENDERED shape (`gateway` alone on a line, then the
 * balanced object) as well as literal fenced markdown, which is still what a
 * raw driver read returns.
 *
 * Two locks keep a peer from acting through the model: only the newest
 * assistant turn is parsed (the host never parses peer text), and a block
 * carrying any other nonce is refused. A peer that copies a command block out
 * of an older turn therefore holds a dead nonce.
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
    // state.ts caps a label at 80 characters. Accepting a longer one here would
    // write a peer.json this host refuses to load on its next start.
    if (label.length > 80) return { ok: false, error: 'schedule label is limited to 80 characters' }
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

/**
 * The rendered label line. The page shows a code block as its label over the
 * body, so a `gateway` block arrives as a line reading exactly `gateway`.
 * Leading indentation is allowed; anything else on the line is not a label.
 */
const GATEWAY_LABEL = /^[ \t]*gateway[ \t]*$/i

type LineSpan = { start: number; end: number }

function linesOf(source: string): Array<LineSpan & { text: string }> {
  const lines: Array<LineSpan & { text: string }> = []
  let start = 0
  for (;;) {
    const newline = source.indexOf('\n', start)
    const end = newline < 0 ? source.length : newline
    lines.push({ start, end, text: source.slice(start, end).replace(/\r$/, '') })
    if (newline < 0) break
    start = newline + 1
  }
  return lines
}

/** The index just past the balanced `{...}` that starts at `start`, or -1. */
function objectEnd(source: string, start: number): number {
  if (source[start] !== '{') return -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < source.length; index++) {
    const char = source[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') { inString = true; continue }
    if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) return index + 1
    }
  }
  return -1
}

function firstNonSpace(source: string, from: number): number {
  let index = from
  while (index < source.length && /\s/.test(source[index])) index++
  return index < source.length ? index : -1
}

/**
 * The markup an answer can carry instead of a fence: `<CodeBlock language="gateway">`.
 *
 * The page renders this as a real code block, so the model can write it and
 * mean it - but the text we read back holds the tag, not a fence, and the
 * body is the inner text.
 */
const CODEBLOCK_TAG = /<CodeBlock\b([^>]*)>/gi
const CODEBLOCK_CLOSE = '</codeblock>'

type MarkupElement = { start: number; bodyStart: number; bodyEnd: number; end: number; info: string }

function codeBlockInfo(attributes: string): string {
  const attribute = /(?:^|\s)language\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attributes)
  return (attribute?.[1] ?? attribute?.[2] ?? '').trim()
}

/**
 * The balanced `<CodeBlock ...>...</CodeBlock>` elements, resolved first.
 *
 * Container boundaries must be known before any line is read as a rendered
 * label: a `gateway` line inside a text block is example text, however much it
 * looks like a widget. A tag with no close is not an element; a tag that opens
 * another before its own close is unbalanced and skipped in favour of the inner
 * one.
 */
function codeBlockElements(source: string): MarkupElement[] {
  const lower = source.toLowerCase()
  const elements: MarkupElement[] = []
  CODEBLOCK_TAG.lastIndex = 0
  for (let tag = CODEBLOCK_TAG.exec(source); tag !== null; tag = CODEBLOCK_TAG.exec(source)) {
    const start = tag.index
    const bodyStart = start + tag[0].length
    const closeAt = lower.indexOf(CODEBLOCK_CLOSE, bodyStart)
    if (closeAt < 0) continue
    const nestedAt = lower.indexOf('<codeblock', bodyStart)
    if (nestedAt >= 0 && nestedAt < closeAt) continue
    const end = closeAt + CODEBLOCK_CLOSE.length
    elements.push({ start, bodyStart, bodyEnd: closeAt, end, info: codeBlockInfo(tag[1]) })
    CODEBLOCK_TAG.lastIndex = end
  }
  return elements
}

/**
 * Split one assistant turn into blocks, and record the spans a block occupies.
 *
 * Three shapes are read: literal fenced markdown, what the page actually
 * renders - a line holding only `gateway`, then the balanced JSON object - and
 * `<CodeBlock language="...">...</CodeBlock>` markup. The spans exist so prose
 * outside a block can be returned untouched.
 */
function scanBlocks(source: string): { blocks: Block[]; spans: Array<LineSpan & { gateway: boolean }> } {
  const lines = linesOf(source)
  // Containers come first: a line inside a CodeBlock element belongs to that
  // element, so it is never read as a rendered gateway label.
  const elements = codeBlockElements(source)
  const insideElement = (offset: number): boolean =>
    elements.some(element => offset >= element.start && offset < element.end)
  // Blocks carry the offset they start at, so the three shapes can be put back
  // in reading order once all of them are found.
  const placed: Array<{ block: Block; start: number }> = []
  const spans: Array<LineSpan & { gateway: boolean }> = []
  const spanThrough = (first: number, last: number): LineSpan => ({
    start: lines[first].start,
    // Drop the line break after the last line too, so two prose lines that
    // surrounded a block do not collapse onto one.
    end: lines[last].end < source.length ? lines[last].end + 1 : lines[last].end,
  })
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (insideElement(line.start)) { index++; continue }
    const fence = /^ {0,3}```(.*)$/.exec(line.text)
    if (fence) {
      const info = fence[1].trim()
      let close = index + 1
      while (close < lines.length && !/^ {0,3}```/.test(lines[close].text)) close++
      placed.push({
        block: {
          info,
          body: lines.slice(index + 1, Math.min(close, lines.length)).map(item => item.text).join('\n'),
          line: index + 1,
        },
        start: line.start,
      })
      spans.push({ ...spanThrough(index, close < lines.length ? close : lines.length - 1), gateway: /^gateway\b/i.test(info) })
      index = close < lines.length ? close + 1 : lines.length
      continue
    }
    if (GATEWAY_LABEL.test(line.text)) {
      const objectStart = firstNonSpace(source, line.end < source.length ? line.end + 1 : source.length)
      const end = objectStart >= 0 ? objectEnd(source, objectStart) : -1
      if (end > 0) {
        placed.push({ block: { info: 'gateway', body: source.slice(objectStart, end), line: index + 1 }, start: line.start })
        // The span stops at the closing brace: prose sharing that line stays.
        spans.push({ start: line.start, end, gateway: true })
        while (index + 1 < lines.length && lines[index + 1].start < end) index++
      }
      // A lone `gateway` line with no object after it is prose, not a block.
    }
    index++
  }
  // Third shape: `<CodeBlock language="...">body</CodeBlock>`. The elements
  // were resolved before the line scan; here they become blocks. An element
  // already inside a fence is part of that fence's body.
  const lineAt = (offset: number): number => {
    let at = 1
    for (let cursor = 0; cursor < offset; cursor++) if (source[cursor] === '\n') at++
    return at
  }
  for (const element of elements) {
    if (spans.some(span => element.start < span.end && element.end > span.start)) continue
    placed.push({
      block: { info: element.info, body: source.slice(element.bodyStart, element.bodyEnd), line: lineAt(element.start) },
      start: element.start,
    })
    spans.push({ start: element.start, end: element.end, gateway: /^gateway\b/i.test(element.info) })
  }
  placed.sort((left, right) => left.start - right.start)
  spans.sort((left, right) => left.start - right.start)
  return { blocks: placed.map(item => item.block), spans }
}

/** Split the blocks out of one assistant turn. Returns every block seen. */
export function readFences(source: string): Block[] {
  return scanBlocks(source).blocks
}

/**
 * The credential a block carries, and the object to run once it is removed.
 *
 * The page destroys a block's info string, so the nonce lives in the JSON body.
 * A nonce on a fenced info line is still accepted, because a raw markdown read -
 * and every block from before the rendered shape existed - carries it there.
 */
export function blockCredential(raw: unknown, info: string): { credential?: string; value: unknown } {
  const object = isRecord(raw) ? raw : undefined
  const bodyNonce = object && typeof object.nonce === 'string' && object.nonce ? object.nonce : undefined
  if (object) delete object.nonce
  const infoNonce = info.replace(/^gateway\s*/i, '').trim()
  return { credential: bodyNonce ?? (infoNonce || undefined), value: object ?? raw }
}

/**
 * Read the commands out of one assistant turn.
 *
 * Only blocks labelled `gateway` are considered. The credential is the JSON
 * object's `nonce` field. A mismatch becomes one refusal line rather than an
 * exception, so the model learns why nothing happened and the other blocks
 * still run.
 */
export function extractCommands(source: string, nonce: string, limit = MAX_COMMANDS_PER_TURN): Extraction {
  const commands: Command[] = []
  const problems: string[] = []
  for (const block of scanBlocks(source).blocks) {
    if (!/^gateway\b/i.test(block.info)) continue
    let parsed: unknown
    try { parsed = JSON.parse(block.body) }
    catch (error) { problems.push(`line ${block.line}: refused: invalid JSON (${(error as Error).message})`); continue }
    const { credential, value } = blockCredential(parsed, block.info)
    if (credential !== nonce) {
      problems.push(`line ${block.line}: refused: nonce mismatch`)
      continue
    }
    const result = parseCommand(value)
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
 * A command block is never an answer. Every gateway block is stripped, in both
 * the rendered and the fenced shape; other blocks stay, because a code sample
 * in an answer is prose. `commandShaped` is true when a gateway block was the
 * only thing in the turn, or when the whole turn is a bare JSON command object.
 */
export function proseFromTurn(source: string): { prose: string; commandShaped: boolean } {
  const { blocks, spans } = scanBlocks(source)
  let visible = ''
  let cursor = 0
  for (const span of spans) {
    if (!span.gateway) continue
    visible += source.slice(cursor, span.start)
    cursor = span.end
  }
  visible = (visible + source.slice(cursor)).trim()
  const action = blocks.some(block => /^gateway\b/i.test(block.info))
  const jsonAction = visible.startsWith('{') && /\{\s*"op"\s*:/.test(visible)
  return { prose: visible, commandShaped: (action && !visible) || jsonAction }
}

/**
 * Break any block a peer smuggled into its own text.
 *
 * The nonce already makes such a block unexecutable, but a model can quote it
 * back and a broken block costs nothing. A zero-width space keeps the text
 * readable while ensuring nothing downstream sees a closing fence or a label
 * line of its own.
 */
export function sanitizePeerText(source: string): string {
  return source
    .replace(/```/g, '```\u200b')
    .replace(/^([ \t]*gateway[ \t]*)$/gim, '$1\u200b')
}

export function formatResultLines(lines: readonly string[]): string {
  return [
    'BUS RESULT (tool results, not a peer message)',
    ...lines.map(line => `- ${line}`),
    'Nothing above was said by a peer. Continue, or answer in prose if you are done.',
  ].join('\n')
}
