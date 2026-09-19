/* Factor research: is the 5m signal actually tradeable, and where does any
   edge come from? Measures IC, reversal, holding period and cost sensitivity,
   with an out-of-sample split so we do not fool ourselves.
   Usage: node scripts/factor-research.mjs [bar] [limit] */
const BAR = process.argv[2] || "5m";
const LIMIT = Number(process.argv[3] || 1500);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const cl1 = (v) => clamp(v, -1, 1);

function sma(v, p) {
  return v.map((_, i) => (i < p - 1 ? NaN : v.slice(i - p + 1, i + 1).reduce((a, b) => a + b, 0) / p));
}
function ema(v, p) {
  const o = Array(v.length).fill(NaN), k = 2 / (p + 1);
  if (v.length < p) return o;
  o[p - 1] = v.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < v.length; i++) o[i] = v[i] * k + o[i - 1] * (1 - k);
  return o;
}
function rsi(v, p = 14) {
  const o = Array(v.length).fill(NaN);
  if (v.length <= p) return o;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = v[i] - v[i - 1]; d >= 0 ? (g += d) : (l -= d); }
  let ag = g / p, al = l / p;
  o[p] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = p + 1; i < v.length; i++) {
    const d = v[i] - v[i - 1];
    ag = (ag * (p - 1) + Math.max(d, 0)) / p;
    al = (al * (p - 1) + Math.max(-d, 0)) / p;
    o[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return o;
}
function atr(d, p = 14) {
  const o = Array(d.length).fill(NaN);
  if (d.length <= p) return o;
  let s = 0;
  for (let i = 1; i <= p; i++) s += Math.max(d[i].high - d[i].low, Math.abs(d[i].high - d[i - 1].close), Math.abs(d[i].low - d[i - 1].close));
  o[p] = s / p;
  for (let i = p + 1; i < d.length; i++) {
    const tr = Math.max(d[i].high - d[i].low, Math.abs(d[i].high - d[i - 1].close), Math.abs(d[i].low - d[i - 1].close));
    o[i] = (o[i - 1] * (p - 1) + tr) / p;
  }
  return o;
}

function features(data) {
  const c = data.map((x) => x.close);
  const e20 = ema(c, 20), e50 = ema(c, 50), e200 = ema(c, 200);
  const rs = rsi(c), at = atr(data);
  const i = c.length - 1;
  const macd = ema(c, 12)[i] - ema(c, 26)[i];
  const basis = sma(c, 20)[i];
  const sd = Math.sqrt(c.slice(-20).reduce((s, x) => s + (x - basis) ** 2, 0) / 20);
  const a = at[i] || 1;
  return {
    close: c[i], e20: e20[i], e50: e50[i], e200: e200[i], rsi: rs[i], atr: a, macd,
    bb: (c[i] - (basis - 2 * sd)) / (4 * sd || 1),
    mom5: c.length > 5 ? (c[i] / c[i - 5] - 1) * 100 : 0,
    mom1: c.length > 1 ? (c[i] / c[i - 2] - 1) * 100 : 0,
    atrPct: (a / c[i]) * 100,
    /* mean-reversion style factors, candidates for a 5m model */
    stretch: (c[i] - e20[i]) / a,
    zscore: sd ? (c[i] - basis) / sd : 0,
    rsiExtreme: rs[i] - 50,
  };
}

function corr(x, y) {
  const n = x.length;
  if (n < 10) return 0;
  const mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = x[i] - mx, b = y[i] - my; num += a * b; dx += a * a; dy += b * b; }
  return num / Math.sqrt(dx * dy || 1);
}

async function fetchHistory(bar, want) {
  const OKX_BAR = { "1h": "1H", "4h": "4H", "1d": "1D" };
  const out = [];
  let cursor = "";
  const okxBar = OKX_BAR[bar] || bar;
  while (out.length < want) {
    const j = await (await fetch(`https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=${okxBar}&limit=300${cursor ? `&after=${cursor}` : ""}`)).json();
    if (j.code !== "0" || !j.data?.length) break;
    const b = j.data.map((r) => ({ time: +r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4] }));
    for (const r of b) if (!out.some((x) => x.time === r.time)) out.push(r);
    if (b.length < 300) break;
    cursor = b.reduce((m, r) => (m === 0 ? r.time : Math.min(m, r.time)), 0);
    await new Promise((r) => setTimeout(r, 110));
  }
  return out.sort((a, b) => a.time - b.time);
}

const rows = await fetchHistory(BAR, LIMIT);
console.log(`### ${BAR}  bars=${rows.length}  ${new Date(rows[0].time).toLocaleString("zh-CN")} -> ${new Date(rows.at(-1).time).toLocaleString("zh-CN")}`);

const START = 250;
const HOLD = [1, 3, 6, 12, 24];
const snaps = [];
for (let t = START; t < rows.length - 24; t++) {
  const f = features(rows.slice(0, t + 1));
  const fut = {};
  for (const h of HOLD) fut[h] = (rows[t + h].close / rows[t].close - 1) * 100;
  snaps.push({ t, f, fut });
}

/* 1. Information coefficient per factor: does it predict, and in which sign? */
console.log("\n=== 单因子 IC（与未来收益的相关性，|IC|>0.05 才值得看）===");
const factors = ["mom5", "mom1", "macd", "rsi", "bb", "stretch", "zscore", "rsiExtreme", "atrPct"];
const head = `  ${"因子".padEnd(12)}` + HOLD.map((h) => `H=${String(h).padStart(2)}`.padStart(8)).join("");
console.log(head);
for (const fk of factors) {
  const line = HOLD.map((h) => {
    const xs = snaps.map((s) => s.f[fk]).filter(Number.isFinite);
    const ys = snaps.map((s) => s.fut[h]);
    const ic = corr(snaps.filter((s) => Number.isFinite(s.f[fk])).map((s) => s.f[fk]), snaps.filter((s) => Number.isFinite(s.f[fk])).map((s) => s.fut[h]));
    return ic.toFixed(3).padStart(8);
  }).join("");
  console.log(`  ${fk.padEnd(12)}${line}`);
}
console.log("  （IC 为负 = 反向有效；|IC| < 0.03 基本是噪声）");

/* 2. Trend-follow vs reversal, gross and net of round-trip fees. */
const FEE = 0.1; /* percent, round trip taker on perpetuals */
console.log(`\n=== 趋势跟随 vs 反转（阈值 |score|>=45；成本 = 往返 ${FEE}%）===`);
function tradeTest(sign, h, subset) {
  let n = 0, win = 0, gross = 0;
  for (const s of subset) {
    const sc = sign * (s.f.e20 > s.f.e50 ? 25 : -25) + sign * (s.f.close > s.f.e50 ? 20 : -20);
    if (Math.abs(sc) < 45) continue;
    const dirn = Math.sign(sc);
    const pnl = dirn * s.fut[h];
    n++; gross += pnl; if (pnl > 0) win++;
  }
  if (!n) return null;
  const avg = gross / n;
  return { n, winRate: (win / n) * 100, avg, net: avg - FEE, profit: (avg - FEE) * n };
}
const half = Math.floor(snaps.length / 2);
const inSample = snaps.slice(0, half), outSample = snaps.slice(half);
for (const h of [3, 6, 12]) {
  for (const [name, sign] of [["趋势跟随", 1], ["反转", -1]]) {
    const a = tradeTest(sign, h, snaps), b = tradeTest(sign, h, outSample);
    if (!a) continue;
    console.log(`  H=${String(h).padStart(2)} ${name.padEnd(6)} 全样本: n=${String(a.n).padStart(4)} 胜率=${a.winRate.toFixed(1).padStart(5)}% 毛均=${a.avg.toFixed(3).padStart(6)}% 净均=${a.net.toFixed(3).padStart(6)}% 累计净=${a.profit.toFixed(1).padStart(7)}%  | 样本外胜率=${b ? b.winRate.toFixed(1) : "--"}% 净均=${b ? b.net.toFixed(3) : "--"}%`);
  }
}

/* 3. Does a simple mean-reversion rule beat it? Fade extreme stretches. */
console.log("\n=== 均值回归规则（价格偏离 EMA20 超过 k 倍 ATR 时反向）===");
for (const k of [1.0, 1.5, 2.0, 2.5]) {
  for (const h of [3, 6, 12]) {
    let n = 0, win = 0, gross = 0;
    for (const s of snaps) {
      if (Math.abs(s.f.stretch) < k) continue;
      const pnl = -Math.sign(s.f.stretch) * s.fut[h];
      n++; gross += pnl; if (pnl > 0) win++;
    }
    if (n < 20) continue;
    const avg = gross / n;
    console.log(`  阈值=${k.toFixed(1)}ATR H=${String(h).padStart(2)}: n=${String(n).padStart(4)} 胜率=${((win / n) * 100).toFixed(1).padStart(5)}% 毛均=${avg.toFixed(3).padStart(6)}% 净均=${(avg - FEE).toFixed(3).padStart(6)}% 累计净=${((avg - FEE) * n).toFixed(1).padStart(7)}%`);
  }
}

/* 4. Volatility regime: does the signal work better in high/low vol? */
console.log("\n=== 波动率分层（按 ATR% 中位数切分，H=6）===");
const sorted = [...snaps].sort((a, b) => a.f.atrPct - b.f.atrPct);
const medATR = sorted[Math.floor(sorted.length / 2)].f.atrPct;
for (const [name, pred] of [["低波动", (s) => s.f.atrPct < medATR], ["高波动", (s) => s.f.atrPct >= medATR]]) {
  const sub = snaps.filter(pred);
  let n = 0, win = 0, gross = 0;
  for (const s of sub) {
    const sc = (s.f.e20 > s.f.e50 ? 25 : -25) + (s.f.close > s.f.e50 ? 20 : -20);
    if (Math.abs(sc) < 45) continue;
    const pnl = Math.sign(sc) * s.fut[6];
    n++; gross += pnl; if (pnl > 0) win++;
  }
  if (!n) continue;
  const avg = gross / n;
  console.log(`  ${name}(ATR%${name === "低波动" ? "<" : ">="}${medATR.toFixed(3)}): n=${String(n).padStart(4)} 胜率=${((win / n) * 100).toFixed(1).padStart(5)}% 净均=${(avg - FEE).toFixed(3).padStart(6)}%`);
}
