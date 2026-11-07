import React, { useEffect, useRef } from 'react'
import { useAppStateStore } from '../../state/AppState.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

/**
 * Flip the live thinking display. The state is app state (persisted by the same
 * change hook `verbose` uses), so the conversation updates on the next render
 * rather than after a restart.
 */
function ToggleThinking({ args, onDone }: { args: string; onDone: (message: string) => void }) {
  const store = useAppStateStore()
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current) return
    ran.current = true
    const current = store.getState().showThinking
    const words = args.trim().toLowerCase()
    const next = words === 'on' || words === 'true'
      ? true
      : words === 'off' || words === 'false'
        ? false
        : !current
    store.setState(prev => ({ ...prev, showThinking: next }))
    onDone(
      next
        ? 'Thinking display is on: each block streams while it is being written, with its elapsed time and token estimate.'
        : 'Thinking display is off. Thinking is still generated; it is just not shown.',
    )
  }, [args, onDone, store])

  return null
}

export const call: LocalJSXCommandCall = async (onDone, _context, args) => (
  <ToggleThinking args={args} onDone={message => onDone(message)} />
)
