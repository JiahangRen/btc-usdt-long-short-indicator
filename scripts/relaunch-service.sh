#!/bin/zsh
# 把 launchd 配置同步到「磁盘上的最新状态」。幂等：已是最新时什么都不做。
#
# 需要同步的两项：
#   1. com.jeffereyreng.btc-indicator     —— 8787 服务，ProgramArguments 指向 serve-with-infra.sh
#                                            （启动前先等 Postgres+Redis，消灭启动竞态）
#   2. com.jeffereyreng.btc-alerts-infra  —— 云端告警依赖守护，登录即拉起 + 每 2 分钟巡检自愈
#
# 为什么单独一个脚本：
#   launchctl kickstart 只重启进程、**不会重读 plist**。改过 plist 后必须
#   bootout + bootstrap 才生效。由桌面启动器每次调用，也可在终端手动执行。
#
# 兜底：若 8787 的 bootstrap 失败（权限/环境异常），就直接后台把服务拉起来，
#       保证页面至少可用；环境变量从 plist 读，避免明文散落。

set -u

ROOT="/Users/jeffereyreng/ChatGPT/btc指示器"
APP_LABEL="com.jeffereyreng.btc-indicator"
INFRA_LABEL="com.jeffereyreng.btc-alerts-infra"
LA_DIR="${HOME}/Library/LaunchAgents"
APP_PLIST="${LA_DIR}/${APP_LABEL}.plist"
INFRA_PLIST="${LA_DIR}/${INFRA_LABEL}.plist"
TMP_PID_FILE="/tmp/btc-indicator-tmp.pid"
UID_NUM="$(id -u)"
LAUNCHCTL="/bin/launchctl"
PLIST_BUDDY="/usr/libexec/PlistBuddy"

log() { print -r -- "[$(date '+%Y-%m-%d %H:%M:%S')] relaunch-service: $*" }

reload() {
  local label="$1" plist="$2" out
  "$LAUNCHCTL" bootout "gui/${UID_NUM}/${label}" 2>/dev/null
  out="$("$LAUNCHCTL" bootstrap "gui/${UID_NUM}" "$plist" 2>&1)"
  if "$LAUNCHCTL" print "gui/${UID_NUM}/${label}" >/dev/null 2>&1; then
    log "${label} 已纳管"
    return 0
  fi
  log "${label} 纳管失败：${out:-（无输出）}"
  return 1
}

# ── 1. 8787 服务：确保跑在最新配置下 ─────────────────────────────────────────
app_info="$("$LAUNCHCTL" print "gui/${UID_NUM}/${APP_LABEL}" 2>/dev/null)"
if [[ "$app_info" != *"serve-with-infra.sh"* ]]; then
  # 先收掉不在 launchd 管理下的临时实例，否则 launchd 起来时抢不到 8787
  if [[ -f "$TMP_PID_FILE" ]]; then
    tmp_pid="$(cat "$TMP_PID_FILE" 2>/dev/null)"
    if [[ -n "${tmp_pid}" ]] && kill -0 "${tmp_pid}" 2>/dev/null; then
      log "停止临时实例 pid=${tmp_pid}"
      kill "${tmp_pid}" 2>/dev/null
      for _ in {1..10}; do
        kill -0 "${tmp_pid}" 2>/dev/null || break
        sleep 0.5
      done
      kill -9 "${tmp_pid}" 2>/dev/null
    fi
    rm -f "$TMP_PID_FILE"
  fi

  if ! reload "$APP_LABEL" "$APP_PLIST"; then
    log "改为后台直起 8787"
    cd "$ROOT" || exit 1
    DATABASE_URL="$("$PLIST_BUDDY" -c 'Print :EnvironmentVariables:DATABASE_URL' "$APP_PLIST" 2>/dev/null)" \
    REDIS_URL="$("$PLIST_BUDDY" -c 'Print :EnvironmentVariables:REDIS_URL' "$APP_PLIST" 2>/dev/null)" \
    ALERT_ENCRYPTION_KEY="$("$PLIST_BUDDY" -c 'Print :EnvironmentVariables:ALERT_ENCRYPTION_KEY' "$APP_PLIST" 2>/dev/null)" \
    nohup /bin/zsh "${ROOT}/scripts/serve-with-infra.sh" >> "${ROOT}/btc-indicator.log" 2>&1 &
    print -r -- "$!" > "$TMP_PID_FILE"
    log "已后台直起 pid=$!"
  fi
fi

# ── 2. 云端告警依赖守护：确保已注册 ──────────────────────────────────────────
if ! "$LAUNCHCTL" print "gui/${UID_NUM}/${INFRA_LABEL}" >/dev/null 2>&1; then
  if [[ -f "$INFRA_PLIST" ]]; then
    reload "$INFRA_LABEL" "$INFRA_PLIST" \
      || log "infra 守护注册失败（不致命：8787 启动时仍会自己等依赖）"
  else
    log "缺少 ${INFRA_PLIST}"
  fi
fi

exit 0
