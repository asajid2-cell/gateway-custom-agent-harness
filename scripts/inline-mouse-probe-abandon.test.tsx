import React from 'react'
import { test, expect } from 'bun:test'
import { PassThrough } from 'node:stream'
import { render, Box, Text, useInput } from '../src/ink.ts'
import { BoundedMainScreen } from '../src/ink/components/BoundedMainScreen.tsx'
import instances from '../src/ink/instances.ts'
import { getIsInteractive, setIsInteractive } from '../src/bootstrap/state.ts'
import { expectStandardCursorPosition } from '../src/ink/parse-keypress.ts'
import { TerminalQuerier } from '../src/ink/terminal-querier.ts'

// The inline-mouse CPR probe must not let an abandoned probe's late reply
// resolve a NEWER probe. Removing the abandoned matcher is not enough: a CPR
// reply carries no identity (only a row), so a reply already in flight for an
// abandoned probe matches the next probe's matcher and resolves it with a stale
// row. Live: the attach's resize flurry (197x47 -> 197x48 -> 197x47) replaces
// the probe twice; each abandoned probe's reply is still travelling and resolves
// the newest probe against a caret that has since moved, so the block-fit rule
// rejects it (`probe reply rejected · row=47 col=33 · expected col=3`, ~1 in 6
// attaches).
//
// The fix pairs a reply with its own probe by ORDER: on abort the querier turns
// the query into a tombstone IN PLACE and fences it with a DA1 sentinel written
// right after it. The abandoned probe's reply (or the TWO replies a dual CPR
// query draws from a client) is consumed and discarded by the tombstone, and
// the fence's DA1 — always answered, always after any reply to this query —
// clears the tombstone before a later probe's reply can arrive.
//
// Three contracts:
//   1. an aborted send becomes a fenced tombstone: its stale reply is consumed
//      and discarded, and the fresh query gets its OWN reply.
//   2. a reply for an abandoned probe (a new epoch replaced it) touches no
//      probe state and starts no new probe.
//   3. after the timeout the abandoned query has left the querier, and the
//      retry's probe is the only one in flight — it arms on the first reply,
//      and the probe count stays bounded.
//
// Contracts 2 and 3 drive the REAL Ink instance (as app-mouse-inline-real does)
// with a fake querier that mirrors TerminalQuerier's arm/abort contract for the
// lane's state machine. Contract 1 drives the REAL TerminalQuerier (the pairing
// fix lives there) and, end to end, the REAL Ink instance wired to it — so the
// mirror is paired with a real-instance proof of the red direction.

// ---------------------------------------------------------------------------
// (1) The querier's pairing, pure — no renderer.
// ---------------------------------------------------------------------------
const racePending = <T,>(p: Promise<T>): Promise<T | 'PENDING'> =>
  Promise.race([p, new Promise<'PENDING'>(r => setTimeout(() => r('PENDING'), 100))])

test('an abandoned probe consumes its stale reply; the fresh probe gets its own', async () => {
  const { TerminalQuerier, cursorPosition } = await import('../src/ink/terminal-querier.ts')
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream
  const querier = new TerminalQuerier(stdout)

  const ac = new AbortController()
  const abandoned = querier.send(cursorPosition(false), ac.signal)
  ac.abort()
  // The abandoned promise resolves undefined (it is not the fix's subject).
  expect(await racePending(abandoned)).toBeUndefined()

  const fresh = querier.send(cursorPosition(false))
  // The abandoned probe's stale reply (row 47) arrives first, then its DA1
  // fence, then the fresh probe's own reply (row 3). A dual CPR query draws two
  // replies from a client — deliver both stale ones.
  querier.onResponse({ type: 'cursorPosition', row: 47, col: 33, decPrivate: true })
  querier.onResponse({ type: 'cursorPosition', row: 47, col: 33, decPrivate: false })
  querier.onResponse({ type: 'da1', params: [1] })
  querier.onResponse({ type: 'cursorPosition', row: 3, col: 3, decPrivate: true })
  // RED on HEAD: the first stale reply resolves the fresh probe → row 47.
  expect(await racePending(fresh)).toEqual({
    type: 'cursorPosition',
    row: 3,
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
  displayCursor: { x: number; y: number } | null
  frontFrame: { cursor: { x: number; y: number }; screen: { height: number } }
  terminalRows: number
  calibrateInlineMouse(): void
  repaint(): void
}

function Body() {
  useInput(() => {})
  return (
    <BoundedMainScreen>
      <Box flexDirection="column" width="100%">
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
  // A clean REAL querier on the app's own stdout. The App's querier already
  // holds an unanswered XTVERSION query + sentinel from startup (the test never
  // feeds stdin), which would sit before our probe's fence and absorb the first
  // DA1 — an artifact of the harness, not production. A fresh real querier is
  // the same implementation with a clean queue.
  const real = new TerminalQuerier(stdout as unknown as NodeJS.WriteStream)
  if (!opts.realQuerier) ink.app.querier = fake
  else ink.app.querier = real as unknown as FakeQuerier
  ink.inlineOrigin = null
  ink.inlineTracking = false
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
// (4) End to end on the REAL querier: the attach's resize flurry abandons
//     probe A, its stale reply (row 47) arrives after probe B was sent, and it
//     must not resolve B. B's own reply arms at origin 0.
// ---------------------------------------------------------------------------
test('a stale reply from an abandoned probe cannot arm; the fresh probe arms at origin 0', async () => {
  const { ink, querier, cleanup } = await setupProbe({ realQuerier: true })
  try {
    // The initial arm probe (A).
    ink.calibrateInlineMouse()
    // The attach's resize flurry replaces it: repaint() bumps the epoch and
    // abandons A. Its reply is now in flight with no matcher of its own.
    ink.repaint()
    // The lane re-probes (B). The querier fenced A's tombstone on the abort.
    ink.calibrateInlineMouse()
    const cursorY = (ink.displayCursor ?? ink.frontFrame.cursor).y

    // A's stale reply (the client's pre-settle bottom row) arrives, then A's
    // DA1 fence, then B's own reply (the cursor where the frame parked it).
    querier.onResponse({ type: 'cursorPosition', row: 47, col: 33, decPrivate: true })
    querier.onResponse({ type: 'da1', params: [1] })
    querier.onResponse({ type: 'cursorPosition', row: cursorY + 1, col: 3, decPrivate: true })
    await sleep(20)

    // RED on HEAD: the row-47 reply resolved B, the block-fit rule rejected it
    // (origin 4 in a 12-row viewport), and the lane is unarmed.
    expect(ink.inlineOrigin).toBe(0)
    expect(ink.inlineTracking).toBe(true)
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// (5) The pairing fix does not blind-accept: a genuinely wrong FRESH reply is
//     still rejected by the block-fit rule.
// ---------------------------------------------------------------------------
test('a genuinely wrong fresh reply is still rejected after the tombstone consumes the stale one', async () => {
  const { ink, querier, cleanup } = await setupProbe({ realQuerier: true })
  try {
    ink.calibrateInlineMouse()
    ink.repaint()
    ink.calibrateInlineMouse()
    const cursorY = (ink.displayCursor ?? ink.frontFrame.cursor).y

    querier.onResponse({ type: 'cursorPosition', row: 47, col: 33, decPrivate: true })
    querier.onResponse({ type: 'da1', params: [1] })
    // The fresh reply is itself out of place: origin 40 would put the block
    // well past the bottom of a 12-row viewport.
    querier.onResponse({ type: 'cursorPosition', row: cursorY + 41, col: 3, decPrivate: true })
    await sleep(20)

    expect(ink.inlineOrigin).toBeNull()
    expect(ink.inlineTracking).toBe(false)
  } finally {
    cleanup()
  }
})
