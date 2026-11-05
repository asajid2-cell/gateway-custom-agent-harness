import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { DEFAULT_OVERDUE_HOURS } from './obligations.js'

/**
 * The install-owned settings file.
 *
 * It sits under the config home so it survives a checkout switch and cannot
 * split from `leaf-families/` when `CLAUDE_CONFIG_DIR` moves the home. That is
 * deliberately different from `gateway-default-model.txt` and
 * `gateway-effort-defaults.json`, which resolve from the user home directly and
 * ignore `CLAUDE_CONFIG_DIR`; those two are left as they are.
 */
export function gatewaySettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.GATEWAY_SETTINGS?.trim()
  if (override) return resolve(override)
  return join(getClaudeConfigHomeDir(), 'gateway-settings.json')
}

export type GatewaySettings = {
  /** Absolute directory holding the authoritative vault store. */
  vaultRoot?: string
  [key: string]: unknown
}

export type SettingsRead =
  | { ok: true; path: string; settings: GatewaySettings; existed: boolean }
  | { ok: false; path: string; reason: string }

export const DEFAULT_VAULT_NAME = 'main'

const TOP_LEVEL = new Set(['schemaVersion', 'vaultRoot', 'capture', 'retrieval', 'writer'])

/**
 * The rules a JSON Schema cannot express, enforced before a write so the file
 * on disk is always one the reader can trust.
 *
 * The rotation caps are the interesting one: `every` is the literal count and
 * the two caps are an all-or-nothing pair ("whichever comes first"). Both set
 * is the standing default; both null is the literal-only ruling Ahmed has not
 * given, so it is legal to write deliberately and never a default to invent.
 */
export function validateGatewaySettings(settings: GatewaySettings): string[] {
  const reasons: string[] = []
  for (const key of Object.keys(settings)) {
    if (!TOP_LEVEL.has(key)) reasons.push(`unknown key '${key}'; allowed: ${[...TOP_LEVEL].join(', ')}`)
  }
  if ('schemaVersion' in settings && settings.schemaVersion !== 1) {
    reasons.push(`schemaVersion must be 1, not ${JSON.stringify(settings.schemaVersion)}`)
  }
  if ('vaultRoot' in settings) {
    const value = settings.vaultRoot
    if (typeof value !== 'string' || value.trim() === '') {
      reasons.push('vaultRoot must be a non-empty string')
    } else if (value.split(/[\\/]/).includes('..')) {
      reasons.push('vaultRoot must not contain ..; a settings file must not depend on the working directory')
    }
  }

  const asRecord = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

  if ('capture' in settings) {
    const capture = asRecord(settings.capture)
    if (!capture) reasons.push('capture must be an object')
    else {
      if ('mode' in capture && capture.mode !== 'monitor' && capture.mode !== 'enforce') {
        reasons.push("capture.mode must be 'monitor' or 'enforce'")
      }
      const scribe = 'scribe' in capture ? asRecord(capture.scribe) : null
      if ('scribe' in capture && !scribe) reasons.push('capture.scribe must be an object')
      const rotation = scribe && 'rotation' in scribe ? asRecord(scribe.rotation) : null
      if (scribe && 'rotation' in scribe && !rotation) reasons.push('capture.scribe.rotation must be an object')
      if (rotation) {
        if ('every' in rotation && (!Number.isInteger(rotation.every) || Number(rotation.every) < 1)) {
          reasons.push('capture.scribe.rotation.every must be an integer >= 1')
        }
        const hasAge = 'maxAgeHours' in rotation
        const hasEvents = 'maxEvents' in rotation
        const ageNull = rotation.maxAgeHours === null
        const eventsNull = rotation.maxEvents === null
        if (hasAge !== hasEvents) {
          reasons.push('maxAgeHours and maxEvents must be set together; half a cap pair is not a rule')
        } else if (hasAge && hasEvents && ageNull !== eventsNull) {
          reasons.push('maxAgeHours and maxEvents must both be numbers or both null')
        } else if (hasAge && !ageNull && (!Number.isInteger(rotation.maxAgeHours) || Number(rotation.maxAgeHours) < 1)) {
          reasons.push('capture.scribe.rotation.maxAgeHours must be an integer >= 1 or null')
        } else if (hasEvents && !eventsNull && (!Number.isInteger(rotation.maxEvents) || Number(rotation.maxEvents) < 1)) {
          reasons.push('capture.scribe.rotation.maxEvents must be an integer >= 1 or null')
        }
      }
      const obligations = 'obligations' in capture ? asRecord(capture.obligations) : null
      if ('obligations' in capture && !obligations) reasons.push('capture.obligations must be an object')
      if (obligations) {
        if ('overdueHours' in obligations && (!Number.isInteger(obligations.overdueHours) || Number(obligations.overdueHours) < 1)) {
          reasons.push('capture.obligations.overdueHours must be an integer >= 1')
        }
        if ('maxPending' in obligations && obligations.maxPending !== null && (!Number.isInteger(obligations.maxPending) || Number(obligations.maxPending) < 0)) {
          reasons.push('capture.obligations.maxPending must be an integer >= 0 or null')
        }
      }
    }
  }

  if ('retrieval' in settings) {
    const retrieval = asRecord(settings.retrieval)
    if (!retrieval) reasons.push('retrieval must be an object')
    else {
      if ('engine' in retrieval && retrieval.engine !== 'sqlite-fts5') {
        reasons.push("retrieval.engine must be 'sqlite-fts5'")
      }
      const embeddings = 'embeddings' in retrieval ? asRecord(retrieval.embeddings) : null
      if ('embeddings' in retrieval && !embeddings) reasons.push('retrieval.embeddings must be an object')
      if (embeddings && 'enabled' in embeddings && embeddings.enabled !== false) {
        reasons.push('retrieval.embeddings.enabled must be false; enabling paid embeddings is a spec change, not a settings edit')
      }
    }
  }

  if ('writer' in settings) {
    const writer = asRecord(settings.writer)
    if (!writer) reasons.push('writer must be an object')
    else if ('fsync' in writer && writer.fsync !== true) {
      reasons.push('writer.fsync must be true; a commit not on disk has not happened')
    }
  }

  return reasons
}

/**
 * Relative paths resolve against the config home, so a settings file copied
 * between machines - or a `vaultRoot` written as `vaults/main` - cannot follow
 * the current working directory into a checkout.
 */
export function resolveInstallPath(value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(getClaudeConfigHomeDir(), value)
}

export function defaultVaultRoot(settings: GatewaySettings = {}): string {
  return join(getClaudeConfigHomeDir(), 'vaults', DEFAULT_VAULT_NAME)
}

/**
 * The vault root a writer should adopt. `vaultRoot` wins when it is a
 * non-empty string; anything else falls back to the install default, and the
 * caller is told which it got so a diagnostic can name the source.
 */
export function vaultRootFor(settings: GatewaySettings = {}): { root: string; source: 'settings' | 'default' } {
  const configured = typeof settings.vaultRoot === 'string' ? settings.vaultRoot.trim() : ''
  if (configured) return { root: resolveInstallPath(configured), source: 'settings' }
  return { root: defaultVaultRoot(settings), source: 'default' }
}

export type ObligationPolicy = {
  /** What counts as overdue now. One reader for recall and the activation gate. */
  overdueHours: number
  /** `null` means the cap is off, not a cap of zero. */
  maxPending: number | null
}

/**
 * The obligation policy with its defaults applied. Validated settings are
 * already known-good, so this only fills the gaps - but a setting that is
 * validated and then read by nothing is a claim, so the readers of this file go
 * through here rather than re-deriving the defaults.
 */
export function obligationPolicy(settings: GatewaySettings = {}): ObligationPolicy {
  const capture =
    settings.capture && typeof settings.capture === 'object' && !Array.isArray(settings.capture)
      ? (settings.capture as Record<string, unknown>)
      : null
  const obligations =
    capture && capture.obligations && typeof capture.obligations === 'object' && !Array.isArray(capture.obligations)
      ? (capture.obligations as Record<string, unknown>)
      : null
  const overdue = obligations?.overdueHours
  const maxPending = obligations?.maxPending
  return {
    overdueHours: typeof overdue === 'number' && overdue >= 1 ? overdue : DEFAULT_OVERDUE_HOURS,
    maxPending: typeof maxPending === 'number' && maxPending >= 0 ? maxPending : null,
  }
}

export async function readGatewaySettings(env: NodeJS.ProcessEnv = process.env): Promise<SettingsRead> {
  const path = gatewaySettingsPath(env)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, path, settings: {}, existed: false }
    return { ok: false, path, reason: `cannot read ${path}: ${(error as Error).message}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { ok: false, path, reason: `${path} is not valid JSON: ${(error as Error).message}` }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, path, reason: `${path} must contain a JSON object` }
  }
  const settings = parsed as GatewaySettings
  // Read-side validation too: a file with a mistyped key is refused rather than
  // silently ignored, which is how a vault ends up somewhere nobody meant.
  const reasons = validateGatewaySettings(settings)
  if (reasons.length > 0) {
    return { ok: false, path, reason: `${path}: ${reasons.join('; ')}` }
  }
  return { ok: true, path, settings, existed: true }
}

/**
 * Merge a patch into the settings file atomically: write a sibling temp file,
 * fsync it, then rename over the target in the same directory. A reader never
 * sees a half-written file, and a crash leaves either the old or the new one.
 */
export async function writeGatewaySettings(
  patch: GatewaySettings,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: true; path: string; settings: GatewaySettings } | { ok: false; path: string; reason: string }> {
  const path = gatewaySettingsPath(env)
  const current = await readGatewaySettings(env)
  if (!current.ok) return current
  const merged: GatewaySettings = { ...current.settings, ...patch, schemaVersion: 1 }
  const reasons = validateGatewaySettings(merged)
  if (reasons.length > 0) {
    return { ok: false, path, reason: reasons.join('; ') }
  }
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(temp, `${JSON.stringify(merged, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temp, path)
  } catch (error) {
    return { ok: false, path, reason: `cannot write ${path}: ${(error as Error).message}` }
  }
  return { ok: true, path, settings: merged }
}
