/* 当前规则信号（旧口径）模块
 * 从 app.js 抽取：独立的已收盘 K 线流计算 + 稳定持仓呈现 + 信号卡渲染 +
 * 基准周期切换 + 多周期确认。函数名与旧实现保持一致，app.js 散落调用点仅需 import。
 * enhancer 机制：renderFixedRuleSignal = base + 各 enhancer；enhancer 由 app.js 侧
 * 通过 registerRuleSignalEnhancer 注入（避免跨模块重赋值反模式）。
 */
import {
  $, tx, state, money, pointTime, txInterval, addHelp,
} from '../core.js?v=20260928a';
import {
  metrics, classification, fixedRuleSignal,
  RULE_SIGNAL_MIN_CANDLES, RULE_SIGNAL_HISTORY_CANDLES,
  RULE_SIGNAL_ENTER_SCORE, RULE_SIGNAL_EXIT_SCORE,
  RULE_SIGNAL_CONFIRM_INTERVALS, RULE_SIGNAL_REENTRY_CANDLES,
} from '../signals.js?v=20260924b';
/* 规则信号面板刻意使用独立的已收盘 K 线流，避免未收盘 K 线造成结论抖动。
   The rule-signal panel deliberately uses its own closed-candle data stream.
   Chart range and chart interval are presentation controls, not a signal input. */

function ruleDirectionForScore(score, threshold = RULE_SIGNAL_ENTER_SCORE) {
  return score >= threshold ? "bull" : score <= -threshold ? "bear" : "flat";
}
export function ruleSignalLabel(kind) {
  return kind === "bull" ? tx("做多", "Long") : kind === "bear" ? tx("做空", "Short") : tx("观望", "Wait");
}
function stableRuleStorageKey(source, interval) {
  return `btc_rule_signal_stable_v1:${source}:${interval}`;
}
function recentRuleDirections(candles) {
  return [2, 1, 0].map((offset) =>
    ruleDirectionForScore(metrics(candles.slice(0, candles.length - offset)).score),
  );
}
function deriveStableRulePresentation() {
  const candles = fixedRuleSignal.candles;
  if (candles.length < RULE_SIGNAL_MIN_CANDLES) return null;
  /* Only the headline signal takes the live quote; confirmation intervals stay
     on closed candles so the cross-interval check is not double-corrected. */
  const metric = metrics(candles, state.ticker?.last),
    source = fixedRuleSignal.source || state.source || "okx",
    storageKey = stableRuleStorageKey(source, fixedRuleSignal.interval),
    current = ruleDirectionForScore(metric.score),
    recent = recentRuleDirections(candles),
    sustained =
      current !== "flat" &&
      recent.filter((kind) => kind === current).length >= 2;
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(storageKey) || "{}");
  } catch {}
  let held = saved.direction || "flat";
  if (held !== "bull" && held !== "bear") held = "flat";
  const invalidatedClosedAt = Number(saved.invalidatedClosedAt) || 0,
    reentryCandles = invalidatedClosedAt
      ? candles.filter((candle) => candle.time > invalidatedClosedAt).length
      : RULE_SIGNAL_REENTRY_CANDLES,
    revalidating =
      invalidatedClosedAt > 0 && reentryCandles < RULE_SIGNAL_REENTRY_CANDLES;
  if (revalidating) held = "flat";
  if (held === "flat" && sustained) held = current;
  else if (held !== "flat" && sustained && current !== held) held = current;
  else if (held !== "flat" && Math.abs(metric.score) <= RULE_SIGNAL_EXIT_SCORE) held = "flat";
  if (revalidating) held = "flat";
  try {
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        direction: held,
        closedAt: fixedRuleSignal.closedAt,
        invalidatedClosedAt: revalidating ? invalidatedClosedAt : null,
      }),
    );
  } catch {}
  const confirmations = RULE_SIGNAL_CONFIRM_INTERVALS.map((interval) => {
      const rows = interval === fixedRuleSignal.interval ? candles : fixedRuleSignal.confirmations[interval]?.candles;
      return rows?.length >= RULE_SIGNAL_MIN_CANDLES
        ? { interval, direction: ruleDirectionForScore(metrics(rows).score, 45) }
        : { interval, direction: "pending" };
    }),
    agreeing = confirmations.filter((item) => item.direction === held).length,
    opposing = confirmations.some(
      (item) =>
        item.direction !== "pending" &&
        item.direction !== "flat" &&
        item.direction !== held,
    ),
    ready = confirmations.every((item) => item.direction !== "pending"),
    confirmed =
      held !== "flat" &&
      !opposing &&
      (agreeing >= 1 || (sustained && Math.abs(metric.score) >= RULE_SIGNAL_ENTER_SCORE)),
    trendObserved = !confirmed && current !== "flat";
  return {
    rawScore: metric.score,
    held,
    confirmed,
    ready,
    confirmations,
    revalidating,
    reentryCandles,
    candidate: current,
    trendObserved,
    label: revalidating
      ? tx("重新评估中", "Re-evaluating")
      : confirmed
        ? agreeing >= 1
          ? ruleSignalLabel(held)
          : `${ruleSignalLabel(held)}${tx("趋势", " trend")}`
        : trendObserved
          ? `${current === "bull" ? tx("偏多趋势", "Bullish trend") : tx("偏空趋势", "Bearish trend")}${tx(" · 待收盘", " · close pending")}`
          : tx("观望 · 等待确认", "Wait · confirmation pending"),
    cls: revalidating ? "flat" : confirmed ? held : trendObserved ? current : "flat",
  };
}
function invalidateFixedRuleSignal() {
  if (!fixedRuleSignal.closedAt) return false;
  const source = fixedRuleSignal.source || state.source || "okx",
    storageKey = stableRuleStorageKey(source, fixedRuleSignal.interval);
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(storageKey) || "{}");
  } catch {}
  if (Number(saved.invalidatedClosedAt) === fixedRuleSignal.closedAt) return false;
  try {
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        ...saved,
        direction: "flat",
        invalidatedClosedAt: fixedRuleSignal.closedAt,
      }),
    );
  } catch {}
  fixedRuleSignal.presentation = deriveStableRulePresentation();
  return true;
}
async function loadRuleSignalConfirmations(source) {
  const requested = RULE_SIGNAL_CONFIRM_INTERVALS.filter((interval) => interval !== fixedRuleSignal.interval);
  const results = await Promise.all(
    requested.map(async (interval) => {
      try {
        const query = new URLSearchParams({ source, interval, limit: String(RULE_SIGNAL_HISTORY_CANDLES + 1) });
        const response = await fetch("/api/market?" + query), data = await response.json();
        if (!response.ok) return null;
        const candles = data.candles.slice(0, -1).slice(-RULE_SIGNAL_HISTORY_CANDLES);
        return candles.length >= RULE_SIGNAL_MIN_CANDLES ? [interval, { candles, closedAt: candles.at(-1)?.time }] : null;
      } catch {
        return null;
      }
    }),
  );
  results.filter(Boolean).forEach(([interval, value]) => (fixedRuleSignal.confirmations[interval] = value));
}
function fixedRuleHistoryCount() {
  return fixedRuleSignal.candles.length || RULE_SIGNAL_HISTORY_CANDLES;
}
function fixedRuleBasisText() {
  const source =
      { okx: "OKX", coinbase: "Coinbase", binance: "Binance", gate: "Gate" }[
        fixedRuleSignal.source || state.source
      ] || "--",
    intervalLabel =
      {
        "5m": tx("5分钟", "5 min"),
        "15m": tx("15分钟", "15 min"),
        "30m": tx("30分钟", "30 min"),
        "1h": tx("1小时", "1 hour"),
        "3h": tx("3小时", "3 hours"),
      }[fixedRuleSignal.interval] || fixedRuleSignal.interval;
  return `${tx("基准", "Basis")}：${source} · ${intervalLabel} · ${tx("最近", "latest")} ${fixedRuleHistoryCount()} ${tx("根已收盘 K 线", "closed candles")}`;
}
function renderFixedIndicatorDetails(m) {
  const indicators = $("indicators");
  if (!indicators) return;
  const rows = [
    ["EMA20", "EMA20", money(m.e20), m.close >= m.e20 ? "bull" : "bear"],
    ["EMA50", "EMA50", money(m.e50), m.close >= m.e50 ? "bull" : "bear"],
    [
      "EMA200",
      "EMA200",
      money(m.e200),
      Number.isFinite(m.e200) ? (m.close >= m.e200 ? "bull" : "bear") : "flat",
    ],
    [
      "RSI(14)",
      "RSI(14)",
      m.rsi.toFixed(2),
      m.rsi > 55 ? "bull" : m.rsi < 45 ? "bear" : "flat",
    ],
    [
      "布林位置",
      tx("布林位置", "Bollinger position"),
      (m.bb * 100).toFixed(2) + "%",
      m.bb > 0.6 ? "bull" : m.bb < 0.4 ? "bear" : "flat",
    ],
    ["ATR(14)", "ATR(14)", money(m.atr), "flat"],
  ];
  const tag = (kind) =>
    kind === "bull"
      ? tx("看多", "Bullish")
      : kind === "bear"
        ? tx("看空", "Bearish")
        : tx("中性", "Neutral");
  indicators.innerHTML = rows
    .map(
      ([key, name, value, kind]) =>
        `<div class="metric" data-fixed-basis="true" data-indicator="${key}"><span>${name}</span><b>${value}</b><i class="badge ${kind}">${tag(kind)}</i></div>`,
    )
    .join("");
  const interval = fixedRuleSignal.interval,
    historyCount = fixedRuleHistoryCount(),
    minutes =
      { "5m": 5, "15m": 15, "30m": 30, "1h": 60, "3h": 180 }[interval] || 15,
    period = (n) => {
      const total = n * minutes;
      return total < 60
        ? `${total} 分钟`
        : total < 1440
          ? `${(total / 60).toFixed(total % 60 ? 1 : 0)} 小时`
          : `${(total / 1440).toFixed(1)} 天`;
    },
    tips = {
      EMA20: [
        `EMA20 看最近 20 根 ${interval} K 线（约 ${period(20)}）。收盘价在其上方标记看多，下方标记看空。`,
        "EMA20 tracks the latest 20 basis candles. A close above it is marked bullish; below it is bearish.",
      ],
      EMA50: [
        `EMA50 看最近 50 根 ${interval} K 线（约 ${period(50)}），比 EMA20 更平滑。收盘价在其上方标记看多，下方标记看空。`,
        "EMA50 tracks the latest 50 basis candles and is smoother than EMA20. Above is bullish; below is bearish.",
      ],
      EMA200: [
        `EMA200 使用最近 ${historyCount} 根 ${interval} K 线预热，并以最后 200 根（约 ${period(200)}）作为长趋势窗口。数据不足时显示 -- 和中性。`,
        `EMA200 is warmed up with the latest ${historyCount} basis candles and uses the final 200 candles for long-trend context. Missing data is shown as neutral.`,
      ],
      "RSI(14)": [
        `衡量最近 14 根 ${interval} K 线的动量。高于 55 标记看多，低于 45 标记看空，45–55 为中性。`,
        "Momentum over 14 basis candles. Above 55 is bullish, below 45 bearish, and 45–55 neutral.",
      ],
      布林位置: [
        "当前价在布林带上下轨之间的位置。高于 60% 标记看多，低于 40% 标记看空，中间为中性。",
        "Position within the Bollinger Bands. Above 60% is bullish, below 40% bearish, and the middle neutral.",
      ],
      "ATR(14)": [
        "ATR(14) 表示最近 14 根基准 K 线的平均真实波幅，只衡量波动大小，不判断方向，因此标记中性。",
        "ATR(14) measures volatility over 14 basis candles, not direction, so it is marked neutral.",
      ],
    };
  indicators.querySelectorAll(".metric").forEach((row) => {
    const copy = tips[row.dataset.indicator];
    if (copy) addHelp(row.querySelector("span"), copy[0], copy[1]);
  });
}
let lastRuleSignalState = null;
function renderFixedRuleSignalBase() {
  if (fixedRuleSignal.candles.length < RULE_SIGNAL_MIN_CANDLES) return;
  const m = metrics(fixedRuleSignal.candles),
    presentation =
      fixedRuleSignal.presentation || deriveStableRulePresentation(),
    label = presentation?.label || classification(m.score)[0],
    cls = presentation?.cls || classification(m.score)[1],
    signal = $("signal"),
    reason = $("signalReason");
  // Keep the distinction visible: a short-term trend may be observed before
  // it is safe to promote it to an executable, multi-timeframe signal.
  const observedDirection =
    !presentation?.revalidating && !presentation?.confirmed
      ? ruleDirectionForScore(m.score)
      : "flat";
  const showingTrendObservation = observedDirection !== "flat";
  const isShortBasis =
    fixedRuleSignal.interval === "5m" || fixedRuleSignal.interval === "15m";
  const trendWord =
    observedDirection === "bull" ? tx("偏多趋势", "Bullish trend") : tx("偏空趋势", "Bearish trend");
  const reverseWord =
    observedDirection === "bull"
      ? tx("超买 · 回落风险", "Overbought · pullback risk")
      : tx("超卖 · 反弹机会", "Oversold · bounce chance");
  const visibleLabel = showingTrendObservation
    ? `${isShortBasis ? reverseWord : trendWord}${tx(" · 待收盘", " · close pending")}`
    : label;
  const visibleCls = showingTrendObservation ? observedDirection : cls;
  if (!fixedRuleSignal.presentation) fixedRuleSignal.presentation = presentation;
  if (signal) {
    signal.textContent = presentation?.confirmed
      ? `${label} ${m.score > 0 ? "+" : ""}${m.score.toFixed(2)}`
      : visibleLabel;
    signal.className = `signal ${visibleCls}`;
  }
  /* 基准周期徽章贴在卡片标题「当前规则信号」旁；标题文本会被语言切换覆写，
     所以徽章作为标题的兄弟节点插入，避免被 textContent 清掉。 */
  const ruleHeading = signal?.closest("article")?.querySelector("h2");
  if (ruleHeading) {
    let chip = ruleHeading.parentElement.querySelector(".signal-basis-chip");
    if (!chip) {
      chip = document.createElement("i");
      chip.className = "signal-basis-chip";
      ruleHeading.after(chip);
    }
    chip.textContent = fixedRuleSignal.interval;
    chip.dataset.tone = visibleCls;
    chip.title = tx(
      `当前规则信号基于 ${fixedRuleSignal.interval} 已收盘 K 线计算`,
      `Rule signal is computed from closed ${txInterval(fixedRuleSignal.interval)} candles`,
    );
  }
  /* Keep the signal card's accent aligned with the actual rule direction.
     The attribute is presentation-only; it never affects the score or rule. */
  const signalCard = $("ruleSignalCard");
  if (signalCard) signalCard.dataset.signalTone = visibleCls;
  document.documentElement.dataset.ruleSignalTone = visibleCls;
  /* 1h 主方向条：直接复用多周期确认结果（presentation.confirmations 已含 1h），
     不再发起额外请求。1h 是趋势有效的周期，作为大周期背景供短线信号对照。 */
  if (reason) {
    let pt = $("primaryTrend");
    if (!pt) {
      pt = document.createElement("div");
      pt.id = "primaryTrend";
      pt.className = "primary-trend";
      reason.after(pt);
    }
    const c1h = presentation?.confirmations?.find((c) => c.interval === "1h");
    let ptHtml = "";
    let ptShown = false;
    if (c1h && c1h.direction !== "pending") {
      const w = c1h.direction === "bull" ? tx("做多", "Long") : c1h.direction === "bear" ? tx("做空", "Short") : tx("观望", "Neutral");
      const note = c1h.direction === "bull" ? tx("趋势向上 · 短线逆势回调是机会", "uptrend · counter-trend dip = entry") : c1h.direction === "bear" ? tx("趋势向下 · 短线反弹应减仓", "downtrend · bounce = trim") : tx("中性", "neutral");
      ptHtml = `<span class="muted">1h 主方向</span><b class="signal-indicator ${c1h.direction}">${w}</b><span class="pt-note">${note}</span>`;
      ptShown = true;
    } else if (c1h && c1h.direction === "pending") {
      ptHtml = `<span class="muted">1h 主方向</span><b class="signal-indicator flat">${tx("加载中", "loading")}</b>`;
      ptShown = true;
    }
    if (ptShown) {
      if (pt.dataset.lastHtml !== ptHtml) {
        pt.innerHTML = ptHtml;
        pt.dataset.lastHtml = ptHtml;
      }
      pt.style.display = "";
    } else if (pt.style.display !== "none") {
      pt.style.display = "none";
      pt.dataset.lastHtml = "";
    }
    /* 有效期标注：短线反转信号在 60 分钟内最有效，长周期趋势信号有效期更长。 */
    const validity = $("signalValidity");
    if (validity) {
      const mins = { "5m": 60, "15m": 60, "30m": 120, "1h": 1440, "3h": 4320 }[fixedRuleSignal.interval] || 60;
      const dur = mins >= 1440 ? `${mins / 1440} 天` : mins >= 60 ? `${mins / 60} 小时` : `${mins} 分钟`;
      const valHtml = `<span class="muted">${tx("有效至", "Valid until")}</span> ${tx("当前收盘后约", "~after this candle")} <b>${dur}</b> · <span class="muted">${tx("破位即撤销", "void if broken")}</span>`;
      if (validity.dataset.lastHtml !== valHtml) {
        validity.innerHTML = valHtml;
        validity.dataset.lastHtml = valHtml;
      }
      validity.classList.add("is-valid");
    }
  }
  if (reason) {
    const reasonHtml = `<span class="signal-summary"><b class="signal-indicator ${m.close >= m.e20 ? "bull" : "bear"}">EMA20 ${money(m.e20)}</b><i>·</i><b class="signal-indicator ${m.close >= m.e50 ? "bull" : "bear"}">EMA50 ${money(m.e50)}</b><i>·</i><b class="signal-indicator ${m.rsi >= 50 ? "bull" : "bear"}">RSI(14) ${m.rsi.toFixed(2)}</b><i>·</i><b class="signal-indicator ${m.macd >= 0 ? "bull" : "bear"}">MACD ${m.macd.toFixed(2)}</b></span>`;
    if (reason.dataset.lastHtml !== reasonHtml) {
      reason.innerHTML = reasonHtml;
      reason.dataset.lastHtml = reasonHtml;
    }
  }
  renderFixedIndicatorDetails(m);
  const sl = $("sl"),
    tp = $("tp");
  if (sl) sl.textContent = money(m.close - m.atr * 1.5);
  if (tp) tp.textContent = money(m.close + m.atr * 3);
  let basis = $("fixedRuleBasis");
  if (!basis && reason) {
    basis = document.createElement("small");
    basis.id = "fixedRuleBasis";
    basis.className = "fixed-rule-basis";
    reason.after(basis);
  }
  if (basis) {
    const confirmation = presentation
      ? presentation.confirmations
          .map((item) => `${item.interval} ${item.direction === "pending" ? tx("加载中", "loading") : ruleSignalLabel(item.direction)}`)
          .join(" · ")
      : "";
    basis.textContent = `${fixedRuleBasisText()} · ${tx("最近收盘", "Last close")} ${pointTime(fixedRuleSignal.closedAt)}${confirmation ? ` · ${tx("周期校验", "Timeframes")}: ${confirmation}` : ""}`;
  }
  /* 事件驱动高亮：仅当方向跨阈值切换时闪烁一次，避免持续状态标签造成的噪音。 */
  const newState = ruleDirectionForScore(m.score);
  if (lastRuleSignalState !== null && newState !== lastRuleSignalState && signalCard) {
    signalCard.classList.remove("signal-flash");
    void signalCard.offsetWidth;
    signalCard.classList.add("signal-flash");
  }
  lastRuleSignalState = newState;
}
async function loadFixedRuleSignal(force = false) {
  if (fixedRuleSignal.loading) return;
  fixedRuleSignal.loading = true;
  try {
    const source = state.source || "okx",
      query = new URLSearchParams({
        source,
        interval: fixedRuleSignal.interval,
        limit: String(RULE_SIGNAL_HISTORY_CANDLES + 1),
      }),
      response = await fetch("/api/market?" + query),
      data = await response.json();
    if (!response.ok) throw data;
    const candles = data.candles.slice(0, -1).slice(-RULE_SIGNAL_HISTORY_CANDLES),
      closedAt = candles.at(-1)?.time,
      key = `${data.source}:${fixedRuleSignal.interval}:${closedAt}`;
    if (
      candles.length >= RULE_SIGNAL_MIN_CANDLES &&
      (force ||
        candles.length !== fixedRuleSignal.candles.length ||
        key !==
          `${fixedRuleSignal.source}:${fixedRuleSignal.interval}:${fixedRuleSignal.closedAt}`)
    ) {
      fixedRuleSignal.candles = candles;
      fixedRuleSignal.source = data.source;
      fixedRuleSignal.closedAt = closedAt;
    }
    fixedRuleSignal.presentation = deriveStableRulePresentation();
    renderFixedRuleSignal();
    void loadRuleSignalConfirmations(data.source || source).then(() => {
      fixedRuleSignal.presentation = deriveStableRulePresentation();
      renderFixedRuleSignal();
    });
  } catch {
  } finally {
    fixedRuleSignal.loading = false;
  }
}
export function initRuleSignal() {
  const card = $("signal")?.closest("article"),
    heading = card?.querySelector("h2");
  if (!card || !heading || $("fixedRuleControl")) return;
  const control = document.createElement("label");
  control.id = "fixedRuleControl";
  control.className = "fixed-rule-control";
  control.innerHTML = `<span>${tx("信号基准", "Signal basis")}</span><select aria-label="${tx("信号基准周期", "Signal basis interval")}"><option value="5m">${tx("5分钟", "5 min")}</option><option value="15m">${tx("15分钟", "15 min")}</option><option value="30m">${tx("30分钟", "30 min")}</option><option value="1h">${tx("1小时", "1 hour")}</option><option value="3h">${tx("3小时", "3 hours")}</option></select>`;
  const select = control.querySelector("select");
  select.value = fixedRuleSignal.interval;
  select.onchange = () => {
    fixedRuleSignal.interval = select.value;
    fixedRuleSignal.candles = [];
    fixedRuleSignal.closedAt = 0;
    fixedRuleSignal.confirmations = {};
    fixedRuleSignal.presentation = null;
    localStorage.setItem("btc_rule_signal_interval", select.value);
    loadFixedRuleSignal(true);
  };
  heading.after(control);
  $("source")?.addEventListener("change", () => {
    fixedRuleSignal.confirmations = {};
    fixedRuleSignal.presentation = null;
    loadFixedRuleSignal(true);
  });
  loadFixedRuleSignal(true);
  setInterval(() => loadFixedRuleSignal(), 15_000);
}
/* ── enhancer 注册：app.js 侧通过 registerRuleSignalEnhancer 注入本地增强 ── */
const fixedRuleSignalEnhancers = [];
function addFixedRuleSignalEnhancer(id, render) {
  if (fixedRuleSignalEnhancers.some((enhancer) => enhancer.id === id))
    throw new Error(`Duplicate fixed rule signal enhancer: ${id}`);
  fixedRuleSignalEnhancers.push({ id, render });
}

/* 渲染 base + 各显式注册的增强步骤（等价原 app.js 的 wrapper 重赋值）。 */
export function renderFixedRuleSignal() {
  renderFixedRuleSignalBase();
  fixedRuleSignalEnhancers.forEach(({ render }) => render());
}

export {
  loadFixedRuleSignal,
  deriveStableRulePresentation,
  fixedRuleHistoryCount,
  invalidateFixedRuleSignal,
};
export function registerRuleSignalEnhancer(id, render) {
  addFixedRuleSignalEnhancer(id, render);
}
