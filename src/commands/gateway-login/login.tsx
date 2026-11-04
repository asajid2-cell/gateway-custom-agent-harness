import React, { useState } from 'react'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import type {
  LocalJSXCommandCall,
  LocalJSXCommandContext,
} from '../../types/command.js'
import { Box, Text } from '../../ink.js'
import TextInput from '../../components/TextInput.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { getSessionId } from '../../bootstrap/state.js'
import {
  captureSecret,
  hasSecret,
  keysafeMode,
  listSecrets,
  removeSecret,
} from '../../utils/keysafe/index.js'
import { externalGatewayEnvPath } from '../../utils/gatewayCredentials.js'

const KEYSAFE_RELATIVE_PATH = '.claude/skills/keysafe/scripts/keysafe.ps1'

function keyLabel(keyName: string): string {
  if (keyName === 'ds') return 'DeepSeek'
  if (keyName === 'openrouter') return 'OpenRouter'
  if (keyName.startsWith('commandcode')) {
    const suffix = keyName.slice('commandcode'.length)
    return suffix ? `Command Code ${suffix}` : 'Command Code'
  }
  if (keyName.startsWith('mistralvibe') || keyName.startsWith('mistral-vibe')) {
    const suffix = keyName.replace(/^mistral-?vibe/, '')
    return suffix ? `Mistral Vibe ${suffix}` : 'Mistral Vibe'
  }
  if (keyName.startsWith('mistral')) {
    const suffix = keyName.slice('mistral'.length)
    return suffix ? `Mistral ${suffix}` : 'Mistral'
  }
  const suffix = keyName.slice('opencode-go'.length)
  return suffix ? `OpenCode Go ${suffix}` : 'OpenCode Go'
}

/**
 * Record names in the selected store. Bundled reads the vault; external reads
 * the legacy keysafe on Windows or gateway.env on POSIX.
 */
async function storedNames(): Promise<string[]> {
  if (keysafeMode() === 'bundled') return (await listSecrets()).map(entry => entry.name)
  if (process.platform !== 'win32') {
    try {
      const raw = await readFile(externalGatewayEnvPath(), 'utf8')
      const names: string[] = []
      for (const line of raw.split(/\r?\n/)) {
        const match = /^\s*(?:export\s+)?([A-Z0-9_]+)=/.exec(line)
        if (!match) continue
        const envVar = match[1]
        if (envVar === 'DEEPSEEK_API_KEY') names.push('ds')
        else if (envVar === 'AMD_API_KEY') names.push('amd-ds')
        else if (envVar === 'OPENROUTER_API_KEY') names.push('openrouter')
        else {
          const opencode = /^OPENCODE_API_KEY([2-9]|[1-9][0-9]+)?$/.exec(envVar)
          const commandcode = /^COMMANDCODE_API_KEY([2-9]|[1-9][0-9]+)?$/.exec(envVar)
          const mistralVibe = /^MISTRAL_VIBE_KEY([2-9]|[1-9][0-9]+)?$/.exec(envVar)
          const mistral = /^MISTRAL_API_KEY([2-9]|[1-9][0-9]+)?$/.exec(envVar)
          if (opencode) names.push(`opencode-go${opencode[1] ?? ''}`)
          if (commandcode) names.push(`commandcode${commandcode[1] ?? ''}`)
          if (mistralVibe) names.push(`mistralvibe${mistralVibe[1] ?? ''}`)
          if (mistral) names.push(`mistral${mistral[1] ?? ''}`)
        }
      }
      return names
    } catch {
      return []
    }
  }
  const listed = await runKeysafe('', 'list')
  if (!listed.ok) return []
  return listed.output
    .split(/\r?\n/)
    .map(line => /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s+\(stored\b/.exec(line)?.[1])
    .filter((name): name is string => Boolean(name))
}

async function storeHas(name: string): Promise<boolean> {
  if (keysafeMode() === 'bundled') return hasSecret(name)
  return (await storedNames()).includes(name)
}

async function storeCapture(
  name: string,
  value: string,
): Promise<{ ok: boolean; source: string; reason?: string }> {
  if (keysafeMode() === 'bundled') {
    try {
      await captureSecret(name, value)
      return { ok: true, source: 'bundled vault' }
    } catch (error) {
      return { ok: false, source: 'bundled vault', reason: (error as Error).message.slice(0, 300) }
    }
  }
  if (process.platform !== 'win32') {
    return {
      ok: false,
      source: 'external gateway.env',
      reason: 'external mode on this platform is read-only; the launcher owns gateway.env',
    }
  }
  const result = await runKeysafe(name, 'capture', value)
  return { ok: result.ok, source: 'external keysafe', reason: result.output }
}

async function storeRemove(
  name: string,
): Promise<{ ok: boolean; source: string; reason?: string }> {
  if (keysafeMode() === 'bundled') {
    try {
      const removed = await removeSecret(name)
      return { ok: removed, source: 'bundled vault', reason: removed ? undefined : 'not present' }
    } catch (error) {
      return { ok: false, source: 'bundled vault', reason: (error as Error).message.slice(0, 300) }
    }
  }
  if (process.platform !== 'win32') {
    return {
      ok: false,
      source: 'external gateway.env',
      reason: 'external mode on this platform is read-only',
    }
  }
  const result = await runKeysafe(name, 'remove')
  return { ok: result.ok, source: 'external keysafe', reason: result.output }
}

// The next free vault slot for a key prefix: `<prefix>` is slot 1, then
// `<prefix>2`, `<prefix>3`, ... in the first gap. This is the number the gateway
// will report for the key, so it is chosen before the key is stored.
async function nextKeySlot(prefix: string): Promise<string> {
  const used = new Set<number>()
  const pattern = new RegExp(`^${prefix}([2-9]|[1-9][0-9]+)?$`)
  for (const name of await storedNames()) {
    const match = pattern.exec(name)
    if (match) used.add(Number(match[1] || 1))
  }
  let number = 1
  while (used.has(number)) number += 1
  return number === 1 ? prefix : `${prefix}${number}`
}

async function reloadGatewayKeys(): Promise<{ ok: boolean; available?: number[]; error?: string }> {
  const base = process.env.CLAUDE_CODE_GATEWAY_BASE_URL
  if (!base) return { ok: false, error: 'Reloading keys requires gateway mode.' }
  try {
    const response = await fetch(new URL('/gateway/reload-keys', base), {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
    })
    const body = await response.json().catch(() => ({}))
    return response.ok
      ? { ok: true, available: body.available }
      : { ok: false, error: body.error ?? 'The gateway refused the key reload.' }
  } catch {
    return { ok: false, error: 'Could not reach the gateway to reload keys.' }
  }
}

// The reloaded gateway exits to pick up the new chain, so the account list is
// read back after it has come up again rather than from the reload response.
async function waitForAccounts(
  accountPath = '/gateway/opencode-account',
  timeoutMs = 8_000,
): Promise<number[] | null> {
  const base = process.env.CLAUDE_CODE_GATEWAY_BASE_URL
  if (!base) return null
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const url = new URL(accountPath, base)
      url.searchParams.set('sessionId', getSessionId())
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) {
        const body = await response.json()
        if (Array.isArray(body.available)) return body.available
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return null
}

function keyCommand(keyName: string): string {
  if (keyName === 'ds') return 'deepseeklogin'
  if (keyName === 'openrouter') return 'openrouterlogin'
  if (keyName.startsWith('commandcode')) return 'commandcodelogin'
  if (keyName.startsWith('mistralvibe') || keyName.startsWith('mistral-vibe')) return 'mistralvibelogin'
  if (keyName.startsWith('mistral')) return 'mistrallogin'
  return 'opencodelogin'
}

async function runKeysafe(
  keyName: string,
  operation: 'list' | 'capture' | 'remove',
  value?: string,
): Promise<{ ok: boolean; output: string }> {
  const script = join(homedir(), KEYSAFE_RELATIVE_PATH)
  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    operation,
    ...(operation === 'list' ? [] : [keyName]),
    ...(operation === 'capture' ? ['-FromStdin'] : []),
  ]
  const result = await execFileNoThrow('powershell.exe', args, {
    useCwd: false,
    stdin: operation === 'capture' ? 'pipe' : 'ignore',
    input: operation === 'capture' ? `${value ?? ''}\n` : undefined,
    timeout: 30_000,
    preserveOutputOnError: true,
  })
  const output = `${result.stdout}\n${result.stderr}`.trim()
  return { ok: result.code === 0, output }
}

export const call: LocalJSXCommandCall = async (
  onDone,
  _context: LocalJSXCommandContext,
  args,
  boundKeyName?: string,
) => {
  // Resolve the mode once, up front: a bad GATEWAY_*_MODE must land as a line in
  // the dialog, not as an uncaught rejection out of the store helpers (and not
  // as a throw during dialog render).
  try {
    keysafeMode()
  } catch (error) {
    onDone(`Credential store error: ${(error as Error).message}`)
    return null
  }
  const keyName = boundKeyName ?? (args.trim().startsWith('deepseek') ? 'ds' : 'opencode-go')
  const action = args.trim().toLowerCase()

  const accountKeyPrefix = keyName.startsWith('commandcode')
    ? 'commandcode'
    : /^mistral(?:[2-9]|[1-9][0-9]+)?$/.test(keyName)
      ? 'mistral'
      : keyName === 'opencode-go'
        ? 'opencode-go'
        : null
  if (accountKeyPrefix && action) {
    const label = accountKeyPrefix === 'commandcode' ? 'Command Code' : accountKeyPrefix === 'mistral' ? 'Mistral' : 'OpenCode'
    const accountPath = accountKeyPrefix === 'commandcode' ? '/gateway/commandcode-account' : accountKeyPrefix === 'mistral' ? '/gateway/mistral-account' : '/gateway/opencode-account'
    const match = new RegExp(`^(?:switch\\s+)?(?:${accountKeyPrefix})?([1-9][0-9]*)(?:\\s+(session|global))?$`).exec(action)
    if (match || action === 'status') {
      const base = process.env.CLAUDE_CODE_GATEWAY_BASE_URL
      if (!base) { onDone(`${label} account selection requires gateway mode.`); return null }
      try {
        const url = new URL(accountPath, base)
        url.searchParams.set('sessionId', getSessionId())
        const response = await fetch(url, {
          ...(match ? {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ number: Number(match[1]), scope: match[2] ?? 'session', sessionId: getSessionId() }),
          } : {}),
          signal: AbortSignal.timeout(5_000),
        })
        const result = await response.json()
        onDone(response.ok
          ? match
            ? `${label} account ${result.number} selected ${result.scope === 'global' ? 'globally' : 'for this session'}. Automatic fallback remains enabled.`
            : `${label} active account: ${result.number}; global default: ${result.global}; loaded accounts: ${result.available.join(', ')}.`
          : result.error ?? `Could not select the ${label} account.`)
      } catch { onDone('Could not reach the gateway account selector. Restart cc with the updated gateway.') }
      return null
    }
    if (action === 'new') {
      const slot = await nextKeySlot(accountKeyPrefix)
      return (
        <GatewayLoginDialog
          keyName={slot}
          accountKind={accountKeyPrefix === 'commandcode' ? 'commandcode' : accountKeyPrefix === 'mistral' ? 'mistral' : 'opencode'}
          reload
          onDone={onDone}
        />
      )
    }
    if (action !== 'remove') {
      const commandName = keyCommand(keyName)
      onDone(`Use /${commandName} new, /${commandName} switch 2 [session|global], /${commandName} status, or /${commandName} remove.`)
      return null
    }
  }

  if (action === 'status') {
    const stored = await storeHas(keyName)
    onDone(
      stored
        ? `${keyLabel(keyName)} key is stored in the ${keysafeMode()} credential store. Run /refreshlogin after changing it.`
        : `${keyLabel(keyName)} key is not configured. Run /${keyCommand(keyName)} to add it.`,
    )
    return null
  }

  if (action === 'remove') {
    const result = await storeRemove(keyName)
    onDone(
      result.ok
        ? `${keyLabel(keyName)} key removed from the ${result.source}.`
        : `Could not remove the ${keyLabel(keyName)} key (${result.source}): ${result.reason || 'unknown error'}`,
    )
    return null
  }

  return <GatewayLoginDialog keyName={keyName} onDone={onDone} />
}

function GatewayLoginDialog(props: {
  keyName: string
  onDone: (result?: string) => void
  reload?: boolean
  accountKind?: 'opencode' | 'commandcode' | 'mistral'
}): React.ReactNode {
  const [value, setValue] = useState('')
  const [cursorOffset, setCursorOffset] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const terminalSize = useTerminalSize()
  const label = keyLabel(props.keyName)
  const accountsName = props.accountKind === 'commandcode' ? 'Command Code' : props.accountKind === 'mistral' ? 'Mistral' : 'OpenCode'
  const accountsPath = props.accountKind === 'commandcode' ? '/gateway/commandcode-account' : props.accountKind === 'mistral' ? '/gateway/mistral-account' : '/gateway/opencode-account'

  const submit = async () => {
    if (busy) return
    if (!value.trim()) {
      setError('Enter a key before submitting.')
      return
    }
    setBusy(true)
    setError(null)
    const result = await storeCapture(props.keyName, value.trim())
    if (!result.ok) {
      setBusy(false)
      setError(result.reason || `The ${result.source} could not store the key.`)
      return
    }
    setValue('')
    if (props.reload) {
      const reload = await reloadGatewayKeys()
      const accounts = reload.ok ? await waitForAccounts(accountsPath) : null
      setBusy(false)
      props.onDone(
        reload.ok
          ? `${label} key saved in the ${result.source}. Gateway reloaded; ${accountsName} accounts now: ${(accounts ?? reload.available ?? []).join(', ') || 'none'}.`
          : `${label} key saved in the ${result.source}, but the gateway reload failed: ${reload.error} Run /refreshlogin to retry.`,
      )
      return
    }
    setBusy(false)
    // OpenRouter has no gateway route yet; say so instead of implying the key
    // is already in use.
    const routeNote = props.keyName === 'openrouter'
      ? ' The gateway has no OpenRouter route yet; the key is stored for when it does.'
      : ''
    props.onDone(
      `${label} key saved in the ${result.source}. Run /refreshlogin to load it without restarting cc.${routeNote}`,
    )
  }

  return (
    <Dialog
      title={`${label} gateway key`}
      onCancel={() => props.onDone('Key setup cancelled.')}
      color="permission"
    >
      <Box flexDirection="column">
        <Text dimColor>
          Enter the key once. It is stored in the {keysafeMode() === 'bundled' ? 'bundled, encrypted vault' : 'external credential store'}.
        </Text>
        <Box marginTop={1}>
          <TextInput
            value={value}
            onChange={setValue}
            onPaste={setValue}
            onSubmit={submit}
            focus
            showCursor
            mask="*"
            columns={Math.max(30, terminalSize.columns - 4)}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
          />
        </Box>
        {busy && <Text dimColor>{props.reload ? 'Saving key and reloading the gateway...' : 'Saving key...'}</Text>}
        {error && <Text color="error">{error}</Text>}
      </Box>
    </Dialog>
  )
}

// Re-read the vault into the running gateway without restarting cc. The gateway
// answers, exits, and the supervisor respawns it under a fresh keysafe chain.
export const refreshLogin: LocalJSXCommandCall = async (
  onDone,
  _context: LocalJSXCommandContext,
) => {
  const reload = await reloadGatewayKeys()
  if (!reload.ok) {
    onDone(reload.error ?? 'Could not reload the gateway keys.')
    return null
  }
  const accounts = await waitForAccounts()
  onDone(
    accounts
      ? `Gateway reloaded from Keysafe. OpenCode accounts: ${accounts.join(', ') || 'none'}.`
      : 'Gateway reloaded from Keysafe, but the account list did not come back. Check the gateway terminal.',
  )
  return null
}
