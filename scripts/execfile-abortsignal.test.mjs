import assert from 'node:assert/strict'
import test from 'node:test'

import { execFileNoThrow } from '../src/utils/execFileNoThrow.js'

/**
 * An abortSignal must not stop the command from running.
 *
 * execa v9 renamed the `signal` option to `cancelSignal`. The wrapper passed
 * `signal`, so execa threw `TypeError: The "signal" option has been renamed to
 * "cancelSignal" instead.` before the spawn. Every abortable call therefore
 * returned a rejected promise and never ran its command — the file-suggestion
 * git listing fell back to ripgrep on every prompt, and the rejection, when
 * unhandled, was logged once per call.
 */
test('a live abortSignal still runs the command', async () => {
  const controller = new AbortController()
  const result = await execFileNoThrow(
    process.execPath,
    ['-e', 'process.stdout.write("ok")'],
    { abortSignal: controller.signal, useCwd: false },
  )
  assert.equal(result.code, 0, `stderr=${result.stderr}`)
  assert.equal(result.stdout.trim(), 'ok')
})

test('an already-aborted signal cancels instead of running', async () => {
  const controller = new AbortController()
  controller.abort()
  const result = await execFileNoThrow(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 5000)'],
    { abortSignal: controller.signal, useCwd: false, timeout: 10_000 },
  )
  assert.notEqual(result.code, 0)
})
