// AI 助手后端模块：把服务端采集到的行情数据压缩成快照，交给千问（DashScope）分析。
// AI assistant backend: snapshots the server-side market data, then asks Qwen (DashScope) to analyse it.
//
// 设计原则 / Design notes
// 1. 密钥只存在服务端，浏览器永远拿不到 key。Credentials stay server-side only.
// 2. 快照是结构化 JSON，不是自然语言，模型才不会误读数字。
//    The snapshot is structured JSON, not prose, so the model cannot misread numbers.
// 3. 上下文有 token 预算：K 线降采样 + 只保留对判断有用的派生量。
//    There is a token budget: candles are downsampled and only useful derived values ship.
// 4. 输出有契约（固定小标题），前端才能稳定渲染。
//    Output follows a fixed contract so the UI can render it reliably.

import { readFileSync, writeFileSync } from 'node:fs';

// 本地额度累计必须跨重启保留，否则每次重启都会「清零」，用户看到的已用量会倒退。
// The local quota accumulator must survive restarts, otherwise the usage counter resets to zero.
const QUOTA_FILE = new URL('./data/ai-quota.json', import.meta.url);

const QWEN_TIMEOUT_MS = 180_000;
const SNAPSHOT_TTL = 20_000;
// 本地累计历史保留最近 50 条调用，方便在面板里展示近况。
// Keep the last 50 local calls so the quota panel can show recent activity.
const QUOTA_HISTORY_LIMIT = 50;
// 千问按量 credits 估算表（每千 tokens 消耗多少 credits）。
// Qwen credits estimate per 1k tokens. Source: 阿里云百炼开发者社区 / Token Plan 文档.
// 注意：实际按请求中 输入/输出/缓存/思考 多段加权计算，模型不同差别大；这里给的是粗略估算。
// Note: actual cost is request-specific (prompt/output/cache/thinking ratios differ per model).
// This is a rough estimator, not a bill; show it as such in the UI.
// 换算基准：以 qwen3.8-max 为 2.5 / 7.5，其余按官方「按量付费单价」等比缩放。
// 单价（华北2·北京，元/百万 token，输入/输出）：
//   qwen3.8-max 12/36 · qwen3.7-max 6/18（5折）· qwen3.8-flash 0.8/2.7 · qwen3.7-plus 1.6/6.4（8折）
// Baseline is qwen3.8-max; every other row is scaled by Alibaba's own per-token price ratio.
const MODEL_CREDITS_PER_1K = {
  'qwen3.8-max':  { prompt:2.5,  completion:7.5 },
  'qwen3.7-max':  { prompt:1.25, completion:3.75 },
  'qwen3.8-flash':{ prompt:0.17, completion:0.56 },
  'qwen3.7-plus': { prompt:0.33, completion:1.33 },
  'qwen3.6-flash':{ prompt:0.15, completion:0.5 },
  // 兼容早期存过的按量付费模型名，避免历史配置估算时报错。
  // Legacy pay-as-you-go codes kept so an old stored model name still estimates cleanly.
  'qwen3.6-plus': { prompt:1.0,  completion:3.0 },
  'qwen-plus':    { prompt:1.0,  completion:3.0 },
  'qwen-flash':   { prompt:0.25, completion:0.75 },
  'qwen-turbo':   { prompt:0.5,  completion:1.5 },
  'qwen-long':    { prompt:2.0,  completion:6.0 },
  'qwen-max':     { prompt:2.5,  completion:7.5 }
};
function estimateCredits(model, promptTokens, completionTokens) {
  const ratio = MODEL_CREDITS_PER_1K[String(model || '').toLowerCase()] || MODEL_CREDITS_PER_1K['qwen3.8-max'];
  return (promptTokens / 1000) * ratio.prompt + (completionTokens / 1000) * ratio.completion;
}

// ---------- 配额追踪 / Quota tracking ----------
// 双轨数据：remote 来自千问响应头（最准），local 来自本地累加（一定有，作 fallback）。
// Two-track quota: remote from Qwen response headers (most accurate), local from accumulated usage (always available as fallback).
const quotaState = {
  remote:null, // { limit, remaining, used, resetAt, raw, updatedAt } | null
  local:{
    periodStart:Date.now(),   // 当前计费周期的开始时间（首次启动；如响应头有 reset，会被覆盖）
    calls:0,
    promptTokens:0,
    completionTokens:0,
    reasoningTokens:0,
    totalTokens:0,
    estimatedCredits:0,        // 按模型表粗略估算的累计 credits
    history:[]                // [{timestamp, prompt, completion, reasoning, total, credits, model}]
  }
};
// 额度累计的持久化：启动时恢复，每次调用后写回。文件很小（最多 50 条历史）。
// Quota persistence: restore on boot, write back after each call. The file stays tiny.
const QUOTA_PERSIST_KEYS = ['periodStart','periodEnd','calls','promptTokens','completionTokens','reasoningTokens','totalTokens','estimatedCredits'];
function persistQuota() {
  try { writeFileSync(QUOTA_FILE, JSON.stringify({ ...quotaState.local, history:quotaState.local.history.slice(-QUOTA_HISTORY_LIMIT) })); }
  catch { /* 磁盘不可写时静默降级为内存态 / fall back to memory when the disk is read-only */ }
}
(function restoreQuota() {
  let saved = null;
  try { saved = JSON.parse(readFileSync(QUOTA_FILE, 'utf8')); } catch { return; }
  if (!saved || typeof saved !== 'object') return;
  const l = quotaState.local;
  for (const key of QUOTA_PERSIST_KEYS) if (Number.isFinite(saved[key])) l[key] = saved[key];
  if (Array.isArray(saved.history)) l.history = saved.history.slice(-QUOTA_HISTORY_LIMIT);
  // 计费周期已结束：清零重来，避免把上一周期的消耗算进这一周期。
  // The billing window already elapsed: reset so last period's burn is not carried over.
  if (l.periodEnd && l.periodEnd <= Date.now()) {
    quotaState.local = { periodStart:Date.now(), calls:0, promptTokens:0, completionTokens:0, reasoningTokens:0, totalTokens:0, estimatedCredits:0, history:[] };
  }
})();
function parseNumber(value) {
  if (value == null) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}
function parseResetSeconds(value) {
  // 兼容三种格式：秒数(429 常见)、ISO 字符串、毫秒 Unix 时间戳
  if (value == null) return null;
  if (/^\d+(\.\d+)?$/.test(String(value))) {
    const n = Number(value);
    // 1e12 量级视为毫秒时间戳
    return n > 1e12 ? n : Date.now() + n * 1000;
  }
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}
function parseRateLimitHeaders(headers) {
  if (!headers || typeof headers.get !== 'function') return null;
  // OpenAI / DashScope / 多数兼容端点都会带这些 header，按优先级查找
  // Try multiple casings because DashScope sometimes uses hyphen, sometimes underscore.
  const candidates = [
    ['x-ratelimit-limit-tokens', 'limit-tokens'],
    ['x-ratelimit-remaining-tokens', 'remaining-tokens'],
    ['x-ratelimit-reset-tokens', 'reset-tokens'],
    ['x-ratelimit-limit-requests', 'limit-requests'],
    ['x-ratelimit-remaining-requests', 'remaining-requests'],
    ['x-ratelimit-reset-requests', 'reset-requests'],
    ['x-ratelimit-limit', 'limit'],
    ['x-ratelimit-remaining', 'remaining'],
    ['x-ratelimit-reset', 'reset']
  ];
  const out = {};
  for (const [name] of candidates) {
    const v = headers.get(name);
    if (v != null) out[name] = v;
  }
  if (!Object.keys(out).length) return null;
  // 选择最丰富的一组（tokens > requests > 通用）
  const limit = parseNumber(out['x-ratelimit-limit-tokens']) ?? parseNumber(out['x-ratelimit-limit']);
  const remaining = parseNumber(out['x-ratelimit-remaining-tokens']) ?? parseNumber(out['x-ratelimit-remaining-requests']) ?? parseNumber(out['x-ratelimit-remaining']);
  const resetMs = parseResetSeconds(out['x-ratelimit-reset-tokens']) ?? parseResetSeconds(out['x-ratelimit-reset-requests']) ?? parseResetSeconds(out['x-ratelimit-reset']);
  if (limit == null && remaining == null) return null;
  return {
    limit,
    remaining,
    used:limit != null && remaining != null ? Math.max(0, limit - remaining) : null,
    resetAt:resetMs,
    raw:out,
    updatedAt:Date.now()
  };
}
function recordLocalUsage({ usage, model }) {
  if (!usage || typeof usage !== 'object') return;
  const prompt = Number(usage.prompt_tokens || usage.input_tokens || 0);
  const completion = Number(usage.completion_tokens || usage.output_tokens || 0);
  const reasoning = Number(usage.reasoning_tokens || (usage.completion_tokens_details?.reasoning_tokens) || 0);
  const total = Number(usage.total_tokens || (prompt + completion)) || 0;
  const credits = estimateCredits(model, prompt, completion);
  const l = quotaState.local;
  l.calls += 1;
  l.promptTokens += prompt;
  l.completionTokens += completion;
  l.reasoningTokens += reasoning;
  l.totalTokens += total;
  l.estimatedCredits += credits;
  l.history.push({ timestamp:Date.now(), prompt, completion, reasoning, total, credits, model:String(model || '') });
  if (l.history.length > QUOTA_HISTORY_LIMIT) l.history.splice(0, l.history.length - QUOTA_HISTORY_LIMIT);
  // 如果响应头提供了 resetAt，把它当作本周期的结束点（本地兜底显示倒计时也用这个）
  // If the header told us when the period resets, use it as the local countdown anchor too.
  if (quotaState.remote?.resetAt) {
    l.periodEnd = quotaState.remote.resetAt;
  } else if (!l.periodEnd) {
    // 第一次启动：粗略假设一个 7 天的周期（Token Plan 的默认值），后续响应头会修正。
    // First boot: assume a 7-day window (Token Plan default), header will refine it.
    l.periodEnd = l.periodStart + 7 * 24 * 60 * 60 * 1000;
  }
  // 写回磁盘，重启后已用量不会倒退。
  // Flush to disk so the counter survives a restart.
  persistQuota();
}
function getQuotaState() {
  // getCredential 是工厂函数注入的，这里通过 getCredentialFn 间接拿（见 createAiChat 末尾绑定）
  const credential = (typeof getCredentialFn === 'function' ? getCredentialFn('qwen') : null) || {};
  const remote = quotaState.remote ? { ...quotaState.remote, ageMs:Date.now() - quotaState.remote.updatedAt } : null;
  const local = { ...quotaState.local };
  // 派生字段：百分比 + 倒计时
  // Derived: percentage + countdown
  const remotePercent = remote?.limit ? Math.max(0, Math.min(100, (remote.remaining / remote.limit) * 100)) : null;
  const localEstimatePercent = remote?.limit && remote?.used != null
    ? Math.max(0, Math.min(100, ((remote.used + local.totalTokens) / remote.limit) * 100))
    : null;
  const periodEnd = remote?.resetAt || local.periodEnd;
  const countdownMs = periodEnd ? Math.max(0, periodEnd - Date.now()) : null;
  return {
    configured:Boolean(credential.key),
    remote:remote ? {
      limit:remote.limit,
      remaining:remote.remaining,
      used:remote.used,
      percentRemaining:remotePercent,
      resetAt:remote.resetAt ? new Date(remote.resetAt).toISOString() : null,
      updatedAt:new Date(remote.updatedAt).toISOString(),
      ageMs:remote.ageMs
    } : null,
    local:{
      periodStart:new Date(local.periodStart).toISOString(),
      periodEnd:periodEnd ? new Date(periodEnd).toISOString() : null,
      countdownMs,
      calls:local.calls,
      promptTokens:local.promptTokens,
      completionTokens:local.completionTokens,
      reasoningTokens:local.reasoningTokens,
      totalTokens:local.totalTokens,
      estimatedCredits:Number((local.estimatedCredits || 0).toFixed(2)),
      estimatedPercentUsed:localEstimatePercent,
      recentCalls:local.history.slice(-10).reverse()
    },
    // 提示文案：千问 API 不返回 credits 响应头，只能给本地估算。
    // Friendly hint: Qwen API doesn't surface credit headers, so the UI only shows an estimate.
    note:'千问 API 不返回实时额度响应头，下方数字为按模型换算表本地估算，精确剩余请到 Token Plan 控制台查看。'
  };
}
// 由 createAiChat 在工厂内绑定，避开循环依赖。
// Bound by createAiChat to avoid a circular dependency.
let getCredentialFn = null;
// 切换模型需要写回服务端凭据文件，故由 server.mjs 注入一个 setter（本模块不碰磁盘）。
// Switching the model writes back to the credential file, so server.mjs injects a setter.
let setModelFn = null;
// 千问有两套完全隔离的接入体系，Key 与端点必须配套，混用会 401：
// Qwen ships two fully isolated access systems; key and endpoint must match or you get 401.
//   1) 按量付费 Pay-as-you-go (DashScope)：Key 以 sk- / sk-ws- 开头
//   2) Token Plan 个人版订阅（2025 起）：Key 以 sk-sp- 开头
const QWEN_ENDPOINTS = [
  { id:'dashscope', baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1', keyHint:'sk- / sk-ws-', label:'按量付费 DashScope（sk- / sk-ws- 开头）' },
  { id:'token-plan', baseUrl:'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', keyHint:'sk-sp-', label:'Token Plan 个人版订阅（sk-sp- 开头）' }
];
const DEFAULT_BASE_URL = QWEN_ENDPOINTS[0].baseUrl;
const TOKEN_PLAN_BASE_URL = QWEN_ENDPOINTS[1].baseUrl;
// 端点自动匹配：没显式指定端点时，按 Key 前缀挑正确的那个。
// Auto-match: when no endpoint was chosen explicitly, pick by key prefix.
function inferBaseUrl(key) {
  return /^sk-sp-/i.test(String(key || '').trim()) ? TOKEN_PLAN_BASE_URL : DEFAULT_BASE_URL;
}
function endpointMismatch(credential) {
  const key = String(credential?.key || '').trim();
  const base = String(credential?.baseUrl || DEFAULT_BASE_URL).trim();
  if (!key) return null;
  const isSp = /^sk-sp-/i.test(key);
  const isTokenPlan = base.includes('token-plan');
  if (isSp && !isTokenPlan) return { expected:TOKEN_PLAN_BASE_URL, actual:base, reason:'Token Plan 的 Key（sk-sp-）必须配 Token Plan 端点' };
  if (!isSp && isTokenPlan) return { expected:DEFAULT_BASE_URL, actual:base, reason:'按量付费的 Key 不能配 Token Plan 端点' };
  return null;
}
// 模型清单 = Token Plan 个人版「支持模型」面板里列出的全部型号。
// 前 5 个是文本/推理模型，可用于行情问答；后 2 个属于图片生成与语音识别，列出来仅为对齐官方清单。
// The list mirrors the "supported models" panel of Token Plan Personal. The first five are
// text/reasoning models usable for market Q&A; the last two are image/audio and are listed for parity only.
export const QWEN_MODELS = [
  { id:'qwen3.8-flash', label:'qwen3.8-flash', tier:'value',
    note:'性价比首选：成本约为旗舰的 1/15，精度接近旗舰，响应更快', usable:true, recommended:true },
  { id:'qwen3.7-plus', label:'qwen3.7-plus', tier:'balanced',
    note:'均衡之选：质量与花费都居中，适合日常分析', usable:true },
  { id:'qwen3.7-max', label:'qwen3.7-max', tier:'flagship',
    note:'上一代旗舰：推理扎实，花费偏高', usable:true },
  { id:'qwen3.6-flash', label:'qwen3.6-flash', tier:'value',
    note:'最省钱一档：适合简单问题，复杂研判偏弱', usable:true },
  { id:'qwen3.8-max', label:'qwen3.8-max', tier:'flagship',
    note:'当代旗舰：推理最强，花费最高（约 flash 的 15 倍）', usable:true },
  { id:'qwen-image-3.0-pro', label:'qwen-image-3.0-pro', tier:'other',
    note:'图片生成模型 · 不能用于行情问答', usable:false, kind:'image' },
  { id:'qwen-audio-3.0-asr-flash', label:'qwen-audio-3.0-asr-flash', tier:'other',
    note:'语音识别模型 · 不能用于行情问答', usable:false, kind:'audio' }
];
// 默认走性价比档：qwen3.8-flash 比旗舰便宜约 15 倍，分析质量仍接近旗舰。
// Default to the value tier: roughly 15x cheaper than the flagship with near-flagship quality.
export const DEFAULT_MODEL = 'qwen3.8-flash';

// 回答模式（语气档位）：与「快速/深度」正交 —— 那个决定模型想多久，这个决定说给谁听。
// Answer styles (register): orthogonal to fast/deep — that one controls thinking, this one controls tone.
export const ANSWER_STYLES = [
  { id:'plain', label:'通俗', tag:'默认', audience:'完全不懂技术分析的人',
    hint:'完全不用术语，大白话讲清是涨是跌、大概什么时候' },
  { id:'balanced', label:'中等', tag:'均衡', audience:'懂一点但不深的人',
    hint:'术语首次出现配一句白话解释，专业与好懂兼顾' },
  { id:'pro', label:'专业', tag:'进阶', audience:'熟悉技术分析的人',
    hint:'术语与指标数值直接给全，多周期拆开讲' }
];
export const DEFAULT_STYLE = 'plain';
// 白名单校验：非法值一律落回默认档，避免把任意字符串塞进提示词。
// Whitelist the style so an arbitrary string can never be injected into the prompt.
export function normalizeStyle(style) {
  const wanted = String(style || '').trim().toLowerCase();
  return ANSWER_STYLES.some(s => s.id === wanted) ? wanted : DEFAULT_STYLE;
}

// ---------- 联网检索 / Web research ----------
// 让模型「本地快照数据 + 外部网络信息」综合回答：服务端先按用户问题去公开新闻源检索
// 最近的相关报道与分析，作为额外的 system 消息注入提示词；模型必须标注来源与时间，
// 与快照冲突时要明确指出来。
// Server-side web research: search public news feeds for the user's question, inject the
// results as an extra system message, and require the model to cite source + time.
//
// 为什么不用模型自带的联网插件（enable_search）：本地快照已经覆盖价格、衍生品与宏观
// 日历，外部信息的作用主要是解释「为什么」和「接下来有什么催化剂」。用可缓存、可审计、
// 零额外费用的 RSS 检索更可控，也不会因为某个端点不支持 enable_search 而整条链路失败。
// We deliberately use cacheable, auditable, zero-cost RSS retrieval instead of the model's
// own search plugin, so the pipeline never hinges on one endpoint supporting enable_search.
const WEB_TTL = 10 * 60_000;   // 同一问题 10 分钟内复用检索结果 / reuse results for 10 min
const WEB_ITEM_LIMIT = 12;     // 注入提示词的最大条数（控制 token 预算）/ cap injected rows
const WEB_FETCH_TIMEOUT = 9_000;
const WEB_UA = 'Mozilla/5.0 (compatible; BTC-Indicator-AI/1.0; +local research assistant)';
const webCache = new Map();

function decodeXmlEntities(value) {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d{1,6});/g, (whole, code) => {
      const point = Number(code);
      return point >= 32 && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
    })
    .replace(/&amp;/g, '&');
}
function stripXml(value) {
  return decodeXmlEntities(String(value).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}
function xmlTag(block, tag) {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return match ? stripXml(match[1]) : null;
}
// RSS 2.0：title / link / description / pubDate，来源名在 <source url="...">媒体</source>。
// RSS 2.0 items: title, link, description, pubDate; the outlet name lives in <source>.
function parseRssItems(xml, limit = 30) {
  const items = [];
  const re = /<item[\s>][\s\S]*?<\/item>/gi;
  let match;
  while ((match = re.exec(xml)) && items.length < limit) {
    const block = match[0];
    const title = xmlTag(block, 'title');
    if (!title) continue;
    const sourceMatch = block.match(/<source[^>]*>([\s\S]*?)<\/source>/i);
    const pub = xmlTag(block, 'pubDate') || xmlTag(block, 'dc:date');
    const at = pub ? Date.parse(pub) : NaN;
    const summary = xmlTag(block, 'description');
    items.push({
      title:title.slice(0, 200),
      source:sourceMatch ? stripXml(sourceMatch[1]).slice(0, 60) : null,
      url:(xmlTag(block, 'link') || '').slice(0, 400) || null,
      summary:summary ? summary.slice(0, 260) : null,
      publishedAt:Number.isFinite(at) ? at : null
    });
  }
  return items;
}
// 中文虚词与口语词不适合做检索词，直接丢掉，避免把「未来 24 小时怎么走」原样丢给搜索。
// Drop Chinese function words and filler so "how will the next 24h go" becomes real keywords.
const QUERY_STOPWORDS = new Set([
  '现在','未来','怎么','怎样','如何','什么','多少','哪个','哪些','请问','帮我','一下','时候','今天','明天','后天',
  '目前','还能','可以','是不是','是否','的话','这个','那个','以及','还有','就是','一般','大概','可能','应该',
  '要不要','能不能','会不会','为什么','讲解','分析下','说下','讲讲','吗','呢','吧','的','了','会','要','在','有',
  '和','与','或','对','给','我','你','他','这','那','个','下','上','里','中','时','日','月','年','点','个点',
  // 时间与口语化的行情说法：这些词丢给搜索只会拉回无关结果。
  // Time spans and colloquial market talk: searching these returns mostly noise.
  '小时','分钟','天','周','周内','走','怎么走','走向','走势如何','接下来','后市','动向','动静','情况','是怎么',
  '追多','追空','加仓','减仓','上车','下车','入场','出场','点位','看法','意见','建议'
]);
// 主题线索 → 检索词：把「资金费率」这类话题翻成新闻源真正会用的关键词。
// Topic hints: translate a topic like "资金费率" into words news feeds actually contain.
const TOPIC_HINTS = [
  { test:/cpi|pce|ppi|通胀|物价/i, zh:'比特币 通胀 CPI PPI', en:'Bitcoin inflation CPI PPI' },
  { test:/非农|就业|失业|jobless|nonfarm|payroll/i, zh:'比特币 非农 就业数据', en:'Bitcoin nonfarm payrolls jobs' },
  { test:/美联储|降息|加息|议息|利率|fomc|鲍威尔|fed/i, zh:'比特币 美联储 利率', en:'Bitcoin Federal Reserve rate decision' },
  { test:/etf|灰度|贝莱德|blackrock|机构资金/i, zh:'比特币 ETF 资金流入', en:'Bitcoin ETF flows' },
  { test:/监管|法案|sec|合规|政策|立法/i, zh:'比特币 监管 政策', en:'Bitcoin regulation policy' },
  { test:/流动性|缩表|放水|qe|qt|资产负债表|逆回购/i, zh:'比特币 流动性 央行', en:'Bitcoin liquidity central bank' },
  { test:/技术分析|指标|均线|支撑|阻力|背离|rsi|macd|布林|趋势/i, zh:'比特币 技术分析 支撑 阻力', en:'Bitcoin technical analysis support resistance' },
  { test:/资金费率|合约|爆仓|多空|持仓量|基差|杠杆|清算/i, zh:'比特币 合约 资金费率 爆仓', en:'Bitcoin funding rate liquidations futures' },
  { test:/巨鲸|链上|交易所|资金流|on-?chain|whale/i, zh:'比特币 链上数据 巨鲸', en:'Bitcoin on-chain whale flows' },
  { test:/预测|走势|行情|方向|目标价|forecast|outlook|price|涨|跌|走|后市|接下来|动向|追多|追空/i, zh:'比特币 行情 走势 预测', en:'Bitcoin price forecast outlook' }
];
// 与比特币（或其交易生态）有关的信号词：用来把山寨币 SEO 稿、预测软文排到后面。
// Bitcoin-adjacency signals: used to push altcoin SEO pieces and evergreen promo posts down.
const BITCOIN_RE = /bitcoin|\bbtc\b|比特币|比特幣|加密|数字货币|加密貨幣|币安|binance|okx|coinbase|crypto market|现货 etf/i;
const ALTCOIN_ONLY_RE = /ethereum|\beth\b|\bxrp\b|solana|\bsol\b|dogecoin|\bdoge\b|cardano|\bada\b|shiba|\bpepe\b|mars.?cat|memecoin|altcoin|polygon|\bton\b|avalanche|chainlink|\btron\b|bnb|hyperliquid|sui\b/i;
// 宏观事件词：用户问「接下来怎么走」时，宏观催化剂比价格预测软文更有价值。
// Macro catalyst words: far more useful than evergreen price-prediction filler.
const MACRO_EVENT_RE = /cpi|ppi|pce|通胀|非农|就业|失业|美联储|fed\b|fomc|利率|降息|加息|鲍威尔|国债|经济数据|etf|监管|法案/i;
// 相关性打分：比特币权重最高，其次是与问题关键词的重合，山寨币软文扣分。
// Relevance score: Bitcoin mentions weigh most, then question-keyword overlap; altcoin filler is penalised.
function relevanceScore(item, keywords, hints) {
  const text = `${item.title} ${item.summary || ''}`.toLowerCase();
  let score = 0;
  const hasBitcoin = BITCOIN_RE.test(text);
  if (hasBitcoin) score += 4;
  if (ALTCOIN_ONLY_RE.test(text) && !hasBitcoin) score -= 5;
  if (MACRO_EVENT_RE.test(text)) score += 1.5;
  for (const keyword of keywords) {
    const probe = String(keyword).toLowerCase();
    if (probe.length >= 2 && text.includes(probe)) score += 1.5;
  }
  for (const hint of hints) {
    for (const part of hint.en.toLowerCase().split(/\s+/)) {
      if (part.length > 3 && text.includes(part)) score += 0.8;
    }
  }
  // 越新越靠前：12 小时内 +2，36 小时内 +1，5 天内 +0.4。
  // Recency bonus: +2 within 12h, +1 within 36h, +0.4 within 5 days.
  const age = item.publishedAt ? Date.now() - item.publishedAt : Infinity;
  if (age <= 12 * 3_600_000) score += 2;
  else if (age <= 36 * 3_600_000) score += 1;
  else if (age <= 5 * 86_400_000) score += 0.4;
  return score;
}
function questionKeywords(question) {
  return String(question || '')
    .replace(/[，。！？、；：,.!?;:()（）"“”'’\[\]【】]/g, ' ')
    .split(/\s+/)
    .map(token => token.trim())
    .filter(token => token && !QUERY_STOPWORDS.has(token) && token.length <= 14)
    .slice(0, 6);
}
// 一次提问最多 3 条检索：中文主题 + 英文主题 + 大盘基线，覆盖「新闻 + 分析 + 评论」。
// Up to three queries per question: Chinese topic, English topic, and a market baseline.
function buildSearchQueries(question, lang) {
  const hints = TOPIC_HINTS.filter(hint => hint.test.test(String(question || ''))).slice(0, 2);
  const words = questionKeywords(question);
  // 主题线索里已经含「比特币 / Bitcoin」，只在退回原始关键词时才补主语，
  // 否则会出现「比特币 美联储 利率 比特币」这种重复词。
  // Topic hints already carry the subject token, so only raw keyword fallbacks need it.
  const zhParts = hints.map(hint => hint.zh);
  if (!zhParts.length && words.length) zhParts.push(`${words.join(' ')} 比特币`);
  if (!zhParts.length) zhParts.push('比特币 行情 走势');
  const enParts = hints.map(hint => hint.en.replace(/^Bitcoin\s+/i, ''));
  const queries = [];
  queries.push({ id:'zh', label:'Google News · 中文', query:`${zhParts.join(' ')} when:3d`, locale:'zh' });
  if (enParts.length) queries.push({ id:'en', label:'Google News · English', query:`Bitcoin ${enParts.join(' ')} when:3d`, locale:'en' });
  else if (words.length) queries.push({ id:'en', label:'Google News · English', query:`Bitcoin ${words.join(' ')} when:3d`, locale:'en' });
  queries.push({ id:'base', label:'Google News · Market', query:'Bitcoin price analysis when:2d', locale:'en' });
  return { queries, hints, words };
}
function googleNewsUrl(query, locale) {
  const params = locale === 'en'
    ? 'hl=en-US&gl=US&ceid=US:en'
    : 'hl=zh-CN&gl=CN&ceid=CN:zh-Hans';
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&${params}`;
}
async function fetchNewsFeed({ label, url, signal }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEB_FETCH_TIMEOUT);
  let composite = controller.signal;
  try {
    // 与外层取消信号合并：用户关掉窗口时立刻停掉检索，不空转。
    // Merge with the caller's signal so closing the panel cancels the search immediately.
    if (signal && typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') composite = AbortSignal.any([signal, controller.signal]);
    const response = await fetch(url, {
      signal:composite,
      headers:{ accept:'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8', 'user-agent':WEB_UA }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const xml = (await response.text()).slice(0, 400_000);
    return parseRssItems(xml, 24).map(item => ({ ...item, feed:label }));
  } finally {
    clearTimeout(timer);
  }
}
// 同一标题被多家媒体转载是常态：按规范化标题去重，再按时间倒序，最后只留最近的。
// Cross-posted headlines are the norm: dedupe by normalised title, then newest first.
function dedupeNews(items) {
  const seen = new Set();
  const out = [];
  for (const item of [...items].sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0))) {
    const norm = item.title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '').slice(0, 52);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push(item);
  }
  return out;
}
// 检索一次外部信息。失败不算致命：返回 attempted=true、items=[]，提示词照常构建。
// A failed search is never fatal: it returns attempted=true with no items.
async function webSearch(question, { lang = 'zh', signal } = {}) {
  const built = buildSearchQueries(question, lang);
  const queries = built.queries;
  const cacheKey = queries.map(q => q.query).join('|');
  const hit = webCache.get(cacheKey);
  const now = Date.now();
  if (hit && now - hit.at < WEB_TTL) return { ...hit.value, cached:true, cacheAgeMs:now - hit.at };
  const startedAt = Date.now();
  const settled = await Promise.allSettled(queries.map(entry => fetchNewsFeed({ label:entry.label, url:googleNewsUrl(entry.query, entry.locale), signal })));
  const feeds = settled.map((result, index) => ({
    label:queries[index].label,
    query:queries[index].query,
    ok:result.status === 'fulfilled',
    reason:result.status === 'rejected' ? String(result.reason?.message || result.reason).slice(0, 120) : null,
    count:result.status === 'fulfilled' ? result.value.length : 0
  }));
  const raw = settled.flatMap(result => (result.status === 'fulfilled' ? result.value : []));
  // 相关性优先：先剔掉山寨币软文与纯 SEO 稿，再按分数 + 时间排序。
  // Relevance first: drop altcoin/SEO filler, then rank by score plus recency.
  const scored = raw.map(item => ({ ...item, score:relevanceScore(item, built.words, built.hints) }));
  const relevant = dedupeNews(scored.filter(item => item.score > 0));
  const merged = relevant.length >= 6 ? relevant : dedupeNews(scored);
  const ranked = merged
    .sort((a, b) => (b.score || 0) - (a.score || 0) || (b.publishedAt || 0) - (a.publishedAt || 0))
    .slice(0, WEB_ITEM_LIMIT);
  const value = {
    items:ranked,
    attempted:true,
    feeds,
    sources:[...new Set(ranked.map(item => item.source).filter(Boolean))].slice(0, 8),
    fetchedAt:new Date(now).toISOString(),
    elapsedMs:Date.now() - startedAt,
    cached:false,
    cacheAgeMs:0,
    ttlMs:WEB_TTL
  };
  webCache.set(cacheKey, { at:now, value });
  // 缓存别无限增长：超过 60 条就丢掉最旧的。
  // Keep the cache bounded: drop the oldest entries past 60.
  if (webCache.size > 60) for (const key of [...webCache.keys()].slice(0, webCache.size - 60)) webCache.delete(key);
  return value;
}
function beijingStamp(iso) {
  try {
    return new Date(iso).toLocaleString('zh-CN', { timeZone:'Asia/Shanghai', hour12:false, month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
  } catch { return iso; }
}
// 把毫秒时间戳格式成「北京时间」YYYY-MM-DD HH:MM。快照里所有日历时间都按北京时间呈现，
// 与提示词中「以快照里 investmentCalendar 的北京时间为准」一致；之前误用 toISOString()（UTC），会整体偏早 8 小时。
// Render an epoch as Beijing (Asia/Shanghai) time. The snapshot promises Beijing time to the model,
// but the old code used toISOString() (UTC), shifting every event 8 hours early.
function beijingDateTime(ms) {
  try {
    const parts = new Intl.DateTimeFormat('zh-CN', { timeZone:'Asia/Shanghai', hour12:false, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }).formatToParts(new Date(ms));
    const m = {}; for (const p of parts) m[p.type] = p.value;
    const hour = m.hour === '24' ? '00' : m.hour;
    return `${m.year}-${m.month}-${m.day} ${hour}:${m.minute}`;
  } catch { return new Date(ms).toISOString().slice(0, 16).replace('T', ' '); }
}
// 把检索结果写成一段可核对的上下文；条数与来源都在，模型不能凭空编造。
// Render the results as checkable context: counts and outlets are explicit so nothing is invented.
function formatWebContext(web) {
  const okFeeds = web.feeds.filter(feed => feed.ok).length;
  const head = `以下是服务端刚刚从公开互联网检索到的最新信息（检索时间 ${beijingStamp(web.fetchedAt)} 北京时间，命中 ${web.items.length} 条，成功源 ${okFeeds}/${web.feeds.length}）。这是**外部公开信息**，不是本站快照数据。`;
  const rows = web.items.map((item, index) => {
    const when = item.publishedAt ? beijingStamp(new Date(item.publishedAt).toISOString()) : '时间未知';
    const outlet = item.source || '未知来源';
    const body = item.summary && item.summary !== item.title ? `\n   摘要：${item.summary}` : '';
    return `${index + 1}. [${outlet} · ${when}] ${item.title}${body}`;
  }).join('\n');
  const rules = [
    '使用规则（必须遵守）：',
    '1. 以本站快照数据为判断主体，外部信息只用来解释「为什么现在是这样」以及「接下来有什么催化剂」，不要让新闻标题盖过真实价格与指标。',
    '2. 引用外部信息必须写明来源与时间（例如「据 CoinDesk 09-11 报道」），不得编造上面没有出现的新闻、数字或机构观点。',
    '3. 如果外部信息与快照数据矛盾（例如新闻说大涨但价格在跌），必须明确点出这个矛盾，并说明你更相信哪一个、为什么。',
    '4. 如果这些外部信息与用户的问题无关、或不足以支撑结论，就直接说「最新公开消息里没有能解释这件事的内容」，不要硬凑。',
    '5. 不要输出网址，也不要罗列全部条目；只挑与问题直接相关的 2-4 条来讲。',
    '6. 涉及宏观数据的公布时间，一律以快照里 investmentCalendar 的北京时间为准；外部新闻里的时间多为当地时区，不要直接当成北京时间照抄。'
  ].join('\n');
  return `${head}\n\n${rows}\n\n${rules}`;
}
const WEB_EMPTY_HINT = '本次已尝试联网检索，但没有取到可用的最新公开信息（可能是网络受限或源暂时不可用）。不要编造网络消息或新闻标题，只依据快照数据分析，并明确告诉用户「这次没取到最新外部消息」。';

// 简易令牌桶：本地服务也要防止误触造成的密钥烧钱。
// A small token bucket: even a local service must protect the key from accidental floods.
const RATE_LIMIT = { capacity:12, refillMs:5_000 };
const buckets = new Map();
function rateAllow(key) {
  const now = Date.now(), bucket = buckets.get(key) || { tokens:RATE_LIMIT.capacity, at:now };
  const gained = Math.floor((now - bucket.at) / RATE_LIMIT.refillMs);
  if (gained > 0) { bucket.tokens = Math.min(RATE_LIMIT.capacity, bucket.tokens + gained); bucket.at = now; }
  if (bucket.tokens <= 0) { buckets.set(key, bucket); return false; }
  bucket.tokens -= 1; buckets.set(key, bucket); return true;
}
setInterval(() => { for (const [key, bucket] of buckets) if (Date.now() - bucket.at > 60_000) buckets.delete(key); }, 60_000).unref?.();

// ---------- 指标计算 / Indicator maths ----------
function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let acc = values.slice(0, period).reduce((sum, v) => sum + v, 0) / period;
  for (let i = period; i < values.length; i += 1) acc = values[i] * k + acc * (1 - k);
  return acc;
}
function emaSeries(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1), out = [];
  let acc = values.slice(0, period).reduce((sum, v) => sum + v, 0) / period;
  out.push(acc);
  for (let i = period; i < values.length; i += 1) { acc = values[i] * k + acc * (1 - k); out.push(acc); }
  return out;
}
function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gain += diff; else loss -= diff;
  }
  let avgGain = gain / period, avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i += 1) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}
function macd(closes) {
  if (closes.length < 35) return null;
  const fast = emaSeries(closes, 12), slow = emaSeries(closes, 26);
  const offset = fast.length - slow.length;
  const line = [], diffs = [];
  for (let i = 0; i < slow.length; i += 1) { const v = fast[i + offset] - slow[i]; line.push(v); diffs.push(v); }
  if (diffs.length < 9) return null;
  const signal = emaSeries(diffs, 9);
  const last = line[line.length - 1], sig = signal[signal.length - 1];
  const prev = line[line.length - 2], prevSig = signal[signal.length - 2];
  return { line:last, signal:sig, histogram:last - sig, prevHistogram:prev - prevSig, trend:last > sig ? 'bull' : 'bear' };
}
function bollinger(closes, period = 20) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period), mean = slice.reduce((s, v) => s + v, 0) / period;
  const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  return { mid:mean, upper:mean + 2 * sd, lower:mean - 2 * sd, widthPct:(4 * sd / mean) * 100 };
}
function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = candles.length - period; i < candles.length; i += 1) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  return trs.reduce((s, v) => s + v, 0) / trs.length;
}
function pct(a, b) { return Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? (a / b - 1) * 100 : null; }
function round(value, digits = 2) { return Number.isFinite(value) ? Number(value.toFixed(digits)) : null; }

// 单周期画像：把一堆 K 线压成模型真正需要的十几个数字。
// One timeframe profile: compress candles into the dozen numbers that actually matter.
function timeframeProfile(candles, keepCandles) {
  if (!Array.isArray(candles) || candles.length < 30) return null;
  const closes = candles.map(c => c.close);
  const last = candles[candles.length - 1];
  const lastClose = last.close;
  const ema20 = ema(closes, 20), ema50 = ema(closes, 50), ema200 = ema(closes, 200);
  const rsiValue = rsi(closes, 14), macdValue = macd(closes), boll = bollinger(closes, 20), atrValue = atr(candles, 14);
  const recentVolume = candles.slice(-5).reduce((s, c) => s + (c.volume || 0), 0) / 5;
  const baseVolume = candles.slice(-25, -5).reduce((s, c) => s + (c.volume || 0), 0) / 20;
  const high = Math.max(...candles.map(c => c.high));
  const low = Math.min(...candles.map(c => c.low));
  const returns = closes.slice(1).map((v, i) => Math.log(v / closes[i]));
  const mean = returns.reduce((s, v) => s + v, 0) / returns.length;
  const vol = Math.sqrt(returns.reduce((s, v) => s + (v - mean) ** 2, 0) / returns.length) * Math.sqrt(365) * 100;
  // 多空打分：趋势 + 动量 + 位置，简单但可解释。
  // Directional score: trend + momentum + position. Simple, but explainable.
  let score = 0;
  if (ema20 && ema50) score += lastClose > ema20 ? 1 : -1;
  if (ema20 && ema50) score += ema20 > ema50 ? 1 : -1;
  if (ema50 && ema200) score += ema50 > ema200 ? 1 : -1;
  if (macdValue) score += macdValue.histogram > 0 ? 1 : -1;
  if (rsiValue !== null) score += rsiValue > 55 ? 1 : rsiValue < 45 ? -1 : 0;
  if (boll) score += lastClose > boll.mid ? 0.5 : -0.5;
  return {
    last:round(lastClose, 2),
    ema20:round(ema20, 2), ema50:round(ema50, 2), ema200:round(ema200, 2),
    rsi14:round(rsiValue, 1),
    macd:macdValue ? { line:round(macdValue.line, 2), signal:round(macdValue.signal, 2), histogram:round(macdValue.histogram, 2), trend:macdValue.trend } : null,
    bollinger:boll ? { upper:round(boll.upper, 2), mid:round(boll.mid, 2), lower:round(boll.lower, 2), widthPct:round(boll.widthPct, 2) } : null,
    atr14:round(atrValue, 2),
    rangeHigh:round(high, 2), rangeLow:round(low, 2),
    positionInRange:round(((lastClose - low) / (high - low)) * 100, 1),
    volumeRatio:round(baseVolume ? recentVolume / baseVolume : null, 2),
    annualisedVolPct:round(vol, 1),
    score:round(score, 1),
    candles:candles.slice(-keepCandles).map(c => [c.time, round(c.open, 2), round(c.high, 2), round(c.low, 2), round(c.close, 2), round(c.volume, 2)])
  };
}

// 从日历负载里挑出"事件"数组：先看语义字段名，避免误抓 marketSignals 这类行情数组。
// Pick the event array by semantic key first, so market-signal arrays are never mistaken for a calendar.
function pickCalendarRows(payload) {
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['events','items','rows','calendar','schedule','data']) {
    const value = payload[key];
    if (Array.isArray(value) && value.length) return value;
  }
  const arrays = Object.entries(payload).filter(([key, value]) => Array.isArray(value) && value.length && !/signal/i.test(key));
  if (!arrays.length) return [];
  return arrays.sort((a, b) => b[1].length - a[1].length)[0][1];
}
function shortDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 1e11) return beijingDateTime(numeric);
  return String(value).slice(0, 40);
}
// 日历负载里的时间可能是「毫秒时间戳」也可能是「已格式化字符串」；只有前者才能算倒计时。
// Calendar payloads carry either epoch milliseconds or an already formatted string; only the former can be counted down.
function epochMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 1e11 ? numeric : null;
}
// 事件时间相对「现在」的倒计时：服务端算好，模型直接照抄，不再自行换算时区或猜「还有多久」。
// Countdown relative to `now`, computed server-side so the model copies it instead of converting time zones or guessing.
function humanCountdown(atMs, now = Date.now()) {
  if (!Number.isFinite(atMs)) return null;
  const diffMs = atMs - now, past = diffMs < 0, abs = Math.abs(diffMs);
  const minutes = Math.round(diffMs / 60_000) || 0;
  const span = (amount, unit) => (past ? `已公布约 ${amount} ${unit}前` : `约 ${amount} ${unit}后公布`);
  if (abs < 45_000) return { countdown:past ? '刚刚公布' : '正在公布（不到 1 分钟）', minutesUntil:0 };
  if (abs < 60 * 60_000) return { countdown:span(Math.round(abs / 60_000), '分钟'), minutesUntil:minutes };
  if (abs < 10 * 3_600_000) return { countdown:span((abs / 3_600_000).toFixed(1), '小时'), minutesUntil:minutes };
  if (abs < 48 * 3_600_000) return { countdown:span(Math.round(abs / 3_600_000), '小时'), minutesUntil:minutes };
  if (abs < 10 * 86_400_000) return { countdown:span((abs / 86_400_000).toFixed(1), '天'), minutesUntil:minutes };
  return { countdown:span(Math.round(abs / 86_400_000), '天'), minutesUntil:minutes };
}
// 从任意日历负载里安全地摘出前几条事件，字段未知也不会报错。
// Safely pluck the first few events from any calendar payload with unknown shape.
function summarizeCalendar(payload, limit = 5, now = Date.now()) {
  const rows = pickCalendarRows(payload);
  if (!rows.length) return null;
  return rows.slice(0, limit).map(row => {
    if (!row || typeof row !== 'object') return null;
    const title = row.title || row.event || row.name || row.label || null;
    const raw = row.date || row.time || row.datetime || row.at || row.scheduledAt || row.start || null;
    const atMs = epochMs(raw);
    const importance = row.importance || row.impact || row.level || null;
    const base = title ? { title:String(title).slice(0, 120), date:shortDate(raw), importance:importance ? String(importance) : null } : null;
    if (!base) return null;
    // 只有拿到毫秒时间戳才附倒计时；字符串时间无法可靠换算，就保持原样不编造。
    // Only attach a countdown when an epoch is available; never invent one from a formatted string.
    return atMs === null ? base : { ...base, atMs, ...(humanCountdown(atMs, now) || {}) };
  }).filter(Boolean);
}
// 快照有 20 秒缓存；重新生成（暂停/终止后继续、已发送消息被编辑后重发）时必须按最新时钟重算倒计时。
// The snapshot is cached for 20s, so refresh countdowns against the latest clock on every (re)build.
function refreshMacroCountdown(macro, now = Date.now()) {
  if (!macro || typeof macro !== 'object') return macro;
  const refreshRows = rows => Array.isArray(rows)
    ? rows.map(row => (row && typeof row === 'object' && Number.isFinite(row.atMs) ? { ...row, ...(humanCountdown(row.atMs, now) || {}) } : row))
    : rows;
  return { ...macro, federalReserve:refreshRows(macro.federalReserve), economicCalendar:refreshRows(macro.economicCalendar) };
}

export function createAiChat({ market, liveQuote, marketContext, fearGreedSentiment, fedMonitor, investmentCalendar, getCredential, getVerification, setModel }) {
  getCredentialFn = getCredential || null;
  setModelFn = typeof setModel === 'function' ? setModel : null;
  let snapshotCache = { at:0, source:null, value:null, promise:null };

  async function buildSnapshot(source = 'okx') {
    const now = Date.now();
    if (snapshotCache.source === source && snapshotCache.value && now - snapshotCache.at < SNAPSHOT_TTL) {
      return { ...snapshotCache.value, cacheAgeMs:now - snapshotCache.at };
    }
    // 同一个快照只抓一次：并发提问时共享同一次抓取。
    // One in-flight fetch per snapshot: concurrent questions share it.
    if (snapshotCache.source === source && snapshotCache.promise && now - snapshotCache.at < SNAPSHOT_TTL) {
      return snapshotCache.promise;
    }
    const task = (async () => {
      const settled = await Promise.allSettled([
        liveQuote(source),
        market('1d', 240, source),
        market('4h', 240, source),
        market('1h', 240, source),
        market('5m', 240, source),
        marketContext(source),
        fearGreedSentiment({}),
        fedMonitor(),
        investmentCalendar()
      ]);
      // 追加新数据源时只在数组末尾加，前面的槽位序号被 failures 引用，不能挪。
      // Append new sources at the end; earlier slot indexes are referenced by `failures`.
      // 注意：解构顺序必须与上面数组逐位对应（5m 插在 1h 之后）。
      const [quote, daily, fourHour, hourly, fiveMin, context, sentiment, fed, calendar] = settled.map(r => (r.status === 'fulfilled' ? r.value : null));
      const failures = settled.map((r, i) => (r.status === 'rejected' ? { slot:i, reason:String(r.reason?.message || r.reason) } : null)).filter(Boolean);

      const quoteTicker = quote?.ticker || daily?.ticker || null;
      const dailyCandles = daily?.candles || [];
      const snapshot = {
        generatedAt:new Date().toISOString(),
        source:(quote?.source || daily?.source || source || 'okx').toUpperCase(),
        price:quoteTicker ? {
          last:round(quoteTicker.last, 2),
          change24hPct:round(quoteTicker.changePct, 2),
          high24:round(quoteTicker.high24, 2),
          low24:round(quoteTicker.low24, 2),
          transport:quote?.transport || null,
          fetchedAtMsAgo:quote?.fetchedAt ? now - quote.fetchedAt : null
        } : null,
        timeframes:{
          '1d':timeframeProfile(dailyCandles, 45),
          '4h':timeframeProfile(fourHour?.candles, 36),
          '1h':timeframeProfile(hourly?.candles, 18),
          '5m':timeframeProfile(fiveMin?.candles, 30)
        },
        derivatives:context ? {
          fundingRatePct:round(Number(context.fundingRate) * 100, 4),
          nextFundingRatePct:round(Number(context.nextFundingRate) * 100, 4),
          openInterest:round(Number(context.oi), 2),
          openInterestUnit:context.oiUnit || null,
          basisPct:round(context.basisPct, 3),
          perpPrice:round(context.perpPrice, 2),
          spotPrice:round(context.spotPrice, 2)
        } : null,
        sentiment:sentiment ? {
          fearGreedValue:Number(sentiment.value),
          classification:sentiment.classification || null,
          observedAtMsAgo:sentiment.observedAt ? now - sentiment.observedAt : null
        } : null,
        macro:{
          federalReserve:summarizeCalendar(fed, 4),
          economicCalendar:summarizeCalendar(calendar, 5)
        },
        multiTimeframeScore:null,
        dataGaps:failures.length ? failures.map(f => `slot-${f.slot}: ${f.reason}`) : null
      };
      const scores = Object.entries(snapshot.timeframes).filter(([, v]) => v).map(([tf, v]) => [tf, v.score]);
      if (scores.length) {
        const total = scores.reduce((s, [, v]) => s + (v || 0), 0);
        snapshot.multiTimeframeScore = { perTimeframe:Object.fromEntries(scores), sum:round(total, 1), max:scores.length * 6 };
      }
      snapshotCache = { at:Date.now(), source, value:snapshot, promise:null };
      return snapshot;
    })();
    snapshotCache = { at:snapshotCache.at, source, value:snapshotCache.value, promise:task };
    try { return await task; } finally { if (snapshotCache.promise === task) snapshotCache.promise = null; }
  }

  // ---------- 提示词 / Prompts ----------
  // 三个「回答模式」（语气档位）：同一份数据与同一套事实约束，表达深度不同。
  // Three answer styles share one factual core and differ only in register and depth.
  //   plain    通俗（默认）：完全不用术语，大白话讲清涨跌与时间
  //   balanced 中等：术语首次出现配一句白话解释
  //   pro      专业：术语与指标数值直接给全，适合懂技术分析的人
  const STYLE_PROMPTS = {
    plain: `你是一个帮普通人看懂比特币行情的助手。用户**完全没有技术分析基础**，看不懂 EMA、RSI、MACD、布林带这类术语，也不懂资金费率、基差是什么意思。

你会收到一份 JSON 市场快照（真实数据）和用户的问题。你的唯一目标：**让一个完全不懂的人也能明白现在是什么情况、接下来可能怎么走、他该注意什么。**

## 说话方式（最重要）
1. 像给朋友发微信一样说话，用大白话。不要用"超买""背离""共振"这类词。
2. 万不得已必须提到某个专业指标时，**先说人话，再括号补一句解释**。例如：
   - 好："现在买盘有点过热（一个叫 RSI 的指标冲到 78，超过 70 就算过热），短线容易回调一下"
   - 差："RSI 78 处于超买区间，存在回调风险"
3. 数字要给，但必须说清这个数字**意味着什么**。不要只丢一个数。
   - 好："现价 77,950，离最近的支撑位 76,800 只有 1.5% 的距离，跌下去空间不大"
   - 差："现价 77,950，positionInRange = 0.87"
4. 用生活比喻帮助理解。例如把支撑位说成"地板"、阻力位说成"天花板"、震荡说成"在原地打转"。
5. 不要输出 JSON、不要输出字段名（ema20、rsi14、positionInRange 这些一律不准出现在回答里）。
6. 不写废话，不写"综上所述""值得注意的是"。每句话都要有信息量。

## 回答结构（严格按这 5 段，标题必须逐字照抄）
【结论】
一句话说清：短期（未来 1-2 天）更可能涨、跌，还是原地震荡。给一个大概的概率感觉，比如"六成机会偏跌"。

【为什么这么判断】
说 2-3 条原因，每条都用大白话 + 一个具体数字。要让完全不懂的人也能点头。

【关键价位】
用具体价格说清楚：跌到哪个价格附近可能止跌（支撑），涨到哪个价格附近可能涨不动（阻力）。并说明离现价还有多少距离。

【什么情况说明我判断错了】
用大白话给一个可验证的信号，比如"如果 1 小时收盘价站上 79,200，那我上面说的偏跌就不成立了"。

【风险提醒】
一句话，提醒杠杆和波动风险。不要承诺收益。

## 其他
- 默认用中文回答。如果用户用英文提问，就用英文回答（标题翻成 Conclusion / Why / Key levels / What would prove me wrong / Risk）。
- 如果用户问的不是涨跌预测（比如问"资金费率是什么""怎么用这个页面"），就不用套上面结构，直接像聊天一样用大白话讲清楚就行。
- 数据缺失（快照里是 null）就直说"这个数据现在拿不到"，不要猜。
- 你是做数据分析的，不是给投资建议，不要承诺收益。`,

    balanced: `你是一个比特币行情分析师，服务对象是**懂一点行情、但不算专业**的读者：他知道涨和跌，也听过 RSI、均线，但说不准具体含义，也不想读满屏术语。

你会收到一份 JSON 市场快照（真实数据）和用户的问题。你的目标：让他在半分钟内看懂现在是什么情况、接下来可能怎么走、该盯哪个价格。

## 说话方式
1. 用清楚、正常的中文叙述，不必刻意口语化，也不要堆砌术语。
2. 专业术语**首次出现时用一句白话解释**，之后可以直接使用。例如：
   - 好："相对强弱指标（RSI）已经到 78，这个数超过 70 就说明买方有点过热，短线容易回调一下"
   - 差："RSI 78 处于超买区间，存在回调风险"
3. 关键数字必须给，并说清它相对现价的含义与距离。不要只丢一个数。
4. 可以用少量形象说法（把支撑说成"地板"、阻力说成"天花板"）帮助记忆，但不要整段打比方。
5. 不输出 JSON、不输出原始字段名（ema20、rsi14、positionInRange 这类一律不准出现），改用自然说法（20 日均线、14 日强弱指标）。
6. 不写废话，不写"综上所述""值得注意的是"。每句话都要有信息量。

## 回答结构（严格按这 5 段，标题必须逐字照抄）
【结论】
一句话说清短期（未来 1-2 天）更可能涨、跌还是原地震荡，并给一个概率感觉，比如"六成机会偏跌"。

【为什么这么判断】
给 2-3 条理由，每条都是"指标或数据 + 它意味着什么"。允许出现术语，但按上面的规则解释一次。

【关键价位】
用具体价格说清支撑与阻力，并给出离现价的百分比距离；如果日线、4 小时、1 小时给出的位置互相冲突，点明哪个更值得信。

【什么情况说明我判断错了】
给一个可验证的失效条件，例如"如果 1 小时收盘价站上 79,200，上面说的偏跌就不成立"。

【风险提醒】
一句话，提醒杠杆与波动风险，不承诺收益。

## 其他
- 默认用中文回答。如果用户用英文提问，就用英文回答（标题翻成 Conclusion / Why I think so / Key price levels / What would prove me wrong / Risk）。
- 如果用户问的不是涨跌预测（比如问"资金费率是什么""怎么用这个页面"），不用套上面结构，直接讲清楚就好。
- 数据缺失（快照里是 null）就直说"这个数据现在拿不到"，不要猜。
- 你是做数据分析的，不是给投资建议，不要承诺收益。`,

    pro: `你是一名加密货币衍生品交易员，为用户提供结构化的比特币行情研判。用户熟悉技术分析，能直接读懂 EMA、MACD、RSI、布林带、ATR、资金费率、基差、持仓量等概念，**不需要任何白话解释，也不要用生活比喻**。

你会收到一份 JSON 市场快照（真实数据）和用户的问题。

## 表达要求
1. 直接使用专业术语，指标带上周期与取值（如 EMA20、RSI14、MACD 柱、布林带宽、ATR14）。
2. 数字要精确，并给出相对现价的百分比距离；涉及衍生品时标明资金费率与基差的符号与量级。
3. 多周期分开陈述：日线定方向、4 小时看结构、1 小时找入场，明确点出是共振还是背离。
4. 观点必须可证伪：给出触发条件与失效条件，用"若 X 则 Y"的条件化表述，避免"可能、也许"式模糊措辞。
5. 允许讨论情景与概率分布（主情景、次情景各给概率），但必须基于快照数据，不得凭空想象。
6. 不输出 JSON、不输出原始字段名（如 positionInRange、basisPct），指标名按行业习惯书写即可。
7. 信息密度优先，不写"综上所述""值得注意的是"这类填充句。

## 回答结构（严格按这 5 段，标题必须逐字照抄）
【结论】
一句话给出方向判断（偏多 / 偏空 / 区间震荡）与时间尺度，并附主情景概率。

【为什么这么判断】
给 3-4 条依据，逐条列出指标读数、所处周期、以及它支持哪个方向；如果有相互冲突的证据，明确指出并说明你如何权衡。

【关键价位】
给出具体的支撑与阻力价格，标明来源（前高 / 日线 EMA20 / 密集成交区等）与距离百分比；同时标注触发用的一档与止损参考位。

【什么情况说明我判断错了】
给出明确的失效价位或条件，例如"4 小时收盘跌破 76,800 且 RSI14 下穿 50，偏多逻辑作废"。

【风险提醒】
一句话，提示杠杆、流动性与事件窗口风险（如宏观数据公布）。

## 其他
- 默认用中文回答。如果用户用英文提问，就用英文回答（标题翻成 Conclusion / Why I think so / Key levels / What would invalidate this / Risk）。
- 如果用户问的不是涨跌预测，简洁作答即可，不必套上面的结构。
- 快照中为 null 的数据直接说明缺失，不得推测填充。
- 你是做数据分析的，不是给投资建议，不要承诺收益。`
  };

  // 排版约定：前端会把纯文本渲染成富文本（方向词着色、价格/百分比高亮、
  // 列表、Markdown 表格）。引导模型在合适场景结构化输出，让回答更清晰。
  // Formatting contract: the frontend renders plain text as rich HTML. Nudge the
  // model to emit structured output (lists / Markdown tables) where it helps.
  const FORMAT_HINT = `

## 排版格式（让回答清晰、好扫读）
你的回答会被前端渲染成富文本（标题区块、着色、数字高亮、列表、表格、图表），请遵守下面的约定：

### 1. 罗列优先，不要写大段文字
- 【为什么这么判断】必须用 \`- \` 无序列表分行列出，**每条一行，一条一个依据**，不要挤成一段话。
- 【关键价位】用列表或表格给出，不要写成连续叙述。
- 【结论】保持 1-2 句，不要铺开。
- 并列的要点、条件、情形，一律分行；能用列表就不用段落。

### 2. 重点数据要突出
- 具体价格、百分比、指标读数务必如实写出（如 77,155.30、−65.3%、RSI14 为 38.2），前端会自动加粗/着色/加底。
- 结论性的关键数字（现价、强平价、关键支撑阻力位）建议用 \`**加粗**\` 包一层，读者一眼能抓住。
- 方向词（上涨/下跌、看多/看空、支撑/阻力）前端会自动着色，正常书写即可。

### 3. 表格只用于真正的横向对比
- 适合用 Markdown 表格的场景：多周期（日线 / 4 小时 / 1 小时 / 5 分钟）方向与关键读数对比；支撑阻力价位清单（价格 | 距现价 | 来源 | 强度）；持仓指标（开仓价 | 现价 | 强平价 | ROE | 距强平）；外部信息对照（来源 | 时间 | 内容要点）。
- 表头用中文。只有 2 列且行数少于 3 行时不要用表格，直接列表更清楚。

### 4. 图表：只在图比文字更简明时才加
- 判断标准：当你要比较**同一类数值**在 3 个以上对象上的大小（例如各周期 RSI、各情景概率、各价位强度），用图比表格更直观；数据只有一两个、或信息本身是文字与方向，就**不要**加图。
- 加图时插入一个 chart 代码块，格式如下（标签与数值各占一行，数值必须是快照或检索结果里的真实数值，不得编造）：

\`\`\`chart
type: bar
title: 各周期 RSI14 对比
日线: 38.2
4小时: 45.1
1小时: 52.7
\`\`\`

- \`type\` 可写 \`bar\`（横向条形，适合比大小）或 \`line\`（折线，适合按时间排列的变化）。
- \`title\` 可省略。数值后面可以带 \`%\`，前端会照原样显示。
- 一个回答最多 1 张图；图放在对应段落内部，不要另起一段堆在末尾。

### 5. 结构不变
仍然严格保留五段固定标题，顺序不能改，标题必须逐字照抄。表格、列表、图表都放在对应段落内部。`;

  // 按档位取提示词；未知档位落回默认，防止提示词为空。
  function buildSystemPrompt(style) {
    return STYLE_PROMPTS[normalizeStyle(style)] + FORMAT_HINT;
  }

  // ---------- 用户上下文 / Personal context ----------
  // 前端随提问附带「我的持仓 + 页面信号面板」。浏览器来的数据不可信：
  // 只接受白名单里的有限数字/枚举，字符串一律压空白并截断。
  // Browser-supplied data is untrusted: whitelist a few numeric fields, clip strings.
  const POSITION_MMR = 0.005; // 与页面持仓卡相同的维持保证金率假设 / same assumption as the on-page card

  const finitePositive = (value, max) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 && n < max ? n : null;
  };
  const clippedText = (value, max) => {
    if (typeof value !== 'string') return null;
    const text = value.replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, max) : null;
  };

  function sanitizeContext(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const positions = (Array.isArray(raw.positions) ? raw.positions : [])
      .slice(0, 2)
      .map(p => ({
        side: p && p.side === 'short' ? 'short' : 'long',
        entryPrice: finitePositive(p?.entryPrice, 10_000_000),
        sizeUsd: finitePositive(p?.sizeUsd, 1_000_000_000),
        marginUsd: finitePositive(p?.marginUsd, 1_000_000_000),
        leverage: finitePositive(p?.leverage, 500)
      }))
      .filter(p => p.entryPrice);
    let pageSignals = null;
    if (raw.pageSignals && typeof raw.pageSignals === 'object') {
      const ruleSignal = clippedText(raw.pageSignals.ruleSignal, 600);
      const directionalEstimate = clippedText(raw.pageSignals.directionalEstimate, 400);
      if (ruleSignal || directionalEstimate) pageSignals = { ruleSignal, directionalEstimate };
    }
    if (!positions.length && !pageSignals) return null;
    return { positions: positions.length ? positions : null, pageSignals };
  }

  // 用快照现价把持仓推算成结论级数值（浮动盈亏 / 回报 / 理论强平价），
  // 模型不需要自己算术，也就不会算错。
  // Pre-compute position metrics from the snapshot price so the model never does arithmetic.
  function derivePositionMetrics(positions, lastPrice) {
    if (!Array.isArray(positions) || !positions.length || !Number.isFinite(lastPrice)) return positions;
    return positions.map(p => {
      const leverage = p.leverage || (p.sizeUsd && p.marginUsd ? p.sizeUsd / p.marginUsd : null);
      // 强平价必须用「有效杠杆」（仓位 / 当前保证金，含追加保证金），与页面持仓卡一致：
      // 用开仓杠杆会在追加保证金后把强平价算得偏近（虚惊一场）。ROE 的保证金口径本就取 marginUsd。
      // Liquidation must use effective leverage (size / current margin, including top-ups), matching
      // the on-page card; open leverage makes liq look closer than it really is after a top-up.
      const effectiveLeverage = p.sizeUsd && p.marginUsd ? p.sizeUsd / p.marginUsd : leverage;
      const diffPct = ((lastPrice - p.entryPrice) / p.entryPrice) * 100 * (p.side === 'short' ? -1 : 1);
      const pnl = p.sizeUsd != null ? p.sizeUsd * (diffPct / 100) : null;
      const margin = p.marginUsd || (p.sizeUsd && leverage ? p.sizeUsd / leverage : null);
      const roePct = pnl != null && margin ? (pnl / margin) * 100 : null;
      const liquidation = effectiveLeverage
        ? p.side === 'short'
          ? p.entryPrice * (1 + 1 / effectiveLeverage - POSITION_MMR)
          : p.entryPrice * (1 - 1 / effectiveLeverage + POSITION_MMR)
        : null;
      const liqDistancePct = liquidation ? ((liquidation - lastPrice) / lastPrice) * 100 : null;
      return {
        ...p,
        leverage: leverage ? round(leverage, 2) : null,
        effectiveLeverage: effectiveLeverage ? round(effectiveLeverage, 2) : null,
        priceDiffPct: round(diffPct, 2),
        pnlUsd: pnl != null ? round(pnl, 2) : null,
        marginUsd: margin,
        roePct: roePct != null ? round(roePct, 2) : null,
        liquidationPrice: liquidation ? round(liquidation, 2) : null,
        liquidationDistancePct: liqDistancePct != null ? round(liqDistancePct, 2) : null
      };
    });
  }

  function buildMessages(snapshot, history, lang, thinking, style, web) {
    const language = lang === 'en' ? 'en' : 'zh';
    const deepMode = thinking === 'deep';
    const messages = [];
    // 规则放 system：会话内稳定，利于上下文缓存；快照单独一条，便于服务端复用。
    // Rules live in a stable system message (cache-friendly); the snapshot gets its own message.
    messages.push({
      role:'system',
      content:language === 'en'
        ? buildSystemPrompt(style) + '\n\nWrite the answer in English. Translate the five fixed section labels into English: Conclusion, Why I think so, Key price levels, What would prove me wrong, Risk.'
        : buildSystemPrompt(style)
    });
    // 「现在」每次请求都重新取值：暂停/终止后继续、已发送消息被编辑后重发，都拿最新北京时间。
    // Re-read the clock on every request so resumed, stopped or re-edited generations use the latest Beijing time.
    const nowMs = Date.now();
    const nowBeijing = beijingDateTime(nowMs);
    const payload = { ...snapshot, macro:refreshMacroCountdown(snapshot.macro, nowMs) };
    messages.push({
      role:'system',
      content:`以下是生成于 ${snapshot.generatedAt} 的实时市场快照（数据源 ${snapshot.source}，快照缓存 ${snapshot.cacheAgeMs || 0} 毫秒）。这是原始数据，字段名仅供你参考，不要出现在回答里：\n\n${JSON.stringify(payload)}\n\n当前北京时间 ${nowBeijing}；快照中所有日历时间均为北京时间。日历条目里的 countdown / minutesUntil 是服务端按上面的北京时间算好的，直接照抄即可；不要自行换算时区，也不要把外部新闻里的当地时间当成北京时间。`
    });
    // 联网检索结果：紧跟快照注入，模型才能做「本地数据 × 外部信息」的交叉验证。
    // Web results follow the snapshot so the model can cross-check one against the other.
    if (web && web.items && web.items.length) {
      messages.push({
        role:'system',
        content:language === 'en'
          ? `${formatWebContext(web)}\n\nWrite this section's citations in English.`
          : formatWebContext(web)
      });
    } else if (web && web.attempted) {
      messages.push({ role:'system', content:WEB_EMPTY_HINT });
    }
    if (snapshot.userContext) {
      messages.push({
        role:'system',
        content:'快照里的 userContext 是用户自己的数据，必须优先考虑：\n1. positions 是用户手填的持仓（已按快照现价推算出浮动盈亏 pnlUsd、保证金回报 roePct、理论强平价 liquidationPrice 及其距现价百分比 liquidationDistancePct）。只要存在持仓，回答必须把仓位状况纳入：信号方向与持仓方向是否相反、离强平还有多远；若信号与持仓方向相反，必须直说风险，但不替用户做平仓决定。\n2. pageSignals 是页面自身规则模块的输出原文（规则信号分数、信号有效期/有效区间、方向研究估算）。可以引用，但要与快照数据交叉验证，发现矛盾就指出来。\n3. userContext 为 null 表示用户没填持仓，此时不要虚构任何仓位信息。\n4. 表达方式仍严格遵循所选回答模式的要求。'
      });
    }
    if (deepMode) {
      messages.push({
        role:'system',
        content:'本次是「深度分析」模式：请更充分地权衡多空双方的理由，结论可以更谨慎、更保守，但表达方式仍严格遵循上面所选回答模式的要求。'
      });
    }
    // 只带最近若干轮，且剔除内部上下文字段，避免上下文无限膨胀。
    // Keep only the latest turns so the context cannot grow without bound.
    const trimmed = (Array.isArray(history) ? history : [])
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-12)
      .map(({ role, content }) => ({ role, content:content.slice(0, 2_000) }));
    // 多轮提示：明确告诉模型「这是同一场对话的延续」，否则它容易把追问当新问题重头讲。
    // Multi-turn hint: state that the turns below are the same conversation, otherwise the model
    // tends to treat a follow-up as a brand-new question and restarts from scratch.
    if (trimmed.length) {
      messages.push({
        role:'system',
        content: language === 'en'
          ? 'This is a multi-turn conversation. The user/assistant messages below are earlier turns of the same chat. Keep continuity: when the user says "it", "and that one", "go on", "why" or "the previous one", they refer to the preceding turn. Do not restart from scratch, and do not repeat a conclusion you already gave unless the data changed.'
          : '这是一场多轮对话：下面 user / assistant 消息是同一场对话的历史，回答必须延续上下文。用户说「它」「那这个呢」「继续」「为什么」「刚才那个」时，指的就是上一轮的内容；不要把追问当成全新问题从头讲一遍，也不要重复已经给过的结论，除非数据变了。'
      });
    }
    messages.push(...trimmed);
    return messages;
  }

  function friendlyError(error, status, credential) {
    const mismatch = endpointMismatch(credential);
    if (mismatch) return `千问 Key 与端点不匹配：${mismatch.reason}。当前填的是 ${mismatch.actual}，应改为 ${mismatch.expected}`;
    if (status === 401 || status === 403) {
      const prefix = String(credential?.key || '').slice(0, 3);
      const hint = prefix === 'sk-' && !/^sk-sp-/i.test(credential?.key || '')
        ? '（若你订阅的是 Token Plan 个人版，端点须改成 https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1）'
        : '';
      return `千问拒绝了本次请求（401/403）：API Key 无效、过期或没有该模型的权限${hint}。请到「API 接入中心」重新保存 Key。`;
    }
    if (status === 429) return '千问返回 429：请求太快或额度用尽（Token Plan 为每周 Credits 额度），请稍后再试。';
    if (status === 400) return `千问返回 400：${error}`;
    if (error === 'timeout') return `调用千问超时（${QWEN_TIMEOUT_MS / 1000} 秒）。思考型模型较慢，可在 API 接入中心换成 qwen3.8-flash 提速。`;
    return `调用千问失败：${error}`;
  }

  async function callQwen({ credential, messages, stream, signal, thinking }) {
    const base = String(credential.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const url = `${base}/chat/completions`;
    // 快速模式（默认）：关掉思考，直接回答，速度提升数倍。
    // 深度模式：保留思考，并用 thinking_budget 限制推理长度避免跑飞。
    // Fast mode (default) disables reasoning for a big speed win; deep mode keeps it, capped.
    const deepMode = thinking === 'deep';
    const buildBody = (includeThinkingParam) => {
      const body = {
        model:credential.model || DEFAULT_MODEL,
        messages,
        // 非思考模式推荐 temperature 0.7 / top_p 0.8；思考模式推荐 0.6 / 0.95。
        // Non-thinking suggests 0.7 / 0.8; thinking suggests 0.6 / 0.95.
        temperature:deepMode ? 0.6 : 0.7,
        top_p:deepMode ? 0.95 : 0.8,
        // 快速模式不需要给推理留余量；深度模式思考可能吃掉 2-4k tokens，预算要给足。
        // Fast mode needs no reasoning headroom; deep mode can burn 4k+ tokens thinking.
        max_tokens:deepMode ? 5_500 : 1_400,
        stream:Boolean(stream)
      };
      if (includeThinkingParam) {
        body.enable_thinking = deepMode;
        if (deepMode) body.thinking_budget = 4_096;
      }
      return body;
    };
    const send = async (includeThinkingParam) => {
      const response = await fetch(url, {
        method:'POST',
        signal,
        headers:{ 'content-type':'application/json', authorization:`Bearer ${credential.key}` },
        body:JSON.stringify(buildBody(includeThinkingParam))
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        let parsed = null;
        try { parsed = JSON.parse(detail); } catch { /* 非 JSON 错误体直接忽略 / ignore non-JSON error bodies */ }
        const message = parsed?.error?.message || parsed?.message || detail.slice(0, 200);
        return { ok:false, status:response.status, error:message || `HTTP ${response.status}` };
      }
      return { ok:true, response };
    };
    let result = await send(true);
    // 端点/模型不认识 enable_thinking 时会 400，此时静默降级重试一次。
    // If the endpoint rejects enable_thinking with a 400, retry once without it.
    if (!result.ok && result.status === 400 && /enable_thinking|thinking_budget|thinking|extra|unknown|unsupported|invalid.*(param|argument|field)/i.test(String(result.error || ''))) {
      result = await send(false);
    }
    if (!result.ok) return result;
    const response = result.response;
    // 抓住响应头里的配额信息，成功调用都会更新 remote 配额。
    // Capture rate-limit headers so every successful call refreshes the remote quota.
    const headerQuota = parseRateLimitHeaders(response.headers);
    if (headerQuota) quotaState.remote = headerQuota;
    return { ok:true, response, deepMode };
  }

  // 非流式：一次性拿全文本。Non-streaming: a single round trip.
  async function complete({ credential, messages, signal, thinking }) {
    const result = await callQwen({ credential, messages, stream:false, signal, thinking });
    if (!result.ok) return { ok:false, status:result.status, error:result.error };
    const payload = await result.response.json();
    const content = payload?.choices?.[0]?.message?.content || '';
    const usage = payload?.usage || null;
    const model = payload?.model || credential.model || DEFAULT_MODEL;
    recordLocalUsage({ usage, model });
    return { ok:true, content, usage, model, deepMode:Boolean(result.deepMode) };
  }

  // 先把 SSE 响应头与「已连上」事件发出去，前端才能立刻显示「正在联网检索」这类进度，
  // 而不用干等整个检索 + 模型首 token。
  // Send the SSE headers (and a started event) first so the UI can show live progress
  // instead of sitting silent through the search plus the model's first token.
  function startSse(res, { model, deepMode }) {
    if (res.writableEnded) return false;
    if (!res.headersSent) {
      res.writeHead(200, {
        'content-type':'text/event-stream; charset=utf-8',
        'cache-control':'no-store, no-transform',
        connection:'keep-alive',
        'x-accel-buffering':'no',
        'x-content-type-options':'nosniff'
      });
    }
    sendSse(res, { started:true, model:model || DEFAULT_MODEL, deepMode:Boolean(deepMode) });
    return true;
  }

  // 流式：把上游 SSE 增量原样转写给浏览器（响应头已由 startSse 写出）。
  // Streaming: relay upstream SSE deltas (headers already sent by startSse).
  async function relayQwenStream({ credential, messages, res, signal, thinking }) {
    const result = await callQwen({ credential, messages, stream:true, signal, thinking });
    if (!result.ok) { sendSse(res, { error:friendlyError(result.error, result.status, credential) }); return { ok:false }; }
    const reader = result.response.body?.getReader();
    if (!reader) { sendSse(res, { error:'千问返回的响应无法流式读取，请关闭流式重试。' }); return { ok:false }; }
    const decoder = new TextDecoder();
    let buffer = '', full = '', usage = null, model = null, reasoningChars = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream:true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          let parsed;
          try { parsed = JSON.parse(data); } catch { continue; }
          model = parsed.model || model;
          if (parsed.usage) usage = parsed.usage;
          // 深度模式下思考内容走 reasoning_content：只推长度信号，不把推理正文给用户看。
          // In deep mode reasoning arrives on reasoning_content; forward only a progress signal.
          const reasoningDelta = parsed?.choices?.[0]?.delta?.reasoning_content;
          if (reasoningDelta) { reasoningChars += reasoningDelta.length; sendSse(res, { reasoning:reasoningChars }); }
          const delta = parsed?.choices?.[0]?.delta?.content;
          if (delta) { full += delta; sendSse(res, { delta }); }
        }
      }
    } catch (error) {
      if (error.name !== 'AbortError') sendSse(res, { error:friendlyError(error.message, null, credential) });
      return { ok:false, content:full };
    }
    sendSse(res, { done:true, usage, model, reasoningChars });
    recordLocalUsage({ usage, model });
    return { ok:true, content:full, usage, model };
  }

  function sendSse(res, payload) {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    if (payload.done || payload.error) res.end();
  }

  // ---------- 路由处理 / Route handler ----------
  async function handle({ req, res, url, readJsonBody, json, clientKey }) {
    if (url.pathname === '/api/ai/config') {
    const credential = getCredential('qwen') || {};
    const verified = Boolean(getVerification?.('qwen'));
    const resolvedBaseUrl = credential.baseUrl || inferBaseUrl(credential.key);
    json(res, 200, {
      configured:Boolean(credential.key),
      verified,
      available:Boolean(credential.key) && verified,
      model:credential.model || DEFAULT_MODEL,
      baseUrl:resolvedBaseUrl,
      // 端点与 Key 前缀是否一致（保存时留空会自动匹配，故通常一致）
      // Whether the endpoint matches the key prefix (auto-matched when left blank).
      matched:resolvedBaseUrl === inferBaseUrl(credential.key),
      // 已存端点跨体系时被自动纠正过（例如 sk-sp- 的 Key 存了 dashscope 端点）。
      // Set when a stored endpoint from the wrong system was corrected automatically.
      autoCorrected:Boolean(credential.autoCorrected),
      keyKind:/^sk-sp-/i.test(String(credential.key || '')) ? 'token-plan' : 'dashscope',
      mismatch:endpointMismatch(credential) || null,
      endpoints:QWEN_ENDPOINTS,
      models:QWEN_MODELS,
      // 未配置模型时服务端会落到这个默认值（前端可据此高亮「推荐」）。
      // The server falls back to this when no model is stored; the UI uses it to mark "recommended".
      defaultModel:DEFAULT_MODEL,
      // 思考模式：fast = 关闭推理（默认，快数倍）；deep = 保留推理（慢但更审慎）。
      // Thinking modes: fast disables reasoning (default, several times quicker); deep keeps it.
      thinkingModes:[
        { id:'fast', label:'快速（默认）· 秒级回答', hint:'关闭模型思考，直接给结论' },
        { id:'deep', label:'深度 · 慢但更审慎', hint:'保留推理过程，约需 1-2 分钟' }
      ],
      defaultThinking:'fast',
      // 回答模式（语气档位）：与思考模式正交，前端据此渲染选择器。
      // Answer styles (register): orthogonal to thinking modes; the UI renders the picker from this.
      answerStyles:ANSWER_STYLES,
      defaultStyle:DEFAULT_STYLE,
      // 联网检索：前端据此渲染「联网 / 离线」开关与文案。
      // Web research: the UI renders its on/off chip and copy from this block.
      webSearch:{
        available:true,
        defaultEnabled:true,
        ttlMs:WEB_TTL,
        maxItems:WEB_ITEM_LIMIT,
        providers:['Google News RSS（中文）','Google News RSS（English）'],
        note:'服务端按你的问题去公开新闻源检索最近报道与分析，与本站快照数据一起交给模型；关闭后只读本地数据。'
      },
      snapshotTtlMs:SNAPSHOT_TTL
    });
      return true;
    }
    if (url.pathname === '/api/ai/snapshot') {
      try { json(res, 200, { snapshot:await buildSnapshot(url.searchParams.get('source') || 'okx') }); }
      catch (error) { json(res, 503, { error:'市场快照暂不可用', detail:error.message }); }
      return true;
    }
    if (url.pathname === '/api/ai/quota') {
      // 只读：返回当前最新一次响应头 + 本地累计，无需调用千问。
      // Read-only: returns the latest header snapshot + local accumulation. No upstream call.
      json(res, 200, getQuotaState());
      return true;
    }
    if (url.pathname === '/api/ai/model' && req.method === 'PUT') {
      // 切换模型：只改模型名，Key 与端点保持不动，也不用重新验证。
      // Switching the model only rewrites the model name; key and endpoint stay as they are.
      let payload;
      try { payload = await readJsonBody(req, 4_000); }
      catch (error) { json(res, error.statusCode || 400, { error:error.message }); return true; }
      const wanted = String(payload.model || '').trim();
      const entry = QWEN_MODELS.find(m => m.id === wanted);
      if (!entry) { json(res, 400, { error:`不支持的模型：${wanted || '(空)'}。` }); return true; }
      if (!entry.usable) { json(res, 400, { error:`${entry.label} 属于${entry.kind === 'image' ? '图片生成' : '语音识别'}模型，不能用于行情问答。` }); return true; }
      const credential = getCredential('qwen') || {};
      if (!credential.key) { json(res, 503, { error:'尚未配置千问 API Key。请先到「API 接入中心」保存 Key。' }); return true; }
      if (!getVerification?.('qwen')) { json(res, 503, { error:'千问 API Key 尚未验证或验证已失效。请先到「API 接入中心」验证 Key。' }); return true; }
      if (!setModelFn) { json(res, 503, { error:'服务端未启用模型切换。' }); return true; }
      const result = setModelFn(entry.id) || {};
      if (!result.ok) { json(res, 400, { error:result.error || '切换模型失败。' }); return true; }
      json(res, 200, { ok:true, model:entry.id, label:entry.label, note:entry.note, tier:entry.tier });
      return true;
    }
    if (url.pathname === '/api/ai/chat' && req.method === 'POST') {
      let payload;
      try { payload = await readJsonBody(req, 128_000); }
      catch (error) { json(res, error.statusCode || 400, { error:error.message }); return true; }
      const credential = getCredential('qwen');
      if (!credential?.key) { json(res, 503, { error:'尚未配置千问 API Key。请打开右上角「API 接入中心」保存 Key 后再提问。' }); return true; }
      if (!getVerification?.('qwen')) { json(res, 503, { error:'千问 API Key 尚未验证或验证已失效。请打开右上角「API 接入中心」验证 Key 后再提问。' }); return true; }
      if (!rateAllow(clientKey)) { json(res, 429, { error:'提问过于频繁，请稍等几秒再试。' }); return true; }
      const question = String(payload.question || '').trim().slice(0, 2_000);
      if (!question) { json(res, 400, { error:'请输入问题。' }); return true; }
      // 多轮上下文：前端把整段对话带上来（含失败的提问已剔除），这里再按条数兜一次底。
      // Multi-turn context: the client sends the whole conversation; cap it again here as a backstop.
      const history = Array.isArray(payload.history) ? payload.history.slice(-12) : [];
      const wantStream = payload.stream !== false;
      // 默认快速模式（关闭思考）；只有显式传 deep 才启用推理。
      // Fast mode (no reasoning) by default; deep mode only when explicitly requested.
      const thinking = payload.thinking === 'deep' ? 'deep' : 'fast';
      // 回答模式：白名单校验，非法值落回「通俗」。
      // Answer style: whitelisted, anything unknown falls back to plain.
      const style = normalizeStyle(payload.style);
      // 联网检索：默认开启，前端可显式关掉（payload.search === false）。
      // Web research is on by default; the client can switch it off explicitly.
      const wantSearch = payload.search !== false;

      let snapshot;
      try { snapshot = await buildSnapshot(payload.source || 'okx'); }
      catch (error) { json(res, 503, { error:'市场快照获取失败，暂时无法分析。', detail:error.message }); return true; }

      // 用户上下文（持仓 + 页面信号面板）：白名单清洗后，用快照现价推算出盈亏与强平价。
      // Personal context (positions + on-page signals): sanitized, then enriched with the snapshot price.
      const context = sanitizeContext(payload.context);
      const snapshotWithContext = context
        ? {
            ...snapshot,
            userContext:{
              positions: derivePositionMetrics(context.positions, snapshot.price?.last),
              pageSignals: context.pageSignals
            }
          }
        : snapshot;

      // 思考型模型（qwen3.8 系列）会先产出大段推理再出结论，30 秒远远不够。
      // Thinking models emit a long reasoning trace first, so 30s is far too tight.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), QWEN_TIMEOUT_MS);
      req.on('close', () => controller.abort());

      if (wantStream) {
        // 先把响应头写好，前端可以立刻显示「正在联网检索」，不用干等。
        // Write the headers first so the UI can show the search phase immediately.
        if (!startSse(res, { model:credential.model || DEFAULT_MODEL, deepMode:thinking === 'deep' })) return true;
        try {
          const web = wantSearch ? await webSearch(question, { lang:payload.lang, signal:controller.signal }) : null;
          if (res.writableEnded) return true;
          // 检索回执：条数、来源、耗时都推给前端，界面上可核对，也方便排查源是否被墙。
          // Search receipt: count, outlets and latency go to the client for transparency.
          sendSse(res, {
            search:{
              enabled:wantSearch,
              count:web ? web.items.length : 0,
              attempted:Boolean(web),
              sources:web ? web.sources : [],
              feeds:web ? web.feeds : [],
              headlines:web ? web.items.slice(0, 4).map(item => `${item.source ? item.source + ' · ' : ''}${item.title}`) : [],
              fetchedAt:web ? web.fetchedAt : null,
              cached:web ? web.cached : false,
              elapsedMs:web ? web.elapsedMs : 0
            }
          });
          const messages = buildMessages(snapshotWithContext, [...history, { role:'user', content:question }], payload.lang, thinking, style, web);
          const outcome = await relayQwenStream({ credential, messages, res, signal:controller.signal, thinking });
          if (!outcome.ok && !res.writableEnded) json(res, 502, { error:'千问响应失败', detail:outcome.error });
          return true;
        } catch (error) {
          const message = error.name === 'AbortError' ? `调用千问超时（${QWEN_TIMEOUT_MS / 1000} 秒），请稍后重试或改用「快速」模式。` : `调用千问失败：${error.message}`;
          if (!res.headersSent) json(res, 502, { error:message });
          else sendSse(res, { error:message });
          return true;
        } finally { clearTimeout(timer); }
      }

      let web = null;
      if (wantSearch) {
        try { web = await webSearch(question, { lang:payload.lang, signal:controller.signal }); }
        catch { web = null; }
      }
      const messages = buildMessages(snapshotWithContext, [...history, { role:'user', content:question }], payload.lang, thinking, style, web);
      try {
        const outcome = await complete({ credential, messages, signal:controller.signal, thinking });
        if (!outcome.ok) { json(res, 502, { error:friendlyError(outcome.error, outcome.status, credential) }); return true; }
        json(res, 200, {
          content:outcome.content,
          usage:outcome.usage,
          model:outcome.model,
          deepMode:outcome.deepMode,
          search:web ? { enabled:true, count:web.items.length, sources:web.sources, fetchedAt:web.fetchedAt, cached:web.cached } : { enabled:false, count:0 },
          snapshot:{ generatedAt:snapshot.generatedAt, source:snapshot.source, price:snapshot.price }
        });
        return true;
      } catch (error) {
        const message = error.name === 'AbortError' ? `调用千问超时（${QWEN_TIMEOUT_MS / 1000} 秒），请稍后重试或改用「快速」模式。` : `调用千问失败：${error.message}`;
        if (!res.headersSent) json(res, 502, { error:message });
        return true;
      } finally { clearTimeout(timer); }
    }
    return false;
  }

  // webSearch 一并导出，便于本地自检与后续复用（不依赖 HTTP 层）。
  // webSearch is exposed too, so it can be exercised without going through HTTP.
  return { handle, buildSnapshot, webSearch, QWEN_MODELS, getQuotaState };
}
