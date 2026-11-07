import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import React from 'react'
import { render } from '../src/ink.ts'
import { UsageMenu } from '../src/components/UsageWorkspaceDialog.tsx'
import { resetTokenLedgerForTests } from '../src/utils/tokenLedger.ts'
import usage from '../src/commands/usage/index.ts'
import { call } from '../src/commands/usage/usage.tsx'

/**
 * `/usage` is two surfaces over one ledger, and both are covered here: the
 * argument grammar that `scripts/token-usage.mjs` also serves, and the menu the
 * bare invocation opens. The menu is rendered for real rather than asserted
 * structurally - a menu that cannot draw is the failure that matters, and it is
 * invisible to a test that only checks the element type.
 */

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    // Today, so the trend screen has a point inside its 30-day window whenever
    // this suite is run rather than only on the day it was written.
    at: new Date().toISOString(),
    session: 'cb41b4cd-466e-4b69-bf9c-410eddc6e812',
    cwd: '',
    model: 'gateway-opencode-deepseek-v4.1-flash',
    backend: 'opencode-go',
    input: 100,
    output: 10,
    cacheRead: 900,
    cacheWrite: 0,
    costUSD: 0.05,
    src: 'response',
    ...overrides,
  }
}

async function withLedger(
  rows: readonly Record<string, unknown>[],
  body: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'usage-menu-'))
  const previousDir = process.env.GATEWAY_TOKEN_LEDGER_DIR
  const previousFlag = process.env.GATEWAY_TOKEN_LEDGER
  process.env.GATEWAY_TOKEN_LEDGER_DIR = dir
  delete process.env.GATEWAY_TOKEN_LEDGER
  // The ledger caches its resolved directory, so a test that points it somewhere
  // else must clear that cache or it writes into the real one.
  resetTokenLedgerForTests()
  try {
    await writeFile(
      join(dir, 'tokens.jsonl'),
      `${rows.map(item => JSON.stringify(item)).join('\n')}\n`,
    )
    await body(dir)
  } finally {
    if (previousDir === undefined) delete process.env.GATEWAY_TOKEN_LEDGER_DIR
    else process.env.GATEWAY_TOKEN_LEDGER_DIR = previousDir
    if (previousFlag === undefined) delete process.env.GATEWAY_TOKEN_LEDGER
    else process.env.GATEWAY_TOKEN_LEDGER = previousFlag
    resetTokenLedgerForTests()
    await rm(dir, { recursive: true, force: true })
  }
}

function collector(): { calls: string[]; onDone: (value?: string) => void } {
  const calls: string[] = []
  return { calls, onDone: (value?: string) => { calls.push(value ?? '') } }
}

const tick = (ms = 80) => new Promise(resolve => setTimeout(resolve, ms))

test('the command is universal, immediate, and loads a callable', async () => {
  assert.equal(usage.name, 'usage')
  assert.equal(usage.type, 'local-jsx')
  // No availability: the ledger covers backends claude.ai subscribers never see,
  // and gating it there would hide the report from the users who need it most.
  assert.equal(usage.availability, undefined)
  assert.equal(usage.immediate, true)
  const loaded = await usage.load()
  assert.equal(typeof loaded.call, 'function')
})

test('a bare /usage opens the menu, and a period opens it on that window', async () => {
  await withLedger([row()], async () => {
    const bare = collector()
    const menu = await call(bare.onDone, {}, '')
    assert.equal(bare.calls.length, 0, 'opening the menu is not a result')
    assert.ok(React.isValidElement(menu), 'a bare invocation returns the menu element')
    assert.equal((menu as React.ReactElement<{ initialPeriod?: string }>).props.initialPeriod, 'all')

    const week = collector()
    const onWeek = await call(week.onDone, {}, 'week')
    assert.equal((onWeek as React.ReactElement<{ initialPeriod?: string }>).props.initialPeriod, 'week')

    const spaced = collector()
    const onMonth = await call(spaced.onDone, {}, '  month  ')
    assert.equal((onMonth as React.ReactElement<{ initialPeriod?: string }>).props.initialPeriod, 'month')
  })
})

test('arguments render the text report in-process', async () => {
  await withLedger([row({ input: 100 }), row({ input: 50 })], async () => {
    const text = collector()
    assert.equal(await call(text.onDone, {}, '--backend opencode-go'), null)
    assert.equal(text.calls.length, 1)
    assert.match(text.calls[0]!, /TOTAL/)
    assert.match(text.calls[0]!, /BY MODEL/)
    assert.ok(!text.calls[0]!.endsWith('\n'), 'the harness supplies its own newline')

    const json = collector()
    await call(json.onDone, {}, '--json')
    const parsed = JSON.parse(json.calls[0]!)
    assert.equal(parsed.totals.input, 150)
    assert.equal(parsed.byBackend[0].key, 'opencode-go')
  })
})

test('a bad flag is refused with the surface, not with a wrong report', async () => {
  await withLedger([row()], async () => {
    const bad = collector()
    await call(bad.onDone, {}, '--sesion abc')
    assert.match(bad.calls[0]!, /Usage: \/usage/)
    assert.match(bad.calls[0]!, /Unknown option/)
    assert.ok(!bad.calls[0]!.includes('TOTAL'), 'a typo must not print a report')

    const help = collector()
    await call(help.onDone, {}, '--help')
    assert.match(help.calls[0]!, /Token usage report/)
    assert.match(help.calls[0]!, /--period/)
    assert.ok(!help.calls[0]!.includes('BY MODEL'), 'help is the surface, not a report')
  })
})

test('the menu draws the real ledger and returns to the menu on Escape', async () => {
  await withLedger(
    [row({ input: 1000, costUSD: 0.5 }), row({ session: 'other-chat', input: 2000 })],
    async () => {
      // 100 columns, and deliberately NOT a TTY: on a TTY Ink repaints only the
      // cells that changed, so an accumulated buffer holds fragments of a frame
      // ("p ak 4.8K tok n") and no rendered sentence survives a substring search.
      // A non-TTY stdout gets each frame whole, which is what makes this
      // assertable at all.
      const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 40 })
      const stdin = Object.assign(new PassThrough(), {
        isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {},
      })
      let output = ''
      stdout.on('data', chunk => { output += chunk.toString() })
      let closed = 0

      const app = await render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(UsageMenu, { onDone: () => { closed++ } }),
        ),
        {
          stdout: stdout as unknown as NodeJS.WriteStream,
          stderr: stdout as unknown as NodeJS.WriteStream,
          stdin: stdin as unknown as NodeJS.ReadStream,
          patchConsole: false, exitOnCtrlC: false,
        },
      )

      try {
        await tick(150)
        // Ink encodes a space as a cursor-forward, and deleting those sequences
        // (rather than expanding them) is how a rendered line turns into
        // "Usage-Alltime" and a passing assertion into a mystery. The last
        // frame is what matters, so earlier writes are dropped.
        const plain = () =>
          output
            .replace(/\x1b\[(\d+)C/g, (_, count: string) => ' '.repeat(Number(count)))
            .replace(/\x1b\][^\x07]*\x07/g, '')
            .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
        // The last frame is the live screen; earlier ones are history.
        const frame = () => plain().slice(plain().lastIndexOf('Usage'))
        assert.match(frame(), /Usage [\u2014-] All time/)
        assert.match(frame(), /2 requests/, 'the summary counts both chats')
        assert.match(frame(), /2 chats/)
        assert.match(frame(), /4\.8K tokens/, 'the summary sums the four figures')
        // The list scrolls, so this asserts the first screen's options rather
        // than every option: Close sits below the fold and is reached by
        // scrolling, which the keybinding layer owns.
        for (const label of [
          'Tokens by model',
          'Tokens by chat',
          'Tokens by upstream',
          'Throughput (tok/s)',
          'Custom range',
        ]) {
          assert.ok(frame().includes(label), `${label} is offered`)
        }

        // Option 5 is "Trend over time". Selection here is by number key rather
        // than arrow-plus-Enter: arrows are dispatched through the keybinding
        // layer, which needs a Select context that a bare render does not
        // provide, while the digits are handled directly by the select's own
        // input hook. Opening a screen is what this asserts, not the keybinding
        // plumbing the real REPL already covers.
        stdin.write('5')
        await tick(250)
        assert.match(frame(), /Trend [\u2014-] \d+ day/, 'the trend screen opened')
        assert.match(frame(), /peak 4\.8K tokens on \d{4}-\d{2}-\d{2}/, 'the trend reports its peak, not just a shape')
        assert.ok(!frame().includes('0…'), 'the date axis is labels, not a row of clipped stubs')
        assert.match(frame(), /Esc returns to the menu/)

        stdin.write('\x1b')
        await tick(200)
        assert.match(frame(), /Usage [\u2014-] All time/, 'Escape backs out one level')
        assert.equal(closed, 0, 'Escape on a sub-screen does not close the report')
      } finally {
        app.unmount()
        await tick(20)
      }
    },
  )
})

test('a narrow terminal gets a dated range instead of clipped labels', async () => {
  // Fifteen days of history: the series is daily (the span is under three
  // weeks), and fifteen two-cell columns will not fit a 40-column terminal, so
  // the axis must fall back to the range.
  const today = new Date()
  const rows = Array.from({ length: 15 }, (_, index) => {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (14 - index))
    return row({ at: day.toISOString(), input: 1000 })
  })
  await withLedger(rows, async () => {
    const stdout = Object.assign(new PassThrough(), { columns: 40, rows: 40 })
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {},
    })
    let output = ''
    stdout.on('data', chunk => { output += chunk.toString() })
    const app = await render(React.createElement(UsageMenu, { onDone: () => {} }), {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false, exitOnCtrlC: false,
    })
    try {
      await tick(150)
      stdin.write('5')
      await tick(250)
      const plain = output
        .replace(/\x1b\[(\d+)C/g, (_, count: string) => ' '.repeat(Number(count)))
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      // Fifteen daily points will not fit as labelled columns at 40 columns, so
      // the axis becomes one full range rather than fifteen clipped stubs.
      assert.match(plain, /Trend [\u2014-] 15 days/)
      assert.match(plain, /\d{4}-\d{2}-\d{2} … \d{4}-\d{2}-\d{2}/)
      assert.ok(!plain.includes('0…'))
    } finally {
      app.unmount()
      await tick(20)
    }
  })
})

/** Render the menu on a non-TTY stdout and return the last frame as plain text. */
async function withMenu(
  rows: readonly Record<string, unknown>[],
  body: (frame: () => string, stdin: PassThrough) => Promise<void>,
  columns = 100,
): Promise<void> {
  await withLedger(rows, async () => {
    const stdout = Object.assign(new PassThrough(), { columns, rows: 40 })
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {},
    })
    let output = ''
    stdout.on('data', chunk => { output += chunk.toString() })
    const app = await render(React.createElement(UsageMenu, { onDone: () => {} }), {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false, exitOnCtrlC: false,
    })
    const plain = () =>
      output
        .replace(/\x1b\[(\d+)C/g, (_, count: string) => ' '.repeat(Number(count)))
        .replace(/\x1b\][^\x07]*\x07/g, '')
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    const frame = () => plain().slice(plain().lastIndexOf('Usage'))
    try {
      await tick(150)
      await body(frame, stdin)
    } finally {
      app.unmount()
      await tick(20)
    }
  })
}

test('the throughput screen ranks measured responses and names the upstreams', async () => {
  await withMenu(
    [
      row({ output: 100, genMs: 2000, ttftMs: 500, totalMs: 2500, tokPerSec: 50 }),
      row({ output: 20, genMs: 4000, ttftMs: 900, totalMs: 4900, tokPerSec: 5, session: 'slow-chat' }),
    ],
    async (frame, stdin) => {
      stdin.write('6')
      await tick(250)
      const screen = frame()
      assert.match(screen, /Throughput/, 'the screen opened')
      assert.match(screen, /50\.0 tok\/s/, 'the fast response is reported at its own rate')
      assert.match(screen, /5\.0 tok\/s/, 'the slow response is reported at its own rate')
      assert.match(screen, /Slowest responses/)
      assert.match(screen, /Fastest responses/)
      assert.match(screen, /By upstream/)
      assert.match(screen, /measured/, 'the count of measured responses is stated')
    },
  )
})

test('a custom range is typed, applied, and narrows the report', async () => {
  const old = new Date()
  old.setDate(old.getDate() - 40)
  await withMenu(
    [
      row({ input: 1000 }),
      row({ at: old.toISOString(), input: 5000, session: 'old-chat' }),
    ],
    async (frame, stdin) => {
      stdin.write('7')
      await tick(250)
      assert.match(frame(), /Custom range/, 'the range screen opened')
      assert.match(frame(), /From/)
      assert.match(frame(), /To/)

      const today = new Date()
      const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
      stdin.write(day)
      await tick(80)
      stdin.write('\t')
      await tick(80)
      stdin.write(day)
      await tick(80)
      stdin.write('\r')
      await tick(250)

      const home = frame()
      assert.match(home, new RegExp(`Usage [\\u2014-] ${day} . ${day}`), 'the window is the typed range')
      assert.match(home, /1 requests/, 'the row outside the range is not counted')
      assert.ok(!home.includes('old-chat'), 'the excluded chat is gone from the window')
    },
  )
})

test('an empty ledger explains itself instead of drawing an empty chart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-menu-empty-'))
  const previousDir = process.env.GATEWAY_TOKEN_LEDGER_DIR
  process.env.GATEWAY_TOKEN_LEDGER_DIR = dir
  resetTokenLedgerForTests()
  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 40 })
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {},
  })
  let output = ''
  stdout.on('data', chunk => { output += chunk.toString() })
  const app = await render(React.createElement(UsageMenu, { onDone: () => {} }), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false, exitOnCtrlC: false,
  })
  try {
    await tick(150)
    const plain = output
      .replace(/\x1b\[(\d+)C/g, (_, count: string) => ' '.repeat(Number(count)))
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    assert.match(plain, /No usage has been recorded yet/)
    assert.ok(!plain.includes('█'), 'no bars are drawn from no data')
  } finally {
    app.unmount()
    if (previousDir === undefined) delete process.env.GATEWAY_TOKEN_LEDGER_DIR
    else process.env.GATEWAY_TOKEN_LEDGER_DIR = previousDir
    resetTokenLedgerForTests()
    await rm(dir, { recursive: true, force: true })
  }
})
