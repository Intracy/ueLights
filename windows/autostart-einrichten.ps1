<#
.SYNOPSIS
  Richtet ueLights so ein, dass es bei der Windows-Anmeldung unsichtbar im Hintergrund startet.

.DESCRIPTION
  Legt eine geplante Aufgabe "ueLights" an (Start bei Anmeldung, Neustart bei Absturz).
  Mit -Firewall werden zusätzlich Firewall-Regeln für die Web-App und Govee angelegt (Administratorrechte nötig).
  Logs: %LOCALAPPDATA%\ueLights\logs\uelights.log

.PARAMETER Port
  Port der Web-App (Standard 8787).

.PARAMETER Firewall
  Firewall-Regeln anlegen: TCP <Port> (Web-App im Heimnetz) und UDP 4002 (Govee-Antworten).
#>
[CmdletBinding()]
param(
  [int]$Port = 8787,
  [switch]$Firewall
)

$ErrorActionPreference = 'Stop'
$Start = Join-Path $PSScriptRoot 'start-uelights.ps1'
$TaskName = 'ueLights'

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Start`" -Port $Port -NoBrowser -Background" `
  -WorkingDirectory (Split-Path -Parent $PSScriptRoot)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description 'ueLights – StreamElements-Alerts auf lokale Lichter' -Force | Out-Null
Write-Host "Geplante Aufgabe '$TaskName' angelegt. ueLights startet ab jetzt bei jeder Anmeldung." -ForegroundColor Green

if ($Firewall) {
  $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $isAdmin) {
    Write-Host 'Für Firewall-Regeln dieses Skript als Administrator starten.' -ForegroundColor Yellow
  } else {
    Get-NetFirewallRule -DisplayName 'ueLights *' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName "ueLights Web-App (TCP $Port)" -Direction Inbound -Protocol TCP -LocalPort $Port -Profile Private -Action Allow | Out-Null
    New-NetFirewallRule -DisplayName 'ueLights Govee (UDP 4002)' -Direction Inbound -Protocol UDP -LocalPort 4002 -Profile Private -Action Allow | Out-Null
    Write-Host 'Firewall-Regeln für das private Netzwerk angelegt.' -ForegroundColor Green
  }
}

$answer = Read-Host 'ueLights jetzt im Hintergrund starten? (j/n)'
if ($answer -match '^[jJyY]') {
  Start-ScheduledTask -TaskName $TaskName
  Write-Host "Gestartet. Web-App: http://localhost:$Port" -ForegroundColor Cyan
}
