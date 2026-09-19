// shared/indicators.mjs
//
// 单一事实来源：行情指标的数学实现。
// Single source of truth for indicator maths.
//
// 背景 / Why this module exists:
// 指标公式原本在前端 app.js 与后端 ai-chat.mjs 各实现一遍，长期维护会漂移
// （见 docs/CODE_AUDIT_REPORT.md 的 F5）。这里把后端用到的标量 / 紧凑序列版本
// 集中，后端直接 import；前端绘图用的「全长度 + NaN 填充」序列版本
// （*SeriesPadded）也一并放在此处，待 Step 6 把 app.js 拆成 ES Module 后由前端
// 直接复用，届时即可彻底去掉前端的重复实现。
//
// 关键不变量 / Invariants（重构硬约束，禁止改变语义）:
// - 所有函数必须与原实现逐字节等价（已有 parity 测试覆盖，见 /tmp 临时校验）。
// - 入参: closes 为数字数组；candles 为 {high, low, close} 对象数组。
// - 长度不足时: 标量函数返回 null，序列函数返回 [] 或 NaN 填充数组。

// ---------- 标量 + 紧凑序列（后端 ai-chat.mjs 原实现，逐字节等价）----------

// 指数移动平均的「最新一个值」（标量）。长度不足 period 返回 null。
export function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let acc = values.slice(0, period).reduce((sum, v) => sum + v, 0) / period;
  for (let i = period; i < values.length; i += 1) acc = values[i] * k + acc * (1 - k);
  return acc;
}

// EMA 序列（从 period 处起算，长度 = values.length - period + 1，无 NaN 填充）。
export function emaSeries(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1), out = [];
  let acc = values.slice(0, period).reduce((sum, v) => sum + v, 0) / period;
  out.push(acc);
  for (let i = period; i < values.length; i += 1) { acc = values[i] * k + acc * (1 - k); out.push(acc); }
  return out;
}

// 相对强弱指标（标量）。长度不足 period+1 返回 null；全跌（avgLoss=0）返回 100。
export function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gain += diff; else loss -= diff;
  }
  let avgGain = gain / period, avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i += 1) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// MACD（标量对象）。长度不足 35 返回 null。
export function macd(closes) {
  if (closes.length < 35) return null;
  const fast = emaSeries(closes, 12), slow = emaSeries(closes, 26);
  const offset = fast.length - slow.length;
  const line = [], diffs = [];
  for (let i = 0; i < slow.length; i += 1) { const v = fast[i + offset] - slow[i]; line.push(v); diffs.push(v); }
  if (diffs.length < 9) return null;
  const signal = emaSeries(diffs, 9);
  const last = line[line.length - 1], sig = signal[signal.length - 1];
  const prev = line[line.length - 2], prevSig = signal[signal.length - 2];
  return { line:last, signal:sig, histogram:last - sig, prevHistogram:prev - prevSig, trend:last > sig ? 'bull' : 'bear' };
}

// 布林带（标量对象）。
export function bollinger(closes, period = 20) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period), mean = slice.reduce((s, v) => s + v, 0) / period;
  const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  return { mid:mean, upper:mean + 2 * sd, lower:mean - 2 * sd, widthPct:(4 * sd / mean) * 100 };
}

// 平均真实波幅（标量）。candles 为 {high, low, close} 数组。
export function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = candles.length - period; i < candles.length; i += 1) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  return trs.reduce((s, v) => s + v, 0) / trs.length;
}

// ---------- 全长度 + NaN 填充序列（前端 app.js 原实现，供 Step 6 复用）----------
// 与上面标量/紧凑序列的区别: 返回与输入等长的数组，索引 < period 处填 NaN，
// 以便绘图时指标线与 K 线逐根对齐。当前 app.js 仍是普通 <script>（非 module），
// 故本批不引入；等 Step 6 拆分后再 import，替换前端重复实现。

export function emaSeriesPadded(values, p) {
  const out = Array(values.length).fill(NaN),
    k = 2 / (p + 1);
  if (values.length < p) return out;
  out[p - 1] = values.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < values.length; i++)
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  return out;
}

export function rsiSeriesPadded(values, p = 14) {
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

export function atrSeriesPadded(data, p = 14) {
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
