/**
 * Element map: the semantic description of a rendered frame, carried on the
 * VT stream.
 *
 * A terminal frame is pixels and nothing else. A multiplex viewer that wants
 * to draw its own widgets - a phone, a narrow browser - has to know which
 * cells are the leaf chips, the prompt bar and the footer, otherwise it can
 * only scale a fixed canvas. The element map is that knowledge, emitted by
 * the renderer at the end of the frame it describes, in the same byte stream
 * as the frame.
 *
 * Why the VT stream. The only path from this process to the viewer is
 * gateway -> pty -> muxtee -> muxd -> relay, and only VT bytes cross it. A
 * side file or socket would be a new network surface with its own auth and
 * firewall question, and it would still need something to carry it. Riding the
 * stream means the map a consumer holds is the map of the frame it drew, with
 * no pairing protocol to get wrong.
 *
 * The number. OSC command numbers are a shared namespace: 0/1/2 title, 8
 * hyperlinks, 9 iTerm2 notifications, 52 clipboard, 133 prompt, 1337 iTerm2
 * proprietary, 21337 the tab-status extension already in this tree. 21338 is
 * that extension's sibling and nothing else is known to use it. An unknown
 * number is discarded by a terminal, which is the property we want; the
 * stripper below keys on this number alone, so every other sequence survives.
 *
 * The payload. base64url of UTF-8 JSON, terminated by ST. Not raw JSON: it
 * can carry `;` and a raw 0x9C into the middle of an OSC string. base64url's
 * alphabet is [A-Za-z0-9-_], which contains nothing that can terminate the
 * sequence early and nothing a naive parameter splitter can mistake for a
 * boundary. Not BEL: an unrecognized command plus BEL is a bell.
 *
 * The rule that matters. A sequence is written whole or not at all. A
 * half-written sequence has no terminator, so the terminal prints the
 * remaining base64 to the screen as text - worse than emitting nothing. A
 * refused frame leaves the previous map in place, which is why the publisher
 * below only advances `gen` after a frame has actually been written.
 *
 * The contract is shared with the relay half (harmonizer-suite) and with the
 * relay's stripper (relaycore). Fields: v, gen, cols, rows, els; per element
 * id, role, r, label, act. Emission is the full list every time - no deltas -
 * and the consumer resolves duplicates last-wins by id.
 */

import { Buffer } from 'buffer'
import { BEL, SEP } from './termio/ansi.js'
import { OSC_PREFIX, ST } from './termio/osc.js'

/** OSC command number for the element map. See the header. */
export const ELEMENT_MAP_OSC = 21338

/**
 * A frame larger than this is refused rather than truncated. 32 KB of JSON is
 * roughly a thousand elements at the density this draws; a frame that exceeds
 * it is a bug (an unbounded list rendered without virtual scrolling), not a
 * routine event.
 */
export const ELEMENT_MAP_MAX_PAYLOAD_BYTES = 32 * 1024

/**
 * How often the last map is re-sent while it is non-empty. A relay that
 * restarts mid-session loses the map and has no way to ask for it - there is
 * no request channel in the other direction, and an input byte would be
 * visible to the app. Ten seconds at ~2 KB is ~200 B/s and recovers a restart
 * without a continuous write. The same `gen` is re-sent, so a consumer that
 * dedupes on `gen` pays nothing for the heartbeat.
 */
export const ELEMENT_MAP_HEARTBEAT_MS = 10_000

/** Cell rect in app space: x, y, width, height. 0-based, app screen origin. */
export type ElementRect = [number, number, number, number]

/**
 * What activating an element does.
 *
 * `ptr` is a pointer press at app-space cell coordinates; the consumer
 * synthesises press+release through its existing mouse path. `key` is opaque
 * bytes, base64url, replayed verbatim - the consumer never parses them, so
 * there is no second encoder to drift from the renderer's parser. `focus` is
 * a text-entry target: the consumer focuses its own widget and typed text
 * returns as ordinary keys. Absent or `none` is display-only.
 *
 * The emitter derives the form from the element's actual handler, not from
 * its role: `ptr` only where the handler is pointer-reachable, `key` where the
 * control is key-only. A role that usually carries a click may carry a key
 * here, and that is correct.
 */
export type MapAction =
  | { t: 'ptr'; x: number; y: number; b: 0 | 1 | 2 }
  | { t: 'key'; d: string }
  | { t: 'focus' }
  | { t: 'none' }

export type MapElement = {
  /** Stable while the widget is the same widget; the consumer keys overlays on it. */
  id: string
  /** Control vocabulary. Consumers must tolerate roles they do not know. */
  role: string
  /** App-space cell rect. May be outside [0,rows) for scrolled-out elements. */
  r: ElementRect
  /** Visible text of the element, when it has any. */
  label?: string
  /** What activating it does. Absent means display-only. */
  act?: MapAction
}

export type ElementMapFrame = {
  /** Format version. A consumer that does not know this number drops the frame. */
  v: 1
  /** Advances only when the map changes. A heartbeat re-sends the same `gen`. */
  gen: number
  /** Frame geometry, so a consumer can sanity-check rects against its terminal. */
  cols: number
  rows: number
  els: MapElement[]
}

export type EncodeResult =
  | { ok: true; sequence: string }
  | { ok: false; reason: 'too-large'; bytes: number }

const ELEMENT_MAP_INTRODUCER = `${OSC_PREFIX}${ELEMENT_MAP_OSC}${SEP}`

/** The same sequence with the 8-bit C1 OSC introducer, as a relayed stream may carry it. */
const ELEMENT_MAP_INTRODUCER_C1 = `${String.fromCharCode(0x9d)}${ELEMENT_MAP_OSC}${SEP}`

/**
 * Serialize one frame as a complete OSC sequence. Ends with ST: BEL is a bell
 * to every terminal that does not recognize the command.
 */
export function encodeElementMap(frame: ElementMapFrame): EncodeResult {
  // Reject before serializing an unbounded list: the size check is on the
  // bytes the terminal would receive, not on an estimate.
  const json = JSON.stringify(frame)
  const bytes = Buffer.byteLength(json, 'utf8')
  if (bytes > ELEMENT_MAP_MAX_PAYLOAD_BYTES) {
    return { ok: false, reason: 'too-large', bytes }
  }
  return { ok: true, sequence: `${ELEMENT_MAP_INTRODUCER}${Buffer.from(json, 'utf8').toString('base64url')}${ST}` }
}

/**
 * Encode the bytes of a key action.
 *
 * The map carries no raw escape characters: an action's bytes are base64url,
 * the same envelope as the payload, so nothing inside an action can terminate
 * the sequence that carries it.
 */
export function keyAction(bytes: string): MapAction {
  return { t: 'key', d: Buffer.from(bytes, 'utf8').toString('base64url') }
}

/** Decode a key action back to bytes. For the consumer side and for tests. */
export function decodeKeyAction(action: { t: 'key'; d: string }): string {
  return Buffer.from(action.d, 'base64url').toString('utf8')
}

/**
 * Where a stripper keeps bytes it cannot classify yet.
 *
 * `carry` is the trailing text that may be the beginning of a sequence the
 * next chunk completes. It is capped: a stream that opens an introducer and
 * never terminates it (corruption, or a truncated ring on a reconnect replay)
 * must not grow the buffer without bound. `dropped` counts sequences and
 * fragments discarded, so a consumer can report corruption rather than
 * silently losing frames.
 */
export type StripState = {
  carry: string
  dropped: number
}

export function createStripState(): StripState {
  return { carry: '', dropped: 0 }
}

/** Larger than any legal frame, so a legal frame split across chunks is never abandoned. */
export const ELEMENT_MAP_MAX_CARRY_BYTES = ELEMENT_MAP_MAX_PAYLOAD_BYTES * 2

/**
 * Split a stream into the text a terminal should render and the frames it
 * should consume.
 *
 * Keyed on the command number, never on "any OSC": the window title,
 * hyperlinks, clipboard, the shell-integration prompt, iTerm2's 1337 and our
 * sibling 21337 all have to survive. Recognizes the 8-bit C1 forms as well as
 * the ESC-prefixed ones, because a stream relayed through a terminal in 8-bit
 * mode carries 0x9d/0x9c rather than ESC ]/ESC \.
 *
 * A frame that does not decode is dropped and the surrounding text kept: the
 * stripper's first job is to protect the screen, and a corrupt frame must not
 * take the frame's pixels down with it.
 */
export function stripElementMap(
  chunk: string,
  state: StripState,
): { text: string; frames: ElementMapFrame[] } {
  let buffer = state.carry + chunk
  state.carry = ''
  const frames: ElementMapFrame[] = []
  let text = ''

  for (;;) {
    const open = findIntroducer(buffer)
    if (!open) {
      text += keepableTail(buffer, state)
      return { text, frames }
    }
    text += buffer.slice(0, open.index)
    const bodyStart = open.index + open.length
    const end = findTerminator(buffer, bodyStart)
    if (!end) {
      // No terminator yet: the sequence may be completed by the next chunk.
      const partial = buffer.slice(open.index)
      if (partial.length > ELEMENT_MAP_MAX_CARRY_BYTES) {
        state.dropped += 1
        return { text, frames }
      }
      state.carry = partial
      return { text, frames }
    }
    const frame = decodePayload(buffer.slice(bodyStart, end.index))
    if (frame) frames.push(frame)
    else state.dropped += 1
    buffer = buffer.slice(end.index + end.length)
  }
}

/** `ESC ]` and the 8-bit `\u009d`, with our command number and separator. */
function findIntroducer(buffer: string): { index: number; length: number } | null {
  const escaped = buffer.indexOf(ELEMENT_MAP_INTRODUCER)
  const c1 = buffer.indexOf(ELEMENT_MAP_INTRODUCER_C1)
  if (escaped < 0 && c1 < 0) return null
  if (c1 < 0 || (escaped >= 0 && escaped <= c1)) {
    return { index: escaped, length: ELEMENT_MAP_INTRODUCER.length }
  }
  return { index: c1, length: ELEMENT_MAP_INTRODUCER_C1.length }
}

/**
 * Where the sequence starting at `from` ends.
 *
 * `length: 0` means the string was *aborted* rather than terminated: VT ends
 * an OSC at ESC, CAN or SUB and continues parsing what follows. The aborted
 * bytes are machine data and are not printed, but the escape that ended it is
 * the start of a real sequence and has to survive.
 */
function findTerminator(
  buffer: string,
  from: number,
): { index: number; length: number } | null {
  for (let i = from; i < buffer.length; i++) {
    const c = buffer[i]
    if (c === BEL) return { index: i, length: 1 }
    if (c === String.fromCharCode(0x9c)) return { index: i, length: 1 }
    if (c === '\x18' || c === '\x1a') return { index: i, length: 1 }
    if (c === '\x1b') {
      if (i + 1 >= buffer.length) return null // ESC at the end: next chunk decides.
      if (buffer[i + 1] === '\\') return { index: i, length: 2 }
      return { index: i, length: 0 }
    }
  }
  return null
}

/**
 * Text that is definitely not the beginning of an introducer, plus the carry.
 *
 * A chunk can end in the middle of `ESC ] 21338 ;`, so those few trailing
 * bytes are held rather than printed: printing them would put a visible `^[`
 * on screen, and the next chunk completes the sequence.
 */
function keepableTail(buffer: string, state: StripState): string {
  const hold = ELEMENT_MAP_INTRODUCER.length - 1
  // A buffer that is not a prefix at all is text and is printed whole - which
  // is why the length check is inside the loop rather than before it.
  for (let keep = Math.min(hold, buffer.length); keep > 0; keep--) {
    const suffix = buffer.slice(buffer.length - keep)
    if (ELEMENT_MAP_INTRODUCER.startsWith(suffix)) {
      state.carry = suffix
      return buffer.slice(0, buffer.length - keep)
    }
  }
  return buffer
}

function decodePayload(payload: string): ElementMapFrame | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  return isElementMapFrame(parsed) ? parsed : null
}

function isElementMapFrame(value: unknown): value is ElementMapFrame {
  if (typeof value !== 'object' || value === null) return false
  const frame = value as Partial<ElementMapFrame>
  if (frame.v !== 1) return false
  if (!isCount(frame.gen) || !isCount(frame.cols) || !isCount(frame.rows)) return false
  if (!Array.isArray(frame.els)) return false
  return frame.els.every(isMapElement)
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isMapElement(value: unknown): value is MapElement {
  if (typeof value !== 'object' || value === null) return false
  const element = value as Partial<MapElement>
  if (typeof element.id !== 'string' || typeof element.role !== 'string') return false
  const rect = element.r
  if (!Array.isArray(rect) || rect.length !== 4) return false
  if (!rect.every(n => typeof n === 'number' && Number.isFinite(n))) return false
  if (element.label !== undefined && typeof element.label !== 'string') return false
  if (element.act !== undefined && !isMapAction(element.act)) return false
  return true
}

function isMapAction(value: unknown): value is MapAction {
  if (typeof value !== 'object' || value === null) return false
  const action = value as { t?: unknown; x?: unknown; y?: unknown; b?: unknown; d?: unknown }
  switch (action.t) {
    case 'ptr':
      return (
        typeof action.x === 'number' &&
        typeof action.y === 'number' &&
        Number.isFinite(action.x) &&
        Number.isFinite(action.y) &&
        (action.b === 0 || action.b === 1 || action.b === 2)
      )
    case 'key':
      return typeof action.d === 'string' && /^[A-Za-z0-9_-]*$/.test(action.d)
    case 'focus':
    case 'none':
      return true
    default:
      return false
  }
}

export type PublishResult = 'emitted' | 'unchanged' | 'refused'

export type ElementMapPublisherOptions = {
  /** Where a complete sequence goes - the same writer the frame itself is written to. */
  emit: (sequence: string) => void
  /** Called when a frame is refused as oversized, so the caller can log it once. */
  onRefused?: (bytes: number) => void
  /** Heartbeat period. Tests shorten it; production uses the default. */
  heartbeatMs?: number
  /**
   * Timer, injected so tests do not wait and so the emitter can share one
   * scheduler. Returns a cancel function.
   */
  schedule?: (fn: () => void, ms: number) => () => void
}

function defaultSchedule(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms)
  // Must never be the reason a process stays up, only the reason a viewer
  // catches up with a relay that restarted.
  timer.unref?.()
  return () => clearTimeout(timer)
}

/**
 * The emission rules, held apart from the render pass that produces elements.
 *
 * Three rules live here because they are contract, not implementation, and
 * are exactly the kind of thing that diverges when two halves implement them
 * separately:
 *
 * - `gen` advances only after a frame has been written, and only when the map
 *   changed (elements or geometry). A refused frame leaves the previous map
 *   in place and does not burn a generation.
 * - the heartbeat re-sends the last frame unchanged, same `gen`, so a
 *   consumer that dedupes on `gen` pays nothing for it.
 * - the heartbeat runs only while the map is non-empty. An empty map is an
 *   explicit statement - "there are no widgets" - and a consumer must not
 *   paint stale widgets over a blank screen, so it does not need refreshing.
 *
 * The render pass calls publish() on every frame. The publisher decides
 * whether anything goes on the wire.
 */
export class ElementMapPublisher {
  private readonly emit: (sequence: string) => void
  private readonly onRefused: ((bytes: number) => void) | undefined
  private readonly heartbeatMs: number
  private readonly schedule: (fn: () => void, ms: number) => () => void
  private gen = 0
  private last: { key: string; frame: ElementMapFrame; sequence: string } | undefined
  private cancel: (() => void) | undefined
  private stopped = false

  constructor(options: ElementMapPublisherOptions) {
    this.emit = options.emit
    this.onRefused = options.onRefused
    this.heartbeatMs = options.heartbeatMs ?? ELEMENT_MAP_HEARTBEAT_MS
    this.schedule = options.schedule ?? defaultSchedule
  }

  /** The generation of the map currently on the wire. 0 means nothing has been sent. */
  get generation(): number {
    return this.gen
  }

  publish(els: MapElement[], cols: number, rows: number): PublishResult {
    if (this.stopped) return 'unchanged'
    const key = `${cols}x${rows}|${JSON.stringify(els)}`
    if (this.last && this.last.key === key) {
      this.armHeartbeat()
      return 'unchanged'
    }
    const frame: ElementMapFrame = { v: 1, gen: this.gen + 1, cols, rows, els }
    const encoded = encodeElementMap(frame)
    if (!encoded.ok) {
      // Whole frame refused, previous map retained: a truncated sequence would
      // print base64 to the screen, and a partial map is worse than a stale one.
      this.onRefused?.(encoded.bytes)
      this.armHeartbeat()
      return 'refused'
    }
    this.gen += 1
    this.last = { key, frame, sequence: encoded.sequence }
    this.emit(encoded.sequence)
    this.armHeartbeat()
    return 'emitted'
  }

  /** Stop the heartbeat. Idempotent; a stopped publisher emits nothing. */
  stop(): void {
    this.stopped = true
    if (this.cancel) this.cancel()
    this.cancel = undefined
  }

  private armHeartbeat(): void {
    if (this.cancel) this.cancel()
    this.cancel = undefined
    if (!this.last || this.last.frame.els.length === 0) return
    this.cancel = this.schedule(() => {
      if (this.stopped || !this.last) return
      this.emit(this.last.sequence)
      this.armHeartbeat()
    }, this.heartbeatMs)
  }
}
