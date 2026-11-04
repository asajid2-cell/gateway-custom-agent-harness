// Most rows are about the vault, not the host ACL; keep them environment-
// independent. The ACL row below unsets this deliberately. KEYSAFE_SKIP_ACL is
// honored only while NODE_ENV=test, so this cannot disable hardening in a
// production process by accident.
process.env.NODE_ENV = 'test'
process.env.KEYSAFE_SKIP_ACL = '1'

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { access, mkdtemp, readFile, rm, copyFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  captureSecret,
  clearMasterKeyCache,
  credentialModeMatrix,
  envVarForRecord,
  gatewayCredentialsMode,
  hasSecret,
  keysafeMode,
  listSecrets,
  oauthMode,
  readSecret,
  removeSecret,
  secretsEnv,
} from './keysafe-vault.mjs'

async function scratch() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'keysafe-vault-'))
  clearMasterKeyCache()
  return { dir, options: { vaultDir: dir, backend: 'file' } }
}

test('envVarForRecord matches the external keysafe names', () => {
  assert.equal(envVarForRecord('ds'), 'DEEPSEEK_API_KEY')
  assert.equal(envVarForRecord('amd-ds'), 'AMD_API_KEY')
  assert.equal(envVarForRecord('openrouter'), 'OPENROUTER_API_KEY')
  assert.equal(envVarForRecord('opencode-go'), 'OPENCODE_API_KEY')
  assert.equal(envVarForRecord('opencode-go2'), 'OPENCODE_API_KEY2')
  assert.equal(envVarForRecord('opencode-go12'), 'OPENCODE_API_KEY12')
  assert.equal(envVarForRecord('commandcode'), 'COMMANDCODE_API_KEY')
  assert.equal(envVarForRecord('commandcode3'), 'COMMANDCODE_API_KEY3')
  assert.equal(envVarForRecord('not-a-provider'), null)
})

test('capture/read/list/has/remove round-trip', async () => {
  const { dir, options } = await scratch()
  try {
    await captureSecret('ds', 'sk-deepseek-sentinel-1', options)
    assert.equal(await readSecret('ds', options), 'sk-deepseek-sentinel-1')
    assert.equal(await hasSecret('ds', options), true)
    assert.deepEqual(await listSecrets(options), [
      { name: 'ds', envVar: 'DEEPSEEK_API_KEY', updatedAt: (await listSecrets(options))[0].updatedAt },
    ])
    assert.equal(await removeSecret('ds', options), true)
    assert.equal(await hasSecret('ds', options), false)
    assert.equal(await removeSecret('ds', options), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the record on disk is ciphertext and never contains the secret', async () => {
  const { dir, options } = await scratch()
  try {
    await captureSecret('commandcode', 'cc-sentinel-do-not-store-me', options)
    const raw = await readFile(path.join(dir, 'commandcode.json'), 'utf8')
    assert.equal(raw.includes('cc-sentinel-do-not-store-me'), false)
    const record = JSON.parse(raw)
    assert.equal(record.cipher, 'aes-256-gcm')
    assert.ok(record.nonce && record.tag && record.data)
    const master = await readFile(path.join(dir, 'master.key'), 'utf8')
    assert.equal(master.includes('cc-sentinel'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('AAD binds a ciphertext to its record name', async () => {
  const { dir, options } = await scratch()
  try {
    await captureSecret('ds', 'ds-sentinel', options)
    await copyFile(path.join(dir, 'ds.json'), path.join(dir, 'commandcode.json'))
    await assert.rejects(() => readSecret('commandcode', options))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a record from another vault does not decrypt', async () => {
  const a = await scratch()
  const b = await scratch()
  try {
    await captureSecret('ds', 'vault-a-sentinel', a.options)
    await copyFile(path.join(a.dir, 'ds.json'), path.join(b.dir, 'ds.json'))
    await assert.rejects(() => readSecret('ds', b.options))
  } finally {
    await rm(a.dir, { recursive: true, force: true })
    await rm(b.dir, { recursive: true, force: true })
  }
})

test('empty secrets and invalid names are refused', async () => {
  const { dir, options } = await scratch()
  try {
    await assert.rejects(() => captureSecret('ds', '   ', options), /empty secret/)
    await assert.rejects(() => captureSecret('../escape', 'x', options), /invalid record name/)
    await assert.rejects(() => captureSecret('unknown', 'x', options), /unknown credential/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('secretsEnv returns the gateway environment overlay', async () => {
  const { dir, options } = await scratch()
  try {
    await captureSecret('ds', 'deepseek-key', options)
    await captureSecret('opencode-go', 'opencode-1', options)
    await captureSecret('opencode-go2', 'opencode-2', options)
    await captureSecret('commandcode', 'commandcode-1', options)
    assert.deepEqual(await secretsEnv(options), {
      DEEPSEEK_API_KEY: 'deepseek-key',
      OPENCODE_API_KEY: 'opencode-1',
      OPENCODE_API_KEY2: 'opencode-2',
      COMMANDCODE_API_KEY: 'commandcode-1',
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('mode resolution: one axis, per-dimension overrides, invalid fails closed', () => {
  assert.equal(gatewayCredentialsMode({}), 'bundled')
  assert.equal(keysafeMode({}), 'bundled')
  assert.equal(oauthMode({}), 'bundled')
  assert.equal(gatewayCredentialsMode({ GATEWAY_CREDENTIALS_MODE: 'external' }), 'external')
  assert.equal(keysafeMode({ GATEWAY_CREDENTIALS_MODE: 'external' }), 'external')
  assert.equal(oauthMode({ GATEWAY_CREDENTIALS_MODE: 'external' }), 'external')
  assert.equal(
    keysafeMode({ GATEWAY_CREDENTIALS_MODE: 'external', GATEWAY_KEYSAFE_MODE: 'bundled' }),
    'bundled',
  )
  assert.equal(
    oauthMode({ GATEWAY_CREDENTIALS_MODE: 'bundled', GATEWAY_OAUTH_MODE: 'external' }),
    'external',
  )
  assert.throws(() => gatewayCredentialsMode({ GATEWAY_CREDENTIALS_MODE: 'yes' }), /bundled.*external/)
  assert.deepEqual(credentialModeMatrix({ GATEWAY_CREDENTIALS_MODE: 'external' }), {
    mode: 'external',
    keysafe: 'external',
    oauth: 'external',
    vaultDir: credentialModeMatrix({ GATEWAY_CREDENTIALS_MODE: 'external' }).vaultDir,
  })
})

test('the DPAPI helper receives the key on stdin, never in argv', async () => {
  const { dir } = await scratch()
  const calls = []
  const run = async (file, args, stdin) => {
    calls.push({ file, args, stdin })
    // protect: echo back a synthetic sealed blob we can unseal in-process
    if (args.join(' ').includes('Protect($bytes')) return { code: 0, stdout: stdin, stderr: '' }
    if (args.join(' ').includes('Unprotect($bytes')) return { code: 0, stdout: stdin, stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  try {
    await captureSecret('ds', 'dpapi-sentinel', { vaultDir: dir, backend: 'dpapi', platform: 'win32', run })
    for (const call of calls) {
      assert.equal(call.file, 'powershell.exe')
      assert.equal(call.args.join(' ').includes('dpapi-sentinel'), false)
      assert.equal(call.args.some(arg => arg.includes('dpapi-sentinel')), false)
    }
    assert.equal(await readSecret('ds', { vaultDir: dir, backend: 'dpapi', platform: 'win32', run }), 'dpapi-sentinel')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the Keychain and libsecret helpers receive the master key on stdin', async () => {
  for (const backend of ['keychain', 'libsecret']) {
    const { dir } = await scratch()
    const calls = []
    const run = async (file, args, stdin) => {
      calls.push({ file, args, stdin })
      if (args.includes('lookup') || (args[0] === '-i' && String(stdin).startsWith('find-generic-password'))) {
        return { code: 1, stdout: '', stderr: 'The specified item could not be found.' }
      }
      if (args.includes('store') || args[0] === '-i') return { code: 0, stdout: '', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
    try {
      await captureSecret('ds', `${backend}-sentinel`, { vaultDir: dir, backend, platform: backend === 'keychain' ? 'darwin' : 'linux', run })
      const stored = calls.find(c => c.args.includes('store') || c.args[0] === '-i')
      assert.ok(stored, `${backend} store call missing`)
      assert.equal(stored.args.join(' ').includes('sentinel'), false)
      assert.ok(String(stored.stdin).length > 0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
})

test('a populated vault never re-keys when its keyring is unavailable', async () => {
  const { dir, options } = await scratch()
  try {
    await captureSecret('ds', 'first-sentinel', options)
    clearMasterKeyCache()
    // The vault was created with the file backend; a later open that names
    // libsecret must still use the recorded backend, not mint a second key.
    const { resolveMasterKey, readSecret } = await import('./keysafe-vault.mjs')
    // No explicit backend: the platform default (libsecret) is requested, but
    // the recorded backend wins.
    const resolved = await resolveMasterKey({ vaultDir: dir, platform: 'linux', run: async () => ({ code: 1, stdout: '', stderr: 'Cannot autolaunch D-Bus' }) })
    assert.equal(resolved.backend, 'file')
    assert.equal(await readSecret('ds', { vaultDir: dir, backend: 'file' }), 'first-sentinel')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a fresh vault falls back to file and records the backend', async () => {
  const { dir } = await scratch()
  try {
    const { resolveMasterKey } = await import('./keysafe-vault.mjs')
    const resolved = await resolveMasterKey({
      vaultDir: dir,
      platform: 'linux',
      run: async () => ({ code: 1, stdout: '', stderr: 'Cannot autolaunch D-Bus' }),
    })
    assert.equal(resolved.backend, 'file')
    assert.ok(resolved.warning)
    const meta = JSON.parse(await readFile(`${dir}/vault.meta`, 'utf8'))
    assert.equal(meta.backend, 'file')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a locked keychain is not "no record" and does not mint a key', async () => {
  const { dir } = await scratch()
  try {
    const { resolveMasterKey } = await import('./keysafe-vault.mjs')
    await assert.rejects(
      () =>
        resolveMasterKey({
          vaultDir: dir,
          backend: 'keychain',
          platform: 'darwin',
          run: async () => ({ code: 1, stdout: '', stderr: 'errSecInteractionNotAllowed -25308' }),
        }),
      /KEYSAFE_LOCKED/,
    )
    const entries = await (await import('node:fs/promises')).readdir(dir)
    assert.equal(entries.some(entry => entry === 'master.key'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a record whose stored envVar was tampered with is refused', async () => {
  const { dir, options } = await scratch()
  try {
    await captureSecret('ds', 'tamper-sentinel', options)
    const file = `${dir}/ds.json`
    const record = JSON.parse(await readFile(file, 'utf8'))
    record.envVar = 'LD_PRELOAD'
    await (await import('node:fs/promises')).writeFile(file, JSON.stringify(record))
    const { listSecrets } = await import('./keysafe-vault.mjs')
    await assert.rejects(() => listSecrets(options), /wrong environment variable/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('defaultVaultDir honors CLAUDE_CONFIG_DIR', async () => {
  const { defaultVaultDir } = await import('./keysafe-vault.mjs')
  assert.equal(defaultVaultDir({ CLAUDE_CONFIG_DIR: 'C:/tmp/cfg', USERPROFILE: 'C:/u' }), path.join('C:/tmp/cfg', 'keysafe'))
  assert.equal(defaultVaultDir({ USERPROFILE: 'C:/u' }), path.join('C:/u', '.claude', 'keysafe'))
})

test('reserved and non-canonical record names are refused', async () => {
  const { isValidRecordName } = await import('./keysafe-vault.mjs')
  assert.equal(isValidRecordName('ds'), true)
  assert.equal(isValidRecordName('opencode-go2'), true)
  assert.equal(isValidRecordName('con'), false)
  assert.equal(isValidRecordName('nul'), false)
  assert.equal(isValidRecordName('COM1'), false)
  assert.equal(isValidRecordName('ds.'), false)
  assert.equal(isValidRecordName('ds '), false)
})

test('a helper that exits before stdin is written does not crash the process', async () => {
  const { defaultRun } = await import('./keysafe-vault.mjs')
  const result = await defaultRun(process.execPath, ['-e', ''], 'x'.repeat(200_000))
  assert.equal(typeof result.code, 'number')
})

test('peekVault observes without creating anything', async () => {
  const dir = path.join(await mkdtemp(path.join(os.tmpdir(), 'keysafe-peek-')), 'missing')
  try {
    const { peekVault } = await import('./keysafe-vault.mjs')
    const peek = await peekVault(dir)
    assert.deepEqual(peek, { vaultDir: dir, created: false, backend: null, records: false })
    await assert.rejects(access(dir))
  } finally {
    await rm(path.dirname(dir), { recursive: true, force: true })
  }
})

test('the Windows vault directory has a protected DACL', { skip: process.platform !== 'win32' }, async () => {
  delete process.env.KEYSAFE_SKIP_ACL
  const { dir, options } = await scratch()
  try {
    await captureSecret('ds', 'acl-sentinel', options)
    const out = execFileSync('icacls', [dir], { encoding: 'utf8' })
    assert.match(out, /BUILTIN\\Administrators/)
    assert.match(out, /NT AUTHORITY\\SYSTEM/)
    assert.doesNotMatch(out, /CodexSandboxUsers/i)
    // The file pass is recorded so later processes do not re-run it per record.
    const meta = JSON.parse(await readFile(path.join(dir, 'vault.meta'), 'utf8'))
    assert.equal(meta.aclVersion, 1)
  } finally {
    process.env.KEYSAFE_SKIP_ACL = '1'
    await rm(dir, { recursive: true, force: true })
  }
})

test('POSIX vault files are private', { skip: process.platform === 'win32' }, async () => {
  const { dir, options } = await scratch()
  try {
    await captureSecret('ds', 'perm-sentinel', options)
    const { stat } = await import('node:fs/promises')
    assert.equal((await stat(path.join(dir, 'ds.json'))).mode & 0o777, 0o600)
    assert.equal((await stat(path.join(dir, 'master.key'))).mode & 0o777, 0o600)
    assert.equal((await stat(dir)).mode & 0o777, 0o700)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
