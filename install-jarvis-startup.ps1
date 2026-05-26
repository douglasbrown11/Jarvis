param(
  [string]$OpenAIApiKey,
  [string]$AnthropicApiKey,
  [switch]$SkipApiKeyPrompt
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

$OpenAIApiKey = Normalize-ApiKey -Key $OpenAIApiKey
$AnthropicApiKey = Normalize-ApiKey -Key $AnthropicApiKey

if (-not $SkipApiKeyPrompt -and -not $OpenAIApiKey -and -not $AnthropicApiKey -and -not [Environment]::GetEnvironmentVariable("OPENAI_API_KEY", "User") -and -not [Environment]::GetEnvironmentVariable("ANTHROPIC_API_KEY", "User")) {
  $secureKey = Read-Host "Enter an OpenAI API key to save for Jarvis startup, or press Enter to skip" -AsSecureString
  $OpenAIApiKey = Normalize-ApiKey -Key (ConvertTo-PlainText -SecureString $secureKey)
}

if ($OpenAIApiKey) {
  [Environment]::SetEnvironmentVariable("OPENAI_API_KEY", $OpenAIApiKey, "User")
}

if ($AnthropicApiKey) {
  [Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY", $AnthropicApiKey, "User")
}

$startupDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"
$shortcutPath = Join-Path $startupDir "Jarvis Background.lnk"
$powershellPath = Join-Path $PSHOME "powershell.exe"
$scriptPath = Join-Path $PSScriptRoot "launch-jarvis-tray.ps1"
$arguments = "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`" -Hidden"
$runKeyPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$runValueName = "JarvisTrayListener"
$taskName = "Jarvis Tray Listener"

if (Test-Path $shortcutPath) {
  Remove-Item -LiteralPath $shortcutPath -Force
}

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

$runCommand = "`"$powershellPath`" $arguments"
New-Item -Path $runKeyPath -Force | Out-Null
Set-ItemProperty -Path $runKeyPath -Name $runValueName -Value $runCommand

Write-Host "Run key created: $runValueName" -ForegroundColor Green
Write-Host "Jarvis will attempt to start automatically at login." -ForegroundColor Green
