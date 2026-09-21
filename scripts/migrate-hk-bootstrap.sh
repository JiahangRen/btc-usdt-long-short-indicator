#!/usr/bin/env bash
# 新 HK 服务器：一次性装好 BTC 站（纯 Docker + Caddy，不用宝塔）。
#
# 用法（root 或 sudo）:
#   DOMAIN=btc.example.com DEPLOY_ACCOUNT=ubuntu \
#     bash scripts/migrate-hk-bootstrap.sh
#
# 可选:
#   IMPORT_FROM=/tmp/btc-migration-20260921...   # 旧站数据导出包目录，含 postgres.sql + data-sqlite.tgz
#   POSTGRES_PASSWORD / ALERT_ENCRYPTION_KEY     # 不传则自动生成并写入 .env（= 旧数据无法解密，需 IMPORT_FROM 同步旧密钥）
#
# 说明: 脚本把克隆下来的 Caddyfile / compose 就地补成「域名走环境变量」形式，
# 这样即使仓库 master 还没合并 env-var 版本也能跑；合入后此处变为 no-op。
set -Eeuo pipefail

DOMAIN="${DOMAIN:?必须设置 DOMAIN，例如 btc.example.com}"
DEPLOY_ACCOUNT="${DEPLOY_ACCOUNT:-${SUDO_USER:-}}"
APP_DIR="${APP_DIR:-/opt/btc-usdt-long-short-indicator}"
IMPORT_FROM="${IMPORT_FROM:-}"
REPO="https://github.com/JiahangRen/btc-usdt-long-short-indicator.git"

if [ "$(id -u)" -ne 0 ]; then exec sudo "$0" "$@"; fi

# 1) 装 Docker（沿用现有脚本；Ubuntu only）
bash "$(dirname "$0")/provision-docker-ubuntu.sh" "$DEPLOY_ACCOUNT"

# 2) 防火墙：只开 22/80/443。机场端口稍后手动加（如 443 副 SNI 或高位端口）。
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# 3) 取代码
if [ ! -d "$APP_DIR/.git" ]; then
  install -d -m 755 "$APP_DIR"
  git clone "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"

# 4) 把克隆件就地补成 env-var 域名形式（幂等）
python3 - <<'PY'
p='docker-compose.yml'
s=open(p).read()
if 'SITE_DOMAIN' not in s:
    s=s.replace(
        "  caddy:\n    image: caddy:2-alpine\n",
        "  caddy:\n    image: caddy:2-alpine\n    environment:\n      SITE_DOMAIN: ${SITE_DOMAIN:-renjiahang1201.xyz}\n",
        1,
    )
    open(p,'w').write(s)
p2='Caddyfile'
t=open(p2).read()
if '{$SITE_DOMAIN' not in t:
    open(p2,'w').write(t.replace('renjiahang1201.xyz {', '{$SITE_DOMAIN:renjiahang1201.xyz} {', 1))
PY

# 5) .env
if [ ! -f "$APP_DIR/.env" ]; then
  : "${POSTGRES_PASSWORD:=$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 32)}"
  : "${ALERT_ENCRYPTION_KEY:=$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 32)}"
  cat > "$APP_DIR/.env" <<EOF
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
ALERT_ENCRYPTION_KEY=$ALERT_ENCRYPTION_KEY
SITE_DOMAIN=$DOMAIN
EOF
  chmod 600 "$APP_DIR/.env"
  echo ".env 已生成（含随机密钥）。若要沿用旧站数据，请把旧站 .env 的 POSTGRES_PASSWORD / ALERT_ENCRYPTION_KEY 抄过来再继续。"
fi

# 6) 部署
bash "$APP_DIR/scripts/deploy-production.sh"

# 7) 可选：导入旧站数据
if [ -n "$IMPORT_FROM" ]; then
  echo "导入旧站数据: $IMPORT_FROM"
  # Postgres：先清空 public schema 再灌入（app 首次启动可能已建空表）
  docker compose exec -T postgres psql -U btc_alerts -d btc_alerts \
    -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" || true
  if [ -f "$IMPORT_FROM/postgres.sql" ]; then
    docker compose exec -T postgres psql -U btc_alerts -d btc_alerts < "$IMPORT_FROM/postgres.sql"
  fi
  if [ -f "$IMPORT_FROM/data-sqlite.tgz" ]; then
    tar xzf "$IMPORT_FROM/data-sqlite.tgz" -C "$APP_DIR"
  fi
  # 重启应用让数据生效
  docker compose stop app alert-worker || true
  docker compose up -d --no-deps app alert-worker
fi

echo "部署完成。等 Caddy 申请证书（DNS 需已指向本机 80/443）。验证: curl -sI https://$DOMAIN/api/status"
