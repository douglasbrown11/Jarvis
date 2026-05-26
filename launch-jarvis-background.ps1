param(
  [int]$Port = 3080,
  [ValidateSet("auto", "edge", "chrome")]
  [string]$Browser = "auto"
)

function Test-PortListening {
  param(
    [int]$LocalPort
  )

  try {
    return [bool](Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction Stop)
  } catch {
    return $false
  }
}

function Get-BrowserPath {
  param(
    [string]$Requested
  )

  $edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
  $chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"

  if ($Requested -eq "edge" -and (Test-Path $edge)) {
    return $edge
  }

  if ($Requested -eq "chrome" -and (Test-Path $chrome)) {
    return $chrome
  }

  if (Test-Path $edge) {
    return $edge
  }

  if (Test-Path $chrome) {
    return $chrome
  }

  throw "No supported Chromium browser was found."
}

Set-Location $PSScriptRoot
$env:JARVIS_OPEN_BROWSER = "0"

if (-not (Test-PortListening -LocalPort $Port)) {
  Start-Process node -ArgumentList "server.js" -WorkingDirectory $PSScriptRoot -WindowStyle Hidden | Out-Null
}

$deadline = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $deadline) {
  try {
    Invoke-WebRequest -UseBasicParsing "http://localhost:$Port/api/config" | Out-Null
    break
  } catch {
    Start-Sleep -Milliseconds 300
  }
}

$browserPath = Get-BrowserPath -Requested $Browser
$url = "http://localhost:$Port/?autostart=1"
Start-Process $browserPath -ArgumentList "--app=$url"
