import { test, expect } from 'bun:test'
import { handleMouseEvent } from '../src/ink/components/App.tsx'
import {
  createSelectionState,
  finishSelection,
  hasSelection,
  startSelection,
  updateSelection,
} from '../src/ink/selection.ts'
import type { SelectionState } from '../src/ink/selection.ts'
import type { ParsedMouse } from '../src/ink/parse-keypress.ts'

// Co-verification harness for the mouse/selection SEAM (newtok, independent
// verifier). It drives BOTH production mouse paths against ONE shared
// `selection` in one process:
//
//   - the INLINE path, which in production is ink's private
//     handleInlineMouse (ink.tsx:266-327) wired as App's `onInlineMouse`
//     prop. The real method is private on the Ink class and cannot be
//     instantiated in a unit harness, so makeInlineHandler mirrors its
//     branch structure exactly (see the comment there).
//   - the APP path, which is the REAL exported handleMouseEvent
//     (App.tsx:577) - the same function the item-1 fix changed.
//
// handleMouseEvent calls `app.props.onInlineMouse?.(m)` first and returns
// when it is consumed, so routing every event through handleMouseEvent is
// exactly production dispatch order: ink first, App on the fall-through.
//
// This file is the SEAM GATE. It requires both halves of the fix:
//   - the App-side per-press flag (item 1) -> case (a3);
//   - the inline branch finishing a dropped-release selection (item 2) -> (b2).
// (b2) mirrors the inline branch's matching finishSelection (the App branch
// already had one). The mirror alone cannot prove the production switch - a
// mirror ahead of production is a false green - so the real-instance companion
// (app-mouse-inline-real.test.tsx) drives the actual private handleInlineMouse.

const LEFT = 0
const DRAG = 0x20
// Mode-1003 no-button motion: base button 3 ("no button") + the motion bit.
// The inline lane arms 1003 (ENABLE_MOUSE_TRACKING includes MOUSE_ANY), so
// this reaches handleInlineMouse's `mouse.button === 35` branch.
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

/**
 * Mirror of ink.tsx handleInlineMouse's INLINE branch (ink.tsx:266-327).
 * Branch-for-branch:
 *   - wheel            -> consume
 *   - button 35        -> clear the pending press, finish a dropped-release
 *     selection, consume (production: decideInlineMouse 'hover' ->
 *     `if (this.selection.isDragging) finishSelection(...)`)
 *   - left press on a pointer target -> seed the selection via startSelection
 *     (production: seedPressSelection -> startSelection) and consume
 *   - left press on NO target        -> decline (return false -> App press branch)
 *   - left release matching the pending press (epoch/col/row/target) ->
 *     consume (production dispatches a DOM click; App.onClickAt is NOT used)
 *   - left release not matching      -> decline (return false -> App release branch)
 *   - anything else (drag motion)    -> decline
 * `bumpEpoch()` models the inlineEpoch++ sites (resize 532, frame-height
 * change 1011, repaint 1090, alt-screen toggle 1151, bounded-layout 1176),
 * each of which also nulls the pending press.
 */
function makeInlineHandler(selection: SelectionState, selectableCells: Set<string>) {
  let inlinePress: { col: number; row: number; target: object; epoch: number } | null = null
  let inlineEpoch = 0
  const targetCache = new Map<string, object>()
  const targetAt = (col: number, row: number): object | undefined => {
    const key = `${col},${row}`
    if (!selectableCells.has(key)) return undefined
    let t = targetCache.get(key)
    if (!t) {
      t = {}
      targetCache.set(key, t)
    }
    return t
  }
  const domClicks: Array<{ col: number; row: number }> = []
  const hover: Array<{ col: number; row: number }> = []
  return {
    domClicks,
    hover,
    bumpEpoch() {
      inlineEpoch++
      inlinePress = null
    },
    handler(m: ParsedMouse): boolean {
      const col = m.col - 1
      const row = m.row - 1
      const wheel = (m.button & 0x40) !== 0
      if (wheel) return true
      if (m.button === NO_BUTTON_MOTION) {
        inlinePress = null
        // Production ca463a6 case 'hover': the inline lane consumes mode-1003
        // motion, so a dropped release (the up event never arrived) is
        // recovered HERE - symmetric with App's own no-button-motion recovery
        // (App.tsx). Without it isDragging stays true and copy-on-select, which
        // only fires on a finished selection, never runs. This is the (b2) gate.
        if (selection.isDragging) finishSelection(selection)
        hover.push({ col, row })
        return true
      }
      if (m.button === LEFT && m.action === 'press') {
        const target = targetAt(col, row)
        inlinePress = target ? { col, row, target, epoch: inlineEpoch } : null
        if (!target) return false
        startSelection(selection, col, row) // seedPressSelection
        return true
      }
      if (m.button === LEFT && m.action === 'release') {
        const p = inlinePress
        inlinePress = null
        if (!p || p.epoch !== inlineEpoch || p.col !== col || p.row !== row || p.target !== targetAt(col, row)) return false
        domClicks.push({ col, row })
        return true
      }
      inlinePress = null
      return false
    },
  }
}

/**
 * ONE selection shared by both paths. `selectable` lists the cells that carry
 * a pointer target (production: prompt input / bottom-bar widgets); every
 * other cell (transcript text) has none, so a press there declines out of the
 * inline path into App's own press branch.
 */
function seam(selectable: string[]) {
  const selection = createSelectionState()
  const clicks: Array<{ col: number; row: number }> = []
  const inline = makeInlineHandler(selection, new Set(selectable))
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
      // Production wiring: App's onSelectionDrag -> ink.handleSelectionDrag ->
      // updateSelection (char mode; anchorSpan null in these scenarios).
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

// (a) Both paths, one selection, in sequence: an inline drag-then-release,
// then an App-path drag-then-release. Neither is a click, and the second
// must not inherit a stray click from the first.
test('co-verify (a): inline drag-release then App drag-release on ONE selection, no stray click', () => {
  const { app, selection, clicks, inline } = seam(['0,0']) // (0,0) carries a pointer target

  // (1) INLINE lane: press on the widget (ink consumes and seeds), drag, release.
  handleMouseEvent(app as never, press(LEFT, 0, 0))
  expect(hasSelection(selection)).toBe(false) // focus still null after a bare press
  expect(selection.isDragging).toBe(true)
  handleMouseEvent(app as never, dragMotion(5, 3)) // ink declines -> App motion -> onSelectionDrag
  expect(hasSelection(selection)).toBe(true)
  handleMouseEvent(app as never, release(LEFT, 5, 3)) // ink declines (col/row != press) -> App release
  expect(selection.isDragging).toBe(false)
  expect(clicks).toEqual([]) // no App-level click from an inline drag
  expect(inline.domClicks).toEqual([]) // and no DOM click either - it was a drag

  // (2) APP lane on the SAME selection: press a transcript cell (no target),
  // drag, release. Must not see a stray click from (1).
  handleMouseEvent(app as never, press(LEFT, 10, 10)) // ink declines -> App press branch
  handleMouseEvent(app as never, dragMotion(12, 10)) // App motion -> focus
  handleMouseEvent(app as never, release(LEFT, 12, 10)) // App release -> finish; hasSelection true
  expect(clicks).toEqual([])
  expect(hasSelection(selection)).toBe(true)
  expect(selection.isDragging).toBe(false)
})

// (a2) An inline BARE click produces only the inline DOM click; a following
// App-path drag adds no App click and does not disturb the state.
test('co-verify (a2): inline bare click then App drag-release on ONE selection', () => {
  const { app, selection, clicks, inline } = seam(['0,0'])
  handleMouseEvent(app as never, press(LEFT, 0, 0)) // ink consumes, seeds
  handleMouseEvent(app as never, release(LEFT, 0, 0)) // ink consumes -> DOM click
  expect(inline.domClicks).toEqual([{ col: 0, row: 0 }])
  expect(clicks).toEqual([]) // App.onClickAt never fired for the inline click

  handleMouseEvent(app as never, press(LEFT, 20, 20)) // App press (no target)
  handleMouseEvent(app as never, dragMotion(22, 20)) // App motion -> focus
  handleMouseEvent(app as never, release(LEFT, 22, 20)) // App release -> finish
  expect(clicks).toEqual([]) // no stray App click
  expect(hasSelection(selection)).toBe(true)
})

// (a3) A stale App-path recovery flag must not suppress the inline path's own
// click. Set the flag true via an App-path mode-1002 recovery, then run an
// inline widget press+release and assert the inline DOM click still fires.
test('co-verify (a3): stale App recovery flag does not suppress a later inline click', () => {
  const { app, selection, clicks, inline } = seam(['0,0'])
  // App-path: press a transcript cell, drag, DROP the release, recover with a
  // fresh App press (mode-1002 press-while-dragging) -> flag set true.
  handleMouseEvent(app as never, press(LEFT, 10, 10))
  handleMouseEvent(app as never, dragMotion(14, 10))
  expect(selection.isDragging).toBe(true)
  handleMouseEvent(app as never, press(LEFT, 1, 1)) // recovery press -> flag true
  handleMouseEvent(app as never, release(LEFT, 1, 1)) // consumed -> no click
  expect(clicks).toEqual([])

  // Inline widget press+release on the SAME selection:
  handleMouseEvent(app as never, press(LEFT, 0, 0)) // ink consumes, seeds
  handleMouseEvent(app as never, release(LEFT, 0, 0)) // ink consumes -> DOM click
  expect(inline.domClicks).toEqual([{ col: 0, row: 0 }])
  expect(clicks).toEqual([])
})

// (b1) Dropped inline release recovered by a frame move: the epoch invalidation
// (resize/repaint) nulls the pending press, so the late release declines out of
// ink into App, whose release branch finishes the selection.
test('co-verify (b1): dropped inline release + frame move finishes the selection', () => {
  const { app, selection, clicks, inline } = seam(['0,0'])
  handleMouseEvent(app as never, press(LEFT, 0, 0)) // ink seeds, isDragging true
  handleMouseEvent(app as never, dragMotion(6, 4)) // focus set
  expect(selection.isDragging).toBe(true)
  inline.bumpEpoch() // resize / repaint: inlineEpoch++ and pending press nulled
  handleMouseEvent(app as never, release(LEFT, 6, 4)) // late release, stale epoch
  expect(selection.isDragging).toBe(false) // App release branch finished it
  expect(hasSelection(selection)).toBe(true) // highlight preserved
  expect(clicks).toEqual([])
})

// (b2) Dropped inline release recovered by mode-1003 no-button motion. The
// inline lane arms 1003, so this is the motion the recovery is meant to catch.
test('co-verify (b2): dropped inline release + no-button motion finishes the selection', () => {
  const { app, selection, clicks, inline } = seam(['0,0'])
  handleMouseEvent(app as never, press(LEFT, 0, 0)) // ink seeds, isDragging true
  handleMouseEvent(app as never, dragMotion(6, 4)) // focus set
  expect(selection.isDragging).toBe(true)
  handleMouseEvent(app as never, noButtonMotion(6, 4)) // mode-1003 no-button motion
  // Reported for the verifier record - see the assertion below.
  expect(clicks).toEqual([])
  expect(selection.isDragging).toBe(false) // expected: the recovery finishes it
})
