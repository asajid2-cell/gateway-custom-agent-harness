import { test, expect } from 'bun:test'
import { PassThrough } from 'node:stream'

// The mux browser client (relay/public/index.html, `takeTerminalReport`) STRIPS
// Device Attributes replies: it drops `ESC[?…c` before the app ever sees it. So
// on the mux path a DA1 is NEVER answered — which is exactly the premise the
// abandoned-probe fence relied on ("every terminal answers DA1"). An inline
// probe abandoned because its reply is late (the slow client this lane exists
// for) became a fence that only its own DA1 could clear; under mux that DA1
// never comes, so the fence sat in the queue, the newest fence ate every later
// CPR reply, and the live probe never armed — 90/90 attaches never armed in the
// live soak. The fence is backed out. Any future stale-reply guard MUST NOT
// depend on a reply the client may never send; this test is that gate.
//
// Model: a terminal that answers CPR in the DEC-private form the relay uses
// (CSI ? row ; col R) and NEVER answers DA1. After an unwatched stretch of
// timed-out probes, a viewer attaches; the next probe must arm on its OWN row.
// The native-terminal variant (DA1 answered) must stay green too.

const racePending = <T,>(p: Promise<T>): Promise<T | 'PENDING'> =>
  Promise.race([p, new Promise<'PENDING'>(r => setTimeout(() => r('PENDING'), 100))])

// A stale pre-settle caret (the abandoned probe's reply) and the live probe's
// own reply. DEC-private form: the relay answers this form.
const STALE = { type: 'cursorPosition', row: 47, col: 33, decPrivate: true }
const OWN = { type: 'cursorPosition', row: 3, col: 3, decPrivate: true }

/**
 * An unwatched stretch of timed-out probes, then a viewer attaches and answers
 * one probe. `answersDa1` models the native terminal (true) vs the mux client
 * (false — DA1 stripped). Returns what the live probe resolved with, or
 * 'PENDING' if it never armed.
 */
async function unwatchedThenViewer(answersDa1: boolean): Promise<unknown> {
  const { TerminalQuerier, cursorPosition } = await import('../src/ink/terminal-querier.ts')
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream
  const querier = new TerminalQuerier(stdout)
  const realNow = Date.now
  let now = realNow()
  Date.now = () => now
  try {
    // Unwatched: each probe times out (abandoned) and its late reply arrives.
    for (let i = 0; i < 6; i++) {
      const ac = new AbortController()
      void querier.send(cursorPosition(false), ac.signal)
      now += 2000 // the 1s probe timeout has fired; the retry goes out
      ac.abort()
      // The abandoned probe's late reply. Under mux this is the ONLY reply the
      // client sends for it — DA1 is stripped.
      querier.onResponse({ ...STALE })
      if (answersDa1) querier.onResponse({ type: 'da1', params: [1] })
    }
    // A viewer attaches: one probe, answered by the client.
    now += 2000
    const live = querier.send(cursorPosition(false))
    querier.onResponse({ ...OWN })
    return await racePending(live)
  } finally {
    Date.now = realNow
  }
}

test('a mux client that never answers DA1 still lets the next probe arm', async () => {
  // RED on e8d321e: with no DA1 to clear it the newest fence survives, eats the
  // live probe's CPR reply, and the probe stays PENDING forever.
  expect(await unwatchedThenViewer(false)).toEqual(OWN)
})

test('a native terminal that answers DA1 arms on its own reply', async () => {
  expect(await unwatchedThenViewer(true)).toEqual(OWN)
})
