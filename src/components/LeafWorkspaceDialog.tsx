import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Box, Text, useInput } from '../ink.js'
import TextInput from './TextInput.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { useRegisterOverlay } from '../context/overlayContext.js'
import { getLeafRootName, getLeafViews, selectedLeafId, selectLeaf, subscribeLeafWorkspace, leafWorkspaceRevision, type LeafView } from '../utils/leafWorkspace.js'
import { isGatewayMode } from '../utils/model/providers.js'

export function LeafSessionBar(): React.ReactNode {
  useSyncExternalStore(subscribeLeafWorkspace, leafWorkspaceRevision, leafWorkspaceRevision)
  if (!isGatewayMode()) return null
  return <Box flexDirection="column" paddingX={2} flexShrink={0}><LeafCarousel views={getLeafViews()} activeId={selectedLeafId()} onSelect={selectLeaf} /></Box>
}

export function LeafCreateMenu({ onDone, model, effort }: { onDone: () => void; model?: string; effort?: import('../utils/leafFamily.js').LeafMember['effort'] }): React.ReactNode {
  useRegisterOverlay('leaf-create', true)
  const [name, setName] = useState('')
  const [cursor, setCursor] = useState(0)
  const [busy, setBusy] = useState(false)
  const creating = useRef(false)
  const [error, setError] = useState('')
  const { columns } = useTerminalSize()
  const create = async (fresh: boolean, submittedName = name) => {
    if (creating.current) return
    creating.current = true
    setBusy(true)
    try {
      const { createLeaf } = await import('../utils/leafWorkspace.js')
      await createLeaf(submittedName.trim() || undefined, selectedLeafId(), undefined, { fresh, model, effort })
      onDone()
    } catch { setError(fresh ? 'Could not start a new leaf. Saved sessions are retained.' : 'Could not copy context. The source must have a saved conversation and be idle.'); creating.current = false; setBusy(false) }
  }
  useInput((_input, key) => { if (key.escape && !busy) onDone() })
  return <Box flexDirection="column">
    <Text bold>Create a leaf</Text>
    <Text>Name (optional):</Text>
    <TextInput value={name} onChange={setName} onSubmit={value => void create(true, value)} focus={!busy} showCursor={!busy} columns={Math.max(10, columns - 4)} cursorOffset={cursor} onChangeCursorOffset={setCursor} disableEscapeDoublePress />
    <Box onClick={() => void create(true)}><Text>New chat — start with empty conversation context</Text></Box>
    <Box onClick={() => void create(false)}><Text>Copy context — fork the current conversation</Text></Box>
    <Box onClick={() => { if (!busy) onDone() }}><Text>Cancel</Text></Box>
    <Text dimColor>{busy ? 'Starting session…' : 'Each leaf is a full interactive session. Leaves share files unless you choose a worktree.'}</Text>
    {error && <Text color="error">{error}</Text>}
  </Box>
}

export function LeafCarousel({ views, activeId, onSelect, onExpand }: {
  views: LeafView[]; activeId?: string; onSelect: (id?: string) => void; onExpand?: (expanded: boolean) => void
}): React.ReactNode {
  const { columns, rows } = useTerminalSize()
  const [expanded, setExpanded] = useState(false)
  const [page, setPage] = useState(0)
  const hold = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const held = useRef(false)
  const items = [{ id: undefined, label: getLeafRootName(), state: '' }, ...views.map(view => ({ id: view.member.sessionId, label: `${view.member.number} ${view.member.name}`, state: view.process.getState() }))]
  const active = Math.max(0, items.findIndex(item => item.id === activeId))
  const capacity = Math.max(1, Math.floor((columns - 14) / 20))
  const first = Math.max(0, Math.min(active - Math.floor(capacity / 2), items.length - capacity))
  const pageSize = Math.max(1, Math.min(10, rows - 10))
  const stopHold = () => { clearTimeout(hold.current); hold.current = undefined }
  useEffect(() => stopHold, [])
  useEffect(() => { setPage(value => Math.min(value, Math.max(0, Math.ceil(items.length / pageSize) - 1))) }, [items.length, pageSize])
  const expand = () => { setPage(Math.floor(active / pageSize)); setExpanded(true); onExpand?.(true) }
  const collapse = () => { setExpanded(false); onExpand?.(false) }
  const choose = (id?: string) => { collapse(); onSelect(id) }
  const cycle = (direction: number) => choose(items[(active + direction + items.length) % items.length]?.id)
  return <Box flexDirection="column" flexShrink={0} width="100%">
    {expanded && <Box flexDirection="column" flexShrink={0} borderStyle="single" onWheel={event => { event.stopImmediatePropagation(); setPage(value => Math.max(0, Math.min(Math.ceil(items.length / pageSize) - 1, value + event.deltaY))) }}>
      <Text bold>All sessions — click to switch</Text>
      {items.slice(page * pageSize, (page + 1) * pageSize).map(item => <Box key={item.id ?? 'original'} onClick={() => choose(item.id)}><Text inverse={item.id === activeId} wrap="truncate">{item.label}{item.state ? ` [${item.state}]` : ''}</Text></Box>)}
      <Box gap={2}>
        <Box onClick={() => setPage(value => Math.max(0, value - 1))}><Text>Previous</Text></Box>
        <Text>{page + 1}/{Math.ceil(items.length / pageSize)}</Text>
        <Box onClick={() => setPage(value => Math.min(Math.ceil(items.length / pageSize) - 1, value + 1))}><Text>Next</Text></Box>
        <Box onClick={collapse}><Text>Close list</Text></Box>
      </Box>
    </Box>}
    <Box gap={1} height={1} onWheel={event => { event.stopImmediatePropagation(); cycle(event.deltaY) }}
      onMouseDown={() => { stopHold(); held.current = false; hold.current = setTimeout(() => { held.current = true; expand() }, 450) }}
      onMouseUp={stopHold} onMouseLeave={stopHold}>
      <Box flexShrink={0} onClick={() => { if (!held.current) cycle(-1) }}><Text>‹</Text></Box>
      {items.slice(first, first + capacity).map(item => <Box key={item.id ?? 'original'} width={Math.min(20, Math.max(8, columns - 14))} flexShrink={0} onClick={() => { if (!held.current) choose(item.id) }}>
        <Text inverse={item.id === activeId} wrap="truncate">{item.label}{item.state === 'running' ? ' · working' : item.state === 'awaiting-approval' ? ' · approval' : item.state === 'failed' ? ' · failed' : ''}</Text>
      </Box>)}
      <Box flexShrink={0} onClick={() => { if (!held.current) cycle(1) }}><Text>›</Text></Box>
      <Box flexShrink={0} onClick={() => { if (!held.current) { if (expanded) collapse(); else expand() } }}><Text>All {items.length}</Text></Box>
    </Box>
  </Box>
}
