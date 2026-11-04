#!/usr/bin/env node
/**
 * Bundled-mode spawn helper for the model gateway.
 *
 * The supervisor starts this short-lived process instead of the gateway. It
 * decrypts the bundled vault, strips any inherited gateway key variables, then
 * spawns the gateway with the merged environment. Keys are never arguments and
 * never written anywhere: this process reads the vault, merges, and spawns.
 *
 * It exists as a separate process for two reasons:
 *  - the gateway still only ever reads `process.env`, and
 *  - a vault read can unlock DPAPI/Keychain/libsecret, which must not sit on the
 *    supervisor's restart path.
 *
 * A missing or empty vault is normal on a clean machine: the gateway starts and
 * /login fills the vault later. A locked or corrupt vault is not: this exits
 * with 78 (EX_CONFIG) and a diagnostic instead of starting a gateway that would
 * fail every provider request.
 *
 * Usage: node gateway-vault-launch.mjs <runner> <gateway> [args...]
 *
 * Positional, with no `--` separator: bun strips a bare `--` from a script's
 * argv, so the separator form silently produced an empty command under bun.
 */
import { spawn } from 'node:child_process'
import { defaultVaultDir, peekVault, secretsEnv } from './keysafe-vault.mjs'
import { stripGatewayKeys } from './gateway-keysafe.mjs'

const [file, ...args] = process.argv.slice(2)
if (!file) {
  process.stderr.write('gateway-vault-launch: missing gateway command\n')
  process.exit(64)
}

async function vaultOverlay() {
  const vaultDir = defaultVaultDir()
  // Observation only: a clean machine must not get a vault just because the
  // gateway started. Records appear only after /login saves a key.
  const peek = await peekVault(vaultDir)
  if (!peek.created || !peek.records) return {}
  return await secretsEnv({ vaultDir })
}

let overlay = {}
try {
  overlay = await vaultOverlay()
} catch (error) {
  process.stderr.write(
    `gateway-vault-launch: vault unavailable: ${(error && error.message) || error}\n`,
  )
  process.exit(78)
}

const env = { ...stripGatewayKeys(process.env), ...overlay }
const child = spawn(file, args, { env, stdio: 'inherit', windowsHide: true })

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    try {
      child.kill(signal)
    } catch {}
  })
}

child.on('error', error => {
  process.stderr.write(`gateway-vault-launch: spawn failed: ${error.message}\n`)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  // Propagate the reload exit code (75) and any other code the supervisor
  // keys off; a signalled death is re-raised so the supervisor sees it too.
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
