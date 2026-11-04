import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { getClaudeConfigHomeDir } from '../envUtils.js'

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
  return { ok: true, path, settings: parsed as GatewaySettings, existed: true }
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
  const merged: GatewaySettings = { ...current.settings, ...patch }
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
