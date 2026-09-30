import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { lock } from './lockfile.js'
import { ledColor, ledSound } from './ledPalette.js'
import { familyIndexDir, familyRootSync, writeIndexFile } from './leafWorkspace.js'

const ledAssignmentSchema = z
  .object({
    color: z.string().min(1).max(40),
    notify: z.boolean(),
    sound: z.string().min(1).max(40).nullable(),
  })
  .strict()

const ledStoreSchema = z
  .object({
    version: z.literal(1),
    // Session ids are only ever uuids today, but a store that failed to parse
    // because one arrived in another shape would cost every session its LED at
    // once. Identity is the key, not the shape of it.
    assignments: z.record(z.string().min(1).max(200), ledAssignmentSchema),
  })
  .strict()

export type LedAssignment = z.infer<typeof ledAssignmentSchema>
export type LedStore = z.infer<typeof ledStoreSchema>

/**
 * Which LED each session in a family wears.
 *
 * Per family, not per session: an LED is a claim on a shared pool, and "this
 * colour is taken" only means anything if the sessions comparing notes are
 * looking at the same list. So the file is keyed by the family's id - the stable
 * id `familyRootSync()` hands out, which is a session's own id until a family
 * forms and the family's creator id afterwards, and therefore never has to be
 * re-keyed when a family does form.
 *
 * A sidecar, not a field in the family file: that file's schema is strict, and a
 * session still running an older build would throw on an unknown key rather than
 * ignore it. The lock discipline (`lockfile`, then temp file, then rename) is the
 * same one the family file and the family pointers are written with, because the
 * writers here are separate processes racing over one file just as they are
 * there.
 */
export function ledStorePath(familyId: string): string {
  return join(familyIndexDir(), `${familyId}.led.json`)
}

function emptyLedStore(): LedStore {
  return { version: 1, assignments: {} }
}

export async function readLedStore(familyId: string): Promise<LedStore> {
  try {
    return ledStoreSchema.parse(JSON.parse(await readFile(ledStorePath(familyId), 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyLedStore()
    throw error
  }
}

async function mutateLedStore<T>(familyId: string, mutate: (store: LedStore) => T): Promise<T> {
  const path = ledStorePath(familyId)
  // The index directory has to exist before the lock is taken: the lock is a
  // directory beside the file, and neither can be created through a missing
  // parent.
  await mkdir(familyIndexDir(), { recursive: true, mode: 0o700 })
  const release = await lock(path, { realpath: false, retries: { retries: 20, minTimeout: 10, maxTimeout: 100 } })
  try {
    const store = await readLedStore(familyId)
    const result = mutate(store)
    await writeIndexFile(path, ledStoreSchema.parse(store))
    return result
  } finally {
    await release()
  }
}

/** The session in `familyId` wearing `color`, other than `sessionId` itself. */
export function ledColorOwner(assignments: Record<string, LedAssignment>, color: string, sessionId: string): string | undefined {
  return Object.keys(assignments).find(id => id !== sessionId && assignments[id]!.color === color)
}

/**
 * Give a session an LED, or change what its LED does.
 *
 * A colour another session already wears is refused rather than reassigned: the
 * picker does not offer it, and this is the guard for the race between two
 * sessions choosing at once. Turning the LED off removes the row entirely, which
 * is what "off by default, only the sessions I gave a colour are tracked" means
 * in storage.
 */
export function setLedAssignment(
  familyId: string,
  sessionId: string,
  color: string,
  options: { notify?: boolean; sound?: string | null } = {},
): Promise<LedAssignment> {
  return mutateLedStore(familyId, store => {
    if (!ledColor(color)) throw new Error(`Unknown LED colour: ${color}`)
    if (options.sound != null && !ledSound(options.sound)) throw new Error(`Unknown LED sound: ${options.sound}`)
    const owner = ledColorOwner(store.assignments, color, sessionId)
    if (owner) throw new Error(`That LED is already worn by ${owner}`)
    const current = store.assignments[sessionId]
    const assignment: LedAssignment = {
      color,
      notify: options.notify ?? current?.notify ?? false,
      sound: options.sound === undefined ? current?.sound ?? null : options.sound,
    }
    store.assignments[sessionId] = assignment
    return assignment
  })
}

/** Turn a session's LED off: it leaves the pool and is no longer tracked. */
export function clearLedAssignment(familyId: string, sessionId: string): Promise<void> {
  return mutateLedStore(familyId, store => {
    delete store.assignments[sessionId]
  })
}

/**
 * The assignments as the render path last saw them.
 *
 * Reading the store is a file read, and the tab title is written on a blink
 * timer, so the render path cannot await one. `useLedStore` refreshes this on a
 * poll and on every family change; a session that has never refreshed reads an
 * empty store, which is the same as wearing no LED.
 */
let cached: { familyId: string; assignments: Record<string, LedAssignment> } | undefined
// Returned unchanged whenever nothing has been read for this family: a render
// path subscribes to this value, and a fresh `{}` every call would re-render
// forever.
const NO_ASSIGNMENTS: Record<string, LedAssignment> = {}
const listeners = new Set<() => void>()
let revision = 0

function signature(assignments: Record<string, LedAssignment>): string {
  return Object.keys(assignments)
    .sort()
    .map(id => `${id}:${assignments[id]!.color}:${assignments[id]!.notify}:${assignments[id]!.sound ?? ''}`)
    .join('|')
}

export function ledAssignmentsSync(): Record<string, LedAssignment> {
  const familyId = familyRootSync()
  return cached && cached.familyId === familyId ? cached.assignments : NO_ASSIGNMENTS
}

export function subscribeLedStore(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function ledStoreRevision(): number {
  return revision
}

export async function refreshLedStore(): Promise<void> {
  const familyId = familyRootSync()
  const store = await readLedStore(familyId)
  if (cached && cached.familyId === familyId && signature(cached.assignments) === signature(store.assignments)) return
  cached = { familyId, assignments: store.assignments }
  revision++
  for (const listener of listeners) listener()
}

/** Test seam: drop the cache so the next refresh re-reads the file. */
export function forgetLedStore(): void {
  cached = undefined
  revision++
}

/**
 * The LED picker is a prompt overlay, and the control that opens it sits in the
 * footer, which cannot render one. Like the leaf menu it asks for the overlay by
 * name and whichever component owns that slot opens it.
 */
const menuListeners = new Set<() => void>()
export function requestLedMenu(): void {
  for (const listener of menuListeners) listener()
}
export function subscribeLedMenuRequest(listener: () => void): () => void {
  menuListeners.add(listener)
  return () => {
    menuListeners.delete(listener)
  }
}
