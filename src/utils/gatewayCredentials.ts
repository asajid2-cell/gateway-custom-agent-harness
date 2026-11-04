import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  captureSecret,
  credentialModeMatrix,
  envVarForRecord,
  hasSecret,
  keysafeMode,
  removeSecret,
  resolveMasterKey,
  type CredentialMode,
} from './keysafe/index.js'

export type GatewayCredentialName = 'opencode-go' | 'ds' | 'commandcode' | 'openrouter'

export type CredentialResult = {
  ok: boolean
  mode: CredentialMode
  /** Where the credential was found or written, named for the operator. */
  source: string
  reason?: string
}

const USER_HOME = process.env.USERPROFILE || process.env.HOME || ''
const KEYSAFE_SCRIPT = path.join(
  USER_HOME,
  '.claude',
  'skills',
  'keysafe',
  'scripts',
  'keysafe.ps1',
)

function externalGatewayEnvPath(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR
  return path.join(configured || path.join(USER_HOME, '.claude'), 'gateway.env')
}

function sourceFor(mode: CredentialMode): string {
  if (mode === 'bundled') return 'bundled vault'
  return process.platform === 'win32' ? 'external keysafe' : 'external gateway.env'
}

async function externalPosixHas(name: GatewayCredentialName): Promise<boolean> {
  const envVar = envVarForRecord(name)
  if (!envVar) return false
  try {
    const raw = await readFile(externalGatewayEnvPath(), 'utf8')
    return new RegExp(`^\\s*(?:export\\s+)?${envVar}=`, 'm').test(raw)
  } catch {
    return false
  }
}

/** Presence is mode-aware: the bundled vault or the selected external source. */
export async function gatewayCredentialStatus(
  name: GatewayCredentialName,
): Promise<CredentialResult & { present: boolean }> {
  const envVar = envVarForRecord(name)
  const mode = keysafeMode()
  if (!envVar) {
    return { ok: false, present: false, mode, source: sourceFor(mode), reason: 'unknown credential' }
  }
  if (mode === 'bundled') {
    const present = await hasSecret(name)
    return { ok: true, present, mode, source: sourceFor(mode) }
  }
  if (process.platform === 'win32') {
    const present = await externalWindowsList().then(names => names.includes(name))
    return { ok: true, present, mode, source: sourceFor(mode) }
  }
  const present = await externalPosixHas(name)
  return { ok: true, present, mode, source: sourceFor(mode) }
}

export async function hasGatewayCredential(
  name: GatewayCredentialName,
): Promise<boolean> {
  return (await gatewayCredentialStatus(name)).present
}

/**
 * Save through the selected store and report where it went. External mode is
 * read-only on POSIX: that file belongs to the launcher/installer, and silently
 * rewriting it would make the two credential sources disagree.
 */
export async function saveGatewayCredential(
  name: GatewayCredentialName,
  value: string,
): Promise<CredentialResult> {
  const mode = keysafeMode()
  if (!value.trim()) {
    return { ok: false, mode, source: sourceFor(mode), reason: 'a non-empty key is required' }
  }
  if (mode === 'bundled') {
    try {
      await captureSecret(name, value)
      return { ok: true, mode, source: sourceFor(mode) }
    } catch (error) {
      return {
        ok: false,
        mode,
        source: sourceFor(mode),
        reason: (error as Error).message.slice(0, 300),
      }
    }
  }
  if (process.platform !== 'win32') {
    return {
      ok: false,
      mode,
      source: sourceFor(mode),
      reason:
        'external mode on this platform is read-only; the launcher owns ' +
        externalGatewayEnvPath(),
    }
  }
  const result = await runKeysafe(['capture', name, '-FromStdin'], value)
  return result.code === 0
    ? { ok: true, mode, source: sourceFor(mode) }
    : { ok: false, mode, source: sourceFor(mode), reason: `external keysafe exited ${result.code}` }
}

export async function removeGatewayCredential(
  name: GatewayCredentialName,
): Promise<CredentialResult> {
  const mode = keysafeMode()
  if (mode === 'bundled') {
    try {
      const removed = await removeSecret(name)
      return { ok: removed, mode, source: sourceFor(mode), reason: removed ? undefined : 'not present' }
    } catch (error) {
      return { ok: false, mode, source: sourceFor(mode), reason: (error as Error).message.slice(0, 300) }
    }
  }
  if (process.platform !== 'win32') {
    return {
      ok: false,
      mode,
      source: sourceFor(mode),
      reason: 'external mode on this platform is read-only',
    }
  }
  const result = await runKeysafe(['rm', name])
  return result.code === 0
    ? { ok: true, mode, source: sourceFor(mode) }
    : { ok: false, mode, source: sourceFor(mode), reason: `external keysafe exited ${result.code}` }
}

/** Sync mode matrix. Backend discovery is async; use describeCredentialStore. */
export function gatewayCredentialModes() {
  return credentialModeMatrix()
}

/** What `/login status` and `cc doctor` print. Never values. */
export async function describeCredentialStore() {
  const matrix = credentialModeMatrix()
  if (matrix.keysafe === 'external') {
    return { ...matrix, backend: process.platform === 'win32' ? 'external-keysafe' : 'external-gateway-env' }
  }
  try {
    const resolved = await resolveMasterKey()
    return { ...matrix, backend: resolved.backend, warning: resolved.warning }
  } catch (error) {
    return { ...matrix, backend: 'unavailable', warning: (error as Error).message.slice(0, 300) }
  }
}

function runKeysafe(
  args: string[],
  input?: string,
): Promise<{ code: number }> {
  return new Promise(resolve => {
    const child = spawn(
      process.env.ComSpec ? 'powershell.exe' : 'pwsh',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', KEYSAFE_SCRIPT, ...args],
      {
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true,
      },
    )
    child.on('error', () => resolve({ code: 1 }))
    child.on('close', code => resolve({ code: code ?? 1 }))
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

/**
 * Exact names from `keysafe.ps1 list`. A substring test would confuse `ds` with
 * `amd-ds` and `commandcode` with `commandcode2`.
 */
function externalWindowsList(): Promise<string[]> {
  return new Promise(resolve => {
    let out = ''
    const child = spawn(
      process.env.ComSpec ? 'powershell.exe' : 'pwsh',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', KEYSAFE_SCRIPT, 'list'],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
    )
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      out += chunk
    })
    child.on('error', () => resolve([]))
    child.on('close', () => {
      const names: string[] = []
      for (const line of out.split(/\r?\n/)) {
        const match = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s+\(stored\b/.exec(line)
        if (match) names.push(match[1])
      }
      resolve(names)
    })
  })
}
