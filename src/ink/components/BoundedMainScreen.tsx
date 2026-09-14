import React, { type PropsWithChildren, useContext, useInsertionEffect } from 'react'
import instances from '../instances.js'
import Box from './Box.js'
import { TerminalSizeContext } from './TerminalSizeContext.js'

/**
 * Constrain children to the viewport height on the main screen buffer.
 *
 * The inline counterpart to <AlternateScreen>: the same bounded layout (a
 * virtual ScrollBox of exactly `rows` rows with app-painted selection), but
 * written to the normal buffer instead of the alt screen.
 *
 * Gateway inline sessions arm SGR mouse tracking so the bottom-bar controls
 * are clickable, and a mouse-reporting terminal stops scrolling and
 * selecting natively — so the app has to provide both. Without a bounded
 * viewport the wheel finds no ScrollBox to drive and the app-owned
 * selection paths are unreachable, leaving the user with clicks but no
 * scroll and no copy.
 *
 * Notifies the Ink instance via `setInlineBoundedLayout()` so the renderer
 * clamps the cursor to the viewport and the selection/click paths become
 * reachable. Mount/unmount write nothing to the terminal — leaving the
 * final frame in scrollback is the point of staying inline.
 */
export function BoundedMainScreen({ children }: PropsWithChildren) {
  const size = useContext(TerminalSizeContext)

  // useInsertionEffect (not useLayoutEffect): react-reconciler calls
  // resetAfterCommit between the mutation and layout phases, and Ink's
  // resetAfterCommit triggers onRender. With useLayoutEffect that first
  // onRender would run before this flag is set, rendering one frame with
  // the unbounded cursor semantics. Insertion effects fire in the mutation
  // phase, before resetAfterCommit.
  useInsertionEffect(() => {
    const ink = instances.get(process.stdout)
    ink?.setInlineBoundedLayout(true)
    return () => {
      ink?.setInlineBoundedLayout(false)
    }
  }, [])

  return (
    <Box flexDirection="column" height={size?.rows ?? 24} width="100%" flexShrink={0}>
      {children}
    </Box>
  )
}
