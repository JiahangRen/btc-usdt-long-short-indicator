import { tx, uiLang, $, money, coinMetaOf } from '../core.js?v=20260928a';

/* 数据连通性诊断面板：浏览器 → 本站 → 服务商 分段测量往返延时。
   自包含：仅依赖 core 的 i18n/$ 工具与浏览器原生 fetch/performance。
   语言切换通过 window 事件 btc:voice-language-changed 重绘（与多币种/语音同一安全模式）。 */
export function initConnectivity() {
setTimeout(() => {
  const controls = document.querySelector("main>header .controls"),
    version = $("appVersion");
  if (!controls || !version || $("connectivityToggle")) return;
  const wrap = document.createElement("div");
  wrap.className = "connectivity-wrap";
  wrap.innerHTML =
    '<button id="connectivityToggle" class="connectivity-toggle" type="button" aria-expanded="false"></button><section id="connectivityPanel" class="connectivity-panel" hidden><div class="connectivity-head"><div><b id="connectivityTitle"></b><small id="connectivityScope"></small></div><button id="rerunConnectivity" type="button"></button></div><div id="connectivitySummary" class="connectivity-summary"></div><div id="connectivityRows" class="connectivity-rows"></div><p id="connectivityFoot"></p></section>';
  version.after(wrap);
  const toggle = $("connectivityToggle"),
    panel = $("connectivityPanel"),
    rows = $("connectivityRows"),
    summary = $("connectivitySummary");
  let hasRun = false,
    running = false,
    langTimer = 0;
  // 分组标题随语言切换即时重绘，避免「面板上次运行在另一种语言」留下英文标题。
  // Group titles repaint on language change so a panel rendered in the other
  // language never keeps stale headings.
  const groupLabels = [];
  const copy = () => {
    toggle.textContent = tx("连通性测试", "Connectivity");
    $("connectivityTitle").textContent = tx("数据连通性", "Data connectivity");
    $("connectivityScope").textContent = tx(
      "浏览器 → 本站 → 服务商（分段统计）",
      "Browser → site → provider (measured per hop)",
    );
    $("rerunConnectivity").textContent = tx("重新检测", "Test again");
    $("connectivityFoot").textContent = tx(
      "所有数据都经本站中转，所以「服务器 ↔ 你的浏览器」只有一份主数据（取多次往返的中位数）；下面每一行显示的是「服务器 → 该服务商」的真实往返延时，由服务器直连该服务商测得，缓存命中不会掩盖真实耗时。",
      "Everything routes through this server, so there is a single Browser ↔ Server figure (median of the round trips below). Every row then shows the measured server → provider round trip, captured by calling that provider directly so cache hits cannot hide real latency.",
    );
    groupLabels.forEach((item) => (item.el.textContent = item.label()));
  };
  const timedFetch = async (url) => {
    const started = performance.now(),
      controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(url, {
          cache: "no-store",
          signal: controller.signal,
        }),
        data = await response.json();
      if (!response.ok)
        throw new Error(data.detail || data.error || `HTTP ${response.status}`);
      const totalMs = Math.round(performance.now() - started),
        serverMs = Number(data.timing?.serverMs) || 0;
      return {
        data,
        ms: totalMs,
        serverMs,
        siteMs: Math.max(0, totalMs - serverMs),
        upstreamMs: Number(data.timing?.upstreamMs) || 0,
        upstreamCalls: Number(data.timing?.upstreamCalls) || 0,
      };
    } finally {
      clearTimeout(timer);
    }
  };
  const marketCheck = (source, label, contract) => async () => {
    const result = await timedFetch(
        "/api/market?" +
          new URLSearchParams({ source, interval: "15m", limit: "30" }),
      ),
      { data } = result,
      mode =
        data.transport === "websocket"
          ? "WebSocket"
          : data.stale
            ? tx("降级缓存", "stale cache")
            : data.cached
              ? tx("缓存", "cached")
              : "REST";
    const age = Number.isFinite(data.cacheAgeMs)
      ? ` · ${tx("数据年龄", "age")} ${data.cacheAgeMs} ms`
      : "";
    return {
      ...result,
      name: label,
      contract,
      detail: `${contract} · ${money(data.ticker.last)} · ${data.candles.length} ${tx("根K线", "candles")} · ${mode}${age}`,
    };
  };
  const webSocketCheck = async () => {
    const result = await timedFetch("/api/status"),
      { data } = result,
      ws = data.websocket || {};
    if (ws.status !== "connected")
      throw new Error(
        `OKX WebSocket ${ws.status || tx("不可用", "unavailable")}${ws.lastError ? ` · ${ws.lastError}` : ""}`,
      );
    return {
      ...result,
      name: tx("OKX WebSocket（优先）", "OKX WebSocket (preferred)"),
      contract: "wss://ws.okx.com:8443/ws/v5/public",
      detail: `${tx("状态", "Status")} ${ws.status} · ${tx("数据年龄", "age")} ${Number.isFinite(ws.tickerAgeMs) ? `${ws.tickerAgeMs} ms` : "--"} · ${tx("重连", "Reconnects")} ${ws.reconnects ?? 0}`,
    };
  };
  const backendCheck = async () => {
    const result = await timedFetch("/api/status"),
      { data } = result;
    return {
      ...result,
      name: tx("本站后端", "Site backend"),
      contract: "/api/status",
      detail: `${data.sources.length} ${tx("个行情源", "market sources")} · ${data.cacheEntries} ${tx("项缓存", "cache entries")}`,
    };
  };
  const sentimentCheck = async () => {
    const result = await timedFetch("/api/sentiment"),
      { data } = result,
      mode = data.stale
        ? tx("降级缓存", "stale cache")
        : data.cached
          ? tx("缓存", "cached")
          : tx("实时", "live");
    return {
      ...result,
      name: tx("恐惧&贪婪指数", "Fear & Greed Index"),
      contract: "Alternative.me · /api/sentiment",
      detail: `${data.value}/100 · ${data.classification || "--"} · ${mode}`,
    };
  };
  const macroCheck = async () => {
    const result = await timedFetch("/api/fed-calendar"),
      { data } = result,
      events = data.events || [],
      signals = data.marketSignals || [],
      available = signals.filter((signal) => signal.available).length,
      providers = [
        ...new Set(
          [
            ...events.map((event) => event.source),
            ...signals.map((signal) => signal.source),
          ].filter((source) => source && source !== "—"),
        ),
      ];
    return {
      ...result,
      name: tx("宏观日历与市场环境", "Macro calendar & market context"),
      contract: "/api/fed-calendar",
      detail: `${events.length} ${tx("个日历事件", "calendar events")} · ${available}/${signals.length} ${tx("项环境数据", "market signals")} · ${providers.join(" / ") || "--"}`,
    };
  };
  // 数据链路按职责分组：行情与衍生品 / 概率与跨市场 / 宏观与日历 /
  // 情绪与新闻 / AI 与服务。每组可独立折叠，面板随 API 增多也能保持可读。
  // Data paths are grouped by responsibility so the panel stays legible as the
  // number of connected APIs grows. Each group collapses independently.
  const CATS = [
    { id: "market", label: () => tx("行情与衍生品", "Market & derivatives") },
    { id: "signal", label: () => tx("概率与跨市场", "Probability & cross-market") },
    { id: "macro", label: () => tx("宏观与日历", "Macro & calendar") },
    { id: "news", label: () => tx("情绪与新闻", "Sentiment & news") },
    { id: "service", label: () => tx("AI 与服务", "AI & services") },
  ];
  // 服务端探针按归属落进对应分组（对应 server.mjs 的 CONNECTIVITY_PROBES.group）。
  const PROBE_CAT = {
    exchange: "market",
    macro: "macro",
    sentiment: "news",
    service: "service",
  };
  // 宏观日历是「多源聚合」：取它依赖的几个源里最慢的那一个作为该行的真实延时。
  const MACRO_HOSTS = [
    "fred.stlouisfed.org",
    "api.bls.gov",
    "home.treasury.gov",
    "datacenter-web.eastmoney.com",
  ];
  // 没有对应业务行的服务商（备用行情源 / 辅助数据源）也占一行，保证每个服务商
  // 的真实往返都出现在面板里，而不是只剩业务行。
  const PROVIDER_NAME = {
    "api.exchange.coinbase.com": () => tx("Coinbase 备用行情", "Coinbase fallback quotes"),
    "api.gateio.ws": () => tx("Gate.io 备用行情", "Gate.io fallback quotes"),
    "api.deribit.com": () => tx("Deribit 期权数据", "Deribit options data"),
    "api.coingecko.com": () => tx("CoinGecko 行情聚合", "CoinGecko market data"),
    "mempool.space": () => tx("mempool.space 链上数据", "mempool.space on-chain data"),
  };
  const checks = async () => { const base = [
    { cat: "market", name: tx("OKX WebSocket（优先）", "OKX WebSocket (preferred)"), contract: "wss://ws.okx.com:8443/ws/v5/public", host: "www.okx.com", run: webSocketCheck },
    { cat: "market", name: tx("本站后端", "Site backend"), contract: "/api/status", run: backendCheck },
    { cat: "market", name: "OKX", contract: coinMetaOf().okx.swap, host: "www.okx.com", run: marketCheck("okx", "OKX", coinMetaOf().okx.swap) },
    { cat: "market", name: "Binance", contract: coinMetaOf().binance, host: "api.binance.com", run: marketCheck("binance", "Binance", coinMetaOf().binance) },
    { cat: "market", name: tx("衍生品上下文", "Derivatives context"), contract: "/api/market-context · OKX", host: "www.okx.com", run: async () => {
        const result = await timedFetch("/api/market-context?source=okx"),
          { data } = result;
        const fr = data.fundingRate, oi = data.oi;
        return {
          ...result,
          name: tx("衍生品上下文", "Derivatives context"),
          contract: "/api/market-context · OKX",
          detail: `资金费率 ${Number.isFinite(fr) ? (fr * 100).toFixed(4) + "%" : "--"} · OI ${Number.isFinite(oi) ? (oi / 1e8).toFixed(2) + " 亿" : "--"} · ${data.source || "--"}`,
        };
      } },
    { cat: "signal", name: tx("概率历史样本", "Forecast history"), contract: "/api/forecast-history", run: async () => {
        const result = await timedFetch("/api/forecast-history"),
          { data } = result;
        return {
          ...result,
          name: tx("概率历史样本", "Forecast history"),
          contract: "/api/forecast-history",
          detail: `${data.source} · 15m ${data.intraday.length} / 1d ${data.daily.length} · ${data.cached ? tx("缓存", "cached") : tx("实时", "live")}`,
        };
      } },
    { cat: "signal", name: tx("美股联动样本", "US equities history"), contract: "/api/correlation-history", run: async () => {
        const result = await timedFetch("/api/correlation-history"),
          { data } = result;
        return {
          ...result,
          name: tx("美股联动样本", "US equities history"),
          contract: "/api/correlation-history",
          detail: `BTC ${data.btc.length} · SPY ${data.spy.length} · QQQ ${data.qqq.length} · ${data.cached ? tx("缓存", "cached") : tx("实时", "live")}`,
        };
      } },
    { cat: "signal", name: tx("美股实时报价", "US equity quotes"), contract: "Yahoo Finance · /api/us-equity-quotes", host: "query1.finance.yahoo.com", run: async () => {
        const result = await timedFetch("/api/us-equity-quotes"),
          { data } = result;
        const spy = (data.quotes || []).find((q) => q.symbol === "SPY"),
          qqq = (data.quotes || []).find((q) => q.symbol === "QQQ");
        return {
          ...result,
          name: tx("美股实时报价", "US equity quotes"),
          contract: "Yahoo Finance · /api/us-equity-quotes",
          detail: `SPY ${money(spy?.last)} · QQQ ${money(qqq?.last)} · ${data.source || "--"}`,
        };
      } },
    { cat: "macro", name: tx("宏观日历与市场环境", "Macro calendar & market context"), contract: "/api/fed-calendar", hosts: MACRO_HOSTS, run: macroCheck },
    { cat: "macro", name: tx("投资日历", "Investment calendar"), contract: "/api/investment-calendar", run: async () => {
        const result = await timedFetch("/api/investment-calendar"),
          { data } = result;
        const events = data.events || [];
        const sources = [...new Set(events.map((e) => e.source).filter(Boolean))];
        return {
          ...result,
          name: tx("投资日历", "Investment calendar"),
          contract: "/api/investment-calendar",
          detail: `${events.length} ${tx("个事件", "events")} · ${(sources.join(" / ") || "--").slice(0, 48)}`,
        };
      } },
    { cat: "news", name: tx("恐惧&贪婪指数", "Fear & Greed Index"), contract: "Alternative.me · /api/sentiment", host: "api.alternative.me", run: sentimentCheck },
    { cat: "news", name: tx("新闻流", "News feed"), contract: "Google News · /api/news", host: "news.google.com", run: async () => {
        const result = await timedFetch("/api/news"),
          { data } = result;
        const items = data.items || [];
        return {
          ...result,
          name: tx("新闻流", "News feed"),
          contract: "Google News · /api/news",
          detail: `${items.length} ${tx("条", "items")} · ${data.source || "--"}`,
        };
      } },
    { cat: "service", name: tx("AI 助手与密钥", "AI assistant & keys"), contract: "/api/api-center", host: "dashscope.aliyuncs.com", run: async () => {
        const result = await timedFetch("/api/api-center"),
          { data } = result;
        const c = data.credentials || {};
        const on = Object.entries(c).filter(([, v]) => v).map(([k]) => k);
        return {
          ...result,
          name: tx("AI 助手与密钥", "AI assistant & keys"),
          contract: "/api/api-center",
          detail: `${tx("已配置", "configured")}: ${on.length ? on.join(", ") : tx("无", "none")}`,
        };
      } },
    { cat: "service", name: tx("语音播报", "Voice (Azure Speech)"), contract: "Microsoft Azure AI Speech · /api/voice/edge", host: "eastasia.tts.speech.microsoft.com", run: async () => {
        const started = performance.now(),
          controller = new AbortController(),
          timer = setTimeout(() => controller.abort(), 20_000);
        try {
          const response = await fetch("/api/voice/edge", {
              method: "POST",
              cache: "no-store",
              headers: { "content-type": "application/json" },
              // 探针必须是可朗读的文本：纯标点（如「。」）不含任何音素，
              // 上游会返回 0 字节音频，接口就会误报失败。
              // The probe must be pronounceable: punctuation-only text carries no
              // phonemes, the upstream returns 0 bytes, and the check false-alarms.
              body: JSON.stringify({ text: "测试", voice: "zh-CN-XiaoxiaoNeural" }),
              signal: controller.signal,
            }),
            buf = await response.arrayBuffer();
          if (!response.ok || buf.byteLength === 0) throw new Error(`HTTP ${response.status}`);
          const elapsed = Math.round(performance.now() - started),
            engine = response.headers.get("x-voice-engine") || "unknown";
          return {
            ms: elapsed,
            siteMs: elapsed,
            upstreamMs: 0,
            upstreamCalls: 0,
            name: tx("语音播报", "Voice (Azure Speech)"),
            contract: `Microsoft Azure AI Speech · ${engine}`,
            detail: `${tx("合成成功", "synthesized")} · ${(buf.byteLength / 1024).toFixed(1)} KB · ${engine}`,
          };
        } catch (error) {
          throw new Error(error.name === "AbortError" ? tx("请求超时", "Request timed out") : error.message);
        } finally {
          clearTimeout(timer);
        }
      } },
    { cat: "service", name: tx("预警推送", "Price alerts"), contract: "ServerChan · /api/alerts/health", run: async () => {
        const result = await timedFetch("/api/alerts/health"),
          { data } = result;
        return {
          ...result,
          name: tx("预警推送", "Price alerts"),
          contract: "ServerChan · /api/alerts/health",
          detail: data.enabled ? tx("已启用", "enabled") : (data.reason || tx("未启用", "disabled")),
        };
      } },
    ];
    // 「服务器 → 服务商」真实延时：绕开业务缓存，由服务端真打上游端点后回读毫秒数。
    // 阈值与真实网络相称：<1s 快（绿）、1–3s 慢（黄）、≥3s 或连接失败（红）。
    let probes = [];
    try {
      const probe = await timedFetch("/api/connectivity-probe");
      probes = probe?.data?.probes || [];
    } catch { probes = []; }
    // 每个业务行挂上它依赖的服务商探针（多个源时取最慢的那个）。被业务行认领的
    // 服务商不再单列 —— 数字直接显示在业务行上；没被认领的补一行，避免重复计数。
    // Each row adopts the probe of the provider it depends on, taking the slowest
    // source when a row aggregates several. Claimed providers are not listed twice.
    const attach = (check) => {
      const keys = check.hosts || (check.host ? [check.host] : []),
        hits = keys.map((h) => probes.find((p) => p.host === h)).filter(Boolean);
      if (!hits.length) return check;
      const slowest = hits.reduce((a, b) => (Number(b.ms) > Number(a.ms) ? b : a));
      return { ...check, provider: slowest, providerCount: hits.length };
    };
    const claimed = new Set(
      base.flatMap((check) => check.hosts || (check.host ? [check.host] : [])),
    );
    const extra = probes
      .filter((p) => !claimed.has(p.host))
      .map((p) => {
        const nameOf = PROVIDER_NAME[p.host] || (() => p.name);
        return {
          cat: PROBE_CAT[p.group] || "service",
          name: nameOf(),
          contract: p.host,
          provider: p,
          providerCount: 1,
          run: async () => ({
            ms: 0,
            siteMs: 0,
            serverMs: 0,
            upstreamMs: 0,
            upstreamCalls: 0,
            name: nameOf(),
            contract: p.host,
            kind: "provider",
            detail: p.ok
              ? `${p.host} · HTTP ${p.status}`
              : `${tx("连接失败", "connection failed")} · ${p.error || ""}`,
          }),
        };
      });
    return base.map(attach).concat(extra);
  };
  const row = (index, name, contract) => {
    const el = document.createElement("article");
    el.className = "connectivity-row testing";
    el.dataset.check = String(index);
    el.innerHTML =
      '<span class="connectivity-dot"></span><div><b></b><small></small><em></em></div><strong><span></span><small></small></strong>';
    el.querySelector("b").textContent = name;
    el.querySelector("small").textContent = contract;
    el.querySelector("em").textContent = tx("检测中…", "Testing…");
    el.querySelector("strong span").textContent = "-- ms";
    return el;
  };
  const run = async () => {
    if (running) return;
    running = true;
    copy();
    toggle.classList.add("testing");
    const all = await checks(),
      total = all.length;
    summary.className = "connectivity-summary testing";
    summary.textContent = tx(
      `正在并行检测 ${total} 项数据链路（优先 OKX WebSocket）…`,
      `Testing ${total} data paths, prioritizing OKX WebSocket…`,
    );
      rows.replaceChildren();
      groupLabels.length = 0;
      const groupState = {};
      for (const cat of CATS) {
      const section = document.createElement("section");
      section.className = "connectivity-group";
      section.dataset.cat = cat.id;
      const head = document.createElement("button");
      head.type = "button";
      head.className = "connectivity-group-head";
      head.innerHTML =
        '<span class="connectivity-group-title"></span><span class="connectivity-group-badge"></span>';
      head.querySelector(".connectivity-group-title").textContent = cat.label();
      groupLabels.push({ el: head.querySelector(".connectivity-group-title"), label: cat.label });
      const body = document.createElement("div");
      body.className = "connectivity-group-body";
      section.append(head, body);
      rows.append(section);
      groupState[cat.id] = {
        section,
        body,
        badge: head.querySelector(".connectivity-group-badge"),
        passed: 0,
        total: 0,
      };
      head.onclick = (event) => {
        event.stopPropagation();
        section.classList.toggle("collapsed");
      };
    }
    all.forEach((check, index) => {
      const g = groupState[check.cat];
      g.body.append(row(index, check.name, check.contract));
      g.total++;
    });
    const results = await Promise.all(
      all.map(async (check, index) => {
        try {
          return { ok: true, index, ...(await check.run()) };
        } catch (error) {
          return {
            ok: false,
            index,
            error:
              error.name === "AbortError"
                ? tx("请求超时", "Request timed out")
                : error.message,
          };
        }
      }),
    );
    let passed = 0;
    for (const result of results) {
      const check = all[result.index],
        g = groupState[check.cat],
        el = rows.querySelector(`[data-check="${result.index}"]`);
      el.classList.remove("testing");
      if (result.ok) {
        // 右侧只显示「服务器 → 该服务商」的真实往返，不再掺入浏览器那一跳
        // （浏览器 → 本站统一在顶部的主数据里给一次）。优先用服务端直连探针的
        // 实测值，其次是本次响应里真实发生的上游等待，两者都没有说明是本机处理。
        // Every row now shows one figure — server → provider. The browser hop is
        // reported once above instead of being repeated on each row.
        const provider = check.provider,
          upstreamMs = Number(result.upstreamMs) || 0;
        let ms, level, caption, localOnly = false;
        if (provider) {
          ms = Number(provider.ms) || 0;
          level = !provider.ok || ms >= 3_000 ? "bad" : ms >= 1_000 ? "warn" : "good";
          caption =
            tx("服务器 → 服务商", "Server → provider") +
            (Number(check.providerCount) > 1
              ? ` · ${tx("多源取最慢", "slowest source")} ×${check.providerCount}`
              : "") +
            (provider.ok ? "" : ` · ${tx("超时 / 失败", "timeout / failed")}`);
        } else if (upstreamMs > 0) {
          ms = upstreamMs;
          level = ms >= 3_000 ? "bad" : ms >= 1_000 ? "warn" : "good";
          caption = `${tx("服务器 → 服务商", "Server → provider")} · ${tx("真实往返", "real round trip")}`;
        } else {
          // 纯内部处理（本机 SQLite / 已缓存不算网络往返）：不写 0 ms，
          // 否则又会被读成「上游 0 ms」那种假象。
          ms = Number(result.serverMs) || 0;
          level = ms > 2_000 ? "bad" : ms > 800 ? "warn" : "good";
          caption = tx("本机处理 · 无外部请求", "local · no upstream call");
          localOnly = true;
        }
        result.latencyMs = ms;
        result.level = level;
        el.classList.add(level);
        el.querySelector("b").textContent = result.name;
        el.querySelector("small").textContent = result.contract;
        el.querySelector("em").textContent = result.detail;
        el.querySelector("strong span").textContent = localOnly
          ? tx("本机", "local")
          : `${ms.toLocaleString(uiLang === "zh" ? "zh-CN" : "en-US")} ms`;
        el.querySelector("strong small").textContent = caption;
        // 判定为「红」的不计入可用数，否则会出现「汇总全通过」却满屏红灯的自相矛盾。
        if (level !== "bad") {
          passed++;
          g.passed++;
        }
      } else {
        el.classList.add("bad");
        el.querySelector("em").textContent = result.error;
        el.querySelector("strong span").textContent = tx("失败", "Failed");
      }
    }
    for (const cat of CATS) {
      const g = groupState[cat.id],
        cls = g.passed === g.total ? "good" : g.passed ? "warn" : "bad";
      g.badge.textContent = `${g.passed}/${g.total}`;
      g.badge.className = `connectivity-group-badge ${cls}`;
      g.section.classList.toggle("has-error", g.passed < g.total);
    }
    const allOk = passed === total;
    // 两段耗时：①服务器 ↔ 你的浏览器（所有链路共用同一段网络，只显示一个主数据，
    // 取多次往返的中位数）②服务器 → 各服务商（逐行真实往返，这里给分布）。
    const roundTrips = results
      .filter((r) => r.ok && Number(r.siteMs) > 0)
      .map((r) => Number(r.siteMs))
      .sort((a, b) => a - b);
    const rttMs = roundTrips.length
      ? Math.round(roundTrips[Math.floor(roundTrips.length / 2)])
      : null;
    const providerRows = results.filter((r) => all[r.index]?.provider),
      upsFast = providerRows.filter((r) => r.ok && r.level === "good").length,
      upsSlow = providerRows.filter((r) => r.ok && r.level === "warn").length,
      upsFail = providerRows.filter((r) => !r.ok || r.level === "bad").length,
      upsMax = providerRows.reduce(
        (mx, r) => (r.ok && Number(r.latencyMs) > mx ? Number(r.latencyMs) : mx),
        0,
      );
    summary.className = `connectivity-summary ${allOk ? "good" : passed ? "warn" : "bad"}`;
    summary.style.whiteSpace = "";
    summary.replaceChildren();
    const summaryLine = (text, className) => {
      const div = document.createElement("div");
      if (className) div.className = className;
      div.textContent = text;
      summary.append(div);
    };
    summaryLine(
      tx(
        `检测完成：${passed}/${total} 项可用 · ${new Date().toLocaleTimeString("zh-CN")}`,
        `Completed: ${passed}/${total} available · ${new Date().toLocaleTimeString("en-US")}`,
      ),
    );
    summaryLine(
      rttMs !== null
        ? tx(
            `服务器 ↔ 你的浏览器：${rttMs} ms（主数据）`,
            `Server ↔ your browser: ${rttMs} ms (master)`,
          )
        : tx("服务器 ↔ 你的浏览器：未测得", "Server ↔ your browser: not measured"),
      "connectivity-rtt",
    );
    if (providerRows.length)
      summaryLine(
        tx(
          `服务器 → 服务商：${upsFast} 快 / ${upsSlow} 慢 / ${upsFail} 超时或失败${upsMax ? ` · 最慢 ${upsMax.toLocaleString("zh-CN")} ms` : ""}`,
          `Server → providers: ${upsFast} fast / ${upsSlow} slow / ${upsFail} failed${upsMax ? ` · slowest ${upsMax.toLocaleString("en-US")} ms` : ""}`,
        ),
      );
    toggle.classList.remove("testing");
    toggle.classList.toggle("has-error", !allOk);
    toggle.dataset.result = `${passed}/${total}`;
    copy();
    running = false;
    hasRun = true;
  };
  toggle.onclick = (event) => {
    event.stopPropagation();
    const opening = panel.hidden;
    panel.hidden = !opening;
    toggle.setAttribute("aria-expanded", String(opening));
    if (opening && !hasRun) run();
  };
  $("rerunConnectivity").onclick = (event) => {
    event.stopPropagation();
    run();
  };
  panel.onclick = (event) => event.stopPropagation();
  document.addEventListener("click", () => {
    panel.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      panel.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
    }
  });
  copy();
  setTimeout(() => {
    if (!hasRun) run();
  }, 5_000);
  // 语言切换时（btc:voice-language-changed 事件）重绘静态文案；面板打开则顺手重跑探测，
  // 避免「面板上次运行在另一种语言」留下英文标题。
  window.addEventListener("btc:voice-language-changed", () => {
    copy();
    if (hasRun && !panel.hidden) {
      clearTimeout(langTimer);
      langTimer = setTimeout(() => run(), 400);
    }
    hasRun = false;
  });
}, 0);
}
