/* Indicator-system design test.
   Goal: the panel gives DIRECTION hints to a human (no auto-trading), so we
   optimise for (a) directional accuracy, (b) useful coverage, (c) a stated
   validity window.  Tests: confidence gating, event-driven vs state-based
   signals, and multi-timeframe layering.
   Usage: node scripts/indicator-design.mjs */
const cl1 = (v) => Math.max(-1, Math.min(1, v));
function sma(v, p) { return v.map((_, i) => (i < p - 1 ? NaN : v.slice(i - p + 1, i + 1).reduce((a, b) => a + b, 0) / p)); }
function ema(v, p) { const o = Array(v.length).fill(NaN), k = 2 / (p + 1); if (v.length < p) return o; o[p - 1] = v.slice(0, p).reduce((a, b) => a + b, 0) / p; for (let i = p; i < v.length; i++) o[i] = v[i] * k + o[i - 1] * (1 - k); return o; }
function rsi(v, p = 14) {
  const o = Array(v.length).fill(NaN); if (v.length <= p) return o;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = v[i] - v[i - 1]; d >= 0 ? (g += d) : (l -= d); }
  let ag = g / p, al = l / p; o[p] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = p + 1; i < v.length; i++) { const d = v[i] - v[i - 1]; ag = (ag * (p - 1) + Math.max(d, 0)) / p; al = (al * (p - 1) + Math.max(-d, 0)) / p; o[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); }
  return o;
}
function atr(d, p = 14) {
  const o = Array(d.length).fill(NaN); if (d.length <= p) return o;
  let s = 0;
  for (let i = 1; i <= p; i++) s += Math.max(d[i].high - d[i].low, Math.abs(d[i].high - d[i - 1].close), Math.abs(d[i].low - d[i - 1].close));
  o[p] = s / p;
  for (let i = p + 1; i < d.length; i++) { const tr = Math.max(d[i].high - d[i].low, Math.abs(d[i].high - d[i - 1].close), Math.abs(d[i].low - d[i - 1].close)); o[i] = (o[i - 1] * (p - 1) + tr) / p; }
  return o;
}
function features(data) {
  const c = data.map((x) => x.close);
  const e20 = ema(c, 20), e50 = ema(c, 50), e200 = ema(c, 200);
  const rs = rsi(c), at = atr(data); const i = c.length - 1;
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
  const out = []; let cursor = ""; const okxBar = OKX_BAR[bar] || bar;
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
console.log(`数据: 5m=${m5.length}根  1h=${h1.length}根`);

/* ---------- Part A: 1h 主方向 —— 置信度门槛扫描 ---------- */
const HOLD = [1, 3, 6, 12, 24];
const hSnaps = [];
for (let t = 250; t < h1.length - 24; t++) {
  const f = features(h1.slice(0, t + 1));
  const fut = {};
  for (const h of HOLD) fut[h] = (h1[t + h].close / h1[t].close - 1) * 100;
  hSnaps.push({ t, f, fut, s: ruleScore(f) });
}
const hh = Math.floor(hSnaps.length / 2);

function gate(snaps, pick, hold, half) {
  const run = (sub) => {
    let n = 0, win = 0, gross = 0;
    for (const s of sub) {
      const d = pick(s);
      if (!d) continue;
      const pnl = d * s.fut[hold];
      n++; gross += pnl; if (pnl > 0) win++;
    }
    if (!n) return null;
    return { n, win: (win / n) * 100, avg: gross / n, cov: (n / sub.length) * 100 };
  };
  const a = run(snaps), o = run(snaps.slice(half));
  return { a, o };
}
const f2 = (x) => x.toFixed(1).padStart(5);
const f3 = (x) => x.toFixed(3).padStart(6);

console.log("\n=== A. 1h 主方向：置信度门槛扫描（H=6根=6小时）===");
console.log("  门槛   覆盖    n    全样本胜率  均收益  | 样本外胜率");
for (const th of [30, 45, 60, 70, 80, 90]) {
  const r = gate(hSnaps, (s) => (Math.abs(s.s) >= th ? Math.sign(s.s) : 0), 6, hh);
  if (!r.a) continue;
  console.log(`  |s|>=${String(th).padEnd(3)} ${f2(r.a.cov)}% ${String(r.a.n).padStart(4)}   ${f2(r.a.win)}%   ${f3(r.a.avg)}%  |  ${r.o ? f2(r.o.win) + "%" : "--"}`);
}

console.log("\n=== B. 1h 指示有效期衰减（门槛 |s|>=60）===");
console.log("  持有期    n    胜率    均收益   累计");
for (const h of HOLD) {
  const r = gate(hSnaps, (s) => (Math.abs(s.s) >= 60 ? Math.sign(s.s) : 0), h, hh);
  if (!r.a) continue;
  console.log(`  H=${String(h).padStart(2)}    ${String(r.a.n).padStart(4)}  ${f2(r.a.win)}%  ${f3(r.a.avg)}%  ${(r.a.avg * r.a.n).toFixed(1).padStart(7)}%`);
}

/* ---------- Part C: 5m 择时 —— 反转 + 门槛 ---------- */
const mSnaps = [];
for (let t = 250; t < m5.length - 24; t++) {
  const f = features(m5.slice(0, t + 1));
  const fut = {};
  for (const h of HOLD) fut[h] = (m5[t + h].close / m5[t].close - 1) * 100;
  mSnaps.push({ t, f, fut, s: ruleScore(f) });
}
const mh = Math.floor(mSnaps.length / 2);

console.log("\n=== C. 5m 择时：趋势 vs 反转（H=6根=30分钟）===");
console.log("  方式       门槛   覆盖    n    全样本胜率  均收益  | 样本外胜率");
for (const th of [45, 60, 75]) {
  for (const [label, sign] of [["趋势(现状)", 1], ["反转", -1]]) {
    const r = gate(mSnaps, (s) => (Math.abs(s.s) >= th ? sign * Math.sign(s.s) : 0), 6, mh);
    if (!r.a) continue;
    console.log(`  ${label.padEnd(10)} |s|>=${String(th).padEnd(3)} ${f2(r.a.cov)}% ${String(r.a.n).padStart(4)}   ${f2(r.a.win)}%   ${f3(r.a.avg)}%  |  ${r.o ? f2(r.o.win) + "%" : "--"}`);
  }
}

/* ---------- Part D: 事件驱动 vs 持续状态 ---------- */
console.log("\n=== D. 事件驱动（仅新触发时给指示）vs 持续状态 ===");
function eventTest(snaps, th, sign, hold) {
  const run = (sub) => {
    let n = 0, win = 0, gross = 0, prev = 0;
    for (const s of sub) {
      const raw = Math.abs(s.s) >= th ? Math.sign(s.s) : 0;
      const fired = raw !== 0 && raw !== prev; /* only the bar where it appears */
      prev = raw;
      if (!fired) continue;
      const d = sign * raw;
      const pnl = d * s.fut[hold];
      n++; gross += pnl; if (pnl > 0) win++;
    }
    if (!n) return null;
    return { n, win: (win / n) * 100, avg: gross / n };
  };
  return { a: run(snaps), o: run(snaps.slice(Math.floor(snaps.length / 2))) };
}
for (const [label, snaps, th] of [["1h 趋势", hSnaps, 60], ["5m 反转", mSnaps, 60]]) {
  const sign = label === "5m 反转" ? -1 : 1;
  const e = eventTest(snaps, th, sign, 6);
  const st = gate(snaps, (s) => (Math.abs(s.s) >= th ? sign * Math.sign(s.s) : 0), 6, Math.floor(snaps.length / 2));
  if (!e.a || !st.a) continue;
  console.log(`  ${label.padEnd(8)} 事件驱动: n=${String(e.a.n).padStart(3)} 胜率=${f2(e.a.win)}% 均=${f3(e.a.avg)}% (样本外 ${e.o ? f2(e.o.win) + "%" : "--"})  |  持续状态: n=${String(st.a.n).padStart(4)} 胜率=${f2(st.a.win)}%`);
}

/* ---------- Part E: 分层组合 ---------- */
const h1Score = new Map();
for (let t = 250; t < h1.length; t++) h1Score.set(h1[t].time, ruleScore(features(h1.slice(0, t + 1))));
const h1Times = [...h1Score.keys()].sort((a, b) => a - b);
function scoreAt(time) { let v = 0; for (const t of h1Times) { if (t <= time) v = h1Score.get(t); else break; } return v; }
for (const s of mSnaps) s.h1 = scoreAt(m5[s.t].time);

console.log("\n=== E. 分层组合：1h 定方向 + 5m 反转择时（H=6）===");
console.log("  组合                              覆盖    n    全样本胜率  均收益  | 样本外胜率");
const combos = [
  ["1h方向 alone (|s|>=60)", (s) => (Math.abs(s.h1) >= 60 ? Math.sign(s.h1) : 0)],
  ["1h方向 + 5m同向共振", (s) => (Math.abs(s.h1) >= 60 && Math.sign(s.s) === Math.sign(s.h1) ? Math.sign(s.h1) : 0)],
  ["1h方向 + 5m逆向回调", (s) => (Math.abs(s.h1) >= 60 && Math.sign(s.s) === -Math.sign(s.h1) ? Math.sign(s.h1) : 0)],
  ["1h方向 + 5m回调>=1ATR", (s) => (Math.abs(s.h1) >= 60 && s.f.stretch * Math.sign(s.h1) <= -1 ? Math.sign(s.h1) : 0)],
  ["1h方向 + 5m回调>=1.5ATR", (s) => (Math.abs(s.h1) >= 60 && s.f.stretch * Math.sign(s.h1) <= -1.5 ? Math.sign(s.h1) : 0)],
  ["1h方向 + 5m观望(弱5m)", (s) => (Math.abs(s.h1) >= 60 && Math.abs(s.s) < 45 ? Math.sign(s.h1) : 0)],
];
for (const [name, pick] of combos) {
  const r = gate(mSnaps, pick, 6, mh);
  if (!r.a) continue;
  console.log(`  ${name.padEnd(34)} ${f2(r.a.cov)}% ${String(r.a.n).padStart(4)}   ${f2(r.a.win)}%   ${f3(r.a.avg)}%  |  ${r.o ? f2(r.o.win) + "%" : "--"}`);
}

/* ---------- Part G: 最终方案 = 分层 + 事件驱动 ---------- */
console.log("\n=== G. 最终方案：1h定方向 + 5m逆向回调 + 仅新触发时给指示 ===");
console.log("  持有期     n    全样本胜率  均收益   累计   | 样本外 n/胜率");
for (const h of [3, 6, 12, 24]) {
  const run = (sub) => {
    let n = 0, win = 0, gross = 0, prev = 0;
    for (const s of sub) {
      if (Math.abs(s.h1) < 60) { prev = 0; continue; }
      const align = Math.sign(s.s) === -Math.sign(s.h1);
      const fired = align && prev !== 1;
      prev = align ? 1 : 0;
      if (!fired) continue;
      const pnl = Math.sign(s.h1) * s.fut[h];
      n++; gross += pnl; if (pnl > 0) win++;
    }
    if (!n) return null;
    return { n, win: (win / n) * 100, avg: gross / n, total: gross };
  };
  const a = run(mSnaps), o = run(mSnaps.slice(mh));
  if (!a) continue;
  console.log(`  H=${String(h).padStart(2)}根(${String(h * 5).padStart(2)}分) ${String(a.n).padStart(4)}   ${f2(a.win)}%   ${f3(a.avg)}% ${a.total.toFixed(1).padStart(7)}%  |  ${o ? String(o.n).padStart(3) + " / " + f2(o.win) + "%" : "--"}`);
}

console.log("\n=== H. 5m 反转指示有效期（确定给用户的有效截止时间）===");
console.log("  持有期     n    胜率    均收益   累计收益");
for (const h of [1, 3, 6, 12, 24]) {
  const r = gate(mSnaps, (s) => (Math.abs(s.s) >= 60 ? -Math.sign(s.s) : 0), h, mh);
  if (!r.a) continue;
  console.log(`  H=${String(h).padStart(2)}根(${String(h * 5).padStart(3)}分) ${String(r.a.n).padStart(4)}  ${f2(r.a.win)}%  ${f3(r.a.avg)}%  ${(r.a.avg * r.a.n).toFixed(1).padStart(7)}%`);
}

console.log("\n=== I. 稳健性：分三段验证最终方案（H=12根=60分钟）===");
const seg = Math.floor(mSnaps.length / 3);
for (let k = 0; k < 3; k++) {
  const sub = mSnaps.slice(k * seg, (k + 1) * seg);
  let n = 0, win = 0, gross = 0, prev = 0;
  for (const s of sub) {
    if (Math.abs(s.h1) < 60) { prev = 0; continue; }
    const align = Math.sign(s.s) === -Math.sign(s.h1);
    const fired = align && prev !== 1;
    prev = align ? 1 : 0;
    if (!fired) continue;
    const pnl = Math.sign(s.h1) * s.fut[12];
    n++; gross += pnl; if (pnl > 0) win++;
  }
  if (n) console.log(`  第${k + 1}段: n=${String(n).padStart(3)} 胜率=${f2((win / n) * 100)}% 均=${f3(gross / n)}% 累计=${gross.toFixed(1)}%`);
}

console.log("\n=== F. 建议的最终指示档位（1h 主方向，5m 择时）===");
console.log("  档位                    触发率    n    胜率    均收益");
const tiers = [
  ["强多/强空 (|1h|>=80)", (s) => (Math.abs(s.h1) >= 80 ? Math.sign(s.h1) : 0)],
  ["多/空 (60<=|1h|<80)", (s) => (Math.abs(s.h1) >= 60 && Math.abs(s.h1) < 80 ? Math.sign(s.h1) : 0)],
  ["弱多/弱空 (45<=|1h|<60)", (s) => (Math.abs(s.h1) >= 45 && Math.abs(s.h1) < 60 ? Math.sign(s.h1) : 0)],
  ["观望 (|1h|<45)", (s) => (Math.abs(s.h1) < 45 ? 0 : 0)],
];
for (const [name, pick] of tiers) {
  if (name.startsWith("观望")) { console.log(`  ${name.padEnd(24)} 不给方向指示`); continue; }
  const r = gate(mSnaps, pick, 6, mh);
  if (!r.a) continue;
  console.log(`  ${name.padEnd(24)} ${f2(r.a.cov)}% ${String(r.a.n).padStart(4)}  ${f2(r.a.win)}%  ${f3(r.a.avg)}%`);
}
