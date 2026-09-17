import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isCanonicalGatewayModelId } from './gatewayModelIds.js'
import { getGatewayModelOptions } from './gatewayModelOptions.js'

/**
 * The model a fresh `cc` launch starts on when the launcher was given neither
 * MODEL_GATEWAY_DEFAULT nor --model. The picker's `f` shortcut writes this
 * file; scripts/cc.ps1 reads it, following the same single-value state file
 * convention as the Codex account selector (`~/.codex-accounts/current.txt`).
 */
export function gatewayDefaultModelPath(): string {
  return join(homedir(), '.claude', 'gateway-default-model.txt')
}

/**
 * A launch default has to be a route this build can actually serve, so accept
 * only ids from the launcher's catalog (the same list the picker renders).
 */
export function isSelectableGatewayDefault(model: string): boolean {
  return (
    isCanonicalGatewayModelId(model) &&
    getGatewayModelOptions().some(option => option.value === model)
  )
}

/**
 * Persist `model` as the launch default, or clear the stored default when
 * `model` is null so the launcher falls back to its built-in model.
 * Returns false when the id is not in the current catalog — nothing is
 * written in that case, so a stale selection can never strand a launch.
 */
export async function setGatewayDefaultModel(
  model: string | null,
): Promise<boolean> {
  const path = gatewayDefaultModelPath()
  if (model === null) {
    await rm(path, { force: true })
    return true
  }
  if (!isSelectableGatewayDefault(model)) return false
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${model}\n`, 'utf8')
  return true
}
