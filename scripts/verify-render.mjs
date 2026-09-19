/* Runtime verify of the A-option display changes in renderFixedRuleSignal.
   Loads the real public/app.js in a vm with a minimal DOM stub, feeds it live
   OKX candles, and inspects the rendered #signal / #signalValidity /
   #primaryTrend text. */
import fs from "node:fs";
import vm from "node:vm";

const OKX = (bar) =>
  fetch(`https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=${bar}&limit=300`).then((r) => r.json());
const toCandles = (j) => j.data.map((r) => ({ time: +r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4] })).sort((a, b) => a.time - b.time);

const [raw5, raw1h] = await Promise.all([OKX("5m"), OKX("1H")]);
const c5 = toCandles(raw5), c1h = toCandles(raw1h);
console.log(`OKX: 5m=${c5.length}  1h=${c1h.length}`);

/* ---- universal DOM mock (Proxy) so app.js init can run without a browser ---- */
const createdEls = [];
const idMap = new Map();
const PREEXIST = new Set(["signal","signalReason","signalValidity","ruleSignalCard","indicators","sl","tp","fixedRuleBasis","connection","freshness","price","change","chart","intervals","ranges","coverage","diagnostics","resonance","loadResonance","source"]);
function makeUniversal() {
  const store = {};
  const fn = {
    appendChild: (c) => c, append: () => {}, prepend: () => {}, remove: () => {},
    insertBefore: (c) => c, setAttribute: () => {}, getAttribute: () => null,
    addEventListener: () => {}, after: (c) => { createdEls.push(c); },
    querySelector: () => makeUniversal(), querySelectorAll: () => [],
    closest: () => makeUniversal(), removeChild: () => {}, contains: () => false, toggle: () => {},
  };
  const proxy = new Proxy(function(){}, {
    get(t, prop) {
      if (prop === "textContent") return store.textContent ?? "";
      if (prop === "innerHTML") return store.innerHTML ?? "";
      if (prop === "className") return store.className ?? "";
      if (prop === "style") return (store.style ||= { setProperty(){}, removeProperty(){}, getPropertyValue(){return "";} });
      if (prop === "dataset") return (store.dataset ||= {});
      if (prop === "classList") return (store.classList ||= { add(){}, remove(){}, contains(){return false;}, toggle(){} });
      if (prop === "children") return (store.children ||= []);
      if (prop === "elements") return (store.elements ||= makeUniversal());
      if (prop === "parentElement") return (store.parentElement ||= makeUniversal());
      if (prop === "offsetWidth") return 0;
      if (prop === Symbol.iterator) return function*(){};
      if (prop === "then") return undefined;
      if (typeof prop === "string" && prop in fn) return fn[prop];
      if (prop in store) return store[prop];
      return makeUniversal();
    },
    set(t, prop, val) { store[prop] = val; if (prop === "id" && typeof val === "string") idMap.set(val, proxy); return true; },
  });
  return proxy;
}
global.document = {
  addEventListener(){},
  getElementById(id){ if (idMap.has(id)) return idMap.get(id); if (id === "primaryTrend") return null; if (PREEXIST.has(id)) { const e = makeUniversal(); idMap.set(id, e); return e; } const e = makeUniversal(); idMap.set(id, e); return e; },
  querySelector(){ return makeUniversal(); },
  querySelectorAll(){ return []; },
  createElement(){ return makeUniversal(); },
  documentElement: makeUniversal(),
};
global.window = global;
global.addEventListener = () => {};
global.matchMedia = () => ({ matches: false, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){} });
global.MutationObserver = class { constructor(){} observe(){} disconnect(){} };
global.ResizeObserver = class { observe(){} disconnect(){} };
global.getComputedStyle = () => ({ getPropertyValue: () => "" });
global.WebSocket = class { close(){} };
global.localStorage = { _m:{}, getItem(k){ return this._m[k] ?? null; }, setItem(k,v){ this._m[k] = String(v); } };
global.fetch = () => Promise.reject(new Error("no local server in test"));
global.setInterval = () => 0;
/* Execute 0ms timeouts immediately so the real enhanced renderSignalProjection
   overwrites its stub. Longer timeouts are ignored. */
global.setTimeout = (fn, ms) => { if (typeof fn === "function" && ms === 0) fn(); return 0; };
global.requestAnimationFrame = () => 0;
global.BTCPanels = makeUniversal();
global.ResonanceController = makeUniversal();

const code = fs.readFileSync("public/app.js", "utf8");
const tail = "\n;globalThis.__exp = { renderFixedRuleSignal: renderFixedRuleSignalBase, fixedRuleSignal, deriveStableRulePresentation, metrics, ruleDirectionForScore };";
vm.runInThisContext(code + tail, { filename: "app.js" });
const { renderFixedRuleSignal, fixedRuleSignal, deriveStableRulePresentation } = globalThis.__exp;

/* ---- feed live data ---- */
fixedRuleSignal.candles = c5;
fixedRuleSignal.interval = "5m";
fixedRuleSignal.source = "okx";
fixedRuleSignal.closedAt = c5.at(-1).time;
fixedRuleSignal.confirmations = { "1h": { candles: c1h, closedAt: c1h.at(-1).time } };

function runScenario(name) {
  createdEls.length = 0;
  let threw = null;
  try { renderFixedRuleSignal(); } catch (e) { threw = e; }
  const sig = document.getElementById("signal");
  const val = document.getElementById("signalValidity");
  const pt = idMap.get("primaryTrend");
  return { name, threw, sig: sig.textContent, val: val.innerHTML, pt: pt ? pt.innerHTML : "(未创建)" };
}

/* 场景一：真实 confirmations（当前行情大概率已确认） */
fixedRuleSignal.presentation = deriveStableRulePresentation();
const r1 = runScenario("场景一 真实");

/* 场景二：强制『趋势观察·待收盘』分支，验证 5m 反转语义措辞 */
fixedRuleSignal.presentation = {
  confirmed: false, revalidating: false, label: "偏多趋势 · 待收盘", cls: "bull",
  confirmations: [{ interval: "15m", direction: "bull" }, { interval: "1h", direction: "bear" }],
};
const r2 = runScenario("场景二 待收盘/反转语义");

console.log("\n=== 渲染结果 ===");
for (const r of [r1, r2]) {
  console.log(`\n[${r.name}]`);
  if (r.threw) { console.log("  ❌ 抛错:", r.threw.message); continue; }
  console.log("  signal      =", JSON.stringify(r.sig));
  console.log("  validity    =", JSON.stringify(r.val));
  console.log("  primaryTrend=", JSON.stringify(r.pt));
}

/* ---- assertions ---- */
const checks = [];
checks.push(["场景一 不抛错", !r1.threw]);
checks.push(["场景一 有效期含『有效至』", /有效至/.test(r1.val)]);
checks.push(["场景一 有效期含『破位即撤销』", /破位即撤销/.test(r1.val)]);
checks.push(["场景一 1h 主方向条已渲染", /1h 主方向/.test(r1.pt)]);
checks.push(["场景一 1h 条含方向词", /(做多|做空|观望|加载中)/.test(r1.pt)]);
checks.push(["场景二 不抛错", !r2.threw]);
checks.push(["场景二 5m 反转语义(超买/超卖)", /超买|超卖/.test(r2.sig)]);
checks.push(["场景二 含『待收盘』", /待收盘/.test(r2.sig)]);
checks.push(["场景二 1h 主方向条已渲染", /1h 主方向/.test(r2.pt)]);
console.log("\n=== 断言 ===");
let ok = true;
for (const [name, pass] of checks) { console.log(`${pass ? "✓" : "✗"} ${name}`); if (!pass) ok = false; }
console.log(ok ? "\n全部通过" : "\n存在失败项");
process.exit(ok ? 0 : 1);
