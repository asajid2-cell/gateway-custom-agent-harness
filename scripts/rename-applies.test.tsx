// Regression: submitting a rename in SessionMetadataDialog must actually change
// the name the rest of the app reads back.
import React from 'react'
import { expect, test, afterEach } from 'bun:test'
import { PassThrough } from 'node:stream'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { render, ThemeProvider, Box, Text } from '../src/ink.ts'
import { AppStateProvider } from '../src/state/AppState.tsx'
import instances from '../src/ink/instances.ts'
import { cellAt, type Screen } from '../src/ink/screen.ts'
import {
  SessionMetadataDialog,
} from '../src/components/SessionMetadataDialog.tsx'
import {
  getCurrentSessionTitle,
  getTranscriptPath,
  saveSessionName,
} from '../src/utils/sessionStorage.ts'
import { getSessionId } from '../src/bootstrap/state.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function visibleText(screen: Screen): string {
  let out = ''
  for (let y = 0; y < screen.height; y++) {
    for (let x = 0; x < screen.width; x++) out += cellAt(screen, x, y)?.char ?? ' '
    out += '\n'
  }
  return out
}

test('a submitted rename changes the name readers see back', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rename-test-'))
  dirs.push(home)
  process.env.HOME = home
  process.env.USERPROFILE = home

  const sessionId = getSessionId()
  // Use the real transcript path the dialog itself resolves, so the test
  // exercises the same file the product writes rather than a synthetic one.
  const transcript = getTranscriptPath()

  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 40, isTTY: true })
  stdout.resume()
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true, setRawMode() {}, ref() {}, unref() {},
  })

  let done = false
  const app = await render(
    <AppStateProvider>
      <ThemeProvider>
        <Box height={40} flexDirection="column">
          <SessionMetadataDialog onDone={() => { done = true }} />
        </Box>
      </ThemeProvider>
    </AppStateProvider>,
    { stdout: stdout as any, stdin: stdin as any, stderr: stdout as any, patchConsole: false, exitOnCtrlC: false },
  )

  try {
    await new Promise(r => setTimeout(r, 120))

    // The dialog must be showing its editable Name field.
    const screen = (instances.get(stdout as any) as any).frontFrame.screen as Screen
    const shown = visibleText(screen)
    expect(shown).toContain('Session metadata')
    expect(shown).toContain('Name:')

    // Type a name into the focused field, then submit with Enter — exactly what
    // the user does. If input focus or the submit path is broken, the name will
    // not land and the assertions below fail.
    const TARGET = 'Renamed By Test'
    stdin.emit('data', Buffer.from(TARGET))
    await new Promise(r => setTimeout(r, 80))
    stdin.emit('data', Buffer.from('\r'))
    await new Promise(r => setTimeout(r, 200))

    expect(done).toBe(true)

    const readBack = getCurrentSessionTitle(sessionId)
    expect(readBack).toBe(TARGET)

    const disk = existsSync(transcript) ? readFileSync(transcript, 'utf8') : ''
    expect(disk).toContain(TARGET)
  } finally {
    app.unmount()
    app.cleanup()
  }
})

// The reported case: renaming a session that already has a name. The field used
// to open pre-filled with the cursor at the end, so typing appended and the
// saved name was "Old NameNew Name" - which reads as the rename not taking.
test('renaming an already-named session replaces the name, not appends', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rename-again-'))
  dirs.push(home)
  process.env.HOME = home
  process.env.USERPROFILE = home

  const sessionId = getSessionId()
  const transcript = getTranscriptPath()
  saveSessionName(sessionId, 'Original Name', transcript)

  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 40, isTTY: true })
  stdout.resume()
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true, setRawMode() {}, ref() {}, unref() {},
  })

  let done = false
  const app = await render(
    <AppStateProvider>
      <ThemeProvider>
        <Box height={40} flexDirection="column">
          <SessionMetadataDialog onDone={() => { done = true }} />
        </Box>
      </ThemeProvider>
    </AppStateProvider>,
    { stdout: stdout as any, stdin: stdin as any, stderr: stdout as any, patchConsole: false, exitOnCtrlC: false },
  )

  try {
    await new Promise(r => setTimeout(r, 120))

    // The field is empty but advertises the current name as its placeholder, so
    // the old name is visible without being part of the new value.
    const screen = (instances.get(stdout as any) as any).frontFrame.screen as Screen
    const shown = visibleText(screen)
    expect(shown).toContain('Original Name')

    const TARGET = 'Replacement Name'
    stdin.emit('data', Buffer.from(TARGET))
    await new Promise(r => setTimeout(r, 80))
    stdin.emit('data', Buffer.from('\r'))
    await new Promise(r => setTimeout(r, 200))

    expect(done).toBe(true)
    expect(getCurrentSessionTitle(sessionId)).toBe(TARGET)
  } finally {
    app.unmount()
    app.cleanup()
  }
})

// An untouched field must keep the existing name - the field starts empty by
// design, so Enter with no input is "no change", not a validation failure.
test('submitting an untouched field keeps the existing name', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rename-untouched-'))
  dirs.push(home)
  process.env.HOME = home
  process.env.USERPROFILE = home

  const sessionId = getSessionId()
  saveSessionName(sessionId, 'Keep Me', getTranscriptPath())

  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 40, isTTY: true })
  stdout.resume()
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true, setRawMode() {}, ref() {}, unref() {},
  })

  let done = false
  const app = await render(
    <AppStateProvider>
      <ThemeProvider>
        <Box height={40} flexDirection="column">
          <SessionMetadataDialog onDone={() => { done = true }} />
        </Box>
      </ThemeProvider>
    </AppStateProvider>,
    { stdout: stdout as any, stdin: stdin as any, stderr: stdout as any, patchConsole: false, exitOnCtrlC: false },
  )

  try {
    await new Promise(r => setTimeout(r, 120))
    stdin.emit('data', Buffer.from('\r'))
    await new Promise(r => setTimeout(r, 200))

    expect(done).toBe(true)
    expect(getCurrentSessionTitle(sessionId)).toBe('Keep Me')
  } finally {
    app.unmount()
    app.cleanup()
  }
})
