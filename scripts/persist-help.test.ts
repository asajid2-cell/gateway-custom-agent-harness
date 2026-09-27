import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { PassThrough } from 'node:stream'
import React from 'react'
import { render } from '../src/ink.ts'
import persistHelp, { EXAMPLES, PERSIST_REFERENCE, SAMPLES, PersistHelp, call } from '../src/commands/persist-help.tsx'
import { parsePersistArgs } from '../src/skills/bundled/persist.ts'

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

async function mount(onDone: OnDone, copy?: (text: string) => Promise<void>) {
  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 40 })
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {},
  })
  let output = ''
  let mark = 0
  stdout.on('data', chunk => { output += chunk.toString() })
  const app = await render(React.createElement(PersistHelp, { onDone, copy }), {
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
    assert.match(usage, /bounded: up to N reminders, then kept but quiet/)
    assert.match(usage, /Modes/)
    for (const label of [
      'Full reference — read it, or copy the whole thing',
      'Sample prompts — copy a format into your prompt',
      'Checkpoints and blockers',
      'Close',
    ]) {
      assert.ok(usage.includes(label), `${label} is offered`)
    }

    // Row 3 is the checkpoint screen; it must show the JSON the engine enforces.
    const checkpoints = await app.capture('3')
    assert.match(checkpoints, /Checkpoints and blockers/)
    assert.match(checkpoints, /\{"kind":"advanced\|learned\|delivered\|detoured",/)
    assert.match(checkpoints, /never skip `integrate`/)
    assert.match(checkpoints, /canProceedWithoutUser":false/)

    // Back on row 2, and the focused sample's full command is drawn below the list.
    const samples = await app.capture('2')
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
    await app.capture('2')
    // Row 2 is the capped-nudges sample.
    await app.capture('2')
    assert.equal(seen.calls.length, 1, 'choosing a sample completes the command')
    const chosen = seen.calls[0]!
    assert.equal(chosen.result, undefined, 'no result text is produced')
    assert.equal(chosen.options?.display, 'skip', 'nothing is added to the transcript')
    assert.equal(chosen.options?.shouldQuery, undefined, 'the sample is not sent to the model')
    assert.equal(chosen.options?.submitNextInput, undefined, 'the sample is placed, not submitted')
    assert.match(chosen.options?.nextInput ?? '', /^\/persist --nudges 3 /)
  } finally {
    await app.unmount()
  }
})

test('Close ends the command without a result', async () => {
  const seen = collector()
  const app = await mount(seen.onDone)
  try {
    await app.capture('4')
    assert.equal(seen.calls.length, 1)
    assert.equal(seen.calls[0]!.result, undefined, 'closing reports nothing')
    assert.equal(seen.calls[0]!.options?.display, 'skip')
  } finally {
    await app.unmount()
  }
})

/**
 * The examples are instructions: a reader copies them verbatim, so one that the
 * parser would read differently - or refuse - is a wrong instruction. Each
 * example carries the exact result the grammar must produce, and this compares
 * it against the real parser rather than a restatement of it. The examples also
 * include the three traps (a mode word after the goal, task+keep, an
 * out-of-range nudge) precisely because those are where a reader's intuition
 * and the engine disagree.
 */
test('every documented example parses exactly as the help says', () => {
  for (const example of EXAMPLES) {
    assert.ok(example.command.startsWith('/persist '), `${example.command} is a /persist line`)
    const args = example.command.slice('/persist '.length)
    assert.deepEqual(parsePersistArgs(args), example.parsed, `${example.command} did not parse as documented`)
  }
})

/** The samples are copied into the prompt, so each must be a command the parser accepts. */
test('every sample prompt is a command the parser accepts', () => {
  const goals = SAMPLES.filter(sample => sample.value.startsWith('/persist '))
  assert.ok(goals.length > 0, 'the samples include arming commands')
  for (const sample of goals) {
    const parsed = parsePersistArgs(sample.value.slice('/persist '.length))
    assert.notEqual(parsed.kind, 'error', `${sample.value} is refused by the parser`)
  }
})

/**
 * The reference exists so the whole explanation can be taken away in one piece.
 * The screen carries the shape - it must stay inside the immediate-command slot,
 * which is capped at the viewport height, so it cannot draw the whole document -
 * and the copy carries the document itself. This pins both halves: the screen
 * shows the summary and names the entry points, and copying hands over the full
 * text with every verified example in it.
 */
test('the full reference is readable and copies as one blurb', async () => {
  const seen = collector()
  const copied: string[] = []
  const app = await mount(seen.onDone, async text => { copied.push(text) })
  try {
    const usage = await app.capture()
    assert.match(usage, /Full reference/)

    const reference = await app.capture('1')
    assert.match(reference, /Copy the complete reference/)
    assert.match(reference, /WHAT IT IS/)
    assert.match(reference, /GRAMMAR — modifiers precede the goal; order among them is free/)
    assert.match(reference, /MODES/)
    assert.match(reference, /REVIEW — \/persist-review/)
    assert.equal(seen.calls.length, 0, 'reading the reference is not a result')

    // Row 1 on the reference screen is Copy the complete reference.
    await app.capture('1')
    assert.deepEqual(copied, [PERSIST_REFERENCE], 'the copy is the complete reference itself')
    const blurb = copied[0]!
    assert.ok(blurb.startsWith('PERSIST — '), 'the blurb carries its own title')
    for (const heading of [
      'WHAT IT IS',
      'GRAMMAR',
      'LOOK-AFTER MODES',
      'EXAMPLES — complete commands you can copy',
      'LIFECYCLE',
      '/persist-review — checkpoints and the done/blocked verdict',
      'THINGS THAT WILL BITE YOU',
    ]) {
      assert.ok(blurb.includes(heading), `the blurb has the ${heading} section`)
    }
    for (const example of EXAMPLES) {
      assert.ok(blurb.includes(example.command), `${example.command} is in the blurb`)
    }
    assert.equal(seen.calls.length, 0, 'copying is not a result either')
  } finally {
    await app.unmount()
  }
})
