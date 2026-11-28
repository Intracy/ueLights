#!/bin/bash
# ueLights auf der Synology (oder jedem Linux mit Docker) installieren und aktuell halten.
#
# Für den DSM-Aufgabenplaner gedacht (Benutzer: root). Ablauf:
#   1. neuesten Stand von GitHub abfragen (nur ein kleiner API-Aufruf)
#   2. ist er neu: Quellcode laden, Docker-Image bauen, Container neu starten
#   3. Health-Check; schlägt er fehl, wird automatisch die vorige Version wiederhergestellt
# Ohne neuen Stand passiert nichts, außer der Container läuft nicht – dann wird er gestartet.
#
# Optionen:
#   --force    neu bauen, auch wenn sich auf GitHub nichts geändert hat
#   --branch X anderen Branch verwenden (Standard: main)
#
# Ordner (Standard: der Ordner dieses Skripts, z. B. /volume1/docker/uelights):
#   app/                 Quellcode der aktuellen Version (wird bei jedem Update ersetzt)
#   data/                Einstellungen, Alerts, Protokoll – bleibt immer erhalten
#   .env                 optionale Einstellungen (PORT, UELIGHTS_PASSWORD, SE_JWT, HA_TOKEN)
#   docker-compose.yml   wird beim ersten Lauf angelegt, danach nicht mehr verändert
#   logs/update.log      Protokoll dieses Skripts

set -u
REPO="Intracy/ueLights"
BRANCH="main"
FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    --branch) BRANCH="${2:?Branch fehlt}"; shift 2 ;;
    -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unbekannte Option: $1"; exit 2 ;;
  esac
done

BASE="${UELIGHTS_BASE:-$(cd "$(dirname "$0")" && pwd)}"
IMAGE="uelights"
NAME="uelights"
mkdir -p "$BASE/data" "$BASE/logs"
chmod 700 "$BASE/data"
LOG="$BASE/logs/update.log"
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 1048576 ]; then mv -f "$LOG" "$LOG.1"; fi

# Synology: docker liegt unter /usr/local/bin, das fehlt im PATH des Aufgabenplaners
PATH="/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:$PATH"
export PATH

log() { echo "$(date '+%Y-%m-%d %H:%M:%S')  $*" | tee -a "$LOG"; }
die() { log "FEHLER: $*"; exit 1; }

# Nur eine Instanz gleichzeitig
LOCK="$BASE/.update.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +60 2>/dev/null)" ]; then rm -rf "$LOCK"; mkdir "$LOCK"
  else log "Ein Update läuft bereits – übersprungen."; exit 0; fi
fi
TMP=""
cleanup() { rm -rf "$LOCK"; [ -n "$TMP" ] && rm -rf "$TMP"; }
trap cleanup EXIT

command -v docker >/dev/null 2>&1 || die "docker nicht gefunden. Ist der Container Manager installiert?"
docker info >/dev/null 2>&1 || die "Docker antwortet nicht. Läuft die Aufgabe als root?"
command -v curl >/dev/null 2>&1 || die "curl nicht gefunden."

if docker compose version >/dev/null 2>&1; then COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then COMPOSE=(docker-compose)
else COMPOSE=(); fi

# ------------------------------------------------------------------ Einstellungen
if [ ! -f "$BASE/.env" ]; then
  cat > "$BASE/.env" <<'ENV'
# Einstellungen für ueLights. Nach Änderungen die Aufgabe einmal mit --force ausführen
# oder den Container im Container Manager neu starten.
PORT=8787
TZ=Europe/Berlin
# Optional – sonst im Browser einstellen:
# UELIGHTS_PASSWORD=
# SE_JWT=
# HA_TOKEN=
ENV
  chmod 600 "$BASE/.env"
fi
PORT="$(sed -n 's/^PORT=\([0-9][0-9]*\).*/\1/p' "$BASE/.env" | tail -1)"
PORT="${PORT:-8787}"

if [ ! -f "$BASE/docker-compose.yml" ]; then
  cat > "$BASE/docker-compose.yml" <<'YML'
# Angelegt von uelights-update.sh. Das Image baut das Skript selbst (uelights:latest).
services:
  uelights:
    image: uelights:latest
    pull_policy: never
    container_name: uelights
    restart: unless-stopped
    # Host-Netzwerk: nötig für die Gerätesuche (UDP-Broadcast/Multicast) von Twinkly und Govee
    network_mode: host
    env_file: .env
    volumes:
      - ./data:/data
YML
fi

container_running() { [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" = "true" ]; }

start_container() {
  if [ ${#COMPOSE[@]} -gt 0 ]; then
    # --pull never gibt es erst ab Compose 2.8 (DSM 7.1 hat teils noch 1.x)
    (cd "$BASE" && { "${COMPOSE[@]}" -p uelights up -d --force-recreate --remove-orphans --pull never ||
      "${COMPOSE[@]}" -p uelights up -d --force-recreate --remove-orphans; }) >> "$LOG" 2>&1
  else
    docker rm -f "$NAME" >/dev/null 2>&1
    docker run -d --name "$NAME" --restart unless-stopped --network host \
      --env-file "$BASE/.env" -v "$BASE/data:/data" "$IMAGE:latest" >> "$LOG" 2>&1
  fi
}

healthy() {
  local i
  for i in $(seq 1 45); do
    curl -fsS -m 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && return 0
    # Neustart-Schleife (Absturz beim Start) früh erkennen
    [ "$(docker inspect -f '{{.RestartCount}}' "$NAME" 2>/dev/null || echo 0)" -ge 2 ] && return 1
    container_running || [ "$i" -lt 5 ] || return 1
    sleep 2
  done
  return 1
}

# ------------------------------------------------------------------ Neuer Stand?
DEPLOYED="$(cat "$BASE/.deployed-sha" 2>/dev/null || true)"
LATEST="$(curl -fsS -m 20 -H 'Accept: application/vnd.github.sha' \
  "https://api.github.com/repos/$REPO/commits/$BRANCH" 2>/dev/null || true)"
case "$LATEST" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) ;;
  *) LATEST="" ;;
esac

if [ -z "$LATEST" ]; then
  log "GitHub nicht erreichbar – kein Update geprüft."
  if [ -n "$DEPLOYED" ] && ! container_running; then
    log "Container läuft nicht – starte ihn."; start_container; healthy || die "Container startet nicht."
  fi
  [ -n "$DEPLOYED" ] && exit 0
  die "Erstinstallation braucht Zugriff auf GitHub."
fi

if [ "$FORCE" = 0 ] && [ "$LATEST" = "$DEPLOYED" ] && docker image inspect "$IMAGE:latest" >/dev/null 2>&1; then
  if container_running; then exit 0; fi
  log "Aktuell (${LATEST:0:7}), aber Container läuft nicht – starte ihn."
  start_container
  healthy && { log "Läuft wieder auf Port $PORT."; exit 0; }
  die "Container startet nicht. Details: docker logs $NAME"
fi

# ------------------------------------------------------------------ Laden
if [ -z "$DEPLOYED" ]; then log "Erstinstallation von $REPO@$BRANCH (${LATEST:0:7})"
else log "Update ${DEPLOYED:0:7} → ${LATEST:0:7} ($REPO@$BRANCH)"; fi
TMP="$(mktemp -d "$BASE/.tmp.XXXXXX")"
curl -fsSL -m 300 "https://codeload.github.com/$REPO/tar.gz/$LATEST" -o "$TMP/src.tar.gz" \
  || die "Download fehlgeschlagen."
mkdir "$TMP/src"
tar -xzf "$TMP/src.tar.gz" -C "$TMP/src" --strip-components=1 || die "Archiv defekt."
[ -f "$TMP/src/Dockerfile" ] || die "Kein Dockerfile im Download."

# ------------------------------------------------------------------ Bauen
HAD_PREVIOUS=0
if docker image inspect "$IMAGE:latest" >/dev/null 2>&1; then
  docker tag "$IMAGE:latest" "$IMAGE:previous" && HAD_PREVIOUS=1
fi
log "Baue Image (kann auf dem NAS einige Minuten dauern) ..."
if ! docker build --pull -t "$IMAGE:latest" \
     --label "org.opencontainers.image.revision=$LATEST" \
     --label "org.opencontainers.image.source=https://github.com/$REPO" \
     "$TMP/src" >> "$LOG" 2>&1; then
  if [ "$HAD_PREVIOUS" = 1 ]; then
    docker tag "$IMAGE:previous" "$IMAGE:latest"
    container_running || start_container
    die "Build fehlgeschlagen – vorige Version läuft weiter. Details in $LOG"
  fi
  die "Build fehlgeschlagen. Details in $LOG"
fi

# ------------------------------------------------------------------ Tauschen und starten
cp -p "$BASE/data/store.json" "$BASE/data/store.json.bak" 2>/dev/null || true
start_container
if healthy; then
  rm -rf "$BASE/app.old"
  [ -d "$BASE/app" ] && mv "$BASE/app" "$BASE/app.old"
  mv "$TMP/src" "$BASE/app"
  echo "$LATEST" > "$BASE/.deployed-sha"
  rm -rf "$BASE/app.old"
  docker image prune -f >/dev/null 2>&1
  # Dieses Skript selbst aktualisieren (mv ersetzt die Datei, das laufende Skript liest weiter die alte)
  if [ -f "$BASE/app/nas/uelights-update.sh" ] && [ "$(cksum < "$BASE/app/nas/uelights-update.sh")" != "$(cksum < "$0")" ]; then
    cp "$BASE/app/nas/uelights-update.sh" "$BASE/.uelights-update.sh.new" &&
      chmod 755 "$BASE/.uelights-update.sh.new" && mv -f "$BASE/.uelights-update.sh.new" "$BASE/uelights-update.sh" &&
      log "Update-Skript selbst aktualisiert."
  fi
  log "Fertig: ueLights ${LATEST:0:7} läuft auf http://<NAS-IP>:$PORT"
  exit 0
fi

log "Neue Version startet nicht – stelle vorige wieder her."
docker logs --tail 40 "$NAME" >> "$LOG" 2>&1
if [ "$HAD_PREVIOUS" = 1 ]; then
  docker tag "$IMAGE:previous" "$IMAGE:latest"
  [ -f "$BASE/data/store.json.bak" ] && cp -p "$BASE/data/store.json.bak" "$BASE/data/store.json"
  start_container
  healthy && die "Update ${LATEST:0:7} fehlgeschlagen, vorige Version ${DEPLOYED:0:7} läuft wieder."
fi
die "Update fehlgeschlagen und keine lauffähige Version vorhanden. Details in $LOG"
