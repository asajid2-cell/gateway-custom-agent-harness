import React from 'react'
import { test, expect } from 'bun:test'
import { PassThrough } from 'node:stream'
import { render, Box, Text, useInput } from '../src/ink.ts'
import { BoundedMainScreen } from '../src/ink/components/BoundedMainScreen.tsx'
import instances from '../src/ink/instances.ts'
import { isBoundedLayoutEnabled } from '../src/utils/fullscreen.ts'
import { getIsInteractive, setIsInteractive } from '../src/bootstrap/state.ts'
import { hasSelection, startSelection } from '../src/ink/selection.ts'
import type { ParsedMouse } from '../src/ink/parse-keypress.ts'

// REAL-INSTANCE b2 verification (newtok, independent verifier). This is the
// strongest form of the (b2) gate: it renders a live Ink instance and calls
// the REAL private `handleInlineMouse` arrow on it - the very switch item 2
// changed - instead of a hand mirror. It therefore detects whether production
// actually finishes a dropped-release selection on mode-1003 no-button motion,
// which a mirrored harness cannot.
//
// Setup does not depend on a pointer target: the switch's `case 'hover'`
// path needs only `inlineOrigin`/`inlineTracking` set and a rendered
// frontFrame, so we seed the in-progress drag with the real `startSelection`
// (exactly what production's seedPressSelection does) and then feed the real
// handler the no-button motion.
//
// On base (no item 2) the button-35 branch clears the press and hovers WITHOUT
// finishing -> isDragging stays true -> RED. On the fix it finishes -> GREEN.

const LEFT = 0
const DRAG = 0x20
const NO_BUTTON_MOTION = 3 | DRAG // 35

function noButtonMotion(col: number, row: number): ParsedMouse {
  return { kind: 'mouse', button: NO_BUTTON_MOTION, action: 'press', col: col + 1, row: row + 1, sequence: '' }
}

function harness() {
  const stdout = Object.assign(new PassThrough(), { columns: 40, rows: 12, isTTY: true })
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
  return { stdout, stdin }
}

function InteractiveBody() {
  useInput(() => {})
  return (
    <BoundedMainScreen>
      <Box flexDirection="column" width="100%">
        <Text>row-0</Text>
        <Text>row-1</Text>
      </Box>
    </BoundedMainScreen>
  )
}

type RealInk = {
  selection: Parameters<typeof hasSelection>[0]
  inlineOrigin: number | null
  inlineTracking: boolean
  handleInlineMouse(mouse: ParsedMouse): boolean
}

test('real handleInlineMouse finishes a dropped-release selection on no-button motion (b2)', async () => {
  const savedGateway = process.env.CLAUDE_CODE_USE_GATEWAY
  const savedFlicker = process.env.CLAUDE_CODE_NO_FLICKER
  const savedInteractive = getIsInteractive()
  const savedStdinIsTTY = (process.stdin as { isTTY?: boolean } | undefined)?.isTTY
  process.env.CLAUDE_CODE_USE_GATEWAY = '1'
  process.env.CLAUDE_CODE_NO_FLICKER = '0'
  setIsInteractive(true)
  if (process.stdin) (process.stdin as { isTTY?: boolean }).isTTY = true
  const { stdout, stdin } = harness()
  const realStdout = process.stdout
  Object.defineProperty(process, 'stdout', { configurable: true, value: stdout })
  let app: Awaited<ReturnType<typeof render>> | undefined
  try {
    expect(isBoundedLayoutEnabled()).toBe(true)
    app = await render(<InteractiveBody />, {
      stdout: stdout as never, stderr: stdout as never, stdin: stdin as never,
      patchConsole: false, exitOnCtrlC: false,
    })
    await new Promise(r => setTimeout(r, 250))
    const ink = instances.get(stdout as never) as unknown as RealInk
    // The lane is armed (in production this is the CPR probe's verdict); the
    // switch's `origin === null || !tracking` guard would otherwise consume.
    ink.inlineOrigin = 0
    ink.inlineTracking = true

    // A drag is in progress: press landed on a pointer target and seeded the
    // selection (production: seedPressSelection -> startSelection).
    startSelection(ink.selection, 0, 0)
    expect(ink.selection.isDragging).toBe(true)
    expect(hasSelection(ink.selection)).toBe(false)

    // The release was dropped; mode-1003 no-button motion is the recovery.
    const consumed = ink.handleInlineMouse(noButtonMotion(2, 0))
    expect(consumed).toBe(true)
    expect(ink.selection.isDragging).toBe(false) // b2: the REAL switch finished it
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
