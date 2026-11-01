/**
 * G-016 independent fixture: the reply shortener.
 *
 * Written from WORK_QUEUE.md `### G-016` only, not from the author's branch.
 * Every row drives the exported `ask()` path with a fake page: no Chrome, no
 * CDP target, no live host. The network observer is faked one level lower - a
 * session object that records its handlers and lets the fixture emit CDP
 * events - so `loadingFinished`/`loadingFailed` are delivered exactly where a
 * real page target would deliver them.
 *
 * Contract rows (the five the implementer was given, plus the two addenda):
 *
 *   a. the turn's own send-POST request (the same requestId #109 tracks) ends
 *      with `loadingFinished` on a stable non-empty sample -> ONE sample path,
 *      verdict within the ~0.3 s budget, and the log carries both the
 *      stream-end stamp and the first-stable stamp.
 *   b. no `loadingFinished` for that request -> the existing 3 x 900 ms path,
 *      same verdict. The instrument line "reply in <ms>ms: text stable for
 *      <ms>ms, <agree> agreeing samples" is part of the contract.
 *   c. `loadingFailed` -> fallback, never shortened.
 *   d. an empty sample, or a sample that changes on the next tick, at stream
 *      end -> fallback, not acceptance.
 *   e. a superseded send requestId -> only the newest id settles the turn.
 *      Both directions: a finish on the superseded id alone must fall back; a
 *      finish on the newest id shortens.
 *   f. the shortener is never an acceptor: a stream that ends while the send
 *      POST was not accepted leaves the turn unaccepted (the #109 response
 *      path is still the only acceptor).
 *   g. a client cancellation is an end: `loadingFailed` with `canceled: true`
 *      (net::ERR_ABORTED) on the accepted id, after the last data - the live
 *      shape, where an SSE body ends without `loadingFinished` - shortens to
 *      ONE confirming read inside the ~0.3 s budget, and the line says the end
 *      was a cancel and carries both stamps.
 *   h. the same cancel end with an EMPTY page at the confirming read falls
 *      back: an end alone never accepts, the text must still be stable.
 *   i. a transport failure is NOT an end: `loadingFailed` with `canceled:
 *      false` (net::ERR_CONTENT_LENGTH_MISMATCH) never shortens - full 900 ms
 *      cadence and no cancel line. This is what makes row (c), which has no
 *      `canceled` field at all, load-bearing for the distinction.
 *   j. only the newest id: a cancel on a superseded id changes nothing; a
 *      cancel on the newest id shortens. Mirror of e1/e2.
 *   lifetime. one shared session, four exits on consecutive turns - answer,
 *      throw before acceptance, reply timeout, throw after acceptance - each
 *      leaving no Network.* handlers and one Network.enable. The observer is
 *      created per turn and must be stopped in a finally on every path.
 *
 * TIMING BUDGETS, the only numbers here that are properties of the shape rather
 * than of the contract: the fallback samples are 900 ms apart and need three
 * agreeing reads, so it cannot finish under ~1.8 s; the shortened path is
 * ~0.3 s. The rows use 1200 ms / 1600 ms as the two sides of that gap. The
 * timeout exit is observed with CHATGPT_TIMEOUT_MS=4000, which the other rows
 * answer well inside.
 *
 * LOG LINE ASSUMED: the shortener line names the stream end and the first
 * stable sample on ONE line, each with a stamp, and the two stamps differ by
 * the settle actually waited (150-400 ms), because the contract's point is that
 * a later reader can compute the settle saved. The fixture requires one line
 * matching /stream|finished|loadingFinished/i AND /stable/i AND carrying two
 * DISTINCT timestamp tokens (<n>ms or ISO-8601) once the log's own ISO prefix
 * and any `reply in <ms>ms` total are discounted, and their difference must
 * fall in that window: two tokens that merely happen to differ by a tick are a
 * hole, not a stamp pair. Wording stays free. The fallback instrument line is
 * quoted verbatim in the contract and is matched as such. A wording divergence
 * is the finding, not a flaky fixture.
 *
 * Run: `bun test g016shorten.test.mjs` (explicit path; do not touch the live
 * profile, peer.json or driver.log - HOME/USERPROFILE and CHATGPT_PROFILE are
 * redirected to scratch before the import, and this fixture never launches a
 * browser). Point it at another source copy for a red run:
 *
 *   G016_SRC=/tmp/other-chatgpt.mjs bun test g016shorten.test.mjs
 */
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// HOME is redirected before the import so nothing here can append to the live
// driver.log: the module resolves BASE/LOG from it at load time.
const SCRATCH = path.join(os.tmpdir(), `g016-fixture-${process.pid}`)
process.env.CHATGPT_PROFILE ||= path.join(SCRATCH, 'profile')
process.env.HOME = path.join(SCRATCH, 'home')
process.env.USERPROFILE = process.env.HOME
// The acceptance window is not on trial here; a non-accepted turn would
// otherwise cost the shipped 30 s before its ambiguity is decided.
process.env.CHATGPT_ACCEPTANCE_MS ||= '1500'
// The lifetime block drives the reply-timeout exit, which costs the whole reply
// budget. Every other row answers well inside this (the slowest fallback verdict
// is ~2.7 s), so 4 s is long enough to be inert and short enough to observe.
process.env.CHATGPT_TIMEOUT_MS ||= '4000'

const modulePath = process.env.G016_SRC
  ? path.resolve(process.env.G016_SRC)
  : path.join(import.meta.dir, 'chatgpt.mjs')
const { ask, flushLog, BASE } = await import(pathToFileURL(modulePath).href)

/** `log()` appends to the module's own BASE, which HOME redirected to scratch. */
const LOG = path.join(BASE, 'driver.log')

const THREAD = '11111111-1111-4111-8111-111111111111'
const TEXT = 'count the peers on the bus'
const URL_NOW = `https://chatgpt.com/c/${THREAD}`
const SEND_POST = 'https://chatgpt.com/backend-api/conversation'

// How long the page stays empty after the send POST's stream ends, used by row
// d1. It must exceed the longest settle the contract permits (~250 ms), or a
// conforming shortener that reads at its settle samples after the render and is
// judged on a text the row never meant to hide. Row d2 is the mirror: there the
// change must be IN PLACE by the shortest permitted settle, so it uses 150 ms.
const STREAM_END_EMPTY_MS = 300

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * The CDP session the observer would talk to. Handlers are real (the fixture
 * emits into them); `Network.disable` and `detach` tear the domain down exactly
 * as they would on a real target, which is what makes the lifetime row mean
 * something.
 */
function makeSession() {
  const handlers = new Map()
  const stats = { enables: 0, disables: 0, detaches: 0 }
  const clear = () => handlers.clear()
  return {
    stats,
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, new Set())
      handlers.get(event).add(handler)
    },
    async send(command) {
      if (command === 'Network.enable') stats.enables += 1
      if (command === 'Network.disable') { stats.disables += 1; clear() }
      return {}
    },
    async detach() { stats.detaches += 1; clear() },
    emit(event, payload) { for (const handler of handlers.get(event) ?? []) handler(payload) },
    listenerCount() { let total = 0; for (const set of handlers.values()) total += set.size; return total },
  }
}

/**
 * A fake page that satisfies the exported send path. `script.sample(index)`
 * decides each reply sample's text; `script.onClick(ctx)` fires the CDP events
 * for the turn, where `ctx.emit(event, payload)` is the session's emitter.
 */
function makeRig(script, sharedSession = null) {
  const state = { composerText: '', samples: 0, clicked: false }
  const session = sharedSession ?? makeSession()
  const pageRequests = new Set()

  const nodeFor = kind => ({
    isVisible: async () => true,
    isEnabled: async () => true,
    isDisabled: async () => false,
    getAttribute: async () => null,
    boundingBox: async () => ({ x: 0, y: 0, width: 10, height: 10 }),
    scrollIntoViewIfNeeded: async () => {},
    focus: async () => {},
    fill: async text => { state.composerText = text },
    click: async () => {
      if (kind !== 'send' || state.clicked) return
      state.clicked = true
      script.onClick?.({
        emit: (event, payload) => session.emit(event, payload),
        clickAt: Date.now(),
      })
    },
    evaluate: async fn => (String(fn).includes('innerText') || String(fn).includes('textContent') ? state.composerText : null),
    innerText: async () => '',
  })

  const kindOf = selector => {
    if (selector === 'button[aria-label="Send" i]' || selector === '[data-testid="send-button"]' || selector === 'button[aria-label*="Send prompt" i]') return 'send'
    if (selector === '#prompt-textarea' || selector === 'div.ProseMirror[contenteditable="true"]' || selector === 'div[contenteditable="true"]' || selector === 'textarea[data-testid="prompt-textarea"]') return 'composer'
    if (selector === '[data-markdown-text-style="assistant-message"]') return 'assistant'
    return 'other'
  }

  const page = {
    url: () => URL_NOW,
    on: (event, handler) => { if (event === 'request') pageRequests.add(handler) },
    off: (event, handler) => { if (event === 'request') pageRequests.delete(handler) },
    keyboard: {
      insertText: async text => { state.composerText = text },
      press: async () => {},
    },
    context: () => ({ newCDPSession: async () => session }),
    locator: selector => {
      const kind = kindOf(selector)
      return {
        count: async () => (kind === 'assistant' ? 0 : kind === 'other' ? 0 : 1),
        nth: () => nodeFor(kind),
        last: () => nodeFor(kind),
      }
    },
    evaluate: async (fn, arg) => {
      const source = String(fn)
      if (source.includes('userOnly')) {
        // readUserNodesInPage: a thread with no user turns, freshly projected.
        return { ok: true, status: 200, via: 'in-page', body: { mapping: {} } }
      }
      if (source.includes('identities')) return { identities: [], texts: [] }
      if (source.includes('candidates')) {
        const text = script.sample(state.samples)
        state.samples += 1
        return { found: true, text, state: 'complete', candidates: 1 }
      }
      if (source.includes('streaming')) return { stop: false, streaming: false, busy: false }
      if (source.includes('loggedIn')) {
        return { url: URL_NOW, title: 'fixture', composer: true, challenge: false, model: null, loggedIn: true, email: null, plan: null }
      }
      if (source.includes('progressbar')) return false
      // The whole-body read the reply guard uses for its "the page reported a
      // problem" refusal. A script can make it carry the refusal text.
      if (source.includes('-4000')) return script.problem ?? ''
      throw new Error(`fixture: unrecognised page.evaluate (${source.slice(0, 80)})`)
    },
  }

  return {
    page,
    session,
    samples: () => state.samples,
    pageRequestListeners: () => pageRequests.size,
  }
}

/** One turn on a fresh rig; returns the outcome and the wall clock it took. */
async function turn(script) {
  const rig = makeRig(script)
  await flushLog()
  await fs.writeFile(LOG, '').catch(() => {})
  const startedAt = Date.now()
  let result = null
  let error = null
  try {
    result = await ask(rig.page, TEXT, { wait: true })
  } catch (caught) {
    error = caught
  }
  const elapsed = Date.now() - startedAt
  await flushLog()
  const lines = (await fs.readFile(LOG, 'utf8').catch(() => '')).split('\n').filter(Boolean)
  return { ...rig, result, error, elapsed, lines }
}

const replyOf = outcome => outcome.result?.reply ?? null
const fallbackSlow = outcome => outcome.elapsed >= 1600
const shortened = outcome => outcome.elapsed <= 1200
const instrumentLine = outcome => outcome.lines.find(line => /reply in \d+ms: text stable for \d+ms, \d+ agreeing samples/.test(line)) ?? null

/**
 * The stamps on a shortener line, as numbers: `ms` offsets from the turn start,
 * and ISO-8601 instants as epoch millis. The log's own leading ISO prefix and a
 * `reply in <ms>ms` total are dropped first, so neither can stand in for one of
 * the two stamps.
 */
const shortenerStampTokens = line => {
  const body = line
    .replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+/, '')
    .replace(/\breply in \d+ms\b/, '')
  return {
    ms: [...body.matchAll(/(\d+)ms\b/g)].map(match => Number(match[1])),
    iso: [...body.matchAll(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g)].map(match => Date.parse(match[0])),
  }
}

/**
 * The shortener's line must name the stream end AND the first stable sample, on
 * one line, with a stamp for each, and the two stamps must differ by the settle
 * the shortener actually waited. Wording is free; the stamp pair is not.
 *
 * Counting is by DISTINCT token after discounting the log prefix and the total
 * (`<n>ms` values and ISO-8601 stamps count alike). A line that logs one stamp,
 * or logs the same value twice, fails - that is the contract's "both stamps".
 */
const shortenerStamps = line => {
  const { ms, iso } = shortenerStampTokens(line)
  return new Set([...ms.map(value => `ms:${value}`), ...iso.map(value => `iso:${value}`)])
}

/**
 * The settle the line records: the gap between the two stamps, in ms. Only
 * stamps of one convention are compared (offsets to offsets, instants to
 * instants); a line mixing them without a pair of either cannot state a settle
 * and returns null. Two tokens that differ by a tick yield ~1 ms, which is why
 * the row asserts a window rather than "distinct".
 */
const shortenerSettle = line => {
  const { ms, iso } = shortenerStampTokens(line)
  const values = ms.length >= 2 ? ms : iso.length >= 2 ? iso : null
  if (!values) return null
  const distinct = [...new Set(values)]
  if (distinct.length < 2) return null
  return Math.max(...distinct) - Math.min(...distinct)
}

const shortenerLine = outcome => outcome.lines.find(line =>
  /stream|finished|loadingFinished/i.test(line)
  && /stable/i.test(line)
  && shortenerStamps(line).size >= 2) ?? null

/**
 * The cancel-end line: `reply stream:` marking a shortened turn, the word that
 * names the end as a cancellation, and the same two-stamp pair row (a)
 * requires. A cancel that shortens must be able to say so without the clean
 * `loadingFinished` wording, and a cloned stamp on it is the same hole.
 */
const cancelLine = outcome => outcome.lines.find(line =>
  /reply stream:/i.test(line)
  && /cancel/i.test(line)
  && shortenerStamps(line).size >= 2) ?? null

const settleInWindow = line => {
  const settle = line ? shortenerSettle(line) : null
  return settle !== null && settle >= 150 && settle <= 400
}

/** Request + 2xx response for one send POST, the #109 acceptance path. */
function acceptSend(emit, requestId) {
  emit('Network.requestWillBeSent', { requestId, request: { method: 'POST', url: SEND_POST } })
  emit('Network.responseReceived', { requestId, response: { status: 200, url: SEND_POST } })
}

describe('G-016: the reply shortener', () => {
  // (a) the shortened path ---------------------------------------------------
  test('a. loadingFinished on the send request shortens the guard to one stable sample, and both stamps are logged', async () => {
    const one = await turn({
      sample: () => TEXT,
      onClick: ({ emit, clickAt }) => {
        acceptSend(emit, 'r1')
        setTimeout(() => emit('Network.loadingFinished', { requestId: 'r1' }), 40)
      },
    })
    const line = shortenerLine(one)
    const settle = line ? shortenerSettle(line) : null
    console.log(`[row a] elapsed=${one.elapsed}ms samples=${one.samples()} line=${line ? 'yes' : 'no'} settle=${settle}`)
    expect({
      reply: replyOf(one),
      shortened: shortened(one),
      oneOrTwoSamples: one.samples() <= 2,
      bothStampsLogged: Boolean(line),
      // Not merely distinct: the pair must show the settle the shortener waited.
      settleInWindow: settle !== null && settle >= 150 && settle <= 400,
    }).toEqual({
      reply: TEXT,
      shortened: true,
      oneOrTwoSamples: true,
      bothStampsLogged: true,
      settleInWindow: true,
    })
  }, 30_000)

  // (b) no finish: the 3 x 900 ms path, and its instrument -------------------
  test('b. no loadingFinished for that request falls back to the existing 3 x 900 ms path', async () => {
    const one = await turn({
      sample: () => TEXT,
      onClick: ({ emit }) => acceptSend(emit, 'r1'),
    })
    const line = instrumentLine(one)
    console.log(`[row b] elapsed=${one.elapsed}ms samples=${one.samples()} instrument=${line ? 'yes' : 'no'}`)
    expect({
      reply: replyOf(one),
      fallbackSlow: fallbackSlow(one),
      threeSamples: one.samples() >= 3,
      instrumentLogged: Boolean(line),
    }).toEqual({
      reply: TEXT,
      fallbackSlow: true,
      threeSamples: true,
      instrumentLogged: true,
    })
  }, 30_000)

  // (c) loadingFailed never shortens ----------------------------------------
  test('c. loadingFailed on the send request falls back and never shortens', async () => {
    const one = await turn({
      sample: () => TEXT,
      onClick: ({ emit }) => {
        acceptSend(emit, 'r1')
        setTimeout(() => emit('Network.loadingFailed', { requestId: 'r1', errorText: 'net::ERR_ABORTED' }), 40)
      },
    })
    console.log(`[row c] elapsed=${one.elapsed}ms samples=${one.samples()}`)
    expect({
      reply: replyOf(one),
      fallbackSlow: fallbackSlow(one),
      threeSamples: one.samples() >= 3,
    }).toEqual({
      reply: TEXT,
      fallbackSlow: true,
      threeSamples: true,
    })
  }, 30_000)

  // (d) an empty or still-changing sample at stream end ----------------------
  test('d1. an empty sample at stream end falls back instead of accepting', async () => {
    // Keyed to the EVENT, not to the read index: every read taken from the
    // `loadingFinished` emission until the page renders is empty; reads before
    // the event and after the window carry the text. A correct implementation
    // that happens to read once before the stream ends and once at it is not
    // failed for its read order - only for treating an empty sample as stable.
    //
    // The window is STREAM_END_EMPTY_MS, not 150 ms: the empty state has to
    // outlast the longest settle the contract allows (~250 ms). A design that
    // settles 200 ms and reads then would otherwise sample AFTER the page
    // rendered, get the text, and shorten - legitimate, but the row would be
    // pinning that design's settle choice instead of "an empty sample at stream
    // end". 300 ms is the contract's upper bound plus scheduling slack.
    let finishedAt = 0
    const one = await turn({
      sample: () => {
        const now = Date.now()
        return finishedAt && now >= finishedAt && now < finishedAt + STREAM_END_EMPTY_MS ? '' : TEXT
      },
      onClick: ({ emit }) => {
        acceptSend(emit, 'r1')
        setTimeout(() => {
          finishedAt = Date.now()
          emit('Network.loadingFinished', { requestId: 'r1' })
        }, 40)
      },
    })
    console.log(`[row d1] elapsed=${one.elapsed}ms samples=${one.samples()}`)
    expect({
      reply: replyOf(one),
      fallbackSlow: fallbackSlow(one),
      threeSamples: one.samples() >= 3,
    }).toEqual({
      reply: TEXT,
      fallbackSlow: true,
      threeSamples: true,
    })
  }, 30_000)

  test('d2. a sample that changes on the next tick falls back instead of accepting', async () => {
    // Event-keyed likewise: the text changes only from 150 ms after
    // `loadingFinished` onwards, so a read before or AT the stream end sees the
    // old text and the changed text is what must not be accepted early.
    let finishedAt = 0
    const one = await turn({
      sample: () => {
        const now = Date.now()
        return finishedAt && now >= finishedAt + 150 ? `${TEXT}!` : TEXT
      },
      onClick: ({ emit }) => {
        acceptSend(emit, 'r1')
        setTimeout(() => {
          finishedAt = Date.now()
          emit('Network.loadingFinished', { requestId: 'r1' })
        }, 40)
      },
    })
    console.log(`[row d2] elapsed=${one.elapsed}ms samples=${one.samples()}`)
    expect({
      reply: replyOf(one),
      fallbackSlow: fallbackSlow(one),
      threeOrMoreSamples: one.samples() >= 3,
    }).toEqual({
      reply: `${TEXT}!`,
      fallbackSlow: true,
      threeOrMoreSamples: true,
    })
  }, 30_000)

  // (e) only the newest send requestId settles -------------------------------
  test('e1. a finish on a superseded requestId does not settle the turn', async () => {
    const one = await turn({
      sample: () => TEXT,
      onClick: ({ emit }) => {
        emit('Network.requestWillBeSent', { requestId: 'r1', request: { method: 'POST', url: SEND_POST } })
        emit('Network.requestWillBeSent', { requestId: 'r2', request: { method: 'POST', url: SEND_POST } })
        emit('Network.responseReceived', { requestId: 'r2', response: { status: 200, url: SEND_POST } })
        setTimeout(() => emit('Network.loadingFinished', { requestId: 'r1' }), 40)
      },
    })
    console.log(`[row e1] elapsed=${one.elapsed}ms samples=${one.samples()}`)
    expect({
      reply: replyOf(one),
      fallbackSlow: fallbackSlow(one),
      threeSamples: one.samples() >= 3,
    }).toEqual({
      reply: TEXT,
      fallbackSlow: true,
      threeSamples: true,
    })
  }, 30_000)

  test('e2. a finish on the newest requestId shortens the turn', async () => {
    const one = await turn({
      sample: () => TEXT,
      onClick: ({ emit }) => {
        emit('Network.requestWillBeSent', { requestId: 'r1', request: { method: 'POST', url: SEND_POST } })
        emit('Network.requestWillBeSent', { requestId: 'r2', request: { method: 'POST', url: SEND_POST } })
        emit('Network.responseReceived', { requestId: 'r2', response: { status: 200, url: SEND_POST } })
        setTimeout(() => emit('Network.loadingFinished', { requestId: 'r2' }), 40)
      },
    })
    console.log(`[row e2] elapsed=${one.elapsed}ms samples=${one.samples()}`)
    expect({
      reply: replyOf(one),
      shortened: shortened(one),
      oneOrTwoSamples: one.samples() <= 2,
    }).toEqual({
      reply: TEXT,
      shortened: true,
      oneOrTwoSamples: true,
    })
  }, 30_000)

  // (f) the shortener is never an acceptor -----------------------------------
  test('f. a stream that ends on an unaccepted send leaves the turn unaccepted', async () => {
    const one = await turn({
      sample: () => TEXT,
      onClick: ({ emit }) => {
        emit('Network.requestWillBeSent', { requestId: 'r1', request: { method: 'POST', url: SEND_POST } })
        emit('Network.responseReceived', { requestId: 'r1', response: { status: 500, url: SEND_POST } })
        setTimeout(() => emit('Network.loadingFinished', { requestId: 'r1' }), 40)
      },
    })
    const message = String(one.error?.message ?? '')
    console.log(`[row f] threw=${Boolean(one.error)} message=${JSON.stringify(message.slice(0, 90))}`)
    expect({
      threw: Boolean(one.error),
      ambiguous: /ambiguous|may have landed/i.test(message),
      noReply: one.result === null,
    }).toEqual({
      threw: true,
      ambiguous: true,
      noReply: true,
    })
  }, 30_000)

  // (g) a client cancellation is an end --------------------------------------
  test('g. a cancel end on the accepted id shortens to one confirming read, and says cancel', async () => {
    const one = await turn({
      sample: () => TEXT,
      onClick: ({ emit }) => {
        acceptSend(emit, 'r1')
        // The live shape: the SSE body's last frame, then no loadingFinished at
        // all - the target reports the request as client-canceled 12 ms later.
        setTimeout(() => {
          emit('Network.dataReceived', { requestId: 'r1', dataLength: 1024 })
          setTimeout(() => emit('Network.loadingFailed', {
            requestId: 'r1', canceled: true, errorText: 'net::ERR_ABORTED',
          }), 12)
        }, 40)
      },
    })
    const line = cancelLine(one)
    console.log(`[row g] elapsed=${one.elapsed}ms samples=${one.samples()} cancelLine=${line ? 'yes' : 'no'} settle=${line ? shortenerSettle(line) : null}`)
    expect({
      reply: replyOf(one),
      shortened: shortened(one),
      oneOrTwoSamples: one.samples() <= 2,
      cancelLineLogged: Boolean(line),
      // The same stamp discipline as row (a): a cloned stamp is not an end.
      bothStamps: Boolean(line) && shortenerStamps(line).size >= 2,
      settleInWindow: settleInWindow(line),
    }).toEqual({
      reply: TEXT,
      shortened: true,
      oneOrTwoSamples: true,
      cancelLineLogged: true,
      bothStamps: true,
      settleInWindow: true,
    })
  }, 30_000)

  // (h) an end alone never accepts -------------------------------------------
  test('h. a cancel end with an empty page at the confirming read falls back', async () => {
    // Same event as (g); only the page differs. Empty out to STREAM_END_EMPTY_MS
    // after the event, for the same reason as d1.
    let finishedAt = 0
    const one = await turn({
      sample: () => {
        const now = Date.now()
        return finishedAt && now >= finishedAt && now < finishedAt + STREAM_END_EMPTY_MS ? '' : TEXT
      },
      onClick: ({ emit }) => {
        acceptSend(emit, 'r1')
        setTimeout(() => {
          emit('Network.dataReceived', { requestId: 'r1', dataLength: 1024 })
          finishedAt = Date.now()
          emit('Network.loadingFailed', { requestId: 'r1', canceled: true, errorText: 'net::ERR_ABORTED' })
        }, 40)
      },
    })
    console.log(`[row h] elapsed=${one.elapsed}ms samples=${one.samples()}`)
    expect({
      reply: replyOf(one),
      fallbackSlow: fallbackSlow(one),
      threeSamples: one.samples() >= 3,
    }).toEqual({
      reply: TEXT,
      fallbackSlow: true,
      threeSamples: true,
    })
  }, 30_000)

  // (i) a transport failure is not an end ------------------------------------
  test('i. a transport failure never shortens: full cadence, no cancel line', async () => {
    const one = await turn({
      sample: () => TEXT,
      onClick: ({ emit }) => {
        acceptSend(emit, 'r1')
        setTimeout(() => emit('Network.loadingFailed', {
          requestId: 'r1', canceled: false, errorText: 'net::ERR_CONTENT_LENGTH_MISMATCH',
        }), 40)
      },
    })
    console.log(`[row i] elapsed=${one.elapsed}ms samples=${one.samples()} streamLine=${one.lines.some(line => /reply stream:/i.test(line))}`)
    expect({
      reply: replyOf(one),
      fallbackSlow: fallbackSlow(one),
      threeSamples: one.samples() >= 3,
      noCancelLine: cancelLine(one) === null,
      noStreamLine: !one.lines.some(line => /reply stream:/i.test(line)),
    }).toEqual({
      reply: TEXT,
      fallbackSlow: true,
      threeSamples: true,
      noCancelLine: true,
      noStreamLine: true,
    })
  }, 30_000)

  // (j) only the newest id ---------------------------------------------------
  test('j1. a cancel on a superseded requestId does not settle the turn', async () => {
    const one = await turn({
      sample: () => TEXT,
      onClick: ({ emit }) => {
        emit('Network.requestWillBeSent', { requestId: 'r1', request: { method: 'POST', url: SEND_POST } })
        emit('Network.requestWillBeSent', { requestId: 'r2', request: { method: 'POST', url: SEND_POST } })
        emit('Network.responseReceived', { requestId: 'r2', response: { status: 200, url: SEND_POST } })
        setTimeout(() => emit('Network.loadingFailed', { requestId: 'r1', canceled: true, errorText: 'net::ERR_ABORTED' }), 40)
      },
    })
    console.log(`[row j1] elapsed=${one.elapsed}ms samples=${one.samples()}`)
    expect({
      reply: replyOf(one),
      fallbackSlow: fallbackSlow(one),
      threeSamples: one.samples() >= 3,
    }).toEqual({
      reply: TEXT,
      fallbackSlow: true,
      threeSamples: true,
    })
  }, 30_000)

  test('j2. a cancel on the newest requestId shortens the turn', async () => {
    const one = await turn({
      sample: () => TEXT,
      onClick: ({ emit }) => {
        emit('Network.requestWillBeSent', { requestId: 'r1', request: { method: 'POST', url: SEND_POST } })
        emit('Network.requestWillBeSent', { requestId: 'r2', request: { method: 'POST', url: SEND_POST } })
        emit('Network.responseReceived', { requestId: 'r2', response: { status: 200, url: SEND_POST } })
        setTimeout(() => emit('Network.loadingFailed', { requestId: 'r2', canceled: true, errorText: 'net::ERR_ABORTED' }), 40)
      },
    })
    const line = cancelLine(one)
    console.log(`[row j2] elapsed=${one.elapsed}ms samples=${one.samples()} cancelLine=${line ? 'yes' : 'no'} settle=${line ? shortenerSettle(line) : null}`)
    expect({
      reply: replyOf(one),
      shortened: shortened(one),
      oneOrTwoSamples: one.samples() <= 2,
      cancelLineLogged: Boolean(line),
      settleInWindow: settleInWindow(line),
    }).toEqual({
      reply: TEXT,
      shortened: true,
      oneOrTwoSamples: true,
      cancelLineLogged: true,
      settleInWindow: true,
    })
  }, 30_000)

  // lifetime -----------------------------------------------------------------
  test('lifetime. every exit path stops the per-turn observer', async () => {
    // The addendum requires the observer to be stopped in a finally covering
    // every exit: answer, throw, timeout, abort. These rows are green at base by
    // design (base stops the observer before the reply wait); their job is to
    // catch a leak in a design that keeps it alive through the reply.
    const session = makeSession()
    const exits = [
      {
        name: 'answer',
        script: { sample: () => TEXT, onClick: ({ emit }) => acceptSend(emit, 'answer') },
        check: ({ result, error }) => !error && result?.reply === TEXT,
      },
      {
        name: 'throw-before-acceptance',
        script: {
          sample: () => TEXT,
          onClick: ({ emit }) => {
            emit('Network.requestWillBeSent', { requestId: 'g1', request: { method: 'POST', url: SEND_POST } })
            emit('Network.responseReceived', { requestId: 'g1', response: { status: 500, url: SEND_POST } })
          },
        },
        check: ({ error }) => /ambiguous|may have landed/i.test(String(error?.message ?? '')),
      },
      {
        name: 'timeout',
        script: { sample: () => '', onClick: ({ emit }) => acceptSend(emit, 'timeout') },
        check: ({ result }) => result?.timedOut === true,
      },
      {
        name: 'throw-after-acceptance',
        script: {
          sample: () => TEXT,
          problem: 'Something went wrong in this conversation.',
          onClick: ({ emit }) => acceptSend(emit, 'problem'),
        },
        check: ({ error }) => /reported a problem/i.test(String(error?.message ?? '')),
      },
    ]
    const observeds = []
    for (const exit of exits) {
      // The same session object across turns: a watcher that is created and not
      // stopped leaves its handlers right here.
      const rig = makeRig(exit.script, session)
      const before = { ...session.stats }
      await flushLog()
      await fs.writeFile(LOG, '').catch(() => {})
      let result = null
      let error = null
      try {
        result = await ask(rig.page, TEXT, { wait: true })
      } catch (caught) {
        error = caught
      }
      await flushLog()
      observeds.push({
        exit: exit.name,
        listenersAfter: session.listenerCount(),
        enables: session.stats.enables - before.enables,
        disables: session.stats.disables - before.disables,
        detaches: session.stats.detaches - before.detaches,
        asExpected: exit.check({ result, error }),
      })
    }
    console.log(`[lifetime] ${JSON.stringify(observeds)}`)
    // The contract is "no accumulating Network.* listeners, observer created
    // per turn, stopped on every exit". Enables/disables/detaches are logged
    // because they show how the observer was torn down, but only the listener
    // count and one enable per turn are asserted: a rewrite may legitimately
    // stop the session by detach alone or by disable alone.
    expect(observeds.map(entry => ({
      exit: entry.exit,
      listenersAfter: entry.listenersAfter,
      oneEnable: entry.enables === 1,
      asExpected: entry.asExpected,
    }))).toEqual(exits.map(exit => ({
      exit: exit.name,
      listenersAfter: 0,
      oneEnable: true,
      asExpected: true,
    })))
  }, 60_000)
})
