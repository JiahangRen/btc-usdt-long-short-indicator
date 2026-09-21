import { emaSeriesPadded as ema, rsiSeriesPadded as rsi, atrSeriesPadded as atr } from '/shared/indicators.mjs';
import { COIN_KEYS, COINS, BASE_COIN, normalizeCoin } from '/shared/coins.mjs';
const $ = (id) => document.getElementById(id);

/* ══ 币种上下文 / Coin context ═══════════════════════════════════════════════
 * 两种模式：
 *   bitcoin —— 比特币模式。页面与多币种改造之前**完全一致**，币种恒为 BTC。
 *   multi   —— 多币种模式。可在 BTC / ETH / ZEC / BNB 之间切换，
 *              切换后整页（行情、图表、信号、微观结构、研究预测、宏观）都基于该币种。
 * 模式与币种都记在本机 localStorage，刷新后保持。
 *
 * Two modes: `bitcoin` (identical to the pre-multi-coin page, coin pinned to BTC)
 * and `multi` (switch between BTC/ETH/ZEC/BNB; the whole page follows the choice).
 * Both the mode and the selected coin persist in localStorage.
 */
const COIN_MODE_KEY = 'btc_coin_mode_v1';
const COIN_SYMBOL_KEY = 'btc_coin_symbol_v1';
let coinMode = localStorage.getItem(COIN_MODE_KEY) === 'multi' ? 'multi' : 'bitcoin';
let selectedCoin = normalizeCoin(localStorage.getItem(COIN_SYMBOL_KEY));
const isMultiCoinMode = () => coinMode === 'multi';
/** 当前真正生效的币种：比特币模式下恒为 BTC。所有接口请求都用它。 */
const activeCoin = () => (isMultiCoinMode() ? selectedCoin : BASE_COIN);
const coinMetaOf = (coin = activeCoin()) => COINS[normalizeCoin(coin)] || COINS[BASE_COIN];
/** 「BTC / USDT」这类展示用交易对。 */
const coinPair = (coin = activeCoin()) => `${normalizeCoin(coin)} / USDT`;
/** 当前币种的中/英文全名（以太坊 / Ethereum）。 */
// 这里直接读 localStorage 而不复用 uiLang：uiLang 在本文件中声明得更靠后，
// 模块初始化早期若走到这里会撞上暂时性死区（TDZ），整页板块会消失。
const coinNameOf = (coin = activeCoin()) => {
  const name = coinMetaOf(coin).name;
  return (localStorage.getItem('btc_lang') || 'zh') === 'en' ? name.en : name.zh;
};
const coinLabel = (coin = activeCoin()) => normalizeCoin(coin);
/** 多币种本地存储键的币种后缀：BTC 用旧键（无后缀），其余币种 "_<COIN>"。
 *  放在文件最前，任何按币种隔离的 localStorage 键都复用它（避免 TDZ）。 */
const coinStorageSuffix = () => {
  const coin = activeCoin();
  return coin === BASE_COIN ? "" : "_" + coin;
};
// 与币种强相关的接口：请求时自动带上 symbol，服务端据此切换缓存 / SQLite / 合约。
// 账户、登录、语音、AI 配置等不属于行情，不带。
const COIN_SCOPED_API = ['/api/market', '/api/quote', '/api/status', '/api/forecast-history',
  '/api/research-outlook', '/api/research-backfill', '/api/research-ablation',
  '/api/research-candidates', '/api/funding-rates', '/api/macro-outcomes',
  '/api/correlation-history', '/api/news', '/api/ai/'];
function withCoin(url) {
  if (typeof url !== 'string' || url.indexOf('/api/') < 0) return url;
  const path = url.split('?')[0].split('#')[0];
  if (!COIN_SCOPED_API.some((prefix) => path === prefix || path.startsWith(prefix + '/'))) return url;
  if (/[?&]symbol=/.test(url)) return url;
  return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'symbol=' + activeCoin();
}
/* v2.11.80：前端请求调度器。同域仅 6 条 HTTP 连接，首屏曾并发 ~73 个 /api/ 请求，
   把连接打满、实时价 quote 排队 20+ 秒。这里在 fetch 层（模块内 fetch 标识符 + window.fetch）
   统一加并发限制（6）+ 优先级队列：实时价 quote 最高优先插队，语音/AI 外部依赖最低优先，
   其余默认。非 /api/ 请求（静态资源、外部 API）原样放行。 */
const _origFetch = window.fetch.bind(window);
const _apiQueue = (() => {
  const MAX = 6, queue = [];
  let running = 0;
  function pump() {
    if (running >= MAX) return;
    let bi = -1;
    for (let i = 0; i < queue.length; i++) if (bi < 0 || queue[i].p > queue[bi].p) bi = i;
    if (bi < 0) return;
    const job = queue.splice(bi, 1)[0];
    running++;
    Promise.resolve().then(() =>
      job.fn().then(job.res, job.rej).finally(() => { running--; pump(); })
    );
  }
  return { add(fn, p) { return new Promise((res, rej) => { queue.push({ fn, p, res, rej }); pump(); }); } };
})();
function _apiPriority(u) {
  if (u.indexOf('/api/quote') >= 0) return 3;
  if (u.indexOf('/api/voice') >= 0 || u.indexOf('/api/ai/') >= 0) return 0;
  return 1;
}
function _wrappedFetch(url, opts) {
  const target = withCoin(url);
  const u = typeof target === 'string' ? target : (target && target.url) || '';
  if (u.indexOf('/api/') >= 0) return _apiQueue.add(() => _origFetch(target, opts), _apiPriority(u));
  return _origFetch(target, opts);
}
const fetch = _wrappedFetch;
window.fetch = _wrappedFetch;
/* v2.11.83：脚本按需/空闲加载器 + 空闲调度。
   ai-chat.js(144KB) 与 html2canvas.min.js(196KB) 与首屏无关，但此前作为 defer 脚本
   仍会在 DCL 前下载并解析执行，占着主线程。这里把它们移出首屏关键路径：
   先排队 html2canvas（AI 长截图依赖它），随后加载 ai-chat —— 后者是自启动 IIFE，
   尾部 `readyState === "loading" ? DOMContentLoaded : boot()`，
   所以即使延迟插入到已就绪的 DOM，它也会走 else 分支正常启动。 */
const __loadedScripts = new Set();
function loadScriptOnce(src) {
  if (__loadedScripts.has(src)) return Promise.resolve(true);
  __loadedScripts.add(src);
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.onload = () => resolve(true);
    el.onerror = () => { __loadedScripts.delete(src); reject(new Error('script load failed: ' + src)); };
    document.head.appendChild(el);
  });
}
window.loadJsOnce = loadScriptOnce;
const whenIdle = (fn) => (window.requestIdleCallback ? window.requestIdleCallback(fn, { timeout: 3000 }) : window.setTimeout(fn, 1));
whenIdle(() => {
  loadScriptOnce('/html2canvas.min.js?v=1').catch(() => {});
  loadScriptOnce('/ai-chat.js?v=2.12.1').catch(() => {});
});
/* 极值辅助：用循环代替 Math.max(...arr) / Math.min(...arr) 的展开写法。
   当 arr 很大时，spread 会把每个元素当作函数实参展开，可能触发调用栈溢出
   （RangeError: maximum call stack size exceeded）。空数组行为与 Math 一致：
   maxOf([]) === -Infinity，minOf([]) === Infinity，因此可直接替换、语义不变。 */
function maxOf(arr) {
  let m = -Infinity;
  for (let i = 0; i < arr.length; i++) if (arr[i] > m) m = arr[i];
  return m;
}
function minOf(arr) {
  let m = Infinity;
  for (let i = 0; i < arr.length; i++) if (arr[i] < m) m = arr[i];
  return m;
}
/* 前端常量：从散落魔法数字集中提取，便于审阅与统一调整（F4）。
   只收录语义清晰、用途单一的散落数字；坐标等绘图常量保持就近声明。 */
const VOICE_LIST_POPULATE_DELAY_MS = 350;        // 启动后延迟拉取语音列表，避开初始化竞争
const LONG_TERM_INTERVAL_MIN = 240;              // “长周期”阈值：>= 4h（240 分钟）
const DAILY_HISTORY_MAX_RETRIES = 3;             // 日线历史拉取失败后的最大重试次数
const DAILY_HISTORY_RETRY_DELAY_MS = 4_000;      // 日线历史重试间隔（4s，避开上游限频）
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
// 首屏采用 1 分钟 K 线与 6 小时可见范围，便于直接观察短线结构。
// The first view uses one-minute candles across six hours for immediate short-horizon context.
const state = {
  interval: "1m",
  limit: 360,
  range: "6时",
  viewPoints: 361,
  source: "okx",
  candles: [],
  marketMeta: null,
  ticker: null,
  lastGood: null,
  loading: false,
  reloadQueued: false,
  zoom: 1,
};
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
const money = (n) =>
  Number.isFinite(n)
    ? "$" +
      n.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    : "--";
const pct = (n) =>
  Number.isFinite(n) ? `${n >= 0 ? "+" : ""}${n.toFixed(2)}%` : "--";
const time = (ms) =>
  new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(ms);
/* 主图 X 轴时间标签格式化；短周期显示 HH:mm，跨天或长周期追加 MM-DD，
   跨度跨年时再追加年份（1Y 这类范围内 MM-DD 会指代不明）。 */
function formatTimeAxisLabel(ms, showDate, showYear) {
  const d = new Date(ms);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (!showDate) return hm;
  const md = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return showYear ? `${d.getFullYear()}-${md} ${hm}` : `${md} ${hm}`;
}
/* 覆盖信息里的完整时间（含年份），用于跨度跨年的范围。 */
const timeFull = (ms) =>
  new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(ms);
async function apiFetch(url, timeout = 8_000) {
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { cache: "no-store", signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
function sma(values, p) {
  return values.map((_, i) =>
    i < p - 1
      ? NaN
      : values.slice(i - p + 1, i + 1).reduce((a, b) => a + b, 0) / p,
  );
}
/* livePrice is optional: when given, the panel stops lagging one full candle.
   Pass the live quote only for the headline signal, not for confirmation
   intervals, so cross-interval checks stay on a consistent closed-candle basis. */
function metrics(data, livePrice) {
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
function classification(score) {
  return score >= 45
    ? ["偏多", "bull"]
    : score <= -45
      ? ["偏空", "bear"]
      : ["观望", "flat"];
}
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
    state.ticker = data.ticker;
    state.lastGood = data;
    $("chartError").hidden = true;
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
    $("freshness").textContent = pointTime(data.fetchedAt);
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
$("source").onchange = (e) => {
  state.source = e.target.value;
  loadCurrent();
};
buttons();
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
  const dirLabel = { bull: tx("看多", "Bullish"), bear: tx("看空", "Bearish"), flat: tx("中性", "Neutral") };
  $("indicators").innerHTML = rows
    .map(
      ([k, v, key]) =>
        `<div class="metric"><span>${k}</span><b>${v}</b><i class="badge ${key}">${dirLabel[key]}</i></div>`,
    )
    .join("");
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
  const n = Math.max(30, Math.ceil(state.candles.length / state.zoom));
  return state.candles.slice(-n);
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
      const data = frozenCandles || state.candles,
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
  const title = main.querySelector("header h1"),
    sub = main.querySelector("header p");
  title.textContent = "₿ BTC/USDT 多空指标";
  sub.innerHTML = '<span class="live-pulse"></span>实时连接 · REST 轮询';
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
      layout.replaceChildren(signal, chart, changes, side);
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
      column.replaceChildren(chart, ...(okx ? [okx] : []), changes);
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
const I18N = {
  zh: {
    title: "BTC/USDT 多空指标指示器",
    source: "数据源",
    refresh: "刷新",
    kline: "K 线周期",
    range: "查看范围",
    forecast: "多周期概率预测",
    correlation: "BTC × 美股联动",
    theme: ["自动", "浅色", "深色"],
    fullscreen: "全屏",
    exitFullscreen: "退出全屏",
  },
  en: {
    title: "BTC/USDT Long–Short Indicator",
    source: "Source",
    refresh: "Refresh",
    kline: "Candle interval",
    range: "Visible range",
    forecast: "Multi-horizon probability",
    correlation: "BTC × US equities linkage",
    backtest: "Research backtest (expand)",
    theme: ["Auto", "Light", "Dark"],
    fullscreen: "Fullscreen",
    exitFullscreen: "Exit fullscreen",
  },
};
let uiLang = localStorage.getItem("btc_lang") || "zh",
  themeMode = localStorage.getItem("btc_theme") || "auto";
function locale() {
  return I18N[uiLang];
}
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
// tx 必须在此处（首个 IIFE 之前）就绪：applyLanguage() 在 IIFE 加载期被调用且内部用到 tx，
// 若按旧位置定义在 IIFE 之后，加载期触发 TDZ（Cannot access 'tx' before initialization），
// 整个模块求值中断，后续顶层绑定（calendarEscape 等）全部处于未初始化状态。
const tx = (zh, en) => (uiLang === "zh" ? zh : en);
/* 多周期共振卡片「!」里的说明文案。放在这里（而不是就地写在安装函数里），
   是因为同一个 help-dot 还挂着「数据源与更新频率」的追加写入，两边要共用一个真源。 */
const RESONANCE_HELP = {
  zh:
    "<b>多周期共振 · 使用说明</b><br><br>" +
    "自动聚合 15m / 1h / 4h / 1d / 1w 五个周期的方向一致性：把五个周期的规则信号方向放在一起比对，权重依次为 0.05 / 0.1 / 0.2 / 0.3 / 0.35 —— 周期越大，分量越重。<br><br>" +
    "<b>怎么读</b><br>" +
    "· 标题旁那句几个字的短语 = 一句话结论（全线偏多 / 多头占优 / 多空分歧 …）。<br>" +
    "· 短语左边的徽标 = 更细的结论：强共振（5/5 同向）＞多数（4/5）＞单边待确认（只有一侧有方向、还没共振）＞多空分歧（两边都有人），括号里是同向的周期数。<br>" +
    "· 徽标里的「强度 0–100」= 加权后的方向力度，越高越「一边倒」。<br>" +
    "· 每个周期一个标签（按周期从小到大排）：周期 → 方向与评分（±100）；与主流方向相反的会加红色虚线框，标成冲突周期。<br><br>" +
    "<b>怎么用</b><br>" +
    "· 强共振且强度高：顺大势交易，规则信号的背景更可靠，但入场点与止损仍要单独判断。<br>" +
    "· 出现分歧或冲突周期：大小周期打架，多为回调或震荡，宜减仓或等它重新同向。<br>" +
    "· 优先做与日线、周线同向的交易；这两个大周期与你的方向相反时，短线胜率通常更差。<br><br>" +
    "<b>自动计算</b>：打开页面自动算一次，之后按周期自动刷新 —— 15m 约每分钟、1h 约 5 分钟、4h 约 15 分钟、1d 约 1 小时、1w 约 6 小时各重算一次；点「计算共振」可立即强制全部重算。<br><br>" +
    "<b>注意</b>：该结论只描述技术面是否同向，不含基本面与资金面，不构成投资建议。",
  en:
    "<b>Multi-timeframe resonance · how to use</b><br><br>" +
    "Auto-aggregates direction agreement across 15m / 1h / 4h / 1d / 1w: it compares the rule-signal direction on all five, weighted 0.05 / 0.1 / 0.2 / 0.3 / 0.35 — the higher the timeframe, the more it counts.<br><br>" +
    "<b>Reading it</b><br>" +
    "· The few-word phrase next to the title = the one-line verdict (All bullish / Bulls lead / Diverged …).<br>" +
    "· The badge left of it is the finer verdict: strong (5/5 agree) > majority (4/5) > one-sided but still pending > diverged (both sides present); the fraction is how many agree.<br>" +
    "· \"strength 0–100\" = weighted conviction; higher means more one-sided.<br>" +
    "· Each chip is one timeframe, ordered shortest → longest: interval → direction and score (±100); a red dashed box marks a timeframe fighting the dominant direction.<br><br>" +
    "<b>Using it</b><br>" +
    "· Strong resonance with high strength: trade with the dominant side — better context, but entry and stop still need their own check.<br>" +
    "· Diverged, or a conflicting chip: timeframes disagree, usually a pullback or a range — trim, or wait until they realign.<br>" +
    "· Prefer trades that agree with the daily and weekly timeframes; short-term win rate is usually worse against them.<br><br>" +
    "<b>Auto refresh</b>: computed once on page load, then refreshed per timeframe — roughly every minute (15m), 5 min (1h), 15 min (4h), 1 hour (1d) and 6 hours (1w). The button forces a full recalculation.<br><br>" +
    "<b>Note</b>: this only describes whether the technical picture agrees; no fundamentals or flows, and not investment advice.",
};
/* 「周期涨幅」的说明。原先它和共振共用同一段文字（两张卡共用一个 help 文案），拆开各写各的。 */
const PERIOD_RETURNS_HELP = {
  zh: "周期涨幅展示 15 分钟到 1 年共 9 个周期的涨跌幅，用来判断当前这一波在更长时间尺度上是延续还是背离。",
  en: "Period returns show the change over 9 horizons from 15m to 1y, so you can tell whether the current move continues or diverges on longer scales.",
};
/* 说明按钮有两个写入方：这里的卡片用法说明，和数据节奏安装器追加的「数据源与更新频率」。
   安装器可能先一步建好按钮（addHelp 遇到已存在的按钮会直接跳过），所以这里每次都强制归位 ——
   说明为正文，频率由安装器追加在其后（它读的基准就是 cadenceBaseTip）。 */
function setCardHelpTip(selector, zh, en) {
  document.querySelectorAll(selector).forEach((x) => {
    addHelp(x, zh, en);
    const dot = x.querySelector(".help-dot");
    if (!dot) return;
    dot.dataset.tip = uiLang === "zh" ? zh : en;
    dot.dataset.cadenceBaseTip = dot.dataset.tip;
  });
}
function syncCardHelpTips() {
  setCardHelpTip(".optional h2", RESONANCE_HELP.zh, RESONANCE_HELP.en);
  setCardHelpTip(".change-card h2", PERIOD_RETURNS_HELP.zh, PERIOD_RETURNS_HELP.en);
}
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
  const apiCenterModal=document.createElement("div");
  apiCenterModal.id="apiCenterModal";
  apiCenterModal.className="alert-composer api-center-modal";
  apiCenterModal.hidden=true;
  document.body.append(apiCenterModal);
  const apiCenterRequest=async(path, options={})=>{const response=await fetch(path,{...options,headers:{'content-type':'application/json',...(options.headers||{})}}),body=await response.json().catch(()=>({}));if(!response.ok)throw new Error(body.error||"请求失败");return body;};
  const apiCenterFree=()=>uiLang==='zh'?[['市场行情','OKX · Binance','无需填入'],['宏观日程','美联储 · BLS 日程 · 美国财政部 · EIA 发布时间 · CFTC','无需填入'],['加密与链上','mempool.space · Deribit 公共行情 · CoinLore · Alternative.me','无需填入'],['市场环境','Yahoo Finance（公开入口）','无需填入']]:[['Market quotes','OKX · Binance','No entry needed'],['Macro calendar','Federal Reserve · BLS schedule · US Treasury · EIA releases · CFTC','No entry needed'],['Crypto & on-chain','mempool.space · Deribit public quotes · CoinLore · Alternative.me','No entry needed'],['Market environment','Yahoo Finance (public)','No entry needed']];
  const apiCenterOptional=()=>uiLang==='zh'?[['coingecko','CoinGecko','加密市场总市值、BTC 占比','可以填入高级或升级版的 API key，如果不填，就默认使用已接入的免费版'],['eia','EIA','原油库存的完整实际值与历史数据','可填写免费 EIA API key；不填仍默认使用已接入的 EIA 发布时间日历'],['custom','自定义 HTTPS API','手动订阅的数据源地址与可选 API Key','仅接受 HTTPS 地址；地址和 Key 均以相同的服务端加密逻辑保存，不会回显']]:[['coingecko','CoinGecko','Crypto market cap, BTC dominance','You can enter a premium or higher-tier API key; if left blank, the free version already connected is used'],['eia','EIA','Complete actual & historical crude inventory','Enter a free EIA API key; if blank, the connected EIA release calendar is used'],['custom','Custom HTTPS API','Manually subscribed data source URL and optional API key','Only HTTPS URLs accepted; both URL and key are saved with the same server-side encryption and never echoed back']];
  // 千问 mini 额度卡的渲染：复用 /api/ai/quota，单函数一处渲染全部字段。
  // Qwen mini quota renderer: reuses /api/ai/quota, a single function covers all fields.
  const renderApiQwenQuota=async(card)=>{
    if(!card)return;
    const fill=card.querySelector('.api-qwen-quota-fill');
    const pct=card.querySelector('.api-qwen-quota-pct');
    const meta=card.querySelector('.api-qwen-quota-meta');
    let payload=null;
    try { const res=await fetch('/api/ai/quota'); if(res.ok)payload=await res.json(); } catch {}
    if(!payload||!payload.configured){ card.setAttribute('data-empty','true'); pct.textContent='—'; fill.style.width='0%'; meta.textContent=tx('保存 Key 后再提问一次即可显示额度','Ask once after saving the key to see quota'); return; }
    const remote=payload.remote,local=payload.local||{};
    // 千问 API 不返回实时额度响应头，本地按模型换算表估算 credits 消耗。
    // Qwen API does not surface live quota headers; we estimate from the model conversion table.
    const estimateLimit=2500; // Token Plan Lite 默认值（按截图用户用的是 Lite 套餐）
    const estCredits=Number(local.estimatedCredits||0);
    const estPctRemaining=estCredits>0?Math.max(0,Math.min(100,(1-estCredits/estimateLimit)*100)):null;
    if(remote&&remote.limit!=null&&remote.remaining!=null){
      const remainingPct=Math.max(0,Math.min(100,remote.percentRemaining));
      const usedPct=100-remainingPct;
      fill.style.width=remainingPct+'%';
      fill.setAttribute('data-level',remainingPct>50?'ok':remainingPct>20?'mid':'low');
      card.setAttribute('data-empty','false');
      pct.textContent=remainingPct.toFixed(1)+'%';
      const usedNum=Number.isFinite(remote.used)?remote.used.toLocaleString():'—';
      const limitNum=Number.isFinite(remote.limit)?remote.limit.toLocaleString():'—';
      const cd=local.countdownMs?(()=>{const ms=local.countdownMs,totalMin=Math.floor(ms/60000),d=Math.floor(totalMin/1440),h=Math.floor((totalMin%1440)/60);return d>0?d+'d '+h+'h':h>0?h+'h':Math.max(1,totalMin)+'m';})():null;
      const resetAt=remote.resetAt?(new Date(remote.resetAt)).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):null;
      meta.innerHTML=`${tx('剩余','Remaining')} <b>${remote.remaining.toLocaleString()}</b> / ${limitNum}（${usedNum} ${tx('已用','used')} · ${usedPct.toFixed(1)}%）${resetAt?` · ${tx('重置','reset')} ${resetAt}`:''}${cd?` · ${cd} ${tx('后','later')}`:''} · ${tx('累计','cumulative')} ${local.calls||0} ${tx('次','times')} / ${(local.totalTokens||0).toLocaleString()} tokens`;
    } else if(local.calls){
      // 没有远程响应头，用本地估算显示。进度条按 Lite 套餐 2,500 credits 估算。
      // No remote headers: render the local estimate. The bar compares against the Lite plan's 2,500 credits.
      if(estPctRemaining!=null){
        fill.style.width=estPctRemaining+'%';
        fill.setAttribute('data-level',estPctRemaining>50?'ok':estPctRemaining>20?'mid':'low');
        pct.textContent=estPctRemaining.toFixed(1)+'%';
        card.setAttribute('data-empty','false');
      } else {
        fill.style.width='0%';
        fill.removeAttribute('data-level');
        pct.textContent='—';
        card.setAttribute('data-empty','true');
      }
      const cd=local.countdownMs?(()=>{const ms=local.countdownMs,totalMin=Math.floor(ms/60000),d=Math.floor(totalMin/1440),h=Math.floor((totalMin%1440)/60);return d>0?d+'d '+h+'h':h>0?h+'h':Math.max(1,totalMin)+'m';})():null;
      const resetTxt=local.periodEnd?(new Date(local.periodEnd)).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):null;
      meta.innerHTML=`${tx('估算已用','Est. used')} <b>${estCredits.toFixed(1)}</b> credits / ${estimateLimit}（${tx('本地估算','local estimate')} · Token Plan Lite ${tx('默认','default')}） · ${tx('累计','cumulative')} ${local.calls} ${tx('次','times')} / ${(local.totalTokens||0).toLocaleString()} tokens${resetTxt?` · ${tx('重置','reset')} ${resetTxt}`:''}${cd?`（${cd}）`:''} · <span style="color:#ffcb69">${tx('精确剩余请到 Token Plan 控制台查看','Check exact remaining in the Token Plan console')}</span>`;
    } else {
      card.setAttribute('data-empty','true');
      pct.textContent='—';
      fill.style.width='0%';
      meta.textContent=tx('尚未调用千问，额度无数据','Qwen not called yet; no quota data');
    }
  };
  const renderApiCenter=async()=>{
    let credentials={},verification={},coinGeckoUsage=null; try { const payload=await apiCenterRequest('/api/api-center'); credentials=payload.credentials||{}; verification=payload.verification||{}; coinGeckoUsage=payload.coinGeckoUsage||null; } catch {}
    window.dispatchEvent(new CustomEvent('btc:ai-credential-changed', { detail:{ available:Boolean(credentials.qwen && verification.qwen) } }));
    const free=apiCenterFree().map(([group,name,note])=>`<article class="api-center-row free"><div><b>${group}</b><span>${name}</span></div><em>${note}</em></article>`).join('');
    // 千问配置需要模型列表与当前选择，单独从 AI 配置接口取。
    // The Qwen card needs the model list and current choice, fetched from the AI config endpoint.
    let aiConfig={configured:false,model:'',models:[]}; try { aiConfig=await (await fetch('/api/ai/config')).json(); } catch {}
    // 模型下拉：只列可用于问答的文本模型，并标出额度档位（省 / 中 / 贵）。
    // Model picker: only chat-capable text models, tagged with their credit tier.
    const qwenTierTag={value:tx('省','Econ'),balanced:tx('中','Mid'),flagship:tx('贵','Premium')};
    const qwenModels=(aiConfig.models||[]).filter(entry=>entry.usable!==false).map(entry=>{const tag=qwenTierTag[entry.tier]||'';return `<option value="${calendarEscape(entry.id)}"${entry.id===aiConfig.model?' selected':''}>${calendarEscape(entry.label)}${tag?' · '+tag:''}${entry.recommended?tx('（推荐）',' (recommended)'):''}</option>`;}).join('');
    // 端点快捷选择：千问两套体系（按量付费 / Token Plan 订阅），端点与 Key 必须配套。
    // Endpoint picker: Qwen has two isolated systems and the endpoint must match the key.
    const qwenEndpoints=(aiConfig.endpoints||[]).map(entry=>`<option value="${calendarEscape(entry.baseUrl)}"${entry.baseUrl===aiConfig.baseUrl?' selected':''}>${calendarEscape(entry.label)}</option>`).join('');
    const qwenEndpointNote=aiConfig.baseUrl?`<p class="api-endpoint-note">${tx('当前端点：','Current endpoint: ')}<code>${calendarEscape(aiConfig.baseUrl)}</code> · ${tx('识别为','detected as ')}${aiConfig.keyKind==='token-plan'?tx('Token Plan 订阅 Key（sk-sp-）','Token Plan subscription key (sk-sp-)'):tx('按量付费 Key（sk-）','pay-as-you-go key (sk-)')}${aiConfig.mismatch?'<b class="api-endpoint-warn"> · ⚠️ ' + tx('与 Key 前缀不匹配，调用会返回 401','key prefix mismatch; calls return 401') + '</b>':''}${aiConfig.autoCorrected?'<b class="api-endpoint-warn"> · ' + tx('已自动纠正为匹配端点','auto-corrected to the matching endpoint') + '</b>':''}</p>`:'';
    // 千问额度小卡：进度条 + 剩余 % + 倒计时，与右下角 AI 助手面板同源。
    // Qwen quota mini card: bar + remaining % + countdown, mirrors the chat-panel source.
    const qwenQuotaMarkup=`<div class="api-qwen-quota" data-empty="true"><div class="api-qwen-quota-bar"><div class="api-qwen-quota-fill"></div></div><span class="api-qwen-quota-pct">—</span><span class="api-qwen-quota-meta">${tx('尚未调用千问，额度无数据','Qwen not called yet; no quota data')}</span></div>`;
    const qwen=`<article class="api-center-row api-center-qwen"><div><b>千问 Qwen<small>${tx('AI 行情助手','AI market assistant')}</small>${verification.qwen?'<span class="badge bull api-verified">' + tx('已验证','Verified') + '</span>':''}</b><span>${tx('为右下角 AI 助手提供行情解读与涨跌判断；默认 ','Provides market readouts and trend calls for the bottom-right AI assistant; default ')}<code>${calendarEscape(aiConfig.defaultModel||'qwen3.8-flash')}</code>${tx('，额度消耗约为旗舰的 1/15','; credit cost ≈ 1/15 of the flagship')}</span><div class="api-key-systems"><b>${tx('两种 Key 体系 · 端点必须配套，混用一律 401','Two key systems · endpoint must match, mismatched = 401')}</b><span><code>sk-</code> / <code>sk-ws-</code> ${tx('按量付费 → DashScope 端点','pay-as-you-go → DashScope endpoint')}</span><span><code>sk-sp-</code> ${tx('Token Plan 个人版订阅 → Token Plan 端点','Token Plan personal subscription → Token Plan endpoint')}</span><small>${tx('Token Plan 的 Key 在「我的订阅」页面生成，只完整显示一次；Key 仅以服务端加密方式保存，不会回显。','The Token Plan key is generated on the “My Subscriptions” page and shown in full only once; keys are saved server-side encrypted and never echoed back.')}</small></div>${qwenEndpointNote}${qwenQuotaMarkup}</div><form data-api-provider="qwen" autocomplete="off"><input name="key" type="password" autocomplete="new-password" placeholder="${credentials.qwen?tx('已保存，重新填写以更新','Saved — re-enter to update'):tx('sk-… / sk-sp-… 千问 API Key','sk-… / sk-sp-… Qwen API Key')}" data-1p-ignore="true" data-lpignore="true" ${credentials.qwen?'data-saved="true"':''}><label>${tx('模型','Model')}<select name="model">${qwenModels}</select></label><label>${tx('端点类型','Endpoint type')}<select name="endpoint" class="qwen-endpoint"><option value="">${tx('按 Key 前缀自动匹配（推荐）','Auto-match by key prefix (recommended)')}</option>${qwenEndpoints}</select></label><label>${tx('API 地址（可选，留空自动匹配）','API URL (optional, auto-matched if blank)')}<input name="url" type="url" inputmode="url" autocomplete="off" aria-label="Qwen compatible endpoint" placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"></label><div class="api-qwen-actions"><button>${credentials.qwen?tx('更新 Key','Update Key'):tx('保存 Key','Save Key')}</button><button type="button" class="api-verify-qwen">${tx('验证 Key','Verify Key')}</button>${credentials.qwen?'<button type="button" class="api-clear">' + tx('清除','Clear') + '</button>':''}</div></form></article>`;
    const coinGeckoUsageMarkup=(()=>{if(!credentials.coingecko)return '<div class="coingecko-usage muted">' + tx('保存 CoinGecko Demo Key 后显示月度额度统计。','Save a CoinGecko Demo Key to see monthly quota stats.') + '</div>';if(!coinGeckoUsage?.available)return `<div class="coingecko-usage error">${tx('额度暂不可用：','Quota temporarily unavailable: ')}${calendarEscape(coinGeckoUsage?.reason||tx('请稍后重试','please retry later'))}</div>`;const used=coinGeckoUsage.used,limit=coinGeckoUsage.monthlyLimit,remaining=coinGeckoUsage.remaining,pct=Number.isFinite(used)&&Number.isFinite(limit)&&limit>0?Math.min(100,used/limit*100):0,next=new Date();next.setMonth(next.getMonth()+1,1);next.setHours(0,0,0,0);return `<div class="coingecko-usage"><div><b>${tx('CoinGecko 月度额度','CoinGecko monthly quota')} · ${calendarEscape(coinGeckoUsage.plan)}</b><strong>${Number.isFinite(pct)?pct.toFixed(1):'--'}%</strong></div><i><span style="width:${pct}%"></span></i><p>${Number.isFinite(used)?used.toLocaleString():'--'} ${tx('已用','used')} · ${Number.isFinite(remaining)?remaining.toLocaleString():'--'} ${tx('剩余','remaining')} · ${tx('月度总额','monthly total')} ${Number.isFinite(limit)?limit.toLocaleString():'--'}</p><small>${coinGeckoUsage.rateLimit?`${tx('限额','limit')} ${coinGeckoUsage.rateLimit}${tx('/分钟','/min')} · `:''}${tx('下次重置','next reset')} ${next.toLocaleDateString(uiLang==='zh'?'zh-CN':'en-US')} · ${tx('统计缓存 5 分钟','stats cached 5 min')}</small></div>`;})();
    const optional=apiCenterOptional().map(([id,name,scope,hint])=>`<article class="api-center-row"><div><b>${name}<small>${tx('可选升级（默认免费）','Optional upgrade (free by default)')}</small>${verification[id]?'<span class="badge bull api-verified">' + tx('已验证','Verified') + '</span>':''}</b><span>${scope}</span><p>${hint}</p>${id==='coingecko'?coinGeckoUsageMarkup:''}</div><form data-api-provider="${id}" autocomplete="off">${id==='custom'?`<label>API URL<input name="url" type="url" inputmode="url" autocomplete="url" aria-label="HTTPS API URL" placeholder="https://api.example.com/v1/data" data-1p-ignore="true" data-lpignore="true" ${credentials[id]?'data-saved="true"':''}></label><label>API Key（${credentials[id]?tx('重新填写以更新','refill to update'):tx('可选','optional')}）<input name="key" type="password" autocomplete="new-password" aria-label="Optional API key" placeholder="${tx('可选 API Key（不会回显）','Optional API key (never echoed)')}" data-1p-ignore="true" data-lpignore="true"></label>`:`<input name="key" type="password" autocomplete="off" placeholder="${hint}" ${credentials[id]?'data-saved="true"':''}>`}<button>${credentials[id]?tx('更新','Update'):tx('保存','Save')}${id==='custom'?tx('配置',' config'):tx(' Key',' Key')}</button>${credentials[id]&&id!=='custom'?'<button type="button" class="api-verify">' + tx('验证 Key','Verify Key') + '</button>':''}${credentials[id]?'<button type="button" class="api-clear">' + tx('清除','Clear') + '</button>':''}</form></article>`).join('');
    apiCenterModal.innerHTML=`<section role="dialog" aria-modal="true" aria-labelledby="apiCenterTitle"><header><div><b id="apiCenterTitle">${tx('API 接入中心','API Center')}</b><small>${tx('密钥仅保存于本机服务端，不会回显到浏览器','Keys are stored server-side only and never echoed back')}</small></div><button type="button" data-close-api-center aria-label="${tx('关闭','Close')}">×</button></header><div class="api-center-body"><h3>${tx('默认免费（无需填入）','Free by default (no entry)')}</h3>${free}<h3>${tx('可选升级（默认免费）','Optional upgrade (free by default)')}</h3>${optional}<h3>${tx('AI 大模型（可选）','AI models (optional)')}</h3>${qwen}<h3>${tx('付费数据（可选）','Paid data (optional)')}</h3><article class="api-center-row required"><div><b>Finnhub Economic Calendar<small>${tx("付费套餐","Paid plan")}</small>${verification.finnhub?'<span class="badge bull api-verified">' + tx("Key 已验证","Key verified") + '</span>':''}</b><span>${tx("宏观实际值、市场一致预期、前值","Actual macro values, market consensus, previous values")}</span><p>${tx("免费 Key 可验证基础行情，但 Economic Calendar 需要付费套餐；未开通时自动使用内置公开宏观日历。","A free key validates basic quotes, but the Economic Calendar needs a paid plan; when unavailable, the built-in public macro calendar is used automatically.")}</p></div><form data-api-provider="finnhub"><input name="key" type="password" autocomplete="off" placeholder="${tx("可选：仅付费套餐可启用 Economic Calendar","Optional: paid plan enables the Economic Calendar")}" ${credentials.finnhub?'data-saved="true"':''}><button>${credentials.finnhub?tx('更新 Key','Update Key'):tx('保存 Key','Save Key')}</button>${credentials.finnhub?'<button type="button" class="api-verify">' + tx('验证 Key','Verify Key') + '</button><button type="button" class="api-clear">' + tx('清除','Clear') + '</button>':''}</form></article></div></section>`;
    apiCenterModal.querySelector('[data-close-api-center]').onclick=()=>{apiCenterModal.hidden=true;};
    apiCenterModal.onclick=event=>{if(event.target===apiCenterModal)apiCenterModal.hidden=true;};
    apiCenterModal.querySelectorAll('form[data-api-provider]').forEach(form=>form.onsubmit=async event=>{event.preventDefault();const provider=form.dataset.apiProvider,key=(form.elements.key?.value||'').trim(),url=(form.elements.url?.value||'').trim(),model=(form.elements.model?.value||'').trim();if(provider==='custom'?!url:!key){showAppDialog({title:tx('API 接入中心','API Center'),message:provider==='custom'?tx('请填写有效的 HTTPS API 地址。','Enter a valid HTTPS API URL.'):tx('请填写 API Key。','Enter the API Key.')});return;}try{await apiCenterRequest('/api/api-center',{method:'PUT',body:JSON.stringify({provider,key,url,model})});const saved=await window.btcSecureVault?.get('api-center')||{};await window.btcSecureVault?.put('api-center',{...saved,[provider]:{key,url}});await renderApiCenter();}catch(error){showAppDialog({title:tx('API 接入中心','API Center'),message:error.message});}});
    apiCenterModal.querySelectorAll('.api-clear').forEach(button=>button.onclick=async()=>{try{const provider=button.closest('form').dataset.apiProvider;await apiCenterRequest(`/api/api-center?provider=${provider}`,{method:'DELETE'});const saved=await window.btcSecureVault?.get('api-center')||{};delete saved[provider];await window.btcSecureVault?.put('api-center',saved);await renderApiCenter();}catch(error){showAppDialog({title:tx('API 接入中心','API Center'),message:error.message});}});
    apiCenterModal.querySelectorAll('.api-verify').forEach(button=>button.onclick=async()=>{const provider=button.closest('form').dataset.apiProvider;button.disabled=true;button.textContent=tx('验证中…','Verifying…');try{const result=await apiCenterRequest('/api/api-center/verify',{method:'POST',body:JSON.stringify({provider})});if(result.valid)await renderApiCenter();showAppDialog({title:tx('API Key 验证','API Key verification'),message:result.message});}catch(error){showAppDialog({title:tx('API Key 验证','API Key verification'),message:error.message});}finally{button.disabled=false;button.textContent=tx('验证 Key','Verify Key');}});
    // 千问验证：输入框里填了新 Key 就先保存再验证，一次点击走完整个流程。
    // Qwen verify: save first when a new key is typed, so one click completes the whole flow.
    // 端点下拉只是填充工具：选中即写入 API 地址输入框；留空表示交给服务端按 Key 前缀自动匹配。
    // The endpoint dropdown only fills the URL field; blank means auto-match by key prefix.
    const qwenEndpointSelect=apiCenterModal.querySelector('.qwen-endpoint');
    if(qwenEndpointSelect)qwenEndpointSelect.onchange=()=>{const form=apiCenterModal.querySelector('form[data-api-provider="qwen"]');if(form?.elements.url)form.elements.url.value=qwenEndpointSelect.value;};
    // 粘贴 Key 立刻提示它属于哪套体系（sk-sp- = Token Plan 订阅）。
    // Typing a key immediately reveals which system it belongs to.
    const qwenKeyInput=apiCenterModal.querySelector('form[data-api-provider="qwen"] input[name="key"]');
    if(qwenKeyInput&&qwenEndpointSelect){const tokenPlanOption=[...qwenEndpointSelect.options].find(option=>option.value.includes('token-plan'));if(tokenPlanOption)qwenKeyInput.oninput=()=>{qwenEndpointSelect.value=/^sk-sp-/i.test(qwenKeyInput.value.trim())?tokenPlanOption.value:'';};}
    const qwenVerifyButton=apiCenterModal.querySelector('.api-verify-qwen');
    if(qwenVerifyButton)qwenVerifyButton.onclick=async()=>{const form=apiCenterModal.querySelector('form[data-api-provider="qwen"]');const key=(form?.elements.key?.value||'').trim(),model=(form?.elements.model?.value||'').trim(),url=(form?.elements.url?.value||'').trim();if(!key&&!credentials.qwen){showAppDialog({title:tx('千问 API Key 验证','Qwen API Key verification'),message:tx('请先填写 API Key 再验证。','Enter the API Key before verifying.')});return;}qwenVerifyButton.disabled=true;qwenVerifyButton.textContent=tx('验证中…','Verifying…');try{if(key){await apiCenterRequest('/api/api-center',{method:'PUT',body:JSON.stringify({provider:'qwen',key,url,model})});window.dispatchEvent(new CustomEvent('btc:ai-credential-changed',{detail:{available:false}}));}const result=await apiCenterRequest('/api/api-center/verify',{method:'POST',body:JSON.stringify({provider:'qwen'})});await renderApiCenter();showAppDialog({title:'千问 API Key 验证',message:result.message});}catch(error){await renderApiCenter();showAppDialog({title:'千问 API Key 验证',message:error.message});}finally{qwenVerifyButton.disabled=false;qwenVerifyButton.textContent=tx('验证 Key','Verify Key');}};

    // 千问额度小卡渲染：与右下角对话窗同源（同一接口），数据保留 60s。
    // Mini Qwen quota card: same endpoint as the chat panel; data cached for 60s.
    const qwenQuotaCard=apiCenterModal.querySelector('.api-qwen-quota');
    if(qwenQuotaCard)renderApiQwenQuota(qwenQuotaCard);
  };
  apiCenter.onclick=async()=>{apiCenterModal.hidden=false;await renderApiCenter();};
  // API 中心打开时 60s 拉一次千问额度；关闭后停掉，避免空转。
  // While the API center is open, refresh the Qwen quota card every 60s; stop when hidden.
  let apiQuotaTimer=null;
  const startApiQuotaLoop=()=>{if(apiQuotaTimer)return;const tick=()=>{const card=apiCenterModal.querySelector('.api-qwen-quota');if(card)renderApiQwenQuota(card);};apiQuotaTimer=setInterval(()=>{if(!apiCenterModal.hidden)tick();else{clearInterval(apiQuotaTimer);apiQuotaTimer=null;}},60_000);};
  const stopApiQuotaLoop=()=>{if(apiQuotaTimer){clearInterval(apiQuotaTimer);apiQuotaTimer=null;}};
  const apiCenterCloseBtn=apiCenterModal.querySelector('[data-close-api-center]');
  if(apiCenterCloseBtn){const original=apiCenterCloseBtn.onclick;apiCenterCloseBtn.onclick=(event)=>{stopApiQuotaLoop();if(typeof original==='function')original.call(apiCenterCloseBtn,event);};}
  apiCenter.onclick=async()=>{apiCenterModal.hidden=false;await renderApiCenter();startApiQuotaLoop();};
  lang.onclick = () => {
    uiLang = uiLang === "zh" ? "en" : "zh";
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
  wti: ["WTI 原油", "WTI crude oil"],
  vix: ["VIX 波动率", "VIX volatility"],
  "btc-dominance": ["BTC 总市值占比", "BTC dominance"],
  "crypto-total-cap": ["全网加密总市值", "Total crypto market cap"],
  "crypto-volume": ["全网 24h 成交额", "Total 24h crypto volume"],
  "exchange-btc-reserve": ["交易所 BTC 钱包余额", "Exchange BTC reserves"],
};
// 周期/范围内部标签（中文 token → 英文显示）。Interval/range internal tokens (zh → en display).
const INTERVAL_LABELS = {
  "5分": "5m", "15分": "15m", "30分": "30m", "1时": "1h", "3时": "3h",
  "6时": "6h", "12时": "12h", "1小时": "1h", "3小时": "3h",
  "5分钟": "5 min", "15分钟": "15 min", "30分钟": "30 min",
  "1小时": "1 hour", "3小时": "3 hours",
};
const txInterval = (v) => (uiLang === "zh" ? v : INTERVAL_LABELS[v] || v);
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
// Chinese experiment names/candidates returned by the research backend, with EN equivalents.
const RESEARCH_EXP_NAMES = {
  "当前规则信号（旧口径）": "Current rule signal (legacy)",
  "GitHub 规则信号对照（Walk-forward）": "GitHub rule-signal comparison (walk-forward)",
  "当前规则信号（严格对照）": "Current rule signal (strict comparison)",
  "短线机器预测": "Short-horizon ML forecast",
  "多周期概率预测": "Multi-timeframe probability forecast",
  "多周期共振": "Multi-timeframe resonance",
  "形态与关键位": "Patterns & key levels",
  "OKX 微观结构": "OKX microstructure",
  "恐惧贪婪 / 新闻": "Fear & Greed / News",
  "美股联动": "US equity correlation",
  "强平缓冲": "Liquidation buffer",
  "宏观日历": "Macro calendar",
  "图表、周期涨幅、指标明细": "Charts, period returns, indicator details",
};
const RESEARCH_EXP_CANDS = {
  "旧版近似基线；仅保留历史参照，不作为升级依据":
    "Legacy approximate baseline; kept only as historical reference, not an upgrade target",
  "A：GitHub v2.4.0 即时分数；B：当前 ±45 / ±28 稳定化核心与连续收盘确认。相同 15m 已收盘 K 线、相同 1h / 4h / 24h 结算与 0.08% 往返成本。":
    "A: GitHub v2.4.0 instant score; B: current ±45/±28 stabilized core with consecutive-close confirmation. Same 15m closed candles, same 1h/4h/24h settlement and 0.08% round-trip cost.",
  "线上同分数基线 + 连续 3 根收盘确认 + EMA 排列 / RSI / 成交量确认":
    "Live same-score baseline + 3 consecutive close confirmations + EMA alignment / RSI / volume confirmation",
  "仅已收盘 K 线的波动归一化候选":
    "Volatility-normalized candidate from closed candles only",
  "时间顺序、波动归一化的校准候选":
    "Time-ordered, volatility-normalized calibration candidate",
  "按趋势强度与波动率加权的一致性":
    "Consistency weighted by trend strength and volatility",
  "突破需成交量、ATR 与收盘确认":
    "Breakouts need volume, ATR, and close confirmation",
  "OFI、流动性质量与点差过滤":
    "OFI, liquidity quality, and spread filtering",
  "事件分类、时间衰减、价格吸收标记":
    "Event classification, time decay, price-absorption markers",
  "滚动相关、正则化与市场状态过滤":
    "Rolling correlation, regularization, and market-state filtering",
  "分位数波动与状态自适应缓冲":
    "Quantile volatility with state-adaptive buffer",
  "事件前后波动区间模型":
    "Pre/post-event volatility-range model",
  "数据一致性、缺失率与公式复算":
    "Data consistency, missing-rate, and formula recomputation",
};
const RESEARCH_WINDOW_LABELS = {
  "约 15 分钟": "~15 min",
  "约 1 小时": "~1 hour",
  "约 4 小时": "~4 hours",
  "约 1 天": "~1 day",
  "约 1 日": "~1 day",
};
const txExpName = (v) => (uiLang === "zh" ? v : RESEARCH_EXP_NAMES[v] || v);
const txExpCand = (v) => (uiLang === "zh" ? v : RESEARCH_EXP_CANDS[v] || v);
const txWinLabel = (v) => (uiLang === "zh" ? v : RESEARCH_WINDOW_LABELS[v] || v);
// 实验备注（note）双语映射。
// Bilingual map for experiment notes (note) from the research backend.
const RESEARCH_EXP_NOTES = {
  "先以当前可用 OFI 快照记录；深度历史成熟前不作升级结论":
    "Recording with current OFI snapshots first; no upgrade decision until deep history matures",
  "等待 BTC、SPY、QQQ 的同步日线快照":
    "Awaiting synchronized daily snapshots of BTC, SPY, QQQ",
  "按实际触及率验证风险覆盖率，不用方向准确率":
    "Validated by realized hit rate / risk coverage, not directional accuracy",
  "按波动覆盖率验证，不用涨跌准确率":
    "Validated by volatility coverage, not up/down accuracy",
  "描述 / 公式型：不适用方向准确率":
    "Descriptive/formula module: directional accuracy does not apply",
  "每个周期需 30 个已配对结算样本；当前样本不足。":
    "Each horizon needs 30 paired settled samples; current samples are insufficient.",
};
// 评估结论（verdict.reason / verdict.label）双语映射。
// Bilingual map for evaluation verdict reasons and labels from the research backend.
const RESEARCH_VERDICT_REASON = {
  "样本量已达到最低门槛，但候选尚未同时达到正 Brier Skill、成本后正收益与市场状态稳健性要求。":
    "Sample size meets the minimum threshold, but the candidate does not yet achieve positive Brier Skill, post-cost positive return, and market-state robustness at the same time.",
  "每个周期及已覆盖市场状态均需 100 个已结算配对样本。":
    "Each horizon and covered market state requires 100 settled paired samples.",
  "每个已覆盖市场状态均有足量样本":
    "Every covered market state has sufficient samples",
};
const RESEARCH_VERDICT_LABEL = {
  "继续影子评估": "Continue shadow scoring",
  "不建议升级": "Not recommended for upgrade",
};
const txExpNote = (v) => (uiLang === "zh" ? v : RESEARCH_EXP_NOTES[v] || v);
const txVerdictReason = (v) =>
  uiLang === "zh" ? v : RESEARCH_VERDICT_REASON[v] || v;
const txVerdictLabel = (v) =>
  uiLang === "zh" ? v : RESEARCH_VERDICT_LABEL[v] || v;
const txMap = (map, value, fallback) =>
  value == null ? fallback : (uiLang === "zh" ? value : (map[value] || value));
function pointTime(ms) {
  return new Intl.DateTimeFormat(uiLang === "zh" ? "zh-CN" : "en-US", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(ms);
}
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
function addHelp(el, zh, en) {
  if (!el || el.querySelector(".help-dot")) return;
  const tip = document.createElement("button");
  tip.type = "button";
  tip.className = "help-dot";
  tip.setAttribute("aria-label", tx("查看说明", "Show explanation"));
  tip.textContent = "!";
  tip.dataset.tip = tx(zh, en);
  el.append(tip);
}
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
  $("indicators").innerHTML = rows
    .map(
      ([k, v, tag]) =>
        `<div class="metric"><span>${k}</span><b>${v}</b><i class="badge ${tag === tx("看多", "Bullish") ? "bull" : tag === tx("看空", "Bearish") ? "bear" : "flat"}">${tag}</i></div>`,
    )
    .join("");
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
    state.ticker = data.ticker;
    state.lastGood = data;
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
  document.querySelector("header p").innerHTML =
    `<span class="live-pulse"></span>${tx("实时连接 · REST 轮询", "Live connection · REST polling")}`;
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
  const index = (e) => {
    const r = cv.getBoundingClientRect(),
      d = visibleCandles();
    return Math.max(
      0,
      Math.min(
        d.length - 1,
        Math.round(
          ((e.clientX - r.left - 18) / (r.width - 92)) * (d.length - 1),
        ),
      ),
    );
  };
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
      el.innerHTML = `<b>${tx("已选区段", "Selected")}</b> ${pointTime(s[0].time)} — ${pointTime(s.at(-1).time)} · <span class="high">${tx("最高", "High")} ${money(hi)}</span> · <span class="low">${tx("最低", "Low")} ${money(lo)}</span> · <span class="${change >= 0 ? "bull" : "bear"}">${tx("涨跌", "Return")} ${pct(change)}</span>`;
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
let chartPaused = false,
  frozenCandles = null;
/* Keep pan-control state independent from the chart renderer. */
let updatePanControls = () => {};
visibleCandles = function () {
  const data = frozenCandles || state.candles,
    n = Math.max(30, Math.ceil(data.length / state.zoom));
  return data.slice(-n);
};
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
    frozenCandles = null;
    hoverIndex = null;
    const tip = $("chartTooltip");
    if (tip) tip.style.display = "none";
    drawLive();
  };
  cv.addEventListener("mouseenter", () => {
    frozenCandles = state.candles.slice();
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

/* Browser speech uses the device's native voice and stays entirely local. */
setTimeout(() => {
  const priceCard = $("price")?.parentElement;
  if (!priceCard) return;
  const store = "btc_voice_quote_settings_v1";
  let settings = {
    enabled: false,
    livePriceEnabled: false,
    livePriceConcise: false,
    interval: 60,
    lastSpokenAt: 0,
    voiceURI: "",
    engine: "edge",
    edgeVoice: "zh-CN-XiaoxiaoNeural",
    chimeType: "station",
    riseChimeType: "rise",
    dropChimeType: "drop",
    liquidationChimeType: "warning",
    chimeVolume: 100,
    speechVolume: 100,
  };
  try {
    settings = {
      ...settings,
      ...JSON.parse(localStorage.getItem(store) || "{}"),
    };
  } catch {}
  if (
    ![15, 30, 60, 300, 600, 900, 1800, 3600].includes(Number(settings.interval))
  )
    settings.interval = 300;
  const supported =
    "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
  const voicePlaybackAvailable = supported || "Audio" in window;
  const save = () => localStorage.setItem(store, JSON.stringify(settings));
  /* 播报优先级：多条语音同时触发时按此顺序依次播报（设置面板可自定义排序）。 */
  const speechPriorityDefault = [
    "liquidation",
    "speed",
    "price",
    "move",
    "tick",
    "gap",
    "live",
  ];
  settings.speakPriority = Array.isArray(settings.speakPriority)
    ? [
        ...new Set(
          settings.speakPriority.filter((key) =>
            speechPriorityDefault.includes(key),
          ),
        ),
      ]
    : [];
  speechPriorityDefault.forEach((key) => {
    if (!settings.speakPriority.includes(key))
      settings.speakPriority.push(key);
  });
  const speechRankOfKey = (key) => {
      const index = settings.speakPriority.indexOf(key);
      return index < 0 ? speechPriorityDefault.length : index;
    },
    speechCategoryOfRule = (rule) =>
      rule?.kind === "long_liquidation" || rule?.kind === "short_liquidation"
        ? "liquidation"
        : rule?.kind === "price_speed"
          ? "speed"
          : rule?.kind === "price_move"
            ? "move"
            : rule?.kind === "price_tick_move"
              ? "tick"
              : rule?.kind === "theoretical_liquidation_gap"
                ? "gap"
                : "price",
    speechRankOfRule = (rule) => speechRankOfKey(speechCategoryOfRule(rule));
  const speechQueue = [];
  let speechQueueBusy = false;
  const drainSpeechQueue = () => {
      if (speechQueueBusy || !speechQueue.length) return;
      const item = speechQueue.shift();
      speechQueueBusy = true;
      const done = () => {
        speechQueueBusy = false;
        window.setTimeout(drainSpeechQueue, 300);
      };
      /* say 返回 false（总开关已关）时放弃整条队列，避免 busy 永久卡住。 */
      if (!say(item.text, { ...item.options, onEnded: done, onFailure: done })) {
        speechQueueBusy = false;
        speechQueue.length = 0;
      }
    },
    enqueueSpeech = (text, options = {}, rank = 0) => {
      speechQueue.push({ text, options, rank });
      speechQueue.sort((a, b) => a.rank - b.rank);
      drainSpeechQueue();
      return true;
    };
  let voices = [],
    audioContext = null,
    currentAudio = null,
    isSpeaking = false,
    /* 正在/最近一次播报的规则名：设置面板状态行据此显示「正在播报：xxx」。 */
    speakingLabel = null,
    speechSequence = 0,
    lastLiveSpokenPrice = null;
  let setSpeaking = () => {};
  const volume = (value) => {
    const normalized = Math.max(0, Math.min(1, Number(value) / 100));
    return normalized * normalized;
  };
  const chimePresets = {
    station: { notes: [523.25, 659.25, 783.99], wave: "sine", gap: 0.15 },
    airport: { notes: [880, 1046.5, 1318.5], wave: "sine", gap: 0.13 },
    gentle: { notes: [392, 493.88, 587.33], wave: "triangle", gap: 0.2 },
    alert: { notes: [740, 740, 988, 988], wave: "square", gap: 0.11 },
    rise: { notes: [440, 554.37, 659.25], wave: "triangle", gap: 0.14 },
    drop: { notes: [659.25, 554.37, 440], wave: "sine", gap: 0.14 },
    warning: { notes: [880, 880, 660, 880], wave: "square", gap: 0.12 },
    siren: { notes: [740, 988, 740, 988, 740], wave: "sawtooth", gap: 0.12 },
    critical: { notes: [1046.5, 1046.5, 1046.5, 740], wave: "square", gap: 0.1 },
  };
  const playChime = (chimeType = settings.chimeType) => {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return 0;
    audioContext ||= new Context();
    audioContext.resume?.().catch(() => {});
    const preset = chimePresets[chimeType] || chimePresets.station,
      level = Math.max(0, Math.min(1, Number(settings.chimeVolume) / 100)),
      peak = Math.max(0.0001, Math.min(1, 0.72 * Math.pow(level, 1.35))),
      start = audioContext.currentTime + 0.02;
    preset.notes.forEach((frequency, index) => {
      const oscillator = audioContext.createOscillator(),
        gain = audioContext.createGain(),
        at = start + index * preset.gap;
      oscillator.type = preset.wave;
      oscillator.frequency.setValueAtTime(frequency, at);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(peak, at + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.start(at);
      oscillator.stop(at + 0.18);
    });
    return preset.notes.length * preset.gap * 1000 + 290;
  };
  const saySystem = (text, { onStarted, onEnded, onFailure } = {}) => {
    if (!supported) return false;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text),
      voice = voices.find((item) => item.voiceURI === settings.voiceURI);
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    } else utterance.lang = uiLang === "zh" ? "zh-CN" : "en-US";
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.volume = volume(settings.speechVolume);
    utterance.onstart = onStarted;
    utterance.onend = onEnded;
    utterance.onerror = onFailure;
    window.speechSynthesis.speak(utterance);
    return true;
  };
  const sayEdge = async (text, { onStarted, onEnded, onFailure } = {}) => {
    const response = await fetch("/api/voice/edge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, voice: settings.edgeVoice }),
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      throw new Error(failure.detail || failure.error || "Edge voice unavailable");
    }
    currentAudio?.pause();
    const audio = new Audio(URL.createObjectURL(await response.blob()));
    currentAudio = audio;
    audio.volume = volume(settings.speechVolume);
    audio.onplay = onStarted;
    audio.onended = () => {
      URL.revokeObjectURL(audio.src);
      onEnded?.();
    };
    audio.onerror = onFailure;
    await audio.play();
    return true;
  };
  const say = (text, { force = false, chimeType, label, onStarted, onEnded, onFailure } = {}) => {
    if (!settings.enabled && !force) return false;
    // Edge TTS does not depend on the browser's system speech API.  Some
    // embedded browsers omit speechSynthesis entirely, so only touch it when
    // it exists; otherwise the exception prevented the Edge request as well.
    const sequence = ++speechSequence;
    if (supported) window.speechSynthesis.cancel();
    currentAudio?.pause();
    const started = () => {
        if (sequence !== speechSequence) return;
        setSpeaking(true, label);
        onStarted?.();
      },
      /* 被更高优先级的插队打断时也要回调 onEnded/onFailure，语音队列才能继续。 */
      ended = () => {
        if (sequence === speechSequence) setSpeaking(false);
        onEnded?.();
      },
      failed = (error) => {
        if (sequence === speechSequence) setSpeaking(false);
        onFailure?.(error);
      };
    const delay = playChime(chimeType);
    window.setTimeout(() => {
      if (sequence !== speechSequence) {
        onEnded?.();
        return;
      }
      if (settings.engine === "edge") {
        sayEdge(text, { onStarted: started, onEnded: ended, onFailure: failed })
          .catch((error) => {
            if (!saySystem(text, { onStarted: started, onEnded: ended, onFailure: failed }))
              failed(error);
          });
      } else if (!saySystem(text, { onStarted: started, onEnded: ended, onFailure: failed }))
        failed(new Error("System speech is unavailable"));
    }, delay);
    return true;
  };
  const personalEntryComparisons = (value) => {
    const entries = (
        Array.isArray(window.btcPersonalEntries)
          ? window.btcPersonalEntries
          : typeof personalEntries !== "undefined"
            ? personalEntries
            : []
      ).filter(
        (entry) =>
          Number.isFinite(Number(entry?.price)) && Number(entry.price) > 0,
      ),
      current = Number(value);
    return entries.map((entry) => {
      const entryPrice = Number(entry.price),
        delta = current - entryPrice,
        isShort = entry.side === "short",
        // 价格相对买入价的变动和仓位盈亏是两个概念：空头下跌时
        // 价格是“下跌”，但仓位仍是盈利，不能用盈亏方向替代价格方向。
        // Price movement and P&L direction are distinct for short positions.
        priceUp = delta >= 0,
        pnlDelta = isShort ? -delta : delta,
        inProfit = pnlDelta >= 0,
        amount = Math.abs(delta).toLocaleString("en-US", {
          maximumFractionDigits: 2,
        }),
        percent = Math.abs((delta / entryPrice) * 100).toFixed(2),
        positionSize = Number(entry.amount),
        actualPnl =
          Number.isFinite(positionSize) && positionSize > 0
            ? positionSize * (pnlDelta / entryPrice)
            : null,
        actualPnlText =
          actualPnl === null
            ? ""
            : Math.abs(actualPnl).toLocaleString("en-US", {
                maximumFractionDigits: 2,
              }),
        sideZh = isShort ? "做空" : "做多",
        sideEn = isShort ? "Short" : "Long",
        labelZh = isShort ? "做空买入价" : "做多买入价",
        labelEn = isShort ? "short entry price" : "long entry price";
      return uiLang === "zh"
        ? `相对${labelZh} ${entryPrice.toLocaleString("en-US", { maximumFractionDigits: 2 })}，现价${priceUp ? "上涨" : "下跌"} ${amount}，${priceUp ? "涨幅" : "跌幅"} ${percent}%。差价 ${amount} 美元。${sideZh}${inProfit ? "盈利中" : "亏损中"}${actualPnlText ? `，${inProfit ? "盈利" : "亏损"} ${actualPnlText} 美元` : ""}。`
        : `Compared with your ${labelEn} of ${entryPrice.toLocaleString("en-US", { maximumFractionDigits: 2 })}, price is ${priceUp ? "up" : "down"} ${amount}, a ${priceUp ? "gain" : "drop"} of ${percent} percent. The price difference is ${amount} USD. ${sideEn} ${inProfit ? "is in profit" : "is at a loss"}${actualPnlText ? `, ${inProfit ? "profit" : "loss"} ${actualPnlText} USD` : ""}.`;
    });
  };
  const priceText = (value) => {
    const current = Number(value).toLocaleString("en-US", {
        maximumFractionDigits: 2,
      }),
      comparisons = personalEntryComparisons(value);
    return uiLang === "zh"
      ? `当前价格，${current}。${comparisons.join("")}`
      : `Current price, ${current}. ${comparisons.join(" ")}`;
  };
  /* 精简版播报语：只报「当前实时价 + 数字」这一句，不带结尾句号和持仓对比。
     数字不加千分位（76287.5 而非 76,287.5），避免 TTS 把逗号读成停顿。 */
  const concisePriceText = (value) =>
    uiLang === "zh"
      ? `当前实时价 ${Number(value).toLocaleString("en-US", { maximumFractionDigits: 2, useGrouping: false })}`
      : `Live price ${Number(value).toLocaleString("en-US", { maximumFractionDigits: 2, useGrouping: false })}`;
  const trigger = document.createElement("button");
  trigger.id = "voiceQuickToggle";
  trigger.type = "button";
  trigger.className = "voice-quick-toggle";
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.setAttribute("aria-expanded", "false");
  trigger.innerHTML = `<span class="voice-pulse voice-pulse-one" aria-hidden="true"></span><span class="voice-pulse voice-pulse-two" aria-hidden="true"></span><svg viewBox="0 0 64 64" aria-hidden="true"><path d="M8 25h13l18-14v42L21 39H8z"/><path class="voice-wave" d="M46 23c5 5 5 13 0 18M52 16c10 10 10 22 0 32"/><line class="voice-mute" x1="9" y1="10" x2="55" y2="54"/></svg><span class="voice-quick-toggle-label" aria-hidden="true"></span>`;
  priceCard.append(trigger);
  setSpeaking = (playing, label = null) => {
    isSpeaking = Boolean(playing);
    /* speakingLabel 只在拿到新 label 时更新；播报结束后保留，
       状态行才能持续显示「已播报：<规则名>」。 */
    if (isSpeaking && label) speakingLabel = label;
    trigger.classList.toggle("is-speaking", isSpeaking);
    trigger.classList.toggle("is-muted", !settings.enabled);
    trigger.disabled = !voicePlaybackAvailable;
    const label2 = !voicePlaybackAvailable
      ? tx("当前环境不支持语音播报", "Voice broadcast is unavailable")
      : isSpeaking
        ? tx("语音播报设置（正在播报）", "Voice settings (speaking)")
        : tx("打开语音播报设置", "Open voice settings");
    trigger.setAttribute("aria-label", label2);
    trigger.title = label2;
    trigger.querySelector(".voice-quick-toggle-label").textContent = isSpeaking
      ? tx("播报中", "Speaking")
      : "";
    paintVoiceSpeaking();
  };
  const settingsModal = document.createElement("div");
  settingsModal.id = "voiceSettingsModal";
  settingsModal.className = "alert-composer voice-settings-modal";
  settingsModal.hidden = true;
  settingsModal.innerHTML = `<section role="dialog" aria-modal="true" aria-labelledby="voiceSettingsTitle"><header><b id="voiceSettingsTitle">${tx("语音播报设置", "Voice alert settings")}</b><button type="button" aria-label="${tx("关闭", "Close")}" data-close-voice-settings>×</button></header><div class="voice-settings-body"></div></section>`;
  document.body.append(settingsModal);
  const settingsBody = settingsModal.querySelector(".voice-settings-body");
  const panel = document.createElement("section");
  panel.className = "voice-alert-panel";
  panel.innerHTML = `<div class="voice-panel-head"><div><b>${tx("语音播报", "Voice alerts")}</b><small id="voiceAlertStatus"></small></div></div><div class="voice-panel-grid"><section class="voice-panel-group voice-panel-toggles"><label class="voice-switch"><input id="voiceAlertEnabled" type="checkbox"><span>${tx("语音总开关", "Voice master")}</span></label><label class="voice-switch"><input id="voiceLivePriceEnabled" type="checkbox"><span>${tx("定时播报实时价", "Speak live price")}</span></label><label class="voice-switch voice-switch-sub" title="${tx("开启后定时播报只报一句播报语（如「当前实时价 76287.5」），不带持仓对比", "When on, timed speech says only one short phrase (e.g. 'Live price 76287.5'), without position comparison")}"><input id="voiceLivePriceConcise" type="checkbox"><span>${tx("定时播报实时价精简版", "Concise live price")}</span></label><label class="voice-live-interval">${tx("播报间隔", "Interval")}<select id="voiceAlertInterval"><option value="15">15 ${tx("秒", "sec")}</option><option value="30">30 ${tx("秒", "sec")}</option><option value="60">1 ${tx("分钟", "min")}</option><option value="300">5 ${tx("分钟", "min")}</option></select><small id="voiceLastSpokenAt" class="voice-last-spoken"></small></label></section><section class="voice-panel-group"><label>${tx("播报引擎", "Engine")}<select id="voiceAlertEngine"><option value="edge">${tx("Edge 神经语音（免费）", "Edge neural (free)")}</option><option value="system">${tx("本机系统语音", "System voice")}</option></select></label><label>${tx("音色", "Voice")}<select id="voiceAlertEdgeVoice"><optgroup label="${tx("自然女声", "Female (natural)")}"><option value="zh-CN-XiaoxiaoNeural">${tx("小晓 · 普通话", "Xiaoxiao · Mandarin")}</option><option value="zh-CN-XiaoyiNeural">${tx("小艺 · 普通话", "Xiaoyi · Mandarin")}</option><option value="zh-CN-liaoning-XiaobeiNeural">${tx("小北 · 辽宁口音", "Xiaobei · Liaoning")}</option><option value="zh-CN-shaanxi-XiaoniNeural">${tx("小妮 · 陕西口音", "Xiaoni · Shaanxi")}</option><option value="zh-TW-HsiaoChenNeural">${tx("晓臻 · 台湾国语", "HsiaoChen · Taiwanese")}</option><option value="zh-HK-HiuGaaiNeural">${tx("晓佳 · 粤语", "HiuGaai · Cantonese")}</option></optgroup><optgroup label="${tx("自然男声", "Male (natural)")}"><option value="zh-CN-YunxiNeural">${tx("云希 · 普通话", "Yunxi · Mandarin")}</option><option value="zh-CN-YunyangNeural">${tx("云扬 · 普通话", "Yunyang · Mandarin")}</option></optgroup></select></label><label class="system-voice-label">${tx("系统回退", "System fallback")}<select id="voiceAlertVoice"><option>${tx("正在加载系统语音…", "Loading system voices…")}</option></select></label><label>${tx("提示音音量", "Chime volume")}<span class="voice-volume-row"><input id="voiceChimeVolume" type="range" min="0" max="200" step="1"><output id="voiceChimeVolumeValue"></output></span></label><label>${tx("语音音量", "Speech volume")}<span class="voice-volume-row"><input id="voiceSpeechVolume" type="range" min="0" max="100" step="1"><output id="voiceSpeechVolumeValue"></output></span></label></section><section class="voice-panel-group voice-panel-actions"><button type="button" id="voiceAlertAddRule">＋ ${tx("配置语音规则", "Voice rules")}</button><button type="button" id="voiceAlertTest">${tx("试听", "Test voice")}</button></section></div><small class="voice-rule-note">${tx("语音规则支持价格达到、上涨、下跌及爆仓价；在“添加预警”中勾选“触发时语音播报”。", "Voice rules support reached, rise, fall and liquidation prices; enable Speak when triggered in Add alert.")}</small>`;
  settingsBody.append(panel);
  const voicePanelGrid = panel.querySelector(".voice-panel-grid"),
    voicePanelToggles = panel.querySelector(".voice-panel-toggles"),
    voicePanelActions = panel.querySelector(".voice-panel-actions");
  voicePanelToggles.append(voicePanelActions);
  /* 播报优先级排序面板：多条语音同时触发时，按此列表从上到下依次播报。 */
  /* 优先级标签与「配置语音规则 → 播报条件」下拉项保持一致，避免用户对排序对象产生歧义。 */
  const speechPriorityLabels = {
    liquidation: ["做多 / 做空爆仓价", "Long / short liquidation price"],
    speed: ["短时间急涨／急跌", "Rapid move in a short window"],
    price: ["价格达到", "Price reached"],
    move: ["每上涨／下跌指定金额", "Every rise or drop by amount"],
    tick: ["与前一次报价变动差", "Difference from previous quote"],
    gap: ["距理论强平价警告", "Theoretical liquidation distance"],
    live: ["定时播报实时价", "Timed live price"],
  };
  const priorityPanel = document.createElement("section");
  priorityPanel.className = "voice-priority-panel";
  priorityPanel.innerHTML =
    `<b>${tx("播报优先级", "Speech priority")}</b><small>${tx(
      "按住条目上下拖动即可调整顺序；多条语音同时触发时按此顺序从上到下依次播报，越靠上越优先。",
      "Drag entries up or down to reorder; when several alerts fire together they play top to bottom, higher entries first.",
    )}</small><ol class="voice-priority-list"></ol>`;
  voicePanelToggles.append(priorityPanel);
  const priorityList = priorityPanel.querySelector(".voice-priority-list");
  /* 拖拽排序：按住条目上下拖动，松手即按新顺序保存。 */
  let dragKey = null,
    renderPriority;
  renderPriority = () => {
    priorityList.innerHTML = settings.speakPriority
      .map((key, index) => {
        const label = speechPriorityLabels[key]
          ? tx(speechPriorityLabels[key][0], speechPriorityLabels[key][1])
          : key;
        return (
          '<li draggable="true" data-priority-key="' +
          key +
          '"><span class="voice-priority-grip" aria-hidden="true">⠿</span><span class="voice-priority-index">' +
          (index + 1) +
          ".</span><span>" +
          label +
          "</span></li>"
        );
      })
      .join("");
    priorityList.querySelectorAll("li").forEach((item) => {
      item.addEventListener("dragstart", (event) => {
        dragKey = item.dataset.priorityKey;
        item.classList.add("is-dragging");
        event.dataTransfer.effectAllowed = "move";
        /* Firefox 需要显式 setData 才会启动拖拽。 */
        try {
          event.dataTransfer.setData("text/plain", dragKey);
        } catch {}
      });
      item.addEventListener("dragend", () => {
        item.classList.remove("is-dragging");
        dragKey = null;
        priorityList.querySelectorAll("li").forEach((el) =>
          el.classList.remove("drop-before", "drop-after"),
        );
        /* 松手：按当前 DOM 顺序写回设置并保存。 */
        const order = [...priorityList.querySelectorAll("li")].map(
          (el) => el.dataset.priorityKey,
        );
        if (
          order.length === settings.speakPriority.length &&
          order.some((key, i) => key !== settings.speakPriority[i])
        ) {
          settings.speakPriority = order;
          save();
        }
        renderPriority();
      });
      item.addEventListener("dragover", (event) => {
        if (!dragKey || item.dataset.priorityKey === dragKey) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        const rect = item.getBoundingClientRect(),
          before = event.clientY < rect.top + rect.height / 2;
        const draggingEl = priorityList.querySelector(
          '[data-priority-key="' + dragKey + '"]',
        );
        if (!draggingEl) return;
        /* 实时预览：把拖拽项移动到目标前/后，形成无级插入。 */
        if (before && draggingEl.nextElementSibling !== item) {
          priorityList.insertBefore(draggingEl, item);
        } else if (
          !before &&
          (item.nextElementSibling !== draggingEl ||
            item.nextElementSibling === null)
        ) {
          if (item.nextElementSibling !== draggingEl)
            priorityList.insertBefore(draggingEl, item.nextElementSibling);
        }
        /* 序号即时更新，让用户看到生效后的排名。 */
        priorityList.querySelectorAll("li").forEach((el, i) => {
          const idx = el.querySelector(".voice-priority-index");
          if (idx) idx.textContent = i + 1 + ".";
        });
      });
    });
  };
  renderPriority();
  const enabled = $("voiceAlertEnabled"),
    livePriceEnabled = $("voiceLivePriceEnabled"),
    livePriceConcise = $("voiceLivePriceConcise"),
    engine = $("voiceAlertEngine"),
    edgeVoice = $("voiceAlertEdgeVoice"),
    interval = $("voiceAlertInterval"),
    lastSpokenAtLabel = $("voiceLastSpokenAt"),
    voiceSelect = $("voiceAlertVoice"),
    chimeVolume = $("voiceChimeVolume"),
    speechVolume = $("voiceSpeechVolume"),
    chimeVolumeValue = $("voiceChimeVolumeValue"),
    speechVolumeValue = $("voiceSpeechVolumeValue"),
    status = $("voiceAlertStatus"),
    test = $("voiceAlertTest");
  /* 面板头部状态行：默认显示引擎/音色摘要；播报进行中改显「正在播报：<规则名>」，
     播报结束保留「已播报：<规则名>」，总开关关闭时始终显示「已静音」。 */
  const voiceStatusLine = () => {
      const selected = voices.find(
          (voice) => voice.voiceURI === settings.voiceURI,
        ),
        name =
          settings.engine === "edge"
            ? edgeVoice.options[edgeVoice.selectedIndex]?.text
            : selected?.name || tx("系统语音", "system voice");
      return settings.enabled
        ? `${tx("已开启：", "On: ")}${name}${settings.livePriceEnabled ? ` · ${tx("定时价位播报", "Live price on")}` : ""}`
        : tx("已静音", "Muted");
    },
    paintVoiceSpeaking = () => {
      if (!status) return;
      if (isSpeaking && speakingLabel) {
        status.textContent = tx(
          `正在播报：${speakingLabel}`,
          `Speaking: ${speakingLabel}`,
        );
        status.classList.add("is-speaking-label");
      } else if (speakingLabel && settings.enabled) {
        status.textContent = tx(
          `已播报：${speakingLabel}`,
          `Spoke: ${speakingLabel}`,
        );
        status.classList.remove("is-speaking-label");
      } else {
        status.textContent = voiceStatusLine();
        status.classList.remove("is-speaking-label");
      }
    };
  edgeVoice.insertAdjacentHTML(
    "beforeend",
    '<optgroup data-voice-language="en" label="American English · Female"><option value="en-US-AvaNeural">Ava · American female</option><option value="en-US-EmmaNeural">Emma · American female</option><option value="en-US-AnaNeural">Ana · American female</option><option value="en-US-AriaNeural">Aria · American female</option><option value="en-US-JennyNeural">Jenny · American female</option><option value="en-US-MichelleNeural">Michelle · American female</option></optgroup><optgroup data-voice-language="en" label="American English · Male"><option value="en-US-AndrewNeural">Andrew · American male</option><option value="en-US-BrianNeural">Brian · American male</option><option value="en-US-ChristopherNeural">Christopher · American male</option><option value="en-US-EricNeural">Eric · American male</option><option value="en-US-GuyNeural">Guy · American male</option><option value="en-US-RogerNeural">Roger · American male</option><option value="en-US-SteffanNeural">Steffan · American male</option></optgroup>',
  );
  edgeVoice
    .querySelectorAll("optgroup:not([data-voice-language])")
    .forEach((group) => (group.dataset.voiceLanguage = "zh"));
  chimeVolume
    .closest("label")
    .insertAdjacentHTML(
      "beforebegin",
      `<label>${tx("默认提示音", "Default chime")}<select id="voiceChimeType">${Object.keys(chimePresets).map((key) => `<option value="${key}">${({ station: tx("车站三音", "Station three-tone"), airport: tx("机场登机", "Airport boarding"), gentle: tx("轻柔提示", "Gentle chime"), alert: tx("短促提醒", "Short alert"), rise: tx("上涨音", "Rising tone"), drop: tx("下跌音", "Falling tone"), warning: tx("警示音", "Warning"), siren: tx("警报器", "Siren"), critical: tx("紧急警报", "Critical alert") })[key]}</option>`).join("")}</select></label><label>${tx("上涨提示音", "Rise chime")}<select id="voiceRiseChimeType"></select></label><label>${tx("下跌提示音", "Drop chime")}<select id="voiceDropChimeType"></select></label><label>${tx("爆仓警示音", "Liquidation alert")}<select id="voiceLiquidationChimeType"></select></label>`,
    );
  const chimeType = $("voiceChimeType"),
    riseChimeType = $("voiceRiseChimeType"),
    dropChimeType = $("voiceDropChimeType"),
    liquidationChimeType = $("voiceLiquidationChimeType");
  [riseChimeType, dropChimeType, liquidationChimeType].forEach((select) => {
    select.innerHTML = chimeType.innerHTML;
  });
  chimeType.value = settings.chimeType;
  riseChimeType.value = settings.riseChimeType;
  dropChimeType.value = settings.dropChimeType;
  liquidationChimeType.value = settings.liquidationChimeType;
  const normalizeChimeType = (value, fallback) =>
    chimePresets[value] ? value : fallback;
  settings.chimeType = normalizeChimeType(settings.chimeType, "station");
  settings.riseChimeType = normalizeChimeType(settings.riseChimeType, "rise");
  settings.dropChimeType = normalizeChimeType(settings.dropChimeType, "drop");
  settings.liquidationChimeType = normalizeChimeType(
    settings.liquidationChimeType,
    "warning",
  );
  chimeVolume.max = "100";
  interval.innerHTML = `<option value="15">15 ${tx("秒", "sec")}</option><option value="30">30 ${tx("秒", "sec")}</option><option value="60">1 ${tx("分钟", "min")}</option><option value="300">5 ${tx("分钟", "min")}</option><option value="600">10 ${tx("分钟", "min")}</option><option value="900">15 ${tx("分钟", "min")}</option><option value="1800">30 ${tx("分钟", "min")}</option><option value="3600">1 ${tx("小时", "hour")}</option>`;
  panel.querySelector(".voice-rule-note").textContent = tx(
    "语音规则独立保存，可设置价格达到、上涨或下跌后的单次／重复播报。首页保持打开时即由浏览器监听并播报，无需打开本设置面板；关闭页面或电脑重启后停止播报。重复播报的冷却下限为 30 秒。",
    "Voice rules are independent and support one-time or repeated reached, rise and fall alerts. They monitor and speak while the home page is open; this settings panel does not need to remain open. Speech stops after the page closes or the computer restarts. Repeated alerts cool down at least 30 seconds.",
  );
  const populateVoices = () => {
    if (!supported) return;
    voices = window.speechSynthesis.getVoices();
    const preferred = voices.filter((voice) => /^zh/i.test(voice.lang)),
      items = preferred.length ? preferred : voices;
    if (!items.length) return;
    const chosen = items.some((voice) => voice.voiceURI === settings.voiceURI)
      ? settings.voiceURI
      : (
          items.find((voice) =>
            /Ting-Ting|Mei-Jia|Sin-Ji|Xiaoxiao|Xiaoyi/i.test(voice.name),
          ) || items[0]
        ).voiceURI;
    settings.voiceURI = chosen;
    voiceSelect.innerHTML = items
      .map(
        (voice) =>
          `<option value="${voice.voiceURI}">${voice.name} · ${voice.lang}</option>`,
      )
      .join("");
    voiceSelect.value = chosen;
    save();
    render();
  };
  const filterEdgeVoices = () => {
    const desired = uiLang === "en" ? "en" : "zh";
    edgeVoice.querySelectorAll("optgroup").forEach((group) => {
      const visible = group.dataset.voiceLanguage === desired;
      group.hidden = !visible;
      group.querySelectorAll("option").forEach((option) => {
        option.hidden = !visible;
        option.disabled = !visible;
      });
    });
    const selected = [...edgeVoice.options].find(
      (option) => option.value === settings.edgeVoice,
    );
    if (
      !selected ||
      selected.parentElement?.dataset.voiceLanguage !== desired
    ) {
      settings.edgeVoice =
        [...edgeVoice.options].find(
          (option) => option.parentElement?.dataset.voiceLanguage === desired,
        )?.value || settings.edgeVoice;
      save();
    }
    edgeVoice.value = settings.edgeVoice;
  };
  const formatLastSpokenAt = (ts) => {
    if (!ts) return tx("从未", "Never");
    const date = new Date(ts);
    const now = new Date();
    const sameDay =
      date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate();
    const timeStr = date.toLocaleTimeString(uiLang === "zh" ? "zh-CN" : "en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    if (sameDay) return timeStr;
    const dateStr = date.toLocaleDateString(uiLang === "zh" ? "zh-CN" : "en-US", {
      month: "short",
      day: "numeric",
    });
    return uiLang === "zh" ? `${dateStr} ${timeStr}` : `${dateStr}, ${timeStr}`;
  };
  const render = () => {
    enabled.checked = Boolean(settings.enabled);
    livePriceEnabled.checked = Boolean(settings.livePriceEnabled);
    livePriceConcise.checked = Boolean(settings.livePriceConcise);
    engine.value = settings.engine;
    edgeVoice.value = settings.edgeVoice;
    interval.value = String(settings.interval);
    lastSpokenAtLabel.textContent = `${tx("上次播报：", "Last spoken: ")}${formatLastSpokenAt(settings.lastSpokenAt)}`;
    chimeType.value = settings.chimeType;
    riseChimeType.value = settings.riseChimeType;
    dropChimeType.value = settings.dropChimeType;
    liquidationChimeType.value = settings.liquidationChimeType;
    settings.chimeVolume = Math.max(0, Math.min(100, Number(settings.chimeVolume) || 0));
    chimeVolume.value = String(settings.chimeVolume);
    speechVolume.value = String(settings.speechVolume);
    const paintRange = (input) => {
      const minimum = Number(input.min) || 0;
      const maximum = Number(input.max) || 100;
      const value = Math.max(minimum, Math.min(maximum, Number(input.value) || 0));
      input.style.setProperty(
        "--voice-range-fill",
        `${((value - minimum) / (maximum - minimum || 1)) * 100}%`,
      );
    };
    paintRange(chimeVolume);
    paintRange(speechVolume);
    chimeVolumeValue.value = `${settings.chimeVolume}%`;
    chimeVolumeValue.textContent = `${settings.chimeVolume}%`;
    speechVolumeValue.value = `${settings.speechVolume}%`;
    speechVolumeValue.textContent = `${settings.speechVolume}%`;
    panel.classList.toggle("is-enabled", Boolean(settings.enabled));
    /* 定时播报关闭时，播报间隔一并置灰，避免“调了却不生效”的困惑。 */
    interval.disabled = !settings.livePriceEnabled;
    livePriceConcise.disabled = !settings.livePriceEnabled;
    panel.classList.toggle("uses-edge", settings.engine === "edge");
    /* 状态行文字统一由 paintVoiceSpeaking 决定（含「正在播报/已播报」态）。 */
    setSpeaking(isSpeaking);
  };
  const speakPrice = (force) => {
    const current = state?.ticker?.last,
      now = Date.now();
    if (
      !Number.isFinite(current) ||
      !settings.enabled ||
      !settings.livePriceEnabled
    )
      return;
    if (
      force ||
      now - settings.lastSpokenAt >= Number(settings.interval) * 1000
    ) {
      const chimeType =
        !Number.isFinite(lastLiveSpokenPrice) || current === lastLiveSpokenPrice
          ? settings.chimeType
          : current > lastLiveSpokenPrice
            ? settings.riseChimeType
            : settings.dropChimeType;
      /* 精简版：只报「当前实时价 76287.5」这类播报语，不带持仓对比。 */
      const spokenText = settings.livePriceConcise
        ? concisePriceText(current)
        : priceText(current);
      if (
        enqueueSpeech(
          spokenText,
          {
            chimeType,
            label: tx("定时播报实时价", "Timed live price"),
          },
          speechRankOfKey("live"),
        )
      ) {
        settings.lastSpokenAt = now;
        lastLiveSpokenPrice = current;
        save();
        lastSpokenAtLabel.textContent = `${tx("上次播报：", "Last spoken: ")}${formatLastSpokenAt(settings.lastSpokenAt)}`;
      }
    }
  };
  enabled.onchange = () => {
    settings.enabled = enabled.checked;
    settings.lastSpokenAt = 0;
    save();
    render();
    syncVoiceToServer();
    if (settings.enabled) primeAudioContext();
  };
  livePriceEnabled.onchange = () => {
    settings.livePriceEnabled = livePriceEnabled.checked;
    settings.lastSpokenAt = 0;
    save();
    render();
    syncVoiceToServer();
    if (settings.enabled && settings.livePriceEnabled) {
      primeAudioContext();
      speakPrice(true);
    }
  };
  /* 精简版只影响本地播报文本格式，无需同步服务端。 */
  livePriceConcise.onchange = () => {
    settings.livePriceConcise = livePriceConcise.checked;
    save();
    render();
    if (settings.enabled && settings.livePriceEnabled) {
      primeAudioContext();
      speakPrice(true);
    }
  };
  engine.onchange = () => {
    settings.engine = engine.value;
    save();
    render();
  };
  edgeVoice.onchange = () => {
    settings.edgeVoice = edgeVoice.value;
    save();
    render();
    syncVoiceToServer();
  };
  interval.onchange = () => {
    settings.interval = Math.max(15, Number(interval.value) || 60);
    save();
    render();
  };
  let lastChimePreviewAt = 0,
    pendingChimePreview = null;
  const previewChimeVolume = () => {
    const minimumGap = 550,
      wait = minimumGap - (Date.now() - lastChimePreviewAt),
      play = () => {
        pendingChimePreview = null;
        lastChimePreviewAt = Date.now();
        // Three short notes make the current slider volume immediately audible.
        playChime();
      };
    if (wait <= 0) play();
    else if (!pendingChimePreview) pendingChimePreview = window.setTimeout(play, wait);
  };
  chimeVolume.oninput = () => {
    settings.chimeVolume = Math.max(0, Math.min(100, Number(chimeVolume.value) || 0));
    save();
    render();
    previewChimeVolume();
  };
  chimeType.onchange = () => {
    settings.chimeType = chimeType.value;
    save();
    render();
    playChime(settings.chimeType);
  };
  riseChimeType.onchange = () => {
    settings.riseChimeType = riseChimeType.value;
    save();
    render();
    playChime(settings.riseChimeType);
  };
  dropChimeType.onchange = () => {
    settings.dropChimeType = dropChimeType.value;
    save();
    render();
    playChime(settings.dropChimeType);
  };
  liquidationChimeType.onchange = () => {
    settings.liquidationChimeType = liquidationChimeType.value;
    save();
    render();
    playChime(settings.liquidationChimeType);
  };
  speechVolume.oninput = () => {
    settings.speechVolume = Number(speechVolume.value);
    save();
    render();
  };
  voiceSelect.onchange = () => {
    settings.voiceURI = voiceSelect.value;
    save();
    render();
  };
  const showVoiceSettings = (open) => {
    settingsModal.hidden = !open;
    trigger.setAttribute("aria-expanded", String(open));
    if (open) render();
  };
  const primeAudioContext = () => {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return;
    audioContext ||= new Context();
    audioContext.resume?.().catch(() => {});
    const silent = audioContext.createGain();
    silent.gain.value = 0;
    silent.connect(audioContext.destination);
    try {
      const oscillator = audioContext.createOscillator();
      oscillator.frequency.value = 1;
      oscillator.connect(silent);
      oscillator.start();
      oscillator.stop(audioContext.currentTime + 0.001);
    } catch {}
  };
  trigger.onclick = () => {
    // 只打开设置面板，不自动开启语音总开关；
    // 是否启用由面板内的「语音总开关」控制。
    primeAudioContext();
    showVoiceSettings(true);
  };
  settingsModal.querySelector("[data-close-voice-settings]").onclick = () =>
    showVoiceSettings(false);
  settingsModal.onclick = (event) => {
    if (event.target === settingsModal) showVoiceSettings(false);
  };
  test.onclick = () => {
    primeAudioContext();
    // The previous check accidentally disabled the selected Edge engine on
    // browsers that lack local speechSynthesis, even though Edge TTS works
    // through our audio endpoint.  Only the system-voice option needs it.
    if (settings.engine === "system" && !supported) {
      status.textContent = tx(
        "当前浏览器不支持语音",
        "Speech is unavailable in this browser",
      );
      return;
    }
    const current = state?.ticker?.last;
    if (!Number.isFinite(current)) {
      status.textContent = tx("实时价格尚未加载", "Live price is not loaded");
      return;
    }
    /* 试听也尊重「精简版」开关：开启时只报「当前实时价 76287.5」这句播报语。 */
    const previewText = settings.livePriceConcise
      ? concisePriceText(current)
      : priceText(current);
    const wasEnabled = settings.enabled;
    settings.enabled = true;
    say(previewText, {
      onStarted: () => {
        status.textContent = tx("正在播放试听", "Playing test");
      },
      onFailure: () => {
        status.textContent = tx(
          "试听失败：请检查本机音量，或切换为本机系统语音后重试。",
          "Test failed: check local volume or switch to system voice and try again.",
        );
      },
    });
    settings.enabled = wasEnabled;
    status.textContent = tx("正在连接语音服务…", "Connecting to voice service…");
  };
  $("voiceAlertAddRule").onclick = () => $("openLocalAlert")?.click();
  /* 多币种（v2.12.5）：语音规则按币种独立存储 —— BTC 沿用旧键保留历史数据，
     其余币种各用 btc_voice_alert_rules_v1_<COIN>；没设置过的币种就是空，不借 BTC 的规则。 */
  const voiceRuleStoreKey = () =>
    "btc_voice_alert_rules_v1" + coinStorageSuffix();
  const loadVoiceRulesFromStorage = () => {
    try {
      const stored = JSON.parse(localStorage.getItem(voiceRuleStoreKey()) || "[]");
      if (!Array.isArray(stored)) return [];
      return stored
        .filter((rule) => rule && rule.id && Number(rule.targetPrice) > 0)
        .slice(0, 30)
        .map((rule) => ({
          ...rule,
          kind: [
            "price_reached",
            "price_above",
            "price_below",
            "long_liquidation",
            "short_liquidation",
            "price_move",
            "price_speed",
            "price_tick_move",
            "theoretical_liquidation_gap",
          ].includes(rule.kind)
            ? rule.kind
            : "price_reached",
          direction: ["down", "both"].includes(rule.direction)
            ? rule.direction
            : "up",
          positionSide: rule.positionSide === "short" ? "short" : "long",
          anchorPrice: Number(rule.anchorPrice) || null,
          windowSeconds: Math.min(
            60,
            Math.max(1, Number(rule.windowSeconds) || 3),
          ),
          repeat: Boolean(rule.repeat),
          cooldownMinutes: Math.max(0, Number(rule.cooldownMinutes) || 0),
        }));
    } catch {
      return [];
    }
  };
  let voiceRules = loadVoiceRulesFromStorage(),
    voicePrevious = null,
    voicePriceHistory = [],
    voiceRuleEditingId = null;
  const saveVoiceRules = () => {
    localStorage.setItem(voiceRuleStoreKey(), JSON.stringify(voiceRules));
    /* 同步页面设置供状态恢复；服务端不执行关闭页面后的接力播报。 */
    syncVoiceToServer();
  };
  const syncVoiceToServer = () => {
    fetch("/api/voice/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        symbol: activeCoin(),
        settings: {
          enabled: Boolean(settings.enabled),
          livePriceEnabled: Boolean(settings.livePriceEnabled),
          interval: Number(settings.interval),
          voice: settings.edgeVoice,
        },
        personalEntries: Array.isArray(window.btcPersonalEntries)
          ? window.btcPersonalEntries
          : [],
        rules: voiceRules.map(({ satisfied, ...rule }) => rule),
      }),
    }).catch(() => {});
  };
  window.addEventListener("btc:personal-entries-changed", syncVoiceToServer);
  /* 心跳仅用于页面会话状态；心跳停止后服务端不会接力播报。 */
  setInterval(() => {
    if (settings.enabled)
      fetch("/api/voice/heartbeat", { method: "POST" }).catch(() => {});
  }, 5_000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && settings.enabled)
      fetch("/api/voice/heartbeat", { method: "POST" }).catch(() => {});
  });
  /* 读取已保存状态以便在当前页面恢复规则显示。 */
  setInterval(() => {
    fetch("/api/voice/state")
      .then((response) => response.json())
      .then((remoteState) => {
        let changed = false;
        for (const remote of remoteState?.rules || []) {
          const rule = voiceRules.find((item) => item.id === remote.id);
          if (
            rule &&
            remote.lastTriggeredAt &&
            rule.lastTriggeredAt !== remote.lastTriggeredAt
          ) {
            rule.lastTriggeredAt = remote.lastTriggeredAt;
            changed = true;
          }
        }
        if (changed) {
          localStorage.setItem(voiceRuleStoreKey(), JSON.stringify(voiceRules));
          renderVoiceRules();
        }
      })
      .catch(() => {});
  }, 10_000);
  /* 多币种：切换币种时重读该币种自己的语音规则，并重置价格基准与短窗历史
     （跨币种价格量级差异巨大，沿用旧基准会把切换瞬间当成暴涨暴跌误触发）。 */
  window.addEventListener("btc:coin-changed", () => {
    voiceRules = loadVoiceRulesFromStorage();
    voicePrevious = null;
    voicePriceHistory = [];
    voiceRuleEditingId = null;
    renderVoiceRules();
    syncVoiceToServer();
  });
  const voiceRuleName = (kind, direction, positionSide = "long") =>
    ({
      price_reached: tx("价格达到", "Price reached"),
      price_above: tx("价格上涨至", "Price rises to"),
      price_below: tx("价格下跌至", "Price falls to"),
      long_liquidation: tx("做多爆仓价", "Long liquidation"),
      short_liquidation: tx("做空爆仓价", "Short liquidation"),
      price_move:
        direction === "both"
          ? tx("每上涨或下跌", "Every rise or drop of")
          : direction === "down"
            ? tx("每下跌", "Every drop of")
            : tx("每上涨", "Every rise of"),
      price_speed:
        direction === "both"
          ? tx("短时急涨／急跌", "Rapid move")
          : direction === "down"
            ? tx("短时急跌", "Rapid drop")
            : tx("短时急涨", "Rapid rise"),
      price_tick_move:
        direction === "both"
          ? tx("较前一次报价变动", "Difference from previous quote")
          : direction === "down"
            ? tx("较前一次报价下跌", "Drop since previous quote")
            : tx("较前一次报价上涨", "Rise since previous quote"),
      theoretical_liquidation_gap:
        positionSide === "short"
          ? tx("距做空理论强平价", "Distance from short theoretical liquidation")
          : tx("距做多理论强平价", "Distance from long theoretical liquidation"),
    })[kind] || tx("价格达到", "Price reached");
  const voiceRuleList = document.createElement("section");
  voiceRuleList.className = "voice-rule-list";
  voicePanelGrid.append(voiceRuleList);
  /* 左／中／右三栏宽度自由拖拽：拖动分隔条调节，宽度本地记忆，双击复位。 */
  const columnStore = "btc_voice_panel_columns_v1",
    columnDefaults = { left: 200, mid: 208 },
    columnMin = { left: 150, mid: 150, right: 210 },
    columnGap = 8,
    columnResizer = 8,
    panelColumns = { ...columnDefaults };
  try {
    Object.assign(
      panelColumns,
      JSON.parse(localStorage.getItem(columnStore) || "{}"),
    );
  } catch {}
  const saveColumns = () =>
      localStorage.setItem(columnStore, JSON.stringify(panelColumns)),
    applyColumns = () => {
      voicePanelGrid.style.setProperty(
        "--voice-col-left",
        `${Math.round(panelColumns.left)}px`,
      );
      voicePanelGrid.style.setProperty(
        "--voice-col-mid",
        `${Math.round(panelColumns.mid)}px`,
      );
    },
    clampColumns = () => {
      const total =
        voicePanelGrid.getBoundingClientRect().width ||
        voicePanelGrid.parentElement?.getBoundingClientRect().width ||
        0;
      const usable =
        total - columnGap * 4 - columnResizer * 2 - columnMin.right;
      if (usable < columnMin.left + columnMin.mid) return;
      panelColumns.left = Math.max(
        columnMin.left,
        Math.min(panelColumns.left, usable - columnMin.mid),
      );
      panelColumns.mid = Math.max(
        columnMin.mid,
        Math.min(panelColumns.mid, usable - panelColumns.left),
      );
    },
    setColumns = (left, mid) => {
      panelColumns.left = left;
      panelColumns.mid = mid;
      clampColumns();
      applyColumns();
    };
  const makeResizer = (key) => {
    const resizer = document.createElement("div");
    resizer.className = "voice-grid-resizer";
    resizer.dataset.resize = key;
    resizer.setAttribute("role", "separator");
    resizer.setAttribute("aria-orientation", "vertical");
    resizer.tabIndex = 0;
    resizer.title = tx(
      "拖动调节左右栏宽度，双击恢复默认",
      "Drag to resize columns, double-click to reset",
    );
    return resizer;
  };
  /* 注意 :scope > ——「配置语音规则/试听」那块也带 .voice-panel-group 类，
     但它嵌套在左栏内部；不限直接子元素会匹配到它导致 insertBefore 抛错，
     整个语音模块初始化中断（规则列表变空白）。 */
  const engineGroup = voicePanelGrid.querySelector(
      ":scope > .voice-panel-group:not(.voice-panel-toggles)",
    ),
    leftResizer = makeResizer("left"),
    midResizer = makeResizer("mid");
  voicePanelGrid.insertBefore(leftResizer, engineGroup || voiceRuleList);
  voicePanelGrid.insertBefore(midResizer, voiceRuleList);
  [leftResizer, midResizer].forEach((resizer) => {
    const isLeft = resizer.dataset.resize === "left";
    resizer.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      resizer.setPointerCapture?.(event.pointerId);
      resizer.classList.add("is-dragging");
      document.body.classList.add("voice-grid-resizing");
      const startX = event.clientX,
        startLeft = panelColumns.left,
        startMid = panelColumns.mid;
      const onMove = (moveEvent) => {
          const delta = moveEvent.clientX - startX;
          if (isLeft) setColumns(startLeft + delta, startMid);
          else setColumns(startLeft, startMid + delta);
        },
        onUp = () => {
          resizer.releasePointerCapture?.(event.pointerId);
          resizer.classList.remove("is-dragging");
          document.body.classList.remove("voice-grid-resizing");
          resizer.removeEventListener("pointermove", onMove);
          resizer.removeEventListener("pointerup", onUp);
          resizer.removeEventListener("pointercancel", onUp);
          saveColumns();
        };
      resizer.addEventListener("pointermove", onMove);
      resizer.addEventListener("pointerup", onUp);
      resizer.addEventListener("pointercancel", onUp);
    });
    resizer.addEventListener("keydown", (event) => {
      const step =
        event.key === "ArrowLeft" ? -12 : event.key === "ArrowRight" ? 12 : 0;
      if (!step) return;
      event.preventDefault();
      if (isLeft) setColumns(panelColumns.left + step, panelColumns.mid);
      else setColumns(panelColumns.left, panelColumns.mid + step);
      saveColumns();
    });
    resizer.addEventListener("dblclick", () => {
      setColumns(columnDefaults.left, columnDefaults.mid);
      saveColumns();
    });
  });
  const resyncColumns = () => {
    clampColumns();
    applyColumns();
  };
  if ("ResizeObserver" in window)
    new ResizeObserver(resyncColumns).observe(voicePanelGrid);
  else window.addEventListener("resize", resyncColumns);
  resyncColumns();
  const cooldownText = (value) => {
    const minutes = Number(value) || 0;
    if (minutes === 0) return tx("不冷却", "No cooldown");
    const duration =
      minutes === 0.5
        ? `30 ${tx("秒", "sec")}`
        : `${minutes} ${tx("分钟", "min")}`;
    return `${tx("冷却", "Cooldown")} ${duration}`;
  };
  const voiceRuleSpeechState = (rule) =>
    rule.lastTriggeredAt
      ? tx("等待下次播报", "Waiting for next alert")
      : tx("待触发", "Armed");
  const voiceRuleSpeechTitle = (rule) =>
    rule.lastTriggeredAt
      ? tx("此规则最近已触发播报；重复规则仍会继续监听。", "This rule has spoken recently; repeating rules remain armed.")
      : tx("此规则正在等待触发。", "This rule is armed and waiting to trigger.");
  const renderVoiceRules = () => {
    const rows = voiceRules
      .map(
        (rule) =>
          "<article" +
          (!rule.repeat && rule.lastTriggeredAt ? ' class="is-done"' : "") +
          '><span><b>' +
          voiceRuleName(rule.kind, rule.direction, rule.positionSide) +
          " " +
          Number(rule.targetPrice).toLocaleString("en-US", {
            maximumFractionDigits: 2,
          }) +
          "</b><small>" +
          (rule.kind === "price_move"
            ? tx(
                "以保存时的市价为起点；每次播报后重新计量。",
                "Starts from the saved market price and measures again after each alert. ",
              )
            : rule.kind === "price_speed"
              ? tx(
                  "在 " + rule.windowSeconds + " 秒观察窗口内触发。",
                  "Triggers within a " +
                    rule.windowSeconds +
                    " second window. ",
                )
              : rule.kind === "price_tick_move"
                ? tx(
                    "与连续收到的前一次报价比较。",
                    "Compares with the immediately previous received quote. ",
                  )
                : "") +
          (rule.repeat
            ? "重复播报 · " + cooldownText(rule.cooldownMinutes)
            : "仅播报一次") +
          (rule.lastTriggeredAt
            ? (rule.repeat
              ? " · 上次播报 "
              : " · 已播报 ") +
              new Date(rule.lastTriggeredAt).toLocaleTimeString("zh-CN", {
                hour12: false,
              })
            : "") +
          '</small></span><em class="' +
          (rule.lastTriggeredAt ? "muted" : "bull") +
          '" title="' +
          voiceRuleSpeechTitle(rule) +
          '">' +
          voiceRuleSpeechState(rule) +
          '</em><button type="button" class="rule-test" data-test-voice-rule="' +
          rule.id +
          '">测试触发</button><button type="button" class="rule-edit" data-edit-voice-rule="' +
          rule.id +
          '">编辑</button><button type="button" class="rule-remove" data-remove-voice-rule="' +
          rule.id +
          '">删除</button></article>',
      )
      .join("");
    voiceRuleList.innerHTML =
      "<div><b>" +
      tx("语音规则", "Voice rules") +
      "</b><small>" +
      tx(
        "首页保持打开时即由浏览器播报，无需打开本设置面板；页面关闭或电脑重启后停止播报。",
        "Speech runs while the home page is open; this settings panel does not need to remain open. It stops after the page closes or the computer restarts.",
      ) +
      "</small></div>" +
      (voiceRules.length
        ? '<div class="notification-rule-list">' + rows + "</div>"
        : "<small>" +
          tx("尚未配置语音规则。", "No voice rules configured.") +
          "</small>");
    voiceRuleList.querySelectorAll("[data-edit-voice-rule]").forEach(
      (button) =>
        (button.onclick = () =>
          showVoiceRuleModal(
            true,
            voiceRules.find((rule) => rule.id === button.dataset.editVoiceRule),
          )),
    );
    voiceRuleList.querySelectorAll("[data-test-voice-rule]").forEach(
      (button) =>
        (button.onclick = () => {
          const rule = voiceRules.find(
            (item) => item.id === button.dataset.testVoiceRule,
          );
          if (rule) testVoiceRule(rule);
        }),
    );
    voiceRuleList.querySelectorAll("[data-remove-voice-rule]").forEach(
      (button) =>
        (button.onclick = () => {
          voiceRules = voiceRules.filter(
            (rule) => rule.id !== button.dataset.removeVoiceRule,
          );
          saveVoiceRules();
          renderVoiceRules();
        }),
    );
  };
  const voiceRuleModal = document.createElement("div");
  voiceRuleModal.className = "alert-composer voice-rule-composer";
  voiceRuleModal.hidden = true;
  voiceRuleModal.innerHTML = `<section><header><b>${tx("配置语音规则", "Configure voice rule")}</b><button type="button" data-close-voice-rule>×</button></header><p class="alert-symbol">◉ <b>${tx("语音播报预警", "Voice alert")}</b></p><form id="voiceRuleForm"><label>${tx("播报条件", "Condition")}<select name="kind"><option value="price_reached">${tx("价格达到", "Price reached")}</option><option value="price_above">${tx("价格上涨至", "Price rises to")}</option><option value="price_below">${tx("价格下跌至", "Price falls to")}</option><option value="long_liquidation">${tx("做多爆仓价", "Long liquidation")}</option><option value="short_liquidation">${tx("做空爆仓价", "Short liquidation")}</option><option value="price_move">${tx("每上涨／下跌指定金额", "Every move by amount")}</option><option value="price_speed">${tx("短时间急涨／急跌", "Rapid move in a short window")}</option><option value="price_tick_move">${tx("与前一次报价变动差", "Difference from previous quote")}</option></select></label><label id="voiceRuleDirection" hidden>${tx("变动方向", "Move direction")}<select name="direction"><option value="up">${tx("上涨", "Up")}</option><option value="down">${tx("下跌", "Down")}</option><option value="both">${tx("上涨或下跌", "Up or down")}</option></select></label><label id="voiceRuleWindow" hidden>${tx("观察窗口", "Time window")}<input name="windowSeconds" type="number" inputmode="numeric" min="1" max="60" step="1" value="3"><em>${tx("秒", "sec")}</em></label><label><span id="voiceRuleTargetLabel">${tx("目标价格", "Target price")}</span><input name="target" type="number" inputmode="decimal" min="0" step="0.01" required placeholder="80000"><em id="voiceRuleTargetUnit">USDT</em></label><label>${tx("播报方式", "Playback")}<select name="repeat"><option value="once">${tx("仅播报一次", "Speak once")}</option><option value="repeat">${tx("重复播报", "Repeat")}</option></select></label><label id="voiceRuleCooldown" hidden>${tx("冷却时间", "Cooldown")}<select name="cooldown"><option value="0">${tx("不冷却", "No cooldown")}</option><option value="0.5">30 ${tx("秒", "sec")}</option><option value="1">1 ${tx("分钟", "min")}</option><option value="5">5 ${tx("分钟", "min")}</option><option value="10">10 ${tx("分钟", "min")}</option><option value="30">30 ${tx("分钟", "min")}</option></select></label><button class="alert-submit">${tx("保存语音规则", "Save voice rule")}</button></form></section>`;
  document.body.append(voiceRuleModal);
  voiceRuleModal
    .querySelector(".alert-symbol")
    .insertAdjacentHTML(
      "afterend",
      '<section id="voiceEntrySummary" class="voice-entry-summary"><div><b>市价</b><strong>--</strong></div><div class="voice-entry-values"></div></section>',
    );
  voiceRuleModal
    .querySelector('[name="kind"]')
    .insertAdjacentHTML(
      "beforeend",
      `<option value="theoretical_liquidation_gap">${tx("距理论强平价警告", "Theoretical liquidation distance")}</option>`,
    );
  voiceRuleModal
    .querySelector('[name="direction"]')
    .closest("label")
    .insertAdjacentHTML(
      "afterend",
      `<label id="voiceRulePositionSide" hidden>${tx("持仓方向", "Position side")}<select name="positionSide"><option value="long">${tx("做多", "Long")}</option><option value="short">${tx("做空", "Short")}</option></select></label>`,
    );
  const voiceRuleForm = voiceRuleModal.querySelector("#voiceRuleForm"),
    voiceRuleCooldown = voiceRuleModal.querySelector("#voiceRuleCooldown"),
    voiceRuleDirection = voiceRuleModal.querySelector("#voiceRuleDirection"),
    voiceRulePositionSide = voiceRuleModal.querySelector(
      "#voiceRulePositionSide",
    ),
    voiceRuleWindow = voiceRuleModal.querySelector("#voiceRuleWindow"),
    voiceEntrySummary = voiceRuleModal.querySelector("#voiceEntrySummary"),
    voiceRuleTargetLabel = voiceRuleModal.querySelector(
      "#voiceRuleTargetLabel",
    ),
    voiceRuleTargetUnit = voiceRuleModal.querySelector("#voiceRuleTargetUnit"),
    voiceRuleSubmit = voiceRuleModal.querySelector(".alert-submit");
  const theoreticalLiquidation = (side) => {
    const entry = (
      Array.isArray(window.btcPersonalEntries)
        ? window.btcPersonalEntries
        : typeof personalEntries !== "undefined"
          ? personalEntries
          : []
    ).find((item) => item?.side === side && Number(item?.price) > 0);
    if (!entry) return null;
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
    return side === "short"
      ? price * (1 + 1 / effectiveLeverage - 0.005)
      : price * (1 - 1 / effectiveLeverage + 0.005);
  };
  const updateVoiceEntrySummary = () => {
    const current = Number(state?.ticker?.last),
      entries = (
        Array.isArray(window.btcPersonalEntries)
          ? window.btcPersonalEntries
          : typeof personalEntries !== "undefined"
            ? personalEntries
            : []
      ).filter(
        (entry) =>
          Number.isFinite(Number(entry?.price)) && Number(entry.price) > 0,
      );
    voiceEntrySummary.querySelector("b").textContent = tx(
      "市价",
      "Market price",
    );
    voiceEntrySummary.querySelector("strong").textContent = Number.isFinite(
      current,
    )
      ? current.toLocaleString("en-US", { maximumFractionDigits: 2 })
      : "--";
    voiceEntrySummary.querySelector(".voice-entry-values").innerHTML = entries
      .map((entry) => {
        const side = entry.side === "short" ? "short" : "long",
          liquidation = theoreticalLiquidation(side),
          entryText =
            side === "short"
              ? tx("做空买入价", "Short entry price")
              : tx("做多买入价", "Long entry price"),
          liqText =
            side === "short"
              ? tx("做空理论强平价", "Short theoretical liquidation")
              : tx("做多理论强平价", "Long theoretical liquidation");
        return `<span class="${side}">${entryText} <b>${Number(entry.price).toLocaleString("en-US", { maximumFractionDigits: 2 })}</b></span>${Number.isFinite(liquidation) ? `<button type="button" class="voice-theoretical-liquidation ${side}" data-voice-theoretical-liquidation="${side}" title="${tx("带入为爆仓价格规则", "Use as liquidation-price rule")}">${liqText} <b>${liquidation.toLocaleString("en-US", { maximumFractionDigits: 2 })}</b></button>` : ""}`;
      })
      .join("");
    voiceEntrySummary
      .querySelectorAll("[data-voice-theoretical-liquidation]")
      .forEach((button) => {
        button.onclick = () => {
          const side = button.dataset.voiceTheoreticalLiquidation,
            liquidation = theoreticalLiquidation(side);
          if (!Number.isFinite(liquidation)) return;
          voiceRuleForm.elements.kind.value =
            side === "short" ? "short_liquidation" : "long_liquidation";
          voiceRuleForm.elements.target.value = liquidation.toFixed(2);
          syncVoiceRuleForm();
        };
      });
  };
  const useVoiceMarketPrice = () => {
    if (
      [
        "price_move",
        "price_speed",
        "price_tick_move",
        "theoretical_liquidation_gap",
      ].includes(
        voiceRuleForm.elements.kind.value,
      )
    )
      return;
    const current = Number(state?.ticker?.last);
    if (Number.isFinite(current))
      voiceRuleForm.elements.target.value = current.toFixed(2);
  };
  voiceEntrySummary.querySelector("strong").title = tx(
    "点击填入目标价格",
    "Click to use as target price",
  );
  voiceEntrySummary.querySelector("strong").tabIndex = 0;
  voiceEntrySummary.querySelector("strong").onclick = useVoiceMarketPrice;
  voiceEntrySummary.querySelector("strong").onkeydown = (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      useVoiceMarketPrice();
    }
  };
  const syncVoiceRuleForm = () => {
    const kind = voiceRuleForm.elements.kind.value,
      move = kind === "price_move",
      speed = kind === "price_speed",
      tick = kind === "price_tick_move",
      theoreticalGap = kind === "theoretical_liquidation_gap",
      relative = move || speed || tick;
    if (relative && voiceRuleForm.elements.repeat.value === "once")
      voiceRuleForm.elements.repeat.value = "repeat";
    voiceRuleDirection.hidden = !relative;
    voiceRulePositionSide.hidden = !theoreticalGap;
    voiceRuleWindow.hidden = !speed;
    voiceRuleCooldown.hidden = voiceRuleForm.elements.repeat.value !== "repeat";
    voiceRuleTargetLabel.textContent = relative
      ? tx("涨跌金额", "Move amount")
      : theoreticalGap
        ? tx("距理论强平价的警戒差额", "Warning distance from theoretical liquidation")
      : kind.includes("liquidation")
        ? tx("爆仓价格", "Liquidation price")
        : tx("目标价格", "Target price");
    voiceRuleTargetUnit.textContent = "USDT";
    voiceRuleForm.elements.target.placeholder = speed
      ? "500"
      : relative
        ? "100"
        : theoreticalGap
          ? "500"
        : kind.includes("liquidation")
          ? "75000"
          : "80000";
    voiceEntrySummary.querySelector("strong").title = theoreticalGap
      ? tx(
          "系统会实时重算所选持仓的理论强平价；填写距强平价的警戒差额，例如 500。",
          "The app recalculates the selected position's theoretical liquidation price; enter a warning distance, e.g. 500.",
        )
      : relative
      ? speed
        ? tx(
            "此规则比较当前价格与设定秒数前的价格；填写涨跌金额，例如 500。",
            "This rule compares the current price with the price from the selected number of seconds ago; enter a move amount, e.g. 500.",
          )
        : tick
          ? tx(
              "此规则比较当前价格与本页连续收到的前一次报价；填写差额，例如 100。",
              "This rule compares the current price with the immediately previous quote received on this page; enter a difference, e.g. 100.",
            )
          : tx(
              "此规则保存时自动采用市价作为基准；此处填写涨跌金额，例如 100。",
              "This rule uses the market price at save time as its baseline; enter a move amount here, e.g. 100.",
            )
      : tx("点击填入目标价格", "Click to use as target price");
  };
  const showVoiceRuleModal = (open, rule = null) => {
    voiceRuleModal.hidden = !open;
    if (!open) {
      voiceRuleEditingId = null;
      return;
    }
    voiceRuleForm.reset();
    voiceRuleEditingId = rule?.id || null;
    if (rule) {
      voiceRuleForm.elements.kind.value = rule.kind;
      voiceRuleForm.elements.direction.value = rule.direction || "up";
      voiceRuleForm.elements.positionSide.value =
        rule.positionSide === "short" ? "short" : "long";
      voiceRuleForm.elements.target.value = rule.targetPrice;
      voiceRuleForm.elements.windowSeconds.value = rule.windowSeconds || 3;
      voiceRuleForm.elements.repeat.value = rule.repeat ? "repeat" : "once";
      voiceRuleForm.elements.cooldown.value = rule.cooldownMinutes || 0;
    }
    voiceRuleSubmit.textContent = rule
      ? tx("保存修改", "Save changes")
      : tx("保存语音规则", "Save voice rule");
    syncVoiceRuleForm();
    updateVoiceEntrySummary();
  };
  voiceRuleModal.querySelector("[data-close-voice-rule]").onclick = () =>
    showVoiceRuleModal(false);
  voiceRuleModal.onclick = (event) => {
    if (event.target === voiceRuleModal) showVoiceRuleModal(false);
  };
  voiceRuleForm.elements.repeat.onchange = () => {
    voiceRuleCooldown.hidden = voiceRuleForm.elements.repeat.value !== "repeat";
  };
  voiceRuleForm.elements.kind.onchange = syncVoiceRuleForm;
  voiceRuleForm.onsubmit = (event) => {
    event.preventDefault();
    const targetPrice = Number(voiceRuleForm.elements.target.value),
      kind = voiceRuleForm.elements.kind.value,
      repeat = voiceRuleForm.elements.repeat.value === "repeat",
      cooldownMinutes = repeat
        ? Math.max(0, Number(voiceRuleForm.elements.cooldown.value) || 0)
        : 0,
      windowSeconds = Math.min(
        60,
        Math.max(1, Number(voiceRuleForm.elements.windowSeconds.value) || 3),
      ),
      existing = voiceRules.find((rule) => rule.id === voiceRuleEditingId),
      direction = ["down", "both"].includes(
        voiceRuleForm.elements.direction.value,
      )
        ? voiceRuleForm.elements.direction.value
        : "up",
      positionSide =
        voiceRuleForm.elements.positionSide.value === "short"
          ? "short"
          : "long";
    if (!Number.isFinite(targetPrice) || targetPrice <= 0) return;
    if (
      kind === "theoretical_liquidation_gap" &&
      !Number.isFinite(theoreticalLiquidation(positionSide))
    ) {
      status.textContent = tx(
        "请先在“我的持仓”中填写该方向的开仓价、持仓量及保证金或杠杆。",
        "Set that position's entry price, size, and margin or leverage in My Position first.",
      );
      return;
    }
    const anchorPrice =
      kind === "price_move" ? Number(state?.ticker?.last) : null;
    if (kind === "price_move" && !Number.isFinite(anchorPrice)) return;
    const updated = {
      id: existing?.id || crypto.randomUUID(),
      kind,
      targetPrice,
      direction,
      positionSide,
      anchorPrice,
      windowSeconds,
      repeat,
      cooldownMinutes,
      lastTriggeredAt: null,
    };
    if (existing)
      voiceRules = voiceRules.map((rule) =>
        rule.id === existing.id ? updated : rule,
      );
    else voiceRules.push(updated);
    saveVoiceRules();
    showVoiceRuleModal(false);
    renderVoiceRules();
  };
  $("voiceAlertAddRule").onclick = () => showVoiceRuleModal(true);
  // 各规则种类的「命中」判定：抽出为查表，替代长 if 链（见 CODE_AUDIT_REPORT.md Step 5）。
  // 表内每个分支与原有 if 块逐字节等价；表外的默认兜底处理 price_above /
  // price_below / long_liquidation / short_liquidation 这一组「价格越过类」规则，
  // 语义与原 if 链完全一致。
  const VOICE_MATCHERS = {
    theoretical_liquidation_gap(rule, from, to, now, amount) {
      const side = rule.positionSide === "short" ? "short" : "long",
        liquidation = theoreticalLiquidation(side);
      if (!Number.isFinite(liquidation)) return false;
      const satisfied =
        side === "short" ? to >= liquidation - amount : to <= liquidation + amount;
      if (!satisfied) return false;
      // 双仓场景：若反方向也接近强平，只播报当前价格离得更近（更危险）的一边，
      // 避免价格上涨时做空盈利一边的语音播报干扰。
      const otherSide = side === "short" ? "long" : "short",
        otherLiquidation = theoreticalLiquidation(otherSide);
      if (Number.isFinite(otherLiquidation)) {
        const myGap = Math.abs(to - liquidation),
          otherGap = Math.abs(to - otherLiquidation);
        if (otherGap < myGap) return false;
      }
      return true;
    },
    price_move(rule, from, to, now, amount) {
      const anchor = Number(rule.anchorPrice),
        delta = to - anchor;
      return (
        Number.isFinite(anchor) &&
        (rule.direction === "both"
          ? Math.abs(delta) >= amount
          : rule.direction === "down"
            ? delta <= -amount
            : delta >= amount)
      );
    },
    price_speed(rule, from, to, now, amount) {
      const cutoff =
          now -
          Math.min(60, Math.max(1, Number(rule.windowSeconds) || 3)) * 1_000,
        base = voicePriceHistory.find((point) => point.ts >= cutoff),
        delta = base ? to - base.price : 0;
      return (
        base &&
        (rule.direction === "both"
          ? Math.abs(delta) >= amount
          : rule.direction === "down"
            ? delta <= -amount
            : delta >= amount)
      );
    },
    price_tick_move(rule, from, to, now, amount) {
      const delta = to - from;
      return rule.direction === "both"
        ? Math.abs(delta) >= amount
        : rule.direction === "down"
          ? delta <= -amount
          : delta >= amount;
    },
    price_reached(rule, from, to, now, amount) {
      return (
        from === rule.targetPrice ||
        to === rule.targetPrice ||
        (from - rule.targetPrice) * (to - rule.targetPrice) < 0
      );
    },
  };
  const voiceMatched = (rule, from, to, now) => {
    const amount = Number(rule.targetPrice);
    const matcher = VOICE_MATCHERS[rule.kind];
    if (matcher) return matcher(rule, from, to, now, amount);
    /* 价格越过类规则按“状态”而非“穿越瞬间”判定：创建规则时价格已在目标之外
       （例如现价已高于“上涨至 79865”的目标）也必须立即播报，否则规则会静默失效。 */
    const up = rule.kind === "price_above" || rule.kind === "short_liquidation";
    return up ? to >= rule.targetPrice : to <= rule.targetPrice;
  };
  const voiceDirection = (rule, from, to, now) => {
    if (rule.kind === "theoretical_liquidation_gap")
      return rule.positionSide === "short" ? "up" : "down";
    if (
      rule.kind === "price_below" ||
      rule.kind === "long_liquidation"
    )
      return "down";
    if (
      rule.kind === "price_above" ||
      rule.kind === "short_liquidation"
    )
      return "up";
    if (rule.kind === "price_reached") return to >= from ? "up" : "down";
    if (rule.direction === "up" || rule.direction === "down")
      return rule.direction;
    if (rule.kind === "price_move")
      return to >= Number(rule.anchorPrice) ? "up" : "down";
    if (rule.kind === "price_speed") {
      const cutoff =
          now -
          Math.min(60, Math.max(1, Number(rule.windowSeconds) || 3)) * 1_000,
        base = voicePriceHistory.find((point) => point.ts >= cutoff);
      return !base || to >= base.price ? "up" : "down";
    }
    return to >= from ? "up" : "down";
  };
  // 强平类规则（含理论强平）共用一套提示音；其余按涨跌方向选音。
  // Centralised so the kind list isn't duplicated across the voice engine.
  const LIQUIDATION_KINDS = new Set([
    "long_liquidation",
    "short_liquidation",
    "theoretical_liquidation_gap",
  ]);
  const voiceChimeFor = (rule, direction) => {
    if (LIQUIDATION_KINDS.has(rule.kind)) return settings.liquidationChimeType;
    return direction === "down" ? settings.dropChimeType : settings.riseChimeType;
  };
  const voiceRuleMessage = (rule, current, direction) => {
    const target = Number(rule.targetPrice).toLocaleString("en-US", {
        maximumFractionDigits: 2,
      }),
      currentText = Number(current).toLocaleString("en-US", {
        maximumFractionDigits: 2,
      });
    const comparisonText = personalEntryComparisons(current).join(" ");
    let message;
    if (rule.kind === "theoretical_liquidation_gap") {
      const side = rule.positionSide === "short" ? "short" : "long",
        liquidation = theoreticalLiquidation(side),
        gap = Number.isFinite(liquidation)
          ? Math.abs(current - liquidation).toLocaleString("en-US", {
              maximumFractionDigits: 2,
            })
          : "--";
      // 若持仓填写了名义金额，可估算当前亏损。
      const entry = (
          Array.isArray(window.btcPersonalEntries)
            ? window.btcPersonalEntries
            : typeof personalEntries !== "undefined"
              ? personalEntries
              : []
        ).find(
          (item) => item?.side === side && Number(item?.price) > 0,
        ),
        entryPrice = entry ? Number(entry.price) : null,
        notional =
          entry &&
          Number.isFinite(Number(entry.amount)) &&
          Number(entry.amount) > 0
            ? Number(entry.amount)
            : null;
      let lossText = "";
      if (
        Number.isFinite(entryPrice) &&
        entryPrice > 0 &&
        Number.isFinite(notional) &&
        notional > 0
      ) {
        const pnl =
          side === "short"
            ? (notional * (entryPrice - current)) / entryPrice
            : (notional * (current - entryPrice)) / entryPrice;
        const loss = -pnl;
        if (loss > 0) {
          const lossAmount = loss.toLocaleString("en-US", {
            maximumFractionDigits: 2,
          });
          lossText =
            uiLang === "zh"
              ? `约亏损 ${lossAmount} 美元。`
              : `Estimated loss ${lossAmount} USD. `;
        }
      }
      message = uiLang === "zh"
        ? `${side === "short" ? "做空" : "做多"}理论强平价警告。理论强平价 ${Number.isFinite(liquidation) ? liquidation.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "暂不可用"}。当前价格 ${currentText}，距强平价 ${gap}。${lossText}`
        : `${side === "short" ? "Short" : "Long"} theoretical liquidation warning. The theoretical liquidation price is ${Number.isFinite(liquidation) ? liquidation.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "unavailable"}. Current price is ${currentText}, ${gap} from liquidation. ${lossText}`;
    } else if (rule.kind === "price_tick_move")
      message = uiLang === "zh"
        ? `价格跳动提醒。当前价格，${currentText}。较前一次报价${direction === "down" ? "下跌" : "上涨"} ${target}。`
        : `Price jump alert. Current price is ${currentText}. It moved ${direction === "down" ? "down" : "up"} ${target} from the previous quote.`;
    else if (rule.kind === "price_speed")
      message = uiLang === "zh"
        ? `快速价格变动提醒。当前价格，${currentText}。价格在 ${rule.windowSeconds} 秒内${direction === "down" ? "下跌" : "上涨"} ${target}。`
        : `Rapid price movement alert. Current price is ${currentText}. Price moved ${direction === "down" ? "down" : "up"} ${target} within ${rule.windowSeconds} seconds.`;
    else if (rule.kind === "price_move")
      message = uiLang === "zh"
        ? `价格变动提醒。当前价格，${currentText}。价格已${direction === "down" ? "下跌" : "上涨"} ${target}。`
        : `Price movement alert. Current price is ${currentText}. Price has moved ${direction === "down" ? "down" : "up"} ${target}.`;
    else
      message = uiLang === "zh"
        ? `价格预警。当前价格，${currentText}。已触发${voiceRuleName(rule.kind)}，${target}。`
        : `Price alert. Current price is ${currentText}. ${voiceRuleName(rule.kind)} ${target} triggered.`;
    return comparisonText ? `${message}${comparisonText}` : message;
  };
  /* 规则的展示名（与规则列表标题一致）：「正在播报/已播报」状态行复用。 */
  const voiceRuleLabel = (rule) =>
    `${voiceRuleName(rule.kind, rule.direction, rule.positionSide)} ${Number(rule.targetPrice).toLocaleString("en-US", {
      maximumFractionDigits: 2,
    })}`;
  /* 规则真实触发时更新状态文字；播报按钮由实际播放开始／结束事件同步。 */
  const announceVoiceTrigger = (rule) => {
    status.textContent = tx(`已播报：${voiceRuleLabel(rule)}`, `Spoke: ${voiceRuleLabel(rule)}`);
  };
  const testVoiceRule = (rule) => {
    const current = Number(state?.ticker?.last);
    if (!Number.isFinite(current)) {
      status.textContent = tx("实时价格尚未加载", "Live price is not loaded");
      return;
    }
    const direction = voiceDirection(
      rule,
      current,
      current,
      Date.now(),
    ),
      wasEnabled = settings.enabled;
    settings.enabled = true;
    say(voiceRuleMessage(rule, current, direction), {
      chimeType: voiceChimeFor(rule, direction),
      label: voiceRuleLabel(rule),
      onFailure: () => {
        status.textContent = tx(
          "规则测试失败：请检查本机音量或切换系统语音。",
          "Rule test failed: check local volume or switch to system voice.",
        );
      },
    });
    settings.enabled = wasEnabled;
    status.textContent = tx("正在测试该规则…", "Testing this rule…");
  };
  setInterval(() => {
    updateVoiceEntrySummary();
    const current = state?.ticker?.last;
    if (!Number.isFinite(current)) return;
    const now = Date.now();
    voicePriceHistory.push({ ts: now, price: current });
    voicePriceHistory = voicePriceHistory.filter(
      (point) => point.ts >= now - 61_000,
    );
    if (voicePrevious === null) {
      voicePrevious = current;
      return;
    }
    /* 异常报价跳变保护：单拍价格不可能合法地跳 3% 以上，只有「页面刚打开时先拿到本地
       快照价（或行情源短暂串到别的币种）」这类坏读数才会如此。坏读数一旦进入规则判定，
       所有「价格达到／越过」类规则会在同一拍被同时判成穿越 —— 实测 09:44:39.433 有 6 条
       规则在同一毫秒全部播报（当时 BTC 实际 81,43x，不可能同时穿越 74,500~80,300 六个
       价位）。这一拍只用来把基准对齐到新价格，不参与任何规则判定。 */
    if (
      voicePrevious > 0 &&
      Math.abs(current - voicePrevious) / voicePrevious > 0.03
    ) {
      voicePrevious = current;
      return;
    }
    const triggeredBatch = [];
    if (settings.enabled)
      for (const rule of voiceRules) {
        if (!rule.repeat && rule.lastTriggeredAt) continue;
        const satisfied = voiceMatched(rule, voicePrevious, current, now);
        /* 冷却时间对「重复播报」规则是唯一的闸门 —— 包括每一次新的边沿。
           曾经的写法是 freshEdge（“上一拍不满足、这一拍满足”）直接短路冷却：对状态类
           规则（上涨至／下跌至，持续满足时 satisfied 恒为真）没问题，但 price_reached
           （价格达到）这类穿越规则的 satisfied 只在穿越那一拍为真、紧接着就回到 false，
           于是价格在目标位附近来回震荡时每一次穿越都被当成“新边沿”立即播报，冷却形同
           虚设（实测设了 5 分钟冷却的「价格达到 81,000」在 18 秒内播报两次；当时价格在
           81,000 上下 ±40 反复穿越，32 分钟内穿越 15 次）。现在：重复规则首次触发照旧
           立即出声，之后一律等冷却（不冷却也为 30 秒下限）；一次性规则语义不变，仍由
           上面的 continue 保证只播一次。 */
        const cooldown = rule.repeat
          ? Math.max(
              30_000,
              Math.max(0, Number(rule.cooldownMinutes) || 0) * 60_000,
            )
          : 0;
        const cooldownReady =
          !rule.lastTriggeredAt || now - rule.lastTriggeredAt >= cooldown;
        /* 一次性规则到这一步时 lastTriggeredAt 必为空（上面已 continue），恒为真。 */
        if (satisfied && (rule.repeat ? cooldownReady : true)) {
          const direction = voiceDirection(rule, voicePrevious, current, now);
          rule.lastTriggeredAt = now;
          if (rule.kind === "price_move" && rule.repeat)
            rule.anchorPrice = current;
          saveVoiceRules();
          triggeredBatch.push({ rule, direction });
        }
        rule.satisfied = satisfied;
      }
    /* 同一秒内多条规则同时命中：按「播报优先级」排序后依次入队播报，
       而不是互相掐掉（此前数组靠后的规则会直接 cancel 前面的）。 */
    triggeredBatch
      .map((item, index) => ({
        ...item,
        rank: speechRankOfRule(item.rule) * 1000 + index,
      }))
      .sort((a, b) => a.rank - b.rank)
      .forEach(({ rule, direction, rank }) => {
        enqueueSpeech(voiceRuleMessage(rule, current, direction), {
          chimeType: voiceChimeFor(rule, direction),
          label: voiceRuleLabel(rule),
        }, rank);
        announceVoiceTrigger(rule);
      });
    if (triggeredBatch.length) renderVoiceRules();
    voicePrevious = current;
  }, 1_000);
  window.addEventListener("btc:voice-language-changed", () => {
    filterEdgeVoices();
    renderPriority();
    render();
  });
  /* 「添加预警」里勾选“触发时语音播报”的规则在触发时会派发该事件——
     此前没有任何监听者，语音从不发声。这里补上播报。 */
  window.addEventListener("btc:voice-alert", (event) => {
    const rule = event.detail?.rule;
    if (!rule || !settings.enabled) return;
    const price = Number(event.detail?.price),
      current = Number.isFinite(price) ? price : state?.ticker?.last;
    if (!Number.isFinite(current)) return;
    const direction =
      rule.kind === "price_below" || rule.kind === "long_liquidation"
        ? "down"
        : "up";
    say(voiceRuleMessage({ ...rule, direction }, current, direction), {
      chimeType: voiceChimeFor(rule, direction),
      label: voiceRuleLabel({ ...rule, direction }),
    });
  });
  if (supported) {
    window.speechSynthesis.addEventListener?.("voiceschanged", populateVoices);
    populateVoices();
    setTimeout(populateVoices, VOICE_LIST_POPULATE_DELAY_MS);
  }
  setInterval(() => speakPrice(false), 1_000);
  filterEdgeVoices();
  renderVoiceRules();
  render();
  syncVoiceToServer();
}, 0);

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
    el.innerHTML = `<b>${tx("已选时间段", "Selected period")}</b> ${pointTime(s[0].time)} — ${pointTime(s.at(-1).time)} · ${s.length} ${tx("根", "candles")} / ${duration.toFixed(0)} ${tx("分钟", "min")} · <span class="high">${tx("最高", "High")} ${money(hi)}</span> · <span class="low">${tx("最低", "Low")} ${money(lo)}</span> · <span class="${ret >= 0 ? "bull" : "bear"}">${tx("涨跌幅", "Return")} ${pct(ret)}</span>`;
});
if (state.candles.length) renderAnalysis();

/* 规则信号面板刻意使用独立的已收盘 K 线流，避免未收盘 K 线造成结论抖动。
   The rule-signal panel deliberately uses its own closed-candle data stream.
   Chart range and chart interval are presentation controls, not a signal input. */
const fixedRuleSignal = {
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
const RULE_SIGNAL_MIN_CANDLES = 200;
const RULE_SIGNAL_HISTORY_CANDLES = 800;
const RULE_SIGNAL_ENTER_SCORE = 45;
const RULE_SIGNAL_EXIT_SCORE = 28;
const RULE_SIGNAL_CONFIRM_INTERVALS = ["15m", "1h"];
const RULE_SIGNAL_REENTRY_CANDLES = 2;
function ruleDirectionForScore(score, threshold = RULE_SIGNAL_ENTER_SCORE) {
  return score >= threshold ? "bull" : score <= -threshold ? "bear" : "flat";
}
function ruleSignalLabel(kind) {
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
function renderFixedRuleSignal() {
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
(() => {
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
})();
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
  const allCloses = (frozenCandles || state.candles || []).map((v) => v.close),
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
function formatRate(value) {
  return Number.isFinite(value)
    ? `${value >= 0 ? "+" : ""}${(value * 100).toFixed(4)}%`
    : "--";
}
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

/* 连通性诊断在启动稍后执行，并将服务器给出的本地与上游耗时分别呈现。
   Connectivity diagnostics begin shortly after startup, with the server's
   persistent OKX WebSocket checked before REST-backed data routes. */
setTimeout(() => {
  const controls = document.querySelector("main>header .controls"),
    version = $("appVersion");
  if (!controls || !version || $("connectivityToggle")) return;
  const wrap = document.createElement("div");
  wrap.className = "connectivity-wrap";
  wrap.innerHTML =
    '<button id="connectivityToggle" class="connectivity-toggle" type="button" aria-expanded="false"></button><section id="connectivityPanel" class="connectivity-panel" hidden><div class="connectivity-head"><div><b id="connectivityTitle"></b><small id="connectivityScope"></small></div><button id="rerunConnectivity" type="button"></button></div><div id="connectivitySummary" class="connectivity-summary"></div><div id="connectivityRows" class="connectivity-rows"></div><p id="connectivityFoot"></p></section>';
  version.after(wrap);
  const toggle = $("connectivityToggle"),
    panel = $("connectivityPanel"),
    rows = $("connectivityRows"),
    summary = $("connectivitySummary");
  let hasRun = false,
    running = false;
  const copy = () => {
    toggle.textContent = tx("连通性测试", "Connectivity");
    $("connectivityTitle").textContent = tx("数据连通性", "Data connectivity");
    $("connectivityScope").textContent = tx(
      "浏览器 → 本站，与服务器 → 数据上游分开统计",
      "Browser → site and server → upstream measured separately",
    );
    $("rerunConnectivity").textContent = tx("重新检测", "Test again");
    $("connectivityFoot").textContent = tx(
      "本地到本站 = 浏览器总耗时减去服务端处理；服务器到上游 = 实际 REST 等待。OKX WebSocket 会显示数据年龄；缓存命中时上游为 0 ms。",
      "Browser → site = total browser time minus server processing. Server → upstream is REST wait time. OKX WebSocket shows data age; cached responses show 0 ms upstream.",
    );
  };
  const timedFetch = async (url) => {
    const started = performance.now(),
      controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(url, {
          cache: "no-store",
          signal: controller.signal,
        }),
        data = await response.json();
      if (!response.ok)
        throw new Error(data.detail || data.error || `HTTP ${response.status}`);
      const totalMs = Math.round(performance.now() - started),
        serverMs = Number(data.timing?.serverMs) || 0;
      return {
        data,
        ms: totalMs,
        siteMs: Math.max(0, totalMs - serverMs),
        upstreamMs: Number(data.timing?.upstreamMs) || 0,
        upstreamCalls: Number(data.timing?.upstreamCalls) || 0,
      };
    } finally {
      clearTimeout(timer);
    }
  };
  const marketCheck = (source, label, contract) => async () => {
    const result = await timedFetch(
        "/api/market?" +
          new URLSearchParams({ source, interval: "15m", limit: "30" }),
      ),
      { data } = result,
      mode =
        data.transport === "websocket"
          ? "WebSocket"
          : data.stale
            ? tx("降级缓存", "stale cache")
            : data.cached
              ? tx("缓存", "cached")
              : "REST";
    const age = Number.isFinite(data.cacheAgeMs)
      ? ` · ${tx("数据年龄", "age")} ${data.cacheAgeMs} ms`
      : "";
    return {
      ...result,
      name: label,
      contract,
      detail: `${contract} · ${money(data.ticker.last)} · ${data.candles.length} ${tx("根K线", "candles")} · ${mode}${age}`,
    };
  };
  const webSocketCheck = async () => {
    const result = await timedFetch("/api/status"),
      { data } = result,
      ws = data.websocket || {};
    if (ws.status !== "connected")
      throw new Error(
        `OKX WebSocket ${ws.status || tx("不可用", "unavailable")}${ws.lastError ? ` · ${ws.lastError}` : ""}`,
      );
    return {
      ...result,
      name: tx("OKX WebSocket（优先）", "OKX WebSocket (preferred)"),
      contract: "wss://ws.okx.com:8443/ws/v5/public",
      detail: `${tx("状态", "Status")} ${ws.status} · ${tx("数据年龄", "age")} ${Number.isFinite(ws.tickerAgeMs) ? `${ws.tickerAgeMs} ms` : "--"} · ${tx("重连", "Reconnects")} ${ws.reconnects ?? 0}`,
    };
  };
  const backendCheck = async () => {
    const result = await timedFetch("/api/status"),
      { data } = result;
    return {
      ...result,
      name: tx("本站后端", "Site backend"),
      contract: "/api/status",
      detail: `${data.sources.length} ${tx("个行情源", "market sources")} · ${data.cacheEntries} ${tx("项缓存", "cache entries")}`,
    };
  };
  const sentimentCheck = async () => {
    const result = await timedFetch("/api/sentiment"),
      { data } = result,
      mode = data.stale
        ? tx("降级缓存", "stale cache")
        : data.cached
          ? tx("缓存", "cached")
          : tx("实时", "live");
    return {
      ...result,
      name: tx("恐惧&贪婪指数", "Fear & Greed Index"),
      contract: "Alternative.me · /api/sentiment",
      detail: `${data.value}/100 · ${data.classification || "--"} · ${mode}`,
    };
  };
  const macroCheck = async () => {
    const result = await timedFetch("/api/fed-calendar"),
      { data } = result,
      events = data.events || [],
      signals = data.marketSignals || [],
      available = signals.filter((signal) => signal.available).length,
      providers = [
        ...new Set(
          [
            ...events.map((event) => event.source),
            ...signals.map((signal) => signal.source),
          ].filter((source) => source && source !== "—"),
        ),
      ];
    return {
      ...result,
      name: tx("宏观日历与市场环境", "Macro calendar & market context"),
      contract: "/api/fed-calendar",
      detail: `${events.length} ${tx("个日历事件", "calendar events")} · ${available}/${signals.length} ${tx("项环境数据", "market signals")} · ${providers.join(" / ") || "--"}`,
    };
  };
  // 数据链路按职责分组：行情与衍生品 / 概率与跨市场 / 宏观与日历 /
  // 情绪与新闻 / AI 与服务。每组可独立折叠，面板随 API 增多也能保持可读。
  // Data paths are grouped by responsibility so the panel stays legible as the
  // number of connected APIs grows. Each group collapses independently.
  const CATS = [
    { id: "market", label: () => tx("行情与衍生品", "Market & derivatives") },
    { id: "signal", label: () => tx("概率与跨市场", "Probability & cross-market") },
    { id: "macro", label: () => tx("宏观与日历", "Macro & calendar") },
    { id: "news", label: () => tx("情绪与新闻", "Sentiment & news") },
    { id: "service", label: () => tx("AI 与服务", "AI & services") },
  ];
  const checks = () => [
    { cat: "market", name: tx("OKX WebSocket（优先）", "OKX WebSocket (preferred)"), contract: "wss://ws.okx.com:8443/ws/v5/public", run: webSocketCheck },
    { cat: "market", name: tx("本站后端", "Site backend"), contract: "/api/status", run: backendCheck },
    { cat: "market", name: "OKX", contract: coinMetaOf().okx.swap, run: marketCheck("okx", "OKX", coinMetaOf().okx.swap) },
    { cat: "market", name: "Binance", contract: coinMetaOf().binance, run: marketCheck("binance", "Binance", coinMetaOf().binance) },
    { cat: "market", name: tx("衍生品上下文", "Derivatives context"), contract: "/api/market-context · OKX", run: async () => {
        const result = await timedFetch("/api/market-context?source=okx"),
          { data } = result;
        const fr = data.fundingRate, oi = data.oi;
        return {
          ...result,
          name: tx("衍生品上下文", "Derivatives context"),
          contract: "/api/market-context · OKX",
          detail: `资金费率 ${Number.isFinite(fr) ? (fr * 100).toFixed(4) + "%" : "--"} · OI ${Number.isFinite(oi) ? (oi / 1e8).toFixed(2) + " 亿" : "--"} · ${data.source || "--"}`,
        };
      } },
    { cat: "signal", name: tx("概率历史样本", "Forecast history"), contract: "/api/forecast-history", run: async () => {
        const result = await timedFetch("/api/forecast-history"),
          { data } = result;
        return {
          ...result,
          name: tx("概率历史样本", "Forecast history"),
          contract: "/api/forecast-history",
          detail: `${data.source} · 15m ${data.intraday.length} / 1d ${data.daily.length} · ${data.cached ? tx("缓存", "cached") : tx("实时", "live")}`,
        };
      } },
    { cat: "signal", name: tx("美股联动样本", "US equities history"), contract: "/api/correlation-history", run: async () => {
        const result = await timedFetch("/api/correlation-history"),
          { data } = result;
        return {
          ...result,
          name: tx("美股联动样本", "US equities history"),
          contract: "/api/correlation-history",
          detail: `BTC ${data.btc.length} · SPY ${data.spy.length} · QQQ ${data.qqq.length} · ${data.cached ? tx("缓存", "cached") : tx("实时", "live")}`,
        };
      } },
    { cat: "signal", name: tx("美股实时报价", "US equity quotes"), contract: "Yahoo Finance · /api/us-equity-quotes", run: async () => {
        const result = await timedFetch("/api/us-equity-quotes"),
          { data } = result;
        const spy = (data.quotes || []).find((q) => q.symbol === "SPY"),
          qqq = (data.quotes || []).find((q) => q.symbol === "QQQ");
        return {
          ...result,
          name: tx("美股实时报价", "US equity quotes"),
          contract: "Yahoo Finance · /api/us-equity-quotes",
          detail: `SPY ${money(spy?.last)} · QQQ ${money(qqq?.last)} · ${data.source || "--"}`,
        };
      } },
    { cat: "macro", name: tx("宏观日历与市场环境", "Macro calendar & market context"), contract: "/api/fed-calendar", run: macroCheck },
    { cat: "macro", name: tx("投资日历", "Investment calendar"), contract: "/api/investment-calendar", run: async () => {
        const result = await timedFetch("/api/investment-calendar"),
          { data } = result;
        const events = data.events || [];
        const sources = [...new Set(events.map((e) => e.source).filter(Boolean))];
        return {
          ...result,
          name: tx("投资日历", "Investment calendar"),
          contract: "/api/investment-calendar",
          detail: `${events.length} ${tx("个事件", "events")} · ${(sources.join(" / ") || "--").slice(0, 48)}`,
        };
      } },
    { cat: "news", name: tx("恐惧&贪婪指数", "Fear & Greed Index"), contract: "Alternative.me · /api/sentiment", run: sentimentCheck },
    { cat: "news", name: tx("新闻流", "News feed"), contract: "Google News · /api/news", run: async () => {
        const result = await timedFetch("/api/news"),
          { data } = result;
        const items = data.items || [];
        return {
          ...result,
          name: tx("新闻流", "News feed"),
          contract: "Google News · /api/news",
          detail: `${items.length} ${tx("条", "items")} · ${data.source || "--"}`,
        };
      } },
    { cat: "service", name: tx("AI 助手与密钥", "AI assistant & keys"), contract: "/api/api-center", run: async () => {
        const result = await timedFetch("/api/api-center"),
          { data } = result;
        const c = data.credentials || {};
        const on = Object.entries(c).filter(([, v]) => v).map(([k]) => k);
        return {
          ...result,
          name: tx("AI 助手与密钥", "AI assistant & keys"),
          contract: "/api/api-center",
          detail: `${tx("已配置", "configured")}: ${on.length ? on.join(", ") : tx("无", "none")}`,
        };
      } },
    { cat: "service", name: tx("语音播报", "Voice (Edge TTS)"), contract: "Microsoft Edge TTS · /api/voice/edge", run: async () => {
        const started = performance.now(),
          controller = new AbortController(),
          timer = setTimeout(() => controller.abort(), 20_000);
        try {
          const response = await fetch("/api/voice/edge", {
              method: "POST",
              cache: "no-store",
              headers: { "content-type": "application/json" },
              // 探针必须是可朗读的文本：纯标点（如「。」）不含任何音素，
              // 上游会返回 0 字节音频，接口就会误报失败。
              // The probe must be pronounceable: punctuation-only text carries no
              // phonemes, the upstream returns 0 bytes, and the check false-alarms.
              body: JSON.stringify({ text: "测试", voice: "zh-CN-XiaoxiaoNeural" }),
              signal: controller.signal,
            }),
            buf = await response.arrayBuffer();
          if (!response.ok || buf.byteLength === 0) throw new Error(`HTTP ${response.status}`);
          const elapsed = Math.round(performance.now() - started);
          return {
            ms: elapsed,
            siteMs: elapsed,
            upstreamMs: 0,
            upstreamCalls: 0,
            name: tx("语音播报", "Voice (Edge TTS)"),
            contract: "Microsoft Edge TTS · /api/voice/edge",
            detail: `${tx("合成成功", "synthesized")} · ${(buf.byteLength / 1024).toFixed(1)} KB`,
          };
        } catch (error) {
          throw new Error(error.name === "AbortError" ? tx("请求超时", "Request timed out") : error.message);
        } finally {
          clearTimeout(timer);
        }
      } },
    { cat: "service", name: tx("预警推送", "Price alerts"), contract: "ServerChan · /api/alerts/health", run: async () => {
        const result = await timedFetch("/api/alerts/health"),
          { data } = result;
        return {
          ...result,
          name: tx("预警推送", "Price alerts"),
          contract: "ServerChan · /api/alerts/health",
          detail: data.enabled ? tx("已启用", "enabled") : (data.reason || tx("未启用", "disabled")),
        };
      } },
  ];
  const row = (index, name, contract) => {
    const el = document.createElement("article");
    el.className = "connectivity-row testing";
    el.dataset.check = String(index);
    el.innerHTML =
      '<span class="connectivity-dot"></span><div><b></b><small></small><em></em></div><strong><span></span><small></small></strong>';
    el.querySelector("b").textContent = name;
    el.querySelector("small").textContent = contract;
    el.querySelector("em").textContent = tx("检测中…", "Testing…");
    el.querySelector("strong span").textContent = "-- ms";
    return el;
  };
  const run = async () => {
    if (running) return;
    running = true;
    copy();
    toggle.classList.add("testing");
    const all = checks(),
      total = all.length;
    summary.className = "connectivity-summary testing";
    summary.textContent = tx(
      `正在并行检测 ${total} 项数据链路（优先 OKX WebSocket）…`,
      `Testing ${total} data paths, prioritizing OKX WebSocket…`,
    );
    rows.replaceChildren();
    const groupState = {};
    for (const cat of CATS) {
      const section = document.createElement("section");
      section.className = "connectivity-group";
      section.dataset.cat = cat.id;
      const head = document.createElement("button");
      head.type = "button";
      head.className = "connectivity-group-head";
      head.innerHTML =
        '<span class="connectivity-group-title"></span><span class="connectivity-group-badge"></span>';
      head.querySelector(".connectivity-group-title").textContent = cat.label();
      const body = document.createElement("div");
      body.className = "connectivity-group-body";
      section.append(head, body);
      rows.append(section);
      groupState[cat.id] = {
        section,
        body,
        badge: head.querySelector(".connectivity-group-badge"),
        passed: 0,
        total: 0,
      };
      head.onclick = (event) => {
        event.stopPropagation();
        section.classList.toggle("collapsed");
      };
    }
    all.forEach((check, index) => {
      const g = groupState[check.cat];
      g.body.append(row(index, check.name, check.contract));
      g.total++;
    });
    const results = await Promise.all(
      all.map(async (check, index) => {
        try {
          return { ok: true, index, ...(await check.run()) };
        } catch (error) {
          return {
            ok: false,
            index,
            error:
              error.name === "AbortError"
                ? tx("请求超时", "Request timed out")
                : error.message,
          };
        }
      }),
    );
    let passed = 0;
    for (const result of results) {
      const check = all[result.index],
        g = groupState[check.cat],
        el = rows.querySelector(`[data-check="${result.index}"]`);
      el.classList.remove("testing");
      if (result.ok) {
        passed++;
        g.passed++;
        const level =
          result.siteMs > 1_800 ? "bad" : result.siteMs > 800 ? "warn" : "good";
        el.classList.add(level);
        el.querySelector("b").textContent = result.name;
        el.querySelector("small").textContent = result.contract;
        el.querySelector("em").textContent = result.detail;
        el.querySelector("strong span").textContent =
          `${tx("本站", "Site")} ${result.siteMs} ms`;
        el.querySelector("strong small").textContent =
          `${tx("上游", "Upstream")} ${result.upstreamMs} ms${result.upstreamCalls ? ` · ${result.upstreamCalls} ${tx("次", "calls")}` : ""}`;
      } else {
        el.classList.add("bad");
        el.querySelector("em").textContent = result.error;
        el.querySelector("strong span").textContent = tx("失败", "Failed");
      }
    }
    for (const cat of CATS) {
      const g = groupState[cat.id],
        cls = g.passed === g.total ? "good" : g.passed ? "warn" : "bad";
      g.badge.textContent = `${g.passed}/${g.total}`;
      g.badge.className = `connectivity-group-badge ${cls}`;
      g.section.classList.toggle("has-error", g.passed < g.total);
    }
    const allOk = passed === total;
    summary.className = `connectivity-summary ${allOk ? "good" : passed ? "warn" : "bad"}`;
    summary.textContent = tx(
      `检测完成：${passed}/${total} 项可用 · ${new Date().toLocaleTimeString("zh-CN")}`,
      `Completed: ${passed}/${total} available · ${new Date().toLocaleTimeString("en-US")}`,
    );
    toggle.classList.remove("testing");
    toggle.classList.toggle("has-error", !allOk);
    toggle.dataset.result = `${passed}/${total}`;
    copy();
    running = false;
    hasRun = true;
  };
  toggle.onclick = (event) => {
    event.stopPropagation();
    const opening = panel.hidden;
    panel.hidden = !opening;
    toggle.setAttribute("aria-expanded", String(opening));
    if (opening && !hasRun) run();
  };
  $("rerunConnectivity").onclick = (event) => {
    event.stopPropagation();
    run();
  };
  panel.onclick = (event) => event.stopPropagation();
  document.addEventListener("click", () => {
    panel.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      panel.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
    }
  });
  copy();
  setTimeout(() => {
    if (!hasRun) run();
  }, 5_000);
  const applyLanguageWithConnectivity = applyLanguage;
  applyLanguage = function () {
    applyLanguageWithConnectivity();
    copy();
  };
}, 0);

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
visibleCandles = function () {
  const data = frozenCandles || state.candles;
  if (!data.length) return [];
  const count = state.viewPoints
    ? Math.max(2, Math.ceil(state.viewPoints / state.zoom))
    : Math.max(30, Math.ceil(data.length / state.zoom));
  const n = Math.min(data.length, count),
    maxOffset = Math.max(0, data.length - n),
    offset = Math.max(0, Math.min(maxOffset, state.panOffset || 0)),
    end = data.length - offset;
  return data.slice(Math.max(0, end - n), end);
};

function updatePanAvailability() {
  const data = frozenCandles || state.candles,
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
      const data = frozenCandles || state.candles;
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
  version.textContent = "v2.12.5";
  version.title = "查看更新日志";
  version.setAttribute("aria-expanded", "false");
  const sourceLabel = controls.querySelector("label");
  if (sourceLabel) controls.insertBefore(version, sourceLabel);
  else controls.prepend(version);
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
  tickers: "",
  output: "",
  loaded: false,
  loading: false,
};
function paintCorrelationPanel() {
  const status = $("correlationStatus"),
    out = $("correlationOutput"),
    cards = $("indexTickerCards"),
    button = $("refreshCorrelation");
  if (!out) return;
  if (status && correlationState.status) status.textContent = correlationState.status;
  if (cards && correlationState.tickers) cards.innerHTML = correlationState.tickers;
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
    const quoteCard = (name, ticker, q) => {
      const delta = q.last - q.previous,
        up = delta >= 0;
      return `<article class="index-card ${up ? "up" : "down"}"><span>${name} · ${ticker}</span><b>${q.last.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b><div><em>${up ? "+" : "−"}${Math.abs(delta).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</em><em>${up ? "+" : "−"}${((Math.abs(delta) / q.previous) * 100).toFixed(2)}%</em></div><small>${tx("最近收盘", "Last close")}</small></article>`;
    };
    correlationState.tickers =
      quoteCard(tx("标普 500", "S&P 500"), "SPY", d.indexQuotes.spy) +
      quoteCard(tx("纳斯达克 100", "Nasdaq 100"), "QQQ", d.indexQuotes.qqq);
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

/* 多周期共振：加权一致性所需的常量（上移到此处，避免在 applyLanguage 早期调用时触发 TDZ）。
   **数组顺序 = 界面上的展示顺序（时间由小到大）**，也是加权时的遍历顺序，改动时留意。
   ttl = 该周期缓存的有效期，同时就是它在自动刷新里的目标节奏：15m 约 1 分钟、
   1h 约 5 分钟、4h 约 15 分钟、1d 约 1 小时、1w 约 6 小时（周线一周才收一根，不必勤刷）。
   取值略小于整数间隔，是为了不跟 20 秒的检查节拍撞线 —— 正好取 60_000 时，到点那一拍的
   已过时间往往只有 59.9s，会被判成「还没到期」而白漏一拍，变成每两拍才更新一次。
   weight 之和为 1，周期越大分量越重。 */
const RES_INTERVALS = [
  { key: "15m", weight: 0.05, threshold: 35, ttl: 55_000 },
  { key: "1h", weight: 0.1, threshold: 45, ttl: 280_000 },
  { key: "4h", weight: 0.2, threshold: 45, ttl: 870_000 },
  { key: "1d", weight: 0.3, threshold: 45, ttl: 3_540_000 },
  { key: "1w", weight: 0.35, threshold: 45, ttl: 21_600_000 },
];
const resonanceCache = {};
let resonanceSource = null;

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
  const unpannedVisibleCandles = visibleCandles;
  visibleCandles = function () {
    const data = frozenCandles || state.candles,
      n = state.viewPoints
        ? Math.max(2, Math.ceil(state.viewPoints / state.zoom))
        : Math.max(30, Math.ceil(data.length / state.zoom)),
      maxOffset = Math.max(0, data.length - n);
    state.panOffset = Math.max(0, Math.min(maxOffset, state.panOffset || 0));
    const end = Math.max(n, data.length - state.panOffset);
    return data.slice(Math.max(0, end - n), end);
  };
  const toolbar = document.querySelector(".toolbar");
  if (!toolbar || $("panTools")) return;
  const pan = document.createElement("div");
  pan.id = "panTools";
  pan.className = "pan-tools";
  pan.innerHTML = `<button type="button" data-pan="back" title="查看更早数据">←</button><span id="panLabel"><i>${tx("横向移动", "Pan chart")}</i><small>${tx("按住 ⌘ / Ctrl + 滚轮", "Hold ⌘ / Ctrl + scroll")}</small></span><button type="button" data-pan="forward" title="回到较新数据">→</button>`;
  toolbar.append(pan);
  updatePanControls = () => {
    const d = frozenCandles || state.candles,
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
    const d = frozenCandles || state.candles,
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
const visibleCandlesRange = visibleCandles;
visibleCandles = function () {
  const d = visibleCandlesRange();
  return state.viewPoints
    ? d.slice(-Math.max(2, Math.ceil(state.viewPoints / state.zoom)))
    : d;
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
let resonanceTimer = null,
  horizonForecastCache = null,
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
  overlay.innerHTML = `<b>${tx("框选时间段", "Selected range")}</b> ${pointTime(s[0].time)} — ${pointTime(s.at(-1).time)}<span>${tx("最高", "High")} <em class="high">${money(hi)}</em> <i class="${diff(hi) >= 0 ? "bull" : "bear"}">${tx("较实时", "vs live")} ${diff(hi) >= 0 ? "+" : "−"}${money(Math.abs(diff(hi)))}</i></span><span>${tx("最低", "Low")} <em class="low">${money(lo)}</em> <i class="${diff(lo) >= 0 ? "bull" : "bear"}">${tx("较实时", "vs live")} ${diff(lo) >= 0 ? "+" : "−"}${money(Math.abs(diff(lo)))}</i></span><span class="${ret >= 0 ? "bull" : "bear"}">${tx("区间涨跌", "Range return")} ${pct(ret)}</span>`;
}
/* 多周期共振的自动计算节奏。
   首屏：等核心 K 线渲染完之后再算一次，避免与首屏请求抢带宽。
   之后：每 RESONANCE_AUTO_MS 走一次「到期检查」—— 不强制全拉，只重算缓存已过期的周期，
   于是常态下一拍只真正拉 15m（约每分钟一次），1h / 4h / 1d 分别在 5 / 15 / 60 分钟才发请求，
   四个周期共 800 根 K 线不会被每分钟重拉一遍。检查本身不发请求，节拍取小一点没有代价。 */
const RESONANCE_AUTO_MS = 20_000,
  RESONANCE_FIRST_MS = 2_500;
function resetResonanceTimer() {
  clearTimeout(resonanceTimer);
  resonanceTimer = setTimeout(async () => {
    if (!document.hidden) await refreshResonance(false);
    resetResonanceTimer();
  }, RESONANCE_AUTO_MS);
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
$("loadResonance").onclick = () => refreshResonance(true);
resetResonanceTimer();
/* 打开页面自动计算一次：不点按钮也能直接看到共振结论。 */
setTimeout(() => {
  if (!document.hidden) refreshResonance(true);
}, RESONANCE_FIRST_MS);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) clearTimeout(resonanceTimer);
  else resetResonanceTimer();
});

/* Quiet live refresh and exchange comparison strip. */
classification = function (score) {
  return score >= 45
    ? [tx("做多", "Long"), "bull"]
    : score <= -45
      ? [tx("做空", "Short"), "bear"]
      : [tx("观望", "Neutral"), "flat"];
};
function classifyTf(score, threshold) {
  if (score >= threshold) return [tx("做多", "Long"), "bull", 1];
  if (score <= -threshold) return [tx("做空", "Short"), "bear", -1];
  return [tx("观望", "Neutral"), "flat", 0];
}
async function fetchResonanceInterval(iv, force) {
  const now = Date.now(),
    c = resonanceCache[iv.key];
  if (!force && resonanceSource === state.source && c && now - c.ts < iv.ttl)
    return false;
  const r = await fetch(
    "/api/market?" +
      new URLSearchParams({
        interval: iv.key,
        limit: 200,
        source: state.source,
      }),
  );
  const x = await r.json();
  if (!r.ok) throw new Error(`${iv.key}: ${x.error}`);
  const m = metrics(x.candles),
    [, cls, dir] = classifyTf(m.score, iv.threshold);
  resonanceCache[iv.key] = {
    score: m.score,
    cls,
    dir,
    source: x.source,
    ts: now,
  };
  resonanceSource = state.source;
  return true;
}
/* 结论的唯一真源：徽标文案（同向周期数 + 强度）与标题行右侧那句四字短语都在这里算。
   `majority` 用比例而非写死 3，是为了周期数变动时门槛自动跟着走
   （4 个周期 → 3 个算多数；5 个周期 → 4 个算多数）。 */
function resonanceVerdict() {
  if (!RES_INTERVALS.some((iv) => resonanceCache[iv.key])) return null;
  let longs = 0,
    shorts = 0,
    weighted = 0;
  for (const iv of RES_INTERVALS) {
    const c = resonanceCache[iv.key];
    if (!c) continue;
    const [, , dir] = classifyTf(c.score, iv.threshold);
    if (dir > 0) {
      longs++;
      weighted += iv.weight * (c.score / 100);
    } else if (dir < 0) {
      shorts++;
      weighted -= iv.weight * (c.score / 100);
    }
  }
  const total = RES_INTERVALS.length,
    mag = Math.round(Math.min(1, Math.abs(weighted)) * 100),
    majority = Math.ceil(total * 0.7);
  let cls, label, short;
  if (longs === total) {
    cls = "bull";
    label = `${tx("强共振·多", "Strong long")} (${total}/${total})`;
    short = tx("全线偏多", "All bullish");
  } else if (shorts === total) {
    cls = "bear";
    label = `${tx("强共振·空", "Strong short")} (${total}/${total})`;
    short = tx("全线偏空", "All bearish");
  } else if (longs >= majority) {
    cls = "bull";
    label = `${tx("多数·多", "Majority long")} (${longs}/${total})`;
    short = tx("多头占优", "Bulls lead");
  } else if (shorts >= majority) {
    cls = "bear";
    label = `${tx("多数·空", "Majority short")} (${shorts}/${total})`;
    short = tx("空头占优", "Bears lead");
  } else if (longs === 0 && shorts === 0) {
    cls = "flat";
    label = `${tx("无方向", "No direction")} (0/${total})`;
    short = tx("方向不明", "No direction");
  } else if (shorts === 0 || longs === 0) {
    /* 只有一侧有方向、但没到「多数」门槛：这是「偏多/偏空、还没共振」，
       不能叫分歧 —— 分歧的前提是多空两边都有人。 */
    const n = longs > 0 ? longs : shorts;
    cls = longs > 0 ? "bull" : "bear";
    label = `${longs > 0 ? tx("偏多", "Lean long") : tx("偏空", "Lean short")} · ${tx("待确认", "pending")} ${n}/${total}`;
    short = longs > 0 ? tx("偏多待确认", "Lean long") : tx("偏空待确认", "Lean short");
  } else {
    cls = "conflict";
    const lean =
      longs > shorts
        ? tx("偏多", "lean long")
        : longs < shorts
          ? tx("偏空", "lean short")
          : tx("均衡", "balanced");
    label = `${lean} · ${tx("分歧", "diverged")} ${longs}/${total}`;
    short = tx("多空分歧", "Diverged");
  }
  return { cls, label, mag, short };
}
function renderResonanceSummary() {
  const v = resonanceVerdict();
  return v
    ? `<div class="res-summary ${v.cls}"><b>${v.label}</b><small>${tx("强度", "str")} ${v.mag}</small></div>`
    : "";
}
function renderResonanceChips() {
  const out = $("resonance");
  if (!out) return;
  const chips = RES_INTERVALS.map(({ key }) => {
    const c = resonanceCache[key];
    if (!c || c.error)
      return `<span class="res-chip flat" data-iv="${key}"><b>${key}</b><em>${tx("…", "…")}</em></span>`;
    const dirLabel =
      c.cls === "bull"
        ? tx("做多", "Long")
        : c.cls === "bear"
          ? tx("做空", "Short")
          : tx("观望", "Neutral");
    return `<span class="res-chip ${c.cls}" data-iv="${key}"><b>${key}</b><em>${dirLabel} ${c.score > 0 ? "+" : ""}${c.score}</em></span>`;
  }).join("");
  /* 结论分两处：徽标进标题右侧的槽位，一句话短语进它更右侧的短语位
     （用户要求：中间那块空位放「几个字」的简要结论）。右侧一栏只留逐周期标签。 */
  const v = resonanceVerdict(),
    summary = renderResonanceSummary(),
    slot = $("resonanceSummary"),
    verdict = $("resonanceVerdict");
  if (verdict) {
    verdict.textContent = v ? v.short : "";
    verdict.className = `res-verdict ${v ? v.cls : "flat"}`;
    verdict.hidden = !v;
  }
  if (slot) {
    slot.innerHTML = summary;
    out.innerHTML = `<div class="res-chips">${chips}</div>`;
  } else out.innerHTML = summary + `<div class="res-chips">${chips}</div>`;
  highlightResonanceConflict();
  /* 按钮文字跟随计算状态：已算出 chips 就显示「重新计算共振」，
     避免自动计算后按钮仍是「计算共振」，让用户误以为还没算过 / 点击无效。 */
  const loadBtn = $("loadResonance");
  if (loadBtn) {
    loadBtn.textContent = out.querySelector(".res-chip")
      ? tx("重新计算共振", "Recalculate resonance")
      : tx("计算共振", "Calculate resonance");
  }
}
function highlightResonanceConflict() {
  const out = $("resonance");
  if (!out) return;
  const dirs = RES_INTERVALS.map((iv) => {
    const c = resonanceCache[iv.key];
    return c ? classifyTf(c.score, iv.threshold)[2] : 0;
  });
  const longs = dirs.filter((d) => d > 0).length,
    shorts = dirs.filter((d) => d < 0).length;
  if (longs === 0 || shorts === 0) return;
  const dom = longs >= shorts ? 1 : -1;
  RES_INTERVALS.forEach((iv, i) => {
    const chip = out.querySelector(`.res-chip[data-iv="${iv.key}"]`);
    if (!chip) return;
    if (dirs[i] !== 0 && dirs[i] !== dom) chip.classList.add("conflict");
    else chip.classList.remove("conflict");
  });
}
async function refreshResonance(forceAll) {
  const loadBtn = $("loadResonance");
  if (loadBtn && forceAll) loadBtn.textContent = tx("计算中…", "Computing…");
  let changed = false;
  await Promise.all(
    RES_INTERVALS.map(async (iv) => {
      try {
        if (await fetchResonanceInterval(iv, forceAll)) changed = true;
      } catch (e) {
        resonanceCache[iv.key] = {
          ...(resonanceCache[iv.key] || {}),
          error: e.message,
          ts: Date.now(),
        };
        changed = true;
      }
    }),
  );
  if (changed || forceAll) renderResonanceChips();
  return changed;
}
$("loadResonance").onclick = () => refreshResonance(true);
const loadCurrentWithHeader = loadCurrent;
loadCurrent = async function () {
  const refreshed = await loadCurrentWithHeader();
  if (refreshed === false) return false;
  const subtitle = document.querySelector("header p"),
    stream = state.lastGood?.transport === "websocket",
    latency = requestLatency || "--",
    highLatency = !stream && Number(requestLatency) >= 1000,
    streamAge = Number.isFinite(state.lastGood?.cacheAgeMs)
      ? `${state.lastGood.cacheAgeMs} ms`
      : "--";
  if (subtitle)
    subtitle.innerHTML = `<span class="live-pulse"></span>${stream ? tx("实时连接 · OKX WebSocket", "Live connection · OKX WebSocket") : tx("实时连接 · REST 降级", "Live connection · REST fallback")} · ${stream ? tx("数据年龄", "data age") + " " : ""}<b class="latency${highLatency ? " latency-high" : ""}">${stream ? streamAge : latency + " ms"}</b>`;
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
  const resonanceCard = document.querySelector("main > .optional");
  if (resonanceCard && card.previousElementSibling !== resonanceCard)
    card.before(resonanceCard);
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
   mount asynchronously, so preserve the reading order whenever one is added. */
function normalizePanelReadingOrder() {
  const main = document.querySelector("main"),
    diagnosticsCard = $("diagnostics")?.closest(".card"),
    liquidationDetails = document.querySelector(".liq-probability-details"),
    patternCard = $("patternAnalysis"),
    researchCard = $("researchOutlookCard"),
    resonanceCard = document.querySelector("main > .optional");
  if (!main) return;
  if (patternCard && resonanceCard && patternCard.previousElementSibling !== resonanceCard)
    patternCard.before(resonanceCard);
  if (patternCard && researchCard && patternCard.nextElementSibling !== researchCard)
    patternCard.after(researchCard);
  if (
    diagnosticsCard &&
    liquidationDetails &&
    liquidationDetails.nextElementSibling !== diagnosticsCard
  )
    liquidationDetails.after(diagnosticsCard);
}
(() => {
  const main = document.querySelector("main");
  if (!main) return;
  const observer = new MutationObserver(normalizePanelReadingOrder);
  observer.observe(main, { childList: true });
  normalizePanelReadingOrder();
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
      basis: `当前永续价差为 ${basis >= 0 ? "+" : ""}${basis.toFixed(3)}%，${extremeBasis ? "已达到需要留意杠杆拥挤的范围" : "仍在常规范围内"}。`,
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

/* Render the fixed signal once, then enrich its expanded indicator details. */
const renderFixedRuleSignalBase = renderFixedRuleSignal;
const fixedRuleSignalEnhancers = [];

/* Register post-render fixed-signal work without wrapping the renderer again. */
function addFixedRuleSignalEnhancer(id, render) {
  if (fixedRuleSignalEnhancers.some((enhancer) => enhancer.id === id))
    throw new Error(`Duplicate fixed rule signal enhancer: ${id}`);
  fixedRuleSignalEnhancers.push({ id, render });
}

/* Run the original signal renderer followed by each explicitly registered step. */
renderFixedRuleSignal = function () {
  renderFixedRuleSignalBase();
  fixedRuleSignalEnhancers.forEach(({ render }) => render());
};

/* Attach the confirmation rows before the detailed indicator card. */
addFixedRuleSignalEnhancer("trading-confirmation", () => {
  if (fixedRuleSignal.candles.length >= 200) {
    renderTradingConfirmation(metrics(fixedRuleSignal.candles));
    addLiveFlowConfirmation();
  }
});

/* Attach the detailed indicator card whenever enough fixed-basis candles exist. */
addFixedRuleSignalEnhancer("expanded-details", () => {
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
  if (
    (index !== 0 && index !== 1) ||
    !validEntry(Number(personalEntries[index]?.price))
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
        : ["crypto-total-cap", "crypto-volume"].includes(signal.key)
          ? compactDollar(Number(signal.value))
          : `$${Number(signal.value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const signalsUpdatedAt = data?.marketSignalsFetchedAt;
  const signalCards = (data?.marketSignals || [])
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
      return `<article class="fed-market-signal ${signal.available ? "" : "unavailable"}"><span>${tname(ENV_SIGNAL_NAMES, signal.key)}</span>${signal.available ? `<b class="${kind}">${changeText}</b><strong>${value(signal)}</strong><small>${signal.source} · ${txMap(SIGNAL_CADENCE, signal.cadence, tx("快照", "Snapshot"))}</small>` : `<b class="flat">--</b><strong>${tx("暂不可用", "Unavailable")}</strong><small>${txMap(SIGNAL_DETAIL, signal.detail, tx("公开数据暂不可用", "Public data unavailable"))}</small>`}<small class="macro-update-age" data-macro-updated-at="${signalsUpdatedAt || ""}"${signal.available ? "" : ' data-macro-checking="true"'}>${age}</small></article>`;
    })
    .join("");
  const marketPanel = signalCards
    ? `<section class="fed-market-panel"><div><h3>${tx("综合指标", "Market context")}</h3><span>${tx("公开数据 · 每 10 分钟检查", "Public data · checked every 10 min")}</span></div><div class="fed-market-grid">${signalCards}</div></section>`
    : "";
  const correlationPanel = `<section class="fed-corr-panel"><div class="fed-corr-head"><div><h3>${tx(coinLabel() + " × 美股联动", coinLabel() + " × US equities linkage")}</h3><p id="correlationStatus">${tx("等待市场数据…", "Waiting for market data…")}</p></div><button id="refreshCorrelation" type="button">${tx("更新分析", "Refresh analysis")}</button></div><div id="indexTickerCards" class="index-ticker-cards"></div><div id="correlationOutput" class="correlation-output"></div></section>`;
  card.innerHTML = `<div class="fed-monitor-head"><div><h2>${tx("宏观环境与跨市场联动", "Macro environment & cross-market linkage")}</h2><p>${tx("综合指标、美联储公开日历与 BTC × 美股联动同处一卡；事件前后行情波动可能放大，不构成方向预测。", "Market context, the Fed's public calendar and BTC × US equities linkage in one card. Volatility can rise around releases; this is not a directional forecast.")}</p></div><span>${tx("每 10 分钟检查", "Checked every 10 min")}</span></div>${marketPanel}<div class="fed-event-grid">${eventCards || `<article class="fed-event unavailable"><span>${tx("公开日历暂不可用", "Public calendar unavailable")}</span><small>${tx("下次 10 分钟检查会自动重试。", "The next ten-minute check will retry automatically.")}</small></article>`}</div>${correlationPanel}<footer>${nearest ? tx(`最近事件：${tname(MACRO_EVENT_NAMES, nearest.key)}，请在发布前后降低杠杆和仓位集中度。`, `Nearest event: ${tname(MACRO_EVENT_NAMES, nearest.key)}. Consider reducing leverage and concentration around the release.`) : tx("使用 Federal Reserve 与 BLS 的公开发布日历。", "Uses public Federal Reserve and BLS release calendars.")} <em>${data?.cached ? tx("缓存", "Cached") : tx("刚更新", "Updated")}</em></footer>`;
  refreshMacroUpdateAges();
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
    "crypto-total-cap": [
      "全网加密总市值反映整体风险偏好与资产规模，使用 24 小时快照而非实时买卖信号。",
      "Total crypto market cap reflects overall risk appetite and asset size; it uses a 24h snapshot, not a real-time buy/sell signal.",
    ],
    "crypto-volume": [
      "全网 24 小时成交额反映市场参与度；放量不代表必然上涨或下跌。",
      "Total 24h volume reflects market participation; higher volume does not imply a guaranteed move up or down.",
    ],
    "exchange-btc-reserve": [
      "交易所 BTC 钱包余额需要可验证链上数据源；本面板不会用个人账户余额替代。",
      "Exchange BTC wallet balances need a verifiable on-chain source; this panel never substitutes an individual account balance.",
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

/* Investment calendar: a table-first risk window, purpose-built for BTC risk
   windows. It reads the server-side feed so an optional Finnhub key never
   reaches the browser. Every wall-clock decision is made in Beijing time. */
let investmentCalendarData = null;
// The lower timeline is the complete calendar by default. Date shortcuts are
// opt-in views; starting on "today" made future events appear to be missing
// even though the API and the Major events strip already contained them.
let investmentCalendarRange = "today";        // yesterday|today|tomorrow|week|nextweek|custom|all（v2.11.0 起默认「今天」时间流）
/* v2.11.0：事件行「影响预测」展开状态（key = at|title），重渲染后保持。 */
const calendarExpandedRows = new Set();
let investmentCalendarFrom = "";              // yyyy-mm-dd (Beijing day)
let investmentCalendarTo = "";                // yyyy-mm-dd (Beijing day)
let investmentCalendarImportance = new Set(); // empty = all (low|medium|high)
let investmentCalendarRegions = new Set();    // empty = all countries
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
const MACRO_PICKS_KEY = "btc_macro_calendar_picks";
let macroCalendarPicks = new Set();           // at|title keys of user-picked events from investment calendar

function loadMacroCalendarPicks() {
  try {
    const raw = localStorage.getItem(MACRO_PICKS_KEY);
    macroCalendarPicks = new Set(raw ? JSON.parse(raw) : []);
  } catch {
    macroCalendarPicks = new Set();
  }
}
function saveMacroCalendarPicks() {
  try { localStorage.setItem(MACRO_PICKS_KEY, JSON.stringify([...macroCalendarPicks])); } catch {}
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
function macroCalendarPickedEvents(limit = 3) {
  if (!investmentCalendarData?.events) return [];
  const now = Date.now();
  const picked = [...macroCalendarPicks]
    .map(macroCalendarPickEvent)
    .filter(Boolean)
    .sort((a, b) => {
      const ad = Math.abs(a.at - now), bd = Math.abs(b.at - now);
      return ad - bd;
    })
    .slice(0, limit);
  return picked;
}

// 关注宏观事件实时数据：只保留「尚未公布」或「已公布但不超过 30 分钟」的事件，
// 超过 30 分钟后自动移除，让卡片始终聚焦可交易的实时/即将到来的数据。
const MACRO_LIVE_WINDOW_MS = 30 * 60_000;
let macroLiveFetchTimer = null;
function macroCalendarPickedLiveEvent() {
  if (!investmentCalendarData?.events) return null;
  const now = Date.now();
  const picked = [...macroCalendarPicks]
    .map(macroCalendarPickEvent)
    .filter(Boolean)
    .filter((event) => {
      if (event.at > now) return true; // 未公布： upcoming
      return now - event.at <= MACRO_LIVE_WINDOW_MS; // 已公布：30 分钟内
    })
    .sort((a, b) => {
      const ad = Math.abs(a.at - now), bd = Math.abs(b.at - now);
      return ad - bd;
    })[0];
  return picked || null;
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

const calendarEscape = (value) => String(value ?? "--").replace(/[&<>"]/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" })[char]);
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
    case "all": return [now, Infinity];
    case "custom": {
      const from = calendarBeijingDateToMs(investmentCalendarFrom), to = calendarBeijingDateToMs(investmentCalendarTo);
      return [Math.max(now, Number.isFinite(from) ? from : now), Number.isFinite(to) ? to + CALENDAR_DAY : Infinity];
    }
    default: return [now, today + CALENDAR_DAY];
  }
}
const CALENDAR_RANGES = [
  ["today", "今天", "Today"], ["tomorrow", "明天", "Tomorrow"], ["yesterday", "昨天", "Yesterday"],
  ["week", "本周", "This week"], ["nextweek", "下周", "Next week"], ["custom", "自定义日期", "Custom"], ["all", "全部", "All"],
];
const CALENDAR_IMPORTANCE = [["high", "高", "High"], ["medium", "中", "Medium"], ["low", "低", "Low"]];
function calendarWindow(event) {
  const diff = Number(event.at) - Date.now();
  const liquidity = event.category === "liquidity";
  if (/FOMC|美联储利率决议/.test(String(event.title || ""))) return ["宏观核心", "FOMC（联邦公开市场委员会）决定政策利率并发布政策声明；BTC 通常通过美元、实际利率与风险偏好间接受影响", event.importance === "high"];
  if (event.importance === "high" && diff > 0 && diff < 4 * 3_600_000) return [liquidity ? "流动性窗口" : "高波动窗口", liquidity ? "临近财政部操作；关注规模、期限桶及美债利率反应，不预设 BTC 方向" : "发布前 4 小时：避免追单，降低杠杆与仓位集中度", true];
  if (event.importance === "high" && diff > 0 && diff < 24 * 3_600_000) return [liquidity ? "流动性关注" : "风险关注", liquidity ? "24 小时内财政部流动性节点；跟踪操作结果与收益率曲线反应" : "24 小时内高敏感宏观事件；等待预期差确认", true];
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

function renderCalendarEventRow(event) {
  const pickKey = macroCalendarPickKey(event);
  const isPicked = macroCalendarPicks.has(pickKey);
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
  return `<li class="cal-event${hot?" is-hot":""}${isPicked?" is-picked":""}${releasedRow && macroHasActual(event)?" is-released":""}${expandable?" is-expandable":""}${expanded?" is-expanded":""}"${expandable?` data-cal-expand="${calendarEscape(rowKey)}"`:""} data-category="${calendarEscape(event.category||"")}">
    <label class="cal-pick" data-pin-label="${calendarEscape(tx("关注","Pin"))}" data-pinned-label="${calendarEscape(tx("已关注","Pinned"))}" title="${calendarEscape(tx("显示在未来的宏观日历","Pin to upcoming macro calendar"))}">
      <input type="checkbox" data-cal-pick="${calendarEscape(pickKey)}"${isPicked?" checked":""}>
      <i class="cal-pick-ui"></i>
    </label>
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
   研究预测 → A/B 实验中心 → 宏观事件中枢 → 宏观环境与跨市场联动。
   这几张卡由不同异步流程创建/重渲（研究卡约 1s、日历约 3.6s、宏观卡每 10 分钟整卡重渲），
   任一被其他布局逻辑移动后这里负责拉回。链式校正对尚未创建的卡片自动跳过，
   幂等，可安全重复调用。 */
function syncMacroPanels() {
  const chain = [
    $("researchOutlookCard"),
    $("abEvaluationCard"),
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
  const visibleEvents = events.slice(0, investmentCalendarVisibleLimit);
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
  if (!events.length) {
    listHtml = `<li class="cal-empty">${tx("该时间范围内暂无符合条件的更新。", "No events match the current filters in this range.")}</li>`;
  } else {
    listHtml += `<li class="cal-head">
      <span>${tx("时间","Time")}</span><span>${tx("国家","Country")}</span><span>${tx("事件","Event")}</span><span>${tx("重要性","Impact")}</span>
      <span>${tx("今值","Actual")}</span><span>${tx("预期","Forecast")}</span><span>${tx("前值","Previous")}</span><span>${tx("影响","Note")}</span>
    </li>`;
  }
  /* v2.11.0：时间流。「现在」线把今天一分为二：上方已公布、下方即将发布。 */
  const nowMs = Date.now();
  const rangeHasNow = events.some((event) => event.at <= nowMs) && events.some((event) => event.at > nowMs);
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
    listHtml += renderCalendarEventRow(event);
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
  const rankText = `${rangeSummary} · ${tx(`筛选后 ${events.length} 项，已显示 ${visibleEvents.length} 项`, `${events.length} filtered, ${visibleEvents.length} shown`)}`;
  /* v2.11.16 展开/收起控制条。旧版只在「还有更多」时渲染整块，一旦全部展开
     就连同「已显示 N/N」统计一起消失、无路可退。现在改成：只要列表长于折叠态
     就常驻，并按当前状态动态切换按钮与文案（Show more ⇄ Show less，PatternFly
     的标准做法）。 */
  const hasMoreEvents = visibleEvents.length < events.length;
  const isExpanded = investmentCalendarVisibleLimit > INVESTMENT_CALENDAR_BASE_LIMIT;
  const isAllShown = !hasMoreEvents;
  const listScrolls = visibleEvents.length > INVESTMENT_CALENDAR_SCROLL_AFTER;
  const nextVisibleCount = hasMoreEvents
    ? Math.min(visibleEvents.length + INVESTMENT_CALENDAR_STEP, events.length)
    : visibleEvents.length;
  const progressPct = events.length ? Math.round((visibleEvents.length / events.length) * 100) : 100;
  const moreBar = events.length > INVESTMENT_CALENDAR_BASE_LIMIT ? `
    <div class="ic-list-more${isExpanded ? " is-expanded" : ""}">
      <div class="ic-more-actions">
        ${hasMoreEvents ? `<button type="button" class="ic-more-btn" data-calendar-more>${tx(`继续展开 ${INVESTMENT_CALENDAR_STEP} 条`, `Show ${INVESTMENT_CALENDAR_STEP} more`)}<i class="ic-caret"></i></button>` : ""}
        ${hasMoreEvents && events.length > nextVisibleCount ? `<button type="button" class="ic-more-btn is-ghost" data-calendar-all>${tx(`全部展开（${events.length} 条）`, `Show all ${events.length}`)}</button>` : ""}
        ${isExpanded ? `<button type="button" class="ic-more-btn is-less" data-calendar-less><i class="ic-caret up"></i>${isAllShown ? tx("收起全部", "Collapse all") : tx("收起", "Collapse")}</button>` : ""}
      </div>
      <div class="ic-more-progress" title="${calendarEscape(tx(`已显示 ${visibleEvents.length} / ${events.length} 条`, `${visibleEvents.length} / ${events.length} shown`))}">
        <span><b>${tx("已显示", "Showing")} ${visibleEvents.length} / ${events.length}</b>${isAllShown ? `<em>· ${tx("全部", "all")}</em>` : ""}</span>
        <i class="ic-more-track"><i class="ic-more-fill" style="width:${progressPct}%"></i></i>
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
      </div>
      <button type="button" class="ic-filter-toggle" data-calendar-toggle-filters>${investmentCalendarShowFilters ? tx("隐藏筛选器","Hide filters") : tx("显示筛选器","Show filters")}<i class="ic-caret${investmentCalendarShowFilters?" up":""}"></i></button>
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
    resetInvestmentCalendarVisibleLimit();
    calendarOpenMenu = null;
    renderInvestmentCalendar(investmentCalendarData);
  }));
  card.querySelector("[data-calendar-toggle-filters]")?.addEventListener("click", () => {
    investmentCalendarShowFilters = !investmentCalendarShowFilters;
    calendarOpenMenu = null;
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
  // —— Pin events to the macro calendar (max 3) ——
  card.querySelectorAll("[data-cal-pick]").forEach((box) => box.addEventListener("change", () => {
    const key = box.dataset.calPick;
    if (box.checked) {
      if (macroCalendarPicks.size >= 3) {
        // 达到上限：移除最早勾选的，保持最多 3 个
        const first = macroCalendarPicks.values().next().value;
        macroCalendarPicks.delete(first);
      }
      macroCalendarPicks.add(key);
    } else {
      macroCalendarPicks.delete(key);
    }
    saveMacroCalendarPicks();
    renderInvestmentCalendar(investmentCalendarData);
    renderFearGreedGauge();
    renderReleasedDataCard();
  }));
  // —— v2.11.0：点事件行展开 / 收起「情景 × 资产」影响预测矩阵 ——
  card.querySelectorAll("li.cal-event[data-cal-expand]").forEach((li) => li.addEventListener("click", (event) => {
    if (event.target.closest("label.cal-pick")) return;
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
/* 未来的宏观日历：只显示用户从投资日历勾选的事件（最多 3 个）。
   未勾选时保持空白，提示用户去投资日历勾选。 */
function upcomingMacroEvents(limit = 4) {
  const now = Date.now();
  return macroCalendarPickedEvents(limit)
    .filter((event) => event.at > now)
    .sort((a, b) => a.at - b.at)
    .slice(0, limit);
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
  // 卡片内直接展示关注宏观事件的实时数据：最近勾选、且未公布或公布后 30 分钟内的事件。
  const pinnedNow = macroCalendarPickedLiveEvent();
  const emptyText = pinnedNow
    ? tx("该事件已公布超过 30 分钟，已自动移除。在投资日历或「重大事件」卡片勾选新的事件即可继续查看实时数据。", "This release was published more than 30 minutes ago and has been removed. Pin a new macro or major event in the investment calendar to see live data again.")
    : tx("在投资日历列表中勾选关注的宏观或重大事件，北京时间、倒计时、预期/前值/实际与阈值式解读会显示在这里", "Pin a macro or major event in the investment calendar list to see its Beijing time, countdown, estimate/previous/actual and threshold read-through here");
  const body = pinnedNow
    ? renderPinnedRelease(pinnedNow)
    : `<p class="macro-cmp-empty">${emptyText}</p>`;
  card.className = "card fear-greed-gauge-card fear-greed-compact";
  card.innerHTML = `<div class="fear-greed-head"><h2>${tx("关注宏观事件实时数据", "Pinned macro release")}</h2><span>${tx("实时数据", "Live data")}</span></div><div class="fear-greed-compact-grid macro-sentiment-grid">${body}</div>`;
  addHelp(
    card.querySelector(".fear-greed-head h2"),
    "这里直接展示你最近勾选的宏观事件或重大事件实时数据：北京时间、倒计时、预期/前值/实际，以及「高于/低于锚点分别对 BTC 属于利好还是利空」的阈值式解读。可在投资日历列表中勾选关注；事件公布超过 30 分钟后会自动移除；未公布事件在公布前后 2 分钟内会高频刷新，第一时间抓取实际值。恐惧贪婪指数已从该卡移除；宏观经济数据已独立成卡，位于「BTC 多因子研究」与「投资日历」之间。",
    "This card shows the pinned macro or major event live data: Beijing time, countdown, estimate/previous/actual, and a threshold read-through (above/below the anchor → bullish or bearish for BTC). You can pin events either from the investment calendar list or from the Major events card; released events are removed after 30 minutes, and upcoming events are polled every 15 seconds around release time to capture actuals as soon as they appear. The Fear & Greed index has been removed from this card; macroeconomic data now lives in its own card between the BTC multi-factor research and the investment calendar.",
  );
  if (!macroCountdownTimer) {
    // 秒级刷新，让「关注事件」的倒计时真正在跳。
    macroCountdownTimer = setInterval(refreshMacroCompareCountdowns, 1000);
  }
  manageMacroLiveFetch();
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

/* 技术指标保持紧凑，OKX 公开微观结构单独呈现，以突出实时证据。
   Keep technical indicators compact, and give OKX public microstructure a
   dedicated card so live derivatives evidence is not mistaken for an EMA/RSI. */
let microstructureNeutralExpanded = false;
function renderOkxMicrostructure(context) {
  let card = $("okxMicrostructureCard"),
    layout = document.querySelector(".terminal-layout");
  if (!card) {
    card = document.createElement("section");
    card.id = "okxMicrostructureCard";
    card.className = "card okx-microstructure-card";
  }
  // v2.10.56：作为左列的独立第二张卡，紧跟 K 线卡之后（.chart-column 平级排列）。
  // A separate grid row would inherit the height of the much taller right
  // column and leave a blank gap; the chart column stack avoids that.
  const chartCard = $("mainChartCard");
  const chartColumn = chartCard?.parentElement;
  if (
    chartCard &&
    chartColumn?.classList.contains("chart-column") &&
    card.parentElement !== chartColumn
  )
    chartCard.after(card);
  else if (!card.isConnected) document.querySelector("main")?.append(card);
  if (!card) return;
  if (context?.source !== "okx") {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const book = context.orderBook,
    flow = context.takerFlow,
    oiChange = context.oiChangePct,
    fundingChange = context.fundingChangePct,
    priceChange = context.priceChangePct;
  const tone = (value, positive = 12, negative = -12) =>
    !Number.isFinite(value)
      ? "flat"
      : value >= positive
        ? "bull"
        : value <= negative
          ? "bear"
          : "flat";
  const label = (kind) =>
    kind === "bull"
      ? tx("偏多", "Bullish")
      : kind === "bear"
        ? tx("偏空", "Bearish")
        : tx("中性", "Neutral");
  const percent = (value) =>
    Number.isFinite(value)
      ? `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`
      : "--";
  const bookKind = tone(book?.imbalancePct),
    flowKind = tone(flow?.imbalancePct, 14, -14);
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
  const basisKind =
    Math.abs(context.basisPct || 0) >= 0.12
      ? context.basisPct > 0
        ? "bear"
        : "bull"
      : "flat";
  const premiumKind = Number.isFinite(context.premiumPct)
      ? Math.abs(context.premiumPct) >= 0.05
        ? context.premiumPct > 0
          ? "bear"
          : "bull"
        : "flat"
      : "flat",
    cvd = context.takerFlow?.cvdSessionNotional,
    spread = context.orderBook?.spreadBps;
  const compact = (value, currency = false) => {
    if (!Number.isFinite(value)) return "—";
    const abs = Math.abs(value),
      unit =
        abs >= 1e9
          ? [1e9, "B"]
          : abs >= 1e6
            ? [1e6, "M"]
            : abs >= 1e3
              ? [1e3, "K"]
              : [1, ""];
    return `${value < 0 ? "−" : ""}${currency ? "$" : ""}${(abs / unit[0]).toFixed(currency ? 1 : 2).replace(/\.0+$/, "")}${unit[1]}`;
  };
  const rows = [
    {
      name: tx("盘口失衡", "Order-book imbalance"),
      value: book ? percent(book.imbalancePct) : "—",
      note: book
        ? tx(
            `深度比 ${Number.isFinite(book.ratio) ? book.ratio.toFixed(2) + "×" : "—"} · 前5档`,
            `Depth ratio ${Number.isFinite(book.ratio) ? book.ratio.toFixed(2) + "×" : "—"} · top 5`,
          )
        : tx("等待 OKX 盘口快照", "Waiting for the OKX book snapshot"),
      kind: bookKind,
      tip: tx(
        "前 5 档挂单深度的买卖差。挂单可以快速撤销，所以只作为短线确认，不能单独开仓。",
        "Difference between top-five bid and ask depth. Orders can vanish quickly, so use only as short-term confirmation.",
      ),
    },
    {
      name: tx("主动成交比", "Taker flow"),
      value: flow ? `${flow.buyRatioPct.toFixed(1)}%` : "—",
      note: flow
        ? tx(
            `买入占比 · ${flow.windowSeconds}秒窗口`,
            `Buy ratio · ${flow.windowSeconds}s window`,
          )
        : tx("正在积累 60 秒成交窗口", "Building a 60-second trade window"),
      kind: flowKind,
      tip: tx(
        "统计最近 60 秒实际主动买入与卖出成交，不是静态挂单；短线有效，但变化也很快。",
        "Measures executed taker buying and selling over 60 seconds, not resting orders; useful short-term but fast-changing.",
      ),
    },
    {
      name: tx("持仓量 OI", "Open interest"),
      value: compact(context.oi),
      note: Number.isFinite(context.oi)
        ? tx(
            `${context.oiUnit || "BTC"} · OI ${Number.isFinite(oiChange) ? percent(oiChange) : "—"}`,
            `${context.oiUnit || "BTC"} · OI ${Number.isFinite(oiChange) ? percent(oiChange) : "—"}`,
          )
        : tx("需积累约 5 分钟快照", "Needs about five minutes of snapshots"),
      kind: oiKind,
      tip: tx(
        "价格与 OI 同涨常代表新多参与；价格跌、OI 升常代表新空参与。OI 下降更多表示去杠杆，并不自动等于反转。",
        "Price and OI rising together can indicate new longs; price down with OI up can indicate new shorts. Falling OI often means deleveraging, not necessarily reversal.",
      ),
    },
    {
      name: tx("资金费率趋势", "Funding-rate trend"),
      value: Number.isFinite(context.fundingRate)
        ? formatRate(context.fundingRate)
        : "--",
      note: Number.isFinite(fundingChange)
        ? tx(
            `约 ${context.fundingChangeWindowSeconds || 0} 秒变化 ${percent(fundingChange)}`,
            `~${context.fundingChangeWindowSeconds || 0}s change ${percent(fundingChange)}`,
          )
        : tx("需积累约 1 小时快照", "Needs about one hour of snapshots"),
      kind: fundingKind,
      tip: tx(
        "正费率表示多头向空头付费，负费率相反。费率明显单边上升或下降，是拥挤风险提醒而不是方向保证。",
        "Positive funding means longs pay shorts; negative is the reverse. A strong trend flags crowding risk, not a direction guarantee.",
      ),
    },
    {
      name: tx("永续价差", "Perpetual basis"),
      value: Number.isFinite(context.basisPct)
        ? percent(context.basisPct)
        : "—",
      note:
        Number.isFinite(context.perpPrice) && Number.isFinite(context.spotPrice)
          ? tx("永续 vs 现货基差", "Perpetual vs spot basis")
          : tx("等待现货与永续报价", "Waiting for spot and perpetual quotes"),
      kind: basisKind,
      tip: tx(
        "永续相对现货的溢价或贴水。价差过大时，通常说明杠杆一侧更拥挤，应提高追单门槛。",
        "Premium or discount of the perpetual versus spot. An extreme gap can signal leveraged crowding and should raise the bar for chasing.",
      ),
    },
    {
      name: tx("溢价指数", "Premium index"),
      value: Number.isFinite(context.premiumPct)
        ? percent(context.premiumPct)
        : "—",
      note: Number.isFinite(context.premiumPct)
        ? tx("资金费率的领先拥挤线索", "Lead signal for funding crowding")
        : tx("OKX 公开数据正在重试", "Retrying OKX public data"),
      kind: premiumKind,
      tip: tx(
        "OKX 永续的溢价历史读数。明显正溢价代表多头付费更高，明显负溢价代表空头付费更高；它是拥挤过滤，不是方向指令。",
        "OKX perpetual premium history. Strong positive premium can signal costly longs; negative premium can signal costly shorts. It is a crowding filter, not a direction order.",
      ),
    },
    {
      name: "CVD",
      value: compact(cvd, true),
      note: Number.isFinite(cvd)
        ? tx(
            `主动买卖累计差 · ${Number.isFinite(spread) ? spread.toFixed(2) + " bps" : "价差采集中"}`,
            `Session taker delta · ${Number.isFinite(spread) ? spread.toFixed(2) + " bps" : "spread collecting"}`,
          )
        : tx("正在积累会话成交数据", "Building session trade data"),
      kind: Number.isFinite(cvd)
        ? cvd > 0
          ? "bull"
          : cvd < 0
            ? "bear"
            : "flat"
        : "flat",
      tip: tx(
        "CVD 是主动买入减主动卖出的累计名义额；若它与价格方向背离，趋势可信度下降。价差衡量执行成本，变宽时不宜追单。",
        "CVD is cumulative taker-buy minus taker-sell notional. Divergence from price weakens a trend. Spread measures execution cost; avoid chasing when it widens.",
      ),
    },
    {
      name: tx("爆仓热力", "Liquidation heat"),
      value: "—",
      note: tx("公开数据暂不可用", "Public feed unavailable"),
      kind: "flat",
      tip: tx(
        "当前 OKX V5 公共数据源没有返回可验证的 " + coinMetaOf().okx.swap + " 清算流，因此本卡不会用推测值替代。",
        "The current OKX V5 public feed is not returning a verifiable " + coinMetaOf().okx.swap + " liquidation stream.",
      ),
    },
    {
      name: tx("大户多空比", "Top-trader ratio"),
      value: "—",
      note: tx("公开数据暂不可用", "Public feed unavailable"),
      kind: "flat",
      tip: tx(
        "当前 OKX V5 公共数据源没有返回可验证的大户持仓多空比。本卡保持不可用，避免把模型猜测当成交易所统计。",
        "The current OKX V5 public feed is not returning a verifiable top-trader position ratio.",
      ),
    },
  ];
  const directional = [bookKind, flowKind, oiKind],
    bull = directional.filter((x) => x === "bull").length,
    bear = directional.filter((x) => x === "bear").length;
  let conclusion = tx("观望", "Wait"),
    conclusionKind = "flat",
    reason = tx(
      "盘口、主动成交与 OI 尚未形成两个以上同向确认。",
      "Order book, taker flow and OI do not yet have two aligned confirmations.",
    );
  if (bull >= 2) {
    conclusion = tx("短线研究偏多", "Short-term research bullish");
    conclusionKind = "bull";
    reason = tx(
      "盘口、主动成交和 OI 中至少两项偏多；仍需结合 K 线收盘确认。",
      "At least two of order book, taker flow and OI lean bullish; still wait for candle-close confirmation.",
    );
  } else if (bear >= 2) {
    conclusion = tx("短线研究偏空", "Short-term research bearish");
    conclusionKind = "bear";
    reason = tx(
      "盘口、主动成交和 OI 中至少两项偏空；仍需结合 K 线收盘确认。",
      "At least two of order book, taker flow and OI lean bearish; still wait for candle-close confirmation.",
    );
  }
  const meterLevel = (row) => {
    if (row === rows[0])
      return Math.max(8, Math.min(92, 50 + (book?.imbalancePct || 0) * 1.5));
    if (row === rows[1])
      return Math.max(
        8,
        Math.min(
          92,
          Number.isFinite(flow?.buyRatioPct) ? flow.buyRatioPct : 50,
        ),
      );
    if (row === rows[2])
      return Number.isFinite(oiChange)
        ? Math.max(10, Math.min(90, 50 + oiChange * 70))
        : 50;
    if (row === rows[3])
      return Number.isFinite(fundingChange)
        ? Math.max(10, Math.min(90, 50 + fundingChange * 8000))
        : 50;
    if (row === rows[4])
      return Number.isFinite(context.basisPct)
        ? Math.max(10, Math.min(90, 50 + context.basisPct * 160))
        : 50;
    if (row === rows[5])
      return Number.isFinite(context.premiumPct)
        ? Math.max(10, Math.min(90, 50 + context.premiumPct * 300))
        : 50;
    if (row === rows[6])
      return Number.isFinite(cvd)
        ? Math.max(10, Math.min(90, 50 + cvd / 1_500_000))
        : 50;
    return 50;
  };
  const alert = [
    fundingKind === "bear" &&
      tx(
        "资金费率上升，注意多头拥挤。",
        "Funding is rising; watch long crowding.",
      ),
    fundingKind === "bull" &&
      tx(
        "资金费率走低，注意空头拥挤。",
        "Funding is falling; watch short crowding.",
      ),
    premiumKind === "bear" &&
      tx(
        "溢价偏高，降低追多优先级。",
        "Premium is elevated; lower the priority of chasing longs.",
      ),
    premiumKind === "bull" &&
      tx(
        "溢价偏低，注意空头拥挤。",
        "Premium is depressed; watch short crowding.",
      ),
    Number.isFinite(spread) &&
      spread >= 3 &&
      tx(
        "盘口价差变宽，降低执行优先级。",
        "The book spread is wide; lower execution priority.",
      ),
  ].find(Boolean);
  const currentMeaning = [
    book
      ? `当前买卖深度差为 ${percent(book.imbalancePct)}，前 5 档买盘约为卖盘的 ${Number.isFinite(book.ratio) ? book.ratio.toFixed(2) : "—"} 倍；${bookKind === "bull" ? "眼下挂单更偏向买方，短线标为偏多" : bookKind === "bear" ? "眼下挂单更偏向卖方，短线标为偏空" : "买卖挂单接近，方向暂不明确"}。`
      : "当前还未拿到可用盘口快照，不能据此判断买卖力量。",
    flow
      ? `当前 ${flow.windowSeconds} 秒内主动买入占 ${flow.buyRatioPct.toFixed(1)}%；${flowKind === "bull" ? "买方正在主动吃掉卖盘，短线标为偏多" : flowKind === "bear" ? "卖方正在主动压低成交，短线标为偏空" : "主动买卖大致均衡"}。`
      : "当前正在积累成交窗口，暂不对买卖主动性下结论。",
    Number.isFinite(oiChange) && Number.isFinite(priceChange)
      ? `当前 OI 约变化 ${percent(oiChange)}，价格约变化 ${percent(priceChange)}；${oiKind === "bull" ? "价格和持仓同步上升，较像新多头参与" : oiKind === "bear" ? "价格走弱而持仓上升，较像新空头参与" : "两者没有形成清晰的同向新仓信号"}。`
      : "OI 的比较样本仍在积累，暂不判断新多或新空。",
    Number.isFinite(context.fundingRate)
      ? `当前资金费率为 ${formatRate(context.fundingRate)}，近 ${context.fundingChangeWindowSeconds || 0} 秒变化 ${percent(fundingChange)}；${fundingKind === "bear" ? "多头付费压力在升高，需防多头拥挤" : fundingKind === "bull" ? "空头付费压力在升高，需防空头拥挤" : "暂未显示明显的一边拥挤"}。`
      : "当前尚无可用资金费率，不能判断哪一方的杠杆更拥挤。",
    Number.isFinite(context.basisPct)
      ? `当前永续相对现货价差为 ${percent(context.basisPct)}；${basisKind === "flat" ? "幅度不大，未显示明显拥挤" : "价差偏大，说明杠杆一侧可能拥挤"}。`
      : "尚未同时拿到现货和永续报价，无法判断价差。",
    Number.isFinite(context.premiumPct)
      ? `当前溢价指数为 ${percent(context.premiumPct)}；${premiumKind === "flat" ? "暂未显示明显拥挤" : "提示一侧杠杆成本可能偏高，应避免追单"}。`
      : "当前溢价指数不可用，因此不作拥挤判断。",
    Number.isFinite(cvd)
      ? `当前会话 CVD 为 ${compact(cvd, true)}；${cvd > 0 ? "累计主动买入多于主动卖出，买方成交更占优" : cvd < 0 ? "累计主动卖出多于主动买入，卖方成交更占优" : "主动买卖累计接近平衡"}。`
      : "会话成交数据仍在积累，暂不判断买卖主动性。",
    "当前没有可验证的公开数据，所以此卡不会用猜测值代替。",
    "当前没有可验证的公开数据，所以此卡不会用猜测值代替。",
  ];
  rows.forEach((row, index) => {
    row.tip = `${currentMeaning[index]} ${row.tip}`;
  });
  const directionalRows = rows.filter((row) => row.kind !== "flat"),
    neutralRows = rows.filter((row) => row.kind === "flat"),
    gridClass = (items) =>
      items.length % 2 === 0 ? "is-even" : "is-odd";
  const rowHtml = (row) =>
    `<article class="microstructure-item ${row.kind}${row.value === "—" ? " unavailable" : ""}" style="--micro-level:${meterLevel(row).toFixed(1)}%"><div><span>${row.name}<button class="help-dot" type="button" data-tip="${row.tip}" aria-label="${tx("查看说明", "Show explanation")}">!</button></span><i>${label(row.kind)}</i></div><b>${row.value}</b><small>${row.note}</small><div class="microstructure-meter" aria-label="${tx("指标强度", "Indicator strength")}"><em></em></div></article>`;
  const neutralSection = neutralRows.length
    ? `<section class="microstructure-neutral-group ${microstructureNeutralExpanded ? "is-expanded" : ""}"><button type="button" class="microstructure-neutral-toggle" aria-expanded="${microstructureNeutralExpanded}"><span>${tx("中性指标", "Neutral indicators")} · ${neutralRows.length} ${tx("项", "items")}</span><b>${microstructureNeutralExpanded ? tx("收起", "Hide") : tx("展开", "Show")}</b></button><div class="microstructure-grid microstructure-neutral-grid ${gridClass(neutralRows)} ${microstructureNeutralExpanded ? "" : "is-collapsed"}" ${microstructureNeutralExpanded ? "" : "hidden"}>${neutralRows.map(rowHtml).join("")}</div></section>`
    : "";
  card.innerHTML = `<div class="microstructure-head"><div><h2>${tx("OKX 市场微观结构", "OKX market microstructure")} <button class="help-dot" type="button" data-tip="${tx("来自 OKX " + coinMetaOf().okx.swap + " 永续的公开 WebSocket：盘口、最新成交、持仓量、资金费率与现货/永续价格。用于 5 分钟到 1 小时的短线确认，不保证预测正确。", "Public OKX WebSocket data for BTC-USDT perpetual: order book, recent trades, OI, funding and spot/perpetual prices. It supports 5m–1h confirmation, not guaranteed prediction.")}">!</button></h2><p>${tx("盘口与成交实时 · OI、费率持续更新", "Live order book and trades · continuously updated OI and funding")}</p></div><span>${context.transport === "websocket" ? tx("OKX WebSocket", "OKX WebSocket") : tx("REST 备用", "REST fallback")}</span></div><div class="microstructure-conclusion ${conclusionKind}"><b>${conclusion}</b><p>${reason}</p></div><div class="microstructure-grid ${gridClass(directionalRows)}">${directionalRows.map(rowHtml).join("")}</div>${neutralSection}`;
  card.querySelector(".microstructure-neutral-toggle")?.addEventListener("click", () => {
    microstructureNeutralExpanded = !microstructureNeutralExpanded;
    renderOkxMicrostructure(context);
  });
  if (alert) {
    const warning = document.createElement("p");
    warning.className = "microstructure-alert";
    warning.textContent = `⚠ ${alert}`;
    warning.title = alert;
    card.append(warning);
  }
}
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
    "3h": 180,
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
addFixedRuleSignalEnhancer("signal-gauge", () => {
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
addFixedRuleSignalEnhancer("signal-projection", () => {
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
  if (period) return period;
  period = document.createElement("section");
  period.id = "periodChangeCard";
  period.className = "card change-card chart-periods";
  period.innerHTML = `<h2>${tx("周期涨幅（当前价 vs 历史收盘价）", "Period return (current vs historical close)")}</h2><div id="changeTags"></div>`;
  return period;
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
  // 宏观与情绪的位置统一交给 responsive arrange()：桌面端在右侧 side-stack，
  // 移动端在 terminal-layout 之后。避免多处代码反复移动导致闪烁。
  window.arrangeTerminalLayout?.();
  scheduleMicrostructureAlignment();
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
let researchOutlookLoading = false;
const safeText = (value) =>
  String(value ?? "").replace(
    /[&<>'"]/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[
        char
      ],
  );
const safeHref = (value) => {
  try {
    const url = new URL(String(value || ""));
    return /^https?:$/.test(url.protocol) ? url.href : "#";
  } catch {
    return "#";
  }
};
function ensureResearchOutlookCard() {
  let card = $("researchOutlookCard");
  if (!card) {
    card = document.createElement("section");
    card.id = "researchOutlookCard";
    card.className = "card research-outlook-card";
  }
  // Keep the reading order: resonance → pattern interpretation → research → macro data → calendar.
  const pattern = $("patternAnalysis"),
    resonance =
    document.querySelector("main > .optional") ||
    document.querySelector(".optional");
  if (pattern) pattern.after(card);
  else if (resonance) resonance.after(card);
  else document.querySelector("main")?.append(card);
  // v2.11.9：研究卡之后的整条链（A/B 实验中心 → 宏观事件中枢 → 宏观环境与联动）
  // 统一交给 syncMacroPanels 校正。这里不再单独把日历卡搬到研究卡后面，
  // 否则会把夹在中间的 A/B 实验中心顶开。
  syncMacroPanels();
  return card;
}
function researchDirectionText(direction) {
  return direction === "up"
    ? tx("上涨预期", "Upside expected")
    : direction === "down"
      ? tx("下跌预期", "Downside expected")
      : tx("稳定 / 震荡", "Stable / range");
}
function researchDirectionClass(direction) {
  return direction === "up" ? "bull" : direction === "down" ? "bear" : "flat";
}
function researchAge(value) {
  return Number.isFinite(value) ? pointTime(value) : tx("刚刚", "Just now");
}
// Probability wording separates confidence strength from the side that has the edge.
// 概率文案将“信号强度”与“哪一侧占优”分开表达。
function researchProbabilityLabel(probability) {
  const isUp = probability >= 50,
    confidence = isUp ? probability : 100 - probability,
    side = isUp ? "bull" : "bear";
  if (confidence < 56)
    return {
      kind: "flat",
      side,
      title: tx("中性震荡", "Neutral range"),
      detail: tx(
        isUp
          ? `偏多 ${confidence.toFixed(1)}%`
          : `偏空 ${confidence.toFixed(1)}%`,
        isUp
          ? `Slightly bullish ${confidence.toFixed(1)}%`
          : `Slightly bearish ${confidence.toFixed(1)}%`,
      ),
    };
  if (confidence < 65)
    return {
      kind: side,
      side,
      title: tx(
        isUp ? "轻度看多" : "轻度看空",
        isUp ? "Mildly bullish" : "Mildly bearish",
      ),
      detail: tx(
        isUp
          ? `上涨概率 ${confidence.toFixed(1)}%`
          : `下跌概率 ${confidence.toFixed(1)}%`,
        isUp
          ? `Up probability ${confidence.toFixed(1)}%`
          : `Down probability ${confidence.toFixed(1)}%`,
      ),
    };
  return {
    kind: side,
    side,
    title: tx(
      isUp ? "看多占优" : "看空占优",
      isUp ? "Bullish advantage" : "Bearish advantage",
    ),
    detail: tx(
      isUp
        ? `上涨概率 ${confidence.toFixed(1)}%`
        : `下跌概率 ${confidence.toFixed(1)}%`,
      isUp
        ? `Up probability ${confidence.toFixed(1)}%`
        : `Down probability ${confidence.toFixed(1)}%`,
    ),
  };
}
// Three-class wording: the largest of up / flat / down leads, and all three probabilities
// are printed so a 12% "up" can never be read as a conviction call.
// 三分类文案：偏多 / 震荡 / 偏空中概率最高者领先，并同时打印三个概率，避免 12% 的「偏多」被读成强烈信号。
function researchClassLabel(window) {
  const up = Number(window.upProbability) * 100,
    flat = Number(window.flatProbability) * 100,
    down = Number(window.downProbability) * 100,
    ranked = [
      { key: "up", value: up, side: "bull", title: tx("偏多占优", "Bullish lead") },
      { key: "flat", value: flat, side: "flat", title: tx("中性震荡", "Neutral range") },
      { key: "down", value: down, side: "bear", title: tx("偏空占优", "Bearish lead") },
    ].sort((a, b) => b.value - a.value),
    lead = ranked[0];
  return {
    kind: lead.key === "flat" ? "flat" : lead.side,
    side: lead.side,
    title: lead.title,
    up,
    flat,
    down,
    detail: `${tx("偏多", "Up")} ${up.toFixed(1)}% · ${tx("震荡", "Flat")} ${flat.toFixed(1)}% · ${tx("偏空", "Down")} ${down.toFixed(1)}%`,
  };
}
/* v2.11.9：缓存最近一次渲染入参。研究卡与 A/B 卡都是整卡渲染（不像多数卡片那样
   逐节点替换文案），语言切换时必须用同一份数据就地重渲，标题与文案才会跟着走。 */
let researchOutlookData = null;
function renderResearchOutlook(data) {
  researchOutlookData = data || researchOutlookData;
  const card = ensureResearchOutlookCard();
  if (!card) return;
  const newsItems = (data.news?.items || []).slice(0, 6),
    newsRows = (items) =>
      items
        .map((item) => {
          const title = safeText(item.title),
            href = safeHref(item.url),
            category = safeText(item.category || "market");
          return `<li class="${item.sentiment > 0 ? "bull" : item.sentiment < 0 ? "bear" : "flat"}"><i>${item.sentiment > 0 ? tx("利好", "Positive") : item.sentiment < 0 ? tx("利空", "Negative") : tx("中性", "Neutral")}</i>${href === "#" ? `<span title="${title}">${title}</span>` : `<a href="${href}" target="_blank" rel="noopener noreferrer" title="${title}">${title}</a>`}<small>${safeText(item.source || "")} · ${category}</small></li>`;
        })
        .join("") ||
      `<li class="flat"><span>${tx("该时间窗暂无可用 " + coinLabel() + " 新闻。", "No " + coinLabel() + " headline is available in this window.")}</span></li>`,
    twoHourItems = newsItems.filter(
      (item) =>
        Number.isFinite(item.publishedAt) &&
        Date.now() - item.publishedAt <= 2 * 3_600_000,
    ),
    newsPanel = `<div class="research-news"><h3>${tx(coinLabel() + " 重点新闻（可点击查看原文）", coinLabel() + " priority headlines (click to open)")}</h3><div class="research-news-windows"><section><h4>${tx("近 2 小时", "Last 2 hours")}</h4><ul>${newsRows(twoHourItems)}</ul></section><section><h4>${tx("近 24 小时", "Last 24 hours")}</h4><ul>${newsRows(newsItems)}</ul></section></div></div>`,
    headlineRows = newsRows(newsItems);
  const windows = (data.windows || [])
    .map((window) => {
      const move = Number(window.expectedMove),
        ret = Number(window.expectedReturn) * 100,
        prob = Number(window.upProbability) * 100,
        quality = Math.round(Number(window.matchQuality || 0) * 100),
        range = window.priceRange || {},
        label = researchClassLabel(window),
        band = Number(window.theta);
      return `<article class="research-window ${label.kind}"><span>${safeText(txWinLabel(window.label))} · ${tx({ bull: "牛市", bear: "熊市", range: "震荡" }[window.regime] || "未知", { bull: "Bull", bear: "Bear", range: "Range" }[window.regime] || "Unknown")}</span><b>${label.title}</b><strong class="${label.side}">${label.detail}</strong><em>${tx("预期变动", "Expected move")} ${move >= 0 ? "+" : "−"}${money(Math.abs(move))} (${ret >= 0 ? "+" : "−"}${Math.abs(ret).toFixed(2)}%)</em><small>${tx("价格区间 P10/P50/P90", "Price range P10/P50/P90")}：${money(range.p10)} / ${money(range.p50)} / ${money(range.p90)}</small><small>${tx("中性阈带", "Neutral band")} ±${Number.isFinite(band) ? (band * 100).toFixed(2) : "--"}%${Number.isFinite(band) ? `（${tx("涨跌幅超过该幅度才算有方向", "a move must exceed this to count as directional")}）` : ""}</small><small>${tx("匹配质量", "Match quality")} ${quality}% · n=${window.samples}/${window.candidateCount}</small></article>`;
    })
    .join("");
  const news = data.news || {},
    history = data.historical || {},
    sentiment = data.sentiment,
    derivatives = data.derivatives,
    eventRisk = data.eventRisk || [];
  const structuralTone = (value) =>
    !Number.isFinite(value)
      ? "flat"
      : value > 0
        ? "bull"
        : value < 0
          ? "bear"
          : "flat";
  const derivativeSummary = derivatives
    ? `<div class="research-derivatives"><h3>${tx("市场结构（短周期仅在可验证特征上加权）", "Market structure (short horizon uses validated features only)")}</h3><div><span class="${structuralTone(derivatives.bookImbalancePct)}">${tx("盘口", "Book")} <b>${Number.isFinite(derivatives.bookImbalancePct) ? pct(derivatives.bookImbalancePct) : "--"}</b></span><span class="${structuralTone(derivatives.takerImbalancePct)}">${tx("主动成交", "Taker flow")} <b>${Number.isFinite(derivatives.takerImbalancePct) ? pct(derivatives.takerImbalancePct) : "--"}</b></span><span class="${structuralTone(derivatives.cvdSessionNotional)}">${tx("CVD（会话）", "CVD (session)")} <b>${Number.isFinite(derivatives.cvdSessionNotional) ? money(derivatives.cvdSessionNotional) : "--"}</b></span><span class="${structuralTone(derivatives.oiChangePct)}">OI Δ <b>${Number.isFinite(derivatives.oiChangePct) ? pct(derivatives.oiChangePct) : "--"}</b></span><span class="flat">${tx("资金费率", "Funding")} <b>${Number.isFinite(derivatives.fundingRate) ? `${(derivatives.fundingRate * 100).toFixed(4)}%` : "--"}</b></span><span class="${structuralTone(derivatives.ofiPct)}">OFI <b>${Number.isFinite(derivatives.ofiPct) ? pct(derivatives.ofiPct) : tx("采集中", "Collecting")}</b></span></div><small>${tx("暂不入模", "Excluded until time-aligned history is sufficient")}：${(derivatives.collecting || []).map(safeText).join(" · ")} · ${tx("未接入", "Not connected")}：${derivatives.unavailable.map(safeText).join(" · ")}</small></div>`
    : `<div class="research-derivatives unavailable"><h3>${tx("市场结构", "Market structure")}</h3><small>${tx("OKX 微观结构暂不可用，本次预测未计入该层。", "OKX microstructure is unavailable and is not included in this research run.")}</small></div>`;
  const eventBanner = eventRisk.length
    ? `<div class="research-event-risk"><b>${tx("事件待定", "Event pending")}</b><span>${safeText(eventRisk.join(" · "))} ${tx("将在 24 小时内公布：预测区间已应扩大解读。", "is due within 24 hours: interpret forecast ranges more broadly.")}</span></div>`
    : "";
  // Scorecard combines chronological held-out validation with only settled live predictions; pending rows are never counted as hits.
  // 记分卡同时展示按时间保留的验证结果和已结算实时预测；未到期预测绝不会计入命中率。
  const scorecard = data.scorecard || {},
    scoreRows = (data.windows || [])
      .map((window) => {
        const live = scorecard.rows?.[window.key],
          pending = scorecard.pending?.[window.key] || 0,
          validation = window.validation,
          quality = validation
            ? `${tx("验证（仅方向样本）", "Validation (directional rows only)")} ${validation.directionalSamples || validation.samples}/${validation.totalSamples || validation.samples} · ${tx("震荡占比", "chop rate")} ${Number.isFinite(validation.flatRate) ? `${(validation.flatRate * 100).toFixed(0)}%` : "--"} · ${tx("命中", "Hit")} ${(validation.accuracy * 100).toFixed(1)}% · Brier ${validation.brier.toFixed(3)} · BSS ${Number.isFinite(validation.brierSkill) ? `${(validation.brierSkill * 100).toFixed(1)}%` : "--"} · ECE ${Number.isFinite(validation.ece) ? `${(validation.ece * 100).toFixed(1)}%` : "--"} · AUC ${Number.isFinite(validation.auc) ? validation.auc.toFixed(3) : "--"}`
            : tx("方向样本不足，本周期未训练方向模型", "Too few directional rows; no directional model for this horizon"),
          three = live?.threeClass,
          className = (key) => tx({ up: "偏多", flat: "震荡", down: "偏空" }[key] || key, { up: "Up", flat: "Flat", down: "Down" }[key] || key),
          threeClass = three
            ? `${tx("三分类准确率", "Three-class accuracy")} <b>${(three.accuracy * 100).toFixed(1)}%</b> · ${tx("基线：永远猜", "baseline: always guess")} ${className(three.majorityLabel)} <b>${(three.majorityAccuracy * 100).toFixed(1)}%</b> · ${tx("基线：按频率随机", "baseline: random by frequency")} <b>${(three.frequencyAccuracy * 100).toFixed(1)}%</b> · ${tx("差值", "delta")} <b class="${three.deltaVsMajority >= 0 ? "bull" : "bear"}">${three.deltaVsMajority >= 0 ? "+" : "−"}${Math.abs(three.deltaVsMajority * 100).toFixed(1)}pp</b> · n=${three.samples}`
            : tx("三分类样本待积累（早于阈带机制的旧数据不计入）", "Three-class sample pending (rows predating the band are excluded)"),
          confusion = three
            ? `<span>${tx("混淆矩阵（行=预测 / 列=实际，顺序 偏多·震荡·偏空）", "Confusion (rows = predicted / columns = actual; order up·flat·down)")}：${["up", "flat", "down"].map((key) => `${className(key)} [${three.confusion[key].up}/${three.confusion[key].flat}/${three.confusion[key].down}]`).join(" · ")}</span>`
            : "",
          missed = three && Number.isFinite(three.missedBreakout)
            ? `<span>${tx("判为震荡但实际走出趋势", "Called chop but a trend appeared")} <b>${(three.missedBreakout * 100).toFixed(1)}%</b></span>`
            : "",
          economic = live?.economic && live.scored
            ? `<span class="muted">${tx("参考：成本后", "Reference: after cost")} ${live.economic.trades} ${tx("笔", "trades")} · ${tx("净收益", "Net")} ${pct(live.economic.netReturn * 100)} · ${tx("最大回撤", "Max DD")} ${pct(live.economic.maxDrawdown * 100)}</span>`
            : null,
          // 权威样本与旧窗口样本必须分开说：旧样本的实际持有窗口随访问时机变化，混在一起
          // 会让准确率无法解释。这里显式报出被排除的条数，而不是让它悄悄消失。
          liveText = live?.scored
            ? `${tx("实时", "Live")} ${tx("命中", "Hit")} ${(live.hitRate * 100).toFixed(1)}% · Brier ${Number(live.brier).toFixed(3)} · BSS ${Number.isFinite(live.brierSkill) ? `${(live.brierSkill * 100).toFixed(1)}%` : "--"} · ECE ${Number.isFinite(live.ece) ? `${(live.ece * 100).toFixed(1)}%` : "--"} · n=${live.scored}`
            : `${tx("实时命中待积累", "Live outcomes pending")} · ${tx("待结算", "Pending")} ${pending}`,
          legacyNote = live?.legacy
            ? `<span class="muted">${tx(`另有 ${live.legacy} 条旧窗口定义样本已排除：旧逻辑不检查目标 K 线是否已收盘，实测仅约三成旧样本的结算价等于该根最终收盘，持有窗口无法复原`, `${live.legacy} older samples excluded: the old rule settled without checking that the target bar had closed — only about 30% matched that bar close exactly, so their window cannot be reconstructed`)}</span>`
            : null;
        return `<article><b>${safeText(txWinLabel(window.label))}</b><span>${threeClass}</span>${confusion}${missed}<span>${quality}</span><span>${liveText}</span>${legacyNote ? legacyNote : ""}${economic ? economic : ""}</article>`;
      })
      .join("");
  const scorecardPanel = `<section class="research-scorecard"><h3>${tx("模型记分卡", "Model scorecard")}</h3><p>${tx("终点三分类标签（偏多 / 震荡 / 偏空，阈带 = 1.15σ·√周期）· 时间顺序 60/20/20 切分并 embargo · 震荡概率来自软加权历史近邻，方向条件概率来自逻辑回归与本地树模型基线动态加权 · Platt 仅在独立校准窗拟合。三分类必须与「永远猜震荡」「按频率随机」两条基线并列阅读，差值才是模型贡献；成本化指标仅作参考，不作为升级门槛。", "Terminal three-class labels (up / flat / down; band = 1.15 sigma · sqrt(horizon)) · chronological 60/20/20 split with embargo · chop probability comes from soft-weighted historical neighbours, directional probability from a dynamically blended logistic and local tree baseline · Platt fits only on the independent calibration window. Read three-class accuracy next to the always-chop and random baselines: only the delta is the model's contribution. Cost metrics are reference only and never a promotion gate.")}</p><div>${scoreRows}</div></section>`;
  const featureStatus = data.features || {},
    macro = data.macro?.dxy,
    training = data.training || {},
    latestRun = training.latest,
    shadow = training.shadow || {},
    comparison = training.comparison,
    candidateLocked = latestRun?.status === "shadow" && !shadow.readyForNext,
    runSummary = latestRun
      ? `${tx("候选版本", "Candidate")} #${latestRun.id} · ${latestRun.status === "shadow" ? tx("影子记分中", "shadow scoring") : latestRun.status === "failed" ? tx("训练失败", "training failed") : tx("训练中", "training")} · ${tx("已配对结算", "Paired outcomes")} ${shadow.totalSettled || 0} ${tx("条", "rows")}`
      : tx("尚未创建候选模型", "No candidate model yet"),
    // 门槛卡在哪个周期必须写出来：只显示「样本不足」会让等待期看起来像功能坏了。
    // Name the horizon that is short of the gate; a bare "insufficient" reads as a broken feature.
    // 门槛逐周期从服务端取：四个周期不再共用同一个数字（1d 一天只产一个独立样本，于是同样的
    // 条数意味着长得多得多的等待）。折算天数放在提示里，否则「20 条」会让人以为四个周期的
    // 等待时间相同。The gate and the wall-clock wait it implies are both per horizon.
    horizonProgress = comparison?.byHorizon
      ? `<span class="research-horizon-progress">${tx("各周期独立样本", "Independent per horizon")}：${["15m", "1h", "4h", "1d"]
          .map((key) => {
            const row = comparison.byHorizon[key] || {},
              got = Number(row.independent || 0),
              need = Number(row.required || shadow.requiredIndependentPerHorizon || 20),
              days = Number(row.gateDays || 0),
              wait = days < 1 ? `${(days * 24).toFixed(1)} ${tx("小时", "h")}` : `${days.toFixed(1)} ${tx("天", "d")}`;
            return `<b class="${got >= need ? "bull" : "muted"}" title="${tx("门槛", "gate")} ${need} · ${tx("折算等待", "≈")} ${wait}">${key} ${got}/${need}</b>`;
          })
          .join(" · ")}</span>`
      : "",
    trainLabel = training.inProgress
      ? tx("训练中…", "Training…")
      : candidateLocked
        ? tx("影子评估中", "Shadow scoring")
        : latestRun
          ? tx("训练下一候选", "Train next candidate")
          : tx("训练候选模型", "Train candidate"),
    metric = (value) => (Number.isFinite(value) ? value.toFixed(3) : "--"),
    comparisonRows = comparison
      ? ["15m", "1h", "4h", "1d"]
          .map((key) => {
            const row = comparison.byHorizon?.[key] || {},
              base = row.baseline || {},
              candidate = row.candidate || {};
            return `<article><b>${key}</b><span>${tx("配对", "Paired")} n=${row.samples || 0}/30</span><span>${tx("Brier", "Brier")} ${metric(base.brier)} → ${metric(candidate.brier)}</span><span>${tx("Log Loss", "Log Loss")} ${metric(base.logLoss)} → ${metric(candidate.logLoss)}</span></article>`;
          })
          .join("")
      : "",
    overallBase = comparison?.overall?.baseline || {},
    overallCandidate = comparison?.overall?.candidate || {},
    verdict = comparison?.verdict,
    abPanel = comparison
      ? `<section class="research-ab-evaluation ${safeText(verdict?.tone || "yellow")}"><h3>${tx("A/B 自动评估 · 当前对象：" + coinLabel() + " 多因子研究预测模型", "A/B automatic evaluation · current scope: " + coinLabel() + " multi-factor research model")}</h3><div class="research-ab-verdict"><b>${safeText(txVerdictLabel(verdict?.label) || tx("继续影子评估", "Continue shadow scoring"))}</b><span>${safeText(txVerdictReason(verdict?.reason) || "")}</span></div><div class="research-ab-summary"><span>${tx("已配对结算", "Paired outcomes")} <b>${comparison.paired || 0}</b></span><span>${tx("总体 Brier", "Overall Brier")} <b>${metric(overallBase.brier)} → ${metric(overallCandidate.brier)}</b></span><span>${tx("总体 Log Loss", "Overall Log Loss")} <b>${metric(overallBase.logLoss)} → ${metric(overallCandidate.logLoss)}</b></span><span>${tx("成本后净收益", "Net after cost")} <b>${pct((overallBase.economic?.netReturn || 0) * 100)} → ${pct((overallCandidate.economic?.netReturn || 0) * 100)}</b></span></div><div class="research-ab-grid">${comparisonRows}</div><small>${tx("门槛：每周期 30 个配对样本；Brier 与 Log Loss 均至少优于 3%，BSS≥0，ECE 不恶化超过 5%，成本后净收益不低于现役，且已验证市场状态不显著退化。绿色仅表示建议人工复核，绝不自动切换。", "Gate: 30 paired outcomes per horizon; Brier and Log Loss each improve by 3%, BSS≥0, ECE no worse by over 5%, net after cost no lower, and no material degradation in validated regimes. Green means manual review only; it never auto-switches.")}</small></section>`
      : `<section class="research-ab-evaluation yellow"><h3>${tx("A/B 自动评估 · 当前对象：" + coinLabel() + " 多因子研究预测模型", "A/B automatic evaluation · current scope: " + coinLabel() + " multi-factor research model")}</h3><div class="research-ab-verdict"><b>${tx("等待候选版本", "Waiting for a candidate")}</b><span>${tx("先在 BTC 多因子研究预测卡片创建候选模型，系统才会开始同桶影子结算与自动对照。", "Create a candidate in the BTC multi-factor research card to begin paired shadow settlement and automatic comparison.")}</span></div></section>`,
    governance = `<section class="research-governance"><h3>${tx("特征与训练治理", "Feature & training governance")}</h3><div><span>${tx("OFI 快照", "OFI snapshots")} <b>${featureStatus.ofiSnapshots || 0}</b><small>${featureStatus.readyForTraining ? tx("达到最低历史门槛", "history threshold met") : tx("采集中，未进入训练", "collecting; excluded from training")}</small></span><span>DXY <b>${macro ? macro.value.toFixed(3) : "--"}</b><small>${tx("仅作环境展示，待时序对齐验证", "context only; awaiting aligned validation")}</small></span><span>${tx("新闻", "News")} <b>${tx("事件分类 + 时间衰减", "event + decay")}</b><small>${tx("无预期数据时不计算“意外度”", "no surprise factor without consensus data")}</small></span></div><div class="research-training-status"><b>${runSummary}</b>${horizonProgress}<small>${safeText(shadow.reason || tx("训练候选模型后会并行记录结果，达到门槛后仍需人工决定是否切换。", "Candidate outcomes are recorded in parallel; reaching the threshold still requires a manual switch decision."))}</small></div></section>`;
  /* v2.11.10：实时样本的攒够速度由市场决定 —— 日线一天只产生一个独立结果，等 30 条就是 30 天。
     回放把已存 K 线按同样的窗口口径重放成已评分样本，因此不自动运行（要重训十几个分段模型，
     约 20 秒），改由用户按需触发，服务端缓存 30 分钟。 */
  const replayPanel = `<section class="research-replay" id="researchReplayPanel"><h3>${tx("历史回放 · walk-forward 三分类验证", "Historical replay · walk-forward three-class validation")}</h3><div class="research-replay-head"><button type="button" id="runResearchReplay">${tx("运行历史回放", "Run historical replay")}</button><small>${tx("用本地已存 K 线重放：每一段只用该段起点之前的数据训练，再逐桶预测其后的桶，因此不含前瞻偏差。不含新闻/情绪/微观结构（它们没有历史），震荡概率来自近邻池、与实时同源。", "Replays stored candles: each segment trains only on data before its own cut, then predicts the buckets after it, so there is no look-ahead. News, sentiment, and microstructure have no history and are excluded; the chop probability comes from the analogue pool, as it does live.")}</small></div><div id="researchReplayResult" class="research-replay-result"><small>${tx("尚未运行。", "Not run yet.")}</small></div></section>`;
  /* v2.11.14：宏观事件因子。CPI / 非农 / FOMC 的发布时刻与 BTC 事件窗口收益对齐。数据来自
     FRED 观测序列 + Fed 官方决议日，点按钮才去取数（首次约 5 秒），否则只读库。 */
  const macroPanel = `<section class="research-macro" id="researchMacroPanel"><h3>${tx("宏观事件因子 · CPI / 非农 / FOMC", "Macro event factors · CPI / NFP / FOMC")}</h3><div class="research-macro-head"><button type="button" id="runMacroStudy">${tx("重新回填事件样本", "Refetch event samples")}</button><small>${tx("面板打开时自动读取已入库的事件样本；点左侧按钮才会去 FRED 与 Fed 取数并重算（约 5 秒）。回填覆盖至少 24 个月，1d 窗口用日线、1h/4h 用 15m；基准只取事件时刻前已收盘的 K 线，避免前视偏差。", "The panel loads stored events on open; the button re-fetches from FRED and the Fed and recomputes (about 5 seconds). Coverage spans 24+ months. The 1d window uses daily candles and 1h/4h use 15m; baselines only ever use candles already closed at the event instant, so there is no look-ahead.")}</small></div><div id="researchMacroResult" class="research-macro-result"><small>${tx("正在读取事件样本…", "Loading event samples…")}</small></div></section>`;
  /* v2.11.27：因子消融。加一个新因子最容易自欺的一步是「只看 accuracy 有没有涨」——在大部分时间
     震荡的行情里，永不预测方向就能拿到很高的准确率。两臂跑完全相同的回放与 K 线，唯一差别是待验证
     的那三列日历特征，头条指标是相对「永远猜多数类」的增量 ΔM。 */
  const ablationPanel = `<section class="research-ablation" id="researchAblationPanel"><h3>${tx("因子消融 · 逐因子对比", "Factor ablation · one factor at a time")}</h3><div class="research-ablation-head"><button type="button" id="runResearchAblation">${tx("运行消融实验", "Run ablation")}</button><button type="button" id="refreshResearchAblation">${tx("强制重算", "Force recompute")}</button><button type="button" id="backfillFunding">${tx("回填资金费率历史", "Backfill funding history")}</button><small>${tx("每个因子臂跑完全相同的回放流程与同一批 K 线，唯一差别是它自己那一块特征列 —— 这样任何「无差异」结论都只能归因于那一块。判定看的是 deltaVsMajority（相对「永远猜多数类」的增量），不是 accuracy：震荡占多数时永远猜震荡就能拿到 75% 以上。各因子还要看它的「暴露」条件分组，因为全局均值会掩盖一个只在窄区间起作用的因子。因子数与周期数相乘。「运行消融实验」优先复用服务端 30 分钟内的结果，旁边的「强制重算」才会真的重跑（一到两分钟）；结果里会标明本次是否来自缓存。", "Every factor arm runs the identical replay over the same candles; the only difference is its own block of columns, so a verdict of \"no difference\" can only be attributed to that block. Both arms are judged twice: once on direction (deltaVsMajority - the gain over always guessing the majority class, never accuracy, since chop dominates the tape and always guessing chop already scores above 75%), and once on volatility - whether anything here knows that a move is coming at all, measured by a dedicated head trained on the same columns with a band-exit label. The two verdicts are reported apart because they answer different questions, and the volatility verdict names the level and the ranking separately: a level that moved while the ranking got worse is not a gain. Each factor is also split by the condition it is supposed to act on, because a global average can hide a factor that works only in a narrow regime. Run reuses the server's 30-minute cache; the neighbouring button forces a recompute of one to two minutes, and the result states whether it was cached.")}</small></div><div id="researchAblationResult" class="research-ablation-result"><small>${tx("尚未运行。", "Not run yet.")}</small></div></section>`;
  /* v2.11.29：参数与门槛。研究模块的全部阈值与权重此前散在十几个函数里，没人能同时审查它们。
     现在只有一个来源，这个面板把它摊开，并给出当前生效配置的指纹 —— 两份结果只有指纹相同才允许
     互相比较。 */
  const tuningPanel = `<section class="research-tuning" id="researchTuningPanel"><h3>${tx("参数与门槛 · 单一配置源", "Tuning · single source of truth")}</h3><div class="research-tuning-head"><button type="button" id="loadResearchTuning">${tx("读取当前配置", "Load configuration")}</button><small>${tx("研究模块的全部门槛与权重（震荡带倍数、独立样本门槛、成本模型、融合权重）集中在服务端一个配置块里，可由环境变量 BTC_RESEARCH_TUNING 覆盖。指纹标识一套配置；两份结果只有指纹相同才可互相比较。", "Every research threshold and weight lives in one server-side block and may be overridden with the BTC_RESEARCH_TUNING environment variable. The fingerprint identifies a configuration; two results may only be compared when their fingerprints match.")}</small></div><div class="research-tuning-result" id="researchTuningResult"></div></section>`;
  const abCenterHeader = `<div class="ab-center-head"><h2>${tx("A/B 实验中心", "A/B experiment center")}</h2><p>${tx("A 版为网页上方冻结的现役版本；B 版仅在后台同桶记录、到期后用同一真实价格结算。绿色只表示建议人工复核，系统绝不自动替换现役版本。描述/公式型模块改验算一致性、偏差或覆盖率，不输出“准确率”。", "A is the frozen live version shown above. B is recorded only in the background from the same bucket and settled against the same realised price. Green only means manual review; the system never replaces A automatically. Descriptive/formula modules validate consistency, bias, or coverage rather than accuracy.")}</p><div id="abExperimentRegistry" class="ab-experiment-registry"><span><b>${tx("正在读取各板块影子实验…", "Loading module shadow experiments…")}</b></span></div></div>`;
  card.innerHTML = `<div class="research-outlook-head"><div><h2>${tx(coinLabel() + " 多因子研究预测", coinLabel() + " multi-factor research outlook")}</h2><p>${tx("软加权历史近邻数据模型融合历史状态、近 24 小时公开 BTC 新闻情绪与 OKX 市场结构；结果为条件概率与价格区间，不是买卖建议。", "A soft-weighted historical-neighbor data model combines historical states, recent public BTC news sentiment, and OKX market structure. Results are conditional probabilities and price ranges, not buy/sell advice.")}</p></div><div class="research-actions"><button type="button" id="refreshResearchOutlook">${tx("更新研究", "Refresh research")}</button><button type="button" id="trainResearchCandidate" ${training.inProgress || candidateLocked ? "disabled" : ""}>${trainLabel}</button></div></div>${eventBanner}<div class="research-outlook-summary"><span>${tx("新闻情绪", "News sentiment")}：<b class="bull">${news.bullish || 0} ${tx("利好", "positive")}</b> · <b class="bear">${news.bearish || 0} ${tx("利空", "negative")}</b> · <b class="flat">${news.neutral || 0} ${tx("中性", "neutral")}</b> · ${tx("半衰期", "half-life")} ${news.halfLifeHours || 4}h</span><span>${tx("情绪指数", "Fear & Greed")}：<b>${Number.isFinite(sentiment?.value) ? `${sentiment.value}/100` : "--"}</b></span><span>${tx("中性阈带 15m", "Neutral band 15m")}：±${Number.isFinite(Number(data.windows?.[0]?.theta)) ? (Number(data.windows[0].theta) * 100).toFixed(2) : "--"}%</span><span>${tx("样本", "Samples")}：15m ${history.intradaySamples || 0} · 1d ${history.dailySamples || 0}</span></div><div class="research-window-grid">${windows}</div>${derivativeSummary}<div class="research-news"><h3>${tx("近期 BTC 重点新闻（可点击查看原文）", "Priority BTC headlines (click to open)")}</h3><ul>${headlineRows}</ul></div><footer>${tx("更新时间", "Updated")} ${researchAge(data.fetchedAt)} · ${safeText(news.source || "")} · ${tx("新闻优先按利好/利空影响排序，并采用标题相似度去重、信源与事件权重、4 小时时间衰减；仍需自行核验其真实性与影响。", "Headlines prioritize positive/negative impact, with similarity dedupe, source/event weights, and a 4-hour time decay; verify accuracy and impact independently.")}</footer>`;
  const legacyNews = card.querySelector(".research-news");
  if (legacyNews) legacyNews.outerHTML = newsPanel;
  card
    .querySelector(".research-derivatives")
    ?.insertAdjacentHTML("afterend", scorecardPanel + governance + replayPanel + macroPanel + ablationPanel + tuningPanel);
  let abCard = $("abEvaluationCard");
  if (!abCard) {
    abCard = document.createElement("section");
    abCard.id = "abEvaluationCard";
    abCard.className = "card research-ab-evaluation-card";
  }
  /* v2.11.9：A/B 实验中心与研究预测同属「研究」类，紧贴研究卡之后。原先挂在 main 末尾
     （footer 之前），会被整组决策工具卡隔开。最终次序由 syncMacroPanels 统一校正。 */
  const main = document.querySelector("main");
  if (main && !main.contains(abCard)) main.append(abCard);
  if (card.nextElementSibling !== abCard) card.after(abCard);
  syncMacroPanels();
  abCard.innerHTML = abCenterHeader + abPanel;
  card
    .querySelector("#refreshResearchOutlook")
    ?.addEventListener("click", () => loadResearchOutlook(true));
  card
    .querySelector("#trainResearchCandidate")
    ?.addEventListener("click", trainResearchCandidate);
  card.querySelector("#runMacroStudy")?.addEventListener("click", () => loadMacroEventStudy(true));
  // 读库是毫秒级的，所以面板自动填一次；取数 + 重算仍然只在点按钮时发生。
  loadMacroEventStudy(false);
  card
    .querySelector("#runResearchReplay")
    ?.addEventListener("click", runResearchReplay);
  card
    .querySelector("#runResearchAblation")
    // 必须包一层：addEventListener 会把事件对象当第一个实参传进去，直接挂 runResearchAblation
    // 等于每次都传了个真值，于是「复用缓存」永远走不到。
    // Wrap it: addEventListener passes the event object as the first argument, so hooking the
    // function directly would hand it a truthy value every time and the cache path would never run.
    ?.addEventListener("click", () => runResearchAblation(false));
  card
    .querySelector("#refreshResearchAblation")
    ?.addEventListener("click", () => runResearchAblation(true));
  card
    .querySelector("#backfillFunding")
    ?.addEventListener("click", backfillFundingHistory);
  card
    .querySelector("#loadResearchTuning")
    ?.addEventListener("click", loadResearchTuning);
  loadAbExperimentRegistry();
  addHelp(
    card.querySelector("h2"),
    tx(
      "模型从本机 SQLite 与公开行情中使用所有可用的 15 分钟、日线历史样本，寻找与当前动量和波动接近的历史片段；新闻仅对结果施加有限权重。预计金额是 BTC 价格变动（美元），不是你的账户盈亏。",
      "The model uses all available 15-minute and daily samples in local SQLite/public market history to find past states similar in momentum and volatility. News has limited weight only. Expected amount is the BTC price move in USD, not your account P&L.",
    ),
    tx(
      "刷新会重新读取缓存/公开数据源；公开新闻源最多每 15 分钟更新一次。",
      "Refreshes cache/public sources; the public news source updates at most every 15 minutes.",
    ),
  );
}
// The HTTP status alone throws the server's reason away. A 503 out of the research endpoints is
// almost never "the server is down": it is a timeout, a missing dependency or a broken invariant,
// and the body already names which one. Reporting only "HTTP 503" leaves a panel that says the run
// failed and gives nothing to look at, which is exactly what happened when the ablation kept
// answering 503 while the replay beside it worked fine.
// 只报 HTTP 状态码会把服务端的理由丢掉。研究接口的 503 几乎从来不是「服务挂了」：它是超时、依赖缺失
// 或某条不变量被破坏，而响应体早就写清了是哪一种。只显示「HTTP 503」会留下一个「失败了、但没有线索」
// 的面板 —— 消融一直回 503、旁边的回放却正常时，看到的正是这个样子。
async function describeHttpFailure(response) {
  let detail = "";
  try { const body = await response.json(); detail = body?.detail || body?.error || ""; } catch { detail = ""; }
  return `HTTP ${response.status}${detail ? ` · ${detail}` : ""}`;
}
// 面板默认自动读库（毫秒级），只有点按钮才去 FRED / Fed 取数重算。
async function loadMacroEventStudy(refresh = false) {
  const panel = document.getElementById("researchMacroResult");
  if (!panel) return;
  panel.innerHTML = `<small>${refresh ? tx("正在从 FRED 与 Fed 取数并重算事件窗口…", "Fetching from FRED and the Fed, then recomputing event windows…") : tx("正在读取宏观事件样本…", "Loading macro event samples…")}</small>`;
  try {
    const response = await apiFetch(`/api/macro-outcomes${refresh ? "?refresh=1" : ""}`, refresh ? 90_000 : 15_000);
    if (!response.ok) throw new Error(await describeHttpFailure(response));
    renderMacroEventStudy(await response.json());
  } catch (error) {
    panel.innerHTML = `<small class="bear">${tx("宏观事件回填失败", "Macro event backfill failed")}：${safeText(error.message)}</small>`;
  }
}
function renderMacroEventStudy(data) {
  const panel = document.getElementById("researchMacroResult");
  if (!panel) return;
  const rate = (value) => (Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(2)}%` : "--");
  const cards = ["cpi", "core-cpi", "nfp", "fomc"]
    .map((key) => {
      const row = data.byKind?.[key];
      if (!row?.samples) return "";
      const vol = Number(row.volatility?.medianRatio),
        split = row.surpriseSplit;
      return `<article><b>${safeText(row.name)}</b><span>${tx("样本", "Samples")} ${row.samples} · ${tx("含实际值", "with actual")} ${row.withActual}</span><span>${tx("1d 中位幅度", "median 1d move")} ${rate(row.medianAbsReturn?.d1)}</span><span>${tx("波动倍数", "vol ratio")} ${Number.isFinite(vol) ? `${vol.toFixed(2)}×` : "--"}</span><span>${tx("放大占比", "amplified")} ${Number.isFinite(Number(row.volatility?.amplifiedShare)) ? `${(Number(row.volatility.amplifiedShare) * 100).toFixed(0)}%` : "--"}</span>${split ? `<span>${tx("正意外 1d", "+surprise 1d")} ${rate(split.positive.meanAfter1d)} <small>n=${split.positive.samples}</small></span><span>${tx("负意外 1d", "−surprise 1d")} ${rate(split.negative.meanAfter1d)} <small>n=${split.negative.samples}</small></span>` : ""}${row.unchanged ? `<span>${tx("无变动日 1d", "unchanged 1d")} ${rate(row.unchanged.meanAfter1d)} <small>n=${row.unchanged.samples}</small></span>` : ""}<small>${safeText(row.precision)} · ${safeText(row.note)}</small></article>`;
    })
    .join("");
  const span = data.coverage ? `${new Date(data.coverage.from).toISOString().slice(0, 10)} → ${new Date(data.coverage.to).toISOString().slice(0, 10)}` : "--",
    notes = (data.methodology || []).map((line) => `<li>${safeText(line)}</li>`).join("");
  panel.innerHTML = `<div class="research-macro-grid">${cards}</div><small>${tx("覆盖", "Coverage")} ${span} · ${data.total} ${tx("条事件", "events")} · ${tx("CPI 与核心 CPI 同日发布，窗口收益完全相同，不是两组独立证据。", "CPI and core CPI ship on the same day, so their window returns are identical — not two independent samples.")}</small><details><summary>${tx("方法学边界", "Methodology limits")}</summary><ul>${notes}</ul></details>`;
}
// 回放按需触发：它要重训十几个历史分段模型，不该拖慢每一次面板渲染。
// Replay is user-triggered: it retrains a dozen historical segment models and must not slow down
// every panel render.
async function runResearchReplay() {
  const panel = document.getElementById("researchReplayResult");
  if (!panel) return;
  panel.innerHTML = `<small>${tx("正在重训历史分段并逐桶预测，约需 20 秒…", "Retraining historical segments bucket by bucket; about 20 seconds…")}</small>`;
  try {
    const response = await fetch("/api/research-backfill?refresh=1", { cache: "no-store" });
    if (!response.ok) throw new Error(await describeHttpFailure(response));
    renderResearchReplay(await response.json());
  } catch (error) {
    panel.innerHTML = `<small class="bear">${tx("回放失败", "Replay failed")}：${safeText(error.message)}</small>`;
  }
}
function renderResearchReplay(data) {
  const panel = document.getElementById("researchReplayResult");
  if (!panel) return;
  const rate = (value) => (Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(1)}%` : "--");
  const rows = ["15m", "1h", "4h", "1d"]
    .map((key) => {
      const row = data.rows?.[key] || {},
        three = row.threeClass || {},
        delta = Number(three.deltaVsMajority),
        tone = Number.isFinite(delta) ? (delta > 0 ? "bull" : "bear") : "muted";
      return `<article><b>${key}</b><span>${tx("回放样本", "Replayed")} ${row.samples || 0}</span><span>${tx("独立", "independent")} ${row.independent || 0}</span><span>${tx("准确率", "Accuracy")} ${rate(three.accuracy)}</span><span>${tx("猜震荡基线", "Always-flat")} ${rate(three.majorityAccuracy)}</span><span class="${tone}">${tx("差值", "Delta")} ${Number.isFinite(delta) ? (delta > 0 ? "+" : "") + (delta * 100).toFixed(1) + "%" : "--"}</span></article>`;
    })
    .join("");
  const daily = data.rows?.["1d"] || {},
    span = daily.from ? `${new Date(daily.from).toISOString().slice(0, 10)} → ${daily.to ? new Date(daily.to).toISOString().slice(0, 10) : "--"}` : "--";
  panel.innerHTML = `<div class="research-replay-grid">${rows}</div><small>${tx("1d 回放覆盖", "1d replay coverage")} ${span} · ${tx("与实时样本同口径（同一 theta 与窗口定义）", "same threshold and window definition as live samples")}</small>`;
}
// 消融按需触发：两臂各跑一遍完整回放，比回放本身慢一倍（约 25 秒），因此不自动运行。
// 资金费率历史要先去交易所取一次才能参与消融。这一步是显式按钮，而不是在「运行消融」里悄悄联网：
// 取数依赖外部服务，它的失败必须看得见，而不是伪装成「这个因子没有增量」。
// The funding history must be fetched from the exchange once before it can take part in an ablation.
// That is an explicit button rather than a silent network call inside "run ablation": the fetch
// depends on an external service, and its failure has to be visible instead of masquerading as
// "this factor adds nothing".
async function backfillFundingHistory() {
  const panel = document.getElementById("researchAblationResult");
  if (!panel) return;
  panel.innerHTML = `<small>${tx("正在从交易所分页回填资金费率历史…", "Paging the funding-rate history from the exchange…")}</small>`;
  try {
    const response = await fetch("/api/funding-rates?refresh=1", { cache: "no-store" });
    if (!response.ok) throw new Error(await describeHttpFailure(response));
    const data = await response.json();
    const days = Number(data.coverageDays),
      span = Number.isFinite(days) ? ` · ${tx("覆盖", "covering")} ${days.toFixed(1)} ${tx("天", "days")}` : "",
      fetched = data.backfill ? ` · ${tx("本次取数", "this fetch")} ${data.backfill.requests} ${tx("次请求", "requests")}` : "";
    panel.innerHTML = `<small>${tx("已存", "Stored")} <b>${data.stored || 0}</b> ${tx("条结算", "settlements")}${span}${fetched}。${tx("现在运行消融，资金费率会作为一个因子臂出现；两臂的列数不同是它真的进了模型的前提。", "Run the ablation now and funding will appear as a factor arm; the two arms differing in column count is the precondition for it having reached the model at all.")}</small>`;
  } catch (error) {
    panel.innerHTML = `<small class="bear">${tx("回填失败", "Backfill failed")}：${safeText(error.message)}</small>`;
  }
}
// 按钮默认**复用**服务端 30 分钟的缓存：一次重算要重训十几个分段模型、耗时一到两分钟，而 30 分钟内
// 重算得到的是同一份配置、同一批 K 线下的同一批数字 —— 让人为同一份结果等两次没有意义。需要强制时
// 用旁边的「强制重算」。结果里会标明本次是否来自缓存。
// The button **reuses** the server's 30-minute cache by default: a recompute retrains a dozen segment
// models and takes one to two minutes, while inside 30 minutes it can only reproduce the same numbers
// from the same configuration and the same candles. Waiting twice for one result is not a feature;
// the neighbouring button forces a recompute, and the result says whether it came from the cache.
async function runResearchAblation(force = false) {
  const panel = document.getElementById("researchAblationResult");
  if (!panel) return;
  panel.innerHTML = `<small>${force
    ? tx("正在强制重算：每个因子臂各重训一遍历史分段并逐桶预测，约需一到两分钟…", "Forcing a recompute: retraining every factor arm over historical segments bucket by bucket; one to two minutes…")
    : tx("正在读取消融结果…", "Loading ablation results…")}</small>`;
  try {
    const response = await fetch(`/api/research-ablation${force ? "?refresh=1" : ""}`, { cache: "no-store" });
    if (!response.ok) throw new Error(await describeHttpFailure(response));
    renderResearchAblation(await response.json());
  } catch (error) {
    panel.innerHTML = `<small class="bear">${tx("消融实验失败", "Ablation failed")}：${safeText(error.message)}</small>`;
  }
}
function renderResearchAblation(data) {
  const panel = document.getElementById("researchAblationResult");
  if (!panel) return;
  const pp = (value) => (Number.isFinite(Number(value)) ? `${Number(value) > 0 ? "+" : ""}${(Number(value) * 100).toFixed(2)}pp` : "--");
  const rate = (value) => (Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(1)}%` : "--");
  // The threshold arrives in percentage points (0.5 means 0.5pp) while deltaVsMajority is a ratio.
  // Comparing 0.5 against a 0.005-sized difference would pin every verdict to "no difference" and
  // print the threshold as ±50.0pp in the footnote.
  const threshold = (Number.isFinite(Number(data.deltaThresholdPp)) ? Number(data.deltaThresholdPp) : 0.5) / 100;
  // 波动口径的阈值同样是**百分点**，也同样必须换算成比例再比较。两个阈值分开传递，是因为它们判定的是
  // 两个不同的问题；共用一个数字会让其中一边的判定失去意义。
  // The volatility threshold is in percentage points as well, and needs the same conversion. It is a
  // separate field because the two judge different questions; sharing one number would make one of
  // the two verdicts meaningless.
  const volThreshold = (Number.isFinite(Number(data.volatilityThresholdPp)) ? Number(data.volatilityThresholdPp) : 0.5) / 100;
  // The AUC gain is not a percentage of anything - it is a bare increment on a 0-to-1 statistic - so it
  // gets its own band instead of borrowing the one expressed in percentage points. The two happened to
  // coincide at 0.005, which is exactly why they had to be separated before anyone could retune one of
  // them without silently moving the other.
  // AUC 增量不是任何东西的百分比 —— 它是 0 到 1 之间的统计量上的裸增量 —— 所以它有自己的一条带，
  // 而不是借用那条以百分点表达的。两者恰好都等于 0.005，这正是必须在有人想单独调整其中一个而不悄悄
  // 带动另一个之前、把它们分开的原因。
  const volAucThreshold = Number.isFinite(Number(data.volatilityAucThreshold)) ? Number(data.volatilityAucThreshold) : 0.005;
  const horizons = ["15m", "1h", "4h", "1d"];
  // 三档判定：阈值带以内一律读作「无差异」，包括那些小幅为负的 —— 把 ±0.1pp 的波动读成「有损害」
  // 会让面板每次刷新都在叫狼来了，真正有信号的因子反而被淹没。
  // Three-way verdict: anything inside the band reads as "no difference", including small negatives.
  // Reading a 0.1pp wobble as harm would make the panel cry wolf on every refresh.
  const verdictOf = (value, band = threshold) => {
    const shift = Number(value);
    if (!Number.isFinite(shift)) return { tone: "muted", label: tx("样本不足", "insufficient") };
    if (shift > band) return { tone: "bull", label: tx("有增量", "adds value") };
    if (shift < -band) return { tone: "bear", label: tx("有损害", "hurts") };
    return { tone: "muted", label: tx("无差异", "no difference") };
  };
  const meta = Array.isArray(data.factorMeta) ? data.factorMeta : [];
  if (!meta.length) {
    panel.innerHTML = `<small class="muted">${tx("没有任何因子带数据，无法对比。先回填因子历史再运行。", "No factor carries data yet; backfill the factor history first.")}</small>`;
    return;
  }
  // 按因子分卡而不是按周期分卡：因子是这次对比的主角，周期是它的四行读数。
  // One card per factor rather than per horizon: the factor is what is being judged, and the four
  // horizons are its four readings.
  const cards = meta.map((factor) => {
    const rows = horizons.map((key) => {
      const row = data.rows?.[key] || {}, base = row.baseline || {}, arm = row.factors?.[factor.key] || {},
        delta = row.deltas?.[factor.key] || {}, condition = row.conditions?.[factor.key] || {},
        inside = condition.inside || {}, outside = condition.outside || {},
        // Same rule as the volatility line: a verdict that inverts between the two halves of the evidence
        // is not a verdict yet, so it is reported as such instead of being averaged into a number that
        // would depend on which half you happened to believe.
        // 与波动行同一条规则：一个在证据的前后两半之间反转的判定，还不是一个判定；它照原样报出，而不是被
        // 平摊成一个取决于你碰巧相信哪一半的数字。
        verdict = delta.stability?.direction?.flipped ? { tone: "warn", label: tx("前后段反向·还不可判", "halves disagree · not yet") } : verdictOf(delta.deltaVsMajority);
      // 波动口径单独一行：它与方向口径回答的是两个问题，混在一行里会让人把「方向没有增量」读成
      // 「这个因子什么也没买到」。基线技巧是模型自己（不加该因子）对「要动」的预测能力，先看它才能
      // 判断因子那点增量是加在一个本来就有技巧的模型上，还是一个本来就为零的模型上。
      // The volatility reading gets its own line: it answers a different question from the direction
      // reading, and sharing a line invites reading "no directional edge" as "this factor buys
      // nothing at all". Baseline skill is what the model already achieves without the factor, and
      // it is what tells apart a gain on top of real skill from a gain on top of nothing.
      const volDelta = delta.volatility || {}, volInside = inside.volatility || {}, volOutside = outside.volatility || {},
        volAucVerdict = verdictOf(volDelta.auc, volAucThreshold),
        // 波动这一行有两个指标，只报「有没有增量」会把「只是整体水位变了、排序反而更差」读成好消息 ——
        // 而那恰好是这批数据里出现的情形（4h 宏观事件窗口：Brier 技巧 +1.03pp 而 AUC −1.40pp）。
        // 所以这行的判定必须分别说明水平与排序各发生了什么，不能压成一句「有增量」。
        // The volatility line carries two metrics, and a single "adds value" verdict would read
        // "the overall level moved but the ranking got worse" as good news - which is exactly what
        // this data does at 4h inside an event window (+1.03pp Brier skill against a -1.40pp AUC).
        // The verdict therefore has to say what happened to the level and to the ranking separately.
        volVerdict = (() => {
          const skill = Number(volDelta.brierSkill), rank = Number(volDelta.auc);
          if (!Number.isFinite(skill) || !Number.isFinite(rank)) return { tone: "muted", label: tx("样本不足", "insufficient") };
          const skillUp = skill > volThreshold, skillDown = skill < -volThreshold, rankUp = rank > volAucThreshold, rankDown = rank < -volAucThreshold;
          // A reversal is the one reading that must not be summarised away: a delta that holds in one half
          // of the independent samples and inverts in the other is a coin, and saying "level up" without
          // saying that would be the panel's own version of crying wolf. It outranks the seven-way verdict.
          // 反向是唯一一个绝不能被总结掉掉的读数：一个差值在独立样本的一半上成立、在另一半上反转，那就是
          // 一枚硬币；只说「水平改善」而不说这件事，就成了面板自己在虚报。它的优先级高于那七种判定。
          const flipped = Boolean(volDelta.stability?.brierSkill?.flipped || volDelta.stability?.auc?.flipped);
          if (flipped) return { tone: "warn", label: tx("前后段反向·还不可判", "halves disagree · not yet readable") };
          if (skillUp && rankUp) return { tone: "bull", label: tx("水平与排序同增", "level + ranking up") };
          if (skillUp && rankDown) return { tone: "muted", label: tx("仅水平改善·排序变差", "level up · ranking worse") };
          if (skillUp) return { tone: "bull", label: tx("仅水平改善", "level only") };
          if (rankUp) return { tone: "bull", label: tx("仅排序改善", "ranking only") };
          if (skillDown && rankDown) return { tone: "bear", label: tx("两项同降", "both down") };
          if (skillDown) return { tone: "bear", label: tx("仅水平变差", "level worse only") };
          if (rankDown) return { tone: "bear", label: tx("仅排序变差", "ranking worse only") };
          return { tone: "muted", label: tx("无差异", "no difference") };
        })();
      const dh = base.directionHead || {};
      const dhCalGap = (Number.isFinite(Number(dh.calibrationPredictedRate)) && Number.isFinite(Number(dh.calibrationBaseRate))) ? (Number(dh.calibrationPredictedRate) - Number(dh.calibrationBaseRate)) * 100 : null;
      const dhCalTone = dhCalGap == null ? "muted" : (Math.abs(dhCalGap) < 1 ? "bull" : "bear");
      const dhCalLabel = dhCalGap == null ? tx("无数据", "no data") : (Math.abs(dhCalGap) < 1 ? tx("已校准", "calibrated") : tx("偏差 " + dhCalGap.toFixed(1) + "pp", "off " + dhCalGap.toFixed(1) + "pp"));
      const dhLiveGap = (Number.isFinite(Number(dh.testPredictedRate)) && Number.isFinite(Number(dh.testBaseRate))) ? (Number(dh.testPredictedRate) - Number(dh.testBaseRate)) * 100 : null;
      const dhLiveTone = dhLiveGap == null ? "muted" : (Math.abs(dhLiveGap) < 3 ? "bull" : (Math.abs(dhLiveGap) < 8 ? "muted" : "bear"));
      return `<div class="research-ablation-horizon">`
        + `<div class="research-ablation-row"><b>${key}</b><span>${tx("特征列", "columns")} ${base.featureWidth ?? "--"} → ${arm.featureWidth ?? "--"}</span><span>${tx("独立样本", "independent")} ${base.samples ?? 0}</span>${Number(arm.skippedSegments) > 0 ? `<span class="bear">${tx("跳过训练段", "skipped segments")} ${arm.skippedSegments}/${(arm.segments ?? 0) + arm.skippedSegments}</span>` : ""}<span class="${verdict.tone}">${tx("Δ 相对多数类", "Δ vs majority")} ${pp(delta.deltaVsMajority)}</span><span class="${verdict.tone}"><b>${verdict.label}</b></span><span>${tx("方向类准确率", "directional accuracy")} ${rate(base.threeClass?.directionalAccuracy)} → ${rate(arm.threeClass?.directionalAccuracy)}</span><span>${tx("漏报率", "missed breakout")} ${rate(base.threeClass?.missedBreakout)} → ${rate(arm.threeClass?.missedBreakout)}</span><span class="muted">${safeText(condition.label || "")} n=${inside.baseline?.samples ?? 0} · ${tx("ΔM", "ΔM")} ${pp(inside.deltaVsMajority)}</span><span class="muted">${tx("窗口外", "outside")} n=${outside.baseline?.samples ?? 0} · ${tx("ΔM", "ΔM")} ${pp(outside.deltaVsMajority)}</span></div>`
        + `<div class="research-ablation-row research-ablation-vol"><b>${tx("波动", "vol")}</b><span>${tx("波动头列", "vol cols")} ${base.volatilityColumns ?? "--"} → ${arm.volatilityColumns ?? "--"}</span><span>${tx("大动占比", "big-move rate")} ${rate(base.volatility?.bigRate)}</span><span>${tx("基线技巧", "baseline skill")} ${pp(base.volatility?.brierSkill)}</span><span>${tx("预测/实际", "predicted/actual")} ${rate(base.volatility?.predictedRate)} / ${rate(base.volatility?.bigRate)}${Number.isFinite(Number(base.volatility?.rateRatio)) ? ` · ${Number(base.volatility.rateRatio).toFixed(2)}×` : ""}</span><span class="${volVerdict.tone}">${tx("Δ Brier 技巧", "Δ Brier skill")} ${pp(volDelta.brierSkill)}</span><span class="${volAucVerdict.tone}">${tx("Δ AUC", "Δ AUC")} ${pp(volDelta.auc)}</span><span class="${volVerdict.tone}"><b>${volVerdict.label}</b></span><span class="muted">${safeText(condition.label || "")} n=${volInside.baseline?.samples ?? 0} · ${tx("ΔBSS", "ΔBSS")} ${pp(volInside.brierSkill)}</span><span class="muted">${tx("窗口外", "outside")} n=${volOutside.baseline?.samples ?? 0} · ${tx("ΔBSS", "ΔBSS")} ${pp(volOutside.brierSkill)}</span></div>`
        + `<div class="research-ablation-row research-ablation-dir"><b>${tx("方向头", "dir head")}</b><span>${tx("AUC", "AUC")} ${dh.auc != null ? dh.auc.toFixed(3) : "--"}</span><span>${tx("BSS", "BSS")} ${pp(dh.brierSkill)}</span><span>${tx("ECE", "ECE")} ${dh.ece != null ? (dh.ece * 100).toFixed(1) + "%" : "--"}</span><span class="${dhCalTone}">${tx("校准", "cal")}：${dhCalLabel}</span><span class="${dhLiveTone}">${tx("实测/预测", "actual/pred")} ${rate(dh.testBaseRate)} / ${rate(dh.testPredictedRate)}</span></div>`
        + `</div>`;
    }).join("");
    return `<article><div class="research-ablation-row research-ablation-title"><b>${safeText(factor.label)}</b><span class="muted">${safeText(factor.key)} · ${tx("列", "cols")} +${factor.columns}</span><span class="muted">${safeText(factor.note || "")}</span><span class="muted">${tx("暴露条件", "exposed when")}：${safeText(factor.condition?.label || "")}</span></div>${rows}</article>`;
  }).join("");
  const contexts = data.contexts || {};
  const contextNote = tx(`上下文：日历事件 ${contexts.calendarEvents || 0} 个 · 资金费率结算 ${contexts.fundingSettlements || 0} 条`,
    `Contexts: ${contexts.calendarEvents || 0} calendar events · ${contexts.fundingSettlements || 0} funding settlements`);
  const method = (data.methodology || []).map((line) => `<li>${safeText(line)}</li>`).join("");
  // 结果是否来自缓存必须写明：同一份缓存与刚刚重算出来的数字看不出差别，但前者省掉了两分钟。
  // Whether the result came from the cache has to be stated: a cached payload is indistinguishable
  // from a fresh one, and it saved two minutes.
  const cacheNote = data.cached ? `${tx("服务端缓存（30 分钟内）", "server cache (within 30 min)")} · ` : "";
  // A reader who does not know which numbers are decided and which are merely read will treat every
  // number as a verdict. This block is the difference between a panel that answers a question and a
  // panel that produces output.
  // 一个不知道「哪些数字是被判定的、哪些只是被读出来的」的读者，会把每个数字都当成结论。这一段就是
  // 「一个回答问题的面板」与「一个只是产出东西的面板」之间的差别。
  const howto = [
    tx("先看这一行值不值得信：样本数，以及有没有标「跳过训练段」或「前后段反向」。标了反向的格子读作「还没有结论」，不是「结论相反」。",
      "First check whether the row is readable at all: sample count, and whether it carries a skipped-segment or halves-disagree mark. A halves-disagree row reads as 'no verdict yet', not as 'the opposite verdict'."),
    tx("再看差值落在带内还是带外：带内一律是「无差异」，它的意思是「在这批样本、这个模型、这几列下测不出」，不等于「这个东西没有信息」。",
      "Then check whether the delta clears its band. Inside the band always means 'no difference' — meaning 'not measurable with this sample, model and column set', not 'this factor carries no information'."),
    tx("波动那一行有两个数，回答两个问题：水平（Δ Brier 技巧）＝整体水位报得准不准；排序（Δ AUC）＝能不能挑出更容易动的那些桶。只有两个都动，才算真的会择时。",
      "The volatility line carries two numbers answering two questions: level (Δ Brier skill) = is the overall rate reported correctly; ranking (Δ AUC) = can it pick out the buckets that move. Only when both move is there any timing."),
    tx("「预测/实际」的倍数离 1 越远，越说明是尺度问题而不是信号问题：远大于 1 是喊了没动，远小于 1 是大量漏报。尺度坏了会把 Brier 技巧压成负值，即便排序是对的。",
      "The further predicted/actual sits from 1, the more the problem is scaling rather than signal: far above 1 means it calls moves that never arrive, far below means it misses them. Bad scaling drives Brier skill negative even when the ranking is right."),
    tx("只有在某个暴露条件下格子变了、全局没变时，别当成噪声：全局均值会掩盖只在窄区间起作用的因子 —— 但那也意味着它只对少数桶有用。",
      "A reading that moves only inside the exposed condition while the headline does not is not noise: a global mean hides factors that act in a narrow range — but it also means it only helps on those buckets."),
  ].map(line => `<li>${safeText(line)}</li>`).join("");
  panel.innerHTML = `<div class="research-ablation-grid">${cards}</div><small>${cacheNote}${contextNote} · ${tx("判定阈值", "verdict bands")}：${tx("方向", "direction")} ±${(threshold * 100).toFixed(1)}pp · ${tx("波动水平", "volatility level")} ±${(volThreshold * 100).toFixed(1)}pp · ${tx("波动排序", "volatility ranking")} ±${volAucThreshold}（${tx("AUC 增量，无量纲", "AUC increment, dimensionless")}） · ${tx("指标基于互不重叠的独立样本子集。", "metrics computed on the non-overlapping subset.")}</small><details class="research-ablation-howto" open><summary>${tx("这个面板怎么读", "How to read this panel")}</summary><ol>${howto}</ol></details><ul class="research-ablation-method">${method}</ul>`;
}
// 参数与门槛面板：只读地把服务端的单一配置源摊开。它不写任何状态，也不参与任何计算。
function formatTuningValue(value) {
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}
async function loadResearchTuning() {
  const panel = document.getElementById("researchTuningResult");
  if (!panel) return;
  panel.innerHTML = `<small class="muted">${tx("读取中…", "Loading…")}</small>`;
  try {
    const response = await fetch("/api/research-tuning", { cache: "no-store" });
    if (!response.ok) throw new Error(await describeHttpFailure(response));
    renderResearchTuning(await response.json());
  } catch (error) {
    panel.innerHTML = `<small class="bear">${tx("读取失败", "Failed")}：${String((error && error.message) || error)}</small>`;
  }
}
function renderResearchTuning(data) {
  const panel = document.getElementById("researchTuningResult");
  if (!panel) return;
  const entries = Object.entries((data && data.effective) || {});
  if (!entries.length) {
    panel.innerHTML = `<small class="muted">${tx("未读到任何配置项", "No configuration returned")}</small>`;
    return;
  }
  // 分组标题用中文短句，否则读者只能看到 theta / gates 这类内部代号。
  const titles = {
    theta: tx("震荡带", "Chop band"), analogue: tx("近邻池", "Analogue pool"),
    fusion: tx("融合模型", "Fusion model"), calendarFeatures: tx("日历特征", "Calendar features"),
    replay: tx("历史回放", "Replay"), horizons: tx("周期定义", "Horizons"),
    blend: tx("实时融合", "Live blend"), gates: tx("升级门槛", "Promotion gates"),
    economics: tx("成本模型", "Cost model"), ablation: tx("消融判定", "Ablation verdict"),
    funding: tx("资金费率", "Funding rate"),
  };
  const overridden = new Set(((data && data.overrides) || []).map((item) => item.path));
  const buckets = new Map();
  for (const [path, value] of entries) {
    const head = path.split(".")[0];
    if (!buckets.has(head)) buckets.set(head, []);
    buckets.get(head).push([path, value]);
  }
  const cards = [...buckets].map(([head, items]) => {
    const rows = items.map(([path, value]) => {
      const short = path.split(".").slice(1).join(".") || path;
      const hit = overridden.has(path);
      return `<span class="${hit ? "bull" : "muted"}">${short} <b>${formatTuningValue(value)}</b>${hit ? tx("（环境变量覆盖）", " (env override)") : ""}</span>`;
    }).join("");
    return `<article><b>${titles[head] || head}</b><small class="muted">${head}</small>${rows}</article>`;
  }).join("");
  const overrideNote = data.overrideCount
    ? tx(`当前有 ${data.overrideCount} 项被环境变量覆盖，它们不再等于内置默认值。`, `${data.overrideCount} value(s) overridden by environment, no longer equal to the built-in defaults.`)
    : tx("当前全部使用内置默认值。", "All values are the built-in defaults.");
  const errorNote = data.error ? `<span class="bear">${tx("覆盖解析失败：", "Override parse failed: ")}${data.error}</span>` : "";
  panel.innerHTML = `<div class="research-tuning-summary"><span>${tx("指纹", "Fingerprint")} <b>${data.fingerprint}</b></span><span>${tx("来源", "Source")} ${data.source}</span><span>${tx("配置项", "Leaves")} ${entries.length}</span><span class="${data.overrideCount ? "bull" : "muted"}">${overrideNote}</span>${errorNote}</div><div class="research-tuning-grid">${cards}</div>`;
}
async function loadResearchOutlook(force = false) {
  if (researchOutlookLoading) return;
  researchOutlookLoading = true;
  const card = ensureResearchOutlookCard();
  if (card && !card.innerHTML)
    card.innerHTML = `<div class="research-outlook-head"><div><h2>${tx(coinLabel() + " 多因子研究预测", coinLabel() + " multi-factor research outlook")}</h2><p>${tx("正在读取历史样本、公开新闻与市场结构…", "Reading history samples, public news, and market structure…")}</p></div></div>`;
  try {
    const response = await apiFetch(
        `/api/research-outlook${force ? "?refresh=1" : ""}`,
        20_000,
      ),
      data = await response.json();
    if (!response.ok)
      throw new Error(data.detail || data.error || "request failed");
    renderResearchOutlook(data);
  } catch (error) {
    if (card)
      card.innerHTML = `<div class="research-outlook-head"><div><h2>${tx(coinLabel() + " 多因子研究预测", coinLabel() + " multi-factor research outlook")}</h2><p class="bear">${tx("研究数据暂不可用：", "Research data unavailable: ")}${safeText(error.message)}</p></div><button type="button" id="refreshResearchOutlook">${tx("重试", "Retry")}</button></div>`;
    card
      ?.querySelector("#refreshResearchOutlook")
      ?.addEventListener("click", () => loadResearchOutlook(true));
  } finally {
    researchOutlookLoading = false;
  }
}
let abExperimentPayload = null;
function renderAbExperimentRegistry(payload) {
  abExperimentPayload = payload || abExperimentPayload;
  const holder = $("abExperimentRegistry");
  if (!holder) return;
  const metric = (value) => (Number.isFinite(value) ? value.toFixed(3) : "--"),
    percent = (value) =>
      Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "--",
    experiments = payload?.experiments || [];
  holder.innerHTML =
    experiments
      .map((experiment) => {
        const comparison = experiment.comparison,
          verdict = comparison?.verdict,
          base = comparison?.overall?.baseline || {},
          candidate = comparison?.overall?.candidate || {};
        const tone =
          verdict?.tone || (experiment.status === "active" ? "yellow" : "flat");
        const status =
          experiment.kind === "validation"
            ? tx("覆盖率 / 一致性验证", "coverage / consistency validation")
            : experiment.status === "collecting"
              ? tx("等待特征历史", "awaiting feature history")
              : safeText(
                  txVerdictLabel(verdict?.label) ||
                    tx("继续观察", "continue observing"),
                );
        const samples = comparison
          ? `${tx("配对", "paired")} ${comparison.paired || 0} · ${tx("每周期门槛", "per-horizon gate")} ${comparison.minSamples}`
          : safeText(txExpNote(experiment.note || ""));
        return `<article class="ab-experiment ${tone}"><b>${safeText(txExpName(experiment.name))}</b><span>${safeText(txExpCand(experiment.candidate))}</span><small>${status}${samples ? ` · ${samples}` : ""}</small>${comparison ? `<small>${tx("方向命中", "Directional hit")} ${percent(base.directionalAccuracy)} → ${percent(candidate.directionalAccuracy)} · ${tx("信号覆盖", "Signal coverage")} ${percent(base.coverage)} → ${percent(candidate.coverage)}</small><small>Brier ${metric(base.brier)} → ${metric(candidate.brier)} · Log Loss ${metric(base.logLoss)} → ${metric(candidate.logLoss)} · ${tx("成本后", "After cost")} ${percent(base.economic?.netReturn)} → ${percent(candidate.economic?.netReturn)} · ${tx("回撤", "Drawdown")} ${percent(base.economic?.maxDrawdown)} → ${percent(candidate.economic?.maxDrawdown)}</small>` : ""}</article>`;
      })
      .join("") ||
    `<span>${tx("实验注册表暂不可用。", "Experiment registry unavailable.")}</span>`;
}
let abExperimentLoading = false;
async function loadAbExperimentRegistry() {
  if (abExperimentLoading) return;
  abExperimentLoading = true;
  try {
    const response = await apiFetch("/api/ab-experiments", 10_000),
      data = await response.json();
    if (response.ok) renderAbExperimentRegistry(data);
  } catch {
  } finally {
    abExperimentLoading = false;
  }
}
let researchCandidateTraining = false;
async function trainResearchCandidate() {
  if (researchCandidateTraining) return;
  researchCandidateTraining = true;
  const button = document.querySelector("#trainResearchCandidate");
  if (button) {
    button.disabled = true;
    button.textContent = tx("训练中…", "Training…");
  }
  try {
    const response = await fetch("/api/research-candidates/train", {
        method: "POST",
        cache: "no-store",
      }),
      data = await response.json();
    if (!response.ok)
      throw new Error(data.detail || data.error || "candidate training failed");
    await loadResearchOutlook(true);
  } catch (error) {
    if (button) {
      button.disabled = false;
      button.textContent = tx("训练失败，重试", "Training failed, retry");
    }
    alert(
      `${tx("候选模型训练未完成：", "Candidate training did not complete: ")}${error.message}`,
    );
  } finally {
    researchCandidateTraining = false;
  }
}
setTimeout(() => loadResearchOutlook(), 2_500);
setInterval(() => loadResearchOutlook(), 900_000);

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
          "SQLite + Federal Reserve / BLS / Yahoo / CoinGecko / CoinLore · 每 10 分钟",
          "SQLite + Federal Reserve / BLS / Yahoo / CoinGecko / CoinLore · every 10m",
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
      width = Math.min(340, innerWidth - 28);
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
addFixedRuleSignalEnhancer("stable-alert-slot", () => {
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
  /* Write exactly the existing digit-level price markup. */
  price.innerHTML = [...value]
    .map(
      (character, index) =>
        `<span class="${/\d/.test(character) ? "price-digit" : ""} ${firstChanged >= 0 && index >= firstChanged && /\d/.test(character) ? `changed-${direction}` : ""}">${character}</span>`,
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
      if ($("fedMonitorCard") && macroCalendarData) {
        renderFedMonitor(macroCalendarData);
        paintCorrelationPanel();
      }
    } catch {
      /* 语言切换不应因宏观卡重渲失败而中断。 */
    }
  };
})();

/* ===== v2.11.9：语言切换时整卡重渲研究区两张卡 =====================
   「BTC 多因子研究预测」与「A/B 实验中心」同样按当前语言整卡渲染
   （数据刷新时重建，不随 applyLanguage 逐节点替换）。在此之前，语言
   切换那一刻若只等下一次数据刷新，标题、副标题、按钮与实验注册表文案
   会停留在上一语言（最长约 15 分钟）。这里用缓存的数据就地重渲；
   数据尚未到达时跳过，交给正常的首次渲染。 */
(() => {
  const applyLanguageBeforeResearchLang = applyLanguage;
  applyLanguage = function () {
    applyLanguageBeforeResearchLang();
    try {
      if ($("researchOutlookCard") && researchOutlookData) {
        renderResearchOutlook(researchOutlookData);
      }
      if ($("abEvaluationCard") && abExperimentPayload) {
        renderAbExperimentRegistry(abExperimentPayload);
      }
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
      '#versionChangelog:not([hidden]),#apiCenterModal:not([hidden]),#accountServiceCard:not([hidden]),#localAlertModal:not([hidden]),#pushSettingsModal:not([hidden]),#voiceSettingsModal:not([hidden]),.connectivity-toggle[aria-expanded="true"]',
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

/* ══ 多币种：模式开关 + 币种切换器 / Coin mode toggle & switcher ═════════════
 * 挂在这里（文件末尾）是刻意的：上方的面板渲染函数此时都已就绪，切换币种后
 * 才能安全地逐个重拉。整段不改动比特币模式下的任何既有行为 —— 比特币模式下
 * 开关只显示「₿ 比特币」，切换器隐藏，activeCoin() 恒为 BTC。
 */
(() => {
  const header = document.querySelector("main>header .controls");
  if (!header) return;

  // ── 1. 顶部分段模式开关（位于账号按钮左侧）────────────────────────────────
  const modeBtn = document.createElement("div");
  modeBtn.id = "coinModeToggle";
  modeBtn.className = "coin-mode-segment";
  modeBtn.setAttribute("role", "group");
  modeBtn.setAttribute("aria-label", tx("模式切换", "Mode switch"));
  modeBtn.innerHTML =
    '<button type="button" data-mode="bitcoin" aria-pressed="false">' + tx("₿ 比特币", "₿ Bitcoin") + '</button>' +
    '<button type="button" data-mode="multi" aria-pressed="false">' + tx("多币种", "Multi-coin") + '</button>';
  modeBtn.addEventListener("click", (event) => {
    // 顶栏有全局收起监听，不阻断会让刚展开的浮层立刻关掉。
    event.stopPropagation();
    const chip = event.target.closest && event.target.closest("[data-mode]");
    if (!chip) return;
    setCoinMode(chip.dataset.mode);
  });

  // 账号按钮由 cloud-alerts.js 稍后插入，顺序可能被改写；用观察器兜住位置。
  const placeModeButton = () => {
    const account = $("accountLoginToggle");
    if (account) {
      if (account.previousElementSibling !== modeBtn) header.insertBefore(modeBtn, account);
    } else if (header.firstElementChild !== modeBtn) {
      header.insertBefore(modeBtn, header.firstElementChild);
    }
  };
  placeModeButton();
  if (window.MutationObserver) new MutationObserver(placeModeButton).observe(header, { childList: true });

  // ── 2. 币种切换器（实时价格上方，仅多币种模式可见）──────────────────────
  const hero = document.querySelector(".hero");
  const switcher = document.createElement("div");
  switcher.id = "coinSwitcher";
  switcher.className = "coin-switcher";
  switcher.hidden = true;
  switcher.innerHTML = COIN_KEYS.map(
    (key) =>
      '<button type="button" class="coin-chip" data-coin="' + key + '"><span class="coin-chip-mark">' +
      COINS[key].label + '</span><span class="coin-chip-name">' + COINS[key].name.zh + '</span></button>'
  ).join("");
  switcher.addEventListener("click", (event) => {
    const chip = event.target.closest && event.target.closest("[data-coin]");
    if (!chip) return;
    event.stopPropagation();
    setActiveCoin(chip.dataset.coin);
  });
  if (hero && hero.parentNode) hero.parentNode.insertBefore(switcher, hero);
  else { const main = document.querySelector("main"); if (main) main.append(switcher); }

  // ── 3. 渲染 ─────────────────────────────────────────────────────────────
  const isEn = () => (localStorage.getItem("btc_lang") || "zh") === "en";
  function paintModeButton() {
    const multi = isMultiCoinMode();
    const activeMode = multi ? "multi" : "bitcoin";
    modeBtn.title = multi
      ? "当前：多币种模式（可切换 BTC / ETH / ZEC / BNB）—— 点击左侧按钮回到比特币模式"
      : "当前：比特币模式 —— 点击右侧按钮切换到多币种模式";
    modeBtn.querySelectorAll("[data-mode]").forEach((btn) => {
      const on = btn.dataset.mode === activeMode;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-pressed", String(on));
    });
  }
  function paintSwitcher() {
    switcher.hidden = !isMultiCoinMode();
    switcher.querySelectorAll("[data-coin]").forEach((chip) => {
      const on = chip.dataset.coin === activeCoin();
      chip.classList.toggle("is-active", on);
      chip.setAttribute("aria-pressed", String(on));
      const nameEl = chip.querySelector(".coin-chip-name");
      if (nameEl) nameEl.textContent = isEn() ? COINS[chip.dataset.coin].name.en : COINS[chip.dataset.coin].name.zh;
    });
  }
  /** 把页面里写死的「BTC / USDT」之类文案改成当前币种。
   *  比特币模式下**原样还原**挂载时抓到的字符串，一个字都不动 —— 这是「比特币模式
   *  等于旧版页面」这条硬约束在文案层的体现。 */
  const h1El = document.querySelector("main>header h1");
  const mutedEl = document.querySelector(".hero .muted");
  const ORIGINAL = { title: document.title, h1: h1El && h1El.textContent, muted: mutedEl && mutedEl.textContent };
  function paintCoinLabels() {
    const base = activeCoin() === BASE_COIN;
    if (base) {
      document.title = ORIGINAL.title;
      if (h1El && ORIGINAL.h1 != null) h1El.textContent = ORIGINAL.h1;
      if (mutedEl && ORIGINAL.muted != null) mutedEl.textContent = ORIGINAL.muted;
      return;
    }
    const pair = coinPair(), suffix = isEn() ? "Long/Short Indicator" : "多空指标指示器";
    document.title = pair + " " + suffix;
    // h1 与标题保持一致；₿ 是比特币专属符号，非 BTC 时不展示，避免 ETH/ZEC/BNB 误带 ₿。
    // h1 mirrors the document title; ₿ is Bitcoin-specific and is omitted for non-BTC coins.
    if (h1El) h1El.textContent = document.title;
    if (mutedEl) mutedEl.textContent = pair;
  }
  function paint() { paintModeButton(); paintSwitcher(); paintCoinLabels(); }

  // ── 4. 切换动作 ─────────────────────────────────────────────────────────
  function setCoinMode(mode) {
    coinMode = mode === "multi" ? "multi" : "bitcoin";
    localStorage.setItem(COIN_MODE_KEY, coinMode);
    paint();
    refreshCoinPanels();
    notifyCoinChanged();
  }
  function setActiveCoin(coin) {
    const key = normalizeCoin(coin);
    if (key === selectedCoin && isMultiCoinMode()) return;
    selectedCoin = key;
    localStorage.setItem(COIN_SYMBOL_KEY, selectedCoin);
    paint();
    refreshCoinPanels();
    notifyCoinChanged();
  }
  function notifyCoinChanged() {
    const label = coinLabel() + "（" + coinNameOf() + "）";
    window.dispatchEvent(new CustomEvent("btc:coin-changed", { detail: { coin: activeCoin(), mode: coinMode } }));
    try { showAppDialog({ message: "已切换到 " + label + "，正在重新加载该币种的全部数据。", confirmText: "好" }); }
    catch { /* 弹层未就绪时静默 */ }
  }
  /** 切换后逐个重拉与币种相关的面板；任一面板自身失败不该影响其它面板。 */
  function refreshCoinPanels() {
    const jobs = [
      () => loadCurrent(),
      () => loadQuote(),
      () => loadDerivativeMarketContext(true),
      () => loadHorizonForecasts(),
      () => loadResearchOutlook(true),
      () => refreshResonance(false),
      () => loadFedMonitor(),
      () => loadInvestmentCalendar(true),
      () => loadFixedRuleSignal(true),
      () => renderPosition(),
    ];
    for (const job of jobs) { try { Promise.resolve(job()).catch(() => {}); } catch { /* ignore */ } }
  }

  // 语言切换时同步币种名称与标题。
  window.addEventListener("btc:voice-language-changed", () => { paint(); });
  paint();
  window.btcCoinContext = {
    mode: () => coinMode, coin: activeCoin,
    setMode: setCoinMode, setCoin: setActiveCoin, repaint: paint
  };
})();
