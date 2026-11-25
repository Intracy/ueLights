<#
.SYNOPSIS
  Holt die neueste Version aus GitHub, baut neu und startet einen eingerichteten Autostart neu.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Host 'git fehlt. Entweder Git installieren (winget install Git.Git) oder das Repo neu als ZIP laden.' -ForegroundColor Yellow
  exit 1
}

$task = Get-ScheduledTask -TaskName 'ueLights' -ErrorAction SilentlyContinue
if ($task) { Stop-ScheduledTask -TaskName 'ueLights' -ErrorAction SilentlyContinue }

Write-Host '» git pull' -ForegroundColor Magenta
& git pull --ff-only
if ($LASTEXITCODE -ne 0) { Write-Host 'git pull fehlgeschlagen (lokale Änderungen?).' -ForegroundColor Red; exit 1 }

Write-Host '» Abhängigkeiten und Build' -ForegroundColor Magenta
& npm ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { exit 1 }
& npm run build
if ($LASTEXITCODE -ne 0) { exit 1 }
Remove-Item -Force -ErrorAction SilentlyContinue 'node_modules\.uelights-deps', 'server\dist\.uelights-build'

if ($task) {
  Start-ScheduledTask -TaskName 'ueLights'
  Write-Host 'Aktualisiert und im Hintergrund neu gestartet.' -ForegroundColor Green
} else {
  Write-Host 'Aktualisiert. Starten mit ueLights-starten.bat' -ForegroundColor Green
}
