/* ═══════════════════════════════════════════════════════════════════════════
 * src/core.js —— 前端「共享内核 / Shared kernel」
 * ───────────────────────────────────────────────────────────────────────────
 * 本文件承载**所有功能模块共用**的底座：
 *   1. DOM 便捷函数（$）
 *   2. 币种上下文（多币种模式 / 当前币种 / 交易对标签 / 请求带 symbol）
 *   3. 请求调度器（6 并发 + 优先级队列）与 window.fetch 覆盖
 *   4. 脚本按需 / 空闲加载器（loadScriptOnce / whenIdle）
 *   5. 全局可变状态容器 state
 *   6. 纯工具：极值、均线、数字/时间格式化、带超时请求
 *   7. i18n：I18N 字典、当前语言 uiLang、翻译函数 tx
 *
 * 【模块化关键约定 · 务必先读】
 *   ES module 的 import 是**只读绑定**：跨模块「读取」共享变量无需任何改动
 *   （live binding 永远拿到最新值）；但**不能**对导入进来的变量重新赋值。
 *   因此本文件对「会被其它模块改写」的可变标量一律额外导出一个 **setter**
 *   （commitXxx / setXxxState）。约定：
 *     · 只读使用  → 直接 import 该变量（如 tx、activeCoin、state）
 *     · 需要改写  → 调用对应 setter（如 setUiLangState(...)）
 *   注意 setter 命名刻意避开业务代码里的同名函数（如 app.js 内部已有
 *   局部的 setCoinMode / setActiveCoin / setActiveCoin），避免遮蔽冲突。
 * ═══════════════════════════════════════════════════════════════════════════ */

import { COINS, BASE_COIN, normalizeCoin } from '/shared/coins.mjs';
// 重新导出币种符号，供各功能模块直接 import（避免每个模块都去引 /shared/coins.mjs）。
export { COINS, BASE_COIN, normalizeCoin };

/* ── 1. DOM 便捷函数 ─────────────────────────────────────────────────────── */

/** 按 id 取元素（全站最高频的 DOM 助手）。 */
export const $ = (id) => document.getElementById(id);

/* ── 2. 币种上下文 / Coin context ───────────────────────────────────────────
 * 两种模式：
 *   bitcoin —— 比特币模式。页面与多币种改造之前**完全一致**，币种恒为 BTC。
 *   multi   —— 多币种模式。可在 BTC / ETH / ZEC / BNB 之间切换，
 *              切换后整页（行情、图表、信号、微观结构、研究预测、宏观）都基于该币种。
 * 模式与币种都记在本机 localStorage，刷新后保持。
 *
 * Two modes: `bitcoin` (identical to the pre-multi-coin page, coin pinned to BTC)
 * and `multi` (switch between BTC/ETH/ZEC/BNB; the whole page follows the choice).
 * Both the mode and the selected coin persist in localStorage.
 */
export const COIN_MODE_KEY = 'btc_coin_mode_v1';
export const COIN_SYMBOL_KEY = 'btc_coin_symbol_v1';

/** 当前币种模式：'bitcoin' | 'multi'。可变——切模式时调用 setCoinModeState()。 */
export let coinMode = localStorage.getItem(COIN_MODE_KEY) === 'multi' ? 'multi' : 'bitcoin';
/** 多币种模式下选中的币种（已归一化）。可变——切币时调用 setSelectedCoinState()。 */
export let selectedCoin = normalizeCoin(localStorage.getItem(COIN_SYMBOL_KEY));

/** setter：写 coinMode（仅内核内部与 app.js 的切模式逻辑使用）。 */
export const setCoinModeState = (value) => { coinMode = value; };
/** setter：写 selectedCoin（仅内核内部与 app.js 的切币逻辑使用）。 */
export const setSelectedCoinState = (value) => { selectedCoin = value; };

/** 是否处于多币种模式。 */
export const isMultiCoinMode = () => coinMode === 'multi';
/** 当前真正生效的币种：比特币模式下恒为 BTC。所有接口请求都用它。 */
export const activeCoin = () => (isMultiCoinMode() ? selectedCoin : BASE_COIN);
/** 取某币种的元数据（合约 ID / 显示名等）；缺省用当前生效币种。 */
export const coinMetaOf = (coin = activeCoin()) => COINS[normalizeCoin(coin)] || COINS[BASE_COIN];
/** 「BTC / USDT」这类展示用交易对。 */
export const coinPair = (coin = activeCoin()) => `${normalizeCoin(coin)} / USDT`;
/** 仅币种符号，如「BTC」。 */
export const coinLabel = (coin = activeCoin()) => normalizeCoin(coin);
/** 多币种本地存储键的币种后缀：BTC 用旧键（无后缀），其余币种 "_<COIN>"。
 *  放在文件最前，任何按币种隔离的 localStorage 键都复用它（避免 TDZ）。
 *  可选入参 coin：分屏要按「面板的币种」取键（此时它不等于当前币种），必须显式传。 */
export const coinStorageSuffix = (coin = activeCoin()) => {
  const key = normalizeCoin(coin);
  return key === BASE_COIN ? '' : '_' + key;
};
// 与币种强相关的接口：请求时自动带上 symbol，服务端据此切换缓存 / SQLite / 合约。
// 账户、登录、语音、AI 配置等不属于行情，不带。
export const COIN_SCOPED_API = ['/api/market', '/api/quote', '/api/status', '/api/forecast-history',
  '/api/research-outlook',
  '/api/correlation-history', '/api/news', '/api/ai/'];
/** 若 url 属于「与币种强相关的接口」且尚未带 symbol，则补上当前币种。 */
export function withCoin(url) {
  if (typeof url !== 'string' || url.indexOf('/api/') < 0) return url;
  const path = url.split('?')[0].split('#')[0];
  if (!COIN_SCOPED_API.some((prefix) => path === prefix || path.startsWith(prefix + '/'))) return url;
  if (/[?&]symbol=/.test(url)) return url;
  return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'symbol=' + activeCoin();
}

/* ── 3. 前端请求调度器 ──────────────────────────────────────────────────────
 * v2.11.80：同域仅 6 条 HTTP 连接，首屏曾并发 ~73 个 /api/ 请求，把连接打满、
 * 实时价 quote 排队 20+ 秒。这里在 fetch 层（模块内 fetch 标识符 + window.fetch）
 * 统一加并发限制（6）+ 优先级队列：实时价 quote 最高优先插队，语音/AI 外部依赖
 * 最低优先，其余默认。非 /api/ 请求（静态资源、外部 API）原样放行。 */
const _origFetch = window.fetch.bind(window);
const _apiQueue = (() => {
  const MAX = 6, queue = [];
  let running = 0;
  function pump() {
    if (running >= MAX) return;
    let bi = -1;
    for (let i = 0; i < queue.length; i++) if (bi < 0 || queue[i].p > queue[bi].p) bi = i;
    if (bi < 0) return;
    const job = queue.splice(bi, 1)[0];
    running++;
    Promise.resolve().then(() =>
      job.fn().then(job.res, job.rej).finally(() => { running--; pump(); })
    );
  }
  return { add(fn, p) { return new Promise((res, rej) => { queue.push({ fn, p, res, rej }); pump(); }); } };
})();
/** 请求优先级：实时价最高(3)，语音/AI 最低(0)，其余默认(1)。 */
function _apiPriority(u) {
  if (u.indexOf('/api/quote') >= 0) return 3;
  if (u.indexOf('/api/voice') >= 0 || u.indexOf('/api/ai/') >= 0) return 0;
  return 1;
}
/* v2.12.26：请求合并（coalescing）—— 同一 method+URL 在「在飞」或「刚落定 1.2s」内，
 * 复用同一次网络请求，避免多个模块在初始化/刷新期对同一端点重复打网络（曾观测到
 * forecast-history 4×、research-outlook 2×、correlation-history 3× 等重载荷重复请求，
 * 单页首屏浪费 1.5MB+）。每个调用者拿到独立 clone()，互不消费彼此的响应体。
 * 短 grace（1200ms）远小于各端点轮询间隔（实时价 2s、其余分钟级），不影响正常刷新。 */
const _DEDUP_GRACE_MS = 1200;
const _apiInflight = new Map();   // method+url -> Promise<Response>（在飞）
const _apiGrace = new Map();      // method+url -> { res: 未读 Response, t: ms }（落定后快照）
async function _dedupeFetch(target, opts) {
  const key = (opts && opts.method || 'GET') + ' ' + (typeof target === 'string' ? target : target.url);
  // ① 落定 grace 内的快照：直接返回克隆，零网络
  const cached = _apiGrace.get(key);
  if (cached && Date.now() - cached.t < _DEDUP_GRACE_MS) return cached.res.clone();
  // ② 在飞：复用同一 promise，调用者各自 clone()
  const inflight = _apiInflight.get(key);
  if (inflight) return inflight.then((r) => r.clone());
  // ③ 新请求：发起一次，存 in-flight；落定后转存 grace 快照并从 in-flight 移除
  const p = _origFetch(target, opts).then(
    (res) => {
      _apiInflight.delete(key);
      // 快照保留一个「未读」的 clone，调用方通过 .clone() 读取（未读的 Response 可无限克隆）
      _apiGrace.set(key, { res: res.clone(), t: Date.now() });
      setTimeout(() => { const g = _apiGrace.get(key); if (g && Date.now() - g.t >= _DEDUP_GRACE_MS) _apiGrace.delete(key); }, _DEDUP_GRACE_MS + 50);
      return res;
    },
    (err) => { _apiInflight.delete(key); throw err; }
  );
  _apiInflight.set(key, p);
  return p.then((r) => r.clone());
}
/** 包装后的 fetch：/api/ 请求走队列 + 合并，其余直接放行。 */
function _wrappedFetch(url, opts) {
  const target = withCoin(url);
  const u = typeof target === 'string' ? target : (target && target.url) || '';
  if (u.indexOf('/api/') >= 0) return _apiQueue.add(() => _dedupeFetch(target, opts), _apiPriority(u));
  return _origFetch(target, opts);
}
// 覆盖全局 fetch，使所有模块（含 split-mode.js / ai-chat.js 等）都走同一调度器。
window.fetch = _wrappedFetch;

/* ── 4. 脚本按需 / 空闲加载器 ───────────────────────────────────────────────
 * v2.11.83：ai-chat.js(144KB) 与 html2canvas.min.js(196KB) 与首屏无关，但此前作为
 * defer 脚本仍会在 DCL 前下载并解析执行，占着主线程。这里把它们移出首屏关键路径：
 * 先排队 html2canvas（AI 长截图依赖它），随后加载 ai-chat —— 后者是自启动 IIFE，
 * 尾部 `readyState === "loading" ? DOMContentLoaded : boot()`，
 * 所以即使延迟插入到已就绪的 DOM，它也会走 else 分支正常启动。 */
const __loadedScripts = new Set();
/** 惰性加载一个脚本（同一 src 只加载一次）。 */
export function loadScriptOnce(src) {
  // v2.12.31：按「路径（去掉 ?v= 查询串）」去重，而非整串。
  // 否则 ai-chat.js?v=2.12.31 与 ai-chat.js?v=20260924b 会被当成两个不同脚本各加载一次，
  // 在 core 被实例化多次时会重复注入按钮。剥离查询串后用归一 key 判重。
  // Dedupe by normalized path (strip the ?v= query) so the same logical script
  // loaded under different cache stamps counts as one.
  const norm = String(src).split('?')[0];
  if (__loadedScripts.has(norm)) return Promise.resolve(true);
  __loadedScripts.add(norm);
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.onload = () => resolve(true);
    el.onerror = () => { __loadedScripts.delete(norm); reject(new Error('script load failed: ' + src)); };
    document.head.appendChild(el);
  });
}
// 暴露给经典脚本（非 module）使用同一套加载器。
window.loadJsOnce = loadScriptOnce;
/** 空闲时执行（有 requestIdleCallback 用它，否则退化为 setTimeout）。 */
export const whenIdle = (fn) => (window.requestIdleCallback ? window.requestIdleCallback(fn, { timeout: 3000 }) : window.setTimeout(fn, 1));
// 首屏空闲后预取两个重资产（AI 长截图 + AI 助手），失败静默。
whenIdle(() => {
  loadScriptOnce('/html2canvas.min.js?v=1').catch(() => {});
  loadScriptOnce('/ai-chat.js?v=20260924b').catch(() => {});
});

/* ── 5. 极值辅助 ────────────────────────────────────────────────────────────
 * 用循环代替 Math.max(...arr) / Math.min(...arr) 的展开写法。
 * 当 arr 很大时，spread 会把每个元素当作函数实参展开，可能触发调用栈溢出
 * （RangeError: maximum call stack size exceeded）。空数组行为与 Math 一致：
 * maxOf([]) === -Infinity，minOf([]) === Infinity，因此可直接替换、语义不变。 */
export function maxOf(arr) {
  let m = -Infinity;
  for (let i = 0; i < arr.length; i++) if (arr[i] > m) m = arr[i];
  return m;
}
export function minOf(arr) {
  let m = Infinity;
  for (let i = 0; i < arr.length; i++) if (arr[i] < m) m = arr[i];
  return m;
}

/* ── 6. 前端常量 ────────────────────────────────────────────────────────────
 * 从散落魔法数字集中提取，便于审阅与统一调整。只收录语义清晰、用途单一的
 * 散落数字；坐标等绘图常量保持就近声明。 */
export const VOICE_LIST_POPULATE_DELAY_MS = 350;        // 启动后延迟拉取语音列表，避开初始化竞争
export const LONG_TERM_INTERVAL_MIN = 240;              // “长周期”阈值：>= 4h（240 分钟）
export const DAILY_HISTORY_MAX_RETRIES = 3;             // 日线历史拉取失败后的最大重试次数
export const DAILY_HISTORY_RETRY_DELAY_MS = 4_000;      // 日线历史重试间隔（4s，避开上游限频）

/* ── 7. 全局可变状态容器 ────────────────────────────────────────────────────
 * 首屏采用 1 分钟 K 线与 6 小时可见范围，便于直接观察短线结构。
 * 这是**唯一**的大状态对象：成员均为属性读写，因此跨模块 import 后可直接
 * mutate（如 state.candles = ...），无需 setter。 */
export const state = {
  interval: '1m',
  limit: 360,
  range: '6时',
  viewPoints: 361,
  source: 'okx',
  candles: [],
  marketMeta: null,
  ticker: null,
  lastGood: null,
  loading: false,
  reloadQueued: false,
  zoom: 1,
  frozenCandles: null,
};

/* ── 8. 纯工具：数字 / 时间格式化 ─────────────────────────────────────────── */
/** 美元金额，保留两位小数；非有限数显示 "--"。 */
export const money = (n) =>
  Number.isFinite(n)
    ? '$' +
      n.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    : '--';
/** 百分比，带正负号；非有限数显示 "--"。 */
export const pct = (n) =>
  Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${n.toFixed(2)}%` : '--';
/** 资金费率百分比，4 位小数并带正负号；非有限数显示 "--"。
 *  原在 app.js 本地定义，抽微观结构模块时上提为共享工具。 */
export function formatRate(value) {
  return Number.isFinite(value)
    ? `${value >= 0 ? '+' : ''}${(value * 100).toFixed(4)}%`
    : '--';
}
/** 短时间（MM-DD HH:mm，zh-CN 格式）。 */
export const time = (ms) =>
  new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(ms);
/** 主图 X 轴时间标签格式化；短周期显示 HH:mm，跨天或长周期追加 MM-DD，
 *  跨度跨年时再追加年份（1Y 这类范围内 MM-DD 会指代不明）。 */
export function formatTimeAxisLabel(ms, showDate, showYear) {
  const d = new Date(ms);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (!showDate) return hm;
  const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return showYear ? `${d.getFullYear()}-${md} ${hm}` : `${md} ${hm}`;
}
/** 覆盖信息里的完整时间（含年份），用于跨度跨年的范围。 */
export const timeFull = (ms) =>
  new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(ms);

/* ── 8b. 区间标签 / 完整时间（随语言切换） ───────────────────────────────── */
/** 区间标签双语映射（zh 显示原值，en 显示英文）。 */
export const INTERVAL_LABELS = {
  "5分": "5m", "15分": "15m", "30分": "15m", "1时": "1h", "3时": "3h",
  "6时": "6h", "12时": "12h", "1小时": "1h", "3小时": "3h",
  "5分钟": "5 min", "15分钟": "15 min", "30分钟": "30 min",
  "1小时": "1 hour", "3小时": "3 hours",
};
/** 区间标签按当前语言返回（zh 原值，en 英文）。 */
export const txInterval = (v) => (uiLang === "zh" ? v : INTERVAL_LABELS[v] || v);
/** 完整时间（MM-DD HH:mm:ss，随语言切换 zh-CN / en-US）。 */
export function pointTime(ms) {
  return new Intl.DateTimeFormat(uiLang === "zh" ? "zh-CN" : "en-US", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(ms);
}

/* ── 9. 带超时的请求 / 简易均线 ───────────────────────────────────────────── */
/** 带 AbortController 超时的 fetch（默认 8s），并禁用浏览器缓存。 */
export async function apiFetch(url, timeout = 8_000) {
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { cache: 'no-store', signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
/** 简单移动平均；前 p-1 个点返回 NaN（与原有实现一致）。 */
export function sma(values, p) {
  return values.map((_, i) =>
    i < p - 1
      ? NaN
      : values.slice(i - p + 1, i + 1).reduce((a, b) => a + b, 0) / p,
  );
}

/* ── 10. i18n：字典 / 当前语言 / 翻译 ─────────────────────────────────────── */
/** 界面文案字典（zh / en）。 */
export const I18N = {
  zh: {
    title: 'BTC/USDT 多空指标指示器',
    source: '数据源',
    refresh: '刷新',
    kline: 'K 线周期',
    range: '查看范围',
    forecast: '多周期概率预测',
    correlation: 'BTC × 美股联动',
    theme: ['自动', '浅色', '深色'],
    fullscreen: '全屏',
    exitFullscreen: '退出全屏',
  },
  en: {
    title: 'BTC/USDT Long–Short Indicator',
    source: 'Source',
    refresh: 'Refresh',
    kline: 'Candle interval',
    range: 'Visible range',
    forecast: 'Multi-horizon probability',
    correlation: 'BTC × US equities linkage',
    backtest: 'Research backtest (expand)',
    theme: ['Auto', 'Light', 'Dark'],
    fullscreen: 'Fullscreen',
    exitFullscreen: 'Exit fullscreen',
  },
};
/** 当前界面语言：'zh' | 'en'。可变——切换语言时调用 setUiLangState()。 */
export let uiLang = localStorage.getItem('btc_lang') || 'zh';
/** setter：写 uiLang（仅 app.js 的语言切换逻辑使用）。 */
export const setUiLangState = (value) => { uiLang = value; };
/** 取当前语言的字典。 */
export function locale() {
  return I18N[uiLang];
}
/** 翻译函数：zh 取中文，否则取英文。
 *  注意：必须在任何调用点之前初始化完毕——由于本文件是 module，import 会在
 *  app.js 模块体执行前完成求值，因此比原先「定义在 IIFE 之前」更安全（无 TDZ）。 */
export const tx = (zh, en) => (uiLang === 'zh' ? zh : en);

/* ── 11. 跨模块注册表 ───────────────────────────────────────────────────────
 * 用于打断潜在的循环依赖：模块 A 需要调用模块 B 的函数时，可在加载期把引用
 * 挂到本注册表（registry.kline = { renderChart }），运行期再从注册表取用，
 * 从而避免 A ←→ B 的 import 环。 */
export const registry = {};

/* ── 8. HTML 安全转义工具（全局通用） ───────────────────────────────────────
 * safeText：把任意文本安全插入 innerHTML，防止 XSS / 标签破坏。
 * safeHref：仅放行 http/https 链接，其余返回 "#"，防止 javascript: 等协议注入。
 * 原定义在 app.js 顶部，因被全站数十处引用，抽离研究模块前统一收归内核。 */
export const safeText = (value) =>
  String(value ?? "").replace(
    /[&<>'"]/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char],
  );
export const safeHref = (value) => {
  try {
    const url = new URL(String(value || ""));
    return /^https?:$/.test(url.protocol) ? url.href : "#";
  } catch {
    return "#";
  }
};

/* ── 11b. 日历 / HTML 转义（calendarEscape） ───────────────────────────
 * calendarEscape：转义 & < > "，用于把事件标题 / 国家 / 数值等文本安全塞进
 * 模板字符串。投资日历、宏观事件、API 接入中心模态共用。原定义在 app.js
 * 顶部，因宏观子系统与 API 接入中心都要用，收归内核保证单一来源。 */
export const calendarEscape = (value) =>
  String(value ?? "--").replace(
    /[&<>"]/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char],
  );

/* ── 12. 帮助系统（help-dot 说明） ─────────────────────────────────
 * 被研究域、共振卡、周期涨幅卡等共用；抽离研究模块前收归内核，避免循环依赖。
 * addHelp 创建一个「!」说明按钮；setCardHelpTip / syncCardHelpTips 给指定卡片挂说明。 */
export const RESONANCE_HELP = {
  zh:
    "<b>多周期共振 · 使用说明</b><br><br>" +
    "自动聚合 15m / 1h / 4h / 1d / 1w 五个周期的方向一致性：把五个周期的规则信号方向放在一起比对，权重依次为 0.05 / 0.1 / 0.2 / 0.3 / 0.35 —— 周期越大，分量越重。<br><br>" +
    "<b>怎么读</b><br>" +
    "· 标题旁那句几个字的短语 = 一句话结论（全线偏多 / 多头占优 / 多空分歧 …）。<br>" +
    "· 短语左边的徽标 = 更细的结论：强共振（5/5 同向）＞多数（4/5）＞单边待确认（只有一侧有方向、还没共振）＞多空分歧（两边都有人），括号里是同向的周期数。<br>" +
    "· 徽标里的「强度 0–100」= 加权后的方向力度，越高越「一边倒」。<br>" +
    "· 每个周期一个标签（按周期从小到大排）：周期 → 方向与评分（±100）；与主流方向相反的会加红色虚线框，标成冲突周期。<br><br>" +
    "<b>怎么用</b><br>" +
    "· 强共振且强度高：顺大势交易，规则信号的背景更可靠，但入场点与止损仍要单独判断。<br>" +
    "· 出现分歧或冲突周期：大小周期打架，多为回调或震荡，宜减仓或等它重新同向。<br>" +
    "· 优先做与日线、周线同向的交易；这两个大周期与你的方向相反时，短线胜率通常更差。<br><br>" +
    "<b>自动计算</b>：打开页面自动算一次，之后按周期自动刷新 —— 15m 约每分钟、1h 约 5 分钟、4h 约 15 分钟、1d 约 1 小时、1w 约 6 小时各重算一次；点「计算共振」可立即强制全部重算。<br><br>" +
    "<b>注意</b>：该结论只描述技术面是否同向，不含基本面与资金面，不构成投资建议。",
  en:
    "<b>Multi-timeframe resonance · how to use</b><br><br>" +
    "Auto-aggregates direction agreement across 15m / 1h / 4h / 1d / 1w: it compares the rule-signal direction on all five, weighted 0.05 / 0.1 / 0.2 / 0.3 / 0.35 — the higher the timeframe, the more it counts.<br><br>" +
    "<b>Reading it</b><br>" +
    "· The few-word phrase next to the title = the one-line verdict (All bullish / Bulls lead / Diverged …).<br>" +
    "· The badge left of it is the finer verdict: strong (5/5 agree) > majority (4/5) > one-sided but still pending > diverged (both sides present); the fraction is how many agree.<br>" +
    "· \"strength 0–100\" = weighted conviction; higher means more one-sided.<br>" +
    "· Each chip is one timeframe, ordered shortest → longest: interval → direction and score (±100); a red dashed box marks a timeframe fighting the dominant direction.<br><br>" +
    "<b>Using it</b><br>" +
    "· Strong resonance with high strength: trade with the dominant side — better context, but entry and stop still need their own check.<br>" +
    "· Diverged, or a conflicting chip: timeframes disagree, usually a pullback or a range — trim, or wait until they realign.<br>" +
    "· Prefer trades that agree with the daily and weekly timeframes; short-term win rate is usually worse against them.<br><br>" +
    "<b>Auto refresh</b>: computed once on page load, then refreshed per timeframe — roughly every minute (15m), 5 min (1h), 15 min (4h), 1 hour (1d) and 6 hours (1w). The button forces a full recalculation.<br><br>" +
    "<b>Note</b>: this only describes whether the technical picture agrees; no fundamentals or flows, and not investment advice.",
};
/* 「周期涨幅」的说明。原先它和共振共用同一段文字（两张卡共用一个 help 文案），拆开各写各的。 */
export const PERIOD_RETURNS_HELP = {
  zh: "周期涨幅展示 15 分钟到 1 年共 9 个周期的涨跌幅，用来判断当前这一波在更长时间尺度上是延续还是背离。",
  en: "Period returns show the change over 9 horizons from 15m to 1y, so you can tell whether the current move continues or diverges on longer scales.",
};
/* 说明按钮有两个写入方：这里的卡片用法说明，和数据节奏安装器追加的「数据源与更新频率」。
   安装器可能先一步建好按钮（addHelp 遇到已存在的按钮会直接跳过），所以这里每次都强制归位 ——
   说明为正文，频率由安装器追加在其后（它读的基准就是 cadenceBaseTip）。 */
export function setCardHelpTip(selector, zh, en) {
  document.querySelectorAll(selector).forEach((x) => {
    addHelp(x, zh, en);
    const dot = x.querySelector(".help-dot");
    if (!dot) return;
    dot.dataset.tip = uiLang === "zh" ? zh : en;
    dot.dataset.cadenceBaseTip = dot.dataset.tip;
  });
}
export function syncCardHelpTips() {
  setCardHelpTip(".optional h2", RESONANCE_HELP.zh, RESONANCE_HELP.en);
  setCardHelpTip(".change-card h2", PERIOD_RETURNS_HELP.zh, PERIOD_RETURNS_HELP.en);
}

export function addHelp(el, zh, en) {
  if (!el || el.querySelector(".help-dot")) return;
  const tip = document.createElement("button");
  tip.type = "button";
  tip.className = "help-dot";
  tip.setAttribute("aria-label", tx("查看说明", "Show explanation"));
  tip.textContent = "!";
  tip.dataset.tip = tx(zh, en);
  el.append(tip);
}
