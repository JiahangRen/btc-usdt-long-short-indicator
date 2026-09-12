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
      connectedWithPosition: "已连接，正在结合你的持仓读数据…",
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
      aiTip: "点我，问问行情",
      resize: "拖动四边或四角调整窗口大小",
      webOn: "联网",
      webOff: "离线",
      webTipOn: "已开启联网检索：提问时会同时搜索公开新闻与分析，和本站实时数据一起分析",
      webTipOff: "已关闭联网检索：只依据本站实时数据回答",
      webSearching: "正在联网检索公开信息…",
      webFound: "已联网检索到 {n} 条公开信息，正在结合本站数据分析…",
      webNone: "这次没取到可用的外部信息，改为只用本站数据分析…",
      webReceipt: "已联网检索 {n} 条 · 来源 {src} · 耗时 {ms} ms",
      webReceiptCached: "已联网检索 {n} 条（复用 10 分钟内缓存）· 来源 {src}",
      webOffNote: "本次未联网，仅使用本站实时数据",
      webHeadlines: "本次获取到的外部信息",
      newChat: "新建对话",
      newChatTip: "开一段新对话；当前这段会自动存进历史记录",
      newChatDone: "已开启新对话，上一段已存入历史记录",
      historyBtn: "历史对话",
      historyTip: "回看或切回之前的对话，上下文会一起带回来",
      historyTitle: "历史对话",
      historyHint: "点一条即可切回那段对话，上下文一起带回来 · 记录只存在这台设备的浏览器里",
      historyEmpty: "还没有历史对话。点「新建对话」后，当前这段就会存到这里。",
      historyCurrent: "进行中",
      historyMeta: "{n} 条消息 · {t}",
      historyLimit: "最多保留 {n} 段对话，超出会自动清掉最旧的",
      historyDelete: "删除这段对话",
      historyRestored: "已切回历史对话（{n} 条消息），可以直接接着提问",
      historyOpen: "切回这段对话，接着提问",
      historyBadge: "{n}",
      zoomOut: "缩小文字（最小 50%）",
      zoomIn: "放大文字（最大 200%）",
      zoomResetTip: "点一下恢复 100% 字号",
      shotBtn: "长截图",
      shotTip: "把整段对话导出成一张长图，方便分享",
      shotEmpty: "这段对话还没有内容，先问一句再截图",
      shotWorking: "正在生成长图…",
      shotDone: "长图已生成 {w}×{h}，已开始下载",
      shotCopied: "长图已复制到剪贴板，同时下载了一份（{w}×{h}）",
      shotFail: "生成长图失败，请稍后重试（也可直接截屏）",
      shotCount: "共 {n} 条消息",
      exportFoot: "AI 输出为数据分析，不构成投资建议。",
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
      connectedWithPosition: "Connected, reading data with your position attached…",
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
      aiTip: "Tap me to ask",
      resize: "Drag any edge or corner to resize",
      webOn: "Web",
      webOff: "Offline",
      webTipOn: "Web search is on: questions also search public news and analysis alongside the site's live data",
      webTipOff: "Web search is off: answers use only this site's live data",
      webSearching: "Searching public sources…",
      webFound: "Found {n} public items, combining them with local data…",
      webNone: "No usable external info this time — falling back to local data only…",
      webReceipt: "Searched {n} items · {src} · {ms} ms",
      webReceiptCached: "Searched {n} items (cached, <10 min old) · {src}",
      webOffNote: "No web search this time — local data only",
      webHeadlines: "External sources used",
      newChat: "New chat",
      newChatTip: "Start a fresh chat; the current one is filed under History",
      newChatDone: "New chat started — the previous one was saved to History",
      historyBtn: "History",
      historyTip: "Reopen an earlier chat with its context intact",
      historyTitle: "Chat history",
      historyHint: "Tap one to switch back to it, context included · stored in this browser only",
      historyEmpty: "No saved chats yet. Tap New chat and the current one lands here.",
      historyCurrent: "Current",
      historyMeta: "{n} messages · {t}",
      historyLimit: "Up to {n} chats are kept; the oldest is dropped first",
      historyDelete: "Delete this chat",
      historyRestored: "Reopened a saved chat ({n} messages) — just keep asking",
      historyOpen: "Reopen this chat and keep asking",
      historyBadge: "{n}",
      zoomOut: "Smaller text (min 50%)",
      zoomIn: "Larger text (max 200%)",
      zoomResetTip: "Click to reset to 100%",
      shotBtn: "Long shot",
      shotTip: "Export the whole conversation into one tall image",
      shotEmpty: "Nothing to export yet — ask something first",
      shotWorking: "Rendering the long image…",
      shotDone: "Long image ready ({w}×{h}) — download started",
      shotCopied: "Copied to clipboard and downloaded ({w}×{h})",
      shotFail: "Could not render the long image. Please try again (a plain screenshot works too).",
      shotCount: "{n} messages",
      exportFoot: "Analysis only, not investment advice.",
      langName: "English"
    }
  };

  var STYLE_ID = "btc-ai-chat-style";
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      ".btc-ai-launch{position:fixed;right:22px;bottom:22px;z-index:1200;display:inline-flex;align-items:center;gap:8px;padding:11px 16px;border-radius:999px;border:1.5px solid #ff6b6b;background:var(--bg-elevated,#232a33);color:var(--text-primary,#e8eaed);font:500 13px/1 system-ui,-apple-system,'Segoe UI',sans-serif;cursor:grab;touch-action:none;box-shadow:0 8px 24px rgba(0,0,0,.35);transition:transform .12s ease;animation:btc-ai-glow 2.6s ease-in-out infinite,btc-ai-hue 7s linear infinite}",
      ".btc-ai-launch[hidden]{display:none}",
      // 波纹扩散：两个向外扩的发光圆环，用伪元素画。inset:-1px 让环贴在胶囊外侧，
      // z-index:-1 让环落在按钮自身背景之后（本元素有 z-index 会自成层叠上下文，环仍在页面内容之上）。
      // Ripple rings: glowing pseudo-element rings scaling outward; inset:-1px keeps them on the
      // pill's rim, z-index:-1 drops them behind the pill's own background.
      ".btc-ai-launch::before,.btc-ai-launch::after{content:'';position:absolute;inset:-1px;border-radius:999px;border:2px solid rgba(255,107,107,.85);box-shadow:0 0 14px rgba(255,107,107,.6),inset 0 0 10px rgba(255,107,107,.35);pointer-events:none;z-index:-1;animation:btc-ai-ripple 3s cubic-bezier(.2,.6,.3,1) infinite}",
      ".btc-ai-launch::after{animation-delay:1.5s;border-color:rgba(34,211,238,.8);box-shadow:0 0 14px rgba(34,211,238,.55),inset 0 0 10px rgba(34,211,238,.3)}",
      ".btc-ai-launch:hover{transform:translateY(-1px) scale(1.03)}",
      ".btc-ai-launch:focus-visible{outline:2px solid var(--accent-purple,#a78bfa);outline-offset:2px}",
      ".btc-ai-dot{width:8px;height:8px;border-radius:50%;background:#ff6b6b;animation:btc-ai-dot 2.2s ease-in-out infinite}",
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
      ".btc-ai-msg{max-width:92%;padding:11px 13px;border-radius:12px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-weight:400;font-size:calc(13px * var(--ai-fs,1));line-height:1.6;white-space:normal;word-break:break-word}",
      // 提问气泡：紫罗兰渐变 + 白字 + 右下收一个小圆角（像从对话框里「长出来」），
      // 字号比回答小一档、字重稍加，读起来更像「我说的话」而不是一段正文。
      // Question bubble: violet gradient, white text, one tight corner so it reads as a speech
      // bubble, and a step smaller than the answers.
      ".btc-ai-msg.user{align-self:flex-end;max-width:84%;padding:10px 14px;border-radius:16px 16px 4px 16px;background:linear-gradient(135deg,#a294ff 0%,#7c68f0 46%,#5f4be0 100%);color:#fff;font-size:calc(12px * var(--ai-fs,1));font-weight:500;line-height:1.55;letter-spacing:.012em;border:1px solid rgba(255,255,255,.18);box-shadow:0 10px 22px -14px rgba(95,75,224,.95)}",
      // 站点全局的 `p`/`li` 规则会盖掉继承色，白字必须对内部元素逐个显式指定，否则会被染成深灰。
      // The site's global `p`/`li` rules beat inheritance, so every descendant needs an explicit
      // white colour — otherwise the text turns dark grey on the gradient.
      ".btc-ai-msg.user .btc-ai-section,.btc-ai-msg.user .btc-ai-p,.btc-ai-msg.user .btc-ai-list li{color:#fff}",
      ".btc-ai-msg.user strong,.btc-ai-msg.user .btc-ai-num,.btc-ai-msg.user .btc-ai-tag,.btc-ai-msg.user .btc-ai-bull,.btc-ai-msg.user .btc-ai-bear,.btc-ai-msg.user .btc-ai-warn,.btc-ai-msg.user .btc-ai-pct,.btc-ai-msg.user .btc-ai-pct-neg{color:#fff}",
      ".btc-ai-msg.user strong{font-weight:600}",
      ".btc-ai-msg.user .btc-ai-num{background:rgba(255,255,255,.2);border-color:rgba(255,255,255,.32)}",
      // 用户提问通常只有一行，不需要左侧竖线，去掉更干净。
      // A one-line question needs no left rail — drop it for a cleaner bubble.
      ".btc-ai-msg.user .btc-ai-section{border-left:0;padding-left:0}",
      ".btc-ai-msg.bot{align-self:flex-start;background:var(--bg-elevated,#232a33);border:1px solid var(--border-subtle,#2a313b)}",
      ".btc-ai-msg.error{align-self:flex-start;background:transparent;border:1px solid var(--bear,#ff4d6a);color:var(--bear,#ff4d6a)}",
      // 气泡内最后一块不留底外边距：否则单行提问的气泡下沿会多出一截空白，看着不居中。
      // The last block inside a bubble keeps no bottom margin, or a one-line question ends up
      // bottom-heavy with dead space under the text.
      ".btc-ai-msg > .btc-ai-section:last-child,.btc-ai-msg > .btc-ai-p:last-child,.btc-ai-msg > .btc-ai-list:last-child,.btc-ai-msg > .btc-ai-table-wrap:last-child,.btc-ai-msg .btc-ai-section:last-child > .btc-ai-p:last-child,.btc-ai-msg .btc-ai-section:last-child > .btc-ai-list:last-child{margin-bottom:0}",
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
      // 发送键与提问气泡同一套紫罗兰渐变，视觉上「发出去的」和「写下的」是同一件事。
      // The send button shares the question bubble's violet gradient so the two look related.
      ".btc-ai-send{border:1px solid rgba(255,255,255,.18);background:linear-gradient(135deg,#a294ff,#5f4be0);color:#fff;border-radius:10px;padding:10px 14px;font:500 13px/1 system-ui,sans-serif;cursor:pointer;box-shadow:0 8px 18px -12px rgba(95,75,224,.95)}",
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
      ".btc-ai-note{margin:8px 2px 0;font:400 11px/1.4 system-ui,sans-serif;color:var(--text-muted,#5b6573);text-align:center}",
      ".btc-ai-launch.btc-ai-dragging{cursor:grabbing;transition:none;animation:none;opacity:.92}",
      ".btc-ai-launch.btc-ai-dragging::before,.btc-ai-launch.btc-ai-dragging::after{animation:none;opacity:0}",
      // 首次打开后收敛一档：光波照旧在跑（只是更慢更淡），确保按钮永远有可见动效。
      // After the first open the effect drops one gear — the wave keeps running, just slower
      // and fainter — so the button is never animation-less.
      ".btc-ai-launch.btc-ai-seen{animation:btc-ai-glow-soft 4.2s ease-in-out infinite,btc-ai-hue 14s linear infinite}",
      ".btc-ai-launch.btc-ai-seen::before{animation:btc-ai-ripple-soft 4.6s cubic-bezier(.2,.6,.3,1) infinite;border-color:rgba(255,107,107,.6);box-shadow:0 0 10px rgba(255,107,107,.35)}",
      ".btc-ai-launch.btc-ai-seen::after{animation:none;opacity:0}",
      "@keyframes btc-ai-glow{0%,100%{box-shadow:0 8px 24px rgba(0,0,0,.35),0 0 18px 3px rgba(255,107,107,.6)}50%{box-shadow:0 8px 24px rgba(0,0,0,.35),0 0 40px 13px rgba(34,211,238,.8)}}",
      "@keyframes btc-ai-glow-soft{0%,100%{box-shadow:0 8px 24px rgba(0,0,0,.35),0 0 12px 1px rgba(255,107,107,.36)}50%{box-shadow:0 8px 24px rgba(0,0,0,.35),0 0 28px 7px rgba(255,107,107,.7)}}",
      "@keyframes btc-ai-ripple{0%{transform:scale(1);opacity:.9}70%{opacity:.16}100%{transform:scale(1.9);opacity:0}}",
      "@keyframes btc-ai-ripple-soft{0%{transform:scale(1);opacity:.45}70%{opacity:.1}100%{transform:scale(1.5);opacity:0}}",
      // 彩虹循环：红基色 + hue-rotate 360°，按 红→橙→黄→绿→青→蓝→紫→红 循环扫过
      // 边框、辉光与波纹环（filter 作用于整个元素渲染，含伪元素与阴影）。
      // Rainbow cycle: red base + hue-rotate sweeps border, glow and ripple rings
      // through red→orange→yellow→green→cyan→blue→purple→red.
      "@keyframes btc-ai-hue{0%{filter:hue-rotate(0deg)}100%{filter:hue-rotate(360deg)}}",
      "@keyframes btc-ai-dot{0%,100%{transform:scale(1);background:var(--accent-purple,#a78bfa);box-shadow:0 0 0 0 rgba(167,139,250,.8)}50%{transform:scale(1.45);background:var(--accent-cyan,#22d3ee);box-shadow:0 0 0 7px rgba(34,211,238,0)}}",
      ".btc-ai-launch-tip{position:absolute;right:0;bottom:calc(100% + 12px);white-space:nowrap;background:var(--accent-purple,#a78bfa);color:#14121f;font:500 12px/1 system-ui,sans-serif;padding:7px 11px;border-radius:9px;box-shadow:0 8px 22px rgba(0,0,0,.45);pointer-events:none;animation:btc-ai-tip-in .35s ease both}",
      ".btc-ai-launch-tip::after{content:'';position:absolute;top:100%;right:20px;border:6px solid transparent;border-top-color:var(--accent-purple,#a78bfa)}",
      "@keyframes btc-ai-tip-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}",
      // 八向缩放把手：四条边各一条细带（单轴拉伸），四角各一个小方块（同时改宽高）。
      // 8-way resize grips: thin strips along each edge (one axis) plus corner squares (both).
      ".btc-ai-rz{position:absolute;z-index:4;touch-action:none;background:transparent}",
      ".btc-ai-rz-n{left:12px;right:12px;top:0;height:6px;cursor:ns-resize}",
      ".btc-ai-rz-s{left:12px;right:12px;bottom:0;height:6px;cursor:ns-resize}",
      ".btc-ai-rz-w{top:12px;bottom:12px;left:0;width:6px;cursor:ew-resize}",
      ".btc-ai-rz-e{top:12px;bottom:12px;right:0;width:6px;cursor:ew-resize}",
      ".btc-ai-rz-nw{left:0;top:0;width:14px;height:14px;cursor:nwse-resize}",
      ".btc-ai-rz-ne{right:0;top:0;width:14px;height:14px;cursor:nesw-resize}",
      ".btc-ai-rz-sw{left:0;bottom:0;width:14px;height:14px;cursor:nesw-resize}",
      ".btc-ai-rz-se{right:0;bottom:0;width:14px;height:14px;cursor:nwse-resize}",
      // 右下角只保留透明的缩放热区，不再画那个「小角」标记（用户要求隐藏）。
      // The bottom-right keeps a transparent hit zone only — the visible corner marker
      // was removed on request. Do not re-add a ::after here.
      ".btc-ai-rz-se{border:0;background:transparent}",
      ".btc-ai-rz:hover{background:rgba(167,139,250,.16)}",
      ".btc-ai-rz-se:hover{background:transparent}",
      ".btc-ai-panel[data-resizing='true']{user-select:none}",
      ".btc-ai-panel[data-resizing='true'] .btc-ai-log{pointer-events:none}",
      ".btc-ai-msg strong{font-weight:700;color:var(--text-primary,#e8eaed)}",
      ".btc-ai-section{margin:2px 0 9px;padding-left:10px;border-left:3px solid var(--accent-cyan,#22d3ee);line-height:1.6}",
      ".btc-ai-section .btc-ai-tag{margin-right:6px}",
      ".btc-ai-p{margin:0 0 8px}",
      ".btc-ai-list{margin:0 0 9px;padding-left:18px}",
      ".btc-ai-list li{margin:3px 0;line-height:1.6}",
      ".btc-ai-bull{color:var(--bull,#00d4aa);font-weight:600}",
      ".btc-ai-bear{color:var(--bear,#ff4d6a);font-weight:600}",
      ".btc-ai-warn{color:var(--warn,#f59e0b);font-weight:600}",
      ".btc-ai-num{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:500;font-size:calc(12.5px * var(--ai-fs,1));line-height:1;background:rgba(127,127,127,.14);border:1px solid var(--border-subtle,#2a313b);border-radius:5px;padding:0 4px;color:var(--text-primary,#e8eaed)}",
      ".btc-ai-pct{font-weight:600;color:var(--accent-cyan,#22d3ee)}",
      ".btc-ai-pct-neg{color:var(--bear,#ff4d6a)}",
      ".btc-ai-table-wrap{margin:4px 0 10px;overflow-x:auto}",
      ".btc-ai-table{border-collapse:collapse;width:100%;font-family:system-ui,sans-serif;font-weight:400;font-size:calc(12px * var(--ai-fs,1));line-height:1.4}",
      ".btc-ai-table th,.btc-ai-table td{border:1px solid var(--border-subtle,#2a313b);padding:5px 8px;text-align:left;white-space:nowrap}",
      ".btc-ai-table th{background:var(--bg-elevated,#232a33);color:var(--text-primary,#e8eaed);font-weight:600}",
      ".btc-ai-table td{color:var(--text-secondary,#9aa4b2)}",
      ".btc-ai-table tr:nth-child(even) td{background:rgba(127,127,127,.06)}",
      // 联网开关：与模型/语气徽标同款胶囊，开着时描边点亮。
      // Web-search chip: same pill as the model/style chips, lit up while enabled.
      ".btc-ai-web{font:400 11px/1 system-ui,sans-serif;color:var(--text-secondary,#9aa4b2);border:1px solid var(--border-subtle,#2a313b);border-radius:999px;padding:4px 10px;background:transparent;cursor:pointer;white-space:nowrap}",
      ".btc-ai-web:hover{border-color:var(--accent-purple,#a78bfa);color:var(--text-primary,#e8eaed)}",
      ".btc-ai-web[data-on='true']{color:var(--accent-cyan,#22d3ee);border-color:var(--accent-cyan,#22d3ee)}",
      // 检索回执：回答下方一行小字，说明这次到底联网取了几条、来自哪里、耗时多久。
      // Search receipt: one small line under the answer showing count, outlets and latency.
      ".btc-ai-src{margin-top:8px;padding-top:7px;border-top:1px dashed var(--border-subtle,#2a313b);font-family:system-ui,sans-serif;font-weight:400;font-size:calc(11px * var(--ai-fs,1));line-height:1.5;color:var(--text-muted,#5b6573)}",
      ".btc-ai-src b{color:var(--accent-cyan,#22d3ee);font-weight:600}",
      ".btc-ai-src ul{margin:4px 0 0;padding-left:16px}",
      ".btc-ai-src li{margin:2px 0;color:var(--text-muted,#5b6573)}",
      ".btc-ai-section-lead{border-left-color:var(--accent-purple,#a78bfa);background:rgba(167,139,250,.08);border-radius:0 8px 8px 0;padding:8px 10px 2px;margin-bottom:11px}",
      ".btc-ai-chart{margin:6px 0 11px;padding:9px 10px 7px;border:1px solid var(--border-subtle,#2a313b);border-radius:10px;background:rgba(127,127,127,.05)}",
      ".btc-ai-chart figcaption{margin:0 0 7px;font:500 12px/1.3 system-ui,sans-serif;color:var(--text-primary,#e8eaed)}",
      ".btc-ai-chart svg{display:block;width:100%;height:auto;overflow:visible}",
      ".btc-ai-chart text{font:400 10px/1 system-ui,sans-serif}",
      ".btc-ai-chart .btc-ai-chart-val{font-weight:600}",
      // 工具条：新建对话 / 历史对话 / 字号 / 长截图。单独一行，避免把标题栏挤爆。
      // Tool row: new chat, history, text size, long screenshot — its own row keeps the header uncrowded.
      ".btc-ai-tools{display:flex;align-items:center;gap:6px;padding:7px 12px;border-bottom:1px solid var(--border-subtle,#2a313b);background:var(--bg-surface,#161a20);flex-wrap:wrap}",
      ".btc-ai-tool{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--border-subtle,#2a313b);background:transparent;color:var(--text-secondary,#9aa4b2);border-radius:999px;padding:5px 10px;font:400 11px/1 system-ui,sans-serif;cursor:pointer;white-space:nowrap}",
      ".btc-ai-tool:hover{border-color:var(--accent-purple,#a78bfa);color:var(--text-primary,#e8eaed)}",
      ".btc-ai-tool[data-active='true']{border-color:var(--accent-purple,#a78bfa);color:var(--accent-purple,#a78bfa);background:rgba(167,139,250,.12)}",
      ".btc-ai-tool-spacer{flex:1}",
      ".btc-ai-tool-badge{font:500 10px/1 system-ui,sans-serif;border-radius:999px;padding:2px 6px;background:rgba(167,139,250,.18);color:var(--accent-purple,#a78bfa)}",
      ".btc-ai-tool-badge[hidden]{display:none}",
      ".btc-ai-zoom-val{border:0;background:transparent;color:var(--text-muted,#5b6573);font:400 11px/1 system-ui,sans-serif;font-variant-numeric:tabular-nums;cursor:pointer;padding:5px 2px;min-width:40px;text-align:center}",
      ".btc-ai-zoom-val:hover{color:var(--text-primary,#e8eaed)}",
      ".btc-ai-note-flash{color:var(--accent-cyan,#22d3ee)}",
      // 历史对话浮层：与模型浮层同款卡片，纵向避开工具条（打开时按工具条实际位置再校准一次）。
      // History overlay: same card as the model menu, parked below the tool row (re-measured on open).
      ".btc-ai-convs{position:absolute;top:100px;right:10px;z-index:7;width:min(360px,calc(100% - 20px));max-height:62%;overflow-y:auto;padding:8px;border-radius:12px;border:1px solid var(--border-strong,#3a434f);background:var(--bg-elevated,#232a33);box-shadow:0 16px 40px rgba(0,0,0,.5);scrollbar-width:thin}",
      ".btc-ai-convs[hidden]{display:none}",
      ".btc-ai-convs h4{margin:2px 4px 4px;font:500 12px/1.3 system-ui,sans-serif;color:var(--text-primary,#e8eaed)}",
      ".btc-ai-conv-row{display:flex;align-items:center;gap:6px;padding:7px 8px;border-radius:9px;cursor:pointer}",
      ".btc-ai-conv-row:hover{background:rgba(167,139,250,.1)}",
      ".btc-ai-conv-row[aria-current='true']{background:rgba(167,139,250,.16)}",
      ".btc-ai-conv-body{min-width:0;flex:1}",
      ".btc-ai-conv-title{display:block;font:500 12px/1.35 system-ui,sans-serif;color:var(--text-primary,#e8eaed);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".btc-ai-conv-meta{display:block;margin-top:3px;font:400 10px/1.3 system-ui,sans-serif;color:var(--text-muted,#5b6573)}",
      ".btc-ai-conv-now{font:500 10px/1 system-ui,sans-serif;color:var(--accent-cyan,#22d3ee)}",
      ".btc-ai-conv-go{flex:0 0 auto;color:var(--text-muted,#5b6573);font:400 15px/1 system-ui,sans-serif;padding:0 1px}",
      ".btc-ai-conv-row:hover .btc-ai-conv-go{color:var(--accent-purple,#a78bfa)}",
      ".btc-ai-conv-del{border:0;background:transparent;color:var(--text-muted,#5b6573);font:400 14px/1 system-ui,sans-serif;cursor:pointer;padding:2px 6px;border-radius:6px}",
      ".btc-ai-conv-del:hover{color:var(--bear,#ff4d6a);background:rgba(255,77,106,.12)}",
      // 长截图导出容器：既是页面里的离屏量尺，也是 SVG foreignObject 里的根节点，所以样式一律用
      // #btc-ai-shot 作用域，绝不写全局选择器（否则会污染整站）。
      // The export container doubles as the off-screen measuring ruler and the foreignObject root,
      // so every rule is scoped under #btc-ai-shot instead of polluting the site.
      "#btc-ai-shot *{box-sizing:border-box;margin:0;padding:0}",
      "#btc-ai-shot{width:100%;padding:20px 18px 16px;background:var(--bg-surface,#161a20);color:var(--text-primary,#e8eaed);font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:calc(13px * var(--ai-fs,1))}",
      "#btc-ai-shot .btc-ai-shot-head{border-bottom:1px solid var(--border-subtle,#2a313b);padding-bottom:12px;margin-bottom:14px}",
      "#btc-ai-shot .btc-ai-shot-head h1{font-weight:600;font-size:calc(18px * var(--ai-fs,1));line-height:1.3;color:var(--text-primary,#e8eaed)}",
      "#btc-ai-shot .btc-ai-shot-head p{margin-top:6px;font-size:calc(12px * var(--ai-fs,1));line-height:1.5;color:var(--text-secondary,#9aa4b2)}",
      "#btc-ai-shot .btc-ai-shot-body{display:flex;flex-direction:column;gap:14px}",
      "#btc-ai-shot .btc-ai-shot-foot{margin-top:16px;padding-top:10px;border-top:1px dashed var(--border-subtle,#2a313b);font-size:calc(11px * var(--ai-fs,1));color:var(--text-muted,#5b6573)}",
      "#btc-ai-shot .btc-ai-log{display:block;overflow:visible;height:auto;padding:0}",
      "#btc-ai-shot-host{position:fixed;left:-100000px;top:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:-1}"
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
  // 富文本渲染：把模型返回的纯文本转成清晰排版。
  // Rich renderer: turn the model's plain text into clean, scannable HTML.
  // 方向词着色（绿涨红跌）、价格/百分比高亮、段落与列表、Markdown 表格。
  // Directional words get colored (green up / red down), prices & percents are
  // highlighted, paragraphs/lists are grouped, Markdown tables are rendered.
  var BULL_RE = /(看多|做多|上涨|多头|看涨|突破|站上|金叉|支撑|企稳)/g;
  var BEAR_RE = /(看空|做空|下跌|空头|看跌|跌破|失守|死叉|阻力|回落|回调)/g;
  var WARN_RE = /(强平|爆仓|止损|风险|杠杆|警告|注意|谨慎)/g;
  function colorize(text) {
    return text
      .replace(BULL_RE, '<span class="btc-ai-bull">$1</span>')
      .replace(BEAR_RE, '<span class="btc-ai-bear">$1</span>')
      .replace(WARN_RE, '<span class="btc-ai-warn">$1</span>');
  }
  // 价格（带 $ 或千分位）与百分比高亮成 chip；负数百分比标红。
  // Prices (with $ or thousands separators) and percentages become chips; negative % is red.
  function fmtNums(text) {
    return text
      .replace(/\$?\s?\d{1,3}(?:,\d{3})+(?:\.\d+)?|\$?\s?\d{4,}(?:\.\d+)?/g, function (m) {
        return '<span class="btc-ai-num">' + m + "</span>";
      })
      .replace(/(-?\d+(?:\.\d+)?)%/g, function (m, p) {
        var cls = p.indexOf("-") === 0 ? "btc-ai-pct btc-ai-pct-neg" : "btc-ai-pct";
        return '<span class="' + cls + '">' + m + "</span>";
      });
  }
  function inline(s) {
    s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    s = fmtNums(s);
    s = colorize(s);
    return s;
  }
  function renderTable(buf) {
    buf = buf.filter(function (l) { return l.trim(); });
    if (buf.length < 2) return escapeHtml(buf.join("\n")).replace(/\n/g, "<br>");
    function cells(line) {
      return line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map(function (c) { return c.trim(); });
    }
    var head = cells(buf[0]);
    var rows = buf.slice(1).filter(function (l) {
      return !/^[\s|:-]+$/.test(l); // 跳过 | --- | --- | 分隔行
    }).map(cells);
    if (!rows.length) return escapeHtml(buf.join("\n")).replace(/\n/g, "<br>");
    var th = head.map(function (h) { return "<th>" + inline(h) + "</th>"; }).join("");
    var body = rows.map(function (r) {
      return "<tr>" + r.map(function (c) { return "<td>" + inline(c) + "</td>"; }).join("") + "</tr>";
    }).join("");
    return '<div class="btc-ai-table-wrap"><table class="btc-ai-table"><thead><tr>' + th + "</tr></thead><tbody>" + body + "</tbody></table></div>";
  }
  // ---------- 按需图表 / On-demand charts ----------
  // 只认模型显式给出的 ```chart 代码块（每行「标签: 数值」）。图表是可选的：模型判断
  // 「图比文字更简明」时才输出，前端不会每次回答都硬塞一张图。
  // Only explicit ```chart fenced blocks (one "label: value" per line) are supported. Charts
  // are optional: the model emits one only when a chart reads better than prose.
  function parseChartBlock(lines) {
    var spec = { type: "bar", title: "", rows: [] };
    lines.forEach(function (raw) {
      var line = String(raw).trim();
      if (!line) return;
      var m = line.match(/^([^:：]+)[:：]\s*(.*)$/);
      if (!m) return;
      var key = m[1].trim().toLowerCase();
      var value = m[2].trim();
      if (key === "type" || key === "类型") { spec.type = value.toLowerCase() === "line" ? "line" : "bar"; return; }
      if (key === "title" || key === "标题") { spec.title = value; return; }
      if (key === "unit" || key === "单位") { spec.unit = value; return; }
      var num = parseFloat(value.replace(/[^0-9.+-]/g, ""));
      if (!Number.isFinite(num)) return;
      // 保留原始写法（可能带 % 或单位），图上直接照抄，避免四舍五入失真。
      // Keep the literal text (may carry a % or unit) so the chart never re-rounds the value.
      spec.rows.push({ label: m[1].trim(), value: num, raw: value });
    });
    return spec.rows.length >= 2 ? spec : null;
  }
  function chartFill(value, maxAbs) {
    // 负数走跌色，接近最大值的走涨色，其余用青色——与页面既有的涨跌语义一致。
    // Negative values use the bear colour, near-max use the bull colour, the rest cyan.
    if (value < 0) return "var(--bear,#ff4d6a)";
    if (maxAbs > 0 && Math.abs(value) >= maxAbs * 0.85) return "var(--bull,#00d4aa)";
    return "var(--accent-cyan,#22d3ee)";
  }
  function renderChart(spec) {
    var rows = spec.rows.slice(0, 12);
    if (rows.length < 2) return "";
    var maxAbs = 0;
    rows.forEach(function (r) { maxAbs = Math.max(maxAbs, Math.abs(r.value)); });
    if (!maxAbs) maxAbs = 1;
    var parts = [];
    var height;
    if (spec.type === "line") {
      // 折线：等距横轴，纵向按数值区间归一化，末端点加粗。
      // Line: evenly spaced x-axis, values normalised vertically, last point emphasised.
      var values = rows.map(function (r) { return r.value; });
      var min = Math.min.apply(null, values), max = Math.max.apply(null, values);
      var span = max - min || 1;
      var left = 46, right = 24, top = 14, bottom = 26;
      var plotW = 600 - left - right, plotH = Math.max(70, rows.length * 14);
      height = plotH + top + bottom;
      var points = rows.map(function (row, index) {
        var x = left + (rows.length === 1 ? plotW / 2 : (index / (rows.length - 1)) * plotW);
        var y = top + (1 - (row.value - min) / span) * plotH;
        return { x: x, y: y, row: row };
      });
      parts.push('<line x1="' + left + '" y1="' + (top + plotH) + '" x2="' + (left + plotW) + '" y2="' + (top + plotH) + '" stroke="var(--border-subtle,#2a313b)" stroke-width="1"/>');
      parts.push('<polyline fill="none" stroke="var(--accent-cyan,#22d3ee)" stroke-width="2" stroke-linejoin="round" points="' + points.map(function (p) { return p.x.toFixed(1) + "," + p.y.toFixed(1); }).join(" ") + '"/>');
      points.forEach(function (p, index) {
        var last = index === points.length - 1;
        parts.push('<circle cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="' + (last ? 4 : 2.6) + '" fill="' + chartFill(p.row.value, maxAbs) + '"/>');
        parts.push('<text x="' + p.x.toFixed(1) + '" y="' + (p.y - 8).toFixed(1) + '" text-anchor="middle" fill="var(--text-primary,#e8eaed)">' + escapeHtml(p.row.raw) + "</text>");
        parts.push('<text x="' + p.x.toFixed(1) + '" y="' + (top + plotH + 15) + '" text-anchor="middle" fill="var(--text-secondary,#9aa4b2)">' + escapeHtml(p.row.label.slice(0, 10)) + "</text>");
      });
    } else {
      // 条形：标签左对齐、条长按绝对值比例、数值贴在条尾。
      // Bars: right-aligned labels, length proportional to |value|, value pinned to the tip.
      var labelW = 104, tipW = 66, rowH = 25;
      var barPlotW = 600 - labelW - tipW;
      height = rows.length * rowH + 6;
      rows.forEach(function (row, index) {
        var y = index * rowH + 3;
        var width = Math.max(2, (Math.abs(row.value) / maxAbs) * barPlotW);
        parts.push('<text x="' + (labelW - 8) + '" y="' + (y + 14) + '" text-anchor="end" fill="var(--text-secondary,#9aa4b2)">' + escapeHtml(row.label.slice(0, 11)) + "</text>");
        parts.push('<rect x="' + labelW + '" y="' + y + '" width="' + width.toFixed(1) + '" height="' + (rowH - 9) + '" rx="3" fill="' + chartFill(row.value, maxAbs) + '" opacity=".88"/>');
        parts.push('<text class="btc-ai-chart-val" x="' + (labelW + width + 6).toFixed(1) + '" y="' + (y + 14) + '" fill="var(--text-primary,#e8eaed)">' + escapeHtml(row.raw) + "</text>");
      });
    }
    var caption = spec.title ? "<figcaption>" + escapeHtml(spec.title) + "</figcaption>" : "";
    var label = spec.title || (spec.type === "line" ? "chart" : "chart");
    return '<figure class="btc-ai-chart">' + caption +
      '<svg viewBox="0 0 600 ' + height + '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="' + escapeHtml(label) + '">' +
      parts.join("") + "</svg></figure>";
  }

  function renderRich(text) {
    if (text == null) return "";
    text = String(text).replace(/\u2212/g, "-"); // 统一全角减号，便于数字着色
    var lines = text.split(/\r?\n/);
    var out = [];
    var i = 0;
    var sectionOpen = false;
    // 【结论】是全文最该被看见的一段：给它加底色与更粗的左边线。
    // 【结论】 gets a tinted, thicker left rail — it is the line readers look for first.
    function isLead(title) { return /^\s*(结论|Conclusion)\s*$/i.test(String(title)); }
    function openSection(lead) {
      if (!sectionOpen) {
        out.push('<div class="btc-ai-section' + (lead ? " btc-ai-section-lead" : "") + '">');
        sectionOpen = true;
      }
    }
    function closeSection() { if (sectionOpen) { out.push("</div>"); sectionOpen = false; } }
    while (i < lines.length) {
      var rawLine = lines[i];
      // 代码围栏：```chart → 图表；其它围栏按等宽代码块原样显示。
      // Fences: ```chart becomes a chart; anything else stays a monospace code block.
      var fence = rawLine.match(/^\s*```+\s*([a-zA-Z]*)\s*$/);
      if (fence) {
        var lang = (fence[1] || "").toLowerCase();
        var body = [];
        i++;
        while (i < lines.length && !/^\s*```+\s*$/.test(lines[i])) { body.push(lines[i]); i++; }
        i++; // 跳过结束围栏 / skip the closing fence
        closeSection();
        if (lang === "chart") {
          var spec = parseChartBlock(body);
          if (spec) { out.push(renderChart(spec)); continue; }
        }
        out.push("<pre class='btc-ai-chart'><code>" + escapeHtml(body.join("\n")) + "</code></pre>");
        continue;
      }
      var line = escapeHtml(rawLine);
      // Markdown 表格：连续以 | 起止的行（保持在当前分段内，不另起边框）
      // Markdown table: consecutive lines starting and ending with | (kept inside the current section)
      if (/^\s*\|.*\|\s*$/.test(line)) {
        var tableBuf = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(escapeHtml(lines[i]))) { tableBuf.push(escapeHtml(lines[i])); i++; }
        out.push(renderTable(tableBuf));
        continue;
      }
      // 【标题】分段
      // 【Section】 headers
      var hm = line.match(/^【(.+?)】(.*)$/);
      if (hm) {
        closeSection();
        openSection(isLead(hm[1]));
        out.push('<span class="btc-ai-tag">【' + hm[1] + "】</span>");
        if (hm[2].trim()) out.push(inline(hm[2]));
        i++;
        continue;
      }
      // 无序列表
      // Bullet list
      if (/^\s*[-*•]\s+/.test(line)) {
        closeSection();
        var items = [];
        while (i < lines.length) {
          var b2 = escapeHtml(lines[i]).match(/^\s*[-*•]\s+(.*)$/);
          if (!b2) break;
          items.push("<li>" + inline(b2[1]) + "</li>");
          i++;
        }
        out.push('<ul class="btc-ai-list">' + items.join("") + "</ul>");
        continue;
      }
      // 有序列表
      // Numbered list
      if (/^\s*\d+[.)]\s+/.test(line)) {
        closeSection();
        var nis = [];
        while (i < lines.length) {
          var n2 = escapeHtml(lines[i]).match(/^\s*\d+[.)]\s+(.*)$/);
          if (!n2) break;
          nis.push("<li>" + inline(n2[1]) + "</li>");
          i++;
        }
        out.push('<ol class="btc-ai-list">' + nis.join("") + "</ol>");
        continue;
      }
      if (!line.trim()) { closeSection(); i++; continue; }
      openSection(false);
      out.push('<p class="btc-ai-p">' + inline(line) + "</p>");
      i++;
    }
    closeSection();
    return out.join("");
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
    var busy = false;
    var configured = false;
    var model = "";
    // 可选模型清单由 /api/ai/config 下发（含性价比档位与是否可用于问答）。
    // The selectable model list arrives from /api/ai/config with tier + usable flags.
    var modelList = [];

    // ---------- 对话管理：本地持久化 ----------
    // 每段对话都存在 localStorage 里：刷新不丢、「新建对话」把当前这段归档进历史记录、
    // 历史记录可随时切回来继续聊（上下文一并恢复）。
    // Conversations persist in localStorage: a reload keeps them, "New chat" files the current one
    // under History, and any saved chat can be reopened with its context intact.
    var CONV_KEY = "btc_ai_conv_list";
    var ACTIVE_KEY = "btc_ai_conv_id";
    var CONV_MAX = 12;        // 最多保留的对话段数 / conversations kept
    var CONV_MSG_MAX = 40;    // 每段对话落盘的消息上限 / messages persisted per conversation
    var MSG_CHAR_MAX = 6000;  // 单条消息落盘的字符上限 / chars persisted per message
    var convList = [];        // 已保存的对话（最新的在最前）/ saved conversations, newest first
    var convId = "";          // 当前对话 id / active conversation id
    var convCreatedAt = 0;
    var convMsgs = [];        // 当前对话的消息 / messages of the active conversation
    var convSeq = 0;
    // 字号缩放：只影响对话正文，倍率记在本地。范围 50%–200%：缩小档位密一些（每次 -10%）
    // 方便把长回答压进面板，放大档位到 120% 之后步子变大，避免一路点十几次。
    // Text zoom: scales the transcript only, remembered locally. Range 50%–200% — shrinking
    // steps are fine-grained (10% each) and enlarging gets coarser past 120%.
    var FONT_STEPS = [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.4, 1.6, 1.8, 2];
    var fontScale = 1;
    var shotBusy = false;

    var launch = document.createElement("button");
    launch.type = "button";
    launch.className = "btc-ai-launch";
    launch.hidden = true;
    launch.innerHTML = '<span class="btc-ai-dot"></span><span class="btc-ai-launch-label">' + t.open + "</span>";

    var panel = document.createElement("section");
    panel.className = "btc-ai-panel";
    panel.hidden = true;
    panel.setAttribute("aria-label", t.title);
    panel.innerHTML =
      '<header class="btc-ai-head">' +
      "<div><h3></h3><p></p></div>" +
      '<span class="btc-ai-spacer"></span>' +
      '<button type="button" class="btc-ai-web"></button>' +
      '<button type="button" class="btc-ai-style"></button>' +
      '<button type="button" class="btc-ai-mode" data-mode="fast"></button>' +
      '<button type="button" class="btc-ai-model"></button>' +
      '<button type="button" class="btc-ai-iconbtn" data-act="close"></button>' +
      "</header>" +
      // 工具条：新建对话 / 历史对话 / 字号缩放 / 长截图。
      // Tool row: new chat, history, text-size zoom, long screenshot.
      '<div class="btc-ai-tools">' +
        '<button type="button" class="btc-ai-tool" data-act="new"><span class="btc-ai-tool-label"></span></button>' +
        '<button type="button" class="btc-ai-tool" data-act="history"><span class="btc-ai-tool-label"></span><span class="btc-ai-tool-badge" hidden></span></button>' +
        '<span class="btc-ai-tool-spacer"></span>' +
        '<button type="button" class="btc-ai-tool" data-act="zoom-out">A−</button>' +
        '<button type="button" class="btc-ai-zoom-val" data-act="zoom-reset"></button>' +
        '<button type="button" class="btc-ai-tool" data-act="zoom-in">A＋</button>' +
        '<button type="button" class="btc-ai-tool" data-act="shot"><span class="btc-ai-tool-label"></span></button>' +
      "</div>" +
      // 模型选择浮层：点头部模型徽标展开，按性价比排序。
      // Model picker overlay: opened from the model chip in the header, sorted by value.
      '<div class="btc-ai-models btc-ai-model-menu" hidden></div>' +
      // 语气浮层：与模型浮层同款版式，三档回答模式。
      // Answer-style overlay: same layout as the model menu, three registers.
      '<div class="btc-ai-models btc-ai-styles" hidden></div>' +
      // 历史对话浮层：与模型浮层同款版式，列出本地保存过的对话。
      // History overlay: same card layout, listing the conversations kept in this browser.
      '<div class="btc-ai-convs btc-ai-conv-menu" hidden></div>' +
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

    // 八个方向的缩放把手：n/s 上下拉伸、w/e 左右拉伸、四角同时改宽高。
    // Eight grips: n/s stretch vertically, w/e horizontally, corners change both axes.
    ["n", "s", "w", "e", "nw", "ne", "sw", "se"].forEach(function (dir) {
      var grip = document.createElement("span");
      grip.className = "btc-ai-rz btc-ai-rz-" + dir;
      grip.setAttribute("data-dir", dir);
      grip.title = t.resize;
      panel.appendChild(grip);
    });

    document.body.append(launch, panel);

    // ---------- 悬浮按钮：可拖动 + 注意力动画 ----------
    // Floating button: draggable + attention animation
    var aiTip = document.createElement("span");
    aiTip.className = "btc-ai-launch-tip";
    aiTip.textContent = t.aiTip;
    launch.appendChild(aiTip);
    var launchSeen = false;
    try { launchSeen = localStorage.getItem("btc_ai_launch_seen") === "1"; } catch (e) {}
    if (launchSeen) { launch.classList.add("btc-ai-seen"); aiTip.style.display = "none"; }
    var tipTimer = setTimeout(function () { aiTip.style.display = "none"; }, 7000);
    function hideTip() { aiTip.style.display = "none"; clearTimeout(tipTimer); }
    function markLaunchSeen() {
      launchSeen = true;
      launch.classList.add("btc-ai-seen");
      hideTip();
      try { localStorage.setItem("btc_ai_launch_seen", "1"); } catch (e) {}
    }

    // 恢复上次拖动到的位置
    // Restore the last dragged position.
    try {
      var savedPos = JSON.parse(localStorage.getItem("btc_ai_launch_pos") || "null");
      if (savedPos && Number.isFinite(savedPos.x) && Number.isFinite(savedPos.y)) {
        launch.style.right = "auto";
        launch.style.bottom = "auto";
        launch.style.left = savedPos.x + "px";
        launch.style.top = savedPos.y + "px";
      }
    } catch (e) {}

    var dragMoved = false;
    var lastDragAt = 0;
    // 位移小于这个值算「点击」而不是「拖动」：避免手抖导致点击被吞、动效被无谓打断。
    // Below this distance it counts as a click, not a drag, so a shaky click still opens the panel.
    var DRAG_THRESHOLD = 4;
    launch.addEventListener("pointerdown", function (e) {
      if (e.button !== 0) return;
      var rect = launch.getBoundingClientRect();
      var offX = e.clientX - rect.left;
      var offY = e.clientY - rect.top;
      var startX = e.clientX, startY = e.clientY;
      dragMoved = false;
      var dragging = false;
      try { launch.setPointerCapture(e.pointerId); } catch (err) {}
      function move(ev) {
        if (!dragging) {
          if (Math.abs(ev.clientX - startX) < DRAG_THRESHOLD && Math.abs(ev.clientY - startY) < DRAG_THRESHOLD) return;
          dragging = true;
          dragMoved = true;
          launch.classList.add("btc-ai-dragging");
        }
        var w = rect.width, h = rect.height;
        var x = Math.max(4, Math.min(window.innerWidth - w - 4, ev.clientX - offX));
        var y = Math.max(4, Math.min(window.innerHeight - h - 4, ev.clientY - offY));
        launch.style.right = "auto";
        launch.style.bottom = "auto";
        launch.style.left = x + "px";
        launch.style.top = y + "px";
      }
      function up() {
        try { launch.releasePointerCapture(e.pointerId); } catch (err) {}
        launch.classList.remove("btc-ai-dragging");
        launch.removeEventListener("pointermove", move);
        launch.removeEventListener("pointerup", up);
        launch.removeEventListener("pointercancel", up);
        if (dragMoved) {
          lastDragAt = Date.now();
          try {
            localStorage.setItem("btc_ai_launch_pos", JSON.stringify({
              x: parseInt(launch.style.left, 10),
              y: parseInt(launch.style.top, 10)
            }));
          } catch (err) {}
          // 按钮被挪走后，已打开的面板重新贴回去。
          // The button moved: re-anchor an open panel to its new spot.
          if (!panel.hidden) placePanel();
        }
      }
      launch.addEventListener("pointermove", move);
      launch.addEventListener("pointerup", up);
      launch.addEventListener("pointercancel", up);
    });

    // ---------- 聊天窗口：跟随按钮定位 + 八向拖拽缩放 ----------
    // Chat window: open next to the launch button, resize from any edge or corner.
    var MIN_W = 320, MIN_H = 340;
    // 恢复上次调整的尺寸 / restore the last resized dimensions
    try {
      var savedSize = JSON.parse(localStorage.getItem("btc_ai_panel_size") || "null");
      if (savedSize && Number.isFinite(savedSize.w) && Number.isFinite(savedSize.h)) {
        panel.style.width = savedSize.w + "px";
        panel.style.height = savedSize.h + "px";
      }
    } catch (e) { /* 隐私模式下 localStorage 不可用 / storage can throw in private mode */ }

    function maxPanelW() { return Math.max(MIN_W, window.innerWidth - 8); }
    function maxPanelH() { return Math.max(MIN_H, window.innerHeight - 8); }
    function clampPanelSize() {
      var width = panel.offsetWidth, height = panel.offsetHeight;
      if (!width || !height) return;
      var w = Math.min(Math.max(MIN_W, width), maxPanelW());
      var h = Math.min(Math.max(MIN_H, height), maxPanelH());
      if (w !== width) panel.style.width = w + "px";
      if (h !== height) panel.style.height = h + "px";
    }
    // 「紧贴按钮开」：优先贴在按钮正上/正下方（按钮在下半屏就往上开，在上半屏就往下开），
    // 纵向放不下时退化为贴着按钮左右并排，最后才夹进视口。位置一律用 left/top 表达。
    // Sticks to the button: prefer directly above/below it, fall back to side-by-side when the
    // vertical space is too tight, and only then clamp into the viewport. Anchored with left/top.
    function placePanel() {
      if (panel.hidden) return;
      clampPanelSize();
      var gap = 10, pad = 8;
      var btn = launch.getBoundingClientRect();
      var w = panel.offsetWidth || 430, h = panel.offsetHeight || 620;
      var vw = window.innerWidth, vh = window.innerHeight;
      var cx = btn.left + btn.width / 2, cy = btn.top + btn.height / 2;
      function clampL(l) { return Math.max(pad, Math.min(vw - pad - w, l)); }
      function clampT(t) { return Math.max(pad, Math.min(vh - pad - h, t)); }
      // 四组「紧贴按钮」的原始坐标：下／上／右／左。横向按按钮所在半区与按钮对齐，
      // 纵向按按钮所在半区决定优先顺序（按钮在上半屏先往下开，在下半屏先往上开）。
      // Four anchor candidates: below / above / right / left, aligned to the button's own half.
      var ax = cx <= vw / 2 ? btn.left : btn.right - w;
      var cands = (cy <= vh / 2
        ? [[ax, btn.bottom + gap], [ax, btn.top - gap - h]]
        : [[ax, btn.top - gap - h], [ax, btn.bottom + gap]]
      ).concat([
        [btn.right + gap, cy - h / 2],
        [btn.left - gap - w, cy - h / 2]
      ]);
      // 逐个夹进视口后按代价打分：出屏面积 + 压住主按钮的面积（重罚）+ 顺序偏好，取最小者。
      // 视口很矮／很窄、四条边都塞不下时也能自动选「不遮挡按钮且尽量完整」的那一侧。
      // Clamp each candidate, then score: off-screen area + area covering the button (heavily
      // weighted) + preference order. Picks the least-bad side when nothing fits cleanly.
      var best = null, bestScore = Infinity;
      for (var i = 0; i < cands.length; i++) {
        var l = clampL(cands[i][0]), t = clampT(cands[i][1]);
        var out = (Math.max(0, pad - l) + Math.max(0, l + w - (vw - pad))) * h
                + (Math.max(0, pad - t) + Math.max(0, t + h - (vh - pad))) * w;
        var ox = Math.min(l + w, btn.right) - Math.max(l, btn.left);
        var oy = Math.min(t + h, btn.bottom) - Math.max(t, btn.top);
        var score = out + (ox > 0 && oy > 0 ? ox * oy * 40 : 0) + i * 0.5;
        if (score < bestScore) { bestScore = score; best = [l, t]; }
      }
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      panel.style.left = Math.round(best[0]) + "px";
      panel.style.top = Math.round(best[1]) + "px";
    }

    panel.querySelectorAll(".btc-ai-rz").forEach(function (grip) {
      grip.addEventListener("pointerdown", function (e) {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        var dir = grip.getAttribute("data-dir") || "se";
        var rect = panel.getBoundingClientRect();
        var startX = e.clientX, startY = e.clientY;
        var startW = rect.width, startH = rect.height, startL = rect.left, startT = rect.top;
        // 对边保持不动：拖动左边框时右边框固定，反之亦然。
        // Pin the opposite edge: dragging the left edge keeps the right edge fixed.
        var rightEdge = startL + startW, bottomEdge = startT + startH;
        try { grip.setPointerCapture(e.pointerId); } catch (err) { /* 捕获失败也能继续 / continue without capture */ }
        panel.setAttribute("data-resizing", "true");
        function move(ev) {
          var dx = ev.clientX - startX, dy = ev.clientY - startY;
          var w = startW, h = startH, l = startL, t = startT;
          if (dir.indexOf("e") >= 0) w = startW + dx;
          if (dir.indexOf("w") >= 0) { w = startW - dx; l = startL + dx; }
          if (dir.indexOf("s") >= 0) h = startH + dy;
          if (dir.indexOf("n") >= 0) { h = startH - dy; t = startT + dy; }
          // 触到最小/最大限制时钳住被拖的那条边，对边依然不动。
          // When a limit is reached, pin the dragged edge so the opposite edge stays put.
          var cappedW = Math.min(Math.max(MIN_W, w), maxPanelW());
          if (cappedW !== w) { if (dir.indexOf("w") >= 0) l = rightEdge - cappedW; w = cappedW; }
          var cappedH = Math.min(Math.max(MIN_H, h), maxPanelH());
          if (cappedH !== h) { if (dir.indexOf("n") >= 0) t = bottomEdge - cappedH; h = cappedH; }
          l = Math.max(0, Math.min(window.innerWidth - w, l));
          t = Math.max(0, Math.min(window.innerHeight - h, t));
          panel.style.width = Math.round(w) + "px";
          panel.style.height = Math.round(h) + "px";
          panel.style.left = Math.round(l) + "px";
          panel.style.top = Math.round(t) + "px";
        }
        function up() {
          try { grip.releasePointerCapture(e.pointerId); } catch (err) { /* 已释放 / already released */ }
          panel.removeAttribute("data-resizing");
          grip.removeEventListener("pointermove", move);
          grip.removeEventListener("pointerup", up);
          grip.removeEventListener("pointercancel", up);
          try {
            localStorage.setItem("btc_ai_panel_size", JSON.stringify({
              w: Math.round(panel.getBoundingClientRect().width),
              h: Math.round(panel.getBoundingClientRect().height)
            }));
          } catch (err) { /* 忽略存储失败 / ignore storage failures */ }
        }
        grip.addEventListener("pointermove", move);
        grip.addEventListener("pointerup", up);
        grip.addEventListener("pointercancel", up);
      });
    });
    // 视口变化后重新贴回按钮（面板始终紧贴主按钮，不会飘在页面外）。
    // Re-anchor to the button after a viewport change so the panel never strands off-screen.
    window.addEventListener("resize", placePanel);

    var log = panel.querySelector(".btc-ai-log");
    var quick = panel.querySelector(".btc-ai-quick");
    var input = panel.querySelector(".btc-ai-input");
    var sendBtn = panel.querySelector(".btc-ai-send");
    var modelTag = panel.querySelector(".btc-ai-model");
    var titleEl = panel.querySelector(".btc-ai-head h3");
    var subEl = panel.querySelector(".btc-ai-head p");
    var closeBtn = panel.querySelector('[data-act="close"]');
    var toolsEl = panel.querySelector(".btc-ai-tools");
    var newBtn = panel.querySelector('[data-act="new"]');
    var historyBtn = panel.querySelector('[data-act="history"]');
    var historyBadge = panel.querySelector(".btc-ai-tool-badge");
    var zoomOutBtn = panel.querySelector('[data-act="zoom-out"]');
    var zoomInBtn = panel.querySelector('[data-act="zoom-in"]');
    var zoomVal = panel.querySelector('[data-act="zoom-reset"]');
    var shotBtn = panel.querySelector('[data-act="shot"]');
    var convMenu = panel.querySelector(".btc-ai-conv-menu");
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
    var webBtn = panel.querySelector(".btc-ai-web");
    // 联网检索：默认开（服务端 /api/ai/config 可覆盖），选择记在本地浏览器。
    // Web research: on by default (the server config can override), remembered locally.
    var webEnabled = true;
    try { webEnabled = localStorage.getItem("btc_ai_web") !== "0"; } catch (e) { /* 隐私模式 / private mode */ }
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
      var labelEl = launch.querySelector(".btc-ai-launch-label");
      if (labelEl) labelEl.textContent = t.open;
      if (!launchSeen && aiTip) aiTip.textContent = t.aiTip;
      titleEl.textContent = t.title;
      subEl.textContent = t.subtitle;
      input.placeholder = t.placeholder;
      sendBtn.textContent = busy ? t.sending : t.send;
      closeBtn.textContent = t.close;
      setToolLabel("new", t.newChat, t.newChatTip);
      setToolLabel("history", t.historyBtn, t.historyTip);
      setToolLabel("shot", t.shotBtn, t.shotTip);
      if (zoomOutBtn) zoomOutBtn.title = t.zoomOut;
      if (zoomInBtn) zoomInBtn.title = t.zoomIn;
      if (zoomVal) zoomVal.title = t.zoomResetTip;
      applyFontScale();
      updateConvBadge();
      if (convMenu && !convMenu.hidden) renderConvMenu();
      noteEl.textContent = t.disclaimer;
      if (modelTag) modelTag.title = configured ? t.modelPick : t.notConfigured;
      if (modelMenu && !modelMenu.hidden) renderModelMenu();
      if (styleMenu && !styleMenu.hidden) renderStyleMenu();
      applyModeLabel();
      applyStyleLabel();
      applyWebLabel();
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
    // 联网检索开关：显示当前状态（青色=开），点一下切换并记在本地浏览器。
    // Web-search toggle: shows the current state (cyan = on); click flips it and persists locally.
    function applyWebLabel() {
      if (!webBtn) return;
      webBtn.textContent = webEnabled ? t.webOn : t.webOff;
      webBtn.setAttribute("data-on", webEnabled ? "true" : "false");
      webBtn.title = webEnabled ? t.webTipOn : t.webTipOff;
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

    // ================= 对话管理 / Conversation management =================
    // 工具条按钮上的文字＋悬停说明由这里统一刷新（语言切换后也会走一遍）。
    // Label + tooltip for a tool-row button; refreshed on language switches too.
    function setToolLabel(act, label, tip) {
      var btn = panel.querySelector('[data-act="' + act + '"]');
      if (!btn) return;
      var span = btn.querySelector(".btc-ai-tool-label");
      if (span) span.textContent = label;
      if (tip) btn.title = tip;
    }
    function convUid() {
      convSeq += 1;
      return Date.now().toString(36) + "-" + convSeq.toString(36);
    }
    // 读盘时逐项校验，坏数据直接丢掉，避免一段脏记录把整个面板卡死。
    // Validate on read and drop junk, so one bad record cannot wedge the whole panel.
    function readConvs() {
      var raw = null;
      try { raw = JSON.parse(localStorage.getItem(CONV_KEY) || "[]"); } catch (e) { return []; }
      if (!Array.isArray(raw)) return [];
      return raw.filter(function (c) {
        return c && typeof c.id === "string" && Array.isArray(c.msgs);
      }).map(function (c) {
        return {
          id: c.id,
          createdAt: Number(c.createdAt) || Date.now(),
          updatedAt: Number(c.updatedAt) || Date.now(),
          title: typeof c.title === "string" ? c.title : "",
          msgs: c.msgs.filter(function (m) {
            return m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string";
          }).map(function (m) {
            return { role: m.role, content: m.content, ts: Number(m.ts) || Date.now(), search: m.search || null };
          })
        };
      }).slice(0, CONV_MAX);
    }
    // 落盘：配额满时先砍最旧的对话，再逐次压缩单条消息，最后放弃并静默（不能因为存不下就打断聊天）。
    // Persist: when over quota, drop the oldest chat first, then shrink messages, and finally give up quietly.
    function writeConvs() {
      for (var attempt = 0; attempt < 4; attempt += 1) {
        try {
          localStorage.setItem(CONV_KEY, JSON.stringify(convList.slice(0, CONV_MAX)));
          return true;
        } catch (e) {
          if (convList.length > 1) { convList = convList.slice(0, convList.length - 1); continue; }
          MSG_CHAR_MAX = Math.max(1500, Math.floor(MSG_CHAR_MAX / 2));
          convList.forEach(function (c) {
            c.msgs.forEach(function (m) {
              if (m.content.length > MSG_CHAR_MAX) m.content = m.content.slice(0, MSG_CHAR_MAX);
            });
          });
        }
      }
      return false;
    }
    function convTitle(msgs) {
      var first = msgs.filter(function (m) { return m.role === "user"; })[0];
      if (!first) return t.newChat;
      var text = String(first.content).replace(/\s+/g, " ").trim();
      return text.length > 26 ? text.slice(0, 26) + "…" : text;
    }
    // 联网回执只留图上要用的字段，避免把整包检索结果塞进本地存储。
    // Keep only the fields the transcript renders, so the stored record stays small.
    function slimSearch(info) {
      if (!info || !info.enabled) return null;
      return {
        enabled: true,
        count: info.count || 0,
        sources: (info.sources || []).slice(0, 6),
        headlines: (info.headlines || []).slice(0, 4),
        cached: Boolean(info.cached),
        elapsedMs: info.elapsedMs || 0
      };
    }
    // 把当前对话写回 convList（最新的排最前）；一句都没问过的空对话不落盘，免得历史里堆空壳。
    // Upsert the active conversation (newest first); an empty chat is not stored at all.
    function persistCurrent() {
      if (!convId) convId = convUid();
      var cleaned = convMsgs
        .filter(function (m) { return !m.failed; })
        .map(function (m) {
          var out = { role: m.role, content: String(m.content || "").slice(0, MSG_CHAR_MAX), ts: m.ts || Date.now() };
          if (m.role === "assistant" && m.search) out.search = m.search;
          return out;
        })
        .slice(-CONV_MSG_MAX);
      convList = convList.filter(function (c) { return c.id !== convId; });
      if (cleaned.some(function (m) { return m.role === "user"; })) {
        convList.unshift({
          id: convId,
          createdAt: convCreatedAt || Date.now(),
          updatedAt: Date.now(),
          title: convTitle(cleaned),
          msgs: cleaned
        });
      }
      writeConvs();
      try { localStorage.setItem(ACTIVE_KEY, convId); } catch (e) { /* 隐私模式 / private mode */ }
      updateConvBadge();
    }
    // 送给服务端的多轮上下文：同一段对话里所有成功的问答（失败的提问会被剔除）。
    // Multi-turn context sent upstream: every successful turn, failed ones filtered out.
    function apiHistory() {
      return convMsgs
        .filter(function (m) { return (m.role === "user" || m.role === "assistant") && !m.failed && m.content; })
        .map(function (m) { return { role: m.role, content: m.content }; })
        .slice(0, -1); // 最后一条就是本轮提问，服务端会单独拼上去 / the current question is appended server-side
    }
    function updateConvBadge() {
      if (!historyBadge) return;
      var others = convList.filter(function (c) {
        return c.id !== convId && c.msgs.some(function (m) { return m.role === "user"; });
      }).length;
      historyBadge.textContent = t.historyBadge.replace("{n}", String(others));
      historyBadge.hidden = others === 0;
      if (historyBtn) historyBtn.setAttribute("data-active", convMenu && !convMenu.hidden ? "true" : "false");
    }
    // 回放一段对话：把存储里的消息重新渲染成气泡（含联网回执）。
    // Replay a conversation: re-render the stored messages as bubbles, receipts included.
    function renderConversation() {
      log.innerHTML = "";
      if (!convMsgs.length) { addMessage("bot", t.greeting); return; }
      convMsgs.forEach(function (m) {
        var node = addMessage(m.role === "user" ? "user" : "bot", m.content);
        if (m.role === "assistant" && m.search) {
          var receipt = buildSearchReceipt(m.search);
          if (receipt) node.appendChild(receipt);
        }
      });
      log.scrollTop = log.scrollHeight;
    }
    // 新建对话：先把当前这段归档，再开一段干净的（带问候语）。
    // New chat: archive the current one first, then start a clean one with the greeting.
    function newConversation() {
      var had = convMsgs.some(function (m) { return m.role === "user"; });
      persistCurrent();
      closeOverlays(false);
      convId = convUid();
      convCreatedAt = Date.now();
      convMsgs = [];
      try { localStorage.setItem(ACTIVE_KEY, convId); } catch (e) { /* 隐私模式 / private mode */ }
      log.innerHTML = "";
      addMessage("bot", t.greeting);
      updateConvBadge();
      if (had) flashStatus(t.newChatDone);
      input.focus();
    }
    // 切回历史对话：上下文（含失败剔除后的问答）整体恢复，可继续追问。
    // Reopen a saved chat: the whole context comes back so the user can just keep asking.
    function switchConversation(id) {
      if (!id) return;
      if (id === convId) { toggleConvMenu(false); return; }
      persistCurrent();
      var target = convList.filter(function (c) { return c.id === id; })[0];
      if (!target) return;
      convId = target.id;
      convCreatedAt = target.createdAt || Date.now();
      convMsgs = target.msgs.map(function (m) {
        return { role: m.role, content: m.content, ts: m.ts, search: m.search || null };
      });
      try { localStorage.setItem(ACTIVE_KEY, convId); } catch (e) { /* 隐私模式 / private mode */ }
      renderConversation();
      updateConvBadge();
      toggleConvMenu(false);
      flashStatus(t.historyRestored.replace("{n}", String(convMsgs.length)));
      input.focus();
    }
    // 开机恢复：读回本地记录，优先接回上次那段对话；没有记录返回 false（调用方开新对话）。
    // Boot restore: read local records and reopen the last chat; return false when there is none.
    function restoreConversation() {
      convList = readConvs();
      var savedId = "";
      try { savedId = localStorage.getItem(ACTIVE_KEY) || ""; } catch (e) { savedId = ""; }
      var target = convList.filter(function (c) { return c.id === savedId; })[0] || convList[0];
      if (!target) return false;
      convId = target.id;
      convCreatedAt = target.createdAt || Date.now();
      convMsgs = target.msgs.map(function (m) {
        return { role: m.role, content: m.content, ts: m.ts, search: m.search || null };
      });
      // 字号也是本地记忆，恢复对话时一并套用。
      // Text size is remembered too; apply it while restoring.
      try {
        var savedScale = parseFloat(localStorage.getItem("btc_ai_font_scale") || "1");
        if (FONT_STEPS.indexOf(savedScale) >= 0) fontScale = savedScale;
      } catch (e) { /* 隐私模式 / private mode */ }
      renderConversation();
      updateConvBadge();
      return true;
    }
    function deleteConversation(id) {
      var wasActive = id === convId;
      convList = convList.filter(function (c) { return c.id !== id; });
      writeConvs();
      if (wasActive) {
        convId = convUid();
        convCreatedAt = Date.now();
        convMsgs = [];
        log.innerHTML = "";
        addMessage("bot", t.greeting);
        try { localStorage.setItem(ACTIVE_KEY, convId); } catch (e) { /* 隐私模式 / private mode */ }
      }
      updateConvBadge();
      renderConvMenu();
    }
    function formatConvTime(ts) {
      var d = new Date(ts);
      if (Number.isNaN(d.getTime())) return "—";
      var pad = function (n) { return String(n).padStart(2, "0"); };
      return (d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
    }
    function renderConvMenu() {
      if (!convMenu) return;
      convMenu.innerHTML = "";
      var head = document.createElement("h4");
      head.textContent = t.historyTitle;
      var hint = document.createElement("p");
      hint.className = "btc-ai-models-hint";
      hint.textContent = t.historyHint;
      convMenu.append(head, hint);
      if (!convList.length) {
        var empty = document.createElement("p");
        empty.className = "btc-ai-models-hint";
        empty.textContent = t.historyEmpty;
        convMenu.appendChild(empty);
        return;
      }
      convList.forEach(function (conv) {
        var row = document.createElement("div");
        row.className = "btc-ai-conv-row";
        row.setAttribute("role", "button");
        row.tabIndex = 0;
        if (conv.id === convId) row.setAttribute("aria-current", "true");

        var body = document.createElement("span");
        body.className = "btc-ai-conv-body";
        var title = document.createElement("span");
        title.className = "btc-ai-conv-title";
        title.textContent = conv.title || t.newChat;
        var meta = document.createElement("span");
        meta.className = "btc-ai-conv-meta";
        meta.textContent = t.historyMeta
          .replace("{n}", String(conv.msgs.length))
          .replace("{t}", formatConvTime(conv.updatedAt));
        body.append(title, meta);
        if (conv.id === convId) {
          var now = document.createElement("span");
          now.className = "btc-ai-conv-now";
          now.textContent = t.historyCurrent;
          meta.appendChild(document.createTextNode(" · "));
          meta.appendChild(now);
        }
        row.appendChild(body);

        // 右侧的「›」是给用户看的可点进提示：这一行是能点开的。
        // The trailing chevron is the affordance that tells the user this row is clickable.
        var go = document.createElement("span");
        go.className = "btc-ai-conv-go";
        go.textContent = "›";
        row.appendChild(go);
        if (conv.id !== convId) row.title = t.historyOpen;

        var del = document.createElement("button");
        del.type = "button";
        del.className = "btc-ai-conv-del";
        del.textContent = "×";
        del.title = t.historyDelete;
        del.onclick = function (event) { event.stopPropagation(); deleteConversation(conv.id); };
        row.appendChild(del);

        row.onclick = function () { switchConversation(conv.id); };
        row.onkeydown = function (event) {
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); switchConversation(conv.id); }
        };
        convMenu.appendChild(row);
      });
      var foot = document.createElement("p");
      foot.className = "btc-ai-models-hint";
      foot.style.marginTop = "6px";
      foot.textContent = t.historyLimit.replace("{n}", String(CONV_MAX));
      convMenu.appendChild(foot);
    }
    function toggleConvMenu(force) {
      if (!convMenu || !historyBtn) return;
      var open = typeof force === "boolean" ? force : convMenu.hidden;
      if (open) {
        // 打开前先落一次盘，当前这段才能带着最新内容出现在列表顶部。
        // Persist first so the active chat shows up at the top with its latest content.
        persistCurrent();
        toggleModelMenu(false);
        toggleStyleMenu(false);
        // 浮层要落在工具条下方：高度随视口/字号变化，所以每次打开都实测一次位置。
        // Park the overlay right below the tool row; measure every time since the row can wrap.
        convMenu.style.top = ((toolsEl ? toolsEl.offsetTop + toolsEl.offsetHeight : 96) + 6) + "px";
      }
      convMenu.hidden = !open;
      historyBtn.setAttribute("data-active", open ? "true" : "false");
      if (open) renderConvMenu();
    }
    // 点面板其它地方时收起所有浮层；withPanel=false 表示只收浮层、不动面板本身。
    // Close every overlay on outside clicks; withPanel=false keeps the panel itself open.
    function closeOverlays(withPanel) {
      toggleModelMenu(false);
      toggleStyleMenu(false);
      toggleConvMenu(false);
      if (withPanel) panel.hidden = true;
    }

    // ================= 字号缩放 / Text zoom =================
    function applyFontScale() {
      panel.style.setProperty("--ai-fs", String(fontScale));
      if (zoomVal) zoomVal.textContent = Math.round(fontScale * 100) + "%";
    }
    function setFontScale(value) {
      fontScale = value;
      if (FONT_STEPS.indexOf(fontScale) < 0) fontScale = 1;
      applyFontScale();
      try { localStorage.setItem("btc_ai_font_scale", String(fontScale)); } catch (e) { /* 隐私模式 / private mode */ }
    }
    function zoomStep(direction) {
      var index = FONT_STEPS.indexOf(fontScale);
      if (index < 0) index = FONT_STEPS.indexOf(1);
      var next = Math.max(0, Math.min(FONT_STEPS.length - 1, index + direction));
      if (FONT_STEPS[next] === fontScale) return;
      setFontScale(FONT_STEPS[next]);
    }

    // ================= 长截图 / Long screenshot =================
    // 不依赖任何外部库：克隆对话 DOM → 套上本站注入的聊天样式 → 塞进 SVG <foreignObject> →
    // 画到 canvas 导出 PNG。顺带把整段对话复制进剪贴板，能直接粘到聊天窗口里。
    // No third-party library: clone the transcript, wrap it in the site's own chat CSS inside an SVG
    // <foreignObject>, rasterise to a canvas, then download the PNG and try to copy it too.
    var SHOT_VARS = ["--bg-base","--bg-surface","--bg-surface-2","--bg-elevated","--border-subtle","--border-strong","--bull","--bear","--warn","--accent-cyan","--accent-orange","--accent-purple","--text-primary","--text-secondary","--text-muted"];
    function shotThemeVars() {
      // 主题变量按页面当前的实际取值抄一份，导出图才和屏幕一致；取不到就回落到深色默认值。
      // Copy the live theme variables so the export matches the screen; fall back to the dark defaults.
      var computed = window.getComputedStyle(panel);
      var out = ":root{";
      SHOT_VARS.forEach(function (name) {
        var value = (computed.getPropertyValue(name) || "").trim();
        if (value) out += name + ":" + value + ";";
      });
      return out + "}";
    }
    function shotHost() {
      var host = document.getElementById("btc-ai-shot-host");
      if (!host) {
        host = document.createElement("div");
        host.id = "btc-ai-shot-host";
        host.setAttribute("aria-hidden", "true");
        document.body.appendChild(host);
      }
      return host;
    }
    function shotStamp() {
      var d = new Date();
      var pad = function (n) { return String(n).padStart(2, "0"); };
      return {
        file: String(d.getFullYear()) + pad(d.getMonth() + 1) + pad(d.getDate()) + "-" + pad(d.getHours()) + pad(d.getMinutes()),
        text: formatTimestamp(d.toISOString())
      };
    }
    function buildShot() {
      var bubbles = [];
      Array.prototype.forEach.call(log.querySelectorAll(".btc-ai-msg"), function (node) {
        var clone = node.cloneNode(true);
        // 流式光标与「正在连接」这类瞬时状态不进图。
        // Drop the streaming caret and transient status text.
        Array.prototype.forEach.call(clone.querySelectorAll(".btc-ai-caret,.btc-ai-status"), function (n) { n.remove(); });
        if (!clone.textContent.replace(/\s+/g, "")) return;
        bubbles.push(clone.outerHTML);
      });
      if (!bubbles.length) return null;
      var width = Math.max(420, Math.min(760, Math.round(log.clientWidth || 430)));
      var stamp = shotStamp();
      var meta = [t.subtitle, stamp.text, model].filter(Boolean).join(" · ");
      var host = shotHost();
      host.innerHTML = "";
      var wrap = document.createElement("div");
      wrap.id = "btc-ai-shot";
      wrap.style.width = width + "px";
      wrap.style.setProperty("--ai-fs", String(fontScale));
      // 把面板上的 CSS 变量（配色 / 字号基准等）搬到导出容器，克隆出来的气泡才能拿到正确的颜色。
      // Copy the panel's CSS custom properties onto the export wrapper so cloned bubbles keep their palette.
      try {
        var panelVars = window.getComputedStyle(panel);
        for (var vi = 0; vi < panelVars.length; vi++) {
          var vname = panelVars[vi];
          if (vname && vname.indexOf("--") === 0) {
            var vval = panelVars.getPropertyValue(vname);
            if (vval) wrap.style.setProperty(vname, vval);
          }
        }
      } catch (e) { /* 拿不到变量也不影响导出 / ignore, fallbacks cover it */ }
      wrap.innerHTML =
        '<div class="btc-ai-shot-head"><h1>' + escapeHtml(t.title) + "</h1><p>" +
        escapeHtml(meta) + " · " + escapeHtml(t.shotCount.replace("{n}", String(bubbles.length))) +
        "</p></div>" +
        '<div class="btc-ai-shot-body">' + bubbles.join("") + "</div>" +
        '<div class="btc-ai-shot-foot">' + escapeHtml(t.exportFoot) + "</div>";
      // 留在 DOM 里交给 html2canvas 量尺并栅格化（不走 foreignObject，否则画布会被 Chromium 判为污染而无法导出）。
      // Keep it in the DOM for html2canvas to measure and rasterize — no foreignObject, so the canvas stays untainted.
      host.appendChild(wrap);
      var height = Math.ceil(wrap.getBoundingClientRect().height) + 8;
      return { width: width, height: height, el: wrap };
    }
    function downloadBlob(blob, name) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    }
    function copyShot(blob, w, h) {
      var finish = function (copied) {
        var line = copied ? t.shotCopied : t.shotDone;
        flashStatus(line.replace("{w}", String(w)).replace("{h}", String(h)));
      };
      try {
        if (navigator.clipboard && window.ClipboardItem && window.isSecureContext) {
          navigator.clipboard.write([new window.ClipboardItem({ "image/png": blob })])
            .then(function () { finish(true); })
            .catch(function () { finish(false); });
          return;
        }
      } catch (e) { /* 剪贴板不可用就走「只下载」/ clipboard unavailable: download only */ }
      finish(false);
    }
    function shootLong() {
      if (shotBusy) return;
      var built = buildShot();
      if (!built) { flashStatus(t.shotEmpty); return; }
      if (typeof window.html2canvas !== "function") { flashStatus(t.shotFail); return; }
      shotBusy = true;
      flashStatus(t.shotWorking);
      // 长对话按 2 倍导出可能撞上 canvas 尺寸上限，超了就自动降倍率。
      // A very long chat can hit the canvas size ceiling at 2x, so scale down when needed.
      var scale = 2;
      if (built.height * scale > 16000) scale = Math.max(1, 16000 / built.height);
      var bg = (window.getComputedStyle(panel).getPropertyValue("--bg-surface") || "#161a20").trim() || "#161a20";
      // html2canvas 是逐节点手动重绘，画布不会被判为污染，toBlob 可以正常导出（foreignObject 方案会被 Chromium 直接判污染）。
      // html2canvas repaints node-by-node, so the canvas stays clean and toBlob works (the foreignObject path is tainted by Chromium).
      var cleanup = function () { var h = document.getElementById("btc-ai-shot-host"); if (h) h.innerHTML = ""; };
      try {
        window.html2canvas(built.el, {
          backgroundColor: bg,
          scale: scale,
          width: built.width,
          height: built.height,
          windowWidth: built.width,
          logging: false,
          useCORS: false
        }).then(function (canvas) {
          if (!canvas) { shotBusy = false; cleanup(); flashStatus(t.shotFail); return; }
          canvas.toBlob(function (result) {
            shotBusy = false;
            cleanup();
            if (!result) { flashStatus(t.shotFail); return; }
            downloadBlob(result, "btc-ai-chat-" + shotStamp().file + ".png");
            copyShot(result, canvas.width, canvas.height);
          }, "image/png");
        }).catch(function () {
          shotBusy = false; cleanup(); flashStatus(t.shotFail);
        });
      } catch (e) {
        shotBusy = false; cleanup(); flashStatus(t.shotFail);
      }
    }
    // 状态行：临时借用底部免责声明那一行，几秒后自动回到原文案。
    // Status line: borrows the disclaimer row for a few seconds, then restores it.
    var noteTimer = null;
    function flashStatus(text) {
      if (!text || !noteEl) return;
      noteEl.textContent = text;
      noteEl.classList.add("btc-ai-note-flash");
      clearTimeout(noteTimer);
      noteTimer = setTimeout(function () {
        noteEl.classList.remove("btc-ai-note-flash");
        noteEl.textContent = t.disclaimer;
      }, 5200);
    }

    function addMessage(role, text) {
      var node = document.createElement("div");
      node.className = "btc-ai-msg " + role;
      node.innerHTML = renderRich(text);
      log.appendChild(node);
      log.scrollTop = log.scrollHeight;
      return node;
    }

    // 联网检索来源回执：贴在回答末尾，列出条数 / 来源 / 耗时与抓取到的外部标题。
    // Source receipt for web research: pinned under the answer, listing count / outlets / latency and the headlines.
    function buildSearchReceipt(info) {
      if (!info || !info.enabled) return null;
      var box = document.createElement("div");
      box.className = "btc-ai-src";
      var srcs = Array.isArray(info.sources) ? info.sources : [];
      var srcText = srcs.length ? srcs.slice(0, 6).join(" · ") : "—";
      var head = document.createElement("div");
      if (info.count > 0) {
        var line = info.cached ? t.webReceiptCached : t.webReceipt;
        line = line.replace("{n}", String(info.count)).replace("{src}", srcText).replace("{ms}", String(info.elapsedMs || 0));
        head.textContent = line;
      } else {
        head.textContent = t.webOffNote;
      }
      box.appendChild(head);
      var heads = Array.isArray(info.headlines) ? info.headlines : [];
      if (heads.length) {
        var cap = document.createElement("div");
        cap.textContent = t.webHeadlines;
        cap.style.marginTop = "4px";
        box.appendChild(cap);
        var ul = document.createElement("ul");
        heads.forEach(function (h) {
          var li = document.createElement("li");
          li.textContent = h;
          ul.appendChild(li);
        });
        box.appendChild(ul);
      }
      return box;
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
        configured = Boolean(payload.available);
        launch.hidden = !configured;
        if (!configured) panel.hidden = true;
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
      } catch (error) {
        configured = false;
        launch.hidden = true;
        panel.hidden = true;
      }
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

    // 采集页面上下文：用户手填的持仓（window.btcPersonalEntries，app.js 维护）
    // 加信号面板的可见文本（规则信号卡 / 方向研究估算）。
    // Collect page context: the user-entered positions plus the signal panels' visible text.
    function collectPageContext() {
      var positions = [];
      try {
        var entries = window.btcPersonalEntries;
        if (Array.isArray(entries)) {
          entries.forEach(function (entry) {
            var price = Number(entry && entry.price);
            if (!(price > 0)) return;
            var leverage = Number(entry.leverage);
            var amount = Number(entry.amount);
            var margin = Number(entry.margin);
            positions.push({
              side: entry.side === "short" ? "short" : "long",
              entryPrice: price,
              sizeUsd: amount > 0 ? amount : null,
              marginUsd: margin > 0 ? margin : null,
              leverage: leverage > 0 ? leverage : null
            });
          });
        }
      } catch (e) { /* app.js 未就绪时忽略 / app.js may not be ready */ }
      var pickText = function (selector, limit) {
        try {
          var el = document.querySelector(selector);
          var text = el && el.innerText ? el.innerText.replace(/\s+/g, " ").trim() : "";
          return text ? text.slice(0, limit) : null;
        } catch (e) { return null; }
      };
      var pageSignals = {};
      var ruleSignal = pickText("#ruleSignalCard", 500);
      if (ruleSignal) pageSignals.ruleSignal = ruleSignal;
      var projection = pickText(".signal-projection", 400);
      if (projection) pageSignals.directionalEstimate = projection;
      return {
        positions: positions.slice(0, 2),
        pageSignals: Object.keys(pageSignals).length ? pageSignals : null
      };
    }

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
      convMsgs.push({ role: "user", content: question, ts: Date.now() });
      setBusy(true);
      var botNode = addMessage("bot", "");
      var caret = document.createElement("span");
      caret.className = "btc-ai-caret";
      botNode.appendChild(caret);
      var full = "";
      // 联网检索回执：流式期间服务端会推一个 search 事件，存下来留待回答完成后渲染来源清单。
      // Web-search receipt: the server streams a `search` event; stash it and render the source list after the answer.
      var searchInfo = null;
      // 采集一次页面上下文（持仓 + 信号面板），随本次提问一起发送。
      // Collect page context once (positions + signal panels) for this question.
      var pageContext = collectPageContext();
      // 等待期间给用户可见的进度：先提示"已连接"，深度模式再显示推理进度。
      // Give the user visible progress while waiting: connection notice, then reasoning progress.
      var statusNode = document.createElement("span");
      statusNode.className = "btc-ai-status";
      statusNode.textContent = pageContext && pageContext.positions.length ? t.connectedWithPosition : t.connected;
      botNode.appendChild(statusNode);

      try {
        var response = await fetch("/api/ai/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ question: question, history: apiHistory(), stream: true, lang: currentLang(), thinking: thinking, style: answerStyle, search: webEnabled, context: pageContext || collectPageContext() })
        });
        var type = response.headers.get("content-type") || "";
        if (!response.ok) {
          var errBody = await response.json().catch(function () { return {}; });
          throw new Error(errBody.error || t.askAgain);
        }
        if (type.indexOf("application/json") >= 0) {
          var data = await response.json();
          full = data.content || "";
          if (data.search) searchInfo = data.search;
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
              // 联网检索回执：先把状态从「已连接」切到「检索到 N 条 / 没取到」，等正文开始后再被移除。
              // Web-search receipt: swap the "connected" status for "found N / none", removed once the answer starts.
              if (parsed.search) {
                searchInfo = parsed.search;
                if (searchInfo.enabled) {
                  statusNode.textContent = searchInfo.count > 0
                    ? t.webFound.replace("{n}", String(searchInfo.count))
                    : t.webNone;
                }
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
        // 这一轮问答落进当前对话并立刻存盘：切到别的对话、甚至刷新页面都不会丢上下文。
        // Store the finished turn and persist right away, so switching chats or reloading keeps it.
        convMsgs.push({ role: "assistant", content: full, ts: Date.now(), search: slimSearch(searchInfo) });
        persistCurrent();
        // 成功拿到回答后立即拉一次最新额度（含响应头 + 本地累加），不等轮询。
        // Refresh quota immediately after a successful answer; don't wait for the next tick.
        loadQuota();
      } catch (error) {
        botNode.remove();
        addMessage("error", error.message || t.askAgain);
        // 失败的提问剔出上下文，避免下一次回答被半截问题带偏。
        // A failed turn stays out of the context so the next answer is not skewed by it.
        if (convMsgs.length && convMsgs[convMsgs.length - 1].role === "user") convMsgs.pop();
      } finally {
        botNode.innerHTML = renderRich(full || "…");
        var receipt = buildSearchReceipt(searchInfo);
        if (receipt && full) botNode.appendChild(receipt);
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
    // 联网检索开关：不影响已开的浮层，切换对下一条提问立即生效。
    // Web-search toggle: doesn't disturb open overlays; applies from the next question on.
    if (webBtn) webBtn.onclick = function (event) {
      event.stopPropagation();
      toggleStyleMenu(false);
      toggleModelMenu(false);
      webEnabled = !webEnabled;
      try { localStorage.setItem("btc_ai_web", webEnabled ? "1" : "0"); } catch (e) { /* 忽略存储失败 / ignore storage failures */ }
      applyWebLabel();
      input.focus();
    };
    // 点面板内其它区域或页面空白处收起浮层；点面板外部则直接关闭整个聊天窗。
    // Clicking anywhere else dismisses the overlays; a click outside the panel closes it.
    document.addEventListener("click", function (event) {
      toggleModelMenu(false);
      toggleStyleMenu(false);
      toggleConvMenu(false);
      if (!panel.hidden && !panel.contains(event.target) && event.target !== launch && !launch.contains(event.target)) {
        panel.hidden = true;
      }
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
    closeBtn.onclick = function () { panel.hidden = true; };
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !panel.hidden) closeOverlays(true);
    });
    // ---------- 工具条：新建 / 历史 / 字号 / 长截图 ----------
    // Tool row: new chat, history, text size, long screenshot.
    if (newBtn) newBtn.onclick = function () { newConversation(); };
    // 必须 stopPropagation：否则这一次点击继续冒泡到 document，
    // 被「点别处收起浮层」那条监听立刻把刚打开的历史列表关掉（表现为点了没反应）。
    // Must stop propagation: otherwise this very click bubbles to the document-level
    // dismiss handler, which instantly closes the list we just opened.
    if (historyBtn) historyBtn.onclick = function (event) { event.stopPropagation(); toggleConvMenu(); };
    if (zoomOutBtn) zoomOutBtn.onclick = function () { zoomStep(-1); input.focus(); };
    if (zoomInBtn) zoomInBtn.onclick = function () { zoomStep(1); input.focus(); };
    if (zoomVal) zoomVal.onclick = function () { setFontScale(1); input.focus(); };
    if (shotBtn) shotBtn.onclick = function () { shootLong(); };
    // 历史浮层内部的点击不冒泡到「点别处收起」，否则删一条就整层关掉。
    // Clicks inside the history overlay must not bubble to the dismiss handler.
    if (convMenu) convMenu.onclick = function (event) { event.stopPropagation(); };
    // 快捷键：⌘/Ctrl + = − 0 缩放正文字号（只在面板打开时生效，不动页面本身）。
    // Shortcuts: Cmd/Ctrl + = − 0 resize the transcript text while the panel is open.
    document.addEventListener("keydown", function (event) {
      if (panel.hidden || !(event.metaKey || event.ctrlKey)) return;
      if (event.key === "=" || event.key === "+") { event.preventDefault(); zoomStep(1); }
      else if (event.key === "-" || event.key === "_") { event.preventDefault(); zoomStep(-1); }
      else if (event.key === "0") { event.preventDefault(); setFontScale(1); }
    });
    launch.onclick = function () {
      if (Date.now() - lastDragAt < 350) return; // 拖动结束后紧跟的那次点击不触发开合
      panel.hidden = !panel.hidden;
      if (!panel.hidden) {
        placePanel(); // 先定位再显示内容，避免在右下角闪一下
        markLaunchSeen();
        if (!log.childElementCount) addMessage("bot", t.greeting);
        loadConfig();
        loadQuota();
        input.focus();
      }
    };

    applyLabels();
    // 开机先接回上次那段对话（本地有记录就带着上下文继续）；没有记录才开一段新的。
    // Reopen the last conversation on boot so the context survives a reload; start fresh if none.
    if (!restoreConversation()) {
      convId = convUid();
      convCreatedAt = Date.now();
      addMessage("bot", t.greeting);
      try { localStorage.setItem(ACTIVE_KEY, convId); } catch (e) { /* 隐私模式 / private mode */ }
    }
    applyFontScale();
    updateConvBadge();
    loadConfig();
    loadQuota();
    window.addEventListener("btc:ai-credential-changed", function () { loadConfig(); });
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
