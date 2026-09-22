// split-pane.js — 多分屏模式的单个轻量面板。
//
// 刻意保持「轻」：只渲染价格 / K线 / 规则信号三项（与 8787 主站同源的数据与算法），
// 不加载 notification / cloud-alerts / ai-chat / voice 等脚本，避免 4 个面板重复触发
// 推送、语音与 AI 会话。后端已按请求里的 ?symbol= 做币种隔离，这里只负责带参数拉数据。
//
// 关键不变量：app.js 里 `import { emaSeriesPadded as ema, ... }`，所以 metrics() 里
// 的 ema/rsi/atr 都是「全长度 + NaN 填充」的数组，索引取 [closes.length-1]。复刻必须一致。

import { COINS, normalizeCoin, pairLabel } from '/shared/coins.mjs';
import { emaSeriesPadded as ema, rsiSeriesPadded as rsi, atrSeriesPadded as atr } from '/shared/indicators.mjs';

const $ = (id) => document.getElementById(id);
const isEn = () => localStorage.getItem('btc_lang') === 'en';
const tx = (zh, en) => (isEn() ? en : zh);

// ── 复刻主站 signal 数学（与主站逐字节等价）──────────────────────────────────
function sma(values, p) {
  return values.map((_, i) =>
    i < p - 1 ? NaN : values.slice(i - p + 1, i + 1).reduce((a, b) => a + b, 0) / p,
  );
}
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
    sd = Math.sqrt(closes.slice(-20).reduce((s, x) => s + (x - basis) ** 2, 0) / 20);
  const bb = (closes[i] - (basis - 2 * sd)) / (4 * sd || 1);
  const atrV = at[i] || 1,
    atrPct = (atrV / closes[i]) * 100,
    mom5 = closes.length > 5 ? (closes[i] / closes[i - 5] - 1) * 100 : 0;
  let score = 0;
  score += e20[i] > e50[i] ? 25 : -25;
  score += closes[i] > e50[i] ? 20 : -20;
  score += Number.isFinite(e200[i]) ? (closes[i] > e200[i] ? 20 : -20) : 0;
  score += Math.max(-15, Math.min(15, (macd / (atrV * 1.2)) * 15));
  score += Math.max(-10, Math.min(10, (rs[i] - 50) / 2.5));
  score += Math.max(-10, Math.min(10, (bb - 0.5) * 20));
  const driftPct =
      Number.isFinite(livePrice) && livePrice > 0
        ? ((livePrice - closes[i]) / closes[i]) * 100
        : 0,
    recentDir = mom5 + driftPct * 1.5;
  let damped = 1;
  if (score !== 0 && recentDir !== 0 && Math.sign(score) !== Math.sign(recentDir))
    score *= (damped = 1 - 0.5 * Math.min(1, Math.abs(recentDir) / (atrPct * 1.5 || 0.1)));
  return {
    close: closes[i], e20: e20[i], e50: e50[i], e200: e200[i],
    rsi: rs[i], atr: at[i], macd, bb, mom5, atrPct, driftPct, recentDir, damped,
    score: Math.round(score),
  };
}
function classification(score) {
  return score >= 45 ? ['偏多', 'bull'] : score <= -45 ? ['偏空', 'bear'] : ['观望', 'flat'];
}
function ruleDirectionForScore(score, threshold = 45) {
  return score >= threshold ? 'bull' : score <= -threshold ? 'bear' : 'flat';
}
function ruleSignalLabel(kind) {
  return kind === 'bull' ? tx('做多', 'Long') : kind === 'bear' ? tx('做空', 'Short') : tx('观望', 'Wait');
}
// 轻量「稳定呈现」：与主站 headline 信号一致（带迟滞），仅在方向变化时写 localStorage，
// 避免每 4s 一次的高频写入。
function computeSignalState(candles, livePrice, symbol, interval) {
  if (!candles || candles.length < 200) return null;
  const m = metrics(candles, livePrice);
  const current = ruleDirectionForScore(m.score);
  const len = candles.length;
  const recent = [0, 1, 2].map((off) =>
    ruleDirectionForScore(metrics(candles.slice(0, len - off), livePrice).score),
  );
  const sustained = current !== 'flat' && recent.filter((k) => k === current).length >= 2;
  const key = `btc_split_signal_v1:${symbol}:${interval}`;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(key) || '{}'); } catch {}
  let held = saved.direction === 'bull' || saved.direction === 'bear' ? saved.direction : 'flat';
  if (held === 'flat' && sustained) held = current;
  else if (held !== 'flat' && sustained && current !== held) held = current;
  else if (held !== 'flat' && Math.abs(m.score) <= 28) held = 'flat';
  if (held !== saved.direction) {
    try { localStorage.setItem(key, JSON.stringify({ direction: held, savedAt: Date.now() })); } catch {}
  }
  const label = held !== 'flat' ? ruleSignalLabel(held) : classification(m.score)[0];
  const cls = held !== 'flat' ? held : classification(m.score)[1];
  return { label, cls, score: m.score, m };
}

// ── 运行时状态 ──────────────────────────────────────────────────────────────
const params = new URLSearchParams(location.search);
const symbol = normalizeCoin(params.get('symbol')) || 'BTC';
const paneIdx = params.get('pane') || '0';
const SOURCE = 'okx';
const prec = (COINS[symbol] && COINS[symbol].pricePrecision) || 2;

const MIN_COUNT = 20, MAX_COUNT = 800;

// 查看时长预设（与周期正交）：选定周期后想看多长时间跨度的数据。
const RANGE_ORDER = [
  { key: '4H', label: '4小时', sec: 4 * 3600 },
  { key: '1D', label: '1天', sec: 86400 },
  { key: '2D', label: '2天', sec: 2 * 86400 },
  { key: '1W', label: '1周', sec: 7 * 86400 },
  { key: 'ALL', label: '全部', sec: 0 },
];
const RANGE_DEFAULT = '2D';

function intervalToSec(iv) {
  const m = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 };
  return m[iv] || 900;
}
// 把"查看时长"换算成可见根数（ALL=全部 800 根）；依赖传入的 interval（避免初始化时读 state 触发 TDZ）。
function rangeToCount(key, iv) {
  const r = RANGE_ORDER.find((x) => x.key === key) || RANGE_ORDER.find((x) => x.key === RANGE_DEFAULT);
  if (!r) return 130;
  if (r.sec === 0) return MAX_COUNT;
  const c = Math.round(r.sec / intervalToSec(iv || '15m'));
  return Math.max(MIN_COUNT, Math.min(MAX_COUNT, c));
}

const state = {
  candles: [], ticker: null, signal: null, theme: 'dark', running: false,
  interval: params.get('interval') || '15m',
  range: params.get('range') || RANGE_DEFAULT,
  voiceOn: false, // 本币是否参与播报（由外壳推送，仅用于按钮图标；朗读由主站引擎统一做）
  tone: '', // 板块状态色：long（做多/涨 → 绿）/ short（做空/跌 → 红）/ ''（还没有数据）
  view: { count: rangeToCount(params.get('range') || RANGE_DEFAULT, params.get('interval') || '15m'), end: null }, // 缩放/平移窗口：可见根数 + 右端索引（null=最新）
};
let quoteTimer = null, marketTimer = null;

function money(v, p = prec) {
  if (!Number.isFinite(v)) return '--';
  return v.toLocaleString('en-US', { minimumFractionDigits: p, maximumFractionDigits: p });
}

// ── 渲染 ────────────────────────────────────────────────────────────────────
function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  // 关键：split.css 的 --sp-* 变量定义在 `body.sp-pane-page[data-theme=…]` 上，
  // 只设 <html> 会让面板页的涨跌色整组失效（拿到无效变量 → 默认白字）。body 也要设。
  if (document.body) document.body.dataset.theme = state.theme;
}
function renderHead() {
  const el = $('paneCoin');
  if (el) el.textContent = pairLabel(symbol);
}

/* ── 板块状态色（v2.12.18；v2.12.21 收窄）─────────────────────────────────────
   规则：**只在多空信号明确时才染色** —— 做多 → 绿、做空 → 红；**观望 → 不染色（中性）**。
   ⚠️ v2.12.18–2.12.20 曾在观望时按涨跌兜底染色，于是「观望 + 微跌」的币种整块变红，
   看着像在提示做空（用户报过：BNB 观望却是红的）。多空方向与涨跌是两套语义，
   别再互相兜底 —— 涨跌已经由价格/涨跌幅/K 线自己表达了。
   ⚠️ 本口子只染板块外框、顶部光晕、币种名与多空胶囊；价格 / 涨跌幅 / K 线一律不动。 */
function toneFor() {
  const kind = state.signal ? state.signal.cls : 'flat';
  if (kind === 'bull') return 'long';   // 做多
  if (kind === 'bear') return 'short';  // 做空
  return '';                            // 观望：不加状态色
}
function applyTone() {
  const tone = toneFor();
  state.tone = tone;
  const root = $('paneRoot');
  if (root) {
    if (tone) root.dataset.tone = tone;
    else delete root.dataset.tone;
  }
  /* 外框（格子卡片）在父窗口里，得让它一起染色。 */
  if (window.parent && window.parent !== window) {
    try {
      window.parent.postMessage({ type: 'split:tone', coin: symbol, tone, pane: paneIdx }, location.origin);
    } catch {}
  }
}
// 上次报价（用于检测本次 tick 的涨跌方向，触发逐位跳动特效）。
let prevLastNum = null;
let prevPriceText = null;

// 逐位跳动：只让价格中真正变化的那几位数字闪颜色 + 轻微上浮缩放。
// 与首页大屏版（#price 的 digit-flash）同一机制；涨跌口径与主站一致（v2.12.18 统一）：
// 上涨(rise)=绿、下跌(fall)=红。每次 tick 重建 innerHTML → 新节点 → 动画从头播放。
function digitFlashHTML(text, prev, dir) {
  const shift = prev == null ? 0 : text.length - prev.length;
  const out = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const isDigit = ch >= '0' && ch <= '9';
    const at = i - shift;
    const tick = isDigit && dir !== '' && (prev == null || at < 0 || prev[at] !== ch);
    if (isDigit) out.push(`<span class="price-digit${tick ? ` changed-${dir}` : ''}">${ch}</span>`);
    else out.push(ch);
  }
  return out.join('');
}
function renderPrice() {
  const price = $('panePrice'), change = $('paneChange');
  if (!state.ticker) {
    if (price) { price.textContent = '--'; prevLastNum = null; prevPriceText = null; }
    if (change) change.textContent = '--';
    return;
  }
  const last = state.ticker.last, pct = state.ticker.changePct;
  if (price) {
    const text = money(last);
    price.className = 'pane-price ' + (pct >= 0 ? 'bull' : 'bear');
    // 仅在运行中、且与上次不同、且有上次基准时才逐位跳动；否则纯文本（清掉旧 span）。
    if (state.running && prevPriceText != null && prevLastNum != null && text !== prevPriceText) {
      const dir = last > prevLastNum ? 'rise' : (last < prevLastNum ? 'fall' : '');
      price.innerHTML = digitFlashHTML(text, prevPriceText, dir);
    } else {
      price.textContent = text;
    }
    prevPriceText = text;
    prevLastNum = last;
  }
  if (change) {
    const up = pct >= 0;
    change.textContent = (up ? '+' : '−') + Math.abs(pct).toFixed(2) + '%';
    change.className = 'pane-change ' + (up ? 'bull' : 'bear');
  }
  applyTone();
}
function renderIndicators(m) {
  const box = $('paneIndicators');
  if (!box || !m) return;
  const rows = [
    ['EMA20', money(m.e20), m.close >= m.e20 ? 'bull' : 'bear'],
    ['EMA50', money(m.e50), m.close >= m.e50 ? 'bull' : 'bear'],
    ['EMA200', Number.isFinite(m.e200) ? money(m.e200) : '--', Number.isFinite(m.e200) ? (m.close >= m.e200 ? 'bull' : 'bear') : 'flat'],
    ['RSI', m.rsi.toFixed(2), m.rsi > 55 ? 'bull' : m.rsi < 45 ? 'bear' : 'flat'],
    ['BB%', (m.bb * 100).toFixed(1) + '%', m.bb > 0.6 ? 'bull' : m.bb < 0.4 ? 'bear' : 'flat'],
    ['ATR', money(m.atr), 'flat'],
  ];
  box.innerHTML = rows
    .map(([k, v, t]) => `<div class="metric"><span>${k}</span><b>${v}</b><i class="${t}">${t === 'bull' ? tx('多', 'B') : t === 'bear' ? tx('空', 'S') : '·'}</i></div>`)
    .join('');
}
function renderSignal() {
  const chip = $('paneSignal'), basis = $('paneBasis');
  if (!state.signal) { if (chip) { chip.textContent = '--'; chip.className = 'signal-chip flat'; } if (basis) basis.textContent = ''; applyTone(); return; }
  if (chip) { chip.textContent = state.signal.label; chip.className = 'signal-chip ' + state.signal.cls; }
  if (basis) basis.textContent = `${state.signal.score > 0 ? '+' : ''}${state.signal.score} · ${state.interval}`;
  renderIndicators(state.signal.m);
  applyTone();
}

// ── K 线（精简：蜡烛 + EMA20/50 + RSI 副图，支持缩放/平移窗口）──────────────
function palette() {
  const dark = state.theme !== 'light';
  return {
    up: '#28c76f', down: '#ef4d78', // 涨绿跌红（与主站 K 线同色，v2.12.18 统一口径）
    ema20: dark ? '#f0b90b' : '#d4a017',
    ema50: dark ? '#4ea1ff' : '#1f6feb',
    grid: dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.07)',
    axis: dark ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.45)',
    text: dark ? '#8b949e' : '#656d76',
    rsi: dark ? '#9b8cff' : '#6f5fff',
    guide: dark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.14)',
    tick: dark ? 'rgba(126,178,238,0.72)' : 'rgba(60,110,170,0.85)',
  };
}

// 底部时间轴标签格式化（与 8787 主站 formatTimeAxisLabel 同口径）：
// 短周期只显示 HH:mm；跨自然日或长周期（4h+ / 范围≥1天）追加 MM-DD；跨年再补年份。
function formatTimeAxisLabel(ms, showDate, showYear) {
  const d = new Date(ms);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (!showDate) return hm;
  const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return showYear ? `${d.getFullYear()}-${md} ${hm}` : `${md} ${hm}`;
}

// 根据当前 view 计算实际可见窗口 [start, end]。end=null 表示锚定在最新（数组末尾）。
function viewSlice() {
  const len = state.candles.length;
  if (len < 2) return { start: 0, end: Math.max(0, len - 1), count: len };
  let count = Math.max(MIN_COUNT, Math.min(MAX_COUNT, state.view.count));
  let end = state.view.end;
  if (end == null || end > len - 1) end = len - 1;
  let start = end - count + 1;
  if (start < 0) { start = 0; end = Math.min(len - 1, start + count - 1); }
  count = end - start + 1;
  return { start, end, count };
}

// 以窗口内光标比例 t∈[0,1] 为锚点缩放可见根数（factor<1 放大、>1 缩小）。
function zoomAt(t, factor) {
  const len = state.candles.length;
  if (len < 2) return;
  const v = viewSlice();
  const anchor = Math.round(v.start + t * (v.end - v.start));
  let count = Math.max(MIN_COUNT, Math.min(MAX_COUNT, Math.round(v.count * factor)));
  if (count > len) count = len;
  let start = Math.round(anchor - t * (count - 1));
  let end = start + count - 1;
  if (end > len - 1) { end = len - 1; start = end - count + 1; }
  if (start < 0) { start = 0; end = start + count - 1; }
  state.view.count = count;
  state.view.end = end;
  renderChart();
}
// 以中心为锚点缩放（按钮用）。
function zoomCenter(factor) { zoomAt(0.5, factor); }
// 平移：dCols>0 = 往更早看（右端索引减小），dCols<0 = 往更新的方向看。
function panBy(dCols) {
  const len = state.candles.length;
  if (len < 2) return;
  const v = viewSlice();
  let end = v.end - dCols;
  if (end > len - 1) end = len - 1;
  if (end < v.count - 1) end = v.count - 1;
  state.view.end = end;
  renderChart();
}
function resetView() { state.view = { count: rangeToCount(state.range, state.interval), end: null }; renderChart(); }

function renderRange() {
  const len = state.candles.length;
  const v = viewSlice();
  const zoomCount = $('zoomCount');
  if (zoomCount) zoomCount.textContent = v.count;
  const range = $('paneRange');
  if (range) {
    const r = RANGE_ORDER.find((x) => x.key === state.range);
    const rlabel = r ? r.label : state.range;
    const a = v.start + 1, b = v.end + 1;
    range.textContent = `${rlabel} · ${tx('区间', 'Range')} ${a}–${b} / ${len} · ${state.interval} · ${tx('滚轮缩放 · ⌘/Ctrl+滚轮平移 · 拖拽平移', 'Scroll zoom · ⌘/Ctrl+scroll pan · Drag pan')}`;
  }
}

function renderChart() {
  const canvas = $('paneChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const W = Math.max(10, rect.width), H = Math.max(10, rect.height);
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const candles = state.candles;
  if (!candles || candles.length < 2) { renderRange(); return; }

  const v = viewSlice();
  const { start, end, count } = v;
  const vis = candles.slice(start, end + 1);
  const closesAll = candles.map((c) => c.close);
  const e20a = ema(closesAll, 20), e50a = ema(closesAll, 50), rsiA = rsi(closesAll);

  let lo = Infinity, hi = -Infinity;
  for (const c of vis) { if (c.low < lo) lo = c.low; if (c.high > hi) hi = c.high; }
  for (let j = 0; j < vis.length; j++) {
    const i = start + j;
    if (Number.isFinite(e20a[i])) { lo = Math.min(lo, e20a[i]); hi = Math.max(hi, e20a[i]); }
    if (Number.isFinite(e50a[i])) { lo = Math.min(lo, e50a[i]); hi = Math.max(hi, e50a[i]); }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) { renderRange(); return; }
  const ppad = (hi - lo) * 0.06 || 1; lo -= ppad; hi += ppad;

  const COL = palette();
  const gap = 6, L = 6, R = 52, T = 6;
  const axisH = 16; // 底部时间轴高度
  const priceH = H * 0.62;            // 主图（价格 + EMA）占比
  const botTop = priceH + gap;        // 底部合并区：成交量柱 + RSI 线叠放
  const botBottom = H - axisH - gap;
  const botH = botBottom - botTop;
  const plotW = W - L - R;
  const x = (j) => L + (plotW * (j + 0.5)) / count;
  const yP = (val) => T + priceH * (1 - (val - lo) / (hi - lo));
  const yR = (val) => botBottom - (val / 100) * botH; // RSI 0..100 映射到整个底部区
  const cw = Math.max(1, (plotW / count) * 0.62);

  // 主图网格 + 右侧价格刻度
  ctx.lineWidth = 1;
  ctx.strokeStyle = COL.grid;
  ctx.fillStyle = COL.text;
  ctx.font = '10px -apple-system, sans-serif';
  ctx.textAlign = 'left';
  for (let g = 0; g <= 4; g++) {
    const yy = T + (priceH * g) / 4;
    ctx.beginPath(); ctx.moveTo(L, yy); ctx.lineTo(L + plotW, yy); ctx.stroke();
    const val = hi - ((hi - lo) * g) / 4;
    ctx.fillText(money(val), L + plotW + 4, yy + 3);
  }

  // 蜡烛
  for (let j = 0; j < vis.length; j++) {
    const c = vis[j], up = c.close >= c.open;
    ctx.strokeStyle = ctx.fillStyle = up ? COL.up : COL.down;
    ctx.beginPath(); ctx.moveTo(x(j), yP(c.high)); ctx.lineTo(x(j), yP(c.low)); ctx.stroke();
    const yo = yP(c.open), yc = yP(c.close), top = Math.min(yo, yc), h = Math.max(1, Math.abs(yc - yo));
    ctx.fillRect(x(j) - cw / 2, top, cw, h);
  }

  // EMA 线
  const drawLine = (series, color) => {
    ctx.strokeStyle = color; ctx.lineWidth = 1.4; ctx.beginPath();
    let started = false;
    for (let j = 0; j < vis.length; j++) {
      const i = start + j;
      const val = series[i];
      if (!Number.isFinite(val)) { started = false; continue; }
      const px = x(j), py = yP(val);
      if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
    }
    ctx.stroke();
  };
  drawLine(e20a, COL.ema20);
  drawLine(e50a, COL.ema50);

  // 最新价虚线 + 标签
  const lastC = vis[vis.length - 1];
  ctx.strokeStyle = COL.axis; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(L, yP(lastC.close)); ctx.lineTo(L + plotW, yP(lastC.close)); ctx.stroke();
  ctx.setLineDash([]);

  // ── 底部合并区：成交量柱（半透明，贴底） + RSI 线（叠放其上）──
  // 成交量柱
  let volMax = 0;
  for (const c of vis) if (c.volume > volMax) volMax = c.volume;
  if (volMax > 0) {
    const volAreaH = botH * 0.5;
    ctx.save();
    ctx.globalAlpha = 0.32;
    for (let j = 0; j < vis.length; j++) {
      const c = vis[j], up = c.close >= c.open;
      const h = Math.max(1, (c.volume / volMax) * volAreaH);
      ctx.fillStyle = up ? COL.up : COL.down;
      ctx.fillRect(x(j) - cw / 2, botBottom - h, cw, h);
    }
    ctx.restore();
  }
  // RSI 指引线 30/70 + RSI 线（叠加在成交量之上）
  ctx.strokeStyle = COL.guide; ctx.setLineDash([2, 3]);
  for (const lvl of [30, 70]) {
    const yy = yR(lvl);
    ctx.beginPath(); ctx.moveTo(L, yy); ctx.lineTo(L + plotW, yy); ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.strokeStyle = COL.rsi; ctx.lineWidth = 1.3; ctx.beginPath();
  let started = false;
  for (let j = 0; j < vis.length; j++) {
    const i = start + j;
    const val = rsiA[i];
    if (!Number.isFinite(val)) { started = false; continue; }
    const px = x(j), py = yR(val);
    if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
  }
  ctx.stroke();
  // 区域标签
  ctx.fillStyle = COL.text;
  ctx.font = '10px -apple-system, sans-serif';
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillText('RSI', L + 2, botTop + 11);
  if (volMax > 0) ctx.fillText('VOL', L + 2, botBottom - 3);

  // ── 底部时间轴 ──
  const rsiBottom = botBottom;
  const axisY = rsiBottom + 2;
  const intervalMins = intervalToSec(state.interval) / 60;
  const isLongTerm = intervalMins >= 240; // 4h+
  const fDate = new Date(vis[0].time), lDate = new Date(vis[vis.length - 1].time);
  const crossesDay =
    fDate.getFullYear() !== lDate.getFullYear() ||
    fDate.getMonth() !== lDate.getMonth() ||
    fDate.getDate() !== lDate.getDate();
  const rSec = (RANGE_ORDER.find((r) => r.key === state.range) || {}).sec || 0;
  const showDate = isLongTerm || rSec >= 86400 || crossesDay;
  const showYear = showDate && fDate.getFullYear() !== lDate.getFullYear();
  const labelMinGap = showYear ? 150 : showDate ? 110 : 72;
  const maxTimeLabels = Math.max(2, Math.floor(plotW / labelMinGap));
  const timeStep = Math.max(1, Math.ceil((count - 1) / (maxTimeLabels - 1)));
  // 轴线
  ctx.strokeStyle = COL.grid; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(L, axisY); ctx.lineTo(L + plotW, axisY); ctx.stroke();
  // 刻度短线 + 时间标签（随可见范围 / 缩放 / 周期动态调密度与格式）
  ctx.fillStyle = COL.text;
  ctx.font = '10px -apple-system, sans-serif';
  ctx.textBaseline = 'top';
  ctx.strokeStyle = COL.tick; ctx.lineWidth = 2;
  for (let j = 0; j < vis.length; j += timeStep) {
    const xx = x(j);
    const txt = formatTimeAxisLabel(vis[j].time, showDate, showYear);
    const tw = ctx.measureText(txt).width;
    ctx.beginPath(); ctx.moveTo(xx, axisY - 5); ctx.lineTo(xx, axisY); ctx.stroke();
    ctx.textAlign = xx - tw / 2 < L ? 'left' : xx + tw / 2 > L + plotW ? 'right' : 'center';
    ctx.fillText(
      txt,
      ctx.textAlign === 'left' ? L : ctx.textAlign === 'right' ? L + plotW : xx,
      axisY + 3,
    );
  }

  renderRange();
}

function recomputeSignal() {
  if (!state.candles || state.candles.length < 200) return;
  const live = state.ticker && Number.isFinite(state.ticker.last) ? state.ticker.last : state.candles[state.candles.length - 1].close;
  state.signal = computeSignalState(state.candles, live, symbol, state.interval);
  renderSignal();
  renderChart();
}
function setStatus(msg) { const el = $('paneStatus'); if (el) el.textContent = msg || ''; }

// ── 数据拉取 ────────────────────────────────────────────────────────────────
async function loadQuote() {
  try {
    const r = await fetch(`/api/quote?source=${SOURCE}&symbol=${symbol}`, { cache: 'no-store' });
    if (!r.ok) throw 0;
    const d = await r.json();
    state.ticker = d.ticker || null;
    if (state.ticker) { renderPrice(); recomputeSignal(); }
    /* 把最新价喂给外壳（主站语音引擎）：分屏里每个币种的规则判定与发声都由主站那一套
       引擎做 —— 引擎 / 音色 / 音量与不分屏页面完全一致，面板自己不再朗读。 */
    if (state.ticker && Number.isFinite(state.ticker.last)) {
      try {
        window.parent.postMessage(
          { type: 'split:voice-price', coin: symbol, price: state.ticker.last, pane: paneIdx },
          location.origin,
        );
      } catch {}
    }
    setStatus('');
  } catch (e) {
    setStatus(tx('价格获取失败，重试中…', 'Price fetch failed, retrying…') + (e && (e.stack || e.message) ? ' ⚠ ' + (e.stack || e.message).split('\n').slice(0, 2).join(' | ') : ''));
  }
}
async function loadMarket() {
  try {
    const r = await fetch(`/api/market?source=${SOURCE}&interval=${state.interval}&limit=801&symbol=${symbol}`, { cache: 'no-store' });
    if (!r.ok) throw 0;
    const d = await r.json();
    const c = (d.candles || []).slice(0, -1).slice(-800);
    if (c.length >= 2) {
      // 轮询换数据时保持用户的缩放/平移窗口：按最新一根的时间差平移索引。
      const old = state.candles;
      let shift = 0;
      if (old.length >= 2) {
        const dur = old[old.length - 1].time - old[old.length - 2].time;
        if (dur > 0) shift = Math.round((c[c.length - 1].time - old[old.length - 1].time) / dur);
      }
      state.candles = c;
      if (state.view.end != null && shift !== 0) state.view.end += shift;
      recomputeSignal();
      renderChart();
    }
    setStatus('');
  } catch (e) {
    setStatus(tx('K线获取失败，重试中…', 'Candle fetch failed, retrying…') + (e && (e.stack || e.message) ? ' ⚠ ' + (e.stack || e.message).split('\n').slice(0, 2).join(' | ') : ''));
  }
}

// 父窗口/控件请求切换周期：保持"查看时长"语义不变（按新周期重新换算根数），重拉数据。
function applyInterval(iv) {
  if (!iv || iv === state.interval) return;
  state.interval = iv;
  state.view = { count: rangeToCount(state.range, iv), end: null };
  loadMarket();
}
// 父窗口/控件请求切换"查看时长"：根数按当前周期换算，数据已齐无需重拉，直接重绘。
function applyRange(key) {
  if (!key || key === state.range) return;
  state.range = key;
  state.view = { count: rangeToCount(key, state.interval), end: null };
  renderChart();
  renderRange();
}

// ── 轮询控制（由父窗口 resume/pause 驱动；面板自身初始为暂停）────────────────
function start() {
  if (state.running) return;
  state.running = true;
  loadMarket();
  loadQuote();
  quoteTimer = setInterval(loadQuote, 4000);
  marketTimer = setInterval(loadMarket, 20000);
}
function stop() {
  state.running = false;
  clearInterval(quoteTimer); clearInterval(marketTimer);
  quoteTimer = marketTimer = null;
  setSpeaking(false);
}

window.addEventListener('message', (e) => {
  if (e.source !== window.parent) return; // 只接受父窗口（分屏覆盖层）指令
  const msg = e.data || {};
  if (msg.type === 'split:theme') { state.theme = msg.theme; applyTheme(); renderChart(); }
  else if (msg.type === 'split:interval') applyInterval(msg.interval);
  else if (msg.type === 'split:range') applyRange(msg.range);
  else if (msg.type === 'split:voice') { state.voiceOn = !!msg.on; updateVoiceBtn(); }
  else if (msg.type === 'split:voice-active') setSpeaking(!!msg.speaking);
  else if (msg.type === 'split:voice-trigger') { /* v2.12.17 起播报由主站引擎统一做，面板不再自己出声 */ }
  else if (msg.type === 'split:resume') start();
  else if (msg.type === 'split:pause') stop();
});

// ── 图表交互：滚轮缩放 · ⌘/Ctrl+滚轮平移 · 拖拽平移 · 双击重置 · 底部 ± 按钮 ──
// 点击图表 → 请求外壳放大单看（split:expand，首页详细浮层）。
function bindChartInteractions() {
  const canvas = $('paneChart');
  if (!canvas) return;
  canvas.style.cursor = 'grab';

  canvas.addEventListener('wheel', (e) => {
    /* 两套手势，与主站图表口径一致：
       · 不带修饰键 → 以光标为锚点缩放（分屏面板小，滚轮直接缩放最顺手）；
       · ⌘ / Ctrl + 滚轮 → 横向平移（同主站图表与工具栏「按住 ⌘ / Ctrl + 滚轮」，
         一次滚动移可见宽度的 10%，向下滚看更早、向上滚看更新）。
       触控板横滑给 deltaX、纵向滚轮给 deltaY，取主导分量。 */
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      const dx = e.deltaX || 0, dy = e.deltaY || 0,
        delta = Math.abs(dx) > Math.abs(dy) ? dx : dy;
      if (!delta || state.candles.length < 2) return;
      const step = Math.max(1, Math.round(viewSlice().count * 0.1));
      /* 方向与主站一致：向下滚（delta>0）＝ 往更早看，向上滚回最新。 */
      panBy(delta > 0 ? step : -step);
      return;
    }
    e.preventDefault();
    /* 纯横滑（触控板双指左右）不带修饰键时不动作：它既不是缩放也不该被当成缩放，
       否则会莫名缩小。 */
    const dy = e.deltaY || 0;
    if (!dy) return;
    const rect = canvas.getBoundingClientRect();
    const plotW = rect.width - 6 - 52;
    const t = Math.max(0, Math.min(1, (e.clientX - rect.left - 6) / plotW));
    zoomAt(t, dy < 0 ? 0.82 : 1 / 0.82);
  }, { passive: false });

  let downX = 0, downY = 0, lastX = 0, movedFar = false;

  canvas.addEventListener('mousedown', (e) => {
    downX = e.clientX; downY = e.clientY; lastX = e.clientX; movedFar = false;
    canvas.style.cursor = 'grabbing';
  });

  window.addEventListener('mousemove', (e) => {
    if (movedFar === false && Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 5) movedFar = true;
    if (!movedFar) return;
    const rect = canvas.getBoundingClientRect();
    const bw = (rect.width - 6 - 52) / viewSlice().count;
    const dx = e.clientX - lastX;
    if (Math.abs(dx) >= bw) {
      const dCols = Math.round(dx / bw);
      panBy(-dCols); // 鼠标左移(dx<0) → 看历史（end 减小）
      lastX = e.clientX;
    }
  });

  window.addEventListener('mouseup', (e) => {
    if (!movedFar) {
      // 视为点击：请求外壳放大单看（首页详细浮层）。
      try { window.parent.postMessage({ type: 'split:expand', pane: paneIdx }, location.origin); } catch {}
    }
    movedFar = false;
    canvas.style.cursor = 'grab';
  });

  canvas.addEventListener('dblclick', () => resetView());

  const zin = $('zoomIn'), zout = $('zoomOut');
  if (zin) zin.addEventListener('click', () => zoomCenter(0.82));
  if (zout) zout.addEventListener('click', () => zoomCenter(1 / 0.82));
}

// ── 语音播报（面板侧只管显示，朗读统一由主站语音引擎做）──────────────────────
// v2.12.17：面板不再自己出声。每次拿到报价把价格喂给外壳（split:voice-price），由主站
// 引擎按【该币种自己的语音规则 + 主站引擎 / 音色 / 音量】判定并播报 —— 与不分屏页面一致。
// 本币是否参与播报由外壳推送（split:voice），这里只读不写，避免两处各写一份。
// ⚠️ 与外壳一致用 sessionStorage（会话级）——同源 iframe 共享同一份，旧版写在
// localStorage 里的「已关闭」记录不会再影响这里。
const VOICE_KEY = 'btc_split_voice_v1';
function readVoiceMap() { try { return JSON.parse(sessionStorage.getItem(VOICE_KEY)) || {}; } catch { return {}; } }
function updateVoiceBtn() {
  const b = $('paneVoice');
  if (!b) return;
  // 图标状态与主站 .voice-quick-toggle 同一套约定：on=显示声波，is-muted=显示红斜线，
  // is-speaking=播报进行中的声波闪烁动效（CSS 负责）。绝不用 textContent 改图标，
  // 否则会把 HTML 里的 SVG 直接顶掉（本条曾有并发会话写回旧版踩过）。
  b.classList.toggle('on', state.voiceOn);
  b.classList.toggle('is-muted', !state.voiceOn);
  if (!state.voiceOn) b.classList.remove('is-speaking');
  b.title = state.voiceOn
    ? tx(`打开 ${symbol} 语音播报设置（本币正在播报）`, `Open ${symbol} voice settings · broadcasting`)
    : tx(`打开 ${symbol} 语音播报设置（本币未参与分屏播报）`, `Open ${symbol} voice settings · not broadcasting`);
  b.setAttribute('aria-label', b.title);
}
/* 播报进行中（由外壳驱动：主站引擎正在念这个币种）→ 按钮加「播报中」动效。
   v2.12.17 起面板不再自己朗读：规则判定与发声都交给主站语音引擎（引擎 / 音色 / 音量
   与不分屏页面一致），面板只负责显示状态，也不再往父窗口回报。 */
function setSpeaking(speaking) {
  const b = $('paneVoice');
  if (b) b.classList.toggle('is-speaking', !!speaking && state.voiceOn);
}
/* 开关态由外壳推过来（总开关 × 该币种开关）：写 localStorage 只在分屏设置面板那一处，
   两处各写一份会互相打脸。这里额外做一次**同源兜底**——直接读父窗口里那颗主站
   「语音总开关」：面板脚本就绪那一刻外壳可能还没推（外壳的推送早于本模块执行），
   不兜底会先闪一下静音图标。规则与外壳的 coinVoiceOn 一致：没单独设置过 = 跟随总开关。 */
function shellMasterOn() {
  try {
    const box = window.parent.document.getElementById('voiceAlertEnabled');
    return !!(box && box.checked);
  } catch { return false; }
}
function applyVoiceState() {
  const m = readVoiceMap();
  state.voiceOn = shellMasterOn() && (symbol in m ? !!m[symbol] : true);
  updateVoiceBtn();
}

function init() {
  applyTheme();
  renderHead();
  renderPrice();
  applyVoiceState();
  // 通知父窗口本面板已就绪，父窗口会回发主题与 resume/pause。
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ type: 'split:ready', pane: paneIdx, symbol }, location.origin);
    // 同步语音开关状态给父窗口顶部优先级面板。
    window.parent.postMessage({ type: 'split:voice-register', pane: paneIdx, coin: symbol, on: state.voiceOn }, location.origin);
  }
  const wrap = document.querySelector('.pane-chart-wrap');
  if (wrap && window.ResizeObserver) {
    new ResizeObserver(() => renderChart()).observe(wrap);
  }
  bindChartInteractions();
  const vb = $('paneVoice');
  if (vb) vb.addEventListener('click', (e) => {
    e.stopPropagation();
    /* v2.12.16：这颗喇叭是「普通模式（非分屏）下该币种播报按钮」的软链接 ——
       点它打开的是主站的「语音播报设置」浮层（币种自动切到本面板的币种，关掉后还原）。
       v2.12.17：本币是否参与播报改由分屏顶部的「播报设置」面板控制，这里不再切换。 */
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: 'split:voice-open', coin: symbol, pane: paneIdx }, location.origin);
    }
  });
}
try { init(); } catch (e) {
  const s = $('paneStatus');
  if (s) s.textContent = tx('面板初始化失败：', 'Pane init failed: ') + (e && (e.message || e));
}
