param(
  [switch]$Build
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$LaunchDirectory = (Get-Location).Path
$BridgeScript = Join-Path $PSScriptRoot 'codex-subscription-bridge.mjs'
$CliPath = Join-Path $Root 'dist\cli.js'
$Model = 'gpt-6-luna'
$BridgeToken = 'local-luna'
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

# Resolve at launch time; do not trust CODEX_HOME inherited from an old shell or resumed session.
$env:CODEX_HOME = Resolve-SelectedCodexHome

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

# A rewound session can leave its bridge alive. Reuse 4011 when possible, but
# never attach a new Claude process to an unrelated or stale listener.
$Port = 4011
$probe = [System.Net.Sockets.TcpClient]::new()
try {
  $probe.Connect('127.0.0.1', $Port)
  $Port = Get-FreeLoopbackPort
} catch {
  # The preferred port is available.
} finally {
  $probe.Dispose()
}

$StdoutLog = Join-Path $env:TEMP "gateway-luna-$PID-$Port.out.log"
$StderrLog = Join-Path $env:TEMP "gateway-luna-$PID-$Port.err.log"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js is required for the Gateway Luna bridge.'
}
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    throw 'Bun is required to run the Gateway CLI.'
}
if (-not (Test-Path -LiteralPath $BridgeScript)) {
  throw "Luna bridge is missing: $BridgeScript"
}

$env:GATEWAY_PROVIDER = 'openai-codex'
$env:CLAUDEX_PROVIDER = $env:GATEWAY_PROVIDER
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:$Port"
$env:ANTHROPIC_AUTH_TOKEN = $null
$env:ANTHROPIC_API_KEY = $BridgeToken
$env:CLAUDE_CODE_OAUTH_TOKEN = $null
$env:ANTHROPIC_MODEL = $Model
$env:ANTHROPIC_DEFAULT_OPUS_MODEL = $Model
$env:ANTHROPIC_DEFAULT_SONNET_MODEL = $Model
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL = $Model
$env:CLAUDE_CODE_SUBAGENT_MODEL = $Model
$env:CLAUDE_CODE_EFFORT_LEVEL = 'max'
$env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
$env:LUNA_MODEL = $Model
$env:LUNA_REASONING_EFFORT = 'max'
$env:LUNA_BRIDGE_TOKEN = $BridgeToken

$bridge = Start-Process `
  -FilePath 'node.exe' `
  -ArgumentList @($BridgeScript, '--port', "$Port") `
  -WindowStyle Hidden `
  -RedirectStandardOutput $StdoutLog `
  -RedirectStandardError $StderrLog `
  -PassThru

try {
  $healthy = $false
  for ($i = 0; $i -lt 30; $i++) {
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 1
      if ($health.status -eq 'ok' -and $health.model -eq $Model) {
        $healthy = $true
        break
      }
    } catch {
      Start-Sleep -Milliseconds 250
    }
  }
  if (-not $healthy) {
    $detail = if (Test-Path -LiteralPath $StderrLog) {
      Get-Content -Raw -LiteralPath $StderrLog
    } else {
      ''
    }
    throw "Luna bridge did not become healthy. $detail"
  }

  Push-Location $Root
  try {
    if ($Build -or -not (Test-Path -LiteralPath $CliPath)) {
      & bun run build
      if ($LASTEXITCODE -ne 0) {
        throw "Gateway CLI build failed with exit code $LASTEXITCODE."
      }
    }
  } finally {
    Pop-Location
  }

  # Claude resolves session transcripts from the current project directory.
  # Keep the caller's directory so --resume uses the same project namespace
  # as the original session.
  Push-Location $LaunchDirectory
  try {
    & bun $CliPath @args
    exit $LASTEXITCODE
  } finally {
    Pop-Location
  }
} finally {
  if ($bridge -and -not $bridge.HasExited) {
    Stop-Process -Id $bridge.Id -Force -ErrorAction SilentlyContinue
  }
}
