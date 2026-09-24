import React from 'react'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { PassThrough } from 'node:stream'
import { render, Box, Text } from '../src/ink.ts'
import { BoundedMainScreen } from '../src/ink/components/BoundedMainScreen.tsx'
import instances from '../src/ink/instances.ts'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Replay enough of a terminal to know what the user would SEE.
 *
 * The bounded lane's writer emits a small, fixed alphabet: printable text,
 * CR, LF, CSI H, CSI n B, CSI n C, CSI 2J, CSI 2K, and SGR/DEC-private
 * sequences that do not move cells. This implements exactly those. It is not
 * a general VT emulator — it is the subset this regression needs, kept small
 * so that a wrong model of the terminal cannot hide behind the parser.
 */
class ReplayScreen {
  rows: string[][]
  x = 0
  y = 0

  constructor(readonly columns: number, readonly height: number) {
    this.rows = Array.from({ length: height }, () => Array<string>(columns).fill(' '))
  }

  private scrollUp(): void {
    this.rows.shift()
    this.rows.push(Array<string>(this.columns).fill(' '))
  }

  private put(char: string): void {
    if (this.x >= this.columns) {
      this.x = 0
      this.y++
      if (this.y >= this.height) {
        this.scrollUp()
        this.y = this.height - 1
      }
    }
    this.rows[this.y]![this.x] = char
    this.x++
  }

  feed(data: string): void {
    for (let i = 0; i < data.length; i++) {
      const ch = data[i]!
      if (ch === '\x1b') {
        const match = /^\x1b\[(\??)(\d*)(?:;(\d+))?([A-Za-z@])/.exec(data.slice(i))
        assert.ok(match, `replay does not understand escape at index ${i}`)
        const [whole, priv, first, , final] = match
        const n = first === '' ? 1 : Number(first)
        if (priv !== '?') {
          if (final === 'H') {
            this.x = 0
            this.y = 0
          } else if (final === 'B') {
            this.y = Math.min(this.height - 1, this.y + n)
          } else if (final === 'C') {
            this.x = Math.min(this.columns, this.x + n)
          } else if (final === 'J' && n === 2) {
            this.rows = Array.from({ length: this.height }, () => Array<string>(this.columns).fill(' '))
          } else if (final === 'K' && n === 2) {
            this.rows[this.y] = Array<string>(this.columns).fill(' ')
          } else if (final !== 'm') {
            throw new Error(`replay does not implement CSI ${first}${final}`)
          }
        }
        i += whole.length - 1
        continue
      }
      if (ch === '\r') { this.x = 0; continue }
      if (ch === '\n') {
        this.y++
        if (this.y >= this.height) { this.scrollUp(); this.y = this.height - 1 }
        continue
      }
      this.put(ch)
    }
  }

  visible(): string[] {
    return this.rows.map(row => row.join('').replace(/\s+$/, ''))
  }
}

const COLUMNS = 40
const ROWS = 8
// A marker no frame ever draws, so any survivor is provably stale terminal
// content rather than something the app wrote.
const STALE = 'PREVIOUS-SCREEN-CONTENT'

function seedPreviousScreen(screen: ReplayScreen): void {
  for (let y = 0; y < ROWS; y++) {
    screen.feed(`${STALE}-${y}`.padEnd(COLUMNS, '#') + '\r\n')
  }
}

function harness() {
  const stdout = Object.assign(new PassThrough(), { columns: COLUMNS, rows: ROWS, isTTY: true })
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
  let raw = ''
  stdout.on('data', (chunk: Buffer) => { raw += chunk.toString() })
  return { stdout, stdin, take: () => { const seen = raw; raw = ''; return seen } }
}

function Body({ lines }: { lines: number }) {
  return (
    <BoundedMainScreen>
      <Box flexDirection="column" width="100%">
        {Array.from({ length: lines }, (_, i) => <Text key={i}>{`row-${i}`}</Text>)}
      </Box>
    </BoundedMainScreen>
  )
}

test('the inline bounded block owns its rows on the first frame', async () => {
  const { stdout, stdin, take } = harness()
  const screen = new ReplayScreen(COLUMNS, ROWS)
  seedPreviousScreen(screen)

  const realStdout = process.stdout
  Object.defineProperty(process, 'stdout', { configurable: true, value: stdout })
  let app: Awaited<ReturnType<typeof render>> | undefined
  try {
    app = await render(<Body lines={3} />, {
      stdout: stdout as any, stderr: stdout as any, stdin: stdin as any,
      patchConsole: false, exitOnCtrlC: false,
    })
    await sleep(300)
    screen.feed(take())
    const visible = screen.visible()
    assert.deepEqual(visible.slice(0, 3), ['row-0', 'row-1', 'row-2'])
    // The block is the whole viewport: rows it leaves blank must be blank,
    // not the previous screen showing through the gaps.
    assert.ok(
      visible.every(row => !row.includes(STALE)),
      `previous screen survived inside the block:\n${visible.join('\n')}`,
    )
  } finally {
    app?.unmount()
    stdin.destroy()
    stdout.destroy()
    Object.defineProperty(process, 'stdout', { configurable: true, value: realStdout })
  }
})

test('a repaint repaints opaquely, as a leaf handoff and a resume require', async () => {
  const { stdout, stdin, take } = harness()
  const screen = new ReplayScreen(COLUMNS, ROWS)

  const realStdout = process.stdout
  Object.defineProperty(process, 'stdout', { configurable: true, value: stdout })
  let app: Awaited<ReturnType<typeof render>> | undefined
  try {
    app = await render(<Body lines={3} />, {
      stdout: stdout as any, stderr: stdout as any, stdin: stdin as any,
      patchConsole: false, exitOnCtrlC: false,
    })
    await sleep(300)
    take()

    // What returning from a leaf, resuming a session, or switching layout
    // mode does: the model forgets the screen while the terminal keeps it.
    seedPreviousScreen(screen)
    // exitAlternateScreen() on an inline root, which is what returning from
    // a leaf does, is repaint() then resume(); repaint() alone only resets
    // state and renders nothing.
    const ink = instances.get(stdout as any) as unknown as { repaint(): void; resume(): void }
    ink.repaint()
    ink.resume()
    await sleep(300)
    screen.feed(take())

    const visible = screen.visible()
    assert.deepEqual(visible.slice(0, 3), ['row-0', 'row-1', 'row-2'])
    assert.ok(
      visible.every(row => !row.includes(STALE)),
      `previous screen survived the repaint:\n${visible.join('\n')}`,
    )
  } finally {
    app?.unmount()
    stdin.destroy()
    stdout.destroy()
    Object.defineProperty(process, 'stdout', { configurable: true, value: realStdout })
  }
})

test('starting a selection does not erase the inline block', async () => {
  const { stdout, stdin, take } = harness()
  const screen = new ReplayScreen(COLUMNS, ROWS)

  const realStdout = process.stdout
  Object.defineProperty(process, 'stdout', { configurable: true, value: stdout })
  let app: Awaited<ReturnType<typeof render>> | undefined
  try {
    app = await render(<Body lines={3} />, {
      stdout: stdout as any, stderr: stdout as any, stdin: stdin as any,
      patchConsole: false, exitOnCtrlC: false,
    })
    await sleep(300)
    screen.feed(take())
    assert.deepEqual(screen.visible().slice(0, 3), ['row-0', 'row-1', 'row-2'])

    // A selection is a per-frame full-damage condition, not a
    // terminal-content invalidation: the overlay only restyles cells, so the
    // frame that carries it must still be a diff. Erasing here would clear
    // the block and repaint only the selected cells, i.e. a black screen.
    const ink = instances.get(stdout as any) as unknown as {
      seedPressSelection(col: number, row: number): void
      handleSelectionDrag(col: number, row: number): void
      hasTextSelection(): boolean
    }
    ink.seedPressSelection(0, 0)
    ink.handleSelectionDrag(3, 1)
    await sleep(300)
    // A drag renders on every motion event, so the frame after the first
    // selected one is where the bug showed: the per-frame flag is only set
    // at the END of a frame, so the second selected frame is the first one
    // that could see it. Extend the selection and let it render.
    ink.handleSelectionDrag(6, 2)
    await sleep(300)
    const stream = take()
    // The selection must still be live and rendered - "nothing erased it"
    // would be a hollow pass if the selection had simply been dropped.
    assert.ok(ink.hasTextSelection(), 'the selection was dropped instead of rendered')
    assert.ok(
      !stream.includes('\x1b[2J'),
      `selection frame erased the block: ${JSON.stringify(stream)}`,
    )
    screen.feed(stream)
    assert.deepEqual(screen.visible().slice(0, 3), ['row-0', 'row-1', 'row-2'])
  } finally {
    app?.unmount()
    stdin.destroy()
    stdout.destroy()
    Object.defineProperty(process, 'stdout', { configurable: true, value: realStdout })
  }
})
