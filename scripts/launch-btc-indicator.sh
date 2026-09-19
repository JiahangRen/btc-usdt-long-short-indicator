#!/bin/zsh
# BTC/USDT 多空指标指示器 —— 桌面启动器（真正的逻辑）
#
# 双击 .app 会按顺序完成五件事：
#   1. 让 launchd 用上磁盘上的最新 plist 配置（首次双击把 8787 重新纳管）
#   2. 确保云端告警依赖（Postgres + Redis，跑在 Docker 里）就绪
#   3. 确保 8787 的 node 服务在线，并且已经成功挂上云端告警
#   4. 打开 http://127.0.0.1:8787/ —— 但**先找已经开着的那个标签**，找到就切过去
#   5. 确实没开才新开一个标签
#
# 为什么要自己把顺序摆平：
#   8787 由 launchd 秒起，而 Docker Desktop 要几十秒；alert-store.mjs 在启动期
#   只做一次探测，失败就把「账户与云端服务」永久置为 disabled —— 谁先谁后会直接
#   决定页面能不能用。这里先等依赖、再拉起服务，竞态就不会发生。
#
# 为什么打开要分「找 / 开」两步：
#   Chrome / Safari 对相同 URL 不做去重，`open <url>` 必然新开标签；
#   所以先在**已在运行的**浏览器里找 127.0.0.1:8787（按主机+端口判，带锚点也算），
#   命中就把该标签置为活动并置前。

set -u

ROOT="/Users/jeffereyreng/ChatGPT/btc指示器"
URL="http://127.0.0.1:8787/"
HEALTH_URL="${URL}api/alerts/health"
LABEL="com.jeffereyreng.btc-indicator"
SYNC_SCRIPT="${ROOT}/scripts/relaunch-service.sh"
INFRA_SCRIPT="${ROOT}/scripts/ensure-alerts-infra.sh"
LAUNCHER_LOG="${ROOT}/btc-launcher.log"
FOCUS_LOG="${ROOT}/btc-focus.log"
PERM_FLAG="${ROOT}/.btc-focus-perm-notified"

CURL="/usr/bin/curl"
NC="/usr/bin/nc"
OPEN="/usr/bin/open"
LAUNCHCTL="/bin/launchctl"
OSASCRIPT="/usr/bin/osascript"
PGREP="/usr/bin/pgrep"
MKTEMP="/usr/bin/mktemp"
RM="/bin/rm"

PORT_TEXT=":8787"

log() { print -r -- "[$(date '+%Y-%m-%d %H:%M:%S')] launcher: $*" >> "$LAUNCHER_LOG" }
flog() { print -r -- "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$FOCUS_LOG" }
notify() { "$OSASCRIPT" -e "display notification \"$1\" with title \"BTC/USDT 多空指标指示器\"" >/dev/null 2>&1 }
port_up() { "$NC" -z 127.0.0.1 "$1" >/dev/null 2>&1 }
http_code() { "$CURL" -s --noproxy '*' -m 3 -o /dev/null -w '%{http_code}' "$URL" 2>/dev/null }
alerts_state() { "$CURL" -s --noproxy '*' -m 3 "$HEALTH_URL" 2>/dev/null }
ready() { [[ "$(http_code)" == "200" ]] && [[ "$(alerts_state)" == *'"enabled":true'* ]] }

# ── 找「已开着的标签」 ──────────────────────────────────────────────────────
# 两个必须遵守的约束（否则脚本会被静默判定为失败，症状和「真没找到」一模一样）：
#   ① app 名必须是**字面量**：AppleScript 编译期要拿目标的 dictionary 去解析
#      tabs / URL / active tab index，用变量会在运行时 -2740。所以用 @APP@ 占位，
#      运行时替换成字面量。
#   ② 脚本必须落成**文件**再整份编译：`osascript -` 是逐行交互解析，循环体里
#      属性照样解析不了。
CHROME_TMPL='on run argv
  set portText to item 1 of argv
  tell application "@APP@"
    repeat with w in windows
      set i to 0
      repeat with t in tabs of w
        set i to i + 1
        set u to URL of t
        if (u contains portText) and ((u contains "127.0.0.1") or (u contains "localhost")) then
          set active tab index of w to i
          try
            set miniaturized of w to false
          end try
          set index of w to 1
          activate
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  error "not found"
end run'

SAFARI_TMPL='on run argv
  set portText to item 1 of argv
  tell application "@APP@"
    repeat with w in windows
      repeat with t in tabs of w
        set u to URL of t
        if (u contains portText) and ((u contains "127.0.0.1") or (u contains "localhost")) then
          set current tab of w to t
          try
            set miniaturized of w to false
          end try
          set index of w to 1
          activate
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  error "not found"
end run'

# 返回 0=切过去了 / 1=确实没开 / 2=系统没给自动化权限
focus_existing() {
  local app file out rc worst=1
  for app in "Google Chrome" "Google Chrome Canary" "Brave Browser" "Microsoft Edge" "Chromium" "Vivaldi" "Opera" "Safari"; do
    # 只碰**已经在运行的**浏览器：对没运行的 app 发 Apple 事件会把它启动起来
    "$PGREP" -x "$app" >/dev/null 2>&1 || continue
    file="$("$MKTEMP" -t btc-focus)" || continue
    if [[ "$app" == "Safari" ]]; then
      printf '%s\n' "${SAFARI_TMPL//@APP@/$app}" > "$file"
    else
      printf '%s\n' "${CHROME_TMPL//@APP@/$app}" > "$file"
    fi
    out="$("$OSASCRIPT" "$file" "$PORT_TEXT" 2>&1)"; rc=$?
    "$RM" -f "$file"
    flog "focus app=${app} rc=${rc} out=${out//$'\n'/ }"
    [[ "$rc" == "0" ]] && return 0
    case "$out" in *-10004*|*-1743*|*权限违例*) worst=2 ;; esac
  done
  return "$worst"
}

open_or_focus() {
  focus_existing
  local rc=$?
  case "$rc" in
    0)
      log "命中已开标签，切回（不新开）"
      return 0
      ;;
    2)
      log "Apple 事件被拒（缺自动化权限），本次新开"
      if [[ ! -f "$PERM_FLAG" ]]; then
        notify "首次需要授权：系统设置 → 隐私与安全性 → 自动化，允许「BTC 多空指标」控制浏览器"
        : > "$PERM_FLAG"
      fi
      ;;
    *)
      log "未找到已开标签，新开一个"
      ;;
  esac
  "$OPEN" "$URL"
}

log "启动器触发"

# ── 0. 同步 launchd 配置（幂等：已是最新时几乎零开销，不会重启服务） ─────────
/bin/zsh "$SYNC_SCRIPT" >> "$LAUNCHER_LOG" 2>&1
sleep 3

# ── 已就绪则秒开 ────────────────────────────────────────────────────────────
if ready; then
  log "服务已就绪，直接打开"
  open_or_focus
  exit 0
fi

notify "正在启动本地服务，请稍候…"

# ── 1. 云端告警依赖 ─────────────────────────────────────────────────────────
if ! port_up 5432 || ! port_up 6379; then
  log "infra 未就绪，调用守护脚本拉起（最多等 150s）"
  /bin/zsh "$INFRA_SCRIPT" >/dev/null 2>&1 &
  infra_pid=$!
  for _ in {1..75}; do
    port_up 5432 && port_up 6379 && break
    sleep 2
  done
  kill "$infra_pid" >/dev/null 2>&1
fi
if ! port_up 5432 || ! port_up 6379; then
  log "infra 未就绪，仍打开页面（云端告警可能暂时不可用）"
  notify "云端告警依赖未就绪，页面仍会打开"
  open_or_focus
  exit 0
fi
log "infra 就绪"

# ── 2. 8787 + 云端告警挂载 ──────────────────────────────────────────────────
if ! ready; then
  log "8787 未就绪或云端告警未挂上，重启 8787"
  "$LAUNCHCTL" kickstart -k "gui/$(id -u)/${LABEL}" >/dev/null 2>&1
  for _ in {1..15}; do
    ready && break
    sleep 2
  done
fi

log "打开页面（http=$(http_code)，alerts=$(alerts_state)）"
open_or_focus
exit 0
