$startupDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"
$shortcutPath = Join-Path $startupDir "Jarvis Background.lnk"
$runKeyPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$runValueName = "JarvisTrayListener"
$taskName = "Jarvis Tray Listener"

if (Test-Path $shortcutPath) {
  Remove-Item -LiteralPath $shortcutPath
  Write-Host "Removed $shortcutPath" -ForegroundColor Yellow
} else {
  Write-Host "No Jarvis startup shortcut found." -ForegroundColor Yellow
}

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Host "Removed scheduled task $taskName" -ForegroundColor Yellow
} else {
  Write-Host "No Jarvis scheduled task found." -ForegroundColor Yellow
}

if (Get-ItemProperty -Path $runKeyPath -Name $runValueName -ErrorAction SilentlyContinue) {
  Remove-ItemProperty -Path $runKeyPath -Name $runValueName
  Write-Host "Removed Run key $runValueName" -ForegroundColor Yellow
} else {
  Write-Host "No Jarvis Run key found." -ForegroundColor Yellow
}
