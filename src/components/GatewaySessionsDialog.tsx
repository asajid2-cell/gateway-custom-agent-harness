import React, { useEffect, useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
import { getSessionId } from '../bootstrap/state.js'
import { getGatewaySessionRuntime } from '../utils/gatewaySessionRuntime.js'
import type { GatewayPeer } from '../utils/gatewaySessionProtocol.js'
import { useRegisterOverlay } from '../context/overlayContext.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'

export function GatewaySessionsDialog({ onDone }: { onDone: () => void }): React.ReactNode {
  useRegisterOverlay('gateway-sessions', true)
  const runtime = getGatewaySessionRuntime(getSessionId())
  const [peers, setPeers] = useState<GatewayPeer[]>([])
  const [error, setError] = useState('')
  const [page, setPage] = useState(0)
  const [inbox, setInbox] = useState(false)
  const { rows } = useTerminalSize()
  const pageSize = Math.max(1, Math.floor((rows - 6) / 3))
  const refresh = () => { void runtime?.list().then(setPeers).catch(() => setError('Session discovery unavailable.')) }
  useEffect(() => { refresh() }, [runtime])
  useInput((input, key) => {
    if (key.escape) onDone()
    if (input === 'r') refresh()
    if (input === 'i') { setInbox(!inbox); setPage(0) }
    if (key.pageUp) setPage(Math.max(0, page - 1))
    if (key.pageDown) setPage(page + 1)
    if (runtime && ['a', 'h', 'f'].includes(input)) void runtime.setPolicy(input === 'a' ? 'accept' : input === 'h' ? 'hold' : 'refuse').then(() => setError(`Inbound policy: ${input === 'a' ? 'accept' : input === 'h' ? 'hold' : 'refuse'}`)).catch(() => setError('Policy was not saved.'))
  })
  const records = runtime?.transport.inbox() ?? []
  return <Box flexDirection="column">
    <Text bold>Gateway sessions — Escape closes; R refreshes; I toggles inbox</Text>
    <Text>PgUp/PgDn pages; A accept / H hold / F refuse incoming messages</Text>
    {!runtime && <Text>Communication is not active in this runtime.</Text>}
    {inbox ? records.slice(page * pageSize, (page + 1) * pageSize).map(record => <Box key={record.message.id} flexDirection="column"><Text>{record.state}: {record.senderName} — {record.message.summary}</Text><Text>{record.message.id}</Text></Box>) : peers.slice(page * pageSize, (page + 1) * pageSize).map(peer => <Box key={peer.sessionId} flexDirection="column"><Text>{peer.name} [{peer.status}]</Text><Text>{peer.sessionId}</Text><Text dimColor>{peer.cwd}</Text></Box>)}
    <Text dimColor>Use /sessions send &lt;session-id&gt; &lt;message&gt;; /sessions history &lt;title&gt;</Text>
    {error && <Text>{error}</Text>}
  </Box>
}
