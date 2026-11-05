import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  anthropicAccounts,
  currentAnthropicAccountName,
  findAnthropicAccount,
  nextAnthropicAccountName,
  readAnthropicAccount,
  registerAnthropicAccount,
  removeAnthropicAccount,
  setCurrentAnthropicAccount,
} from './anthropic-accounts.mjs'

async function scratch(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-accounts-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

function credential(accessToken) {
  return {
    claudeAiOauth: {
      accessToken,
      refreshToken: `refresh-${accessToken}`,
      expiresAt: Date.now() + 3_600_000,
    },
  }
}

test('registration writes a 0600 credential and records the identity', async t => {
  const root = await scratch(t)
  const account = await registerAnthropicAccount({
    root,
    name: 'work',
    stored: credential('token-work'),
    identity: { email: 'work@example.com', displayName: 'Work Person' },
  })
  assert.deepEqual(account, {
    number: 1,
    name: 'work',
    home: path.join(root, 'work'),
    email: 'work@example.com',
    displayName: 'Work Person',
  })

  const file = path.join(root, 'work', 'credentials.json')
  const mode = (await stat(file)).mode & 0o777
  if (process.platform !== 'win32') assert.equal(mode, 0o600)
  assert.equal((await readAnthropicAccount(path.join(root, 'work'))).claudeAiOauth.accessToken, 'token-work')

  const registry = JSON.parse(await readFile(path.join(root, 'registry.json'), 'utf8'))
  assert.deepEqual(registry.accounts, [
    { number: 1, name: 'work', email: 'work@example.com', displayName: 'Work Person' },
  ])
})

test('numbers are stable, unbounded, and a new home takes the lowest free one', async t => {
  const root = await scratch(t)
  for (const name of ['one', 'two', 'three']) {
    await registerAnthropicAccount({ root, name, stored: credential(name) })
  }
  let accounts = await anthropicAccounts({ root })
  assert.deepEqual(accounts.map(account => [account.number, account.name]), [
    [1, 'one'],
    [2, 'two'],
    [3, 'three'],
  ])

  await removeAnthropicAccount('one', { root })
  accounts = await anthropicAccounts({ root })
  assert.deepEqual(accounts.map(account => [account.number, account.name]), [
    [2, 'two'],
    [3, 'three'],
  ])

  await registerAnthropicAccount({ root, name: 'four', stored: credential('four') })
  accounts = await anthropicAccounts({ root })
  assert.deepEqual(accounts.map(account => [account.number, account.name]), [
    [1, 'four'],
    [2, 'two'],
    [3, 'three'],
  ])

  // No cap: the store keeps growing and numbering keeps rising.
  for (let index = 0; index < 25; index += 1) {
    await registerAnthropicAccount({ root, name: `bulk${index}`, stored: credential(`bulk${index}`) })
  }
  accounts = await anthropicAccounts({ root })
  assert.equal(accounts.length, 28)
  assert.equal(new Set(accounts.map(account => account.number)).size, 28)
})

test('targets resolve by number, name, or email', async t => {
  const root = await scratch(t)
  await registerAnthropicAccount({
    root,
    name: 'work',
    stored: credential('work'),
    identity: { email: 'Work@Example.com' },
  })
  await registerAnthropicAccount({
    root,
    name: 'home',
    stored: credential('home'),
    identity: { email: 'home@example.com' },
  })
  const accounts = await anthropicAccounts({ root })
  assert.equal(findAnthropicAccount(accounts, '1').name, 'work')
  assert.equal(findAnthropicAccount(accounts, 'home').number, 2)
  assert.equal(findAnthropicAccount(accounts, 'work@example.com').number, 1)
  assert.equal(findAnthropicAccount(accounts, 'nobody@example.com'), undefined)
})

test('the selection is stored where the gateway reads it', async t => {
  const root = await scratch(t)
  await registerAnthropicAccount({ root, name: 'work', stored: credential('work') })
  await setCurrentAnthropicAccount('work', { root })
  assert.equal(await currentAnthropicAccountName({ root }), 'work')
  await assert.rejects(() => setCurrentAnthropicAccount('../escape', { root }))
})

test('the next default name is not already taken', async t => {
  const root = await scratch(t)
  await mkdir(path.join(root, 'account1'), { recursive: true })
  await writeFile(
    path.join(root, 'account1', 'credentials.json'),
    JSON.stringify(credential('one')),
  )
  assert.equal(await nextAnthropicAccountName({ root }), 'account2')
})
