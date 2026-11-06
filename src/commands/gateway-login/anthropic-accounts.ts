import { getSessionId } from '../../bootstrap/state.js'
import { getGlobalConfig } from '../../utils/config.js'
import { getSecureStorage } from '../../utils/secureStorage/index.js'
import {
  ANTHROPIC_ACCOUNT_NAME,
  anthropicAccounts,
  anthropicAccountsRoot,
  currentAnthropicAccountName,
  findAnthropicAccount,
  nextAnthropicAccountName,
  registerAnthropicAccount,
  removeAnthropicAccount as removeAccountHome,
  setCurrentAnthropicAccount,
} from '../../../scripts/anthropic-accounts.mjs'
import { nameFromEmail } from '../../../scripts/account-store.mjs'

export type ClaudeAccount = {
  number: number
  name: string
  email?: string
  displayName?: string
}

export { anthropicAccounts, findAnthropicAccount }

function gatewayBase(): string | undefined {
  return process.env.CLAUDE_CODE_GATEWAY_BASE_URL
}

function accountLabel(account: ClaudeAccount): string {
  return account.email || account.displayName || account.name
}

// The name a person reads and types: claude1, claude2, ... The email stays
// alongside it as the identity, so the number and the account agree.
function accountName(account: ClaudeAccount): string {
  return `claude${account.number}`
}

function listing(accounts: ClaudeAccount[], active?: number): string {
  return accounts
    .map(
      account =>
        `${accountName(account)}=${accountLabel(account)}${account.name !== accountLabel(account) ? ` (${account.name})` : ''}${account.number === active ? ' (active)' : ''}`,
    )
    .join(', ')
}

/** The identity the OAuth flow recorded for the account just signed in. */
function currentIdentity(): { email: string | null; displayName: string | null } {
  const account = getGlobalConfig().oauthAccount
  return {
    email: typeof account?.emailAddress === 'string' ? account.emailAddress : null,
    displayName: typeof account?.displayName === 'string' ? account.displayName : null,
  }
}

/** The credential object the CLI currently holds (file or Keychain). */
function currentCredential(): Record<string, unknown> | null {
  const data = getSecureStorage().read()
  const oauth = (data as { claudeAiOauth?: { accessToken?: unknown; refreshToken?: unknown } } | null)
    ?.claudeAiOauth
  if (!oauth || typeof oauth.accessToken !== 'string' || typeof oauth.refreshToken !== 'string') {
    return null
  }
  return data as Record<string, unknown>
}

async function registerCredential(
  credential: Record<string, unknown>,
  requestedName?: string,
): Promise<ClaudeAccount> {
  const identity = currentIdentity()
  const name = requestedName
    ? requestedName
    : identity.email
      ? await nameFromEmail(identity.email, {
          root: anthropicAccountsRoot(),
          marker: 'credentials.json',
        })
      : await nextAnthropicAccountName()
  return registerAnthropicAccount({ name, stored: credential, identity })
}

/**
 * Copy the single sign-in the CLI already holds into the account store, so the
 * account becomes visible and switchable. The CLI's own copy is left in place:
 * a gateway started before this feature still reads it, and a copy is never
 * refreshed by two processes at once (gateway mode refreshes the store copy,
 * off-gateway mode the CLI copy).
 */
export async function adoptLegacyClaudeCredential(): Promise<ClaudeAccount | null> {
  const accounts = await anthropicAccounts()
  if (accounts.length > 0) return null
  const credential = currentCredential()
  if (!credential) return null
  return registerCredential(credential)
}

/** After a successful OAuth sign-in: store the new credential as its account. */
export async function registerCurrentClaudeLogin(
  requestedName?: string,
): Promise<{ ok: true; account: ClaudeAccount } | { ok: false; reason: string }> {
  const credential = currentCredential()
  if (!credential) {
    return { ok: false, reason: 'the sign-in produced no credential the store can read' }
  }
  if (requestedName && !ANTHROPIC_ACCOUNT_NAME.test(requestedName)) {
    return { ok: false, reason: `invalid account name: ${requestedName}` }
  }
  const existing = requestedName
    ? (await anthropicAccounts()).find(account => account.name === requestedName)
    : undefined
  if (existing) {
    return {
      ok: false,
      reason: `account ${requestedName} already exists (${accountLabel(existing)}); pick another name or remove it first`,
    }
  }
  try {
    const account = await registerCredential(credential, requestedName)
    return { ok: true, account }
  } catch (error) {
    return { ok: false, reason: (error as Error).message }
  }
}

export type AnthropicSelection = {
  number: number
  global: number
  accounts: ClaudeAccount[]
}

export async function fetchAnthropicSelection(): Promise<AnthropicSelection | null> {
  const base = gatewayBase()
  if (!base) return null
  try {
    const url = new URL('/gateway/anthropic-account', base)
    url.searchParams.set('sessionId', getSessionId())
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) })
    if (!response.ok) return null
    const body = await response.json()
    if (!Array.isArray(body?.accounts)) return null
    return {
      number: Number(body.number) || 1,
      global: Number(body.global) || 1,
      accounts: body.accounts.map((account: ClaudeAccount) => ({
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

export async function anthropicStatusMessage(): Promise<string> {
  const adopted = await adoptLegacyClaudeCredential()
  const [accounts, selection, currentName] = await Promise.all([
    anthropicAccounts(),
    fetchAnthropicSelection(),
    currentAnthropicAccountName(),
  ])
  if (accounts.length === 0) {
    return 'No Claude account is stored. Run /login claude to sign in; each account keeps its own email.'
  }
  const active =
    selection?.number ??
    accounts.find(account => account.name === currentName)?.number ??
    accounts[0]?.number
  const lines = accounts.map(account => `  ${accountName(account)}  ${accountLabel(account)}${account.name !== accountLabel(account) ? ` (${account.name})` : ''}${account.number === active ? '  <- active' : ''}`)
  const adoptedNote = adopted
    ? `\nAdopted the existing Claude sign-in as account ${accountName(adopted)} (${accountLabel(adopted)}).`
    : ''
  return (
    `Claude accounts (${accounts.length}):\n${lines.join('\n')}` +
    (selection
      ? `\nSession account: ${selection.number}; global: ${selection.global}. A request that fails on one account retries with the next.`
      : '\nThis gateway does not report Claude accounts, so switching is unavailable here; restart cc on the updated gateway to enable it.') +
    adoptedNote
  )
}

export async function selectAnthropicAccount(
  target: string,
  scope: 'session' | 'global',
): Promise<{ ok: boolean; message: string }> {
  const base = gatewayBase()
  if (!base) {
    return { ok: false, message: 'Selecting a Claude account requires gateway mode.' }
  }
  const accounts: ClaudeAccount[] = await anthropicAccounts()
  if (accounts.length === 0) {
    return { ok: false, message: 'No Claude account is stored. Run /login claude first.' }
  }
  const account = findAnthropicAccount(accounts, target)
  if (!account) {
    return { ok: false, message: `No Claude account ${target}. Available: ${listing(accounts)}.` }
  }
  try {
    const response = await fetch(new URL('/gateway/anthropic-account', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        number: account.number,
        name: account.name,
        email: account.email,
        scope,
        sessionId: getSessionId(),
      }),
      signal: AbortSignal.timeout(5_000),
    })
    if (response.status === 404) {
      return {
        ok: false,
        message: 'This gateway does not expose Claude accounts yet; restart cc on the updated gateway.',
      }
    }
    const body = await response.json().catch(() => ({}))
    if (!response.ok) {
      return { ok: false, message: body.error ?? 'The gateway refused the Claude account switch.' }
    }
    return {
      ok: true,
      message:
        `Claude account ${account.number} (${accountLabel(account)}) selected ` +
        `${scope === 'global' ? 'globally' : 'for this session'}. ` +
        'A request that fails on it retries with the next account.',
    }
  } catch {
    return { ok: false, message: 'Could not reach the gateway to switch the Claude account.' }
  }
}

/**
 * Remove one account home. The global selection is moved off it first, so no
 * launcher reads a name whose home is gone.
 */
export async function removeClaudeAccount(
  target: string,
): Promise<{ ok: boolean; message: string }> {
  const accounts: ClaudeAccount[] = await anthropicAccounts()
  const account = findAnthropicAccount(accounts, target)
  if (!account) {
    return { ok: false, message: `No Claude account ${target}. Available: ${listing(accounts)}.` }
  }
  const current = await currentAnthropicAccountName()
  try {
    await removeAccountHome(account.name)
  } catch (error) {
    return { ok: false, message: `Could not remove Claude account ${account.name}: ${(error as Error).message}` }
  }
  let selectionNote = ''
  if (current === account.name) {
    const next = accounts.filter(candidate => candidate.name !== account.name)[0]?.name ?? 'default'
    try {
      await setCurrentAnthropicAccount(next)
      selectionNote = next === 'default' ? ' No Claude account remains selected.' : ` The global selection moved to ${next}.`
    } catch {
      selectionNote = ' The global selection still names the removed account; run /login claude switch.'
    }
  }
  return { ok: true, message: `Claude account ${accountLabel(account)} removed.${selectionNote}` }
}
