#!/usr/bin/env bash
# Deploy only after the candidate image builds.  On any failed local health
# check, restore the snapshot made by the GitHub Actions workflow.
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/btc-usdt-long-short-indicator}"
ROLLBACK_LINK="${ROLLBACK_LINK:-$APP_DIR/.rollback-current}"
changed=false

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
# Do not enumerate PostgreSQL/Redis here: Compose follows app/worker
# dependencies itself. Listing both the dependencies and dependants can race
# container creation on older Compose releases.
docker compose up -d app alert-worker

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
exit 1
