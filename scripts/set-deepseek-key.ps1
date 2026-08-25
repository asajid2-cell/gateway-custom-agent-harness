param(
  [switch]$SkipApiTest
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$EnvPath = Join-Path $Root '.env.deepseek.local'

function Convert-SecureStringToPlainText {
  param([Security.SecureString]$SecureString)

  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureString)
  try {
    [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  }
}

function Read-EnvFile {
  param([string]$Path)

  $vars = [ordered]@{}
  if (Test-Path $Path) {
    Get-Content $Path | ForEach-Object {
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
      $vars[$name] = $value
    }
  }
  return $vars
}

function Set-Default {
  param(
    [System.Collections.Specialized.OrderedDictionary]$Vars,
    [string]$Name,
    [string]$Value
  )

  if (-not $Vars.Contains($Name) -or [string]::IsNullOrWhiteSpace($Vars[$Name])) {
    $Vars[$Name] = $Value
  }
}

$secureKey = Read-Host 'Paste new DeepSeek API key' -AsSecureString
$key = Convert-SecureStringToPlainText $secureKey

if ([string]::IsNullOrWhiteSpace($key)) {
  throw 'No key entered.'
}

$vars = Read-EnvFile $EnvPath
$vars['DEEPSEEK_API_KEY'] = $key.Trim()
Set-Default $vars 'ANTHROPIC_BASE_URL' 'https://api.deepseek.com/anthropic'
Set-Default $vars 'ANTHROPIC_MODEL' 'deepseek-v4-pro[1m]'
Set-Default $vars 'ANTHROPIC_DEFAULT_OPUS_MODEL' 'deepseek-v4-pro[1m]'
Set-Default $vars 'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME' 'DeepSeek V4 Pro'
Set-Default $vars 'ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION' 'DeepSeek V4 Pro with 1M context'
Set-Default $vars 'ANTHROPIC_DEFAULT_SONNET_MODEL' 'deepseek-v4-pro[1m]'
Set-Default $vars 'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME' 'DeepSeek V4 Pro'
Set-Default $vars 'ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION' 'DeepSeek V4 Pro with 1M context'
Set-Default $vars 'ANTHROPIC_DEFAULT_HAIKU_MODEL' 'deepseek-v4-flash'
Set-Default $vars 'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME' 'DeepSeek V4 Flash'
Set-Default $vars 'ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION' 'DeepSeek V4 Flash for quick work and subagents'
Set-Default $vars 'CLAUDE_CODE_SUBAGENT_MODEL' 'deepseek-v4-flash'
Set-Default $vars 'CLAUDE_CODE_EFFORT_LEVEL' 'max'

$orderedKeys = @(
  'DEEPSEEK_API_KEY',
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
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_EFFORT_LEVEL'
)

$lines = foreach ($name in $orderedKeys) {
  if ($vars.Contains($name)) {
    "$name=$($vars[$name])"
  }
}

Set-Content -Path $EnvPath -Value $lines -Encoding utf8
Write-Host "Saved DeepSeek key to $EnvPath"

if ($SkipApiTest) {
  Write-Host 'Skipped API test.'
  exit 0
}

$body = @{
  model = 'deepseek-v4-flash'
  max_tokens = 8
  messages = @(
    @{
      role = 'user'
      content = 'Reply with OK only.'
    }
  )
} | ConvertTo-Json -Depth 6

try {
  $response = Invoke-RestMethod `
    -Method Post `
    -Uri 'https://api.deepseek.com/anthropic/v1/messages' `
    -Headers @{
      Authorization = "Bearer $($vars['DEEPSEEK_API_KEY'])"
      'anthropic-version' = '2023-06-01'
      'content-type' = 'application/json'
    } `
    -Body $body `
    -TimeoutSec 30

  $text = $response.content[0].text
  Write-Host "DeepSeek API test passed: $text"
  Write-Host 'Run claudex with: bun run deepseek'
} catch {
  $status = $null
  if ($_.Exception.Response) {
    $status = [int]$_.Exception.Response.StatusCode
  }

  Write-Host "DeepSeek API test failed. HTTP status: $status" -ForegroundColor Red
  Write-Host 'The key was saved, but DeepSeek rejected the test request. Check that the key is active and has API credits.' -ForegroundColor Red
  exit 1
}
