import React, { useState } from 'react'
import { Box, Text } from '../ink.js'
import { Select } from './CustomSelect/select.js'
import { useRegisterOverlay } from '../context/overlayContext.js'
import { getSessionId } from '../bootstrap/state.js'
import { useLedAssignments } from '../hooks/useLedTitle.js'
import { LED_COLORS, LED_NONE_GLYPH, LED_SOUNDS, ledSound } from '../utils/ledPalette.js'
import { clearLedAssignment, ledColorOwner, setLedAssignment } from '../utils/ledStore.js'
import { familyRootSync, getLeafViews } from '../utils/leafWorkspace.js'

/**
 * The LED picker.
 *
 * A colour is a claim on a pool the whole family shares, so this both offers and
 * accounts for it: a colour another session wears is shown, worn, with the name
 * of the session wearing it, and cannot be chosen. The store refuses a race
 * anyway, but a row that explains itself beats a refusal after the fact.
 *
 * The colour and the two opt-ins are one session's, and all three live here
 * rather than in three places: what the LED is for - telling you which of the
 * things you left running wants you - only works if the tab, the toast and the
 * tone are the same colour.
 */
export function LedMenu({ onDone }: { onDone: () => void }): React.ReactNode {
  useRegisterOverlay('led-menu', true)
  const [screen, setScreen] = useState<'home' | 'sound'>('home')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const assignments = useLedAssignments()
  const self = getSessionId()
  const family = familyRootSync()
  const mine = assignments[self]
  const members = getLeafViews()

  // The owner's name if this window can see them, the id if it cannot: a
  // displaced window knows fewer sessions than the store does, and a bare id is
  // still an answer to "whose is this?".
  const ownerLabel = (sessionId: string): string => {
    const view = members.find(entry => entry.member.sessionId === sessionId)
    return view ? `#${view.member.number} ${view.member.name}` : sessionId.slice(0, 8)
  }

  const apply = (label: string, action: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    setNotice('')
    action()
      .then(() => setNotice(label))
      .catch((failure: unknown) => {
        const reason = failure instanceof Error ? failure.message.replace(/\s+/g, ' ').trim() : ''
        setError(reason || 'That LED change failed.')
      })
      .finally(() => setBusy(false))
  }

  if (screen === 'sound') {
    const options = [
      { value: 'silent', label: 'Silent', description: 'No tone' },
      ...LED_SOUNDS.map(sound => ({ value: sound.id, label: sound.name, description: `Windows system sound · ${sound.id}` })),
      { value: 'back', label: 'Back', description: 'Return to the LED menu' },
    ]
    return <Box flexDirection="column">
      <Text bold>Tone</Text>
      <Text dimColor>Windows plays these itself; nothing is bundled and nothing is downloaded.</Text>
      <Select options={options} visibleOptionCount={8} onCancel={() => setScreen('home')} onChange={(value: string) => {
        if (value === 'back') { setScreen('home'); return }
        if (!mine) { setScreen('home'); return }
        apply(`Tone ${value === 'silent' ? 'off' : ledSound(value)?.name ?? value}`, () =>
          setLedAssignment(family, self, mine.color, { sound: value === 'silent' ? null : value }),
        )
      }} />
      {busy && <Text dimColor>Working…</Text>}
      {notice && <Text>{notice}</Text>}
      {error && <Text color="error">{error}</Text>}
    </Box>
  }

  const current = mine
    ? `${LED_COLORS.find(color => color.id === mine.color)?.glyph ?? ''} ${LED_COLORS.find(color => color.id === mine.color)?.name ?? mine.color}${mine.notify ? ' · notification on' : ''}${mine.sound ? ` · ${ledSound(mine.sound)?.name ?? mine.sound}` : ''}`
    : 'no LED'
  const options: Array<{ value: string; label: string; description?: string; disabled?: boolean }> = [
    ...LED_COLORS.map(color => {
      const owner = ledColorOwner(assignments, color.id, self)
      return {
        value: `colour:${color.id}`,
        label: `${color.glyph} ${color.name}${mine?.color === color.id ? '  ✓' : ''}`,
        description: owner ? `worn by ${ownerLabel(owner)}` : 'not worn in this family',
        disabled: owner !== undefined,
      }
    }),
    {
      value: 'off',
      label: `${LED_NONE_GLYPH} No LED`,
      description: mine ? 'Give the colour up: this session stops being tracked' : 'This session has no LED',
    },
    {
      value: 'notify',
      label: `Notification: ${mine?.notify ? 'on' : 'off'}`,
      description: mine
        ? mine.notify ? 'Turn the desktop toast off' : 'Send a Windows toast carrying this colour when the session parks'
        : 'Choose a colour first',
      disabled: mine === undefined,
    },
    {
      value: 'sound',
      label: `Tone: ${mine?.sound ? ledSound(mine.sound)?.name ?? mine.sound : 'silent'}`,
      description: mine ? 'Choose a short tone, or silence' : 'Choose a colour first',
      disabled: mine === undefined,
    },
    { value: 'exit', label: 'Done', description: 'Close the LED menu' },
  ]

  return <Box flexDirection="column">
    <Text bold>LED</Text>
    <Text dimColor>
      This session's LED is an emoji in its terminal tab, right of the name. It shows while the session is parked and
      holds steady until you come back. One colour belongs to one session.
    </Text>
    <Text dimColor>This session: {current}</Text>
    <Select options={options} visibleOptionCount={14} onCancel={() => onDone()} onChange={(value: string) => {
      if (value === 'exit') { onDone(); return }
      if (value === 'sound') { setScreen('sound'); return }
      if (value === 'off') {
        apply('LED off', () => clearLedAssignment(family, self))
        return
      }
      if (value === 'notify') {
        if (!mine) return
        apply(mine.notify ? 'Notification off' : 'Notification on', () =>
          setLedAssignment(family, self, mine.color, { notify: !mine.notify }),
        )
        return
      }
      const color = value.slice(value.indexOf(':') + 1)
      apply(`LED ${color}`, () => setLedAssignment(family, self, color))
    }} />
    {busy && <Text dimColor>Working…</Text>}
    {notice && <Text>{notice}</Text>}
    {error && <Text color="error">{error}</Text>}
  </Box>
}
