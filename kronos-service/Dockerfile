FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    KRONOS_PATH=/opt/Kronos \
    PYTHONPATH=/opt/Kronos

WORKDIR /app

# 需要 git 克隆 Kronos 仓库（提供 model.py / tokenizer）
RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

# CPU 版 torch（显著减小镜像体积）；后续 -r requirements 不会再拉 GPU 版
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 克隆 Kronos 仓库（MIT）。inference.py 通过 PYTHONPATH 导入 model。
RUN git clone --depth 1 https://github.com/shiyu-coder/Kronos.git /opt/Kronos

COPY . .

# 构建期预下载权重（需联网；失败不阻断构建，运行时首次会再拉）
RUN python -c "from model import Kronos, KronosTokenizer; Kronos.from_pretrained('NeoQuasar/Kronos-small'); KronosTokenizer.from_pretrained('NeoQuasar/Kronos-Tokenizer-base')" \
    || echo "WARN: offline build, weights will download on first request"

EXPOSE 8799

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8799"]
