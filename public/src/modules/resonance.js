// 多周期共振（D）模块：原 app.js 的加权一致性计算 + 自动刷新调度 + 卡片渲染。
// 常量 / 状态 / 调度 / 渲染全部收进本模块；app.js 仅保留卡面布局调度与 DOM 读取。
// 启动时由 initResonance() 完成按钮接线、首屏自动计算与可见性切换监听。
import { $, tx, state } from '../core.js?v=20260928a';
import { metrics } from '../signals.js?v=20260924b';

let resonanceTimer = null;

/* 多周期共振：加权一致性所需的常量（上移到此处，避免在 applyLanguage 早期调用时触发 TDZ）。
   **数组顺序 = 界面上的展示顺序（时间由小到大）**，也是加权时的遍历顺序，改动时留意。
   ttl = 该周期缓存的有效期，同时就是它在自动刷新里的目标节奏：15m 约 1 分钟、
   1h 约 5 分钟、4h 约 15 分钟、1d 约 1 小时、1w 约 6 小时（周线一周才收一根，不必勤刷）。
   取值略小于整数间隔，是为了不跟 20 秒的检查节拍撞线 —— 正好取 60_000 时，到点那一拍的
   已过时间往往只有 59.9s，会被判成「还没到期」而白漏一拍，变成每两拍才更新一次。
   weight 之和为 1，周期越大分量越重。 */
export const RES_INTERVALS = [
  { key: "15m", weight: 0.05, threshold: 35, ttl: 55_000 },
  { key: "1h", weight: 0.1, threshold: 45, ttl: 280_000 },
  { key: "4h", weight: 0.2, threshold: 45, ttl: 870_000 },
  { key: "1d", weight: 0.3, threshold: 45, ttl: 3_540_000 },
  { key: "1w", weight: 0.35, threshold: 45, ttl: 21_600_000 },
];
export const resonanceCache = {};
let resonanceSource = null;
/* 多周期共振的自动计算节奏。
   首屏：等核心 K 线渲染完之后再算一次，避免与首屏请求抢带宽。
   之后：每 RESONANCE_AUTO_MS 走一次「到期检查」—— 不强制全拉，只重算缓存已过期的周期，
   于是常态下一拍只真正拉 15m（约每分钟一次），1h / 4h / 1d 分别在 5 / 15 / 60 分钟才发请求，
   四个周期共 800 根 K 线不会被每分钟重拉一遍。检查本身不发请求，节拍取小一点没有代价。 */
const RESONANCE_AUTO_MS = 20_000,
  RESONANCE_FIRST_MS = 2_500;
function resetResonanceTimer() {
  clearTimeout(resonanceTimer);
  resonanceTimer = setTimeout(async () => {
    if (!document.hidden) await refreshResonance(false);
    resetResonanceTimer();
  }, RESONANCE_AUTO_MS);
}

/* Quiet live refresh and exchange comparison strip. */
;
function classifyTf(score, threshold) {
  if (score >= threshold) return [tx("做多", "Long"), "bull", 1];
  if (score <= -threshold) return [tx("做空", "Short"), "bear", -1];
  return [tx("观望", "Neutral"), "flat", 0];
}
async function fetchResonanceInterval(iv, force) {
  const now = Date.now(),
    c = resonanceCache[iv.key];
  if (!force && resonanceSource === state.source && c && now - c.ts < iv.ttl)
    return false;
  const r = await fetch(
    "/api/market?" +
      new URLSearchParams({
        interval: iv.key,
        limit: 200,
        source: state.source,
      }),
  );
  const x = await r.json();
  if (!r.ok) throw new Error(`${iv.key}: ${x.error}`);
  const m = metrics(x.candles),
    [, cls, dir] = classifyTf(m.score, iv.threshold);
  resonanceCache[iv.key] = {
    score: m.score,
    cls,
    dir,
    source: x.source,
    ts: now,
  };
  resonanceSource = state.source;
  return true;
}
/* 结论的唯一真源：徽标文案（同向周期数 + 强度）与标题行右侧那句四字短语都在这里算。
   `majority` 用比例而非写死 3，是为了周期数变动时门槛自动跟着走
   （4 个周期 → 3 个算多数；5 个周期 → 4 个算多数）。 */
export function resonanceVerdict() {
  if (!RES_INTERVALS.some((iv) => resonanceCache[iv.key])) return null;
  let longs = 0,
    shorts = 0,
    weighted = 0;
  for (const iv of RES_INTERVALS) {
    const c = resonanceCache[iv.key];
    if (!c) continue;
    const [, , dir] = classifyTf(c.score, iv.threshold);
    if (dir > 0) {
      longs++;
      weighted += iv.weight * (c.score / 100);
    } else if (dir < 0) {
      shorts++;
      weighted -= iv.weight * (c.score / 100);
    }
  }
  const total = RES_INTERVALS.length,
    mag = Math.round(Math.min(1, Math.abs(weighted)) * 100),
    majority = Math.ceil(total * 0.7);
  let cls, label, short;
  if (longs === total) {
    cls = "bull";
    label = `${tx("强共振·多", "Strong long")} (${total}/${total})`;
    short = tx("全线偏多", "All bullish");
  } else if (shorts === total) {
    cls = "bear";
    label = `${tx("强共振·空", "Strong short")} (${total}/${total})`;
    short = tx("全线偏空", "All bearish");
  } else if (longs >= majority) {
    cls = "bull";
    label = `${tx("多数·多", "Majority long")} (${longs}/${total})`;
    short = tx("多头占优", "Bulls lead");
  } else if (shorts >= majority) {
    cls = "bear";
    label = `${tx("多数·空", "Majority short")} (${shorts}/${total})`;
    short = tx("空头占优", "Bears lead");
  } else if (longs === 0 && shorts === 0) {
    cls = "flat";
    label = `${tx("无方向", "No direction")} (0/${total})`;
    short = tx("方向不明", "No direction");
  } else if (shorts === 0 || longs === 0) {
    /* 只有一侧有方向、但没到「多数」门槛：这是「偏多/偏空、还没共振」，
       不能叫分歧 —— 分歧的前提是多空两边都有人。 */
    const n = longs > 0 ? longs : shorts;
    cls = longs > 0 ? "bull" : "bear";
    label = `${longs > 0 ? tx("偏多", "Lean long") : tx("偏空", "Lean short")} · ${tx("待确认", "pending")} ${n}/${total}`;
    short = longs > 0 ? tx("偏多待确认", "Lean long") : tx("偏空待确认", "Lean short");
  } else {
    cls = "conflict";
    const lean =
      longs > shorts
        ? tx("偏多", "lean long")
        : longs < shorts
          ? tx("偏空", "lean short")
          : tx("均衡", "balanced");
    label = `${lean} · ${tx("分歧", "diverged")} ${longs}/${total}`;
    short = tx("多空分歧", "Diverged");
  }
  return { cls, label, mag, short };
}
function renderResonanceSummary() {
  const v = resonanceVerdict();
  return v
    ? `<div class="res-summary ${v.cls}"><b>${v.label}</b><small>${tx("强度", "str")} ${v.mag}</small></div>`
    : "";
}
export function renderResonanceChips() {
  const out = $("resonance");
  if (!out) return;
  const chips = RES_INTERVALS.map(({ key }) => {
    const c = resonanceCache[key];
    if (!c || c.error)
      return `<span class="res-chip flat" data-iv="${key}"><b>${key}</b><em>${tx("…", "…")}</em></span>`;
    const dirLabel =
      c.cls === "bull"
        ? tx("做多", "Long")
        : c.cls === "bear"
          ? tx("做空", "Short")
          : tx("观望", "Neutral");
    return `<span class="res-chip ${c.cls}" data-iv="${key}"><b>${key}</b><em>${dirLabel} ${c.score > 0 ? "+" : ""}${c.score}</em></span>`;
  }).join("");
  /* 结论分两处：徽标进标题右侧的槽位，一句话短语进它更右侧的短语位
     （用户要求：中间那块空位放「几个字」的简要结论）。右侧一栏只留逐周期标签。 */
  const v = resonanceVerdict(),
    summary = renderResonanceSummary(),
    slot = $("resonanceSummary"),
    verdict = $("resonanceVerdict");
  if (verdict) {
    verdict.textContent = v ? v.short : "";
    verdict.className = `res-verdict ${v ? v.cls : "flat"}`;
    verdict.hidden = !v;
  }
  if (slot) {
    slot.innerHTML = summary;
    out.innerHTML = `<div class="res-chips">${chips}</div>`;
  } else out.innerHTML = summary + `<div class="res-chips">${chips}</div>`;
  highlightResonanceConflict();
  /* 按钮文字跟随计算状态：已算出 chips 就显示「重新计算共振」，
     避免自动计算后按钮仍是「计算共振」，让用户误以为还没算过 / 点击无效。 */
  const loadBtn = $("loadResonance");
  if (loadBtn) {
    loadBtn.textContent = out.querySelector(".res-chip")
      ? tx("重新计算共振", "Recalculate resonance")
      : tx("计算共振", "Calculate resonance");
  }
}
function highlightResonanceConflict() {
  const out = $("resonance");
  if (!out) return;
  const dirs = RES_INTERVALS.map((iv) => {
    const c = resonanceCache[iv.key];
    return c ? classifyTf(c.score, iv.threshold)[2] : 0;
  });
  const longs = dirs.filter((d) => d > 0).length,
    shorts = dirs.filter((d) => d < 0).length;
  if (longs === 0 || shorts === 0) return;
  const dom = longs >= shorts ? 1 : -1;
  RES_INTERVALS.forEach((iv, i) => {
    const chip = out.querySelector(`.res-chip[data-iv="${iv.key}"]`);
    if (!chip) return;
    if (dirs[i] !== 0 && dirs[i] !== dom) chip.classList.add("conflict");
    else chip.classList.remove("conflict");
  });
}
export async function refreshResonance(forceAll) {
  const loadBtn = $("loadResonance");
  if (loadBtn && forceAll) loadBtn.textContent = tx("计算中…", "Computing…");
  let changed = false;
  await Promise.all(
    RES_INTERVALS.map(async (iv) => {
      try {
        if (await fetchResonanceInterval(iv, forceAll)) changed = true;
      } catch (e) {
        resonanceCache[iv.key] = {
          ...(resonanceCache[iv.key] || {}),
          error: e.message,
          ts: Date.now(),
        };
        changed = true;
      }
    }),
  );
  if (changed || forceAll) renderResonanceChips();
  return changed;
}
export function initResonance() {
  $("loadResonance").onclick = () => refreshResonance(true);
  resetResonanceTimer();
  /* 打开页面自动计算一次：不点按钮也能直接看到共振结论。 */
  setTimeout(() => {
    if (!document.hidden) refreshResonance(true);
  }, RESONANCE_FIRST_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearTimeout(resonanceTimer);
    else resetResonanceTimer();
  });
}

