import type { LocalCommandModule, LocalCommandResult } from '../../types/command.js'
import { probeVaultFilesystem } from '../../utils/vault/filesystem.js'
import {
  readGatewaySettings,
  resolveInstallPath,
  vaultRootFor,
  writeGatewaySettings,
  type GatewaySettings,
} from '../../utils/vault/settings.js'

const SETTABLE = ['vaultRoot'] as const
const POLICY = ['capture', 'retrieval', 'writer', 'schemaVersion'] as const

/** The standing defaults from spec §12.10; displayed, never written. */
const DEFAULTS = {
  captureMode: 'monitor',
  rotationEvery: 5,
  maxAgeHours: 8,
  maxEvents: 200,
  overdueHours: 24,
  engine: 'sqlite-fts5',
  embeddings: false,
  fsync: true,
} as const

function readNumber(settings: GatewaySettings, path: string[], fallback: number): number | null {
  let cursor: unknown = settings
  for (const key of path) {
    if (!cursor || typeof cursor !== 'object') return fallback
    cursor = (cursor as Record<string, unknown>)[key]
    if (cursor === undefined) return fallback
  }
  return typeof cursor === 'number' ? cursor : null
}

async function show(): Promise<LocalCommandResult> {
  const result = await readGatewaySettings()
  if (!result.ok) return { type: 'text', value: `gateway-settings: ${result.reason}` }
  const { root, source } = vaultRootFor(result.settings)
  const mode = (result.settings.capture as { mode?: string } | undefined)?.mode ?? DEFAULTS.captureMode
  const every = readNumber(result.settings, ['capture', 'scribe', 'rotation', 'every'], DEFAULTS.rotationEvery)
  const maxAge = readNumber(result.settings, ['capture', 'scribe', 'rotation', 'maxAgeHours'], DEFAULTS.maxAgeHours)
  const maxEvents = readNumber(result.settings, ['capture', 'scribe', 'rotation', 'maxEvents'], DEFAULTS.maxEvents)
  const overdue = readNumber(result.settings, ['capture', 'obligations', 'overdueHours'], DEFAULTS.overdueHours)
  const rotation =
    maxAge === null || maxEvents === null
      ? `${every ?? DEFAULTS.rotationEvery} admissions (literal only)`
      : `${every ?? DEFAULTS.rotationEvery} admissions, or ${maxAge}h / ${maxEvents} events, whichever comes first`
  const lines = [
    `settings: ${result.path}${result.existed ? '' : ' (not created yet)'}`,
    `schemaVersion: ${typeof result.settings.schemaVersion === 'number' ? result.settings.schemaVersion : 1}`,
    `vaultRoot: ${root} (${source === 'settings' ? 'from settings' : 'install default'})`,
    `capture.mode: ${mode}`,
    `rotation: ${rotation}`,
    `obligations.overdueHours: ${overdue ?? DEFAULTS.overdueHours}`,
    `retrieval: ${DEFAULTS.engine}, embeddings ${DEFAULTS.embeddings ? 'enabled' : 'disabled'}`,
    `writer.fsync: ${DEFAULTS.fsync}`,
  ]
  return { type: 'text', value: lines.join('\n') }
}

async function setVaultRoot(value: string): Promise<LocalCommandResult> {
  if (!value.trim()) {
    return { type: 'text', value: 'usage: /gateway-settings vaultRoot <path>' }
  }
  const raw = value.trim()
  if (raw.split(/[\\/]/).includes('..')) {
    return { type: 'text', value: 'refused: vaultRoot must not contain ..; it must not depend on the working directory' }
  }
  const root = resolveInstallPath(raw)
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
  if ((POLICY as readonly string[]).includes(key ?? '')) {
    // These are read-only today: they are policy the harness reads as steps
    // 5-8 land, and a hand-edited value would claim a ruling that was never made.
    return {
      type: 'text',
      value: `'${key}' is read-only in this build; it is set by the harness, not by hand`,
    }
  }
  if (!(SETTABLE as readonly string[]).includes(key ?? '')) {
    return {
      type: 'text',
      value: `unknown setting '${key}'; settable: ${SETTABLE.join(', ')}; read-only: ${POLICY.join(', ')}`,
    }
  }
  if (key === 'vaultRoot') return setVaultRoot(rest.join(' '))
  return { type: 'text', value: `unknown setting '${key}'` }
}
