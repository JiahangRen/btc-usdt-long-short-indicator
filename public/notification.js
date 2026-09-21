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

        const sanitize = (arr) =>
          (Array.isArray(arr) ? arr : [])
            .filter((x) => x && x.id && Number(x.targetPrice) > 0)
            .slice(0, 30)
            .map((x) => ({
              ...x,
              kind: x.kind || "price_reached",
              repeat: x.repeat === false ? false : true,
              cooldownMinutes: Math.max(1, Number(x.cooldownMinutes) || 5),
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

      const card = document.createElement("section"),
        details = document.createElement("details");
      details.id = "wechatAlertDetails";
      details.className = "position-details alert-details";
      details.innerHTML = `<summary>${tx("消息推送", "Message alerts")}</summary>`;
      card.id = "wechatAlertCard";
      card.className = "card wechat-alert-card";
      /* v2.10.53 结构：标题行 → 总开关行（右侧「推送设置」入口）→ 推送规则区
         （总开关打开时才显示；云面板插槽由 cloud-alerts.js 注入）。 */
      card.innerHTML = `<div class="forecast-head"><div><h2>${tx("消息推送", "Message alerts")}</h2><p id="localAlertDescription"></p></div><span id="localAlertState" class="badge flat"></span></div>`
        + `<div class="push-head-row"><label class="push-switch push-switch-row"><input type="checkbox" id="pushMasterSwitch"><span>${tx("启用消息推送", "Enable push")}</span></label><small id="pushMasterHint"></small><button type="button" id="openPushSettings" class="push-settings-btn">⚙ ${tx("推送设置", "Settings")}</button></div>`
        + `<div id="pushMasterBody"><div class="alert-rule-toolbar"><b>${tx("推送规则", "Push rules")}<small>${coinMark()}${coinPairPlain()} · ${tx("永续", "Perpetual")}</small></b><div><button type="button" id="clearLocalAlerts" class="danger">${tx("批量全删", "Delete all")}</button><button type="button" id="openLocalAlert">＋ ${tx("添加预警", "Add alert")}</button></div></div><div id="localAlertList" class="wechat-alert-detail"></div>`
        + `<div id="lossPushSection" class="loss-push-box"><label class="push-switch push-switch-row"><input type="checkbox" id="lossPushEnabled"><span>${tx("亏损推送（联动持仓）", "Loss push (linked to positions)")}</span></label><div class="loss-push-fields"><label>${tx("警告 ROE ≤", "Warn ROE ≤")}<input id="lossWarnRoe" type="number" min="1" max="1000" step="1"></label><label>${tx("推送 ROE ≤", "Push ROE ≤")}<input id="lossLossRoe" type="number" min="1" max="1000" step="1"></label><label>${tx("冷却（分钟）", "Cooldown (min)")}<input id="lossCooldown" type="number" min="1" max="1440" step="1"></label><button type="button" id="lossPushSave">${tx("保存设置", "Save")}</button></div><small>${tx("以「我的持仓」中各笔持仓的保证金收益率（ROE = 价格变动% × 杠杆）计算；任一持仓触发即向所有启用渠道推送。", "Computed from each saved position's ROE (price move % × leverage); any position crossing a threshold pushes to all enabled channels.")}</small></div></div>`
        + `<div id="cloudAlertPanel" class="cloud-alert-panel"></div>`
        + `<div id="localAlertModal" class="alert-composer" hidden><section><header><b>${tx("添加预警", "Add alert")}</b><button type="button" id="closeLocalAlert">×</button></header><p class="alert-symbol">${coinMark()}<b>${coinPairPlain()} ${tx("永续", "Perpetual")}</b></p><form id="localAlertForm"><label>${tx("预警类型", "Alert type")}<select name="kind"><option value="price_reached">${tx("价格达到", "Price reached")}</option><option value="price_above">${tx("价格上涨至", "Price rises to")}</option><option value="price_below">${tx("价格下跌至", "Price falls to")}</option><option value="long_liquidation">${tx("多头爆仓价", "Long liquidation")}</option><option value="short_liquidation">${tx("空头爆仓价", "Short liquidation")}</option></select></label><label>${tx("价格", "Price")}<span class="mark-price">${tx("市价", "Mark")} <button type="button" id="useLocalMark">--</button></span><input name="target" type="number" step="0.01" min="0" required placeholder="0.00"></label><div class="frequency-toggle"><button type="button" data-local-frequency="once" class="active">${tx("仅一次", "Once")}</button><button type="button" data-local-frequency="repeat">${tx("重复", "Repeat")}</button></div><label id="localCooldown" hidden>${tx("冷却时间（分钟）", "Cooldown (minutes)")}<input name="cooldown" type="number" min="1" step="1" value="5"></label><label class="voice-rule-toggle">${tx("同时语音播报", "Also announce by voice")}<input name="voiceEnabled" type="checkbox"></label><button class="alert-submit">${tx("保存预警", "Save alert")}</button></form></section></div>`
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
      details.append(card);
      (main.querySelector("footer") || main.lastElementChild).before(details);
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
      const localKey = () => (sessionStorage.getItem(keyStore) || "").trim(),
        localKeyOk = () => /^SCT/i.test(localKey());
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
        })[kind] || kind;
      const alertCategory = (kind) =>
        kind === "long_liquidation" || kind === "short_liquidation"
          ? tx("爆仓告警", "Liquidation alert")
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
      const triggerText = (rule) =>
        rule.lastTriggeredAt
          ? `${new Date(rule.lastTriggeredAt).toLocaleString(getLang() === "zh" ? "zh-CN" : "en-US", { hour12: false })} · ${tx("实时", "Live")} ${Number.isFinite(Number(rule.lastTriggeredPrice)) ? `${fmt(rule.lastTriggeredPrice)} USDT` : "--"}`
          : "";

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
                    triggered =
                      !cloudManaged && r.repeat === false && r.lastTriggeredAt;
                  return `<article class="${cloudManaged ? "cloud-managed-rule" : ""}"><span><b>${coinPairPlain()} ${tx("价格预警", "price alert")}</b><small>${label(r.kind)} ${fmt(r.targetPrice)} · ${r.repeat === false ? tx("仅提醒一次", "Once only") : tx(`重复提醒 · ${r.cooldownMinutes} 分钟冷却`, `Repeat · ${r.cooldownMinutes} min cooldown`)}</small>${triggered ? `<small class="notification-triggered">${tx("已触发执行：", "Triggered: ")}${triggerText(r)}</small>` : ""}</span><em class="${cloudManaged ? "cloud-managed" : triggered ? "flat" : "bull"}">${cloudManaged ? tx("云端接管", "Cloud-managed") : triggered ? tx("已执行", "Executed") : tx("本地触发", "Local")}</em><button type="button" data-remove-local-alert="${r.id}">${tx("删除", "Delete")}</button></article>`;
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
          setText("#wechatAlertDetails summary", "消息推送", "Message alerts");
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
      const push = async (current, rule = null) => {
        if (!localKeyOk()) throw new Error("请先在「推送设置」中保存有效的本机 SendKey。");
        const currentText = fmt(current),
          targetText = rule ? fmt(rule.targetPrice) : currentText,
          phrase = rule
            ? alertPhrase(rule.kind, targetText)
            : `${coinPairPlain()} 当前价格 ${currentText}`,
          title = rule
            ? alertTitle(rule.kind, targetText)
            : `价格告警【测试】 ${phrase}`,
          short = rule
            ? alertShort(rule.kind, targetText)
            : `${coinPairPlain()} 当前价格 ${currentText} USDT`,
          body = new URLSearchParams({
            title,
            short,
            desp: rule
              ? `${title}\n\n${phrase} USDT\n触发时市价 ${currentText} USDT`
              : `${title}\n\n${phrase} USDT`,
          });
        await sendViaServerChan(body);
      };
      const pushRuleTest = async (current, rule) => {
        if (!localKeyOk()) throw new Error("请先在「推送设置」中保存有效的本机 SendKey。");
        const targetText = fmt(rule.targetPrice),
          currentText = fmt(current),
          phrase = alertPhrase(rule.kind, targetText),
          title = alertTitle(rule.kind, targetText, { test: true }),
          body = new URLSearchParams({
            title,
            short: alertShort(rule.kind, targetText),
            desp: `${title}\n\n${phrase} USDT\n当前市价 ${currentText} USDT\n\n该规则不会被保存。`,
          });
        await sendViaServerChan(body);
      };
      const matched = (r, from, to) => {
        if (r.kind === "price_reached")
          return (from - r.targetPrice) * (to - r.targetPrice) <= 0 && from !== to;
        const up = r.kind === "price_above" || r.kind === "short_liquidation";
        return up
          ? from < r.targetPrice && to >= r.targetPrice
          : from > r.targetPrice && to <= r.targetPrice;
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
          if (r.cloudManaged || (r.repeat === false && r.lastTriggeredAt)) continue;
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
        const target = Number(form.elements.target.value),
          current = price();
        if (!Number.isFinite(target) || target <= 0) {
          alert("请先填写有效的规则价格。");
          return;
        }
        if (!Number.isFinite(current)) {
          alert("实时价格尚未加载，请稍后重试。");
          return;
        }
        try {
          await pushRuleTest(current, {
            kind: form.elements.kind.value,
            targetPrice: target,
          });
          showRuleNotice(true);
        } catch (error) {
          alert(error.message);
        }
      };
      const show = (open) => {
        modal.hidden = !open;
        if (open) {
          repeat = false;
          form
            .querySelectorAll("[data-local-frequency]")
            .forEach((button) =>
              button.classList.toggle(
                "active",
                button.dataset.localFrequency === "once",
              ),
            );
          $("localCooldown").hidden = true;
          syncMarkPrice();
        }
      };
      $("openLocalAlert").onclick = () => show(true);
      $("closeLocalAlert").onclick = () => show(false);
      $("useLocalMark").onclick = () => {
        const current = price();
        if (Number.isFinite(current))
          form.elements.target.value = current.toFixed(2);
      };
      form.querySelectorAll("[data-local-frequency]").forEach(
        (b) =>
          (b.onclick = () => {
            repeat = b.dataset.localFrequency === "repeat";
            form
              .querySelectorAll("[data-local-frequency]")
              .forEach((x) => x.classList.toggle("active", x === b));
            $("localCooldown").hidden = !repeat;
          }),
      );
      form.onsubmit = (e) => {
        e.preventDefault();
        const target = Number(form.elements.target.value),
          cooldown = Math.max(1, Number(form.elements.cooldown.value) || 1);
        if (!Number.isFinite(target) || target <= 0) return;
        rules.push({
          id: crypto.randomUUID(),
          kind: form.elements.kind.value,
          targetPrice: target,
          repeat,
          cooldownMinutes: cooldown,
          voiceEnabled: form.elements.voiceEnabled.checked,
          lastTriggeredAt: null,
        });
        save();
        form.reset();
        repeat = false;
        $("localCooldown").hidden = true;
        form.querySelector('[data-local-frequency="once"]').click();
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
