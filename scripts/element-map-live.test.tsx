import React from 'react'
import { test, expect } from 'bun:test'
import { PassThrough } from 'node:stream'
import { Buffer } from 'buffer'
import { BaseBox, Text, render } from '../src/ink.ts'
import instances from '../src/ink/instances.ts'
import { useDeclaredCursor } from '../src/ink/hooks/use-declared-cursor.ts'
import {
  ELEMENT_MAP_OSC,
  createStripState,
  stripElementMap,
} from '../src/ink/element-map.ts'
import type { ElementMapFrame } from '../src/ink/element-map.ts'
import { ELEMENT_MAP_ENV } from '../src/ink/element-map-emitter.ts'

// End-to-end proof that the REAL render pass emits the element map.
//
// The codec, the stripper, the publisher and the collector each have unit
// tests. What none of them can prove is that a frame going through ink.tsx -
// the renderer the CLI actually runs - reaches the wire at all, with the
// elements the emitter just collected, on the same stream as the pixels.
//
// Everything here is driven through `render()` from src/ink.ts and asserted
// against bytes captured from the stdout the renderer writes to. No PTY, no
// terminal emulator, no heartbeat wait: the heartbeat is covered by the unit
// suite and would need wall-clock time to fire.

const COLUMNS = 80
const ROWS = 24

const INTRODUCER = `\x1b]${ELEMENT_MAP_OSC};`
const ST = '\x1b\\'

type Harness = {
  stdout: any
  stdin: any
  /** Every write() call, in order, decoded as UTF-8. Boundaries are the point. */
  writes: string[]
  capture: () => string
  reset: () => void
  /** Completed render passes, so "unchanged re-render" is proven to be a pass. */
  passes: () => number
  onFrame: () => void
}

function harness(): Harness {
  const stdout = Object.assign(new PassThrough(), {
    columns: COLUMNS,
    rows: ROWS,
    isTTY: true,
  })
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode() {},
    ref() {},
    unref() {},
  })

  const writes: string[] = []
  const realWrite = stdout.write.bind(stdout)
  // Wrap the stream itself, not a 'data' listener: a listener coalesces chunks
  // and would hide a sequence split across two write() calls, which is exactly
  // the invariant this suite exists to check.
  stdout.write = (chunk: unknown, ...rest: unknown[]) => {
    writes.push(
      typeof chunk === 'string'
        ? chunk
        : Buffer.isBuffer(chunk)
          ? chunk.toString('utf8')
          : String(chunk),
    )
    return (realWrite as any)(chunk, ...rest)
  }

  let passCount = 0
  return {
    stdout,
    stdin,
    writes,
    capture: () => writes.join(''),
    reset: () => {
      writes.length = 0
    },
    passes: () => passCount,
    onFrame: () => {
      passCount += 1
    },
  }
}

function tick(): Promise<void> {
  // The renderer only needs a turn of the event loop: in test env commits call
  // onRender directly, and a non-test commit defers it through queueMicrotask.
  return new Promise(resolve => setTimeout(resolve, 0))
}

/** Every complete OSC 21338 sequence in a raw capture, with its byte offsets. */
function sequencesIn(capture: string): Array<{ sequence: string; start: number }> {
  const out: Array<{ sequence: string; start: number }> = []
  const prefix = INTRODUCER
  let from = 0
  for (;;) {
    const start = capture.indexOf(prefix, from)
    if (start < 0) return out
    const bodyStart = start + prefix.length
    const end = capture.indexOf(ST, bodyStart)
    if (end < 0) return out
    const sequence = capture.slice(start, end + ST.length)
    if (/^[A-Za-z0-9_-]+$/.test(capture.slice(bodyStart, end))) {
      out.push({ sequence, start })
    }
    from = end + ST.length
  }
}

function framesOf(capture: string): ElementMapFrame[] {
  const state = createStripState()
  const { frames } = stripElementMap(capture, state)
  // A complete capture must not leave anything in carry: if it did, the
  // sequence we are asserting on was truncated.
  expect(state.carry).toBe('')
  return frames
}

/** Index of the write() call that contains the byte at `offset`. */
function writeAt(writes: string[], offset: number): number {
  let acc = 0
  for (let i = 0; i < writes.length; i++) {
    if (offset < acc + writes[i]!.length) return i
    acc += writes[i]!.length
  }
  return -1
}

/**
 * The capture with the map's own bytes cut out. That is what the terminal
 * should render, computed independently of stripElementMap so the test is not
 * a round trip through the code under test.
 */
function withoutMapBytes(capture: string): string {
  let out = ''
  let cursor = 0
  for (const { sequence, start } of sequencesIn(capture)) {
    out += capture.slice(cursor, start)
    cursor = start + sequence.length
  }
  return out + capture.slice(cursor)
}

// --- the tree --------------------------------------------------------------
//
// A real Ink tree through the same renderer: text, a pointer control, a
// declared-cursor input, and a plain layout box that must stay out of the map.

type Settle = { bump: () => void }

function FocusInput() {
  const ref = useDeclaredCursor({ line: 0, column: 0, active: true })
  return (
    <BaseBox ref={ref} width={20} height={1}>
      <Text>input</Text>
    </BaseBox>
  )
}

function Scene({ title, settle }: { title: string; settle: Settle }) {
  // State that is never rendered: bumping it forces a real render pass with
  // identical output, which is what "unchanged re-render" has to mean.
  const [, setTick] = React.useState(0)
  settle.bump = () => setTick(t => t + 1)
  return (
    <BaseBox flexDirection="column" width="100%">
      <Text>{title}</Text>
      <BaseBox width={12} height={1} onClick={() => {}}>
        <Text>send</Text>
      </BaseBox>
      <FocusInput />
      {/* No label and no handler: structure, not semantics. */}
      <BaseBox width={8} height={1} />
    </BaseBox>
  )
}

/**
 * Render the scene and settle it.
 *
 * The test path commits through onImmediateRender, which runs BEFORE React's
 * layout phase - so the declared cursor from useDeclaredCursor is not visible
 * to the first pass (the hook's own doc says tests compensate this way). One
 * explicit pass reads the declaration; it is also a second real render pass,
 * so it doubles as the "first frame publishes too" check.
 */
async function mount(h: Harness, title: string) {
  const settle: Settle = { bump: () => {} }
  const app = await render(<Scene title={title} settle={settle} />, {
    stdout: h.stdout,
    stderr: h.stdout,
    stdin: h.stdin,
    patchConsole: false,
    exitOnCtrlC: false,
    onFrame: h.onFrame,
  })
  await tick()
  const firstFrameSequences = sequencesIn(h.capture()).length
  ;(instances.get(h.stdout as any) as unknown as { onRender(): void }).onRender()
  await tick()
  return { app, settle, firstFrameSequences }
}

function withEnv<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const saved = process.env[ELEMENT_MAP_ENV]
  if (value === undefined) delete process.env[ELEMENT_MAP_ENV]
  else process.env[ELEMENT_MAP_ENV] = value
  return fn().finally(() => {
    if (saved === undefined) delete process.env[ELEMENT_MAP_ENV]
    else process.env[ELEMENT_MAP_ENV] = saved
  })
}

// --- 1 + 4 (first frame) ---------------------------------------------------

test('a real render emits a decodable element map and adds no pixels', async () => {
  await withEnv('1', async () => {
    const h = harness()
    const { app, firstFrameSequences } = await mount(h, 'alpha')
    try {
      // The publish hook is at the end of the render pass, so the very first
      // frame carries a map - not only later frames.
      expect(firstFrameSequences).toBeGreaterThanOrEqual(1)

      {
        const capture = h.capture()
        const sequences = sequencesIn(capture)
        expect(sequences.length).toBeGreaterThan(0)

        const frames = framesOf(capture)
        expect(frames.length).toBe(sequences.length)

        // The frame the consumer would use: last wins by gen.
        const frame = frames[frames.length - 1]!
        expect(frame.v).toBe(1)
        expect(frame.gen).toBeGreaterThanOrEqual(1)
        expect(frame.cols).toBe(COLUMNS)
        expect(frame.rows).toBe(ROWS)

        const labels = frame.els.map(e => e.label).filter((l): l is string => l !== undefined)
        // The title from the FIRST frame and the settled one (the map is a
        // full list each time, so the last frame carries everything painted).
        expect(labels).toContain('alpha')
        expect(labels).toContain('send')
        expect(labels).toContain('input')

        // Every emitted rect is a real rect inside the frame it describes.
        for (const element of frame.els) {
          const [x, y, w, h] = element.r
          expect(w).toBeGreaterThan(0)
          expect(h).toBeGreaterThan(0)
          expect(x).toBeGreaterThanOrEqual(0)
          expect(y).toBeGreaterThanOrEqual(0)
          expect(x + w).toBeLessThanOrEqual(COLUMNS)
          expect(y + h).toBeLessThanOrEqual(ROWS)
        }

        // The clickable box: pointer-reachable, and the press point must land
        // in the element it describes. The consumer synthesises press+release
        // at this cell through the same hit-test this renderer uses, which
        // treats a rect as half-open [x, x+w) x [y, y+h).
        const pointerControls = frame.els.filter(e => e.act?.t === 'ptr')
        expect(pointerControls.length).toBe(1)
        const clickable = pointerControls[0]!
        expect(clickable.role).toBe('box')
        const [cx, cy, cw, ch] = clickable.r
        expect(clickable.act).toMatchObject({ t: 'ptr', b: 0 })
        if (clickable.act?.t === 'ptr') {
          expect(
            clickable.act.x >= cx &&
              clickable.act.x < cx + cw &&
              clickable.act.y >= cy &&
              clickable.act.y < cy + ch,
            `ptr action ${JSON.stringify(clickable.act)} does not land inside ` +
              `its own rect ${JSON.stringify(clickable.r)}; a synthetic press ` +
              `there misses the control (hit-test is half-open: ` +
              `[x,x+w) x [y,y+h))`,
          ).toBe(true)
        }

        // The declared cursor node is the focus target.
        const focus = frame.els.filter(e => e.act?.t === 'focus')
        expect(focus.length).toBe(1)
        expect(focus[0]!.role).toBe('box')

        // The plain layout box is absent entirely: structure is not semantics.
        const boxes = frame.els.filter(e => e.role === 'box')
        expect(boxes.length).toBe(2) // clickable + focus, nothing else
        expect(boxes.every(e => e.act !== undefined)).toBe(true)

        // (a) the map added no pixels: the stripper's text is exactly the
        // capture with the sequence bytes cut out, computed independently.
        const stripped = stripElementMap(capture, createStripState())
        expect(stripped.text).toBe(withoutMapBytes(capture))
        expect(stripped.text.includes('alpha')).toBe(true)
        expect(stripped.text.includes('send')).toBe(true)
        expect(stripped.text.includes('input')).toBe(true)
        expect(stripped.text.includes(String(ELEMENT_MAP_OSC))).toBe(false)
      }
    } finally {
      app.unmount()
      h.stdin.destroy()
      h.stdout.destroy()
    }
  })
})

// --- 3: one write per sequence ---------------------------------------------

test('each OSC 21338 sequence sits wholly inside one write() call', async () => {
  await withEnv('1', async () => {
    const h = harness()
    const { app } = await mount(h, 'alpha')
    try {
      const capture = h.capture()
      const sequences = sequencesIn(capture)
      expect(sequences.length).toBeGreaterThan(0)

      for (const { sequence, start } of sequences) {
        const first = writeAt(h.writes, start)
        const last = writeAt(h.writes, start + sequence.length - 1)
        expect(first).toBeGreaterThanOrEqual(0)
        // Same call for the introducer and for the final ST. A split sequence
        // would index two calls here.
        expect(last).toBe(first)
        // And that call is exactly the sequence: nothing else rides along,
        // and no prefix/suffix of the sequence is left in another write.
        expect(h.writes[first]).toBe(sequence)
      }

      // The introducer occurs exactly as many times as there are sequences:
      // no second, orphaned introducer inside a frame write.
      expect(capture.split(INTRODUCER).length - 1).toBe(sequences.length)
    } finally {
      app.unmount()
      h.stdin.destroy()
      h.stdout.destroy()
    }
  })
})

// --- 2: the default path ---------------------------------------------------

test('with the gate explicitly off the default path emits no map at all', async () => {
  await withEnv('0', async () => {
    const h = harness()
    const { app } = await mount(h, 'alpha')
    try {
      const capture = h.capture()
      // The frame must still have been drawn: "no map" must not be "nothing".
      expect(capture.length).toBeGreaterThan(0)
      expect(capture.includes('alpha')).toBe(true)
      expect(capture.includes('21338')).toBe(false)
      expect(capture.includes(INTRODUCER)).toBe(false)
    } finally {
      app.unmount()
      h.stdin.destroy()
      h.stdout.destroy()
    }
  })
})

// --- 4: generation through the real render path ----------------------------

test('gen advances on a visible change and not on an unchanged re-render', async () => {
  await withEnv('1', async () => {
    const h = harness()
    const { app: mounted, settle } = await mount(h, 'alpha')
    try {
      const settledFrames = framesOf(h.capture())
      expect(settledFrames.length).toBeGreaterThan(0)
      const baselineGen = settledFrames[settledFrames.length - 1]!.gen
      // The settled map carries the focus target, so it is the complete one.
      expect(settledFrames[settledFrames.length - 1]!.els.some(e => e.act?.t === 'focus')).toBe(true)

      // A real render pass with identical output: React state changes, the
      // painted tree does not. The publisher must dedupe. The pass counter is
      // what stops "no sequence" from passing because nothing rendered.
      h.reset()
      const passesBeforeUnchanged = h.passes()
      settle.bump()
      await tick()
      expect(h.passes()).toBeGreaterThan(passesBeforeUnchanged)
      expect(sequencesIn(h.capture()).length).toBe(0)
      expect(h.capture().includes(INTRODUCER)).toBe(false)

      // A visible change: one new sequence, exactly one generation later.
      h.reset()
      const passesBeforeChange = h.passes()
      mounted.rerender(<Scene title="beta" settle={settle} />)
      await tick()
      expect(h.passes()).toBeGreaterThan(passesBeforeChange)

      const changed = framesOf(h.capture())
      expect(changed.length).toBe(1)
      expect(changed[0]!.gen).toBe(baselineGen + 1)
      const changedLabels = changed[0]!.els
        .map(e => e.label)
        .filter((l): l is string => l !== undefined)
      expect(changedLabels).toContain('beta')
      expect(changedLabels).not.toContain('alpha')
    } finally {
      mounted.unmount()
      h.stdin.destroy()
      h.stdout.destroy()
    }
  })
})
