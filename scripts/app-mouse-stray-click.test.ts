import { test, expect } from 'bun:test'
import { handleMouseEvent } from '../src/ink/components/App.tsx'
import { createSelectionState, hasSelection, startSelection, updateSelection, finishSelection } from '../src/ink/selection.ts'
import type { ParsedMouse } from '../src/ink/parse-keypress.ts'

// App.tsx coords: handleMouseEvent translates terminal 1-indexed (col,row)
// to 0-indexed screen coords by subtracting 1. These helpers take screen
// coords and produce the terminal-shaped ParsedMouse a terminal would send.
const LEFT = 0
const SHIFT = 0x04
const DRAG = 0x20

function press(button: number, col: number, row: number): ParsedMouse {
  return { kind: 'mouse', button, action: 'press', col: col + 1, row: row + 1, sequence: '' }
}
function release(button: number, col: number, row: number): ParsedMouse {
  return { kind: 'mouse', button, action: 'release', col: col + 1, row: row + 1, sequence: '' }
}
function motion(col: number, row: number): ParsedMouse {
  // Mode-1003 no-button motion: button 3 (no button) + the motion bit.
  return { kind: 'mouse', button: 3 | DRAG, action: 'press', col: col + 1, row: row + 1, sequence: '' }
}

/**
 * The smallest App the mouse handler touches: it reads props.selection and a
 * handful of callbacks plus a few instance fields for click/hover tracking.
 * `clicks` records every onClickAt so a stray click is observable directly,
 * rather than inferred from changed selection state.
 */
function fakeApp() {
  const selection = createSelectionState()
  const clicks: Array<{ col: number; row: number }> = []
  const app = {
    props: {
      selection,
      onClickAt: (col: number, row: number) => { clicks.push({ col, row }); return true },
      onHoverAt: () => {},
      onInlineMouse: undefined,
      onMultiClick: () => {},
      onSelectionChange: () => {},
      // The real REPL wires this to ink's handleSelectionDrag, which calls
      // updateSelection. Mirror that here so drag motion actually sets focus
      // (and therefore hasSelection) the way production does.
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
  return { app, selection, clicks }
}

test('a plain click still dispatches onClickAt (the guard does not over-fire)', () => {
  const { app, clicks } = fakeApp()
  handleMouseEvent(app as never, press(LEFT, 5, 3))
  handleMouseEvent(app as never, release(LEFT, 5, 3))
  expect(clicks).toEqual([{ col: 5, row: 3 }])
})

test('a normal drag does not dispatch onClickAt on release', () => {
  const { app, selection, clicks } = fakeApp()
  handleMouseEvent(app as never, press(LEFT, 5, 3))
  // Drag motion (held button + motion bit): button LEFT|DRAG.
  handleMouseEvent(app as never, press(LEFT | DRAG, 8, 3))
  handleMouseEvent(app as never, release(LEFT, 8, 3))
  expect(clicks).toEqual([])
  expect(hasSelection(selection)).toBe(true)
})

test('recovering a dropped release does not re-click on the recovering press release', () => {
  // The defect: the release left the window (no SGR 'm' ever arrived), so
  // isDragging stayed true. A no-button motion event is the lost-release
  // recovery. In the OLD code the NEXT plain press+release was still read as
  // a click because startSelection re-seeded anchor with focus=null, and the
  // release branch only checked `!hasSelection && anchor`.
  const { app, selection, clicks } = fakeApp()
  // Press and drag, but the release is dropped.
  handleMouseEvent(app as never, press(LEFT, 5, 3))
  handleMouseEvent(app as never, press(LEFT | DRAG, 9, 5))
  // Lost-release recovery fires on no-button motion while isDragging.
  handleMouseEvent(app as never, motion(9, 5))
  expect(selection.isDragging).toBe(false)
  expect(hasSelection(selection)).toBe(true)

  // Now a fresh press+release that a mode-1002-only terminal would send. The
  // press recovers again (isDragging is false now, so no recovery here) — so
  // this is the bare-press case the guard must still allow. Prove the guard
  // does not swallow a legitimate click after a completed recovery.
  clicks.length = 0
  handleMouseEvent(app as never, press(LEFT, 2, 2))
  handleMouseEvent(app as never, release(LEFT, 2, 2))
  expect(clicks).toEqual([{ col: 2, row: 2 }])
})

test('the fresh press that recovers a dropped release does not click on its own release', () => {
  // Mode-1002-only path (no 1003 motion): the only signal that the previous
  // release was dropped is the NEXT press arriving while isDragging=true.
  // That press finishes the old selection AND starts a new drag; its release
  // must not be read as a click, which is the stray click Ahmed reported.
  const { app, selection, clicks } = fakeApp()
  // First selection: press + drag, release dropped (isDragging stays true).
  handleMouseEvent(app as never, press(LEFT, 5, 3))
  handleMouseEvent(app as never, press(LEFT | DRAG, 9, 5))
  expect(selection.isDragging).toBe(true)

  // Fresh left press while still dragging: recovery + startSelection.
  handleMouseEvent(app as never, press(LEFT, 1, 1))
  // The release of that recovering press must NOT dispatch onClickAt.
  handleMouseEvent(app as never, release(LEFT, 1, 1))
  expect(clicks).toEqual([])
})

test('the recovery flag is per-press, so a later bare click still fires', () => {
  const { app, clicks } = fakeApp()
  // Recover via the 1002 path (press while dragging).
  handleMouseEvent(app as never, press(LEFT, 5, 3))
  handleMouseEvent(app as never, press(LEFT | DRAG, 9, 5))
  handleMouseEvent(app as never, press(LEFT, 1, 1)) // recovery press
  handleMouseEvent(app as never, release(LEFT, 1, 1)) // consumed
  expect(clicks).toEqual([])
  // A subsequent ordinary click must still work: the flag clears each press.
  handleMouseEvent(app as never, press(LEFT, 7, 7))
  handleMouseEvent(app as never, release(LEFT, 7, 7))
  expect(clicks).toEqual([{ col: 7, row: 7 }])
})

test('a bare press with no prior selection still clicks (no anchor spurious)', () => {
  const { app, clicks } = fakeApp()
  handleMouseEvent(app as never, press(LEFT, 4, 4))
  handleMouseEvent(app as never, release(LEFT, 4, 4))
  expect(clicks).toEqual([{ col: 4, row: 4 }])
})
