/* 消息推送模块（v2.10.52 自 app.js 拆分为独立文件；v2.10.54 UI/交互重构，仿 8899 分渠道交互）。
 *
 * 职责：
 *  1. 消息推送卡片：总开关 + 右侧「推送设置」入口；总开关打开时正文只展示
 *     推送规则（明确标注币种对 BTC/USDT，为未来多币种预留），关闭时正文收起；
 *  2. 推送设置弹层：仿 Apple 补货监控（8899）的分渠道交互 —— 每个渠道一个
 *     独立开关，打开后展开表单填写 API Key，点「确认并验证」真实发送测试
 *     消息，验证通过后输入框自动收起，只留「重新编辑」；徽章状态
 *     已验证(绿) / 验证失败(红) / 待验证(黄) / 未验证(灰)；
 *  3. 未登录的本机模式：仅 Server酱 一条链路（SendKey 只存在当前会话，
 *     AES-GCM 落 IndexedDB），其余渠道显示「登录后可用」；
 *  4. 云端模式：渠道与设置加密保存到服务端，网页关闭后由 alert-worker
 *     持续监测并逐渠道投递。
 *
 * 由 app.js 注入依赖并调用 BTCNotification.init({ $, tx, showAppDialog, getLang, getState })。
 * 渠道类型注册表与 notification.mjs 保持同构（新增渠道类型时两处同步）。 */
window.BTCNotification = {
  init(ctx) {
    const { $, tx, showAppDialog } = ctx,
      getLang = ctx.getLang || (() => "zh"),
      getState = ctx.getState || (() => null);

    // ---- 渠道类型注册表（与 notification.mjs 同构） ----
    const CHANNEL_DEFS = {
      serverchan: {
        label: tx("Server酱（微信）", "ServerChan (WeChat)"),
        hint: tx("在 sct.ftqq.com 获取 SendKey，推送到微信「Server酱」服务号。", "Get a SendKey at sct.ftqq.com; pushes arrive in WeChat."),
        fields: [{ key: "sendKey", label: "SendKey", type: "password", placeholder: "SCT…", required: true, secret: true }],
        summary: (c) => `${c.sendKey || ""}`,
      },
      bark: {
        label: tx("Bark（iOS 推送）", "Bark (iOS push)"),
        hint: tx("iOS 安装 Bark App 后复制推送 URL；自建服务器可修改推送地址。", "Install the Bark app on iOS and copy its push URL; change the server for self-hosting."),
        fields: [
          { key: "serverUrl", label: tx("推送地址", "Server URL"), type: "text", placeholder: "https://api.day.app", required: false },
          { key: "deviceKey", label: tx("设备 Key", "Device key"), type: "password", placeholder: tx("Bark 推送 URL 中的 Key", "Key from the Bark push URL"), required: true, secret: true },
        ],
        summary: (c) => `${c.serverUrl || "https://api.day.app"} · ${c.deviceKey || ""}`,
      },
      feishu: {
        label: tx("飞书自定义机器人", "Feishu custom bot"),
        hint: tx("飞书群 → 设置 → 群机器人 → 添加「自定义机器人」，复制 Webhook 地址；开了签名校验就同时填密钥。", "Feishu group → Settings → Group bot → Custom bot; paste the webhook URL (and secret if signing is on)."),
        fields: [
          { key: "webhookUrl", label: "Webhook", type: "text", placeholder: "https://open.feishu.cn/open-apis/bot/v2/hook/…", required: true },
          { key: "secret", label: tx("签名密钥（可选）", "Signing secret (optional)"), type: "password", placeholder: "", required: false, secret: true },
        ],
        summary: (c) => c.webhookUrl || "",
      },
      dingtalk: {
        label: tx("钉钉自定义机器人", "DingTalk custom bot"),
        hint: tx("钉钉群 → 群设置 → 智能群助手 → 添加「自定义机器人」（安全设置选「加签」最简单）。", "DingTalk group → Settings → Group bot → Custom bot (signing is the simplest security option)."),
        fields: [
          { key: "webhookUrl", label: "Webhook", type: "text", placeholder: "https://oapi.dingtalk.com/robot/send?access_token=…", required: true },
          { key: "secret", label: tx("加签密钥（SEC 开头，可选）", "Signing secret (SEC…, optional)"), type: "password", placeholder: "SEC…", required: false, secret: true },
        ],
        summary: (c) => c.webhookUrl || "",
      },
      webhook: {
        label: tx("通用 Webhook", "Generic webhook"),
        hint: tx("向任意 HTTP 接口 POST JSON：{title, short, body, time}，适合 n8n / 自建网关 / 企业微信应用等。", "POSTs JSON {title, short, body, time} to any HTTP endpoint; ideal for n8n / custom gateways."),
        fields: [{ key: "url", label: "Webhook URL", type: "text", placeholder: "https://…", required: true }],
        summary: (c) => c.url || "",
      },
    };

      setTimeout(async () => {
        const old = $("wechatAlertCard");
        if (old) old.remove();
        const main = document.querySelector("main");
        if (!main) return;
        const keyStore = "btc_local_serverchan_sendkey_v1",
          ruleStore = "btc_local_notification_rules_v1"; // 仅 BTC 旧明文迁移用
        let previous = null,
          repeat = false,
          rules = [];

        // ── 多币种：本机推送/语音播报规则按币种隔离存储 ──
        // BTC 继续用旧 key "alerts"（保留历史数据）；其余币种各自 "alerts_<COIN>"。
        // 每个币种独立存取：默认空、已添加则保留、未添加则为无 —— 互不串台。
        const getCoin = ctx.getCoin || (() => (window.btcCoinContext && window.btcCoinContext.coin ? window.btcCoinContext.coin() : "BTC"));
        const vaultKeyFor = () => (getCoin() === "BTC" ? "alerts" : "alerts_" + getCoin());
        const coinPairPlain = () => (getCoin() === "BTC" ? "BTC/USDT" : getCoin() + "/USDT");
        const coinMark = () => (getCoin() === "BTC" ? "₿ " : "");

        const LOCAL_ONLY_KINDS = ["round_number", "custom_grid", "volatility"];
        const isValidRule = (x) =>
          x && x.id && (Number(x.targetPrice) > 0 || LOCAL_ONLY_KINDS.includes(x.kind) || Number(x.basePrice) > 0 || Number(x.step) > 0 || Number(x.windowMinutes) > 0);
        const sanitize = (arr) =>
          (Array.isArray(arr) ? arr : [])
            .filter(isValidRule)
            .slice(0, 30)
            .map((x) => ({
              ...x,
              kind: x.kind || "price_reached",
              repeat: x.repeat === false ? false : true,
              cooldownMinutes: Math.max(1, Number(x.cooldownMinutes) || 5),
              // 持久化新模式的评价状态，避免刷新/重载后重复触发或丢失进度
              step: Number.isFinite(Number(x.step)) ? Number(x.step) : undefined,
              basePrice: Number.isFinite(Number(x.basePrice)) ? Number(x.basePrice) : undefined,
              windowMinutes: Number.isFinite(Number(x.windowMinutes)) ? Number(x.windowMinutes) : undefined,
              threshold: Number.isFinite(Number(x.threshold)) ? Number(x.threshold) : undefined,
              direction: x.direction || "both",
              _roundLevel: Number.isFinite(Number(x._roundLevel)) ? Number(x._roundLevel) : undefined,
              _gridIdx: Number.isFinite(Number(x._gridIdx)) ? Number(x._gridIdx) : undefined,
            }));

        const loadRules = async () => {
          const key = vaultKeyFor();
          let arr = [];
          let sendKey = "";
          try {
            const saved = await window.btcSecureVault?.get(key);
            if (saved && Array.isArray(saved.rules)) arr = saved.rules;
            if (typeof saved?.sendKey === "string" && saved.sendKey) sendKey = saved.sendKey.trim();
          } catch {}
          // 仅 BTC 做一次旧明文迁移（其他币种本就无明文规则）
          if (getCoin() === "BTC") {
            try {
              const legacy = JSON.parse(localStorage.getItem(ruleStore) || "[]");
              if (Array.isArray(legacy) && legacy.length && !arr.length) arr = legacy;
              const lsk = localStorage.getItem(keyStore) || "";
              if (/^SCT/i.test(lsk)) {
                sessionStorage.setItem(keyStore, lsk);
                if (!sendKey) sendKey = lsk.trim();
              }
              localStorage.removeItem(ruleStore);
              localStorage.removeItem(keyStore);
            } catch {}
          }
          return { rules: sanitize(arr), sendKey };
        };

        const loaded = await loadRules();
        rules = loaded.rules;
        if (loaded.sendKey) sessionStorage.setItem(keyStore, loaded.sendKey);

        const save = () => { window.btcSecureVault?.put(vaultKeyFor(), { rules, sendKey: (sessionStorage.getItem(keyStore) || "").trim() }).catch((error) => console.warn("Local encrypted save failed:", error.message)); },
        price = () => getState()?.ticker?.last,
        fmt = (n) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 });

      // ---- 多渠道云端状态 ----
      let cloudSession = { loggedIn: false, hasSendKey: false };
      let cloudChannels = [];
      let pushSettings = {
        masterEnabled: true,
        lossPush: { enabled: false, warnRoe: 20, lossRoe: 50, cooldownMinutes: 30 },
      };
      const api = async (path, options) => {
        const response = await fetch(path, options);
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
        return payload;
      };
      const loadCloudState = async () => {
        if (!cloudSession.loggedIn) return;
        try {
          const [channels, settings] = await Promise.all([
            api("/api/alerts/channels"),
            api("/api/alerts/push-settings"),
          ]);
          cloudChannels = channels.channels || [];
          pushSettings = settings.settings || pushSettings;
        } catch (error) {
          console.warn("Push settings load failed:", error.message);
        }
      };
      const savePushSettings = async (patch) => {
        const payload = await api("/api/alerts/push-settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        });
        pushSettings = payload.settings || pushSettings;
      };

      const card = document.createElement("section");
      card.id = "wechatAlertCard";
      card.className = "card wechat-alert-card";
      /* v2.10.53 结构：标题行 → 总开关行（右侧「推送设置」入口）→ 推送规则区
         （总开关打开时才显示；云面板插槽由 cloud-alerts.js 注入）。 */
      card.innerHTML = `<div class="forecast-head"><div><h2>${tx("消息推送", "Message alerts")}</h2><p id="localAlertDescription"></p></div><span id="localAlertState" class="badge flat"></span></div>`
        + `<div class="push-head-row"><label class="push-switch push-switch-row"><input type="checkbox" id="pushMasterSwitch"><span>${tx("启用消息推送", "Enable push")}</span></label><small id="pushMasterHint"></small><button type="button" id="openPushSettings" class="push-settings-btn">⚙ ${tx("推送设置", "Settings")}</button></div>`
        + `<div id="pushMasterBody"><div class="alert-rule-toolbar"><b>${tx("推送规则", "Push rules")}<small>${coinMark()}${coinPairPlain()} · ${tx("永续", "Perpetual")}</small></b><div><button type="button" id="clearLocalAlerts" class="danger">${tx("批量全删", "Delete all")}</button><button type="button" id="openLocalAlert">＋ ${tx("添加预警", "Add alert")}</button></div></div><div id="localAlertList" class="wechat-alert-detail"></div>`
        + `<div id="lossPushSection" class="loss-push-box"><label class="push-switch push-switch-row"><input type="checkbox" id="lossPushEnabled"><span>${tx("亏损推送（联动持仓）", "Loss push (linked to positions)")}</span></label><div class="loss-push-fields"><label>${tx("警告 ROE ≤", "Warn ROE ≤")}<input id="lossWarnRoe" type="number" min="1" max="1000" step="1"></label><label>${tx("推送 ROE ≤", "Push ROE ≤")}<input id="lossLossRoe" type="number" min="1" max="1000" step="1"></label><label>${tx("冷却（分钟）", "Cooldown (min)")}<input id="lossCooldown" type="number" min="1" max="1440" step="1"></label><button type="button" id="lossPushSave">${tx("保存设置", "Save")}</button></div><small>${tx("以「我的持仓」中各笔持仓的保证金收益率（ROE = 价格变动% × 杠杆）计算；任一持仓触发即向所有启用渠道推送。", "Computed from each saved position's ROE (price move % × leverage); any position crossing a threshold pushes to all enabled channels.")}</small></div></div>`
        + `<div id="cloudAlertPanel" class="cloud-alert-panel"></div>`
        + `<div id="localAlertModal" class="alert-composer" hidden><section><header><b id="localAlertModalTitle">${tx("添加预警", "Add alert")}</b><button type="button" id="closeLocalAlert">×</button></header><p class="alert-symbol">${coinMark()}<b>${coinPairPlain()} ${tx("永续", "Perpetual")}</b></p><form id="localAlertForm"><label>${tx("推送模式", "Push mode")}<select name="mode"><option value="price">${tx("价格预警", "Price alert")}</option><option value="round_number">${tx("整数推送", "Round-number")}</option><option value="custom_grid">${tx("自定义推送", "Custom grid")}</option><option value="volatility">${tx("快速挣扎推送", "Volatility")}</option></select></label><div data-mode-fields="price"><label>${tx("预警类型", "Alert type")}<select name="kind"><option value="price_reached">${tx("价格达到", "Price reached")}</option><option value="price_above">${tx("价格上涨至", "Price rises to")}</option><option value="price_below">${tx("价格下跌至", "Price falls to")}</option><option value="long_liquidation">${tx("多头爆仓价", "Long liquidation")}</option><option value="short_liquidation">${tx("空头爆仓价", "Short liquidation")}</option></select></label><label>${tx("价格", "Price")}<span class="mark-price">${tx("市价", "Mark")} <button type="button" id="useLocalMark">--</button></span><input name="target" type="number" step="0.01" min="0" placeholder="0.00"></label><div class="frequency-toggle"><button type="button" data-local-frequency="once" class="active">${tx("仅一次", "Once")}</button><button type="button" data-local-frequency="repeat">${tx("重复", "Repeat")}</button></div></div><div data-mode-fields="round_number" hidden><label>${tx("整数步长", "Round step")}<input name="roundStep" type="number" min="1" step="1" value="100"></label><label>${tx("方向", "Direction")}<select name="roundDir"><option value="both">${tx("任一方向", "Either")}</option><option value="up">${tx("只向上", "Up only")}</option><option value="down">${tx("只向下", "Down only")}</option></select></label></div><div data-mode-fields="custom_grid" hidden><label>${tx("基准价格", "Base price")}<span class="mark-price">${tx("市价", "Mark")} <button type="button" id="useLocalMarkBase">--</button></span><input name="basePrice" type="number" step="0.01" min="0" placeholder="0.00"></label><label>${tx("间隔", "Step")}<input name="gridStep" type="number" min="1" step="1" value="50"></label><label>${tx("方向", "Direction")}<select name="gridDir"><option value="both">${tx("双向", "Both")}</option><option value="up">${tx("只向上", "Up only")}</option><option value="down">${tx("只向下", "Down only")}</option></select></label></div><div data-mode-fields="volatility" hidden><label>${tx("时间窗口（分钟）", "Window (min)")}<input name="volWindow" type="number" min="1" max="120" step="1" value="5"></label><label>${tx("波动阈值（USDT）", "Move threshold (USDT)")}<input name="volThreshold" type="number" min="1" step="1" value="300"></label><label>${tx("方向", "Direction")}<select name="volDir"><option value="both">${tx("双向", "Both")}</option><option value="up">${tx("只涨", "Up only")}</option><option value="down">${tx("只跌", "Down only")}</option></select></label></div><label id="localCooldown" hidden>${tx("冷却时间（分钟）", "Cooldown (minutes)")}<input name="cooldown" type="number" min="1" step="1" value="5"></label><label class="voice-rule-toggle">${tx("同时语音播报", "Also announce by voice")}<input name="voiceEnabled" type="checkbox"></label><button class="alert-submit">${tx("保存预警", "Save alert")}</button></form></section></div>`
        + `<div id="pushSettingsModal" class="alert-composer push-settings-modal" hidden><section><header><b>${tx("推送设置", "Push settings")}</b><button type="button" id="closePushSettings" aria-label="${tx("关闭", "Close")}">×</button></header><p class="push-settings-desc">${tx("每个渠道独立开关：打开后填写 API Key，点「确认并验证」会真实发送一条测试消息；验证通过后输入框自动收起，只留「重新编辑」。", "Each channel has its own switch: turn it on, fill in the API key, then “Save & verify” sends a real test message; inputs collapse once verified.")}</p><div id="pushSettingsBody"></div><div class="push-settings-footer"><button type="button" id="pushTestSend">${tx("发送测试推送（当前市价）", "Send test push (current price)")}</button><button type="button" id="donePushSettings" class="alert-submit">${tx("完成", "Done")}</button></div></section></div>`;
      const submitAlert = card.querySelector(".alert-submit"),
        alertActions = document.createElement("div");
      alertActions.className = "alert-actions";
      alertActions.innerHTML = `<button type="button" id="localRuleTest">${tx("测试当前规则（不保存）", "Test rule (not saved)")}</button>`;
      submitAlert.before(alertActions);
      alertActions.append(submitAlert);
      const notice = document.createElement("div");
      notice.id = "localRuleNotice";
      notice.className = "alert-composer alert-notice";
      notice.hidden = true;
      notice.innerHTML = `<section role="dialog" aria-modal="true" aria-labelledby="localRuleNoticeTitle"><header><b id="localRuleNoticeTitle">${tx("规则测试已发送", "Rule test sent")}</b><button type="button" id="closeLocalRuleNotice" aria-label="${tx("关闭", "Close")}">×</button></header><div class="notice-body"><span>✓</span><p>${tx("当前规则测试请求已发送。通知标题会标注“【测试】”，该规则不会被保存，也不会影响已有规则的冷却时间。", "The current-rule test was sent. Its notification is labeled “Test”; this rule is not saved and does not affect existing cooldowns.")}</p></div><button type="button" id="confirmLocalRuleNotice" class="alert-submit">${tx("我知道了", "Got it")}</button></section>`;
      document.body.append(notice);
      /* v2.12.56 起：卡片不再是主页面底部卡片，改为顶栏铃铛弹层。
         外壳复用 .alert-composer + .push-settings-modal 的居中修饰类，
         内容仍是完整的 #wechatAlertCard（所有设置原样保留）。 */
      const shell = document.createElement("div");
      shell.id = "notificationCenterModal";
      shell.className = "alert-composer push-settings-modal notification-center-modal";
      shell.hidden = true;
      shell.innerHTML = `<section><header class="notification-center-head"><b>${tx("消息推送", "Message alerts")}</b><button type="button" id="closeNotificationCenter" aria-label="${tx("关闭", "Close")}">×</button></header></section>`;
      shell.querySelector("section").append(card);
      document.body.append(shell);
      const openCenter = (open) => {
        shell.hidden = !open;
      };
      document.getElementById("closeNotificationCenter").onclick = () => openCenter(false);
      shell.addEventListener("click", (event) => {
        if (event.target === shell) openCenter(false); // 点背板关闭
      });
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && !shell.hidden) openCenter(false);
      });
      /* 顶栏铃铛按钮：插在设置齿轮之前（…全屏 → 主题 → 🔔 → 齿轮）。
         齿轮由 app.js 的 IIFE 创建，加载时序不保证已就位 → 轮询等它出现。 */
      const bell = document.createElement("button");
      bell.id = "notificationBellToggle";
      bell.type = "button";
      bell.title = tx("消息推送", "Message alerts");
      bell.setAttribute("aria-haspopup", "dialog");
      bell.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg>`;
      bell.addEventListener("click", (event) => {
        // 顶栏 document 级收起监听会把刚打开的浮层立刻关掉，必须阻断。
        event.stopPropagation();
        openCenter(true);
      });
      const placeBell = (tries = 0) => {
        if (document.getElementById("notificationBellToggle")) return;
        const controls = document.querySelector("main > header .controls"),
          gear = document.getElementById("headerSettingsToggle");
        if (controls && gear && gear.parentElement === controls) gear.before(bell);
        else if (tries < 40) setTimeout(() => placeBell(tries + 1), 250);
        else if (controls) controls.append(bell);
      };
      placeBell();
      const stateEl = $("localAlertState"),
        description = $("localAlertDescription"),
        master = $("pushMasterSwitch"),
        masterHint = $("pushMasterHint"),
        masterBody = $("pushMasterBody"),
        settingsModal = $("pushSettingsModal"),
        settingsBody = $("pushSettingsBody"),
        list = $("localAlertList"),
        modal = $("localAlertModal"),
        form = $("localAlertForm");
      let editingId = null; // 当前正在编辑的规则 id；null = 新建模式
      const localKey = () => (sessionStorage.getItem(keyStore) || "").trim(),
        localKeyOk = () => /^SCT/i.test(localKey());
      // 「推送就绪」= 本机 Server酱有效，或已登录且云端有启用渠道（钉钉/飞书/Bark/Webhook 均算）。
      const cloudReady = () =>
        Boolean(cloudSession.loggedIn) &&
        cloudChannels.some((c) => c && c.enabled);
      // 云端 buildAlertMessage 的 categoryLabel 是短词（'价格'→'价格告警'）。
      // v2.12.63：整数按方向拆分（up→整数上破 / down→整数下破），价格按方向拆分（上涨/下跌）。
      const cloudCategoryLabel = (kind, up) =>
        ({
          long_liquidation: "爆仓",
          short_liquidation: "爆仓",
          round_number: up === true ? "整数上破" : up === false ? "整数下破" : "整数",
          custom_grid: "网格",
          volatility: "波动",
          price_above: "上涨",
          price_below: "下跌",
        })[kind] || "价格";
      // 无本机 SendKey 时走云端多渠道发送（服务端向所有启用渠道投递）。
      // 走 /api/alerts/notify（语义=自定义消息），test:false 表示真实触发、标题不挂【测试】。
      const sendCloudCustom = async (payload) => {
        const response = await fetch("/api/alerts/notify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "云端推送失败");
        return data;
      };
      const showRuleNotice = (open) => {
        notice.hidden = !open;
      };
      $("closeLocalRuleNotice").onclick = () => showRuleNotice(false);
      $("confirmLocalRuleNotice").onclick = () => showRuleNotice(false);
      notice.onclick = (event) => {
        if (event.target === notice) showRuleNotice(false);
      };
      const label = (kind) =>
        ({
          price_reached: tx("价格达到", "Price reaches"),
          price_above: tx("价格上涨至", "Price rises to"),
          price_below: tx("价格下跌至", "Price falls to"),
          long_liquidation: tx("多头爆仓价", "Long liquidation"),
          short_liquidation: tx("空头爆仓价", "Short liquidation"),
          round_number: tx("整数推送", "Round-number"),
          custom_grid: tx("自定义推送", "Custom grid"),
          volatility: tx("快速挣扎", "Volatility"),
        })[kind] || kind;
      // v2.12.63：类别标签按方向细分，使「整数上破告警 / 整数下破告警」「上涨告警 / 下跌告警」一眼可辨。
      const alertCategory = (kind, up) =>
        kind === "long_liquidation" || kind === "short_liquidation"
          ? tx("爆仓告警", "Liquidation alert")
          : kind === "round_number"
            ? up === true ? tx("整数上破告警", "Round-up alert")
              : up === false ? tx("整数下破告警", "Round-down alert")
              : tx("整数告警", "Round alert")
          : kind === "custom_grid"
            ? tx("网格告警", "Grid alert")
            : kind === "volatility"
              ? tx("波动告警", "Volatility alert")
              : kind === "price_above"
                ? tx("上涨告警", "Price-up alert")
                : kind === "price_below"
                  ? tx("下跌告警", "Price-down alert")
                  : tx("价格告警", "Price alert");
      const alertPhrase = (kind, priceText) =>
        getLang() === "zh"
          ? ({
              price_reached: `${coinPairPlain()} 价格达到 ${priceText}`,
              price_above: `${coinPairPlain()} 价格上涨至 ${priceText}`,
              price_below: `${coinPairPlain()} 价格下跌至 ${priceText}`,
              long_liquidation: `${coinPairPlain()} 价格接近多头爆仓价 ${priceText}`,
              short_liquidation: `${coinPairPlain()} 价格接近空头爆仓价 ${priceText}`,
            })[kind] || `${coinPairPlain()} 价格 ${priceText}`
          : ({
              price_reached: `${coinPairPlain()} price reaches ${priceText}`,
              price_above: `${coinPairPlain()} price rises to ${priceText}`,
              price_below: `${coinPairPlain()} price falls to ${priceText}`,
              long_liquidation: `${coinPairPlain()} nears long liquidation ${priceText}`,
              short_liquidation: `${coinPairPlain()} nears short liquidation ${priceText}`,
            })[kind] || `${coinPairPlain()} price ${priceText}`;
      const alertTitle = (kind, target, { test = false } = {}) => {
        const phrase = alertPhrase(kind, target);
        if (test) return `${alertCategory(kind)}【${tx("测试", "Test")}】 ${phrase}`;
        return kind === "long_liquidation" || kind === "short_liquidation"
          ? `【${tx("爆仓", "Liquidation")}】${phrase}`
          : `【${tx("价格", "Price")}】${phrase}`;
      };
      const triggerText = (rule, withLevel = false) => {
        if (!rule.lastTriggeredAt) return "";
        const time = timeText(rule.lastTriggeredAt),
          live = `${tx("实时", "Live")} ${Number.isFinite(Number(rule.lastTriggeredPrice)) ? `${fmt(rule.lastTriggeredPrice)} USDT` : "--"}`;
        if (!withLevel || !Number.isFinite(Number(rule._eventLevel))) return `${time} · ${live}`;
        const lvl = fmt(rule._eventLevel),
          up = rule._eventDir !== "down",
          arrow = up ? "↑" : "↓",
          breakWord = up ? tx("上破", "broke up") : tx("下破", "broke down");
        if (rule.kind === "custom_grid") {
          const off = rule._eventLevel - rule.basePrice;
          const offText = Math.abs(off) < 1e-9 ? tx("回到基准", "back to base") : `${off > 0 ? "+" : "-"}${fmt(Math.abs(off))}`;
          return `${time} · ${arrow} ${tx("命中", "hit")} ${lvl}（${offText}） · ${live}`;
        }
        if (rule.kind === "volatility") {
          const move = Number(rule._eventMove) || 0;
          return `${time} · ${arrow} ${move >= 0 ? tx("涨", "up") : tx("跌", "down")} ${fmt(Math.abs(move))} · ${live}`;
        }
        return `${time} · ${arrow} ${breakWord} ${lvl} · ${live}`;
      };

      // ---- 推送设置弹层：分渠道开关 + 表单（仿 8899 交互） ----
      const editing = {},
        dirty = {};
      let localVerified = false;
      const channelSummary = (channel) => {
        const def = CHANNEL_DEFS[channel.type];
        try { return def ? def.summary(channel.config || {}) : ""; }
        catch { return ""; }
      };
      const primaryOf = (type) => cloudChannels.find((c) => c.type === type);
      const extrasOf = (type) => cloudChannels.filter((c) => c.type === type).slice(1);
      const badgeFor = (type) => {
        if (!cloudSession.loggedIn) {
          if (type !== "serverchan") return null;
          if (dirty.serverchan) return { cls: "warn", text: tx("待重新验证", "Needs re-check") };
          if (localVerified && localKeyOk()) return { cls: "ok", text: tx("本机已就绪", "Local ready") };
          if (localKeyOk()) return { cls: "muted", text: tx("未验证", "Not verified") };
          return null;
        }
        const primary = primaryOf(type);
        if (!primary) return dirty[type] ? { cls: "warn", text: tx("待验证", "Pending") } : null;
        if (editing[type] || dirty[type]) return { cls: "warn", text: tx("待验证", "Pending") };
        if (primary.lastVerifyOk === true) return { cls: "ok", text: tx("已验证", "Verified") };
        if (primary.lastVerifyOk === false) return { cls: "danger", text: tx("验证失败", "Failed") };
        return { cls: "muted", text: tx("未验证", "Not verified") };
      };
      const fieldsHtml = (type, config = {}) =>
        (CHANNEL_DEFS[type]?.fields || [])
          .map((field) => {
            if (field.secret && config[`__masked__${field.key}`])
              return `<div class="field"><input name="__masked__${field.key}" type="hidden" value="1"><input name="${field.key}" type="${field.type}" autocomplete="off" placeholder="${tx("已保存，留空则不修改", "Saved; leave blank to keep")}"></div>`;
            return `<div class="field"><input name="${field.key}" type="${field.type}" autocomplete="off" placeholder="${field.placeholder || field.label}" value="${String(config[field.key] ?? "").replace(/"/g, "&quot;")}"></div>`;
          })
          .join("");
      const renderSettings = () => {
        if (!settingsBody) return;
        const signedIn = cloudSession.loggedIn;
        settingsBody.innerHTML = Object.entries(CHANNEL_DEFS)
          .map(([type, def]) => {
            const isLocal = !signedIn && type === "serverchan",
              locked = !signedIn && type !== "serverchan",
              primary = signedIn ? primaryOf(type) : null,
              extras = signedIn ? extrasOf(type) : [];
            const enabled = locked ? false : isLocal ? (localKeyOk() || Boolean(editing.serverchan)) : Boolean(primary?.enabled || editing[type]);
            const badge = badgeFor(type);
            const showBody = !locked && (enabled || editing[type]);
            const fieldsVisible =
              !locked &&
              (isLocal
                ? Boolean(editing.serverchan || (localKeyOk() && !localVerified))
                : !primary
                  ? Boolean(editing[type])
                  : Boolean(editing[type] || primary.lastVerifyOk !== true));
            const configured = isLocal ? localKeyOk() : Boolean(primary);
            const actions = [];
            if (fieldsVisible)
              actions.push(`<button type="button" class="ch-primary" data-ch-confirm="${type}">${tx("确认并验证", "Save & verify")}</button>`);
            if (!fieldsVisible && configured)
              actions.push(`<button type="button" data-ch-edit="${type}">${tx("重新编辑", "Edit")}</button>`);
            if (configured)
              actions.push(`<button type="button" class="ch-clear" data-ch-clear="${type}">${tx("清除", "Clear")}</button>`);
            const body = locked
              ? `<div class="ch-body"><small class="ch-sub">${tx("登录后可启用云端推送渠道：配置加密保存到云端，网页关闭后由服务器持续投递。", "Sign in to enable this cloud channel: configs are stored encrypted server-side and delivered after the page closes.")}</small><div class="ch-actions"><button type="button" data-open-account>${tx("前往登录", "Go to sign in")}</button></div></div>`
              : `<div class="ch-body"${showBody ? "" : " hidden"}><small class="ch-sub">${def.hint}</small><div class="ch-fields"${fieldsVisible ? "" : " hidden"}>${fieldsHtml(type, primary?.config || {})}</div><div class="ch-actions">${actions.join("")}<span class="ch-msg" data-ch-msg="${type}"></span></div></div>`;
            const extrasHtml = extras
              .map(
                (c) =>
                  `<div class="ch-extra"><span class="channel-main"><b>${c.name}</b><small>${channelSummary(c)}</small></span><label class="push-switch"><input type="checkbox" data-extra-toggle="${c.id}" ${c.enabled ? "checked" : ""}></label><button type="button" class="ch-clear" data-extra-delete="${c.id}">${tx("删除", "Delete")}</button></div>`,
              )
              .join("");
            return `<div class="ch-block${locked ? " ch-locked" : ""}" data-ch-block="${type}"><div class="ch-head"><div class="grow"><div class="ch-label">${def.label}<span class="ch-badge ${badge ? badge.cls : ""}">${badge ? badge.text : ""}</span></div></div><label class="push-switch"><input type="checkbox" data-ch-toggle="${type}" ${enabled ? "checked" : ""} ${locked ? "disabled" : ""}></label></div>${body}${extrasHtml}</div>`;
          })
          .join("");
        bindSettings();
      };
      const setBlockBadge = (block, type) => {
        const badge = badgeFor(type),
          el = block?.querySelector(".ch-badge");
        if (el) {
          el.className = `ch-badge ${badge ? badge.cls : ""}`;
          el.textContent = badge ? badge.text : "";
        }
      };
      const collectBlock = (block) => {
        const config = {};
        block.querySelectorAll(".ch-fields input").forEach((el) => {
          config[el.name] = el.type === "hidden" ? el.value : el.value.trim();
        });
        return config;
      };
      const verifyChannel = async (id) => {
        const result = await api(`/api/alerts/channels/${encodeURIComponent(id)}/verify`, { method: "POST" });
        return result;
      };
      const bindSettings = () => {
        settingsBody.querySelectorAll("[data-ch-toggle]").forEach((input) => {
          input.onchange = async () => {
            const type = input.dataset.chToggle,
              block = settingsBody.querySelector(`[data-ch-block="${type}"]`);
            if (!cloudSession.loggedIn) {
              // 本机 Server酱：关闭开关 = 清除本机 Key
              if (type === "serverchan" && !input.checked && localKeyOk()) {
                showAppDialog({
                  title: tx("清除本机 Key", "Clear local Key"),
                  message: tx("确定清除本会话保存的 Server酱 SendKey 吗？", "Clear the ServerChan SendKey saved in this session?"),
                  confirmText: tx("清除", "Clear"),
                  cancelText: tx("取消", "Cancel"),
                  onConfirm: () => {
                    sessionStorage.removeItem(keyStore);
                    localVerified = false;
                    dirty.serverchan = false;
                    save();
                    renderSettings();
                    render();
                  },
                  onCancel: () => {
                    input.checked = true;
                    renderSettings();
                  },
                });
              } else if (type === "serverchan") {
                editing.serverchan = input.checked;
                renderSettings();
              }
              return;
            }
            const primary = primaryOf(type);
            if (!primary) {
              // 尚未配置：开关只控制表单展开/收起
              editing[type] = input.checked;
              renderSettings();
              return;
            }
            try {
              await api(`/api/alerts/channels/${encodeURIComponent(primary.id)}`, {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ enabled: input.checked }),
              });
              await loadCloudState();
              renderSettings();
            } catch (error) {
              input.checked = !input.checked;
              showAppDialog({ title: tx("消息推送", "Message alerts"), message: error.message });
            }
          };
        });
        settingsBody.querySelectorAll("[data-ch-confirm]").forEach((button) => {
          button.onclick = async () => {
            const type = button.dataset.chConfirm,
              block = settingsBody.querySelector(`[data-ch-block="${type}"]`);
            button.disabled = true;
            button.textContent = tx("验证中…", "Verifying…");
            try {
              if (!cloudSession.loggedIn) {
                const key = block?.querySelector('input[name="sendKey"]')?.value.trim() || "";
                if (!/^SCT/i.test(key)) throw new Error(tx("请输入以 SCT 开头的 Server酱 Turbo SendKey。", "Enter a ServerChan Turbo SendKey starting with SCT."));
                sessionStorage.setItem(keyStore, key);
                save();
                localVerified = true;
                dirty.serverchan = false;
                editing.serverchan = false;
                const current = price();
                if (Number.isFinite(current)) await push(current).catch(() => {});
                renderSettings();
                render();
                showAppDialog({ title: tx("本机推送已就绪", "Local push ready"), message: tx("SendKey 已保存到当前会话（AES-GCM 加密），测试推送已发出，请查看微信。", "SendKey saved for this session (AES-GCM encrypted) and a test push was sent; check WeChat.") });
                return;
              }
              const primary = primaryOf(type),
                config = collectBlock(block),
                input = { type, name: primary?.name || CHANNEL_DEFS[type].label, config };
              if (primary) input.id = primary.id;
              const saved = await api("/api/alerts/channels", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(input),
              });
              dirty[type] = false;
              editing[type] = false;
              const result = await verifyChannel(saved.id).catch((error) => ({ ok: false, error: error.message }));
              await loadCloudState();
              renderSettings();
              render();
              if (result.ok)
                showAppDialog({ title: tx("验证成功", "Verified"), message: tx("验证消息已发送，请在该渠道查收。", "A verification message was sent; check the channel.") });
              else
                showAppDialog({ title: tx("验证失败", "Verification failed"), message: result.error || tx("渠道未确认送达。", "The channel did not confirm delivery.") });
            } catch (error) {
              renderSettings();
              showAppDialog({ title: tx("消息推送", "Message alerts"), message: error.message });
            }
          };
        });
        settingsBody.querySelectorAll("[data-ch-edit]").forEach(
          (button) =>
            (button.onclick = () => {
              editing[button.dataset.chEdit] = true;
              renderSettings();
            }),
        );
        settingsBody.querySelectorAll("[data-ch-clear]").forEach((button) => {
          button.onclick = () => {
            const type = button.dataset.chClear;
            if (!cloudSession.loggedIn) {
              if (type !== "serverchan") return;
              showAppDialog({
                title: tx("清除本机 Key", "Clear local Key"),
                message: tx("确定清除本会话保存的 Server酱 SendKey 吗？", "Clear the ServerChan SendKey saved in this session?"),
                confirmText: tx("清除", "Clear"),
                cancelText: tx("取消", "Cancel"),
                onConfirm: () => {
                  sessionStorage.removeItem(keyStore);
                  localVerified = false;
                  dirty.serverchan = false;
                  save();
                  renderSettings();
                  render();
                },
              });
              return;
            }
            const primary = primaryOf(type);
            if (!primary) return;
            showAppDialog({
              title: tx("清除渠道", "Clear channel"),
              message: tx(`确定清除「${primary.name}」的配置吗？`, `Clear the “${primary.name}” configuration?`),
              confirmText: tx("清除", "Clear"),
              cancelText: tx("取消", "Cancel"),
              onConfirm: async () => {
                try {
                  await api(`/api/alerts/channels/${encodeURIComponent(primary.id)}`, { method: "DELETE" });
                  dirty[type] = false;
                  editing[type] = false;
                  await loadCloudState();
                  renderSettings();
                  render();
                } catch (error) {
                  showAppDialog({ title: tx("消息推送", "Message alerts"), message: error.message });
                }
              },
            });
          };
        });
        settingsBody.querySelectorAll("[data-open-account]").forEach((button) => {
          button.onclick = () => {
            const accountCard = document.getElementById("accountServiceCard");
            if (accountCard) accountCard.hidden = false;
            showPushSettings(false);
          };
        });
        settingsBody.querySelectorAll(".ch-fields input:not([type=hidden])").forEach((input) => {
          input.oninput = () => {
            const type = input.closest("[data-ch-block]")?.dataset.chBlock;
            if (!type) return;
            dirty[type] = true;
            setBlockBadge(input.closest("[data-ch-block]"), type);
          };
        });
        settingsBody.querySelectorAll("[data-extra-toggle]").forEach((input) => {
          input.onchange = async () => {
            try {
              await api(`/api/alerts/channels/${encodeURIComponent(input.dataset.extraToggle)}`, {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ enabled: input.checked }),
              });
              await loadCloudState();
              renderSettings();
            } catch (error) {
              input.checked = !input.checked;
              showAppDialog({ title: tx("消息推送", "Message alerts"), message: error.message });
            }
          };
        });
        settingsBody.querySelectorAll("[data-extra-delete]").forEach((button) => {
          button.onclick = () => {
            const channel = cloudChannels.find((c) => c.id === button.dataset.extraDelete);
            showAppDialog({
              title: tx("删除渠道", "Delete channel"),
              message: tx(`确定删除「${channel?.name || ""}」吗？`, `Delete “${channel?.name || ""}”?`),
              confirmText: tx("删除", "Delete"),
              cancelText: tx("取消", "Cancel"),
              onConfirm: async () => {
                try {
                  await api(`/api/alerts/channels/${encodeURIComponent(button.dataset.extraDelete)}`, { method: "DELETE" });
                  await loadCloudState();
                  renderSettings();
                  render();
                } catch (error) {
                  showAppDialog({ title: tx("消息推送", "Message alerts"), message: error.message });
                }
              },
            });
          };
        });
      };
      const showPushSettings = (open) => {
        settingsModal.hidden = !open;
        if (open) renderSettings();
      };
      $("openPushSettings").onclick = () => showPushSettings(true);
      $("closePushSettings").onclick = () => showPushSettings(false);
      $("donePushSettings").onclick = () => showPushSettings(false);
      settingsModal.onclick = (event) => {
        if (event.target === settingsModal) showPushSettings(false);
      };
      const syncSettingsInputs = () => {
        if (master) master.checked = pushSettings.masterEnabled !== false;
        const lossEnabled = $("lossPushEnabled"),
          loss = pushSettings.lossPush || {};
        if (lossEnabled) lossEnabled.checked = Boolean(loss.enabled);
        if ($("lossWarnRoe")) $("lossWarnRoe").value = loss.warnRoe ?? 20;
        if ($("lossLossRoe")) $("lossLossRoe").value = loss.lossRoe ?? 50;
        if ($("lossCooldown")) $("lossCooldown").value = loss.cooldownMinutes ?? 30;
      };
      if (master)
        master.onchange = async () => {
          try {
            await savePushSettings({ masterEnabled: master.checked });
            render();
          } catch (error) {
            master.checked = !master.checked;
            showAppDialog({ title: tx("消息推送", "Message alerts"), message: error.message });
          }
        };
      const lossSave = $("lossPushSave");
      if (lossSave)
        lossSave.onclick = async () => {
          if (!cloudSession.loggedIn) {
            showAppDialog({ title: tx("亏损推送", "Loss push"), message: tx("请先登录后使用亏损推送。", "Sign in to use loss push.") });
            return;
          }
          try {
            await savePushSettings({
              lossPush: {
                enabled: $("lossPushEnabled").checked,
                warnRoe: Number($("lossWarnRoe").value) || 20,
                lossRoe: Number($("lossLossRoe").value) || 50,
                cooldownMinutes: Number($("lossCooldown").value) || 30,
              },
            });
            showAppDialog({ title: tx("亏损推送", "Loss push"), message: tx("亏损推送设置已保存。", "Loss push settings saved.") });
          } catch (error) {
            showAppDialog({ title: tx("亏损推送", "Loss push"), message: error.message });
          }
        };

      const render = () => {
        const ready = localKeyOk(),
          cloudCount = rules.filter((r) => r.cloudManaged).length,
          masterOn = pushSettings.masterEnabled !== false;
        stateEl.className = `badge ${masterOn ? (cloudCount || ready ? "bull" : "flat") : "flat"}`;
        stateEl.textContent = !masterOn
          ? tx("推送已关闭", "Push off")
          : cloudSession.loggedIn
            ? cloudCount
              ? tx(`云端接管 ${cloudCount} 条`, `Cloud manages ${cloudCount}`)
              : tx("待配置规则", "No rules yet")
            : ready
              ? tx("本机推送已就绪", "Local push ready")
              : tx("未配置推送", "Not configured");
        description.textContent = cloudSession.loggedIn
          ? tx("已登录：渠道与 Key 加密保存到云端，网页关闭后持续推送；渠道在「推送设置」中管理。", "Signed in: channels and keys are stored encrypted in the cloud and keep pushing after the page closes; manage them under “Settings”.")
          : tx("本机模式：规则仅保存在此浏览器；在「推送设置」中配置 Server酱，或登录后启用多渠道。", "Local mode: rules stay in this browser; set up ServerChan under “Settings”, or sign in for multi-channel push.");
        if (master) {
          master.checked = masterOn;
          master.disabled = !cloudSession.loggedIn;
        }
        if (masterHint)
          masterHint.textContent = cloudSession.loggedIn
            ? tx("关闭后，下方所有规则停止推送。", "When off, all rules below stop pushing.")
            : tx("总开关与亏损联动在登录后可用。", "Master switch and loss push are available after signing in.");
        if (masterBody) masterBody.hidden = !masterOn;
        // 多币种：标题小字与「添加预警」弹窗符号随当前币种变化（比特币模式恒为 ₿ BTC/USDT）
        const rtb = document.querySelector(".alert-rule-toolbar b");
        if (rtb) rtb.innerHTML = tx("推送规则", "Push rules") + "<small>" + coinMark() + coinPairPlain() + " · " + tx("永续", "Perpetual") + "</small>";
        const symEl = document.querySelector("#localAlertModal .alert-symbol");
        if (symEl) symEl.innerHTML = coinMark() + "<b>" + coinPairPlain() + " " + tx("永续", "Perpetual") + "</b>";
        if ($("lossPushSave")) $("lossPushSave").disabled = !cloudSession.loggedIn;
        list.innerHTML = `<div class="notification-rule-list">${
          rules.length
            ? rules
                .map((r) => {
                  const cloudManaged = Boolean(r.cloudManaged),
                    newMode = isNewMode(r),
                    triggered =
                      !cloudManaged && r.repeat === false && r.lastTriggeredAt;
                  /* 徽标只标「例外状态」：云端规则是默认形态不再逐行盖章；
                     已执行（一次性触发）与登录后仍留在本机的规则才值得提示。 */
                  const badge = triggered
                    ? `<em class="flat">${tx("已执行", "Executed")}</em>`
                    : !cloudManaged && cloudSession.loggedIn
                      ? `<em class="muted">${tx("本地", "Local")}</em>`
                      : "";
                  // 新模式为重复型：用「最后触发」行展示时间与命中价，一次性规则沿用「已触发执行」
                  const lastLine = r.lastTriggeredAt
                    ? newMode
                      ? `<small class="notification-triggered">${tx("最后触发：", "Last fired: ")}${triggerText(r, true)}</small>`
                      : triggered
                        ? `<small class="notification-triggered">${tx("已触发执行：", "Triggered: ")}${triggerText(r)}</small>`
                        : ""
                    : "";
                  return `<article class="${cloudManaged ? "cloud-managed-rule" : ""} ${newMode ? "rule-new-mode" : ""}"><span><b>${coinPairPlain()} ${modeTitle(r)}</b><small>${ruleShort(r)}</small>${lastLine}</span>${badge}<button type="button" class="rule-edit" data-edit-local-alert="${r.id}">${tx("编辑", "Edit")}</button><button type="button" class="rule-test" data-test-local-alert="${r.id}">${tx("测试", "Test")}</button><button type="button" class="rule-remove" data-remove-local-alert="${r.id}">${tx("删除", "Delete")}</button></article>`;
                })
                .join("")
            : `<small>${tx("尚未添加推送规则。点击「＋ 添加预警」创建第一条 " + coinPairPlain() + " 规则。", "No push rules yet. Click “Add alert” to create the first " + coinPairPlain() + " rule.")}</small>`
        }</div>`;
        list.querySelectorAll("[data-remove-local-alert]").forEach(
          (b) =>
            (b.onclick = () => {
              rules = rules.filter((r) => r.id !== b.dataset.removeLocalAlert);
              save();
              render();
            }),
        );
        list.querySelectorAll("[data-edit-local-alert]").forEach(
          (b) =>
            (b.onclick = () => {
              const rule = rules.find((r) => r.id === b.dataset.editLocalAlert);
              if (rule) openEdit(rule);
            }),
        );
        list.querySelectorAll("[data-test-local-alert]").forEach(
          (b) =>
            (b.onclick = async () => {
              const rule = rules.find((r) => r.id === b.dataset.testLocalAlert);
              if (!rule) return;
              const current = price();
              if (!Number.isFinite(current)) {
                alert(tx("实时价格尚未加载，请稍后重试。", "Live price not loaded yet, try again shortly."));
                return;
              }
              b.disabled = true;
              try {
                await pushRuleTest(current, rule, true);
                showRuleNotice(true);
              } catch (error) {
                alert(error.message);
              } finally {
                b.disabled = false;
              }
            }),
        );
        syncSettingsInputs();
        if (!settingsModal.hidden) renderSettings();
      };
      // 语言切换后刷新通知卡片静态文案与动态状态（卡片初次按当前语言构建，切换时需补刷新）
      // Refresh static labels + dynamic state after a language switch.
      (function watchLangForNotification() {
        const applyLang = () => {
          try { render(); } catch (e) {}
          const setText = (sel, s, e) => { const el = document.querySelector(sel); if (el) el.textContent = tx(s, e); };
          setText("#wechatAlertCard .forecast-head h2", "消息推送", "Message alerts");
          setText("#notificationCenterModal .notification-center-head b", "消息推送", "Message alerts");
          const bellBtn = document.getElementById("notificationBellToggle"); if (bellBtn) bellBtn.title = tx("消息推送", "Message alerts");
          const ps = document.querySelector("#openPushSettings"); if (ps) ps.textContent = "⚙ " + tx("推送设置", "Settings");
          const en = document.querySelector("#pushMasterSwitch")?.nextElementSibling; if (en) en.textContent = tx("启用消息推送", "Enable push");
          const add = document.querySelector("#openLocalAlert"); if (add) add.textContent = "＋ " + tx("添加预警", "Add alert");
          const del = document.querySelector("#clearLocalAlerts"); if (del) del.textContent = tx("批量全删", "Delete all");
          const loss = document.querySelector("#lossPushEnabled")?.nextElementSibling; if (loss) loss.textContent = tx("亏损推送（联动持仓）", "Loss push (linked to positions)");
          const ls = document.querySelector("#lossPushSave"); if (ls) ls.textContent = tx("保存设置", "Save");
          const lsSmall = document.querySelector(".loss-push-box small"); if (lsSmall) lsSmall.textContent = tx("以「我的持仓」中各笔持仓的保证金收益率（ROE = 价格变动% × 杠杆）计算；任一持仓触发即向所有启用渠道推送。", "Computed from each saved position ROE (price move % x leverage); any position crossing a threshold pushes to all enabled channels.");
        };
        new MutationObserver(applyLang).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
      })();
      const alertShort = (kind, target) =>
        ({
          price_reached: `${coinPairPlain()} 达到 ${target} USDT`,
          price_above: `${coinPairPlain()} 上涨至 ${target} USDT`,
          price_below: `${coinPairPlain()} 下跌至 ${target} USDT`,
          long_liquidation: `多头爆仓价 ${target} USDT`,
          short_liquidation: `空头爆仓价 ${target} USDT`,
        })[kind] || `${coinPairPlain()} ${target} USDT`;
      const sendViaServerChan = async (body) => {
        try {
          await fetch(`https://sctapi.ftqq.com/${encodeURIComponent(localKey())}.send`, {
            method: "POST",
            mode: "no-cors",
            body,
            keepalive: true,
          });
        } catch {
          navigator.sendBeacon?.(
            `https://sctapi.ftqq.com/${encodeURIComponent(localKey())}.send`,
            body,
          );
        }
      };
      const timeText = (ts) =>
        new Date(ts).toLocaleString(getLang() === "zh" ? "zh-CN" : "en-US", { hour12: false });
      const dirText = (d) =>
        ({ both: tx("双向", "Both"), up: tx("向上", "Up"), down: tx("向下", "Down") })[d] || tx("双向", "Both");
      const modeTitle = (r) =>
        ({
          price_reached: tx("价格预警", "Price alert"), price_above: tx("价格预警", "Price alert"),
          price_below: tx("价格预警", "Price alert"), long_liquidation: tx("爆仓预警", "Liquidation"),
          short_liquidation: tx("爆仓预警", "Liquidation"), round_number: tx("整数推送", "Round-number"),
          custom_grid: tx("自定义推送", "Custom grid"), volatility: tx("快速挣扎推送", "Volatility"),
        })[r.kind] || tx("价格预警", "Price alert");
      const ruleShort = (r) =>
        r.kind === "round_number"
          ? `${tx("步长", "step")} ${fmt(r.step)} · ${dirText(r.direction)}`
          : r.kind === "custom_grid"
            ? `${tx("基准", "base")} ${fmt(r.basePrice)} · ${tx("间隔", "step")} ${fmt(r.step)} · ${dirText(r.direction)}`
            : r.kind === "volatility"
              ? `${tx("窗口", "win")} ${r.windowMinutes}${tx("分", "m")} · ${tx("阈值", "thr")} ±${fmt(r.threshold)} · ${dirText(r.direction)}`
              : `${label(r.kind)} ${fmt(r.targetPrice)} · ${r.repeat === false ? tx("仅一次", "Once") : tx(`重复 · ${r.cooldownMinutes} 分钟冷却`, `Repeat · ${r.cooldownMinutes} min`)}`;
      /* 统一文案生成（按规则类型编排，v2.12.59）：
         测试触发 → 标题挂【测试】、正文首行声明「模拟触发，非真实信号」；
         真实触发 → 无任何测试字样，只给客观数据。
         每种规则的正文字段不同（整数=步长/突破方向，网格=基准/偏移，波动=窗口/涨跌幅度…）。 */
      const buildMessage = (rule, current, opts = {}) => {
        const test = Boolean(opts.test),
          event = opts.event || {},
          lvl = Number.isFinite(Number(event.level)) ? Number(event.level) : Number(rule.targetPrice),
          currentText = fmt(current),
          zh = getLang() === "zh",
          pair = coinPairPlain();
        // 方向判定（红跌绿涨，v2.12.63）：爆仓语义固定 —— 多头爆仓=价跌(红)/空头爆仓=价涨(绿)；
        // 其余按突破/波动方向；无方向信息（如价格达到）用中立 ⚠️。
        const volMove = Number.isFinite(Number(event.move)) ? Number(event.move) : null;
        const direction =
          rule.kind === "long_liquidation" ? "down"
          : rule.kind === "short_liquidation" ? "up"
          : rule.kind === "volatility" ? (volMove === null ? (event.dir === "down" ? "down" : "up") : (volMove >= 0 ? "up" : "down"))
          : rule.kind === "price_above" ? "up"
          : rule.kind === "price_below" ? "down"
          : rule.kind === "price_reached" ? (event.dir === "down" ? "down" : event.dir === "up" ? "up" : "none")
          : event.dir === "down" ? "down" : event.dir === "up" ? "up" : "up";
        const up = direction === "up",
          arrow = direction === "up" ? "↑" : direction === "down" ? "↓" : "→",
          dot = direction === "up" ? "🟢" : direction === "down" ? "🔴" : "⚠️",
          cat = alertCategory(rule.kind, up);
        let phrase,
          facts = [];
        if (rule.kind === "round_number") {
          phrase = zh
            ? `${pair} ${arrow} ${up ? "上破" : "下破"}整数位 ${fmt(lvl)}`
            : `${pair} ${arrow} ${up ? "broke above" : "broke below"} round ${fmt(lvl)}`;
          facts = [
            [zh ? "整数步长" : "Step", `${fmt(Number(rule.step) || 0)} USDT`],
            [zh ? "突破方向" : "Direction", up ? (zh ? "向上 ↑" : "up ↑") : (zh ? "向下 ↓" : "down ↓")],
            [zh ? "命中整数位" : "Hit level", `**${fmt(lvl)} USDT**`],
          ];
        } else if (rule.kind === "custom_grid") {
          const base = Number(rule.basePrice) || 0,
            step = Number(rule.step) || 0,
            off = lvl - base,
            offText =
              Math.abs(off) < 1e-9
                ? zh ? "回到基准价" : "back to base"
                : `${zh ? "较基准" : "vs base"} ${off > 0 ? "+" : "-"}${fmt(Math.abs(off))}`;
          phrase = zh
            ? `${pair} ${arrow} 触及网格线 ${fmt(lvl)}（${offText}）`
            : `${pair} ${arrow} hit grid ${fmt(lvl)} (${offText})`;
          facts = [
            [zh ? "基准价" : "Base", `${fmt(base)} USDT`],
            [zh ? "网格间隔" : "Grid step", `${fmt(step)} USDT`],
            [zh ? "本次命中" : "Hit", `**${fmt(lvl)} USDT**`],
            [zh ? "相对基准" : "Offset", offText],
          ];
        } else if (rule.kind === "volatility") {
          const move = volMove === null ? 0 : volMove,
            start = Number.isFinite(Number(event.start)) ? Number(event.start) : current,
            win = Number(rule.windowMinutes) || 0,
            pctText = start ? `${((move / start) * 100).toFixed(2)}%` : "--";
          phrase = zh
            ? `${pair} ${arrow} ${win} 分钟内${move >= 0 ? "上涨" : "下跌"} ${fmt(Math.abs(move))} USDT`
            : `${pair} ${arrow} ${move >= 0 ? "rose" : "fell"} ${fmt(Math.abs(move))} USDT in ${win} min`;
          facts = [
            [zh ? "观察窗口" : "Window", `${win} ${zh ? "分钟" : "min"}`],
            [zh ? "波动阈值" : "Threshold", `±${fmt(Number(rule.threshold) || 0)} USDT`],
            [zh ? "窗口起点" : "From", `${fmt(start)} USDT`],
            [zh ? "区间涨跌" : "Move", `**${move >= 0 ? "+" : "-"}${fmt(Math.abs(move))} USDT（${pctText}）**`],
          ];
        } else if (rule.kind === "long_liquidation" || rule.kind === "short_liquidation") {
          const long = rule.kind === "long_liquidation";
          phrase = zh
            ? `${pair} ${arrow} 逼近${long ? "多头" : "空头"}爆仓价 ${fmt(lvl)}`
            : `${pair} ${arrow} nears ${long ? "long" : "short"} liquidation ${fmt(lvl)}`;
          const dist = Math.abs(current - lvl),
            gapPct = current ? `${((dist / current) * 100).toFixed(2)}%` : "--";
          facts = [
            [zh ? "爆仓方向" : "Side", long ? (zh ? "多头（做多）" : "long") : (zh ? "空头（做空）" : "short")],
            [zh ? "爆仓价" : "Liquidation", `**${fmt(lvl)} USDT**`],
            [zh ? "距爆仓价" : "Distance", `${fmt(dist)} USDT`],
            [zh ? "距爆仓幅度" : "Gap", gapPct],
          ];
        } else {
          const kindText =
            ({
              price_reached: zh ? "到达" : "reached",
              price_above: zh ? "涨破" : "broke above",
              price_below: zh ? "跌破" : "broke below",
            })[rule.kind] || (zh ? "价格触发" : "triggered");
          phrase = zh ? `${pair} ${arrow} ${kindText} ${fmt(lvl)}` : `${pair} ${arrow} ${kindText} ${fmt(lvl)}`;
          facts = [
            [zh ? "触发类型" : "Trigger", kindText],
            [zh ? "目标价" : "Target", `**${fmt(lvl)} USDT**`],
          ];
        }
        /* v2.12.63：红跌绿涨色标（🟢 涨 / 🔴 跌 / ⚠️ 中立）+ 文案按类型重排（标题只带触发短语，正文纯明细 → 时间/交易对 → 站点链接）。
           钉钉渠道已改 markdown 渲染（标题 h4 + 明细加粗 + 蓝色链接）；Bark 渠道发送端自动降级纯文本。 */
        const badge = test ? `【${zh ? "测试" : "Test"}】` : "";
        const title = `${badge}${cat.includes("】") ? cat : "【" + cat + "】"}${dot} ${phrase}`;
        const desp = [
          test
            ? `**${zh ? "🧪 测试推送 · 模拟触发，非真实信号" : "🧪 Test push · simulated, not a real signal"}**`
            : `${zh ? "当前价" : "Mark"}：**${currentText} USDT**`,
          ...(test ? [`${zh ? "当前价" : "Mark"}：**${currentText} USDT**`] : []),
          /* v2.12.64：字段值统一加粗（去掉各 fact 自带的零散 ** 再整体包裹），
             与钉钉渲染的「标签常规 + 值加粗」版式一致。 */
          ...facts.map(([k, v]) => `${k}：**${String(v).replace(/\*\*/g, "")}**`),
          `${zh ? "🕒 触发时间" : "🕒 Triggered at"}：${timeText(Date.now())}`,
          `${zh ? "💱 交易对" : "💱 Pair"}：${pair} · ${zh ? "永续" : "Perp"}`,
          test
            ? opts.savedRule
              ? zh
                ? "本条由规则列表的「测试」按钮发送，为模拟触发的测试数据；已保存的规则未受任何影响。"
                : "Sent via the list Test button with simulated data; the saved rule is untouched."
              : zh
                ? "本条为弹窗草稿的测试推送（模拟数据），该规则不会被保存。"
                : "Test push of the form draft (simulated data); this rule is not saved."
            : "",
          zh
            ? "🔗 [查看实时行情 · jeffereyreng.site](https://jeffereyreng.site/)"
            : "🔗 [Live dashboard · jeffereyreng.site](https://jeffereyreng.site/)",
        ]
          .filter(Boolean)
          .join("\n");
        return { title, short: phrase, desp, test, category: cat, direction };
      };
      const push = async (current, rule = null, event = null) => {
        if (!localKeyOk() && !cloudReady())
          throw new Error(
            tx(
              "请先在「推送设置」中配置并启用至少一个推送渠道（Server酱 / 钉钉 / 飞书 / Bark / Webhook 均可）。",
              "Configure and enable at least one push channel in Settings first (ServerChan / DingTalk / Feishu / Bark / Webhook).",
            ),
          );
        if (!rule) {
          if (localKeyOk()) {
            await sendViaServerChan(
              new URLSearchParams({
                title: `价格告警【测试】 ${coinPairPlain()} 当前价格 ${fmt(current)}`,
                short: `${coinPairPlain()} 当前价格 ${fmt(current)} USDT`,
                desp: `价格告警【测试】\n\n${coinPairPlain()} 当前价格 ${fmt(current)} USDT`,
              }),
            );
          } else {
            await sendCloudCustom({ price: current, test: true });
          }
          return;
        }
        const m = buildMessage(rule, current, { event });
        if (localKeyOk())
          await sendViaServerChan(new URLSearchParams({ title: m.title, short: m.short, desp: m.desp }));
        else
          await sendCloudCustom({
            price: current,
            categoryLabel: cloudCategoryLabel(rule.kind, m.direction === "up"),
            phrase: m.short,
            note: m.desp,
            direction: m.direction,
            test: false, // 真实触发：云端不得再挂【测试】
          });
      };
      // 测试推送的模拟触发数据：按当前市价构造一次「如果现在触发会是什么样」的假想事件
      const testEventFor = (rule, current) => {
        if (rule.kind === "round_number") {
          const step = Math.max(1, Number(rule.step) || 1),
            dir = rule.direction === "down" ? "down" : "up";
          return {
            level: dir === "up" ? Math.floor(current / step) * step + step : Math.ceil(current / step) * step - step,
            dir,
          };
        }
        if (rule.kind === "custom_grid") {
          const step = Math.max(1, Number(rule.step) || 1),
            base = Number(rule.basePrice) || current,
            dir = rule.direction === "down" ? "down" : "up",
            idx = Math.round((current - base) / step);
          return { level: base + (dir === "up" ? idx + 1 : idx - 1) * step, dir };
        }
        if (rule.kind === "volatility") {
          const move = (rule.direction === "down" ? -1 : 1) * (Number(rule.threshold) || 0);
          return { level: current, dir: move >= 0 ? "up" : "down", move, start: current - move };
        }
        return null;
      };
      const pushRuleTest = async (current, rule, saved = false) => {
        if (!localKeyOk() && !cloudReady())
          throw new Error(
            tx(
              "请先在「推送设置」中配置并启用至少一个推送渠道（Server酱 / 钉钉 / 飞书 / Bark / Webhook 均可）。",
              "Configure and enable at least one push channel in Settings first (ServerChan / DingTalk / Feishu / Bark / Webhook).",
            ),
          );
        const m = buildMessage(rule, current, { test: true, event: testEventFor(rule, current), savedRule: saved });
        if (localKeyOk())
          await sendViaServerChan(new URLSearchParams({ title: m.title, short: m.short, desp: m.desp }));
        else
          await sendCloudCustom({
            price: current,
            categoryLabel: cloudCategoryLabel(rule.kind, m.direction === "up"),
            phrase: m.short,
            note: m.desp,
            direction: m.direction,
            test: true, // 测试按钮：云端标题同样挂【测试】
          });
      };
      const matched = (r, from, to) => {
        if (r.kind === "price_reached")
          return (from - r.targetPrice) * (to - r.targetPrice) <= 0 && from !== to;
        const up = r.kind === "price_above" || r.kind === "short_liquidation";
        return up
          ? from < r.targetPrice && to >= r.targetPrice
          : from > r.targetPrice && to <= r.targetPrice;
      };
      const isNewMode = (r) => LOCAL_ONLY_KINDS.includes(r.kind);
      // 整数推送：跟踪当前整数位，价格跨越 step 边界即触发（向上/向下/双向）
      const evalRound = (r, current) => {
        if (!Number.isFinite(Number(r.step)) || r.step <= 0) return null;
        if (!Number.isFinite(Number(r._roundLevel))) r._roundLevel = Math.floor(current / r.step) * r.step;
        let hit = null,
          dir = null;
        while ((r.direction === "up" || r.direction === "both") && current >= r._roundLevel + r.step) {
          r._roundLevel += r.step;
          hit = r._roundLevel;
          dir = "up";
        }
        while ((r.direction === "down" || r.direction === "both") && current <= r._roundLevel - r.step) {
          r._roundLevel -= r.step;
          hit = r._roundLevel;
          dir = "down";
        }
        return hit == null ? null : { level: hit, dir };
      };
      // 自定义推送：相对基准价格，每跨越一个 step 网格触发（双向可只上/只下）
      const evalGrid = (r, current) => {
        if (!Number.isFinite(Number(r.basePrice)) || !Number.isFinite(Number(r.step)) || r.step <= 0) return null;
        const idx = Math.round((current - r.basePrice) / r.step);
        if (r._gridIdx === undefined) r._gridIdx = idx;
        if (idx === r._gridIdx) return null;
        if (idx > r._gridIdx && r.direction === "down") return null;
        if (idx < r._gridIdx && r.direction === "up") return null;
        const dir = idx > r._gridIdx ? "up" : "down";
        r._gridIdx = idx;
        return { level: r.basePrice + idx * r.step, dir };
      };
      // 快速挣扎推送：滚动窗口内的累计涨跌幅超阈值即触发
      const evalVol = (r, current, now) => {
        if (!Number.isFinite(Number(r.windowMinutes)) || r.windowMinutes <= 0 ||
            !Number.isFinite(Number(r.threshold)) || r.threshold <= 0) return null;
        r._volBuffer = Array.isArray(r._volBuffer) ? r._volBuffer : [];
        r._volBuffer.push({ t: now, price: current });
        const cutoff = now - r.windowMinutes * 60000;
        while (r._volBuffer.length && r._volBuffer[0].t < cutoff) r._volBuffer.shift();
        if (r._volBuffer.length < 2) return null;
        const start = r._volBuffer[0],
          move = current - start.price;
        const hit = () => ({ level: current, move, start: start.price, dir: move >= 0 ? "up" : "down" });
        if (r.direction === "up" && move >= r.threshold) return hit();
        if (r.direction === "down" && move <= -r.threshold) return hit();
        if (r.direction === "both" && Math.abs(move) >= r.threshold) return hit();
        return null;
      };
      const evaluateMode = (r, current, now) => {
        if (r.kind === "round_number") return evalRound(r, current);
        if (r.kind === "custom_grid") return evalGrid(r, current);
        if (r.kind === "volatility") return evalVol(r, current, now);
        return null;
      };
      const syncMarkPrice = () => {
        const mark = $("useLocalMark"),
          current = price();
        if (mark) mark.textContent = Number.isFinite(current) ? fmt(current) : "--";
      };
      setInterval(() => {
        syncMarkPrice();
        const current = price();
        if (!Number.isFinite(current)) return;
        if (previous === null) {
          previous = current;
          return;
        }
        if (pushSettings.masterEnabled === false) {
          previous = current;
          return;
        }
        const now = Date.now();
        for (const r of rules) {
          if (r.cloudManaged) continue;
          if (isNewMode(r)) {
            /* 三种新模式：浏览器端滚动评价（整数位 / 基准网格 / 波动窗口），
               命中即用冷却节流；波动模式每拍都采样以维持滚动窗口。 */
            const ev = evaluateMode(r, current, now);
            if (!ev) continue;
            const newGap = Math.max(1, Number(r.cooldownMinutes) || 1) * 60_000;
            if (r.lastTriggeredAt && now - r.lastTriggeredAt < newGap) continue;
            r.lastTriggeredAt = now;
            r.lastTriggeredPrice = current;
            r._eventLevel = ev.level;
            r._eventMove = ev.move;
            r._eventStart = ev.start;
            r._eventDir = ev.dir;
            save();
            render();
            if (r.voiceEnabled)
              window.dispatchEvent(
                new CustomEvent("btc:voice-alert", { detail: { rule: r, price: current } }),
              );
            push(current, r, ev).catch(() => {});
            continue;
          }
          if (r.repeat === false && r.lastTriggeredAt) continue;
          const gap =
            r.repeat === false
              ? 0
              : Math.max(1, Number(r.cooldownMinutes) || 1) * 60_000;
          if (
            matched(r, previous, current) &&
            (!gap || !r.lastTriggeredAt || now - r.lastTriggeredAt >= gap)
          ) {
            r.lastTriggeredAt = now;
            r.lastTriggeredPrice = current;
            save();
            render();
            if (r.voiceEnabled)
              window.dispatchEvent(
                new CustomEvent("btc:voice-alert", {
                  detail: { rule: r, price: current },
                }),
              );
            push(current, r).catch(() => {});
          }
        }
        previous = current;
      }, 1_000);
      $("clearLocalAlerts").onclick = () => {
        if (!rules.length) return;
        showAppDialog({
          title: "确认批量删除",
          message: "确定删除全部本机推送规则吗？",
          confirmText: "全部删除",
          cancelText: "取消",
          onConfirm: () => {
            rules = [];
            save();
            render();
          },
        });
      };
      $("pushTestSend").onclick = async () => {
        const current = price();
        if (!Number.isFinite(current)) {
          alert("实时价格尚未加载，请稍后重试。");
          return;
        }
        try {
          if (cloudSession.loggedIn) {
            const response = await fetch("/api/alerts/test", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ price: current }),
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok)
              throw new Error(payload.error || "云端测试失败");
            const okCount = (payload.results || []).filter((r) => r.ok).length,
              totalCount = (payload.results || []).length;
            showAppDialog({
              title: "云端测试已发送",
              message: totalCount
                ? `测试推送已提交到 ${okCount}/${totalCount} 个启用渠道，请逐渠道查收。`
                : "测试推送已由服务器提交。",
            });
          } else {
            await push(current);
            showAppDialog({
              title: "本机测试已发送",
              message: "测试推送请求已由当前浏览器发出，请查看微信。",
            });
          }
        } catch (error) {
          showAppDialog({ title: tx("消息推送", "Message alerts"), message: error.message });
        }
      };
      $("localRuleTest").onclick = async () => {
        const current = price();
        if (!Number.isFinite(current)) {
          alert("实时价格尚未加载，请稍后重试。");
          return;
        }
        try {
          await pushRuleTest(current, collectDraft());
          showRuleNotice(true);
        } catch (error) {
          alert(error.message);
        }
      };
      // 模式切换：只显示当前模式需要的字段；非价格模式恒为重复型，冷却始终可见
      const applyMode = () => {
        const mode = form.elements.mode.value;
        form.querySelectorAll("[data-mode-fields]").forEach((box) => {
          box.hidden = box.dataset.modeFields !== mode;
        });
        $("localCooldown").hidden = mode === "price" ? !repeat : false;
      };
      // 从表单读取一份「规则草稿」（供保存与测试推送共用）
      const collectDraft = () => {
        const mode = form.elements.mode.value,
          cooldown = Math.max(1, Number(form.elements.cooldown.value) || 5),
          voiceEnabled = form.elements.voiceEnabled.checked,
          base = { id: editingId || crypto.randomUUID(), repeat: mode === "price" ? repeat : true, cooldownMinutes: cooldown, voiceEnabled, lastTriggeredAt: null };
        if (mode === "round_number") {
          const step = Number(form.elements.roundStep.value);
          if (!Number.isFinite(step) || step <= 0) throw new Error(tx("请填写有效的整数步长（> 0）。", "Enter a valid round step (> 0)."));
          return { ...base, kind: "round_number", step, direction: form.elements.roundDir.value };
        }
        if (mode === "custom_grid") {
          const basePrice = Number(form.elements.basePrice.value),
            step = Number(form.elements.gridStep.value);
          if (!Number.isFinite(basePrice) || basePrice <= 0) throw new Error(tx("请填写有效的基准价格。", "Enter a valid base price."));
          if (!Number.isFinite(step) || step <= 0) throw new Error(tx("请填写有效的间隔（> 0）。", "Enter a valid step (> 0)."));
          return { ...base, kind: "custom_grid", basePrice, step, direction: form.elements.gridDir.value };
        }
        if (mode === "volatility") {
          const windowMinutes = Number(form.elements.volWindow.value),
            threshold = Number(form.elements.volThreshold.value);
          if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) throw new Error(tx("请填写有效的时间窗口。", "Enter a valid window."));
          if (!Number.isFinite(threshold) || threshold <= 0) throw new Error(tx("请填写有效的波动阈值。", "Enter a valid move threshold."));
          return { ...base, kind: "volatility", windowMinutes, threshold, direction: form.elements.volDir.value };
        }
        const targetPrice = Number(form.elements.target.value);
        if (!Number.isFinite(targetPrice) || targetPrice <= 0) throw new Error(tx("请先填写有效的规则价格。", "Enter a valid rule price."));
        return { ...base, kind: form.elements.kind.value, targetPrice };
      };
      const show = (open) => {
        modal.hidden = !open;
        if (open) {
          editingId = null;
          $("localAlertModalTitle").textContent = tx("添加预警", "Add alert");
          repeat = false;
          form.elements.mode.value = "price";
          form
            .querySelectorAll("[data-local-frequency]")
            .forEach((button) =>
              button.classList.toggle(
                "active",
                button.dataset.localFrequency === "once",
              ),
            );
          applyMode();
          syncMarkPrice();
        }
      };
      // 编辑已有规则：回填表单并切换弹窗为「编辑预警」模式（提交时原位替换，不新增）
      const openEdit = (rule) => {
        show(true);
        editingId = rule.id;
        $("localAlertModalTitle").textContent = tx("编辑预警", "Edit alert");
        const set = (name, v) => {
          if (form.elements[name] && Number.isFinite(Number(v)))
            form.elements[name].value = v;
        };
        if (isNewMode(rule)) {
          form.elements.mode.value = rule.kind;
          form.elements.mode.dispatchEvent(new Event("change"));
          if (rule.kind === "round_number") {
            set("roundStep", rule.step);
            form.elements.roundDir.value = rule.direction || "both";
          } else if (rule.kind === "custom_grid") {
            set("basePrice", rule.basePrice);
            set("gridStep", rule.step);
            form.elements.gridDir.value = rule.direction || "both";
          } else {
            set("volWindow", rule.windowMinutes);
            set("volThreshold", rule.threshold);
            form.elements.volDir.value = rule.direction || "both";
          }
        } else {
          form.elements.kind.value = rule.kind;
          set("target", rule.targetPrice);
          repeat = rule.repeat !== false;
          form
            .querySelectorAll("[data-local-frequency]")
            .forEach((button) =>
              button.classList.toggle(
                "active",
                (button.dataset.localFrequency === "repeat") === repeat,
              ),
            );
          applyMode();
        }
        form.elements.voiceEnabled.checked = Boolean(rule.voiceEnabled);
        form.elements.cooldown.value = Math.max(1, Number(rule.cooldownMinutes) || 5);
      };
      $("openLocalAlert").onclick = () => show(true);
      $("closeLocalAlert").onclick = () => show(false);
      form.elements.mode.onchange = applyMode;
      $("useLocalMark").onclick = () => {
        const current = price();
        if (Number.isFinite(current))
          form.elements.target.value = current.toFixed(2);
      };
      $("useLocalMarkBase").onclick = () => {
        const current = price();
        if (Number.isFinite(current))
          form.elements.basePrice.value = current.toFixed(2);
      };
      form.querySelectorAll("[data-local-frequency]").forEach(
        (b) =>
          (b.onclick = () => {
            repeat = b.dataset.localFrequency === "repeat";
            form
              .querySelectorAll("[data-local-frequency]")
              .forEach((x) => x.classList.toggle("active", x === b));
            applyMode();
          }),
      );
      form.onsubmit = (e) => {
        e.preventDefault();
        let rule;
        try {
          rule = collectDraft();
        } catch (error) {
          showAppDialog({ title: editingId ? tx("编辑预警", "Edit alert") : tx("添加预警", "Add alert"), message: error.message });
          return;
        }
        if (editingId) {
          // 原位替换：保留触发历史；编辑后参数变了，内部游标（_roundLevel/_gridIdx 等）天然不带过来，会按新参数重新锚定
          const idx = rules.findIndex((r) => r.id === editingId);
          if (idx >= 0)
            rule = {
              ...rule,
              lastTriggeredAt: rules[idx].lastTriggeredAt,
              lastTriggeredPrice: rules[idx].lastTriggeredPrice,
            };
          rules = idx >= 0 ? rules.map((r) => (r.id === editingId ? rule : r)) : [...rules, rule];
          editingId = null;
        } else {
          rules.push(rule);
        }
        save();
        form.reset();
        repeat = false;
        show(false);
        render();
      };
      window.addEventListener("btc:cloud-rules-synced", () => { window.btcSecureVault?.get(vaultKeyFor()).then(saved=>{if(Array.isArray(saved?.rules))rules=saved.rules;render()}).catch(()=>render()); });
      window.addEventListener("btc:account-state", async (event) => {
        cloudSession = {
          loggedIn: Boolean(event.detail?.loggedIn),
          hasSendKey: Boolean(event.detail?.hasSendKey),
        };
        await loadCloudState();
        render();
      });
      render();
      // 切换币种：按新币种重新读取本机规则并重渲染（每币种独立存储，默认空、已添加则保留、未添加则为无）
      window.addEventListener("btc:coin-changed", async () => {
        const reloaded = await loadRules();
        rules = reloaded.rules;
        if (reloaded.sendKey) sessionStorage.setItem(keyStore, reloaded.sendKey);
        // 重置价格基准：跨币种价格量级不同，沿用旧基准会把切换瞬间当成暴涨暴跌误触发
        previous = null;
        render();
      });
    }, 0);
  },
};
