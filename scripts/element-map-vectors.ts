/**
 * Generates the cross-language fixture for the element map (OSC 21338).
 *
 * Every value in the output is produced by calling the real codec in
 * `src/ink/element-map.ts` - `encodeElementMap`, `stripElementMap`,
 * `keyAction`, `decodeKeyAction` and `ElementMapPublisher`. Nothing here is
 * hand-written, so regenerating after a codec change cannot silently claim a
 * contract the code does not implement.
 *
 *   bun run scripts/element-map-vectors.ts
 *
 * Run it from anywhere; the output path is resolved from this file. The
 * companion test (`element-map-vectors.test.ts`) fails if the committed JSON
 * differs from a fresh run, which is what keeps the fixture from drifting.
 *
 * Encodings, so a consumer in any language cannot mis-read a byte:
 * - `sequence_hex` is the UTF-8 byte encoding of the string `encodeElementMap`
 *   returned (it is ASCII in practice; ST is ESC 0x5c).
 * - `chunks`, `text_hex` and `carry_hex` are the raw stream bytes, with 8-bit
 *   C1 controls represented as their single byte (0x9d / 0x9c), i.e. the
 *   ISO-8859-1 mapping of the JS string the stripper receives.
 */

import { Buffer } from 'buffer'
import { mkdirSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import {
  ELEMENT_MAP_MAX_CARRY_BYTES,
  ELEMENT_MAP_MAX_PAYLOAD_BYTES,
  ELEMENT_MAP_OSC,
  ElementMapPublisher,
  createStripState,
  decodeKeyAction,
  encodeElementMap,
  keyAction,
  stripElementMap,
} from '../src/ink/element-map.ts'
import type {
  ElementMapFrame,
  MapElement,
  PublishResult,
} from '../src/ink/element-map.ts'

const ESC = '\x1b'
const BEL = '\x07'
const ST = ESC + '\\'
const INTRODUCER = `${ESC}]${ELEMENT_MAP_OSC};`
const INTRODUCER_C1 = `${String.fromCharCode(0x9d)}${ELEMENT_MAP_OSC};`

/** Raw stream bytes, C1 controls as single bytes. */
const streamHex = (s: string): string => Buffer.from(s, 'latin1').toString('hex')
const fromStreamHex = (h: string): string => Buffer.from(h, 'hex').toString('latin1')
/** UTF-8 bytes of an emitted sequence. */
const sequenceHex = (s: string): string => Buffer.from(s, 'utf8').toString('hex')

function encodeOk(frame: ElementMapFrame): string {
  const result = encodeElementMap(frame)
  if (!result.ok) throw new Error(`encode refused ${frame.gen}: ${result.bytes} bytes`)
  return result.sequence
}

function frame(gen: number, els: MapElement[], cols = 80, rows = 24): ElementMapFrame {
  return { v: 1, gen, cols, rows, els }
}

// --- codec -----------------------------------------------------------------

const minimalFrame = frame(1, [])

const roleFrame = frame(2, [
  { id: 'e1', role: 'box', r: [0, 0, 80, 2], act: { t: 'ptr', x: 40, y: 1, b: 0 } },
  { id: 'e2', role: 'text', r: [2, 3, 24, 1], label: 'Build passed in 42 s' },
  { id: 'e3', role: 'link', r: [28, 3, 30, 1], label: 'docs.example.com/release-notes' },
  { id: 'e4', role: 'progress', r: [0, 5, 40, 1], label: '40% - indexing' },
  { id: 'e5', role: 'raw', r: [0, 6, 80, 1], label: 'coloured banner text' },
])

const unicodeFrame = frame(2, [
  { id: 'e1', role: 'text', r: [0, 0, 34, 1], label: 'Καλημέρα · 你好 · مرحبا' },
  { id: 'e2', role: 'link', r: [0, 1, 34, 1], label: 'Ελληνικά/中文/🚀' },
  { id: 'e3', role: 'text', r: [0, 2, 34, 1], label: 'e\u0301 (combining) and 𝔘𝔫𝔦𝔠𝔬𝔡𝔢' },
])

// Size boundary: one label sized so the JSON lands just under the cap, then
// one byte more so the same call refuses. Found by asking the encoder.
function sizedFrame(labelLength: number): ElementMapFrame {
  return frame(1, [
    { id: 'e1', role: 'text', r: [0, 0, 200, 60], label: 'x'.repeat(labelLength) },
  ], 200, 60)
}
function jsonBytes(f: ElementMapFrame): number {
  return Buffer.byteLength(JSON.stringify(f), 'utf8')
}
function largestFittingLabel(): number {
  let lo = 0
  let hi = ELEMENT_MAP_MAX_PAYLOAD_BYTES * 2
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (jsonBytes(sizedFrame(mid)) <= ELEMENT_MAP_MAX_PAYLOAD_BYTES) lo = mid
    else hi = mid - 1
  }
  return lo
}
const fittingLabel = largestFittingLabel()
const underFrame = sizedFrame(fittingLabel)
const overFrame = sizedFrame(fittingLabel + 1)

const keyBytes = ESC + '[A'
const keyAct = keyAction(keyBytes)
const keyDecoded = decodeKeyAction(keyAct as { t: 'key'; d: string })

const actFrame = frame(3, [
  { id: 'p', role: 'box', r: [0, 0, 4, 1], act: { t: 'ptr', x: 2, y: 0, b: 0 } },
  { id: 'f', role: 'text', r: [0, 1, 12, 1], label: 'type here', act: { t: 'focus' } },
  { id: 'n', role: 'text', r: [0, 2, 12, 1], label: 'display only', act: { t: 'none' } },
  { id: 'a', role: 'text', r: [0, 3, 12, 1], label: 'action absent' },
  { id: 'k', role: 'text', r: [0, 4, 12, 1], label: 'key only', act: keyAct },
])

const overResult = encodeElementMap(overFrame)
if (overResult.ok) throw new Error('over-cap frame was accepted')

const codec = {
  osc: ELEMENT_MAP_OSC,
  max_payload_bytes: ELEMENT_MAP_MAX_PAYLOAD_BYTES,
  max_carry_bytes: ELEMENT_MAP_MAX_CARRY_BYTES,
  entries: [
    {
      name: 'minimal-empty',
      ok: true,
      frame: minimalFrame,
      payload_bytes: jsonBytes(minimalFrame),
      sequence_hex: sequenceHex(encodeOk(minimalFrame)),
    },
    {
      name: 'roles-box-text-link-progress-raw',
      ok: true,
      frame: roleFrame,
      payload_bytes: jsonBytes(roleFrame),
      sequence_hex: sequenceHex(encodeOk(roleFrame)),
    },
    {
      name: 'unicode-label',
      ok: true,
      frame: unicodeFrame,
      payload_bytes: jsonBytes(unicodeFrame),
      sequence_hex: sequenceHex(encodeOk(unicodeFrame)),
    },
    {
      name: 'size-boundary-under',
      ok: true,
      frame: underFrame,
      payload_bytes: jsonBytes(underFrame),
      sequence_hex: sequenceHex(encodeOk(underFrame)),
    },
    {
      name: 'size-boundary-over',
      ok: false,
      frame: overFrame,
      payload_bytes: jsonBytes(overFrame),
      reason: (overResult as { ok: false; reason: 'too-large'; bytes: number }).reason,
      bytes: (overResult as { ok: false; reason: 'too-large'; bytes: number }).bytes,
    },
    {
      name: 'actions-ptr-focus-none-absent-key',
      ok: true,
      frame: actFrame,
      payload_bytes: jsonBytes(actFrame),
      sequence_hex: sequenceHex(encodeOk(actFrame)),
      key_roundtrip: {
        bytes_hex: streamHex(keyBytes),
        d: (keyAct as { t: 'key'; d: string }).d,
        decoded_hex: streamHex(keyDecoded),
        equal: keyDecoded === keyBytes,
      },
    },
  ],
}

// --- strip -----------------------------------------------------------------

type StripExpect = {
  text_hex: string
  frames: ElementMapFrame[]
  carry_hex: string
  dropped: number
}

type StripCase = { name: string; chunks: string[]; expect: StripExpect[] }

function stripCase(name: string, rawChunks: string[]): StripCase {
  // The fixture carries bytes; drive the stripper from those exact bytes so a
  // C1 control in a case cannot be widened by a string round-trip.
  const chunks = rawChunks.map(streamHex)
  const state = createStripState()
  const expect = chunks.map(chunk => {
    const result = stripElementMap(fromStreamHex(chunk), state)
    return {
      text_hex: streamHex(result.text),
      frames: result.frames,
      carry_hex: streamHex(state.carry),
      dropped: state.dropped,
    }
  })
  return { name, chunks, expect }
}

/** A small frame so the exhaustive split case stays loadable. */
const tinySequence = encodeOk(minimalFrame)
const splitCases: StripCase[] = []
for (let offset = 1; offset < tinySequence.length; offset++) {
  splitCases.push(
    stripCase(`split-empty-frame-at-${offset}`, [
      tinySequence.slice(0, offset),
      tinySequence.slice(offset),
    ]),
  )
}

/** Representative cut points on a larger frame: introducer, base64, ST. */
const bigFrame = frame(7, [
  { id: 'e1', role: 'text', r: [0, 0, 60, 1], label: 'a representative line of terminal text '.repeat(4).trim() },
  { id: 'e2', role: 'box', r: [0, 1, 60, 6], act: { t: 'ptr', x: 30, y: 3, b: 0 } },
])
const bigSequence = encodeOk(bigFrame)
const bigOffsets = [1, 2, 3, 4, 5, 6, 7, 8, 12, 20, 40, 60,
  Math.floor(bigSequence.length / 2), bigSequence.length - 8,
  bigSequence.length - 3, bigSequence.length - 2, bigSequence.length - 1]
const bigSplitCases = [...new Set(bigOffsets)]
  .filter(o => o > 0 && o < bigSequence.length)
  .map(o => stripCase(`split-large-frame-at-${o}`, [bigSequence.slice(0, o), bigSequence.slice(o)]))

const frameA = frame(1, [{ id: 'e1', role: 'text', r: [0, 0, 5, 1], label: 'one' }])
const frameB = frame(2, [{ id: 'e1', role: 'text', r: [0, 0, 5, 1], label: 'two' }])
const seqA = encodeOk(frameA)
const seqB = encodeOk(frameB)

const corruptFrames: Array<[string, string]> = [
  ['not-base64url', `${INTRODUCER}!!!!;!!!${ST}`],
  ['valid-base64url-of-v2', encodeOk({ v: 2 as unknown as 1, gen: 1, cols: 80, rows: 24, els: [] })],
  ['malformed-action', `${INTRODUCER}${Buffer.from(JSON.stringify({
    v: 1, gen: 1, cols: 80, rows: 24,
    els: [{ id: 'x', role: 'text', r: [0, 0, 1, 1], act: { t: 'ptr', x: 1 } }],
  }), 'utf8').toString('base64url')}${ST}`],
]

const neighbours =
  `before${ESC}]0;window title${BEL}` +
  `mid${ESC}]8;;https://example.com${ST}` +
  `after${ESC}]21337;status=thinking;status-color=#ff8800${BEL}` +
  `end`

const c1Sequence = `${INTRODUCER_C1}${Buffer.from(JSON.stringify(minimalFrame), 'utf8').toString('base64url')}${String.fromCharCode(0x9c)}`

const overflowPayload =
  INTRODUCER + 'A'.repeat(ELEMENT_MAP_MAX_CARRY_BYTES)
const resyncSequence = encodeOk(frame(9, [{ id: 'e1', role: 'text', r: [0, 0, 6, 1], label: 'again' }]))

const strip: StripCase[] = [
  stripCase('whole-frame-st', [tinySequence]),
  stripCase('whole-frame-bel', [tinySequence.slice(0, -2) + BEL]),
  ...splitCases,
  ...bigSplitCases,
  stripCase('two-frames-one-chunk', ['L' + seqA + seqB + 'R']),
  stripCase('two-frames-split-with-text-between', [
    'pre' + seqA.slice(0, 23),
    seqA.slice(23) + 'between' + seqB,
    'post',
  ]),
  stripCase('frame-followed-by-text', [tinySequence + 'tail text']),
  stripCase('frame-preceded-by-text', ['head text' + tinySequence]),
  stripCase('non-21338-osc-pass-through', [neighbours]),
  stripCase('c1-introducer-and-terminator', [c1Sequence]),
  stripCase('no-semicolon-is-not-ours-passes-through', [
    `${ESC}]${ELEMENT_MAP_OSC}PAYLOAD${BEL}tail`,
  ]),
  stripCase('leading-zero-command-passes-through', [
    `${ESC}]00${ELEMENT_MAP_OSC};abc${BEL}tail`,
  ]),
  stripCase('c1-partial-introducer-held-then-completed', [
    'x' + `${String.fromCharCode(0x9d)}213`,
    '38;' + Buffer.from(JSON.stringify(minimalFrame), 'utf8').toString('base64url') +
      String.fromCharCode(0x9c),
  ]),
  stripCase('abort-esc-other-sequence', ['A' + INTRODUCER + 'AAAA' + `${ESC}[31m` + 'B']),
  stripCase('abort-after-valid-frame', ['A' + tinySequence.slice(0, -2) + `${ESC}[31m` + 'B']),
  stripCase('abort-can', ['A' + INTRODUCER + 'AAAA' + '\x18' + 'B']),
  stripCase('abort-sub', ['A' + INTRODUCER + 'AAAA' + '\x1a' + 'B']),
  stripCase('carry-overflow-then-resync', [
    'A' + overflowPayload,
    'B' + resyncSequence + 'C',
  ]),
  stripCase('corrupt-not-base64url', ['L' + corruptFrames[0]![1] + 'R']),
  stripCase('corrupt-v2', ['L' + corruptFrames[1]![1] + 'R']),
  stripCase('corrupt-malformed-action', ['L' + corruptFrames[2]![1] + 'R']),
  stripCase('partial-introducer-held-then-completed', [
    'hi' + `${ESC}]21`,
    '338;' + Buffer.from(JSON.stringify(minimalFrame), 'utf8').toString('base64url') + ST + 'bye',
  ]),
  stripCase('partial-introducer-esc-only-held', [
    'x' + ESC,
    ']' + '21338;' + Buffer.from(JSON.stringify(minimalFrame), 'utf8').toString('base64url') + ST,
  ]),
  stripCase('tail-that-looks-suggestive-is-text', ['abcv1.2133', 'DEF']),
]

const stripSection = { entries: strip }

// --- publisher -------------------------------------------------------------

type PublisherStep =
  | { els: MapElement[]; cols: number; rows: number }
  | { fire_timer: true }

type PublisherCase = {
  name: string
  steps: PublisherStep[]
  expect: {
    results: PublishResult[]
    generations: number[]
    emitted_count: number
    heartbeat_fires: number
    emitted_hex: string[]
    /** Set when a heartbeat re-sent the frame that was already on the wire. */
    heartbeat_repeats_previous?: boolean
  }
}

function publisherCase(name: string, steps: PublisherStep[], stoppedAt?: number): PublisherCase {
  const emitted: string[] = []
  let heartbeatFires = 0
  let timer: { fn: () => void; cancelled: boolean } | null = null
  const schedule = (fn: () => void, _ms: number): (() => void) => {
    const entry = { fn, cancelled: false }
    timer = entry
    return () => {
      entry.cancelled = true
    }
  }
  const publisher = new ElementMapPublisher({
    emit: sequence => {
      emitted.push(sequence)
    },
    heartbeatMs: 10_000,
    schedule,
  })
  const results: PublishResult[] = []
  const generations: number[] = []
  steps.forEach((step, index) => {
    if (stoppedAt !== undefined && index === stoppedAt) publisher.stop()
    if ('fire_timer' in step) {
      const entry = timer
      timer = null
      if (entry && !entry.cancelled) {
        entry.cancelled = true
        const before = emitted.length
        entry.fn()
        if (emitted.length > before) heartbeatFires += 1
      }
      return
    }
    results.push(publisher.publish(step.els, step.cols, step.rows))
    generations.push(publisher.generation)
  })
  publisher.stop()
  return {
    name,
    steps,
    expect: {
      results,
      generations,
      emitted_count: emitted.length,
      heartbeat_fires: heartbeatFires,
      emitted_hex: emitted.map(sequenceHex),
    },
  }
}

const plainEls: MapElement[] = [
  { id: 'e1', role: 'text', r: [0, 0, 12, 1], label: 'hello' },
]
const changedEls: MapElement[] = [
  { id: 'e1', role: 'text', r: [0, 0, 12, 1], label: 'hello there' },
]
const oversizeEls: MapElement[] = [
  { id: 'e1', role: 'text', r: [0, 0, 200, 60], label: 'y'.repeat(ELEMENT_MAP_MAX_PAYLOAD_BYTES + 1024) },
]

const publisherSection = {
  entries: [
    publisherCase('unchanged-rerender', [
      { els: plainEls, cols: 80, rows: 24 },
      { els: plainEls, cols: 80, rows: 24 },
    ]),
    publisherCase('changed-elements-bump-gen', [
      { els: plainEls, cols: 80, rows: 24 },
      { els: changedEls, cols: 80, rows: 24 },
    ]),
    publisherCase('resize-with-same-elements-bumps-gen', [
      { els: plainEls, cols: 80, rows: 24 },
      { els: plainEls, cols: 100, rows: 24 },
    ]),
    (() => {
      const c = publisherCase('refused-leaves-previous-map-then-heartbeat-resends-it', [
        { els: plainEls, cols: 80, rows: 24 },
        { els: oversizeEls, cols: 80, rows: 24 },
        { fire_timer: true },
      ])
      c.expect.heartbeat_repeats_previous =
        c.expect.emitted_hex.length === 2 && c.expect.emitted_hex[0] === c.expect.emitted_hex[1]
      return c
    })(),
    (() => {
      const c = publisherCase('publish-does-not-restart-the-heartbeat', [
        { els: plainEls, cols: 80, rows: 24 },
        { els: changedEls, cols: 80, rows: 24 },
        { fire_timer: true },
      ])
      c.expect.heartbeat_repeats_previous =
        c.expect.emitted_hex.length === 3 &&
        c.expect.emitted_hex[1] === c.expect.emitted_hex[2]
      return c
    })(),
    publisherCase('empty-map-cancels-the-heartbeat', [
      { els: plainEls, cols: 80, rows: 24 },
      { els: [], cols: 80, rows: 24 },
      { fire_timer: true },
    ]),
    publisherCase('empty-map-emitted-no-heartbeat', [
      { els: [], cols: 80, rows: 24 },
      { fire_timer: true },
    ]),
    publisherCase('stopped-emits-nothing', [
      { els: plainEls, cols: 80, rows: 24 },
      { els: changedEls, cols: 80, rows: 24 },
      { fire_timer: true },
    ], 1),
  ],
}

// --- assemble --------------------------------------------------------------

export function buildVectors(): string {
  return (
    JSON.stringify(
      {
        meta: {
          osc: ELEMENT_MAP_OSC,
          introducer_esc_hex: streamHex(INTRODUCER),
          introducer_c1_hex: streamHex(INTRODUCER_C1),
          st_hex: streamHex(ST),
          bel_hex: streamHex(BEL),
          max_payload_bytes: ELEMENT_MAP_MAX_PAYLOAD_BYTES,
          max_carry_bytes: ELEMENT_MAP_MAX_CARRY_BYTES,
          heartbeat_ms: 10_000,
          sequence_hex_encoding: 'utf-8',
          stream_hex_encoding: 'latin1 (C1 controls as one byte: 0x9d, 0x9c)',
          strip_expect_semantics:
            'one entry per chunk, in order; dropped is cumulative; carry is the state after that chunk',
          publisher_expect_semantics:
            'results and generations hold one entry per publish step (fire_timer steps produce neither); emitted_hex lists every sequence written',
          generated_by: 'scripts/element-map-vectors.ts',
        },
        codec,
        strip: stripSection,
        publisher: publisherSection,
      },
      null,
      2,
    ) + '\n'
  )
}

const OUT_PATH = fileURLToPath(
  new URL('../contracts/element-map-21338/element-map-vectors.json', import.meta.url),
)

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  mkdirSync(dirname(OUT_PATH), { recursive: true })
  writeFileSync(OUT_PATH, buildVectors())
  console.log(`wrote ${OUT_PATH}`)
}
