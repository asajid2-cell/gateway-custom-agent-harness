import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import path from 'node:path'

export type GatewayCredentialName = 'opencode-go' | 'ds'

const USER_HOME = process.env.USERPROFILE || process.env.HOME || ''
const KEYSAFE_SCRIPT = path.join(
  USER_HOME,
  '.claude',
  'skills',
  'keysafe',
  'scripts',
  'keysafe.ps1',
)

async function credentialPath(name: GatewayCredentialName): Promise<string> {
  return path.join(USER_HOME, '.keysafe', `${name}.cred`)
}

export async function hasGatewayCredential(
  name: GatewayCredentialName,
): Promise<boolean> {
  try {
    await access(await credentialPath(name))
    return true
  } catch {
    return false
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

export async function saveGatewayCredential(
  name: GatewayCredentialName,
  value: string,
): Promise<boolean> {
  if (!value.trim()) return false
  const result = await runKeysafe(['capture', name, '-FromStdin'], value)
  return result.code === 0
}

export async function removeGatewayCredential(
  name: GatewayCredentialName,
): Promise<boolean> {
  const result = await runKeysafe(['rm', name])
  return result.code === 0
}
