import React from 'react'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { render, Box } from '../src/ink.ts'
import instances from '../src/ink/instances.ts'
import { ModelPicker } from '../src/components/ModelPicker.tsx'
import { AppStateProvider } from '../src/state/AppState.tsx'
import { KeybindingSetup } from '../src/keybindings/KeybindingProviderSetup.tsx'
import {
  gatewayModelOrderPath,
  readGatewayModelOrder,
} from '../src/utils/model/gatewayModelOrder.ts'

/**
 * The picker's `t` (move to top) and `r` (lift, then arrows to place) keys,
 * driven through the real keybinding dispatch rather than asserted from
 * source. The interesting half is the dispatch: Select registers its own
 * up/down/escape handlers before the picker's, so the picker only receives
 * those keys while it has asked Select to stand down. A source-level check
 * cannot tell whether that plumbing actually reaches the handlers.
 */

const CATALOG = JSON.stringify([
  { value: 'gateway-gpt-luna', label: 'GPT Luna', description: 'Gateway' },
  { value: 'gateway-ds-flash', label: 'DeepSeek Flash', description: 'Gateway' },
  { value: 'gateway-ds-pro', label: 'DeepSeek Pro', description: 'Gateway' },
  { value: 'gateway-gpt-terra', label: 'GPT Terra', description: 'Gateway' },
])
const LABELS = ['GPT Luna', 'DeepSeek Flash', 'DeepSeek Pro', 'GPT Terra']
const DOWN = '\x1b[B'
const UP = '\x1b[A'
const ESCAPE = '\x1b'

function textOf(node: any): string {
  return node.nodeName === '#text'
    ? node.nodeValue
    : (node.childNodes ?? []).map(textOf).join('')
}

/** The rows the picker is drawing, in the order they are drawn. */
function visibleOrder(root: any): string[] {
  const screen = textOf(root)
  return LABELS.filter(label => screen.includes(label)).sort(
    (left, right) => screen.indexOf(left) - screen.indexOf(right),
  )
}

/** The row Select is drawing the cursor on. */
function focusedRow(root: any): string | undefined {
  const marked = textOf(root).split('❯')[1]
  if (marked === undefined) return undefined
  return LABELS.find(label => marked.includes(label))
}

const settle = (ms = 80) => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(what: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000
  while (!predicate() && Date.now() < deadline) await settle(25)
  assert.ok(predicate(), `timed out waiting for ${what}`)
}

async function waitForValue<T>(
  what: string,
  read: () => Promise<T>,
  done: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + 3000
  let value = await read()
  while (!done(value) && Date.now() < deadline) {
    await settle(25)
    value = await read()
  }
  assert.ok(done(value), `timed out waiting for ${what}: got ${JSON.stringify(value)}`)
  return value
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

type Picker = {
  text: () => string
  order: () => string[]
  focused: () => string | undefined
  press: (keys: string) => Promise<void>
  cancelled: () => boolean
  storedOrder: () => Promise<string[]>
}

/**
 * The picker reads its catalog and writes its order file through the process
 * environment and the home directory, so two pickers open at once would see
 * each other's values. Whatever a test does with one runs alone.
 */
let pickerQueue: Promise<unknown> = Promise.resolve()

function withPicker(
  run: (picker: Picker) => Promise<void>,
  seed: string[] = [],
): Promise<void> {
  const next = pickerQueue.then(
    () => openPicker(run, seed),
    () => openPicker(run, seed),
  )
  pickerQueue = next.then(
    () => {},
    () => {},
  )
  return next
}

async function openPicker(
  run: (picker: Picker) => Promise<void>,
  seed: string[],
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'model-picker-reorder-'))

  const saved = {
    USERPROFILE: process.env.USERPROFILE,
    HOME: process.env.HOME,
    CLAUDE_CODE_USE_GATEWAY: process.env.CLAUDE_CODE_USE_GATEWAY,
    MODEL_GATEWAY_MODEL_OPTIONS: process.env.MODEL_GATEWAY_MODEL_OPTIONS,
  }
  process.env.USERPROFILE = home
  process.env.HOME = home
  process.env.CLAUDE_CODE_USE_GATEWAY = '1'
  process.env.MODEL_GATEWAY_MODEL_OPTIONS = CATALOG

  // A stored order is what a previous session left, so seeding the file before
  // the picker mounts is how the "restore" path sees one at all.
  if (seed.length > 0) {
    await mkdir(join(home, '.claude'), { recursive: true })
    await writeFile(gatewayModelOrderPath(), `${JSON.stringify(seed)}\n`)
  }

  const stdout = Object.assign(new PassThrough(), {
    columns: 100,
    rows: 30,
    isTTY: true,
  })
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode() {},
    ref() {},
    unref() {},
  })
  stdout.resume()

  let cancelled = false
  const app = await render(
    <AppStateProvider>
      <KeybindingSetup>
        <Box flexDirection="column">
          <ModelPicker
            initial={null}
            isStandaloneCommand
            onSelect={() => {}}
            onCancel={() => {
              cancelled = true
            }}
          />
        </Box>
      </KeybindingSetup>
    </AppStateProvider>,
    {
      stdout: stdout as any,
      stderr: stdout as any,
      stdin: stdin as any,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  )

  try {
    await settle(250)
    const ink = instances.get(stdout as any) as any
    await run({
      text: () => textOf(ink.rootNode),
      order: () => visibleOrder(ink.rootNode),
      focused: () => focusedRow(ink.rootNode),
      press: async (keys: string) => {
        stdin.write(keys)
        await settle()
      },
      cancelled: () => cancelled,
      storedOrder: () => readGatewayModelOrder(),
    })
  } finally {
    app.unmount()
    stdin.destroy()
    stdout.destroy()
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(home, { recursive: true, force: true })
  }
}

test('t sends the focused row to the top and saves that order', { timeout: 20000 }, async () => {
  await withPicker(async ({ text, order, press, storedOrder }) => {
    assert.deepEqual(order(), LABELS, 'the picker starts on the catalog order')
    // The hints are a Byline, so each one has to reach it as its own child for
    // the middot separators to appear between them rather than the words running
    // together into one unreadable line.
    await waitFor('the footer hints to be separated', () =>
      text().includes(
        'Enter to confirm · f to new-session default · t to move to top · r to reorder · Esc to exit',
      ),
    )
    await press(DOWN)
    await press(DOWN)
    await press('t')
    await waitFor('the focused row to reach the top', () => order()[0] === 'DeepSeek Pro')
    assert.deepEqual(order(), [
      'DeepSeek Pro',
      'GPT Luna',
      'DeepSeek Flash',
      'GPT Terra',
    ])
    // Re-sorting the list must not swallow the message that says what happened.
    // The notice follows the write, so it also stands as "this is on disk now".
    await waitFor('the move notice', () =>
      text().includes('Moved DeepSeek Pro to the top.'),
    )
    // The file is what the next launch reads, so it has to match the screen.
    assert.deepEqual(
      await waitForValue('the saved order', storedOrder, value => value.length === 4),
      [
        'gateway-ds-pro',
        'gateway-gpt-luna',
        'gateway-ds-flash',
        'gateway-gpt-terra',
      ],
    )
  })
})

test('r lifts the focused row so the arrows place it one slot at a time', { timeout: 20000 }, async () => {
  await withPicker(async ({ text, order, focused, press, storedOrder }) => {
    await press('r')
    await waitFor('the lift notice', () => text().includes('Reordering GPT Luna'))
    // While a row is lifted the footer swaps in the placing hints, separated the
    // same way.
    await waitFor('the placing hints to be separated', () =>
      text().includes('Enter to confirm · ↑↓ to place · r to drop · Esc to cancel'),
    )
    await press(DOWN)
    await waitFor('the row to move down one slot', () => order()[0] === 'DeepSeek Flash')
    // The cursor has to ride the row being placed, not stay where that row
    // used to be, or the arrows would feel like they are moving another model.
    assert.equal(focused(), 'GPT Luna', 'the cursor stays on the lifted row')
    await press(DOWN)
    await waitFor('the row to move down again', () => order()[2] === 'GPT Luna')
    assert.deepEqual(order(), [
      'DeepSeek Flash',
      'DeepSeek Pro',
      'GPT Luna',
      'GPT Terra',
    ])
    await press('r')
    await waitFor('the drop notice', () => text().includes('Order saved.'))
    assert.deepEqual(
      await waitForValue('the saved order', storedOrder, value => value.length === 4),
      [
        'gateway-ds-flash',
        'gateway-ds-pro',
        'gateway-gpt-luna',
        'gateway-gpt-terra',
      ],
    )
  })
})

test('escape during a lift restores the order instead of closing the picker', { timeout: 20000 }, async () => {
  // A stored order from a previous session, so the restore has something of its
  // own to go back to: cancelling must not wipe an order it never moved.
  const seed = ['gateway-ds-flash']
  const seeded = ['DeepSeek Flash', 'GPT Luna', 'DeepSeek Pro', 'GPT Terra']
  await withPicker(
    async ({ text, order, focused, press, cancelled, storedOrder }) => {
      assert.deepEqual(order(), seeded)

      await press('r')
      const liftedRow = focused()
      assert.ok(liftedRow, 'a row must be focused for the lift')
      assert.ok(
        text().includes(`Reordering ${liftedRow}`),
        `the lift notice must name the lifted row; screen=${JSON.stringify(text())}`,
      )
      // Place it with whichever arrow can actually move it.
      const from = order().indexOf(liftedRow)
      await press(from === order().length - 1 ? UP : DOWN)
      await waitFor(
        'the lifted row to keep the cursor while it moves',
        () => focused() === liftedRow && order().join() !== seeded.join(),
      )
      await waitForValue(
        'the moved order to be saved',
        storedOrder,
        value => value.length === 4,
      )

      await press(ESCAPE)
      await waitFor('the seeded order to be restored', () => order().join() === seeded.join())
      // The cancel notice follows the write, so waiting for it also confirms the
      // lift's moves were undone on disk rather than only on screen.
      await waitFor('the cancel notice', () => text().includes('Reorder cancelled.'))
      assert.deepEqual(
        await waitForValue('the restored order', storedOrder, value => value.length === 1),
        seed,
      )
      assert.equal(cancelled(), false, 'escape belonged to the lift, not the dialog')
    },
    seed,
  )
})

test('escape with nothing lifted still closes the picker and writes no order', { timeout: 20000 }, async () => {
  await withPicker(async ({ press, cancelled }) => {
    await press(ESCAPE)
    await waitFor('the picker to cancel', cancelled)
    assert.equal(
      await fileExists(gatewayModelOrderPath()),
      false,
      'leaving the picker must not write an order',
    )
  })
})
