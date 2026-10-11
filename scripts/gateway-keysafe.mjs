/**
 * Live keysafe chain for the model gateway.
 *
 * The gateway only ever reads `process.env` (see model-gateway-spec.md): nobody
 * prints a key, and no key is ever an argument or a file. Keys reach the
 * gateway's environment through one short-lived keysafe child that injects
 * every vault record at once (keysafe run-many) - the same shape scripts/cc.ps1
 * builds once at launch.
 *
 * Building the chain only at launch is what made the credential set a snapshot:
 * a key added to ~/.keysafe afterwards stayed invisible until the next `cc`.
 * The supervisor now rebuilds the chain from the vault on every spawn, so a
 * reload (POST /gateway/reload-keys -> exit GATEWAY_RELOAD_EXIT_CODE) picks up
 * whatever is in ~/.keysafe at that moment. cc.ps1 is left alone: the supervisor
 * strips the gateway key variables it inherited and re-injects them from the
 * vault, so the vault stays the single source of truth and a key deleted from it
 * cannot survive as a stale inherited value.
 *
 * This module is pure and side-effect free so the supervisor, the gateway, and
 * the tests can all import it.
 */
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// A deliberate reload is not a crash. The gateway answers the reload request and
// then exits with this code; the supervisor treats it as an immediate restart
// and does not count it against the restart limit. 75 is EX_TEMPFAIL.
export const GATEWAY_RELOAD_EXIT_CODE = 75

export function keysafeHome() {
  return process.env.MODEL_GATEWAY_KEYSAFE_HOME || homedir()
}

export function keysafeScriptPath(home = keysafeHome()) {
  return process.env.MODEL_GATEWAY_KEYSAFE_SCRIPT || join(home, '.claude', 'skills', 'keysafe', 'scripts', 'keysafe.ps1')
}

export function keysafeVaultDir(home = keysafeHome()) {
  return join(home, '.keysafe')
}

// Non-OpenCode providers always sit in the chain when their vault record exists.
export const GATEWAY_KEY_ENV_VARS = ['DEEPSEEK_API_KEY', 'AMD_API_KEY', 'COMMANDCODE_API_KEY']

export function isGatewayKeyEnvVar(name) {
  return GATEWAY_KEY_ENV_VARS.includes(name) ||
    /^OPENCODE_API_KEY(?:[2-9]|[1-9][0-9]+)?$/.test(name) ||
    /^COMMANDCODE_API_KEY(?:[2-9]|[1-9][0-9]+)?$/.test(name)
}

function openCodeNumber(name) {
  return Number(name.slice('opencode-go'.length) || 1)
}

function commandCodeNumber(name) {
  return Number(name.slice('commandcode'.length) || 1)
}

/**
 * The provider records for this machine's vault: numbered OpenCode records,
 * then amd-ds, then numbered commandcode records, then the always-required ds
 * base layer. The order no longer affects nesting (one invocation injects them
 * all) but keeps the list stable for callers and tests.
 */
export function listKeysafeProviders(home = keysafeHome()) {
  let entries = []
  try {
    entries = readdirSync(keysafeVaultDir(home))
  } catch {
    return []
  }
  const names = new Set(
    entries.filter(entry => entry.endsWith('.cred')).map(entry => entry.slice(0, -'.cred'.length)),
  )
  const providers = []
  for (const name of [...names]
    .filter(name => /^opencode-go([2-9]|[1-9][0-9]+)?$/.test(name))
    .sort((a, b) => openCodeNumber(a) - openCodeNumber(b))) {
    providers.push({ credential: name, envVar: `OPENCODE_API_KEY${name.slice('opencode-go'.length)}` })
  }
  if (names.has('amd-ds')) providers.push({ credential: 'amd-ds', envVar: 'AMD_API_KEY' })
  for (const name of [...names]
    .filter(name => /^commandcode([2-9]|[1-9][0-9]+)?$/.test(name))
    .sort((a, b) => commandCodeNumber(a) - commandCodeNumber(b))) {
    providers.push({ credential: name, envVar: `COMMANDCODE_API_KEY${name.slice('commandcode'.length)}` })
  }
  if (names.has('ds')) providers.push({ credential: 'ds', envVar: 'DEEPSEEK_API_KEY' })
  return providers
}

export function stripGatewayKeys(env) {
  const next = { ...env }
  for (const name of Object.keys(next)) {
    if (isGatewayKeyEnvVar(name)) delete next[name]
  }
  return next
}

const psQuote = value => `'${String(value).replace(/'/g, "''")}'`

/**
 * Resolve how the supervisor should spawn the gateway.
 *
 * Returns { file, args, env }. With no vault records (or off Windows, or a
 * missing keysafe script) it is a plain `node <gateway>` spawn with the
 * inherited environment untouched, so development and the supervisor tests do
 * not need a vault. With records it is a powershell.exe invocation of one
 * keysafe layer (run-many) that injects every record into the gateway; the
 * environment handed to it has the inherited gateway key variables removed so
 * the fresh injection is the only source.
 */
export function buildGatewayLaunch({
  gatewayPath,
  gatewayArgs = [],
  nodePath = process.execPath,
  home = keysafeHome(),
  env = process.env,
  platform = process.platform,
} = {}) {
  if (!gatewayPath) throw new Error('buildGatewayLaunch requires gatewayPath')
  const providers = listKeysafeProviders(home)
  const keysafe = keysafeScriptPath(home)
  if (platform !== 'win32' || providers.length === 0 || !existsSync(keysafe)) {
    return { file: nodePath, args: [gatewayPath, ...gatewayArgs], env }
  }

  // `&` is required: a single-quoted path is a string expression, not a command,
  // so a bare quoted executable would be a parse error in the child PowerShell.
  const command = `& ${[nodePath, gatewayPath, ...gatewayArgs].map(psQuote).join(' ')}`
  // One keysafe invocation injects every record into the single gateway process,
  // so the gateway is reached through one PowerShell wrapper instead of a nested
  // chain of one wrapper per key.
  const inject = providers.map(provider => `${provider.credential}=${provider.envVar}`).join(';')
  return {
    file: 'powershell.exe',
    args: [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      keysafe,
      'run-many',
      '-Inject',
      inject,
      '-Command',
      command,
    ],
    env: stripGatewayKeys(env),
  }
}

export function gatewayKeyInjectScriptPath() {
  return process.env.MODEL_GATEWAY_KEY_INJECT_SCRIPT ||
    fileURLToPath(new URL('./gateway-key-inject.mjs', import.meta.url))
}

/**
 * Resolve the short-lived keysafe child that heals a running gateway.
 *
 * When a new numbered record appears in the vault, one keysafe invocation for
 * that record is enough: it decrypts the key into the child's environment, and
 * the child (gateway-key-inject.mjs) posts it to the running gateway's
 * /gateway/keys route, which parks it in a transient overlay for the life of
 * that process. The key is never an argument, never a file, and never printed;
 * the ordinary keysafe chain still supplies it on the next spawn, so nothing
 * about the overlay is persisted.
 */
export function buildKeyInjectLaunch({
  credential,
  envVar,
  port,
  nodePath = process.execPath,
  home = keysafeHome(),
  env = process.env,
  platform = process.platform,
} = {}) {
  if (!credential || !envVar || !port) {
    throw new Error('buildKeyInjectLaunch requires credential, envVar and port')
  }
  const script = gatewayKeyInjectScriptPath()
  const command = `& ${[nodePath, script, envVar, String(port)].map(psQuote).join(' ')}`
  const keysafe = keysafeScriptPath(home)
  if (platform !== 'win32' || !existsSync(keysafe)) {
    return { file: nodePath, args: [script, envVar, String(port)], env }
  }
  return {
    file: 'powershell.exe',
    args: [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      keysafe,
      'run',
      credential,
      '-EnvVar',
      envVar,
      '-Command',
      command,
    ],
    env: stripGatewayKeys(env),
  }
}
