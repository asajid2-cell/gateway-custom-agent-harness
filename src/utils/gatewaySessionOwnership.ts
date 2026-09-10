import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { lock } from './lockfile.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { registerCleanup } from './cleanupRegistry.js'

const claims = new Map<string, Promise<() => Promise<void>>>()

export async function claimGatewaySessionWriter(sessionId: string): Promise<void> {
  if (process.env.CLAUDE_CODE_USE_GATEWAY !== '1') return
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error('Invalid session identity')
  const directory = join(getClaudeConfigHomeDir(), 'gateway-writers')
  const path = join(directory, sessionId)
  let claim = claims.get(path)
  if (!claim) {
    claim = (async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      return lock(path, { realpath: false, stale: 30000, retries: 0 })
    })()
    claims.set(path, claim)
    claim.catch(() => { if (claims.get(path) === claim) claims.delete(path) })
  }
  await claim
}

export async function releaseGatewaySessionWriter(sessionId: string): Promise<void> {
  const path = join(getClaudeConfigHomeDir(), 'gateway-writers', sessionId)
  const claim = claims.get(path)
  if (!claim) return
  await (await claim)()
  if (claims.get(path) === claim) claims.delete(path)
}

registerCleanup(async () => {
  await (await import('./sessionStorage.js')).flushSessionStorage()
  for (const [path, claim] of claims) {
    try { await (await claim)() } finally { claims.delete(path) }
  }
})
