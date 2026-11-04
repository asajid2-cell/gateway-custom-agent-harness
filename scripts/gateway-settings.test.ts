import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { probeVaultFilesystem } from '../src/utils/vault/filesystem.js'
import {
  defaultVaultRoot,
  gatewaySettingsPath,
  readGatewaySettings,
  resolveInstallPath,
  validateGatewaySettings,
  vaultRootFor,
  writeGatewaySettings,
} from '../src/utils/vault/settings.js'
import { call } from '../src/commands/gateway-settings/settings.js'

async function scratch(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'gateway-settings-'))
}

test('GATEWAY_SETTINGS names the file; otherwise it sits under the config home', () => {
  const override = gatewaySettingsPath({ GATEWAY_SETTINGS: path.join('C:', 'tmp', 'gs.json') } as NodeJS.ProcessEnv)
  assert.equal(path.basename(override), 'gs.json')
  const fallback = gatewaySettingsPath({} as NodeJS.ProcessEnv)
  assert.equal(path.basename(fallback), 'gateway-settings.json')
  assert.ok(fallback.endsWith(path.join('.claude', 'gateway-settings.json')), fallback)
})

test('a relative vaultRoot resolves against the install home, never the cwd', () => {
  const resolved = resolveInstallPath(path.join('vaults', 'main'))
  assert.ok(path.isAbsolute(resolved), resolved)
  assert.ok(resolved.includes(path.join('vaults', 'main')), resolved)
})

test('the vault root defaults to <install>/vaults/main and settings win when present', () => {
  const fallback = vaultRootFor({})
  assert.equal(fallback.source, 'default')
  assert.equal(fallback.root, defaultVaultRoot({}))
  assert.ok(fallback.root.endsWith(path.join('vaults', 'main')), fallback.root)

  const explicit = vaultRootFor({ vaultRoot: path.join('C:', 'vaults', 'lab') })
  assert.equal(explicit.source, 'settings')
  assert.equal(explicit.root, path.resolve('C:/vaults/lab'))

  const blank = vaultRootFor({ vaultRoot: '   ' })
  assert.equal(blank.source, 'default')
})

test('a missing settings file is not an error and a malformed one is', async () => {
  const root = await scratch()
  try {
    const env = { GATEWAY_SETTINGS: path.join(root, 'missing.json') } as NodeJS.ProcessEnv
    const missing = await readGatewaySettings(env)
    assert.equal(missing.ok, true)
    assert.equal(missing.ok && missing.existed, false)

    const bad = path.join(root, 'bad.json')
    await writeFile(bad, '{ not json')
    const malformed = await readGatewaySettings({ GATEWAY_SETTINGS: bad } as NodeJS.ProcessEnv)
    assert.equal(malformed.ok, false)
    assert.match(malformed.ok === false ? malformed.reason : '', /not valid JSON/)

    const array = path.join(root, 'array.json')
    await writeFile(array, '[]')
    const wrongShape = await readGatewaySettings({ GATEWAY_SETTINGS: array } as NodeJS.ProcessEnv)
    assert.equal(wrongShape.ok, false)
    assert.match(wrongShape.ok === false ? wrongShape.reason : '', /JSON object/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('writing merges with the existing object and replaces the file atomically', async () => {
  const root = await scratch()
  try {
    const file = path.join(root, 'nested', 'gateway-settings.json')
    const env = { GATEWAY_SETTINGS: file } as NodeJS.ProcessEnv
    const first = await writeGatewaySettings({ vaultRoot: path.join(root, 'a') }, env)
    assert.equal(first.ok, true)
    const second = await writeGatewaySettings({ capture: { mode: 'monitor' } }, env)
    assert.equal(second.ok, true)
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(parsed.vaultRoot, path.join(root, 'a'))
    assert.equal(parsed.capture.mode, 'monitor')
    // The key set is closed: a typo is refused rather than written and ignored.
    const refused = await writeGatewaySettings({ note: 'kept' } as never, env)
    assert.equal(refused.ok, false)
    assert.match(refused.ok === false ? refused.reason : '', /unknown key 'note'/)
    const leftovers = (await import('node:fs/promises')).readdir(root)
    assert.deepEqual((await leftovers).filter(name => name.endsWith('.tmp')), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the filesystem probe accepts a local directory and leaves nothing behind', async () => {
  const root = await scratch()
  try {
    const dir = path.join(root, 'vault')
    const probe = await probeVaultFilesystem(dir)
    assert.equal(probe.ok, true, probe.ok === false ? probe.reasons.join('; ') : '')
    const names = (await import('node:fs/promises')).readdir(dir)
    assert.deepEqual((await names).filter(name => name.startsWith('.vault-probe')), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a network path is refused before it is touched', async () => {
  const probe = await probeVaultFilesystem('//server/share/vault')
  assert.equal(probe.ok, false)
  assert.match(probe.ok === false ? probe.reasons.join(' ') : '', /network path/)
  assert.equal(probe.ok === false ? probe.reasons.length : 0, 1)
})

test('a path that is a file is refused', async () => {
  const root = await scratch()
  try {
    const file = path.join(root, 'not-a-dir')
    await writeFile(file, 'x')
    const probe = await probeVaultFilesystem(file)
    assert.equal(probe.ok, false)
    assert.match(probe.ok === false ? probe.reasons.join(' ') : '', /not a directory/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('/gateway-settings sets a probed vault root and reports the default when unset', async () => {
  const root = await scratch()
  const previous = process.env.GATEWAY_SETTINGS
  try {
    process.env.GATEWAY_SETTINGS = path.join(root, 'gateway-settings.json')
    const shown = await call('', {} as never)
    assert.equal(shown.type, 'text')
    assert.match(shown.type === 'text' ? shown.value : '', /install default/)

    const vault = path.join(root, 'vault')
    const set = await call(`vaultRoot ${vault}`, {} as never)
    assert.match(set.type === 'text' ? set.value : '', new RegExp(`vaultRoot: ${vault.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))

    const after = await call('show', {} as never)
    assert.match(after.type === 'text' ? after.value : '', /from settings/)

    const refused = await call('vaultRoot //server/share', {} as never)
    assert.match(refused.type === 'text' ? refused.value : '', /refused/)
    assert.match(refused.type === 'text' ? refused.value : '', /network path/)

    const unknown = await call('vaultName x', {} as never)
    assert.match(unknown.type === 'text' ? unknown.value : '', /unknown setting/)

    await mkdir(path.join(root, 'file-target'))
    const notDir = path.join(root, 'not-a-dir')
    await writeFile(notDir, 'x')
    const refusedFile = await call(`vaultRoot ${notDir}`, {} as never)
    assert.match(refusedFile.type === 'text' ? refusedFile.value : '', /not a directory/)
  } finally {
    if (previous === undefined) delete process.env.GATEWAY_SETTINGS
    else process.env.GATEWAY_SETTINGS = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('the settings contract is closed and its cross-field rules are enforced', () => {
  assert.deepEqual(validateGatewaySettings({}), [])
  assert.deepEqual(validateGatewaySettings({ schemaVersion: 1, vaultRoot: 'vaults/main' }), [])

  const unknown = validateGatewaySettings({ vaults: {} } as never)
  assert.ok(unknown.some(reason => /unknown key 'vaults'/.test(reason)))
  const traversal = validateGatewaySettings({ vaultRoot: '../outside' })
  assert.ok(traversal.some(reason => /must not contain \.\./.test(reason)))
  const version = validateGatewaySettings({ schemaVersion: 2 })
  assert.ok(version.some(reason => /schemaVersion must be 1/.test(reason)))
  const halfPair = validateGatewaySettings({
    capture: { scribe: { rotation: { maxAgeHours: 8 } } },
  })
  assert.ok(halfPair.some(reason => /must be set together/.test(reason)))
  const mixedPair = validateGatewaySettings({
    capture: { scribe: { rotation: { maxAgeHours: null, maxEvents: 200 } } },
  })
  assert.ok(mixedPair.some(reason => /both null/.test(reason)))
  assert.deepEqual(
    validateGatewaySettings({ capture: { scribe: { rotation: { every: 5, maxAgeHours: null, maxEvents: null } } } }),
    [],
    'literal-only is legal to write deliberately',
  )
  const embeddings = validateGatewaySettings({ retrieval: { embeddings: { enabled: true } } })
  assert.ok(embeddings.some(reason => /embeddings\.enabled must be false/.test(reason)))
  const fsync = validateGatewaySettings({ writer: { fsync: false } })
  assert.ok(fsync.some(reason => /writer\.fsync must be true/.test(reason)))
  const mode = validateGatewaySettings({ capture: { mode: 'sometimes' } })
  assert.ok(mode.some(reason => /capture\.mode/.test(reason)))
})

test('a save writes schemaVersion 1 and refuses an invalid merge', async () => {
  const root = await scratch()
  try {
    const file = path.join(root, 'gateway-settings.json')
    const env = { GATEWAY_SETTINGS: file } as NodeJS.ProcessEnv
    const written = await writeGatewaySettings({ vaultRoot: path.join(root, 'v') }, env)
    assert.equal(written.ok, true)
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(parsed.schemaVersion, 1)

    const refused = await writeGatewaySettings({ vaultRoot: '../escape' }, env)
    assert.equal(refused.ok, false)
    assert.match(refused.ok === false ? refused.reason : '', /must not contain \.\./)

    const bad = path.join(root, 'bad.json')
    await writeFile(bad, JSON.stringify({ writer: { fsync: false } }))
    const read = await readGatewaySettings({ GATEWAY_SETTINGS: bad } as NodeJS.ProcessEnv)
    assert.equal(read.ok, false)
    assert.match(read.ok === false ? read.reason : '', /writer\.fsync must be true/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('/gateway-settings shows the effective policy and refuses a read-only key', async () => {
  const root = await scratch()
  const previous = process.env.GATEWAY_SETTINGS
  try {
    process.env.GATEWAY_SETTINGS = path.join(root, 'gateway-settings.json')
    const shown = await call('', {} as never)
    const text = shown.type === 'text' ? shown.value : ''
    assert.match(text, /schemaVersion: 1/)
    assert.match(text, /capture\.mode: monitor/)
    assert.match(text, /5 admissions, or 8h \/ 200 events/)
    assert.match(text, /retrieval: sqlite-fts5, embeddings disabled/)

    const readOnly = await call('capture enforce', {} as never)
    assert.match(readOnly.type === 'text' ? readOnly.value : '', /read-only/)

    const traversal = await call('vaultRoot ../escape', {} as never)
    assert.match(traversal.type === 'text' ? traversal.value : '', /must not contain \.\./)
  } finally {
    if (previous === undefined) delete process.env.GATEWAY_SETTINGS
    else process.env.GATEWAY_SETTINGS = previous
    await rm(root, { recursive: true, force: true })
  }
})
