#!/bin/bash
# Startet ueLights auf dem Mac.
#
# Prüft Node.js, installiert Abhängigkeiten, baut die App bei Bedarf und startet den Server.
# Daten (Einstellungen, Alerts, Protokoll) liegen in ~/Library/Application Support/ueLights.
#
# Optionen:
#   --port 8788     anderer Port (Standard 8787)
#   --no-browser    Browser nicht öffnen
#   --rebuild       neu bauen, auch ohne Änderungen
#   --background    Ausgabe in die Logdatei statt ins Fenster (für den Autostart)
#   --prepare-only  nur Node prüfen, installieren und bauen, nicht starten

set -u
PORT=8787
NO_BROWSER=0
REBUILD=0
BACKGROUND=0
PREPARE_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:-}"; shift 2 ;;
    --port=*) PORT="${1#*=}"; shift ;;
    --no-browser) NO_BROWSER=1; shift ;;
    --rebuild) REBUILD=1; shift ;;
    --background) BACKGROUND=1; NO_BROWSER=1; shift ;;
    --prepare-only) PREPARE_ONLY=1; NO_BROWSER=1; shift ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unbekannte Option: $1"; exit 2 ;;
  esac
done
case "$PORT" in ''|*[!0-9]*) echo "Ungültiger Port: $PORT"; exit 2 ;; esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

DATA_DIR_DEFAULT="$HOME/Library/Application Support/ueLights"
[ "$(uname -s)" = "Darwin" ] || DATA_DIR_DEFAULT="$HOME/.local/share/ueLights"
DATA_DIR="${DATA_DIR:-$DATA_DIR_DEFAULT}"
LOG_DIR="$HOME/Library/Logs/ueLights"
[ "$(uname -s)" = "Darwin" ] || LOG_DIR="$DATA_DIR/logs"
LOG_FILE="$LOG_DIR/uelights.log"
mkdir -p "$DATA_DIR" "$LOG_DIR"
chmod 700 "$DATA_DIR" 2>/dev/null

# launchd und Doppelklick starten mit kargem PATH: Homebrew, nvm, Volta, fnm ergänzen
for p in /opt/homebrew/bin /usr/local/bin "$HOME/.volta/bin" "$HOME/.local/bin"; do
  [ -d "$p" ] && case ":$PATH:" in *":$p:"*) ;; *) PATH="$p:$PATH" ;; esac
done
if ! command -v node >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
fi
export PATH

if [ -t 1 ] && [ "$BACKGROUND" = 0 ]; then
  C_STEP=$'\033[35m'; C_ERR=$'\033[31m'; C_OK=$'\033[36m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
else
  C_STEP=; C_ERR=; C_OK=; C_DIM=; C_OFF=
fi

step() {
  if [ "$BACKGROUND" = 1 ]; then echo "$(date '+%Y-%m-%dT%H:%M:%S')  $*" >> "$LOG_FILE"
  else echo "${C_STEP}» $*${C_OFF}"; fi
}

fail() {
  if [ "$BACKGROUND" = 1 ]; then
    echo "$(date '+%Y-%m-%dT%H:%M:%S')  FEHLER: $*" >> "$LOG_FILE"
  else
    echo
    echo "${C_ERR}FEHLER: $*${C_OFF}"
    [ -t 0 ] && read -r -p "Enter zum Beenden " _
  fi
  exit 1
}

# ------------------------------------------------------------------ Node.js
node_major() {
  command -v node >/dev/null 2>&1 || { echo 0; return; }
  node --version | sed -E 's/^v([0-9]+).*/\1/'
}

MAJOR="$(node_major)"
if [ "$MAJOR" -lt 20 ]; then
  [ "$BACKGROUND" = 1 ] && fail "Node.js 20 oder neuer fehlt. Bitte einmal ueLights-starten.command per Doppelklick ausführen."
  echo "Node.js 20 oder neuer wird benötigt (gefunden: ${MAJOR})."
  if command -v brew >/dev/null 2>&1; then
    read -r -p "Jetzt Node.js über Homebrew installieren? (j/n) " answer
    case "$answer" in
      [jJyY]*) brew install node@22 && brew link --overwrite --force node@22 ;;
    esac
    hash -r
    MAJOR="$(node_major)"
  fi
  if [ "$MAJOR" -lt 20 ]; then
    echo "Node.js LTS gibt es als Installer auf https://nodejs.org (Datei .pkg)."
    command -v open >/dev/null 2>&1 && open "https://nodejs.org/de/download"
    fail "Bitte Node.js installieren und das Skript erneut starten."
  fi
fi
step "Node.js $(node --version) gefunden"

hash_stdin() { if command -v shasum >/dev/null 2>&1; then shasum -a 256; else sha256sum; fi | cut -d' ' -f1; }

# ------------------------------------------------------------------ Abhängigkeiten
STAMP_DEPS="node_modules/.uelights-deps"
LOCK_HASH="$(hash_stdin < package-lock.json)"
if [ ! -f "$STAMP_DEPS" ] || [ "$(cat "$STAMP_DEPS")" != "$LOCK_HASH" ]; then
  step "Installiere Abhängigkeiten (einmalig, dauert etwas) ..."
  if [ "$BACKGROUND" = 1 ]; then npm ci --no-audit --no-fund >> "$LOG_FILE" 2>&1; else npm ci --no-audit --no-fund; fi \
    || fail "npm ci ist fehlgeschlagen."
  echo "$LOCK_HASH" > "$STAMP_DEPS"
  REBUILD=1
fi

# ------------------------------------------------------------------ Bauen
source_hash() {
  # Pfad, Größe und Änderungszeit aller Quelldateien (macOS- und GNU-stat)
  if stat --version >/dev/null 2>&1; then STAT_FMT=(-c '%n %s %Y'); else STAT_FMT=(-f '%N %z %m'); fi
  find packages/shared/src server/src web/src web/public web/index.html -type f 2>/dev/null | LC_ALL=C sort |
    while IFS= read -r f; do stat "${STAT_FMT[@]}" "$f"; done | hash_stdin
}

STAMP_BUILD="server/dist/.uelights-build"
SRC_HASH="$(source_hash)"
if [ "$REBUILD" = 1 ] || [ ! -f server/dist/index.js ] || [ ! -f web/dist/index.html ] ||
   [ ! -f "$STAMP_BUILD" ] || [ "$(cat "$STAMP_BUILD")" != "$SRC_HASH" ]; then
  step "Baue ueLights ..."
  if [ "$BACKGROUND" = 1 ]; then npm run build >> "$LOG_FILE" 2>&1; else npm run build; fi \
    || fail "Build ist fehlgeschlagen."
  echo "$SRC_HASH" > "$STAMP_BUILD"
fi
if [ "$PREPARE_ONLY" = 1 ]; then step "ueLights ist gebaut und startbereit."; exit 0; fi

# ------------------------------------------------------------------ Starten
URL="http://localhost:$PORT"

port_busy() {
  if command -v lsof >/dev/null 2>&1; then lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1
  else (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; fi
}

open_browser() {
  if command -v open >/dev/null 2>&1; then open "$1"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$1" >/dev/null 2>&1; fi
}

if port_busy; then
  if curl -fsS -m 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    step "ueLights läuft bereits auf $URL"
    [ "$NO_BROWSER" = 0 ] && open_browser "$URL"
    exit 0
  fi
  fail "Port $PORT ist von einem anderen Programm belegt. Mit --port 8788 starten."
fi

export PORT HOST=0.0.0.0 DATA_DIR WEB_DIR="$ROOT/web/dist" NODE_ENV=production

step "Starte ueLights auf $URL (Daten: $DATA_DIR)"

if [ "$NO_BROWSER" = 0 ]; then
  # Browser öffnen, sobald der Server antwortet
  (
    for _ in $(seq 1 60); do
      if curl -fsS -m 1 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then open_browser "$URL"; break; fi
      sleep 0.5
    done
  ) &
fi

if [ "$BACKGROUND" = 1 ]; then
  # Logdatei klein halten
  if [ -f "$LOG_FILE" ] && [ "$(wc -c < "$LOG_FILE")" -gt 5242880 ]; then mv -f "$LOG_FILE" "$LOG_FILE.1"; fi
  exec node server/dist/index.js >> "$LOG_FILE" 2>&1
fi

IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || hostname -I 2>/dev/null | cut -d' ' -f1)"
echo
echo "${C_OK}  ueLights läuft:  $URL${C_OFF}"
[ -n "$IP" ] && echo "${C_OK}  Im Heimnetz:     http://$IP:$PORT${C_OFF}"
echo "${C_DIM}  Beenden:         ctrl+C oder Fenster schließen${C_OFF}"
echo
exec node server/dist/index.js
