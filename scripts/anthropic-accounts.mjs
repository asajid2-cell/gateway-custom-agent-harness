/**
 * Claude Code account homes.
 *
 * Anthropic's subscription login is one `.credentials.json`, which is why a
 * second Claude account had nowhere to live. Each account here is a home
 * holding `credentials.json` (the exact object the OAuth flow stores) plus a
 * registry entry naming the email and display name it belongs to. Numbers,
 * selection, and the registry come from `account-store.mjs`; there is no cap on
 * how many accounts can be held.
 *
 * The active account's file is what the gateway refreshes and writes back, so a
 * credential has exactly one live copy - the config-directory copy is moved
 * here at registration, never duplicated.
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  ACCOUNT_NAME,
  accountRecords,
  accountRoot,
  listAccountNames,
  nextAccountName,
  readCurrent,
  setAccountIdentity,
  writeCurrent,
} from './account-store.mjs'

export const ANTHROPIC_ACCOUNT_NAME = ACCOUNT_NAME

export function anthropicAccountsRoot({ home = os.homedir() } = {}) {
  return accountRoot('ANTHROPIC_ACCOUNTS_HOME', '.claude-accounts', { home })
}

export function anthropicHomeFor(name, { root = anthropicAccountsRoot() } = {}) {
  return path.join(root, name)
}

export function anthropicCredentialPath(home) {
  return path.join(home, 'credentials.json')
}

export async function listAnthropicAccountNames({ root = anthropicAccountsRoot() } = {}) {
  return listAccountNames(root, 'credentials.json')
}

export async function anthropicAccounts({ root = anthropicAccountsRoot() } = {}) {
  const names = await listAnthropicAccountNames({ root })
  if (names.length === 0) return []
  const records = await accountRecords(root, names)
  return names
    .map(name => {
      const record = records.get(name)
      return {
        number: record.number,
        name,
        home: anthropicHomeFor(name, { root }),
        ...(record.email ? { email: record.email } : {}),
        ...(record.displayName ? { displayName: record.displayName } : {}),
      }
    })
    .sort((a, b) => a.number - b.number)
}

/** The whole stored credential object, or null. */
export async function readAnthropicAccount(home) {
  try {
    return JSON.parse(await fs.readFile(anthropicCredentialPath(home), 'utf8'))
  } catch {
    return null
  }
}

/** Write the credential the way the CLI does: 0600, replaced atomically. */
export async function writeAnthropicAccount(home, stored) {
  const target = anthropicCredentialPath(home)
  const temp = `${target}.${randomUUID()}.tmp`
  await fs.mkdir(home, { recursive: true })
  try {
    const handle = await fs.open(temp, 'w', 0o600)
    try {
      await handle.writeFile(JSON.stringify(stored))
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(temp, target)
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * Add (or replace) an account from a credential object. The home is written
 * before the registry entry so an interrupted registration never leaves a
 * numbered account without its login.
 */
export async function registerAnthropicAccount({
  name,
  stored,
  identity = null,
  root = anthropicAccountsRoot(),
}) {
  if (!ACCOUNT_NAME.test(name)) throw new Error(`Invalid account name: ${name}`)
  const home = anthropicHomeFor(name, { root })
  await writeAnthropicAccount(home, stored)
  const names = await listAnthropicAccountNames({ root })
  const records = await accountRecords(root, names)
  if (identity && (identity.email || identity.displayName)) {
    await setAccountIdentity(root, name, identity)
  }
  const record = (await accountRecords(root, names)).get(name)
  return {
    number: record.number,
    name,
    home,
    ...(record.email ? { email: record.email } : {}),
    ...(record.displayName ? { displayName: record.displayName } : {}),
  }
}

export async function removeAnthropicAccount(name, { root = anthropicAccountsRoot() } = {}) {
  if (!ACCOUNT_NAME.test(name)) throw new Error(`Invalid account name: ${name}`)
  await fs.rm(anthropicHomeFor(name, { root }), { recursive: true, force: true })
}

/** Resolve a number, name, or email to one account. */
export function findAnthropicAccount(accounts, target) {
  const text = String(target ?? '').trim()
  if (/^[1-9][0-9]*$/.test(text)) {
    return accounts.find(account => account.number === Number(text))
  }
  const byName = accounts.find(account => account.name === text)
  if (byName) return byName
  return accounts.find(account => account.email?.toLowerCase() === text.toLowerCase())
}

export async function currentAnthropicAccountName({ root = anthropicAccountsRoot() } = {}) {
  return readCurrent(root)
}

export async function setCurrentAnthropicAccount(name, { root = anthropicAccountsRoot() } = {}) {
  await writeCurrent(root, name)
}

export async function nextAnthropicAccountName({
  root = anthropicAccountsRoot(),
  prefix = 'account',
} = {}) {
  return nextAccountName(root, { marker: 'credentials.json', prefix })
}
