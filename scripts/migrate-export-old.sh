#!/usr/bin/env bash
# 在【旧服务器】运行：导出 Postgres + 本地 SQLite 历史行情，生成可传输的包。
# 导出后把包 scp 到新服务器 /tmp，再在新服务器用 IMPORT_FROM 指过去跑 bootstrap。
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/btc-usdt-long-short-indicator}"
OUT="/tmp/btc-migration-$(date +%Y%m%d%H%M%S)"
mkdir -p "$OUT"
cd "$APP_DIR"

# Postgres 逻辑导出（云端告警等）
docker compose exec -T postgres pg_dump -U btc_alerts btc_alerts > "$OUT/postgres.sql"

# 本地 SQLite 历史行情（market.sqlite 等）
tar czf "$OUT/data-sqlite.tgz" -C "$APP_DIR" data

echo "导出完成:"
echo "  $OUT/postgres.sql"
echo "  $OUT/data-sqlite.tgz"
echo "传输到新服务器: scp -r $OUT <new-server>:/tmp/"
echo "（注意：云端告警的 ALERT_ENCRYPTION_KEY 必须与旧站一致才能解密；请在 bootstrap 时把旧 .env 的同名值抄进新 .env）"
