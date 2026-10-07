import React from 'react'
import { test, expect } from 'bun:test'
import { PassThrough } from 'node:stream'
import { render, Box, Text, useInput } from '../src/ink.ts'
import { BoundedMainScreen } from '../src/ink/components/BoundedMainScreen.tsx'
import instances from '../src/ink/instances.ts'
import { getIsInteractive, setIsInteractive } from '../src/bootstrap/state.ts'
import { expectStandardCursorPosition } from '../src/ink/parse-keypress.ts'
import type { ParsedMouse } from '../src/ink/parse-keypress.ts'

// Fix #2 (follows 0222bde): the inline lane must not ARM a wrong origin, and a
// new viewer means new cursor truth.
//
// Live: a late mux attach answers the CPR probe while the client is still
// settling its geometry (the browser xterm reports 48 then 47 rows). The reply
// carries the client's cursor at the bottom of its freshly-scrolled buffer while
// the app's block is parked higher, so the probe yielded origin=4. The lane armed
// with it and never re-probed (geometry did not change again), so EVERY click was
// translated 4 rows off — the Led press at client row 45 mapped to app row 40,
// `decideInlineMouse` returned downMiss, and the click was dropped (the lane was
// armed, so it was not merely "not yet ready"). Resizing re-armed at origin=0 and
// the same click opened the chooser.
//
// Three contracts:
//   1. requestViewerRepaint (the FOCUS_IN attach/resync path) abandons any
//      in-flight probe and re-probes, WITHOUT clearing the current origin — a
//      new viewer means new cursor truth, and clicks keep working until the new
//      reply swaps the origin atomically (never disarm-then-dead-click).
//   2. resolveInlineProbeArm rejects an origin that would place the rendered
//      block outside the viewport (origin < 0, or origin + blockRows > rows).
//      In a bounded layout the block IS the viewport, so only origin 0 can arm.
//   3. An arm that followed a resize or attach re-probes once after a settle and
//      adopts the origin if it moved — one confirmation, never a loop.
//
// The lane is driven on the REAL Ink instance (as app-mouse-inline-real does)
// with a fake querier that mirrors TerminalQuerier's contract, including the
// abort cancel from 0222bde.

const LEFT = 0

function press(col: number, row: number): ParsedMouse {
  return { kind: 'mouse', button: LEFT, action: 'press', col: col + 1, row: row + 1, sequence: '' }
}
function release(col: number, row: number): ParsedMouse {
  return { kind: 'mouse', button: LEFT, action: 'release', col: col + 1, row: row + 1, sequence: '' }
}

// ---------------------------------------------------------------------------
// (2) The plausibility rule, pure — no renderer.
// ---------------------------------------------------------------------------
test('resolveInlineProbeArm rejects an origin that puts the block outside the viewport', async () => {
  const { resolveInlineProbeArm } = await import('../src/ink/ink.tsx')
  // 47 rows, block 47 tall (a bounded block is the viewport): the origin must be
  // 0. The live late-attach reply (row 47 against a cursor parked at 42) yields
  // origin 4, which would place the block's last row at 50 — past the viewport.
  const cursor = { x: 0, y: 42 }
  const relay = (row: number) => ({ type: 'cursorPosition' as const, row, col: 3, decPrivate: true })
  expect(resolveInlineProbeArm(true, relay(47), cursor, 47, 47)).toEqual({ arm: false })
  // A settled reply (the cursor where the app parked it) arms at origin 0.
  expect(resolveInlineProbeArm(true, relay(43), cursor, 47, 47)).toEqual({ arm: true, relay: true, origin: 0 })
  // An origin above the viewport is rejected too.
  expect(resolveInlineProbeArm(true, relay(10), cursor, 47, 47)).toEqual({ arm: false })
  // An unbounded block shorter than the viewport may start lower, but never past
  // the bottom: 47 rows, a 3-row block, the cursor parked at row 43 (y=42).
  // origin 2 puts the block at rows 2-4 (fits); origin 45 would run past row 46.
  expect(resolveInlineProbeArm(true, relay(45), cursor, 47, 3)).toEqual({ arm: true, relay: true, origin: 2 })
  expect(resolveInlineProbeArm(true, relay(88), cursor, 47, 3)).toEqual({ arm: false })
  // Omitting blockRows keeps the older row-only rule (backward compatible with
  // the callers that pass four arguments).
  expect(resolveInlineProbeArm(true, relay(47), cursor, 47)).toEqual({ arm: true, relay: true, origin: 4 })
})

// ---------------------------------------------------------------------------
// Real-Ink scaffolding: a bounded inline session with a clickable Led.
// ---------------------------------------------------------------------------
type ProbeQuery = { match(r: unknown): boolean }
type FakeQuerier = {
  sends: ProbeQuery[]
  pending: Array<{ query: ProbeQuery; resolve(v: unknown): void }>
  send(query: ProbeQuery, signal?: AbortSignal): Promise<unknown>
  flush(): Promise<void>
  onResponse(r: unknown): void
}

function makeFakeQuerier(): FakeQuerier {
  const sends: ProbeQuery[] = []
  const pending: FakeQuerier['pending'] = []
  return {
    sends,
    pending,
    send(query, signal) {
      sends.push(query)
      return new Promise(resolve => {
        const entry = { query, resolve }
        pending.push(entry)
        signal?.addEventListener(
          'abort',
          () => {
            const i = pending.indexOf(entry)
            if (i !== -1) pending.splice(i, 1)
            resolve(undefined)
          },
          { once: true },
        )
      })
    },
    flush: () => Promise.resolve(),
    onResponse(r) {
      const i = pending.findIndex(e => e.query.match(r))
      if (i !== -1) {
        const [e] = pending.splice(i, 1)
        e!.resolve(r)
      }
    },
  }
}

type ProbeInk = {
  app: { querier: FakeQuerier; rawModeEnabledCount: number }
  inlineOrigin: number | null
  inlineTracking: boolean
  inlineProbePending: boolean
  displayCursor: { x: number; y: number } | null
  frontFrame: { cursor: { x: number; y: number }; screen: { height: number } }
  terminalRows: number
  calibrateInlineMouse(): void
  requestViewerRepaint(): void
  handleInlineMouse(mouse: ParsedMouse): boolean
  repaint(): void
}

let clicked = 0

function Body() {
  useInput(() => {})
  return (
    <BoundedMainScreen>
      <Box flexDirection="column" width="100%">
        <Text>row-0</Text>
        <Text>row-1</Text>
        {/* The Led sits at app row 2; a click at its client row must reach it. */}
        <Box onClick={() => { clicked++ }}>
          <Text>LED</Text>
        </Box>
      </Box>
    </BoundedMainScreen>
  )
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** The probe's cursor: what the arm rule subtracts from the reply row. */
function cursorY(ink: ProbeInk): number {
  return (ink.displayCursor ?? ink.frontFrame.cursor).y
}

/** Answer the first pending probe with a reply that yields `origin`. */
function answerOne(ink: ProbeInk, fake: FakeQuerier, origin: number): boolean {
  if (fake.pending.length === 0) return false
  fake.onResponse({ type: 'cursorPosition', row: cursorY(ink) + 1 + origin, col: 1, decPrivate: true })
  return true
}

/**
 * Answer pending probes with a reply that yields `origin` until the lane arms
 * at it. Robust to the lane's own retry timing: if a reply is dropped (an epoch
 * replaced the probe), the lane re-probes and this answers the next one.
 */
async function answerUntil(
  ink: ProbeInk,
  fake: FakeQuerier,
  origin: number,
  ms: number,
): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (fake.pending.length > 0) {
      fake.onResponse({ type: 'cursorPosition', row: cursorY(ink) + 1 + origin, col: 1, decPrivate: true })
    }
    if (ink.inlineOrigin === origin) return true
    await sleep(25)
  }
  return ink.inlineOrigin === origin
}

const saved = {
  gateway: process.env.CLAUDE_CODE_USE_GATEWAY,
  noFlicker: process.env.CLAUDE_CODE_NO_FLICKER,
  tmux: process.env.TMUX,
  interactive: getIsInteractive(),
  stdoutDesc: Object.getOwnPropertyDescriptor(process.stdout, 'isTTY'),
}

async function setupProbe(): Promise<{
  ink: ProbeInk
  fake: FakeQuerier
  cleanup: () => void
}> {
  process.env.CLAUDE_CODE_USE_GATEWAY = '1'
  process.env.CLAUDE_CODE_NO_FLICKER = '0'
  delete process.env.TMUX
  setIsInteractive(true)
  const stdout = Object.assign(new PassThrough(), { columns: 40, rows: 12, isTTY: true })
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode() {},
    ref() {},
    unref() {},
  })
  const realStdout = process.stdout
  Object.defineProperty(process, 'stdout', { configurable: true, value: stdout })
  const app = await render(<Body />, {
    stdout: stdout as never,
    stderr: stdout as never,
    stdin: stdin as never,
    patchConsole: false,
    exitOnCtrlC: false,
  })
  await sleep(250)
  const ink = instances.get(stdout as never) as unknown as ProbeInk
  const fake = makeFakeQuerier()
  ink.app.querier = fake
  ink.inlineOrigin = null
  ink.inlineTracking = false
  return {
    ink,
    fake,
    cleanup() {
      app.unmount()
      stdin.destroy()
      stdout.destroy()
      expectStandardCursorPosition(false)
      Object.defineProperty(process, 'stdout', { configurable: true, value: realStdout })
      if (saved.gateway === undefined) delete process.env.CLAUDE_CODE_USE_GATEWAY
      else process.env.CLAUDE_CODE_USE_GATEWAY = saved.gateway
      if (saved.noFlicker === undefined) delete process.env.CLAUDE_CODE_NO_FLICKER
      else process.env.CLAUDE_CODE_NO_FLICKER = saved.noFlicker
      if (saved.tmux === undefined) delete process.env.TMUX
      else process.env.TMUX = saved.tmux
      if (saved.stdoutDesc) Object.defineProperty(process.stdout, 'isTTY', saved.stdoutDesc)
      setIsInteractive(saved.interactive)
    },
  }
}

// ---------------------------------------------------------------------------
// (1) A new viewer means new cursor truth: FOCUS_IN re-probes without disarming,
//     and the Led click still hits after the settled reply.
// ---------------------------------------------------------------------------
test('a viewer FOCUS_IN re-probes without disarming, and the Led click hits', async () => {
  const { ink, fake, cleanup } = await setupProbe()
  try {
    // Arm the lane the way production does: a CPR reply (origin 0 in a bounded
    // block, which IS the viewport).
    ink.calibrateInlineMouse()
    expect(fake.sends.length).toBe(1)
    expect(answerOne(ink, fake, 0)).toBe(true)
    await sleep(0)
    expect(ink.inlineOrigin).toBe(0)
    expect(ink.inlineTracking).toBe(true)

    const before = fake.sends.length
    // A viewer attaches/resyncs (muxd injects FOCUS_IN). The lane must re-probe
    // so the origin tracks the new viewer's cursor truth.
    ink.requestViewerRepaint()
    expect(fake.sends.length).toBe(before + 1) // RED on 0222bde: no re-probe
    // ...without disarming: clicks keep working with the current origin.
    expect(ink.inlineOrigin).toBe(0)
    expect(ink.inlineTracking).toBe(true)

    // The settled reply arrives at origin 0. Let the opaque repaint render so the
    // frame is authoritative again before the click.
    expect(await answerUntil(ink, fake, 0, 1500)).toBe(true)
    await sleep(120)
    expect(ink.inlineOrigin).toBe(0)
    expect(ink.inlineTracking).toBe(true)

    // The Led sits at app row 2; the user clicks its client row (row 2 + origin).
    // Correct origin -> app row 2 -> the Led's onClick fires. A wrong origin (4)
    // -> app row -2 -> consumed -> no click.
    clicked = 0
    ink.handleInlineMouse(press(0, 2))
    ink.handleInlineMouse(release(0, 2))
    expect(clicked).toBe(1)
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// (3) The late-attach outcome: a settling reply never arms; the settled reply
//     arms origin 0 and the Led click hits.
// ---------------------------------------------------------------------------
test('a settling reply never arms; the settled reply arms origin 0 and the Led click hits', async () => {
  const { ink, fake, cleanup } = await setupProbe()
  try {
    // The initial probe fires from the render loop; drive it explicitly so the
    // reply timing is deterministic, then answer with the SETTLING reply
    // (origin 4: the client's cursor at the bottom of its freshly-scrolled
    // buffer while our block is parked higher).
    ink.calibrateInlineMouse()
    expect(fake.sends.length).toBe(1)
    expect(answerOne(ink, fake, 4)).toBe(true)
    await sleep(0)
    // RED on 0222bde: the wrong origin arms here and no retry is scheduled, so
    // this stays 4 and every click below is translated 4 rows off.
    expect(ink.inlineOrigin).toBe(null)
    expect(ink.inlineTracking).toBe(false)

    // A viewer attaches; the lane re-probes and the settled reply arms origin 0.
    ink.requestViewerRepaint()
    expect(await answerUntil(ink, fake, 0, 2500)).toBe(true)
    await sleep(120) // let the opaque repaint render

    // The Led sits at app row 2; the user clicks its client row. Correct origin
    // -> app row 2 -> the Led's onClick fires. A wrong origin (4) -> app row -2
    // -> consumed -> no click.
    clicked = 0
    ink.handleInlineMouse(press(0, 2))
    ink.handleInlineMouse(release(0, 2))
    expect(clicked).toBe(1)

    // Bounded: the arm/retry/confirmation did not storm the querier.
    expect(fake.sends.length).toBeLessThanOrEqual(4)
    expect(fake.pending.length).toBe(0)
  } finally {
    cleanup()
  }
})
