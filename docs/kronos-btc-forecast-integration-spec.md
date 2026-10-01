# Kronos × btc指示器 集成规格（Spec）

> 目标：在 btc指示器 网站页脚新增一个**内嵌的 AI 预测板块**，内含 **BTC 涨跌 / 波动 AI 预测卡**（Kronos 基座模型），
> 后端由开源金融基座模型 **Kronos**（shiyu-coder/Kronos，MIT）驱动。
> 本文档为可交付规格，供自行实现或交给编码 Agent 执行。

---

## 0. 背景与目标

- Kronos 是首个开源的金融 K 线（OHLCV）基座模型，自带 BTC/USDT 未来预测能力。
- 目标站点 **btc指示器** 当前是纯前端 + Node 后端，**没有 "Get APP" 板块**，需新建。
- 交付物：① 独立 Python 推理微服务；② index.html 新增 Get APP 板块 + 预测卡；③ server.mjs 代理；④ Docker 编排 + Redis 缓存。

---

## 1. Kronos 仓库分析（要点）

### 1.1 基本事实
| 项 | 值 |
|---|---|
| 仓库 | https://github.com/shiyu-coder/Kronos （文档镜像 zdoc.app/zh/shiyu-coder/Kronos） |
| 定位 | 金融 K 线（OHLCV）基座模型，论文 AAAI 2026 |
| 协议 | **MIT**（可商用、可改、可再分发） |
| 训练数据 | 45+ 全球交易所真实 K 线 |
| 架构 | 两阶段：① `KronosTokenizer` 把连续 OHLCV 量化成分层离散 token → ② 自回归 Transformer 在 token 上预训练 |
| 原生 demo | BTC/USDT 未来 24h 预测（https://shiyu-coder.github.io/Kronos-demo/） |
| webui | Flask + Plotly（参考实现；**本集成预测卡不引 Plotly**，复用站点自有 canvas 渲染） |

### 1.2 模型尺寸与选型（对比表）
| 模型 | 参数量 | Tokenizer 上下文 | 适合场景 | 本集成建议 |
|---|---|---|---|---|
| `Kronos-mini` | 4.1M | 2048 | 极快、CPU 可跑 | 低频/轻量备选 |
| **`Kronos-small`** | 24.7M | 512 | 质量/速度均衡 | **⭐ 主选**（M1 Max MPS 几秒出） |
| `Kronos-base` | 102.3M | 512 | 质量更高、更重 | ⚠️ 仅缓存模式可用（见下） |
| `Kronos-large` | 499M | — | 未开源 | 不可用 |

**模型选型硬约束（本集成）**：
- **`Kronos-small` = 默认**。24.7M，M1 Max（MPS）单次完整评估约 2–5 秒，质量/速度均衡，优先用它打通整条链路。
- **`Kronos-base` 须走缓存模式**。102.3M（≈ small 的 4.1 倍），M1 Max 上单次完整评估（含 N≈20 条路径采样 + `pred_len` 自回归生成）粗估 **十几秒到一分钟量级**；若每次 HTTP 请求都现场跑会让卡片卡死，必须配合 Redis 缓存（§4 / §7.2，TTL 1h）+ 后台定时/按需刷新，前端只取缓存。仅在实测 base 预测明显优于 small 时再升级。
- **`Kronos-large` 不可用**。499M 且未开源，权重无法获取，禁止选。
- 部署形态：本机 MPS 跑推理服务，或 Docker 内 torch CPU（更慢但部署简单）；无论哪种，**前台请求一律取缓存、不触发实时推理**。

> 权重均从 Hugging Face Hub 拉取：`NeoQuasar/Kronos-{mini,small,base}` + 对应 `NeoQuasar/Kronos-Tokenizer-{2k,base}`。

### 1.3 推理接口（已核实）
```python
from model import Kronos, KronosTokenizer, KronosPredictor
tokenizer = KronosTokenizer.from_pretrained("NeoQuasar/Kronos-Tokenizer-base")
model     = Kronos.from_pretrained("NeoQuasar/Kronos-small")
predictor = KronosPredictor(model, tokenizer, max_context=512)
pred_df = predictor.predict(
    df=x_df, x_timestamp=x_ts, y_timestamp=y_ts,
    pred_len=120, T=1.2, top_p=0.95, sample_count=1, verbose=False,
)
# pred_df: 每行一个未来时间点；列 open/high/low/close/volume/amount；index = y_timestamp
```
- 输入 `df` 必填列：`open/high/low/close`；`volume/amount` 可选（缺失填 0）。
- `lookback`（输入长度）建议 ≤ `max_context`（small/base=512）；超过会自动截断。

### 1.4 能力边界（重要，避免误用）
- Kronos 输出的是 **OHLCV 点预测 + 概率采样路径**，不是现成的「涨跌概率 / 波动率」。这两个指标必须**由我们派生**（见 §6）。
- `predict(sample_count=N)` 返回的是 **N 条路径的均值 DataFrame**，不是 N 条独立路径。要拿分布需循环多次 `sample_count=1`（§6.1）。
- 原始预测 ≠ 可盈利信号（README 明确）。仅作展示/参考，卡片须加免责声明。

---

## 2. 目标站点现状（btc指示器）

| 项 | 现状 |
|---|---|
| 前端 | 纯 JS（ES module，`public/index.html` + `public/app.js` + `public/src/*`） |
| 后端 | 原生 `http` 服务 `server.mjs`（Node 22，非 Express），端口 8787 |
| 依赖 | `edge-tts.js` / `pg` / `redis`（**无 Python 运行时**） |
| 行情源 | **前端直连交易所**（站点现状：默认 Gate.io，OKX/Binance 备选）；**本 Kronos 集成仅取 OKX / Binance**（见 §5） |
| Get APP 板块 | **当前不存在**（grep 无命中），需新建于页脚 |
| 部署 | Docker Compose：`app`(Node) + `alert-worker` + `postgres` + `redis` + `caddy` |
| 配色约定 | 站点默认红涨绿跌（中国习惯）；**但 Kronos 预测卡按用户要求改用绿涨红跌（国际惯例）** |

---

## 3. 集成架构

### 3.1 总体框图
```
┌─────────────────────────────────────────────────────────────┐
│ 浏览器  public/index.html  →  「Get APP」板块 + 预测卡          │
│         fetch('/api/kronos/forecast')                         │
└───────────────────────────┬─────────────────────────────────┘
                            │  (同源，走 Caddy/8787)
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ server.mjs (Node 8787)  新增反向代理  /api/kronos/*  ──────────┼──▶ 内部转发
└───────────────────────────┬─────────────────────────────────┘
                            │  http://kronos:8799
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ kronos-service (FastAPI :8799, Python + torch)               │
│   1) 拉 BTC_USDT K线 (server-side 直连交易所; 默认 OKX, 可切 Binance) │
│   2) KronosPredictor 推理 (循环采样)                          │
│   3) 派生 涨跌概率 + 波动率                                    │
│   4) Redis 缓存结果 (复用已有 redis 容器)                     │
│   返回 JSON                                                   │
└─────────────────────────────────────────────────────────────┘
```
- **为什么是独立 Python 服务**：Kronos 是 PyTorch/Python；站点后端是 Node，无法同进程加载。独立服务解耦、可独立扩缩、可本机 MPS / 容器 CPU 二选一。

---

## 4. 文件级改动清单

| 文件 | 动作 | 内容 |
|---|---|---|
| `kronos-service/app.py` | 新增 | FastAPI，`GET /api/kronos/forecast` |
| `kronos-service/inference.py` | 新增 | 加载模型 + 拉 K 线 + 推理 + 派生指标 |
| `kronos-service/requirements.txt` | 新增 | torch(CPU) / huggingface_hub / einops / pandas / numpy / fastapi / uvicorn / redis |
| `kronos-service/Dockerfile` | 新增 | python:3.11-slim，预缓存 Kronos-small 权重 |
| `kronos-service/README.md` | 新增 | 本地起停 + 验证命令 |
| `docker-compose.yml` | 改 | 新增 `kronos` 服务，接入现有 `redis` 网络 |
| `server.mjs` | 改 | 新增 `/api/kronos/*` 代理到 `kronos:8799`（绕 CORS、统一出口） |
| `public/index.html` | 改 | 页脚**新建「Get APP」板块**，含预测卡容器 `#kronos-forecast-card` |
| `public/src/modules/kronos-forecast.js` | 新增 | 拉取 + 渲染预测卡（涨跌箭头 / 概率 / 波动率 / **复用站点 canvas K 线**） |
| `public/app.js` | 改 | 注册并初始化 `kronos-forecast` 模块（遵循 core.js 的 registry/setter 约定） |
| `public/styles.css` | 改 | 板块 + 卡片样式（复用主题；预测卡涨跌色用绿涨红跌·国际惯例） |

> 纯前端改动**不需重启 8787**（server 每请求读磁盘）；改 `server.mjs`/Docker 才需重启。
> 所有前端改动按项目约定走 `?v=` 缓存戳收口（见 §13）。

---

## 5. 数据输入规格

### 5.1 K 线数据源（OKX / Binance 可切换）

Kronos 只吃 OHLCV，任意交易所都行；本集成**复用站点已有的多源能力**，推理输入在 `kronos-service` 内按 `exchange` 参数选源（默认 `okx`）。

| 交易所 | REST 端点 | 交易对参数 | 返回 K 线字段顺序（实现时打印首行核对） |
|---|---|---|---|
| OKX（欧易） | `GET /api/v5/market/candles` | `instId=BTC-USDT` | `[ts(ms), open, high, low, close, vol, volCcy, ...]` |
| Binance（币安） | `GET /api/v3/klines` | `symbol=BTCUSDT` | `[openTime, open, high, low, close, volume, closeTime, ...]` |

- 两者均取最近 `lookback=400` 根 → 映射为 Kronos 所需 `open/high/low/close/volume`；时间戳转 `pd.to_datetime`（**OKX/Binance 均为毫秒，注意单位**）。
- **字段顺序各家不同**（见上表），`kronos-service` 内用一个小 per-exchange 适配器做映射；**实现时必须打印首行核对**，避免 open/close 错位导致预测失真。
- 默认 `exchange=okx`；前端/接口可切 `binance`。

### 5.2 窗口参数（可调）
| 参数 | 建议值 | 含义 |
|---|---|---|
| `interval` | `1h` | K 线粒度 |
| `lookback` | `400` | 输入历史长度（≤512） |
| `pred_len` | `24`（展示未来 24h）或 `120` | 预测步数 |

---

## 6. 预测派生逻辑（涨跌 / 波动）—— 核心算法

### 6.1 上涨概率（多路径随机采样法）
> ⚠️ `predict(sample_count=N)` 返回 N 条路径**均值**，无法求分布。正确做法：循环 `N` 次、每次 `sample_count=1`、`T=1.2` 的随机采样，收集每条路径期末 `close`。

```
N = 8                         # 采样路径数（可配）
last_close = x_df['close'].iloc[-1]
ends = []
for i in range(N):
    p = predictor.predict(df=x_df, x_timestamp=xts, y_timestamp=yts,
                          pred_len=pred_len, T=1.2, top_p=0.95, sample_count=1)
    ends.append(p['close'].iloc[-1])

p_up   = mean(c > last_close for c in ends)   # 上涨概率
p_down = 1 - p_up
direction = "up" if p_up > 0.5 else "down"
```

### 6.2 波动放大概率（Volatility Amplification）
与 Kronos 官方 demo 对齐：预测期内的波动率（平均 `(high−low)/close`）相对近期历史波动率放大的概率。

```python
avg_path = predictor.predict(..., sample_count=4)
pred_vol  = mean((avg_path['high'] - avg_path['low']) / avg_path['close'])
hist_vol  = mean((x_df['high']   - x_df['low'])   / x_df['close'])
vol_amplification = pred_vol / hist_vol - 1.0

# 多次采样算「放大」概率
sampled_vols = [ mean((path['high']-path['low'])/path['close']) for path in N_paths ]
p_vol_amp = mean(sampled_vols > hist_vol * 1.05)
volatilityLevel = "低" if p_vol_amp < 0.35 else ("中" if p_vol_amp < 0.65 else "高")
```
- `volatilityAmplification`：预测波动相对历史放大的比例（可为负，即缩小）。
- `pVolatilityAmplification`：预测波动显著高于历史波动的概率。

### 6.3 输出 JSON Schema
```json
{
  "symbol": "BTC_USDT",
  "interval": "1h",
  "exchange": "okx",
  "predLen": 24,
  "model": "Kronos-small",
  "direction": "up | down | neutral",
  "pUp": 0.62,
  "pDown": 0.38,
  "volatilityLevel": "中",
  "volatilityAmplification": 0.12,
  "pVolatilityAmplification": 0.58,
  "lastClose": 64000.0,
  "history": [
    { "t": "2026-09-24T19:00:00Z", "close": 63800, "volume": 120.5 }
  ],
  "forecast": [
    { "t": "2026-09-25T19:00:00Z", "open": 64000, "high": 64500, "low": 63800, "close": 64300, "volume": 115.3 }
  ],
  "forecastRange": [
    { "t": "2026-09-25T19:00:00Z", "min": 63900, "max": 64700 }
  ],
  "generatedAt": "2026-09-25T18:43:00Z"
}
```
- `direction`：方向判定，含 ±5% 死区（0.45–0.55 显示 `neutral`）。
- `history`：最近 `predLen` 根历史 close / volume，前端绘制蓝色「历史」段。
- `forecast`：均值预测 OHLCV（`sample_count=4`），前端绘制橙色「均值预测」段。
- `forecastRange`：各预测时点 close 在多次蒙特卡罗采样中的 `min/max`，用于绘制橙色半透明预测范围阴影，表达不确定性。

---

## 7. 推理服务设计（kronos-service）

### 7.1 目录
```
kronos-service/
├── app.py
├── inference.py
├── requirements.txt
├── Dockerfile
└── README.md
```

### 7.2 app.py（接口）
```python
from fastapi import FastAPI, Response
from inference import get_forecast
import redis, json, os

app = FastAPI()
r = redis.Redis.from_url(os.getenv("REDIS_URL", "redis://redis:6379"))

CACHE_TTL = 3600  # 1h

@app.get("/api/kronos/forecast")
def forecast(exchange: str = "okx", symbol: str = "BTC_USDT", interval: str = "1h", pred_len: int = 24):
    key = f"kronos:v4:{exchange}:{symbol}:{interval}:{pred_len}"
    hit = r.get(key)
    if hit:
        return Response(content=hit, media_type="application/json")
    data = get_forecast(exchange, symbol, interval, pred_len)   # 见 7.3
    body = json.dumps(data, ensure_ascii=False)
    r.setex(key, CACHE_TTL, body)
    return Response(content=body, media_type="application/json")
```

### 7.3 inference.py（流程）
1. `load_model()` 懒加载 `Kronos-small` + Tokenizer（首次下载权重，全局缓存）。
2. `fetch_kline(exchange, symbol, interval, limit=512)` → 按 `exchange` 选端点（见 §5.1 表）→ 经 per-exchange 适配器映射为 DataFrame。
3. 按 §6.1 / §6.2 跑采样、派生指标。
4. 返回 §6.3 的 dict。

### 7.4 requirements.txt
```
torch>=2.0.0
huggingface_hub==0.33.1
einops==0.8.1
pandas==2.2.2
numpy
safetensors==0.6.2
fastapi
uvicorn[standard]
redis
```

### 7.5 Dockerfile（要点）
- 基础 `python:3.11-slim`；装 `torch` **CPU 版**（`pip install torch --index-url https://download.pytorch.org/whl/cpu` 以减小体积）。
- 构建期预下载权重：`python -c "from model import Kronos,KronosTokenizer; Kronos.from_pretrained('NeoQuasar/Kronos-small'); KronosTokenizer.from_pretrained('NeoQuasar/Kronos-Tokenizer-base')"`（需联网拉一次）。
- 启动 `uvicorn app:app --host 0.0.0.0 --port 8799`。

---

## 8. 前端 AI 预测板块（内嵌，无下载入口）

> 板块为**网站内嵌功能区**，不做 APP 下载入口（用户已确认）。

### 8.1 HTML（index.html 页脚新增）
```html
<section class="card get-app-card">
  <div id="kronos-forecast-card" class="forecast-card">
    <div class="kf-head"><h2>AI 预测</h2><span class="kf-exchange" id="kf-exchange">OKX</span></div>
    <div class="kf-probability-grid">
      <div class="kf-prob-card" id="kf-up-card">
        <div class="kf-prob-title">上涨概率（未来 24 小时）</div>
        <div class="kf-prob-value" id="kf-up-prob">--</div>
        <div class="kf-prob-desc">该模型对24小时后价格高于上次已知价格的置信度。</div>
      </div>
      <div class="kf-prob-card" id="kf-vol-card">
        <div class="kf-prob-title">波动性放大（未来24小时）</div>
        <div class="kf-prob-value" id="kf-vol-prob">--</div>
        <div class="kf-prob-desc">预测未来 24 小时内波动率超过近期历史波动率的概率。</div>
      </div>
    </div>
    <div class="kf-forecast-section">
      <h3>24小时概率预报</h3>
      <p>下图显示了历史价格（蓝色）和概率预测（橙色）。橙色线是多次蒙特卡罗模拟的平均值，阴影区域代表预测结果的全部范围，表明预测的不确定性。</p>
      <div class="kf-chart-title">BTCUSDT 概率价格与成交量预报（未来 24 小时）</div>
      <div class="kf-chart-wrap">
        <canvas id="kf-price-chart" class="kf-chart kf-price-chart"></canvas>
        <canvas id="kf-volume-chart" class="kf-chart kf-volume-chart"></canvas>
      </div>
    </div>
    <div class="kf-foot"><span id="kf-updated">--</span><span class="kf-disclaimer">模型预测仅供参考，非投资建议</span></div>
  </div>
</section>
```

### 8.2 渲染逻辑（kronos-forecast.js）
- `fetch('/api/kronos/forecast')` → 渲染：
  - **顶部双卡片**：左卡「上涨概率（未来 24 小时）」显示 `pUp` 大数字 + 置信度说明；右卡「波动性放大（未来 24 小时）」显示 `pVolatilityAmplification` 大数字 + 说明。卡片边框按方向/波动等级动态着色（涨绿 / 跌红 / 中性灰；波动低灰 / 中黄 / 高橙）。
  - **24 小时概率预报区**：标题 + 说明文字 + 子标题「BTCUSDT Probabilistic Price & Volume Forecast (Next 24 Hours)」。
  - **价格预报图（canvas）**：蓝色折线为历史 `history.close`；橙色折线为均值预测 `forecast.close`；橙色半透明阴影填充 `forecastRange` 的 min/max 区间；红色虚线分隔「当前/未来」。
  - **成交量预报图（canvas）**：蓝色柱状为历史 `history.volume`；橙色柱状为均值预测 `forecast.volume`；红色虚线分隔。
  - 图例、坐标轴标签、价格 Y 轴、成交量 Y 轴均轻量绘制，零新增图表库。
  - 脚注：「模型预测仅供参考，非投资建议」+ 「更新于 {generatedAt}」。
- 定时刷新：每 `CACHE_TTL`（1h）拉一次；首屏 loading 占位。

### 8.3 样式
- 复用 `styles.css` 主题变量与卡片样式；**涨跌色特例用绿涨红跌（国际惯例）**，刻意区别于站点默认的红涨绿跌。
- 顶部 `.kf-probability-grid` 双列网格（移动端单列）；`.kf-prob-value` 为大号数字（38px），按方向/波动等级改变卡片边框色。
- 图表区 `.kf-chart-wrap` 包含上下两张 canvas：`.kf-price-chart` 高 260px（移动端 220px），`.kf-volume-chart` 高 130px（移动端 110px），均带深色细边框与圆角。

---

## 9. server.mjs 代理
- 在 `http.createServer` 路由分发处，对路径前缀 `/api/kronos/` 做内部 `fetch('http://kronos:8799' + 原路径)` 并透传，避免浏览器跨域、统一出口。
- Node 22 全局 `fetch` 可用；注意透传 method/headers/body。

---

## 10. Docker 编排
- `docker-compose.yml` 新增服务：
```yaml
  kronos:
    build: ./kronos-service
    restart: unless-stopped
    environment:
      REDIS_URL: redis://redis:6379
    expose:
      - "8799"
    depends_on:
      redis:
        condition: service_healthy
```
- 复用现有 `redis` 容器做缓存；不暴露宿主机端口（仅内部访问）。

---

## 11. 部署与缓存
- 首次启动从 HF 拉 `Kronos-small`（24.7M）→ 预缓存进镜像 volume，避免每次拉。
- 部署机需能访问 `huggingface.co`（或构建期预缓存、离线运行）。
- Redis 缓存 1h，避免每请求都跑模型（CPU 推理 small 约数秒~十秒）。

---

## 12. 风险与免责
- **新增 Python 运行时**：现有栈纯 Node，Docker 镜像体积显著增大（torch CPU 几百 MB）。
- **权重来源**：来自 Hugging Face，需网络或在构建期预缓存。
- **非交易信号**：Kronos 原始预测不保证盈利；卡片必须加免责声明。
- **字段映射风险**：各家交易所 K 线字段顺序不同（见 §5.1 表），须按所选 `exchange` 用对应适配器映射，并实现时打印首行核对，避免 open/close 错位导致预测失真。
- **缓存戳**：前端文件改动按项目约定 bump `?v=`，否则用户端可能长期看到旧副本。

---

## 13. 落地顺序（里程碑）
1. **M1 推理服务**：本机起 `kronos-service`（MPS 跑 small），`curl /api/kronos/forecast` 验证 JSON 正确（涨跌 + 波动 + forecast）。
2. **M2 前端卡**：index.html 加 Get APP + 预测卡，`kronos-forecast.js` 渲染（先调本机服务）。
3. **M3 代理 + Docker**：server.mjs 代理 + docker-compose `kronos` 服务 + Redis 缓存。
4. **M4 收口**：`?v=` 缓存戳、版本号、静态自检（`npm run check`）、端到端验证。

---

## 14. 验证清单
- [ ] `curl localhost:8799/api/kronos/forecast` 返回合法 JSON（§6.3 字段齐全）。
- [ ] `curl 'localhost:8799/api/kronos/forecast?exchange=okx'` 与 `?exchange=binance` 均返回合法 JSON（验证多源 K 线映射，open/close 未错位）。
- [ ] `pUp + pDown ≈ 1`，`direction` 与 `pUp>0.5` 一致。
- [ ] `forecast` 长度 == `pred_len`，时间戳递增；每条含 `volume`。
- [ ] `history` 长度 == `pred_len`，含 `close` / `volume`。
- [ ] `forecastRange` 长度 == `pred_len`，含 `min` / `max`。
- [ ] 前端面板显示「上涨概率」「波动性放大」两张大数字卡片与「24小时概率预报」标题说明。
- [ ] 价格图：蓝色历史折线、橙色预测均值线、橙色半透明 min/max 阴影、红色虚线分隔。
- [ ] 成交量图：蓝色历史柱状、橙色预测均值柱状、红色虚线分隔。
- [ ] Redis 缓存命中（第二次请求 8799 无模型推理日志）。
- [ ] `npm run check` 通过；`?v=` 戳已更新；浏览器硬刷新后看到新卡。
- [ ] Docker `kronos` 服务 `docker compose up` 正常启动并通过健康检查。

---

## 15. 历史准确度回测模块（Backtest）

> 在「KRONOS AI预测」卡内新增「历史准确度回测」区块，量化模型在近期历史时点上的真实表现，避免「展示预测却无法验证」。

### 15.1 方法学
- 在历史锚点（默认过去 `weeks=12` 周、每周一个锚点）用**当时可得的 K 线**跑与实时**完全相同**的推理（`_prepare_ctx` + `_metrics_from_ctx`），得到当时预测的 `pUp` / 波动放大概率；再拉取该锚点 **24 小时后**的真实 K 线，判定实际涨跌 / 实际波动是否放大；逐样本比对后聚合。

### 15.2 指标
| 指标 | 含义 |
|---|---|
| `directionalAccuracy` | 方向准确率：预测方向（pUp>0.5=涨）与实际 24h 涨跌一致的比例 |
| `brier` | Brier 分数（越小越好）；对照 `naiveBrier`（一律押多数类 baseRate 的基准） |
| `volHitRate` | 波动放大命中率：预测「波动放大」且实际波动放大的比例 |
| `samples` / `errors` | 有效样本数 / 因历史数据缺失被跳过的锚点数 |

- **诚实原则**：回测**如实展示**聚合结果，不粉饰。若样本期内标的单边（如 12 周里 9 周实际上涨），而模型频繁给出反向信号，方向准确率会低于 0.5 / 低于 naiveBrier——这如实反映模型在该窗口的短期方向弱势，而非 bug。

### 15.3 深历史数据源（关键坑）
- **OKX 公开蜡烛接口仅回翻约 60 天**（`after`/`before` 游标上限），而回测需 ~12×168≈2016 根 1h K 线（≈84 天）。→ 回测**默认 `exchange=binance`**（Binance `endTime` 有深历史，200 天前仍返回 300 根）。
- `fetch_kline_history` 用分页 `after` 游标回翻 + concat + 排序 + 去重；`backtest` 内动态裁剪 `weeks`：`max_weeks=(hist_len-lookback-pred_len-50)//168`，`eff_weeks=max(1,min(weeks,max_weeks))`，历史不够时自动缩减周数而非报错。

### 15.4 端点与缓存
- `GET /api/kronos/backtest?weeks=12&exchange=binance&force=False`（`kronos-service/app.py`）。非 `force` 走 Redis 缓存（TTL 86400）；`force=True` 强制重算。
- 前端 `BACKTEST_TIMEOUT=180_000`（首次冷算可能 1–3 分钟）；每日重新拉取（`setInterval(loadBacktest, 24h)` 对齐服务端按天缓存）。

### 15.5 前端渲染
- `index.html`：`#kf-backtest` 含 head（h3「历史准确度回测」+exchange 徽标）、note（数据来源说明）、`#kf-backtest-grid`（4 卡：方向准确率 / Brier / 波动放大命中率 / 样本数，方向准确率卡≥50%绿、<50%红）、chart-title、`<canvas id=kf-backtest-chart>`（各锚点预测上涨概率柱状，绿=实际上涨、红=实际下跌，50% 参考虚线）、foot（生成时间）。
- `kronos-forecast.js`：`loadBacktest()` / `renderBacktest()` / `drawBacktestChart()`。
- ⚠️ **回测说明文案 bug（已修）**：note `<p>` 一度同时带 `data-zh`/`data-en`，被 `app.js` 的 `applyStaticI18n()` 在语言切换时覆盖回静态占位「回测计算中…」。修复：去掉 note 的 `data-zh`/`data-en`（文案完全由 `renderBacktest` 经 `tx()` 动态管理），并在 `init()` 监听 `btc:voice-language-changed` 重渲染。详见 §12 同款教训：**动态文案元素勿带 `data-zh`/`data-en`**。

### 15.6 实测（v2.12.36，12 样本 / 0 错误）
`dirAcc=0.4545`、`brier=0.3466`(naiveBrier=0.1875)、`baseRate=0.75`、`volHitRate=0.0909`。样本周 BTC 75% 实际上涨，模型却频繁误判下跌、波动放大概率恒为 1.0（T=1.2 高温采样噪声大）→ 短期方向准确率低于朴素基准。方法学无误，如实展示。
```
