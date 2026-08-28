param(
  [switch]$Build
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$EnvPath = Join-Path $Root '.env.deepseek.local'

$InheritedEnvToClear = @(
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_EFFORT_LEVEL'
)

foreach ($Name in $InheritedEnvToClear) {
  [Environment]::SetEnvironmentVariable($Name, $null, 'Process')
}

function Set-DefaultEnv {
  param(
    [string]$Name,
    [string]$Value
  )

  if (-not [Environment]::GetEnvironmentVariable($Name, 'Process')) {
    [Environment]::SetEnvironmentVariable($Name, $Value, 'Process')
  }
}

if (Test-Path $EnvPath) {
  Get-Content $EnvPath | ForEach-Object {
    $line = $_.Trim()
    if ($line.Length -eq 0 -or $line.StartsWith('#')) {
      return
    }

    $separator = $line.IndexOf('=')
    if ($separator -le 0) {
      return
    }

    $name = $line.Substring(0, $separator).Trim()
    $value = $line.Substring($separator + 1).Trim()

    if (
      ($value.StartsWith('"') -and $value.EndsWith('"')) -or
      ($value.StartsWith("'") -and $value.EndsWith("'"))
    ) {
      $value = $value.Substring(1, $value.Length - 2)
    }

    [Environment]::SetEnvironmentVariable($name, $value, 'Process')
  }
}

if (-not $env:DEEPSEEK_API_KEY) {
  throw 'DEEPSEEK_API_KEY is not set. Put it in .env.deepseek.local or in your shell environment.'
}

[Environment]::SetEnvironmentVariable('GATEWAY_PROVIDER', 'deepseek', 'Process')
[Environment]::SetEnvironmentVariable('CLAUDEX_PROVIDER', $env:GATEWAY_PROVIDER, 'Process')
[Environment]::SetEnvironmentVariable('ANTHROPIC_BASE_URL', 'https://api.deepseek.com/anthropic', 'Process')
Set-DefaultEnv 'ANTHROPIC_MODEL' 'deepseek-v4-pro[1m]'
Set-DefaultEnv 'ANTHROPIC_DEFAULT_OPUS_MODEL' 'deepseek-v4-pro[1m]'
Set-DefaultEnv 'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME' 'DeepSeek V4 Pro'
Set-DefaultEnv 'ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION' 'DeepSeek V4 Pro with 1M context'
Set-DefaultEnv 'ANTHROPIC_DEFAULT_SONNET_MODEL' 'deepseek-v4-pro[1m]'
Set-DefaultEnv 'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME' 'DeepSeek V4 Pro'
Set-DefaultEnv 'ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION' 'DeepSeek V4 Pro with 1M context'
Set-DefaultEnv 'ANTHROPIC_DEFAULT_HAIKU_MODEL' 'deepseek-v4-flash'
Set-DefaultEnv 'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME' 'DeepSeek V4 Flash'
Set-DefaultEnv 'ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION' 'DeepSeek V4 Flash for quick work and subagents'
Set-DefaultEnv 'CLAUDE_CODE_SUBAGENT_MODEL' 'deepseek-v4-flash'
Set-DefaultEnv 'CLAUDE_CODE_EFFORT_LEVEL' 'max'

Push-Location $Root
try {
  $CliPath = Join-Path $Root 'dist\cli.js'
  if ($Build -or -not (Test-Path $CliPath)) {
    bun run build
  }

  bun $CliPath @args
} finally {
  Pop-Location
}
