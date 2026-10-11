import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Box, Text, useInput } from '../ink.js'
import { Select } from './CustomSelect/select.js'
import { SessionPreview } from './SessionPreview.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { useRegisterOverlay } from '../context/overlayContext.js'
import { LEAF_EFFORT_LEVELS, externallyHeldLeafIds, getLeafCarouselViews, getLeafHeirSessionId, getLeafMatriarchName, getLeafMatriarchSessionId, getLeafPatriarchName, getLeafPatriarchSessionId, getLeafSelfName, getLeafViews, getTandemViews, isFamilyMatriarch, listLeafMenuMembers, refreshLeafMatriarch, requestLeafMenu, selectedLeafId, selectLeaf, subscribeLeafWorkspace, leafWorkspaceRevision, type LeafView, type TandemView } from '../utils/leafWorkspace.js'
import type { LeafMember } from '../utils/leafFamily.js'
import type { LogOption } from '../types/logs.js'
import { isLeafProcessAlive } from '../utils/leafProcess.js'
import { isInteractiveLeaf } from '../utils/leafTerminal.js'
import { isGatewayMode } from '../utils/model/providers.js'
import { getSessionId } from '../bootstrap/state.js'

export function LeafSessionBar(): React.ReactNode {
  useSyncExternalStore(subscribeLeafWorkspace, leafWorkspaceRevision, leafWorkspaceRevision)
  if (!isGatewayMode()) return null
  // A row of the footer section, not a band of its own. The dim rule that used
  // to sit above the labels cost a row and made them read as a separate block;
  // inside the footer they line up with the rows above them instead.
  return <Box paddingX={2} flexShrink={0} width="100%">
    <LeafCarousel views={getLeafCarouselViews()} activeId={selectedLeafId()} onSelect={selectLeaf} />
  </Box>
}

/** Effort choices offered by the wizard; `inherit` keeps the source's effort. */
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

/**
 * How a session is named in a result. Every member is a leaf, the creator
 * included, so one form names them all.
 */
function describeSession(member?: { number: number; name: string }): string {
  if (!member) return 'That session'
  return `Leaf #${member.number} ${member.name}`
}

/**
 * How the archive entry reads, so both menus that offer it say the same thing.
 * The count is the point of the row: archiving hides leaves from the ordinary
 * list, and this is the only place that says how many went.
 */
function describeArchives(members: LeafMember[] | undefined, hint: string): string {
  const count = (members ?? []).filter(member => member.status === 'archived').length
  return count ? `${count} filed away · ${hint}` : 'Nothing is archived yet'
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
  const [screen, setScreen] = useState<'home' | 'list' | 'create' | 'archives' | 'view' | 'tandems' | 'tandem-create'>('home')
  const [members, setMembers] = useState<LeafMember[] | undefined>(undefined)
  // Tandems are this session's own, so there is nothing to load from disk: the
  // rows are read straight from the workspace whenever the roster refreshes.
  const [tandems, setTandems] = useState<TandemView[]>(() => getTandemViews())
  // The transcript an archive row asked to read, with the member it belongs to:
  // the viewer is read-only, and Enter in it resumes that member once.
  const [viewing, setViewing] = useState<{ member: LeafMember; log: LogOption } | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  // Refresh the family roster whenever the workspace publishes a change.
  useSyncExternalStore(subscribeLeafWorkspace, leafWorkspaceRevision, leafWorkspaceRevision)
  // The roster the rows are built from carries the session on screen as well:
  // the rows drop it themselves, and the wizard needs it - the sessions a leaf
  // can be forked from include the one the window is showing.
  const reload = () => {
    void listLeafMenuMembers().then(setMembers).catch(() => setMembers([]))
    setTandems(getTandemViews())
  }
  useEffect(() => { reload() }, [screen])
  // One window manages a family at a time and another window may have opened it
  // since this one last looked. Read the lease on open so the rows are the ones
  // that will actually work, rather than refusing after the fact; the publish
  // this triggers re-renders the menu with the answer.
  useEffect(() => { void refreshLeafMatriarch() }, [])

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

  // Reading a filed-away leaf starts nothing: its transcript is a file on disk,
  // so this works the same whether or not anything is running.
  const viewTranscript = async (member: LeafMember) => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const { loadTranscriptFromFile } = await import('../utils/sessionStorage.js')
      setViewing({ member, log: await loadTranscriptFromFile(member.transcriptPath) })
      setScreen('view')
    } catch (failure) {
      const reason = failure instanceof Error ? failure.message.replace(/\s+/g, ' ').trim() : ''
      setError(reason || 'That leaf transcript could not be read.')
    } finally {
      setBusy(false)
    }
  }

  if (screen === 'create') {
    return <LeafCreateWizard
      members={members}
      selectedId={selectedLeafId()}
      patriarchName={getLeafPatriarchName()}
      defaultModel={model}
      defaultEffort={effort}
      onDone={result => { if (result) void run(result, async () => result); setScreen('home') }}
      onCancel={() => setScreen('home')}
    />
  }

  if (screen === 'tandem-create') {
    return <TandemCreateWizard
      defaultModel={model}
      defaultEffort={effort}
      onDone={result => { if (result) void run(result, async () => result); setScreen('tandems') }}
      onCancel={() => setScreen('tandems')}
    />
  }

  if (screen === 'list') {
    // The session asking is a member like any other - inside a leaf the roster
    // is the family file, and a window opened on a member's own address is in
    // it too - so its row is named rather than dropped, which is also how a leaf
    // finds itself. It is offered the one verb that means anything for it:
    // closing it, which moves the family rather than stopping a process.
    const self = selectedLeafId() ?? getSessionId()
    const mine = members?.find(member => member.sessionId === self)
    const open = members?.filter(member => member.status !== 'archived' && member.sessionId !== self) ?? []
    const patriarchId = getLeafPatriarchSessionId()
    const heirId = getLeafHeirSessionId()
    const canCloseSelf = isFamilyMatriarch() || isInteractiveLeaf()
    // Displaced, this is a roster and nothing else: the rows that manage leaves
    // belong to the window holding the lease, and offering them here only
    // produced a refusal after the fact.
    const options = [
      ...(mine && canCloseSelf ? [{
        value: `close-self:${self}`,
        label: `Close this session — ${describeSession(mine)}`,
        description: isFamilyMatriarch()
          ? 'Hand the family to the next leaf and leave; with no leaf left it just leaves'
          : 'Leave this leaf; its transcript and its place in the family are kept',
      }] : []),
      ...(!isFamilyMatriarch() ? open.map(member => ({
        value: `member:${member.sessionId}`,
        label: `#${member.number} ${member.name}`,
        description: `${member.status}${externallyHeldLeafIds().includes(member.sessionId) ? ' · open in the window that manages it' : ''}`,
      })) : [
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
        ...open.filter(member => member.sessionId !== patriarchId).map(member => ({
          value: `head:${member.sessionId}`,
          label: `Make head #${member.number} ${member.name}`,
          description: 'The family takes this member’s name; the member that is the head now becomes an ordinary leaf',
        })),
        ...open.filter(member => member.sessionId !== patriarchId && member.sessionId !== heirId).map(member => ({
          value: `heir:${member.sessionId}`,
          label: `Raise heir #${member.number} ${member.name}`,
          description: 'Name the member being trained to succeed the head; it stays an ordinary leaf',
        })),
      ]),
      // Every member is an entry point, so every member gets the command that
      // opens it from anywhere. It is a read, not management: a window that was
      // displaced still hands out the address of the family it no longer runs.
      ...open.map(member => ({
        value: `resume:${member.sessionId}`,
        label: `Enter #${member.number} ${member.name} from a terminal`,
        description: `cc --resume ${member.sessionId}`,
      })),
      ...(open.length === 0 ? [{ value: 'empty', label: 'No saved leaves yet', description: 'Go back and create one' }] : []),
      { value: 'archives', label: 'Archived leaves', description: describeArchives(members, 'revive, view or open one') },
      { value: 'back', label: 'Back', description: 'Return to the leaf menu' },
    ]
    return <Box flexDirection="column">
      <Text bold>Leaves in this family</Text>
      <Text dimColor>Opening a leaf is the only thing that starts its process. Closed leaves stay closed until you open them again.</Text>
      {mine && <Text dimColor>{describeSession(mine)} is the session you are in; the rows below act on the rest of the family.</Text>}
      <Select options={options} visibleOptionCount={12} onCancel={() => setScreen('home')} onChange={(value: string) => {
        if (value === 'back' || value === 'empty') { setScreen('home'); return }
        if (value === 'archives') { setScreen('archives'); return }
        const id = value.slice(value.indexOf(':') + 1)
        const member = members?.find(item => item.sessionId === id)
        const action = value.slice(0, value.indexOf(':'))
        // A roster row in a window that was displaced is a label, not a verb.
        if (action === 'member') { setNotice(`${describeSession(member)} is managed in the window the family moved to.`); return }
        // Nothing is started here: the command is the answer, and running it in
        // another terminal is the person's to do.
        if (action === 'resume') { setNotice(`To enter ${describeSession(member)} from another terminal, run: cc --resume ${id}`); return }
        void run('', async () => {
          const workspace = await import('../utils/leafWorkspace.js')
          if (action === 'open') return workspace.openLeaf(id)
          if (action === 'head') return workspace.conferPatriarch(id)
          if (action === 'heir') return workspace.conferHeir(id)
          // Closing the session you are in is the same call as closing any other
          // member; what it does is decided by which session is asking, not by
          // the row. It hands the family on when it can and leaves when it
          // cannot, and the workspace says which happened.
          if (action === 'close-self') return workspace.changeLeaf(id, { status: 'closed' })
          // The pane is left where it is. A member leaving is not the window
          // changing what it shows, and the workspace drops the selection itself
          // when the member that goes is the one on screen - doing it here as
          // well cleared the pane for every close, and inside a leaf that
          // tears down the very terminal this dialog is drawn in, so the
          // confirmation of what happened went with it.
          const promoted = await workspace.changeLeaf(id, { status: action === 'archive' ? 'archived' : 'closed' })
          const filed = action === 'archive'
            ? `${describeSession(member)} archived. It is detached from this family and no longer appears here; its transcript and session are untouched.`
            : `${describeSession(member)} closed. Its transcript is retained; open it again any time.`
          return promoted ? `${filed} ${promoted}` : filed
        })
      }} />
      {busy && <Text dimColor>Working…</Text>}
      {notice && <Text>{notice}</Text>}
      {error && <Text color="error">{error}</Text>}
    </Box>
  }

  // Archived leaves are out of the ordinary list, which is what archiving
  // means, so they need a screen of their own to come back from. Nothing here
  // deletes anything: the three verbs are file, read and run-if-you-must.
  if (screen === 'archives') {
    const archived = members?.filter(member => member.status === 'archived') ?? []
    const running = new Set(getLeafViews().map(view => view.member.sessionId))
    // Reading an archived conversation is not managing the family, so it stays
    // available to a displaced window; reviving and running one do not.
    const options = [
      ...(isFamilyMatriarch() ? archived.map(member => ({
        value: `revive:${member.sessionId}`,
        label: `Revive #${member.number} ${member.name}`,
        description: 'Put it back in the leaf list; it stays closed until you open it',
      })) : []),
      ...(isFamilyMatriarch() ? archived.map(member => ({
        value: `open-once:${member.sessionId}`,
        label: `Open once #${member.number} ${member.name}`,
        description: 'Run it now, then file it away again when you close it',
      })) : []),
      ...archived.map(member => ({
        value: `view:${member.sessionId}`,
        label: `View #${member.number} ${member.name}`,
        description: 'Read the saved conversation; nothing is started',
      })),
      ...(isFamilyMatriarch() ? archived.filter(member => running.has(member.sessionId)).map(member => ({
        value: `close:${member.sessionId}`,
        label: `Close #${member.number} ${member.name}`,
        description: 'Stop the process it is running now; it stays archived',
      })) : []),
      ...(archived.length === 0 ? [{ value: 'empty', label: 'Nothing is archived', description: 'Leaves you archive are filed here' }] : []),
      { value: 'back', label: 'Back', description: 'Return to the leaf menu' },
    ]
    return <Box flexDirection="column">
      <Text bold>Archived leaves</Text>
      <Text dimColor>Archiving files a leaf away without deleting anything: its transcript, its session and its place in this family are kept.</Text>
      <Text dimColor>Opening one from here runs it as it is and leaves it archived; reviving moves it back to the leaf list.</Text>
      <Select options={options} visibleOptionCount={12} onCancel={() => setScreen('home')} onChange={(value: string) => {
        if (value === 'back' || value === 'empty') { setScreen('home'); return }
        const id = value.slice(value.indexOf(':') + 1)
        const action = value.slice(0, value.indexOf(':'))
        const member = archived.find(item => item.sessionId === id)
        if (action === 'view' && member) { void viewTranscript(member); return }
        void run('', async () => {
          const workspace = await import('../utils/leafWorkspace.js')
          if (action === 'revive') return workspace.reviveLeaf(id)
          if (action === 'open-once') return workspace.openLeafOnce(id)
          const promoted = await workspace.changeLeaf(id, { status: 'archived' })
          const filed = `${describeSession(member)} closed. It stays archived.`
          return promoted ? `${filed} ${promoted}` : filed
        })
      }} />
      {busy && <Text dimColor>Working…</Text>}
      {notice && <Text>{notice}</Text>}
      {error && <Text color="error">{error}</Text>}
    </Box>
  }

  // Tandems are this session's own throwaway partners, so nothing here can
  // displace a window or touch the durable family: the rows are per-tandem verbs
  // plus the one that starts a fresh one. A tandem is never a family member and
  // is deliberately kept out of the leaf list, the roster and the session bar.
  if (screen === 'tandems') {
    const options = [
      ...tandems.flatMap(tandem => [
        {
          value: `watch:${tandem.sessionId}`,
          label: `Watch ${tandem.label}`,
          description: tandem.watched
            ? 'Already open in a terminal'
            : 'Stop the headless tandem and open its session in a new terminal',
        },
        {
          value: `close:${tandem.sessionId}`,
          label: `Close ${tandem.label}`,
          description: 'End it for good; a tandem is throwaway and is not kept',
        },
      ]),
      ...(tandems.length === 0 ? [{ value: 'empty', label: 'No tandems right now', description: 'Start one below' }] : []),
      { value: 'create', label: 'Start a fresh tandem', description: 'A throwaway session to review or check something with' },
      { value: 'back', label: 'Back', description: 'Return to the leaf menu' },
    ]
    return <Box flexDirection="column">
      <Text bold>Tandem leaves</Text>
      <Text dimColor>A tandem is a throwaway session this one owns: an independent model working the same problem, whose disagreement is the signal. It is not a family member, so it never appears in the leaf list, the roster or the session bar.</Text>
      <Text dimColor>It ends when this session ends, or when you close it here. Watching it stops the headless tandem and opens its session in a new terminal so you can see and type into it.</Text>
      <Select options={options} visibleOptionCount={12} onCancel={() => setScreen('home')} onChange={(value: string) => {
        if (value === 'back' || value === 'empty') { setScreen('home'); return }
        if (value === 'create') { setScreen('tandem-create'); return }
        const id = value.slice(value.indexOf(':') + 1)
        const action = value.slice(0, value.indexOf(':'))
        void run('', async () => {
          const workspace = await import('../utils/leafWorkspace.js')
          if (action === 'watch') return workspace.watchTandem(id)
          return workspace.closeTandem(id)
        })
      }} />
      {busy && <Text dimColor>Working…</Text>}
      {notice && <Text>{notice}</Text>}
      {error && <Text color="error">{error}</Text>}
    </Box>
  }

  // The read-only viewer. Enter is the one gesture it inherits from resume, so
  // Enter means the same thing here as it does there: run it once, archived.
  if (screen === 'view' && viewing) {
    const member = viewing.member
    return <SessionPreview
      log={viewing.log}
      onExit={() => { setViewing(undefined); setScreen('archives') }}
      onSelect={() => {
        setViewing(undefined)
        setScreen('archives')
        void run('', async () => {
          const workspace = await import('../utils/leafWorkspace.js')
          return workspace.openLeafOnce(member.sessionId)
        })
      }}
    />
  }

  const selected = selectedLeafId()
  // With nothing selected the source is the session asking, which is not always
  // the patriarch - a member hosting the family forks itself.
  const sourceName = selected ? (members?.find(member => member.sessionId === selected)?.name ?? selected) : getLeafSelfName()
  // One window manages a family at a time. This one is a window onto it: it can
  // still use the terminals it has attached, but starting or changing leaves
  // belongs to the session that took the lease.
  const displaced = !isFamilyMatriarch()
  const options: Array<{ value: string; label: string; description?: string; type?: 'text' }> = [
    ...(displaced ? [] : [{ value: 'create', label: 'Create a leaf', description: 'Name it, choose its model and effort, then create it' }]),
    { value: 'list', label: 'Leaves in this family', description: displaced ? 'Read-only: another window manages them now' : members ? `${members.length} saved — open, close, or reopen one` : 'Loading…' },
    { value: 'tandems', label: 'Tandem leaves', description: tandems.length ? `${tandems.length} held — throwaway partners this session owns` : 'Throwaway partners this session owns; kept out of the family' },
    { value: 'archives', label: 'Archived leaves', description: describeArchives(members, displaced ? 'filed away' : 'leaves you archive are filed here') },
    { value: 'exit', label: 'Cancel', description: 'Leave the leaf workspace' },
  ]
  return <Box flexDirection="column">
    <Text bold>Leaves</Text>
    <Text dimColor>Each leaf is a full independent session. They share your files unless you point one at a separate worktree.</Text>
    {displaced
      ? <Text dimColor>The family moved to the window opened most recently ({getLeafMatriarchSessionId()}), which manages its leaves now. The terminals you already have stay yours to use.</Text>
      : <Text dimColor>Nothing starts until you open it. Creating a leaf forks the session you are looking at: {sourceName}.</Text>}
    <Select options={options} visibleOptionCount={6} onCancel={() => onDone()} onChange={(value: string) => {
      if (value === 'exit') { onDone(); return }
      if (value === 'list') { setScreen('list'); return }
      if (value === 'tandems') { setScreen('tandems'); return }
      if (value === 'archives') { setScreen('archives'); return }
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
export function LeafCreateWizard({ members, selectedId, patriarchName, defaultModel, defaultEffort, onDone, onCancel }: {
  members?: LeafMember[]
  selectedId?: string
  patriarchName: string
  defaultModel?: string
  defaultEffort?: string
  onDone: (result?: string) => void
  onCancel: () => void
}): React.ReactNode {
  useRegisterOverlay('leaf-create', true)
  const [name, setName] = useState('')
  const [fresh, setFresh] = useState(false)
  const [source, setSource] = useState(selectedId ?? getSessionId())
  const [model, setModel] = useState(defaultModel || MODEL_DEFAULT)
  const [effort, setEffort] = useState(defaultEffort || 'inherit')
  const [worktree, setWorktree] = useState('')
  const [goal, setGoal] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const creating = useRef(false)

  // The designated patriarch gets the first row, so it is not listed twice: it
  // is a member now, and its own row would otherwise sit beside this one.
  const patriarchId = getLeafPatriarchSessionId()
  const sources = [
    { value: 'root', label: patriarchName, description: 'The member designated as this family’s head' },
    ...(members ?? []).filter(member => member.status !== 'archived' && member.sessionId !== patriarchId).map(member => ({
      value: member.sessionId,
      label: `#${member.number} ${member.name}`,
      description: member.status,
    })),
  ]
  const sourceName = sources.find(item => item.value === source)?.label
    ?? (source === patriarchId ? patriarchName : source === getSessionId() ? getLeafSelfName() : source)

  const create = async () => {
    if (creating.current) return
    creating.current = true
    setBusy(true)
    setError('')
    try {
      const { createLeaf, setLeafGoal } = await import('../utils/leafWorkspace.js')
      // "Root" is named rather than left empty: an empty source means "the
      // session on screen", which is not the same conversation once a leaf is
      // selected - the row said root and forked the leaf.
      const forkSource = source
      const view = await createLeaf(
        name.trim() || undefined,
        forkSource,
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

/**
 * Create-tandem wizard. A tandem is always fresh - there is no source to choose
 * - so the fields are what it is for, its model and its effort. It goes through
 * the same `createPartner` path the `partner` tool action uses, so the menu and
 * the assistant cannot drift apart.
 */
export function TandemCreateWizard({ defaultModel, defaultEffort, onDone, onCancel }: {
  defaultModel?: string
  defaultEffort?: string
  onDone: (result?: string) => void
  onCancel: () => void
}): React.ReactNode {
  useRegisterOverlay('tandem-create', true)
  const [purpose, setPurpose] = useState('')
  const [model, setModel] = useState(defaultModel ? MODEL_INHERIT : MODEL_DEFAULT)
  const [effort, setEffort] = useState(defaultEffort || 'inherit')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const creating = useRef(false)

  const create = async () => {
    if (creating.current) return
    creating.current = true
    setBusy(true)
    setError('')
    try {
      const { createPartner } = await import('../utils/leafWorkspace.js')
      const result = await createPartner({
        ...(purpose.trim() ? { purpose: purpose.trim() } : {}),
        ...(model === MODEL_DEFAULT ? {} : model === MODEL_INHERIT ? (defaultModel ? { model: defaultModel } : {}) : { model }),
        ...(effort === 'inherit' ? {} : { effort }),
      })
      onDone(result)
    } catch (failure) {
      const reason = failure instanceof Error ? failure.message.replace(/\s+/g, ' ').trim() : ''
      setError(reason || 'Could not start a tandem. Nothing was changed.')
      creating.current = false
      setBusy(false)
    }
  }

  useInput((_input, key) => { if (key.escape && !busy) onCancel() })

  const summary = `${modelLabel(model)} · ${effortLabel(effort)}`
  const options: Array<{
    value: string
    label: string
    description?: string
    type?: 'text' | 'input'
    onChange?: (value: string) => void
    placeholder?: string
  }> = [
    { value: 'purpose', type: 'input', label: 'Purpose', description: 'What it is for — e.g. "review the diff"', placeholder: 'review X', onChange: setPurpose },
    { value: 'model', label: `Model: ${modelLabel(model)}`, description: 'Which model the tandem runs' },
    { value: 'effort', label: `Effort: ${effortLabel(effort)}`, description: 'How hard the tandem thinks' },
    { value: 'create', label: busy ? 'Starting…' : `Start tandem — ${summary}`, description: 'Convenes a headless session this one owns' },
    { value: 'cancel', label: 'Cancel', description: 'Back to the tandem leaves' },
  ]
  return <Box flexDirection="column">
    <Text bold>Start a tandem</Text>
    <Text dimColor>A tandem is a throwaway headless session this one owns. It is not a family member and never joins the leaf list.</Text>
    <Text dimColor>Pick a row and press Enter. The purpose is typed in place.</Text>
    <Select
      options={options}
      visibleOptionCount={5}
      layout="expanded"
      isDisabled={busy}
      onCancel={() => onCancel()}
      onChange={(value: string) => {
        if (busy) return
        if (value === 'cancel') { onCancel(); return }
        if (value === 'create') { void create(); return }
        if (value === 'model') { setModel(current => nextIn([MODEL_INHERIT, MODEL_DEFAULT], current)); return }
        if (value === 'effort') { setEffort(current => nextIn(EFFORT_CHOICES, current)); return }
      }} />
    {error && <Text color="error">{error}</Text>}
  </Box>
}

export function LeafCarousel({ views, activeId, onSelect, onExpand, onManage }: {
  views: LeafView[]; activeId?: string; onSelect: (id?: string) => void; onExpand?: (expanded: boolean) => void
  /** Opens the leaf menu. Defaults to asking the prompt overlay for it, since
   *  the carousel sits in the layout rather than inside the prompt. */
  onManage?: () => void
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
  const items = [{ id: undefined, label: getLeafMatriarchName(), state: '' }, ...views.filter(view => isLeafProcessAlive(view.process.getState())).map(view => ({ id: view.member.sessionId, label: `${view.member.number} ${view.member.name}`, state: view.process.getState() }))]
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
        {/* Creating, opening, closing and archiving all live in the leaf menu;
            this is the one gesture that reaches it without typing /leaf. */}
        <Box onClick={() => { collapse(); (onManage ?? requestLeafMenu)() }}><Text>Manage leaves</Text></Box>
        <Box onClick={collapse}><Text>Close list</Text></Box>
      </Box>
    </Box>}
    <Box gap={1} height={1} onWheel={event => { event.stopImmediatePropagation(); cycle(event.deltaY) }}
      onMouseDown={() => { stopHold(); held.current = false; hold.current = setTimeout(() => { held.current = true; expand() }, 450) }}
      onMouseUp={stopHold} onMouseLeave={stopHold}>
      <Box flexShrink={0} onClick={() => { if (!held.current) cycle(-1) }}><Text dimColor>‹</Text></Box>
      {items.slice(first, first + capacity).map(item => <Box key={item.id ?? 'original'} width={Math.min(20, Math.max(8, columns - 14))} flexShrink={0} onClick={() => { if (!held.current) choose(item.id) }}>
        <Text inverse={item.id === activeId} wrap="truncate">{item.label}{item.state === 'running' ? ' · working' : item.state === 'awaiting-approval' ? ' · approval' : item.state === 'failed' ? ' · failed' : ''}</Text>
      </Box>)}
      <Box flexShrink={0} onClick={() => { if (!held.current) cycle(1) }}><Text dimColor>›</Text></Box>
      <Box flexShrink={0} onClick={() => { if (!held.current) { if (expanded) collapse(); else expand() } }}><Text dimColor>All {items.length}</Text></Box>
    </Box>
  </Box>
}
