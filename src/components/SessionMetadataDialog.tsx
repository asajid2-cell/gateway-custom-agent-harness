import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { controlPersistGoal, getCurrentPersistRecord, subscribePersist } from '../skills/bundled/persist.js'
import { getSessionId, onSessionSwitch } from '../bootstrap/state.js'
import { useRegisterOverlay } from '../context/overlayContext.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { Box, Button, Text, useInput } from '../ink.js'
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
import { isTeammate } from '../utils/teammate.js'

type Props = {
  readonly onDone: () => void
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
  const [name, setName] = useState(() => getCurrentSessionTitle(sessionId) ?? '')
  const inputColumns = Math.max(1, terminalColumns - 10)
  const [cursorOffset, setCursorOffset] = useState(name.length)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | undefined>()
  const [muxResult, setMuxResult] = useState<MuxMetadataResult | undefined>()

  useEffect(() => {
    let cancelled = false
    void loadMuxSessionMetadata(sessionId).then(result => {
      if (!cancelled) setMuxResult(result)
    })
    return () => {
      cancelled = true
    }
  }, [sessionId])

  const closing = useRef(false)
  const handleSubmit = useCallback(async () => {
    const newName = name.trim()
    if (saving || closing.current) return
    if (teammate || !newName) {
      onDone()
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
  }, [appStateStore, fullPath, name, onDone, saving, sessionId, teammate])

  const handleCancel = useCallback(() => { void handleSubmit() }, [handleSubmit])
  useInput((_input, key) => {
    if (key.escape) handleCancel()
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
      subtitle="Edit the native session name. Local mux metadata is informational only."
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
            placeholder="Unnamed session"
            onChange={setName}
            onSubmit={() => void handleSubmit()}
            onExit={handleCancel}
            focus={!saving && !teammate}
            showCursor={!saving && !teammate}
            columns={inputColumns}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
            disableEscapeDoublePress
          />
        </Box>
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
                if (action === 'resume') return goal.status === 'paused' || goal.status === 'blocked'
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
        <Byline>
          {!teammate && (
            <KeyboardShortcutHint shortcut="Enter" action={saving ? 'saving' : 'save'} />
          )}
          <Text dimColor>Esc save & close{goal ? ' · PgUp/PgDn details' : ''}</Text>
        </Byline>
      </Box>
    </Dialog>
  )
}
