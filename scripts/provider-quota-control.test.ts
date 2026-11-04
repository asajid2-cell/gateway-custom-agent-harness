import { strict as assert } from 'node:assert'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import React from 'react'
import { PassThrough } from 'node:stream'
import { render, useInput } from '../src/ink.ts'
import instances from '../src/ink/instances.ts'
import { ProviderQuotaControl } from '../src/components/PromptInput/PromptInputFooter.tsx'
import type { ProviderName, ProviderQuota } from '../src/utils/bottomBarUsage.ts'

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const quota = (
  windows: ProviderQuota['windows'],
  extra: Partial<ProviderQuota> = {},
): ProviderQuota => ({ windows, asof: 1_000, stale: false, ...extra })

/**
 * Mount the quota control on its own, at the cell a click lands on. The
 * renderer writes only the cells that changed, so the frame as first mounted is
 * asserted whole and each later assertion is made against just the changed
 * characters - the cycle's *semantics* are pinned exhaustively by the pure
 * helpers in bottom-bar-usage.test.mjs, and this proves the control is wired to
 * them.
 */
async function mountQuota(provider: ProviderName, model: string, value: ProviderQuota) {
  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 24, isTTY: true })
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} })
  let output = ''
  stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
  const element = React.createElement(ProviderQuotaControl, { provider, model, quota: value })
  function InputHost() {
    useInput(() => {})
    return element
  }
  const app = await render(React.createElement(InputHost), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
    exitOnCtrlC: false,
  })
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream)!
  instance.setAltScreenActive(true, true)
  await wait(100)
  return {
    // The renderer writes changed cells and cursor moves, so assertions are made
    // against the characters that reached the terminal with escapes taken out. A
    // run of unchanged cells is emitted as a cursor-forward for that many
    // columns, not as literal spaces, so those are expanded first - otherwise
    // every space in a label disappears and the assertion reads as a product
    // defect.
    rendered: () =>
      output
        .replace(/\x1b\[(\d*)C/g, (_match, count: string) => ' '.repeat(count === '' ? 1 : Number(count)))
        .replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''),
    // The raw bytes, escapes kept, for assertions about the styling the renderer
    // emitted (an underline is an SGR sequence, not a character).
    raw: () => output,
    clear: () => { output = '' },
    // A press and a release on the same cell is the click.
    click: async () => {
      stdin.write('\x1b[<0;1;1M')
      stdin.write('\x1b[<0;1;1m')
      await wait(100)
    },
    // A mouse-motion report over the control, which is what drives onMouseEnter.
    hover: async () => {
      stdin.write('\x1b[<35;2;1M')
      await wait(100)
    },
    // One key per call: a chunk like ' \t' is not parsed as a Space keydown, so
    // only separate writes exercise the keyboard path a focus target would use.
    keys: async (keys: string) => {
      stdin.write(keys)
      await wait(100)
    },
    unmount: () => app.unmount(),
  }
}

test('a click cycles the Codex quota weekly then hourly and back', async () => {
  const control = await mountQuota('Codex', 'gateway-gpt-6-sol', quota({
    W: { usedPercent: 23, resetsAt: null },
    H: { usedPercent: 0, resetsAt: null },
  }))
  try {
    // The whole label on mount, because the first frame is the whole frame.
    assert.match(control.rendered(), /Weekly usage: 77% left/)
    control.clear()
    await control.click()
    // Only the changed cells are written, so the step is read from the window
    // label that replaced weekly: it is the new window, not a re-render.
    assert.match(control.rendered(), /5hr/)
    control.clear()
    await control.click()
    // After the last window the cycle names the provider, so the pool is one
    // click away without permanently spending columns on it.
    assert.match(control.rendered(), /Codex/)
    control.clear()
    await control.click()
    assert.match(control.rendered(), /Weekly/)
    // Click-only, like the resume control beside it: the click must not leave a
    // focus target that Space or Enter re-activates, which would step the window
    // without a pointer. Each key is sent on its own - a chunk like ' \t' is not
    // parsed as a keydown, so it would pass against a Button too.
    control.clear()
    await control.keys(' ')
    assert.equal(control.rendered(), '')
    control.clear()
    await control.keys('\r')
    assert.equal(control.rendered(), '')
  } finally {
    control.unmount()
  }
})

test('the OpenCode quota cycles weekly, hourly, monthly and back', async () => {
  const control = await mountQuota('OpenCode', 'gateway-opencode-deepseek-v4.1-flash', quota({
    W: { usedPercent: 10, resetsAt: null },
    H: { usedPercent: 20, resetsAt: null },
    M: { usedPercent: 30, resetsAt: null },
  }))
  try {
    assert.match(control.rendered(), /Weekly usage: 90% left/)
    control.clear()
    await control.click()
    assert.match(control.rendered(), /5hr/)
    control.clear()
    await control.click()
    assert.match(control.rendered(), /Monthly/)
    control.clear()
    await control.click()
    assert.match(control.rendered(), /OpenCode/)
    control.clear()
    await control.click()
    // Changed cells only, so the stable part of the label is the assertion.
    assert.match(control.rendered(), /usage: 90% left/)
  } finally {
    control.unmount()
  }
})

test('a missing window is skipped rather than shown empty', async () => {
  // Weekly is absent, so the cycle is hourly -> monthly -> hourly.
  const control = await mountQuota('OpenCode', 'gateway-opencode-deepseek-v4.1-flash', quota({
    H: { usedPercent: 20, resetsAt: null },
    M: { usedPercent: 30, resetsAt: null },
  }))
  try {
    assert.match(control.rendered(), /5hr usage: 80% left/)
    control.clear()
    await control.click()
    assert.match(control.rendered(), /Monthly/)
    control.clear()
    await control.click()
    assert.match(control.rendered(), /OpenCode/)
    control.clear()
    await control.click()
    assert.match(control.rendered(), /5hr/)
  } finally {
    control.unmount()
  }
})

test('a stale figure carries the marker', async () => {
  const control = await mountQuota('Anthropic', 'gateway-claude-opus-5-5', quota(
    { W: { usedPercent: 12, resetsAt: null } },
    { stale: true },
  ))
  try {
    assert.match(control.rendered(), /Weekly usage: 88% left \(stale\)/)
  } finally {
    control.unmount()
  }
})

test('the hover underline marks only a control with a second window', async () => {
  // The underline is how the control advertises that it is clickable. A single
  // window has nothing to step to, so hovering it must not underline - that
  // would advertise a dead control, which the click assertions cannot see.
  const two = await mountQuota('Codex', 'gateway-gpt-6-sol', quota({
    W: { usedPercent: 23, resetsAt: null },
    H: { usedPercent: 0, resetsAt: null },
  }))
  const one = await mountQuota('Anthropic', 'gateway-claude-opus-5-5', quota({ W: { usedPercent: 12, resetsAt: null } }))
  try {
    two.clear()
    await two.hover()
    assert.match(two.raw(), /\x1b\[4m/)
    one.clear()
    await one.hover()
    assert.doesNotMatch(one.raw(), /\x1b\[4m/)
  } finally {
    two.unmount()
    one.unmount()
  }
})

test('a single-window quota wires no click handler', async () => {
  // With one window there is nothing to cycle to, so the control must not be a
  // click target at all - the same shape as an unnamed session's resume control.
  const control = await mountQuota('Anthropic', 'gateway-claude-opus-5-5', quota({ W: { usedPercent: 12, resetsAt: null } }))
  try {
    assert.match(control.rendered(), /Weekly usage: 88% left/)
    control.clear()
    await control.click()
    // Nothing to step to, so the click cannot move the window off weekly.
    assert.match(control.rendered(), /Weekly usage: 88% left/)
    assert.doesNotMatch(control.rendered(), /Anthropic/)
  } finally {
    control.unmount()
  }
  const source = await readFile(
    new URL('../src/components/PromptInput/PromptInputFooter.tsx', import.meta.url),
    'utf8',
  )
  // The click is wired only when there is a second step to take.
  assert.match(source, /steps\.length > 1 \? \{/)
  // The control is a plain Box with onClick - never a Button, which would leave
  // a Space/Enter focus target behind, like the resume row beside it.
  const start = source.indexOf('export function ProviderQuotaControl')
  const end = source.indexOf('\n//# sourceMappingURL', start)
  assert.ok(start >= 0 && end > start)
  const controlSource = source.slice(start, end)
  assert.match(controlSource, /<Box flexShrink=\{0\} \{\.\.\.cycle\}>/)
  assert.doesNotMatch(controlSource, /<Button[\s>]/)
})
