/* Minimal smoke test: ensure renderFixedRuleSignal and renderSignalProjection
   do not rewrite innerHTML when the computed markup has not changed.
   We use the same Universal DOM stub as verify-render.mjs. */
import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";

process.on("unhandledRejection", (e) => {
  process.stderr.write("unhandledRejection: " + (e.stack || e) + "\n");
  process.exit(3);
});

function makeUniversal(seed = "") {
  const store = { textContent: "", innerHTML: "", className: "", id: seed, _calls: [] };
  const methods = {
    appendChild: () => makeUniversal(),
    append: () => {},
    prepend: () => {},
    remove: () => {},
    insertBefore: () => makeUniversal(),
    setAttribute: () => {},
    getAttribute: () => null,
    addEventListener: () => {},
    after: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    removeChild: () => {},
    contains: () => false,
    toggle: () => {},
  };
  return new Proxy(() => {}, {
    get: (t, p) => {
      if (p === "textContent") return store.textContent;
      if (p === "innerHTML") return store.innerHTML;
      if (p === "className") return store.className;
      if (p === "style") return (store.style ||= { setProperty(){}, getPropertyValue(){return "";}, removeProperty(){} });
      if (p === "dataset") return (store.dataset ||= {});
      if (p === "classList") return (store.classList ||= { add(){}, remove(){}, contains(){return false;}, toggle(){} });
      if (p === "children") return [];
      if (p === "parentElement") return makeUniversal();
      if (p === "offsetWidth") return 0;
      if (typeof p === "string" && p in methods) return methods[p];
      if (p in store) return store[p];
      return makeUniversal();
    },
    set: (t, p, v) => {
      store._calls.push(`${String(p)}=${typeof v === "string" ? v.slice(0, 60) : v}`);
      store[p] = v;
      return true;
    },
  });
}

const idMap = new Map();
const createdEls = [];
const doc = {
  addEventListener: () => {},
  getElementById: (id) => {
    if (!idMap.has(id)) {
      const el = makeUniversal(id);
      idMap.set(id, el);
      createdEls.push(el);
    }
    return idMap.get(id);
  },
  querySelector: () => makeUniversal(),
  querySelectorAll: () => [],
  createElement: () => makeUniversal("created"),
  documentElement: makeUniversal("html"),
};

const globals = {
  document: doc,
  window: new Proxy({}, { get: () => makeUniversal(), set: () => true }),
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
  WebSocket: class { close(){} },
  setTimeout: () => 0,
  setInterval: () => 0,
  requestAnimationFrame: () => 0,
  addEventListener: () => {},
  matchMedia: () => ({ matches: false, addListener(){}, removeListener(){} }),
  console: { log: process.stderr.write.bind(process.stderr), warn: () => {}, error: process.stderr.write.bind(process.stderr) },
};
for (const [k, v] of Object.entries(globals)) global[k] = v;

const app = readFileSync("/Users/jeffereyreng/ChatGPT/btc指示器/public/app.js", "utf8");
const tail = `
;globalThis.__exp = {
  renderFixedRuleSignal,
  renderSignalProjection,
  metrics,
  classification,
  money,
  tx: (a) => a,
  fixedRuleSignal: { candles: [], presentation: null },
  state: { candles: [], ticker: {} },
};
`;

try {
  runInThisContext(app + tail, { filename: "app.js" });
} catch (e) {
  process.stderr.write("init error: " + (e.stack || e) + "\n");
  process.exit(1);
}
process.stderr.write("app.js evaluated\n");

const exp = globalThis.__exp;

const closed = [];
for (let i = 1; i <= 210; i++) {
  const c = 78900 + i * 15 + Math.sin(i) * 20;
  closed.push({ time: i, open: c - 5, high: c + 10, low: c - 15, close: c });
}
exp.fixedRuleSignal.candles = closed;
exp.fixedRuleSignal.interval = "5m";
exp.fixedRuleSignal.closedAt = closed.at(-1).time;
exp.fixedRuleSignal.source = "okx";
exp.fixedRuleSignal.presentation = null;
exp.fixedRuleSignal.confirmations = {};
exp.state.ticker = { last: closed.at(-1).close + 10 };

const primaryTrend = doc.createElement();
primaryTrend.id = "primaryTrend";
primaryTrend.className = "primary-trend";
const validity = doc.createElement();
validity.id = "signalValidity";
validity.className = "signal-validity";
const signalProjection = doc.createElement();
signalProjection.id = "signalProjection";
signalProjection.className = "signal-projection";

idMap.set("primaryTrend", primaryTrend);
idMap.set("signalValidity", validity);
idMap.set("signalProjection", signalProjection);

const signal = doc.getElementById("signal");
const reason = doc.getElementById("signalReason");

function clearWrites(el) { el._calls = []; }
function innerHTMLWrites(el) { return el._calls.filter(c => c.startsWith("innerHTML=")).length; }
function classNameWrites(el) { return el._calls.filter(c => c.startsWith("className=")).length; }

process.stderr.write("rendering fixed rule signal twice\n");
exp.renderFixedRuleSignal();
const ptWrites1 = innerHTMLWrites(primaryTrend);
const valWrites1 = innerHTMLWrites(validity);
const reaWrites1 = innerHTMLWrites(reason);

clearWrites(primaryTrend); clearWrites(validity); clearWrites(reason);
exp.renderFixedRuleSignal();
const ptWrites2 = innerHTMLWrites(primaryTrend);
const valWrites2 = innerHTMLWrites(validity);
const reaWrites2 = innerHTMLWrites(reason);

process.stderr.write("rendering projection twice\n");
exp.renderSignalProjection();
const projWrites1 = innerHTMLWrites(signalProjection);
const projClass1 = classNameWrites(signalProjection);
clearWrites(signalProjection);
exp.renderSignalProjection();
const projWrites2 = innerHTMLWrites(signalProjection);
const projClass2 = classNameWrites(signalProjection);

console.log("=== renderFixedRuleSignal DOM rewrite counts ===");
console.log(`primaryTrend innerHTML: first=${ptWrites1}, second=${ptWrites2}`);
console.log(`signalValidity innerHTML: first=${valWrites1}, second=${valWrites2}`);
console.log(`signalReason innerHTML: first=${reaWrites1}, second=${reaWrites2}`);
console.log("=== renderSignalProjection DOM rewrite counts ===");
console.log(`projection innerHTML: first=${projWrites1}, second=${projWrites2}`);
console.log(`projection className: first=${projClass1}, second=${projClass2}`);

const ok = ptWrites2 === 0 && valWrites2 === 0 && reaWrites2 === 0 && projWrites2 === 0 && projClass2 === 0;
console.log(ok ? "\nPASS: no unnecessary rewrites on second render" : "\nFAIL: still rewriting DOM when nothing changed");
process.exit(ok ? 0 : 1);
