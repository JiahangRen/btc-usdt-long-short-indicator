/* Signal score audit: compare the legacy metrics() score against the revised
   model on real OKX candles. Read-only, does not touch app.js.
   Usage: node scripts/score-audit.mjs [bar] [limit] */
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
  for (let i = 1; i <= p; i++) {
    const d = v[i] - v[i - 1];
    d >= 0 ? (g += d) : (l -= d);
  }
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
  for (let i = 1; i <= p; i++)
    s += Math.max(d[i].high - d[i].low, Math.abs(d[i].high - d[i - 1].close), Math.abs(d[i].low - d[i - 1].close));
  o[p] = s / p;
  for (let i = p + 1; i < d.length; i++) {
    const tr = Math.max(d[i].high - d[i].low, Math.abs(d[i].high - d[i - 1].close), Math.abs(d[i].low - d[i - 1].close));
    o[i] = (o[i - 1] * (p - 1) + tr) / p;
  }
  return o;
}

/* Raw indicator bundle, computed once per window and reused by both models. */
function features(data) {
  const c = data.map((x) => x.close);
  const e20 = ema(c, 20), e50 = ema(c, 50), e200 = ema(c, 200);
  const rs = rsi(c), at = atr(data);
  const i = c.length - 1;
  const macd = ema(c, 12)[i] - ema(c, 26)[i];
  const basis = sma(c, 20)[i];
  const sd = Math.sqrt(c.slice(-20).reduce((s, x) => s + (x - basis) ** 2, 0) / 20);
  return {
    close: c[i], e20: e20[i], e50: e50[i], e200: e200[i], rsi: rs[i], atr: at[i] || 1,
    macd, bb: (c[i] - (basis - 2 * sd)) / (4 * sd || 1),
    mom5: c.length > 5 ? (c[i] / c[i - 5] - 1) * 100 : 0,
  };
}

/* Legacy: app.js metrics() as shipped. */
function scoreOld(f) {
  let s = 0;
  s += f.e20 > f.e50 ? 25 : -25;
  s += f.close > f.e50 ? 20 : -20;
  s += Number.isFinite(f.e200) ? (f.close > f.e200 ? 20 : -20) : 0;
  s += clamp((f.macd / (f.close * 0.0015)) * 15, -15, 15);
  s += clamp((f.rsi - 50) / 2.5, -10, 10);
  s += clamp((f.bb - 0.5) * 20, -10, 10);
  return Math.round(s);
}

/* Revised: ATR-normalised continuous terms + momentum + live drift.
   Weights sum to 100 so the existing +/-45 and +/-28 thresholds keep meaning. */
const BASE = { wEma: 20, wE50: 16, wE200: 12, wMacd: 14, wRsi: 6, wBb: 6, wMom: 18, wLive: 8, kEma: 1.5, kE50: 1.5, kE200: 4, kMacd: 1.2, kRsi: 25, kMom: 2.5, kLive: 1.5 };
function scoreNew(f, livePrice, cfg = BASE) {
  const a = f.atr, atrPct = (a / f.close) * 100;
  const parts = {
    ema: cl1((f.e20 - f.e50) / (a * cfg.kEma)) * cfg.wEma,
    e50: cl1((f.close - f.e50) / (a * cfg.kE50)) * cfg.wE50,
    e200: Number.isFinite(f.e200) ? cl1((f.close - f.e200) / (a * cfg.kE200)) * cfg.wE200 : 0,
    macd: cl1(f.macd / (a * cfg.kMacd)) * cfg.wMacd,
    rsi: cl1((f.rsi - 50) / cfg.kRsi) * cfg.wRsi,
    bb: cl1((f.bb - 0.5) * 2) * cfg.wBb,
    mom: cl1(f.mom5 / (atrPct * cfg.kMom || 0.1)) * cfg.wMom,
    live: livePrice ? cl1((livePrice - f.close) / (a * cfg.kLive)) * cfg.wLive : 0,
    mom5pct: f.mom5, atrPct,
  };
  parts.total = Math.round(parts.ema + parts.e50 + parts.e200 + parts.macd + parts.rsi + parts.bb + parts.mom + parts.live);
  return parts;
}

/* V2 (conservative): keep the legacy binary trend/position terms, which carry
   real predictive value on 1h, and only fix the broken MACD scaling plus add a
   moderate momentum term. Total stays at 100 so thresholds keep their meaning. */
function scoreV2(f, livePrice) {
  let s = 0;
  s += f.e20 > f.e50 ? 25 : -25;
  s += f.close > f.e50 ? 20 : -20;
  s += Number.isFinite(f.e200) ? (f.close > f.e200 ? 12 : -12) : 0;
  s += cl1(f.macd / (f.atr * 1.2)) * 15;
  s += clamp((f.rsi - 50) / 2.5, -6, 6);
  s += clamp((f.bb - 0.5) * 20, -6, 6);
  const atrPct = (f.atr / f.close) * 100;
  s += cl1(f.mom5 / (atrPct * 2.5 || 0.1)) * 16;
  if (livePrice) s += cl1((livePrice - f.close) / (f.atr * 1.5)) * 8;
  return Math.round(s);
}

/* V3 (conflict damping): keep the legacy direction logic untouched, fix the
   broken MACD scaling, then *damp* the score (never flip it) when recent
   momentum opposes it. A damped score falls below the 45 threshold and shows
   "watch", which is what a falling price should look like instead of "long". */
function scoreV3(f, livePrice) {
  let s = 0;
  s += f.e20 > f.e50 ? 25 : -25;
  s += f.close > f.e50 ? 20 : -20;
  s += Number.isFinite(f.e200) ? (f.close > f.e200 ? 20 : -20) : 0;
  s += cl1(f.macd / (f.atr * 1.2)) * 15;
  s += clamp((f.rsi - 50) / 2.5, -10, 10);
  s += clamp((f.bb - 0.5) * 20, -10, 10);
  const atrPct = (f.atr / f.close) * 100;
  if (s !== 0 && f.mom5 !== 0 && Math.sign(s) !== Math.sign(f.mom5)) {
    const conflict = Math.min(1, Math.abs(f.mom5) / (atrPct * 1.5 || 0.1));
    s *= 1 - 0.65 * conflict;
  }
  if (livePrice) s += cl1((livePrice - f.close) / (f.atr * 1.5)) * 8;
  return Math.round(s);
}

/* V4: fold the live-quote drift into the same damping term instead of adding a
   small weight that gets clamped away. Drift counts 1.5x because it is the most
   current information the user sees. Damping stays one-sided (never flips). */
function scoreV4(f, livePrice) {
  let s = 0;
  s += f.e20 > f.e50 ? 25 : -25;
  s += f.close > f.e50 ? 20 : -20;
  s += Number.isFinite(f.e200) ? (f.close > f.e200 ? 20 : -20) : 0;
  s += cl1(f.macd / (f.atr * 1.2)) * 15;
  s += clamp((f.rsi - 50) / 2.5, -10, 10);
  s += clamp((f.bb - 0.5) * 20, -10, 10);
  const atrPct = (f.atr / f.close) * 100;
  const driftPct = livePrice ? ((livePrice - f.close) / f.close) * 100 : 0;
  const recent = f.mom5 + driftPct * 1.5;
  if (s !== 0 && recent !== 0 && Math.sign(s) !== Math.sign(recent))
    s *= 1 - 0.5 * Math.min(1, Math.abs(recent) / (atrPct * 1.5 || 0.1));
  return Math.round(s);
}

const dir = (s, t = 45) => (s >= t ? "bull" : s <= -t ? "bear" : "flat");

/* OKX expects uppercase for hour/day bars: 1H, 4H, 1D. */
const OKX_BAR = { "1h": "1H", "2h": "2H", "4h": "4H", "6h": "6H", "12h": "12H", "1d": "1D", "3h": "3H" };
async function fetchHistory(bar, want) {
  const out = [];
  const okxBar = OKX_BAR[bar] || bar;
  let cursor = "";
  while (out.length < want) {
    const url = `https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=${okxBar}&limit=300${cursor ? `&after=${cursor}` : ""}`;
    const j = await (await fetch(url)).json();
    if (j.code !== "0" || !j.data?.length) break;
    const batch = j.data.map((r) => ({ time: Number(r[0]), open: +r[1], high: +r[2], low: +r[3], close: +r[4] }));
    const oldest = batch.reduce((m, r) => (m === 0 ? r.time : Math.min(m, r.time)), 0);
    for (const r of batch) if (!out.some((x) => x.time === r.time)) out.push(r);
    if (batch.length < 300) break;
    cursor = oldest;
    await new Promise((r) => setTimeout(r, 110));
  }
  return out.sort((a, b) => a.time - b.time);
}

const rows = await fetchHistory(BAR, LIMIT);
console.log(`bars=${rows.length} bar=${BAR} ${new Date(rows[0].time).toLocaleString("zh-CN")} -> ${new Date(rows.at(-1).time).toLocaleString("zh-CN")}\n`);

/* Point-in-time snapshot, mirroring app.js slice(0,-1) closed-candle rule. */
{
  const closed = rows.slice(0, -1);
  const f = features(closed), o = scoreOld(f), n = scoreNew(f, rows.at(-1).close);
  console.log("=== 当前时点（已收盘口径 + 实时价）===");
  console.log(`old=${o} -> ${dir(o)}   new=${n.total} -> ${dir(n.total)}`);
  console.log(`  new 明细: ema=${n.ema.toFixed(1)} e50=${n.e50.toFixed(1)} e200=${n.e200.toFixed(1)} macd=${n.macd.toFixed(2)} rsi=${n.rsi.toFixed(1)} bb=${n.bb.toFixed(1)} mom=${n.mom.toFixed(1)} (mom5=${n.mom5pct.toFixed(3)}% atrPct=${n.atrPct.toFixed(3)}%) live=${n.live.toFixed(1)}`);
  console.log(`  实时=${rows.at(-1).close} 最近收盘=${closed.at(-1).close} 偏离=${(((rows.at(-1).close - closed.at(-1).close) / closed.at(-1).close) * 100).toFixed(3)}%\n`);
}

/* The user's exact complaint: price keeps falling after the last close. */
{
  const f = features(rows.slice(0, -1));
  console.log("=== 实时价敏感性（最近收盘后价格变动 X，5m 基线）===");
  console.log(`  基线: 最近收盘=${f.close.toFixed(1)} atrPct=${((f.atr / f.close) * 100).toFixed(3)}% mom5=${f.mom5.toFixed(3)}%`);
  for (const d of [-0.8, -0.5, -0.3, -0.1, 0, 0.1, 0.3, 0.5, 0.8]) {
    const lp = f.close * (1 + d / 100);
    const o = scoreOld(f), v3 = scoreV3(f, lp), v4 = scoreV4(f, lp), v4n = scoreV4(f, null);
    console.log(`  变动 ${(d >= 0 ? "+" : "") + d}%  old=${String(o).padStart(4)}(${dir(o)})  V3含实时=${String(v3).padStart(4)}(${dir(v3)})  V4无实时=${String(v4n).padStart(4)}(${dir(v4n)})  V4含实时=${String(v4).padStart(4)}(${dir(v4)})`);
  }
  console.log("");
}

/* Mirror test: reflect the series about its last close so every rise becomes an
   equal fall. A direction-neutral model must return the exact negated score.
   This is the strict long/short symmetry check. */
{
  const base = rows.slice(-260);
  const centre = base.at(-1).close;
  const mirror = base.map((r) => ({
    time: r.time,
    open: 2 * centre - r.open,
    high: 2 * centre - r.low,
    low: 2 * centre - r.high,
    close: 2 * centre - r.close,
  }));
  const fa = features(base), fb = features(mirror);
  const oa = scoreOld(fa), ob = scoreOld(fb);
  const va = scoreV4(fa, null), vb = scoreV4(fb, null);
  console.log("=== 镜像对称性（涨跌互换，score 应恰好反号）===");
  console.log(`  old: 原=${String(oa).padStart(4)} 镜像=${String(ob).padStart(4)} 和=${oa + ob} ${Math.abs(oa + ob) <= 1 ? "通过" : "不对称"}`);
  console.log(`  V4 : 原=${String(va).padStart(4)} 镜像=${String(vb).padStart(4)} 和=${va + vb} ${Math.abs(va + vb) <= 1 ? "通过" : "不对称"}`);
  console.log("");
}

/* Pre-compute features once, then evaluate many configs cheaply. */
const H = 6, START = 250;
const samples = [];
for (let t = START; t < rows.length - H; t++) {
  const f = features(rows.slice(0, t + 1));
  const fut = (rows[t + H].close / rows[t].close - 1) * 100;
  const gate = ((f.atr / f.close) * 100) * 1.5;
  samples.push({
    t, px: rows[t].close, f, fut,
    actual: fut > gate ? "up" : fut < -gate ? "down" : "flat",
  });
}

function evaluate(getScore) {
  let hit = 0, fBull = 0, fBear = 0, downTotal = 0, upTotal = 0, downBull = 0, upBear = 0;
  const scores = [];
  for (const s of samples) {
    if (s.actual === "flat") continue;
    const d = dir(getScore(s));
    scores.push(getScore(s));
    if (s.actual === "down") { downTotal++; if (d === "bull") downBull++; }
    else { upTotal++; if (d === "bear") upBear++; }
    if (d === "bull" && s.actual === "down") fBull++;
    else if (d === "bear" && s.actual === "up") fBear++;
    else if ((d === "bull" && s.actual === "up") || (d === "bear" && s.actual === "down")) hit++;
  }
  const fired = hit + fBull + fBear;
  const mean = scores.reduce((a, b) => a + b, 0) / Math.max(scores.length, 1);
  return {
    fired, acc: (hit / Math.max(fired, 1)) * 100, hit, fBull, fBear,
    /* the exact complaint: price fell but the panel said long */
    downBullRate: (downBull / Math.max(downTotal, 1)) * 100, downBull, downTotal,
    upBearRate: (upBear / Math.max(upTotal, 1)) * 100, upBear, upTotal,
    bull: scores.filter((x) => x >= 45).length, bear: scores.filter((x) => x <= -45).length, mean,
  };
}

const resOld = evaluate((s) => scoreOld(s.f));
const resNew = evaluate((s) => scoreNew(s.f, null).total);
const resV2 = evaluate((s) => scoreV2(s.f, null));
const resV3 = evaluate((s) => scoreV3(s.f, null));

const row = (n, r) =>
  `${n.padEnd(10)} 信号=${String(r.fired).padStart(4)} 准确率=${r.acc.toFixed(1).padStart(5)}% 假多=${String(r.fBull).padStart(3)} 假空=${String(r.fBear).padStart(3)} | 跌时判多=${r.downBull}/${r.downTotal} (${r.downBullRate.toFixed(1)}%) 涨时判空=${r.upBear}/${r.upTotal} (${r.upBearRate.toFixed(1)}%) | 均分=${r.mean.toFixed(1)} 多/空=${r.bull}/${r.bear}`;

console.log("=== 滚动验证（未来 6 根收益，噪声门限 1.5x ATR%）===");
console.log(`有效样本=${samples.filter((s) => s.actual !== "flat").length}`);
console.log(row("old", resOld));
console.log(row("new激进", resNew));
console.log(row("V2保守", resV2));
console.log(row("V3压制", resV3));
console.log(row("V4联合", evaluate((s) => scoreV4(s.f, null))));

console.log("\n=== 参数扫描（mom 权重 x mom 归一化系数）===");
const grid = [];
for (const wMom of [10, 14, 18, 22]) for (const kMom of [1.5, 2.0, 2.5, 3.0]) {
  const cfg = { ...BASE, wMom, kMom };
  /* keep the weight total at 100 by redistributing the remainder over the trend terms */
  const rest = 82 - wMom;
  const scale = rest / (BASE.wEma + BASE.wE50 + BASE.wE200 + BASE.wMacd + BASE.wRsi + BASE.wBb);
  const c2 = { ...cfg, wEma: BASE.wEma * scale, wE50: BASE.wE50 * scale, wE200: BASE.wE200 * scale, wMacd: BASE.wMacd * scale, wRsi: BASE.wRsi * scale, wBb: BASE.wBb * scale };
  const r = evaluate((s) => scoreNew(s.f, null, c2).total);
  grid.push({ wMom, kMom, r });
}
grid.sort((a, b) => b.r.acc - a.r.acc || b.r.fired - a.r.fired);
grid.forEach((g) => console.log(`wMom=${String(g.wMom).padStart(2)} kMom=${g.kMom.toFixed(1)}  ${row("", g.r)}`));
