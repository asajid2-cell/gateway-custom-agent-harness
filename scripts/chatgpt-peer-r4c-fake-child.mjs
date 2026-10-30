// Real child for the R-LIVE-5 lanes: the driver under a page that keeps
// generating while one read misses its own deadline.
//
// Ops run on independent timers, not a FIFO chain: a page turn that is still
// generating (a `send` that emitted `accepted`) and a `conversation` read of
// that same page are two things the child is doing at once, which is exactly
// the shape the host saw live. `delayMs` on a request keeps the test short.
const readline = require('node:readline')

const emit = value => process.stdout.write(JSON.stringify(value) + '\n')
const rl = readline.createInterface({ input: process.stdin })

// The page's one pushed signal. Its timestamp never moves by itself: a signal
// that changed on every poll would read as progress and extend every wait.
const SIGNAL_AT = new Date().toISOString()
let statusCalls = 0
// 'delay' answers a conversation read after `delayMs`; 'error' is a genuine
// page-side failure (the driver answered, the page did not).
let conversationMode = 'delay'

emit({ event: 'ready' })

rl.on('line', line => {
  let request
  try { request = JSON.parse(line) } catch { return }
  const id = request.id
  const delay = Number.isFinite(request.delayMs) ? Number(request.delayMs) : 0
  if (request.op === 'quit') { setTimeout(() => process.exit(0), 20); return }
  if (request.op === 'pid' || request.op === 'ping') {
    emit({ ok: true, op: request.op, id, pid: process.pid })
    return
  }
  if (request.op === 'mode') {
    if (typeof request.conversation === 'string') conversationMode = request.conversation
    emit({ ok: true, op: 'mode', id })
    return
  }
  if (request.op === 'status') {
    // The first question is the post gate (the page is idle, so the job is
    // typed); every later one is the turn's own wait, and the page generates.
    statusCalls += 1
    const state = statusCalls === 1 ? 'idle' : 'generating'
    emit({
      ok: true, op: 'status', id, cost: 'push', threadId: String(request.threadId ?? ''),
      pushedThreadId: String(request.threadId ?? ''), matchesThread: true,
      state, phase: state === 'generating' ? 'streaming' : 'complete',
      ageMs: 0, at: SIGNAL_AT,
    })
    return
  }
  if (request.op === 'send') {
    // Accepted at once, answered when the page finishes generating.
    emit({ event: 'accepted', id })
    setTimeout(() => emit({ ok: true, op: 'send', id, text: 'answered:' + String(request.text ?? ''), threadId: String(request.threadId ?? '') }), delay || 1200)
    return
  }
  if (request.op === 'conversation') {
    if (conversationMode === 'error') {
      emit({ ok: false, op: 'conversation', id, status: 500, error: 'conversation fetch failed' })
      return
    }
    setTimeout(() => emit({ ok: true, op: 'conversation', id, conversation: { mapping: {} } }), delay || 800)
    return
  }
  if (request.op === 'stuck') {
    // Takes the work and never finishes it: R2-F6's stuck head of the queue.
    emit({ event: 'accepted', id })
    return
  }
  if (request.op === 'nothing') return
  emit({ ok: true, op: request.op, id })
})
