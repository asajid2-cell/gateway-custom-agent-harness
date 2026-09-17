// Regression: a rename must change the title the terminal actually shows.
//
// The sibling test (rename-applies.test.tsx) proves storage accepts the write.
// This one proves the *display* follows it, which is the part the user sees.
//
// The shape of the fault: the title lives in a module-level cache, so REPL read
// it during render with a bare getCurrentSessionTitle() call - no dependency
// React could track. A rename landed in the cache and REPL kept rendering the
// old name until something unrelated re-rendered it. The Rename button's dialog
// sets standaloneAgentContext, which REPL does not read, so for that path
// nothing ever re-rendered: the name changed on disk and stayed wrong on screen.
//
// So the test must NOT give the rename a free re-render. Calling the storage
// function directly - exactly what both rename paths do - and asserting the
// title follows is what discriminates fixed from broken. Driving /rename instead
// would pass even pre-fix, because that command's setAppState() re-renders REPL
// as a side effect and masks the missing subscription.
import React from 'react'
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

// The mounted REPL pulls in the auto-updater, which shells out and throws under
// the test runner. Neutralize the two modules it reaches for, matching
// gateway-resume-terminal.test.tsx.
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
const storage = await import('../src/utils/sessionStorage.ts')
const { getSessionId } = await import('../src/bootstrap/state.ts')

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

test('a rename reaches the terminal title without an unrelated re-render', async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'rename-title-'))
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
    await new Promise(r => setTimeout(r, 800))

    const before = observedTitle(output)
    expect(before).toBeDefined()
    expect(before).not.toContain('Renamed Title Target')

    // The exact call both rename entry points make. No app-state write, no
    // command, nothing that would re-render REPL for an unrelated reason.
    storage.saveSessionName(getSessionId(), 'Renamed Title Target', storage.getTranscriptPath())

    // Poll: the title must follow on its own.
    let after = observedTitle(output)
    for (let i = 0; i < 20 && !(after ?? '').includes('Renamed Title Target'); i++) {
      await new Promise(r => setTimeout(r, 100))
      after = observedTitle(output)
    }

    expect(after).toContain('Renamed Title Target')
  } finally {
    app.unmount()
    app.cleanup()
    for (const key of ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_USE_GATEWAY', 'DISABLE_AUTOUPDATER']) {
      delete process.env[key]
    }
  }
}, 30_000)
