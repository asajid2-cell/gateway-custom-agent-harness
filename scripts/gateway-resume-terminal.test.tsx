import React from 'react'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { PassThrough } from 'node:stream'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { mock } from 'bun:test'
import { render } from '../src/ink.ts'
import { AppStateProvider } from '../src/state/AppState.tsx'
import { lock } from '../src/utils/lockfile.ts'
import type { Command } from '../src/types/command.ts'
import type { LogOption } from '../src/types/logs.ts'

const injectedFailure = 'gateway resume hook failure (injected)'
let diagnosticOutput = ''
let observedFailure: unknown
const postSwitch = process.env.GATEWAY_RESUME_POST_SWITCH === '1'

// Install the failure before REPL is imported. Copy the real module's exports so
// this test only replaces the one hook used by the resume path.
;(globalThis as any).MACRO = {
  VERSION: '1.0.0-test',
  BUILD_TIME: 'test',
  PACKAGE_URL: '',
  NATIVE_PACKAGE_URL: undefined,
  FEEDBACK_CHANNEL: '',
  ISSUES_EXPLAINER: '',
  VERSION_CHANGELOG: '',
}

const hooksModule = await import('../src/utils/hooks.js')
const releaseNotesModule = await import('../src/utils/releaseNotes.js')
const autoUpdaterModule = await import('../src/utils/autoUpdater.js')
mock.module('../src/utils/autoUpdater.js', () => ({
  ...autoUpdaterModule,
  getLatestVersion: async () => null,
}))
mock.module('../src/utils/releaseNotes.js', () => ({
  ...releaseNotesModule,
  checkForReleaseNotesSync: () => ({ hasReleaseNotes: false, releaseNotes: [] }),
}))
mock.module('../src/utils/hooks.js', () => ({
  ...hooksModule,
  executeSessionEndHooks: async () => { if (!postSwitch) throw new Error(injectedFailure) },
  processSessionStartHooks: async () => [],
}))
const persistModule = await import('../src/skills/bundled/persist.js')
mock.module('../src/skills/bundled/persist.js', () => ({
  ...persistModule,
  restorePersistForCurrentSession: async (...args: any[]) => {
    if (postSwitch) throw new Error(injectedFailure)
    return persistModule.restorePersistForCurrentSession(...args)
  },
}))

const { REPL } = await import('../src/screens/REPL.tsx')

const resumeCommand: Command = {
  type: 'local-jsx',
  name: 'gateway-resume-test',
  immediate: true,
  description: 'test-only resume command',
  load: async () => ({
    call: async (_onDone, context, _args) => {
      const targetId = process.env.GATEWAY_RESUME_TEST_TARGET_ID!
      const minimalLog = {
        date: new Date().toISOString(),
        messages: [],
        value: 0,
        created: new Date(),
        modified: new Date(),
        firstPrompt: '',
        messageCount: 0,
        isSidechain: false,
        sessionId: targetId,
        projectPath: process.cwd(),
      } as LogOption
      try {
        assert.equal(typeof context.resume, 'function')
        await context.resume!(targetId as `${string}-${string}-${string}-${string}-${string}`, minimalLog, 'slash_command_session_id')
      } catch (error) {
        observedFailure = error
      }
      _onDone('Resume failure fixture finished', { display: 'system' })
      return null
    },
  }),
}

function waitFor(predicate: () => boolean, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve()
      if (Date.now() >= deadline) return reject(new Error(`Timed out waiting for terminal interaction: ${diagnosticOutput.slice(-3000)}`))
      setTimeout(poll, 25)
    }
    poll()
  })
}

test('mounted REPL releases a claimed target writer when resume hooks fail', { timeout: 50000 }, async () => {
  const savedEnv = { ...process.env }
  const configDir = await mkdtemp(join(tmpdir(), 'gateway-resume-terminal-'))
  await mkdir(join(configDir, 'gateway-writers'), { recursive: true })
  const targetId = randomUUID()
  process.env.CLAUDE_CONFIG_DIR = configDir
  process.env.CLAUDE_CODE_USE_GATEWAY = '1'
  process.env.CLAUDE_CODE_NO_FLICKER = '0'
  process.env.DEMO_VERSION = 'test'
  process.env.DISABLE_AUTOUPDATER = '1'
  process.env.GATEWAY_RESUME_TEST_TARGET_ID = targetId
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('network blocked by gateway resume terminal test') }

  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 30, isTTY: true })
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
  let output = ''
  stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-200000); diagnosticOutput = output })
  const app = await render(
    <AppStateProvider>
      <REPL
        commands={[resumeCommand]}
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
    await new Promise(resolve => setTimeout(resolve, 2500))
    const { getSessionId } = await import('../src/bootstrap/state.ts')
    const originalSessionId = getSessionId()
    stdin.write('/gateway-resume-test')
    await new Promise(resolve => setTimeout(resolve, 100))
    stdin.write('\r')
    await waitFor(() => observedFailure !== undefined)
    assert.equal((observedFailure as Error).message, injectedFailure)
    assert.equal(getSessionId(), postSwitch ? targetId : originalSessionId, 'failure must retain the appropriate committed session identity')

    // This is deliberately the lock primitive, not claimGatewaySessionWriter:
    // the cached helper can hide a leaked claim from this oracle.
    const releaseExternal = await lock(join(configDir, 'gateway-writers', postSwitch ? originalSessionId : targetId), { realpath: false, retries: 0 })
    await releaseExternal()
    if (postSwitch) {
      const { recordTranscript, flushSessionStorage, getTranscriptPath } = await import('../src/utils/sessionStorage.ts')
      const { createUserMessage } = await import('../src/utils/messages.ts')
      const { readFile } = await import('node:fs/promises')
      process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
      await recordTranscript([createUserMessage({ content: 'POST_SWITCH_WRITE_TARGET_ONLY' })])
      await flushSessionStorage()
      const targetPath = getTranscriptPath()
      assert.ok(targetPath.endsWith(`${targetId}.jsonl`))
      const persisted = (await readFile(targetPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      const marker = persisted.find(record => JSON.stringify(record.message ?? '').includes('POST_SWITCH_WRITE_TARGET_ONLY'))
      assert.ok(marker)
      assert.equal(marker.sessionId, targetId)
    }
  } finally {
    app.unmount()
    globalThis.fetch = originalFetch
    const { runCleanupFunctions } = await import('../src/utils/cleanupRegistry.ts')
    await runCleanupFunctions()
    for (const key of ['TEST_ENABLE_SESSION_PERSISTENCE', 'GATEWAY_RESUME_TEST_TARGET_ID', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_USE_GATEWAY', 'CLAUDE_CODE_NO_FLICKER', 'DEMO_VERSION', 'DISABLE_AUTOUPDATER']) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
  }
})
