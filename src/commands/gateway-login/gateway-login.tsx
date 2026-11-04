import * as React from 'react'
import { useEffect, useState } from 'react'
import { Box, Text } from '../../ink.js'
import TextInput from '../../components/TextInput.js'
import type {
  LocalJSXCommandCall,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import {
  gatewayCredentialModes,
  hasGatewayCredential,
  removeGatewayCredential,
  saveGatewayCredential,
  type GatewayCredentialName,
} from '../../utils/gatewayCredentials.js'

type Props = {
  credential: GatewayCredentialName
  label: string
  args: string
  onDone: LocalJSXCommandOnDone
}

function GatewayLogin({
  credential,
  label,
  args,
  onDone,
}: Props): React.ReactNode {
  const action = args.trim().toLowerCase()
  const [value, setValue] = useState('')
  const [cursorOffset, setCursorOffset] = useState(0)
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    if (
      action !== 'status' &&
      action !== 'check' &&
      action !== 'remove' &&
      action !== 'clear'
    ) {
      return
    }

    let cancelled = false
    void (async () => {
      if (action === 'status' || action === 'check') {
        const present = await hasGatewayCredential(credential)
        if (!cancelled) {
          onDone(
            `${label} key: ${present ? 'present in keysafe' : 'not configured'}`,
          )
        }
        return
      }

      const removed = await removeGatewayCredential(credential)
      if (!cancelled) {
        onDone(
          removed.ok
            ? `${label} key removed from the ${removed.source}`
            : `No ${label} key was removed (${removed.source}${removed.reason ? `: ${removed.reason}` : ''})`,
        )
      }
    })()

    return () => {
      cancelled = true
    }
  }, [action, credential, label, onDone])

  if (
    action === 'status' ||
    action === 'check' ||
    action === 'remove' ||
    action === 'clear'
  ) {
    return <Text dimColor>{status ?? `Checking ${label} key…`}</Text>
  }

  const handleSubmit = async (submitted: string) => {
    const secret = submitted.trim()
    if (!secret) {
      setStatus('A non-empty key is required.')
      return
    }
    setStatus(`Saving ${label} key to the ${gatewayCredentialModes().keysafe} store…`)
    const saved = await saveGatewayCredential(credential, secret)
    setValue('')
    setCursorOffset(0)
    if (saved.ok) {
      onDone(
        `${label} key saved in the ${saved.source}. Restart cc to inject it into a new gateway process.`,
      )
      return
    }
    setStatus(`Could not save the ${label} key (${saved.source}): ${saved.reason ?? 'unknown error'}`)
  }

  return (
    <Box flexDirection="column">
      <Text>Enter the {label} API key. Input is masked and stored in keysafe.</Text>
      <TextInput
        value={value}
        onChange={setValue}
        onSubmit={handleSubmit}
        onChangeCursorOffset={setCursorOffset}
        cursorOffset={cursorOffset}
        columns={80}
        focus
        showCursor
        mask="*"
      />
      {status ? <Text color="warning">{status}</Text> : null}
    </Box>
  )
}

export const openCodeLogin: LocalJSXCommandCall = async (
  onDone,
  _context,
  args,
) => (
  <GatewayLogin
    credential="opencode-go"
    label="OpenCode Go"
    args={args}
    onDone={onDone}
  />
)

export const deepSeekLogin: LocalJSXCommandCall = async (
  onDone,
  _context,
  args,
) => (
  <GatewayLogin
    credential="ds"
    label="DeepSeek"
    args={args}
    onDone={onDone}
  />
)
