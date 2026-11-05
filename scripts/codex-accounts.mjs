/**
 * Codex account homes.
 *
 * A Codex login is a home directory holding `auth.json`. Multiple homes are how
 * one machine carries several ChatGPT subscriptions, and `codex-acct` already
 * keeps them under `~/.codex-accounts/<name>/` with `current.txt` naming the
 * human's selection.
 *
 * Numbers, selection, and the registry live in `account-store.mjs`. The one
 * Codex-specific thing here is identity: `auth.json` carries the ChatGPT
 * id_token, whose payload names the account (email and display name). Those two
 * non-secret claims are copied into the registry so a list of accounts is
 * readable; no token value is ever returned, logged, or displayed.
 *
 * Never read, log, or echo the contents of `auth.json` beyond those claims and
 * the two request fields.
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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

export const CODEX_ACCOUNT_NAME = ACCOUNT_NAME

export function codexAccountsRoot({ home = os.homedir() } = {}) {
  return accountRoot('CODEX_ACCOUNTS_HOME', '.codex-accounts', { home })
}

export function codexHomeFor(name, { root = codexAccountsRoot() } = {}) {
  return path.join(root, name)
}

export function codexAuthPath(home) {
  return path.join(home, 'auth.json')
}

export async function listCodexAccountNames({ root = codexAccountsRoot() } = {}) {
  return listAccountNames(root, 'auth.json')
}

/** The email and display name the id_token names, or null. Never throws. */
export async function codexIdentity(home) {
  try {
    const auth = JSON.parse(await fs.readFile(codexAuthPath(home), 'utf8'))
    const idToken = auth?.tokens?.id_token
    if (typeof idToken !== 'string' || idToken.split('.').length !== 3) return null
    const payload = JSON.parse(
      Buffer.from(
        idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'),
        'base64',
      ).toString('utf8'),
    )
    const email = typeof payload?.email === 'string' ? payload.email : null
    const displayName = typeof payload?.name === 'string' ? payload.name : null
    return email || displayName ? { email, displayName } : null
  } catch {
    return null
  }
}

/**
 * Every loaded account with its stable number and identity, lowest number
 * first. New homes are numbered and recorded before they are returned. An
 * account whose identity is not on record yet is read once and remembered.
 */
export async function codexAccounts({ root = codexAccountsRoot() } = {}) {
  const names = await listAccountNames(root, 'auth.json')
  if (names.length === 0) return []
  const records = await accountRecords(root, names)
  const accounts = []
  for (const name of names) {
    const record = records.get(name)
    const home = codexHomeFor(name, { root })
    if (!record.email && !record.displayName) {
      const identity = await codexIdentity(home)
      if (identity) {
        await setAccountIdentity(root, name, identity)
        record.email = identity.email ?? record.email
        record.displayName = identity.displayName ?? record.displayName
      }
    }
    accounts.push({
      number: record.number,
      name,
      home,
      ...(record.email ? { email: record.email } : {}),
      ...(record.displayName ? { displayName: record.displayName } : {}),
    })
  }
  return accounts.sort((a, b) => a.number - b.number)
}

export async function currentCodexAccountName({ root = codexAccountsRoot() } = {}) {
  return readCurrent(root)
}

export async function setCurrentCodexAccount(name, { root = codexAccountsRoot() } = {}) {
  await writeCurrent(root, name)
}

export async function nextCodexAccountName({ root = codexAccountsRoot(), prefix = 'account' } = {}) {
  return nextAccountName(root, { marker: 'auth.json', prefix })
}

/**
 * The two fields a request needs from an account's login. Null means the home
 * is not usable, so the caller refuses or rotates rather than sending an
 * unauthenticated request.
 */
export async function readCodexAuth(home) {
  try {
    const raw = await fs.readFile(codexAuthPath(home), 'utf8')
    const auth = JSON.parse(raw)
    const accessToken = auth?.tokens?.access_token
    const accountId = auth?.tokens?.account_id
    if (typeof accessToken !== 'string' || !accessToken) return null
    if (typeof accountId !== 'string' || !accountId) return null
    return { accessToken, accountId }
  } catch {
    return null
  }
}
