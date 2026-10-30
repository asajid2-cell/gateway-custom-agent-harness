// Real child for the R-LIVE-5 lane: the driver under a page that keeps
// generating while one read misses its own deadline.
//
// Ops run on independent timers, not a FIFO chain: a page turn that is still
// generating (a `send` that emitted `accepted`) and a `conversation` read of
// that same page are two things the child is doing at once, which is exactly
// the shape the host saw live. `delayMs` on a request keeps the test short.
const readline = require('node:readline')

const emit = value => process.stdout.write(JSON.stringify(value) + '\n')
const rl = readline.createInterface({ input: process.stdin })

emit({ event: 'ready' })

rl.on('line', line => {
  let request
  try { request = JSON.parse(line) } catch { return }
  const id = request.id
  const delay = Number.isFinite(request.delayMs) ? Number(request.delayMs) : 0
  if (request.op === 'quit') { setTimeout(() => process.exit(0), 20); return }
  if (request.op === 'ping' || request.op === 'pid') {
    emit({ ok: true, op: request.op, id, pid: process.pid })
    return
  }
  if (request.op === 'send') {
    // Accepted at once, answered when the page finishes generating.
    emit({ event: 'accepted', id })
    setTimeout(() => emit({ ok: true, op: 'send', id, text: 'answered:' + String(request.text ?? '') }), delay || 1200)
    return
  }
  if (request.op === 'conversation') {
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
