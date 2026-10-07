import React from 'react'
import { test, expect } from 'bun:test'
import { PassThrough } from 'node:stream'
import { render, Box, Text, useInput } from '../src/ink.ts'
import { BoundedMainScreen } from '../src/ink/components/BoundedMainScreen.tsx'
import instances from '../src/ink/instances.ts'
import { getIsInteractive, setIsInteractive } from '../src/bootstrap/state.ts'
import { expectStandardCursorPosition } from '../src/ink/parse-keypress.ts'

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
