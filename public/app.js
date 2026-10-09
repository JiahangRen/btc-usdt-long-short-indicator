import { emaSeriesPadded as ema, rsiSeriesPadded as rsi, atrSeriesPadded as atr } from '/shared/indicators.mjs';
import { COIN_KEYS, COINS, BASE_COIN, normalizeCoin, okxInstId } from '/shared/coins.mjs';
import {
  $, state, tx, uiLang, setUiLangState, I18N, locale,
  COIN_MODE_KEY, COIN_SYMBOL_KEY, withCoin, COIN_SCOPED_API, coinMode, selectedCoin,
  setCoinModeState, setSelectedCoinState, isMultiCoinMode, activeCoin,
  coinMetaOf, coinPair, coinLabel, coinStorageSuffix, registry, INTERVAL_LABELS, txInterval, pointTime,
  apiFetch, sma, money, pct, time, timeFull, formatTimeAxisLabel, maxOf, minOf,
  loadScriptOnce, whenIdle,
  VOICE_LIST_POPULATE_DELAY_MS, LONG_TERM_INTERVAL_MIN,
  DAILY_HISTORY_MAX_RETRIES, DAILY_HISTORY_RETRY_DELAY_MS,
  safeText, safeHref, calendarEscape,
  addHelp, syncCardHelpTips,
  formatRate,
} from './src/core.js?v=20260928a';
import { initMultiCoin } from './src/modules/multi-coin.js?v=20261001d';
import { initApiCenter } from './src/modules/api-center.js?v=20261008c';
import { metrics, classification, fixedRuleSignal, RULE_SIGNAL_MIN_CANDLES, RULE_SIGNAL_HISTORY_CANDLES, RULE_SIGNAL_ENTER_SCORE, RULE_SIGNAL_EXIT_SCORE, RULE_SIGNAL_CONFIRM_INTERVALS, RULE_SIGNAL_REENTRY_CANDLES } from './src/signals.js?v=20261009a';
import { renderFixedRuleSignal, deriveStableRulePresentation, fixedRuleHistoryCount, invalidateFixedRuleSignal, registerRuleSignalEnhancer, initRuleSignal, loadFixedRuleSignal, ruleSignalLabel } from './src/modules/rule-signal.js?v=20261009a';
import { refreshResonance, renderResonanceChips, RES_INTERVALS, resonanceCache, initResonance } from './src/modules/resonance.js?v=20260924b';
import { loadResearchOutlook, renderResearchOutlook, rerenderResearchOutlook, initResearch, setSyncMacroPanels } from './src/modules/research.js?v=20260928a';
import { renderOkxMicrostructure } from './src/modules/microstructure.js?v=20260924b';
import { initConnectivity } from './src/modules/connectivity.js?v=20260924b';
/* Use the application's dialog style instead of browser-native prompts. */
function showAppDialog({
  title = tx("提示","Tip"),
  message = "",
  confirmText = tx("我知道了","Got it"),
  cancelText = "",
  onConfirm,
  onCancel,
} = {}) {
  let modal = $("appDialog");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "appDialog";
    modal.className = "alert-composer alert-notice app-dialog";
    modal.hidden = true;
    modal.innerHTML =
      '<section role="dialog" aria-modal="true"><header><b></b><button type="button" aria-label="关闭">×</button></header><div class="notice-body"><span>!</span><p></p></div><div class="app-dialog-actions"><button type="button" class="app-dialog-cancel"></button><button type="button" class="alert-submit app-dialog-confirm"></button></div></section>';
    document.body.append(modal);
  }
  const close = () => {
    modal.hidden = true;
    modal._onConfirm = null;
    modal._onCancel = null;
  };
  modal.querySelector("header b").textContent = title;
  modal.querySelector(".notice-body p").textContent = String(message);
  const cancel = modal.querySelector(".app-dialog-cancel"),
    confirm = modal.querySelector(".app-dialog-confirm");
  cancel.hidden = !cancelText;
  cancel.textContent = cancelText;
  confirm.textContent = confirmText;
  modal._onConfirm = onConfirm || null;
  modal._onCancel = onCancel || null;
  modal.querySelector("header button").onclick = close;
  cancel.onclick = () => {
    const action = modal._onCancel;
    close();
    action?.();
  };
  confirm.onclick = () => {
    const action = modal._onConfirm;
    close();
    action?.();
  };
  modal.onclick = (event) => {
    if (event.target === modal) close();
  };
  modal.hidden = false;
}
window.alert = (message) => showAppDialog({ message });
// 桥接：经典脚本（cloud-alerts.js）以裸名 showAppDialog 调用；模块模式下顶层函数不再挂全局，故显式暴露到 window。
window.showAppDialog = showAppDialog;
// 显式声明历史上以“隐式全局”形式存在的可变状态（calcLiqProbability 全文件无任何 var/let/const/function 声明，
// 是真正的隐式全局），使其可在 ES Module（strict 模式）下安全赋值；其余同名符号原本已在模块顶层以 function/const 声明，无需重复。
var calcLiqProbability;
// 前端控制器：维护首屏状态、定时请求、图表绘制和所有用户交互。
// Frontend controller: owns initial state, scheduled requests, chart drawing, and user interactions.
var quoteStripBusy = false;
const intervals = [
  ["5s", "5 秒", "5s"],
  ["10s", "10 秒", "10s"],
  ["30s", "30 秒", "30s"],
  ["1m", "1 分", "1m"],
  ["5m", "5 分", "5m"],
  ["15m", "15 分", "15m"],
  ["30m", "30 分", "30m"],
  ["1h", "1 时", "1h"],
  ["2h", "2 时", "2h"],
  ["4h", "4 时", "4h"],
  ["1d", "1 日", "1D"],
];
const ranges = {
  "1D": ["15m", 96],
  "1W": ["30m", 300],
  "1M": ["4h", 180],
  "6M": ["1d", 183],
  "1Y": ["1d", 300],
};
/* livePrice is optional: when given, the panel stops lagging one full candle.
   Pass the live quote only for the headline signal, not for confirmation
   intervals, so cross-interval checks stay on a consistent closed-candle basis. */


function buttonsLegacy() {
  $("intervals").innerHTML = intervals
    .map(
      ([v, n]) =>
        `<button data-i="${v}" class="${state.range === null && state.interval === v ? "active" : ""}">${n}</button>`,
    )
    .join("");
  $("ranges").innerHTML = Object.keys(ranges)
    .map(
      (x) =>
        `<button data-r="${x}" class="${state.range === x ? "active" : ""}">${x}</button>`,
    )
    .join("");
  document.querySelectorAll("[data-i]").forEach(
    (b) =>
      (b.onclick = () => {
        state.interval = b.dataset.i;
        state.limit = 300;
        state.range = null;
        loadCurrent();
      }),
  );
  document.querySelectorAll("[data-r]").forEach(
    (b) =>
      (b.onclick = () => {
        const [i, l] = ranges[b.dataset.r];
        state.interval = i;
        state.limit = l;
        state.range = b.dataset.r;
        loadCurrent();
      }),
  );
}
let previousTickerPrice = null;
let previousTickerDirection = "";
function renderTicker() {
  const t = state.ticker;
  if (!t) return;
  const priceEl = $("price"),
    changeEl = $("change"),
    up = t.last >= t.open24h,
    delta = t.last - t.open24h,
    amount = `${delta >= 0 ? "+" : "−"}$${Math.abs(delta).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    pulse =
      previousTickerPrice === null
        ? up
          ? "price-up"
          : "price-down"
        : t.last >= previousTickerPrice
          ? "price-up"
          : "price-down";
  priceEl.textContent = money(t.last);
  changeEl.innerHTML = `<span class="change-amount">${amount}</span><span class="change-pct">${pct(t.changePct)}</span>`;
  changeEl.className = up ? "bull" : "bear";
  [priceEl, changeEl].forEach((el) => {
    el.classList.remove("price-up", "price-down");
    void el.offsetWidth;
    el.classList.add(pulse);
  });
  previousTickerPrice = t.last;
  const compactOpen24 = $("open24"),
    compactHighLow = $("highlow"),
    compactSource = $("sourceUsed");
  if (compactOpen24) compactOpen24.textContent = money(t.open24h);
  if (compactHighLow) compactHighLow.textContent = `${money(t.high24)} / ${money(t.low24)}`;
  if (compactSource) compactSource.textContent = state.lastGood.source;
}
function diagnostics(payload) {
  const f = payload.failures || {},
    locale = uiLang === "zh" ? "zh-CN" : "en-US";
  $("diagnostics").textContent = tx(
    `当前图表：${state.lastGood.source} · ${payload.cached ? "服务端缓存（≤15秒）" : "刚从交易所获取"}\n成功时间：${new Date(payload.fetchedAt).toLocaleString(locale)}\n其他源状态：${
      Object.keys(f).length
        ? Object.entries(f)
            .map(([k, v]) => `${k}: ${v}`)
            .join("；")
        : "本次无失败报告"
    }\n若全部失败，页面会保留最近成功数据并显示原因。`,
    `Current chart: ${state.lastGood.source} · ${payload.cached ? "server cache (≤15 sec)" : "fetched from exchange"}\nSuccessful fetch: ${new Date(payload.fetchedAt).toLocaleString(locale)}\nOther source status: ${
      Object.keys(f).length
        ? Object.entries(f)
            .map(([k, v]) => `${k}: ${v}`)
            .join("; ")
        : "no failures reported"
    }\nIf every source fails, the page retains the last successful data and shows the reason.`,
  );
}
async function loadCurrent() {
  if (state.loading) return;
  state.loading = true;
  buttons();
  $("connection").textContent = tx("正在加载当前图表…","Loading the current chart…");
  try {
    const q = new URLSearchParams({
      interval: state.interval,
      limit: state.limit,
    });
    if (state.source) q.set("source", state.source);
    const r = await fetch("/api/market?" + q);
    const data = await r.json();
    if (!r.ok) throw data;
    state.candles = data.candles;
    state.marketMeta = {
      synthetic: Boolean(data.synthetic),
      syntheticIntervalMs: Number(data.syntheticIntervalMs) || null,
    };
    state.lastGood = data;
    $("chartError").hidden = true;
    state.ticker = data.ticker;
    // 双保险：整体替换蜡烛后用实时价锚定最后一根「正在形成」的蜡烛，消除 2s 周期 loadCurrent
    // 把实时长阳线打回快照造成的抖动。服务端已让快照自带 live close，此为冗余防线。
    if (state.ticker?.last && state.candles.length) {
      const last = state.candles[state.candles.length - 1];
      const intervalMs = (intervalMinutes[state.interval] || 0) * 60 * 1000;
      if (intervalMs && Date.now() - last.time < intervalMs) {
        last.close = state.ticker.last;
        if (state.ticker.last > last.high) last.high = state.ticker.last;
        if (state.ticker.last < last.low) last.low = state.ticker.last;
      }
    }
    renderTicker();
    renderAnalysis();
    diagnostics(data);
    $("coverage").textContent =
      `${tx("图表覆盖：","Chart coverage:")}${time(data.candles[0].time)}${tx(" 至 "," to ")}${time(data.candles.at(-1).time)} · ${data.candles.length}${tx(" 根 · 仅此范围参与回测"," bars · only this range is used for backtest")}`;
    $("connection").textContent = data.cached
      ? tx("已显示缓存数据","Cached data shown")
      : tx("实时 REST 数据已更新","Live REST data updated");
    $("freshness").textContent =
      `${new Date(data.fetchedAt).toLocaleTimeString("zh-CN")}`;
  } catch (e) {
    $("connection").textContent = tx("行情暂不可用：保留最近成功数据","Market unavailable: keeping the last successful data");
    $("chartError").hidden = false;
    $("chartError").textContent =
      `无法获取数据。${e.error || "请检查本机网络或代理。"}\n${Object.entries(
        e.failures || {},
      )
        .map(([k, v]) => `${k}: ${v}`)
        .join("；")}`;
    $("diagnostics").textContent = JSON.stringify(e.failures || e, null, 2);
  } finally {
    state.loading = false;
  }
}
// 旧版共振（按全周期并排展示、无一致性结论）已移除，统一由下方加权一致性实现替代。
/* 实时报价轮询间隔：上游 OKX 流约每 100ms 推一次，本地取 250ms（4 次/秒）
   —— 既跟得上报价变化，也不至于把渲染压过载。
   Live-quote polling cadence: the OKX stream ticks about every 100ms, so 250ms
   (4/s) keeps up with it without over-driving the render path. */
const refreshIntervalMs = 2000;
/* 报价请求去重：同一时刻只允许一条在飞；若某个 tick 因上一次尚未返回而被跳过，
   记一个 pending，等请求落地后立刻补拉一次，避免「隔一拍才刷新」。
   Only one quote request may be in flight; a tick skipped because of that sets a
   pending flag so the value is fetched again as soon as the request lands. */
let quoteLoading = false,
  quotePending = false;
async function loadQuote() {
  if (!state.ticker) return;
  if (quoteLoading) {
    quotePending = true;
    return;
  }
  quoteLoading = true;
  const started = performance.now();
  try {
    const r = await fetch(
        "/api/quote?" + new URLSearchParams({ source: state.source || "okx" }),
      ),
      data = await r.json();
    if (!r.ok) throw data;
    requestLatency = Math.round(performance.now() - started);
    state.ticker = data.ticker;
    state.lastGood = {
      ...(state.lastGood || {}),
      source: data.source,
      ticker: data.ticker,
      fetchedAt: data.fetchedAt,
      transport: data.transport,
      cacheAgeMs: data.cacheAgeMs,
      stale: data.stale,
    };
    renderTicker();
    onLivePrice(data.ticker.last, activeCoin());
    $("freshness").textContent = pointTime(data.fetchedAt);
    updateHeaderLatency();
  } catch {
  } finally {
    quoteLoading = false;
    /* 有被跳过的 tick 就立刻补一次，保证刷新节奏不出现空档。 */
    if (quotePending) {
      quotePending = false;
      setTimeout(loadQuote, 0);
    }
  }
}
/* ── L1: 服务端 SSE 实时推送 → 浏览器 ──────────────────────────────────────
   浏览器订阅 /api/stream，每次服务端从 OKX WebSocket 收到新 ticker 即推送过来，
   直接更新 state.ticker 并重绘，消除 2s 轮询间隙。EventSource 自带按 retry 重连；
   若始终连不上，下方既有的 2s loadQuote 轮询继续兜底，不回归。 */
let liveStream = null;
let lastSseTickerMsg = null;
function onLivePrice(price, coin) {
  /* L2: 当前（未收盘）K 线随实时价连续移动，像交易所官网一样呼吸，而非每 10s 跳一次。
     关键边界：仅当末根蜡烛属于「正在形成的当前周期」时才用实时价写 close/high/low。
     若 market() 因 OKX REST 刷新失败而回退旧快照，末根 open 仍是旧快照价位，无条件写
     实时价会画出从旧快照价贯穿到实时价的超长红蜡烛（根因 bug）。已收盘的末根保持快照
     原值即可，实时价照常显示在顶部 ticker，下一轮成功刷新即自然接上。 */
  if (coin === activeCoin() && state.candles && state.candles.length) {
    const c = state.candles[state.candles.length - 1];
    if (c && Number.isFinite(price)) {
      const intervalMs = (intervalMinutes[state.interval] || 0) * 60 * 1000;
      if (!intervalMs || Date.now() - c.time < intervalMs) {
        c.close = price;
        if (price > c.high) c.high = price;
        if (price < c.low) c.low = price;
        scheduleChartRender();
      }
    }
  }
}
function connectLiveStream() {
  if (liveStream || typeof EventSource === 'undefined') return;
  try {
    liveStream = new EventSource('/api/stream');
    liveStream.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'ticker' && msg.coin === activeCoin()) {
          lastSseTickerMsg = msg;
          state.ticker = msg.ticker;
          state.lastGood = {
            ...(state.lastGood || {}),
            source: 'okx', ticker: msg.ticker, fetchedAt: msg.tickerAt,
            transport: 'websocket',
            cacheAgeMs: Date.now() - (msg.serverTime || msg.tickerAt), stale: false
          };
          renderTicker();
          const fp = $('freshness'); if (fp) fp.textContent = pointTime(msg.tickerAt);
          onLivePrice(msg.ticker.last, msg.coin);
          updateHeaderLatency();
        }
      } catch { /* 单条消息解析失败不影响后续 */ }
    };
    liveStream.onerror = () => { /* 浏览器按 retry 自动重连；2s 轮询兜底继续 */ };
  } catch { liveStream = null; }
}
/* 连接模式选择器已移除：仅在价格下方显示浏览器到数据源的延迟，避免误导。 */
$("source").onchange = (e) => {
  state.source = e.target.value;
  loadCurrent();
};
buttons();
connectLiveStream();
setInterval(updateHeaderLatency, 1000); // 徽标延迟读数每秒自刷新
setTimeout(() => loadCurrent(), 0);
setInterval(() => {
  if (["5s", "10s", "30s"].includes(state.interval)) loadCurrent();
}, 2_000);
setInterval(() => {
  if (!["5s", "10s", "30s"].includes(state.interval)) loadCurrent();
}, 10_000);
setInterval(() => loadQuote(), refreshIntervalMs);
/* 页面从后台切回时立即补一次：后台标签的定时器会被浏览器降频，切回来若干等
   下一个 tick，看起来就像「卡住不刷新」。
   Refresh immediately when the tab becomes visible again — background tabs are
   throttled by the browser, so waiting for the next tick looks like a stall. */
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) loadQuote();
});

/* 图表与信号增强展示 / Enhanced chart and signal presentation */
let hoverIndex = null,
  hoverPoint = null;
function renderAnalysis() {
  const m = metrics(state.candles),
    [, cls] = classification(m.score),
    sigLabel = cls === "bull" ? tx("偏多", "Bullish") : cls === "bear" ? tx("偏空", "Bearish") : tx("观望", "Neutral"),
    direction = m.score >= 0 ? tx("做多", "Long") : tx("做空", "Short"),
    strength = Math.min(100, Math.abs(m.score));
  $("signal").textContent =
    `${sigLabel} ${m.score > 0 ? "+" : ""}${m.score.toFixed(2)}`;
  $("signal").className = `signal ${cls}`;
  $("signalReason").innerHTML =
    `<span>EMA20 ${money(m.e20)} · EMA50 ${money(m.e50)} · RSI(14) ${m.rsi.toFixed(2)} · MACD ${m.macd.toFixed(2)}</span><div class="signal-gauge"><div class="gauge-top"><b>${tx("做空", "Short")} −100.00</b><span>${tx("当前", "Now")}：${direction} ${m.score > 0 ? "+" : ""}${m.score.toFixed(2)}</span><b>${tx("做多", "Long")} +100.00</b></div><div class="gauge-track"><i style="left:${(m.score + 100) / 2}%"></i></div><div class="gauge-strength"><em style="width:${strength}%"></em><span>${tx("信号强度", "Signal strength")}：${strength.toFixed(2)}</span></div></div><small>${tx("基于当前 K 线的确定性规则打分，不是机器学习预测。", "Deterministic rule score from the current candle, not a machine-learning forecast.")}</small>`;
  $("sl").textContent = money(m.close - m.atr * 1.5);
  $("tp").textContent = money(m.close + m.atr * 3);
  const rows = [
    ["EMA20", money(m.e20), m.close >= m.e20 ? "bull" : "bear"],
    ["EMA50", money(m.e50), m.close >= m.e50 ? "bull" : "bear"],
    ["EMA200", money(m.e200), Number.isFinite(m.e200) && m.close >= m.e200 ? "bull" : "flat"],
    ["RSI(14)", m.rsi.toFixed(2), m.rsi > 55 ? "bull" : m.rsi < 45 ? "bear" : "flat"],
    [tx("布林位置", "Bollinger position"), (m.bb * 100).toFixed(2) + "%", m.bb > 0.6 ? "bull" : m.bb < 0.4 ? "bear" : "flat"],
    ["ATR(14)", money(m.atr), "flat"],
  ];
  // 重构后统一交给富集基座渲染（含中性指标折叠 / 研究结论 / 市场微观结构增强）
  renderExpandedIndicatorDetails(m);
  const tags = [
    [tx("5分", "5m"), 20],
    [tx("15分", "15m"), 60],
    [tx("1时", "1h"), 240],
    [tx("4时", "4h"), 960],
    [tx("1日", "1d"), Math.min(1439, state.candles.length - 1)],
  ]
    .map(([label, n]) => {
      const start =
        state.candles[Math.max(0, state.candles.length - 1 - n)].close;
      const v = (m.close / start - 1) * 100;
      return `<span><small>${label}</small><b class="${v >= 0 ? "bull" : "bear"}">${pct(v)}</b></span>`;
    })
    .join("");
  const tagEl = $("changeTags");
  if (tagEl) tagEl.innerHTML = tags;
  renderLeverageGuard(m);
  draw();
}
function visibleCandles() {
  const data = state.frozenCandles || state.candles,
    n = state.viewPoints
      ? Math.max(2, Math.ceil(state.viewPoints / state.zoom))
      : Math.max(30, Math.ceil(data.length / state.zoom)),
    maxOffset = Math.max(0, data.length - n);
  state.panOffset = Math.max(0, Math.min(maxOffset, state.panOffset || 0));
  const end = Math.max(n, data.length - state.panOffset);
  return data.slice(Math.max(0, end - n), end);
}
(() => {
  const cv = $("chart"),
    box = cv.parentElement,
    tip = document.createElement("div");
  tip.id = "chartTooltip";
  box.appendChild(tip);
  cv.addEventListener("mousemove", (event) => {
    const visible = visibleCandles();
    if (!visible.length) return;
    const rect = cv.getBoundingClientRect(),
      ratio = (event.clientX - rect.left - 18) / (rect.width - 92);
    hoverIndex = Math.max(
      0,
      Math.min(visible.length - 1, Math.round(ratio * (visible.length - 1))),
    );
    const d = visible[hoverIndex],
      change = (d.close / d.open - 1) * 100;
    tip.innerHTML = `<b>${time(d.time)}</b><span>开 ${money(d.open)}　高 ${money(d.high)}</span><span>低 ${money(d.low)}　收 ${money(d.close)}</span><span class="${change >= 0 ? "bull" : "bear"}">${pct(change)}　量 ${d.volume.toLocaleString("en-US", { maximumFractionDigits: 2 })}</span>`;
    tip.style.display = "grid";
    tip.style.left =
      Math.min(event.clientX - rect.left + 14, rect.width - 185) + "px";
    tip.style.top = Math.max(8, event.clientY - rect.top - 96) + "px";
    draw();
  });
  cv.addEventListener("mouseleave", () => {
    hoverIndex = null;
    tip.style.display = "none";
    draw();
  });
  cv.addEventListener(
    "wheel",
    (event) => {
      if (!event.metaKey && !event.ctrlKey) return;
      event.preventDefault();
      const data = state.frozenCandles || state.candles,
        n = state.viewPoints
          ? Math.max(2, Math.ceil(state.viewPoints / state.zoom))
          : Math.max(30, Math.ceil(data.length / state.zoom)),
        max = Math.max(0, data.length - n),
        step = Math.max(1, Math.round(n * 0.1));
      state.panOffset = Math.max(
        0,
        Math.min(
          max,
          (state.panOffset || 0) + (event.deltaY > 0 ? step : -step),
        ),
      );
      hoverIndex = null;
      clearChartSelection();
      draw();
    },
    { passive: false },
  );
  window.addEventListener("resize", draw);
})();
(() => {
  const main = document.querySelector("main"),
    chartCard = [...main.children].find(
      (x) => x.querySelector && x.querySelector("#chart"),
    ),
    grid = main.querySelector(".grid");
  if (!chartCard || !grid) return;
  chartCard.id = "mainChartCard";
  const layout = document.createElement("section");
  layout.className = "terminal-layout";
  const side = document.createElement("aside");
  side.className = "side-stack";
  const [signalCard, indicatorCard] = [...grid.children];
  signalCard.id = "ruleSignalCard";
  indicatorCard.id = "indicatorDetailsCard";
  side.append(signalCard, indicatorCard);
  const changes = document.createElement("section");
  changes.className = "card change-card chart-periods";
  changes.id = "periodChangeCard";
  changes.innerHTML = '<h2>周期涨幅</h2><div id="changeTags"></div>';
  // v2.10.56：K 线图、OKX 微观结构、周期涨幅拆为左列三张平级卡片，
  // 不再嵌套在同一个大卡片内。.chart-column 纵向排列并提供卡片间距。
  // Keep period returns inside the main chart column, directly after the OKX microstructure card,
  // so the right column's height never creates an empty gap in the chart column.
  const chartColumn = document.createElement("section");
  chartColumn.className = "chart-column";
  chartColumn.append(chartCard, changes);
  layout.append(chartColumn, side);
  main.insertBefore(layout, grid);
  grid.remove();
  const title = main.querySelector("header h1");
  title.textContent = "₿ BTC/USDT 多空指标";
  // 注意：此处不调用 updateHeaderLatency()，因为模块顶层执行时 core.js 的
  // requestLatency 仍在 TDZ（app.js 与 core.js 存在循环依赖）。徽标会在模块初始化
  // 完成后由 loadCurrent / 连接代码统一渲染，这里只设标题即可。
})();
/* On phones, read the live decision before working through the dense chart.
   The same nodes are restored to the right sidebar on desktop, so state and
   event handlers are preserved rather than duplicated. */
(() => {
  const query = matchMedia("(max-width: 760px)");
  function arrange() {
    const layout = document.querySelector(".terminal-layout"),
      side = layout?.querySelector(".side-stack"),
      chart = $("mainChartCard"),
      signal = $("ruleSignalCard"),
      indicators = $("indicatorDetailsCard"),
      changes = $("periodChangeCard"),
      sentiment = $("fearGreedGauge");
    if (!layout || !side || !chart || !signal || !indicators || !changes)
      return;
    if (query.matches) {
      layout.classList.add("mobile-reading-layout");
      // 若尾部平衡器把「多周期共振」临时放进了左列，重建之前必须把它先放回主流程，
      // 否则整个 .chart-column 会被 replaceChildren 丢弃，卡跟着消失。
      const stowed = layout.querySelector(".chart-column > .optional");
      if (stowed) layout.after(stowed);
      const healthMobile = $("marketHealthCard");
      layout.replaceChildren(signal, chart, changes, ...(healthMobile ? [healthMobile] : []), side);
      side.hidden = true;
      // 移动端：宏观与情绪不能留在 hidden 的 side-stack 里，否则会被隐藏。
      // 把它放到 terminal-layout 之后、indicatorDetailsCard 之前。
      if (sentiment && side.contains(sentiment)) layout.after(sentiment);
      layout.after(indicators);
    } else {
      side.hidden = false;
      side.replaceChildren(signal, indicators);
      // 桌面端：宏观与情绪固定在右侧 side-stack 的 indicatorDetailsCard 下方。
      if (sentiment && !side.contains(sentiment)) side.append(sentiment);
      layout.classList.remove("mobile-reading-layout");
      // 桌面端左列 = K 线卡 + OKX 微观结构卡 + 周期涨幅卡 三张平级卡片。
      let column = layout.querySelector(".chart-column");
      if (!column) {
        column = document.createElement("section");
        column.className = "chart-column";
      }
      const okx = $("okxMicrostructureCard");
      /* ⚠️ 尾部平衡器（syncTailBalance）在差值过大时会把「多周期共振」临时放进左列。
         这里的 replaceChildren 会把不在清单里的子节点整个摘掉 —— 卡片会凭空消失
         （实测：宏观卡一长就触发）。所以凡是已经在左列里的共振卡，必须原样带上。 */
      const stowedResonance = column.querySelector(".optional");
      const healthDesktop = $("marketHealthCard");
      column.replaceChildren(chart, ...(okx ? [okx] : []), changes, ...(healthDesktop ? [healthDesktop] : []), ...(stowedResonance ? [stowedResonance] : []));
      layout.replaceChildren(column, side);
    }
    draw();
  }
  window.arrangeTerminalLayout = arrange;
  query.addEventListener("change", arrange);
  setTimeout(arrange, 0);
  setTimeout(arrange, 80);
})();
function buttons() {
  $("intervals").innerHTML =
    `<span class="control-label">K 线周期</span>` +
    intervals
      .map(
        ([v, n]) =>
          `<button data-i="${v}" class="${state.range === null && state.interval === v ? "active" : ""}">${n}</button>`,
      )
      .join("");
  $("ranges").innerHTML =
    `<span class="control-label">查看范围</span>` +
    Object.keys(ranges)
      .map(
        (x) =>
          `<button data-r="${x}" class="${state.range === x ? "active" : ""}">${x}</button>`,
      )
      .join("");
  document.querySelectorAll("[data-i]").forEach(
    (b) =>
      (b.onclick = () => {
        state.interval = b.dataset.i;
        state.limit = 300;
        state.range = null;
        loadCurrent();
      }),
  );
  document.querySelectorAll("[data-r]").forEach(
    (b) =>
      (b.onclick = () => {
        const [i, l] = ranges[b.dataset.r];
        state.interval = i;
        state.limit = l;
        state.range = b.dataset.r;
        loadCurrent();
      }),
  );
}
(() => {
  const coverage = $("coverage");
  new MutationObserver(() => {
    const raw = coverage.textContent,
      rangePrefix = tx("查看范围", "Visible range"),
      intervalPrefix = tx("K 线周期", "Candle interval");
    if (raw.startsWith(rangePrefix) || raw.startsWith(intervalPrefix)) return;
    coverage.textContent = `${state.range ? `${rangePrefix} ${txInterval(state.range)}` : `${intervalPrefix} ${txInterval(state.interval)}`} · ${raw}`;
  }).observe(coverage, { childList: true, characterData: true, subtree: true });
})();
(() => {
  const toolbar = document.querySelector(".toolbar"),
    zoom = document.createElement("div");
  zoom.className = "zoom-tools";
  zoom.innerHTML =
    '<button title="缩小图表" data-zoom="out">−</button><span id="zoomLabel">100%</span><button title="放大图表" data-zoom="in">+</button><button title="重置缩放" data-zoom="reset">重置</button>';
  toolbar.append(zoom);
  zoom.onclick = (e) => {
    const op = e.target.dataset.zoom;
    if (!op) return;
    state.zoom =
      op === "in"
        ? Math.min(7, state.zoom * 1.5)
        : op === "out"
          ? Math.max(1, state.zoom / 1.5)
          : 1;
    $("zoomLabel").textContent = `${Math.round(state.zoom * 100)}%`;
    draw();
  };
})();
function sigmoid(x) {
  return 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, x))));
}
function featureSet(closes, i) {
  const ret = (k) => (closes[i] / closes[i - k] - 1) * 100;
  let mean = 0;
  for (let k = 1; k <= 12; k++) mean += ret(k);
  mean /= 12;
  let variance = 0;
  for (let k = 1; k <= 12; k++) variance += (ret(k) - mean) ** 2;
  return [ret(1), ret(4), ret(12), Math.sqrt(variance / 12)];
}
function trainProbability(closes, horizon) {
  const end = closes.length - horizon - 1,
    rows = [];
  for (let i = 20; i <= end; i += 3)
    rows.push({
      x: featureSet(closes, i),
      y: closes[i + horizon] > closes[i] ? 1 : 0,
    });
  if (rows.length < 80) return null;
  const split = Math.floor(rows.length * 0.8),
    train = rows.slice(0, split),
    test = rows.slice(split),
    w = [0, 0, 0, 0],
    hidden = Array.from({ length: 6 }, (_, j) => [
      0.13 * Math.sin(j + 1),
      0.11 * Math.sin(j + 3),
      0.09 * Math.sin(j + 5),
      0.07 * Math.sin(j + 7),
    ]),
    out = Array.from({ length: 6 }, (_, j) => 0.12 * Math.cos(j + 2));
  let bias = 0,
    ob = 0;
  for (let epoch = 0; epoch < 70; epoch++)
    for (const r of train) {
      const z = r.x.map((_, j) =>
          r.x.reduce((s, v, k) => s + v * hidden[j][k], 0),
        ),
        a = z.map(sigmoid),
        p = sigmoid(bias + r.x.reduce((s, v, j) => s + v * w[j], 0));
      const q = sigmoid(ob + a.reduce((s, v, j) => s + v * out[j], 0)),
        err = r.y - p;
      bias += 0.012 * err;
      r.x.forEach((v, j) => (w[j] += 0.012 * err * v));
      const qe = r.y - q;
      ob += 0.008 * qe;
      a.forEach((v, j) => {
        out[j] += 0.008 * qe * v;
        hidden[j].forEach(
          (_, k) =>
            (hidden[j][k] += 0.002 * qe * out[j] * v * (1 - v) * r.x[k]),
        );
      });
    }
  const score = (r) => {
    const p = sigmoid(bias + r.x.reduce((s, v, j) => s + v * w[j], 0));
    const a = hidden.map((h) =>
      sigmoid(r.x.reduce((s, v, k) => s + v * h[k], 0)),
    );
    const q = sigmoid(ob + a.reduce((s, v, j) => s + v * out[j], 0));
    return (p + q) / 2;
  };
  const accuracy =
    test.filter((r) => (score(r) >= 0.5 ? 1 : 0) === r.y).length / test.length;
  return {
    prob: score({ x: featureSet(closes, closes.length - 1) }),
    accuracy,
    train: train.length,
    test: test.length,
  };
}
async function loadForecasts() {
  const grid = $("forecastGrid"),
    status = $("forecastStatus");
  if (!grid) return;
  status.textContent = "正在获取训练样本并进行滚动训练…";
  try {
    const r = await fetch("/api/forecast-history");
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "history request failed");
    const jobs = [
      ["30分", "intraday", 2],
      ["1小时", "intraday", 4],
      ["2小时", "intraday", 8],
      ["半天", "intraday", 48],
      ["1天", "intraday", 96],
      ["2天", "intraday", 192],
      ["1周", "daily", 7],
      ["半个月", "daily", 15],
      ["1个月", "daily", 30],
      ["半年", "daily", 180],
    ];
    grid.innerHTML = jobs
      .map(([label, key, h]) => {
        const fit = trainProbability(
          data[key].map((x) => x.close),
          h,
        );
        if (!fit)
          return `<div class="forecast-item muted"><span>${label}</span><b>样本不足</b></div>`;
        const long = fit.prob * 100,
          cls = long >= 50 ? "bull" : "bear";
        return `<div class="forecast-item"><span>${label}</span><b class="${cls}">${long.toFixed(2)}% 看多</b><small>看空 ${(100 - long).toFixed(2)}% · 验证 ${(fit.accuracy * 100).toFixed(2)}% · n=${fit.train}</small></div>`;
      })
      .join("");
    status.textContent = `双模型集成：L2 逻辑回归 + 小型神经网络 · ${data.cached ? "缓存历史样本" : "刚更新"} · 概率为方向条件概率，不是收益预测。`;
  } catch (e) {
    status.textContent = `概率模块暂不可用：${e.message}`;
  }
}
function pearson(a, b) {
  const n = Math.min(a.length, b.length),
    ma = a.slice(-n).reduce((s, x) => s + x, 0) / n,
    mb = b.slice(-n).reduce((s, x) => s + x, 0) / n;
  let xy = 0,
    xx = 0,
    yy = 0;
  for (let i = 0; i < n; i++) {
    const x = a[a.length - n + i] - ma,
      y = b[b.length - n + i] - mb;
    xy += x * y;
    xx += x * x;
    yy += y * y;
  }
  return xy / Math.sqrt(xx * yy || 1);
}
let leverageExchange =
  localStorage.getItem("btc_leverage_exchange") || "okx";
function renderLeverageGuard(m) {
  const out = $("leverageGrid");
  if (!out) return;
  const exchange = {
      binance: { name: "Binance USDⓈ-M", mmr: 0.004 },
      okx: { name: tx("OKX USDT 永续", "OKX USDT perpetual"), mmr: 0.005 },
      coinbase: { name: "Coinbase Perpetuals", mmr: 0.006 },
    }[leverageExchange],
    entry = m.close,
    mmr = exchange.mmr,
    data = state.candles.slice(-60),
    swings = [];
  for (let i = 19; i < data.length; i++) {
    const window = data.slice(i - 19, i + 1),
      hi = maxOf(window.map((x) => x.high)),
      lo = minOf(window.map((x) => x.low));
    swings.push((hi - lo) / data[i].close);
  }
  const sorted = swings.sort((a, b) => a - b),
    p80 = sorted.length ? sorted[Math.floor((sorted.length - 1) * 0.8)] : 0;
  const atrFloor = (m.atr / entry) * 2,
    bufferPct = Math.max(p80 * 0.35, atrFloor, 0.003),
    buffer = entry * bufferPct;
  const method = $("leverageMethod");
  if (method)
    method.textContent = tx(
      `已应用 ${exchange.name} 的比较用近似参数（维持保证金 ${(mmr * 100).toFixed(2)}%）。自适应缓冲：近 ${data.length} 根 K 线的 20 根高低振幅 P80 为 ${(p80 * 100).toFixed(2)}%，取其 35% 与 2×ATR 中较大者；当前缓冲 ${(bufferPct * 100).toFixed(2)}%（${money(buffer)}）。`,
      `Using ${exchange.name} comparison parameters (maintenance margin ${(mmr * 100).toFixed(2)}%). Adaptive buffer: the P80 20-candle high/low range across the latest ${data.length} candles is ${(p80 * 100).toFixed(2)}%; the buffer uses the greater of 35% of that value and 2×ATR. Current buffer ${(bufferPct * 100).toFixed(2)}% (${money(buffer)}).`,
    );
  out.innerHTML = [10, 30, 50, 100]
    .map((lev) => {
      const long = entry * (1 - 1 / lev + mmr),
        short = entry * (1 + 1 / lev - mmr);
      return `<div class="lev-row"><b>${lev}×</b><span><small>${tx("多 · 理论强平", "Long · theoretical liq.")}</small>${money(long)}</span><span><small>${tx("多 · 缓冲警戒", "Long · buffer warning")}</small>${money(long + buffer)}</span><span><small>${tx("空 · 理论强平", "Short · theoretical liq.")}</small>${money(short)}</span><span><small>${tx("空 · 缓冲警戒", "Short · buffer warning")}</small>${money(short - buffer)}</span></div>`;
    })
    .join("");
}
function trainCrossMarket(rows) {
  if (rows.length < 120) return null;
  const split = Math.floor(rows.length * 0.8),
    w = [0, 0, 0],
    train = rows.slice(0, split),
    test = rows.slice(split);
  let b = 0;
  for (let e = 0; e < 90; e++)
    for (const r of train) {
      const p = sigmoid(b + r.x.reduce((s, v, i) => s + v * w[i], 0)),
        err = r.y - p;
      b += 0.018 * err;
      r.x.forEach((v, i) => (w[i] += 0.018 * err * v));
    }
  const score = (x) => sigmoid(b + x.reduce((s, v, i) => s + v * w[i], 0));
  const accuracy =
    test.filter((r) => (score(r.x) >= 0.5 ? 1 : 0) === r.y).length /
    test.length;
  return { prob: score(rows.at(-1).x), accuracy, n: train.length };
}
async function loadCorrelation() {
  const status = $("correlationStatus"),
    out = $("correlationOutput");
  if (!out) return;
  status.textContent = "正在对齐 " + coinLabel() + "、SPY、QQQ 的共同交易日并训练…";
  try {
    const r = await fetch("/api/correlation-history");
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "request failed");
    const quoteCard = (name, ticker, q) => {
      const delta = q.last - q.previous,
        up = delta >= 0;
      return `<article class="index-card ${up ? "up" : "down"}"><span>${name} · ${ticker}</span><b>${q.last.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b><div><em>${up ? "+" : "−"}${Math.abs(delta).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</em><em>${up ? "+" : "−"}${((Math.abs(delta) / q.previous) * 100).toFixed(2)}%</em></div><small>最近收盘</small></article>`;
    };
    const cards = $("indexTickerCards");
    if (cards)
      cards.innerHTML =
        quoteCard("标普 500", "SPY", d.indexQuotes.spy) +
        quoteCard("纳斯达克 100", "QQQ", d.indexQuotes.qqq);
    const byDate = (arr) =>
        new Map(
          arr.map((x) => [
            new Date(x.time).toISOString().slice(0, 10),
            x.close,
          ]),
        ),
      btc = byDate(d.btc),
      spy = byDate(d.spy),
      qqq = byDate(d.qqq),
      dates = [...btc.keys()].filter((k) => spy.has(k) && qqq.has(k)).sort(),
      rows = [];
    for (let i = 1; i < dates.length - 1; i++) {
      const prev = dates[i - 1],
        cur = dates[i],
        next = dates[i + 1],
        br = (btc.get(cur) / btc.get(prev) - 1) * 100,
        sr = (spy.get(cur) / spy.get(prev) - 1) * 100,
        qr = (qqq.get(cur) / qqq.get(prev) - 1) * 100;
      rows.push({
        br,
        sr,
        qr,
        y: btc.get(next) > btc.get(cur) ? 1 : 0,
        x: [sr, qr, br],
      });
    }
    const recent = rows.slice(-60),
      fit = trainCrossMarket(rows),
      corrSPY = pearson(
        recent.map((x) => x.br),
        recent.map((x) => x.sr),
      ),
      corrQQQ = pearson(
        recent.map((x) => x.br),
        recent.map((x) => x.qr),
      ),
      p = fit ? Math.round(fit.prob * 100) : null;
    out.innerHTML = `<div class="corr-stat"><span>BTC × SPY（60日）</span><b class="${corrSPY >= 0 ? "bull" : "bear"}">${corrSPY >= 0 ? "+" : ""}${corrSPY.toFixed(2)}</b><small>${corrSPY >= 0.3 ? "正相关较明显" : corrSPY <= -0.3 ? "负相关较明显" : "相关性偏弱"}</small></div><div class="corr-stat"><span>BTC × QQQ（60日）</span><b class="${corrQQQ >= 0 ? "bull" : "bear"}">${corrQQQ >= 0 ? "+" : ""}${corrQQQ.toFixed(2)}</b><small>${corrQQQ >= 0.3 ? "正相关较明显" : corrQQQ <= -0.3 ? "负相关较明显" : "相关性偏弱"}</small></div><div class="corr-stat wide"><span>跨市场模型：下一交易日 BTC 看多概率</span><b class="${p >= 50 ? "bull" : "bear"}">${p === null ? "--" : p.toFixed(2) + "%"}</b><small>${fit ? `SPY、QQQ 与 BTC 当日收益特征 · 样本外准确率 ${(fit.accuracy * 100).toFixed(2)}% · 训练 n=${fit.n}` : "共同交易日不足"}</small></div>`;
    status.textContent = `数据已按共同交易日对齐 · ${d.cached ? "缓存数据" : "刚更新"} · 相关性会随窗口变化，不能单独作为开仓信号。`;
  } catch (e) {
    status.textContent = `美股联动模块暂不可用：${e.message}`;
  }
}
(() => {
  // v2.11.0：「BTC × 美股联动分析」不再创建独立卡片，整体并入
  // 「宏观环境与跨市场联动」卡（fedMonitorCard）底部的联动面板。
  // loadCorrelation 会把结果写入 correlationState，由 renderFedMonitor 渲染时回填。
  setTimeout(loadCorrelation, 950);
})();
(() => {
  const card = document.createElement("section"),
    details = document.createElement("details");
  card.className = "card leverage-card";
  card.innerHTML =
    '<div class="forecast-head leverage-head"><div><h2 data-zh="高杠杆强平缓冲参考" data-en="High-leverage liquidation buffer">高杠杆强平缓冲参考</h2><p data-zh="逐仓近似演示；实际强平以标记价格、仓位档位、费用和保证金模式为准。" data-en="Isolated-margin approximation; actual liquidation depends on mark price, position tier, fees, and margin mode.">逐仓近似演示；实际强平以标记价格、仓位档位、费用和保证金模式为准。</p></div><div class="leverage-controls"><label class="leverage-exchange">交易所 <select id="leverageExchange"><option value="binance">Binance</option><option value="okx">OKX</option><option value="coinbase">Coinbase</option></select></label></div></div><p id="leverageMethod" class="leverage-method" data-zh="正在根据近期震荡幅度计算缓冲…" data-en="Computing buffer from recent volatility…">正在根据近期震荡幅度计算缓冲…</p><div id="leverageGrid" class="leverage-grid"></div>';
  details.id = "leverageDetails";
  details.className = "position-details leverage-details";
  // This initializer runs before the language helper exists; applyLanguage()
  // updates the summary after boot when the user changes the interface language.
  details.innerHTML = "<summary>高杠杆强平缓冲参考</summary>";
  details.append(card);
  // v2.11.0：联动卡已并入 fedMonitorCard，这里直接挂到 main 末尾即可，
  // 后续卡片会按各自锚点插入，阅读顺序由渲染函数维护。
  document.querySelector("main")?.append(details);
  const select = $("leverageExchange");
  select.value = leverageExchange;
  select.onchange = () => {
    leverageExchange = select.value;
    localStorage.setItem("btc_leverage_exchange", leverageExchange);
    if (state.candles.length) renderLeverageGuard(metrics(state.candles));
  };
})();
let themeMode = localStorage.getItem("btc_theme") || "auto";
function applyTheme() {
  document.documentElement.dataset.theme = themeMode;
  applyAmbientLight();
  localStorage.setItem("btc_theme", themeMode);
  const b = $("themeToggle");
  if (b)
    b.textContent = `◐ ${locale().theme[["auto", "light", "dark"].indexOf(themeMode)]}`;
}
function applyAmbientLight() {
  const hour = new Date().getHours();
  const ambientTime =
    hour >= 6 && hour < 10
      ? "dawn"
      : hour >= 10 && hour < 17
        ? "day"
        : hour >= 17 && hour < 21
          ? "dusk"
          : "night";
  document.documentElement.dataset.ambientTime = ambientTime;
}
function syncFullscreenButton() {
  const b = $("fullscreenToggle"),
    active = !!(
      document.fullscreenElement || document.webkitFullscreenElement
    );
  if (b) {
    const label = active ? locale().exitFullscreen : locale().fullscreen;
    b.textContent = active ? "⤢ " + label : "⛶ " + label;
    b.title = label;
    b.setAttribute("aria-label", label);
    b.setAttribute("aria-pressed", String(active));
  }
  // 全屏时把页面顶部 header（标题/账户/全屏按钮等）也藏掉，
  // 让画面只留图表与指标区。ESC 退出时浏览器 fullscreenchange
  // 会再次回调本函数，自动把 class 撤掉、header 恢复。
  document.documentElement.classList.toggle("is-fullscreen", active);
}
async function toggleFullscreen() {
  const active = document.fullscreenElement || document.webkitFullscreenElement;
  try {
    if (active) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) await exit.call(document);
    } else {
      const enter =
        document.documentElement.requestFullscreen ||
        document.documentElement.webkitRequestFullscreen;
      if (enter) await enter.call(document.documentElement);
    }
  } catch (e) {
    console.warn("Fullscreen unavailable", e);
  } finally {
    syncFullscreenButton();
  }
}
/* 分屏外壳（split-mode.js）复用这一套全屏：全屏的是整个文档，而分屏覆盖层本身就是
   全屏固定层，所以效果就是「只看到分屏」。别在分屏那边另写一份 requestFullscreen ——
   两处各写一份的话，`.is-fullscreen`（隐藏页头）与按钮态同步都会漏掉一边。 */
window.btcFullscreen = { toggle: () => toggleFullscreen() };
function applyLanguage() {
  const x = locale();
  document.documentElement.lang = uiLang === "zh" ? "zh-CN" : "en";
  document.querySelector("header h1").textContent = x.title;
  document.querySelector(".controls label").dataset.label = x.source;
  document
    .querySelectorAll(".control-label")
    .forEach((e, i) => (e.textContent = i ? x.range : x.kline));
  const f = document.querySelector(".forecast-card h2");
  if (f) f.textContent = x.forecast;
  const c = document.querySelector(".fed-corr-panel h3");
  if (c) c.textContent = x.correlation;
  const b = $("langToggle");
  if (b) b.textContent = uiLang === "zh" ? "EN" : "中文";
  const apiC = $("apiCenterToggle");
  if (apiC) apiC.textContent = tx("API 接入中心", "API Center");
  applyTheme();
  syncFullscreenButton();
}
function formatZone(zone) {
  return new Intl.DateTimeFormat(uiLang === "zh" ? "zh-CN" : "en-US", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "short",
  }).format(new Date());
}
function nyseState() {
  const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date()),
    get = (t) => parts.find((x) => x.type === t)?.value,
    day = get("weekday"),
    mins = +get("hour") * 60 + +get("minute");
  return !["Sat", "Sun"].includes(day) && mins >= 570 && mins < 960;
}
let usEquityStripMarkup = "",
  usEquityQuoteBusy = false;
function renderUsEquityStrip() {
  const host = $("usEquityStrip");
  if (!host) return;
  host.hidden = !usEquityStripMarkup;
  host.innerHTML = usEquityStripMarkup;
}
async function loadUsEquityStrip() {
  if (!nyseState()) {
    usEquityStripMarkup = "";
    renderUsEquityStrip();
    return;
  }
  if (usEquityQuoteBusy) return;
  usEquityQuoteBusy = true;
  try {
    const response = await fetch("/api/us-equity-quotes", {
        cache: "no-store",
      }),
      data = await response.json();
    if (
      !response.ok ||
      !data.open ||
      !Array.isArray(data.quotes) ||
      data.quotes.length !== 2
    ) {
      usEquityStripMarkup = "";
      return;
    }
    usEquityStripMarkup = data.quotes
      .map((quote) => {
        const delta = quote.last - quote.previous,
          pct = (delta / quote.previous) * 100,
          cls = delta >= 0 ? "bull" : "bear";
        return `<span class="us-equity-quote"><b>${quote.symbol}</b> <strong>${quote.last.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong> <em class="${cls}">${delta >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(2)}%</em></span>`;
      })
      .join("");
  } catch {
    usEquityStripMarkup = "";
  } finally {
    usEquityQuoteBusy = false;
    renderUsEquityStrip();
  }
}
var exchangeStripMarkup = "";
/* 多周期共振卡片「!」里的说明文案。放在这里（而不是就地写在安装函数里），
   是因为同一个 help-dot 还挂着「数据源与更新频率」的追加写入，两边要共用一个真源。 */
function renderExchangeStrip() {
  const host = $("exchangeMeta");
  if (host) host.innerHTML = exchangeStripMarkup;
}
function updateClocks() {
  const el = $("marketClocks");
  if (!el) return;
  const zh = uiLang === "zh";
  el.innerHTML = `<span>${zh ? "北京时间" : "Beijing"} <b>${formatZone("Asia/Shanghai")} GMT+8</b></span><i></i><span>${zh ? "纽约（美股）" : "New York (NYSE)"} <b>${formatZone("America/New_York")}</b> · <em class="${nyseState() ? "open" : "closed"}">${nyseState() ? (zh ? "开市中" : "Market open") : zh ? "09:30 开盘" : "Opens 09:30"}</em></span><span id="usEquityStrip" class="us-equity-strip" hidden></span><span id="exchangeMeta" aria-label="OKX 实时行情"></span>`;
  renderUsEquityStrip();
  renderExchangeStrip();
}
(() => {
  const header = document.querySelector("header"),
    controls = header.querySelector(".controls"),
    clocks = document.createElement("div");
  clocks.id = "marketClocks";
  header.after(clocks);
  const lang = document.createElement("button");
  lang.id = "langToggle";
  const fullscreen = document.createElement("button");
  fullscreen.id = "fullscreenToggle";
  fullscreen.type = "button";
  const theme = document.createElement("button");
  theme.id = "themeToggle";
  const apiCenter = document.createElement("button");
  apiCenter.id = "apiCenterToggle";
  apiCenter.type = "button";
  apiCenter.textContent = tx("API 接入中心","API Center");
  apiCenter.title = tx("管理数据源 API 接入","Manage data-source API keys");
  controls.append(apiCenter, lang, fullscreen, theme);
  /* 设置齿轮 + 下拉面板（v2.12.7）：把「账户 / API 接入中心 / 版本 / 连通性测试 /
     数据源」从顶栏收进齿轮面板，顶栏只留 模式开关 · 语言 · 全屏 · 深色 · 齿轮。
     面板是 .controls 的子节点 —— 上层用后代选择器（.controls label 等）的
     i18n 与样式逻辑不受影响；各按钮的插入点在各自创建处改为「面板优先」。 */
  const gear = document.createElement("button");
  gear.id = "headerSettingsToggle";
  gear.type = "button";
  gear.title = tx("设置", "Settings");
  gear.setAttribute("aria-haspopup", "true");
  gear.setAttribute("aria-expanded", "false");
  gear.innerHTML =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>';
  controls.append(gear);
  const panel = document.createElement("div");
  panel.id = "headerSettingsPanel";
  panel.hidden = true;
  controls.append(panel);
  // 静态「数据源」标签先搬进面板；账户/版本/连通性由各自创建时机插入面板。
  const settingsSource = controls.querySelector("label");
  if (settingsSource) panel.append(settingsSource);
  panel.append(apiCenter);
  gear.addEventListener("click", (event) => {
    // 顶栏 document 级收起监听会把刚打开的浮层立刻关掉，必须阻断。
    event.stopPropagation();
    const open = panel.hidden;
    panel.hidden = !open;
    gear.setAttribute("aria-expanded", String(open));
  });
  panel.addEventListener("click", (event) => event.stopPropagation());
  document.addEventListener("click", () => {
    if (!panel.hidden) {
      panel.hidden = true;
      gear.setAttribute("aria-expanded", "false");
    }
  });
  initApiCenter();
  lang.onclick = () => {
    setUiLangState(uiLang === "zh" ? "en" : "zh");
    localStorage.setItem("btc_lang", uiLang);
    applyLanguage();
    updateClocks();
    window.dispatchEvent(new Event("btc:voice-language-changed"));
  };
  fullscreen.onclick = toggleFullscreen;
  theme.onclick = () => {
    themeMode = { auto: "light", light: "dark", dark: "auto" }[themeMode];
    applyTheme();
  };
  document.addEventListener("fullscreenchange", syncFullscreenButton);
  document.addEventListener("webkitfullscreenchange", syncFullscreenButton);
  applyLanguage();
  updateClocks();
  loadUsEquityStrip();
  setInterval(updateClocks, 1000);
  setInterval(applyAmbientLight, 10 * 60 * 1000);
  setInterval(loadUsEquityStrip, 10_000);
})();

/* 交互、说明与完整语言层 / Interaction, explanations, and complete language layer */
let chartSelection = null,
  requestLatency = 0;
// 通用「按 key 取本地化名」辅助：maps 为 { key: [zh, en] }，缺失时回退到 key 本身。
const tname = (maps, key) => {
  const entry = maps && maps[key];
  if (!entry) return key;
  return Array.isArray(entry) ? (uiLang === "zh" ? entry[0] : entry[1]) : entry;
};
// 宏观事件（FOMC / CPI / 非农等）双语名，key 与 /api/fed-calendar 返回一致。
const MACRO_EVENT_NAMES = {
  fomc: ["FOMC 议息会议", "FOMC meeting"],
  cpi: ["美国 CPI 公布", "US CPI release"],
  payrolls: ["美国非农就业", "US nonfarm payrolls"],
  ppi: ["美国 PPI 公布", "US PPI release"],
  gdp: ["美国 GDP 初值", "US GDP (advance)"],
  retail: ["美国零售销售", "US retail sales"],
  housing: ["美国房屋数据", "US housing data"],
  minutes: ["FOMC 会议纪要", "FOMC minutes"],
  speech: ["美联储官员讲话", "Fed speaker"],
};
// 跨市场环境指标（传统市场 + 加密）双语名，key 与 /api/fed-calendar marketSignals 返回一致。
const ENV_SIGNAL_NAMES = {
  gold: ["黄金", "Gold"],
  dxy: ["美元指数", "US Dollar Index"],
  ndx: ["纳斯达克100", "Nasdaq 100"],
  spx: ["标普 500", "S&P 500"],
  us10y: ["美国10年期国债收益率", "US 10Y Treasury yield"],
  wti: ["WTI 原油", "WTI crude oil"],
  brent: ["布伦特原油", "Brent crude"],
  cnh: ["美元/离岸人民币", "USD/CNH"],
  vix: ["VIX 波动率", "VIX volatility"],
  "btc-dominance": ["BTC 总市值占比", "BTC dominance"],
  "crypto-total-cap": ["全网加密总市值", "Total crypto market cap"],
  "crypto-volume": ["全网 24h 成交额", "Total 24h crypto volume"],
  "exchange-btc-reserve": ["交易所 BTC 钱包余额", "Exchange BTC reserves"],
};
/* v2.12.53：实时宏观信号子集（对照表左列）—— 宏观卡滚动条与顶部滚动条共用。
   排除加密快照类（BTC 占比 / 总市值 / 成交额 / 交易所余额）。 */
const REALTIME_SIGNAL_KEYS = ["gold", "dxy", "ndx", "spx", "us10y", "wti", "brent", "cnh", "vix"];
// 周期/范围内部标签（中文 token → 英文显示）。Interval/range internal tokens (zh → en display).
// 跨市场指标的数据频率（cadence）与不可用说明（detail）双语映射。
// Bilingual maps for cross-market indicator cadence labels and unavailable details.
const SIGNAL_CADENCE = {
  "日线": "Daily",
  "快照": "Snapshot",
  "24h 快照": "24h snapshot",
  "实时": "Live",
};
const SIGNAL_DETAIL = {
  "需要可验证的链上数据订阅；当前未接入 Key":
    "Needs a verifiable on-chain data subscription; no API key connected yet",
};
// 研究 / A-B 实验中心里由后端返回的中文名称与描述，做中英映射。
// 研究预测专用 i18n 映射（RESEARCH_WINDOW_LABELS / txWinLabel）已抽到 src/modules/research.js；A/B 实验中心相关映射已随板块移除（v2.12.43）。
// Chinese experiment names/candidates returned by the research backend, with EN equivalents.
const txMap = (map, value, fallback) =>
  value == null ? fallback : (uiLang === "zh" ? value : (map[value] || value));
let floatingHelpTip = null,
  activeHelpDot = null;
function ensureFloatingHelpTip() {
  if (floatingHelpTip) return floatingHelpTip;
  floatingHelpTip = document.createElement("div");
  floatingHelpTip.id = "globalHelpTooltip";
  floatingHelpTip.setAttribute("role", "tooltip");
  floatingHelpTip.hidden = true;
  document.body.append(floatingHelpTip);
  return floatingHelpTip;
}
function showFloatingHelpTip(dot) {
  const text = dot?.dataset?.tip;
  if (!text) return;
  const tip = ensureFloatingHelpTip();
  activeHelpDot = dot;
  tip.innerHTML = text;
  tip.hidden = false;
  const rect = dot.getBoundingClientRect(),
    margin = 12,
    maxLeft = Math.max(margin, window.innerWidth - tip.offsetWidth - margin);
  let left = Math.min(
    maxLeft,
    Math.max(margin, rect.left + rect.width / 2 - tip.offsetWidth / 2),
  );
  let top = rect.bottom + 9;
  if (top + tip.offsetHeight > window.innerHeight - margin)
    top = Math.max(margin, rect.top - tip.offsetHeight - 9);
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
}
function hideFloatingHelpTip(dot) {
  if (dot && dot !== activeHelpDot) return;
  activeHelpDot = null;
  if (floatingHelpTip) floatingHelpTip.hidden = true;
}
/* 说明的触发节奏：鼠标要「停住」才弹 —— 「!」上 260ms、卡片标题文字上 800ms。
   这是 NN/g 与 Material 的通行量级（300–500ms），扫过不该弹东西；键盘 focus 仍然即时。 */
let helpShowTimer = null;
const HELP_DOT_DELAY_MS = 260,
  HELP_HOST_DELAY_MS = 800;
function scheduleHelpShow(dot, delay) {
  if (activeHelpDot === dot && floatingHelpTip && !floatingHelpTip.hidden) return;
  clearTimeout(helpShowTimer);
  helpShowTimer = setTimeout(() => showFloatingHelpTip(dot), delay);
}
document.addEventListener("pointerover", (event) => {
  const target = event.target,
    dot = target.closest?.(".help-dot[data-tip]");
  if (dot) {
    scheduleHelpShow(dot, HELP_DOT_DELAY_MS);
    return;
  }
  /* 不想去瞄那个小图标也行：指针停在卡片标题（h2 / h3 / summary）上同样给说明。 */
  const hostDot = target
    .closest?.("h2, h3, summary")
    ?.querySelector(".help-dot[data-tip]");
  if (hostDot) {
    scheduleHelpShow(hostDot, HELP_HOST_DELAY_MS);
    return;
  }
  /* 说明层本身可以悬停（长说明要在里面滚），所以指针移到浮层上不算离开。 */
  clearTimeout(helpShowTimer);
  if (floatingHelpTip && !floatingHelpTip.contains(target)) hideFloatingHelpTip();
});
document.addEventListener("pointerout", (event) => {
  const dot = event.target.closest?.(".help-dot[data-tip]");
  if (!dot) return;
  const to = event.relatedTarget;
  if (dot.contains(to) || floatingHelpTip?.contains(to)) return;
  /* 指针挪到同一张卡片的标题文字上不算离开（那边会重新计时再显示）。 */
  const host = dot.closest("h2, h3, summary");
  if (host && to && host.contains(to)) return;
  clearTimeout(helpShowTimer);
  hideFloatingHelpTip(dot);
});
document.addEventListener("focusin", (event) => {
  const dot = event.target.closest?.(".help-dot[data-tip]");
  if (dot) showFloatingHelpTip(dot);
});
document.addEventListener("focusout", (event) => {
  const dot = event.target.closest?.(".help-dot[data-tip]");
  if (dot) hideFloatingHelpTip(dot);
});
document.addEventListener("click", (event) => {
  const dot = event.target.closest?.(".help-dot[data-tip]");
  if (!dot) return;
  event.preventDefault();
  activeHelpDot === dot ? hideFloatingHelpTip(dot) : showFloatingHelpTip(dot);
});
window.addEventListener(
  "scroll",
  (event) => {
    /* 在说明浮层内部滚动查看长说明时，别把浮层本身收掉。 */
    if (floatingHelpTip && event.target === floatingHelpTip) return;
    hideFloatingHelpTip();
  },
  true,
);
window.addEventListener("resize", () => hideFloatingHelpTip());
function ensureInteractionUI() {
  const chartCard = $("chart")?.closest(".card");
  if (chartCard && !$("selectionStats")) {
    const stats = document.createElement("div");
    stats.id = "selectionStats";
    stats.className = "selection-stats muted";
    stats.textContent = tx(
      "拖拽图表可框选区段，显示最高、最低及涨跌幅。",
      "Drag on chart to select a period: high, low and return.",
    );
    chartCard.append(stats);
  }
  const signalCard = $("signal")?.closest("article");
  // The former short-horizon prediction is deliberately not shown: it is not
  // part of the rule signal and invited an unwarranted trading interpretation.
  $("microForecast")?.remove();
  if (signalCard) {
    const signalHeading = signalCard.querySelector("h2");
    addHelp(
      signalHeading,
      `<b>综合信号状态说明</b><br><br>` +
      `<b style="color:#00d4aa">● 做多 +分数</b> / <b style="color:#ff4d6a">● 做空 +分数</b><br><b>最强信号</b> — 多周期（15m/1h）方向一致，评分已确认。<br>` +
      `✅ 可参考：按自身规则设好止损/止盈后小仓位跟进。<br>` +
      `❌ 切忌：因分数高就重仓追；信号会随新 K 线变化。<br><br>` +
      `<b style="color:#00d4aa">● 做多趋势</b> / <b style="color:#ff4d6a">● 做空趋势</b><br><b>弱确认</b> — 当前周期连续 3 根同向，但大周期未跟上。<br>` +
      `✅ 可小仓位试单，或等“+分数”最强信号再进场。<br>` +
      `❌ 切忌：此时满仓；胜率只比随机略高。<br><br>` +
      `<b style="color:#00d4aa">● 超买 · 回落风险</b> / <b style="color:#ff4d6a">● 超卖 · 反弹机会</b><br><b>短线反转预警</b>（5m/15m 观察期）— 价格短期冲过头，动能透支。<br>` +
      `✅ 若持有多单，可考虑减仓/上移止盈；空仓则等回落结束。<br>` +
      `❌ 切忌：此时追涨杀跌；“超买”不是继续涨的理由。<br><br>` +
      `<b style="color:#00d4aa">● 偏多趋势 · 待收盘</b> / <b style="color:#ff4d6a">● 偏空趋势 · 待收盘</b><br><b>趋势初显</b>（1h 及以上周期）— 方向刚算出来，还没收盘确认。<br>` +
      `✅ 等当前 K 线收盘、状态升级后再决定。<br>` +
      `❌ 切忌：在“待收盘”阶段开新仓。<br><br>` +
      `<b>● 观望 · 等待确认</b><br><b>无方向</b> — 评分在 ±45 之间，多空力量均衡。<br>` +
      `✅ 空仓等待；或只做已有持仓的保护。<br>` +
      `❌ 切忌：强行解读为做多/做空信号。<br><br>` +
      `<b style="color:var(--text-muted)">● 重新评估中</b><br><b>信号刚被清除</b> — 上一段信号触发止损或条件不再满足，需重新积累 2 根 K 线。<br>` +
      `✅ 暂停开新仓，等系统给出新状态。<br>` +
      `❌ 切忌：急着反手。<br><br>` +
      `<hr style="border-color:var(--border);margin:8px 0"><b>速查：</b>带数字 = 最强信号；超买/超卖 = 短线反转预警（5m/15m）；待收盘 = 等确认、别动手；趋势无数字 = 弱确认。<br><br>` +
      `<small>提示：信号仅基于技术指标（EMA/RSI/MACD/布林），用于辅助观察，不构成投资建议。高杠杆请格外谨慎。</small>`,
      `<b>Rule Signal States</b><br><br>` +
      `<b style="color:#00d4aa">● Long +score</b> / <b style="color:#ff4d6a">● Short +score</b><br><b>Strongest signal</b> — multi-timeframe (15m/1h) aligned and score confirmed.<br>` +
      `✅ OK: follow with small size after setting your own stop/take-profit.<br>` +
      `❌ Don't: size up just because the score is high; signals update with each candle.<br><br>` +
      `<b style="color:#00d4aa">● Long trend</b> / <b style="color:#ff4d6a">● Short trend</b><br><b>Weak confirmation</b> — 3 consecutive same-direction candles on base TF only.<br>` +
      `✅ OK: tiny probe position, or wait for a "+score" strongest signal.<br>` +
      `❌ Don't: go all-in now; edge is only slightly better than random.<br><br>` +
      `<b style="color:#00d4aa">● Overbought · pullback risk</b> / <b style="color:#ff4d6a">● Oversold · bounce chance</b><br><b>Short-term reversal alert</b> (5m/15m observation) — price has stretched too far, momentum exhausted.<br>` +
      `✅ OK: trim longs / raise take-profit; wait for pullback to finish if flat.<br>` +
      `❌ Don't: chase here; "overbought" is not a reason to keep buying.<br><br>` +
      `<b style="color:#00d4aa">● Bullish trend · close pending</b> / <b style="color:#ff4d6a">● Bearish trend · close pending</b><br><b>Trend forming</b> (1h+) — direction just appeared but candle has not closed.<br>` +
      `✅ OK: wait for the candle to close and the state to upgrade.<br>` +
      `❌ Don't: open new positions during "close pending".<br><br>` +
      `<b>● Wait · confirmation pending</b><br><b>No direction</b> — score between ±45, bulls and bears balanced.<br>` +
      `✅ OK: stay flat; only manage existing positions.<br>` +
      `❌ Don't: force a long/short interpretation.<br><br>` +
      `<b style="color:var(--text-muted)">● Re-evaluating</b><br><b>Signal cleared</b> — previous signal hit stop or conditions failed; re-accumulating 2 candles.<br>` +
      `✅ OK: pause new entries and wait for a fresh state.<br>` +
      `❌ Don't: immediately flip the other way.<br><br>` +
      `<hr style="border-color:var(--border);margin:8px 0"><b>Quick ref:</b> +score = strongest; overbought/oversold = short-term reversal alert (5m/15m); close pending = wait, don't act; trend without score = weak confirmation.<br><br>` +
      `<small>Note: signals are derived from technical indicators (EMA/RSI/MACD/Bollinger) for observational aid only, not investment advice. Use extra caution with high leverage.</small>`,
    );
  }
  syncCardHelpTips();
  document
    .querySelectorAll(".metrics .metric span")
    .forEach((x) =>
      addHelp(
        x,
        `${x.childNodes[0]?.textContent || "指标"}用于描述趋势、动量或波动；应与风险控制结合使用。`,
        `${x.childNodes[0]?.textContent || "Indicator"} describes trend, momentum or volatility; use it with risk controls.`,
      ),
    );
}
function microPrediction(m) {
  const d = state.candles,
    closes = d.map((x) => x.close),
    ret = (n) => closes.at(-1) / closes[Math.max(0, closes.length - 1 - n)] - 1,
    recent = ret(4),
    trend = (m.e20 - m.e50) / m.close,
    bias = Math.max(-0.006, Math.min(0.006, recent * 0.38 + trend * 0.62));
  const vol = Math.max(
    0.0008,
    Math.min(0.05, (m.atr / m.close) * Math.sqrt(4)),
  );
  const direction = bias >= 0 ? tx("偏多", "Bullish") : tx("偏空", "Bearish");
  const price = m.close * (1 + bias - vol * 0.18),
    one = bias / 15,
    five = bias / 3;
  const volItem = (label, mins) => {
    const w = vol * Math.sqrt(mins / 15),
      index = Math.min(100, w * 10000);
    return `<div class="vol-item"><span>${label}</span><b>${index.toFixed(2)}</b><small><i class="low">${tx("低", "Low")} ${money(m.close * (1 - w))}</i><i class="high">${tx("高", "High")} ${money(m.close * (1 + w))}</i></small></div>`;
  };
  const out = $("microForecast");
  if (!out) return;
  out.innerHTML = `<div class="micro-head"><h3>${tx("短线机器预测", "Short-horizon model")}</h3><span>${tx("仅为研究估计", "Research estimate only")}</span></div><div class="micro-direction"><b class="${bias >= 0 ? "bull" : "bear"}">${direction}</b><span>${tx("建议观察买入价", "Suggested observation entry")} <strong>${money(price)}</strong></span><small>${tx("下一分钟", "Next 1m")} ${pct(one * 100)} · ${tx("下一五分钟", "Next 5m")} ${pct(five * 100)}</small></div><div class="vol-grid">${volItem(tx("5分震荡", "5m volatility"), 5)}${volItem(tx("10分震荡", "10m volatility"), 10)}${volItem(tx("30分震荡", "30m volatility"), 30)}${volItem(tx("1时震荡", "1h volatility"), 60)}</div>`;
}
renderAnalysis = function () {
  const m = metrics(state.candles),
    [label, cls] = classification(m.score),
    dir = m.score >= 0 ? tx("做多", "Long") : tx("做空", "Short"),
    strength = Math.min(100, Math.abs(m.score));
  $("signal").textContent =
    `${uiLang === "zh" ? label : cls === "bull" ? "Bullish" : cls === "bear" ? "Bearish" : "Neutral"} ${m.score > 0 ? "+" : ""}${m.score.toFixed(2)}`;
  $("signal").className = `signal ${cls}`;
  $("signalReason").innerHTML =
    `<span>EMA20 ${money(m.e20)} · EMA50 ${money(m.e50)} · RSI(14) ${m.rsi.toFixed(2)} · MACD ${m.macd.toFixed(2)}</span><div class="signal-gauge"><div class="gauge-top"><b>${tx("做空", "Short")} −100.00</b><span>${tx("当前", "Now")}：${dir} ${m.score > 0 ? "+" : ""}${m.score.toFixed(2)}</span><b>${tx("做多", "Long")} +100.00</b></div><div class="gauge-track"><i style="left:${(m.score + 100) / 2}%"></i></div></div><small>${tx("规则信号由当前 K 线的趋势、动量和波动计算；不等于机器学习预测。", "Rule signal is calculated from candle trend, momentum and volatility; it is not a machine-learning forecast.")}</small>`;
  const rows = [
    [
      "EMA20",
      money(m.e20),
      m.close >= m.e20 ? tx("看多", "Bullish") : tx("看空", "Bearish"),
    ],
    [
      "EMA50",
      money(m.e50),
      m.close >= m.e50 ? tx("看多", "Bullish") : tx("看空", "Bearish"),
    ],
    [
      "EMA200",
      money(m.e200),
      Number.isFinite(m.e200) && m.close >= m.e200
        ? tx("看多", "Bullish")
        : tx("中性", "Neutral"),
    ],
    [
      "RSI(14)",
      m.rsi.toFixed(2),
      m.rsi > 55
        ? tx("看多", "Bullish")
        : m.rsi < 45
          ? tx("看空", "Bearish")
          : tx("中性", "Neutral"),
    ],
    [
      tx("布林位置", "Bollinger position"),
      (m.bb * 100).toFixed(2) + "%",
      m.bb > 0.6
        ? tx("看多", "Bullish")
        : m.bb < 0.4
          ? tx("看空", "Bearish")
          : tx("中性", "Neutral"),
    ],
    ["ATR(14)", money(m.atr), tx("中性", "Neutral")],
  ];
  // 重构后统一交给富集基座渲染（含中性指标折叠 / 研究结论 / 市场微观结构增强）
  renderExpandedIndicatorDetails(m);
  const tags = [
    [tx("5分", "5m"), 20],
    [tx("15分", "15m"), 60],
    [tx("1时", "1h"), 240],
    [tx("4时", "4h"), 960],
    [tx("1日", "1d"), Math.min(1439, state.candles.length - 1)],
  ]
    .map(([label, n]) => {
      const start =
          state.candles[Math.max(0, state.candles.length - 1 - n)].close,
        v = (m.close / start - 1) * 100;
      return `<span><small>${label}</small><b class="${v >= 0 ? "bull" : "bear"}">${pct(v)}</b></span>`;
    })
    .join("");
  if ($("changeTags")) $("changeTags").innerHTML = tags;
  ensureInteractionUI();
  microPrediction(m);
  renderLeverageGuard(m);
  draw();
};
renderTicker = function () {
  const t = state.ticker;
  if (!t) return;
  const priceEl = $("price"),
    changeEl = $("change"),
    up = t.last >= t.open24h,
    delta = t.last - t.open24h,
    pulse =
      previousTickerPrice === null
        ? up
          ? "price-up"
          : "price-down"
        : t.last >= previousTickerPrice
          ? "price-up"
          : "price-down";
  priceEl.textContent = money(t.last);
  changeEl.innerHTML = `<span class="change-amount">${delta >= 0 ? "+" : "−"}$${Math.abs(delta).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span><span class="change-pct">${pct(t.changePct)}</span><span class="price-market-meta"><small id="priceTime">${tx("实时", "Live")} ${pointTime(Date.now())}</small></span>`;
  changeEl.className = up ? "bull" : "bear";
  [priceEl, changeEl].forEach((el) => {
    el.classList.remove("price-up", "price-down");
    void el.offsetWidth;
    el.classList.add(pulse);
  });
  previousTickerPrice = t.last;
  const compactOpen24 = $("open24"),
    compactHighLow = $("highlow"),
    compactSource = $("sourceUsed");
  if (compactOpen24) compactOpen24.textContent = money(t.open24h);
  if (compactHighLow) compactHighLow.textContent = `${money(t.high24)} / ${money(t.low24)}`;
  if (compactSource) compactSource.textContent = state.lastGood.source;
};
loadCurrent = async function () {
  if (state.loading) {
    state.reloadQueued = true;
    return false;
  }
  state.loading = true;
  const requestKey = `${state.interval}:${state.limit}:${state.source}`;
  buttons();
  const started = performance.now();
  $("connection").textContent = tx("正在刷新行情…", "Refreshing market…");
  $("chartError").hidden = true;
  try {
    const q = new URLSearchParams({
      interval: state.interval,
      limit: state.limit,
    });
    if (state.source) q.set("source", state.source);
    const r = await apiFetch("/api/market?" + q, 12_000);
    const data = await r.json();
    if (!r.ok) throw data;
    if (requestKey !== `${state.interval}:${state.limit}:${state.source}`) {
      state.reloadQueued = true;
      return false;
    }
    requestLatency = Math.round(performance.now() - started);
    state.candles = data.candles;
    state.marketMeta = {
      synthetic: Boolean(data.synthetic),
      syntheticIntervalMs: Number(data.syntheticIntervalMs) || null,
    };
    state.lastGood = data;
    state.ticker = data.ticker;
    // 双保险：整体替换蜡烛后用实时价锚定最后一根「正在形成」的蜡烛，消除 2s 周期 loadCurrent
    // 把实时长阳线打回快照造成的抖动。服务端已让快照自带 live close，此为冗余防线。
    if (state.ticker?.last && state.candles.length) {
      const last = state.candles[state.candles.length - 1];
      const intervalMs = (intervalMinutes[state.interval] || 0) * 60 * 1000;
      if (intervalMs && Date.now() - last.time < intervalMs) {
        last.close = state.ticker.last;
        if (state.ticker.last > last.high) last.high = state.ticker.last;
        if (state.ticker.last < last.low) last.low = state.ticker.last;
      }
    }
    renderTicker();
    renderAnalysis();
    diagnostics(data);
    $("coverage").textContent =
      `${tx("图表覆盖", "Chart coverage")}：${time(data.candles[0].time)} ${tx("至", "to")} ${time(data.candles.at(-1).time)} · ${data.candles.length} ${tx("根", "candles")} · ${tx("仅此范围参与回测", "only this range is used in backtest")}`;
    const age = Number.isFinite(data.cacheAgeMs)
        ? Math.round(data.cacheAgeMs / 1000)
        : null,
      mode = data.stale
        ? tx(
            `OKX 缓存 · ${age ?? "--"} 秒前更新`,
            `OKX cache · ${age ?? "--"}s old`,
          )
        : data.cached
          ? tx("缓存行情", "Cached market")
          : tx("实时行情", "Live market");
    $("connection").textContent =
      `${mode} · ${requestLatency} ms · ${tx("K线/指标每10秒更新；价格每秒刷新", "Candles/indicators every 10s; quote every second")}`;
    $("freshness").textContent = pointTime(data.fetchedAt);
    try {
      if (typeof window.saveMarketSnapshot === "function")
        window.saveMarketSnapshot(data);
    } catch {}
    document.documentElement.classList.remove("pre-boot");
    return true;
  } catch (e) {
    $("connection").textContent = tx(
      "行情暂不可用，保留最近成功图表",
      "Market unavailable; keeping the last successful chart",
    );
    document.documentElement.classList.remove("pre-boot");
    if (!state.candles.length) {
      $("chartError").hidden = false;
      $("chartError").textContent =
        `${tx("无法获取数据。", "Could not fetch data. ")}${e.error || ""}`;
    }
    $("diagnostics").textContent = JSON.stringify(e.failures || e, null, 2);
    return false;
  } finally {
    state.loading = false;
    if (state.reloadQueued) {
      state.reloadQueued = false;
      queueMicrotask(() => loadCurrent());
    }
  }
};
buttons = function () {
  const iLabel = tx("K 线周期", "Candle interval"),
    rLabel = tx("查看范围", "Visible range");
  $("intervals").innerHTML =
    `<span class="control-label">${iLabel}</span>` +
    intervals
      .map(
        ([v, n]) =>
          `<button data-i="${v}" class="${state.range === null && state.interval === v ? "active" : ""}">${uiLang === "zh" ? n : v.replace("m", "m").replace("h", "h").replace("d", "D")}</button>`,
      )
      .join("");
  $("ranges").innerHTML =
    `<span class="control-label">${rLabel}</span>` +
    Object.keys(ranges)
      .map(
        (x) =>
          `<button data-r="${x}" class="${state.range === x ? "active" : ""}">${x}</button>`,
      )
      .join("");
  document.querySelectorAll("[data-i]").forEach(
    (b) =>
      (b.onclick = () => {
        state.interval = b.dataset.i;
        state.limit = 300;
        state.range = null;
        clearChartSelection();
        loadCurrent();
      }),
  );
  document.querySelectorAll("[data-r]").forEach(
    (b) =>
      (b.onclick = () => {
        const [i, l] = ranges[b.dataset.r];
        state.interval = i;
        state.limit = l;
        state.range = b.dataset.r;
        clearChartSelection();
        loadCurrent();
      }),
  );
};
applyLanguage = function () {
  const x = locale();
  document.documentElement.lang = uiLang === "zh" ? "zh-CN" : "en";
  document.title = x.title;
  document.querySelector("header h1").textContent = x.title;
  // 徽标交由 updateHeaderLatency() 统一渲染，反映实时连接模式（直连/流/REST 降级），
  // 不再写死「REST 轮询」，否则切换语言会把直连态徽标覆盖掉。
  // 用 queueMicrotask 延后到模块初始化完成后执行：避免循环依赖下 requestLatency
  // 仍在 TDZ 时同步调用 updateHeaderLatency() 抛错。
  queueMicrotask(updateHeaderLatency);
  document.querySelector(".controls label").dataset.label = x.source;
  const f = document.querySelector(".forecast-card h2");
  if (f) f.textContent = x.forecast;
  const c = document.querySelector(".fed-corr-panel h3");
  if (c) c.textContent = x.correlation;
  const rb = $("refreshForecast");
  if (rb) rb.textContent = tx("训练并更新", "Train & update");
  const rc = $("refreshCorrelation");
  if (rc) rc.textContent = tx("更新分析", "Update analysis");
  const lr = $("loadResonance");
  if (lr)
    lr.textContent = $("resonance")?.querySelector(".res-chip")
      ? tx("重新计算共振", "Recalculate resonance")
      : tx("计算共振", "Calculate resonance");
  const l = $("leverageExchange")?.closest("label");
  if (l) l.firstChild.textContent = tx("交易所 ", "Exchange ");
  const lc = document.querySelector(".leverage-card h2");
  if (lc)
    lc.textContent = tx(
      "高杠杆强平缓冲参考",
      "High-leverage liquidation buffer",
    );
  const leverageSummary = document.querySelector("#leverageDetails > summary");
  if (leverageSummary)
    leverageSummary.textContent = tx(
      "高杠杆强平缓冲参考",
      "High-leverage liquidation buffer",
    );
  const b = $("langToggle");
  if (b) b.textContent = uiLang === "zh" ? "EN" : "中文";
  const apiC = $("apiCenterToggle");
  if (apiC) apiC.textContent = tx("API 接入中心", "API Center");
  applyTheme();
  buttons();
  if (state.candles.length) renderAnalysis();
  updateClocks();
};
function draw() { if (chartPaused) return; renderChart(); }
(() => {
  const cv = $("chart");
  /* 框选与十字线、悬浮卡共用同一套「光标 X → K 线索引」换算（chartIndexFromClientX），
     三者对同一位置必须给出同一根 K 线。 */
  const index = (e) =>
    chartIndexFromClientX(
      cv.getBoundingClientRect(),
      e.clientX,
      visibleCandles().length,
    );
  const stats = () => {
    if (!chartSelection) return;
    const d = visibleCandles(),
      a = Math.min(chartSelection.start, chartSelection.end),
      b = Math.max(chartSelection.start, chartSelection.end),
      s = d.slice(a, b + 1),
      hi = maxOf(s.map((v) => v.high)),
      lo = minOf(s.map((v) => v.low)),
      change = (s.at(-1).close / s[0].open - 1) * 100;
    const el = $("selectionStats");
    if (el)
      el.innerHTML = `<b>${tx("已选区段", "Selected")}</b> ${pointTime(s[0].time)} — ${pointTime(s.at(-1).time)} · <span class="high">${tx("最高", "High")} ${money(hi)}</span> · <span class="low">${tx("最低", "Low")} ${money(lo)}</span> · ${selectionSpreadHtml(hi, lo, change)} · <span class="${change >= 0 ? "bull" : "bear"}">${tx("涨跌", "Return")} ${pct(change)}</span>`;
  };
  cv.addEventListener("pointerdown", (e) => {
    /* 价格标签优先于框选：点在某个价格数字上只把它点亮（再点一次收回），不启动框选；
       已经点亮时点空白处，先把点亮收回、这一次点击也不落到框选上 ——
       用户要的是「点一下把数字收回去」，不该顺手再画出一段选区。 */
    const chip = priceChipHitTest(e, cv);
    if (chip >= 0) {
      priceChipPinned = priceChipPinned === chip ? -1 : chip;
      draw();
      return;
    }
    if (priceChipPinned >= 0) {
      priceChipPinned = -1;
      draw();
      return;
    }
    chartSelection = { start: index(e), end: index(e) };
    cv.setPointerCapture(e.pointerId);
    stats();
    draw();
  });
  cv.addEventListener("pointermove", (e) => {
    /* 悬停在价格数字上给出手型光标，提示这里可以点。 */
    if (!cv.hasPointerCapture(e.pointerId))
      cv.style.cursor = priceChipHitTest(e, cv) >= 0 ? "pointer" : "";
    if (!chartSelection || !cv.hasPointerCapture(e.pointerId)) return;
    chartSelection.end = index(e);
    stats();
    draw();
  });
  cv.addEventListener("pointerup", (e) => {
    if (cv.hasPointerCapture(e.pointerId))
      cv.releasePointerCapture(e.pointerId);
    stats();
  });
  /* 双击 = 显式清除框选：状态、浮层、底部提示一起收敛（均由 clearChartSelection 处理）。 */
  cv.addEventListener("dblclick", () => {
    clearChartSelection();
    drawLive();
  });
})();
ensureInteractionUI();
applyLanguage();

const applyLanguageBase = applyLanguage;
applyLanguage = function () {
  applyLanguageBase();
  const zh = uiLang === "zh",
    set = (selector, cn, en) => {
      const el = document.querySelector(selector);
      if (el) el.textContent = zh ? cn : en;
    };
  set(".optional h2", "多周期共振", "Multi-timeframe resonance");
  /* 卡片上不再挂副标题（那行说明已并进「!」里），所以这里也不再需要写 `.optional p`
     —— 留着的话，哪次渲染再插进一个 p 就会被塞上这句。 */
  /* 每次切语言都重写一遍卡片说明（含 cadence 基准），否则切到英文后
     说明仍是中文 —— 说明是整段 HTML，不归 data-zh/data-en 那套静态替换管。 */
  syncCardHelpTips();
  const diagnosticsTitle = $("diagnostics")
    ?.closest(".card")
    ?.querySelector("h2");
  if (diagnosticsTitle)
    diagnosticsTitle.textContent = zh ? "数据诊断" : "Data diagnostics";
  set(".change-card h2", "周期涨幅", "Period returns");
  if ($("forecastGrid")?.children.length) loadForecasts();
  if ($("correlationOutput")?.children.length) loadCorrelation();
};
applyLanguage();

/* Reuse the directional-estimate DOM during live polling.  Recreating this
   card used to briefly remove the validation line and shift every card below. */
function projectionValidationData() {
  const d = state.candles;
  if (d.length < 60) return null;
  const minutes =
      {
        "1m": 1,
        "5m": 5,
        "15m": 15,
        "30m": 30,
        "1h": 60,
        "2h": 120,
        "4h": 240,
        "1d": 1440,
      }[state.interval] || 15,
    current = metrics(d),
    targetMinutes =
      Math.abs(current.score) >= 75
        ? 60
        : Math.abs(current.score) >= 50
          ? 40
          : 20,
    horizon = Math.max(1, Math.round(targetMinutes / minutes)),
    start = Math.max(50, d.length - 121),
    end = d.length - horizon;
  let hit = 0,
    total = 0;
  for (let i = start; i < end; i++) {
    const predicted = metrics(d.slice(0, i + 1)).score >= 0,
      actual = d[i + horizon].close >= d[i].close;
    hit += predicted === actual ? 1 : 0;
    total++;
  }
  return { targetMinutes, accuracy: total ? (hit / total) * 100 : 0, total };
}
updateSignalProjectionValidation = function () {
  const box = $("signalProjection"),
    data = projectionValidationData();
  if (!box || !data) return;
  const prefix = box.querySelector("[data-projection-validation]"),
    value = box.querySelector("[data-projection-accuracy]"),
    suffix = box.querySelector("[data-projection-validation-suffix]");
  if (!prefix || !value || !suffix) return;
  prefix.textContent = tx(
    `按当前 ATR 波动与规则信号强度推算；预计方向在约 ${data.targetMinutes} 分钟的滚动历史准确度`,
    `Derived from current ATR and rule strength; direction is tested over about ${data.targetMinutes} minutes of rolling historical validation`,
  );
  value.textContent = ` ${data.accuracy.toFixed(2)}%`;
  suffix.textContent = tx(
    ` · n=${data.total}。目标价本身不保证到达。`,
    ` · n=${data.total}; the target itself is not guaranteed.`,
  );
};
renderSignalProjection = function () {
  const signal = $("signal"),
    reason = $("signalReason"),
    m = state.candles.length ? metrics(state.candles) : null;
  if (!signal || !reason || !m) return;
  let box = $("signalProjection");
  if (!box) {
    box = document.createElement("section");
    box.id = "signalProjection";
    box.className = "signal-projection";
    box.innerHTML =
      '<span data-projection-heading></span><div><b data-projection-direction></b><em data-projection-duration></em><strong><span data-projection-target-label></span> <b data-projection-target-value></b> <button class="help-dot" type="button" data-projection-tip aria-label="Target price explanation">!</button></strong></div><small><span data-projection-validation></span><b data-projection-accuracy></b><span data-projection-validation-suffix></span></small>';
    reason.after(box);
  }
  const long = m.score >= 0,
    strength = Math.abs(m.score),
    last = state.ticker?.last || m.close,
    move = m.atr * (1.05 + Math.min(1.25, strength / 100)),
    target = last + (long ? move : -move),
    duration =
      strength >= 75
        ? tx("约 45–90 分钟", "about 45–90 min")
        : strength >= 50
          ? tx("约 20–60 分钟", "about 20–60 min")
          : tx("约 10–30 分钟", "about 10–30 min"),
    tip = long
      ? tx(
          "预计目标价表示：按当前“做多”方向与上方预计持续时长，推测价格可能上涨到的研究目标位；不是保证到达或成交的价格。",
          "Estimated target: a research level the price may rise to during the projected long duration; not a guaranteed fill or outcome.",
        )
      : tx(
          "预计目标价表示：按当前“做空”方向与上方预计持续时长，推测价格可能下跌到的研究目标位；不是保证到达或成交的价格。",
          "Estimated target: a research level the price may fall to during the projected short duration; not a guaranteed fill or outcome.",
        );
  box.className = `signal-projection ${long ? "bull" : "bear"}`;
  box.querySelector("[data-projection-heading]").textContent = tx(
    "方向研究估算",
    "Directional research estimate",
  );
  box.querySelector("[data-projection-direction]").textContent = long
    ? tx("做多", "Long")
    : tx("做空", "Short");
  box.querySelector("[data-projection-duration]").textContent =
    `${tx("预计持续", "Estimated duration")} ${duration}`;
  box.querySelector("[data-projection-target-label]").textContent = tx(
    "预计目标价",
    "Estimated target",
  );
  box.querySelector("[data-projection-target-value]").textContent =
    money(target);
  const tipButton = box.querySelector("[data-projection-tip]");
  tipButton.dataset.tip = tip;
  tipButton.setAttribute(
    "aria-label",
    tx("预计目标价说明", "Target price explanation"),
  );
  updateSignalProjectionValidation();
};

/* The forecast grid belongs directly below the chart on wide displays, using
   the otherwise empty left column while the indicator stack remains visible. */
setTimeout(() => {
  const chartCard = $("mainChartCard"),
    forecast = document.querySelector("main > .forecast-card");
  if (chartCard && forecast && !chartCard.contains(forecast))
    chartCard.append(forecast);
}, 0);

/* Keep the compact multi-period resonance beside the indicator list so the
   two desktop columns finish at a similar height. */
setTimeout(() => {
  const side = document.querySelector(".terminal-layout .side-stack"),
    resonanceCard = document.querySelector("main > .optional");
  if (side && resonanceCard && !side.contains(resonanceCard))
    side.append(resonanceCard);
}, 0);

/* Keep resonance as its original full-width section.  The right column uses
   the indicator card itself to balance the height of the chart column. */
setTimeout(() => {
  const layout = document.querySelector(".terminal-layout"),
    side = layout?.querySelector(".side-stack"),
    resonanceCard = side?.querySelector(".optional");
  if (layout && resonanceCard) layout.after(resonanceCard);
}, 0);

/* 上面三步定完「多周期共振」的原生位置后，再让尾部平衡器接管：
   右列比左列高时才动手，把余量消化在左列内部（详见 syncTailBalance）。
   ?notail=1 可临时关掉，用于对照排查布局出处。 */
setTimeout(() => {
  if (!/[?&]notail=1/.test(location.search)) initTailBalance();
}, 1200);

/* Keep the short-side risk columns in the same reading order as the long side:
   theoretical liquidation first, then the buffered warning price. */
renderLeverageGuard = function (m) {
  const out = $("leverageGrid");
  if (!out) return;
  const exchange = {
      binance: { name: "Binance USDⓈ-M", mmr: 0.004 },
      okx: { name: tx("OKX USDT 永续", "OKX USDT perpetual"), mmr: 0.005 },
      coinbase: { name: "Coinbase Perpetuals", mmr: 0.006 },
    }[leverageExchange],
    entry = m.close,
    mmr = exchange.mmr,
    data = state.candles.slice(-60),
    swings = [];
  for (let i = 19; i < data.length; i++) {
    const w = data.slice(i - 19, i + 1);
    swings.push(
      (maxOf(w.map((x) => x.high)) - minOf(w.map((x) => x.low))) /
        data[i].close,
    );
  }
  const sorted = swings.sort((a, b) => a - b),
    p80 = sorted.length ? sorted[Math.floor((sorted.length - 1) * 0.8)] : 0,
    bufferPct = Math.max(p80 * 0.35, (m.atr / entry) * 2, 0.003),
    buffer = entry * bufferPct,
    method = $("leverageMethod");
  if (method)
    method.textContent = tx(
      `已应用 ${exchange.name} 的比较用近似参数（维持保证金 ${(mmr * 100).toFixed(2)}%）。自适应缓冲：近 ${data.length} 根 K 线的 20 根高低振幅 P80 为 ${(p80 * 100).toFixed(2)}%，取其 35% 与 2×ATR 中较大者；当前缓冲 ${(bufferPct * 100).toFixed(2)}%（${money(buffer)}）。`,
      `Using ${exchange.name} comparison parameters (maintenance margin ${(mmr * 100).toFixed(2)}%). Adaptive buffer: the P80 20-candle high/low range across the latest ${data.length} candles is ${(p80 * 100).toFixed(2)}%; the buffer uses the greater of 35% of that value and 2×ATR. Current buffer ${(bufferPct * 100).toFixed(2)}% (${money(buffer)}).`,
    );
  out.innerHTML = [10, 30, 50, 100]
    .map((lev) => {
      const long = entry * (1 - 1 / lev + mmr),
        short = entry * (1 + 1 / lev - mmr);
      return `<div class="lev-row"><b>${lev}×</b><span><small>${tx("多 · 理论强平", "Long · theoretical liq.")}</small>${money(long)}</span><span><small>${tx("多 · 缓冲警戒", "Long · buffer warning")}</small>${money(long + buffer)}</span><span><small>${tx("空 · 理论强平", "Short · theoretical liq.")}</small>${money(short)}</span><span><small>${tx("空 · 缓冲警戒", "Short · buffer warning")}</small>${money(short - buffer)}</span></div>`;
    })
    .join("");
};

const applyLanguageWithPositionSummary = applyLanguage;
applyLanguage = function () {
  applyLanguageWithPositionSummary();
  const summary = document.querySelector(".position-estimate-details summary");
  if (summary)
    summary.textContent = tx(
      "我的持仓与盈亏估算",
      "My position & PnL estimate",
    );
};
applyLanguage();

loadForecasts = async function (force = false) {
  const grid = $("forecastGrid"),
    status = $("forecastStatus");
  if (!grid) return;
  const button = $("refreshForecast");
  if (button) button.disabled = true;
  status.textContent = tx(
    force
      ? "正在强制刷新历史样本并重新训练…"
      : "正在获取训练样本并进行滚动训练…",
    force
      ? "Refreshing history and retraining…"
      : "Fetching samples and training rolling models…",
  );
  try {
    const r = await fetch(`/api/forecast-history${force ? "?refresh=1" : ""}`),
      data = await r.json();
    if (!r.ok) throw new Error(data.error || "history request failed");
    const jobs =
      uiLang === "zh"
        ? [
            ["30分", "intraday", 2],
            ["1小时", "intraday", 4],
            ["2小时", "intraday", 8],
            ["半天", "intraday", 48],
            ["1天", "intraday", 96],
            ["2天", "intraday", 192],
            ["1周", "daily", 7],
            ["半个月", "daily", 15],
            ["1个月", "daily", 30],
            ["半年", "daily", 180],
          ]
        : [
            ["30m", "intraday", 2],
            ["1h", "intraday", 4],
            ["2h", "intraday", 8],
            ["12h", "intraday", 48],
            ["1d", "intraday", 96],
            ["2d", "intraday", 192],
            ["1w", "daily", 7],
            ["15d", "daily", 15],
            ["1m", "daily", 30],
            ["6m", "daily", 180],
          ];
    grid.innerHTML = jobs
      .map(([label, key, h]) => {
        const fit = trainProbability(
          data[key].map((x) => x.close),
          h,
        );
        if (!fit)
          return `<div class="forecast-item muted"><span>${label}</span><b>${tx("样本不足", "Insufficient sample")}</b></div>`;
        const long = fit.prob * 100;
        return `<div class="forecast-item"><span>${label}</span><b class="${long >= 50 ? "bull" : "bear"}">${long.toFixed(2)}% ${tx("看多", "bullish")}</b><small>${tx("看空", "bearish")} ${(100 - long).toFixed(2)}% · ${tx("验证", "validation")} ${(fit.accuracy * 100).toFixed(2)}% · n=${fit.train}</small></div>`;
      })
      .join("");
    status.textContent = tx(
      `双模型集成 · ${data.cached ? "缓存历史样本" : "样本已刷新"} · 训练完成 ${pointTime(Date.now())} · 概率为方向条件概率，不是收益预测。`,
      `Two-model ensemble · ${data.cached ? "cached samples" : "samples refreshed"} · trained ${pointTime(Date.now())} · Directional probability, not a return forecast.`,
    );
  } catch (e) {
    status.textContent = `${tx("概率模块暂不可用", "Probability module unavailable")}：${e.message}`;
  } finally {
    if (button) button.disabled = false;
  }
};
if ($("refreshForecast")) $("refreshForecast").onclick = loadForecasts;
$("chart")?.addEventListener("mousemove", () => {
  const tip = $("chartTooltip"),
    d = visibleCandles(),
    v = d[hoverIndex];
  if (!tip || !v || !state.ticker) return;
  const delta = (v.close / v.open - 1) * 100;
  tip.innerHTML = `<b>${pointTime(v.time)}</b><span>${tx("实时价", "Live")} <strong>${money(state.ticker.last)}</strong></span><span>${tx("开", "Open")} ${money(v.open)}　${tx("高", "High")} ${money(v.high)}</span><span>${tx("低", "Low")} ${money(v.low)}　${tx("收", "Close")} ${money(v.close)}</span><span class="${delta >= 0 ? "bull" : "bear"}">${pct(delta)}　${tx("量", "Vol")} ${v.volume.toLocaleString("en-US", { maximumFractionDigits: 2 })}</span>`;
});

// 悬停时保持图表稳定；离开绘图区才清除十字线，让下一次实时刷新重绘。
// Keep a hovered chart visually stable; leaving the plotting surface clears the
// crosshair and lets the next live refresh redraw it.
let chartPaused = false;
state.frozenCandles = null;
/* Keep pan-control state independent from the chart renderer. */
let updatePanControls = () => {};
// Chart interaction must always use the active OHLC renderer.  Capturing the
// early close-line `draw` implementation here made hover/pan temporarily
// switch the visible chart back to a different renderer.
const drawLive = () => renderChart({ immediate: true });
(() => {
  const cv = $("chart"),
    card = cv?.closest(".card"),
    periods = document.querySelector(".change-card");
  if (!cv || !card) return;
  const selection = $("selectionStats");
  if (periods) {
    periods.classList.add("chart-periods");
  }
  /* 只清理“悬停”态（十字线 / 悬浮卡 / 冻结的 K 线），**绝不**清掉框选态。
     框选数据（已选区段·最高·最低·涨跌）必须在松手后留在屏幕上供阅读，
     只有显式清除（双击图表、切换周期/范围/数据源、平移）才消失。
     历史 bug：这里曾一并清空 chartSelection 并重置提示文字；而松手时
     「重大事件」浮层恰好弹在光标下 → #chart 触发 pointerleave → 选区被秒清。 */
  const clearHover = () => {
    chartPaused = false;
    state.frozenCandles = null;
    hoverIndex = null;
    const tip = $("chartTooltip");
    if (tip) tip.style.display = "none";
    drawLive();
  };
  cv.addEventListener("mouseenter", () => {
    state.frozenCandles = state.candles.slice();
    chartPaused = true;
  });
  cv.addEventListener("mousemove", () => {
    if (chartPaused) drawLive();
  });
  cv.addEventListener("pointerdown", () => {
    if (chartPaused) drawLive();
  });
  cv.addEventListener("pointermove", () => {
    if (chartPaused) drawLive();
  });
  cv.addEventListener("pointerleave", clearHover);
  cv.addEventListener("mouseleave", clearHover);
  window.addEventListener("blur", clearHover);
})();

/* 消息推送模块自 v2.10.52 起拆分到 public/notification.js（多渠道推送：总开关 /
   渠道管理 / 价格预警 / 持仓亏损联动），此处只负责注入依赖并初始化。 */
setTimeout(() => {
  window.BTCNotification?.init({
    $,
    tx,
    showAppDialog,
    getLang: () => uiLang,
    getState: () => state,
    getCoin: () => activeCoin(),
  });
}, 0);

import { initVoiceEngine } from './src/modules/voice.js?v=20261005a';

/* Final readability pass: selected-point pricing, compact global explanations, and clearer short-horizon caveats. */
const microPredictionBase = microPrediction;
microPrediction = function (m) {
  microPredictionBase(m);
  const closes = state.candles.map((x) => x.close);
  let hit = 0,
    total = 0;
  for (let i = 6; i < closes.length; i++) {
    const predicted = closes[i - 1] >= closes[i - 4],
      actual = closes[i] >= closes[i - 1];
    hit += predicted === actual ? 1 : 0;
    total++;
  }
  const accuracy = total ? (hit / total) * 100 : 0;
  const entry = document.querySelector(".micro-direction span"),
    note = document.querySelector(".micro-direction small");
  if (entry)
    entry.innerHTML = `${tx("未来 5 分钟建议观察买入价", "Suggested observation entry for next 5m")} <strong>${entry.querySelector("strong")?.textContent || "--"}</strong>`;
  if (note)
    note.innerHTML = `${tx("下一分钟", "Next 1m")} ${note.textContent.split("·")[0]?.replace(/^.*? /, "")} · ${tx("下一五分钟", "Next 5m")} ${note.textContent.split("·")[1]?.replace(/^.*? /, "")} · <b>${tx("5分钟方向历史验证", "5m directional historical validation")} ${accuracy.toFixed(2)}%</b>`;
};
function addGlobalHelp() {
  const signalCard = $("signal")?.closest("article");
  addHelp(
    signalCard?.querySelector("h2"),
    "该数值将 EMA 趋势、MACD 动量、RSI 和波动位置标准化为 −100 至 +100。正值偏多、负值偏空，绝对值越大代表规则一致性越高；不代表必然涨跌。",
    "This score combines EMA trend, MACD momentum, RSI and volatility position on a −100 to +100 scale. Positive is bullish, negative bearish; magnitude is rule agreement, not certainty.",
  );
  addHelp(
    document.querySelector(".change-card h2"),
    "显示当前价格相对于 1 分钟、5 分钟、15 分钟、1 小时、4 小时及更长窗口前收盘价的涨跌幅，用于快速比较不同观察窗口。",
    "Shows return versus 1m, 5m, 15m, 1h, 4h and longer historical closes for fast cross-window comparison.",
  );
  addHelp(
    document.querySelector(".forecast-card h2"),
    "概率模型通过历史价格特征估计未来方向。它只能提供研究线索，不能保证收益或替代仓位和风险管理。",
    "The probability model estimates future direction from historical price features. It is research context only, not a profit guarantee or a substitute for risk management.",
  );
  addHelp(
    document.querySelector(".fed-corr-panel h3"),
    "比较 BTC 与 SPY、QQQ 的滚动相关和跨市场特征，辅助识别联动环境；相关性会随时间变化。",
    "Compares rolling BTC correlations with SPY and QQQ. It helps identify market linkage; correlations vary over time.",
  );
  addHelp(
    document.querySelector(".leverage-card h2"),
    "强平和缓冲价是基于当前价格、杠杆与近期震荡的近似研究值。实际交易所以标记价格、仓位档位和保证金模式为准。",
    "Liquidation and buffer prices are research approximations based on current price, leverage and recent volatility. Actual exchange values depend on mark price, tiers and margin mode.",
  );
  document
    .querySelectorAll("#indicators .metric>span")
    .forEach((el) =>
      addHelp(
        el,
        `${el.childNodes[0]?.textContent || "该指标"}用于观察趋势、动量或波动，不应单独作为开仓依据。`,
        `${el.childNodes[0]?.textContent || "This indicator"} describes trend, momentum or volatility and should not be used as a stand-alone entry rule.`,
      ),
    );
}
/* Keep the original analysis renderer as the stable base of the decision layer. */
const renderAnalysisBase = renderAnalysis;

/* Store independent decision-panel refreshes in source order. */
const decisionRenderEnhancers = [];

/* Register a named enhancement once, without repeatedly wrapping a global function. */
function addDecisionRenderEnhancer(id, render) {
  /* A duplicate would silently render the same panel twice, so fail during development. */
  if (decisionRenderEnhancers.some((enhancer) => enhancer.id === id))
    throw new Error(`Duplicate decision render enhancer: ${id}`);
  /* Preserve registration order because some panels depend on earlier markup. */
  decisionRenderEnhancers.push({ id, render });
}

/* Render the base analysis and every registered enhancement in one predictable pass. */
function renderAnalysisComposed() {
  /* Build the original signal and indicator markup first. */
  renderAnalysisBase();
  /* Run each formerly-wrapped behavior in its established order. */
  decisionRenderEnhancers.forEach(({ render }) => render());
}

/* Use the composed entry point for every subsequent legacy caller. */
renderAnalysis = renderAnalysisComposed;

/* Attach the existing explanatory tooltips after their target markup is available. */
addDecisionRenderEnhancer("global-help", () => addGlobalHelp());
$("chart")?.addEventListener("mousemove", () => {
  const tip = $("chartTooltip"),
    v = visibleCandles()[hoverIndex];
  if (!tip || !v) return;
  const delta = (v.close / v.open - 1) * 100;
  tip.innerHTML = `<b>${pointTime(v.time)}</b><strong class="chart-point-price">${tx("选中收盘价", "Selected close")} ${money(v.close)}</strong><span>${tx("开", "Open")} ${money(v.open)}　${tx("高", "High")} ${money(v.high)}</span><span>${tx("低", "Low")} ${money(v.low)}　${tx("收", "Close")} ${money(v.close)}</span><span class="${delta >= 0 ? "bull" : "bear"}">${pct(delta)}　${tx("量", "Vol")} ${v.volume.toLocaleString("en-US", { maximumFractionDigits: 2 })}</span>`;
});
$("chart")?.addEventListener("pointerup", () => {
  if (!chartSelection) return;
  const d = visibleCandles(),
    a = Math.min(chartSelection.start, chartSelection.end),
    b = Math.max(chartSelection.start, chartSelection.end),
    s = d.slice(a, b + 1),
    hi = maxOf(s.map((v) => v.high)),
    lo = minOf(s.map((v) => v.low)),
    ret = (s.at(-1).close / s[0].open - 1) * 100,
    duration = Math.max(0, s.at(-1).time - s[0].time) / 60000,
    el = $("selectionStats");
  if (el)
    el.innerHTML = `<b>${tx("已选时间段", "Selected period")}</b> ${pointTime(s[0].time)} — ${pointTime(s.at(-1).time)} · ${s.length} ${tx("根", "candles")} / ${duration.toFixed(0)} ${tx("分钟", "min")} · <span class="high">${tx("最高", "High")} ${money(hi)}</span> · <span class="low">${tx("最低", "Low")} ${money(lo)}</span> · ${selectionSpreadHtml(hi, lo, ret)} · <span class="${ret >= 0 ? "bull" : "bear"}">${tx("涨跌幅", "Return")} ${pct(ret)}</span>`;
});
if (state.candles.length) renderAnalysis();

// 当前规则信号（旧口径）逻辑已抽到 src/modules/rule-signal.js，启动时初始化。
initRuleSignal();
/* Refresh the fixed-basis rule signal after the base signal card exists. */
addDecisionRenderEnhancer("fixed-rule-signal", () => renderFixedRuleSignal());

/* 主图渲染真实 OHLC 蜡烛（实体与上下影线），而不是只画收盘价折线。
   Main chart: render true OHLC candles (body + high/low wicks) rather than a
   close-only line.  This preserves hammer / shooting-star shapes directly in
   the price data while keeping the existing MA, range-selection and tooltip UI. */
// Monotone cubic interpolation: retain samples and never overshoot a segment.
function traceSmoothChartLine(c, values, x, y) {
  let start = 0;
  while (start < values.length) {
    while (start < values.length && !Number.isFinite(values[start])) start++;
    if (start === values.length) break;
    let end = start + 1;
    while (end < values.length && Number.isFinite(values[end])) end++;
    const points = values
      .slice(start, end)
      .map((v, i) => ({ x: x(start + i), y: y(v) }));
    const slopes = points
      .slice(1)
      .map((p, i) => (p.y - points[i].y) / (p.x - points[i].x));
    const tangents = points.map((p, i) => {
      if (i === 0) return slopes[0] || 0;
      if (i === points.length - 1) return slopes[i - 1] || 0;
      const a = slopes[i - 1],
        b = slopes[i];
      return a * b <= 0 ? 0 : (2 * a * b) / (a + b);
    });
    c.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1],
        b = points[i],
        third = (b.x - a.x) / 3;
      c.bezierCurveTo(
        a.x + third,
        a.y + third * tangents[i - 1],
        b.x - third,
        b.y - third * tangents[i],
        b.x,
        b.y,
      );
    }
    start = end;
  }
}

/* 主图绘图区几何：renderChart 与十字线 syncHoverPoint 必须共用同一套数值。
   成交量和 RSI 已经在独立画布（#chartRsi）里，主图画布只到时间轴上方，
   所以不能再沿用「扣掉副图高度」的旧公式，否则定位点会提前卡在半空。
   右侧留白 r 从 74 收为 0（价格轴不再独占画布右侧空白带），再回到与左侧相同的 18：
   K 线两端都不贴画布边，价格数字作为浮层压在绘图区右端之上，不占独立空间。 */
const CHART_PAD = { l: 18, r: 18, t: 15, b: 8 },
  CHART_TIME_AXIS_H = 28;
function chartPlotGeom(rect) {
  const cw = rect.width - CHART_PAD.l - CHART_PAD.r,
    ch = rect.height - CHART_PAD.t - CHART_PAD.b;
  return { cw, ch, priceHeight: Math.max(80, ch - CHART_TIME_AXIS_H) };
}
/* 光标 X → K 线索引：必须与 chartPlotMapper 的 x(i) 严格互逆，否则框选 / 命中位置会偏离光标。
   历史 bug（v2.12.28 修）：主图右侧留白从 74 收为 18（见上方注释）后绘图宽度变大，
   但框选这里仍按旧的「画布宽 − 92」折算 → 分母偏小、索引偏大，越靠右偏得越多
   （实测 888px 宽的图上最右端起点偏移 54px ≈ 53 根 1 分钟 K 线），
   而十字线悬浮卡走的是正确几何，于是同一位置会报出相差数分钟的时间。 */
function chartIndexFromClientX(rect, clientX, count) {
  const { cw } = chartPlotGeom(rect),
    n = Math.max(1, count - 1);
  if (!(cw > 0) || !(count > 1)) return 0;
  return Math.max(
    0,
    Math.min(
      count - 1,
      Math.round(((clientX - rect.left - CHART_PAD.l) / cw) * n),
    ),
  );
}
/* 价格标签的「点一下凸显」状态：默认 -1 表示 K 线优先（标签整体压暗），
   点中某个标签后它单独恢复不透明度并跳到最前，点空白处再收回。
   priceChipRects 每帧由绘制过程写入，供点击命中判定使用。 */
let priceChipPinned = -1,
  priceChipRects = [];
const priceChipHitTest = (event, cv) => {
  const r = cv.getBoundingClientRect(),
    px = event.clientX - r.left,
    py = event.clientY - r.top;
  return priceChipRects.findIndex(
    (b) => b && px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h,
  );
};

/* 主图每次绘制都会写入当前价格标尺。极值标签与 hover 命中判定共用这一标尺，
   标注点才会落在 K 线真实位置，而不是另一套估算出来的坐标上。 */
let chartPriceScale = null;

/* Range extrema follow the plotted series: a candle chart exposes its wick
   high/low, while a close-line chart has no wick and therefore stays on closes.
   极值跟随实际绘制的图形：K 线取影线高低，收盘线只有收盘价。
   影线在聚合周期上是守恒的（15 分线的低点必然包含内部 5 分线低点），
   所以同一段行情切换到不同周期时，读到的是同一个极值。 */
function rangeExtremeValue(v, kind) {
  const series = state.chartSeries || { candles: true, close: false };
  if (series.candles === false) return v.close;
  return kind === "high" ? v.high : v.low;
}
function rangeExtremeIndices(d) {
  let hiI = 0,
    loI = 0;
  for (let i = 1; i < d.length; i++) {
    if (rangeExtremeValue(d[i], "high") > rangeExtremeValue(d[hiI], "high"))
      hiI = i;
    if (rangeExtremeValue(d[i], "low") < rangeExtremeValue(d[loI], "low"))
      loI = i;
  }
  return { hiI, loI };
}
/* 坐标换算与主图保持一致；主图还没画过时退回独立的范围估算。 */
function chartPlotMapper(rect, d) {
  const n = Math.max(1, d.length - 1),
    { cw, priceHeight } = chartPlotGeom(rect);
  let lo,
    hi;
  if (chartPriceScale) ({ lo, hi } = chartPriceScale);
  else {
    const values = d.flatMap((v) => [v.low, v.high]),
      closes = d.map((v) => v.close);
    [ema(closes, 20), ema(closes, 50), ema(closes, 200)].forEach((a) =>
      a.forEach((v) => {
        if (Number.isFinite(v)) values.push(v);
      }),
    );
    lo = minOf(values);
    hi = maxOf(values);
    const pad = (hi - lo || 1) * 0.075;
    lo -= pad;
    hi += pad;
  }
  return {
    cw,
    priceHeight,
    x: (i) => CHART_PAD.l + (i / n) * cw,
    y: (v) =>
      CHART_PAD.t + priceHeight - ((v - lo) / (hi - lo || 1)) * priceHeight,
  };
}

/* 买入/卖出气球标记的数据源：欧易同步扩展（tools/okx-position-filler）在填卡的
   同时把每笔仓的开仓时间按「方向@开仓均价」指纹存进 localStorage["okxFiller:openedAt"]
   （rec.at 为毫秒；精度四级：成交明细秒级 > K 线反查 > 首次同步 > 手动）。
   匹配顺序：精确指纹命中 → 同方向、价差 ≤0.2% 里取最近的一条（防两侧数字格式抖动）。
   找不到（没装扩展 / 没同步过 / 用户改过方向）返回 null —— 没有时间锚点就不画气球。 */
function personalEntryOpenedAt(side, price) {
  let map = null;
  try {
    map = JSON.parse(localStorage.getItem("okxFiller:openedAt") || "{}");
  } catch {
    return null;
  }
  if (!map || typeof map !== "object") return null;
  const hit = map[side + "@" + price];
  if (hit && Number(hit.at) > 0) return Number(hit.at);
  let best = null,
    bestGap = Infinity;
  for (const [key, rec] of Object.entries(map)) {
    if (!key.startsWith(side + "@")) continue;
    const at = Number(rec?.at);
    if (!(at > 0)) continue;
    const p = Number(key.slice(side.length + 1));
    if (!(p > 0)) continue;
    const gap = Math.abs(p - price) / price;
    if (gap <= 0.002 && gap < bestGap) {
      bestGap = gap;
      best = at;
    }
  }
  return best;
}

function drawCandlestickChart() {
  const cv = $("chart"),
    rect = cv?.getBoundingClientRect(),
    d = visibleCandles();
  if (!cv || !rect || d.length < 2) return;
  const dpr = devicePixelRatio || 1,
    w = rect.width,
    h = rect.height;
  // 仅在画布像素尺寸真正变化时才重设 width/height：赋值会清空画布并强制重排，hover 时尺寸不变却反复重设是卡顿/闪烁的主因。
  // Only resize the backing store when the pixel size actually changes; assigning width clears the canvas and forces a reflow, the main cause of hover jank.
  const nextW = Math.round(w * dpr), nextH = Math.round(h * dpr);
  if (cv.width !== nextW) cv.width = nextW;
  if (cv.height !== nextH) cv.height = nextH;
  const     c = cv.getContext("2d"),
    P = CHART_PAD,
    cw = w - P.l - P.r,
    ch = h - P.t - P.b,
    timeAxisH = CHART_TIME_AXIS_H,
    priceHeight = Math.max(80, ch - timeAxisH);
  const closes = d.map((v) => v.close),
    ma20 = ema(closes, 20),
    ma50 = ema(closes, 50),
    ma200 = ema(closes, 200);
  /* 布林带：SMA20 中轨，±2σ 上下轨。 */
  const bollPeriod = 20,
    bollK = 2,
    basisArr = sma(closes, bollPeriod),
    upperArr = [],
    lowerArr = [];
  for (let bi = 0; bi < closes.length; bi++) {
    const s = Math.max(0, bi - bollPeriod + 1),
      slice = closes.slice(s, bi + 1),
      mean = slice.reduce((a, v) => a + v, 0) / slice.length,
      variance = slice.reduce((a, v) => a + (v - mean) ** 2, 0) / slice.length,
      sd = Math.sqrt(variance);
    upperArr.push(mean + bollK * sd);
    lowerArr.push(mean - bollK * sd);
  }
  /* 日内 VWAP：按每根 K 线所属 UTC 日累计的典型价加权均价，跨日重置。 */
  const sessionVwapArr = [],
    vwapDayMs = 86_400_000;
  let vwapDay = -1,
    cumPV = 0,
    cumVol = 0;
  for (const c of d) {
    const day = Math.floor(c.time / vwapDayMs) * vwapDayMs;
    if (day !== vwapDay) {
      vwapDay = day;
      cumPV = 0;
      cumVol = 0;
    }
    const typical = (c.high + c.low + c.close) / 3;
    cumPV += typical * c.volume;
    cumVol += c.volume;
    sessionVwapArr.push(cumVol ? cumPV / cumVol : NaN);
  }
  const entryLevels = (window.btcPersonalEntries || [])
    .filter(
      (entry) =>
        Number.isFinite(Number(entry?.price)) && Number(entry.price) > 0,
    )
    .map((entry) => ({
      price: Number(entry.price),
      side: entry.side === "short" ? "short" : "long",
    }));
  const values = d.flatMap((v) => [v.low, v.high]);
  [ma20, ma50, ma200, upperArr, lowerArr].forEach((a) =>
    a.forEach((v) => {
      if (Number.isFinite(v)) values.push(v);
    }),
  );
  const marketLow = minOf(values),
    marketHigh = maxOf(values),
    marketSpan = marketHigh - marketLow || 1;
  // An entry well outside the current market structure is an annotation, not
  // chart data. Keeping it out of the scale preserves readable candles.
  const entryLevelsWithPlacement = entryLevels.map((entry) => ({
    ...entry,
    placement:
      entry.price > marketHigh + marketSpan * 0.25
        ? "top"
        : entry.price < marketLow - marketSpan * 0.25
          ? "bottom"
          : "inside",
  }));
  /* 理论强评价线：只有持仓填入了可推算强平价的数据（保证金/持仓量+杠杆）才显示。
     计算口径与 voice 模块的 theoreticalLiquidation 保持一致。 */
  const liqLevelsWithPlacement = (window.btcPersonalEntries || [])
    .filter(
      (entry) =>
        Number.isFinite(Number(entry?.price)) && Number(entry.price) > 0,
    )
    .map((entry) => {
      const price = Number(entry.price),
        amount = Number(entry.amount),
        margin = Number(entry.margin),
        leverage = Number(entry.leverage),
        collateral =
          Number.isFinite(margin) && margin > 0
            ? margin
            : Number.isFinite(amount) && amount > 0 && leverage > 0
              ? amount / leverage
              : null,
        effectiveLeverage =
          Number.isFinite(amount) && amount > 0 && collateral
            ? amount / collateral
            : null;
      if (!Number.isFinite(effectiveLeverage) || effectiveLeverage <= 0)
        return null;
      const side = entry.side === "short" ? "short" : "long",
        liqPrice =
          side === "short"
            ? price * (1 + 1 / effectiveLeverage - 0.005)
            : price * (1 - 1 / effectiveLeverage + 0.005);
      return {
        price: liqPrice,
        side,
        placement:
          liqPrice > marketHigh + marketSpan * 0.25
            ? "top"
            : liqPrice < marketLow - marketSpan * 0.25
              ? "bottom"
              : "inside",
      };
    })
    .filter(Boolean);
  entryLevelsWithPlacement
    .filter((entry) => entry.placement === "inside")
    .forEach((entry) => values.push(entry.price));
  liqLevelsWithPlacement
    .filter((entry) => entry.placement === "inside")
    .forEach((entry) => values.push(entry.price));
  /* 买入/卖出气球（B/S）：做多=买入点（绿 B），做空=卖出开空点（红 S）。
     时间锚点 = 扩展记录的开仓时间，落在可见范围内最近的那根 K 线上；
     不参与价格缩放（values 之外），否则远价位的仓会把 K 线压扁。 */
  const markerSpacing = d.length > 1 ? d[1].time - d[0].time : 0;
  const tradeMarkers = (window.btcPersonalEntries || [])
    .map((entry) => {
      const price = Number(entry?.price);
      if (!(price > 0) || !markerSpacing) return null;
      const side = entry.side === "short" ? "short" : "long",
        at = personalEntryOpenedAt(side, price);
      if (!(at > 0)) return null;
      const idx = Math.round((at - d[0].time) / markerSpacing);
      if (idx < 0 || idx > d.length - 1) return null;
      return { side, idx };
    })
    .filter(Boolean);
  let lo = minOf(values),
    hi = maxOf(values),
    margin = (hi - lo || 1) * 0.075;
  lo -= margin;
  hi += margin;
  /* Publish the scale so the floating extrema labels land on the same pixels. */
  chartPriceScale = { lo, hi };
  const x = (i) => P.l + (i / Math.max(1, d.length - 1)) * cw,
    y = (v) => P.t + priceHeight - ((v - lo) / (hi - lo)) * priceHeight;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  c.font = "11px system-ui";
  c.lineWidth = 1;
  c.strokeStyle = "rgba(144,169,199,.14)";
  c.fillStyle = "#75849a";
  /* Y 轴价格刻度：内嵌到绘图区右缘。
     原先价格轴独占画布右侧 74px 的空白带，数字离图很远、K 线可用宽度却被压掉一截。
     现在网格线一路画到画布右边缘，价格坐在半透明圆角底片上、贴着右缘，
     既能一眼对上线，也不再吃掉横向空间（数字带底片是为了不糊住最右侧那几根 K 线）。 */
  /* Y-axis price ticks, overlaid on the plot's right edge. The grid line runs to the
     canvas edge and the value sits on a translucent rounded chip pinned there, so the
     axis no longer costs 74px of horizontal space while staying readable. */
  /* Y 轴价格刻度：内嵌到绘图区右缘。
     原先价格轴独占画布右侧 74px 的空白带，数字离图很远、K 线可用宽度却被压掉一截。
     现在网格线一路画到画布右边缘；价格数字与底片留到全部图形画完之后再落笔
     （见本函数末尾的 priceChips 段），否则会被最右侧那几根 K 线盖住。 */
  const priceLight = document.documentElement.getAttribute("data-theme") === "light",
    priceChips = [];
  for (let g = 0; g < 5; g++) {
    const yy = P.t + (g * priceHeight) / 4;
    c.beginPath();
    c.moveTo(P.l, yy);
    /* 网格线停在绘图区右边界（= 画布宽 − 18），与左端同样留出 18px；
       一路顶到画布边缘的话，会跟容器边框贴在一起，左右看着一头齐一头空。 */
    c.lineTo(P.l + cw, yy);
    c.stroke();
    priceChips.push([
      (hi - ((hi - lo) * g) / 4).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
      yy,
    ]);
  }
  const candleWidth = Math.max(2, Math.min(14, (cw / d.length) * 0.64)),
    lines = state.chartLines || { ma20: true, ma50: true, ma200: true, boll: true, vwap: true },
    series = state.chartSeries || { candles: true, close: false, volume: true, rsi: true };
  /* 成交量已合并到下方副图（RSI 副图的下半部分），主图只画价格。 */
  /* 布林带：上轨—下轨之间填充淡色，再画三条边线（中轨为虚线 SMA20）。 */
  if (lines.boll !== false) {
    c.save();
    c.beginPath();
    let started = false;
    for (let i = 0; i < d.length; i++) {
      if (!Number.isFinite(upperArr[i]) || !Number.isFinite(lowerArr[i])) continue;
      const xx = x(i);
      if (!started) {
        c.moveTo(xx, y(upperArr[i]));
        started = true;
      } else c.lineTo(xx, y(upperArr[i]));
    }
    for (let i = d.length - 1; i >= 0; i--) {
      if (!Number.isFinite(upperArr[i]) || !Number.isFinite(lowerArr[i])) continue;
      c.lineTo(x(i), y(lowerArr[i]));
    }
    c.closePath();
    c.fillStyle = "rgba(150,180,220,.07)";
    c.fill();
    const bandLine = (arr, color) => {
      c.beginPath();
      traceSmoothChartLine(c, arr, x, y);
      c.lineJoin = "round";
      c.lineCap = "round";
      c.strokeStyle = color;
      c.lineWidth = 1;
      c.stroke();
    };
    bandLine(upperArr, "rgba(124,154,196,.6)");
    bandLine(lowerArr, "rgba(124,154,196,.6)");
    c.beginPath();
    traceSmoothChartLine(c, basisArr, x, y);
    c.setLineDash([4, 3]);
    c.strokeStyle = "rgba(178,198,228,.55)";
    c.lineWidth = 1;
    c.stroke();
    c.setLineDash([]);
    c.restore();
  }
  if (series.candles)
    d.forEach((v, i) => {
      const xx = x(i),
        up = v.close >= v.open,
        color = up ? "#28c76f" : "#ef4d78",
        bodyTop = y(Math.max(v.open, v.close)),
        bodyBottom = y(Math.min(v.open, v.close)),
        bodyHeight = Math.max(1.5, bodyBottom - bodyTop);
      c.strokeStyle = color;
      c.fillStyle = color;
      c.lineWidth = 1.15;
      c.beginPath();
      c.moveTo(xx, y(v.high));
      c.lineTo(xx, y(v.low));
      c.stroke();
      c.fillRect(
        Math.round(xx - candleWidth / 2),
        bodyTop,
        Math.max(1, candleWidth),
        bodyHeight,
      );
      const full = Math.max(v.high - v.low, 0.01),
        body = Math.abs(v.close - v.open),
        upper = v.high - Math.max(v.open, v.close),
        lower = Math.min(v.open, v.close) - v.low;
      const hammer =
          lower / full > 0.52 && upper / full < 0.2 && body / full < 0.32,
        star = upper / full > 0.52 && lower / full < 0.2 && body / full < 0.32;
      if ((hammer || star) && candleWidth >= 4) {
        c.save();
        c.fillStyle = hammer ? "#55d9ff" : "#ffc35b";
        c.font = "700 10px system-ui";
        c.textAlign = "center";
        c.fillText(
          hammer ? "H" : "S",
          xx,
          hammer
            ? Math.min(P.t + priceHeight - 3, y(v.low) + 14)
            : Math.max(P.t + 10, y(v.high) - 7),
        );
        c.restore();
      }
    });
  /* 价格线：青色细线 + 收窄的深色描边，深浅主题都清晰且不压蜡烛。 */
  if (series.close) {
    c.save();
    c.beginPath();
    traceSmoothChartLine(c, closes, x, y);
    c.lineJoin = "round";
    c.lineCap = "round";
    c.strokeStyle = "rgba(10,22,42,.55)";
    c.lineWidth = 3;
    c.stroke();
    c.strokeStyle = "#00c8e0";
    c.lineWidth = 1.3;
    c.stroke();
    c.restore();
  }
  const line = (a, color, enabled) => {
    if (!enabled) return;
    c.beginPath();
    traceSmoothChartLine(c, a, x, y);
    c.lineJoin = "round";
    c.lineCap = "round";
    c.strokeStyle = color;
    c.lineWidth = 1.35;
    c.stroke();
  };
  line(ma20, "#4b9fff", lines.ma20);
  line(ma50, "#d69b2d", lines.ma50);
  line(ma200, "#a970ff", lines.ma200);
  /* 日内 VWAP：按每根 K 线所属 UTC 日累计的动态线，作为多空分水岭。 */
  if (lines.vwap !== false) {
    c.save();
    c.beginPath();
    traceSmoothChartLine(c, sessionVwapArr, x, y);
    c.lineJoin = "round";
    c.lineCap = "round";
    c.strokeStyle = "#ff5cd0";
    c.lineWidth = 1.25;
    c.setLineDash([6, 4]);
    c.stroke();
    c.setLineDash([]);
    c.restore();
  }
  /* 行号按 placement+side 分组独立计：否则另一侧贴边线会占掉行号，
     把本侧标签挤到别人的行里造成重叠。 */
  const groupRowOf = (levels) => {
    const counts = {},
      rowOf = new Map();
    levels.forEach((e) => {
      const key = `${e.placement}:${e.side}`;
      rowOf.set(e, counts[key] || 0);
      counts[key] = (counts[key] || 0) + 1;
    });
    return rowOf;
  };
  const entryRowOf = groupRowOf(entryLevelsWithPlacement),
    liqRowOf = groupRowOf(liqLevelsWithPlacement);
  /* ── 标签统一布局（买入 + 爆仓一起参与碰撞消解）──
     过去买入/爆仓两组各自独立定位、互不知情：贴顶的爆仓标签固定在
     画布顶部前几行，而「区间内」但价格靠近顶部的买入标签会跟随价格线
     落在同一纵向条带里，两组标签叠字。这里先收集所有标签的期望位置，
     再做全局碰撞消解（横向有交叠才避让；向下顺延，底部放不下向上找），
     最后先画全部参考线、再画全部标签。 */
  c.font = "700 10px ui-sans-serif,system-ui";
  const LABEL_H = 17,
    LABEL_ROW = 19,
    midPrice = (marketLow + marketHigh) / 2,
    levelDraws = [];
  entryLevelsWithPlacement.forEach((entry) => {
    const isShort = entry.side === "short",
      edgeOffset = entryRowOf.get(entry) * 20,
      yy =
        entry.placement === "top"
          ? Math.max(P.t + 9, 30) + edgeOffset
          : entry.placement === "bottom"
            ? P.t + priceHeight - 9 - edgeOffset
            : y(entry.price),
      label = `${isShort ? tx("做空买入价", "Short entry") : tx("做多买入价", "Long entry")} ${money(entry.price)}${entry.placement === "top" ? " ↑" : entry.placement === "bottom" ? " ↓" : ""}`,
      width = Math.min(c.measureText(label).width + 12, cw - 10),
      /* 买入价标签贴线的内侧：边缘线朝价格区一侧，区间内线朝当前价一侧。 */
      innerAbove =
        entry.placement === "top"
          ? false
          : entry.placement === "bottom"
            ? true
            : entry.price < midPrice;
    levelDraws.push({
      isShort,
      color: isShort ? "#ff5b7b" : "#19d3b0",
      colorBg: isShort ? "rgba(255,91,123,.18)" : "rgba(25,211,176,.18)",
      lineDash: [7, 5],
      lineWidth: 1.6,
      yy,
      label,
      width,
      labelY: innerAbove ? yy - 20 : yy + 5,
    });
  });
  liqLevelsWithPlacement.forEach((entry) => {
    const isShort = entry.side === "short",
      yy =
        entry.placement === "top"
          ? 22 + liqRowOf.get(entry) * 18
          : entry.placement === "bottom"
            ? h - 26 - liqRowOf.get(entry) * 18
            : y(entry.price),
      label = `${isShort ? tx("做空爆仓价", "Short liquidation") : tx("做多爆仓价", "Long liquidation")} ${money(entry.price)}${entry.placement === "top" ? " ↑" : entry.placement === "bottom" ? " ↓" : ""}`,
      width = Math.min(c.measureText(label).width + 12, cw - 10),
      /* 爆仓价标签贴线的外侧：与买入价标签分居线的两侧。 */
      outerAbove =
        entry.placement === "top"
          ? true
          : entry.placement === "bottom"
            ? false
            : entry.price > midPrice;
    levelDraws.push({
      isShort,
      color: isShort ? "#ff9d2b" : "#c0eb2a",
      colorBg: isShort ? "rgba(255,157,43,.18)" : "rgba(192,235,42,.16)",
      lineDash: [3, 3],
      lineWidth: 1.5,
      yy,
      label,
      width,
      labelY: outerAbove ? yy - 20 : yy + 5,
    });
  });
  /* 价格坐标一旦切到左端，会占住绘图区最左约 80px：做多线的线名往右让开这一段，
     否则两串文字会叠在一起。切回右端（或关掉坐标）时线名回到原来的贴左位置。 */
  const priceAxisLeftPad =
      state.priceAxis !== false && state.priceAxisSide === "left" ? 82 : 0,
    labelXOf = (d) =>
      d.isShort
        ? P.l + cw / 2 - d.width / 2
        : P.l + 5 + priceAxisLeftPad,
    clampLabelY = (v) =>
      Math.max(P.t + 3, Math.min(P.t + priceHeight - LABEL_H - 3, v)),
    placedRects = [],
    rectHits = (x0, y0, w0) =>
      placedRects.some(
        (r) =>
          x0 < r.x + r.w &&
          r.x < x0 + w0 &&
          y0 < r.y + LABEL_H &&
          r.y < y0 + LABEL_H,
      );
  levelDraws.forEach((d) => {
    d.labelX = labelXOf(d);
    let yv = clampLabelY(d.labelY);
    if (rectHits(d.labelX, yv, d.width)) {
      const bottomLimit = P.t + priceHeight - LABEL_H - 3;
      let probe = yv,
        found = false;
      while (probe < bottomLimit) {
        probe = Math.min(probe + LABEL_ROW, bottomLimit);
        if (!rectHits(d.labelX, probe, d.width)) {
          found = true;
          break;
        }
      }
      if (!found) {
        probe = clampLabelY(d.labelY);
        while (probe > P.t + 3) {
          probe = Math.max(probe - LABEL_ROW, P.t + 3);
          if (!rectHits(d.labelX, probe, d.width)) {
            found = true;
            break;
          }
        }
      }
      if (found) yv = probe;
    }
    placedRects.push({ x: d.labelX, y: yv, w: d.width });
    d.drawY = yv;
  });
  levelDraws.forEach((d) => {
    c.save();
    c.strokeStyle = d.color;
    c.lineWidth = d.lineWidth;
    c.setLineDash(d.lineDash);
    c.beginPath();
    c.moveTo(P.l, d.yy);
    c.lineTo(P.l + cw, d.yy);
    c.stroke();
    c.setLineDash([]);
    c.restore();
  });
  levelDraws.forEach((d) => {
    c.save();
    c.font = "700 10px ui-sans-serif,system-ui";
    c.textAlign = "left";
    c.fillStyle = d.colorBg;
    c.fillRect(d.labelX, d.drawY, d.width, LABEL_H);
    c.fillStyle = d.color;
    c.fillText(d.label, d.labelX + 6, d.drawY + 12);
    c.restore();
  });
  const highValue = (v) => v.close,
    lowValue = (v) => v.close,
    hiI = d.reduce(
      (best, v, i) => (highValue(v) > highValue(d[best]) ? i : best),
      0,
    ),
    loI = d.reduce(
      (best, v, i) => (lowValue(v) < lowValue(d[best]) ? i : best),
      0,
    );
  for (const [i, value, color] of [
    [hiI, highValue(d[hiI]), "#ffcb65"],
    [loI, lowValue(d[loI]), "#52d5f4"],
  ]) {
    const xx = x(i),
      yy = y(value);
    c.save();
    c.strokeStyle = color + "99";
    c.setLineDash([4, 4]);
    c.beginPath();
    c.moveTo(P.l, yy);
    c.lineTo(P.l + cw, yy);
    c.stroke();
    c.setLineDash([]);
    c.fillStyle = "#15202d";
    c.strokeStyle = color;
    c.lineWidth = 2;
    c.beginPath();
    c.arc(xx, yy, 5, 0, Math.PI * 2);
    c.fill();
    c.stroke();
    c.restore();
  }
  /* 买入/卖出气球：挂在锚定 K 线的影线端点外侧 —— 做多 B（绿）在下、做空 S（红）在上，
     气球圆 + 指向 K 线的小尾巴，TradingView 风格。亮主题补一圈白描边保证对比度。 */
  if (tradeMarkers.length) {
    c.save();
    c.font = "700 10px ui-sans-serif,system-ui";
    c.textAlign = "center";
    c.textBaseline = "middle";
    const markerLight =
      document.documentElement.getAttribute("data-theme") === "light";
    for (const m of tradeMarkers) {
      const v = d[m.idx],
        isLong = m.side === "long",
        dir = isLong ? 1 : -1,
        anchorY = isLong ? y(v.low) : y(v.high),
        col = isLong ? "#28c76f" : "#ef4d78",
        xx = x(m.idx),
        cy = anchorY + dir * 16;
      c.fillStyle = col;
      /* 尾巴：从影线端点指向气球圆。 */
      c.beginPath();
      c.moveTo(xx, anchorY + dir * 1);
      c.lineTo(xx - 3.2, anchorY + dir * 7.5);
      c.lineTo(xx + 3.2, anchorY + dir * 7.5);
      c.closePath();
      c.fill();
      /* 气球主体：圆心距影线端点 16px，半径 9 —— 近端刚好压住尾巴底边。 */
      c.beginPath();
      c.arc(xx, cy, 9, 0, Math.PI * 2);
      c.fill();
      if (markerLight) {
        c.strokeStyle = "rgba(255,255,255,.85)";
        c.lineWidth = 1;
        c.stroke();
      }
      c.fillStyle = "#fff";
      c.fillText(isLong ? "B" : "S", xx, cy + dir * 0.5);
    }
    c.restore();
  }
  if (chartSelection) {
    const a = Math.min(chartSelection.start, chartSelection.end),
      b = Math.max(chartSelection.start, chartSelection.end);
    c.fillStyle = "rgba(75,159,255,.13)";
    c.fillRect(x(a), P.t, x(b) - x(a), priceHeight);
    c.strokeStyle = "rgba(135,190,255,.9)";
    c.setLineDash([4, 4]);
    c.strokeRect(x(a), P.t, x(b) - x(a), priceHeight);
    c.setLineDash([]);
  }
  if (hoverPoint) {
    const xx = Math.max(P.l, Math.min(P.l + cw, hoverPoint.x)),
      yy = Math.max(P.t, Math.min(P.t + priceHeight, hoverPoint.y));
    c.save();
    c.strokeStyle = "rgba(222,237,255,.42)";
    c.setLineDash([3, 4]);
    c.beginPath();
    c.moveTo(xx, P.t);
    c.lineTo(xx, P.t + priceHeight);
    // 焦点在 RSI 子图时只画竖线贯穿主图，不画水平线与圆点。
    if (!hoverPoint.sub) {
      c.moveTo(P.l, yy);
      c.lineTo(P.l + cw, yy);
    }
    c.stroke();
    c.setLineDash([]);
    if (!hoverPoint.sub) {
      c.fillStyle = "#fff";
      c.beginPath();
      c.arc(xx, yy, 3.5, 0, Math.PI * 2);
      c.fill();
    }
    c.restore();
  }
  /* 主图右上角状态角标：布林 %b 超买、跌破日内 VWAP 转弱。 */
  const lastClose = closes.at(-1),
    lb = lowerArr.at(-1),
    ub = upperArr.at(-1),
    bbPct = Number.isFinite(lb) && Number.isFinite(ub) ? (lastClose - lb) / ((ub - lb) || 1) : NaN,
    vwapLast = sessionVwapArr.at(-1),
    badges = [];
  if (Number.isFinite(bbPct) && bbPct >= 0.83)
    badges.push([`超买 BOLL ${Math.round(bbPct * 100)}%`, "#ffb454"]);
  if (Number.isFinite(vwapLast) && lastClose < vwapLast)
    badges.push(["跌破 VWAP · 转弱", "#ff6b81"]);
  if (badges.length) {
    c.save();
    const lightTheme = document.documentElement.getAttribute("data-theme") === "light";
    c.font = "700 11px ui-sans-serif,system-ui";
    c.textAlign = "right";
    let by = P.t + 14;
    /* 右侧要给价格底片让位（约 72px 宽），角标右边缘退到它左边，免得在右上角叠在一起。
       价格坐标被切到左端或关掉时这里仍保持同样的退让量，免得角标跟着左右横跳。 */
    const chipReserve = 78;
    for (const [txt, col] of badges) {
      const tw = c.measureText(txt).width + 14,
        bxx = P.l + cw - chipReserve - tw;
      c.fillStyle = lightTheme ? "rgba(255,255,255,.82)" : "rgba(20,28,40,.78)";
      c.fillRect(bxx, by - 12, tw, 17);
      c.strokeStyle = col;
      c.lineWidth = 1;
      c.strokeRect(bxx, by - 12, tw, 17);
      c.fillStyle = lightTheme ? "#7a4a00" : col;
      c.fillText(txt, bxx + tw - 7, by);
      by += 21;
    }
    c.restore();
  }
  /* 价格数字与底片最后落笔：此时 K 线、均线、各种标注都已经画完，它们压在最上层，
     否则最右边那几根 K 线会把数字吃掉。
     贴哪一端、要不要显示，都由图表菜单里的「价格坐标」控制（默认右侧、显示）。 */
  c.save();
  c.font = "11px system-ui";
  priceChipRects = [];
  if (state.priceAxis !== false) {
    const onLeft = state.priceAxisSide === "left";
    c.textAlign = onLeft ? "left" : "right";
    priceChips.forEach(([txt, yy], idx) => {
      const bw = c.measureText(txt).width + 12,
        bx = onLeft ? P.l + 3 : P.l + cw - bw - 3,
        by = yy - 8,
        pinned = idx === priceChipPinned;
      c.globalAlpha = pinned ? 1 : 0.58;
      c.fillStyle = priceLight ? "rgba(255,255,255,.88)" : "rgba(13,22,36,.84)";
      c.beginPath();
      if (c.roundRect) c.roundRect(bx, by, bw, 16, 4);
      else c.rect(bx, by, bw, 16);
      c.fill();
      c.fillStyle = priceLight ? "#4a5b73" : "#96a8c2";
      c.fillText(txt, onLeft ? P.l + 9 : P.l + cw - 9, yy + 4);
      c.globalAlpha = 1;
      priceChipRects.push({ x: bx, y: by, w: bw, h: 16 });
    });
  }
  c.restore();

  /* X 轴时间刻度：随可见 K 线范围、缩放与周期动态调整密度/格式。 */
  c.save();
  const intervalMins = intervalMinutes[state.interval] || 1;
  const isLongTerm = intervalMins >= LONG_TERM_INTERVAL_MIN; // 4h+
  const firstDate = new Date(d[0].time),
    lastDate = new Date(d[d.length - 1].time),
    crossesCalendarDay =
      firstDate.getFullYear() !== lastDate.getFullYear() ||
      firstDate.getMonth() !== lastDate.getMonth() ||
      firstDate.getDate() !== lastDate.getDate(),
    configuredRangeMinutes = viewRanges[state.range]?.minutes || 0;
  /* “1D” 的首尾点通常只相差 23:55 或 23:45，不能用严格的 24 小时时差判断。
     选择范围达到一天，或实际数据跨了自然日时，所有时间刻度都明确带日期。 */
  const showDate =
    isLongTerm || configuredRangeMinutes >= 1_440 || crossesCalendarDay;
  const showYear =
    showDate &&
    firstDate.getFullYear() !== lastDate.getFullYear();
  const labelMinGap = showYear ? 150 : showDate ? 110 : 72;
  const maxTimeLabels = Math.max(2, Math.floor(cw / labelMinGap));
  const timeStep = Math.max(1, Math.ceil((d.length - 1) / (maxTimeLabels - 1)));
  const axisY = P.t + priceHeight + 14;
  c.strokeStyle = "rgba(144,169,199,.14)";
  c.lineWidth = 1;
  c.beginPath();
  c.moveTo(P.l, axisY);
  c.lineTo(P.l + cw, axisY);
  c.stroke();
  c.fillStyle = "#75849a";
  c.font = "11px system-ui";
  c.textBaseline = "top";
  /* 时间刻度：只落在标签所在的关键时间点上，每个位置一条竖线（像刻度尺的短线），
     不额外加密。线改用偏蓝的亮色、并且比轴线粗一档 —— 和网格线同一个色系时，
     一眼扫过去根本找不到刻度在哪儿。
     首尾两个标签改成贴边对齐 —— 居中的话第一个标签会有一半落在画布外，
     显示成「-19 22:37」这样被裁掉一截。 */
  c.strokeStyle = "rgba(126,178,238,.72)";
  c.lineWidth = 2;
  for (let i = 0; i < d.length; i += timeStep) {
    const xx = x(i),
      txt = formatTimeAxisLabel(d[i].time, showDate, showYear),
      tw = c.measureText(txt).width;
    c.beginPath();
    c.moveTo(xx, axisY - 7);
    c.lineTo(xx, axisY);
    c.stroke();
    c.textAlign = xx - tw / 2 < P.l ? "left" : xx + tw / 2 > P.l + cw ? "right" : "center";
    c.fillText(
      txt,
      c.textAlign === "left" ? P.l : c.textAlign === "right" ? P.l + cw : xx,
      axisY + 3,
    );
  }
  c.restore();
  renderRangeExtremaPoints();
  drawRsiChart();
}
const syncHoverPoint = (event) => {
  const cv = $("chart"),
    rect = cv?.getBoundingClientRect(),
    d = visibleCandles();
  if (!cv || !rect || d.length < 2) return;
  /* 钳制范围必须与 drawCandlestickChart 完全一致（共用 chartPlotGeom），
     否则十字定位点会在到达图表底部之前就卡住不动。 */
  const { cw, priceHeight } = chartPlotGeom(rect),
    rawX = event.clientX - rect.left,
    rawY = event.clientY - rect.top;
  hoverPoint = {
    x: Math.max(CHART_PAD.l, Math.min(CHART_PAD.l + cw, rawX)),
    y: Math.max(CHART_PAD.t, Math.min(CHART_PAD.t + priceHeight, rawY)),
    sub: false,
  };
  hoverIndex = Math.max(
    0,
    Math.min(
      d.length - 1,
      Math.round(((hoverPoint.x - CHART_PAD.l) / cw) * (d.length - 1)),
    ),
  );
};
$("chart")?.addEventListener("mousemove", syncHoverPoint);
$("chart")?.addEventListener("pointermove", syncHoverPoint);
$("chart")?.addEventListener("mouseleave", () => {
  hoverPoint = null;
});

/* RSI 子图聚焦状态：null=默认叠显；"volume"=成交量柱凸显；"rsi"=RSI 凸显、柱压暗后推。 */
let rsiPaneFocus = null;

function drawRsiChart() {
  const cv = $("chartRsi");
  if (!cv) return;
  const series = state.chartSeries || { rsi: true, volume: true };
  const rect = cv.getBoundingClientRect();
  const d = visibleCandles();
  if (d.length < 2) return;
  const dpr = devicePixelRatio || 1,
    w = rect.width,
    h = rect.height;
  const nextW = Math.round(w * dpr), nextH = Math.round(h * dpr);
  if (cv.width !== nextW) cv.width = nextW;
  if (cv.height !== nextH) cv.height = nextH;
  const c = cv.getContext("2d");
  /* 与主图共用左右几何（CHART_PAD）：主图把价格轴内嵌之后右留白已归零，
     副图必须跟着走同一条边界，否则右侧会空出一截、与主图对不齐。 */
  const P = { l: CHART_PAD.l, r: CHART_PAD.r, t: 8, b: 8 },
    cw = w - P.l - P.r,
    ch = h - P.t - P.b;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  const showRsi = series.rsi !== false;
  const showVolume = series.volume !== false;
  /* 同区域叠显（回归原始设计）：成交量柱铺满整个副图高度垫底，RSI 曲线叠加在上层。
     仅当可见时间跨度 > 12 小时（长周期 / 多日）才对成交量启用 0.55 次幂压缩，
     消除个别巨量柱对其他柱子的压制；短周期盯盘（如 6h/3h/1h 区间，跨度 ≤ 12h）
     保持线性缩放，对交易量的细微变化保持敏感，便于第一时间察觉异动巨量。 */
  const spanMs = Number(d[d.length - 1].time) - Number(d[0].time);
  const useVolumePower = spanMs > 12 * 3600 * 1000;
  const x = (i) => P.l + (i / Math.max(1, d.length - 1)) * cw;
  const y = (v) => P.t + (1 - v / 100) * ch;
  /* 聚焦状态（点击切换）：volume=柱凸显；rsi=RSI 凸显、柱压暗后推。 */
  const volumeFocus = showVolume && (rsiPaneFocus === "volume" || !showRsi);
  const rsiFocused = showRsi && (rsiPaneFocus === "rsi" || !showVolume);
  /* 超买(>70)/超卖(<30) 浅色背景区 + 参考线（垫在柱与线之下）。 */
  if (showRsi) {
    c.fillStyle = "rgba(239,77,120,.08)";
    c.fillRect(P.l, y(70), cw, y(100) - y(70));
    c.fillStyle = "rgba(40,199,111,.08)";
    c.fillRect(P.l, y(0), cw, y(30) - y(0));
    c.strokeStyle = "rgba(144,169,199,.2)";
    c.lineWidth = 1;
    c.setLineDash([3, 3]);
    for (const lv of [30, 50, 70]) {
      const yy = y(lv);
      c.beginPath();
      c.moveTo(P.l, yy);
      c.lineTo(P.l + cw, yy);
      c.stroke();
    }
    c.setLineDash([]);
    c.strokeStyle = "rgba(255,180,84,.45)";
    c.setLineDash([2, 3]);
    c.beginPath();
    c.moveTo(P.l, y(67));
    c.lineTo(P.l + cw, y(67));
    c.stroke();
    c.setLineDash([]);
  }
  /* 成交量柱：铺满整个副图高度（同区域叠显），红绿按 K 线涨跌着色。
     长周期时按 0.55 次幂缩放抑制巨量柱，短周期线性保留敏感度。 */
  if (showVolume) {
    const maxVolume = Math.max(1, ...d.map((v) => Number(v.volume) || 0));
    const candleWidth = Math.max(2, Math.min(14, (cw / d.length) * 0.64));
    const volAlpha = rsiFocused ? 0.1 : volumeFocus ? 0.8 : 0.34;
    const volHeight = (raw) => {
      const ratio = Math.max(0, raw) / maxVolume;
      const scaled = useVolumePower ? Math.pow(ratio, 0.55) : ratio;
      return scaled * ch * 0.94;
    };
    c.save();
    d.forEach((v, i) => {
      const height = volHeight(Number(v.volume) || 0);
      if (height < 1) return;
      c.fillStyle = v.close >= v.open ? "#28c76f" : "#ef4d78";
      c.globalAlpha = volAlpha;
      c.fillRect(
        Math.round(x(i) - candleWidth / 2),
        P.t + ch - height,
        Math.max(1, candleWidth),
        height,
      );
    });
    if (!rsiFocused && Number.isInteger(hoverIndex) && d[hoverIndex]) {
      const selected = d[hoverIndex],
        height = volHeight(Number(selected.volume) || 0);
      if (height >= 1) {
        const barWidth = Math.max(2, candleWidth + 2);
        const barX = Math.round(x(hoverIndex) - barWidth / 2);
        const barY = P.t + ch - height;
        c.fillStyle = selected.close >= selected.open ? "#28c76f" : "#ef4d78";
        c.globalAlpha = 0.95;
        c.fillRect(barX, barY, barWidth, height);
        c.globalAlpha = 1;
        c.strokeStyle = "rgba(222,237,255,.78)";
        c.lineWidth = 1;
        c.strokeRect(barX + 0.5, barY + 0.5, barWidth - 1, Math.max(1, height - 1));
      }
    }
    c.globalAlpha = 1;
    c.restore();
  }
  if (!showRsi) return;
  /* RSI 曲线（在 RSI 区域绘制；聚焦时加粗发光，柱聚焦时略退后）。
     RSI(14) 的前 14 根天然没有值 —— 需要 14 个涨跌幅做预热。若直接拿「可见范围」
     那一段收盘价去算，曲线左端就永远缺一截，而且每横向滚动一次都会重新缺一次。
     这里改成用整段 K 线算完之后再切出可见的那一段，于是只有数据最开头才缺。 */
  const allCloses = (state.frozenCandles || state.candles || []).map((v) => v.close),
    fullRsi = allCloses.length > d.length ? rsi(allCloses, 14) : null,
    closes = d.map((v) => v.close),
    rsiArr = fullRsi ? fullRsi.slice(fullRsi.length - d.length) : rsi(closes, 14),
    /* RSI 用中性白（亮色主题用石板灰）：与红绿成交量柱、各指标线色差都最大。 */
    rsiColor =
      document.documentElement.getAttribute("data-theme") === "light"
        ? "#64748b"
        : "#f4f8ff";
  c.save();
  if (rsiFocused) {
    c.shadowColor = rsiColor;
    c.shadowBlur = 9;
    c.lineWidth = 2.1;
  } else if (volumeFocus) {
    c.globalAlpha = 0.75;
    c.lineWidth = 1.1;
  } else {
    c.lineWidth = 1.3;
  }
  c.beginPath();
  traceSmoothChartLine(c, rsiArr, x, y);
  c.lineJoin = "round";
  c.lineCap = "round";
  c.strokeStyle = rsiColor;
  c.stroke();
  c.restore();
  /* 标题与最新值。 */
  c.fillStyle = "#75849a";
  c.font = "11px system-ui";
  c.textAlign = "left";
  c.fillText(tx("RSI(14)", "RSI(14)"), P.l, P.t + 10);
  /* 聚焦状态提示（紧跟标题）。 */
  if (rsiPaneFocus === "volume" && showVolume) {
    c.font = "10px system-ui";
    c.fillStyle = "#28c76f";
    c.fillText(tx("· 成交量聚焦", "· Volume focus"), P.l + 52, P.t + 10);
  } else if (rsiPaneFocus === "rsi" && showRsi) {
    c.font = "10px system-ui";
    c.fillStyle = rsiColor;
    c.fillText(tx("· RSI 聚焦", "· RSI focus"), P.l + 52, P.t + 10);
  }
  const last = rsiArr.at(-1);
  if (Number.isFinite(last)) {
    c.textAlign = "right";
    c.font = "700 11px system-ui";
    c.fillStyle = last >= 70 ? "#ef4d78" : last >= 67 ? "#ffb454" : last <= 30 ? "#28c76f" : rsiColor;
    c.fillText(last.toFixed(2), P.l + cw, P.t + 10);
    if (last >= 67) {
      c.font = "10px system-ui";
      c.fillStyle = last >= 70 ? "rgba(239,77,120,.9)" : "rgba(255,180,84,.9)";
      c.fillText(last >= 70 ? tx("超买", "OB") : tx("即将超买", "Near OB"), P.l + cw, P.t + 22);
    }
  }
  /* 左轴刻度。 */
  c.fillStyle = "#75849a";
  c.font = "10px system-ui";
  c.textAlign = "left";
  c.fillText("70", P.l + 2, y(70) - 2);
  c.fillText("30", P.l + 2, y(30) + 9);
  /* 悬浮十字虚线（竖线）：与主图贯穿联动，随鼠标左右移动实时更新。 */
  if (hoverPoint) {
    const xx = Math.max(P.l, Math.min(P.l + cw, hoverPoint.x));
    c.save();
    c.strokeStyle = "rgba(222,237,255,.42)";
    c.setLineDash([3, 4]);
    c.beginPath();
    c.moveTo(xx, P.t);
    c.lineTo(xx, P.t + ch);
    c.stroke();
    c.setLineDash([]);
    c.restore();
  }
}

/* RSI 子图交互：点击柱状图区域→柱凸显；点击 RSI 线附近（±14px）→RSI 凸显、柱压暗后推；
   再次点击同一目标或点击子图外还原。悬停时单根柱高亮（沿用主图 hoverIndex）。 */
(() => {
  const cv = $("chartRsi");
  if (!cv) return;
  /* 必须与 drawRsiChart 的绘制几何完全一致（原先这里写 l:52、绘制却用 l:18，
     点选命中的柱子与眼睛看到的相差 34px。 */
  const P = { l: CHART_PAD.l, r: CHART_PAD.r, t: 8, b: 8 };
  const pick = (event) => {
    const rect = cv.getBoundingClientRect(),
      d = visibleCandles();
    if (!rect || d.length < 2) return null;
    const cw = rect.width - P.l - P.r,
      ch = rect.height - P.t - P.b,
      px = event.clientX - rect.left,
      py = event.clientY - rect.top;
    if (px < P.l || px > P.l + cw || py < P.t || py > P.t + ch) return null;
    const idx = Math.max(
      0,
      Math.min(d.length - 1, Math.round(((px - P.l) / cw) * (d.length - 1))),
    );
    if ((state.chartSeries || {}).rsi !== false) {
      const val = rsi(d.map((v) => v.close), 14)[idx];
      if (Number.isFinite(val)) {
        /* 与 drawRsiChart 一致：RSI 曲线铺满整个副图高度（同区域叠显）。 */
        const yy = P.t + (1 - val / 100) * ch;
        if (Math.abs(py - yy) <= 14) return "rsi";
      }
    }
    return "volume";
  };
  cv.addEventListener("click", (event) => {
    const target = pick(event);
    rsiPaneFocus = target && rsiPaneFocus !== target ? target : null;
    scheduleChartRender();
  });
  cv.addEventListener("mousemove", (event) => {
    const rect = cv.getBoundingClientRect(),
      d = visibleCandles();
    if (!rect || d.length < 2) return;
    const cw = rect.width - P.l - P.r,
      rawX = event.clientX - rect.left;
    // 同步悬浮十字线（sub=true：主图只画竖线贯穿，不画水平线与圆点）。
    hoverPoint = {
      x: Math.max(P.l, Math.min(P.l + cw, rawX)),
      y: event.clientY - rect.top,
      sub: true,
    };
    hoverIndex = Math.max(
      0,
      Math.min(d.length - 1, Math.round(((hoverPoint.x - P.l) / cw) * (d.length - 1))),
    );
    cv.style.cursor = pick(event) ? "pointer" : "default";
    scheduleChartRender();
    const tip = $("chartTooltip");
    if (tip && hoverIndex !== null && d[hoverIndex]) {
      const v = d[hoverIndex],
        series = state.chartSeries || { rsi: true, volume: true },
        showRsi = series.rsi !== false,
        showVolume = series.volume !== false;
      let rsiHtml = "";
      if (showRsi) {
        const rsiArr = rsi(d.map((x) => x.close), 14),
          rv = rsiArr[hoverIndex];
        if (Number.isFinite(rv)) rsiHtml = `<span>RSI(14) ${rv.toFixed(2)}</span>`;
      }
      const volHtml = showVolume
        ? `<span>${tx("量", "Vol")} ${v.volume.toLocaleString("en-US", { maximumFractionDigits: 2 })}</span>`
        : "";
      const delta = (v.close / v.open - 1) * 100;
      tip.innerHTML = `<b>${pointTime(v.time)}</b><span>${tx("收", "Close")} ${money(v.close)} ${pct(delta)}</span>${volHtml}${rsiHtml}`;
      tip.style.display = "grid";
      const boxRect = cv.closest(".chart-box")?.getBoundingClientRect() || rect;
      tip.style.left = Math.min(event.clientX - boxRect.left + 14, boxRect.width - 185) + "px";
      tip.style.top = Math.max(8, event.clientY - boxRect.top - 96) + "px";
    }
  });
  cv.addEventListener("mouseleave", () => {
    hoverIndex = null;
    hoverPoint = null;
    const tip = $("chartTooltip");
    if (tip) tip.style.display = "none";
    scheduleChartRender();
  });
})();

if (state.candles.length) drawCandlestickChart();

// 形态卡片每一项都提供通俗说明；必须在渲染器之后添加，避免数据刷新时被覆盖。
// Each item in the pattern card gets a plain-language explanation. Add these
// after the renderer so a data refresh cannot remove them.
function addPatternAnalysisHelp() {
  const card = $("patternAnalysis");
  if (!card) return;
  const attach = (selector, zh, en) => {
    const label = card.querySelector(selector);
    if (label) addHelp(label, zh, en);
  };
  attach(
    ".pattern-grid article:nth-child(1) small",
    "趋势与均线：把 MA5、MA10、MA20 想成不同速度的平均价格线。短线均线在上、长一点的均线在下，代表最近价格整体偏强；反过来则偏弱。它只描述目前走势，不保证下一根 K 线继续涨或跌。",
    "Trend and moving averages: MA5, MA10 and MA20 are average-price lines of different speeds. Faster lines above slower ones indicate recent strength; the reverse indicates weakness. This describes the current trend, not the next candle.",
  );
  attach(
    ".pattern-grid article:nth-child(2) small",
    "近期关键高 / 低：这是前 20 根已经完成的 K 线里，价格到过的最高和最低位置。很多人会把它们当成可能遇到卖压或买盘的位置，但价格也可能直接突破。",
    "Recent high / low: the highest and lowest prices across the prior 20 completed candles. They can act as areas of selling or buying interest, but price can also break through them.",
  );
  attach(
    ".pattern-grid article:nth-child(3) small",
    "当前 K 线信号：看这一根 K 线的上下影线和成交量。长上影表示冲高后被卖下来，长下影表示跌下去后有人接；单独一根 K 线不能确认趋势。",
    "Current-candle signal: reads this candle's wicks and volume. A long upper wick shows selling after a push up; a long lower wick shows buying after a dip. One candle cannot confirm a trend.",
  );
  attach(
    ".pattern-levels span:nth-child(1) small",
    "阻力参考：价格靠近这里时，可能遇到较多卖单或前期套牢盘。站上并收稳才说明压力可能被突破。",
    "Resistance: an area where selling or trapped holders may appear. Holding above it after a close suggests the pressure may be breaking.",
  );
  attach(
    ".pattern-levels span:nth-child(2) small",
    "短线支撑：离当前价格较近、值得观察的承接位置。跌破不代表一定继续跌，但说明短线买盘需要重新确认。",
    "Near support: a nearby area where buyers may step in. A break does not guarantee further decline, but means short-term demand needs reassessment.",
  );
  attach(
    ".pattern-levels span:nth-child(3) small",
    "关键支撑：比短线支撑更重要的观察位置。若价格在这里也守不住，原来的上涨或震荡结构可能变弱。",
    "Key support: a more important level than near support. Losing it can weaken the prior uptrend or range structure.",
  );
  attach(
    ".pattern-levels span:nth-child(4) small",
    "结构失效参考：这是当前这套“偏多、偏空或震荡”解读不再适用的价格附近。它是复盘用的风险参考，不是自动下单价。",
    "Structure invalidation: a nearby price where the current bullish, bearish, or range interpretation no longer fits. It is a risk reference, not an order price.",
  );
  attach(
    ".pattern-scenario b",
    "情景观察：页面把当前数据整理成“如果发生 A，就重点观察 B”的条件句，帮助你做计划；不是对未来的保证。",
    "Scenario watch: conditional planning from current data—if A happens, watch B. It is not a prediction or guarantee.",
  );
};

// 保留原有六项技术指标；仅在当前交易所提供数据时追加市场环境确认项。
// Keep the original six technical indicators and append market-context
// confirmations only when the selected exchange supplies them.
renderTradingConfirmation = function (m) {
  const indicators = $("indicators"),
    candles = fixedRuleSignal.candles;
  if (!indicators || candles.length < 30) return;
  const latest = candles.at(-1),
    averageVolume =
      candles.slice(-21, -1).reduce((sum, c) => sum + c.volume, 0) / 20,
    volumeRatio = averageVolume ? latest.volume / averageVolume : NaN,
    vwap = fixedSessionVwap(candles),
    context =
      derivativeMarketContext?.source ===
      (fixedRuleSignal.source || state.source)
        ? derivativeMarketContext
        : null,
    funding = context?.fundingRate,
    basis = context?.basisPct,
    oi = context?.oi;
  const trendBull = m.close > m.e20 && m.e20 > m.e50 && m.e50 > m.e200,
    trendBear = m.close < m.e20 && m.e20 < m.e50 && m.e50 < m.e200,
    vwapBull = Number.isFinite(vwap) && m.close > vwap,
    vwapBear = Number.isFinite(vwap) && m.close < vwap,
    crowdedLong = Number.isFinite(funding) && funding >= 0.0005,
    crowdedShort = Number.isFinite(funding) && funding <= -0.0005,
    extremeBasis = Number.isFinite(basis) && Math.abs(basis) >= 0.12,
    rows = [];
  const add = (key, name, value, kind, label, help) =>
      rows.push({ key, name, value, kind, label, help }),
    signal = (bull, bear) => (bull ? "bull" : bear ? "bear" : "flat");
  add(
    "ema20",
    "EMA20",
    money(m.e20),
    signal(m.close >= m.e20, m.close < m.e20),
    m.close >= m.e20 ? tx("看多", "Bullish") : tx("看空", "Bearish"),
    [
      "当前选中价相对 EMA20 的位置；EMA20 用于观察短线趋势。",
      "Selected price relative to EMA20; EMA20 is a short-term trend reference.",
    ],
  );
  add(
    "ema50",
    "EMA50",
    money(m.e50),
    signal(m.close >= m.e50, m.close < m.e50),
    m.close >= m.e50 ? tx("看多", "Bullish") : tx("看空", "Bearish"),
    [
      "当前选中价相对 EMA50 的位置；EMA50 用于观察中短线趋势。",
      "Selected price relative to EMA50; EMA50 is a medium-short trend reference.",
    ],
  );
  if (Number.isFinite(m.e200))
    add(
      "ema200",
      "EMA200",
      money(m.e200),
      signal(m.close >= m.e200, m.close < m.e200),
      m.close >= m.e200 ? tx("看多", "Bullish") : tx("看空", "Bearish"),
      [
        "当前选中价相对 EMA200 的位置；EMA200 常用于长趋势过滤。",
        "Selected price relative to EMA200; EMA200 is commonly used as a long-trend filter.",
      ],
    );
  const rsiKind = m.rsi > 55 ? "bull" : m.rsi < 45 ? "bear" : "flat";
  add(
    "rsi",
    "RSI(14)",
    m.rsi.toFixed(2),
    rsiKind,
    rsiKind === "bull"
      ? tx("看多", "Bullish")
      : rsiKind === "bear"
        ? tx("看空", "Bearish")
        : tx("中性", "Neutral"),
    [
      "RSI(14) 衡量近期涨跌动能；这里按 55/45 作为偏多或偏空的温和阈值，不等同超买超卖。",
      "RSI(14) measures recent momentum. 55/45 are mild directional thresholds, not overbought/oversold calls.",
    ],
  );
  const bollKind = m.boll > 55 ? "bull" : m.boll < 45 ? "bear" : "flat";
  add(
    "boll",
    tx("布林位置", "Bollinger position"),
    `${m.boll.toFixed(2)}%`,
    bollKind,
    bollKind === "bull"
      ? tx("看多", "Bullish")
      : bollKind === "bear"
        ? tx("看空", "Bearish")
        : tx("中性", "Neutral"),
    [
      "价格在布林带中的相对位置；接近上/下沿并不单独构成开仓信号。",
      "Relative position within Bollinger Bands; being near either band is not an entry signal on its own.",
    ],
  );
  add("atr", "ATR(14)", money(m.atr), "flat", tx("中性", "Neutral"), [
    "ATR(14) 衡量波动幅度，适合用于止损和仓位大小；它本身不判断方向。",
    "ATR(14) measures volatility and is useful for stops and sizing; it is not directional by itself.",
  ]);
  const volumeKind =
    volumeRatio >= 1.2 ? "bull" : volumeRatio < 0.8 ? "bear" : "flat";
  if (Number.isFinite(volumeRatio))
    add(
      "volume",
      tx("成交量确认", "Volume confirmation"),
      `${volumeRatio.toFixed(2)}×`,
      volumeKind,
      volumeKind === "bull"
        ? tx("确认", "Confirmed")
        : volumeKind === "bear"
          ? tx("偏弱", "Weak")
          : tx("一般", "Normal"),
      [
        "最新已收盘 K 线成交量相对前 20 根均量。≥1.2× 为放量确认，<0.8× 为量能偏弱。",
        "Latest closed-candle volume relative to the prior 20-candle average. ≥1.2× confirms participation; <0.8× is weak.",
      ],
    );
  if (Number.isFinite(vwap))
    add(
      "vwap",
      tx("日内 VWAP", "Session VWAP"),
      money(vwap),
      signal(vwapBull, vwapBear),
      vwapBull ? tx("偏多", "Bullish") : tx("偏空", "Bearish"),
      [
        "UTC 自然日成交量加权平均价。价格在其上/下仅说明日内位置，仍需趋势与成交量确认。",
        "UTC-session VWAP. Price above/below only indicates intraday position and still needs trend and volume confirmation.",
      ],
    );
  if (Number.isFinite(funding))
    add(
      "funding",
      tx("资金费率", "Funding rate"),
      formatRate(funding),
      crowdedLong ? "bear" : crowdedShort ? "bull" : "flat",
      crowdedLong
        ? tx("多头拥挤", "Long crowded")
        : crowdedShort
          ? tx("空头拥挤", "Short crowded")
          : tx("中性", "Neutral"),
      [
        "永续资金费率反映多空持仓的定期费用。费率极端时，拥挤方向的追单风险更高。",
        "Funding reflects periodic perp-position payments. Extreme readings increase the risk of chasing the crowded side.",
      ],
    );
  if (Number.isFinite(oi))
    add(
      "oi",
      tx("持仓量 OI", "Open interest"),
      `${oi.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${context.oiUnit || ""}`.trim(),
      "flat",
      tx("中性", "Neutral"),
      [
        "交易所公开的未平仓合约量，反映杠杆参与规模；需结合价格和成交量判断。",
        "Public open interest reflects leveraged participation and should be read with price and volume.",
      ],
    );
  if (Number.isFinite(basis))
    add(
      "basis",
      tx("永续价差", "Perp basis"),
      `${basis >= 0 ? "+" : ""}${basis.toFixed(3)}%`,
      extremeBasis ? (basis > 0 ? "bear" : "bull") : "flat",
      extremeBasis ? tx("注意", "Caution") : tx("中性", "Neutral"),
      [
        "永续相对现货的百分比价差。较大的溢价或贴水可能提示杠杆市场拥挤。",
        "Perpetual price relative to spot. A large premium or discount can indicate crowded derivatives positioning.",
        "",
      ],
    );
  let action =
      trendBull && vwapBull && volumeRatio >= 1
        ? tx("研究偏多", "Bullish bias")
        : trendBear && vwapBear && volumeRatio >= 1
          ? tx("研究偏空", "Bearish bias")
          : tx("观望", "Wait"),
    decisionKind =
      action === tx("研究偏多", "Bullish bias")
        ? "bull"
        : action === tx("研究偏空", "Bearish bias")
          ? "bear"
          : "flat";
  if (
    (decisionKind === "bull" && crowdedLong) ||
    (decisionKind === "bear" && crowdedShort)
  ) {
    action = tx("观望", "Wait");
    decisionKind = "flat";
  }
  const row = ({ key, name, value, kind, label }) =>
    `<div class="metric trade-confirmation-row compact-indicator" data-fixed-basis="true" data-indicator="${key}"><span>${name}</span><b>${value}</b><i class="badge ${kind}">${label}</i></div>`;
  indicators.classList.add(
    "trade-confirmation-metrics",
    "indicator-adaptive-grid",
  );
  indicators.style.setProperty(
    "--indicator-font-scale",
    rows.length > 10 ? ".84" : rows.length > 8 ? ".92" : "1",
  );
  indicators.innerHTML =
    rows.map(row).join("") +
    `<div class="trade-decision ${decisionKind}"><span>${tx("综合研究结论", "Research view")}</span><b>${action}</b><p>${tx("仅在趋势、VWAP 与成交量同向时给出研究倾向；资金费率与永续价差用于识别拥挤风险。", "A directional bias requires trend, VWAP and volume agreement; funding and basis flag crowding risk.")}${context ? ` · ${String(context.source).toUpperCase()}` : ""}</p></div>`;
  indicators.querySelectorAll(".compact-indicator").forEach((el) => {
    const copy = rows.find((item) => item.key === el.dataset.indicator)?.help;
    if (copy) addHelp(el.querySelector("span"), copy[0], copy[1]);
  });
};

/* The indicator card is a compact trading-confirmation view.  It uses only
   the fixed, closed-candle signal basis and a separately cached derivatives
   context, so changing the chart display never changes its recommendation. */
var derivativeMarketContext = null,
  derivativeMarketContextLoading = false;
function fixedSessionVwap(candles) {
  const latest = candles.at(-1),
    start = Math.floor(latest.time / 86_400_000) * 86_400_000,
    session = candles.filter((c) => c.time >= start),
    total = session.reduce((sum, c) => sum + c.volume, 0);
  return total
    ? session.reduce(
        (sum, c) => sum + ((c.high + c.low + c.close) / 3) * c.volume,
        0,
      ) / total
    : NaN;
}
function renderTradingConfirmation(m) {
  const indicators = $("indicators"),
    candles = fixedRuleSignal.candles;
  if (!indicators || candles.length < 30) return;
  const latest = candles.at(-1),
    averageVolume =
      candles.slice(-21, -1).reduce((sum, c) => sum + c.volume, 0) / 20,
    volumeRatio = averageVolume ? latest.volume / averageVolume : NaN,
    vwap = fixedSessionVwap(candles),
    trendBull = m.close > m.e20 && m.e20 > m.e50 && m.e50 > m.e200,
    trendBear = m.close < m.e20 && m.e20 < m.e50 && m.e50 < m.e200,
    trendKind = trendBull ? "bull" : trendBear ? "bear" : "flat",
    vwapKind = m.close > vwap ? "bull" : m.close < vwap ? "bear" : "flat",
    volumeKind =
      volumeRatio >= 1.2 ? "bull" : volumeRatio < 0.8 ? "bear" : "flat",
    context =
      derivativeMarketContext?.source ===
      (fixedRuleSignal.source || state.source)
        ? derivativeMarketContext
        : null,
    funding = context?.fundingRate,
    basis = context?.basisPct,
    oi = context?.oi;
  const crowdedLong = Number.isFinite(funding) && funding >= 0.0005,
    crowdedShort = Number.isFinite(funding) && funding <= -0.0005,
    extremeBasis = Number.isFinite(basis) && Math.abs(basis) >= 0.12;
  let action = "观望",
    decisionKind = "flat",
    reason = "趋势、成交或位置尚未同时确认";
  if (
    (trendBull || trendBear) &&
    volumeRatio >= 1 &&
    ((trendBull && vwapKind === "bull") || (trendBear && vwapKind === "bear"))
  ) {
    action = trendBull ? "研究偏多" : "研究偏空";
    decisionKind = trendBull ? "bull" : "bear";
    reason = trendBull ? "趋势、VWAP 与成交量同向" : "趋势、VWAP 与成交量同向";
  } else if ((trendBull || trendBear) && volumeRatio < 1) {
    reason = "趋势存在，但成交量未确认";
  } else if (trendBull || trendBear) {
    reason = "趋势存在，但价格与 VWAP 尚未同向";
  }
  if (
    (decisionKind === "bull" && crowdedLong) ||
    (decisionKind === "bear" && crowdedShort)
  ) {
    action = "观望";
    decisionKind = "flat";
    reason += `；${crowdedLong ? "多头" : "空头"}资金费率偏拥挤`;
  }
  if (extremeBasis) {
    reason += `；永续${basis > 0 ? "溢价" : "贴水"}偏大`;
  }
  const row = (key, name, value, detail, kind, label) =>
    `<div class="metric trade-confirmation-row" data-fixed-basis="true" data-indicator="${key}"><span>${name}</span><b>${value}</b><i class="badge ${kind}">${label || { bull: "偏多", bear: "偏空", flat: "中性" }[kind]}</i><small>${detail}</small></div>`;
  const volumeDetail = Number.isFinite(volumeRatio)
    ? `${volumeRatio.toFixed(2)}× ${volumeRatio >= 1.2 ? "放量确认" : volumeRatio < 0.8 ? "量能偏弱" : "量能一般"} · 对比前 20 根已收盘K线`
    : "数据不足";
  const fundingKind = crowdedLong ? "bear" : crowdedShort ? "bull" : "flat",
    fundingDetail = Number.isFinite(funding)
      ? `${funding > 0 ? "多头付费" : "空头付费"} · 下期 ${formatRate(context.nextFundingRate)}`
      : "当前数据源未提供",
    basisKind = extremeBasis ? (basis > 0 ? "bear" : "bull") : "flat",
    basisDetail = Number.isFinite(basis)
      ? `永续 ${money(context.perpPrice)} / 现货 ${money(context.spotPrice)}`
      : "当前数据源未提供";
  indicators.classList.add("trade-confirmation-metrics");
  indicators.innerHTML = [
    row(
      "trend",
      tx("趋势结构", "Trend structure"),
      trendBull
        ? "EMA 多头排列"
        : trendBear
          ? "EMA 空头排列"
          : tx("均线分歧", "Mixed EMAs"),
      `EMA20 ${money(m.e20)} · EMA50 ${money(m.e50)} · EMA200 ${money(m.e200)}`,
      trendKind,
    ),
    row(
      "volume",
      tx("成交量确认", "Volume confirmation"),
      Number.isFinite(volumeRatio) ? `${volumeRatio.toFixed(2)}×` : "--",
      volumeDetail,
      volumeKind,
      volumeRatio >= 1.2
        ? tx("确认", "Confirmed")
        : volumeRatio < 0.8
          ? tx("偏弱", "Weak")
          : tx("一般", "Normal"),
    ),
    row(
      "vwap",
      tx("日内 VWAP", "Session VWAP"),
      Number.isFinite(vwap) ? money(vwap) : "--",
      Number.isFinite(vwap)
        ? `${m.close >= vwap ? tx("现价在 VWAP 上方", "Price above VWAP") : tx("现价在 VWAP 下方", "Price below VWAP")} · ${m.close >= vwap ? "+" : "−"}${Math.abs((m.close / vwap - 1) * 100).toFixed(2)}% · UTC 日内`
        : "数据不足",
      vwapKind,
    ),
    row(
      "funding",
      tx("资金费率", "Funding rate"),
      formatRate(funding),
      fundingDetail,
      fundingKind,
      crowdedLong
        ? tx("多头拥挤", "Long crowded")
        : crowdedShort
          ? tx("空头拥挤", "Short crowded")
          : tx("中性", "Neutral"),
    ),
    row(
      "oi",
      tx("持仓量 OI", "Open interest"),
      Number.isFinite(oi)
        ? `${oi.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${context.oiUnit}`
        : "--",
      context
        ? `${String(context.source).toUpperCase()} ${tx("当前公开持仓量", "current public open interest")}`
        : tx("数据暂不可用", "Data unavailable"),
      "flat",
    ),
    row(
      "basis",
      tx("永续价差", "Perp basis"),
      Number.isFinite(basis)
        ? `${basis >= 0 ? "+" : ""}${basis.toFixed(3)}%`
        : "--",
      basisDetail,
      basisKind,
      extremeBasis ? tx("注意", "Caution") : tx("中性", "Neutral"),
    ),
    `<div class="trade-decision ${decisionKind}"><span>${tx("研究结论", "Research view")}</span><b>${action}</b><p>${reason}。${context ? ` ${String(context.source).toUpperCase()} · ${context.cached ? tx("缓存", "cached") : tx("实时", "live")}` : ""}</p></div>`,
  ].join("");
  const tips = {
    trend: [
      `基于最近 ${fixedRuleHistoryCount()} 根已收盘 ${fixedRuleSignal.interval} K 线预热后的 EMA20、EMA50、EMA200 排列。只用于趋势过滤，不等于立即开仓。`,
      `EMA20, EMA50, and EMA200 alignment after warming up with the latest ${fixedRuleHistoryCount()} closed basis candles. It filters trend; it is not an entry by itself.`,
    ],
    volume: [
      `当前已收盘 K 线成交量与之前 20 根已收盘 K 线平均成交量的比值。≥1.2× 视为放量确认，<0.8× 视为量能偏弱。`,
      "Ratio of the latest closed candle volume to the preceding 20-candle average. ≥1.2× confirms participation; <0.8× is weak.",
    ],
    vwap: [
      `按 UTC 自然日内成交量加权平均价。现价在其上方仅代表日内位置偏强，仍需趋势和成交量确认。`,
      "UTC-session volume-weighted average price. Above it is only a stronger intraday position and still needs trend and volume confirmation.",
    ],
    funding: [
      "永续资金费率反映多空持仓的定期费用，不直接预测涨跌。费率过高或过低时，页面将拥挤方向降级为观望。",
      "Funding reflects periodic perp-position payments, not a direct price forecast. Extreme readings downgrade the crowded side to wait.",
    ],
    oi: [
      "交易所公开的当前未平仓合约量。它说明参与杠杆规模，不单独判断多空。",
      "Public current open interest. It shows leveraged participation, not direction by itself.",
    ],
    basis: [
      "永续价格相对现货价格的百分比。过大的溢价或贴水提示杠杆市场可能拥挤。",
      "Perpetual price relative to spot. A large premium or discount can indicate crowded derivatives positioning.",
    ],
  };
  indicators.querySelectorAll(".trade-confirmation-row").forEach((el) => {
    const copy = tips[el.dataset.indicator];
    if (copy) addHelp(el.querySelector("span"), copy[0], copy[1]);
  });
}
/* Superseded microstructure renderer retained below for historical context.
   The active renderer follows it in a readable form.
const renderTradingConfirmationWithMicrostructure=renderTradingConfirmation;
renderTradingConfirmation=function(m){renderTradingConfirmationWithMicrostructure(m);const indicators=$('indicators'),context=derivativeMarketContext;if(!indicators||context?.source!=='okx')return;const book=context.orderBook,flow=context.takerFlow,oiChange=context.oiChangePct,fundingChange=context.fundingChangePct,priceChange=state.ticker?.changePct;const signal=(value,positive=12,negative=-12)=>!Number.isFinite(value)?'flat':value>=positive?'bull':value<=negative?'bear':'flat',label=kind=>kind==='bull'?tx('偏多','Bullish'):kind==='bear'?tx('偏空','Bearish'):tx('中性','Neutral'),number=value=>Number.isFinite(value)?`${value>=0?'+':''}${value.toFixed(2)}%`:'--',add=(key,name,value,detail,kind,help)=>{const row=document.createElement('div');row.className='metric trade-confirmation-row compact-indicator microstructure-row';row.dataset.fixedBasis='true';row.dataset.indicator=key;row.innerHTML=`<span>${name}</span><b>${value}</b><i class="badge ${kind}">${label(kind)}</i>`;const decision=indicators.querySelector('.trade-decision');decision?decision.before(row):indicators.append(row);if(help)addHelp(row.querySelector('span'),help[0],help[1]);};const bookKind=signal(book?.imbalancePct),flowKind=signal(flow?.imbalancePct,14,-14),oiKind=Number.isFinite(oiChange)&&Number.isFinite(priceChange)?oiChange>=.2&&priceChange>=.1?'bull':oiChange>=.2&&priceChange<=-.1?'bear':'flat':'flat',fundingKind=Number.isFinite(fundingChange)?fundingChange>=.001?'bear':fundingChange<=-.001?'bull':'flat';add('book',tx('盘口失衡','Order-book imbalance'),book?`${number(book.imbalancePct)} · ${book.ratio.toFixed(2)}×`:'积累中',book?`${tx('前 5 档买盘','Top-5 bids')} / ${tx('卖盘','asks')} · ${money(book.bidDepth)} / ${money(book.askDepth)}`:tx('等待 OKX 盘口快照','Waiting for an OKX order-book snapshot'),bookKind,['前 5 档挂单金额的买卖差。挂单可以迅速撤销，因此只作为短线确认，不直接作为开仓信号。','Difference between top-five bid and ask notional. Orders can be cancelled quickly, so use only as short-term confirmation.']);add('taker',tx('主动成交','Taker flow'),flow?`${number(flow.imbalancePct)} · ${flow.buyRatioPct.toFixed(1)}%`:'积累中',flow?`${flow.windowSeconds}${tx(' 秒窗口','s window')} · ${tx('主动成交','taker trades')} ${flow.tradeCount} ${tx('笔','trades')}`:tx('正在积累 60 秒成交窗口','Building the 60-second trade window'),flowKind,['最近 60 秒主动买入与主动卖出成交额的差异。它反映已成交意愿，比静态挂单更难伪造，但仍可能很快反转。','Difference between taker buy and sell notional in the latest 60 seconds. It reflects executed intent, but can still reverse quickly.']);add('oi-change',tx('OI 变化（约5分）','OI change (~5m)'),Number.isFinite(oiChange)?number(oiChange):'积累中',Number.isFinite(oiChange)?`${priceChange>=0?tx('价格上涨','Price up'):tx('价格下跌','Price down')} ${number(priceChange)} · ${context.oiChangeWindowSeconds||300}${tx(' 秒样本','s sample')}`:tx('需先积累约 5 分钟的 OI 快照','Needs about five minutes of OI snapshots'),oiKind,['对比当前未平仓量与约 5 分钟前快照。价格上涨且 OI 增加通常代表新多参与；价格下跌且 OI 增加通常代表新空参与。','Compares current open interest with a roughly five-minute-old snapshot. Rising price plus rising OI can indicate new longs; falling price plus rising OI can indicate new shorts.']);add('funding-change',tx('资金费率变化','Funding-rate change'),Number.isFinite(fundingChange)?number(fundingChange):'积累中',Number.isFinite(fundingChange)?`${context.fundingChangeWindowSeconds||0}${tx(' 秒对比窗口','s comparison window')} · ${tx('当前','Current')} ${formatRate(context.fundingRate)}`:tx('需先积累约 1 小时费率快照','Needs about one hour of funding snapshots'),fundingKind,['当前资金费率相对约一小时前的变化。变化上升表示多头付费压力增加，变化下降表示空头付费压力增加；它是拥挤风险提示而非方向预测。','Change in funding versus roughly one hour ago. Rising funding increases long-crowding pressure; falling funding increases short-crowding pressure. It flags crowding risk rather than direction.']);const microKinds=[bookKind,flowKind,oiKind],bull=microKinds.filter(kind=>kind==='bull').length,bear=microKinds.filter(kind=>kind==='bear').length,decision=indicators.querySelector('.trade-decision'),view=decision?.querySelector('b'),reason=decision?.querySelector('p');if(decision&&view&&reason){const current=view.textContent.trim(),conflict=(current.includes('多')&&bear>=2)||(current.includes('空')&&bull>=2);if(conflict){view.textContent=tx('观望','Wait');decision.classList.remove('bull','bear');decision.classList.add('flat');reason.textContent=tx('趋势与实时盘口/主动成交发生分歧，暂不追随单一方向。','Trend conflicts with live order-book and taker flow; do not follow a single direction.')}else{const evidence=bull>=2?tx('盘口与主动成交偏多','Order book and taker flow lean bullish'):bear>=2?tx('盘口与主动成交偏空','Order book and taker flow lean bearish'):tx('盘口与主动成交未形成共识','Order book and taker flow have no consensus');reason.textContent=`${reason.textContent} · ${evidence}`}}indicators.classList.add('indicator-adaptive-grid');indicators.style.setProperty('--indicator-font-scale',indicators.querySelectorAll('.compact-indicator').length>12?'.78':'.84')};
*/
/* Add live OKX order-flow evidence after the base confirmation rows are rendered. */
function addLiveFlowConfirmation() {
  const indicators = $("indicators"),
    context = derivativeMarketContext;
  if (!indicators || context?.source !== "okx") return;
  const book = context.orderBook,
    flow = context.takerFlow,
    oiChange = context.oiChangePct,
    fundingChange = context.fundingChangePct,
    priceChange = context.priceChangePct;
  const direction = (value, positive = 12, negative = -12) =>
    !Number.isFinite(value)
      ? "flat"
      : value >= positive
        ? "bull"
        : value <= negative
          ? "bear"
          : "flat";
  const directionLabel = (kind) =>
    kind === "bull"
      ? tx("偏多", "Bullish")
      : kind === "bear"
        ? tx("偏空", "Bearish")
        : tx("中性", "Neutral");
  const signedPercent = (value) =>
    Number.isFinite(value)
      ? `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`
      : "--";
  const add = (key, name, value, detail, kind, help) => {
    const row = document.createElement("div");
    row.className =
      "metric trade-confirmation-row compact-indicator microstructure-row";
    row.dataset.fixedBasis = "true";
    row.dataset.indicator = key;
    row.innerHTML = `<span>${name}</span><b>${value}</b><i class="badge ${kind}">${directionLabel(kind)}</i>`;
    const decision = indicators.querySelector(".trade-decision");
    decision ? decision.before(row) : indicators.append(row);
    if (help) addHelp(row.querySelector("span"), help[0], help[1]);
  };
  const bookKind = direction(book?.imbalancePct),
    flowKind = direction(flow?.imbalancePct, 14, -14);
  const oiKind =
    Number.isFinite(oiChange) && Number.isFinite(priceChange)
      ? oiChange >= 0.2 && priceChange >= 0.1
        ? "bull"
        : oiChange >= 0.2 && priceChange <= -0.1
          ? "bear"
          : "flat"
      : "flat";
  const fundingKind = Number.isFinite(fundingChange)
    ? fundingChange >= 0.001
      ? "bear"
      : fundingChange <= -0.001
        ? "bull"
        : "flat"
    : "flat";
  const bookValue = book
    ? `${signedPercent(book.imbalancePct)} · ${Number.isFinite(book.ratio) ? book.ratio.toFixed(2) + "×" : "--"}`
    : tx("积累中", "Collecting");
  add(
    "book",
    tx("盘口失衡", "Order-book imbalance"),
    bookValue,
    book
      ? `${tx("前 5 档买/卖深度比", "Top-5 bid/ask depth ratio")} ${Number.isFinite(book.ratio) ? book.ratio.toFixed(2) + "×" : "--"}`
      : tx("等待 OKX 盘口快照", "Waiting for an OKX order-book snapshot"),
    bookKind,
    [
      "前 5 档挂单深度的买卖差。挂单可以迅速撤销，因此只作为短线确认，不直接作为开仓信号。",
      "Difference between top-five bid and ask depth. Orders can be cancelled quickly, so use only as short-term confirmation.",
    ],
  );
  add(
    "taker",
    tx("主动成交", "Taker flow"),
    flow
      ? `${signedPercent(flow.imbalancePct)} · ${flow.buyRatioPct.toFixed(1)}%`
      : tx("积累中", "Collecting"),
    flow
      ? `${flow.windowSeconds}${tx(" 秒窗口", "s window")} · ${tx("主动成交", "taker trades")} ${flow.tradeCount} ${tx("笔", "trades")}`
      : tx("正在积累 60 秒成交窗口", "Building the 60-second trade window"),
    flowKind,
    [
      "最近 60 秒主动买入与主动卖出成交额的差异。它反映已成交意愿，比静态挂单更难伪造，但仍可能很快反转。",
      "Difference between taker buy and sell notional in the latest 60 seconds. It reflects executed intent, but can still reverse quickly.",
    ],
  );
  add(
    "oi-change",
    tx("OI 变化（约5分）", "OI change (~5m)"),
    Number.isFinite(oiChange)
      ? signedPercent(oiChange)
      : tx("积累中", "Collecting"),
    Number.isFinite(oiChange) && Number.isFinite(priceChange)
      ? `${tx("价格（约5分钟）", "Price (~5m)")} ${signedPercent(priceChange)} · ${context.oiChangeWindowSeconds || 300}${tx(" 秒样本", "s sample")}`
      : tx(
          "需先积累约 5 分钟的 OI 与价格快照",
          "Needs about five minutes of OI and price snapshots",
        ),
    oiKind,
    [
      "对比当前未平仓量与约 5 分钟前快照。价格上涨且 OI 增加通常代表新多参与；价格下跌且 OI 增加通常代表新空参与。",
      "Compares current open interest with a roughly five-minute-old snapshot. Rising price plus rising OI can indicate new longs; falling price plus rising OI can indicate new shorts.",
    ],
  );
  add(
    "funding-change",
    tx("资金费率变化", "Funding-rate change"),
    Number.isFinite(fundingChange)
      ? signedPercent(fundingChange)
      : tx("积累中", "Collecting"),
    Number.isFinite(fundingChange)
      ? `${context.fundingChangeWindowSeconds || 0}${tx(" 秒对比窗口", "s comparison window")} · ${tx("当前", "Current")} ${formatRate(context.fundingRate)}`
      : tx(
          "需先积累约 1 小时费率快照",
          "Needs about one hour of funding snapshots",
        ),
    fundingKind,
    [
      "当前资金费率相对约一小时前的变化。变化上升表示多头付费压力增加，变化下降表示空头付费压力增加；它是拥挤风险提示而非方向预测。",
      "Change in funding versus roughly one hour ago. Rising funding increases long-crowding pressure; falling funding increases short-crowding pressure. It flags crowding risk rather than direction.",
    ],
  );
  const directions = [bookKind, flowKind, oiKind],
    bull = directions.filter((kind) => kind === "bull").length,
    bear = directions.filter((kind) => kind === "bear").length,
    decision = indicators.querySelector(".trade-decision"),
    view = decision?.querySelector("b"),
    reason = decision?.querySelector("p");
  if (decision && view && reason) {
    const current = view.textContent.trim(),
      conflict =
        (current.includes("多") && bear >= 2) ||
        (current.includes("空") && bull >= 2);
    if (conflict) {
      view.textContent = tx("观望", "Wait");
      decision.classList.remove("bull", "bear");
      decision.classList.add("flat");
      reason.textContent = tx(
        "趋势与实时盘口/主动成交发生分歧，暂不追随单一方向。",
        "Trend conflicts with live order-book and taker flow; do not follow a single direction.",
      );
    } else {
      const evidence =
        bull >= 2
          ? tx("盘口与主动成交偏多", "Order book and taker flow lean bullish")
          : bear >= 2
            ? tx("盘口与主动成交偏空", "Order book and taker flow lean bearish")
            : tx(
                "盘口与主动成交未形成共识",
                "Order book and taker flow have no consensus",
              );
      reason.textContent = `${reason.textContent} · ${evidence}`;
    }
  }
  indicators.classList.add("indicator-adaptive-grid");
  indicators.style.setProperty(
    "--indicator-font-scale",
    indicators.querySelectorAll(".compact-indicator").length > 12
      ? ".78"
      : ".84",
  );
}
async function loadDerivativeMarketContext(force = false) {
  if (derivativeMarketContextLoading) return;
  const source = state.source || "okx";
  if (!force && derivativeMarketContext?.source === source) return;
  derivativeMarketContextLoading = true;
  try {
    const response = await fetch(
        "/api/market-context?" + new URLSearchParams({ source }),
      ),
      data = await response.json();
    if (!response.ok) throw new Error(data.detail || data.error);
    derivativeMarketContext = data;
    renderFixedRuleSignal();
    renderOkxMicrostructure(derivativeMarketContext);
  } catch {
    derivativeMarketContext = { source, error: true };
  } finally {
    derivativeMarketContextLoading = false;
  }
}
$("source")?.addEventListener("change", () => {
  derivativeMarketContext = null;
  loadDerivativeMarketContext(true);
});
whenIdle(() => loadDerivativeMarketContext(true));
setInterval(() => loadDerivativeMarketContext(true), 10_000);
whenIdle(() => loadMarketHealth());
setInterval(() => loadMarketHealth(), 30_000);

/* 连通性诊断在启动稍后执行，并将服务器给出的本地与上游耗时分别呈现。
   Connectivity diagnostics begin shortly after startup, with the server's
   persistent OKX WebSocket checked before REST-backed data routes. */
initConnectivity();

/* “最高/最低价” follows the plotted series (wick on candles, close on a
   close-line chart).  The marker and hover card read the same value, so no
   mismatch shows up between the label and the point it sits on. */
$("chart")?.addEventListener("mousemove", () => {
  const tip = $("chartTooltip"),
    d = visibleCandles();
  if (!tip || hoverIndex === null || d.length < 2) return;
  tip.querySelector(".range-extrema-tooltip-note")?.remove();
  const { hiI: highIndex, loI: lowIndex } = rangeExtremeIndices(d),
    kind =
      hoverIndex === highIndex
        ? "high"
        : hoverIndex === lowIndex
          ? "low"
          : null;
  if (!kind) return;
  const label =
    kind === "high"
      ? tx("此为当前查看范围内最高价", "Highest price in this range")
      : tx("此为当前查看范围内最低价", "Lowest price in this range");
  tip.insertAdjacentHTML(
    "afterbegin",
    `<div class="range-extrema-tooltip-note ${kind}">${label}</div>`,
  );
});
/* 提示文字由「横向移动」工具（#panTools / updatePanControls）统一维护，
   这里不再二次改写，避免出现「提示写横向移动、实际却在缩放」的不一致。 */

/* Pan the actual displayed slice.  The older compatibility renderer reset it
   to the newest candles, which made ⌘/Ctrl + wheel appear to do nothing. */

function updatePanAvailability() {
  const data = state.frozenCandles || state.candles,
    count = state.viewPoints
      ? Math.max(2, Math.ceil(state.viewPoints / state.zoom))
      : Math.max(30, Math.ceil(data.length / state.zoom)),
    max = Math.max(0, data.length - Math.min(data.length, count)),
    offset = Math.max(0, Math.min(max, state.panOffset || 0)),
    tools = $("panTools");
  if (!tools) return;
  tools
    .querySelector('[data-pan="back"]')
    ?.toggleAttribute("disabled", offset >= max);
  tools
    .querySelector('[data-pan="forward"]')
    ?.toggleAttribute("disabled", offset === 0);
}
/* ⌘ / Ctrl + 滚轮 = 横向移动（与工具栏「横向移动」提示一致）。
   缩放不再绑定任何鼠标快捷键，只在工具栏的 − / + / 重置 按钮上触发，
   避免误触改变缩放级别。 */
$("chart")
  ?.closest(".chart-box")
  ?.addEventListener(
    "wheel",
    (event) => {
      if (!event.metaKey && !event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();
      const data = state.frozenCandles || state.candles;
      if (data.length < 2) return;
      const count = state.viewPoints
          ? Math.max(2, Math.ceil(state.viewPoints / state.zoom))
          : Math.max(30, Math.ceil(data.length / state.zoom)),
        n = Math.min(data.length, count),
        max = Math.max(0, data.length - n),
        step = Math.max(1, Math.round(n * 0.1)),
        dx = event.deltaX || 0,
        dy = event.deltaY || 0,
        /* 触控板横滑给 deltaX，鼠标纵向滚轮给 deltaY，取主导分量。 */
        delta = Math.abs(dx) > Math.abs(dy) ? dx : dy;
      if (!delta) return;
      state.panOffset = Math.max(
        0,
        Math.min(max, (state.panOffset || 0) + (delta > 0 ? step : -step)),
      );
      hoverIndex = null;
      clearChartSelection();
      draw();
      updatePanControls();
      updatePanAvailability();
    },
    { capture: true, passive: false },
  );

/* Floating extrema labels share the renderer's scale and the selected display
   mode: candle chart uses wick high/low, close-line chart uses close high/low. */
renderRangeExtremaPoints = function () {
  const box = $("chart")?.closest(".chart-box"),
    cv = $("chart"),
    d = visibleCandles();
  if (!box || !cv || d.length < 2) return;
  let high = $("rangeHighPoint"),
    low = $("rangeLowPoint");
  if (!high) {
    high = document.createElement("div");
    high.id = "rangeHighPoint";
    high.className = "range-extreme high";
    box.append(high);
  }
  if (!low) {
    low = document.createElement("div");
    low.id = "rangeLowPoint";
    low.className = "range-extreme low";
    box.append(low);
  }
  const series = state.chartSeries || { candles: true, close: false },
    highValue = (v) => (series.candles ? v.high : v.close),
    lowValue = (v) => (series.candles ? v.low : v.close),
    hiI = d.reduce(
      (best, v, i) => (highValue(v) > highValue(d[best]) ? i : best),
      0,
    ),
    loI = d.reduce(
      (best, v, i) => (lowValue(v) < lowValue(d[best]) ? i : best),
      0,
    ),
    values = d.flatMap((v) => [v.low, v.high]),
    closes = d.map((v) => v.close);
  [ema(closes, 20), ema(closes, 50), ema(closes, 200)].forEach((a) =>
    a.forEach((v) => {
      if (Number.isFinite(v)) values.push(v);
    }),
  );
  let min = minOf(values),
    max = maxOf(values),
    pad = (max - min || 1) * 0.075;
  min -= pad;
  max += pad;
  const rect = cv.getBoundingClientRect(),
    P = { l: 52, r: 74, t: 15, b: 30 },
    cw = rect.width - P.l - P.r,
    ch = rect.height - P.t - P.b,
    priceHeight = ch - Math.max(42, Math.round(ch * 0.24)) - 8,
    x = (i) => P.l + (i / (d.length - 1)) * cw,
    y = (v) => P.t + ch - ((v - min) / (max - min)) * ch,
    label = txInterval(state.range || state.interval),
    point = (el, i, value, kind) => {
      el.style.left = `${Math.max(8, Math.min(rect.width - 160, x(i)))}px`;
      el.style.top = `${Math.max(6, Math.min(rect.height - 28, y(value) + (kind === "high" ? -25 : 8)))}px`;
      el.textContent = `${label}${kind === "high" ? tx("最高点", " high") : tx("最低点", " low")} ${money(value)} · ${pointTime(d[i].time)}`;
    };
  point(high, hiI, highValue(d[hiI]), "high");
  point(low, loI, lowValue(d[loI]), "low");
};

/* 顶部版本信息与用户选定的数据源刻意解耦 / Header version is deliberately independent from the selected market source. */
(() => {
  const controls = document.querySelector("main>header .controls");
  if (!controls || $("appVersion")) return;
  const version = document.createElement("button");
  version.type = "button";
  version.id = "appVersion";
  version.textContent = "v2.12.79";
  version.title = "查看更新日志";
  version.setAttribute("aria-expanded", "false");
  // v2.12.7：版本号随「账户 / API / 连通性 / 数据源」一起收进设置齿轮面板。
  const settingsHost = $("headerSettingsPanel") || controls;
  const sourceLabel = settingsHost.querySelector("label");
  if (sourceLabel) settingsHost.insertBefore(version, sourceLabel);
  else settingsHost.prepend(version);
  const log = document.createElement("section");
  log.id = "versionChangelog";
  log.hidden = true;
  log.innerHTML = `<b>v2.0.1 更新日志</b><dl><dt>情绪加载</dt><dd>情绪指数首屏优先从 SQLite 读取最近一次成功数据，再自动请求 Alternative.me 新数据替换。</dd><dt>失败重试</dt><dd>情绪源失败时显示“暂不可用＋重试”，并约 30 秒后自动重试；刷新频率改为 2 分钟。</dd><dt>连通性测试</dt><dd>改为页面打开 5 秒后自动执行，OKX WebSocket 作为第一项。</dd><dt>连通性检测</dt><dd>从原先市场／历史样本扩展到 10 项，加入 Alternative.me、Fed/BLS、Yahoo、CoinGecko、CoinLore 宏观数据链路。</dd><dt>微观结构</dt><dd>卡片中的长数值不再被省略；压缩字号与间距，必要时换行完整显示。</dd><dt>页面布局</dt><dd>OKX 微观结构移到多周期概率预测上方；周期涨幅紧跟微观结构；移除了无意义空白。</dd><dt>卡片对齐</dt><dd>多周期概率预测卡与恐惧&贪婪指数卡在桌面端底边齐平。</dd></dl><hr><b>v2.0.0 新增／更新</b><dl><dt>OKX 微观结构</dt><dd>新增盘口失衡、主动成交比、持仓量 OI、资金费率趋势、永续价差；基于至少两项同向证据给出短线研究结论。</dd><dt>实时数据</dt><dd>OKX WebSocket 新订阅盘口前五档与成交数据；计算近 60 秒主动买卖流；保存 OI、资金费率、盘口和成交快照以支持趋势比较。</dd><dt>情绪指标</dt><dd>新增恐惧&贪婪仪表盘、五档情绪解释，并在指标明细中显示情绪读数。</dd><dt>宏观监控</dt><dd>新增 BTC × 美联储监控：FOMC、CPI、非农日历及倒计时；增加黄金、美元指数、BTC 市值占比、加密总市值和成交额等公开环境指标。</dd><dt>周期涨幅</dt><dd>从较短周期扩展为：5 分钟、15 分钟、1 小时、4 小时、1 日、2 日、1 周、1 月、半年；改为按相应 K 线历史精确取值。</dd><dt>预测与持仓</dt><dd>补充 15 分钟与 24 小时方向预测展示；增加个人持仓参考／价差相关展示。</dd><dt>页面布局</dt><dd>重构为桌面双栏终端式布局；手机端优先展示规则信号；图表、预测、微观结构和周期涨幅重新编排。</dd><dt>可用性</dt><dd>新增全局说明浮层、版本更新日志入口；修复窗口缩放时周期涨幅跳位、贪婪卡片尺寸突变、说明浮层遮挡、顶部行情文字重叠等问题。</dd><dt>数据存储</dt><dd>SQLite 新增衍生品快照、情绪快照、宏观快照、美联储日历快照，并设置相应保留期和索引。</dd></dl>`;
  // v2.1.0 只追加相对 v2.0.1 的变更，后续保留完整旧版记录以便追溯。
  // v2.1.0 contains only changes since v2.0.1; prior release notes remain intact for traceability.
  const legacyChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.1.0 更新日志</b><dl><dt>多因子研究预测</dt><dd>新增 BTC 多因子研究预测：融合 SQLite 历史样本、公开 BTC 新闻情绪、恐惧&贪婪指数与 OKX 市场结构，覆盖 15 分钟、1 小时、4 小时、1 日方向与价格区间研究。</dd><dt>概率融合与记分卡</dt><dd>加入时间顺序融合、Platt 概率校准、跨周期一致性约束；展示验证准确率、Brier 分数、已结算实时命中率与待结算预测。</dd><dt>新闻研究</dt><dd>重点新闻支持点击原文，按利好／利空影响排序并按标题相似度去重；显示近 2 小时与近 24 小时窗口，默认最多 6 篇。</dd><dt>宏观日历存储</dt><dd>FOMC、CPI 与非农日历写入 SQLite；首屏优先读取最近成功快照，再后台请求 Federal Reserve／BLS 更新。修正非农日期解析，并在官方源不可达时明确标记发布节奏回退。</dd><dt>数据透明度</dt><dd>所有依赖外部或 SQLite 数据的卡片新增“数据源 · 更新频率”标识，便于确认来源、缓存策略与数据新鲜度。</dd><dt>图表体验</dt><dd>图表工具与显示控制左对齐；新增 15 分钟查看范围；默认改为 1 分钟 K 线与 6 小时查看范围，并支持完整加载该窗口。</dd><dt>持仓与风险研究</dt><dd>完善双持仓参考、方向选择持久化、盈亏颜色提示与强平概率研究输入；长数值保持完整显示，必要时自动换行。</dd><dt>移动端可用性</dt><dd>修复小屏幕说明感叹号的拉伸变形，并优化数据卡片、工具栏与研究卡片的换行和溢出表现。</dd></dl><hr>${legacyChangelog}`;
  const v21Changelog = log.innerHTML;
  log.innerHTML = `<b>v2.2.0 更新日志</b><dl><dt>账户与云端服务</dt><dd>新增注册与登录入口。账户可保存个人买入价、多空方向、云端推送凭证与规则，换浏览器登录同一账户即可恢复。</dd><dt>关页持续推送</dt><dd>新增服务端 BTC 行情监听、规则检查与异步推送队列；云端接管的规则在网页关闭后仍持续监测并推送到微信。</dd><dt>统一 SendKey 操作</dt><dd>消息推送区改为唯一 SendKey 输入框：未登录时仅保存／测试本机；登录后同一入口加密保存到云端，测试优先由服务器提交。</dd><dt>本机迁移云端</dt><dd>保留“同步本机规则到云端”操作，便于中途登录后把已有提醒迁移为后台执行；规则明确标识“本地触发”或“云端接管”。</dd><dt>个人买入价图表</dt><dd>已设置的做多／做空买入价会显示为主图横向虚线：做多为青绿色、做空为红色，附带方向与价格标签和自动图例；未设置则不显示。</dd><dt>提醒体验</dt><dd>新增统一悬浮提示与确认弹层；规则默认“仅提醒一次”，记录已执行时间和实时价格，并支持批量删除与规则测试。</dd></dl><hr>${v21Changelog}`;
  const v22Changelog = log.innerHTML;
  log.innerHTML = `<b>v2.3.0 更新日志</b><dl><dt>秒级 K 线</dt><dd>继续使用 OKX 数据源，基于实时成交在本地聚合 5 秒、10 秒与 30 秒 K 线；秒级视图会随行情近实时更新。</dd><dt>图表与周期控制</dt><dd>K 线周期与查看范围完全解耦，切换其中一项不会改写另一项；修正鼠标十字线与光标位置对齐。远离市场区间的个人买入价改为图表顶部／底部标注，避免压缩走势。</dd><dt>OKX 行情栏</dt><dd>移除币安来源，仅保留 OKX；实时行情置于顶部时间栏右侧并标注“来源：OKX”。</dd><dt>语音播报</dt><dd>新增语音总开关、快捷喇叭入口、提示音样式与独立音量；支持中英文播报与多种中文／美式英文 Edge 神经音色。</dd><dt>语音规则</dt><dd>新增价格到达、累计涨跌、短时急涨急跌、与前一次报价变动、做多／做空爆仓价等规则；支持上涨、下跌或双向、单次／重复、冷却时间及重新编辑。</dd><dt>持仓语境</dt><dd>播报实时价时会显示并结合已设置的多空买入价计算涨跌；未设置持仓则不显示。</dd></dl><hr>${v22Changelog}`;
  const v23Changelog = log.innerHTML;
  const v24Changelog = `<b>v2.4.0 更新日志</b><dl><dt>语音接力播报</dt><dd>语音设置、规则、音色与持仓参考同步持久化到本机服务端；页面每 5 秒发送心跳，关闭或挂起超过 60 秒后由服务端按相同规则继续播报，期间触发记录在重新打开页面时回拉刷新。</dd><dt>信号有效区间</dt><dd>规则信号卡新增 ATR 作废／兑现参考带与现价位置刻度：价格在带内信号保持有效，越过作废边界后信号灰显并提示失效；取代原先静态的 ATR 止盈止损读数。</dd><dt>溢价指数</dt><dd>新增 OKX 永续相对现货的溢价指数（每 30 秒刷新），作为杠杆拥挤过滤进入微观结构与追单理由：明显正溢价提示多头成本偏高、负溢价提示空头拥挤。</dd><dt>美股实时状态</dt><dd>顶部时间栏新增北京时间与纽约时间及纽交所开闭市状态；美股盘中自动展示 SPY、QQQ 实时价格与涨跌，数据源不可用时整行隐藏而不渲染空行情。</dd><dt>长期图表修复</dt><dd>OKX 历史 K 线超过单页上限（300 根）时改为按页回溯拼接，1 年／6 个月等长周期不再被静默截短，图表覆盖范围与页面声明一致。</dd><dt>宏观日历增强</dt><dd>事件进入发布窗口（前后 15 分钟）时自动高频刷新；FOMC、CPI 与非农在公布后 24 小时内保持可见，非农自动回填 BLS 官方实际值。</dd><dt>盘口价差</dt><dd>订单簿快照新增买卖价差（bps）度量并纳入微观结构参考。</dd><dt>稳定性与缓存</dt><dd>未处理异常／Promise 拒绝只记录日志，不再拖垮整个行情服务；每个请求带统一兜底错误返回；Server 酱推送统一 8 秒超时避免挂起投递循环；空闲数据库连接异常受控监听；带版本号的静态资源启用一年强缓存，其余按需刷新。</dd><dt>前端架构</dt><dd>面板归属集中登记到统一注册中心（BTCPanels）；决策层、固定规则信号与指标明细改由有序增强器队列扩展，不再覆写旧渲染函数或跨模块挪动 DOM；研究型回测与联动卡不再依赖固定 DOM 锚点，改为数据就绪后动态挂载；样式按 tokens／base／layout／components／responsive／foundation 分模块渐进拆分。</dd></dl><hr>${v23Changelog}`;
  log.innerHTML = `<b>v2.4.1 更新日志</b><dl><dt>RSI × 成交量叠显</dt><dd>RSI 曲线与成交量柱改为同区域叠显：成交量柱垫底、RSI 线叠上层；点击柱状图凸显量、点 RSI 线压暗量，悬浮竖虚线贯穿主图与子图。</dd><dt>我的持仓编辑升级</dt><dd>编辑表单扩为四字段（持仓量／开仓均价／保证金／杠杆），手动杠杆优先、留空自动推导；新增保存／取消／清除三按钮与双击编辑；自动计算杠杆、未实现盈亏、收益率、保证金回报与理论强平价；两持仓槽支持拖拽互换位置。</dd><dt>图表线条配色统一</dt><dd>图例色块与线条颜色对齐：布林带保持灰、VWAP 改品红、RSI 改中性白，消除与红绿柱撞色。</dd><dt>语音播报体验</dt><dd>「播报中」标签移到按钮右侧；语音规则三栏可拖拽调宽；原生勾选改为 iOS 风格拨钮；播报优先级支持拖拽排序，标签与「播报条件」文案对齐。</dd><dt>综合信号状态说明</dt><dd>「当前规则信号」标题新增帮助按钮，展开 5 种信号状态（做多绿／做空红）的完整说明与速查口诀：带数字＝已确认最强；带「待收盘」＝观察期；带「趋势」无数字＝弱确认。</dd><dt>更新日志折叠</dt><dd>所有旧版本（含 v2.0.0）默认收起，打开日志首先看到当前版本完整变更。</dd><dt>连通性测试修复</dt><dd>顶部连通性按钮的分数不再重复显示（原 JS 文本与 CSS 伪元素各显示一次）。</dd><dt>后端数据链路</dt><dd>持仓档案同步支持持仓量／保证金／杠杆；OKX 改用 history-candles 端点并分页回溯，1 年／6 个月等长周期 K 线不再静默截短；3 小时 K 线聚合拉足量 1 小时数据以预热 EMA200；新增服务端规则评分精确复算；服务端语音接力默认关闭，播报改由浏览器接管。</dd></dl><hr>${v24Changelog}`;
  // v2.5.0：AI 行情助手（千问）整条链路启用，并补上 API 接入中心、本机凭据加密与云端密文升级。
  // v2.5.0 ships the Qwen assistant end to end, plus API Center, the encrypted local
  // vault and the hardened cloud ciphertext envelope.
  const v25Changelog = log.innerHTML;
  log.innerHTML = `<b>v2.8.4 更新日志</b><dl><dt>投资日历勾选联动未来的宏观日历</dt><dd>「投资日历」每条事件右上角新增「关注」勾选；勾选后的事件会显示在「宏观与情绪」卡右侧「未来的宏观日历」里，最多 3 个，最近事件大字、其余两个紧凑小字。</dd><dt>恐惧贪婪下方实时回填</dt><dd>左侧恐惧贪婪小卡片下方新增「关注事件 · 实时数据」：已勾选事件中最近的一个，一旦公布就自动回填实际值并显示「利好 BTC / 利空 BTC / 符合预期」标签；未公布时显示倒计时与预期／前值。</dd><dt>判断逻辑</dt><dd>按「公布值 vs 预期」的预期差推断方向（通胀／利率高于预期 → 利空 BTC 等），并给出简要说明；属经验规律，非确定性结论。事件公布时自动重取投资日历刷新实际值。</dd></dl><hr>` + `<b>v2.8.3 更新日志</b><dl><dt>重大事件卡片移入投资日历</dt><dd>把「重大事件」卡片从 K 线图框选悬浮层迁移到投资日历模块内部常驻显示，夹在筛选器与时钟/风险条之间，无需框选即可直接看到高影响事件。</dd><dt>内容展示</dt><dd>小卡片显示事件名称、重要性点、影响权重、北京时间、事件当地时间、倒计时；数值类事件给出预期／前值；并给出利好 BTC / 利空 BTC / 中性的编辑性预判，以及「公布值 vs 预期」预期差推断的说明，属非确定性结论。</dd><dt>数据源</dt><dd>手工维护的 MAJOR_EVENTS（如美国《清晰法案》投票、战略比特币储备等定性／政策事件）与投资日历里 importance=high 的宏观／加密事件自动合并去重；手工事件优先展示，避免被近端宏观数据挤出。</dd><dt>样式</dt><dd>采用卡片式横幅，最多 4 个小卡片横向排列，带彩色左边框（利好青绿／利空红／中性灰），小屏幕自动改为单列。</dd></dl><hr>` + `<b>v2.8.2 更新日志</b><dl><dt>重大事件卡片</dt><dd>框选图表时，在两条框选线之间浮现「重大事件」卡片，只列对比特币影响权重高的事件：手工维护的 MAJOR_EVENTS（如美国《清晰法案》投票等定性／政策事件）与投资日历里 importance=high 的宏观／加密事件（含预期／前值，自动合并去重）。</dd><dt>内容展示</dt><dd>每条显示事件名称、北京时间、事件当地时间与倒计时；数值类事件给出预期／前值；并给出编辑性预判与「公布值 vs 预期」预期差推断的利好／利空／中性标签，以及「预计高于／低于预期」的判断说明，属非确定性结论。</dd><dt>筛选与定位</dt><dd>仅在框选区间命中时显示对应事件；若区间内无重大事件则回退展示近期即将发生的重大事件并标注提示。卡片夹在两条框选线中间、顶部对齐，超出图表左右边界时自动夹紧。</dd></dl><hr>` + `<b>v2.8.1 更新日志</b><dl><dt>宏观与情绪三区分栏</dt><dd>「宏观与情绪」卡改为三块布局：左上恐惧贪婪（进一步缩小）、左下「已公布数据」（实际值公布后实时回填）、右侧整块承载「未来的宏观日历」（倒计时＋预期／前值／实际）与「实时数据·利好利空」（高重要性事件对 BTC／原油／美股／黄金的方向）。</dd><dt>重要性筛选点标注</dt><dd>投资日历筛选菜单内的重要性红点／黄点补上颜色与「高／重要／低」文字标签，不再只是无名圆点。</dd><dt>热点新闻面板移除</dt><dd>应要求从「宏观与情绪」卡移除「热点新闻」面板（含下方标签）；/api/news 接口与渲染函数保留备用，不再自动拉取。</dd><dt>倒计时与实时回填</dt><dd>宏观事件进入发布窗口时倒计时归零，并自动重取投资日历、回填实际值、重新计算利空／利好标签；倒计时每 30 秒刷新。</dd><dt>十字定位与框选体验</dt><dd>修复放大后十字定位点提前钳制「卡在一条线」的问题：绘图区与十字线共用 chartPlotGeom 几何，可一路跟到价格区底部；框选遮罩由 blur(12px)/0.72 调浅为 blur(4px)/0.45，不再盖住成交量柱。</dd></dl><hr>` + `<b>v2.8.0 更新日志</b><dl><dt>时间筛选与默认折叠</dt><dd>投资日历新增时间范围筛选：昨天／今天／明天／本周／下周／自定义日期／全部，默认停在「今天」，只展示最近的事件，不再一次性铺开全部条目；自定义区间可选起止日期（按北京日计算）。</dd><dt>筛选器整合</dt><dd>把原先混在一起的「全部／高重要／宏观／流动性…」胶囊拆分为三个多选筛选器——国家及地区、类别领域、重要性，与财经日历一致：支持搜索、全选与全部清除，选项按当前时间窗统计条数并可叠加使用；筛选器可一键隐藏。</dd><dt>时间与排序</dt><dd>统一按北京时间排序与分组，主时间显示北京的几号几点，下方小字注明事件发生的当地时间（可切换当地／美东／UTC）；副信息条新增实时北京时间。为让「昨天／本周」有数据，服务端历史窗口由仅未来扩展为保留近 4 天并放宽条数上限。</dd><dt>数据列加宽</dt><dd>今值／预期／前值拆为三列独立对齐（每条各占一列，表头对齐），列宽大幅增加并允许两行显示，不再出现数值被裁切隐藏；同时把末尾「影响（流动性观察）」列收窄。</dd><dt>数据公布影响预测</dt><dd>日历末尾新增「数据公布影响预测」板块：取未来两周最重要且带方向映射的数据（通胀、利率、失业率、就业、增长、原油库存），用「高于预期／低于预期」两种情景列出比特币、原油、美股、黄金的利好／利空／中性；已公布的事件按实际值与预期的偏差高亮命中的那一行。属宏观常识映射，非确定性结论。</dd><dt>界面风格</dt><dd>事件行加入国家旗帜标识与彩色领域标签（宏观／流动性／能源／避险／加密期权／BTC 链上），新增列标题行；卡片配色改为卡片级变量锁定，不再受外层明暗主题影响。</dd></dl><hr>` + `<b>v2.7.2 更新日志</b><dl><dt>宏观与情绪重构</dt><dd>「近期宏观日历」与投资日历联动：按相关性取近期最重要的事件，逐条显示预期值与前值，公布后自动回填实际值，并给出利空／利好 BTC 的方向标签（按公布值相对预期的偏差推断，非确定性判断）。</dd><dt>恐惧贪婪瘦身</dt><dd>恐惧贪婪改为紧凑小卡，并加入 0–100 情绪刻度条；腾出的空间用于宏观数据对比与热点新闻。</dd><dt>热点新闻</dt><dd>新增「热点新闻」面板，展示可能影响 BTC 走势的实时头条（Google News RSS），按利好／利空／中性标注，并显示来源与发布时间；新增 /api/news 接口。</dd></dl><hr>` + `<b>v2.7.1 更新日志</b><dl><dt>时间显示本地化</dt><dd>投资日历主时间固定显示为北京时间（日期＋几点钟），并新增小字参考行显示事件发生的当地时间；可通过顶部「当地／美东／UTC」切换参考时区，默认「当地」。</dd><dt>修复 9/11 美国 CPI 漏显</dt><dd>数据原本存在于东方财富与 FinanceCalendar 源中，但因服务端硬切片 48 条且未来事件未优先，导致同日关键发布被挤掉。已提升上限、未来事件优先排序，并把 CPI／PPI／非农等同一发布的多个指标变体合并为单一 recognizable 标题。</dd><dt>界面留白优化</dt><dd>投资日历卡片、标题区、工具栏、事件行与页脚的 padding 与间距整体加大，避免文字贴边。</dd></dl><hr>` + `<b>v2.7.0 更新日志</b><dl><dt>投资日历国家筛选</dt><dd>顶部新增国家／地区下拉筛选，选项按当前事件动态生成（美国、中国、欧元区、日本、英国等），与分类筛选、时区切换相互独立、可叠加使用。</dd><dt>新增免费数据源</dt><dd>东方财富主源之外接入 TradingView 与 FinanceCalendar 两个免 Key 全球宏观日历：前者回填实际值／预期／前值并补充个别未覆盖的发布，后者补充美联储／央行决议与关键数据；跨源按「国家＋指标＋日期」签名去重，避免重复事件。</dd></dl><hr>` + `<b>v2.6.0 更新日志</b><dl><dt>投资日历数据源</dt><dd>数据源替换为东方财富（数据研究中心）免费公开接口，覆盖全球主要经济体数据发布、央行决议与重要会议，无需 API Key、调用稳定；美联储／BLS 官方日程作为补充并回填已公布数值，财政部、EIA、Deribit、mempool 等原有源全部保留。原 Finnhub 付费增强路径下线（其密钥仍用于 AI 助手）。</dd><dt>投资日历界面</dt><dd>从默认表格重做为按日分组的卡片列表：新增国家／地区色标、重要性圆点、今值／预期／前值指标块、实时倒计时胶囊与风险窗口提醒；筛选胶囊与时间轴（北京时间／美东／UTC）重新排布，移动端自适应折叠。</dd><dt>重要性重算</dt><dd>东方财富原始“重要”标签偏向会议论坛，已改为按 BTC 宏观相关性重排：CPI、非农、失业率、PCE、GDP、零售销售、央行利率决议等标记为高重要，真正驱动风险窗口的事件才会进入高重要筛选与风险提醒。</dd></dl><hr>` + `<b>v2.5.0 更新日志</b><dl><dt>AI 行情助手</dt><dd>页面右下角新增悬浮对话窗：把你正在看的数据（各周期 K 线与 EMA／MACD／RSI／布林带／ATR、资金费率与基差、持仓量、恐惧&贪婪指数、美联储与宏观日程）整理成结构化快照交给千问，回答固定按【结论】【为什么这么判断】【关键价位】【什么情况说明我判断错了】【风险提醒】五段呈现，并以打字机效果流式输出。</dd><dt>回答模式</dt><dd>可选「通俗／中等／专业」三档语气，只改讲法不改数据：通俗档完全不用术语（RSI 说成“衡量抢着买还是抢着卖的指标”，支撑叫“地板”、阻力叫“天花板”）；中等档术语首次出现配一句白话解释；专业档直接给指标读数与日线／4 小时／1 小时分周期结构，并要求给出失效条件与情景概率。与「快速／深度」互相独立，选择记在本机。</dd><dt>思考模式与模型选择</dt><dd>快速档关闭模型思考（实测约 20 秒出结果），深度档保留推理并限制长度（约 55 秒）；模型可在 Token Plan 列出的 5 个文本型号间切换，默认性价比档 qwen3.8-flash（成本约为旗舰的 1/15），图片与语音型号置灰不可选；已把旧版硬编码的旗舰默认值一次性迁移到性价比档，用户后续自选的型号不会被覆盖。</dd><dt>额度面板</dt><dd>对话窗顶部显示额度进度条、重置倒计时与最近 10 次调用明细，累计用量写入 data/ai-quota.json，重启不归零。千问兼容端点不返回实时额度响应头，面板数值为按模型换算的本地估算，精确剩余仍以控制台为准。</dd><dt>API 接入中心</dt><dd>右上角新增浮层，集中管理第三方密钥（千问为 Key＋端点＋模型三件套），支持更新、验证与清除；服务端以 AES-256-GCM 加密落盘，浏览器始终拿不到明文 Key。云端账户服务不可用时，千问这类纯本机配置仍可保存与验证，不再被登录态连坐。</dd><dt>本机凭据加密存储</dt><dd>推送 Key、提醒规则与 API 配置改由浏览器 IndexedDB 中不可导出的 AES-GCM 密钥加密，localStorage 不再存明文；退出登录时可选择“保留加密副本”或“彻底清除本机副本”。账户卡新增「一键同步全部」，把持仓资料、推送规则与本会话 SendKey 一次同步到云端。</dd><dt>云端账户加密升级</dt><dd>账户密文改为带版本前缀的认证信封，并把密文与用户、用途绑定——即使数据库行被复制到其它账户也无法解密；个人档案新增独立加密列；服务端推送任务不再携带 SendKey，改为投递前从加密记录中读取。</dd><dt>宏观与投资日历</dt><dd>新增投资日历接口，可选接入 Finnhub（共识／实际值／前值）、EIA 石油库存与 CoinGecko 增强数据，密钥只留在服务端；未配置增强源时，官方公开日历照常可用。</dd><dt>部署与生态</dt><dd>Caddy 入口新增 HSTS、X-Content-Type-Options 与 Referrer-Policy 响应头；附带 mcp-server.mjs，把价格、指标、情绪、宏观日历与完整快照暴露为 5 个 MCP 工具，供桌面端 AI 直接取数而不重复采集。</dd></dl><hr>${v25Changelog}`;
  // v2.8.5：悬浮按钮动效 + 聊天窗口跟随打开/八向缩放 + 联网检索 + 信息展示优化。
  const v284Changelog = log.innerHTML;
  log.innerHTML = `<b>v2.8.5 更新日志</b><dl><dt>悬浮按钮动效</dt><dd>AI 助手悬浮按钮新增外发光脉冲与双层波纹扩散光效，未打开前持续吸引注意；首次打开后自动收起为柔和微光并隐藏提示气泡。</dd><dt>聊天窗口跟随打开</dt><dd>点击悬浮按钮时聊天窗口跟随按钮当前位置弹出（按屏幕半区上下翻转、贴边夹取），不再固定右下角。</dd><dt>八向缩放</dt><dd>聊天窗口支持拖动四条边框单独拉伸宽／高、拖动四个角同时改变宽高，最小 320×340，尺寸记忆在本机。</dd><dt>联网检索</dt><dd>提问时一并搜索公开新闻与分析（Google News RSS，按比特币相关度与时效打分去重），回答末尾展示来源清单、条数与耗时，可一键开／关，关闭后仅用本站实时数据。</dd><dt>信息展示优化</dt><dd>重点数据加粗与高亮，回答以清晰罗列排版；图表仅在能更简明解释时才生成（最多一张柱状／折线），不强制每次使用。</dd><dt>框选数据常驻</dt><dd>拖拽框选后「框选时间段 · 最高 · 最低 · 区间涨跌」不再因鼠标移出图表而消失：移出只收起十字线与「重大事件」浮层，数据卡与底部提示保留在屏幕上，只有双击图表、切换周期／范围／数据源或平移时才清除；实时价缺失时退回最后一根收盘计算，避免整卡凭空消失。</dd></dl><hr>` + v284Changelog;
  // v2.8.6：投资日历勾选联动优化，未勾选时不自动填充未来的宏观日历。
  const v285Changelog = log.innerHTML;
  log.innerHTML = `<b>v2.8.6 更新日志</b><dl><dt>未来的宏观日历只显示勾选事件</dt><dd>未在投资日历勾选任何事件时，「宏观与情绪」卡右侧「未来的宏观日历」不再自动用高重要性宏观事件填充，保持空白并提示用户去投资日历勾选；只有勾选的未来事件才会出现在这里。</dd><dt>恐惧贪婪下方只显示最近勾选事件</dt><dd>左侧恐惧贪婪小卡片下方的「关注事件 · 实时数据」同样只在有勾选事件时显示内容；未勾选时仅显示引导提示，不展示任何未来或已公布数据。</dd><dt>排序与显示规则不变</dt><dd>勾选后仍最多显示 3 个，最近时间的未来事件大字置顶，其余小字紧凑排列；已公布的最近勾选事件会自动回填实际值并显示利好／利空标签。</dd></dl><hr>` + v285Changelog;
  // v2.8.7：修复聊天窗口打开位置不跟随主按钮、悬浮按钮动效过弱两个问题。
  const v286Changelog = log.innerHTML;
  log.innerHTML = `<b>v2.8.7 更新日志</b><dl><dt>聊天窗口紧贴按钮</dt><dd>修复「按钮在左上、聊天框却弹在右下」的问题：打开聊天窗时按按钮当前位置实时定位，优先贴在按钮正上／正下方并与按钮左缘或右缘对齐；纵向放不下时改为贴着按钮左右并排，都放不下才夹进视口。按钮被拖走后已打开的窗口会立即跟着贴过去，浏览器窗口尺寸变化时也会重新贴合，不再固定右下角。</dd><dt>悬浮按钮动效增强</dt><dd>按钮动效改为持续可见：外发光在紫／青之间呼吸并大幅提高亮度，双圈波纹改为发光圆环向外扩散，圆点做变色跳动；首次打开后只收敛一档（波纹更慢更淡），不再完全关闭动效，确保按钮始终能引起注意。</dd><dt>点击不再被手抖吞掉</dt><dd>原先指针只要挪动 1 像素就被判定为拖动，导致随后 350 毫秒内的点击不生效、按钮点不开。改为位移超过 4 像素才算拖动，正常点击稳定开合，拖动时也不再无谓打断动效。</dd></dl><hr>` + v286Changelog;
  // v2.8.8：修正重大事件《清晰法案》投票院别与日期；并修复 AI 助手提问气泡文字配色、隐藏右下角缩放角标。
  const v287Changelog = log.innerHTML;
  log.innerHTML = `<b>v2.8.8 更新日志</b><dl><dt>重大事件数据修正</dt><dd>修正美国《清晰法案》(CLARITY Act) 事件描述：由众议院投票改为参议院先投票，日期由 9 月 25 日更新为 9 月 15 日；确保投资日历「重大事件」与投资日历/宏观情绪模块正确显示最近优先级。</dd><dt>提问气泡文字清晰可见</dt><dd>修复自己发出的提问在气泡里几乎看不清的问题：站点全局的段落配色会盖掉气泡继承的深色文字，现对气泡内的段落、加粗、数字等元素显式指定深色字色，数字标签底色一并加深，在浅紫底上对比清晰。</dd><dt>隐藏右下角缩放角标</dt><dd>聊天窗口右下角那个可见的缩放「小角」标记已隐藏，只保留透明拖拽热区；按住右下角仍可同时调整宽高，四条边框缩放不受影响。</dd></dl><hr>` + v287Changelog;
  // v2.8.9：修正 OKX 市场微观结构卡「偏多／偏空」标签与大数值的涨跌配色。
  const v288Changelog = log.innerHTML;
  log.innerHTML = `<b>v2.8.9 更新日志</b><dl><dt>微观结构涨跌配色修正</dt><dd>OKX 市场微观结构卡里「偏多 / 偏空」标签及右侧大数值的颜色此前标反了（偏多显示为红、偏空显示为绿）。现统一为全站口径：偏多用绿、偏空用红，并与本卡下方进度条、顶部「短线研究偏多 / 偏空」结论条保持一致。</dd></dl><hr>` + v288Changelog;
  // v2.9.0：宏观与情绪模块拆分，已公布数据独立成卡，移除实时利好利空。
  const v289Changelog = log.innerHTML;
  log.innerHTML = `<b>v2.9.0 更新日志</b><dl><dt>已公布数据独立成卡</dt><dd>将「宏观与情绪」卡左下角的「已公布数据」模块拆出，成为紧跟其后的独立卡片；桌面端以两列网格展示，移动端单列，空间更充裕，便于浏览近期已公布实际值。</dd><dt>移除实时数据·利好利空</dt><dd>从「宏观与情绪」卡右下角移除「实时数据 · 利好利空」模块及其说明注脚，减少右侧信息堆叠。</dd><dt>宏观与情绪保留内容</dt><dd>该卡现在只保留左侧「恐惧贪婪」+「关注事件 · 实时数据（最近勾选）」，右侧「未来的宏观日历」。</dd></dl><hr>` + v289Changelog;
  // v2.9.1：宏观经济数据卡片重命名并调整位置到「BTC 多因子研究」与「投资日历」之间。
  const v290Changelog = log.innerHTML;
  log.innerHTML = `<b>v2.9.1 更新日志</b><dl><dt>宏观经济数据重命名与定位</dt><dd>将「已公布数据」卡片重命名为「宏观经济数据」，并移动到「BTC 多因子研究」与「投资日历」之间；空态提示同步更新，阅读顺序更符合逻辑。</dd></dl><hr>` + v290Changelog;
  // v2.9.2：修复「宏观与情绪」卡片反复闪烁（被 responsive arrange 反复清出/插回）。
  const v291Changelog = log.innerHTML;
  log.innerHTML = `<b>v2.9.2 更新日志</b><dl><dt>修复宏观与情绪卡片闪烁</dt><dd>「宏观与情绪」卡此前会周期性消失再出现：定位逻辑把卡片误移入右侧 side-stack，而 responsive arrange() 每次都会用 replaceChildren 清空 side-stack，导致卡片被反复移除又重建。现统一把该卡固定到主流程（投资日历之后），确保不会被 side-stack 清空。</dd></dl><hr>` + v291Changelog;
  // v2.9.3：AI 助手四项能力 + 长截图导出修复。
  const v292Changelog = log.innerHTML;
  log.innerHTML = `<b>v2.9.3 更新日志</b><dl><dt>AI 助手：对话管理 / 历史 / 上下文 / 字号 / 长截图</dt><dd>新增「新建对话」（自动归档上一段）、「历史对话」浮层（可切回任意历史对话并带回上下文）、多轮上下文记忆（追问不断联）、正文字号缩放（A−/A＋，本地记忆），以及「长截图」导出整段对话为 PNG（含复制到剪贴板）。修复长截图在 Chromium 下因 foreignObject 污染画布导致导出失败的问题，改用 html2canvas 逐节点重绘（画布不再被判定为污染）。</dd><dt>提问气泡美化 + 字号缩放范围扩大</dt><dd>我发出的提问气泡改为紫罗兰渐变 + 白字 + 右下小圆角（含柔和投影），字号比回答小一档（12px），气泡内不再多留空白；发送键同款配色。字号缩放范围由 85%–160% 扩大到 50%–200%，缩小档位更密（每次 10%），并把范围写进按钮提示。</dd></dl><hr>` + v292Changelog;
  // v2.9.5：框选 K 线时「重大事件」浮层改为默认关闭，并可在图表设置里手动开启。
  const v293Changelog = log.innerHTML;
  log.innerHTML = `<b>v2.9.5 更新日志</b><dl><dt>框选重大事件可开关</dt><dd>顶部「图表」设置面板新增「框选重大事件」开关，默认关闭；关闭后拖拽框选 K 线时不再弹出「重大事件」浮层，避免遮挡走势。需要查看框选区间事件时可手动打开。</dd></dl><hr>` + v293Changelog;
  // v2.9.6：把「宏观与情绪」卡片放回右侧 side-stack，并修复反复闪烁。
  const v294Changelog = log.innerHTML;
  log.innerHTML = `<b>v2.9.6 更新日志</b><dl><dt>宏观与情绪回归右侧栏</dt><dd>「宏观与情绪」卡片现在重新显示在桌面端右侧边栏（当前规则信号下方），而不是被挤到主流程底部；右侧空白区域不再丢失该模块。</dd><dt>修复闪烁与消失</dt><dd>彻底解决刷新后卡片「闪一下又消失」的问题：responsive arrange() 现在会主动保留 side-stack 中的宏观与情绪卡片，移动端则自动把它移出隐藏的 side-stack 并放在终端布局之后，避免被隐藏或反复移除。</dd><dt>窄栏自适应单列</dt><dd>当宏观与情绪位于右侧窄栏时，内部自动切换为单列竖排（恐惧贪婪 → 关注事件 → 未来日历），避免两列在窄栏里被压成不可读的小块。</dd></dl><hr>` + v294Changelog;
  // v2.10.0：把「数据公布影响预测」小卡片移入「宏观经济数据」，矩阵保留 BTC、加密货币、美股、黄金并突出 BTC 字体。
  const v295Changelog = log.innerHTML;
  log.innerHTML = `<b>v2.10.0 更新日志</b><dl><dt>数据公布影响预测移入宏观经济数据</dt><dd>把「投资日历」底部的「数据公布影响预测」小卡片移到「宏观经济数据」卡片内，统一浏览入口；移除投资日历底部的该模块。</dd><dt>重要等级显示</dt><dd>影响预测卡片与已公布实际值卡片均显示事件的重要等级（高/中/低）。</dd><dt>矩阵去原油、加加密货币、突出比特币</dt><dd>影响矩阵的情景列只保留比特币、加密货币、美股、黄金，移除原油；比特币列字号放大、其他列字号缩小，优先阅读 BTC 方向。</dd></dl><hr>` + v295Changelog;
  // v2.10.1：修复「历史对话」点了没反应（点击冒泡到全局收起浮层）；历史列表补可点提示。
  const v296Changelog = log.innerHTML;
  log.innerHTML = `<b>v2.10.1 更新日志</b><dl><dt>历史对话可以点开继续问了</dt><dd>修复「历史对话」按钮点了没反应的 bug：按钮自身的点击会继续冒泡到页面级的「点别处收起浮层」监听，导致刚打开的历史列表被立刻关掉（历史条数角标在涨、列表却打不开）。现在按钮点击不再冒泡，列表正常展开。</dd><dt>列表每行补上可点提示</dt><dd>历史列表里每一段对话右侧新增「›」箭头，悬浮按钮时高亮，并提示「切回这段对话，接着提问」；点进去会完整回放当时的问答（含联网来源回执），上下文一并带回，可以直接接着追问，不会另起一段。</dd><dt>切回提示更明确</dt><dd>切回历史对话后的提示改为「已切回历史对话（N 条消息），可以直接接着提问」。</dd></dl><hr>` + v296Changelog;
  // v2.10.2：彻底移除 K 线图框选「重大事件」浮层，简化图表交互。
  const v2101Changelog = log.innerHTML;
  log.innerHTML = `<b>v2.10.2 更新日志</b><dl><dt>移除框选重大事件浮层</dt><dd>删除 K 线框选时浮现的「重大事件」卡片及顶部「图表」设置中的开关；框选只保留时间段、最高、最低与区间涨跌提示，避免遮挡走势，简化交互。</dd></dl><hr>` + v2101Changelog;
  // v2.10.3：RSI 副图动态分区，成交量柱按 K 线密度放大，长周期更易看清涨跌量对比。
  const v2102Changelog = log.innerHTML;
  log.innerHTML = `<b>v2.10.3 更新日志</b><dl><dt>RSI 副图动态分区</dt><dd>根据可见 K 线数量动态划分 RSI 副图：K 线越多，底部成交量区域占比越大（40%→65%），上部 RSI 区域相应压缩，避免长周期下红绿柱被压成细线。</dd><dt>成交量非线性缩放</dt><dd>对成交量柱使用 0.55 次幂缩放，弱化个别巨量柱对整体比例的压制，让多数柱子的涨跌对比更清晰。</dd><dt>主图不变</dt><dd>仅调整底部 RSI 副图内部比例，上方 K 线/指标区域完全不受影响。</dd></dl><hr>` + v2102Changelog;
  const v2103Changelog = log.innerHTML;
  log.innerHTML = `<b>v2.10.4 更新日志</b><dl><dt>周期涨幅桌面单排</dt><dd>OKX 微观结构内的周期涨幅在电脑端始终保持 10 个柱子在同一排，随容器宽度动态缩放；仅在 680px 以下才折为两排（每排 5 个）。</dd><dt>宏观经济数据空状态</dt><dd>当宏观经济数据卡片暂无事件时，空提示居中并增大可读性，避免看起来像一块空白区域。</dd></dl><hr>` + v2103Changelog;
  // v2.10.5：撤销上版的 RSI 副图上下分块，恢复与成交量同区域叠显；0.55 次幂压缩改为仅长周期生效。
  const v2104Changelog = log.innerHTML;
  log.innerHTML = `<b>v2.10.6 更新日志</b><dl><dt>宏观经济数据空态不再留白</dt><dd>当宏观经济数据卡片当前没有任何影响预测或已公布实际值时，卡片不再渲染空 body，只保留标题行；周期涨幅卡片因此紧贴「OKX 市场微观结构」下方，不再出现空白区域。</dd></dl><hr>` + v2104Changelog;
  const v2105Changelog = log.innerHTML;
  log.innerHTML = `<b>v2.10.5 更新日志</b><dl><dt>RSI × 成交量恢复叠显</dt><dd>撤销 v2.10.3 的上下分块，改回原始「同区域叠显」：成交量柱铺满整个副图高度垫底，RSI 曲线叠加在上层，互不遮挡；点击柱状图凸显量、点 RSI 线压暗量，悬浮竖虚线贯穿主图与子图。</dd><dt>幂次压缩按时间跨度区分</dt><dd>0.55 次幂缩放成交量仅在「可见时间跨度大于 12 小时」（长周期／多日）时生效，用于消除个别巨量柱对其他柱子的压制；跨度 12 小时以内（如盯盘用的 6h/3h/1h 区间）保持线性缩放，对交易量的细微变化保持敏感，便于第一时间察觉异动巨量。</dd><dt>主图不变</dt><dd>仅调整底部 RSI 副图内部比例与缩放逻辑，上方 K 线／指标区域完全不受影响。</dd></dl><hr>` + v2105Changelog;
  // v2.10.7：把周期涨幅卡片固定到主 K 线卡片内、紧跟 OKX 微观结构，彻底消除两者之间的空白。
  const v2106Changelog = log.innerHTML;
  log.innerHTML = `<b>v2.10.7 更新日志</b><dl><dt>周期涨幅紧贴 OKX 市场微观结构</dt><dd>把「周期涨幅」卡片从 terminal-layout 的跨行元素改为主 K 线卡片（#mainChartCard）的内部元素，紧跟「OKX 市场微观结构」卡片；避免右侧「宏观与情绪」栏更高时把周期涨幅推下去、在 OKX 下方留下大块空白。现在两者无缝相接。</dd><dt>桌面端始终单排 10 柱</dt><dd>电脑端继续显示 10 个周期柱在同一排，随容器宽度动态缩放；仅当屏幕宽度 ≤680px 时才折为两排（每排 5 个）。</dd></dl><hr>` + v2106Changelog;
  // v2.10.8：宏观经济数据卡片新增筛选器 + 重大事件卡片按日期最近排序。
  const v2107Changelog = log.innerHTML;
  log.innerHTML = `<b>v2.10.8 更新日志</b><dl><dt>宏观经济数据卡片新增筛选器</dt><dd>为「宏观经济数据」卡片增加与投资日历同款的筛选器，支持国家及地区、类别领域、重要性三维度过滤；重要性默认只勾选「高」，默认只显示高重要性事件预测；已公布实际值置顶，下方再接后续公布预测。</dd><dt>重大事件按日期最近排序</dt><dd>投资日历顶部「重大事件」卡片不再把手动维护项整体排在自动提取项前面，而是统一按事件时间升序，让最近即将发生的事件出现在最前面。</dd></dl><hr>` + v2107Changelog;
  // v2.10.9：恐惧贪婪只显示数字+文字；宏观与情绪卡片移除未来的宏观日历。
  const v2108Changelog = log.innerHTML;
  log.innerHTML = `<b>v2.10.9 更新日志</b><dl><dt>恐惧贪婪改为纯数字+文字</dt><dd>「宏观与情绪」卡片顶部的恐惧贪婪指数不再显示刻度条/滑块指示器，只保留数值与情绪标签（如 56 · 贪婪），让卡片更紧凑。</dd><dt>移除「未来的宏观日历」</dt><dd>「宏观与情绪」卡片右侧的「未来的宏观日历」区块已移除，仅保留下方「关注事件 · 实时数据」区块；未来事件仍可在投资日历中查看，宏观经济数据已独立成卡。</dd></dl><hr>` + v2108Changelog;
  // v2.10.10：强平概率计算器支持一键引用顶部持仓、持仓价快选与手动计算，并新增半月/一月/半年/一年触及概率。
  const v2109Changelog = log.innerHTML;
  log.innerHTML = `<b>v2.10.10 更新日志</b><dl><dt>强平概率计算器：一键引用顶部持仓</dt><dd>计算器表单下方新增操作条，「引用顶部持仓数据」把上方「我的持仓与盈亏估算」卡片里的交易所、方向、持仓量、杠杆倍率、开仓均价一次性填入计算器。</dd><dt>持仓价快选</dt><dd>新增「填入我的持仓价」按钮，展开后可一键选择「做多持仓价」或「做空持仓价」填入开仓均价并自动切换方向；两个价格在每次确认持仓或修改开仓均价时自动记录，随时复用。</dd><dt>改成点「计算」才出结果</dt><dd>手动修改表单不再边输边重算，改动后提示「参数已修改，点击计算更新结果」，点「计算」按钮才刷新，避免数字乱跳；用快捷按钮填入时会立即计算。</dd><dt>新增半个月 / 一个月 / 半年 / 一年触及概率</dt><dd>历史触及概率从 12h / 24h / 48h / 1 周四个短窗口扩展为两组：短线窗口继续用 15 分钟 K 线，长线窗口（半个月 / 一个月 / 半年 / 一年）改用日线样本，并在脚注标注日线样本区间与根数；杠杆越高、强平距离越近，长窗口越容易饱和到 100%，属正常现象。</dd><dt>修复刷新后顶部持仓被清空</dt><dd>修复「我的持仓与盈亏估算」在每次刷新时把持仓量、保证金、开仓均价、标记价格回写成空值的问题（旧逻辑在杠杆下拉框插入时派发 input 事件，把当时还空着的表单字段写回了状态），现在刷新后数据与「确认持仓并显示买入点」状态都会保留。</dd></dl><hr>` + v2109Changelog;
  // v2.10.11：宏观与情绪卡片重排 —— 恐惧贪婪收成左上角小方块，其余整块让给「关注事件 · 实时数据」，并补上秒级倒计时与阈值式解读。
  const v2110Changelog = log.innerHTML;
  log.innerHTML = `<b>v2.10.11 更新日志</b><dl><dt>恐惧贪婪改成左上角小方块</dt><dd>「宏观与情绪」卡片左上角只留一个小正方形显示恐惧贪婪指数（大号数值 + 情绪词），不再横向铺满一整条，腾出的横向空间全部让给右侧的「关注事件 · 实时数据」。</dd><dt>关注事件 · 实时数据：突出倒计时</dt><dd>该区块改为大号 HH:MM:SS 秒级倒计时（超过一天自动带天数），并写清北京时间与事件当地时间；倒计时每秒刷新，已公布后自动切换为「已公布」。</dd><dt>补上预期 / 前值 / 实际与阈值解读</dt><dd>新增「预期 / 前值 / 实际」三栏，并给出阈值式解读：以「预期」为锚（数据源没有免费共识时退回「前值」并注明），写明「实际 > 锚点 → 高于预期/前值 → 通常利好或利空 BTC」「实际 < 锚点 → …」「实际 = 锚点 → 通常影响有限」三种情景；已公布时高亮命中的那一条，并附该类数据的影响说明。</dd></dl><hr>` + v2110Changelog;
  // v2.10.12：强平概率计算器的「填入我的持仓价」改为直接读取顶部两个持仓舱段，并逐项填入持仓数据。
  const v2111Changelog = log.innerHTML;
  log.innerHTML = `<b>v2.10.12 更新日志</b><dl><dt>「填入我的持仓价」改为读取顶部两个舱段</dt><dd>修复「填入我的持仓价」浮层里两个价格一直显示「--」的问题：原实现只读旧的「我的持仓与盈亏估算」卡片留言记录，没有读取顶部「我的持仓」卡片的两个舱段。现在浮层直接列出顶部两个舱段的开仓均价，并附带持仓量、保证金与有效杠杆，哪一格没填就明确置灰并提示。</dd><dt>选中舱段 = 一次填好整笔持仓</dt><dd>点选某个舱段不再是只填开仓均价，而是把方向、开仓均价、持仓量、有效杠杆一起写入计算器（有效杠杆 = 持仓量 ÷ 保证金，与顶部卡片显示的理论强平价同口径），上下两块数字从此一致。</dd><dt>「引用顶部持仓数据」同样优先取顶部舱段</dt><dd>该按钮原先读旧持仓卡；现在优先取与当前方向一致、且已填价格的顶部舱段，顶部为空时才回退旧卡片，并在回执里写明取的是哪个舱段、填了哪些值。</dd><dt>浮层实时跟随顶部卡片</dt><dd>顶部持仓卡保存或修改后，浮层内容与本地记录立即刷新，不会出现「卡片已改、菜单还是旧值」。</dd></dl><hr>` + v2111Changelog;
  // v2.10.13：宏观与情绪卡片更名为「关注宏观事件实时数据」，并移除恐惧贪婪指数。
  const v21013Changelog = log.innerHTML;
  log.innerHTML = `<b>v2.10.13 更新日志</b><dl><dt>卡片更名并聚焦实时数据</dt><dd>「宏观与情绪」卡片标题改为「关注宏观事件实时数据」，右上角标签改为「实时数据」。</dd><dt>移除恐惧贪婪指数</dt><dd>该卡片不再显示恐惧贪婪指数，整块区域只保留「关注事件 · 实时数据」。</dd><dt>关注事件放大展示</dt><dd>「关注事件 · 实时数据」区块现在占满整张卡片，内部事件标题、倒计时、预期/前值/实际与阈值解读的字号、间距同步放大，阅读更醒目。</dd></dl><hr>` + v21013Changelog;
  // v2.10.14：去掉套娃标题，事件公布后 30 分钟内显示并高频抓取，过期自动移除。
  const v2113Changelog = log.innerHTML;
  log.innerHTML = `<b>v2.10.14 更新日志</b><dl><dt>去掉内部套娃标题</dt><dd>「关注宏观事件实时数据」卡片不再套一层「关注事件 · 实时数据」子标题，整块区域直接展示关注的数据本身。</dd><dt>已公布数据保留 30 分钟</dt><dd>事件公布后的实际值与解读只保留 30 分钟，超过后自动从卡片移除，避免把过期数据当成实时参考。</dd><dt>第一时间抓取实际值</dt><dd>事件到达公布时间前后 2 分钟内以及公布后 30 分钟内，每 15 秒强制刷新一次投资日历，跳过服务端 5 分钟缓存，确保实际值一经发布就立即回填。</dd></dl><hr>` + v2113Changelog;
  // v2.10.15：投资日历「重大事件」支持关注并同步到上方实时数据卡片。
  const v2114Changelog = log.innerHTML;
  log.innerHTML = `<b>v2.10.15 更新日志</b><dl><dt>重大事件也可关注</dt><dd>投资日历「重大事件」卡片里的每个事件右上角新增「关注」勾选框；勾选后事件会进入顶部「关注宏观事件实时数据」卡片，与常规宏观事件共享同一份关注列表（最多 3 个）。</dd><dt>重大事件同样适用实时规则</dt><dd>被关注的重大事件同样遵循「未公布显示倒计时、公布后保留 30 分钟、公布前后 2 分钟及公布后 30 分钟内每 15 秒强制刷新」的规则；手工维护的政策/定性事件无预期/前值，只展示时间与解读。</dd><dt>空状态提示同步更新</dt><dd>上方卡片为空时，提示用户可去投资日历列表或「重大事件」卡片勾选事件。</dd></dl><hr>` + v2114Changelog;
  // v2.10.16：修复被关注重大事件在实时卡片只显示倒计时、缺名称与利好利空解读的问题。
  const v2115Changelog = log.innerHTML;
  log.innerHTML = `<b>v2.10.16 更新日志</b><dl><dt>重大事件实时卡片补全展示</dt><dd>修复在投资日历「重大事件」关注美国《清晰法案》等事件后，上方「关注宏观事件实时数据」卡片只显示倒计时、不显示事件名称、利好/利空判断与解读的问题：现在标题优先使用事件名称（curated 事件以「重大事件」标注来源），非数值类政策/定性事件直接在倒计时下方展示「利好 BTC / 利空 BTC / 中性」标签，并附人工编辑性解读（judge）。</dd><dt>数值类事件保留阈值解读</dt><dd>带预期/前值/实际的宏观事件仍展示三栏数据并给出「实际 vs 预期/前值」阈值式利好利空解读；两类事件同样遵循公布后保留 30 分钟、公布前后每 15 秒强制刷新规则。</dd></dl><hr>` + v2115Changelog;
  // v2.10.17：数据连通性面板补全缺失 API 检测，并按分组折叠重做 UI。
  const v2116Changelog = log.innerHTML;
  log.innerHTML = `<b>v2.10.17 更新日志</b><dl><dt>连通性补全缺失 API</dt><dd>数据连通性面板由 10 项扩展到 17 项，新增投资日历（东方财富 / TradingView / FinanceCalendar / 美国财政部 / Deribit / mempool 等上游）、新闻流（Google News）、美股实时报价（Yahoo Finance）、衍生品上下文（资金费率 / OI / 基差）、AI 助手与密钥状态（千问 / CoinGecko / Finnhub / EIA / 自定义）、语音播报（Edge TTS）、预警推送（ServerChan）共 7 类此前未检测的数据链路。</dd><dt>分组折叠 UI</dt><dd>连通性面板改为按「行情与衍生品 / 概率与跨市场 / 宏观与日历 / 情绪与新闻 / AI 与服务」五组展示，每组可独立折叠并带可用率徽章；面板改为可滚动，不再因 API 增多而无限拉长，浏览器→本站与本站→上游延迟仍分列显示。</dd></dl><hr>` + v2116Changelog;
  // v2.10.18：消息推送默认折叠，并严格按已验证的大模型 Key 控制 AI 助手入口与接口权限。
  const v2117Changelog = log.innerHTML;
  log.innerHTML = `<b>v2.10.18 更新日志</b><dl><dt>消息推送默认折叠</dt><dd>「消息推送」板块默认收起，折叠外观与「高杠杆强平缓冲参考」保持一致；需要配置 SendKey 或管理预警规则时再展开，减少页面纵向占用。</dd><dt>AI 助手按有效接入显示</dt><dd>页面不再默认展示 AI 助手按钮。只有在「API 接入中心」保存大语言模型 API Key 且验证通过后才显示；未接入、未验证、验证失败、更新或清除 Key 时立即隐藏入口并关闭助手面板。</dd><dt>AI 接口权限收紧</dt><dd>模型切换与提问接口同步校验 Key 的验证状态，不能通过绕过前端使用未验证的凭据；验证失败会撤销旧的有效标记，避免已过期或已替换的 Key 继续被视为可用。</dd></dl><hr>` + v2117Changelog;
  // v2.10.30：强平价警告语音播报新增亏损估算，双仓时只播报更接近强平的一边。
  const v2118Changelog = log.innerHTML;
  log.innerHTML = `<b>v2.10.30 更新日志</b><dl><dt>强平价警告播报亏损估算</dt><dd>「距理论强平价」语音规则触发时，播报内容新增当前亏损估算：基于持仓名义金额与开仓均价计算，仅当持仓处于亏损时才读出具体金额。</dd><dt>双仓只报危险的一边</dt><dd>若同时持有多空两个仓位，当两个方向都进入预警范围时，只播报当前价格离理论强平价更近的那一边，避免价格上涨时播报正在盈利的空单、或价格下跌时播报正在盈利的多单。</dd><dt>触发逻辑不变</dt><dd>规则本身的警戒差额、冷却与重复机制保持不变；仅在真正触发时按上述规则过滤并生成播报文案。</dd></dl><hr>` + v2118Changelog;
  // v2.10.31：精简版播报改为「当前实时价 76287.5」这类整句播报语。
  const v2119Changelog = log.innerHTML;
  log.innerHTML = `<b>v2.10.31 更新日志</b><dl><dt>精简版播报改为播报语</dt><dd>「定时播报实时价精简版」开启后，不再只念一串裸数字，改为播报完整短句，例如「当前实时价 76287.5」，听感更清楚。</dd><dt>数字不带千分位</dt><dd>播报数字写作 76287.5 而不是 76,287.5，避免语音引擎把千分位逗号读成停顿。</dd><dt>作用范围不变</dt><dd>该开关只影响定时实时价播报与试听文案；语音规则（价格达到、涨跌幅、强平价等）的播报内容不受影响。关闭精简版后仍播报带持仓对比的完整版本。</dd></dl><hr>` + v2119Changelog;
  // v2.10.32：修正语音播报自检恒报失败，并让接口错误原因更准确。
  const v2120Changelog = log.innerHTML;
  log.innerHTML = `<b>v2.10.32 更新日志</b><dl><dt>修复语音自检误报失败</dt><dd>「API 接入中心」检测语音播报时原先用单个句号「。」作为探针文本。纯标点不含任何音素，微软语音服务会返回 0 字节音频，这项自检因此长期显示 HTTP 503 失败。探针改为可朗读的短文本后恢复正常，语音播报功能本身并未损坏。</dd><dt>失败原因不再一律报 503</dt><dd>文本为空、超过 240 字、或只含标点符号时，接口返回 400 并说明具体原因；只有上游语音服务确实不可用时才返回 503，便于区分「请求写错」与「服务故障」。</dd><dt>上游抖动自动重试</dt><dd>真实播报遇到上游偶发空音频或建连抖动时，服务端会短暂退避后自动重试一次，减少偶发的语音播报失败。</dd></dl><hr>` + v2120Changelog;
  // v2.10.33：图表最高／最低价改为按实际绘制的图形取值（K 线取影线），跨周期一致。
  const v2121Changelog = log.innerHTML;
  log.innerHTML = `<b>v2.10.33 更新日志</b><dl><dt>最高／最低价改用影线极值</dt><dd>原先取当前周期每根 K 线的收盘价作比较：5 分线视图能看到 02:45 那根的收盘，15 分线视图却把它并入 15 分钟大 K 线（收盘取 03:00 的价格），同一段行情在 1 日与 2 日视图下会读出两个不同的最低价。现改为按实际绘制的图形取值：K 线图取影线最高／最低，收盘线图仍取收盘价。影线在聚合时是守恒的（15 分钟 K 线的低点必然包含其内部 5 分钟 K 线的低点），因此同一时间窗切换到不同周期得到的是同一个极值。</dd><dt>标注点落在影线上</dt><dd>浮动标签与虚线圆点改用主图绘制时的价格标尺与绘图区几何定位，标注点正好落在对应 K 线的影线上，不再因另算一套坐标而偏移；鼠标靠近时的高亮判定同步复用同一坐标。</dd><dt>文案与提示同步</dt><dd>标签与悬浮提示由「最高／最低选中价」改为「最高价／最低价」，并明确是「当前查看范围内」的极值，避免被误读成其它口径。</dd></dl><hr>` + v2121Changelog;
  // v2.10.34：修复极值悬浮卡片金额口径与右缘标记错位。
  const v2122Changelog = log.innerHTML;
  log.innerHTML = `<b>v2.10.34 更新日志</b><dl><dt>悬浮极值 K 线时显示极值价</dt><dd>鼠标悬浮到最低／最高点所在 K 线时，卡片大字原先固定显示该 K 线的收盘价（如 02:50 显示 $75,846.30），与蓝点标注的影线最低价 $74,896.60 对不上。现在悬浮的正是极值 K 线时，大字直接显示标记所标的最低价／最高价，口径与标注一致；悬浮其他 K 线仍显示选中价（收盘价）。</dd><dt>右缘标记不再错位</dt><dd>最低／最高点靠近图表右缘时，标签位置原先被硬性夹回边界内，蓝点被拉离真实 K 线约几十像素，导致悬浮蓝点时提示不出现、卡片定位到旁边的 K 线。现在标记点始终落在真实 K 线上，标签改为贴近右缘时向左展开，圆点仍精确锚在 K 线位置。</dd></dl><hr>` + v2122Changelog;
  // v2.10.51：修复共振重构引入的 TDZ，恢复下半部分动态板块。
  const v2123Changelog = log.innerHTML;
  log.innerHTML = `<b>v2.10.51 更新日志</b><dl><dt>修复下半部分板块丢失</dt><dd>多周期共振加权一致性重构时，RES_INTERVALS / resonanceCache 的 const 声明位于 applyLanguage 早期调用点之后，触发暂时性死区（TDZ）ReferenceError，导致模块初始化在共振逻辑处中断，投资日历、宏观与情绪、BTC 多因子研究预测、A/B 实验中心等动态板块不再创建。已将常量上移，并在自动刷新中改用 refreshResonance，下半部分板块恢复正常。</dd></dl><hr>` + v2123Changelog;
  const v21052Changelog = log.innerHTML;
  log.innerHTML = `<b>v2.10.52 更新日志</b><dl><dt>消息推送模块拆分</dt><dd>消息推送整体拆分为独立文件 public/notification.js（前端）与 notification.mjs（后端发送器），app.js 减少约 640 行；app.js 中只保留依赖注入与初始化调用，为后续逐板块拆分建立模板。</dd><dt>多渠道推送</dt><dd>推送渠道从单一 Server酱 升级为多渠道：Server酱（微信）、Bark（iOS）、飞书自定义机器人、钉钉自定义机器人与通用 Webhook，可同时启用多个；每个渠道支持添加、编辑、启停、删除与一键验证（发送标注【验证】的测试消息），密钥 AES-GCM 加密存储且列表仅回传掩码。</dd><dt>消息总开关</dt><dd>新增推送总开关：关闭后云端规则与亏损联动均不再入队推送，本机模式不受影响。</dd><dt>亏损推送（联动持仓）</dt><dd>新增与「我的持仓」联动的亏损推送：按各笔持仓的保证金收益率（ROE = 价格变动% × 杠杆）计算，支持自定义警告 ROE、推送 ROE 与冷却时间；触发后向所有启用渠道推送并记录投递结果。</dd><dt>测试推送升级</dt><dd>「测试云端推送」改为向所有启用渠道逐渠道发送并回报成功数，便于确认每条链路可用。</dd><dt>旧代码清理</dt><dd>移除已被替代的旧版本机推送卡死代码（其后台轮询会造成同规则重复推送的隐患）。</dd></dl><hr>` + v21052Changelog;
  // v2.10.53：缩小 K 线图左侧留白，让主图与 RSI 副图向左边延伸。
  const v21053Changelog = log.innerHTML;
  log.innerHTML = `<b>v2.10.53 更新日志</b><dl><dt>主图左侧留白缩小</dt><dd>将主 K 线 canvas 的左侧内边距从 52px 减至 18px，原先左侧无内容的宽边距不再挤压 K 线主体；Y 轴价格标签仍在右侧，整体绘图区更宽。</dd><dt>RSI 副图同步对齐</dt><dd>RSI/成交量副图的左侧内边距同样从 52px 减至 18px，确保主图与副图的 K 线竖直对齐，悬浮十字线贯穿时不错位。</dd><dt>图表容器向卡片边缘延伸</dt><dd>chart-box 在桌面端的左右负边距从 -3/-4px 扩至 -16px，让 canvas 更接近卡片内边距，进一步放大可视区域。</dd></dl><hr>` + v21052Changelog;
  // v2.10.54：消息推送卡片 UI/交互重构（仿 8899 分渠道交互）。
  const v21054Changelog = log.innerHTML;
  log.innerHTML = `<b>v2.10.54 更新日志</b><dl><dt>消息推送 UI 重构</dt><dd>重新设计「消息推送」卡片：标题行右侧并列「推送设置」入口，总开关打开时正文只展示推送规则（明确标注 BTC/USDT 交易对，为未来多币种预留），关闭时整段收起。推送设置改为仿苹果补货监控（8899）的分渠道交互：每个渠道一个独立开关，打开后展开表单填写 API Key，点「确认并验证」真实发送测试消息，验证通过输入框自动收起、仅留「重新编辑」；状态徽章区分已验证（绿）／验证失败（红）／待验证（黄）／未验证（灰）。</dd></dl><hr>` + v21054Changelog;
  // v2.10.55：修复顶部登录按钮空白失效，并重排「账户与云端服务」弹窗布局。
  const v21055Changelog = log.innerHTML;
  log.innerHTML = `<b>v2.10.55 更新日志</b><dl><dt>登录按钮修复</dt><dd>修复「API 接入中心」旁登录按钮显示为空白胶囊且点击无反应的问题：推送卡片重构后 cloud-alerts.js 的缓存戳未随代码更新，浏览器强缓存中的旧脚本在已被移除的节点上挂载云端面板时抛错，登录状态刷新链路整体中断。现已更新缓存戳，并在按钮创建时即写入初始文字、渲染异常时显示错误提示而非空白，杜绝同类静默失效。</dd><dt>账户弹窗重排</dt><dd>「账户与云端服务」改为分层布局：说明文字整行显示不再被挤成竖条；账户卡内为头像（邮箱首字母）、邮箱地址与「已登录」徽章一行，同步说明独立整行，「一键同步全部」与「退出登录」并列为主次按钮，配色沿用全局主题令牌。</dd></dl><hr>` + v21055Changelog;
  // v2.10.56：图表区三块拆为左列三张平级独立卡片。
  const v21056Changelog = log.innerHTML;
  log.innerHTML = `<b>v2.10.56 更新日志</b><dl><dt>图表区拆分为三张独立卡片</dt><dd>K 线图、OKX 市场微观结构、周期涨幅原先嵌在同一个大卡片内，现拆为左列三张平级卡片纵向排列，各自拥有独立边框与间距，视觉层级更清晰；桌面端右列高度不再影响左列排版，移动端编排保持不变。</dd></dl><hr>` + v21056Changelog;
  // v2.10.67：i18n 国际化修复
  const v21067Changelog = log.innerHTML;
  log.innerHTML = `<b>v2.10.67 更新日志</b><dl><dt>国际化（i18n）修复</dt><dd>修复英文模式下多处中文残留与 undefined：消息推送 / 账户云端 / AI 助手三大子模块切换语言时现可即时重渲染；API 接入中心弹窗与千问额度卡改为双语；连接状态、图表覆盖、缓存提示等运行时文案接入翻译；修正单参数 tx 导致的「同步中…」英文显示 undefined。</dd></dl><hr>` + v21067Changelog;
  // v2.10.68：修复清除推送渠道后被 legacy SendKey 复活的问题
  const v21068Changelog = log.innerHTML;
  log.innerHTML = `<b>v2.10.68 更新日志</b><dl><dt>推送渠道修复</dt><dd>修复「推送设置 → 清除」Server酱 渠道后仍显示「未验证」的问题：老版账户级 SendKey（alert_credentials 迁移源）会在渠道列表刷新时静默复活刚删除的渠道；现在清除最后一条 Server酱 渠道时会同步清掉老版 SendKey，清除后与初始状态一致。</dd></dl><hr>` + v21068Changelog;
  const v2_11_0Changelog = log.innerHTML;
  log.innerHTML = `<b>v2.11.0 更新日志</b><dl><dt>宏观板块整合：5 卡并为 2 卡</dt><dd>「宏观经济数据」「数据公布影响预测」「投资日历」三卡合并为「宏观事件中枢」：默认按「今天」时间流排列，「现在」分隔线上方为已公布事件（实际值实时回填 + 利好/利空 BTC 偏差标签 + 实际值高亮），下方为即将发布事件（倒计时 + 预期）；点任意带方向模型的事件行可展开「情景（高于/低于预期）× 比特币/加密货币/美股/黄金」影响预测矩阵，原「宏观经济数据」独立卡下线。</dd><dt>宏观环境与跨市场联动</dt><dd>「BTC × 美联储监控」升级为「宏观环境与跨市场联动」：综合指标（黄金/美元指数/原油/VIX/BTC 占比等）与 FOMC/CPI/非农倒计时保留，「BTC × 美股联动分析」整体并入卡底联动面板（SPY/QQQ 报价、60 日相关性、下一交易日 BTC 看多概率），不再单独占卡，联动结果在卡每 10 分钟重渲染后自动回填不丢失。</dd><dt>时间流交互</dt><dd>日历默认范围改为「今天」并置于范围按钮首位；新增「现在」分隔线；已公布事件行绿色高亮实际值。</dd></dl><hr>` + v2_11_0Changelog;

  // v2.11.2：图表悬浮缩略图 + 一键返回顶部
  const v2112FloatChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.11.2 更新日志</b><dl><dt>图表悬浮缩略图</dt><dd>图表工具栏「重置」旁新增「缩略图」开关：开启后往下滚动浏览其他数据时，K 线主图 + RSI 副图的实时缩略图置顶悬浮在屏幕边（约 0.5 秒刷新），标题栏同步显示最新价格与涨跌幅；图表滚回视野内时自动隐藏避免遮挡。按住标题栏可拖动位置，拖右下角手柄或点 − /＋ 按钮自定义大小，点击缩略图本体在常用尺寸与放大尺寸间切换；位置与尺寸记忆在本机。</dd><dt>一键返回顶部</dt><dd>屏幕右下方新增「↑」悬浮按钮：页面下滑超过约半屏后出现，点击平滑滚回最顶部，解决长页面回滚慢的问题。</dd></dl><hr>` + v2112FloatChangelog;
  // v2.11.3：研究预测改为终点三分类，并让采样与结算脱离页面访问
  const v2113ThreeClassChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.11.3 更新日志</b><dl><dt>研究预测：三分类准确性验证</dt><dd>多因子研究预测改为「偏多 / 中性震荡 / 偏空」三分类：中性阈带 = 1.15σ·√周期并随每条预测存库，训练标签与结算标签统一为「终点收益是否越过阈带」，不再用「先触及哪边屏障」训练、却用「终点涨跌」评分。记分卡新增三分类准确率、混淆矩阵、漏报率，并强制并列展示「永远猜震荡」与「按频率随机」两条基线——只有差值才是模型的贡献。窗口卡片改为同时显示三类概率与当周期阈带。</dd><dt>研究预测：采样与结算脱离页面访问</dt><dd>预测写入过去只发生在有人打开页面时，样本因此是「谁来过」的便利样本（15 分钟桶覆盖率仅 20%）。现在采样与结算各走自己的服务端时钟：每 15 分钟生成四周期预测，每 60 秒结算到期预测。预测锚点改为已收盘 K 线，修复 entry 价格与桶时间错位 15 分钟的问题；同一桶在结算前会被最新模型重新定价，不再被 IGNORE 静默丢弃。日线缓存改为按末根 K 线时间判断新鲜度，修复日线冻结 20 天导致 1 天周期无法验证的问题。另修复未平仓合约交互项因运算符优先级恒为正号、候选进度条「1119/120」等缺陷，并对历史已结算行回填三分类结论。</dd></dl><hr>` + v2113ThreeClassChangelog;
  // v2.11.4：影子评估门槛按周期展开 + 回填补全旧样本
  const v2114GateChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.11.4 更新日志</b><dl><dt>影子评估：门槛进度按周期展开</dt><dd>候选模型的「已配对结算」此前只给总数与每周期门槛，看不出是哪个周期在等，等待期容易误判成按钮坏了。现在治理区直接列出四个周期各自的进度（如 1d 2/30），已达标的周期标红、未达标的置灰。同时修复历史回填受内存 K 线窗口限制的问题：早于窗口的已结算行匹配不到锚点，会被静默跳过而缺失三分类结论；回填改为按时间范围直读库存 K 线，约 440 条旧样本补回标签，记分卡不再丢掉这段历史。</dd></dl><hr>` + v2114GateChangelog;
  // v2.11.5：修掉会让整页白屏的重复标识符隐患
  const v2115RenameChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.11.5 更新日志</b><dl><dt>修复更新日志变量重名隐患</dt><dd>早期版本的日志块留下了一个错位命名的常量（v2.10.13 的块用了 v2112Changelog 这个名字）。它与后续版本按惯例命名的新块一旦撞名，重复声明会让 app.js 整个模块加载失败、页面全白。现改回与自身版本一致的命名，消除这个隐患。本次仅重命名，不改任何显示内容。</dd></dl><hr>` + v2115RenameChangelog;
  // v2.11.6：宏观板块整合收尾（语言切换重渲 + 时间流交互）
  const v2116MacroLangChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.11.6 更新日志</b><dl><dt>宏观板块整合收尾：语言切换同步</dt><dd>「宏观事件中枢」与「宏观环境与跨市场联动」按当前语言整卡渲染，语言切换那一刻不会逐节点替换，导致标题、范围按钮、副标题要等下一次数据刷新才变成新语言。现在切中英文会立即重渲这两张卡（保留当前范围、筛选与已展开的事件行），并同步刷新卡底 BTC × 美股联动面板的文案。</dd><dt>宏观事件中枢：时间流与展开矩阵</dt><dd>确认并保留三项交互：默认按「今天」排列、事件按北京时间升序，「现在」分隔线把今天一分为二（上方已公布、实际值绿色高亮并给出利好/利空 BTC 偏差标签；下方即将发布，带倒计时与预期）；点任意带方向模型的事件行可展开「情景（高于预期 / 低于预期）× 比特币 / 加密货币 / 美股 / 黄金」影响预测矩阵。当前若无已公布事件，则只显示单一时间轴，不画分隔线。</dd></dl><hr>` + v2116MacroLangChangelog;
  // v2.11.7：修正持有窗口的整根 K 线偏差，并把不可比的旧样本单独标出
  const v2117WindowChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.11.7 更新日志</b><dl><dt>研究预测：修正持有窗口的整根 K 线偏差</dt><dd>此前结算时刻按「锚定桶 + 持有期」计算，而入场价取的是锚定 K 线的收盘（即桶的收盘时刻），两者相差整整一根 K 线。实测结果是：15 分钟周期的名义持有窗口塌缩成 0，1 小时与 4 小时各少 15 分钟。更糟的是结算取的是「起点 ≥ 结算时刻的第一根 K 线」，而它此时尚未收盘，于是拿到的是盘中残价，刚开盘就立刻结算（实测新样本的实际持有只有约 1 分钟）。现在结算时刻改为「锚定桶 + (持有期 + 1) 根」，结算只采用在该时刻之前已经收盘的最后一根，实际持有窗口严格等于名义持有期。</dd><dt>研究预测：不可比的旧样本单独标出，不再稀释准确率</dt><dd>窗口定义固定之前结算的历史样本，其实际持有长度取决于「谁在什么时候打开页面」，与当前口径不可比（15 分钟这一档尤其严重）。这些行保留在库内，但记分卡改为只统计新口径样本，并在卡片上显式报出被排除的条数；分子分母都不再含糊。候选模型的配对对照不在此列——它两侧用的是同一批行，窗口偏差对两边同等作用，属于相对比较。</dd><dt>研究预测：候选快照与现役对齐</dt><dd>候选训练快照的桶时间原先盖的是训练时刻，永远配不上现役行；且参数少传两个，把方向字符串写进了震荡概率字段。现已与现役共用同一锚定与持有期定义。</dd></dl><hr>` + v2117WindowChangelog;
  // v2.11.8：把旧样本失真的量级写进提示
  const v2118LegacyNoteChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.11.8 更新日志</b><dl><dt>研究预测：旧样本排除提示补上量级</dt><dd>上一条只说旧窗口样本「与当前口径不可比」，没给严重程度。补上实测：旧逻辑结算时不检查目标 K 线是否已收盘，三个周期中只有约 27% / 29% / 30% 的旧样本结算价恰好等于该根的最终收盘，另有 15%–26% 在收盘前就结算了，因此这批样本的持有窗口无法复原。本次仅改提示文案。</dd></dl><hr>` + v2118LegacyNoteChangelog;
  // v2.11.9：A/B 实验中心归位到研究板块 + 涨跌配色反向残留清理
  const v2119PanelOrderChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.11.9 更新日志</b><dl><dt>A/B 实验中心归位到研究板块</dt><dd>A/B 实验中心原先挂在 main 末尾（footer 之前），下方被整组决策工具卡隔开，与它同属研究类的「BTC 多因子研究预测」之间隔了十几张卡。现在它紧贴研究卡之后，页面阅读顺序固定为：研究预测 → A/B 实验中心 → 宏观事件中枢 → 宏观环境与跨市场联动。这四张卡由不同异步流程创建，任一张被其他布局逻辑挪走后，由 syncMacroPanels 链式校正拉回原位。</dd><dt>涨跌配色：清理反向残留定义</dt><dd>样式表里存在两组早期残留的反向涨跌定义（.bull 红 / .bear 绿），一直被下方的 var(--bull)/--bear 规则覆盖、从未生效，但层叠顺序一旦变动就会让全站涨跌色整体翻转。现已移除，并在生效规则处标注唯一真源。全站约定保持欧美习惯：涨=绿、跌=红（K 线图同为涨 #28c76f / 跌 #ef4d78）。本次为清理，不改变任何已生效的显示颜色。</dd><dt>研究区两张卡：语言切换即时生效</dt><dd>「BTC 多因子研究预测」与「A/B 实验中心」同样是整卡渲染，语言切换那一刻不会逐节点替换文案，标题、副标题、按钮与实验注册表会停留在上一语言直到下次数据刷新（最长约 15 分钟）。现在切中英文会立即用缓存数据就地重渲这两张卡，与已按同样方式处理的「宏观事件中枢」「宏观环境与跨市场联动」保持一致。</dd></dl><hr>` + v2119PanelOrderChangelog;
  // v2.11.10：智能顶部栏（滚动即隐 / 可唤回）
  const v21110SmartBarChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.11.10 更新日志</b><dl><dt>智能顶部栏：向下滚动自动收起，内容让出空间</dt><dd>红框里的那条顶栏此前固定在文档流顶端，滚动时会一直占着头一屏的位置。现在它改为浮动条：向下滚动超过约一个栏高的距离后整条上滑出视口并释放点击（不会挡住底下的内容，也不会被误点到），向上滚动约 24 像素即自动滑回。鼠标移到视口顶部边缘、或键盘焦点进入栏内同样会唤回，三条通道任意一条都能把栏拿回来。</dd><dt>唤回后静置自动再收起</dt><dd>把两种方案合并了：唤回后若鼠标不在栏上、焦点不在栏内、栏内浮层（版本日志 / 连通性 / API 接入中心 / 账户卡等）未打开，静置 4 秒会再次收起，避免顶栏长期压住图表；鼠标停在栏上或浮层开着时不收起。回到页面顶部（滚动位置 ≤24 像素）则恢复常显，不参与自动收起。</dd><dt>实现方式：固定定位 + 等高占位，首屏布局零位移</dt><dd>栏体改用固定定位，原位插入一个高度跟随栏体自适应的占位块，首屏位置与改造前逐像素一致；栏体宽度与左边距跟随主内容区实时同步，窗口缩放、字体加载与中英文切换后都会重新对位。打印时栏体回归文档流，不会在导出里出现悬空的一条。跟随系统「减少动态效果」时取消过渡动画。</dd></dl><hr>` + v21110SmartBarChangelog;
  const v21112Changelog = log.innerHTML;
  log.innerHTML = `<b>v2.11.12 更新日志</b><dl><dt>新增：历史回放（walk-forward 三分类验证）</dt><dd>用本地已存 K 线把历史重放成已评分样本：每一段只用该段起点之前的数据训练，再逐桶预测其后的桶，因此不含前瞻偏差。首次运行约 20 秒，结果在服务端缓存 30 分钟。需要它的原因是实时样本的攒够速度由市场决定 —— 日线一天只产生一个独立结果，等 30 条就是等 30 天；回放同一条命令即可拿到约 600 条日线样本（覆盖 20 个月）与每个日内周期约 1700 条。回放不含新闻、情绪与微观结构（它们没有历史），震荡概率来自近邻池，与实时同源。</dd><dt>修正：候选升级门槛改为按周期独立判定</dt><dd>原先要求四个周期同时攒够 30 条名义样本，等于把否决权交给日线（30 天），而 4h 的重叠桶只是把计数撑大、并未增加证据。现改为每个周期按自己的「不重叠独立样本」计数（门槛 20），先达标的周期可先评估；四周期全部达标前不会给出升级结论。进度文案同步显示各周期的独立样本数。</dd><dt>记分卡新增独立样本口径</dt><dd>实时样本每 15 分钟采一个桶，只要持有期长于一根 K 线，这些桶就会互相重叠，于是统计条数会高估它实际持有的独立证据量。记分卡现在额外报出同一批行经贪心去重叠后的独立样本数及其三分类结果，不再让重叠桶虚增统计功效。</dd><dt>实时报价：主字号放大</dt><dd>顶部 BTC/USDT 主报价由 39px 提到 44px，数字本身更清晰；下方的涨跌幅、涨跌额、来源与刷新时间等小字保持原尺寸不变。</dd><dt>报价跳动：变化数字轻微放大后回落</dt><dd>逐位刷新时，发生变化的数字除了原本的变色与光晕，还会轻微放大一次（峰值 1.16 倍，以该字符底线为原点向上生长），约 0.95 秒内平滑回落到正常大小。颜色与光晕方案完全保持原样，未变化的数字位不受影响，整行基线与行高也不发生位移。</dd><dt>语音喇叭入口随之右移</dt><dd>报价变宽后，右上角的语音快捷喇叭与数字尾部贴得过近，已把它在桌面端的定位右移到 300 像素处重新留出间隔；窄屏布局不受影响。</dd></dl><hr>` + v21112Changelog;
  // v2.11.13：首页静置也让位（静置收起 + 顶部热区唤回）
  const v21113TopIdleStowChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.11.13 更新日志</b><dl><dt>首页静置 5 秒，顶栏自动收起并让出空间</dt><dd>上一条只做了「向下滚动收起 + 唤回后静置收起」，停在页面顶部不动时顶栏仍然常显。现在补上：停在首页顶部（滚动位置 ≤24 像素）且约 5 秒内没有任何交互 —— 鼠标不移动、不滚动、不按键、不点击 —— 顶栏同样会整条收起隐藏，并把它的占位一起收掉，下方内容整体上提约一个栏高，真正拿到这部分信息空间。</dd><dt>鼠标回到顶部区域即唤回</dt><dd>收起后把鼠标移到视口顶部边缘（约 36 像素内）就会把它唤回，与滚动到一半时的唤回方式一致：滑回栏体、占位同步展开、内容回到原位，随后重新开始计时。唤回后再静置 5 秒仍会再次收起 —— 静止不动就一直是让位的状态，鼠标一动就到手。</dd><dt>不收起的情况保持不变</dt><dd>鼠标停在栏体上、键盘焦点在栏内、栏内浮层（版本日志 / 连通性 / API 接入中心 / 账户卡 / 通知与语音设置）开着，以及栏内刚点过的 2.5 秒免打扰窗口内，都不会收起。离开顶部后的静置时长仍是 4 秒，与滚动收起配合使用。</dd><dt>实现细节：占位块只在顶部收，下滑时先补回再补偿滚动</dt><dd>占位块的高度只在「页面顶部 + 已收起」这个组合下收成 0；一旦开始下滑就先把占位补回原高，同时等量补偿滚动位置，两步相抵后画面完全不动，因此下滑途中唤回栏体也不会把内容再顶一次。占位高度过渡在首帧之后才启用，避免开屏时把首次赋值当成动画而跳一下。跟随系统「减少动态效果」时取消过渡。</dd><dt>实时报价刷新提到 4 次/秒</dt><dd>报价轮询间隔由 1 秒缩短到 250 毫秒（来源行会显示「刷新 0.25 秒/次」）。同一时刻只允许一条报价请求在飞：若有刷新节拍因上一次请求尚未返回而被跳过，会立刻补拉一次，不再出现「隔一拍才刷新」的空档；页面从后台标签切回时也立即补一次（浏览器会降频后台标签的定时器）。服务端同步收紧：WS 报价的新鲜度窗口从 5 秒收到 1.5 秒、REST 回退缓存从 1 秒降到 0.3 秒 —— 行情流一旦抖动就尽快回退到 REST 取值，而不是把几秒前的旧价继续当作实时返回。</dd><dt>跳动脉冲时长随之缩短到 0.5 秒</dt><dd>刷新变快后，若沿用原先 0.95 秒的脉冲，同一位数字连续变化时动画会在播完前被下一次刷新打断、看上去「一直亮着」。脉冲时长改为 0.5 秒，让每次跳动都能回落到常态；颜色与光晕方案完全不变。另需说明：这里显示的是 OKX 永续的「最新成交价」，行情清淡时该价本身可能几秒不动（例如在一档价位上反复成交），那属于市场行为，不是页面卡住。</dd></dl><hr>` + v21113TopIdleStowChangelog;
  // v2.11.19：宏观事件因子（阶段 2）—— 把 CPI / 非农 / FOMC 与 BTC 事件窗口收益对齐
  const v21119MacroEventChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.11.19 更新日志</b><dl><dt>新增：宏观事件因子（CPI / 核心 CPI / 非农 / FOMC）</dt><dd>研究预测卡片新增「宏观事件因子」面板，可按需回填至少 24 个月的宏观事件样本：从 FRED 取 CPI、核心 CPI、非农的观测序列，从美联储官方页取 FOMC 决议日，再把每次发布的时刻与 BTC 在该时刻之后 1 小时 / 4 小时 / 1 天的真实表现对齐。首批回填 110 条事件，覆盖 2024-03 至 2026-09。</dd><dt>它衡量的是波动，不是方向</dt><dd>宏观事件日的 BTC 日线波动幅度中位数比平常一天高 28% 到 56%（FOMC 1.42 倍、CPI 1.52 倍、非农 1.56 倍），且 55% 到 70% 的事件日波动被放大。这条证据比「涨还是跌」稳健得多，也正好说明这类因子应该进入波动与风险通道，而不是直接当方向信号。</dd><dt>窗口基准严格取「事件时刻前已收盘」的 K 线</dt><dd>事件当天那根日线在事件发生时仍在运行，拿它的收盘价当事件前基准就是前视偏差。实现上所有窗口都只取「收盘时刻早于事件瞬间」的最后一根 K 线，1 天窗口因此等于事件当日的完整日收益。</dd><dt>明确标注三条方法学边界</dt><dd>一、免费源拿不到市场预期，所谓的「意外」是实际值减上一次发布值，只用于事后分层，不能当发布瞬间可用的预测特征。二、FOMC 决议时刻精确到分钟（官方决议日 14:00 东部时间），非农按「次月首个周五」的稳定惯例到日，CPI 因 BLS 不承诺固定发布日只能到日级估计，所以 CPI 的 1 小时窗口不出统计。三、FRED 给的是修订后终值而非发布瞬间初值，因此修订只影响「大意外 / 小意外」的分层，不影响窗口收益本身。</dd><dt>修正：FOMC 决议日不再混入纪要发布日</dt><dd>第一版从美联储日历页的正文里提取日期，而页面正文混着会议纪要的发布日等非会议日期，凭空造出十几个不存在的「决议日」（30 个月里数到 40 次）。改为只认文件名里的日期（会议纪要与决议声明的命名惯例严格对应决议日），并保留「决议固定在周二或周三」的过滤，次数回到真实的 20 次。</dd><dt>修正：利率决议改用日度序列对齐</dt><dd>联邦基金目标利率是日度序列，原先和月度指标一样按「期」聚合，同一月内多次变动会互相覆盖。改为按事件瞬间前后各取一个观测，决议后的目标利率上限与决议前直接相减，20 次决议全部拿到了利率变动值。</dd><dt>修正：「没有意外」不再被当成小意外</dt><dd>FOMC 多数会议利率不动，若把它们按标准化的符号分到正负两侧，分层结论会凭空冒出来。现在「零意外」单独作为一类样本报出，正负意外只统计真正发生变动的那些。</dd></dl><hr>` + v21119MacroEventChangelog;
  // v2.11.20：缩略图价格标明身份 + 逐位跳动对齐大价格
  const v21120ThumbPriceTickChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.11.20 更新日志</b><dl><dt>缩略图价格写明白是什么价</dt><dd>悬浮缩略图标题栏原来只有一个孤零零的数字，看不出是什么价格。现在拆成两行：上行为「实时缩略图」与缩放/关闭按钮，下行在数字前明确标出「BTC/USDT 最新价」。标的是 OKX 永续的最新成交价，与页面顶部大报价同源同一时刻。</dd><dt>刷新提到 4 次每秒，与大报价同节奏</dt><dd>价格刷新原来跟着缩略图的画面一起每 0.5 秒走一次，看起来比大报价慢半拍。现在价格单独用 250 毫秒的节拍刷新（与大报价的轮询节奏一致），画面重绘仍是 0.5 秒一次，两者互不影响。</dd><dt>逐位跳动，与大报价同一套样式</dt><dd>数字改为逐位渲染并复用大报价同一套跳动样式：方向取自「本次价 vs 上次价」，涨为绿（#00d4aa）、跌为红（#ff4d6a），被跳到的数字位各做一次放大 1.16 倍并伴随光晕的脉冲后回落，0.5 秒走完，整行基线不发生位移。与顶部大报价唯一的差别是范围：大报价从第一个变化的数字位一路跳到末尾，这里改为严格按位比对，只跳真正变了的那几位（按右对齐比较，价格进位多出一位数时新出现的高位同样算变化）；逗号、小数点与货币符号不参与比较也不跳动。未变化的数字位全程静止。</dd></dl><hr>` + v21120ThumbPriceTickChangelog;
  // v2.11.21：宏观事件列表的展开 / 收起控制条
  const v2122ListExpandChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.11.22 更新日志</b><dl><dt>修复：展开到底后收不回来</dt><dd>宏观事件中枢底部的控制条此前只在「还有更多事件」时才渲染，一旦把范围内的事件全部展开，整块会连同「已显示 N / N 条」统计一起消失，页面上再也找不到回退入口，只能靠切换时间范围把列表重置换回来。现在控制条改为常驻：只要该范围内的事件多于折叠态的 6 条，它就一直在，并按当前状态动态切换按钮。</dd><dt>展开 / 全部展开 / 收起三档操作</dt><dd>新增「全部展开」一次到底，省去连点十余次；展开后「收起」按钮始终出现，点击即回到默认的 6 条。按钮文案随状态切换（继续展开 10 条 ⇄ 收起），符合「Show more / Show less」的通行做法。收起时若列表已滚出视口，会自动把它带回视野中央，不会让操作停在半空。</dd><dt>右侧新增进度指示</dt><dd>原先只有一行「已显示 x / y 条」小字，现在补充一条细进度轨，并用「全部」徽标标出已完全展开的状态，一眼就能判断当前展开到什么程度、还剩多少。</dd><dt>展开超过 30 条改为框内滚动</dt><dd>一旦展开超过 30 条，列表容器自动切换为固定高度（最高约 62% 视口高）的内部滚动区域，事件再多也只在框内滚，不会把整页拉成超长文档 —— 实测全部展开 116 条时页面总高 6663 像素，反而比展开 26 条时的 8219 像素更矮。同时日期分组标题吸顶，滚到任何位置都能立刻知道当前是哪一天。框内滚动时列标题行会隐藏：该行只在列表顶部出现一次，滚下去本就不可见，而每行数据自带「今值 / 预期 / 前值」标签，信息并无缺失。列表下方附「回到顶部」按钮与滚动提示。</dd></dl><hr>` + v2122ListExpandChangelog;
  // v2.11.23：推送设置里「已验证」的渠道输入框没真正收起（hidden 被 display:flex 盖掉）
  const v21123PushFieldsHiddenChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.11.23 更新日志</b><dl><dt>修复：渠道验证通过后，输入框没有真正收起</dt><dd>推送设置里本该在验证通过后自动收起 API Key 输入框、只留「重新编辑」和「清除」，实际却是输入框和这两个按钮同时出现 —— 判断本身是对的（按钮就是按「已收起」的状态渲染的），只是隐藏没生效：样式表给输入框容器写了 display:flex，而作者样式会盖掉浏览器对 hidden 属性的默认隐藏，于是 hidden 加不加这个容器都照常显示。现在给该容器补上 hidden 时的显式隐藏。</dd><dt>输入框的显示 / 隐藏规则（所有渠道一致）</dt><dd>收起：已经保存过配置且验证通过、当前又没在编辑时，输入框收起，只留「重新编辑」和「清除」。显示：还没保存过任何地址或 Key（例如刚打开推送开关）、验证未通过或验证失败、以及点了「重新编辑」之后，输入框显示，按钮相应换成「确认并验证」和「清除」。未登录时的本机 Server酱 走同一套规则。</dd><dt>顺带说明：钉钉 / 飞书的 Webhook 地址按原样回填</dt><dd>只有标注为密钥的字段（如加签密钥、SendKey、设备 Key）会以掩码形式返回，回填时显示「已保存，留空则不修改」；Webhook 地址属于非密钥字段，重新编辑时会带出完整地址（钉钉地址里含 access_token），属于既有设计，本次未改动。</dd></dl><hr>` + v21123PushFieldsHiddenChangelog;
  // v2.11.26：图表工具栏「横向移动」的小字提示默认收起，悬停标题时原位替换
  const v21126PanHintChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.11.26 更新日志</b><dl><dt>「横向移动」下方的小字提示默认收起</dt><dd>图表工具栏中间的「横向移动」原先占两行：上面是标题，下面常驻一行小字「按住 ⌘ / Ctrl + 滚轮」。这行字占着一行高度却很少被读到，现在默认收起，中间只剩单行标题，与左右两枚箭头按钮在垂直方向对齐。</dd><dt>鼠标移到标题文字上，标题当场被提示替换</dt><dd>指针进入中间文字区（左右两枚箭头按钮不参与，各自保持原来的悬停提示）时，「横向移动」立刻消失、原位换成「按住 ⌘ / Ctrl + 滚轮」，移开即恢复成标题。这一下不加过渡动画：本意是「凑近看一眼」的瞬时替换，淡入淡出反而像卡顿。</dd><dt>做法：两块文字叠进同一格，命中区只由标题承担</dt><dd>先把两行文字改为叠放在同一个网格单元里，替换时不会发生纵向位移；再把悬停中的标题设为文字透明而不是隐藏元素，这样它的盒子尺寸不变、指针判定不会自己松开。提示层设为不接收指针事件，否则它浮到上层后会截走悬停，形成「显示↔隐藏」的高频闪烁。</dd><dt>中英文长短差异不会推动两侧箭头</dt><dd>实测提示文字中文 91 像素、英文 100 像素，都窄于标签固有的 112 像素最小宽度，且工具栏容器高度固定，因此替换前后箭头的位置与工具栏高度都不变。</dd></dl><hr>` + v21126PanHintChangelog;
  // v2.11.27：因子消融实验 —— 宏观日程特征入模的边际贡献
  const v21127AblationChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.11.27 更新日志</b><dl><dt>研究卡片新增「因子消融」面板</dt><dd>加一个新因子最容易自欺的一步是「只看准确率有没有涨」——在大部分时间震荡的行情里，永不预测方向就能拿到很高的准确率。消融让两臂跑完全相同的回放流程与 K 线，唯一差别是待验证的那三列宏观日程特征，头条指标改成相对「永远猜多数类」的增量，判定阈值 ±0.5pp，指标基于互不重叠的独立样本子集，避免重叠桶把显著性撑大。</dd><dt>入模的只有事件「日期」，没有发布值</dt><dd>三个特征是距上次事件的小时数、距下次事件的小时数、是否在事件后 24 小时内，全部取对数归一。FOMC / 非农 / CPI 的日程由官方提前数月公布，因此在任何历史时点都真实可得，把它们当特征不构成前视偏差。发布值（actual / surprise）被有意排除：它们从发布瞬间才存在，而 FRED 用「所描述的时间段」给观测打戳而非「公开时刻」，按观测日期对齐会把未来泄漏进过去。</dd><dt>把「没用」和「只在事件期有用」拆开</dt><dd>全局无差异可能掩盖两种相反的情况：特征根本没用，或者它只在事件窗口打开时有用——而窗口期只占全部桶的少数。因此消融会把同一批样本按「是否落在事件后 24 小时内」再拆一次分别对比。</dd><dt>实测结论：四个周期都没有正增量</dt><dd>特征列确实从 8 变成 11（模型真的吃到了这三列），但 15m 与 1d 的预测分布毫无变化，1h 与 4h 反而变差，其中 1h 在事件窗口内是 −1.51pp。这与前一轮的发现自洽：宏观事件影响的是波动而不是方向（事件日 1 日幅度中位数是平常一天的 1.4–1.6 倍），所以这三列特征不进入实时方向模型，只留在消融面板里作为后续因子验收的基准设施。</dd></dl><hr>` + v21127AblationChangelog;
  // v2.11.28：推送设置弹层改为整屏居中（原先继承底部 sheet 的 align-items:end）
  const v21128PushModalCenterChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.11.28 更新日志</b><dl><dt>修复：推送设置弹层贴着浏览器底部，没有居中</dt><dd>推送设置用的是全站弹层的公共外壳，而这个外壳是按「交易所风格底部弹层」写的 —— 里面明确写着底对齐，本来就是给「添加预警」那种一步输入的表单用的。推送设置属于设置面板，却没带改回居中的修饰类，于是继承到的是「底对齐」而不是「居中」，视觉上就成了贴在浏览器底部。现在按站内既有的做法（语音设置、账户卡都这么做）给它补上居中修饰类：纵向居中、四周留 20 像素、圆角统一。</dd><dt>同一外壳下各弹层现在的对齐方式</dt><dd>居中：推送设置、语音设置、语音规则、API 接入中心、账户卡。保持底部弹层：添加预警（从卡片直接拉起的一步输入表单，底部弹出更顺手）。改的只是推送设置这一个类，其余弹层行为不变。</dd><dt>弹层过高时不会溢出屏幕</dt><dd>居中后内容上限仍是「视口高度减去四周留白」，超长时在面板内部滚动，不会把上下两端的留白吃掉、也不会顶出屏幕外。窗口很矮或很窄时按较小的一边收敛宽度，与其它居中弹层一致。</dd><dt>图表工具栏：一排按钮重新对齐，高度统一</dt><dd>工具栏右侧原先三种高度混用 —— 缩放组里的 − / 100% / + / 重置 只有 26 像素高，左边「K 线周期 / 查看范围 / 图表」是 28 像素，中间「横向移动」那一块更是独占 40 像素，一排扫过去高低不齐。现在统一到 28 像素，所有控件落在同一条水平线上。</dd><dt>「缩略图」从「重置」旁独立出来，改名「悬浮缩略图」</dt><dd>这个开关原先挤在「重置」右侧、共用缩放组那个圆角框，读起来像缩放功能的一部分。现在把它从缩放组里移出来、自带边框单独成一颗按钮，文案由「缩略图」改为「悬浮缩略图」（悬停说明「图表悬浮缩略图：滚动离开图表后置顶显示」不变，开启时的高亮样式也不变）。</dd><dt>一行重新分成左右两组</dt><dd>「横向移动」归到左边那组，跟 K 线周期 / 查看范围 / 图表连在一起；右边只留缩放组（− / 100% / + / 重置）和「悬浮缩略图」，两者紧挨着整体贴住右边缘。右对齐的支点挂在右侧组的第一个元素（缩放组）上，组内彼此只隔工具栏统一的 6 像素 —— 支点若挂到组内靠后的元素上，就会在组内空出一大片。窄屏下这颗按钮的位置与改造前一致，小屏时不会跳到别处。</dd><dt>多周期共振：结论挪到卡片头部，落在标题右侧</dt><dd>原先结论徽标（如「强共振·多 (4/4) 强度 83」）和四个周期的标签挤在右侧同一栏里，看结论得先在一排小标签上方找。现在结论单独渲染到标题右侧的槽位，卡片变成「左侧标题 + 结论 → 右侧逐周期标签」的读法：一眼先看到结论，再往下看是哪个周期在拖后腿。</dd><dt>周期标签不再标注数据源</dt><dd>每个周期标签尾部原本还挂着一个数据源小字，与这个模块要表达的「方向是否一致」无关，只会让一行标签更宽更挤，现已去掉，标签只保留周期、方向与评分。</dd><dt>感叹号里补上完整用法</dt><dd>说明从一句「一致性越高越好」扩成完整的使用说明：四个周期的权重、结论与「强度 0–100」怎么读、红色虚线框代表与主流方向相反的冲突周期、强共振时该注意什么、出现分歧时怎么处理、为什么优先做与日线同向的交易。说明较长，浮层现在有高度上限并可在内部滚动，鼠标停在说明上也不会把它关掉。顺手把「周期涨幅」卡片的说明拆出来单独写（原先两张卡共用同一段共振说明）。</dd><dt>自动计算：打开就算一次，之后按周期各自刷新</dt><dd>原先只有点按钮才计算（那个 15 秒的静默定时器还会每次强制把四个周期全部重拉）。现在打开页面、等首屏 K 线画完就自动算一次；之后每 20 秒做一次「到期检查」，只重算缓存已过期的周期 —— 15m 约每分钟、1h 约 5 分钟、4h 约 15 分钟、1d 约 1 小时各发一次请求，四个周期共 800 根 K 线不会被每分钟重拉一遍。检查本身不发请求，所以节拍可以取得比刷新间隔小得多。点「计算共振」仍是立即强制全部重算；浏览器标签切到后台时暂停，切回来恢复。</dd><dt>工具栏按钮的边框统一成一档</dt><dd>同样一排按钮，边框颜色原先分成三档：左边三个控制按钮是 0.26 的不透明度，缩放组 0.18，「横向移动」与「悬浮缩略图」只有 0.13 —— 都是 1 像素的线，浅的那几条看着就比深的细。现在统一到与左侧控制按钮相同的 0.26，圆角也一并统一成 8 像素，一排扫过去粗细与深浅一致。</dd><dt>图例区整排上提，省下的高度让给图表</dt><dd>工具栏与「锤子线 / 流星线」那行注释之间原来隔着 20 像素（工具栏下边距 12 + 图例区上内边距 8），两行图例之间 10 像素，图例到图表顶之间还有 10 像素。现在收成 8 / 8 / 4，图例区整体上提 6 到 14 像素，画面更紧凑；省下来的高度直接补给图表主体，绘图区高度由 580 提到 600 像素，实际可绘制的画面部分相应高出一截。<dt>多周期共振：加周线、加一句短结论、按钮贴到标签旁</dt><dd>① 周期加了一档周线，现在是 15m / 1h / 4h / 1d / 1w 五个，权重依次 0.05 / 0.1 / 0.2 / 0.3 / 0.35（周期越长分量越重）；判定门槛改成按比例算，五个周期里 4 个同向算「多数」、全部同向算「强共振」，以后再加周期门槛会自动跟着走。周线一根 K 线是一周，所以它的自动刷新节奏是约 6 小时一次，不必勤刷。② 五个周期标签按时间从小到大排（原先大周期在前，读起来是倒的）。③ 标题右侧补了一句几个字的短结论 —— 全线偏多 / 多头占优 / 空头占优 / 多空分歧 / 方向不明，跟着方向变色；原先徽标与按钮之间那块是空的，整行看着左重右轻。④ 「计算共振」按钮从卡片正中挪到最右侧，紧挨着周期标签，改完这一行是「左边看结论、右边看细节与操作」。</dd></dl><hr>` + v21128PushModalCenterChangelog;
  // v2.11.36：研究参数外置 —— 门槛与权重收进单一配置源
  const v21136TuningChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.11.36 更新日志</b><dl><dt>研究模块的门槛与权重收进一个配置源</dt><dd>震荡带倍数、独立样本门槛、成本模型、融合权重此前散在十几个函数里，没人能把它们放在一起审查，改一个数得先确认它到底有几个副本。现在全部集中在服务端一个配置块（105 项），可由环境变量 BTC_RESEARCH_TUNING 覆盖，并在研究卡片新增的「参数与门槛」面板里摊开。<br>配置带指纹：每份研究结果都标明自己是在哪套配置下产出的，两份结果只有指纹相同才允许互相比较 —— 指纹不同就说明规则变了，不该被读成「模型变好了」或「模型变差了」。<br>新增一项构建期自检（<code>npm run check</code> 内），检查每个参数是否真被读取、每处引用是否都能解析；它当天就抓到一个只声明未使用的死参数。<br><span class="muted">默认值与重构前逐项相同，回放结果完全复现（15m/1h/4h/1d 的 flat 占比 98.9%/97.4%/96.1%/100% 不变），本次改动不改变任何现有结论。</span></dd></dl><hr>` + v21136TuningChangelog;
  // v2.11.39：两个悬浮按钮统一「贴边吸附 + 静置淡化」，并修复 AI 助手按钮被推出视口后消失
  const v21139FloatDockChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.11.39 更新日志</b><dl><dt>修复：AI 助手按钮有时会「不见了」</dt><dd>按钮的位置是按坐标记在本机的。在较宽的窗口里把它拖到右侧、之后换到更窄的窗口（或把窗口调小），旧坐标就落到了屏幕外 —— 按钮其实一直在页面上，只是停在看不见的地方，而恢复位置时没有把它拉回可视区。现在读取记忆位置时会先把坐标夹回当前视口，窗口尺寸变化时再夹一次；已经被旧坐标推到屏幕外的，刷新页面就会自己回到可见区域。</dd><dt>修复：AI 配置接口偶发失败时按钮不再整个消失</dt><dd>按钮原先只认一次接口结果：本机服务正在重启、或网络抖一下就会读不到配置，于是按钮被直接隐藏，看着像这个功能被删掉了。现在会退避重试几次；确实读不到配置时也保留按钮（点开有明确提示），入口不会凭空消失。</dd><dt>两个悬浮按钮统一：拖到边缘自动吸附，只露 45% 在外面</dt><dd>「AI 助手」与「从欧易同步持仓」现在行为一致：把按钮拖到屏幕左边缘或右边缘附近松手，它会吸附到那条边上、并沿边藏起 55%，屏幕里正好留下 45%；鼠标搭上去按钮滑回完整形态，移开再收回。想恢复完整显示，把它拖离边缘即可。吸附状态会记住，刷新后仍贴在同一条边上（换了窗口大小会跟到新的边缘）。</dd><dt>两颗按钮的尺寸规格完全对齐，并排贴着不会一大一小</dt><dd>收起后两者统一成同一个盒子（宽 80 × 高 40），露出的 45% 都是 36 像素宽；展开态的高度、圆角、字号、字重、边框粗细也逐项对齐 —— 此前「同步持仓」比「AI 助手」矮一档、字也小一号，并排吸在屏幕两侧时一个大一个小很扎眼。图标统一 18 像素，在露出的 36 像素里居中。<br>收窄用的是宽度上限而不是写死宽度：写死宽度会把「从欧易同步持仓」挤成竖排三行、「AI 助手」挤成两行（鼠标搭上去展开时尤其明显）—— 用上限则既能收窄、又能平滑放开回一行。</dd><dt>露在外面的那一半显示图标，一眼能分清哪个是哪个</dt><dd>贴边之后文字收起，留下的半个只显示一个图标：<b>AI 助手</b>是星芒，<b>从欧易同步持仓</b>是循环箭头。两个按钮都带光效：AI 助手沿用原有的红→青辉光与彩虹色循环，同步持仓新增一层向外扩散的波纹环加呼吸光晕。拖动过程中光效会暂时停下，免得和缩放动画叠在一起显得吵。</dd><dt>页面侧兜底：扩展那颗按钮即使没更新，也会被钉到同一规格</dt><dd>「从欧易同步持仓」由浏览器扩展注入，而扩展是本机手动加载的 —— 扩展代码改完必须去扩展页点一次刷新才会进浏览器。漏刷一次，页面上就会出现「页面这颗已经更新、扩展那颗还是旧规格」，并排看就是一个大一个小（甚至被折行的文字撑高），而这事从页面上完全看不出来。现在页面会用优先级更高的样式把它的尺寸、半隐藏位移、宽度上限与图标位置一并钉住：<b>只要刷新页面，两颗就一致</b>，不必再单独去动扩展。扩展更新到新版后两边数值相同，不会打架。</dd><dt>不用的时候自动淡化，不再常亮挡着看盘</dt><dd>光标离开按钮约 2.6 秒后，按钮整体淡化到三成左右；鼠标移回去立刻恢复。已贴边收起时只露一条，不再叠加淡化。AI 助手原有的光效与闪烁动效保持不变 —— 淡化只是整体透明度变化，动效照常运行。</dd><dt>怎么让按钮立刻回到默认位置</dt><dd>把按钮拖离边缘即可恢复完整形态；想彻底回到初始的右下角，在本机页面控制台执行 <code>localStorage.removeItem("btc_ai_launch_pos")</code>（AI 助手）或 <code>localStorage.removeItem("okxFiller:btnPos")</code>（同步持仓）后刷新页面。</dd><dt>图表卡片内的元素左边缘与 K 线主体对齐</dt><dd>图表本身用负外边距铺到卡片内边距之外，而工具栏还留着 10 像素的左内缩、图例区 2 像素、底部两行说明各 20 像素，从上往下看左边就一节一节地参差 —— 有的缩在里、有的探在外。现在工具栏、图例区、底部说明都跟图表走同一条边界（左右各外扩 10 像素、水平内边距归零），整列左边缘与 K 线主体落在同一条竖线上，同时与卡片边框之间留出约 11 像素的空隙（外扩量一开始取 16 像素，会贴死卡片边框、只剩 5 像素余量，已收回 10 像素）。顺带右侧的「悬浮缩略图」也贴到图表右边缘，一排按钮与图表同宽。</dd></dl><hr>` + v21139FloatDockChangelog;
  // v2.11.46：研究侧两件事 —— 升级门槛按周期分别配置、合约资金费率接成第二个消融因子
  const v21146FundingFactorChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.11.46 更新日志</b><dl><dt>升级门槛改为按周期分别配置</dt><dd>四个周期此前共用同一个独立样本门槛（20 条）。但一个独立样本的代价就是一个持有期：20 条在 15m 约 5 小时、在 4h 约 3.3 天、在 1d 却是整整 20 天 —— 日线因此成了升级链上唯一的串行约束，把另外三个周期一起拖了三周。现在门槛可以按周期给出，日线降到 10 天证据；每道门槛同时折算成真实等待时间显示在候选进度上，「20 条」不再让人误以为四个周期等得一样久。这是有意用统计功效换决策节奏：降低门槛本身不会导致提前升级，质量、校准与稳健三道门仍要在同一批配对样本上通过。</dd><dt>合约资金费率接成第二个消融因子</dt><dd>资金费率是持有永续的代价，为正即多头拥挤。已从交易所回填约三年、3285 条结算（每 8 小时一条），覆盖远超现有 K 线；每个派生值只用它之前的结算计算，并按 funding_at ≤ 桶时刻 对齐，不构成前视。消融装置也从「宏观 vs 无宏观」泛化为逐因子对比：每个因子臂与基线臂只差它自己那一块列，并各自给出「暴露」条件分组 —— 全局均值会掩盖一个只在窄区间起作用的因子。</dd><dt>结算出来的结论</dt><dd>资金费率在四个周期上都没有方向增量：15m −0.12pp、1h −0.29pp、4h +0.23pp、1d 0.00pp，全部落在 ±0.5pp 判定带内；而在它本该起作用的拥挤极端子集（|z| 大于 1，约 680 条）上，1h 反而录得 −0.73pp。这与宏观日程的结论一致 —— 这类「拥挤度」因子影响的是波动与尾部，不是方向。另一个观察：4h 在非极端区间 +0.48pp、在极端区间 −0.15pp，方向相反，说明那点正值更像噪声。两臂列数 8 → 12 是「它真的进了模型」的前提断言；宏观臂的数值与上一轮逐项一致，说明这次泛化重构没有改变任何已有结论。</dd><dt>顺带修掉的两处</dt><dd>一是消融的「暴露分组」此前把包装过的臂对象传给了对比函数，导致所有条件差值静默变成 null（面板显示成「--」而不是报错）；二是调参接线自检识别不了「按变量键读取配置」这种用法，会把按周期的门槛表误判成死参数 —— 现在它显式识别该模式，并单独报出有多少叶子是经计算键读取的。</dd><dt>价格轴从右侧独立一条改成内嵌进图表</dt><dd>价格刻度原先独占画布右侧 74 像素的空白带，数字离图很远、K 线的可用宽度却被压掉一截。现在网格线一路画到画布右边缘，价格坐在半透明圆角底片上、贴着右缘：既能一眼对上是哪条线，也不至于糊住最右边那几根 K 线，同时把那 74 像素还给了 K 线 —— 主图与 RSI 副图的可绘制宽度一起变宽。数字顺带改成与顶部大报价一致的千分位写法（81,985.22，而不是 81985.22），八位数的价格一眼就能读出量级。</dd><dt>时间轴的首尾标签与刻度线</dt><dd>最左边那个时间原先显示成「-19 22:37」，是被裁掉了一截：标签按刻度位置居中，而第一个刻度正好落在绘图区左边缘，于是有一半落在画布外。现在首尾两个标签改成贴边对齐（左边的左对齐到绘图区起点、右边的右对齐到终点），中间的仍然居中。刻度线本身加长到 6 像素、亮度提了一档，只落在有标签的关键时间点上、不额外加密，起的是刻度尺那种定位作用。</dd><dt>价格数字不再被 K 线压住，右上角提示也让开了位置</dt><dd>价格刻度改成内嵌之后，它是在 K 线之前画的，于是最右侧那几根蜡烛会把数字盖掉；右上角的「超买 / 跌破 VWAP」提示又是右对齐到画布边缘，跟顶部的价格数字叠在一起。现在价格数字与底片挪到全部图形画完之后再落笔、压在最上层，提示则右退 78 像素给价格底片让位，两处都不再打架。</dd><dt>副图（成交量 / RSI）与主图同宽</dt><dd>上一版把主图右侧的价格轴内嵌进来、K 线可用宽度多了 74 像素，但下方成交量与 RSI 的副图仍然写着自己的一份几何（右留白 74），结果只有主图变宽、副图右边空出一截。现在副图直接复用主图的左右几何常量，两边永远同宽；顺带修掉副图点击命中区一直用另一个左边界（52 而不是 18）导致点选位置与看到的柱子差 34 像素的老问题。</dd><dt>时间轴的刻度线加粗提亮</dt><dd>刻度线之前与网格线是同一个色系，扫过去几乎找不到在哪。现在换成偏蓝的亮色、线宽加到 2 像素、长度 7 像素，仍然只落在有标签的关键时间点上，不额外加密。</dd><dt>图表左右留白对称</dt><dd>价格轴改成内嵌之后，右留白一度收到 0，K 线贴着画布右边缘、左边却留着 18 像素间隙，看起来「一头贴边、一头留白」。现在右侧也回到 18 像素，与左侧同宽；价格数字作为浮层压在绘图区右端之上，不再占用独立的轴带。</dd><dt>价格数字默认让位给 K 线，点一下才凸显</dt><dd>价格数字压在 K 线之上，默认会盖住最右侧那几根蜡烛。现在默认状态整块压到半透明（约六成），只在余光里提示价格档位、K 线优先；指针移到数字上会出现手型光标，点一下它单独恢复全不透明度、跳到最前，再点一下空白处就收回去。点空白那一次不会顺带画出选区 —— 用户要的是「把数字收回去」，不该在图上留一段框选。</dd></dl><hr>` + v21146FundingFactorChangelog;
  // v2.11.64：消融加「波动口径」（并先证明不做这条通道就测不出东西），日线预热按周期放宽、各臂共享近邻投影
  const v21164VolatilityAblationChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.11.64 更新日志</b><dl><dt>消融实验新增「波动口径」：第二个问题，答案不一样</dt><dd>此前消融只回答「能否改善方向判定」。但前两轮的结论是这类拥挤度因子影响波动、不影响方向 —— 而模块里没有任何口径能验证这句话。现在每个周期多出一行读数：大动占比、基线的波动技巧、预测占比，以及该因子带来的 Δ Brier 技巧与 Δ AUC。两个指标读法不同：Brier 技巧看数值尺度，AUC 只看排序且与阈值无关；二者背离意味着「排序里有信号、但数值标定不对」，这与「没有信号」是两件事。</dd><dt>先说一个结构性发现：不做这条通道，波动永远测不出东西</dt><dd>波动口径写好、第一次运行的结果是每个因子的 Δ 都<b>恰好为 0.00pp</b>。这不是「因子没有波动信息」，而是架构决定的：实时融合的震荡概率完全取自近邻池（1 − P(震荡)），特征列在设计上根本到不了预测的波动那一侧，所以任何因子对波动的影响都无法被观测到。为此给每个臂的训练额外加了一个「波动头」—— 同样的特征列、同样的规则，标签改成「是否离开震荡带」，且用全部行训练而不是方向那少数。它做成显式开关，实时路径与已发布的回放口径保持完全不变。没有这个头，波动口径测的就是一条常数为零的线。</dd><dt>波动口径的第一个结论：水平标定在滚动预测里系统性失败</dt><dd>波动头能在排序上跑赢随机（AUC 0.618 / 0.599 / 0.545 / 0.520），但报不出正确的数值标定：15m / 1h / 4h 的事后大动基率是 22.2% / 24.0% / 24.3%，而它的预测占比是 34.6% / 35.9% / 35.0%，高出四到六成（尺度 1.44–1.56 倍）；日线是反过来的一例 —— 预测占比 22.3% 略低于基率 24.3%，Brier 技巧却是四个周期里最差的 −21.08pp，因为它的概率过度分散、排序又几乎没信息（AUC 0.520）。<b>同一套头在 1d 上的偏向会随样本变化翻转</b>（日线样本从 620 增到 720 之后就翻了一次），这本身就是结论的一部分。原因不是实现错误，而是回放的评估方式：校准用的是训练期切片，被打分的桶在更晚的时段，而波动水平本身随时段漂移。结论是波动的绝对水平在滚动预测里不可靠，<b>Brier 技巧只能当相对量读、排序看 AUC</b>。另需注意 Brier 技巧的基准是评估窗口的真实基率 —— 一个事后才可知的基准，所以负值只说明「打不过事后基率」，跨臂的差值仍然可比。</dd><dt>因子在波动口径上的表现</dt><dd><b>资金费率</b>：四个周期的 Brier 技巧全部小幅改善（+0.90 / +0.96 / +0.16 / +1.05pp），但 AUC 几乎不动（−0.003 / +0.004 / +0.003 / +0.001）—— 改善的是<b>水平</b>而不是<b>排序</b>。这与「拥挤度决定波动水平、而非逐桶的波动择时」吻合，也解释了它为什么在方向口径上同样测不出东西。<b>宏观日程</b>：全局没有正面证据（−0.38 / +0.34 / +1.05 / −0.07pp），且在事件窗口内对排序是负的（15m AUC 0.697 → 0.652、1h 0.683 → 0.615）。唯一像发现的是 4h 事件窗口内（ΔBSS +12.17pp、AUC +0.051 两者都向好），但它的绝对值只是从 −60.55pp 修到 −48.38pp —— 那个子集的大动基率只有 10.6%（事件期间波动带本身被撑宽，反而更少走出带），而模型仍按 32% 上下去报，差了三倍；只看差值会把这个格子读成好消息。</dd><dt>日线预热长度按周期配置，把被浪费的日线历史拿回来</dt><dd>回放的预热长度此前是全局 400 根 —— 占日内历史的五分之一，却占日线历史的五分之二。也就是说日线周期静默丢掉了唯一那份日线历史里的 40%（1022 根里的 401 根），而训练器自己的下限要的远少于这个数。现在日线单独设为 300：1d 的独立样本 620 → <b>720</b>，三段训练全部成功、没有被跳过的段，另外三个周期的数值一字未变。取 300 而不是更低，是因为训练器要求每个切分至少 12 条方向样本、而日线约 23% 是方向样本 —— 再往下就会开始跳段。</dd><dt>消融提速：各臂共享同一份近邻投影</dt><dd>近邻投影只取决于 K 线与桶，与模型、也与它拿到了哪一块特征无关。也就是说每个消融臂在同一个桶上算出的投影完全相同，而此前三臂各算一遍，成本是「桶数 × 历史长度」的重复。现在每个周期一份缓存、各臂共享，<b>数值逐字节相同</b>（两种设置交替跑八次，去掉时间戳后载荷完全一致），耗时约为原来的<b>五分之四</b>（同机交替实测 45.4s → 35.7s，另一次独立复测 53.7s → 42.7s，两次比值 0.79）。这个开关保留在本机环境变量里，所以这次的等价性随时可以复验，而不是只靠推理断言。</dd><dt>被跳过的训练段现在会显式报出</dt><dd>回放里每个周期由若干段构成，某一段样本不足时模型根本拟合不出来、整段被跳过 —— 而此前这在面板上完全看不出来，看着像从来没有过的覆盖。现在只要有跳过就会在周期行上标出「跳过训练段 N/M」。以当前数据，15m / 1h / 4h 各有 2 段被跳过（共 8 段），这也是这批日内结论本就该被读作「基于 6 段」的地方。</dd><dt>波动这一行的判定改成分别说水平与排序</dt><dd>只给一句「有增量」会把「整体水位变了、排序反而更差」读成好消息，而这恰好是真实出现的情形（4h 事件窗口：Brier 技巧 +1.03pp 而 AUC −1.40pp）。现在这行的结论会写成「水平与排序同增 / 仅水平改善 / 仅排序改善 / 仅水平改善·排序变差 / 两项同降 / 仅水平变差 / 仅排序变差」七种之一，Δ AUC 也单独着色，不再被 Brier 技巧的结论盖住。</dd><dt>消融按钮不再每次都重算</dt><dd>按钮此前固定带 <code>refresh=1</code>，于是每次点击都重跑全部回放（一到两分钟），而服务端 30 分钟内的缓存永远不会被用到 —— 30 分钟内重算只能得到同一份配置、同一批 K 线下的同一批数字。现在「运行消融实验」优先复用缓存（秒回），需要重跑时点旁边的「强制重算」，结果里也标明本次是否来自缓存。</dd><dt>价格纵坐标可以换到左侧，也可以整体收起</dt><dd>「图表」菜单新增一组控制：一个「价格坐标」开关，加「贴左 / 贴右」两个位置按钮。它管的是图表里那一列价格数字（纵坐标本身）：贴左之后数字落在绘图区左端、贴右回到默认的右端；关掉则整列数字收起、横向网格线保留，把画面让给 K 线。开关与位置都记在本机，刷新后保持。仓位线（做多 / 做空买入价、爆仓价）的金额维持原样，仍跟在各自线名后面。</dd><dt>RSI 曲线左端不再缺一段</dt><dd>RSI(14) 的前 14 根天然算不出值 —— 它需要 14 个涨跌幅先做预热。而原先曲线是直接拿「当前可见范围」那一段收盘价去算的，于是可见范围的最左边永远缺一截，而且每横向滚动一次就重新缺一次。现在改为用整段 K 线算完之后再切出可见的那一段，只有数据最开头才可能缺。</dd><dt>横向网格线不再顶到图表边缘</dt><dd>上一版把价格轴内嵌进绘图区时，网格线顺手画到了画布最右缘 —— 于是右边跟容器边框贴死、左边却留着 18 像素，看着一头齐一头空。现在网格线停在绘图区右边界（画布宽减去 18），与左端完全对称，两端留出同样的空隙。</dd></dl><hr>` + v21164VolatilityAblationChangelog;
  const v21170VolatilityCalibrationChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.11.70 更新日志</b><dl><dt>波动口径的结论翻了一半：问题不在校准，是模型自己没收敛</dt><dd>上一版给波动口径做了装置，结论是「排序能赢随机、但数值标定系统性失败」。这一版去查它为什么失败 —— 不是校准的问题，是逻辑回归自己就没收敛：它在<b>自己的训练行</b>上报出 43.0% 的平均概率，而基率只有 22.6%，整整高 20.4pp。一个收敛的逻辑回归在训练集上的平均预测必须等于基率（截距无正则时，梯度为零就意味着这一点），所以那 20pp 全部是截距没走到位，而现有的迭代方案只把它推到了目标的约四分之一。截距是唯一一个「收敛值事先已知」的参数，于是改成直接解出来（它对 bias 单调，二分即可）：训练集偏差当场归零，评估期的尺度从 1.56 / 1.50 / 1.44 变成 <b>1.01 / 1.01 / 0.93</b>，Brier 技巧从 −7.34 / −6.32 / −5.54 / −21.08 变成 <b>+1.23 / +1.10 / −0.27 / −14.36</b>。<b>15m 与 1h 的波动头并不是没有技巧，是那份技巧一直被一个没走到位的截距吃掉。</b></dd><dt>一个因子会替一个坏掉的截距做事，于是它看起来有效</dt><dd>修正前，资金费率在四个周期上<b>一致地</b>把波动水平改善了 0.90 / 0.96 / 0.16 / 1.05pp，那是上一版的主要结论之一。修正后这些数字缩到 −0.07 / −0.02 / +0.17 / +0.52pp，基本消失。原因不神秘：截距严重偏低时，模型需要有人帮它把整体水位压下来，而资金费率的 level 列恰好携带水位信息 —— 它替截距做了这件事。截距一旦被解准，这份「帮助」就无事可做。<b>要记的是方法而不是结论：一个因子在标定坏掉时看起来有效，不等于它对目标有信息。</b></dd><dt>每个差值现在会自己说「这个结论现在能不能下」</dt><dd>样本量只说明有多少个观察，不说明它们是否指向同一件事 —— 而这个模块已经被这一点咬过一次（日线的波动读数在样本从 620 涨到 720 时就翻了向）。现在每个差值都会被沿独立样本对半切开重算一遍：两个半段都越过阈值、方向却相反时，那一行直接标出「前后段反向·还不可判」，而不是继续报一个取决于你碰巧相信哪一半的结论。它在第一次运行就抓到了一个 —— 15m 资金费率的 ΔAUC 前半 −1.40、后半 +0.54。</dd><dt>判定带从两档变三档，AUC 有了自己的那一条</dt><dd>AUC 增量不是百分点 —— 它是 0 到 1 之间的统计量上的裸增量，此前却和 Brier 技巧共用同一个「±0.5pp」。两者恰好都落在可用的数值上，所以一直没暴露，但它们不可能被分别调整：想放松排序的判定，就会连带放松水平。现在分成三个：方向 ±0.5pp、波动水平 ±0.5pp、波动排序 ±0.005。「前后段反向」用的是第三种颜色（琥珀）而不是红或绿 —— 它说的是证据分裂，不是这个因子有害。</dd><dt>面板里直接写了「这个面板怎么读」</dt><dd>把「先看什么、再看什么」放到数字旁边，而不是只留给文档：先看这一行值不值得信（样本数、有没有跳过训练段或前后段反向），再看差值落在带内还是带外，再看波动那行的两个数各自回答哪一个问题，再看「预测/实际」的倍数说明的是尺度问题还是信号问题，最后一条提醒「只在暴露条件里动过」的那些格子意味着什么。</dd></dl><hr>` + v21170VolatilityCalibrationChangelog;
  const v21171DirectionCalibrationChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.11.71 更新日志</b><dl><dt>方向头（线上信号）的 Platt 同样欠收敛，系统性高估「涨」</dt><dd>波动头那次的「截距没走到位的 20pp」让人怀疑方向头有没有同样的问题 —— 它喂的是线上真实信号，所以先看清楚再动。结论是<b>同一类缺陷、出在不同的一步</b>：方向头的裸逻辑回归因为基率就在 0.5 附近，训练集偏移只有 1–4pp（不像波动头那次 20pp），但<b>Platt 校准步</b>欠收敛，导致在校准切片上把「涨」的均值报成比真实基率高 3.2 / 4.8 / 10.1 / 1.6pp（4h 最严重），并直接流到测试切片（高 2.7 / 8.9 / 11.7 / 2.8pp）和实时信号。换句话说，指标在 4h 上一半时间喊「涨」、实际只有 34% 真的涨。</dd><dt>修法：把 Platt 截距解到「校准边际均值 = 校准基率」</dt><dd>和波动头同一条思路，但作用在 Platt 这一步：校准好的模型应当重现它拟合所在切片的率，而这个值是已知的。于是把截距（slope 保留 SGD 学到的）二分解到让校准切片上的平均预测恰好等于校准基率。单调性不依赖 slope 符号（对截距的导数是 sigmoid·(1−sigmoid)，恒正），所以二分不会跑偏。事后可检验的不变量是：校准切片上的「预测 − 实际」应当为零。</dd><dt>不变量成立，且把有信号的周期救了回来</dt><dd>修正后四个周期的校准偏移（Δcal）全部归零。关键改善出现在有信号的 1h / 4h：测试切片对「涨」的高估从 +8.9 / +11.7pp 降到 <b>+4.1 / +1.5pp</b>；Brier 技巧从 +5.8% / +7.0% 升到 <b>+8.1% / +12.4%</b>；ECE 从 8.9% / 19.3% 降到 <b>4.9% / 10.7%</b>（4h 从「很差」变「中等」）。残余的测试偏移现在来自校准与测试切片之间的真实 regime 差异（例如 1h 测试切片本身偏多、占 53% 而校准只有 45%），已不是标定 bug。1d 的 ECE 反弹是样本噪声（日线只有约 40 个方向样本，分箱 n=1→7），其 Δtest 与 BSS 都在改善，不读它。</dd><dt>方向头现在也报三段式诊断，面板里多了一行</dt><dd>方向头与波动头一样有了「训练 / 校准 / 测试」三段的输出率读数，进了 API（baseline.directionHead）也在每个周期的消融卡里多了一行「方向头」：AUC、BSS、ECE、校准状态（已校准 / 偏差 Npp）、以及「实测 / 预测」—— 后者离得越近，越说明线上信号对自己基率是诚实的。这直接回答了「怎么知道方向信号现在是好还是坏」。</dd></dl><hr>` + v21171DirectionCalibrationChangelog;
  const v21172TradeMarkersChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.11.72 更新日志</b><dl><dt>主图新增买入/卖出气球标记（B/S）</dt><dd>在 K 线主图上用 TradingView 风格的气球标出你的买入点与卖出点：<b>做多（买入）= 绿色 B 气球挂在 K 线下方</b>，<b>做空（卖出开空）= 红色 S 气球挂在上方</b>，带指向锚定 K 线的小尾巴，亮色主题自动补白描边。时间锚点来自「从欧易同步持仓」扩展记录的开仓时间（指纹「方向@开仓均价」，精确匹配失败时按同方向价差 ≤0.2% 就近匹配）；开仓时间精度为「成交明细秒级 → K 线反查 → 首次同步 → 手动」四级自动升级，越用越准。持仓卡一有改动主图立即重绘，气球跟着走；没同步过或没有时间记录的仓位不显示标记。标记不参与价格缩放，不会把 K 线压扁。</dd></dl><hr>` + v21172TradeMarkersChangelog;
  // v2.12.0：多币种模式（比特币模式 + 多币种模式）。
  log.innerHTML = `<b>v2.12.0 更新日志</b><dl><dt>新增：顶部「比特币模式 / 多币种模式」开关</dt><dd>顶栏账号左侧新增一个开关按钮，在两种模式之间切换，选择记在本机、刷新后保持。<b>默认仍是比特币模式</b> —— 该模式下页面与本次升级之前逐字一致，包括标题、交易对显示、数据源与全部文案，习惯旧版的用户不会看到任何变化。</dd><dt>新增：多币种模式与币种切换器</dt><dd>切到多币种模式后，实时价格上方出现币种切换器，可在 <b>BTC / ETH（以太坊）/ ZEC（Zcash）/ BNB</b> 之间选择。选中某个币种后，整页都基于它重新生成：K 线与图表、当前规则信号、指标明细、形态识别与关键位、我的持仓与强平概率、OKX 市场微观结构，全部换成该币种的数据；「BTC 的多因子研究预测」相应变成「ETH 的多因子研究预测」，宏观事件与宏观环境影响里的「利好 BTC / 利空 BTC」也一并跟着当前币种走。</dd><dt>数据层：币种贯穿了服务端整条链路</dt><dd>交易所合约 ID 原先散落在服务端二十多处（BTC-USDT-SWAP / BTCUSDT 等），现在收敛到唯一一份币种注册表；每个请求按 <code>?symbol=</code> 切换缓存键、交易所合约与本地库，四个币种在 OKX、Binance、Gate、Coinbase 四个数据源上都已验证可用。OKX 公共 WebSocket 改为一条连接同时订阅四个币种的盘口、成交、资金费率与持仓量，切换币种无需重连、没有订阅延迟。</dd><dt>为什么比特币模式能完全不变</dt><dd>不是靠分支兼容：BTC 走的就是改造前那一条代码路径 —— 同一个库文件、同一套字段、同一批合约 ID。其余币种各自落在独立的本地库（<code>market-&lt;币种&gt;.sqlite</code>），既不会污染已有的历史样本，也不会让新币种的样本被 BTC 的旧数据带偏。</dd><dt>需要注意的边界</dt><dd>新币种的本地历史样本是空的，多因子研究预测的记分卡与宏观事件因子需要从零积累（可用研究卡上的回填按钮主动拉取）；恐惧贪婪指数与美联储／投资日历属于宏观数据，与币种无关，四个币种共用同一份，不重复请求上游。</dd></dl><hr>` + v21172TradeMarkersChangelog;
  // v2.12.1：语音「重复播报 · 冷却」真正对每一次触发生效；另拦掉异常报价跳变导致的多规则同拍齐响。
  const v2121VoiceCooldownChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.1 更新日志</b><dl><dt>「重复播报 · 冷却 N 分钟」现在真的按冷却走</dt><dd>此前冷却只拦得住“状态一直满足”的那种重复，拦不住“价格反复穿越目标位”的情况：以「价格达到 X」为例，它在穿越的那一拍判定为满足、下一拍就回到不满足，于是价格在 X 上下震荡时，<b>每一次穿越都被当成一次全新的触发，冷却被整段跳过</b>。实测设了 5 分钟冷却的「价格达到 81,000」在 18 秒内播报了两次（当时价格在 81,000 上下 ±40 美元来回走，32 分钟里穿越了 15 次），听感就是“一直在播报同一个价位”。现在冷却对每一次触发都生效：重复规则首次触发仍立即出声，之后一律等冷却（「不冷却」档也保留 30 秒下限，防每秒狂响）；「仅播报一次」规则行为不变。想彻底避免同一价位反复播报，可把目标价设在离现价有距离的位置，或把冷却调长。</dd><dt>拦掉一次「多价位同拍齐响」的坏读数</dt><dd>另外给播报引擎加了异常报价保护：单拍价格不可能合法地跳 3% 以上，只有页面刚打开时先拿到本机快照价、或行情源短暂串到别的币种这类坏读数才会如此。这种坏读数会让所有「价格达到／越过」类规则在同一瞬间被同时判成穿越 —— 实测 09:44:39.433 有 6 条规则在同一毫秒全部播报（当时 BTC 实际 81,43x，不可能同时穿越 74,500～80,300 这六个价位）。现在这类那一拍只用于对齐价格基准，不参与任何规则判定。</dd></dl><hr>` + v2121VoiceCooldownChangelog;
  // v2.12.2：多币种模式下消息推送/语音播报规则按币种隔离。
  const v2122CoinAlertsChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.2 更新日志</b><dl><dt>多币种模式：推送规则与语音播报按币种独立</dt><dd>此前「消息推送」里的价格预警规则与「同时语音播报」开关写死在 BTC 下，切到 ETH / ZEC / BNB 会穿帮。现在本机规则按币种分别存储：<b>默认是空的</b>，没有任何 BTC 的规则漏进其他币种；在某个币种下添加过规则，切走再切回来依然存在；从未添加过的币种就是没有 —— 四个币种互不串台。</dd><dt>卡片标题与弹窗交易对跟随币种</dt><dd>推送卡片标题小字与「添加预警」弹窗里的交易对，从写死的「₿ BTC/USDT 永续」改为跟随当前币种显示（如 ETH/USDT 永续、ZEC/USDT 永续）；比特币模式下一如既往仍是 ₿ BTC/USDT，与旧版完全一致。</dd><dt>云端规则仍仅 BTC</dt><dd>云端关页推送与多渠道同步目前只服务于比特币（后端 BTC 专属），多币种模式下云端面板会明确提示「该币种仅支持本机规则」，避免误把 BTC 的云规则当成当前币种的。</dd></dl><hr>` + v2122CoinAlertsChangelog;
  // v2.12.3：顶栏模式开关改为分段控件样式。
  const v2123SegmentToggleChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.3 更新日志</b><dl><dt>顶部模式开关改为分段切换按钮</dt><dd>原先「比特币 / 多币种」是一个单按钮，点击后文字整体翻转。现在改成左右两个分段选项组成的控件：选中项有凸起的浅色药丸背景，未选项仅显示文字，和系统 Segmented Control 观感一致；同时支持鼠标悬停高亮与亮色 / 深色主题自适应。</dd><dt>修复：研究卡的「运行消融实验」此前点一次失败一次（HTTP 503）</dt><dd>消融实验一直打不开，只显示一个 HTTP 503。根因在波动头的诊断字段：它本该遍历校准切片的每一行去算平均预测概率，却误用了只含 0/1 标签的那个数组，于是取行特征时拿到空值、标准化在那上面抛错，整个请求随即被兜底成 503。<b>影响范围仅限消融实验</b> —— 波动头是消融专用的量具，实时预测与旁边的「运行历史回放」都不启用它，所以实时信号、历史回放、宏观事件研究与回测数值均未受影响；这也正是旁边那块一直正常的原因。</dd><dt>失败原因不再被折叠成一个状态码</dt><dd>研究卡上的几个取数／计算按钮过去只报「HTTP 503」，把服务端写在响应体里的原因丢掉了。现在失败信息会带上服务端自己的说明（例如 HTTP 503 · Cannot read properties of undefined），一眼能看出是超时、依赖缺失还是代码本身出错。</dd></dl><hr>` + v2123SegmentToggleChangelog;
  // v2.12.4：修复「计算共振」按钮点击后没有反馈、文字也不跟随状态的问题。
  const v2124ResonanceButtonChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.4 更新日志</b><dl><dt>修复：「计算共振」按钮状态不同步</dt><dd>页面自动计算完成后，按钮文字仍然显示「计算共振」，而不是「重新计算共振」，容易让用户以为还没算过、或者点击没生效。现在渲染共振结果时会同步刷新按钮文案。</dd><dt>修复：点击「计算共振」缺少即时反馈</dt><dd>手动点击按钮时，由于各周期缓存仍在有效期内，界面可能瞬间完成、没有任何变化，看起来像「点了没反应」。现在点击后会立即把按钮文案改成「计算中…」，计算结束后再根据是否有结果切到「重新计算共振」或「计算共振」，给用户明确的点击反馈。</dd></dl><hr>` + v2124ResonanceButtonChangelog;
  // v2.12.5：多币种隔离补全 —— 语音规则、持仓、记录簿与云端读写全部按币种独立。
  const v2125CoinScopedStorageChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.5 更新日志</b><dl><dt>多币种：语音播报规则按币种独立</dt><dd>此前「语音播报」里的规则只有一份，切到 ETH / ZEC / BNB 看到的、播出来的仍是 BTC 下设置的内容。现在语音规则按币种分别存储：BTC 沿用原有数据；其余币种<b>默认是空的</b>，没设置过的币种不会再借用 BTC 的规则；在某币种下添加过，切走再切回依然保留。切换币种时播报引擎会重置价格基准与短窗历史 —— 跨币种价格量级差异巨大，沿用旧基准会把切换瞬间当成暴涨暴跌误触发。</dd><dt>多币种：「我的持仓」按币种独立</dt><dd>顶部两张持仓卡与「我的持仓与盈亏估算」表单改为每个币种各存一份：BNB 下看到的就是 BNB 自己的持仓（没填过就是空白），不再是 BTC 的数值；强平概率计算器的「历史持仓价」记录同步按币种分开。切换币种立即生效，各币种互不串台。</dd><dt>多币种：消息推送的本机数据读写按币种取</dt><dd>修复云端同步面板读写的仍是 BTC 本机数据的串台：现在「同步本机规则到云端」「一键同步全部」读写的是当前币种自己的本机规则存储。云端关页推送仍仅 BTC 专属（多币种下云端面板有明确提示）。</dd><dt>持仓云端同步明确为 BTC 专属</dt><dd>其它币种的持仓只存本机：不显示「同步／已同步」徽标，登录后也不会把 BTC 的云端持仓自动回填到其它币种，更不会把其它币种的持仓误写进 BTC 的云端档案；回到 BTC 后一切照旧。</dd></dl><hr>` + v2125CoinScopedStorageChangelog;
  // v2.12.6：切换币种不再弹「已切换到 XX」提示。
  const v2126NoSwitchDialogChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.6 更新日志</b><dl><dt>优化：切换币种不再弹出「已切换到 XX」提示</dt><dd>v2.12.5 在切换币种时会弹一个「已切换到 ETH（以太坊），正在重新加载该币种的全部数据」的提示框，需要手动点掉。实际上切换后顶部标签、币种 chip 高亮与各面板数据都在原地即时刷新，切换结果对用户已经可见，弹窗属于多余打扰 —— 现已移除，切换币种恢复静默原地刷新。</dd></dl><hr>` + v2126NoSwitchDialogChangelog;
  // v2.12.7：顶栏「深色」旁新增设置齿轮，低频入口收进下拉面板。
  const v2127SettingsGearChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.7 更新日志</b><dl><dt>顶栏新增设置齿轮，低频入口收进面板</dt><dd>「深色」按钮旁新增一个齿轮按钮，点击展开下拉面板；原先常驻顶栏的<b>账户、API 接入中心、版本号、连通性测试、数据源切换</b>五个入口全部收进面板内，点击页面其他位置自动收起。顶栏现在只留 模式开关 · 语言 · 全屏 · 深色 · 齿轮，清爽不少。面板内各项功能与原先完全一致：版本号仍可点开更新日志，连通性测试仍带独立详情面板，账户按钮仍展开登录／账户卡片。</dd></dl><hr>` + v2127SettingsGearChangelog;
  // v2.12.8：连通性面板改为显示「服务器 → 上游服务商」与「服务器 → 浏览器」的真实延时。
  const v2128UpstreamLatencyChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.8 更新日志</b><dl><dt>连通性：显示真实的「服务器 → 上游服务商」延时</dt><dd>此前面板里多数项显示「上游 0 ms」且一律绿灯，那是假象：探测的是业务端点，而这些端点几乎都命中缓存（情绪 120 秒、投资日历 300 秒、宏观日历 600 秒、新闻 900 秒），服务端直接返回缓存结果、根本没有发起上游请求，耗时自然统计成 0。现在新增「服务器 → 上游服务商（真实延时）」一组：由服务器直接向 OKX、Binance、Coinbase、Gate、Deribit、FRED、BLS、美国财政部、东方财富、Alternative.me、CoinGecko、mempool.space、Google News、Yahoo Finance、阿里云通义、Edge TTS 共 16 个服务商的真实端点发起请求并计时，完全绕开业务缓存，每个源如实给出毫秒数与颜色 —— <b>1 秒内绿、1–3 秒黄、超过 3 秒或连接失败红</b>。判定为红的项不再计入「可用」数，避免出现「汇总全部通过」却满屏红灯的矛盾。</dd><dt>连通性：汇总区同时给出两段延时</dt><dd>面板顶部现在分两段展示：①服务器 ↔ 你的浏览器（本站往返耗时，本地部署约 2 ms，公网部署通常几十毫秒）②服务器 → 各上游服务商的延时分布（几条快／几条慢／几条超时或失败，并标出最慢的一项）。点击「连通性测试」或「重新检测」都会重跑一次真实探测。</dd></dl><hr>` + v2128UpstreamLatencyChangelog;
  // v2.12.9：语音播报改用微软 Azure AI Speech Service，并按界面语言接入全部音色。
  const v2129AzureSpeechChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.9 更新日志</b><dl><dt>语音播报改用微软 Azure AI Speech（官方 REST）</dt><dd>语音合成此前走两条老路：优先调本地 Piper sidecar（这个容器从未部署过，一直在打一个不存在的地址），失败后回退 Edge TTS 的免费 WebSocket 接口 —— 该接口在国内已被限制，也正是 HK 站点语音不稳的根因。现在主链路换成<b>微软 Azure AI Speech Service</b>：服务器向自己所在区域的官方端点合成 MP3（24 kHz / 48 kbps），线路正统且支持每月 50 万字符的免费额度；本地 Piper 相关代码全部移除。Azure 未配置或调用失败时仍回退 Edge TTS，合成响应会带上 x-voice-engine 头，标明本次实际走的是哪条链路。</dd><dt>音色按界面语言动态接入全部 Azure 音色</dt><dd>音色下拉不再是写死的 21 个，而是启动时拉取当前区域可用的全部音色，并按界面语言分组：中文界面接入全部中文音色（简体、粤语、台湾国语，以及东北话、陕西话、四川话、山东话、河南话、广西方言），英文界面接入全部英文音色（美式、英式、澳式、加拿大、新加坡、印度等）。音色名做了中文化整理：Azure 只给经典音色配了中文名，HD、MAI 这类新代音色返回的都是英文，原样显示会出现「Xiaoxiao Dragon HD Flash Latest」重复两遍的观感，现已统一成「晓辰 · 女声 · HD 超清 · 极速」这类可读名称，并把同一位配音员的经典、多语言、方言、HD 各版本排在一起 —— 中文 75 个音色其实只有 50 位配音员，其中 18 位有多个版本，并不是重复条目；方言与普通话撞名时用地名区分（如「云希 四川」），Azure 最新的 MAI 实验音色沉到列表末尾。「播报引擎」下拉里的「Edge 神经语音（免费）」也更名为「微软云语音（Azure Speech）」。音色清单在服务端缓存 24 小时，未配置 Azure 时自动沿用原有的静态列表。</dd></dl><hr>` + v2129AzureSpeechChangelog;

  // v2.12.10：连通性面板重排 —— 浏览器那一跳只留一个主数据，每行只显示服务器到服务商的真实延时。
  const v21210ConnectivityLatencyChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.10 更新日志</b><dl><dt>连通性：浏览器那一跳只留一个主数据</dt><dd>所有数据都是「浏览器 → 本站 → 服务商」同一条链路，浏览器到服务器这一段的往返跟访问哪个服务商无关，逐行重复显示没有意义。现在面板顶部只给<b>一个主数据</b>「服务器 ↔ 你的浏览器：X ms」（取本次所有成功往返的中位数），下面每一行右侧的数字一律是「服务器 → 该服务商」的真实往返延时。</dd><dt>连通性：服务商延时挂到对应业务行，不再单列一组</dt><dd>原先独立的「服务器 → 上游服务商（真实延时）」一组已取消：OKX、Binance、Yahoo、Alternative.me、Google News、阿里云通义、Azure Speech 等延时直接显示在它们各自的业务行上；宏观日历这类多源聚合的行取所依赖的几个源里最慢的一个并标注「多源取最慢 ×N」；没有被任何业务行认领的服务商（Coinbase、Gate.io、Deribit、CoinGecko、mempool.space）仍按归属补一行，避免重复计数。完全走本机 SQLite 或纯内部处理的行明确标注「本机处理 · 无外部请求」，不再伪装成 0 ms 的上游延时。</dd><dt>连通性：切换语言时整块重绘</dt><dd>修复「中文界面 + 英文分组标题」的混合态：分组标题现在跟随语言即时重绘；面板处于打开状态时切换语言还会顺带重跑一次检测，行名与说明也一并对齐到当前语言。</dd></dl><hr>` + v21210ConnectivityLatencyChangelog;

  // v2.12.11：语音播报全部带币种 —— 实时价与各类状态播报都先说「BTC / ETH / …」。
  const v21211VoiceCoinChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.11 更新日志</b><dl><dt>语音播报：所有播报语都先报币种</dt><dd>引入多币种后，播报语里一直只有价格、没有币种，听到的人无法判断这条播报说的是哪个币。现在<b>全部播报语都先说明币种，且币种一律用英文代码</b>（BTC / ETH / ZEC / BNB），不用「比特币」这类中文名 —— 中文名下紧跟「实时价格」容易被听成行情类型而不是资产名前缀。<br>① 定时播报实时价：精简版念「当前 BTC 实时价格 76287.5」，完整版念「当前 BTC 价格，76287.5」再接持仓对比。<br>② 状态类播报（价格达到／上涨至／下跌至／价格变动／跳价／短时急涨急跌）统一变成「BTC 价格预警。当前 BTC 价格……」—— 规则名与当前价格两处都带币种，单独听到一句也能确认是哪个币；短时急变规则的措辞同时改为「急涨／急跌」，与设置里「短时间急涨／急跌」的叫法一致。<br>③ 理论强平价警告：「BTC 做空理论强平价警告……当前 BTC 价格……」，亏损估算照旧。<br>播报开关、规则、冷却与播放引擎均未改动，切换币种后播报内容自动跟着当前币种走。</dd></dl><hr>` + v21211VoiceCoinChangelog;

  // v2.12.12：音色下拉里点选即自动试听 —— 念一句「我是 X，这是我的声音」。
  const v21212VoicePreviewChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.12 更新日志</b><dl><dt>选音色即试听：点一下就知道选的是谁</dt><dd>以前要挑音色只能先选中、保存，再点一次「试听」才听得到，来回比对十几个音色非常费事。现在<b>在音色下拉里点中任意一条就立刻念一句自我介绍</b>：<br>「晓晓 · 女声 · 经典」→「我是晓晓，这是我的声音。」<br>「云帆 · 男声 · HD 超清 · 极速」→「我是云帆，超清极速，这是我的声音。」<br>文案直接从下拉里<b>显示的那个名字</b>生成，不另存一份对照表 —— 列表写什么就念什么，不会出现「写着 HD 超清、念出来是别的版本」这种错位。三条拼接规则：性别不念（女声／男声）；「经典」是默认代次，念出来是噪音，跳过；其余代次去掉 HD 前缀、抹掉分隔点后连读（超清 · 极速 → 超清极速）。方言音色的显示名带地名（如「云希 四川」），会念成「我是云希，四川，这是我的声音。」而不是别扭的连读；「晓晓 2」这类带数字后缀的名字不会被拆开。本机系统语音的那张下拉同样支持点选试听（念英文音色时用英文句式）。</dd><dt>试听不受总开关与提示音影响</dt><dd>试听是点选动作本身触发的，所以<b>静音状态下（语音总开关关闭）也能试听</b>，方便先把音色挑好再开播报；试听也不再先敲一遍提示音，点完直接开口。另外，点的是 Azure 音色时一律用该音色自身合成，即使「播报引擎」当前选着本机系统语音也能听到真实音色。</dd></dl><hr>` + v21212VoicePreviewChangelog;

  // v2.12.13：修复「点任何 HD 音色都念同一个女声」—— 音色名白名单误杀 + 静默换声。
  const v21213HdVoiceChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.13 更新日志</b><dl><dt>修复：选 HD／极速／MAI 音色时，念出来却是同一个女声</dt><dd>带代次的音色（HD 超清、极速、MAI 二代）在 Azure 里的正式名带一个冒号，例如「云瀚」的高清版是 <code>zh-CN-Yunhan:DragonHDLatestNeural</code>。服务端的音色名白名单把它当成了非法字符，于是<b>把音色悄悄替换成默认的「晓晓」</b>（女声）—— 表现就是「点任何一个 HD 男声，念出来都是同一个人、还是女声」，而且因为声音正常、只是换人，极难判断是哪里出了问题。现在白名单放行冒号（仍然只做防注入校验），并且<b>格式非法时直接报错、绝不替换</b>：让用户听到并非自己选的音色，比直接失败危险得多。</dd><dt>本地区不支持的代次音色直接从下拉里去掉</dt><dd>HD／极速／MAI 代次的音色只在 Azure 的部分区域提供（southeastasia、eastus 等），当前区域（eastasia）合成它们只会返回错误，但音色清单里照旧列着它们。启动时会探测一次本区域是否支持这些代次：不支持就把它们<b>整批从音色下拉里去掉</b>（不留「选了必然失败」的选项），并在下拉下方写明去掉了多少个、以及让它们出现的办法（换成支持 HD 的区域即全部回来）。先前若已选中过这类音色，会自动改回本语言下第一条可用音色，不会停在一个已经消失的选择上。</dd><dt>试听失败不再「悄悄换成本机系统语音」</dt><dd>此前若云端合成没成功，代码会退回用本机系统语音把这句话念一遍 —— 听起来像「音色没变」，实际是换了一套声音。现在音色试听<b>只在成功时出声，失败则如实报错</b>（不会再冒充你选的音色）；广播播报仍保留系统语音兜底，以免彻底静音。</dd></dl><hr>` + v21213HdVoiceChangelog;

  // v2.12.14：音量控件重排 + 新增「音色筛选」（全部 / 男声 / 女声）。
  const v21214VolumeAndFilterChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.14 更新日志</b><dl><dt>音量：百分比挪到标签右边，滑条拉满整行</dt><dd>提示音／语音音量的百分比原先挂在滑条同一行的末尾，栏目一窄就整段换行掉到滑条下面，看着像是「百分比离标签很远」，滑条也只剩半截。现在<b>百分比紧跟「提示音音量／语音音量」标签</b>（同一行、紧邻），<b>滑条独占整行、铺满栏宽</b>，两行高度也对齐了。</dd><dt>音量：100% 时滑条能真正到底</dt><dd>原生滑条的填充比例由浏览器按「拇指可移动区间」折算，<b>拉到 100% 时右端仍会留一小段灰底</b>，看着像没拉到底。现在轨道与拇指改为自绘：填充比例直接用脚本算好的百分比（此前这个变量只有脚本在写、样式里从没用过），并在两端各留半个拇指的内边距，于是 0% 与 100% 的拇指都正好贴住滑条两端，不再有空白。实测 100% 时拇指右缘与滑条右缘重合（差 1 像素以内）。</dd><dt>新增「音色筛选」：全部 / 男声 / 女声</dt><dd>音色下拉上方多了一个筛选框，可按性别缩小音色列表：选「男声」只列男声音色，选「女声」只列女声音色，选「全部」不限制。性别直接取自 Azure 音色表（不是从名字里猜），系统语音那批没有性别字段的则由标签文字兜底判断。<b>筛选只影响列表里列出哪些音色，不会悄悄改动你当前正在用的音色</b> —— 即使当前音色被筛掉（例如在用女声时切到「男声」），实际播报仍是你选的那条，筛完切回「全部」即可看到它。</dd></dl><hr>` + v21214VolumeAndFilterChangelog;

  // v2.12.15：顶栏「₿ 比特币 / 多币种」模式开关比旁边的药丸高出 4px。
  const v21215CoinToggleHeightChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.15 更新日志</b><dl><dt>修复：顶栏的模式开关比旁边的按钮高出 4 像素</dt><dd>「₿ 比特币 / 多币种」这个分段开关是<b>整排里唯一一个不是按钮的元素</b>（EN／全屏／深色／齿轮／多分屏都是 button），所以它没吃到「顶栏按钮统一 36px 高」那条规则，只继承了按钮的「最小高度 34px」，再叠上自己的上下各 2px 内边距与 1px 描边，最终算出 <b>40px</b> —— 比紧挨着的邻居高出 4 像素，上下各冒出一截，整排看着参差、像是没对齐。现在把开关外框<b>显式锁到与邻居一致的 36px</b>，内部两段由外框撑高、文字改为居中，切换观感与原来的位置都没变。</dd></dl><hr>` + v21215CoinToggleHeightChangelog;

  // v2.12.16：分屏面板右上角的喇叭改成「普通模式下该币种播报按钮」的软链接。
  const v21216SplitPaneVoiceLinkChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.16 更新日志</b><dl><dt>分屏：面板上的喇叭改成打开「语音播报设置」</dt><dd>以前分屏每个面板右上角那颗喇叭是它自己的一套简易播报（只念「当前价 + 信号」，30 秒一次），和普通模式下的播报设置完全是两回事 —— 想调音色、加价格预警规则都得先退出分屏。现在它变成普通模式下该币种那颗喇叭的<b>软链接</b>：<b>点它就弹出完整的「语音播报设置」</b>（总开关、定时播报实时价、播报间隔、引擎与音色、按币种隔离的语音规则、播报优先级、音量），而且在分屏里点哪个面板的喇叭，设置面板就自动切到那个币种的规则。关掉设置后主站币种会自动还原成打开前的状态 —— 在分屏里「看一眼某个币的播报设置」不会悄悄改掉你的主视图。</dd><dt>分屏：独立播报的开关搬到顶部「语音优先级」面板</dt><dd>每个币各自独立播报（可同时出声、互不打断）的能力保留，开关移到分屏顶栏的语音面板上：<b>列出当前分屏的所有币种，点一下就开／关该币的独立播报</b>（黄色实心圆点＝开着），按住条目左右拖动仍可调整多条语音同时触发时的播报顺序，「全部播报」按这个顺序依次念一遍。面板上的喇叭图标与这里保持同步 —— 无论从哪边开关，另一边都立刻跟着变。</dd><dt>设置面板标题标出当前币种</dt><dd>分屏里点不同面板的喇叭会来回切币种，标题旁现在会标出「· ETH / USDT」这样的当前币种，一眼就知道这份设置是给哪个币配的；普通模式下点喇叭打开时同样显示当前币种。</dd></dl><hr>` + v21216SplitPaneVoiceLinkChangelog;

  // v2.12.17：分屏顶栏那排语音 chip 收成一颗「播报设置」按钮 + 设置面板（总开关 / 币种顺序 / 引擎）。
  const v21217SplitVoicePanelChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.17 更新日志</b><dl><dt>分屏：顶栏语音区收成一颗「播报设置」按钮</dt><dd>原先顶栏上摊着「🔊 + 各币种 chip + 全部播报」一整排，币种一多就挤。现在只留一颗 <b>🔊 播报设置</b> 按钮，点开一个面板，里面放三件事：<b>总开关</b>、<b>按币种的播报顺序</b>、<b>语音引擎</b>。<br>面板里的顺序列表就是原来的拖动排序（按住条目上下拖，越靠上越先播）；每行左侧的圆点点亮表示该币种参与播报（原来的 chip 开关），右侧按钮直接打开该币种的语音规则设置。</dd><dt>分屏里各币种真正按「该币种自己的语音规则」播报</dt><dd>以前分屏每个面板是它自己的一套简易播报：每 30 秒念一句「价格 + 涨跌 + 信号」，和你在设置里配的语音规则完全没有关系。现在分屏把每个面板的最新价喂给主站的语音引擎，<b>用该币种自己在「语音播报设置」里配的规则</b>（爆仓价、急涨急跌、价格达到、距理论强平价…）判定并播报 —— 分屏里听到的，就是不分屏页面下那个币种会播报的内容。分屏打开期间主站自己的循环对这些币种让位，不会同一个币种播两遍。</dd><dt>分屏的播报引擎与不分屏页面完全同一套</dt><dd>发声统一走主站的语音引擎：<b>引擎（微软云语音 / 本机系统语音）、音色、语音音量、提示音音量、播报间隔、精简版</b>全部共用同一份设置，面板里改哪一项，主页面与分屏一起变。面板里的这些控件就是主站那几个控件的镜像（改这里等于改主站设置），所以两边永远不会不一致。定时播报实时价在分屏里也按币种各自计时，不会几个币种互相顶掉间隔。</dd><dt>多个币种同时触发 → 按面板里的顺序依次播报</dt><dd>三个币种在同一拍都命中规则时，按你在面板里排的币种顺序从上到下依次念完，而不是抢着念、互相打断；面板里对应的那一行会跟面板喇叭一起闪「播报中」。</dd></dl><hr>` + v21217SplitVoicePanelChangelog;

  // v2.12.18：多分屏背景改磨砂渐变（青绿系）+ 板块按多空状态上色。
  const v21218SplitToneChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.18 更新日志</b><dl><dt>分屏背景：与主页同款的磨砂渐变，但换成青绿系</dt><dd>多分屏底色从一块纯色，改成跟主页同一套做法：<b>多层柔光色团 + 斜向渐变 + 半透明背景模糊</b>。底下的主页面会透出一点被模糊的轮廓，所以有磨砂玻璃的质感。<br>色系刻意与主页区分开 —— 主页是蓝紫系，分屏换成<b>青绿 / 墨青系</b>，一眼就知道自己在哪个模式里。浅色主题下则是奶白 + 淡青的同款磨砂。</dd><dt>分屏板块按多空状态上色：做多 → 绿，做空 → 红</dt><dd>每个格子的外框、顶部横条与面板内顶部光晕，会跟着该币种的状态变色：<b>做多（或多空信号没出来但价格在涨）→ 绿色；做空（或价格在跌）→ 红色</b>。多空胶囊（「做多 / 做空」）与指标卡里的「多 / 空」小标也一起统一成多绿空红。<br>⚠️ 只有<b>板块与多空</b>用这套颜色；价格数字、涨跌幅、K 线仍然是站内的「涨红跌绿」口径，一秒都没有混。</dd><dt>分屏的涨跌配色统一到主站口径（涨绿跌红）</dt><dd>分屏面板里的价格、涨跌幅与 K 线一直是「涨红跌绿」，与主站（涨绿跌红）正好相反 —— 早期遗留，进分屏像换了个市场。现在整块统一成主站的涨绿跌红，顺手也让「板块色 / 多空色 / 数字色」三者同向：涨且做多 → 全绿，跌或做空 → 全红，一眼看完不用再换算。</dd><dt>面板本身也变成磨砂玻璃</dt><dd>每个格子改成半透明 + 背景模糊的卡片，面板内部换成与外框同色系的深青墨底并叠一层状态色柔光（面板是 iframe，实测透明 iframe 会被浏览器画成白底，所以底色由面板自己画），四个格子叠在渐变背景上层次更清楚。</dd></dl><hr>` + v21218SplitToneChangelog;

  // v2.12.19：分屏每个格子的滚轮手势 —— 滚轮缩放、⌘/Ctrl + 滚轮横向平移。
  const v21219SplitWheelPanChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.19 更新日志</b><dl><dt>分屏：⌘ / Ctrl + 滚轮 = 横向平移，滚轮仍是缩放</dt><dd>分屏每个格子里，<b>滚轮照旧缩放</b>（以光标位置为锚点，指哪放哪）；<b>按住 ⌘（Command）或 Ctrl 再滚轮 = 左右平移</b>，一次滚动约移过可见宽度的一成，往下滚看更早的数据、往上滚回到最新。这与主站图表是同一个手势（主站工具栏里写的「按住 ⌘ / Ctrl + 滚轮」就是它），两个模式下不用换肌肉记忆。拖动图表平移、双击重置、底部 − / ＋ 也都还在。</dd><dt>分屏：底部手势提示同步更新</dt><dd>格子底部那行小字改成「<b>滚轮缩放 · ⌘/Ctrl+滚轮平移 · 拖拽平移</b>」，不用去查说明书。顺带修掉一个小毛病：触控板双指左右滑（只给横向滚动量）以前会被当成缩放、图表莫名缩小，现在被正确接到平移上。</dd></dl><hr>` + v21219SplitWheelPanChangelog;

  // v2.12.20：分屏各币种的播报默认跟随主站「语音总开关」。
  const v21220SplitVoiceFollowChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.20 更新日志</b><dl><dt>分屏的喇叭现在跟随主站「语音总开关」</dt><dd>此前分屏有个反直觉的默认：<b>各个币种默认「不参与播报」</b>，于是在普通页面里语音总开关明明开着，进分屏一看，四个格子的喇叭全是<b>静音（红斜线）</b>态，而且也不会把价格喂给播报引擎 —— 看着像分屏把播报关掉了。现在改成<b>默认跟随主站语音总开关</b>：主站开着，分屏里各币种的喇叭就都是亮的，并真的参与播报；主站关掉，四个一起变回静音。这一条与「不分屏时该币种会不会播报」完全一致。</dd><dt>主站总开关一改，分屏立刻跟上</dt><dd>在普通页面（或分屏设置面板那颗镜像开关）上切换总开关，分屏这边<b>四个格子的喇叭图标、播报顺序列表里的圆点、状态行、以及参与播报的币种范围</b>会同时刷新，不用退出分屏重进。</dd><dt>单个币种仍可单独关掉</dt><dd>默认跟随总开关之后，仍可以在分屏的「播报设置 → 播报顺序」里点某个币种左侧的圆点，把它单独从播报里摘出去（以你那次点击为准）；再点一下恢复跟随。</dd></dl><hr>` + v21220SplitVoiceFollowChangelog;

  // v2.12.21：分屏「全屏」按钮修好 + 顶栏按钮配色归队 + 观望态不再染色。
  const v21221SplitTopbarFixChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.21 更新日志</b><dl><dt>分屏的「⛶ 全屏」按钮修好了</dt><dd>这个按钮此前<b>点了没有任何反应</b> —— 它的处理函数只有调用、没有定义（点一下抛一个 ReferenceError 就没了，界面上看不出任何动静）。现在补上，并且<b>复用主站那一套全屏逻辑</b>：全屏的是整个页面，而分屏本身就是一个铺满全屏的层，所以效果就是「屏幕上只剩分屏」。再点一次按钮或按 <b>Esc</b> 退出，按钮文字会在「全屏 / 退出全屏」之间自动切换。</dd><dt>分屏顶栏按钮的配色归队（不再串主站的蓝紫色）</dt><dd>「全屏 / 退出 / ＋ 添加币种 / 🔊 播报设置」这几颗按钮原先直接继承了主站的蓝紫系色板，摆在青绿色的分屏底上明显不是一家人。现在统一改成<b>分屏自己的青绿系</b>：淡青底 + 青色描边，鼠标移上去变亮；<b>「退出」单独用偏红的颜色</b>（它是关闭整个分屏，跟其它操作区分开）。深色与浅色主题各配了一套。</dd><dt>「观望」的币种不再染成红/绿</dt><dd>板块的状态色现在只由<b>明确的多空信号</b>决定：<b>做多 → 绿、做空 → 红、观望 → 不染色（保持中性）</b>。此前观望时会拿涨跌幅兜底染色，于是「观望 + 微跌」的币种整块变红（比如 BNB 跌 0.03% 也在报红），看着像在提示做空 —— 现在不会了：涨跌由价格、涨跌幅和 K 线自己表达，板块色只表达多空方向。</dd></dl><hr>` + v21221SplitTopbarFixChangelog;

  // v2.12.22：分屏「参与播报」改成会话级，并加「全部跟随总开关」。
  const v21222SplitVoiceSessionChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.22 更新日志</b><dl><dt>修掉「主站播报开着、分屏却永远静音」</dt><dd>分屏里「某个币种是否参与播报」的选择原先<b>存在浏览器里长期有效</b>：一旦在旧版本里点过某个币种的开关（或它留下了「关闭」记录），<b>就会一直压住主站的语音总开关</b> —— 于是在普通页面里总开关和规则明明都是开着的，分屏四个格子的喇叭却始终是静音态，<b>连刷新页面都没用</b>。现在这类选择改成<b>只在当前这次会话有效</b>：关掉浏览器再打开、或刷新页面后，分屏一律回到「跟随主站总开关」。<br>换句话说：<b>持久状态只由主站的语音总开关决定</b>，分屏里不再有任何能悄悄把播报关掉的历史残留。</dd><dt>新增「全部跟随总开关」按钮</dt><dd>分屏的「播报设置」面板底部多了一颗按钮：一键把每个币种都恢复成<b>跟随主站总开关</b>（主站开着就都播）。如果你之前手动关过某个币种、想让它重新参与，点它最快，不用逐个点圆点。</dd><dt>重新打开总开关 = 全都播</dt><dd>把主站的语音总开关关掉再打开时，分屏会顺手清掉本会话里单独关掉的那些币种，避免出现「总开关明明开着、某个格子却还是静音」这种找不到原因的中间状态。</dd></dl><hr>` + v21222SplitVoiceSessionChangelog;

  // v2.12.23：修掉顶部「美股实时报价」在盘中永远不显示（服务端交易时段判定漏 await）。
  const v21223UsEquityStateChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.23 更新日志</b><dl><dt>顶部状态条的美股报价（SPY / QQQ）现在真会出现了</dt><dd>症状是：美股明明<b>开市中</b>——顶栏那句「纽约（美股）周二 09:45 · <b>开市中</b>」显示得好好的——可它右边本该跟出 SPY / QQQ 的<b>实时价格与涨跌幅</b>，那里却<b>永远是一片空白</b>。刷新、重启、换浏览器都一样。</dd><dt>根因：一个函数被写成了 async，调用时却漏了 await</dt><dd>服务端那个「现在是盘前 / 盘中 / 盘后」的判定函数被声明成了 <b>async</b>，但取用它的地方<b>没写 await</b>。于是拿到的不是 <code>"REGULAR"</code> 这个字符串，而是一个 <b>Promise 对象</b>；接口把它序列化成 <code>{}</code> 交给前端，前端每次判断「是否处于常规交易时段」都得到假值，就顺手把这一块清空了。<br>注意这跟开不开盘<b>无关</b>——只要走的是腾讯这个主源，它就<b>从来没有显示过</b>；跟数据源能不能连通也无关，行情其实早就取到了，只是被这一道判定挡在门外。</dd><dt>修复与顺带的两处对齐</dt><dd>① 该函数改成<b>同步函数</b>（它本来就不需要异步），并在旁边留了注释，写明「改回 async 就会重犯」，避免以后再次踩同一个坑。<br>② 取美东时间的方式换成按字段解析，不再依赖对本地化时间串的宽松解析。<br>③ 收盘边界从「≤ 16:00」收紧为「&lt; 16:00」—— 16:00 整不再算盘中，与前端口径完全一致。</dd></dl><hr>` + v21223UsEquityStateChangelog;

  // v2.12.24：多分屏按钮移到「比特币 / 多币种」左边 + 币种切换组配色归队。
  const v21224TopbarOrderChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.24 更新日志</b><dl><dt>「⊞ 多分屏」挪到顶栏最左边</dt><dd>它原先固定在顶栏最右端。现在移到<b>「₿ 比特币 / 多币种」切换组的左侧</b>，于是整排从左到右是：<b>多分屏 → 币种切换 → EN → 全屏 → 深色 → 齿轮</b>，与「先选模式、再选语言/显示」的顺序一致。<br>顺带说明为什么这颗按钮的落位要两个文件一起改：币种切换组由 <code>app.js</code> 注入，并且原本会<b>无条件把自己抢到第一位</b>，而多分屏按钮由另一个模块注入 —— 谁先跑谁就占位。现在两边都改成「以对方为锚、只在位置不对时才动」，<b>无论加载先后，最终都是多分屏在最左</b>，也不会来回抖。</dd><dt>币种切换组的配色归队</dt><dd>「₿ 比特币 / 多币种」这个分段开关原先用的是<b>深黑底色</b>（与页面背景同系），摆在旁边那排<b>紫色胶囊</b>按钮（EN / 全屏 / 深色 / 齿轮 / 多分屏）里明显不是一家人 —— 整排看着"凹"下去一块。<br>现在它的底色与描边改成<b>与顶栏其它按钮同一套紫色系</b>：外框淡紫描边 + 半透明紫底，选中的那一半用更实的紫并配白字。深色与浅色主题各对齐了一次（浅色下同样改为与相邻按钮一致的白底半透明 + 同色描边）。</dd><dt>「EN」的蓝色描边也一起归队</dt><dd>顺便查了一遍整排：这颗语言按钮过去被单独指定了<b>蓝色描边 + 蓝白字</b>，是全排里<b>唯一一颗蓝边按钮</b>，挨着旁边几颗淡紫边显得突兀。现在取消单独染色，与全屏 / 深色 / 齿轮 / 多分屏 完全同一套（只剩宽度差异）。</dd></dl><hr>` + v21224TopbarOrderChangelog;
  /* v2.12.25：分屏「播报设置」的音色必须与主站（比特币）逐字一致。 */
  const v21225SplitVoiceMirrorChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.25 更新日志</b><dl><dt>分屏「播报设置」里的音色不再显示成另一个人</dt><dd>症状：多分屏顶栏「🔊 播报设置」里看到的音色，跟主站「语音播报设置」里的不是同一个 —— 例如主站是「晓晓 · 女声 · 经典」，分屏面板却显示成「云帆 · 男声 · 多语言」。<br><b>原因</b>：分屏面板是从主站那个下拉整份搬过来的，但旧代码<b>跳过了被隐藏的选项</b>；而主站当前用的音色恰好可能正被隐藏 —— 只要「音色筛选」选的是男声或女声，或者选中的是 HD 超清 / MAI 这类<b>本机 Azure 区域不支持的代次</b>（服务端日志里那批 <code>Azure Speech HTTP 400</code> 就是这么来的），搬过去之后就匹配不上，于是回落到列表里的第一条。分屏这边显示的于是成了另一个音色，而实际发声其实还是主站那一个 —— 两边自然对不上。<br><b>现在</b>：隐藏与置灰状态一并搬过来（列表可见性与主站保持一致），并且<b>选中项绝不回落</b> —— 万一还是匹配不上，就把主站当前值补成一项，宁可多一项也不显示成别人。另外分屏面板开着时，主站那几个音色相关控件一变就重新镜像一次，两边永远同步。</dd><dt>云语音偶发失败不再悄悄换成「系统嗓」</dt><dd>浏览器拒掉自动播放、或音频通道被上一次播报占用时，云语音的播放会失败，旧代码会<b>静默改用本机系统语音</b>把同一句话再念一遍 —— 听感上就是「音色突然换了一个人」，界面上完全看不出来。<br>现在这种失败会立刻重试一次（间隔 200 毫秒，仍在同一个用户手势的有效期内），能吃掉这类瞬时失败，明显减少被误换成系统声音的概率。</dd></dl><hr>` + v21225SplitVoiceMirrorChangelog;

  // v2.12.26：AI 助手「检索条数」可调 + 快捷问题动态生成。
  const v21226AiSearchLimitChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.26 更新日志</b><dl><dt>AI 助手工具条新增「检索 N 条」按钮</dt><dd>联网检索取回的公开信息条数原先固定为 12 条，现在可以在工具条上直接调：<b>10 / 12 / 20 / 30</b> 四档，选择记在本地浏览器，对下一条提问立即生效。条数越多，模型能参考的外部材料越多，但 token 消耗也相应变大；回答下方的回执会显示本次实际条数。</dd><dt>快捷问题不再固定，改为随行情与热点动态生成</dt><dd>面板底部的快捷问题原先永远是同样五条。现在由服务端<b>按当前行情快照</b>（资金费率异常、24 小时涨跌幅、恐惧贪婪极值、临近宏观事件、多周期方向冲突）<b>＋ 实时 BTC 热点头条 ＋ 常青话题池轮换</b>动态生成，最多 6 条；打开面板、切换语言或新建对话时刷新。没有触发阈值的状态（例如资金费率正常）就不会硬塞对应问题。</dd></dl><hr>` + v21226AiSearchLimitChangelog;

  // v2.12.28：框选起点对齐光标（几何口径统一）+ 框选区间新增「最高 − 最低」价差。
  const v21228SelectionSpreadChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.28 更新日志</b><dl><dt>框选起点现在真的从你按下的地方开始</dt><dd>症状：在 K 线图上按下去准备框一段区间时，选区不是从光标位置起，而是<b>比光标往右偏出一截</b>，并且<b>越靠近图表右侧偏得越多</b> —— 实测 900 像素宽的图上，最右端偏差约 <b>54 像素</b>，相当于 50 多根 1 分钟 K 线。<br><b>原因</b>：把光标位置换算成「第几根 K 线」时，用的还是<b>旧版绘图区几何</b>。主图右侧留白早先从 74 像素收窄到了 18 像素，绘图宽度随之变大，但这段换算仍按旧的宽度折算 —— 分母偏小、序号偏大，选区整体右移，而且偏差随位置线性放大（左端几乎不偏、右端最明显）。图表上的十字线与悬浮卡走的是<b>另一套正确的几何</b>，所以同一位置悬浮会显示 09:41、框选起点却是 09:44，两者对不上就是这个原因。<br><b>现在</b>：换算收口到与绘制共用的一个函数，框选、十字线、悬浮卡对同一位置给出同一根 K 线，起点落在光标处（误差不超过半根 K 线）。</dd><dt>框选区间新增「最高 − 最低」价差</dt><dd>框出一段区间后，除了时间段、最高、最低与区间涨跌，现在还会给出这一段的<b>最高价与最低价之差</b>，形如 <code>价差 $622.30 (0.74%)</code> —— 括号里是价差相对最低价的幅度。它与「区间涨跌」互补：<b>区间涨跌</b>看的是首尾净变化（方向与幅度），<b>价差</b>看的是区间内的最大波动幅度（震荡空间有多大）。拖动时的底部摘要、松手后的完整摘要、图表上的浮层卡片三处口径一致，中英文均已覆盖。</dd></dl><hr>` + v21228SelectionSpreadChangelog;
  // v2.12.29：框选「价差」按区间涨跌方向着色（跌红 / 涨绿）。
  const v21229SpreadToneChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.29 更新日志</b><dl><dt>框选「价差」按涨跌方向着色</dt><dd>框出一段区间后新增的「价差」原先一律是浅色，看不出这一段行情是往上还是往下。现在它跟着<b>区间涨跌</b>的方向走：<b>区间是跌的，价差显示为红色；区间是涨的，显示为绿色</b>（与全站涨绿跌红的口径一致）。<br><b>为什么看的是区间涨跌</b>：价差是这一段「最高价 − 最低价」的差，数学上<b>恒为正数</b>，本身不带方向，能体现方向的只有首尾净变化，所以配色取区间涨跌的符号。颜色只是方向提示，价差数值本身始终是这段区间的最大波动幅度。<br>三处显示（拖动中的底部摘要、松手后的完整摘要、图表上的浮层卡片）同步生效，中英文一致。</dd></dl><hr>` + v21229SpreadToneChangelog;
  // v2.12.31：彻底修复主页面「两个 AI 助手按钮」（根因是 core.js 双实例）。
  // v2.12.30：分屏「放大单看」浮层改用 zoom 缩放，修复原生下拉弹层飘离控件。
  const v21230SplitZoomChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.30 更新日志</b><dl><dt>分屏放大浮层的下拉选项不再飘走</dt><dd>症状：在分屏「放大单看」浮层里点「信号基准」等下拉框时，弹出的选项列表<b>不贴在控件下方，而是整体飘到右边／别处</b>。<br><b>原因</b>：浮层是把整个首页用 CSS transform 缩小渲染的，而 Chrome 原生下拉弹层的定位<b>不认 transform 缩放</b>，按未缩放的坐标弹出，于是和控件的实际位置脱开。<br><b>现在</b>：浮层缩放改用参与布局计算的 zoom 方式，弹层锚点与控件视觉位置一致；不支持 zoom 的浏览器自动回落原缩放方式。选项内容与逻辑不变。</dd><dt>放大浮层不再出现两个 AI 助手按钮</dt><dd>打开分屏「放大单看」浮层时，浮层内的首页会<b>再注入一个 AI 助手悬浮按钮</b>（一暗一亮两个）：暗的那个是主页面原有按钮被浮层背板压暗，亮的那个是浮层自己多注入的——其位置还按主页面记忆的坐标计算，会错位叠在图表工具上。现在浮层内不再注入 AI 助手（与该浮层静音推送／语音的处理一致），只保留主页面那一个。</dd></dl><hr>` + v21230SplitZoomChangelog;
  const v21231DoubleBtnChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.31 更新日志</b><dl><dt>彻底修复「两个 AI 助手按钮」</dt><dd>上一版只在分屏浮层内做了「iframe 里不注入」的处理，但<b>主页面本身在某些缓存串号情况下仍会注入两个</b> AI 助手悬浮按钮（两个一模一样、都挂在 body 上，一前一后叠在一起）。<br><b>真正根因</b>：核心模块 <code>core.js</code> 被当成了<strong>两个独立实例</strong>加载——多处 <code>?v=</code> 缓存戳不一致（例如 app.js 引 <code>core.js?v=11</code>、其余模块还停在 <code>?v=10</code>），浏览器把同一份代码按不同 URL 各实例化一次。每个实例都有自己的加载器，各自拉一次 <code>ai-chat.js</code>，脚本跑两遍 → 注入两个按钮。<br><b>现在两层兜底</b>：① <code>ai-chat.js</code> 自身幂等——boot 前先查 DOM 里是否已有 <code>.btc-ai-launch</code> 按钮，再加一道跨实例共享的 <code>window.__btcAiBooted</code> 标志，脚本被加载几遍也只注入一个；② <code>core.js</code> 的 <code>loadScriptOnce</code> 改为<strong>按路径去重、忽略 <code>?v=</code> 查询串</strong>，同一脚本即使带着不同缓存戳也只加载一次。<br>顺带把全站模块链的 <code>?v=</code> 缓存戳统一换成全新值，清掉之前无头/本地浏览器里 immutable 缓存的毒化副本。</dd><dt>API 中心：Key 填错框不再卡死（自动收回）</dt><dd>把 <code>sk-sp-…</code> 这类 Key 粘到「API 地址（可选，留空自动匹配）」框里再点保存时，过去只会跳出浏览器自带的英文提示 “Please enter a URL.”，看起来就像 Key 根本填不进去（实际是那个框在做原生 URL 校验，提交被拦下）。现在保存与验证都会先归一化：地址框里若是 Key、而 Key 框为空，自动搬回 Key 框并把地址留空（按前缀自动匹配端点）；两边填了不同内容则给出中文说明。地址框不再使用浏览器原生 URL 校验，改为中文提示；Key 输入框补上可见标题「千问 API Key」，与地址框不再混淆。</dd></dl><hr>` + v21231DoubleBtnChangelog;
  // v2.12.32：持仓「清除」即同步——本地清空的持仓立刻推上云端，不再被回填复活。
  const v21232ClearSyncChangelog = log.innerHTML;
  // v2.12.36：KRONOS AI预测卡新增「历史准确度回测」模块。
  const v21236KronosBacktestChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.36 更新日志</b><dl><dt>KRONOS AI预测卡新增「历史准确度回测」</dt><dd>在现有 KRONOS AI预测能力基础上，新增一个历史准确度回测区块：后端 <code>inference.py</code> 新增 <code>backtest()</code>，在过去 12 周、每周一个历史锚点用当时 K 线跑与线上完全一致的推理，对比 24 小时后真实走势，聚合出<code>方向准确率</code>（清晰喊单中方向命中率）、<code>Brier 分数</code>（概率校准度，越低越好）、<code>波动放大命中率</code>与<code>回测样本数</code>四项指标；前端用四张小卡 + 一张柱状图（每根柱=一个历史锚点的预测上涨概率，绿=实际上涨、红=实际下跌）展示。<br><b>接口</b>：<code>/api/kronos/backtest</code>（带 <code>force</code> 参数，Redis 缓存一天，因回测耗时长）。<br>卡片标题由「AI 预测」改为「KRONOS AI预测」。<br>模型预测仅供参考，非投资建议。</dd></dl><hr>` + v21236KronosBacktestChangelog;
  // v2.12.34：Kronos AI 预测卡按官方 demo 风格重制为「双卡 + 双图」概率预报面板。
  const v21234KronosUiChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.34 更新日志</b><dl><dt>Kronos AI 预测卡重制为「双卡 + 双图」概率预报面板</dt><dd>在现有 AI 预测能力基础上，把单卡界面升级为与 Kronos 官方 demo 对齐的「24 小时概率预报」面板：顶部两张独立大数字卡片分别展示「上涨概率」与「波动性放大」；下方用两张 canvas 图分别展示未来 24 小时的价格概率预报与成交量预报。<br><b>数据增强</b>：后端推理新增 <code>history</code>（历史 24 根 close / volume）与 <code>forecastRange</code>（多次蒙特卡罗采样得到的每时点 close 最小/最大值），用于绘制蓝色历史段与橙色预测范围阴影。<br><b>视觉</b>：历史价格/成交量用蓝色，预测均值用橙色，预测范围用橙色半透明阴影填充，当前与未来用红色虚线分隔；顶部卡片按方向（涨绿/跌红/中性灰）与波动等级（低灰/中黄/高橙）动态着色。成交量图独立展示历史与预测均值柱状图。<br>模型预测仅供参考，非投资建议。</dd></dl><hr>` + v21234KronosUiChangelog;
  // v2.12.33：新增「Get APP」板块下的 Kronos BTC 涨跌/波动 AI 预测卡。
  const v21233KronosChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.33 更新日志</b><dl><dt>Get APP 板块新增 Kronos AI 预测卡</dt><dd>在页脚「Get APP」板块下新增一张 BTC 涨跌 / 波动 AI 预测卡，由开源金融基座模型 <b>Kronos</b>（MIT）驱动。卡片展示未来 24 小时涨跌方向（绿涨红跌·国际惯例）、上涨概率、波动率等级，以及 Kronos 预测段的迷你 K 线。<br><b>数据来源</b>：推理服务后台直连 OKX / 币安拉取 BTC K 线，经 Kronos-small 自回归预测，结果 Redis 缓存 1 小时。<br><b>配色</b>：预测卡刻意采用绿涨红跌（国际惯例），与全站默认的红涨绿跌区分开。<br><b>架构</b>：独立 Python（FastAPI）推理服务 <code>kronos-service</code> 经 <code>server.mjs</code> 的 <code>/api/kronos/*</code> 代理供前端访问。<br>模型预测仅供参考，非投资建议。</dd></dl><hr>` + v21233KronosChangelog;
  log.innerHTML = `<b>v2.12.32 更新日志</b><dl><dt>清除持仓后不再被云端「复活」</dt><dd>症状：把「我的持仓」里某一笔<b>清除</b>后，过一会儿（刷新页面、切走再切回币种、或账户状态刷新时）<b>这笔持仓又原样回来了</b>，同步徽标还显示「已同步」。<br><b>原因</b>：清除只写进了<b>本机</b>存储，从未告诉云端——云端账户档案里那笔持仓还在。而登录刷新 / 切币时的<b>云端回填</b>逻辑是「本地为空、云端有值 → 用云端补上」，本意是让新设备能拉回自己的持仓，结果把「刚被清除」也当成了「本地没有」，把云端旧持仓原样灌了回来。<br><b>现在</b>：清除即同步——只要该笔持仓曾同步到账户（云端档案里还有它），点「清除」（或把四项全部清空保存）的瞬间，就会自动把空仓推上云端；之后无论刷新、切币还是换设备登录，都不会再回来。清空动作现在才算真正清掉。手动点「已同步」徽标逐笔推送的机制不变；云端回填逻辑本身也保留，仍用于新设备拉回持仓。</dd></dl><hr>` + v21232ClearSyncChangelog;
  // 修复 2.12.x 版本链顺序：此前 v2.12.33/34/36 被后续短周期版本覆盖，这里重新置顶。
  const v21232Final = log.innerHTML;
  log.innerHTML = `<b>v2.12.33 更新日志</b><dl><dt>Get APP 板块新增 Kronos AI 预测卡</dt><dd>在页脚「Get APP」板块下新增一张 BTC 涨跌 / 波动 AI 预测卡，由开源金融基座模型 <b>Kronos</b>（MIT）驱动。卡片展示未来 24 小时涨跌方向（绿涨红跌·国际惯例）、上涨概率、波动率等级，以及 Kronos 预测段的迷你 K 线。<br><b>数据来源</b>：推理服务后台直连 OKX / 币安拉取 BTC K 线，经 Kronos-small 自回归预测，结果 Redis 缓存 1 小时。<br><b>配色</b>：预测卡刻意采用绿涨红跌（国际惯例），与全站默认的红涨绿跌区分开。<br><b>架构</b>：独立 Python（FastAPI）推理服务 <code>kronos-service</code> 经 <code>server.mjs</code> 的 <code>/api/kronos/*</code> 代理供前端访问。<br>模型预测仅供参考，非投资建议。</dd></dl><hr>` + v21232Final;
  const v21233Final = log.innerHTML;
  log.innerHTML = `<b>v2.12.34 更新日志</b><dl><dt>Kronos AI 预测卡重制为「双卡 + 双图」概率预报面板</dt><dd>在现有 AI 预测能力基础上，把单卡界面升级为与 Kronos 官方 demo 对齐的「24 小时概率预报」面板：顶部两张独立大数字卡片分别展示「上涨概率」与「波动性放大」；下方用两张 canvas 图分别展示未来 24 小时的价格概率预报与成交量预报。<br><b>数据增强</b>：后端推理新增 <code>history</code>（历史 24 根 close / volume）与 <code>forecastRange</code>（多次蒙特卡罗采样得到的每时点 close 最小/最大值），用于绘制蓝色历史段与橙色预测范围阴影。<br><b>视觉</b>：历史价格/成交量用蓝色，预测均值用橙色，预测范围用橙色半透明阴影填充，当前与未来用红色虚线分隔；顶部卡片按方向（涨绿/跌红/中性灰）与波动等级（低灰/中黄/高橙）动态着色。成交量图独立展示历史与预测均值柱状图。<br>模型预测仅供参考，非投资建议。</dd></dl><hr>` + v21233Final;
  const v21234Final = log.innerHTML;
  log.innerHTML = `<b>v2.12.36 更新日志</b><dl><dt>KRONOS AI预测卡新增「历史准确度回测」</dt><dd>在现有 KRONOS AI预测能力基础上，新增一个历史准确度回测区块：后端 <code>inference.py</code> 新增 <code>backtest()</code>，在过去 12 周、每周一个历史锚点用当时 K 线跑与线上完全一致的推理，对比 24 小时后真实走势，聚合出<code>方向准确率</code>（清晰喊单中方向命中率）、<code>Brier 分数</code>（概率校准度，越低越好）、<code>波动放大命中率</code>与<code>回测样本数</code>四项指标；前端用四张小卡 + 一张柱状图（每根柱=一个历史锚点的预测上涨概率，绿=实际上涨、红=实际下跌）展示。<br><b>接口</b>：<code>/api/kronos/backtest</code>（带 <code>force</code> 参数，Redis 缓存一天，因回测耗时长）。<br>卡片标题由「AI 预测」改为「KRONOS AI预测」。<br>模型预测仅供参考，非投资建议。</dd></dl><hr>` + v21234Final;
  const v21236Final = log.innerHTML;
  log.innerHTML = `<b>v2.12.37 更新日志</b><dl><dt>KRONOS AI 预测卡新增 24h 走势形状与回测方向/走势明细</dt><dd>回应「数据源差异 / 历史锚点方向 / 24h 走势」三点反馈：① 卡片新增「24h 预测走势」一行（持续上涨 / 持续下跌 / 先涨后跌 / 先跌后涨 / 震荡等），基于均值预测 close 路径自动分类；② 回测柱状图每个柱顶增加预测方向箭头（↑ 涨 / ↓ 跌 / — 中性），柱子颜色仍表示实际方向（绿=实际涨、红=实际跌），并支持鼠标悬停查看该锚点的「预测方向 / 实际方向 / 预测走势 / 实际走势」；③ 数据源差异保留但说明文案改为「BTC 价格各主流所几乎一致」，主预测仍默认 OKX（与全站默认数据源一致），回测默认 Binance（深历史，OKX 公开接口仅约 60 天）。<br>模型预测仅供参考，非投资建议。</dd></dl><hr>` + v21236Final;
  // v2.12.38：KRONOS AI 预测卡支持自定义自动刷新间隔。
  const v21238RefreshChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.38 更新日志</b><dl><dt>KRONOS AI 预测卡支持自定义自动刷新间隔</dt><dd>卡片头部新增「自动刷新间隔（分钟）」输入框，可自行设定预测卡的自动刷新频率（默认 60 分钟，范围 0.5～1440 分钟，即 30 秒～24 小时）。设定值写入 localStorage，刷新页面后保留；点击「应用」或回车后立即按新间隔重启定时器。为避免刷新过快导致请求叠加，叠加了 in-flight 锁（上一次请求未完成时忽略新一次触发）。<br><b>注意</b>：服务端对预测结果有约 1 小时的 Redis 缓存，把间隔设得低于 1 小时只会在服务端缓存过期前重复读取同一份预测数据，直到服务端缓存刷新才会拿到新推理；回测区块仍为每日刷新。</dd></dl><hr>` + v21238RefreshChangelog;
  // v2.12.39：回测图增加判断正误标记，并修复 pUp=0 的实际下跌柱不可见。
  const v21239BacktestMarksChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.39 更新日志</b><dl><dt>回测图增加「判断正确 / 错误」标记并修复零高度下跌柱</dt><dd>回应截图反馈：① 修复实际下跌柱不可见的问题——部分锚点预测上涨概率为 0，按原高度绘制会得到零高度矩形，导致「实际下跌」的红色完全看不到；现在为每根柱设置 3px 最小高度，pUp=0 的实际下跌也会显示为一条可见的红线；② 在每个日期下方新增判断标记：预测方向与实际方向一致时显示绿色「✓」（判断正确），不一致时显示红色「✗」（判断错误），一眼看出模型在哪些锚点押对方向；③ 鼠标悬停 tooltip 同步增加「判断结果」一行（正确/错误）。<br>模型预测仅供参考，非投资建议。</dd></dl><hr>` + v21239BacktestMarksChangelog;
  // v2.12.40：概率价格图支持鼠标悬停显示大概价格。
  const v21240PriceHoverChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.40 更新日志</b><dl><dt>概率价格图支持鼠标悬停查看大概价格</dt><dd>回应截图反馈：在「24小时概率预报」价格图（蓝=历史价格，橙=均值预测，橙阴影=预测范围）上新增鼠标悬停 tooltip。移动鼠标时自动定位到最近的时间点，显示该时刻的日期/小时，以及对应价格：历史段显示「历史价格」，预测段显示「均值预测」和「预测范围（最低–最高）」。便于快速读取任意时刻的大致价格与不确定性区间。<br>模型预测仅供参考，非投资建议。</dd></dl><hr>` + v21240PriceHoverChangelog;
  // v2.12.41：回测锚点由「每周一个」改为「每天一个」。
  const v21241DailyBacktestChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.41 更新日志</b><dl><dt>回测锚点由「每周一个」改为「每天一个」</dt><dd>回应截图反馈：原本回测是「过去 12 周、每周一个历史锚点」（每根柱间隔 7 天，所以日期跳着显示），用户期望每天都有。现在改为每天一个历史时点：后端 <code>backtest()</code> 参数由 <code>weeks</code> 改为 <code>days</code>（默认 30 天），锚点按 <code>now - k 天</code> 逐日取点；缓存 key 升到 <code>v2</code> 避免旧周度缓存串味；前端默认请求 <code>?days=30</code>，note 文案改为「过去 N 天、每天一个历史时点」，图表日期标签按列数自适应间隔显示（最多约 12 个），避免日期挤在一起。左=远、右=近的排列不变。<br>健壮性：Kronos 把 512 根上下文压成变长 token 序列，个别历史窗口会被压到 <code>max_context(512)</code> 以下，触发模型内部「tensor 512 vs N」崩溃；回测现对每个锚点先快速 token 化预检长度，跳过会崩溃的窗口并在当天邻近小时（±1/±2/±3/±6/±12h）回退重试，尽量保留「当天」样本；单锚点推理失败不再拖垮整批（计入 errors）。<br>模型预测仅供参考，非投资建议。</dd></dl><hr>` + v21241DailyBacktestChangelog;
  // v2.12.42：KRONOS AI 预测卡片位置调整到形态识别与关键位下方、比特币多因子研究上方。
  const v21242KronosReorderChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.42 更新日志</b><dl><dt>KRONOS AI 预测卡片位置调整</dt><dd>回应截图反馈：KRONOS AI 预测卡片原先位于「数据诊断」之后、用户滚动到形态识别与多因子研究之间时才会遇到，阅读顺序不够顺。现在把它移到「形态识别与关键位」正下方、「比特币多因子研究」正上方，形成「形态识别 → KRONOS AI 预测 → 多因子研究」的流向，与研究性卡片保持一致。<br>实现：面板统一由 <code>normalizePanelReadingOrder()</code> 在异步挂载后归位；静态 HTML 中的 KRONOS 卡片作为可移动节点，在「形态识别」与「多因子研究」渲染完成后被自动插入两者之间。<br>另：工具类卡片（数据诊断 / 高杠杆强平缓冲参考 / 我的持仓与盈亏估算 / 消息推送 / 强平概率计算器）统一沉底，固定排在页面最下方。模型预测仅供参考，非投资建议。</dd></dl><hr>` + v21242KronosReorderChangelog;
  // v2.12.43：按需求整块移除「A/B 实验中心」板块。
  const v21243RemoveAbCenterChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.43 更新日志</b><dl><dt>移除「A/B 实验中心」板块</dt><dd>按需求整块下线「A/B 实验中心」：各板块影子实验注册表与「A/B 自动评估」卡不再显示，相关前端卡片、样式、<code>/api/ab-experiments</code> 接口与后端遗留配对结算逻辑一并移除。「BTC 多因子研究预测」卡本身（含模型记分卡、训练候选模型、宏观事件、历史回放、因子消融、参数与门槛面板）保留不变。</dd></dl><hr>` + v21243RemoveAbCenterChangelog;
  // v2.12.44：按需求整块移除「模型记分卡」UI + 训练链路，研究卡只留事件/回放/消融描述性面板。
  const v21244RemoveScorecardChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.44 更新日志</b><dl><dt>移除「模型记分卡」UI 与训练链路</dt><dd>按需求整块下线「模型记分卡」：研究卡不再展示各周期模型的 Brier 技能评分 / 方向准确率 / 经济回测记分卡、治理与训练状态面板、参数与门槛（调参）面板，相关前端卡片、样式、<code>/api/research-tuning</code> 与 <code>/api/research-candidates/train</code> 接口、后端影子训练候选与训练运行表一并移除。记分值长期劣化为「永远震荡」基线（相对多数类的 BSS 为 -40%~-67%、净收益 -47%~-72%），无实用价值。「BTC 多因子研究预测」卡保留宏观事件、历史回放、因子消融等描述性面板；回放所需的实时预测主表 <code>research_predictions</code> 与结算逻辑继续保留。</dd></dl><hr>` + v21244RemoveScorecardChangelog;
  // v2.12.45：按需求整块移除「BTC 多因子研究预测」卡下的历史回放 / 宏观事件 / 因子消融三个描述性面板。
  const v21245RemoveResearchPanelsChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.45 更新日志</b><dl><dt>移除研究卡历史回放 / 宏观事件 / 因子消融面板</dt><dd>按需求整块下线「BTC 多因子研究预测」卡下的三个描述性面板（历史回放 walk-forward 三分类验证、宏观事件因子 CPI/非农/FOMC、因子消融逐因子对比）及其配套后端链路：<code>/api/research-backfill</code>、<code>/api/research-ablation</code>、<code>/api/macro-outcomes</code>、<code>/api/funding-rates</code> 接口，<code>researchBackfill</code> / <code>walkForwardBackfill</code> / <code>macroEventStudy</code> / <code>backfillMacroEventOutcomes</code> / <code>researchAblation</code> / <code>backfillFundingRates</code> 等函数，以及死亡账本 <code>research_predictions</code>（自记分卡移除后变为只写、无读者）连同其 15 分钟结算定时器一并移除。研究卡现在只保留实时多因子预测（窗口网格 / 市场结构 / 资讯），这才是真正可用的产品。模型预测仅供参考，非投资建议。</dd></dl><hr>` + v21245RemoveResearchPanelsChangelog;
  // v2.12.46：宏观事件中枢默认筛选与交互重做；关注改为自动；新增 K 线上方宏观预警滚动条。
  const v21246MacroHubChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.46 更新日志</b><dl><dt>宏观事件中枢：默认筛选与交互重做</dt><dd>默认「国家及地区」改为只勾选美国（菜单里可随时加选其他国家和地区），时间范围默认停在「全部」，「类别领域」与「重要性」默认全部。时间按钮精简为 今天 / 明天 / 昨天 / 本周 / 下周 / 全部 六个，「自定义日期」收成右侧一个日历图标，选中后才展开起止日期输入。</dd><dt>已公布数据跨天折叠</dt><dd>「全部」现在同时包含近 4 天内已公布的事件，但今天以前的部分默认折成一行「已公布 · N 条」，点开才铺开实际值与偏差结论 —— 第一眼看到的仍然是即将发生的事件，昨天 CPI 这类刚公布的数据也随时翻得出来。</dd><dt>展开 / 收起控制条简化</dt><dd>列表底部的控制条由三个等重按钮改为「一个主按钮（继续展开 N 条 / 收起）＋ 一个次级文字链接（全部展开）」，计数与细进度条合并到左侧同一行；三种状态共用一行，不再需要先想清楚该点哪一个。</dd><dt>关注改为自动</dt><dd>取消每行右上角的「关注」勾选。顶部「关注宏观事件实时数据」改为自动挑选最值得盯的一条高重要性事件：30 分钟内即将发布的 → 刚公布 30 分钟内的 → 最近的一场。卡片右上新增「更换」（手动指定任意高重要性事件，或恢复自动）与「不显示」（把当前这条加入忽略名单，下次自动跳过），浮层底部可一键恢复已隐藏的条目；手动挑中的那条在日历列表里以左侧青色角标同步标出。</dd><dt>K 线上方新增宏观预警滚动条</dt><dd>在「我的持仓 / 实时价格」与「K 线 / 当前规则信号」之间新增一条无缝横向滚动的预警条：只滚高重要性事件，24 小时内已公布的带实际值与「利好 / 利空」标签，即将发布的带秒级倒计时，15 分钟内发布的整条脉冲高亮；悬停自动暂停，点任意一条会把顶部卡片切到该事件并高亮定位。右侧 ✕ 可收起整条，在「宏观事件中枢」工具栏再点一下即可打开。预警为宏观常识映射，不构成投资建议。</dd><dt>已公布折叠可收起 + 浅色主题可读性</dt><dd>「已公布」那一行展开后不再消失，而是留在原地变成实线高亮、文案切换为「点这里收起」，同时把条数上限整体抬一段，让放出来的历史条目是「多出来」而不是把后面的「即将发生」挤出可视范围。预警条与「关注」控制条的次级文字在浅色主题下统一压到 5:1 以上（此前只有 3:1）。</dd></dl><hr>` + v21246MacroHubChangelog;
  // v2.12.47：尾部空白平衡 —— 右列比左列高时，把余量消化在左列内部。
  const v21247TailBalanceChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.47 更新日志</b><dl><dt>尾部空白：动态平衡左右两列</dt><dd>「关注宏观事件实时数据」的内容一多，右侧栏就会比左列高出一截，左列底部随之在「周期涨幅」与「多周期共振」之间空出一块。现在尾部会自动平衡：差值较大时先把「多周期共振」上移到左列末尾吃掉一整块，剩下的零头交给「周期涨幅」卡吸收 —— 它的柱状图本来就是按百分比绘制的，卡片变高时柱子等比变长，视觉上就是一张更高的柱状图，而不是一块空洞。右侧内容变化（宏观卡换条目、展开解读、切换语言）时会即时重算。K 线、当前规则信号以及下方板块的位置完全不受影响；窄屏单列布局保持原样。</dd></dl><hr>` + v21247TailBalanceChangelog;
  // v2.12.48：修复 OKX REST 刷新失败时 K 线末根出现的永驻超长红蜡烛。
  const v21248LiveLongBarChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.48 更新日志</b><dl><dt>修复 K 线永驻超长红蜡烛</dt><dd>症状：OKX REST 行情刷新失败时，K 线最右端会画出一根从旧快照价贯穿到实时价的超长红色蜡烛，且一直不随行情变短。根因：当上游 REST 连接进入 CLOSED 状态、stale-while-revalidate 只能回退旧快照时，末根蜡烛的 open 仍是旧快照价位，而 SSE / 轮询推送的实时价被无条件写入该根的 close / high / low，于是把一根已收盘的蜡烛拉成贯穿整个价格区间的超长线；快照不刷新，这根线就一直存在。修复：<code>onLivePrice</code> 增加与 <code>loadCurrent</code> 一致的时间边界判断——仅当末根蜡烛属于「正在形成的当前周期」（<code>Date.now() - c.time &lt; intervalMs</code>）时才用实时价更新其 close / high / low；已收盘的末根保持快照原值，实时价照常显示在顶部 ticker，下一轮行情成功刷新即自然接上。</dd></dl><hr>` + v21248LiveLongBarChangelog;
  const v21249MacroNoNumberChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.49 更新日志</b><dl><dt>宏观事件卡：预期/前值缺失时不再吞掉利多利空解读</dt><dd>症状：个别时段「关注宏观事件实时数据」卡片只剩倒计时与一句「数据尚未公布，等待实际值。」，原本的「市场解读」与「预期 / 前值 / 实际」三列一起消失。根因：预期与前值来自 TradingView / FinanceCalendar 补充源，这两路某一轮拉取失败时，东方财富主源本身不带估值，于是该轮所有事件的三项数值同时为 null；而「市场解读」区块的渲染条件被写成「模型存在 <b>且</b> 至少有一个数值」，条件不成立就整体跳过，退化成最后那条兜底提示。修复：把方向性解读拆出来——它依赖的是事件类型（就业 / 通胀 / 利率 / 失业 / 增长 / 能源）而非具体锚定数字，所以当模型存在但没有数值时，改为渲染一版不含数字的通用解读（实际高于预期 / 低于预期 / 符合预期各自的方向），并注明数值暂未取到、稍后自动补齐。有数值时仍是原来的阈值式解读，带具体锚点。curated 重大事件的人工解读优先级不变。</dd></dl><hr>` + v21249MacroNoNumberChangelog;
  // v2.12.50：服务端为宏观事件预期/前值加记忆层，补充源偶发失败时回填，避免卡片再次整轮丢失估值。
  const v21250MacroValueMemoryChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.50 更新日志</b><dl><dt>宏观事件预期/前值记忆层：补充源偶发失败时回填</dt><dd>根因：预期与前值来自 TradingView / FinanceCalendar 补充源，这两路某轮拉取失败时东方财富主源不带估值，宏事件卡片三项数值会整轮为 null，连带「利多利空解读」被吞（v2.12.49 已修展示层，让解读不再因缺值而消失）。本次在<strong>服务端</strong>加一层记忆：每轮成功取到的「预期 / 前值」按事件签名（国家 + 关键词 + 日期）缓存进 <code>data/macro-values-cache.json</code>，并随取数自然刷新；当本轮补充源失败时，从最近一次成功取数回填预期与前值（只回填预期/前值，<strong>绝不回填实际值</strong>，因为实际值是公布后才确定的事实）。缓存 40 天自动清理过期条目。这样即便补充源短暂抽风，卡片也会稳定显示上一轮的有效估值与解读，直到正常取数恢复。属服务端改动，需重启 8787 生效。</dd></dl><hr>` + v21250MacroValueMemoryChangelog;
  // v2.12.51：投资日历「关注档位」增加 24–72 小时预警档，高重要性事件不再过早降级为「常规监控」。
  const v21251CalWatchWindowChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.51 更新日志</b><dl><dt>投资日历：高重要性事件新增 72 小时预警档</dt><dd>症状：非农就业这类对 BTC 最关键的宏观数据，在公布前 1–3 天出现在日历里时右侧标注却是「常规监控」，反而不如 24 小时内的财政部回购（「流动性关注」）醒目。根因：事件标注按「重要性 × 距今时间」判定，高重要性事件只有 4 小时内（高波动窗口）与 24 小时内（风险关注 / 流动性关注）两档，一旦超出 24 小时就掉进兜底的「常规监控」，没有任何中间提示。修复：新增 24–72 小时预警档 —— 高重要性宏观事件显示红色「重点关注」（提示提前评估仓位与杠杆、临近 24 小时转入风险关注），财政部流动性类事件显示「流动性预警」。PMI 等中重要性事件维持原判不受影响。纯前端改动，刷新即生效。</dd></dl><hr>` + v21251CalWatchWindowChangelog;
  // v2.12.52：多周期共振一行横向排布改为 flex 折行，消除标题 / 按钮 / 周期标签的相互叠压。
  const v21252ResonanceRowChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.52 更新日志</b><dl><dt>多周期共振：排版重叠修复</dt><dd>症状：卡片这一行里「标题 + 结论徽标 + 一句话短语」「重新计算共振」按钮与右侧 5 个周期标签互相叠压 —— 徽标被按钮压住、周期标签被挤成贴合的两排，一眼看去像字体被覆盖、按钮也歪了。根因：这一行原本是三层网格固定列（标题组 / 1fr 留白 / 周期标签），而 <code>auto</code> 轨道会按自身内容抢宽，中间那列 1fr 被挤成 0 宽；按钮的 <code>justify-self:end</code> 挂在 0 宽列上，于是从列里<strong>向左溢出</strong>压到标题与徽标上，同时周期标签在过窄的列里被迫折行、只剩贴合的两排。修复：这一行改为 flex + 折行 —— 标题组按内容占位（放不下时短语自己折行），按钮用 auto 外边距推到本行最右，5 个周期标签整排折到下一行；宽度不足时单块整体换行，不再互相挤压。窄屏（≤760px）维持单列堆叠、按钮整宽，侧栏内的紧凑排布不受影响。纯样式改动，刷新即生效。</dd></dl><hr>` + v21252ResonanceRowChangelog;
  // v2.12.53：宏观卡补齐纳指 / 标普 / 美10Y / 离岸人民币 / 布伦特；卡顶与顶部币种区新增「宏观实况」滚动条。
  const v21253MacroLiveTickerChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.53 更新日志</b><dl><dt>宏观环境卡：补齐 5 项实时宏观指标</dt><dd>按「实时 / 每日市场情绪指标」对照表补齐缺失数据：纳斯达克100（^NDX）、标普500（^GSPC）、美国10年期国债收益率（^TNX，自动换算为百分比）、美元兑离岸人民币（CNH=X）、布伦特原油（BZ=F），全部走 Yahoo Finance 免费日线，与既有黄金 / 美元指数 / WTI / VIX 同源同刷新节奏（每 10 分钟检查）。原有指标一项未删。</dd><dt>宏观卡顶部新增「宏观实况」滚动条</dt><dd>卡头下方新增一条无缝横向滚动的实时数据条，滚动展示美元指数、纳指、标普、美债收益率、原油（WTI/布伦特）、离岸人民币汇率、黄金与 VIX 的最新值与日内涨跌幅；悬停自动暂停。数据与下方综合指标网格同源。</dd><dt>顶部多币种按钮改为宏观实况滚动条</dt><dd>多币种模式下，BTC / ETH / ZEC / BNB 四个按钮换成一条与宏观卡同款的「宏观实况」滚动条（独立拉取，每 60 秒刷新，悬停暂停）；币种切换收进滚动条右侧的紧凑下拉（显示当前币种，点开选择），切换能力保留。比特币模式下该区域照旧隐藏，页面与旧版完全一致。</dd></dl><hr>` + v21253MacroLiveTickerChangelog;
  // v2.12.54：正式移除单币种（比特币）模式，恒为多币种；币种下拉上移顶栏、与多分屏交换位置。
  const v21254CoinOnlyChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.54 更新日志</b><dl><dt>正式移除单币种（比特币）模式</dt><dd>顶栏「₿ 比特币 / 多币种」模式开关删除，页面恒为多币种模式：曾停留在比特币模式的用户升级后自动回到多币种（选中币种归位 BTC），宏观实况滚动条与币种下拉常驻显示，历史存储里的旧模式标记不再生效。</dd><dt>币种下拉移入顶栏，与多分屏按钮交换位置</dt><dd>币种切换下拉（BTC ▾）从顶部市场条右侧上移到顶栏最左，「⊞ 多分屏」紧随其后；顶部市场条只保留宏观实况滚动条（通栏圆角）。下拉配色对齐顶栏紫胶囊，明暗主题各自适配；下拉展开期间顶栏不再自动收起。</dd></dl><hr>` + v21254CoinOnlyChangelog;
  // v2.12.55：宏观实况条升级 —— 卡内滚动条移除、顶部双条统一上移、异动/临近动效与内容自定义。
  const v21255MacroLiveUpgradeChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.55 更新日志</b><dl><dt>顶部双条统一：宏观实况 + 宏观预警</dt><dd>「宏观环境与跨市场联动」卡内不再重复放滚动条；顶部的「宏观实况」条与「宏观预警」条样式完全统一（同高、同圆角、同结构），宏观预警条紧贴宏观实况条下方，两条都位于「我的持仓 / 实时价格」上方。宏观实况条新增显示/隐藏开关（宏观卡右上角，与宏观事件中枢的预警条开关同一套逻辑，选择会记住），条右侧也有 ✕ 可快速收起。</dd><dt>异动闪烁与 24 小时临近预警动效</dt><dd>宏观实况条里日内涨跌幅达到 ±1% 的指标会以金色闪烁高亮，波动越大越醒目；宏观预警条里未来 24 小时内即将公布的事件新增琥珀色呼吸闪烁，临近 15 分钟内仍维持原有的高频红色闪烁，提示「马上要出结果了」。</dd><dt>实况条内容自定义</dt><dd>「综合指标」标题行新增「⚙ 实况条设置」：勾选/取消美元指数、股指、美债、原油、人民币、黄金、VIX 等指标，顶部滚动条立即按选择重排，选择持久化保存。综合指标标题同时补上英文名（如「黄金 Gold」），采用中英结合命名。</dd><dt>数据清理：移除交易所 BTC 钱包余额，美股联动去重</dt><dd>「交易所 BTC 钱包余额」长期因缺少链上数据源显示「暂不可用」，本次从综合指标中移除。美股联动面板原先展示的标普 500 / 纳斯达克 100 报价卡与综合指标重复，已移除报价卡、保留相关性分析与看多概率（美股实时报价以综合指标为准）。</dd></dl><hr>` + v21255MacroLiveUpgradeChangelog;
  // v2.12.56：实况条条目可点击跳转 + 综合指标脉冲提示 + 实况条 ⚙ 设置入口。
  const v21256TickerJumpChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.56 更新日志</b><dl><dt>宏观实况条：点击指标直达宏观卡</dt><dd>顶部「宏观实况」条里的每个指标现在可以点击：页面自动滚动到下方「宏观环境与跨市场联动」卡的「综合指标」区，对应的指标卡片会放大缩小两拍并带青色描边高亮，在十来张卡片里一眼认出刚在滚动条里看到的那一项。</dd><dt>实况条右端新增 ⚙ 设置入口</dt><dd>点击后同样跳到宏观卡并直接展开「实况条设置」浮层，勾选/取消指标即可自定义顶部滚动条显示哪些数据，不必先找设置按钮在哪。宏观卡里原有的「⚙ 实况条设置」保持不变，两处入口共用同一份设置与保存逻辑。</dd></dl><hr>` + v21256TickerJumpChangelog;
  // v2.12.57：关注卡新增「锁定」—— 锁定后点顶部预警条不再抢占卡片，改为跳宏观事件中枢高亮。
  const v21257PinLockChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.57 更新日志</b><dl><dt>关注宏观事件卡：新增「锁定」</dt><dd>此前在顶部「宏观预警」条里点任意事件，都会把「关注宏观事件实时数据」卡切到那条并滚过去 —— 正在盯非农时点一下别的条目，关注卡就被抢走了。现在卡上新增「锁定」按钮（状态持久化）：锁定后点击预警条里的事件，若它正是当前关注的那条，页面直接滚回关注卡并闪烁提示；若不是当前关注的，则跳到下方「宏观事件中枢」，对应事件行放大缩小高亮，告诉你它在哪里 —— 关注卡保持不动。想换关注对象时，点「更换」菜单选择仍然直接切换（显式操作优先于锁定）。</dd></dl><hr>` + v21257PinLockChangelog;
  // v2.12.58：锁定收紧 —— 「更换」在锁定期间整体冻结，先解锁才能换关注对象。
  const v21258LockFreezeChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.58 更新日志</b><dl><dt>关注卡锁定收紧：「更换」随锁定一并冻结</dt><dd>v2.12.57 上线锁定时保留了「更换菜单仍可直接切换」的口子，实际用下来容易误触换掉正在盯的事件。现在锁定期间点「更换」不再展开菜单，按钮置灰并左右抖动提示，必须先点「已锁定」解锁、再「更换」；锁定瞬间若更换菜单开着也会自动收起。顶部预警条点击的定位逻辑不变。</dd></dl><hr>` + v21258LockFreezeChangelog;
  // v2.12.59：「规则测试已发送」提示被消息推送弹层盖住 —— 提示层提到 1200，压过所有业务弹层。
  const v21259NoticeZIndexChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.59 更新日志</b><dl><dt>修复「规则测试已发送」提示被推送面板盖住</dt><dd>症状：在「消息推送」弹层里点规则的「测试」后，「规则测试已发送」提示被推送面板整个盖住，必须先关掉消息推送面板才能看到。根因：提示层 z-index 为 1001，而消息推送弹层复用推送设置的 1004 层级，同层时后挂载的弹层永远压在提示上面。修复：提示层提升到 1200，与全局确认框同级，压过所有业务弹层；提示弹出时无需关闭任何面板。纯样式改动，刷新即生效。</dd></dl><hr>` + v21259NoticeZIndexChangelog;
  // v2.12.60：浅色主题对比度全面修复 —— 深色渐变面板在浅色下变成「深底深字」的一批卡片全部适配。
  const v21260LightContrastChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.60 更新日志</b><dl><dt>浅色主题对比度全面修复</dt><dd>症状：切到浅色主题后，指标明细、周期涨幅、研究预测（BTC 多因子）、宏观环境与跨市场联动、信号有效区间、关注宏观事件等一批卡片仍带着深色渐变底，而文字却跟随主题变成深色 —— 深底深字几乎不可读；顶部宏观实况条的金色数字、OKX 微观结构的琥珀警语、「已公布」折叠行等也在浅底上对比不足。根因：一组共享的深色渐变规则带 !important，把早前没有 !important 的浅色覆盖全部压住。修复：浅色主题下这批面板统一切换为浅色表面（auto 主题跟随系统浅色时同步），金色/琥珀文字在浅底下换深琥珀变体，KRONOS 卡涨跌色改读主题变量（明暗自适应），「计算」按钮在浅色下加深紫色渐变。深色主题外观不变。纯样式改动，刷新即生效。</dd></dl><hr>` + v21260LightContrastChangelog;
  // v2.12.61：宏观事件中枢浅色翻浅（修复 v2.12.61 块此前被 v2.12.60 行覆盖、日志面板显示不出的链序错误）
  const v21261MacroCalLightChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.61 更新日志</b><dl><dt>宏观事件中枢：浅色主题整卡翻浅</dt><dd>症状：切到浅色主题后，其它卡片都变浅了，唯独「宏观事件中枢」整张卡仍是深色渐变底。根因：这张卡是早期的「强制深色」设计 —— 卡底深色渐变带 !important，卡内配色由一组卡级 --cal-* 变量锁定为深底浅字，与外层主题完全脱钩。修复：浅色主题下把卡面翻成白/浅灰渐变，卡级变量整体重映射为浅色系（深字、深青强调色、深绿/深红涨跌色），卡内的筛选下拉菜单、国旗胶囊、分类徽章（宏观/流动性/能源/风险/加密）、「今天」徽标、「现在」分隔线、「继续展开」按钮、影响矩阵单元格等硬编码色逐条适配；「更换关注」浮层随卡一起翻浅。auto 主题跟随系统浅色时同步。深色主题下这张卡保持原有深色外观不变。纯样式改动，刷新即生效。</dd></dl><hr>` + v21261MacroCalLightChangelog;
  // v2.12.62：告警推送钉钉 markdown 化 —— 色标（红跌绿涨）、加粗、站点蓝链、文案去重重排。
  const v21262PushMarkdownChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.62 更新日志</b><dl><dt>警报推送样式重做：颜色提示 + 站点链接 + 文案重排</dt><dd>钉钉机器人从纯文本消息改为 markdown 消息：原来 ** 加粗星号原样露出、不可能有颜色，现在正常渲染。文案加红跌绿涨色标（🟢 上破/上涨、🔴 下破/跌破、⚠️ 无方向），标题、正文首行同步；信息重排为「触发摘要 → 当前价 → 明细字段 → 触发时间 → 交易对 → 站点链接」，一眼先看到命中价位与市价；修掉了同一条消息里触发文案重复出现三次的问题。正文末尾新增醒目蓝色链接「jeffereyreng.site · 查看实时行情」，点击直达站点。Bark 渠道无 markdown 渲染，自动降级为纯文本（剥加粗、链接转「文字：URL」），不再裸露星号。本地服务端与云端部署同步生效。</dd></dl><hr>` + v21262PushMarkdownChangelog;
  // v2.12.63：各告警类型文案按语义细分 + 爆仓方向色标修正。
  const v21263AlertCopyChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.63 更新日志</b><dl><dt>各类型告警文案优化：整数明确上破/下破，爆仓色标修正</dt><dd>把 8 类告警的标题与明细文案按语义统一重排：整数告警拆成「整数上破告警 / 整数下破告警」（命中整数位时一眼看清是涨破还是跌破）；价格类拆成「上涨告警（涨破）/ 下跌告警（跌破）」；网格、波动、爆仓各自文案更贴合实际事件。爆仓色标修正：多头爆仓=价格下跌=🔴、空头爆仓=价格上涨=🟢，旧实现把「接近多头爆仓价」误判成绿色，本次通过显式 direction 参数彻底修掉；网格/整数等原先无方向词的告警也补齐了精准着色。爆仓明细新增「距爆仓幅度」百分比字段，更直观判断逼近程度。文案与 v2.12.62 的钉钉 markdown / 站点蓝链 / 红跌绿涨样式保持一致，本地、云端、Bark 三路同步生效。</dd></dl><hr>` + v21263AlertCopyChangelog;
  // v2.12.64：告警推送版式整理 —— 钉钉换行改段落空行、字段值统一加粗。
  const v21264PushLayoutChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.64 更新日志</b><dl><dt>告警推送版式整理：一行一条、字段值统一加粗</dt><dd>把告警推送的正文版式按「标题一行 + 每个字段独占一行」整理：钉钉 markdown 的换行从行尾双空格硬换行改为段落空行分隔（硬换行在钉钉客户端不稳定、容易被折叠成一行挤在一起），现在当前价、各明细字段、触发时间、交易对、站点链接逐行显示、行间留白，一眼扫下来就是一条完整明细；全部明细字段的值统一加粗（此前只有部分字段加粗，字重参差）。Bark 渠道仍自动降级纯文本，逐行保留。纯排版调整，内容与色标（🟢 涨 / 🔴 跌）不变，本地服务端即时生效。</dd></dl><hr>` + v21264PushLayoutChangelog;
  // v2.12.68：本地多渠道推送、% 后缀显示修复、登录后上传提示。
  const v21268LocalChannelsChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.68 更新日志</b><dl><dt>本地多渠道推送设置 & 登录上传提示</dt><dd>推送设置改为「本地/云端」清晰分流：未登录时所有渠道（Server酱 / Bark / Webhook / 钉钉 / 飞书）均可配置，配置加密保存在本机 secure vault；本地 8787 在线时由浏览器直接推送，掉线或关页后自动切云端。修复亏损/强平阈值输入框的 % 字体重叠：单位选择器显示文字单位，输入框右侧静态显示 %。冷却分钟数移除微调器、只能填整数。登录成功后自动弹出「上传本地数据到云端」提示，支持一键同步推送规则与渠道、AI 助手/API 设置、持仓数据；持仓同时提供下载云端覆盖本地的入口。若用户未处理，下次登录会继续提示，点击「不再提示」后不再打扰。</dd></dl><hr>` + v21268LocalChannelsChangelog;
  // v2.12.67：亏损推送简化为单阈值（警告+推送同时），亏损/强平均支持 % 与金额/价格双向实时换算，按参考仓位联动，天然多仓位。
  const v21267LossPushSimplifyChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.67 更新日志</b><dl><dt>亏损推送：单阈值 + 双向实时换算 + 多仓位联动</dt><dd>把「亏损推送（联动持仓）」从「三维度 × 警告/推送两级」简化为单一阈值：命中即页面警示并外推（警告与推送同时发生）。亏损设置合并为一个输入框 + 单位切换（% / USDT），基于所选「参考仓位」的名义持仓实时双向换算——填百分比自动算出对应亏损额，填金额自动算出对应百分比。强平设置同样合并为一个输入框 + 单位切换（距强平价% / 强平价价格），填百分比给出触发价与理论强平价，填价格自动折算距离百分比。新增「参考仓位」下拉（仅用于换算预览）；阈值以通用口径作用于每个仓位：亏损金额阈值在每个仓位独立判定（亏损达到该 USDT 即提醒），强平价距离阈值按百分比作用于每个仓位，天然支持多仓位。后端 push-settings schema 同步精简，前端 UI、换算逻辑与文案统一更新。</dd></dl><hr>` + v21267LossPushSimplifyChangelog;
  // v2.12.66：亏损推送触发维度从单一 ROE 扩展为亏损百分比 / 亏损额 / 距离强平价百分比。
  const v21266LossPushChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.66 更新日志</b><dl><dt>亏损推送：三维度触发</dt><dd>原「亏损推送（联动持仓）」仅按保证金收益率 ROE（价格变动% × 杠杆）触发，现在改为三套独立阈值，每套均分「警告 / 推送」两级：① 亏损百分比（按开仓价计算的价格亏损幅度）；② 亏损额（按持仓名义价值估算的绝对亏损金额）；③ 距离强平价百分比（按理论强平价计算）。三者互斥或关系：任一维度先达到推送线即触发亏损推送，无推送线命中但达到警告线则触发警告。设置保存在云端 push-settings，alert-worker 每 15 秒扫描一次持仓档案并统一推送文案，正文展示命中时各维度的具体数值与理论强平价。UI 上的输入框同步改为三组，小字说明同步更新计算公式。</dd></dl><hr>` + v21266LossPushChangelog;
  // v2.12.69：登录同步改为双向（按时间戳 last-write-wins）。
  const v21269BidirectionalSyncChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.69 更新日志</b><dl><dt>登录同步改为双向（按时间戳较新者为准）</dt><dd>登录后弹出的数据同步从「单向上传」改为「双向合并」：① 推送规则与自动播报（语音规则）按条目合并——同 id 比 updatedAt 取新、不同 id 并集保留，不再整组覆盖误删；② 持仓按「集合时间戳」整组替换（较新一方整体覆盖，符合你设定的捆绑语义）；③ API 密钥因服务端安全不回传浏览器，仅本地→云端上传、云端→本地下载不可用。服务端 alert_rules 新增 updated_at 并复用本地规则 id，使双向合并成立。未处理时下次登录继续提示，点「不再提示」后不再打扰。</dd></dl><hr>` + v21269BidirectionalSyncChangelog;
  // v2.12.65：OKX 同步持仓写入本地 SQLite，作为 localStorage / 云端同步之外的本地持久层。
  const v21265LocalPositionsChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.65 更新日志</b><dl><dt>OKX 同步持仓写入本地数据库</dt><dd>从欧易同步持仓时，除页面 localStorage 与云端同步外，额外写入本机 SQLite（data/positions.sqlite）。新增 /api/positions 接口（GET/POST/DELETE），无需云端登录；OKX 扩展 content-app.js 在填卡成功后自动落库，本地持久化便于后续读取、跨浏览器恢复与风控联动。</dd></dl><hr>` + v21265LocalPositionsChangelog;
  // v2.12.70：修复亏损/强平阈值单位被强制回退 + 亏损推送新增「测试发送」按钮。
  const v21270LossPushUnitTestChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.70 更新日志</b><dl><dt>亏损 / 强平阈值单位记忆修复</dt><dd>此前选择「百分比 / 百分比距离」后，每次重新打开亏损推送面板都会被强制回退成「金额 / 百分比距离」：根因是服务端只持久化了换算后的金额与百分比，未保存用户选择的输入单位，前端每次渲染都硬编码为默认单位。现服务端 alert_push_settings 的 lossPush 增加 lossUnit / lossValue / liqUnit / liqValue 四个字段持久化用户的选择与原始输入值；前端 syncSettingsInputs 改为按已存单位回填，亏损阈值选百分比不再跳回金额，强平阈值（百分比距离 / 价格）也正确联动与还原。</dd><dt>亏损推送「测试发送」按钮</dt><dd>在亏损推送卡片内新增「测试发送」按钮：用当前输入框的亏损阈值、强平阈值与参考仓位构造一条模拟触发文案（含当前价格、名义持仓、亏损额与距强平价百分比），经现有本地 / 云端渠道发出，便于即时验证推送链路是否畅通。无启用渠道时给出明确提示；本地渠道优先，未配置本地则走云端自定义消息接口。</dd></dl><hr>` + v21270LossPushUnitTestChangelog;
  // v2.12.71：美联储利率监测（Fed Rate Monitor）——目标利率概率上线。
  const v21271FedRateChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.71 更新日志</b><dl><dt>美联储利率监测：目标利率概率上线</dt><dd>「宏观环境与跨市场联动」卡新增『美联储利率监测』面板：基于 CME 30 天联邦基金期货月度合约（行情经 Yahoo Finance 免费源转发）与美联储公开日历的市场隐含目标利率概率，月末加权算法与 Investing.com Fed Rate Monitor 同族；当前目标区间取自 FRED 的 DFEDTARU 日度序列。展示未来两至三场 FOMC 决议的期货价格、北京时间决议时刻与倒计时、各目标利率区间的概率横条及较昨日变化（按期货昨收盘复算）；第二场起按路径递推（以前一场期望结果为基准），概率随期货价格每 10 分钟刷新。新增 /api/fed-rate-monitor 接口，并随 /api/fed-calendar 一并下发。所有数字是市场定价快照，不构成方向预测。</dd></dl><hr>` + v21271FedRateChangelog;
  // v2.12.72：推送设置新增「推送日志」+ 桌面 app 切回旧标签自动重载（根治缓存错位）
  const v21272PushLogChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.72 更新日志</b><dl><dt>推送设置新增「推送日志」+ 桌面 app 根治缓存错位</dt><dd>推送设置（⚙）新增「推送日志」按钮：弹窗按时间倒序列出历史推送投递，逐条展示投递时间、状态（送达 / 失败）、消息类型与标题、以及各渠道服务名（成功 / 失败），即「几点几分往哪个服务推送了哪条消息」。数据来自服务端 alert_deliveries 表（本次已把推送消息正文补进投递记录，此前仅存消息类型），新增 /api/alerts/deliveries 查询接口（需登录）。桌面启动器同步根治：命中已开旧标签后顺手 location.reload()，以后每次点 app 自动吃到最新前端，不再有「我这边好、你那边坏」的缓存错位。</dd></dl><hr>` + v21272PushLogChangelog;
  // v2.12.73：推送日志补全详细内容 + 按钮挪到「消息推送」标题栏。
  const v21273PushLogDetailChangelog = log.innerHTML;
  log.innerHTML = `<b>v2.12.73 更新日志</b><dl><dt>推送日志展示完整推送内容 + 入口挪到「消息推送」标题栏</dt><dd>推送日志逐条展示手机端实际收到的完整文本：推送标题 + 多行正文（保留换行），逐渠道标注成功 / 失败，失败渠道直接附上具体失败原因（悬停徽章也可查看），整体投递失败时展示顶层错误。旧记录（本次升级前入库）当时未存正文，仅能显示消息类型；新推送起全部带完整内容。「推送日志」入口从「推送设置」弹窗挪到「消息推送」弹层标题栏（标题右侧），打开消息推送即可一键查看，无需先进设置。</dd></dl><hr>` + v21273PushLogDetailChangelog;
  // v2.12.74：推送日志默认只加载最近 10 条 + 「展示全部」，根治打开日志卡「加载中」很久。
  const v21274PushLogPageChangelog = log.innerHTML;
  log.innerHTML = '<b>v2.12.75 更新日志</b><dl><dt>市场异动监测卡片</dt><dd>周期涨幅下方新增「市场异动监测」面板，基于现有 OKX 数据实时评估 5 类异动并给出三态提示（正常/关注/异动）：成交量放大（当前 K 线量 ÷ 近 20 根均值）、资金费率极端（|费率|/8h）、永续 OI 快速变化（约 5 分钟窗口）、关键支撑/阻力有效收盘突破（近期摆动高低点）、巨鲸交易与交易所净流出。其中成交量/资金费率/OI/支撑阻力四项完全由站内数据计算；巨鲸与净流出需配置 ONCHAIN_API_KEY（CryptoQuant / Coinglass）后启用，未配置时显示「未配置」而不报错。</dd></dl><hr>' + `<b>v2.12.74 更新日志</b><dl><dt>推送日志分页加载：默认 10 条 + 「展示全部」</dt><dd>推送日志此前一次性拉取并渲染最近 100 条，打开后长时间停在「加载中」。现改为默认只加载最近 10 条（秒开），列表底部出现「展示全部（更早的推送）」按钮，点击后才拉取全量（最多 200 条）。请求同时加 8 秒超时保护：超时或失败会给出明确提示，不再永久转圈。服务端 alert_deliveries 补 user_id 维度索引，日志查询随数据量增长仍保持毫秒级。</dd></dl><hr>` + v21274PushLogPageChangelog;
  // v2.12.76：API 接入中心新增 CryptoQuant 接入区。
  const v21276CqApiCenterChangelog = log.innerHTML;
  log.innerHTML = '<b>v2.12.76 更新日志</b><dl><dt>API 接入中心新增 CryptoQuant 接入区</dt><dd>「API 接入中心 → 可选升级」新增 CryptoQuant 行：填入免费 API key（cryptoquant.com 免费注册即得）即可启用「市场异动监测」卡片中的交易所净流入与巨鲸大额交易监测；免费层为日级数据、巨鲸笔数可能不含，缺失项自动降级不报错。支持一键「验证 Key」，Key 仍以服务端加密保存、不会回显；服务器环境变量 ONCHAIN_API_KEY 注入方式继续可用，页面保存的 Key 优先。顺带修正链上请求鉴权头（token → Bearer）并把请求分辨率对齐免费层（hour → day）。</dd></dl><hr>' + v21276CqApiCenterChangelog;
  // v2.12.77：链上净流出默认走 CoinMetrics 免费源；修正 CryptoQuant 套餐认知与验证端点。
  const v21277CmOnchainChangelog = log.innerHTML;
  log.innerHTML = '<b>v2.12.77 更新日志</b><dl><dt>交易所净流出改为默认可用（CoinMetrics 免费源）</dt><dd>经与官方文档核实，CryptoQuant 的链上数据（交易所净流入/巨鲸交易）需 Professional 及以上付费套餐，免费 Key 调用会返回 403（此前「免费层可用」的说法有误）。现改为：「市场异动监测」卡片的交易所净流出一律默认走 CoinMetrics Community 免费 API（无需任何 Key，日级数据，正=净流入 / 负=净流出），开箱即用。API 接入中心的 CryptoQuant 行改为「付费增强源（可选）」：验证 Key 改用所有套餐均可调的 market-data 端点（免费 Key 也能验证通过并明确提示套餐限制）；若配了付费套餐 Key，链上请求优先走 CryptoQuant，遇 403 自动回落 CoinMetrics 不空转。Coinglass 路径保留。</dd></dl><hr>' + v21277CmOnchainChangelog;
  // v2.12.78：规则信号基准周期 3h → 4h/6h，并修掉取数失败被静默吞掉的隐患。
  const v21278BasisIntervalChangelog = log.innerHTML;
  log.innerHTML = '<b>v2.12.78 更新日志</b><dl><dt>「当前规则信号」基准周期：3 小时 → 4 小时 / 6 小时</dt><dd>原 3 小时档位只有 OKX 能提供，且还需服务端把 1 小时 K 线聚合而成；Gate 与 Binance 都不支持该周期（实测分别返回 INVALID_PARAM_VALUE 与 Invalid interval），切到这两个数据源时规则信号会取不到数据。现移除 3 小时，改为 4 小时与 6 小时——三家数据源全部原生支持，同时与图表 K 线选择器、多周期共振、AI 快照所用的周期保持一致：4 小时是币圈中线通用档，6 小时给出更长一档的趋势视角。各档「有效至」时长同步按 24 根基准 K 线计算（4 小时 ≈ 4 天、6 小时 ≈ 6 天）。另修复：基准取数失败此前被空 catch 静默吞掉，卡片会继续展示上一次数据源的旧 K 线却看不出异常，现在改为在基准行直接提示失败原因。停留在 3 小时的历史偏好会自动迁移到 4 小时。</dd></dl><hr>' + v21278BasisIntervalChangelog;
  // v2.12.79：修复账户面板规则列表查询的 SQL 别名错误（v2.12.78 多币种改动引入）。
  const v21279AlertRulesFixChangelog = log.innerHTML;
  log.innerHTML = '<b>v2.12.79 更新日志</b><dl><dt>修复：打开「账户与云端服务」报「云端服务暂不可用」</dt><dd>上一版加入多币种规则隔离时，规则列表查询把 coin 列写成了带表别名的 r.coin，但同一条 SQL 的 FROM 子句并未声明别名 r（同批改动里的另一条查询有别名、这条漏了），导致打开账户面板必然报错「接口不可用：missing FROM-clause entry for table "r"」，账户信息与规则列表完全无法加载。现已修正该查询，账户面板恢复正常。属纯查询语句修复，数据库结构与已存数据均不受影响。</dd></dl><hr>' + v21279AlertRulesFixChangelog;
  // 旧版本默认收起，确保用户打开日志时首先看到当前版本的完整变更。
  // Older releases are collapsed by default so opening the log focuses on the current release.
  const collapseLegacyRelease = () => {
    const divider = log.querySelector("hr"),
      heading = divider?.nextElementSibling,
      content = heading?.nextElementSibling;
    if (!divider || heading?.tagName !== "B" || content?.tagName !== "DL")
      return false;
    const details = document.createElement("details"),
      summary = document.createElement("summary");
    details.className = "legacy-release";
    summary.textContent = heading.textContent;
    details.append(summary, content);
    divider.replaceWith(details);
    heading.remove();
    return true;
  };
  // 自动收起当前版本之后的全部历史版本；版本链增长时无需再维护固定调用次数。
  // Collapse every release after the current one; future releases need no manual count update.
  while (collapseLegacyRelease()) {}
  document.body.append(log);
  version.onclick = () => {
    const open = log.hidden;
    if (open) {
      const rect = version.getBoundingClientRect();
      const width = Math.min(480, window.innerWidth - 28);
      log.style.top = `${Math.min(window.innerHeight - 80, rect.bottom + 8)}px`;
      log.style.left = `${Math.max(14, Math.min(window.innerWidth - width - 14, rect.left))}px`;
      log.style.right = "auto";
    }
    log.hidden = !open;
    version.setAttribute("aria-expanded", String(open));
  };
  document.addEventListener("click", (event) => {
    if (
      !log.hidden &&
      !log.contains(event.target) &&
      event.target !== version
    ) {
      log.hidden = true;
      version.setAttribute("aria-expanded", "false");
    }
  });
})();

/* Chart display controls: persist an intentional, uncluttered line setup. */
function updateTopLegend() {
  const legend = $("chartLegend"),
    series = state.chartSeries || {},
    lines = state.chartLines || {};
  if (!legend) return;
  legend.querySelectorAll("[data-legend-series]").forEach((el) => {
    const key = el.dataset.legendSeries;
    el.classList.toggle("legend-off", !series[key]);
  });
  legend.querySelectorAll("[data-legend-line]").forEach((el) => {
    const key = el.dataset.legendLine;
    el.classList.toggle("legend-off", lines[key] === false);
  });
  legend.querySelectorAll("[data-legend-sub]").forEach((el) => {
    const key = el.dataset.legendSub;
    el.classList.toggle("legend-off", !series[key]);
  });
}
(() => {
  const toolbar = $("chart")?.closest(".card")?.querySelector(".toolbar"),
    chartBox = $("chart")?.closest(".chart-box");
  if (!toolbar || $("chartDisplayControls")) return;
  const saved = JSON.parse(localStorage.getItem("btc_chart_display") || "{}");
  state.chartSeries = {
    candles: saved.candles ?? saved.mode !== "line",
    close: saved.close ?? saved.mode === "line",
    volume: saved.volume ?? true,
    rsi: saved.rsi ?? true,
  };
  state.chartLines = {
    ma20: saved.ma20 ?? true,
    ma50: saved.ma50 ?? true,
    ma200: saved.ma200 ?? true,
    boll: saved.boll ?? true,
    vwap: saved.vwap ?? true,
  };
  /* 价格纵坐标（图表里那一列价格数字）：贴哪一端、要不要显示。
     刻意用一组新键名，免得读到早期同名字段留下的历史取值。 */
  state.priceAxis = saved.priceAxis ?? true;
  state.priceAxisSide = saved.priceAxisSide === "left" ? "left" : "right";
  const patternLegend = document.createElement("div");
  patternLegend.id = "chartPatternLegend";
  patternLegend.className = "chart-pattern-legend";
  patternLegend.innerHTML =
    `<span><b>H</b> ${tx("锤子线：长下影线，表示低位承接形态", "Hammer: long lower wick, a bottom-acceptance pattern")}</span><span><b>S</b> ${tx("流星线：长上影线，表示高位抛压形态", "Shooting star: long upper wick, a top-rejection pattern")}</span>`;
  const panel = document.createElement("div");
  panel.id = "chartDisplayControls";
  panel.className = "chart-display-controls";
  const sync = () => {
    panel
      .querySelectorAll("[data-series]")
      .forEach((b) =>
        b.classList.toggle("active", state.chartSeries[b.dataset.series]),
      );
    panel
      .querySelectorAll("[data-sub]")
      .forEach((b) =>
        b.classList.toggle("off", !state.chartSeries[b.dataset.sub]),
      );
    panel
      .querySelectorAll("[data-line]")
      .forEach((b) =>
        b.classList.toggle("off", !state.chartLines[b.dataset.line]),
      );
    patternLegend.hidden = !state.chartSeries.candles;
    panel
      .querySelector("[data-pricetag]")
      ?.classList.toggle("off", !state.priceAxis);
    panel.querySelectorAll("[data-pricetag-side]").forEach((b) => {
      b.disabled = !state.priceAxis;
      b.classList.toggle(
        "active",
        !!state.priceAxis && b.dataset.pricetagSide === state.priceAxisSide,
      );
    });
    localStorage.setItem(
      "btc_chart_display",
      JSON.stringify({
        ...state.chartSeries,
        ...state.chartLines,
        priceAxis: state.priceAxis,
        priceAxisSide: state.priceAxisSide,
      }),
    );
    const activeItems = [];
    if (state.chartSeries.candles)
      activeItems.push(tx("K线图", "Candlestick"));
    if (state.chartSeries.close)
      activeItems.push(tx("价格线", "Price line"));
    panel.querySelector("[data-current-chart]").textContent =
      activeItems.join(" + ") || tx("已隐藏", "Hidden");
    updateTopLegend();
    drawCandlestickChart();
  };
  panel.innerHTML = `<div class="control-popover chart-picker"><button class="control-trigger" type="button" aria-haspopup="true" aria-expanded="false"><span class="control-label">${tx("图表", "Chart")}</span><b data-current-chart></b><i aria-hidden="true">▾</i></button><div class="control-popover-panel chart-display-options"><div class="chart-series-options"><button type="button" data-series="candles">${tx("K线图", "Candlestick")}</button><button type="button" data-series="close">${tx("价格线", "Price line")}</button></div><div class="chart-line-toggles"><button type="button" data-line="ma20">MA20</button><button type="button" data-line="ma50">MA50</button><button type="button" data-line="ma200">MA200</button><button type="button" data-line="boll">${tx("布林带", "Bollinger")}</button><button type="button" data-line="vwap">VWAP</button></div><div class="chart-line-toggles"><button type="button" data-pricetag>${tx("价格坐标", "Price axis")}</button><button type="button" data-pricetag-side="left">${tx("贴左", "Left")}</button><button type="button" data-pricetag-side="right">${tx("贴右", "Right")}</button></div></div></div>`;
  const popover = panel.querySelector(".control-popover"),
    trigger = panel.querySelector(".control-trigger");
  trigger.addEventListener("click", () => {
    const open = popover.classList.toggle("is-open");
    trigger.setAttribute("aria-expanded", String(open));
  });
  panel.addEventListener("click", (event) => {
    const series = event.target.dataset.series,
      line = event.target.dataset.line,
      tagToggle = event.target.dataset.pricetag,
      tagSide = event.target.dataset.pricetagSide;
    if (series) state.chartSeries[series] = !state.chartSeries[series];
    if (line) state.chartLines[line] = !state.chartLines[line];
    if (tagToggle !== undefined) state.priceAxis = !state.priceAxis;
    if (tagSide && state.priceAxis) state.priceAxisSide = tagSide;
    if (series || line || tagToggle !== undefined || tagSide) sync();
  });
  toolbar.append(panel);
  sync();
  /* 顶部固定图例条：把形态说明与颜色图例全部收拢到 toolbar 与 chart-box 之间，
     空间不足时自动换行，避免在图表内部四角堆叠。 */
  const strip = document.createElement("div");
  strip.id = "chartLegendStrip";
  strip.className = "chart-legend-strip";
  // 清理旧版底部图例行，避免与新版顶部图例条重复。
  const oldRow = $("chartLegendRow");
  if (oldRow) oldRow.remove();
  // 若页面已存在旧版 chartLegend，直接迁移到 strip 中复用。
  const existingLegend = $("chartLegend");
  if (existingLegend) strip.append(existingLegend);
  strip.append(patternLegend);
  toolbar.after(strip);
})();
/* 当前所选来源始终为永续合约，应明确标出，避免被误认为现货。
   The selected source is always a perpetual contract; say so explicitly so
   a displayed futures quote is never mistaken for spot. */
/* The glass source menu is opened by CSS hover; JavaScript is used only to
   apply an option through the existing source-change handler. */
(() => {
  const native = $("source");
  if (!native || $("sourcePicker")) return;
  native.classList.add("source-native");
  const picker = document.createElement("div");
  picker.id = "sourcePicker";
  picker.className = "dropdown-container";
  picker.innerHTML =
    '<span class="dropdown-trigger" aria-hidden="true"></span><div class="dropdown-menu" role="listbox"></div>';
  native.after(picker);
  const trigger = picker.querySelector(".dropdown-trigger"),
    menu = picker.querySelector(".dropdown-menu"),
    sync = () => {
      trigger.textContent =
        native.options[native.selectedIndex]?.textContent || native.value;
      menu.innerHTML = [...native.options]
        .map(
          (option) =>
            `<button type="button" role="option" aria-selected="${option.value === native.value}" data-source-option="${option.value}">${option.textContent}</button>`,
        )
        .join("");
    };
  menu.addEventListener("click", (event) => {
    const option = event.target.closest("[data-source-option]");
    if (!option) return;
    native.value = option.dataset.sourceOption;
    native.dispatchEvent(new Event("change", { bubbles: true }));
    sync();
  });
  native.addEventListener("change", sync);
  sync();
})();

/* 英文模式质量层：覆盖固定卡片与动态插入内容。
   Final English-mode QA layer: every persistent card and every dynamically
   rendered market-analysis string is rebuilt from the same locale source. */
/* v2.11.0：联动数据改为集中状态。fedMonitorCard 每 60 秒整卡重渲染，
   面板 DOM 会被重建；correlationState 保存最近一次结果，
   renderFedMonitor 渲染完调用 paintCorrelationPanel() 回填，内容不丢。 */
let correlationState = {
  status: "",
  output: "",
  loaded: false,
  loading: false,
};
function paintCorrelationPanel() {
  const status = $("correlationStatus"),
    out = $("correlationOutput"),
    button = $("refreshCorrelation");
  if (!out) return;
  if (status && correlationState.status) status.textContent = correlationState.status;
  if (correlationState.output) out.innerHTML = correlationState.output;
  if (button && !button.dataset.corrBound) {
    button.dataset.corrBound = "1";
    button.onclick = () => loadCorrelation();
  }
}
loadCorrelation = async function () {
  const status = $("correlationStatus"),
    out = $("correlationOutput");
  if (!out || correlationState.loading) return;
  correlationState.loading = true;
  correlationState.status = tx(
    "正在对齐 " + coinLabel() + "、SPY、QQQ 的共同交易日并训练…",
    "Aligning BTC, SPY and QQQ trading days and training…",
  );
  if (status) status.textContent = correlationState.status;
  try {
    const r = await fetch("/api/correlation-history"),
      d = await r.json();
    if (!r.ok) throw new Error(d.error || "request failed");
    /* v2.12.55：标普 500 / 纳斯达克 100 报价卡移除 —— 与综合指标重复，实时报价以
       综合指标为准；本面板只保留相关性分析与下一交易日看多概率。 */
    const byDate = (arr) =>
        new Map(
          arr.map((x) => [
            new Date(x.time).toISOString().slice(0, 10),
            x.close,
          ]),
        ),
      btc = byDate(d.btc),
      spy = byDate(d.spy),
      qqq = byDate(d.qqq),
      dates = [...btc.keys()].filter((k) => spy.has(k) && qqq.has(k)).sort(),
      rows = [];
    for (let i = 1; i < dates.length - 1; i++) {
      const prev = dates[i - 1],
        cur = dates[i],
        next = dates[i + 1],
        br = (btc.get(cur) / btc.get(prev) - 1) * 100,
        sr = (spy.get(cur) / spy.get(prev) - 1) * 100,
        qr = (qqq.get(cur) / qqq.get(prev) - 1) * 100;
      rows.push({
        br,
        sr,
        qr,
        y: btc.get(next) > btc.get(cur) ? 1 : 0,
        x: [sr, qr, br],
      });
    }
    const recent = rows.slice(-60),
      fit = trainCrossMarket(rows),
      corrSPY = pearson(
        recent.map((x) => x.br),
        recent.map((x) => x.sr),
      ),
      corrQQQ = pearson(
        recent.map((x) => x.br),
        recent.map((x) => x.qr),
      ),
      p = fit ? Math.round(fit.prob * 100) : null,
      correlationLabel = (v) =>
        v >= 0.3
          ? tx("正相关较明显", "Clear positive correlation")
          : v <= -0.3
            ? tx("负相关较明显", "Clear negative correlation")
            : tx("相关性偏弱", "Weak correlation");
    correlationState.output = `<div class="corr-stat"><span>BTC × SPY (${tx("60日", "60d")})</span><b class="${corrSPY >= 0 ? "bull" : "bear"}">${corrSPY >= 0 ? "+" : ""}${corrSPY.toFixed(2)}</b><small>${correlationLabel(corrSPY)}</small></div><div class="corr-stat"><span>BTC × QQQ (${tx("60日", "60d")})</span><b class="${corrQQQ >= 0 ? "bull" : "bear"}">${corrQQQ >= 0 ? "+" : ""}${corrQQQ.toFixed(2)}</b><small>${correlationLabel(corrQQQ)}</small></div><div class="corr-stat wide"><span>${tx("跨市场模型：下一交易日 BTC 看多概率", "Cross-market model: next-session BTC bullish probability")}</span><b class="${p >= 50 ? "bull" : "bear"}">${p === null ? "--" : p.toFixed(2) + "%"}</b><small>${fit ? tx(`SPY、QQQ 与 BTC 当日收益特征 · 样本外准确率 ${(fit.accuracy * 100).toFixed(2)}% · 训练 n=${fit.n}`, `SPY, QQQ and BTC same-day return features · out-of-sample accuracy ${(fit.accuracy * 100).toFixed(2)}% · training n=${fit.n}`) : tx("共同交易日不足", "Not enough shared trading days")}</small></div>`;
    correlationState.status = tx(
      `数据已按共同交易日对齐 · ${d.cached ? "缓存数据" : "刚更新"} · 相关性会随窗口变化，不能单独作为开仓信号。`,
      `Data aligned to shared trading days · ${d.cached ? "cached" : "updated"} · correlations vary by window and are not stand-alone entry signals.`,
    );
    correlationState.loaded = true;
    paintCorrelationPanel();
  } catch (e) {
    correlationState.status = `${tx("美股联动模块暂不可用", "US equities linkage module unavailable")}：${e.message}`;
    paintCorrelationPanel();
  } finally {
    correlationState.loading = false;
  }
};

// 多周期共振常量/状态/调度/渲染已抽到 src/modules/resonance.js（启动时由 initResonance() 初始化）。

const applyLanguageFully = applyLanguage;
applyLanguage = function () {
  applyLanguageFully();
  const zh = uiLang === "zh",
    /* 只替换标题自身文本，保留内部挂载的 help-dot 说明按钮，
       否则启动 1.2s 的语言回填会把「当前规则信号」旁的「!」清掉。 */
    text = (el, cn, en) => {
      if (!el) return;
      const target = zh ? cn : en;
      if (el.querySelector(".help-dot")) {
        if (el.firstChild) el.firstChild.textContent = target;
        else el.textContent = target;
      } else el.textContent = target;
    },
    label = (form, name, cn, en) => {
      const node = form?.elements[name]?.closest("label");
      if (node?.firstChild) node.firstChild.textContent = zh ? cn : en;
    };
  const sourceLabel = document.querySelector(".controls label");
  if (sourceLabel?.firstChild)
    sourceLabel.firstChild.textContent = zh ? "优先源 " : "Preferred source ";
  text(
    $("signal")?.closest("article")?.querySelector("h2"),
    "当前规则信号",
    "Current rule signal",
  );
  text(
    $("indicators")?.closest("article")?.querySelector("h2"),
    "指标明细",
    "Indicator details",
  );
  text(
    document.querySelector('.zoom-tools [data-zoom="reset"]'),
    "重置",
    "Reset",
  );
  const z = document.querySelector(".zoom-tools");
  if (z) {
    z.querySelector('[data-zoom="out"]')?.setAttribute(
      "title",
      zh ? "缩小图表" : "Zoom out",
    );
    z.querySelector('[data-zoom="in"]')?.setAttribute(
      "title",
      zh ? "放大图表" : "Zoom in",
    );
    z.querySelector('[data-zoom="reset"]')?.setAttribute(
      "title",
      zh ? "重置缩放" : "Reset zoom",
    );
  }
  const rangeNames = zh
    ? { "1时": "1时", "6时": "6时", "12时": "12时" }
    : { "1时": "1h", "6时": "6h", "12时": "12h" };
  document
    .querySelectorAll("[data-view]")
    .forEach(
      (node) =>
        (node.textContent = rangeNames[node.dataset.view] || node.dataset.view),
    );
  const coverage = $("coverage");
  if (coverage)
    coverage.textContent = coverage.textContent
      .replace(/^查看范围/, "Visible range")
      .replace(/^K 线周期/, "Candle interval");
  const selection = $("selectionStats");
  if (selection && !chartSelection)
    text(
      selection,
      "拖拽图表可框选区段，显示时间段、最高、最低及涨跌幅。",
      "Drag on chart to select a time span, high, low and return.",
    );
  const resonanceText = $("resonance");
  if (
    resonanceText &&
    /^(尚未计算|Not computed yet)$/.test(resonanceText.textContent.trim())
  )
    text(resonanceText, "尚未计算", "Not computed yet");
  if (resonanceText && RES_INTERVALS.some((iv) => resonanceCache[iv.key]))
    renderResonanceChips();
  const legend = $("chartLegend");
  if (legend) {
    const names = zh
      ? ["K线图", "价格", "MA20", "MA50", "MA200", "布林带", "VWAP", "成交量", "RSI(14)"]
      : ["Candlestick", "Price", "MA20", "MA50", "MA200", "Bollinger", "VWAP", "Volume", "RSI(14)"];
    legend
      .querySelectorAll(":scope > span")
      .forEach((node, i) => {
        if (names[i]) node.textContent = names[i];
      });
  }
  const lev = document.querySelector(".leverage-card");
  text(
    lev?.querySelector(".forecast-head p"),
    "逐仓近似演示；实际强平以标记价格、仓位档位、费用和保证金模式为准。",
    "Isolated-margin approximation; actual liquidation depends on mark price, position tier, fees and margin mode.",
  );
  const position = document.querySelector(".position-card"),
    positionForm = $("positionForm");
  text(
    position?.querySelector("h2"),
    "我的持仓与盈亏估算",
    "My position & PnL estimate",
  );
  text(
    position?.querySelector(".position-head p"),
    "研究估算；强平、费率及资金费以交易所最终规则为准。",
    "Research estimate; final liquidation, fees and funding follow exchange rules.",
  );
  text($("syncMark"), "同步实时标记价", "Sync live mark");
  text(
    $("confirmPosition"),
    "确认持仓并显示买入点",
    "Confirm & show entry point",
  );
  [
    ["side", "方向", "Side"],
    ["exchange", "交易所", "Exchange"],
    ["amount", "持仓量（USDT）", "Position (USDT)"],
    ["margin", "保证金（USDT）", "Margin (USDT)"],
    ["leverage", "杠杆倍率", "Leverage"],
    ["entry", "开仓均价", "Average entry"],
    ["mark", "标记价格", "Mark price"],
  ].forEach((x) => label(positionForm, ...x));
  const liq = $("liqProbabilityCard"),
    liqForm = $("liqProbabilityForm");
  text(
    liq?.querySelector("h2, h3"),
    "强平概率计算器",
    "Liquidation probability calculator",
  );
  text(
    liq?.querySelector(".liq-prob-head p"),
    "基于近期历史震荡的研究估算，不是未来真实概率。",
    "Historical-volatility research estimate, not a future probability.",
  );
  text(
    liq?.querySelector(".liq-prob-head span"),
    "历史震荡估算",
    "Historical volatility estimate",
  );
  [
    ["exchange", "交易所", "Exchange"],
    ["side", "方向", "Side"],
    ["amount", "持仓量（USDT）", "Position (USDT)"],
    ["margin", "保证金（USDT）", "Margin (USDT)"],
    ["leverage", "杠杆倍率", "Leverage"],
    ["entry", "开仓均价", "Average entry"],
  ].forEach((x) => label(liqForm, ...x));
  [positionForm, liqForm].forEach(
    (form) =>
      form?.elements.side &&
      [...form.elements.side.options].forEach(
        (option) =>
          (option.textContent =
            option.value === "long" ? tx("做多", "Long") : tx("做空", "Short")),
      ),
  );
  if (state.lastGood) diagnostics(state.lastGood);
  if (state.candles.length) {
    renderLeverageGuard(metrics(state.candles));
    renderPosition();
    calcLiqProbability();
  }
  if ($("correlationOutput")) loadCorrelation();
};
applyLanguage();

/* Earlier timed setup creates several cards after the first locale pass. */
setTimeout(() => {
  if ($("forecastGrid")) loadForecasts();
  if ($("correlationOutput")) loadCorrelation();
  applyLanguage();
}, 1_200);

function updateSignalProjectionValidation() {
  const box = $("signalProjection"),
    small = box?.querySelector("small"),
    d = state.candles;
  if (!small || d.length < 60) return;
  const minutes =
      {
        "1m": 1,
        "5m": 5,
        "15m": 15,
        "30m": 30,
        "1h": 60,
        "2h": 120,
        "4h": 240,
        "1d": 1440,
      }[state.interval] || 15,
    current = metrics(d),
    targetMinutes =
      Math.abs(current.score) >= 75
        ? 60
        : Math.abs(current.score) >= 50
          ? 40
          : 20,
    horizon = Math.max(1, Math.round(targetMinutes / minutes)),
    start = Math.max(50, d.length - 121),
    end = d.length - horizon;
  let hit = 0,
    total = 0;
  for (let i = start; i < end; i++) {
    const predicted = metrics(d.slice(0, i + 1)).score >= 0,
      actual = d[i + horizon].close >= d[i].close;
    hit += predicted === actual ? 1 : 0;
    total++;
  }
  const accuracy = total ? (hit / total) * 100 : 0,
    html = `${tx("按当前 ATR 波动与规则信号强度推算；预计方向在约", "Derived from current ATR and rule strength; direction is tested over about")} ${targetMinutes}${tx(" 分钟的滚动历史准确度", " minutes of rolling historical validation")} <b>${accuracy.toFixed(2)}%</b> · n=${total}${tx("。目标价本身不保证到达。", "; the target itself is not guaranteed.")}`;
  if (small.dataset.validationHtml === html) return;
  small.dataset.validationHtml = html;
  small.innerHTML = html;
}
setTimeout(() => {
  updateSignalProjectionValidation();
  setInterval(updateSignalProjectionValidation, 10_000);
}, 0);

function refreshDetailedIndicatorHelp() {
  const minutes =
      {
        "1m": 1,
        "5m": 5,
        "15m": 15,
        "30m": 30,
        "1h": 60,
        "2h": 120,
        "4h": 240,
        "1d": 1440,
      }[state.interval] || 15,
    period = (n) => {
      const total = n * minutes;
      return total < 60
        ? `${total} 分钟`
        : total < 1440
          ? `${(total / 60).toFixed(total % 60 ? 1 : 0)} 小时`
          : `${(total / 1440).toFixed(1)} 天`;
    },
    tips = {
      EMA20: `EMA20 看最近 20 根 ${state.interval} K 线（约 ${period(20)}），属于短线趋势参考。现价在 EMA20 上方通常偏强、下方偏弱；它会随当前周期改变。`,
      EMA50: `EMA50 看最近 50 根 ${state.interval} K 线（约 ${period(50)}），属于中短线趋势参考，比 EMA20 更平滑、反应更慢。现价上方偏强、下方偏弱。`,
      EMA200: `EMA200 看最近 200 根 ${state.interval} K 线（约 ${period(200)}），用于较长趋势背景。数据不足时显示 --；它不适合单独做超短线进场判断。`,
      "RSI(14)": `RSI(14) 衡量最近 14 根 ${state.interval} K 线（约 ${period(14)}）的涨跌动量，范围 0–100。约 70 以上常被视为偏热，约 30 以下常被视为偏弱；中间区域表示动量不明确，并非买卖指令。`,
      布林位置: `布林位置表示当前价在布林带上下轨之间的相对位置：0% 靠近下轨，50% 接近中轨，100% 靠近上轨。它主要看价格位置与波动区间，不等于必然反转。`,
      "ATR(14)": `ATR(14) 是最近 14 根 ${state.interval} K 线（约 ${period(14)}）的平均真实波幅，单位是价格/美元。数值越大，说明每根 K 线平均波动越大；它用于估计止损、目标和风险，不判断涨跌方向。`,
    };
  document
    .querySelectorAll("#indicators .metric:not([data-fixed-basis])")
    .forEach((row) => {
      const label = row
          .querySelector("span")
          ?.childNodes[0]?.textContent?.trim(),
        dot = row.querySelector(".help-dot");
      if (dot && tips[label]) dot.dataset.tip = tips[label];
    });
}
function annotateRangeExtremaTooltip() {
  const tip = $("chartTooltip"),
    d = visibleCandles();
  if (!tip || hoverIndex === null || d.length < 2) return;
  const { hiI: highIndex, loI: lowIndex } = rangeExtremeIndices(d),
    kind =
      hoverIndex === highIndex
        ? "high"
        : hoverIndex === lowIndex
          ? "low"
          : null;
  tip.querySelector(".range-extrema-tooltip-note")?.remove();
  if (!kind) return;
  const label =
    kind === "high"
      ? tx("此为当前查看范围内最高价", "Highest price in this range")
      : tx("此为当前查看范围内最低价", "Lowest price in this range");
  tip.insertAdjacentHTML(
    "afterbegin",
    `<div class="range-extrema-tooltip-note ${kind}">${label}</div>`,
  );
}
setTimeout(
  () => $("chart")?.addEventListener("mousemove", annotateRangeExtremaTooltip),
  0,
);

function renderSignalProjection() {
  const signal = $("signal"),
    reason = $("signalReason"),
    m = state.candles.length ? metrics(state.candles) : null;
  if (!signal || !reason || !m) return;
  let box = $("signalProjection");
  if (!box) {
    box = document.createElement("section");
    box.id = "signalProjection";
    box.className = "signal-projection";
    reason.after(box);
  }
  const long = m.score >= 0,
    strength = Math.abs(m.score),
    last = state.ticker?.last || m.close,
    move = m.atr * (1.05 + Math.min(1.25, strength / 100)),
    target = last + (long ? move : -move),
    duration =
      strength >= 75
        ? tx("约 45–90 分钟", "about 45–90 min")
        : strength >= 50
          ? tx("约 20–60 分钟", "about 20–60 min")
          : tx("约 10–30 分钟", "about 10–30 min"),
    cls = long ? "bull" : "bear";
  box.className = `signal-projection ${cls}`;
  box.innerHTML = `<span>${tx("方向研究估算", "Directional research estimate")}</span><div><b>${long ? tx("做多", "Long") : tx("做空", "Short")}</b><em>${tx("预计持续", "Estimated duration")} ${duration}</em><strong>${tx("预计目标价", "Estimated target")} ${money(target)}</strong></div><small>${tx("按当前 ATR 波动与规则信号强度推算；目标不保证到达。", "Derived from current ATR volatility and rule-signal strength; the target is not guaranteed.")}</small>`;
}
setTimeout(() => {
  renderSignalProjection = function () {
    const signal = $("signal"),
      reason = $("signalReason");
    if (!signal || !reason) return;
    /* Use the same data source as the rule signal so the directional estimate
       does not jitter on every chart-period/ticker tick. Fallback only if rule
       candles are not ready yet. */
    const source = fixedRuleSignal.candles.length >= RULE_SIGNAL_MIN_CANDLES
      ? fixedRuleSignal.candles
      : state.candles.length
        ? state.candles
        : null;
    if (!source) return;
    const m = metrics(source, state.ticker?.last);
    if (!m) return;
    const [label, cls] = classification(m.score);
    const flat = cls === "flat";
    const long = cls === "bull";
    const strength = Math.abs(m.score);
    const last = state.ticker?.last || m.close;
    const move = m.atr * (1.05 + Math.min(1.25, strength / 100));
    const target = flat
      ? last
      : last + (long ? move : -move);
    const intervalMin =
      {
        "1m": 1,
        "5m": 5,
        "15m": 15,
        "30m": 30,
        "1h": 60,
        "2h": 120,
        "4h": 240,
        "1d": 1440,
      }[fixedRuleSignal.interval] || 5;
    const duration = flat
      ? tx("—", "—")
      : strength >= 75
        ? tx(`约 ${Math.round(45 / intervalMin)}–${Math.round(90 / intervalMin)} 根 K 线`, `about ${Math.round(45 / intervalMin)}–${Math.round(90 / intervalMin)} candles`)
        : strength >= 50
          ? tx(`约 ${Math.round(20 / intervalMin)}–${Math.round(60 / intervalMin)} 根 K 线`, `about ${Math.round(20 / intervalMin)}–${Math.round(60 / intervalMin)} candles`)
          : tx(`约 ${Math.round(10 / intervalMin)}–${Math.round(30 / intervalMin)} 根 K 线`, `about ${Math.round(10 / intervalMin)}–${Math.round(30 / intervalMin)} candles`);
    const tip = flat
      ? tx(
          "当前规则信号处于观望区间，方向研究估算暂时不给出目标价；等待多周期确认后再更新。",
          "The rule signal is neutral right now, so no directional target is estimated; it will update once the multi-timeframe confirmation aligns.",
        )
      : long
        ? tx(
            "预计目标价表示：按当前“做多”方向与上方预计持续时长，推测价格可能上涨到的研究目标位；不是保证到达或成交的价格。",
            "Estimated target: a research level the price may rise to during the projected long duration; not a guaranteed fill or outcome.",
          )
        : tx(
            "预计目标价表示：按当前“做空”方向与上方预计持续时长，推测价格可能下跌到的研究目标位；不是保证到达或成交的价格。",
            "Estimated target: a research level the price may fall to during the projected short duration; not a guaranteed fill or outcome.",
          );
    const dirText = flat
      ? tx("观望", "Neutral")
      : long
        ? tx("做多", "Long")
        : tx("做空", "Short");
    const basisText = fixedRuleSignal.candles.length >= RULE_SIGNAL_MIN_CANDLES
      ? tx(`基于 ${fixedRuleSignal.interval} 已收盘 K 线`, `Based on closed ${txInterval(fixedRuleSignal.interval)} candles`)
      : tx("基于当前图表周期", "Based on current chart interval");
    let box = $("signalProjection");
    if (!box) {
      box = document.createElement("section");
      box.id = "signalProjection";
      box.className = "signal-projection";
      reason.after(box);
    }
    box.className = `signal-projection ${cls}`;
    box.innerHTML = `<span>${tx("方向研究估算", "Directional research estimate")}<small> · ${basisText}</small></span><div><b>${dirText}</b><em>${tx("预计持续", "Estimated duration")} ${duration}</em><strong>${flat ? tx("目标价待方向确认后更新", "Target pending confirmation") : `${tx("预计目标价", "Estimated target")} ${money(target)}`} <button class="help-dot" type="button" data-tip="${tip}" aria-label="${tx("预计目标价说明", "Target price explanation")}">!</button></strong></div><small>${tx("按当前 ATR 波动与规则信号强度推算；目标不保证到达。", "Derived from current ATR volatility and rule-signal strength; the target is not guaranteed.")}</small>`;
  };
  if (state.candles.length) renderAnalysis();
}, 0);
/* Keep the target-price help control at the end of its sentence after each render. */
function placeTargetHelp() {
  /* Find the optional explanatory control created by the projection panel. */
  const help = document.querySelector("#signalProjection .help-dot");
  /* The panel may not exist until enough market data has loaded. */
  if (!help) return;
  /* Moving an existing node preserves its click handler and tooltip metadata. */
  help.parentElement.append(help);
}

setTimeout(() => {
  state.panOffset = 0;
  const toolbar = document.querySelector(".toolbar");
  if (!toolbar || $("panTools")) return;
  const pan = document.createElement("div");
  pan.id = "panTools";
  pan.className = "pan-tools";
  pan.innerHTML = `<button type="button" data-pan="back" title="查看更早数据">←</button><span id="panLabel"><i>${tx("横向移动", "Pan chart")}</i><small>${tx("按住 ⌘ / Ctrl + 滚轮", "Hold ⌘ / Ctrl + scroll")}</small></span><button type="button" data-pan="forward" title="回到较新数据">→</button>`;
  toolbar.append(pan);
  updatePanControls = () => {
    const d = state.frozenCandles || state.candles,
      n = state.viewPoints
        ? Math.max(2, Math.ceil(state.viewPoints / state.zoom))
        : Math.max(30, Math.ceil(d.length / state.zoom)),
      max = Math.max(0, d.length - n),
      offset = state.panOffset || 0,
      panLabel = $("panLabel");
    panLabel?.querySelector("i") &&
      (panLabel.querySelector("i").textContent = tx("横向移动", "Pan chart"));
    panLabel?.querySelector("small") &&
      (panLabel.querySelector("small").textContent = tx(
        "按住 ⌘ / Ctrl + 滚轮",
        "Hold ⌘ / Ctrl + scroll",
      ));
    pan.querySelector('[data-pan="back"]').disabled = offset >= max;
    pan.querySelector('[data-pan="forward"]').disabled = !offset;
  };
  pan.onclick = (event) => {
    const dir = event.target.dataset.pan;
    if (!dir) return;
    const d = state.frozenCandles || state.candles,
      n = state.viewPoints
        ? Math.max(2, Math.ceil(state.viewPoints / state.zoom))
        : Math.max(30, Math.ceil(d.length / state.zoom)),
      step = Math.max(1, Math.round(n * 0.25)),
      max = Math.max(0, d.length - n);
    state.panOffset = Math.max(
      0,
      Math.min(max, (state.panOffset || 0) + (dir === "back" ? step : -step)),
    );
    hoverIndex = null;
    clearChartSelection();
    draw();
    updatePanControls();
  };
  updatePanControls();
}, 0);
setTimeout(
  () =>
    $("ranges")?.addEventListener("click", (event) => {
      if (!event.target.closest("[data-view]")) return;
      state.zoom = 1;
      state.panOffset = 0;
      const label = $("zoomLabel");
      if (label) label.textContent = "100%";
    }),
  0,
);

/* Range extrema read the price the chart actually plots: wick high/low on a
   candle chart, closes on a close-line chart.  Wick extremes are conserved when
   candles are aggregated, so the same price window reports one extreme no
   matter which candle interval is on screen. */
renderRangeExtremaPoints = function () {
  /* 用户要求隐藏「1D最低价 …」浮动小条：悬浮卡片的提示行与大字极值
     已覆盖同一信息，保留会造成重复。悬浮判定与卡片渲染不依赖这两个元素。 */
  $("rangeHighPoint")?.remove();
  $("rangeLowPoint")?.remove();
};
function drawCloseExtrema() {
  const cv = $("chart"),
    rect = cv?.getBoundingClientRect(),
    d = visibleCandles();
  if (!cv || !rect || !d.length) return;
  const dpr = devicePixelRatio || 1,
    w = rect.width,
    h = rect.height;
  const nextW = Math.round(w * dpr), nextH = Math.round(h * dpr);
  if (cv.width !== nextW) cv.width = nextW;
  if (cv.height !== nextH) cv.height = nextH;
  const c = cv.getContext("2d"),
    P = { l: 18, r: 74, t: 15, b: 30 },
    cw = w - P.l - P.r,
    ch = h - P.t - P.b,
    closes = d.map((v) => v.close),
    ma20 = ema(closes, 20),
    ma50 = ema(closes, 50),
    ma200 = ema(closes, 200),
    all = d.flatMap((v) => [v.low, v.high]);
  [ma20, ma50, ma200].forEach((a) =>
    a.forEach((v) => {
      if (Number.isFinite(v)) all.push(v);
    }),
  );
  let lo = minOf(all),
    hi = maxOf(all),
    margin = (hi - lo || 1) * 0.075;
  lo -= margin;
  hi += margin;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const x = (i) => P.l + (i / (d.length - 1)) * cw,
    y = (v) => P.t + ch - ((v - lo) / (hi - lo)) * ch;
  c.font = "11px system-ui";
  c.lineWidth = 1;
  c.strokeStyle = "rgba(144,169,199,.14)";
  c.fillStyle = "#75849a";
  // Y 轴价格标签：右对齐到右侧留白边界内，避免长数字（如 80019.01）起点侵入图表绘制区
  // Right-align Y-axis labels inside the right padding so long price strings (e.g. 80019.01) don't bleed into the chart area.
  c.textAlign = "right";
  for (let g = 0; g < 5; g++) {
    const yy = P.t + (g * ch) / 4;
    c.beginPath();
    c.moveTo(P.l, yy);
    c.lineTo(P.l + cw, yy);
    c.stroke();
    c.fillText((hi - ((hi - lo) * g) / 4).toFixed(2), w - 6, yy + 4);
  }
  c.textAlign = "start";
  const grad = c.createLinearGradient(0, P.t, 0, P.t + ch);
  grad.addColorStop(0, "rgba(0,212,170,.22)");
  grad.addColorStop(1, "rgba(0,212,170,0)");
  c.beginPath();
  d.forEach((v, i) =>
    i ? c.lineTo(x(i), y(v.close)) : c.moveTo(x(i), y(v.close)),
  );
  c.lineTo(x(d.length - 1), P.t + ch);
  c.lineTo(x(0), P.t + ch);
  c.closePath();
  c.fillStyle = grad;
  c.fill();
  const line = (a, color) => {
    c.beginPath();
    let started = false;
    a.forEach((v, i) => {
      if (!Number.isFinite(v)) {
        started = false;
        return;
      }
      if (started) c.lineTo(x(i), y(v));
      else {
        c.moveTo(x(i), y(v));
        started = true;
      }
    });
    c.strokeStyle = color;
    c.lineWidth = 1.3;
    c.stroke();
  };
  line(ma20, "#4b9fff");
  line(ma50, "#d69b2d");
  line(ma200, "#a970ff");
  c.beginPath();
  d.forEach((v, i) =>
    i ? c.lineTo(x(i), y(v.close)) : c.moveTo(x(i), y(v.close)),
  );
  c.strokeStyle = "#00d4aa";
  c.lineWidth = 2;
  c.stroke();
  const { hiI, loI } = rangeExtremeIndices(d),
    mark = (i, value, label, color, above) => {
      const xx = x(i),
        yy = y(value);
      c.save();
      c.strokeStyle = color + "99";
      c.setLineDash([4, 4]);
      c.beginPath();
      c.moveTo(P.l, yy);
      c.lineTo(P.l + cw, yy);
      c.stroke();
      c.setLineDash([]);
      c.fillStyle = color;
      c.font = "600 11px system-ui";
      c.textAlign = xx > w - 205 ? "right" : "left";
      c.fillText(
        `${label} ${money(value)}`,
        xx + (xx > w - 205 ? -8 : 8),
        yy + (above ? -9 : 16),
      );
      c.fillStyle = "#15202d";
      c.strokeStyle = color;
      c.lineWidth = 2;
      c.beginPath();
      c.arc(xx, yy, 5, 0, Math.PI * 2);
      c.fill();
      c.stroke();
      c.fillStyle = color;
      c.beginPath();
      c.arc(xx, yy, 2, 0, Math.PI * 2);
      c.fill();
      c.restore();
    };
  mark(
    hiI,
    rangeExtremeValue(d[hiI], "high"),
    tx("最高价", "Highest price"),
    "#ffcb65",
    true,
  );
  mark(
    loI,
    rangeExtremeValue(d[loI], "low"),
    tx("最低价", "Lowest price"),
    "#52d5f4",
    false,
  );
  for (let g = 0; g < 5; g++) {
    const i = Math.round((g * (d.length - 1)) / 4);
    c.fillStyle = "#75849a";
    c.textAlign = "center";
    c.fillText(time(d[i].time), x(i), h - 8);
  }
  if (chartSelection) {
    const a = Math.min(chartSelection.start, chartSelection.end),
      b = Math.max(chartSelection.start, chartSelection.end);
    c.fillStyle = "rgba(75,159,255,.13)";
    c.fillRect(x(a), P.t, x(b) - x(a), ch);
    c.strokeStyle = "rgba(135,190,255,.9)";
    c.setLineDash([4, 4]);
    c.strokeRect(x(a), P.t, x(b) - x(a), ch);
    c.setLineDash([]);
  }
  if (hoverIndex !== null) {
    const v = d[hoverIndex],
      xx = x(hoverIndex),
      yy = y(v.close);
    c.save();
    c.strokeStyle = "rgba(222,237,255,.42)";
    c.setLineDash([3, 4]);
    c.beginPath();
    c.moveTo(xx, P.t);
    c.lineTo(xx, P.t + ch);
    c.moveTo(P.l, yy);
    c.lineTo(P.l + cw, yy);
    c.stroke();
    c.setLineDash([]);
    c.fillStyle = "#fff";
    c.beginPath();
    c.arc(xx, yy, 3.5, 0, Math.PI * 2);
    c.fill();
    c.restore();
  }
  renderRangeExtremaPoints();
}

if (state.candles.length) drawCloseExtrema();

/* 按仓位计算的爆仓模型：使用用户输入的 USDT 名义金额，结果仅作研究参考。
   Position-sized liquidation model. It uses the entered USDT notional and
   margin (then derives BTC quantity), instead of assuming a one-BTC position. */
// The latest calculator owns the form; legacy startup only ensures the card exists.
// 最新计算器管理表单；旧启动逻辑仅确保卡片已创建。
function setupLiqProbabilityCalculator() {
  ensureLiqProbabilityCard();
  loadLiqProbabilityHistory();
}
calcLiqProbability = function () {
  const form = $("liqProbabilityForm"),
    out = $("liqProbabilityOutput");
  if (!form || !out) return;
  const p = liqProbState,
    entry = +p.entry || state.ticker?.last || 0,
    amount = Math.max(0, +p.amount || 0),
    margin = Math.max(
      0.01,
      +p.margin || amount / Math.max(1, +p.leverage || 1),
    ),
    lev = amount / margin,
    side = p.side === "short" ? -1 : 1,
    mmr = { binance: 0.004, okx: 0.005, coinbase: 0.006 }[p.exchange] || 0.005,
    fee =
      { binance: 0.0005, okx: 0.0005, coinbase: 0.0006 }[p.exchange] || 0.0005,
    btc = entry ? amount / entry : 0,
    maintenance = amount * mmr,
    liq = btc
      ? side > 0
        ? entry + (maintenance - margin) / btc
        : entry + (margin - maintenance) / btc
      : 0,
    live = state.ticker?.last || entry,
    d = state.candles.slice(-Math.min(120, state.candles.length)),
    window = Math.min(20, Math.max(5, Math.floor(d.length / 4)));
  let hits = 0,
    total = 0;
  for (let i = 0; i + window <= d.length; i++) {
    const start = d[i].close,
      extreme =
        side > 0
          ? minOf(d.slice(i, i + window).map((x) => x.low))
          : maxOf(d.slice(i, i + window).map((x) => x.high)),
      adverse =
        side > 0 ? (start - extreme) / start : (extreme - start) / start;
    hits += adverse >= Math.abs(liq - start) / start ? 1 : 0;
    total++;
  }
  const nearby =
      side > 0
        ? minOf(d.slice(-Math.min(60, d.length)).map((x) => x.low))
        : maxOf(d.slice(-Math.min(60, d.length)).map((x) => x.high)),
    gap = side > 0 ? nearby - liq : liq - nearby,
    probability = total ? (hits / total) * 100 : 0,
    level =
      gap <= 0 || probability >= 25
        ? "bear"
        : probability >= 10
          ? "flat"
          : "bull",
    extremeLabel =
      side > 0
        ? tx("近 60 根最低价", "Lowest in last 60 candles")
        : tx("近 60 根最高价", "Highest in last 60 candles"),
    gapLabel =
      gap >= 0
        ? tx("局部极值距强平", "Local extreme above liquidation")
        : tx("局部极值已越过强平", "Local extreme crossed liquidation");
  out.innerHTML = `<div><small>${tx("理论强平价", "Theoretical liquidation")}</small><b class="bear">${money(liq)}</b></div><div><small>${tx("实际杠杆 / " + coinLabel() + " 数量", "Effective leverage / " + coinLabel() + " size")}</small><b>${lev.toFixed(2)}× / ${btc.toFixed(6)} ${coinLabel()}</b></div><div><small>${extremeLabel}</small><b class="${side > 0 ? "low" : "high"}">${money(nearby)}</b></div><div><small>${gapLabel}</small><b class="${gap >= 0 ? "bull" : "bear"}">${gap >= 0 ? "+" : "−"}${money(Math.abs(gap))}</b></div><div><small>${tx("历史触及概率", "Historical touch probability")}</small><b class="${level}">${probability.toFixed(2)}%</b></div><div><small>${tx("手续费参考（开+平）", "Fee reference (in + out)")}</small><b>${money(amount * fee * 2)}</b></div><p class="${level}">${tx("以当前价", "Using live price")} ${money(live)} · ${tx("以最近", "Using")} ${total} ${tx("个", "")} ${window}${tx(" 根 K 线窗口，比较每段局部最低/最高价与同一仓位的强平距离；仅作风险研究，不代表真实强平或未来概率。", "-candle windows: compares each local low/high with this position’s liquidation distance. Research only; not actual liquidation or future probability.")}</p>`;
};
setTimeout(setupLiqProbabilityCalculator, 0);

/* Keep the short-horizon model label and colour on the same signal. */
const microPredictionWithConsistentDirection = microPrediction;
microPrediction = function (m) {
  microPredictionWithConsistentDirection(m);
  const closes = state.candles.map((x) => x.close),
    recent = closes.length
      ? closes.at(-1) / closes[Math.max(0, closes.length - 5)] - 1
      : 0,
    trend = m.close ? (m.e20 - m.e50) / m.close : 0,
    bias = recent * 0.38 + trend * 0.62,
    direction = document.querySelector(".micro-direction>b");
  if (direction) {
    const long = bias >= 0;
    direction.textContent = long ? tx("做多", "Long") : tx("做空", "Short");
    direction.className = long ? "bull" : "bear";
  }
};

/* Stable controls, short visible windows, and user position calculator. */
const buttonsRebuild = buttons;
let buttonsSignature = "";
const viewRanges = {
  "1时": { minutes: 60, defaultInterval: "30s" },
  "3时": { minutes: 180, defaultInterval: "1m" },
  "6时": { minutes: 360, defaultInterval: "1m" },
  "12时": { minutes: 720, defaultInterval: "5m" },
  "1D": { minutes: 1440, defaultInterval: "5m" },
  "2D": { minutes: 2880, defaultInterval: "15m" },
  "1W": { minutes: 10080, defaultInterval: "30m" },
  "1M": { minutes: 43200, defaultInterval: "4h" },
  "6M": { minutes: 262800, defaultInterval: "1d" },
  "1Y": { minutes: 525600, defaultInterval: "1d" },
};
// The local market gateway pages OKX history up to this bound. It is large
// enough for the 12-hour and 1-day minute windows without an unbounded fetch.
const MAX_VISIBLE_CANDLES = 1800;
/* 低于这个根数时 K 线图基本无法阅读（一根柱子代表一整个周期），
   范围与周期冲突时按此下限自动换到更合适的周期；RANGE_TARGET_CANDLES 是
   换周期时的目标密度。 */
const MIN_RANGE_CANDLES = 8;
const RANGE_TARGET_CANDLES = 360;
const intervalMinutes = {
  "5s": 5 / 60,
  "10s": 10 / 60,
  "30s": 0.5,
  "1m": 1,
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "2h": 120,
  "4h": 240,
  "1d": 1440,
};
function closeChartControlPopover(popover) {
  popover.classList.remove("is-open");
  popover
    .querySelector(".control-popover-panel")
    ?.classList.remove("is-visible");
  popover
    .querySelector(".control-trigger")
    ?.setAttribute("aria-expanded", "false");
}
document.addEventListener("pointerdown", (event) => {
  if (event.target.closest("#mainChartCard .toolbar .control-popover")) return;
  document
    .querySelectorAll("#mainChartCard .toolbar .control-popover.is-open")
    .forEach(closeChartControlPopover);
});
window.addEventListener("blur", () =>
  document
    .querySelectorAll("#mainChartCard .toolbar .control-popover.is-open")
    .forEach(closeChartControlPopover),
);
if (state.range && !state.rangeRequiredPoints) {
  const initialRange = viewRanges[state.range];
  state.rangeRequiredPoints = initialRange
    ? Math.max(
        2,
        Math.ceil(
          initialRange.minutes / (intervalMinutes[state.interval] || 1),
        ),
      )
    : 0;
}
function applyVisibleRange(label, { useDefaultInterval = true } = {}) {
  const range = viewRanges[label],
    minutes = range?.minutes;
  if (!minutes) return state.interval;
  if (useDefaultInterval && range.defaultInterval)
    state.interval = range.defaultInterval;
  /* 用户选择范围时先应用该范围的默认 K 线周期。用户随后手动改变周期时，
     只在数据量无法覆盖范围或柱数少到不可读时才进行兼容性调整。
     视图一次最多取 MAX_VISIBLE_CANDLES 根 K 线。
     范围与周期冲突时，以「查看范围」为准微调 K 线周期，保证刻度真的覆盖所选跨度：
       ① 周期过细、装不下（「1 分 × 1W」= 10080 根）：放粗到仍能装下整个范围的最细周期，
          否则刻度只会停在最近 30 小时，与「查看范围」标签不符；
       ② 周期过粗、装不满（「1 日 × 6时」= 1 根，K 线图无法阅读）：换到约 360 根的周期，
          否则从「1Y」切回短范围时会留下一根柱子代表一整段。
     手动周期只要不冲突就保持不变（例如「1 分 × 6时」= 360 根）。 */
  const currentPoints = rangePointsFor(minutes, state.interval);
  if (currentPoints > MAX_VISIBLE_CANDLES)
    state.interval = finestIntervalForRange(minutes);
  else if (currentPoints < MIN_RANGE_CANDLES)
    state.interval = balancedIntervalForRange(minutes);
  const requiredPoints = Math.max(2, rangePointsFor(minutes, state.interval)),
    points = Math.min(MAX_VISIBLE_CANDLES, requiredPoints);
  state.range = label;
  state.rangeRequiredPoints = requiredPoints;
  state.viewPoints = points;
  state.limit = Math.max(300, points);
  localStorage.setItem("btc_visible_range", label);
  return state.interval;
}
/* 某个周期在给定跨度下会画出多少根 K 线。 */
function rangePointsFor(minutes, interval) {
  return Math.ceil(minutes / (intervalMinutes[interval] || 1));
}
/* 仍能把整个范围装进 MAX_VISIBLE_CANDLES 根以内的最细周期（intervals 由细到粗排列）。 */
function finestIntervalForRange(minutes) {
  for (const [value] of intervals) {
    if (!intervalMinutes[value]) continue;
    if (rangePointsFor(minutes, value) <= MAX_VISIBLE_CANDLES) return value;
  }
  return intervals.at(-1)?.[0] || state.interval;
}
/* 根数最接近 RANGE_TARGET_CANDLES 的周期，用于把「一根柱子代表一整段」的过粗组合拉回可读范围。 */
function balancedIntervalForRange(minutes) {
  let best = null,
    bestScore = Infinity;
  for (const [value] of intervals) {
    if (!intervalMinutes[value]) continue;
    const count = rangePointsFor(minutes, value);
    if (count > MAX_VISIBLE_CANDLES) continue;
    const score = Math.abs(Math.log(count / RANGE_TARGET_CANDLES));
    if (score < bestScore) {
      bestScore = score;
      best = value;
    }
  }
  return best || finestIntervalForRange(minutes);
}
const savedVisibleRange = localStorage.getItem("btc_visible_range");
if (viewRanges[savedVisibleRange]) applyVisibleRange(savedVisibleRange);
buttons = function () {
  const key = `${uiLang}:${state.interval}:${state.limit}:${state.range || ""}:${state.viewPoints || ""}`,
    intervalBox = $("intervals"),
    rangeBox = $("ranges"),
    viewText = (label) =>
      uiLang === "zh"
        ? label
        : { "15分": "15m", "1时": "1h", "3时": "3h", "6时": "6h", "12时": "12h" }[label] ||
          label;
  if (key === buttonsSignature) return;
  buttonsSignature = key;
  // Keep the control labels (and their help dots) in place while only the
  // selected state changes. Replacing their innerHTML made the help dots blink.
  if (intervalBox.dataset.lang !== uiLang) {
    intervalBox.dataset.lang = uiLang;
    intervalBox.innerHTML =
      `<div class="control-popover interval-picker"><button class="control-trigger" type="button" aria-haspopup="true"><span class="control-label">${tx("K 线周期", "Candle interval")}</span><b data-current-interval></b><i aria-hidden="true">▾</i></button><div class="control-popover-panel"><div class="interval-wheel" role="group" aria-label="${tx("K 线周期，可左右滑动选择", "Candle interval, scroll horizontally to choose")}">` +
      intervals
        .map(
          ([v, n, en]) =>
            `<button data-candle="${v}">${uiLang === "zh" ? n : en || v}</button>`,
        )
        .join("") +
      "</div></div></div>";
    const intervalPopover = intervalBox.querySelector(".control-popover"),
      intervalTrigger = intervalPopover?.querySelector(".control-trigger");
    intervalTrigger?.setAttribute("aria-expanded", "false");
    intervalTrigger?.addEventListener("click", () => {
      const open = intervalPopover.classList.toggle("is-open");
      intervalTrigger.setAttribute("aria-expanded", String(open));
    });
    intervalBox.querySelectorAll("[data-candle]").forEach(
      (b) =>
        (b.onclick = () => {
          state.interval = b.dataset.candle;
          const rangeMinutes = viewRanges[state.range]?.minutes;
          if (
            rangeMinutes &&
            Math.ceil(rangeMinutes / (intervalMinutes[state.interval] || 1)) >
              MAX_VISIBLE_CANDLES
          ) {
            /* 用户主动选了更细的周期：此时周期优先，把「查看范围」退回自定义，
               只显示能取到的最近 MAX_VISIBLE_CANDLES 根，避免范围标签与实际刻度不符。 */
            state.range = null;
            state.rangeRequiredPoints = 0;
            state.viewPoints = MAX_VISIBLE_CANDLES;
            state.limit = Math.max(300, MAX_VISIBLE_CANDLES);
            localStorage.removeItem("btc_visible_range");
          } else if (state.range) {
            applyVisibleRange(state.range, { useDefaultInterval: false });
          } else {
            state.limit = Math.max(300, state.limit || 300);
          }
          buttonsSignature = "";
          closeChartControlPopover(intervalPopover);
          loadCurrent();
        }),
    );
    const wheel = intervalBox.querySelector(".interval-wheel");
    wheel?.addEventListener("wheel", (event) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      wheel.scrollBy({ left: event.deltaY, behavior: "smooth" });
    }, { passive: false });
  }
  if (rangeBox.dataset.lang !== uiLang) {
    rangeBox.dataset.lang = uiLang;
    rangeBox.innerHTML =
      `<div class="control-popover range-picker"><button class="control-trigger" type="button" aria-haspopup="listbox" aria-expanded="false" aria-controls="rangePopoverOptions"><span class="control-label">${tx("查看范围", "Visible range")}</span><b data-current-range></b><i aria-hidden="true">▾</i></button><div id="rangePopoverOptions" class="control-popover-panel range-options" role="listbox" aria-label="${tx("查看范围", "Visible range")}">${Object.keys(viewRanges)
        .map(
          (label) =>
            `<button type="button" data-view="${label}" role="option" aria-selected="${state.range === label}">${viewText(label)}</button>`,
        )
        .join("")}</div></div>`;
    const rangePopover = rangeBox.querySelector(".control-popover");
    const rangeTrigger = rangePopover.querySelector(".control-trigger");
    const closeRangePopover = () => closeChartControlPopover(rangePopover);
    const openRangePopover = () => {
      if (rangePopover.classList.contains("is-open")) return closeRangePopover();
      const list = rangePopover.querySelector(".control-popover-panel");
      list.querySelectorAll("[data-view]").forEach((chip) =>
        chip.classList.toggle("active", state.range === chip.dataset.view),
      );
      rangePopover.classList.add("is-open");
      rangeTrigger.setAttribute("aria-expanded", "true");
      requestAnimationFrame(() => list.classList.add("is-visible"));
    };
    rangeTrigger.addEventListener("click", openRangePopover);
    rangePopover.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRangePopover();
        rangeTrigger.focus();
        return;
      }
      if (!/^Arrow(Left|Right|Up|Down)$/.test(event.key)) return;
      const chips = [...rangePopover.querySelectorAll("[data-view]")];
      if (!chips.length) return;
      event.preventDefault();
      const step = /Right|Down/.test(event.key) ? 1 : -1;
      const current = chips.indexOf(document.activeElement);
      chips[(current + step + chips.length) % chips.length].focus();
    });
    rangeBox.addEventListener("click", (event) => {
      const chip = event.target.closest("[data-view]");
      if (!chip) return;
      const label = chip.dataset.view;
      applyVisibleRange(label);
      rangeTrigger.querySelector("[data-current-range]").textContent = viewText(label);
      rangePopover.querySelectorAll("[data-view]").forEach((item) => {
        const selected = item.dataset.view === label;
        item.classList.toggle("active", selected);
        item.setAttribute("aria-selected", String(selected));
      });
      // Start the request from the newly selected state immediately. Delaying
      // it until the popover animation completed allowed an earlier request
      // to win and leave the caption describing the previous range.
      buttonsSignature = "";
      void loadCurrent();
      window.setTimeout(() => {
        closeRangePopover();
      }, 200);
    });
  }
  const currentInterval = intervals.find(([value]) => value === state.interval);
  intervalBox.querySelector("[data-current-interval]").textContent = uiLang === "zh"
    ? currentInterval?.[1] || state.interval
    : currentInterval?.[2] || state.interval;
  rangeBox.querySelector("[data-current-range]").textContent = state.range
    ? viewText(state.range)
    : tx("自定义", "Custom");
  intervalBox
    .querySelectorAll("[data-candle]")
    .forEach((b) =>
      b.classList.toggle("active", state.interval === b.dataset.candle),
    );
  rangeBox
    .querySelectorAll("[data-view]")
    .forEach((b) =>
      b.classList.toggle("active", state.range === b.dataset.view),
    );
};

/* 多币种（v2.12.5）：持仓表单状态按币种独立存储（BTC 沿用旧键 btc_position_state），
   其余币种用 btc_position_state_<COIN>；从未填过的币种用默认模板，不再共用 BTC 的数值。 */
const POSITION_STATE_DEFAULT =
  '{"side":"long","exchange":"binance","amount":1000,"margin":100,"entry":0,"mark":0}';
const positionStateStorageKey = () =>
  "btc_position_state" + coinStorageSuffix();
function loadPositionStateFromStorage() {
  try {
    return JSON.parse(
      localStorage.getItem(positionStateStorageKey()) || POSITION_STATE_DEFAULT,
    );
  } catch {
    return JSON.parse(POSITION_STATE_DEFAULT);
  }
}
let positionState = loadPositionStateFromStorage();
const persistPositionState = () => {
  try {
    localStorage.setItem(positionStateStorageKey(), JSON.stringify(positionState));
  } catch {}
};
window.addEventListener("btc:coin-changed", () => {
  positionState = loadPositionStateFromStorage();
  syncPositionForm();
});
function positionCalc() {
  const p = positionState,
    amount = Math.max(0, +p.amount || 0),
    margin = Math.max(0.01, +p.margin || 0),
    entry = +p.entry || state.ticker?.last || 0,
    mark = +p.mark || state.ticker?.last || 0,
    side = p.side === "short" ? -1 : 1,
    lev = amount / margin,
    fees =
      { binance: 0.0005, okx: 0.0005, coinbase: 0.0006 }[p.exchange] || 0.0005,
    mmr = { binance: 0.004, okx: 0.005, coinbase: 0.006 }[p.exchange] || 0.005,
    gross = entry ? (side * amount * (mark - entry)) / entry : 0,
    fee = amount * fees * 2,
    net = gross - fee,
    liq = side > 0 ? entry * (1 - 1 / lev + mmr) : entry * (1 + 1 / lev - mmr);
  return { amount, margin, entry, mark, lev, fees, gross, fee, net, liq, side };
}
function renderPosition() {
  const out = $("positionOutput");
  if (!out) return;
  const x = positionCalc(),
    cls = x.net >= 0 ? "bull" : "bear";
  out.innerHTML = `<div><small>${tx("杠杆倍率", "Leverage")}</small><b>${x.lev.toFixed(2)}×</b></div><div><small>${tx("未扣费收益", "Gross PnL")}</small><b class="${x.gross >= 0 ? "bull" : "bear"}">${x.gross >= 0 ? "+" : "−"}${money(Math.abs(x.gross))}</b></div><div><small>${tx("估算双边手续费", "Estimated round-trip fee")}</small><b>${money(x.fee)}</b></div><div><small>${tx("预计净收益", "Estimated net PnL")}</small><b class="${cls}">${x.net >= 0 ? "+" : "−"}${money(Math.abs(x.net))}</b></div><div><small>${tx("理论强平价", "Theoretical liquidation")}</small><b class="bear">${money(x.liq)}</b></div>`;
  const marker = $("entryMarker");
  /* Keep the chart marker hidden until the user explicitly confirms this position. */
  if (marker) marker.hidden = !positionState.confirmed;
  if (
    marker &&
    positionState.confirmed &&
    state.candles.length &&
    Number.isFinite(x.entry)
  ) {
    const d = visibleCandles(),
      lo = minOf(d.map((v) => v.low)),
      hi = maxOf(d.map((v) => v.high)),
      pad = (hi - lo || 1) * 0.075,
      y = Math.max(
        2,
        Math.min(
          96,
          100 - ((x.entry - (lo - pad)) / (hi - lo + pad * 2)) * 100,
        ),
      );
    marker.hidden = false;
    marker.style.top = `${y}%`;
    marker.textContent = `${x.side > 0 ? tx("做多", "Long") : tx("做空", "Short")} ${x.lev.toFixed(2)}× · ${tx("开仓", "Entry")} ${money(x.entry)}`;
  }
}
function syncPositionForm() {
  const form = $("positionForm");
  if (!form) return;
  Object.entries(positionState).forEach(([k, v]) => {
    const el = form.elements[k];
    if (el && document.activeElement !== el) el.value = v;
  });
  renderPosition();
}
(() => {
  const main = document.querySelector("main"),
    anchor = document.querySelector(".leverage-details"),
    card = document.createElement("section");
  card.className = "card position-card";
  card.innerHTML = `<div class="position-head"><div><h2>${tx("我的持仓与盈亏估算", "My position & PnL estimate")}</h2><p>${tx("研究估算；强平、费率及资金费以交易所最终规则为准。", "Research estimate; exchange rules determine final liquidation, fees and funding.")}</p></div><button type="button" id="syncMark">${tx("同步实时标记价", "Sync live mark")}</button></div><form id="positionForm" class="position-form"><label>${tx("方向", "Side")}<select name="side"><option value="long">${tx("做多", "Long")}</option><option value="short">${tx("做空", "Short")}</option></select></label><label>${tx("交易所", "Exchange")}<select name="exchange"><option value="binance">Binance</option><option value="okx">OKX</option><option value="coinbase">Coinbase</option></select></label><label>${tx("持仓量（USDT）", "Position (USDT)")}<input name="amount" type="number" min="0" step="0.01"></label><label>${tx("保证金（USDT）", "Margin (USDT)")}<input name="margin" type="number" min="0.01" step="0.01"></label><label>${tx("开仓均价", "Average entry")}<input name="entry" type="number" min="0" step="0.01"></label><label>${tx("标记价格", "Mark price")}<input name="mark" type="number" min="0" step="0.01"></label></form><div id="positionOutput" class="position-output"></div>`;
  anchor?.after(card);
  const box = $("chart")?.closest(".chart-box");
  if (box)
    box.insertAdjacentHTML("beforeend", '<div id="entryMarker" hidden></div>');
  const form = $("positionForm");
  form.oninput = () => {
    for (const el of form.elements)
      if (el.name) positionState[el.name] = el.value;
    persistPositionState();
    renderPosition();
  };
  $("syncMark").onclick = () => {
    positionState.mark = state.ticker?.last || 0;
    if (!positionState.entry) positionState.entry = positionState.mark;
    persistPositionState();
    syncPositionForm();
  };
  setTimeout(syncPositionForm, 0);
})();
/* Keep the position form initialized from the first available quote. */
addDecisionRenderEnhancer("position-state", () => {
  if (!positionState.entry && state.ticker)
    positionState.entry = state.ticker.last;
  if (!positionState.mark && state.ticker)
    positionState.mark = state.ticker.last;
  syncPositionForm();
});

const exchangeStripWithSource = loadExchangeStrip;
loadExchangeStrip = async function () {
  await exchangeStripWithSource();
  document.querySelectorAll(".exchange-row").forEach((row) => {
    if (!row.querySelector(".source-note")) {
      const source = row.querySelector("b")?.textContent.toLowerCase() || "--";
      row.insertAdjacentHTML(
        "beforeend",
        `<small class="source-note">${tx("来源", "Source")}：${source}</small>`,
      );
    }
  });
};
whenIdle(() => loadExchangeStrip());

(() => {
  const chartBox = $("chart")?.closest(".chart-box");
  if (!chartBox) return;
  const html =
    `<span class="candle-series" data-legend-series="candles">${tx("K线图", "Candlestick")}</span>` +
    `<span class="price-line" data-legend-series="close">${tx("价格", "Price")}</span>` +
    '<span class="ma20-line" data-legend-line="ma20">MA20</span>' +
    '<span class="ma50-line" data-legend-line="ma50">MA50</span>' +
    '<span class="ma200-line" data-legend-line="ma200">MA200</span>' +
    `<span class="boll-line" data-legend-line="boll">${tx("布林带", "Bollinger")}</span>` +
    '<span class="vwap-line" data-legend-line="vwap">VWAP</span>' +
    `<span class="volume-line" data-legend-series="volume">${tx("成交量", "Volume")}</span>` +
    '<span class="rsi-line" data-legend-sub="rsi">RSI(14)</span>';
  let legend = $("chartLegend");
  if (!legend) {
    legend = document.createElement("div");
    legend.id = "chartLegend";
  }
  legend.innerHTML = html;
  const strip = $("chartLegendStrip");
  if (strip) strip.append(legend);
  else chartBox.after(legend);
  updateTopLegend();
})();
document.querySelectorAll(".exchange-row>b").forEach((el) => el.remove());
const loadExchangeWithoutName = loadExchangeStrip;
loadExchangeStrip = async function () {
  await loadExchangeWithoutName();
  document.querySelectorAll(".exchange-row>b").forEach((el) => el.remove());
};

if (!positionState.leverage) positionState.leverage = 10;
const positionCalcWithSelectedLeverage = positionCalc;
positionCalc = function () {
  const x = positionCalcWithSelectedLeverage(),
    lev = Math.max(1, +positionState.leverage || x.lev),
    mmr =
      { binance: 0.004, okx: 0.005, coinbase: 0.006 }[positionState.exchange] ||
      0.005;
  x.lev = lev;
  x.liq =
    x.side > 0 ? x.entry * (1 - 1 / lev + mmr) : x.entry * (1 + 1 / lev - mmr);
  return x;
};
(() => {
  const form = $("positionForm");
  if (!form || form.elements.leverage) return;
  const label = document.createElement("label");
  label.innerHTML = `${tx("杠杆倍率", "Leverage")}<select name="leverage">${[1, 2, 3, 5, 10, 20, 30, 50, 100].map((v) => `<option value="${v}">${v}×</option>`).join("")}</select>`;
  form.querySelector("label:nth-child(3)")?.before(label);
  form.elements.leverage.value = positionState.leverage;
  /* 这里原先派发 input 事件，会把当时还空着的表单字段回写进 positionState，
     刷新一次就清空用户填好的持仓量 / 保证金 / 开仓均价 / 标记价格。
     改为从状态同步到表单后直接重绘，既不丢数据，也不会误清 confirmed。 */
  for (const key of ["exchange", "side", "amount", "margin", "entry", "mark"])
    if (form.elements[key]) form.elements[key].value = positionState[key] ?? "";
  renderPosition();
})();

if (typeof positionState.confirmed !== "boolean")
  positionState.confirmed = false;
(() => {
  const form = $("positionForm"),
    head = document.querySelector(".position-head");
  if (!form || !head) return;
  let confirm = $("confirmPosition");
  if (!confirm) {
    confirm = document.createElement("button");
    confirm.type = "button";
    confirm.id = "confirmPosition";
    confirm.textContent = tx(
      "确认持仓并显示买入点",
      "Confirm & show entry point",
    );
    head.append(confirm);
  }
  /* 按钮改为开关：未确认时「确认持仓并显示买入点」；已确认后变为「隐藏买入点标记」，
     点一下即可清除图表上的开仓标记（原先没有任何取消入口，只能靠改表单字段顺带清除）。 */
  const paintConfirm = () => {
    confirm.textContent = positionState.confirmed
      ? tx("隐藏买入点标记", "Hide entry marker")
      : tx("确认持仓并显示买入点", "Confirm & show entry point");
  };
  const renderPositionWithConfirm = renderPosition;
  renderPosition = function () {
    renderPositionWithConfirm();
    paintConfirm();
  };
  confirm.onclick = () => {
    if (!positionState.confirmed) {
      const entry = +form.elements.entry.value;
      if (!Number.isFinite(entry) || entry <= 0) {
        form.elements.entry.focus();
        return;
      }
      positionState.confirmed = true;
    } else {
      positionState.confirmed = false;
      const marker = $("entryMarker");
      if (marker) marker.hidden = true;
    }
    persistPositionState();
    renderPosition();
  };
  form.addEventListener("input", () => {
    positionState.confirmed = false;
    persistPositionState();
    const marker = $("entryMarker");
    if (marker) marker.hidden = true;
    paintConfirm();
  });
  renderPosition();
})();

function ensureLiqProbabilityCard() {
  let card = $("liqProbabilityCard");
  if (card && card.closest(".micro-forecast")) card.remove();
  if (card) return;
  const anchor =
      document.querySelector(".position-estimate-details") ||
      document.querySelector(".position-card") ||
      document.querySelector(".leverage-card"),
    main = document.querySelector("main");
  card = document.createElement("section");
  card.id = "liqProbabilityCard";
  card.className = "card liq-probability-card";
  card.innerHTML = `<div class="liq-prob-head"><div><h2>${tx("强平概率计算器", "Liquidation probability calculator")}</h2><p>${tx("基于近期历史震荡的研究估算，不是未来真实概率。", "Historical-volatility research estimate, not a future probability.")}</p></div><span>${tx("历史震荡估算", "Historical volatility estimate")}</span></div><form id="liqProbabilityForm" class="liq-prob-form"><label>${tx("交易所", "Exchange")}<select name="exchange"><option value="okx">OKX</option><option value="binance">Binance</option><option value="coinbase">Coinbase</option></select></label><label>${tx("方向", "Side")}<select name="side"><option value="long">${tx("做多", "Long")}</option><option value="short">${tx("做空", "Short")}</option></select></label><label>${tx("购买数量（USDT）", "Purchase amount (USDT)")}<input name="amount" type="number" min="0" step="0.01"></label><label>${tx("杠杆倍率", "Leverage")}<select name="leverage">${[1, 2, 3, 5, 10, 20, 30, 50, 100].map((x) => `<option value="${x}">${x}×</option>`).join("")}</select></label><label>${tx("成本价", "Entry cost")}<input name="entry" type="number" min="0" step="0.01"></label></form><div id="liqProbabilityOutput" class="liq-prob-output"></div>`;
  (anchor || main.lastElementChild).after(card);
  const form = $("liqProbabilityForm");
  Object.entries(liqProbState).forEach(([k, v]) => {
    if (form.elements[k]) form.elements[k].value = v;
  });
  form.oninput = () => {
    for (const el of form.elements)
      if (el.name) liqProbState[el.name] = el.value;
    localStorage.setItem("btc_liq_probability", JSON.stringify(liqProbState));
    calcLiqProbability();
  };
  calcLiqProbability();
}
setTimeout(() => {
  const card = document.querySelector(".position-card");
  if (card && !card.closest("details")) {
    const details = document.createElement("details");
    details.className = "position-details position-estimate-details";
    const summary = document.createElement("summary");
    summary.textContent = tx(
      "我的持仓与盈亏估算",
      "My position & PnL estimate",
    );
    card.before(details);
    details.append(summary, card);
  }
  ensureLiqProbabilityCard();
  const liq = $("liqProbabilityCard");
  if (liq && !liq.closest("details")) {
    const details = document.createElement("details");
    details.className = "liq-probability-details position-details";
    const summary = document.createElement("summary");
    summary.textContent = tx(
      "强平概率计算器",
      "Liquidation probability calculator",
    );
    liq.before(details);
    details.append(summary, liq);
  }
}, 0);
const applyLanguageWithLiqProbabilityFold = applyLanguage;
applyLanguage = function () {
  applyLanguageWithLiqProbabilityFold();
  const summary = document.querySelector(".liq-probability-details summary");
  if (summary)
    summary.textContent = tx(
      "强平概率计算器",
      "Liquidation probability calculator",
    );
};
/* Keep the persistent liquidation-probability card in the same refresh pass. */
addDecisionRenderEnhancer("liquidation-card", () => {
  ensureLiqProbabilityCard();
  calcLiqProbability();
});

function renderRangeExtremaPoints() {
  // 用户要求隐藏最高/最低选中价浮动标签
  $("rangeHighPoint")?.remove();
  $("rangeLowPoint")?.remove();
  return;
  const box = $("chart")?.closest(".chart-box"),
    cv = $("chart"),
    d = visibleCandles();
  if (!box || !cv || d.length < 2) return;
  let high = $("rangeHighPoint"),
    low = $("rangeLowPoint");
  if (!high) {
    high = document.createElement("div");
    high.id = "rangeHighPoint";
    high.className = "range-extreme high";
    box.append(high);
  }
  if (!low) {
    low = document.createElement("div");
    low.id = "rangeLowPoint";
    low.className = "range-extreme low";
    box.append(low);
  }
  const hiI = d.reduce((best, v, i) => (v.high > d[best].high ? i : best), 0),
    loI = d.reduce((best, v, i) => (v.low < d[best].low ? i : best), 0),
    hi = d[hiI].high,
    lo = d[loI].low,
    rect = cv.getBoundingClientRect(),
    P = { l: 18, r: 74, t: 15, b: 30 },
    cw = rect.width - P.l - P.r,
    ch = rect.height - P.t - P.b,
    pad = (hi - lo || 1) * 0.075,
    y = (v) => P.t + ch - ((v - (lo - pad)) / (hi - lo + pad * 2)) * ch,
    x = (i) => P.l + (i / (d.length - 1)) * cw,
    label = txInterval(state.range || state.interval);
  const point = (el, i, value, kind) => {
    el.style.left = `${Math.max(8, Math.min(rect.width - 160, x(i)))}px`;
    el.style.top = `${Math.max(6, Math.min(rect.height - 28, y(value) + (kind === "high" ? -25 : 8)))}px`;
    el.textContent = `${label}${kind === "high" ? tx("最高点", " high") : tx("最低点", " low")} ${money(value)} · ${pointTime(d[i].time)}`;
  };
  point(high, hiI, hi, "high");
  point(low, loI, lo, "low");
}
/* Empirical liquidation-risk calculator: uses 15-minute history and is not an exchange liquidation engine.
   经验强平风险计算器：使用 15 分钟历史数据，不替代交易所实际强平引擎。 */
const liqProbState = JSON.parse(
  localStorage.getItem("btc_liq_probability") ||
    '{"exchange":"okx","side":"long","amount":1000,"leverage":10,"entry":0}',
);
let liqHistoricalCandles = [],
  liqHistoryLoading = false;
function liqTouchStats(candles, side, distance, horizon) {
  let hits = 0,
    total = 0;
  for (let index = 0; index + horizon <= candles.length; index++) {
    const start = candles[index].close,
      segment = candles.slice(index, index + horizon),
      extreme =
        side > 0
          ? minOf(segment.map((candle) => candle.low))
          : maxOf(segment.map((candle) => candle.high)),
      adverse =
        side > 0 ? (start - extreme) / start : (extreme - start) / start;
    hits += adverse >= distance ? 1 : 0;
    total++;
  }
  return { hits, total, probability: total ? (hits / total) * 100 : 0 };
}
function liqRiskKind(probability) {
  return probability >= 25 ? "bear" : probability >= 10 ? "flat" : "bull";
}
// Reassign after legacy render hooks so this calculator remains the active implementation.
// 在旧版渲染钩子之后重新赋值，确保当前计算器实现保持生效。
calcLiqProbability = function () {
  const form = $("liqProbabilityForm"),
    out = $("liqProbabilityOutput");
  if (!form || !out) return;
  const p = liqProbState,
    livePrice = state.ticker?.last || state.candles.at(-1)?.close || 0,
    rawEntry = Number(p.entry),
    requestedEntry = rawEntry >= 10_000 ? rawEntry : livePrice,
    requestedLeverage = Math.min(
      100,
      Math.max(1, Math.round(Number(p.leverage) || 1)),
    );
  const risk = calculatePositionRisk({
    ...p,
    entry: requestedEntry,
    mark: requestedEntry,
    margin: (Number(p.amount) || 0) / requestedLeverage,
  });
  const entry = risk.entry,
    amount = risk.notional,
    lev = risk.leverage,
    side = risk.sign,
    liq = risk.liquidation,
    fee = risk.feeRate,
    distance = Math.abs(liq - entry) / entry,
    history =
      liqHistoricalCandles.length >= 100 ? liqHistoricalCandles : state.candles,
    extreme = history.length
      ? side > 0
        ? minOf(history.map((candle) => candle.low))
        : maxOf(history.map((candle) => candle.high))
      : NaN;
  const horizons = [
      ["12h", 48],
      ["24h", 96],
      ["48h", 192],
      [tx("1 周", "1 week"), 672],
    ].map(([label, window]) => ({
      label,
      window,
      ...liqTouchStats(history, side, distance, window),
    })),
    primary = horizons[0],
    level = liqRiskKind(primary.probability),
    direction = side > 0 ? tx("做多", "Long") : tx("做空", "Short");
  if (
    rawEntry < 10_000 &&
    livePrice &&
    document.activeElement !== form.elements.entry
  ) {
    p.entry = livePrice;
    form.elements.entry.value = livePrice.toFixed(2);
    localStorage.setItem("btc_liq_probability", JSON.stringify(p));
  }
  if (
    String(lev) !== String(p.leverage) &&
    document.activeElement !== form.elements.leverage
  ) {
    p.leverage = lev;
    form.elements.leverage.value = lev;
    localStorage.setItem("btc_liq_probability", JSON.stringify(p));
  }
  const probabilityCards = horizons
    .map(
      (item) =>
        `<div><small>${item.label} ${tx("历史触及概率", "historical touch")}</small><b class="${liqRiskKind(item.probability)}">${item.probability.toFixed(2)}%</b><em>n=${item.total}</em></div>`,
    )
    .join("");
  out.innerHTML = `<div><small>${tx("理论强平价", "Theoretical liquidation")}</small><b class="bear">${money(liq)}</b></div><div><small>${tx("历史极值价格", "Historical extreme price")}</small><b class="${side > 0 ? "bear" : "bull"}">${money(extreme)}</b></div><div><small>${tx("距成本价", "Distance from entry")}</small><b>${(distance * 100).toFixed(2)}%</b></div><div><small>${tx("手续费参考（开+平）", "Fee reference (in + out)")}</small><b>${money(amount * fee * 2)}</b></div>${probabilityCards}<p class="${level}">${direction} · ${tx("以成本价", "Uses entry")} ${money(entry)} · ${lev}× · ${tx("使用", "using")} ${history.length} ${tx("根 15 分钟历史 K 线的未来窗口统计；仅作风险研究，不代表未来真实概率或交易所强平价。", "15-minute historical candles and forward-window counts; risk research only, not a future probability or an exchange liquidation price.")}</p>`;
};
async function loadLiqProbabilityHistory() {
  if (liqHistoryLoading) return;
  liqHistoryLoading = true;
  try {
    const response = await apiFetch("/api/forecast-history", 20_000),
      data = await response.json();
    if (!response.ok) throw new Error(data.error || "history unavailable");
    liqHistoricalCandles = (data.intraday || []).filter(
      (candle) =>
        Number.isFinite(candle?.close) &&
        Number.isFinite(candle?.low) &&
        Number.isFinite(candle?.high),
    );
  } catch {
    liqHistoricalCandles = [];
  } finally {
    liqHistoryLoading = false;
    calcLiqProbability();
  }
}
(() => {
  const host = document.querySelector(".micro-forecast");
  if (!host || $("liqProbabilityCard")) return;
  const card = document.createElement("section");
  card.id = "liqProbabilityCard";
  card.className = "liq-probability";
  card.innerHTML = `<div class="liq-prob-head"><h3>${tx("强平概率计算器", "Liquidation probability calculator")}</h3><span>${tx("15 分钟历史触及估算", "15m historical touch estimate")}</span></div><form id="liqProbabilityForm" class="liq-prob-form"><label>${tx("交易所", "Exchange")}<select name="exchange"><option value="okx">OKX</option><option value="binance">Binance</option><option value="coinbase">Coinbase</option></select></label><label>${tx("方向", "Side")}<select name="side"><option value="long">${tx("做多", "Long")}</option><option value="short">${tx("做空", "Short")}</option></select></label><label>${tx("购买数量（USDT）", "Purchase amount (USDT)")}<input name="amount" type="number" min="0" step="0.01"></label><label>${tx("杠杆倍率（1–100×）", "Leverage (1–100×)")}<input name="leverage" type="number" min="1" max="100" step="1" inputmode="numeric"></label><label>${tx("开仓均价", "Average entry price")}<input name="entry" type="number" min="10000" step="0.01"></label></form><div id="liqProbabilityOutput" class="liq-prob-output"></div>`;
  host.append(card);
  const form = $("liqProbabilityForm");
  Object.entries(liqProbState).forEach(([k, v]) => {
    if (form.elements[k]) form.elements[k].value = v;
  });
  form.oninput = () => {
    for (const el of form.elements)
      if (el.name) liqProbState[el.name] = el.value;
    localStorage.setItem("btc_liq_probability", JSON.stringify(liqProbState));
    calcLiqProbability();
  };
  calcLiqProbability();
  loadLiqProbabilityHistory();
})();
// Replace any legacy select/margin form after startup timers have created the card.
// 在启动定时器创建卡片后替换旧版下拉/保证金表单。
function installLatestLiqForm() {
  const form = $("liqProbabilityForm");
  if (!form || form.dataset.latestLiq === "1") return;
  form.dataset.latestLiq = "1";
  form.innerHTML = `<label>${tx("交易所", "Exchange")}<select name="exchange"><option value="okx">OKX</option><option value="binance">Binance</option><option value="coinbase">Coinbase</option></select></label><label>${tx("方向", "Side")}<select name="side"><option value="long">${tx("做多", "Long")}</option><option value="short">${tx("做空", "Short")}</option></select></label><label>${tx("持仓量（USDT）", "Position (USDT)")}<input name="amount" type="number" min="0" step="0.01"></label><label>${tx("杠杆倍率（1–100×）", "Leverage (1–100×)")}<input name="leverage" type="number" min="1" max="100" step="1" inputmode="numeric"></label><label>${tx("开仓均价", "Average entry price")}<input name="entry" type="number" min="10000" step="0.01"></label>`;
  Object.entries(liqProbState).forEach(([key, value]) => {
    if (form.elements[key]) form.elements[key].value = value;
  });
  form.oninput = () => {
    for (const element of form.elements)
      if (element.name) liqProbState[element.name] = element.value;
    localStorage.setItem("btc_liq_probability", JSON.stringify(liqProbState));
    calcLiqProbability();
  };
  calcLiqProbability();
  loadLiqProbabilityHistory();
}
setTimeout(installLatestLiqForm, 0);
function renderSignalValidity() {
  const box = $("signalValidity"),
    candles = fixedRuleSignal.candles.length
      ? fixedRuleSignal.candles
      : state.candles;
  if (!box || candles.length < 30) return;
  const m = metrics(candles),
    presentation =
      fixedRuleSignal.presentation || deriveStableRulePresentation(),
    long = m.score >= 0,
    reference = m.close,
    current = state.ticker?.last || state.candles.at(-1)?.close || reference;
  if (presentation && !presentation.confirmed) {
    const revalidating = Boolean(presentation.revalidating),
      remaining = revalidating
        ? Math.max(0, RULE_SIGNAL_REENTRY_CANDLES - presentation.reentryCandles)
        : 0,
      candidate =
        presentation.candidate === "flat"
          ? tx("暂无明确方向", "No directional candidate")
          : `${tx("候选", "Candidate ")}${ruleSignalLabel(presentation.candidate)}`;
    box.className = "signal-validity is-revalidating";
    box.dataset.rangeKey = `${revalidating ? "revalidating" : "awaiting"}|${fixedRuleSignal.closedAt}|${presentation.reentryCandles || 0}`;
    box.innerHTML = `<div class="signal-validity-head"><b>${revalidating ? tx("信号重新评估", "Signal re-evaluation") : tx("方向确认中", "Direction confirmation")}</b><span>${revalidating ? tx("旧信号已失效", "Prior signal invalid") : tx("尚无活跃信号", "No active signal")}</span></div><div class="signal-reentry-state"><b>${candidate}</b><span>${revalidating ? tx(`等待 ${remaining} 根 ${fixedRuleSignal.interval} 已收盘 K 线确认`, `Awaiting ${remaining} closed ${fixedRuleSignal.interval} candles`) : tx("等待连续收盘与多周期同向确认", "Awaiting consecutive closes and multi-timeframe agreement")}</span></div><div class="signal-validity-foot"><small>${revalidating ? tx("价格越过旧作废边界后，旧方向不再使用；完成收盘与多周期确认后将自动生成新的有效区间。", "The prior direction is retired after its invalidation boundary is crossed. A fresh range is created automatically after closed-candle and multi-timeframe confirmation.") : tx("当前没有可执行方向；确认完成后才会生成新的有效区间与作废边界。", "There is no actionable direction yet. A new validity range and invalidation boundary appear only after confirmation.")}</small></div>`;
    [$("signal"), $("signalReason"), $("signalProjection")].forEach((el) =>
      el?.classList.remove("signal-invalid"),
    );
    return;
  }
  // The interval is anchored to the last completed signal candle.  It must not
  // move with the live quote, otherwise a signal could never become invalid.
  const invalid = reference + (long ? -1 : 1) * m.atr * 1.5,
    redeem = reference + (long ? 1 : -1) * m.atr * 3;
  const low = Math.min(invalid, redeem),
    high = Math.max(invalid, redeem),
    // 兑现价是目标而不是失效线：多头只在跌破作废价后失效，
    // 空头只在涨破作废价后失效，达到兑现价仍保持有效。
    valid = long ? current >= invalid : current <= invalid,
    position = Math.max(
      0,
      Math.min(100, ((current - low) / Math.max(high - low, 0.01)) * 100),
    );
  const redeemSide = redeem === low ? "left" : "right",
    invalidSide = invalid === low ? "left" : "right";
  const sideLabel = (side, kind, label) =>
      `<div class="signal-validity-label ${side} ${kind}"><em>${label}</em></div>`,
    sidePrice = (side, kind, value) =>
      `<div class="signal-validity-label ${side} ${kind}"><small>${money(value)}</small></div>`,
    // 文字标签在进度条上方一行，价格数字在进度条下方一行（两侧对称）
    topLeftLabel = invalidSide === "left" ? sideLabel("left", "invalid", tx("作废", "Invalid")) : sideLabel("left", "redeem", tx("兑现", "Redeem")),
    topRightLabel = invalidSide === "right" ? sideLabel("right", "invalid", tx("作废", "Invalid")) : sideLabel("right", "redeem", tx("兑现", "Redeem")),
    bottomLeftPrice = invalidSide === "left" ? sidePrice("left", "invalid", invalid) : sidePrice("left", "redeem", redeem),
    bottomRightPrice = invalidSide === "right" ? sidePrice("right", "invalid", invalid) : sidePrice("right", "redeem", redeem);
  const rangeKey = [
    long,
    reference.toFixed(2),
    invalid.toFixed(2),
    redeem.toFixed(2),
  ].join("|");
  box.className = `signal-validity ${long ? "bull" : "bear"} ${valid ? "is-valid" : "is-invalid"}`;
  const note = valid
    ? tx(
        "价格处于区间内，当前规则信号有效。",
        "Price is inside the range; the rule signal remains active.",
      )
    : tx(
        "价格已越过作废边界，当前规则信号已灰显。",
        "Price crossed the invalidation boundary; the rule signal is dimmed.",
      );
  if (!valid && invalidateFixedRuleSignal()) {
    renderFixedRuleSignal();
    renderSignalValidity();
    return;
  }
  if (box.dataset.rangeKey === rangeKey) {
    const marker = box.querySelector(".signal-validity-now"),
      price = box.querySelector(".signal-validity-now-price"),
      state = box.querySelector(".signal-validity-head>span"),
      foot = box.querySelector(".signal-validity-foot small");
    if (marker) {
      marker.style.left = `${position}%`;
      marker.setAttribute(
        "aria-label",
        `${tx("现价", "Current price")} ${money(current)}`,
      );
    }
    if (price) price.textContent = money(current);
    if (state)
      state.textContent = valid
        ? tx("信号有效", "Signal active")
        : tx("信号已作废", "Signal invalid");
    if (foot) foot.textContent = note;
  } else {
    box.dataset.rangeKey = rangeKey;
    box.innerHTML = `<div class="signal-validity-head"><b>${tx("信号有效区间", "Signal validity range")}</b><span>${valid ? tx("信号有效", "Signal active") : tx("信号已作废", "Signal invalid")}</span></div><div class="signal-validity-scale"><div class="signal-validity-ends">${topLeftLabel}${topRightLabel}</div><div class="signal-validity-track"><i class="signal-validity-now" style="left:${position}%" aria-label="${tx("现价", "Current price")} ${money(current)}"><span class="signal-validity-now-price">${money(current)}</span></i></div><div class="signal-validity-ends">${bottomLeftPrice}${bottomRightPrice}</div></div><div class="signal-validity-foot"><small>${note}</small></div>`;
  }
  const signal = $("signal"),
    reason = $("signalReason"),
    projection = $("signalProjection");
  [signal, reason, projection].forEach((el) =>
    el?.classList.toggle("signal-invalid", !valid),
  );
}
/* Refresh validity and probability state after their cards have mounted. */
addDecisionRenderEnhancer("liquidation-probability", () => {
  renderSignalValidity();
  if (!liqProbState.entry && state.ticker) {
    liqProbState.entry = state.ticker.last;
    const f = $("liqProbabilityForm");
    if (f && document.activeElement !== f.elements.entry)
      f.elements.entry.value = liqProbState.entry;
  }
  calcLiqProbability();
});

/* Digit-level ticker animation: the first changed digit and every lower place flash. */
let renderedPriceText = null;

/* 实时比较、选择覆盖层、共振调度与不同期限预测 / Live comparison, selection overlay, resonance scheduler and horizon forecasts. */
let horizonForecastCache = null,
  horizonForecastLoading = false;
/* ════════════════════════════════════════════════════════════════════════
   重大事件数据（对比特币影响权重高）
   这些事件与普通日历数据合并后统一显示在投资日历列表中：
   · 手工维护的 MAJOR_EVENTS（如美国《清晰法案》投票等定性 / 政策事件）
   · 投资日历里 importance=high 的宏观 / 加密事件（含预期 / 前值，自动合并去重）
   判断结果（利好 / 利空）为「编辑性预判」+ 日历「公布值 vs 预期」的预期差推断，
   非确定性结论；政策类定性事件无预期 / 前值数值。
   新增事件：直接往 MAJOR_EVENTS 数组里加一项即可（at 用 Date.parse）。
   ════════════════════════════════════════════════════════════════════════ */
const MAJOR_EVENTS = [
  {
    name: "美国《清晰法案》(CLARITY Act) 参议院投票",
    at: Date.parse("2026-09-15T18:00:00Z"), // 9/15 14:00 ET / 9/16 02:00 北京
    country: "US",
    category: "crypto",
    importance: "high",
    weight: 5, // 对比特币影响权重 1–5
    estimate: null, // 定性事件无数值
    previous: null,
    kind: "bull", // 编辑预判：bull / bear / neutral
    judge:
      "9/15 参议院 cloture 需 60 票：共和党约 51 票，需 7-9 名民主党跨党，目前仅约 2 人存可能。预测市场通过概率约 15-20%（Polymarket ~17%、Galaxy low double digits）。通过→监管明朗，长期利好 BTC；失败→不确定性延续，短期利空。概率加权短期偏空（期望跌幅约 -10%），但若意外通过可触发 10-20% relief rally。",
  },
  {
    name: "美国战略比特币储备相关行政进展",
    at: Date.parse("2026-10-08T14:00:00Z"), // ⚠️ 示例日期，请按真实日程修改
    country: "US",
    category: "crypto",
    importance: "high",
    weight: 4,
    estimate: null,
    previous: null,
    kind: "bull",
    judge: "若确认增持 / 建立储备框架，叙事层面利好；反之中性。属定性事件。",
  },
  // 模板：复制一项改字段即可
  // {
  //   name: "事件名称", at: Date.parse("2026-01-01T00:00:00Z"),
  //   country: "US", category: "macro", importance: "high", weight: 3,
  //   estimate: "3.2%", previous: "3.0%",          // 数值类事件填预期 / 前值
  //   kind: "bull", judge: "预计高于预期 → 偏紧，短期利空；长期看落地节奏。",
  // },
];
function majorEventsView() {
  const now = Date.now();
  const curated = MAJOR_EVENTS.map((ev) => ({
    curated: true,
    name: ev.name,
    at: Number(ev.at),
    country: ev.country,
    category: ev.category,
    importance: ev.importance,
    weight: ev.weight || 0,
    estimate: ev.estimate ?? null,
    previous: ev.previous ?? null,
    actual: null,
    kind: ev.kind || "neutral",
    judge: ev.judge || "",
  }));
  const live = (investmentCalendarData?.events || [])
    .filter(
      (e) =>
        e.importance === "high" &&
        (e.category === "macro" || e.category === "crypto"),
    )
    .map((e) => {
      const bias = macroEventBias(e) || {};
      const v = {
        curated: false,
        ref: e,
        name: calendarEventTitle(e.title),
        at: Number(e.at),
        country: e.country,
        category: e.category,
        importance: e.importance,
        weight: 5,
        estimate: e.estimate ?? null,
        previous: e.previous ?? null,
        actual: e.actual ?? null,
        kind: bias.kind || "neutral",
        judge: bias.tip || "",
      };
      // 尚未公布、且为数值型（有预期 / 前值）：用「预期相对前值」预判方向
      if (
        e.at > now &&
        v.estimate !== null &&
        v.previous !== null &&
        (v.kind === "neutral" || v.kind === "muted" || v.kind === "flat")
      ) {
        const en = macroParseNumber(e.estimate),
          pn = macroParseNumber(e.previous);
        if (en != null && pn != null && Math.abs(en - pn) > 1e-9) {
          const rising = en > pn;
          const cls = macroIndicatorClass(e.title);
          const bearishIfRising = cls !== "unemployment";
          v.kind = rising === bearishIfRising ? "bear" : "bull";
          v.judge = rising
            ? tx(
                "预期较前值上升，市场偏紧预期 → 短期利空概率更高",
                "Consensus above prior; tighter expectations lean bearish",
              )
            : tx(
                "预期较前值下降，市场宽松预期 → 短期利好概率更高",
                "Consensus below prior; easier expectations lean bullish",
              );
        }
      }
      return v;
    });
  const merged = [...curated, ...live];
  const seen = new Set();
  return merged
    .filter((ev) => {
      const key = ev.name + "|" + calendarBeijingDayKey(ev.at);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.at - b.at);
}
/* 框选区间的「最高 − 最低」价差：绝对价差 + 相对最低价的幅度（%）。
   最高 / 最低在浮层与底部摘要里都是同一套口径（K 线影线极值），价差随之保持一致。
   与「区间涨跌」互补：一个是区间首尾的净变化，一个是区间内的最大波动幅度。 */
function selectionSpreadHtml(hi, lo, dir) {
  /* 价差是「最高 − 最低」的绝对值（恒 ≥ 0），本身不带方向；
     配色因此跟随区间涨跌方向：涨（dir ≥ 0）绿、跌红，与全站 .bull / .bear 单一真源一致。 */
  const tone = !Number.isFinite(dir) ? "flat" : dir >= 0 ? "bull" : "bear";
  const abs = hi - lo,
    rel = Number.isFinite(lo) && lo > 0 ? (abs / lo) * 100 : NaN;
  return `<span class="spread ${tone}">${tx("价差", "Spread")} <em>${money(abs)}</em><i> (${Number.isFinite(rel) ? rel.toFixed(2) + "%" : "--"})</i></span>`;
}
/* 清空框选并同步隐藏浮层、恢复底部提示。
   任何“显式”清除（双击图表、切换周期/范围/数据源、平移）都走这里；
   鼠标移出图表（pointerleave）不再触发——框选数据要留在屏幕上供阅读。 */
function clearChartSelection() {
  chartSelection = null;
  const overlay = $("selectionOverlay");
  if (overlay) {
    overlay.hidden = true;
    overlay.innerHTML = "";
  }
  const stat = $("selectionStats");
  if (stat)
    stat.textContent = tx(
      "拖拽图表可框选区段，显示时间段、最高、最低及涨跌幅。",
      "Drag on chart to select a time span, high, low and return.",
    );
}
function renderSelectionOverlay() {
  const overlay = $("selectionOverlay");
  if (!chartSelection) {
    if (overlay) overlay.hidden = true;
    return;
  }
  const d = visibleCandles(),
    a = Math.min(chartSelection.start, chartSelection.end),
    b = Math.max(chartSelection.start, chartSelection.end);
  /* 单击（未拖动）不构成框选：直接清掉，避免留下 1 根 K 线的“粘性”选区。 */
  if (a === b) {
    clearChartSelection();
    drawLive();
    return;
  }
  const s = d.slice(a, b + 1);
  /* 选区索引若因数据刷新而越界，slice 可能为空 → 直接收敛，避免 .at(-1) 抛错。
     If the indices drift out of range after a data refresh, bail out cleanly. */
  if (!s.length) {
    clearChartSelection();
    drawLive();
    return;
  }
  const hi = maxOf(s.map((v) => v.high)),
    lo = minOf(s.map((v) => v.low)),
    /* 实时价缺失时退回最后一根收盘，保证「最高 / 最低 / 区间涨跌」永远有得可算，
       不会因为报价源抖动让整张框选数据卡凭空消失。 */
    now = Number.isFinite(state.ticker?.last)
      ? state.ticker.last
      : d.at(-1)?.close,
    ret = (s.at(-1).close / s[0].open - 1) * 100;
  if (!overlay || !Number.isFinite(now)) return;
  const diff = (v) => v - now;
  overlay.hidden = false;
  overlay.innerHTML = `<b>${tx("框选时间段", "Selected range")}</b> ${pointTime(s[0].time)} — ${pointTime(s.at(-1).time)}<span>${tx("最高", "High")} <em class="high">${money(hi)}</em> <i class="${diff(hi) >= 0 ? "bull" : "bear"}">${tx("较实时", "vs live")} ${diff(hi) >= 0 ? "+" : "−"}${money(Math.abs(diff(hi)))}</i></span><span>${tx("最低", "Low")} <em class="low">${money(lo)}</em> <i class="${diff(lo) >= 0 ? "bull" : "bear"}">${tx("较实时", "vs live")} ${diff(lo) >= 0 ? "+" : "−"}${money(Math.abs(diff(lo)))}</i></span>${selectionSpreadHtml(hi, lo, ret)}<span class="${ret >= 0 ? "bull" : "bear"}">${tx("区间涨跌", "Range return")} ${pct(ret)}</span>`;
}
function renderHorizonForecasts() {
  const host = $("microForecast");
  if (!host) return;
  let box = $("horizonForecasts");
  if (!box) {
    box = document.createElement("div");
    box.id = "horizonForecasts";
    box.className = "horizon-forecasts";
    host.append(box);
  }
  if (!horizonForecastCache) {
    box.innerHTML = `<span>${tx("正在训练 15 分钟与 24 小时模型…", "Training 15m and 24h models…")}</span>`;
    return;
  }
  const card = (label, fit) => {
    const long = fit.prob * 100,
      bullish = long >= 50,
      cls = bullish ? "bull" : "caution",
      direction = bullish ? tx("看多", "bullish") : tx("看空", "bearish");
    return `<article><small>${label}</small><b class="${cls}">${long.toFixed(2)}% ${direction}</b><span>${tx("看空", "bearish")} ${(100 - long).toFixed(2)}% · ${tx("历史验证", "historical validation")} ${(fit.accuracy * 100).toFixed(2)}%</span></article>`;
  };
  box.innerHTML =
    card(tx("15 分钟机器预测", "15m ML forecast"), horizonForecastCache.f15) +
    card(
      tx("24 小时长线预测", "24h long-horizon forecast"),
      horizonForecastCache.f24,
    );
}
async function loadHorizonForecasts() {
  if (horizonForecastLoading || horizonForecastCache) return;
  horizonForecastLoading = true;
  try {
    const r = await fetch("/api/forecast-history"),
      data = await r.json();
    if (!r.ok) throw new Error(data.error);
    const f15 = trainProbability(
        data.intraday.map((x) => x.close),
        1,
      ),
      f24 = trainProbability(
        data.daily.map((x) => x.close),
        1,
      );
    if (f15 && f24) horizonForecastCache = { f15, f24 };
  } catch {
  } finally {
    horizonForecastLoading = false;
    renderHorizonForecasts();
  }
}
/* Load and render horizon forecasts after the core signal section. */
addDecisionRenderEnhancer("horizon-forecasts", () => {
  renderHorizonForecasts();
  loadHorizonForecasts();
  document
    .querySelectorAll("#intervals .help-dot, #ranges .help-dot")
    .forEach((dot) => dot.remove());
});
$("chart")
  ?.closest(".chart-box")
  ?.insertAdjacentHTML(
    "beforeend",
    '<div id="selectionOverlay" hidden></div>',
  );
$("chart")?.addEventListener("pointerup", renderSelectionOverlay);
$("chart")?.addEventListener("mousemove", (event) => {
  const tip = $("chartTooltip"),
    d = visibleCandles(),
    v = d[hoverIndex],
    live = state.ticker?.last;
  if (!tip || !v || !Number.isFinite(live)) return;
  const delta = v.close - live,
    series = state.chartSeries || { rsi: true, volume: true },
    showRsi = series.rsi !== false,
    showVolume = series.volume !== false;
  let rsiHtml = "";
  if (showRsi) {
    const rv = rsi(d.map((x) => x.close), 14)[hoverIndex];
    if (Number.isFinite(rv)) {
      const rsiClass = rv >= 70 ? "bear" : rv <= 30 ? "bull" : "";
      rsiHtml = `<span class="${rsiClass}">RSI(14) ${rv.toFixed(2)}</span>`;
    }
  }
  const volHtml = showVolume
    ? `<span class="${v.close >= v.open ? "bull" : "bear"}">${tx("成交量", "Volume")} ${Number(v.volume).toLocaleString("en-US", { maximumFractionDigits: 2 })}</span>`
    : "";
  /* 悬浮的正是范围内极值 K 线时，大字直接读标记所标的那个价（影线极值），
     与蓝点标签口径一致；否则维持收盘价口径。 */
  const { hiI: hoverHiI, loI: hoverLoI } = rangeExtremeIndices(d),
    headline =
      hoverIndex === hoverLoI
        ? `${tx("最低价", "Lowest price")} ${money(rangeExtremeValue(v, "low"))}`
        : hoverIndex === hoverHiI
          ? `${tx("最高价", "Highest price")} ${money(rangeExtremeValue(v, "high"))}`
          : `${tx("选中价", "Selected price")} ${money(v.close)}`;
  tip.innerHTML = `<b>${pointTime(v.time)}</b><strong class="chart-point-price">${headline}</strong><span class="chart-live-price">${tx("实时价", "Live price")} ${money(live)} <i class="${delta >= 0 ? "bull" : "bear"}">${tx("差价", "Δ")} ${delta >= 0 ? "+" : "−"}${money(Math.abs(delta))}</i></span><span>${tx("开", "Open")} ${money(v.open)}　${tx("高", "High")} ${money(v.high)}</span><span>${tx("低", "Low")} ${money(v.low)}　${tx("收", "Close")} ${money(v.close)}</span>${volHtml}${rsiHtml}`;
  const rect = $("chart")?.getBoundingClientRect();
  if (rect && event) {
    const boxRect = $("chart")?.closest(".chart-box")?.getBoundingClientRect() || rect,
      pad = 10,
      gap = 20,
      tipW = tip.offsetWidth || 220,
      tipH = tip.offsetHeight || 150,
      cursorX = event.clientX - boxRect.left,
      cursorY = event.clientY - boxRect.top;
    // 水平：默认放光标右侧（间距 20px）；放不下时整卡翻到光标左侧。
    let left = cursorX + gap;
    if (left + tipW > boxRect.width - pad) left = cursorX - tipW - gap;
    // 垂直：默认放光标上方（间距 20px）；顶部放不下时翻到光标下方。
    let top = cursorY - tipH - gap;
    if (top < pad) top = cursorY + gap;
    tip.style.left = Math.max(pad, Math.min(left, boxRect.width - tipW - pad)) + "px";
    tip.style.top = Math.max(pad, Math.min(top, boxRect.height - tipH - pad)) + "px";
  }
});
initResonance();
setSyncMacroPanels(syncMacroPanels); // 注入 app.js 宏观编排函数给 research 模块
initResearch(); // 启动研究数据拉取与 15 分钟整卡重拉
function updateHeaderLatency() {
  const subtitle = document.querySelector("header p");
  if (!subtitle) return;
  const isStream = state.lastGood?.transport === "websocket",
    highLatency = !isStream && Number(requestLatency) >= 1000;
  const label = isStream
    ? tx("实时连接 · OKX WebSocket", "Live connection · OKX WebSocket")
    : tx("实时连接 · REST 降级", "Live connection · REST fallback");
  // 端到端延迟 = 浏览器收到帧的时刻 − 服务器生成帧的时刻（含跨境链路与 CDN）
  let ms = null;
  if (lastSseTickerMsg && Number.isFinite(lastSseTickerMsg.serverTime)) {
    ms = Math.max(0, Date.now() - lastSseTickerMsg.serverTime);
  } else if (Number.isFinite(state.lastGood?.cacheAgeMs)) {
    ms = state.lastGood.cacheAgeMs;
  }
  const high = highLatency || (ms !== null && ms >= 1000);
  const latencyTxt =
    ms === null
      ? tx("延迟 --", "latency --")
      : tx("延迟", "latency") + ` ${ms} ms`;
  subtitle.innerHTML = `<span class="live-pulse"></span>${label} · <b class="latency${high ? " latency-high" : ""}">${latencyTxt}</b>`;
}
const loadCurrentWithHeader = loadCurrent;
loadCurrent = async function () {
  const refreshed = await loadCurrentWithHeader();
  if (refreshed === false) return false;
  updateHeaderLatency();
  return refreshed;
};
const microPredictionWithTerms = microPrediction;
microPrediction = function (m) {
  microPredictionWithTerms(m);
  const direction = document.querySelector(".micro-direction>b");
  if (direction)
    direction.textContent =
      m.score >= 0 ? tx("做多", "Long") : tx("做空", "Short");
};
quoteStripBusy = false;
async function loadExchangeStrip() {
  if (quoteStripBusy) return;
  quoteStripBusy = true;
  try {
    const queries = ["okx"].map(async (source) => {
        const r = await apiFetch(
            "/api/market?" +
              new URLSearchParams({ source, interval: "15m", limit: 30 }),
            5000,
          ),
          v = await r.json();
        if (!r.ok) throw new Error(v.error || source);
        return { source, t: v.ticker };
      }),
      settled = await Promise.allSettled(queries),
      rows = settled
        .filter((result) => result.status === "fulfilled")
        .map((result) => result.value);
    exchangeStripMarkup = rows
      .map(({ source, t }) => {
        const delta = t.last - t.open24h,
          up = delta >= 0,
          cls = up ? "bull" : "bear";
        return `<div class="exchange-row"><span>${tx("实时", "Live")} ${money(t.last)}</span><span class="${cls}">${delta >= 0 ? "+" : "−"}${money(Math.abs(delta))} · ${pct(t.changePct)}</span><span>${tx("24h 开盘", "24h open")} <em class="${cls}">${money(t.open24h)}</em></span><span>${tx("高/低", "High/Low")} ${money(t.high24)} / ${money(t.low24)}</span><small class="source-note">${tx("来源", "Source")}：${source.toUpperCase()}</small></div>`;
      })
      .join("");
    renderExchangeStrip();
  } catch {
    exchangeStripMarkup = "";
    renderExchangeStrip();
  } finally {
    quoteStripBusy = false;
  }
}
(() => {
  document.querySelector(".hero .meta")?.style.setProperty("display", "none");
  loadExchangeStrip();
  setInterval(loadExchangeStrip, 10_000);
})();

function updateExtremaHover(event) {
  const cv = $("chart"),
    d = visibleCandles(),
    high = $("rangeHighPoint"),
    low = $("rangeLowPoint");
  if (!cv || d.length < 2 || !high || !low) return;
  const rect = cv.getBoundingClientRect(),
    { x, y } = chartPlotMapper(rect, d),
    { hiI: hi, loI: lo } = rangeExtremeIndices(d),
    mx = event.clientX - rect.left,
    my = event.clientY - rect.top,
    near = (i, kind) =>
      Math.hypot(mx - x(i), my - y(rangeExtremeValue(d[i], kind))) <= 15;
  high.classList.toggle("is-visible", near(hi, "high"));
  low.classList.toggle("is-visible", near(lo, "low"));
}
$("chart")?.addEventListener("mousemove", updateExtremaHover);
$("chart")?.addEventListener("mouseleave", () => {
  for (const id of ["rangeHighPoint", "rangeLowPoint"])
    $(id)?.classList.remove("is-visible");
});
/* The time-stamped floating chip is the single extrema label.  Suppress only
   the duplicate canvas text while retaining its guide line and point circle. */
function drawChartWithoutDuplicateExtremaText() {
  const proto = CanvasRenderingContext2D.prototype,
    fill = proto.fillText;
  proto.fillText = function (text, ...args) {
    if (
      typeof text === "string" &&
      (text.startsWith("最高价") ||
        text.startsWith("最低价") ||
        text.startsWith("Highest price") ||
        text.startsWith("Lowest price"))
    )
      return;
    return fill.call(this, text, ...args);
  };
  try {
    drawCloseExtrema();
  } finally {
    proto.fillText = fill;
  }
}

if (state.candles.length) drawChartWithoutDuplicateExtremaText();
/* Keep the first and last time ticks inside the canvas instead of clipping
   their date portion at the chart edges. */
drawChartWithoutDuplicateExtremaText = function () {
  const proto = CanvasRenderingContext2D.prototype,
    fill = proto.fillText;
  proto.fillText = function (text, ...args) {
    if (
      typeof text === "string" &&
      (text.startsWith("最高价") ||
        text.startsWith("最低价") ||
        text.startsWith("Highest price") ||
        text.startsWith("Lowest price"))
    )
      return;
    const x = Number(args[0]),
      isTick = /^\d{2}\/\d{2}\s\d{2}:\d{2}$/.test(text);
    if (isTick) {
      const previous = this.textAlign,
        canvasWidth = this.canvas.width / (devicePixelRatio || 1);
      if (x < 90) {
        this.textAlign = "left";
        args[0] = 18;
      } else if (x > canvasWidth - 145) {
        this.textAlign = "right";
        args[0] = canvasWidth - 74;
      }
      const result = fill.call(this, text, ...args);
      this.textAlign = previous;
      return result;
    }
    return fill.call(this, text, ...args);
  };
  try {
    drawCloseExtrema();
  } finally {
    proto.fillText = fill;
  }
};
if (state.candles.length) drawChartWithoutDuplicateExtremaText();
/* 缩放上限（700%）现在只在工具栏 − / + / 重置 三处生效：
   滚轮已不再绑定缩放，因此这里原来的「滚轮兜底压回上限」监听已移除。 */
const zoomControls = document.querySelector(".zoom-tools");
if (zoomControls)
  zoomControls.onclick = (event) => {
    const op = event.target.dataset.zoom;
    if (!op) return;
    state.zoom =
      op === "in"
        ? Math.min(7, state.zoom * 1.5)
        : op === "out"
          ? Math.max(1, state.zoom / 1.5)
          : 1;
    $("zoomLabel").textContent = `${Math.round(state.zoom * 100)}%`;
    draw();
  };
/* Final short-horizon label: wording and colour always come from the same
   short-horizon bias, never from the separate rule-signal score. */
const microPredictionFinal = microPrediction;
microPrediction = function (m) {
  microPredictionFinal(m);
  const closes = state.candles.map((x) => x.close),
    recent = closes.length
      ? closes.at(-1) / closes[Math.max(0, closes.length - 5)] - 1
      : 0,
    trend = m.close ? (m.e20 - m.e50) / m.close : 0,
    long = recent * 0.38 + trend * 0.62 >= 0,
    direction = document.querySelector(".micro-direction>b");
  if (direction) {
    direction.className = long ? "bull" : "bear";
    direction.textContent = long ? tx("做多", "Long") : tx("做空", "Short");
  }
};
/* A probability below 50% is a bearish outcome; never label it bullish. */
const loadForecastsWithConsistentDirection = loadForecasts;
loadForecasts = async function (force = false) {
  await loadForecastsWithConsistentDirection(force);
  document
    .querySelectorAll("#forecastGrid .forecast-item>b")
    .forEach((node) => {
      const probability = Number.parseFloat(node.textContent);
      if (!Number.isFinite(probability)) return;
      const long = probability >= 50;
      node.className = long ? "bull" : "caution";
      node.textContent = `${probability.toFixed(2)}% ${long ? tx("看多", "bullish") : tx("看空", "bearish")}`;
    });
};
$("refreshForecast")?.addEventListener("click", () => loadForecasts(true));
/* A fresh render must never retain a previous point's tooltip.  This wrapper
   clears it first; the final mouse handler below can reveal it only on hit. */
const drawChartWithHiddenExtrema = drawChartWithoutDuplicateExtremaText;
drawChartWithoutDuplicateExtremaText = function () {
  drawChartWithHiddenExtrema();
  $("rangeHighPoint")?.classList.remove("is-visible");
  $("rangeLowPoint")?.classList.remove("is-visible");
};
$("chart")?.addEventListener("mousemove", updateExtremaHover);
setTimeout(loadForecasts, 0);
/* Keep period-return labels synchronized with the selected interface language. */
addDecisionRenderEnhancer("period-context", () => {
  const labels =
    uiLang === "zh"
      ? [
          "较 1 分钟前收盘价",
          "较 5 分钟前收盘价",
          "较 15 分钟前收盘价",
          "较 1 小时前收盘价",
          "较 4 小时前收盘价",
          "较 1 日前收盘价",
        ]
      : [
          "vs close 1m ago",
          "vs close 5m ago",
          "vs close 15m ago",
          "vs close 1h ago",
          "vs close 4h ago",
          "vs close 1d ago",
        ];
  document.querySelectorAll("#changeTags span").forEach((el, i) => {
    const small = el.querySelector("small");
    if (small) small.textContent = labels[i];
  });
  const title = document.querySelector(".chart-periods h2");
  if (title)
    title.firstChild.textContent = tx(
      "周期涨幅（当前价 vs 历史收盘价）",
      "Period return (current vs historical close)",
    );
});
/* Recalculate projection validation after the displayed period context. */
addDecisionRenderEnhancer("projection-validation", () => {
  updateSignalProjectionValidation();
});
if (state.candles.length) renderAnalysis();
/* Colour each summary indicator by its own live reading instead of borrowing
   the overall rule-signal colour. */
addDecisionRenderEnhancer("indicator-sentiment", () => {
  const m = metrics(state.candles),
    summary = $("signalReason")?.querySelector(":scope>span");
  if (!summary) return;
  const tone = (value, deadband = 0) =>
      value > deadband ? "bull" : value < -deadband ? "bear" : "neutral",
    items = [
      ["EMA20", money(m.e20), tone(m.close - m.e20)],
      ["EMA50", money(m.e50), tone(m.close - m.e50)],
      ["RSI(14)", m.rsi.toFixed(2), tone(m.rsi - 50, 5)],
      ["MACD", m.macd.toFixed(2), tone(m.macd, m.close * 0.00005)],
    ];
  summary.innerHTML = items
    .map(
      ([name, value, kind], index) =>
        `${index ? ' <i aria-hidden="true">·</i> ' : ""}<b class="signal-indicator sentiment-${kind}">${name} ${value}</b>`,
    )
    .join("");
  requestAnimationFrame(() => {
    summary.style.fontSize = "12px";
    const available = summary.parentElement?.clientWidth || summary.clientWidth;
    for (
      let size = 12;
      size >= 9.5 && summary.scrollWidth > available;
      size -= 0.25
    )
      summary.style.fontSize = `${size - 0.25}px`;
  });
});
if (state.candles.length) renderAnalysis();
function renderPatternAnalysis() {
  const d = state.candles;
  if (d.length < 25) return;
  let card = $("patternAnalysis");
  if (!card) {
    card = document.createElement("section");
    card.id = "patternAnalysis";
    card.className = "card pattern-analysis-card";
    const anchor = document.querySelector(".terminal-layout");
    if (anchor) anchor.after(card);
    else document.querySelector("main")?.append(card);
  }
  // Keep the multi-period check immediately before the pattern interpretation:
  // it provides the broader directional context for the details that follow.
  // v2.12.42p：顺序统一交给 normalizePanelReadingOrder() 处理，避免与 ensureResearchOutlookCard
  // 的排序逻辑互相触发 MutationObserver。
  const closes = d.map((x) => x.close),
    ma5 = ema(closes, 5).at(-1),
    ma10 = ema(closes, 10).at(-1),
    ma20 = ema(closes, 20).at(-1),
    last = d.at(-1),
    prior = d.slice(-Math.min(21, d.length), -1),
    high = maxOf(prior.map((x) => x.high)),
    low = minOf(prior.map((x) => x.low)),
    range = Math.max(last.high - last.low, 0.01),
    upper = (last.high - Math.max(last.open, last.close)) / range,
    lower = (Math.min(last.open, last.close) - last.low) / range,
    meanVol =
      prior.reduce((sum, x) => sum + x.volume, 0) / Math.max(1, prior.length),
    volumeRatio = meanVol ? last.volume / meanVol : 1,
    bullStack = ma5 > ma10 && ma10 > ma20,
    bearStack = ma5 < ma10 && ma10 < ma20,
    above = last.close > ma5 && last.close > ma10 && last.close > ma20,
    breakout = last.close > high,
    breakdown = last.close < low,
    trend =
      bullStack && above
        ? breakout || volumeRatio >= 1.5
          ? tx("放量突破后强势整理", "Post-breakout consolidation")
          : tx("均线多头排列，短线偏强", "Bullish moving-average alignment")
        : bearStack && !above
          ? breakdown || volumeRatio >= 1.5
            ? tx("跌破整理区，短线偏弱", "Breakdown below consolidation")
            : tx("均线空头排列，短线偏弱", "Bearish moving-average alignment")
          : tx(
              "区间震荡，等待方向确认",
              "Range-bound; waiting for confirmation",
            ),
    trendClass =
      bullStack && above ? "bull" : bearStack && !above ? "bear" : "flat",
    wick =
      upper >= 0.42
        ? tx(
            "长上影：高位抛压需留意",
            "Long upper wick: overhead selling pressure",
          )
        : lower >= 0.42
          ? tx(
              "长下影：下方承接出现",
              "Long lower wick: lower-price demand appeared",
            )
          : tx(
              "影线中性，暂无明显单根反转形态",
              "Neutral wick; no strong one-candle reversal",
            ),
    supportA = bullStack ? ma5 : ma10,
    supportB = bullStack ? ma10 : low,
    resistance = bullStack ? high : ma20,
    invalid = bullStack ? Math.min(ma20, low) : Math.max(ma20, high),
    scenario =
      bullStack && above
        ? tx(
            `若守住 ${money(supportA)} 附近，才有机会再次测试 ${money(resistance)}；若跌破 ${money(invalid)}，短线强势结构会被削弱。`,
            `Holding near ${money(supportA)} keeps a retest of ${money(resistance)} possible; a break below ${money(invalid)} weakens the short-term structure.`,
          )
        : bearStack && !above
          ? tx(
              `若反抽未能站回 ${money(resistance)}，弱势可能延续；若重新站上 ${money(invalid)}，空头结构会被削弱。`,
              `Failure to recover ${money(resistance)} can prolong weakness; moving back above ${money(invalid)} weakens the bearish structure.`,
            )
          : tx(
              `重点观察 ${money(low)} 至 ${money(high)} 区间的有效突破，并结合成交量确认。`,
              `Watch for a confirmed break of the ${money(low)}–${money(high)} range with volume confirmation.`,
            );
  const html = `<div class="pattern-head"><div><h2>${tx("形态识别与关键位", "Pattern recognition & key levels")} <button class="help-dot" type="button" data-tip="${tx("该卡片仅将当前 K 线、均线、成交量与近期区间转为研究性描述。它不预测确定涨跌，也不构成投资建议。", "This card turns current candles, moving averages, volume and recent ranges into research descriptions. It does not predict certain outcomes or provide investment advice.")}">!</button></h2><p>${tx(`基于当前 ${state.interval} K 线 · 研究解读，非投资建议`, `Based on current ${state.interval} candles · research only, not investment advice`)}</p></div><span class="pattern-state ${trendClass}">${trend}</span></div><div class="pattern-grid"><article><small>${tx("趋势与均线", "Trend & moving averages")}</small><b class="${trendClass}">${bullStack ? tx("MA5 / 10 / 20 多头排列", "MA5 / 10 / 20 bullish stack") : bearStack ? tx("MA5 / 10 / 20 空头排列", "MA5 / 10 / 20 bearish stack") : tx("均线交错", "Mixed moving averages")}</b><em>MA5 ${money(ma5)} · MA10 ${money(ma10)} · MA20 ${money(ma20)}</em></article><article><small>${tx("近期关键高 / 低", "Recent high / low")}</small><b>${money(high)} <i>${tx("高", "High")}</i>　${money(low)} <i>${tx("低", "Low")}</i></b><em>${tx("统计窗口：前 20 根 K 线（不含当前）", "Window: prior 20 candles, excluding current")}</em></article><article><small>${tx("当前 K 线信号", "Current-candle signal")}</small><b class="${upper >= 0.42 ? "bear" : lower >= 0.42 ? "bull" : "flat"}">${wick}</b><em>${tx("当前成交量 / 近 20 根均量", "Current volume / 20-candle average")} ${volumeRatio.toFixed(2)}×</em></article></div><div class="pattern-levels"><span><small>${tx("阻力参考", "Resistance")}</small><b class="bear">${money(resistance)}</b></span><span><small>${tx("短线支撑", "Near support")}</small><b class="bull">${money(supportA)}</b></span><span><small>${tx("关键支撑", "Key support")}</small><b class="bull">${money(supportB)}</b></span><span><small>${tx("结构失效参考", "Structure invalidation")}</small><b class="flat">${money(invalid)}</b></span></div><p class="pattern-scenario"><b>${tx("情景观察：", "Scenario watch:")}</b> ${scenario}</p>`;
  if (card.innerHTML !== html) card.innerHTML = html;
}

/* Keep diagnostic output as the final content panel.  Other optional cards
   mount asynchronously, so preserve the reading order whenever one is added.
   v2.12.42p：统一由这里负责排序；renderPatternAnalysis / ensureResearchOutlookCard
   不再各自移动卡片，避免三处逻辑互相触发 MutationObserver。 */
let _panelOrderNormalizing = false;
function normalizePanelReadingOrder() {
  const main = document.querySelector("main");
  if (!main) return;
  try {
    const diagnosticsCard = $("diagnostics")?.closest(".card"),
      patternCard = $("patternAnalysis"),
      researchCard = $("researchOutlookCard"),
      resonanceCard = document.querySelector("main > .optional"),
      kronosCard = $("kronos-forecast-card")?.closest(".card.get-app-card");
    const desired = [];
    if (resonanceCard) desired.push(resonanceCard);
    if (patternCard) desired.push(patternCard);
    if (kronosCard) desired.push(kronosCard);
    if (researchCard) desired.push(researchCard);
    if (desired.length < 2) return;
    // 按期望顺序重排，仅当当前顺序不一致时才移动。
    // 先取出这些节点在 main 中的当前顺序，比较是否需要重排。
    const current = [...main.children].filter((el) => desired.includes(el));
    if (current.every((el, i) => el === desired[i])) return;
    // 以第一个期望节点为锚点，把后续节点依次插到它后面，保证顺序。
    let anchor = desired[0];
    for (let i = 1; i < desired.length; i++) {
      anchor.after(desired[i]);
      anchor = desired[i];
    }
  } catch (e) { /* 排序失败不影响主流程 */ }
}

/* v2.12.42p：工具/诊断类卡片统一沉底（用户要求排在页面最底下）：
   数据诊断 → 高杠杆强平缓冲参考 → 我的持仓与盈亏估算 → 强平概率计算器。
   （消息推送已改为顶栏铃铛弹层，不在此列。）
   各渲染函数仍按自己的锚点插入，这里只在相对顺序偏离时一次性把它们依次
   append 到 main 末尾，避免反复横跳触发 MutationObserver 风暴。 */
function normalizeTailCards() {
  const main = document.querySelector("main");
  if (!main) return;
  const tail = [
    $("diagnostics")?.closest(".card"),
    document.getElementById("leverageDetails"),
    document.querySelector(".position-estimate-details"),
    document.querySelector(".liq-probability-details"),
  ].filter(Boolean);
  if (tail.length < 2) return;
  const lastN = [...main.children].slice(-tail.length);
  if (lastN.every((el, i) => el === tail[i])) return;
  for (const el of tail) main.append(el);
}
function normalizeAllPanels() {
  if (_panelOrderNormalizing) return;
  _panelOrderNormalizing = true;
  try {
    normalizePanelReadingOrder();
    normalizeTailCards();
  } finally {
    _panelOrderNormalizing = false;
  }
}
(() => {
  const main = document.querySelector("main");
  if (!main) return;
  const observer = new MutationObserver(normalizeAllPanels);
  observer.observe(main, { childList: true });
  normalizeAllPanels();
})();
/* Build the pattern analysis after its source indicators have refreshed. */
addDecisionRenderEnhancer("pattern-analysis", () => {
  renderPatternAnalysis();
  addPatternAnalysisHelp();
});
if (state.candles.length) renderAnalysis();
function renderPatternNarrative() {
  const card = $("patternAnalysis"),
    d = state.candles;
  if (!card || d.length < 25) return;
  const closes = d.map((x) => x.close),
    ma5 = ema(closes, 5).at(-1),
    ma10 = ema(closes, 10).at(-1),
    ma20 = ema(closes, 20).at(-1),
    last = d.at(-1),
    prior = d.slice(-Math.min(21, d.length), -1),
    high = maxOf(prior.map((x) => x.high)),
    low = minOf(prior.map((x) => x.low)),
    bull = ma5 > ma10 && ma10 > ma20 && last.close > ma20,
    bear = ma5 < ma10 && ma10 < ma20 && last.close < ma20,
    resistance = bull ? high : ma20,
    support = bull ? ma5 : ma10,
    invalid = bull ? Math.min(ma20, low) : Math.max(ma20, high);
  let box = $("patternNarrative");
  if (!box) {
    box = document.createElement("div");
    box.id = "patternNarrative";
    box.className = "pattern-narrative";
    card.append(box);
  }
  const script = bull
    ? `<ol><li>${tx(`先观察 ${money(support)} 至 ${money(resistance)} 的整理 / 回踩。`, `Watch for consolidation or a pullback between ${money(support)} and ${money(resistance)}.`)}</li><li>${tx(`若支撑守住且量能恢复，才具备再次测试 ${money(resistance)} 的条件。`, `If support holds and volume returns, a retest of ${money(resistance)} becomes possible.`)}</li><li>${tx(`若跌破 ${money(invalid)}，短线多头结构转弱。`, `A break below ${money(invalid)} weakens the short-term bullish structure.`)}</li></ol>`
    : bear
      ? `<ol><li>${tx(`先观察反抽是否受制于 ${money(resistance)}。`, `Watch whether rebounds are capped near ${money(resistance)}.`)}</li><li>${tx(`若无法站回该位置，可能继续测试 ${money(support)} 附近。`, `Failure to recover that level may lead to a test near ${money(support)}.`)}</li><li>${tx(`若重新站上 ${money(invalid)}，空头结构会被削弱。`, `A move above ${money(invalid)} weakens the bearish structure.`)}</li></ol>`
      : `<ol><li>${tx(`先观察 ${money(low)} 至 ${money(high)} 区间内的震荡。`, `Watch the range between ${money(low)} and ${money(high)}.`)}</li><li>${tx("只有突破区间并伴随成交量确认，方向判断才更有意义。", "A directional view becomes more meaningful only after a range break with volume confirmation.")}</li><li>${tx("区间中部信号质量通常较低，避免把单根 K 线当成趋势确认。", "Signals near the middle of a range are weaker; do not treat one candle as trend confirmation.")}</li></ol>`;
  box.innerHTML = `<article><h3>${tx("短线剧本", "Short-term scenario")}</h3>${script}</article><article><h3>${tx("观察建议", "What to watch")}</h3><ul><li>${tx(`支撑 / 阻力：${money(support)} / ${money(resistance)}`, `Support / resistance: ${money(support)} / ${money(resistance)}`)}</li><li>${tx("核心确认：下一 1–3 根 K 线的收盘位置与成交量变化。", "Core confirmation: closes and volume over the next 1–3 candles.")}</li><li>${tx(`结构失效参考：${money(invalid)}；仅作研究观察，不构成交易指令。`, `Structure invalidation reference: ${money(invalid)}; research context only, not a trade instruction.`)}</li></ul></article>`;
}
/* Add the explanatory pattern scenario after the pattern card exists. */
addDecisionRenderEnhancer("pattern-narrative", () => {
  renderPatternNarrative();
});
if (state.candles.length) renderAnalysis();

/* Coalesce input and live updates into one final chart render per frame. */
let chartRenderFrame = null;

/* ===== v2.11.86：本地行情快照秒回填（消除刷新时的多次闪烁） ==================
   刷新后浏览器要重新解析并执行整个 app.js（本地实测 ~0.9s），期间页面依次经历
   「静态骨架 → app.js 注入的空界面 → 数据灌入」三个视觉状态，观感就是连闪几下。
   做法：把最后一次成功的行情数据写入 localStorage，下次开页时在模块加载完毕的
   第一时间同步回填并渲染 —— 用户看到的首帧就是带数据的完整界面，后台再静默刷新。
   首次访问（无快照）仍然走骨架屏路径。 */
(() => {
  const SNAP_KEY = "btc_market_snapshot_v1",
    SNAP_MAX_CANDLES = 400,
    SNAP_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 超过 6 小时的行情不再回填，避免显示陈旧图表
  const usableCandle = (candle) =>
    !!candle &&
    Number.isFinite(candle.close) &&
    Number.isFinite(candle.high) &&
    Number.isFinite(candle.low) &&
    Number.isFinite(candle.time);

  /* 写入放在空闲片段执行（localStorage 是同步 IO，别打断绘制与交互）。 */
  function saveMarketSnapshot(data) {
    try {
      if (!data || !data.ticker || !Array.isArray(data.candles)) return;
      const candles = data.candles.slice(-SNAP_MAX_CANDLES);
      if (candles.length < 2) return;
      const payload = JSON.stringify({
        at: Date.now(),
        interval: state.interval,
        limit: state.limit,
        range: state.range,
        viewPoints: state.viewPoints,
        source: state.source,
        candles,
        ticker: data.ticker,
        marketMeta: state.marketMeta,
        fetchedAt: data.fetchedAt,
      });
      whenIdle(() => {
        try {
          localStorage.setItem(SNAP_KEY, payload);
        } catch {
          /* 配额/隐私模式：快照不可用时静默降级为普通加载 */
        }
      });
    } catch {
      /* 同上 */
    }
  }
  window.saveMarketSnapshot = saveMarketSnapshot;

  const fail = (reason) => {
    try {
      window.__hydrateFailReason = reason;
    } catch {}
    return false;
  };
  function hydrateMarketSnapshot() {
    let snap = null;
    try {
      snap = JSON.parse(localStorage.getItem(SNAP_KEY) || "null");
    } catch {
      return false;
    }
    if (!snap || !snap.ticker || !Array.isArray(snap.candles)) return fail('no-snapshot');
    // 周期 / 数据源不一致时不复用，否则会把旧视图的数据套到新视图上。
    if (snap.source !== state.source || snap.interval !== state.interval) return fail(`mismatch:${snap.source}/${snap.interval} vs ${state.source}/${state.interval}`);
    if (!Number.isFinite(snap.at) || Date.now() - snap.at > SNAP_MAX_AGE_MS) return fail('stale');
    const candles = snap.candles.filter(usableCandle);
    if (candles.length < 2) return fail('no-valid-candles');

    state.candles = candles;
    state.ticker = snap.ticker;
    state.marketMeta = snap.marketMeta || null;
    state.range = snap.range === undefined ? state.range : snap.range;
    state.viewPoints = snap.viewPoints || state.viewPoints;
    if (Number.isFinite(snap.limit)) state.limit = snap.limit;
    state.lastGood = {
      candles,
      ticker: snap.ticker,
      source: snap.source || state.source,
      synthetic: Boolean(snap.marketMeta && snap.marketMeta.synthetic),
    };
    try {
      renderTicker();
      renderAnalysis();
      if (typeof diagnostics === "function")
        diagnostics({ candles, ticker: snap.ticker, marketMeta: state.marketMeta });
    } catch (err) {
      // 回填渲染失败就让位给正常的网络加载，不干扰用户
      return fail('render:' + (err && err.message));
    }
    const conn = $("connection");
    if (conn)
      conn.textContent = tx("本机快照 · 正在刷新行情…", "Local snapshot · refreshing…");
    const cov = $("coverage");
    if (cov)
      cov.textContent =
        `${tx("图表覆盖", "Chart coverage")}：${time(candles[0].time)} ${tx("至", "to")} ${time(candles.at(-1).time)}` +
        ` · ${candles.length} ${tx("根", "candles")}`;
    document.documentElement.classList.remove("pre-boot");
    try {
      window.__dataReadyAt = performance.now(); // 诊断用：数据首次可见的时刻
    } catch {}
    return true;
  }

  try {
    if (hydrateMarketSnapshot()) window.__hydratedFromSnapshot = true;
  } catch {
    /* 快照异常不影响主流程 */
  }
})();
function scheduleChartRender() {
  if (chartRenderFrame !== null) return;
  chartRenderFrame = requestAnimationFrame(() => {
    chartRenderFrame = null;
    drawCandlestickChart();
  });
}
["mousemove", "pointermove", "pointerdown", "mouseleave"].forEach((type) =>
  $("chart")?.addEventListener(type, scheduleChartRender),
);
if (state.candles.length) drawCandlestickChart();

/* Keep the neutral indicator group collapsed while live data refreshes. */
let neutralIndicatorsExpanded = false;

/* Final indicator renderer: installed after every compatibility wrapper so
   the base rows cannot overwrite the expanded research view. */
function renderExpandedIndicatorDetails(m) {
  const host = $("indicators"),
    candles = fixedRuleSignal.candles;
  if (!host || candles.length < 30) return;
  const latest = candles.at(-1),
    average =
      candles.slice(-21, -1).reduce((total, c) => total + c.volume, 0) / 20,
    volumeRatio = average ? latest.volume / average : NaN,
    vwap = fixedSessionVwap(candles),
    context =
      derivativeMarketContext?.source ===
      (fixedRuleSignal.source || state.source)
        ? derivativeMarketContext
        : null,
    funding = context?.fundingRate,
    basis = context?.basisPct,
    oi = context?.oi,
    bull = (kind) => kind === "bull",
    trendBull = m.close > m.e20 && m.e20 > m.e50 && m.e50 > m.e200,
    trendBear = m.close < m.e20 && m.e20 < m.e50 && m.e50 < m.e200,
    vwapBull = Number.isFinite(vwap) && m.close > vwap,
    vwapBear = Number.isFinite(vwap) && m.close < vwap,
    crowdedLong = Number.isFinite(funding) && funding >= 0.0005,
    crowdedShort = Number.isFinite(funding) && funding <= -0.0005,
    extremeBasis = Number.isFinite(basis) && Math.abs(basis) >= 0.12,
    rows = [];
  const tag = (kind, bullish = tx("看多", "Bullish"), bearish = tx("看空", "Bearish")) =>
      kind === "bull" ? bullish : kind === "bear" ? bearish : tx("中性", "Neutral"),
    add = (key, label, value, kind, tip) =>
      rows.push({ key, label, value, kind, tip });
  add(
    "ema20",
    "EMA20",
    money(m.e20),
    m.close >= m.e20 ? "bull" : "bear",
    "EMA20 是最近 20 根 K 线的平均价格。现价在它上方通常偏强、下方偏弱，但不能单独作为买卖理由。",
  );
  add(
    "ema50",
    "EMA50",
    money(m.e50),
    m.close >= m.e50 ? "bull" : "bear",
    "EMA50 反应比 EMA20 慢，适合看中短线方向。价格在其上方偏强、下方偏弱。",
  );
  if (Number.isFinite(m.e200))
    add(
      "ema200",
      "EMA200",
      money(m.e200),
      m.close >= m.e200 ? "bull" : "bear",
      "EMA200 用来观察更长的趋势背景；它不适合用来判断瞬间进场。",
    );
  const rsiKind = m.rsi > 55 ? "bull" : m.rsi < 45 ? "bear" : "flat";
  add(
    "rsi",
    "RSI(14)",
    m.rsi.toFixed(2),
    rsiKind,
    "RSI 看近期涨跌的力度。高于 55 略偏强，低于 45 略偏弱，中间说明方向不够明确。",
  );
  const bollKind = m.boll > 55 ? "bull" : m.boll < 45 ? "bear" : "flat";
  add(
    "boll",
    tx("布林位置", "Bollinger position"),
    `${m.boll.toFixed(2)}%`,
    bollKind,
    tx("布林位置表示价格在近期波动区间的哪里：靠上偏强、靠下偏弱，但不代表一定反转。", "Bollinger position shows where price sits within the recent range: high is stronger, low is weaker, but it does not imply a reversal."),
  );
  add(
    "atr",
    "ATR(14)",
    money(m.atr),
    "flat",
    "ATR 是近期平均波动幅度，适合用来估算止损和仓位风险，本身不判断涨跌。",
  );
  if (Number.isFinite(volumeRatio))
    add(
      "volume",
      tx("成交量确认", "Volume confirmation"),
      `${volumeRatio.toFixed(2)}×`,
      volumeRatio >= 1.2 ? "bull" : volumeRatio < 0.8 ? "bear" : "flat",
      tx("这根已收盘 K 线的成交量相对前 20 根均量。大于 1.2 倍叫放量确认，低于 0.8 倍说明参与度较弱。", "This closed candle's volume versus the prior 20-candle average. Above 1.2× is confirmation; below 0.8× shows weak participation."),
    );
  if (Number.isFinite(vwap))
    add(
      "vwap",
      tx("日内 VWAP", "Session VWAP"),
      money(vwap),
      vwapBull ? "bull" : vwapBear ? "bear" : "flat",
      tx("VWAP 是当天按成交量加权的平均成交价。价格在它上方偏强、下方偏弱，仍需要趋势和成交量配合。", "VWAP is the volume-weighted average price for the session. Above it is stronger, below is weaker, but trend and volume still must agree."),
    );
  if (Number.isFinite(funding))
    add(
      "funding",
      "资金费率",
      formatRate(funding),
      crowdedLong ? "bear" : crowdedShort ? "bull" : "flat",
      "资金费率是永续合约多空双方定期支付的费用。数值很极端时，代表一边可能太拥挤，追单风险更高。",
    );
  if (Number.isFinite(oi))
    add(
      "oi",
      "持仓量 OI",
      `${oi.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${context?.oiUnit || ""}`.trim(),
      "flat",
      "持仓量是还没有平仓的合约总量，反映杠杆参与规模；需要结合价格和成交量判断方向。",
    );
  if (Number.isFinite(basis))
    add(
      "basis",
      "永续价差",
      `${basis >= 0 ? "+" : ""}${basis.toFixed(3)}%`,
      extremeBasis ? (basis > 0 ? "bear" : "bull") : "flat",
      "永续价差是永续合约相对现货的溢价或贴水。差距太大时，说明杠杆市场可能拥挤。",
    );
  const relativeTo = (reference) => {
      if (!Number.isFinite(reference) || !reference) return "";
      const difference = ((m.close - reference) / reference) * 100;
      return `当前收盘价 ${money(m.close)}，${difference >= 0 ? "高于" : "低于"}${Math.abs(difference).toFixed(2)}%。`;
    },
    liveMeaning = {
      ema20: `${relativeTo(m.e20)}因此 EMA20 这项目前${m.close >= m.e20 ? "偏强（看多）" : "偏弱（看空）"}。`,
      ema50: `${relativeTo(m.e50)}因此 EMA50 这项目前${m.close >= m.e50 ? "偏强（看多）" : "偏弱（看空）"}。`,
      ema200: `${relativeTo(m.e200)}因此较长趋势背景目前${m.close >= m.e200 ? "偏强（看多）" : "偏弱（看空）"}。`,
      rsi: `当前 RSI 为 ${m.rsi.toFixed(2)}，${m.rsi < 45 ? "低于 45，说明最近下跌力度相对更强，故标为看空" : m.rsi > 55 ? "高于 55，说明最近上涨力度相对更强，故标为看多" : "处于 45–55 的中间区，买卖力量暂未拉开差距"}。`,
      boll: `当前布林位置为 ${m.boll.toFixed(2)}%，${m.boll < 45 ? "靠近或跌破近期波动区间下侧，短线偏弱" : m.boll > 55 ? "靠近近期波动区间上侧，短线偏强" : "在近期波动区间中部，方向暂不明确"}。`,
      atr: `当前 ATR 为 ${money(m.atr)}，约等于现价的 ${((m.atr / m.close) * 100).toFixed(2)}%；这表示最近每根 ${fixedRuleSignal.interval} K 线的常见波动幅度，不代表涨或跌。`,
      volume: `当前已收盘 K 线成交量是近 20 根均量的 ${volumeRatio.toFixed(2)} 倍，${volumeRatio >= 1.2 ? "参与度明显放大，因此标为确认" : volumeRatio < 0.8 ? "参与度偏低，趋势缺少成交支持" : "参与度大致正常"}。`,
      vwap: `${relativeTo(vwap)}因此日内价格目前${vwapBull ? "在多数成交者的平均成本之上，偏强" : "在多数成交者的平均成本之下，偏弱"}。`,
      funding: `当前资金费率为 ${formatRate(funding)}，${crowdedLong ? "多头付费压力偏高，追多风险增加" : crowdedShort ? "空头付费压力偏高，追空风险增加" : "尚未达到明显拥挤水平"}。`,
      oi: `当前未平仓量为 ${Number.isFinite(oi) ? oi.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "—"} ${context?.oiUnit || ""}；它反映杠杆资金规模，本项单独不能判断方向。`,
      /* ⚠️ basis 来自行情快照的 context.basisPct，可能整块缺失（合约数据没返回时）
         → 这里必须自己守卫：此前直接 basis.toFixed(3)，缺数据时抛
         TypeError: Cannot read properties of undefined (reading 'toFixed')，
         连带把后面的 row.tip 赋值一起打断。 */
      basis: `当前永续价差为 ${
        Number.isFinite(basis) ? (basis >= 0 ? "+" : "") + basis.toFixed(3) : "—"
      }%，${extremeBasis ? "已达到需要留意杠杆拥挤的范围" : "仍在常规范围内"}。`,
    };
  rows.forEach((row) => {
    row.tip = `${liveMeaning[row.key] || `当前读数为 ${row.value}，系统标记为${tag(row.kind)}。`} ${row.tip}`;
  });
  let decision = tx("观望", "Wait"),
    decisionKind = "flat",
    reason = tx("趋势、成交量与日内位置还没有同时确认", "Trend, volume and intraday position are not yet confirmed together");
  if (trendBull && vwapBull && volumeRatio >= 1) {
    decision = tx("研究偏多", "Research bullish");
    decisionKind = "bull";
    reason = tx("均线趋势向上，价格在日内 VWAP 上方，且成交量没有走弱", "Moving averages slope up, price is above session VWAP, and volume is not weakening");
  } else if (trendBear && vwapBear && volumeRatio >= 1) {
    decision = tx("研究偏空", "Research bearish");
    decisionKind = "bear";
    reason = tx("均线趋势向下，价格在日内 VWAP 下方，且成交量没有走弱", "Moving averages slope down, price is below session VWAP, and volume is not weakening");
  } else if ((trendBull || trendBear) && volumeRatio < 1)
    reason = tx("趋势存在，但成交量不足，信号可信度较低", "A trend exists but volume is insufficient, so signal confidence is low");
  else if (trendBull || trendBear)
    reason = tx("趋势存在，但价格与日内 VWAP 没有同向确认", "A trend exists but price and session VWAP do not confirm the same direction");
  if (
    (decisionKind === "bull" && crowdedLong) ||
    (decisionKind === "bear" && crowdedShort)
  ) {
    decision = tx("观望", "Wait");
    decisionKind = "flat";
    reason += tx(`；${crowdedLong ? "多头" : "空头"}资金费率偏拥挤`, `; ${crowdedLong ? "long" : "short"} funding is crowded`);
  }
  if (extremeBasis) reason += tx(`；永续${basis > 0 ? "溢价" : "贴水"}偏大`, `; perpetual ${basis > 0 ? "premium" : "discount"} is elevated`);
  host.classList.add("trade-confirmation-metrics", "indicator-adaptive-grid");
  host.style.setProperty(
    "--indicator-font-scale",
    rows.length > 10 ? ".84" : rows.length > 8 ? ".92" : "1",
  );
    const rowHtml = (row) =>
      `<div class="metric trade-confirmation-row compact-indicator" data-fixed-basis="true" data-indicator-key="${row.key}"><span>${row.label}</span><b>${row.value}</b><i class="badge ${row.kind}">${tag(row.kind, row.key === "volume" ? tx("确认", "Confirm") : row.key === "vwap" ? tx("偏多", "Bullish") : tx("看多", "Bullish"), row.key === "volume" ? tx("偏弱", "Weak") : row.key === "vwap" ? tx("偏空", "Bearish") : tx("看空", "Bearish"))}</i></div>`,
    directionalRows = rows.filter((row) => row.kind !== "flat"),
    neutralRows = rows.filter((row) => row.kind === "flat"),
    neutralSection = neutralRows.length
      ? `<section class="indicator-neutral-group ${neutralIndicatorsExpanded ? "is-expanded" : ""}"><button type="button" class="indicator-neutral-toggle" aria-expanded="${neutralIndicatorsExpanded}"><span>${tx("中性指标", "Neutral indicators")} · ${neutralRows.length} ${tx("项", "items")}</span><b>${neutralIndicatorsExpanded ? tx("收起", "Hide") : tx("展开", "Show")}</b></button><div class="indicator-neutral-grid ${neutralIndicatorsExpanded ? "" : "is-collapsed"}" ${neutralIndicatorsExpanded ? "" : "hidden"}>${neutralRows.map(rowHtml).join("")}</div></section>`
      : "";
  host.innerHTML =
    directionalRows.map(rowHtml).join("") +
    neutralSection +
    `<div class="trade-decision ${decisionKind}"><span>${tx("研究结论", "Research view")}</span><b>${decision}</b><p>${reason}。${context ? ` ${tx("数据源", "Source")}：${String(context.source).toUpperCase()}。` : ""}${tx("仅供研究，不构成交易建议。", " For research only, not investment advice.")}</p></div>`;
  host.querySelector(".indicator-neutral-toggle")?.addEventListener("click", () => {
    neutralIndicatorsExpanded = !neutralIndicatorsExpanded;
    renderExpandedIndicatorDetails(m);
  });
  host
    .querySelectorAll(".compact-indicator")
    .forEach((el) => {
      const row = rows.find((item) => item.key === el.dataset.indicatorKey);
      if (row) addHelp(el.querySelector("span"), row.tip, row.tip);
    });
}
/* Keep one base renderer for expanded indicators and append named enrichments. */
const renderExpandedIndicatorDetailsBase = renderExpandedIndicatorDetails;
const indicatorDetailEnhancers = [];

/* Register an enrichment once so each additional metric has a traceable owner. */
function addIndicatorDetailEnhancer(id, render) {
  if (indicatorDetailEnhancers.some((enhancer) => enhancer.id === id))
    throw new Error(`Duplicate indicator detail enhancer: ${id}`);
  indicatorDetailEnhancers.push({ id, render });
}

/* Normalize the legacy Bollinger property and render every detail in source order. */
renderExpandedIndicatorDetails = function (m) {
  const normalized = {
    ...m,
    boll: Number.isFinite(m.boll) ? m.boll : m.bb * 100,
  };
  renderExpandedIndicatorDetailsBase(normalized);
  indicatorDetailEnhancers.forEach(({ render }) => render(normalized));
};

/* Keep the historical public alias while callers migrate to the named renderer. */
renderTradingConfirmation = renderExpandedIndicatorDetails;

/* 规则信号 enhancer 由 app.js 注入（交易确认 / 指标详情），enhancer 调用 app.js 本地渲染器。 */
registerRuleSignalEnhancer("trading-confirmation", () => {
  if (fixedRuleSignal.candles.length >= 200) {
    renderTradingConfirmation(metrics(fixedRuleSignal.candles));
    addLiveFlowConfirmation();
  }
});
registerRuleSignalEnhancer("expanded-details", () => {
  if (fixedRuleSignal.candles.length >= 30)
    renderExpandedIndicatorDetails(metrics(fixedRuleSignal.candles));
});
if (fixedRuleSignal.candles.length) renderFixedRuleSignal();

/* 两张完全相同的本地买入价卡片：各自保存价格与多空方向，允许同时记录两种仓位。
   Two identical local price cards. Each card keeps its own price and direction
   so the user can choose long or short independently. */
const entryPriceStorageKey = "btc_personal_entry_price"; // BTC 旧单值键，仅 BTC 迁移用
/* 多币种（v2.12.5）：持仓按币种独立存储 —— BTC 继续用旧键保留历史数据，
   其余币种各用 btc_personal_entry_prices_v3_<COIN> / btc_personal_entry_side_v1_<COIN>_<index>。
   从未设置过的币种就是空白，不再借用 BTC 的持仓。 */
const entryPricesStorageKey = () =>
  "btc_personal_entry_prices_v3" + coinStorageSuffix();
const entrySideStorageKey = (index) =>
  "btc_personal_entry_side_v1" + coinStorageSuffix() + "_" + index;
// 方向按卡片单独保存；行情每秒刷新时只读取此固定选择，不推断或覆盖用户的多空选择。
// Persist direction per card. Live quote refreshes only read this explicit choice; they never infer or overwrite it.
const validEntry = (value) =>
  Number.isFinite(value) && value > 0 ? value : null;
/* 读取当前币种自己的持仓组（含 BTC 的旧版本迁移，迁移仅限 BTC）。 */
function loadPersonalEntriesFromStorage() {
  const storageKey = entryPricesStorageKey(),
    hasV3 = localStorage.getItem(storageKey) !== null;
  let entries = [
    { price: null, amount: null, margin: null, leverage: null, side: "long" },
    { price: null, amount: null, margin: null, leverage: null, side: "short" },
  ];
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || "[]");
    if (Array.isArray(saved) && saved.length === 2)
      entries = saved.map((entry, index) => ({
      price: validEntry(Number(entry?.price)),
      amount: validEntry(Number(entry?.amount)),
      // Migrate the previous leverage-only input into the new margin field.
      margin: validEntry(Number(entry?.margin)) || (validEntry(Number(entry?.amount)) && Number(entry?.leverage) > 0 ? Number(entry.amount) / Number(entry.leverage) : null),
      leverage: validEntry(Number(entry?.leverage)) || (validEntry(Number(entry?.amount)) && validEntry(Number(entry?.margin)) ? Number(entry.amount) / Number(entry.margin) : null),
      side:
        entry?.side === "short"
          ? "short"
          : entry?.side === "long"
            ? "long"
            : index === 1
              ? "short"
              : "long",
    }));
  } catch {}
  // Only migrate old single-price storage once (BTC only). An intentionally
  // blank v3 value must remain blank after reload instead of being repopulated
  // from v2/legacy — and other coins never inherit BTC's legacy entries.
  if (!hasV3 && activeCoin() === BASE_COIN) {
    try {
      const prior = JSON.parse(
        localStorage.getItem("btc_personal_entry_prices_v2") || "{}",
      );
      entries = [
        { price: validEntry(Number(prior.long)), amount: null, margin: null, leverage: null, side: "long" },
        { price: validEntry(Number(prior.short)), amount: null, margin: null, leverage: null, side: "short" },
      ];
    } catch {}
    const legacy = validEntry(Number(localStorage.getItem(entryPriceStorageKey)));
    if (legacy)
      entries[0] = {
        price: legacy,
        amount: null,
        margin: null,
        leverage: null,
        side:
          localStorage.getItem("btc_personal_entry_side") === "short"
            ? "short"
            : "long",
      };
  }
  // 独立方向键优先级最高，兼容旧版整组存储并避免任一旧数据迁移覆盖新选择。
  // Per-card side keys take precedence over legacy grouped storage, preventing migrations from overwriting a new choice.
  return entries.map((entry, index) => {
    const savedSide = localStorage.getItem(entrySideStorageKey(index));
    return {
      ...entry,
      side:
        savedSide === "short"
          ? "short"
          : savedSide === "long"
            ? "long"
            : entry.side,
    };
  });
}
let personalEntries = loadPersonalEntriesFromStorage();
let personalEntriesAccountLoggedIn = false;
let personalEntrySyncState = [false, false];
let personalEntryCloudSnapshot = null;
const personalEntrySyncing = new Set();
let personalEntryEditingIndex = null;
window.btcPersonalEntries = personalEntries;
function savePersonalEntries(changedIndex = null) {
  window.btcPersonalEntries = personalEntries;
  localStorage.setItem(entryPricesStorageKey(), JSON.stringify(personalEntries));
  /* v2.12.69：BTC 持仓集合时间戳，供登录双向同步按集合时间戳整组替换。 */
  if ((changedIndex === 0 || changedIndex === 1) && typeof activeCoin === 'function' && activeCoin() === BASE_COIN) { try { localStorage.setItem('btc_positions_sync_ts_v1', String(Date.now())); } catch {} }
  personalEntries.forEach((entry, index) =>
    localStorage.setItem(entrySideStorageKey(index), entry.side),
  );
  if (activeCoin() === BASE_COIN) {
    localStorage.removeItem("btc_personal_entry_prices_v2");
    localStorage.removeItem(entryPriceStorageKey);
    localStorage.removeItem("btc_personal_entry_side");
  }
  if (changedIndex === 0 || changedIndex === 1)
    personalEntrySyncState[changedIndex] = false;
  window.dispatchEvent(new Event("btc:personal-entries-changed"));
}
/* 切换币种：读取该币种自己的持仓（没设置过就是空白，不借 BTC 的），并重算账户同步状态。
   云端持仓档案目前仅 BTC；回到 BTC 时若本地为空且云端有值，沿用登录时的云端回填逻辑。 */
window.addEventListener("btc:coin-changed", () => {
  personalEntryEditingIndex = null;
  personalEntries = loadPersonalEntriesFromStorage();
  if (
    activeCoin() === BASE_COIN &&
    personalEntriesAccountLoggedIn &&
    personalEntryCloudSnapshot
  )
    personalEntries = personalEntries.map((localEntry, index) => {
      const local = normalizePersonalEntry(localEntry, index),
        cloud = personalEntryCloudSnapshot[index];
      return !local.price && cloud.price ? cloud : local;
    });
  personalEntrySyncState = personalEntries.map((entry, index) =>
    Boolean(personalEntriesAccountLoggedIn) &&
    Boolean(personalEntryCloudSnapshot) &&
    Boolean(entry.price) &&
    samePersonalEntry(entry, personalEntryCloudSnapshot[index]),
  );
  window.btcPersonalEntries = personalEntries;
  savePersonalEntries();
  renderPersonalEntryCard(true);
});
function ensurePersonalEntryCard() {
  let card = $("personalEntryCard");
  if (card) return card;
  const hero = document.querySelector(".hero"),
    price = $("price");
  if (!hero || !price) return null;
  card = document.createElement("section");
  card.id = "personalEntryCard";
  card.className = "personal-entry-card";
  const quote = price.closest("div");
  if (quote) quote.after(card);
  else hero.append(card);
  return card;
}
/* 顶部三卡（价格卡 + 两个持仓卡）拖拽互换位置：顺序持久化在 localStorage。
   持仓容器在 CSS 里 display:contents 透传，三个卡片同为 .hero 的 flex 项，用 order 排序。 */
const heroUnitOrderKey = "btc_hero_unit_order";
const heroUnitKeys = ["price", "slot0", "slot1"];
let heroUnitOrder = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(heroUnitOrderKey) || "null");
    if (
      Array.isArray(saved) &&
      saved.length === 3 &&
      heroUnitKeys.every((key) => saved.includes(key))
    )
      return saved.map(String);
  } catch {}
  return [...heroUnitKeys];
})();
function saveHeroUnitOrder() {
  localStorage.setItem(heroUnitOrderKey, JSON.stringify(heroUnitOrder));
}
const heroUnitDesktop = window.matchMedia("(min-width: 1200px)");
function applyHeroUnitOrder() {
  const hero = document.querySelector(".hero");
  if (!hero) return;
  const desktop = heroUnitDesktop.matches;
  const units = [];
  const priceDiv = hero.querySelector(":scope > div");
  if (priceDiv) {
    priceDiv.dataset.heroUnit = "price";
    priceDiv.draggable = true;
    units.push({ key: "price", el: priceDiv });
  }
  /* 包含编辑态在内的所有持仓单元：编辑态模板同样带 data-hero-unit，
     否则丢失排序会退回 order:0，编辑面板会跳到第一列。 */
  hero
    .querySelectorAll('#personalEntryCard [data-hero-unit^="slot"]')
    .forEach((slot) => {
      const key = slot.dataset.heroUnit;
      if (!/^slot[01]$/.test(key)) return;
      units.push({ key, el: slot });
    });
  units.forEach(({ key, el }) => {
    const order = desktop
      ? heroUnitOrder.indexOf(key)
      : /* 窄屏：价格卡不参与互换，仅两个持仓槽在卡内排序。 */
        key === "price"
        ? 0
        : heroUnitOrder.filter((k) => k !== "price").indexOf(key);
    el.style.order = String(order);
  });
  /* 视觉上最左的单元不带左侧分隔线。 */
  units.forEach(({ el }) => el.classList.remove("hero-unit-first"));
  const firstKey = desktop
    ? heroUnitOrder[0]
    : heroUnitOrder.find((k) => k !== "price");
  units.find(({ key }) => key === firstKey)?.el.classList.add("hero-unit-first");
  /* 行情栏等其他子元素固定排在三个可互换单元之后，避免插进中间。 */
  hero
    .querySelectorAll(":scope > *:not([data-hero-unit])")
    .forEach((el) => (el.style.order = "9"));
}
function bindHeroUnitDrag() {
  const hero = document.querySelector(".hero");
  if (!hero || hero.dataset.heroDragBound === "1") return;
  hero.dataset.heroDragBound = "1";
  let sourceKey = null;
  hero.addEventListener("dragstart", (event) => {
    const unit = event.target.closest?.("[data-hero-unit]");
    if (!unit) return;
    sourceKey = unit.dataset.heroUnit;
    unit.classList.add("is-dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", sourceKey);
  });
  hero.addEventListener("dragend", (event) => {
    event.target.closest?.("[data-hero-unit]")?.classList.remove("is-dragging");
    hero
      .querySelectorAll(".hero-unit-drag-over")
      .forEach((el) => el.classList.remove("hero-unit-drag-over"));
    sourceKey = null;
  });
  hero.addEventListener("dragover", (event) => {
    const unit = event.target.closest?.("[data-hero-unit]");
    if (!unit || sourceKey === null || unit.dataset.heroUnit === sourceKey)
      return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    unit.classList.add("hero-unit-drag-over");
  });
  hero.addEventListener("dragleave", (event) => {
    const unit = event.target.closest?.("[data-hero-unit]");
    if (unit && !unit.contains(event.relatedTarget))
      unit.classList.remove("hero-unit-drag-over");
  });
  hero.addEventListener("drop", (event) => {
    event.preventDefault();
    const unit = event.target.closest?.("[data-hero-unit]");
    if (!unit || sourceKey === null) return;
    const targetKey = unit.dataset.heroUnit;
    /* 窄屏布局下价格卡不参与互换。 */
    if (
      !heroUnitDesktop.matches &&
      (targetKey === "price" || sourceKey === "price")
    ) {
      unit.classList.remove("hero-unit-drag-over");
      sourceKey = null;
      return;
    }
    if (targetKey !== sourceKey) {
      const a = heroUnitOrder.indexOf(sourceKey),
        b = heroUnitOrder.indexOf(targetKey);
      [heroUnitOrder[a], heroUnitOrder[b]] = [heroUnitOrder[b], heroUnitOrder[a]];
      saveHeroUnitOrder();
      applyHeroUnitOrder();
    }
    unit.classList.remove("hero-unit-drag-over");
    sourceKey = null;
  });
}
function personalSidePicker(index, side, configuredLeverage) {
  const leverage = configuredLeverage
    ? `<b class="personal-entry-leverage">${Math.round(configuredLeverage)}X</b>`
    : "";
  return `<span class="personal-entry-heading">${tx("我的持仓", "My position")}<i class="personal-side-picker"><button type="button" data-entry-side="long" data-entry-index="${index}" class="${side === "long" ? "active" : ""}">${tx("做多", "Long")}</button><button type="button" data-entry-side="short" data-entry-index="${index}" class="${side === "short" ? "active" : ""}">${tx("做空", "Short")}</button></i>${leverage}</span>`;
}
function personalEntrySlot(index, live) {
  const entry = personalEntries[index],
    price = entry.price,
    side = entry.side,
    configuredLeverage = validEntry(Number(entry.leverage));
  if (personalEntryEditingIndex === index) {
    const fmt = (v, digits = 2) => (v ? Number(v).toFixed(digits) : "");
    return `<article class="personal-entry-slot ${side} editing" data-hero-unit="slot${index}">${personalSidePicker(index, side)}<div class="personal-entry-form"><label><small>${tx("持仓量 (USDT)", "Size (USDT)")}</small><input class="personal-entry-input" data-entry-amount="${index}" aria-label="${tx("持仓量", "Position size")}" type="number" inputmode="decimal" min="0" step="0.01" placeholder="0.00" value="${fmt(entry.amount)}"></label><label><small>${tx("开仓均价 (USDT)", "Entry price (USDT)")}</small><input class="personal-entry-input" data-entry-price="${index}" aria-label="${tx("我的买入价", "My entry price")}" type="number" inputmode="decimal" min="0" step="0.01" placeholder="0.00" value="${fmt(price)}"></label><label><small>${tx("保证金 (USDT)", "Margin (USDT)")}</small><input class="personal-entry-input" data-entry-margin="${index}" aria-label="${tx("保证金", "Margin")}" type="number" inputmode="decimal" min="0" step="0.01" placeholder="0.00" value="${fmt(entry.margin)}"></label><label><small>${tx("杠杆 (倍)", "Leverage (x)")}</small><input class="personal-entry-input" data-entry-leverage="${index}" aria-label="${tx("杠杆倍数", "Leverage")}" type="number" inputmode="decimal" min="0" step="1" placeholder="${tx("自动", "Auto")}" value="${fmt(entry.leverage, 0)}"></label></div><div class="personal-entry-actions"><button type="button" class="personal-entry-btn primary" data-entry-save="${index}">${tx("保存", "Save")}</button><button type="button" class="personal-entry-btn" data-entry-cancel="${index}">${tx("取消", "Cancel")}</button><button type="button" class="personal-entry-btn danger" data-entry-clear="${index}">${tx("清除", "Clear")}</button></div><small>${tx("Enter 保存 · Esc 取消；杠杆留空 = 持仓量÷保证金；清除 = 清空本笔持仓", "Enter to save · Esc to cancel; blank leverage = size÷margin; Clear removes the position")}</small></article>`;
  }
  if (!price)
    return `<article class="personal-entry-slot ${side} empty" draggable="true" data-entry-drag-index="${index}" data-hero-unit="slot${index}">${personalSidePicker(index, side, configuredLeverage)}<button type="button" class="personal-entry-value" data-entry-value="${index}">--</button><small>${tx("双击输入杠杆、持仓量、保证金和开仓均价", "Double-click to enter leverage, size, margin and entry price")}<br>${tx("拖拽可以与价格卡/另一持仓互换位置", "Drag to swap with the price card or the other position")}</small></article>`;
  const rawDelta = Number.isFinite(live) ? live - price : 0,
    delta = side === "short" ? -rawDelta : rawDelta,
    percentage = (delta / price) * 100,
    profit = delta >= 0,
    amount = validEntry(Number(entry.amount)),
    margin = validEntry(Number(entry.margin)),
    inferredMargin = amount && configuredLeverage ? amount / configuredLeverage : null,
    collateral = margin || inferredMargin,
    leverage = amount && collateral ? amount / collateral : null,
    pnl = amount ? amount * (percentage / 100) : null,
    roe = collateral && pnl !== null ? (pnl / collateral) * 100 : null,
    mmr = 0.005,
    liquidation = leverage
      ? side === "short"
        ? price * (1 + 1 / leverage - mmr)
        : price * (1 - 1 / leverage + mmr)
      : null,
    signed = (value) => `${value >= 0 ? "+" : "−"}${money(Math.abs(value))}`,
    signedPct = (value) => `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(2)}%`;
  const actualPnl = amount ? pnl : delta,
    nearLiquidation =
      liquidation && Number.isFinite(live) && Math.abs(live - liquidation) <= 200,
    liquidationSummary = liquidation
      ? `<span class="personal-entry-liquidation${nearLiquidation ? " is-near-liquidation" : ""}">${tx("理论强平价", "Theoretical liquidation")} ${money(liquidation)}${nearLiquidation ? `<small role="alert">${tx("您的仓位即将被强平。", "Your position is close to liquidation.")}</small>` : ""}</span>`
      : "";
  const pnlSummary = `<b class="personal-entry-pnl">${signed(delta)} <em>${signedPct(percentage)}</em></b>${liquidationSummary}<span class="personal-entry-return">${tx("实时价差", "Live price difference")}${amount && roe !== null ? ` · ${tx("保证金回报", "Margin return")} ${signedPct(roe)}` : amount ? ` · ${tx("填写杠杆或保证金后计算回报与强平价", "Add leverage or margin for return and liquidation")}` : ` · ${tx("填写仓位金额后显示实际盈亏。", "Add position size to show actual PnL.")}`}</span>`;
  return `<article class="personal-entry-slot ${side} ${profit ? "profit" : "loss"}" draggable="true" data-entry-drag-index="${index}" data-hero-unit="slot${index}">${personalSidePicker(index, side, configuredLeverage)}<div class="personal-entry-price-row"><button type="button" class="personal-entry-value" data-entry-value="${index}" title="${tx("双击编辑持仓", "Double-click to edit position")}">${money(price)}</button><i class="personal-entry-status">${profit ? tx("盈利中", "In profit") : tx("亏损中", "At a loss")}</i><b class="personal-entry-status-pnl">${signed(actualPnl)}</b></div><div class="personal-entry-pnl-layout"><div>${pnlSummary}</div></div><small>${amount ? `${tx("持仓", "Size")} ${money(amount)} USDT${configuredLeverage ? ` · ${tx("开仓杠杆", "Entry leverage")} ${configuredLeverage.toFixed(2)}×` : ""}${margin ? ` · ${tx("当前保证金", "Current margin")} ${money(margin)}` : ""}${leverage ? ` · ${tx("有效杠杆", "Effective leverage")} ${leverage.toFixed(2)}×` : ""} · ${tx("市价实时更新", "Live market price")}` : tx("双击价格补充杠杆、持仓量与保证金", "Double-click price to add leverage, size and margin")}</small></article>`;
}
function beginPersonalEntryEdit(index) {
  if (personalEntryEditingIndex !== null) return;
  personalEntryEditingIndex = index;
  renderPersonalEntryCard(true);
  const form = document.querySelector(".personal-entry-slot.editing"),
    amountInput = form?.querySelector(`[data-entry-amount="${index}"]`),
    marginInput = form?.querySelector(`[data-entry-margin="${index}"]`),
    leverageInput = form?.querySelector(`[data-entry-leverage="${index}"]`),
    priceInput = form?.querySelector(`[data-entry-price="${index}"]`);
  priceInput?.focus();
  priceInput?.select();
  const readField = (input) => validEntry(Number(input?.value));
  const finish = (save) => {
    if (personalEntryEditingIndex !== index) return;
    if (save) {
      const amount = readField(amountInput),
        margin = readField(marginInput),
        manualLeverage = readField(leverageInput),
        price = readField(priceInput);
      if (!amount && !margin && !manualLeverage && !price) {
        // 四项全空：整笔持仓清除（保留多空方向）。
        personalEntries[index] = {
          price: null,
          amount: null,
          margin: null,
          leverage: null,
          side: personalEntries[index].side,
        };
      } else {
        personalEntries[index].price = price;
        personalEntries[index].amount = amount;
        personalEntries[index].margin = margin;
        // 杠杆优先用手动填写的倍数（徽章/开仓杠杆）；留空时按 持仓量÷保证金 推导。
        personalEntries[index].leverage =
          manualLeverage ||
          (amount && margin ? amount / margin : null);
      }
      savePersonalEntries(index);
    }
    personalEntryEditingIndex = null;
    renderPersonalEntryCard();
    /* v2.12.32 清除即同步：本笔持仓被清空、当前是 BTC 且已登录、云端档案还留着它
       （曾同步过）时，立即把空仓推上云端。否则云端快照不变，account-state 刷新 /
       切币回填会把云端旧持仓原样复活，用户「清了又回来」。 */
    if (
      save &&
      !personalEntries[index].price &&
      personalEntriesAccountLoggedIn &&
      activeCoin() === BASE_COIN &&
      validEntry(Number(personalEntryCloudSnapshot?.[index]?.price)) &&
      !personalEntrySyncing.has(index)
    )
      syncPersonalEntry(index);
  };
  form?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    }
    if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    }
  });
  // 保存 / 取消 / 清除 按钮：清除 = 清空四项后立即保存（清掉本笔持仓，保留方向）。
  form
    ?.querySelector(`[data-entry-save="${index}"]`)
    ?.addEventListener("click", () => finish(true));
  form
    ?.querySelector(`[data-entry-cancel="${index}"]`)
    ?.addEventListener("click", () => finish(false));
  form
    ?.querySelector(`[data-entry-clear="${index}"]`)
    ?.addEventListener("click", () => {
      amountInput && (amountInput.value = "");
      marginInput && (marginInput.value = "");
      leverageInput && (leverageInput.value = "");
      priceInput && (priceInput.value = "");
      finish(true);
    });
  // 焦点在三个输入框之间移动不算结束；只有焦点离开整个表单才保存。
  form?.addEventListener("focusout", (event) => {
    if (form.contains(event.relatedTarget)) return;
    finish(true);
  });
}
function setPersonalEntrySide(index, side) {
  // 点击立刻写入独立键和整组数据；后续每秒重绘仅从这份状态取值。
  // Write both the per-card key and grouped data immediately; subsequent live renders only consume this state.
  personalEntries[index].side = side === "short" ? "short" : "long";
  savePersonalEntries(index);
}
function renderPersonalEntryLegend() {
  // 顶部图例已精简为只保留 K线图+价格，个人买入价图例不再追加。
  return;
}
function renderPersonalEntryCard(force = false) {
  const card = ensurePersonalEntryCard(),
    live = state.ticker?.last;
  if (!card || (!force && personalEntryEditingIndex !== null)) return;
  card.className = "personal-entry-card";
  card.innerHTML =
    personalEntrySlot(0, live) + personalEntrySlot(1, live);
  applyHeroUnitOrder();
  /* 每笔持仓独立显示账户同步状态；空仓不显示状态。
     云端持仓档案目前仅 BTC —— 其它币种一律不显示同步徽标，避免误把持仓写进 BTC 的云端档案。 */
  personalEntries.forEach((entry, index) => {
    if (!validEntry(Number(entry.price))) return;
    if (activeCoin() !== BASE_COIN) return;
    const syncing = personalEntrySyncing.has(index),
      synced = personalEntrySyncState[index] && !syncing,
      label = syncing
        ? tx("同步中…", "Syncing…")
        : synced
          ? tx("已同步", "Synced")
          : tx("未同步", "Not synced"),
      title = synced
        ? tx("该持仓已保存到当前登录账户", "This position is saved to the signed-in account")
        : tx("点击将该持仓同步到我的账户", "Click to sync this position to my account"),
      button = `<button type="button" class="personal-entry-account-sync ${synced ? "is-synced" : "is-unsynced"}" ${synced || syncing ? "disabled" : `data-entry-sync="${index}"`} title="${title}" aria-label="${label}：${title}">${label}</button>`;
    card
      .querySelector(`[data-hero-unit="slot${index}"] .personal-entry-heading`)
      ?.insertAdjacentHTML("beforeend", button);
  });
  card
    .querySelectorAll("[data-entry-value]")
    .forEach((button) =>
      button.addEventListener("dblclick", () =>
        beginPersonalEntryEdit(Number(button.dataset.entryValue)),
      ),
    );
  if (card.dataset.entryControlsBound !== "1") {
    card.dataset.entryControlsBound = "1";
    card.addEventListener("click", (event) => {
      const syncButton = event.target.closest("[data-entry-sync]");
      if (syncButton && card.contains(syncButton)) {
        event.preventDefault();
        syncPersonalEntry(Number(syncButton.dataset.entrySync));
        return;
      }
      const button = event.target.closest("[data-entry-side]");
      if (!button || !card.contains(button)) return;
      event.preventDefault();
      const index = Number(button.dataset.entryIndex);
      setPersonalEntrySide(index, button.dataset.entrySide);
      renderPersonalEntryCard();
    });
  }
  renderPersonalEntryLegend();
  if (state.candles.length) draw();
}
const normalizePersonalEntry = (entry, index) => ({
  price: validEntry(Number(entry?.price)),
  amount: validEntry(Number(entry?.amount)),
  margin:
    validEntry(Number(entry?.margin)) ||
    (validEntry(Number(entry?.amount)) && Number(entry?.leverage) > 0
      ? Number(entry.amount) / Number(entry.leverage)
      : null),
  leverage:
    validEntry(Number(entry?.leverage)) ||
    (validEntry(Number(entry?.amount)) && validEntry(Number(entry?.margin))
      ? Number(entry.amount) / Number(entry.margin)
      : null),
  side:
    entry?.side === "short"
      ? "short"
      : entry?.side === "long"
        ? "long"
        : index === 1
          ? "short"
          : "long",
});
const blankPersonalEntries = () => [
  normalizePersonalEntry(null, 0),
  normalizePersonalEntry(null, 1),
];
const samePersonalEntry = (left, right) =>
  ["price", "amount", "margin", "leverage", "side"].every(
    (key) => left?.[key] === right?.[key],
  );
async function syncPersonalEntry(index) {
  /* 云端持仓档案目前仅 BTC：其它币种的持仓只存本机，不允许覆盖 BTC 的云端档案。 */
  if (activeCoin() !== BASE_COIN) {
    showAppDialog({
      title: tx("持仓同步", "Position sync"),
      message: tx(
        "云端持仓同步目前仅支持比特币（BTC）；该币种的持仓仅保存在本机。",
        "Cloud position sync currently supports Bitcoin (BTC) only; this coin's positions stay on this device.",
      ),
    });
    return;
  }
  if (index !== 0 && index !== 1) return;
  /* v2.12.32：空仓也允许推送。本地刚清除、而云端档案还留着旧持仓时，
     必须能把「清除」同步上去，否则登录刷新 / 切币回填会把云端旧持仓原样灌回来。 */
  if (
    !validEntry(Number(personalEntries[index]?.price)) &&
    !validEntry(Number(personalEntryCloudSnapshot?.[index]?.price))
  )
    return;
  if (!personalEntriesAccountLoggedIn) {
    showAppDialog({
      title: tx("持仓同步", "Position sync"),
      message: tx(
        "请先登录账户，再同步该持仓数据。",
        "Sign in before syncing this position.",
      ),
    });
    return;
  }
  if (personalEntrySyncing.has(index)) return;
  personalEntrySyncing.add(index);
  renderPersonalEntryCard();
  try {
    const snapshot = (personalEntryCloudSnapshot || blankPersonalEntries()).map(
      (entry, entryIndex) => normalizePersonalEntry(entry, entryIndex),
    );
    snapshot[index] = normalizePersonalEntry(personalEntries[index], index);
    const response = await fetch("/api/account/profile", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ personalEntries: snapshot }),
      }),
      data = await response.json();
    if (!response.ok)
      throw new Error(
        data.error || tx("账户同步失败", "Account sync failed"),
      );
    personalEntryCloudSnapshot = data.profile.personalEntries.map(
      (entry, entryIndex) => normalizePersonalEntry(entry, entryIndex),
    );
    personalEntrySyncState[index] = samePersonalEntry(
      normalizePersonalEntry(personalEntries[index], index),
      personalEntryCloudSnapshot[index],
    );
  } catch (error) {
    personalEntrySyncState[index] = false;
    showAppDialog({
      title: tx("持仓同步失败", "Position sync failed"),
      message: error.message,
    });
  } finally {
    personalEntrySyncing.delete(index);
    renderPersonalEntryCard();
  }
}
bindHeroUnitDrag();
heroUnitDesktop.addEventListener?.("change", applyHeroUnitOrder);
whenIdle(() => renderPersonalEntryCard());
applyHeroUnitOrder();
window.addEventListener("btc:account-state", async (event) => {
  personalEntriesAccountLoggedIn = Boolean(event.detail?.loggedIn);
  if (!event.detail?.loggedIn) {
    personalEntryCloudSnapshot = null;
    personalEntrySyncState = [false, false];
    renderPersonalEntryCard();
    return;
  }
  try {
    const response = await fetch("/api/account/profile"),
      data = await response.json();
    if (!response.ok) throw new Error(data.error || "账户资料读取失败");
    const cloudEntries = data.profile?.personalEntries;
    personalEntryCloudSnapshot =
      Array.isArray(cloudEntries) && cloudEntries.length === 2
        ? cloudEntries.map((entry, index) => normalizePersonalEntry(entry, index))
        : blankPersonalEntries();
    /* 云端回填仅 BTC：其它币种本地为空就是空，不把 BTC 的云端持仓灌进来。 */
    if (Array.isArray(cloudEntries) && cloudEntries.length === 2 && activeCoin() === BASE_COIN) {
      personalEntries = personalEntries.map((localEntry, index) => {
        const local = normalizePersonalEntry(localEntry, index),
          cloud = personalEntryCloudSnapshot[index];
        return !local.price && cloud.price ? cloud : local;
      });
    }
    personalEntrySyncState = personalEntries.map(
      (entry, index) =>
        Boolean(entry.price) &&
        samePersonalEntry(entry, personalEntryCloudSnapshot[index]),
    );
    savePersonalEntries();
    renderPersonalEntryCard();
  } catch {
    personalEntryCloudSnapshot = null;
    personalEntrySyncState = [false, false];
    renderPersonalEntryCard();
  }
});

/* 只使用公开日历的宏观监控：刻意追踪事件时间，不冒充未经验证的实际数据。
   Public-calendar-only macro watch. It intentionally tracks event timing,
   not a paid macro-data feed or a direction call. */
let fedCalendarLoading = false;
let macroCalendarData = null;
let macroCalendarError = null;
function macroCountdown(at) {
  const seconds = Math.max(0, Math.round((at - Date.now()) / 1000));
  const days = Math.floor(seconds / 86_400),
    hours = Math.floor((seconds % 86_400) / 3_600),
    minutes = Math.floor((seconds % 3_600) / 60),
    remainingSeconds = seconds % 60;
  return days
    ? tx(`${days} 天 ${hours} 小时 ${minutes} 分 ${remainingSeconds} 秒`, ` ${days}d ${hours}h ${minutes}m ${remainingSeconds}s`)
    : hours
      ? tx(`${hours} 小时 ${minutes} 分 ${remainingSeconds} 秒`, ` ${hours}h ${minutes}m ${remainingSeconds}s`)
      : tx(`${minutes} 分 ${remainingSeconds} 秒`, ` ${minutes}m ${remainingSeconds}s`);
}
function macroUpdatedAgo(at, checking = false) {
  const elapsed = Math.max(0, Date.now() - Number(at || 0));
  if (!Number.isFinite(elapsed) || !at)
    return tx("更新时间未知", "Update time unknown");
  const prefix = checking
    ? tx("上次检查", "Last checked")
    : tx("上次更新", "Updated");
  if (elapsed < 45_000) return tx(`${prefix}：刚刚`, `${prefix}: just now`);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60)
    return tx(`${prefix}：${minutes} 分钟前`, `${prefix} ${minutes}m ago`);
  const hours = Math.floor(minutes / 60);
  if (hours < 24)
    return tx(`${prefix}：${hours} 小时前`, `${prefix} ${hours}h ago`);
  return tx(
    `${prefix}：${Math.floor(hours / 24)} 天前`,
    `${prefix} ${Math.floor(hours / 24)}d ago`,
  );
}
function refreshMacroUpdateAges() {
  document.querySelectorAll("[data-macro-updated-at]").forEach((el) => {
    el.textContent = macroUpdatedAgo(
      Number(el.dataset.macroUpdatedAt),
      el.dataset.macroChecking === "true",
    );
  });
}
/* v2.12.70：美联储利率监测面板（Fed Rate Monitor）。
   服务端 /api/fed-calendar 的 rateMonitor 字段：CME 30 天联邦基金期货（ZQ 月度合约）
   + FRED DFEDTARU 当前目标区间，月末加权算出各场 FOMC 决议的 25bp 步数期望（steps）。
   这里把 steps 换算成概率桶（与 Investing.com 同族算法）并渲染横条。 */
function fedRatePanelHtml(rateMonitor) {
  if (!rateMonitor || !Array.isArray(rateMonitor.meetings) || !rateMonitor.meetings.length) return "";
  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  const rangeText = (mid, step) =>
    `${(mid + step * 0.25 - 0.125).toFixed(2)} – ${(mid + step * 0.25 + 0.125).toFixed(2)}`;
  const bucketsFromSteps = (steps, midBefore) => {
    if (!Number.isFinite(steps)) return [];
    const s = Math.max(-2, Math.min(2, steps)),
      mag = Math.abs(s),
      dir = s >= 0 ? 1 : -1;
    return (mag <= 1 ? [[0, 1 - mag], [dir, mag]] : [[dir, 2 - mag], [2 * dir, mag - 1]])
      .filter(([, p]) => p > 0.0005)
      .map(([step, p]) => ({ step, p, range: rangeText(midBefore, step) }));
  };
  const dateFmt = new Intl.DateTimeFormat(uiLang === "zh" ? "zh-CN" : "en-US", { month: "long", day: "numeric", timeZone: "Asia/Shanghai" });
  const timeFmt = new Intl.DateTimeFormat(uiLang === "zh" ? "zh-CN" : "en-US", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Shanghai" });
  const meetingCards = rateMonitor.meetings.map((meeting, meetingIndex) => {
    const head = `<header><span>FOMC · ${tx("决议", "Decision")} · ${dateFmt.format(meeting.at)}</span>${
      meeting.available ? `<b>${Number(meeting.price).toFixed(3)}</b>` : `<b class="flat">--</b>`
    }</header>`;
    if (!meeting.available) {
      return `<article class="fed-rate-meeting unavailable">${head}<small>${tx(`该月合约（${meeting.contract}）暂不可用：${meeting.detail || "数据源失败"}，下次刷新自动重试。`, `Contract ${meeting.contract} unavailable (${meeting.detail || "source failure"}); will retry.`)}</small></article>`;
    }
    const buckets = bucketsFromSteps(meeting.steps, meeting.midBefore),
      prevBuckets = Number.isFinite(meeting.stepsPrev) ? bucketsFromSteps(meeting.stepsPrev, meeting.midBefore) : [];
    const max = Math.max(...buckets.map((b) => b.p), 0.0001);
    const rows = buckets
      .map((bucket) => {
        const prev = prevBuckets.find((b) => b.step === bucket.step),
          delta = prev ? (prev.p - bucket.p) * 100 : null,
          hold = bucket.step === 0;
        const deltaText =
          delta != null && Math.abs(delta) > 0.05
            ? `<small class="${delta >= 0 ? "up" : "down"}">${delta >= 0 ? "+" : ""}${delta.toFixed(1)}pp ${tx("较昨日", "vs 1d")}</small>`
            : `<small class="muted">${tx("与昨日持平", "flat vs 1d")}</small>`;
        return `<div class="fed-rate-bucket${hold ? "" : " is-change"}"><span class="fed-rate-range">${bucket.range}${hold && meetingIndex === 0 ? tx("（维持）", "") : ""}</span><span class="fed-rate-bar"><i class="${bucket.p === max ? "lead" : ""}" style="width:${Math.max((bucket.p / max) * 100, 2).toFixed(1)}%"></i></span><b>${pct(bucket.p)}</b>${deltaText}</div>`;
      })
      .join("");
    return `<article class="fed-rate-meeting">${head}<strong>${tx("距决议 ", "In ")}${macroCountdown(meeting.at)}</strong><small>${tx("北京时间", "Beijing")} ${timeFmt.format(meeting.at)} · ${tx("期货", "futures")} ${meeting.contract}${Number.isFinite(meeting.prevPrice) ? ` · ${tx("昨收", "prev")} ${Number(meeting.prevPrice).toFixed(3)}` : ""}</small><div class="fed-rate-buckets">${rows}</div></article>`;
  }).join("");
  return `<section class="fed-rate-panel"><div class="fed-rate-head"><div><h3>${tx("美联储利率监测", "Fed rate monitor")}<em class="fed-rate-en">Fed Rate Monitor</em></h3><p>${tx("基于 CME 30 天联邦基金期货与美联储公开日历的市场隐含目标利率概率（月末加权，与 Investing.com 同族算法）。这是市场定价快照，不是本站预测；概率随期货价格实时变化。", "Market-implied target-rate probabilities from CME 30-Day Fed Funds futures and the Fed's public calendar (month-end weighted, same family as Investing.com). A market-pricing snapshot, not a forecast.")}</p></div><span class="fed-rate-current">${tx("当前目标区间", "Current target range")}<b>${Number(rateMonitor.targetLower).toFixed(2)} – ${Number(rateMonitor.targetUpper).toFixed(2)}%</b></span></div><div class="fed-rate-grid">${meetingCards}</div></section>`;
}

function renderFedMonitor(data) {
  macroCalendarData = data || null;
  macroCalendarError = data ? null : macroCalendarError;
  renderFearGreedGauge();
  let card = $("fedMonitorCard");
  if (!card) {
    card = document.createElement("section");
    card.id = "fedMonitorCard";
    card.className = "card fed-monitor-card";
    // v2.11.0：联动卡并入本卡后，阅读顺序固定为 …投资日历 → 宏观环境与联动。
    const calendarCard = $("investmentCalendarCard");
    if (calendarCard) calendarCard.after(card);
    else document.querySelector("main")?.append(card);
  }
  if (!card) return;
  /* v2.11.6：每次渲染都校正相邻关系。本卡每隔几分钟整卡重渲，而其他布局
     逻辑可能在两次渲染之间移动过日历卡，留到下次渲染才修会有一段错位窗口。 */
  syncMacroPanels();
  const events = (data?.events || []).slice(0, 3),
    nearest = events[0],
    near = nearest && nearest.at - Date.now() < 48 * 3_600_000;
  // 有回退日期的事件仍然可展示；仅为完全没有事件数据的来源渲染“暂不可用”占位。
  // An event with a fallback date remains displayable; show “unavailable” only when no event data exists at all.
  const missing = (data?.unavailable || []).flatMap((source) =>
    source === "BLS CPI" && !events.some((event) => event.key === "cpi")
      ? [tx("美国 CPI", "US CPI")]
      : source === "BLS Employment" &&
          !events.some((event) => event.key === "payrolls")
        ? [tx("美国非农就业", "US payrolls")]
        : [],
  );
  const calendarUpdatedAt = data?.fetchedAt;
  // 当上游 BLS 暂不可达时，明确标出按固定发布节奏计算的日期，避免把回退日期误认为实时官方响应。
  // When BLS is temporarily unreachable, label cadence-derived dates so they are not mistaken for a live official response.
  const eventCards = [
    ...events.map(
      (event) =>
        `<article class="fed-event ${event === nearest && near ? "near" : ""}"><span>${tname(MACRO_EVENT_NAMES, event.key)}</span><b>${new Intl.DateTimeFormat(uiLang === "zh" ? "zh-CN" : "en-US", { month: "2-digit", day: "2-digit", year: "numeric", timeZone: "Asia/Shanghai" }).format(event.at)}</b><strong>${tx("距事件 ", "In ")}${macroCountdown(event.at)}</strong><small>${event.source}${event.fallback ? tx(" · 发布节奏回退", " · cadence fallback") : ""}</small><small class="macro-update-age" data-macro-updated-at="${calendarUpdatedAt || ""}">${macroUpdatedAgo(calendarUpdatedAt)}</small></article>`,
    ),
    ...missing.map(
      (name) =>
        `<article class="fed-event unavailable"><span>${name}</span><b>--</b><strong>${tx("官方日历暂不可达", "Official calendar unavailable")}</strong><small>${tx("将于下一次检查自动重试", "Will retry at the next check")}</small><small class="macro-update-age" data-macro-updated-at="${calendarUpdatedAt || ""}" data-macro-checking="true">${macroUpdatedAgo(calendarUpdatedAt, true)}</small></article>`,
    ),
  ].join("");
  const compactDollar = (value) =>
    value >= 1e12
      ? `$${(value / 1e12).toFixed(2)}T`
      : value >= 1e9
        ? `$${(value / 1e9).toFixed(2)}B`
        : value >= 1e6
          ? `$${(value / 1e6).toFixed(2)}M`
          : `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const value = (signal) =>
    signal.key === "btc-dominance"
      ? `${Number(signal.value).toFixed(2)}%`
      : signal.key === "dxy"
        ? Number(signal.value).toFixed(3)
        : /* v2.12.53：指数 / 汇率 / 收益率有各自的单位与精度，不再套 $ 前缀。 */
        signal.key === "us10y"
          ? `${Number(signal.value).toFixed(2)}%`
          : signal.key === "cnh"
            ? Number(signal.value).toFixed(4)
            : ["crypto-total-cap", "crypto-volume"].includes(signal.key)
              ? compactDollar(Number(signal.value))
              : ["ndx", "spx", "gold", "wti", "brent", "vix"].includes(signal.key)
                ? Number(signal.value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                : `$${Number(signal.value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const signalsUpdatedAt = data?.marketSignalsFetchedAt;
  /* v2.12.55：综合指标标题中英结合 —— 中文语境「黄金 Gold」，英文语境只显英文短名。 */
  const ENV_SIGNAL_EN_SHORT = {
    gold: "Gold", dxy: "DXY", ndx: "Nasdaq 100", spx: "S&P 500",
    us10y: "US 10Y", wti: "WTI Crude", brent: "Brent", cnh: "USD/CNH", vix: "VIX",
    "btc-dominance": "BTC Dominance", "crypto-total-cap": "Crypto Cap", "crypto-volume": "24h Volume",
  };
  const macroSignalBilingual = (key) => {
    const pair = ENV_SIGNAL_NAMES[key];
    if (!pair) return tname(ENV_SIGNAL_NAMES, key);
    const en = ENV_SIGNAL_EN_SHORT[key] || pair[1];
    return uiLang === "zh" ? `${pair[0]}<em class="fed-sig-en">${en}</em>` : en;
  };
  const signalCards = (data?.marketSignals || [])
    /* v2.12.55：移除「交易所 BTC 钱包余额」—— 长期无链上数据源、恒为「暂不可用」，不再展示。 */
    .filter((signal) => signal.key !== "exchange-btc-reserve")
    .map((signal) => {
      const change = Number(signal.changePct),
        changeText = Number.isFinite(change)
          ? `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`
          : tx("日内变化待提供", "Change unavailable"),
        kind = Number.isFinite(change)
          ? change >= 0
            ? "bull"
            : "bear"
          : "flat",
        age = macroUpdatedAgo(signalsUpdatedAt, !signal.available);
      return `<article class="fed-market-signal ${signal.available ? "" : "unavailable"}" data-sig-key="${signal.key}"><span>${macroSignalBilingual(signal.key)}</span>${signal.available ? `<b class="${kind}">${changeText}</b><strong>${value(signal)}</strong><small>${signal.source} · ${txMap(SIGNAL_CADENCE, signal.cadence, tx("快照", "Snapshot"))}</small>` : `<b class="flat">--</b><strong>${tx("暂不可用", "Unavailable")}</strong><small>${txMap(SIGNAL_DETAIL, signal.detail, tx("公开数据暂不可用", "Public data unavailable"))}</small>`}<small class="macro-update-age" data-macro-updated-at="${signalsUpdatedAt || ""}"${signal.available ? "" : ' data-macro-checking="true"'}>${age}</small></article>`;
    })
    .join("");
  const marketPanel = signalCards
    ? `<section class="fed-market-panel"><div><h3>${tx("综合指标", "Market context")}</h3><span class="fed-market-head-right">${tx("公开数据 · 每 2 分钟检查", "Public data · checked every 2 min")}<button type="button" class="fed-live-cog" data-fed-live-settings aria-haspopup="true" aria-expanded="false" title="${tx("自定义顶部实况条显示的指标", "Choose indicators shown in the top ticker")}">⚙ ${tx("实况条设置", "Ticker settings")}</button></span><div id="macroLiveSettings" class="fed-live-settings" hidden></div></div><div class="fed-market-grid">${signalCards}</div></section>`
    : "";
  const correlationPanel = `<section class="fed-corr-panel"><div class="fed-corr-head"><div><h3>${tx(coinLabel() + " × 美股联动", coinLabel() + " × US equities linkage")}</h3><p id="correlationStatus">${tx("等待市场数据…", "Waiting for market data…")}</p></div><button id="refreshCorrelation" type="button">${tx("更新分析", "Refresh analysis")}</button></div><div id="correlationOutput" class="correlation-output"></div></section>`;
  card.innerHTML = `<div class="fed-monitor-head"><div><h2>${tx("宏观环境与跨市场联动", "Macro environment & cross-market linkage")}</h2><p>${tx("综合指标、美联储公开日历与 BTC × 美股联动同处一卡；事件前后行情波动可能放大，不构成方向预测。", "Market context, the Fed's public calendar and BTC × US equities linkage in one card. Volatility can rise around releases; this is not a directional forecast.")}</p></div><span class="fed-head-right"><button type="button" class="fed-live-toggle" data-fed-toggle-live>${macroLiveHidden() ? tx("显示实况条", "Show live ticker") : tx("隐藏实况条", "Hide live ticker")}</button><span class="fed-check-pill">${tx("每 2 分钟检查", "Checked every 2 min")}</span></span></div>${marketPanel}<div class="fed-event-grid">${eventCards || `<article class="fed-event unavailable"><span>${tx("公开日历暂不可用", "Public calendar unavailable")}</span><small>${tx("下次 2 分钟检查会自动重试。", "The next two-minute check will retry automatically.")}</small></article>`}</div>${fedRatePanelHtml(data?.rateMonitor)}${correlationPanel}<footer>${nearest ? tx(`最近事件：${tname(MACRO_EVENT_NAMES, nearest.key)}，请在发布前后降低杠杆和仓位集中度。`, `Nearest event: ${tname(MACRO_EVENT_NAMES, nearest.key)}. Consider reducing leverage and concentration around the release.`) : tx("使用 Federal Reserve 与 BLS 的公开发布日历。", "Uses public Federal Reserve and BLS release calendars.")} <em>${data?.cached ? tx("缓存", "Cached") : tx("刚更新", "Updated")}</em></footer>`;
  refreshMacroUpdateAges();
  // v2.12.55：顶部「宏观实况」条显示/隐藏开关（与宏观事件中枢预警条开关同一套逻辑，持久化）。
  card.querySelector("[data-fed-toggle-live]")?.addEventListener("click", () => {
    setMacroLiveHidden(!macroLiveHidden());
  });
  // v2.12.55：实况条内容自定义 —— 勾选哪些实时指标进入顶部滚动条，改动立即生效并持久化。
  const settingsBtn = card.querySelector("[data-fed-live-settings]");
  const settingsPanel = card.querySelector("#macroLiveSettings");
  if (settingsBtn && settingsPanel) {
    const paintSettings = () => {
      const selected = macroLiveSelectedKeys();
      settingsPanel.innerHTML = `<b>${tx("顶部实况条显示内容", "Top ticker contents")}</b>` +
        REALTIME_SIGNAL_KEYS.map((key) => {
          const pair = ENV_SIGNAL_NAMES[key] || [key, key];
          const on = !selected.length ? true : selected.includes(key);
          return `<label><input type="checkbox" data-live-signal="${key}"${on ? " checked" : ""}><span>${pair[0]} <em>${ENV_SIGNAL_EN_SHORT[key] || pair[1]}</em></span></label>`;
        }).join("") +
        `<small>${tx("取消勾选的指标立即从顶部滚动条移除；选择会自动保存。", "Unchecked indicators leave the top ticker immediately; choices are saved.")}</small>`;
      settingsPanel.hidden = !macroLiveSettingsOpen;
      settingsBtn.setAttribute("aria-expanded", String(macroLiveSettingsOpen));
    };
    paintSettings();
    settingsBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      macroLiveSettingsOpen = settingsPanel.hidden;
      settingsPanel.hidden = !macroLiveSettingsOpen;
      settingsBtn.setAttribute("aria-expanded", String(macroLiveSettingsOpen));
    });
    settingsPanel.addEventListener("click", (event) => event.stopPropagation());
    settingsPanel.addEventListener("change", (event) => {
      const box = event.target.closest && event.target.closest("[data-live-signal]");
      if (!box) return;
      const current = new Set(macroLiveSelectedKeys().length ? macroLiveSelectedKeys() : REALTIME_SIGNAL_KEYS);
      if (box.checked) current.add(box.dataset.liveSignal);
      else current.delete(box.dataset.liveSignal);
      try { localStorage.setItem(MACRO_LIVE_SIGNALS_KEY, JSON.stringify(REALTIME_SIGNAL_KEYS.filter((key) => current.has(key)))); } catch {}
      window.dispatchEvent(new CustomEvent("btc:macro-live-config"));
    });
  }
  // v2.11.0：回填联动面板（含首次触发加载）。
  paintCorrelationPanel();
  if (!correlationState.loaded && !correlationState.loading) loadCorrelation();
  addHelp(
    card.querySelector(".fed-monitor-head h2"),
    "整合宏观环境与跨市场联动：综合指标观察美元、避险与加密市场环境；美联储公开日历提示 FOMC、CPI 与非农波动窗口；底部联动面板给出 BTC 与标普/纳指的 60 日相关性与跨市场看多概率。均为环境观察，不预测事件结果或价格方向。",
    "Combines macro context and cross-market linkage: market snapshots track the dollar, safe havens and crypto; the Fed calendar flags FOMC, CPI and payroll volatility windows; the bottom panel shows 60-day BTC correlations with S&P/Nasdaq and a cross-market bullish probability. Context only, never a directional forecast.",
  );
  addHelp(
    card.querySelector(".fed-market-panel h3"),
    "综合传统市场与加密市场的公开快照，用于识别宏观环境；各数据更新频率不同，不能视为同一时点的交易信号。",
    "Combines public traditional-market and crypto snapshots for macro context. Update cadences differ, so it is not a single-time trading signal.",
  );
  const fedRateHead = card.querySelector(".fed-rate-panel h3");
  if (fedRateHead)
    addHelp(
      fedRateHead,
      "目标利率概率的算法：30 天联邦基金期货价格给出该月有效联邦基金利率均值的市场定价（100 − 期货价），再按决议日把当月拆成「现行利率天数 / 新利率天数」，反推一次 25 个基点变动的概率。期货合约由 CME 上市、行情经 Yahoo Finance 免费源转发，当前目标区间取自美联储 FRED 的 DFEDTARU 日度序列。两场以上的会议按路径递推（第二场以第一场的期望结果为基准）。所有数字是市场定价的快照，会随期货价格波动，不构成任何方向预测。",
      "How the probabilities work: the 30-Day Fed Funds futures price prices the month's average effective fed funds rate (100 − price); splitting the month around the decision day lets us back out the probability of one 25bp move. Contracts are listed by CME with quotes relayed via Yahoo Finance; the current target range comes from FRED's daily DFEDTARU series. Later meetings chain off the expected outcome of earlier ones. All figures are market-pricing snapshots that move with the futures — not a forecast.",
    );
  const signalTips = {
    gold: [
      "黄金通常被视为避险资产，和 BTC 的短线关系并不稳定；这里仅观察其日内风险偏好变化。",
      "Gold is usually a safe-haven asset, but its short-term relationship with BTC is unstable; we only observe intraday risk-sentiment shifts here.",
    ],
    dxy: [
      "美元指数走强时，风险资产可能承压；相关性会随市场阶段变化。",
      "When the US Dollar Index strengthens, risk assets can come under pressure; the correlation shifts with the market regime.",
    ],
    "btc-dominance": [
      "BTC 总市值占全加密市场的比例。占比上升常代表资金更偏向 BTC，但不能单独判断涨跌。",
      "BTC's share of total crypto market cap. A rising share often means capital favors BTC, but it alone does not decide direction.",
    ],
    ndx: [
      "纳斯达克100 代表美股科技股整体风向，与 BTC 的中期相关性较高；这里仅观察其日线环境变化。",
      "The Nasdaq 100 tracks US tech stocks, which correlate with BTC over mid-term horizons; intraday context only.",
    ],
    spx: [
      "标普500 代表美股大盘走势，风险偏好回升时通常与加密市场同向；相关性会随阶段变化。",
      "The S&P 500 tracks the broad US equity market; risk-on phases often move it with crypto, but correlation shifts.",
    ],
    us10y: [
      "美国10年期国债收益率是全球资产定价之锚；收益率快速上行通常会抽走风险资产（包括 BTC）的资金。",
      "The US 10-year Treasury yield anchors global asset pricing; a sharp rise often drains capital from risk assets, including BTC.",
    ],
    brent: [
      "布伦特原油是国际油价基准，能源价格走高会推升通胀预期并影响美联储政策路径。",
      "Brent crude is the global oil benchmark; higher energy prices lift inflation expectations and shape the Fed's policy path.",
    ],
    cnh: [
      "美元兑离岸人民币反映美元流动性与非美货币强弱；人民币走弱常伴随美元走强、风险资产承压。",
      "USD/CNH reflects dollar liquidity and non-USD currency strength; a weaker yuan often accompanies a stronger dollar and pressure on risk assets.",
    ],
    "crypto-total-cap": [
      "全网加密总市值反映整体风险偏好与资产规模，使用 24 小时快照而非实时买卖信号。",
      "Total crypto market cap reflects overall risk appetite and asset size; it uses a 24h snapshot, not a real-time buy/sell signal.",
    ],
    "crypto-volume": [
      "全网 24 小时成交额反映市场参与度；放量不代表必然上涨或下跌。",
      "Total 24h volume reflects market participation; higher volume does not imply a guaranteed move up or down.",
    ],
  };
  const defaultTip = [
    "这是公开市场环境数据，用于辅助研究，不应单独作为开仓或平仓依据。",
    "This is public market-context data for research and should not be used as a stand-alone entry or exit signal.",
  ];
  (data?.marketSignals || []).forEach((signal, index) =>
    addHelp(
      card.querySelectorAll(".fed-market-signal>span")[index],
      ...(signalTips[signal.key] || defaultTip),
    ),
  );
}
async function loadFedMonitor() {
  if (fedCalendarLoading) return;
  fedCalendarLoading = true;
  try {
    const response = await apiFetch("/api/fed-calendar", 10_000),
      data = await response.json();
    if (!response.ok) throw new Error(data.detail || data.error);
    macroCalendarError = null;
    renderFedMonitor(data);
  } catch (error) {
    macroCalendarError = error;
    renderFedMonitor(null);
  } finally {
    fedCalendarLoading = false;
  }
}
whenIdle(() => loadFedMonitor());
// The server keeps ordinary calendar reads cached. A one-minute client check lets
// a release-window update (such as payrolls) appear as soon as its public source does.
setInterval(loadFedMonitor, 60_000);
setInterval(refreshMacroUpdateAges, 30_000);
/* v2.12.55：全局只注册一次的实况条联动 —— ① 设置浮层「点外部收起」；② 实况条被 ✕
   收起 / 重开后，同步宏观卡右上角开关按钮的文字。renderFedMonitor 每 60 秒整卡重渲，
   按钮/浮层节点会换新，但 document 级监听绝不能跟着重挂（会越积越多）。 */
document.addEventListener("click", (event) => {
  const panel = document.getElementById("macroLiveSettings");
  if (!panel || panel.hidden) return;
  if (panel.contains(event.target)) return;
  const btn = panel.parentElement.querySelector("[data-fed-live-settings]");
  if (btn && (btn === event.target || btn.contains(event.target))) return;
  panel.hidden = true;
  macroLiveSettingsOpen = false;
  btn?.setAttribute("aria-expanded", "false");
});
window.addEventListener("btc:macro-live-visibility", (event) => {
  const hidden = !!(event.detail && event.detail.hidden);
  document.querySelectorAll("[data-fed-toggle-live]").forEach((button) => {
    button.textContent = hidden ? tx("显示实况条", "Show live ticker") : tx("隐藏实况条", "Hide live ticker");
  });
});
/* v2.12.56：顶部实况条的 ⚙ —— 平滑滚到宏观卡综合指标区并展开「实况条设置」浮层。
   浮层开合状态由模块级 macroLiveSettingsOpen 持有，60s 整卡重渲后自动恢复；
   本监听与上面两个一样，全局只注册一次（renderFedMonitor 重渲绝不重挂）。 */
window.addEventListener("btc:macro-live-settings-request", () => {
  const panel = document.getElementById("macroLiveSettings");
  if (!panel) return;
  macroLiveSettingsOpen = true;
  panel.hidden = false;
  panel.parentElement?.querySelector("[data-fed-live-settings]")?.setAttribute("aria-expanded", "true");
  panel.closest(".fed-market-panel")?.scrollIntoView({ behavior: "smooth", block: "center" });
});

/* Investment calendar: a table-first risk window, purpose-built for BTC risk
   windows. It reads the server-side feed so an optional Finnhub key never
   reaches the browser. Every wall-clock decision is made in Beijing time. */
let investmentCalendarData = null;
// The lower timeline is the complete calendar by default. Date shortcuts are
// opt-in views; starting on "today" made future events appear to be missing
// even though the API and the Major events strip already contained them.
let investmentCalendarRange = "all";          // yesterday|today|tomorrow|week|nextweek|custom|all（v2.12.46 起默认「全部」）
/* v2.11.0：事件行「影响预测」展开状态（key = at|title），重渲染后保持。 */
const calendarExpandedRows = new Set();
/* v2.12.46：「全部」视图里，今天以前已公布的条目默认折叠成一行，
   点开才铺开 —— 「即将发生」始终是第一眼内容，昨天的数据也还翻得出来。 */
let calendarReleasedExpanded = false;
/* 展开「已公布」时把条数上限临时抬高（记下原值，收起时还原），
   否则放出来的那批会把后面的「即将发生」整段挤出可视条数之外。 */
let calendarReleasedBaseLimit = 0;
let investmentCalendarFrom = "";              // yyyy-mm-dd (Beijing day)
let investmentCalendarTo = "";                // yyyy-mm-dd (Beijing day)
let investmentCalendarImportance = new Set(); // empty = all (low|medium|high)
let investmentCalendarRegions = new Set(["US"]); // v2.12.46 默认只看美国；清空 = 全部国家
let investmentCalendarCategories = new Set(); // empty = all categories
let investmentCalendarTimeZone = "local";     // reference zone for the secondary line
let investmentCalendarShowFilters = true;
/* v2.11.16 列表展开模型：折叠态固定 6 条，之后每步 +10，可一键全展开。
   SCROLL_AFTER 是「改为列表内滚动」的阈值——超过它就不再让 116 行把整页撑长，
   而是在列表容器里滚（TradingView / ServiceNow 日历都这么做）。 */
const INVESTMENT_CALENDAR_BASE_LIMIT = 6;
const INVESTMENT_CALENDAR_STEP = 10;
const INVESTMENT_CALENDAR_SCROLL_AFTER = 30;
let investmentCalendarVisibleLimit = INVESTMENT_CALENDAR_BASE_LIMIT;
let investmentCalendarListReturnY = null;     // 「收起」后要滚回的锚点（卡顶文档坐标）
let calendarOpenMenu = null;                  // region|category|importance|null
const calendarMenuSearch = { region: "", category: "", importance: "" };

function investmentCalendarMatchesSelectors(event) {
  return (!investmentCalendarImportance.size || investmentCalendarImportance.has(event.importance || "low"))
    && (!investmentCalendarRegions.size || investmentCalendarRegions.has(event.country || "GLOBAL"))
    && (!investmentCalendarCategories.size || investmentCalendarCategories.has(event.category || "macro"));
}
function resetInvestmentCalendarVisibleLimit() { investmentCalendarVisibleLimit = 6; }

/* 「宏观经济数据」卡片独立筛选器状态，默认只显示高重要性事件。 */
let releasedDataRegions = new Set();          // empty = all countries
let releasedDataCategories = new Set();       // empty = all categories
let releasedDataImportance = new Set(["high"]); // default high only
let releasedDataShowFilters = true;
let releasedDataOpenMenu = null;                // region|category|importance|null
const releasedDataMenuSearch = { region: "", category: "", importance: "" };
/* v2.12.46：「关注」勾选取消 —— 重要事件自动进顶部卡片。
   用户的控制权剩下两点：①「不显示」（进忽略名单，下次自动跳过）；
   ②「更换」（手动指定一条，或恢复自动）。两份状态都持久化在本机。 */
const MACRO_MANUAL_KEY = "btc_macro_calendar_manual";
const MACRO_DISMISSED_KEY = "btc_macro_calendar_dismissed";
/* v2.12.57：关注卡「锁定」—— 锁定后顶部预警条的点击不再切换关注对象（见 focusMacroEvent）。 */
const MACRO_PIN_LOCKED_KEY = "btc_macro_calendar_locked";
const MACRO_TICKER_HIDDEN_KEY = "btc_macro_ticker_hidden";
/* v2.12.55：顶部「宏观实况」条的可见性与内容选择（与 multi-coin.js 通过事件互通）。
   实况条本体由 multi-coin.js 注入并渲染，这里只负责持久化键 + 广播变更事件。 */
const MACRO_LIVE_HIDDEN_KEY = "btc_macro_live_hidden";
const MACRO_LIVE_SIGNALS_KEY = "btc_macro_live_signals";
let macroLiveSettingsOpen = false;               // 实况条设置浮层是否展开（重渲染后保持）
function macroLiveHidden() {
  try { return localStorage.getItem(MACRO_LIVE_HIDDEN_KEY) === "1"; } catch { return false; }
}
function setMacroLiveHidden(hidden) {
  try { localStorage.setItem(MACRO_LIVE_HIDDEN_KEY, hidden ? "1" : "0"); } catch {}
  window.dispatchEvent(new CustomEvent("btc:macro-live-visibility", { detail: { hidden } }));
}
function macroLiveSelectedKeys() {
  try {
    const raw = JSON.parse(localStorage.getItem(MACRO_LIVE_SIGNALS_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((key) => REALTIME_SIGNAL_KEYS.includes(key)) : [];
  } catch { return []; }
}
let macroManualPick = "";                     // at|title；空串 = 跟随自动挑选
let macroDismissed = new Set();               // 用户点过「不显示」的事件 key
let macroPinLocked = false;                   // v2.12.57：关注卡是否锁定（锁定后预警条点击不抢占）
let macroTickerHidden = false;                // K 线上方宏观预警滚动条是否被收起
let macroPickerOpen = false;                  // 「更换」浮层是否展开

function loadMacroCalendarPicks() {
  try { macroManualPick = String(localStorage.getItem(MACRO_MANUAL_KEY) || ""); } catch { macroManualPick = ""; }
  try {
    const raw = localStorage.getItem(MACRO_DISMISSED_KEY);
    macroDismissed = new Set(raw ? JSON.parse(raw) : []);
  } catch {
    macroDismissed = new Set();
  }
  try { macroTickerHidden = localStorage.getItem(MACRO_TICKER_HIDDEN_KEY) === "1"; } catch { macroTickerHidden = false; }
  try { macroPinLocked = localStorage.getItem(MACRO_PIN_LOCKED_KEY) === "1"; } catch { macroPinLocked = false; }
}
function saveMacroCalendarPicks() {
  try {
    if (macroManualPick) localStorage.setItem(MACRO_MANUAL_KEY, macroManualPick);
    else localStorage.removeItem(MACRO_MANUAL_KEY);
  } catch {}
  try { localStorage.setItem(MACRO_DISMISSED_KEY, JSON.stringify([...macroDismissed])); } catch {}
}
function saveMacroTickerHidden() {
  try { localStorage.setItem(MACRO_TICKER_HIDDEN_KEY, macroTickerHidden ? "1" : "0"); } catch {}
}
function macroCalendarPickKey(event) {
  return `${Number(event.at)}|${event.title || event.name || ""}`;
}
function macroCalendarPickEvent(key) {
  if (!investmentCalendarData?.events) return null;
  const [atStr, ...titleParts] = String(key).split("|");
  const at = Number(atStr);
  const title = titleParts.join("|");
  const fromCalendar = investmentCalendarData.events.find((e) => Number(e.at) === at && (e.title === title || e.name === title));
  if (fromCalendar) return fromCalendar;
  // 重大事件（手工维护 / 高重要性自动聚合）也可能被关注，fallback 到 majorEventsView。
  return majorEventsView().find((e) => Number(e.at) === at && (e.name === title || e.title === title)) || null;
}
/* v2.12.46：候选池 —— 高重要性事件，已公布最多回看 24 小时、未公布最多前瞻 14 天。
   自动挑选与「更换」菜单共用这一个池，口径只此一处。
   每条都经 macroCalendarPickEvent 归一到「权威对象」：手工维护的重大事件带
   curated / judge / kind 字段，而时间线视图的副本会丢掉它们。 */
const MACRO_PIN_LOOKBACK_MS = 24 * 3_600_000;
// 注意：这里的「天」必须写死毫秒 —— CALENDAR_DAY 在文件后面才声明，
// 顶层 const 初始化期引用它会命中 TDZ，整个模块直接停在这一行。
const MACRO_PIN_LOOKAHEAD_MS = 14 * 86_400_000;
function macroPinCandidates() {
  const now = Date.now();
  return investmentCalendarTimelineEvents()
    .filter((event) => event.importance === "high")
    // 跟随「国家及地区」筛选：默认只看美国，加选别的地区这里就一起进来。
    .filter((event) => !investmentCalendarRegions.size || investmentCalendarRegions.has(event.country || "GLOBAL"))
    .filter((event) => Number.isFinite(Number(event.at)))
    .filter((event) => Number(event.at) >= now - MACRO_PIN_LOOKBACK_MS && Number(event.at) <= now + MACRO_PIN_LOOKAHEAD_MS)
    .map((event) => macroCalendarPickEvent(macroCalendarPickKey(event)) || event)
    .sort((a, b) => a.at - b.at);
}
function macroPinnedExpired(event, now = Date.now()) {
  return Number(event.at) <= now && now - Number(event.at) > MACRO_LIVE_WINDOW_MS;
}

// 关注宏观事件实时数据：只保留「尚未公布」或「已公布但不超过 30 分钟」的事件，
// 超过 30 分钟后自动移除，让卡片始终聚焦可交易的实时/即将到来的数据。
const MACRO_LIVE_WINDOW_MS = 30 * 60_000;
let macroLiveFetchTimer = null;
/* v2.12.46：顶部卡片自动挑选，不再依赖任何手工勾选。
   优先级：① 手动指定的那条（未被「不显示」且未过期）；② 30 分钟内即将发布的高重要性
   事件（最紧急）；③ 刚公布 30 分钟内的（第一时间给出实际值与利好利空）；
   ④ 最近的一场高重要性事件。用户点过「不显示」的一律跳过。 */
function macroCalendarPickedLiveEvent() {
  const now = Date.now();
  if (macroManualPick) {
    const manual = macroCalendarPickEvent(macroManualPick);
    if (manual && !macroDismissed.has(macroManualPick) && !macroPinnedExpired(manual, now)) return manual;
  }
  if (!investmentCalendarData?.events) return null;
  const pool = macroPinCandidates().filter((event) => !macroDismissed.has(macroCalendarPickKey(event)));
  const imminent = pool.filter((event) => event.at > now && event.at - now <= MACRO_LIVE_WINDOW_MS);
  if (imminent.length) return imminent[0];
  const justReleased = pool
    .filter((event) => event.at <= now && now - event.at <= MACRO_LIVE_WINDOW_MS)
    .sort((a, b) => b.at - a.at);
  if (justReleased.length) return justReleased[0];
  return pool.filter((event) => event.at > now)[0] || null;
}
function manageMacroLiveFetch() {
  const event = macroCalendarPickedLiveEvent();
  const now = Date.now();
  const inLiveWindow = event && event.at <= now && now - event.at <= MACRO_LIVE_WINDOW_MS;
  const nearRelease = event && event.at > now && event.at - now <= 2 * 60_000;
  if (inLiveWindow || nearRelease) {
    if (!macroLiveFetchTimer) {
      // 事件公布前后 2 分钟/公布后 30 分钟内，每 15 秒强制刷新一次，第一时间抓取实际值。
      macroLiveFetchTimer = setInterval(() => loadInvestmentCalendar(true), 15_000);
    }
  } else if (macroLiveFetchTimer) {
    clearInterval(macroLiveFetchTimer);
    macroLiveFetchTimer = null;
  }
}

// calendarEscape 已收归内核（src/core.js 导出），此处不再重复定义。
function calendarFormat(at, options) {
  return new Intl.DateTimeFormat(uiLang === "zh" ? "zh-CN" : "en-US", { timeZone: investmentCalendarTimeZone, ...options }).format(at);
}
function calendarFormatInZone(at, zone, options) {
  return new Intl.DateTimeFormat(uiLang === "zh" ? "zh-CN" : "en-US", { timeZone: zone, ...options }).format(at);
}
function calendarFormatBeijing(at, options) {
  return new Intl.DateTimeFormat(uiLang === "zh" ? "zh-CN" : "en-US", { timeZone: "Asia/Shanghai", ...options }).format(at);
}
const CALENDAR_LOCAL_ZONE = {
  US:"America/New_York", CN:"Asia/Shanghai", EU:"Europe/Brussels", JP:"Asia/Tokyo", UK:"Europe/London",
  DE:"Europe/Berlin", FR:"Europe/Paris", BR:"America/Sao_Paulo", AU:"Australia/Sydney", SG:"Asia/Singapore",
  CA:"America/Toronto", KR:"Asia/Seoul", IN:"Asia/Kolkata", RU:"Europe/Moscow", OPEC:"Europe/Vienna",
  CH:"Europe/Zurich", IT:"Europe/Rome", ES:"Europe/Madrid", MX:"America/Mexico_City", TR:"Europe/Istanbul",
  ZA:"Africa/Johannesburg", NZ:"Pacific/Auckland", HK:"Asia/Hong_Kong", TW:"Asia/Shanghai",
  BTC:"UTC", OIL:"UTC", GLOBAL:"UTC",
};
function calendarLocalZone(country) { return CALENDAR_LOCAL_ZONE[country] || "UTC"; }
function calendarLocalLabel(country) { return calendarCountry(country).label; }

/* Beijing wall-clock helpers. Mainland China has no DST, so a fixed +8h shift is
   exact — no timezone round-trips needed for day bucketing and range windows. */
const CALENDAR_BJ_OFFSET = 8 * 3_600_000, CALENDAR_DAY = 86_400_000;
function calendarBeijingDayStart(ts) { return Math.floor((Number(ts) + CALENDAR_BJ_OFFSET) / CALENDAR_DAY) * CALENDAR_DAY - CALENDAR_BJ_OFFSET; }
function calendarBeijingDayKey(ts) { const d = new Date(Number(ts) + CALENDAR_BJ_OFFSET); return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`; }
function calendarBeijingDateToMs(value) {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  return matched ? Date.UTC(+matched[1], +matched[2] - 1, +matched[3]) - CALENDAR_BJ_OFFSET : NaN;
}
function calendarWeekStart(ts) {
  const day = calendarBeijingDayStart(ts), dow = new Date(day + CALENDAR_BJ_OFFSET).getUTCDay();
  return day + (dow === 0 ? -6 : 1 - dow) * CALENDAR_DAY;
}
// Past events are visible only through “Yesterday”. Every other shortcut is
// clamped to the current instant, including “All” and custom ranges.
function calendarRangeWindow(range) {
  const now = Date.now();
  const today = calendarBeijingDayStart(now);
  switch (range) {
    case "yesterday": return [today - CALENDAR_DAY, today];
    case "tomorrow": return [today + CALENDAR_DAY, today + 2 * CALENDAR_DAY];
    case "week": { const w = calendarWeekStart(today); return [Math.max(now, w), w + 7 * CALENDAR_DAY]; }
    case "nextweek": { const w = calendarWeekStart(today) + 7 * CALENDAR_DAY; return [w, w + 7 * CALENDAR_DAY]; }
    // v2.12.46：「全部」= 服务端保留窗口内的已公布（近 4 天）＋ 全部未来。
    // 今天以前的部分在列表里默认折叠成一行（见 calendarReleasedExpanded），
    // 所以「即将发生」仍是第一眼内容，昨天 CPI 这类刚公布的也还能翻出来看。
    case "all": return [now - 4 * CALENDAR_DAY, Infinity];
    case "custom": {
      const from = calendarBeijingDateToMs(investmentCalendarFrom), to = calendarBeijingDateToMs(investmentCalendarTo);
      return [Math.max(now, Number.isFinite(from) ? from : now), Number.isFinite(to) ? to + CALENDAR_DAY : Infinity];
    }
    default: return [now, today + CALENDAR_DAY];
  }
}
/* v2.12.46：常用 6 个平铺，「自定义日期」收进一个日历图标按钮 ——
   只在选中它时才展开起止日期输入，工具栏不再被 7 个等重按钮铺满。 */
const CALENDAR_RANGES = [
  ["today", "今天", "Today"], ["tomorrow", "明天", "Tomorrow"], ["yesterday", "昨天", "Yesterday"],
  ["week", "本周", "This week"], ["nextweek", "下周", "Next week"], ["all", "全部", "All"],
];
const CALENDAR_CUSTOM_RANGE = ["custom", "自定义日期", "Custom"];
const CALENDAR_CAL_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-width="1.4" d="M2.6 3.6h10.8v9.8H2.6zM2.6 6.6h10.8M5.6 2.2v2.6M10.4 2.2v2.6"/><path fill="currentColor" d="M4.7 8.4h1.6v1.6H4.7zM7.2 8.4h1.6v1.6H7.2zM9.7 8.4h1.6v1.6H9.7z"/></svg>';
const CALENDAR_IMPORTANCE = [["high", "高", "High"], ["medium", "中", "Medium"], ["low", "低", "Low"]];
function calendarWindow(event) {
  const diff = Number(event.at) - Date.now();
  const liquidity = event.category === "liquidity";
  if (/FOMC|美联储利率决议/.test(String(event.title || ""))) return ["宏观核心", "FOMC（联邦公开市场委员会）决定政策利率并发布政策声明；BTC 通常通过美元、实际利率与风险偏好间接受影响", event.importance === "high"];
  if (event.importance === "high" && diff > 0 && diff < 4 * 3_600_000) return [liquidity ? "流动性窗口" : "高波动窗口", liquidity ? "临近财政部操作；关注规模、期限桶及美债利率反应，不预设 BTC 方向" : "发布前 4 小时：避免追单，降低杠杆与仓位集中度", true];
  if (event.importance === "high" && diff > 0 && diff < 24 * 3_600_000) return [liquidity ? "流动性关注" : "风险关注", liquidity ? "24 小时内财政部流动性节点；跟踪操作结果与收益率曲线反应" : "24 小时内高敏感宏观事件；等待预期差确认", true];
  /* v2.12.51：高重要性事件 24–72h 预警档。非农 / CPI 这类第一梯队宏观事件常在 1–3 天前就出现在日历里，
     旧逻辑 24h 窗一过就掉进「常规监控」，用户会误以为不重要（2026-10-01 反馈）。 */
  if (event.importance === "high" && diff > 0 && diff < 72 * 3_600_000) return [liquidity ? "流动性预警" : "重点关注", liquidity ? "72 小时内财政部流动性节点；提前跟踪操作安排与美债利率反应" : "72 小时内高影响宏观事件（非农 / CPI 等）；提前评估仓位与杠杆，临近 24 小时转入风险关注", true];
  if (diff <= 0 && diff > -2 * 3_600_000) return ["数据窗口", "数据刚公布，先观察实际值相对预期的偏差", true];
  return [event.category === "chain" || event.category === "crypto" ? "加密观察" : event.category === "liquidity" ? "流动性观察" : "常规监控", event.directional || "不单独构成方向信号", false];
}
function calendarEventTitle(title) {
  const raw=String(title || "");
  const exact={
    "Producer Price Index":"美国生产者价格指数（PPI） · Producer Price Index",
    "Consumer Price Index":"美国消费者价格指数（CPI） · Consumer Price Index",
    "Employment Situation":"美国非农就业报告 · Employment Situation",
    "U.S. Import and Export Price Indexes":"美国进出口价格指数 · U.S. Import and Export Price Indexes",
    "Deribit BTC 期权到期":"比特币期权到期 · Deribit BTC Options Expiry",
    "BTC 挖矿难度调整":"比特币挖矿难度调整 · Bitcoin Mining Difficulty Adjustment",
    "EIA 美国原油库存周报":"EIA 美国原油库存周报 · EIA Weekly Petroleum Status Report",
    "CFTC COT · 黄金/WTI 持仓":"CFTC 黄金 / WTI 原油持仓 · CFTC Commitments of Traders",
    "FOMC 利率决议":"美国联邦公开市场委员会利率决议（FOMC） · FOMC Rate Decision",
    "美财政部长端流动性回购上限至少翻倍":"美国财政部长端流动性回购上限至少翻倍 · Treasury Long-End Buyback Size Increase",
    "美国 CPI":"美国消费者价格指数（CPI） · US Consumer Price Index",
    "美国非农就业":"美国非农就业报告 · US Employment Situation",
  };
  if (exact[raw]) return exact[raw];
  const auction=raw.match(/^美国\s+(.+?)\s+国债拍卖\s+·\s+(NOTE|BOND)$/i);
  if (auction) {
    const kind=auction[2].toUpperCase() === "NOTE" ? "中期国债 Note（2–10 年）" : "长期国债 Bond（20–30 年）";
    return `美国 ${auction[1]} 国债拍卖（${kind}） · U.S. Treasury ${auction[1]} ${auction[2].toUpperCase()} Auction`;
  }
  const buyback=raw.match(/^美财政部回购\s+·\s+(.+)$/);
  return buyback ? `美国财政部回购（${buyback[1]}） · U.S. Treasury Buyback (${buyback[1]})` : raw;
}
function calendarCountry(code) {
  const map = {
    US:{flag:"US",emoji:"🇺🇸",label:tx("美国","US"),cls:"c-us"}, CN:{flag:"CN",emoji:"🇨🇳",label:tx("中国","CN"),cls:"c-cn"},
    EU:{flag:"EU",emoji:"🇪🇺",label:tx("欧元区","EU"),cls:"c-eu"}, JP:{flag:"JP",emoji:"🇯🇵",label:tx("日本","JP"),cls:"c-jp"},
    UK:{flag:"UK",emoji:"🇬🇧",label:tx("英国","UK"),cls:"c-uk"}, DE:{flag:"DE",emoji:"🇩🇪",label:tx("德国","DE"),cls:"c-de"},
    FR:{flag:"FR",emoji:"🇫🇷",label:tx("法国","FR"),cls:"c-fr"}, BR:{flag:"BR",emoji:"🇧🇷",label:tx("巴西","BR"),cls:"c-br"},
    AU:{flag:"AU",emoji:"🇦🇺",label:tx("澳大利亚","AU"),cls:"c-au"}, SG:{flag:"SG",emoji:"🇸🇬",label:tx("新加坡","SG"),cls:"c-sg"},
    CA:{flag:"CA",emoji:"🇨🇦",label:tx("加拿大","CA"),cls:"c-ca"}, KR:{flag:"KR",emoji:"🇰🇷",label:tx("韩国","KR"),cls:"c-kr"},
    IN:{flag:"IN",emoji:"🇮🇳",label:tx("印度","IN"),cls:"c-in"}, RU:{flag:"RU",emoji:"🇷🇺",label:tx("俄罗斯","RU"),cls:"c-ru"},
    OPEC:{flag:"OPEC",emoji:"🛢",label:tx("OPEC","OPEC"),cls:"c-opec"}, CH:{flag:"CH",emoji:"🇨🇭",label:tx("瑞士","CH"),cls:"c-ch"},
    IT:{flag:"IT",emoji:"🇮🇹",label:tx("意大利","IT"),cls:"c-it"}, ES:{flag:"ES",emoji:"🇪🇸",label:tx("西班牙","ES"),cls:"c-es"},
    MX:{flag:"MX",emoji:"🇲🇽",label:tx("墨西哥","MX"),cls:"c-mx"}, TR:{flag:"TR",emoji:"🇹🇷",label:tx("土耳其","TR"),cls:"c-tr"},
    ZA:{flag:"ZA",emoji:"🇿🇦",label:tx("南非","ZA"),cls:"c-za"}, NZ:{flag:"NZ",emoji:"🇳🇿",label:tx("新西兰","NZ"),cls:"c-nz"},
    HK:{flag:"HK",emoji:"🇭🇰",label:tx("中国香港","HK"),cls:"c-hk"}, TW:{flag:"TW",emoji:"",label:tx("中国台湾","Taiwan, China"),cls:"c-tw"},
    BTC:{flag:"₿",emoji:"",label:tx("比特币","BTC"),cls:"c-btc"}, OIL:{flag:"OIL",emoji:"🛢",label:tx("能源","Oil"),cls:"c-oil"},
    GLOBAL:{flag:"GLB",emoji:"🌐",label:tx("全球","Global"),cls:"c-global"},
  };
  return map[code] || { flag:String(code||"--").slice(0,3).toUpperCase(), emoji:"", label:String(code||"--"), cls:"c-etc" };
}
const CALENDAR_CATEGORIES = [
  ["macro", "宏观", "Macro", "cat-macro"],
  ["liquidity", "流动性", "Liquidity", "cat-liquidity"],
  ["energy", "能源", "Energy", "cat-energy"],
  ["risk", "避险", "Risk", "cat-risk"],
  ["crypto", "加密期权", "Crypto", "cat-crypto"],
  ["chain", coinLabel() + " 链上", coinLabel() + " chain", "cat-chain"],
];
function calendarCategoryMeta(key) {
  const row = CALENDAR_CATEGORIES.find((entry) => entry[0] === key);
  return row ? { key:row[0], label:tx(row[1],row[2]), cls:row[3] } : { key, label:key, cls:"cat-macro" };
}
function calendarImportanceDots(event) {
  const stars = event.importance === "high" ? 3 : event.importance === "medium" ? 2 : 1;
  return [1,2,3].map((n) => `<i class="ic-dot${n<=stars?" on":""}"></i>`).join("");
}
function calendarFlagHtml(code) {
  const country = calendarCountry(code);
  const mark = country.emoji ? `<i class="cal-flag-emoji">${country.emoji}</i>` : "";
  return `<span class="cal-flag ${country.cls}" title="${calendarEscape(country.label)}">${mark}<em class="cal-flag-code">${calendarEscape(country.flag)}</em></span>`;
}

/* —— Data-reaction playbook ——
   Directional maps for the four assets the user asked about. These are
   heuristics built on the common "surprise vs consensus" logic, not
   certainties; the UI states that explicitly. */
const CALENDAR_IMPACT_ASSETS = [["btc","比特币","Bitcoin"],["crypto","加密货币","Crypto"],["stocks","美股","US stocks"],["gold","黄金","Gold"]];
function calendarImpactFamily(title) {
  const t = String(title || "").toLowerCase();
  if (/失业率|unemploy|失业金|jobless|初请/.test(t)) return "unemployment";
  if (/cpi|ppi|pce|物价|通胀|消费者价格|生产者价格|inflation|price index/.test(t)) return "inflation";
  if (/利率|fomc|rate decision|央行|决议|interest rate|benchmark rate|议息/.test(t)) return "rates";
  if (/非农|就业|payroll|employment/.test(t)) return "jobs";
  if (/原油库存|eia|petroleum|库存|opec|钻井/.test(t)) return "energy";
  if (/gdp|零售|销售|retail|gross domestic|pmi|工业|景气|制造业|商业活动/.test(t)) return "growth";
  if (/回购|buyback/.test(t)) return "liquidity-op";
  return null;
}
const CALENDAR_IMPACT_MODELS = {
  inflation: { label:"通胀", note:"通胀高于预期 → 紧缩预期与实际利率上行，通常压制 BTC、加密货币、美股与黄金。",
    high:{btc:-1,crypto:-1,stocks:-1,gold:-1}, low:{btc:1,crypto:1,stocks:1,gold:1} },
  rates: { label:"利率", note:"政策利率高于预期（偏鹰）→ 美元与实际利率走强，压制 BTC、加密货币、美股与黄金。",
    high:{btc:-1,crypto:-1,stocks:-1,gold:-1}, low:{btc:1,crypto:1,stocks:1,gold:1} },
  unemployment: { label:"失业率", note:"失业率高于预期 → 就业转弱、降息预期升温，利好 BTC、加密货币、美股与黄金。",
    high:{btc:1,crypto:1,stocks:1,gold:1}, low:{btc:-1,crypto:-1,stocks:-1,gold:-1} },
  jobs: { label:"就业", note:"就业强于预期 → 经济有韧性但紧缩预期升温，股市多空拉锯，BTC、加密货币与黄金承压。",
    high:{btc:-1,crypto:-1,stocks:0,gold:-1}, low:{btc:1,crypto:1,stocks:0,gold:1} },
  growth: { label:"增长", note:"增长强于预期 → 风险偏好回暖，利好 BTC、加密货币与美股；黄金主要看实际利率，方向有限。",
    high:{btc:1,crypto:1,stocks:1,gold:0}, low:{btc:-1,crypto:-1,stocks:-1,gold:1} },
  energy: { label:"能源", note:"能源类数据以原油供需为主，对 BTC、加密货币、美股与黄金通常无直接方向。",
    high:{btc:0,crypto:0,stocks:0,gold:0}, low:{btc:0,crypto:0,stocks:0,gold:0} },
  "liquidity-op": { label:"流动性操作", note:"财政部回购是向长端注入流动性的支持操作：规模落地越大，对风险资产流动性越友好。实际操作规模在操作结束后于 TreasuryDirect 公布，免费日历源通常不回填数字，故「今值」多为「操作后公布」。",
    high:{btc:1,crypto:1,stocks:1,gold:0}, low:{btc:-1,crypto:-1,stocks:-1,gold:0} },
};
function calendarImpactModel(event) {
  const family = calendarImpactFamily(event.title);
  if (!family) return null;
  const model = CALENDAR_IMPACT_MODELS[family];
  return { family, label:model.label, note:model.note, high:model.high, low:model.low };
}
function calendarImpactDir(value) {
  if (value > 0) return { kind:"bull", label:tx("利好","Bullish") };
  if (value < 0) return { kind:"bear", label:tx("利空","Bearish") };
  return { kind:"flat", label:tx("中性","Neutral") };
}
// Directional events for the playbook. Upcoming releases come first (they are the
// actionable ones), then the most recent releases so a just-published print still
// shows which scenario actually landed.
function calendarImpactEvents(limit = 3, filters = {}) {
  const { regions = null, categories = null, importance = null } = filters;
  const now = Date.now();
  const pool = (investmentCalendarData?.events || [])
    .filter((event) => event.category === "macro")
    .filter((event) => !importance || importance.size === 0 || importance.has(event.importance || "low"))
    .filter((event) => !regions || regions.size === 0 || regions.has(event.country || "GLOBAL"))
    .filter((event) => !categories || categories.size === 0 || categories.has(event.category || "macro"))
    .filter((event) => event.at >= now - 18 * 3_600_000 && event.at <= now + 14 * CALENDAR_DAY)
    .filter((event) => calendarImpactModel(event));
  const rank = (event) => (event.importance === "high" ? 0 : 1);
  const upcoming = pool.filter((event) => event.at >= now).sort((a, b) => (rank(a) - rank(b)) || (a.at - b.at));
  const recent = pool.filter((event) => event.at < now).sort((a, b) => (rank(a) - rank(b)) || (b.at - a.at));
  return [...upcoming, ...recent].slice(0, limit);
}
function renderImpactCard(event, compact = false) {
  const model = calendarImpactModel(event);
  if (!model) return "";
  const released = event.at <= Date.now();
  const actualN = macroParseNumber(event.actual), estimateN = macroParseNumber(event.estimate);
  const liveKey = released && actualN != null && estimateN != null && Math.abs(actualN - estimateN) > 1e-9
    ? (actualN > estimateN ? "high" : "low") : null;
  const when = event.timePrecision === "date"
    ? tx("日期待定","Date TBD")
    : `${calendarFormatBeijing(event.at,{month:"2-digit",day:"2-digit"})} ${calendarFormatBeijing(event.at,{hour:"2-digit",minute:"2-digit",hour12:false})} ${tx("北京","Beijing")}`;
  const impLabel = (CALENDAR_IMPORTANCE.find(([k]) => k === event.importance) || ["low", tx("低","Low"), "Low"])[1];
  const head = CALENDAR_IMPACT_ASSETS.map(([asset,zh,en]) => `<th class="asset-${asset}">${tx(zh,en)}</th>`).join("");
  const row = (key, label) => {
    const dirs = model[key];
    const cells = CALENDAR_IMPACT_ASSETS.map(([asset]) => {
      const dir = calendarImpactDir(dirs[asset]);
      return `<td class="${dir.kind} asset-${asset}">${dir.label}</td>`;
    }).join("");
    return `<tr class="${liveKey === key ? "is-live" : ""}"><th>${tx(label[0],label[1])}${liveKey === key ? `<em>${tx("已公布","Released")}</em>` : ""}</th>${cells}</tr>`;
  };
  const actualLine = released && event.actual
    ? `<p class="ic-impact-actual">${tx("已公布","Released")} <b>${calendarEscape(String(event.actual))}</b>${estimateN != null ? ` · ${tx("预期","Est")} ${calendarEscape(String(event.estimate))}` : ""}</p>`
    : "";
  return `<article class="ic-impact-card${compact ? " is-compact" : ""}">
    <header class="ic-impact-top">
      ${calendarFlagHtml(event.country)}
      <div class="ic-impact-title"><b>${calendarEscape(calendarEventTitle(event.title))}</b><span>${calendarEscape(when)} · ${tx("影响力","Impact")} ${calendarEscape(model.label)} · ${tx("重要等级","Importance")} ${calendarEscape(impLabel)}</span></div>
      <span class="cal-impact imp-${event.importance}" title="${tx(impLabel, impLabel)}">${calendarImportanceDots(event)}<em>${calendarEscape(impLabel)}</em></span>
    </header>
    ${actualLine}
    <table class="ic-impact-matrix">
      <thead><tr><th>${tx("情景","Scenario")}</th>${head}</tr></thead>
      <tbody>${row("high", ["高于预期","Above est"])}${row("low", ["低于预期","Below est"])}</tbody>
    </table>
    ${compact ? "" : `<p class="ic-impact-note">${calendarEscape(model.note)}</p>`}
  </article>`;
}

/* v2.11.0：事件行的稳定 key，用于「影响预测」展开状态在重渲染间保持。 */
function calendarEventRowKey(event) {
  return `${Number(event.at)}|${String(event.title || event.name || "")}`;
}

function renderCalendarEventRow(event, autoPinnedKey = "") {
  const pickKey = macroCalendarPickKey(event);
  const isAutoPinned = pickKey === autoPinnedKey;
  const country = calendarCountry(event.country);
  const category = calendarCategoryMeta(event.category);
  const [label, read, hot] = calendarWindow(event);
  const bias = macroEventBias(event);
  // Primary line: Beijing wall-clock date + time. Secondary line: event local time / ET / UTC.
  const beijingDate = event.timePrecision === "date" ? tx("日期待定","Date TBD") : calendarFormatBeijing(event.at,{month:"numeric",day:"numeric"});
  const beijingTime = event.timePrecision === "date" ? tx("--","--") : calendarFormatBeijing(event.at,{hour:"2-digit",minute:"2-digit",hour12:false});
  const refZone = investmentCalendarTimeZone === "local" ? calendarLocalZone(event.country) : investmentCalendarTimeZone;
  const refLabel = investmentCalendarTimeZone === "local" ? calendarLocalLabel(event.country) : investmentCalendarTimeZone === "America/New_York" ? tx("美东","ET") : "UTC";
  const localDate = event.timePrecision === "date" ? tx("待定","TBD") : calendarFormatInZone(event.at,refZone,{month:"numeric",day:"numeric"});
  const localTime = event.timePrecision === "date" ? tx("--","--") : calendarFormatInZone(event.at,refZone,{hour:"2-digit",minute:"2-digit",hour12:false});
  const eventCountdown = event.timePrecision === "date" ? tx("官方已给日期","Official date") : event.at < Date.now() ? tx("已发布","Released") : `${tx("距今","In ")} ${macroCountdown(event.at)}`;
  const met = (value, field) => {
    const placeholder = field==="actual"
      ? (event.at > Date.now() && event.category==="macro" ? tx("待公布","Pending") : event.category==="liquidity" ? tx("操作后公布","After op") : tx("不适用","N/A"))
      : field==="estimate"
      ? (event.category==="macro" ? tx("无免费共识","No consensus") : tx("不适用","N/A"))
      : (event.category==="macro" ? tx("官方未提供","—") : tx("不适用","N/A"));
    return (value===null||value===undefined||value==="")
      ? `<span class="ic-met-val empty">${calendarEscape(placeholder)}</span>`
      : `<span class="ic-met-val">${calendarEscape(String(value))}</span>`;
  };
  const expandable = Boolean(calendarImpactModel(event));
  const rowKey = calendarEventRowKey(event);
  const expanded = expandable && calendarExpandedRows.has(rowKey);
  const releasedRow = event.at <= Date.now();
  return `<li class="cal-event${hot?" is-hot":""}${isAutoPinned?" is-pinned":""}${releasedRow && macroHasActual(event)?" is-released":""}${expandable?" is-expandable":""}${expanded?" is-expanded":""}" data-cal-key="${calendarEscape(pickKey)}"${expandable?` data-cal-expand="${calendarEscape(rowKey)}"`:""} data-category="${calendarEscape(event.category||"")}">
    <div class="cal-when">
      <span class="cal-datetime"><span class="cal-date">${calendarEscape(beijingDate)}</span><span class="cal-time">${calendarEscape(beijingTime)}</span></span>
      <span class="cal-localtime">${calendarEscape(refLabel)} ${calendarEscape(localDate)} ${calendarEscape(localTime)}</span>
      <span class="cal-countdown calendar-countdown" data-calendar-at="${Number(event.at)}" data-calendar-time-precision="${calendarEscape(event.timePrecision||"time")}">${eventCountdown}</span>
    </div>
    ${calendarFlagHtml(event.country)}
    <div class="cal-main">
      <div class="cal-name"><span class="cal-cat ${category.cls}">${calendarEscape(category.label)}</span>${calendarEscape(calendarEventTitle(event.title))}${event.fallback?"<em class=\"cal-fallback\">节奏回退</em>":""}${bias && bias.kind !== "muted" ? `<span class="macro-cmp-tag ${bias.kind}" title="${calendarEscape(bias.tip)}">${calendarEscape(bias.label)}</span>` : ""}</div>
      <div class="cal-sub">${calendarEscape(event.source||"--")}</div>
    </div>
    <div class="cal-impact imp-${event.importance}" title="${event.importance==="high"?tx("高重要","High"):event.importance==="medium"?tx("中重要","Medium"):tx("低重要","Low")}">${calendarImportanceDots(event)}</div>
    <span class="ic-met is-actual"><b>${tx("今值","Act")}</b>${met(event.actual,"actual")}</span>
    <span class="ic-met is-est"><b>${tx("预期","Est")}</b>${met(event.estimate,"estimate")}</span>
    <span class="ic-met is-prev"><b>${tx("前值","Prev")}</b>${met(event.previous,"previous")}</span>
    <div class="cal-read ${hot?"is-hot":""}"><b>${label}</b><span title="${calendarEscape(read)}">${calendarEscape(read)}</span>${expandable?`<i class="cal-expand-caret" title="${calendarEscape(tx("展开影响预测矩阵","Expand impact matrix"))}"></i>`:""}</div>
  </li>`;
}

function investmentCalendarTimelineEvents() {
  const base = investmentCalendarData?.events || [];
  const curated = majorEventsView()
    .filter((event) => event.curated)
    .map((event) => ({
      at: event.at,
      title: event.name,
      country: event.country,
      category: event.category,
      importance: event.importance,
      actual: event.actual,
      estimate: event.estimate,
      previous: event.previous,
      source: tx("重大事件维护", "Curated major event"),
      timePrecision: "time",
      majorEvent: true,
    }));
  const seen = new Set(base.map((event) => `${calendarBeijingDayKey(event.at)}|${String(event.title || event.name || "").trim().toLowerCase()}`));
  return [...base, ...curated.filter((event) => {
    const key = `${calendarBeijingDayKey(event.at)}|${String(event.title || "").trim().toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  })];
}
function renderCalendarField(kind, label, options, selected) {
  const open = calendarOpenMenu === kind;
  const valueText = selected.size === 0
    ? tx("全部","All")
    : selected.size === 1
    ? (options.find((option) => option.key === [...selected][0])?.label || tx("已选 1 项","1 selected"))
    : tx(`已选 ${selected.size} 项`, `${selected.size} selected`);
  const query = String(calendarMenuSearch[kind] || "").trim().toLowerCase();
  const rows = options.filter((option) => !query || `${option.label} ${option.key}`.toLowerCase().includes(query));
  return `<div class="ic-field" data-field="${kind}">
    <span class="ic-field-label">${calendarEscape(label)}</span>
    <button type="button" class="ic-select${selected.size?" has-value":""}" data-menu-toggle="${kind}">
      <span class="ic-select-value">${calendarEscape(valueText)}</span><i class="ic-caret${open?" up":""}"></i>
    </button>
    <div class="ic-menu"${open?"":" hidden"}>
      <div class="ic-menu-head">
        <input type="search" class="ic-menu-search" data-menu-search="${kind}" value="${calendarEscape(calendarMenuSearch[kind]||"")}" placeholder="${tx("搜索…","Search…")}" autocomplete="off">
        <div class="ic-menu-actions"><button type="button" data-menu-all="${kind}">${tx("全选","All")}</button><button type="button" data-menu-clear="${kind}">${tx("全部清除","Clear")}</button></div>
      </div>
      <ul class="ic-menu-list">${rows.length
        ? rows.map((option) => `<li data-search-text="${calendarEscape(`${option.label} ${option.key}`.toLowerCase())}"><label class="ic-opt"><input type="checkbox" data-opt-field="${kind}" data-opt-key="${calendarEscape(option.key)}"${selected.has(option.key)?" checked":""}><span class="ic-opt-label">${option.html || calendarEscape(option.label)}</span>${option.count!=null?`<em>${option.count}</em>`:""}</label></li>`).join("")
        : `<li class="ic-menu-empty">${tx("无匹配项","No match")}</li>`}</ul>
    </div>
  </div>`;
}
function renderReleasedDataField(kind, label, options, selected) {
  const open = releasedDataOpenMenu === kind;
  const valueText = selected.size === 0
    ? tx("全部","All")
    : selected.size === 1
    ? (options.find((option) => option.key === [...selected][0])?.label || tx("已选 1 项","1 selected"))
    : tx(`已选 ${selected.size} 项`, `${selected.size} selected`);
  const query = String(releasedDataMenuSearch[kind] || "").trim().toLowerCase();
  const rows = options.filter((option) => !query || `${option.label} ${option.key}`.toLowerCase().includes(query));
  return `<div class="ic-field rd-field" data-field="${kind}">
    <span class="ic-field-label">${calendarEscape(label)}</span>
    <button type="button" class="ic-select${selected.size?" has-value":""}" data-released-menu-toggle="${kind}">
      <span class="ic-select-value">${calendarEscape(valueText)}</span><i class="ic-caret${open?" up":""}"></i>
    </button>
    <div class="ic-menu"${open?"":" hidden"}>
      <div class="ic-menu-head">
        <input type="search" class="ic-menu-search" data-released-menu-search="${kind}" value="${calendarEscape(releasedDataMenuSearch[kind]||"")}" placeholder="${tx("搜索…","Search…")}" autocomplete="off">
        <div class="ic-menu-actions"><button type="button" data-released-menu-all="${kind}">${tx("全选","All")}</button><button type="button" data-released-menu-clear="${kind}">${tx("全部清除","Clear")}</button></div>
      </div>
      <ul class="ic-menu-list">${rows.length
        ? rows.map((option) => `<li data-search-text="${calendarEscape(`${option.label} ${option.key}`.toLowerCase())}"><label class="ic-opt"><input type="checkbox" data-released-opt-field="${kind}" data-released-opt-key="${calendarEscape(option.key)}"${selected.has(option.key)?" checked":""}><span class="ic-opt-label">${option.html || calendarEscape(option.label)}</span>${option.count!=null?`<em>${option.count}</em>`:""}</label></li>`).join("")
        : `<li class="ic-menu-empty">${tx("无匹配项","No match")}</li>`}</ul>
    </div>
  </div>`;
}
/* v2.11.6 / v2.11.9：研究类面板必须按固定次序连排 ——
   研究预测 → 宏观事件中枢 → 宏观环境与跨市场联动。
   这几张卡由不同异步流程创建/重渲（研究卡约 1s、日历约 3.6s、宏观卡每 10 分钟整卡重渲），
   任一被其他布局逻辑移动后这里负责拉回。链式校正对尚未创建的卡片自动跳过，
   幂等，可安全重复调用。 */
function syncMacroPanels() {
  const chain = [
    $("researchOutlookCard"),
    $("investmentCalendarCard"),
    $("fedMonitorCard"),
  ].filter(Boolean);
  for (let i = 0; i < chain.length - 1; i += 1) {
    if (chain[i].nextElementSibling !== chain[i + 1]) chain[i].after(chain[i + 1]);
  }
}
function renderInvestmentCalendar(data) {
  investmentCalendarData = data || investmentCalendarData;
  let card = $("investmentCalendarCard");
  if (!card) {
    card = document.createElement("section");
    card.id = "investmentCalendarCard";
    card.className = "card investment-calendar-card";
    // 阅读顺序（v2.11.0）：BTC 多因子研究 → 宏观事件中枢 → 宏观环境与联动。
    const research = $("researchOutlookCard"),
      fed = $("fedMonitorCard"),
      anchor = $("fearGreedGauge");
    if (research) research.after(card);
    else if (fed) fed.before(card);
    else if (anchor) anchor.after(card);
    else document.querySelector("main")?.append(card);
  }
  if (!card) return;
  /* v2.11.6：数据到位后校正两张宏观卡的相邻顺序（fed 卡首次挂载时日历卡
     可能尚未加载完，会走 main 末尾兜底）。 */
  syncMacroPanels();

  const allEvents = investmentCalendarTimelineEvents();
  const [rangeStart, rangeEnd] = calendarRangeWindow(investmentCalendarRange);
  // Counts are computed over the time window only, so the menus keep showing how
  // many events each option would add even while other filters are active.
  const timeFiltered = allEvents.filter((event) => event.at >= rangeStart && event.at < rangeEnd);
  const events = timeFiltered
    .filter(investmentCalendarMatchesSelectors)
    .sort((a, b) => a.at - b.at);
  /* v2.12.46：「全部」视图里，今天以前已公布的条目默认折成一行。
     折叠时列表只铺今天及以后（「即将发生」第一眼可见），展开后全部铺开。 */
  const todayStart = calendarBeijingDayStart(Date.now());
  const foldReleased = investmentCalendarRange === "all";
  const foldedReleased = foldReleased ? events.filter((event) => event.at < todayStart) : [];
  const releasedFoldedNow = foldedReleased.length > 0 && !calendarReleasedExpanded;
  const activeEvents = releasedFoldedNow ? events.filter((event) => event.at >= todayStart) : events;
  const visibleEvents = activeEvents.slice(0, investmentCalendarVisibleLimit);
  /* 顶部「关注宏观事件实时数据」当前展示的那条，在列表里高亮标出，两处口径一致。 */
  const pinnedEvent = macroCalendarPickedLiveEvent();
  const autoPinnedKey = pinnedEvent ? macroCalendarPickKey(pinnedEvent) : "";
  const countBy = (list, pick) => list.reduce((acc, event) => { const key = pick(event); acc.set(key, (acc.get(key) || 0) + 1); return acc; }, new Map());
  const countryCounts = countBy(timeFiltered, (event) => event.country || "GLOBAL");
  const categoryCounts = countBy(timeFiltered, (event) => event.category || "macro");
  const importanceCounts = countBy(timeFiltered, (event) => event.importance || "low");

  const nearestHigh = events.find((event) => event.importance === "high" && event.at >= Date.now())
    || timeFiltered.find((event) => event.importance === "high" && event.at >= Date.now());
  const [riskLabel, riskText] = nearestHigh ? calendarWindow(nearestHigh) : ["风险平稳", "当前时间窗内暂无高重要性事件"];

  const provider = investmentCalendarData?.provider || {};
  const sourceText = provider.domesticAvailable
    ? tx("东方财富 · TradingView · FinanceCalendar · 美联储/BLS · 财政部 · EIA · Deribit", "Eastmoney · TradingView · FinanceCalendar · Fed/BLS · Treasury · EIA · Deribit")
    : (provider.finnhubConfigured ? "Finnhub 已接入" : tx("官方日历 · 财政部 · EIA · Deribit", "Official · Treasury · EIA · Deribit"));
  const fetchedAt = investmentCalendarData?.fetchedAt;
  const updatedLabel = fetchedAt ? `${tx("更新于", "Updated")} ${calendarFormatBeijing(fetchedAt, { month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", hour12:false })}` : "";

  const todayKey = calendarBeijingDayKey(Date.now());
  const dayKey = (at) => calendarFormatBeijing(at, { year:"numeric", month:"long", day:"numeric", weekday:"short" });
  let previousDay = "", listHtml = "";
  const nowMs = Date.now();
  if (!activeEvents.length) {
    listHtml = `<li class="cal-empty">${tx("该时间范围内暂无符合条件的更新。", "No events match the current filters in this range.")}</li>`;
  } else {
    listHtml += `<li class="cal-head">
      <span>${tx("时间","Time")}</span><span>${tx("国家","Country")}</span><span>${tx("事件","Event")}</span><span>${tx("重要性","Impact")}</span>
      <span>${tx("今值","Actual")}</span><span>${tx("预期","Forecast")}</span><span>${tx("前值","Previous")}</span><span>${tx("影响","Note")}</span>
    </li>`;
  }
  /* v2.12.46：今天以前已公布的条目在这里折成一行 —— 默认不占版面，
     点一下把近几天的实际值与偏差结论整段铺开。 */
  /* 这行始终保留 —— 折叠时是「点开回看」，展开后变成「收起」，
     否则用户一旦点开就再也收不回去（只能切时间范围重来）。 */
  if (foldedReleased.length > 0) {
    listHtml += `<li class="cal-fold"><button type="button" class="cal-fold-btn${calendarReleasedExpanded ? " is-open" : ""}" data-calendar-fold aria-expanded="${calendarReleasedExpanded}">
      <i class="ic-caret${calendarReleasedExpanded ? " up" : ""}"></i>
      <b>${tx("已公布", "Released")}</b>
      <span>${calendarReleasedExpanded
        ? tx(`已展开今天以前 ${foldedReleased.length} 条，点这里收起`, `${foldedReleased.length} earlier releases shown — click to fold`)
        : tx(`今天以前 ${foldedReleased.length} 条已折叠，点开可回看实际值与偏差结论`, `${foldedReleased.length} earlier releases folded — expand to review actuals and verdicts`)}</span>
    </button></li>`;
  }
  /* v2.11.0：时间流。「现在」线把今天一分为二：上方已公布、下方即将发布。 */
  const rangeHasNow = activeEvents.some((event) => event.at <= nowMs) && activeEvents.some((event) => event.at > nowMs);
  let nowLineDrawn = false;
  for (const event of visibleEvents) {
    const day = dayKey(event.at);
    if (day !== previousDay) {
      previousDay = day;
      const isToday = calendarBeijingDayKey(event.at) === todayKey;
      listHtml += `<li class="cal-day"><span class="cal-day-name">${calendarEscape(day)}</span>${isToday ? '<em class="cal-day-today">今天</em>' : ""}</li>`;
    }
    if (rangeHasNow && !nowLineDrawn && event.at > nowMs) {
      nowLineDrawn = true;
      listHtml += `<li class="cal-now"><span>${tx("现在", "Now")} ${calendarFormatBeijing(nowMs, { hour:"2-digit", minute:"2-digit", hour12:false })}</span></li>`;
    }
    listHtml += renderCalendarEventRow(event, autoPinnedKey);
    const rowKey = calendarEventRowKey(event);
    if (calendarExpandedRows.has(rowKey)) {
      const impact = renderImpactCard(event);
      if (impact) listHtml += `<li class="cal-detail">${impact}</li>`;
    }
  }

  const tzButtons = [
    ["local", tx("当地","Local")], ["America/New_York", tx("美东","ET")], ["UTC", "UTC"],
  ];
  const countryOrder = ["US","CN","EU","JP","UK","DE","FR","BR","AU","CA","KR","IN","RU","CH","IT","ES","MX","TR","ZA","NZ","SG","HK","TW","OPEC","GLOBAL","BTC","OIL"];
  const countryOptions = [...countryCounts.entries()].sort((a, b) => {
    const ia = countryOrder.indexOf(a[0]), ib = countryOrder.indexOf(b[0]);
    const ra = ia < 0 ? 1e9 : ia, rb = ib < 0 ? 1e9 : ib;
    return ra !== rb ? ra - rb : String(a[0]).localeCompare(String(b[0]));
  }).map(([code, count]) => {
    const info = calendarCountry(code);
    return { key:code, label:info.label, count, html:`${info.emoji?`<i class="ic-opt-flag">${info.emoji}</i>`:""}<span>${calendarEscape(info.label)}</span>` };
  });
  const categoryOptions = CALENDAR_CATEGORIES.filter(([key]) => categoryCounts.get(key)).map(([key, zh, en, cls]) => ({
    key, label:tx(zh,en), count:categoryCounts.get(key), html:`<i class="ic-opt-dot ${cls}"></i><span>${tx(zh,en)}</span>`,
  }));
  const importanceOptions = CALENDAR_IMPORTANCE.filter(([key]) => importanceCounts.get(key)).map(([key, zh, en]) => ({
    key, label:tx(zh,en), count:importanceCounts.get(key),
    html:`<i class="ic-opt-stars imp-${key}">${[1,2,3].map((n) => `<i class="ic-dot${n<=(key==="high"?3:key==="medium"?2:1)?" on":""}"></i>`).join("")}</i><span>${tx(zh,en)}</span>`,
  }));
  const rangeSummary = investmentCalendarRange === "custom"
    ? tx("自定义区间","Custom range")
    : tx(`本区间 ${timeFiltered.length} 项 / 全量 ${allEvents.length} 项`, `${timeFiltered.length} in range / ${allEvents.length} total`);
  const shownNote = releasedFoldedNow
    ? tx(`筛选后 ${events.length} 项（今天以前 ${foldedReleased.length} 条已折叠），已显示 ${visibleEvents.length} 项`, `${events.length} filtered (${foldedReleased.length} earlier releases folded), ${visibleEvents.length} shown`)
    : tx(`筛选后 ${events.length} 项，已显示 ${visibleEvents.length} 项`, `${events.length} filtered, ${visibleEvents.length} shown`);
  const rankText = `${rangeSummary} · ${shownNote}`;
  /* v2.12.46 展开 / 收起控制条简化：一个主按钮（继续展开 ⇄ 收起）+ 一个次级文字链接
     （全部展开）。计数与细进度条同排放在左侧，操作永远在右侧 —— 三种状态共用一行，
     不再出现「三个等重按钮同时挂着、不知道该点哪个」。 */
  const hasMoreEvents = visibleEvents.length < activeEvents.length;
  const isExpanded = investmentCalendarVisibleLimit > INVESTMENT_CALENDAR_BASE_LIMIT;
  const isAllShown = !hasMoreEvents && isExpanded;
  const listScrolls = visibleEvents.length > INVESTMENT_CALENDAR_SCROLL_AFTER;
  const progressPct = activeEvents.length ? Math.round((visibleEvents.length / activeEvents.length) * 100) : 100;
  const moreBar = activeEvents.length > INVESTMENT_CALENDAR_BASE_LIMIT ? `
    <div class="ic-list-more">
      <div class="ic-more-progress" title="${calendarEscape(tx(`已显示 ${visibleEvents.length} / ${activeEvents.length} 条`, `${visibleEvents.length} / ${activeEvents.length} shown`))}">
        <span><b>${tx("已显示", "Showing")} ${visibleEvents.length} / ${activeEvents.length}</b>${isAllShown ? `<em>· ${tx("全部", "all")}</em>` : ""}</span>
        <i class="ic-more-track"><i class="ic-more-fill" style="width:${progressPct}%"></i></i>
      </div>
      <div class="ic-more-actions">
        ${hasMoreEvents ? `<button type="button" class="ic-more-btn" data-calendar-more>${tx(`继续展开 ${INVESTMENT_CALENDAR_STEP} 条`, `Show ${INVESTMENT_CALENDAR_STEP} more`)}<i class="ic-caret"></i></button>` : ""}
        ${hasMoreEvents ? `<button type="button" class="ic-more-link" data-calendar-all>${tx(`全部展开（${activeEvents.length} 条）`, `Show all ${activeEvents.length}`)}</button>` : ""}
        ${isExpanded ? `<button type="button" class="ic-more-link" data-calendar-less><i class="ic-caret up"></i>${isAllShown ? tx("收起全部", "Collapse all") : tx("收起", "Collapse")}</button>` : ""}
      </div>
    </div>` : "";

  card.innerHTML = `
    <header class="ic-header">
      <div class="ic-title">
        <div class="ic-kicker"><i></i>${tx("MACRO EVENT HUB · 宏观事件中枢", "MACRO EVENT HUB · Macro event hub")}</div>
        <h2>${tx("宏观事件中枢", "Macro event hub")}</h2>
        <p>${tx("投资日历、已公布实际值与影响预测合一：今天按时间流排列，「现在」线上方是已公布（实际值已回填并给出偏差结论），下方是即将发布（倒计时 + 预期）。点任意事件行可展开「情景 × 资产」影响预测矩阵。", "Calendar, released actuals and impact playbooks in one place. Today is a time stream: above the “Now” line events are released (actual filled, surprise verdict included), below they are upcoming (countdown + estimate). Click any event row to expand the scenario-by-asset impact matrix.")}</p>
      </div>
      <div class="ic-meta">
        <span class="ic-source">${calendarEscape(sourceText)}</span>
        ${updatedLabel ? `<span class="ic-updated">${updatedLabel}</span>` : ""}
      </div>
    </header>

    <div class="ic-toolbar">
      <div class="ic-ranges">
        ${CALENDAR_RANGES.map(([key,zh,en]) => `<button type="button" class="ic-range${investmentCalendarRange===key?" active":""}" data-calendar-range="${key}">${tx(zh,en)}</button>`).join("")}
        <button type="button" class="ic-range ic-range-icon${investmentCalendarRange==="custom"?" active":""}" data-calendar-range="custom" title="${calendarEscape(tx("自定义日期区间","Custom date range"))}" aria-label="${calendarEscape(tx("自定义日期区间","Custom date range"))}">${CALENDAR_CAL_ICON}</button>
      </div>
      <div class="ic-toolbar-right">
        <button type="button" class="ic-filter-toggle" data-calendar-toggle-ticker>${macroTickerHidden ? tx("显示预警条","Show ticker") : tx("隐藏预警条","Hide ticker")}</button>
        <button type="button" class="ic-filter-toggle" data-calendar-toggle-filters aria-expanded="${investmentCalendarShowFilters}">${tx("筛选器","Filters")}<i class="ic-caret${investmentCalendarShowFilters?" up":""}"></i></button>
      </div>
    </div>

    ${investmentCalendarRange === "custom" ? `<div class="ic-custom">
      <label>${tx("起","From")}<input type="date" data-calendar-from value="${calendarEscape(investmentCalendarFrom)}"></label>
      <label>${tx("止","To")}<input type="date" data-calendar-to value="${calendarEscape(investmentCalendarTo)}"></label>
    </div>` : ""}

    ${investmentCalendarShowFilters ? `<div class="ic-fields">
      ${renderCalendarField("region", tx("国家及地区","Country / region"), countryOptions, investmentCalendarRegions)}
      ${renderCalendarField("category", tx("类别领域","Category"), categoryOptions, investmentCalendarCategories)}
      ${renderCalendarField("importance", tx("重要性","Importance"), importanceOptions, investmentCalendarImportance)}
    </div>` : ""}

    <div class="ic-subbar">
      <span class="ic-clock">${tx("当前时间","Now")} <b data-calendar-clock>--:--:--</b> <em>GMT+8:00</em></span>
      <span class="ic-range-note">${calendarEscape(rankText)}</span>
      <span class="ic-tz-wrap"><i>${tx("参考时区","Reference")}</i>${tzButtons.map(([zone,label]) => `<button type="button" class="ic-tz-btn${investmentCalendarTimeZone===zone?" active":""}" data-calendar-zone="${zone}">${label}</button>`).join("")}</span>
    </div>

    <div class="ic-risk ${nearestHigh?"is-hot":"is-safe"}">
      <span class="ic-risk-label">${riskLabel}</span>
      <span class="ic-risk-text">${calendarEscape(riskText)}</span>
    </div>

    <ul class="ic-list${listScrolls ? " is-scrollable" : ""}">${listHtml}</ul>
    ${listScrolls ? `<div class="ic-scroll-bar"><span>${tx(`列表中已展开 ${visibleEvents.length} 条，框内滚动查看，避免撑长页面`, `${visibleEvents.length} rows expanded — scroll inside the list to keep the page compact`)}</span><button type="button" data-calendar-top>${tx("回到顶部","Back to top")}</button></div>` : ""}
    ${moreBar}

    <footer class="ic-foot">
      <span class="ic-treasury-note">${tx("国债说明：Note 通常为 2–10 年中期国债；Bond 通常为 20–30 年长期国债。已过滤高频短票 Bill。影响预测为宏观常识映射，不构成投资建议。","Treasury note: 2–10y; bond: 20–30y. High-frequency bills filtered out. Impact playbook is general macro mapping, not investment advice.")}</span>
    </footer>`;

  // —— Toolbar wiring ——
  card.querySelectorAll("[data-calendar-range]").forEach((button) => button.addEventListener("click", () => {
    investmentCalendarRange = button.dataset.calendarRange;
    // 离开「全部」后折叠状态无意义，一并归位，下次回到「全部」仍是「即将发生」优先。
    if (investmentCalendarRange !== "all") calendarReleasedExpanded = false;
    resetInvestmentCalendarVisibleLimit();
    calendarOpenMenu = null;
    renderInvestmentCalendar(investmentCalendarData);
  }));
  card.querySelector("[data-calendar-fold]")?.addEventListener("click", () => {
    calendarReleasedExpanded = !calendarReleasedExpanded;
    // 展开时把条数上限整体抬一段，让已公布那批是「多出来」而不是「挤掉后面」。
    if (calendarReleasedExpanded) {
      calendarReleasedBaseLimit = investmentCalendarVisibleLimit;
      investmentCalendarVisibleLimit = calendarReleasedBaseLimit + foldedReleased.length;
    } else if (calendarReleasedBaseLimit) {
      investmentCalendarVisibleLimit = calendarReleasedBaseLimit;
    }
    renderInvestmentCalendar(investmentCalendarData);
  });
  card.querySelector("[data-calendar-toggle-filters]")?.addEventListener("click", () => {
    investmentCalendarShowFilters = !investmentCalendarShowFilters;
    calendarOpenMenu = null;
    renderInvestmentCalendar(investmentCalendarData);
  });
  card.querySelector("[data-calendar-toggle-ticker]")?.addEventListener("click", () => {
    macroTickerHidden = !macroTickerHidden;
    saveMacroTickerHidden();
    renderMacroTicker();
    renderInvestmentCalendar(investmentCalendarData);
  });
  card.querySelectorAll("[data-calendar-zone]").forEach((button) => button.addEventListener("click", () => {
    investmentCalendarTimeZone = button.dataset.calendarZone;
    renderInvestmentCalendar(investmentCalendarData);
  }));
  card.querySelector("[data-calendar-from]")?.addEventListener("change", (e) => { investmentCalendarFrom = e.target.value; resetInvestmentCalendarVisibleLimit(); renderInvestmentCalendar(investmentCalendarData); });
  card.querySelector("[data-calendar-to]")?.addEventListener("change", (e) => { investmentCalendarTo = e.target.value; resetInvestmentCalendarVisibleLimit(); renderInvestmentCalendar(investmentCalendarData); });
  /* v2.11.16 展开 / 全部展开 / 收起。收起后若列表已不在视口内，把它带回视野中央，
     否则用户在长列表深处点「收起」会"掉"在半空、丢失上下文。 */
  card.querySelector("[data-calendar-more]")?.addEventListener("click", () => {
    investmentCalendarVisibleLimit += INVESTMENT_CALENDAR_STEP;
    renderInvestmentCalendar(investmentCalendarData);
  });
  card.querySelector("[data-calendar-all]")?.addEventListener("click", () => {
    investmentCalendarVisibleLimit = Number.MAX_SAFE_INTEGER;
    renderInvestmentCalendar(investmentCalendarData);
  });
  card.querySelector("[data-calendar-less]")?.addEventListener("click", () => {
    resetInvestmentCalendarVisibleLimit();
    calendarReleasedExpanded = false;
    renderInvestmentCalendar(investmentCalendarData);
    const list = $("investmentCalendarCard")?.querySelector(".ic-list");
    const rect = list?.getBoundingClientRect();
    if (rect && (rect.top < 0 || rect.bottom > window.innerHeight)) {
      list.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  });
  card.querySelector("[data-calendar-top]")?.addEventListener("click", () => {
    card.querySelector(".ic-list")?.scrollTo({ top: 0, behavior: "smooth" });
  });
  // —— Filter menus ——
  card.querySelectorAll("[data-menu-toggle]").forEach((button) => button.addEventListener("click", () => {
    const kind = button.dataset.menuToggle;
    calendarOpenMenu = calendarOpenMenu === kind ? null : kind;
    renderInvestmentCalendar(investmentCalendarData);
  }));
  card.querySelectorAll("[data-menu-search]").forEach((input) => input.addEventListener("input", () => {
    const kind = input.dataset.menuSearch, query = input.value.trim().toLowerCase();
    calendarMenuSearch[kind] = input.value;
    // Filter in place so the caret and focus survive the keystroke.
    input.closest(".ic-menu")?.querySelectorAll("li[data-search-text]").forEach((row) => {
      row.hidden = Boolean(query) && !row.dataset.searchText.includes(query);
    });
  }));
  card.querySelectorAll("[data-opt-field]").forEach((box) => box.addEventListener("change", () => {
    const kind = box.dataset.optField, key = box.dataset.optKey;
    const target = kind === "region" ? investmentCalendarRegions : kind === "category" ? investmentCalendarCategories : investmentCalendarImportance;
    if (box.checked) target.add(key); else target.delete(key);
    resetInvestmentCalendarVisibleLimit();
    renderInvestmentCalendar(investmentCalendarData);
  }));
  card.querySelectorAll("[data-menu-all]").forEach((button) => button.addEventListener("click", () => {
    const kind = button.dataset.menuAll;
    const target = kind === "region" ? investmentCalendarRegions : kind === "category" ? investmentCalendarCategories : investmentCalendarImportance;
    const query = String(calendarMenuSearch[kind] || "").trim().toLowerCase();
    button.closest(".ic-menu")?.querySelectorAll("[data-opt-key]").forEach((box) => {
      const row = box.closest("li[data-search-text]");
      if (query && row?.hidden) return;
      target.add(box.dataset.optKey);
    });
    resetInvestmentCalendarVisibleLimit();
    renderInvestmentCalendar(investmentCalendarData);
  }));
  card.querySelectorAll("[data-menu-clear]").forEach((button) => button.addEventListener("click", () => {
    const kind = button.dataset.menuClear;
    const target = kind === "region" ? investmentCalendarRegions : kind === "category" ? investmentCalendarCategories : investmentCalendarImportance;
    const query = String(calendarMenuSearch[kind] || "").trim().toLowerCase();
    if (!query) { target.clear(); resetInvestmentCalendarVisibleLimit(); renderInvestmentCalendar(investmentCalendarData); return; }
    button.closest(".ic-menu")?.querySelectorAll("[data-opt-key]").forEach((box) => {
      const row = box.closest("li[data-search-text]");
      if (row?.hidden) return;
      target.delete(box.dataset.optKey);
    });
    resetInvestmentCalendarVisibleLimit();
    renderInvestmentCalendar(investmentCalendarData);
  }));
  // —— v2.12.46：「关注」勾选已取消（重要事件自动进顶部卡片），此处不再有 pin 绑定。——
  // —— v2.11.0：点事件行展开 / 收起「情景 × 资产」影响预测矩阵 ——
  card.querySelectorAll("li.cal-event[data-cal-expand]").forEach((li) => li.addEventListener("click", (event) => {
    if (event.target.closest("a, button, label")) return;
    const key = li.dataset.calExpand;
    if (calendarExpandedRows.has(key)) calendarExpandedRows.delete(key);
    else calendarExpandedRows.add(key);
    renderInvestmentCalendar(investmentCalendarData);
  }));
  if (!window.__btcCalendarOutsideClickBound) {
    window.__btcCalendarOutsideClickBound = true;
    document.addEventListener("click", (event) => {
      if (!calendarOpenMenu) return;
      // Use the dispatch-time path: interacting with a menu re-renders the card,
      // which detaches event.target, so a live closest() lookup would misfire and
      // close the menu on every checkbox click.
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      const insideField = path.some((node) => node && node.classList && node.classList.contains("ic-field") && !node.classList.contains("rd-field"));
      if (insideField) return;
      calendarOpenMenu = null;
      renderInvestmentCalendar(investmentCalendarData);
    });
  }
  refreshInvestmentCalendarClock();
  // 预警条的取数口径与筛选器无关（只看高重要性），但语言 / 数据刷新要跟着走。
  renderMacroTicker();
}

function refreshInvestmentCalendarClock() {
  const clock = document.querySelector("[data-calendar-clock]");
  if (clock) clock.textContent = calendarFormatBeijing(Date.now(), { hour:"2-digit", minute:"2-digit", second:"2-digit", hour12:false });
}
function refreshInvestmentCalendarCountdowns() {
  document.querySelectorAll(".calendar-countdown[data-calendar-at]").forEach((element) => {
    if (element.dataset.calendarTimePrecision === "date") return;
    const at=Number(element.dataset.calendarAt);
    if (!Number.isFinite(at)) return;
    element.textContent=at < Date.now() ? tx("已发布 / 已过期", "Released / passed") : `${tx("距今", "In ")} ${macroCountdown(at)}`;
  });
  refreshInvestmentCalendarClock();
}
async function loadInvestmentCalendar(force = false) {
  try { const response = await apiFetch(`/api/investment-calendar${force ? "?refresh=1" : ""}`, 12_000), data = await response.json(); if (!response.ok) throw new Error(data.detail || data.error); renderInvestmentCalendar(data); }
  catch { renderInvestmentCalendar(investmentCalendarData); }
  // 数据到位后同步刷新「关注宏观事件实时数据」，并清理已下线卡的残留 DOM（v2.11.0）。
  const fgCard = $("fearGreedGauge");
  if (fgCard && fgCard.isConnected) renderFearGreedGauge();
  renderReleasedDataCard();
}
whenIdle(() => loadMacroCalendarPicks());
whenIdle(() => loadInvestmentCalendar());
// Several legacy cards mount asynchronously; run one settled-layout pass so
// this independent panel is not displaced while those sections are arranging.
window.addEventListener("load", () => setTimeout(loadInvestmentCalendar, 1_500), { once: true });
setInterval(loadInvestmentCalendar, 5 * 60_000);
setInterval(refreshInvestmentCalendarCountdowns, 1_000);

/* ===== v2.12.46 宏观预警滚动条 =========================================
   位置：「我的持仓 + 实时价格」与「K 线 + 当前规则信号」之间那条空带。
   内容：高重要性事件 —— 24 小时内已公布的带实际值与利好/利空标签，
   即将发布的带秒级倒计时，15 分钟内发布的整条脉冲高亮。
   交互：无缝横向滚动（悬停暂停），点某一条 = 把顶部「关注宏观事件实时数据」
   切到该事件；右侧 ✕ 收起整条（可从「宏观事件中枢」工具栏再打开）。
   ======================================================================= */
const MACRO_TICKER_MAX = 16;
const MACRO_TICKER_LOOKBACK_MS = 24 * 3_600_000;
const MACRO_TICKER_LOOKAHEAD_MS = 7 * 86_400_000;   // 同 MACRO_PIN_LOOKAHEAD_MS，写死毫秒避开 TDZ
const MACRO_TICKER_IMMINENT_MS = 15 * 60_000;
/* v2.12.55：未来 24 小时内即将公布的事件用琥珀色呼吸闪烁提示「快出结果了」；
   15 分钟内仍沿用更高频的 is-imminent 红色闪烁，两级动效不叠加。 */
const MACRO_TICKER_SOON_MS = 24 * 3_600_000;

/* 滚动条与顶部卡片共用同一份候选池（macroPinCandidates），只在这里收窄时间窗。
   已公布的事件只有在真的回填到实际值时才留 —— 免费源很多条目只有时间没有数值，
   留着只会变成「已公布」三个字的噪音，而这条滚动带的本职是「提示即将发生」。 */
function macroTickerItems() {
  const now = Date.now();
  return macroPinCandidates()
    .filter((event) => Number(event.at) >= now - MACRO_TICKER_LOOKBACK_MS)
    .filter((event) => Number(event.at) <= now + MACRO_TICKER_LOOKAHEAD_MS)
    .filter((event) => Number(event.at) > now || macroHasActual(event))
    .slice(0, MACRO_TICKER_MAX);
}
/* 事件标题两种写法：①「美国消费者价格指数（CPI） · Consumer Price Index」这种
   中英双写，取前半段即可；②「英国 · GDP · 不变价 · 季调 · 环比」这种用 · 做层级
   分隔的东方财富式标题，劈开只剩「英国」两个字 —— 必须整体保留。
   判据：分隔符后面整段没有中文、且有 4 个以上连续拉丁字母，才算英文副本。 */
function macroShortTitle(event) {
  const raw = String(event.title || event.name || "").trim();
  const translated = calendarEventTitle(raw);
  const split = translated.match(/^(.*?)\s·\s([\s\S]*)$/);
  if (split && /[A-Za-z]{4,}/.test(split[2]) && !/[\u4e00-\u9fa5]/.test(split[2])) return split[1].trim();
  return translated || raw || "--";
}
function ensureMacroTickerBar() {
  const layout = document.querySelector(".terminal-layout");
  if (!layout) return null;                     // 终端布局还没搭好，等下一轮渲染
  const hero = document.querySelector("main > .hero") || document.querySelector(".hero");
  let bar = $("macroTickerBar");
  if (!bar) {
    bar = document.createElement("section");
    bar.id = "macroTickerBar";
    bar.className = "macro-ticker";
    bar.hidden = true;
  }
  // 锚点（v2.12.55）：预警条紧贴顶部「宏观实况」条（#coinSwitcher）下方，两条都
  // 位于 hero（我的持仓 / 实时价格）之上；实况条不存在时退回 hero 之前。两边谁先
  // 跑都收敛到同一位置，只在位置不对时才动 DOM。
  const liveBar = document.getElementById("coinSwitcher");
  if (liveBar && liveBar.parentElement === layout.parentElement) {
    if (bar.previousElementSibling !== liveBar) liveBar.after(bar);
  } else if (hero && hero.parentElement === layout.parentElement) {
    if (bar.previousElementSibling !== hero) hero.before(bar);
  } else if (bar.nextElementSibling !== layout) {
    layout.parentElement?.insertBefore(bar, layout);
  }
  return bar;
}
function renderMacroTicker() {
  const bar = ensureMacroTickerBar();
  if (!bar) return;
  const items = macroTickerItems();
  if (macroTickerHidden || !items.length) {
    bar.hidden = true;
    bar.innerHTML = "";
    return;
  }
  const now = Date.now();
  const itemHtml = (event, dup) => {
    const country = calendarCountry(event.country);
    const at = Number(event.at);
    const released = at <= now;
    const bias = macroEventBias(event);
    const imminent = !released && at - now <= MACRO_TICKER_IMMINENT_MS;
    const soon = !released && !imminent && at - now <= MACRO_TICKER_SOON_MS;
    const actual = released && macroHasActual(event)
      ? `<span class="mt-act">${tx("实际", "Act")} <b>${calendarEscape(String(event.actual))}</b></span>`
      : "";
    const tag = released
      ? (bias && bias.kind !== "muted" ? `<em class="mt-tag ${bias.kind}">${calendarEscape(bias.label)}</em>` : "")
      : (macroParseNumber(event.estimate) != null
          ? `<em class="mt-tag est">${tx("预期", "Est")} ${calendarEscape(String(event.estimate))}</em>`
          : "");
    /* 未公布才挂秒级倒计时（由全局 1 秒节拍统一刷新，兼作「刚公布」的重取触发）；
       已公布的条目不回写倒计时，展示的是实际值 + 利好/利空。 */
    const timing = released
      ? ""
      : `<span class="mt-cd"><b data-macro-at="${at}" data-macro-format="bare">${macroCountdownClock(at)}</b></span>`;
    const when = calendarFormatBeijing(at, { month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", hour12:false });
    const flag = country.emoji
      ? `<i class="mt-flag" title="${calendarEscape(country.label)}">${country.emoji}</i>`
      : `<i class="mt-flag mt-flag-code" title="${calendarEscape(country.label)}">${calendarEscape(country.flag)}</i>`;
    return `<button type="button" class="mt-item${released ? " is-released" : ""}${imminent ? " is-imminent" : ""}${soon ? " is-soon" : ""}" data-mt-key="${calendarEscape(macroCalendarPickKey(event))}"${dup ? ' tabindex="-1" aria-hidden="true"' : ""}>
      ${flag}
      <b class="mt-title">${calendarEscape(macroShortTitle(event))}</b>
      ${actual}
      <span class="mt-when">${calendarEscape(when)} ${tx("北京", "Beijing")}</span>
      ${timing}
      ${tag}
    </button>`;
  };
  const half = items.map((event) => itemHtml(event, false)).join("");
  const twin = items.map((event) => itemHtml(event, true)).join("");
  bar.hidden = false;
  bar.innerHTML = `<span class="mt-live"><i></i>${tx("宏观预警", "Macro alerts")}</span>
    <div class="mt-viewport" data-mt-viewport><div class="mt-track" data-mt-track>${half}${twin}</div></div>
    <button type="button" class="mt-close" data-mt-close title="${calendarEscape(tx("收起预警条", "Hide alert ticker"))}" aria-label="${calendarEscape(tx("收起预警条", "Hide alert ticker"))}">✕</button>`;
  const track = bar.querySelector("[data-mt-track]");
  /* 秒表速度：内容越宽跑得越久，固定 ≈50px/s，并给一个 26s 下限免得快到看不清。 */
  requestAnimationFrame(() => {
    if (!track) return;
    const width = track.scrollWidth / 2;
    if (width > 0) track.style.animationDuration = `${Math.max(26, Math.round(width / 50))}s`;
  });
  bar.querySelectorAll("[data-mt-key]").forEach((button) => button.addEventListener("click", () => focusMacroEvent(button.dataset.mtKey)));
  bar.querySelector("[data-mt-close]")?.addEventListener("click", (event) => {
    event.stopPropagation();
    macroTickerHidden = true;
    saveMacroTickerHidden();
    renderMacroTicker();
    renderInvestmentCalendar(investmentCalendarData);
  });
}
/* 点滚动条某一条 / 「更换」里选中某一条：把顶部卡片切到该事件并滚过去。
   v2.12.57：关注卡锁定后行为分叉 ——
   ① 点的正是当前关注的那条 → 直接滚回关注卡并闪烁；
   ② 点的不是当前关注的 → 跳「宏观事件中枢」高亮那条事件行，关注卡保持不动；
   「更换」菜单里的显式选择（force=true）不受锁定约束，仍然直接切换。 */
function flashPinnedMacroCard() {
  const card = $("fearGreedGauge");
  if (!card) return;
  card.classList.remove("is-flash");
  void card.offsetWidth;
  card.classList.add("is-flash");
  setTimeout(() => card.classList.remove("is-flash"), 1600);
  card.scrollIntoView({ block: "center", behavior: "smooth" });
}
function flashCalendarEventRow(key) {
  const card = $("investmentCalendarCard");
  if (!card) return;
  const row = card.querySelector(`.cal-event[data-cal-key="${CSS.escape(String(key))}"]`);
  if (!row) {
    // 事件行不在当前列表里（被时间范围/地区筛选或折叠挡住）：退而求其次，整卡闪烁提示。
    card.classList.remove("is-flash");
    void card.offsetWidth;
    card.classList.add("is-flash");
    setTimeout(() => card.classList.remove("is-flash"), 1600);
    card.scrollIntoView({ block: "start", behavior: "smooth" });
    return;
  }
  row.classList.remove("is-jump-pulse");
  void row.offsetWidth;
  row.classList.add("is-jump-pulse");
  setTimeout(() => row.classList.remove("is-jump-pulse"), 2000);
  row.scrollIntoView({ block: "center", behavior: "smooth" });
}
function focusMacroEvent(key, force = false) {
  if (!key) return;
  const pinned = macroCalendarPickedLiveEvent();
  if (!force && macroPinLocked) {
    const pinnedKey = pinned ? macroCalendarPickKey(pinned) : "";
    if (key === pinnedKey) {
      flashPinnedMacroCard();
      return;
    }
    flashCalendarEventRow(key);
    return;
  }
  macroManualPick = key;
  macroDismissed.delete(key);
  macroPickerOpen = false;
  saveMacroCalendarPicks();
  renderFearGreedGauge();
  renderInvestmentCalendar(investmentCalendarData);
  flashPinnedMacroCard();
}
/* ==== v2.12.47：尾部空白平衡 ====
   右列（侧栏 = 当前规则信号 + 指标明细 + 关注宏观事件实时数据）比左列
   （K 线 + OKX 微观结构 + 周期涨幅）高时，差值会在左列底部、也就是
   「周期涨幅」和「多周期共振」之间留出一块空白。宏观事件卡内容一多，
   这个差值能到 200px 以上。这里按「优先搬卡、其次吸收」两步消化余量：

     ① 差值够大且搬得下 → 把「多周期共振」上移到左列末尾（能吃掉一整块）；
     ② 剩下的零头 → 交给「周期涨幅」卡吸收。它的柱状图是百分比高度
        （.period-return-bar > i { height:100% }），卡片变高时柱子等比变长，
        视觉上就是一张更高的柱状图，而不是一块空洞。

   ⚠️ 只碰「周期涨幅」和「多周期共振」两张卡：K 线、当前规则信号、下方板块
   一律不动。窄屏（单列）或差值过小时直接复位成原生布局。
   ⚠️ 宏观卡有 1 秒级的倒计时刷新，若不加签名短路，这里会被反复触发。 */
const TAIL_BALANCE_MIN_GAP = 28; // 小于这个差值不值得动布局
const TAIL_BALANCE_MAX_ABSORB = 230; // 「周期涨幅」最多被拉高这么多，避免柱子比例失真
let tailBalanceSignature = "";

function tailBalanceNodes() {
  const layout = document.querySelector(".terminal-layout");
  if (!layout) return null;
  const column = layout.querySelector(":scope > .chart-column");
  const side = layout.querySelector(":scope > .side-stack");
  if (!column || !side) return null;
  /* 「多周期共振」始终是 main 下那张 .optional —— 宽屏时由既有布局逻辑
     放在 terminal-layout 之后，窄屏时它本就在侧栏里。 */
  const resonance = document.querySelector("main > .optional") || column.querySelector(".optional");
  return { layout, column, side, resonance, periodCard: document.getElementById("periodChangeCard") };
}

function resetTailBalance(nodes) {
  const { layout, column, resonance, periodCard } = nodes;
  column.classList.remove("is-tail-balanced", "is-tail-with-tail");
  column.style.removeProperty("min-height");
  if (periodCard) periodCard.style.removeProperty("height");
  if (resonance) {
    resonance.style.removeProperty("min-height");
    if (column.contains(resonance)) layout.after(resonance);
  }
}

function syncTailBalance() {
  const nodes = tailBalanceNodes();
  if (!nodes) return;
  const { layout, column, side, resonance, periodCard } = nodes;
  const signature = `${side.offsetHeight}|${window.innerWidth}`;
  if (signature === tailBalanceSignature) return;
  tailBalanceSignature = signature;

  resetTailBalance(nodes);
  if (!window.matchMedia("(min-width: 1025px)").matches) return;
  if (column.offsetWidth < 300) return;

  const sideHeight = side.offsetHeight;
  let gap = sideHeight - column.offsetHeight;
  if (gap <= TAIL_BALANCE_MIN_GAP) return;

  const naturalHeight = column.offsetHeight;
  /* ① 搬卡。只在「光靠吸收吃不下」时才动「多周期共振」—— 它一搬就从全宽变窄，
        多数情况不值得；而且它会被 arrange() 的 replaceChildren 摘掉，能不动就不动。 */
  let moved = false;
  if (resonance && gap > TAIL_BALANCE_MAX_ABSORB + TAIL_BALANCE_MIN_GAP) {
    column.append(resonance);
    moved = true;
    // 搬到窄列后它自身高度会变，必须用真实值重算，不能用搬之前的预估值。
    gap = sideHeight - column.offsetHeight;
  }

  /* ② 吸收剩余零头。 */
  const absorb = Math.max(0, Math.min(gap, TAIL_BALANCE_MAX_ABSORB));
  if (!moved && absorb <= 0) return;
  column.classList.add("is-tail-balanced");
  column.classList.toggle("is-tail-with-tail", moved);
  column.style.minHeight = `${(moved ? column.offsetHeight : naturalHeight) + absorb}px`;
}

/* 侧栏内容一变（宏观卡换条目 / 展开解读 / 切语言）就重新平衡。 */
function initTailBalance() {
  const nodes = tailBalanceNodes();
  if (!nodes) {
    setTimeout(initTailBalance, 300);
    return;
  }
  syncTailBalance();
  if (typeof ResizeObserver === "function") {
    let queued = false;
    new ResizeObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        syncTailBalance();
      });
    }).observe(nodes.side);
  }
  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      tailBalanceSignature = ""; // 视口变了必须重算
      syncTailBalance();
    }, 160);
  });
}
/* 「更换」浮层：全部高重要性事件（含已被「不显示」的，可在此恢复）。 */
function macroPickerHtml(currentKey) {
  const now = Date.now();
  const candidates = macroPinCandidates();
  const rows = candidates.length
    ? candidates.map((event) => {
        const key = macroCalendarPickKey(event);
        const country = calendarCountry(event.country);
        const hidden = macroDismissed.has(key);
        const released = Number(event.at) <= now;
        const when = calendarFormatBeijing(event.at, { month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", hour12:false });
        return `<li><button type="button" class="macro-pick-row${key === currentKey ? " is-current" : ""}${hidden ? " is-hidden" : ""}" data-pin-pick="${calendarEscape(key)}">
          <i class="cal-flag ${country.cls}">${country.emoji || calendarEscape(country.flag)}</i>
          <span class="macro-pick-name">${calendarEscape(macroShortTitle(event))}</span>
          <span class="macro-pick-when">${calendarEscape(when)}</span>
          <em>${hidden ? tx("已隐藏", "Hidden") : released ? tx("已公布", "Released") : tx("待公布", "Pending")}</em>
        </button></li>`;
      }).join("")
    : `<li class="ic-menu-empty">${tx("当前没有高重要性事件", "No high-importance events now")}</li>`;
  return `<div class="ic-menu-head macro-pick-head">
      <span>${tx("选择要盯的事件（仅高重要性）", "Pick a high-importance event")}</span>
      <button type="button" data-pin-auto>${tx("恢复自动", "Back to auto")}</button>
    </div>
    <ul class="ic-menu-list macro-pick-list">${rows}</ul>
    ${macroDismissed.size ? `<div class="macro-pick-foot"><button type="button" data-pin-restore>${tx(`恢复已隐藏的 ${macroDismissed.size} 条`, `Restore ${macroDismissed.size} hidden`)}</button></div>` : ""}`;
}

/* 恐惧与贪婪故意采用低频更新：它是市场环境指标，不能单独作为交易信号。
   Fear & Greed is intentionally slow-moving. It is a market-environment
   guardrail, not a high-frequency directional input. */
const fearGreedRefreshMs = 120_000,
  fearGreedRetryMs = 30_000;
let fearGreedSentiment = null,
  fearGreedLoading = false,
  fearGreedError = null,
  fearGreedRetryTimer = null;
function fearGreedView(value) {
  if (value <= 24)
    return {
      kind: "bull",
      label: tx("极度恐慌", "Extreme fear"),
      note: tx(
        "极度恐慌：不追空，等待价格与成交量确认。",
        "Extreme fear: avoid chasing shorts; wait for price and volume confirmation.",
      ),
    };
  if (value <= 44)
    return {
      kind: "flat",
      label: tx("恐慌", "Fear"),
      note: tx(
        "市场偏恐慌：降低追空意愿，仍以趋势确认。",
        "Fearful market: lower the urge to chase shorts; keep trend confirmation.",
      ),
    };
  if (value <= 55)
    return {
      kind: "flat",
      label: tx("中性", "Neutral"),
      note: tx(
        "情绪中性：不额外改变现有研究结论。",
        "Neutral sentiment: no extra adjustment to the research view.",
      ),
    };
  if (value <= 74)
    return {
      kind: "flat",
      label: tx("贪婪", "Greed"),
      note: tx(
        "市场偏贪婪：提高追多门槛，注意资金费率。",
        "Greedy market: raise the bar for chasing longs and watch funding.",
      ),
    };
  return {
    kind: "bear",
    label: tx("极度贪婪", "Extreme greed"),
    note: tx(
      "极度贪婪：不追多，警惕拥挤后的回撤。",
      "Extreme greed: avoid chasing longs; watch for crowded-market pullbacks.",
    ),
  };
}
/* ---- 宏观与情绪 v2.7.2：恐惧贪婪（紧凑）+ 近期宏观日历（联动投资日历）+ 热点新闻 ---- */
let macroNewsData = null;
let macroNewsError = null;
let macroNewsLoading = false;
let macroCountdownTimer = null;
// 记录上一拍仍在“未来”的事件，用于侦测“刚刚公布”的瞬间并立刻拉取最新实际值。
// Tracks which events were still upcoming last tick, so the moment one is released
// we can immediately refetch the calendar and back-fill the actual value.
let macroUpcomingIds = new Set();
// 新闻情绪仅用于界面展示标签，刻意与服务端 newsSentimentScore() 分开：
// 后者会喂给价格预测模型，改动它会影响模型行为。
// Display-only news sentiment, deliberately separate from the server's
// newsSentimentScore() which feeds the price model and must stay stable.
const NEWS_DISPLAY_BULL = ["etf approval","etf inflow","institutional","accumulat","adoption","partnership","bullish","rally","surge","soar","jump","gain","rises","rise","all-time high","record high","rate cut","dovish","approval","buyback","reserve","买入","增持","采用","合作","利好","上涨","反弹","降息","获批","流入","新高","新高点"];
const NEWS_DISPLAY_BEAR = ["etf outflow","outflow","hack","exploit","breach","lawsuit","ban","crackdown","liquidation","sell-off","selloff","plunge","slump","drops","drop","falls","fall","decline","sink","sinks","suffer","weak","rate hike","hawkish","fraud","scam","conflict","war","attack","strike","tension","escalat","sanction","tariff","invasion","default","调查","禁令","监管打击","黑客","漏洞","清算","抛售","下跌","利空","加息","流出","诉讼","冲突","战争","制裁","关税","袭击"];
function newsDisplaySentiment(title) {
  const t = String(title || "").toLowerCase();
  const bull = NEWS_DISPLAY_BULL.filter((w) => t.includes(w)).length;
  const bear = NEWS_DISPLAY_BEAR.filter((w) => t.includes(w)).length;
  if (bull === bear) return 0;
  return bull > bear ? 1 : -1;
}
function newsCleanTitle(title) {
  return String(title || "")
    .replace(/\s*[-–—]\s*[^-–—|]{2,40}$/, "")
    .replace(/\s*\|\s*[^|]{2,40}$/, "")
    .trim();
}
function newsRelativeTime(at) {
  if (!Number.isFinite(at)) return "";
  const mins = Math.max(1, Math.round((Date.now() - at) / 60_000));
  if (mins < 60) return tx(`${mins} 分钟前`, `${mins}m ago`);
  const hours = Math.round(mins / 60);
  if (hours < 24) return tx(`${hours} 小时前`, `${hours}h ago`);
  return tx(`${Math.round(hours / 24)} 天前`, `${Math.round(hours / 24)}d ago`);
}
function renderNewsRow(item) {
  const sent = newsDisplaySentiment(item.title);
  const kind = sent > 0 ? "bull" : sent < 0 ? "bear" : "flat";
  const label = sent > 0 ? tx("利好", "Bullish") : sent < 0 ? tx("利空", "Bearish") : tx("中性", "Neutral");
  const title = calendarEscape(newsCleanTitle(item.title));
  const src = calendarEscape(item.source || "--");
  const time = newsRelativeTime(item.publishedAt);
  const inner = `<span class="news-title">${title}</span><span class="news-meta"><em>${src}</em>${time ? `<i>${calendarEscape(time)}</i>` : ""}<b class="news-sent ${kind}">${label}</b></span>`;
  return item.url
    ? `<li class="news-item ${kind}"><a href="${safeHref(item.url)}" target="_blank" rel="noopener noreferrer">${inner}</a></li>`
    : `<li class="news-item ${kind}">${inner}</li>`;
}
async function loadMacroNews(force = false) {
  if (macroNewsLoading) return;
  macroNewsLoading = true;
  try {
    const response = await apiFetch(`/api/news${force ? "?refresh=1" : ""}`, 12_000);
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || data.error);
    macroNewsData = data;
    macroNewsError = null;
  } catch (error) {
    macroNewsError = error;
  } finally {
    macroNewsLoading = false;
    renderFearGreedGauge();
  }
}
// 指标类别 → 对 BTC 的方向含义。通胀/利率高于预期偏紧缩（利空），低于预期偏宽松（利好）；
// 失业率反向；就业/增长按“强于预期→紧缩”处理。均为经验映射，非确定性结论。
function macroIndicatorClass(title) {
  const t = String(title || "").toLowerCase();
  if (/失业率|unemploy/.test(t)) return "unemployment";
  if (/cpi|ppi|pce|物价|通胀|消费者价格|生产者价格|inflation|price index/.test(t)) return "inflation";
  if (/利率|fomc|rate decision|央行|决议|interest rate|benchmark rate/.test(t)) return "rate";
  if (/非农|就业|payroll|employment/.test(t)) return "jobs";
  if (/gdp|零售|销售|retail|gross domestic/.test(t)) return "growth";
  return null;
}
function macroParseNumber(value) {
  const matched = String(value ?? "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return matched ? parseFloat(matched[0]) : null;
}
function macroEventBias(event) {
  const cls = macroIndicatorClass(event.title);
  if (!cls) return null;
  const released = event.actual != null && event.actual !== "" && event.at <= Date.now();
  const actual = macroParseNumber(event.actual),
    estimate = macroParseNumber(event.estimate),
    previous = macroParseNumber(event.previous);
  if (released && actual != null && estimate != null) {
    const diff = actual - estimate;
    const detail = tx(`实际 ${event.actual} vs 预期 ${event.estimate}`, `actual ${event.actual} vs est ${event.estimate}`);
    const caveat = tx("按“数据超预期→紧缩”的常见逻辑推断，实际方向还取决于当时的市场主线，非确定性结论。", "Inferred from the common 'beat → hawkish' logic; the real direction also depends on the market narrative. Not a certainty.");
    if (Math.abs(diff) < 1e-9) return { kind: "flat", label: tx("符合预期", "As expected"), tip: tx(`${detail}，符合预期，通常影响有限。`, `${detail}; in line with consensus, usually limited impact.`) };
    let bearish;
    if (cls === "unemployment") bearish = diff < 0;
    else bearish = diff > 0;
    return bearish
      ? { kind: "bear", label: tx("利空 " + coinLabel(), "Bearish " + coinLabel()), tip: tx(`${detail}，超预期偏紧缩，通常利空风险资产。`, `${detail}; hotter than expected is typically hawkish and bearish for risk assets.`) + " " + caveat }
      : { kind: "bull", label: tx("利好 " + coinLabel(), "Bullish " + coinLabel()), tip: tx(`${detail}，不及预期偏宽松，通常利好风险资产。`, `${detail}; cooler than expected is typically dovish and bullish for risk assets.`) + " " + caveat };
  }
  if (estimate != null && previous != null) {
    const diff = estimate - previous;
    if (Math.abs(diff) < 1e-9) return { kind: "muted", label: tx("预期持平", "Flat consensus"), tip: tx("市场共识与前值持平，方向取决于公布值相对预期的偏差。", "Consensus matches the prior; direction depends on the surprise vs consensus.") };
    return diff > 0
      ? { kind: "muted", label: tx("预期升温", "Consensus ↑"), tip: tx("共识预期较前值上升，这是预期变化、不是公布结果。", "Consensus rose vs the prior; this is an expectation, not the release.") }
      : { kind: "muted", label: tx("预期降温", "Consensus ↓"), tip: tx("共识预期较前值下降，这是预期变化、不是公布结果。", "Consensus fell vs the prior; this is an expectation, not the release.") };
  }
  return { kind: "muted", label: tx("待公布", "Pending"), tip: tx("数据尚未公布，等待实际值。", "Not yet released; awaiting the actual value.") };
}
function macroImportanceRank(event) {
  return event.importance === "high" ? 0 : event.importance === "medium" ? 1 : 2;
}
function macroHasActual(event) {
  return event.actual != null && event.actual !== "";
}
/* 「宏观经济数据」：刚公布的事件，已回填实际值的优先，其次按时间倒序。 */
function releasedMacroEvents(limit = 8, filters = {}) {
  const { regions = null, categories = null, importance = null } = filters;
  const now = Date.now();
  return (investmentCalendarData?.events || [])
    .filter((event) => event.category === "macro")
    .filter((event) => !importance || importance.size === 0 || importance.has(event.importance || "low"))
    .filter((event) => !regions || regions.size === 0 || regions.has(event.country || "GLOBAL"))
    .filter((event) => !categories || categories.size === 0 || categories.has(event.category || "macro"))
    .filter((event) => event.at <= now && event.at >= now - 14 * CALENDAR_DAY)
    .filter((event) => macroEventBias(event))
    .sort((a, b) => (Number(macroHasActual(b)) - Number(macroHasActual(a))) || (b.at - a.at))
    .slice(0, limit);
}
/* 右下角「实时数据 · 利好利空」：只取重要性为高（3 点）的事件。 */
function macroImpactEvents(limit = 2) {
  const now = Date.now();
  const pool = (investmentCalendarData?.events || [])
    .filter((event) => event.importance === "high")
    .filter((event) => event.category === "macro" || event.category === "energy")
    .filter((event) => event.at >= now - 18 * 3_600_000 && event.at <= now + 14 * CALENDAR_DAY)
    .filter((event) => calendarImpactModel(event));
  const upcoming = pool.filter((event) => event.at >= now).sort((a, b) => a.at - b.at);
  const recent = pool.filter((event) => event.at < now).sort((a, b) => b.at - a.at);
  return [...upcoming, ...recent].slice(0, limit);
}
function renderMacroCompareRow(event, { compact = false } = {}) {
  const country = calendarCountry(event.country);
  const bias = macroEventBias(event);
  const released = event.at <= Date.now();
  const bjDate = event.timePrecision === "date" ? tx("待定", "TBD") : calendarFormatBeijing(event.at, { month: "2-digit", day: "2-digit" });
  const bjTime = event.timePrecision === "date" ? "" : calendarFormatBeijing(event.at, { hour: "2-digit", minute: "2-digit", hour12: false });
  const countdown = released ? tx("已公布", "Released") : `${tx("距今", "In ")} ${macroCountdown(event.at)}`;
  const num = (value, field) => {
    if (value === null || value === undefined || value === "")
      return `<b class="empty">${field === "actual" ? tx("待更新", "Pending") : tx("—", "—")}</b>`;
    return `<b>${calendarEscape(String(value))}</b>`;
  };
  if (compact) {
    return `<article class="macro-cmp macro-cmp-compact ${bias ? bias.kind : ""}">
      <div class="macro-cmp-top">
        <span class="cal-flag ${country.cls}" title="${calendarEscape(country.label)}">${country.flag}</span>
        <span class="macro-cmp-title">${calendarEscape(calendarEventTitle(event.title))}</span>
        <span class="macro-cmp-time"><i>${calendarEscape(bjDate)} ${calendarEscape(bjTime)}</i><em data-macro-at="${Number(event.at)}">${countdown}</em></span>
      </div>
      <div class="macro-cmp-metrics">
        <span class="macro-cmp-met"><i>${tx("预期", "Est")}</i>${num(event.estimate, "estimate")}</span>
        <span class="macro-cmp-met"><i>${tx("前值", "Prev")}</i>${num(event.previous, "previous")}</span>
        <span class="macro-cmp-met actual ${released && event.actual ? "is-released" : ""}"><i>${tx("实际", "Act")}</i>${num(event.actual, "actual")}</span>
        ${bias ? `<span class="macro-cmp-tag ${bias.kind}" title="${calendarEscape(bias.tip)}">${calendarEscape(bias.label)}</span>` : ""}
      </div>
    </article>`;
  }
  return `<article class="macro-cmp ${bias ? bias.kind : ""}">
    <div class="macro-cmp-top">
      <span class="cal-flag ${country.cls}" title="${calendarEscape(country.label)}">${country.flag}</span>
      <span class="macro-cmp-title">${calendarEscape(calendarEventTitle(event.title))}</span>
      <span class="macro-cmp-time"><i>${calendarEscape(bjDate)} ${calendarEscape(bjTime)}</i><em data-macro-at="${Number(event.at)}">${countdown}</em></span>
    </div>
    <div class="macro-cmp-metrics">
      <span class="macro-cmp-met"><i>${tx("预期", "Est")}</i>${num(event.estimate, "estimate")}</span>
      <span class="macro-cmp-met"><i>${tx("前值", "Prev")}</i>${num(event.previous, "previous")}</span>
      <span class="macro-cmp-met actual ${released && event.actual ? "is-released" : ""}"><i>${tx("实际", "Act")}</i>${num(event.actual, "actual")}</span>
      ${bias ? `<span class="macro-cmp-tag ${bias.kind}" title="${calendarEscape(bias.tip)}">${calendarEscape(bias.label)}</span>` : ""}
    </div>
  </article>`;
}
/* 大号倒计时：HH:MM:SS（超过一天则带上天数）。秒级刷新，比「距今 X 分 Y 秒」更醒目。 */
function macroCountdownClock(at) {
  const total = Math.max(0, Math.round((at - Date.now()) / 1000)),
    days = Math.floor(total / 86_400),
    hours = Math.floor((total % 86_400) / 3_600),
    minutes = Math.floor((total % 3_600) / 60),
    seconds = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  const clock = `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  return days ? tx(`${days} 天 ${clock}`, `${days}d ${clock}`) : clock;
}
/* 影响方向 → BTC 文案。0 视为中性（能源类数据对 BTC 通常无直接方向）。 */
function macroBtcDirText(dir) {
  if (dir > 0) return { kind: "bull", text: tx("利好 " + coinLabel(), "Bullish " + coinLabel()) };
  if (dir < 0) return { kind: "bear", text: tx("利空 " + coinLabel(), "Bearish " + coinLabel()) };
  return { kind: "flat", text: tx("中性（无直接方向）", "Neutral (no direct read)") };
}
/* 「关注事件 · 实时数据」：突出倒计时与北京时间，附预期/前值/实际，
   并给出「高于/低于锚点 → 对 BTC 属于利好还是利空」的阈值式解读。
   锚点优先用「预期」；数据源没有免费共识时退回「前值」，并在文案里注明是前值。 */
function renderPinnedRelease(event) {
  const country = calendarCountry(event.country);
  const model = calendarImpactModel(event);
  const bias = macroEventBias(event);
  const released = event.at <= Date.now();
  const hasActual = released && macroHasActual(event);
  const actualN = macroParseNumber(event.actual),
    estimateN = macroParseNumber(event.estimate),
    previousN = macroParseNumber(event.previous);
  const hasNumeric = estimateN != null || previousN != null || actualN != null;
  const isCurated = event.curated === true;
  const val = (v) => (v === null || v === undefined || v === "" ? tx("—", "—") : calendarEscape(String(v)));
  const bjDate = event.timePrecision === "date" ? tx("待定", "TBD") : calendarFormatBeijing(event.at, { month: "2-digit", day: "2-digit" });
  const bjTime = event.timePrecision === "date" ? "" : calendarFormatBeijing(event.at, { hour: "2-digit", minute: "2-digit", hour12: false });
  const impLabel = (CALENDAR_IMPORTANCE.find(([k]) => k === event.importance) || ["low", tx("低", "Low"), "Low"])[1];
  const countdown = released ? tx("已公布", "Released") : macroCountdownClock(event.at);
  const title = calendarEventTitle(event.title || event.name || "");
  const source = isCurated ? tx("重大事件", "Major event") : (event.source || "--");
  const kindMap = {
    bull: { cls: "bull", label: tx("利好 " + coinLabel(), "Bullish " + coinLabel()) },
    bear: { cls: "bear", label: tx("利空 " + coinLabel(), "Bearish " + coinLabel()) },
  };
  const kind = kindMap[event.kind] || { cls: "flat", label: tx("中性", "Neutral") };

  // 数值类事件：保留预期/前值/实际三列。
  let metricsHtml = "";
  if (hasNumeric) {
    const status = hasActual
      ? `<span class="ms-pin-badge ${bias ? bias.kind : "flat"}">${calendarEscape(bias ? bias.label : tx("已公布", "Released"))}</span>`
      : `<span class="ms-pin-badge pending">${tx("待公布", "Pending")}</span>`;
    metricsHtml = `<div class="ms-pin-metrics">
      <span class="ms-pin-met"><i>${tx("预期", "Est")}</i><b>${val(event.estimate)}</b></span>
      <span class="ms-pin-met"><i>${tx("前值", "Prev")}</i><b>${val(event.previous)}</b></span>
      <span class="ms-pin-met actual"><i>${tx("实际", "Act")}</i><b class="${hasActual ? "on" : "empty"}">${hasActual ? val(event.actual) : tx("待更新", "Pending")}</b>${status}</span>
    </div>`;
  }

  // 解读区：curated 重大事件优先展示人工 judge；数值类事件展示阈值模型。
  let analysis;
  if (isCurated && event.judge) {
    analysis = `<div class="ms-pin-analysis">
      <p class="ms-pin-note">${tx("事件解读", "Read-through")}<em class="${kind.cls}">${calendarEscape(kind.label)}</em></p>
      <p class="ms-pin-tip">${calendarEscape(event.judge)}</p>
    </div>`;
  } else if (model && hasNumeric) {
    const anchorRaw = estimateN != null ? event.estimate : previousN != null ? event.previous : null;
    const anchorIsEstimate = estimateN != null;
    const highWording = anchorIsEstimate ? tx("高于预期", "above consensus") : tx("高于前值", "above prior");
    const lowWording = anchorIsEstimate ? tx("低于预期", "below consensus") : tx("低于前值", "below prior");
    const liveKey = hasActual && actualN != null && estimateN != null && Math.abs(actualN - estimateN) > 1e-9
      ? (actualN > estimateN ? "high" : "low")
      : null;
    const hi = macroBtcDirText(model.high.btc),
      lo = macroBtcDirText(model.low.btc);
    const anchorLabel = anchorIsEstimate ? tx("预期", "Est") : tx("前值", "Prev");
    analysis = `<div class="ms-pin-analysis">
      <p class="ms-pin-note">${tx("市场解读", "Read-through")}<em>${calendarEscape(model.label)}</em></p>
      <ul>
        <li class="${liveKey === "high" ? "is-live" : ""}">${tx(`实际 > ${anchorRaw}（${anchorLabel}）→ ${highWording}，通常 `, `Actual > ${anchorRaw} (${anchorLabel}) → ${highWording}, typically `)}<b class="${hi.kind}">${hi.text}</b></li>
        <li class="${liveKey === "low" ? "is-live" : ""}">${tx(`实际 < ${anchorRaw}（${anchorLabel}）→ ${lowWording}，通常 `, `Actual < ${anchorRaw} (${anchorLabel}) → ${lowWording}, typically `)}<b class="${lo.kind}">${lo.text}</b></li>
        <li class="is-flat">${tx(`实际 = ${anchorRaw}（符合${anchorLabel}），通常影响有限`, `Actual = ${anchorRaw} (in line with ${anchorLabel}), usually limited impact`)}</li>
      </ul>
      <p class="ms-pin-tip">${calendarEscape(model.note)}</p>
    </div>`;
  } else if (model) {
    /* v2.12.49：补充源（TradingView / FinanceCalendar）某一轮拉取失败时，预期与前值会整轮缺失。
       旧逻辑走最后的 else，只剩一句「数据尚未公布，等待实际值。」—— 连方向性解读一起被吞掉。
       但方向解读本来就不依赖具体锚定数字（CALENDAR_IMPACT_MODELS 的 high/low/note 全是定性描述），
       所以这里给一版不含数字的通用解读，保证任何一轮都能看到「利多/利空」说明。 */
    const hi = macroBtcDirText(model.high.btc),
      lo = macroBtcDirText(model.low.btc);
    analysis = `<div class="ms-pin-analysis">
      <p class="ms-pin-note">${tx("市场解读", "Read-through")}<em>${calendarEscape(model.label)}</em></p>
      <ul>
        <li>${tx("实际高于预期 → 通常 ", "Above consensus → typically ")}<b class="${hi.kind}">${hi.text}</b></li>
        <li>${tx("实际低于预期 → 通常 ", "Below consensus → typically ")}<b class="${lo.kind}">${lo.text}</b></li>
        <li class="is-flat">${tx("实际符合预期，通常影响有限", "In line with consensus, usually limited impact")}</li>
      </ul>
      <p class="ms-pin-tip">${calendarEscape(model.note)}</p>
      <p class="ms-pin-tip">${tx("预期值与前值暂未取到（数据源本轮未返回），稍后会自动补齐。", "Estimate and previous are unavailable this round and will be filled in automatically.")}</p>
    </div>`;
  } else {
    const tip = bias?.tip || event.directional || "";
    analysis = tip ? `<div class="ms-pin-analysis"><p class="ms-pin-tip">${calendarEscape(tip)}</p></div>` : "";
  }

  // 非数值的 curated 事件：在倒计时下方直接展示「利好/利空/中性」标签。
  const kindbar = isCurated && !hasNumeric
    ? `<div class="ms-pin-kindbar"><span class="ms-pin-badge ${kind.cls}">${calendarEscape(kind.label)}</span></div>`
    : "";

  return `<article class="ms-pin ${bias ? bias.kind : ""} ${kind.cls}${released ? " is-released" : ""}">
    <header class="ms-pin-head">
      <span class="cal-flag ${country.cls}" title="${calendarEscape(country.label)}">${country.flag}</span>
      <div class="ms-pin-title"><b>${calendarEscape(title)}</b><span>${calendarEscape(source)}</span></div>
      <span class="cal-impact imp-${event.importance}" title="${tx("重要等级", "Importance")}: ${calendarEscape(impLabel)}">${calendarImportanceDots(event)}<em>${calendarEscape(impLabel)}</em></span>
    </header>
    <div class="ms-pin-when">
      <div class="ms-pin-clock"><b data-macro-at="${Number(event.at)}" data-macro-format="bare">${countdown}</b><span>${released ? tx("已公布", "Released") : tx("倒计时", "Countdown")}</span></div>
      <div class="ms-pin-datetime"><span>${tx("北京时间", "Beijing")}</span><b>${calendarEscape(bjDate)} ${calendarEscape(bjTime)}</b>${event.timePrecision === "date" ? "" : `<span>${tx("当地", "Local")} ${calendarEscape(calendarFormatInZone(event.at, calendarLocalZone(event.country), { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }))}</span>`}</div>
    </div>
    ${metricsHtml}
    ${kindbar}
    ${analysis}
  </article>`;
}
/* 左下栏很窄，用竖排紧凑行代替双行 macro-cmp，避免标题/时间被挤成省略号。 */
function renderReleasedRow(event) {
  const country = calendarCountry(event.country);
  const bias = macroEventBias(event);
  const when = event.timePrecision === "date"
    ? tx("日期待定", "Date TBD")
    : `${calendarFormatBeijing(event.at, { month: "2-digit", day: "2-digit" })} ${calendarFormatBeijing(event.at, { hour: "2-digit", minute: "2-digit", hour12: false })}`;
  const val = (v) => (v === null || v === undefined || v === "") ? "—" : calendarEscape(String(v));
  const title = calendarEscape(calendarEventTitle(event.title));
  const impLabel = (CALENDAR_IMPORTANCE.find(([k]) => k === event.importance) || ["low", tx("低", "Low"), "Low"])[1];
  return `<article class="ms-rel ${bias ? bias.kind : ""}">
    <div class="ms-rel-top"><span class="cal-flag ${country.cls}" title="${calendarEscape(country.label)}">${country.flag}</span><span class="ms-rel-title" title="${title}">${title}</span><span class="ms-rel-imp cal-impact imp-${event.importance}" title="${tx("重要等级", "Importance")}: ${calendarEscape(impLabel)}">${calendarImportanceDots(event)}<em>${calendarEscape(impLabel)}</em></span></div>
    <div class="ms-rel-metrics">
      <span class="ms-rel-met is-act"><i>${tx("实际", "Act")}</i><b class="${macroHasActual(event) ? "on" : "empty"}">${val(event.actual)}</b></span>
      <span class="ms-rel-met"><i>${tx("预期", "Est")}</i><b>${val(event.estimate)}</b></span>
      <span class="ms-rel-met"><i>${tx("前值", "Prev")}</i><b>${val(event.previous)}</b></span>
    </div>
    <div class="ms-rel-foot"><span class="ms-rel-when">${calendarEscape(when)} ${tx("北京", "Beijing")}</span>${bias ? `<span class="macro-cmp-tag ${bias.kind}" title="${calendarEscape(bias.tip)}">${calendarEscape(bias.label)}</span>` : ""}</div>
  </article>`;
}
function refreshMacroCompareCountdowns() {
  const now = Date.now();
  const stillUpcoming = new Set();
  let justReleased = false;
  document.querySelectorAll("[data-macro-at]").forEach((el) => {
    const at = Number(el.dataset.macroAt);
    if (!Number.isFinite(at)) return;
    const key = String(at);
    if (at > now) {
      stillUpcoming.add(key);
      el.textContent =
        el.dataset.macroFormat === "bare"
          ? macroCountdownClock(at)
          : `${tx("距今", "In ")} ${macroCountdown(at)}`;
    } else {
      el.textContent = tx("已公布", "Released");
      if (macroUpcomingIds.has(key)) justReleased = true;
    }
  });
  macroUpcomingIds = stillUpcoming;
  // 有数据刚刚公布：立刻强制重取一次，把实际值回填到「宏观经济数据」。
  if (justReleased) {
    loadInvestmentCalendar(true).then(() => { renderFearGreedGauge(); renderReleasedDataCard(); });
    manageMacroLiveFetch();
  }
  // 当前展示的事件如果已过期超过 30 分钟，重新渲染以自动移除。
  const liveEvent = macroCalendarPickedLiveEvent();
  if (liveEvent) {
    const currentAt = Number($("fearGreedGauge")?.querySelector("[data-macro-at]")?.dataset.macroAt);
    if (Number.isFinite(currentAt) && currentAt !== liveEvent.at) renderFearGreedGauge();
  }
}
function renderReleasedDataCard() {
  // v2.11.0：「宏观经济数据」独立卡已并入「宏观事件中枢」——
  // 已公布实际值直接回填在时间流里，影响预测改为事件行展开矩阵。
  // 保留函数名以兼容历史调用点（强刷回填、关注勾选等），仅清理残留 DOM。
  $("releasedDataCard")?.remove();
}

function renderFearGreedGauge() {
  const card = ensureFearGreedCard();
  if (!card) return;
  card.hidden = false;
  /* v2.12.46：不再需要手工勾选 —— 自动挑选最相关的高重要性事件。
     用户仍可「不显示」（进忽略名单）或「更换」（手动指定 / 恢复自动）。 */
  const pinnedNow = macroCalendarPickedLiveEvent();
  const currentKey = pinnedNow ? macroCalendarPickKey(pinnedNow) : "";
  const manualMode = Boolean(macroManualPick) && Boolean(pinnedNow) && currentKey === macroManualPick;
  const candidates = investmentCalendarData?.events ? macroPinCandidates().length : 0;
  const emptyText = candidates
    ? tx("已把所有高重要性事件都设为「不显示」。点「更换」可以挑一条继续盯，或恢复已隐藏的条目。", "Every high-importance event is hidden. Use “Change” to pick one again, or restore the hidden ones.")
    : tx("当前时间窗内没有即将发布或刚公布的高重要性事件。有新的重要宏观数据时，这里会自动显示它的北京时间、倒计时、预期/前值/实际与阈值式解读。", "No high-importance release is upcoming or freshly published. When one appears it shows up here automatically with Beijing time, countdown, estimate/previous/actual and a threshold read-through.");
  const body = pinnedNow
    ? renderPinnedRelease(pinnedNow)
    : `<p class="macro-cmp-empty">${emptyText}</p>`;
  card.className = "card fear-greed-gauge-card fear-greed-compact";
  card.innerHTML = `<div class="fear-greed-head"><h2>${tx("关注宏观事件实时数据", "Pinned macro release")}</h2><span>${tx("实时数据", "Live data")}</span></div>
    <div class="macro-pin-bar">
      <span class="macro-pin-mode${manualMode ? " is-manual" : ""}">${manualMode ? tx("手动", "Manual") : tx("自动", "Auto")}</span>
      ${pinnedNow ? `<button type="button" class="macro-pin-act${macroPinLocked ? " is-locked" : ""}" data-pin-lock aria-pressed="${macroPinLocked}" title="${macroPinLocked ? tx("已锁定：顶部预警条点击不再切换关注对象，只做定位提示；「更换」也已冻结，需先解锁", "Locked: ticker clicks no longer switch the pinned event, they only locate it; “Change” is frozen until you unlock") : tx("锁定当前关注对象，顶部预警条点击不再切换", "Lock the pinned event so ticker clicks don't switch it")}">${macroPinLocked ? tx("🔒 已锁定", "🔒 Locked") : tx("🔓 锁定", "🔓 Lock")}</button>
      <button type="button" class="macro-pin-act${macroPinLocked ? " is-frozen" : ""}" data-pin-change aria-expanded="${macroPickerOpen}" title="${macroPinLocked ? tx("已锁定：请先解锁再更换关注对象", "Locked: unlock first to change the pinned event") : ""}">${tx("更换", "Change")}<i class="ic-caret${macroPickerOpen ? " up" : ""}"></i></button>
      <button type="button" class="macro-pin-act is-quiet" data-pin-hide>${tx("不显示", "Hide")}</button>` : ""}
      <div class="macro-picker ic-menu"${macroPickerOpen ? "" : " hidden"}>${macroPickerHtml(currentKey)}</div>
    </div>
    <div class="fear-greed-compact-grid macro-sentiment-grid">${body}</div>`;
  addHelp(
    card.querySelector(".fear-greed-head h2"),
    "这里自动展示最值得盯的高重要性宏观事件：北京时间、秒级倒计时、预期/前值/实际，以及「高于/低于锚点分别对 BTC 属于利好还是利空」的阈值式解读，不需要手工勾选。挑选顺序是：30 分钟内即将发布的 → 刚公布 30 分钟内的 → 最近的一场高重要性事件。点「锁定」后顶部预警条的点击不再切换关注对象：点的是当前这条就直接滚回来，点别的会跳到宏观事件中枢定位那条事件；锁定期间「更换」也会一并冻结（点击只抖动提示），必须先解锁才能换关注对象。不想要当前这条可以点「不显示」，它会进忽略名单、下次自动跳过；想指定别的就点「更换」，也可以在那里把已隐藏的恢复回来。事件公布超过 30 分钟后会自动让位给下一条；公布前后会每 15 秒强刷一次，第一时间抓取实际值。",
    "This card automatically surfaces the high-importance release most worth watching: Beijing time, a second-level countdown, estimate/previous/actual and a threshold read-through (above/below the anchor → bullish or bearish for BTC). No manual pinning needed: a release within 30 minutes, then one published in the last 30 minutes, then the nearest high-importance event. Press “Lock” and clicks on the top alert ticker stop switching the pinned event: clicking the current one scrolls back here, clicking another locates it in the macro event hub instead. While locked, the “Change” menu is frozen too (clicking it just shakes the button) — unlock first to switch. Use “Hide” to skip the current one (it goes on an ignore list), or “Change” to pick another — that menu also restores hidden items. Releases step aside automatically 30 minutes after publication, and the feed is polled every 15 seconds around the release time to capture actuals immediately.",
  );
  // —— 「锁定 / 更换 / 不显示 / 恢复自动 / 恢复已隐藏」——
  card.querySelector("[data-pin-lock]")?.addEventListener("click", (event) => {
    event.stopPropagation();
    macroPinLocked = !macroPinLocked;
    // 顺手收起「更换」浮层：锁定生效后菜单必须整个冻结，不留半开状态。
    macroPickerOpen = false;
    try { localStorage.setItem(MACRO_PIN_LOCKED_KEY, macroPinLocked ? "1" : "0"); } catch {}
    renderFearGreedGauge();
  });
  card.querySelector("[data-pin-change]")?.addEventListener("click", (event) => {
    event.stopPropagation();
    // v2.12.58：锁定期间「更换」整体冻结 —— 想换关注对象必须先解锁，防止误触换卡。
    if (macroPinLocked) {
      const btn = event.currentTarget;
      btn.classList.remove("is-denied");
      void btn.offsetWidth; /* 重启动画 */
      btn.classList.add("is-denied");
      return;
    }
    macroPickerOpen = !macroPickerOpen;
    renderFearGreedGauge();
  });
  card.querySelector("[data-pin-hide]")?.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!pinnedNow) return;
    macroDismissed.add(currentKey);
    if (macroManualPick === currentKey) macroManualPick = "";
    macroPickerOpen = false;
    saveMacroCalendarPicks();
    renderFearGreedGauge();
    renderInvestmentCalendar(investmentCalendarData);
  });
  card.querySelector(".macro-picker")?.addEventListener("click", (event) => event.stopPropagation());
  card.querySelector("[data-pin-auto]")?.addEventListener("click", (event) => {
    event.stopPropagation();
    macroManualPick = "";
    macroPickerOpen = false;
    saveMacroCalendarPicks();
    renderFearGreedGauge();
    renderInvestmentCalendar(investmentCalendarData);
  });
  card.querySelector("[data-pin-restore]")?.addEventListener("click", (event) => {
    event.stopPropagation();
    macroDismissed.clear();
    saveMacroCalendarPicks();
    renderFearGreedGauge();
    renderInvestmentCalendar(investmentCalendarData);
  });
  card.querySelectorAll("[data-pin-pick]").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    // 更换菜单只在未锁定时可打开（锁定时按钮已冻结）；保留 force 作为显式切换语义。
    focusMacroEvent(button.dataset.pinPick, true);
  }));
  if (!macroCountdownTimer) {
    // 秒级刷新，让「关注事件」的倒计时真正在跳。
    macroCountdownTimer = setInterval(refreshMacroCompareCountdowns, 1000);
  }
  manageMacroLiveFetch();
}
/* 「更换」浮层是页面级浮层，点别处要收起 —— 与日历筛选菜单同一套约定。 */
if (!window.__btcMacroPickerOutsideClickBound) {
  window.__btcMacroPickerOutsideClickBound = true;
  document.addEventListener("click", () => {
    if (!macroPickerOpen) return;
    macroPickerOpen = false;
    renderFearGreedGauge();
  });
}
// 热点新闻板块已移除（用户要求）：保留 fetch/render 帮助函数与 /api/news 路由，
// 但不再自动拉取，避免无谓请求。
// The market-news tile was removed by request; the helpers and /api/news route are
// kept for reuse, but nothing fetches them automatically anymore.
function renderFearGreedSentiment() {
  if (!fearGreedSentiment) return;
  renderFearGreedGauge();
  if (fixedRuleSignal.candles.length) renderFixedRuleSignal();
}
async function loadFearGreedSentiment(force = false) {
  if (fearGreedLoading) return;
  if (force && fearGreedRetryTimer) {
    clearTimeout(fearGreedRetryTimer);
    fearGreedRetryTimer = null;
  }
  fearGreedLoading = true;
  try {
    const response = await apiFetch(`/api/sentiment${force ? "?refresh=1" : ""}`, 10_000),
      data = await response.json();
    if (!response.ok) throw new Error(data.detail || data.error);
    fearGreedSentiment = data;
    fearGreedError = null;
    renderFearGreedSentiment();
    return data;
  } catch (error) {
    fearGreedError = error;
    if (!fearGreedSentiment) renderFearGreedGauge();
    if (!fearGreedRetryTimer)
      fearGreedRetryTimer = setTimeout(() => {
        fearGreedRetryTimer = null;
        loadFearGreedSentiment();
      }, fearGreedRetryMs);
    return null;
  } finally {
    fearGreedLoading = false;
  }
}
/* Append the sentiment reading after the fixed-basis indicator rows. */
addIndicatorDetailEnhancer("fear-greed-sentiment", () => {
  const host = $("indicators"),
    sentiment = fearGreedSentiment;
  if (!host || !Number.isFinite(sentiment?.value)) return;
  const view = fearGreedView(sentiment.value),
    row = document.createElement("div");
  row.className =
    "metric trade-confirmation-row compact-indicator sentiment-indicator";
  row.dataset.fixedBasis = "true";
  row.dataset.indicator = "fear-greed";
  row.innerHTML = `<span>${tx("恐慌贪婪指数", "Fear & Greed")}</span><b>${sentiment.value}/100</b><i class="badge ${view.kind}">${view.label}</i>`;
  const decision = host.querySelector(".trade-decision");
  decision ? decision.before(row) : host.append(row);
  addHelp(
    row.querySelector("span"),
    tx(
      "市场情绪的日频综合读数，范围 0–100。低值表示恐慌、高值表示贪婪。它适合提示“不要追单”的环境风险，不单独预测短线涨跌。",
      "A daily market-sentiment composite from 0–100. Low means fear and high means greed. It flags conditions where chasing a move is risky; it does not predict short-term direction by itself.",
    ),
    tx(
      "公开情绪源，每 2 分钟更新；数据源：Alternative.me。",
      "Public sentiment source, refreshed every 2 minutes; source: Alternative.me.",
    ),
  );
  const reason = decision?.querySelector("p");
  if (reason) reason.textContent = `${reason.textContent} · ${view.note}`;
  host.classList.add("indicator-adaptive-grid");
  host.style.setProperty(
    "--indicator-font-scale",
    host.querySelectorAll(".compact-indicator").length > 12 ? ".78" : ".84",
  );
});
whenIdle(() => {
  loadFearGreedSentiment().then((data) => {
    if (data?.storageCached) setTimeout(() => loadFearGreedSentiment(true), 0);
  });
});
setInterval(() => loadFearGreedSentiment(true), fearGreedRefreshMs);
if (fixedRuleSignal.candles.length) renderFixedRuleSignal();

/* Refresh market-microstructure context after the indicator card has mounted. */
addIndicatorDetailEnhancer("market-microstructure", () => {
  renderOkxMicrostructure(derivativeMarketContext);
});
if (fixedRuleSignal.candles.length) renderFixedRuleSignal();

/* Make the difference between chart granularity and REST polling explicit. */
const loadCurrentWithDataDensity = loadCurrent;
let initialResonanceCalculated = false;
loadCurrent = async function () {
  const refreshed = await loadCurrentWithDataDensity();
  if (refreshed === false || !state.candles.length) return;
  const intervalMs =
      {
        "5s": 5_000,
        "10s": 10_000,
        "30s": 30_000,
        "1m": 60_000,
        "5m": 300_000,
        "15m": 900_000,
        "30m": 1_800_000,
        "1h": 3_600_000,
        "2h": 7_200_000,
        "3h": 10_800_000,
        "4h": 14_400_000,
        "6h": 21_600_000,
        "1d": 86_400_000,
      }[state.interval] || 60_000,
    seconds = intervalMs / 1_000,
    density =
      seconds < 60
        ? `${seconds} ${tx("秒/根", "sec/candle")}`
        : seconds < 3_600
          ? `${seconds / 60} ${tx("分钟/根", "min/candle")}`
          : `${seconds / 3_600} ${tx("小时/根", "hours/candle")}`,
    perHour = 3_600 / seconds,
    coverage = $("coverage"),
    displayed = visibleCandles();
  const insufficient =
      state.range &&
      state.rangeRequiredPoints &&
      state.candles.length < state.rangeRequiredPoints,
    chartError = $("chartError");
  const actualCoverageMs = displayed.length > 1
      ? displayed.at(-1).time - displayed[0].time + intervalMs
      : 0,
    windowText = (ms) => {
      const totalMinutes = Math.max(0, Math.round(ms / 60_000));
      if (totalMinutes < 60) return `${totalMinutes} ${tx("分", "m")}`;
      if (totalMinutes < 1_440)
        return `${Math.floor(totalMinutes / 60)} ${tx("时", "h")}${totalMinutes % 60 ? `${totalMinutes % 60} ${tx("分", "m")}` : ""}`;
      return `${(totalMinutes / 1_440).toFixed(totalMinutes % 1_440 ? 1 : 0)} ${tx("天", "d")}`;
    };
  if (coverage) {
    const availableNote = insufficient
      ? state.marketMeta?.synthetic
        ? tx(
            ` · 秒级 K 线记录 ${displayed.length}/${state.rangeRequiredPoints} 根，时间跨度 ${windowText(actualCoverageMs)}；从本地服务启动后开始积累`,
            ` · Second candles recorded: ${displayed.length}/${state.rangeRequiredPoints} across ${windowText(actualCoverageMs)}; they accumulate while this local service runs`,
          )
        : tx(
            ` · 当前范围需 ${state.rangeRequiredPoints} 根，已显示可用的 ${windowText(actualCoverageMs)}（${displayed.length} 根）`,
            ` · This range needs ${state.rangeRequiredPoints} candles; showing the available ${windowText(actualCoverageMs)} (${displayed.length})`,
          )
      : "";
    const coverStamp = (ms) =>
      new Date(displayed[0].time).getFullYear() !==
      new Date(displayed.at(-1).time).getFullYear()
        ? timeFull(ms)
        : time(ms);
    coverage.textContent = displayed.length
      ? `${tx("查看范围", "Visible range")} ${txInterval(state.range || "--")} · ${tx("图表覆盖", "Chart coverage")}：${coverStamp(displayed[0].time)} ${tx("至", "to")} ${coverStamp(displayed.at(-1).time)} · ${displayed.length} ${tx("根", "candles")} · ${tx("数据粒度", "Granularity")} ${density}（${perHour.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${tx("根/小时", "candles/hour")}）${availableNote} · ${tx("仅此范围参与回测", "only this range is used in backtest")}`
      : "--";
  }
  if (chartError) {
    // A partial historical window is still useful. Keep rendering it instead
    // of covering the canvas (which made long-range choices look like flicker).
    chartError.hidden = true;
  }
  if (!initialResonanceCalculated) {
    initialResonanceCalculated = true;
    void refreshResonance(true);
  }
};

/* Duration is a research estimate, not a fixed label: stronger signals tend
   to persist longer, while a larger ATR relative to price shortens the window. */
function estimatedSignalDuration(m) {
  const minutesByInterval = {
    "5m": 5,
    "15m": 15,
    "30m": 30,
    "1h": 60,
    "4h": 240,
    "6h": 360,
  };
  const candleMinutes = minutesByInterval[fixedRuleSignal.interval] || 15;
  const strength = Math.max(0, Math.min(100, Math.abs(m.score) || 0));
  const atrPercent = Math.max(0.05, (m.atr / Math.max(m.close, 1)) * 100);
  const volatilityFactor = Math.max(0.58, Math.min(1.16, 0.9 / atrPercent));
  const expectedCandles = (1.55 + strength / 25) * volatilityFactor;
  const minMinutes = Math.max(
    candleMinutes,
    Math.round(candleMinutes * expectedCandles * 0.72),
  );
  const maxMinutes = Math.max(
    minMinutes + candleMinutes,
    Math.round(candleMinutes * expectedCandles * 1.36),
  );
  const print = (minutes) =>
    minutes < 60
      ? `${minutes} ${tx("分钟", "min")}`
      : minutes % 60 === 0
        ? `${minutes / 60} ${tx("小时", "h")}`
        : `${(minutes / 60).toFixed(1)} ${tx("小时", "h")}`;
  const urgency =
    minMinutes >= 45 ? "comfort" : minMinutes >= 20 ? "caution" : "urgent";
  return {
    label: `${tx("约", "about")} ${print(minMinutes)}–${print(maxMinutes)}`,
    urgency,
    atrPercent,
  };
}

/* This final override is intentionally placed after compatibility renderers.
   It reuses the same closed-candle basis as the rule signal and only updates
   the projection card when the computed markup actually changes, so live-price
   polling no longer causes the whole card to flicker. */
renderSignalProjection = function () {
  const signal = $("signal"),
    reason = $("signalReason"),
    m = fixedRuleSignal.candles.length
      ? metrics(fixedRuleSignal.candles, state.ticker?.last)
      : state.candles.length
        ? metrics(state.candles)
        : null;
  if (!signal || !reason || !m) return;
  let box = $("signalProjection");
  if (!box) {
    box = document.createElement("section");
    box.id = "signalProjection";
    box.className = "signal-projection";
    reason.after(box);
  }
  const [dirLabel, cls] = classification(m.score);
  const long = cls === "bull",
    flat = cls === "flat",
    last = state.ticker?.last || m.close,
    strength = Math.abs(m.score),
    move = m.atr * (1.05 + Math.min(1.25, strength / 100)),
    target = flat ? last : last + (long ? move : -move),
    duration = estimatedSignalDuration(m),
    dirText = flat
      ? tx("观望", "Neutral")
      : long
        ? tx("做多", "Long")
        : tx("做空", "Short"),
    targetLabel = flat
      ? tx("目标价待方向确认后更新", "Target pending confirmation")
      : `${tx("预计目标价", "Estimated target")} ${money(target)}`,
    tip = flat
      ? tx(
          "当前规则信号处于观望区间，方向研究估算暂时不给出目标价；等待多周期确认后再更新。",
          "The rule signal is neutral right now, so no directional target is estimated; it will update once the multi-timeframe confirmation aligns.",
        )
      : long
        ? tx(
            "预计目标价表示：按当前做多方向、波动和预计持续时间推算的研究目标位；不保证到达或成交。",
            "Estimated target is a research level derived from the current long direction, volatility, and estimated duration; it is not guaranteed.",
          )
        : tx(
            "预计目标价表示：按当前做空方向、波动和预计持续时间推算的研究目标位；不保证到达或成交。",
            "Estimated target is a research level derived from the current short direction, volatility, and estimated duration; it is not guaranteed.",
          );
  const nextClass = `signal-projection ${cls}`;
  if (box.className !== nextClass) box.className = nextClass;
  const html = `<span>${tx("方向研究估算", "Directional research estimate")}</span><div><b>${dirText}</b><em>${tx("预计持续", "Estimated duration")} <mark class="duration-estimate duration-${duration.urgency}" title="按信号强度、ATR 波动和信号基准周期动态估算">${duration.label}</mark></em><strong>${targetLabel} <button class="help-dot" type="button" data-tip="${tip}" aria-label="${tx("预计目标价说明", "Target price explanation")}">!</button></strong></div><small>${tx(`依据规则信号强度、ATR 波动（${duration.atrPercent.toFixed(2)}%）和 ${fixedRuleSignal.interval} 基准周期动态估算；时间越短，方向越容易失效。目标不保证到达。`, `Dynamically estimated from signal strength, ATR volatility (${duration.atrPercent.toFixed(2)}%), and the ${fixedRuleSignal.interval} basis; shorter windows can fail sooner. The target is not guaranteed.`)}</small>`;
  if (box.dataset.lastHtml !== html) {
    box.innerHTML = html;
    box.dataset.lastHtml = html;
  }
};
if (state.candles.length) renderSignalProjection();
/* A legacy timeout above replaces the renderer once during boot.  Reinstall
   the dynamic renderer after that compatibility pass has completed. */
const renderDynamicSignalProjection = renderSignalProjection;
setTimeout(() => {
  renderSignalProjection = renderDynamicSignalProjection;
  renderSignalProjection();
}, 0);

// Preserve the long/short gauge after fixed-basis signal refreshes.
registerRuleSignalEnhancer("signal-gauge", () => {
  const reason = $("signalReason");
  if (
    !reason ||
    fixedRuleSignal.candles.length < 30 ||
    reason.querySelector(".signal-gauge")
  )
    return;
  const m = metrics(fixedRuleSignal.candles),
    direction = m.score >= 0 ? tx("做多", "Long") : tx("做空", "Short"),
    gauge = document.createElement("div"),
    strength = Math.min(100, Math.abs(m.score));
  gauge.className = "signal-gauge";
  gauge.innerHTML = `<div class="gauge-top"><b>${tx("做空", "Short")} −100.00</b><span>${tx("当前", "Now")}：${direction} ${m.score > 0 ? "+" : ""}${m.score.toFixed(2)}</span><b>${tx("做多", "Long")} +100.00</b></div><div class="gauge-track"><i style="left:${Math.max(0, Math.min(100, (m.score + 100) / 2))}%"></i></div><div class="gauge-strength"><em style="width:${strength}%"></em><span>${tx("信号强度", "Signal strength")}：${strength.toFixed(2)}</span></div>`;
  reason.querySelector(".signal-summary")?.after(gauge);
});
if (fixedRuleSignal.candles.length) renderFixedRuleSignal();
whenIdle(() => loadDerivativeMarketContext(true));

/* Keep projection output synchronized with each fixed-basis signal refresh. */
registerRuleSignalEnhancer("signal-projection", () => {
  if (fixedRuleSignal.candles.length >= 30) {
    renderSignalProjection();
  }
});
if (fixedRuleSignal.candles.length) renderFixedRuleSignal();

/* Keep the personal reference quote attached after all late ticker wrappers. */
whenIdle(() => renderPersonalEntryCard());

/* 周期涨幅使用与周期匹配的 K 线历史，不能把不同粒度的间隔当成相同时间长度。
   Period returns use appropriately sized candle histories instead of treating
   a fixed number of whichever candles happen to be on screen as "minutes". */
let periodHistory = {},
  periodHistoryLoading = false,
  periodHistorySource = "";
const periodReturnDefinitions = [
  [tx("较 15 分钟前收盘价", "vs close 15m ago"), "intraday", 15],
  [tx("较 1 小时前收盘价", "vs close 1h ago"), "intraday", 60],
  [tx("较 8 小时前收盘价", "vs close 8h ago"), "day", 480],
  [tx("较 1 日前收盘价", "vs close 1d ago"), "day", 1440],
  [tx("较 3 日前收盘价", "vs close 3d ago"), "day", 4320],
  [tx("较 1 周前收盘价", "vs close 1w ago"), "week", 10080],
  [tx("较 1 月前收盘价", "vs close 1mo ago"), "halfYear", 43200],
  [tx("较 3 月前收盘价", "vs close 3mo ago"), "halfYear", 129600],
  [tx("较半年前收盘价", "vs close 6mo ago"), "halfYear", 259200],
  [tx("较 1 年前收盘价", "vs close 1y ago"), "halfYear", 525600],
];
function periodCloseBefore(candles, minutes) {
  if (!Array.isArray(candles) || !candles.length) return NaN;
  const target = Date.now() - minutes * 60_000;
  for (let i = candles.length - 1; i >= 0; i--)
    if (candles[i].time <= target) return candles[i].close;
  return NaN;
}
function renderExtendedPeriodReturns() {
  const host = $("changeTags"),
    last = state.ticker?.last || state.candles.at(-1)?.close;
  if (!host || !Number.isFinite(last)) return;
  const labels =
    uiLang === "zh"
      ? [
          "近15分",
          "近1小时",
          "近8小时",
          "近1日",
          "近3日",
          "近1周",
          "近1月",
          "近3月",
          "近6月",
          "近1年",
        ]
      : ["15m", "1h", "8h", "1d", "3d", "1w", "1mo", "3mo", "6mo", "1y"];
  const returns = periodReturnDefinitions.map(
      ([label, bucket, minutes], index) => {
        const close = periodCloseBefore(periodHistory[bucket], minutes),
          value = Number.isFinite(close) ? (last / close - 1) * 100 : NaN;
        return { label, short: labels[index], value };
      },
    ),
    max = Math.max(
      0.08,
      ...returns
        .filter((x) => Number.isFinite(x.value))
        .map((x) => Math.abs(x.value)),
    );
  host.innerHTML = returns
    .map((item) => {
      const known = Number.isFinite(item.value),
        kind = known ? (item.value >= 0 ? "bull" : "bear") : "flat",
        height = known
          ? Math.max(5, Math.min(100, (Math.abs(item.value) / max) * 100))
          : 5;
      return `<span class="period-return-bar ${kind}" title="${item.label}"><b>${known ? pct(item.value) : "--"}</b><i><em style="height:${height.toFixed(1)}%"></em></i><small>${item.short}</small></span>`;
    })
    .join("");
}
async function loadExtendedPeriodHistories() {
  const source = state.source || "okx";
  if (periodHistoryLoading && periodHistorySource === source) return;
  if (
    periodHistorySource === source &&
    Object.keys(periodHistory).length === 4
  ) {
    renderExtendedPeriodReturns();
    return;
  }
  periodHistoryLoading = true;
  periodHistorySource = source;
  periodHistory = {};
  renderExtendedPeriodReturns();
  try {
    const groups = await Promise.all(
      [
        /* 15m 桶取 400 根（≈100 小时）覆盖近3日；日 K 桶取 400 根（≈13 个月）覆盖近1年。 */
        ["intraday", "1m", 300],
        ["day", "15m", 400],
        ["week", "1h", 300],
        ["halfYear", "1d", 400],
      ].map(async ([key, interval, limit]) => {
        const response = await apiFetch(
            `/api/market?${new URLSearchParams({ source, interval, limit })}`,
            8_000,
          ),
          data = await response.json();
        if (!response.ok) throw new Error(data.error || key);
        return [key, data.candles];
      }),
    );
    periodHistory = Object.fromEntries(groups);
  } catch {
    /* Individual period cells remain loading/unavailable until the next refresh. */
  } finally {
    periodHistoryLoading = false;
    renderExtendedPeriodReturns();
  }
}
function ensurePeriodChangeCard() {
  let period = $("periodChangeCard");
  if (period) { ensureMarketHealthCard(); return period; }
  period = document.createElement("section");
  period.id = "periodChangeCard";
  period.className = "card change-card chart-periods";
  period.innerHTML = `<h2>${tx("周期涨幅（当前价 vs 历史收盘价）", "Period return (current vs historical close)")}</h2><div id="changeTags"></div>`;
  ensureMarketHealthCard();
  return period;
}
/* ---- 市场异动监测卡片（周期涨幅下方独立小卡片）---- */
let marketHealthData = null;
let marketHealthLoading = false;
function ensureMarketHealthCard() {
  let card = $("marketHealthCard");
  if (card) return card;
  card = document.createElement("section");
  card.id = "marketHealthCard";
  card.className = "card market-health-card";
  card.innerHTML = `<h2>${tx("市场异动监测", "Market anomaly monitor")}<span class="mh-int" id="mhInterval">4h</span><span class="help-dot" data-tip="${mhHelpTip()}"></span></h2><ul class="mh-list" id="mhList"></ul>`;
  return card;
}
function mhHelpTip() {
  return tx("基于现有数据实时监测 5 类异动：①成交量放大（当前 K 线量 ÷ 近 20 根均值，≥1.6× 关注 / ≥2.5× 异动）；②资金费率极端（|费率|≥0.05%/8h 关注 / ≥0.1% 异动）；③永续 OI 快速变化（|变化|≥3% 关注 / ≥8% 异动，约 5 分钟窗口）；④关键支撑/阻力有效收盘突破（最近收盘价实体突破近期摆动高低点）；⑤交易所净流出（CoinMetrics 免费源，日级数据；正=净流入 / 负=净流出）。仅供研究，非投资建议。",
    "Real-time monitoring of 5 anomalies from existing data: ① volume amplification (current bar ÷ 20-bar MA, ≥1.6× watch / ≥2.5× alert); ② extreme funding rate (|rate|≥0.05%/8h watch / ≥0.1% alert); ③ rapid perp OI change (|Δ|≥3% watch / ≥8% alert, ~5 min window); ④ valid close breakout of key S/R (recent close body beyond a swing high/low); ⑤ exchange netflow (free CoinMetrics source, daily; positive = net inflow / negative = net outflow). Research only, not investment advice.");
}
function mhLevelPill(level) {
  const map = { normal: tx("正常", "Normal"), watch: tx("关注", "Watch"), alert: tx("异动", "Alert") };
  return `<span class="mh-pill ${level}">${map[level] || map.normal}</span>`;
}
function mhRow(label, value, level, hint) {
  return `<li class="mh-row"><span class="mh-label">${label}</span><span class="mh-value" title="${hint || ''}">${value}</span>${mhLevelPill(level)}</li>`;
}
function renderMarketHealth() {
  const list = $("mhList"); if (!list) return;
  const d = marketHealthData;
  const head = $("mhInterval"); if (head && d) head.textContent = d.interval || "4h";
  const tip = document.querySelector("#marketHealthCard .help-dot"); if (tip) tip.dataset.tip = mhHelpTip();
  if (!d) { list.innerHTML = `<li class="mh-row mh-empty"><span class="mh-label">${tx("加载中…", "Loading…")}</span></li>`; return; }
  const rows = [];
  rows.push(mhRow(tx("成交量放大", "Volume"), d.volume.ratio != null ? `${d.volume.ratio.toFixed(2)}×` : "--", d.volume.level, d.volume.note));
  rows.push(mhRow(tx("资金费率", "Funding"), d.funding.rate != null ? `${(d.funding.rate * 100).toFixed(4)}%` : "--", d.funding.level, d.funding.note));
  rows.push(mhRow(tx("永续 OI 变化", "Perp OI Δ"), d.oi.changePct != null ? `${d.oi.changePct >= 0 ? "+" : ""}${d.oi.changePct.toFixed(2)}%` : "--", d.oi.level, d.oi.note));
  let srVal = "--", srHint = d.srBreakout.note || "";
  if (d.srBreakout.broken) srVal = tx("突破", "Break ") + (d.srBreakout.broken.type === "resistance" ? tx("阻力", "R") : tx("支撑", "S"));
  else if (d.srBreakout.near) srVal = tx("逼近", "Near ") + (d.srBreakout.near.type === "resistance" ? tx("阻力", "R") : tx("支撑", "S"));
  else srVal = tx("无突破", "None");
  rows.push(mhRow(tx("支撑/阻力", "S/R"), srVal, d.srBreakout.level, srHint));
  const oc = d.onchain || {};
  let whaleVal = "--", whaleHint = oc.note || "";
  if (!oc.configured) whaleVal = tx("未配置", "No key");
  else if (oc.netflow != null || oc.whaleTx != null) {
    const parts = [];
    if (oc.netflow != null) parts.push(`${tx("净流", "Netflow")} ${oc.netflow >= 0 ? "+" : ""}${Math.round(oc.netflow)} BTC`);
    if (oc.whaleTx != null) parts.push(`${tx("巨鲸笔数", "Whale tx")} ${oc.whaleTx}`);
    whaleVal = parts.join(" · ") || "--";
    if (oc.netflow != null) whaleHint = `${tx("交易所净流（正=流入 / 负=流出），日级数据" + (oc.day ? " · " + oc.day : ""), "Exchange netflow (positive = inflow / negative = outflow), daily" + (oc.day ? " · " + oc.day : ""))}${whaleHint ? " · " + whaleHint : ""}`;
  }
  const whaleLevel = oc.configured ? (oc.netflowLevel === "alert" || oc.whaleLevel === "alert" ? "alert" : (oc.netflowLevel === "watch" || oc.whaleLevel === "watch" ? "watch" : "normal")) : "normal";
  rows.push(mhRow(tx("巨鲸/净流出", "Whale/Flow"), whaleVal, whaleLevel, whaleHint));
  list.innerHTML = rows.join("");
}
async function loadMarketHealth() {
  if (marketHealthLoading) return;
  const card = ensureMarketHealthCard();
  if (!card.isConnected) return;
  marketHealthLoading = true;
  try {
    const source = state.source || "okx";
    const r = await fetch("/api/market-health?" + new URLSearchParams({ source, interval: "4h" }));
    if (!r.ok) throw new Error("HTTP " + r.status);
    marketHealthData = await r.json();
    renderMarketHealth();
  } catch {
    if (!marketHealthData) renderMarketHealth();
  } finally {
    marketHealthLoading = false;
  }
}
function ensureFearGreedCard() {
  let card = $("fearGreedGauge");
  const side = document.querySelector(".terminal-layout .side-stack"),
    main = document.querySelector("main");
  // 清理可能残留的旧占位卡（缓存 HTML 里的 hidden 占位），确保唯一且位于 side-stack。
  document.querySelectorAll("#fearGreedGauge").forEach((node) => {
    if (node !== card) node.remove();
  });
  if (!card) {
    card = document.createElement("section");
    card.id = "fearGreedGauge";
    card.className = "card fear-greed-gauge-card fear-greed-compact";
    card.innerHTML = `<div class="fear-greed-head"><h2>${tx("关注宏观事件实时数据", "Pinned macro release")}</h2><span>${tx("实时数据", "Live data")}</span></div><div class="fear-greed-compact-grid macro-sentiment-grid"><section class="fear-greed-compact-tile ms-block ms-pick-release"><span class="macro-tile-label">${tx("关注事件 · 实时数据", "Pinned release")}<em>${tx("最近勾选的事件", "Most recent pick")}</em></span><p class="macro-cmp-empty">${tx("在投资日历勾选事件后，该事件的时间、倒计时与数据解读会显示在这里", "Pin an event in the investment calendar to see its time, countdown and read-through here")}</p></section></div>`;
  }
  // 占位卡优先放进右侧 side-stack；桌面端 arrange() 会保留它，
  // 移动端 arrange() 会把它移到 layout 之后，避免被 hidden 的 side-stack 吞掉。
  if (side) {
    if (!side.contains(card)) side.append(card);
  } else if (!card.isConnected) {
    main?.append(card);
  }
  return card;
}
function ensureReleasedDataCard() {
  // v2.11.0：「宏观经济数据」独立卡下线，见 renderReleasedDataCard 注释。
  $("releasedDataCard")?.remove();
  return null;
}
let sentimentContentFill = false;
function placePeriodAndSentimentCards() {
  const period = ensurePeriodChangeCard(),
    micro = $("okxMicrostructureCard"),
    health = ensureMarketHealthCard(),
    layout = document.querySelector(".terminal-layout"),
    sentiment = ensureFearGreedCard(),
    released = ensureReleasedDataCard();
  // 周期涨幅保持独立卡片外观，但紧贴在 OKX 微观结构之后，不能被右列高度推到下一行。
  // Keep period returns visually independent, directly after microstructure,
  // so the right column never creates an empty area in the chart column.
  // 周期涨幅始终是左列独立卡片、放在 OKX 微观结构卡之后（v2.10.56 起三卡平级），
  // 避免被右侧 side-stack 高度推到下一行产生左列空白。
  if (micro && micro.isConnected) micro.after(period);
  else if (chart?.isConnected && period.parentElement !== chart.parentElement)
    chart.after(period);
  // 市场异动监测卡片放在周期涨幅下方（与周期涨幅同属左列，受 arrange() 的 replaceChildren 清单保护）。
  if (health && health.parentElement !== period.parentElement && period.parentElement) period.after(health);
  else if (health && !health.isConnected) period.after(health);
  // 宏观与情绪的位置统一交给 responsive arrange()：桌面端在右侧 side-stack，
  // 移动端在 terminal-layout 之后。避免多处代码反复移动导致闪烁。
  window.arrangeTerminalLayout?.();
  scheduleMicrostructureAlignment();
  // 异动监测卡片随布局稳定后拉取一次（loading 守卫避免并发重复请求）。
  loadMarketHealth();
  // 布局重排（arrange 里的 side.replaceChildren）会丢弃“早于它插入”的情绪卡，
  // 使卡片停在「正在加载」占位状态。布局稳定后补渲染一次内容（带重入保护）。
  // Layout rearrangement drops the sentiment card when it was inserted too early,
  // leaving the placeholder. Re-render its content once the layout has settled.
  if (!sentimentContentFill && sentiment && !sentiment.querySelector(".macro-sentiment-grid")) {
    sentimentContentFill = true;
    try {
      renderFearGreedGauge();
      renderReleasedDataCard();
    } finally {
      sentimentContentFill = false;
    }
  }
}
let microstructureAlignmentFrame = 0;
function scheduleMicrostructureAlignment() {
  cancelAnimationFrame(microstructureAlignmentFrame);
  microstructureAlignmentFrame = requestAnimationFrame(() => {
    const forecast = document.querySelector("#mainChartCard .forecast-card"),
      fear = $("fearGreedGauge");
    forecast?.style.removeProperty("min-height");
    fear?.style.removeProperty("min-height");
  });
}
window.addEventListener("resize", scheduleMicrostructureAlignment, {
  passive: true,
});
/* Refresh extended historical returns in the same deterministic pass. */
addDecisionRenderEnhancer("extended-periods", () => {
  renderExtendedPeriodReturns();
  loadExtendedPeriodHistories();
  placePeriodAndSentimentCards();
  if (marketHealthData) renderMarketHealth();
});
const renderFearGreedGaugeWithPlacement = renderFearGreedGauge;
renderFearGreedGauge = function () {
  renderFearGreedGaugeWithPlacement();
  placePeriodAndSentimentCards();
};
setTimeout(() => {
  renderFearGreedGauge();
  renderExtendedPeriodReturns();
  loadExtendedPeriodHistories();
  placePeriodAndSentimentCards();
}, 0);
/* The responsive shell completes its own rearrangement shortly after boot.
   A pair of bounded checks is sufficient and avoids observing every live-data
   DOM update, which can otherwise keep the browser's main thread busy. */
setTimeout(placePeriodAndSentimentCards, 180);
setTimeout(placePeriodAndSentimentCards, 900);

/* 历史价格 + 公开新闻研究预测：显示概率、预测窗口与预期价格变化，不生成下单建议。
   Historical-price + public-news research outlook: shows probability, horizon, and expected price change; it never generates an order recommendation. */
// researchOutlookLoading（研究卡加载态）已抽到 src/modules/research.js。
function renderChart({ immediate = false } = {}) {
  /* Hover and drag need an immediate canvas update to keep the crosshair under the pointer. */
  if (immediate) {
    /* Use only the final OHLC renderer. */
    drawCandlestickChart();
    /* Keep pan button state aligned with the frozen range. */
    updatePanControls();
    /* Finish the synchronous interaction repaint. */
    return;
  }
  /* Coalesce normal data, resize, and control updates into one animation frame. */
  scheduleChartRender();
  /* Keep pan button state aligned with the scheduled range. */
  updatePanControls();
}

/* Keep one named boundary for every decision-layer refresh during migration. */
const renderDecisionPanelsLegacy = renderAnalysis;

/* Delegate to the verified legacy composition until each feature is extracted. */
function renderDecisionPanels() {
  /* Preserve the current signal, indicator, pattern, and risk output. */
  renderDecisionPanelsLegacy();
  /* Refresh the interval-aware explanations that previously came from a timer wrapper. */
  refreshDetailedIndicatorHelp();
  /* Render the final target-price implementation, including its explanatory control. */
  renderSignalProjection();
  /* Preserve the original inline placement of the target-price help control. */
  placeTargetHelp();
}

/* Route all existing callers through the named decision-layer boundary. */
renderAnalysis = renderDecisionPanels;

/* Complete one post-boot decision refresh after optional cards have mounted. */
setTimeout(() => {
  /* Avoid building panels before the first candle payload is available. */
  if (state.candles.length) renderDecisionPanels();
}, 0);

/* Synchronize duplicate risk forms while the visible cards are migrated into one tool module. */
function syncRiskInputs(source) {
  /* Read both forms only after their legacy initializers have mounted them. */
  const positionForm = $("positionForm"),
    probabilityForm = $("liqProbabilityForm");
  /* Stop when either optional tool panel is not mounted yet. */
  if (!positionForm || !probabilityForm) return;
  /* Use the form the user just edited as the sole source of truth for shared fields. */
  const from = source === "position" ? positionState : liqProbState;
  /* Copy exactly the fields represented by both tools. */
  for (const field of ["exchange", "side", "amount", "leverage", "entry"]) {
    /* Keep the in-memory position state synchronized. */
    positionState[field] = from[field];
    /* Keep the in-memory probability state synchronized. */
    liqProbState[field] = from[field];
    /* Update the position form without dispatching another input event. */
    if (
      positionForm.elements[field] &&
      document.activeElement !== positionForm.elements[field]
    )
      positionForm.elements[field].value = from[field];
    /* Update the probability form without dispatching another input event. */
    if (
      probabilityForm.elements[field] &&
      document.activeElement !== probabilityForm.elements[field]
    )
      probabilityForm.elements[field].value = from[field];
  }
  /* Persist both legacy keys until their consumers are removed in the next migration step. */
  persistPositionState();
  /* Persist the probability card compatibility state. */
  localStorage.setItem("btc_liq_probability", JSON.stringify(liqProbState));
  /* Recalculate the position summary with the shared inputs. */
  renderPosition();
  /* Recalculate the historical-touch estimate with the same shared inputs. */
  calcLiqProbability();
}

/* Mirror a position edit into the liquidation-probability card. */
$("positionForm")?.addEventListener("input", () => syncRiskInputs("position"));

/* Mirror a liquidation-probability edit into the position card. */
$("liqProbabilityForm")?.addEventListener("input", () =>
  syncRiskInputs("probability"),
);

/* Keep the buffer-reference exchange selector aligned with the shared risk inputs. */
// 研究预测渲染/加载/子面板/宏观事件/回放/消融/参数 + ensureResearchOutlookCard 已抽到 src/modules/research.js（启动时由 initResearch() 初始化；syncMacroPanels 经 setSyncMacroPanels 注入）。

/* 将数据源与页面更新节奏展示在每一张依赖数据的卡片上，避免用户必须查看全局说明才能判断新鲜度。
   Surface data source and UI cadence on every data-backed card, so freshness is visible without opening global documentation. */
function installDataCadenceLabels() {
  const selectedSource = () =>
    String(state.lastGood?.source || state.source || "OKX").toUpperCase();
  // The chart selector already owns its display configuration.  Do not add a
  // second, unrelated help button to the control strip.
  document.querySelector("#mainChartCard .toolbar > .help-dot")?.remove();
  // #ruleSignalCard has its own dedicated help-dot with full signal-state
  // documentation; do not overwrite it with generic cadence text.
  const labels = [
    [
      "#indicatorDetailsCard",
      () =>
        tx(
          `${selectedSource()} K 线 · 每 10 秒`,
          `${selectedSource()} candles · every 10s`,
        ),
    ],
    [
      "#periodChangeCard",
      () =>
        tx(
          `${selectedSource()} 历史 K 线 · 每 10 秒`,
          `${selectedSource()} historical candles · every 10s`,
        ),
    ],
    [
      ".forecast-card",
      () =>
        tx(
          "SQLite 历史 K 线 · 缓存 5 分钟 · 首屏/手动训练",
          "SQLite historical candles · 5m cache · initial/manual training",
        ),
    ],
    [
      /* 共振卡不标数据源（用户要求）：这里只说节奏，避免与周期标签里的来源重复。 */
      ".optional",
      () =>
        tx(
          "多周期 K 线 · 打开页面自动计算 · 15m 约每分钟刷新 · 可手动重算",
          "multi-horizon candles · computed on load · 15m refreshed about every minute · manual recalc available",
        ),
    ],
    [
      ".fed-corr-panel",
      () =>
        tx(
          "BTC + Yahoo Finance（SPY / QQQ）· 缓存 5 分钟 · 手动更新",
          "BTC + Yahoo Finance (SPY / QQQ) · 5m cache · manual refresh",
        ),
    ],
    [
      ".leverage-card",
      () =>
        tx(
          `${selectedSource()} 价格与历史 K 线 · 每 10 秒`,
          `${selectedSource()} price and historical candles · every 10s`,
        ),
    ],
    [
      ".position-card",
      () =>
        tx(
          `${selectedSource()} 标记价 · 每 1 秒`,
          `${selectedSource()} mark price · every 1s`,
        ),
    ],
    [
      "#liqProbabilityCard",
      () =>
        tx(
          `${selectedSource()} 历史 K 线 · 缓存 5 分钟`,
          `${selectedSource()} historical candles · 5m cache`,
        ),
    ],
    [
      "#okxMicrostructureCard",
      () =>
        tx(
          "OKX WebSocket · 实时推送 · 快照每 10 秒",
          "OKX WebSocket · live stream · snapshot every 10s",
        ),
    ],
    [
      "#fearGreedGauge",
      () =>
        tx(
          "Alternative.me · SQLite 首屏优先 · 每 2 分钟",
          "Alternative.me · SQLite first paint · every 2m",
        ),
    ],
    [
      "#fedMonitorCard",
      () =>
        tx(
          "SQLite + Federal Reserve / BLS / Yahoo / CoinGecko / CoinLore · 每 2 分钟",
          "SQLite + Federal Reserve / BLS / Yahoo / CoinGecko / CoinLore · every 2m",
        ),
    ],
    [
      "#researchOutlookCard",
      () =>
        tx(
          "SQLite 历史 + Google News RSS + Alternative.me + OKX · 每 15 分钟",
          "SQLite history + Google News RSS + Alternative.me + OKX · every 15m",
        ),
    ],
  ];
  for (const [selector, text] of labels) {
    for (const card of document.querySelectorAll(selector)) {
      const value = text();
      // Cadence belongs in the card's existing help affordance, not as a
      // footer strip that competes with the card content.
      card.querySelector(":scope > .data-cadence")?.remove();
      const helpHost =
        card.querySelector("h2, h3") ||
        card.querySelector(".toolbar, .chart-tools, .forecast-head") ||
        card.firstElementChild;
      if (!helpHost) continue;
      let help = helpHost.querySelector(".help-dot") || card.querySelector(".help-dot");
      if (!help) {
        addHelp(
          helpHost,
          `数据源与更新频率：${value}`,
          `Data source and update cadence: ${value}`,
        );
        help = helpHost.querySelector(".help-dot");
      }
      if (!help) continue;
      const baseTip = help.dataset.cadenceBaseTip ?? help.dataset.tip ?? "";
      help.dataset.cadenceBaseTip = baseTip;
      help.dataset.tip = `${baseTip}${baseTip ? "\n\n" : ""}${tx("数据源与更新频率：", "Data source and update cadence: ")}${value}`;
    }
  }
}
// 动态卡片会整块重绘；轻量观察器负责恢复频率标识，同时更新切换交易所后的来源名称。
// Dynamic cards redraw their contents; a small observer restores cadence labels and updates the selected source name.
(() => {
  let queued = false;
  const refresh = () => {
    queued = false;
    /* 卡片整块重绘会连 help-dot 一起重建，新按钮上没有 cadenceBaseTip；所以先归位卡片说明，
       再让频率安装器把「数据源与更新频率」追加到说明后面（顺序反了会把说明顶掉）。 */
    syncCardHelpTips();
    installDataCadenceLabels();
  };
  new MutationObserver(() => {
    if (!queued) {
      queued = true;
      queueMicrotask(refresh);
    }
  }).observe(document.querySelector("main"), {
    childList: true,
    subtree: true,
    characterData: true,
  });
  setTimeout(refresh, 0);
  const applyLanguageWithCadence = applyLanguage;
  applyLanguage = function () {
    applyLanguageWithCadence();
    installDataCadenceLabels();
    applyStaticI18n();
  };
})();

// 同步 index.html 中的静态文案（标题、页头、各卡片标题等）到当前语言。
// Sync static text nodes in index.html (title, header, card headings, etc.) to the active language.
function applyStaticI18n() {
  const zh = uiLang === "zh";
  document.querySelectorAll("[data-zh][data-en]").forEach((el) => {
    if (el.matches("title")) {
      document.title = zh ? el.dataset.zh : el.dataset.en;
      return;
    }
    // 仅替换首个文本节点，避免覆盖内部子元素（如 <select>）。
    // Only replace the first text node so nested children (e.g. <select>) are preserved.
    const text = zh ? el.dataset.zh : el.dataset.en;
    if (el.firstChild && el.firstChild.nodeType === 3) {
      el.firstChild.textContent = text;
    } else if (!el.querySelector(":scope > *")) {
      el.textContent = text;
    }
  });
}

/* Keep the first time label wholly inside the plot after the left scale has
   been widened for readable price labels. */
drawChartWithoutDuplicateExtremaText = function () {
  const proto = CanvasRenderingContext2D.prototype,
    fill = proto.fillText;
  proto.fillText = function (text, ...args) {
    if (
      typeof text === "string" &&
      (text.startsWith("最高价") ||
        text.startsWith("最低价") ||
        text.startsWith("Highest price") ||
        text.startsWith("Lowest price"))
    )
      return;
    const x = Number(args[0]),
      isTick = /^\d{2}\/\d{2}\s\d{2}:\d{2}$/.test(text);
    if (isTick) {
      const previous = this.textAlign,
        canvasWidth = this.canvas.width / (devicePixelRatio || 1);
      if (x < 105) {
        this.textAlign = "left";
        args[0] = 52;
      } else if (x > canvasWidth - 145) {
        this.textAlign = "right";
        args[0] = canvasWidth - 74;
      }
      const result = fill.call(this, text, ...args);
      this.textAlign = previous;
      return result;
    }
    return fill.call(this, text, ...args);
  };
  try {
    drawCloseExtrema();
  } finally {
    proto.fillText = fill;
  }
};

/* The changelog follows the version pill, rather than using a fixed viewport
   corner that drifts away when the header is centered or resized. */
$("appVersion")?.addEventListener("click", () => {
  requestAnimationFrame(() => {
    const version = $("appVersion"),
      log = $("versionChangelog");
    if (!version || !log || log.hidden) return;
    const rect = version.getBoundingClientRect(),
      // 实测宽度而非估算值：CSS 宽度是 min(480px, …)，按旧 340 钳制会溢出右边缘。
      width = Math.min(log.offsetWidth || 480, innerWidth - 28);
    log.style.top = `${rect.bottom + 8}px`;
    log.style.left = `${Math.max(14, Math.min(innerWidth - width - 14, rect.left))}px`;
    log.style.right = "auto";
  });
});

// Install after every historical compatibility wrapper so the validity range
// updates with both candle refreshes and one-second live quotes.
/* Re-check the live signal range after every decision refresh. */
addDecisionRenderEnhancer("signal-validity-final", () => {
  renderSignalValidity();
});
if (state.candles.length) renderSignalValidity();

/* Keep the source line and the EMA-convergence alert in their intended slots:
   alert immediately below the gauge, basis after the research estimate. */
function placeRuleSignalMeta() {
  const reason = $("signalReason"),
    slot = $("signalAlertSlot"),
    projection = $("signalProjection"),
    basis = $("fixedRuleBasis");
  if (!reason) return;
  if (slot) reason.after(slot);
  if (projection) (slot || reason).after(projection);
  if (basis) (projection || slot || reason).after(basis);
}

/* 固定的短线提示槽始终占据同一高度；行情提示出现或消失都不会推移下方内容。
   It can carry one highest-priority live warning without moving the cards below. */
function renderSignalAlertSlot(sourceMetrics) {
  const reason = $("signalReason"),
    candles = fixedRuleSignal.candles.length
      ? fixedRuleSignal.candles
      : state.candles;
  if (!reason || candles.length < 6) return;
  reason.querySelector(".short-risk")?.remove();
  let slot = $("signalAlertSlot");
  if (!slot) {
    slot = document.createElement("div");
    slot.id = "signalAlertSlot";
    slot.className = "signal-alert-slot is-empty";
    slot.setAttribute("aria-live", "polite");
    reason.after(slot);
  }
  const m = sourceMetrics || metrics(candles),
    five = (candles.at(-1).close / candles.at(-6).close - 1) * 100,
    atrPct = (m.atr / Math.max(m.close, 1)) * 100,
    emaGap = (Math.abs(m.e20 - m.e50) / Math.max(m.close, 1)) * 100,
    basis = fixedRuleSignal.interval || state.interval || "15m",
    shortWindow = `${basis} · ${tx("最近 5 根", "last 5 candles")}`;
  let alert = null;
  if (m.rsi >= 72)
    alert = {
      kind: "warning",
      text: tx(
        `${basis} · RSI 偏热 ${m.rsi.toFixed(1)} · 短线追高风险上升`,
        `${basis} · RSI elevated ${m.rsi.toFixed(1)} · chasing risk rising`,
      ),
    };
  else if (m.rsi <= 28)
    alert = {
      kind: "warning",
      text: tx(
        `${basis} · RSI 偏弱 ${m.rsi.toFixed(1)} · 短线波动可能放大`,
        `${basis} · RSI weak ${m.rsi.toFixed(1)} · short-term volatility may expand`,
      ),
    };
  else if (Math.abs(five) >= Math.max(0.55, atrPct * 1.75))
    alert = {
      kind: "warning",
      text: tx(
        `${shortWindow} ${pct(five)} · 短线快速${five > 0 ? "拉升" : "回撤"}`,
        `${shortWindow} ${pct(five)} · rapid short-term ${five > 0 ? "rise" : "pullback"}`,
      ),
    };
  else if (emaGap <= Math.max(0.035, atrPct * 0.42))
    alert = {
      kind: "caution",
      text: tx(
        `${basis} · EMA 收敛 ${emaGap.toFixed(2)}% · 方向尚待确认`,
        `${basis} · EMA convergence ${emaGap.toFixed(2)}% · direction awaits confirmation`,
      ),
    };
  else if (Math.abs(five) < Math.max(0.18, atrPct * 0.55))
    alert = {
      kind: "caution",
      text: tx(
        `${shortWindow} ${pct(five)} · 短线无加速 / 震荡`,
        `${shortWindow} ${pct(five)} · no acceleration / consolidation`,
      ),
    };
  if (!alert) {
    slot.className = "signal-alert-slot is-empty";
    slot.replaceChildren();
    placeRuleSignalMeta();
    return;
  }
  slot.className = `signal-alert-slot is-visible short-status ${alert.kind}`;
  let item = slot.querySelector(".signal-alert");
  if (!item) {
    item = document.createElement("p");
    item.className = "signal-alert";
    slot.append(item);
  }
  item.textContent = alert.text;
  placeRuleSignalMeta();
}
/* Render the stable alert slot after all decision content has been refreshed. */
addDecisionRenderEnhancer("signal-alert-slot", () => {
  const candles = fixedRuleSignal.candles.length
    ? fixedRuleSignal.candles
    : state.candles;
  if (candles.length >= 6) renderSignalAlertSlot(metrics(candles));
});
registerRuleSignalEnhancer("stable-alert-slot", () => {
  const candles = fixedRuleSignal.candles;
  if (candles.length >= 6) renderSignalAlertSlot(metrics(candles));
});

/* Register the existing sections after every legacy initializer has mounted them. */
/* Registration is observational in this migration step, so it cannot alter visible layout. */
BTCPanels.register({
  id: "market-summary",
  tier: "decision",
  selector: ".hero",
  defaultOpen: true,
});
BTCPanels.register({
  id: "chart",
  tier: "decision",
  selector: "#mainChartCard",
  defaultOpen: true,
});
BTCPanels.register({
  id: "rule-signal",
  tier: "decision",
  selector: "#ruleSignalCard",
  defaultOpen: true,
});
BTCPanels.register({
  id: "indicators",
  tier: "evidence",
  selector: "#indicatorDetailsCard",
  defaultOpen: true,
});
BTCPanels.register({
  id: "microstructure",
  tier: "evidence",
  selector: "#okxMicrostructureCard",
  defaultOpen: true,
});
BTCPanels.register({
  id: "pattern-analysis",
  tier: "evidence",
  selector: "#patternAnalysis",
  defaultOpen: true,
});
BTCPanels.register({
  id: "resonance",
  tier: "evidence",
  selector: ".optional",
  defaultOpen: true,
});
BTCPanels.register({
  id: "research",
  tier: "research",
  selector: "#researchOutlookCard",
  defaultOpen: true,
});
BTCPanels.register({
  id: "macro",
  tier: "research",
  selector: "#fedMonitorCard",
  defaultOpen: true,
});
BTCPanels.register({
  id: "investment-calendar",
  tier: "research",
  selector: "#investmentCalendarCard",
  defaultOpen: true,
});
BTCPanels.register({
  id: "position-risk",
  tier: "tools",
  selector: ".leverage-card",
  defaultOpen: true,
});
BTCPanels.register({
  id: "alerts",
  tier: "tools",
  selector: "#wechatAlertCard",
  defaultOpen: true,
});

/* Render the quote strip from one source of truth instead of replaying legacy wrappers. */
renderTicker = function () {
  /* Exit until the quote endpoint has supplied a complete ticker. */
  const ticker = state.ticker;
  /* Avoid partially updating the header while the first request is pending. */
  if (!ticker) return;
  /* Resolve the price and change targets once for the whole render. */
  const price = $("price"),
    change = $("change");
  /* Preserve the previous price before the current value becomes the baseline. */
  const previous = previousTickerPrice;
  /* Calculate the signed absolute twenty-four-hour price change. */
  const delta = ticker.last - ticker.open24h;
  /* Determine the displayed twenty-four-hour direction. */
  const up = delta >= 0;
  /* Format the full price before splitting it into animated characters. */
  const value = money(ticker.last);
  /* 浏览器标签栏实时价格（仿 OKX 标签样式「84,291.6 BTC USDT」）：
     复用与页面大屏相同的 money() 格式（去掉 $ 前缀），每个行情 tick 跟随跳动；
     币种跟随 activeCoin()，多币种模式下切币后标签自动换币。 */
  document.title = `${value.replace(/^\$/, "")} ${activeCoin()} USDT`;
  /* Find the first digit that changed so only changed trailing digits animate. */
  let firstChanged = -1;
  /* Compare against the last rendered value when this is not the first quote. */
  if (renderedPriceText !== null) {
    /* A length change means every digit after the currency marker may have moved. */
    if (renderedPriceText.length !== value.length) firstChanged = 0;
    /* Otherwise locate the first differing numeric character. */ else
      for (let index = 0; index < value.length; index++) {
        /* Ignore commas, periods, and the currency marker. */
        if (
          /\d/.test(value[index]) &&
          value[index] !== renderedPriceText[index]
        ) {
          /* Keep the first changed digit for the animation class. */
          firstChanged = index;
          /* Stop after the first difference. */
          break;
        }
      }
  }
  /* Work out whether the animated digits moved up or down. */
  const direction =
    previous === null || ticker.last === previous
      ? ""
      : ticker.last > previous
        ? "up"
        : "down";
  /* Only animate when the quote actually moved AND the direction changed.
     Same price (direction === "") or the same direction as the last tick
     stays calm instead of re-pulsing on every OKX push. */
  const animate = direction !== "" && direction !== previousTickerDirection;
  /* Write exactly the existing digit-level price markup. */
  price.innerHTML = [...value]
    .map(
      (character, index) =>
        `<span class="${/\d/.test(character) ? "price-digit" : ""} ${firstChanged >= 0 && index >= firstChanged && /\d/.test(character) && animate ? `changed-${direction}` : ""}">${character}</span>`,
    )
    .join("");
  /* Keep the existing amount, percentage, and live-time presentation. */
  change.innerHTML = `<span class="change-amount">${delta >= 0 ? "+" : "−"}$${Math.abs(delta).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span><span class="change-pct">${pct(ticker.changePct)}</span><span class="price-market-meta"><small id="priceTime">${tx("实时", "Live")} ${pointTime(Date.now())}</small></span>`;
  /* Apply the market direction class used by the existing stylesheet. */
  change.className = up ? "bull" : "bear";
  /* Remove legacy container pulses: digit spans alone own quote animation. */
  price.classList.remove("price-up", "price-down");
  /* Save the current rendered text for the next digit-level comparison. */
  renderedPriceText = value;
  /* Save the current quote as the next refresh baseline. */
  previousTickerPrice = ticker.last;
  /* Remember the last move direction so repeated ticks in the same direction
     no longer re-trigger the digit pulse animation (same-direction calm). */
  if (direction !== "") previousTickerDirection = direction;
  /* Update the legacy compact header only when it is present. */
  const compactOpen24 = $("open24"),
    compactHighLow = $("highlow");
  if (compactOpen24) compactOpen24.textContent = money(ticker.open24h);
  if (compactHighLow) compactHighLow.textContent = `${money(ticker.high24)} / ${money(ticker.low24)}`;
  /* Resolve the readable perpetual-market name for the hero card. */
  const source = state.lastGood?.source || state.source;
  /* Use the same exchange labels as the existing final wrapper. */
  const market =
    {
      okx: tx("OKX USDT 永续", "OKX USDT perpetual"),
      coinbase: tx("Coinbase " + coinMetaOf().coinbase + " 永续", "Coinbase " + coinMetaOf().coinbase + " perpetual"),
      binance: tx("Binance USDT-M 永续", "Binance USDT-M perpetual"),
      gate: tx("Gate USDT 永续", "Gate USDT perpetual"),
    }[source] || tx("USDT 永续", "USDT perpetual");
  /* Update the legacy compact header only when it is present. */
  const compactSource = $("sourceUsed");
  if (compactSource) compactSource.textContent = market;
  /* Recreate the source line if an early render has not created it yet. */
  let sourceLine = $("priceSource");
  /* Append the source line beside the live timestamp exactly once. */
  if (!sourceLine) {
    /* Build the existing semantic element. */
    sourceLine = document.createElement("small");
    /* Retain the public selector used by later UI code. */
    sourceLine.id = "priceSource";
    /* Append it after the live timestamp. */
    $("priceTime")?.after(sourceLine);
  }
  /* Keep the final refresh-frequency wording that the current UI displays. */
  if (sourceLine)
    sourceLine.textContent = `${tx("来源", "Source")}：${String(source || "--").toUpperCase()} · ${tx("刷新", "Refresh")} ${refreshIntervalMs / 1000}${tx("秒/次", "s/request")}`;
  /* Refresh personal-entry P&L once, rather than through duplicate wrappers. */
  renderPersonalEntryCard();
  /* Refresh the signal-validity marker alongside every live quote. */
  renderSignalValidity();
};

/* Route every chart repaint through one public boundary. */
$("leverageExchange")?.addEventListener("change", (event) => {
  /* Store the selected exchange in both risk states. */
  positionState.exchange = event.target.value;
  /* Store the selected exchange in the probability state. */
  liqProbState.exchange = event.target.value;
  /* Refresh both panels from the unified exchange selection. */
  syncRiskInputs("position");
});

/* Calculate exchange-agnostic position risk once for every risk-oriented panel. */
function calculatePositionRisk({
  exchange,
  side,
  amount,
  margin,
  leverage,
  entry,
  mark,
}) {
  /* Resolve the supported exchange fee and maintenance-margin assumptions. */
  const rules = {
    binance: { fee: 0.0005, mmr: 0.004 },
    okx: { fee: 0.0005, mmr: 0.005 },
    coinbase: { fee: 0.0006, mmr: 0.006 },
  }[exchange] || { fee: 0.0005, mmr: 0.005 };
  /* Normalize the notional value so incomplete forms remain safe to render. */
  const notional = Math.max(0, Number(amount) || 0);
  /* Normalize the configured leverage and stay inside the public one-to-one hundred range. */
  const normalizedLeverage = Math.min(
    100,
    Math.max(
      1,
      Number(leverage) || notional / Math.max(0.01, Number(margin) || 1),
    ),
  );
  /* Derive margin from leverage when the probability card does not collect it directly. */
  const normalizedMargin = Math.max(
    0.01,
    Number(margin) || notional / normalizedLeverage,
  );
  /* Use the live price only as a display fallback for an empty entry field. */
  const normalizedEntry = Math.max(0, Number(entry) || state.ticker?.last || 0);
  /* Use the entry price when no independent mark price is available. */
  const normalizedMark = Math.max(0, Number(mark) || normalizedEntry);
  /* Convert the UI direction into a signed multiplier. */
  const sign = side === "short" ? -1 : 1;
  /* Convert the USDT notional into BTC exposure for liquidation arithmetic. */
  const quantity = normalizedEntry ? notional / normalizedEntry : 0;
  /* Calculate gross P&L before fees. */
  const gross = normalizedEntry
    ? (sign * notional * (normalizedMark - normalizedEntry)) / normalizedEntry
    : 0;
  /* Estimate round-trip taker fees with the existing exchange assumptions. */
  const fees = notional * rules.fee * 2;
  /* Calculate net P&L after the display-only fee estimate. */
  const net = gross - fees;
  /* Use the same isolated-margin approximation used by the current position card. */
  const liquidation =
    sign > 0
      ? normalizedEntry * (1 - 1 / normalizedLeverage + rules.mmr)
      : normalizedEntry * (1 + 1 / normalizedLeverage - rules.mmr);
  /* Return a frozen result so panels cannot accidentally diverge by mutating it. */
  return Object.freeze({
    notional,
    margin: normalizedMargin,
    leverage: normalizedLeverage,
    entry: normalizedEntry,
    mark: normalizedMark,
    sign,
    quantity,
    gross,
    fees,
    net,
    liquidation,
    feeRate: rules.fee,
    maintenanceMarginRate: rules.mmr,
  });
}

/* Replace the position-card calculation with the shared risk calculation. */
positionCalc = function () {
  /* Calculate from the position form's shared state. */
  const risk = calculatePositionRisk(positionState);
  /* Preserve the legacy property names consumed by the existing position renderer. */
  return {
    amount: risk.notional,
    margin: risk.margin,
    entry: risk.entry,
    mark: risk.mark,
    lev: risk.leverage,
    fees: risk.feeRate,
    gross: risk.gross,
    fee: risk.fees,
    net: risk.net,
    liq: risk.liquidation,
    side: risk.sign,
  };
};

/* ===== v2.10.10 强平概率计算器：快捷填充 / 持仓价快选 / 手动计算 / 长周期触及概率 =====
   这一层只在运行时接上操作条、替换渲染函数并扩展历史窗口，不改写旧卡片的 DOM 外壳。
   Shortcut layer only: it wires an action bar, swaps the renderer and widens the historical
   windows without rewriting the legacy card markup. */
(function () {
  /* 做多 / 做空持仓价的本地记录（用户每次确认持仓或改开仓均价时更新）。
     多币种（v2.12.5）：按币种独立存储，BTC 沿用旧键。 */
  const entryBookKey = () =>
    "btc_position_entry_book" + coinStorageSuffix();
  /* 日线样本少于这个根数时不展示长周期窗口，避免用十几个样本凑出一个假概率。 */
  const MIN_DAILY_SAMPLES = 200;
  const MIRRORED_FIELDS = ["exchange", "side", "amount", "leverage", "entry"];

  function readEntryBook() {
    try {
      const raw = JSON.parse(localStorage.getItem(entryBookKey()) || "{}");
      return {
        long: Number(raw.long) > 0 ? Number(raw.long) : null,
        short: Number(raw.short) > 0 ? Number(raw.short) : null,
      };
    } catch {
      return { long: null, short: null };
    }
  }
  let entryBook = readEntryBook(),
    entryBookCoin = activeCoin();
  /* 币种切换后第一次触到记录簿时，先换成当前币种自己的记录，
     避免把 BTC 的历史持仓价抄进其它币种的键里。 */
  function syncEntryBookCoin() {
    if (entryBookCoin !== activeCoin()) {
      entryBookCoin = activeCoin();
      entryBook = readEntryBook();
    }
  }
  function saveEntryBook() {
    try {
      localStorage.setItem(entryBookKey(), JSON.stringify(entryBook));
    } catch {
      /* 隐私模式下 localStorage 可能不可写，记录失败不影响本次会话使用。 */
    }
  }

  let liqDailyCandles = [],
    liqDirty = false,
    dailyLoading = false,
    flashTimer = 0;

  function isValidCandle(candle) {
    return (
      !!candle &&
      Number.isFinite(candle.close) &&
      Number.isFinite(candle.low) &&
      Number.isFinite(candle.high)
    );
  }
  /* 按方向取整段样本的极值：做多关心最低、做空关心最高。 */
  function extremeOf(candles, side) {
    if (!candles.length) return NaN;
    let value = side > 0 ? candles[0].low : candles[0].high;
    for (const candle of candles) {
      if (side > 0) {
        if (candle.low < value) value = candle.low;
      } else if (candle.high > value) value = candle.high;
    }
    return value;
  }
  /* 统一按北京时间标注样本区间，避免 UTC 与本地日期混用。 */
  function sampleDay(ms) {
    if (!Number.isFinite(ms)) return "--";
    return new Intl.DateTimeFormat(uiLang === "zh" ? "zh-CN" : "en-US", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(ms));
  }

  function setDirty(value) {
    liqDirty = !!value;
    const hint = $("liqProbDirtyHint"),
      button = $("liqProbCompute");
    if (hint) hint.hidden = !liqDirty;
    if (button) button.classList.toggle("is-dirty", liqDirty);
  }
  function flash(message) {
    const el = $("liqProbFlash");
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      el.hidden = true;
    }, 2400);
  }

  /* 渲染：窗口统计 + 分组展示，仍然是「经验估算」而非交易所强平引擎。 */
  function renderLiqProbability() {
    const form = $("liqProbabilityForm"),
      out = $("liqProbabilityOutput");
    if (!form || !out) return;
    setDirty(false);
    const p = liqProbState,
      livePrice = state.ticker?.last || state.candles.at(-1)?.close || 0,
      rawEntry = Number(p.entry),
      requestedEntry = rawEntry >= 10_000 ? rawEntry : livePrice,
      requestedLeverage = Math.min(
        100,
        Math.max(1, Math.round(Number(p.leverage) || 1)),
      );
    const risk = calculatePositionRisk({
      ...p,
      entry: requestedEntry,
      mark: requestedEntry,
      margin: (Number(p.amount) || 0) / requestedLeverage,
    });
    const entry = risk.entry,
      amount = risk.notional,
      lev = risk.leverage,
      side = risk.sign,
      liq = risk.liquidation,
      fee = risk.feeRate,
      distance = entry ? Math.abs(liq - entry) / entry : NaN,
      direction = side > 0 ? tx("做多", "Long") : tx("做空", "Short");
    /* 空的开仓价先跟上实时价，但不要抢用户正在输入的输入框。 */
    if (
      form.elements.entry &&
      rawEntry < 10_000 &&
      livePrice &&
      document.activeElement !== form.elements.entry
    ) {
      p.entry = livePrice;
      form.elements.entry.value = livePrice.toFixed(2);
      localStorage.setItem("btc_liq_probability", JSON.stringify(p));
    }
    if (
      form.elements.leverage &&
      String(lev) !== String(p.leverage) &&
      document.activeElement !== form.elements.leverage
    ) {
      p.leverage = lev;
      form.elements.leverage.value = lev;
      localStorage.setItem("btc_liq_probability", JSON.stringify(p));
    }
    const shortHistory =
        liqHistoricalCandles.length >= 100
          ? liqHistoricalCandles
          : state.candles.filter(isValidCandle),
      longHistory =
        liqDailyCandles.length >= MIN_DAILY_SAMPLES ? liqDailyCandles : [],
      shortWindows = [
        ["12h", 48],
        ["24h", 96],
        ["48h", 192],
        [tx("1 周", "1 week"), 672],
      ],
      longWindows = [
        [tx("半个月", "15 days"), 15],
        [tx("一个月", "1 month"), 30],
        [tx("半年", "6 months"), 180],
        [tx("一年", "1 year"), 365],
      ],
      build = (windows, candles) =>
        windows.map(([label, window]) => ({
          label,
          window,
          ...liqTouchStats(candles, side, distance, window),
        })),
      shortItems = build(shortWindows, shortHistory),
      longItems = build(longWindows, longHistory),
      windowCards = (items) =>
        items
          .map((item) =>
            item.total
              ? `<div class="liq-prob-window"><small>${item.label} ${tx("历史触及概率", "historical touch")}</small><b class="${liqRiskKind(item.probability)}">${item.probability.toFixed(2)}%</b><em>n=${item.total}</em></div>`
              : `<div class="liq-prob-window"><small>${item.label} ${tx("历史触及概率", "historical touch")}</small><b class="flat">--</b><em>${tx("样本不足", "too few samples")}</em></div>`,
          )
          .join("");
    /* 样本区间必须写清楚：短线只有约十天，长线是日线，否则「n=953」会被误读成长期统计。 */
    const rangeLabel = (candles) =>
        candles.length
          ? `${candles.length} ${tx("根", "bars")}（${sampleDay(candles[0].time)} → ${sampleDay(candles.at(-1).time)}）`
          : tx("暂不可用", "unavailable"),
      shortUnit =
        liqHistoricalCandles.length >= 100
          ? tx("15 分钟 K 线", "15m candles")
          : txInterval(state.interval),
      sampleNote = `${tx("短线样本", "Short samples")} ${shortUnit} ${rangeLabel(shortHistory)}；${
        longHistory.length
          ? `${tx("长线样本", "long samples")} ${tx("日线", "daily")} ${rangeLabel(longHistory)}`
          : tx("长线样本（日线）暂不可用", "long samples (daily) unavailable")
      }`;
    out.innerHTML =
      `<div><small>${tx("理论强平价", "Theoretical liquidation")}</small><b class="bear">${money(liq)}</b></div>` +
      `<div><small>${tx("历史极值价格", "Historical extreme price")}</small><b class="${side > 0 ? "bear" : "bull"}">${money(extremeOf(shortHistory, side))}</b></div>` +
      `<div><small>${tx("距成本价", "Distance from entry")}</small><b>${Number.isFinite(distance) ? (distance * 100).toFixed(2) : "--"}%</b></div>` +
      `<div><small>${tx("手续费参考（开+平）", "Fee reference (in + out)")}</small><b>${money(amount * fee * 2)}</b></div>` +
      `<div class="liq-prob-windows">` +
      `<div class="liq-prob-window-group"><h4>${tx("短线窗口 · 15 分钟 K 线", "Short windows · 15m candles")}</h4><div class="liq-prob-window-grid">${windowCards(shortItems)}</div></div>` +
      `<div class="liq-prob-window-group"><h4>${tx("长线窗口 · 日线", "Long windows · daily candles")}</h4><div class="liq-prob-window-grid">${windowCards(longItems)}</div></div>` +
      `</div>` +
      `<p class="${liqRiskKind(shortItems[0]?.probability || 0)}">${direction} · ${tx("以成本价", "Uses entry")} ${money(entry)} · ${lev}× · ${sampleNote}。${tx("历史窗口互相重叠，长周期样本相关性高，且杠杆越高强平距离越近、长窗口越容易饱和到 100%；仅作风险研究，不代表未来真实概率或交易所强平价。", "Windows overlap, so long-horizon samples are highly correlated, and higher leverage means a shorter liquidation distance that saturates long windows at 100%; risk research only, not a future probability or an exchange liquidation price.")}</p>`;
  }

  /* 独立的日线取数通道：不复用旧版 intraday 加载器，避免两个请求互相把对方挡在 loading 上。 */
  async function loadDailyHistory(attempt = 0) {
    if (dailyLoading || liqDailyCandles.length >= MIN_DAILY_SAMPLES) return;
    dailyLoading = true;
    try {
      const response = await apiFetch("/api/forecast-history", 20_000),
        data = await response.json();
      if (!response.ok) throw new Error(data.error || "history unavailable");
      liqDailyCandles = (data.daily || []).filter(isValidCandle);
      if (!liqDirty) renderLiqProbability();
    } catch {
      /* 保留已有样本；下一次尝试再补。 */
    } finally {
      dailyLoading = false;
    }
    if (liqDailyCandles.length < MIN_DAILY_SAMPLES && attempt < DAILY_HISTORY_MAX_RETRIES) {
      setTimeout(() => loadDailyHistory(attempt + 1), DAILY_HISTORY_RETRY_DELAY_MS);
    }
  }

  function entryMenu() {
    return $("liqProbEntryMenu");
  }
  /* 顶部「我的持仓」两个舱段的原始数据：price / amount / margin / leverage(开仓杠杆) / side。
     保证金优先，缺失时用 持仓量÷开仓杠杆 反推；有效杠杆 = 持仓量÷保证金，与顶部卡片
     显示的理论强平价同一口径（见 personalEntrySlot 与 v2.10.7 的强平价修复）。 */
  function topSlots() {
    const list = Array.isArray(window.btcPersonalEntries)
      ? window.btcPersonalEntries
      : [];
    const positive = (value) => (Number(value) > 0 ? Number(value) : null);
    return [0, 1].map((index) => {
      const entry = list[index] || {},
        price = positive(entry.price),
        amount = positive(entry.amount),
        margin = positive(entry.margin),
        configured = positive(entry.leverage),
        collateral =
          margin || (amount && configured ? amount / configured : null),
        effective = amount && collateral ? amount / collateral : configured;
      return {
        index,
        side: entry.side === "short" ? "short" : "long",
        price,
        amount,
        margin,
        collateral,
        configured,
        effective,
      };
    });
  }
  const slotSideLabel = (side) =>
    side === "short" ? tx("做空", "Short") : tx("做多", "Long");
  function slotMeta(slot) {
    const bits = [];
    if (slot.amount) bits.push(`${tx("持仓", "Size")} ${money(slot.amount)}`);
    if (slot.collateral)
      bits.push(`${tx("保证金", "Margin")} ${money(slot.collateral)}`);
    if (slot.effective)
      bits.push(`${tx("有效杠杆", "Effective")} ${slot.effective.toFixed(2)}×`);
    if (
      slot.configured &&
      slot.effective &&
      Math.abs(slot.configured - slot.effective) > 0.005
    )
      bits.push(`${tx("开仓杠杆", "Entry")} ${slot.configured.toFixed(2)}×`);
    return bits.join(" · ");
  }
  /* 把某个舱段折算成计算器的字段：方向 / 开仓均价 / 持仓量 / 有效杠杆。 */
  function slotFields(slot) {
    const fields = { side: slot.side, entry: slot.price };
    if (slot.amount) fields.amount = Math.round(slot.amount * 100) / 100;
    if (slot.effective && slot.effective >= 1)
      fields.leverage = Math.min(100, Math.round(slot.effective * 100) / 100);
    return fields;
  }
  /* 顶部卡片改动后把舱段价格抄进本地记录，让历史记录始终跟得上。 */
  function refreshEntryBookFromSlots() {
    syncEntryBookCoin();
    let changed = false;
    for (const slot of topSlots())
      if (slot.price && entryBook[slot.side] !== slot.price) {
        entryBook[slot.side] = slot.price;
        changed = true;
      }
    if (changed) saveEntryBook();
  }
  function syncEntryMenu() {
    const menu = entryMenu();
    if (!menu) return;
    refreshEntryBookFromSlots();
    const slots = topSlots(),
      slotRow = (slot) =>
        `<button type="button" data-liq-slot="${slot.index}" class="${slot.side}"${slot.price ? "" : " disabled"}>` +
        `<span class="liq-entry-title"><em>${tx("顶部舱段", "Top slot")} ${slot.index + 1}</em><i>${slotSideLabel(slot.side)}</i></span>` +
        `<b>${slot.price ? money(slot.price) : "--"}</b>` +
        `<small>${
          slot.price
            ? slotMeta(slot) || tx("只有开仓均价", "Entry price only")
            : tx("顶部持仓卡还没填这一格", "This top slot is still empty")
        }</small></button>`;
    /* 已填价格的舱段优先；某方向没有舱段数据时，退回上一次记录下的持仓价。 */
    const covered = new Set(slots.filter((slot) => slot.price).map((slot) => slot.side)),
      fallback = ["long", "short"]
        .filter((side) => !covered.has(side) && entryBook[side])
        .map(
          (side) =>
            `<button type="button" data-liq-entry="${side}" class="${side}">` +
            `<span class="liq-entry-title"><em>${tx("历史记录", "Saved")}</em><i>${slotSideLabel(side)}${tx("持仓价", " entry")}</i></span>` +
            `<b>${money(entryBook[side])}</b></button>`,
        )
        .join("");
    menu.innerHTML = slots.map(slotRow).join("") + fallback;
  }
  function closeEntryMenu() {
    const menu = entryMenu(),
      trigger = document.querySelector("[data-liq-action='entry']");
    if (menu && !menu.hidden) menu.hidden = true;
    if (trigger) trigger.setAttribute("aria-expanded", "false");
  }
  function toggleEntryMenu() {
    const menu = entryMenu();
    if (!menu) return;
    syncEntryMenu();
    const open = menu.hidden;
    menu.hidden = !open;
    const trigger = document.querySelector("[data-liq-action='entry']");
    if (trigger) trigger.setAttribute("aria-expanded", String(open));
  }

  /* 记录用户自己的做多 / 做空持仓价。 */
  function recordPositionEntry() {
    syncEntryBookCoin();
    const form = $("positionForm");
    if (!form || !form.elements.entry || !form.elements.side) return;
    const price = Number(form.elements.entry.value);
    if (!Number.isFinite(price) || price <= 0) return;
    const side = form.elements.side.value === "short" ? "short" : "long";
    if (entryBook[side] === price) return;
    entryBook[side] = price;
    saveEntryBook();
    syncEntryMenu();
  }

  /* 写回计算器字段：同时镜像到旧持仓卡并重算，保证上下两块数字一致。 */
  function writeLiqFields(fields, note) {
    const form = $("liqProbabilityForm");
    if (!form) return;
    for (const [field, value] of Object.entries(fields)) {
      if (value === undefined || value === null || value === "") continue;
      liqProbState[field] = value;
      if (form.elements[field]) form.elements[field].value = value;
    }
    localStorage.setItem("btc_liq_probability", JSON.stringify(liqProbState));
    syncRiskInputs("probability");
    renderLiqProbability();
    if (note) flash(note);
  }

  /* 「引用顶部持仓数据」：优先取顶部持仓卡里与当前方向一致、且已填价格的舱段。 */
  function pullPositionData() {
    const filled = topSlots().filter((slot) => slot.price),
      wanted = liqProbState.side === "short" ? "short" : "long",
      slot = filled.find((item) => item.side === wanted) || filled[0];
    if (slot) {
      writeLiqFields(
        slotFields(slot),
        `${tx("已引用", "Applied")} ${tx("顶部舱段", "top slot")} ${slot.index + 1} · ${slotSideLabel(slot.side)} ${
          slotMeta(slot) || money(slot.price)
        }`,
      );
      return;
    }
    /* 顶部卡片还没填时，退回旧的「我的持仓与盈亏估算」卡片。 */
    const fields = {};
    for (const field of MIRRORED_FIELDS) {
      const value = positionState[field];
      if (value === undefined || value === null || value === "") continue;
      if (
        ["amount", "leverage", "entry"].includes(field) &&
        !(Number(value) > 0)
      )
        continue;
      fields[field] = value;
    }
    writeLiqFields(
      fields,
      tx(
        "顶部持仓卡还没填数据，已改用旧的持仓卡",
        "Top card is empty; used the older position card",
      ),
    );
  }

  /* 选中某个顶部舱段：一次填好方向 / 开仓均价 / 持仓量 / 有效杠杆。 */
  function applySlot(index) {
    closeEntryMenu();
    const slot = topSlots().find((item) => item.index === index);
    if (!slot || !slot.price) {
      flash(tx("该舱段还没有开仓均价", "That slot has no entry price yet"));
      return;
    }
    writeLiqFields(
      slotFields(slot),
      `${tx("已填入", "Filled")} ${tx("顶部舱段", "top slot")} ${index + 1} · ${slotSideLabel(slot.side)} ${money(slot.price)}${
        slotMeta(slot) ? ` · ${slotMeta(slot)}` : ""
      }`,
    );
  }

  function applyEntryPrice(side) {
    closeEntryMenu();
    const price = entryBook[side];
    if (!price) {
      flash(tx("还没有记录到该方向的持仓价", "No entry price recorded yet"));
      return;
    }
    writeLiqFields(
      { side, entry: price },
      `${tx("已填入", "Filled")} ${
        side === "short"
          ? tx("做空持仓价", "short entry")
          : tx("做多持仓价", "long entry")
      } ${money(price)}`,
    );
  }

  /* 表单一改动就做「待计算」，把计算时机交回给「计算」按钮。 */
  function bindManualForm() {
    const form = $("liqProbabilityForm");
    if (!form || form.dataset.liqManual === "1") return;
    form.dataset.liqManual = "1";
    form.oninput = null;
    form.addEventListener("input", (event) => {
      if (event.target && event.target.name)
        liqProbState[event.target.name] = event.target.value;
      localStorage.setItem("btc_liq_probability", JSON.stringify(liqProbState));
      setDirty(true);
    });
  }

  function installActions() {
    const card = $("liqProbabilityCard"),
      form = $("liqProbabilityForm");
    if (!card || !form) return false;
    if ($("liqProbActions")) {
      syncEntryMenu();
      return true;
    }
    const bar = document.createElement("div");
    bar.id = "liqProbActions";
    bar.className = "liq-prob-actions";
    bar.innerHTML =
      `<button type="button" data-liq-action="pull">${tx("引用顶部持仓数据", "Use position above")}</button>` +
      `<div class="liq-entry-picker"><button type="button" data-liq-action="entry" aria-haspopup="true" aria-expanded="false">${tx("填入我的持仓价", "Fill my entry price")} ▾</button>` +
      `<div id="liqProbEntryMenu" class="liq-entry-menu" hidden role="menu"></div></div>` +
      `<button type="button" id="liqProbCompute" class="liq-prob-compute" data-liq-action="compute">${tx("计算", "Calculate")}</button>` +
      `<span id="liqProbFlash" class="liq-prob-flash" hidden></span>`;
    const hint = document.createElement("p");
    hint.id = "liqProbDirtyHint";
    hint.className = "liq-prob-hint";
    hint.hidden = true;
    hint.textContent = tx(
      "参数已修改，点击「计算」更新结果。",
      "Inputs changed - press Calculate to refresh.",
    );
    /* 有效杠杆常带小数（如 19.93×），放宽步长以免被浏览器判成非法值。 */
    const levInput = form.elements.leverage;
    if (levInput) levInput.step = "0.01";
    form.after(bar);
    bar.after(hint);
    bar.addEventListener("click", (event) => {
      const target = event.target;
      if (target.closest("[data-liq-action='entry']")) {
        /* 必须拦下冒泡：document 上的关闭监听会把刚打开的浮层当场关掉。 */
        event.stopPropagation();
        toggleEntryMenu();
        return;
      }
      const slot = target.closest("[data-liq-slot]");
      if (slot) {
        event.stopPropagation();
        applySlot(Number(slot.dataset.liqSlot));
        return;
      }
      const item = target.closest("[data-liq-entry]");
      if (item) {
        event.stopPropagation();
        applyEntryPrice(item.dataset.liqEntry);
        return;
      }
      if (target.closest("[data-liq-action='pull']")) {
        event.stopPropagation();
        pullPositionData();
        return;
      }
      if (target.closest("[data-liq-action='compute']")) {
        event.stopPropagation();
        closeEntryMenu();
        renderLiqProbability();
      }
    });
    document.addEventListener("click", closeEntryMenu);
    bindManualForm();
    syncEntryMenu();
    return true;
  }

  function relabelShortcuts() {
    const pull = document.querySelector("[data-liq-action='pull']"),
      pick = document.querySelector("[data-liq-action='entry']"),
      compute = $("liqProbCompute"),
      hint = $("liqProbDirtyHint");
    if (pull) pull.textContent = tx("引用顶部持仓数据", "Use position above");
    if (pick)
      pick.textContent = `${tx("填入我的持仓价", "Fill my entry price")} ▾`;
    if (compute) compute.textContent = tx("计算", "Calculate");
    if (hint)
      hint.textContent = tx(
        "参数已修改，点击「计算」更新结果。",
        "Inputs changed - press Calculate to refresh.",
      );
    syncEntryMenu();
    if (!liqDirty) renderLiqProbability();
  }

  /* 旧版会在两个卡片之间自动镜像输入；保留镜像，但不再顺带重算，交给「计算」按钮。 */
  const syncRiskInputsBaseline = syncRiskInputs;
  syncRiskInputs = function (source) {
    const positionForm = $("positionForm"),
      probabilityForm = $("liqProbabilityForm");
    if (!positionForm || !probabilityForm) return;
    const from = source === "position" ? positionState : liqProbState;
    for (const field of MIRRORED_FIELDS) {
      positionState[field] = from[field];
      liqProbState[field] = from[field];
      if (
        positionForm.elements[field] &&
        document.activeElement !== positionForm.elements[field]
      )
        positionForm.elements[field].value = from[field];
      if (
        probabilityForm.elements[field] &&
        document.activeElement !== probabilityForm.elements[field]
      )
        probabilityForm.elements[field].value = from[field];
    }
    persistPositionState();
    localStorage.setItem("btc_liq_probability", JSON.stringify(liqProbState));
    renderPosition();
    setDirty(true);
  };
  void syncRiskInputsBaseline;

  /* 接管渲染入口：所有旧调用点（决策层刷新、实时价更新）都走新的分组渲染。 */
  calcLiqProbability = renderLiqProbability;

  /* 中英文切换时同步操作条文案。 */
  const applyLanguageBeforeShortcuts = applyLanguage;
  applyLanguage = function () {
    applyLanguageBeforeShortcuts();
    relabelShortcuts();
  };

  /* 记录做多 / 做空持仓价：改开仓均价（失焦）或点确认持仓时更新。 */
  const positionForm = $("positionForm");
  if (positionForm) {
    positionForm.addEventListener("change", recordPositionEntry);
    /* 首次进入时若已有持仓价而记录为空，补一次种子值。 */
    const seeded = positionState.side === "short" ? "short" : "long",
      seededPrice = Number(positionState.entry);
    if (seededPrice > 0 && !entryBook[seeded]) {
      entryBook[seeded] = seededPrice;
      saveEntryBook();
    }
  }
  $("confirmPosition")?.addEventListener("click", recordPositionEntry);

  /* 顶部两张持仓卡一改动就刷新浮层与本地记录，菜单里不再出现旧值；
     同时重绘主图 —— 持仓价/开仓时间变了，买入/卖出气球与参考线要跟着走。 */
  window.addEventListener("btc:personal-entries-changed", () => {
    refreshEntryBookFromSlots();
    syncEntryMenu();
    try {
      renderChart();
    } catch {}
  });

  function boot() {
    if (installActions()) loadDailyHistory();
  }
  setTimeout(boot, 0);
  setTimeout(boot, 600);
})();

/* ===== v2.10.69：图表悬浮缩略图 + 一键返回顶部 =========================
   入口：图表工具栏「重置」旁的「缩略图」开关。
   行为：开启后当 .chart-box 滚出视口时，屏幕右上出现置顶悬浮缩略图
   （主图 + RSI 副图 canvas 实时快照，约 0.5s 刷新，标题栏带实时价格）；
   标题栏拖动位置、右下角手柄或 − /＋ 按钮缩放、点击缩略图本体放大/还原；
   图表滚回视野时自动隐藏避免遮挡；位置与尺寸记忆在本机。 */
(() => {
  const PREFS_KEY = "btc_chart_thumb_prefs_v1",
    MIN_W = 220,
    MIN_H = 150,
    MAX_W = 920,
    MAX_H = 640;

  /* ---------- 一键返回顶部 ---------- */
  const backToTop = document.createElement("button");
  backToTop.type = "button";
  backToTop.id = "backToTop";
  backToTop.title = tx("返回顶部", "Back to top");
  backToTop.setAttribute("aria-label", tx("返回顶部", "Back to top"));
  backToTop.textContent = "↑";
  backToTop.hidden = true;
  backToTop.addEventListener(
    "click",
    (event) => {
      event.stopPropagation();
      window.scrollTo({ top: 0, behavior: "smooth" });
    },
  );
  document.body.append(backToTop);
  const syncBackToTop = () => {
    backToTop.hidden = window.scrollY < Math.max(320, window.innerHeight * 0.5);
  };
  window.addEventListener("scroll", syncBackToTop, { passive: true });
  window.addEventListener("resize", syncBackToTop);
  syncBackToTop();

  /* ---------- 工具栏开关（从「重置」旁独立出来，单独一颗按钮） ---------- */
  const zoomTools = document.querySelector(".zoom-tools");
  if (!zoomTools) return;
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.id = "thumbToggle";
  toggle.title = tx(
    "图表悬浮缩略图：滚动离开图表后置顶显示",
    "Floating chart thumbnail: pins to the screen once the chart scrolls away",
  );
  toggle.textContent = tx("悬浮缩略图", "Floating thumbnail");
  const thumbTools = document.createElement("div");
  thumbTools.className = "thumb-tools";
  thumbTools.append(toggle);
  /* 插在缩放组之后（而不是塞进缩放组内部）：窄屏下位置与改造前一致，
     宽屏下由 CSS 的 order 把它排到最右，并与「重置」拉开一段小间距。 */
  zoomTools.after(thumbTools);

  /* ---------- 本机偏好 ---------- */
  let prefs = { on: false, x: null, y: null, w: 300, h: 210 };
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || "null");
    if (saved && typeof saved === "object") prefs = { ...prefs, ...saved };
  } catch {}
  const savePrefs = () => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {}
  };

  /* ---------- 悬浮缩略图骨架 ---------- */
  const widget = document.createElement("aside");
  widget.id = "chartThumb";
  widget.hidden = true;
  widget.innerHTML = `
    <div class="ct-head">
      <div class="ct-row">
        <span class="ct-title">${tx("实时缩略图", "Live thumbnail")}</span>
        <span class="ct-spacer"></span>
        <button type="button" class="ct-btn" data-ct="smaller" title="${tx("缩小", "Smaller")}">−</button>
        <button type="button" class="ct-btn" data-ct="bigger" title="${tx("放大", "Bigger")}">＋</button>
        <button type="button" class="ct-btn" data-ct="close" title="${tx("关闭缩略图", "Close thumbnail")}">×</button>
      </div>
      <div class="ct-row">
        <span class="ct-price-lab">${tx(coinPair() + " 最新价", coinPair() + " last price")}</span>
        <span class="ct-price" id="chartThumbPrice">--</span>
      </div>
    </div>
    <div class="ct-body">
      <canvas id="chartThumbCanvas"></canvas>
      <span class="ct-rz" title="${tx("拖拽调整大小", "Drag to resize")}"></span>
    </div>`;
  document.body.append(widget);

  const head = widget.querySelector(".ct-head"),
    bodyEl = widget.querySelector(".ct-body"),
    canvas = widget.querySelector("#chartThumbCanvas"),
    priceEl = widget.querySelector("#chartThumbPrice"),
    rzHandle = widget.querySelector(".ct-rz"),
    chartBox = document.querySelector(".chart-box");

  let restoreW = Math.max(MIN_W, prefs.w),
    restoreH = Math.max(MIN_H, prefs.h),
    isExpanded = false,
    chartVisible = true,
    paintTimer = null,
    priceTimer = null,
    prevPriceText = null,
    prevPriceNum = null;

  const clampW = (w) => Math.max(MIN_W, Math.min(MAX_W, Math.round(w)));
  const clampH = (h) => Math.max(MIN_H, Math.min(MAX_H, Math.round(h)));

  function clampPosition() {
    const maxX = Math.max(8, window.innerWidth - widget.offsetWidth - 8),
      maxY = Math.max(8, window.innerHeight - 64);
    prefs.x =
      prefs.x == null ? maxX : Math.max(8, Math.min(prefs.x, maxX));
    prefs.y = prefs.y == null ? 84 : Math.max(8, Math.min(prefs.y, maxY));
    widget.style.left = `${prefs.x}px`;
    widget.style.top = `${prefs.y}px`;
  }

  function applySize(w, h) {
    prefs.w = clampW(Math.min(w, window.innerWidth - 32));
    prefs.h = clampH(Math.min(h, window.innerHeight - 140));
    widget.style.width = `${prefs.w}px`;
    bodyEl.style.height = `${prefs.h}px`;
    widget.classList.toggle("is-expanded", isExpanded);
    clampPosition();
    paint();
  }

  /* ---------- 主图 + RSI 副图实时快照 ---------- */
  function paint() {
    if (widget.hidden) return;
    const src = document.getElementById("chart");
    if (!src) return;
    const sub = document.getElementById("chartRsi"),
      dpr = window.devicePixelRatio || 1,
      bw = Math.max(1, bodyEl.clientWidth),
      bh = Math.max(1, bodyEl.clientHeight),
      bwPx = Math.round(bw * dpr),
      bhPx = Math.round(bh * dpr);
    if (canvas.width !== bwPx || canvas.height !== bhPx) {
      canvas.width = bwPx;
      canvas.height = bhPx;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const baseBg = getComputedStyle(document.body)
      .getPropertyValue("--bg-base")
      .trim();
    ctx.fillStyle = baseBg || "#0d1117";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const gap = Math.round(3 * dpr),
      mainH = sub ? Math.round((canvas.height - gap) * 0.76) : canvas.height;
    if (sub && canvas.height - mainH - gap > 4)
      ctx.drawImage(
        sub,
        0,
        mainH + gap,
        canvas.width,
        canvas.height - mainH - gap,
      );
    ctx.drawImage(src, 0, 0, canvas.width, mainH);
    syncPrice();
  }

  /* ---------- 标题栏实时价格：逐位跳动 ---------- */
  /* 只取 #price 的首个价格 token：该元素与涨跌幅等是同级节点，直接读父节点
     会把整行富文本一起读进来。跳动语义与顶部 hero 大价格同款 ——
     方向取自「本次价 vs 上次价」，涨=绿(#00d4aa) / 跌=红(#ff4d6a)，
     复用同一套 .price-digit / .changed-up / .changed-down 样式；
     区别是大价格从「首个变化位」一路跳到末尾，这里严格只跳真正变化的那几位
     （按右对齐逐位比对，价格位数变化时多出的高位同样算变化）。 */
  function syncPrice() {
    if (widget.hidden) return;
    const value =
      (document.getElementById("price")?.textContent ?? "")
        .trim()
        .split(/\s+/)[0] || "";
    if (!value || value === prevPriceText) return;
    const num = Number(value.replace(/[^0-9.]/g, "")),
      prev = prevPriceText,
      shift = prev === null ? 0 : value.length - prev.length,
      dir =
        prev === null || !Number.isFinite(num) || !Number.isFinite(prevPriceNum)
          ? ""
          : num > prevPriceNum
            ? "up"
            : num < prevPriceNum
              ? "down"
              : "";
    priceEl.innerHTML = [...value]
      .map((ch, i) => {
        const digit = /[0-9]/.test(ch);
        /* 右对齐取上一串的同一位；逗号、小数点与货币符号自身不跳动。 */
        const at = i - shift,
          tick = digit && dir !== "" && (at < 0 || prev[at] !== ch);
        return `<span class="${digit ? "price-digit" : ""}${
          tick ? ` changed-${dir}` : ""
        }">${ch}</span>`;
      })
      .join("");
    prevPriceText = value;
    prevPriceNum = Number.isFinite(num) ? num : prevPriceNum;
  }

  function startLoop() {
    if (paintTimer == null) paintTimer = setInterval(paint, 500);
    if (priceTimer == null) priceTimer = setInterval(syncPrice, 250);
    paint();
  }
  function stopLoop() {
    if (paintTimer != null) {
      clearInterval(paintTimer);
      paintTimer = null;
    }
    if (priceTimer != null) {
      clearInterval(priceTimer);
      priceTimer = null;
    }
    prevPriceText = null; // 重新出现时不要补做一次陈旧的跳动
    prevPriceNum = null;
  }

  /* ---------- 显示 / 隐藏（图表在视野内时自动让位） ---------- */
  function syncVisibility() {
    const show = prefs.on && !chartVisible;
    toggle.classList.toggle("is-active", prefs.on);
    if (show) {
      widget.hidden = false;
      clampPosition();
      applySize(prefs.w, prefs.h);
      startLoop();
    } else {
      widget.hidden = true;
      stopLoop();
    }
  }
  if (chartBox)
    new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          chartVisible = entry.intersectionRatio >= 0.2;
        syncVisibility();
      },
      { threshold: [0, 0.2, 0.5] },
    ).observe(chartBox);
  else chartVisible = false;

  /* ---------- 工具栏开关 ---------- */
  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    prefs.on = !prefs.on;
    savePrefs();
    syncVisibility();
  });

  /* ---------- 标题栏：拖动 + 尺寸按钮 + 关闭 ---------- */
  head.addEventListener("click", (event) => {
    const op = event.target.closest("button")?.dataset.ct;
    if (!op) return;
    event.stopPropagation();
    if (op === "close") {
      prefs.on = false;
      savePrefs();
      syncVisibility();
      return;
    }
    if (op === "smaller" || op === "bigger") {
      isExpanded = false;
      const step = op === "bigger" ? 90 : -90;
      restoreW = clampW(prefs.w + step);
      restoreH = clampH(prefs.h + Math.round(step * 0.7));
      applySize(restoreW, restoreH);
      savePrefs();
    }
  });
  head.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button")) return;
    event.stopPropagation();
    const startX = event.clientX,
      startY = event.clientY,
      baseX = prefs.x,
      baseY = prefs.y;
    const onMove = (ev) => {
      prefs.x = baseX + (ev.clientX - startX);
      prefs.y = baseY + (ev.clientY - startY);
      clampPosition();
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      savePrefs();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    event.preventDefault();
  });

  /* ---------- 点击缩略图本体：放大 / 还原 ---------- */
  bodyEl.addEventListener("click", (event) => {
    if (event.target.closest(".ct-rz")) return;
    event.stopPropagation();
    if (isExpanded) {
      isExpanded = false;
      applySize(restoreW, restoreH);
    } else {
      restoreW = prefs.w;
      restoreH = prefs.h;
      isExpanded = true;
      applySize(
        Math.min(760, Math.round(window.innerWidth * 0.62)),
        Math.min(520, Math.round(window.innerHeight * 0.6)),
      );
    }
    savePrefs();
  });

  /* ---------- 右下角手柄：自由缩放 ---------- */
  rzHandle.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    event.preventDefault();
    const startX = event.clientX,
      startY = event.clientY,
      baseW = prefs.w,
      baseH = prefs.h;
    const onMove = (ev) => {
      isExpanded = false;
      restoreW = clampW(baseW + (ev.clientX - startX));
      restoreH = clampH(baseH + (ev.clientY - startY));
      applySize(restoreW, restoreH);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      savePrefs();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  });

  /* ---------- 视口变化时回收位置与尺寸 ---------- */
  window.addEventListener("resize", () => {
    if (widget.hidden) return;
    applySize(prefs.w, prefs.h);
  });

  syncVisibility();
})();

/* ===== v2.11.0 补充：语言切换时整卡重渲宏观两张卡 =====================
   「宏观事件中枢」与「宏观环境与跨市场联动」都按当前语言整卡渲染
   （数据刷新时重建，不随 applyLanguage 逐节点替换）。语言切换那一刻
   若只等下次数据刷新，标题 / 范围按钮 / 副标题会停留在上一语言。 */
(() => {
  const applyLanguageBeforeMacroMerger = applyLanguage;
  applyLanguage = function () {
    applyLanguageBeforeMacroMerger();
    try {
      if ($("investmentCalendarCard") && investmentCalendarData) {
        renderInvestmentCalendar(investmentCalendarData);
      }
      // 预警条与顶部关注卡都是整块渲染，语言切换要就地重渲（否则标题停在上一种语言）。
      renderMacroTicker();
      if ($("fearGreedGauge")) renderFearGreedGauge();
      if ($("fedMonitorCard") && macroCalendarData) {
        renderFedMonitor(macroCalendarData);
        paintCorrelationPanel();
      }
    } catch {
      /* 语言切换不应因宏观卡重渲失败而中断。 */
    }
  };
})();

/* ===== v2.11.9：语言切换时整卡重渲研究区卡片 =====================
   「BTC 多因子研究预测」按当前语言整卡渲染
   （数据刷新时重建，不随 applyLanguage 逐节点替换）。在此之前，语言
   切换那一刻若只等下一次数据刷新，标题、副标题与按钮文案
   会停留在上一语言（最长约 15 分钟）。这里用缓存的数据就地重渲；
   数据尚未到达时跳过，交给正常的首次渲染。 */
(() => {
  const applyLanguageBeforeResearchLang = applyLanguage;
  applyLanguage = function () {
    applyLanguageBeforeResearchLang();
    try {
      rerenderResearchOutlook();
    } catch {
      /* 语言切换不应因研究区重渲失败而中断。 */
    }
  };
})();

/* ===== v2.11.10 / v2.11.13：智能顶部栏 ==============================
   目标：让顶栏别长期占着首屏空间 —— 不管是滚动还是静置，都会自己让位。
   做法：栏体改为 fixed 定位（首屏由 .header-slot 撑住原始高度，布局
   零位移），收起时整条上滑出视口并放弃点击；唤回通道有四条：
   ① 向下滚动到阈值后收起；② 向上滚动到阈值后唤回；③ 鼠标进入视口
   顶部热区；④ 键盘焦点进入栏内。
   静置收起有两档：离开顶部时唤回后静置 4s 收起；**停在首页顶部时
   无任何交互（含鼠标不动）静置 5s 也收起**，并把占位块一起收掉、
   让内容整体上提；鼠标再回到顶部热区即唤回。
   鼠标停在栏上、焦点在栏内、栏内浮层打开、栏内刚点过时不收起。

   Smart top bar: stows on scroll-down, on idle at the top of the page,
   and shortly after being recalled; it returns on scroll-up, the top
   hover zone, or keyboard focus. While stowed at the very top the
   placeholder collapses too, so the content really moves up. */
(() => {
  const header = document.querySelector("main > header"),
    main = document.querySelector("main");
  if (!header || !main || header.classList.contains("is-smart-bar")) return;

  const STOW_AFTER_MS = 4000, // 离开顶部时：唤回后静置多久再次收起
    TOP_STOW_AFTER_MS = 5000, // 停在页面顶部时：无任何交互静置多久收起
    DOWN_STEP = 56, // 向下滚动累计多少像素后收起
    UP_STEP = 24, // 向上滚动累计多少像素后唤回
    TOP_ZONE = 36, // 鼠标进入视口顶部多少像素内即唤回
    POPUP_RETRY_MS = 2500, // 被浮层拦住时的重试间隔
    TOP_RESET = 24; // 进入这个区间算「在页面顶部」

  // 栏体离流后，原本由它的 margin-bottom 提供的间距要由占位块补齐。
  // 实测值会被后续样式块覆盖（当前是 18px，而不是基础块里的 12px），
  // 所以这里实测一次而不是写死，避免首屏多出或少掉一段间距。
  let gapPx = parseFloat(getComputedStyle(header).marginBottom) || 0;

  // 占位块：栏体 fixed 后由它保留首屏空间，高度跟随栏体自适应。
  const slot = document.createElement("div");
  slot.className = "header-slot";
  slot.setAttribute("aria-hidden", "true");
  header.after(slot);
  header.classList.add("is-smart-bar");

  let slotFull = 0, // 占位块的完整高度（栏高 + 间距）
    topCollapsed = false, // 当前是否「在顶部把占位收掉」的状态
    lastY = window.scrollY,
    acc = 0,
    hovered = false,
    graceUntil = 0,
    idleTimer = 0,
    lastBump = 0,
    frame = 0;

  // 栏内控件弹出的浮层一旦打开，收起会把它一起带走 —— 此时不收起。
  const popupOpen = () =>
    !!document.querySelector(
      '#versionChangelog:not([hidden]),#apiCenterModal:not([hidden]),#accountServiceCard:not([hidden]),#localAlertModal:not([hidden]),#pushSettingsModal:not([hidden]),#voiceSettingsModal:not([hidden]),#notificationCenterModal:not([hidden]),.connectivity-toggle[aria-expanded="true"],.csw-coin-menu:not([hidden]),#macroLiveSettings:not([hidden])',
    );

  const canStow = () =>
    !hovered &&
    !popupOpen() &&
    !header.contains(document.activeElement) &&
    Date.now() > graceUntil;

  // 栏体固定后不再由 main 的盒模型定位：宽度与左边距实时跟随内容区。
  const syncLayout = () => {
    const style = getComputedStyle(main),
      rect = main.getBoundingClientRect(),
      padLeft = parseFloat(style.paddingLeft) || 0,
      padRight = parseFloat(style.paddingRight) || 0;
    document.documentElement.style.setProperty(
      "--smart-bar-top",
      style.paddingTop || "20px",
    );
    header.style.left = `${Math.round(rect.left + padLeft)}px`;
    header.style.width = `${Math.max(
      0,
      Math.round(main.clientWidth - padLeft - padRight),
    )}px`;
    slotFull = header.offsetHeight + gapPx;
    applySlotHeight();
  };

  // 占位块高度：只有在「页面顶部 + 已收起」时才收成 0，让内容整体上提；
  // 一旦离开顶部就补回原高（配套滚动补偿，见 onScroll），
  // 这样下滑途中唤回栏体不会把下面的内容再顶一次。
  const applySlotHeight = () => {
    const collapse =
      header.classList.contains("is-stowed") && window.scrollY <= TOP_RESET;
    topCollapsed = collapse;
    slot.style.height = `${collapse ? 0 : slotFull}px`;
  };

  // 媒体查询会改栏体的 margin-bottom，窗口尺寸变化后重新实测一次。
  // 整个实测在同一帧内完成，不会产生可见跳动。
  const refreshGap = () => {
    const left = header.style.left,
      width = header.style.width;
    header.classList.remove("is-smart-bar");
    gapPx = parseFloat(getComputedStyle(header).marginBottom) || 0;
    header.classList.add("is-smart-bar");
    header.style.left = left;
    header.style.width = width;
  };

  const stow = () => {
    clearTimeout(idleTimer);
    idleTimer = 0;
    header.classList.add("is-stowed");
    applySlotHeight();
  };

  // 停在页面顶部时用更长的静置时长（用户明确要 5s），
  // 离开顶部后沿用唤回续命的 4s。
  const stowDelay = () =>
    window.scrollY <= TOP_RESET ? TOP_STOW_AFTER_MS : STOW_AFTER_MS;

  const scheduleStow = () => {
    clearTimeout(idleTimer);
    const tick = () => {
      if (canStow()) {
        idleTimer = 0;
        stow();
        return;
      }
      // 只有「浮层开着」这一种拦阻会自己消失且不产生任何事件
      // （例如面板被脚本收起），所以这种情况下隔一会重试；
      // 鼠标悬停 / 焦点在栏内都会由对应事件重新计时，不在这里轮询。
      if (popupOpen()) idleTimer = setTimeout(tick, POPUP_RETRY_MS);
      else idleTimer = 0;
    };
    idleTimer = setTimeout(tick, stowDelay());
  };

  // 任何「人还在动」的信号都重新计时：鼠标移动、滚轮、按键、点击、触摸。
  // 已收起时不必计时（收起态没有待办），等唤回时再从头开始。
  const bumpIdle = () => {
    if (header.classList.contains("is-stowed")) return;
    const now = Date.now();
    if (now - lastBump < 250) return; // mousemove 很密，节流一下
    lastBump = now;
    scheduleStow();
  };

  const reveal = () => {
    acc = 0;
    if (header.classList.contains("is-stowed"))
      header.classList.remove("is-stowed");
    applySlotHeight();
    scheduleStow();
  };

  const onScroll = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const y = window.scrollY,
        dy = y - lastY;

      // 顶部收起态下开始下滑：先把占位块补回原高，再等量补偿滚动位置。
      // 两步相抵后画面完全不动，只是把文档高度还原成常规状态，
      // 避免「下滑途中唤回栏体」时把下面的内容再顶一次。
      if (topCollapsed && y > TOP_RESET) {
        expandSlot();
        lastY = window.scrollY;
        acc = 0;
        header.classList.toggle("is-detached", true);
        return;
      }

      lastY = y;
      header.classList.toggle("is-detached", y > TOP_RESET);
      if (y <= TOP_RESET) {
        acc = 0;
        reveal();
        return;
      }
      // 只累加同一方向的距离：来回小幅抖动不会误触发。
      acc = dy > 0 ? Math.max(0, acc + dy) : Math.min(0, acc + dy);
      if (acc >= DOWN_STEP) {
        acc = 0;
        if (canStow()) stow();
      } else if (acc <= -UP_STEP) {
        acc = 0;
        reveal();
      }
    });
  };

  // 把顶部收掉的占位补回，并同步补偿滚动位置（视觉零跳动）。
  // 两个坑：
  // ① 浏览器自己也有一套「滚动锚定」（content 上方尺寸变化时自动调
  //    scrollTop 保持画面稳定），会和这里的补偿叠加成跳两次 —— 所以
  //    改动期间显式关掉，下一帧恢复。
  // ② 这一步必须瞬时生效，不能走 .header-slot 的高度过渡：过渡会让
  //    占位在后面几帧里慢慢长高，而我们一次就把 scrollTop 补到位，
  //    两者错位会看到内容先上一截再慢慢退回来。
  const expandSlot = () => {
    if (!topCollapsed) return;
    topCollapsed = false;
    const root = document.documentElement,
      wasAnimated = slot.classList.contains("is-animated"),
      prevAnchor = root.style.overflowAnchor;
    root.style.overflowAnchor = "none";
    slot.classList.remove("is-animated");
    slot.style.height = `${slotFull}px`;
    if (slotFull > 0) window.scrollTo(0, window.scrollY + slotFull);
    requestAnimationFrame(() => {
      root.style.overflowAnchor = prevAnchor;
      if (wasAnimated) slot.classList.add("is-animated");
    });
  };

  // 停在顶部边缘不再往复触发：只在已收起时才唤回。
  // 顶部同样生效 —— 首页静置收起后，鼠标回到顶部热区即唤回。
  const reviveAtTop = (event) => {
    if (!header.classList.contains("is-stowed")) return;
    if (event.clientY > TOP_ZONE) return;
    reveal();
  };

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener(
    "resize",
    () => {
      refreshGap();
      syncLayout();
    },
    { passive: true },
  );
  document.addEventListener("mousemove", reviveAtTop, { passive: true });
  document.addEventListener("pointerdown", reviveAtTop, { passive: true });
  for (const type of ["mousemove", "wheel", "pointerdown", "keydown", "touchstart"])
    document.addEventListener(type, bumpIdle, { passive: true });
  header.addEventListener("pointerenter", () => {
    hovered = true;
    reveal();
  });
  header.addEventListener("pointerleave", () => {
    hovered = false;
    scheduleStow();
  });
  // 栏内任意一点击都可能弹出浮层，给一段免打扰窗口再考虑收起。
  header.addEventListener("pointerdown", () => {
    graceUntil = Date.now() + 2500;
    reveal();
  });
  document.addEventListener("focusin", (event) => {
    if (!header.contains(event.target)) return;
    graceUntil = Date.now() + 4000;
    reveal();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) onScroll();
  });

  // 字体加载完成、窗口缩放、栏内文字换行都会改变栏高，需重新对位。
  if (window.ResizeObserver) new ResizeObserver(syncLayout).observe(header);
  window.addEventListener("load", syncLayout, { once: true });
  if (document.fonts && document.fonts.ready)
    document.fonts.ready.then(syncLayout).catch(() => {});

  syncLayout();
  header.classList.toggle("is-detached", window.scrollY > TOP_RESET);
  // 占位块的高度过渡只在首帧之后启用，否则首次 syncLayout 会把
  // 0 → 栏高 的赋值当成动画，开屏就看见内容跳一下。
  requestAnimationFrame(() => slot.classList.add("is-animated"));
  scheduleStow(); // 开屏即计时：停在首页不动 → 5s 后自动让位
})();

/* 多币种模块已从 app.js 抽离到 src/modules/multi-coin.js（ESM）。
 * 切换币种后需重拉的面板函数通过 registry.loaders 注入，避免模块反向依赖 app.js 造成循环引用。
 * 这里在所有面板函数已定义之后、原多币种 IIFE 应执行的时机（文件末尾）调用 initMultiCoin()。 */
registry.loaders = {
  loadCurrent, loadQuote, loadDerivativeMarketContext, loadHorizonForecasts,
  loadResearchOutlook, refreshResonance, loadFedMonitor, loadInvestmentCalendar,
  loadFixedRuleSignal, renderPosition,
};
initMultiCoin();

initVoiceEngine();