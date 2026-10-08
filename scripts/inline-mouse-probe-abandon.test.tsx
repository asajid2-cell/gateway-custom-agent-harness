import React from 'react'
import { test, expect } from 'bun:test'
import { PassThrough } from 'node:stream'
import { render, Box, Text, useInput } from '../src/ink.ts'
import { BoundedMainScreen } from '../src/ink/components/BoundedMainScreen.tsx'
import instances from '../src/ink/instances.ts'
import { getIsInteractive, setIsInteractive } from '../src/bootstrap/state.ts'
import { expectStandardCursorPosition } from '../src/ink/parse-keypress.ts'
import { TerminalQuerier } from '../src/ink/terminal-querier.ts'

// The inline-mouse CPR probe must not leave its query behind when it is
// abandoned. Live: the probe times out with no client attached, its query
// stays queued forever, and once a client attaches the reply resolves the
// STALE query — whose `.then` clears the CURRENT probe's timer and pending
// flag. The render loop then sees "no probe in flight" and re-probes every
// frame (measured: 58 probes in 20s, 0 resolved, 0 rejected, ?1000h never
// written), so the mouse lane never arms and clicks do nothing.
//
// Three contracts, one per fix requirement:
//   1. send(query, signal) + abort removes the query from the querier and
//      resolves undefined, so an abandoned matcher cannot swallow a later
//      reply meant for a fresh query.
//   2. a reply for an abandoned probe (a new epoch replaced it) touches no
//      probe state and starts no new probe.
//   3. after the timeout the query has left the querier, and the retry's probe
//      is the only one in flight — it arms on the first reply, and the probe
//      count stays bounded.
//
// The probe is driven on the REAL Ink instance (as app-mouse-inline-real does)
// with a fake querier that mirrors TerminalQuerier's contract, including the
// abort cancel. On HEAD send() ignores the signal, so the abandoned query
// lingers — every red assertion below is exactly that.
//
// The timeout rule (contract 3, exercised in the last two tests): a slow reply
// does not make a confirmed origin wrong. A timeout with an origin already
// armed against the CURRENT geometry keeps the origin and tracking — clicks
// never dead-window — and retries the probe; only a timeout with no origin, or
// one whose geometry changed since the origin was measured, disarms.

// ---------------------------------------------------------------------------
// (1) The querier's cancel, pure — no renderer.
// ---------------------------------------------------------------------------
const racePending = <T,>(p: Promise<T>): Promise<T | 'PENDING'> =>
  Promise.race([p, new Promise<'PENDING'>(r => setTimeout(() => r('PENDING'), 100))])

test('an aborted send leaves the querier and resolves undefined', async () => {
  const { TerminalQuerier, cursorPosition } = await import('../src/ink/terminal-querier.ts')
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream
  const querier = new TerminalQuerier(stdout)

  const ac = new AbortController()
  const abandoned = querier.send(cursorPosition(false), ac.signal)
  ac.abort()
  // RED on HEAD: send() ignores the signal, so this stays pending.
  expect(await racePending(abandoned)).toBeUndefined()

  // The aborted matcher must be gone: a later reply reaches the NEXT send.
  const fresh = querier.send(cursorPosition(false))
  querier.onResponse({ type: 'cursorPosition', row: 5, col: 3, decPrivate: true })
  // RED on HEAD: the abandoned query is still first in the queue and steals it.
  expect(await racePending(fresh)).toEqual({
    type: 'cursorPosition',
    row: 5,
    col: 3,
    decPrivate: true,
  })
})

// ---------------------------------------------------------------------------
// Real-Ink scaffolding: a bounded inline session (the lane's own topology).
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
        // Mirrors TerminalQuerier.send(query, signal): abort removes the query.
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
  inlineProbeFailed: boolean
  inlineEpoch: number
  displayCursor: { x: number; y: number } | null
  frontFrame: { cursor: { x: number; y: number }; screen: { height: number } }
  terminalRows: number
  calibrateInlineMouse(): void
  repaint(): void
  getMouseRowOffset(): number
  /** The inline lane's mouse entry (private field in ink.tsx). */
  handleInlineMouse(mouse: {
    button: number
    action: 'press' | 'release'
    col: number
    row: number
  }): boolean
}

// Clicks that reached the content, recorded by Body's onClick. A click that
// lands during a probe gap must still be translated and delivered here; a
// click the lane merely consumes (uncalibrated) never arrives.
const clicks: Array<{ row: number }> = []

function Body() {
  useInput(() => {})
  return (
    <BoundedMainScreen>
      <Box
        flexDirection="column"
        width="100%"
        onClick={e => clicks.push({ row: e.localRow ?? -1 })}
      >
        <Text>row-0</Text>
        <Text>row-1</Text>
      </Box>
    </BoundedMainScreen>
  )
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (pred()) return true
    await sleep(25)
  }
  return pred()
}

const saved = {
  gateway: process.env.CLAUDE_CODE_USE_GATEWAY,
  noFlicker: process.env.CLAUDE_CODE_NO_FLICKER,
  tmux: process.env.TMUX,
  interactive: getIsInteractive(),
  stdoutDesc: Object.getOwnPropertyDescriptor(process.stdout, 'isTTY'),
}

type RealQuerier = {
  onResponse(r: unknown): void
  send(q: unknown, s?: AbortSignal): Promise<unknown>
  flush(): Promise<void>
}

async function setupProbe(opts: { realQuerier?: boolean } = {}): Promise<{
  ink: ProbeInk
  fake: FakeQuerier
  /** The querier the lane actually drives: the real one, or the mirror. */
  querier: FakeQuerier | RealQuerier
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
  // A clean REAL querier on the app's own stdout: the App's querier already
  // holds an unanswered XTVERSION query + sentinel from startup (the test never
  // feeds stdin), which would sit ahead of our probe. A fresh real querier is
  // the same implementation with a clean queue.
  const real = new TerminalQuerier(stdout as unknown as NodeJS.WriteStream)
  if (!opts.realQuerier) ink.app.querier = fake
  else ink.app.querier = real as unknown as FakeQuerier
  ink.inlineOrigin = null
  ink.inlineTracking = false
  clicks.length = 0
  return {
    ink,
    fake,
    querier: opts.realQuerier ? real : fake,
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
// (2) A new epoch replaces the probe: its late reply must not start a new one.
// ---------------------------------------------------------------------------
test('a reply for an epoch-replaced probe neither touches state nor re-probes', async () => {
  const { ink, fake, cleanup } = await setupProbe()
  try {
    ink.calibrateInlineMouse()
    expect(fake.sends.length).toBe(1)
    expect(fake.pending.length).toBe(1)

    // A new epoch replaces the probe (production: repaint on resume, alt-screen
    // exit, layout change). The fix abandons the query; HEAD leaves it queued.
    ink.repaint()
    expect(fake.pending.length).toBe(0) // RED on HEAD: 1

    // The reply for the abandoned probe arrives.
    fake.onResponse({ type: 'cursorPosition', row: 5, col: 3, decPrivate: true })
    await sleep(0)

    // It must not arm, not touch state, and never start a new probe.
    expect(fake.sends.length).toBe(1) // RED on HEAD: the stale reply re-probes -> 2
    expect(ink.inlineOrigin).toBeNull()
    expect(ink.inlineTracking).toBe(false)
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// (3) The timeout abandons the query; the retry's probe arms on the first reply
//     and the probe count stays bounded.
// ---------------------------------------------------------------------------
test('a timed-out probe leaves the querier, and the retry arms on the first reply', async () => {
  const { ink, fake, cleanup } = await setupProbe()
  try {
    ink.calibrateInlineMouse()
    expect(fake.sends.length).toBe(1)

    // No client attached: the probe times out at 1000ms.
    expect(await waitFor(() => ink.inlineProbeFailed, 2500)).toBe(true)
    // The abandoned query has left the querier (RED on HEAD: still queued).
    expect(fake.pending.length).toBe(0)
    expect(fake.sends.length).toBe(1)

    // The retry timer clears the failure and re-probes.
    expect(await waitFor(() => fake.sends.length === 2, 3000)).toBe(true)

    // The first reply after the retry arms the lane. The row must place the
    // block inside the viewport (a bounded block IS the viewport, so the reply
    // row is the parked cursor's own row), or the plausibility rule rejects it.
    const cursorY = (ink.displayCursor ?? ink.frontFrame.cursor).y
    fake.onResponse({ type: 'cursorPosition', row: cursorY + 1, col: 3, decPrivate: true })
    await sleep(0)
    expect(ink.inlineOrigin).toBe(0)
    expect(ink.inlineTracking).toBe(true)

    // Bounded: the resolution did not itself send another probe.
    expect(fake.sends.length).toBe(2)
    expect(fake.pending.length).toBe(0)
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// (4) A probe timeout must not disarm an origin that is already armed against
//     the CURRENT geometry. A viewer attach (FOCUS_IN) re-probes WITHOUT
//     clearing the origin, so a client slow to answer must not kill a working
//     mouse lane - the origin and tracking stay, and the abandoned probe's late
//     reply matches no pending query, so it is dropped.
// ---------------------------------------------------------------------------
test('an armed origin survives a probe timeout; the late reply leaves it untouched', async () => {
  const { ink, querier, cleanup } = await setupProbe({ realQuerier: true })
  try {
    // Arm: probe A, answer it -> origin 0, tracking on.
    ink.calibrateInlineMouse()
    const cursorY = (ink.displayCursor ?? ink.frontFrame.cursor).y
    querier.onResponse({ type: 'cursorPosition', row: cursorY + 1, col: 3, decPrivate: true })
    await sleep(0)
    expect(ink.inlineOrigin).toBe(0)
    expect(ink.inlineTracking).toBe(true)

    // A viewer attach re-probes (the arm path at the post-frame probe) while the
    // origin is armed. The client never answers.
    ink.calibrateInlineMouse()
    // The probe times out at 1000ms. RED on HEAD: origin null, tracking off.
    expect(await waitFor(() => ink.inlineProbePending === false, 2000)).toBe(true)
    await sleep(200)

    // The confirmed origin and the tracking survive: clicks keep mapping.
    expect(ink.inlineOrigin).toBe(0)
    expect(ink.inlineTracking).toBe(true)
    expect(ink.getMouseRowOffset()).toBe(0)
    expect(ink.inlineProbeFailed).toBe(false)

    // A click DURING the would-be gap (the window HEAD spends disarmed) still
    // lands. origin is 0, so block row 0 is terminal row 1. RED on HEAD: the
    // lane is uncalibrated there, so the click is consumed with no translation
    // and Body's onClick never fires (clicks stays empty).
    clicks.length = 0
    expect(ink.handleInlineMouse({ button: 0, action: 'press', col: 5, row: 1 })).toBe(true)
    expect(ink.handleInlineMouse({ button: 0, action: 'release', col: 5, row: 1 })).toBe(true)
    await sleep(0)
    expect(clicks).toEqual([{ row: 0 }])

    // The abandoned probe's late reply (a stale pre-settle row) arrives. The
    // abandoned query left the querier on abort, so it matches no pending query
    // and must not move the origin.
    querier.onResponse({ type: 'cursorPosition', row: 47, col: 33, decPrivate: true })
    await sleep(20)
    expect(ink.inlineOrigin).toBe(0)
    expect(ink.inlineTracking).toBe(true)
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// (5) The no-disarm rule is bounded by geometry: a timeout whose geometry
//     changed since the origin was measured still disarms. The epoch is the
//     geometry generation; a mismatch must disarm even while an origin is held
//     (no current public path bumps the epoch without clearing the origin, so
//     the epoch clause is exercised directly here - it is what keeps the guard
//     correct if such a path is ever added).
// ---------------------------------------------------------------------------
test('a timeout after a geometry change still disarms', async () => {
  const { ink, fake, cleanup } = await setupProbe()
  try {
    ink.calibrateInlineMouse()
    const cursorY = (ink.displayCursor ?? ink.frontFrame.cursor).y
    fake.onResponse({ type: 'cursorPosition', row: cursorY + 1, col: 3, decPrivate: true })
    await sleep(0)
    expect(ink.inlineOrigin).toBe(0)
    expect(ink.inlineTracking).toBe(true)

    // The geometry changed since the origin was measured: the epoch moved on.
    ink.inlineEpoch++
    ink.calibrateInlineMouse()

    // The probe times out: the origin is stale, so the lane disarms.
    expect(await waitFor(() => ink.inlineProbeFailed, 2500)).toBe(true)
    expect(ink.inlineOrigin).toBeNull()
    expect(ink.inlineTracking).toBe(false)
  } finally {
    cleanup()
  }
})
