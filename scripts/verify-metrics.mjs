/* End-to-end check: run the ACTUAL metrics() shipped in public/app.js against
   real candles. Extracts the real source instead of re-implementing it, so this
   catches any drift between the audited model and the shipped one.
   Dev-only script: runs against trusted, locally-authored source — never external
   input. Uses vm instead of the deprecated new Function(). */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { emaSeriesPadded as ema, rsiSeriesPadded as rsi, atrSeriesPadded as atr } from "../shared/indicators.mjs";

const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const start = src.indexOf("function sma(");
const end = src.indexOf("function classification(");
if (start < 0 || end < 0) throw new Error("could not locate metrics() source");
const code = src.slice(start, end);

// Run the extracted indicator block in an isolated VM context. The shipped
// metrics() depends on ema/rsi/atr, which now live in shared/indicators.mjs;
// inject the same implementations into the sandbox so the isolated slice
// behaves identically to the live page (function declarations attach to the
// context's global object, so sandbox.metrics becomes reachable).
const sandbox = vm.createContext({ ema, rsi, atr });
vm.runInContext(code, sandbox);
const { metrics } = sandbox;

const dir = (s, t = 45) => (s >= t ? "bull" : s <= -t ? "bear" : "flat");

async function fetchHistory(bar, want) {
  const out = [];
  let cursor = "";
  while (out.length < want) {
    const url = `https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=${bar}&limit=300${cursor ? `&after=${cursor}` : ""}`;
    const j = await (await fetch(url)).json();
    if (j.code !== "0" || !j.data?.length) break;
    const b = j.data.map((r) => ({ time: +r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4] }));
    for (const r of b) if (!out.some((x) => x.time === r.time)) out.push(r);
    if (b.length < 300) break;
    cursor = b.reduce((m, r) => (m === 0 ? r.time : Math.min(m, r.time)), 0);
    await new Promise((r) => setTimeout(r, 110));
  }
  return out.sort((a, b) => a.time - b.time);
}

const rows = await fetchHistory("5m", 600);
const closed = rows.slice(0, -1);
const live = rows.at(-1).close;
const base = metrics(closed);
const withLive = metrics(closed, live);

console.log(`app.js metrics() 实跑  bars=${rows.length}  最近收盘=${base.close.toFixed(1)}  实时=${live}`);
console.log(`无实时价: score=${base.score} (${dir(base.score)})  mom5=${base.mom5.toFixed(3)}% atrPct=${base.atrPct.toFixed(3)}% damped=${base.damped.toFixed(3)}`);
console.log(`含实时价: score=${withLive.score} (${dir(withLive.score)})  driftPct=${withLive.driftPct.toFixed(3)}% recentDir=${withLive.recentDir.toFixed(3)}% damped=${withLive.damped.toFixed(3)}`);

console.log("\n=== 实时价敏感性（跌应降级，涨应维持）===");
for (const d of [-0.5, -0.3, -0.1, 0, 0.1, 0.3, 0.5]) {
  const lp = base.close * (1 + d / 100);
  const m = metrics(closed, lp);
  console.log(`  变动 ${(d >= 0 ? "+" : "") + d}%  score=${String(m.score).padStart(4)} ${dir(m.score).padEnd(4)} damped=${m.damped.toFixed(2)}`);
}

/* Strict long/short symmetry on the shipped code. */
const seg = rows.slice(-260);
const centre = seg.at(-1).close;
const mirror = seg.map((r) => ({
  time: r.time, open: 2 * centre - r.open, high: 2 * centre - r.low,
  low: 2 * centre - r.high, close: 2 * centre - r.close,
}));
const a = metrics(seg).score, b = metrics(mirror).score;
console.log("\n=== 镜像对称性（做多/做空必须完全反号）===");
console.log(`  原序列=${a} (${dir(a)})   镜像=${b} (${dir(b)})   和=${a + b}  ${Math.abs(a + b) <= 1 ? "通过" : "不对称!"}`);

/* Mirrored live quote: a "long" reading must degrade when price falls, and the
   mirrored "short" reading must degrade when price rises. */
console.log("\n=== 双向压制验证 ===");
for (const d of [-0.4, 0.4]) {
  const lpUp = seg.at(-1).close * (1 + d / 100);
  const s1 = metrics(seg, lpUp).score;
  const lpDown = mirror.at(-1).close * (1 - d / 100);
  const s2 = metrics(mirror, lpDown).score;
  console.log(`  同向变动 ${d > 0 ? "+" : ""}${d}%: 多头序列=${String(s1).padStart(4)}(${dir(s1)})  镜像空头序列=${String(s2).padStart(4)}(${dir(s2)})  和=${s1 + s2}`);
}
