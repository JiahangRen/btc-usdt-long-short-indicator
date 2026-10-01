# Kronos 推理服务

独立 Python（FastAPI）微服务，用开源金融基座模型 [Kronos](https://github.com/shiyu-coder/Kronos)（MIT）
预测 BTC 未来 K 线，并派生「上涨概率 / 波动放大概率」。通过 `btc指示器` 站点的
`server.mjs` 代理（`/api/kronos/*`）供前端预测卡访问。

## 模型选型（见 spec §1.2）

- **默认 Kronos-small**（24.7M）：M1 Max MPS 几秒出，优先用它打通链路。
- **base** 仅缓存模式可用（单机十秒~一分钟级），需配合 Redis 缓存 + 后台刷新。
- **large 不可用**（未开源）。

## 方式一：launchd 常驻（推荐，开网页自动可用）

已随 btc-indicator 一起注册。点桌面「BTC 多空指标」图标时，`scripts/launch-btc-indicator.sh`
会先同步 launchd 配置并等 Kronos（8799）就绪，再打开网页。

首次/重装后手动注册一次：

```bash
cd /Users/jeffereyreng/ChatGPT/btc指示器
mkdir -p ~/Library/LaunchAgents
cp com.jeffereyreng.btc-kronos.plist ~/Library/LaunchAgents/
launchctl bootout gui/$(id -u)/com.jeffereyreng.btc-kronos 2>/dev/null || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jeffereyreng.btc-kronos.plist
```

之后每次登录自动启动。日常可：

```bash
kronos-kick   # 重启服务（.zshrc alias）
kronos-log    # 看日志
kronos-err    # 看错误日志
```

## 方式二：手动启动（开发 / 验证）

```bash
cd kronos-service
./start-local.sh
```

这会：clone Kronos 源码 → 建 venv → 装依赖 → 预加载 small 权重 → 起 uvicorn。

```bash
# 验证
curl 'http://127.0.0.1:8799/api/kronos/forecast?exchange=okx'
curl 'http://127.0.0.1:8799/api/kronos/forecast?exchange=binance'
curl 'http://127.0.0.1:8799/health'
```

`inference.py` 顶部也支持 `python inference.py` 直接跑一次完整预测做快速验证。

## 参数

| 查询参数 | 默认 | 说明 |
|---|---|---|
| `exchange` | `okx` | `okx` / `binance`（本集成不含 Gate.io） |
| `symbol` | `BTC_USDT` | 交易对 |
| `interval` | `1h` | K 线粒度 |
| `pred_len` | `24` | 预测步数（展示未来 24h） |

## 环境变量

- `REDIS_URL`：缓存地址，默认 `redis://redis:6379`（无 Redis 时降级为实时推理）。
- `KRONOS_CACHE_TTL`：缓存秒数，默认 `3600`。
- `KRONOS_MODEL`：模型名，默认 `NeoQuasar/Kronos-small`。
- `KRONOS_PATH` / `PYTHONPATH`：Kronos 仓库路径（容器内为 `/opt/Kronos`）。

## 部署

见根目录 `docker-compose.yml` 的 `kronos` 服务，复用站点已有 `redis` 容器做缓存。
