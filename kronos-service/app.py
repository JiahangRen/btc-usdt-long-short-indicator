"""Kronos 推理服务（FastAPI）。

路由：
  GET /api/kronos/forecast?exchange=okx|binance&symbol=BTC_USDT&interval=1h&pred_len=24
  GET /health

结果经 Redis 缓存（默认 TTL 1h），避免每次请求都跑模型。
前端经 server.mjs 代理的 /api/kronos/* 访问，默认开发地址 http://127.0.0.1:8799。
"""

import os
import json
import threading
import redis
from fastapi import FastAPI, Response, HTTPException

import inference

app = FastAPI(title="Kronos BTC Forecast Service")

_r = redis.Redis.from_url(os.getenv("REDIS_URL", "redis://redis:6379"), decode_responses=True)
_CACHE_TTL = int(os.getenv("KRONOS_CACHE_TTL", "3600"))


def _warm_cache():
    """启动时后台预热默认（okx）预测，避免首个用户遇到 78s 冷调用。"""
    try:
        inference.get_forecast("okx", "BTC_USDT", "1h", 24)
        print("[warmup] okx forecast cached", flush=True)
    except Exception as e:
        print("[warmup] failed:", e, flush=True)


@app.on_event("startup")
def _on_startup():
    threading.Thread(target=_warm_cache, daemon=True).start()


@app.get("/api/kronos/forecast")
def forecast(exchange: str = "okx", symbol: str = "BTC_USDT",
             interval: str = "1h", pred_len: int = 24):
    # 缓存键带版本号：推理逻辑/指标变更时升版，使旧缓存自然失效
    key = f"kronos:v4:{exchange}:{symbol}:{interval}:{pred_len}"
    try:
        hit = _r.get(key)
        if hit:
            return Response(content=hit, media_type="application/json")
    except Exception:
        pass  # Redis 不可用时降级为实时推理

    try:
        data = inference.get_forecast(exchange, symbol, interval, pred_len)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"forecast failed: {e}")

    body = json.dumps(data, ensure_ascii=False)
    try:
        _r.setex(key, _CACHE_TTL, body)
    except Exception:
        pass
    return Response(content=body, media_type="application/json")


@app.get("/api/kronos/backtest")
def backtest(exchange: str = "binance", symbol: str = "BTC_USDT",
             interval: str = "1h", pred_len: int = 24,
             days: int = 30, force: bool = False):
    # 回测耗时较长（逐锚点跑模型），结果缓存一天；force=true 可强制重算。
    key = f"kronos:backtest:v2:{exchange}:{symbol}:{interval}:{pred_len}:{days}"
    if not force:
        try:
            hit = _r.get(key)
            if hit:
                return Response(content=hit, media_type="application/json")
        except Exception:
            pass

    try:
        data = inference.backtest(exchange, symbol, interval, pred_len,
                                 sample_paths=12, days=days)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"backtest failed: {e}")

    body = json.dumps(data, ensure_ascii=False)
    try:
        _r.setex(key, 86400, body)
    except Exception:
        pass
    return Response(content=body, media_type="application/json")


@app.get("/health")
def health():
    return {"status": "ok", "model": inference._MODEL_NAME}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8799")))
