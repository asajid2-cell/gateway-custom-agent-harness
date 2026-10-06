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
async function mountQuota(provider: ProviderName, value: ProviderQuota) {
  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 24, isTTY: true })
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} })
  let output = ''
  stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
  const element = React.createElement(ProviderQuotaControl, { provider, quota: value })
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
    // against the characters that reached the terminal with escapes taken out.
    rendered: () => output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''),
    clear: () => { output = '' },
    // A press and a release on the same cell is the click.
    click: async () => {
      stdin.write('\x1b[<0;1;1M')
      stdin.write('\x1b[<0;1;1m')
      await wait(100)
    },
    keys: async (keys: string) => {
      stdin.write(keys)
      await wait(100)
    },
    unmount: () => app.unmount(),
  }
}

test('a click cycles the Codex quota weekly then hourly and back', async () => {
  const control = await mountQuota('Codex', quota({
    W: { usedPercent: 23, resetsAt: null },
    H: { usedPercent: 0, resetsAt: null },
  }))
  try {
    // The whole label on mount, because the first frame is the whole frame.
    assert.match(control.rendered(), /Codex W remaining 77%/)
    control.clear()
    await control.click()
    // Only the changed cells are written, so the step is read from the window
    // letter that replaced weekly: it is the new window, not a re-render.
    assert.match(control.rendered(), /H/)
    control.clear()
    await control.click()
    assert.match(control.rendered(), /W/)
    // Click-only, like the resume control beside it: the click must not leave a
    // focus target that Space or Tab re-activates, which would step the window
    // without a pointer.
    control.clear()
    await control.keys(' \t')
    assert.doesNotMatch(control.rendered(), /H/)
  } finally {
    control.unmount()
  }
})

test('the OpenCode quota cycles weekly, hourly, monthly and back', async () => {
  const control = await mountQuota('OpenCode', quota({
    W: { usedPercent: 10, resetsAt: null },
    H: { usedPercent: 20, resetsAt: null },
    M: { usedPercent: 30, resetsAt: null },
  }))
  try {
    assert.match(control.rendered(), /OpenCode W remaining 90%/)
    control.clear()
    await control.click()
    assert.match(control.rendered(), /H/)
    control.clear()
    await control.click()
    assert.match(control.rendered(), /M/)
    control.clear()
    await control.click()
    assert.match(control.rendered(), /W/)
  } finally {
    control.unmount()
  }
})

test('a missing window is skipped rather than shown empty', async () => {
  // Weekly is absent, so the cycle is hourly -> monthly -> hourly.
  const control = await mountQuota('OpenCode', quota({
    H: { usedPercent: 20, resetsAt: null },
    M: { usedPercent: 30, resetsAt: null },
  }))
  try {
    assert.match(control.rendered(), /OpenCode H remaining 80%/)
    control.clear()
    await control.click()
    assert.match(control.rendered(), /M/)
    control.clear()
    await control.click()
    assert.match(control.rendered(), /H/)
  } finally {
    control.unmount()
  }
})

test('a stale figure carries the marker', async () => {
  const control = await mountQuota('Anthropic', quota(
    { W: { usedPercent: 12, resetsAt: null } },
    { stale: true },
  ))
  try {
    assert.match(control.rendered(), /Anthropic W remaining 88% \(stale\)/)
  } finally {
    control.unmount()
  }
})

test('a single-window quota wires no click handler', async () => {
  // With one window there is nothing to cycle to, so the control must not be a
  // click target at all - the same shape as an unnamed session's resume control.
  const control = await mountQuota('Anthropic', quota({ W: { usedPercent: 12, resetsAt: null } }))
  try {
    assert.match(control.rendered(), /Anthropic W remaining 88%/)
    control.clear()
    await control.click()
    // Nothing to step to, so the click cannot move the window off weekly.
    assert.doesNotMatch(control.rendered(), /H/)
  } finally {
    control.unmount()
  }
  const source = await readFile(
    new URL('../src/components/PromptInput/PromptInputFooter.tsx', import.meta.url),
    'utf8',
  )
  // The click is wired only when there is a second window to step to.
  assert.match(source, /available\.length > 1 \? \{/)
  // The control is a plain Box with onClick - never a Button, which would leave
  // a Space/Enter focus target behind, like the resume row beside it.
  const start = source.indexOf('export function ProviderQuotaControl')
  const end = source.indexOf('\n//# sourceMappingURL', start)
  assert.ok(start >= 0 && end > start)
  const controlSource = source.slice(start, end)
  assert.match(controlSource, /<Box flexShrink=\{0\} \{\.\.\.cycle\}>/)
  assert.doesNotMatch(controlSource, /<Button[\s>]/)
})
