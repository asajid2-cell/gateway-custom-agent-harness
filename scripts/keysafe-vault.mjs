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
 * Provider records are never plaintext. Secrets move on stdin to platform
 * helpers, never in argv, and the master key never appears in an error message.
 * Scope: this guarantee covers the provider records only. The `file` backend
 * necessarily holds the master key in a 0600 file and protects it by file
 * permissions alone; OAuth tokens stay in their native locations and are not
 * covered by this vault.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, link, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const KEY_BYTES = 32
const SERVICE = 'gateway-keysafe'

const OPENCODE = /^opencode-go([2-9]|[1-9][0-9]+)?$/
const COMMANDCODE = /^commandcode([2-9]|[1-9][0-9]+)?$/

const masterKeyCache = new Map()

/** @param {string} name */
export function envVarForRecord(name) {
  // Exact-case, exact-pattern matches only. Do not widen this to a case-folding
  // substring test: `DS` and `ds` are the same file on NTFS, so a loose match
  // would let a future provider name collide with an existing record.
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

const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * @param {string} name
 * NTFS makes `foo.` and `foo` the same file, and CON/NUL/etc are devices.
 * A name is also a filename and part of the GCM AAD, so keep one canonical
 * spelling: no trailing dot/space, no reserved device names.
 */
export function isValidRecordName(name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) return false
  if (/[. ]$/.test(name)) return false
  if (RESERVED_NAMES.test(name)) return false
  return true
}

/** @param {NodeJS.ProcessEnv} [env] */
export function defaultVaultDir(env = process.env) {
  const configDir = env.CLAUDE_CONFIG_DIR
  let home = env.USERPROFILE || env.HOME
  if (!home) {
    try {
      home = os.homedir()
    } catch {
      home = ''
    }
  }
  if (!configDir && !home) {
    throw new Error('keysafe: cannot resolve a home directory; set CLAUDE_CONFIG_DIR or HOME')
  }
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

export const HELPER_TIMEOUT_MS = 15_000

/**
 * The unlock helpers need a shell's search path and a GUI session's keyring
 * socket; nothing else from the parent environment. Handing over the whole
 * environment would leak provider keys into a PowerShell child for no reason.
 */
const HELPER_ENV_KEYS = [
  'PATH', 'Path',
  'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC',
  'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP',
  'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'DISPLAY', 'WAYLAND_DISPLAY',
  'LANG', 'LC_ALL',
]

function helperEnv() {
  const env = {}
  for (const key of HELPER_ENV_KEYS) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

/**
 * A helper that never returns is a locked keychain or a blocked D-Bus prompt,
 * not a slow vault. Bound every call and classify the timeout distinctly.
 */
export const defaultRun = (file, args, stdin) =>
  new Promise(resolve => {
    const child = spawn(file, args, { env: helperEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = result => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ code: 124, stdout, stderr: `${stderr}keysafe: helper timed out after ${HELPER_TIMEOUT_MS}ms` })
    }, HELPER_TIMEOUT_MS)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.on('error', error => finish({ code: 127, stdout, stderr: `${stderr}${error.message}` }))
    child.on('close', code => finish({ code: code ?? 1, stdout, stderr }))
    // A helper that exits early (policy block, fast failure) makes the write
    // raise EPIPE; without a handler that is an unhandled stream error.
    child.stdin.on('error', () => {})
    try {
      child.stdin.end(stdin)
    } catch {
      // The close/error handler above reports the outcome.
    }
  })

const LOCKED_HINT =
  /errSecInteractionNotAllowed|-25308|errSecAuthFailed|-25293|interaction not allowed|keychain is locked|could not switch to audit session/i
const NOT_FOUND_HINT =
  /errSecItemNotFound|-25300|The specified item could not be found|could not be found|No such secret|no such object/i

function lockedError(what, detail, code = 'KEYSAFE_LOCKED') {
  const error = new Error(
    `keysafe: [KEYSAFE_LOCKED] ${what} could not be read; the credential store is locked ` +
      `or unavailable. Unlock it in the user's GUI session and retry. ${String(detail).trim().slice(0, 240)}`,
  )
  error.code = code
  return error
}

// Only this one failure permits a fresh-vault fallback: the store exists but
// this process is outside the session allowed to use it (ssh, no GUI session).
const INTERACTION_HINT =
  /errSecInteractionNotAllowed|-25308|interaction not allowed|could not switch to audit session/i

async function vaultHasRecords(vaultDir) {
  try {
    const entries = await readdir(vaultDir)
    return entries.some(entry => entry.endsWith('.json'))
  } catch {
    return false
  }
}

/** The backend that created a vault is recorded once and is sticky. */
async function readVaultMeta(vaultDir) {
  try {
    const meta = JSON.parse(await readFile(path.join(vaultDir, 'vault.meta'), 'utf8'))
    if (meta?.version === 1 && typeof meta.backend === 'string') return meta
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return null
}

async function writeVaultMeta(vaultDir, backend, extra = {}) {
  // aclVersion records that the files passed the DACL pass in this process, so
  // the next process does not repeat one icacls spawn per record.
  const aclVersion = process.platform === 'win32' && hardenedFiles.has(vaultDir) ? 1 : 0
  await writePrivate(
    path.join(vaultDir, 'vault.meta'),
    `${JSON.stringify({ version: 1, backend, aclVersion, ...extra })}\n`,
  )
}

/** Persist a field into an existing meta; a no-op before the meta is created. */
async function updateVaultMeta(vaultDir, patch) {
  const meta = await readVaultMeta(vaultDir).catch(() => null)
  if (!meta) return
  await writePrivate(
    path.join(vaultDir, 'vault.meta'),
    `${JSON.stringify({ ...meta, ...patch })}\n`,
  )
}

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
    const error = new Error(
      `keysafe: ${what} failed (exit ${result.code}): ${String(result.stderr).trim().slice(0, 300)}`,
    )
    // A hung helper is not a locked store: it must not be reported as LOCKED,
    // which would send the operator looking for the wrong problem.
    error.code = result.code === 124 ? 'KEYSAFE_HELPER_TIMEOUT' : 'KEYSAFE_HELPER_FAILED'
    throw error
  }
  return String(result.stdout).trim()
}

const hardenedDirs = new Set()
const hardenedFiles = new Set()

/** Test-only seam; ignored in a production run so it cannot disable hardening. */
function aclSkip() {
  return process.env.KEYSAFE_SKIP_ACL === '1' && process.env.NODE_ENV === 'test'
}

// Well-known SIDs: `SYSTEM` and `BUILTIN\Administrators` are localized on a
// non-English Windows, while the SID form always resolves.
const ACL_SYSTEM = '*S-1-5-18'
const ACL_ADMINISTRATORS = '*S-1-5-32-544'

function windowsPrincipal() {
  const user = process.env.USERNAME || os.userInfo().username
  const domain = process.env.USERDOMAIN
  return domain && domain.toLowerCase() !== user.toLowerCase() ? `${domain}\\${user}` : user
}

/**
 * A protected DACL on the vault directory: no inherited ACEs, then explicit
 * full control for the current user, SYSTEM and Administrators, propagating to
 * descendants. This is what removes an inherited CodexSandboxUsers grant.
 * New files created inside inherit these ACEs; chmod(0600) is not enough here.
 */
async function hardenWindowsAcl(dir, run = defaultRun) {
  if (process.platform !== 'win32' || hardenedDirs.has(dir) || aclSkip()) {
    return
  }
  const principal = windowsPrincipal()
  const result = await run(
    'icacls',
    [
      dir,
      '/inheritance:r',
      '/grant:r',
      `${principal}:(OI)(CI)F`,
      '/grant:r',
      `${ACL_SYSTEM}:(OI)(CI)F`,
      '/grant:r',
      `${ACL_ADMINISTRATORS}:(OI)(CI)F`,
    ],
    '',
  )
  if (result.code !== 0) {
    throw new Error(
      `keysafe: could not protect the vault directory ACL (exit ${result.code}): ` +
        `${String(result.stderr).trim().slice(0, 240)}`,
    )
  }
  hardenedDirs.add(dir)
}

/**
 * A vault that predates the DACL fix keeps inherited ACEs on its files even
 * after the directory is protected. Run the file pass once, then record it in
 * vault.meta so later processes do not shell out per record.
 */
async function hardenWindowsFiles(dir, run) {
  if (process.platform !== 'win32' || hardenedFiles.has(dir) || aclSkip()) {
    return
  }
  const meta = await readVaultMeta(dir).catch(() => null)
  if (meta?.aclVersion === 1) {
    hardenedFiles.add(dir)
    return
  }
  let entries
  try {
    entries = await readdir(dir)
  } catch {
    return
  }
  const principal = windowsPrincipal()
  let failure = null
  for (const entry of entries) {
    if (entry.endsWith('.tmp')) continue
    const result = await run(
      'icacls',
      [
        path.join(dir, entry),
        '/inheritance:r',
        '/grant:r',
        `${principal}:(F)`,
        '/grant:r',
        `${ACL_SYSTEM}:(F)`,
        '/grant:r',
        `${ACL_ADMINISTRATORS}:(F)`,
      ],
      '',
    )
    if (result.code !== 0 && !failure) {
      // Keep hardening the rest; report the first failure at the end so one
      // locked file does not leave every later record unprotected too.
      failure = new Error(
        `keysafe: could not protect ${entry} (exit ${result.code}): ` +
          `${String(result.stderr).trim().slice(0, 200)}`,
      )
    }
  }
  if (failure) throw failure
  hardenedFiles.add(dir)
  await updateVaultMeta(dir, { aclVersion: 1 })
}

async function ensureDir(dir, run = defaultRun) {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') await chmod(dir, 0o700).catch(() => {})
  await hardenWindowsAcl(dir, run)
  await hardenWindowsFiles(dir, run)
}

async function replaceFile(tmp, file) {
  // Windows fails a replace with EPERM/EBUSY while a reader holds the target.
  // Bounded retry; anything else is a real error.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(tmp, file)
      return
    } catch (error) {
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) throw error
      await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)))
    }
  }
}

async function writePrivate(file, contents) {
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(tmp, contents, { encoding: 'utf8', mode: 0o600 })
  await replaceFile(tmp, file)
  if (process.platform !== 'win32') await chmod(file, 0o600).catch(() => {})
}

/**
 * Create `file` only if it does not exist. Two processes opening the same fresh
 * vault must not both mint a master key: the loser adopts the winner's file.
 */
async function writePrivateExclusive(file, contents) {
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(tmp, contents, { encoding: 'utf8', mode: 0o600 })
  try {
    await link(tmp, file)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {})
    if (error?.code === 'EEXIST') return false
    // Filesystems without hard links (SMB, exFAT). `wx` is still an atomic
    // exclusive create, so only one process can win and the loser adopts.
    if (['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(error?.code)) {
      try {
        await writeFile(file, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
        if (process.platform !== 'win32') await chmod(file, 0o600).catch(() => {})
        return true
      } catch (fallback) {
        if (fallback?.code === 'EEXIST') return false
        throw fallback
      }
    }
    throw error
  }
  await rm(tmp, { force: true }).catch(() => {})
  if (process.platform !== 'win32') await chmod(file, 0o600).catch(() => {})
  return true
}

function accountFor(vaultDir) {
  return createHash('sha256').update(path.resolve(vaultDir)).digest('hex').slice(0, 16)
}

async function dpapiMasterKey(vaultDir, run, { create = true } = {}) {
  const file = path.join(vaultDir, 'master.dpapi')
  try {
    const sealed = (await readFile(file, 'utf8')).trim()
    let raw
    try {
      raw = requireSuccess(
        await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', DPAPI_UNPROTECT], sealed),
        'unsealing the DPAPI master key',
      )
    } catch (error) {
      // A hung helper is its own fault, not a locked store.
      if (error?.code === 'KEYSAFE_HELPER_TIMEOUT') throw error
      // Profile moved/changed, DPAPI reset, corrupt blob: a typed, actionable
      // state, never a raw PowerShell error and never a silent re-key.
      throw lockedError('the DPAPI master key', (error)?.message ?? String(error))
    }
    const key = Buffer.from(raw, 'base64')
    assertKey(key)
    return key
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    if (!create) {
      throw lockedError('the DPAPI master key', 'the vault has records but master.dpapi is missing')
    }
  }
  const key = randomBytes(KEY_BYTES)
  const sealed = requireSuccess(
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', DPAPI_PROTECT], key.toString('base64')),
    'sealing the DPAPI master key',
  )
  if (!(await writePrivateExclusive(file, sealed))) {
    // Another process won the creation race. Adopt its key; do not orphan the
    // records it may already have written.
    const winner = (await readFile(file, 'utf8')).trim()
    const raw = requireSuccess(
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', DPAPI_UNPROTECT], winner),
      'unsealing the DPAPI master key',
    )
    const shared = Buffer.from(raw, 'base64')
    assertKey(shared)
    return shared
  }
  return key
}

// The helper ships beside the vault script in a source checkout and beside the
// bundle's scripts directory in the artifact, so look in both places.
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
const KEYCHAIN_HELPERS = [
  path.join(MODULE_DIR, 'macos', 'bin', 'keysafe-keychain'),
  path.join(MODULE_DIR, '..', 'scripts', 'macos', 'bin', 'keysafe-keychain'),
]

/**
 * The compiled helper beside the vault script. `KEYSAFE_KEYCHAIN_HELPER`
 * overrides the path; `keychainHelper: false` forces the `security` CLI path
 * (source checkouts without the binary, and the tests that cover that path).
 */
function keychainHelperPath(options) {
  if (options.keychainHelper === false) return null
  if (typeof options.keychainHelper === 'string') return options.keychainHelper
  const override = process.env.KEYSAFE_KEYCHAIN_HELPER
  if (override) return override
  return KEYCHAIN_HELPERS.find(candidate => existsSync(candidate)) ?? null
}

/**
 * Native path: Security.framework through the small Swift helper. Exit codes
 * say what happened (44 not found, 45 interaction) instead of English error
 * text, and the item carries an any-application ACL so a rebuilt helper cannot
 * lock the vault behind an approval prompt.
 */
async function nativeKeychainMasterKey(vaultDir, run, helper, { create = true } = {}) {
  const account = accountFor(vaultDir)
  const lookup = await run(helper, ['get', SERVICE, account], '')
  if (lookup.code === 0 && String(lookup.stdout).trim()) {
    const key = Buffer.from(String(lookup.stdout).trim(), 'base64')
    assertKey(key)
    return key
  }
  const detail = `${lookup.stderr}\n${lookup.stdout}`.trim() || `the Keychain helper exited ${lookup.code}`
  if (lookup.code === 45) {
    throw lockedError('the Keychain master key', detail, 'KEYSAFE_LOCKED_INTERACTION')
  }
  if (lookup.code !== 44 || !create) {
    throw lockedError('the Keychain master key', detail)
  }
  const key = randomBytes(KEY_BYTES)
  const stored = await run(helper, ['set', SERVICE, account], key.toString('base64'))
  if (stored.code !== 0) {
    throw lockedError(
      'the Keychain master key',
      `${stored.stderr}\n${stored.stdout}`.trim() || `the Keychain helper exited ${stored.code}`,
      stored.code === 45 ? 'KEYSAFE_LOCKED_INTERACTION' : 'KEYSAFE_LOCKED',
    )
  }
  return key
}

async function keychainMasterKey(vaultDir, run, opts = {}) {
  const helper = keychainHelperPath(opts)
  if (helper) return nativeKeychainMasterKey(vaultDir, run, helper, opts)
  return securityCliMasterKey(vaultDir, run, opts)
}

async function securityCliMasterKey(vaultDir, run, { create = true } = {}) {
  const account = accountFor(vaultDir)
  const lookup = await run('security', ['-i'], `find-generic-password -s ${SERVICE} -a ${account} -w\n`)
  if (lookup.code === 0 && String(lookup.stdout).trim()) {
    const key = Buffer.from(String(lookup.stdout).trim(), 'base64')
    assertKey(key)
    return key
  }
  const detail = `${lookup.stderr}\n${lookup.stdout}`
  // An interaction failure outranks "not found": macOS reports both in the same
  // message, and minting a key the GUI session can never reach would orphan the
  // vault. This is the one failure a fresh vault may fall back from.
  if (INTERACTION_HINT.test(detail)) {
    throw lockedError('the Keychain master key', detail, 'KEYSAFE_LOCKED_INTERACTION')
  }
  // A failed lookup is NOT "no key": generating a replacement here would
  // orphan every record encrypted under the real one.
  if (!NOT_FOUND_HINT.test(detail) || !create) {
    throw lockedError('the Keychain master key', detail)
  }
  const key = randomBytes(KEY_BYTES)
  // The lookup can answer "not found" while the *store* is what the session is
  // not allowed to do, so classify here too: a fresh vault outside a GUI
  // session falls back instead of failing after it has already chosen a key.
  const stored = await run(
    'security',
    ['-i'],
    `add-generic-password -U -s ${SERVICE} -a ${account} -w ${key.toString('base64')}\n`,
  )
  if (stored.code !== 0) {
    const storeDetail = `${stored.stderr}\n${stored.stdout}`
    throw lockedError(
      'the Keychain master key',
      storeDetail,
      INTERACTION_HINT.test(storeDetail) ? 'KEYSAFE_LOCKED_INTERACTION' : 'KEYSAFE_LOCKED',
    )
  }
  return key
}

async function libsecretMasterKey(vaultDir, run, { create = true } = {}) {
  const account = accountFor(vaultDir)
  const lookup = await run('secret-tool', ['lookup', 'service', SERVICE, 'account', account], '')
  if (lookup.code === 0 && String(lookup.stdout).trim()) {
    const key = Buffer.from(String(lookup.stdout).trim(), 'base64')
    assertKey(key)
    return key
  }
  const detail = `${lookup.stderr}\n${lookup.stdout}`
  if (!NOT_FOUND_HINT.test(detail) && LOCKED_HINT.test(detail)) {
    throw lockedError('the libsecret master key', detail)
  }
  if (!NOT_FOUND_HINT.test(detail) || !create) {
    // Existing records mean a master key exists. Never mint a second one.
    throw lockedError('the libsecret master key', detail)
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

async function fileMasterKey(vaultDir, { create = true } = {}) {
  const file = path.join(vaultDir, 'master.key')
  try {
    const key = Buffer.from((await readFile(file, 'utf8')).trim(), 'hex')
    assertKey(key)
    return key
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    if (!create) {
      throw lockedError('the file master key', 'the vault has records but master.key is missing')
    }
  }
  const key = randomBytes(KEY_BYTES)
  if (!(await writePrivateExclusive(file, key.toString('hex')))) {
    const existing = Buffer.from((await readFile(file, 'utf8')).trim(), 'hex')
    assertKey(existing)
    return existing
  }
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

  const run = options.run ?? defaultRun
  await ensureDir(vaultDir, run)
  const platform = options.platform ?? process.platform
  const requested =
    options.backend ?? (platform === 'win32' ? 'dpapi' : platform === 'darwin' ? 'keychain' : 'libsecret')
  const meta = await readVaultMeta(vaultDir)

  // The backend that created the vault is sticky. A different explicit request
  // is a configuration error, never a silent re-key.
  if (meta && options.backend && options.backend !== meta.backend) {
    throw new Error(
      `keysafe: this vault was created with the ${meta.backend} backend; refusing to open it as ${options.backend}`,
    )
  }
  const backend = meta?.backend ?? requested
  const allowCreate = !(await vaultHasRecords(vaultDir))
  const opts = {
    create: allowCreate,
    ...(options.keychainHelper !== undefined ? { keychainHelper: options.keychainHelper } : {}),
  }

  let resolved
  if (backend === 'dpapi') {
    resolved = { key: await dpapiMasterKey(vaultDir, run, opts), backend }
  } else if (backend === 'keychain') {
    try {
      resolved = { key: await keychainMasterKey(vaultDir, run, opts), backend }
    } catch (error) {
      // Existing records mean a master key exists somewhere. Never mint a
      // second one: it would orphan every record encrypted under the first.
      // Only an interaction failure permits this, and only on a fresh vault.
      if (!allowCreate || error?.code !== 'KEYSAFE_LOCKED_INTERACTION') throw error
      const warning =
        'keysafe: the Keychain is not usable from this session ' +
        '(no GUI security session, or it is locked); ' +
        'using a 0600 master-key file in the config directory'
      resolved = {
        key: await fileMasterKey(vaultDir, opts),
        backend: 'file',
        warning,
        reason: 'keychain-unavailable',
      }
    }
  } else if (backend === 'libsecret') {
    try {
      resolved = { key: await libsecretMasterKey(vaultDir, run, opts), backend }
    } catch (error) {
      // Existing records mean a master key exists somewhere. Never mint a
      // second one: it would orphan every record encrypted under the first.
      if (!allowCreate) throw error
      // No D-Bus session / no keyring and a fresh vault: the documented
      // fallback, recorded so subsequent opens stay on it.
      const warning =
        `keysafe: libsecret is unavailable (${String(error?.message ?? error).slice(0, 160)}); ` +
        'using a 0600 master-key file in the config directory'
      resolved = {
        key: await fileMasterKey(vaultDir, opts),
        backend: 'file',
        warning,
        reason: 'libsecret-unavailable',
      }
    }
  } else {
    resolved = { key: await fileMasterKey(vaultDir, opts), backend: 'file' }
  }
  if (!meta) {
    // A fallback records why, so the choice is auditable on the next open.
    await writeVaultMeta(
      vaultDir,
      resolved.backend,
      resolved.reason ? { reason: resolved.reason } : {},
    )
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
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
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
  await ensureDir(vaultDir, options.run ?? defaultRun)
  const { key, backend, warning } = await resolveMasterKey({ ...options, vaultDir })
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
  // The caller needs to say which store the key actually landed in. A silent
  // fallback is a security-relevant surprise, not an implementation detail.
  return { name, envVar, backend, ...(warning ? { warning } : {}) }
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
    const expected = envVarForRecord(name)
    if (!isValidRecordName(name) || !expected) continue
    const record = await readRecordFile(vaultDir, name)
    if (!record) continue
    // The NAME decides the variable. A record whose stored envVar disagrees was
    // edited or corrupted; refuse it rather than inject into an arbitrary var.
    if (record.envVar !== expected) {
      throw new Error(`keysafe: record "${name}" names the wrong environment variable`)
    }
    records.push({ name, envVar: expected, updatedAt: record.updatedAt })
  }
  return records.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Observation only. Never creates the directory, a master key or vault.meta,
 * so `cc doctor` / `/login status` are not writes. `created: false` means there
 * is no vault yet.
 */
export async function peekVault(vaultDir = defaultVaultDir()) {
  const meta = await readVaultMeta(vaultDir)
  const records = await vaultHasRecords(vaultDir)
  return { vaultDir, created: Boolean(meta), backend: meta?.backend ?? null, records }
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
