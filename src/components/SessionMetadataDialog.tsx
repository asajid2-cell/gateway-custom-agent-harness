import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { controlPersistGoal, getCurrentPersistRecord, subscribePersist } from '../skills/bundled/persist.js'
import { getSdkBetas, getSessionId, onSessionSwitch } from '../bootstrap/state.js'
import { useRegisterOverlay } from '../context/overlayContext.js'
import { useMainLoopModel } from '../hooks/useMainLoopModel.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { Box, Button, Text, useInput } from '../ink.js'
import {
  getConfiguredGatewayContextWindow,
  getContextWindowForModel,
  setConfiguredGatewayContextWindow,
} from '../utils/context.js'
import {
  isCanonicalGatewayModelId,
  normalizeGatewayModelId,
} from '../utils/model/gatewayModelIds.js'
import ScrollBox, { type ScrollBoxHandle } from '../ink/components/ScrollBox.js'
import { useAppStateStore } from '../state/AppState.js'
import { Dialog } from './design-system/Dialog.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'
import { Byline } from './design-system/Byline.js'
import TextInput from './TextInput.js'
import {
  getCurrentSessionTitle,
  getTranscriptPath,
  saveSessionName,
} from '../utils/sessionStorage.js'
import {
  getBridgeBaseUrlOverride,
  getBridgeTokenOverride,
} from '../bridge/bridgeConfig.js'
import {
  loadMuxSessionMetadata,
  muxMetadataUnavailableText,
  type MuxMetadataResult,
} from '../utils/muxSessionMetadata.js'
import { reportSessionRename } from '../utils/leafWorkspace.js'
import { isTeammate } from '../utils/teammate.js'

type Props = {
  readonly onDone: () => void
}

/**
 * Accepts `450000`, `450_000`, `450,000`, `450k`, `1.2m`. Returns null when
 * the text is not a usable token count, so the caller can show one message
 * instead of guessing at a typo.
 */
function parseTokenCount(raw: string): number | null {
  const cleaned = raw.replace(/[,_\s]/g, '')
  const match = /^(\d+(?:\.\d+)?)([km])?$/i.exec(cleaned)
  if (!match) return null
  const unit = match[2]?.toLowerCase()
  const scale = unit === 'm' ? 1_000_000 : unit === 'k' ? 1_000 : 1
  const tokens = Math.round(Number(match[1]) * scale)
  return Number.isFinite(tokens) && tokens > 0 ? tokens : null
}

export function SessionMetadataDialog({ onDone }: Props): React.ReactNode {
  useRegisterOverlay('session-metadata-dialog', true)

  const appStateStore = useAppStateStore()
  const goal = useSyncExternalStore(subscribePersist, getCurrentPersistRecord, getCurrentPersistRecord)
  const { columns: terminalColumns, rows: terminalRows } = useTerminalSize()
  const scrollRef = useRef<ScrollBoxHandle>(null)
  const detailHeight = goal ? Math.max(2, Math.min(10, Math.floor(terminalRows / 2) - 6)) : 2
  const [{ sessionId, fullPath }] = useState(() => ({
    sessionId: getSessionId(),
    fullPath: getTranscriptPath(),
  }))
  useEffect(() => onSessionSwitch(() => onDone()), [onDone])
  const teammate = isTeammate()
  // The context-window field edits the accounting window for the route this
  // session is on. It is keyed by the canonical Gateway id, so a route's
  // aliases share one number, and the effective value always comes from
  // getContextWindowForModel so the dialog shows what compaction actually uses.
  const mainLoopModel = useMainLoopModel()
  const canonicalModelId = normalizeGatewayModelId(mainLoopModel)
  const contextRouteEditable = isCanonicalGatewayModelId(canonicalModelId)
  const configuredContextWindow = getConfiguredGatewayContextWindow(mainLoopModel)
  const effectiveContextWindow = getContextWindowForModel(
    mainLoopModel,
    getSdkBetas(),
  )
  // Start empty and show the existing name as the placeholder. Pre-filling with
  // the cursor at the end meant typing appended to the old name ("My Session"
  // + "New Name" saved as "My SessionNew Name"), which reads as the rename not
  // taking effect. An empty field means what you type is what gets saved.
  const existingName = useState(() => getCurrentSessionTitle(sessionId))[0]
  const [name, setName] = useState('')
  const inputColumns = Math.max(1, terminalColumns - 10)
  const [cursorOffset, setCursorOffset] = useState(0)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | undefined>()
  const [muxResult, setMuxResult] = useState<MuxMetadataResult | undefined>()
  // Two fields share this dialog: the session name (the original one) and the
  // context window. Tab moves between them; Enter saves the field that has
  // focus. The context field starts empty for the same reason the name does:
  // empty means "leave it alone", and the placeholder shows the live value.
  const [field, setField] = useState<'name' | 'context'>('name')
  const [contextValue, setContextValue] = useState('')
  const [contextCursorOffset, setContextCursorOffset] = useState(0)
  const [contextError, setContextError] = useState<string | undefined>()
  const [contextNotice, setContextNotice] = useState<string | undefined>()

  useEffect(() => {
    let cancelled = false
    void loadMuxSessionMetadata(sessionId).then(result => {
      if (!cancelled) setMuxResult(result)
    })
    return () => {
      cancelled = true
    }
  }, [sessionId])

  // Applies the context field. Empty input is a no-op (the field starts empty,
  // so it must not mean "clear"); `0` clears an override back to the catalog
  // value. Returns false only when the text is unusable, so the caller can keep
  // the dialog open and let the person fix the typo.
  const applyContextWindow = useCallback((raw: string): boolean => {
    const trimmed = raw.trim()
    if (!trimmed) {
      setContextError(undefined)
      return true
    }
    if (!contextRouteEditable) {
      setContextError('Context overrides apply to Gateway routes only.')
      return false
    }
    if (/^(0|default|reset)$/i.test(trimmed)) {
      setConfiguredGatewayContextWindow(mainLoopModel, null)
      setContextValue('')
      setContextError(undefined)
      setContextNotice(
        `Cleared the override; this route is back to ${getContextWindowForModel(mainLoopModel, getSdkBetas()).toLocaleString()} tokens.`,
      )
      return true
    }
    const tokens = parseTokenCount(trimmed)
    if (tokens === null) {
      setContextError('Enter a token count like 450000, 450k, or 1.2m.')
      return false
    }
    setConfiguredGatewayContextWindow(mainLoopModel, tokens)
    setContextValue('')
    setContextError(undefined)
    setContextNotice(
      `Context window is now ${tokens.toLocaleString()} tokens for ${canonicalModelId}; auto-compaction follows.`,
    )
    return true
  }, [canonicalModelId, contextRouteEditable, mainLoopModel])

  const closing = useRef(false)
  const handleSubmit = useCallback(async (submittedName: string) => {
    const newName = submittedName.trim()
    if (saving || closing.current) return
    if (teammate) { onDone(); return }
    // A context number typed before switching to the name field must not be
    // silently dropped when Enter saves the name.
    if (contextValue.trim() && !applyContextWindow(contextValue)) return
    // Submitting an untouched (empty) field means "keep the current name" - the
    // field starts empty by design, so empty is the initial state, not an error.
    if (!newName) { closing.current = true; onDone(); return }
    if (newName.length > 200) {
      setSaveError('Name must contain 1–200 characters.')
      return
    }
    if (getSessionId() !== sessionId || getTranscriptPath() !== fullPath) {
      onDone()
      return
    }

    closing.current = true
    setSaving(true)
    setSaveError(undefined)
    try {
      saveSessionName(sessionId, newName, fullPath)
      // The name is on the transcript now; telling the leaf family is a report it
      // must not have to wait on. Awaiting it here held the dialog open on the
      // hosting session, and a report that failed reported a saved name as
      // unsaved.
      void reportSessionRename(newName)
      const bridgeSessionId = appStateStore.getState().replBridgeSessionId
      if (bridgeSessionId) {
        const tokenOverride = getBridgeTokenOverride()
        void import('../bridge/createSession.js').then(
          ({ updateBridgeSessionTitle }) =>
            updateBridgeSessionTitle(bridgeSessionId, newName, {
              baseUrl: getBridgeBaseUrlOverride(),
              getAccessToken: tokenOverride ? () => tokenOverride : undefined,
            }).catch(() => {}),
        ).catch(() => {})
      }
      appStateStore.setState(prev => ({
        ...prev,
        standaloneAgentContext: {
          ...prev.standaloneAgentContext,
          name: newName,
        },
      }))
      onDone()
    } catch {
      closing.current = false
      setSaveError('Unable to save session name; inspect storage permissions.')
      setSaving(false)
    }
  }, [appStateStore, applyContextWindow, contextValue, fullPath, name, onDone, saving, sessionId, teammate])

  const handleCancel = useCallback(() => { if (!saving && !closing.current) { closing.current = true; onDone() } }, [onDone, saving])
  useInput((_input, key) => {
    if (key.tab) {
      if (field === 'name') {
        setField('context')
      } else if (applyContextWindow(contextValue)) {
        setField('name')
      }
      return
    }
    if (key.escape) {
      // Escape inside the context field gives up that edit, not the dialog:
      // closing the whole dialog here would discard the name typed beside it.
      if (field === 'context') {
        setContextValue('')
        setContextError(undefined)
        setField('name')
        return
      }
      handleCancel()
    }
    if (key.pageDown) scrollRef.current?.scrollBy(detailHeight)
    if (key.pageUp) scrollRef.current?.scrollBy(-detailHeight)
  })

  const muxSummary = useMemo(() => {
    if (!muxResult) return <Text dimColor>Checking local mux metadata…</Text>
    if (!muxResult.available) {
      return <Text dimColor>{muxMetadataUnavailableText(muxResult.reason)}</Text>
    }
    const { metadata } = muxResult
    return <Box flexDirection="column" gap={0}>
      <Text>Local mux: <Text bold>{metadata.name}</Text> <Text dimColor>(read-only)</Text></Text>
      <Text>
        Mux tags:{' '}
        {metadata.tags && metadata.tags.length > 0
          ? metadata.tags.join(', ')
          : 'not exposed'}
      </Text>
      <Text dimColor>{metadata.mutation.reason}</Text>
    </Box>
  }, [muxResult])

  return (
    <Dialog
      title="Session metadata"
      subtitle="Edit the session name or this route's context window."
      color="permission"
      onCancel={handleCancel}
      isCancelActive={false}
      hideInputGuide
    >
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1}>
          <Text>Name:</Text>
          <TextInput
            value={name}
            placeholder={existingName || 'Unnamed session'}
            onChange={setName}
            onSubmit={value => void handleSubmit(value)}
            onExit={handleCancel}
            focus={field === 'name' && !saving && !teammate}
            showCursor={field === 'name' && !saving && !teammate}
            columns={inputColumns}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
            disableEscapeDoublePress
          />
        </Box>
        <Box flexDirection="row" gap={1}>
          <Text>Context window:</Text>
          <TextInput
            value={contextValue}
            placeholder={effectiveContextWindow.toLocaleString()}
            onChange={setContextValue}
            onSubmit={value => {
              if (applyContextWindow(value)) setField('name')
            }}
            onExit={handleCancel}
            focus={field === 'context' && !saving && !teammate}
            showCursor={field === 'context' && !saving && !teammate}
            columns={inputColumns}
            cursorOffset={contextCursorOffset}
            onChangeCursorOffset={setContextCursorOffset}
            disableEscapeDoublePress
          />
          <Text dimColor>tokens</Text>
        </Box>
        <Text dimColor>
          {contextRouteEditable
            ? `${canonicalModelId}${configuredContextWindow === null ? ' · catalog' : ' · override'} · used by auto-compaction · 0 clears`
            : 'Context overrides apply to Gateway routes only.'}
        </Text>
        {contextError && <Text color="error">{contextError}</Text>}
        {contextNotice && <Text dimColor>{contextNotice}</Text>}
        {teammate && (
          <Text dimColor>
            Teammate names are set by the team leader and cannot be edited here.
          </Text>
        )}
        {saveError && <Text color="error">{saveError}</Text>}
        <ScrollBox ref={scrollRef} height={detailHeight} flexDirection="column">
        {muxSummary}
        {goal && (
          <Box flexDirection="column">
            <Text bold>Persistent goal ({goal.status})</Text>
            <Text>{goal.task}</Text>
            <Text dimColor>{goal.keep ? 'Keep working' : `${goal.nudgesRemaining} nudges remaining`} · {goal.mode}</Text>
            <Box gap={1} flexWrap="wrap">
              {(['pause', 'resume', 'complete', 'clear'] as const).filter(action => {
                if (goal.status === 'cleared') return false
                if (action === 'clear') return true
                if (goal.status === 'completed') return false
                if (action === 'pause') return goal.status === 'active'
                // A stalled goal is retained with its heartbeat stopped, so
                // resume is the control that brings it back - the same as a
                // paused or blocked goal.
                if (action === 'resume') return goal.status === 'paused' || goal.status === 'blocked' || goal.status === 'stalled'
                return true
              }).map(action => (
                <Button key={action} tabIndex={-1} onAction={() => {
                  if (saving || getSessionId() !== sessionId) return
                  setSaving(true)
                  void controlPersistGoal(action, appStateStore.setState)
                    .catch(() => setSaveError('Unable to update goal; inspect storage permissions.'))
                    .finally(() => setSaving(false))
                }}>
                  {({ hovered }: { hovered: boolean }) => <Text underline={hovered}>{action}</Text>}
                </Button>
              ))}
            </Box>
          </Box>
        )}
        </ScrollBox>
        {/* Byline must sit inside a Text: as a bare child of a column Box each
            separator and hint becomes its own row, which spent the height this
            dialog needs and pushed the title off the top. */}
        <Text dimColor>
          <Byline>
            {!teammate && (
              <KeyboardShortcutHint shortcut="Enter" action={saving ? 'saving' : 'save'} />
            )}
            <KeyboardShortcutHint shortcut="Tab" action="switch field" />
            <Text dimColor>Esc cancel{goal ? ' · PgUp/PgDn details' : ''}</Text>
          </Byline>
        </Text>
      </Box>
    </Dialog>
  )
}
