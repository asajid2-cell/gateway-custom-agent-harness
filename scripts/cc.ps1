$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$LaunchDirectory = (Get-Location).Path
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
} else {
  (Get-Command bun.exe -ErrorAction Stop).Source
}
$ClaudeScript = Join-Path $Root 'dist\cli.js'
$CapabilityCatalogPath = Join-Path $Root 'scripts\effort-capabilities.json'
if (-not (Test-Path -LiteralPath $CapabilityCatalogPath -PathType Leaf)) {
  throw "Effort capability catalog is missing: $CapabilityCatalogPath"
}
$CapabilityCatalog = Get-Content -Raw -LiteralPath $CapabilityCatalogPath |
  ConvertFrom-Json

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
    $selectedHome = $DefaultCodexHome
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
$env:CODEX_HOME = Resolve-SelectedCodexHome
$Keysafe = Join-Path $env:USERPROFILE '.claude\skills\keysafe\scripts\keysafe.ps1'
$RequestedModel = if ($env:MODEL_GATEWAY_DEFAULT) { $env:MODEL_GATEWAY_DEFAULT } else { 'gateway-gpt-luna' }
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
$Effort = if ($env:MODEL_GATEWAY_EFFORT) { $env:MODEL_GATEWAY_EFFORT } else { 'high' }
$KeepGatewayLogs = $env:MODEL_GATEWAY_KEEP_LOGS -eq '1'
$GatewayToken = 'local-gateway'
$ClaudeArgs = @($args)
$GatewayProcess = $null
$StdoutLog = $null
$StderrLog = $null
$ScopedSettingsPath = $null
$ExitCode = 1

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

# Gateway owns its provider-qualified model catalog. Do not pass inherited
# Anthropic modelOverrides into the Gateway child settings; legacy model IDs
# are normalized only at the explicit resume/model-selection boundary.
$CallerSettings.modelOverrides = @{}
$CallerSettings.enableWorkflows = $true
$CallerSettings.workflowKeywordTriggerEnabled = $true

$HasEffortArgument = $false
$IsResume = $false
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
}
$AutoRestartAttempts = if ($IsResume) { 1 } else { 0 }
$SettingsEnableUltracode = $CallerSettings.ultracode -eq $true
if (
  -not $HasEffortArgument -and
  ($EffortWasExplicit -or -not $IsResume) -and
  ($EffortWasExplicit -or -not $SettingsEnableUltracode)
) {
  $ClaudeArgs += @('--effort', $Effort)
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

function Test-OwnedGatewayProcess {
  param(
    $Process,
    [string[]]$GatewayPaths,
    [int]$Port
  )

  if ($Process.Name -ne 'node.exe' -or [string]::IsNullOrEmpty($Process.CommandLine)) {
    return $false
  }

  try {
    $arguments = @(ConvertFrom-WindowsCommandLine -CommandLine $Process.CommandLine)
    for ($i = 0; $i -lt ($arguments.Count - 2); $i++) {
      try {
        $candidatePath = [IO.Path]::GetFullPath([string]$arguments[$i])
        if (
          ($candidatePath -in @($GatewayPaths | ForEach-Object { [IO.Path]::GetFullPath($_) })) -and
          ([string]$arguments[$i + 1] -eq '--port') -and
          ([int]$arguments[$i + 2] -eq $Port)
        ) {
          return $true
        }
      } catch {
        continue
      }
    }
  } catch {
    return $false
  }
  return $false
}

function Stop-OwnedGateway {
  param($Process)

  if ($null -eq $Process) {
    return
  }
  try {
    $gatewayPaths = @($GatewayScript, $GatewaySupervisor)
    $gatewayProcessIds = @()
    try {
      $gatewayProcessIds = @(
        Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
          Where-Object { Test-OwnedGatewayProcess -Process $_ -GatewayPaths $gatewayPaths -Port $Port } |
          Select-Object -ExpandProperty ProcessId
      )
    } catch {
      $gatewayProcessIds = @()
    }
    foreach ($gatewayProcessId in @($gatewayProcessIds | Sort-Object -Descending)) {
      Stop-Process -Id ([int]$gatewayProcessId) -Force -ErrorAction SilentlyContinue
    }
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
if (-not (Test-Path -LiteralPath $Keysafe)) {
  throw "Keysafe is missing: $Keysafe"
}

function Test-ClaudeArtifactFresh {
  if (-not (Test-Path -LiteralPath $ClaudeScript -PathType Leaf)) {
    return $false
  }

  $buildInputs = @(
    (Join-Path $Root 'src'),
    (Join-Path $Root 'scripts\build.ts'),
    (Join-Path $Root 'package.json'),
    (Join-Path $Root 'bun.lock'),
    (Join-Path $Root 'bun.lockb'),
    (Join-Path $Root 'tsconfig.json')
  )
  $inputFiles = @(
    foreach ($inputPath in $buildInputs) {
      if (Test-Path -LiteralPath $inputPath -PathType Container) {
        Get-ChildItem -LiteralPath $inputPath -File -Recurse -Force
      } elseif (Test-Path -LiteralPath $inputPath -PathType Leaf) {
        Get-Item -LiteralPath $inputPath
      }
    }
  )
  if ($inputFiles.Count -eq 0) {
    return $false
  }

  $latestInput = ($inputFiles | Measure-Object -Property LastWriteTimeUtc -Maximum).Maximum
  $artifact = Get-Item -LiteralPath $ClaudeScript
  return $artifact.LastWriteTimeUtc -ge $latestInput
}

# The global cc launcher intentionally points at this worktree. Rebuild only
# when the compiled harness is older than its source or build inputs; this keeps
# fresh terminals current without paying the full Bun build cost on every launch.
if (-not (Test-ClaudeArtifactFresh)) {
  Push-Location $Root
  try {
    & $ClaudeRunner 'run' 'build'
    if ($LASTEXITCODE -ne 0) {
      throw "Claude harness build failed with exit code $LASTEXITCODE."
    }
  } finally {
    Pop-Location
  }
}

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
$env:MODEL_GATEWAY_DEFAULT_MODEL = 'gateway-gpt-luna'
$env:MODEL_GATEWAY_OPUS_MODEL = 'gateway-gpt-sol'
$env:MODEL_GATEWAY_FAST_MODEL = 'gateway-ds-flash'
$env:MODEL_GATEWAY_SUBAGENT_MODEL = $Model
# Keep gateway-backed cc on the standard native harness compaction path.
# Session-memory compaction is a separate summary producer and can replace
# compactConversation() without making a provider request, which makes it
# impossible to validate or recover the gateway compaction boundary reliably.
$env:DISABLE_CLAUDE_CODE_SM_COMPACT = '1'
$env:ENABLE_CLAUDE_CODE_SM_COMPACT = $null

$env:CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = '1'
$env:MODEL_GATEWAY_EFFORT_CAPABILITIES = (
  $CapabilityCatalog.gatewayAliases | ConvertTo-Json -Compress
)
$GatewayModelOptions = @($CapabilityCatalog.gatewayModelOptions)
$env:MODEL_GATEWAY_MODEL_OPTIONS = ($GatewayModelOptions | ConvertTo-Json -Compress)
$env:CLAUDE_CODE_EFFORT_LEVEL = $null
$env:CLAUDE_CODE_WORKFLOWS = 'true'
$env:CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT = '1'
$env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
$env:CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = '1'
$env:MODEL_GATEWAY_LOG_TIMING = '1'

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

  # Start the Gateway through a short-lived keysafe child. OpenCode is included
  # only when its vault record is present, and the value never becomes an argument
  # or file.
  $GatewayCommand = 'node "' + $GatewaySupervisor + '" --port ' + [string]$Port
  $GatewayArgumentList = @(
    '-NoProfile'
    '-ExecutionPolicy'
    'Bypass'
    '-File'
    $Keysafe
    'run'
    'ds'
    '-EnvVar'
    'DEEPSEEK_API_KEY'
    '-Command'
    ($GatewayCommand)
  )
  if (Test-Path -LiteralPath (Join-Path $env:USERPROFILE '.keysafe\opencode-go.cred') -PathType Leaf) {
    # Keysafe injects one record per child. Nest the second runtime injection so
    # the Gateway inherits both variables without exposing either value in an
    # argument, file, or log.
    # The outer keysafe runner parses its child command as PowerShell. Encode
    # the nested invocation so its -EnvVar token cannot be rebound as a second
    # parameter of the outer invocation. The encoded script contains only paths,
    # key names, and the Gateway command; no credential value.
    $NestedScript = '$KeysafePath = ' +
      ("'" + $Keysafe.Replace("'", "''") + "'") +
      '; $GatewayCommand = ' +
      ("'" + $GatewayCommand.Replace("'", "''") + "'") +
      '; & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $KeysafePath ' +
      'run opencode-go -EnvVar OPENCODE_API_KEY -Command $GatewayCommand; ' +
      'exit $LASTEXITCODE'
    $NestedEncoded = [Convert]::ToBase64String(
      [Text.Encoding]::Unicode.GetBytes($NestedScript)
    )
    $NestedCommand = '& powershell.exe -NoProfile -ExecutionPolicy Bypass ' +
      '-EncodedCommand ' + $NestedEncoded
    # The common Start-Process argument quoting below wraps this complete
    # nested command exactly once.
    $GatewayArgumentList = @(
      '-NoProfile'
      '-ExecutionPolicy'
      'Bypass'
      '-File'
      $Keysafe
      'run'
      'ds'
      '-EnvVar'
      'DEEPSEEK_API_KEY'
      '-Command'
      $NestedCommand
    )
  }

  # Start-Process serializes ArgumentList items into a native command line.
  # Quote the one outer -Command value so spaces and nested switches remain
  # inside keysafe's Command parameter; the key itself is never an argument.
  $GatewayArgumentList = @($GatewayArgumentList)
  $GatewayArgumentList[-1] = '"' +
    ([string]$GatewayArgumentList[-1]).Replace('"', '\"') +
    '"'

  if ($env:CC_SKIP_GATEWAY_START -eq '1') {
    # Test-only seam for launcher control-flow regression. Gateway startup and
    # health are covered independently by the gateway and compiled replay gates.
    $healthy = $true
  } else {
    $GatewayProcess = Start-Process `
      -FilePath 'powershell.exe' `
      -ArgumentList $GatewayArgumentList `
      -WorkingDirectory $Root `
      -WindowStyle Hidden `
      -RedirectStandardOutput $StdoutLog `
      -RedirectStandardError $StderrLog `
      -PassThru

    $healthy = $false
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
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
      $detail = if (Test-Path -LiteralPath $StderrLog) {
        (Get-Content -Raw -LiteralPath $StderrLog).Trim()
      } else {
        ''
      }
      if ($detail) {
        throw "Model gateway did not become healthy. $detail"
      }
      throw 'Model gateway did not become healthy within 15 seconds.'
    }
  }

  # Claude resolves transcripts from the caller's directory. Keep that
  # directory active so --resume uses the correct project namespace.
  Push-Location $LaunchDirectory
  try {
    # Keep the harness attached directly to the caller's console
    for ($attempt = 0; $attempt -le $AutoRestartAttempts; $attempt++) {
      & $ClaudeRunner $ClaudeScript @ClaudeArgs
      $ExitCode = $LASTEXITCODE
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
      if ($ExitCode -eq 130 -or $attempt -ge $AutoRestartAttempts) {
        break
      }
    }
  } finally {
    Pop-Location
  }
} finally {
  Stop-OwnedGateway -Process $GatewayProcess
  if ($StdoutLog) {
    if ($KeepGatewayLogs) {
      [Console]::Error.WriteLine("cc gateway stdout log=$StdoutLog")
    } else {
      Remove-Item -LiteralPath $StdoutLog -Force -ErrorAction SilentlyContinue
    }
  }
  if ($StderrLog) {
    if ($KeepGatewayLogs) {
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
