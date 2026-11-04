import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm, mkdir, writeFile, copyFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
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

test('both launchers disable Bun auto-install ahead of the script path', async () => {
  const script = await readFile(new URL('./cc.ps1', import.meta.url), 'utf8')
  const launcher = await readFile(new URL('./cc-launcher.mjs', import.meta.url), 'utf8')
  // After the script path Bun silently ignores the flag, so anchor on the order.
  assert.match(script, /& \$ClaudeRunner --no-install \$ClaudeScript/)
  assert.match(launcher, /spawnSync\(ClaudeRunner, \['--no-install', ClaudeScript,/)
})

test('both launchers pass `login` through before session flags', async () => {
  const script = await readFile(new URL('./cc.ps1', import.meta.url), 'utf8')
  const launcher = await readFile(new URL('./cc-launcher.mjs', import.meta.url), 'utf8')
  // `cc login` is a CLI subcommand and must not inherit the session's flags or
  // start a gateway. Anchor on the order, not just presence.
  const launcherCase = launcher.indexOf("ClaudeArgs[0] === 'login'")
  assert.ok(launcherCase > 0)
  assert.ok(launcherCase < launcher.indexOf('--dangerously-skip-permissions'))
  const psCase = script.indexOf("([string]($ClaudeArgs[0])) -eq 'login'")
  const psFlags = script.indexOf("$ClaudeArgs += '--dangerously-skip-permissions'")
  assert.ok(psCase > 0)
  assert.ok(psCase < psFlags)
})

test('the external allowlist is one data file shared with the stage', async () => {
  const build = await readFile(new URL('./build.ts', import.meta.url), 'utf8')
  const allowlist = JSON.parse(await readFile(new URL('./bundle-allowlist.json', import.meta.url), 'utf8'))
  assert.match(build, /bundle-allowlist\.json/)
  // modifiers-napi is a build-generated stub, not a package the stage installs.
  assert.deepEqual(allowlist.nativePackages, ['sharp'])
  assert.deepEqual(allowlist.buildGeneratedExternals, ['modifiers-napi'])
  assert.deepEqual(allowlist.lazyOptional, ['@opentelemetry/exporter-*'])
})

test('settings compatibility is guarded generally, in both directions', async () => {
  const types = await readFile(new URL('../src/utils/settings/types.ts', import.meta.url), 'utf8')
  const validation = await readFile(new URL('../src/utils/settings/validation.ts', import.meta.url), 'utf8')
  const settings = await readFile(new URL('../src/utils/settings/settings.ts', import.meta.url), 'utf8')
  // A newer Claude Code can write a value this build's schema lacks (e.g. an
  // unknown permission mode). Any invalid setting makes the loader skip the
  // whole file, so the field must swallow an unknown value rather than reject.
  assert.match(
    types,
    /defaultMode: z\s*\.enum\([\s\S]*?\)\s*\.optional\(\)[\s\S]*?\.catch\(undefined\)/,
    'defaultMode must tolerate a mode this build does not know',
  )
  // One general guard replaces the single-field special case: it drops any
  // value this build does not accept (warning + log), and records the fields it
  // does accept and the ones it does not know - both directions logged.
  assert.match(validation, /export function guardSettingsCompatibility/)
  assert.match(validation, /collectSwallowedValues/)
  assert.match(validation, /acceptedFields/)
  assert.match(validation, /unknownFields/)
  assert.match(validation, /logForDebugging\([\s\S]*?accepted fields in/)
  assert.match(validation, /logForDebugging\([\s\S]*?unknown fields in/)
  // The file loader uses the guard, not the old single-field filter.
  assert.match(settings, /guardSettingsCompatibility\(data, path\)/)
  assert.doesNotMatch(settings, /filterInvalidPermissionRules/)
})

test('launcher owns the backend job through startup and unconditional cleanup', async () => {
  const script = await readFile(new URL('./cc.ps1', import.meta.url), 'utf8')
  assert.match(script, /\. \(Join-Path \$PSScriptRoot 'owned-gateway-process\.ps1'\)/)
  assert.match(script, /\$ownedGateway = Start-OwnedGatewayProcess/)
  assert.match(script, /\$GatewayJob = \$ownedGateway\.Job/)
  assert.match(script, /Stop-OwnedGateway -Process \$GatewayProcess\s*\} finally \{\s*if \(\$GatewayJob\) \{ \$GatewayJob\.Dispose\(\) \}/)
  assert.doesNotMatch(script, /\$GatewayProcess = Start-Process/)
})

test('a clean machine launches bundled and does not require the legacy store', async () => {
  const script = await readFile(new URL('./cc.ps1', import.meta.url), 'utf8')
  const launcher = await readFile(new URL('./cc-launcher.mjs', import.meta.url), 'utf8')
  // An unset mode must resolve to the cleanroom default explicitly; leaving it
  // unset made every `-eq 'bundled'` branch fall through to the keysafe chain.
  assert.match(script, /\$env:GATEWAY_CREDENTIALS_MODE = 'bundled'/)
  assert.match(launcher, /legacyExternalStorePresent\(\) \? 'external' : 'bundled'/)
  // The keysafe script is an external-mode prerequisite only.
  assert.match(
    script,
    /\$env:GATEWAY_CREDENTIALS_MODE -ne 'bundled' -and -not \(Test-Path -LiteralPath \$Keysafe\)/,
  )
  // The default codex home need not exist yet: `codex login` creates it.
  assert.match(script, /return \$DefaultCodexHome\s*\r?\n\s*\} elseif/)
})

test('launcher diagnostics use an explicit safe-field allowlist', async () => {
  const script = await readFile(new URL('./cc.ps1', import.meta.url), 'utf8')
  assert.match(script, /@\('exitCode', 'attempt', 'port', 'errorType', 'elapsedMs'\)/)
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
  assert.match(script, /MODEL_GATEWAY_DEFAULT_MODEL = 'gateway-gpt-6-sol'/)
  assert.match(script, /MODEL_GATEWAY_OPUS_MODEL = 'gateway-gpt-astra'/)
  // Both roles must land on a lane that answers: the Codex lanes measured
  // 1/10 and 0/10 under 10 concurrent auxiliary calls, the ds lanes 10/10.
  assert.match(script, /MODEL_GATEWAY_FAST_MODEL = 'gateway-ds-flash'/)
  assert.match(script, /MODEL_GATEWAY_SUBAGENT_MODEL = 'gateway-ds-4\.1-flash'/)
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

test('a fresh launch mints a session id its retry can resume, in both mirrors', async () => {
  const script = await readFile(scriptPath, 'utf8')
  // A fresh interactive session is given an id at launch, so an unexpected exit
  // is recovered by resuming the very session that crashed rather than opening
  // a second, unrelated conversation. The retry rewrites that id to --resume;
  // print and prompt-carrying launches are left alone.
  assert.match(script, /\$MintedSessionId = \[Guid\]::NewGuid\(\)\.ToString\(\)/)
  assert.match(script, /\$ClaudeArgs \+= @\('--session-id', \$MintedSessionId\)/)
  assert.match(script, /\$AutoRestartAttempts = if \(\$IsResume -or \$MintedSessionId\) \{ 1 \} else \{ 0 \}/)
  assert.match(script, /if \(\$argument -eq '--session-id'\) \{ '--resume' \}/)
  assert.match(script, /\$AttemptArgs = if \(\$attempt -eq 0\) \{ \$ClaudeArgs \} else \{ \$RetryArgs \}/)

  // The POSIX mirror must make the same decision with the same guards.
  const posix = await readFile(new URL('./cc-launcher.mjs', import.meta.url), 'utf8')
  assert.match(posix, /mintedSessionId = randomUUID\(\)/)
  assert.match(posix, /ClaudeArgs\.push\('--session-id', mintedSessionId\)/)
  assert.match(posix, /const attempts = isResume \|\| mintedSessionId \? 1 : 0/)
  assert.match(posix, /finalArgs\.map\(a => \(a === '--session-id' \? '--resume' : a\)\)/)
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
  // The freshness walk reads mtimes through the .NET directory API instead of
  // Get-ChildItem + Measure-Object, which builds a FileInfo per file and then
  // re-walks the list. Measured ~690ms against ~77ms for the same tree, on the
  // launch path before the gateway is spawned.
  assert.match(script, /function Test-ClaudeArtifactFresh\s*\{[\s\S]*Get-NewestWriteTimeUtc/)
  assert.match(script, /\[IO\.Directory\]::EnumerateFiles\([\s\S]*AllDirectories\)/)
  assert.match(script, /\[IO\.File\]::GetLastWriteTimeUtc/)
  const fresh = script.slice(
    script.indexOf('function Test-ClaudeArtifactFresh'),
    script.indexOf('function Initialize-ClaudeArtifact'),
  )
  assert.doesNotMatch(
    fresh,
    /Get-ChildItem/,
    'the launch-path freshness check must not use the pipeline scan',
  )
  assert.match(
    script,
    /if \(-not \(Test-ClaudeArtifactFresh\)\) \{[\s\S]*\$startInfo\.Arguments = 'run build'/,
    'the build must be conditional on artifact freshness',
  )
  assert.equal(
    /# The global cc launcher intentionally points at this worktree\. Rebuild before\s+# every launch/.test(script),
    false,
    'the launcher must not rebuild unconditionally',
  )
})

test('launcher names the two gateway-unhealthy modes instead of one timeout', async () => {
  const script = await readFile(scriptPath, 'utf8')
  // A backend that dies at startup is not a 15s timeout. The diagnostic records
  // which happened, the message names the exit code and elapsed time, and the
  // child's stderr survives so the reason is recoverable.
  assert.match(script, /errorType = 'exited'/)
  assert.match(script, /errorType = 'timeout'/)
  assert.match(script, /\$gatewayExitCode = \$GatewayProcess\.ExitCode/)
  assert.match(script, /backend exited \(code \$codeText\) after \$\{elapsedMs\}ms/)
  // The missing-record hint emits only the validated name from keysafe's own
  // message, never raw stderr.
  assert.match(script, /no key named '\(\[A-Za-z0-9\._-\]\{1,64\}\)'/)
  assert.match(script, /credential is missing from the legacy keysafe store/)
  assert.match(script, /did not become healthy within 15 seconds \(waited \$\{elapsedMs\}ms\)/)
  assert.match(script, /\$PreserveGatewayLogs = \$true/)
  assert.match(script, /if \(\$KeepGatewayLogs -or \$PreserveGatewayLogs\)/)
})

test('launcher teardown relies on the owned job, not a machine-wide node sweep', async () => {
  const script = await readFile(scriptPath, 'utf8')
  // The job handle is authoritative for the backend chain and is disposed in the
  // same finally that stops the wrapper, so teardown must not enumerate every
  // node.exe on the machine on each exit (a WMI query that stalls under load).
  assert.doesNotMatch(script, /Get-CimInstance Win32_Process/)
  assert.doesNotMatch(script, /Test-OwnedGatewayProcess/)
  assert.match(script, /Stop-OwnedGateway -Process \$GatewayProcess\s*\} finally \{\s*if \(\$GatewayJob\) \{ \$GatewayJob\.Dispose\(\) \}/)
})

test('launcher starts every session in bypass permissions', async () => {
  const script = await readFile(scriptPath, 'utf8')
  // permissionSetup.ts makes bypass both available and the starting mode only
  // when the session launched with --dangerously-skip-permissions; the "as an
  // option" flag would leave the mode off by default. The decision is that all
  // gateway sessions start in bypass, so the launcher passes the mode flag and
  // must not write a settings defaultMode to achieve it.
  assert.match(script, /\$ClaudeArgs \+= '--dangerously-skip-permissions'/)
  assert.doesNotMatch(script, /'--allow-dangerously-skip-permissions'/)
  assert.doesNotMatch(script, /defaultMode\s*=\s*'bypassPermissions'/)
})

test('partner prewarm has one finite launch-path budget', async () => {
  const policy = JSON.parse(await readFile(new URL('./launcher-policy.json', import.meta.url), 'utf8'))
  assert.ok(Number.isSafeInteger(policy.prewarmTimeoutMs))
  assert.ok(policy.prewarmTimeoutMs > 0 && policy.prewarmTimeoutMs <= 300000)
})

test('prewarm builds without a session and does not consume caller stdin', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gateway-prewarm-'))
  try {
    await mkdir(path.join(root, 'scripts'))
    await mkdir(path.join(root, 'src'))
    const launcher = await readFile(scriptPath, 'utf8')
    await writeFile(path.join(root, 'scripts', 'cc.ps1'), launcher.replace(
      "  Write-LaunchDiagnostic 'prewarm-exit'",
      "  [IO.File]::WriteAllText((Join-Path $Root 'remaining-input'), [Console]::In.ReadToEnd())\n  Write-LaunchDiagnostic 'prewarm-exit'",
    ))
    await copyFile(new URL('./effort-capabilities.json', import.meta.url), path.join(root, 'scripts', 'effort-capabilities.json'))
    await writeFile(path.join(root, 'src', 'input.ts'), 'export {}')
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { build: 'bun scripts/build.ts' } }))
    await writeFile(path.join(root, 'scripts', 'build.ts'), `
      import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
      const input = readFileSync(0, 'utf8');
      if (input !== '' && input !== '\\uFEFF') throw new Error('Build stdin: ' + JSON.stringify(input));
      mkdirSync('dist', { recursive: true });
      writeFileSync('dist/cli.js', 'throw new Error("Harness must not launch")');
      appendFileSync('build-count', '1');
    `)
    const env = { ...process.env, CC_RAW_ARGS: '--prewarm', CC_CLAUDE_RUNNER_OVERRIDE: process.execPath,
      LOCALAPPDATA: root, USERPROFILE: path.join(root, 'missing-home') }
    delete env.CC_CLAUDE_SCRIPT_OVERRIDE
    delete env.TANDEM_GATEWAY_CODEX_HOME
    const fixturePath = path.join(root, 'scripts', 'cc.ps1')
    const fixture = await readFile(fixturePath, 'utf8')
    await writeFile(fixturePath, fixture
      .replace('$startInfo.RedirectStandardInput = $true', '$startInfo.RedirectStandardInput = $false')
      .replace('$buildProcess.StandardInput.BaseStream.Close()', ''))
    const red = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fixturePath], {
      env, input: 'caller prompt must survive', encoding: 'utf8', timeout: 30000,
    })
    assert.equal(red.status, 1)
    assert.match(red.stderr, /Build stdin:.*caller prompt must survive/)
    await writeFile(fixturePath, fixture)
    for (let i = 0; i < 2; i++) {
      const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'cc.ps1')], {
        env, input: 'caller prompt must survive', encoding: 'utf8', timeout: 30000,
      })
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
      assert.equal(await readFile(path.join(root, 'remaining-input'), 'utf8'), 'caller prompt must survive')
    }
    assert.equal(await readFile(path.join(root, 'build-count'), 'utf8'), '1')
    const events = (await readFile(path.join(root, 'Gateway', 'launcher.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(events.filter(event => event.event === 'prewarm-exit').length, 2)
    assert.equal(events.some(event => event.event === 'harness-exit'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('interactive cc avoids the Defender-blocked nested encoded launcher', async () => {
  const script = await readFile(scriptPath, 'utf8')
  assert.equal(script.includes('$NestedEncoded'), false)
  assert.doesNotMatch(
    script,
    /\$KeysafeCommand\s*=\s*['"]& powershell\.exe[\s\S]*-EncodedCommand/,
  )
  // Bundled mode spawns the supervisor plain. The external branch injects
  // through one keysafe run-many child, named as argv -File items rather than
  // a nested -EncodedCommand.
  assert.match(
    script,
    /'-File'\s*\r?\n\s*\$Keysafe\s*\r?\n\s*'run-many'/,
    'each optional credential should be injected by invoking keysafe directly in the existing child',
  )
  // Every optional provider must be wrapped the same way, and the env-var name
  // must come from the provider table rather than being hardcoded per provider,
  // so adding a provider cannot silently skip its key injection.
  assert.match(
    script,
    /\$OptionalKeyProviders\s*=\s*\$OpenCodeProviders\s*\+\s*@\([\s\S]*Credential\s*=\s*'amd-ds'[\s\S]*\)/,
    'optional providers should be declared in one table',
  )
})

test('launcher injects every numbered OpenCode workspace credential', async () => {
  const script = await readFile(scriptPath, 'utf8')
  assert.match(script, /Get-ChildItem[^\n]*-Filter 'opencode-go\*\.cred'/)
  assert.match(script, /Sort-Object/)
  assert.match(script, /Credential = \$_.BaseName; EnvVar = \('OPENCODE_API_KEY' \+ \$suffix\)/)
  assert.doesNotMatch(script, /\$OpenCodeCredential = if/)
})

test('launcher honors the picker-written default model below explicit overrides', async () => {
  const script = await readFile(scriptPath, 'utf8')
  assert.match(
    script,
    /Join-Path \$env:USERPROFILE '\.claude\\gateway-default-model\.txt'/,
    'the stored default must live in the location the picker writes',
  )
  // Priority: MODEL_GATEWAY_DEFAULT (cc-* wrappers) then stored default then
  // the built-in. --model is applied later and overrides both.
  assert.match(
    script,
    /\$RequestedModel = if \(\$env:MODEL_GATEWAY_DEFAULT\) \{[\s\S]*?\} elseif \(\$StoredDefaultModel\) \{[\s\S]*?\} else \{\s*'gateway-gpt-luna'\s*\}/,
    'the stored default must sit between the env override and the built-in',
  )
  assert.match(
    script,
    /if \(\$StoredDefaultModel -notlike 'gateway-\*'\) \{\s*\$StoredDefaultModel = \$null\s*\}/,
    'a non-gateway id in the state file must not reach the launcher',
  )
})

test('launcher re-sorts the catalog by the picker-written reorder', async () => {
  const script = await readFile(scriptPath, 'utf8')
  assert.match(
    script,
    /Join-Path \$env:USERPROFILE '\.claude\\gateway-model-order\.json'/,
    'the stored order must live in the location the picker writes',
  )
  // The order has to be applied between the catalog read and the export,
  // because the export is what the picker renders its order from.
  assert.match(
    script,
    /\$GatewayModelOptions = @\(\$CapabilityCatalog\.gatewayModelOptions\)[\s\S]*\$env:MODEL_GATEWAY_MODEL_OPTIONS = \(\$GatewayModelOptions \| ConvertTo-Json -Compress\)/,
    'the stored order must be applied before the catalog is exported',
  )
  assert.match(
    script,
    /if \(-not \$OptionsByValue\.ContainsKey\(\$ModelId\)\) \{ continue \}/,
    'ids the catalog cannot serve must be dropped rather than injected',
  )
  assert.match(
    script,
    /if \(\$LeadingOptions\.Count -gt 0\) \{/,
    'an empty or unusable stored order must leave the catalog untouched',
  )
})

test('the model picker moves a model to the top on t and reorders it on r', async () => {
  const bindings = await readFile(
    new URL('../src/keybindings/defaultBindings.ts', import.meta.url),
    'utf8',
  )
  const schema = await readFile(
    new URL('../src/keybindings/schema.ts', import.meta.url),
    'utf8',
  )
  const picker = await readFile(
    new URL('../src/components/ModelPicker.tsx', import.meta.url),
    'utf8',
  )
  const selectInput = await readFile(
    new URL('../src/components/CustomSelect/use-select-input.ts', import.meta.url),
    'utf8',
  )
  assert.match(
    bindings,
    /context: 'ModelPicker',\s*bindings: \{[\s\S]*?t: 'modelPicker:moveToTop'[\s\S]*?r: 'modelPicker:liftReorder'/,
    't and r must resolve inside the picker context',
  )
  assert.match(
    bindings,
    /up: 'modelPicker:moveUp',\s*down: 'modelPicker:moveDown',\s*escape: 'modelPicker:cancelReorder'/,
    'the arrows and escape must be the picker\'s while a row is lifted',
  )
  for (const action of [
    'modelPicker:moveToTop',
    'modelPicker:liftReorder',
    'modelPicker:moveUp',
    'modelPicker:moveDown',
    'modelPicker:cancelReorder',
  ]) {
    assert.ok(
      schema.includes(`'${action}'`),
      `${action} must be a declared action`,
    )
  }
  assert.match(picker, /"modelPicker:moveToTop": \(\) => \{/)
  assert.match(picker, /"modelPicker:liftReorder": \(\) => \{/)
  // Every reordering path persists through the same helper, so a move the
  // screen shows is a move the next launch reads.
  assert.match(picker, /await persistModelOrder\(next, setNotice\)/)
  assert.match(picker, /await writeGatewayModelOrder\(ids\)/)
  assert.match(
    picker,
    /setNotice\("Could not save the model order\."\)/,
    'a failed write must say so instead of reading as a saved order',
  )
  // The arrows and escape belong to the picker only while a row is lifted, so
  // ordinary navigation and Escape-to-exit are untouched the rest of the time.
  assert.match(picker, /\.\.\.\(lifted \? \{/)
  assert.match(
    picker,
    /const navigationSuspended = lifted !== null;/,
    'the Select must be suspended exactly while a row is lifted',
  )
  assert.match(
    selectInput,
    /if \(!navigationSuspended\) \{\s*handlers\['select:next'\]/,
    'a suspended Select must drop its own navigation and cancel bindings',
  )
})

test('an explicit --effort the model lacks fails at launch instead of at request time', async () => {
  const script = await readFile(new URL('./cc.ps1', import.meta.url), 'utf8')
  assert.match(script, /function Assert-GatewayEffortSupported \{/)
  assert.match(
    script,
    /if \(\$levels -notcontains \$Effort\) \{\s*throw "Effort '\$Effort' is not supported by \$Model\. Supported: \$\(\$levels -join ', '\), ultracode"\s*\}/,
    'an unsupported explicit effort must be refused, naming the values that work',
  )
  assert.match(
    script,
    /if \(\$EffortWasExplicit -and -not \[string\]::IsNullOrWhiteSpace\(\$Effort\)\) \{\s*Assert-GatewayEffortSupported -Model \$Model -Effort \$Effort\s*\}/,
    'validation must run only for an explicit effort, before the ladder default is applied',
  )
  // The default resolution must stay read-only: a stored/generated default is
  // chosen from the ladder, so it can never need validation.
  assert.match(
    script,
    /elseif \(\[string\]::IsNullOrWhiteSpace\(\$Effort\)\) \{\s*\$Effort = Resolve-DefaultGatewayEffort -Value \$Model\s*\}/,
  )
})

test('the picker pins a per-model default effort the launcher and harness both read', async () => {
  const script = await readFile(new URL('./cc.ps1', import.meta.url), 'utf8')
  const bindings = await readFile(
    new URL('../src/keybindings/defaultBindings.ts', import.meta.url),
    'utf8',
  )
  const schema = await readFile(
    new URL('../src/keybindings/schema.ts', import.meta.url),
    'utf8',
  )
  const picker = await readFile(
    new URL('../src/components/ModelPicker.tsx', import.meta.url),
    'utf8',
  )
  // The launcher reads the same file the picker's `e` writes, so a pin made in
  // one session reaches the next launch.
  assert.match(
    script,
    /Join-Path \$env:USERPROFILE '\.claude\\gateway-effort-defaults\.json'/,
    'the pinned defaults must live in the location the picker writes',
  )
  // A pin the model cannot take is ignored, exactly as the harness ignores it,
  // so a stale pin can never start a session on a level it rejects.
  assert.match(
    script,
    /\$pinned = \$PinnedEffortDefaults\[\$Value\]\s*if \(\$pinned -and \(\$levels -contains \$pinned\)\) \{\s*return \[string\]\$pinned\s*\}/,
    'a valid pin must be preferred over the ladder default',
  )
  // The map is exported so the harness resolves `auto` to the same level the
  // launcher started the session on, without a relaunch.
  assert.match(
    script,
    /\$env:MODEL_GATEWAY_EFFORT_DEFAULTS = if \(\$PinnedEffortDefaults\.Count -gt 0\) \{/,
    'the pinned map must reach the harness through the environment',
  )
  // The pin key is the picker's `e`, declared as an action and bound in the
  // ModelPicker context beside `f`.
  assert.match(
    bindings,
    /f: 'modelPicker:setDefault',\s*e: 'modelPicker:pinEffort',/,
    'e must sit beside f in the ModelPicker context',
  )
  assert.ok(
    schema.includes("'modelPicker:pinEffort'"),
    'modelPicker:pinEffort must be a declared action',
  )
  assert.match(picker, /"modelPicker:pinEffort": \(\) => \{/)
  assert.match(picker, /await pinGatewayEffort\(model, target\)/)
  assert.match(picker, /await pinGatewayEffort\(model, null\)/)
})

test('the Command Code provider gets its key injected through the same table', async () => {
  const script = await readFile(scriptPath, 'utf8')
  assert.match(
    script,
    /Credential = 'commandcode'; EnvVar = 'COMMANDCODE_API_KEY'/,
    'Command Code must be an optional keysafe provider',
  )
})

test('the model picker promotes the focused model to the launch default on f', async () => {
  const bindings = await readFile(
    new URL('../src/keybindings/defaultBindings.ts', import.meta.url),
    'utf8',
  )
  const schema = await readFile(
    new URL('../src/keybindings/schema.ts', import.meta.url),
    'utf8',
  )
  const picker = await readFile(
    new URL('../src/components/ModelPicker.tsx', import.meta.url),
    'utf8',
  )
  assert.match(
    bindings,
    /context: 'ModelPicker',\s*bindings: \{[\s\S]*?f: 'modelPicker:setDefault'/,
    'f must resolve to the set-default action inside the picker context',
  )
  assert.match(schema, /'modelPicker:setDefault'/)
  assert.match(picker, /"modelPicker:setDefault": \(\) => \{/)
  assert.match(picker, /setGatewayDefaultModel\(target\)/)
})

test('interactive cc narrates its startup phases instead of staying blank', async () => {
  const script = await readFile(scriptPath, 'utf8')
  // Measured: the launcher writes nothing user-visible until the session paints
  // its first frame - the console is blank ~10s on a fresh launch and ~30s+ when
  // a rebuild runs. Without narration a slow launch is indistinguishable from
  // one that will never open ("cc just stays blank, no lines print").
  assert.match(script, /function Write-LaunchProgress \{/)
  assert.match(script, /if \(-not \$ShowLaunchProgress\) \{ return \}/)
  assert.match(script, /\$ShowLaunchProgress = -not \$PrintRequested/,
    'print mode must stay silent so callers see only harness output')
  assert.match(script, /Write-LaunchProgress 'the compiled harness is stale; rebuilding before launch\.\.\.'/)
  assert.match(script, /Write-LaunchProgress "starting the model gateway on port \$Port\.\.\."/)
  assert.match(script, /Write-LaunchProgress 'waiting for the model gateway to become healthy\.\.\.'/)
  assert.match(script, /Write-LaunchProgress 'launching the session\.\.\.'/)
})

test('the launch-path build is bounded so a hung build fails loudly', async () => {
  const script = await readFile(scriptPath, 'utf8')
  // An unbounded WaitForExit leaves a stuck build as a permanent blank console.
  assert.match(script, /WaitForExit\(600000\)/)
  assert.match(script, /Claude harness build did not finish within 10 minutes\./)
})

test('cc zenith resolves the role before launch and refuses a live holder', async () => {
  const script = await readFile(scriptPath, 'utf8')
  // The launcher resolves; the harness writes. A claim naming a launcher-side id
  // would keep reading as live after the chat behind it was gone, so the role is
  // taken at mount (useGatewaySession.ts) and the launcher only checks it here.
  assert.match(script, /\[string\]\$ClaudeArgs\[0\] -eq 'zenith'/)
  // The claim is read from the session's config home, the same one zenithRole
  // uses, so the launcher and the session cannot disagree about who holds it.
  assert.match(script, /\$env:CLAUDE_CONFIG_DIR/)
  assert.match(script, /Join-Path \$ZenithConfigHome 'zenith\.json'/)
  assert.match(script, /\$env:CC_ZENITH = '1'/)
  assert.match(script, /\$env:CC_ZENITH_MODE = 'take'/)
  assert.match(script, /\$env:CC_ZENITH_PURPOSE = \$ZenithPurpose/)
  // Displacing a live holder is the user's decision, not a launch side effect.
  assert.match(
    script,
    /cc zenith: the role is held by \$ZenithSession, which is still running\./,
    'a live holder must be named and refused, never silently displaced',
  )
  // The harness side, where the session id is real. Both mounts must take the
  // claim, or the verb works in a REPL and silently not in a headless run.
  const role = await readFile(new URL('../src/utils/zenithRole.ts', import.meta.url), 'utf8')
  assert.match(role, /export async function claimZenithFromLaunchEnv/)
  assert.match(role, /process\.env\.CC_ZENITH !== '1'/)
  assert.match(role, /force: process\.env\.CC_ZENITH_MODE === 'take'/)
  const hook = await readFile(new URL('../src/hooks/useGatewaySession.ts', import.meta.url), 'utf8')
  const headless = await readFile(new URL('../src/cli/print.ts', import.meta.url), 'utf8')
  assert.match(hook, /claimZenithFromLaunchEnv\(\)/)
  assert.match(headless, /claimZenithFromLaunchEnv\(\)/)
  assert.ok(
    hook.indexOf('claimZenithFromLaunchEnv()') > hook.indexOf('runtime.start(gatewayMessageIds'),
    'the interactive claim must be taken only after the registration lands',
  )
  assert.ok(
    headless.indexOf('claimZenithFromLaunchEnv()') > headless.indexOf('runtime.start(gatewayMessageIds'),
    'the headless claim must be taken only after the registration lands',
  )
})

test('cc login forwards the credential subcommand without session flags', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gateway-login-'))
  try {
    const runner = process.execPath
    await mkdir(path.join(root, 'scripts'))
    await mkdir(path.join(root, 'src'))
    await copyFile(new URL('./cc.ps1', import.meta.url), path.join(root, 'scripts', 'cc.ps1'))
    await copyFile(new URL('./cc-launcher.mjs', import.meta.url), path.join(root, 'scripts', 'cc-launcher.mjs'))
    await copyFile(new URL('./effort-capabilities.json', import.meta.url), path.join(root, 'scripts', 'effort-capabilities.json'))
    await writeFile(path.join(root, 'src', 'input.ts'), 'export {}')
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { build: 'bun scripts/build.ts' } }))
    await writeFile(path.join(root, 'scripts', 'build.ts'), 'export {}')
    // Presence checks run before the login branch in the POSIX launcher.
    await writeFile(path.join(root, 'scripts', 'model-gateway.mjs'), 'export {}')
    await writeFile(path.join(root, 'scripts', 'gateway-supervisor.mjs'), 'export {}')
    await mkdir(path.join(root, 'dist'))
    // Written last so the fake harness is fresher than every build input.
    await writeFile(path.join(root, 'dist', 'cli.js'), `
      const fs = require('node:fs');
      fs.writeFileSync(process.env.LOGIN_ARGV_LOG, JSON.stringify(process.argv.slice(2)));
    `)

    const envFor = log => {
      const env = { ...process.env, CC_CLAUDE_RUNNER_OVERRIDE: runner, LOCALAPPDATA: root,
        USERPROFILE: path.join(root, 'missing-home'), LOGIN_ARGV_LOG: log }
      delete env.CC_CLAUDE_SCRIPT_OVERRIDE
      delete env.TANDEM_GATEWAY_CODEX_HOME
      delete env.CC_RAW_ARGS
      return env
    }

    const psLog = path.join(root, 'ps-argv.json')
    const ps = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'cc.ps1')], {
      env: { ...envFor(psLog), CC_RAW_ARGS: 'login status' }, encoding: 'utf8', timeout: 60000,
    })
    assert.equal(ps.status, 0, `${ps.stdout}\n${ps.stderr}`)
    assert.deepEqual(JSON.parse(await readFile(psLog, 'utf8')), ['login', 'status'])

    const mjsLog = path.join(root, 'mjs-argv.json')
    const mjs = spawnSync(runner, [path.join(root, 'scripts', 'cc-launcher.mjs'), 'login', 'status'], {
      env: envFor(mjsLog), encoding: 'utf8', timeout: 60000,
    })
    assert.equal(mjs.status, 0, `${mjs.stdout}\n${mjs.stderr}`)
    assert.deepEqual(JSON.parse(await readFile(mjsLog, 'utf8')), ['login', 'status'])

    let events = []
    try { events = (await readFile(path.join(root, 'Gateway', 'launcher.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse) } catch {}
    assert.equal(events.some(event => event.event === 'gateway-spawn-start'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a gateway that dies on a missing keysafe record names that record', { skip: process.platform !== 'win32', timeout: 120000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gateway-missing-key-'))
  try {
    const home = path.join(root, 'home')
    const keysafeDir = path.join(home, '.claude', 'skills', 'keysafe', 'scripts')
    await mkdir(keysafeDir, { recursive: true })
    await mkdir(path.join(root, 'scripts'))
    await mkdir(path.join(root, 'src'))
    await mkdir(path.join(root, 'dist'))
    await mkdir(path.join(root, 'tmp'))
    await copyFile(new URL('./cc.ps1', import.meta.url), path.join(root, 'scripts', 'cc.ps1'))
    await copyFile(new URL('./owned-gateway-process.ps1', import.meta.url), path.join(root, 'scripts', 'owned-gateway-process.ps1'))
    await copyFile(new URL('./effort-capabilities.json', import.meta.url), path.join(root, 'scripts', 'effort-capabilities.json'))
    await writeFile(path.join(root, 'scripts', 'model-gateway.mjs'), 'export {}')
    await writeFile(path.join(root, 'scripts', 'gateway-supervisor.mjs'), 'export {}')
    await writeFile(path.join(root, 'scripts', 'build.ts'), 'export {}')
    await writeFile(path.join(root, 'src', 'input.ts'), 'export {}')
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { build: 'bun scripts/build.ts' } }))
    await writeFile(path.join(root, 'dist', 'cli.js'), 'throw new Error("the harness must not start")')
    await writeFile(path.join(keysafeDir, 'keysafe.ps1'), [
      'param([string]$Action, [string]$Inject, [string]$Command)',
      '[Console]::Error.WriteLine("no key named \'ds\' - capture it first")',
      'exit 1',
    ].join('\r\n'))

    const env = { ...process.env, GATEWAY_CREDENTIALS_MODE: 'external', CC_RAW_ARGS: 'hello',
      CC_CLAUDE_RUNNER_OVERRIDE: process.execPath, LOCALAPPDATA: root, USERPROFILE: home,
      TEMP: path.join(root, 'tmp'), TMP: path.join(root, 'tmp') }
    delete env.CC_CLAUDE_SCRIPT_OVERRIDE
    delete env.TANDEM_GATEWAY_CODEX_HOME

    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'cc.ps1')], {
      env, encoding: 'utf8', timeout: 60000,
    })
    assert.notEqual(result.status, 0)
    const noise = `${result.stdout}\n${result.stderr}`
    // The owned-process wrapper cannot always replay ExitCode; the point is
    // that the code is named rather than rendered as an empty parenthesis.
    assert.match(noise, /exited \(code (?:1|unknown)\)/, noise)
    assert.match(noise, /the 'ds' credential is missing from the legacy keysafe\s+store/, noise)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
