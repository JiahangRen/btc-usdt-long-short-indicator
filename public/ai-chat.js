/* BTC 指示器 · AI 行情助手（千问）
 * 自举式悬浮对话窗：右下角按钮 + 抽屉面板，流式显示千问基于实时快照给出的分析。
 * Self-bootstrapping chat dock: a floating button plus a drawer that streams Qwen's analysis.
 *
 * 依赖 / Depends on: /api/ai/chat（SSE 流式）, /api/ai/config
 */
(function () {
  "use strict";

  var LANG = {
    zh: {
      open: "AI 助手",
      title: "AI 行情助手",
      subtitle: "基于实时快照 · 千问",
      placeholder: "问点什么，例如：现在能追多吗？",
      send: "发送",
      sending: "生成中",
      clear: "清空",
      close: "关闭",
      notConfigured: "还没有配置千问 API Key。请打开右上角「API 接入中心」填入 Key 后再回来提问。",
      askAgain: "提问失败，请稍后重试。",
      disclaimer: "AI 输出为数据分析，不构成投资建议。",
      greeting: "你好，我会读这个页面上的实时数据（价格、成交量、多空力量、市场情绪、宏观日程），然后按你选的语气告诉你：现在是什么情况、接下来可能往哪走、要小心什么。\n\n默认是「通俗」模式，大白话讲；想换成更专业的说法，点标题栏上的「通俗」就能切。想问什么直接说，或者点下面的问题试试。",
      quick: ["现在能追多吗？", "未来 24 小时怎么走？", "关键支撑和阻力在哪？", "当前资金费率说明什么？", "多周期是否共振？"],
      quotaIdle: "尚未调用千问，额度为 0",
      quotaReset: "重置",
      quotaIn: "剩余",
      quotaCalls: "调用",
      quotaTokens: "tokens",
      quotaNoRemote: "Token Plan 限额（官方接口未返回实时额度，本地按 tokens 估算）",
      quotaCallDetail: "上次",
      modeFast: "快速",
      modeDeep: "深度",
      modeFastTip: "快速模式：关掉模型思考，几秒出结果（推荐）",
      modeDeepTip: "深度模式：保留推理过程，更审慎但需 1-2 分钟",
      styleMenuTitle: "回答模式",
      styleMenuHint: "同一份数据，三种讲法 · 点一下立即生效",
      stylePlain: "通俗",
      stylePlainTag: "默认",
      stylePlainNote: "完全不用术语，大白话讲清是涨是跌、大概什么时候",
      stylePlainWho: "适合完全不懂技术分析的人",
      styleBalanced: "中等",
      styleBalancedTag: "均衡",
      styleBalancedNote: "术语首次出现配一句白话解释，专业与好懂兼顾",
      styleBalancedWho: "适合懂一点但不深的人",
      stylePro: "专业",
      styleProTag: "进阶",
      styleProNote: "术语与指标数值直接给全，多周期拆开讲",
      styleProWho: "适合熟悉技术分析的人",
      connected: "已连接，正在读数据…",
      thinkingDeep: "深度思考中",
      reasoningNow: "已推理",
      reasoningUnit: "字",
      modelPick: "切换模型",
      modelMenuTitle: "选择模型",
      modelMenuHint: "按性价比排序 · 越靠上消耗的额度越少",
      modelSwitchFailed: "切换模型失败，请稍后重试。",
      modelTierValue: "省",
      modelTierBalanced: "中",
      modelTierFlagship: "贵",
      modelTierOther: "不适用",
      modelRecommended: "推荐",
      modelCurrent: "使用中",
      langName: "中文"
    },
    en: {
      open: "AI",
      title: "AI market assistant",
      subtitle: "Live snapshot · Qwen",
      placeholder: "Ask anything, e.g. is it safe to go long now?",
      send: "Send",
      sending: "Generating",
      clear: "Clear",
      close: "Close",
      notConfigured: "No Qwen API key yet. Open API Center in the top-right corner, save your key, then come back.",
      askAgain: "Request failed. Please try again shortly.",
      disclaimer: "Analysis only, not investment advice.",
      greeting: "Hi, I read the live data on this page (price, volume, buying vs selling pressure, market mood, macro calendar) and explain in the tone you pick what is going on, where it may head next, and what to watch out for.\n\nThe default is Plain — everyday words. Tap the chip in the header to switch to a more technical style. Ask me anything, or tap a question below.",
      quick: ["Is it safe to go long now?", "How will the next 24 hours play out?", "Where are the key support and resistance levels?", "What does the funding rate imply?", "Are the timeframes aligned?"],
      quotaIdle: "No calls yet, quota is empty",
      quotaReset: "Resets",
      quotaIn: "left",
      quotaCalls: "calls",
      quotaTokens: "tokens",
      quotaNoRemote: "Token Plan cap (no live remote quota; local token estimate)",
      quotaCallDetail: "Last",
      modeFast: "Fast",
      modeDeep: "Deep",
      modeFastTip: "Fast mode: reasoning off, answers in seconds (recommended)",
      modeDeepTip: "Deep mode: keeps the reasoning trace, more careful but takes 1-2 min",
      styleMenuTitle: "Answer style",
      styleMenuHint: "Same data, three registers · applies on the next question",
      stylePlain: "Plain",
      stylePlainTag: "Default",
      stylePlainNote: "No jargon at all — plain words for direction and timing",
      stylePlainWho: "For readers with no technical background",
      styleBalanced: "Balanced",
      styleBalancedTag: "Neutral",
      styleBalancedNote: "Jargon explained once, the first time it appears",
      styleBalancedWho: "For readers who know a little",
      stylePro: "Pro",
      styleProTag: "Advanced",
      styleProNote: "Full indicator readings with a per-timeframe breakdown",
      styleProWho: "For readers fluent in technical analysis",
      connected: "Connected, reading data…",
      thinkingDeep: "Thinking deeply",
      reasoningNow: "reasoned",
      reasoningUnit: "chars",
      modelPick: "Switch model",
      modelMenuTitle: "Choose a model",
      modelMenuHint: "Sorted by value · higher entries burn fewer credits",
      modelSwitchFailed: "Could not switch the model. Please try again.",
      modelTierValue: "Value",
      modelTierBalanced: "Balanced",
      modelTierFlagship: "Premium",
      modelTierOther: "N/A",
      modelRecommended: "Recommended",
      modelCurrent: "In use",
      langName: "English"
    }
  };

  var STYLE_ID = "btc-ai-chat-style";
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      ".btc-ai-launch{position:fixed;right:22px;bottom:22px;z-index:1200;display:inline-flex;align-items:center;gap:8px;padding:11px 16px;border-radius:999px;border:1px solid var(--border-strong,#3a434f);background:var(--bg-elevated,#232a33);color:var(--text-primary,#e8eaed);font:500 13px/1 system-ui,-apple-system,'Segoe UI',sans-serif;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.35)}",
      ".btc-ai-launch:hover{border-color:var(--accent-purple,#a78bfa)}",
      ".btc-ai-dot{width:8px;height:8px;border-radius:50%;background:var(--accent-purple,#a78bfa)}",
      ".btc-ai-panel{position:fixed;right:22px;bottom:74px;z-index:1201;width:min(430px,calc(100vw - 32px));height:min(620px,calc(100vh - 110px));display:flex;flex-direction:column;border-radius:14px;border:1px solid var(--border-strong,#3a434f);background:var(--bg-surface,#161a20);color:var(--text-primary,#e8eaed);box-shadow:0 20px 60px rgba(0,0,0,.45);overflow:hidden}",
      ".btc-ai-panel[hidden]{display:none}",
      ".btc-ai-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--border-subtle,#2a313b);background:var(--bg-surface-2,#1c2129)}",
      ".btc-ai-head>div:first-child{min-width:0;overflow:hidden}",
      ".btc-ai-head h3{margin:0;font:500 14px/1.2 system-ui,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".btc-ai-head p{margin:2px 0 0;font:400 11px/1.2 system-ui,sans-serif;color:var(--text-secondary,#9aa4b2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".btc-ai-head .btc-ai-spacer{flex:1}",
      ".btc-ai-iconbtn{border:1px solid transparent;background:transparent;color:var(--text-secondary,#9aa4b2);border-radius:8px;padding:5px 9px;font:400 12px/1 system-ui,sans-serif;cursor:pointer}",
      ".btc-ai-iconbtn:hover{border-color:var(--border-strong,#3a434f);color:var(--text-primary,#e8eaed)}",
      ".btc-ai-model{font:400 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--accent-purple,#a78bfa);border:1px solid var(--border-subtle,#2a313b);border-radius:999px;padding:4px 8px;background:transparent;cursor:pointer;white-space:nowrap;max-width:96px;overflow:hidden;text-overflow:ellipsis}",
      ".btc-ai-model:hover{border-color:var(--accent-purple,#a78bfa);color:var(--text-primary,#e8eaed)}",
      ".btc-ai-model[data-open='true']{border-color:var(--accent-purple,#a78bfa);background:rgba(167,139,250,.14)}",
      ".btc-ai-model:disabled{cursor:default;opacity:.55}",
      ".btc-ai-models{position:absolute;top:54px;right:10px;z-index:6;width:min(340px,calc(100% - 20px));max-height:64%;overflow-y:auto;padding:8px;border-radius:12px;border:1px solid var(--border-strong,#3a434f);background:var(--bg-elevated,#232a33);box-shadow:0 16px 40px rgba(0,0,0,.5);scrollbar-width:thin}",
      ".btc-ai-models[hidden]{display:none}",
      ".btc-ai-models h4{margin:2px 4px 4px;font:500 12px/1.3 system-ui,sans-serif;color:var(--text-primary,#e8eaed)}",
      ".btc-ai-models-hint{margin:0 4px 8px;font:400 10px/1.45 system-ui,sans-serif;color:var(--text-muted,#5b6573)}",
      ".btc-ai-model-row{display:block;width:100%;text-align:left;padding:8px 9px;border:0;border-radius:9px;background:transparent;color:inherit;font:inherit;cursor:pointer}",
      ".btc-ai-model-row:hover{background:rgba(167,139,250,.1)}",
      ".btc-ai-model-row[aria-current='true']{background:rgba(167,139,250,.16)}",
      ".btc-ai-model-row[disabled]{cursor:not-allowed;opacity:.45}",
      ".btc-ai-model-top{display:flex;align-items:center;gap:6px}",
      ".btc-ai-model-id{font:500 12px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--text-primary,#e8eaed)}",
      ".btc-ai-model-tier{font:500 10px/1 system-ui,sans-serif;border-radius:999px;padding:2px 6px;border:1px solid var(--border-subtle,#2a313b);color:var(--text-secondary,#9aa4b2)}",
      ".btc-ai-model-tier[data-tier='value']{color:var(--accent-cyan,#22d3ee);border-color:var(--accent-cyan,#22d3ee)}",
      ".btc-ai-model-tier[data-tier='flagship']{color:var(--warn,#f59e0b);border-color:var(--warn,#f59e0b)}",
      ".btc-ai-model-badge{margin-left:auto;font:500 10px/1 system-ui,sans-serif;color:var(--accent-purple,#a78bfa)}",
      ".btc-ai-model-note{display:block;margin-top:3px;font:400 11px/1.45 system-ui,sans-serif;color:var(--text-muted,#5b6573)}",
      ".btc-ai-mode{font:400 11px/1 system-ui,sans-serif;color:var(--text-secondary,#9aa4b2);border:1px solid var(--border-subtle,#2a313b);border-radius:999px;padding:4px 10px;background:transparent;cursor:pointer;white-space:nowrap}",
      ".btc-ai-mode:hover{border-color:var(--accent-purple,#a78bfa);color:var(--text-primary,#e8eaed)}",
      ".btc-ai-mode[data-mode='deep']{border-color:var(--accent-purple,#a78bfa);color:var(--accent-purple,#a78bfa)}",
      ".btc-ai-style{font:400 11px/1 system-ui,sans-serif;color:var(--text-secondary,#9aa4b2);border:1px solid var(--border-subtle,#2a313b);border-radius:999px;padding:4px 10px;background:transparent;cursor:pointer;white-space:nowrap}",
      ".btc-ai-style:hover{border-color:var(--accent-cyan,#22d3ee);color:var(--text-primary,#e8eaed)}",
      ".btc-ai-style[data-style='balanced']{color:var(--accent-cyan,#22d3ee);border-color:var(--accent-cyan,#22d3ee)}",
      ".btc-ai-style[data-style='pro']{color:var(--warn,#f59e0b);border-color:var(--warn,#f59e0b)}",
      ".btc-ai-style[data-open='true']{background:rgba(34,211,238,.12)}",
      ".btc-ai-style-tag{font:500 10px/1 system-ui,sans-serif;border-radius:999px;padding:2px 6px;border:1px solid var(--border-subtle,#2a313b);color:var(--text-secondary,#9aa4b2)}",
      ".btc-ai-style-tag[data-tag='plain']{color:var(--accent-cyan,#22d3ee);border-color:var(--accent-cyan,#22d3ee)}",
      ".btc-ai-style-tag[data-tag='balanced']{color:var(--accent-purple,#a78bfa);border-color:var(--accent-purple,#a78bfa)}",
      ".btc-ai-style-tag[data-tag='pro']{color:var(--warn,#f59e0b);border-color:var(--warn,#f59e0b)}",
      ".btc-ai-status{color:var(--text-muted,#5b6573);font-style:italic}",
      ".btc-ai-log{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:12px;scrollbar-width:thin}",
      ".btc-ai-msg{max-width:88%;padding:10px 12px;border-radius:12px;font:400 13px/1.65 system-ui,sans-serif;white-space:pre-wrap;word-break:break-word}",
      ".btc-ai-msg.user{align-self:flex-end;background:var(--accent-purple,#a78bfa);color:#14121f}",
      ".btc-ai-msg.bot{align-self:flex-start;background:var(--bg-elevated,#232a33);border:1px solid var(--border-subtle,#2a313b)}",
      ".btc-ai-msg.error{align-self:flex-start;background:transparent;border:1px solid var(--bear,#ff4d6a);color:var(--bear,#ff4d6a)}",
      ".btc-ai-tag{display:inline-block;font-weight:500;color:var(--accent-cyan,#22d3ee)}",
      ".btc-ai-caret{display:inline-block;width:6px;height:14px;background:var(--accent-purple,#a78bfa);vertical-align:-2px;animation:btc-ai-blink 1s steps(2,start) infinite}",
      "@keyframes btc-ai-blink{to{visibility:hidden}}",
      ".btc-ai-quick{display:flex;gap:6px;flex-wrap:wrap;padding:0 14px 10px}",
      ".btc-ai-chip{border:1px solid var(--border-subtle,#2a313b);background:transparent;color:var(--text-secondary,#9aa4b2);border-radius:999px;padding:6px 10px;font:400 12px/1 system-ui,sans-serif;cursor:pointer}",
      ".btc-ai-chip:hover{border-color:var(--accent-purple,#a78bfa);color:var(--text-primary,#e8eaed)}",
      ".btc-ai-foot{border-top:1px solid var(--border-subtle,#2a313b);padding:10px 12px;background:var(--bg-surface-2,#1c2129)}",
      ".btc-ai-row{display:flex;gap:8px;align-items:flex-end}",
      ".btc-ai-input{flex:1;resize:none;min-height:38px;max-height:120px;border-radius:10px;border:1px solid var(--border-subtle,#2a313b);background:var(--bg-base,#0e1014);color:var(--text-primary,#e8eaed);padding:9px 10px;font:400 13px/1.5 system-ui,sans-serif}",
      ".btc-ai-input:focus{outline:none;border-color:var(--accent-purple,#a78bfa)}",
      ".btc-ai-send{border:1px solid var(--accent-purple,#a78bfa);background:var(--accent-purple,#a78bfa);color:#14121f;border-radius:10px;padding:10px 14px;font:500 13px/1 system-ui,sans-serif;cursor:pointer}",
      ".btc-ai-send[disabled]{opacity:.5;cursor:not-allowed}",
      ".btc-ai-quota{padding:10px 14px;border-bottom:1px solid var(--border-subtle,#2a313b);background:var(--bg-surface,#161a20)}",
      ".btc-ai-quota-row{display:flex;align-items:center;gap:8px;font:400 11px/1.2 system-ui,sans-serif;color:var(--text-secondary,#9aa4b2)}",
      ".btc-ai-quota-bar{flex:1;height:6px;border-radius:3px;background:var(--border-subtle,#2a313b);overflow:hidden;position:relative}",
      ".btc-ai-quota-fill{position:absolute;inset:0;width:100%;background:var(--accent-purple,#a78bfa);transition:width .4s ease,background-color .3s ease}",
      ".btc-ai-quota-fill[data-level='mid']{background:var(--accent-amber,#f59e0b)}",
      ".btc-ai-quota-fill[data-level='low']{background:var(--bear,#ff4d6a)}",
      ".btc-ai-quota-pct{font-variant-numeric:tabular-nums;color:var(--text-primary,#e8eaed)}",
      ".btc-ai-quota-meta{font:400 10px/1.3 system-ui,sans-serif;color:var(--text-muted,#5b6573);margin-top:6px;display:flex;gap:10px;flex-wrap:wrap}",
      ".btc-ai-quota-meta b{color:var(--text-secondary,#9aa4b2);font-weight:400}",
      ".btc-ai-quota-detail{display:none;margin-top:8px;border-top:1px dashed var(--border-subtle,#2a313b);padding-top:6px;font:400 10px/1.4 system-ui,sans-serif;color:var(--text-muted,#5b6573);max-height:90px;overflow-y:auto}",
      ".btc-ai-quota[data-open='true'] .btc-ai-quota-detail{display:block}",
      ".btc-ai-quota-detail-row{display:flex;justify-content:space-between;padding:2px 0}",
      ".btc-ai-quota-detail-row b{color:var(--text-secondary,#9aa4b2);font-weight:500}",
      ".btc-ai-note{margin:8px 2px 0;font:400 11px/1.4 system-ui,sans-serif;color:var(--text-muted,#5b6573);text-align:center}"
    ].join("\n");
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
  }

  function currentLang() {
    var attr = (document.documentElement.getAttribute("lang") || "").toLowerCase();
    return attr.indexOf("en") === 0 ? "en" : "zh";
  }
  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }
  // 极简渲染：保留换行，并把【结论】这类小标题高亮成青色标签。
  // Minimal renderer: keep line breaks and highlight the 【…】 section labels.
  function renderRich(text) {
    return escapeHtml(text)
      .replace(/^【(.+?)】/gm, '<span class="btc-ai-tag">【$1】</span>')
      .replace(/\n/g, "<br>");
  }

  // 回答模式（语气档位）：与「快速/深度」正交 —— 那个决定模型想多久，这个决定说给谁听。
  // Answer styles (register): orthogonal to fast/deep — that one controls thinking, this one tone.
  var STYLE_IDS = ["plain", "balanced", "pro"];
  function styleText(t, id) {
    if (id === "pro") return { label: t.stylePro, tag: t.styleProTag, note: t.styleProNote, who: t.styleProWho };
    if (id === "balanced") return { label: t.styleBalanced, tag: t.styleBalancedTag, note: t.styleBalancedNote, who: t.styleBalancedWho };
    return { label: t.stylePlain, tag: t.stylePlainTag, note: t.stylePlainNote, who: t.stylePlainWho };
  }
  // 头部空间有限，模型名去掉 qwen 前缀显示（浮层里仍给全名）。
  // The header is tight, so drop the "qwen" prefix here (the menu still shows the full id).
  function shortModel(id) {
    var name = String(id || "");
    return name.replace(/^qwen[-\s]*/i, "") || name;
  }

  function boot() {
    injectStyle();
    var t = LANG[currentLang()];
    var history = [];
    var busy = false;
    var configured = false;
    var model = "";
    // 可选模型清单由 /api/ai/config 下发（含性价比档位与是否可用于问答）。
    // The selectable model list arrives from /api/ai/config with tier + usable flags.
    var modelList = [];

    var launch = document.createElement("button");
    launch.type = "button";
    launch.className = "btc-ai-launch";
    launch.innerHTML = '<span class="btc-ai-dot"></span><span>' + t.open + "</span>";

    var panel = document.createElement("section");
    panel.className = "btc-ai-panel";
    panel.hidden = true;
    panel.setAttribute("aria-label", t.title);
    panel.innerHTML =
      '<header class="btc-ai-head">' +
      "<div><h3></h3><p></p></div>" +
      '<span class="btc-ai-spacer"></span>' +
      '<button type="button" class="btc-ai-style"></button>' +
      '<button type="button" class="btc-ai-mode" data-mode="fast"></button>' +
      '<button type="button" class="btc-ai-model"></button>' +
      '<button type="button" class="btc-ai-iconbtn" data-act="clear"></button>' +
      '<button type="button" class="btc-ai-iconbtn" data-act="close"></button>' +
      "</header>" +
      // 模型选择浮层：点头部模型徽标展开，按性价比排序。
      // Model picker overlay: opened from the model chip in the header, sorted by value.
      '<div class="btc-ai-models btc-ai-model-menu" hidden></div>' +
      // 语气浮层：与模型浮层同款版式，三档回答模式。
      // Answer-style overlay: same layout as the model menu, three registers.
      '<div class="btc-ai-models btc-ai-styles" hidden></div>' +
      // 额度面板：进度条 + 倒计时 + 累计统计 + 近 10 次历史
      // Quota panel: bar + countdown + cumulative stats + last 10 calls
      '<section class="btc-ai-quota" data-open="false">' +
        '<div class="btc-ai-quota-row">' +
          '<div class="btc-ai-quota-bar"><div class="btc-ai-quota-fill"></div></div>' +
          '<span class="btc-ai-quota-pct">—</span>' +
        '</div>' +
        '<div class="btc-ai-quota-meta"></div>' +
        '<div class="btc-ai-quota-detail"></div>' +
      "</section>" +
      '<div class="btc-ai-log"></div>' +
      '<div class="btc-ai-quick"></div>' +
      '<div class="btc-ai-foot"><div class="btc-ai-row">' +
      '<textarea class="btc-ai-input" rows="1"></textarea>' +
      '<button type="button" class="btc-ai-send"></button>' +
      "</div><p class='btc-ai-note'></p></div>";

    document.body.append(launch, panel);

    var log = panel.querySelector(".btc-ai-log");
    var quick = panel.querySelector(".btc-ai-quick");
    var input = panel.querySelector(".btc-ai-input");
    var sendBtn = panel.querySelector(".btc-ai-send");
    var modelTag = panel.querySelector(".btc-ai-model");
    var titleEl = panel.querySelector(".btc-ai-head h3");
    var subEl = panel.querySelector(".btc-ai-head p");
    var clearBtn = panel.querySelector('[data-act="clear"]');
    var closeBtn = panel.querySelector('[data-act="close"]');
    var noteEl = panel.querySelector(".btc-ai-note");
    var quotaEl = panel.querySelector(".btc-ai-quota");
    var quotaFill = panel.querySelector(".btc-ai-quota-fill");
    var quotaPct = panel.querySelector(".btc-ai-quota-pct");
    var quotaMeta = panel.querySelector(".btc-ai-quota-meta");
    var quotaDetail = panel.querySelector(".btc-ai-quota-detail");
    var modeBtn = panel.querySelector(".btc-ai-mode");
    var modelMenu = panel.querySelector(".btc-ai-model-menu");
    var styleBtn = panel.querySelector(".btc-ai-style");
    var styleMenu = panel.querySelector(".btc-ai-styles");
    // 思考模式：默认快速（关掉推理，秒级出结果），存 localStorage 记住选择。
    // Thinking mode: fast by default (no reasoning, answers in seconds), persisted in localStorage.
    var thinking = "fast";
    try { thinking = localStorage.getItem("btc_ai_thinking") === "deep" ? "deep" : "fast"; } catch (e) { /* 隐私模式下 localStorage 不可用 / localStorage can throw in private mode */ }
    // 回答模式：默认「通俗」，同样记住在本地。切换对下一条提问立即生效。
    // Answer style: plain by default, also remembered locally; applies from the next question on.
    var answerStyle = "plain";
    try {
      var savedStyle = localStorage.getItem("btc_ai_style");
      if (savedStyle && STYLE_IDS.indexOf(savedStyle) >= 0) answerStyle = savedStyle;
    } catch (e) { /* 忽略存储失败 / ignore storage failures */ }

    function applyLabels() {
      t = LANG[currentLang()];
      launch.lastElementChild.textContent = t.open;
      titleEl.textContent = t.title;
      subEl.textContent = t.subtitle;
      input.placeholder = t.placeholder;
      sendBtn.textContent = busy ? t.sending : t.send;
      clearBtn.textContent = t.clear;
      closeBtn.textContent = t.close;
      noteEl.textContent = t.disclaimer;
      if (modelTag) modelTag.title = configured ? t.modelPick : t.notConfigured;
      if (modelMenu && !modelMenu.hidden) renderModelMenu();
      if (styleMenu && !styleMenu.hidden) renderStyleMenu();
      applyModeLabel();
      applyStyleLabel();
      quick.innerHTML = "";
      t.quick.forEach(function (text) {
        var chip = document.createElement("button");
        chip.type = "button";
        chip.className = "btc-ai-chip";
        chip.textContent = text;
        chip.onclick = function () { ask(text); };
        quick.appendChild(chip);
      });
    }

    // 模式按钮：显示当前档位，点一下切换，鼠标悬停给出解释。
    // Mode button: shows the current gear, toggles on click, explains itself on hover.
    function applyModeLabel() {
      if (!modeBtn) return;
      var deep = thinking === "deep";
      modeBtn.textContent = deep ? t.modeDeep : t.modeFast;
      modeBtn.setAttribute("data-mode", thinking);
      modeBtn.title = deep ? t.modeDeepTip : t.modeFastTip;
    }

    // ---------- 模型切换 / Model switching ----------
    // 档位标签：省 / 中 / 贵，让用户一眼看出额度消耗量级。
    // Tier badge so the credit burn is obvious at a glance.
    function tierLabel(tier) {
      if (tier === "value") return t.modelTierValue;
      if (tier === "flagship") return t.modelTierFlagship;
      if (tier === "other") return t.modelTierOther;
      return t.modelTierBalanced;
    }
    function renderModelMenu() {
      if (!modelMenu) return;
      modelMenu.innerHTML = "";
      var head = document.createElement("h4");
      head.textContent = t.modelMenuTitle;
      var hint = document.createElement("p");
      hint.className = "btc-ai-models-hint";
      hint.textContent = t.modelMenuHint;
      modelMenu.append(head, hint);
      if (!configured) {
        var needKey = document.createElement("p");
        needKey.className = "btc-ai-models-hint";
        needKey.textContent = t.notConfigured;
        modelMenu.appendChild(needKey);
        return;
      }
      if (!modelList.length) {
        var empty = document.createElement("p");
        empty.className = "btc-ai-models-hint";
        empty.textContent = "—";
        modelMenu.appendChild(empty);
        return;
      }
      modelList.forEach(function (entry) {
        var usable = entry.usable !== false;
        var row = document.createElement("button");
        row.type = "button";
        row.className = "btc-ai-model-row";
        if (!usable) row.disabled = true;
        if (usable && entry.id === model) row.setAttribute("aria-current", "true");

        var top = document.createElement("span");
        top.className = "btc-ai-model-top";
        var idEl = document.createElement("span");
        idEl.className = "btc-ai-model-id";
        idEl.textContent = entry.label || entry.id;
        var tierEl = document.createElement("span");
        tierEl.className = "btc-ai-model-tier";
        tierEl.setAttribute("data-tier", entry.tier || "balanced");
        tierEl.textContent = tierLabel(entry.tier);
        top.append(idEl, tierEl);
        // 优先级：当前使用中 > 推荐标记，避免两个徽标同时出现。
        // Current model wins over the "recommended" badge so only one chip shows.
        if (usable && entry.id === model) {
          var nowBadge = document.createElement("span");
          nowBadge.className = "btc-ai-model-badge";
          nowBadge.textContent = t.modelCurrent;
          top.appendChild(nowBadge);
        } else if (entry.recommended) {
          var recBadge = document.createElement("span");
          recBadge.className = "btc-ai-model-badge";
          recBadge.textContent = t.modelRecommended;
          top.appendChild(recBadge);
        }
        row.appendChild(top);

        var noteLine = document.createElement("span");
        noteLine.className = "btc-ai-model-note";
        noteLine.textContent = entry.note || "";
        row.appendChild(noteLine);

        if (usable) row.onclick = function () { switchModel(entry.id); };
        modelMenu.appendChild(row);
      });
    }
    function toggleModelMenu(force) {
      if (!modelMenu || !modelTag) return;
      var open = typeof force === "boolean" ? force : modelMenu.hidden;
      if (open && !configured) {
        addMessage("error", t.notConfigured);
        return;
      }
      // 与语气浮层互斥。/ Mutually exclusive with the style overlay.
      if (open) toggleStyleMenu(false);
      modelMenu.hidden = !open;
      modelTag.setAttribute("data-open", open ? "true" : "false");
      if (open) renderModelMenu();
    }
    async function switchModel(id) {
      if (!id) return;
      toggleModelMenu(false);
      if (id === model) return;
      modelTag.disabled = true;
      try {
        var response = await fetch("/api/ai/model", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: id })
        });
        var data = await response.json().catch(function () { return {}; });
        if (!response.ok) throw new Error(data.error || t.modelSwitchFailed);
        model = data.model || id;
        modelTag.textContent = shortModel(model);
        var picked = modelList.filter(function (m) { return m.id === model; })[0];
        modelTag.title = t.modelPick + (picked && picked.note ? "：" + picked.note : "");
      } catch (error) {
        addMessage("error", error.message || t.modelSwitchFailed);
      } finally {
        modelTag.disabled = !configured;
      }
    }

    // ---------- 回答模式（语气档位）/ Answer styles ----------
    // 徽标显示当前档位（通俗 / 中等 / 专业），点开是三选一浮层。
    // The chip shows the active register; clicking opens a three-way picker.
    function applyStyleLabel() {
      if (!styleBtn) return;
      var info = styleText(t, answerStyle);
      styleBtn.textContent = info.label;
      styleBtn.title = t.styleMenuTitle + "：" + info.note;
      styleBtn.setAttribute("data-style", answerStyle);
    }
    function renderStyleMenu() {
      if (!styleMenu) return;
      styleMenu.innerHTML = "";
      var head = document.createElement("h4");
      head.textContent = t.styleMenuTitle;
      var hint = document.createElement("p");
      hint.className = "btc-ai-models-hint";
      hint.textContent = t.styleMenuHint;
      styleMenu.append(head, hint);
      STYLE_IDS.forEach(function (id) {
        var info = styleText(t, id);
        var row = document.createElement("button");
        row.type = "button";
        row.className = "btc-ai-model-row";
        if (id === answerStyle) row.setAttribute("aria-current", "true");

        var top = document.createElement("span");
        top.className = "btc-ai-model-top";
        var nameEl = document.createElement("span");
        nameEl.className = "btc-ai-model-id";
        nameEl.textContent = info.label;
        var tagEl = document.createElement("span");
        tagEl.className = "btc-ai-style-tag";
        tagEl.setAttribute("data-tag", id);
        tagEl.textContent = info.tag;
        top.append(nameEl, tagEl);
        if (id === answerStyle) {
          var nowBadge = document.createElement("span");
          nowBadge.className = "btc-ai-model-badge";
          nowBadge.textContent = t.modelCurrent;
          top.appendChild(nowBadge);
        }
        row.appendChild(top);

        var noteLine = document.createElement("span");
        noteLine.className = "btc-ai-model-note";
        noteLine.textContent = info.note + " · " + info.who;
        row.appendChild(noteLine);

        row.onclick = function () { pickStyle(id); };
        styleMenu.appendChild(row);
      });
    }
    function toggleStyleMenu(force) {
      if (!styleMenu || !styleBtn) return;
      var open = typeof force === "boolean" ? force : styleMenu.hidden;
      // 两个浮层互斥，避免叠在一起。
      // The two overlays are mutually exclusive so they never stack.
      if (open) toggleModelMenu(false);
      styleMenu.hidden = !open;
      styleBtn.setAttribute("data-open", open ? "true" : "false");
      if (open) renderStyleMenu();
    }
    function pickStyle(id) {
      toggleStyleMenu(false);
      if (STYLE_IDS.indexOf(id) < 0 || id === answerStyle) return;
      answerStyle = id;
      try { localStorage.setItem("btc_ai_style", answerStyle); } catch (e) { /* 忽略存储失败 / ignore storage failures */ }
      applyStyleLabel();
      input.focus();
    }

    function addMessage(role, text) {
      var node = document.createElement("div");
      node.className = "btc-ai-msg " + role;
      node.innerHTML = renderRich(text);
      log.appendChild(node);
      log.scrollTop = log.scrollHeight;
      return node;
    }

    function setBusy(state) {
      busy = state;
      sendBtn.disabled = state;
      sendBtn.textContent = state ? t.sending : t.send;
      input.disabled = state;
    }

    async function loadConfig() {
      try {
        var response = await fetch("/api/ai/config");
        if (!response.ok) return;
        var payload = await response.json();
        configured = Boolean(payload.configured);
        model = payload.model || payload.defaultModel || "";
        modelList = Array.isArray(payload.models) ? payload.models : [];
        modelTag.textContent = configured ? shortModel(model) : "";
        modelTag.disabled = !configured;
        var current = modelList.filter(function (m) { return m.id === model; })[0];
        modelTag.title = configured ? t.modelPick + (current && current.note ? "：" + current.note : "") : t.notConfigured;
        if (modelMenu && !modelMenu.hidden) renderModelMenu();
        // 服务端下发档位清单时做一次校验，避免前端与服务端 id 漂移。
        // Validate the stored register against the server list so the ids cannot drift apart.
        if (Array.isArray(payload.answerStyles) && payload.answerStyles.length) {
          var styleIds = payload.answerStyles.map(function (entry) { return entry.id; });
          if (styleIds.indexOf(answerStyle) < 0) {
            answerStyle = styleIds.indexOf(payload.defaultStyle) >= 0 ? payload.defaultStyle : styleIds[0];
            applyStyleLabel();
          }
        }
      } catch (error) { /* 配置拉取失败不阻塞使用 / a failed probe must not block the UI */ }
    }

    // 把毫秒格式化成「6d 23h 12m」紧凑倒计时，<= 1h 时换成「XX 分钟」更醒目。
    // Format a countdown as "6d 23h 12m", or "XX min" when under one hour.
    function formatCountdown(ms) {
      if (ms == null || ms <= 0) return null;
      var totalMin = Math.floor(ms / 60000);
      var d = Math.floor(totalMin / 1440);
      var h = Math.floor((totalMin % 1440) / 60);
      var m = totalMin % 60;
      if (d > 0) return d + "d " + h + "h";
      if (h > 0) return h + "h " + m + "m";
      return Math.max(1, m) + "m";
    }
    function formatTimestamp(iso) {
      if (!iso) return null;
      var d = new Date(iso);
      if (Number.isNaN(d.getTime())) return null;
      var pad = function (n) { return String(n).padStart(2, "0"); };
      return pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
    }
    function formatNumber(value) {
      if (value == null) return "—";
      var n = Number(value);
      if (!Number.isFinite(n)) return "—";
      if (Math.abs(n) >= 10000) return (n / 1000).toFixed(1) + "k";
      return Math.round(n).toLocaleString();
    }
    // 把配额对象渲染成面板上的可视行：进度条 + 文案 + 折叠历史。
    // Render the quota payload onto the panel: bar + meta + collapsible history.
    function renderQuota(state) {
      if (!state) { quotaFill.style.width = "0%"; quotaPct.textContent = "—"; quotaMeta.textContent = ""; quotaDetail.innerHTML = ""; return; }
      var remote = state.remote;
      var local = state.local || {};
      var hasRemote = remote && (remote.limit != null) && (remote.remaining != null);
      var pctRemaining = hasRemote ? remote.percentRemaining : null;
      var pctUsed = hasRemote ? 100 - pctRemaining : null;
      // 优先用 remote 限额算进度；否则基于本地估算（按模型换算表 × 套餐 2500 credits 兜底）
      // Prefer the remote limit when known; otherwise fall back to the local credits estimate.
      var estimateLimit = 2500;  // Token Plan Lite 套餐默认值；用户可到控制台查看实际值
      var estCredits = local.estimatedCredits || 0;
      var estPercentRemaining = estCredits > 0 ? Math.max(0, Math.min(100, (1 - estCredits / estimateLimit) * 100)) : null;
      if (hasRemote) {
        var fillPct = Math.max(0, Math.min(100, pctRemaining));
        quotaFill.style.width = fillPct + "%";
        var level = pctRemaining > 50 ? "ok" : (pctRemaining > 20 ? "mid" : "low");
        quotaFill.setAttribute("data-level", level);
        quotaPct.textContent = (100 - pctUsed).toFixed(1) + "%";
        var usedNum = formatNumber(remote.used);
        var limitNum = formatNumber(remote.limit);
        var remainNum = formatNumber(remote.remaining);
        var resetTxt = formatTimestamp(remote.resetAt);
        var cd = formatCountdown(local.countdownMs);
        quotaMeta.innerHTML =
          '<span><b>' + t.quotaIn + '</b> ' + remainNum + ' / ' + limitNum + (pctUsed != null ? ' (' + usedNum + ' ' + (currentLang()==='en'?'used':'已用') + ')' : '') + '</span>' +
          (resetTxt ? '<span><b>' + t.quotaReset + '</b> ' + resetTxt + (cd ? ' · ' + cd : '') + '</span>' : '') +
          '<span><b>' + t.quotaCalls + '</b> ' + formatNumber(local.calls) + ' · ' + formatNumber(local.totalTokens) + ' ' + t.quotaTokens + '</span>';
      } else if (local.calls) {
        // 没有远程数据：用本地估算显示。Fill 是剩余百分比（按 Lite 套餐 2500 credits 估算）。
        // No remote data: show local estimate. Fill is the remaining % vs. the Lite plan's 2,500 credits.
        if (estPercentRemaining != null) {
          quotaFill.style.width = estPercentRemaining + "%";
          var lvl = estPercentRemaining > 50 ? "ok" : (estPercentRemaining > 20 ? "mid" : "low");
          quotaFill.setAttribute("data-level", lvl);
          quotaPct.textContent = estPercentRemaining.toFixed(1) + "%";
        } else {
          quotaFill.style.width = "0%";
          quotaFill.removeAttribute("data-level");
          quotaPct.textContent = "—";
        }
        var cd2 = formatCountdown(local.countdownMs);
        var resetTxt2 = formatTimestamp(state.local.periodEnd);
        var callsN = formatNumber(local.calls);
        var tokN = formatNumber(local.totalTokens);
        var credN = estCredits > 0 ? estCredits.toFixed(1) + ' credits（' + (currentLang()==='en'?'est':'估算') + '）' : '';
        quotaMeta.innerHTML =
          '<span><b>' + (currentLang()==='en'?'Used':'已用') + '</b> ' + credN + (credN?' · ':'') + callsN + ' ' + t.quotaCalls + ' · ' + tokN + ' ' + t.quotaTokens + '</span>' +
          (resetTxt2 ? '<span><b>' + t.quotaReset + '</b> ' + resetTxt2 + (cd2 ? ' · ' + cd2 : '') + '</span>' : '') +
          '<span style="opacity:.8">' + t.quotaNoRemote + '</span>';
      } else {
        // 一次都没调用过
        quotaFill.style.width = "0%";
        quotaFill.removeAttribute("data-level");
        quotaPct.textContent = "—";
        quotaMeta.innerHTML = '<span>' + t.quotaIdle + '</span>';
        quotaDetail.innerHTML = "";
        return;
      }
      // 最近 10 次明细
      var recent = local.recentCalls || [];
      if (!recent.length) { quotaDetail.innerHTML = ""; return; }
      var rows = recent.map(function (entry) {
        var at = formatTimestamp(new Date(entry.timestamp).toISOString());
        var credTxt = entry.credits != null ? ' · ' + entry.credits.toFixed(1) + ' cr' : '';
        return '<div class="btc-ai-quota-detail-row"><b>' + (at || '—') + ' · ' + escapeHtml(entry.model || '') + '</b><span>' + formatNumber(entry.total) + ' tok' + credTxt + '</span></div>';
      }).join("");
      quotaDetail.innerHTML = rows;
    }
    async function loadQuota() {
      try {
        var response = await fetch("/api/ai/quota");
        if (!response.ok) return null;
        var payload = await response.json();
        renderQuota(payload);
        return payload;
      } catch (error) { return null; }
    }
    // 折叠/展开明细
    // Toggle the detail block.
    function toggleQuotaDetail() { quotaEl.setAttribute("data-open", quotaEl.getAttribute("data-open") === "true" ? "false" : "true"); }
    quotaEl.addEventListener("click", toggleQuotaDetail);

    // 流式读取：服务端以 SSE 增量推送，逐块追加到同一条消息上。
    // Streaming: the server pushes SSE deltas which are appended to one message node.
    async function ask(question) {
      question = String(question || "").trim();
      if (!question || busy) return;
      if (!configured) {
        await loadConfig();
        if (!configured) { addMessage("error", t.notConfigured); return; }
      }
      addMessage("user", question);
      input.value = "";
      history.push({ role: "user", content: question });
      setBusy(true);
      var botNode = addMessage("bot", "");
      var caret = document.createElement("span");
      caret.className = "btc-ai-caret";
      botNode.appendChild(caret);
      var full = "";
      // 等待期间给用户可见的进度：先提示"已连接"，深度模式再显示推理进度。
      // Give the user visible progress while waiting: connection notice, then reasoning progress.
      var statusNode = document.createElement("span");
      statusNode.className = "btc-ai-status";
      statusNode.textContent = t.connected;
      botNode.appendChild(statusNode);

      try {
        var response = await fetch("/api/ai/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ question: question, history: history.slice(0, -1), stream: true, lang: currentLang(), thinking: thinking, style: answerStyle })
        });
        var type = response.headers.get("content-type") || "";
        if (!response.ok) {
          var errBody = await response.json().catch(function () { return {}; });
          throw new Error(errBody.error || t.askAgain);
        }
        if (type.indexOf("application/json") >= 0) {
          var data = await response.json();
          full = data.content || "";
        } else {
          var reader = response.body.getReader();
          var decoder = new TextDecoder();
          var buffer = "";
          while (true) {
            var chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            var lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (var i = 0; i < lines.length; i += 1) {
              var line = lines[i].trim();
              if (line.indexOf("data:") !== 0) continue;
              var raw = line.slice(5).trim();
              if (!raw) continue;
              var parsed;
              try { parsed = JSON.parse(raw); } catch (e) { continue; }
              if (parsed.error) throw new Error(parsed.error);
              // 深度模式：上游持续吐 reasoning_content，这里只显示进度不显示正文。
              // Deep mode: upstream streams reasoning_content; show progress only, not the text.
              if (parsed.reasoning != null) {
                statusNode.textContent = t.thinkingDeep + "…（" + t.reasoningNow + " " + parsed.reasoning + " " + t.reasoningUnit + "）";
                continue;
              }
              if (parsed.delta) {
                if (statusNode.parentNode) statusNode.remove();
                full += parsed.delta;
                botNode.innerHTML = renderRich(full);
                botNode.appendChild(caret);
                log.scrollTop = log.scrollHeight;
              }
            }
          }
        }
        if (!full) full = "（无返回内容）";
        history.push({ role: "assistant", content: full });
        // 成功拿到回答后立即拉一次最新额度（含响应头 + 本地累加），不等轮询。
        // Refresh quota immediately after a successful answer; don't wait for the next tick.
        loadQuota();
      } catch (error) {
        botNode.remove();
        addMessage("error", error.message || t.askAgain);
        history.pop();
      } finally {
        botNode.innerHTML = renderRich(full || "…");
        setBusy(false);
        input.focus();
      }
    }

    sendBtn.onclick = function () { ask(input.value); };
    // 模式切换：快速 ⇄ 深度，选择记住在本地。
    // Mode toggle: fast <-> deep, remembered locally.
    if (modelTag) modelTag.onclick = function (event) {
      event.stopPropagation();
      toggleModelMenu();
    };
    if (modelMenu) modelMenu.onclick = function (event) { event.stopPropagation(); };
    if (styleBtn) styleBtn.onclick = function (event) {
      event.stopPropagation();
      toggleStyleMenu();
    };
    if (styleMenu) styleMenu.onclick = function (event) { event.stopPropagation(); };
    // 点面板内其它区域或页面空白处收起浮层。
    // Clicking anywhere else dismisses the overlays.
    document.addEventListener("click", function () {
      if (modelMenu && !modelMenu.hidden) toggleModelMenu(false);
      if (styleMenu && !styleMenu.hidden) toggleStyleMenu(false);
    });

    if (modeBtn) modeBtn.onclick = function () {
      thinking = thinking === "deep" ? "fast" : "deep";
      try { localStorage.setItem("btc_ai_thinking", thinking); } catch (e) { /* 忽略存储失败 / ignore storage failures */ }
      applyModeLabel();
      input.focus();
    };
    input.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); ask(input.value); }
    });
    clearBtn.onclick = function () { history = []; log.innerHTML = ""; addMessage("bot", t.greeting); };
    closeBtn.onclick = function () { panel.hidden = true; };
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !panel.hidden) panel.hidden = true;
    });
    launch.onclick = function () {
      panel.hidden = !panel.hidden;
      if (!panel.hidden) {
        if (!log.childElementCount) addMessage("bot", t.greeting);
        loadConfig();
        loadQuota();
        input.focus();
      }
    };

    applyLabels();
    addMessage("bot", t.greeting);
    loadConfig();
    loadQuota();
    // 60 秒轮询：刷新额度与倒计时；提问成功后也会主动调一次。
    // Poll every 60s so the countdown stays fresh; also called after each successful answer.
    setInterval(function () { if (!panel.hidden) loadQuota(); }, 60_000);
    // 语言切换后重刷静态文案（页面使用 data-zh/data-en 同步）。
    // Refresh static labels after a language switch (the page syncs via data-zh/data-en).
    new MutationObserver(function () { applyLabels(); }).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
