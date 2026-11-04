/**
 * Independent fixture: the send stream's completion marker.
 *
 * Written from the PROTOCOL captured off the live page (four bodies in
 * `%TEMP%\cw-sseobs\turn-2026-11-01T12-07-17-577Z-{1..4}.sse`), not from any
 * implementation of it. Every row feeds a synthetic SSE body through the real
 * watcher and the real reply wait, and asserts whether the turn fires on the
 * marker and WHEN.
 *
 * WHAT THE PROTOCOL SAYS (verified against the four captures):
 *
 *   - The send POST's body is `text/event-stream`. A frame is `event:<name>`
 *     and/or `data:<json>`, terminated by a blank line. The completion frame is
 *     `event:delta` whose data is `{"v":[ ...patches... ]}` carrying BOTH
 *     `{"p":"/message/status","o":"replace","v":"finished_successfully"}` and
 *     `{"p":"/message/end_turn","o":"replace","v":true}`.
 *   - That patch appears exactly once per body, and the last content delta is
 *     always before it.
 *   - The bare string `finished_successfully` appears 6-11 times per body, so a
 *     substring test fires early and is WRONG.
 *   - `/message/end_turn` appears twice: `replace null` at answer start and
 *     `replace true` at completion. Firing on null is WRONG.
 *   - A created message carries `v` as an OBJECT with `status` and
 *     `is_complete`; a patch carries `v` as an ARRAY. The trap: an assistant
 *     message created mid-stream with empty `parts`, `status:
 *     finished_successfully`, `is_complete: true` and `stop_tokens: [200012]`
 *     (the real end uses [200002]). A predicate keyed on either field fires
 *     there and is WRONG.
 *   - `message_stream_complete` (~1.3 s after the marker), `last_token` and
 *     `[DONE]` all arrive later; none of them alone is the completion.
 *   - The body never emits `loadingFinished`: it ends as `loadingFailed`
 *     `canceled: true`, `net::ERR_ABORTED`, after `[DONE]`.
 *
 * THE SEAM the fixture drives, which is the production one:
 *
 *   startNetworkWatch(page) -> watch with `marker` (the new promise) alongside
 *   the existing `accepted`/`completion`; then waitForReply(page, 0, '', watch).
 *   The body reaches the watcher as `Network.dataReceived { requestId, data }`
 *   with `data` base64, which is what Chrome sends after
 *   `Network.streamResourceContent` on that request; the fixture answers that
 *   CDP command and streams the chunks. An implementation that reads the body
 *   another way fails these rows loudly rather than silently.
 *
 * THE DELIVERY LOG STRING IS A CONTRACT (pinned 2026-11-01, `6ed7e45`), not an
 * incidental wording - do not improve it without changing this fixture in the
 * same commit. Every marker delivery writes exactly one line beginning:
 *
 *   reply marker: /message/status finished at <N>ms (message <id>), ...
 *
 * and its tail carries `... delivered <N> chars`, where `<N>` is the length of
 * the text actually returned to the caller. Rows 1 and 9 match that line and
 * compare `<N>` against the delivered reply, so a line that names a different
 * text than the one returned is red even when both look plausible. `delivered
 * <N> chars` is also what separates a DELIVERY from a DIAGNOSTIC: the same
 * prefix is written when a marker is seen and the confirm falls back to the
 * guard, and that line carries no `delivered` tail, so it is not a delivery.
 * The rest of the line is free - only the prefix and the count are pinned.
 *
 * THE MARKER MEANS THE PAYLOAD IS COMPLETE. Every content delta precedes the
 * completion patch, so at the marker the body holds the whole answer while the
 * DOM may still be behind it (live 2026-11-01: body 253 characters, DOM 37, two
 * equal reads 70 ms apart - the answer was delivered truncated). Two equal,
 * non-empty reads are therefore NOT sufficient evidence at the marker: the
 * confirm must also see the payload's trailing text in the DOM read (how much
 * is 24 characters or 8 words depending on the rule, but some of it), or refuse
 * and hand the turn back to the guard (row 12). It must
 * refuse inside its own cap rather than wait for a tail that is not coming
 * (row 13). With no body at all there is no tail to check, and the plain
 * equality rule governs unchanged (row 14) - a body-gated delivery wedges
 * exactly there.
 *
 * THE TAIL NEEDS AN ANCHOR. The completion patch names no message, and content
 * deltas name none either, so "the payload" is not self-identifying: the body
 * also carries reasoning, tool and system messages. The captured body anchors
 * it in two frames that arrive BEFORE the first content delta: a created
 * assistant message carrying `v.message.id`, then a `message_marker` frame with
 * `marker:"user_visible_token"`, `event:"first"` and the same `message_id`. The
 * tail rule speaks only when the marker's message id matches the accumulated
 * payload's id; otherwise it is UNAVAILABLE and the old equality rule runs.
 * Rows 12 and 13 carry both frames (the real shape). Row 15 is the deliberate
 * exception: same stale-prefix shape, no anchor, and the residual risk that the
 * prefix is therefore delivered - visible in the matrix, not deleted, because
 * an implementation cannot invent an anchor the body did not send.
 *
 * TIMING BUDGETS (properties of the shape, not of any implementation): the
 * guard needs ANSWER_AGREE_SAMPLES agreeing samples GUARD_INTERVAL_MS apart, so
 * it cannot deliver under GUARD_FLOOR_MS; a marker path with a short bounded
 * confirm delivers in ~0.4-0.6 s. The marker is fed at 300 ms so a false fire
 * is unmistakable.
 *
 * COUPLING - READ BEFORE CHANGING THE GUARD CADENCE. `SHORTENED_MAX_MS` and
 * `FALLBACK_MIN_MS` are not free parameters: they encode the CURRENT guard
 * shape (a 900 ms interval, three agreeing samples, so a ~1.8 s floor). Change
 * the cadence without changing them and the two thresholds silently invert
 * meaning - rows 1/6/9 would then fail (or worse, pass) for the wrong reason.
 * ANSWER_AGREE_SAMPLES is imported from the module under test and
 * GUARD_INTERVAL_MS is the literal in `waitForReply` (it is NOT exported, so it
 * cannot be derived); the module-scope check below refuses to run if the
 * resulting floor no longer brackets these two thresholds.
 *
 * Run: `bun test ssecompletion.test.mjs`
 * Against another source copy (ALWAYS `git show <sha>:chatgpt.mjs` written to a
 * file - a worktree path is never a valid implementation under test, because an
 * uncommitted predicate can make the rows green against nothing):
 *   SSE_SRC=/tmp/x.mjs bun test ssecompletion.test.mjs
 *
 * HOME/USERPROFILE and CHATGPT_PROFILE are redirected to scratch before the
 * import, so nothing here can append to the live driver.log.
 */
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const SCRATCH = path.join(os.tmpdir(), `sse-fixture-${process.pid}`)
process.env.CHATGPT_PROFILE ||= path.join(SCRATCH, 'profile')
process.env.HOME = path.join(SCRATCH, 'home')
process.env.USERPROFILE = process.env.HOME
// The guard's own floor is ~1.8 s and the slowest fallback row here reaches
// ~3.4 s; 8 s leaves room without making a wedge invisible.
process.env.CHATGPT_TIMEOUT_MS ||= '8000'

const modulePath = process.env.SSE_SRC
  ? path.resolve(process.env.SSE_SRC)
  : path.join(import.meta.dir, 'chatgpt.mjs')
const { startNetworkWatch, waitForReply, flushLog, BASE, ANSWER_AGREE_SAMPLES } = await import(pathToFileURL(modulePath).href)
const LOG = path.join(BASE, 'driver.log')

// --- timing budgets, coupled to the guard cadence (see header) -------------
// Literal in `waitForReply` at every commit this fixture has seen; it is not
// exported, so it cannot be derived and is recorded here instead.
const GUARD_INTERVAL_MS = 900
const GUARD_FLOOR_MS = (ANSWER_AGREE_SAMPLES - 1) * GUARD_INTERVAL_MS
// The two sides of the marker-vs-guard gap. Both must sit strictly inside the
// guard floor, or the rows stop measuring the path they claim to measure.
const SHORTENED_MAX_MS = 1200
const FALLBACK_MIN_MS = 1600
if (!(SHORTENED_MAX_MS < FALLBACK_MIN_MS && FALLBACK_MIN_MS < GUARD_FLOOR_MS)) {
  throw new Error(
    `ssecompletion: timing budgets no longer bracket the guard cadence: `
    + `SHORTENED_MAX_MS=${SHORTENED_MAX_MS} FALLBACK_MIN_MS=${FALLBACK_MIN_MS} `
    + `GUARD_FLOOR_MS=${GUARD_FLOOR_MS} (ANSWER_AGREE_SAMPLES=${ANSWER_AGREE_SAMPLES} x `
    + `${GUARD_INTERVAL_MS} ms). Update the budgets with the cadence, do not lower them.`,
  )
}

const THREAD = '11111111-1111-4111-8111-111111111111'
const SEND_POST = 'https://chatgpt.com/backend-api/conversation'
// Long enough that a 97-character lag is a real prefix, not a rounding error:
// the live failure was 37 characters delivered out of 253.
const TEXT = 'Mercury boils at approximately 356.7 degrees Celsius at standard atmospheric pressure. That figure is the one every textbook quotes for the liquid metal at sea level, and it is the answer this turn gives'
const SHORT = TEXT.slice(0, TEXT.length - 97) // the paint-lag sample: 97 characters behind
const TRUNC = TEXT.slice(0, TEXT.length - 10) // a truncated final render: 10 characters short
if (TEXT.length < 150 || SHORT.length < 40) throw new Error('ssecompletion: TEXT is too short for the lag/prefix rows')

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

// --- synthetic SSE ---------------------------------------------------------

const frame = (name, data) => `${name ? `event:${name}\n` : ''}data:${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`

/** The completion patch, exactly the captured shape. */
const patch = () => frame('delta', {
  v: [
    { p: '/message/status', o: 'replace', v: 'finished_successfully' },
    { p: '/message/end_turn', o: 'replace', v: true },
    { p: '/message/metadata', o: 'append', v: { finish_details: { type: 'stop', stop_tokens: [200002] }, is_complete: true } },
  ],
})

/** A content delta: the answer text arriving. Captured shape: `v` is an ARRAY
 * of ops, exactly like the completion patch (a bare `{p,o,v}` frame is not a
 * shape this protocol emits). */
const content = text => frame('delta', { v: [{ p: '/message/content/parts/0', o: 'append', v: text }] })

/** The answer-start patch: end_turn null. Must never fire. */
const answerStart = () => frame('delta', {
  v: [
    { p: '/message/content/parts/0', o: 'append', v: SHORT },
    { p: '/message/end_turn', o: 'replace', v: null },
  ],
})

/** A created tool/system message that already says finished_successfully. */
const systemMessage = () => frame('delta', {
  v: { message: { id: 'sys-1', author: { role: 'system' }, content: { content_type: 'text', parts: [''] }, status: 'finished_successfully', end_turn: null } },
})

/** The T3 trap: a created assistant message, empty parts, already "complete". */
const trapMessage = () => frame('delta', {
  v: {
    message: {
      id: 'trap-1',
      author: { role: 'assistant' },
      content: { content_type: 'text', parts: [] },
      status: 'finished_successfully',
      end_turn: false,
      metadata: { finish_details: { type: 'stop', stop_tokens: [200012] }, is_complete: true, message_type: 'next' },
    },
  },
})

const streamComplete = () => frame(null, { type: 'message_stream_complete', conversation_id: 'c-1' })
const lastToken = () => frame(null, { type: 'message_marker', marker: 'last_token', event: 'last' })
const done = () => 'data:[DONE]\n\n'

/**
 * The answer's own id. The completion patch names no message and content deltas
 * name none either, so the tail rule can only speak about text it can attribute
 * to the answer. In the captured body two frames do that, both BEFORE the first
 * content delta: a created assistant message (`v.message.id`), then
 * `user_visible_token`/`first` announcing the same id.
 *
 * Captured order (`turn-2026-11-01T12-07-17-577Z-1.sse`, frames 9-12):
 *   delta {v:{message:{id:<answer>...}}} -> message_marker user_visible_token
 *   -> (final_channel_token) -> delta {v:[{p:'/message/content/parts/0'...}]}
 */
const ANSWER_ID = '55555555-5555-4555-8555-555555555555'
const answerCreated = () => frame('delta', {
  v: {
    message: {
      id: ANSWER_ID,
      author: { role: 'assistant', name: null, metadata: {} },
      create_time: 1793534907.05,
      update_time: null,
      content: { content_type: 'text', parts: [''] },
      status: 'in_progress',
      end_turn: false,
      weight: 1.0,
    },
  },
})
const userVisibleToken = () => frame(null, {
  type: 'message_marker',
  conversation_id: 'c-1',
  message_id: ANSWER_ID,
  marker: 'user_visible_token',
  event: 'first',
})

// --- fake CDP session ------------------------------------------------------

function makeSession(tapFails = false) {
  const handlers = new Map()
  const stats = { enables: 0, disables: 0, detaches: 0, streaming: [] }
  const buffered = new Map()
  const waiters = new Map()
  const clear = () => handlers.clear()
  const notify = requestId => {
    const waiting = waiters.get(requestId)
    if (waiting) { waiters.delete(requestId); waiting() }
  }
  return {
    stats,
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, new Set())
      handlers.get(event).add(handler)
    },
    async send(command, params) {
      if (command === 'Network.enable') stats.enables += 1
      if (command === 'Network.disable') { stats.disables += 1; clear() }
      if (command === 'Network.streamResourceContent') {
        const requestId = params?.requestId
        if (requestId && !stats.streaming.includes(requestId)) stats.streaming.push(requestId)
        notify(requestId)
        // The no-tap row: the body cannot be streamed at all (a protocol error
        // Chrome really returns for some requests). The watcher must degrade
        // to the guard, never wedge.
        if (tapFails) throw new Error('Protocol error (Network.streamResourceContent): buffered data is not available for this request')
        const data = buffered.get(requestId) ?? ''
        return data ? { bufferedData: data } : {}
      }
      return {}
    },
    async detach() { stats.detaches += 1; clear() },
    emit(event, payload) { for (const handler of handlers.get(event) ?? []) handler(payload) },
    listenerCount() { let total = 0; for (const set of handlers.values()) total += set.size; return total },
    /** Resolve once the implementation asks for this body, or after `graceMs`. */
    streamingStarted(requestId, graceMs = 600) {
      if (stats.streaming.includes(requestId)) return Promise.resolve(true)
      return new Promise(resolve => {
        waiters.set(requestId, () => resolve(true))
        setTimeout(() => resolve(false), graceMs)
      })
    },
    pushBody(requestId, text) {
      const b64 = Buffer.from(text, 'utf8').toString('base64')
      buffered.set(requestId, (buffered.get(requestId) ?? '') + b64)
      this.emit('Network.dataReceived', { requestId, data: b64, dataLength: Buffer.byteLength(text) })
    },
  }
}

// --- fake page -------------------------------------------------------------

function makePage(script) {
  const state = { samples: 0, texts: [] }
  const page = {
    url: () => `https://chatgpt.com/c/${THREAD}`,
    context: () => ({ newCDPSession: async () => script.session }),
    evaluate: async fn => {
      const source = String(fn)
      if (source.includes('candidates')) {
        const index = state.samples
        state.samples += 1
        // `script.clock.t0` is the harness's t0 (the instant `waitForReply`
        // was called), so a row can arm a DOM change at a known offset from
        // the marker without guessing when the feeder got there.
        const text = typeof script.sample === 'function' ? script.sample(index, script.clock) : String(script.sample ?? '')
        state.texts.push(text)
        return { found: true, text, state: 'complete', candidates: 1 }
      }
      if (source.includes('streaming')) return { stop: false, streaming: false, busy: false }
      if (source.includes('-4000')) return ''
      return null
    },
  }
  return { page, state }
}

// --- the run harness -------------------------------------------------------

/**
 * One turn: start the watcher, run the reply wait, feed the timeline.
 *
 * `timeline` entries are `{ at, sse?, event? }`, `at` in ms from the call to
 * `waitForReply` (which is t0). The feeder emits the request and the 2xx first,
 * waits for the implementation to ask for the body, then plays the timeline.
 * `post(result, ctx)` runs after the reply resolves, for the late-event rows.
 */
async function run({ sample, timeline = [], ids = ['r1'], accepted = 'r1', post = null, tailMs = 0, tapFails = false }) {
  await flushLog()
  await fs.writeFile(LOG, '').catch(() => {})
  const session = makeSession(tapFails)
  const clock = { t0: 0 }
  const { page, state } = makePage({ sample, session, clock })
  const watch = await startNetworkWatch(page)
  const t0 = Date.now()
  clock.t0 = t0
  const feeder = (async () => {
    for (const id of ids) {
      session.emit('Network.requestWillBeSent', { requestId: id, request: { method: 'POST', url: SEND_POST } })
    }
    session.emit('Network.responseReceived', { requestId: accepted, response: { status: 200, url: SEND_POST } })
    await session.streamingStarted(accepted)
    for (const step of timeline) {
      const wait = step.at - (Date.now() - t0)
      if (wait > 0) await delay(wait)
      // `sseOn` pushes the frame on a DIFFERENT request than the accepted one
      // (the supersession row); the default is the accepted body.
      if (step.sse !== undefined) session.pushBody(step.sseOn ?? accepted, step.sse)
      if (step.event) session.emit(step.event, step.params)
    }
  })().catch(() => {})
  let result = null
  let error = null
  try {
    result = await waitForReply(page, 0, '', watch)
  } catch (caught) {
    error = caught
  }
  const elapsed = Date.now() - t0
  const samplesAtReturn = state.samples
  const ctx = { session, state, t0, watch, samplesAtReturn }
  if (post) await post(result, ctx, elapsed).catch(() => {})
  if (tailMs) await delay(tailMs)
  const samplesAtEnd = state.samples
  await feeder
  await watch.stop().catch(() => {})
  // `log` only queues; without the drain the last lines (including any marker
  // line) can be missing from this read, which would make every "no marker
  // line" assertion pass for the wrong reason.
  await flushLog()
  const lines = (await fs.readFile(LOG, 'utf8').catch(() => '')).split('\n').filter(Boolean)
  return { result, error, elapsed, samplesAtReturn, samplesAtEnd, lines, state, watch }
}

const replyOf = outcome => outcome.result?.reply ?? null
const shortened = outcome => outcome.elapsed <= SHORTENED_MAX_MS
const fallbackSlow = outcome => outcome.elapsed >= FALLBACK_MIN_MS
// The delivery log string is a CONTRACT, not a guess (see header): every marker
// DELIVERY writes one line beginning `reply marker:` and ending its body with
// `delivered <N> chars`, the length of the text actually returned. The prefix
// alone is NOT a delivery - implementations also log diagnostics under it
// (`... confirm did not settle ... falling back to the guard`), and counting
// those as delivered would make the fallback row red for the wrong reason.
const markerLine = outcome => outcome.lines.find(
  line => /reply marker:/i.test(line) && /delivered \d+ chars/.test(line),
) ?? null
const markerChars = line => {
  const match = /delivered (\d+) chars/.exec(line ?? '')
  return match ? Number(match[1]) : null
}

describe('SSE completion marker', () => {
  // 1 -----------------------------------------------------------------------
  test('1. happy path: fires once at the patch, never later', async () => {
    const one = await run({
      sample: () => TEXT,
      timeline: [
        { at: 40, sse: content('Mercury boils at approximately 356.7') },
        { at: 300, sse: patch() },
        // Deliberately OUTSIDE the delivery window: an implementation that
        // waits for message_stream_complete or [DONE] delivers at ~1520 and
        // fails `firedAtPatch`, instead of landing just inside it.
        { at: 1500, sse: streamComplete() },
        { at: 1800, sse: done() },
        { at: 2400, event: 'Network.loadingFailed', params: { requestId: 'r1', canceled: true, errorText: 'net::ERR_ABORTED' } },
      ],
      tailMs: 400,
    })
    const line = markerLine(one)
    console.log(`[row 1] elapsed=${one.elapsed}ms samples=${one.samplesAtReturn} reply=${JSON.stringify(replyOf(one))} line=${line ? 'yes' : 'no'} chars=${markerChars(line)}`)
    expect({
      reply: replyOf(one),
      shortened: shortened(one),
      firedAtPatch: one.elapsed >= 250 && one.elapsed <= SHORTENED_MAX_MS,
      // "never later": no read may happen after the reply resolved
      noReadsAfterDelivery: one.samplesAtEnd === one.samplesAtReturn,
      markerLogged: Boolean(line),
      // The stamp must describe the text that was actually returned, and that
      // text must be the expected one - the two are separate claims.
      charsLogged: markerChars(line),
      charsMatchDelivered: markerChars(line) === (replyOf(one) ?? '').length,
    }).toEqual({
      reply: TEXT,
      shortened: true,
      firedAtPatch: true,
      noReadsAfterDelivery: true,
      markerLogged: true,
      charsLogged: TEXT.length,
      charsMatchDelivered: true,
    })
  }, 30_000)

  // 2 -----------------------------------------------------------------------
  test('2. a created tool/system message saying finished_successfully does not fire', async () => {
    const one = await run({
      sample: () => TEXT,
      timeline: [{ at: 100, sse: systemMessage() }, { at: 300, sse: content(SHORT) }],
    })
    console.log(`[row 2] elapsed=${one.elapsed}ms samples=${one.samplesAtReturn} markerLine=${markerLine(one) ? 'yes' : 'no'}`)
    expect({
      reply: replyOf(one),
      fallbackSlow: fallbackSlow(one),
      threeSamples: one.samplesAtReturn >= 3,
      noMarkerLine: markerLine(one) === null,
    }).toEqual({
      reply: TEXT,
      fallbackSlow: true,
      threeSamples: true,
      noMarkerLine: true,
    })
  }, 30_000)

  // 3 -----------------------------------------------------------------------
  test('3. the T3 trap: a created assistant message with is_complete does not fire', async () => {
    const one = await run({
      sample: () => TEXT,
      timeline: [{ at: 200, sse: trapMessage() }, { at: 400, sse: content(SHORT) }],
    })
    console.log(`[row 3] elapsed=${one.elapsed}ms samples=${one.samplesAtReturn} markerLine=${markerLine(one) ? 'yes' : 'no'}`)
    expect({
      reply: replyOf(one),
      fallbackSlow: fallbackSlow(one),
      threeSamples: one.samplesAtReturn >= 3,
      noMarkerLine: markerLine(one) === null,
    }).toEqual({
      reply: TEXT,
      fallbackSlow: true,
      threeSamples: true,
      noMarkerLine: true,
    })
  }, 30_000)

  // 4 -----------------------------------------------------------------------
  test('4. message_stream_complete and [DONE] without the patch do not fire', async () => {
    const one = await run({
      sample: () => TEXT,
      timeline: [
        { at: 200, sse: content(TEXT) },
        { at: 300, sse: streamComplete() },
        { at: 340, sse: lastToken() },
        { at: 400, sse: done() },
      ],
    })
    console.log(`[row 4] elapsed=${one.elapsed}ms samples=${one.samplesAtReturn} markerLine=${markerLine(one) ? 'yes' : 'no'}`)
    expect({
      reply: replyOf(one),
      fallbackSlow: fallbackSlow(one),
      noMarkerLine: markerLine(one) === null,
    }).toEqual({
      reply: TEXT,
      fallbackSlow: true,
      noMarkerLine: true,
    })
  }, 30_000)

  // 5 -----------------------------------------------------------------------
  test('5. end_turn replace null at answer start does not fire', async () => {
    const one = await run({
      sample: () => TEXT,
      timeline: [{ at: 200, sse: answerStart() }],
    })
    console.log(`[row 5] elapsed=${one.elapsed}ms samples=${one.samplesAtReturn} markerLine=${markerLine(one) ? 'yes' : 'no'}`)
    expect({
      reply: replyOf(one),
      fallbackSlow: fallbackSlow(one),
      noMarkerLine: markerLine(one) === null,
    }).toEqual({
      reply: TEXT,
      fallbackSlow: true,
      noMarkerLine: true,
    })
  }, 30_000)

  // 6 -----------------------------------------------------------------------
  test('6. a duplicated patch is one delivery', async () => {
    const one = await run({
      sample: () => TEXT,
      timeline: [{ at: 300, sse: patch() }, { at: 340, sse: patch() }],
      tailMs: 500,
    })
    console.log(`[row 6] elapsed=${one.elapsed}ms samples=${one.samplesAtReturn} after=${one.samplesAtEnd}`)
    expect({
      reply: replyOf(one),
      shortened: shortened(one),
      noReadsAfterDelivery: one.samplesAtEnd === one.samplesAtReturn,
    }).toEqual({
      reply: TEXT,
      shortened: true,
      noReadsAfterDelivery: true,
    })
  }, 30_000)

  // 7 -----------------------------------------------------------------------
  test('7. a patch on a superseded requestId is ignored', async () => {
    const one = await run({
      sample: () => TEXT,
      ids: ['r1', 'r2'],
      accepted: 'r2',
      timeline: [{ at: 300, sse: patch(), sseOn: 'r1' }],
    })
    console.log(`[row 7] elapsed=${one.elapsed}ms samples=${one.samplesAtReturn} markerLine=${markerLine(one) ? 'yes' : 'no'}`)
    expect({
      reply: replyOf(one),
      fallbackSlow: fallbackSlow(one),
      noMarkerLine: markerLine(one) === null,
    }).toEqual({
      reply: TEXT,
      fallbackSlow: true,
      noMarkerLine: true,
    })
  }, 30_000)

  // 8 -----------------------------------------------------------------------
  test('8. a patch after the guard delivered is a no-op', async () => {
    // No marker at all: the guard owns the turn and delivers at its cadence.
    // The patch then lands on a turn that is already answered.
    const one = await run({
      sample: () => TEXT,
      timeline: [],
      post: async (_result, ctx, elapsed) => {
        ctx.session.pushBody('r1', patch())
        await delay(600)
      },
    })
    console.log(`[row 8] elapsed=${one.elapsed}ms samplesAtReturn=${one.samplesAtReturn} samplesAtEnd=${one.samplesAtEnd}`)
    expect({
      reply: replyOf(one),
      deliveredByGuard: fallbackSlow(one),
      noSecondDelivery: one.samplesAtEnd === one.samplesAtReturn,
      noError: one.error === null,
    }).toEqual({
      reply: TEXT,
      deliveredByGuard: true,
      noSecondDelivery: true,
      noError: true,
    })
  }, 30_000)

  // 9 -----------------------------------------------------------------------
  test('9. paint lag at the marker: the delivered text is the full text', async () => {
    // The paint lands 112 ms after the marker frame (captured lag: the last
    // content delta's characters reach the DOM a render behind the transport).
    const PAINT_AT = 300 + 112
    const one = await run({
      sample: (_index, clock) => (Date.now() - clock.t0 >= PAINT_AT ? TEXT : SHORT),
      // The body already carries the whole answer: this is the live shape -
      // transport complete, DOM a render behind. The tail check must not refuse
      // a DOM that catches up inside the confirm cap.
      timeline: [{ at: 40, sse: content(TEXT) }, { at: 300, sse: patch() }],
    })
    console.log(`[row 9] elapsed=${one.elapsed}ms delivered=${(replyOf(one) ?? '').length} of ${TEXT.length} markerLine=${markerLine(one) ? 'yes' : 'no'}`)
    expect({
      delivered: replyOf(one),
      // The marker path must be the one that delivered, or the guard's slow
      // path would satisfy this row with the same text.
      shortened: shortened(one),
      markerLogged: Boolean(markerLine(one)),
      charsLogged: markerChars(markerLine(one)),
      charsMatchDelivered: markerChars(markerLine(one)) === (replyOf(one) ?? '').length,
    }).toEqual({
      delivered: TEXT,
      shortened: true,
      markerLogged: true,
      charsLogged: TEXT.length,
      charsMatchDelivered: true,
    })
  }, 30_000)

  // 10 ----------------------------------------------------------------------
  test('10. a confirm that cannot settle inside the cap falls through to the guard', async () => {
    // The DOM keeps moving for 600 ms after the marker (300 + 600 = 900 ms),
    // which is longer than any short confirm cap, then settles. A deliver-on-
    // cap implementation returns a moving text here.
    const SETTLE_AT = 300 + 600
    let counter = 0
    const one = await run({
      sample: (_index, clock) => {
        if (Date.now() - clock.t0 < SETTLE_AT) { counter += 1; return `${TEXT} v${counter}` }
        return TEXT
      },
      timeline: [{ at: 300, sse: patch() }],
    })
    console.log(`[row 10] elapsed=${one.elapsed}ms samples=${one.samplesAtReturn} reply=${JSON.stringify(replyOf(one))} markerLine=${markerLine(one) ? 'yes' : 'no'}`)
    expect({
      reply: replyOf(one),
      fellThrough: fallbackSlow(one),
      deliveredByGuard: markerLine(one) === null,
    }).toEqual({
      reply: TEXT,
      fellThrough: true,
      deliveredByGuard: true,
    })
  }, 30_000)

  // 11 ----------------------------------------------------------------------
  test('11. (open) a content delta after the patch: recorder, not a verdict', async () => {
    const edited = `${TEXT} EDIT`
    // The DOM gains the trailing delta 200 ms after the marker, i.e. outside a
    // 120 ms confirm pair but inside the 400 ms cap (an implementation that
    // pairs further apart may or may not catch it - that is the open input).
    const EDIT_AT = 300 + 200
    const one = await run({
      sample: (_index, clock) => (Date.now() - clock.t0 >= EDIT_AT ? edited : TEXT),
      timeline: [
        { at: 300, sse: patch() },
        { at: EDIT_AT, sse: content(' EDIT') },
      ],
    })
    const delivered = replyOf(one) ?? ''
    const which = delivered === edited ? 'final-after-edit' : delivered === TEXT ? 'pre-edit' : 'other'
    console.log(`[row 11] elapsed=${one.elapsed}ms outcome=${which} markerLine=${markerLine(one) ? 'yes' : 'no'} delivered=${JSON.stringify(delivered.slice(-24))}`)
    // The ruling on this row is not made. What is asserted is only that the
    // behaviour is one of the two well-defined outcomes and that the delivered
    // text is never corrupted or truncated mid-code-point. NOTE: this row does
    // NOT discriminate the marker path - a guard-only implementation lands on
    // `pre-edit` too - it records which of two legal outcomes the path has.
    expect({
      wellDefined: which === 'final-after-edit' || which === 'pre-edit',
      prefix: edited.startsWith(delivered),
    }).toEqual({
      wellDefined: true,
      prefix: true,
    })
  }, 30_000)

  // 12 ----------------------------------------------------------------------
  test('12. a stable prefix is not a finished answer: no delivery on it', async () => {
    // The live failure of 2026-11-01: the body carried the whole answer, the
    // DOM sat on a 97-character-behind prefix and did not move. Two equal,
    // non-empty reads are satisfied there, so an equality-only confirm delivers
    // the prefix. The payload tail is not in that DOM, so a confirm that checks
    // it refuses, and the turn goes back to the guard until the full text lands.
    const PAINT_AT = 1200
    const one = await run({
      sample: (_index, clock) => (Date.now() - clock.t0 >= PAINT_AT ? TEXT : SHORT),
      timeline: [
        // The captured body order (see `answerCreated`): the answer is
        // attributed first, then the text arrives, then the patch. Without the
        // anchor the tail rule is unavailable and the row would fall through
        // for the wrong reason - that case is row 15, deliberately.
        { at: 20, sse: answerCreated() },
        { at: 20, sse: userVisibleToken() },
        { at: 40, sse: content(TEXT) },
        { at: 300, sse: patch() },
      ],
    })
    console.log(`[row 12] elapsed=${one.elapsed}ms samples=${one.samplesAtReturn} delivered=${(replyOf(one) ?? '').length} of ${TEXT.length} markerLine=${markerLine(one) ? 'yes' : 'no'}`)
    expect({
      reply: replyOf(one),
      deliveredFullText: replyOf(one) === TEXT,
      fellThroughToGuard: fallbackSlow(one),
      noMarkerDelivery: markerLine(one) === null,
    }).toEqual({
      reply: TEXT,
      deliveredFullText: true,
      fellThroughToGuard: true,
      noMarkerDelivery: true,
    })
  }, 30_000)

  // 13 ----------------------------------------------------------------------
  test('13. a suffix that never closes: fall back inside the cap, do not hang', async () => {
    // The DOM never grows past a truncated render, so the payload tail is never
    // present. The confirm must give up inside its cap and hand the turn to the
    // guard (which will deliver what the page actually shows), rather than
    // waiting forever for a tail that is not coming.
    const one = await run({
      sample: () => TRUNC,
      timeline: [
        // Attributed like row 12, so the tail rule is REACHED and then has to
        // refuse: the point of this row is the bounded refusal, not an
        // unattributable payload.
        { at: 20, sse: answerCreated() },
        { at: 20, sse: userVisibleToken() },
        { at: 40, sse: content(TEXT) },
        { at: 300, sse: patch() },
      ],
    })
    console.log(`[row 13] elapsed=${one.elapsed}ms samples=${one.samplesAtReturn} delivered=${(replyOf(one) ?? '').length} of ${TEXT.length} markerLine=${markerLine(one) ? 'yes' : 'no'}`)
    expect({
      reply: replyOf(one),
      // The guard's answer is what the page shows; the row is that the MARKER
      // path did not deliver it early and did not wedge. The lower bound is
      // "later than any marker delivery", not the 3-sample floor: the refused
      // confirm runs inside what would have been the guard's first interval, so
      // a correct turn lands just above the shortened window (~1.6 s here).
      notDeliveredEarly: one.elapsed > SHORTENED_MAX_MS,
      noMarkerDelivery: markerLine(one) === null,
      deliveredSomething: typeof replyOf(one) === 'string' && replyOf(one).length > 0,
      noError: one.error === null,
    }).toEqual({
      reply: TRUNC,
      notDeliveredEarly: true,
      noMarkerDelivery: true,
      deliveredSomething: true,
      noError: true,
    })
  }, 30_000)

  // 14 ----------------------------------------------------------------------
  test('14. no tap / no body: the old equality rule governs unchanged', async () => {
    // `Network.streamResourceContent` fails, so no body ever arrives: no
    // payload, no marker, no tail to check. The turn must still finish on the
    // guard's plain rule - a body-gated delivery would wedge here forever.
    const one = await run({
      sample: () => TEXT,
      timeline: [],
      tapFails: true,
    })
    console.log(`[row 14] elapsed=${one.elapsed}ms samples=${one.samplesAtReturn} reply=${JSON.stringify((replyOf(one) ?? '').slice(0, 24))} markerLine=${markerLine(one) ? 'yes' : 'no'}`)
    expect({
      reply: replyOf(one),
      finishedOnGuard: fallbackSlow(one),
      noMarkerDelivery: markerLine(one) === null,
      noError: one.error === null,
    }).toEqual({
      reply: TEXT,
      finishedOnGuard: true,
      noMarkerDelivery: true,
      noError: true,
    })
  }, 30_000)

  // 15 ----------------------------------------------------------------------
  test('15. an unattributed payload: the old equality rule runs, prefix delivered', async () => {
    // The RESIDUAL RISK, recorded rather than fixed. Exactly row 12's shape -
    // stable prefix in the DOM, whole answer in the body - but the body never
    // names the answer message (`answerCreated` / `userVisibleToken` are
    // absent), so the tail rule has no anchor and is UNAVAILABLE. The equality
    // rule is then what it always was: two equal, non-empty reads deliver, and
    // the stale prefix goes out. An implementation cannot invent the anchor the
    // body did not send, so this row is GREEN on a correct implementation and
    // must stay that way - it is the measured cost of an unattributed body, not
    // a bug. It goes red only under a mode that refuses to confirm without
    // attribution (`noattrib`), which is the wrong trade: it would wedge every
    // turn whose body omitted the frame.
    const PAINT_AT = 1200
    const one = await run({
      sample: (_index, clock) => (Date.now() - clock.t0 >= PAINT_AT ? TEXT : SHORT),
      timeline: [
        { at: 40, sse: content(TEXT) },
        { at: 300, sse: patch() },
      ],
    })
    const line = markerLine(one)
    console.log(`[row 15] elapsed=${one.elapsed}ms delivered=${(replyOf(one) ?? '').length} of ${TEXT.length} reply=${JSON.stringify((replyOf(one) ?? '').slice(0, 12))} markerLine=${line ? 'yes' : 'no'}`)
    expect({
      reply: replyOf(one),
      // The old rule ran: the marker path delivered, it delivered the stable
      // prefix rather than the whole body, and it did so inside the shortened
      // window.
      deliveredTheStalePrefix: replyOf(one) === SHORT,
      notTheFullBody: replyOf(one) !== TEXT,
      markerPathDelivered: line !== null,
      shortened: shortened(one),
      charsLogged: markerChars(line),
      charsMatchDelivered: markerChars(line) === (replyOf(one) ?? '').length,
    }).toEqual({
      reply: SHORT,
      deliveredTheStalePrefix: true,
      notTheFullBody: true,
      markerPathDelivered: true,
      shortened: true,
      charsLogged: SHORT.length,
      charsMatchDelivered: true,
    })
  }, 30_000)
})
