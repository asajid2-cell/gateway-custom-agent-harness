import { rm } from 'node:fs/promises'
import { getSessionId } from '../../bootstrap/state.js'
import {
  CODEX_ACCOUNT_NAME,
  codexAccounts,
  codexHomeFor,
  currentCodexAccountName,
  nextCodexAccountName,
  setCurrentCodexAccount,
} from '../../../scripts/codex-accounts.mjs'

export type CodexAccount = {
  number: number
  name: string
  email?: string
  displayName?: string
}

export { CODEX_ACCOUNT_NAME, codexAccounts, codexHomeFor, nextCodexAccountName }

export type CodexSelection = {
  number: number
  global: number
  accounts: CodexAccount[]
}

function gatewayBase(): string | undefined {
  return process.env.CLAUDE_CODE_GATEWAY_BASE_URL
}

/** The active account, as the running gateway sees it. */
export async function fetchCodexSelection(): Promise<CodexSelection | null> {
  const base = gatewayBase()
  if (!base) return null
  try {
    const url = new URL('/gateway/codex-account', base)
    url.searchParams.set('sessionId', getSessionId())
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) })
    if (!response.ok) return null
    const body = await response.json()
    if (!Array.isArray(body?.accounts)) return null
    return {
      number: Number(body.number) || 1,
      global: Number(body.global) || 1,
      accounts: body.accounts.map((account: CodexAccount) => ({
        number: account.number,
        name: String(account.name),
        ...(account.email ? { email: String(account.email) } : {}),
        ...(account.displayName ? { displayName: String(account.displayName) } : {}),
      })),
    }
  } catch {
    return null
  }
}

function resolve(accounts: CodexAccount[], target: string): CodexAccount | undefined {
  if (/^[1-9][0-9]*$/.test(target)) {
    return accounts.find(account => account.number === Number(target))
  }
  return accounts.find(account => account.name === target)
}

function accountLabel(account: CodexAccount): string {
  return account.email || account.displayName || account.name
}

// The name a person reads and types: openai1, openai2, ... The account's own
// label stays alongside it.
function accountName(account: CodexAccount): string {
  return `openai${account.number}`
}

function listing(accounts: CodexAccount[], active?: number): string {
  return accounts
    .map(
      account =>
        `${accountName(account)}=${accountLabel(account)}${account.name !== accountLabel(account) ? ` (${account.name})` : ''}${account.number === active ? ' (active)' : ''}`,
    )
    .join(', ')
}

function accountLines(accounts: CodexAccount[], active?: number): string {
  return accounts
    .map(
      account =>
        `  ${accountName(account)}  ${accountLabel(account)}${account.name !== accountLabel(account) ? ` (${account.name})` : ''}${account.number === active ? '  <- active' : ''}`,
    )
    .join('\n')
}

/**
 * The status line. The gateway knows the session pin; when it is unreachable the
 * local homes are still worth reporting, so say which fact is missing rather
 * than showing nothing.
 */
export async function codexStatusMessage(): Promise<string> {
  const [accounts, selection, currentName] = await Promise.all([
    codexAccounts(),
    fetchCodexSelection(),
    currentCodexAccountName(),
  ])
  if (accounts.length === 0) {
    return 'No Codex account is signed in. Run /login codex new [name] to sign in with ChatGPT device auth.'
  }
  if (selection) {
    return (
      `Codex accounts (${selection.accounts.length}):\n${accountLines(selection.accounts, selection.number)}\n` +
      `Session account: ${selection.number}; global: ${selection.global}. ` +
      'A request that fails on one account retries with the next one.'
    )
  }
  const current = accounts.find(
    (account: CodexAccount) => account.name === currentName,
  )
  return (
    `Codex accounts (${accounts.length}):\n${accountLines(accounts, current?.number ?? accounts[0]?.number)}\n` +
    'This gateway does not report Codex accounts, so switching is unavailable here; ' +
    'restart cc on the updated gateway to enable it. ' +
    'The account marked active is the one the global selection names.'
  )
}

export async function selectCodexAccount(
  target: string,
  scope: 'session' | 'global',
): Promise<{ ok: boolean; message: string }> {
  const base = gatewayBase()
  if (!base) {
    return { ok: false, message: 'Selecting a Codex account requires gateway mode.' }
  }
  const accounts: CodexAccount[] = await codexAccounts()
  if (accounts.length === 0) {
    return { ok: false, message: 'No Codex account is loaded. Run /login codex new first.' }
  }
  const account = resolve(accounts, target)
  if (!account) {
    return {
      ok: false,
      message: `No Codex account ${target}. Available: ${listing(accounts)}.`,
    }
  }
  try {
    const response = await fetch(new URL('/gateway/codex-account', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        number: account.number,
        name: account.name,
        scope,
        sessionId: getSessionId(),
      }),
      signal: AbortSignal.timeout(5_000),
    })
    const body = await response.json().catch(() => ({}))
    if (response.status === 404) {
      return {
        ok: false,
        message: 'This gateway does not expose Codex accounts yet; restart cc on the updated gateway.',
      }
    }
    if (!response.ok) {
      return { ok: false, message: body.error ?? 'The gateway refused the Codex account switch.' }
    }
    return {
      ok: true,
      message:
        `Codex account ${accountName(account)} (${account.name}) selected ` +
        `${scope === 'global' ? 'globally' : 'for this session'}. ` +
        'A request that fails on it retries with the next loaded account.',
    }
  } catch {
    return { ok: false, message: 'Could not reach the gateway to switch the Codex account.' }
  }
}

/**
 * Remove one account home. Refuses to leave `current.txt` pointing at a home
 * that no longer exists - the launcher refuses that state at startup.
 */
export async function removeCodexAccount(target: string): Promise<{ ok: boolean; message: string }> {
  const accounts: CodexAccount[] = await codexAccounts()
  const account = resolve(accounts, target)
  if (!account) {
    return {
      ok: false,
      message: `No Codex account ${target}. Available: ${listing(accounts)}.`,
    }
  }
  const current = await currentCodexAccountName()
  try {
    await rm(codexHomeFor(account.name), { recursive: true, force: true })
  } catch (error) {
    return { ok: false, message: `Could not remove Codex account ${account.name}: ${(error as Error).message}` }
  }
  let selectionNote = ''
  if (current === account.name) {
    const remaining = accounts.filter(candidate => candidate.name !== account.name)
    const next = remaining[0]?.name ?? 'default'
    try {
      await setCurrentCodexAccount(next)
      selectionNote = ` The global selection moved to ${next}.`
    } catch {
      selectionNote = ' The global selection still names the removed account; run codex-acct use.'
    }
  }
  return { ok: true, message: `Codex account ${account.name} removed.${selectionNote}` }
}
