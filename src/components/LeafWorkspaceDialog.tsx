import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Box, Text, useInput } from '../ink.js'
import { Select } from './CustomSelect/select.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { useRegisterOverlay } from '../context/overlayContext.js'
import { LEAF_EFFORT_LEVELS, getLeafRootName, getLeafViews, listLeafMembers, selectedLeafId, selectLeaf, subscribeLeafWorkspace, leafWorkspaceRevision, type LeafView } from '../utils/leafWorkspace.js'
import type { LeafMember } from '../utils/leafFamily.js'
import { isLeafProcessAlive } from '../utils/leafProcess.js'
import { isGatewayMode } from '../utils/model/providers.js'

export function LeafSessionBar(): React.ReactNode {
  useSyncExternalStore(subscribeLeafWorkspace, leafWorkspaceRevision, leafWorkspaceRevision)
  if (!isGatewayMode()) return null
  return <Box flexDirection="column" paddingX={2} flexShrink={0}><LeafCarousel views={getLeafViews()} activeId={selectedLeafId()} onSelect={selectLeaf} /></Box>
}

/** Effort choices offered by the wizard; `inherit` keeps the parent's effort. */
const EFFORT_CHOICES: readonly string[] = ['inherit', ...LEAF_EFFORT_LEVELS]

const MODEL_INHERIT = 'inherit'
const MODEL_DEFAULT = 'default'

function effortLabel(value: string): string {
  return value === 'inherit' ? 'Same as me' : value
}

function modelLabel(value: string): string {
  if (value === MODEL_DEFAULT) return 'Gateway default'
  if (value === MODEL_INHERIT) return 'Same as me'
  return value
}

/** Enter on a choice row advances to its next value and wraps. */
function nextIn(values: readonly string[], current: string): string {
  const index = values.indexOf(current)
  return values[(index + 1) % values.length] ?? values[0]!
}

/**
 * The `/leaf` surface: a guided menu over the leaf family instead of a command
 * grammar. Bare `/leaf` opens this; `/leaf <args>` still hits the arg grammar.
 *
 * Nothing here starts a leaf except "Open", which is the point: leaves used to
 * relaunch themselves on every mount, which read as random background chats.
 */
export function LeafMenu({ onDone, model, effort }: { onDone: (result?: string) => void; model?: string; effort?: string }): React.ReactNode {
  useRegisterOverlay('leaf-menu', true)
  const [screen, setScreen] = useState<'home' | 'list' | 'create'>('home')
  const [members, setMembers] = useState<LeafMember[] | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  // Refresh the family roster whenever the workspace publishes a change.
  useSyncExternalStore(subscribeLeafWorkspace, leafWorkspaceRevision, leafWorkspaceRevision)
  const reload = () => { void listLeafMembers().then(setMembers).catch(() => setMembers([])) }
  useEffect(reload, [screen])

  const run = async (label: string, action: () => Promise<string | void>) => {
    if (busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const result = await action()
      reload()
      setNotice(result || label)
    } catch (failure) {
      const reason = failure instanceof Error ? failure.message.replace(/\s+/g, ' ').trim() : ''
      setError(reason || 'That leaf action failed. Saved sessions are retained.')
    } finally {
      setBusy(false)
    }
  }

  if (screen === 'create') {
    return <LeafCreateWizard
      members={members}
      selectedId={selectedLeafId()}
      rootName={getLeafRootName()}
      defaultModel={model}
      defaultEffort={effort}
      onDone={result => { if (result) void run(result, async () => result); setScreen('home') }}
      onCancel={() => setScreen('home')}
    />
  }

  if (screen === 'list') {
    const open = members?.filter(member => member.status !== 'archived') ?? []
    const options = [
      ...open.map(member => ({
        value: `open:${member.sessionId}`,
        label: `Open  #${member.number} ${member.name}`,
        description: `${member.status}${member.model ? ` · ${member.model}` : ''}${member.effort ? ` · ${member.effort}` : ''}`,
      })),
      ...open.map(member => ({
        value: `close:${member.sessionId}`,
        label: `Close #${member.number} ${member.name}`,
        description: 'Stop its process; the transcript and its place in the family are kept',
      })),
      ...open.map(member => ({
        value: `archive:${member.sessionId}`,
        label: `Archive #${member.number} ${member.name}`,
        description: 'Detach it from this family and hide it from this menu; the transcript is kept',
      })),
      ...(open.length === 0 ? [{ value: 'empty', label: 'No saved leaves yet', description: 'Go back and create one' }] : []),
      { value: 'back', label: 'Back', description: 'Return to the leaf menu' },
    ]
    return <Box flexDirection="column">
      <Text bold>Leaves in this family</Text>
      <Text dimColor>Opening a leaf is the only thing that starts its process. Closed leaves stay closed until you open them again.</Text>
      <Select options={options} visibleOptionCount={12} onCancel={() => setScreen('home')} onChange={(value: string) => {
        if (value === 'back' || value === 'empty') { setScreen('home'); return }
        const id = value.slice(value.indexOf(':') + 1)
        const member = members?.find(item => item.sessionId === id)
        const action = value.slice(0, value.indexOf(':'))
        void run('', async () => {
          const workspace = await import('../utils/leafWorkspace.js')
          if (action === 'open') return workspace.openLeaf(id)
          await workspace.changeLeaf(id, { status: action === 'archive' ? 'archived' : 'closed' })
          selectLeaf(undefined)
          return action === 'archive'
            ? `Leaf #${member?.number} ${member?.name} archived. It is detached from this family and no longer appears here; its transcript and session are untouched.`
            : `Leaf #${member?.number} ${member?.name} closed. Its transcript is retained; open it again any time.`
        })
      }} />
      {busy && <Text dimColor>Working…</Text>}
      {notice && <Text>{notice}</Text>}
      {error && <Text color="error">{error}</Text>}
    </Box>
  }

  const selected = selectedLeafId()
  const sourceName = selected ? (members?.find(member => member.sessionId === selected)?.name ?? selected) : getLeafRootName()
  const options: Array<{ value: string; label: string; description?: string; type?: 'text' }> = [
    { value: 'create', label: 'Create a leaf', description: 'Name it, choose its model and effort, then create it' },
    { value: 'list', label: 'Leaves in this family', description: members ? `${members.length} saved — open, close, or reopen one` : 'Loading…' },
    { value: 'exit', label: 'Cancel', description: 'Leave the leaf workspace' },
  ]
  return <Box flexDirection="column">
    <Text bold>Leaves</Text>
    <Text dimColor>Each leaf is a full independent session. They share your files unless you point one at a separate worktree.</Text>
    <Text dimColor>Nothing starts until you open it. Creating a leaf forks the session you are looking at: {sourceName}.</Text>
    <Select options={options} visibleOptionCount={6} onCancel={() => onDone()} onChange={(value: string) => {
      if (value === 'exit') { onDone(); return }
      if (value === 'list') { setScreen('list'); return }
      setError('')
      setNotice('')
      setScreen('create')
    }} />
    {notice && <Text>{notice}</Text>}
    {error && <Text color="error">{error}</Text>}
  </Box>
}

/**
 * Create-leaf wizard. Every field is editable before the single confirm, and
 * the fork source is shown as a choice rather than implied - forking the wrong
 * conversation was the failure mode when the source was invisible.
 */
export function LeafCreateWizard({ members, selectedId, rootName, defaultModel, defaultEffort, onDone, onCancel }: {
  members?: LeafMember[]
  selectedId?: string
  rootName: string
  defaultModel?: string
  defaultEffort?: string
  onDone: (result?: string) => void
  onCancel: () => void
}): React.ReactNode {
  useRegisterOverlay('leaf-create', true)
  const [name, setName] = useState('')
  const [fresh, setFresh] = useState(false)
  const [source, setSource] = useState(selectedId ?? 'root')
  const [model, setModel] = useState(defaultModel || MODEL_DEFAULT)
  const [effort, setEffort] = useState(defaultEffort || 'inherit')
  const [worktree, setWorktree] = useState('')
  const [goal, setGoal] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const creating = useRef(false)

  const sources = [
    { value: 'root', label: rootName, description: selectedId ? 'The original conversation' : 'The current conversation' },
    ...(members ?? []).filter(member => member.status !== 'archived').map(member => ({
      value: member.sessionId,
      label: `#${member.number} ${member.name}`,
      description: member.status,
    })),
  ]
  const sourceName = sources.find(item => item.value === source)?.label ?? source

  const create = async () => {
    if (creating.current) return
    creating.current = true
    setBusy(true)
    setError('')
    try {
      const { createLeaf, setLeafGoal } = await import('../utils/leafWorkspace.js')
      const parent = source === 'root' ? undefined : source
      const view = await createLeaf(
        name.trim() || undefined,
        parent,
        worktree.trim() || undefined,
        { fresh, model: model === MODEL_DEFAULT || model === MODEL_INHERIT ? undefined : model, effort: (effort === 'inherit' ? undefined : effort) as LeafMember['effort'] },
      )
      // A goal is recorded through the same path `/leaf goal` uses, so the two
      // surfaces cannot drift apart.
      if (goal.trim()) await setLeafGoal(view.member.sessionId, `task ${goal.trim()}`)
      onDone(`Created ${fresh ? 'a new chat as' : 'a fork of ' + sourceName + ' as'} leaf #${view.member.number} ${view.member.name}. It is open now.`)
    } catch (failure) {
      const reason = failure instanceof Error ? failure.message.replace(/\s+/g, ' ').trim() : ''
      setError(reason || (fresh ? 'Could not start a new leaf. Saved sessions are retained.' : 'Could not fork. The source must have a saved conversation and be idle.'))
      creating.current = false
      setBusy(false)
    }
  }

  useInput((_input, key) => { if (key.escape && !busy) onCancel() })

  const summary = `${fresh ? 'New chat' : `Fork of ${sourceName}`} · ${modelLabel(model)} · ${effortLabel(effort)}`
  const options: Array<{
    value: string
    label: string
    description?: string
    type?: 'text' | 'input'
    onChange?: (value: string) => void
    placeholder?: string
    initialValue?: string
  }> = [
    { value: 'name', type: 'input', label: 'Name', description: 'Optional — a leaf gets a name like "leaf 3" if you skip this', placeholder: 'leaf name', onChange: setName },
    { value: 'mode', label: `Start: ${fresh ? 'New chat (empty context)' : `Fork ${sourceName}`}`, description: 'Enter toggles it' },
    { value: 'source', label: `Fork source: ${sourceName}`, description: 'Which conversation this leaf copies' },
    { value: 'model', label: `Model: ${modelLabel(model)}`, description: 'Which model the leaf runs' },
    { value: 'effort', label: `Effort: ${effortLabel(effort)}`, description: 'How hard the leaf thinks' },
    { value: 'worktree', type: 'input', label: 'Worktree', description: 'Optional path — give the leaf its own copy of the files', placeholder: 'leave empty to share your files', onChange: setWorktree },
    { value: 'goal', type: 'input', label: 'Goal', description: 'Optional task the leaf is meant to accomplish', placeholder: 'what this leaf is for', onChange: setGoal },
    { value: 'create', label: busy ? 'Creating…' : `Create leaf — ${summary}`, description: 'Starts the leaf and opens it now' },
    { value: 'cancel', label: 'Cancel', description: 'Back to the leaf menu' },
  ]
  return <Box flexDirection="column">
    <Text bold>Create a leaf</Text>
    <Text dimColor>Every leaf is a full interactive session. They share files unless you give one a worktree.</Text>
    <Text dimColor>Pick a row and press Enter. Name, worktree and goal are typed in place.</Text>
    <Select
      options={options}
      visibleOptionCount={9}
      layout="expanded"
      isDisabled={busy}
      onCancel={() => onCancel()}
      onChange={(value: string) => {
        if (busy) return
        if (value === 'cancel') { onCancel(); return }
        if (value === 'create') { void create(); return }
        if (value === 'mode') { setFresh(current => !current); return }
        if (value === 'source') { setSource(current => nextIn(sources.map(item => item.value), current)); return }
        if (value === 'model') { setModel(current => nextIn([MODEL_INHERIT, MODEL_DEFAULT], current)); return }
        if (value === 'effort') { setEffort(current => nextIn(EFFORT_CHOICES, current)); return }
      }} />
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
  // Only leaves that can still take the terminal are offered. A leaf whose
  // process has ended is not an entry point - entering one muted this session
  // and left a black screen - and it stays in the menu, where it can be
  // reopened, rather than in the bar, where a click is the only gesture.
  const items = [{ id: undefined, label: getLeafRootName(), state: '' }, ...views.filter(view => isLeafProcessAlive(view.process.getState())).map(view => ({ id: view.member.sessionId, label: `${view.member.number} ${view.member.name}`, state: view.process.getState() }))]
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
      <Text bold>All sessions - click to switch</Text>
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
