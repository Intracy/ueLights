#!/bin/bash
# Holt die neueste Version aus GitHub, baut neu und startet einen eingerichteten Autostart neu.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
LABEL="de.uelights.server"
command -v git >/dev/null 2>&1 || { echo "git fehlt (xcode-select --install) oder das Repo neu als ZIP laden."; exit 1; }

RUNNING=0
if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  RUNNING=1
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
fi

echo "» git pull"
git pull --ff-only || { echo "git pull fehlgeschlagen (lokale Änderungen?)."; exit 1; }
rm -f node_modules/.uelights-deps server/dist/.uelights-build
/bin/bash mac/start-uelights.sh --prepare-only

if [ "$RUNNING" = 1 ]; then
  launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$LABEL.plist"
  echo "Aktualisiert und im Hintergrund neu gestartet."
else
  echo "Aktualisiert. Starten per Doppelklick auf ueLights-starten.command"
fi
