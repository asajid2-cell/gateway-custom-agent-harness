import React from 'react'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { PassThrough } from 'node:stream'
import { render, Box, Text, useInput } from '../src/ink.ts'
import { BoundedMainScreen } from '../src/ink/components/BoundedMainScreen.tsx'
import instances from '../src/ink/instances.ts'
import { cellAt, type Screen } from '../src/ink/screen.ts'
import PromptInput from '../src/components/PromptInput/PromptInput.tsx'
import { FullscreenLayout } from '../src/components/FullscreenLayout.tsx'
import { isBoundedLayoutEnabled } from '../src/utils/fullscreen.ts'
import { AppStateProvider, getDefaultAppState } from '../src/state/AppState.tsx'
import { getIsInteractive, setIsInteractive } from '../src/bootstrap/state.ts'

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

  constructor(readonly columns: number, public height: number) {
    this.rows = Array.from({ length: height }, () => Array<string>(columns).fill(' '))
  }

  /**
   * The terminal changing size under the app, which is the one transition that
   * both invalidates the layout and moves every row the block was drawn on.
   * Growing keeps what was on screen below the old rows; shrinking takes those
   * rows away. Both are modelled here, so a frame that assumes the terminal
   * held still after a resize shows up as wrong cells rather than as nothing.
   */
  resizeTo(height: number): void {
    if (height > this.height) {
      for (let y = this.height; y < height; y++) this.rows.push(Array<string>(this.columns).fill(' '))
    } else {
      this.rows.length = height
    }
    this.height = height
    this.y = Math.min(this.y, height - 1)
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
          } else if (final === 'J' && n === 3) {
            // Erase scrollback, which the resize path sends with its full
            // reset. Nothing above the viewport is modelled, so this is the
            // one erasure that changes no visible cell.
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

// The inline mouse probe only arms once a component has taken raw mode
// (`App.rawModeEnabledCount > 0`), which `useInput` is what a real REPL does.
function InteractiveBody() {
  useInput(() => {})
  return <Body lines={3} />
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

test('a terminal resize redraws the block where it now belongs', async () => {
  const { stdout, stdin, take } = harness()
  const screen = new ReplayScreen(COLUMNS, ROWS)
  seedPreviousScreen(screen)

  const realStdout = process.stdout
  Object.defineProperty(process, 'stdout', { configurable: true, value: stdout })
  let app: Awaited<ReturnType<typeof render>> | undefined
  // The terminal resizes first and the app is told second, which is the order
  // a real SIGWINCH arrives in.
  const resize = async (rows: number) => {
    screen.resizeTo(rows)
    stdout.rows = rows
    stdout.emit('resize')
    await sleep(300)
    screen.feed(take())
  }
  // `from` is where the visible window starts: a block that cannot keep all
  // its rows keeps the newest ones, so the oldest row is the one that goes.
  const exact = (rows: string[], count: number, from = 0) => {
    assert.deepEqual(rows.slice(0, count), Array.from({ length: count }, (_, i) => `row-${i + from}`))
    assert.ok(
      rows.every(row => !row.includes(STALE)),
      `previous screen survived the resize:\n${rows.join('\n')}`,
    )
  }
  try {
    app = await render(<Body lines={6} />, {
      stdout: stdout as any, stderr: stdout as any, stdin: stdin as any,
      patchConsole: false, exitOnCtrlC: false,
    })
    await sleep(300)
    screen.feed(take())
    exact(screen.visible(), 6)

    // Taller than the frame that was laid out: the block keeps its rows and the
    // rows it no longer needs are blank, not whatever the screen held before.
    await resize(12)
    exact(screen.visible(), 6)

    // Shorter than the content wants. The block has to drop a row rather than
    // let the terminal scroll, because a scroll moves every row the app
    // believes it owns - which is how a prompt ends up painted mid-screen.
    // The row it drops is the oldest: the window below the transcript behaves
    // as the transcript's ScrollBox does, anchored to the newest content.
    await resize(5)
    exact(screen.visible(), 5, 1)

    // And back, so the row that was clipped comes back where it was.
    await resize(8)
    exact(screen.visible(), 6)
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

/**
 * The frame as rows of text, which is what the terminal would show. The yoga
 * tree alone cannot answer "did the user see it": a squashed or clipped node
 * is still in the tree, just never inked.
 */
function frameRows(stdout: PassThrough): string[] {
  const screen = (instances.get(stdout as any) as unknown as { frontFrame: { screen: Screen } }).frontFrame.screen
  const rows: string[] = []
  for (let y = 0; y < screen.height; y++) {
    let row = ''
    for (let x = 0; x < screen.width; x++) row += cellAt(screen, x, y)?.char ?? ' '
    rows.push(row.replace(/\s+$/, ''))
  }
  return rows
}

test('the prompt row survives a terminal shorter than the chrome', async () => {
  // The bounded chrome (FullscreenLayout's bottom block) is taller than a
  // short terminal is willing to give it, and what gives way has to be the
  // footer hints - never the row the user types into or its border. A
  // shrinkable prompt squashed its own content row to nothing and painted its
  // two borders back to back, which is how the input line went missing.
  const savedGateway = process.env.CLAUDE_CODE_USE_GATEWAY
  const savedFlicker = process.env.CLAUDE_CODE_NO_FLICKER
  const savedInteractive = getIsInteractive()
  const savedStdinIsTTY = (process.stdin as { isTTY?: boolean } | undefined)?.isTTY
  process.env.CLAUDE_CODE_USE_GATEWAY = '1'
  process.env.CLAUDE_CODE_NO_FLICKER = '0'
  setIsInteractive(true)
  // The lane gate reads the real process.stdin, not the harness's fake one:
  // a gateway session with both TTYs is the inline lane the user runs.
  if (process.stdin) (process.stdin as { isTTY?: boolean }).isTTY = true
  const stdout = Object.assign(new PassThrough(), { columns: 60, rows: 24, isTTY: true })
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
  const realStdout = process.stdout
  Object.defineProperty(process, 'stdout', { configurable: true, value: stdout })
  let app: Awaited<ReturnType<typeof render>> | undefined
  const noop = () => {}
  const state = getDefaultAppState()
  const MARKER = 'PROMPT-ROW-MARKER'
  // The real layout, not a replica of it: the chrome container that decides
  // how a short terminal is divided lives in FullscreenLayout, so a replica
  // would keep passing after the real one changed - which is exactly what
  // this test exists to catch.
  function Chrome() {
    return (
      <AppStateProvider>
        <BoundedMainScreen>
          <FullscreenLayout
            scrollable={
              <Box flexDirection="column" width="100%">
                {Array.from({ length: 16 }, (_, i) => <Text key={i}>{`row-${i}`}</Text>)}
              </Box>
            }
            bottom={
              <Box flexDirection="row" width="100%" alignItems="flex-end">
                <Box flexDirection="column" flexGrow={1}>
                  <PromptInput {...{
                    debug: false, ideSelection: undefined, toolPermissionContext: state.toolPermissionContext, setToolPermissionContext: noop,
                    apiKeyStatus: 'valid', commands: [], agents: [], isLoading: false, verbose: false, messages: [], onAutoUpdaterResult: noop, autoUpdaterResult: null,
                    input: MARKER, onInputChange: noop, mode: 'prompt', onModeChange: noop, stashedPrompt: undefined, setStashedPrompt: noop, submitCount: 0,
                    onShowMessageSelector: noop, mcpClients: [], pastedContents: {}, setPastedContents: noop, vimMode: 'INSERT', setVimMode: noop,
                    showBashesDialog: false, setShowBashesDialog: noop, onExit: noop, getToolUseContext: () => ({}), onSubmit: async () => {},
                    isSearchingHistory: false, setIsSearchingHistory: noop, helpOpen: false, setHelpOpen: noop,
                  } as any} />
                </Box>
              </Box>
            }
          />
        </BoundedMainScreen>
      </AppStateProvider>
    )
  }
  const promptRow = () => {
    const rows = frameRows(stdout)
    return { rows, index: rows.findIndex(row => row.includes(MARKER)) }
  }
  const isBorderRow = (row: string) => row.length > 0 && /^─+$/.test(row)
  try {
    // Without the bounded lane, FullscreenLayout renders the plain inline
    // branch and the prompt could never be squashed: the test would pass
    // without exercising the code it is about.
    assert.ok(isBoundedLayoutEnabled(), 'the test must exercise the bounded lane')
    app = await render(<Chrome />, {
      stdout: stdout as any, stderr: stdout as any, stdin: stdin as any,
      patchConsole: false, exitOnCtrlC: false,
    })
    await sleep(400)
    const tall = promptRow()
    assert.ok(tall.index >= 0, `prompt row missing at 24 rows:\n${tall.rows.join('\n')}`)

    // Each of these is a height at which the chrome used to squash: below 14
    // rows the clamp bites, and the smaller the terminal the more it bit.
    for (const rows of [14, 12, 10, 8]) {
      stdout.rows = rows
      stdout.emit('resize')
      await sleep(300)
      const short = promptRow()
      assert.ok(short.index >= 0, `prompt row vanished at ${rows} rows:\n${short.rows.join('\n')}`)
      assert.ok(
        /^[>❯]/.test(short.rows[short.index]!.trimStart()),
        `prompt row lost its arrow at ${rows} rows: "${short.rows[short.index]}"`,
      )
      assert.ok(
        isBorderRow(short.rows[short.index - 1] ?? ''),
        `the border above the prompt is gone at ${rows} rows:\n${short.rows.join('\n')}`,
      )
    }
  } finally {
    app?.unmount()
    stdin.destroy()
    stdout.destroy()
    Object.defineProperty(process, 'stdout', { configurable: true, value: realStdout })
    if (savedGateway === undefined) delete process.env.CLAUDE_CODE_USE_GATEWAY
    else process.env.CLAUDE_CODE_USE_GATEWAY = savedGateway
    if (savedFlicker === undefined) delete process.env.CLAUDE_CODE_NO_FLICKER
    else process.env.CLAUDE_CODE_NO_FLICKER = savedFlicker
    if (process.stdin) (process.stdin as { isTTY?: boolean }).isTTY = savedStdinIsTTY
    setIsInteractive(savedInteractive)
  }
})

test('the prompt survives a block above it taller than the terminal', async () => {
  // The other way the prompt leaves the screen: not a short terminal, but a
  // tall block in the same column - an expanded task list, a queued-commands
  // panel, a dialog. The block is above the prompt in REPL's `bottom`, so if
  // the chrome is allowed to take its natural height the prompt is pushed
  // past the last row and the user is left with a screen of tasks and no
  // input line. Worse on the main screen: content past the viewport scrolls
  // the terminal, which moves every row the app believes it owns.
  const savedGateway = process.env.CLAUDE_CODE_USE_GATEWAY
  const savedFlicker = process.env.CLAUDE_CODE_NO_FLICKER
  const savedInteractive = getIsInteractive()
  const savedStdinIsTTY = (process.stdin as { isTTY?: boolean } | undefined)?.isTTY
  process.env.CLAUDE_CODE_USE_GATEWAY = '1'
  process.env.CLAUDE_CODE_NO_FLICKER = '0'
  setIsInteractive(true)
  if (process.stdin) (process.stdin as { isTTY?: boolean }).isTTY = true
  const stdout = Object.assign(new PassThrough(), { columns: 60, rows: 24, isTTY: true })
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
  const realStdout = process.stdout
  Object.defineProperty(process, 'stdout', { configurable: true, value: stdout })
  let app: Awaited<ReturnType<typeof render>> | undefined
  const MARKER = 'PROMPT-ROW-MARKER'
  const TALL = 40
  function Chrome() {
    return (
      <AppStateProvider>
        <BoundedMainScreen>
          <FullscreenLayout
            scrollable={
              <Box flexDirection="column" width="100%">
                {Array.from({ length: 16 }, (_, i) => <Text key={i}>{`row-${i}`}</Text>)}
              </Box>
            }
            bottom={
              <Box flexDirection="row" width="100%" alignItems="flex-end">
                <Box flexDirection="column" flexGrow={1}>
                  <Box flexDirection="column" width="100%">
                    {Array.from({ length: TALL }, (_, i) => <Text key={i}>{`task-${i}`}</Text>)}
                  </Box>
                  <Box flexDirection="column" flexShrink={0}>
                    <Text>{'─'.repeat(8)}</Text>
                    <Text>{`❯ ${MARKER}`}</Text>
                  </Box>
                </Box>
              </Box>
            }
          />
        </BoundedMainScreen>
      </AppStateProvider>
    )
  }
  try {
    assert.ok(isBoundedLayoutEnabled(), 'the test must exercise the bounded lane')
    app = await render(<Chrome />, {
      stdout: stdout as any, stderr: stdout as any, stdin: stdin as any,
      patchConsole: false, exitOnCtrlC: false,
    })
    await sleep(400)
    const rows = frameRows(stdout)
    const index = rows.findIndex(row => row.includes(MARKER))
    assert.ok(
      index >= 0,
      `the prompt was pushed off screen by the block above it:\n${rows.join('\n')}`,
    )
    assert.ok(/^❯/.test(rows[index]!.trimStart()), `the prompt row lost its arrow: "${rows[index]}"`)
    // No terminal scroll: the app must fit the viewport it was given, or the
    // rows it believes it owns move under it.
    const yogaHeight = (instances.get(stdout as any) as unknown as {
      rootNode: { yogaNode: { getComputedHeight(): number } }
    }).rootNode.yogaNode.getComputedHeight()
    assert.ok(yogaHeight <= 24, `the frame is ${yogaHeight} rows tall in a 24-row terminal`)
  } finally {
    app?.unmount()
    stdin.destroy()
    stdout.destroy()
    Object.defineProperty(process, 'stdout', { configurable: true, value: realStdout })
    if (savedGateway === undefined) delete process.env.CLAUDE_CODE_USE_GATEWAY
    else process.env.CLAUDE_CODE_USE_GATEWAY = savedGateway
    if (savedFlicker === undefined) delete process.env.CLAUDE_CODE_NO_FLICKER
    else process.env.CLAUDE_CODE_NO_FLICKER = savedFlicker
    if (process.stdin) (process.stdin as { isTTY?: boolean }).isTTY = savedStdinIsTTY
    setIsInteractive(savedInteractive)
  }
})

test('a timed-out inline mouse probe re-probes after the backoff, so a late attach self-heals', async () => {
  // A relay/mux client sends no host resize on a same-size attach, so the
  // alt-screen exit and the size-changing frame that used to be the only
  // clears for a failed probe may never arrive. The probe must therefore
  // retry on its own: the first reply after a client attaches then arms the
  // wheel with no resize. Nothing answers here, so the retry is the only
  // signal, and any second probe on the wire is proof it fired.
  const savedGateway = process.env.CLAUDE_CODE_USE_GATEWAY
  const savedFlicker = process.env.CLAUDE_CODE_NO_FLICKER
  const savedInteractive = getIsInteractive()
  const savedStdinIsTTY = (process.stdin as { isTTY?: boolean } | undefined)?.isTTY
  process.env.CLAUDE_CODE_USE_GATEWAY = '1'
  process.env.CLAUDE_CODE_NO_FLICKER = '0'
  setIsInteractive(true)
  if (process.stdin) (process.stdin as { isTTY?: boolean }).isTTY = true
  const { stdout, stdin, take } = harness()
  const realStdout = process.stdout
  Object.defineProperty(process, 'stdout', { configurable: true, value: stdout })
  let app: Awaited<ReturnType<typeof render>> | undefined
  // The private DECXCPR the probe writes; the harness never replies, so each
  // occurrence is one probe that will time out.
  const PROBE = '\x1b[?6n'
  const countProbes = (s: string) => s.split(PROBE).length - 1
  let seen = 0
  try {
    assert.ok(isBoundedLayoutEnabled(), 'the test must exercise the bounded lane')
    app = await render(<InteractiveBody />, {
      stdout: stdout as any, stderr: stdout as any, stdin: stdin as any,
      patchConsole: false, exitOnCtrlC: false,
    })
    // Let useInput's effect take raw mode, then force one frame so the probe
    // is sent now rather than whenever the next render happens to land.
    await sleep(200)
    ;(instances.get(stdout as any) as unknown as { resume(): void }).resume()
    // Past the first 1s timeout: one probe has gone out and the latch is set.
    await sleep(1200)
    seen += countProbes(take())
    assert.ok(seen >= 1, 'the first probe never went out, so the test proves nothing')
    // Past the backoff (1s timeout + 2s retry) with no resize and no
    // alt-screen exit: a second probe must have sent itself.
    await sleep(2600)
    seen += countProbes(take())
    assert.ok(
      seen >= 2,
      `the probe did not retry after the backoff (saw ${seen}), so a late attach would stay latched`,
    )
  } finally {
    app?.unmount()
    stdin.destroy()
    stdout.destroy()
    Object.defineProperty(process, 'stdout', { configurable: true, value: realStdout })
    if (savedGateway === undefined) delete process.env.CLAUDE_CODE_USE_GATEWAY
    else process.env.CLAUDE_CODE_USE_GATEWAY = savedGateway
    if (savedFlicker === undefined) delete process.env.CLAUDE_CODE_NO_FLICKER
    else process.env.CLAUDE_CODE_NO_FLICKER = savedFlicker
    if (process.stdin) (process.stdin as { isTTY?: boolean }).isTTY = savedStdinIsTTY
    setIsInteractive(savedInteractive)
  }
})
