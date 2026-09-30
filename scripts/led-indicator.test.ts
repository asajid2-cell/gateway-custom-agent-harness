import { test, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LED_COLORS,
  LED_NONE_GLYPH,
  LED_SOUNDS,
  isParkedState,
  ledColor,
  ledTitleGlyph,
} from '../src/utils/ledPalette.ts'
import { sessionProcessTitle } from '../src/utils/sessionIdentity.ts'
import {
  clearLedAssignment,
  ledAssignmentsSync,
  ledColorOwner,
  readLedStore,
  refreshLedStore,
  setLedAssignment,
} from '../src/utils/ledStore.ts'
import { WINDOWS_TOAST_SCRIPT, win32NotifyCommand } from '../src/utils/windowsNotify.ts'

/**
 * The LED is a family-scoped claim on a file, so the subject here is the session
 * side - the store, not a leaf. Launched by a leaf the inherited identity would
 * make `familyRootSync()` answer from the watching session's snapshot instead of
 * this process's own id, which is the ambient identity the family suite pins for
 * the same reason. Pin it, and put it back for whatever runs next.
 */
const ambientLeafIdentity = process.env.GATEWAY_INTERACTIVE_LEAF
delete process.env.GATEWAY_INTERACTIVE_LEAF
after(() => {
  if (ambientLeafIdentity === undefined) delete process.env.GATEWAY_INTERACTIVE_LEAF
  else process.env.GATEWAY_INTERACTIVE_LEAF = ambientLeafIdentity
})

/** A config home of its own, so the store lives and dies inside one test. */
async function freshDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'led-store-'))
  process.env.CLAUDE_CONFIG_DIR = directory
  return directory
}

test('the palette offers twelve LEDs and no two of them are the same', () => {
  assert.equal(LED_COLORS.length, 12)
  assert.equal(new Set(LED_COLORS.map(color => color.id)).size, 12, 'ids are unique')
  assert.equal(new Set(LED_COLORS.map(color => color.glyph)).size, 12, 'glyphs are unique')
  assert.ok(
    !LED_COLORS.some(color => color.glyph === LED_NONE_GLYPH),
    'the empty socket must not be a colour a session can wear, or a black LED would read as no LED',
  )
  assert.equal(ledColor('black')?.glyph, '⚫', 'the nine circles include black')
  assert.equal(ledColor('crimson')?.glyph, '❤️')
  assert.equal(ledColor('chartreuse'), undefined)
})

test('the LED appears only when parked, and stays while it is', () => {
  const assignment = { color: 'red' }
  assert.equal(ledTitleGlyph(undefined, true), '', 'a session with no LED is untouched')
  assert.equal(ledTitleGlyph(assignment, false), '', 'nothing to say while the turn runs')
  assert.equal(ledTitleGlyph(assignment, true), '🔴')
  assert.equal(ledTitleGlyph({ color: 'chartreuse' }, true), '', 'an unknown colour is not an LED')
})

test('the LED leads the title, so a clipped tab cannot lose it', () => {
  const short = sessionProcessTitle('').slice(-8)
  assert.equal(sessionProcessTitle('Rework the installer', '🔴'), `🔴 Rework the installer · ${short}`)
  assert.equal(
    sessionProcessTitle('Rework the installer'),
    sessionProcessTitle('Rework the installer', ''),
    'no LED leaves the title exactly as it was',
  )
  assert.equal(sessionProcessTitle('', '🔴'), `🔴 ${short}`, 'a session with nothing to name it still wears its LED')
})

test('a long name cannot push the LED out of the tab', () => {
  // A tab clips its title from the right, and the name is the long part: a leaf
  // is titled "<leaf> (of session <id>)" and a session titled after its own work
  // is no shorter. A mark after the name is a mark no tab shows, so the LED has
  // to lead and survive every width a tab might clip to.
  const long = sessionProcessTitle(`Leaf 2: tokens (of session ${'e'.repeat(48)})`, '🔴')
  assert.ok(long.startsWith('🔴 '), `the LED leads a long title: ${long.slice(0, 32)}…`)
  assert.ok(long.length > 60, 'the case is only meaningful if the name really is long')
  for (const width of [4, 8, 12, 16, 24, 40]) {
    assert.ok(
      long.slice(0, width).includes('🔴'),
      `the LED survives a ${width}-column tab: ${JSON.stringify(long.slice(0, width))}`,
    )
  }
  // Leading the id as well as the name: an id behind a long name is equally lost,
  // and the two must not be able to swap places.
  assert.ok(long.indexOf('🔴') < long.indexOf('Leaf 2'), 'the LED leads the name')
  assert.ok(long.startsWith('🔴'), 'nothing may be composed ahead of the LED')
})

test('a session awaiting approval is parked, a running one is not', () => {
  assert.ok(isParkedState('idle'))
  assert.ok(isParkedState('awaiting-approval'))
  assert.ok(!isParkedState('running'))
  assert.ok(!isParkedState('closed'))
  assert.ok(!isParkedState('failed'))
})

test('an LED is a claim on a file the whole family reads', async () => {
  const directory = await freshDirectory()
  const family = randomUUID()
  const session = randomUUID()
  try {
    assert.deepEqual(
      await readLedStore(family),
      { version: 1, assignments: {} },
      'off by default: a family nobody has touched has no LEDs',
    )
    await setLedAssignment(family, session, 'blue', { notify: true, sound: 'asterisk' })
    assert.deepEqual((await readLedStore(family)).assignments[session], {
      color: 'blue',
      notify: true,
      sound: 'asterisk',
    })
    await clearLedAssignment(family, session)
    assert.deepEqual((await readLedStore(family)).assignments, {}, 'turning the LED off leaves no row behind')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('one colour belongs to one session', async () => {
  const directory = await freshDirectory()
  const family = randomUUID()
  const first = randomUUID()
  const second = randomUUID()
  try {
    await setLedAssignment(family, first, 'green')
    assert.deepEqual((await readLedStore(family)).assignments[first], { color: 'green', notify: false, sound: null })
    await assert.rejects(() => setLedAssignment(family, second, 'green'), /already worn/)
    await setLedAssignment(family, first, 'green', { notify: true })
    assert.deepEqual(
      (await readLedStore(family)).assignments[first],
      { color: 'green', notify: true, sound: null },
      'a session may change what its own LED does without giving up the colour',
    )
    await clearLedAssignment(family, first)
    await setLedAssignment(family, second, 'green')
    assert.equal((await readLedStore(family)).assignments[second]?.color, 'green', 'the colour is free once it is given up')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('two sessions racing for one colour leave exactly one wearing it', async () => {
  const directory = await freshDirectory()
  const family = randomUUID()
  try {
    const results = await Promise.allSettled([
      setLedAssignment(family, randomUUID(), 'amber'),
      setLedAssignment(family, randomUUID(), 'amber'),
    ])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1, 'the claim is exclusive across writers')
    const assignments = (await readLedStore(family)).assignments
    assert.equal(Object.keys(assignments).length, 1)
    assert.equal(assignments[Object.keys(assignments)[0]!]!.color, 'amber')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a colour or a tone that does not exist is refused, and nothing is written', async () => {
  const directory = await freshDirectory()
  const family = randomUUID()
  const session = randomUUID()
  try {
    await assert.rejects(() => setLedAssignment(family, session, 'chartreuse'), /Unknown LED colour/)
    await assert.rejects(() => setLedAssignment(family, session, 'red', { sound: 'gong' }), /Unknown LED sound/)
    assert.deepEqual((await readLedStore(family)).assignments, {}, 'a refused claim leaves the store as it was')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a colour in use names its owner, and your own LED is not taken from you', () => {
  const assignments = { alpha: { color: 'red', notify: false, sound: null } }
  assert.equal(ledColorOwner(assignments, 'red', 'beta'), 'alpha')
  assert.equal(ledColorOwner(assignments, 'red', 'alpha'), undefined)
  assert.equal(ledColorOwner(assignments, 'blue', 'beta'), undefined)
})

test('the render path sees the family store after a refresh', async () => {
  const directory = await freshDirectory()
  const { getSessionId } = await import('../src/bootstrap/state.ts')
  const { forgetLedStore } = await import('../src/utils/ledStore.ts')
  try {
    // No family and no pointer file: a session's family is itself, which is the
    // same id it wears an LED under before any family forms.
    const family = getSessionId()
    forgetLedStore()
    assert.deepEqual(ledAssignmentsSync(), {}, 'nothing is claimed before the first read')
    await setLedAssignment(family, family, 'purple')
    await refreshLedStore()
    assert.equal(ledAssignmentsSync()[family]?.color, 'purple')
    await clearLedAssignment(family, family)
    await refreshLedStore()
    assert.deepEqual(ledAssignmentsSync(), {}, 'a cleared LED leaves the render path too')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('the Windows notification is a constant script fed over stdin', () => {
  assert.match(WINDOWS_TOAST_SCRIPT, /\[Console\]::In\.ReadToEnd\(\)/, 'the payload arrives on stdin')
  assert.match(WINDOWS_TOAST_SCRIPT, /ToastNotificationManager/)
  assert.ok(!WINDOWS_TOAST_SCRIPT.includes('${'), 'nothing is interpolated into the command line')
  assert.deepEqual(win32NotifyCommand(), {
    file: 'powershell',
    args: ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_TOAST_SCRIPT],
  })
})

test('every tone the picker offers is one the script can play', () => {
  assert.ok(LED_SOUNDS.length > 0)
  for (const sound of LED_SOUNDS) {
    assert.match(WINDOWS_TOAST_SCRIPT, new RegExp(`${sound.id}=\\[System\\.Media`), `${sound.id} is playable`)
  }
})
