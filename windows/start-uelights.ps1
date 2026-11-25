<#
.SYNOPSIS
  Startet ueLights auf einem Windows-Rechner.

.DESCRIPTION
  Prüft Node.js, installiert Abhängigkeiten, baut die App bei Bedarf und startet den Server.
  Daten (Einstellungen, Alerts, Protokoll) liegen in %LOCALAPPDATA%\ueLights.

.PARAMETER Port
  Port der Web-App (Standard 8787).

.PARAMETER NoBrowser
  Browser nach dem Start nicht öffnen (für Autostart).

.PARAMETER Rebuild
  App neu bauen, auch wenn sich nichts geändert hat.

.PARAMETER Background
  Ausgabe in eine Logdatei statt ins Fenster schreiben (für Autostart).
#>
[CmdletBinding()]
param(
  [int]$Port = 8787,
  [switch]$NoBrowser,
  [switch]$Rebuild,
  [switch]$Background
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$DataDir = Join-Path $env:LOCALAPPDATA 'ueLights'
$LogDir = Join-Path $DataDir 'logs'
New-Item -ItemType Directory -Force -Path $DataDir, $LogDir | Out-Null
$LogFile = Join-Path $LogDir 'uelights.log'

function Write-Step([string]$Text) {
  if ($Background) { Add-Content -Path $LogFile -Value "$(Get-Date -Format s)  $Text" }
  else { Write-Host "» $Text" -ForegroundColor Magenta }
}

function Fail([string]$Text) {
  if ($Background) { Add-Content -Path $LogFile -Value "$(Get-Date -Format s)  FEHLER: $Text" }
  else {
    Write-Host ''
    Write-Host "FEHLER: $Text" -ForegroundColor Red
    Read-Host 'Enter zum Beenden'
  }
  exit 1
}

# ------------------------------------------------------------------ Node.js
function Get-NodeMajor {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { return 0 }
  $v = (& node --version) -replace '^v', ''
  return [int]($v.Split('.')[0])
}

$major = Get-NodeMajor
if ($major -lt 20) {
  if ($Background) { Fail 'Node.js 20 oder neuer fehlt. Bitte einmal ueLights-starten.bat im Vordergrund ausführen.' }
  Write-Host 'Node.js 20 oder neuer wird benötigt.' -ForegroundColor Yellow
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget) {
    $answer = Read-Host 'Jetzt Node.js LTS über winget installieren? (j/n)'
    if ($answer -match '^[jJyY]') {
      & winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
      # PATH der laufenden Sitzung aktualisieren
      $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
      $major = Get-NodeMajor
    }
  }
  if ($major -lt 20) { Fail 'Bitte Node.js LTS von https://nodejs.org installieren und das Skript erneut starten.' }
}
Write-Step "Node.js $(& node --version) gefunden"

# ------------------------------------------------------------------ Abhängigkeiten
$lock = Join-Path $Root 'package-lock.json'
$stampDeps = Join-Path $Root 'node_modules\.uelights-deps'
$lockHash = (Get-FileHash $lock -Algorithm SHA256).Hash
$needInstall = -not (Test-Path $stampDeps) -or ((Get-Content $stampDeps -Raw).Trim() -ne $lockHash)
if ($needInstall) {
  Write-Step 'Installiere Abhängigkeiten (einmalig, dauert etwas) ...'
  & npm ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Fail 'npm ci ist fehlgeschlagen.' }
  Set-Content -Path $stampDeps -Value $lockHash
  $Rebuild = $true
}

# ------------------------------------------------------------------ Bauen
function Get-SourceHash {
  $files = Get-ChildItem -Recurse -File -Path 'packages\shared\src', 'server\src', 'web\src', 'web\public', 'web\index.html' |
    Sort-Object FullName
  $sb = New-Object System.Text.StringBuilder
  foreach ($f in $files) { [void]$sb.Append($f.FullName).Append($f.Length).Append($f.LastWriteTimeUtc.Ticks) }
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($sb.ToString())
  $sha = [System.Security.Cryptography.SHA256]::Create()
  return [BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', ''
}

$stampBuild = Join-Path $Root 'server\dist\.uelights-build'
$srcHash = Get-SourceHash
$needBuild = $Rebuild -or -not (Test-Path 'server\dist\index.js') -or -not (Test-Path 'web\dist\index.html') -or
  -not (Test-Path $stampBuild) -or ((Get-Content $stampBuild -Raw).Trim() -ne $srcHash)
if ($needBuild) {
  Write-Step 'Baue ueLights ...'
  & npm run build
  if ($LASTEXITCODE -ne 0) { Fail 'Build ist fehlgeschlagen.' }
  Set-Content -Path $stampBuild -Value $srcHash
}

# ------------------------------------------------------------------ Starten
$env:PORT = "$Port"
$env:HOST = '0.0.0.0'
$env:DATA_DIR = $DataDir
$env:WEB_DIR = Join-Path $Root 'web\dist'
$env:NODE_ENV = 'production'

$busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($busy) { Fail "Port $Port ist schon belegt. Läuft ueLights bereits? Sonst mit -Port 8788 starten." }

$url = "http://localhost:$Port"
Write-Step "Starte ueLights auf $url (Daten: $DataDir)"

if (-not $NoBrowser -and -not $Background) {
  # Browser öffnen, sobald der Server antwortet
  Start-Job -ArgumentList $url -ScriptBlock {
    param($u)
    for ($i = 0; $i -lt 60; $i++) {
      try { Invoke-WebRequest -UseBasicParsing -Uri "$u/api/health" -TimeoutSec 1 | Out-Null; Start-Process $u; break }
      catch { Start-Sleep -Milliseconds 500 }
    }
  } | Out-Null
}

$ErrorActionPreference = 'Continue'  # stderr von node darf das Skript nicht abbrechen
if ($Background) {
  # Logdatei klein halten
  if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt 5MB) { Move-Item $LogFile "$LogFile.1" -Force }
  & node 'server\dist\index.js' *>> $LogFile
} else {
  Write-Host ''
  Write-Host "  ueLights läuft:  $url" -ForegroundColor Cyan
  Write-Host '  Im Heimnetz:     http://<IP dieses PCs>:' -NoNewline -ForegroundColor Cyan; Write-Host $Port -ForegroundColor Cyan
  Write-Host '  Beenden:         Strg+C oder Fenster schließen' -ForegroundColor DarkGray
  Write-Host ''
  & node 'server\dist\index.js'
}
exit $LASTEXITCODE
