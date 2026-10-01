/* OKX 市场微观结构卡片（c 模块）：从 app.js 抽取，纯渲染 + 模块内状态。
 * 渲染入口 renderOkxMicrostructure(context) 由 app.js 的 indicator-detail enhancer
 * 「market-microstructure」在指标卡挂载后调用；context 为衍生品行情上下文。
 * 模块内状态 microstructureNeutralExpanded 仅供本渲染函数与中性指标折叠交互使用。 */
import { $, tx, coinMetaOf, formatRate } from '../core.js?v=20260928a';

/* 技术指标保持紧凑，OKX 公开微观结构单独呈现，以突出实时证据。
   Keep technical indicators compact, and give OKX public microstructure a
   dedicated card so live derivatives evidence is not mistaken for an EMA/RSI. */
let microstructureNeutralExpanded = false;
function renderOkxMicrostructure(context) {
  let card = $("okxMicrostructureCard"),
    layout = document.querySelector(".terminal-layout");
  if (!card) {
    card = document.createElement("section");
    card.id = "okxMicrostructureCard";
    card.className = "card okx-microstructure-card";
  }
  // v2.10.56：作为左列的独立第二张卡，紧跟 K 线卡之后（.chart-column 平级排列）。
  // A separate grid row would inherit the height of the much taller right
  // column and leave a blank gap; the chart column stack avoids that.
  const chartCard = $("mainChartCard");
  const chartColumn = chartCard?.parentElement;
  if (
    chartCard &&
    chartColumn?.classList.contains("chart-column") &&
    card.parentElement !== chartColumn
  )
    chartCard.after(card);
  else if (!card.isConnected) document.querySelector("main")?.append(card);
  if (!card) return;
  if (context?.source !== "okx") {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const book = context.orderBook,
    flow = context.takerFlow,
    oiChange = context.oiChangePct,
    fundingChange = context.fundingChangePct,
    priceChange = context.priceChangePct;
  const tone = (value, positive = 12, negative = -12) =>
    !Number.isFinite(value)
      ? "flat"
      : value >= positive
        ? "bull"
        : value <= negative
          ? "bear"
          : "flat";
  const label = (kind) =>
    kind === "bull"
      ? tx("偏多", "Bullish")
      : kind === "bear"
        ? tx("偏空", "Bearish")
        : tx("中性", "Neutral");
  const percent = (value) =>
    Number.isFinite(value)
      ? `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`
      : "--";
  const bookKind = tone(book?.imbalancePct),
    flowKind = tone(flow?.imbalancePct, 14, -14);
  const oiKind =
    Number.isFinite(oiChange) && Number.isFinite(priceChange)
      ? oiChange >= 0.2 && priceChange >= 0.1
        ? "bull"
        : oiChange >= 0.2 && priceChange <= -0.1
          ? "bear"
          : "flat"
      : "flat";
  const fundingKind = Number.isFinite(fundingChange)
    ? fundingChange >= 0.001
      ? "bear"
      : fundingChange <= -0.001
        ? "bull"
        : "flat"
    : "flat";
  const basisKind =
    Math.abs(context.basisPct || 0) >= 0.12
      ? context.basisPct > 0
        ? "bear"
        : "bull"
      : "flat";
  const premiumKind = Number.isFinite(context.premiumPct)
      ? Math.abs(context.premiumPct) >= 0.05
        ? context.premiumPct > 0
          ? "bear"
          : "bull"
        : "flat"
      : "flat",
    cvd = context.takerFlow?.cvdSessionNotional,
    spread = context.orderBook?.spreadBps;
  const compact = (value, currency = false) => {
    if (!Number.isFinite(value)) return "—";
    const abs = Math.abs(value),
      unit =
        abs >= 1e9
          ? [1e9, "B"]
          : abs >= 1e6
            ? [1e6, "M"]
            : abs >= 1e3
              ? [1e3, "K"]
              : [1, ""];
    return `${value < 0 ? "−" : ""}${currency ? "$" : ""}${(abs / unit[0]).toFixed(currency ? 1 : 2).replace(/\.0+$/, "")}${unit[1]}`;
  };
  const rows = [
    {
      name: tx("盘口失衡", "Order-book imbalance"),
      value: book ? percent(book.imbalancePct) : "—",
      note: book
        ? tx(
            `深度比 ${Number.isFinite(book.ratio) ? book.ratio.toFixed(2) + "×" : "—"} · 前5档`,
            `Depth ratio ${Number.isFinite(book.ratio) ? book.ratio.toFixed(2) + "×" : "—"} · top 5`,
          )
        : tx("等待 OKX 盘口快照", "Waiting for the OKX book snapshot"),
      kind: bookKind,
      tip: tx(
        "前 5 档挂单深度的买卖差。挂单可以快速撤销，所以只作为短线确认，不能单独开仓。",
        "Difference between top-five bid and ask depth. Orders can vanish quickly, so use only as short-term confirmation.",
      ),
    },
    {
      name: tx("主动成交比", "Taker flow"),
      value: flow ? `${flow.buyRatioPct.toFixed(1)}%` : "—",
      note: flow
        ? tx(
            `买入占比 · ${flow.windowSeconds}秒窗口`,
            `Buy ratio · ${flow.windowSeconds}s window`,
          )
        : tx("正在积累 60 秒成交窗口", "Building a 60-second trade window"),
      kind: flowKind,
      tip: tx(
        "统计最近 60 秒实际主动买入与卖出成交，不是静态挂单；短线有效，但变化也很快。",
        "Measures executed taker buying and selling over 60 seconds, not resting orders; useful short-term but fast-changing.",
      ),
    },
    {
      name: tx("持仓量 OI", "Open interest"),
      value: compact(context.oi),
      note: Number.isFinite(context.oi)
        ? tx(
            `${context.oiUnit || "BTC"} · OI ${Number.isFinite(oiChange) ? percent(oiChange) : "—"}`,
            `${context.oiUnit || "BTC"} · OI ${Number.isFinite(oiChange) ? percent(oiChange) : "—"}`,
          )
        : tx("需积累约 5 分钟快照", "Needs about five minutes of snapshots"),
      kind: oiKind,
      tip: tx(
        "价格与 OI 同涨常代表新多参与；价格跌、OI 升常代表新空参与。OI 下降更多表示去杠杆，并不自动等于反转。",
        "Price and OI rising together can indicate new longs; price down with OI up can indicate new shorts. Falling OI often means deleveraging, not necessarily reversal.",
      ),
    },
    {
      name: tx("资金费率趋势", "Funding-rate trend"),
      value: Number.isFinite(context.fundingRate)
        ? formatRate(context.fundingRate)
        : "--",
      note: Number.isFinite(fundingChange)
        ? tx(
            `约 ${context.fundingChangeWindowSeconds || 0} 秒变化 ${percent(fundingChange)}`,
            `~${context.fundingChangeWindowSeconds || 0}s change ${percent(fundingChange)}`,
          )
        : tx("需积累约 1 小时快照", "Needs about one hour of snapshots"),
      kind: fundingKind,
      tip: tx(
        "正费率表示多头向空头付费，负费率相反。费率明显单边上升或下降，是拥挤风险提醒而不是方向保证。",
        "Positive funding means longs pay shorts; negative is the reverse. A strong trend flags crowding risk, not a direction guarantee.",
      ),
    },
    {
      name: tx("永续价差", "Perpetual basis"),
      value: Number.isFinite(context.basisPct)
        ? percent(context.basisPct)
        : "—",
      note:
        Number.isFinite(context.perpPrice) && Number.isFinite(context.spotPrice)
          ? tx("永续 vs 现货基差", "Perpetual vs spot basis")
          : tx("等待现货与永续报价", "Waiting for spot and perpetual quotes"),
      kind: basisKind,
      tip: tx(
        "永续相对现货的溢价或贴水。价差过大时，通常说明杠杆一侧更拥挤，应提高追单门槛。",
        "Premium or discount of the perpetual versus spot. An extreme gap can signal leveraged crowding and should raise the bar for chasing.",
      ),
    },
    {
      name: tx("溢价指数", "Premium index"),
      value: Number.isFinite(context.premiumPct)
        ? percent(context.premiumPct)
        : "—",
      note: Number.isFinite(context.premiumPct)
        ? tx("资金费率的领先拥挤线索", "Lead signal for funding crowding")
        : tx("OKX 公开数据正在重试", "Retrying OKX public data"),
      kind: premiumKind,
      tip: tx(
        "OKX 永续的溢价历史读数。明显正溢价代表多头付费更高，明显负溢价代表空头付费更高；它是拥挤过滤，不是方向指令。",
        "OKX perpetual premium history. Strong positive premium can signal costly longs; negative premium can signal costly shorts. It is a crowding filter, not a direction order.",
      ),
    },
    {
      name: "CVD",
      value: compact(cvd, true),
      note: Number.isFinite(cvd)
        ? tx(
            `主动买卖累计差 · ${Number.isFinite(spread) ? spread.toFixed(2) + " bps" : "价差采集中"}`,
            `Session taker delta · ${Number.isFinite(spread) ? spread.toFixed(2) + " bps" : "spread collecting"}`,
          )
        : tx("正在积累会话成交数据", "Building session trade data"),
      kind: Number.isFinite(cvd)
        ? cvd > 0
          ? "bull"
          : cvd < 0
            ? "bear"
            : "flat"
        : "flat",
      tip: tx(
        "CVD 是主动买入减主动卖出的累计名义额；若它与价格方向背离，趋势可信度下降。价差衡量执行成本，变宽时不宜追单。",
        "CVD is cumulative taker-buy minus taker-sell notional. Divergence from price weakens a trend. Spread measures execution cost; avoid chasing when it widens.",
      ),
    },
    {
      name: tx("爆仓热力", "Liquidation heat"),
      value: "—",
      note: tx("公开数据暂不可用", "Public feed unavailable"),
      kind: "flat",
      tip: tx(
        "当前 OKX V5 公共数据源没有返回可验证的 " + coinMetaOf().okx.swap + " 清算流，因此本卡不会用推测值替代。",
        "The current OKX V5 public feed is not returning a verifiable " + coinMetaOf().okx.swap + " liquidation stream.",
      ),
    },
    {
      name: tx("大户多空比", "Top-trader ratio"),
      value: "—",
      note: tx("公开数据暂不可用", "Public feed unavailable"),
      kind: "flat",
      tip: tx(
        "当前 OKX V5 公共数据源没有返回可验证的大户持仓多空比。本卡保持不可用，避免把模型猜测当成交易所统计。",
        "The current OKX V5 public feed is not returning a verifiable top-trader position ratio.",
      ),
    },
  ];
  const directional = [bookKind, flowKind, oiKind],
    bull = directional.filter((x) => x === "bull").length,
    bear = directional.filter((x) => x === "bear").length;
  let conclusion = tx("观望", "Wait"),
    conclusionKind = "flat",
    reason = tx(
      "盘口、主动成交与 OI 尚未形成两个以上同向确认。",
      "Order book, taker flow and OI do not yet have two aligned confirmations.",
    );
  if (bull >= 2) {
    conclusion = tx("短线研究偏多", "Short-term research bullish");
    conclusionKind = "bull";
    reason = tx(
      "盘口、主动成交和 OI 中至少两项偏多；仍需结合 K 线收盘确认。",
      "At least two of order book, taker flow and OI lean bullish; still wait for candle-close confirmation.",
    );
  } else if (bear >= 2) {
    conclusion = tx("短线研究偏空", "Short-term research bearish");
    conclusionKind = "bear";
    reason = tx(
      "盘口、主动成交和 OI 中至少两项偏空；仍需结合 K 线收盘确认。",
      "At least two of order book, taker flow and OI lean bearish; still wait for candle-close confirmation.",
    );
  }
  const meterLevel = (row) => {
    if (row === rows[0])
      return Math.max(8, Math.min(92, 50 + (book?.imbalancePct || 0) * 1.5));
    if (row === rows[1])
      return Math.max(
        8,
        Math.min(
          92,
          Number.isFinite(flow?.buyRatioPct) ? flow.buyRatioPct : 50,
        ),
      );
    if (row === rows[2])
      return Number.isFinite(oiChange)
        ? Math.max(10, Math.min(90, 50 + oiChange * 70))
        : 50;
    if (row === rows[3])
      return Number.isFinite(fundingChange)
        ? Math.max(10, Math.min(90, 50 + fundingChange * 8000))
        : 50;
    if (row === rows[4])
      return Number.isFinite(context.basisPct)
        ? Math.max(10, Math.min(90, 50 + context.basisPct * 160))
        : 50;
    if (row === rows[5])
      return Number.isFinite(context.premiumPct)
        ? Math.max(10, Math.min(90, 50 + context.premiumPct * 300))
        : 50;
    if (row === rows[6])
      return Number.isFinite(cvd)
        ? Math.max(10, Math.min(90, 50 + cvd / 1_500_000))
        : 50;
    return 50;
  };
  const alert = [
    fundingKind === "bear" &&
      tx(
        "资金费率上升，注意多头拥挤。",
        "Funding is rising; watch long crowding.",
      ),
    fundingKind === "bull" &&
      tx(
        "资金费率走低，注意空头拥挤。",
        "Funding is falling; watch short crowding.",
      ),
    premiumKind === "bear" &&
      tx(
        "溢价偏高，降低追多优先级。",
        "Premium is elevated; lower the priority of chasing longs.",
      ),
    premiumKind === "bull" &&
      tx(
        "溢价偏低，注意空头拥挤。",
        "Premium is depressed; watch short crowding.",
      ),
    Number.isFinite(spread) &&
      spread >= 3 &&
      tx(
        "盘口价差变宽，降低执行优先级。",
        "The book spread is wide; lower execution priority.",
      ),
  ].find(Boolean);
  const currentMeaning = [
    book
      ? `当前买卖深度差为 ${percent(book.imbalancePct)}，前 5 档买盘约为卖盘的 ${Number.isFinite(book.ratio) ? book.ratio.toFixed(2) : "—"} 倍；${bookKind === "bull" ? "眼下挂单更偏向买方，短线标为偏多" : bookKind === "bear" ? "眼下挂单更偏向卖方，短线标为偏空" : "买卖挂单接近，方向暂不明确"}。`
      : "当前还未拿到可用盘口快照，不能据此判断买卖力量。",
    flow
      ? `当前 ${flow.windowSeconds} 秒内主动买入占 ${flow.buyRatioPct.toFixed(1)}%；${flowKind === "bull" ? "买方正在主动吃掉卖盘，短线标为偏多" : flowKind === "bear" ? "卖方正在主动压低成交，短线标为偏空" : "主动买卖大致均衡"}。`
      : "当前正在积累成交窗口，暂不对买卖主动性下结论。",
    Number.isFinite(oiChange) && Number.isFinite(priceChange)
      ? `当前 OI 约变化 ${percent(oiChange)}，价格约变化 ${percent(priceChange)}；${oiKind === "bull" ? "价格和持仓同步上升，较像新多头参与" : oiKind === "bear" ? "价格走弱而持仓上升，较像新空头参与" : "两者没有形成清晰的同向新仓信号"}。`
      : "OI 的比较样本仍在积累，暂不判断新多或新空。",
    Number.isFinite(context.fundingRate)
      ? `当前资金费率为 ${formatRate(context.fundingRate)}，近 ${context.fundingChangeWindowSeconds || 0} 秒变化 ${percent(fundingChange)}；${fundingKind === "bear" ? "多头付费压力在升高，需防多头拥挤" : fundingKind === "bull" ? "空头付费压力在升高，需防空头拥挤" : "暂未显示明显的一边拥挤"}。`
      : "当前尚无可用资金费率，不能判断哪一方的杠杆更拥挤。",
    Number.isFinite(context.basisPct)
      ? `当前永续相对现货价差为 ${percent(context.basisPct)}；${basisKind === "flat" ? "幅度不大，未显示明显拥挤" : "价差偏大，说明杠杆一侧可能拥挤"}。`
      : "尚未同时拿到现货和永续报价，无法判断价差。",
    Number.isFinite(context.premiumPct)
      ? `当前溢价指数为 ${percent(context.premiumPct)}；${premiumKind === "flat" ? "暂未显示明显拥挤" : "提示一侧杠杆成本可能偏高，应避免追单"}。`
      : "当前溢价指数不可用，因此不作拥挤判断。",
    Number.isFinite(cvd)
      ? `当前会话 CVD 为 ${compact(cvd, true)}；${cvd > 0 ? "累计主动买入多于主动卖出，买方成交更占优" : cvd < 0 ? "累计主动卖出多于主动买入，卖方成交更占优" : "主动买卖累计接近平衡"}。`
      : "会话成交数据仍在积累，暂不判断买卖主动性。",
    "当前没有可验证的公开数据，所以此卡不会用猜测值代替。",
    "当前没有可验证的公开数据，所以此卡不会用猜测值代替。",
  ];
  rows.forEach((row, index) => {
    row.tip = `${currentMeaning[index]} ${row.tip}`;
  });
  const directionalRows = rows.filter((row) => row.kind !== "flat"),
    neutralRows = rows.filter((row) => row.kind === "flat"),
    gridClass = (items) =>
      items.length % 2 === 0 ? "is-even" : "is-odd";
  const rowHtml = (row) =>
    `<article class="microstructure-item ${row.kind}${row.value === "—" ? " unavailable" : ""}" style="--micro-level:${meterLevel(row).toFixed(1)}%"><div><span>${row.name}<button class="help-dot" type="button" data-tip="${row.tip}" aria-label="${tx("查看说明", "Show explanation")}">!</button></span><i>${label(row.kind)}</i></div><b>${row.value}</b><small>${row.note}</small><div class="microstructure-meter" role="meter" aria-label="${tx("指标强度", "Indicator strength")}" aria-valuenow="${meterLevel(row).toFixed(1)}" aria-valuemin="0" aria-valuemax="100"><em></em></div></article>`;
  const neutralSection = neutralRows.length
    ? `<section class="microstructure-neutral-group ${microstructureNeutralExpanded ? "is-expanded" : ""}"><button type="button" class="microstructure-neutral-toggle" aria-expanded="${microstructureNeutralExpanded}"><span>${tx("中性指标", "Neutral indicators")} · ${neutralRows.length} ${tx("项", "items")}</span><b>${microstructureNeutralExpanded ? tx("收起", "Hide") : tx("展开", "Show")}</b></button><div class="microstructure-grid microstructure-neutral-grid ${gridClass(neutralRows)} ${microstructureNeutralExpanded ? "" : "is-collapsed"}" ${microstructureNeutralExpanded ? "" : "hidden"}>${neutralRows.map(rowHtml).join("")}</div></section>`
    : "";
  card.innerHTML = `<div class="microstructure-head"><div><h2>${tx("OKX 市场微观结构", "OKX market microstructure")} <button class="help-dot" type="button" data-tip="${tx("来自 OKX " + coinMetaOf().okx.swap + " 永续的公开 WebSocket：盘口、最新成交、持仓量、资金费率与现货/永续价格。用于 5 分钟到 1 小时的短线确认，不保证预测正确。", "Public OKX WebSocket data for BTC-USDT perpetual: order book, recent trades, OI, funding and spot/perpetual prices. It supports 5m–1h confirmation, not guaranteed prediction.")}">!</button></h2><p>${tx("盘口与成交实时 · OI、费率持续更新", "Live order book and trades · continuously updated OI and funding")}</p></div><span>${context.transport === "websocket" ? tx("OKX WebSocket", "OKX WebSocket") : tx("REST 备用", "REST fallback")}</span></div><div class="microstructure-conclusion ${conclusionKind}"><b>${conclusion}</b><p>${reason}</p></div><div class="microstructure-grid ${gridClass(directionalRows)}">${directionalRows.map(rowHtml).join("")}</div>${neutralSection}`;
  card.querySelector(".microstructure-neutral-toggle")?.addEventListener("click", () => {
    microstructureNeutralExpanded = !microstructureNeutralExpanded;
    renderOkxMicrostructure(context);
  });
  if (alert) {
    const warning = document.createElement("p");
    warning.className = "microstructure-alert";
    warning.textContent = `⚠ ${alert}`;
    warning.title = alert;
    card.append(warning);
  }
}

export { renderOkxMicrostructure };
