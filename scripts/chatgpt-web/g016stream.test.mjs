/**
 * G-016 shortener fixture: the send POST's stream end, used as a CADENCE hint.
 *
 * Written against the change, from the contract rather than from the diff. The
 * frozen proof (proof/d5proof.mjs) stays untouched and is run separately; this
 * file only drives exported seams with fakes, so it needs no Chrome.
 *
 * Run: `bun test g016stream.test.mjs`
 *
 * Red run against the base (5b92ad3), where neither `startNetworkWatch`'s
 * `completion` nor `waitForReply`'s fourth argument exists:
 *
 *   G016STREAM_SRC=$(git show 5b92ad3:chatgpt.mjs > /tmp/base.mjs && echo /tmp/base.mjs) \
 *     bun test g016stream.test.mjs
 *
 * What is pinned, in the head's order:
 *
 *   (a) stable-sample   - a clean stream end costs exactly two reads: the
 *                         guard's own sample is the reference and one confirming
 *                         sample is taken a settle later. The evidence rule is
 *                         not lowered.
 *   (b) no-signal       - with no completion signal the loop is byte-identical to
 *                         the guard it was before: same line, same 900 ms cadence.
 *   (c) loadingFailed   - a transport fault that is NOT a client cancellation
 *                         is no end - including ERR_ABORTED with no `canceled`
 *                         field. The cadence stays at 900 ms throughout, never
 *                         cut, and no shortener line is written.
 *   (ca) canceled       - the live page cancels its own SSE reader (ERR_ABORTED
 *                         + canceled, no loadingFinished): that IS an end, and
 *                         the line names the kind.
 *   (d) empty/changing  - one empty or changing sample at stream end retires the
 *                         shorter path for the rest of the turn: the guard's
 *                         900 ms governs every later wait.
 *   (e) superseded      - a second send POST makes the completion unattributable
 *                         (null), so it can never shorten the turn it does not own.
 *   (f) observer life   - N consecutive turns on ONE page object: the page request
 *                         listeners and live CDP sessions return to their pre-turn
 *                         count after EVERY turn, including a turn that throws.
 *
 * HOME/USERPROFILE are redirected before the import so the fixture's log lines
 * land in the scratch directory and never in the live driver.log.
 */
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const SCRATCH = path.join(os.tmpdir(), 'g016stream-fixture')
const HOME = path.join(SCRATCH, 'home')
process.env.CHATGPT_PROFILE ||= path.join(SCRATCH, 'profile')
process.env.HOME = HOME
process.env.USERPROFILE = HOME

const source = process.env.G016STREAM_SRC
  ? pathToFileURL(path.resolve(process.env.G016STREAM_SRC)).href
  : new URL('./chatgpt.mjs', import.meta.url).href
const mod = await import(source)

const THREAD = '11111111-1111-4111-8111-111111111111'
const TEXT = 'count the peers on the bus'
// Read the module's OWN log path, not this file's HOME: when two fixtures run in
// one bun process the module is imported once, and the first importer's HOME is
// the one it resolved. `BASE` is the authoritative path either way.
const LOG = path.join(mod.BASE, 'driver.log')

// --- log capture, per test ---------------------------------------------------

async function mark() {
  await mod.flushLog()
  const text = await fs.readFile(LOG, 'utf8').catch(() => '')
  return text.split('\n').filter(Boolean).length
}

/** The lines written after `from`, with the ISO stamp stripped. */
async function linesSince(from) {
  await mod.flushLog()
  const text = await fs.readFile(LOG, 'utf8').catch(() => '')
  return text.split('\n').filter(Boolean).slice(from).map(line => line.replace(/^\S+ /, ''))
}

// --- a page whose reply samples follow a plan --------------------------------

/**
 * Each entry is one `sampleTurn` observation. `busy` applies to the `busyState`
 * read that follows that same observation. The last entry repeats forever.
 */
function replyPage(plan) {
  let index = 0
  const times = []
  const page = {
    url: () => `https://chatgpt.com/c/${THREAD}`,
    evaluate: async (fn, arg) => {
      const src = String(fn)
      const entry = plan[Math.min(Math.max(index - 1, 0), plan.length - 1)]
      if (/querySelectorAll\(selector\)/.test(src)) {
        index += 1
        times.push(Date.now())
        const now = plan[Math.min(index - 1, plan.length - 1)]
        return now.found === false
          ? { found: false, text: '', state: null, candidates: now.candidates ?? 1 }
          : { found: true, text: now.text, state: 'complete', candidates: now.candidates ?? 1 }
      }
      if (/stop-button/.test(src)) {
        return { stop: false, streaming: false, busy: Boolean(entry?.busy) }
      }
      return '' // the problem-body read at the end of the guard
    },
    samples: () => index,
    times: () => times,
    gaps: () => times.slice(1).map((at, i) => at - times[i]),
  }
  return page
}

/** The guard's normal start: nothing before, nothing sent before. */
const before = { count: 0, text: '' }

const cleanEnd = (at, end = 'finished') => ({ at, requestId: 'r1', end })

// --- a fake CDP page, so the watcher is exercised without Chrome -------------

async function fakeWatcher() {
  const handlers = new Map()
  const state = { enabled: 0, disabled: 0, detached: 0, live: 0 }
  let detached = false
  const session = {
    on: (event, handler) => { handlers.set(event, handler) },
    send: async method => {
      if (method === 'Network.enable') state.enabled += 1
      if (method === 'Network.disable') state.disabled += 1
      return {}
    },
    detach: async () => {
      if (!detached) { detached = true; state.detached += 1; state.live -= 1 }
      return {}
    },
  }
  const page = {
    url: () => `https://chatgpt.com/c/${THREAD}`,
    context: () => ({
      newCDPSession: async () => { state.live += 1; return session },
    }),
  }
  const watch = await mod.startNetworkWatch(page)
  const emit = (event, payload) => handlers.get(event)?.(payload)
  const url = 'https://chatgpt.com/backend-api/conversation'
  return {
    watch,
    state,
    send: requestId => emit('Network.requestWillBeSent', { requestId, request: { method: 'POST', url } }),
    answered: (requestId, status = 200) => emit('Network.responseReceived', { requestId, response: { status, url } }),
    finished: requestId => emit('Network.loadingFinished', { requestId }),
    // The live page cancels its own reader when the SSE ends: the transport
    // reports ERR_ABORTED with `canceled: true` and never a loadingFinished.
    // Both fields are explicit here, because only `canceled === true` may count.
    failed: (requestId, errorText = 'net::ERR_ABORTED', canceled = undefined) =>
      emit('Network.loadingFailed', { requestId, errorText, canceled }),
  }
}

// ---------------------------------------------------------------------------

describe('G-016 stream-end shortener', () => {
  // (a) stable-sample --------------------------------------------------------
  test('a. a clean stream end costs one guard read and one confirming read', async () => {
    const page = replyPage([{ text: TEXT }, { text: TEXT }, { text: TEXT }, { text: TEXT }])
    const watch = { completion: Promise.resolve(cleanEnd(Date.now() - 100)) }
    const from = await mark()
    const startedAt = Date.now()
    const result = await mod.waitForReply(page, before.count, before.text, watch)
    const elapsed = Date.now() - startedAt

    expect(result.reply).toBe(TEXT)
    // Two reads: the guard's own sample (the reference) and the confirming read
    // one settle later. No fresh reference read at the stream end.
    expect(page.samples()).toBe(2)
    const gaps = page.gaps()
    expect(gaps.length).toBe(1)
    expect(gaps[0]).toBeGreaterThanOrEqual(150)
    expect(gaps[0]).toBeLessThan(600)
    expect(elapsed).toBeLessThan(800)

    const lines = await linesSince(from)
    // The guard's own line, unchanged in shape...
    const guard = lines.find(line => /^reply in \d+ms: text stable for \d+ms, \d+ agreeing samples$/.test(line))
    expect(guard).toBeDefined()
    // ...and the shortener's own line, carrying BOTH stamps: the stream end and
    // the confirming read. (The stream stamp may be negative here only because
    // this fixture hands in a completion that predates the call; live, it is
    // always after the click.) The stamp must be the confirming read's time,
    // not the stream end again, so the settle is recoverable from the line.
    const short = lines.find(line => /^reply stream: ended at -?\d+ms \((finished|canceled)\), first stable sample at -?\d+ms \(shortener\)$/.test(line))
    expect(short).toBeDefined()
    // A clean body names its kind, so a reader never has to guess.
    expect(short).toContain('(finished)')
    const endedAt = Number(/ended at (-?\d+)ms/.exec(short)[1])
    const stableStamp = Number(/first stable sample at (-?\d+)ms/.exec(short)[1])
    expect(stableStamp - endedAt).toBeGreaterThanOrEqual(150)
    expect(stableStamp - endedAt).toBeLessThanOrEqual(400)
  }, 15_000)

  // (b) no-signal fallback ---------------------------------------------------
  test('b. without a signal the loop is byte-identical to the guard it was', async () => {
    const plan = [{ text: TEXT }, { text: TEXT }, { text: TEXT }]

    const plain = replyPage(plan)
    const fromPlain = await mark()
    const plainResult = await mod.waitForReply(plain, before.count, before.text)
    const plainLines = await linesSince(fromPlain)

    const empty = replyPage(plan)
    const fromEmpty = await mark()
    // A watch that carries no completion is the same absence as no watch.
    const emptyResult = await mod.waitForReply(empty, before.count, before.text, {})
    const emptyLines = await linesSince(fromEmpty)

    expect(plainResult.reply).toBe(TEXT)
    expect(emptyResult.reply).toBe(TEXT)
    // Same lines, same fields, same order: only the wall-clock numbers differ
    // between two runs, so they are normalized before the comparison.
    const shape = lines => lines.map(line => line
      .replace(/\b\d+ms\b/g, '<ms>')
      .replace(/\b\d+ agreeing samples$/, '<n> agreeing samples'))
    expect(shape(plainLines)).toEqual(shape(emptyLines))
    expect(plainLines.some(line => /^reply stream:/.test(line))).toBe(false)
    // The old cadence is intact: 900 ms, never the shortener's settle.
    expect(Math.min(...plain.gaps())).toBeGreaterThanOrEqual(800)
    expect(Math.min(...empty.gaps())).toBeGreaterThanOrEqual(800)
  }, 20_000)

  // (c) loadingFailed --------------------------------------------------------
  test('c. a transport fault that is not a cancellation is never an end', async () => {
    // ERR_ABORTED with NO `canceled` field, and ERR_ABORTED with an explicit
    // `canceled: false`. An aborted-looking transport failure is ambiguous (a
    // truncation and a finished reader both read as ERR_ABORTED), so each one
    // pays the full fallback: 3 x 900 ms and no shortener line.
    for (const canceled of [undefined, false]) {
      const fake = await fakeWatcher()
      fake.send('r1')
      fake.answered('r1')
      fake.failed('r1', 'net::ERR_ABORTED', canceled)
      const completion = await fake.watch.completion
      expect(completion).toMatchObject({ requestId: 'r1', reason: 'net::ERR_ABORTED' })
      expect(completion.at).toBeUndefined()
      expect(completion.end).toBeUndefined()

      const page = replyPage([{ text: TEXT }, { text: TEXT }, { text: TEXT }])
      const from = await mark()
      const result = await mod.waitForReply(page, before.count, before.text, fake.watch)
      const lines = await linesSince(from)

      expect(result.reply).toBe(TEXT)
      // Not shortened AND not cut: a failed signal is teardown information only,
      // so every interval the guard serves is its full 900 ms.
      const gaps = page.gaps()
      expect(gaps.every(gap => gap >= 800)).toBe(true)
      expect(page.samples()).toBe(mod.ANSWER_AGREE_SAMPLES)
      expect(lines.some(line => /^reply stream:/.test(line))).toBe(false)
      await fake.watch.stop()
    }

    // A mismatch with `canceled: false` is the same verdict.
    const mismatch = await fakeWatcher()
    mismatch.send('r1')
    mismatch.answered('r1')
    mismatch.failed('r1', 'net::ERR_CONTENT_LENGTH_MISMATCH', false)
    const mismatchCompletion = await mismatch.watch.completion
    expect(mismatchCompletion).toMatchObject({ requestId: 'r1', reason: 'net::ERR_CONTENT_LENGTH_MISMATCH' })
    expect(mismatchCompletion.at).toBeUndefined()
    await mismatch.watch.stop()
  }, 20_000)

  test('ca. the live page cancels its own reader: that IS an end', async () => {
    // Live shape: fifteen SSE chunks, then loadingFailed ERR_ABORTED with
    // canceled true 12 ms after the last chunk, and no loadingFinished ever.
    const fake = await fakeWatcher()
    fake.send('r1')
    fake.answered('r1')
    fake.failed('r1', 'net::ERR_ABORTED', true)
    const completion = await fake.watch.completion
    expect(completion).toMatchObject({ requestId: 'r1', end: 'canceled' })
    expect(typeof completion.at).toBe('number')

    const page = replyPage([{ text: TEXT }])
    const from = await mark()
    const startedAt = Date.now()
    const result = await mod.waitForReply(page, before.count, before.text, fake.watch)
    const elapsed = Date.now() - startedAt
    const lines = await linesSince(from)

    expect(result.reply).toBe(TEXT)
    expect(page.samples()).toBe(2)
    expect(elapsed).toBeLessThan(800)
    const short = lines.find(line => /^reply stream: ended at -?\d+ms \(canceled\), first stable sample at -?\d+ms \(shortener\)$/.test(line))
    expect(short).toBeDefined()
    const endedAt = Number(/ended at (-?\d+)ms/.exec(short)[1])
    const stableStamp = Number(/first stable sample at (-?\d+)ms/.exec(short)[1])
    expect(stableStamp - endedAt).toBeGreaterThanOrEqual(150)
    expect(stableStamp - endedAt).toBeLessThanOrEqual(400)
    await fake.watch.stop()

    // `canceled: true` alone is enough, whatever the error text says.
    const other = await fakeWatcher()
    other.send('r1')
    other.answered('r1')
    other.failed('r1', 'net::ERR_FAILED', true)
    expect(await other.watch.completion).toMatchObject({ requestId: 'r1', end: 'canceled' })
    await other.watch.stop()
  }, 20_000)

  // (d) empty/changing sample ------------------------------------------------
  test('d1. an empty or busy sample at stream end ends the shorter path for good', async () => {
    // The stream is already over before the first read, and that first read is
    // empty. The shortener then takes its one attempt on the first real sample,
    // whose confirming read is busy: refused, and every later wait is 900.
    const page = replyPage([
      { found: false },               // 1. nothing on the page at stream end
      { text: 'alpha' },              // 2. the reference read
      { text: 'alpha', busy: true },  // 3. confirming read still busy: no
      { text: 'alpha' },              // 4. one, at the guard cadence
      { text: 'alpha' },              // 5. two
      { text: 'alpha' },              // 6. three: this is the reply
    ])
    const watch = { completion: Promise.resolve(cleanEnd(Date.now() - 50)) }
    const result = await mod.waitForReply(page, before.count, before.text, watch)

    expect(result.reply).toBe('alpha')
    expect(page.samples()).toBe(6)
    // Only the one settle is short; everything after the refusal is the guard's
    // own 900 ms, never a retried 300.
    const gaps = page.gaps()
    expect(gaps[1]).toBeGreaterThanOrEqual(150)
    expect(gaps[1]).toBeLessThan(600)
    expect(gaps.slice(2).every(gap => gap >= 800)).toBe(true)
  }, 20_000)

  test('d2. a changing confirming sample also ends the shorter path', async () => {
    const page = replyPage([
      { text: 'alpha' },        // 1. reference at stream end
      { text: 'alpha beta' },   // 2. the text changed: no evidence yet
      { text: 'alpha beta' },   // 3. one, at the guard cadence
      { text: 'alpha beta' },   // 4. two
      { text: 'alpha beta' },   // 5. three: this is the reply
    ])
    const watch = { completion: Promise.resolve(cleanEnd(Date.now() - 50)) }
    const result = await mod.waitForReply(page, before.count, before.text, watch)

    expect(result.reply).toBe('alpha beta')
    expect(page.samples()).toBe(5)
    const gaps = page.gaps()
    expect(gaps[0]).toBeGreaterThanOrEqual(150)
    expect(gaps[0]).toBeLessThan(600)
    expect(gaps.slice(1).every(gap => gap >= 800)).toBe(true)
  }, 20_000)

  // (e) superseded requestId -------------------------------------------------
  test('e. a second send POST makes the completion unattributable', async () => {
    const fake = await fakeWatcher()
    fake.send('r1')
    fake.answered('r1', 200)
    const accepted = await fake.watch.accepted
    expect(accepted?.requestId).toBe('r1')
    // A second send POST means the turn the caller is waiting for is no longer
    // the one this watcher accepted. The r1 stream-end then arrives, and it must
    // NOT be attributed: the completion resolves null.
    fake.send('r2')
    fake.finished('r1')
    expect(await fake.watch.completion).toBe(null)

    // The same verdict when the newer POST was seen BEFORE the accepted one
    // answered: here only the completion guard can catch it. A client
    // cancellation is held to the same attribution rule as a clean finish.
    const late = await fakeWatcher()
    late.send('r1')
    late.send('r2')
    late.answered('r1', 200)
    expect((await late.watch.accepted)?.requestId).toBe('r1')
    late.failed('r1', 'net::ERR_ABORTED', true)
    expect(await late.watch.completion).toBe(null)
    await late.watch.stop()

    const page = replyPage([{ text: TEXT }, { text: TEXT }, { text: TEXT }])
    const from = await mark()
    const result = await mod.waitForReply(page, before.count, before.text, fake.watch)
    const lines = await linesSince(from)
    expect(result.reply).toBe(TEXT)
    // A null completion is not a clean end: the guard's full cadence throughout.
    expect(page.gaps().every(gap => gap >= 800)).toBe(true)
    expect(page.samples()).toBe(mod.ANSWER_AGREE_SAMPLES)
    expect(lines.some(line => /^reply stream:/.test(line))).toBe(false)
    await fake.watch.stop()
  }, 20_000)

  // (f) observer lifetime across N turns on ONE child ------------------------
  test('f. N consecutive turns on one page leave no listener and no CDP session', async () => {
    const counts = { listeners: 0, sessions: 0, live: 0, detached: 0, clicks: 0, enables: 0, disables: 0 }
    let emitTurn = true
    let seq = 0
    const node = {
      isVisible: async () => true,
      isEnabled: async () => true,
      isDisabled: async () => false,
      getAttribute: async () => null,
      boundingBox: async () => ({ x: 0, y: 0, width: 1, height: 1 }),
      click: async () => { counts.clicks += 1 },
    }
    const page = {
      url: () => `https://chatgpt.com/c/${THREAD}`,
      on: (event) => { if (event === 'request') counts.listeners += 1 },
      off: (event) => { if (event === 'request') counts.listeners -= 1 },
      context: () => ({
        newCDPSession: async () => {
          counts.sessions += 1
          counts.live += 1
          const handlers = new Map()
          let detached = false
          return {
            on: (event, handler) => { handlers.set(event, handler) },
            send: async method => {
              if (method === 'Network.enable') {
                counts.enables += 1
                if (emitTurn) {
                  const requestId = `r${++seq}`
                  queueMicrotask(() => {
                    handlers.get('Network.requestWillBeSent')?.({ requestId, request: { method: 'POST', url: 'https://chatgpt.com/backend-api/conversation' } })
                    handlers.get('Network.responseReceived')?.({ requestId, response: { status: 200, url: 'https://chatgpt.com/backend-api/conversation' } })
                  })
                }
              }
              if (method === 'Network.disable') counts.disables += 1
              return {}
            },
            detach: async () => {
              if (!detached) { detached = true; counts.detached += 1; counts.live -= 1 }
              return {}
            },
          }
        },
      }),
      locator: selector => ({
        count: async () => (selector === 'button[aria-label="Send" i]' ? 1 : 0),
        nth: () => node,
      }),
      evaluate: async fn => {
        if (/stop-button/.test(String(fn))) return { stop: false, streaming: false, busy: false }
        return false
      },
    }

    // Turn 1: accepted from the response, held through a (simulated) reply.
    // Turn 2: nothing answers - the deadline throws and the turn must still clean
    // up. Turn 3: accepted again, proving the second turn left nothing behind.
    const turns = ['ok', 'throw', 'ok']
    for (const [index, kind] of turns.entries()) {
      emitTurn = kind === 'ok'
      const beforeListeners = counts.listeners
      const beforeLive = counts.live
      const startedAt = Date.now()
      if (kind === 'ok') {
        const submitted = await mod.submitTurn(page, {
          baseline: { users: 0, dom: [] }, text: `turn ${index}`, deadline: Date.now() + 4_000, holdNetwork: true,
        })
        await submitted.release()
      } else {
        let thrown = null
        try {
          await mod.submitTurn(page, {
            baseline: { users: 0, dom: [] }, text: `turn ${index}`, deadline: Date.now() + 200, holdNetwork: true,
          })
        } catch (error) { thrown = error }
        expect(thrown?.reason).toBe('ambiguous')
      }
      // After EVERY turn, not just the last: nothing accumulated.
      expect(counts.listeners).toBe(beforeListeners)
      expect(counts.live).toBe(beforeLive)
      expect(counts.detached).toBe(counts.sessions)
      expect(Date.now() - startedAt).toBeLessThan(3_500)
    }
    // Three turns, three observers, three stops - and one click each.
    expect(counts.sessions).toBe(3)
    expect(counts.detached).toBe(3)
    expect(counts.clicks).toBe(3)
    expect(counts.live).toBe(0)
    expect(counts.listeners).toBe(0)
  }, 30_000)

  // Wiring: the handoff cannot be dropped without this failing -----------------
  test('g. ask holds the observer and releases it in a finally; submitTurn hands it over', async () => {
    const src = await fs.readFile(new URL(source), 'utf8')
    expect(src).toContain('deadline = null, holdNetwork = false })')
    expect(src).toContain('if (holdNetwork) return { network, release }')
    expect(src).toContain('holdNetwork: true })')
    expect(src).toContain('const submitted = await submitTurn(page,')
    expect(src).toContain('await submitted.release().catch(() => null)')
    // The release sits in the `finally` of the block that owns the reply, so an
    // answer, a timeout, an abort and a throw all pass through it.
    const askBody = src.slice(src.indexOf('async function ask(page,'), src.indexOf('async function doLogin('))
    expect(askBody).toMatch(/\} finally \{\s*await submitted\.release\(\)/)
    const finallyAt = askBody.search(/\} finally \{\s*await submitted\.release\(\)/)
    expect(askBody.indexOf('waitForReply(page, beforeCount, beforeText, submitted?.network ?? null)')).toBeLessThan(finallyAt)
    // And the watcher's own completion is what the reply is handed, never a
    // second observer created for the reply.
    expect(mod.STREAM_SETTLE_MS).toBeGreaterThanOrEqual(150)
    expect(mod.STREAM_SETTLE_MS).toBeLessThanOrEqual(250)
    expect(mod.ANSWER_AGREE_SAMPLES).toBe(3)
  }, 15_000)
})
