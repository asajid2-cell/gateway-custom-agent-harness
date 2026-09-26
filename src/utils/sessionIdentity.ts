import { getSessionId } from '../bootstrap/state.js'
import { leafLabel } from './leafTerminal.js'

/**
 * What this session is called in the OS process and terminal list.
 *
 * A session's command line carries only the id it was resumed from, so a machine
 * running several of them is a list of identical bun processes whose only
 * distinguishing feature is their start time - which is how a stray session goes
 * unrecognised for eighteen hours. Everything needed to tell them apart is in the
 * peer registry, and no process list or task manager reads the registry.
 *
 * The id is shortened to eight characters because that is what /sessions and the
 * registration file name take, and a title is read at a glance in a tab strip
 * rather than copied.
 *
 * A leaf uses its own label in place of the incoming title: a forked leaf carries
 * its parent's conversation, so the session title it would otherwise show
 * describes the parent's work, and labelling a leaf with it is worse than
 * labelling it with nothing.
 */
export function sessionProcessTitle(title: string): string {
  const label = (leafLabel() ?? title).replace(/\s+/g, ' ').trim()
  const short = getSessionId().slice(0, 8)
  return label ? `${label} · ${short}` : short
}
