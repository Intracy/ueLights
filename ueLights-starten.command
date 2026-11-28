#!/bin/bash
# Startet ueLights auf dem Mac (Doppelklick im Finder genügt).
# Optionen werden weitergereicht, z. B.:  ./ueLights-starten.command --port 8788 --rebuild
cd "$(dirname "$0")" || exit 1
exec /bin/bash ./mac/start-uelights.sh "$@"
