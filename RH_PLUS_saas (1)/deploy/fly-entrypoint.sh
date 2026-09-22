#!/bin/sh
# Point d'entrée Fly.io : le volume /data est monté en root, alors que l'application
# doit tourner sous un compte sans privilèges. On rend le volume accessible, puis on
# abandonne les privilèges (gosu → setpriv → su).
#
# Le compte d'exécution est « node » dans l'image officielle Node.js ; il peut être
# changé avec RHPLUS_RUN_USER (utile hors conteneur).
set -eu

DATADIR="${RHPLUS_DATA_DIR:-/data}"
APP_USER="${RHPLUS_RUN_USER:-node}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATADIR/backups"
  if id "$APP_USER" >/dev/null 2>&1; then
    chown -R "$APP_USER":"$APP_USER" "$DATADIR" 2>/dev/null || true
    UID_RUN="$(id -u "$APP_USER")"
    GID_RUN="$(id -g "$APP_USER")"
    echo "[RH PLUS] volume $DATADIR confié à $APP_USER (uid $UID_RUN) — démarrage sans privilèges"
    if command -v gosu >/dev/null 2>&1; then
      exec gosu "$APP_USER" node src/server.js
    elif command -v setpriv >/dev/null 2>&1; then
      exec setpriv --reuid="$UID_RUN" --regid="$GID_RUN" --init-groups node src/server.js
    else
      exec su "$APP_USER" -s /bin/sh -c "exec node src/server.js"
    fi
  fi
  echo "[RH PLUS] compte $APP_USER absent : démarrage sous l'utilisateur courant"
fi

exec node src/server.js
