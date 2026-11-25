@echo off
chcp 65001 >nul
title ueLights
rem Startet ueLights unter Windows (Doppelklick genuegt).
rem Optionen werden weitergereicht, z. B.:  ueLights-starten.bat -Port 8788 -Rebuild
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\start-uelights.ps1" %*
if errorlevel 1 pause
