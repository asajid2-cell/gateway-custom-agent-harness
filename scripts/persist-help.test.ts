import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { PassThrough } from 'node:stream'
import React from 'react'
import { render } from '../src/ink.ts'
import persistHelp, { PersistHelp, call } from '../src/commands/persist-help.tsx'

/**
 * `/persist-help` exists so the persist grammar can be read without asking the
 * model anything: it is an immediate local-jsx command that returns no result
 * and sends no query, and choosing a sample only fills the prompt. Those two
 * properties are the point of the command, so the menu is drawn for real here
 * rather than asserted structurally, and the selection is checked through the
 * onDone options - `shouldQuery` defaulting to true is exactly the mistake that
 * would turn this into a model turn.
 *
 * Selection is driven by number keys rather than arrows or Escape: those are
 * dispatched through the keybinding layer, which needs a Select context a bare
 * render does not provide, while the digits are handled by the select's own
 * input hook. The menu numbers its rows so this is also how a user can drive it.
 */

type Done = {
  result: string | undefined
  options?: { display?: string; nextInput?: string; shouldQuery?: boolean; submitNextInput?: boolean }
}

type OnDone = (result?: string, options?: Done['options']) => void

const tick = (ms = 200) => new Promise(resolve => setTimeout(resolve, ms))

function collector(): { calls: Done[]; onDone: OnDone } {
  const calls: Done[] = []
  return { calls, onDone: (result, options) => { calls.push({ result, options }) } }
}

function plain(output: string): string {
  return output
    .replace(/\x1b\[(\d+)C/g, (_, count: string) => ' '.repeat(Number(count)))
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
}

async function mount(onDone: OnDone) {
  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 40 })
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {},
  })
  let output = ''
  let mark = 0
  stdout.on('data', chunk => { output += chunk.toString() })
  const app = await render(React.createElement(PersistHelp, { onDone }), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false, exitOnCtrlC: false,
  })
  await tick()
  // Only what is written after the previous capture is returned. A non-TTY
  // stdout gets whole frames, so this is the screen the last keypress produced
  // rather than an accumulation that could match a screen already left behind.
  const capture = async (key?: string) => {
    const from = mark
    if (key) stdin.write(key)
    await tick(250)
    mark = output.length
    return plain(output.slice(from))
  }
  return { capture, unmount: async () => { app.unmount(); await tick(20) } }
}

test('/persist-help is immediate, non-interrupting, and loads a callable', async () => {
  assert.equal(persistHelp.name, 'persist-help')
  assert.equal(persistHelp.type, 'local-jsx')
  assert.equal(persistHelp.immediate, true)
  const loaded = await persistHelp.load()
  assert.equal(typeof loaded.call, 'function')
})

test('a bare invocation opens the menu instead of producing a result', async () => {
  const menu = collector()
  const element = await call(menu.onDone, {}, '')
  assert.equal(menu.calls.length, 0, 'opening the menu is not a result')
  assert.ok(React.isValidElement(element), 'a bare invocation returns the menu element')
})

test('the menu draws the grammar, the checkpoints, and the samples', async () => {
  const seen = collector()
  const app = await mount(seen.onDone)
  try {
    const usage = await app.capture()
    assert.match(usage, /keep a goal alive across turns/)
    assert.match(usage, /Arm a goal/)
    assert.match(usage, /bounded: work on it until the outcome is met/)
    assert.match(usage, /Modes/)
    for (const label of ['Sample prompts — copy a format into your prompt', 'Checkpoints and blockers', 'Close']) {
      assert.ok(usage.includes(label), `${label} is offered`)
    }

    // Row 2 is the checkpoint screen; it must show the JSON the engine enforces.
    const checkpoints = await app.capture('2')
    assert.match(checkpoints, /Checkpoints and blockers/)
    assert.match(checkpoints, /\{"kind":"advanced\|learned\|delivered\|detoured",/)
    assert.match(checkpoints, /never skip `integrate`/)
    assert.match(checkpoints, /canProceedWithoutUser":false/)

    // Back on row 1, and the focused sample's full command is drawn below the list.
    const samples = await app.capture('1')
    assert.match(samples, /Enter puts the highlighted line into your prompt/)
    assert.match(samples, /bounded goal/)
    assert.match(samples, /\/persist fix the installer so a fresh PC bootstrap works end-to-end/)
    assert.equal(seen.calls.length, 0, 'opening a screen is not a result')
  } finally {
    await app.unmount()
  }
})

test('choosing a sample fills the prompt and sends nothing', async () => {
  const seen = collector()
  const app = await mount(seen.onDone)
  try {
    await app.capture('1')
    // Row 5 is the capped-nudges sample.
    await app.capture('5')
    assert.equal(seen.calls.length, 1, 'choosing a sample completes the command')
    const chosen = seen.calls[0]!
    assert.equal(chosen.result, undefined, 'no result text is produced')
    assert.equal(chosen.options?.display, 'skip', 'nothing is added to the transcript')
    assert.equal(chosen.options?.shouldQuery, undefined, 'the sample is not sent to the model')
    assert.equal(chosen.options?.submitNextInput, undefined, 'the sample is placed, not submitted')
    assert.match(chosen.options?.nextInput ?? '', /^\/persist task --nudges 3 /)
  } finally {
    await app.unmount()
  }
})

test('Close ends the command without a result', async () => {
  const seen = collector()
  const app = await mount(seen.onDone)
  try {
    await app.capture('3')
    assert.equal(seen.calls.length, 1)
    assert.equal(seen.calls[0]!.result, undefined, 'closing reports nothing')
    assert.equal(seen.calls[0]!.options?.display, 'skip')
  } finally {
    await app.unmount()
  }
})
