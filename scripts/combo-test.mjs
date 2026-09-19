/* Multi-timeframe combo test: use 1h (where momentum has positive IC) for
   direction and 5m (where mean reversion dominates) for entry timing.
   Usage: node scripts/combo-test.mjs */
const FEE = Number(process.argv[2] || 0.1); /* round-trip percent */

const cl1 = (v) => Math.max(-1, Math.min(1, v));
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
  const basis = sma(c, 20)[i];
  const sd = Math.sqrt(c.slice(-20).reduce((s, x) => s + (x - basis) ** 2, 0) / 20);
  const a = at[i] || 1;
  return {
    close: c[i], e20: e20[i], e50: e50[i], e200: e200[i], rsi: rs[i], atr: a,
    macd: ema(c, 12)[i] - ema(c, 26)[i],
    bb: (c[i] - (basis - 2 * sd)) / (4 * sd || 1),
    mom5: c.length > 5 ? (c[i] / c[i - 5] - 1) * 100 : 0,
    stretch: (c[i] - e20[i]) / a,
    atrPct: (a / c[i]) * 100,
  };
}
/* Legacy rule score, kept identical to production so results transfer. */
function ruleScore(f) {
  let s = 0;
  s += f.e20 > f.e50 ? 25 : -25;
  s += f.close > f.e50 ? 20 : -20;
  s += Number.isFinite(f.e200) ? (f.close > f.e200 ? 20 : -20) : 0;
  s += cl1(f.macd / (f.atr * 1.2)) * 15;
  s += Math.max(-10, Math.min(10, (f.rsi - 50) / 2.5));
  s += Math.max(-10, Math.min(10, (f.bb - 0.5) * 20));
  return Math.round(s);
}

async function fetchHistory(bar, want) {
  const OKX_BAR = { "1h": "1H" };
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

const [m5, h1] = await Promise.all([fetchHistory("5m", 1500), fetchHistory("1h", 1500)]);
console.log(`5m=${m5.length}  1h=${h1.length}  成本=往返${FEE}%`);

/* Pre-compute the 1h rule score per hour; it only changes on the hour. */
const h1Score = new Map();
for (let t = 250; t < h1.length; t++) h1Score.set(h1[t].time, ruleScore(features(h1.slice(0, t + 1))));
const h1Times = [...h1Score.keys()].sort((a, b) => a - b);
function scoreAt(time) {
  let v = 0;
  for (const t of h1Times) { if (t <= time) v = h1Score.get(t); else break; }
  return v;
}

/* 5m features per bar, plus future returns. */
const HOLD = [3, 6, 12, 24];
const snaps = [];
for (let t = 250; t < m5.length - 24; t++) {
  const f = features(m5.slice(0, t + 1));
  const fut = {};
  for (const h of HOLD) fut[h] = (m5[t + h].close / m5[t].close - 1) * 100;
  snaps.push({ t, f, fut, h1: scoreAt(m5[t].time) });
}
const half = Math.floor(snaps.length / 2);

function report(name, pick, hold) {
  const run = (sub) => {
    let n = 0, win = 0, gross = 0;
    for (const s of sub) {
      const d = pick(s);
      if (!d) continue;
      const pnl = d * s.fut[hold];
      n++; gross += pnl; if (pnl > 0) win++;
    }
    if (!n) return null;
    const avg = gross / n;
    return { n, win: (win / n) * 100, avg, net: avg - FEE, total: (avg - FEE) * n };
  };
  const a = run(snaps), o = run(snaps.slice(half));
  if (!a) return;
  console.log(`  ${name.padEnd(30)} H=${String(hold).padStart(2)} n=${String(a.n).padStart(4)} 胜率=${a.win.toFixed(1).padStart(5)}% 毛均=${a.avg.toFixed(3).padStart(6)}% 净均=${a.net.toFixed(3).padStart(6)}% 累计净=${a.total.toFixed(1).padStart(7)}% | 样本外 胜率=${o ? o.win.toFixed(1) : "--"}% 净均=${o ? o.net.toFixed(3) : "--"}%`);
}

console.log("\n=== 基线 ===");
for (const h of [6, 12]) report("5m 单独趋势(现状)", (s) => (Math.abs(ruleScore(s.f)) >= 45 ? Math.sign(ruleScore(s.f)) : 0), h);
for (const h of [6, 12]) report("5m 单独反转", (s) => (Math.abs(ruleScore(s.f)) >= 45 ? -Math.sign(ruleScore(s.f)) : 0), h);

console.log("\n=== 组合：1h 定方向 + 5m 回调入场（逆小周期、顺大周期）===");
for (const th of [45, 60]) {
  for (const k of [1.0, 1.5, 2.0]) {
    for (const h of [6, 12]) {
      /* 1h bull -> only long, and only when 5m has pulled back k ATR below EMA20 */
      report(`1h多(|s|>=${th})+5m回调${k}ATR`, (s) => {
        if (s.h1 < th) return 0;
        if (s.f.stretch > -k) return 0;
        return 1;
      }, h);
      /* 1h bear -> only short, and only when 5m has bounced k ATR above EMA20 */
      report(`1h空(|s|>=${th})+5m反弹${k}ATR`, (s) => {
        if (s.h1 > -th) return 0;
        if (s.f.stretch < k) return 0;
        return -1;
      }, h);
    }
  }
}

console.log("\n=== 组合：1h 方向 + 5m 同向确认（双周期共振）===");
for (const th of [45, 60]) {
  for (const h of [6, 12]) {
    report(`共振多(1h>=${th} & 5m>0)`, (s) => (s.h1 >= th && ruleScore(s.f) > 0 ? 1 : 0), h);
    report(`共振空(1h<=-${th} & 5m<0)`, (s) => (s.h1 <= -th && ruleScore(s.f) < 0 ? -1 : 0), h);
  }
}
