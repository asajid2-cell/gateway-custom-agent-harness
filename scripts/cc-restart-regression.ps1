$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $PSScriptRoot 'cc.ps1'
$fakeRunner = Join-Path $PSScriptRoot 'cc-restart-fake-runner.cmd'
$state = Join-Path $env:TEMP "cc-restart-regression-$PID.state"
Remove-Item -LiteralPath $state -Force -ErrorAction SilentlyContinue

function Invoke-Launcher([string[]]$Arguments) {
  $env:CC_CLAUDE_RUNNER_OVERRIDE = $fakeRunner
  $env:CC_FAKE_RUNNER_STATE = $state
  $env:CC_SKIP_GATEWAY_START = '1'
  $env:TANDEM_GATEWAY_CODEX_HOME = Join-Path $env:USERPROFILE '.codex'
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = @(
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $launcher @Arguments 2>&1
    )
    return [pscustomobject]@{
      Output = $output
      ExitCode = $LASTEXITCODE
    }
  } finally {
    $ErrorActionPreference = $previousPreference
  }
}

try {
  $resumeRun = Invoke-Launcher @('--resume', '00000000-0000-4000-8000-000000000000')
  $resumeOutput = @($resumeRun.Output)
  $resumeExit = $resumeRun.ExitCode
  $resumeRestarted = $resumeOutput -match 'restarting the resumed session once'
  $resumeState = Test-Path -LiteralPath $state -PathType Leaf
  $resumeStateText = if ($resumeState) {
    Get-Content -Raw -LiteralPath $state
  } else {
    ''
  }
  $resumeStateLines = @($resumeStateText -split "`r?`n")
  $gatewayOptionsLine = $resumeStateLines |
    Where-Object { $_ -like 'gateway-options=*' } |
    Select-Object -First 1
  $nativeCompactDisabled = $resumeStateText -match 'disable-sm=1'
    $gatewayIdentity = (
    $resumeStateLines -contains ('codex-home=' + (Join-Path $env:USERPROFILE '.codex')) -and
    $resumeStateLines -contains 'model=gateway-gpt-luna' -and
    ($resumeStateLines | Where-Object {
      $_ -match '^gateway-base=http://127\.0\.0\.1:\d+$'
    }).Count -eq 1 -and
    $resumeStateLines -contains 'gateway-token=local-gateway' -and
    $resumeStateLines -contains 'gateway-mode=1' -and
    $resumeStateLines -contains 'anthropic-auth=' -and
    $resumeStateLines -contains 'anthropic-model=' -and
    $resumeStateLines -contains 'anthropic-api-key-present=0' -and
    $resumeStateLines -contains 'anthropic-custom-headers-present=0' -and
    $resumeStateLines -contains 'bedrock-provider-present=0' -and
    $resumeStateLines -contains 'vertex-provider-present=0' -and
    $resumeStateLines -contains 'foundry-provider-present=0' -and
    $gatewayOptionsLine -match '^gateway-options=.*gateway-' -and
    $gatewayOptionsLine -notmatch 'claude-'
  )

  Remove-Item -LiteralPath $state -Force -ErrorAction SilentlyContinue
  $freshRun = Invoke-Launcher @()
  $freshOutput = @($freshRun.Output)
  $freshExit = $freshRun.ExitCode
  $freshRestarted = $freshOutput -match 'restarting the resumed session once'
  $freshState = Test-Path -LiteralPath $state -PathType Leaf

  $report = [ordered]@{
    result = if (
      $resumeExit -eq 0 -and
      $resumeRestarted -and
      $resumeState -and
      $freshExit -eq 42 -and
      -not $freshRestarted -and
      $freshState -and
      $nativeCompactDisabled -and
      $gatewayIdentity
    ) { 'pass' } else { 'fail' }
    resumeExit = $resumeExit
    resumeRestarted = [bool]$resumeRestarted
    freshExit = $freshExit
    freshRestarted = [bool]$freshRestarted
    runnerStateCreated = [bool]($resumeState -and $freshState)
    nativeHarnessCompactionOnly = [bool]$nativeCompactDisabled
    gatewayIdentity = [bool]$gatewayIdentity
  }
  $report | ConvertTo-Json -Compress
  if ($report.result -ne 'pass') { exit 1 }
} finally {
  Remove-Item Env:CC_CLAUDE_RUNNER_OVERRIDE -ErrorAction SilentlyContinue
  Remove-Item Env:CC_FAKE_RUNNER_STATE -ErrorAction SilentlyContinue
  Remove-Item Env:CC_SKIP_GATEWAY_START -ErrorAction SilentlyContinue
  Remove-Item Env:TANDEM_GATEWAY_CODEX_HOME -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $state -Force -ErrorAction SilentlyContinue
}
