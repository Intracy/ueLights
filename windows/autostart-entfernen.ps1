<#
.SYNOPSIS
  Entfernt den ueLights-Autostart und beendet einen laufenden Hintergrund-Server.
  Daten in %LOCALAPPDATA%\ueLights bleiben erhalten.
#>
$ErrorActionPreference = 'Stop'
$TaskName = 'ueLights'

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Autostart '$TaskName' entfernt." -ForegroundColor Green
} else {
  Write-Host 'Kein Autostart eingerichtet.'
}

$root = Split-Path -Parent $PSScriptRoot
$procs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -like '*server\dist\index.js*' -and $_.CommandLine -notlike '*--inspect*' }
foreach ($p in $procs) {
  Stop-Process -Id $p.ProcessId -Force
  Write-Host "ueLights-Prozess $($p.ProcessId) beendet."
}
if (Get-NetFirewallRule -DisplayName 'ueLights *' -ErrorAction SilentlyContinue) {
  Write-Host 'Hinweis: Firewall-Regeln "ueLights *" bestehen noch (als Administrator mit Remove-NetFirewallRule entfernen).' -ForegroundColor DarkGray
}
