const $ = (id) => document.getElementById(id);
/* Use the application's dialog style instead of browser-native prompts. */
function showAppDialog({
  title = "提示",
  message = "",
  confirmText = "我知道了",
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
function ema(values, p) {
  const out = Array(values.length).fill(NaN),
    k = 2 / (p + 1);
  if (values.length < p) return out;
  out[p - 1] = values.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < values.length; i++)
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  return out;
}
function rsi(values, p = 14) {
  const out = Array(values.length).fill(NaN);
  if (values.length <= p) return out;
  let g = 0,
    l = 0;
  for (let i = 1; i <= p; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) g += d;
    else l -= d;
  }
  let ag = g / p,
    al = l / p;
  out[p] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = p + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    ag = (ag * (p - 1) + Math.max(d, 0)) / p;
    al = (al * (p - 1) + Math.max(-d, 0)) / p;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}
function atr(data, p = 14) {
  const out = Array(data.length).fill(NaN);
  if (data.length <= p) return out;
  let s = 0;
  for (let i = 1; i <= p; i++)
    s += Math.max(
      data[i].high - data[i].low,
      Math.abs(data[i].high - data[i - 1].close),
      Math.abs(data[i].low - data[i - 1].close),
    );
  out[p] = s / p;
  for (let i = p + 1; i < data.length; i++) {
    const tr = Math.max(
      data[i].high - data[i].low,
      Math.abs(data[i].high - data[i - 1].close),
      Math.abs(data[i].low - data[i - 1].close),
    );
    out[i] = (out[i - 1] * (p - 1) + tr) / p;
  }
  return out;
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
  $("connection").textContent = "正在加载当前图表…";
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
      `图表覆盖：${time(data.candles[0].time)} 至 ${time(data.candles.at(-1).time)} · ${data.candles.length} 根 · 仅此范围参与回测`;
    $("connection").textContent = data.cached
      ? "已显示缓存数据"
      : "实时 REST 数据已更新";
    $("freshness").textContent =
      `${new Date(data.fetchedAt).toLocaleTimeString("zh-CN")}`;
  } catch (e) {
    $("connection").textContent = "行情暂不可用：保留最近成功数据";
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
async function resonance() {
  const btn = $("loadResonance");
  btn.disabled = true;
  btn.textContent = "计算中…";
  $("resonance").textContent = "正在按需请求 15m、1h、4h、1d…";
  try {
    const arr = await Promise.all(
      ["15m", "1h", "4h", "1d"].map(async (interval) => {
        const r = await fetch(
          "/api/market?" +
            new URLSearchParams({ interval, limit: 200, source: state.source }),
        );
        const x = await r.json();
        if (!r.ok) throw new Error(`${interval}: ${x.error}`);
        const m = metrics(x.candles);
        return `${interval}：${classification(m.score)[0]} ${m.score > 0 ? "+" : ""}${m.score}（${x.source}）`;
      }),
    );
    $("resonance").textContent = arr.join("　|　");
  } catch (e) {
    $("resonance").textContent = "共振计算失败：" + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "重新计算共振";
  }
}
let quoteLoading = false;
async function loadQuote() {
  if (quoteLoading || !state.ticker) return;
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
  }
}
$("source").onchange = (e) => {
  state.source = e.target.value;
  loadCurrent();
};
$("loadResonance").onclick = resonance;
buttons();
setTimeout(() => loadCurrent(), 0);
setInterval(() => {
  if (["5s", "10s", "30s"].includes(state.interval)) loadCurrent();
}, 2_000);
setInterval(() => {
  if (!["5s", "10s", "30s"].includes(state.interval)) loadCurrent();
}, 10_000);
setInterval(() => loadQuote(), 1_000);

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
  // 周期涨幅放在主 K 线卡片内，紧跟 OKX 微观结构卡片，避免被右侧 side-stack 高度推下去。
  // Keep period returns inside the main chart column, directly after the OKX microstructure card,
  // so the right column's height never creates an empty gap in the chart column.
  chartCard.append(changes);
  layout.append(chartCard, side);
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
      layout.replaceChildren(chart, side);
      // 周期涨幅固定在主 K 线卡片内（紧跟 OKX 微观结构），不让右列高度把它推下去。
      if (changes && !chart.contains(changes)) chart.append(changes);
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
      hi = Math.max(...window.map((x) => x.high)),
      lo = Math.min(...window.map((x) => x.low));
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
  status.textContent = "正在对齐 BTC、SPY、QQQ 的共同交易日并训练…";
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
  // 创建美股联动卡片，并追加到主内容区末尾，避免依赖已移除的回测锚点。
  const main = document.querySelector("main");
  const card = document.createElement("section");
  card.className = "card correlation-card";
  card.innerHTML =
    '<div class="forecast-head"><div><h2>BTC × 美股联动分析</h2><p id="correlationStatus">等待市场数据…</p></div><button id="refreshCorrelation">更新分析</button></div><div id="indexTickerCards" class="index-ticker-cards"></div><div id="correlationOutput" class="correlation-output"></div>';
  main.append(card);
  $("refreshCorrelation").onclick = loadCorrelation;
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
  const anchor = document.querySelector(".correlation-card");
  anchor.after(details);
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
    correlation: "BTC × 美股联动分析",
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
  const c = document.querySelector(".correlation-card h2");
  if (c) c.textContent = x.correlation;
  const b = $("langToggle");
  if (b) b.textContent = uiLang === "zh" ? "EN" : "中文";
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
  apiCenter.textContent = "API 接入中心";
  apiCenter.title = "管理数据源 API 接入";
  controls.append(apiCenter, lang, fullscreen, theme);
  const apiCenterModal=document.createElement("div");
  apiCenterModal.id="apiCenterModal";
  apiCenterModal.className="alert-composer api-center-modal";
  apiCenterModal.hidden=true;
  document.body.append(apiCenterModal);
  const apiCenterRequest=async(path, options={})=>{const response=await fetch(path,{...options,headers:{'content-type':'application/json',...(options.headers||{})}}),body=await response.json().catch(()=>({}));if(!response.ok)throw new Error(body.error||"请求失败");return body;};
  const apiCenterFree=[['市场行情','OKX · Coinbase · Binance · Gate','无需填入'],['宏观日程','美联储 · BLS 日程 · 美国财政部 · EIA 发布时间 · CFTC','无需填入'],['加密与链上','mempool.space · Deribit 公共行情 · CoinLore · Alternative.me','无需填入'],['市场环境','Yahoo Finance（公开入口）','无需填入']];
  const apiCenterOptional=[['coingecko','CoinGecko','加密市场总市值、BTC 占比','可以填入高级或升级版的 API key，如果不填，就默认使用已接入的免费版'],['eia','EIA','原油库存的完整实际值与历史数据','可填写免费 EIA API key；不填仍默认使用已接入的 EIA 发布时间日历'],['custom','自定义 HTTPS API','手动订阅的数据源地址与可选 API Key','仅接受 HTTPS 地址；地址和 Key 均以相同的服务端加密逻辑保存，不会回显']];
  // 千问 mini 额度卡的渲染：复用 /api/ai/quota，单函数一处渲染全部字段。
  // Qwen mini quota renderer: reuses /api/ai/quota, a single function covers all fields.
  const renderApiQwenQuota=async(card)=>{
    if(!card)return;
    const fill=card.querySelector('.api-qwen-quota-fill');
    const pct=card.querySelector('.api-qwen-quota-pct');
    const meta=card.querySelector('.api-qwen-quota-meta');
    let payload=null;
    try { const res=await fetch('/api/ai/quota'); if(res.ok)payload=await res.json(); } catch {}
    if(!payload||!payload.configured){ card.setAttribute('data-empty','true'); pct.textContent='—'; fill.style.width='0%'; meta.textContent='保存 Key 后再提问一次即可显示额度'; return; }
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
      meta.innerHTML=`剩余 <b>${remote.remaining.toLocaleString()}</b> / ${limitNum}（${usedNum} 已用 · ${usedPct.toFixed(1)}%）${resetAt?` · 重置 ${resetAt}`:''}${cd?` · ${cd} 后`:''} · 累计 ${local.calls||0} 次 / ${(local.totalTokens||0).toLocaleString()} tokens`;
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
      meta.innerHTML=`估算已用 <b>${estCredits.toFixed(1)}</b> credits / ${estimateLimit}（本地估算 · Token Plan Lite 默认） · 累计 ${local.calls} 次 / ${(local.totalTokens||0).toLocaleString()} tokens${resetTxt?` · 重置 ${resetTxt}`:''}${cd?`（${cd}）`:''} · <span style="color:#ffcb69">精确剩余请到 Token Plan 控制台查看</span>`;
    } else {
      card.setAttribute('data-empty','true');
      pct.textContent='—';
      fill.style.width='0%';
      meta.textContent='尚未调用千问，额度无数据';
    }
  };
  const renderApiCenter=async()=>{
    let credentials={},verification={},coinGeckoUsage=null; try { const payload=await apiCenterRequest('/api/api-center'); credentials=payload.credentials||{}; verification=payload.verification||{}; coinGeckoUsage=payload.coinGeckoUsage||null; } catch {}
    window.dispatchEvent(new CustomEvent('btc:ai-credential-changed', { detail:{ available:Boolean(credentials.qwen && verification.qwen) } }));
    const free=apiCenterFree.map(([group,name,note])=>`<article class="api-center-row free"><div><b>${group}</b><span>${name}</span></div><em>${note}</em></article>`).join('');
    // 千问配置需要模型列表与当前选择，单独从 AI 配置接口取。
    // The Qwen card needs the model list and current choice, fetched from the AI config endpoint.
    let aiConfig={configured:false,model:'',models:[]}; try { aiConfig=await (await fetch('/api/ai/config')).json(); } catch {}
    // 模型下拉：只列可用于问答的文本模型，并标出额度档位（省 / 中 / 贵）。
    // Model picker: only chat-capable text models, tagged with their credit tier.
    const qwenTierTag={value:'省',balanced:'中',flagship:'贵'};
    const qwenModels=(aiConfig.models||[]).filter(entry=>entry.usable!==false).map(entry=>{const tag=qwenTierTag[entry.tier]||'';return `<option value="${calendarEscape(entry.id)}"${entry.id===aiConfig.model?' selected':''}>${calendarEscape(entry.label)}${tag?' · '+tag:''}${entry.recommended?'（推荐）':''}</option>`;}).join('');
    // 端点快捷选择：千问两套体系（按量付费 / Token Plan 订阅），端点与 Key 必须配套。
    // Endpoint picker: Qwen has two isolated systems and the endpoint must match the key.
    const qwenEndpoints=(aiConfig.endpoints||[]).map(entry=>`<option value="${calendarEscape(entry.baseUrl)}"${entry.baseUrl===aiConfig.baseUrl?' selected':''}>${calendarEscape(entry.label)}</option>`).join('');
    const qwenEndpointNote=aiConfig.baseUrl?`<p class="api-endpoint-note">当前端点：<code>${calendarEscape(aiConfig.baseUrl)}</code> · 识别为${aiConfig.keyKind==='token-plan'?'Token Plan 订阅 Key（sk-sp-）':'按量付费 Key（sk-）'}${aiConfig.mismatch?'<b class="api-endpoint-warn"> · ⚠️ 与 Key 前缀不匹配，调用会返回 401</b>':''}${aiConfig.autoCorrected?'<b class="api-endpoint-warn"> · 已自动纠正为匹配端点</b>':''}</p>`:'';
    // 千问额度小卡：进度条 + 剩余 % + 倒计时，与右下角 AI 助手面板同源。
    // Qwen quota mini card: bar + remaining % + countdown, mirrors the chat-panel source.
    const qwenQuotaMarkup=`<div class="api-qwen-quota" data-empty="true"><div class="api-qwen-quota-bar"><div class="api-qwen-quota-fill"></div></div><span class="api-qwen-quota-pct">—</span><span class="api-qwen-quota-meta">尚未调用千问，额度无数据</span></div>`;
    const qwen=`<article class="api-center-row"><div><b>千问 Qwen<small>AI 行情助手</small>${verification.qwen?'<span class="badge bull api-verified">已验证</span>':''}</b><span>为右下角 AI 助手提供行情解读与涨跌判断；默认 <code>${calendarEscape(aiConfig.defaultModel||'qwen3.8-flash')}</code>，额度消耗约为旗舰的 1/15</span><p>两种 Key 体系，<b>端点必须配套</b>，混用一律 401：① 按量付费（<code>sk-</code> / <code>sk-ws-</code>）→ DashScope 端点；② Token Plan 个人版订阅（<code>sk-sp-</code>）→ Token Plan 端点。Token Plan 的 Key 在「我的订阅」页面生成，只完整显示一次。Key 仅以服务端加密方式保存，不会回显。</p>${qwenEndpointNote}${qwenQuotaMarkup}</div><form data-api-provider="qwen" autocomplete="off"><input name="key" type="password" autocomplete="new-password" placeholder="${credentials.qwen?'已保存，重新填写以更新':'sk-… / sk-sp-… 千问 API Key'}" data-1p-ignore="true" data-lpignore="true" ${credentials.qwen?'data-saved="true"':''}><label>模型<select name="model">${qwenModels}</select></label><label>端点类型<select name="endpoint" class="qwen-endpoint"><option value="">按 Key 前缀自动匹配（推荐）</option>${qwenEndpoints}</select></label><label>API 地址（可选，留空自动匹配）<input name="url" type="url" inputmode="url" autocomplete="off" aria-label="Qwen compatible endpoint" placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"></label><button>${credentials.qwen?'更新 Key':'保存 Key'}</button><button type="button" class="api-verify-qwen">验证 Key</button>${credentials.qwen?'<button type="button" class="api-clear">清除</button>':''}</form></article>`;
    const coinGeckoUsageMarkup=(()=>{if(!credentials.coingecko)return '<div class="coingecko-usage muted">保存 CoinGecko Demo Key 后显示月度额度统计。</div>';if(!coinGeckoUsage?.available)return `<div class="coingecko-usage error">额度暂不可用：${calendarEscape(coinGeckoUsage?.reason||'请稍后重试')}</div>`;const used=coinGeckoUsage.used,limit=coinGeckoUsage.monthlyLimit,remaining=coinGeckoUsage.remaining,pct=Number.isFinite(used)&&Number.isFinite(limit)&&limit>0?Math.min(100,used/limit*100):0,next=new Date();next.setMonth(next.getMonth()+1,1);next.setHours(0,0,0,0);return `<div class="coingecko-usage"><div><b>CoinGecko 月度额度 · ${calendarEscape(coinGeckoUsage.plan)}</b><strong>${Number.isFinite(pct)?pct.toFixed(1):'--'}%</strong></div><i><span style="width:${pct}%"></span></i><p>${Number.isFinite(used)?used.toLocaleString():'--'} 已用 · ${Number.isFinite(remaining)?remaining.toLocaleString():'--'} 剩余 · 月度总额 ${Number.isFinite(limit)?limit.toLocaleString():'--'}</p><small>${coinGeckoUsage.rateLimit?`限额 ${coinGeckoUsage.rateLimit}/分钟 · `:''}下次重置 ${next.toLocaleDateString('zh-CN')} · 统计缓存 5 分钟</small></div>`;})();
    const optional=apiCenterOptional.map(([id,name,scope,hint])=>`<article class="api-center-row"><div><b>${name}<small>可选升级（默认免费）</small>${verification[id]?'<span class="badge bull api-verified">已验证</span>':''}</b><span>${scope}</span><p>${hint}</p>${id==='coingecko'?coinGeckoUsageMarkup:''}</div><form data-api-provider="${id}" autocomplete="off">${id==='custom'?`<label>API URL<input name="url" type="url" inputmode="url" autocomplete="url" aria-label="HTTPS API URL" placeholder="https://api.example.com/v1/data" data-1p-ignore="true" data-lpignore="true" ${credentials[id]?'data-saved="true"':''}></label><label>API Key（${credentials[id]?'重新填写以更新':'可选'}）<input name="key" type="password" autocomplete="new-password" aria-label="Optional API key" placeholder="可选 API Key（不会回显）" data-1p-ignore="true" data-lpignore="true"></label>`:`<input name="key" type="password" autocomplete="off" placeholder="${hint}" ${credentials[id]?'data-saved="true"':''}>`}<button>${credentials[id]?'更新':'保存'}${id==='custom'?'配置':' Key'}</button>${credentials[id]&&id!=='custom'?'<button type="button" class="api-verify">验证 Key</button>':''}${credentials[id]?'<button type="button" class="api-clear">清除</button>':''}</form></article>`).join('');
    apiCenterModal.innerHTML=`<section role="dialog" aria-modal="true" aria-labelledby="apiCenterTitle"><header><div><b id="apiCenterTitle">API 接入中心</b><small>密钥仅保存于本机服务端，不会回显到浏览器</small></div><button type="button" data-close-api-center aria-label="关闭">×</button></header><div class="api-center-body"><h3>默认免费（无需填入）</h3>${free}<h3>可选升级（默认免费）</h3>${optional}<h3>AI 大模型（可选）</h3>${qwen}<h3>付费数据（可选）</h3><article class="api-center-row required"><div><b>Finnhub Economic Calendar<small>付费套餐</small>${verification.finnhub?'<span class="badge bull api-verified">Key 已验证</span>':''}</b><span>宏观实际值、市场一致预期、前值</span><p>免费 Key 可验证基础行情，但 Economic Calendar 需要付费套餐；未开通时自动使用内置公开宏观日历。</p></div><form data-api-provider="finnhub"><input name="key" type="password" autocomplete="off" placeholder="可选：仅付费套餐可启用 Economic Calendar" ${credentials.finnhub?'data-saved="true"':''}><button>${credentials.finnhub?'更新 Key':'保存 Key'}</button>${credentials.finnhub?'<button type="button" class="api-verify">验证 Key</button><button type="button" class="api-clear">清除</button>':''}</form></article></div></section>`;
    apiCenterModal.querySelector('[data-close-api-center]').onclick=()=>{apiCenterModal.hidden=true;};
    apiCenterModal.onclick=event=>{if(event.target===apiCenterModal)apiCenterModal.hidden=true;};
    apiCenterModal.querySelectorAll('form[data-api-provider]').forEach(form=>form.onsubmit=async event=>{event.preventDefault();const provider=form.dataset.apiProvider,key=(form.elements.key?.value||'').trim(),url=(form.elements.url?.value||'').trim(),model=(form.elements.model?.value||'').trim();if(provider==='custom'?!url:!key){showAppDialog({title:'API 接入中心',message:provider==='custom'?'请填写有效的 HTTPS API 地址。':'请填写 API Key。'});return;}try{await apiCenterRequest('/api/api-center',{method:'PUT',body:JSON.stringify({provider,key,url,model})});const saved=await window.btcSecureVault?.get('api-center')||{};await window.btcSecureVault?.put('api-center',{...saved,[provider]:{key,url}});await renderApiCenter();}catch(error){showAppDialog({title:'API 接入中心',message:error.message});}});
    apiCenterModal.querySelectorAll('.api-clear').forEach(button=>button.onclick=async()=>{try{const provider=button.closest('form').dataset.apiProvider;await apiCenterRequest(`/api/api-center?provider=${provider}`,{method:'DELETE'});const saved=await window.btcSecureVault?.get('api-center')||{};delete saved[provider];await window.btcSecureVault?.put('api-center',saved);await renderApiCenter();}catch(error){showAppDialog({title:'API 接入中心',message:error.message});}});
    apiCenterModal.querySelectorAll('.api-verify').forEach(button=>button.onclick=async()=>{const provider=button.closest('form').dataset.apiProvider;button.disabled=true;button.textContent='验证中…';try{const result=await apiCenterRequest('/api/api-center/verify',{method:'POST',body:JSON.stringify({provider})});if(result.valid)await renderApiCenter();showAppDialog({title:'API Key 验证',message:result.message});}catch(error){showAppDialog({title:'API Key 验证',message:error.message});}finally{button.disabled=false;button.textContent='验证 Key';}});
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
    if(qwenVerifyButton)qwenVerifyButton.onclick=async()=>{const form=apiCenterModal.querySelector('form[data-api-provider="qwen"]');const key=(form?.elements.key?.value||'').trim(),model=(form?.elements.model?.value||'').trim(),url=(form?.elements.url?.value||'').trim();if(!key&&!credentials.qwen){showAppDialog({title:'千问 API Key 验证',message:'请先填写 API Key 再验证。'});return;}qwenVerifyButton.disabled=true;qwenVerifyButton.textContent='验证中…';try{if(key){await apiCenterRequest('/api/api-center',{method:'PUT',body:JSON.stringify({provider:'qwen',key,url,model})});window.dispatchEvent(new CustomEvent('btc:ai-credential-changed',{detail:{available:false}}));}const result=await apiCenterRequest('/api/api-center/verify',{method:'POST',body:JSON.stringify({provider:'qwen'})});await renderApiCenter();showAppDialog({title:'千问 API Key 验证',message:result.message});}catch(error){await renderApiCenter();showAppDialog({title:'千问 API Key 验证',message:error.message});}finally{qwenVerifyButton.disabled=false;qwenVerifyButton.textContent='验证 Key';}};

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
const tx = (zh, en) => (uiLang === "zh" ? zh : en);
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
document.addEventListener("pointerover", (event) => {
  const dot = event.target.closest?.(".help-dot[data-tip]");
  if (dot) showFloatingHelpTip(dot);
});
document.addEventListener("pointerout", (event) => {
  const dot = event.target.closest?.(".help-dot[data-tip]");
  if (dot && !dot.contains(event.relatedTarget)) hideFloatingHelpTip(dot);
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
window.addEventListener("scroll", () => hideFloatingHelpTip(), true);
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
  document
    .querySelectorAll(".optional h2,.change-card h2")
    .forEach((x) =>
      addHelp(
        x,
        "多周期共振用于检查 15 分钟、1 小时、4 小时和日线的方向是否一致；一致性越高，规则信号的背景一致性越好，但不等于预测必然正确。",
        "Multi-period resonance checks whether 15m, 1h, 4h and daily signals point in the same direction. Higher agreement is contextual support, not certainty.",
      ),
    );
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
    return true;
  } catch (e) {
    $("connection").textContent = tx(
      "行情暂不可用，保留最近成功图表",
      "Market unavailable; keeping the last successful chart",
    );
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
  const c = document.querySelector(".correlation-card h2");
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
      hi = Math.max(...s.map((v) => v.high)),
      lo = Math.min(...s.map((v) => v.low)),
      change = (s.at(-1).close / s[0].open - 1) * 100;
    const el = $("selectionStats");
    if (el)
      el.innerHTML = `<b>${tx("已选区段", "Selected")}</b> ${pointTime(s[0].time)} — ${pointTime(s.at(-1).time)} · <span class="high">${tx("最高", "High")} ${money(hi)}</span> · <span class="low">${tx("最低", "Low")} ${money(lo)}</span> · <span class="${change >= 0 ? "bull" : "bear"}">${tx("涨跌", "Return")} ${pct(change)}</span>`;
  };
  cv.addEventListener("pointerdown", (e) => {
    chartSelection = { start: index(e), end: index(e) };
    cv.setPointerCapture(e.pointerId);
    stats();
    draw();
  });
  cv.addEventListener("pointermove", (e) => {
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
  set(".optional h2", "多周期共振", "Multi-period resonance");
  set(
    ".optional p",
    "仅在点击后请求额外 4 个周期。",
    "Requests four additional timeframes only when selected.",
  );
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
      (Math.max(...w.map((x) => x.high)) - Math.min(...w.map((x) => x.low))) /
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

/* Modal-style local alert composer.  The SendKey and alert rules remain in
   this browser only; ServerChan receives a push directly from the browser. */
setTimeout(() => {
  const old = $("wechatAlertCard");
  if (old) old.remove();
  const main = document.querySelector("main");
  if (!main) return;
  const keyStore = "btc_local_serverchan_sendkey_v1",
    ruleStore = "btc_local_notification_rules_v1";
  let previous = null,
    repeat = false,
    rules = [];
  try {
    const saved = JSON.parse(localStorage.getItem(ruleStore) || "[]");
    if (Array.isArray(saved))
      rules = saved
        .filter((x) => x && x.id && Number(x.targetPrice) > 0)
        .slice(0, 30)
        .map((x) => ({
          ...x,
          kind: x.kind || "price_reached",
          repeat: x.repeat === false ? false : true,
          cooldownMinutes: Math.max(1, Number(x.cooldownMinutes) || 5),
        }));
  } catch {}
  // Migrate any legacy plaintext once, then keep only AES-GCM ciphertext in
  // IndexedDB.  The key is non-extractable and never written to localStorage.
  const legacyAlertState=rules.length?rules:null,legacySendKey=localStorage.getItem(keyStore)||'';
  if(/^SCT/i.test(legacySendKey))sessionStorage.setItem(keyStore,legacySendKey);
  localStorage.removeItem(ruleStore);
  localStorage.removeItem(keyStore);
  const save = () => { window.btcSecureVault?.put('alerts',{rules,sendKey:(sessionStorage.getItem(keyStore)||'').trim()}).catch(error=>console.warn('Local encrypted save failed:',error.message)); },
    price = () => state?.ticker?.last,
    fmt = (n) =>
      Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 });
  const card = document.createElement("section"),
    details = document.createElement("details");
  details.id = "wechatAlertDetails";
  details.className = "position-details alert-details";
  details.innerHTML = `<summary>${tx("消息推送", "Message alerts")}</summary>`;
  card.id = "wechatAlertCard";
  card.className = "card wechat-alert-card";
  card.innerHTML = `<div class="forecast-head"><div><h2>${tx("消息推送", "Message alerts")}</h2><p id="localAlertDescription">${tx("未登录时 SendKey 仅保存在当前会话；登录后可加密保存到云端。", "When signed out, SendKey stays only in this session; sign in to encrypt it in the cloud.")}</p></div><span id="localAlertState" class="badge flat"></span></div><form id="localKeyForm" class="wechat-key-form"><label>${tx("Server酱 SendKey", "ServerChan SendKey")}<input name="key" type="password" autocomplete="off" placeholder="SCT…"></label><a href="https://sct.ftqq.com/sendkey" target="_blank" rel="noopener">${tx("获取 SendKey", "Get SendKey")}</a><button id="localKeySave">${tx("保存到当前会话", "Save for this session")}</button><button type="button" id="localAlertTest">${tx("测试当前市价", "Test current price")}</button><button type="button" id="localAlertClear" class="danger">${tx("清除本机 Key", "Clear local Key")}</button></form><div class="alert-rule-toolbar"><b>₿ BTCUSDT ${tx("永续", "Perpetual")}</b><div><button type="button" id="clearLocalAlerts" class="danger">${tx("批量全删", "Delete all")}</button><button type="button" id="openLocalAlert">＋ ${tx("添加预警", "Add alert")}</button></div></div><div id="localAlertList" class="wechat-alert-detail"></div><div id="localAlertModal" class="alert-composer" hidden><section><header><b>${tx("添加预警", "Add alert")}</b><button type="button" id="closeLocalAlert">×</button></header><p class="alert-symbol">₿ <b>BTCUSDT ${tx("永续", "Perpetual")}</b></p><form id="localAlertForm"><label>${tx("预警类型", "Alert type")}<select name="kind"><option value="price_reached">${tx("价格达到", "Price reached")}</option><option value="price_above">${tx("价格上涨至", "Price rises to")}</option><option value="price_below">${tx("价格下跌至", "Price falls to")}</option><option value="long_liquidation">${tx("多头爆仓价", "Long liquidation")}</option><option value="short_liquidation">${tx("空头爆仓价", "Short liquidation")}</option></select></label><label>${tx("价格", "Price")}<span class="mark-price">${tx("市价", "Mark")} <button type="button" id="useLocalMark">--</button></span><input name="target" type="number" inputmode="decimal" min="0" step="0.01" required placeholder="80000"><em>USDT</em></label><div class="frequency"><b>${tx("频率", "Frequency")}</b><div><button type="button" data-local-frequency="once" class="active">${tx("仅提醒一次", "Once")}</button><button type="button" data-local-frequency="repeat">${tx("重复提醒", "Repeat")}</button></div></div><label id="localCooldown" hidden>${tx("冷却时间（分钟）", "Cooldown (minutes)")}<input name="cooldown" type="number" inputmode="numeric" min="1" step="1" value="5"></label><label class="voice-rule-option"><input name="voiceEnabled" type="checkbox" checked>${tx("触发时语音播报", "Speak when triggered")}</label><button class="alert-submit">${tx("添加", "Add")}</button></form></section></div>`;
  const submitAlert = card.querySelector(".alert-submit"),
    alertActions = document.createElement("div");
  alertActions.className = "alert-actions";
  alertActions.innerHTML = `<button type="button" id="localRuleTest">${tx("测试当前规则（不保存）", "Test rule (not saved)")}</button>`;
  submitAlert.before(alertActions);
  alertActions.append(submitAlert);
  const notice = document.createElement("div");
  notice.id = "localRuleNotice";
  notice.className = "alert-composer alert-notice";
  notice.hidden = true;
  notice.innerHTML = `<section role="dialog" aria-modal="true" aria-labelledby="localRuleNoticeTitle"><header><b id="localRuleNoticeTitle">${tx("规则测试已发送", "Rule test sent")}</b><button type="button" id="closeLocalRuleNotice" aria-label="${tx("关闭", "Close")}">×</button></header><div class="notice-body"><span>✓</span><p>${tx("当前规则测试请求已发送。通知标题会标注“【测试】”，该规则不会被保存，也不会影响已有规则的冷却时间。", "The current-rule test was sent. Its notification is labeled “Test”; this rule is not saved and does not affect existing cooldowns.")}</p></div><button type="button" id="confirmLocalRuleNotice" class="alert-submit">${tx("我知道了", "Got it")}</button></section>`;
  document.body.append(notice);
  details.append(card);
  (main.querySelector("footer") || main.lastElementChild).before(details);
  const keyForm = $("localKeyForm"),
    keyInput = keyForm.elements.key,
    stateEl = $("localAlertState"),
    description = $("localAlertDescription"),
    saveKeyButton = $("localKeySave"),
    testButton = $("localAlertTest"),
    clearKeyButton = $("localAlertClear"),
    list = $("localAlertList"),
    modal = $("localAlertModal"),
    form = $("localAlertForm");
  let cloudSession = { loggedIn: false, hasSendKey: false };
  keyInput.value = sessionStorage.getItem(keyStore) || "";
  const showRuleNotice = (open) => {
    notice.hidden = !open;
  };
  $("closeLocalRuleNotice").onclick = () => showRuleNotice(false);
  $("confirmLocalRuleNotice").onclick = () => showRuleNotice(false);
  notice.onclick = (event) => {
    if (event.target === notice) showRuleNotice(false);
  };
  const label = (kind) =>
    ({
      price_reached: tx("价格达到", "Price reaches"),
      price_above: tx("价格上涨至", "Price rises to"),
      price_below: tx("价格下跌至", "Price falls to"),
      long_liquidation: tx("多头爆仓价", "Long liquidation"),
      short_liquidation: tx("空头爆仓价", "Short liquidation"),
    })[kind] || kind;
  const alertCategory = (kind) =>
    kind === "long_liquidation" || kind === "short_liquidation"
      ? tx("爆仓告警", "Liquidation alert")
      : tx("价格告警", "Price alert");
  const alertPhrase = (kind, price) =>
    uiLang === "zh"
      ? ({
          price_reached: `BTC价格达到 ${price}`,
          price_above: `BTC价格上涨至 ${price}`,
          price_below: `BTC价格下跌至 ${price}`,
          long_liquidation: `BTC价格接近多头爆仓价 ${price}`,
          short_liquidation: `BTC价格接近空头爆仓价 ${price}`,
        })[kind] || `BTC价格 ${price}`
      : ({
          price_reached: `BTC price reaches ${price}`,
          price_above: `BTC price rises to ${price}`,
          price_below: `BTC price falls to ${price}`,
          long_liquidation: `BTC price nears long liquidation ${price}`,
          short_liquidation: `BTC price nears short liquidation ${price}`,
        })[kind] || `BTC price ${price}`;
  const alertTitle = (kind, target, { test = false } = {}) => {
    const phrase = alertPhrase(kind, target);
    if (test) return `${alertCategory(kind)}【${tx("测试", "Test")}】 ${phrase}`;
    return kind === "long_liquidation" || kind === "short_liquidation"
      ? `【${tx("爆仓", "Liquidation")}】${phrase.replace(/^BTC价格/, uiLang === "zh" ? "BTC价格" : "BTC price")}`
      : `【${tx("价格", "Price")}】${phrase}`;
  };
  const triggerText = (rule) =>
    rule.lastTriggeredAt
      ? `${new Date(rule.lastTriggeredAt).toLocaleString(uiLang === "zh" ? "zh-CN" : "en-US", { hour12: false })} · ${tx("实时", "Live")} ${Number.isFinite(Number(rule.lastTriggeredPrice)) ? `${fmt(rule.lastTriggeredPrice)} USDT` : "--"}`
      : "";
  const render = () => {
    const ready = /^SCT/i.test((sessionStorage.getItem(keyStore) || "").trim()),
      cloudCount = rules.filter((r) => r.cloudManaged).length,
      localCount = rules.length - cloudCount,
      cloudReady = cloudSession.loggedIn && cloudSession.hasSendKey;
    stateEl.className = `badge ${cloudCount || ready || cloudReady ? "bull" : "flat"}`;
    stateEl.textContent = cloudSession.loggedIn
      ? cloudReady
        ? tx(`云端接管 ${cloudCount} 条`, `Cloud takes over ${cloudCount} rule(s)`)
        : tx("云端待配置 Key", "Cloud key not set")
      : ready
        ? tx("本机推送已就绪", "Local push ready")
        : tx("未填本机 Key", "No local key set");
    description.textContent = cloudSession.loggedIn
      ? tx("已登录：当前 SendKey 会加密保存到云端；云端规则会在网页关闭后继续监测并推送。", "Signed in: the SendKey is saved encrypted to the cloud; cloud rules keep monitoring after the page closes.")
      : tx("未登录时，SendKey 与规则只保存在本机浏览器；登录后可保存到云端。", "Signed out: the SendKey and rules stay in this browser; sign in to save them to the cloud.");
    saveKeyButton.textContent = cloudSession.loggedIn
      ? tx("保存到云端", "Save to cloud")
      : tx("仅保存到本机", "Save locally only");
    testButton.textContent = cloudSession.loggedIn
      ? tx("测试云端推送", "Test cloud push")
      : tx("测试当前市价", "Test current price");
    clearKeyButton.textContent = cloudSession.loggedIn
      ? tx("清空输入", "Clear input")
      : tx("清除本机 Key", "Clear local Key");
    const summary = cloudCount
      ? `<p><b>${tx(`云端已接管 ${cloudCount} 条规则`, `Cloud takes over ${cloudCount} rule(s)`)}</b>：${tx("由服务器后台持续监测，网页关闭后仍会推送。", "Monitored by the server in the background and pushed even after the page closes.")}${localCount ? tx(`其余 ${localCount} 条为本地触发，页面关闭后停止。`, `The other ${localCount} are local-triggered and stop when the page closes.`) : tx("当前没有本地触发规则。", "No local-triggered rules now.")}</p>`
      : `<p>${tx("当前浏览器独立保存；页面保持打开时才会监测。", "Saved independently in this browser; only monitored while the page stays open.")}</p>`;
    list.innerHTML = `${summary}<div class="notification-rule-list">${
      rules.length
        ? rules
            .map((r) => {
              const cloudManaged = Boolean(r.cloudManaged),
                triggered =
                  !cloudManaged && r.repeat === false && r.lastTriggeredAt;
              return `<article class="${cloudManaged ? "cloud-managed-rule" : ""}"><span><b>→ BTC-USDT ${tx("价格预警", "price alert")}</b><small>${label(r.kind)} ${fmt(r.targetPrice)} · ${r.repeat === false ? tx("仅提醒一次", "Once only") : tx(`重复提醒 · ${r.cooldownMinutes} 分钟冷却`, `Repeat · ${r.cooldownMinutes} min cooldown`)}</small>${triggered ? `<small class="notification-triggered">${tx("已触发执行：", "Triggered: ")}${triggerText(r)}</small>` : ""}</span><em class="${cloudManaged ? "cloud-managed" : triggered ? "flat" : "bull"}">${cloudManaged ? tx("云端接管", "Cloud-managed") : triggered ? tx("已执行", "Executed") : tx("本地触发", "Local")}</em><button type="button" data-remove-local-alert="${r.id}">${tx("删除", "Delete")}</button></article>`;
            })
            .join("")
        : `<small>${tx("尚未添加预警。", "No alerts added yet.")}</small>`
    }</div>`;
    list.querySelectorAll("[data-remove-local-alert]").forEach(
      (b) =>
        (b.onclick = () => {
          rules = rules.filter((r) => r.id !== b.dataset.removeLocalAlert);
          save();
          render();
        }),
    );
  };
  const alertShort = (kind, target) =>
    ({
      price_reached: `BTC 达到 ${target} USDT`,
      price_above: `BTC 上涨至 ${target} USDT`,
      price_below: `BTC 下跌至 ${target} USDT`,
      long_liquidation: `多头爆仓价 ${target} USDT`,
      short_liquidation: `空头爆仓价 ${target} USDT`,
    })[kind] || `BTC ${target} USDT`;
  const push = async (current, rule = null) => {
    const key = (sessionStorage.getItem(keyStore) || "").trim();
    if (!/^SCT/i.test(key)) throw new Error("请先保存有效的本机 SendKey。");
    const currentText = fmt(current),
      targetText = rule ? fmt(rule.targetPrice) : currentText,
      phrase = rule
        ? alertPhrase(rule.kind, targetText)
        : `BTC当前价格 ${currentText}`,
      title = rule
        ? alertTitle(rule.kind, targetText)
        : `价格告警【测试】 ${phrase}`,
      short = rule
        ? alertShort(rule.kind, targetText)
        : `BTC 当前价格 ${currentText} USDT`,
      body = new URLSearchParams({
        title,
        short,
        desp: rule
          ? `${title}\n\n${phrase} USDT\n触发时市价 ${currentText} USDT`
          : `${title}\n\n${phrase} USDT`,
      });
    try {
      await fetch(`https://sctapi.ftqq.com/${encodeURIComponent(key)}.send`, {
        method: "POST",
        mode: "no-cors",
        body,
        keepalive: true,
      });
    } catch {
      navigator.sendBeacon?.(
        `https://sctapi.ftqq.com/${encodeURIComponent(key)}.send`,
        body,
      );
    }
  };
  const pushRuleTest = async (current, rule) => {
    const key = (sessionStorage.getItem(keyStore) || "").trim();
    if (!/^SCT/i.test(key)) throw new Error("请先保存有效的本机 SendKey。");
    const targetText = fmt(rule.targetPrice),
      currentText = fmt(current),
      phrase = alertPhrase(rule.kind, targetText),
      title = alertTitle(rule.kind, targetText, { test: true }),
      body = new URLSearchParams({
        title,
        short: alertShort(rule.kind, targetText),
        desp: `${title}\n\n${phrase} USDT\n当前市价 ${currentText} USDT\n\n该规则不会被保存。`,
      });
    try {
      await fetch(`https://sctapi.ftqq.com/${encodeURIComponent(key)}.send`, {
        method: "POST",
        mode: "no-cors",
        body,
        keepalive: true,
      });
    } catch {
      navigator.sendBeacon?.(
        `https://sctapi.ftqq.com/${encodeURIComponent(key)}.send`,
        body,
      );
    }
  };
  const matched = (r, from, to) => {
    if (r.kind === "price_reached")
      return (from - r.targetPrice) * (to - r.targetPrice) <= 0 && from !== to;
    const up = r.kind === "price_above" || r.kind === "short_liquidation";
    return up
      ? from < r.targetPrice && to >= r.targetPrice
      : from > r.targetPrice && to <= r.targetPrice;
  };
  const syncMarkPrice = () => {
    const mark = $("useLocalMark"),
      current = price();
    if (mark) mark.textContent = Number.isFinite(current) ? fmt(current) : "--";
  };
  setInterval(() => {
    syncMarkPrice();
    const current = price();
    if (!Number.isFinite(current)) return;
    if (previous === null) {
      previous = current;
      return;
    }
    const now = Date.now();
    for (const r of rules) {
      if (r.cloudManaged || (r.repeat === false && r.lastTriggeredAt)) continue;
      const gap =
        r.repeat === false
          ? 0
          : Math.max(1, Number(r.cooldownMinutes) || 1) * 60_000;
      if (
        matched(r, previous, current) &&
        (!gap || !r.lastTriggeredAt || now - r.lastTriggeredAt >= gap)
      ) {
        r.lastTriggeredAt = now;
        r.lastTriggeredPrice = current;
        save();
        render();
        if (r.voiceEnabled)
          window.dispatchEvent(
            new CustomEvent("btc:voice-alert", {
              detail: { rule: r, price: current },
            }),
          );
        push(current, r).catch(() => {});
      }
    }
    previous = current;
  }, 1_000);
  keyForm.onsubmit = async (e) => {
    e.preventDefault();
    const key = keyInput.value.trim();
    if (!/^SCT/i.test(key)) {
      alert("请输入以 SCT 开头的 Server酱 Turbo SendKey。");
      return;
    }
    try {
      if (cloudSession.loggedIn) {
        const response = await fetch("/api/alerts/credentials", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sendKey: key }),
        });
        if (!response.ok)
          throw new Error(
            (await response.json().catch(() => ({}))).error || "云端保存失败",
          );
        sessionStorage.setItem(keyStore, key);
        save();
        window.dispatchEvent(new Event("btc:cloud-refresh"));
        showAppDialog({
          title: "云端推送",
          message: "SendKey 已加密保存到云端。",
        });
      } else {
        sessionStorage.setItem(keyStore, key);
        save();
        render();
      }
    } catch (error) {
      showAppDialog({ title: "消息推送", message: error.message });
    }
  };
  clearKeyButton.onclick = () => {
    if (cloudSession.loggedIn) {
      keyInput.value = "";
      return;
    }
    sessionStorage.removeItem(keyStore);
    save();
    keyInput.value = "";
    render();
  };
  $("clearLocalAlerts").onclick = () => {
    if (!rules.length) return;
    showAppDialog({
      title: "确认批量删除",
      message: "确定删除全部本机预警规则吗？",
      confirmText: "全部删除",
      cancelText: "取消",
      onConfirm: () => {
        rules = [];
        save();
        render();
      },
    });
  };
  testButton.onclick = async () => {
    const current = price();
    if (!Number.isFinite(current)) {
      alert("实时价格尚未加载，请稍后重试。");
      return;
    }
    try {
      if (cloudSession.loggedIn) {
        const response = await fetch("/api/alerts/test", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ price: current }),
        });
        if (!response.ok)
          throw new Error(
            (await response.json().catch(() => ({}))).error || "云端测试失败",
          );
        showAppDialog({
          title: "云端测试已发送",
          message: "测试推送已由服务器提交到 Server酱，请查看微信。",
        });
      } else {
        await push(current);
        showAppDialog({
          title: "本机测试已发送",
          message: "测试推送请求已由当前浏览器发出，请查看微信。",
        });
      }
    } catch (error) {
      showAppDialog({ title: "消息推送", message: error.message });
    }
  };
  $("localRuleTest").onclick = async () => {
    const target = Number(form.elements.target.value),
      current = price();
    if (!Number.isFinite(target) || target <= 0) {
      alert("请先填写有效的规则价格。");
      return;
    }
    if (!Number.isFinite(current)) {
      alert("实时价格尚未加载，请稍后重试。");
      return;
    }
    try {
      await pushRuleTest(current, {
        kind: form.elements.kind.value,
        targetPrice: target,
      });
      showRuleNotice(true);
    } catch (error) {
      alert(error.message);
    }
  };
  const show = (open) => {
    modal.hidden = !open;
    if (open) {
      repeat = false;
      form
        .querySelectorAll("[data-local-frequency]")
        .forEach((button) =>
          button.classList.toggle(
            "active",
            button.dataset.localFrequency === "once",
          ),
        );
      $("localCooldown").hidden = true;
      syncMarkPrice();
    }
  };
  $("openLocalAlert").onclick = () => show(true);
  $("closeLocalAlert").onclick = () => show(false);
  $("useLocalMark").onclick = () => {
    const current = price();
    if (Number.isFinite(current))
      form.elements.target.value = current.toFixed(2);
  };
  form.querySelectorAll("[data-local-frequency]").forEach(
    (b) =>
      (b.onclick = () => {
        repeat = b.dataset.localFrequency === "repeat";
        form
          .querySelectorAll("[data-local-frequency]")
          .forEach((x) => x.classList.toggle("active", x === b));
        $("localCooldown").hidden = !repeat;
      }),
  );
  form.onsubmit = (e) => {
    e.preventDefault();
    const target = Number(form.elements.target.value),
      cooldown = Math.max(1, Number(form.elements.cooldown.value) || 1);
    if (!Number.isFinite(target) || target <= 0) return;
    rules.push({
      id: crypto.randomUUID(),
      kind: form.elements.kind.value,
      targetPrice: target,
      repeat,
      cooldownMinutes: cooldown,
      voiceEnabled: form.elements.voiceEnabled.checked,
      lastTriggeredAt: null,
    });
    save();
    form.reset();
    repeat = false;
    $("localCooldown").hidden = true;
    form.querySelector('[data-local-frequency="once"]').click();
    show(false);
    render();
  };
  window.addEventListener("btc:cloud-rules-synced", () => { window.btcSecureVault?.get('alerts').then(saved=>{if(Array.isArray(saved?.rules))rules=saved.rules;render()}).catch(()=>render()); });
  window.addEventListener("btc:account-state", (event) => {
    cloudSession = {
      loggedIn: Boolean(event.detail?.loggedIn),
      hasSendKey: Boolean(event.detail?.hasSendKey),
    };
    render();
  });
  render();
  window.btcSecureVault?.get('alerts').then(saved=>{if(Array.isArray(saved?.rules))rules=saved.rules;if(/^SCT/i.test(String(saved?.sendKey||'')))sessionStorage.setItem(keyStore,saved.sendKey);if(!saved&&(legacyAlertState||/^SCT/i.test(legacySendKey)))save();render()}).catch(error=>console.warn('Local encrypted restore failed:',error.message));
}, 0);

/* Browser speech uses the device's native voice and stays entirely local. */
setTimeout(() => {
  const priceCard = $("price")?.parentElement;
  if (!priceCard) return;
  const store = "btc_voice_quote_settings_v1";
  let settings = {
    enabled: false,
    livePriceEnabled: false,
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
  const say = (text, { force = false, chimeType, onStarted, onEnded, onFailure } = {}) => {
    if (!settings.enabled && !force) return false;
    // Edge TTS does not depend on the browser's system speech API.  Some
    // embedded browsers omit speechSynthesis entirely, so only touch it when
    // it exists; otherwise the exception prevented the Edge request as well.
    const sequence = ++speechSequence;
    if (supported) window.speechSynthesis.cancel();
    currentAudio?.pause();
    const started = () => {
        if (sequence !== speechSequence) return;
        setSpeaking(true);
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
  const trigger = document.createElement("button");
  trigger.id = "voiceQuickToggle";
  trigger.type = "button";
  trigger.className = "voice-quick-toggle";
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.setAttribute("aria-expanded", "false");
  trigger.innerHTML = `<span class="voice-pulse voice-pulse-one" aria-hidden="true"></span><span class="voice-pulse voice-pulse-two" aria-hidden="true"></span><svg viewBox="0 0 64 64" aria-hidden="true"><path d="M8 25h13l18-14v42L21 39H8z"/><path class="voice-wave" d="M46 23c5 5 5 13 0 18M52 16c10 10 10 22 0 32"/><line class="voice-mute" x1="9" y1="10" x2="55" y2="54"/></svg><span class="voice-quick-toggle-label" aria-hidden="true"></span>`;
  priceCard.append(trigger);
  setSpeaking = (playing) => {
    isSpeaking = Boolean(playing);
    trigger.classList.toggle("is-speaking", isSpeaking);
    trigger.classList.toggle("is-muted", !settings.enabled);
    trigger.disabled = !voicePlaybackAvailable;
    const label = !voicePlaybackAvailable
      ? tx("当前环境不支持语音播报", "Voice broadcast is unavailable")
      : isSpeaking
        ? tx("语音播报设置（正在播报）", "Voice settings (speaking)")
        : tx("打开语音播报设置", "Open voice settings");
    trigger.setAttribute("aria-label", label);
    trigger.title = label;
    trigger.querySelector(".voice-quick-toggle-label").textContent = isSpeaking
      ? tx("播报中", "Speaking")
      : "";
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
  panel.innerHTML = `<div class="voice-panel-head"><div><b>${tx("语音播报", "Voice alerts")}</b><small id="voiceAlertStatus"></small></div></div><div class="voice-panel-grid"><section class="voice-panel-group voice-panel-toggles"><label class="voice-switch"><input id="voiceAlertEnabled" type="checkbox"><span>${tx("语音总开关", "Voice master")}</span></label><label class="voice-switch"><input id="voiceLivePriceEnabled" type="checkbox"><span>${tx("定时播报实时价", "Speak live price")}</span></label><label class="voice-live-interval">${tx("播报间隔", "Interval")}<select id="voiceAlertInterval"><option value="15">15 ${tx("秒", "sec")}</option><option value="30">30 ${tx("秒", "sec")}</option><option value="60">1 ${tx("分钟", "min")}</option><option value="300">5 ${tx("分钟", "min")}</option></select><small id="voiceLastSpokenAt" class="voice-last-spoken"></small></label></section><section class="voice-panel-group"><label>${tx("播报引擎", "Engine")}<select id="voiceAlertEngine"><option value="edge">${tx("Edge 神经语音（免费）", "Edge neural (free)")}</option><option value="system">${tx("本机系统语音", "System voice")}</option></select></label><label>${tx("音色", "Voice")}<select id="voiceAlertEdgeVoice"><optgroup label="${tx("自然女声", "Female (natural)")}"><option value="zh-CN-XiaoxiaoNeural">${tx("小晓 · 普通话", "Xiaoxiao · Mandarin")}</option><option value="zh-CN-XiaoyiNeural">${tx("小艺 · 普通话", "Xiaoyi · Mandarin")}</option><option value="zh-CN-liaoning-XiaobeiNeural">${tx("小北 · 辽宁口音", "Xiaobei · Liaoning")}</option><option value="zh-CN-shaanxi-XiaoniNeural">${tx("小妮 · 陕西口音", "Xiaoni · Shaanxi")}</option><option value="zh-TW-HsiaoChenNeural">${tx("晓臻 · 台湾国语", "HsiaoChen · Taiwanese")}</option><option value="zh-HK-HiuGaaiNeural">${tx("晓佳 · 粤语", "HiuGaai · Cantonese")}</option></optgroup><optgroup label="${tx("自然男声", "Male (natural)")}"><option value="zh-CN-YunxiNeural">${tx("云希 · 普通话", "Yunxi · Mandarin")}</option><option value="zh-CN-YunyangNeural">${tx("云扬 · 普通话", "Yunyang · Mandarin")}</option></optgroup></select></label><label class="system-voice-label">${tx("系统回退", "System fallback")}<select id="voiceAlertVoice"><option>${tx("正在加载系统语音…", "Loading system voices…")}</option></select></label><label>${tx("提示音音量", "Chime volume")}<span class="voice-volume-row"><input id="voiceChimeVolume" type="range" min="0" max="200" step="1"><output id="voiceChimeVolumeValue"></output></span></label><label>${tx("语音音量", "Speech volume")}<span class="voice-volume-row"><input id="voiceSpeechVolume" type="range" min="0" max="100" step="1"><output id="voiceSpeechVolumeValue"></output></span></label></section><section class="voice-panel-group voice-panel-actions"><button type="button" id="voiceAlertAddRule">＋ ${tx("配置语音规则", "Voice rules")}</button><button type="button" id="voiceAlertTest">${tx("试听", "Test voice")}</button></section></div><small class="voice-rule-note">${tx("语音规则支持价格达到、上涨、下跌及爆仓价；在“添加预警”中勾选“触发时语音播报”。", "Voice rules support reached, rise, fall and liquidation prices; enable Speak when triggered in Add alert.")}</small>`;
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
    panel.classList.toggle("uses-edge", settings.engine === "edge");
    const selected = voices.find(
        (voice) => voice.voiceURI === settings.voiceURI,
      ),
      name =
        settings.engine === "edge"
          ? edgeVoice.options[edgeVoice.selectedIndex]?.text
          : selected?.name || tx("系统语音", "system voice");
    status.textContent = settings.enabled
      ? `${tx("已开启：", "On: ")}${name}${settings.livePriceEnabled ? ` · ${tx("定时价位播报", "Live price on")}` : ""}`
      : tx("已静音", "Muted");
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
      if (
        enqueueSpeech(
          priceText(current),
          { chimeType },
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
    const wasEnabled = settings.enabled;
    settings.enabled = true;
    say(priceText(current), {
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
  const voiceRuleStore = "btc_voice_alert_rules_v1";
  let voiceRules = [],
    voicePrevious = null,
    voicePriceHistory = [],
    voiceRuleEditingId = null;
  try {
    const stored = JSON.parse(localStorage.getItem(voiceRuleStore) || "[]");
    if (Array.isArray(stored))
      voiceRules = stored
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
  } catch {}
  const saveVoiceRules = () => {
    localStorage.setItem(voiceRuleStore, JSON.stringify(voiceRules));
    /* 同步页面设置供状态恢复；服务端不执行关闭页面后的接力播报。 */
    syncVoiceToServer();
  };
  const syncVoiceToServer = () => {
    fetch("/api/voice/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
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
          localStorage.setItem(voiceRuleStore, JSON.stringify(voiceRules));
          renderVoiceRules();
        }
      })
      .catch(() => {});
  }, 10_000);
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
  const voiceMatched = (rule, from, to, now) => {
    const amount = Number(rule.targetPrice);
    if (rule.kind === "theoretical_liquidation_gap") {
      const liquidation = theoreticalLiquidation(
        rule.positionSide === "short" ? "short" : "long",
      );
      if (!Number.isFinite(liquidation)) return false;
      return rule.positionSide === "short"
        ? to >= liquidation - amount
        : to <= liquidation + amount;
    }
    if (rule.kind === "price_move") {
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
    }
    if (rule.kind === "price_speed") {
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
    }
    if (rule.kind === "price_tick_move") {
      const delta = to - from;
      return rule.direction === "both"
        ? Math.abs(delta) >= amount
        : rule.direction === "down"
          ? delta <= -amount
          : delta >= amount;
    }
    /* 价格越过类规则按“状态”而非“穿越瞬间”判定：创建规则时价格已在目标之外
       （例如现价已高于“上涨至 79865”的目标）也必须立即播报，否则规则会静默失效。 */
    if (rule.kind === "price_reached")
      return (
        from === rule.targetPrice ||
        to === rule.targetPrice ||
        (from - rule.targetPrice) * (to - rule.targetPrice) < 0
      );
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
  const voiceChimeFor = (rule, direction) => {
    if (
      rule.kind === "long_liquidation" ||
      rule.kind === "short_liquidation" ||
      rule.kind === "theoretical_liquidation_gap"
    )
      return settings.liquidationChimeType;
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
      message = uiLang === "zh"
        ? `${side === "short" ? "做空" : "做多"}理论强平价警告。理论强平价 ${Number.isFinite(liquidation) ? liquidation.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "暂不可用"}。当前价格 ${currentText}，距强平价 ${gap}。`
        : `${side === "short" ? "Short" : "Long"} theoretical liquidation warning. The theoretical liquidation price is ${Number.isFinite(liquidation) ? liquidation.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "unavailable"}. Current price is ${currentText}, ${gap} from liquidation.`;
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
  /* 规则真实触发时更新状态文字；播报按钮由实际播放开始／结束事件同步。 */
  const announceVoiceTrigger = (rule) => {
    const label =
      voiceRuleName(rule.kind, rule.direction, rule.positionSide) +
      " " +
      Number(rule.targetPrice).toLocaleString("en-US", {
        maximumFractionDigits: 2,
    });
    status.textContent = tx(`已播报：${label}`, `Spoke: ${label}`);
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
      onStarted: () => {
        status.textContent = tx("规则测试正在播放", "Rule test playing");
      },
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
    const triggeredBatch = [];
    if (settings.enabled)
      for (const rule of voiceRules) {
        if (!rule.repeat && rule.lastTriggeredAt) continue;
        const satisfied = voiceMatched(rule, voicePrevious, current, now);
        /* 状态类规则（上涨至／下跌至）在价格持续满足期间每秒都为真：
           只有“从不满足→满足”的边沿立即播报；持续满足期间重复规则按冷却重复，
           且冷却下限 30 秒，避免“重复播报 · 不冷却”每秒狂响。 */
        const cooldown = rule.repeat
          ? Math.max(
              30_000,
              Math.max(0, Number(rule.cooldownMinutes) || 0) * 60_000,
            )
          : 0;
        const freshEdge = !rule.satisfied;
        if (
          satisfied &&
          (freshEdge ||
            !rule.lastTriggeredAt ||
            now - rule.lastTriggeredAt >= cooldown)
        ) {
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
    });
  });
  if (supported) {
    window.speechSynthesis.addEventListener?.("voiceschanged", populateVoices);
    populateVoices();
    setTimeout(populateVoices, 350);
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
    document.querySelector(".correlation-card h2"),
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
    hi = Math.max(...s.map((v) => v.high)),
    lo = Math.min(...s.map((v) => v.low)),
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
   所以不能再沿用「扣掉副图高度」的旧公式，否则定位点会提前卡在半空。 */
const CHART_PAD = { l: 52, r: 74, t: 15, b: 8 },
  CHART_TIME_AXIS_H = 28;
function chartPlotGeom(rect) {
  const cw = rect.width - CHART_PAD.l - CHART_PAD.r,
    ch = rect.height - CHART_PAD.t - CHART_PAD.b;
  return { cw, ch, priceHeight: Math.max(80, ch - CHART_TIME_AXIS_H) };
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
  const marketLow = Math.min(...values),
    marketHigh = Math.max(...values),
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
  let lo = Math.min(...values),
    hi = Math.max(...values),
    margin = (hi - lo || 1) * 0.075;
  lo -= margin;
  hi += margin;
  const x = (i) => P.l + (i / Math.max(1, d.length - 1)) * cw,
    y = (v) => P.t + priceHeight - ((v - lo) / (hi - lo)) * priceHeight;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  c.font = "11px system-ui";
  c.lineWidth = 1;
  c.strokeStyle = "rgba(144,169,199,.14)";
  c.fillStyle = "#75849a";
  // Y 轴价格标签：右对齐到右侧留白边界内，避免长数字（如 80019.01）起点侵入图表绘制区
  // Right-align Y-axis labels inside the right padding so long price strings (e.g. 80019.01) don't bleed into the chart area.
  c.textAlign = "right";
  for (let g = 0; g < 5; g++) {
    const yy = P.t + (g * priceHeight) / 4;
    c.beginPath();
    c.moveTo(P.l, yy);
    c.lineTo(P.l + cw, yy);
    c.stroke();
    c.fillText((hi - ((hi - lo) * g) / 4).toFixed(2), w - 6, yy + 4);
  }
  c.textAlign = "start";
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
  entryLevelsWithPlacement.forEach((entry, index) => {
    const color = entry.side === "short" ? "#ff5b7b" : "#19d3b0",
      edgeOffset = Math.floor(index / 2) * 20,
      yy =
        entry.placement === "top"
          ? P.t + 9 + edgeOffset
          : entry.placement === "bottom"
            ? P.t + priceHeight - 9 - edgeOffset
            : y(entry.price),
      label = `${entry.side === "short" ? tx("做空买入价", "Short entry") : tx("做多买入价", "Long entry")} ${money(entry.price)}${entry.placement === "top" ? " ↑" : entry.placement === "bottom" ? " ↓" : ""}`;
    c.save();
    c.strokeStyle = color;
    c.lineWidth = 1.6;
    c.setLineDash([7, 5]);
    c.beginPath();
    c.moveTo(P.l, yy);
    c.lineTo(P.l + cw, yy);
    c.stroke();
    c.setLineDash([]);
    c.font = "700 10px ui-sans-serif,system-ui";
    c.textAlign = "left";
    const width = Math.min(c.measureText(label).width + 12, cw - 10),
      labelY =
        entry.placement === "top"
          ? Math.min(P.t + priceHeight - 20, yy + 5)
          : entry.placement === "bottom"
            ? Math.max(P.t + 3, yy - 20)
            : Math.max(P.t + 3, Math.min(P.t + priceHeight - 20, yy - (index ? 0 : 18)));
    c.fillStyle =
      entry.side === "short" ? "rgba(255,91,123,.18)" : "rgba(25,211,176,.18)";
    c.fillRect(P.l + 5, labelY, width, 17);
    c.fillStyle = color;
    c.fillText(label, P.l + 11, labelY + 12);
    c.restore();
  });
  /* 理论爆仓价线：做空=亮橙、做多=黄绿，均为其他线条未占用的警示色；
     左右只画到图表主体（P.l ~ P.l+cw），不超出；
     离图表数据很远时贴画布最上/最下边缘（第一条线紧贴边），带 ↑/↓ 箭头。 */
  liqLevelsWithPlacement.forEach((entry, index) => {
    const isShort = entry.side === "short",
      color = isShort ? "#ff9d2b" : "#c0eb2a",
      colorBg = isShort ? "rgba(255,157,43,.18)" : "rgba(192,235,42,.16)",
      yy =
        entry.placement === "top"
          ? 2 + index * 18
          : entry.placement === "bottom"
            ? h - 26 - index * 18
            : y(entry.price),
      label = `${isShort ? tx("做空爆仓价", "Short liquidation") : tx("做多爆仓价", "Long liquidation")} ${money(entry.price)}${entry.placement === "top" ? " ↑" : entry.placement === "bottom" ? " ↓" : ""}`;
    c.save();
    c.strokeStyle = color;
    c.lineWidth = 1.5;
    c.setLineDash([3, 3]);
    c.beginPath();
    c.moveTo(P.l, yy);
    c.lineTo(P.l + cw, yy);
    c.stroke();
    c.setLineDash([]);
    c.font = "700 10px ui-sans-serif,system-ui";
    c.textAlign = "left";
    const width = Math.min(c.measureText(label).width + 12, cw - 10),
      labelY =
        entry.placement === "top"
          ? Math.min(P.t + priceHeight - 20, yy + 5)
          : entry.placement === "bottom"
            ? Math.max(P.t + 3, yy - 20)
            : Math.max(P.t + 3, Math.min(P.t + priceHeight - 20, yy + 5));
    c.fillStyle = colorBg;
    c.fillRect(P.l + 5, labelY, width, 17);
    c.fillStyle = color;
    c.fillText(label, P.l + 11, labelY + 12);
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
    for (const [txt, col] of badges) {
      const tw = c.measureText(txt).width + 14;
      c.fillStyle = lightTheme ? "rgba(255,255,255,.82)" : "rgba(20,28,40,.78)";
      c.fillRect(P.l + cw - tw, by - 12, tw, 17);
      c.strokeStyle = col;
      c.lineWidth = 1;
      c.strokeRect(P.l + cw - tw, by - 12, tw, 17);
      c.fillStyle = lightTheme ? "#7a4a00" : col;
      c.fillText(txt, P.l + cw - 7, by);
      by += 21;
    }
    c.restore();
  }
  /* X 轴时间刻度：随可见 K 线范围、缩放与周期动态调整密度/格式。 */
  c.save();
  const spanMs = d[d.length - 1].time - d[0].time;
  const intervalMins = intervalMinutes[state.interval] || 1;
  const isLongTerm = intervalMins >= 240; // 4h+
  const showDate = isLongTerm || spanMs > 86_400_000;
  const showYear =
    showDate &&
    new Date(d[0].time).getFullYear() !== new Date(d[d.length - 1].time).getFullYear();
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
  c.textAlign = "center";
  c.textBaseline = "top";
  for (let i = 0; i < d.length; i += timeStep) {
    const xx = x(i);
    c.beginPath();
    c.moveTo(xx, axisY - 4);
    c.lineTo(xx, axisY);
    c.stroke();
    c.fillText(formatTimeAxisLabel(d[i].time, showDate, showYear), xx, axisY + 3);
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
  const P = { l: 52, r: 74, t: 8, b: 8 },
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
  /* RSI 曲线（在 RSI 区域绘制；聚焦时加粗发光，柱聚焦时略退后）。 */
  const closes = d.map((v) => v.close),
    rsiArr = rsi(closes, 14),
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
  const P = { l: 52, r: 74, t: 8, b: 8 };
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
loadDerivativeMarketContext(true);
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
    { cat: "market", name: "OKX", contract: "BTC-USDT-SWAP", run: marketCheck("okx", "OKX", "BTC-USDT-SWAP") },
    { cat: "market", name: "Coinbase", contract: "BTC-PERP", run: marketCheck("coinbase", "Coinbase", "BTC-PERP") },
    { cat: "market", name: "Gate", contract: "BTC_USDT", run: marketCheck("gate", "Gate", "BTC_USDT") },
    { cat: "market", name: "Binance", contract: "BTCUSDT", run: marketCheck("binance", "Binance", "BTCUSDT") },
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
              body: JSON.stringify({ text: "。", voice: "zh-CN-XiaoxiaoNeural" }),
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

/* “最高/最低选中价” means closing price in every display mode.  Keeping the
   marker and hover card on that same close point prevents the 500% mismatch. */
$("chart")?.addEventListener("mousemove", () => {
  const tip = $("chartTooltip"),
    d = visibleCandles();
  if (!tip || hoverIndex === null || d.length < 2) return;
  tip.querySelector(".range-extrema-tooltip-note")?.remove();
  const highIndex = d.reduce(
      (best, v, i) => (v.close > d[best].close ? i : best),
      0,
    ),
    lowIndex = d.reduce(
      (best, v, i) => (v.close < d[best].close ? i : best),
      0,
    ),
    kind =
      hoverIndex === highIndex
        ? "high"
        : hoverIndex === lowIndex
          ? "low"
          : null;
  if (!kind) return;
  const label =
    kind === "high"
      ? tx(
          "此为当前查看范围内最高收盘价",
          "Highest closing price in this range",
        )
      : tx(
          "此为当前查看范围内最低收盘价",
          "Lowest closing price in this range",
        );
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
  let min = Math.min(...values),
    max = Math.max(...values),
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
  version.textContent = "v2.10.18";
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
  const v2112Changelog = log.innerHTML;
  log.innerHTML = `<b>v2.10.13 更新日志</b><dl><dt>卡片更名并聚焦实时数据</dt><dd>「宏观与情绪」卡片标题改为「关注宏观事件实时数据」，右上角标签改为「实时数据」。</dd><dt>移除恐惧贪婪指数</dt><dd>该卡片不再显示恐惧贪婪指数，整块区域只保留「关注事件 · 实时数据」。</dd><dt>关注事件放大展示</dt><dd>「关注事件 · 实时数据」区块现在占满整张卡片，内部事件标题、倒计时、预期/前值/实际与阈值解读的字号、间距同步放大，阅读更醒目。</dd></dl><hr>` + v2112Changelog;
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
    localStorage.setItem(
      "btc_chart_display",
      JSON.stringify({ ...state.chartSeries, ...state.chartLines }),
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
  panel.innerHTML = `<div class="control-popover chart-picker"><button class="control-trigger" type="button" aria-haspopup="true" aria-expanded="false"><span class="control-label">${tx("图表", "Chart")}</span><b data-current-chart></b><i aria-hidden="true">▾</i></button><div class="control-popover-panel chart-display-options"><div class="chart-series-options"><button type="button" data-series="candles">${tx("K线图", "Candlestick")}</button><button type="button" data-series="close">${tx("价格线", "Price line")}</button></div><div class="chart-line-toggles"><button type="button" data-line="ma20">MA20</button><button type="button" data-line="ma50">MA50</button><button type="button" data-line="ma200">MA200</button><button type="button" data-line="boll">${tx("布林带", "Bollinger")}</button><button type="button" data-line="vwap">VWAP</button></div></div></div>`;
  const popover = panel.querySelector(".control-popover"),
    trigger = panel.querySelector(".control-trigger");
  trigger.addEventListener("click", () => {
    const open = popover.classList.toggle("is-open");
    trigger.setAttribute("aria-expanded", String(open));
  });
  popover.addEventListener("mouseleave", () => {
    popover.classList.remove("is-open");
    trigger.setAttribute("aria-expanded", "false");
  });
  panel.addEventListener("click", (event) => {
    const series = event.target.dataset.series,
      line = event.target.dataset.line;
    if (series) state.chartSeries[series] = !state.chartSeries[series];
    if (line) state.chartLines[line] = !state.chartLines[line];
    if (series || line) sync();
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
loadCorrelation = async function () {
  const status = $("correlationStatus"),
    out = $("correlationOutput");
  if (!out) return;
  status.textContent = tx(
    "正在对齐 BTC、SPY、QQQ 的共同交易日并训练…",
    "Aligning BTC, SPY and QQQ trading days and training…",
  );
  try {
    const r = await fetch("/api/correlation-history"),
      d = await r.json();
    if (!r.ok) throw new Error(d.error || "request failed");
    const quoteCard = (name, ticker, q) => {
      const delta = q.last - q.previous,
        up = delta >= 0;
      return `<article class="index-card ${up ? "up" : "down"}"><span>${name} · ${ticker}</span><b>${q.last.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b><div><em>${up ? "+" : "−"}${Math.abs(delta).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</em><em>${up ? "+" : "−"}${((Math.abs(delta) / q.previous) * 100).toFixed(2)}%</em></div><small>${tx("最近收盘", "Last close")}</small></article>`;
    };
    const cards = $("indexTickerCards");
    if (cards)
      cards.innerHTML =
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
    out.innerHTML = `<div class="corr-stat"><span>BTC × SPY (${tx("60日", "60d")})</span><b class="${corrSPY >= 0 ? "bull" : "bear"}">${corrSPY >= 0 ? "+" : ""}${corrSPY.toFixed(2)}</b><small>${correlationLabel(corrSPY)}</small></div><div class="corr-stat"><span>BTC × QQQ (${tx("60日", "60d")})</span><b class="${corrQQQ >= 0 ? "bull" : "bear"}">${corrQQQ >= 0 ? "+" : ""}${corrQQQ.toFixed(2)}</b><small>${correlationLabel(corrQQQ)}</small></div><div class="corr-stat wide"><span>${tx("跨市场模型：下一交易日 BTC 看多概率", "Cross-market model: next-session BTC bullish probability")}</span><b class="${p >= 50 ? "bull" : "bear"}">${p === null ? "--" : p.toFixed(2) + "%"}</b><small>${fit ? tx(`SPY、QQQ 与 BTC 当日收益特征 · 样本外准确率 ${(fit.accuracy * 100).toFixed(2)}% · 训练 n=${fit.n}`, `SPY, QQQ and BTC same-day return features · out-of-sample accuracy ${(fit.accuracy * 100).toFixed(2)}% · training n=${fit.n}`) : tx("共同交易日不足", "Not enough shared trading days")}</small></div>`;
    status.textContent = tx(
      `数据已按共同交易日对齐 · ${d.cached ? "缓存数据" : "刚更新"} · 相关性会随窗口变化，不能单独作为开仓信号。`,
      `Data aligned to shared trading days · ${d.cached ? "cached" : "updated"} · correlations vary by window and are not stand-alone entry signals.`,
    );
  } catch (e) {
    status.textContent = `${tx("美股联动模块暂不可用", "US equities linkage module unavailable")}：${e.message}`;
  }
};

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
    /^(尚未计算|Not calculated yet)$/.test(resonanceText.textContent.trim())
  )
    text(resonanceText, "尚未计算", "Not calculated yet");
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
  const highIndex = d.reduce(
      (best, v, i) => (v.close > d[best].close ? i : best),
      0,
    ),
    lowIndex = d.reduce(
      (best, v, i) => (v.close < d[best].close ? i : best),
      0,
    ),
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
      ? tx(
          "此为当前查看范围内最高选中价",
          "Highest selected price in this range",
        )
      : tx(
          "此为当前查看范围内最低选中价",
          "Lowest selected price in this range",
        );
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

/* The price path represents candle closes.  Range extrema must use that same
   selectable price, rather than the intrabar high/low that may never touch
   the plotted line. */
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
  const hiI = d.reduce((best, v, i) => (v.close > d[best].close ? i : best), 0),
    loI = d.reduce((best, v, i) => (v.close < d[best].close ? i : best), 0),
    rect = cv.getBoundingClientRect(),
    P = { l: 52, r: 74, t: 15, b: 30 },
    cw = rect.width - P.l - P.r,
    ch = rect.height - P.t - P.b,
    volumeHeight = Math.min(118, Math.max(96, Math.round(ch * 0.21))),
    priceHeight = ch - volumeHeight - 30,
    closes = d.map((v) => v.close),
    all = [...closes];
  [ema(closes, 20), ema(closes, 50), ema(closes, 200)].forEach((a) =>
    a.forEach((v) => {
      if (Number.isFinite(v)) all.push(v);
    }),
  );
  let loValue = Math.min(...all),
    hiValue = Math.max(...all),
    margin = (hiValue - loValue || 1) * 0.075;
  loValue -= margin;
  hiValue += margin;
  const x = (i) => P.l + (i / (d.length - 1)) * cw,
    y = (v) => P.t + priceHeight - ((v - loValue) / (hiValue - loValue)) * priceHeight,
    label = txInterval(state.range || state.interval),
    place = (el, i, kind) => {
      const value = d[i].close;
      el.style.left = `${Math.max(8, Math.min(rect.width - 214, x(i)))}px`;
      el.style.top = `${Math.max(6, Math.min(P.t + priceHeight - 20, y(value) + (kind === "high" ? -20 : 6)))}px`;
      el.textContent = `${label}${kind === "high" ? tx("最高选中价", " highest selected price") : tx("最低选中价", " lowest selected price")} ${money(value)} · ${pointTime(d[i].time)}`;
    };
  place(high, hiI, "high");
  place(low, loI, "low");
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
    all = [...closes];
  [ma20, ma50, ma200].forEach((a) =>
    a.forEach((v) => {
      if (Number.isFinite(v)) all.push(v);
    }),
  );
  let lo = Math.min(...all),
    hi = Math.max(...all),
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
  const hiI = d.reduce((best, v, i) => (v.close > d[best].close ? i : best), 0),
    loI = d.reduce((best, v, i) => (v.close < d[best].close ? i : best), 0),
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
    d[hiI].close,
    tx("最高选中价", "Highest selected price"),
    "#ffcb65",
    true,
  );
  mark(
    loI,
    d[loI].close,
    tx("最低选中价", "Lowest selected price"),
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
          ? Math.min(...d.slice(i, i + window).map((x) => x.low))
          : Math.max(...d.slice(i, i + window).map((x) => x.high)),
      adverse =
        side > 0 ? (start - extreme) / start : (extreme - start) / start;
    hits += adverse >= Math.abs(liq - start) / start ? 1 : 0;
    total++;
  }
  const nearby =
      side > 0
        ? Math.min(...d.slice(-Math.min(60, d.length)).map((x) => x.low))
        : Math.max(...d.slice(-Math.min(60, d.length)).map((x) => x.high)),
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
  out.innerHTML = `<div><small>${tx("理论强平价", "Theoretical liquidation")}</small><b class="bear">${money(liq)}</b></div><div><small>${tx("实际杠杆 / BTC 数量", "Effective leverage / BTC size")}</small><b>${lev.toFixed(2)}× / ${btc.toFixed(6)} BTC</b></div><div><small>${extremeLabel}</small><b class="${side > 0 ? "low" : "high"}">${money(nearby)}</b></div><div><small>${gapLabel}</small><b class="${gap >= 0 ? "bull" : "bear"}">${gap >= 0 ? "+" : "−"}${money(Math.abs(gap))}</b></div><div><small>${tx("历史触及概率", "Historical touch probability")}</small><b class="${level}">${probability.toFixed(2)}%</b></div><div><small>${tx("手续费参考（开+平）", "Fee reference (in + out)")}</small><b>${money(amount * fee * 2)}</b></div><p class="${level}">${tx("以当前价", "Using live price")} ${money(live)} · ${tx("以最近", "Using")} ${total} ${tx("个", "")} ${window}${tx(" 根 K 线窗口，比较每段局部最低/最高价与同一仓位的强平距离；仅作风险研究，不代表真实强平或未来概率。", "-candle windows: compares each local low/high with this position’s liquidation distance. Research only; not actual liquidation or future probability.")}</p>`;
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
  "1时": { minutes: 60 },
  "3时": { minutes: 180 },
  "6时": { minutes: 360 },
  "12时": { minutes: 720 },
  "1D": { minutes: 1440 },
  "2D": { minutes: 2880 },
  "1W": { minutes: 10080 },
  "1M": { minutes: 43200 },
  "6M": { minutes: 262800 },
  "1Y": { minutes: 525600 },
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
    .querySelector(".control-trigger")
    ?.setAttribute("aria-expanded", "false");
  if (popover.classList.contains("range-picker"))
    popover.querySelector(".control-popover-panel")?.remove();
}
const dismissChartPopoverOnPointerExit = (event) => {
  document
    .querySelectorAll("#mainChartCard .toolbar .control-popover.is-open")
    .forEach((popover) => {
      if (!popover.contains(event.target)) closeChartControlPopover(popover);
    });
};
document.addEventListener("pointermove", dismissChartPopoverOnPointerExit, true);
document.addEventListener("pointerover", dismissChartPopoverOnPointerExit, true);
document.addEventListener("pointerover", (event) => {
  const popover = event.target.closest?.(
    "#mainChartCard .toolbar .control-popover.is-open",
  );
  if (popover && !popover.contains(event.relatedTarget))
    closeChartControlPopover(popover);
}, true);
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
function applyVisibleRange(label) {
  const minutes = viewRanges[label]?.minutes;
  if (!minutes) return state.interval;
  /* 视图一次最多取 MAX_VISIBLE_CANDLES 根 K 线。
     范围与周期冲突时，以「查看范围」为准微调 K 线周期，保证刻度真的覆盖所选跨度：
       ① 周期过细、装不下（「1 分 × 1W」= 10080 根）：放粗到仍能装下整个范围的最细周期，
          否则刻度只会停在最近 30 小时，与「查看范围」标签不符；
       ② 周期过粗、装不满（「1 日 × 6时」= 1 根，K 线图无法阅读）：换到约 360 根的周期，
          否则从「1Y」切回短范围时会留下一根柱子代表一整段。
     只要不冲突就不动周期（例如默认的「1 分 × 6时」= 360 根保持原样）。 */
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
    const intervalPopover = intervalBox.querySelector(".control-popover");
    intervalPopover?.querySelector(".control-trigger")?.addEventListener("click", () =>
      intervalPopover.classList.toggle("is-open"),
    );
    intervalPopover?.addEventListener("mouseleave", () =>
      intervalPopover.classList.remove("is-open"),
    );
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
            applyVisibleRange(state.range);
          } else {
            state.limit = Math.max(300, state.limit || 300);
          }
          buttonsSignature = "";
          intervalPopover?.classList.remove("is-open");
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
      `<div class="control-popover range-picker"><button class="control-trigger" type="button" aria-haspopup="listbox" aria-expanded="false" aria-controls="rangePopoverOptions"><span class="control-label">${tx("查看范围", "Visible range")}</span><b data-current-range></b><i aria-hidden="true">▾</i></button></div>`;
    const rangePopover = rangeBox.querySelector(".control-popover");
    const rangeTrigger = rangePopover.querySelector(".control-trigger");
    const closeRangePopover = () => closeChartControlPopover(rangePopover);
    const openRangePopover = () => {
      if (rangePopover.classList.contains("is-open")) return closeRangePopover();
      const list = document.createElement("div");
      list.id = "rangePopoverOptions";
      list.className = "control-popover-panel range-options";
      list.setAttribute("role", "listbox");
      list.setAttribute("aria-label", tx("查看范围", "Visible range"));
      list.innerHTML = Object.keys(viewRanges)
        .map(
          (label) =>
            `<button type="button" data-view="${label}" role="option" aria-selected="${state.range === label}">${viewText(label)}</button>`,
        )
        .join("");
      rangePopover.append(list);
      list.querySelectorAll("[data-view]").forEach((chip) =>
        chip.classList.toggle("active", state.range === chip.dataset.view),
      );
      rangePopover.classList.add("is-open");
      rangeTrigger.setAttribute("aria-expanded", "true");
      requestAnimationFrame(() => list.classList.add("is-visible"));
    };
    rangeTrigger.addEventListener("click", openRangePopover);
    rangePopover.addEventListener("mouseleave", closeRangePopover);
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
let positionState = JSON.parse(
  localStorage.getItem("btc_position_state") ||
    '{"side":"long","exchange":"binance","amount":1000,"margin":100,"entry":0,"mark":0}',
);
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
      lo = Math.min(...d.map((v) => v.low)),
      hi = Math.max(...d.map((v) => v.high)),
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
    localStorage.setItem("btc_position_state", JSON.stringify(positionState));
    renderPosition();
  };
  $("syncMark").onclick = () => {
    positionState.mark = state.ticker?.last || 0;
    if (!positionState.entry) positionState.entry = positionState.mark;
    localStorage.setItem("btc_position_state", JSON.stringify(positionState));
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
loadExchangeStrip();

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
  confirm.onclick = () => {
    const entry = +form.elements.entry.value;
    if (!Number.isFinite(entry) || entry <= 0) {
      form.elements.entry.focus();
      return;
    }
    positionState.confirmed = true;
    localStorage.setItem("btc_position_state", JSON.stringify(positionState));
    renderPosition();
  };
  form.addEventListener("input", () => {
    positionState.confirmed = false;
    localStorage.setItem("btc_position_state", JSON.stringify(positionState));
    const marker = $("entryMarker");
    if (marker) marker.hidden = true;
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
          ? Math.min(...segment.map((candle) => candle.low))
          : Math.max(...segment.map((candle) => candle.high)),
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
        ? Math.min(...history.map((candle) => candle.low))
        : Math.max(...history.map((candle) => candle.high))
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
  const labelHtml = (value, side, kind, label) =>
      `<div class="signal-validity-label ${side} ${kind}"><small>${money(value)}</small><em>${label}</em></div>`,
    redeemLabel = labelHtml(redeem, redeemSide, "redeem", tx("兑现", "Redeem")),
    invalidLabel = labelHtml(invalid, invalidSide, "invalid", tx("作废", "Invalid")),
    leftLabel = redeemSide === "left" ? redeemLabel : invalidLabel,
    rightLabel = redeemSide === "right" ? redeemLabel : invalidLabel;
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
    box.innerHTML = `<div class="signal-validity-head"><b>${tx("信号有效区间", "Signal validity range")}</b><span>${valid ? tx("信号有效", "Signal active") : tx("信号已作废", "Signal invalid")}</span></div><div class="signal-validity-scale">${leftLabel}<div class="signal-validity-track"><i class="signal-validity-now" style="left:${position}%" aria-label="${tx("现价", "Current price")} ${money(current)}"><span class="signal-validity-now-price">${money(current)}</span></i></div>${rightLabel}</div><div class="signal-validity-foot"><small>${note}</small></div>`;
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
   重大事件卡片（对比特币影响权重高）
   框选图表时，在两条框选线之间浮现此卡片，只列出「影响力大」的事件：
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
function renderInvestmentCalendarMajorEvents() {
  const now = Date.now();
  // The compact strip is strictly the next four major events by time. It is a
  // near-term glance, while the lower timeline remains the complete calendar.
  const list = majorEventsView()
    .filter(investmentCalendarMatchesSelectors)
    .filter((ev) => ev.at > now - 24 * 60 * 60 * 1000 && ev.at > now)
    .sort((a, b) => a.at - b.at)
    .slice(0, 4);
  if (!list.length) return "";

  const renderMini = (ev) => {
    const bj = calendarFormatBeijing(ev.at, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
    const refZone = calendarLocalZone(ev.country);
    const refLabel = calendarLocalLabel(ev.country);
    const local = calendarFormatInZone(ev.at, refZone, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
    const countdown = ev.at > now ? `<span class="mev-mini-cd">⏳ ${macroCountdown(ev.at)}</span>` : `<span class="mev-mini-cd is-past">${tx("已发生", "Past")}</span>`;
    const kindLabel = ev.kind === "bull" ? tx("利好", "Bull") : ev.kind === "bear" ? tx("利空", "Bear") : tx("中性", "Neutral");
    const mets = ev.estimate !== null || ev.previous !== null
      ? `<span class="mev-mini-met" title="${tx("预期", "Est")}">${tx("预期", "Est")} ${ev.estimate !== null ? calendarEscape(String(ev.estimate)) : "—"}</span><span class="mev-mini-met" title="${tx("前值", "Prev")}">${tx("前值", "Prev")} ${ev.previous !== null ? calendarEscape(String(ev.previous)) : "—"}</span>`
      : "";
    const pickKey = macroCalendarPickKey(ev);
    const isPicked = macroCalendarPicks.has(pickKey);
    return `<article class="mev-mini mev-mini-${ev.kind}${isPicked ? " is-picked" : ""}">
      <label class="cal-pick mev-mini-pick" data-pin-label="${calendarEscape(tx("关注", "Pin"))}" data-pinned-label="${calendarEscape(tx("已关注", "Pinned"))}" title="${calendarEscape(tx("显示在上方宏观实时数据卡片", "Pin to top macro live-data card"))}">
        <input type="checkbox" data-cal-pick="${calendarEscape(pickKey)}"${isPicked ? " checked" : ""}>
        <i class="cal-pick-ui"></i>
      </label>
      <div class="mev-mini-top">
        <i class="mev-mini-dot ${ev.importance}"></i>
        <span class="mev-mini-name" title="${calendarEscape(ev.name)}">${calendarEscape(ev.name)}</span>
        <span class="mev-mini-weight" title="${tx("对比特币影响权重", "BTC impact weight")}">${tx("权重", "W")}${ev.weight}</span>
      </div>
      <div class="mev-mini-times">
        <span class="mev-mini-bj"><i>🇨🇳 ${tx("北京", "BJ")}</i>${calendarEscape(bj)}</span>
        <span class="mev-mini-local"><i>${calendarEscape(refLabel)}</i>${calendarEscape(local)}</span>
      </div>
      <div class="mev-mini-mets">${mets}</div>
      <div class="mev-mini-foot">
        <span class="mev-mini-kind">${kindLabel}</span>
        ${countdown}
      </div>
      ${ev.judge ? `<small class="mev-mini-judge">${calendarEscape(ev.judge)}</small>` : ""}
    </article>`;
  };

  return `<section class="ic-major-events">
    <header class="ic-major-head">
      <b>${tx("重大事件", "Major events")}</b>
      <span>${tx("对比特币影响权重高", "High BTC impact")}</span>
    </header>
    <div class="ic-major-list">${list.map(renderMini).join("")}</div>
  </section>`;
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
  const hi = Math.max(...s.map((v) => v.high)),
    lo = Math.min(...s.map((v) => v.low)),
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
function resetResonanceTimer() {
  clearTimeout(resonanceTimer);
  resonanceTimer = setTimeout(async () => {
    if (!document.hidden) await resonance(true);
    resetResonanceTimer();
  }, 10_000);
}
resonance = async function (auto = false) {
  const btn = $("loadResonance"),
    out = $("resonance");
  if (!out) return;
  if (!auto) {
    btn.disabled = true;
    btn.textContent = tx("计算中…", "Calculating…");
  }
  out.textContent = tx(
    "正在计算 15m、1h、4h、1d 共振…",
    "Calculating 15m, 1h, 4h and 1d resonance…",
  );
  try {
    const rows = await Promise.all(
      ["15m", "1h", "4h", "1d"].map(async (interval) => {
        const r = await fetch(
            "/api/market?" +
              new URLSearchParams({
                interval,
                limit: 200,
                source: state.source,
              }),
          ),
          x = await r.json();
        if (!r.ok) throw new Error(`${interval}: ${x.error}`);
        const m = metrics(x.candles),
          [label, cls] = classification(m.score);
        return `<span class="res-chip ${cls}"><b>${interval}</b><em>${uiLang === "zh" ? label : cls === "bull" ? "Bullish" : cls === "bear" ? "Bearish" : "Neutral"} ${m.score > 0 ? "+" : ""}${m.score.toFixed(2)}</em><small>${x.source}</small></span>`;
      }),
    );
    out.innerHTML = rows.join("");
  } catch (e) {
    out.textContent = `${tx("共振计算失败", "Resonance calculation failed")}：${e.message}`;
  } finally {
    if (!auto) {
      btn.disabled = false;
      btn.textContent = tx("重新计算共振", "Recalculate resonance");
    }
    resetResonanceTimer();
  }
};
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
  tip.innerHTML = `<b>${pointTime(v.time)}</b><strong class="chart-point-price">${tx("选中价", "Selected price")} ${money(v.close)}</strong><span class="chart-live-price">${tx("实时价", "Live price")} ${money(live)} <i class="${delta >= 0 ? "bull" : "bear"}">${tx("差价", "Δ")} ${delta >= 0 ? "+" : "−"}${money(Math.abs(delta))}</i></span><span>${tx("开", "Open")} ${money(v.open)}　${tx("高", "High")} ${money(v.high)}</span><span>${tx("低", "Low")} ${money(v.low)}　${tx("收", "Close")} ${money(v.close)}</span>${volHtml}${rsiHtml}`;
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
$("loadResonance").onclick = () => resonance(false);
resetResonanceTimer();
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
const resonanceQuiet = resonance;
resonance = async function (auto = false) {
  const btn = $("loadResonance"),
    out = $("resonance");
  if (!out) return;
  if (!auto) {
    btn.disabled = true;
    btn.textContent = tx("计算中…", "Calculating…");
    out.textContent = tx(
      "正在计算 15m、1h、4h、1d 共振…",
      "Calculating 15m, 1h, 4h and 1d resonance…",
    );
  }
  try {
    const rows = await Promise.all(
      ["15m", "1h", "4h", "1d"].map(async (interval) => {
        const r = await fetch(
            "/api/market?" +
              new URLSearchParams({
                interval,
                limit: 200,
                source: state.source,
              }),
          ),
          x = await r.json();
        if (!r.ok) throw new Error(`${interval}: ${x.error}`);
        const m = metrics(x.candles),
          [label, cls] = classification(m.score);
        return `<span class="res-chip ${cls}"><b>${interval}</b><em>${label} ${m.score > 0 ? "+" : ""}${m.score.toFixed(2)}</em><small>${x.source}</small></span>`;
      }),
    );
    const html = rows.join("");
    if (out.innerHTML !== html) out.innerHTML = html;
  } catch (e) {
    if (!auto)
      out.textContent = `${tx("共振计算失败", "Resonance calculation failed")}：${e.message}`;
  } finally {
    if (!auto) {
      btn.disabled = false;
      btn.textContent = tx("重新计算共振", "Recalculate resonance");
    }
    resetResonanceTimer();
  }
};
$("loadResonance").onclick = () => resonance(false);
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
    P = { l: 18, r: 74, t: 15, b: 30 },
    cw = rect.width - P.l - P.r,
    ch = rect.height - P.t - P.b,
    closes = d.map((v) => v.close),
    values = [...closes];
  [ema(closes, 20), ema(closes, 50), ema(closes, 200)].forEach((a) =>
    a.forEach((v) => {
      if (Number.isFinite(v)) values.push(v);
    }),
  );
  let min = Math.min(...values),
    max = Math.max(...values),
    pad = (max - min || 1) * 0.075;
  min -= pad;
  max += pad;
  const x = (i) => P.l + (i / (d.length - 1)) * cw,
    y = (v) => P.t + ch - ((v - min) / (max - min)) * ch,
    hi = d.reduce((best, v, i) => (v.close > d[best].close ? i : best), 0),
    lo = d.reduce((best, v, i) => (v.close < d[best].close ? i : best), 0),
    mx = event.clientX - rect.left,
    my = event.clientY - rect.top,
    near = (i, v) => Math.hypot(mx - x(i), my - y(v)) <= 15;
  high.classList.toggle("is-visible", near(hi, d[hi].close));
  low.classList.toggle("is-visible", near(lo, d[lo].close));
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
      (text.startsWith("最高选中价") ||
        text.startsWith("最低选中价") ||
        text.startsWith("Highest selected price") ||
        text.startsWith("Lowest selected price"))
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
      (text.startsWith("最高选中价") ||
        text.startsWith("最低选中价") ||
        text.startsWith("Highest selected price") ||
        text.startsWith("Lowest selected price"))
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
    high = Math.max(...prior.map((x) => x.high)),
    low = Math.min(...prior.map((x) => x.low)),
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
    high = Math.max(...prior.map((x) => x.high)),
    low = Math.min(...prior.map((x) => x.low)),
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
const entryPriceStorageKey = "btc_personal_entry_price",
  entryPricesStorageKey = "btc_personal_entry_prices_v3";
// 方向按卡片单独保存；行情每秒刷新时只读取此固定选择，不推断或覆盖用户的多空选择。
// Persist direction per card. Live quote refreshes only read this explicit choice; they never infer or overwrite it.
const entrySideStorageKey = (index) => `btc_personal_entry_side_v1_${index}`;
const validEntry = (value) =>
  Number.isFinite(value) && value > 0 ? value : null;
let personalEntries = [
  { price: null, amount: null, margin: null, leverage: null, side: "long" },
  { price: null, amount: null, margin: null, leverage: null, side: "short" },
];
let personalEntriesFollowAccount = false;
const hasPersonalEntriesV3 =
  localStorage.getItem(entryPricesStorageKey) !== null;
try {
  const saved = JSON.parse(localStorage.getItem(entryPricesStorageKey) || "[]");
  if (Array.isArray(saved) && saved.length === 2)
    personalEntries = saved.map((entry, index) => ({
      price: validEntry(Number(entry?.price)),
      amount: validEntry(Number(entry?.amount)),
      // Migrate the previous leverage-only input into the new margin field.
      margin: validEntry(Number(entry?.margin)) || (validEntry(Number(entry?.amount)) && Number(entry?.leverage) > 0 ? Number(entry.amount) / Number(entry.leverage) : null),
      leverage: validEntry(Number(entry?.leverage)) || (validEntry(Number(entry?.amount)) && validEntry(Number(entry?.margin)) ? Number(entry.amount) / Number(entry.margin) : null),
      side: entry?.side === "short" ? "short" : index === 1 ? "short" : "long",
    }));
} catch {}
// Only migrate old single-price storage once. An intentionally blank v3 value
// must remain blank after reload instead of being repopulated from v2/legacy.
if (!hasPersonalEntriesV3) {
  try {
    const prior = JSON.parse(
      localStorage.getItem("btc_personal_entry_prices_v2") || "{}",
    );
    personalEntries = [
      { price: validEntry(Number(prior.long)), amount: null, margin: null, leverage: null, side: "long" },
      { price: validEntry(Number(prior.short)), amount: null, margin: null, leverage: null, side: "short" },
    ];
  } catch {}
  const legacy = validEntry(Number(localStorage.getItem(entryPriceStorageKey)));
  if (legacy)
    personalEntries[0] = {
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
personalEntries = personalEntries.map((entry, index) => {
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
let personalEntryEditingIndex = null;
window.btcPersonalEntries = personalEntries;
function savePersonalEntries() {
  window.btcPersonalEntries = personalEntries;
  localStorage.setItem(entryPricesStorageKey, JSON.stringify(personalEntries));
  personalEntries.forEach((entry, index) =>
    localStorage.setItem(entrySideStorageKey(index), entry.side),
  );
  localStorage.removeItem("btc_personal_entry_prices_v2");
  localStorage.removeItem(entryPriceStorageKey);
  localStorage.removeItem("btc_personal_entry_side");
  window.dispatchEvent(new Event("btc:personal-entries-changed"));
  if (personalEntriesFollowAccount)
    fetch("/api/account/profile", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ personalEntries }),
    })
      .then((response) => {
        if (!response.ok) throw new Error("账户同步失败");
      })
      .catch(() => {
        personalEntriesFollowAccount = false;
        renderPersonalEntryCard();
      });
}
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
      savePersonalEntries();
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
  savePersonalEntries();
}
function renderPersonalEntryLegend() {
  // 顶部图例已精简为只保留 K线图+价格，个人买入价图例不再追加。
  return;
}
function renderPersonalEntryCard(force = false) {
  const card = ensurePersonalEntryCard(),
    live = state.ticker?.last;
  if (!card || (!force && personalEntryEditingIndex !== null)) return;
  card.className = `personal-entry-card${personalEntriesFollowAccount ? " account-synced" : ""}`;
  const sync = personalEntriesFollowAccount
    ? `<small class="personal-entry-account-sync" title="${tx("该数据已保存到当前登录账户，并会随账户恢复", "This data is stored in the signed-in account and follows it across browsers")}">${tx("已同步", "Synced")}</small>`
    : "";
  card.innerHTML =
    personalEntrySlot(0, live) + personalEntrySlot(1, live);
  applyHeroUnitOrder();
  /* 已同步徽章挂在视觉上第一个持仓槽的“我的持仓”标题旁，
     不再绝对定位到卡片右上角（display:contents 会让它失去定位基准飞到页头）。 */
  if (sync) {
    const hostKey = heroUnitOrder.find((key) => key !== "price"),
      hostIndex = Number(String(hostKey).slice(4));
    card
      .querySelector(
        `[data-hero-unit="slot${hostIndex}"] .personal-entry-heading`,
      )
      ?.insertAdjacentHTML("beforeend", sync);
  }
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
bindHeroUnitDrag();
heroUnitDesktop.addEventListener?.("change", applyHeroUnitOrder);
renderPersonalEntryCard();
applyHeroUnitOrder();
window.addEventListener("btc:account-state", async (event) => {
  if (!event.detail?.loggedIn) {
    personalEntriesFollowAccount = false;
    renderPersonalEntryCard();
    return;
  }
  try {
    const response = await fetch("/api/account/profile"),
      data = await response.json();
    if (!response.ok) throw new Error(data.error || "账户资料读取失败");
    const cloudEntries = data.profile?.personalEntries;
    if (Array.isArray(cloudEntries) && cloudEntries.length === 2) {
      personalEntries = cloudEntries.map((entry, index) => ({
        price: validEntry(Number(entry?.price)),
        amount: validEntry(Number(entry?.amount)),
        margin: validEntry(Number(entry?.margin)) || (validEntry(Number(entry?.amount)) && Number(entry?.leverage) > 0 ? Number(entry.amount) / Number(entry.leverage) : null),
        leverage: validEntry(Number(entry?.leverage)) || (validEntry(Number(entry?.amount)) && validEntry(Number(entry?.margin)) ? Number(entry.amount) / Number(entry.margin) : null),
        side:
          entry?.side === "short" ? "short" : index === 1 ? "short" : "long",
      }));
      personalEntriesFollowAccount = true;
      savePersonalEntries();
      renderPersonalEntryCard();
      return;
    }
    personalEntriesFollowAccount = true;
    savePersonalEntries();
    renderPersonalEntryCard();
  } catch {
    personalEntriesFollowAccount = false;
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
  let card = $("fedMonitorCard"),
    correlation = document.querySelector(".correlation-card");
  if (!card) {
    card = document.createElement("section");
    card.id = "fedMonitorCard";
    card.className = "card fed-monitor-card";
    if (correlation) correlation.before(card);
    else document.querySelector("main")?.append(card);
  }
  if (!card) return;
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
  card.innerHTML = `<div class="fed-monitor-head"><div><h2>${tx("BTC × 美联储监控", "BTC × Federal Reserve monitor")}</h2><p>${tx("公开日历与跨市场环境数据；事件前后行情波动可能放大，不构成方向预测。", "Public event-calendar and cross-market context. Volatility can rise around releases; this is not a directional forecast.")}</p></div><span>${tx("每 10 分钟检查", "Checked every 10 min")}</span></div>${marketPanel}<div class="fed-event-grid">${eventCards || `<article class="fed-event unavailable"><span>${tx("公开日历暂不可用", "Public calendar unavailable")}</span><small>${tx("下次 10 分钟检查会自动重试。", "The next ten-minute check will retry automatically.")}</small></article>`}</div><footer>${nearest ? tx(`最近事件：${tname(MACRO_EVENT_NAMES, nearest.key)}，请在发布前后降低杠杆和仓位集中度。`, `Nearest event: ${tname(MACRO_EVENT_NAMES, nearest.key)}. Consider reducing leverage and concentration around the release.`) : tx("使用 Federal Reserve 与 BLS 的公开发布日历。", "Uses public Federal Reserve and BLS release calendars.")} <em>${data?.cached ? tx("缓存", "Cached") : tx("刚更新", "Updated")}</em></footer>`;
  refreshMacroUpdateAges();
  addHelp(
    card.querySelector(".fed-monitor-head h2"),
    "显示下一次 FOMC、CPI 与非农等公开日历事件及倒计时。它提示可能放大的波动窗口，不预测事件结果或价格方向。",
    "Shows the next FOMC, CPI and payroll calendar events and countdowns. It flags potentially volatile windows, not event outcomes or price direction.",
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
loadFedMonitor();
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
let investmentCalendarRange = "all";          // yesterday|today|tomorrow|week|nextweek|custom|all
let investmentCalendarFrom = "";              // yyyy-mm-dd (Beijing day)
let investmentCalendarTo = "";                // yyyy-mm-dd (Beijing day)
let investmentCalendarImportance = new Set(); // empty = all (low|medium|high)
let investmentCalendarRegions = new Set();    // empty = all countries
let investmentCalendarCategories = new Set(); // empty = all categories
let investmentCalendarTimeZone = "local";     // reference zone for the secondary line
let investmentCalendarShowFilters = true;
let investmentCalendarVisibleLimit = 6;        // collapsed=6, first expansion=10, then +10
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
// Date shortcuts narrow the otherwise complete calendar timeline.
function calendarRangeWindow(range) {
  const today = calendarBeijingDayStart(Date.now());
  switch (range) {
    case "yesterday": return [today - CALENDAR_DAY, today];
    case "tomorrow": return [today + CALENDAR_DAY, today + 2 * CALENDAR_DAY];
    case "week": { const w = calendarWeekStart(today); return [w, w + 7 * CALENDAR_DAY]; }
    case "nextweek": { const w = calendarWeekStart(today) + 7 * CALENDAR_DAY; return [w, w + 7 * CALENDAR_DAY]; }
    case "all": return [-Infinity, Infinity];
    case "custom": {
      const from = calendarBeijingDateToMs(investmentCalendarFrom), to = calendarBeijingDateToMs(investmentCalendarTo);
      return [Number.isFinite(from) ? from : -Infinity, Number.isFinite(to) ? to + CALENDAR_DAY : Infinity];
    }
    default: return [today, today + CALENDAR_DAY];
  }
}
const CALENDAR_RANGES = [
  ["yesterday", "昨天", "Yesterday"], ["today", "今天", "Today"], ["tomorrow", "明天", "Tomorrow"],
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
  ["chain", "BTC 链上", "BTC chain", "cat-chain"],
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

function renderCalendarEventRow(event) {
  const pickKey = macroCalendarPickKey(event);
  const isPicked = macroCalendarPicks.has(pickKey);
  const country = calendarCountry(event.country);
  const category = calendarCategoryMeta(event.category);
  const [label, read, hot] = calendarWindow(event);
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
  return `<li class="cal-event${hot?" is-hot":""}${isPicked?" is-picked":""}" data-category="${calendarEscape(event.category||"")}">
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
      <div class="cal-name"><span class="cal-cat ${category.cls}">${calendarEscape(category.label)}</span>${calendarEscape(calendarEventTitle(event.title))}${event.fallback?"<em class=\"cal-fallback\">节奏回退</em>":""}</div>
      <div class="cal-sub">${calendarEscape(event.source||"--")}</div>
    </div>
    <div class="cal-impact imp-${event.importance}" title="${event.importance==="high"?tx("高重要","High"):event.importance==="medium"?tx("中重要","Medium"):tx("低重要","Low")}">${calendarImportanceDots(event)}</div>
    <span class="ic-met is-actual"><b>${tx("今值","Act")}</b>${met(event.actual,"actual")}</span>
    <span class="ic-met is-est"><b>${tx("预期","Est")}</b>${met(event.estimate,"estimate")}</span>
    <span class="ic-met is-prev"><b>${tx("前值","Prev")}</b>${met(event.previous,"previous")}</span>
    <div class="cal-read ${hot?"is-hot":""}"><b>${label}</b><span title="${calendarEscape(read)}">${calendarEscape(read)}</span></div>
  </li>`;
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
function renderInvestmentCalendar(data) {
  investmentCalendarData = data || investmentCalendarData;
  let card = $("investmentCalendarCard");
  if (!card) {
    card = document.createElement("section");
    card.id = "investmentCalendarCard";
    card.className = "card investment-calendar-card";
    // 阅读顺序：BTC 多因子研究 → 宏观经济数据 → 投资日历 → 宏观与情绪。
    const released = $("releasedDataCard"),
      research = $("researchOutlookCard"),
      fed = $("fedMonitorCard"),
      anchor = $("fearGreedGauge");
    if (released) released.after(card);
    else if (research) research.after(card);
    else if (fed) fed.before(card);
    else if (anchor) anchor.after(card);
    else document.querySelector("main")?.append(card);
  }
  if (!card) return;

  const allEvents = investmentCalendarData?.events || [];
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
  for (const event of visibleEvents) {
    const day = dayKey(event.at);
    if (day !== previousDay) {
      previousDay = day;
      const isToday = calendarBeijingDayKey(event.at) === todayKey;
      listHtml += `<li class="cal-day"><span class="cal-day-name">${calendarEscape(day)}</span>${isToday ? '<em class="cal-day-today">今天</em>' : ""}</li>`;
    }
    listHtml += renderCalendarEventRow(event);
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
  const hasMoreEvents = visibleEvents.length < events.length;
  const nextVisibleCount = investmentCalendarVisibleLimit <= 6 ? Math.min(10, events.length) : Math.min(investmentCalendarVisibleLimit + 10, events.length);
  card.innerHTML = `
    <header class="ic-header">
      <div class="ic-title">
        <div class="ic-kicker"><i></i>ECONOMIC CALENDAR · 投资日历</div>
        <h2>${tx("投资日历", "Investment calendar")}</h2>
        <p>${tx("美元流动性、全球宏观、能源与避险、BTC 原生事件同处一条时间轴。默认按北京时间排序，下方小字为事件当地时间。", "One timeline for dollar liquidity, global macro, energy/risk and BTC-native events. Sorted by Beijing time; the small line shows the event's local time.")}</p>
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

    ${renderInvestmentCalendarMajorEvents()}

    <div class="ic-subbar">
      <span class="ic-clock">${tx("当前时间","Now")} <b data-calendar-clock>--:--:--</b> <em>GMT+8:00</em></span>
      <span class="ic-range-note">${calendarEscape(rankText)}</span>
      <span class="ic-tz-wrap"><i>${tx("参考时区","Reference")}</i>${tzButtons.map(([zone,label]) => `<button type="button" class="ic-tz-btn${investmentCalendarTimeZone===zone?" active":""}" data-calendar-zone="${zone}">${label}</button>`).join("")}</span>
    </div>

    <div class="ic-risk ${nearestHigh?"is-hot":"is-safe"}">
      <span class="ic-risk-label">${riskLabel}</span>
      <span class="ic-risk-text">${calendarEscape(riskText)}</span>
    </div>

    <ul class="ic-list">${listHtml}</ul>
    ${hasMoreEvents ? `<div class="ic-list-more"><button type="button" data-calendar-more>${investmentCalendarVisibleLimit <= 6 ? tx(`展开至 ${nextVisibleCount} 条`, `Show ${nextVisibleCount}`) : tx("继续展开 10 条", "Show 10 more")}</button><span>${tx(`已显示 ${visibleEvents.length} / ${events.length} 条`, `${visibleEvents.length} / ${events.length} shown`)}</span></div>` : ""}

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
  card.querySelector("[data-calendar-more]")?.addEventListener("click", () => {
    investmentCalendarVisibleLimit = investmentCalendarVisibleLimit <= 6 ? 10 : investmentCalendarVisibleLimit + 10;
    renderInvestmentCalendar(investmentCalendarData);
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
  // 数据到位后同步刷新「宏观与情绪」与「宏观经济数据」。卡片尚未挂载时跳过，
  // 交给布局稳定后的补渲染逻辑，避免过早插入被重排丢弃。
  const fgCard = $("fearGreedGauge");
  if (fgCard && fgCard.isConnected) renderFearGreedGauge();
  const releasedCard = $("releasedDataCard");
  if (releasedCard && releasedCard.isConnected) renderReleasedDataCard();
}
loadMacroCalendarPicks();
loadInvestmentCalendar();
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
    ? `<li class="news-item ${kind}"><a href="${calendarEscape(item.url)}" target="_blank" rel="noopener noreferrer">${inner}</a></li>`
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
      ? { kind: "bear", label: tx("利空 BTC", "Bearish BTC"), tip: tx(`${detail}，超预期偏紧缩，通常利空风险资产。`, `${detail}; hotter than expected is typically hawkish and bearish for risk assets.`) + " " + caveat }
      : { kind: "bull", label: tx("利好 BTC", "Bullish BTC"), tip: tx(`${detail}，不及预期偏宽松，通常利好风险资产。`, `${detail}; cooler than expected is typically dovish and bullish for risk assets.`) + " " + caveat };
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
  if (dir > 0) return { kind: "bull", text: tx("利好 BTC", "Bullish BTC") };
  if (dir < 0) return { kind: "bear", text: tx("利空 BTC", "Bearish BTC") };
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
    bull: { cls: "bull", label: tx("利好 BTC", "Bullish BTC") },
    bear: { cls: "bear", label: tx("利空 BTC", "Bearish BTC") },
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
  let card = $("releasedDataCard");
  if (!card) {
    card = document.createElement("section");
    card.id = "releasedDataCard";
    card.className = "card released-data-card";
    // 放在「BTC 多因子研究」下方；investmentCalendarCard 会再跟在它后面。
    // 研究卡异步加载，若尚未就绪则先放入主流程安全位置，避免落入右侧 side-stack。
    const research = $("researchOutlookCard");
    if (research) research.after(card);
    else {
      const pattern = $("patternAnalysis"),
        terminal = document.querySelector(".terminal-layout"),
        main = document.querySelector("main");
      if (pattern) pattern.after(card);
      else if (terminal) terminal.after(card);
      else main?.append(card);
    }
  }
  if (!card) return;

  const filters = {
    regions: releasedDataRegions,
    categories: releasedDataCategories,
    importance: releasedDataImportance,
  };

  // 筛选器候选池：过去 14 天到未来 14 天的宏观事件，计数不受当前筛选影响。
  const now = Date.now();
  const pool = (investmentCalendarData?.events || [])
    .filter((event) => event.category === "macro")
    .filter((event) => event.at >= now - 14 * CALENDAR_DAY && event.at <= now + 14 * CALENDAR_DAY);
  const countBy = (list, pick) => list.reduce((acc, event) => { const key = pick(event); acc.set(key, (acc.get(key) || 0) + 1); return acc; }, new Map());
  const countryCounts = countBy(pool, (event) => event.country || "GLOBAL");
  const categoryCounts = countBy(pool, (event) => event.category || "macro");
  const importanceCounts = countBy(pool, (event) => event.importance || "low");

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

  const actualsEvents = releasedMacroEvents(12, filters);
  const impactEvents = calendarImpactEvents(6, filters);

  const actualsBody = actualsEvents.length
    ? `<section class="released-actuals-section"><h3 class="released-actuals-head">${tx("已公布实际值","Released actuals")}</h3><div class="released-data-grid">${actualsEvents.map(renderReleasedRow).join("")}</div></section>`
    : "";
  const impactBody = impactEvents.length
    ? `<section class="released-impact-section"><div class="ic-impact-head"><h3>${tx("数据公布影响预测","Data-reaction playbook")}</h3><p>${tx("按“公布值 vs 预期”的预期差推断方向：通胀 / 利率 / 就业高于预期多为紧缩（利空风险资产），增长与库存另有映射。属经验规律，非确定性结论。","Directions are inferred from the surprise vs consensus: inflation, rates and jobs above expectation are typically hawkish (bearish risk assets). Heuristic, not a certainty.")}</p></div><div class="ic-impact-grid released-impact-grid">${impactEvents.map((event) => renderImpactCard(event)).join("")}</div></section>`
    : "";
  const bodyHtml = actualsBody || impactBody ? `${actualsBody}${impactBody}` : "";
  const emptyHtml = !bodyHtml
    ? `<div class="released-data-body"><p class="macro-cmp-empty">${investmentCalendarData ? tx("当前筛选条件下暂无宏观事件，可调整筛选器或等待新数据公布。", "No macro events match the current filters.") : tx("日历加载中…", "Loading calendar…")}</p></div>`
    : "";
  const filtersHtml = `
    <div class="released-data-toolbar">
      <button type="button" class="ic-filter-toggle" data-released-toggle-filters>${releasedDataShowFilters ? tx("隐藏筛选器","Hide filters") : tx("显示筛选器","Show filters")}<i class="ic-caret${releasedDataShowFilters?" up":""}"></i></button>
    </div>
    ${releasedDataShowFilters ? `<div class="ic-fields released-data-fields">
      ${renderReleasedDataField("region", tx("国家及地区","Country / region"), countryOptions, releasedDataRegions)}
      ${renderReleasedDataField("category", tx("类别领域","Category"), categoryOptions, releasedDataCategories)}
      ${renderReleasedDataField("importance", tx("重要性","Importance"), importanceOptions, releasedDataImportance)}
    </div>` : ""}`;

  card.innerHTML = `<div class="released-data-head"><h2>${tx("宏观经济数据", "Macroeconomic data")}</h2><span>${tx("实际值实时回填", "Actuals filled live")}</span></div>${filtersHtml}${bodyHtml ? `<div class="released-data-body">${bodyHtml}</div>` : emptyHtml}`;

  // —— Toolbar wiring ——
  card.querySelector("[data-released-toggle-filters]")?.addEventListener("click", () => {
    releasedDataShowFilters = !releasedDataShowFilters;
    releasedDataOpenMenu = null;
    renderReleasedDataCard();
  });
  // —— Filter menus ——
  card.querySelectorAll("[data-released-menu-toggle]").forEach((button) => button.addEventListener("click", () => {
    const kind = button.dataset.releasedMenuToggle;
    releasedDataOpenMenu = releasedDataOpenMenu === kind ? null : kind;
    renderReleasedDataCard();
  }));
  card.querySelectorAll("[data-released-menu-search]").forEach((input) => input.addEventListener("input", () => {
    const kind = input.dataset.releasedMenuSearch, query = input.value.trim().toLowerCase();
    releasedDataMenuSearch[kind] = input.value;
    input.closest(".ic-menu")?.querySelectorAll("li[data-search-text]").forEach((row) => {
      row.hidden = Boolean(query) && !row.dataset.searchText.includes(query);
    });
  }));
  card.querySelectorAll("[data-released-opt-field]").forEach((box) => box.addEventListener("change", () => {
    const kind = box.dataset.releasedOptField, key = box.dataset.releasedOptKey;
    const target = kind === "region" ? releasedDataRegions : kind === "category" ? releasedDataCategories : releasedDataImportance;
    if (box.checked) target.add(key); else target.delete(key);
    renderReleasedDataCard();
  }));
  card.querySelectorAll("[data-released-menu-all]").forEach((button) => button.addEventListener("click", () => {
    const kind = button.dataset.releasedMenuAll;
    const target = kind === "region" ? releasedDataRegions : kind === "category" ? releasedDataCategories : releasedDataImportance;
    const query = String(releasedDataMenuSearch[kind] || "").trim().toLowerCase();
    button.closest(".ic-menu")?.querySelectorAll("[data-released-opt-key]").forEach((box) => {
      const row = box.closest("li[data-search-text]");
      if (query && row?.hidden) return;
      target.add(box.dataset.releasedOptKey);
    });
    renderReleasedDataCard();
  }));
  card.querySelectorAll("[data-released-menu-clear]").forEach((button) => button.addEventListener("click", () => {
    const kind = button.dataset.releasedMenuClear;
    const target = kind === "region" ? releasedDataRegions : kind === "category" ? releasedDataCategories : releasedDataImportance;
    const query = String(releasedDataMenuSearch[kind] || "").trim().toLowerCase();
    if (!query) { target.clear(); renderReleasedDataCard(); return; }
    button.closest(".ic-menu")?.querySelectorAll("[data-released-opt-key]").forEach((box) => {
      const row = box.closest("li[data-search-text]");
      if (row?.hidden) return;
      target.delete(box.dataset.releasedOptKey);
    });
    renderReleasedDataCard();
  }));

  if (!window.__btcReleasedDataOutsideClickBound) {
    window.__btcReleasedDataOutsideClickBound = true;
    document.addEventListener("click", (event) => {
      if (!releasedDataOpenMenu) return;
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      const insideField = path.some((node) => node && node.classList && node.classList.contains("rd-field"));
      if (insideField) return;
      releasedDataOpenMenu = null;
      renderReleasedDataCard();
    });
  }
}
function renderFearGreedGauge() {
  const card = ensureFearGreedCard();
  if (!card) return;
  card.hidden = false;
  // 卡片内直接展示关注宏观事件的实时数据：最近勾选、且未公布或公布后 30 分钟内的事件。
  const pinnedNow = macroCalendarPickedLiveEvent();
  const emptyText = pinnedNow
    ? tx("该事件已公布超过 30 分钟，已自动移除。在投资日历或「重大事件」卡片勾选新的事件即可继续查看实时数据。", "This release was published more than 30 minutes ago and has been removed. Pin a new macro or major event in the investment calendar to see live data again.")
    : tx("在投资日历列表或「重大事件」卡片勾选关注的宏观/重大事件，北京时间、倒计时、预期/前值/实际与阈值式解读会显示在这里", "Pin a macro or major event in the investment calendar to see its Beijing time, countdown, estimate/previous/actual and threshold read-through here");
  const body = pinnedNow
    ? renderPinnedRelease(pinnedNow)
    : `<p class="macro-cmp-empty">${emptyText}</p>`;
  card.className = "card fear-greed-gauge-card fear-greed-compact";
  card.innerHTML = `<div class="fear-greed-head"><h2>${tx("关注宏观事件实时数据", "Pinned macro release")}</h2><span>${tx("实时数据", "Live data")}</span></div><div class="fear-greed-compact-grid macro-sentiment-grid">${body}</div>`;
  addHelp(
    card.querySelector(".fear-greed-head h2"),
    "这里直接展示你最近勾选的宏观事件或重大事件实时数据：北京时间、倒计时、预期/前值/实际，以及「高于/低于锚点分别对 BTC 属于利好还是利空」的阈值式解读。可在投资日历列表或「重大事件」卡片中勾选关注；事件公布超过 30 分钟后会自动移除；未公布事件在公布前后 2 分钟内会高频刷新，第一时间抓取实际值。恐惧贪婪指数已从该卡移除；宏观经济数据已独立成卡，位于「BTC 多因子研究」与「投资日历」之间。",
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
loadFearGreedSentiment().then((data) => {
  if (data?.storageCached) setTimeout(() => loadFearGreedSentiment(true), 0);
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
  // Nest the evidence directly in the K-line card. A separate grid row would
  // inherit the height of the much taller right column and leave a blank gap.
  const chartCard = $("mainChartCard");
  if (layout && chartCard && card.parentElement !== chartCard)
    chartCard.append(card);
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
        "当前 OKX V5 公共数据源没有返回可验证的 BTC-USDT-SWAP 清算流，因此本卡不会用推测值替代。",
        "The current OKX V5 public feed is not returning a verifiable BTC-USDT-SWAP liquidation stream.",
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
  card.innerHTML = `<div class="microstructure-head"><div><h2>${tx("OKX 市场微观结构", "OKX market microstructure")} <button class="help-dot" type="button" data-tip="${tx("来自 OKX BTC-USDT 永续的公开 WebSocket：盘口、最新成交、持仓量、资金费率与现货/永续价格。用于 5 分钟到 1 小时的短线确认，不保证预测正确。", "Public OKX WebSocket data for BTC-USDT perpetual: order book, recent trades, OI, funding and spot/perpetual prices. It supports 5m–1h confirmation, not guaranteed prediction.")}">!</button></h2><p>${tx("盘口与成交实时 · OI、费率持续更新", "Live order book and trades · continuously updated OI and funding")}</p></div><span>${context.transport === "websocket" ? tx("OKX WebSocket", "OKX WebSocket") : tx("REST 备用", "REST fallback")}</span></div><div class="microstructure-conclusion ${conclusionKind}"><b>${conclusion}</b><p>${reason}</p></div><div class="microstructure-grid ${gridClass(directionalRows)}">${directionalRows.map(rowHtml).join("")}</div>${neutralSection}`;
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
const refreshIntervalMs = 1_000;
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
    void resonance(false);
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
loadDerivativeMarketContext(true);

/* Keep projection output synchronized with each fixed-basis signal refresh. */
addFixedRuleSignalEnhancer("signal-projection", () => {
  if (fixedRuleSignal.candles.length >= 30) {
    renderSignalProjection();
  }
});
if (fixedRuleSignal.candles.length) renderFixedRuleSignal();

/* Keep the personal reference quote attached after all late ticker wrappers. */
renderPersonalEntryCard();

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
  let card = $("releasedDataCard");
  if (card) return card;
  card = document.createElement("section");
  card.id = "releasedDataCard";
  card.className = "card released-data-card";
  card.innerHTML = `<div class="released-data-head"><h2>${tx("宏观经济数据", "Macroeconomic data")}</h2><span>${tx("实际值实时回填", "Actuals filled live")}</span></div><div class="released-data-body"><p class="macro-cmp-empty">${tx("日历加载中…", "Loading calendar…")}</p></div>`;
  // 放在「BTC 多因子研究」下方；investmentCalendarCard 会再跟在它后面。
  // 研究卡异步加载，若尚未就绪则先放入主流程安全位置，避免落入右侧 side-stack。
  const research = $("researchOutlookCard");
  if (research) research.after(card);
  else {
    const pattern = $("patternAnalysis"),
      terminal = document.querySelector(".terminal-layout"),
      main = document.querySelector("main");
    if (pattern) pattern.after(card);
    else if (terminal) terminal.after(card);
    else main?.append(card);
  }
  return card;
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
  // 周期涨幅始终放在 OKX 微观结构卡片之后（两者都在 #mainChartCard 内），
  // 避免被右侧 side-stack 高度推到下一行产生左列空白。
  if (micro) micro.after(period);
  else if (!chart.contains(period)) chart?.append(period);
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
  // 若宏观经济数据卡已提前创建，确保它紧跟在研究卡后面。
  const released = $("releasedDataCard");
  if (released && card.nextElementSibling !== released) card.after(released);
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
function renderResearchOutlook(data) {
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
      `<li class="flat"><span>${tx("该时间窗暂无可用 BTC 新闻。", "No BTC headline is available in this window.")}</span></li>`,
    twoHourItems = newsItems.filter(
      (item) =>
        Number.isFinite(item.publishedAt) &&
        Date.now() - item.publishedAt <= 2 * 3_600_000,
    ),
    newsPanel = `<div class="research-news"><h3>${tx("BTC 重点新闻（可点击查看原文）", "BTC priority headlines (click to open)")}</h3><div class="research-news-windows"><section><h4>${tx("近 2 小时", "Last 2 hours")}</h4><ul>${newsRows(twoHourItems)}</ul></section><section><h4>${tx("近 24 小时", "Last 24 hours")}</h4><ul>${newsRows(newsItems)}</ul></section></div></div>`,
    headlineRows = newsRows(newsItems);
  const windows = (data.windows || [])
    .map((window) => {
      const move = Number(window.expectedMove),
        ret = Number(window.expectedReturn) * 100,
        prob = Number(window.upProbability) * 100,
        quality = Math.round(Number(window.matchQuality || 0) * 100),
        range = window.priceRange || {},
        label = researchProbabilityLabel(prob);
      return `<article class="research-window ${label.kind}"><span>${safeText(txWinLabel(window.label))} · ${tx({ bull: "牛市", bear: "熊市", range: "震荡" }[window.regime] || "未知", { bull: "Bull", bear: "Bear", range: "Range" }[window.regime] || "Unknown")}</span><b>${label.title}</b><strong class="${label.side}">${label.detail}</strong><em>${tx("预期变动", "Expected move")} ${move >= 0 ? "+" : "−"}${money(Math.abs(move))} (${ret >= 0 ? "+" : "−"}${Math.abs(ret).toFixed(2)}%)</em><small>${tx("价格区间 P10/P50/P90", "Price range P10/P50/P90")}：${money(range.p10)} / ${money(range.p50)} / ${money(range.p90)}</small><small>${tx("匹配质量", "Match quality")} ${quality}% · n=${window.samples}/${window.candidateCount}</small></article>`;
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
            ? `${tx("验证", "Validation")} ${validation.split || ""} · ${tx("命中", "Hit")} ${(validation.accuracy * 100).toFixed(1)}% · Brier ${validation.brier.toFixed(3)} · BSS ${Number.isFinite(validation.brierSkill) ? `${(validation.brierSkill * 100).toFixed(1)}%` : "--"} · ECE ${Number.isFinite(validation.ece) ? `${(validation.ece * 100).toFixed(1)}%` : "--"} · AUC ${Number.isFinite(validation.auc) ? validation.auc.toFixed(3) : "--"} · n=${validation.samples}`
            : tx("样本不足", "Insufficient samples"),
          economic = live?.economic
            ? `${tx("成本后", "After cost")} ${live.economic.trades} ${tx("笔", "trades")} · ${tx("净收益", "Net")} ${pct(live.economic.netReturn * 100)} · ${tx("最大回撤", "Max DD")} ${pct(live.economic.maxDrawdown * 100)}`
            : null;
        return `<article><b>${safeText(txWinLabel(window.label))}</b><span>${quality}</span><span>${live ? `${tx("实时", "Live")} ${tx("命中", "Hit")} ${(live.hitRate * 100).toFixed(1)}% · Brier ${live.brier.toFixed(3)} · BSS ${Number.isFinite(live.brierSkill) ? `${(live.brierSkill * 100).toFixed(1)}%` : "--"} · ECE ${Number.isFinite(live.ece) ? `${(live.ece * 100).toFixed(1)}%` : "--"} · n=${live.settled}` : `${tx("实时命中待积累", "Live outcomes pending")} · ${tx("待结算", "Pending")} ${pending}`}</span>${economic ? `<span>${economic}</span>` : ""}</article>`;
      })
      .join("");
  const scorecardPanel = `<section class="research-scorecard"><h3>${tx("模型记分卡", "Model scorecard")}</h3><p>${tx("三重屏障标签 · 时间顺序 60/20/20 切分并 embargo · 逻辑回归与本地树模型基线动态加权 · Platt 仅在独立校准窗拟合。BSS 相对朴素上涨率基准；成本化指标只使用已结算预测。", "Triple-barrier labels · chronological 60/20/20 split with embargo · dynamically blended logistic and local tree baseline · Platt fits only on the independent calibration window. BSS is relative to a naive base-rate forecast; cost metrics use settled predictions only.")}</p><div>${scoreRows}</div></section>`;
  const featureStatus = data.features || {},
    macro = data.macro?.dxy,
    training = data.training || {},
    latestRun = training.latest,
    shadow = training.shadow || {},
    comparison = training.comparison,
    candidateLocked = latestRun?.status === "shadow" && !shadow.readyForNext,
    runSummary = latestRun
      ? `${tx("候选版本", "Candidate")} #${latestRun.id} · ${latestRun.status === "shadow" ? tx("影子记分中", "shadow scoring") : latestRun.status === "failed" ? tx("训练失败", "training failed") : tx("训练中", "training")} · ${shadow.totalSettled || 0}/${(shadow.requiredPerHorizon || 30) * 4} ${tx("已结算", "settled")}`
      : tx("尚未创建候选模型", "No candidate model yet"),
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
      ? `<section class="research-ab-evaluation ${safeText(verdict?.tone || "yellow")}"><h3>${tx("A/B 自动评估 · 当前对象：BTC 多因子研究预测模型", "A/B automatic evaluation · current scope: BTC multi-factor research model")}</h3><div class="research-ab-verdict"><b>${safeText(txVerdictLabel(verdict?.label) || tx("继续影子评估", "Continue shadow scoring"))}</b><span>${safeText(txVerdictReason(verdict?.reason) || "")}</span></div><div class="research-ab-summary"><span>${tx("已配对结算", "Paired outcomes")} <b>${comparison.paired || 0}</b></span><span>${tx("总体 Brier", "Overall Brier")} <b>${metric(overallBase.brier)} → ${metric(overallCandidate.brier)}</b></span><span>${tx("总体 Log Loss", "Overall Log Loss")} <b>${metric(overallBase.logLoss)} → ${metric(overallCandidate.logLoss)}</b></span><span>${tx("成本后净收益", "Net after cost")} <b>${pct((overallBase.economic?.netReturn || 0) * 100)} → ${pct((overallCandidate.economic?.netReturn || 0) * 100)}</b></span></div><div class="research-ab-grid">${comparisonRows}</div><small>${tx("门槛：每周期 30 个配对样本；Brier 与 Log Loss 均至少优于 3%，BSS≥0，ECE 不恶化超过 5%，成本后净收益不低于现役，且已验证市场状态不显著退化。绿色仅表示建议人工复核，绝不自动切换。", "Gate: 30 paired outcomes per horizon; Brier and Log Loss each improve by 3%, BSS≥0, ECE no worse by over 5%, net after cost no lower, and no material degradation in validated regimes. Green means manual review only; it never auto-switches.")}</small></section>`
      : `<section class="research-ab-evaluation yellow"><h3>${tx("A/B 自动评估 · 当前对象：BTC 多因子研究预测模型", "A/B automatic evaluation · current scope: BTC multi-factor research model")}</h3><div class="research-ab-verdict"><b>${tx("等待候选版本", "Waiting for a candidate")}</b><span>${tx("先在 BTC 多因子研究预测卡片创建候选模型，系统才会开始同桶影子结算与自动对照。", "Create a candidate in the BTC multi-factor research card to begin paired shadow settlement and automatic comparison.")}</span></div></section>`,
    governance = `<section class="research-governance"><h3>${tx("特征与训练治理", "Feature & training governance")}</h3><div><span>${tx("OFI 快照", "OFI snapshots")} <b>${featureStatus.ofiSnapshots || 0}</b><small>${featureStatus.readyForTraining ? tx("达到最低历史门槛", "history threshold met") : tx("采集中，未进入训练", "collecting; excluded from training")}</small></span><span>DXY <b>${macro ? macro.value.toFixed(3) : "--"}</b><small>${tx("仅作环境展示，待时序对齐验证", "context only; awaiting aligned validation")}</small></span><span>${tx("新闻", "News")} <b>${tx("事件分类 + 时间衰减", "event + decay")}</b><small>${tx("无预期数据时不计算“意外度”", "no surprise factor without consensus data")}</small></span></div><div class="research-training-status"><b>${runSummary}</b><small>${safeText(shadow.reason || tx("训练候选模型后会并行记录结果，达到门槛后仍需人工决定是否切换。", "Candidate outcomes are recorded in parallel; reaching the threshold still requires a manual switch decision."))}</small></div></section>`;
  const abCenterHeader = `<div class="ab-center-head"><h2>${tx("A/B 实验中心", "A/B experiment center")}</h2><p>${tx("A 版为网页上方冻结的现役版本；B 版仅在后台同桶记录、到期后用同一真实价格结算。绿色只表示建议人工复核，系统绝不自动替换现役版本。描述/公式型模块改验算一致性、偏差或覆盖率，不输出“准确率”。", "A is the frozen live version shown above. B is recorded only in the background from the same bucket and settled against the same realised price. Green only means manual review; the system never replaces A automatically. Descriptive/formula modules validate consistency, bias, or coverage rather than accuracy.")}</p><div id="abExperimentRegistry" class="ab-experiment-registry"><span><b>${tx("正在读取各板块影子实验…", "Loading module shadow experiments…")}</b></span></div></div>`;
  card.innerHTML = `<div class="research-outlook-head"><div><h2>${tx("BTC 多因子研究预测", "BTC multi-factor research outlook")}</h2><p>${tx("软加权历史近邻数据模型融合历史状态、近 24 小时公开 BTC 新闻情绪与 OKX 市场结构；结果为条件概率与价格区间，不是买卖建议。", "A soft-weighted historical-neighbor data model combines historical states, recent public BTC news sentiment, and OKX market structure. Results are conditional probabilities and price ranges, not buy/sell advice.")}</p></div><div class="research-actions"><button type="button" id="refreshResearchOutlook">${tx("更新研究", "Refresh research")}</button><button type="button" id="trainResearchCandidate" ${training.inProgress || candidateLocked ? "disabled" : ""}>${trainLabel}</button></div></div>${eventBanner}<div class="research-outlook-summary"><span>${tx("新闻情绪", "News sentiment")}：<b class="bull">${news.bullish || 0} ${tx("利好", "positive")}</b> · <b class="bear">${news.bearish || 0} ${tx("利空", "negative")}</b> · <b class="flat">${news.neutral || 0} ${tx("中性", "neutral")}</b> · ${tx("半衰期", "half-life")} ${news.halfLifeHours || 4}h</span><span>${tx("情绪指数", "Fear & Greed")}：<b>${Number.isFinite(sentiment?.value) ? `${sentiment.value}/100` : "--"}</b></span><span>${tx("中性阈值", "Neutral band")}：44–56%</span><span>${tx("样本", "Samples")}：15m ${history.intradaySamples || 0} · 1d ${history.dailySamples || 0}</span></div><div class="research-window-grid">${windows}</div>${derivativeSummary}<div class="research-news"><h3>${tx("近期 BTC 重点新闻（可点击查看原文）", "Priority BTC headlines (click to open)")}</h3><ul>${headlineRows}</ul></div><footer>${tx("更新时间", "Updated")} ${researchAge(data.fetchedAt)} · ${safeText(news.source || "")} · ${tx("新闻优先按利好/利空影响排序，并采用标题相似度去重、信源与事件权重、4 小时时间衰减；仍需自行核验其真实性与影响。", "Headlines prioritize positive/negative impact, with similarity dedupe, source/event weights, and a 4-hour time decay; verify accuracy and impact independently.")}</footer>`;
  const legacyNews = card.querySelector(".research-news");
  if (legacyNews) legacyNews.outerHTML = newsPanel;
  card
    .querySelector(".research-derivatives")
    ?.insertAdjacentHTML("afterend", scorecardPanel + governance);
  let abCard = $("abEvaluationCard");
  if (!abCard) {
    abCard = document.createElement("section");
    abCard.id = "abEvaluationCard";
    abCard.className = "card research-ab-evaluation-card";
  }
  const main = document.querySelector("main"),
    footer = main?.querySelector(":scope>footer");
  if (main) {
    if (footer) main.insertBefore(abCard, footer);
    else main.append(abCard);
  }
  abCard.innerHTML = abCenterHeader + abPanel;
  card
    .querySelector("#refreshResearchOutlook")
    ?.addEventListener("click", () => loadResearchOutlook(true));
  card
    .querySelector("#trainResearchCandidate")
    ?.addEventListener("click", trainResearchCandidate);
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
async function loadResearchOutlook(force = false) {
  if (researchOutlookLoading) return;
  researchOutlookLoading = true;
  const card = ensureResearchOutlookCard();
  if (card && !card.innerHTML)
    card.innerHTML = `<div class="research-outlook-head"><div><h2>${tx("BTC 多因子研究预测", "BTC multi-factor research outlook")}</h2><p>${tx("正在读取历史样本、公开新闻与市场结构…", "Reading history samples, public news, and market structure…")}</p></div></div>`;
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
      card.innerHTML = `<div class="research-outlook-head"><div><h2>${tx("BTC 多因子研究预测", "BTC multi-factor research outlook")}</h2><p class="bear">${tx("研究数据暂不可用：", "Research data unavailable: ")}${safeText(error.message)}</p></div><button type="button" id="refreshResearchOutlook">${tx("重试", "Retry")}</button></div>`;
    card
      ?.querySelector("#refreshResearchOutlook")
      ?.addEventListener("click", () => loadResearchOutlook(true));
  } finally {
    researchOutlookLoading = false;
  }
}
function renderAbExperimentRegistry(payload) {
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
      ".optional",
      () =>
        tx(
          `${selectedSource()} 多周期 K 线 · 每 10 秒`,
          `${selectedSource()} multi-horizon candles · every 10s`,
        ),
    ],
    [
      ".correlation-card",
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
      (text.startsWith("最高选中价") ||
        text.startsWith("最低选中价") ||
        text.startsWith("Highest selected price") ||
        text.startsWith("Lowest selected price"))
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

/* Local-only personal notifications. Each browser keeps its own SendKey and
   rules in localStorage; the website server never receives either value. */
(() => {
  const main = document.querySelector("main");
  if (!main) return;
  const sendKeyStorage = "btc_local_serverchan_sendkey_v1",
    rulesStorage = "btc_local_notification_rules_v1";
  localStorage.removeItem(sendKeyStorage);
  let lastPrice = null,
    rules = [];
  try {
    const saved = JSON.parse(localStorage.getItem(rulesStorage) || "[]");
    if (Array.isArray(saved))
      rules = saved
        .filter(
          (row) =>
            row && typeof row.id === "string" && Number(row.targetPrice) > 0,
        )
        .slice(0, 30);
  } catch {}
  const saveRules = () =>
    localStorage.setItem(rulesStorage, JSON.stringify(rules));
  const card = document.createElement("section");
  card.id = "wechatAlertCard";
  card.className = "card wechat-alert-card";
  card.innerHTML = `<div class="forecast-head"><div><h2>${tx("消息推送", "Message alerts")}</h2><p>${tx("SendKey 与规则仅保存在当前浏览器；本站服务器不会接收或保存。页面需保持打开才能监测并推送。", "The SendKey and rules stay only in this browser; this server never receives or stores them. Keep this page open for monitoring and delivery.")}</p></div><span id="wechatAlertState" class="badge flat"></span></div><form id="wechatKeyForm" class="wechat-key-form"><label>${tx("Server酱 SendKey", "ServerChan SendKey")}<input name="sendKey" type="password" autocomplete="off" placeholder="SCT…"></label><a href="https://sct.ftqq.com/sendkey" target="_blank" rel="noopener">${tx("获取 SendKey", "Get SendKey")}</a><button type="submit">${tx("仅保存到本机", "Save locally only")}</button><button type="button" id="testLocalSendKey">${tx("测试推送", "Test push")}</button><button type="button" id="clearLocalSendKey" class="danger">${tx("清除本机 Key", "Clear local Key")}</button></form><form id="wechatAlertForm" class="wechat-alert-form"><label>${tx("触发类型", "Trigger")}<select name="kind"><option value="price_above">${tx("上涨到指定价", "Rises to target")}</option><option value="price_below">${tx("下跌到指定价", "Falls to target")}</option><option value="long_liquidation">${tx("多头爆仓价", "Long liquidation")}</option><option value="short_liquidation">${tx("空头爆仓价", "Short liquidation")}</option></select></label><label>${tx("触发价格（USDT）", "Target price (USDT)")}<input name="targetPrice" type="number" inputmode="decimal" min="0" step="0.01" required placeholder="80000"></label><label>${tx("触发冷却（分钟）", "Cooldown (minutes)")}<input name="cooldownMinutes" type="number" inputmode="numeric" min="0" step="1" value="0" required><small>${tx("0 = 不限制", "0 = no limit")}</small></label><button type="submit">${tx("添加推送规则", "Add alert rule")}</button></form><div id="wechatAlertDetail" class="wechat-alert-detail"></div>`;
  const footer = main.querySelector("footer");
  if (footer) main.insertBefore(card, footer);
  else main.append(card);
  const form = $("wechatAlertForm"),
    keyForm = $("wechatKeyForm"),
    stateEl = $("wechatAlertState"),
    detail = $("wechatAlertDetail"),
    keyInput = keyForm.elements.sendKey;
  keyInput.value = sessionStorage.getItem(sendKeyStorage) || "";
  const kindName = (kind) =>
    ({
      price_above: tx("上涨到指定价", "Rises to target"),
      price_below: tx("下跌到指定价", "Falls to target"),
      long_liquidation: tx("多头爆仓价", "Long liquidation"),
      short_liquidation: tx("空头爆仓价", "Short liquidation"),
    })[kind] || kind;
  const render = () => {
    const sendKey = (sessionStorage.getItem(sendKeyStorage) || "").trim(),
      ready = /^SCT/i.test(sendKey);
    stateEl.className = `badge ${ready ? "bull" : "flat"}`;
    stateEl.textContent = ready
      ? tx("本机推送已就绪", "Local push ready")
      : tx("未填本机 Key", "No local Key");
    detail.innerHTML = `<p>${tx("当前浏览器独立保存；多用户之间不会共享 Key 或规则。冷却时间由每条规则自行设定，0 表示不限制。", "This browser stores independently; users never share Keys or rules. Each rule sets its own cooldown; 0 means no limit.")}</p><div class="notification-rule-list">${rules.length ? rules.map((row) => `<article><span><b>BTC/USDT ${tx("价格提醒", "price alert")}</b><small>${kindName(row.kind)} · $${Number(row.targetPrice).toLocaleString("en-US")} · ${tx("冷却", "Cooldown")} ${Number(row.cooldownMinutes) || 0} ${tx("分钟", "min")}</small></span><em class="bull">${tx("本机启用", "Local")}</em><button type="button" data-delete-notification="${row.id}">${tx("删除", "Delete")}</button></article>`).join("") : `<small>${tx("尚未添加规则。", "No rules yet.")}</small>`}</div>`;
    detail.querySelectorAll("[data-delete-notification]").forEach((button) =>
      button.addEventListener("click", () => {
        rules = rules.filter(
          (row) => row.id !== button.dataset.deleteNotification,
        );
        saveRules();
        render();
      }),
    );
  };
  const send = async (rule, price, { test = false } = {}) => {
    const key = (sessionStorage.getItem(sendKeyStorage) || "").trim();
    if (!/^SCT/i.test(key))
      throw new Error(
        tx("请先保存有效的本机 SendKey。", "Save a valid local SendKey first."),
      );
    const livePrice = `$${Number(price).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      title = test
        ? `BTC/USDT ${tx("测试推送", "test push")} ${livePrice}`
        : `BTC/USDT ${tx("价格提醒", "price alert")} · ${livePrice}`,
      desp = `${test ? tx("这是一条测试消息。", "This is a test message.") : `${kindName(rule.kind)} $${Number(rule.targetPrice).toLocaleString("en-US")}`}\n\n${tx("当前 OKX 永续价格：", "Current OKX perpetual price: ")}${livePrice}\n${tx("触发时间：", "Time: ")}${new Date().toLocaleString("zh-CN", { hour12: false })}`;
    const body = new URLSearchParams({ title, desp });
    try {
      await fetch(`https://sctapi.ftqq.com/${encodeURIComponent(key)}.send`, {
        method: "POST",
        mode: "no-cors",
        body,
        keepalive: true,
      });
    } catch {
      navigator.sendBeacon?.(
        `https://sctapi.ftqq.com/${encodeURIComponent(key)}.send`,
        body,
      );
    }
  };
  const check = () => {
    const price = state?.ticker?.last;
    if (!Number.isFinite(price)) {
      return;
    }
    if (lastPrice === null) {
      lastPrice = price;
      return;
    }
    const now = Date.now();
    for (const rule of rules) {
      const up =
          rule.kind === "price_above" || rule.kind === "short_liquidation",
        crossed = up
          ? lastPrice < rule.targetPrice && price >= rule.targetPrice
          : lastPrice > rule.targetPrice && price <= rule.targetPrice,
        ruleCooldown = Math.max(0, Number(rule.cooldownMinutes) || 0) * 60_000;
      if (
        crossed &&
        (!ruleCooldown ||
          !rule.lastTriggeredAt ||
          now - rule.lastTriggeredAt >= ruleCooldown)
      ) {
        rule.lastTriggeredAt = now;
        saveRules();
        send(rule, price).catch(() => {});
      }
    }
    lastPrice = price;
  };
  keyForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const key = keyInput.value.trim();
    if (key && !/^SCT/i.test(key)) {
      alert(
        tx(
          "请输入以 SCT 开头的 Server酱 Turbo SendKey。",
          "Enter a ServerChan Turbo SendKey beginning with SCT.",
        ),
      );
      return;
    }
    if (key) sessionStorage.setItem(sendKeyStorage, key);
    else sessionStorage.removeItem(sendKeyStorage);
    render();
  });
  $("clearLocalSendKey").addEventListener("click", () => {
    sessionStorage.removeItem(sendKeyStorage);
    keyInput.value = "";
    render();
  });
  $("testLocalSendKey").addEventListener("click", async () => {
    const price = state?.ticker?.last;
    if (!Number.isFinite(price)) {
      alert(
        tx(
          "实时价格尚未加载，请稍后重试。",
          "Live price is not loaded yet. Try again shortly.",
        ),
      );
      return;
    }
    try {
      await send(null, price, { test: true });
      alert(
        tx(
          "测试推送请求已发送，请查看微信。浏览器无法读取跨站送达回执。",
          "Test push request sent. Check WeChat; the browser cannot read cross-site delivery receipts.",
        ),
      );
    } catch (error) {
      alert(error.message);
    }
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const targetPrice = Number(form.elements.targetPrice.value),
      cooldownMinutes = Math.max(
        0,
        Number(form.elements.cooldownMinutes.value) || 0,
      );
    if (
      !Number.isFinite(targetPrice) ||
      targetPrice <= 0 ||
      !Number.isFinite(cooldownMinutes)
    ) {
      return;
    }
    rules.push({
      id: crypto.randomUUID(),
      kind: form.elements.kind.value,
      targetPrice,
      cooldownMinutes,
      lastTriggeredAt: null,
    });
    saveRules();
    form.reset();
    form.elements.cooldownMinutes.value = "0";
    render();
  });
  return; // Replaced below by the modal-style local alert composer.
})();

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
      coinbase: tx("Coinbase BTC-PERP 永续", "Coinbase BTC-PERP perpetual"),
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
  localStorage.setItem("btc_position_state", JSON.stringify(positionState));
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
  /* 做多 / 做空持仓价的本地记录（用户每次确认持仓或改开仓均价时更新）。 */
  const ENTRY_BOOK_KEY = "btc_position_entry_book";
  /* 日线样本少于这个根数时不展示长周期窗口，避免用十几个样本凑出一个假概率。 */
  const MIN_DAILY_SAMPLES = 200;
  const MIRRORED_FIELDS = ["exchange", "side", "amount", "leverage", "entry"];

  function readEntryBook() {
    try {
      const raw = JSON.parse(localStorage.getItem(ENTRY_BOOK_KEY) || "{}");
      return {
        long: Number(raw.long) > 0 ? Number(raw.long) : null,
        short: Number(raw.short) > 0 ? Number(raw.short) : null,
      };
    } catch {
      return { long: null, short: null };
    }
  }
  let entryBook = readEntryBook();
  function saveEntryBook() {
    try {
      localStorage.setItem(ENTRY_BOOK_KEY, JSON.stringify(entryBook));
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
    if (liqDailyCandles.length < MIN_DAILY_SAMPLES && attempt < 3) {
      setTimeout(() => loadDailyHistory(attempt + 1), 4_000);
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
    localStorage.setItem("btc_position_state", JSON.stringify(positionState));
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

  /* 顶部两张持仓卡一改动就刷新浮层与本地记录，菜单里不再出现旧值。 */
  window.addEventListener("btc:personal-entries-changed", () => {
    refreshEntryBookFromSlots();
    syncEntryMenu();
  });

  function boot() {
    if (installActions()) loadDailyHistory();
  }
  setTimeout(boot, 0);
  setTimeout(boot, 600);
})();
