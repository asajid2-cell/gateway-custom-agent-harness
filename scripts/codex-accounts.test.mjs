import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  codexAccounts,
  currentCodexAccountName,
  listCodexAccountNames,
  nextCodexAccountName,
  readCodexAuth,
  setCurrentCodexAccount,
} from './codex-accounts.mjs'

async function scratch(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-accounts-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

async function addAccount(root, name, auth = { access_token: `token-${name}`, account_id: `acct-${name}` }) {
  const home = path.join(root, name)
  await mkdir(home, { recursive: true })
  if (auth) await writeFile(path.join(home, 'auth.json'), JSON.stringify({ tokens: auth }))
  return home
}

test('accounts get stable numbers and a home that carries a login', async t => {
  const root = await scratch(t)
  await addAccount(root, 'beta')
  await addAccount(root, 'alpha')
  await mkdir(path.join(root, 'no-login'), { recursive: true })

  const accounts = await codexAccounts({ root })
  assert.deepEqual(accounts.map(account => account.name), ['alpha', 'beta'])
  assert.deepEqual(accounts.map(account => account.number), [1, 2])
  assert.equal(accounts[0].home, path.join(root, 'alpha'))
  assert.deepEqual(await listCodexAccountNames({ root }), ['alpha', 'beta'])
})

test('a new home takes the lowest free number and survivors never renumber', async t => {
  const root = await scratch(t)
  await addAccount(root, 'alpha')
  await addAccount(root, 'beta')
  await codexAccounts({ root })

  await addAccount(root, 'gamma')
  let accounts = await codexAccounts({ root })
  assert.deepEqual(
    accounts.map(account => [account.number, account.name]),
    [[1, 'alpha'], [2, 'beta'], [3, 'gamma']],
  )

  // Removing the first home frees number 1 for the next addition, and the
  // survivors keep the numbers callers already selected.
  await rm(path.join(root, 'alpha'), { recursive: true, force: true })
  accounts = await codexAccounts({ root })
  assert.deepEqual(
    accounts.map(account => [account.number, account.name]),
    [[2, 'beta'], [3, 'gamma']],
  )

  await addAccount(root, 'delta')
  accounts = await codexAccounts({ root })
  assert.deepEqual(
    accounts.map(account => [account.number, account.name]),
    [[1, 'delta'], [2, 'beta'], [3, 'gamma']],
  )

  const registry = JSON.parse(await readFile(path.join(root, 'registry.json'), 'utf8'))
  assert.deepEqual(registry.accounts, [
    { number: 1, name: 'delta' },
    { number: 2, name: 'beta' },
    { number: 3, name: 'gamma' },
  ])
})

test('the current selection tolerates a BOM and is written atomically', async t => {
  const root = await scratch(t)
  await addAccount(root, 'alpha')
  await writeFile(path.join(root, 'current.txt'), '\uFEFFalpha\n')
  assert.equal(await currentCodexAccountName({ root }), 'alpha')

  await setCurrentCodexAccount('beta', { root })
  assert.equal(await currentCodexAccountName({ root }), 'beta')
  await assert.rejects(() => setCurrentCodexAccount('../escape', { root }))
})

test('the next account name avoids names already on disk', async t => {
  const root = await scratch(t)
  await addAccount(root, 'account1')
  await addAccount(root, 'account3')
  assert.equal(await nextCodexAccountName({ root }), 'account2')
})

test('auth reads only the two usable fields and refuses an incomplete login', async t => {
  const root = await scratch(t)
  const good = await addAccount(root, 'good')
  assert.deepEqual(await readCodexAuth(good), { accessToken: 'token-good', accountId: 'acct-good' })

  const partial = await addAccount(root, 'partial', { access_token: 'only-a-token' })
  assert.equal(await readCodexAuth(partial), null)

  await mkdir(path.join(root, 'empty'), { recursive: true })
  assert.equal(await readCodexAuth(path.join(root, 'empty')), null)
})
