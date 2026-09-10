#!/usr/bin/env bash
# Deploy only after the candidate image builds.  On any failed local health
# check, restore the snapshot made by the GitHub Actions workflow.
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/btc-usdt-long-short-indicator}"
ROLLBACK_LINK="${ROLLBACK_LINK:-$APP_DIR/.rollback-current}"
changed=false

# Compose can return before Docker has completely removed a recreated
# container.  Starting a replacement during that tiny window fails with
# "removal of container ... is already in progress".  Remove the two
# stateless services deliberately, wait for their old IDs to disappear, then
# create replacements.  PostgreSQL and Redis stay running throughout.
recreate_services() {
  local services=(app alert-worker)
  local old_ids=()
  local service id attempt

  for service in "${services[@]}"; do
    while IFS= read -r id; do
      [ -n "$id" ] && old_ids+=("$id")
    done < <(docker compose ps -aq "$service" 2>/dev/null || true)
  done

  docker compose stop "${services[@]}" || true
  docker compose rm --force --stop "${services[@]}" || true

  for attempt in $(seq 1 30); do
    local remaining=false
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
    if docker compose up -d --no-deps "${services[@]}"; then
      return 0
    fi
    echo "Container replacement is still settling; retrying ($attempt/3)…" >&2
    sleep 3
  done
  return 1
}

rollback() {
  if [ "$changed" != true ]; then
    echo 'Candidate image build failed before replacing the running release.' >&2
    return
  fi
  echo 'Deployment failed; restoring the previous release.' >&2
  bash "$APP_DIR/scripts/rollback-production.sh" "$ROLLBACK_LINK"
}
trap rollback ERR

cd "$APP_DIR"
docker compose build app alert-worker
changed=true
# PostgreSQL and Redis are intentionally not recreated during application
# deploys; their health was checked before this script is called.
recreate_services

for attempt in $(seq 1 24); do
  app_id="$(docker compose ps -q app)"
  worker_id="$(docker compose ps -q alert-worker)"
  app_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$app_id" 2>/dev/null || true)"
  worker_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$worker_id" 2>/dev/null || true)"
  if [ "$app_health" = healthy ] && [ "$worker_health" = healthy ] && curl --fail --silent --max-time 5 http://127.0.0.1:8787/api/status >/dev/null; then
    echo 'Deployment is healthy.'
    trap - ERR
    exit 0
  fi
  sleep 5
done

echo 'Timed out waiting for app and alert worker health checks.' >&2
# A plain `exit 1` does NOT fire the ERR trap, so the replaced (broken) release
# would stay live with no rollback. Restore the snapshot explicitly, then fail
# the step so the workflow surfaces the error.
trap - ERR
rollback
exit 1
