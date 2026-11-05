import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  PROVIDERS,
  planLogin,
} from '../src/commands/gateway-login/unified-plan.js'
import { saveProviderKey } from '../src/commands/gateway-login/unified-save.js'

test('bare /login opens the picker covering host sign-ins and every provider key', () => {
  assert.deepEqual(planLogin(''), { kind: 'pick', action: 'save' })
  assert.deepEqual(planLogin('   '), { kind: 'pick', action: 'save' })
  // The picker must offer the credentials the gateway actually consumes, not a
  // subset: Claude Code and Codex sign in through their own flows, and Mistral
  // has two credential types.
  assert.deepEqual(PROVIDERS, [
    'claude',
    'codex',
    'opencode',
    'commandcode',
    'mistral',
    'mistralvibe',
    'deepseek',
    'openrouter',
  ])
})

test('status and remove alone open the picker in that mode', () => {
  assert.deepEqual(planLogin('status'), { kind: 'pick', action: 'status' })
  assert.deepEqual(planLogin('remove'), { kind: 'pick', action: 'remove' })
})

test('a named provider goes straight to its key UI', () => {
  assert.deepEqual(planLogin('deepseek'), { kind: 'provider', provider: 'deepseek', action: 'save', args: '' })
  assert.deepEqual(planLogin('opencode new'), { kind: 'provider', provider: 'opencode', action: 'new', args: 'new' })
  assert.deepEqual(planLogin('commandcode status'), {
    kind: 'provider',
    provider: 'commandcode',
    action: 'status',
    args: 'status',
  })
  assert.deepEqual(planLogin('openrouter remove'), {
    kind: 'provider',
    provider: 'openrouter',
    action: 'remove',
    args: 'remove',
  })
  assert.deepEqual(planLogin('mistral'), { kind: 'provider', provider: 'mistral', action: 'save', args: '' })
  assert.deepEqual(planLogin('mistralvibe status'), {
    kind: 'provider',
    provider: 'mistralvibe',
    action: 'status',
    args: 'status',
  })
})

test('Claude Code and Codex are picker entries, with their common spellings', () => {
  assert.deepEqual(planLogin('claude'), { kind: 'provider', provider: 'claude', action: 'save', args: '' })
  assert.deepEqual(planLogin('anthropic'), { kind: 'provider', provider: 'claude', action: 'save', args: '' })
  assert.deepEqual(planLogin('codex'), { kind: 'provider', provider: 'codex', action: 'save', args: '' })
  assert.deepEqual(planLogin('chatgpt status'), {
    kind: 'provider',
    provider: 'codex',
    action: 'status',
    args: 'status',
  })
  // Removing a Codex account needs to name it: there can be several.
  assert.equal(planLogin('openai remove').kind, 'error')
  assert.deepEqual(planLogin('claude new'), {
    kind: 'provider',
    provider: 'claude',
    action: 'new',
    args: 'new',
  })
  assert.deepEqual(planLogin('mistral-vibe'), {
    kind: 'provider',
    provider: 'mistralvibe',
    action: 'save',
    args: '',
  })
})

test('account providers carry the switch target and scope', () => {
  assert.deepEqual(planLogin('opencode switch 2'), {
    kind: 'provider',
    provider: 'opencode',
    action: 'switch',
    args: 'switch 2',
    target: '2',
    scope: 'session',
  })
  assert.deepEqual(planLogin('commandcode switch 4 global'), {
    kind: 'provider',
    provider: 'commandcode',
    action: 'switch',
    args: 'switch 4 global',
    target: '4',
    scope: 'global',
  })
  assert.deepEqual(planLogin('mistral switch 3 session'), {
    kind: 'provider',
    provider: 'mistral',
    action: 'switch',
    args: 'switch 3 session',
    target: '3',
    scope: 'session',
  })
  // Codex accounts have names as well as numbers.
  assert.deepEqual(planLogin('codex switch freedock global'), {
    kind: 'provider',
    provider: 'codex',
    action: 'switch',
    args: 'switch freedock global',
    target: 'freedock',
    scope: 'global',
  })
})

test('Codex new takes an optional account name; remove needs a target', () => {
  assert.deepEqual(planLogin('codex new'), {
    kind: 'provider',
    provider: 'codex',
    action: 'new',
    args: 'new',
  })
  assert.deepEqual(planLogin('codex new work2'), {
    kind: 'provider',
    provider: 'codex',
    action: 'new',
    args: 'new work2',
    target: 'work2',
  })
  assert.deepEqual(planLogin('codex remove 2'), {
    kind: 'provider',
    provider: 'codex',
    action: 'remove',
    args: 'remove 2',
    target: '2',
  })
})

test('bad account grammar is refused with the provider its own words', () => {
  assert.equal(planLogin('opencode switch').kind, 'error')
  assert.equal(planLogin('opencode switch 0').kind, 'error')
  assert.equal(planLogin('opencode switch 2 weekly').kind, 'error')
  assert.equal(planLogin('deepseek switch 2').kind, 'error')
  assert.equal(planLogin('mistralvibe switch 2').kind, 'error')
  assert.equal(planLogin('codex remove').kind, 'error')
  assert.equal(planLogin('codex new bad/name').kind, 'error')
  assert.equal(planLogin('deepseek new named').kind, 'error')
  assert.equal(planLogin('claude remove 2').kind, 'error')
})

test('unknown providers and extra words are refused with the list', () => {
  const unknown = planLogin('cohere')
  assert.equal(unknown.kind, 'error')
  assert.match(
    String((unknown as { message: string }).message),
    /claude, codex, opencode, commandcode, mistral, mistralvibe, deepseek, openrouter/,
  )
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
