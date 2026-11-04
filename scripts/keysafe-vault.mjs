/**
 * Bundled keysafe: the gateway-owned credential vault.
 *
 * This module is deliberately plain JavaScript with no imports outside node:
 * builtins. The supervisor (scripts/gateway-supervisor.mjs), the launcher
 * (scripts/cc-launcher.mjs) and the TS CLI all need the same vault, and the
 * supervisor must not gain a bun/TS build dependency. The TS surface in
 * src/utils/keysafe/index.ts is a thin typed facade over this file.
 *
 * Storage model
 *   <vault>/<name>.json   one AES-256-GCM record per provider credential
 *   <vault>/master.*      the per-machine master key, held by a platform backend
 *
 * Record names are the external keysafe's names (opencode-go, opencode-go2,
 * ds, amd-ds, commandcode, commandcode2, openrouter), so GATEWAY_CREDENTIALS_MODE
 * changes where a credential lives, never what a consumer asks for.
 *
 * Plaintext is never written. Secrets move on stdin to platform helpers, never
 * in argv, and the master key never appears in an error message.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const KEY_BYTES = 32
const SERVICE = 'gateway-keysafe'

const OPENCODE = /^opencode-go([2-9]|[1-9][0-9]+)?$/
const COMMANDCODE = /^commandcode([2-9]|[1-9][0-9]+)?$/

const masterKeyCache = new Map()

/** @param {string} name */
export function envVarForRecord(name) {
  if (OPENCODE.test(name)) return `OPENCODE_API_KEY${name.slice('opencode-go'.length)}`
  if (COMMANDCODE.test(name)) return `COMMANDCODE_API_KEY${name.slice('commandcode'.length)}`
  switch (name) {
    case 'ds':
      return 'DEEPSEEK_API_KEY'
    case 'amd-ds':
      return 'AMD_API_KEY'
    case 'openrouter':
      return 'OPENROUTER_API_KEY'
    default:
      return null
  }
}

/** @param {string} name */
export function isValidRecordName(name) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)
}

/** @param {NodeJS.ProcessEnv} [env] */
export function defaultVaultDir(env = process.env) {
  const configDir = env.CLAUDE_CONFIG_DIR
  const home = env.USERPROFILE || env.HOME || ''
  return path.join(configDir || path.join(home, '.claude'), 'keysafe')
}

export function clearMasterKeyCache() {
  masterKeyCache.clear()
}

// ---------------------------------------------------------------------------
// mode resolution (one axis, two dimensions, no silent fallback)
// ---------------------------------------------------------------------------

function parseMode(value, name) {
  if (value === undefined || value === null || String(value).trim() === '') return null
  const mode = String(value).trim().toLowerCase()
  if (mode !== 'bundled' && mode !== 'external') {
    throw new Error(`${name} must be "bundled" or "external", got "${value}"`)
  }
  return mode
}

/** @param {NodeJS.ProcessEnv} [env] */
export function gatewayCredentialsMode(env = process.env) {
  return parseMode(env.GATEWAY_CREDENTIALS_MODE, 'GATEWAY_CREDENTIALS_MODE') ?? 'bundled'
}

/** @param {NodeJS.ProcessEnv} [env] */
export function keysafeMode(env = process.env) {
  return parseMode(env.GATEWAY_KEYSAFE_MODE, 'GATEWAY_KEYSAFE_MODE') ?? gatewayCredentialsMode(env)
}

/** @param {NodeJS.ProcessEnv} [env] */
export function oauthMode(env = process.env) {
  return parseMode(env.GATEWAY_OAUTH_MODE, 'GATEWAY_OAUTH_MODE') ?? gatewayCredentialsMode(env)
}

/**
 * The resolved matrix an operator can inspect. Values only, never secrets.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function credentialModeMatrix(env = process.env) {
  return {
    mode: gatewayCredentialsMode(env),
    keysafe: keysafeMode(env),
    oauth: oauthMode(env),
    vaultDir: defaultVaultDir(env),
  }
}

// ---------------------------------------------------------------------------
// platform helpers (secret on stdin, never argv)
// ---------------------------------------------------------------------------

export const defaultRun = (file, args, stdin) =>
  new Promise(resolve => {
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.on('error', error => resolve({ code: 127, stdout, stderr: `${stderr}${error.message}` }))
    child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }))
    child.stdin.end(stdin)
  })

const DPAPI_PROTECT = [
  'Add-Type -AssemblyName System.Security | Out-Null',
  '$raw = [Console]::In.ReadToEnd().Trim()',
  '$bytes = [Convert]::FromBase64String($raw)',
  '$out = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Convert]::ToBase64String($out))',
].join('; ')

const DPAPI_UNPROTECT = [
  'Add-Type -AssemblyName System.Security | Out-Null',
  '$raw = [Console]::In.ReadToEnd().Trim()',
  '$bytes = [Convert]::FromBase64String($raw)',
  '$out = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Convert]::ToBase64String($out))',
].join('; ')

function requireSuccess(result, what) {
  if (result.code !== 0) {
    throw new Error(`keysafe: ${what} failed (exit ${result.code}): ${String(result.stderr).trim().slice(0, 300)}`)
  }
  return String(result.stdout).trim()
}

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') await chmod(dir, 0o700).catch(() => {})
}

async function writePrivate(file, contents) {
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, contents, { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, file)
  if (process.platform !== 'win32') await chmod(file, 0o600).catch(() => {})
}

function accountFor(vaultDir) {
  return createHash('sha256').update(path.resolve(vaultDir)).digest('hex').slice(0, 16)
}

async function dpapiMasterKey(vaultDir, run) {
  const file = path.join(vaultDir, 'master.dpapi')
  try {
    const sealed = (await readFile(file, 'utf8')).trim()
    const raw = requireSuccess(
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', DPAPI_UNPROTECT], sealed),
      'unsealing the DPAPI master key',
    )
    const key = Buffer.from(raw, 'base64')
    assertKey(key)
    return key
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const key = randomBytes(KEY_BYTES)
  const sealed = requireSuccess(
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', DPAPI_PROTECT], key.toString('base64')),
    'sealing the DPAPI master key',
  )
  await writePrivate(file, sealed)
  return key
}

async function keychainMasterKey(vaultDir, run) {
  const account = accountFor(vaultDir)
  const lookup = await run('security', ['-i'], `find-generic-password -s ${SERVICE} -a ${account} -w\n`)
  if (lookup.code === 0 && String(lookup.stdout).trim()) {
    const key = Buffer.from(String(lookup.stdout).trim(), 'base64')
    assertKey(key)
    return key
  }
  const key = randomBytes(KEY_BYTES)
  requireSuccess(
    await run('security', ['-i'], `add-generic-password -U -s ${SERVICE} -a ${account} -w ${key.toString('base64')}\n`),
    'storing the Keychain master key',
  )
  return key
}

async function libsecretMasterKey(vaultDir, run) {
  const account = accountFor(vaultDir)
  const lookup = await run('secret-tool', ['lookup', 'service', SERVICE, 'account', account], '')
  if (lookup.code === 0 && String(lookup.stdout).trim()) {
    const key = Buffer.from(String(lookup.stdout).trim(), 'base64')
    assertKey(key)
    return key
  }
  const key = randomBytes(KEY_BYTES)
  requireSuccess(
    await run(
      'secret-tool',
      ['store', '--label=Gateway keysafe', 'service', SERVICE, 'account', account],
      key.toString('base64'),
    ),
    'storing the libsecret master key',
  )
  return key
}

async function fileMasterKey(vaultDir) {
  const file = path.join(vaultDir, 'master.key')
  try {
    const key = Buffer.from((await readFile(file, 'utf8')).trim(), 'hex')
    assertKey(key)
    return key
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const key = randomBytes(KEY_BYTES)
  await writePrivate(file, key.toString('hex'))
  return key
}

function assertKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new Error(`keysafe: a master key must be ${KEY_BYTES} bytes, got ${key?.length ?? 'none'}`)
  }
}

/**
 * @param {{vaultDir?: string, backend?: 'dpapi'|'keychain'|'libsecret'|'file', platform?: NodeJS.Platform, run?: Function}} [options]
 * @returns {Promise<{key: Buffer, backend: string, warning?: string}>}
 */
export async function resolveMasterKey(options = {}) {
  const vaultDir = options.vaultDir ?? defaultVaultDir()
  const cached = masterKeyCache.get(vaultDir)
  if (cached && (!options.backend || options.backend === cached.backend)) return cached

  await ensureDir(vaultDir)
  const run = options.run ?? defaultRun
  const platform = options.platform ?? process.platform
  const backend =
    options.backend ?? (platform === 'win32' ? 'dpapi' : platform === 'darwin' ? 'keychain' : 'libsecret')

  let resolved
  if (backend === 'dpapi') {
    resolved = { key: await dpapiMasterKey(vaultDir, run), backend }
  } else if (backend === 'keychain') {
    resolved = { key: await keychainMasterKey(vaultDir, run), backend }
  } else if (backend === 'libsecret') {
    try {
      resolved = { key: await libsecretMasterKey(vaultDir, run), backend }
    } catch (error) {
      // No D-Bus session / no keyring: the documented fallback, never silent.
      const warning =
        `keysafe: libsecret is unavailable (${String(error?.message ?? error).slice(0, 160)}); ` +
        'using a 0600 master-key file in the config directory'
      resolved = { key: await fileMasterKey(vaultDir), backend: 'file', warning }
    }
  } else {
    resolved = { key: await fileMasterKey(vaultDir), backend: 'file' }
  }
  masterKeyCache.set(vaultDir, resolved)
  return resolved
}

// ---------------------------------------------------------------------------
// records
// ---------------------------------------------------------------------------

function recordPath(vaultDir, name) {
  return path.join(vaultDir, `${name}.json`)
}

function assertRecordName(name) {
  if (!isValidRecordName(name)) throw new Error(`keysafe: invalid record name "${name}"`)
  if (!envVarForRecord(name)) throw new Error(`keysafe: unknown credential "${name}"`)
}

function sealRecord(key, name, plaintext) {
  if (!plaintext) throw new Error('keysafe: refusing to store an empty secret')
  const nonce = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, nonce)
  cipher.setAAD(Buffer.from(name, 'utf8'))
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return {
    nonce: nonce.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  }
}

function openRecord(key, name, sealed) {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(sealed.nonce, 'base64'))
  decipher.setAAD(Buffer.from(name, 'utf8'))
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString(
    'utf8',
  )
}

async function readRecordFile(vaultDir, name) {
  try {
    const record = JSON.parse(await readFile(recordPath(vaultDir, name), 'utf8'))
    if (record?.version !== 1 || record?.name !== name || record?.cipher !== ALGORITHM) {
      throw new Error(`keysafe: record "${name}" has an unsupported shape`)
    }
    return record
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function writeRecordFile(vaultDir, record) {
  const file = recordPath(vaultDir, record.name)
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, file)
  if (process.platform !== 'win32') await chmod(file, 0o600).catch(() => {})
}

/** @param {string} name @param {string} secret */
export async function captureSecret(name, secret, options = {}) {
  assertRecordName(name)
  const value = String(secret).trim()
  if (!value) throw new Error(`keysafe: refusing to store an empty secret for "${name}"`)
  const vaultDir = options.vaultDir ?? defaultVaultDir()
  await ensureDir(vaultDir)
  const { key } = await resolveMasterKey({ ...options, vaultDir })
  const envVar = envVarForRecord(name)
  const existing = await readRecordFile(vaultDir, name)
  const now = new Date().toISOString()
  await writeRecordFile(vaultDir, {
    version: 1,
    name,
    envVar,
    cipher: ALGORITHM,
    ...sealRecord(key, name, value),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  })
}

/** @param {string} name */
export async function readSecret(name, options = {}) {
  assertRecordName(name)
  const vaultDir = options.vaultDir ?? defaultVaultDir()
  const record = await readRecordFile(vaultDir, name)
  if (!record) return null
  const { key } = await resolveMasterKey({ ...options, vaultDir })
  return openRecord(key, name, record)
}

/** @param {string} name */
export async function hasSecret(name, options = {}) {
  assertRecordName(name)
  return (await readRecordFile(options.vaultDir ?? defaultVaultDir(), name)) !== null
}

/** @param {string} name */
export async function removeSecret(name, options = {}) {
  assertRecordName(name)
  const vaultDir = options.vaultDir ?? defaultVaultDir()
  if (!(await readRecordFile(vaultDir, name))) return false
  await rm(recordPath(vaultDir, name), { force: true })
  return true
}

export async function listSecrets(options = {}) {
  const vaultDir = options.vaultDir ?? defaultVaultDir()
  let entries
  try {
    entries = await readdir(vaultDir)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const records = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const name = entry.slice(0, -'.json'.length)
    if (!isValidRecordName(name) || !envVarForRecord(name)) continue
    const record = await readRecordFile(vaultDir, name)
    if (record) records.push({ name, envVar: record.envVar, updatedAt: record.updatedAt })
  }
  return records.sort((a, b) => a.name.localeCompare(b.name))
}

/** The environment overlay for a gateway child. */
export async function secretsEnv(options = {}) {
  const env = {}
  for (const entry of await listSecrets(options)) {
    const secret = await readSecret(entry.name, options)
    if (secret) env[entry.envVar] = secret
  }
  return env
}
