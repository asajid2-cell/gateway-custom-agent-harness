import React, { useState } from 'react'
import { access } from 'node:fs/promises'
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

const KEYSAFE_RELATIVE_PATH = '.claude/skills/keysafe/scripts/keysafe.ps1'

function keyPath(keyName: string): string {
  return join(homedir(), '.keysafe', `${keyName}.cred`)
}

function keyLabel(keyName: string): string {
  if (keyName === 'ds') return 'DeepSeek'
  if (keyName === 'openrouter') return 'OpenRouter'
  if (keyName === 'commandcode') return 'Command Code'
  return 'OpenCode Go'
}

function keyCommand(keyName: string): string {
  if (keyName === 'ds') return 'deepseeklogin'
  if (keyName === 'openrouter') return 'openrouterlogin'
  if (keyName === 'commandcode') return 'commandcodelogin'
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
  const keyName = boundKeyName ?? (args.trim().startsWith('deepseek') ? 'ds' : 'opencode-go')
  const action = args.trim().toLowerCase()

  if (action === 'status') {
    const stored = await access(keyPath(keyName)).then(() => true).catch(() => false)
    onDone(
      stored
        ? `${keyLabel(keyName)} key is stored in Keysafe. Restart the gateway terminal after changing it.`
        : `${keyLabel(keyName)} key is not configured. Run /${keyCommand(keyName)} to add it.`,
    )
    return null
  }

  if (action === 'remove') {
    const result = await runKeysafe(keyName, 'remove')
    onDone(
      result.ok
        ? `${keyLabel(keyName)} key removed from Keysafe.`
        : `Could not remove the ${keyLabel(keyName)} key: ${result.output || 'unknown error'}`,
    )
    return null
  }

  return <GatewayLoginDialog keyName={keyName} onDone={onDone} />
}

function GatewayLoginDialog(props: {
  keyName: string
  onDone: (result?: string) => void
}): React.ReactNode {
  const [value, setValue] = useState('')
  const [cursorOffset, setCursorOffset] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const terminalSize = useTerminalSize()
  const label = keyLabel(props.keyName)

  const submit = async () => {
    if (busy) return
    if (!value.trim()) {
      setError('Enter a key before submitting.')
      return
    }
    setBusy(true)
    setError(null)
    const result = await runKeysafe(props.keyName, 'capture', value.trim())
    setBusy(false)
    if (!result.ok) {
      setError(result.output || 'Keysafe could not store the key.')
      return
    }
    setValue('')
    props.onDone(
      `${label} key saved in Keysafe. Start a new terminal, or restart the current gateway terminal, to inject it.`,
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
          Enter the key once. It is stored encrypted in the local Keysafe vault.
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
        {busy && <Text dimColor>Saving key...</Text>}
        {error && <Text color="error">{error}</Text>}
      </Box>
    </Dialog>
  )
}
