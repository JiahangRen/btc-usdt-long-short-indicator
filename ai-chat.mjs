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
  if (Number.isFinite(numeric) && numeric > 1e11) return new Date(numeric).toISOString().slice(0, 16).replace('T', ' ');
  return String(value).slice(0, 40);
}
// 从任意日历负载里安全地摘出前几条事件，字段未知也不会报错。
// Safely pluck the first few events from any calendar payload with unknown shape.
function summarizeCalendar(payload, limit = 5) {
  const rows = pickCalendarRows(payload);
  if (!rows.length) return null;
  return rows.slice(0, limit).map(row => {
    if (!row || typeof row !== 'object') return null;
    const title = row.title || row.event || row.name || row.label || null;
    const date = row.date || row.time || row.datetime || row.at || row.scheduledAt || row.start || null;
    const importance = row.importance || row.impact || row.level || null;
    return title ? { title:String(title).slice(0, 120), date:shortDate(date), importance:importance ? String(importance) : null } : null;
  }).filter(Boolean);
}

export function createAiChat({ market, liveQuote, marketContext, fearGreedSentiment, fedMonitor, investmentCalendar, getCredential, setModel }) {
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
        marketContext(source),
        fearGreedSentiment({}),
        fedMonitor(),
        investmentCalendar()
      ]);
      const [quote, daily, fourHour, hourly, context, sentiment, fed, calendar] = settled.map(r => (r.status === 'fulfilled' ? r.value : null));
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
          '1h':timeframeProfile(hourly?.candles, 18)
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

  // 按档位取提示词；未知档位落回默认，防止提示词为空。
  function buildSystemPrompt(style) {
    return STYLE_PROMPTS[normalizeStyle(style)];
  }

  function buildMessages(snapshot, history, lang, thinking, style) {
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
    messages.push({
      role:'system',
      content:`以下是生成于 ${snapshot.generatedAt} 的实时市场快照（数据源 ${snapshot.source}，快照缓存 ${snapshot.cacheAgeMs || 0} 毫秒）。这是原始数据，字段名仅供你参考，不要出现在回答里：\n\n${JSON.stringify(snapshot)}`
    });
    if (deepMode) {
      messages.push({
        role:'system',
        content:'本次是「深度分析」模式：请更充分地权衡多空双方的理由，结论可以更谨慎、更保守，但表达方式仍严格遵循上面所选回答模式的要求。'
      });
    }
    // 只带最近 8 轮，且剔除内部上下文字段，避免上下文无限膨胀。
    // Keep only the latest turns so the context cannot grow without bound.
    const trimmed = (Array.isArray(history) ? history : [])
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-8)
      .map(({ role, content }) => ({ role, content:content.slice(0, 2_000) }));
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

  // 流式：把上游 SSE 增量原样转写给浏览器。Streaming: relay upstream SSE deltas.
  async function streamToClient({ credential, messages, res, signal, thinking }) {
    const result = await callQwen({ credential, messages, stream:true, signal, thinking });
    if (!result.ok) { sendSse(res, { error:friendlyError(result.error, result.status, credential) }); return { ok:false }; }
    res.writeHead(200, {
      'content-type':'text/event-stream; charset=utf-8',
      'cache-control':'no-store, no-transform',
      connection:'keep-alive',
      'x-accel-buffering':'no',
      'x-content-type-options':'nosniff'
    });
    const reader = result.response.body?.getReader();
    if (!reader) { sendSse(res, { error:'千问返回的响应无法流式读取，请关闭流式重试。' }); return { ok:false }; }
    // 连接建立后立刻告知前端「已连上模型」，避免用户盯着空白气泡不知道在发生什么。
    // Tell the client we're connected immediately, so the empty bubble doesn't look frozen.
    sendSse(res, { started:true, model:credential.model || DEFAULT_MODEL, deepMode:Boolean(result.deepMode) });
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
    const resolvedBaseUrl = credential.baseUrl || inferBaseUrl(credential.key);
    json(res, 200, {
      configured:Boolean(credential.key),
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
      if (!rateAllow(clientKey)) { json(res, 429, { error:'提问过于频繁，请稍等几秒再试。' }); return true; }
      const question = String(payload.question || '').trim().slice(0, 2_000);
      if (!question) { json(res, 400, { error:'请输入问题。' }); return true; }
      const history = Array.isArray(payload.history) ? payload.history.slice(-8) : [];
      const wantStream = payload.stream !== false;
      // 默认快速模式（关闭思考）；只有显式传 deep 才启用推理。
      // Fast mode (no reasoning) by default; deep mode only when explicitly requested.
      const thinking = payload.thinking === 'deep' ? 'deep' : 'fast';
      // 回答模式：白名单校验，非法值落回「通俗」。
      // Answer style: whitelisted, anything unknown falls back to plain.
      const style = normalizeStyle(payload.style);

      let snapshot;
      try { snapshot = await buildSnapshot(payload.source || 'okx'); }
      catch (error) { json(res, 503, { error:'市场快照获取失败，暂时无法分析。', detail:error.message }); return true; }

      const messages = buildMessages(snapshot, [...history, { role:'user', content:question }], payload.lang, thinking, style);
      // 思考型模型（qwen3.8 系列）会先产出大段推理再出结论，30 秒远远不够。
      // Thinking models emit a long reasoning trace first, so 30s is far too tight.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), QWEN_TIMEOUT_MS);
      req.on('close', () => controller.abort());
      try {
        if (wantStream) {
          const outcome = await streamToClient({ credential, messages, res, signal:controller.signal, thinking });
          if (!outcome.ok && !res.writableEnded) json(res, 502, { error:'千问响应失败', detail:outcome.error });
          return true;
        }
        const outcome = await complete({ credential, messages, signal:controller.signal, thinking });
        if (!outcome.ok) { json(res, 502, { error:friendlyError(outcome.error, outcome.status, credential) }); return true; }
        json(res, 200, { content:outcome.content, usage:outcome.usage, model:outcome.model, deepMode:outcome.deepMode, snapshot:{ generatedAt:snapshot.generatedAt, source:snapshot.source, price:snapshot.price } });
        return true;
      } catch (error) {
        const message = error.name === 'AbortError' ? `调用千问超时（${QWEN_TIMEOUT_MS / 1000} 秒），请稍后重试或改用「快速」模式。` : `调用千问失败：${error.message}`;
        if (!res.headersSent) json(res, 502, { error:message });
        return true;
      } finally { clearTimeout(timer); }
    }
    return false;
  }

  return { handle, buildSnapshot, QWEN_MODELS, getQuotaState };
}
