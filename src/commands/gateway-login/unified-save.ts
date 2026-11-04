import { saveGatewayCredential } from '../../utils/gatewayCredentials.js'

export type ReloadResult = { ok: boolean; available?: number[]; error?: string }

export type ProviderSave = {
  ok: boolean
  source: string
  backend?: string
  warning?: string
  reason?: string
  reloaded?: boolean
  reloadError?: string
}

/**
 * Save a provider key and, in a live gateway session, reload the gateway so the
 * new key is usable without restarting cc. The reload is injected so the save
 * itself stays testable against a scratch vault.
 */
export async function saveProviderKey(
  name: string,
  value: string,
  reload?: () => Promise<ReloadResult>,
): Promise<ProviderSave> {
  const saved = await saveGatewayCredential(name, value)
  const base = { source: saved.source, backend: saved.backend, warning: saved.warning }
  if (!saved.ok) return { ok: false, ...base, reason: saved.reason }
  if (!reload) return { ok: true, ...base }
  const result = await reload()
  return result.ok
    ? { ok: true, ...base, reloaded: true }
    : { ok: true, ...base, reloadError: result.error ?? 'the gateway reload failed' }
}
