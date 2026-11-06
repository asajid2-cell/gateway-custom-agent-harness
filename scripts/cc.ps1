$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot

# An installed copy ships its own environment in install.env: the bundled vault
# and a vault directory that belongs to this copy. It is applied before the
# mode logic below, so an install never inherits the machine's legacy ~/.keysafe
# or another copy's credentials. Plain NAME=VALUE, no expansion.
$InstallEnv = Join-Path $Root 'install.env'
if (Test-Path -LiteralPath $InstallEnv) {
  foreach ($line in [IO.File]::ReadAllLines($InstallEnv)) {
    $trimmed = $line.Trim()
    if ($trimmed.Length -eq 0 -or $trimmed.StartsWith('#')) { continue }
    $eq = $trimmed.IndexOf('=')
    if ($eq -lt 1) { continue }
    $name = $trimmed.Substring(0, $eq).Trim()
    $value = $trimmed.Substring($eq + 1).Trim().Trim('"')
    if ($name -match '^[A-Za-z_][A-Za-z0-9_]*$') {
      [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }
  }
}

# The code default is the cleanroom bundled vault. A machine that already has
# the legacy keysafe store keeps using it: this launcher sets the explicit
# external flag itself, so an existing setup is unchanged while a fresh machine
# (no ~/.keysafe records) stays on the bundled default. Both the supervisor and
# the harness inherit the flag, so the gateway and the /login UI agree.
if ([string]::IsNullOrWhiteSpace($env:GATEWAY_CREDENTIALS_MODE)) {
  $LegacyKeysafeDir = Join-Path $env:USERPROFILE '.keysafe'
  $LegacyRecordCount = 0
  if (Test-Path -LiteralPath $LegacyKeysafeDir) {
    $LegacyRecordCount = @(Get-ChildItem -LiteralPath $LegacyKeysafeDir -Filter '*.cred' -ErrorAction SilentlyContinue).Count
  }
  if ($LegacyRecordCount -gt 0) { $env:GATEWAY_CREDENTIALS_MODE = 'external' }
}
# No legacy store and no explicit flag is the cleanroom default. Set it
# explicitly rather than leaving it unset, so every child sees a resolved mode
# and no branch can read "unset" as "external".
if ([string]::IsNullOrWhiteSpace($env:GATEWAY_CREDENTIALS_MODE)) {
  $env:GATEWAY_CREDENTIALS_MODE = 'bundled'
}

$LaunchDirectory = (Get-Location).Path
$DiagnosticPath = Join-Path $env:LOCALAPPDATA 'Gateway\launcher.jsonl'
function Write-LaunchDiagnostic {
  param([string]$Event, [hashtable]$Fields = @{})
  try {
    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $DiagnosticPath))
    # Never include arguments, environment values, prompts, or exception text.
    $record = @{ time = [DateTime]::UtcNow.ToString('o'); pid = $PID; event = $Event }
    foreach ($key in @('exitCode', 'attempt', 'port', 'errorType', 'elapsedMs')) {
      if ($Fields.ContainsKey($key)) { $record[$key] = $Fields[$key] }
    }
    if ((Test-Path -LiteralPath $DiagnosticPath) -and (Get-Item -LiteralPath $DiagnosticPath).Length -gt 1048576) {
      Move-Item -LiteralPath $DiagnosticPath -Destination "$DiagnosticPath.previous" -Force
    }
    [IO.File]::AppendAllText($DiagnosticPath, (($record | ConvertTo-Json -Compress) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
  } catch {
    # Diagnostics must never prevent launch or hide the original failure.
  }
}
$ShowLaunchProgress = $false
function Write-LaunchProgress {
  param([string]$Message)

  # An interactive launch does real work before the session paints its first
  # frame: it may rebuild the harness, spawn the gateway, and wait for health.
  # Until now none of that wrote a byte the user could see, so the console was
  # blank for the whole startup (~10s fresh, ~30s when a rebuild runs) and a slow
  # or stalled launch was indistinguishable from one that would never open -
  # the reported "cc just stays blank, no lines print, nothing ever opens".
  # Print mode stays silent so callers and fixtures see only harness output.
  if (-not $ShowLaunchProgress) { return }
  try {
    [Console]::Error.WriteLine("cc: $Message")
  } catch {
    # Progress must never prevent the launch it is describing.
  }
}
Write-LaunchDiagnostic 'launch-start'
$GatewayScript = Join-Path $PSScriptRoot 'model-gateway.mjs'
$GatewaySupervisor = Join-Path $PSScriptRoot 'gateway-supervisor.mjs'
$CodexAccountsRoot = Join-Path $env:USERPROFILE '.codex-accounts'
$CodexSelectionPath = Join-Path $CodexAccountsRoot 'current.txt'
$DefaultCodexHome = Join-Path $env:USERPROFILE '.codex'
$TandemCodexHome = if ($env:TANDEM_GATEWAY_CODEX_HOME) {
  $env:TANDEM_GATEWAY_CODEX_HOME
} else {
  ''
}
$ClaudeRunner = if ($env:CC_CLAUDE_RUNNER_OVERRIDE) {
  $env:CC_CLAUDE_RUNNER_OVERRIDE
} elseif (Test-Path -LiteralPath (Join-Path $Root 'runtime\bun.exe') -PathType Leaf) {
  # A packaged artifact carries its own runtime, so an install needs no bun.
  Join-Path $Root 'runtime\bun.exe'
} else {
  (Get-Command bun.exe -ErrorAction Stop).Source
}
$ClaudeScript = if ($env:CC_CLAUDE_SCRIPT_OVERRIDE) {
  [IO.Path]::GetFullPath($env:CC_CLAUDE_SCRIPT_OVERRIDE)
} else {
  Join-Path $Root 'dist\cli.js'
}

function Resolve-SelectedCodexHome {
  if (-not [string]::IsNullOrWhiteSpace($TandemCodexHome)) {
    $selectedHome = [IO.Path]::GetFullPath($TandemCodexHome)
    if (-not (Test-Path -LiteralPath $selectedHome -PathType Container)) {
      throw "Tandem Gateway account home does not exist: $selectedHome"
    }
    return $selectedHome
  }

  $account = 'default'
  if (Test-Path -LiteralPath $CodexSelectionPath -PathType Leaf) {
    $account = (Get-Content -Raw -LiteralPath $CodexSelectionPath).Trim()
  }
  if ([string]::IsNullOrWhiteSpace($account) -or $account -eq 'default') {
    # The default home is where `codex login` will create the account. On a
    # clean machine it does not exist yet, and that is not an error.
    return $DefaultCodexHome
  } elseif ($account -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') {
    throw "Invalid selected Codex account name: $account"
  } else {
    $selectedHome = Join-Path $CodexAccountsRoot $account
  }
  if (-not (Test-Path -LiteralPath $selectedHome -PathType Container)) {
    throw "Selected Codex account home does not exist: $selectedHome"
  }
  return $selectedHome
}

# cc can be started from an old shell or a resumed terminal. A Tandem lane may
# pin an explicit account through TANDEM_GATEWAY_CODEX_HOME; ordinary launches
# still resolve the current account at launch time instead of trusting stale
# inherited CODEX_HOME.
$Keysafe = Join-Path $env:USERPROFILE '.claude\skills\keysafe\scripts\keysafe.ps1'
# The model picker's `f` shortcut writes the last model the user chose to make
# the default; MODEL_GATEWAY_DEFAULT (set by the cc-* launcher wrappers) and an
# explicit --model both still outrank it.
$GatewayDefaultModelPath = Join-Path $env:USERPROFILE '.claude\gateway-default-model.txt'
$StoredDefaultModel = $null
if (Test-Path -LiteralPath $GatewayDefaultModelPath -PathType Leaf) {
  $StoredDefaultModel = (Get-Content -Raw -LiteralPath $GatewayDefaultModelPath).Trim()
  if ($StoredDefaultModel -notlike 'gateway-*') {
    $StoredDefaultModel = $null
  }
}
$RequestedModel = if ($env:MODEL_GATEWAY_DEFAULT) {
  $env:MODEL_GATEWAY_DEFAULT
} elseif ($StoredDefaultModel) {
  $StoredDefaultModel
} else {
  'gateway-gpt-luna'
}
$EffortWasExplicit = -not [string]::IsNullOrWhiteSpace($env:MODEL_GATEWAY_EFFORT)
$ModelAliases = @{}
foreach ($canonical in $CapabilityCatalog.gatewayModelAliases.PSObject.Properties) {
  foreach ($alias in @($canonical.Value)) {
    if (-not [string]::IsNullOrWhiteSpace([string]$alias)) {
      $ModelAliases[[string]$alias] = [string]$canonical.Name
    }
  }
}

function Resolve-GatewayModel {
  param([string]$Value)

  if ($ModelAliases.ContainsKey($Value)) {
    return $ModelAliases[$Value]
  }
  if ($Value -like 'claude-opencode-*') {
    return 'gateway-opencode-' + $Value.Substring('claude-opencode-'.Length)
  }
  if ($Value -like 'opencode-go/*') {
    return 'gateway-opencode-' + $Value.Substring('opencode-go/'.Length)
  }
  return $Value
}
$Model = Resolve-GatewayModel -Value $RequestedModel

# Each Gateway model implements only its provider-native effort ladder. Pick
# the launch default from that ladder so a fresh session starts on a level the
# provider accepts, rather than a non-native value that silently clamps at send
# time. Models with no native ladder get no --effort at all.
function Get-GatewayEffortLevels {
  param([string]$Value)

  foreach ($alias in $CapabilityCatalog.gatewayAliases.PSObject.Properties) {
    if ($alias.Name -ieq $Value) {
      return @($alias.Value)
    }
  }
  return @()
}

function Resolve-DefaultGatewayEffort {
  param([string]$Value)

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return $null
  }
  $levels = Get-GatewayEffortLevels -Value $Value
  if ($levels.Count -eq 0) {
    return $null
  }
  # A per-model pin (the picker's `e`) is the default for that model, so a fresh
  # launch starts on the level the user chose rather than the ladder's built-in.
  # A pin the model cannot take is ignored here, exactly as the harness ignores
  # it, so a stale pin can never start a session on a level it rejects.
  $pinned = $PinnedEffortDefaults[$Value]
  if ($pinned -and ($levels -contains $pinned)) {
    return [string]$pinned
  }
  if ($levels -contains 'medium') {
    return 'medium'
  }
  if ($levels -contains 'high') {
    return 'high'
  }
  return [string]$levels[0]
}

# An explicit --effort that the model does not implement is refused at launch.
# Letting it through would store a level the request path has to drop or, worse,
# would have silently run a different level than the one typed.
function Assert-GatewayEffortSupported {
  param([string]$Model, [string]$Effort)

  if ([string]::IsNullOrWhiteSpace($Effort) -or $Effort -ieq 'ultracode') {
    return
  }
  $levels = Get-GatewayEffortLevels -Value $Model
  if ($levels.Count -eq 0) {
    throw "Model $Model takes no effort parameter, so --effort $Effort cannot be applied."
  }
  if ($levels -notcontains $Effort) {
    throw "Effort '$Effort' is not supported by $Model. Supported: $($levels -join ', '), ultracode"
  }
}

$Effort = if ($env:MODEL_GATEWAY_EFFORT) { $env:MODEL_GATEWAY_EFFORT } else { $null }
$KeepGatewayLogs = $env:MODEL_GATEWAY_KEEP_LOGS -eq '1'
$GatewayToken = 'local-gateway'
$ClaudeArgs = @($args)

# `cc zenith` starts the session as the interface plane (zenithRole.ts). The
# launcher only *resolves* here: the role is written by the harness at mount,
# where the session id is real - a claim naming a launcher-side id would keep
# reading as live after the chat behind it was gone. So this runs before any
# gateway work, says what it found, and refuses to start a second Zenith when
# one is already running. The refusal is the point of the role: displacing a
# live holder is the user's decision, not a side effect of launching a session.
# Placed above the capability catalog and model resolution so `--status` and a
# refusal cost nothing but a file read, and no gateway is ever spawned for them.
if ($ClaudeArgs.Count -gt 0 -and [string]$ClaudeArgs[0] -eq 'zenith') {
  $ZenithRest = @($ClaudeArgs | Select-Object -Skip 1)
  $ZenithMode = 'claim'
  $ZenithPurpose = ''
  $ZenithPassThrough = @()
  for ($zi = 0; $zi -lt $ZenithRest.Count; $zi++) {
    $zarg = [string]$ZenithRest[$zi]
    switch -Regex ($zarg) {
      '^--status$' { $ZenithMode = 'status'; continue }
      '^--take$'   { $ZenithMode = 'take';   continue }
      '^--share$'  { $ZenithMode = 'share';  continue }
      '^--purpose$' {
        if ($zi + 1 -ge $ZenithRest.Count) { throw 'cc zenith: --purpose needs a value.' }
        $zi++
        $ZenithPurpose = [string]$ZenithRest[$zi]
        continue
      }
      '^--purpose=(.*)$' { $ZenithPurpose = $Matches[1]; continue }
      default { $ZenithPassThrough += $zarg }
    }
  }
  # The claim lives in the *session's* config home, which is what zenithRole
  # reads and writes (getClaudeConfigHomeDir honors CLAUDE_CONFIG_DIR). Reading
  # the user's home instead would let the launcher refuse a launch over a claim
  # the session it is about to start will never see - and, worse, could read a
  # live holder that the session's own home shows as free. One config home, one
  # answer, whichever one the session actually runs in.
  $ZenithConfigHome = if ([string]::IsNullOrWhiteSpace($env:CLAUDE_CONFIG_DIR)) {
    Join-Path $env:USERPROFILE '.claude'
  } else {
    $env:CLAUDE_CONFIG_DIR
  }
  $ZenithClaimFile = Join-Path $ZenithConfigHome 'zenith.json'
  $ZenithHeld = $false
  $ZenithSession = ''
  $ZenithAlive = $false
  if (Test-Path -LiteralPath $ZenithClaimFile -PathType Leaf) {
    try {
      $zclaim = Get-Content -Raw -LiteralPath $ZenithClaimFile | ConvertFrom-Json
      if ($zclaim -and -not [string]::IsNullOrWhiteSpace([string]$zclaim.zenithSessionId)) {
        $ZenithHeld = $true
        $ZenithSession = [string]$zclaim.zenithSessionId
        # A pid whose process is gone is not a holder: a dead host's claim must
        # not strand the role forever. Only the pid is checked here - the current
        # holder's process is never running on this machine, so the check is
        # deliberately the same conservative one zenithRole uses on Windows.
        $ZenithAlive = $null -ne (Get-Process -Id ([int]$zclaim.pid) -ErrorAction SilentlyContinue)
      }
    } catch {
      # An unreadable claim reads as absent, the same safe direction the module
      # takes - a corrupt pointer must not make the role permanently untakeable.
    }
  }
  if ($ZenithMode -eq 'status') {
    if (-not $ZenithHeld) { [Console]::Out.WriteLine('Zenith is unheld; a session can take the role.') }
    elseif ($ZenithAlive) { [Console]::Out.WriteLine("Zenith is held by $ZenithSession, which is still running.") }
    else { [Console]::Out.WriteLine("Zenith is held by $ZenithSession, whose process is gone; cc zenith would replace it.") }
    exit 0
  }
  if ($ZenithMode -eq 'share') {
    # Another body alongside a running Zenith. It joins the bus as an ordinary
    # session and does not take the role, so it can be messaged and can work
    # under the holder without a second claim contesting the first.
    $ZenithMode = 'none'
  } elseif ($ZenithHeld -and $ZenithAlive -and $ZenithMode -ne 'take') {
    throw "cc zenith: the role is held by $ZenithSession, which is still running. Displacing a live Zenith is your decision, not a launch side effect - end it, run 'cc zenith --take' to replace it, or 'cc zenith --share' to work alongside it."
  }
  if ($ZenithMode -ne 'none') {
    if ($ZenithHeld -and -not $ZenithAlive) { Write-Host "cc zenith: replacing the claim of $ZenithSession, whose process is gone." }
    $env:CC_ZENITH = '1'
    if ($ZenithMode -eq 'take') { $env:CC_ZENITH_MODE = 'take' }
    if (-not [string]::IsNullOrWhiteSpace($ZenithPurpose)) { $env:CC_ZENITH_PURPOSE = $ZenithPurpose }
  }
  $ClaudeArgs = @($ZenithPassThrough)
}

$CapabilityCatalogPath = Join-Path $Root 'scripts\effort-capabilities.json'
if (-not (Test-Path -LiteralPath $CapabilityCatalogPath -PathType Leaf)) {
  throw "Effort capability catalog is missing: $CapabilityCatalogPath"
}
$CapabilityCatalog = Get-Content -Raw -LiteralPath $CapabilityCatalogPath |
  ConvertFrom-Json
# Stage stamps make a slow launch tell us which step it stalled in, instead of
# leaving a blank console and an unattributable multi-minute gap.
Write-LaunchDiagnostic 'config-read'

# The picker's `e` writes per-model default effort levels to this file. The
# launch default for the starting model is read from it so a fresh session
# starts on the level the user pinned, and the map is exported below so the
# harness resolves `auto` to the same level without a relaunch.
$GatewayEffortDefaultsPath = Join-Path $env:USERPROFILE '.claude\gateway-effort-defaults.json'
$PinnedEffortDefaults = @{}
if (Test-Path -LiteralPath $GatewayEffortDefaultsPath -PathType Leaf) {
  try {
    $StoredEffortDefaults = Get-Content -Raw -LiteralPath $GatewayEffortDefaultsPath |
      ConvertFrom-Json
    foreach ($entry in $StoredEffortDefaults.PSObject.Properties) {
      if (
        $entry.Value -is [string] -and
        -not [string]::IsNullOrWhiteSpace([string]$entry.Value)
      ) {
        $PinnedEffortDefaults[[string]$entry.Name] = [string]$entry.Value
      }
    }
  } catch {
    # A malformed file must not break launch; it reads as no pins.
    $PinnedEffortDefaults = @{}
  }
}

$GatewayProcess = $null
$GatewayJob = $null
$StdoutLog = $null
$StderrLog = $null
$ScopedSettingsPath = $null
$ExitCode = 1
$PreserveGatewayLogs = $false

function ConvertFrom-WindowsCommandLine {
  param([string]$CommandLine)

  if (-not ('CcCommandLine.NativeMethods' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace CcCommandLine {
  public static class NativeMethods {
    [DllImport("shell32.dll", SetLastError = true)]
    public static extern IntPtr CommandLineToArgvW(
      [MarshalAs(UnmanagedType.LPWStr)] string commandLine,
      out int argumentCount
    );

    [DllImport("kernel32.dll")]
    public static extern IntPtr LocalFree(IntPtr memory);
  }
}
'@
  }

  if ([string]::IsNullOrWhiteSpace($CommandLine)) {
    return @()
  }

  $argumentCount = 0
  $argumentVector = [CcCommandLine.NativeMethods]::CommandLineToArgvW(
    ('cc.exe ' + $CommandLine),
    [ref]$argumentCount
  )
  if ($argumentVector -eq [IntPtr]::Zero) {
    throw 'Could not parse Claude command-line arguments.'
  }

  try {
    $parsed = New-Object string[] $argumentCount
    for ($i = 0; $i -lt $argumentCount; $i++) {
      $argumentPointer = [Runtime.InteropServices.Marshal]::ReadIntPtr(
        $argumentVector,
        $i * [IntPtr]::Size
      )
      $parsed[$i] = [Runtime.InteropServices.Marshal]::PtrToStringUni($argumentPointer)
    }
    if ($parsed.Length -le 1) {
      return @()
    }
    return @($parsed | Select-Object -Skip 1)
  } finally {
    [void][CcCommandLine.NativeMethods]::LocalFree($argumentVector)
  }
}

if (Test-Path Env:CC_RAW_ARGS) {
  $ClaudeArgs = @(ConvertFrom-WindowsCommandLine -CommandLine $env:CC_RAW_ARGS)
}

function Get-NewestWriteTimeUtc {
  param([string[]]$Paths)

  # Read mtimes straight from the filesystem. Get-ChildItem builds a FileInfo and
  # a PSObject for every file, then Measure-Object walks that whole list again;
  # on this tree that is ~690ms against ~77ms for the same walk through
  # [IO.Directory]::EnumerateFiles, and it runs before the gateway is spawned.
  # src/ holds no reparse points, so the recursive enumeration cannot loop.
  $newest = [DateTime]::MinValue
  foreach ($path in $Paths) {
    if ([IO.Directory]::Exists($path)) {
      foreach ($file in [IO.Directory]::EnumerateFiles($path, '*', [IO.SearchOption]::AllDirectories)) {
        $written = [IO.File]::GetLastWriteTimeUtc($file)
        if ($written -gt $newest) { $newest = $written }
      }
    } elseif ([IO.File]::Exists($path)) {
      $written = [IO.File]::GetLastWriteTimeUtc($path)
      if ($written -gt $newest) { $newest = $written }
    }
  }
  return $newest
}

function Test-ClaudeArtifactFresh {
  if (-not (Test-Path -LiteralPath $ClaudeScript -PathType Leaf)) { return $false }
  $buildInputs = @(
    (Join-Path $Root 'src'),
    (Join-Path $Root 'scripts\build.ts'),
    (Join-Path $Root 'scripts\effort-capabilities.json'),
    (Join-Path $Root 'scripts\effort-capabilities.mjs'),
    (Join-Path $Root 'package.json'),
    (Join-Path $Root 'bun.lock'),
    (Join-Path $Root 'bun.lockb'),
    (Join-Path $Root 'tsconfig.json')
  )
  $latestInput = Get-NewestWriteTimeUtc -Paths $buildInputs
  if ($latestInput -eq [DateTime]::MinValue) { return $false }
  return (Get-Item -LiteralPath $ClaudeScript).LastWriteTimeUtc -ge $latestInput
}

function Initialize-ClaudeArtifact {
  # A packaged tree carries the compiled artifact and no build inputs. Archive
  # tools may rewrite manifest mtimes so package.json/bun.lock look newer than
  # dist/cli.js; rebuilding there would fail with no src/ to build. Only a tree
  # with the build sources may decide the artifact is stale.
  $buildTool = Join-Path $Root 'scripts\build.ts'
  $sourceTree = Join-Path $Root 'src'
  if (-not (Test-Path -LiteralPath $buildTool) -or -not (Test-Path -LiteralPath $sourceTree)) {
    if (-not (Test-Path -LiteralPath $ClaudeScript -PathType Leaf)) {
      throw "The compiled harness is missing: $ClaudeScript"
    }
    return
  }
  if (-not (Test-ClaudeArtifactFresh)) {
    if ($env:CC_CLAUDE_SCRIPT_OVERRIDE) {
      throw 'Selected candidate is missing or stale; build it explicitly before launch.'
    }
    Write-LaunchProgress 'the compiled harness is stale; rebuilding before launch...'
    Write-LaunchDiagnostic 'build-start'
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $ClaudeRunner
    $startInfo.Arguments = 'run build'
    $startInfo.WorkingDirectory = $Root
    $startInfo.UseShellExecute = $false
    # A build must not inherit and consume a print-mode caller's prompt stream.
    $startInfo.RedirectStandardInput = $true
    $buildProcess = [Diagnostics.Process]::new()
    $buildProcess.StartInfo = $startInfo
    try {
      [void]$buildProcess.Start()
      $buildProcess.StandardInput.BaseStream.Close()
      # Bounded: a build that never finishes must fail loudly instead of leaving
      # the console blank forever with no output - the same "cc never opens"
      # symptom the progress line above exists to make visible.
      if (-not $buildProcess.WaitForExit(600000)) {
        try { $buildProcess.Kill() } catch {}
        Write-LaunchDiagnostic 'build-exit' @{ exitCode = -1 }
        throw 'Claude harness build did not finish within 10 minutes.'
      }
      $buildExitCode = $buildProcess.ExitCode
    } finally {
      $buildProcess.Dispose()
    }
    Write-LaunchDiagnostic 'build-exit' @{ exitCode = $buildExitCode }
    if ($buildExitCode -ne 0) {
      throw "Claude harness build failed with exit code $buildExitCode."
    }
  }
}

# Prewarm exits before account selection, credentials, services, or the harness.
if ($ClaudeArgs -contains '--prewarm') {
  if ($ClaudeArgs.Count -ne 1) { throw '--prewarm must be used alone.' }
  Initialize-ClaudeArtifact
  Write-LaunchDiagnostic 'prewarm-exit' @{ exitCode = 0 }
  exit 0
}
$env:CODEX_HOME = Resolve-SelectedCodexHome

function ConvertTo-Hashtable {
  param($Value)

  if ($null -eq $Value) {
    return $null
  }
  if ($Value -is [System.Collections.IDictionary]) {
    $result = @{}
    foreach ($key in $Value.Keys) {
      $result[[string]$key] = ConvertTo-Hashtable -Value $Value[$key]
    }
    return $result
  }
  if ($Value -is [pscustomobject]) {
    $result = @{}
    foreach ($property in $Value.PSObject.Properties) {
      $result[$property.Name] = ConvertTo-Hashtable -Value $property.Value
    }
    return $result
  }
  if (
    $Value -is [System.Collections.IEnumerable] -and
    $Value -isnot [string]
  ) {
    return @($Value | ForEach-Object { ConvertTo-Hashtable -Value $_ })
  }
  return $Value
}

function Read-ClaudeSettings {
  param([string]$Value)

  $settingsText = $Value.Trim()
  if (-not $settingsText.StartsWith('{')) {
    $settingsPath = if ([IO.Path]::IsPathRooted($Value)) {
      $Value
    } else {
      Join-Path $LaunchDirectory $Value
    }
    if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
      $settingsText = Get-Content -Raw -LiteralPath $settingsPath
    }
  }

  try {
    $settings = ConvertTo-Hashtable -Value ($settingsText | ConvertFrom-Json)
  } catch {
    throw "Could not parse Claude --settings value '$Value': $($_.Exception.Message)"
  }
  if ($settings -isnot [System.Collections.IDictionary]) {
    throw "Claude --settings value '$Value' must contain a JSON object."
  }
  return $settings
}

$CallerSettings = @{}
$ForwardedArgs = [System.Collections.Generic.List[string]]::new()
$AfterDoubleDash = $false
for ($i = 0; $i -lt $ClaudeArgs.Count; $i++) {
  $argument = [string]$ClaudeArgs[$i]
  if ($AfterDoubleDash) {
    $ForwardedArgs.Add($argument)
    continue
  }
  if ($argument -eq '--') {
    $AfterDoubleDash = $true
    $ForwardedArgs.Add($argument)
    continue
  }

  $settingsValue = $null
  if ($argument -eq '--settings') {
    if ($i + 1 -ge $ClaudeArgs.Count) {
      throw '--settings needs a file path or JSON object.'
    }
    $i++
    $settingsValue = [string]$ClaudeArgs[$i]
  } elseif ($argument -like '--settings=*') {
    $settingsValue = $argument.Substring('--settings='.Length)
  } else {
    $ForwardedArgs.Add($argument)
  }

  if ($null -ne $settingsValue) {
    $parsedSettings = Read-ClaudeSettings -Value $settingsValue
    foreach ($key in $parsedSettings.Keys) {
      $CallerSettings[$key] = $parsedSettings[$key]
    }
  }
}
$ClaudeArgs = @($ForwardedArgs)

# `cc login` is a CLI subcommand, not a session. The harness fast-paths it and
# must see the operator's arguments unchanged: starting a gateway and appending
# session flags made the installer path fail on every invocation. This runs
# before those flags are added below.
if ($ClaudeArgs.Count -ge 1 -and ([string]($ClaudeArgs[0])) -eq 'login') {
  Initialize-ClaudeArtifact
  & $ClaudeRunner --no-install $ClaudeScript @ClaudeArgs
  exit $LASTEXITCODE
}

# Explicit model/effort arguments are authoritative over inherited launcher
# defaults. Resolve them before constructing Gateway environment and provenance,
# so the metadata describes the exact child invocation rather than a stale shell.
$ExplicitModel = $null
$ExplicitEffort = $null
for ($i = 0; $i -lt $ClaudeArgs.Count; $i++) {
  $argument = [string]$ClaudeArgs[$i]
  if ($argument -eq '--') {
    break
  }
  if ($argument -eq '--model') {
    if ($i + 1 -ge $ClaudeArgs.Count) {
      throw '--model needs a model name.'
    }
    $i++
    $ExplicitModel = [string]$ClaudeArgs[$i]
    continue
  }
  if ($argument -like '--model=*') {
    $ExplicitModel = $argument.Substring('--model='.Length)
    continue
  }
  if ($argument -eq '--effort') {
    if ($i + 1 -ge $ClaudeArgs.Count) {
      throw '--effort needs an effort level.'
    }
    $i++
    $ExplicitEffort = [string]$ClaudeArgs[$i]
    continue
  }
  if ($argument -like '--effort=*') {
    $ExplicitEffort = $argument.Substring('--effort='.Length)
  }
}
if ($null -ne $ExplicitModel) {
  if ([string]::IsNullOrWhiteSpace($ExplicitModel)) {
    throw '--model needs a non-empty model name.'
  }
  $RequestedModel = $ExplicitModel
  $Model = Resolve-GatewayModel -Value $RequestedModel
}
if ($null -ne $ExplicitEffort) {
  if ([string]::IsNullOrWhiteSpace($ExplicitEffort)) {
    throw '--effort needs a non-empty effort level.'
  }
  $Effort = $ExplicitEffort
  $EffortWasExplicit = $true
}
# Resolve the model-native default only after --model is known. $Effort stays
# $null for models with no native ladder, in which case --effort is omitted.
if ($EffortWasExplicit -and -not [string]::IsNullOrWhiteSpace($Effort)) {
  Assert-GatewayEffortSupported -Model $Model -Effort $Effort
} elseif ([string]::IsNullOrWhiteSpace($Effort)) {
  $Effort = Resolve-DefaultGatewayEffort -Value $Model
}

function Test-HasPrintInput {
  param([string[]]$Arguments)

  function Test-RedirectedInputData {
    if (-not [Console]::IsInputRedirected) {
      return $false
    }

    if (-not ('CcInput.NativeMethods' -as [type])) {
      Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace CcInput {
  public static class NativeMethods {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GetStdHandle(int standardHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint GetFileType(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool PeekNamedPipe(
      IntPtr handle,
      IntPtr buffer,
      uint bufferSize,
      IntPtr bytesRead,
      out uint bytesAvailable,
      IntPtr bytesLeft,
      IntPtr readMessage
    );
  }
}
'@
    }

    $handle = [CcInput.NativeMethods]::GetStdHandle(-10)
    if ($handle -eq [IntPtr]::Zero -or $handle -eq [IntPtr](-1)) {
      return $false
    }

    # FILE_TYPE_DISK means a file was redirected into stdin. It is valid even
    # when no bytes have been read yet, so accept it without peeking.
    if ([CcInput.NativeMethods]::GetFileType($handle) -eq 1) {
      return $true
    }

    # A pipe can be empty for a short moment while its producer starts. Wait
    # briefly, but keep the launcher fail-fast for an actually empty pipe.
    for ($attempt = 0; $attempt -lt 5; $attempt++) {
      [uint32]$available = 0
      if ([CcInput.NativeMethods]::PeekNamedPipe(
          $handle,
          [IntPtr]::Zero,
          0,
          [IntPtr]::Zero,
          [ref]$available,
          [IntPtr]::Zero,
          [IntPtr]::Zero
        ) -and $available -gt 0) {
        return $true
      }
      Start-Sleep -Milliseconds 20
    }

    return $false
  }

  if (Test-RedirectedInputData) {
    return $true
  }

  $valueOptions = @(
    '--model',
    '--output-format',
    '--input-format',
    '--settings',
    '--effort',
    '--max-turns',
    '--fallback-model',
    '--agent',
    '--append-system-prompt',
    '--system-prompt',
    '--mcp-config'
  )
  for ($i = 0; $i -lt $Arguments.Count; $i++) {
    $argument = [string]$Arguments[$i]
    if ($argument -in $valueOptions -and $i + 1 -lt $Arguments.Count) {
      $i++
      continue
    }
    if (
      $argument -notlike '-*' -and
      $argument -notlike '--*' -and
      -not [string]::IsNullOrWhiteSpace($argument)
    ) {
      return $true
    }
  }
  return $false
}

$PrintRequested = $ClaudeArgs | Where-Object {
  $_ -eq '--print' -or $_ -eq '-p' -or $_ -like '--print=*'
}
if ($PrintRequested -and -not (Test-HasPrintInput -Arguments $ClaudeArgs)) {
  throw 'cc: --print requires a prompt argument or redirected stdin. Invoke cc without --print for the interactive REPL.'
}

# Interactive REPL only: narrate the startup phases so the blank console before
# the first frame is never unexplained. Print mode stays silent.
$ShowLaunchProgress = -not $PrintRequested

# Gateway owns its provider-qualified model catalog. Do not pass inherited
# Anthropic modelOverrides into the Gateway child settings; legacy model IDs
# are normalized only at the explicit resume/model-selection boundary.
$CallerSettings.modelOverrides = @{}
$CallerSettings.enableWorkflows = $true
$CallerSettings.workflowKeywordTriggerEnabled = $true

# Start every session in Bypass Permissions. permissionSetup.ts makes bypass both
# available and the session's starting mode only when the session was launched
# with --dangerously-skip-permissions (isBypassPermissionsModeAvailable, and
# initialPermissionModeFromCLI pushing 'bypassPermissions'); the "as an option"
# flag would leave the mode off by default, which is not what we want here. This
# is the deliberate choice that all gateway sessions start in bypass; the mode is
# still selectable back out via the Shift+Tab cycle.
$ClaudeArgs += '--dangerously-skip-permissions'

$HasEffortArgument = $false
$IsResume = $false
$HasSessionIdArgument = $false
foreach ($argument in $ClaudeArgs) {
  if ($argument -eq '--') {
    break
  }
  if ($argument -eq '--effort' -or $argument -like '--effort=*') {
    $HasEffortArgument = $true
  }
  if (
    $argument -eq '--resume' -or
    $argument -eq '-r' -or
    $argument -eq '--continue' -or
    $argument -eq '-c' -or
    $argument -like '--resume=*'
  ) {
    $IsResume = $true
  }
  if ($argument -eq '--session-id' -or $argument -like '--session-id=*') {
    $HasSessionIdArgument = $true
  }
}

# A fresh interactive session is minted an id before the harness starts, so a
# crash can be recovered: the retry relaunches with --resume <id> instead of
# opening a second, unrelated conversation. Print launches and launches that
# carry a positional prompt are left alone - print is a single turn, and
# resuming a prompt-carrying launch would replay the prompt.
$MintedSessionId = $null
if (
  -not $IsResume -and
  -not $HasSessionIdArgument -and
  -not $PrintRequested -and
  -not (Test-HasPrintInput -Arguments $ClaudeArgs)
) {
  $MintedSessionId = [Guid]::NewGuid().ToString()
  $ClaudeArgs += @('--session-id', $MintedSessionId)
}
$AutoRestartAttempts = if ($IsResume -or $MintedSessionId) { 1 } else { 0 }
$SettingsEnableUltracode = $CallerSettings.ultracode -eq $true
if (
  -not $HasEffortArgument -and
  -not [string]::IsNullOrWhiteSpace($Effort) -and
  ($EffortWasExplicit -or -not $IsResume) -and
  ($EffortWasExplicit -or -not $SettingsEnableUltracode)
) {
  $ClaudeArgs += @('--effort', $Effort)
}

# The retry resumes the very session that crashed. For a fresh launch the minted
# --session-id is rewritten to --resume in place; a resumed launch already
# carries --resume and retries with the same arguments.
$RetryArgs = $ClaudeArgs
if ($MintedSessionId) {
  $RetryArgs = @(
    foreach ($argument in $ClaudeArgs) {
      if ($argument -eq '--session-id') { '--resume' }
      elseif ($argument -eq "--session-id=$MintedSessionId") { "--resume=$MintedSessionId" }
      else { $argument }
    }
  )
}

function Get-FreeLoopbackPort {
  $listener = [System.Net.Sockets.TcpListener]::new(
    [System.Net.IPAddress]::Loopback,
    0
  )
  try {
    $listener.Start()
    return $listener.LocalEndpoint.Port
  } finally {
    $listener.Stop()
  }
}

function Test-LoopbackPortOccupied {
  param([int]$Port)

  $probe = [System.Net.Sockets.TcpClient]::new()
  try {
    $probe.Connect('127.0.0.1', $Port)
    return $true
  } catch {
    return $false
  } finally {
    $probe.Dispose()
  }
}

function Stop-OwnedGateway {
  param($Process)

  if ($null -eq $Process) {
    return
  }
  # The launcher holds the whole backend chain in a job object with
  # KILL_ON_JOB_CLOSE, and the caller disposes that handle in the same finally
  # that calls this. The wrapper is therefore all this has to stop: the job reaps
  # the keysafe/supervisor/backend descendants when the handle closes, and it
  # does so even when the launcher dies before this runs. What stood here instead
  # asked Win32_Process for every node.exe on the machine and filtered by command
  # line - a machine-wide WMI query on every exit, a stall under load, and
  # redundant now that the job owns the chain.
  try {
    [void]$Process.WaitForExit(1000)
    if (-not $Process.HasExited) {
      Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
      [void]$Process.WaitForExit(5000)
    }
  } catch {
    # Cleanup must not hide the Claude exit code or an earlier launch error.
  }
}

if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
  throw 'Node.js is required for the model gateway.'
}
if (-not (Test-Path -LiteralPath $GatewayScript)) {
  throw "Model gateway is missing: $GatewayScript"
}
if (-not (Test-Path -LiteralPath $GatewaySupervisor)) {
  throw "Model gateway supervisor is missing: $GatewaySupervisor"
}
# Bundled mode never touches the external keysafe script, and a clean machine
# does not have one. Only require it when the external store is in use.
if ($env:GATEWAY_CREDENTIALS_MODE -ne 'bundled' -and -not (Test-Path -LiteralPath $Keysafe)) {
  throw "Keysafe is missing: $Keysafe"
}

# The global cc launcher intentionally points at this worktree. Rebuild only
# when its source or build inputs are newer than the published bundle.
Write-LaunchProgress 'checking the compiled harness...'
Write-LaunchDiagnostic 'artifact-check'
Initialize-ClaudeArtifact
Write-LaunchDiagnostic 'artifact-ready'

# Reuse the reference port only when it is free; otherwise reserve an ephemeral
# loopback port so an unrelated or stale listener is never adopted.
$Port = 4011
if (Test-LoopbackPortOccupied -Port $Port) {
  $Port = Get-FreeLoopbackPort
}

$StdoutLog = Join-Path $env:TEMP "model-gateway-$PID-$Port.out.log"
$StderrLog = Join-Path $env:TEMP "model-gateway-$PID-$Port.err.log"

# Gateway sessions are hermetic. A caller may have a Claude subscription,
# Anthropic API-key, or third-party provider environment in its parent shell;
# none of those values are valid inputs for this launcher.
$GatewayInheritedVariables = @(
  'ANTHROPIC_BASE_URL'
  'ANTHROPIC_API_KEY'
  'ANTHROPIC_AUTH_TOKEN'
  'ANTHROPIC_MODEL'
  'ANTHROPIC_SMALL_FAST_MODEL'
  'ANTHROPIC_CUSTOM_HEADERS'
  'ANTHROPIC_CUSTOM_MODEL_OPTION'
  'ANTHROPIC_CUSTOM_MODEL_OPTION_NAME'
  'ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION'
  'ANTHROPIC_DEFAULT_OPUS_MODEL'
  'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME'
  'ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION'
  'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES'
  'ANTHROPIC_DEFAULT_SONNET_MODEL'
  'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME'
  'ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION'
  'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES'
  'ANTHROPIC_DEFAULT_HAIKU_MODEL'
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME'
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION'
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES'
  'CLAUDE_CODE_OAUTH_TOKEN'
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR'
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR'
  'ANTHROPIC_UNIX_SOCKET'
  'CLAUDE_CODE_USE_BEDROCK'
  'CLAUDE_CODE_USE_VERTEX'
  'CLAUDE_CODE_USE_FOUNDRY'
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH'
  'CLAUDE_CODE_SKIP_VERTEX_AUTH'
  'CLAUDE_CODE_SKIP_FOUNDRY_AUTH'
  'USE_STAGING_OAUTH'
  'ANTHROPIC_FOUNDRY_API_KEY'
  'ANTHROPIC_FOUNDRY_RESOURCE'
  'ANTHROPIC_FOUNDRY_BASE_URL'
  'ANTHROPIC_VERTEX_PROJECT_ID'
  'VERTEX_BASE_URL'
  'BEDROCK_BASE_URL'
  'AWS_BEARER_TOKEN_BEDROCK'
)
foreach ($variableName in $GatewayInheritedVariables) {
  Remove-Item -LiteralPath "Env:$variableName" -ErrorAction SilentlyContinue
}
$env:CLAUDE_CODE_GATEWAY_BASE_URL = "http://127.0.0.1:$Port"
$env:CLAUDE_CODE_GATEWAY_TOKEN = $GatewayToken
$env:CLAUDE_CODE_USE_GATEWAY = '1'
$env:CLAUDE_GATEWAY_ALLOW_LOOPBACK = '1'
# Session memory telemetry. cli.tsx starts the sampler only when both the
# gateway flag above and this directory are present, and the sampler emits a
# JSONL row per minute (reason=interval) plus one at startup and one at
# shutdown. Without it a session that ramps commit but never reclaims cannot be
# told apart from one that is merely large, because working set alone does not
# show the difference. Rows carry only counters, sizes and cache gauges - never
# user content - so the directory is safe to leave enabled permanently.
# Opt out per invocation with $env:CC_DISABLE_MEMORY_TELEMETRY = '1'.
if ($env:CC_DISABLE_MEMORY_TELEMETRY -ne '1') {
  $MemoryTelemetryDir = Join-Path $env:LOCALAPPDATA 'Gateway\memory'
  $env:GATEWAY_MEMORY_TELEMETRY_DIR = $MemoryTelemetryDir
  if (-not (Test-Path -LiteralPath $MemoryTelemetryDir -PathType Container)) {
    New-Item -ItemType Directory -Path $MemoryTelemetryDir -Force | Out-Null
  }
}
$env:MODEL_GATEWAY_MODEL = $Model
$env:CLAUDE_CODE_SUBAGENT_MODEL = $Model
$env:TANDEM_GATEWAY_PROVENANCE_SOURCE = 'cc.ps1'
$env:TANDEM_GATEWAY_PROVENANCE_PROVIDER = 'cc-gateway'
$env:TANDEM_GATEWAY_PROVENANCE_MODEL = $Model
$env:TANDEM_GATEWAY_PROVENANCE_EFFORT = $Effort
$env:TANDEM_GATEWAY_PROVENANCE_CWD = $LaunchDirectory
$env:TANDEM_GATEWAY_PROVENANCE_LAUNCH_NONCE = $env:TANDEM_BRANCH_PROVIDER_LAUNCH_NONCE
# Balanced provider tool schemas preserve bounded tool-selection descriptions
# while removing redundant schema metadata. Explicit compact/fallback modes
# remain available for controlled experiments or compatibility.
if ([string]::IsNullOrWhiteSpace($env:MODEL_GATEWAY_CODEX_TOOL_MODE)) {
  $env:MODEL_GATEWAY_CODEX_TOOL_MODE = 'balanced'
}
# The provider already caches stable prefixes automatically. Keep the
# experimental session namespace opt-in so it cannot reduce cache sharing.
$env:CLAUDE_CODE_GATEWAY_PROVENANCE = @{
  source = 'cc.ps1'
  provider = 'cc-gateway'
  model_actual = $Model
  effort_actual = $Effort
  cwd_actual = $LaunchDirectory
  launch_nonce = $env:TANDEM_BRANCH_PROVIDER_LAUNCH_NONCE
} | ConvertTo-Json -Compress
$env:MODEL_GATEWAY_DEFAULT_MODEL = 'gateway-gpt-6-sol'
$env:MODEL_GATEWAY_OPUS_MODEL = 'gateway-gpt-astra'
# The fast model backs every auxiliary call - WebFetch's summariser, awaySummary,
# session titles, session search, agent hooks - so a lane that stalls degrades
# all of them at once. The Codex lanes are not usable for this: measured 10
# concurrent calls each, gateway-gpt-luna answered 1/10 (med 14.5s) and gpt-astra
# 0/10, against 10/10 (med 1.0s) for gateway-ds-flash. Keep this on a lane that
# answers. (Measured 2026-09-17.)
$env:MODEL_GATEWAY_FAST_MODEL = 'gateway-ds-flash'
# Subagents do real work, so pick for capability among the lanes that answer.
# gateway-ds-4.1-flash is the strongest measured here and answered 10/10.
$env:MODEL_GATEWAY_SUBAGENT_MODEL = 'gateway-ds-4.1-flash'
# Keep gateway-backed cc on the standard native harness compaction path.
# Session-memory compaction is a separate summary producer and can replace
# compactConversation() without making a provider request, which makes it
# impossible to validate or recover the gateway compaction boundary reliably.
$env:DISABLE_CLAUDE_CODE_SM_COMPACT = '1'
$env:ENABLE_CLAUDE_CODE_SM_COMPACT = $null

# Trust the directory this session starts in, without writing a trust grant
# to the global config. The dialog exists to warn about reading and executing
# code in a checkout you did not open deliberately; every directory this
# launcher starts in is one the user chose, and at the home directory the
# answer is never persisted (TrustDialog keeps it session-only, because
# trusting home would implicitly trust every checkout underneath it), so the
# same question repeats on every launch. Leaves inherit this through
# GATEWAY_LEAF_TRUSTED, which they need — a modal in a leaf blocks its control
# handshake and the leaf start times out. Set CLAUDE_CODE_TRUST_CWD=0 before
# launching to get the prompt back.
if ([string]::IsNullOrWhiteSpace($env:CLAUDE_CODE_TRUST_CWD)) {
  $env:CLAUDE_CODE_TRUST_CWD = '1'
}

$env:CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = '1'
$env:MODEL_GATEWAY_EFFORT_CAPABILITIES = (
  $CapabilityCatalog.gatewayAliases | ConvertTo-Json -Compress
)
$GatewayModelOptions = @($CapabilityCatalog.gatewayModelOptions)
# The picker's `t` (move to top) and `r` (lift and place) shortcuts write the
# order they leave behind to this file. The picker reads its order from the
# environment snapshot taken here, so re-sorting the catalog before the export
# is the only way a saved order reaches the next launch. Ids the catalog no
# longer offers are dropped rather than injected, and routes added since the
# file was written keep their catalog position at the bottom.
$GatewayModelOrderPath = Join-Path $env:USERPROFILE '.claude\gateway-model-order.json'
if (Test-Path -LiteralPath $GatewayModelOrderPath -PathType Leaf) {
  $StoredModelOrder = @()
  try {
    $StoredModelOrder = @(
      (Get-Content -Raw -LiteralPath $GatewayModelOrderPath | ConvertFrom-Json)
    )
  } catch {
    $StoredModelOrder = @()
  }
  if ($StoredModelOrder.Count -gt 0) {
    $OptionsByValue = @{}
    foreach ($Option in $GatewayModelOptions) {
      $OptionsByValue[[string]$Option.value] = $Option
    }
    $PlacedOrder = @{}
    $LeadingOptions = @()
    foreach ($ModelId in $StoredModelOrder) {
      if ($ModelId -isnot [string]) { continue }
      if (-not $OptionsByValue.ContainsKey($ModelId)) { continue }
      if ($PlacedOrder.ContainsKey($ModelId)) { continue }
      $LeadingOptions += $OptionsByValue[$ModelId]
      $PlacedOrder[$ModelId] = $true
    }
    if ($LeadingOptions.Count -gt 0) {
      $TrailingOptions = @()
      foreach ($Option in $GatewayModelOptions) {
        if (-not $PlacedOrder.ContainsKey([string]$Option.value)) {
          $TrailingOptions += $Option
        }
      }
      $GatewayModelOptions = @($LeadingOptions + $TrailingOptions)
    }
  }
}
$env:MODEL_GATEWAY_MODEL_OPTIONS = ($GatewayModelOptions | ConvertTo-Json -Compress)
# The per-model effort pins the harness resolves `auto` against. Exported from
# the file read above, so a pin made in one session reaches the next launch and
# the harness and launcher cannot disagree about a model's default effort.
$env:MODEL_GATEWAY_EFFORT_DEFAULTS = if ($PinnedEffortDefaults.Count -gt 0) {
  $PinnedEffortDefaults | ConvertTo-Json -Compress
} else {
  '{}'
}
$env:CLAUDE_CODE_EFFORT_LEVEL = $null
$env:CLAUDE_CODE_WORKFLOWS = 'true'
$env:CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT = '1'
$env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
$env:CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = '1'
$env:MODEL_GATEWAY_LOG_TIMING = '1'
$env:MODEL_GATEWAY_LOG_EVENT_SHAPE = if ($env:MODEL_GATEWAY_CAPTURE_EVENT_SHAPE -eq '1') { '1' } else { $null }
Write-LaunchDiagnostic 'env-setup'

try {
  $ScopedSettingsPath = Join-Path `
    $env:TEMP `
    "cc-gateway-settings-$PID-$([Guid]::NewGuid().ToString('N')).json"
  [IO.File]::WriteAllText(
    $ScopedSettingsPath,
    ($CallerSettings | ConvertTo-Json -Depth 100 -Compress),
    [Text.UTF8Encoding]::new($false)
  )
  $ClaudeArgs += @('--settings', $ScopedSettingsPath)

  # Start the gateway. In external mode it goes through ONE short-lived keysafe
  # child: optional providers are included only when their vault record exists,
  # and no value ever becomes an argument or file. In bundled mode there is no
  # external store to read; the supervisor injects the bundled vault itself.
  $GatewayCommand = 'node "' + $GatewaySupervisor + '" --port ' + [string]$Port
  if ($env:GATEWAY_CREDENTIALS_MODE -eq 'bundled') {
    # Cleanroom: one plain supervisor spawn, no keysafe wrapper.
    $GatewayArgumentList = @(
      '-NoProfile'
      '-ExecutionPolicy'
      'Bypass'
      '-Command'
      $GatewayCommand
    )
  } else {
  # keysafe's run-many decrypts several vault records and injects them all into
  # the single Gateway process, so the launcher opens one PowerShell wrapper
  # instead of one per key. Every key still stays out of arguments, files, and
  # logs, and each value is redacted from the child's output.
  $OpenCodeProviders = @(Get-ChildItem -LiteralPath (Join-Path $env:USERPROFILE '.keysafe') -Filter 'opencode-go*.cred' -ErrorAction SilentlyContinue |
    Where-Object { $_.BaseName -match '^opencode-go([2-9]|[1-9][0-9]+)?$' } |
    Sort-Object { if ($_.BaseName -eq 'opencode-go') { 1 } else { [int]$_.BaseName.Substring('opencode-go'.Length) } } |
    ForEach-Object {
      $suffix = $_.BaseName.Substring('opencode-go'.Length)
      @{ Credential = $_.BaseName; EnvVar = ('OPENCODE_API_KEY' + $suffix) }
    })
  # Vibe plan keys and Studio API keys are separate credential types; both are
  # numbered pools and every stored slot is injected.
  # The console writes `mistralvibe`; the hyphenated `mistral-vibe` is accepted
  # too. Both spellings address the same Vibe credential pool.
  $MistralVibeProviders = @(Get-ChildItem -LiteralPath (Join-Path $env:USERPROFILE '.keysafe') -Filter 'mistral*vibe*.cred' -ErrorAction SilentlyContinue |
    Where-Object { $_.BaseName -match '^mistral-?vibe([2-9]|[1-9][0-9]+)?$' } |
    Sort-Object { $s = $_.BaseName -replace '^mistral-?vibe',''; if ($s -eq '') { 1 } else { [int]$s } } |
    ForEach-Object {
      $suffix = $_.BaseName -replace '^mistral-?vibe',''
      @{ Credential = $_.BaseName; EnvVar = ('MISTRAL_VIBE_KEY' + $suffix) }
    })
  $MistralProviders = @(Get-ChildItem -LiteralPath (Join-Path $env:USERPROFILE '.keysafe') -Filter 'mistral*.cred' -ErrorAction SilentlyContinue |
    Where-Object { $_.BaseName -match '^mistral([2-9]|[1-9][0-9]+)?$' } |
    Sort-Object { if ($_.BaseName -eq 'mistral') { 1 } else { [int]$_.BaseName.Substring('mistral'.Length) } } |
    ForEach-Object {
      $suffix = $_.BaseName.Substring('mistral'.Length)
      @{ Credential = $_.BaseName; EnvVar = ('MISTRAL_API_KEY' + $suffix) }
    })
  $OptionalKeyProviders = $OpenCodeProviders + $MistralVibeProviders + $MistralProviders + @(
    @{ Credential = 'amd-ds';      EnvVar = 'AMD_API_KEY' }
    @{ Credential = 'commandcode'; EnvVar = 'COMMANDCODE_API_KEY' }
  )
  # Every provider, DeepSeek included, is injected only when its record exists.
  # keysafe's run-many is all-or-nothing: asking for one missing name aborts the
  # whole child, so a hard-coded `ds` turned a single absent record into "no
  # session at all" even though the gateway serves the other providers and
  # `/login` in the running session is the path that captures a new key.
  $InjectSpecs = @()
  if (Test-Path -LiteralPath (Join-Path $env:USERPROFILE '.keysafe\ds.cred') -PathType Leaf) {
    $InjectSpecs += 'ds=DEEPSEEK_API_KEY'
  }
  foreach ($Provider in $OptionalKeyProviders) {
    if (-not (Test-Path -LiteralPath (Join-Path $env:USERPROFILE ('.keysafe\' + $Provider.Credential + '.cred')) -PathType Leaf)) {
      continue
    }
    $InjectSpecs += ($Provider.Credential + '=' + $Provider.EnvVar)
  }
  if ($InjectSpecs.Count -eq 0) {
    # Nothing to inject: start the supervisor plainly, exactly as bundled mode
    # does. It resolves the vault itself on every restart and reload, so a key
    # captured by /login reaches the gateway without relaunching cc.
    $GatewayArgumentList = @(
      '-NoProfile'
      '-ExecutionPolicy'
      'Bypass'
      '-Command'
      $GatewayCommand
    )
  } else {
  $GatewayArgumentList = @(
    '-NoProfile'
    '-ExecutionPolicy'
    'Bypass'
    '-File'
    $Keysafe
    'run-many'
    '-Inject'
    '"' + ($InjectSpecs -join ';') + '"'
    '-Command'
    $GatewayCommand
  )
  }
  }

  # Start-Process serializes ArgumentList items into a native command line.
  # The -Inject value is pre-quoted above (it contains ';'); quote the -Command
  # value here (it contains spaces and nested quotes) so both stay single
  # tokens. No key is ever an argument.
  $GatewayArgumentList = @($GatewayArgumentList)
  $GatewayArgumentList[-1] = '"' +
    ([string]$GatewayArgumentList[-1]).Replace('"', '\"') +
    '"'

  if ($env:CC_SKIP_GATEWAY_START -eq '1') {
    # Test-only seam for launcher control-flow regression. Gateway startup and
    # health are covered independently by the gateway and compiled replay gates.
    $healthy = $true
  } else {
    # Hold a non-inheritable job handle here: Windows reaps this exclusive backend
    # chain even if the launcher dies before its finally block can run.
    Write-LaunchProgress "starting the model gateway on port $Port..."
    Write-LaunchDiagnostic 'gateway-spawn-start' @{ port = $Port }
    . (Join-Path $PSScriptRoot 'owned-gateway-process.ps1')
    $ownedGateway = Start-OwnedGatewayProcess `
      -FilePath 'powershell.exe' `
      -ArgumentList $GatewayArgumentList `
      -WorkingDirectory $Root `
      -StdoutPath $StdoutLog `
      -StderrPath $StderrLog
    $GatewayJob = $ownedGateway.Job
    $GatewayProcess = $ownedGateway.Process

    # Two different failures hid under one message. A backend that dies at
    # startup (a refused credential, a provider that closed the socket) exits
    # the wrapper within a few seconds; a gateway that never binds runs to the
    # deadline. The first is not a timeout, so "did not become healthy within 15
    # seconds" named the wrong thing and reported no exit code. Tell them apart,
    # record which one happened, and keep the child's stderr on the exit path so
    # the reason survives for the next launch.
    Write-LaunchProgress 'waiting for the model gateway to become healthy...'
    Write-LaunchDiagnostic 'gateway-health-start' @{ port = $Port }
    $healthy = $false
    $healthStarted = [DateTime]::UtcNow
    $deadline = $healthStarted.AddSeconds(15)
    while (-not $healthy -and [DateTime]::UtcNow -lt $deadline) {
      if ($GatewayProcess.HasExited) {
        break
      }
      try {
        $health = Invoke-RestMethod `
          -Uri "http://127.0.0.1:$Port/health" `
          -TimeoutSec 1
        if ($health.status -eq 'ok') {
          $healthy = $true
          break
        }
      } catch {
        # The gateway may still be binding its loopback listener.
      }
      Start-Sleep -Milliseconds 250
    }

    if (-not $healthy) {
      $elapsedMs = [int]([DateTime]::UtcNow - $healthStarted).TotalMilliseconds
      if ($GatewayProcess.HasExited) {
        $gatewayExitCode = $null
        try {
          [void]$GatewayProcess.WaitForExit(2000)
          $gatewayExitCode = $GatewayProcess.ExitCode
        } catch {}
        $codeText = if ($null -ne $gatewayExitCode) { [string]$gatewayExitCode } else { 'unknown' }
        $failureFields = @{ port = $Port; errorType = 'exited' }
        if ($null -ne $gatewayExitCode) { $failureFields.exitCode = $gatewayExitCode }
        Write-LaunchDiagnostic 'gateway-unhealthy' $failureFields
        $PreserveGatewayLogs = $true
        # keysafe refuses to inject a record it does not have, and the wrapper
        # exits in about a second. Name the missing record so the operator does
        # not have to open the log: emit only the validated name from keysafe's
        # own message, never raw stderr (it could carry provider payloads).
        $missingCredential = $null
        try {
          foreach ($line in @(Get-Content -LiteralPath $StderrLog -Tail 40 -ErrorAction Stop)) {
            if ([string]$line -match "no key named '([A-Za-z0-9._-]{1,64})'") {
              $missingCredential = $Matches[1]
              break
            }
          }
        } catch {}
        if ($missingCredential) {
          throw "Model gateway backend exited (code $codeText) after ${elapsedMs}ms: the '$missingCredential' credential is missing from the legacy keysafe store. Open a gateway session and run /login to capture it, then send again. Safe diagnostics: $DiagnosticPath"
        }
        throw "Model gateway backend exited (code $codeText) after ${elapsedMs}ms without becoming healthy. Safe diagnostics: $DiagnosticPath"
      }
      Write-LaunchDiagnostic 'gateway-unhealthy' @{ port = $Port; errorType = 'timeout' }
      throw "Model gateway did not become healthy within 15 seconds (waited ${elapsedMs}ms). Safe diagnostics: $DiagnosticPath"
    }
    Write-LaunchDiagnostic 'gateway-health-end' @{ port = $Port; elapsedMs = [int]([DateTime]::UtcNow - $healthStarted).TotalMilliseconds }
  }

  # Claude resolves transcripts from the caller's directory. Keep that
  # directory active so --resume uses the correct project namespace.
  Push-Location $LaunchDirectory
  try {
    # Keep the harness attached directly to the caller's console
    Write-LaunchProgress 'launching the session...'
    for ($attempt = 0; $attempt -le $AutoRestartAttempts; $attempt++) {
      Write-LaunchDiagnostic 'harness-start' @{ attempt = $attempt; port = $Port }
      $AttemptArgs = if ($attempt -eq 0) { $ClaudeArgs } else { $RetryArgs }
      # --no-install must precede the script path; Bun silently ignores it after
      # it. With the dependency drift measured on a bare tree this turns a
      # missing module into a clear error instead of a registry fetch of latest.
      & $ClaudeRunner --no-install $ClaudeScript @AttemptArgs
      $ExitCode = $LASTEXITCODE
      Write-LaunchDiagnostic 'harness-exit' @{ attempt = $attempt; exitCode = $ExitCode }
      if ($ExitCode -ne 0 -and $ExitCode -ne 130) {
        [Console]::Error.WriteLine("cc: exit diagnostics saved to $DiagnosticPath")
      }
      if (
        ($ExitCode -ne 0 -and $ExitCode -ne 130) -and
        $attempt -lt $AutoRestartAttempts
      ) {
        [Console]::Error.WriteLine(
          "cc: Claude exited unexpectedly with code $ExitCode; restarting the resumed session once..."
        )
        Start-Sleep -Milliseconds 500
        continue
      }
      if ($ExitCode -eq 0 -or $ExitCode -eq 130 -or $attempt -ge $AutoRestartAttempts) {
        break
      }
    }
  } finally {
    Pop-Location
  }
} finally {
  try {
    Stop-OwnedGateway -Process $GatewayProcess
  } finally {
    if ($GatewayJob) { $GatewayJob.Dispose() }
  }
  if ($StdoutLog) {
    if ($KeepGatewayLogs -or $PreserveGatewayLogs) {
      [Console]::Error.WriteLine("cc gateway stdout log=$StdoutLog")
    } else {
      Remove-Item -LiteralPath $StdoutLog -Force -ErrorAction SilentlyContinue
    }
  }
  if ($StderrLog) {
    if ($KeepGatewayLogs -or $PreserveGatewayLogs) {
      [Console]::Error.WriteLine("cc gateway stderr log=$StderrLog")
    } else {
      Remove-Item -LiteralPath $StderrLog -Force -ErrorAction SilentlyContinue
    }
  }
  if ($ScopedSettingsPath) {
    Remove-Item -LiteralPath $ScopedSettingsPath -Force -ErrorAction SilentlyContinue
  }
}

exit $ExitCode
