import type { LocalCommandModule, LocalCommandResult } from '../../types/command.js'
import { probeVaultFilesystem } from '../../utils/vault/filesystem.js'
import {
  readGatewaySettings,
  resolveInstallPath,
  vaultRootFor,
  writeGatewaySettings,
} from '../../utils/vault/settings.js'

const SUPPORTED = ['vaultRoot'] as const

async function show(): Promise<LocalCommandResult> {
  const result = await readGatewaySettings()
  if (!result.ok) return { type: 'text', value: `gateway-settings: ${result.reason}` }
  const { root, source } = vaultRootFor(result.settings)
  const lines = [
    `settings: ${result.path}${result.existed ? '' : ' (not created yet)'}`,
    `vaultRoot: ${root} (${source === 'settings' ? 'from settings' : 'install default'})`,
  ]
  return { type: 'text', value: lines.join('\n') }
}

async function setVaultRoot(value: string): Promise<LocalCommandResult> {
  if (!value.trim()) {
    return { type: 'text', value: 'usage: /gateway-settings vaultRoot <path>' }
  }
  const root = resolveInstallPath(value.trim())
  // Adopt a directory only after it proves it can host the journal; the
  // refusal names the missing property rather than failing later under load.
  const probe = await probeVaultFilesystem(root)
  if (!probe.ok) {
    return {
      type: 'text',
      value: [`refused: ${root} cannot host the authoritative vault store`, ...probe.reasons.map(reason => `  - ${reason}`)].join('\n'),
    }
  }
  const written = await writeGatewaySettings({ vaultRoot: root })
  if (!written.ok) return { type: 'text', value: `gateway-settings: ${written.reason}` }
  const warnings = probe.warnings.length > 0 ? `\nwarnings: ${probe.warnings.join('; ')}` : ''
  return { type: 'text', value: `vaultRoot: ${root}\nsettings: ${written.path}${warnings}` }
}

export const call: LocalCommandModule['call'] = async args => {
  const trimmed = (args ?? '').trim()
  if (!trimmed || trimmed === 'show') return show()
  const [key, ...rest] = trimmed.split(/\s+/)
  if (!SUPPORTED.includes(key as (typeof SUPPORTED)[number])) {
    return {
      type: 'text',
      value: `unknown setting '${key}'; supported: ${SUPPORTED.join(', ')}`,
    }
  }
  if (key === 'vaultRoot') return setVaultRoot(rest.join(' '))
  return { type: 'text', value: `unknown setting '${key}'` }
}
