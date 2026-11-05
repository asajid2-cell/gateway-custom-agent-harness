/**
 * A numbered store of account homes.
 *
 * Several providers authenticate with a file per account (a Codex `auth.json`,
 * a Claude `.credentials.json`). This module is the shared bookkeeping: which
 * homes are loaded, the stable number each name keeps, the human's current
 * selection, and the identity (email / display name) that must follow the
 * account so a list of tens of sign-ins stays readable.
 *
 * `registry.json` is bookkeeping, not authority: an account is loaded only
 * while its marker file exists. A name keeps the number it was first given, and
 * a new name takes the lowest free number, so switching by number survives
 * adding and removing accounts. There is no cap on the number of accounts.
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const ACCOUNT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function accountRoot(envName, defaultDir, { home = os.homedir() } = {}) {
  const override = process.env[envName]
  if (override) return path.resolve(override)
  return path.join(home, defaultDir)
}

/** Directory names under `root` that carry `marker`, sorted for stable output. */
export async function listAccountNames(root, marker) {
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const names = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !ACCOUNT_NAME.test(entry.name)) continue
    try {
      await fs.access(path.join(root, entry.name, marker))
      names.push(entry.name)
    } catch {}
  }
  return names.sort((a, b) => a.localeCompare(b))
}

function registryPath(root) {
  return path.join(root, 'registry.json')
}

export async function readRegistry(root) {
  try {
    const parsed = JSON.parse(await fs.readFile(registryPath(root), 'utf8'))
    const records = Array.isArray(parsed?.accounts) ? parsed.accounts : []
    return records.filter(
      record =>
        record &&
        Number.isSafeInteger(record.number) &&
        record.number > 0 &&
        typeof record.name === 'string' &&
        ACCOUNT_NAME.test(record.name),
    )
  } catch {
    return []
  }
}

export async function writeRegistry(root, accounts) {
  const temp = `${registryPath(root)}.${randomUUID()}.tmp`
  const ordered = [...accounts].sort((a, b) => a.number - b.number)
  try {
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(temp, `${JSON.stringify({ accounts: ordered }, null, 2)}\n`)
    await fs.rename(temp, registryPath(root))
  } catch {
    await fs.unlink(temp).catch(() => {})
  }
}

/**
 * The registry as it applies to the loaded names: every loaded name gets a
 * number, numbers are never rearranged, and bookkeeping for home directories
 * that are gone is dropped. Extra identity fields on a survivor are preserved.
 */
export async function accountRecords(root, names) {
  const records = await readRegistry(root)
  const byName = new Map()
  for (const record of records) {
    if (!byName.has(record.name)) byName.set(record.name, { ...record })
  }
  const taken = new Set([...byName.values()].map(record => record.number))
  let changed = false
  for (const name of names) {
    if (byName.has(name)) continue
    let number = 1
    while (taken.has(number)) number += 1
    byName.set(name, { number, name })
    taken.add(number)
    changed = true
  }
  const live = new Set(names)
  for (const name of [...byName.keys()]) {
    if (!live.has(name)) {
      byName.delete(name)
      changed = true
    }
  }
  if (changed) await writeRegistry(root, [...byName.values()])
  return byName
}

/** Merge an identity onto an existing record; no-op when it is unchanged. */
export async function setAccountIdentity(root, name, identity) {
  const records = await readRegistry(root)
  const record = records.find(candidate => candidate.name === name)
  if (!record) return false
  let changed = false
  for (const key of ['email', 'displayName']) {
    const value = identity?.[key]
    if (typeof value === 'string' && value && record[key] !== value) {
      record[key] = value
      changed = true
    }
  }
  if (changed) await writeRegistry(root, records)
  return changed
}

export async function readCurrent(root) {
  try {
    const raw = await fs.readFile(path.join(root, 'current.txt'), 'utf8')
    const name = raw.replace(/^\uFEFF/, '').trim()
    return name && ACCOUNT_NAME.test(name) ? name : null
  } catch {
    return null
  }
}

export async function writeCurrent(root, name) {
  if (!ACCOUNT_NAME.test(name)) throw new Error(`Invalid account name: ${name}`)
  const target = path.join(root, 'current.txt')
  const temp = `${target}.${randomUUID()}.tmp`
  await fs.mkdir(root, { recursive: true })
  await fs.writeFile(temp, `${name}\n`)
  await fs.rename(temp, target)
}

/** The next name neither on disk nor reserved in the registry. */
export async function nextAccountName(root, { marker, prefix = 'account' } = {}) {
  const taken = new Set(await listAccountNames(root, marker))
  for (const record of await readRegistry(root)) taken.add(record.name)
  let index = 1
  while (taken.has(`${prefix}${index}`)) index += 1
  return `${prefix}${index}`
}

/** A filesystem-safe account name derived from an email, never duplicated. */
export async function nameFromEmail(email, { root, marker }) {
  const taken = new Set(await listAccountNames(root, marker))
  for (const record of await readRegistry(root)) taken.add(record.name)
  const local = String(email ?? '')
    .split('@')[0]
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 40)
  const base = ACCOUNT_NAME.test(local) ? local : 'account'
  if (!taken.has(base)) return base
  let index = 2
  while (taken.has(`${base}-${index}`)) index += 1
  return `${base}-${index}`
}
