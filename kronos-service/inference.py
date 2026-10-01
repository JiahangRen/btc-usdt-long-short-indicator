"""Kronos 推理核心：拉取 OKX/Binance K 线 → Kronos 自回归预测 → 派生涨跌概率 + 波动放大概率。

模型选型（见 docs/kronos-btc-forecast-integration-spec.md §1.2）：
  - 默认 Kronos-small（24.7M，M1 Max MPS 几秒出）。
  - base 仅缓存模式可用；large 不可用（未开源）。
Kronos 原生只输出 OHLCV 点预测；「涨跌概率 / 波动率」由本文件派生（§6）。

新增（§9 回测）：backtest() 在多个历史锚点用当时 K 线跑相同推理，对比 24h 后真实走势，
输出方向准确率 / Brier 分数 / 波动放大命中率，用于展示「历史准确度」。
"""

import os
import sys
import time
import json
from datetime import timedelta

import numpy as np
import pandas as pd
import requests
import torch

# ── 让 `from model import ...` 可用 ──────────────────────────────────────────
# Kronos 仓库（含 model.py / tokenizer）以源码形式提供，需要放进 PYTHONPATH。
# Dockerfile 把仓库 clone 到 /opt/Kronos 并设 PYTHONPATH；本机调试可 export KRONOS_PATH=...
_KRONOS_PATH = os.environ.get("KRONOS_PATH", "/opt/Kronos")
if _KRONOS_PATH not in sys.path:
    sys.path.insert(0, _KRONOS_PATH)

from model import Kronos, KronosTokenizer, KronosPredictor  # noqa: E402

_MODEL_NAME = os.environ.get("KRONOS_MODEL", "NeoQuasar/Kronos-small")
_MAX_CONTEXT = int(os.environ.get("KRONOS_MAX_CONTEXT", "512"))

# 懒加载，全局单例
_PREDICTOR = None

# 交易所 K 线字段顺序（实现时必须打印首行核对，避免 open/close 错位）：
#   OKX    : GET /api/v5/market/candles  → data[i] = [ts(ms), open, high, low, close, vol, volCcy, ...]（倒序，最新在前）
#   Binance: GET /api/v3/klines          → [openTime(ms), open, high, low, close, volume, closeTime, quoteVol, ...]（正序，最旧在前）
# OKX/Binance 时间戳均为毫秒（UTC）。

_OKX_BAR = {"1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m",
            "1h": "1H", "4h": "4H", "1d": "1D", "1w": "1W"}
_BINANCE_INT = {"1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m",
                "1h": "1h", "4h": "4h", "1d": "1d", "1w": "1w"}
_INTERVAL_SECONDS = {"1m": 60, "5m": 300, "15m": 900, "30m": 1800,
                     "1h": 3600, "4h": 14400, "1d": 86400, "1w": 604800}

# 各交易所单次 K 线请求的数量上限（OKX 上限 300，Binance 上限 1000）。
# 超出部分会被交易所截断，因此 lookback 必须按此上限动态计算。
_EXCHANGE_LIMIT_MAX = {"okx": 300, "binance": 1000}


def _interval_delta(interval: str) -> timedelta:
    return timedelta(seconds=_INTERVAL_SECONDS.get(interval, 3600))


def load_model(model_name=_MODEL_NAME, max_context=_MAX_CONTEXT):
    """懒加载 Kronos 模型 + Tokenizer + Predictor（全局单例）。"""
    global _PREDICTOR
    if _PREDICTOR is not None:
        return _PREDICTOR
    tokenizer = KronosTokenizer.from_pretrained("NeoQuasar/Kronos-Tokenizer-base")
    model = Kronos.from_pretrained(model_name)
    _PREDICTOR = KronosPredictor(model, tokenizer, max_context=max_context)
    return _PREDICTOR


def classify_path_shape(prices: np.ndarray, threshold: float = 0.005) -> str:
    """对一条价格路径做 24h 走势形状分类。

    返回字符串键（前端有对应 i18n 映射）：
      up_sustained    持续上涨（终点明显高于起点，最高点在末尾附近）
      down_sustained  持续下跌（终点明显低于起点，最低点在末尾附近）
      up_then_down    先涨后跌（最高点在前半段，最低点在后半段）
      down_then_up    先跌后涨（最低点在前半段，最高点在后半段）
      up_choppy       震荡上行
      down_choppy     震荡下行
      choppy          横盘震荡 / 无明显趋势
    threshold=0.5% 用于过滤收盘变化过小的"横盘"。
    """
    if len(prices) < 2:
        return "choppy"
    start = float(prices[0])
    end = float(prices[-1])
    if start <= 0:
        return "choppy"
    change = (end - start) / start
    max_idx = int(np.argmax(prices))
    min_idx = int(np.argmin(prices))
    n = len(prices)

    if change > threshold and (max_idx >= n * 0.7 or max_idx == n - 1):
        return "up_sustained"
    if change < -threshold and (min_idx >= n * 0.7 or min_idx == n - 1):
        return "down_sustained"
    if change < -threshold and max_idx <= n * 0.4 and min_idx >= n * 0.6:
        return "up_then_down"
    if change > threshold and min_idx <= n * 0.4 and max_idx >= n * 0.6:
        return "down_then_up"
    if change > threshold:
        return "up_choppy"
    if change < -threshold:
        return "down_choppy"
    return "choppy"


# ── K 线拉取（最新） ─────────────────────────────────────────────────────────

def _parse_rows(rows, close_idx, vol_idx, amount_idx):
    """通用：把交易所原始行映射为 Kronos 所需的 OHLCVA DataFrame（正序，最旧在前）。"""
    out = []
    for row in rows:
        ts_ms = int(row[0])
        close = float(row[close_idx])
        vol = float(row[vol_idx])
        try:
            amount = float(row[amount_idx])
        except (ValueError, TypeError, IndexError):
            amount = close * vol
        out.append({
            "timestamps": pd.to_datetime(ts_ms, unit="ms", utc=True),
            "open": float(row[1]), "high": float(row[2]),
            "low": float(row[3]), "close": close,
            "volume": vol, "amount": amount,
        })
    return pd.DataFrame(out)


def _okx_klines(symbol: str, interval: str, limit: int, after_ms: int = None) -> pd.DataFrame:
    bar = _OKX_BAR.get(interval, interval)
    url = f"https://www.okx.com/api/v5/market/candles?instId={symbol}&bar={bar}&limit={limit}"
    # OKX：after 为「上界游标」，返回 ts < after 的更老 K 线（用于向历史回翻分页）
    if after_ms is not None:
        url += f"&after={int(after_ms)}"
    r = requests.get(url, timeout=10)
    r.raise_for_status()
    rows = r.json().get("data") or []
    if not rows:
        raise ValueError("OKX returned empty klines")
    rows = list(reversed(rows))  # 转正序：最旧在前
    return _parse_rows(rows, close_idx=4, vol_idx=5, amount_idx=6)


def _binance_klines(symbol: str, interval: str, limit: int, after_ms: int = None) -> pd.DataFrame:
    intv = _BINANCE_INT.get(interval, interval)
    url = f"https://api.binance.com/api/v3/klines?symbol={symbol}&interval={intv}&limit={limit}"
    # Binance：endTime 为「上界游标」，返回结束时间 <= endTime 的更老 K 线（用于回翻分页）
    if after_ms is not None:
        url += f"&endTime={int(after_ms)}"
    r = requests.get(url, timeout=10)
    r.raise_for_status()
    rows = r.json()
    if not rows:
        raise ValueError("Binance returned empty klines")
    return _parse_rows(rows, close_idx=4, vol_idx=5, amount_idx=7)


def fetch_kline(exchange: str, symbol: str, interval: str, limit: int = 512) -> pd.DataFrame:
    """按 exchange 拉取「最新」BTC K 线，映射为 Kronos 所需的 OHLCVA DataFrame。"""
    exchange = (exchange or "okx").lower()
    limit = min(limit, _EXCHANGE_LIMIT_MAX.get(exchange, 300))
    if exchange == "okx":
        return _okx_klines(symbol.replace("_", "-"), interval, limit)
    if exchange == "binance":
        return _binance_klines(symbol.replace("_", ""), interval, limit)
    raise ValueError(f"unsupported exchange: {exchange}")


def fetch_kline_history(exchange: str, symbol: str, interval: str, bars: int = 2100) -> pd.DataFrame:
    """分页拉取最近 `bars` 根历史 K 线（正序，最旧在前），用于回测在本地按锚点切片。

    用交易所的「上界游标」向后翻页：每批最多 300 根，下一批 after=本批最老 ts。
    历史 K 线不可变，因此用当前历史重建过去任意时刻的上下文是准确的。
    """
    exchange = (exchange or "okx").lower()
    limit = min(300, _EXCHANGE_LIMIT_MAX.get(exchange, 300))
    out = []
    seen = 0
    after_ms = None
    while seen < bars:
        if exchange == "okx":
            df = _okx_klines(symbol.replace("_", "-"), interval, limit, after_ms=after_ms)
        elif exchange == "binance":
            df = _binance_klines(symbol.replace("_", ""), interval, limit, after_ms=after_ms)
        else:
            raise ValueError(f"unsupported exchange: {exchange}")
        if df.empty:
            break
        out.append(df)
        seen += len(df)
        # 下一批：以本批最老 ts 作为上界游标，翻出更老的数据
        after_ms = int(df["timestamps"].iloc[0].timestamp() * 1000)
        if len(df) < limit:
            break  # 已到数据起点
    if not out:
        raise ValueError("no historical klines fetched")
    full = pd.concat(out, ignore_index=True)
    full = full.sort_values("timestamps").drop_duplicates("timestamps").reset_index(drop=True)
    return full


# ── 预测核心（get_forecast 与 backtest 共用） ────────────────────────────────

def _predict_once(predictor, x_df, x_timestamp, y_timestamp, pred_len, T, top_p):
    return predictor.predict(
        df=x_df[["open", "high", "low", "close", "volume", "amount"]],
        x_timestamp=x_timestamp,
        y_timestamp=y_timestamp,
        pred_len=pred_len,
        T=T,
        top_p=top_p,
        sample_count=1,
        verbose=False,
    )


def _prepare_ctx(ctx_df: pd.DataFrame, interval: str, pred_len: int, lookback: int):
    """从 ctx_df 取最后 lookback 行作为上下文，构造时间戳序列与最后已知收盘价。"""
    x_df = ctx_df.iloc[-lookback:].copy()
    x_timestamp = x_df["timestamps"]   # 先取时间戳，再裁成模型所需的 6 列
    x_df = x_df[["open", "high", "low", "close", "volume", "amount"]]
    last_ts = x_timestamp.iloc[-1]     # 时间戳已从 x_timestamp 保留，避免被 6 列裁剪丢掉
    delta = _interval_delta(interval)
    y_timestamp = pd.Series([last_ts + delta * (i + 1) for i in range(pred_len)])
    last_close = float(x_df["close"].iloc[-1])
    return x_df, x_timestamp, y_timestamp, last_close


def _ctx_token_len(predictor, x_df: pd.DataFrame) -> int:
    """Kronos 把 512 根上下文压成变长 token 序列；token 数 < max_context(512) 会让
    auto_regressive_inference 的缓冲区赋值形状不匹配而崩溃。这里先快速 token 化，
    返回 token 序列长度，供回测在跑慢速推理前筛掉会崩溃的窗口。"""
    cols = ["open", "high", "low", "close", "volume", "amount"]
    x = x_df[cols].values.astype(np.float32)
    xm, xs = np.mean(x, axis=0), np.std(x, axis=0)
    x = (x - xm) / (xs + 1e-5)
    x = np.clip(x, -5, 5)
    x = x[np.newaxis, :]
    try:
        # 注意：tokenizer/model 在 predictor.device（MPS）上，x 必须搬到同设备，
        # 否则 CPU tensor 传入会触发设备不匹配异常（被 except 吞成 0，导致预检误杀全部窗口）。
        xt = predictor.tokenizer.encode(torch.from_numpy(x).to(predictor.device), half=True)
        return int(xt[0].size(1))
    except Exception:
        return 0


def _metrics_from_ctx(predictor, x_df, x_timestamp, y_timestamp, last_close,
                      pred_len, sample_paths, T, top_p) -> dict:
    """循环采样收集每条 Monte Carlo 路径的完整 close/volume 序列，派生涨跌概率 + 波动放大。"""
    ends = []
    path_vols = []
    close_paths = []
    volume_paths = []
    success = 0
    for _ in range(sample_paths):
        # 单条采样路径偶发失败（MPS 瞬时错误 / 数值异常）不应拖垮整锚点；
        # 跳过坏路径，只要成功路径达到下限就继续。否则整批回测会因个别坏样本大量断档。
        try:
            pred = _predict_once(predictor, x_df, x_timestamp, y_timestamp, pred_len, T, top_p)
        except Exception:
            continue
        ends.append(float(pred["close"].iloc[-1]))
        path_vols.append(float(np.mean((pred["high"] - pred["low"]) / pred["close"])))
        close_paths.append(pred["close"].to_numpy(dtype=float))
        volume_paths.append(pred["volume"].to_numpy(dtype=float))
        success += 1
    min_paths = max(1, sample_paths // 4)
    if success < min_paths:
        raise RuntimeError(f"only {success}/{sample_paths} sample paths succeeded")
    ends = np.array(ends, dtype=float)
    path_vols = np.array(path_vols, dtype=float)
    close_paths = np.array(close_paths, dtype=float)     # shape (sample_paths, pred_len)
    volume_paths = np.array(volume_paths, dtype=float)
    close_min = close_paths.min(axis=0)
    close_max = close_paths.max(axis=0)

    p_up = float(np.mean(ends > last_close))
    p_down = 1.0 - p_up

    # 波动放大概率：用 avg 预测（sample_count=4）算预测期波动率，并与历史波动率比较；
    # 同时用各路径波动率看超过历史 5% 的占比（即「放大」置信概率）。
    try:
        avg = predictor.predict(
            df=x_df[["open", "high", "low", "close", "volume", "amount"]],
            x_timestamp=x_timestamp, y_timestamp=y_timestamp,
            pred_len=pred_len, T=T, top_p=top_p, sample_count=4, verbose=False,
        )
        pred_vol = float(np.mean((avg["high"] - avg["low"]) / avg["close"]))
    except Exception:
        # avg 预测失败时，用已采集成功路径的均值/包络作为回退，避免整锚点失败
        cp = np.array(close_paths, dtype=float)        # (success, pred_len)
        avg_close = cp.mean(axis=0)
        avg_high = cp.max(axis=0)
        avg_low = cp.min(axis=0)
        avg = pd.DataFrame({"close": avg_close, "high": avg_high, "low": avg_low})
        pred_vol = float(np.mean((avg_high - avg_low) / avg_close))
    hist_vol = float(np.mean((x_df["high"] - x_df["low"]) / x_df["close"]))
    vol_amplification = 0.0 if hist_vol <= 0 else float(pred_vol / hist_vol - 1.0)
    p_vol_amp = float(np.mean(path_vols > hist_vol * 1.05))
    vol_level = "低" if p_vol_amp < 0.35 else ("中" if p_vol_amp < 0.65 else "高")

    # 方向判定加 ±5% 死区：p_up 恰好 0.5 时不误导性地标成「下跌」，而显示「震荡」
    if p_up > 0.55:
        direction = "up"
    elif p_up < 0.45:
        direction = "down"
    else:
        direction = "neutral"

    predicted_shape = classify_path_shape(avg["close"].to_numpy(dtype=float))

    return {
        "direction": direction,
        "pUp": round(p_up, 4),
        "pDown": round(p_down, 4),
        "volatilityLevel": vol_level,
        "volatilityAmplification": round(vol_amplification, 4),
        "pVolatilityAmplification": round(p_vol_amp, 4),
        "histVol": hist_vol,
        "lastClose": last_close,
        "closeMin": close_min,
        "closeMax": close_max,
        "avg": avg,
        "predictedPathShape": predicted_shape,
    }


def get_forecast(exchange: str = "okx", symbol: str = "BTC_USDT",
                 interval: str = "1h", pred_len: int = 24,
                 sample_paths: int = 16, T: float = 1.2, top_p: float = 0.95) -> dict:
    """完整推理：拉最新 K 线 → 循环采样 → 派生涨跌/波动概率 → 组装 JSON。

    返回字段见 docs/kronos-btc-forecast-integration-spec.md §6.3。
    """
    predictor = load_model()

    limit_max = _EXCHANGE_LIMIT_MAX.get(exchange, 300)
    df = fetch_kline(exchange, symbol, interval, limit=limit_max)
    lookback = min(_MAX_CONTEXT, limit_max - pred_len)
    if lookback < 50:
        raise ValueError(f"pred_len={pred_len} 超过 {exchange} 可支持窗口（上限 {limit_max}）")
    if len(df) < lookback + pred_len:
        raise ValueError(f"insufficient klines: got {len(df)}, need >= {lookback + pred_len}")

    x_df, x_timestamp, y_timestamp, last_close = _prepare_ctx(df, interval, pred_len, lookback)
    m = _metrics_from_ctx(predictor, x_df, x_timestamp, y_timestamp, last_close,
                          pred_len, sample_paths, T, top_p)
    avg = m["avg"]

    forecast = []
    forecast_range = []
    for i in range(len(avg)):
        forecast.append({
            "t": y_timestamp.iloc[i].isoformat().replace("+00:00", "Z"),
            "open": float(avg["open"].iloc[i]),
            "high": float(avg["high"].iloc[i]),
            "low": float(avg["low"].iloc[i]),
            "close": float(avg["close"].iloc[i]),
            "volume": float(avg["volume"].iloc[i]),
        })
        forecast_range.append({
            "t": y_timestamp.iloc[i].isoformat().replace("+00:00", "Z"),
            "min": float(m["closeMin"][i]),
            "max": float(m["closeMax"][i]),
        })

    # 历史展示段：取与预测长度等长的一段（默认 24 根），前端画蓝色「历史」部分。
    history_len = pred_len
    hist_df = df.iloc[-history_len:].copy()
    history = []
    for i in range(len(hist_df)):
        history.append({
            "t": hist_df["timestamps"].iloc[i].isoformat().replace("+00:00", "Z"),
            "close": float(hist_df["close"].iloc[i]),
            "volume": float(hist_df["volume"].iloc[i]),
        })

    return {
        "symbol": symbol,
        "interval": interval,
        "exchange": exchange,
        "predLen": pred_len,
        "model": _MODEL_NAME.split("/")[-1],
        "direction": m["direction"],
        "pUp": m["pUp"],
        "pDown": m["pDown"],
        "volatilityLevel": m["volatilityLevel"],
        "volatilityAmplification": m["volatilityAmplification"],
        "pVolatilityAmplification": m["pVolatilityAmplification"],
        "lastClose": last_close,
        "history": history,
        "forecast": forecast,
        "forecastRange": forecast_range,
        "predictedPathShape": m["predictedPathShape"],
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


# ── 历史回测（§9） ────────────────────────────────────────────────────────────

def backtest(exchange: str = "binance", symbol: str = "BTC_USDT",
             interval: str = "1h", pred_len: int = 24,
             sample_paths: int = 12, days: int = 30) -> dict:
    """在多个历史锚点用当时 K 线跑相同推理，对比 24h 后真实走势，评估历史准确度。

    一次性分页拉取约 (days*24 + 上下文 + 预测) 根历史 K 线（历史 K 线不可变，
    用于重建过去任意时刻的上下文），再在每个日锚点本地切片：
      - 上下文 = 锚点当根之前的 lookback 根；预测段 = 锚点之后 pred_len 根（真实）；
      - 用与线上完全一致的 _metrics_from_ctx 得到 pUp / 方向 / 波动放大概率；
      - 实际涨跌 = 锚点 24h 后真实收盘 vs 锚点收盘；
      - 实际波动放大 = 未来 pred_len 根真实波动率是否超过历史波动率 * 1.05。
    聚合指标：方向准确率（清晰喊单中方向命中率）、Brier 分数（概率校准）、
    波动放大命中率、回测样本数。
    """
    predictor = load_model()
    limit_max = _EXCHANGE_LIMIT_MAX.get(exchange, 300)
    lookback = min(_MAX_CONTEXT, limit_max - pred_len)
    now = pd.Timestamp.now(tz="UTC")

    # 一次性拉取足够长的历史：天数*每天24根 + 上下文 + 预测 + 余量
    bars_needed = days * 24 + lookback + pred_len + 50
    try:
        history = fetch_kline_history(exchange, symbol, interval, bars=bars_needed)
    except Exception as e:
        return {
            "symbol": symbol, "interval": interval, "exchange": exchange,
            "predLen": pred_len, "model": _MODEL_NAME.split("/")[-1],
            "samplePaths": sample_paths, "days": days,
            "samples": 0, "errors": days, "details": [],
            "error": f"history fetch failed: {e}",
            "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
    hist_len = len(history)

    # 按可用历史长度动态裁剪天数（OKX 公开接口仅回翻约 60 天，Binance 更深）
    max_days = (hist_len - lookback - pred_len - 50) // 24
    eff_days = max(1, min(days, max_days))
    if eff_days < days:
        days = eff_days

    results = []
    # 锚点回退偏移：Kronos tokenizer 把 512 根上下文压成变长 token 序列，
    # 个别历史窗口会被压到 < max_context(512) 个 token，触发模型内部
    # 「tensor 512 vs N」形状不匹配而推理失败。对失败锚点在同一天的邻近小时
    # 回退寻找可推理窗口，尽量保留「当天」回测样本，减少断档。
    fallback_offsets = [0, -1, 1, -2, 2, -3, 3, -6, 6, -12, 12]
    for k in range(1, days + 1):
        anchor = now - pd.Timedelta(days=k)
        m = None
        used_idx = None
        last_err = None
        last_k_idx = None
        for off in fallback_offsets:
            a2 = anchor + pd.Timedelta(hours=off)
            diffs = (history["timestamps"] - a2).abs()
            k_idx = int(diffs.idxmin())
            last_k_idx = k_idx
            if k_idx < lookback - 1 or k_idx + pred_len >= hist_len:
                continue
            x_df, x_timestamp, y_timestamp, last_close = _prepare_ctx(
                history.iloc[:k_idx + 1], interval, pred_len, lookback)
            # 预检 token 长度：Kronos 把 512 根上下文压成变长 token，token 数 < max_context(512)
            # 会触发模型内部形状不匹配崩溃；此类窗口直接跳到邻近小时重试，避免慢速推理白跑。
            if _ctx_token_len(predictor, x_df) < 512:
                last_err = "token_len<512 (skip)"
                continue
            try:
                m = _metrics_from_ctx(predictor, x_df, x_timestamp, y_timestamp,
                                      last_close, pred_len, sample_paths, 1.2, 0.95)
                used_idx = k_idx
                break
            except Exception as e:
                last_err = f"{type(e).__name__}: {str(e)[:80]}"
                continue

        if m is None:
            results.append({"anchor": anchor.isoformat(),
                            "error": last_err or f"no usable window (k={last_k_idx}, len={hist_len})"})
            continue

        future = history.iloc[used_idx + 1:used_idx + 1 + pred_len]
        actual_close = float(future["close"].iloc[-1])
        actual_up = bool(actual_close > last_close)
        realized_vol = float(np.mean((future["high"] - future["low"]) / future["close"]))
        vol_amp_actual = bool(realized_vol > m["histVol"] * 1.05)

        actual_shape = classify_path_shape(future["close"].to_numpy(dtype=float))
        results.append({
            "anchor": history["timestamps"].iloc[used_idx].isoformat().replace("+00:00", "Z"),
            "pUp": m["pUp"],
            "direction": m["direction"],
            "predictedUp": m["direction"] == "up",
            "predictedPathShape": m["predictedPathShape"],
            "pVolatilityAmplification": m["pVolatilityAmplification"],
            "actualUp": actual_up,
            "actualPathShape": actual_shape,
            "volAmplificationActual": vol_amp_actual,
        })

    valid = [r for r in results if "error" not in r]
    N = len(valid)

    # 方向准确率：仅在「清晰喊单」（direction != neutral）上与真实方向比对
    calls = [r for r in valid if r["direction"] != "neutral"]
    dir_acc = float(np.mean([r["predictedUp"] == r["actualUp"] for r in calls])) if calls else None
    called_rate = len(calls) / N if N else 0.0

    # Brier 分数：所有样本上 (pUp - 实际0/1)^2 的均值，越低越校准
    brier = float(np.mean([(r["pUp"] - (1.0 if r["actualUp"] else 0.0)) ** 2
                           for r in valid])) if N else None
    base_rate = float(np.mean([1.0 if r["actualUp"] else 0.0 for r in valid])) if N else 0.0
    naive_brier = base_rate * (1.0 - base_rate)

    # 波动放大命中率：喊「放大」（pVol>=0.5）时实际是否放大
    vol_calls = [r for r in valid if r["pVolatilityAmplification"] >= 0.5]
    vol_hit = float(np.mean([(r["pVolatilityAmplification"] >= 0.5) == r["volAmplificationActual"]
                             for r in vol_calls])) if vol_calls else None
    vol_called_rate = len(vol_calls) / N if N else 0.0

    return {
        "symbol": symbol,
        "interval": interval,
        "exchange": exchange,
        "predLen": pred_len,
        "model": _MODEL_NAME.split("/")[-1],
        "samplePaths": sample_paths,
        "days": days,
        "samples": N,
        "errors": len(results) - N,
        "directionalAccuracy": round(dir_acc, 4) if dir_acc is not None else None,
        "calledRate": round(called_rate, 4),
        "brier": round(brier, 4) if brier is not None else None,
        "baseRate": round(base_rate, 4),
        "naiveBrier": round(naive_brier, 4),
        "volHitRate": round(vol_hit, 4) if vol_hit is not None else None,
        "volCalledRate": round(vol_called_rate, 4),
        "details": valid,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


if __name__ == "__main__":
    # 本地快速验证：python inference.py
    print(json.dumps(get_forecast("okx", "BTC_USDT", "1h", 24), ensure_ascii=False, indent=2))
