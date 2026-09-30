import { useEffect, useRef, useSyncExternalStore } from 'react'
import { getSessionId } from '../bootstrap/state.js'
import { getGlobalConfig } from '../utils/config.js'
import { ledColor, ledTitleGlyph } from '../utils/ledPalette.js'
import {
  type LedAssignment,
  ledAssignmentsSync,
  refreshLedStore,
  subscribeLedStore,
} from '../utils/ledStore.js'
import { leafLabel } from '../utils/leafTerminal.js'
import { notifyWindows } from '../utils/windowsNotify.js'

/** How often a session re-reads the family's LED assignments. */
const LED_REFRESH_MS = 5000

/**
 * The family's LED assignments, kept fresh.
 *
 * Reading the store is a file read, so it is cached and polled rather than
 * awaited per render: the tab title is written on every render and cannot wait
 * on the filesystem. The poll is what makes another window's choice show up
 * here - a colour taken across the family has to disappear from this window's
 * picker too.
 */
export function useLedAssignments(): Record<string, LedAssignment> {
  const assignments = useSyncExternalStore(subscribeLedStore, ledAssignmentsSync, ledAssignmentsSync)
  useEffect(() => {
    void refreshLedStore().catch(() => {})
    const interval = setInterval(() => {
      void refreshLedStore().catch(() => {})
    }, LED_REFRESH_MS)
    return () => clearInterval(interval)
  }, [])
  return assignments
}

/**
 * The suffix the tab title wears for this session's LED.
 *
 * Only ever present while the session is parked, which is the whole point of the
 * indicator: while a turn runs there is nothing to tell you, and a mark that is
 * always there is a mark you stop seeing. Parked, it simply stays: a title that
 * moves reads as a session doing something, and the strip is scanned for what is
 * waiting rather than watched.
 *
 * It is composed into the one title write rather than written by its own hook:
 * two writers race and the loser flickers. The caller therefore owns the parked
 * signal, which for the session on screen is the same one the animation uses.
 */
export function useLedTitleSuffix(parked: boolean): string {
  const assignments = useLedAssignments()
  return ledTitleGlyph(assignments[getSessionId()], parked)
}

/** What a session is doing, from the LED's point of view. */
export type LedParkedState = 'busy' | 'waiting' | 'idle'

/**
 * Announce a session's park on the desktop, if it was given an LED that asks for
 * it.
 *
 * The tab is not always on screen - the point of a notification is the window
 * you are in - so a session can opt into a Windows toast carrying its own colour
 * and/or a system tone. Both are per session, chosen in the same place as the
 * colour, and fire once on the way into a park rather than while parked: the
 * session saying "I am done" is the event, and repeating it would be noise.
 */
export function useLedParkedNotification(state: LedParkedState): void {
  const assignments = useLedAssignments()
  const previous = useRef<LedParkedState>(state)
  const assignment = assignments[getSessionId()]

  useEffect(() => {
    const was = previous.current
    previous.current = state
    if (was !== 'busy' || state === 'busy') return
    if (!assignment || (!assignment.notify && !assignment.sound)) return
    if (getGlobalConfig().preferredNotifChannel === 'notifications_disabled') return
    const glyph = ledColor(assignment.color)?.glyph
    if (!glyph) return
    void notifyWindows({
      ...(assignment.notify
        ? {
            title: `${glyph} ${leafLabel() ?? 'Claude Code'}`,
            body: state === 'waiting' ? 'Waiting for your approval' : 'Waiting for your input',
          }
        : {}),
      ...(assignment.sound ? { sound: assignment.sound } : {}),
    })
  }, [state, assignment])
}
