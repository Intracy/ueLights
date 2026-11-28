#!/bin/bash
# Entfernt den Autostart und beendet den Hintergrund-Server.
LABEL="de.uelights.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null && echo "Hintergrund-Server beendet."
rm -f "$PLIST"
echo "Autostart entfernt. Deine Daten in ~/Library/Application Support/ueLights bleiben erhalten."
