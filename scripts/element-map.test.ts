import { test, expect } from 'bun:test'
import { Buffer } from 'buffer'
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
import type { ElementMapFrame, MapElement } from '../src/ink/element-map.ts'

// The element map rides the terminal stream, so the properties that matter
// cannot be checked by round-tripping through the same function:
//
//  1. The encoded sequence must contain nothing that can end an OSC early,
//     or the payload prints to the screen as text.
//  2. The stripper must survive a stream cut at an arbitrary byte - every
//     relay in the path frames its own way, so a boundary can fall anywhere
//     inside the sequence - and must leave every other escape sequence
//     untouched.
//  3. The publisher's three rules (gen on change only, heartbeat repeats the
//     same gen, no heartbeat for an empty map) are contract, not implementation.
//
// All three are asserted against real bytes, not against the codec's own view.

const INTRODUCER = `\x1b]${ELEMENT_MAP_OSC};`
const ST = '\x1b\\'

function frame(gen: number, els: MapElement[] = []): ElementMapFrame {
  return { v: 1, gen, cols: 80, rows: 24, els }
}

function encodeOk(f: ElementMapFrame): string {
  const result = encodeElementMap(f)
  if (!result.ok) throw new Error(`encode refused: ${result.reason}`)
  return result.sequence
}

function payloadOf(sequence: string): string {
  return sequence.slice(INTRODUCER.length, sequence.length - ST.length)
}

// --- encode ---------------------------------------------------------------

test('the sequence is introducer, base64url, ST - and carries nothing that can end it early', () => {
  const els: MapElement[] = [
    { id: 'prompt', role: 'text-input', r: [0, 22, 80, 1], label: '> ', act: { t: 'focus' } },
    // Every character a naive framing would break on, in the label.
    { id: 'send', role: 'button', r: [70, 22, 10, 1], label: 'send; now\x07 \x1b\\ \u009c ✓', act: { t: 'ptr', x: 75, y: 22, b: 0 } },
  ]
  const sequence = encodeOk(frame(7, els))

  expect(sequence.startsWith(INTRODUCER)).toBe(true)
  expect(sequence.endsWith(ST)).toBe(true)

  const payload = payloadOf(sequence)
  // base64url alphabet only: no separator, no BEL, no ESC, no C1 ST.
  expect(payload).toMatch(/^[A-Za-z0-9_-]+$/)
  expect(sequence.indexOf('\x07')).toBe(-1)
  expect(sequence.indexOf('\x9c')).toBe(-1)
  // Exactly one ESC pair, at the very end.
  expect(sequence.split('\x1b').length - 1).toBe(2)
})

test('a key action carries no raw escape characters either', () => {
  const bytes = '\x1b[13;2u'
  const action = keyAction(bytes)
  expect(action.t).toBe('key')
  if (action.t === 'key') expect(action.d).toMatch(/^[A-Za-z0-9_-]+$/)
  expect(decodeKeyAction(action as { t: 'key'; d: string })).toBe(bytes)

  const sequence = encodeOk(frame(1, [{ id: 'k', role: 'button', r: [0, 0, 1, 1], act: action }]))
  expect(sequence.indexOf('\x1b')).toBe(0) // the introducer, and nothing inside
  expect(sequence.split('\x1b').length - 1).toBe(2)
})

test('a frame over the payload cap is refused whole, never truncated', () => {
  const big = 'x'.repeat(ELEMENT_MAP_MAX_PAYLOAD_BYTES)
  const result = encodeElementMap(frame(1, [{ id: 'a', role: 'text', r: [0, 0, 1, 1], label: big }]))
  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.reason).toBe('too-large')
    expect(result.bytes).toBeGreaterThan(ELEMENT_MAP_MAX_PAYLOAD_BYTES)
  }
})

// --- strip: the round trip ------------------------------------------------

test('surrounding text and unrelated escapes survive untouched', () => {
  const sequence = encodeOk(frame(3, [{ id: 'b', role: 'button', r: [1, 2, 3, 4], act: { t: 'ptr', x: 2, y: 3, b: 0 } }]))
  const before = 'hello \x1b[31mred\x1b[0m '
  const title = '\x1b]0;a window title\x07'
  const link = '\x1b]8;;https://example.test\x07link\x1b]8;;\x07'
  const sibling = `\x1b]21337;status=busy\x07`
  const after = ' world\n'

  const state = createStripState()
  const out = stripElementMap(`${before}${title}${link}${sibling}${sequence}${after}`, state)

  expect(out.text).toBe(`${before}${title}${link}${sibling}${after}`)
  expect(out.frames).toHaveLength(1)
  expect(out.frames[0]!.gen).toBe(3)
  expect(out.frames[0]!.els[0]).toEqual({
    id: 'b',
    role: 'button',
    r: [1, 2, 3, 4],
    act: { t: 'ptr', x: 2, y: 3, b: 0 },
  })
  expect(state.carry).toBe('')
  expect(state.dropped).toBe(0)
})

test('two frames in one chunk, with text between them', () => {
  const a = encodeOk(frame(1))
  const b = encodeOk(frame(2, [{ id: 'x', role: 'text', r: [0, 0, 1, 1] }]))
  const out = stripElementMap(`one${a}two${b}three`, createStripState())
  expect(out.text).toBe('onetwothree')
  expect(out.frames.map(f => f.gen)).toEqual([1, 2])
})

// --- strip: every chunk boundary ------------------------------------------

test('a stream cut at every offset still yields exactly one frame and no leaked bytes', () => {
  const sequence = encodeOk(frame(9, [{ id: 'e', role: 'button', r: [5, 6, 7, 8], label: 'ok' }]))
  const stream = `A${sequence}B`

  for (let cut = 1; cut < stream.length; cut++) {
    const state = createStripState()
    const first = stripElementMap(stream.slice(0, cut), state)
    const second = stripElementMap(stream.slice(cut), state)

    const text = first.text + second.text
    const frames = [...first.frames, ...second.frames]

    expect({ cut, text }).toEqual({ cut, text: 'AB' })
    expect({ cut, frames: frames.length }).toEqual({ cut, frames: 1 })
    expect(frames[0]!.gen).toBe(9)
    expect(state.carry).toBe('')
  }
})

test('a stream cut into every pair of pieces (three chunks) still decodes', () => {
  const sequence = encodeOk(frame(4, [{ id: 'q', role: 'text', r: [0, 0, 2, 2], label: 'hi' }]))
  const stream = `pre${sequence}post`

  for (let a = 1; a < stream.length - 1; a++) {
    for (let b = a + 1; b < stream.length; b++) {
      const state = createStripState()
      const out = [
        stripElementMap(stream.slice(0, a), state),
        stripElementMap(stream.slice(a, b), state),
        stripElementMap(stream.slice(b), state),
      ]
      const text = out.map(o => o.text).join('')
      const frames = out.flatMap(o => o.frames)
      expect({ a, b, text }).toEqual({ a, b, text: 'prepost' })
      expect({ a, b, frames: frames.length }).toEqual({ a, b, frames: 1 })
    }
  }
})

test('a partial introducer at a chunk edge is held, not printed as ^[', () => {
  const state = createStripState()
  const first = stripElementMap('text\x1b]21', state)
  // The ESC ] 2 1 could be the start of our sequence: hold it, print the rest.
  expect(first.text).toBe('text')

  const sequence = encodeOk(frame(1))
  const second = stripElementMap(sequence.slice(4) + 'after', state)
  expect(second.text).toBe('after')
  expect(second.frames).toHaveLength(1)
})

// --- strip: corruption ----------------------------------------------------

test('an unterminated sequence is held, then abandoned at the carry cap', () => {
  const state = createStripState()
  const head = stripElementMap(`ok${INTRODUCER}`, state)
  expect(head.text).toBe('ok')
  expect(state.carry).toBe(INTRODUCER)

  const flood = stripElementMap('A'.repeat(ELEMENT_MAP_MAX_CARRY_BYTES + 10), state)
  expect(flood.text).toBe('') // machine data is never printed
  expect(state.dropped).toBe(1)
  expect(state.carry).toBe('')

  const recovered = stripElementMap(`x${encodeOk(frame(11))}y`, state)
  expect(recovered.text).toBe('xy')
  expect(recovered.frames.map(f => f.gen)).toEqual([11])
})

test('a corrupt payload is dropped without taking the surrounding text down', () => {
  const state = createStripState()
  const out = stripElementMap(`left${INTRODUCER}not!base64!${ST}right`, state)
  expect(out.text).toBe('leftright')
  expect(out.frames).toHaveLength(0)
  expect(state.dropped).toBe(1)
})

test('a well-formed base64 payload of the wrong shape is dropped', () => {
  const state = createStripState()
  const wrong = Buffer.from(JSON.stringify({ v: 2, gen: 1, cols: 1, rows: 1, els: [] })).toString('base64url')
  const out = stripElementMap(`a${INTRODUCER}${wrong}${ST}b`, state)
  expect(out.text).toBe('ab')
  expect(out.frames).toHaveLength(0)
  expect(state.dropped).toBe(1)
})

test('an element with a malformed action is rejected, not half-accepted', () => {
  const state = createStripState()
  const bad = Buffer.from(
    JSON.stringify({ v: 1, gen: 1, cols: 1, rows: 1, els: [{ id: 'x', role: 'button', r: [0, 0, 1, 1], act: { t: 'ptr', x: 1 } }] }),
  ).toString('base64url')
  const out = stripElementMap(`${INTRODUCER}${bad}${ST}`, state)
  expect(out.frames).toHaveLength(0)
  expect(state.dropped).toBe(1)
})

test('a BEL-terminated sequence decodes too, in case an emitter picks BEL', () => {
  const sequence = encodeOk(frame(2)).replace(ST, '\x07')
  const out = stripElementMap(`a${sequence}b`, createStripState())
  expect(out.text).toBe('ab')
  expect(out.frames.map(f => f.gen)).toEqual([2])
})

test('the 8-bit C1 forms decode as well as the ESC forms', () => {
  const sequence = encodeOk(frame(5))
  const c1 = `\u009d${ELEMENT_MAP_OSC};${payloadOf(sequence)}\u009cb`
  const out = stripElementMap(`a${c1}`, createStripState())
  expect(out.text).toBe('ab')
  expect(out.frames.map(f => f.gen)).toEqual([5])
})

test('an ESC aborts the string and that escape survives as text for the terminal', () => {
  const state = createStripState()
  const out = stripElementMap(`${INTRODUCER}partial\x1b[31mred`, state)
  // The corrupt payload is not printed; the colour sequence that ended it is.
  expect(out.text).toBe('\x1b[31mred')
  expect(out.frames).toHaveLength(0)
})

// --- publisher ------------------------------------------------------------

function recorder() {
  const emitted: string[] = []
  return { emitted, emit: (sequence: string) => { emitted.push(sequence) } }
}

function manualSchedule() {
  const timers: { fn: () => void; cancelled: boolean }[] = []
  return {
    schedule: (fn: () => void) => {
      const timer = { fn, cancelled: false }
      timers.push(timer)
      return () => { timer.cancelled = true }
    },
    fire() {
      const due = timers.filter(t => !t.cancelled)
      timers.length = 0
      for (const timer of due) timer.fn()
    },
    pending: () => timers.filter(t => !t.cancelled).length,
    /** Identity of the single live timer, so a test can prove it was not replaced. */
    live: () => timers.filter(t => !t.cancelled)[0],
  }
}

const BUTTON: MapElement[] = [{ id: 'send', role: 'button', r: [1, 1, 4, 1], act: { t: 'ptr', x: 2, y: 1, b: 0 } }]

test('gen advances on change only, and an unchanged frame puts nothing on the wire', () => {
  const { emitted, emit } = recorder()
  const scheduler = manualSchedule()
  const publisher = new ElementMapPublisher({ emit, schedule: scheduler.schedule })

  expect(publisher.publish(BUTTON, 80, 24)).toBe('emitted')
  expect(publisher.generation).toBe(1)

  expect(publisher.publish(BUTTON, 80, 24)).toBe('unchanged')
  expect(publisher.generation).toBe(1)
  expect(emitted).toHaveLength(1)

  expect(publisher.publish([...BUTTON, { id: 'foot', role: 'text', r: [0, 23, 80, 1] }], 80, 24)).toBe('emitted')
  expect(publisher.generation).toBe(2)
  expect(emitted).toHaveLength(2)

  // A resize changes the frame the consumer must trust, so it is a change.
  expect(publisher.publish([...BUTTON, { id: 'foot', role: 'text', r: [0, 23, 80, 1] }], 100, 30)).toBe('emitted')
  expect(publisher.generation).toBe(3)

  const gens = emitted.map(s => (JSON.parse(Buffer.from(payloadOf(s), 'base64url').toString('utf8')) as ElementMapFrame).gen)
  expect(gens).toEqual([1, 2, 3])
})

test('the heartbeat re-sends the last frame with the same gen', () => {
  const { emitted, emit } = recorder()
  const scheduler = manualSchedule()
  const publisher = new ElementMapPublisher({ emit, schedule: scheduler.schedule })

  publisher.publish(BUTTON, 80, 24)
  expect(scheduler.pending()).toBe(1)

  scheduler.fire()
  expect(emitted).toHaveLength(2)
  expect(emitted[1]).toBe(emitted[0])
  // Re-armed, so a relay that restarts later still catches up.
  expect(scheduler.pending()).toBe(1)

  publisher.stop()
  expect(scheduler.pending()).toBe(0)
})

test('a publish does not restart the heartbeat countdown', () => {
  // The re-send is periodic, not a quiet timer. If publishing reset it, a stream
  // of frames that never change the map would suppress the heartbeat forever
  // and a relay that restarted mid-stream would never recover.
  const { emitted, emit } = recorder()
  const scheduler = manualSchedule()
  const publisher = new ElementMapPublisher({ emit, schedule: scheduler.schedule })

  publisher.publish(BUTTON, 80, 24)
  const armed = scheduler.live()
  expect(armed).toBeDefined()

  publisher.publish([...BUTTON, { id: 'foot', role: 'text', r: [0, 23, 80, 1] }], 80, 24)
  expect(scheduler.live()).toBe(armed!) // same timer, not a replacement

  publisher.publish([], 80, 24) // the empty map is the one thing that cancels it
  expect(scheduler.pending()).toBe(0)

  scheduler.fire() // nothing was armed, so nothing is re-sent
  expect(emitted).toHaveLength(3) // BUTTON, the change, and the empty map
})

test('an empty map is explicit, and it carries no heartbeat', () => {
  const { emitted, emit } = recorder()
  const scheduler = manualSchedule()
  const publisher = new ElementMapPublisher({ emit, schedule: scheduler.schedule })

  expect(publisher.publish([], 80, 24)).toBe('emitted')
  expect(publisher.generation).toBe(1)
  expect(scheduler.pending()).toBe(0)

  const sent = JSON.parse(Buffer.from(payloadOf(emitted[0]!), 'base64url').toString('utf8')) as ElementMapFrame
  expect(sent.els).toEqual([])
})

test('a refused frame leaves the previous map on the wire and does not burn a generation', () => {
  const { emitted, emit } = recorder()
  const scheduler = manualSchedule()
  const refusals: number[] = []
  const publisher = new ElementMapPublisher({
    emit,
    schedule: scheduler.schedule,
    onRefused: bytes => { refusals.push(bytes) },
  })

  publisher.publish(BUTTON, 80, 24)
  const huge: MapElement[] = [{ id: 'x', role: 'text', r: [0, 0, 1, 1], label: 'y'.repeat(ELEMENT_MAP_MAX_PAYLOAD_BYTES) }]

  expect(publisher.publish(huge, 80, 24)).toBe('refused')
  expect(publisher.generation).toBe(1)
  expect(refusals).toHaveLength(1)
  expect(emitted).toHaveLength(1)

  // The heartbeat still emits the map that is actually on the wire.
  scheduler.fire()
  expect(emitted).toHaveLength(2)
  expect(emitted[1]).toBe(emitted[0])
})

test('a stopped publisher emits nothing, even if the render pass keeps calling it', () => {
  const { emitted, emit } = recorder()
  const publisher = new ElementMapPublisher({ emit, schedule: manualSchedule().schedule })
  publisher.publish(BUTTON, 80, 24)
  publisher.stop()
  expect(publisher.publish([], 80, 24)).toBe('unchanged')
  expect(emitted).toHaveLength(1)
})
