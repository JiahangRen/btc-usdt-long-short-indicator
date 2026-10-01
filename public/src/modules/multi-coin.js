/* ═══════════════════════════════════════════════════════════════════════════
 * src/modules/multi-coin.js —— 多币种模块 / Multi-coin module
 * ───────────────────────────────────────────────────────────────────────────
 * 职责（v2.12.54 起单币种「比特币」模式已移除，全站恒为多币种）：
 *   1. 顶栏币种下拉（BTC / ETH / ZEC / BNB，位于顶栏最左、多分屏之前）
 *   2. 实时价格上方的「宏观实况」滚动条（常驻显示）
 *   3. 切换后重绘标签、高亮，并逐个重拉与币种相关的所有面板
 *
 * 依赖：
 *   · 币种上下文（tx / isMultiCoinMode / activeCoin / coinMode / selectedCoin /
 *     coinPair / setCoinModeState / setSelectedCoinState / COIN_MODE_KEY /
 *     COIN_SYMBOL_KEY）来自 ../core.js；币种元数据（COIN_KEYS / COINS /
 *     BASE_COIN / normalizeCoin）来自 /shared/coins.mjs。
 *   · 切换后需重拉的面板函数（loadCurrent 等）不在本模块内，由 app.js 在调用
 *     initMultiCoin() 之前注入到 core.registry.loaders，本模块运行时取用，
 *     从而打断「多币种模块 ←→ app.js 面板函数」的循环依赖。
 *
 * 导出：initMultiCoin() —— 在 DOM 与所有面板函数就绪后调用一次。
 * ═══════════════════════════════════════════════════════════════════════════ */

import {
  COIN_MODE_KEY, COIN_SYMBOL_KEY, isMultiCoinMode, activeCoin,
  coinMode, selectedCoin, coinPair, setCoinModeState, setSelectedCoinState, registry,
} from '../core.js?v=20260928a';
import { COIN_KEYS, COINS, BASE_COIN, normalizeCoin } from '/shared/coins.mjs';

/** 初始化币种切换器。幂等：重复调用只重挂一次（DOM 已存在即退出）。 */
export function initMultiCoin() {
  const header = document.querySelector("main>header .controls");
  if (!header) return;

  // ── 0. v2.12.54：单币种（比特币）模式正式移除，恒为多币种 ─────────────────
  // 曾停留在比特币模式的老用户：强制回多币种，并把选中币种归位 BTC ——
  // 比特币模式下 selectedCoin 是冻结的旧值，直接放出来会意外落在别的币上。
  const wasBitcoinMode = !isMultiCoinMode();
  if (wasBitcoinMode) {
    setSelectedCoinState(BASE_COIN);
    localStorage.setItem(COIN_SYMBOL_KEY, BASE_COIN);
  }
  setCoinModeState("multi");
  localStorage.setItem(COIN_MODE_KEY, "multi");

  // ── 1. 顶栏币种下拉（v2.12.54：从市场条右侧上移到顶栏最左）────────────────
  const pick = document.createElement("div");
  pick.className = "csw-coin-pick";
  pick.innerHTML =
    '<button type="button" class="csw-coin-btn" data-csw-toggle aria-haspopup="listbox" aria-expanded="false"></button>' +
    '<div class="csw-coin-menu" data-csw-menu hidden></div>';
  // 顶栏顺序约定（v2.12.54）：币种下拉最左，「⊞ 多分屏」紧随其后。
  // 分屏按钮由 split-mode.js 注入、可能晚于本段执行：先排最左，那边注入后本观察者
  // 会把下拉插到它前面。两个文件互相让位，且都只在「位置不对」时才动 DOM，
  // MutationObserver 因此能收敛、不会来回抖（延续 v2.12.24 的互让约定）。
  const placePickButton = () => {
    const splitBtn = document.getElementById("splitModeBtn");
    const splitInHeader = !!(splitBtn && splitBtn.parentElement === header);
    const ok = splitInHeader
      ? pick.nextElementSibling === splitBtn
      : header.firstElementChild === pick;
    if (ok) return;
    header.insertBefore(pick, splitInHeader ? splitBtn : header.firstElementChild);
  };
  placePickButton();
  if (window.MutationObserver) new MutationObserver(placePickButton).observe(header, { childList: true });

  // ── 2. 宏观实况滚动条（实时价格上方；预警条紧随其下）────────────────────────
  // v2.12.53：4 个币种按钮换成一条「宏观实况」滚动条（滚动展示美元指数 / 股指 /
  // 美债 / 原油 / 人民币 / VIX 等实时数据，与宏观卡同源）。v2.12.54：滚动条右侧的
  // 紧凑下拉上移顶栏，滚动条通栏显示。v2.12.55：显示/隐藏持久化（宏观卡右上角开关
  // 与本条右侧 ✕ 共用同一状态，经 btc:macro-live-visibility 事件互通）、内容可由
  // 宏观卡「⚙ 实况条设置」自定义（btc:macro-live-config 触发重排）、异动指标闪烁。
  const hero = document.querySelector(".hero");
  const switcher = document.createElement("div");
  switcher.id = "coinSwitcher";
  switcher.className = "coin-switcher coin-switcher-ticker";
  switcher.innerHTML =
    '<span class="mt-live mt-live-cyan"><i></i><b class="csw-live-label"></b></span>' +
    '<div class="mt-viewport"><div class="mt-track" data-csw-track></div></div>' +
    '<button type="button" class="mt-gear" data-csw-live-settings title="自定义实况条内容">⚙</button>' +
    '<button type="button" class="mt-close" data-csw-live-close title="收起实况条"></button>';
  if (hero && hero.parentNode) hero.parentNode.insertBefore(switcher, hero);
  else { const main = document.querySelector("main"); if (main) main.append(switcher); }

  const cswTrack = switcher.querySelector("[data-csw-track]");
  const cswToggle = pick.querySelector("[data-csw-toggle]");
  const cswMenu = pick.querySelector("[data-csw-menu]");
  const cswLabel = switcher.querySelector(".csw-live-label");

  /* 实况条可见性 / 内容选择：与 app.js 共用两个 localStorage 键。
     选中集合为空 = 全部显示（未配置过的默认态）；勾选变化经 btc:macro-live-config 通知。 */
  const LIVE_HIDDEN_KEY = "btc_macro_live_hidden";
  const LIVE_SIGNALS_KEY = "btc_macro_live_signals";
  const readLiveHidden = () => {
    try { return localStorage.getItem(LIVE_HIDDEN_KEY) === "1"; } catch { return false; }
  };
  const readLiveSelection = () => {
    try {
      const raw = JSON.parse(localStorage.getItem(LIVE_SIGNALS_KEY) || "[]");
      return Array.isArray(raw) ? raw : [];
    } catch { return []; }
  };
  const applyLiveHidden = () => { switcher.hidden = readLiveHidden(); };
  applyLiveHidden();
  window.addEventListener("btc:macro-live-visibility", (event) => {
    switcher.hidden = !!(event.detail && event.detail.hidden);
  });
  switcher.querySelector("[data-csw-live-close]")?.addEventListener("click", (event) => {
    event.stopPropagation();
    try { localStorage.setItem(LIVE_HIDDEN_KEY, "1"); } catch {}
    switcher.hidden = true;
    window.dispatchEvent(new CustomEvent("btc:macro-live-visibility", { detail: { hidden: true } }));
  });
  window.addEventListener("btc:macro-live-config", () => { if (lastSignals) paintMarquee(lastSignals); });

  // ── v2.12.56：实况条条目可点击 —— 跳到宏观卡「综合指标」并脉冲对应卡片 ──────
  // 点击任何一个指标（含 aria-hidden 的无缝滚动副本）都会把页面平滑滚到
  // #fedMonitorCard 的综合指标区，并给对应卡片加 sig-pulse（放大缩小两拍 +
  // 青色描边），1.8s 后由 JS 摘除类。宏观卡每 60s 整卡重渲，脉冲类被冲掉
  // 属可接受的边缘情况（下一次点击会重新走这套流程）。
  let pulseTimer = 0;
  switcher.addEventListener("click", (event) => {
    const item = event.target.closest && event.target.closest(".mt-item[data-sig-key]");
    if (!item || !switcher.contains(item)) return;
    const key = item.dataset.sigKey;
    const target =
      document.querySelector('#fedMonitorCard .fed-market-signal[data-sig-key="' + key + '"]') ||
      document.getElementById("fedMonitorCard");
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    if (!target.classList) return;
    target.classList.remove("sig-pulse");
    void target.offsetWidth; // 强制回流，保证连点也能重启动画
    target.classList.add("sig-pulse");
    clearTimeout(pulseTimer);
    pulseTimer = setTimeout(() => target.classList.remove("sig-pulse"), 1800);
  });
  // ⚙：跳到宏观卡并展开「实况条设置」浮层（浮层本体与状态在 app.js，经事件驱动）。
  switcher.querySelector("[data-csw-live-settings]")?.addEventListener("click", (event) => {
    event.stopPropagation();
    window.dispatchEvent(new CustomEvent("btc:macro-live-settings-request"));
  });

  /* 滚动条信号名称（服务端返回中文名，这里按界面语言显示）。与 app.js 的
     ENV_SIGNAL_NAMES 保持同一批 key，但本模块不反向依赖 app.js，故本地持有一份。 */
  const TICKER_SIGNAL_NAMES = {
    gold: ["黄金", "Gold"], dxy: ["美元指数", "US Dollar Index"],
    ndx: ["纳指100", "Nasdaq 100"], spx: ["标普500", "S&P 500"],
    us10y: ["美10Y国债", "US 10Y"], wti: ["WTI原油", "WTI"],
    brent: ["布伦特原油", "Brent"], cnh: ["美元/离岸人民币", "USD/CNH"], vix: ["VIX", "VIX"],
  };
  const TICKER_SIGNAL_KEYS = Object.keys(TICKER_SIGNAL_NAMES);
  let marqueeBusy = false;
  let lastSignals = null;   // 最近一轮成功拉取的信号，设置变更时免等下一轮立即重排
  /** 把数值按指标类型格式化（口径与宏观卡 value() 一致：指数两位、DXY 三位、
   *  美债收益率带 %、人民币汇率四位）。 */
  function fmtSignalValue(signal) {
    const num = Number(signal.value);
    if (!Number.isFinite(num)) return "--";
    if (signal.key === "us10y") return num.toFixed(2) + "%";
    if (signal.key === "cnh") return num.toFixed(4);
    if (signal.key === "dxy") return num.toFixed(3);
    return num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function tickerItemHtml(signal, dup) {
    const change = Number(signal.changePct),
      cls = Number.isFinite(change) ? (change >= 0 ? "bull" : "bear") : "flat",
      chg = Number.isFinite(change)
        ? '<em class="mt-chg ' + cls + '">' + (change >= 0 ? "+" : "") + change.toFixed(2) + "%</em>"
        : "";
    // v2.12.55：日内波动 ≥±1% 的指标挂 mt-hot —— 金色闪烁 + 数值高亮，引起注意。
    const hot = Number.isFinite(change) && Math.abs(change) >= 1 ? " mt-hot" : "";
    const name = (TICKER_SIGNAL_NAMES[signal.key] || [signal.name, signal.name])[isEn() ? 1 : 0];
    // v2.12.56：条目挂 data-sig-key —— 点击跳到宏观卡综合指标区并脉冲对应卡片。
    return '<span class="mt-item mt-plain' + hot + '" data-sig-key="' + signal.key + '"' + (dup ? ' aria-hidden="true"' : "") + ">" +
      '<b class="mt-title">' + name + "</b>" +
      '<span class="mt-val">' + fmtSignalValue(signal) + "</span>" + chg + "</span>";
  }
  function paintMarquee(signals) {
    lastSignals = signals || lastSignals;
    const selected = readLiveSelection();
    const items = (lastSignals || []).filter(
      (signal) => TICKER_SIGNAL_KEYS.includes(signal.key) && signal.available &&
        (!selected.length || selected.includes(signal.key)),
    );
    if (!items.length) {
      cswTrack.innerHTML = '<span class="mt-item mt-plain"><b class="mt-title">' +
        (lastSignals && selected.length
          ? (isEn() ? "No indicator selected — enable in the fed card settings" : "未勾选指标 —— 可在宏观卡「实况条设置」中开启")
          : (isEn() ? "Live macro data loading…" : "宏观实时数据加载中…")) +
        "</b></span>";
      return;
    }
    const half = items.map((signal) => tickerItemHtml(signal, false)).join("");
    cswTrack.innerHTML = half + items.map((signal) => tickerItemHtml(signal, true)).join("");
    // 无缝滚动速度：内容越宽跑得越久，固定 ≈45px/s，26s 下限。
    requestAnimationFrame(() => {
      const width = cswTrack.scrollWidth / 2;
      if (width > 0) cswTrack.style.animationDuration = Math.max(26, Math.round(width / 45)) + "s";
    });
  }
  async function refreshMarquee() {
    if (marqueeBusy) return;
    marqueeBusy = true;
    try {
      const response = await fetch("/api/fed-calendar", { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const data = await response.json();
      paintMarquee(data && data.marketSignals);
    } catch { /* 静默：保留上一轮内容，下一轮再试 */ }
    finally { marqueeBusy = false; }
  }
  setInterval(refreshMarquee, 60_000);

  // 币种下拉：展开 / 收起 + 点选切换 + 点击外部收起。
  function paintCoinPick() {
    const current = COINS[activeCoin()] || COINS[BASE_COIN];
    cswToggle.innerHTML = '<span class="csw-coin-mark">' + current.label + "</span>" +
      '<span class="csw-coin-caret">▾</span>';
    cswToggle.title = isEn() ? "Switch coin" : "切换币种";
    cswLabel.textContent = isEn() ? "MACRO LIVE" : "宏观实况";
    const closeBtn = switcher.querySelector("[data-csw-live-close]");
    if (closeBtn) { closeBtn.textContent = "✕"; closeBtn.title = isEn() ? "Hide live ticker" : "收起实况条"; }
    const gearBtn = switcher.querySelector("[data-csw-live-settings]");
    if (gearBtn) gearBtn.title = isEn() ? "Customize ticker contents" : "自定义实况条内容";
    cswMenu.innerHTML = COIN_KEYS.map((key) => {
      const meta = COINS[key], on = key === activeCoin();
      return '<button type="button" class="csw-coin-opt' + (on ? " is-active" : "") +
        '" data-coin="' + key + '" role="option" aria-selected="' + on + '">' +
        '<span class="csw-coin-mark">' + meta.label + "</span>" +
        '<span class="csw-coin-name">' + (isEn() ? meta.name.en : meta.name.zh) + "</span>" +
        (on ? '<span class="csw-coin-check">✓</span>' : "") + "</button>";
    }).join("");
  }
  function closeCoinMenu() {
    cswMenu.hidden = true;
    cswToggle.setAttribute("aria-expanded", "false");
  }
  cswToggle.addEventListener("click", (event) => {
    // 顶栏有全局收起监听，不阻断会让刚展开的下拉立刻关掉。
    event.stopPropagation();
    const open = cswMenu.hidden;
    cswMenu.hidden = !open;
    cswToggle.setAttribute("aria-expanded", String(open));
  });
  cswMenu.addEventListener("click", (event) => {
    const opt = event.target.closest && event.target.closest("[data-coin]");
    if (!opt) return;
    event.stopPropagation();
    closeCoinMenu();
    setActiveCoin(opt.dataset.coin);
  });
  document.addEventListener("click", (event) => {
    if (!pick.contains(event.target)) closeCoinMenu();
  });

  // ── 3. 渲染 ─────────────────────────────────────────────────────────────
  const isEn = () => (localStorage.getItem("btc_lang") || "zh") === "en";
  /** 把页面里写死的「BTC / USDT」之类文案改成当前币种。
   *  选中 BTC 时**原样还原**挂载时抓到的字符串，一个字都不动。 */
  const h1El = document.querySelector("main>header h1");
  const mutedEl = document.querySelector(".hero .muted");
  const ORIGINAL = { title: document.title, h1: h1El && h1El.textContent, muted: mutedEl && mutedEl.textContent };
  function paintCoinLabels() {
    const base = activeCoin() === BASE_COIN;
    if (base) {
      document.title = ORIGINAL.title;
      if (h1El && ORIGINAL.h1 != null) h1El.textContent = ORIGINAL.h1;
      if (mutedEl && ORIGINAL.muted != null) mutedEl.textContent = ORIGINAL.muted;
      return;
    }
    const pair = coinPair(), suffix = isEn() ? "Long/Short Indicator" : "多空指标指示器";
    document.title = pair + " " + suffix;
    // h1 与标题保持一致；₿ 是比特币专属符号，非 BTC 时不展示，避免 ETH/ZEC/BNB 误带 ₿。
    // h1 mirrors the document title; ₿ is Bitcoin-specific and is omitted for non-BTC coins.
    if (h1El) h1El.textContent = document.title;
    if (mutedEl) mutedEl.textContent = pair;
  }
  function paint() { paintCoinPick(); paintCoinLabels(); }

  // ── 4. 切换动作 ─────────────────────────────────────────────────────────
  /** v2.12.54：模式只剩多币种，本函数仅为兼容 btcCoinContext.setMode 旧调用而保留
   *  （voice.js / split-mode.js 的恢复路径会调它）。传 'multi' 直接返回；传别的
   *  也只会被拉回多币种，绝不真正切走。 */
  function setCoinMode(mode) {
    if (mode === "multi" && isMultiCoinMode()) return;
    setCoinModeState("multi");
    localStorage.setItem(COIN_MODE_KEY, "multi");
    paint();
  }
  function setActiveCoin(coin) {
    const key = normalizeCoin(coin);
    if (key === selectedCoin && isMultiCoinMode()) return;
    setSelectedCoinState(key);
    localStorage.setItem(COIN_SYMBOL_KEY, selectedCoin);
    paint();
    refreshCoinPanels();
    notifyCoinChanged();
  }
  function notifyCoinChanged() {
    /* v2.12.6：不再弹「已切换到 XX」提示 —— 切换后标签、chip 高亮与各面板
       都在原地即时刷新，切换结果对用户已经可见，弹窗反而要手动点掉。 */
    window.dispatchEvent(new CustomEvent("btc:coin-changed", { detail: { coin: activeCoin(), mode: coinMode } }));
  }
  /** 切换后逐个重拉与币种相关的面板；任一面板自身失败不该影响其它面板。
   *  面板函数来自 app.js 注入的 registry.loaders（见 app.js 末尾），本模块不
   *  直接依赖 app.js，从而打断循环引用。 */
  function refreshCoinPanels() {
    const L = registry.loaders || {};
    const jobs = [
      () => L.loadCurrent && L.loadCurrent(),
      () => L.loadQuote && L.loadQuote(),
      () => L.loadDerivativeMarketContext && L.loadDerivativeMarketContext(true),
      () => L.loadHorizonForecasts && L.loadHorizonForecasts(),
      () => L.loadResearchOutlook && L.loadResearchOutlook(true),
      () => L.refreshResonance && L.refreshResonance(false),
      () => L.loadFedMonitor && L.loadFedMonitor(),
      () => L.loadInvestmentCalendar && L.loadInvestmentCalendar(true),
      () => L.loadFixedRuleSignal && L.loadFixedRuleSignal(true),
      () => L.renderPosition && L.renderPosition(),
    ];
    for (const job of jobs) { try { Promise.resolve(job()).catch(() => {}); } catch { /* ignore */ } }
  }

  // 语言切换时同步币种名称与标题。
  window.addEventListener("btc:voice-language-changed", () => { paint(); });
  paint();
  refreshMarquee();
  window.btcCoinContext = {
    mode: () => coinMode, coin: activeCoin,
    setMode: setCoinMode, setCoin: setActiveCoin, repaint: paint
  };
}
