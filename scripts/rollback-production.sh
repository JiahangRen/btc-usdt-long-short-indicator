#!/usr/bin/env bash
# Restore the most recent pre-deploy snapshot without touching persistent data
# or the production .env secrets.
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/btc-usdt-long-short-indicator}"
ROLLBACK_LINK="${1:-$APP_DIR/.rollback-current}"
ROLLBACK_DIR="$(readlink -f "$ROLLBACK_LINK")"

if [ ! -f "$ROLLBACK_DIR/docker-compose.yml" ]; then
  echo "Rollback snapshot is invalid: $ROLLBACK_DIR" >&2
  exit 1
fi

rsync -a --delete \
  --exclude='.git/' --exclude='data/' --exclude='.env' --exclude='.env.*' \
  --exclude='.releases/' --exclude='.rollback-current' \
  "$ROLLBACK_DIR/" "$APP_DIR/"

cd "$APP_DIR"
docker compose up -d --build app alert-worker

for attempt in $(seq 1 24); do
  if curl --fail --silent --max-time 5 http://127.0.0.1:8787/api/status >/dev/null; then
    echo "Rollback restored: $ROLLBACK_DIR"
    exit 0
  fi
  sleep 5
done

echo 'Rollback containers did not become healthy.' >&2
exit 1
