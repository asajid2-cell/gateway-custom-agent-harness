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
} from './keysafe/index.js'

export type GatewayCredentialName = 'opencode-go' | 'ds' | 'commandcode' | 'openrouter'

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

/**
 * External mode on POSIX is the launcher's `~/.claude/gateway.env`, not
 * PowerShell. That file is the source of truth cc-launcher already reads.
 */
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
export async function hasGatewayCredential(
  name: GatewayCredentialName,
): Promise<boolean> {
  const envVar = envVarForRecord(name)
  if (!envVar) throw new Error(`Unknown gateway credential: ${name}`)
  if (keysafeMode() === 'bundled') {
    return hasSecret(name)
  }
  if (process.platform === 'win32') {
    return externalWindowsHas(name)
  }
  return externalPosixHas(name)
}

/**
 * Save through the selected store. External mode is read-only on POSIX: that
 * file belongs to the launcher/installer, and silently rewriting it would make
 * the two credential sources disagree.
 */
export async function saveGatewayCredential(
  name: GatewayCredentialName,
  value: string,
): Promise<boolean> {
  if (!value.trim()) return false
  if (keysafeMode() === 'bundled') {
    await captureSecret(name, value)
    return true
  }
  if (process.platform !== 'win32') return false
  const result = await runKeysafe(['capture', name, '-FromStdin'], value)
  return result.code === 0
}

export async function removeGatewayCredential(
  name: GatewayCredentialName,
): Promise<boolean> {
  if (keysafeMode() === 'bundled') {
    return removeSecret(name)
  }
  if (process.platform !== 'win32') return false
  const result = await runKeysafe(['rm', name])
  return result.code === 0
}

/** What `/login status` shows. Values only, never secret values. */
export function gatewayCredentialMode() {
  return credentialModeMatrix()
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

function externalWindowsHas(name: GatewayCredentialName): Promise<boolean> {
  // The external vault stores one record file per credential name. Presence is
  // a list-and-match over the external script, never a value read.
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
    child.on('error', () => resolve(false))
    child.on('close', code => resolve(code === 0 && out.includes(name)))
  })
}
