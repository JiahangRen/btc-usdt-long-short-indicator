const $ = (id) => document.getElementById(id);
/* Use the application's dialog style instead of browser-native prompts. */
function showAppDialog({
  title = "提示",
  message = "",
  confirmText = "我知道了",
  cancelText = "",
  onConfirm,
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
  };
  modal.querySelector("header b").textContent = title;
  modal.querySelector(".notice-body p").textContent = String(message);
  const cancel = modal.querySelector(".app-dialog-cancel"),
    confirm = modal.querySelector(".app-dialog-confirm");
  cancel.hidden = !cancelText;
  cancel.textContent = cancelText;
  confirm.textContent = confirmText;
  modal._onConfirm = onConfirm || null;
  modal.querySelector("header button").onclick = close;
  cancel.onclick = close;
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
  ticker: null,
  lastGood: null,
  loading: false,
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
function metrics(data) {
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
  let score = 0;
  score += e20[i] > e50[i] ? 25 : -25;
  score += closes[i] > e50[i] ? 20 : -20;
  score += Number.isFinite(e200[i]) ? (closes[i] > e200[i] ? 20 : -20) : 0;
  score += Math.max(-15, Math.min(15, (macd / (closes[i] * 0.0015)) * 15));
  score += Math.max(-10, Math.min(10, (rs[i] - 50) / 2.5));
  score += Math.max(-10, Math.min(10, (bb - 0.5) * 20));
  return {
    close: closes[i],
    e20: e20[i],
    e50: e50[i],
    e200: e200[i],
    rsi: rs[i],
    atr: at[i],
    macd,
    bb,
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
  $("open24").textContent = money(t.open24h);
  $("highlow").textContent = `${money(t.high24)} / ${money(t.low24)}`;
  $("sourceUsed").textContent = state.lastGood.source;
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
    [label, cls] = classification(m.score),
    direction = m.score >= 0 ? "做多" : "做空",
    strength = Math.min(100, Math.abs(m.score));
  $("signal").textContent =
    `${label} ${m.score > 0 ? "+" : ""}${m.score.toFixed(2)}`;
  $("signal").className = `signal ${cls}`;
  $("signalReason").innerHTML =
    `<span>EMA20 ${money(m.e20)} · EMA50 ${money(m.e50)} · RSI(14) ${m.rsi.toFixed(2)} · MACD ${m.macd.toFixed(2)}</span><div class="signal-gauge"><div class="gauge-top"><b>做空 −100.00</b><span>当前：${direction} ${m.score > 0 ? "+" : ""}${m.score.toFixed(2)}</span><b>做多 +100.00</b></div><div class="gauge-track"><i style="left:${(m.score + 100) / 2}%"></i></div><div class="gauge-strength"><em style="width:${strength}%"></em><span>信号强度：${strength.toFixed(2)}</span></div></div><small>基于当前 K 线的确定性规则打分，不是机器学习预测。</small>`;
  $("sl").textContent = money(m.close - m.atr * 1.5);
  $("tp").textContent = money(m.close + m.atr * 3);
  const rows = [
    ["EMA20", money(m.e20), m.close >= m.e20 ? "看多" : "看空"],
    ["EMA50", money(m.e50), m.close >= m.e50 ? "看多" : "看空"],
    [
      "EMA200",
      money(m.e200),
      Number.isFinite(m.e200) && m.close >= m.e200 ? "看多" : "中性",
    ],
    [
      "RSI(14)",
      m.rsi.toFixed(2),
      m.rsi > 55 ? "看多" : m.rsi < 45 ? "看空" : "中性",
    ],
    [
      "布林位置",
      (m.bb * 100).toFixed(2) + "%",
      m.bb > 0.6 ? "看多" : m.bb < 0.4 ? "看空" : "中性",
    ],
    ["ATR(14)", money(m.atr), "中性"],
  ];
  $("indicators").innerHTML = rows
    .map(
      ([k, v, tag]) =>
        `<div class="metric"><span>${k}</span><b>${v}</b><i class="badge ${tag === "看多" ? "bull" : tag === "看空" ? "bear" : "flat"}">${tag}</i></div>`,
    )
    .join("");
  const tags = [
    ["5分", 20],
    ["15分", 60],
    ["1时", 240],
    ["4时", 960],
    ["1日", Math.min(1439, state.candles.length - 1)],
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
      chartSelection = null;
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
  side.append(changes);
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
      changes = $("periodChangeCard");
    if (!layout || !side || !chart || !signal || !indicators || !changes)
      return;
    if (query.matches) {
      layout.classList.add("mobile-reading-layout");
      layout.replaceChildren(signal, chart, changes, side);
      side.hidden = true;
      layout.after(indicators);
    } else {
      side.hidden = false;
      side.replaceChildren(signal, indicators);
      layout.classList.remove("mobile-reading-layout");
      layout.replaceChildren(chart, side, changes);
    }
    draw();
  }
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
    coverage.textContent = `${state.range ? `${rangePrefix} ${state.range}` : `${intervalPrefix} ${state.interval}`} · ${raw}`;
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
        ? Math.min(8, state.zoom * 1.5)
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
    '<div class="forecast-head leverage-head"><div><h2>高杠杆强平缓冲参考</h2><p>逐仓近似演示；实际强平以标记价格、仓位档位、费用和保证金模式为准。</p></div><div class="leverage-controls"><label class="leverage-exchange">交易所 <select id="leverageExchange"><option value="binance">Binance</option><option value="okx">OKX</option><option value="coinbase">Coinbase</option></select></label></div></div><p id="leverageMethod" class="leverage-method">正在根据近期震荡幅度计算缓冲…</p><div id="leverageGrid" class="leverage-grid"></div>';
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
  localStorage.setItem("btc_theme", themeMode);
  const b = $("themeToggle");
  if (b)
    b.textContent = `◐ ${locale().theme[["auto", "light", "dark"].indexOf(themeMode)]}`;
}
function syncFullscreenButton() {
  const b = $("fullscreenToggle");
  if (!b) return;
  const active = !!(
      document.fullscreenElement || document.webkitFullscreenElement
    ),
    label = active ? locale().exitFullscreen : locale().fullscreen;
  b.textContent = active ? "⤢ " + label : "⛶ " + label;
  b.title = label;
  b.setAttribute("aria-label", label);
  b.setAttribute("aria-pressed", String(active));
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
  if (b) b.textContent = `⌗ ${uiLang === "zh" ? "EN" : "中文"}`;
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
  controls.append(lang, fullscreen, theme);
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
  setInterval(loadUsEquityStrip, 10_000);
})();

/* 交互、说明与完整语言层 / Interaction, explanations, and complete language layer */
let chartSelection = null,
  requestLatency = 0;
const tx = (zh, en) => (uiLang === "zh" ? zh : en);
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
  tip.textContent = text;
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
  $("open24").textContent = money(t.open24h);
  $("highlow").textContent = `${money(t.high24)} / ${money(t.low24)}`;
  $("sourceUsed").textContent = state.lastGood.source;
};
loadCurrent = async function () {
  if (state.loading) return;
  state.loading = true;
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
    const r = await apiFetch("/api/market?" + q);
    const data = await r.json();
    if (!r.ok) throw data;
    requestLatency = Math.round(performance.now() - started);
    state.candles = data.candles;
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
  } finally {
    state.loading = false;
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
        chartSelection = null;
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
        chartSelection = null;
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
  if (b) b.textContent = `⌗ ${uiLang === "zh" ? "EN" : "中文"}`;
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
  cv.addEventListener("dblclick", () => {
    chartSelection = null;
    const el = $("selectionStats");
    if (el)
      el.textContent = tx(
        "拖拽图表可框选区段，显示最高、最低及涨跌幅。",
        "Drag on chart to select a period: high, low and return.",
      );
    draw();
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
  const clearHover = () => {
    chartPaused = false;
    frozenCandles = null;
    hoverIndex = null;
    chartSelection = null;
    const stat = $("selectionStats");
    if (stat)
      stat.textContent = tx(
        "拖拽图表可框选区段，显示时间段、最高、最低及涨跌幅。",
        "Drag on chart to select a time span, high, low and return.",
      );
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
  const save = () => localStorage.setItem(ruleStore, JSON.stringify(rules)),
    price = () => state?.ticker?.last,
    fmt = (n) =>
      Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 });
  const card = document.createElement("section");
  card.id = "wechatAlertCard";
  card.className = "card wechat-alert-card";
  card.innerHTML = `<div class="forecast-head"><div><h2>${tx("消息推送", "Message alerts")}</h2><p id="localAlertDescription">${tx("未登录时，SendKey 与规则只保存在本机浏览器；登录后可保存到云端。", "When signed out, the SendKey and rules stay in this browser; sign in to save them to the cloud.")}</p></div><span id="localAlertState" class="badge flat"></span></div><form id="localKeyForm" class="wechat-key-form"><label>Server酱 SendKey<input name="key" type="password" autocomplete="off" placeholder="SCT…"></label><a href="https://sct.ftqq.com/sendkey" target="_blank" rel="noopener">${tx("获取 SendKey", "Get SendKey")}</a><button id="localKeySave">${tx("仅保存到本机", "Save locally only")}</button><button type="button" id="localAlertTest">${tx("测试当前市价", "Test current price")}</button><button type="button" id="localAlertClear" class="danger">${tx("清除本机 Key", "Clear local Key")}</button></form><div class="alert-rule-toolbar"><b>₿ BTCUSDT ${tx("永续", "Perpetual")}</b><div><button type="button" id="clearLocalAlerts" class="danger">${tx("批量全删", "Delete all")}</button><button type="button" id="openLocalAlert">＋ ${tx("添加预警", "Add alert")}</button></div></div><div id="localAlertList" class="wechat-alert-detail"></div><div id="localAlertModal" class="alert-composer" hidden><section><header><b>${tx("添加预警", "Add alert")}</b><button type="button" id="closeLocalAlert">×</button></header><p class="alert-symbol">₿ <b>BTCUSDT ${tx("永续", "Perpetual")}</b></p><form id="localAlertForm"><label>${tx("预警类型", "Alert type")}<select name="kind"><option value="price_reached">${tx("价格达到", "Price reached")}</option><option value="price_above">${tx("价格上涨至", "Price rises to")}</option><option value="price_below">${tx("价格下跌至", "Price falls to")}</option><option value="long_liquidation">${tx("多头爆仓价", "Long liquidation")}</option><option value="short_liquidation">${tx("空头爆仓价", "Short liquidation")}</option></select></label><label>${tx("价格", "Price")}<span class="mark-price">${tx("市价", "Mark")} <button type="button" id="useLocalMark">--</button></span><input name="target" type="number" inputmode="decimal" min="0" step="0.01" required placeholder="80000"><em>USDT</em></label><div class="frequency"><b>${tx("频率", "Frequency")}</b><div><button type="button" data-local-frequency="once" class="active">${tx("仅提醒一次", "Once")}</button><button type="button" data-local-frequency="repeat">${tx("重复提醒", "Repeat")}</button></div></div><label id="localCooldown" hidden>${tx("冷却时间（分钟）", "Cooldown (minutes)")}<input name="cooldown" type="number" inputmode="numeric" min="1" step="1" value="5"></label><label class="voice-rule-option"><input name="voiceEnabled" type="checkbox" checked>${tx("触发时语音播报", "Speak when triggered")}</label><button class="alert-submit">${tx("添加", "Add")}</button></form></section></div>`;
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
  (main.querySelector("footer") || main.lastElementChild).before(card);
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
  keyInput.value = localStorage.getItem(keyStore) || "";
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
      price_reached: "价格达到",
      price_above: "价格上涨至",
      price_below: "价格下跌至",
      long_liquidation: "多头爆仓价",
      short_liquidation: "空头爆仓价",
    })[kind] || kind;
  const alertCategory = (kind) =>
    kind === "long_liquidation" || kind === "short_liquidation"
      ? "爆仓告警"
      : "价格告警";
  const alertPhrase = (kind, price) =>
    ({
      price_reached: `BTC价格达到 ${price}`,
      price_above: `BTC价格上涨至 ${price}`,
      price_below: `BTC价格下跌至 ${price}`,
      long_liquidation: `BTC价格接近多头爆仓价 ${price}`,
      short_liquidation: `BTC价格接近空头爆仓价 ${price}`,
    })[kind] || `BTC价格 ${price}`;
  const alertTitle = (kind, target, { test = false } = {}) => {
    const phrase = alertPhrase(kind, target);
    if (test) return `${alertCategory(kind)}【测试】 ${phrase}`;
    return kind === "long_liquidation" || kind === "short_liquidation"
      ? `【爆仓】${phrase.replace(/^BTC价格/, "")}`
      : `【价格】${phrase}`;
  };
  const triggerText = (rule) =>
    rule.lastTriggeredAt
      ? `${new Date(rule.lastTriggeredAt).toLocaleString("zh-CN", { hour12: false })} · 实时 ${Number.isFinite(Number(rule.lastTriggeredPrice)) ? `${fmt(rule.lastTriggeredPrice)} USDT` : "--"}`
      : "";
  const render = () => {
    const ready = /^SCT/i.test((localStorage.getItem(keyStore) || "").trim()),
      cloudCount = rules.filter((r) => r.cloudManaged).length,
      localCount = rules.length - cloudCount,
      cloudReady = cloudSession.loggedIn && cloudSession.hasSendKey;
    stateEl.className = `badge ${cloudCount || ready || cloudReady ? "bull" : "flat"}`;
    stateEl.textContent = cloudSession.loggedIn
      ? cloudReady
        ? `云端接管 ${cloudCount} 条`
        : "云端待配置 Key"
      : ready
        ? "本机推送已就绪"
        : "未填本机 Key";
    description.textContent = cloudSession.loggedIn
      ? "已登录：当前 SendKey 会加密保存到云端；云端规则会在网页关闭后继续监测并推送。"
      : "未登录时，SendKey 与规则只保存在本机浏览器；登录后可保存到云端。";
    saveKeyButton.textContent = cloudSession.loggedIn
      ? "保存到云端"
      : "仅保存到本机";
    testButton.textContent = cloudSession.loggedIn
      ? "测试云端推送"
      : "测试当前市价";
    clearKeyButton.textContent = cloudSession.loggedIn
      ? "清空输入"
      : "清除本机 Key";
    const summary = cloudCount
      ? `<p><b>云端已接管 ${cloudCount} 条规则</b>：由服务器后台持续监测，网页关闭后仍会推送。${localCount ? `其余 ${localCount} 条为本地触发，页面关闭后停止。` : "当前没有本地触发规则。"}</p>`
      : "<p>当前浏览器独立保存；页面保持打开时才会监测。</p>";
    list.innerHTML = `${summary}<div class="notification-rule-list">${
      rules.length
        ? rules
            .map((r) => {
              const cloudManaged = Boolean(r.cloudManaged),
                triggered =
                  !cloudManaged && r.repeat === false && r.lastTriggeredAt;
              return `<article class="${cloudManaged ? "cloud-managed-rule" : ""}"><span><b>→ BTC-USDT 价格预警</b><small>${label(r.kind)} ${fmt(r.targetPrice)} · ${r.repeat === false ? "仅提醒一次" : `重复提醒 · ${r.cooldownMinutes} 分钟冷却`}</small>${triggered ? `<small class="notification-triggered">已触发执行：${triggerText(r)}</small>` : ""}</span><em class="${cloudManaged ? "cloud-managed" : triggered ? "flat" : "bull"}">${cloudManaged ? "云端接管" : triggered ? "已执行" : "本地触发"}</em><button type="button" data-remove-local-alert="${r.id}">删除</button></article>`;
            })
            .join("")
        : "<small>尚未添加预警。</small>"
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
    const key = (localStorage.getItem(keyStore) || "").trim();
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
    const key = (localStorage.getItem(keyStore) || "").trim();
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
        window.dispatchEvent(new Event("btc:cloud-refresh"));
        showAppDialog({
          title: "云端推送",
          message: "SendKey 已加密保存到云端。",
        });
      } else {
        localStorage.setItem(keyStore, key);
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
    localStorage.removeItem(keyStore);
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
  window.addEventListener("btc:cloud-rules-synced", () => {
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
    render();
  });
  window.addEventListener("btc:account-state", (event) => {
    cloudSession = {
      loggedIn: Boolean(event.detail?.loggedIn),
      hasSendKey: Boolean(event.detail?.hasSendKey),
    };
    render();
  });
  render();
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
  const save = () => localStorage.setItem(store, JSON.stringify(settings));
  let voices = [],
    audioContext = null,
    currentAudio = null;
  const volume = (value) => {
    const normalized = Math.max(0, Math.min(1, Number(value) / 100));
    return normalized * normalized;
  };
  const playChime = () => {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return 0;
    audioContext ||= new Context();
    audioContext.resume?.().catch(() => {});
    const preset = {
        station: { notes: [523.25, 659.25, 783.99], wave: "sine", gap: 0.15 },
        airport: { notes: [880, 1046.5, 1318.5], wave: "sine", gap: 0.13 },
        gentle: { notes: [392, 493.88, 587.33], wave: "triangle", gap: 0.2 },
        alert: { notes: [740, 740, 988, 988], wave: "square", gap: 0.11 },
      }[settings.chimeType] || {
        notes: [523.25, 659.25, 783.99],
        wave: "sine",
        gap: 0.15,
      },
      level = Math.max(0, Math.min(2, Number(settings.chimeVolume) / 100)),
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
  const saySystem = (text) => {
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
    window.speechSynthesis.speak(utterance);
    return true;
  };
  const sayEdge = async (text) => {
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
    audio.onended = () => {
      URL.revokeObjectURL(audio.src);
    };
    await audio.play();
    return true;
  };
  const say = (text, { onStarted, onFailure } = {}) => {
    if (!settings.enabled) return false;
    // Edge TTS does not depend on the browser's system speech API.  Some
    // embedded browsers omit speechSynthesis entirely, so only touch it when
    // it exists; otherwise the exception prevented the Edge request as well.
    if (supported) window.speechSynthesis.cancel();
    currentAudio?.pause();
    const delay = playChime();
    window.setTimeout(() => {
      const started = () => onStarted?.();
      if (settings.engine === "edge") {
        sayEdge(text)
          .then(started)
          .catch((error) => {
            if (saySystem(text)) started();
            else onFailure?.(error);
          });
      } else if (saySystem(text)) started();
      else onFailure?.(new Error("System speech is unavailable"));
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
        sideZh = isShort ? "做空" : "做多",
        sideEn = isShort ? "Short" : "Long",
        labelZh = isShort ? "做空买入价" : "做多买入价",
        labelEn = isShort ? "short entry price" : "long entry price";
      return uiLang === "zh"
        ? `相对${labelZh} ${entryPrice.toLocaleString("en-US", { maximumFractionDigits: 2 })}，现价${priceUp ? "上涨" : "下跌"} ${amount}，${priceUp ? "涨幅" : "跌幅"} ${percent}%。差价 ${amount} 美元。${sideZh}${inProfit ? "盈利中" : "亏损中"}。`
        : `Compared with your ${labelEn} of ${entryPrice.toLocaleString("en-US", { maximumFractionDigits: 2 })}, price is ${priceUp ? "up" : "down"} ${amount}, a ${priceUp ? "gain" : "drop"} of ${percent} percent. The price difference is ${amount} USD. ${sideEn} ${inProfit ? "profit" : "loss"} is ${amount} USD.`;
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
  priceCard.append(trigger);
  const settingsModal = document.createElement("div");
  settingsModal.id = "voiceSettingsModal";
  settingsModal.className = "alert-composer voice-settings-modal";
  settingsModal.hidden = true;
  settingsModal.innerHTML = `<section role="dialog" aria-modal="true" aria-labelledby="voiceSettingsTitle"><header><b id="voiceSettingsTitle">${tx("语音播报设置", "Voice alert settings")}</b><button type="button" aria-label="${tx("关闭", "Close")}" data-close-voice-settings>×</button></header><div class="voice-settings-body"></div></section>`;
  document.body.append(settingsModal);
  const settingsBody = settingsModal.querySelector(".voice-settings-body");
  const panel = document.createElement("section");
  panel.className = "voice-alert-panel";
  panel.innerHTML = `<div class="voice-panel-head"><div><b>${tx("语音播报", "Voice alerts")}</b><small id="voiceAlertStatus"></small></div></div><div class="voice-panel-grid"><section class="voice-panel-group voice-panel-toggles"><label class="voice-switch"><input id="voiceAlertEnabled" type="checkbox"><span>${tx("语音总开关", "Voice master")}</span></label><label class="voice-switch"><input id="voiceLivePriceEnabled" type="checkbox"><span>${tx("定时播报实时价", "Speak live price")}</span></label><label class="voice-live-interval">${tx("播报间隔", "Interval")}<select id="voiceAlertInterval"><option value="15">15 ${tx("秒", "sec")}</option><option value="30">30 ${tx("秒", "sec")}</option><option value="60">1 ${tx("分钟", "min")}</option><option value="300">5 ${tx("分钟", "min")}</option></select></label></section><section class="voice-panel-group"><label>${tx("播报引擎", "Engine")}<select id="voiceAlertEngine"><option value="edge">Edge 神经语音（免费）</option><option value="system">本机系统语音</option></select></label><label>${tx("音色", "Voice")}<select id="voiceAlertEdgeVoice"><optgroup label="自然女声"><option value="zh-CN-XiaoxiaoNeural">小晓 · 普通话</option><option value="zh-CN-XiaoyiNeural">小艺 · 普通话</option><option value="zh-CN-liaoning-XiaobeiNeural">小北 · 辽宁口音</option><option value="zh-CN-shaanxi-XiaoniNeural">小妮 · 陕西口音</option><option value="zh-TW-HsiaoChenNeural">晓臻 · 台湾国语</option><option value="zh-HK-HiuGaaiNeural">晓佳 · 粤语</option></optgroup><optgroup label="自然男声"><option value="zh-CN-YunxiNeural">云希 · 普通话</option><option value="zh-CN-YunyangNeural">云扬 · 普通话</option></optgroup></select></label><label class="system-voice-label">${tx("系统回退", "System fallback")}<select id="voiceAlertVoice"><option>${tx("正在加载系统语音…", "Loading system voices…")}</option></select></label><label>${tx("提示音音量", "Chime volume")}<span class="voice-volume-row"><input id="voiceChimeVolume" type="range" min="0" max="100" step="1"><output id="voiceChimeVolumeValue"></output></span></label><label>${tx("语音音量", "Speech volume")}<span class="voice-volume-row"><input id="voiceSpeechVolume" type="range" min="0" max="100" step="1"><output id="voiceSpeechVolumeValue"></output></span></label></section><section class="voice-panel-group voice-panel-actions"><button type="button" id="voiceAlertAddRule">＋ ${tx("配置语音规则", "Voice rules")}</button><button type="button" id="voiceAlertTest">${tx("试听", "Test voice")}</button></section></div><small class="voice-rule-note">${tx("语音规则支持价格达到、上涨、下跌及爆仓价；在“添加预警”中勾选“触发时语音播报”。", "Voice rules support reached, rise, fall and liquidation prices; enable Speak when triggered in Add alert.")}</small>`;
  settingsBody.append(panel);
  const enabled = $("voiceAlertEnabled"),
    livePriceEnabled = $("voiceLivePriceEnabled"),
    engine = $("voiceAlertEngine"),
    edgeVoice = $("voiceAlertEdgeVoice"),
    interval = $("voiceAlertInterval"),
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
      "<label>" +
        tx("提示音样式", "Chime style") +
        '<select id="voiceChimeType"><option value="station">' +
        tx("车站三音", "Station three-tone") +
        '</option><option value="airport">' +
        tx("机场登机", "Airport boarding") +
        '</option><option value="gentle">' +
        tx("轻柔提示", "Gentle chime") +
        '</option><option value="alert">' +
        tx("短促提醒", "Short alert") +
        "</option></select></label>",
    );
  const chimeType = $("voiceChimeType");
  chimeType.value = settings.chimeType;
  chimeVolume.max = "200";
  interval.innerHTML = `<option value="15">15 ${tx("秒", "sec")}</option><option value="30">30 ${tx("秒", "sec")}</option><option value="60">1 ${tx("分钟", "min")}</option><option value="300">5 ${tx("分钟", "min")}</option><option value="600">10 ${tx("分钟", "min")}</option><option value="900">15 ${tx("分钟", "min")}</option><option value="1800">30 ${tx("分钟", "min")}</option><option value="3600">1 ${tx("小时", "hour")}</option>`;
  panel.querySelector(".voice-rule-note").textContent = tx(
    "语音规则独立保存，可设置价格达到、上涨或下跌后的单次／重复播报。页面打开时由浏览器播报；页面关闭后由本机服务端自动接力（需总开关开启）。重复播报的冷却下限为 30 秒。",
    "Voice rules are independent and support one-time or repeated reached, rise and fall alerts. The browser speaks while the page is open; the local server takes over after it closes (master switch on). Repeated alerts cool down at least 30 seconds.",
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
  const render = () => {
    enabled.checked = Boolean(settings.enabled);
    livePriceEnabled.checked = Boolean(settings.livePriceEnabled);
    engine.value = settings.engine;
    edgeVoice.value = settings.edgeVoice;
    interval.value = String(settings.interval);
    chimeVolume.value = String(settings.chimeVolume);
    speechVolume.value = String(settings.speechVolume);
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
    trigger.innerHTML = `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M8 25h13l18-14v42L21 39H8z"/><path class="voice-wave" d="M46 23c5 5 5 13 0 18M52 16c10 10 10 22 0 32"/>${settings.enabled ? "" : '<path class="voice-mute" d="M8 8l48 48"/>'}</svg>`;
    trigger.classList.toggle("is-muted", !settings.enabled);
    trigger.setAttribute(
      "aria-label",
      settings.enabled
        ? tx("打开语音播报设置", "Open voice alert settings")
        : tx("开启语音播报并打开设置", "Enable voice alerts and open settings"),
    );
    trigger.title = trigger.getAttribute("aria-label");
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
      if (say(priceText(current))) {
        settings.lastSpokenAt = now;
        save();
      }
    }
  };
  enabled.onchange = () => {
    settings.enabled = enabled.checked;
    settings.lastSpokenAt = 0;
    save();
    render();
    syncVoiceToServer();
  };
  livePriceEnabled.onchange = () => {
    settings.livePriceEnabled = livePriceEnabled.checked;
    settings.lastSpokenAt = 0;
    save();
    render();
    syncVoiceToServer();
    if (settings.enabled && settings.livePriceEnabled) speakPrice(true);
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
  chimeVolume.oninput = () => {
    settings.chimeVolume = Number(chimeVolume.value);
    save();
    render();
  };
  chimeType.onchange = () => {
    settings.chimeType = chimeType.value;
    save();
    render();
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
    if (open) render();
  };
  trigger.onclick = () => {
    if (!settings.enabled) {
      settings.enabled = true;
      settings.lastSpokenAt = 0;
      save();
      render();
    }
    showVoiceSettings(true);
  };
  settingsModal.querySelector("[data-close-voice-settings]").onclick = () =>
    showVoiceSettings(false);
  settingsModal.onclick = (event) => {
    if (event.target === settingsModal) showVoiceSettings(false);
  };
  test.onclick = () => {
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
          ].includes(rule.kind)
            ? rule.kind
            : "price_reached",
          direction: ["down", "both"].includes(rule.direction)
            ? rule.direction
            : "up",
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
    /* 同步给本机服务端：页面关闭（或标签页被挂起）时由服务端接力播报。 */
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
  /* 心跳：告诉服务端“页面还活着，前端负责播报”；停跳 15 秒后服务端接管。 */
  setInterval(() => {
    if (settings.enabled)
      fetch("/api/voice/heartbeat", { method: "POST" }).catch(() => {});
  }, 5_000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && settings.enabled)
      fetch("/api/voice/heartbeat", { method: "POST" }).catch(() => {});
  });
  /* 服务端触发的记录（页面关闭期间的播报）拉回来刷新列表状态。 */
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
  const voiceRuleName = (kind, direction) =>
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
    })[kind] || tx("价格达到", "Price reached");
  const voiceRuleList = document.createElement("section");
  voiceRuleList.className = "voice-rule-list";
  settingsBody.append(voiceRuleList);
  const cooldownText = (value) =>
    Number(value) === 0
      ? "不冷却"
      : Number(value) === 0.5
        ? "30 秒"
        : Number(value) + " 分钟";
  const renderVoiceRules = () => {
    const rows = voiceRules
      .map(
        (rule) =>
          "<article" +
          (!rule.repeat && rule.lastTriggeredAt ? ' class="is-done"' : "") +
          '><span><b>' +
          voiceRuleName(rule.kind, rule.direction) +
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
            ? "重复播报 · 冷却 " + cooldownText(rule.cooldownMinutes)
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
          '">语音</em><button type="button" class="rule-test" data-test-voice-rule="' +
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
        "页面打开时由浏览器播报；页面关闭后由本机服务端接力播报（需语音总开关开启）。",
        "The browser speaks while the page is open; the local server takes over after it closes (master switch on).",
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
  const voiceRuleForm = voiceRuleModal.querySelector("#voiceRuleForm"),
    voiceRuleCooldown = voiceRuleModal.querySelector("#voiceRuleCooldown"),
    voiceRuleDirection = voiceRuleModal.querySelector("#voiceRuleDirection"),
    voiceRuleWindow = voiceRuleModal.querySelector("#voiceRuleWindow"),
    voiceEntrySummary = voiceRuleModal.querySelector("#voiceEntrySummary"),
    voiceRuleTargetLabel = voiceRuleModal.querySelector(
      "#voiceRuleTargetLabel",
    ),
    voiceRuleTargetUnit = voiceRuleModal.querySelector("#voiceRuleTargetUnit"),
    voiceRuleSubmit = voiceRuleModal.querySelector(".alert-submit");
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
      .map(
        (entry) =>
          `<span class="${entry.side === "short" ? "short" : "long"}">${entry.side === "short" ? tx("做空买入价", "Short entry price") : tx("做多买入价", "Long entry price")} <b>${Number(entry.price).toLocaleString("en-US", { maximumFractionDigits: 2 })}</b></span>`,
      )
      .join("");
  };
  const useVoiceMarketPrice = () => {
    if (
      ["price_move", "price_speed", "price_tick_move"].includes(
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
      relative = move || speed || tick;
    if (relative && voiceRuleForm.elements.repeat.value === "once")
      voiceRuleForm.elements.repeat.value = "repeat";
    voiceRuleDirection.hidden = !relative;
    voiceRuleWindow.hidden = !speed;
    voiceRuleCooldown.hidden = voiceRuleForm.elements.repeat.value !== "repeat";
    voiceRuleTargetLabel.textContent = relative
      ? tx("涨跌金额", "Move amount")
      : kind.includes("liquidation")
        ? tx("爆仓价格", "Liquidation price")
        : tx("目标价格", "Target price");
    voiceRuleTargetUnit.textContent = "USDT";
    voiceRuleForm.elements.target.placeholder = speed
      ? "500"
      : relative
        ? "100"
        : kind.includes("liquidation")
          ? "75000"
          : "80000";
    voiceEntrySummary.querySelector("strong").title = relative
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
        : "up";
    if (!Number.isFinite(targetPrice) || targetPrice <= 0) return;
    const anchorPrice =
      kind === "price_move" ? Number(state?.ticker?.last) : null;
    if (kind === "price_move" && !Number.isFinite(anchorPrice)) return;
    const updated = {
      id: existing?.id || crypto.randomUUID(),
      kind,
      targetPrice,
      direction,
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
    if (rule.direction !== "both") return rule.direction;
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
  const voiceRuleMessage = (rule, current, direction) => {
    const target = Number(rule.targetPrice).toLocaleString("en-US", {
        maximumFractionDigits: 2,
      }),
      currentText = Number(current).toLocaleString("en-US", {
        maximumFractionDigits: 2,
      });
    const comparisonText = personalEntryComparisons(current).join(" ");
    let message;
    if (rule.kind === "price_tick_move")
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
  /* 规则真实触发时的可视反馈：状态文字 + 喇叭图标闪烁，避免“触发了但毫无感知”。 */
  let voiceFlashTimer = null;
  const announceVoiceTrigger = (rule) => {
    const label =
      voiceRuleName(rule.kind, rule.direction) +
      " " +
      Number(rule.targetPrice).toLocaleString("en-US", {
        maximumFractionDigits: 2,
      });
    status.textContent = tx(`已播报：${label}`, `Spoke: ${label}`);
    if (trigger) {
      trigger.classList.remove("is-speaking");
      void trigger.offsetWidth;
      trigger.classList.add("is-speaking");
    }
    clearTimeout(voiceFlashTimer);
    voiceFlashTimer = setTimeout(() => {
      trigger?.classList.remove("is-speaking");
      render();
    }, 6_000);
  };
  const testVoiceRule = (rule) => {
    const current = Number(state?.ticker?.last);
    if (!Number.isFinite(current)) {
      status.textContent = tx("实时价格尚未加载", "Live price is not loaded");
      return;
    }
    const direction = rule.direction === "down" ? "down" : "up",
      wasEnabled = settings.enabled;
    settings.enabled = true;
    say(voiceRuleMessage(rule, current, direction), {
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
          say(voiceRuleMessage(rule, current, direction));
          announceVoiceTrigger(rule);
          renderVoiceRules();
        }
        rule.satisfied = satisfied;
      }
    voicePrevious = current;
  }, 1_000);
  window.addEventListener("btc:voice-language-changed", () => {
    filterEdgeVoices();
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
    say(voiceRuleMessage({ ...rule, direction }, current, direction));
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
};
function fixedRuleBasisText() {
  const source =
      { okx: "OKX", coinbase: "Coinbase", binance: "Binance", gate: "Gate" }[
        fixedRuleSignal.source || state.source
      ] || "--",
    label =
      {
        "5m": "5分钟",
        "15m": "15分钟",
        "30m": "30分钟",
        "1h": "1小时",
        "3h": "3小时",
      }[fixedRuleSignal.interval] || fixedRuleSignal.interval;
  return `基准：${source} · ${label} · 最近 200 根已收盘 K 线`;
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
        `EMA200 看最近 200 根 ${interval} K 线（约 ${period(200)}），用于长趋势背景。数据不足时显示 -- 和中性。`,
        "EMA200 uses the latest 200 basis candles for long-trend context. Missing data is shown as neutral.",
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
function renderFixedRuleSignal() {
  if (fixedRuleSignal.candles.length < 200) return;
  const m = metrics(fixedRuleSignal.candles),
    [label, cls] = classification(m.score),
    signal = $("signal"),
    reason = $("signalReason");
  if (signal) {
    signal.textContent = `${label} ${m.score > 0 ? "+" : ""}${m.score.toFixed(2)}`;
    signal.className = `signal ${cls}`;
  }
  /* Keep the signal card's accent aligned with the actual rule direction.
     The attribute is presentation-only; it never affects the score or rule. */
  const signalCard = $("ruleSignalCard");
  if (signalCard) signalCard.dataset.signalTone = cls;
  document.documentElement.dataset.ruleSignalTone = cls;
  if (reason)
    reason.innerHTML = `<span class="signal-summary"><b class="signal-indicator ${m.close >= m.e20 ? "bull" : "bear"}">EMA20 ${money(m.e20)}</b><i>·</i><b class="signal-indicator ${m.close >= m.e50 ? "bull" : "bear"}">EMA50 ${money(m.e50)}</b><i>·</i><b class="signal-indicator ${m.rsi >= 50 ? "bull" : "bear"}">RSI(14) ${m.rsi.toFixed(2)}</b><i>·</i><b class="signal-indicator ${m.macd >= 0 ? "bull" : "bear"}">MACD ${m.macd.toFixed(2)}</b></span>`;
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
  if (basis)
    basis.textContent = `${fixedRuleBasisText()} · 最近收盘 ${pointTime(fixedRuleSignal.closedAt)}`;
}
async function loadFixedRuleSignal(force = false) {
  if (fixedRuleSignal.loading) return;
  fixedRuleSignal.loading = true;
  try {
    const source = state.source || "okx",
      query = new URLSearchParams({
        source,
        interval: fixedRuleSignal.interval,
        limit: "201",
      }),
      response = await fetch("/api/market?" + query),
      data = await response.json();
    if (!response.ok) throw data;
    const candles = data.candles.slice(0, -1).slice(-200),
      closedAt = candles.at(-1)?.time,
      key = `${data.source}:${fixedRuleSignal.interval}:${closedAt}`;
    if (
      candles.length === 200 &&
      (force ||
        key !==
          `${fixedRuleSignal.source}:${fixedRuleSignal.interval}:${fixedRuleSignal.closedAt}`)
    ) {
      fixedRuleSignal.candles = candles;
      fixedRuleSignal.source = data.source;
      fixedRuleSignal.closedAt = closedAt;
    }
    renderFixedRuleSignal();
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
  control.innerHTML = `<span>信号基准</span><select aria-label="信号基准周期"><option value="5m">5分钟</option><option value="15m">15分钟</option><option value="30m">30分钟</option><option value="1h">1小时</option><option value="3h">3小时</option></select>`;
  const select = control.querySelector("select");
  select.value = fixedRuleSignal.interval;
  select.onchange = () => {
    fixedRuleSignal.interval = select.value;
    fixedRuleSignal.candles = [];
    fixedRuleSignal.closedAt = 0;
    localStorage.setItem("btc_rule_signal_interval", select.value);
    loadFixedRuleSignal(true);
  };
  heading.after(control);
  $("source")?.addEventListener("change", () => loadFixedRuleSignal(true));
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
  const c = cv.getContext("2d"),
    P = { l: 52, r: 74, t: 15, b: 30 },
    cw = w - P.l - P.r,
    ch = h - P.t - P.b;
  const closes = d.map((v) => v.close),
    ma20 = ema(closes, 20),
    ma50 = ema(closes, 50),
    ma200 = ema(closes, 200);
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
  [ma20, ma50, ma200].forEach((a) =>
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
  entryLevelsWithPlacement
    .filter((entry) => entry.placement === "inside")
    .forEach((entry) => values.push(entry.price));
  let lo = Math.min(...values),
    hi = Math.max(...values),
    margin = (hi - lo || 1) * 0.075;
  lo -= margin;
  hi += margin;
  const x = (i) => P.l + (i / Math.max(1, d.length - 1)) * cw,
    y = (v) => P.t + ch - ((v - lo) / (hi - lo)) * ch;
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
    const yy = P.t + (g * ch) / 4;
    c.beginPath();
    c.moveTo(P.l, yy);
    c.lineTo(P.l + cw, yy);
    c.stroke();
    c.fillText((hi - ((hi - lo) * g) / 4).toFixed(2), w - 6, yy + 4);
  }
  c.textAlign = "start";
  const candleWidth = Math.max(2, Math.min(14, (cw / d.length) * 0.64)),
    lines = state.chartLines || { ma20: true, ma50: true, ma200: true },
    series = state.chartSeries || { candles: true, close: false };
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
            ? Math.min(P.t + ch - 3, y(v.low) + 14)
            : Math.max(P.t + 10, y(v.high) - 7),
        );
        c.restore();
      }
    });
  /* Close-price trace uses the same teal as the “价格” legend. */
  if (series.close) {
    c.save();
    c.beginPath();
    traceSmoothChartLine(c, closes, x, y);
    c.lineJoin = "round";
    c.lineCap = "round";
    c.strokeStyle = "rgba(10,22,42,.72)";
    c.lineWidth = 4.4;
    c.stroke();
    c.strokeStyle = "#00d4aa";
    c.lineWidth = 2.25;
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
  entryLevelsWithPlacement.forEach((entry, index) => {
    const color = entry.side === "short" ? "#ff5b7b" : "#19d3b0",
      edgeOffset = Math.floor(index / 2) * 20,
      yy =
        entry.placement === "top"
          ? P.t + 9 + edgeOffset
          : entry.placement === "bottom"
            ? P.t + ch - 9 - edgeOffset
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
          ? Math.min(P.t + ch - 20, yy + 5)
          : entry.placement === "bottom"
            ? Math.max(P.t + 3, yy - 20)
            : Math.max(P.t + 3, Math.min(P.t + ch - 20, yy - (index ? 0 : 18)));
    c.fillStyle =
      entry.side === "short" ? "rgba(255,91,123,.18)" : "rgba(25,211,176,.18)";
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
  for (let g = 0; g < 5; g++) {
    const i = Math.round((g * (d.length - 1)) / 4);
    c.fillStyle = "#75849a";
    c.textAlign = g === 0 ? "left" : g === 4 ? "right" : "center";
    c.fillText(
      time(d[i].time),
      g === 0 ? P.l : g === 4 ? P.l + cw : x(i),
      h - 8,
    );
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
  if (hoverPoint) {
    const xx = Math.max(P.l, Math.min(P.l + cw, hoverPoint.x)),
      yy = Math.max(P.t, Math.min(P.t + ch, hoverPoint.y));
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
const syncHoverPoint = (event) => {
  const cv = $("chart"),
    rect = cv?.getBoundingClientRect(),
    d = visibleCandles();
  if (!cv || !rect || d.length < 2) return;
  const P = { l: 52, r: 74, t: 15, b: 30 },
    cw = rect.width - P.l - P.r,
    ch = rect.height - P.t - P.b,
    rawX = event.clientX - rect.left,
    rawY = event.clientY - rect.top;
  hoverPoint = {
    x: Math.max(P.l, Math.min(P.l + cw, rawX)),
    y: Math.max(P.t, Math.min(P.t + ch, rawY)),
  };
  hoverIndex = Math.max(
    0,
    Math.min(
      d.length - 1,
      Math.round(((hoverPoint.x - P.l) / cw) * (d.length - 1)),
    ),
  );
};
$("chart")?.addEventListener("mousemove", syncHoverPoint);
$("chart")?.addEventListener("pointermove", syncHoverPoint);
$("chart")?.addEventListener("mouseleave", () => {
  hoverPoint = null;
});

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
      `基于最近 200 根已收盘 ${fixedRuleSignal.interval} K 线的 EMA20、EMA50、EMA200 排列。只用于趋势过滤，不等于立即开仓。`,
      "EMA alignment over the latest 200 closed basis candles. It filters trend; it is not an entry by itself.",
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
    toggle.childNodes[0]?.remove();
    toggle.prepend(
      document.createTextNode(`⇆ ${tx("连通性测试", "Connectivity")} `),
    );
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
  const checks = () => [
    webSocketCheck,
    backendCheck,
    marketCheck("okx", "OKX", "BTC-USDT-SWAP"),
    marketCheck("coinbase", "Coinbase", "BTC-PERP"),
    marketCheck("gate", "Gate", "BTC_USDT"),
    marketCheck("binance", "Binance", "BTCUSDT"),
    async () => {
      const result = await timedFetch("/api/forecast-history"),
        { data } = result;
      return {
        ...result,
        name: tx("概率历史样本", "Forecast history"),
        contract: "/api/forecast-history",
        detail: `${data.source} · 15m ${data.intraday.length} / 1d ${data.daily.length} · ${data.cached ? tx("缓存", "cached") : tx("实时", "live")}`,
      };
    },
    async () => {
      const result = await timedFetch("/api/correlation-history"),
        { data } = result;
      return {
        ...result,
        name: tx("美股联动样本", "US equities history"),
        contract: "/api/correlation-history",
        detail: `BTC ${data.btc.length} · SPY ${data.spy.length} · QQQ ${data.qqq.length} · ${data.cached ? tx("缓存", "cached") : tx("实时", "live")}`,
      };
    },
    sentimentCheck,
    macroCheck,
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
    summary.className = "connectivity-summary testing";
    summary.textContent = tx(
      "正在并行检测 10 项数据链路（优先 OKX WebSocket）…",
      "Testing 10 data paths, prioritizing OKX WebSocket…",
    );
    const definitions = [
      [
        tx("OKX WebSocket（优先）", "OKX WebSocket (preferred)"),
        "wss://ws.okx.com:8443/ws/v5/public",
      ],
      [tx("本站后端", "Site backend"), "/api/status"],
      ["OKX", "BTC-USDT-SWAP"],
      ["Coinbase", "BTC-PERP"],
      ["Gate", "BTC_USDT"],
      ["Binance", "BTCUSDT"],
      [tx("概率历史样本", "Forecast history"), "/api/forecast-history"],
      [tx("美股联动样本", "US equities history"), "/api/correlation-history"],
      [
        tx("恐惧&贪婪指数", "Fear & Greed Index"),
        "Alternative.me · /api/sentiment",
      ],
      [
        tx("宏观日历与市场环境", "Macro calendar & market context"),
        "/api/fed-calendar",
      ],
    ];
    rows.replaceChildren(
      ...definitions.map((item, index) => row(index, ...item)),
    );
    const results = await Promise.all(
      checks().map(async (check, index) => {
        try {
          return { ok: true, ...(await check()), index };
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
      const el = rows.querySelector(`[data-check="${result.index}"]`);
      el.classList.remove("testing");
      if (result.ok) {
        passed++;
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
    const all = passed === results.length;
    summary.className = `connectivity-summary ${all ? "good" : passed ? "warn" : "bad"}`;
    summary.textContent = tx(
      `检测完成：${passed}/${results.length} 项可用 · ${new Date().toLocaleTimeString("zh-CN")}`,
      `Completed: ${passed}/${results.length} available · ${new Date().toLocaleTimeString("en-US")}`,
    );
    toggle.classList.remove("testing");
    toggle.classList.toggle("has-error", !all);
    toggle.dataset.result = `${passed}/${results.length}`;
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
setTimeout(() => {
  const hint = $("panLabel")?.querySelector("small");
  if (hint)
    hint.textContent = tx(
      "按住 ⌘ / Ctrl + 滚轮缩放",
      "Hold ⌘ / Ctrl + scroll to zoom",
    );
}, 25);

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
$("chart")
  ?.closest(".chart-box")
  ?.addEventListener(
    "wheel",
    (event) => {
      if (!event.metaKey && !event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();
      const factor = event.deltaY < 0 ? 1.2 : 1 / 1.2,
        next = Math.max(1, Math.min(5, state.zoom * factor));
      if (next === state.zoom) return;
      state.zoom = next;
      state.panOffset = 0;
      hoverIndex = null;
      chartSelection = null;
      const label = $("zoomLabel");
      if (label) label.textContent = `${Math.round(state.zoom * 100)}%`;
      draw();
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
    P = { l: 18, r: 74, t: 15, b: 30 },
    cw = rect.width - P.l - P.r,
    ch = rect.height - P.t - P.b,
    x = (i) => P.l + (i / (d.length - 1)) * cw,
    y = (v) => P.t + ch - ((v - min) / (max - min)) * ch,
    label = state.range || state.interval,
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
  version.textContent = "ℹ v2.4.0";
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
  log.innerHTML = `<b>v2.4.0 更新日志</b><dl><dt>语音接力播报</dt><dd>语音设置、规则、音色与持仓参考同步持久化到本机服务端；页面每 5 秒发送心跳，关闭或挂起超过 60 秒后由服务端按相同规则继续播报，期间触发记录在重新打开页面时回拉刷新。</dd><dt>信号有效区间</dt><dd>规则信号卡新增 ATR 作废／兑现参考带与现价位置刻度：价格在带内信号保持有效，越过作废边界后信号灰显并提示失效；取代原先静态的 ATR 止盈止损读数。</dd><dt>溢价指数</dt><dd>新增 OKX 永续相对现货的溢价指数（每 30 秒刷新），作为杠杆拥挤过滤进入微观结构与追单理由：明显正溢价提示多头成本偏高、负溢价提示空头拥挤。</dd><dt>美股实时状态</dt><dd>顶部时间栏新增北京时间与纽约时间及纽交所开闭市状态；美股盘中自动展示 SPY、QQQ 实时价格与涨跌，数据源不可用时整行隐藏而不渲染空行情。</dd><dt>长期图表修复</dt><dd>OKX 历史 K 线超过单页上限（300 根）时改为按页回溯拼接，1 年／6 个月等长周期不再被静默截短，图表覆盖范围与页面声明一致。</dd><dt>宏观日历增强</dt><dd>事件进入发布窗口（前后 15 分钟）时自动高频刷新；FOMC、CPI 与非农在公布后 24 小时内保持可见，非农自动回填 BLS 官方实际值。</dd><dt>盘口价差</dt><dd>订单簿快照新增买卖价差（bps）度量并纳入微观结构参考。</dd><dt>稳定性与缓存</dt><dd>未处理异常／Promise 拒绝只记录日志，不再拖垮整个行情服务；每个请求带统一兜底错误返回；Server 酱推送统一 8 秒超时避免挂起投递循环；空闲数据库连接异常受控监听；带版本号的静态资源启用一年强缓存，其余按需刷新。</dd><dt>前端架构</dt><dd>面板归属集中登记到统一注册中心（BTCPanels）；决策层、固定规则信号与指标明细改由有序增强器队列扩展，不再覆写旧渲染函数或跨模块挪动 DOM；研究型回测与联动卡不再依赖固定 DOM 锚点，改为数据就绪后动态挂载；样式按 tokens／base／layout／components／responsive／foundation 分模块渐进拆分。</dd></dl><hr>${v23Changelog}`;
  // 旧版本默认收起，确保用户打开日志时首先看到当前版本的完整变更。
  // Older releases are collapsed by default so opening the log focuses on the current release.
  const collapseLegacyRelease = () => {
    const divider = log.querySelector("hr"),
      heading = divider?.nextElementSibling,
      content = heading?.nextElementSibling;
    if (!divider || heading?.tagName !== "B" || content?.tagName !== "DL")
      return;
    const details = document.createElement("details"),
      summary = document.createElement("summary");
    details.className = "legacy-release";
    summary.textContent = heading.textContent;
    details.append(summary, content);
    divider.replaceWith(details);
    heading.remove();
  };
  collapseLegacyRelease();
  collapseLegacyRelease();
  collapseLegacyRelease();
  collapseLegacyRelease();
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
(() => {
  const toolbar = $("chart")?.closest(".card")?.querySelector(".toolbar"),
    chartBox = $("chart")?.closest(".chart-box");
  if (!toolbar || $("chartDisplayControls")) return;
  const saved = JSON.parse(localStorage.getItem("btc_chart_display") || "{}");
  state.chartSeries = {
    candles: saved.candles ?? saved.mode !== "line",
    close: saved.close ?? saved.mode === "line",
  };
  state.chartLines = {
    ma20: saved.ma20 ?? true,
    ma50: saved.ma50 ?? true,
    ma200: saved.ma200 ?? true,
  };
  const legend = document.createElement("div");
  legend.id = "chartPatternLegend";
  legend.className = "chart-pattern-legend";
  legend.innerHTML =
    "<span><b>H</b> 锤子线：长下影线，表示低位承接形态</span><span><b>S</b> 流星线：长上影线，表示高位抛压形态</span>";
  chartBox.after(legend);
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
      .querySelectorAll("[data-line]")
      .forEach((b) =>
        b.classList.toggle("off", !state.chartLines[b.dataset.line]),
      );
    legend.hidden = !state.chartSeries.candles;
    localStorage.setItem(
      "btc_chart_display",
      JSON.stringify({ ...state.chartSeries, ...state.chartLines }),
    );
    const activeSeries = [];
    if (state.chartSeries.candles)
      activeSeries.push(tx("K线图", "Candlestick"));
    if (state.chartSeries.close)
      activeSeries.push(tx("收盘线", "Close line"));
    panel.querySelector("[data-current-chart]").textContent =
      activeSeries.join(" + ") || tx("已隐藏", "Hidden");
    drawCandlestickChart();
  };
  panel.innerHTML = `<div class="control-popover chart-picker"><button class="control-trigger" type="button" aria-haspopup="true" aria-expanded="false"><span class="control-label">${tx("图表", "Chart")}</span><b data-current-chart></b><i aria-hidden="true">▾</i></button><div class="control-popover-panel chart-display-options"><div class="chart-series-options"><button type="button" data-series="candles">${tx("K线图", "Candlestick")}</button><button type="button" data-series="close">${tx("收盘价折线", "Close line")}</button></div><div class="chart-line-toggles"><button type="button" data-line="ma20">MA20</button><button type="button" data-line="ma50">MA50</button><button type="button" data-line="ma200">MA200</button></div></div></div>`;
  const popover = panel.querySelector(".control-popover"),
    trigger = panel.querySelector(".control-trigger");
  trigger.addEventListener("click", () => {
    const open = popover.classList.toggle("is-open");
    trigger.setAttribute("aria-expanded", String(open));
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
    text = (el, cn, en) => {
      if (el) el.textContent = zh ? cn : en;
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
      ? ["价格", "MA20", "MA50", "MA200"]
      : ["Price", "MA20", "MA50", "MA200"];
    legend
      .querySelectorAll("span")
      .forEach((node, i) => (node.textContent = names[i]));
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
      cls = long ? "bull" : "bear",
      tip = long
        ? tx(
            "预计目标价表示：按当前“做多”方向与上方预计持续时长，推测价格可能上涨到的研究目标位；不是保证到达或成交的价格。",
            "Estimated target: a research level the price may rise to during the projected long duration; not a guaranteed fill or outcome.",
          )
        : tx(
            "预计目标价表示：按当前“做空”方向与上方预计持续时长，推测价格可能下跌到的研究目标位；不是保证到达或成交的价格。",
            "Estimated target: a research level the price may fall to during the projected short duration; not a guaranteed fill or outcome.",
          );
    box.className = `signal-projection ${cls}`;
    box.innerHTML = `<span>${tx("方向研究估算", "Directional research estimate")}</span><div><b>${long ? tx("做多", "Long") : tx("做空", "Short")}</b><em>${tx("预计持续", "Estimated duration")} ${duration}</em><strong>${tx("预计目标价", "Estimated target")} ${money(target)} <button class="help-dot" type="button" data-tip="${tip}" aria-label="${tx("预计目标价说明", "Target price explanation")}">!</button></strong></div><small>${tx("按当前 ATR 波动与规则信号强度推算；目标不保证到达。", "Derived from current ATR volatility and rule-signal strength; the target is not guaranteed.")}</small>`;
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
    chartSelection = null;
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
    P = { l: 18, r: 74, t: 15, b: 30 },
    cw = rect.width - P.l - P.r,
    ch = rect.height - P.t - P.b,
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
    y = (v) => P.t + ch - ((v - loValue) / (hiValue - loValue)) * ch,
    label = state.range || state.interval,
    place = (el, i, kind) => {
      const value = d[i].close;
      el.style.left = `${Math.max(8, Math.min(rect.width - 214, x(i)))}px`;
      el.style.top = `${Math.max(6, Math.min(rect.height - 28, y(value) + (kind === "high" ? -28 : 9)))}px`;
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
  // A range is a complete view preset, rather than an unbounded request to
  // render the currently selected candle size.  Keeping roughly 100–365 bars
  // makes each option both legible and fetchable from every supported source.
  "15分": { minutes: 15, interval: "1m" },
  "1时": { minutes: 60, interval: "1m" },
  "6时": { minutes: 360, interval: "1m" },
  "12时": { minutes: 720, interval: "5m" },
  "1D": { minutes: 1440, interval: "5m" },
  "1W": { minutes: 10080, interval: "1h" },
  "1M": { minutes: 43200, interval: "4h" },
  "6M": { minutes: 262800, interval: "1d" },
  "1Y": { minutes: 525600, interval: "1d" },
};
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
function applyVisibleRange(label) {
  const preset = viewRanges[label],
    minutes = preset?.minutes,
    interval = preset?.interval || state.interval,
    points = Math.min(
      500,
      Math.max(
        2,
        Math.ceil(minutes / (intervalMinutes[interval] || 1)) + 1,
      ),
    );
  // Do not silently cap a one-minute chart and still call it a one-month
  // view.  Selecting a display range deliberately selects its compatible
  // aggregation interval first.
  state.interval = interval;
  state.range = label;
  state.viewPoints = points;
  state.limit = Math.max(300, points);
}
buttons = function () {
  const key = `${uiLang}:${state.interval}:${state.limit}:${state.range || ""}:${state.viewPoints || ""}`,
    intervalBox = $("intervals"),
    rangeBox = $("ranges"),
    viewText = (label) =>
      uiLang === "zh"
        ? label
        : { "15分": "15m", "1时": "1h", "6时": "6h", "12时": "12h" }[label] ||
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
    intervalBox.querySelectorAll("[data-candle]").forEach(
      (b) =>
        (b.onclick = () => {
          state.interval = b.dataset.candle;
          // A direct interval selection is a custom view.  Clear the range
          // preset instead of falsely retaining (for example) “1M” while
          // showing only the latest few hours of one-minute data.
          state.range = null;
          state.limit = 300;
          state.viewPoints = null;
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
      `<div class="control-popover range-picker"><button class="control-trigger" type="button" aria-haspopup="true"><span class="control-label">${tx("查看范围", "Visible range")}</span><b data-current-range></b><i aria-hidden="true">▾</i></button><div class="control-popover-panel range-options">` +
      Object.keys(viewRanges)
        .map(
          (label) => `<button data-view="${label}">${viewText(label)}</button>`,
        )
        .join("") +
      "</div></div>";
    const rangePopover = rangeBox.querySelector(".control-popover");
    rangePopover?.querySelector(".control-trigger")?.addEventListener("click", () =>
      rangePopover.classList.toggle("is-open"),
    );
    rangeBox.querySelectorAll("[data-view]").forEach(
      (b) =>
        (b.onclick = () => {
          applyVisibleRange(b.dataset.view);
          buttonsSignature = "";
          rangePopover?.classList.remove("is-open");
          loadCurrent();
        }),
    );
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
  const box = $("chart")?.closest(".card")?.querySelector(".toolbar");
  if (box && !$("chartLegend")) {
    const legend = document.createElement("div");
    legend.id = "chartLegend";
    legend.innerHTML =
      '<span class="price-line">价格</span><span class="ma20-line">MA20</span><span class="ma50-line">MA50</span><span class="ma200-line">MA200</span>';
    box.append(legend);
  }
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
  form.dispatchEvent(new Event("input", { bubbles: true }));
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

$("chart")?.addEventListener("mousemove", (event) => {
  const cv = $("chart"),
    tip = $("chartTooltip");
  if (!cv || !tip || tip.style.display === "none") return;
  const rect = cv.getBoundingClientRect(),
    x = event.clientX - rect.left,
    y = event.clientY - rect.top,
    tipW = Math.min(300, tip.offsetWidth || 300),
    tipH = tip.offsetHeight || 190;
  tip.style.left = `${x + tipW + 24 < rect.width ? x + 24 : Math.max(10, x - tipW - 24)}px`;
  tip.style.top = `${y - tipH - 24 > 8 ? y - tipH - 24 : Math.min(rect.height - tipH - 8, y + 24)}px`;
});

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
    label = state.range || state.interval;
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
    long = m.score >= 0,
    reference = m.close,
    current = state.ticker?.last || state.candles.at(-1)?.close || reference;
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
function renderSelectionOverlay() {
  if (!chartSelection) return;
  const d = visibleCandles(),
    a = Math.min(chartSelection.start, chartSelection.end),
    b = Math.max(chartSelection.start, chartSelection.end),
    s = d.slice(a, b + 1),
    hi = Math.max(...s.map((v) => v.high)),
    lo = Math.min(...s.map((v) => v.low)),
    now = state.ticker?.last,
    ret = (s.at(-1).close / s[0].open - 1) * 100,
    overlay = $("selectionOverlay");
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
  addHelp(
    $("intervals")?.querySelector(".control-label"),
    "K 线周期决定每根 K 线代表多长时间，例如 15 分钟 K 线每根聚合 15 分钟价格。",
    "Candle interval sets the duration represented by each candle; a 15m candle aggregates 15 minutes of price.",
  );
  addHelp(
    $("ranges")?.querySelector(".control-label"),
    "查看范围决定图表加载和显示多长的历史，例如 1D 显示一天。它不同于每根 K 线的周期。",
    "Visible range sets how much history is loaded and shown, such as 1D. It differs from the duration of each candle.",
  );
});
$("chart")
  ?.closest(".chart-box")
  ?.insertAdjacentHTML("beforeend", '<div id="selectionOverlay" hidden></div>');
$("chart")?.addEventListener("pointerup", renderSelectionOverlay);
$("chart")?.addEventListener("pointerleave", () => {
  const o = $("selectionOverlay");
  if (o) o.hidden = true;
});
$("chart")?.addEventListener("mousemove", () => {
  const tip = $("chartTooltip"),
    v = visibleCandles()[hoverIndex],
    live = state.ticker?.last;
  if (!tip || !v || !Number.isFinite(live)) return;
  const delta = v.close - live;
  tip.innerHTML = `<b>${pointTime(v.time)}</b><strong class="chart-point-price">${tx("选中价", "Selected price")} ${money(v.close)}</strong><span class="chart-live-price">${tx("实时价", "Live price")} ${money(live)} <i class="${delta >= 0 ? "bull" : "bear"}">${tx("差价", "Δ")} ${delta >= 0 ? "+" : "−"}${money(Math.abs(delta))}</i></span><span>${tx("开", "Open")} ${money(v.open)}　${tx("高", "High")} ${money(v.high)}</span><span>${tx("低", "Low")} ${money(v.low)}　${tx("收", "Close")} ${money(v.close)}</span>`;
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
  await loadCurrentWithHeader();
  const subtitle = document.querySelector("header p"),
    stream = state.lastGood?.transport === "websocket",
    latency = requestLatency || "--",
    highLatency = !stream && Number(requestLatency) >= 1000,
    streamAge = Number.isFinite(state.lastGood?.cacheAgeMs)
      ? `${state.lastGood.cacheAgeMs} ms`
      : "--";
  if (subtitle)
    subtitle.innerHTML = `<span class="live-pulse"></span>${stream ? tx("实时连接 · OKX WebSocket", "Live connection · OKX WebSocket") : tx("实时连接 · REST 降级", "Live connection · REST fallback")} · ${stream ? tx("数据年龄", "data age") + " " : ""}<b class="latency${highLatency ? " latency-high" : ""}">${stream ? streamAge : latency + " ms"}</b>`;
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
/* Keep every zoom path within the same 500% ceiling. */
$("chart")?.addEventListener(
  "wheel",
  () => {
    if (state.zoom > 5) {
      state.zoom = 5;
      const label = $("zoomLabel");
      if (label) label.textContent = "500%";
      draw();
    }
  },
  { passive: true },
);
const zoomControls = document.querySelector(".zoom-tools");
if (zoomControls)
  zoomControls.onclick = (event) => {
    const op = event.target.dataset.zoom;
    if (!op) return;
    state.zoom =
      op === "in"
        ? Math.min(5, state.zoom * 1.5)
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
  const tag = (kind, bullish = "看多", bearish = "看空") =>
      kind === "bull" ? bullish : kind === "bear" ? bearish : "中性",
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
    "布林位置",
    `${m.boll.toFixed(2)}%`,
    bollKind,
    "布林位置表示价格在近期波动区间的哪里：靠上偏强、靠下偏弱，但不代表一定反转。",
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
      "成交量确认",
      `${volumeRatio.toFixed(2)}×`,
      volumeRatio >= 1.2 ? "bull" : volumeRatio < 0.8 ? "bear" : "flat",
      "这根已收盘 K 线的成交量相对前 20 根均量。大于 1.2 倍叫放量确认，低于 0.8 倍说明参与度较弱。",
    );
  if (Number.isFinite(vwap))
    add(
      "vwap",
      "日内 VWAP",
      money(vwap),
      vwapBull ? "bull" : vwapBear ? "bear" : "flat",
      "VWAP 是当天按成交量加权的平均成交价。价格在它上方偏强、下方偏弱，仍需要趋势和成交量配合。",
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
  let decision = "观望",
    decisionKind = "flat",
    reason = "趋势、成交量与日内位置还没有同时确认";
  if (trendBull && vwapBull && volumeRatio >= 1) {
    decision = "研究偏多";
    decisionKind = "bull";
    reason = "均线趋势向上，价格在日内 VWAP 上方，且成交量没有走弱";
  } else if (trendBear && vwapBear && volumeRatio >= 1) {
    decision = "研究偏空";
    decisionKind = "bear";
    reason = "均线趋势向下，价格在日内 VWAP 下方，且成交量没有走弱";
  } else if ((trendBull || trendBear) && volumeRatio < 1)
    reason = "趋势存在，但成交量不足，信号可信度较低";
  else if (trendBull || trendBear)
    reason = "趋势存在，但价格与日内 VWAP 没有同向确认";
  if (
    (decisionKind === "bull" && crowdedLong) ||
    (decisionKind === "bear" && crowdedShort)
  ) {
    decision = "观望";
    decisionKind = "flat";
    reason += `；${crowdedLong ? "多头" : "空头"}资金费率偏拥挤`;
  }
  if (extremeBasis) reason += `；永续${basis > 0 ? "溢价" : "贴水"}偏大`;
  host.classList.add("trade-confirmation-metrics", "indicator-adaptive-grid");
  host.style.setProperty(
    "--indicator-font-scale",
    rows.length > 10 ? ".84" : rows.length > 8 ? ".92" : "1",
  );
  const rowHtml = (row) =>
      `<div class="metric trade-confirmation-row compact-indicator" data-fixed-basis="true" data-indicator-key="${row.key}"><span>${row.label}</span><b>${row.value}</b><i class="badge ${row.kind}">${tag(row.kind, row.key === "volume" ? "确认" : row.key === "vwap" ? "偏多" : "看多", row.key === "volume" ? "偏弱" : row.key === "vwap" ? "偏空" : "看空")}</i></div>`,
    directionalRows = rows.filter((row) => row.kind !== "flat"),
    neutralRows = rows.filter((row) => row.kind === "flat"),
    neutralSection = neutralRows.length
      ? `<section class="indicator-neutral-group ${neutralIndicatorsExpanded ? "is-expanded" : ""}"><button type="button" class="indicator-neutral-toggle" aria-expanded="${neutralIndicatorsExpanded}"><span>${tx("中性指标", "Neutral indicators")} · ${neutralRows.length} ${tx("项", "items")}</span><b>${neutralIndicatorsExpanded ? tx("收起", "Hide") : tx("展开", "Show")}</b></button><div class="indicator-neutral-grid ${neutralIndicatorsExpanded ? "" : "is-collapsed"}" ${neutralIndicatorsExpanded ? "" : "hidden"}>${neutralRows.map(rowHtml).join("")}</div></section>`
      : "";
  host.innerHTML =
    directionalRows.map(rowHtml).join("") +
    neutralSection +
    `<div class="trade-decision ${decisionKind}"><span>研究结论</span><b>${decision}</b><p>${reason}。${context ? ` 数据源：${String(context.source).toUpperCase()}。` : ""}仅供研究，不构成交易建议。</p></div>`;
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
  { price: null, side: "long" },
  { price: null, side: "short" },
];
let personalEntriesFollowAccount = false;
const hasPersonalEntriesV3 =
  localStorage.getItem(entryPricesStorageKey) !== null;
try {
  const saved = JSON.parse(localStorage.getItem(entryPricesStorageKey) || "[]");
  if (Array.isArray(saved) && saved.length === 2)
    personalEntries = saved.map((entry, index) => ({
      price: validEntry(Number(entry?.price)),
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
      { price: validEntry(Number(prior.long)), side: "long" },
      { price: validEntry(Number(prior.short)), side: "short" },
    ];
  } catch {}
  const legacy = validEntry(Number(localStorage.getItem(entryPriceStorageKey)));
  if (legacy)
    personalEntries[0] = {
      price: legacy,
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
function personalSidePicker(index, side) {
  return `<span class="personal-entry-heading">${tx("我的买入价", "My entry price")}<i class="personal-side-picker"><button type="button" data-entry-side="long" data-entry-index="${index}" class="${side === "long" ? "active" : ""}">${tx("做多", "Long")}</button><button type="button" data-entry-side="short" data-entry-index="${index}" class="${side === "short" ? "active" : ""}">${tx("做空", "Short")}</button></i></span>`;
}
function personalEntrySlot(index, live) {
  const entry = personalEntries[index],
    price = entry.price,
    side = entry.side;
  if (personalEntryEditingIndex === index)
    return `<article class="personal-entry-slot ${side} editing">${personalSidePicker(index, side)}<input class="personal-entry-input" data-entry-input="${index}" aria-label="${tx("我的买入价", "My entry price")}" type="number" inputmode="decimal" min="0" step="0.01" placeholder="${tx("输入买入价", "Enter buy-in price")}" value="${price ? price.toFixed(2) : ""}"><small>${tx("按 Enter 保存；留空可清除", "Press Enter to save; leave blank to clear")}</small></article>`;
  if (!price)
    return `<article class="personal-entry-slot ${side} empty">${personalSidePicker(index, side)}<button type="button" class="personal-entry-value" data-entry-value="${index}" title="${tx("双击数字输入买入价", "Double-click the number to enter your buy-in price")}">--</button><small>${tx("双击数字即可输入买入价", "Double-click the number to enter your buy-in price")}</small></article>`;
  const rawDelta = Number.isFinite(live) ? live - price : 0,
    delta = side === "short" ? -rawDelta : rawDelta,
    percentage = (delta / price) * 100,
    profit = delta >= 0;
  return `<article class="personal-entry-slot ${side} ${profit ? "profit" : "loss"}">${personalSidePicker(index, side)}<div class="personal-entry-price-row"><button type="button" class="personal-entry-value" data-entry-value="${index}" title="${tx("双击数字修改买入价", "Double-click the number to edit your buy-in price")}">${money(price)}</button><i class="personal-entry-status">${profit ? tx("盈利中", "In profit") : tx("亏损中", "At a loss")}</i></div><b>${profit ? "+" : "−"}${money(Math.abs(delta))} <em>${profit ? "+" : "−"}${Math.abs(percentage).toFixed(2)}%</em></b><small>${tx("按仓位方向计算 · 双击数字修改", "Calculated by position side · double-click number to edit")}</small></article>`;
}
function beginPersonalEntryEdit(index) {
  if (personalEntryEditingIndex !== null) return;
  personalEntryEditingIndex = index;
  renderPersonalEntryCard(true);
  const input = document.querySelector(`[data-entry-input="${index}"]`);
  input?.focus();
  input?.select();
  const finish = (save) => {
    if (personalEntryEditingIndex !== index) return;
    if (save) {
      personalEntries[index].price = validEntry(Number(input?.value));
      savePersonalEntries();
    }
    personalEntryEditingIndex = null;
    renderPersonalEntryCard();
  };
  input?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    }
    if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    }
  });
  input?.addEventListener("blur", () => finish(true));
}
function setPersonalEntrySide(index, side) {
  // 点击立刻写入独立键和整组数据；后续每秒重绘仅从这份状态取值。
  // Write both the per-card key and grouped data immediately; subsequent live renders only consume this state.
  personalEntries[index].side = side === "short" ? "short" : "long";
  savePersonalEntries();
}
function renderPersonalEntryLegend() {
  const legend = $("chartLegend");
  if (!legend) return;
  legend.querySelectorAll("[data-entry-legend]").forEach((el) => el.remove());
  personalEntries
    .filter((entry) => validEntry(Number(entry.price)))
    .forEach((entry) => {
      const item = document.createElement("span");
      item.dataset.entryLegend = "true";
      item.className = `personal-entry-${entry.side}`;
      item.textContent =
        entry.side === "short"
          ? tx("做空买入价", "Short entry")
          : tx("做多买入价", "Long entry");
      legend.append(item);
    });
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
    sync + personalEntrySlot(0, live) + personalEntrySlot(1, live);
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
renderPersonalEntryCard();
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
function macroCountdown(at) {
  const seconds = Math.max(0, Math.round((at - Date.now()) / 1000));
  const days = Math.floor(seconds / 86_400),
    hours = Math.floor((seconds % 86_400) / 3_600),
    minutes = Math.floor((seconds % 3_600) / 60);
  return days
    ? tx(`${days} 天 ${hours} 小时`, ` ${days}d ${hours}h`)
    : hours
      ? tx(`${hours} 小时 ${minutes} 分钟`, ` ${hours}h ${minutes}m`)
      : tx(`${minutes} 分钟`, ` ${minutes}m`);
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
        `<article class="fed-event ${event === nearest && near ? "near" : ""}"><span>${event.name}</span><b>${new Intl.DateTimeFormat(uiLang === "zh" ? "zh-CN" : "en-US", { month: "2-digit", day: "2-digit", year: "numeric", timeZone: "Asia/Shanghai" }).format(event.at)}</b><strong>${tx("距事件 ", "In ")}${macroCountdown(event.at)}</strong><small>${event.source}${event.fallback ? tx(" · 发布节奏回退", " · cadence fallback") : ""}</small><small class="macro-update-age" data-macro-updated-at="${calendarUpdatedAt || ""}">${macroUpdatedAgo(calendarUpdatedAt)}</small></article>`,
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
      return `<article class="fed-market-signal ${signal.available ? "" : "unavailable"}"><span>${tx(signal.name, signal.name)}</span>${signal.available ? `<b class="${kind}">${changeText}</b><strong>${value(signal)}</strong><small>${signal.source} · ${tx(signal.cadence || "快照", signal.cadence || "Snapshot")}</small>` : `<b class="flat">--</b><strong>${tx("暂不可用", "Unavailable")}</strong><small>${tx(signal.detail || "公开数据暂不可用", signal.detail || "Public data unavailable")}</small>`}<small class="macro-update-age" data-macro-updated-at="${signalsUpdatedAt || ""}"${signal.available ? "" : ' data-macro-checking="true"'}>${age}</small></article>`;
    })
    .join("");
  const marketPanel = signalCards
    ? `<section class="fed-market-panel"><div><h3>${tx("综合指标", "Market context")}</h3><span>${tx("公开数据 · 每 10 分钟检查", "Public data · checked every 10 min")}</span></div><div class="fed-market-grid">${signalCards}</div></section>`
    : "";
  card.innerHTML = `<div class="fed-monitor-head"><div><h2>${tx("BTC × 美联储监控", "BTC × Federal Reserve monitor")}</h2><p>${tx("公开日历与跨市场环境数据；事件前后行情波动可能放大，不构成方向预测。", "Public event-calendar and cross-market context. Volatility can rise around releases; this is not a directional forecast.")}</p></div><span>${tx("每 10 分钟检查", "Checked every 10 min")}</span></div>${marketPanel}<div class="fed-event-grid">${eventCards || `<article class="fed-event unavailable"><span>${tx("公开日历暂不可用", "Public calendar unavailable")}</span><small>${tx("下次 10 分钟检查会自动重试。", "The next ten-minute check will retry automatically.")}</small></article>`}</div><footer>${nearest ? tx(`最近事件：${nearest.name}，请在发布前后降低杠杆和仓位集中度。`, `Nearest event: ${nearest.name}. Consider reducing leverage and concentration around the release.`) : tx("使用 Federal Reserve 与 BLS 的公开发布日历。", "Uses public Federal Reserve and BLS release calendars.")} <em>${data?.cached ? tx("缓存", "Cached") : tx("刚更新", "Updated")}</em></footer>`;
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
    gold: "黄金通常被视为避险资产，和 BTC 的短线关系并不稳定；这里仅观察其日内风险偏好变化。",
    dxy: "美元指数走强时，风险资产可能承压；相关性会随市场阶段变化。",
    "btc-dominance":
      "BTC 总市值占全加密市场的比例。占比上升常代表资金更偏向 BTC，但不能单独判断涨跌。",
    "crypto-total-cap":
      "全网加密总市值反映整体风险偏好与资产规模，使用 24 小时快照而非实时买卖信号。",
    "crypto-volume":
      "全网 24 小时成交额反映市场参与度；放量不代表必然上涨或下跌。",
    "exchange-btc-reserve":
      "交易所 BTC 钱包余额需要可验证链上数据源；本面板不会用个人账户余额替代。",
  };
  (data?.marketSignals || []).forEach((signal, index) =>
    addHelp(
      card.querySelectorAll(".fed-market-signal>span")[index],
      signalTips[signal.key] ||
        "这是公开市场环境数据，用于辅助研究，不应单独作为开仓或平仓依据。",
      "This is public market-context data for research and should not be used as a stand-alone entry or exit signal.",
    ),
  );
}
async function loadFedMonitor() {
  if (fedCalendarLoading) return;
  fedCalendarLoading = true;
  try {
    const response = await fetch("/api/fed-calendar"),
      data = await response.json();
    if (!response.ok) throw new Error(data.detail || data.error);
    renderFedMonitor(data);
  } catch {
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
function renderFearGreedGauge() {
  const sentiment = fearGreedSentiment;
  let card = $("fearGreedGauge");
  if (!card) {
    card = document.createElement("article");
    card.id = "fearGreedGauge";
    card.className = "card fear-greed-gauge-card";
    const indicatorCard = $("indicatorDetailsCard"),
      dashboardGrid = document.querySelector(".grid");
    if (indicatorCard) indicatorCard.after(card);
    else dashboardGrid?.append(card);
  }
  if (!card) return;
  card.hidden = false;
  const macroEvents = macroCalendarData?.events || [],
    now = Date.now();
  const released = macroEvents.find(
    (event) =>
      event.actual && event.at <= now && now - event.at < 24 * 3_600_000,
  );
  const future = macroEvents.find((event) => event.at >= now);
  const macroEvent = released || future;
  const macroTile = macroEvent
    ? `<section class="fear-greed-compact-tile macro-event-tile ${released ? "released" : "upcoming"}"><span>${released ? tx("已公布事件", "Released event") : tx("未来事件", "Upcoming event")}</span><b class="${released ? "bull" : "flat"}">${macroEvent.name}</b><strong>${released ? safeText(macroEvent.actual?.value || tx("数据确认中", "Verifying data")) : `${new Intl.DateTimeFormat(uiLang === "zh" ? "zh-CN" : "en-US", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai" }).format(macroEvent.at)} · ${tx("距事件 ", "In ")}${macroCountdown(macroEvent.at)}`}</strong><small>${released ? safeText(macroEvent.actual?.source || "") : tx("事件窗口内降低杠杆与仓位集中度", "Reduce leverage and concentration around the release")}</small></section>`
    : `<section class="fear-greed-compact-tile macro-event-tile"><span>${tx("未来事件", "Upcoming event")}</span><b>${tx("日历加载中", "Loading calendar")}</b><small>${tx("公开日历更新后自动显示", "Appears when the public calendar updates")}</small></section>`;
  if (!Number.isFinite(sentiment?.value)) {
    card.className = "card fear-greed-gauge-card fear-greed-compact flat";
    const unavailable = fearGreedError;
    card.innerHTML = `<div class="fear-greed-head"><h2>${tx("宏观与情绪", "Macro & sentiment")}</h2><span>${tx("慢速背景", "Slow context")}</span></div><div class="fear-greed-compact-grid"><section class="fear-greed-compact-tile ${unavailable ? "is-error" : ""}"><span class="fear-greed-label">${tx("恐惧贪婪", "Fear & Greed")}</span><b>${unavailable ? tx("暂不可用", "Unavailable") : tx("正在加载", "Loading")}</b><small>${tx("不单独交易", "Not a standalone signal")}</small>${unavailable ? `<button type="button" class="fear-greed-retry">${tx("重试", "Retry")}</button>` : ""}</section>${macroTile}</div>`;
    card
      .querySelector(".fear-greed-retry")
      ?.addEventListener("click", () => loadFearGreedSentiment(true));
    addHelp(
      card.querySelector(".fear-greed-head h2"),
      tx(
        "恐惧与贪婪指数是日频市场情绪读数，范围 0–100。极端恐惧或贪婪更适合提醒不要追单；它不单独预测短线涨跌。",
        "Fear & Greed is a daily 0–100 market-sentiment reading. Extreme values warn against chasing moves; it does not predict short-term direction by itself.",
      ),
    );
    return;
  }
  const value = Math.max(0, Math.min(100, Number(sentiment.value))),
    view = fearGreedView(value),
    sentimentTip = tx(
      `当前恐惧贪婪指数为 ${value}/100，属于“${view.label}”。它把市场情绪浓缩成 0–100：数值越低代表参与者越害怕、越不愿承担风险；数值越高代表参与者越乐观、越愿意追逐风险。${value >= 75 ? "现在处于极度贪婪，通常应避免追多，并防范拥挤后的回撤。" : value >= 56 ? "现在市场偏乐观；不表示价格一定会跌，但追多前应提高确认门槛并留意资金费率。" : value <= 24 ? "现在市场处于极度恐慌；不表示价格一定反弹，但不宜在恐慌中追空。" : value <= 44 ? "现在市场偏恐慌；应等待价格与成交量的进一步确认。" : "现在市场情绪较均衡，单靠情绪不能提供明确方向。"} 区间：0–24 极度恐慌、25–44 恐慌、45–55 中性、56–74 贪婪、75–100 极度贪婪。它是慢速环境提示，不是单独的买卖信号。`,
      `The current Fear & Greed reading is ${value}/100 (${view.label}). It compresses market mood into 0–100: low values reflect fear and lower risk appetite; high values reflect optimism and a willingness to chase risk. ${value >= 75 ? "This is extreme greed: avoid chasing longs and watch for crowded pullbacks." : value >= 56 ? "Sentiment is optimistic; that does not guarantee a decline, but it raises the bar for chasing longs and calls for attention to funding." : value <= 24 ? "This is extreme fear: it does not guarantee a rebound, but avoid chasing shorts." : value <= 44 ? "Sentiment is fearful; wait for further price and volume confirmation." : "Sentiment is balanced, so it offers no clear direction on its own."} Bands: 0–24 extreme fear, 25–44 fear, 45–55 neutral, 56–74 greed, 75–100 extreme greed. It is slow context, not a standalone trading signal.`,
    );
  card.className = `card fear-greed-gauge-card fear-greed-compact ${view.kind}`;
  card.innerHTML = `<div class="fear-greed-head"><h2>${tx("宏观与情绪", "Macro & sentiment")}</h2><span>${tx("慢速背景", "Slow context")}</span></div><div class="fear-greed-compact-grid"><section class="fear-greed-compact-tile"><span class="fear-greed-label">${tx("恐惧贪婪", "Fear & Greed")}</span><b class="${view.kind}">${value} · ${view.label}</b><small>${tx("不单独交易", "Not a standalone signal")}</small></section>${macroTile}</div>`;
  addHelp(
    card.querySelector(".fear-greed-head h2"),
    "恐惧与贪婪指数是日频市场情绪读数，范围 0–100。极端读数更适合提醒不要追单；它不单独预测短线涨跌。",
    "Fear & Greed is a daily 0–100 market-sentiment reading. Extremes warn against chasing moves; it does not predict short-term direction by itself.",
  );
  addHelp(card.querySelector(".fear-greed-label"), sentimentTip, sentimentTip);
}
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
    const response = await fetch(`/api/sentiment${force ? "?refresh=1" : ""}`),
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
  await loadCurrentWithDataDensity();
  if (!state.candles.length) return;
  const minutes =
      {
        "1m": 1,
        "5m": 5,
        "15m": 15,
        "30m": 30,
        "1h": 60,
        "2h": 120,
        "3h": 180,
        "4h": 240,
        "1d": 1440,
      }[state.interval] || 15,
    density =
      minutes >= 60
        ? `${(minutes / 60).toFixed(minutes % 60 ? 1 : 0)} ${tx("小时/根", "hours/candle")}`
        : `${minutes} ${tx("分钟/根", "min/candle")}`,
    perHour = (60 / minutes).toFixed((60 / minutes) % 1 ? 1 : 0),
    coverage = $("coverage"),
    displayed = visibleCandles();
  if (coverage)
    coverage.textContent = displayed.length
      ? `${tx("图表覆盖", "Chart coverage")}：${time(displayed[0].time)} ${tx("至", "to")} ${time(displayed.at(-1).time)} · ${displayed.length} ${tx("根", "candles")} · ${tx("数据粒度", "Granularity")} ${density}（${perHour} ${tx("根/小时", "candles/hour")}） · ${tx("仅此范围参与回测", "only this range is used in backtest")}`
      : "--";
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
      ? `${minutes} 分钟`
      : minutes % 60 === 0
        ? `${minutes / 60} 小时`
        : `${(minutes / 60).toFixed(1)} 小时`;
  const urgency =
    minMinutes >= 45 ? "comfort" : minMinutes >= 20 ? "caution" : "urgent";
  return {
    label: `约 ${print(minMinutes)}–${print(maxMinutes)}`,
    urgency,
    atrPercent,
  };
}

/* This final override is intentionally placed after compatibility renderers. */
renderSignalProjection = function () {
  const signal = $("signal"),
    reason = $("signalReason"),
    m = fixedRuleSignal.candles.length
      ? metrics(fixedRuleSignal.candles)
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
  const long = m.score >= 0,
    last = state.ticker?.last || m.close,
    strength = Math.abs(m.score),
    move = m.atr * (1.05 + Math.min(1.25, strength / 100)),
    target = last + (long ? move : -move),
    duration = estimatedSignalDuration(m),
    tip = long
      ? tx(
          "预计目标价表示：按当前做多方向、波动和预计持续时间推算的研究目标位；不保证到达或成交。",
          "Estimated target is a research level derived from the current long direction, volatility, and estimated duration; it is not guaranteed.",
        )
      : tx(
          "预计目标价表示：按当前做空方向、波动和预计持续时间推算的研究目标位；不保证到达或成交。",
          "Estimated target is a research level derived from the current short direction, volatility, and estimated duration; it is not guaranteed.",
        );
  box.className = `signal-projection ${long ? "bull" : "bear"}`;
  box.innerHTML = `<span>${tx("方向研究估算", "Directional research estimate")}</span><div><b>${long ? tx("做多", "Long") : tx("做空", "Short")}</b><em>${tx("预计持续", "Estimated duration")} <mark class="duration-estimate duration-${duration.urgency}" title="按信号强度、ATR 波动和信号基准周期动态估算">${duration.label}</mark></em><strong>${tx("预计目标价", "Estimated target")} ${money(target)} <button class="help-dot" type="button" data-tip="${tip}" aria-label="${tx("预计目标价说明", "Target price explanation")}">!</button></strong></div><small>${tx(`依据规则信号强度、ATR 波动（${duration.atrPercent.toFixed(2)}%）和 ${fixedRuleSignal.interval} 基准周期动态估算；时间越短，方向越容易失效。目标不保证到达。`, `Dynamically estimated from signal strength, ATR volatility (${duration.atrPercent.toFixed(2)}%), and the ${fixedRuleSignal.interval} basis; shorter windows can fail sooner. The target is not guaranteed.`)}</small>`;
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
    [direction] = classification(m.score),
    gauge = document.createElement("div"),
    strength = Math.min(100, Math.abs(m.score));
  gauge.className = "signal-gauge";
  gauge.innerHTML = `<div class="gauge-top"><b>做空 −100.00</b><span>当前：${direction} ${m.score > 0 ? "+" : ""}${m.score.toFixed(2)}</span><b>做多 +100.00</b></div><div class="gauge-track"><i style="left:${Math.max(0, Math.min(100, (m.score + 100) / 2))}%"></i></div><div class="gauge-strength"><em style="width:${strength}%"></em><span>信号强度：${strength.toFixed(2)}</span></div>`;
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
  [tx("较 1 分钟前收盘价", "vs close 1m ago"), "intraday", 1],
  [tx("较 5 分钟前收盘价", "vs close 5m ago"), "intraday", 5],
  [tx("较 15 分钟前收盘价", "vs close 15m ago"), "intraday", 15],
  [tx("较 1 小时前收盘价", "vs close 1h ago"), "intraday", 60],
  [tx("较 4 小时前收盘价", "vs close 4h ago"), "intraday", 240],
  [tx("较 1 日前收盘价", "vs close 1d ago"), "day", 1440],
  [tx("较 2 日前收盘价", "vs close 2d ago"), "day", 2880],
  [tx("较 1 周前收盘价", "vs close 1w ago"), "week", 10080],
  [tx("较 1 月前收盘价", "vs close 1mo ago"), "halfYear", 43200],
  [tx("较半年前收盘价", "vs close 6mo ago"), "halfYear", 259200],
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
          "近1分",
          "近5分",
          "近15分",
          "近1时",
          "近4时",
          "近一日",
          "近两日",
          "近一周",
          "近1月",
          "近6月",
        ]
      : ["1m", "5m", "15m", "1h", "4h", "1d", "2d", "1w", "1mo", "6mo"];
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
        ["intraday", "1m", 300],
        ["day", "15m", 300],
        ["week", "1h", 300],
        ["halfYear", "1d", 300],
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
  if (card) return card;
  card = document.createElement("section");
  card.id = "fearGreedGauge";
  card.className = "card fear-greed-gauge-card fear-greed-compact flat";
  card.innerHTML = `<div class="fear-greed-head"><h2>${tx("宏观与情绪", "Macro & sentiment")}</h2><span>${tx("慢速背景", "Slow context")}</span></div><div class="fear-greed-compact-grid"><section class="fear-greed-compact-tile"><span>${tx("恐惧贪婪", "Fear & Greed")}</span><b>${tx("正在加载", "Loading")}</b><small>${tx("不单独交易", "Not a standalone signal")}</small></section></div>`;
  return card;
}
function placePeriodAndSentimentCards() {
  const period = ensurePeriodChangeCard(),
    micro = $("okxMicrostructureCard"),
    layout = document.querySelector(".terminal-layout"),
    sentiment = ensureFearGreedCard(),
    indicators = $("indicatorDetailsCard");
  // 周期涨幅保持独立卡片外观，但紧贴在 OKX 微观结构之后，不能被右列高度推到下一行。
  // Keep period returns visually independent, directly after microstructure,
  // so the right column never creates an empty area in the chart column.
  if (micro && period.parentElement !== micro.parentElement) micro.after(period);
  if (sentiment && indicators && indicators.nextElementSibling !== sentiment)
    indicators.after(sentiment);
  scheduleMicrostructureAlignment();
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
  // Keep the reading order: resonance → pattern interpretation → research.
  const pattern = $("patternAnalysis"),
    resonance =
    document.querySelector("main > .optional") ||
    document.querySelector(".optional");
  if (pattern) pattern.after(card);
  else if (resonance) resonance.after(card);
  else document.querySelector("main")?.append(card);
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
      return `<article class="research-window ${label.kind}"><span>${safeText(window.label)} · ${tx({ bull: "牛市", bear: "熊市", range: "震荡" }[window.regime] || "未知", { bull: "Bull", bear: "Bear", range: "Range" }[window.regime] || "Unknown")}</span><b>${label.title}</b><strong class="${label.side}">${label.detail}</strong><em>${tx("预期变动", "Expected move")} ${move >= 0 ? "+" : "−"}${money(Math.abs(move))} (${ret >= 0 ? "+" : "−"}${Math.abs(ret).toFixed(2)}%)</em><small>${tx("价格区间 P10/P50/P90", "Price range P10/P50/P90")}：${money(range.p10)} / ${money(range.p50)} / ${money(range.p90)}</small><small>${tx("匹配质量", "Match quality")} ${quality}% · n=${window.samples}/${window.candidateCount}</small></article>`;
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
        return `<article><b>${safeText(window.label)}</b><span>${quality}</span><span>${live ? `${tx("实时", "Live")} ${tx("命中", "Hit")} ${(live.hitRate * 100).toFixed(1)}% · Brier ${live.brier.toFixed(3)} · BSS ${Number.isFinite(live.brierSkill) ? `${(live.brierSkill * 100).toFixed(1)}%` : "--"} · ECE ${Number.isFinite(live.ece) ? `${(live.ece * 100).toFixed(1)}%` : "--"} · n=${live.settled}` : `${tx("实时命中待积累", "Live outcomes pending")} · ${tx("待结算", "Pending")} ${pending}`}</span>${economic ? `<span>${economic}</span>` : ""}</article>`;
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
      ? `<section class="research-ab-evaluation ${safeText(verdict?.tone || "yellow")}"><h3>${tx("A/B 自动评估 · 当前对象：BTC 多因子研究预测模型", "A/B automatic evaluation · current scope: BTC multi-factor research model")}</h3><div class="research-ab-verdict"><b>${safeText(verdict?.label || tx("继续影子评估", "Continue shadow scoring"))}</b><span>${safeText(verdict?.reason || "")}</span></div><div class="research-ab-summary"><span>${tx("已配对结算", "Paired outcomes")} <b>${comparison.paired || 0}</b></span><span>${tx("总体 Brier", "Overall Brier")} <b>${metric(overallBase.brier)} → ${metric(overallCandidate.brier)}</b></span><span>${tx("总体 Log Loss", "Overall Log Loss")} <b>${metric(overallBase.logLoss)} → ${metric(overallCandidate.logLoss)}</b></span><span>${tx("成本后净收益", "Net after cost")} <b>${pct((overallBase.economic?.netReturn || 0) * 100)} → ${pct((overallCandidate.economic?.netReturn || 0) * 100)}</b></span></div><div class="research-ab-grid">${comparisonRows}</div><small>${tx("门槛：每周期 30 个配对样本；Brier 与 Log Loss 均至少优于 3%，BSS≥0，ECE 不恶化超过 5%，成本后净收益不低于现役，且已验证市场状态不显著退化。绿色仅表示建议人工复核，绝不自动切换。", "Gate: 30 paired outcomes per horizon; Brier and Log Loss each improve by 3%, BSS≥0, ECE no worse by over 5%, net after cost no lower, and no material degradation in validated regimes. Green means manual review only; it never auto-switches.")}</small></section>`
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
                  verdict?.label || tx("继续观察", "continue observing"),
                );
        const samples = comparison
          ? `${tx("配对", "paired")} ${comparison.paired || 0} · ${tx("每周期门槛", "per-horizon gate")} ${comparison.minSamples}`
          : safeText(experiment.note || "");
        return `<article class="ab-experiment ${tone}"><b>${safeText(experiment.name)}</b><span>${safeText(experiment.candidate)}</span><small>${status}${samples ? ` · ${samples}` : ""}</small>${comparison ? `<small>Brier ${metric(base.brier)} → ${metric(candidate.brier)} · Log Loss ${metric(base.logLoss)} → ${metric(candidate.logLoss)}</small>` : ""}</article>`;
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
  const labels = [
    [
      "#mainChartCard",
      () =>
        tx(
          `${selectedSource()} 行情 · 报价每 1 秒 · K 线/指标每 10 秒`,
          `${selectedSource()} market · quote 1s · candles/indicators 10s`,
        ),
    ],
    [
      "#ruleSignalCard",
      () =>
        tx(
          `${selectedSource()} K 线 · 每 15 秒评估`,
          `${selectedSource()} candles · evaluated every 15s`,
        ),
    ],
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
  };
})();

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
  card.innerHTML = `<div class="forecast-head"><div><h2>${tx("消息推送", "Message alerts")}</h2><p>${tx("SendKey 与规则仅保存在当前浏览器；本站服务器不会接收或保存。页面需保持打开才能监测并推送。", "The SendKey and rules stay only in this browser; this server never receives or stores them. Keep this page open for monitoring and delivery.")}</p></div><span id="wechatAlertState" class="badge flat"></span></div><form id="wechatKeyForm" class="wechat-key-form"><label>Server酱 SendKey<input name="sendKey" type="password" autocomplete="off" placeholder="SCT…"></label><a href="https://sct.ftqq.com/sendkey" target="_blank" rel="noopener">${tx("获取 SendKey", "Get SendKey")}</a><button type="submit">${tx("仅保存到本机", "Save locally only")}</button><button type="button" id="testLocalSendKey">${tx("测试推送", "Test push")}</button><button type="button" id="clearLocalSendKey" class="danger">${tx("清除本机 Key", "Clear local Key")}</button></form><form id="wechatAlertForm" class="wechat-alert-form"><label>${tx("触发类型", "Trigger")}<select name="kind"><option value="price_above">${tx("上涨到指定价", "Rises to target")}</option><option value="price_below">${tx("下跌到指定价", "Falls to target")}</option><option value="long_liquidation">${tx("多头爆仓价", "Long liquidation")}</option><option value="short_liquidation">${tx("空头爆仓价", "Short liquidation")}</option></select></label><label>${tx("触发价格（USDT）", "Target price (USDT)")}<input name="targetPrice" type="number" inputmode="decimal" min="0" step="0.01" required placeholder="80000"></label><label>${tx("触发冷却（分钟）", "Cooldown (minutes)")}<input name="cooldownMinutes" type="number" inputmode="numeric" min="0" step="1" value="0" required><small>${tx("0 = 不限制", "0 = no limit")}</small></label><button type="submit">${tx("添加推送规则", "Add alert rule")}</button></form><div id="wechatAlertDetail" class="wechat-alert-detail"></div>`;
  const footer = main.querySelector("footer");
  if (footer) main.insertBefore(card, footer);
  else main.append(card);
  const form = $("wechatAlertForm"),
    keyForm = $("wechatKeyForm"),
    stateEl = $("wechatAlertState"),
    detail = $("wechatAlertDetail"),
    keyInput = keyForm.elements.sendKey;
  keyInput.value = localStorage.getItem(sendKeyStorage) || "";
  const kindName = (kind) =>
    ({
      price_above: tx("上涨到指定价", "Rises to target"),
      price_below: tx("下跌到指定价", "Falls to target"),
      long_liquidation: tx("多头爆仓价", "Long liquidation"),
      short_liquidation: tx("空头爆仓价", "Short liquidation"),
    })[kind] || kind;
  const render = () => {
    const sendKey = (localStorage.getItem(sendKeyStorage) || "").trim(),
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
    const key = (localStorage.getItem(sendKeyStorage) || "").trim();
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
    if (key) localStorage.setItem(sendKeyStorage, key);
    else localStorage.removeItem(sendKeyStorage);
    render();
  });
  $("clearLocalSendKey").addEventListener("click", () => {
    localStorage.removeItem(sendKeyStorage);
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
    emaGap = (Math.abs(m.e20 - m.e50) / Math.max(m.close, 1)) * 100;
  let alert = null;
  if (m.rsi >= 72)
    alert = {
      kind: "warning",
      text: tx(
        `RSI 偏热 ${m.rsi.toFixed(1)} · 短线追高风险上升`,
        `RSI elevated ${m.rsi.toFixed(1)} · chasing risk rising`,
      ),
    };
  else if (m.rsi <= 28)
    alert = {
      kind: "warning",
      text: tx(
        `RSI 偏弱 ${m.rsi.toFixed(1)} · 短线波动可能放大`,
        `RSI weak ${m.rsi.toFixed(1)} · short-term volatility may expand`,
      ),
    };
  else if (Math.abs(five) >= Math.max(0.55, atrPct * 1.75))
    alert = {
      kind: "warning",
      text: tx(
        `近 5 根 K 线 ${pct(five)} · 短线快速${five > 0 ? "拉升" : "回撤"}`,
        `Last 5 candles ${pct(five)} · rapid short-term ${five > 0 ? "rise" : "pullback"}`,
      ),
    };
  else if (emaGap <= Math.max(0.035, atrPct * 0.42))
    alert = {
      kind: "caution",
      text: tx(
        `EMA 收敛 ${emaGap.toFixed(2)}% · 方向尚待确认`,
        `EMA convergence ${emaGap.toFixed(2)}% · direction awaits confirmation`,
      ),
    };
  else if (Math.abs(five) < Math.max(0.18, atrPct * 0.55))
    alert = {
      kind: "caution",
      text: tx(
        `近 5 根 K 线 ${pct(five)} · 短线震荡`,
        `Last 5 candles ${pct(five)} · short-term consolidation`,
      ),
    };
  if (!alert) {
    slot.className = "signal-alert-slot is-empty";
    slot.replaceChildren();
    placeRuleSignalMeta();
    return;
  }
  slot.className = `signal-alert-slot is-visible ${alert.kind}`;
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
  /* Preserve the compact header fields. */
  $("open24").textContent = money(ticker.open24h);
  /* Preserve the high and low text order. */
  $("highlow").textContent = `${money(ticker.high24)} / ${money(ticker.low24)}`;
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
  /* Update the hero source with the human-readable market label. */
  $("sourceUsed").textContent = market;
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
