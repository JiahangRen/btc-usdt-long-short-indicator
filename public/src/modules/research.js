// 研究预测（E）模块：原 app.js 的「BTC 多因子研究预测」渲染 + 加载
// + 完整专用 i18n 映射 + ensureResearchOutlookCard（研究卡挂载）。所有研究渲染逻辑收进本模块；
// app.js 仅保留卡面布局调度（syncMacroPanels 经 setter 注入）与语言切换钩子（rerenderResearchOutlook）。
import { $, tx, pct, safeText, coinLabel, addHelp, apiFetch, money, pointTime, safeHref, uiLang } from '../core.js?v=20260928a';

// app.js 的宏观编排函数 syncMacroPanels 经此注入，避免模块反向依赖 app.js 造成循环引用。
let syncMacroPanelsImpl = () => {};
export function setSyncMacroPanels(fn) { syncMacroPanelsImpl = typeof fn === 'function' ? fn : () => {}; }

// 研究卡加载态（原 app.js 模块级状态，仅研究预测使用）。
let researchOutlookLoading = false;

const RESEARCH_WINDOW_LABELS = {
  "约 15 分钟": "~15 min",
  "约 1 小时": "~1 hour",
  "约 4 小时": "~4 hours",
  "约 1 天": "~1 day",
  "约 1 日": "~1 day",
};
const txWinLabel = (v) => (uiLang === "zh" ? v : RESEARCH_WINDOW_LABELS[v] || v);
function ensureResearchOutlookCard() {
  let card = $("researchOutlookCard");
  if (!card) {
    card = document.createElement("section");
    card.id = "researchOutlookCard";
    card.className = "card research-outlook-card";
    // v2.12.42p：先挂到 main 末尾，具体顺序由 app.js 的 normalizePanelReadingOrder() 统一校正。
    // 避免 renderPatternAnalysis / ensureResearchOutlookCard / normalizePanelReadingOrder
    // 三处各自移动卡片导致 MutationObserver 循环。
    document.querySelector("main")?.append(card);
  }
  // v2.11.9：研究卡之后的整条链（宏观事件中枢 → 宏观环境与联动）
  // 统一交给 syncMacroPanels 校正。这里不再单独把日历卡搬到研究卡后面。
  syncMacroPanelsImpl();
  return card;
}
function researchDirectionText(direction) {
  return direction === "up"
    ? tx("上涨预期", "Upside expected")
    : direction === "down"
      ? tx("下跌预期", "Downside expected")
      : tx("稳定 / 震荡", "Stable / range");
}
function researchDirectionClass(direction) {
  return direction === "up" ? "bull" : direction === "down" ? "bear" : "flat";
}
function researchAge(value) {
  return Number.isFinite(value) ? pointTime(value) : tx("刚刚", "Just now");
}
// Probability wording separates confidence strength from the side that has the edge.
// 概率文案将“信号强度”与“哪一侧占优”分开表达。
function researchProbabilityLabel(probability) {
  const isUp = probability >= 50,
    confidence = isUp ? probability : 100 - probability,
    side = isUp ? "bull" : "bear";
  if (confidence < 56)
    return {
      kind: "flat",
      side,
      title: tx("中性震荡", "Neutral range"),
      detail: tx(
        isUp
          ? `偏多 ${confidence.toFixed(1)}%`
          : `偏空 ${confidence.toFixed(1)}%`,
        isUp
          ? `Slightly bullish ${confidence.toFixed(1)}%`
          : `Slightly bearish ${confidence.toFixed(1)}%`,
      ),
    };
  if (confidence < 65)
    return {
      kind: side,
      side,
      title: tx(
        isUp ? "轻度看多" : "轻度看空",
        isUp ? "Mildly bullish" : "Mildly bearish",
      ),
      detail: tx(
        isUp
          ? `上涨概率 ${confidence.toFixed(1)}%`
          : `下跌概率 ${confidence.toFixed(1)}%`,
        isUp
          ? `Up probability ${confidence.toFixed(1)}%`
          : `Down probability ${confidence.toFixed(1)}%`,
      ),
    };
  return {
    kind: side,
    side,
    title: tx(
      isUp ? "看多占优" : "看空占优",
      isUp ? "Bullish advantage" : "Bearish advantage",
    ),
    detail: tx(
      isUp
        ? `上涨概率 ${confidence.toFixed(1)}%`
        : `下跌概率 ${confidence.toFixed(1)}%`,
      isUp
        ? `Up probability ${confidence.toFixed(1)}%`
        : `Down probability ${confidence.toFixed(1)}%`,
    ),
  };
}
// Three-class wording: the largest of up / flat / down leads, and all three probabilities
// are printed so a 12% "up" can never be read as a conviction call.
// 三分类文案：偏多 / 震荡 / 偏空中概率最高者领先，并同时打印三个概率，避免 12% 的「偏多」被读成强烈信号。
function researchClassLabel(window) {
  const up = Number(window.upProbability) * 100,
    flat = Number(window.flatProbability) * 100,
    down = Number(window.downProbability) * 100,
    ranked = [
      { key: "up", value: up, side: "bull", title: tx("偏多占优", "Bullish lead") },
      { key: "flat", value: flat, side: "flat", title: tx("中性震荡", "Neutral range") },
      { key: "down", value: down, side: "bear", title: tx("偏空占优", "Bearish lead") },
    ].sort((a, b) => b.value - a.value),
    lead = ranked[0];
  return {
    kind: lead.key === "flat" ? "flat" : lead.side,
    side: lead.side,
    title: lead.title,
    up,
    flat,
    down,
    detail: `${tx("偏多", "Up")} ${up.toFixed(1)}% · ${tx("震荡", "Flat")} ${flat.toFixed(1)}% · ${tx("偏空", "Down")} ${down.toFixed(1)}%`,
  };
}
/* 缓存最近一次渲染入参。研究卡是整卡渲染（不像多数卡片那样逐节点替换文案），
   语言切换时必须用同一份数据就地重渲，标题与文案才会跟着走。 */
let researchOutlookData = null;
function renderResearchOutlook(data) {
  researchOutlookData = data || researchOutlookData;
  const card = ensureResearchOutlookCard();
  if (!card) return;
  const newsItems = (data.news?.items || []).slice(0, 6),
    newsRows = (items) =>
      items
        .map((item) => {
          const title = safeText(item.title),
            href = safeHref(item.url),
            category = safeText(item.category || "market");
          return `<li class="${item.sentiment > 0 ? "bull" : item.sentiment < 0 ? "bear" : "flat"}"><i>${item.sentiment > 0 ? tx("利好", "Positive") : item.sentiment < 0 ? tx("利空", "Negative") : tx("中性", "Neutral")}</i>${href === "#" ? `<span title="${title}">${title}</span>` : `<a href="${href}" target="_blank" rel="noopener noreferrer" title="${title}">${title}</a>`}<small>${safeText(item.source || "")} · ${category}</small></li>`;
        })
        .join("") ||
      `<li class="flat"><span>${tx("该时间窗暂无可用 " + coinLabel() + " 新闻。", "No " + coinLabel() + " headline is available in this window.")}</span></li>`,
    twoHourItems = newsItems.filter(
      (item) =>
        Number.isFinite(item.publishedAt) &&
        Date.now() - item.publishedAt <= 2 * 3_600_000,
    ),
    newsPanel = `<div class="research-news"><h3>${tx(coinLabel() + " 重点新闻（可点击查看原文）", coinLabel() + " priority headlines (click to open)")}</h3><div class="research-news-windows"><section><h4>${tx("近 2 小时", "Last 2 hours")}</h4><ul>${newsRows(twoHourItems)}</ul></section><section><h4>${tx("近 24 小时", "Last 24 hours")}</h4><ul>${newsRows(newsItems)}</ul></section></div></div>`,
    headlineRows = newsRows(newsItems);
  const windows = (data.windows || [])
    .map((window) => {
      const move = Number(window.expectedMove),
        ret = Number(window.expectedReturn) * 100,
        prob = Number(window.upProbability) * 100,
        quality = Math.round(Number(window.matchQuality || 0) * 100),
        range = window.priceRange || {},
        label = researchClassLabel(window),
        band = Number(window.theta);
      return `<article class="research-window ${label.kind}"><span>${safeText(txWinLabel(window.label))} · ${tx({ bull: "牛市", bear: "熊市", range: "震荡" }[window.regime] || "未知", { bull: "Bull", bear: "Bear", range: "Range" }[window.regime] || "Unknown")}</span><b>${label.title}</b><strong class="${label.side}">${label.detail}</strong><em>${tx("预期变动", "Expected move")} ${move >= 0 ? "+" : "−"}${money(Math.abs(move))} (${ret >= 0 ? "+" : "−"}${Math.abs(ret).toFixed(2)}%)</em><small>${tx("价格区间 P10/P50/P90", "Price range P10/P50/P90")}：${money(range.p10)} / ${money(range.p50)} / ${money(range.p90)}</small><small>${tx("中性阈带", "Neutral band")} ±${Number.isFinite(band) ? (band * 100).toFixed(2) : "--"}%${Number.isFinite(band) ? `（${tx("涨跌幅超过该幅度才算有方向", "a move must exceed this to count as directional")}）` : ""}</small><small>${tx("匹配质量", "Match quality")} ${quality}% · n=${window.samples}/${window.candidateCount}</small></article>`;
    })
    .join("");
  const news = data.news || {},
    history = data.historical || {},
    sentiment = data.sentiment,
    derivatives = data.derivatives,
    eventRisk = data.eventRisk || [];
  const structuralTone = (value) =>
    !Number.isFinite(value)
      ? "flat"
      : value > 0
        ? "bull"
        : value < 0
          ? "bear"
          : "flat";
  const derivativeSummary = derivatives
    ? `<div class="research-derivatives"><h3>${tx("市场结构（短周期仅在可验证特征上加权）", "Market structure (short horizon uses validated features only)")}</h3><div><span class="${structuralTone(derivatives.bookImbalancePct)}">${tx("盘口", "Book")} <b>${Number.isFinite(derivatives.bookImbalancePct) ? pct(derivatives.bookImbalancePct) : "--"}</b></span><span class="${structuralTone(derivatives.takerImbalancePct)}">${tx("主动成交", "Taker flow")} <b>${Number.isFinite(derivatives.takerImbalancePct) ? pct(derivatives.takerImbalancePct) : "--"}</b></span><span class="${structuralTone(derivatives.cvdSessionNotional)}">${tx("CVD（会话）", "CVD (session)")} <b>${Number.isFinite(derivatives.cvdSessionNotional) ? money(derivatives.cvdSessionNotional) : "--"}</b></span><span class="${structuralTone(derivatives.oiChangePct)}">OI Δ <b>${Number.isFinite(derivatives.oiChangePct) ? pct(derivatives.oiChangePct) : "--"}</b></span><span class="flat">${tx("资金费率", "Funding")} <b>${Number.isFinite(derivatives.fundingRate) ? `${(derivatives.fundingRate * 100).toFixed(4)}%` : "--"}</b></span><span class="${structuralTone(derivatives.ofiPct)}">OFI <b>${Number.isFinite(derivatives.ofiPct) ? pct(derivatives.ofiPct) : tx("采集中", "Collecting")}</b></span></div><small>${tx("暂不入模", "Excluded until time-aligned history is sufficient")}：${(derivatives.collecting || []).map(safeText).join(" · ")} · ${tx("未接入", "Not connected")}：${derivatives.unavailable.map(safeText).join(" · ")}</small></div>`
    : `<div class="research-derivatives unavailable"><h3>${tx("市场结构", "Market structure")}</h3><small>${tx("OKX 微观结构暂不可用，本次预测未计入该层。", "OKX microstructure is unavailable and is not included in this research run.")}</small></div>`;
  const eventBanner = eventRisk.length
    ? `<div class="research-event-risk"><b>${tx("事件待定", "Event pending")}</b><span>${safeText(eventRisk.join(" · "))} ${tx("将在 24 小时内公布：预测区间已应扩大解读。", "is due within 24 hours: interpret forecast ranges more broadly.")}</span></div>`
    : "";
  card.innerHTML = `<div class="research-outlook-head"><div><h2>${tx(coinLabel() + " 多因子研究预测", coinLabel() + " multi-factor research outlook")}</h2><p>${tx("软加权历史近邻数据模型融合历史状态、近 24 小时公开 BTC 新闻情绪与 OKX 市场结构；结果为条件概率与价格区间，不是买卖建议。", "A soft-weighted historical-neighbor data model combines historical states, recent public BTC news sentiment, and OKX market structure. Results are conditional probabilities and price ranges, not buy/sell advice.")}</p></div><div class="research-actions"><button type="button" id="refreshResearchOutlook">${tx("更新研究", "Refresh research")}</button></div></div>${eventBanner}<div class="research-outlook-summary"><span>${tx("新闻情绪", "News sentiment")}：<b class="bull">${news.bullish || 0} ${tx("利好", "positive")}</b> · <b class="bear">${news.bearish || 0} ${tx("利空", "negative")}</b> · <b class="flat">${news.neutral || 0} ${tx("中性", "neutral")}</b> · ${tx("半衰期", "half-life")} ${news.halfLifeHours || 4}h</span><span>${tx("情绪指数", "Fear & Greed")}：<b>${Number.isFinite(sentiment?.value) ? `${sentiment.value}/100` : "--"}</b></span><span>${tx("中性阈带 15m", "Neutral band 15m")}：±${Number.isFinite(Number(data.windows?.[0]?.theta)) ? (Number(data.windows[0].theta) * 100).toFixed(2) : "--"}%</span><span>${tx("样本", "Samples")}：15m ${history.intradaySamples || 0} · 1d ${history.dailySamples || 0}</span></div><div class="research-window-grid">${windows}</div>${derivativeSummary}<div class="research-news"><h3>${tx("近期 BTC 重点新闻（可点击查看原文）", "Priority BTC headlines (click to open)")}</h3><ul>${headlineRows}</ul></div><footer>${tx("更新时间", "Updated")} ${researchAge(data.fetchedAt)} · ${safeText(news.source || "")} · ${tx("新闻优先按利好/利空影响排序，并采用标题相似度去重、信源与事件权重、4 小时时间衰减；仍需自行核验其真实性与影响。", "Headlines prioritize positive/negative impact, with similarity dedupe, source/event weights, and a 4-hour time decay; verify accuracy and impact independently.")}</footer>`;
  const legacyNews = card.querySelector(".research-news");
  if (legacyNews) legacyNews.outerHTML = newsPanel;
  card
    .querySelector("#refreshResearchOutlook")
    ?.addEventListener("click", () => loadResearchOutlook(true));
  addHelp(
    card.querySelector("h2"),
    tx(
      "模型从本机 SQLite 与公开行情中使用所有可用的 15 分钟、日线历史样本，寻找与当前动量和波动接近的历史片段；新闻仅对结果施加有限权重。预计金额是 BTC 价格变动（美元），不是你的账户盈亏。",
      "The model uses all available 15-minute and daily samples in local SQLite/public market history to find past states similar in momentum and volatility. News has limited weight only. Expected amount is the BTC price move in USD, not your account P&L.",
    ),
    tx(
      "刷新会重新读取缓存/公开数据源；公开新闻源最多每 15 分钟更新一次。",
      "Refreshes cache/public sources; the public news source updates at most every 15 minutes.",
    ),
  );
}
async function loadResearchOutlook(force = false) {
  if (researchOutlookLoading) return;
  researchOutlookLoading = true;
  const card = ensureResearchOutlookCard();
  if (card && !card.innerHTML)
    card.innerHTML = `<div class="research-outlook-head"><div><h2>${tx(coinLabel() + " 多因子研究预测", coinLabel() + " multi-factor research outlook")}</h2><p>${tx("正在读取历史样本、公开新闻与市场结构…", "Reading history samples, public news, and market structure…")}</p></div></div>`;
  try {
    const response = await apiFetch(
        `/api/research-outlook${force ? "?refresh=1" : ""}`,
        20_000,
      ),
      data = await response.json();
    if (!response.ok)
      throw new Error(data.detail || data.error || "request failed");
    renderResearchOutlook(data);
  } catch (error) {
    if (card)
      card.innerHTML = `<div class="research-outlook-head"><div><h2>${tx(coinLabel() + " 多因子研究预测", coinLabel() + " multi-factor research outlook")}</h2><p class="bear">${tx("研究数据暂不可用：", "Research data unavailable: ")}${safeText(error.message)}</p></div><button type="button" id="refreshResearchOutlook">${tx("重试", "Retry")}</button></div>`;
    card
      ?.querySelector("#refreshResearchOutlook")
      ?.addEventListener("click", () => loadResearchOutlook(true));
  } finally {
    researchOutlookLoading = false;
  }
}
setTimeout(() => loadResearchOutlook(), 2_500);
setInterval(() => loadResearchOutlook(), 900_000);

// 启动：首屏自动加载一次研究数据，之后每 15 分钟整卡重拉。
export function initResearch() {
  setTimeout(() => loadResearchOutlook(), 2_500);
  setInterval(() => loadResearchOutlook(), 900_000);
}
// 语言切换钩子：仅当研究卡已渲染且仍有上次数据时才整卡重渲。
export function rerenderResearchOutlook() {
  if ($("researchOutlookCard") && researchOutlookData) {
    renderResearchOutlook(researchOutlookData);
  }
}
export {
  loadResearchOutlook,
  renderResearchOutlook,
};
