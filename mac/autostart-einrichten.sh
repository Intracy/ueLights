#!/bin/bash
# Richtet ueLights so ein, dass es bei der Mac-Anmeldung unsichtbar im Hintergrund startet
# (LaunchAgent, Neustart nach Absturz). Logs: ~/Library/Logs/ueLights/uelights.log
#
#   ./mac/autostart-einrichten.sh            Port 8787
#   ./mac/autostart-einrichten.sh --port 8788
set -eu
PORT=8787
[ "${1:-}" = "--port" ] && PORT="${2:?Port fehlt}"
case "$PORT" in ''|*[!0-9]*) echo "Ungültiger Port: $PORT"; exit 2 ;; esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="de.uelights.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/ueLights"
mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

# Einmal im Vordergrund vorbereiten (Node prüfen, installieren, bauen), ohne zu starten
echo "» Prüfe Node.js und baue ueLights ..."
/bin/bash "$ROOT/mac/start-uelights.sh" --prepare-only || { echo "Vorbereitung fehlgeschlagen, Autostart nicht eingerichtet."; exit 1; }

xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
R="$(xml_escape "$ROOT")"
L="$(xml_escape "$LOG_DIR")"

cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$R/mac/start-uelights.sh</string>
    <string>--port</string><string>$PORT</string>
    <string>--background</string>
  </array>
  <key>WorkingDirectory</key><string>$R</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$L/launchd.log</string>
  <key>StandardErrorPath</key><string>$L/launchd.log</string>
</dict>
</plist>
PL

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Autostart eingerichtet: ueLights startet ab jetzt bei jeder Anmeldung und läuft schon."
echo "Web-App: http://localhost:$PORT"
echo "Hinweis: Fragt macOS nach Zugriff auf Geräte im lokalen Netzwerk, bitte erlauben."
