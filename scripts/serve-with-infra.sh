#!/bin/zsh
# 8787 服务的启动包装（由 com.jeffereyreng.btc-indicator.plist 调用）。
#
# 为什么需要它：
#   launchd 启动 8787 是秒级的，而 Docker Desktop 要几十秒才把 Postgres/Redis 拉起来。
#   一旦 8787 先起来，alert-store.mjs 在启动期只做一次 SELECT 1 探测，失败就把
#   「账户与云端服务」永久置为 disabled —— 之后 infra 起来了也不会自愈，页面上就
#   一直显示 "云端服务暂不可用: ... ECONNREFUSED 127.0.0.1:5432"。
#
#   把「等依赖就绪」放在 node 之前，竞态就从根上消失：
#   infra 先就绪 → node 再启动 → 云端告警一次挂上。
#
# 兜底：即使 infra 在超时内没起来，也照样启动 node（服务不能因此不可用），
#       之后由 scripts/ensure-alerts-infra.sh 的巡检把 8787 重启并救回。

set -u

ROOT="/Users/jeffereyreng/ChatGPT/btc指示器"
NODE_BIN="/Users/jeffereyreng/.local/share/mise/installs/node/26/bin/node"
INFRA_SCRIPT="${ROOT}/scripts/ensure-alerts-infra.sh"
NC="/usr/bin/nc"

stamp() { date '+%Y-%m-%d %H:%M:%S' }
port_up() { "$NC" -z 127.0.0.1 "$1" >/dev/null 2>&1 }

if port_up 5432 && port_up 6379; then
  print -r -- "[$(stamp)] serve-with-infra: alerts infra 已在就绪状态"
else
  print -r -- "[$(stamp)] serve-with-infra: alerts infra 未就绪，先拉起（最多等 150s）"
  /bin/zsh "$INFRA_SCRIPT" >/dev/null 2>&1 &
  infra_pid=$!
  for _ in {1..75}; do
    port_up 5432 && port_up 6379 && break
    sleep 2
  done
  kill "$infra_pid" >/dev/null 2>&1

  if port_up 5432 && port_up 6379; then
    print -r -- "[$(stamp)] serve-with-infra: infra 已就绪，启动 node"
  else
    print -r -- "[$(stamp)] serve-with-infra: infra 超时未就绪，仍启动 node（稍后由守护巡检自愈）"
  fi
fi

cd "$ROOT" || exit 1
exec "$NODE_BIN" server.mjs
