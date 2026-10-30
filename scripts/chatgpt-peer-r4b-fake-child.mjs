/**
 * A real child process for the drain test: it speaks the line-JSON driver
 * protocol, accepts every request, answers `ping`, and exits shortly after
 * `quit`. A `work` request is deliberately never answered, so it keeps an
 * in-flight deadline alive until the host ends it.
 */
import { createInterface } from 'node:readline'

const lines = createInterface({ input: process.stdin })
lines.on('line', line => {
  let request
  try { request = JSON.parse(line) } catch { return }
  if (!request || typeof request !== 'object') return
  if (request.op === 'quit') {
    process.stdout.write(`${JSON.stringify({ ok: true, op: 'quit' })}\n`)
    setTimeout(() => process.exit(0), 200)
    return
  }
  if (request.id) process.stdout.write(`${JSON.stringify({ event: 'accepted', id: request.id })}\n`)
  if (request.op === 'ping' && request.id) {
    process.stdout.write(`${JSON.stringify({ id: request.id, ok: true, op: 'ping' })}\n`)
  }
})
