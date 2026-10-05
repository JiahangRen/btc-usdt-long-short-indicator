// Kronos 预测卡：在「AI 预测」板块下展示 BTC 上涨/波动放大 AI 预测。
// 独立 ES module，自执行，不经 app.js 巨型文件（避免回归）。
// 复用站点共享内核 core.js（$/tx/apiFetch/money/time）与主题色。
// 图表用轻量独立 canvas 绘制（零新增图表库、最省性能）。
import { $, tx, apiFetch, money, safeText } from '../core.js?v=20260928a';

const FORECAST_URL = '/api/kronos/forecast';
// 自动刷新间隔：默认 60 分钟，用户可在卡片「自动刷新间隔」输入框自定义（分钟，存 localStorage）。
const REFRESH_KEY = 'kronos:refreshMin';
const REFRESH_MIN_DEFAULT = 60;
const REFRESH_MIN_MIN = 0.5;        // 最短 30 秒
const REFRESH_MIN_MAX = 1440;       // 最长 24 小时
const FETCH_TIMEOUT = 90_000;       // 冷缓存首调可能需 40~80s（加载模型+推理），放宽超时

// 读取用户设定的刷新间隔（分钟），带范围钳制与容错。
function getRefreshMin() {
  let min;
  try { min = parseFloat(localStorage.getItem(REFRESH_KEY)); } catch (e) { min = NaN; }
  if (!isFinite(min) || min <= 0) min = REFRESH_MIN_DEFAULT;
  return Math.min(REFRESH_MIN_MAX, Math.max(REFRESH_MIN_MIN, min));
}
function getRefreshMs() {
  return Math.round(getRefreshMin() * 60 * 1000);
}

// 涨跌配色：读主题变量（深/浅主题各自定义，浅色下为深色变体保证对比度）。
// canvas fillStyle 不支持 var()，所以用函数即时求值；DOM 内联样式同样适用。
function themeVar(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch (e) { return fallback; }
}
const UP = () => themeVar('--bull', '#00d4aa');
const DOWN = () => themeVar('--bear', '#ff4d6a');
const NEUTRAL = () => themeVar('--text-muted', '#9aa4b2');
const HIST_BLUE = '#4ea6ff';

// 24h 走势形状 i18n 映射（与 inference.classify_path_shape 返回的键保持一致）
const SHAPE_LABELS = {
  up_sustained:   { zh: '持续上涨', en: 'Sustained rise' },
  down_sustained: { zh: '持续下跌', en: 'Sustained drop' },
  up_then_down:   { zh: '先涨后跌', en: 'Rise then drop' },
  down_then_up:   { zh: '先跌后涨', en: 'Drop then rise' },
  up_choppy:      { zh: '震荡上行', en: 'Choppy up' },
  down_choppy:    { zh: '震荡下行', en: 'Choppy down' },
  choppy:         { zh: '横盘震荡', en: 'Choppy / flat' },
};
function shapeLabel(key) {
  const item = SHAPE_LABELS[key] || { zh: key, en: key };
  return tx(item.zh, item.en);
}
const FORECAST_ORANGE = '#ff9f45';
const FORECAST_SHADE = 'rgba(255, 159, 69, 0.42)';
const DIVIDER = '#ff4d6a';
const GRID = 'rgba(154, 167, 182, 0.12)';
const TEXT = '#9aa4b2';

function formatGen(iso) {
  if (!iso) return '--';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function fmtPercent(n) {
  return Number.isFinite(n) ? (n * 100).toFixed(1) + '%' : '--';
}

let forecastInFlight = false; // 防止用户把刷新间隔设得很短导致请求重叠
function loadAndRender() {
  const card = $('kronos-forecast-card');
  if (!card) return;
  if (forecastInFlight) return;
  forecastInFlight = true;
  apiFetch(FORECAST_URL, FETCH_TIMEOUT)
    .then((res) => {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then((data) => render(card, data))
    .catch((e) => {
      const upProb = $('kf-up-prob');
      if (upProb) upProb.textContent = tx('预测暂时不可用', 'Forecast unavailable') + '（' + safeText(e.message) + '）';
    })
    .finally(() => { forecastInFlight = false; });
}

function render(card, d) {
  // 方向判定：用于上涨概率卡片颜色（绿色=上涨占优，红色=下跌占优，灰色=中性）
  const up = d.direction === 'up';
  const neutral = d.direction === 'neutral';
  const dirColor = neutral ? NEUTRAL() : (up ? UP() : DOWN());

  $('kf-exchange').textContent = (d.exchange || 'okx').toUpperCase();

  // 上涨概率大数字卡片
  const upProbEl = $('kf-up-prob');
  upProbEl.textContent = fmtPercent(d.pUp);
  upProbEl.style.color = dirColor;
  const upCard = $('kf-up-card');
  upCard.classList.remove('kf-up', 'kf-down', 'kf-neutral');
  upCard.classList.add(neutral ? 'kf-neutral' : (up ? 'kf-up' : 'kf-down'));

  // 波动放大卡片：颜色与方向解耦，按概率本身着色（高=橙，中=黄，低=灰）
  const volProbEl = $('kf-vol-prob');
  const pVol = d.pVolatilityAmplification;
  volProbEl.textContent = fmtPercent(pVol);
  const volCard = $('kf-vol-card');
  volCard.classList.remove('kf-vol-low', 'kf-vol-mid', 'kf-vol-high');
  if (pVol < 0.35) volCard.classList.add('kf-vol-low');
  else if (pVol < 0.65) volCard.classList.add('kf-vol-mid');
  else volCard.classList.add('kf-vol-high');

  // 24h 预测走势形状（基于均值预测的 close 路径）
  const shapeEl = $('kf-forecast-shape');
  if (shapeEl) {
    shapeEl.textContent = d.predictedPathShape ? shapeLabel(d.predictedPathShape) : '--';
  }

  $('kf-updated').textContent = tx('更新于 ', 'Updated ') + formatGen(d.generatedAt);

  // 绘制价格/成交量双图
  const priceCanvas = $('kf-price-chart');
  const volumeCanvas = $('kf-volume-chart');
  if (priceCanvas && Array.isArray(d.forecast) && d.forecast.length) {
    drawPriceChart(priceCanvas, d);
  }
  if (volumeCanvas && Array.isArray(d.forecast) && d.forecast.length) {
    drawVolumeChart(volumeCanvas, d);
  }
}

// 统一准备时间序列：历史段 + 预测段，并在分界处插入红色虚线。
function makeSeries(d) {
  const history = Array.isArray(d.history) ? d.history : [];
  const forecast = Array.isArray(d.forecast) ? d.forecast : [];
  const range = Array.isArray(d.forecastRange) ? d.forecastRange : [];
  return { history, forecast, range };
}

function setupCanvas(canvas, heightCss = 220) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(240, Math.floor(rect.width || canvas.clientWidth || 320));
  const h = heightCss;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const c = canvas.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  return { c, w, h };
}

function drawGrid(c, w, h, pad) {
  c.strokeStyle = GRID;
  c.lineWidth = 1;
  c.beginPath();
  for (let i = 1; i < 4; i++) {
    const y = pad.top + (h - pad.top - pad.bottom) * (i / 4);
    c.moveTo(pad.left, y);
    c.lineTo(w - pad.right, y);
  }
  c.stroke();
}

function drawYAxisLabels(c, w, h, pad, min, max, formatter) {
  c.fillStyle = TEXT;
  c.font = '11px sans-serif';
  c.textAlign = 'left';
  for (let i = 0; i <= 4; i++) {
    const v = max - (max - min) * (i / 4);
    const y = pad.top + (h - pad.top - pad.bottom) * (i / 4) + 4;
    c.fillText(formatter(v), 4, y);
  }
}

function drawDivider(c, x, yTop, yBottom) {
  c.strokeStyle = DIVIDER;
  c.lineWidth = 1.5;
  c.setLineDash([6, 4]);
  c.beginPath();
  c.moveTo(x, yTop);
  c.lineTo(x, yBottom);
  c.stroke();
  c.setLineDash([]);
}

function drawXAxisLabels(c, w, h, pad, history, forecast) {
  if (!history.length && !forecast.length) return;
  const total = history.length + forecast.length;

  c.fillStyle = TEXT;
  c.font = '10px sans-serif';
  c.textAlign = 'center';

  const labelCount = 5;
  const seen = new Set();
  for (let i = 0; i < labelCount; i++) {
    const frac = i / (labelCount - 1);
    const idx = Math.round(frac * (total - 1));
    const x = pad.left + frac * (w - pad.left - pad.right);
    let item;
    if (idx < history.length) item = history[idx];
    else item = forecast[idx - history.length];
    const d = new Date(item.t);
    const label = `${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')} ${d.getHours().toString().padStart(2, '0')}:00`;
    // 避免相邻标签重复导致堆叠
    if (seen.has(label)) continue;
    seen.add(label);
    c.fillText(label, x, h - 4);
  }
}

function drawPriceChart(canvas, d) {
  const { history, forecast, range } = makeSeries(d);
  const { c, w, h } = setupCanvas(canvas, 260);
  const pad = { top: 18, right: 12, bottom: 24, left: 64 };

  const histLen = history.length;
  const total = histLen + forecast.length;
  const xOf = (i) => pad.left + (i / (total - 1)) * (w - pad.left - pad.right);
  const xDivider = xOf(histLen - 0.5);

  let min = Infinity, max = -Infinity;
  for (const p of history) { if (p.close < min) min = p.close; if (p.close > max) max = p.close; }
  for (const p of forecast) { if (p.close < min) min = p.close; if (p.close > max) max = p.close; }
  for (const r of range) { if (r.min < min) min = r.min; if (r.max > max) max = r.max; }
  const margin = (max - min) * 0.08 || 1;
  min -= margin; max += margin;
  const yOf = (p) => pad.top + (1 - (p - min) / (max - min)) * (h - pad.top - pad.bottom);

  drawGrid(c, w, h, pad);
  drawYAxisLabels(c, w, h, pad, min, max, (v) => money(v).replace('$', ''));

  // 预测范围阴影（橙色）
  if (range.length) {
    c.fillStyle = FORECAST_SHADE;
    c.beginPath();
    const startIdx = histLen;
    for (let i = 0; i < range.length; i++) {
      const x = xOf(startIdx + i);
      const y = yOf(range[i].max);
      if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    for (let i = range.length - 1; i >= 0; i--) {
      const x = xOf(startIdx + i);
      const y = yOf(range[i].min);
      c.lineTo(x, y);
    }
    c.closePath();
    c.fill();
  }

  // 历史价格折线（蓝色）
  if (history.length) {
    c.strokeStyle = HIST_BLUE;
    c.lineWidth = 2;
    c.beginPath();
    for (let i = 0; i < history.length; i++) {
      const x = xOf(i);
      const y = yOf(history[i].close);
      if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.stroke();
  }

  // 预测均值线（橙色）
  if (forecast.length) {
    c.strokeStyle = FORECAST_ORANGE;
    c.lineWidth = 2;
    c.beginPath();
    for (let i = 0; i < forecast.length; i++) {
      const x = xOf(histLen + i);
      const y = yOf(forecast[i].close);
      if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.stroke();
  }

  drawDivider(c, xDivider, pad.top, h - pad.bottom);
  drawXAxisLabels(c, w, h, pad, history, forecast);

  // 图例
  c.font = '11px sans-serif';
  const legendY = 12;
  const items = [
    { color: HIST_BLUE, text: tx('历史价格', 'Historical Price') },
    { color: FORECAST_ORANGE, text: tx('均值预测', 'Mean Forecast') },
    { color: FORECAST_SHADE, text: tx('预测范围', 'Forecast Range') },
  ];
  let lx = pad.left;
  for (const item of items) {
    c.fillStyle = item.color;
    c.fillRect(lx, legendY - 8, 12, 4);
    c.fillStyle = TEXT;
    c.textAlign = 'left';
    c.fillText(item.text, lx + 16, legendY - 2);
    lx += 16 + c.measureText(item.text).width + 20;
  }

  // 挂几何信息到 canvas，供鼠标悬停 tooltip 读取价格
  canvas._priceDetails = { history, forecast, range };
  canvas._priceGeom = { xOf, yOf, pad, h, xDivider };
  if (!canvas._priceHasListeners) {
    canvas._priceHasListeners = true;
    canvas.addEventListener('mousemove', onPriceHover);
    canvas.addEventListener('mouseleave', onPriceLeave);
    canvas.addEventListener('click', onPriceHover);
  }
}

function drawVolumeChart(canvas, d) {
  const { history, forecast } = makeSeries(d);
  const { c, w, h } = setupCanvas(canvas, 110);
  const pad = { top: 14, right: 12, bottom: 24, left: 64 };

  const histLen = history.length;
  const total = histLen + forecast.length;
  const xOf = (i) => pad.left + (i / (total - 1)) * (w - pad.left - pad.right);
  const xDivider = xOf(histLen - 0.5);

  let maxVol = 0;
  for (const p of history) maxVol = Math.max(maxVol, p.volume);
  for (const p of forecast) maxVol = Math.max(maxVol, p.volume);
  maxVol *= 1.15;
  if (maxVol <= 0) maxVol = 1;
  const yOf = (v) => h - pad.bottom - (v / maxVol) * (h - pad.top - pad.bottom);
  const barW = (w - pad.left - pad.right) / total * 0.7;

  drawGrid(c, w, h, pad);

  // 历史成交量（蓝色柱）
  c.fillStyle = HIST_BLUE;
  for (let i = 0; i < history.length; i++) {
    const x = xOf(i) - barW / 2;
    const y = yOf(history[i].volume);
    c.fillRect(x, y, barW, h - pad.bottom - y);
  }

  // 预测成交量（橙色柱）
  c.fillStyle = FORECAST_ORANGE;
  for (let i = 0; i < forecast.length; i++) {
    const x = xOf(histLen + i) - barW / 2;
    const y = yOf(forecast[i].volume);
    c.fillRect(x, y, barW, h - pad.bottom - y);
  }

  drawDivider(c, xDivider, pad.top, h - pad.bottom);

  // 成交量 y 轴标签
  c.fillStyle = TEXT;
  c.font = '11px sans-serif';
  c.textAlign = 'left';
  c.fillText('0', 4, h - pad.bottom + 4);
  c.fillText(formatVolume(maxVol), 4, pad.top + 10);

  // 图例
  c.font = '11px sans-serif';
  const legendY = 10;
  const items = [
    { color: HIST_BLUE, text: tx('历史成交量', 'Historical Volume') },
    { color: FORECAST_ORANGE, text: tx('预测成交量', 'Mean Forecasted Volume') },
  ];
  let lx = pad.left;
  for (const item of items) {
    c.fillStyle = item.color;
    c.fillRect(lx, legendY - 7, 12, 4);
    c.fillStyle = TEXT;
    c.textAlign = 'left';
    c.fillText(item.text, lx + 16, legendY - 1);
    lx += 16 + c.measureText(item.text).width + 20;
  }
}

function formatVolume(v) {
  if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return v.toFixed(0);
}

// ── 历史准确度回测 ───────────────────────────────────────────────────────────
const BACKTEST_URL = '/api/kronos/backtest?days=30&exchange=binance';
const BACKTEST_TIMEOUT = 600_000; // daily 30 锚点冷算约 6~9 分钟，放宽超时让 Redis 未热时也能跑完

function loadBacktest() {
  const card = $('kronos-forecast-card');
  if (!card) return;
  apiFetch(BACKTEST_URL, BACKTEST_TIMEOUT)
    .then((res) => { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
    .then((data) => renderBacktest(card, data))
    .catch((e) => {
      const note = $('kf-backtest-note');
      if (note) note.textContent = tx('回测暂时不可用', 'Backtest unavailable') + '（' + safeText(e.message) + '）';
    });
}

function renderBacktest(card, d) {
  $('kf-backtest-exchange').textContent = (d.exchange || 'okx').toUpperCase();
  $('kf-bt-acc').textContent = d.directionalAccuracy != null ? fmtPercent(d.directionalAccuracy) : '--';
  $('kf-bt-brier').textContent = d.brier != null ? Number(d.brier).toFixed(3) : '--';
  $('kf-bt-vol').textContent = d.volHitRate != null ? fmtPercent(d.volHitRate) : '--';
  $('kf-bt-samples').textContent = d.samples != null ? String(d.samples) : '--';

  // 方向准确率卡片着色：≥50% 偏绿，<50% 偏红
  const accCard = $('kf-bt-acc') ? $('kf-bt-acc').closest('.kf-backtest-card') : null;
  if (accCard) {
    accCard.classList.remove('kf-bt-good', 'kf-bt-bad');
    if (d.directionalAccuracy != null) {
      accCard.classList.add(d.directionalAccuracy >= 0.5 ? 'kf-bt-good' : 'kf-bt-bad');
    }
  }

  const note = $('kf-backtest-note');
  if (note) {
    note.textContent = tx(
      `回测数据源：${d.exchange.toUpperCase()} 深度历史（BTC 价格各主流所几乎一致）。基于过去 ${d.days ?? d.weeks} 天、每天一个历史时点，用当时 K 线跑相同推理，对比 24 小时后实际走势；共 ${d.samples} 个有效样本${d.errors ? '，' + d.errors + ' 个锚点数据缺失' : ''}。`,
      `Backtest data: ${d.exchange.toUpperCase()} deep history (BTC price is near-identical across major exchanges). For each of the past ${d.days ?? d.weeks} days, the same inference is run on that day's K-line and compared against the actual 24h move; ${d.samples} valid samples${d.errors ? ', ' + d.errors + ' anchors missing data' : ''}.`
    );
  }
  $('kf-backtest-updated').textContent = tx('回测生成于 ', 'Backtest generated ') + formatGen(d.generatedAt);

  const canvas = $('kf-backtest-chart');
  if (canvas && Array.isArray(d.details) && d.details.length) {
    drawBacktestChart(canvas, d.details);
  }
}

function drawBacktestChart(canvas, details) {
  const { c, w, h } = setupCanvas(canvas, 150);
  // 底部留 34px，容纳日期 + 预测正确性标记（✓ / ✗）。
  const pad = { top: 18, right: 12, bottom: 34, left: 36 };
  const n = details.length;
  if (!n) return;

  const yOf = (p) => pad.top + (1 - p) * (h - pad.top - pad.bottom);
  const slot = (w - pad.left - pad.right) / n;
  const barW = Math.max(3, slot * 0.6);
  // 最低 3px，保证 pUp=0 的实际下跌柱仍能被看到。
  const minBarH = 3;

  // 后端 details 按时间近→远排序（details[0] 为最新），但图表要求左远右近，
  // 绘制前反转，并把反转后的顺序挂给 tooltip，保证悬停索引与视觉一致。
  const ordered = [...details].reverse();

  drawGrid(c, w, h, pad);

  // 50% 参考虚线
  const y50 = yOf(0.5);
  c.strokeStyle = 'rgba(154,167,182,0.6)';
  c.setLineDash([4, 4]);
  c.lineWidth = 1;
  c.beginPath();
  c.moveTo(pad.left, y50);
  c.lineTo(w - pad.right, y50);
  c.stroke();
  c.setLineDash([]);
  c.fillStyle = TEXT;
  c.font = '10px sans-serif';
  c.textAlign = 'left';
  c.fillText('100%', 4, pad.top + 4);
  c.fillText('50%', 4, y50 + 4);
  c.fillText('0%', 4, h - pad.bottom);

  // 日期标签按间隔显示，避免柱子多时拥挤（最多约 12 个标签）。
  const labelStep = Math.max(1, Math.ceil(n / 12));

  for (let i = 0; i < n; i++) {
    const d = ordered[i];
    const p = Number.isFinite(d.pUp) ? d.pUp : 0;
    const x = pad.left + slot * i + (slot - barW) / 2;
    const yTopRaw = yOf(p);
    let barH = h - pad.bottom - yTopRaw;
    const yTop = barH < minBarH ? (h - pad.bottom - minBarH) : yTopRaw;
    if (barH < minBarH) barH = minBarH;
    c.fillStyle = d.actualUp ? UP() : DOWN();
    c.globalAlpha = 0.85;
    c.fillRect(x, yTop, barW, barH);
    c.globalAlpha = 1;

    // 柱顶箭头：预测方向（↑涨 ↓跌 —中性）
    const predSymbol = d.direction === 'up' ? '↑' : (d.direction === 'down' ? '↓' : '—');
    c.fillStyle = '#e8edf2';
    c.font = 'bold 11px sans-serif';
    c.textAlign = 'center';
    c.fillText(predSymbol, x + barW / 2, Math.max(yTop - 3, pad.top + 10));

    // 判断正确性：每根柱都画（预测方向与实际方向一致则绿勾，反之红叉）
    const correct = Boolean(d.predictedUp) === Boolean(d.actualUp);
    c.fillStyle = correct ? UP() : DOWN();
    c.font = 'bold 10px sans-serif';
    c.textAlign = 'center';
    c.fillText(correct ? '✓' : '✗', x + barW / 2, h - 6);

    // 日期标签按间隔显示，给下方正确性标记留出空间
    if (i % labelStep === 0 || i === n - 1) {
      const dt = new Date(d.anchor);
      const label = `${(dt.getMonth() + 1).toString().padStart(2, '0')}-${dt.getDate().toString().padStart(2, '0')}`;
      c.fillStyle = TEXT;
      c.font = '9px sans-serif';
      c.textAlign = 'center';
      c.fillText(label, x + barW / 2, h - 18);
    }
  }

  // 把几何信息挂到 canvas 上，供 tooltip 计算（使用与视觉一致的 ordered）
  canvas._btDetails = ordered;
  canvas._btGeom = { slot, barW, pad, yOf, h };
  if (!canvas._btHasListeners) {
    canvas._btHasListeners = true;
    canvas.addEventListener('mousemove', onBacktestHover);
    canvas.addEventListener('mouseleave', onBacktestLeave);
    canvas.addEventListener('click', onBacktestHover);
  }
}

function onPriceHover(e) {
  const canvas = e.currentTarget;
  const details = canvas._priceDetails;
  const geom = canvas._priceGeom;
  const tooltip = $('kf-price-tooltip');
  if (!details || !geom || !tooltip) return;

  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const total = details.history.length + details.forecast.length;
  if (total <= 0) {
    tooltip.style.display = 'none';
    return;
  }

  // 找到最近的数据点索引
  const rawI = Math.round((x - geom.pad.left) / (geom.xOf(1) - geom.xOf(0)));
  const i = Math.max(0, Math.min(total - 1, rawI));
  const isHistory = i < details.history.length;
  const item = isHistory ? details.history[i] : details.forecast[i - details.history.length];
  if (!item || !Number.isFinite(item.close)) {
    tooltip.style.display = 'none';
    return;
  }

  const dt = new Date(item.t);
  const dateLabel = `${(dt.getMonth() + 1).toString().padStart(2, '0')}-${dt.getDate().toString().padStart(2, '0')} ${dt.getHours().toString().padStart(2, '0')}:00`;

  let html = `<div class="kf-price-tooltip-date">${dateLabel}</div>`;
  if (isHistory) {
    html += `<div><span class="kf-price-tooltip-key">${tx('历史价格', 'Historical Price')}:</span> ${money(item.close)}</div>`;
  } else {
    html += `<div><span class="kf-price-tooltip-key">${tx('均值预测', 'Mean Forecast')}:</span> ${money(item.close)}</div>`;
    const rangeIdx = i - details.history.length;
    const r = details.range && details.range[rangeIdx];
    if (r && Number.isFinite(r.min) && Number.isFinite(r.max)) {
      html += `<div><span class="kf-price-tooltip-key">${tx('预测范围', 'Forecast Range')}:</span> ${money(r.min)} – ${money(r.max)}</div>`;
    }
  }

  tooltip.innerHTML = html;
  tooltip.style.display = 'block';
  const wrap = canvas.parentElement;
  const wrapRect = wrap.getBoundingClientRect();
  let left = e.clientX - wrapRect.left + 12;
  let top = e.clientY - wrapRect.top + 12;
  if (left + tooltip.offsetWidth > wrapRect.width) left = e.clientX - wrapRect.left - tooltip.offsetWidth - 8;
  if (top + tooltip.offsetHeight > wrapRect.height) top = e.clientY - wrapRect.top - tooltip.offsetHeight - 8;
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function onPriceLeave(e) {
  const tooltip = $('kf-price-tooltip');
  if (tooltip) tooltip.style.display = 'none';
}

function onBacktestHover(e) {
  const canvas = e.currentTarget;
  const details = canvas._btDetails;
  const geom = canvas._btGeom;
  const tooltip = $('kf-bt-tooltip');
  if (!details || !geom || !tooltip) return;

  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const i = Math.floor((x - geom.pad.left) / geom.slot);
  if (i < 0 || i >= details.length) {
    tooltip.style.display = 'none';
    return;
  }

  const d = details[i];
  const dt = new Date(d.anchor);
  const dateLabel = `${(dt.getMonth() + 1).toString().padStart(2, '0')}-${dt.getDate().toString().padStart(2, '0')}`;
  const predDir = d.direction === 'up' ? tx('涨', 'Up') : (d.direction === 'down' ? tx('跌', 'Down') : tx('中性', 'Neutral'));
  const actualDir = d.actualUp ? tx('涨', 'Up') : tx('跌', 'Down');
  const predShape = d.predictedPathShape ? shapeLabel(d.predictedPathShape) : '--';
  const actualShape = d.actualPathShape ? shapeLabel(d.actualPathShape) : '--';
  const correct = Boolean(d.predictedUp) === Boolean(d.actualUp);
  const correctLabel = correct
    ? `<span style="color:${UP()}">✓ ${tx('判断正确', 'Correct')}</span>`
    : `<span style="color:${DOWN()}">✗ ${tx('判断错误', 'Wrong')}</span>`;

  tooltip.innerHTML = `
    <div class="kf-bt-tooltip-date">${dateLabel}</div>
    <div><span class="kf-bt-tooltip-key">${tx('预测方向', 'Predicted Dir')}:</span> ${predDir} (${fmtPercent(d.pUp)})</div>
    <div><span class="kf-bt-tooltip-key">${tx('实际方向', 'Actual Dir')}:</span> ${actualDir}</div>
    <div><span class="kf-bt-tooltip-key">${tx('预测走势', 'Predicted Path')}:</span> ${predShape}</div>
    <div><span class="kf-bt-tooltip-key">${tx('实际走势', 'Actual Path')}:</span> ${actualShape}</div>
    <div><span class="kf-bt-tooltip-key">${tx('判断结果', 'Result')}:</span> ${correctLabel}</div>
  `;
  tooltip.style.display = 'block';
  // 让 tooltip 跟随鼠标，且不溢出容器
  const wrap = canvas.parentElement;
  const wrapRect = wrap.getBoundingClientRect();
  let left = e.clientX - wrapRect.left + 12;
  let top = e.clientY - wrapRect.top + 12;
  if (left + tooltip.offsetWidth > wrapRect.width) left = e.clientX - wrapRect.left - tooltip.offsetWidth - 8;
  if (top + tooltip.offsetHeight > wrapRect.height) top = e.clientY - wrapRect.top - tooltip.offsetHeight - 8;
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function onBacktestLeave(e) {
  const tooltip = $('kf-bt-tooltip');
  if (tooltip) tooltip.style.display = 'none';
}

let refreshTimer = null;
function startRefreshTimer() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(loadAndRender, getRefreshMs());
}

// 用户自定义自动刷新间隔：写入 localStorage 并按新间隔重启定时器。
function setupRefreshControl() {
  const input = $('kf-refresh-min');
  const apply = $('kf-refresh-apply');
  if (!input) return;
  // 回填已保存的值
  try {
    const saved = parseFloat(localStorage.getItem(REFRESH_KEY));
    if (isFinite(saved) && saved > 0) input.value = saved;
  } catch (e) {}
  const applyVal = () => {
    let min = parseFloat(input.value);
    if (!isFinite(min) || min <= 0) min = REFRESH_MIN_DEFAULT;
    min = Math.min(REFRESH_MIN_MAX, Math.max(REFRESH_MIN_MIN, min));
    input.value = min;
    try { localStorage.setItem(REFRESH_KEY, String(min)); } catch (e) {}
    startRefreshTimer(); // 立即按新间隔重启定时器
  };
  if (apply) apply.addEventListener('click', applyVal);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyVal(); });
  input.addEventListener('change', applyVal);
}

function init() {
  loadAndRender();
  loadBacktest();
  startRefreshTimer();
  // 回测每日重新拉取（服务端按天缓存，本地仅在跨天后刷新；避免长期开着页面数据过期）
  setInterval(loadBacktest, 24 * 60 * 60 * 1000);
  setupRefreshControl();
  // 语言切换后用当前语言重渲染回测文案（回测文案由 renderBacktest 经 tx() 处理；
  // 该 <p> 不带 data-zh/data-en，不会被 applyStaticI18n 重置，这里主动刷新一次）。
  window.addEventListener('btc:voice-language-changed', () => { try { loadBacktest(); } catch (e) {} });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
