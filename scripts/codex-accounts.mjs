/**
 * Codex account homes.
 *
 * A Codex login is a home directory holding `auth.json`. Multiple homes are how
 * one machine carries several ChatGPT subscriptions, and `codex-acct` already
 * keeps them under `~/.codex-accounts/<name>/` with `current.txt` naming the
 * human's selection.
 *
 * The gateway and the /login picker need a *stable number* per account so a
 * selection survives adding or removing a home, exactly like the numbered
 * OPENCODE_API_KEY/COMMANDCODE_API_KEY slots. `registry.json` is that mapping:
 * a name keeps the number it was first given, and a new name takes the lowest
 * free number. The registry is bookkeeping, not authority - an account is
 * loaded only while its `auth.json` exists.
 *
 * Never read, log, or echo the contents of `auth.json` beyond the two fields the
 * request needs.
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const CODEX_ACCOUNT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function codexAccountsRoot({ home = os.homedir() } = {}) {
  // An explicit root is the test seam and the only way to keep a gateway under
  // test from reading the operator's real account homes.
  const override = process.env.CODEX_ACCOUNTS_HOME
  if (override) return path.resolve(override)
  return path.join(home, '.codex-accounts')
}

export function codexHomeFor(name, { root = codexAccountsRoot() } = {}) {
  return path.join(root, name)
}

export function codexAuthPath(home) {
  return path.join(home, 'auth.json')
}

async function hasAuth(home) {
  try {
    await fs.access(codexAuthPath(home))
    return true
  } catch {
    return false
  }
}

/** Directory names under the accounts root that carry a login. */
export async function listCodexAccountNames({ root = codexAccountsRoot() } = {}) {
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const names = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !CODEX_ACCOUNT_NAME.test(entry.name)) continue
    if (await hasAuth(path.join(root, entry.name))) names.push(entry.name)
  }
  return names.sort((a, b) => a.localeCompare(b))
}

function registryPath(root) {
  return path.join(root, 'registry.json')
}

async function readRegistryNumbers(root) {
  try {
    const parsed = JSON.parse(await fs.readFile(registryPath(root), 'utf8'))
    const records = Array.isArray(parsed?.accounts) ? parsed.accounts : []
    const numbers = new Map()
    for (const record of records) {
      if (!record || !Number.isSafeInteger(record.number) || record.number < 1) continue
      if (typeof record.name !== 'string' || !CODEX_ACCOUNT_NAME.test(record.name)) continue
      if (!numbers.has(record.name)) numbers.set(record.name, record.number)
    }
    return numbers
  } catch {
    return new Map()
  }
}

async function writeRegistryNumbers(root, numbers) {
  const temp = `${registryPath(root)}.${randomUUID()}.tmp`
  const accounts = [...numbers.entries()]
    .map(([name, number]) => ({ number, name }))
    .sort((a, b) => a.number - b.number)
  try {
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(temp, `${JSON.stringify({ accounts }, null, 2)}\n`)
    await fs.rename(temp, registryPath(root))
  } catch {
    await fs.unlink(temp).catch(() => {})
  }
}

/**
 * Every loaded account with its stable number, lowest number first. New homes
 * are added to the registry (and the registry saved) before they are returned,
 * so the number a caller sees is the number a later caller sees.
 */
export async function codexAccounts({ root = codexAccountsRoot() } = {}) {
  const names = await listCodexAccountNames({ root })
  if (names.length === 0) return []
  const numbers = await readRegistryNumbers(root)
  const taken = new Set(numbers.values())
  let changed = false
  for (const name of names) {
    if (numbers.has(name)) continue
    let number = 1
    while (taken.has(number)) number += 1
    numbers.set(name, number)
    taken.add(number)
    changed = true
  }
  // Drop bookkeeping for homes that are gone, but never renumber a survivor.
  const live = new Set(names)
  for (const name of [...numbers.keys()]) {
    if (!live.has(name)) {
      numbers.delete(name)
      changed = true
    }
  }
  if (changed) await writeRegistryNumbers(root, numbers)
  return names
    .map(name => ({ number: numbers.get(name), name, home: codexHomeFor(name, { root }) }))
    .sort((a, b) => a.number - b.number)
}

/** The human's selection, as written by `codex-acct use` and by /login. */
export async function currentCodexAccountName({ root = codexAccountsRoot() } = {}) {
  try {
    const raw = await fs.readFile(path.join(root, 'current.txt'), 'utf8')
    const name = raw.replace(/^\uFEFF/, '').trim()
    return name && CODEX_ACCOUNT_NAME.test(name) ? name : null
  } catch {
    return null
  }
}

export async function setCurrentCodexAccount(name, { root = codexAccountsRoot() } = {}) {
  if (!CODEX_ACCOUNT_NAME.test(name)) throw new Error(`Invalid Codex account name: ${name}`)
  const temp = `${path.join(root, 'current.txt')}.${randomUUID()}.tmp`
  await fs.mkdir(root, { recursive: true })
  await fs.writeFile(temp, `${name}\n`)
  await fs.rename(temp, path.join(root, 'current.txt'))
}

/** The next name that is neither on disk nor reserved in the registry. */
export async function nextCodexAccountName({ root = codexAccountsRoot(), prefix = 'account' } = {}) {
  const taken = new Set(await listCodexAccountNames({ root }))
  const numbers = await readRegistryNumbers(root)
  for (const name of numbers.keys()) taken.add(name)
  let index = 1
  while (taken.has(`${prefix}${index}`)) index += 1
  return `${prefix}${index}`
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
