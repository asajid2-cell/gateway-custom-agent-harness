// A session has to be identifiable from outside itself.
//
// The process list is where an unattributed session is actually noticed, and a
// gateway session's command line carries only the id it was resumed from - so a
// pile of them is a pile of identical bun processes. The title is the one
// channel the OS and every terminal already display, which is why the identity
// goes there rather than into an argument the process list never shows.
//
// The mount is the load-bearing half. Composing a label is easy to get right in
// isolation and easy to wire up wrong: `useTerminalTitle` is the only writer, and
// a second writer racing it would look correct in a unit test and flicker in a
// real tab. So this asserts the title the hook actually sets.
import { expect, test, afterEach } from 'bun:test'
import { PassThrough } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

;(globalThis as any).MACRO = {
  VERSION: '1.0.0-test',
  BUILD_TIME: 'test',
  PACKAGE_URL: '',
  NATIVE_PACKAGE_URL: undefined,
  FEEDBACK_CHANNEL: '',
  ISSUES_EXPLAINER: '',
  VERSION_CHANGELOG: '',
}

// Same neutralization as the sibling title tests: the mounted REPL reaches for
// the auto-updater, which shells out and throws under the test runner.
const { mock } = await import('bun:test')
const autoUpdaterModule = await import('../src/utils/autoUpdater.ts')
const releaseNotesModule = await import('../src/utils/releaseNotes.ts')
mock.module('../src/utils/autoUpdater.ts', () => ({
  ...autoUpdaterModule,
  getLatestVersion: async () => null,
}))
mock.module('../src/utils/releaseNotes.ts', () => ({
  ...releaseNotesModule,
  checkForReleaseNotesSync: () => ({ hasReleaseNotes: false, releaseNotes: [] }),
}))

const { render } = await import('../src/ink.ts')
const { AppStateProvider } = await import('../src/state/AppState.tsx')
const { REPL } = await import('../src/screens/REPL.tsx')
const { getSessionId } = await import('../src/bootstrap/state.ts')
const { sessionProcessTitle } = await import('../src/utils/sessionIdentity.ts')

test('a title carries the label and a short id that can be addressed', () => {
  const short = getSessionId().slice(0, 8)
  expect(sessionProcessTitle('Rework the installer')).toBe(`Rework the installer · ${short}`)
  // Nothing to name it with is not a reason to render a separator into the void.
  expect(sessionProcessTitle('')).toBe(short)
  expect(short).toMatch(/^[0-9a-f]{8}$/)
})

test('the LED this session was given leads the title, however long the name', async () => {
  // The LED is the whole reason the title is composed in one place, and it is
  // invisible to every unit test of the composition: what matters is that the
  // hook's one write carries it, and where in the string it sits. A tab clips
  // from the right, so a mark anywhere behind the name is a mark no tab shows -
  // the name here is a leaf's, which is the longest one there is.
  const configDir = mkdtempSync(join(tmpdir(), 'session-led-'))
  dirs.push(configDir)
  process.env.CLAUDE_CONFIG_DIR = configDir
  process.env.CLAUDE_CODE_USE_GATEWAY = '1'
  process.env.DISABLE_AUTOUPDATER = '1'
  process.env.GATEWAY_LEAF_LABEL = 'Leaf 2: tokens (of session 00000000-0000-4000-8000-000000000000)'

  const { setLedAssignment } = await import('../src/utils/ledStore.ts')
  await setLedAssignment(getSessionId(), getSessionId(), 'crimson')

  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 30, isTTY: true })
  let output = ''
  stdout.on('data', chunk => { output += chunk.toString() })
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true, setRawMode() {}, ref() {}, unref() {},
  })

  const app = await render(
    <AppStateProvider>
      <REPL
        commands={[]}
        debug={false}
        initialTools={[]}
        initialMessages={[]}
        disableSlashCommands={false}
        thinkingConfig={{ type: 'disabled' }}
      />
    </AppStateProvider>,
    { stdout: stdout as any, stderr: stdout as any, stdin: stdin as any, patchConsole: false, exitOnCtrlC: false },
  )

  try {
    const short = getSessionId().slice(0, 8)
    let title: string | undefined
    for (let i = 0; i < 30 && !(title ?? '').includes('❤️'); i++) {
      await new Promise(r => setTimeout(r, 100))
      title = observedTitle(output)
    }
    expect(title).toContain('❤️')
    expect(title!.indexOf('❤️')).toBe(0)
    // The clip case, on the real title the hook set: whatever width the tab is,
    // the LED is still in what it shows.
    expect(title!.slice(0, 8)).toContain('❤️')
    expect(title!.length).toBeGreaterThan(60)
    expect(title!.indexOf('❤️')).toBeLessThan(title!.indexOf(short))
  } finally {
    app.unmount()
    app.cleanup()
    for (const key of ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_USE_GATEWAY', 'DISABLE_AUTOUPDATER', 'GATEWAY_LEAF_LABEL']) {
      delete process.env[key]
    }
  }
}, 30_000)

test('a leaf is titled by its own label, not the conversation it copied', () => {
  // A forked leaf carries the parent's transcript, so the session title it would
  // otherwise show describes work that belongs to somebody else. Naming it after
  // that is worse than naming it nothing.
  process.env.GATEWAY_LEAF_LABEL = 'Leaf 4: ProductShape'
  try {
    expect(sessionProcessTitle('the parent conversation title')).toBe(`Leaf 4: ProductShape · ${getSessionId().slice(0, 8)}`)
  } finally {
    delete process.env.GATEWAY_LEAF_LABEL
  }
})

// On win32 the title hook sets process.title (conhost has no OSC); elsewhere it
// writes OSC 0 to stdout. Read whichever channel this platform actually uses.
const onWindows = process.platform === 'win32'
function observedTitle(output: string): string | undefined {
  if (onWindows) return process.title
  const re = /\u001b\]0;([^\u0007\u001b]*)(?:\u0007|\u001b\\)/g
  let last: string | undefined
  let m: RegExpExecArray | null
  while ((m = re.exec(output)) !== null) last = m[1]
  return last
}

test('the mounted REPL puts this session id in the terminal title', async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'session-identity-'))
  dirs.push(configDir)
  process.env.CLAUDE_CONFIG_DIR = configDir
  process.env.CLAUDE_CODE_USE_GATEWAY = '1'
  process.env.DISABLE_AUTOUPDATER = '1'

  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 30, isTTY: true })
  let output = ''
  stdout.on('data', chunk => { output += chunk.toString() })
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true, setRawMode() {}, ref() {}, unref() {},
  })

  const app = await render(
    <AppStateProvider>
      <REPL
        commands={[]}
        debug={false}
        initialTools={[]}
        initialMessages={[]}
        disableSlashCommands={false}
        thinkingConfig={{ type: 'disabled' }}
      />
    </AppStateProvider>,
    { stdout: stdout as any, stderr: stdout as any, stdin: stdin as any, patchConsole: false, exitOnCtrlC: false },
  )

  try {
    const short = getSessionId().slice(0, 8)
    let title: string | undefined
    for (let i = 0; i < 30 && !(title ?? '').includes(short); i++) {
      await new Promise(r => setTimeout(r, 100))
      title = observedTitle(output)
    }
    expect(title).toBeDefined()
    expect(title!).toContain(short)
  } finally {
    app.unmount()
    app.cleanup()
    for (const key of ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_USE_GATEWAY', 'DISABLE_AUTOUPDATER']) {
      delete process.env[key]
    }
  }
}, 30_000)
