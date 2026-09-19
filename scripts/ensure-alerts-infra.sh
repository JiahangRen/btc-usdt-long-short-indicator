#!/bin/zsh
# 云端告警依赖守护（Postgres + Redis，跑在 Docker 里）。
#
# 背景：8787 的 node 服务由 launchd 秒起，而 Docker Desktop 要几十秒才就绪；
# alert-store.mjs 只在启动时试连一次 5432/6379，失败就把「账户与云端服务」
# 永久置为 disabled，之后 infra 起来了也不会自愈 —— 表现就是页面上那句
# "云端服务暂不可用: alert infrastructure unavailable: connect ECONNREFUSED 127.0.0.1:5432"。
#
# 这个脚本负责把整条链路拉齐并自愈：
#   1. 没有 Docker daemon 就拉起 Docker Desktop 并等它
#   2. 只起 postgres + redis（绝不起 compose 里的 app/caddy —— app 会抢 8787）
#   3. 等 5432 + 6379 真正可连
#   4. 若 8787 还停在 disabled 态，重启它让云端告警重新挂上
#
# 由 ~/Library/LaunchAgents/com.jeffereyreng.btc-alerts-infra.plist 驱动：
# RunAtLoad（登录即跑一次）+ StartInterval（每 2 分钟巡检自愈）。
# 幂等，可重复执行。

set -u

ROOT="/Users/jeffereyreng/ChatGPT/btc指示器"
DOCKER="/Applications/Docker.app/Contents/Resources/bin/docker"
COMPOSE_FILE="${ROOT}/docker-compose.yml"
PROJECT_NAME="btc"
APP_LABEL="com.jeffereyreng.btc-indicator"
HEALTH_URL="http://127.0.0.1:8787/api/alerts/health"

CURL="/usr/bin/curl"
NC="/usr/bin/nc"
OPEN="/usr/bin/open"
LAUNCHCTL="/bin/launchctl"

log() { print -r -- "[$(date '+%Y-%m-%d %H:%M:%S')] $*" }
port_up() { "$NC" -z 127.0.0.1 "$1" >/dev/null 2>&1 }

# ── 1. Docker daemon ────────────────────────────────────────────────────────
if ! "$DOCKER" info >/dev/null 2>&1; then
  log "docker daemon 未就绪，拉起 Docker Desktop 并等待"
  "$OPEN" -a Docker >/dev/null 2>&1
  for _ in {1..60}; do
    "$DOCKER" info >/dev/null 2>&1 && break
    sleep 2
  done
fi
if ! "$DOCKER" info >/dev/null 2>&1; then
  log "docker daemon 在 120s 内仍未就绪，本轮放弃（下轮继续）"
  exit 0
fi

# ── 2 & 3. 起依赖并等端口 ───────────────────────────────────────────────────
if ! port_up 5432 || ! port_up 6379; then
  log "拉起 postgres + redis（compose project: ${PROJECT_NAME}）"
  up_out=$("$DOCKER" compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" up -d postgres redis 2>&1)
  log "compose up 结果: ${up_out:-（无输出）}"
  for _ in {1..60}; do
    port_up 5432 && port_up 6379 && break
    sleep 2
  done
fi
if ! port_up 5432 || ! port_up 6379; then
  log "5432/6379 仍未就绪，本轮放弃（下轮继续）"
  exit 0
fi

# ── 4. 救回被竞态禁用的 8787 ────────────────────────────────────────────────
health=$("$CURL" -s --noproxy '*' -m 5 "$HEALTH_URL" 2>/dev/null)
if [[ "$health" != *'"enabled":true'* ]]; then
  if [[ "$health" == *'"enabled":false'* ]]; then
    log "8787 云端告警处于 disabled（infra 已就绪），重启 8787 以恢复"
    "$LAUNCHCTL" kickstart -k "gui/$(id -u)/${APP_LABEL}" >/dev/null 2>&1
    sleep 4
    after=$("$CURL" -s --noproxy '*' -m 5 "$HEALTH_URL" 2>/dev/null)
    if [[ "$after" == *'"enabled":true'* ]]; then
      log "8787 云端告警已恢复"
    else
      log "8787 重启后仍未恢复，下轮继续重试"
    fi
  else
    log "8787 无响应或未启动，交由 launchd 自行拉起"
  fi
fi

exit 0
