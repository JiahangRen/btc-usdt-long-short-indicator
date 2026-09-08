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
services=(app)
if docker compose config --services | grep -qx 'alert-worker'; then
  services+=(alert-worker)
fi

# Wait for old application container IDs to fully disappear before Compose
# creates their rollback replacements.  Docker may otherwise report that a
# container removal is still in progress.
old_ids=()
for service in "${services[@]}"; do
  while IFS= read -r id; do
    [ -n "$id" ] && old_ids+=("$id")
  done < <(docker compose ps -aq "$service" 2>/dev/null || true)
done
docker compose stop "${services[@]}" || true
docker compose rm --force --stop "${services[@]}" || true
for attempt in $(seq 1 30); do
  remaining=false
  for id in "${old_ids[@]}"; do
    if docker inspect "$id" >/dev/null 2>&1; then
      remaining=true
      break
    fi
  done
  [ "$remaining" = false ] && break
  sleep 1
done

for attempt in $(seq 1 3); do
  if docker compose up -d --build --no-deps "${services[@]}"; then
    break
  fi
  if [ "$attempt" = 3 ]; then
    echo 'Rollback container replacement did not complete.' >&2
    exit 1
  fi
  echo "Rollback container replacement is still settling; retrying ($attempt/3)…" >&2
  sleep 3
done

for attempt in $(seq 1 24); do
  if curl --fail --silent --max-time 5 http://127.0.0.1:8787/api/status >/dev/null; then
    echo "Rollback restored: $ROLLBACK_DIR"
    exit 0
  fi
  sleep 5
done

echo 'Rollback containers did not become healthy.' >&2
exit 1
