import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import test from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

test('build stages the bundle and validates with Bun rather than Node', async () => {
  const build = await readFile(new URL('./build.ts', import.meta.url), 'utf8')
  assert.match(build, /mkdtempSync\(join\(OUT_DIR, '.build-'\)\)/)
  assert.match(build, /new Bun.Transpiler/)
  assert.match(build, /renameSync\(artifact, join\(OUT_DIR, 'cli.js'\)\)/)
  assert.doesNotMatch(build, /\['node', '--check'/)
})

test('launcher diagnostics use an explicit safe-field allowlist', async () => {
  const script = await readFile(new URL('./cc.ps1', import.meta.url), 'utf8')
  assert.match(script, /@\('exitCode', 'attempt', 'port', 'errorType'\)/)
  assert.match(script, /Write-LaunchDiagnostic 'harness-exit'/)
  assert.match(script, /Write-LaunchDiagnostic 'build-exit'/)
  assert.doesNotMatch(script, /throw[^\n]*\$detail/)
  assert.match(script, /scripts\\effort-capabilities\.json/)
})

test('launcher forwards the full Gateway model catalog with economical role defaults', async () => {
  const script = await readFile(new URL('./cc.ps1', import.meta.url), 'utf8')
  assert.match(script, /function Resolve-DefaultGatewayEffort \{/)
  assert.match(script, /\$levels -contains 'medium'/)
  assert.match(script, /\$levels -contains 'high'/)
  assert.match(script, /return \[string\]\$levels\[0\]/)
  assert.match(script, /\$Effort = Resolve-DefaultGatewayEffort -Value \$Model/)
  assert.match(script, /-not \[string\]::IsNullOrWhiteSpace\(\$Effort\) -and/)
  assert.doesNotMatch(script, /else \{ 'medium' \}/)
  assert.match(script, /MODEL_GATEWAY_DEFAULT_MODEL = 'gateway-gpt-sol'/)
  assert.match(script, /MODEL_GATEWAY_OPUS_MODEL = 'gateway-gpt-astra'/)
  assert.match(script, /MODEL_GATEWAY_FAST_MODEL = 'gateway-gpt-luna'/)
  assert.match(script, /MODEL_GATEWAY_SUBAGENT_MODEL = 'gateway-gpt-luna'/)
  assert.match(script, /\$GatewayModelOptions = @\(\$CapabilityCatalog\.gatewayModelOptions\)/)
  assert.doesNotMatch(script, /ApprovedGatewayModels/)
  assert.doesNotMatch(script, /Where-Object \{[\s\S]*\$_\.value -in/)

  const catalog = JSON.parse(await readFile(new URL('./effort-capabilities.json', import.meta.url), 'utf8'))
  const options = catalog.gatewayModelOptions
  assert.ok(options.some(option => option.value === 'gateway-gpt-terra'))
  assert.ok(options.some(option => option.value === 'gateway-ds-flash'))
  assert.ok(options.some(option => option.value === 'gateway-ds-pro'))
  assert.ok(options.some(option => option.value === 'gateway-ds-4.1-flash'))
  assert.ok(options.some(option => option.value === 'gateway-opencode-deepseek-v4.1-flash'))
  assert.ok(options.some(option => option.value.startsWith('gateway-opencode-')))
})

test('runtime diagnostic writer excludes exception text and records exit code', async () => {
  const source = await readFile(new URL('../src/utils/gracefulShutdown.ts', import.meta.url), 'utf8')
  const start = source.indexOf('function recordGatewayFailure(')
  const end = source.indexOf('\nexport const setupGracefulShutdown', start)
  assert.ok(start >= 0 && end > start)
  const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end))
  const directory = await mkdtemp(path.join(tmpdir(), 'gateway-diagnostics-'))
  const fakeProcess = {
    env: { CLAUDE_CODE_USE_GATEWAY: '1', LOCALAPPDATA: directory },
    pid: 123, version: 'test-runtime', uptime: () => 1,
    memoryUsage: () => ({ rss: 42 }),
  }
  try {
    const record = new Function('process', 'join', 'homedir', 'mkdirSync', 'statSync', 'renameSync', 'appendFileSync', 'getSessionId',
      `${code}; return recordGatewayFailure`)(fakeProcess, path.join, tmpdir, mkdirSync, statSync, renameSync, appendFileSync, () => 'test-session')
    const error = new Error('SECRET_SENTINEL must never be logged')
    error.stack = 'Error: SECRET_SENTINEL\n    at run (cli.js:12:34)'
    record('uncaught-exception', error)
    record('runtime-exit', undefined, 17)
    const raw = await readFile(path.join(directory, 'Gateway', 'harness-123.jsonl'), 'utf8')
    assert.equal(raw.includes('SECRET_SENTINEL'), false)
    const records = raw.trim().split('\n').map(JSON.parse)
    assert.deepEqual(records[0].frames, ['cli.js:12:34'])
    assert.equal(records[1].exitCode, 17)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

const scriptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'cc.ps1',
)

test('interactive cc launches the harness without a PowerShell output pipeline', async () => {
  const script = await readFile(scriptPath, 'utf8')
  assert.equal(
    /& \$ClaudeRunner \$ClaudeScript @ClaudeArgs\s+2>&1\s*\|/.test(script),
    false,
    'interactive harness output must not be piped through PowerShell',
  )
  assert.match(
    script,
    /# Keep the harness attached directly to the caller's console/,
  )
  assert.match(
    script,
    /\$ExitCode -ne 0[\s\S]*\$ExitCode -ne 130/,
    'resumed sessions should have one bounded non-zero-exit recovery attempt',
  )
  assert.match(script, /if \(\$ExitCode -eq 0 -or \$ExitCode -eq 130 -or \$attempt -ge \$AutoRestartAttempts\)/,
    'successful exits must not relaunch resumed sessions')
  assert.equal(script.includes('Tee-Object -FilePath $ClaudeCrashLog'), false)
})

test('launcher answers the workspace-trust question per process, and can be opted out', async () => {
  const script = await readFile(scriptPath, 'utf8')
  // Defaulted only when unset, so CLAUDE_CODE_TRUST_CWD=0 restores the prompt.
  assert.match(
    script,
    /if \(\[string\]::IsNullOrWhiteSpace\(\$env:CLAUDE_CODE_TRUST_CWD\)\) \{\s*\$env:CLAUDE_CODE_TRUST_CWD = '1'\s*\}/,
    'the trust opt-in must not clobber an explicit value',
  )

  // The grant has to be read where trust is decided, or the dialog still shows
  // and the rest of the codebase (hooks, plugins, MCP approval) disagrees with
  // a launcher that skipped it.
  const config = await readFile(new URL('../src/utils/config.ts', import.meta.url), 'utf8')
  assert.match(
    config,
    /function computeTrustDialogAccepted\(\): boolean \{\s*(?:\/\/[^\n]*\n|\s)*\s*if \(isEnvTruthy\(process\.env\.CLAUDE_CODE_TRUST_CWD\)\) \{\s*return true\s*\}/,
    'computeTrustDialogAccepted must honor the launcher opt-in',
  )
  // Nothing may be written: the grant is per-process, which is the whole
  // difference between this and persisting hasTrustDialogAccepted.
  const gate = config.slice(
    config.indexOf('function computeTrustDialogAccepted'),
    config.indexOf('const config = getGlobalConfig()', config.indexOf('function computeTrustDialogAccepted')),
  )
  assert.equal(
    /saveGlobalConfig|saveCurrentProjectConfig/.test(gate),
    false,
    'the opt-in must not persist a trust grant',
  )
})

test('interactive cc skips the full build when the compiled harness is fresh', async () => {
  const script = await readFile(scriptPath, 'utf8')
  assert.match(script, /function Test-ClaudeArtifactFresh\s*\{[\s\S]*Get-ChildItem[\s\S]*LastWriteTimeUtc/)
  assert.match(
    script,
    /if \(-not \(Test-ClaudeArtifactFresh\)\) \{[\s\S]*& \$ClaudeRunner 'run' 'build'/,
    'the build must be conditional on artifact freshness',
  )
  assert.equal(
    /# The global cc launcher intentionally points at this worktree\. Rebuild before\s+# every launch/.test(script),
    false,
    'the launcher must not rebuild unconditionally',
  )
})

test('interactive cc avoids the Defender-blocked nested encoded launcher', async () => {
  const script = await readFile(scriptPath, 'utf8')
  assert.equal(script.includes('$NestedEncoded'), false)
  assert.doesNotMatch(
    script,
    /\$KeysafeCommand\s*=\s*['"]& powershell\.exe[\s\S]*-EncodedCommand/,
  )
  assert.match(
    script,
    /\$KeysafeCommand\s*=\s*'& '\s*\+[\s\S]*\$Keysafe\.Replace/,
    'each optional credential should be injected by invoking keysafe directly in the existing child',
  )
  // Every optional provider must be wrapped the same way, and the env-var name
  // must come from the provider table rather than being hardcoded per provider,
  // so adding a provider cannot silently skip its key injection.
  assert.match(
    script,
    /\$OptionalKeyProviders\s*=\s*@\([\s\S]*Credential\s*=\s*'opencode-go'[\s\S]*Credential\s*=\s*'amd-ds'[\s\S]*\)/,
    'optional providers should be declared in one table',
  )
})
