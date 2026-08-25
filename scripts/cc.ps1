$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$LaunchDirectory = (Get-Location).Path
$GatewayScript = Join-Path $PSScriptRoot 'model-gateway.mjs'
$ClaudeScript = Join-Path $Root 'dist\cli.js'
$CodexAccountsRoot = Join-Path $env:USERPROFILE '.codex-accounts'
$CodexSelectionPath = Join-Path $CodexAccountsRoot 'current.txt'
$DefaultCodexHome = Join-Path $env:USERPROFILE '.codex'

function Resolve-SelectedCodexHome {
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

# cc can be started from an old shell or a resumed terminal. Resolve the account at
# launch time instead of trusting that caller's inherited CODEX_HOME.
$env:CODEX_HOME = Resolve-SelectedCodexHome
$Keysafe = Join-Path $env:USERPROFILE '.claude\skills\keysafe\scripts\keysafe.ps1'
$ClaudeRunner = 'bun.exe'
$RequestedModel = if ($env:MODEL_GATEWAY_DEFAULT) { $env:MODEL_GATEWAY_DEFAULT } else { 'gpt-5.6-luna' }
$EffortWasExplicit = -not [string]::IsNullOrWhiteSpace($env:MODEL_GATEWAY_EFFORT)
$ModelAliases = @{
  'gpt-5.6-luna' = 'claude-gpt-luna'
  'gpt-5.6-sol' = 'claude-gpt-sol'
  'gpt-5.6-terra' = 'claude-gpt-terra'
  'deepseek-v4-flash' = 'claude-ds-flash'
  'deepseek-v4-pro' = 'claude-ds-pro'
  'ox-alpha-free' = 'claude-opencode-ox-alpha'
}
$Model = if ($ModelAliases.ContainsKey($RequestedModel)) {
  $ModelAliases[$RequestedModel]
} else {
  $RequestedModel
}
$Effort = if ($env:MODEL_GATEWAY_EFFORT) { $env:MODEL_GATEWAY_EFFORT } else { $null }
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

# Gateway mode intentionally ignores ANTHROPIC_DEFAULT_* capability overrides.
# Reverse model overrides give Claude Code a capability-bearing catalog identity
# while requests still use the gateway alias on the wire.
$GatewayModelOverrides = @{
  'claude-opus-5' = 'claude-gpt-luna'
  'claude-fable-5' = 'claude-gpt-sol'
  'claude-opus-4-8' = 'claude-gpt-terra'
}
$ModelOverrides = @{}
if ($CallerSettings.modelOverrides -is [System.Collections.IDictionary]) {
  foreach ($key in $CallerSettings.modelOverrides.Keys) {
    $ModelOverrides[[string]$key] = $CallerSettings.modelOverrides[$key]
  }
}
foreach ($key in $GatewayModelOverrides.Keys) {
  $ModelOverrides[$key] = $GatewayModelOverrides[$key]
}
$CallerSettings.modelOverrides = $ModelOverrides
$CallerSettings.enableWorkflows = $true
$CallerSettings.workflowKeywordTriggerEnabled = $true

$HasEffortArgument = $false
foreach ($argument in $ClaudeArgs) {
  if ($argument -eq '--') {
    break
  }
  if ($argument -eq '--effort' -or $argument -like '--effort=*') {
    $HasEffortArgument = $true
  }
}
if (-not $HasEffortArgument -and $EffortWasExplicit) {
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
    [string]$GatewayPath,
    [int]$Port
  )

  if ($Process.Name -ne 'node.exe' -or [string]::IsNullOrEmpty($Process.CommandLine)) {
    return $false
  }

  try {
    $arguments = @(ConvertFrom-WindowsCommandLine -CommandLine $Process.CommandLine)
    for ($i = 0; $i -lt ($arguments.Count - 2); $i++) {
      if (
        ([IO.Path]::GetFullPath([string]$arguments[$i]) -eq $GatewayPath) -and
        ([string]$arguments[$i + 1] -eq '--port') -and
        ([int]$arguments[$i + 2] -eq $Port)
      ) {
        return $true
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
    $gatewayPath = [IO.Path]::GetFullPath($GatewayScript)
    $gatewayProcessIds = @()
    try {
      $gatewayProcessIds = @(
        Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
          Where-Object { Test-OwnedGatewayProcess -Process $_ -GatewayPath $gatewayPath -Port $Port } |
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

function Wrap-KeysafeCommand {
  param(
    [string]$KeyName,
    [string]$EnvironmentVariable,
    [string]$ChildCommand
  )

  $NestedScript = '$KeysafePath = ' +
    ("'" + $Keysafe.Replace("'", "''") + "'") +
    '; $ChildCommand = ' +
    ("'" + $ChildCommand.Replace("'", "''") + "'") +
    '; & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $KeysafePath ' +
    'run ' + $KeyName + ' -EnvVar ' + $EnvironmentVariable +
    ' -Command $ChildCommand; exit $LASTEXITCODE'
  $NestedEncoded = [Convert]::ToBase64String(
    [Text.Encoding]::Unicode.GetBytes($NestedScript)
  )
  return '& powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ' + $NestedEncoded
}

if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
  throw 'Node.js is required for the model gateway.'
}
if (-not (Test-Path -LiteralPath $GatewayScript)) {
  throw "Model gateway is missing: $GatewayScript"
}
if (-not (Test-Path -LiteralPath $Keysafe)) {
  throw "Keysafe is missing: $Keysafe"
}
if (-not (Get-Command $ClaudeRunner -ErrorAction SilentlyContinue)) {
  throw 'Bun is required to run the deployed local Claude harness.'
}
if (-not (Test-Path -LiteralPath $ClaudeScript -PathType Leaf)) {
  throw "Deployed Claude harness is missing: $ClaudeScript. Run 'bun run build' first."
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
# new terminals current without paying the full Bun build cost on every launch.
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

$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:$Port"
$env:CLAUDE_CODE_GB_BASE_URL = "http://127.0.0.1:$Port"
$env:ANTHROPIC_API_KEY = $null
$env:ANTHROPIC_AUTH_TOKEN = $GatewayToken
$env:CLAUDE_CODE_OAUTH_TOKEN = $null
$env:CLAUDE_CODE_USE_GATEWAY = '1'
$env:CLAUDE_GATEWAY_ALLOW_LOOPBACK = '1'
$env:ANTHROPIC_MODEL = $Model
$env:CLAUDE_CODE_SUBAGENT_MODEL = $Model

$env:ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-gpt-sol'
$env:ANTHROPIC_DEFAULT_SONNET_MODEL = 'claude-gpt-luna'
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL = 'claude-ds-flash'
$env:ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES = 'effort,thinking,adaptive_thinking'
$env:ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES = 'effort,thinking,adaptive_thinking'
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES = 'effort,thinking,adaptive_thinking'
$env:CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = $null
$env:CLAUDE_CODE_EFFORT_LEVEL = $null
$env:CLAUDE_CODE_WORKFLOWS = 'true'
$env:CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT = '1'
$env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
$env:CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = '1'
$env:MODEL_GATEWAY_LOG_TIMING = '1'
$env:CLAUDE_ENABLE_STREAM_WATCHDOG = '1'
if ([string]::IsNullOrWhiteSpace($env:CLAUDE_STREAM_IDLE_TIMEOUT_MS)) {
  $env:CLAUDE_STREAM_IDLE_TIMEOUT_MS = '90000'
}

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

  # Start the Gateway through short-lived nested Keysafe children. Each value
  # remains inside the child environment and never becomes an argument or file.
  $GatewayCommand = 'node "' + $GatewayScript + '" --port ' + [string]$Port
  $GatewayCommandWithKeys = $GatewayCommand
  if (Test-Path -LiteralPath (Join-Path $env:USERPROFILE '.keysafe\opencode-go.cred') -PathType Leaf) {
    $GatewayCommandWithKeys = Wrap-KeysafeCommand `
      -KeyName 'opencode-go' `
      -EnvironmentVariable 'OPENCODE_API_KEY' `
      -ChildCommand $GatewayCommandWithKeys
  }
  if (Test-Path -LiteralPath (Join-Path $env:USERPROFILE '.keysafe\openrouter.cred') -PathType Leaf) {
    $GatewayCommandWithKeys = Wrap-KeysafeCommand `
      -KeyName 'openrouter' `
      -EnvironmentVariable 'OPENROUTER_API_KEY' `
      -ChildCommand $GatewayCommandWithKeys
  }
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
    $GatewayCommandWithKeys
  )

  # Start-Process serializes ArgumentList items into a native command line.
  # Quote the one outer -Command value so spaces and nested switches remain
  # inside keysafe's Command parameter; the key itself is never an argument.
  $GatewayArgumentList = @($GatewayArgumentList)
  $GatewayArgumentList[-1] = '"' +
    ([string]$GatewayArgumentList[-1]).Replace('"', '\"') +
    '"'

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

  # Claude resolves transcripts from the caller's directory. Keep that
  # directory active so --resume uses the correct project namespace.
  Push-Location $LaunchDirectory
  try {
    $restartAttempted = $false
    while ($true) {
      # Keep the harness attached directly to the caller's console. Piping native
      # output through PowerShell makes stdout non-TTY, which the CLI correctly
      # interprets as --print/headless mode and then waits for prompt input.
      & $ClaudeRunner $ClaudeScript @ClaudeArgs
      $ExitCode = $LASTEXITCODE

      $hasResumeArgument = @($ClaudeArgs | Where-Object {
        $_ -eq '--resume' -or $_ -like '--resume=*'
      }).Count -gt 0

      # With direct console inheritance there is no safe way for PowerShell to
      # tee native stderr without breaking TTY detection. A resumed session is
      # persisted, so one bounded retry on an unexpected non-zero exit still
      # recovers Bun panics and abrupt child termination without retrying Ctrl+C.
      if (
        -not $restartAttempted -and
        $hasResumeArgument -and
        $ExitCode -ne 0 -and
        $ExitCode -ne 130
      ) {
        $restartAttempted = $true
        [Console]::Error.WriteLine(
          "cc: resumed session exited with code $ExitCode; restarting once from its persisted transcript."
        )
        Start-Sleep -Milliseconds 750
        continue
      }
      break
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
