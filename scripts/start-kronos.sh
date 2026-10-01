#!/usr/bin/env bash
# Kronos 推理服务常驻启动脚本（供 launchd 调用）
set -uo pipefail

# 进度日志：写入 stderr，launchd 会捕获到 btc-kronos.error.log
log() { echo "[$(date '+%H:%M:%S')] $*" >&2; }

ROOT="/Users/jeffereyreng/ChatGPT/btc指示器"
# 默认克隆到用户可写目录；/opt 在普通用户下无写权限，会导致 clone 直接失败
REPO_DIR="${KRONOS_PATH:-$HOME/Library/Caches/Kronos}"
VENV_DIR="${ROOT}/kronos-service/.venv"
PYTHON="${VENV_DIR}/bin/python"
PIP="${VENV_DIR}/bin/pip"
UVICORN="${VENV_DIR}/bin/uvicorn"

# launchd 不会自动加载用户 shell 配置，显式指定 PATH
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:$PATH"

log "启动 Kronos 服务；REPO_DIR=${REPO_DIR}"

# 1. 确保 Kronos 仓库存在（提供 model.py / KronosTokenizer 等定义）
if [[ ! -d "$REPO_DIR" ]]; then
  log "克隆 Kronos 仓库到 ${REPO_DIR} …"
  mkdir -p "$(dirname "$REPO_DIR")"
  if ! git clone --depth 1 https://github.com/shiyu-coder/Kronos.git "$REPO_DIR" 2>&1 | sed 's/^/  /' >&2; then
    log "ERROR: git clone 失败（检查网络或目标目录权限：$REPO_DIR）"
    exit 1
  fi
  log "克隆完成"
else
  log "Kronos 仓库已存在，跳过克隆"
fi

# 2. 确保虚拟环境与依赖
if [[ ! -d "$VENV_DIR" ]]; then
  log "创建虚拟环境 ${VENV_DIR} …"
  python3 -m venv "$VENV_DIR"
fi
log "安装依赖（首次较慢，torch 约 200MB）…"
if ! "$PIP" install --upgrade pip >/dev/null 2>&1; then
  log "WARN: pip upgrade 失败（非致命）"
fi
if ! "$PIP" install -r "${ROOT}/kronos-service/requirements.txt" 2>&1 | tail -5 | sed 's/^/  /' >&2; then
  log "ERROR: 依赖安装失败（检查网络）"
  exit 1
fi
log "依赖就绪"

# 3. 启动服务
export PYTHONPATH="$REPO_DIR"
export KRONOS_PATH="$REPO_DIR"
cd "${ROOT}/kronos-service"
log "启动 uvicorn :8799 …"
exec "$UVICORN" app:app --host 127.0.0.1 --port 8799
