/**
 * #109 independent fixture: acceptance from the page's own send response.
 *
 * Written against the change, not from it. The author's proof (proof/d5proof.mjs)
 * stays untouched; this file only imports the exported seams and drives them
 * with fakes, so nothing here needs Chrome, a CDP target or a live page.
 *
 * Run: `bun test r109accept.test.mjs`
 *
 * Point it at another source copy for the red run (the same mechanism the
 * author's proof uses with D5PROOF_SRC):
 *
 *   R109_SRC=/tmp/buggy-global.mjs bun test r109accept.test.mjs
 *
 * The four things being pinned, in the contract's own order:
 *
 *   1. a 2xx on the send POST alone accepts - `path: 'response'`, no tree probe;
 *   2. a non-2xx, a 2xx on another endpoint, a 2xx for a request the watcher
 *      never saw as a send POST, and a GET on the conversation path are NOT
 *      acceptance - the watcher's promise stays pending and DOM/tree carry the
 *      turn exactly as before;
 *   3. ATTRIBUTION - when a DOM read wins its race, the result is the DOM's
 *      (`path: 'dom'`, `newNodes` intact), even though `responseOutcome` is set
 *      by the time the decision is made. This is the row the first cut failed:
 *      `value === RESPONSE_SIGNAL || responseOutcome !== null` is a GLOBAL test,
 *      so a DOM read that won the race a microtask earlier was reported as a
 *      response win and lost its `newNodes`;
 *   4. the two checks that do not race (after the sleep, after the loop) still
 *      accept on `responseOutcome !== null`, because no race was lost there.
 *
 * Row 3 is driven by microtask order, never by wall-clock sleeps: the DOM read
 * and the response signal are resolved in a known order inside the same turn,
 * and the assertion is on the recorded `path` and `newNodes`.
 *
 * MICROTASK BUDGET (deliberate, and the one number in this file that is a
 * property of the implementation rather than of the contract): the DOM read is
 * mid-flight while the response resolves. `readDomUserTurns` -> `evaluateTimed`
 * -> `Promise.race` -> async return -> `.catch` costs three microtask hops from
 * the moment the page read settles to the moment the acceptance window's race
 * settles. So the response is resolved exactly three hops after the DOM value,
 * which is the window in which the DOM read has WON the race and the response's
 * own `.then` has already stored `responseOutcome`. Measured on 4a5036a and on
 * the pre-fix copy: with the strict predicate the DOM wins from three hops; with
 * the global predicate it only wins from five. A future edit that removes an
 * await inside `readDomUserTurns` narrows that band; if it narrows past three,
 * this row fails on the FIXED code too (loudly) rather than passing quietly on
 * the buggy one.
 */
import { describe, expect, test } from 'bun:test'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// chatgpt.mjs refuses to load without a profile: the host owns it and the driver
// has no default. This fixture never launches a browser, so a scratch path is
// enough, and setting it here keeps the run reproducible on any machine.
process.env.CHATGPT_PROFILE ||= path.join(os.tmpdir(), 'r109-fixture-profile')

const source = process.env.R109_SRC
  ? pathToFileURL(path.resolve(process.env.R109_SRC)).href
  : new URL('./chatgpt.mjs', import.meta.url).href
const { waitForAcceptance, startNetworkWatch } = await import(source)

const THREAD = '11111111-1111-4111-8111-111111111111'
const SEND_PATHNAME = '/backend-api/conversation'
const TEXT = 'count the peers on the bus'

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Run `fn` after exactly `hops` microtask hops (same FIFO as promise reactions). */
const afterHops = (hops, fn) => (hops <= 0 ? fn() : queueMicrotask(() => afterHops(hops - 1, fn)))

/** An accepted 2xx payload, in the shape startNetworkWatch resolves. */
const acceptedPayload = (overrides = {}) => ({
  at: Date.now(), status: 200, pathname: SEND_PATHNAME, ...overrides,
})

/**
 * A page whose DOM read is scripted: each `evaluate` call takes the next entry,
 * so a row decides exactly what the n-th poll observed and when it settled.
 */
function scriptedPage(reads) {
  let index = 0
  return {
    url: () => `https://chatgpt.com/c/${THREAD}`,
    evaluate: () => {
      const read = reads[Math.min(index, reads.length - 1)]
      index += 1
      return read.promise ?? read
    },
    polls: () => index,
  }
}

const baseline = { dom: ['a1'], users: 1 }
const domWithOurTurn = { identities: ['a1', 'n1'], texts: [null, TEXT] }
const domUnchanged = { identities: ['a1'], texts: [null] }

describe('#109: acceptance from the page own send response', () => {
  // Contract 1 ---------------------------------------------------------------
  test('1. a 2xx on the send POST accepts on its own: path response, no tree probe', async () => {
    const dom = deferred() // never settles: this row must not need the DOM at all
    const page = scriptedPage([dom])
    const treeBaseline = new Map() // offered, and provably unused
    const result = await waitForAcceptance(page, baseline, TEXT, 2_000, {
      treeBaseline,
      responseSignal: Promise.resolve(acceptedPayload()),
    })
    expect(result.accepted).toBe(true)
    expect(result.readable).toBe(true)
    expect(result.path).toBe('response')
    expect(result.newNodes).toBe(null)
    expect(result.treeProbes).toBe(0)
    expect(result.response?.status).toBe(200)
    expect(result.response?.pathname).toBe(SEND_PATHNAME)
  }, 15_000)

  // Contract 2, at the watcher ------------------------------------------------
  test('2a. a 2xx on the send POST resolves accepted, and is recorded in seen', async () => {
    const watcher = await fakeWatcher()
    watcher.emit('Network.requestWillBeSent', {
      requestId: 'r1', request: { method: 'POST', url: `https://chatgpt.com${SEND_PATHNAME}` },
    })
    watcher.emit('Network.responseReceived', {
      requestId: 'r1', response: { status: 200, url: `https://chatgpt.com${SEND_PATHNAME}` },
    })
    const accepted = await watcher.watch.accepted
    expect(accepted?.status).toBe(200)
    expect(accepted?.pathname).toBe(SEND_PATHNAME)
    expect(watcher.watch.available).toBe(true)
    expect(watcher.watch.seen).toEqual([{ at: expect.any(Number), method: 'POST', pathname: SEND_PATHNAME }])
    await watcher.watch.stop()
  }, 15_000)

  test('2b. a non-2xx on the send POST is not acceptance: the promise stays pending', async () => {
    const watcher = await fakeWatcher()
    watcher.emit('Network.requestWillBeSent', {
      requestId: 'r1', request: { method: 'POST', url: `https://chatgpt.com${SEND_PATHNAME}` },
    })
    watcher.emit('Network.responseReceived', {
      requestId: 'r1', response: { status: 500, url: `https://chatgpt.com${SEND_PATHNAME}` },
    })
    expect(await settles(watcher.watch.accepted, 120)).toBe('pending')
    // Stopping is the only thing that releases it, and it releases it as null -
    // the value the acceptance window maps to "no response can arrive now".
    const stopped = watcher.watch.stop().then(() => watcher.watch.accepted)
    expect(await stopped).toBe(null)
  }, 15_000)

  test('2c. a 2xx is not acceptance when it is another endpoint, another method, or an unseen request', async () => {
    const otherEndpoint = await fakeWatcher()
    otherEndpoint.emit('Network.requestWillBeSent', {
      requestId: 'r1', request: { method: 'POST', url: 'https://chatgpt.com/backend-api/files' },
    })
    otherEndpoint.emit('Network.responseReceived', {
      requestId: 'r1', response: { status: 200, url: 'https://chatgpt.com/backend-api/files' },
    })
    expect(await settles(otherEndpoint.watch.accepted, 120)).toBe('pending')

    const otherMethod = await fakeWatcher()
    otherMethod.emit('Network.requestWillBeSent', {
      requestId: 'r2', request: { method: 'GET', url: `https://chatgpt.com${SEND_PATHNAME}` },
    })
    otherMethod.emit('Network.responseReceived', {
      requestId: 'r2', response: { status: 200, url: `https://chatgpt.com${SEND_PATHNAME}` },
    })
    expect(await settles(otherMethod.watch.accepted, 120)).toBe('pending')

    const unseen = await fakeWatcher() // a response with no request the watcher attributed to a send
    unseen.emit('Network.responseReceived', {
      requestId: 'r3', response: { status: 200, url: `https://chatgpt.com${SEND_PATHNAME}` },
    })
    expect(await settles(unseen.watch.accepted, 120)).toBe('pending')

    await Promise.all([otherEndpoint.watch.stop(), otherMethod.watch.stop(), unseen.watch.stop()])
  }, 20_000)

  test('2d. the /f/ conversation route is the same send, and accepts', async () => {
    const watcher = await fakeWatcher()
    watcher.emit('Network.requestWillBeSent', {
      requestId: 'r1', request: { method: 'POST', url: 'https://chatgpt.com/backend-api/f/conversation' },
    })
    watcher.emit('Network.responseReceived', {
      requestId: 'r1', response: { status: 201, url: 'https://chatgpt.com/backend-api/f/conversation' },
    })
    const accepted = await watcher.watch.accepted
    expect(accepted?.status).toBe(201)
    expect(accepted?.pathname).toBe('/backend-api/f/conversation')
    await watcher.watch.stop()
  }, 15_000)

  // Contract 2, at the window -------------------------------------------------
  test('2e. a signal that never resolves leaves the DOM carrying the turn', async () => {
    const page = scriptedPage([domWithOurTurn])
    const result = await waitForAcceptance(page, baseline, TEXT, 2_000, {
      responseSignal: new Promise(() => {}),
    })
    expect(result.path).toBe('dom')
    expect(result.accepted).toBe(true)
    expect(result.newNodes).toEqual([TEXT])
    expect(result.response).toBeUndefined()
  }, 15_000)

  test('2f. a signal that resolves null (observer stopped) is not acceptance either', async () => {
    const page = scriptedPage([domWithOurTurn])
    const result = await waitForAcceptance(page, baseline, TEXT, 2_000, {
      responseSignal: Promise.resolve(null),
    })
    expect(result.path).toBe('dom')
    expect(result.newNodes).toEqual([TEXT])
    expect(result.response).toBeUndefined()
  }, 15_000)

  // Contract 3 ---------------------------------------------------------------
  test('3. a DOM read that wins its race keeps the DOM attribution and its newNodes', async () => {
    const dom = deferred()
    const response = deferred()
    const page = scriptedPage([dom])
    const window = waitForAcceptance(page, baseline, TEXT, 2_000, { responseSignal: response.promise })
    // The DOM read settles first...
    dom.resolve(domWithOurTurn)
    // ...and the response lands three microtask hops later: late enough that the
    // DOM read has won the race, early enough that `responseOutcome` is already
    // stored by the time the winner is judged. This is the exact interleaving
    // the first cut mis-attributed.
    afterHops(3, () => response.resolve(acceptedPayload()))
    const result = await window
    expect(result.path).toBe('dom')
    expect(result.accepted).toBe(true)
    expect(result.newNodes).toEqual([TEXT])
    expect(result.response).toBeUndefined()
    expect(result.domPolls).toBe(1)
  }, 15_000)

  test('3b. the same interleaving one hop later is still the DOM that wins', async () => {
    const dom = deferred()
    const response = deferred()
    const page = scriptedPage([dom])
    const window = waitForAcceptance(page, baseline, TEXT, 2_000, { responseSignal: response.promise })
    dom.resolve(domWithOurTurn)
    afterHops(4, () => response.resolve(acceptedPayload()))
    const result = await window
    expect(result.path).toBe('dom')
    expect(result.newNodes).toEqual([TEXT])
  }, 15_000)

  test('3c. when the response wins the race it is a response win, and it claims no newNodes', async () => {
    const dom = deferred() // the DOM read never settles: the response must win
    const response = deferred()
    const page = scriptedPage([dom])
    const window = waitForAcceptance(page, baseline, TEXT, 2_000, { responseSignal: response.promise })
    response.resolve(acceptedPayload())
    const result = await window
    expect(result.path).toBe('response')
    expect(result.newNodes).toBe(null)
    expect(result.response?.status).toBe(200)
  }, 15_000)

  // Contract 4 ---------------------------------------------------------------
  test('4. no race is lost, but responseOutcome is set: still acceptance on response', async () => {
    const page = scriptedPage([domUnchanged])
    const response = deferred()
    // The first DOM poll observes nothing new; the window then sleeps, and the
    // response lands inside that sleep. No race is settled by a read here, which
    // is exactly the case the strict sentinel must NOT govern - the non-racing
    // check has to consult `responseOutcome` itself.
    setTimeout(() => response.resolve(acceptedPayload()), 60)
    const result = await waitForAcceptance(page, baseline, TEXT, 2_000, { responseSignal: response.promise })
    expect(result.path).toBe('response')
    expect(result.accepted).toBe(true)
    expect(result.newNodes).toBe(null)
    expect(result.response?.status).toBe(200)
    expect(result.domPolls).toBeGreaterThanOrEqual(1)
  }, 15_000)
})

// --- a fake CDP page, so the watcher is exercised without Chrome ------------

async function fakeWatcher() {
  const handlers = new Map()
  const session = {
    on: (event, handler) => { handlers.set(event, handler) },
    send: async () => ({}),
    detach: async () => ({}),
  }
  const page = {
    url: () => `https://chatgpt.com/c/${THREAD}`,
    context: () => ({ newCDPSession: async () => session }),
  }
  const watch = await startNetworkWatch(page)
  return {
    watch,
    emit: (event, payload) => handlers.get(event)?.(payload),
  }
}

/** Did `promise` settle within `ms`? "pending" is a bounded observation, by nature. */
async function settles(promise, ms) {
  let state = 'pending'
  await Promise.race([
    promise.then(() => { state = 'settled' }, () => { state = 'settled' }),
    delay(ms),
  ])
  return state
}
