/**
 * The LEDs a session can be given.
 *
 * The model is a phone's notification LED: a glance across the room says which
 * of the things you left running wants you. In a terminal the only per-tab
 * decoration a program can produce is the tab's own title, and the only coloured
 * thing a title can carry is an emoji, so a session's LED is an emoji in its
 * title, worn while the session is parked and steady rather than blinking - a
 * title that moves reads as activity, and the strip is scanned for what is
 * waiting, not for what is animating.
 */
export type LedColor = { id: string; name: string; glyph: string }

/**
 * The empty socket.
 *
 * What a session with no LED shows, in the footer control and in the picker's
 * own "No LED" row: an outline rather than a filled disc, which would read as
 * the black LED.
 */
export const LED_NONE_GLYPH = '◌'

export const LED_COLORS: readonly LedColor[] = [
  { id: 'red', name: 'Red', glyph: '🔴' },
  { id: 'orange', name: 'Orange', glyph: '🟠' },
  { id: 'yellow', name: 'Yellow', glyph: '🟡' },
  { id: 'green', name: 'Green', glyph: '🟢' },
  { id: 'blue', name: 'Blue', glyph: '🔵' },
  { id: 'purple', name: 'Purple', glyph: '🟣' },
  { id: 'brown', name: 'Brown', glyph: '🟤' },
  { id: 'black', name: 'Black', glyph: '⚫' },
  { id: 'white', name: 'White', glyph: '⚪' },
  { id: 'amber', name: 'Amber', glyph: '🔶' },
  { id: 'cyan', name: 'Cyan', glyph: '🔷' },
  { id: 'crimson', name: 'Crimson', glyph: '❤️' },
]

export function ledColor(id: string | undefined): LedColor | undefined {
  return id === undefined ? undefined : LED_COLORS.find(color => color.id === id)
}

/**
 * The tones a session can be given, by the Windows system sound that plays them.
 *
 * Windows already ships these, so nothing is vendored and no dependency is added;
 * the ids are `[System.Media.SystemSounds]` member names, which is how the
 * PowerShell child plays one.
 */
export type LedSound = { id: string; name: string }

export const LED_SOUNDS: readonly LedSound[] = [
  { id: 'asterisk', name: 'Chime' },
  { id: 'beep', name: 'Beep' },
  { id: 'question', name: 'Question' },
  { id: 'exclamation', name: 'Alert' },
  { id: 'hand', name: 'Error' },
]

export function ledSound(id: string | undefined): LedSound | undefined {
  return id === undefined ? undefined : LED_SOUNDS.find(sound => sound.id === id)
}

/** The states in which a session is parked - done, and waiting on a person. */
export function isParkedState(state: string): boolean {
  return state === 'idle' || state === 'awaiting-approval'
}

/**
 * What the tab title wears, given the state of the world. Pure, so the whole
 * indicator can be read without a terminal: it is this one string.
 *
 * Nothing while a turn runs, so the mark means "this one is done and waiting"
 * rather than being a permanent decoration nobody reads any more.
 */
export function ledTitleGlyph(assignment: { color: string } | undefined, parked: boolean): string {
  const glyph = assignment === undefined ? undefined : ledColor(assignment.color)?.glyph
  return glyph && parked ? glyph : ''
}
