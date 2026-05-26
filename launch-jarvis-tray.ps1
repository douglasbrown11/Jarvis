param(
  [switch]$Hidden
)

Set-Location $PSScriptRoot

$electronCmd = Join-Path $PSScriptRoot "node_modules\.bin\electron.cmd"
if (-not (Test-Path $electronCmd)) {
  Write-Error "Electron is not installed. Run npm install in this folder first."
  exit 1
}

if ($Hidden) {
  Start-Process $electronCmd -ArgumentList "." -WorkingDirectory $PSScriptRoot -WindowStyle Hidden | Out-Null
  exit 0
}

& $electronCmd .
