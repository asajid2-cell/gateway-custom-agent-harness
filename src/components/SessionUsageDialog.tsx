import React, { useSyncExternalStore } from 'react'
import {
  getSessionTokenTotals,
  subscribeSessionTokenTotals,
} from '../bootstrap/state.js'
import { useRegisterOverlay } from '../context/overlayContext.js'
import { Box, Text, useInput } from '../ink.js'
import { getSessionChargedTokens } from '../utils/bottomBarUsage.js'
import { formatTokens } from '../utils/format.js'
import { Dialog } from './design-system/Dialog.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'
import { Byline } from './design-system/Byline.js'

type Props = {
  readonly onDone: () => void
}

/**
 * The detail behind the bottom bar's total: what the session has been charged,
 * split the way the bill splits it - input, output, and the two cache figures -
 * plus the same split per model. Read live from the run-scoped accumulator, so
 * a response that lands while the dialog is open moves the numbers.
 */
export function SessionUsageDialog({ onDone }: Props): React.ReactNode {
  useRegisterOverlay('session-usage-dialog', true)

  const totals = useSyncExternalStore(
    subscribeSessionTokenTotals,
    getSessionTokenTotals,
    getSessionTokenTotals,
  )
  const charged = getSessionChargedTokens(totals)

  const input = Object.values(totals).reduce((n, u) => n + u.inputTokens, 0)
  const output = Object.values(totals).reduce((n, u) => n + u.outputTokens, 0)
  const cacheRead = Object.values(totals).reduce((n, u) => n + u.cacheReadInputTokens, 0)
  const cacheWrite = Object.values(totals).reduce((n, u) => n + u.cacheCreationInputTokens, 0)

  const models = Object.entries(totals)
    .map(([model, usage]) => ({
      model,
      usage,
      charged: getSessionChargedTokens({ [model]: usage }),
    }))
    .sort((a, b) => b.charged - a.charged)

  useInput((_input, key) => {
    if (key.escape) onDone()
  })

  const row = (label: string, value: number) => (
    <Box flexDirection="row" gap={1}>
      <Box width={12} flexShrink={0}>
        <Text dimColor>{label}</Text>
      </Box>
      <Text>{formatTokens(value)}</Text>
    </Box>
  )

  return (
    <Dialog
      title="Session usage"
      subtitle="Charged tokens for this session. The count starts at zero when the session restarts."
      color="permission"
      onCancel={onDone}
      isCancelActive={false}
      hideInputGuide
    >
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text>
            <Text bold>{formatTokens(charged)}</Text> total
          </Text>
        </Box>
        <Box flexDirection="column">
          {row('Input', input)}
          {row('Output', output)}
          {row('Cache read', cacheRead)}
          {row('Cache write', cacheWrite)}
        </Box>
        {models.length > 0 && (
          <Box flexDirection="column">
            <Text bold>Per model</Text>
            {models.map(({ model, usage }) => (
              <Box key={model} flexDirection="column">
                <Text>{model}</Text>
                <Text dimColor>
                  {formatTokens(usage.inputTokens)} in · {formatTokens(usage.outputTokens)} out ·{' '}
                  {formatTokens(usage.cacheReadInputTokens)} cache read ·{' '}
                  {formatTokens(usage.cacheCreationInputTokens)} cache write
                </Text>
              </Box>
            ))}
          </Box>
        )}
        <Byline>
          <KeyboardShortcutHint shortcut="Esc" action="close" />
        </Byline>
      </Box>
    </Dialog>
  )
}
