import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { planLogin } from '../src/commands/gateway-login/unified-plan.js'
import { saveProviderKey } from '../src/commands/gateway-login/unified-save.js'

test('bare /login opens the picker for the four providers', () => {
  assert.deepEqual(planLogin(''), { kind: 'pick', action: 'save' })
  assert.deepEqual(planLogin('   '), { kind: 'pick', action: 'save' })
})

test('status and remove alone open the picker in that mode', () => {
  assert.deepEqual(planLogin('status'), { kind: 'pick', action: 'status' })
  assert.deepEqual(planLogin('remove'), { kind: 'pick', action: 'remove' })
})

test('a named provider goes straight to its key UI', () => {
  assert.deepEqual(planLogin('deepseek'), { kind: 'provider', provider: 'deepseek', action: 'save' })
  assert.deepEqual(planLogin('opencode new'), { kind: 'provider', provider: 'opencode', action: 'new' })
  assert.deepEqual(planLogin('commandcode status'), {
    kind: 'provider',
    provider: 'commandcode',
    action: 'status',
  })
  assert.deepEqual(planLogin('openrouter remove'), {
    kind: 'provider',
    provider: 'openrouter',
    action: 'remove',
  })
})

test('unknown providers and extra words are refused with the list', () => {
  const unknown = planLogin('anthropic')
  assert.equal(unknown.kind, 'error')
  assert.match(String((unknown as { message: string }).message), /opencode, commandcode, deepseek, openrouter/)
  assert.equal(planLogin('status now').kind, 'error')
  assert.equal(planLogin('deepseek delete').kind, 'error')
})

async function withScratch(fn: (dir: string) => Promise<void>): Promise<void> {
  const previous = {
    config: process.env.CLAUDE_CONFIG_DIR,
    mode: process.env.GATEWAY_CREDENTIALS_MODE,
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'unified-save-'))
  process.env.CLAUDE_CONFIG_DIR = dir
  delete process.env.GATEWAY_CREDENTIALS_MODE
  try {
    await fn(dir)
  } finally {
    if (previous.config === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous.config
    if (previous.mode !== undefined) process.env.GATEWAY_CREDENTIALS_MODE = previous.mode
    await rm(dir, { recursive: true, force: true })
  }
}

test('a provider save writes the vault and reloads the gateway', async () => {
  await withScratch(async dir => {
    let reloads = 0
    const result = await saveProviderKey('ds', 'sentinel-unified-key', async () => {
      reloads += 1
      return { ok: true }
    })
    assert.equal(result.ok, true)
    assert.equal(result.reloaded, true)
    assert.equal(reloads, 1)
    assert.equal(typeof result.backend, 'string')

    const entries = await readdir(path.join(dir, 'keysafe'))
    assert.ok(entries.includes('ds.json'))
    const raw = await readFile(path.join(dir, 'keysafe', 'ds.json'), 'utf8')
    assert.equal(raw.includes('sentinel-unified-key'), false)
  })
})

test('a failed reload keeps the stored key and reports the failure', async () => {
  await withScratch(async () => {
    const result = await saveProviderKey('ds', 'sentinel-unified-key', async () => ({
      ok: false,
      error: 'gateway unreachable',
    }))
    assert.equal(result.ok, true)
    assert.equal(result.reloadError, 'gateway unreachable')
    assert.equal(result.reloaded, undefined)
  })
})

test('with no reload seam the save is storage-only', async () => {
  await withScratch(async () => {
    const result = await saveProviderKey('ds', 'sentinel-unified-key')
    assert.equal(result.ok, true)
    assert.equal(result.reloaded, undefined)
    assert.equal(result.reloadError, undefined)
  })
})
