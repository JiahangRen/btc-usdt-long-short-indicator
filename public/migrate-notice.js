/* 旧站迁移告知横幅 / Legacy-domain migration notice
 * ---------------------------------------------------------------------------
 * 只在旧域名 renjiahang1201.xyz 下注入，引导访客改用新站 jeffereyreng.site。
 * 两台服务器跑的是同一份代码（只有 SITE_DOMAIN 不同），所以这里必须按
 * location.hostname 判断 —— 否则新站自己也会弹「请前往新站」。
 *
 * 本地/预览强制显示：在 URL 后加 ?migrateNotice=1（便于 127.0.0.1:8787 验收）。
 * Injected on the legacy domain only; the new site and localhost stay clean.
 */
(function () {
  "use strict";

  var LEGACY_HOSTS = ["renjiahang1201.xyz"];
  var NEW_URL = "https://jeffereyreng.site/";
  var NEW_LABEL = "jeffereyreng.site";
  var DISMISS_KEY = "btc_migrate_notice_until";
  var DISMISS_DAYS = 7;

  var host = String(location.hostname || "").toLowerCase();
  var forced = /[?&]migrateNotice=1(?:&|$)/.test(location.search);
  var isLegacy = false;
  for (var i = 0; i < LEGACY_HOSTS.length; i++) {
    var h = LEGACY_HOSTS[i];
    if (host === h || host.slice(-(h.length + 1)) === "." + h) {
      isLegacy = true;
      break;
    }
  }
  if (!isLegacy && !forced) return;

  function readDismissed() {
    try {
      return Number(localStorage.getItem(DISMISS_KEY) || 0);
    } catch (e) {
      return 0; // 隐私模式下读不到，照常显示
    }
  }
  if (!forced && readDismissed() > Date.now()) return;

  var COPY = {
    zh: {
      badge: "迁移公告",
      title: "本站已迁移到新域名 " + NEW_LABEL,
      text: "旧域名继续可用，但后续更新与新功能都会发布到新站，建议改用新站并更新书签。",
      cta: "前往新站",
      close: "关闭（" + DISMISS_DAYS + " 天内不再提示）",
    },
    en: {
      badge: "Moved",
      title: "We have moved to " + NEW_LABEL,
      text: "This legacy address stays online, but all future updates ship to the new site. Please switch over and update your bookmark.",
      cta: "Open the new site",
      close: "Dismiss (" + DISMISS_DAYS + "-day reminder)",
    },
  };

  function currentLang() {
    var stored = "";
    try {
      stored = localStorage.getItem("btc_lang") || "";
    } catch (e) {}
    if (/^en/i.test(stored)) return "en";
    if (/^zh/i.test(stored)) return "zh";
    return /^en/i.test(document.documentElement.lang || "") ? "en" : "zh";
  }

  var CSS = [
    ".btc-migrate-notice{",
    "  --mn-bg:linear-gradient(100deg,rgba(23,28,38,.96),rgba(32,27,48,.96));",
    "  --mn-fg:#e8eaed;",
    "  --mn-dim:#9aa4b2;",
    "  --mn-border:rgba(34,211,238,.34);",
    "  --mn-cta:linear-gradient(100deg,#0891b2,#7c3aed);",
    "  position:relative;display:flex;align-items:center;gap:11px;flex-wrap:wrap;",
    "  margin:0 0 12px;padding:10px 12px 10px 14px;border:1px solid var(--mn-border);",
    "  border-radius:14px;background:var(--mn-bg);color:var(--mn-fg);",
    "  box-shadow:inset 1px 1px 0 rgba(255,255,255,.06),0 8px 26px rgba(0,0,0,.30);",
    "  font-size:13px;line-height:1.45;z-index:30;",
    "}",
    "html[data-theme=light] .btc-migrate-notice{",
    "  --mn-bg:linear-gradient(100deg,rgba(255,255,255,.97),rgba(240,242,255,.97));",
    "  --mn-fg:#16202e;--mn-dim:#54626f;--mn-border:rgba(14,116,144,.32);",
    "  box-shadow:inset 1px 1px 0 rgba(255,255,255,.9),0 8px 22px rgba(24,40,64,.14);",
    "}",
    "@media (prefers-color-scheme:light){",
    "  html[data-theme=auto] .btc-migrate-notice{",
    "    --mn-bg:linear-gradient(100deg,rgba(255,255,255,.97),rgba(240,242,255,.97));",
    "    --mn-fg:#16202e;--mn-dim:#54626f;--mn-border:rgba(14,116,144,.32);",
    "    box-shadow:inset 1px 1px 0 rgba(255,255,255,.9),0 8px 22px rgba(24,40,64,.14);",
    "  }",
    "}",
    ".btc-migrate-notice .btc-mn-badge{",
    "  flex:none;padding:2px 7px;border-radius:6px;border:1px solid var(--mn-border);",
    "  color:#22d3ee;font-size:11px;font-weight:700;letter-spacing:.06em;white-space:nowrap;",
    "}",
    "html[data-theme=light] .btc-migrate-notice .btc-mn-badge{color:#0e7490;}",
    "@media (prefers-color-scheme:light){",
    "  html[data-theme=auto] .btc-migrate-notice .btc-mn-badge{color:#0e7490;}",
    "}",
    ".btc-migrate-notice .btc-mn-body{flex:1 1 260px;min-width:0;}",
    ".btc-migrate-notice .btc-mn-title{",
    "  margin:0;color:var(--mn-fg);font-size:13.5px;font-weight:700;",
    "}",
    ".btc-migrate-notice .btc-mn-text{margin:2px 0 0;color:var(--mn-dim);font-size:12.5px;}",
    ".btc-migrate-notice .btc-mn-cta{",
    "  flex:none;display:inline-flex;align-items:center;gap:6px;padding:7px 14px;",
    "  border-radius:999px;background:var(--mn-cta);color:#fff !important;",
    "  font-size:12.5px;font-weight:700;text-decoration:none;white-space:nowrap;",
    "  box-shadow:0 4px 14px rgba(34,211,238,.26);",
    "}",
    ".btc-migrate-notice .btc-mn-cta:hover{filter:brightness(1.12);}",
    ".btc-migrate-notice .btc-mn-close{",
    "  flex:none;width:26px;height:26px;padding:0;border-radius:50%;cursor:pointer;",
    "  border:1px solid var(--mn-border);background:transparent;",
    "  color:var(--mn-dim) !important;font-size:15px;line-height:1;",
    "  display:inline-flex;align-items:center;justify-content:center;",
    "}",
    ".btc-migrate-notice .btc-mn-close:hover{color:var(--mn-fg) !important;}",
    "@media (max-width:640px){",
    "  .btc-migrate-notice{padding:9px 10px;gap:8px;font-size:12.5px;}",
    "  .btc-migrate-notice .btc-mn-body{flex:1 1 100%;}",
    "  .btc-migrate-notice .btc-mn-cta{margin-left:auto;}",
    "}",
  ].join("");

  function installStyles() {
    if (document.getElementById("btcMigrateNoticeStyle")) return;
    var style = document.createElement("style");
    style.id = "btcMigrateNoticeStyle";
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  var el = document.createElement("div");
  el.className = "btc-migrate-notice";
  el.setAttribute("role", "region");
  el.innerHTML =
    '<span class="btc-mn-badge"></span>' +
    '<div class="btc-mn-body"><p class="btc-mn-title"></p><p class="btc-mn-text"></p></div>' +
    '<a class="btc-mn-cta" href="' + NEW_URL + '" target="_blank" rel="noopener"></a>' +
    '<button class="btc-mn-close" type="button"></button>';

  var badgeEl = el.querySelector(".btc-mn-badge");
  var titleEl = el.querySelector(".btc-mn-title");
  var textEl = el.querySelector(".btc-mn-text");
  var ctaEl = el.querySelector(".btc-mn-cta");
  var closeEl = el.querySelector(".btc-mn-close");

  function applyCopy() {
    var t = COPY[currentLang()] || COPY.zh;
    badgeEl.textContent = t.badge;
    titleEl.textContent = t.title;
    textEl.textContent = t.text;
    ctaEl.textContent = t.cta + " →";
    ctaEl.setAttribute("aria-label", t.cta + " " + NEW_LABEL);
    closeEl.textContent = "×";
    closeEl.setAttribute("aria-label", t.close);
    closeEl.title = t.close;
    el.setAttribute("aria-label", t.badge);
  }

  function dismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now() + DISMISS_DAYS * 86400000));
    } catch (e) {}
    el.style.transition = "opacity .18s ease, transform .18s ease";
    el.style.opacity = "0";
    el.style.transform = "translateY(-6px)";
    setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 200);
  }
  closeEl.addEventListener("click", dismiss);

  // 智能顶栏（app.js）会把 main > header 改成 fixed 并紧跟其后插一个
  // .header-slot 占位块。以「占位块优先、header 兜底」为锚点插入，
  // 这样无论两边谁先执行，横幅都落在占位块之后、顶栏下方，不会被压住。
  function mount() {
    if (el.parentNode) return true;
    var header = document.querySelector("main > header");
    if (!header) return false;
    var anchor = document.querySelector(".header-slot") || header;
    anchor.insertAdjacentElement("afterend", el);
    return true;
  }

  installStyles();
  applyCopy();

  try {
    new MutationObserver(applyCopy).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["lang"],
    });
  } catch (e) {}

  if (!mount()) {
    document.addEventListener(
      "DOMContentLoaded",
      function () {
        if (!mount()) setTimeout(mount, 600); // app.js 出错也要能挂上
      },
      { once: true },
    );
  }
})();
