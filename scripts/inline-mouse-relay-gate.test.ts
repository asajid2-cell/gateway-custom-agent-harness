import { test, expect, beforeEach, afterEach } from 'bun:test'
import { handleMouseEvent } from '../src/ink/components/App.tsx'
import { isInlineMouseOwned } from '../src/utils/fullscreen.ts'
import { setIsInteractive } from '../src/bootstrap/state.ts'
import {
  INITIAL_STATE,
  expectStandardCursorPosition,
  parseMultipleKeypresses,
} from '../src/ink/parse-keypress.ts'
import {
  createSelectionState,
  finishSelection,
  hasSelection,
  startSelection,
  updateSelection,
} from '../src/ink/selection.ts'
import type { SelectionState } from '../src/ink/selection.ts'
import type { ParsedMouse, TerminalResponse } from '../src/ink/parse-keypress.ts'
import type { InlineMouseState, InlinePress } from '../src/ink/ink.tsx'

// ITEM 2: the inline (main-screen) mouse lane OWNS the mouse on both the local
// terminal and the mux/relay path. The CPR-probe reply FORM (Option B — a mux
// client strips the plain DSR reply and lets only the DEC-private one through,
// while native ConPTY answers the plain form and ignores the private one; see
// scripts/leaf-pointer-terminal.py --mux-report-filter) still tells us which
// topology we are in, but it no longer decides ownership.
//
// The re-root: yielding the mouse to a mux client left the bottom-bar controls
// dead — the lane armed nothing, the client kept the mouse for native
// selection, and CC never saw the click (proven by
// `--probe-inline-ownership --mux-report-filter`, which fails on the yield
// build). The app supplies both itself — a virtual ScrollBox for scroll and
// its own app-painted selection for select/copy — so the lane owns the mouse
// everywhere and the client forwards the pointer. Thus a relay session DOES
// own the inline mouse; the reply form is informational only.
//
// The harness shape matches the co-verification file
// (gateway-mouse-verify/scripts/app-mouse-seam-coverify.test.ts): every event
// is routed through the REAL exported handleMouseEvent with an `onInlineMouse`
// handler wired, ONE shared selection, ink-first dispatch order. The inline
// handler here is NOT a hand mirror — it is the REAL decideInlineMouse() the
// fix extracted from ink.tsx:266-327, so a branch can never drift from
// production.
//
// The symbols the fix extracts are imported dynamically so that, with the fix
// stashed (base), the cases still RUN and FAIL on their own assertions rather
// than taking the whole file down with a load error.

let decideInlineMouse: typeof import('../src/ink/ink.tsx').decideInlineMouse | undefined
let inlineMouseRelayFromReply: typeof import('../src/ink/ink.tsx').inlineMouseRelayFromReply | undefined
let resolveInlineProbeArm: typeof import('../src/ink/ink.tsx').resolveInlineProbeArm | undefined
try {
  ;({ decideInlineMouse, inlineMouseRelayFromReply, resolveInlineProbeArm } = await import('../src/ink/ink.tsx'))
} catch {}

const LEFT = 0
const DRAG = 0x20
// Mode-1003 no-button motion: base button 3 ("no button") + the motion bit.
const NO_BUTTON_MOTION = 3 | DRAG // 35

function press(button: number, col: number, row: number): ParsedMouse {
  return { kind: 'mouse', button, action: 'press', col: col + 1, row: row + 1, sequence: '' }
}
function release(button: number, col: number, row: number): ParsedMouse {
  return { kind: 'mouse', button, action: 'release', col: col + 1, row: row + 1, sequence: '' }
}
function dragMotion(col: number, row: number): ParsedMouse {
  return { kind: 'mouse', button: LEFT | DRAG, action: 'press', col: col + 1, row: row + 1, sequence: '' }
}
function noButtonMotion(col: number, row: number): ParsedMouse {
  return { kind: 'mouse', button: NO_BUTTON_MOTION, action: 'press', col: col + 1, row: row + 1, sequence: '' }
}

/** Parse a single terminal response the way the live input parser would. */
function parseResponse(sequence: string): TerminalResponse | undefined {
  const [items] = parseMultipleKeypresses({ ...INITIAL_STATE }, sequence)
  const first = items[0]
  return first?.kind === 'response' ? first.response : undefined
}

function parsePlainResponse(sequence: string): TerminalResponse | undefined {
  expectStandardCursorPosition(true)
  try {
    return parseResponse(sequence)
  } finally {
    expectStandardCursorPosition(false)
  }
}

// ---------------------------------------------------------------------------
// Env scaffolding: a plain gateway session with an interactive TTY owns the
// inline mouse. Nothing about the topology may flip that now.
// ---------------------------------------------------------------------------
const savedEnv = {
  gateway: process.env.CLAUDE_CODE_USE_GATEWAY,
  noFlicker: process.env.CLAUDE_CODE_NO_FLICKER,
  disableMouse: process.env.CLAUDE_CODE_DISABLE_MOUSE,
  disableClicks: process.env.CLAUDE_CODE_DISABLE_MOUSE_CLICKS,
  tmux: process.env.TMUX,
  termProgram: process.env.TERM_PROGRAM,
}
const savedStdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
const savedStdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')

function enableLocalInlineSession(): void {
  setIsInteractive(true)
  process.env.CLAUDE_CODE_USE_GATEWAY = '1'
  process.env.CLAUDE_CODE_NO_FLICKER = '0'
  delete process.env.CLAUDE_CODE_DISABLE_MOUSE
  delete process.env.CLAUDE_CODE_DISABLE_MOUSE_CLICKS
  delete process.env.TMUX
  delete process.env.TERM_PROGRAM
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
}

beforeEach(() => {
  enableLocalInlineSession()
})

afterEach(() => {
  setIsInteractive(false)
  if (savedEnv.gateway === undefined) delete process.env.CLAUDE_CODE_USE_GATEWAY
  else process.env.CLAUDE_CODE_USE_GATEWAY = savedEnv.gateway
  if (savedEnv.noFlicker === undefined) delete process.env.CLAUDE_CODE_NO_FLICKER
  else process.env.CLAUDE_CODE_NO_FLICKER = savedEnv.noFlicker
  if (savedEnv.disableMouse === undefined) delete process.env.CLAUDE_CODE_DISABLE_MOUSE
  else process.env.CLAUDE_CODE_DISABLE_MOUSE = savedEnv.disableMouse
  if (savedEnv.disableClicks === undefined) delete process.env.CLAUDE_CODE_DISABLE_MOUSE_CLICKS
  else process.env.CLAUDE_CODE_DISABLE_MOUSE_CLICKS = savedEnv.disableClicks
  if (savedEnv.tmux === undefined) delete process.env.TMUX
  else process.env.TMUX = savedEnv.tmux
  if (savedEnv.termProgram === undefined) delete process.env.TERM_PROGRAM
  else process.env.TERM_PROGRAM = savedEnv.termProgram
  if (savedStdoutTTY) Object.defineProperty(process.stdout, 'isTTY', savedStdoutTTY)
  if (savedStdinTTY) Object.defineProperty(process.stdin, 'isTTY', savedStdinTTY)
})

// ---------------------------------------------------------------------------
// (1) The signal itself, signal-true: the reply FORM decides local vs relay.
// ---------------------------------------------------------------------------
test('the probe reply form is the local-vs-relay signal', () => {
  expect(typeof inlineMouseRelayFromReply).toBe('function')
  // A relay preserves only the DEC-private reply.
  const privateReply = parseResponse('\x1b[?2;1R')
  expect(privateReply).toEqual({ type: 'cursorPosition', row: 2, col: 1, decPrivate: true })
  // A native ConPTY answers the plain DSR form the dual query also sends.
  const plainReply = parsePlainResponse('\x1b[2;1R')
  expect(plainReply).toEqual({ type: 'cursorPosition', row: 2, col: 1, decPrivate: false })

  // Windows sends the dual query: only then does the form discriminate.
  expect(inlineMouseRelayFromReply!(true, privateReply as { decPrivate: boolean })).toBe(true)
  expect(inlineMouseRelayFromReply!(true, plainReply as { decPrivate: boolean })).toBe(false)
  // Non-Windows sends only the private form: no local-vs-relay information.
  expect(inlineMouseRelayFromReply!(false, privateReply as { decPrivate: boolean })).toBe(false)
})

// ---------------------------------------------------------------------------
// (1b) The ARMING rule, the seam this lane owns. The cursor-position reply is
// matched to the parked composer column with `col === cursor.x + 1`. That lock
// is right for a native terminal, where the reply IS the terminal's own cursor.
// It is wrong for a relay client: the answer comes back from xterm.js whose
// terminal cursor is parked on the COMPOSER column (the composer is declared as
// a column inside the box via useDeclaredCursor), so the reply column is a
// stable composer column, not cursor.x + 1. The strict lock rejects it, the
// lane never arms, and it re-probes every frame — the click/select either/or.
//
// The reply FORM already tells us which topology we are in, so a relay is
// armed on the ROW alone (the inline block is a full-width anchored region, so
// its origin needs no column lock). A native terminal keeps the strict lock
// byte-for-byte, so this must not perturb native arming.
// ---------------------------------------------------------------------------
test('resolveInlineProbeArm: a relay arms on the row alone; a native keeps the strict column lock', () => {
  expect(typeof resolveInlineProbeArm).toBe('function')
  const rows = 34
  const cursor = { x: 0, y: 33 } // composer parked on the bottom row, col 0

  // Relay: DEC-private reply, column is xterm's terminal (composer) column and
  // NOT cursor.x + 1 — the exact shape measured live (row=34 col=141 vs
  // expected col=1). It arms, and the origin comes from the row.
  const relayReply = parseResponse('\x1b[?34;141R')
  expect(relayReply).toEqual({ type: 'cursorPosition', row: 34, col: 141, decPrivate: true })
  expect(resolveInlineProbeArm!(true, relayReply as never, cursor, rows)).toEqual({
    arm: true,
    relay: true,
    origin: 34 - 1 - 33,
  })

  // Native: the plain-form reply still has to land on the parked cursor. A
  // mismatched column is rejected exactly as before.
  const nativeOnCursor = parsePlainResponse('\x1b[34;1R')
  expect(resolveInlineProbeArm!(true, nativeOnCursor as never, cursor, rows)).toEqual({
    arm: true,
    relay: false,
    origin: 0,
  })
  const nativeOffCursor = parsePlainResponse('\x1b[34;141R')
  expect(resolveInlineProbeArm!(true, nativeOffCursor as never, cursor, rows)).toEqual({ arm: false })

  // A row outside the viewport is always rejected, relay or native.
  expect(resolveInlineProbeArm!(true, parseResponse('\x1b[?99;1R') as never, cursor, rows)).toEqual({ arm: false })
  expect(resolveInlineProbeArm!(true, undefined, cursor, rows)).toEqual({ arm: false })
})

// ---------------------------------------------------------------------------
// (2) The exported predicate. A relay/mux session DOES own the inline mouse —
// the yield that gated this away is exactly the bug that made the bottom-bar
// controls dead on the relay path. Nothing about local-vs-relay flips it.
// ---------------------------------------------------------------------------
test('a relay session owns the inline mouse, same as a local one', async () => {
  // A plain gateway session owns it...
  expect(isInlineMouseOwned()).toBe(true)
  // ...and there is no longer any verdict that can revoke ownership, so a mux
  // client's DEC-private reply cannot disable it. The predicate module must not
  // export a relay toggle at all.
  const fullscreen = await import('../src/utils/fullscreen.ts')
  expect('setInlineMouseRelayDetected' in fullscreen).toBe(false)
  expect('_resetInlineMouseRelayForTesting' in fullscreen).toBe(false)
  expect(isInlineMouseOwned()).toBe(true)
})

// ---------------------------------------------------------------------------
// (3) decideInlineMouse contract: the inline press/drag/release decision.
// ---------------------------------------------------------------------------
function targetToken(cells: Set<string>, cache: Map<string, object>) {
  return (col: number, row: number): object | undefined => {
    const key = `${col},${row}`
    if (!cells.has(key)) return undefined
    let t = cache.get(key)
    if (!t) {
      t = {}
      cache.set(key, t)
    }
    return t
  }
}
function baseState(over: Partial<InlineMouseState> = {}): InlineMouseState {
  return { origin: 0, tracking: true, epoch: 0, press: null, rows: 24, cols: 80, ...over }
}

test('decideInlineMouse: a bare press then same-cell release clicks', () => {
  const at = targetToken(new Set(['4,4']), new Map())
  const down = decideInlineMouse!(press(LEFT, 4, 4), baseState(), at)
  expect(down.kind).toBe('down')
  const pressState = (down as { press: InlinePress }).press
  const up = decideInlineMouse!(release(LEFT, 4, 4), baseState({ press: pressState }), at)
  expect(up.kind).toBe('upClick')
})

test('decideInlineMouse: a drag that ends on another cell does not click', () => {
  const at = targetToken(new Set(['4,4']), new Map())
  const down = decideInlineMouse!(press(LEFT, 4, 4), baseState(), at)
  const pressState = (down as { press: InlinePress }).press
  // Drag motion (button 32) clears the pending press and declines.
  const drag = decideInlineMouse!(press(LEFT | DRAG, 9, 9), baseState({ press: pressState }), at)
  expect(drag.kind).toBe('pass')
  const up = decideInlineMouse!(release(LEFT, 9, 9), baseState({ press: drag.press }), at)
  expect(up.kind).toBe('upPlain')
})

test('decideInlineMouse: uncalibrated lane consumes and a stray release never clicks', () => {
  const at = targetToken(new Set(['4,4']), new Map())
  // origin null (probe pending) or tracking false (relay) => consume.
  expect(decideInlineMouse!(press(LEFT, 4, 4), baseState({ origin: null }), at).kind).toBe('consume')
  expect(decideInlineMouse!(release(LEFT, 4, 4), baseState({ tracking: false }), at).kind).toBe('consume')
})

// ---------------------------------------------------------------------------
// (4) Cross-case: inline drag-release AND App drag-release on ONE selection.
//     Mirrors the co-verify harness so b2 can be re-run in the same shape.
// ---------------------------------------------------------------------------
function seam(selectable: string[]) {
  const selection = createSelectionState()
  const clicks: Array<{ col: number; row: number }> = []
  const cells = new Set(selectable)
  const cache = new Map<string, object>()
  const at = targetToken(cells, cache)
  let state = baseState()
  const domClicks: Array<{ col: number; row: number }> = []
  const hover: Array<{ col: number; row: number }> = []
  const inline = {
    domClicks,
    hover,
    bumpEpoch() {
      state = { ...state, epoch: state.epoch + 1, press: null }
    },
    handler(m: ParsedMouse): boolean {
      const d = decideInlineMouse!(m, state, at)
      state = { ...state, press: d.press }
      switch (d.kind) {
        case 'consume':
          return true
        case 'wheel':
          return true
        case 'hover':
          // Symmetric with production: a no-button motion the inline lane
          // consumes finishes a dropped-release selection here.
          if (selection.isDragging) finishSelection(selection)
          hover.push({ col: d.col, row: d.row })
          return true
        case 'down':
          startSelection(selection, d.col, d.row) // production: seedPressSelection
          return true
        case 'downMiss':
          return false
        case 'upClick':
          domClicks.push({ col: d.col, row: d.row })
          return true
        case 'upPlain':
        case 'pass':
          return false
      }
    },
  }
  const app = {
    props: {
      selection,
      onInlineMouse: inline.handler,
      onClickAt: (col: number, row: number) => {
        clicks.push({ col, row })
        return true
      },
      onHoverAt: () => {},
      onMultiClick: () => {},
      onSelectionChange: () => {},
      onSelectionDrag: (col: number, row: number) => updateSelection(selection, col, row),
      onOpenHyperlink: () => {},
      getHyperlinkAt: () => undefined,
      mouseRowOffset: undefined,
    },
    clickCount: 0,
    lastClickCol: -1,
    lastClickRow: -1,
    lastClickTime: 0,
    lastHoverCol: -1,
    lastHoverRow: -1,
    pendingHyperlinkTimer: null,
    selectionPressConsumed: false,
  }
  return { app, selection, clicks, inline }
}

test('cross-case: inline drag-release then App drag-release on ONE selection, no stray click', () => {
  const { app, selection, clicks, inline } = seam(['0,0'])

  // (1) INLINE lane: press on the widget (ink consumes and seeds), drag, release.
  handleMouseEvent(app as never, press(LEFT, 0, 0))
  expect(hasSelection(selection)).toBe(false)
  expect(selection.isDragging).toBe(true)
  handleMouseEvent(app as never, dragMotion(5, 3)) // inline declines -> App motion -> focus
  expect(hasSelection(selection)).toBe(true)
  handleMouseEvent(app as never, release(LEFT, 5, 3)) // inline declines -> App release finishes
  expect(selection.isDragging).toBe(false)
  expect(clicks).toEqual([])
  expect(inline.domClicks).toEqual([])

  // (2) APP lane on the SAME selection: a transcript cell (no target), drag,
  // release. Must not inherit a stray click from (1).
  handleMouseEvent(app as never, press(LEFT, 10, 10))
  handleMouseEvent(app as never, dragMotion(12, 10))
  handleMouseEvent(app as never, release(LEFT, 12, 10))
  expect(clicks).toEqual([])
  expect(hasSelection(selection)).toBe(true)
  expect(selection.isDragging).toBe(false)
})

// (b2) Co-verify closure case, run in the same harness shape. Ahmed ruled b2
// FOLDS INTO ITEM 2: the inline lane consumes mode-1003 no-button motion, so
// a dropped inline release left isDragging true and blocked copy-on-select.
// The fix adds the matching finishSelection in the inline branch, so the
// inline seam closes symmetrically with the App-side half.
test('co-verify (b2): dropped inline release + no-button motion finishes the selection', () => {
  const { app, selection, clicks, inline } = seam(['0,0'])
  handleMouseEvent(app as never, press(LEFT, 0, 0))
  handleMouseEvent(app as never, dragMotion(6, 4))
  expect(selection.isDragging).toBe(true)
  handleMouseEvent(app as never, noButtonMotion(6, 4))
  expect(clicks).toEqual([])
  expect(selection.isDragging).toBe(false)
  expect(inline.hover).toEqual([{ col: 6, row: 4 }])
})
