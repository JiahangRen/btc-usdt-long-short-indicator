/* Show why the projection panel used to "jump around".
   Uses the real metrics/classification from public/app.js with a full DOM stub. */
import fs from "node:fs";
import vm from "node:vm";

const OKX = (bar) =>
  fetch(`https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=${bar}&limit=300`).then((r) => r.json());
const toCandles = (j) =>
  j.data.map((r) => ({ time: +r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4] })).sort((a, b) => a.time - b.time);

const [raw5] = await Promise.all([OKX("5m")]);
const candles = toCandles(raw5);
const closed = candles.slice(0, -1);
const liveBase = candles.at(-1).close;

/* ---- universal DOM mock (same approach as verify-render.mjs) ---- */
const idMap = new Map();
const PREEXIST = new Set(["signal","signalReason","signalValidity","ruleSignalCard","indicators","sl","tp","fixedRuleBasis","connection","freshness","price","change","chart","intervals","ranges","coverage","diagnostics","resonance","loadResonance","source"]);
function makeUniversal() {
  const store = {};
  const fn = {
    appendChild: (c) => c, append: () => {}, prepend: () => {}, remove: () => {},
    insertBefore: (c) => c, setAttribute: () => {}, getAttribute: () => null,
    addEventListener: () => {}, after: () => {},
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
  getElementById(id){ if (idMap.has(id)) return idMap.get(id); if (PREEXIST.has(id)) { const e = makeUniversal(); idMap.set(id, e); return e; } return makeUniversal(); },
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
global.setTimeout = () => 0;
global.requestAnimationFrame = () => 0;
global.cancelAnimationFrame = () => {};
global.BTCPanels = makeUniversal();
global.ResonanceController = makeUniversal();

const code = fs.readFileSync("public/app.js", "utf8");
const tail = "\n;globalThis.__exp = { metrics, classification, RULE_SIGNAL_MIN_CANDLES };";
vm.runInThisContext(code + tail, { filename: "app.js" });
const { metrics, classification } = globalThis.__exp;

console.log(`OKX 5m: ${candles.length} candles, lastClosed=${closed.at(-1).close.toFixed(2)}, liveBase=${liveBase.toFixed(2)}\n`);

console.log("旧做法: metrics(state.candles) —— 把最新未收盘 K 线的 close 当成实时价");
for (const pct of [-0.003, -0.001, 0, 0.001, 0.003]) {
  const live = liveBase * (1 + pct);
  const stateCandles = candles.slice();
  stateCandles[stateCandles.length - 1] = { ...stateCandles.at(-1), close: live };
  const m = metrics(stateCandles);
  const lab = classification(m.score);
  console.log(`  live ${(pct * 100).toFixed(2).padStart(5)}%  score=${String(m.score).padStart(4)}  label=${lab[0].padEnd(4)}  MACD=${(m.macd ?? 0).toFixed(2).padStart(8)}  RSI=${(m.rsi ?? 0).toFixed(2).padStart(6)}`);
}

console.log("\n新做法: metrics(fixedRuleSignal.candles, livePrice) —— 收盘 K 线 + 实时价修正");
for (const pct of [-0.003, -0.001, 0, 0.001, 0.003]) {
  const live = liveBase * (1 + pct);
  const m = metrics(closed, live);
  const lab = classification(m.score);
  console.log(`  live ${(pct * 100).toFixed(2).padStart(5)}%  score=${String(m.score).padStart(4)}  label=${lab[0].padEnd(4)}  MACD=${(m.macd ?? 0).toFixed(2).padStart(8)}  RSI=${(m.rsi ?? 0).toFixed(2).padStart(6)}`);
}
