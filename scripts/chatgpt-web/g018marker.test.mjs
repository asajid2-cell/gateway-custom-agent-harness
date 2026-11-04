/**
 * G-018 independent fixture: deliver when the SOURCE says the turn is over.
 *
 * Three blocks, no Chrome and no live host:
 *
 *   A. the frame parser - the predicate, the false positives that must not
 *      fire (a message CREATED finished, `is_complete`, the empty-shell trap),
 *      CRLF, and a frame split across chunks;
 *   B. `waitForReply` with a marker - the bounded confirm, the DOM lagging the
 *      source, a cap that falls first, and a marker that arrives too late;
 *   C. the tap on a fake CDP session - the retry, the scoping to the accepted
 *      requestId, supersession, stop, and the command trace (no Fetch, no
 *      pausing).
 *
 * Run: `bun test g018marker.test.mjs`
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, expect } from 'bun:test'

const SCRATCH = await fs.mkdtemp(path.join(os.tmpdir(), 'g018marker-'))
process.env.CHATGPT_PROFILE ||= path.join(SCRATCH, 'profile')
process.env.HOME = path.join(SCRATCH, 'home')
process.env.USERPROFILE = process.env.HOME
process.env.CHATGPT_TIMEOUT_MS ||= '10000'

const mod = await import(pathToFileURL(path.join(import.meta.dir, 'chatgpt.mjs')).href)
const { waitForReply, startNetworkWatch, parseTurnMarker, parseMessageMarker, parseContentDelta, createSseFrames, frameMessageId, normalizeAnswerText, tailSuffix, flushLog, BASE } = mod
const LOG = path.join(BASE, 'driver.log')

const TEXT = 'count the peers on the bus'
const URL_NOW = 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111'
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const b64 = text => Buffer.from(String(text), 'utf8').toString('base64')

// ---------------------------------------------------------------- A: parser

const PATCH = 'event: delta\ndata: {"v":[{"p":"/message/status","o":"replace","v":"finished_successfully"},{"p":"/message/end_turn","o":"replace","v":true}]}\n\n'
const DATA_PATCH = '{"v":[{"p":"/message/status","o":"replace","v":"finished_successfully"},{"p":"/message/end_turn","o":"replace","v":true}]}'

test('a1. the status+end_turn patch is a marker', () => {
  expect(parseTurnMarker('delta', DATA_PATCH)).toEqual({ status: 'finished_successfully', endTurn: true })
})

test('a2. status alone, end_turn alone, and a non-delta event are not markers', () => {
  expect(parseTurnMarker('delta', '{"v":[{"p":"/message/status","o":"replace","v":"finished_successfully"}]}')).toBeNull()
  expect(parseTurnMarker('delta', '{"v":[{"p":"/message/end_turn","o":"replace","v":true}]}')).toBeNull()
  expect(parseTurnMarker('message', DATA_PATCH)).toBeNull()
})

test('a3. the false positives stay false: created-finished, is_complete, empty shell', () => {
  // A message that is CREATED already finished: same word, no patch.
  expect(parseTurnMarker('', '{"type":"message_created","message":{"status":"finished_successfully","content":{"parts":[]}}}')).toBeNull()
  // Completion-looking flags with no patch on this turn's message.
  expect(parseTurnMarker('delta', '{"v":[{"p":"/message/metadata","o":"append","v":{"is_complete":true,"finish_details":{"type":"stop","stop_tokens":[200012]}}}]}')).toBeNull()
  // The T3 trap: an empty assistant shell that announces is_complete.
  expect(parseTurnMarker('', '{"type":"message","message":{"status":"finished_successfully","content":{"parts":[]},"metadata":{"is_complete":true}}}')).toBeNull()
})

test('a4. last_token corroboration is parsed but is not a predicate', () => {
  const named = parseMessageMarker('', '{"type":"message_marker","message_id":"m-answer","marker":"last_token","event":"last"}')
  expect(named).toEqual({ messageId: 'm-answer', marker: 'last_token', event: 'last' })
  expect(parseTurnMarker('', '{"type":"message_marker","message_id":"m-answer","marker":"last_token","event":"last"}')).toBeNull()
})

test('a4b. content deltas are counted, the patch frame is not a content delta', () => {
  expect(parseContentDelta('delta', '{"v":[{"p":"/message/content/parts/0","o":"append","v":"Hello"}]}')).toBe(5)
  expect(parseContentDelta('delta', '{"v":[{"p":"/message/content/parts/1","o":"append","v":"ab"}]}')).toBe(2)
  expect(parseContentDelta('delta', DATA_PATCH)).toBeNull()
  expect(parseContentDelta('', '{"type":"message_marker","marker":"last_token"}')).toBeNull()
})

test('a4c. all three live frame shapes yield content ops; the single-op shape is not lost', () => {
  // The three shapes the page actually writes (2026-11-01): array of ops, one
  // patch op carrying the ops in v, and a bare op.
  expect(parseContentDelta('delta', '{"v":[{"p":"/message/content/parts/0","o":"append","v":"abc"}]}')).toBe(3)
  expect(parseContentDelta('delta', '{"p":"","o":"patch","v":[{"p":"/message/content/parts/0","o":"append","v":"de"}]}')).toBe(2)
  expect(parseContentDelta('delta', '{"p":"/message/content/parts/0","o":"append","v":"fgh"}')).toBe(3)
  expect(parseContentDelta('delta', '{"p":"/message/content/parts/0","o":"replace","v":"z"}')).toBe(1)
  expect(parseContentDelta('delta', '{"type":"message_marker","message_id":"m"}')).toBeNull()
})

test('a4d. frameMessageId names message-bearing frames and nothing else', () => {
  expect(frameMessageId('', '{"type":"message_created","message":{"id":"m-created"}}')).toBe('m-created')
  expect(frameMessageId('delta', '{"v":{"message":{"id":"m-answer"}}}')).toBe('m-answer')
  expect(frameMessageId('delta', '{"v":[{"p":"","o":"add","v":{"message":{"id":"m-added"}}}]}')).toBe('m-added')
  expect(frameMessageId('delta', '{"p":"/message/content/parts/0","o":"append","v":"x"}')).toBeNull()
  expect(frameMessageId('delta', '{"v":[{"p":"/message/content/parts/0","o":"append","v":"x"}]}')).toBeNull()
})

test('a4e. the normalizer compares prose, tables and code without markdown', () => {
  // Cite tags and emphasis go; the prose words stay in order.
  expect(normalizeAnswerText('The **Verge** report <Cite ref="turn1" /> \n\ntheverge.com'))
    .toBe('The Verge report theverge.com')
  // A table's payload pipes/rule survive innerText as tabs, so both sides
  // collapse to one space-separated word run.
  const payloadTable = '| Python | Go |\n|---|---|\n| Dynamically typed | Statically typed |'
  const domTable = 'Python\tGo\nDynamically typed\tStatically typed'
  expect(normalizeAnswerText(payloadTable)).toBe(normalizeAnswerText(domTable))
  // A code-ending answer: the suffix is the code block alone, so the page's own
  // "Python / Run" header between the prose and the code cannot break it.
  const payloadCode = 'Python function (5 lines):\n\n```python\ndef reverse_list(items):\n    return items\n```'
  expect(tailSuffix(payloadCode)).toBe('def reverse list(items): return items')
  expect(normalizeAnswerText('Python function (5 lines):\n\nPython\nRun\ndef reverse_list(items):\n    return items')
    .includes(tailSuffix(payloadCode))).toBe(true)
})

test('a4f. the suffix is whole words from the last block, closes on the rendered text, and is unavailable when too short', () => {
  const payload = '... the enormous cost of development. South China Morning Post report <Cite ref="t1"/> scmp.com'
  const dom = normalizeAnswerText('... the enormous cost of development. South China Morning Post report scmp.com')
  expect(tailSuffix(payload)).toBe('of development. South China Morning Post report scmp.com')
  expect(dom.includes(tailSuffix(payload))).toBe(true)
  // A stable prefix of the answer does not contain the tail.
  expect(normalizeAnswerText('the answer begins here').includes(tailSuffix(payload))).toBe(false)
  // Fewer than TAIL_MIN_WORDS makes no claim rather than a weak one.
  expect(tailSuffix('two words')).toBeNull()
  expect(tailSuffix('')).toBeNull()
  // A one-word last block (a bare URL) is extended with the paragraph before it,
  // which the DOM renders contiguously.
  expect(tailSuffix('The report is here today.\n\nreuters.com')).toBe('The report is here today. reuters.com')
})

test('a5. CRLF frames, split frames and multi-line data', () => {
  const seen = []
  const reader = createSseFrames((name, data, at) => seen.push({ name, data, at }))
  const crlf = PATCH.replace(/\n/g, '\r\n')
  reader.push(b64(crlf.slice(0, 30)), 1)
  reader.push(b64(crlf.slice(30)), 2)
  reader.push(b64('event: delta\ndata: line-one\ndata: line-two\n\n'), 3)
  expect(seen.length).toBe(2)
  expect(parseTurnMarker(seen[0].name, seen[0].data)).toEqual({ status: 'finished_successfully', endTurn: true })
  expect(seen[0].at).toBe(2)
  expect(seen[1]).toEqual({ name: 'delta', data: 'line-one\nline-two', at: 3 })
})

// ------------------------------------------------------- B: bounded confirm

function samplePage(script) {
  const calls = []
  let index = 0
  return {
    calls,
    url: () => URL_NOW,
    evaluate: async fn => {
      const source = String(fn)
      if (/querySelectorAll\(selector\)/.test(source)) {
        const at = Date.now()
        const step = script(index, at) ?? { text: TEXT }
        index += 1
        calls.push({ at, text: step.text })
        return step.found === false
          ? { found: false, text: '', state: null, candidates: 1 }
          : { found: true, text: step.text, state: 'complete', candidates: 1 }
      }
      if (/stop-button/.test(source)) return { stop: false, streaming: false, busy: false }
      if (/-4000/.test(source)) return ''
      throw new Error(`fixture: unrecognised page.evaluate (${source.slice(0, 60)})`)
    },
  }
}

const markerAt = (ms, extra = {}) => new Promise(resolve => {
  setTimeout(() => resolve({ at: Date.now(), requestId: 'r1', messageId: 'm-answer', lastTokenAt: Date.now(), ...extra }), ms)
})

async function runWait(script, watch) {
  const page = samplePage(script)
  const started = Date.now()
  const result = await waitForReply(page, 0, '', watch)
  const elapsed = Date.now() - started
  await flushLog()
  const log = await fs.readFile(LOG, 'utf8').catch(() => '')
  await fs.writeFile(LOG, '').catch(() => {})
  return { result, elapsed, log, samples: page.calls.length }
}

test('b0. no marker: the guard is exactly the 3 x 900 ms path', async () => {
  const quiet = await runWait(() => ({ text: TEXT }), null)
  expect(quiet.result.reply).toBe(TEXT)
  expect(quiet.elapsed).toBeGreaterThanOrEqual(1600)
  expect(quiet.log).not.toContain('reply marker:')
}, 20_000)

test('b1. marker with the text already final delivers inside the window', async () => {
  const one = await runWait(() => ({ text: TEXT }), { marker: markerAt(30) })
  expect(one.result.reply).toBe(TEXT)
  expect(one.elapsed).toBeLessThan(900)
  expect(one.log).toContain('reply marker: /message/status finished at')
  expect(one.log).toContain('confirm settled at')
  expect(one.log).toContain('delivered 26 chars')
}, 20_000)

test('b2. the DOM lagging the source (T2: short, then final 120 ms later) is waited for, not delivered', async () => {
  const short = TEXT.slice(0, 8)
  const started = Date.now()
  const one = await runWait((index, at) => ({ text: at - started < 150 ? short : TEXT }), { marker: markerAt(20) })
  // The short text must never be the reply, and the wait must stay bounded.
  expect(one.result.reply).toBe(TEXT)
  expect(one.elapsed).toBeLessThan(1000)
  expect(one.log).toContain('reply marker:')
}, 20_000)

test('b3. a cap that falls first falls through to the guard, never delivers partial text', async () => {
  // Text changes on every sample for 900 ms: no two consecutive samples equal
  // while the confirm window is open.
  const started = Date.now()
  const one = await runWait((index, at) => ({ text: at - started < 900 ? `${TEXT} ${index}` : TEXT }), { marker: markerAt(20) })
  expect(one.result.reply).toBe(TEXT)
  expect(one.elapsed).toBeGreaterThanOrEqual(1200)
  expect(one.log).toContain('confirm did not settle within 400ms')
  expect(one.log).toContain('falling back to the guard')
}, 20_000)

test('b4. a null marker (tap failed or superseded) leaves the guard unchanged', async () => {
  const one = await runWait(() => ({ text: TEXT }), { marker: Promise.resolve(null) })
  expect(one.result.reply).toBe(TEXT)
  expect(one.elapsed).toBeGreaterThanOrEqual(1600)
  expect(one.log).not.toContain('reply marker:')
}, 20_000)

test('b5. a marker that arrives after the guard already delivered is a no-op', async () => {
  const one = await runWait(() => ({ text: TEXT }), { marker: markerAt(3000) })
  expect(one.result.reply).toBe(TEXT)
  expect(one.elapsed).toBeLessThan(2700)
  expect(one.log).not.toContain('reply marker:')
}, 20_000)

test('b6. an empty page at the marker waits for text, then delivers once it is stable', async () => {
  const started = Date.now()
  const one = await runWait((index, at) => ({ text: at - started < 120 ? '' : TEXT }), { marker: markerAt(20) })
  expect(one.result.reply).toBe(TEXT)
  expect(one.elapsed).toBeLessThan(1000)
}, 20_000)

// ------------------------------------------- B2: the payload tail check

const payloadFull = 'A moving bicycle stays upright mainly because the rider steers to keep the wheels beneath its center of gravity.'
const payloadPrefix = payloadFull.slice(0, 37)
const answerText = (text, id = 'm-answer') => () => ({ id, text, at: Date.now() })

test('b7. a stable DOM prefix with the payload complete is waited for, not delivered', async () => {
  // The live defect, pinned: the payload holds the whole answer, the DOM shows a
  // clean 37-char prefix for 300 ms. Equality alone would deliver the prefix;
  // the tail check must hold the turn until the paint lands.
  const started = Date.now()
  const one = await runWait(
    (index, at) => ({ text: at - started < 300 ? payloadPrefix : payloadFull }),
    { marker: markerAt(20), answerText: answerText(payloadFull) },
  )
  expect(one.result.reply).toBe(payloadFull)
  expect(one.result.reply).not.toBe(payloadPrefix)
  expect(one.elapsed).toBeLessThan(900)
  expect(one.log).toContain('delivered')
  expect(one.log).toContain(`${payloadFull.length} chars`)
}, 20_000)

test('b8. a strict prefix that never closes falls through to the guard and names the tail', async () => {
  const started = Date.now()
  const one = await runWait(
    (index, at) => ({ text: at - started < 700 ? payloadPrefix : payloadFull }),
    { marker: markerAt(20), answerText: answerText(payloadFull) },
  )
  expect(one.result.reply).toBe(payloadFull)
  expect(one.elapsed).toBeGreaterThanOrEqual(1200)
  expect(one.log).toContain('+tail-miss')
  expect(one.log).toContain('falling back to the guard')
}, 20_000)

test('b9. a buffer that cannot be attributed is unavailable, not wrong', async () => {
  // Same shape as b7, but the tap's buffer belongs to another message id: the
  // tail check makes no claim and the shipped equality rule delivers as before.
  const started = Date.now()
  const one = await runWait(
    (index, at) => ({ text: at - started < 300 ? payloadPrefix : payloadFull }),
    { marker: markerAt(20), answerText: answerText(payloadFull, 'm-thinking') },
  )
  expect(one.result.reply).toBe(payloadPrefix)
  expect(one.elapsed).toBeLessThan(900)
}, 20_000)

test('b10. a payload too short to claim a tail is unavailable', async () => {
  const short = 'Only words'
  const one = await runWait(() => ({ text: short }), { marker: markerAt(20), answerText: answerText(short) })
  expect(one.result.reply).toBe(short)
  expect(one.elapsed).toBeLessThan(900)
  expect(tailSuffix(normalizeAnswerText(short))).toBeNull()
}, 20_000)

// ------------------------------------------------------------- C: the tap

function makeSession() {
  const handlers = new Map()
  const commands = []
  let streamCalls = 0
  const session = {
    commands,
    streamCalls: () => streamCalls,
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, new Set())
      handlers.get(event).add(handler)
    },
    async send(command) {
      commands.push(command)
      if (command === 'Network.streamResourceContent') {
        streamCalls += 1
        if (streamCalls === 1) throw new Error('Trying to stream resource content before the request has started')
        return { bufferedData: '' }
      }
      if (command === 'Network.disable') handlers.clear()
      return {}
    },
    async detach() { handlers.clear() },
    emit(event, payload) { for (const handler of handlers.get(event) ?? []) handler(payload) },
    listenerCount() { let total = 0; for (const set of handlers.values()) total += set.size; return total },
  }
  return session
}

function tapPage(session) {
  return {
    url: () => URL_NOW,
    context: () => ({ newCDPSession: async () => session }),
  }
}

function sendPost(session, requestId = 'r1') {
  session.emit('Network.requestWillBeSent', {
    requestId,
    request: { method: 'POST', url: 'https://chatgpt.com/backend-api/f/conversation' },
  })
  session.emit('Network.responseReceived', {
    requestId,
    response: { status: 200, url: 'https://chatgpt.com/backend-api/f/conversation' },
  })
}

test('c1. the tap retries, then the split patch resolves the marker once, anchored', async () => {
  const session = makeSession()
  const watch = await startNetworkWatch(tapPage(session))
  expect(watch.available).toBe(true)
  sendPost(session)
  // The retry is 120 ms; the buffered body carries the id announcement.
  await delay(200)
  expect(session.streamCalls()).toBe(2)
  session.emit('Network.dataReceived', {
    requestId: 'r1',
    data: b64('data: {"type":"message_marker","message_id":"m-answer","marker":"user_visible_token","event":"first"}\n\n'),
  })
  const frame = b64(PATCH)
  session.emit('Network.dataReceived', { requestId: 'r1', data: frame.slice(0, 40) })
  session.emit('Network.dataReceived', { requestId: 'r1', data: frame.slice(40) })
  const marker = await watch.marker
  expect(marker.requestId).toBe('r1')
  expect(marker.messageId).toBe('m-answer')
  expect(typeof marker.at).toBe('number')
  // No Fetch domain, no pausing: an observer that can stall the send is worse
  // than no tap.
  expect(session.commands.some(command => /^Fetch\./.test(command))).toBe(false)
  expect(session.commands).toContain('Network.streamResourceContent')
  await watch.stop()
}, 20_000)

test('c2. a marker for another requestId is ignored; a superseding send nulls the promise', async () => {
  const session = makeSession()
  const watch = await startNetworkWatch(tapPage(session))
  sendPost(session, 'r1')
  await delay(160)
  session.emit('Network.dataReceived', { requestId: 'r2', data: b64(PATCH) })
  const state = await Promise.race([watch.marker.then(value => ({ value })), delay(200).then(() => ({ pending: true }))])
  expect(state).toEqual({ pending: true })
  // A second send POST while we hold an acceptance: nothing r1 emits is this
  // turn's evidence any more.
  session.emit('Network.requestWillBeSent', {
    requestId: 'r2',
    request: { method: 'POST', url: 'https://chatgpt.com/backend-api/conversation' },
  })
  expect(await watch.marker).toBeNull()
  await watch.stop()
}, 20_000)

test('c3. stop() releases a pending marker and tears the session down', async () => {
  const session = makeSession()
  const watch = await startNetworkWatch(tapPage(session))
  sendPost(session, 'r1')
  await delay(160)
  const stopped = await watch.stop()
  expect(stopped.available).toBe(true)
  expect(await watch.marker).toBeNull()
  expect(session.listenerCount()).toBe(0)
  expect(session.commands).toContain('Network.disable')
}, 20_000)

test('c5. the tap accumulates answer text and keeps one buffer per message', async () => {
  const session = makeSession()
  const watch = await startNetworkWatch(tapPage(session))
  sendPost(session, 'r1')
  await delay(160)
  const frame = body => ({ requestId: 'r1', data: b64(body) })
  session.emit('Network.dataReceived', frame('data: {"type":"message_marker","message_id":"m-answer","marker":"user_visible_token","event":"first"}\n\n'))
  session.emit('Network.dataReceived', frame('event: delta\ndata: {"v":[{"p":"/message/content/parts/0","o":"append","v":"Hello"}]}\n\n'))
  session.emit('Network.dataReceived', frame('event: delta\ndata: {"p":"/message/content/parts/0","o":"append","v":" there"}\n\n'))
  expect(watch.answerText()).toMatchObject({ id: 'm-answer', text: 'Hello there' })
  // A frame that names another message starts a fresh buffer, so a tool's text
  // can never be mistaken for the answer's when the ids are compared.
  session.emit('Network.dataReceived', frame('data: {"v":{"message":{"id":"m-tool"}}}\n\n'))
  expect(watch.answerText()).toMatchObject({ id: 'm-tool', text: '' })
  session.emit('Network.dataReceived', frame('event: delta\ndata: {"p":"/message/content/parts/0","o":"append","v":"tool"}\n\n'))
  expect(watch.answerText()).toMatchObject({ id: 'm-tool', text: 'tool' })
  await watch.stop()
}, 20_000)

test('c4. a body the tap never gets leaves the marker pending, never wrong', async () => {
  const session = makeSession()
  const watch = await startNetworkWatch(tapPage(session))
  sendPost(session, 'r1')
  // A completion-shaped message that is not this turn's patch.
  await delay(160)
  session.emit('Network.dataReceived', {
    requestId: 'r1',
    data: b64('data: {"type":"message","message":{"status":"finished_successfully","content":{"parts":[]}}}\n\n'),
  })
  const state = await Promise.race([watch.marker.then(value => ({ value })), delay(250).then(() => ({ pending: true }))])
  expect(state).toEqual({ pending: true })
  await watch.stop()
}, 20_000)
