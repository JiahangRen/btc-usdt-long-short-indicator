import { emaSeriesPadded as ema, rsiSeriesPadded as rsi, atrSeriesPadded as atr } from '/shared/indicators.mjs';
import { tx, sma } from './core.js?v=20260928a';

/* 图表 / 信号共享计算内核。
   原内联于 app.js 的指标函数 metrics、分数分类 classification、规则信号共享状态
   fixedRuleSignal 及其配置常量，现集中于此，供 app.js 与未来抽离的共振 / 规则信号
   模块共用。classification 统一为带 i18n 的版本（原 @7377 求值期覆盖版，线上实际行为），
   消除「基类 + 求值期重赋值覆盖」反模式。 */

export function metrics(data, livePrice) {
  const closes = data.map((x) => x.close),
    e20 = ema(closes, 20),
    e50 = ema(closes, 50),
    e200 = ema(closes, 200),
    rs = rsi(closes),
    at = atr(data);
  const i = closes.length - 1,
    macd = ema(closes, 12)[i] - ema(closes, 26)[i];
  const basis = sma(closes, 20)[i],
    sd = Math.sqrt(
      closes.slice(-20).reduce((s, x) => s + (x - basis) ** 2, 0) / 20,
    );
  const bb = (closes[i] - (basis - 2 * sd)) / (4 * sd || 1);
  const atrV = at[i] || 1,
    atrPct = (atrV / closes[i]) * 100,
    mom5 = closes.length > 5 ? (closes[i] / closes[i - 5] - 1) * 100 : 0;
  let score = 0;
  score += e20[i] > e50[i] ? 25 : -25;
  score += closes[i] > e50[i] ? 20 : -20;
  score += Number.isFinite(e200[i]) ? (closes[i] > e200[i] ? 20 : -20) : 0;
  /* ATR-normalised. The old close*0.0015 denominator (~118 at 78k) pinned this
     term near zero on BTC, so MACD never moved the score. */
  /* 对称钳位：把 MACD / RSI / 布林三项贡献分别夹在 ±15 / ±10 / ±10，避免任一
     单项在极端行情下独大、淹没趋势与均线给出的信号（F4：把“为什么这么夹”写明）。 */
  score += Math.max(-15, Math.min(15, (macd / (atrV * 1.2)) * 15));
  score += Math.max(-10, Math.min(10, (rs[i] - 50) / 2.5));
  score += Math.max(-10, Math.min(10, (bb - 0.5) * 20));
  /* Damp (never flip) the score when the most recent direction opposes it. The
     live quote counts 1.5x because it is the freshest evidence the user sees —
     this is what stops a falling price from still reading "long". Damping is
     one-sided by design: it can only abstain, never reverse a direction, which
     is why 1h accuracy survives (backtest: 52.4% -> 50.8%). */
  const driftPct =
      Number.isFinite(livePrice) && livePrice > 0
        ? ((livePrice - closes[i]) / closes[i]) * 100
        : 0,
    recentDir = mom5 + driftPct * 1.5;
  let damped = 1;
  if (
    score !== 0 &&
    recentDir !== 0 &&
    Math.sign(score) !== Math.sign(recentDir)
  )
    score *= (damped =
      1 - 0.5 * Math.min(1, Math.abs(recentDir) / (atrPct * 1.5 || 0.1)));
  return {
    close: closes[i],
    e20: e20[i],
    e50: e50[i],
    e200: e200[i],
    rsi: rs[i],
    atr: at[i],
    macd,
    bb,
    mom5,
    atrPct,
    driftPct,
    recentDir,
    damped,
    score: Math.round(score),
  };
}
export function classification(score) {
  return score >= 45
    ? [tx("做多", "Long"), "bull"]
    : score <= -45
      ? [tx("做空", "Short"), "bear"]
      : [tx("观望", "Neutral"), "flat"];
}

export const fixedRuleSignal = {
  interval: localStorage.getItem("btc_rule_signal_interval") || "15m",
  candles: [],
  source: "",
  closedAt: 0,
  loading: false,
  confirmations: {},
  presentation: null,
};
/* Keep enough closed history to warm up EMA200 before it affects the live
   signal.  The chart's own range remains a presentation-only setting. */
export const RULE_SIGNAL_MIN_CANDLES = 200;
export const RULE_SIGNAL_HISTORY_CANDLES = 800;
export const RULE_SIGNAL_ENTER_SCORE = 45;
export const RULE_SIGNAL_EXIT_SCORE = 28;
export const RULE_SIGNAL_CONFIRM_INTERVALS = ["15m", "1h"];
export const RULE_SIGNAL_REENTRY_CANDLES = 2;