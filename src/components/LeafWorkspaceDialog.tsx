import wrapAnsi from 'wrap-ansi'
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Box, Text, useInput } from '../ink.js'
import TextInput from './TextInput.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { useRegisterOverlay } from '../context/overlayContext.js'
import { getCurrentSessionTitle } from '../utils/sessionStorage.js'
import { getSessionId } from '../bootstrap/state.js'
import { changeLeaf, getLeafViews, leafWorkspaceRevision, saveLeafDraft, selectLeaf, selectedLeafId, subscribeLeafWorkspace, restoreLeafWorkspace, type LeafView } from '../utils/leafWorkspace.js'

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
    <Text dimColor>{busy ? 'Starting leaf…' : 'Leaves share files unless you explicitly choose a worktree. Models run when you send a message.'}</Text>
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
  const items = [{ id: undefined, label: getCurrentSessionTitle(getSessionId()) || 'Original', state: '' }, ...views.map(view => ({ id: view.member.sessionId, label: `${view.member.number} ${view.member.name}`, state: view.process.getState() }))]
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

export function LeafWorkspaceDialog({ onDone }: { onDone: () => void }): React.ReactNode {
  useRegisterOverlay('leaf-workspace', true)
  useSyncExternalStore(subscribeLeafWorkspace, leafWorkspaceRevision, leafWorkspaceRevision)
  const [error, setError] = useState('')
  const closing = useRef(false)
  const close = () => {
    if (closing.current) return
    closing.current = true
    const views = getLeafViews()
    void Promise.all(views.map(saveLeafDraft)).then(() => { selectLeaf(); onDone() }).catch(() => { closing.current = false; setError('Could not save drafts. Your unsent text is still here.') })
  }
  return <Box flexDirection="column">
    {error && <Text color="error">{error}</Text>}
    <LeafWorkspacePanel views={getLeafViews()} onDone={close} activeId={selectedLeafId()} onSelect={selectLeaf} />
  </Box>
}

export function LeafWorkspacePanel({ views, onDone, disabled = false, activeId, onSelect }: {
  views: LeafView[]; onDone: () => void; disabled?: boolean; activeId?: string; onSelect?: (id: string) => void
}): React.ReactNode {
  const [localId, setLocalId] = useState(activeId ?? views[0]?.member.sessionId)
  const id = activeId ?? localId
  const view = views.find(item => item.member.sessionId === id)
  const [error, setError] = useState('')
  const [pickerExpanded, setPickerExpanded] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [nameCursor, setNameCursor] = useState(0)
  const [saving, setSaving] = useState(false)
  const savingName = useRef(false)
  const { columns, rows } = useTerminalSize()
  const select = (next?: string) => {
    if (disabled || saving) return
    setRenaming(false)
    setCreating(false)
    if (!next) { onDone(); return }
    setLocalId(next)
    onSelect?.(next)
  }
  useInput((_input, key) => {
    if (!key.escape || creating || savingName.current || disabled) return
    if (renaming) { setRenaming(false); setError('') }
    else onDone()
  })
  const rename = async (submittedName: string) => {
    if (!view || savingName.current) return
    if (!submittedName.trim() || submittedName.trim().length > 200) { setError('Name must contain 1–200 characters.'); return }
    savingName.current = true
    setSaving(true)
    try { await changeLeaf(view.member.sessionId, { name: submittedName.trim() }); setRenaming(false); setError('') }
    catch { setError('Rename could not be fully saved. Your transcript and draft are retained; retry the name.') }
    finally { savingName.current = false; setSaving(false) }
  }
  return <Box flexDirection="column" width={Math.max(20, columns - 2)}>
    {!view ? <Text>No leaf selected. Create a new chat or copy context with /leaf.</Text> : <>
      <Box gap={2}>
        <Text bold wrap="truncate">{view.member.name} [{view.process.getState()}]</Text>
        <Box onClick={() => { setName(view.member.name); setNameCursor(view.member.name.length); setRenaming(true) }}><Text>✎ Rename</Text></Box>
      </Box>
      {['closed', 'failed'].includes(view.process.getState()) && <Box onClick={() => { void restoreLeafWorkspace().catch(() => setError('Could not reopen this leaf. Its saved transcript and draft are retained.')) }}><Text>Retry opening saved leaf</Text></Box>}
      {creating ? <LeafCreateMenu onDone={() => setCreating(false)} model={view.member.model} effort={view.member.effort} /> : renaming ? <Box flexDirection="column">
        <TextInput value={name} onChange={setName} onSubmit={value => void rename(value)} onExit={() => { if (!saving) setRenaming(false) }} focus={!saving} showCursor={!saving} columns={Math.max(10, columns - 4)} cursorOffset={nameCursor} onChangeCursorOffset={setNameCursor} disableEscapeDoublePress />
        <Text dimColor>Enter saves · Esc cancels</Text>
      </Box> : <LeafChat key={view.member.sessionId} view={view} disabled={disabled} height={Math.max(2, rows - 10 - (pickerExpanded ? Math.min(10, Math.max(1, rows - 10), views.length + 1) + 4 : 0))} onError={setError} onCreate={() => setCreating(true)} />}
    </>}
    {error && <Text color="error">{error}</Text>}
    <LeafCarousel views={views} activeId={view?.member.sessionId} onSelect={select} onExpand={setPickerExpanded} />
    <Text dimColor>Click a session · wheel switches · hold for all · Esc returns to Original</Text>
  </Box>
}

function LeafChat({ view, disabled, height, onError, onCreate }: { view: LeafView; disabled: boolean; height: number; onError: (error: string) => void; onCreate: () => void }): React.ReactNode {
  const [draft, setDraft] = useState(view.draft)
  const [cursor, setCursor] = useState(view.draft.length)
  const [offset, setOffset] = useState(view.scrollOffset ?? 0)
  const { columns } = useTerminalSize()
  const lines = wrapAnsi(view.output.join('\n'), Math.max(1, columns - 2), { hard: true }).split('\n')
  const scroll = (delta: number) => { const next = Math.max(0, Math.min(Math.max(0, lines.length - height), (view.scrollOffset ?? 0) + delta)); view.scrollOffset = next; setOffset(next) }
  useInput((input, key) => {
    if (disabled) return
    if (key.pageUp) scroll(height)
    if (key.pageDown) scroll(-height)
    if (key.ctrl && (input === 'y' || input === 'n')) {
      const permission = view.process.getPermissions()[0]
      if (permission) act(() => view.process.approve(permission.id, input === 'y'))
    }
  })
  const act = (action: () => void) => { if (!disabled) { try { action(); onError('') } catch { onError('Action unavailable; check this leaf’s current state.') } } }
  const permissions = view.process.getPermissions()
  return <>
    <Box height={height} flexDirection="column" overflow="hidden" onWheel={event => { event.stopImmediatePropagation(); scroll(-event.deltaY * 3) }}><Text>{lines.slice(-height - offset, offset ? -offset : undefined).join('\n') || 'New conversation. Write a message below.'}</Text></Box>
    {permissions.map(permission => <Box key={permission.id} flexDirection="column">
      <Text>Approval for this leaf: {permission.tool} {JSON.stringify(permission.input)}</Text>
      <Box gap={2}><Box onClick={() => act(() => view.process.approve(permission.id, true))}><Text>Allow once</Text></Box><Box onClick={() => act(() => view.process.approve(permission.id, false))}><Text>Deny</Text></Box></Box>
    </Box>)}
    <TextInput value={draft} onChange={text => { if (!disabled) { view.draft = text; setDraft(text) } }}
      onSubmit={() => act(() => { const text = view.draft; if (!text.trim()) return; if (text.trim() === '/leaf') { view.draft = ''; setDraft(''); setCursor(0); onCreate(); return } view.process.send(text); view.output.push(`You: ${text}`); view.draft = ''; setDraft(''); setCursor(0); scroll(-Number.MAX_SAFE_INTEGER) })}
      focus={!disabled} showCursor={!disabled} columns={Math.max(10, columns - 4)} cursorOffset={cursor} onChangeCursorOffset={setCursor} disableEscapeDoublePress />
    {view.process.getState() === 'running' && <Box onClick={() => { void view.process.interrupt().catch(() => onError('Could not interrupt this leaf.')) }}><Text>Interrupt this leaf</Text></Box>}
  </>
}
