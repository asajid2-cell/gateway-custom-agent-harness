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
type ProbeQuery = { match(r: unknown): boolean; request: string }
type FakeQuerier = {
  sends: ProbeQuery[]
  pending: Array<{ query: ProbeQuery; resolve(v: unknown): void }>
  send(query: ProbeQuery, signal?: AbortSignal): Promise<unknown>
  flush(): Promise<void>
  onResponse(r: unknown): void
  /** Mirror TerminalQuerier.send's `stdout.write(query.request)`. */
  setWrite(fn: (request: string) => void): void
}

function makeFakeQuerier(): FakeQuerier {
  const sends: ProbeQuery[] = []
  const pending: FakeQuerier['pending'] = []
  let writeFn: ((request: string) => void) | undefined
  return {
    sends,
    pending,
    setWrite(fn) {
      writeFn = fn
    },
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
        // Queued, then written — the same order as the real querier, so the
        // request enters the one ordered output stream at its real position
        // relative to frame writes.
        writeFn?.(query.request)
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
  inlineProbeAfterFrame: boolean
  displayCursor: { x: number; y: number } | null
  frontFrame: { cursor: { x: number; y: number }; screen: { height: number } }
  terminalRows: number
  calibrateInlineMouse(): void
  requestViewerRepaint(): void
  handleInlineMouse(mouse: ParsedMouse): boolean
  repaint(): void
  onRender(): void
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

/** Wait until a probe is in flight (the lane has sent one and not been answered). */
async function waitForProbe(fake: FakeQuerier, ms: number): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (fake.pending.length > 0) return true
    await sleep(25)
  }
  return fake.pending.length > 0
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
  stdout: PassThrough & { columns: number; rows: number }
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
    stdout,
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
    // so the origin tracks the new viewer's cursor truth. The probe is deferred
    // to AFTER the repaint frame (so the terminal answers with the cursor that
    // frame parked), so it lands on the next render.
    ink.requestViewerRepaint()
    await sleep(50)
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

// ---------------------------------------------------------------------------
// (4) The attach re-probe is written AFTER the repaint frame it depends on.
//
// A terminal answers a CPR with the cursor it holds when it PARSES the probe.
// A freshly attached mux client has replayed the session bytes but has not yet
// parsed our repaint frame, so its cursor sits at the replayed buffer position
// (the live attach reply: row 42 col 145, while our block parks at row 43 col
// 3). A probe that is written BEFORE the repaint frame is therefore answered
// with that stale cursor: origin = 42 - 1 - 42 = -1, rejected by the block-fit
// rule, and the lane never arms from the first reply (the live "probe reply
// rejected · ... backing off 1000ms" on essentially every attach).
//
// The fake querier now writes its request into stdout exactly as
// TerminalQuerier.send does, and this test models the client's cursor: stale
// until the repaint frame's erase+home is written, then the frame's own cursor.
// So the assertion is behavioral: the FIRST reply must arm at origin 0 and the
// Led click must hit, with no retry needed.
// ---------------------------------------------------------------------------
test('an attach re-probe follows the repaint frame, so the first reply arms', async () => {
  const { ink, fake, stdout, cleanup } = await setupProbe()
  try {
    // The client's cursor: its replayed position (row 2 col 40) until it parses
    // our repaint frame, after which it holds the cursor that frame parked.
    let clientRow = 2
    const realWrite = stdout.write.bind(stdout)
    ;(stdout as unknown as { write: (c: unknown, ...r: unknown[]) => unknown }).write = (
      chunk: unknown,
      ...rest: unknown[]
    ) => {
      const s = String(chunk)
      if (s.includes('\x1b[2J\x1b[H')) clientRow = ink.frontFrame.cursor.y + 1
      if (s.includes('\x1b[?6n')) {
        fake.onResponse({ type: 'cursorPosition', row: clientRow, col: 40, decPrivate: true })
      }
      return realWrite(chunk as never, ...(rest as never[]))
    }
    fake.setWrite(request => {
      ;(stdout as unknown as { write: (s: string) => unknown }).write(request)
    })

    // A viewer attaches (muxd injects FOCUS_IN) into a never-armed lane.
    ink.requestViewerRepaint()
    // Let the repaint frame render and the (deferred) probe be answered.
    await sleep(200)

    // RED on 375e712: the probe is written before the frame, the client answers
    // with its stale replayed cursor, the reply is rejected and origin stays
    // null until the 1000ms retry.
    expect(ink.inlineOrigin).toBe(0)
    expect(ink.inlineTracking).toBe(true)
    // The first reply armed — no retry was needed.
    expect(fake.sends.length).toBe(1)

    // The Led sits at app row 2; a click at its client row (row 2 + origin)
    // must reach it.
    clicked = 0
    ink.handleInlineMouse(press(0, 2))
    ink.handleInlineMouse(release(0, 2))
    expect(clicked).toBe(1)
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// (5) The deferred probe is not lost when a render has no diff to write.
//
// requestViewerRepaint blanks the block, so in practice its repaint always has
// a diff — but the deferred probe must not DEPEND on that. If the flag could sit
// unconsumed on a no-diff render (or one merged by the throttle), it would be a
// brand-new way to never arm. Here the block content is unchanged, so the frame
// writes no cells; the probe must still go out exactly once and the flag clear.
// ---------------------------------------------------------------------------
test('a deferred probe is sent even when the frame has no diff to write', async () => {
  const { ink, fake, cleanup } = await setupProbe()
  try {
    // Arm and settle so the next render produces identical content.
    ink.calibrateInlineMouse()
    expect(answerOne(ink, fake, 0)).toBe(true)
    await sleep(0)
    expect(ink.inlineOrigin).toBe(0)

    const before = fake.sends.length
    // A deferred re-probe on a frame that changes nothing.
    ink.inlineProbeAfterFrame = true
    ink.onRender()
    await sleep(0)
    expect(fake.sends.length).toBe(before + 1)
    // Consumed, not left set for some later frame.
    expect(ink.inlineProbeAfterFrame).toBe(false)
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// (6a) A rate-limited FOCUS_IN still drops the reject backoff.
//
// A burst of FOCUS_INs on one attach (attach + resync + paint-fault) is rate
// limited to one repaint per second. The repaint is skipped, but the backoff a
// rejection earned must not survive: a FOCUS_IN is the clearest signal someone
// is looking, so the next frame must be free to re-probe at once.
// ---------------------------------------------------------------------------
test('a rate-limited FOCUS_IN drops the reject backoff, so the next frame re-probes', async () => {
  const { ink, fake, cleanup } = await setupProbe()
  try {
    ink.requestViewerRepaint()
    expect(await waitForProbe(fake, 1000)).toBe(true)
    // A reply that cannot place the block earns a backoff.
    expect(answerOne(ink, fake, 4)).toBe(true)
    await sleep(0)
    expect(ink.inlineOrigin).toBe(null)

    // A second FOCUS_IN inside the rate-limit window: the repaint is skipped,
    // but the wait must still be cleared.
    ink.requestViewerRepaint()
    // A render for any other reason (spinner, clock) now re-probes at once.
    const before = fake.sends.length
    ink.onRender()
    await sleep(0)
    expect(fake.sends.length).toBe(before + 1) // RED before the reset moved up
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// (6b) The reject backoff stays short, so the lane arms within ~2s.
//
// A rejection means a reply arrived, so a terminal is present and answering.
// The old 30s cap let a burst of rejected probes on one attach (each doubling
// the wait, and a rate-limited FOCUS_IN not resetting it) leave the lane unarmed
// for the rest of the attach — the live "3 of 90 never armed". The cap is now
// 2s, so even after several rejections the retry arms within ~2s.
// ---------------------------------------------------------------------------
test('the reject backoff stays short, so the lane arms within ~2s', async () => {
  const { ink, fake, cleanup } = await setupProbe()
  try {
    ink.requestViewerRepaint()
    expect(await waitForProbe(fake, 1000)).toBe(true)
    // Three rejections. The old doubling would reach 4s on the third.
    for (let i = 0; i < 3; i++) {
      expect(answerOne(ink, fake, 4)).toBe(true)
      await sleep(0)
      expect(ink.inlineOrigin).toBe(null)
      if (i < 2) expect(await waitForProbe(fake, 3000)).toBe(true)
    }
    // The next retry must arrive within the capped ~2s wait, not 4-8s.
    const t = Date.now()
    expect(await answerUntil(ink, fake, 0, 2600)).toBe(true)
    expect(Date.now() - t).toBeLessThan(2600)
  } finally {
    cleanup()
  }
}, 20000)
