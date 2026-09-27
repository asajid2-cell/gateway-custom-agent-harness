import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { PassThrough } from 'node:stream'
import React from 'react'
import { render } from '../src/ink.ts'
import reportHelp, { ReportHelp, call } from '../src/commands/report-help.tsx'

/**
 * `/report-help` exists so the report grammar can be read without asking the
 * model anything: it is an immediate local-jsx command that returns no result
 * and sends no query, and choosing a sample only fills the prompt. Those two
 * properties are the point of the command, so the menu is drawn for real here
 * rather than asserted structurally, and the selection is checked through the
 * onDone options - `shouldQuery` defaulting to true is exactly the mistake that
 * would turn this into a model turn.
 *
 * The one thing this menu is allowed to state as fact is where reports land, and
 * it does not re-type that path: it interpolates the skill's own export. A test
 * that hard-coded the directory would pass while the two drifted apart, so the
 * assertion below reads the export instead.
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
  const app = await render(React.createElement(ReportHelp, { onDone }), {
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

test('/report-help is immediate, non-interrupting, and loads a callable', async () => {
  assert.equal(reportHelp.name, 'report-help')
  assert.equal(reportHelp.type, 'local-jsx')
  assert.equal(reportHelp.immediate, true)
  const loaded = await reportHelp.load()
  assert.equal(typeof loaded.call, 'function')
})

test('a bare invocation opens the menu instead of producing a result', async () => {
  const menu = collector()
  const element = await call(menu.onDone, {}, '')
  assert.equal(menu.calls.length, 0, 'opening the menu is not a result')
  assert.ok(React.isValidElement(element), 'a bare invocation returns the menu element')
})

test('the menu draws the grammar, the evidence rules, and the samples', async () => {
  const { DEFAULT_REPORT_DIR } = await import('../src/skills/bundled/report.ts')
  const seen = collector()
  const app = await mount(seen.onDone)
  try {
    const usage = await app.capture()
    assert.match(usage, /hand off this project to another session/)
    assert.match(usage, /Depth/)
    assert.match(usage, /default is checkpoint/)
    assert.match(usage, /Choosing the session/)
    // The destination is the skill's own export, not a copy of it.
    assert.ok(usage.includes(DEFAULT_REPORT_DIR), 'the real default destination is named')
    assert.match(usage, /nothing is sent/)
    for (const label of ['Sample prompts', 'Evidence and labels', 'Close']) {
      assert.ok(usage.includes(label), `${label} is offered`)
    }

    // Row 2 is the evidence screen; it must show the labels and the PROVEN rule.
    const rules = await app.capture('2')
    assert.match(rules, /built from/)
    assert.match(rules, /machine-gathered evidence block/)
    assert.match(rules, /## Raw evidence/)
    assert.match(rules, /\[PROVEN\] requires a PASS row under TEST RUNS DETECTED/)
    assert.match(rules, /the bound is named/)

    // Back on row 1, and the focused sample's full command is drawn below the list.
    const samples = await app.capture('1')
    assert.match(samples, /Enter puts the highlighted line into your prompt/)
    assert.match(samples, /checkpoint \(this session\)/)
    assert.match(samples, /\/report checkpoint/)
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
    // Row 5 is the seed sample.
    await app.capture('5')
    assert.equal(seen.calls.length, 1, 'choosing a sample completes the command')
    const chosen = seen.calls[0]!
    assert.equal(chosen.result, undefined, 'no result text is produced')
    assert.equal(chosen.options?.display, 'skip', 'nothing is added to the transcript')
    assert.equal(chosen.options?.shouldQuery, undefined, 'the sample is not sent to the model')
    assert.equal(chosen.options?.submitNextInput, undefined, 'the sample is placed, not submitted')
    assert.match(chosen.options?.nextInput ?? '', /^\/report seed$/)
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
