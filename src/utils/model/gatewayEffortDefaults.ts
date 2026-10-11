import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Per-model default effort levels, chosen with the picker's `e`.
 *
 * A pin is what `auto` resolves to for that model. With no pin the harness
 * sends no effort parameter and the provider's own default governs (shown as
 * `auto`); with a pin the level the user chose is sent instead, and the status
 * line shows it in place of `auto`. This is the one way to name a provider
 * default the harness otherwise cannot know.
 *
 * The launch snapshot arrives as MODEL_GATEWAY_EFFORT_DEFAULTS, exported by
 * scripts/cc.ps1 from this same file - the same two-sided arrangement as the
 * launch default model and the picker order. A pin made in a running session is
 * also held in memory, so it takes effect at once without a relaunch.
 */
export function gatewayEffortDefaultsPath(): string {
  return join(homedir(), '.claude', 'gateway-effort-defaults.json')
}

let snapshotRaw: string | undefined
let snapshot: Record<string, string> = {}

/**
 * The launch snapshot cc.ps1 exported, parsed once per distinct value. A pin the
 * launcher could not serve is filtered by the caller against the model's ladder,
 * so this module stays independent of effort capabilities.
 */
function readLaunchSnapshot(): Record<string, string> {
  const raw = process.env.MODEL_GATEWAY_EFFORT_DEFAULTS
  if (raw === snapshotRaw) return snapshot
  snapshotRaw = raw
  snapshot = {}
  if (!raw) return snapshot
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [model, level] of Object.entries(parsed)) {
        if (typeof level === 'string' && level.length > 0) snapshot[model] = level
      }
    }
  } catch {
    // A malformed snapshot must not break effort resolution; it reads as empty.
  }
  return snapshot
}

// Pins made in this session, layered over the launch snapshot so they apply
// without a relaunch. A cleared pin is stored as null so it also shadows a
// snapshot entry the launcher exported for the same model.
const sessionPins = new Map<string, string | null>()

/** The effort level pinned for `model`, or undefined when none is. */
export function getPinnedGatewayEffort(model: string): string | undefined {
  const override = sessionPins.get(model)
  if (override !== undefined) return override ?? undefined
  return readLaunchSnapshot()[model]
}

let writeQueue: Promise<unknown> = Promise.resolve()

/**
 * Persist `level` as the pinned default for `model`, or clear the pin when
 * `level` is null. Writes are serialized so the file ends on the last pin the
 * user made, and the whole map is rewritten each time so a pin for one model
 * never drops another's.
 */
export async function pinGatewayEffort(
  model: string,
  level: string | null,
): Promise<void> {
  sessionPins.set(model, level)
  const queued = writeQueue.then(
    () => writeGatewayEffortDefaultsNow(),
    () => writeGatewayEffortDefaultsNow(),
  )
  writeQueue = queued.then(
    () => {},
    () => {},
  )
  return queued
}

/**
 * Rewrite the file as the launch snapshot with this session's pins applied,
 * through a temporary file in the same directory and renamed into place, so a
 * reader never sees a half-written map and an interrupted write leaves the
 * previous pins intact.
 */
async function writeGatewayEffortDefaultsNow(): Promise<void> {
  const merged: Record<string, string> = { ...readLaunchSnapshot() }
  for (const [model, level] of sessionPins) {
    if (level === null) delete merged[model]
    else merged[model] = level
  }
  const path = gatewayEffortDefaultsPath()
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    try {
      await handle.writeFile(`${JSON.stringify(merged, null, 2)}\n`)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, path)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}
