param(
  [string]$OpenAIApiKey,
  [string]$AnthropicApiKey,
  [switch]$NoBrowser,
  [switch]$PromptForOpenAI
)

function ConvertTo-PlainText {
  param(
    [Security.SecureString]$SecureString
  )

  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureString)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

function Normalize-ApiKey {
  param(
    [string]$Key
  )

  if (-not $Key) {
    return $null
  }

  return ($Key -replace "\s", "").Trim()
}

Set-Location $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Node.js is not installed or not available on PATH."
  exit 1
}

if ($PromptForOpenAI -or (-not $OpenAIApiKey -and -not $AnthropicApiKey -and -not $env:OPENAI_API_KEY -and -not $env:ANTHROPIC_API_KEY)) {
  $secureKey = Read-Host "Enter your OpenAI API key" -AsSecureString
  $OpenAIApiKey = ConvertTo-PlainText -SecureString $secureKey
}

$OpenAIApiKey = Normalize-ApiKey -Key $OpenAIApiKey
$AnthropicApiKey = Normalize-ApiKey -Key $AnthropicApiKey
$env:OPENAI_API_KEY = Normalize-ApiKey -Key $env:OPENAI_API_KEY
$env:ANTHROPIC_API_KEY = Normalize-ApiKey -Key $env:ANTHROPIC_API_KEY

if ($OpenAIApiKey) {
  $env:OPENAI_API_KEY = $OpenAIApiKey
}

if ($AnthropicApiKey) {
  $env:ANTHROPIC_API_KEY = $AnthropicApiKey
}

if (-not $env:OPENAI_API_KEY -and -not $env:ANTHROPIC_API_KEY) {
  Write-Error "No API key is available. Supply -OpenAIApiKey, -AnthropicApiKey, or let the script prompt you."
  exit 1
}

if ($NoBrowser) {
  $env:JARVIS_OPEN_BROWSER = "0"
}

Write-Host "Starting Jarvis from $PSScriptRoot" -ForegroundColor Cyan
node server.js
