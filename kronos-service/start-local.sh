#!/usr/bin/env bash
# Kronos 推理服务本机一键启动脚本（btc-indicator 配套）
# 用法：cd kronos-service && ./start-local.sh
set -euo pipefail

REPO_DIR="${KRONOS_PATH:-/opt/Kronos}"
VENV_DIR="${PWD}/.venv"
PORT="${KRONOS_PORT:-8799}"
PYTHON="${VENV_DIR}/bin/python"
PIP="${VENV_DIR}/bin/pip"
UVICORN="${VENV_DIR}/bin/uvicorn"

echo "==> Kronos 服务本机启动脚本"

# 1. 拉取/更新 Kronos 官方仓库（模型 + Tokenizer 定义）
if [[ ! -d "$REPO_DIR" ]]; then
  echo "==> 克隆 Kronos 仓库到 ${REPO_DIR} ..."
  sudo mkdir -p "$(dirname "$REPO_DIR")"
  sudo git clone --depth 1 https://github.com/shiyu-coder/Kronos.git "$REPO_DIR"
  sudo chown -R "$(whoami)" "$REPO_DIR"
else
  echo "==> 已存在 ${REPO_DIR}，跳过克隆"
fi

# 2. 创建 Python venv 并安装依赖
if [[ ! -d "$VENV_DIR" ]]; then
  echo "==> 创建虚拟环境 ..."
  python3 -m venv "$VENV_DIR"
fi

echo "==> 安装/更新依赖 ..."
"$PIP" install --upgrade pip
"$PIP" install -r requirements.txt

# 3. 启动前预加载权重（首次下载，后续命中缓存）
echo "==> 预加载 Kronos-small 权重到 HF 本地缓存 ..."
PYTHONPATH="$REPO_DIR" "$PYTHON" - <<'PY'
import torch
from model import Kronos, KronosTokenizer
print("MPS available:", torch.backends.mps.is_available())
print("Loading tokenizer...")
tokenizer = KronosTokenizer.from_pretrained("NeoQuasar/Kronos-Tokenizer-base")
print("Loading model...")
model = Kronos.from_pretrained("NeoQuasar/Kronos-small")
print("Model loaded:", model.config if hasattr(model, "config") else "OK")
PY

echo ""
echo "==> 启动 FastAPI 服务（port=${PORT}）"
echo "    测试: curl -s --noproxy '*' 'http://127.0.0.1:${PORT}/api/kronos/forecast?exchange=okx'"
echo ""
PYTHONPATH="$REPO_DIR" exec "$UVICORN" app:app --host 127.0.0.1 --port "$PORT" --reload
