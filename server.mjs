import http from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { gzipSync, brotliCompressSync, constants as zlibConstants } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { Communicate } from 'edge-tts.js';
import { createAiChat, DEFAULT_MODEL as QWEN_DEFAULT_MODEL } from './ai-chat.mjs';
import { createAlertStore } from './alert-store.mjs';
import { evaluateAlertRule } from './shared/alert-rule-eval.mjs';
// Research tuning config + pure fusion-model training, now shared with the
// training worker thread so the two never drift. See shared/ for the rationale.
// 研究超参配置与纯融合模型训练，现与训练 Worker 线程共用，避免两处漂移。
import { RESEARCH_TUNING, RESEARCH_TUNING_ERROR, RESEARCH_TUNING_DEFAULTS, RESEARCH_TUNING_OVERRIDE } from './shared/research-tuning.mjs';
import { clamp, validCandle, percentChange, chopThreshold, sigmoid, logit, buildFundingFeatures, fundingFeaturesAt, FUNDING_FEATURE_COLUMNS, trainFusionModel } from './shared/ml-train.mjs';
import { trainFusionModelAsync } from './shared/train-pool.mjs';
// 币种注册表：所有交易所合约 ID 的唯一真源（shared/coins.mjs）。
// Coin registry: the single source of truth for every exchange instrument id.
import { BASE_COIN, COIN_KEYS, COINS, normalizeCoin, coinMeta, instrumentId, okxInstId } from './shared/coins.mjs';

// BTC 指标服务端：负责静态页面、公开数据源、SQLite 快照与实时 OKX 连接。
// BTC indicator backend: serves the UI, public data sources, SQLite snapshots, and the live OKX connection.

// 进程级兜底：任何漏网的 rejection / 异常只记录，不再导致整个行情服务崩溃（launchd 拉起前仍有窗口期）。
// Process-level safety net: a stray rejection or exception is logged, never crashes the whole service.
process.on('unhandledRejection', (reason) => console.error('[fatal] unhandledRejection:', reason));
process.on('uncaughtException', (error) => console.error('[fatal] uncaughtException:', error && error.stack || error));

/* ── 币种上下文 / Coin context ──────────────────────────────────────────────
 * 一次 HTTP 请求所针对的币种由 ?symbol= 决定，放进 AsyncLocalStorage 里向下传递。
 * 这样做的关键收益：server.mjs 里几十处读取行情/写库的函数**不必改签名**，
 * 只要在需要合约 ID 的地方问一句 currentCoin()，就能自动跟着当前请求走。
 * 没有 ALS 上下文时（启动、定时器、WebSocket、告警 Worker）一律回落到 BTC，
 * 所以「比特币模式」走的是与多币种改造之前完全相同的那条路径。
 *
 * The coin a request targets is resolved from ?symbol= and carried in an
 * AsyncLocalStorage.  Every downstream function can ask currentCoin() instead
 * of taking a new parameter, and anything running outside a request (startup,
 * timers, the WebSocket, the alert worker) still resolves to BTC.
 */
const coinScope = new AsyncLocalStorage();
const currentCoin = () => coinScope.getStore()?.coin || BASE_COIN;
// 便捷取值：当前币种在各交易所的合约 ID。
const okxSwapId = (coin = currentCoin()) => okxInstId(coin, 'swap');
const okxSpotId = (coin = currentCoin()) => okxInstId(coin, 'spot');
const instIdFor = (source, coin = currentCoin()) => instrumentId(source, coin);
// 短别名：塞进 URL 模板里不用再写引号，替换既有硬编码时更安全。
const binanceId = () => instIdFor('binance');
const gateId = () => instIdFor('gate');
const coinbaseId = () => instIdFor('coinbase');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
// Optional: a Finnhub key upgrades the calendar with consensus, actual and
// previous values.  The dashboard deliberately remains useful without one.
const PUBLIC = join(process.cwd(), 'public');
const DATA_DIR = join(process.cwd(), 'data');
mkdirSync(DATA_DIR, { recursive:true });
const API_CREDENTIALS_FILE = join(DATA_DIR, 'api-credentials.json');
let apiCredentialsNeedsMigration=false;
function apiCredentialKey() {
  const raw=process.env.API_CREDENTIAL_ENCRYPTION_KEY || process.env.ALERT_ENCRYPTION_KEY || '';
  const key=raw ? Buffer.from(raw,'base64') : null;
  if(!key || key.length!==32) throw Object.assign(new Error('API_CREDENTIAL_ENCRYPTION_KEY (32-byte base64) is required before saving API settings'),{statusCode:503});
  return key;
}
function sealApiCredentials(value) {
  const key=apiCredentialKey(), iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',key,iv);
  cipher.setAAD(Buffer.from('btc-indicator:api-credentials:v1'));
  const body=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
  return JSON.stringify({version:1,ciphertext:Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64')});
}
function openApiCredentials(text) {
  const parsed=JSON.parse(text), ciphertext=parsed?.ciphertext;
  // A former plaintext file remains readable only to migrate it immediately
  // on the next save; it is never written in plaintext again.
  if(!ciphertext) { apiCredentialsNeedsMigration=true; return parsed && typeof parsed==='object' ? parsed : {}; }
  const raw=Buffer.from(ciphertext,'base64'); if(raw.length<29) throw new Error('Encrypted API settings are malformed');
  const key=apiCredentialKey(), cipher=createDecipheriv('aes-256-gcm',key,raw.subarray(0,12));
  cipher.setAAD(Buffer.from('btc-indicator:api-credentials:v1')); cipher.setAuthTag(raw.subarray(12,28));
  return JSON.parse(Buffer.concat([cipher.update(raw.subarray(28)),cipher.final()]).toString('utf8'));
}
let apiCredentials={};
try { apiCredentials=openApiCredentials(readFileSync(API_CREDENTIALS_FILE,'utf8')); } catch(error) { console.warn(`API credentials unavailable: ${error.message}`); apiCredentials={}; }
// A key explicitly saved through API Center is the active local preference.
// Environment variables remain the deployment fallback when no local setting
// exists, so a restart cannot silently restore an older .env credential.
let FINNHUB_API_KEY = String(apiCredentials.finnhub || process.env.FINNHUB_API_KEY || '').trim();
let EIA_API_KEY = String(apiCredentials.eia || process.env.EIA_API_KEY || '').trim();
let COINGECKO_API_KEY = String(apiCredentials.coingecko || process.env.COINGECKO_API_KEY || '').trim();
// 千问凭据是一组配置（key + endpoint + 模型），整组加密存储，与单个 key 的 provider 分开处理。
// Qwen is a credential bundle (key + endpoint + model) stored as one encrypted object.
const QWEN_DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const QWEN_TOKEN_PLAN_BASE_URL = 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
// 千问两套体系：Token Plan 订阅 Key 以 sk-sp- 开头，必须走 token-plan 端点；
// 按量付费 Key（sk-/sk-ws-）走 dashscope。混用一律 401。
// Qwen has two isolated systems: Token Plan keys start with sk-sp- and require the
// token-plan endpoint; pay-as-you-go keys (sk-/sk-ws-) use dashscope. Mixing = 401.
function inferQwenBaseUrl(key) {
  return /^sk-sp-/i.test(String(key || '').trim()) ? QWEN_TOKEN_PLAN_BASE_URL : QWEN_DEFAULT_BASE_URL;
}
function qwenCredential() {
  const saved = apiCredentials.qwen && typeof apiCredentials.qwen === 'object' ? apiCredentials.qwen : {};
  const key = String(saved.key || process.env.DASHSCOPE_API_KEY || '').trim();
  const stored = String(saved.baseUrl || process.env.DASHSCOPE_BASE_URL || '').trim();
  // 已存的端点若跨体系（sk-sp- 配 dashscope，或按量 Key 配 token-plan），调用必然 401，
  // 没有任何保留价值 —— 运行时直接纠正，重新保存时会落到磁盘。
  // A stored endpoint from the wrong system can only ever 401, so correct it at runtime.
  let baseUrl = stored || inferQwenBaseUrl(key) || QWEN_DEFAULT_BASE_URL, autoCorrected = false;
  if (key && stored) {
    const isTokenPlanKey = /^sk-sp-/i.test(key);
    if (isTokenPlanKey !== stored.includes('token-plan')) { baseUrl = inferQwenBaseUrl(key); autoCorrected = true; }
  }
  return {
    key,
    baseUrl,
    autoCorrected,
    model:String(saved.model || process.env.DASHSCOPE_MODEL || QWEN_DEFAULT_MODEL).trim()
  };
}
function apiCredentialStatus() { return { finnhub:Boolean(FINNHUB_API_KEY), eia:Boolean(EIA_API_KEY), coingecko:Boolean(COINGECKO_API_KEY), custom:Boolean(apiCredentials.custom?.url), qwen:Boolean(qwenCredential().key) }; }
function apiCredentialVerification() { const saved=apiCredentials._verification || {}; return {finnhub:Boolean(saved.finnhub?.valid),eia:Boolean(saved.eia?.valid),coingecko:Boolean(saved.coingecko?.valid),qwen:Boolean(saved.qwen?.valid)}; }
function saveApiCredentialsFile() { writeFileSync(API_CREDENTIALS_FILE,sealApiCredentials(apiCredentials),{mode:0o600}); }
// Migrate legacy plaintext settings as soon as a configured encryption key is
// available.  If the key is absent we keep the service running, but refuse all
// subsequent writes rather than silently creating a weakly protected secret.
if(apiCredentialsNeedsMigration) { try { saveApiCredentialsFile(); apiCredentialsNeedsMigration=false; } catch(error) { console.warn(`API credentials migration deferred: ${error.message}`); } }
// 一次性迁移：早期版本把 qwen3.8-max 硬编码成了出厂默认值，用户几乎不会主动挑最贵的型号。
// 首次启动时挪到性价比档；用户之后自己挑的模型不会被覆盖（靠 _qwenModelMigrated 标记）。
// One-off migration: qwen3.8-max used to be the hard-coded factory default. Move it to the value
// tier once; a model the user picks afterwards is never overridden (guarded by the flag below).
if (apiCredentials.qwen && apiCredentials.qwen.model === 'qwen3.8-max' && !apiCredentials._qwenModelMigrated) {
  apiCredentials = { ...apiCredentials, qwen:{ ...apiCredentials.qwen, model:QWEN_DEFAULT_MODEL }, _qwenModelMigrated:true };
  try { saveApiCredentialsFile(); } catch(error) { console.warn(`Qwen model migration deferred: ${error.message}`); }
}
function validApiUrl(value) { try { const url=new URL(String(value||'').trim()); return url.protocol==='https:' && !url.username && !url.password && url.href.length<=2048 ? url.href : null; } catch { return null; } }
const API_PROVIDERS = ['finnhub','eia','coingecko','custom','qwen'];
function saveApiCredential(provider, key, url, model) {
  if (!API_PROVIDERS.includes(provider)) throw Object.assign(new Error('Unsupported API provider'),{statusCode:400});
  const value=String(key || '').trim();
  // 千问需要三件套：Key、端点、模型名。端点和模型都可留空走默认值。
  // Qwen needs a triple: key, endpoint and model name. Both extras fall back to defaults.
  if (provider === 'qwen') {
    if (!value || value.length > 512) throw Object.assign(new Error('千问 API Key 必填，且不能超过 512 个字符'),{statusCode:400});
    // 端点留空时按 Key 前缀自动匹配（sk-sp- → Token Plan，否则 → DashScope）。
    // When the endpoint is blank, auto-match it from the key prefix.
    const baseUrl=url ? validApiUrl(url) : inferQwenBaseUrl(value);
    if (url && !baseUrl) throw Object.assign(new Error('千问 API 地址必须是有效 HTTPS URL，且不能包含用户名或密码。'),{statusCode:400});
    const chosenModel=String(model || '').trim() || QWEN_DEFAULT_MODEL;
    if (chosenModel.length > 64) throw Object.assign(new Error('模型名称过长'),{statusCode:400});
    const verification={...(apiCredentials._verification||{})}; delete verification.qwen;
    apiCredentials={...apiCredentials,qwen:{key:value,baseUrl,model:chosenModel},_verification:verification}; saveApiCredentialsFile(); return;
  }
  if (provider==='custom') { const endpoint=validApiUrl(url); if(!endpoint) throw Object.assign(new Error('自定义 API 地址必须是有效 HTTPS URL，且不能包含用户名或密码。'),{statusCode:400}); if(value.length>512) throw Object.assign(new Error('API key must be at most 512 characters'),{statusCode:400}); apiCredentials={...apiCredentials,custom:{url:endpoint,key:value||null}}; saveApiCredentialsFile(); return; }
  if (!value || value.length > 512) throw Object.assign(new Error('API key is required and must be at most 512 characters'),{statusCode:400});
  const verification={...(apiCredentials._verification||{})}; delete verification[provider]; apiCredentials={...apiCredentials,[provider]:value,_verification:verification}; saveApiCredentialsFile();
  if (provider==='finnhub') { FINNHUB_API_KEY=value; cache.delete('investment-calendar'); }
  if (provider==='eia') EIA_API_KEY=value;
  if (provider==='coingecko') { COINGECKO_API_KEY=value; cache.delete('fed-market-signals'); }
}
// 切换千问模型：只重写模型名，Key 与端点原样保留，无需重新验证。
// Switch the Qwen model: only the model name is rewritten; key and endpoint stay untouched.
function setQwenModel(model) {
  const id=String(model || '').trim();
  if(!id) return { ok:false, error:'模型名不能为空。' };
  const current=apiCredentials.qwen && typeof apiCredentials.qwen === 'object' ? apiCredentials.qwen : {};
  if(!current.key) return { ok:false, error:'尚未配置千问 API Key，无法切换模型。' };
  const previous=apiCredentials;
  apiCredentials={...apiCredentials,qwen:{...current,model:id}};
  try { saveApiCredentialsFile(); }
  catch(error) { apiCredentials=previous; return { ok:false, error:`保存模型失败：${error.message}` }; }
  return { ok:true, model:id };
}
function deleteApiCredential(provider) {
  if (!API_PROVIDERS.includes(provider)) throw Object.assign(new Error('Unsupported API provider'),{statusCode:400});
  delete apiCredentials[provider]; if(apiCredentials._verification)delete apiCredentials._verification[provider]; saveApiCredentialsFile();
  if (provider==='finnhub') { FINNHUB_API_KEY=String(process.env.FINNHUB_API_KEY || '').trim(); cache.delete('investment-calendar'); }
  if (provider==='eia') EIA_API_KEY=String(process.env.EIA_API_KEY || '').trim();
  if (provider==='coingecko') { COINGECKO_API_KEY=String(process.env.COINGECKO_API_KEY || '').trim(); cache.delete('fed-market-signals'); }
}
async function verifyApiCredential(provider) {
  if (!['finnhub','eia','coingecko','qwen'].includes(provider)) throw Object.assign(new Error('该类型的 API 地址无法通用验证；请按其服务商文档确认响应格式。'),{statusCode:400});
  const credential = provider === 'qwen' ? qwenCredential() : null;
  const key = provider === 'qwen' ? credential.key : {finnhub:FINNHUB_API_KEY,eia:EIA_API_KEY,coingecko:COINGECKO_API_KEY}[provider];
  if(!key) throw Object.assign(new Error('请先保存 API Key。'),{statusCode:400});
  try {
    // 千问：用一次极小请求验证 Key + 端点 + 模型三者是否匹配。
    // Qwen: a minimal request validates key, endpoint and model in one shot.
    if(provider==='qwen') {
      const ctrl=new AbortController(), timer=setTimeout(()=>ctrl.abort(),30_000);
      let response;
      try {
        // max_tokens 给到 16：思考型模型给 1 会被拒绝，而验证只关心 HTTP 状态。
        // max_tokens 16: thinking models reject 1, and the check only inspects the HTTP status.
        response=await fetch(`${credential.baseUrl.replace(/\/+$/,'')}/chat/completions`,{method:'POST',signal:ctrl.signal,
          headers:{'content-type':'application/json',authorization:`Bearer ${credential.key}`},
          body:JSON.stringify({model:credential.model,messages:[{role:'user',content:'ping'}],max_tokens:16,stream:false})});
      } finally { clearTimeout(timer); }
      if(!response.ok) {
        const detail=await response.text().catch(()=>'');
        let parsed=null; try { parsed=JSON.parse(detail); } catch { /* 忽略非 JSON 错误体 / ignore non-JSON bodies */ }
        throw new Error(parsed?.error?.message || parsed?.message || detail.slice(0,200) || `HTTP ${response.status}`);
      }
    } else if(provider==='coingecko') {
      // /key is an account-usage endpoint and may be unavailable to free Demo
      // keys. /ping is documented for Demo authentication and is the correct
      // minimal credential check.
      const payload=await request(`https://api.coingecko.com/api/v3/ping?x_cg_demo_api_key=${encodeURIComponent(key)}`,8_000);
      if(!payload || typeof payload!=='object') throw new Error('CoinGecko 返回格式无效');
    } else if(provider==='finnhub') {
      // Economic Calendar is Premium. Verify a free-plan endpoint first so a
      // valid free registration is not incorrectly reported as a bad key.
      const quote=await request(`https://finnhub.io/api/v1/quote?symbol=AAPL&token=${encodeURIComponent(key)}`,8_000);
      if(!quote || typeof quote!=='object') throw new Error('Finnhub 返回格式无效');
      const day=new Date().toISOString().slice(0,10);
      try { const payload=await request(`https://finnhub.io/api/v1/calendar/economic?from=${day}&to=${day}&token=${encodeURIComponent(key)}`,8_000); if(payload?.error) throw new Error(String(payload.error)); }
      catch { apiCredentials._verification={...(apiCredentials._verification||{}),finnhub:{valid:true,limited:true,verifiedAt:Date.now()}}; saveApiCredentialsFile(); return {valid:true,limited:true,message:'Finnhub Key 已验证通过；但 Economic Calendar 是付费接口，免费套餐将继续使用内置公开宏观日历。'}; }
    } else {
      const payload=await request(`https://api.eia.gov/v2/petroleum/pri/spt/data/?api_key=${encodeURIComponent(key)}&length=1`,8_000);
      if(payload?.error) throw new Error(String(payload.error));
    }
    // 验证通过即把自动纠正后的端点落盘，下次启动不用再纠一次。
    // Persist an auto-corrected endpoint once verification proves it works.
    if (provider === 'qwen' && credential.autoCorrected) {
      apiCredentials={...apiCredentials,qwen:{...(apiCredentials.qwen||{}),key:credential.key,baseUrl:credential.baseUrl,model:credential.model}};
    }
    apiCredentials._verification={...(apiCredentials._verification||{}),[provider]:{valid:true,verifiedAt:Date.now()}}; saveApiCredentialsFile();
    return { valid:true, message:`${provider==='qwen'?`千问（${credential.model}）`:provider==='finnhub'?'Finnhub':provider==='eia'?'EIA':'CoinGecko'} 验证通过。`, ...(provider==='qwen'?{endpoint:credential.baseUrl,model:credential.model}:{}) };
  } catch(error) {
    // A failed check must revoke any earlier success immediately; otherwise an
    // expired or replaced key would continue to expose and authorize AI chat.
    if (apiCredentials._verification?.[provider]) {
      delete apiCredentials._verification[provider];
      saveApiCredentialsFile();
    }
    // 千问 401 最常见的真实原因不是 Key 错，而是 Key 与端点不配套。
    // The most common cause of a Qwen 401 is not a bad key but a key/endpoint mismatch.
    let detail;
    if (provider === 'qwen') {
      const isSp = /^sk-sp-/i.test(credential.key);
      const usingTokenPlan = credential.baseUrl.includes('token-plan');
      const mismatch = isSp !== usingTokenPlan;
      const expected = inferQwenBaseUrl(credential.key);
      if (mismatch) detail = `Key 与端点不配套：你填的 Key 是「${isSp ? 'Token Plan 订阅版（sk-sp-）' : '按量付费版（sk-）'}」，但端点用的是 ${credential.baseUrl}。请在下方端点选择「${isSp ? 'Token Plan 个人版' : '按量付费 DashScope'}」，或直接填 ${expected}`;
      else if (error.message==='HTTP 401') detail=`服务商拒绝认证（HTTP 401）：请检查 Key 是否正确、未过期、未被撤销。（当前端点 ${credential.baseUrl}）`;
      else if (error.message==='HTTP 403') detail=`服务商拒绝访问（HTTP 403）：该套餐可能不含模型 ${credential.model}，或来源受限。（当前端点 ${credential.baseUrl}）`;
      else detail=error.name==='AbortError'?'验证请求超时，请稍后重试。':`验证失败：${error.message}`;
      return { valid:false, message:detail, endpoint:credential.baseUrl, model:credential.model };
    }
    detail=error.message==='HTTP 401'?'服务商拒绝认证（HTTP 401）：请检查 Key 类型、权限或是否已撤销。':error.message==='HTTP 403'?'服务商拒绝访问（HTTP 403）：请检查套餐权限或来源限制。':error.name==='AbortError'?'验证请求超时，请稍后重试。':`验证失败：${error.message}`;
    return { valid:false, message:detail };
  }
}
const COINGECKO_USAGE_TTL = 5 * 60_000;
async function coinGeckoUsage() {
  if (!COINGECKO_API_KEY) return { available:false, reason:'未保存 CoinGecko API key' };
  const cacheKey='coingecko-usage', hit=cache.get(cacheKey), now=Date.now();
  if (hit && now-hit.time<COINGECKO_USAGE_TTL) return cacheResult(hit,now);
  try {
    const data=await request('https://api.coingecko.com/api/v3/key',8_000,{ 'x-cg-demo-api-key':COINGECKO_API_KEY });
    const monthlyLimit=Number(data.api_key_monthly_call_credit ?? data.monthly_call_credit);
    const used=Number(data.api_key_current_total_monthly_calls ?? data.current_total_monthly_calls);
    const remaining=Number(data.current_remaining_monthly_calls ?? (Number.isFinite(monthlyLimit)&&Number.isFinite(used) ? monthlyLimit-used : NaN));
    const usage={ available:true, plan:data.plan || 'Demo', monthlyLimit:Number.isFinite(monthlyLimit)?monthlyLimit:null, used:Number.isFinite(used)?used:null, remaining:Number.isFinite(remaining)?remaining:null,
      rateLimit:Number(data.api_key_rate_limit_request_per_minute ?? data.rate_limit_request_per_minute) || null, fetchedAt:now, refreshMs:COINGECKO_USAGE_TTL };
    remember(cacheKey,usage); return usage;
  } catch(error) {
    // Free Demo keys can authenticate successfully while the account-usage
    // endpoint remains unavailable.  Verify with the documented ping endpoint
    // and report usage as unavailable rather than falsely calling the key bad.
    if(error.message==='HTTP 401') try { await request(`https://api.coingecko.com/api/v3/ping?x_cg_demo_api_key=${encodeURIComponent(COINGECKO_API_KEY)}`,8_000); return { available:true, plan:'Demo', monthlyLimit:null, used:null, remaining:null, rateLimit:null, fetchedAt:now, refreshMs:COINGECKO_USAGE_TTL, usageUnavailable:true }; } catch {}
    return { available:false, reason:error.name==='AbortError'?'CoinGecko 用量查询超时':error.message };
  }
}
// 每币种一个库文件：BTC 继续用 market.sqlite —— 与多币种改造前完全同一个文件、
// 同一套 schema，一行数据都不迁移。其余币种落在 market-<COIN>.sqlite（按需创建）。
// 这样「比特币模式」的读写路径零变更，同时新币种不会污染已有的历史样本。
// One database file per coin: BTC keeps market.sqlite (byte-identical to the
// pre-multi-coin layout, no migration), other coins get market-<COIN>.sqlite.
const marketDatabase = new DatabaseSync(join(DATA_DIR, 'market.sqlite'));
const altDatabases = new Map();
const databaseFileOf = (coin) => (coin === BASE_COIN ? join(DATA_DIR, 'market.sqlite') : join(DATA_DIR, `market-${coin}.sqlite`));
function databaseFor(coin = currentCoin()) {
  const key = normalizeCoin(coin);
  if (key === BASE_COIN) return marketDatabase;
  let handle = altDatabases.get(key);
  if (!handle) {
    handle = new DatabaseSync(databaseFileOf(key));
    handle.exec(SCHEMA_SQL);
    applySchemaMigrations(handle);
    altDatabases.set(key, handle);
  }
  return handle;
}
/** 已打开的全部库（BTC + 已用过的其它币种），供清理/统计遍历。 */
function allDatabases() { return [marketDatabase, ...altDatabases.values()]; }
const alertStore = await createAlertStore();
if (!alertStore.enabled) console.warn(`Server-side alerts disabled: ${alertStore.reason}`);
const SCHEMA_SQL = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
  -- 184MB 的库 + 持续写入会把默认的 2MB 页缓存打爆，导致热查询每条都回盘 pread，
  -- 主线程在等盘（CPU 仅 3% 但 GET / 仍要 1-2s）。扩到 64MB 让热点索引/近期页常驻内存。
  PRAGMA cache_size = -64000;
  PRAGMA mmap_size = 0;
  CREATE TABLE IF NOT EXISTS quote_snapshots (
    id INTEGER PRIMARY KEY, source TEXT NOT NULL, observed_at INTEGER NOT NULL,
    last REAL NOT NULL, open24h REAL, change_pct REAL, high24 REAL, low24 REAL
  );
  CREATE INDEX IF NOT EXISTS quote_snapshots_source_time ON quote_snapshots(source, observed_at DESC);
  CREATE TABLE IF NOT EXISTS candles (
    source TEXT NOT NULL, interval TEXT NOT NULL, candle_time INTEGER NOT NULL,
    open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL, volume REAL NOT NULL,
    updated_at INTEGER NOT NULL, PRIMARY KEY(source, interval, candle_time)
  );
  CREATE TABLE IF NOT EXISTS market_snapshots (
    id INTEGER PRIMARY KEY, source TEXT NOT NULL, interval TEXT NOT NULL,
    observed_at INTEGER NOT NULL, candle_count INTEGER NOT NULL, last REAL NOT NULL, cached INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS market_snapshots_source_time ON market_snapshots(source, observed_at DESC);
  CREATE TABLE IF NOT EXISTS training_runs (
    id INTEGER PRIMARY KEY, observed_at INTEGER NOT NULL, source TEXT NOT NULL,
    intraday_count INTEGER NOT NULL, daily_count INTEGER NOT NULL, forced INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS derivative_snapshots (
    id INTEGER PRIMARY KEY, source TEXT NOT NULL, observed_at INTEGER NOT NULL,
    funding_rate REAL, oi REAL, book_imbalance_pct REAL, book_ratio REAL,
    taker_buy_ratio_pct REAL, taker_trade_count INTEGER, ofi_pct REAL
  );
  CREATE INDEX IF NOT EXISTS derivative_snapshots_source_time ON derivative_snapshots(source, observed_at DESC);
  CREATE TABLE IF NOT EXISTS sentiment_snapshots (
    id INTEGER PRIMARY KEY, observed_at INTEGER NOT NULL, value REAL NOT NULL,
    classification TEXT NOT NULL, source TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sentiment_snapshots_time ON sentiment_snapshots(observed_at DESC);
  CREATE TABLE IF NOT EXISTS macro_market_snapshots (
    id INTEGER PRIMARY KEY, observed_at INTEGER NOT NULL, metric_key TEXT NOT NULL,
    value REAL, change_pct REAL, available INTEGER NOT NULL, source TEXT NOT NULL, cadence TEXT
  );
  CREATE INDEX IF NOT EXISTS macro_market_snapshots_key_time ON macro_market_snapshots(metric_key, observed_at DESC);
  CREATE TABLE IF NOT EXISTS fed_calendar_snapshots (
    id INTEGER PRIMARY KEY, observed_at INTEGER NOT NULL, event_key TEXT NOT NULL,
    event_name TEXT NOT NULL, event_at INTEGER NOT NULL, source TEXT NOT NULL,
    is_fallback INTEGER NOT NULL DEFAULT 0
  );
  -- 宏观事件研究样本（阶段 2）。这里的每一行 = 一次已发布的宏观事件 + BTC 在该事件窗口内的
  -- 实际表现。它不是预测，而是多因子模型可以拿去做条件分层的「已实现事实」。
  -- 精度字段 date_precision 是硬约束：1h 窗口只在 exact / day 上可解释，day-estimated 只进 1d 窗口。
  -- Macro event-study rows (stage 2): one published release + what BTC actually did in its window.
  CREATE TABLE IF NOT EXISTS macro_event_outcomes (
    id INTEGER PRIMARY KEY, event_key TEXT NOT NULL, event_at INTEGER NOT NULL,
    period TEXT, actual REAL, previous REAL, surprise_proxy REAL, surprise_z REAL,
    unit TEXT NOT NULL, date_precision TEXT NOT NULL, source TEXT NOT NULL,
    before_1d REAL, after_1h REAL, after_4h REAL, after_1d REAL,
    after_1h_abs REAL, after_1d_abs REAL,
    realized_vol_1d REAL, baseline_vol_1d REAL, vol_ratio REAL,
    computed_at INTEGER NOT NULL, UNIQUE(event_key, event_at)
  );
  CREATE INDEX IF NOT EXISTS macro_event_outcomes_time ON macro_event_outcomes(event_at DESC);
  CREATE INDEX IF NOT EXISTS macro_event_outcomes_key_time ON macro_event_outcomes(event_key, event_at DESC);
  -- 永续合约资金费率历史（多因子候选）。每 8 小时结算一次，交易所公开，可回溯多年。
  -- 与宏观发布值的关键区别：每个值在 funding_at 那一刻就已公开，因此按 funding_at <= 桶时刻 对齐
  -- 不构成前视偏差，无需 date_precision 那类精度字段。
  -- Perpetual funding-rate history (multi-factor candidate): settled every eight hours and public
  -- years back. The decisive difference from a macro print is that each value is already known at
  -- the instant it is stamped, so aligning on funding_at <= bucket time leaks nothing forward.
  CREATE TABLE IF NOT EXISTS funding_rate_history (
    exchange TEXT NOT NULL, symbol TEXT NOT NULL, funding_at INTEGER NOT NULL,
    rate REAL NOT NULL, mark_price REAL, fetched_at INTEGER NOT NULL,
    PRIMARY KEY (exchange, symbol, funding_at)
  );
  CREATE INDEX IF NOT EXISTS funding_rate_history_time ON funding_rate_history(funding_at DESC);
  CREATE INDEX IF NOT EXISTS fed_calendar_snapshots_event_time ON fed_calendar_snapshots(event_key, observed_at DESC);
  CREATE TABLE IF NOT EXISTS btc_news_snapshots (
    id INTEGER PRIMARY KEY, observed_at INTEGER NOT NULL, published_at INTEGER,
    title TEXT NOT NULL, url TEXT, source TEXT, sentiment INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS btc_news_snapshots_title_time ON btc_news_snapshots(title, published_at);
  CREATE INDEX IF NOT EXISTS btc_news_snapshots_observed_time ON btc_news_snapshots(observed_at DESC);
  CREATE TABLE IF NOT EXISTS research_predictions (
    id INTEGER PRIMARY KEY, bucket_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
    horizon_key TEXT NOT NULL, candle_interval TEXT NOT NULL, target_at INTEGER NOT NULL,
    entry_price REAL NOT NULL, raw_probability REAL NOT NULL, calibrated_probability REAL NOT NULL,
    direction TEXT NOT NULL, regime TEXT NOT NULL, settled_at INTEGER, settled_price REAL,
    actual_return REAL, is_up INTEGER, brier REAL,
    UNIQUE(bucket_at, horizon_key)
  );
  CREATE INDEX IF NOT EXISTS research_predictions_target ON research_predictions(target_at, settled_at);
  CREATE INDEX IF NOT EXISTS research_predictions_horizon_settled ON research_predictions(horizon_key, settled_at DESC);
  CREATE TABLE IF NOT EXISTS research_training_runs (
    id INTEGER PRIMARY KEY, started_at INTEGER NOT NULL, completed_at INTEGER,
    status TEXT NOT NULL, model_name TEXT NOT NULL, metrics_json TEXT, samples_json TEXT, error TEXT
  );
  CREATE INDEX IF NOT EXISTS research_training_runs_time ON research_training_runs(started_at DESC);
  CREATE TABLE IF NOT EXISTS research_candidate_predictions (
    id INTEGER PRIMARY KEY, training_run_id INTEGER NOT NULL, created_at INTEGER NOT NULL,
    horizon_key TEXT NOT NULL, candle_interval TEXT NOT NULL, target_at INTEGER NOT NULL,
    entry_price REAL NOT NULL, probability REAL NOT NULL, direction TEXT NOT NULL,
    settled_at INTEGER, settled_price REAL, actual_return REAL, is_up INTEGER, brier REAL,
    UNIQUE(training_run_id, horizon_key),
    FOREIGN KEY(training_run_id) REFERENCES research_training_runs(id)
  );
  CREATE INDEX IF NOT EXISTS research_candidate_predictions_target ON research_candidate_predictions(target_at, settled_at);
  CREATE TABLE IF NOT EXISTS research_candidate_forecasts (
    id INTEGER PRIMARY KEY, training_run_id INTEGER NOT NULL, bucket_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
    horizon_key TEXT NOT NULL, candle_interval TEXT NOT NULL, target_at INTEGER NOT NULL,
    entry_price REAL NOT NULL, probability REAL NOT NULL, direction TEXT NOT NULL,
    settled_at INTEGER, settled_price REAL, actual_return REAL, is_up INTEGER, brier REAL,
    UNIQUE(training_run_id, bucket_at, horizon_key),
    FOREIGN KEY(training_run_id) REFERENCES research_training_runs(id)
  );
  CREATE INDEX IF NOT EXISTS research_candidate_forecasts_target ON research_candidate_forecasts(target_at, settled_at);
  -- Generic paired shadow ledger.  A is always the frozen live rule; B is
  -- recorded beside it and can never change what the page currently shows.
  CREATE TABLE IF NOT EXISTS ab_shadow_pairs (
    id INTEGER PRIMARY KEY, experiment_key TEXT NOT NULL, bucket_at INTEGER NOT NULL,
    source TEXT NOT NULL, candle_interval TEXT NOT NULL, horizon_key TEXT NOT NULL,
    target_at INTEGER NOT NULL, entry_price REAL NOT NULL, regime TEXT NOT NULL,
    a_probability REAL, a_direction TEXT NOT NULL, b_probability REAL,
    b_direction TEXT NOT NULL, metadata_json TEXT, created_at INTEGER NOT NULL,
    settled_at INTEGER, settled_price REAL, actual_return REAL, is_up INTEGER,
    UNIQUE(experiment_key, bucket_at, horizon_key)
  );
  CREATE INDEX IF NOT EXISTS ab_shadow_pairs_target ON ab_shadow_pairs(target_at, settled_at);
  CREATE INDEX IF NOT EXISTS ab_shadow_pairs_experiment ON ab_shadow_pairs(experiment_key, settled_at DESC);
  -- ↓ 清理/统计单列索引。必须放在所有建表之后：这些索引引用的表（candles、
  --   market_snapshots 等）在下面才创建，写在其前面会让**新建库**在半途中断，
  --   只剩第一张表（多币种首次建库时正是这样暴露出来的）。
  -- cleanStorage 与 storageStatus 只按时间列过滤，上面的 (source, observed_at)
  -- 复合索引服务不了单独的 observed_at 条件，缺这批索引会退化成全表扫描并在
  -- 主线程上阻塞整个服务（2026-09-20 实测 GET / 被 81 秒）。
  CREATE INDEX IF NOT EXISTS quote_snapshots_observed ON quote_snapshots(observed_at);
  CREATE INDEX IF NOT EXISTS candles_updated ON candles(updated_at);
  -- MAX(updated_at) 的覆盖索引：否则走主键索引逐行回表（okx/5s 25 万行），
  -- 兜底路径 storedMarketFallback 每次调用都要冻结主线程数秒（2026-09-20 采样实锤）。
  CREATE INDEX IF NOT EXISTS candles_source_interval_updated ON candles(source, interval, updated_at);
  CREATE INDEX IF NOT EXISTS market_snapshots_observed ON market_snapshots(observed_at);
  CREATE INDEX IF NOT EXISTS training_runs_observed ON training_runs(observed_at);
  CREATE INDEX IF NOT EXISTS derivative_snapshots_observed ON derivative_snapshots(observed_at);
  CREATE INDEX IF NOT EXISTS macro_market_snapshots_observed ON macro_market_snapshots(observed_at);
  CREATE INDEX IF NOT EXISTS fed_calendar_snapshots_observed ON fed_calendar_snapshots(observed_at);
  CREATE INDEX IF NOT EXISTS research_predictions_created ON research_predictions(created_at);
`;
// 建库即刷一次：BTC 库沿用原文件，其它币种首次打开时创建同构 schema。
marketDatabase.exec(SCHEMA_SQL);
// 为既有数据库补充日历回退标识，迁移可重复执行。
// Add the calendar fallback flag to existing databases; this migration is safe to rerun.
function applySchemaMigrations(db) {
try { db.exec('ALTER TABLE fed_calendar_snapshots ADD COLUMN is_fallback INTEGER NOT NULL DEFAULT 0'); }
catch (error) { if (!/duplicate column name/i.test(error.message)) throw error; }
try { db.exec('ALTER TABLE derivative_snapshots ADD COLUMN ofi_pct REAL'); }
catch (error) { if (!/duplicate column name/i.test(error.message)) throw error; }
// Three-class research outcomes.  Every forecast is judged as up / flat / down against
// a volatility-scaled threshold instead of a bare up-or-down coin flip; `theta` records
// the threshold actually used so a verdict can always be recomputed from stored numbers.
// 三分类研究结论：每条预测按波动缩放阈值判定偏多 / 震荡 / 偏空，并把当时使用的阈值一起存下来，保证任何结论都能从库里复算。
for (const [table, column, definition] of [
  ['research_predictions', 'theta', 'REAL'],
  ['research_predictions', 'flat_probability', 'REAL'],
  ['research_predictions', 'outcome_label', 'TEXT'],
  ['research_predictions', 'window_version', 'INTEGER'],
  ['research_candidate_forecasts', 'theta', 'REAL'],
  ['research_candidate_forecasts', 'flat_probability', 'REAL'],
  ['research_candidate_forecasts', 'outcome_label', 'TEXT'],
  ['research_candidate_forecasts', 'window_version', 'INTEGER'],
]) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`); }
  catch (error) { if (!/duplicate column name/i.test(error.message)) throw error; }
}
}
applySchemaMigrations(marketDatabase);

/* ── 按币种解析的语句句柄 / Coin-resolved statement handles ─────────────────
 * 下面几十条 prepared statement 是在模块加载期一次性编译的常量。改成多币种后，
 * 同一个 SQL 必须能落到不同库上，于是用一层惰性代理：常量本身不绑定任何库，
 * 每次真正调用 .run()/.get()/.all() 时才按「当前请求币种」解析到对应库，
 * 并按 (库, SQL) 缓存编译结果。调用点 `storeCandle.run(...)` 一个字都不用改。
 *
 * Statement constants below are compiled once at module load.  Under multi-coin
 * the same SQL must reach different files, so each constant becomes a lazy
 * proxy: it binds to the right database at call time (per currentCoin()) and
 * memoises the compiled StatementSync per (database, SQL).  Call sites unchanged.
 */
const statementCaches = new WeakMap();
function prepareOn(coin, sql) {
  const db = databaseFor(coin);
  let cache = statementCaches.get(db);
  if (!cache) statementCaches.set(db, cache = new Map());
  let compiled = cache.get(sql);
  if (!compiled) cache.set(sql, compiled = db.prepare(sql));
  return compiled;
}
function stmt(sql) {
  return new Proxy({}, {
    get(_target, property) {
      const compiled = prepareOn(currentCoin(), sql);
      const value = compiled[property];
      return typeof value === 'function' ? value.bind(compiled) : value;
    },
  });
}
// 全局 `database` 保留为代理，供 .exec 等一次性调用使用（同样按当前币种解析）。
const database = new Proxy({}, {
  get(_target, property) {
    const db = databaseFor(currentCoin());
    const value = db[property];
    return typeof value === 'function' ? value.bind(db) : value;
  },
});

const storeQuote = stmt('INSERT INTO quote_snapshots (source, observed_at, last, open24h, change_pct, high24, low24) VALUES (?, ?, ?, ?, ?, ?, ?)');
const storeCandle = stmt('INSERT OR IGNORE INTO candles (source, interval, candle_time, open, high, low, close, volume, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
const updateCandle = stmt('UPDATE candles SET open=?, high=?, low=?, close=?, volume=?, updated_at=? WHERE source=? AND interval=? AND candle_time=?');
// OKX does not publish sub-minute candles for this perpetual contract.  These
// rows are built strictly from the public OKX trade stream and remain local.
const upsertSyntheticOkxCandle = stmt(`INSERT INTO candles
  (source, interval, candle_time, open, high, low, close, volume, updated_at)
  VALUES ('okx', ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(source, interval, candle_time) DO UPDATE SET
    high=MAX(candles.high, excluded.high), low=MIN(candles.low, excluded.low),
    close=excluded.close, volume=candles.volume + excluded.volume,
    updated_at=excluded.updated_at`);
const storeMarketSnapshot = stmt('INSERT INTO market_snapshots (source, interval, observed_at, candle_count, last, cached) VALUES (?, ?, ?, ?, ?, ?)');
const storeTrainingRun = stmt('INSERT INTO training_runs (observed_at, source, intraday_count, daily_count, forced) VALUES (?, ?, ?, ?, ?)');
const storeDerivativeSnapshot = stmt('INSERT INTO derivative_snapshots (source, observed_at, funding_rate, oi, book_imbalance_pct, book_ratio, taker_buy_ratio_pct, taker_trade_count, ofi_pct) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
const storeSentimentSnapshot = stmt('INSERT INTO sentiment_snapshots (observed_at, value, classification, source) VALUES (?, ?, ?, ?)');
const storeMacroMarketSnapshot = stmt('INSERT INTO macro_market_snapshots (observed_at, metric_key, value, change_pct, available, source, cadence) VALUES (?, ?, ?, ?, ?, ?, ?)');
const storeFedCalendarSnapshot = stmt('INSERT INTO fed_calendar_snapshots (observed_at, event_key, event_name, event_at, source, is_fallback) VALUES (?, ?, ?, ?, ?, ?)');
const storeNewsSnapshot = stmt('INSERT OR IGNORE INTO btc_news_snapshots (observed_at, published_at, title, url, source, sentiment) VALUES (?, ?, ?, ?, ?, ?)');
const priorOiSnapshot = stmt('SELECT observed_at, oi FROM derivative_snapshots WHERE source=? AND observed_at<=? AND oi IS NOT NULL ORDER BY observed_at DESC LIMIT 1');
const priorFundingSnapshot = stmt('SELECT observed_at, funding_rate FROM derivative_snapshots WHERE source=? AND observed_at<=? AND funding_rate IS NOT NULL ORDER BY observed_at DESC LIMIT 1');
const priorQuoteSnapshot = stmt('SELECT observed_at, last FROM quote_snapshots WHERE source=? AND observed_at<=? AND last IS NOT NULL ORDER BY observed_at DESC LIMIT 1');
const latestQuoteForSource = stmt('SELECT observed_at, last, open24h, change_pct, high24, low24 FROM quote_snapshots WHERE source=? ORDER BY observed_at DESC LIMIT 1');
const latestCandleUpdateForSource = stmt('SELECT MAX(updated_at) AS updated_at FROM candles WHERE source=? AND interval=?');
const latestSentimentSnapshot = stmt('SELECT observed_at, value, classification, source FROM sentiment_snapshots ORDER BY observed_at DESC LIMIT 1');
const latestFedCalendarSnapshots = stmt(`SELECT snapshot.observed_at, snapshot.event_key, snapshot.event_name, snapshot.event_at, snapshot.source, snapshot.is_fallback
  FROM fed_calendar_snapshots AS snapshot
  INNER JOIN (SELECT event_key, MAX(observed_at) AS observed_at FROM fed_calendar_snapshots GROUP BY event_key) AS latest
    ON latest.event_key=snapshot.event_key AND latest.observed_at=snapshot.observed_at
  ORDER BY snapshot.event_at ASC`);
const storeResearchPrediction = stmt('INSERT OR IGNORE INTO research_predictions (bucket_at, created_at, horizon_key, candle_interval, target_at, entry_price, raw_probability, calibrated_probability, flat_probability, direction, regime, theta, window_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
// A horizon re-rates until its bucket settles: the newest model output must replace the
// row the page will later be graded on, instead of being silently dropped by IGNORE.
// 同一周期在结算前会反复重估：最新模型输出必须覆盖将要被评分的那一行，而不是被 IGNORE 静默丢弃。
// window_version 2 marks rows graded on the corrected window: entry is the close of the anchor
// bar and settlement is the close of the bar that closes exactly one horizon later.  Rows without
// it were settled against whichever bar happened to be available when a page was opened, so their
// realised window length varied.  They stay in the table but never enter the authoritative
// three-class numbers.
// window_version 2 表示该行采用修正后的窗口：入场取锚定 K 线的收盘，结算取恰好一个持有期之后
// 收盘的那根。没有此标记的行，结算用的是「打开页面时恰好可用的那根 K 线」，实际持有窗口长度
// 随访问时机变化；它们保留在表内，但不计入权威的三分类口径。
const updateResearchPrediction = stmt('UPDATE research_predictions SET created_at=?, target_at=?, entry_price=?, raw_probability=?, calibrated_probability=?, flat_probability=?, direction=?, regime=?, theta=?, window_version=? WHERE bucket_at=? AND horizon_key=? AND settled_at IS NULL');
const pendingResearchPredictions = stmt('SELECT id, horizon_key, candle_interval, target_at, entry_price, theta FROM research_predictions WHERE settled_at IS NULL AND target_at<=? ORDER BY target_at ASC');
const settleResearchPrediction = stmt('UPDATE research_predictions SET settled_at=?, settled_price=?, actual_return=?, is_up=?, outcome_label=?, brier=? WHERE id=?');
const storeResearchTrainingRun = stmt('INSERT INTO research_training_runs (started_at, status, model_name) VALUES (?, ?, ?)');
const completeResearchTrainingRun = stmt('UPDATE research_training_runs SET completed_at=?, status=?, metrics_json=?, samples_json=?, error=? WHERE id=?');
const storeCandidatePrediction = stmt('INSERT OR IGNORE INTO research_candidate_predictions (training_run_id, created_at, horizon_key, candle_interval, target_at, entry_price, probability, direction) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
const pendingCandidatePredictions = stmt('SELECT id, training_run_id, candle_interval, target_at, entry_price, probability FROM research_candidate_predictions WHERE settled_at IS NULL AND target_at<=? ORDER BY target_at ASC');
const settleCandidatePrediction = stmt('UPDATE research_candidate_predictions SET settled_at=?, settled_price=?, actual_return=?, is_up=?, brier=? WHERE id=?');
const storeCandidateForecast = stmt('INSERT OR IGNORE INTO research_candidate_forecasts (training_run_id, bucket_at, created_at, horizon_key, candle_interval, target_at, entry_price, probability, flat_probability, direction, theta, window_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
const pendingCandidateForecasts = stmt('SELECT id, candle_interval, target_at, entry_price, probability, theta, flat_probability FROM research_candidate_forecasts WHERE settled_at IS NULL AND target_at<=? ORDER BY target_at ASC');
const settleCandidateForecast = stmt('UPDATE research_candidate_forecasts SET settled_at=?, settled_price=?, actual_return=?, is_up=?, outcome_label=?, brier=? WHERE id=?');
const pendingAbShadowPairs = stmt('SELECT id, candle_interval, target_at, entry_price FROM ab_shadow_pairs WHERE settled_at IS NULL AND target_at<=? ORDER BY target_at ASC');
const settleAbShadowPair = stmt('UPDATE ab_shadow_pairs SET settled_at=?, settled_price=?, actual_return=?, is_up=? WHERE id=?');
let lastStorageCleanup = 0;
let researchTrainingInProgress = false;
const lastStoredQuote = new Map();
const lastStoredDerivative = new Map();
function safelyStore(work) { try { work(); } catch (error) { console.error('SQLite storage error:', error.message); } }
// 清理必须对**每个已打开的库**各跑一遍：币种各自一个文件，只清 BTC 库会让
// 其它币种的快照无限增长。这里绕开 stmt() 的币种解析，显式按库执行。
// Cleanup has to run once per open database: with one file per coin, cleaning
// only the BTC file would let the others grow without bound.
function cleanStorageOn(db, now) {
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  run('DELETE FROM quote_snapshots WHERE observed_at < ?', now - 7 * 86_400_000);
  run('DELETE FROM market_snapshots WHERE observed_at < ?', now - 30 * 86_400_000);
  run('DELETE FROM candles WHERE updated_at < ?', now - 90 * 86_400_000);
  run('DELETE FROM training_runs WHERE observed_at < ?', now - 180 * 86_400_000);
  run('DELETE FROM derivative_snapshots WHERE observed_at < ?', now - 14 * 86_400_000);
  run('DELETE FROM sentiment_snapshots WHERE observed_at < ?', now - 365 * 86_400_000);
  run('DELETE FROM macro_market_snapshots WHERE observed_at < ?', now - 180 * 86_400_000);
  run('DELETE FROM fed_calendar_snapshots WHERE observed_at < ?', now - 180 * 86_400_000);
  run('DELETE FROM btc_news_snapshots WHERE observed_at < ?', now - 30 * 86_400_000);
  run('DELETE FROM research_predictions WHERE created_at < ?', now - 180 * 86_400_000);
  db.exec('PRAGMA wal_checkpoint(PASSIVE)');
}
function cleanStorage(now) {
  if (now - lastStorageCleanup < 3_600_000) return;
  lastStorageCleanup = now;
  for (const db of allDatabases()) {
    try { cleanStorageOn(db, now); }
    catch (error) { console.error('SQLite storage cleanup error:', error.message); }
  }
}
const persistKey = (source) => `${currentCoin()}:${source}`;
function persistQuote(source, ticker, observedAt) {
  const key = persistKey(source);
  if (observedAt - (lastStoredQuote.get(key) || 0) < 5_000) return;
  lastStoredQuote.set(key, observedAt);
  safelyStore(() => { storeQuote.run(source, observedAt, ticker.last, ticker.open24h, ticker.changePct, ticker.high24, ticker.low24); cleanStorage(observedAt); });
}
const lastPersistMarket = new Map();
function persistMarket(result, interval) {
  // 蜡烛每 60s 才重写一次：行情窗口只在最新几根变化，逐次全量写盘既浪费又占主线程。
  // 兜底/历史数据最多滞后 60s，对展示与回放无影响。
  const key = `${persistKey(result.source)}:${interval}`, now = result.fetchedAt;
  if (now - (lastPersistMarket.get(key) || 0) < 60_000) return;
  lastPersistMarket.set(key, now);
  safelyStore(() => {
    const t = result.fetchedAt;
    storeMarketSnapshot.run(result.source, interval, t, result.candles.length, result.ticker.last, 0);
    result.candles.forEach(candle => storeCandle.run(result.source, interval, candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume, t));
    result.candles.slice(-2).forEach(candle => updateCandle.run(candle.open, candle.high, candle.low, candle.close, candle.volume, t, result.source, interval, candle.time));
    persistQuote(result.source, result.ticker, t);
    cleanStorage(t);
  });
}
function persistTrainingRun(value, forced) {
  safelyStore(() => storeTrainingRun.run(value.fetchedAt, value.source, value.intraday.length, value.daily.length, forced ? 1 : 0));
}
function persistDerivativeSnapshot(source, values, observedAt = Date.now()) {
  const key = persistKey(source);
  if (observedAt - (lastStoredDerivative.get(key) || 0) < 10_000) return;
  lastStoredDerivative.set(key, observedAt);
  const numberOrNull = value => Number.isFinite(value) ? value : null;
  safelyStore(() => {
    storeDerivativeSnapshot.run(source, observedAt, numberOrNull(values.fundingRate), numberOrNull(values.oi), numberOrNull(values.bookImbalancePct), numberOrNull(values.bookRatio), numberOrNull(values.takerBuyRatioPct), Number.isFinite(values.takerTradeCount) ? values.takerTradeCount : null, numberOrNull(values.ofiPct));
    cleanStorage(observedAt);
  });
}
function persistSentimentSnapshot(value, observedAt = Date.now()) {
  safelyStore(() => { storeSentimentSnapshot.run(observedAt, value.value, value.classification || '', 'Alternative.me'); cleanStorage(observedAt); });
}
function persistMacroMarketSnapshots(rows, observedAt = Date.now()) {
  safelyStore(() => {
    for (const row of rows) storeMacroMarketSnapshot.run(observedAt, row.key, Number.isFinite(row.value) ? row.value : null, Number.isFinite(row.changePct) ? row.changePct : null, row.available ? 1 : 0, row.source || '—', row.cadence || null);
    cleanStorage(observedAt);
  });
}
function persistFedCalendarSnapshots(events, observedAt = Date.now()) {
  safelyStore(() => {
    for (const event of events) storeFedCalendarSnapshot.run(observedAt, event.key, event.name, event.at, event.source, event.fallback ? 1 : 0);
    cleanStorage(observedAt);
  });
}
function persistNewsSnapshots(items, observedAt = Date.now()) {
  safelyStore(() => {
    for (const item of items) storeNewsSnapshot.run(observedAt, Number.isFinite(item.publishedAt) ? item.publishedAt : null, item.title, item.url || null, item.source || 'Google News', item.sentiment);
    cleanStorage(observedAt);
  });
}
function storedCandles(source, interval, limit) {
  const rows = stmt('SELECT candle_time AS time, open, high, low, close, volume FROM candles WHERE source=? AND interval=? ORDER BY candle_time DESC LIMIT ?').all(source, interval, limit);
  return rows.reverse().map(row => ({ time:+row.time, open:+row.open, high:+row.high, low:+row.low, close:+row.close, volume:+row.volume })).filter(validCandle);
}
function storedMarketFallback(source, interval, limit, reason) {
  const candles = storedCandles(source, interval, limit);
  const quote = source === 'okx' ? freshOkxTicker() : null;
  const snapshot = latestQuoteForSource.get(source);
  const ticker = quote || (snapshot && {
    last:+snapshot.last, open24h:+snapshot.open24h, changePct:+snapshot.change_pct,
    high24:+snapshot.high24, low24:+snapshot.low24
  });
  const updatedAt = +latestCandleUpdateForSource.get(source, interval)?.updated_at || snapshot?.observed_at || 0;
  if (candles.length < 30 || !ticker || !Number.isFinite(ticker.last) || !updatedAt) return null;
  return {
    source, ticker, candles, fetchedAt:updatedAt, cached:true,
    cacheAgeMs:Math.max(0, Date.now() - updatedAt), stale:true,
    transport:quote ? 'websocket' : 'rest', fallbackReason:reason
  };
}
function persistHistory(source, interval, candles) {
  const now = Date.now();
  safelyStore(() => {
    candles.forEach(candle => {
      storeCandle.run(source, interval, candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume, now);
      updateCandle.run(candle.open, candle.high, candle.low, candle.close, candle.volume, now, source, interval, candle.time);
    });
    cleanStorage(now);
  });
}
let storageStatusCache={at:0,value:null};
function storageStatus() {
  // COUNT(*) 全表统计很重（market_snapshots 80 万行级别），自检面板每次刷新都会
  // 打 /api/status；加 30 秒缓存避免每次请求都在主线程上同步扫表。
  if (storageStatusCache.value && Date.now() - storageStatusCache.at < 30_000) return storageStatusCache.value;
  const count = table => stmt(`SELECT COUNT(*) AS total FROM ${table}`).get().total;
  storageStatusCache = { at:Date.now(), value:{ engine:'SQLite', quoteSnapshots:count('quote_snapshots'), candles:count('candles'), marketSnapshots:count('market_snapshots'), trainingRuns:count('training_runs'), derivativeSnapshots:count('derivative_snapshots'), sentimentSnapshots:count('sentiment_snapshots'), macroMarketSnapshots:count('macro_market_snapshots'), fedCalendarSnapshots:count('fed_calendar_snapshots'), newsSnapshots:count('btc_news_snapshots') } };
  return storageStatusCache.value;
}
// 分层缓存策略：报价由 OKX 流持续推送，图表/指标以较低频率刷新，慢速历史保留在 SQLite。
// Layered cache policy: quotes come from the OKX stream, chart/indicator data
// refreshes less often, and slow history is retained in SQLite.
const MARKET_TTL = 10_000;
const CONTEXT_TTL = 10_000;
const HISTORY_TTL = 300_000;
const SENTIMENT_TTL = 120_000;
const FED_CALENDAR_TTL = 600_000;
const FED_MARKET_SIGNALS_TTL = 600_000;
const NEWS_TTL = 900_000;
const QUOTE_TTL = 300;
const UPSTREAM_TIMEOUT = 1_200;
// A market request must always finish promptly.  Individual upstream calls have
// their own abort timer, but this protects callers from a stuck/coalesced task.
// OKX history is retrieved in 300-candle pages. Allow an ordinary paged
// history window to complete instead of treating it as a stale quote.
const MARKET_REQUEST_TIMEOUT = 8_000;
const MAX_MARKET_CANDLES = 1800;
const STALE_QUOTE_MAX_AGE = 60_000;
const cache = new Map();
const inFlight = new Map();
/* 与币种相关的缓存键必须加币种前缀，否则切换币种会命中上一个币种的缓存。
 * 宏观类缓存（美联储日历、投资日历、情绪指数）全网共用，故意不加前缀 ——
 * 它们与币种无关，加前缀只会把上游请求数翻四倍。
 * Coin-dependent cache keys must carry a coin prefix; a plain key would let a
 * coin switch hit the previous coin's cache.  Macro-level caches (Fed calendar,
 * investment calendar, sentiment) are deliberately shared: they are coin-agnostic
 * and prefixing them would quadruple upstream traffic for no benefit. */
const coinKey = (key) => `${currentCoin()}:${key}`;
function cacheResult(hit, now = Date.now()) {
  return { ...hit.value, cached:true, cacheAgeMs:Math.max(0, now - hit.time) };
}
function remember(key, value) {
  cache.set(key, { time:Date.now(), value });
  return value;
}
function coalesce(key, work, timeout = 0) {
  const running = inFlight.get(key);
  if (running) return running;
  const workPromise = Promise.resolve().then(work);
  let timer;
  const deadline = timeout > 0 ? new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`request deadline exceeded (${timeout}ms)`)), timeout);
  }) : null;
  const promise = (deadline ? Promise.race([workPromise, deadline]) : workPromise).finally(() => {
    if (timer) clearTimeout(timer);
    // Do not let an earlier timed-out request erase a newer in-flight task.
    if (inFlight.get(key) === promise) inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}
// 自动市场选择需与仪表盘默认值及 BTC-USDT 永续合约保持一致。
// Keep automatic market selection aligned with the dashboard default and the
// BTC-USDT perpetual contract used by the owner.
const sources = ['okx', 'coinbase', 'gate', 'binance'];
// 单一进程级公共连接让默认 OKX 永续报价保持在内存中；当流或某频道不可用时，REST 仍是安全回退。
// A single process-wide public connection keeps the default OKX perpetual
// quote hot in memory. REST remains the safe fallback if the stream or a
// particular channel is unavailable in a region.
const okxStream = {
  socket:null, status:'connecting', ticker:null, spotPrice:null,
  fundingRate:null, nextFundingRate:null, oi:null, oiUnit:'BTC',
  orderBook:null, takerTrades:[], cvdNotional:0, bookAt:0, tradeAt:0,
  premiumPct:null, premiumAt:0,
  lastMessageAt:0, tickerAt:0, contextAt:0, connectedAt:0,
  reconnects:0, lastError:null, retryMs:1_000, heartbeat:null, retryTimer:null
};
/* 多币种：BTC 继续复用上面这个 okxStream 本体（连接级字段 + BTC 行情字段都在上面），
 * 其余币种各挂一份纯行情状态。于是「比特币模式」读到的字段与多币种改造前逐字相同，
 * 不需要任何分支兼容；新增币种也不会让 BTC 的读写路径多走一层。
 * Multi-coin: BTC keeps using okxStream itself (it carries both connection state
 * and BTC market state); every other coin gets a market-only state object. */
const okxCoinStreams = new Map([[BASE_COIN, okxStream]]);
function createAltOkxStreamState(coin) {
  return {
    coin, ticker:null, spotPrice:null, fundingRate:null, nextFundingRate:null,
    oi:null, oiUnit:coin, orderBook:null, takerTrades:[], cvdNotional:0,
    bookAt:0, tradeAt:0, premiumPct:null, premiumAt:0, tickerAt:0, contextAt:0
  };
}
function streamFor(coin = currentCoin()) {
  const key = normalizeCoin(coin);
  if (key === BASE_COIN) return okxStream;
  let state = okxCoinStreams.get(key);
  if (!state) okxCoinStreams.set(key, state = createAltOkxStreamState(key));
  return state;
}
/** 全部已登记的币种流（BTC 在最前），供定时落库遍历。 */
function allOkxStreams() {
  return COIN_KEYS.map(key => ({ coin:key, state:streamFor(key) }));
}
// instId → 币种反查表：WebSocket 推送只有 instId，必须能反解出它属于哪个币。
const OKX_INSTID_TO_COIN = new Map();
for (const key of COIN_KEYS) {
  OKX_INSTID_TO_COIN.set(COINS[key].okx.swap, key);
  OKX_INSTID_TO_COIN.set(COINS[key].okx.spot, key);
}
const isOkxSpotInstId = instId => instId.endsWith('-USDT') && !instId.endsWith('-SWAP');
/** 一条公共连接订阅全部币种的六个频道（4 币 × 6 = 24，远低于 OKX 单连接上限）。 */
function okxSubscribeArgs() {
  const args = [];
  for (const key of COIN_KEYS) {
    const { swap, spot } = COINS[key].okx;
    args.push(
      { channel:'tickers', instId:swap }, { channel:'tickers', instId:spot },
      { channel:'funding-rate', instId:swap }, { channel:'open-interest', instType:'SWAP', instId:swap },
      { channel:'books5', instId:swap }, { channel:'trades', instId:swap }
    );
  }
  return args;
}
const syntheticOkxIntervals = new Map([['5s', 5_000], ['10s', 10_000], ['30s', 30_000]]);
const isSyntheticOkxInterval = interval => syntheticOkxIntervals.has(interval);
// 合成 K 线原本在每笔成交时同步写库：3 个周期 × 每秒数十笔成交 = 主线程每秒上百次
// 同步 UPSERT，直接拖垮 GET / 等所有请求（CPU 仅 3% 却处处慢，根因是等盘）。
// 改为内存聚合，每 1s 批量落库一次：落库次数从「每笔成交×周期」降到「每秒若干桶」。
const syntheticCandleBuffer = new Map();
function recordSyntheticOkxTrade(trade, coin = BASE_COIN, receivedAt = Date.now()) {
  const price = Number(trade.px), size = Number(trade.sz);
  // `ts` is the exchange event time.  It keeps bucket boundaries independent
  // of local WebSocket latency.
  const tradeAt = Number(trade.ts) || receivedAt;
  if (!Number.isFinite(price) || !Number.isFinite(size) || size <= 0 || !Number.isFinite(tradeAt)) return;
  for (const [interval, bucketMs] of syntheticOkxIntervals) {
    const bucketAt = Math.floor(tradeAt / bucketMs) * bucketMs;
    const key = `${coin}:${interval}:${bucketAt}`;
    const cur = syntheticCandleBuffer.get(key);
    if (cur) {
      if (price > cur.high) cur.high = price;
      if (price < cur.low) cur.low = price;
      cur.close = price; cur.volume += size;
      if (receivedAt > cur.updatedAt) cur.updatedAt = receivedAt;
    } else {
      syntheticCandleBuffer.set(key, { coin, interval, bucketAt, open:price, high:price, low:price, close:price, volume:size, updatedAt:receivedAt });
    }
  }
}
function flushSyntheticCandles() {
  if (!syntheticCandleBuffer.size) return;
  const pending = [...syntheticCandleBuffer.values()];
  syntheticCandleBuffer.clear();
  // 每个币种写自己的库：必须显式进入该币种的上下文，否则会串写到 BTC。
  // ⚠️ run() 的 store 必须是 { coin } 对象：currentCoin() 读 store.coin，
  // 传裸字符串会解析成 undefined → 静默回落 BTC（2026-09-21 踩过）。
  for (const coin of new Set(pending.map(c => c.coin))) {
    coinScope.run({ coin }, () => safelyStore(() => {
      for (const c of pending) if (c.coin === coin) upsertSyntheticOkxCandle.run(c.interval, c.bucketAt, c.open, c.high, c.low, c.close, c.volume, c.updatedAt);
    }));
  }
}
setInterval(flushSyntheticCandles, 1_000).unref?.();
function streamAge(at, now = Date.now()) { return at ? Math.max(0, now - at) : null; }
function freshOkxTicker(maxAge = 5_000, coin = currentCoin()) {
  const st = streamFor(coin);
  return st.ticker && streamAge(st.tickerAt) <= maxAge ? { ...st.ticker } : null;
}
function recentTakerFlow(now = Date.now(), coin = currentCoin()) {
  const st = streamFor(coin);
  const cutoff = now - 60_000;
  st.takerTrades = st.takerTrades.filter(trade => trade.time >= cutoff);
  const buys = st.takerTrades.filter(trade => trade.side === 'buy').reduce((sum, trade) => sum + trade.notional, 0);
  const sells = st.takerTrades.filter(trade => trade.side === 'sell').reduce((sum, trade) => sum + trade.notional, 0);
  const total = buys + sells;
  return total > 0 ? {
    buyNotional:buys, sellNotional:sells, buyRatioPct:buys / total * 100,
    imbalancePct:(buys - sells) / total * 100, tradeCount:st.takerTrades.length,
    cvd60Notional:buys-sells, cvdSessionNotional:st.cvdNotional,
    windowSeconds:60, updatedAt:st.tradeAt || null
  } : null;
  }
// Voice rules are evaluated and spoken by the browser only.  The local server
// may retain settings for the active page, but must never speak after a tab
// closes or after macOS restarts.
const VOICE_STATE_FILE = join(DATA_DIR, 'voice_state.json');
const VOICE_HEARTBEAT_TIMEOUT_MS = 60_000; // 保留会话状态读数；不触发服务端接力
const VOICE_RELAY_INTERVAL_MS = 2_000;
const SERVER_VOICE_RELAY_ENABLED = false;
const RELAY_VOICE_ALLOWLIST = ['zh-CN-XiaoxiaoNeural','zh-CN-XiaoyiNeural','zh-CN-YunxiNeural','zh-CN-YunyangNeural','zh-CN-shaanxi-XiaoniNeural','zh-CN-liaoning-XiaobeiNeural','zh-HK-HiuGaaiNeural','zh-TW-HsiaoChenNeural'];
let voiceState = { settings:null, personalEntries:[], rules:[], lastHeartbeatAt:0, lastSpokenAt:0, inFlightUntil:0 };
const loadVoiceState = () => {
  try {
    const raw = readFileSync(VOICE_STATE_FILE, 'utf8');
    const obj = JSON.parse(raw);
    if (obj && Array.isArray(obj.rules)) voiceState = { ...voiceState, ...obj, rules: obj.rules, personalEntries: Array.isArray(obj.personalEntries) ? obj.personalEntries : [], lastHeartbeatAt: Number(obj.lastHeartbeatAt)||0, lastSpokenAt: Number(obj.lastSpokenAt)||0 };
  } catch { /* first run */ }
};
loadVoiceState();
const persistVoiceState = () => { try { writeFileSync(VOICE_STATE_FILE, JSON.stringify(voiceState)); } catch (error) { console.warn('[voice] persist failed:', error.message); } };
// 触发判定：语义原样保留在共享模块（state 用途），见 shared/alert-rule-eval.mjs。
// Alert hit evaluation semantics preserved verbatim in the shared module (purpose 'state').
function ruleMatches(rule, prev, next) {
  return evaluateAlertRule(rule, prev, next, 'state');
}
function ruleCooldownMs(rule) {
  if (!rule.repeat) return 0;
  const min = Math.max(0, Number(rule.cooldownMinutes)||0) * 60_000;
  const poll = VOICE_RELAY_INTERVAL_MS;
  // 重复规则：冷却 < 评估间隔会被无限狂响，强制下限 = 评估间隔 + 5s
  return Math.max(min, VOICE_RELAY_INTERVAL_MS + 5_000);
}
const describeVoiceRule = (rule, last) => {
  const target = Number(rule.targetPrice);
  let message;
  if (rule.kind === 'price_above') message = last >= target ? `上涨目标已到达，BTC 当前价格 ${Math.round(last)} 美元` : `等待 BTC 上行至 ${Math.round(target)}，当前 ${Math.round(last)} 美元`;
  else if (rule.kind === 'price_below') message = last <= target ? `下跌目标已到达，BTC 当前价格 ${Math.round(last)} 美元` : `等待 BTC 下行至 ${Math.round(target)}，当前 ${Math.round(last)} 美元`;
  else if (rule.kind === 'price_reached') message = `BTC 当前价格 ${Math.round(last)} 美元，接近目标 ${Math.round(target)} 美元`;
  else message = `BTC 当前价格 ${Math.round(last)} 美元`;
  const comparisons = describePersonalEntries(last).replace(/^BTC 当前价格[^。]*。?/, '');
  return comparisons ? `${message}。${comparisons}` : message;
};
function describePersonalEntries(last) {
  const entries = (voiceState.personalEntries || []).filter(entry => Number.isFinite(Number(entry?.price)) && Number(entry.price) > 0);
  if (!entries.length) return `BTC 当前价格 ${Math.round(last)} 美元`;
  const fmt = value => Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const comparisons = entries.map(entry => {
    const entryPrice = Number(entry.price), delta = last - entryPrice;
    const isShort = entry.side === 'short', priceUp = delta >= 0, inProfit = isShort ? delta <= 0 : delta >= 0;
    const amount = fmt(Math.abs(delta)), percent = Math.abs(delta / entryPrice * 100).toFixed(2);
    const side = isShort ? '做空' : '做多', label = isShort ? '做空买入价' : '做多买入价';
    return `相对${label}${fmt(entryPrice)}，现价${priceUp ? '上涨' : '下跌'}${amount}，${priceUp ? '涨幅' : '跌幅'}${percent}%。差价${amount}美元。${side}${inProfit ? '盈利中' : '亏损中'}。`;
  });
  return `BTC 当前价格 ${fmt(last)} 美元。${comparisons.join('')}`;
}
async function playVoiceOnServer(text, voice) {
  const safeVoice = RELAY_VOICE_ALLOWLIST.includes(voice) ? voice : 'zh-CN-XiaoxiaoNeural';
  const audio = await edgeTtsAudio(text.slice(0, 240), safeVoice);
  const tmp = join(DATA_DIR, `voice-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.mp3`);
  writeFileSync(tmp, audio);
  await new Promise(resolve => execFile('afplay', [tmp], error => { if (error) console.warn('[voice] afplay error:', error.message); resolve(); }))
    .finally(() => { try { unlinkSync(tmp); } catch {} });
}
async function relayTick() {
  if (!SERVER_VOICE_RELAY_ENABLED) return;
  const now = Date.now();
  // 仍在心跳窗口内：前端接管，不抢权
  if (voiceState.lastHeartbeatAt && now - voiceState.lastHeartbeatAt < VOICE_HEARTBEAT_TIMEOUT_MS) return;
  if (!voiceState.settings || !voiceState.settings.enabled) return;
  const rules = voiceState.rules.filter(rule => rule.enabled !== false);
  const settings = voiceState.settings || {};
  const hasLivePriceBroadcast = Boolean(settings.livePriceEnabled) && (voiceState.personalEntries || []).some(entry => Number(entry?.price) > 0);
  if (!rules.length && !hasLivePriceBroadcast) return;
  if (now < voiceState.inFlightUntil) return; // 防止上次未播完又被启用
  // 选最新行情：优先 OKX WS 缓存，否则主动拉一次
  let last = null;
  const fresh = freshOkxTicker(VOICE_HEARTBEAT_TIMEOUT_MS);
  if (fresh) last = fresh.last;
  if (!Number.isFinite(last)) {
    try {
      const fetched = await fetch(`https://www.okx.com/api/v5/market/ticker?instId=${okxSpotId()}`, { signal: AbortSignal.timeout(4_000) });
      if (fetched.ok) {
        const data = await fetched.json();
        last = Number(data?.data?.[0]?.last);
      }
    } catch {}
  }
  if (!Number.isFinite(last)) return;
  // Disabled page-closed relay implementation retained behind the feature flag.
  const intervalMs = Math.max(15, Number(settings.interval) || 60) * 1_000;
  if (hasLivePriceBroadcast && now - Number(voiceState.lastSpokenAt || 0) >= intervalMs) {
    voiceState.lastSpokenAt = now;
    voiceState.inFlightUntil = now + 8_000;
    persistVoiceState();
    const voice = settings.voice || 'zh-CN-XiaoxiaoNeural';
    playVoiceOnServer(describePersonalEntries(last), voice).catch(error => console.warn('[voice] play failed:', error.message))
      .finally(() => { voiceState.inFlightUntil = 0; persistVoiceState(); });
    return;
  }
  for (const rule of rules) {
    if (!rule.repeat && rule.lastTriggeredAt) continue;
    const cd = ruleCooldownMs(rule);
    if (cd && rule.lastTriggeredAt && now - rule.lastTriggeredAt < cd) continue;
    const prev = Number(rule._lastPrice);
    if (ruleMatches(rule, prev, last)) {
      rule._lastPrice = last; // 立即更新，避免同轮多次触发
      rule.lastTriggeredAt = now;
      voiceState.lastSpokenAt = now;
      voiceState.inFlightUntil = now + 8_000;
      // 状态判定用一次后立即冷却是为了避免同价持续命中；保留 _lastPrice 让下一根价格继续检测（如果隔太久会重新检测）
      persistVoiceState();
      const text = describeVoiceRule(rule, last);
      const voice = voiceState.settings.voice || 'zh-CN-XiaoxiaoNeural';
      playVoiceOnServer(text, voice).catch(error => console.warn('[voice] play failed:', error.message))
        .finally(() => { voiceState.inFlightUntil = 0; persistVoiceState(); });
      // 同一 tick 内只处理一条规则
      break;
    }
    rule._lastPrice = last;
  }
  persistVoiceState();
}
if (SERVER_VOICE_RELAY_ENABLED)
  setInterval(relayTick, VOICE_RELAY_INTERVAL_MS).unref?.();
function okxDerivativeFeatures(now = Date.now(), coin = currentCoin()) {
  const st = streamFor(coin);
  const book = st.orderBook && streamAge(st.bookAt, now) <= 10_000 ? { ...st.orderBook, updatedAt:st.bookAt } : null;
  const takerFlow = recentTakerFlow(now, coin);
  const oiBaseline = priorOiSnapshot.get('okx', now - 300_000);
  const fundingBaseline = priorFundingSnapshot.get('okx', now - 3_600_000);
  const priceBaseline = priorQuoteSnapshot.get('okx', now - 300_000);
  const oiChangePct = Number.isFinite(st.oi) && Number.isFinite(+oiBaseline?.oi) && +oiBaseline.oi !== 0 ? (st.oi / +oiBaseline.oi - 1) * 100 : null;
  const fundingChangePct = Number.isFinite(st.fundingRate) && Number.isFinite(+fundingBaseline?.funding_rate) ? (st.fundingRate - +fundingBaseline.funding_rate) * 100 : null;
  const priceChangePct = Number.isFinite(st.ticker?.last) && Number.isFinite(+priceBaseline?.last) && +priceBaseline.last !== 0 ? (st.ticker.last / +priceBaseline.last - 1) * 100 : null;
  return {
    orderBook:book, takerFlow,
    premiumPct:streamAge(st.premiumAt, now) <= 60_000 ? st.premiumPct : null,
    liquidationHeat:null, topTraderRatio:null,
    oiChangePct, oiChangeWindowSeconds:oiBaseline ? Math.round((now - +oiBaseline.observed_at) / 1000) : null,
    fundingChangePct, fundingChangeWindowSeconds:fundingBaseline ? Math.round((now - +fundingBaseline.observed_at) / 1000) : null,
    priceChangePct, priceChangeWindowSeconds:priceBaseline ? Math.round((now - +priceBaseline.observed_at) / 1000) : null
  };
}
// 每个币种各存一份衍生品快照；必须进入对应币种上下文，否则会落到 BTC 库里。
function persistOkxDerivativeSnapshot() {
  for (const { coin, state } of allOkxStreams()) {
    // store 必须是 { coin } 对象（currentCoin() 读 store.coin），传裸字符串会回落 BTC。
    coinScope.run({ coin }, () => {
      const takerFlow = recentTakerFlow(Date.now(), coin), book = state.orderBook;
      persistDerivativeSnapshot('okx', {
        fundingRate:state.fundingRate, oi:state.oi,
        bookImbalancePct:book?.imbalancePct, bookRatio:book?.ratio,
        takerBuyRatioPct:takerFlow?.buyRatioPct, takerTradeCount:takerFlow?.tradeCount,
        ofiPct:book?.ofiPct
      });
    });
  }
}
function freshOkxContext(maxAge = 30_000, coin = currentCoin()) {
  const st = streamFor(coin);
  if (!freshOkxTicker(maxAge, coin) || !Number.isFinite(st.spotPrice) || !Number.isFinite(st.fundingRate) || !Number.isFinite(st.oi) || streamAge(st.contextAt) > maxAge) return null;
  const ticker = freshOkxTicker(maxAge, coin);
  return {
    source:'okx', fundingRate:st.fundingRate, nextFundingRate:st.nextFundingRate,
    oi:st.oi, oiUnit:st.oiUnit, basisPct:(ticker.last / st.spotPrice - 1) * 100,
    perpPrice:ticker.last, spotPrice:st.spotPrice, fetchedAt:st.contextAt,
    cached:true, cacheAgeMs:streamAge(st.contextAt), transport:'websocket', ...okxDerivativeFeatures(Date.now(), coin)
  };
}
function clearOkxTimers() {
  if (okxStream.heartbeat) clearInterval(okxStream.heartbeat);
  if (okxStream.retryTimer) clearTimeout(okxStream.retryTimer);
  okxStream.heartbeat = null; okxStream.retryTimer = null;
}
function scheduleOkxReconnect() {
  if (okxStream.retryTimer) return;
  const delay = okxStream.retryMs;
  okxStream.retryMs = Math.min(okxStream.retryMs * 2, 30_000);
  okxStream.retryTimer = setTimeout(() => { okxStream.retryTimer = null; openOkxStream(); }, delay);
  okxStream.retryTimer.unref?.();
}
function updateOkxStream(message) {
  const channel = message.arg?.channel, instId = message.arg?.instId;
  const rows = message.data; const row = rows?.[0]; if (!row) return;
  const now = Date.now(); okxStream.lastMessageAt = now;
  // 反解这条推送属于哪个币种；未登记的 instId 一律忽略（不会污染 BTC 的字段）。
  const coin = OKX_INSTID_TO_COIN.get(instId);
  if (!coin) return;
  const st = streamFor(coin);
  // 写库操作必须在该币种上下文里跑，否则快照会串进 BTC 库。
  // ⚠️ store 必须是 { coin } 对象（currentCoin() 读 store.coin）；传裸字符串
  // 会静默回落 BTC，把所有币的行情写进 BTC 库（2026-09-21 踩过）。
  const inCoin = (work) => coinScope.run({ coin }, work);
  const isSpot = isOkxSpotInstId(instId);
  if (channel === 'tickers' && !isSpot) {
    const ticker = { last:+row.last, open24h:+row.open24h, changePct:(+row.last / +row.open24h - 1) * 100, high24:+row.high24h, low24:+row.low24h };
    if (Object.values(ticker).every(Number.isFinite)) { st.ticker = ticker; st.tickerAt = now; inCoin(() => persistQuote('okx', ticker, now)); }
  } else if (channel === 'tickers' && isSpot) {
    if (Number.isFinite(+row.last)) { st.spotPrice = +row.last; st.contextAt = now; }
  } else if (channel === 'funding-rate') {
    if (Number.isFinite(+row.fundingRate)) { st.fundingRate = +row.fundingRate; st.nextFundingRate = Number.isFinite(+row.nextFundingRate) ? +row.nextFundingRate : +row.fundingRate; st.contextAt = now; }
  } else if (channel === 'open-interest') {
    const oi = Number.isFinite(+row.oiCcy) ? +row.oiCcy : +row.oi;
    if (Number.isFinite(oi)) { st.oi = oi; st.oiUnit = Number.isFinite(+row.oiCcy) ? coin : 'contracts'; st.contextAt = now; }
  } else if (channel === 'books5') {
    const depth = values => values.reduce((sum, level) => sum + Math.max(0, +level[0] || 0) * Math.max(0, +level[1] || 0), 0);
    const bidDepth = depth(row.bids || []), askDepth = depth(row.asks || []), total = bidDepth + askDepth;
    const previous=st.orderBook;
    // OFI approximates the signed change in displayed top-of-book liquidity.
    // It is persisted for future time-aligned training, but is not treated as
    // a historical model input until sufficient snapshots have accumulated.
    const previousTotal=(previous?.bidDepth || 0)+(previous?.askDepth || 0);
    const ofiPct=previousTotal>0 ? ((bidDepth-(previous?.bidDepth || 0))-(askDepth-(previous?.askDepth || 0))) / Math.max(total,previousTotal,1)*100 : null;
    const bestBid=+row.bids?.[0]?.[0],bestAsk=+row.asks?.[0]?.[0],mid=(bestBid+bestAsk)/2,spreadBps=Number.isFinite(mid)&&mid>0&&Number.isFinite(bestBid)&&Number.isFinite(bestAsk)?(bestAsk-bestBid)/mid*10_000:null;
    if (total > 0) { st.orderBook = { bidDepth, askDepth, ratio:askDepth ? bidDepth / askDepth : null, imbalancePct:(bidDepth - askDepth) / total * 100, ofiPct, spreadBps }; st.bookAt = now; }
  } else if (channel === 'trades') {
    for (const trade of rows) {
      const price = +trade.px, size = +trade.sz, side = trade.side === 'buy' ? 'buy' : trade.side === 'sell' ? 'sell' : null;
      if (side && Number.isFinite(price) && Number.isFinite(size) && size > 0) { const notional=price*size;st.takerTrades.push({ time:now, side, notional });st.cvdNotional+=side==='buy'?notional:-notional; recordSyntheticOkxTrade(trade, coin, now); }
    }
    st.tradeAt = now;
    recentTakerFlow(now, coin);
  }
}
function openOkxStream() {
  if (okxStream.socket && [WebSocket.CONNECTING, WebSocket.OPEN].includes(okxStream.socket.readyState)) return;
  clearOkxTimers(); okxStream.status = 'connecting';
  try {
    const socket = new WebSocket('wss://ws.okx.com:8443/ws/v5/public');
    okxStream.socket = socket;
    socket.addEventListener('open', () => {
      okxStream.status = 'connected'; okxStream.connectedAt = Date.now(); okxStream.retryMs = 1_000; okxStream.lastError = null;
      // 一条连接订阅全部币种（BTC 在前），切换币种时无需重连、无订阅延迟。
      socket.send(JSON.stringify({ op:'subscribe', args:okxSubscribeArgs() }));
      okxStream.heartbeat = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send('ping'); }, 20_000);
      okxStream.heartbeat.unref?.();
    });
    socket.addEventListener('message', event => {
      try { const message = JSON.parse(String(event.data)); if (message.event === 'error') okxStream.lastError = message.msg || 'subscription error'; else updateOkxStream(message); }
      catch { /* Ignore non-JSON heartbeat frames. */ }
    });
    socket.addEventListener('error', () => { okxStream.lastError = 'socket error'; });
    socket.addEventListener('close', () => { if (okxStream.socket !== socket) return; okxStream.socket = null; okxStream.status = 'reconnecting'; okxStream.reconnects += 1; clearOkxTimers(); scheduleOkxReconnect(); });
  } catch (error) { okxStream.status = 'reconnecting'; okxStream.lastError = error.message; scheduleOkxReconnect(); }
}
openOkxStream();
async function refreshOkxPremium(){
  // This public historical endpoint can take longer than the quote path; run it
  // out of band with its own deadline so it never delays the market response.
  // 溢价指数按币种分别取：写回对应币种的行情状态，不串到 BTC。
  for (const { coin, state } of allOkxStreams()) {
    try {
      const payload = await request(`https://www.okx.com/api/v5/public/premium-history?instId=${okxInstId(coin, 'swap')}`, 8_000);
      const row = payload.data?.[0], value = +row?.premium;
      if (payload.code === '0' && Number.isFinite(value)) { state.premiumPct = value * 100; state.premiumAt = Date.now(); }
    } catch { /* Feature remains unavailable; it never becomes a synthetic value. */ }
  }
}
// Defer the initial pass until module-level request timing state is initialized.
queueMicrotask(refreshOkxPremium);
const premiumRefreshTimer=setInterval(refreshOkxPremium,30_000);premiumRefreshTimer.unref?.();
const derivativePersistTimer = setInterval(persistOkxDerivativeSnapshot, 10_000);
derivativePersistTimer.unref?.();
// 每个 API 响应都携带请求范围的耗时，浏览器可区分“浏览器→本站”与“本站→交易所”的耗时。
// Each API response carries request-scoped timings. This lets the browser
// distinguish its route to this server from the server's route to an exchange.
const requestTiming = new AsyncLocalStorage();

function json(res, status, body) {
  const scope = requestTiming.getStore();
  const now = performance.now();
  const timing = scope ? {
    serverMs: Math.round(now - scope.started),
    upstreamMs: scope.upstreamStarted === null ? 0 : Math.round(scope.upstreamEnded - scope.upstreamStarted),
    upstreamCalls: scope.upstreamCalls
  } : undefined;
  const payload = timing && body && typeof body === 'object' && !Array.isArray(body) ? { ...body, timing } : body;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options':'nosniff', 'referrer-policy':'same-origin' });
  res.end(JSON.stringify(payload));
}
async function readJson(req) {
  let body=''; for await (const chunk of req) { body+=chunk; if(body.length>64_000) throw Object.assign(new Error('Request body too large'),{statusCode:413}); }
  try { return body ? JSON.parse(body) : {}; } catch { throw Object.assign(new Error('Invalid JSON body'),{statusCode:400}); }
}
function setSessionCookie(res, session) {
  const secure = process.env.ALERT_COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production';
  res.setHeader('set-cookie', `btc_alert_session=${encodeURIComponent(session.token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${30*86400}${secure?'; Secure':''}`);
}
function clearSessionCookie(res) { res.setHeader('set-cookie','btc_alert_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'); }
function secureCloudTransport(req, res) {
  const forwarded=String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const host=String(req.headers.host || '').replace(/:\d+$/,'');
  if(forwarded==='https'||(['127.0.0.1','localhost','::1'].includes(host)&&process.env.NODE_ENV!=='production')) return true;
  json(res,400,{error:'账户云端服务仅接受 HTTPS 连接。'}); return false;
}
async function requireAlertUser(req, res) {
  if(!secureCloudTransport(req,res)) return null;
  if(!alertStore.enabled){json(res,503,{error:'Cloud alerts unavailable',detail:alertStore.reason});return null;}
  const user=await alertStore.userFromRequest(req);if(!user){json(res,401,{error:'请先登录云端提醒账户。'});return null;}return user;
}
// API 接入中心的写操作默认要求登录。但千问是纯本地 AI 配置，与云端提醒账户无关：
// 云基础设施（Postgres/Redis）停摆时若仍强制登录，本机就再也无法配置 AI，功能直接废掉。
// 因此云端不可用时，只要传输是本机回环或 HTTPS，就放行千问的保存/清除/验证。
// Writes to API Center normally require a login. Qwen is a purely local AI setting,
// though: if the cloud stack is down, demanding a login would brick AI setup on this
// machine, so we allow it over loopback or HTTPS whenever the cloud store is unavailable.
async function requireApiCenterAccess(req, res, provider) {
  if (provider === 'qwen' && !alertStore.enabled) return secureCloudTransport(req, res);
  return Boolean(await requireAlertUser(req, res));
}
function intervalFor(source, interval) {
  const map = { '1m':'1m', '5m':'5m', '15m':'15m', '30m':'30m', '1h':'1H', '2h':'2H', '3h':'3H', '4h':'4H', '1d':'1D', '1w':'1W' };
  if (source === 'gate' || source === 'binance') return interval === '1h' ? '1h' : interval === '2h' ? '2h' : interval === '4h' ? '4h' : interval === '1d' ? '1d' : interval === '1w' ? '1w' : interval;
  return map[interval];
}
async function request(url, timeout = UPSTREAM_TIMEOUT, extraHeaders = {}) {
  const scope = requestTiming.getStore(), started = performance.now();
  if (scope && scope.upstreamStarted === null) scope.upstreamStarted = started;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json', ...extraHeaders } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
    if (scope) { scope.upstreamEnded = performance.now(); scope.upstreamCalls += 1; }
  }
}
async function requestText(url, timeout = 8_000) {
  const scope = requestTiming.getStore(), started = performance.now();
  if (scope && scope.upstreamStarted === null) scope.upstreamStarted = started;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8', 'user-agent':'BTC-Indicator-Research/1.4 (+local public-calendar monitor)' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(timer);
    if (scope) { scope.upstreamEnded = performance.now(); scope.upstreamCalls += 1; }
  }
}
async function fromGate(interval, limit) {
  const [ticker, rows] = await Promise.all([
    request(`https://api.gateio.ws/api/v4/futures/usdt/tickers?contract=${gateId()}`),
    request(`https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${gateId()}&interval=${intervalFor('gate', interval)}&limit=${limit}`)
  ]);
  const d = ticker[0]; if (!d) throw new Error('ticker payload empty');
  return { ticker: { last:+d.last, open24h:+d.last / (1 + (+d.change_percentage || 0) / 100), changePct:+d.change_percentage, high24:+d.high_24h, low24:+d.low_24h }, candles: rows.map(c => ({ time:+c.t*1000, volume:+c.v, close:+c.c, high:+c.h, low:+c.l, open:+c.o })).reverse() };
}
async function okxCandleRows(interval, limit) {
  if (interval !== '3h') {
    // OKX returns at most 300 rows per request.  A one-year daily view needs
    // 366 rows, so fetch backwards page-by-page instead of silently returning
    // a shorter chart while the UI still says “1Y”.
    // The live-candles endpoint only exposes roughly one day of 1-minute
    // history.  The history endpoint has the same current bars but continues
    // beyond that retention boundary, so range selection stays independent
    // from candle granularity.
    if (limit <= 300) return request(`https://www.okx.com/api/v5/market/history-candles?instId=${okxSwapId()}&bar=${intervalFor('okx', interval)}&limit=${limit}`);
    const pages = [], pageSize = 300;
    let after = '';
    for (let page = 0; page < Math.ceil(limit / pageSize); page++) {
      const suffix = after ? `&after=${after}` : '';
      const payload = await request(`https://www.okx.com/api/v5/market/history-candles?instId=${okxSwapId()}&bar=${intervalFor('okx', interval)}&limit=${pageSize}${suffix}`);
      if (payload.code !== '0' || !payload.data?.length) return payload;
      pages.push(...payload.data);
      after = payload.data.at(-1)?.[0];
      if (payload.data.length < pageSize) break;
    }
    const unique = [...new Map(pages.map(row => [row[0], row])).values()];
    return { code:'0', data:unique.slice(0, limit) };
  }
  // OKX 没有原生 3 小时 K 线：分页取得足量 1 小时历史 K 线后，按 UTC 3 小时边界聚合。
  // Fetch three native hours for every requested 3H bar so the rule-signal
  // history can fully warm up EMA200 rather than silently stopping at 300 bars.
  const pages = [];
  let after = '';
  const hourlyNeeded = limit * 3 + 3;
  const pageSize = 300;
  for (let page = 0; page < Math.ceil(hourlyNeeded / pageSize); page++) {
    const suffix = after ? `&after=${after}` : '';
    const payload = await request(`https://www.okx.com/api/v5/market/history-candles?instId=${okxSwapId()}&bar=1H&limit=${pageSize}${suffix}`);
    if (payload.code !== '0' || !payload.data?.length) throw new Error(payload.msg || 'OKX 1H history unavailable');
    pages.push(...payload.data);
    after = payload.data.at(-1)?.[0];
  }
  const hourly = [...new Map(pages.map(c => [c[0], c])).values()].map(c => ({ time:+c[0], open:+c[1], high:+c[2], low:+c[3], close:+c[4], volume:+c[5] })).sort((a,b) => a.time - b.time);
  const candles = aggregateCandles(hourly, 10_800_000).slice(-limit);
  return { code:'0', data:candles.map(c => [String(c.time),String(c.open),String(c.high),String(c.low),String(c.close),String(c.volume)]) };
}
async function fromOKX(interval, limit) {
  const streamedTicker = freshOkxTicker();
  if (isSyntheticOkxInterval(interval)) {
    const tickerPayload = streamedTicker ? null : await request(`https://www.okx.com/api/v5/market/ticker?instId=${okxSwapId()}`);
    const row = tickerPayload?.data?.[0];
    const ticker = streamedTicker || (row && tickerPayload.code === '0' ? {
      last:+row.last, open24h:+row.open24h, changePct:(+row.last / +row.open24h - 1) * 100,
      high24:+row.high24h, low24:+row.low24h
    } : null);
    if (!ticker || !Object.values(ticker).every(Number.isFinite)) throw new Error('OKX ticker unavailable');
    const candles = storedCandles('okx', interval, limit);
    if (candles.length < 30) {
      const seconds = syntheticOkxIntervals.get(interval) / 1000;
      throw new Error(`OKX ${seconds} 秒本地聚合正在积累：已有 ${candles.length}/30 根，请保持服务运行后再试`);
    }
    return { ticker, candles, synthetic:true, syntheticIntervalMs:syntheticOkxIntervals.get(interval) };
  }
  const [ticker, rows] = await Promise.all([
    // 仪表盘必须沿用 OKX 移动端永续合约的同一市场，不能混入 BTC-USDT 现货价格。
    // Keep the dashboard on the same market as the OKX mobile perpetual
    // contract, rather than mixing its price with BTC-USDT spot.
    streamedTicker ? Promise.resolve(null) : request(`https://www.okx.com/api/v5/market/ticker?instId=${okxSwapId()}`),
    okxCandleRows(interval, limit)
  ]);
  const d = ticker?.data?.[0]; if ((!streamedTicker && (!d || ticker.code !== '0')) || rows.code !== '0') throw new Error(ticker?.msg || rows.msg || 'invalid API payload');
  return { ticker:streamedTicker || { last:+d.last, open24h:+d.open24h, changePct:(+d.last / +d.open24h - 1) * 100, high24:+d.high24h, low24:+d.low24h }, candles: rows.data.map(c => ({ time:+c[0], open:+c[1], high:+c[2], low:+c[3], close:+c[4], volume:+c[5] })).reverse() };
}
const coinbaseIntervals = {
  '1m':['ONE_MINUTE', 60_000], '5m':['FIVE_MINUTE', 300_000],
  '15m':['FIFTEEN_MINUTE', 900_000], '30m':['THIRTY_MINUTE', 1_800_000],
  '1h':['ONE_HOUR', 3_600_000], '2h':['TWO_HOUR', 7_200_000], '3h':['ONE_HOUR', 10_800_000],
  '4h':['TWO_HOUR', 14_400_000], '1d':['ONE_DAY', 86_400_000],
  '1w':['ONE_DAY', 604_800_000]
};
function coinbaseCandleTime(value) {
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  if (/^\d+$/.test(String(value))) { const n = Number(value); return n < 1e12 ? n * 1000 : n; }
  return Date.parse(value);
}
function aggregateCandles(candles, bucketMs) {
  const buckets = new Map();
  for (const candle of candles) {
    const time = Math.floor(candle.time / bucketMs) * bucketMs;
    const prior = buckets.get(time);
    if (!prior) buckets.set(time, { ...candle, time });
    else {
      prior.high = Math.max(prior.high, candle.high);
      prior.low = Math.min(prior.low, candle.low);
      prior.close = candle.close;
      prior.volume += candle.volume;
    }
  }
  return [...buckets.values()].sort((a,b) => a.time - b.time);
}
async function coinbasePerpetualCandles(interval, limit) {
  const [granularity, targetMs] = coinbaseIntervals[interval] || [];
  if (!granularity) throw new Error(`unsupported Coinbase interval ${interval}`);
  const baseMs = granularity === 'ONE_MINUTE' ? 60_000 : granularity === 'FIVE_MINUTE' ? 300_000 : granularity === 'FIFTEEN_MINUTE' ? 900_000 : granularity === 'THIRTY_MINUTE' ? 1_800_000 : granularity === 'ONE_HOUR' ? 3_600_000 : granularity === 'TWO_HOUR' ? 7_200_000 : 86_400_000;
  const multiplier = Math.max(1, Math.ceil(targetMs / baseMs));
  const end = Date.now();
  const start = end - (limit * multiplier + 4) * baseMs;
  const params = new URLSearchParams({ granularity, start:new Date(start).toISOString(), end:new Date(end).toISOString() });
  const payload = await request(`https://api.international.coinbase.com/api/v1/instruments/${coinbaseId()}/candles?${params}`, 8_000);
  const rows = Array.isArray(payload) ? payload : payload.aggregations;
  if (!Array.isArray(rows)) throw new Error('invalid Coinbase candles payload');
  const candles = rows.map(c => ({
    time:coinbaseCandleTime(c.start), open:+c.open, high:+c.high,
    low:+c.low, close:+c.close, volume:+c.volume
  })).filter(validCandle).sort((a,b) => a.time - b.time);
  return (targetMs === baseMs ? candles : aggregateCandles(candles, targetMs)).slice(-limit);
}
async function fromCoinbase(interval, limit) {
  const end = Date.now(), start = end - 26 * 3_600_000;
  const hourlyParams = new URLSearchParams({ granularity:'ONE_HOUR', start:new Date(start).toISOString(), end:new Date(end).toISOString() });
  const [quotePayload, candles, hourlyPayload] = await Promise.all([
    request(`https://api.international.coinbase.com/api/v1/instruments/${coinbaseId()}/quote`, 8_000),
    coinbasePerpetualCandles(interval, limit),
    request(`https://api.international.coinbase.com/api/v1/instruments/${coinbaseId()}/candles?${hourlyParams}`, 8_000)
  ]);
  const quote = quotePayload.quote || quotePayload;
  const last = +(quote.trade_price || quote.mark_price || candles.at(-1)?.close);
  const hourlyRows = Array.isArray(hourlyPayload) ? hourlyPayload : hourlyPayload.aggregations;
  const hourly = (hourlyRows || []).map(c => ({ time:coinbaseCandleTime(c.start), open:+c.open, high:+c.high, low:+c.low, close:+c.close, volume:+c.volume })).filter(validCandle).sort((a,b) => a.time - b.time);
  const window24 = hourly.slice(-24), open24h = window24[0]?.open || candles[0]?.open || last;
  return {
    ticker: {
      last, open24h, changePct:(last / open24h - 1) * 100,
      high24:Math.max(...window24.map(c => c.high), last),
      low24:Math.min(...window24.map(c => c.low), last)
    },
    candles
  };
}
async function fromBinance(interval, limit) {
  const [ticker, rows] = await Promise.all([
    request(`https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${binanceId()}`),
    request(`https://fapi.binance.com/fapi/v1/klines?symbol=${binanceId()}&interval=${intervalFor('binance', interval)}&limit=${limit}`)
  ]);
  return { ticker: { last:+ticker.lastPrice, open24h:+ticker.openPrice, changePct:+ticker.priceChangePercent, high24:+ticker.highPrice, low24:+ticker.lowPrice }, candles: rows.map(c => ({ time:+c[0], open:+c[1], high:+c[2], low:+c[3], close:+c[4], volume:+c[5] })) };
}
const loaders = { gate: fromGate, okx: fromOKX, coinbase: fromCoinbase, binance: fromBinance };
async function liveQuote(source = 'okx') {
  const selected = loaders[source] ? source : 'okx', key = coinKey(`quote:${selected}`), hit = cache.get(key);
  // WS 报价的新鲜度窗口收紧到 1.5 秒：流一旦抖动就尽快回退 REST，
  // 而不是把最长 5 秒前的旧价继续当作「实时」返回给前端。
  // Tightened from the 5s default: once the stream stutters, fall back to REST
  // quickly instead of serving a quote that may already be seconds old.
  const streamed = selected === 'okx' ? freshOkxTicker(1_500) : null;
  const st = streamFor();
  if (streamed) return { source:selected, ticker:streamed, fetchedAt:st.tickerAt, cached:true, cacheAgeMs:streamAge(st.tickerAt), transport:'websocket', stale:false };
  if (hit && Date.now() - hit.time < QUOTE_TTL) return { ...cacheResult(hit), transport:hit.value.transport || 'rest', stale:false };
  const prior = [...cache.values()].map(entry => entry.value).reverse().find(value => value?.source === selected && value?.coin === currentCoin() && value?.ticker)?.ticker;
  try {
    const value = await coalesce(key, async () => {
      let ticker;
      if (selected === 'okx') {
        const payload = await request(`https://www.okx.com/api/v5/market/ticker?instId=${okxSwapId()}`), row = payload.data?.[0];
        if (payload.code !== '0' || !row) throw new Error(payload.msg || 'OKX quote unavailable');
        ticker = { last:+row.last, open24h:+row.open24h, changePct:(+row.last / +row.open24h - 1) * 100, high24:+row.high24h, low24:+row.low24h };
      } else if (selected === 'binance') {
        const row = await request(`https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${binanceId()}`);
        ticker = { last:+row.lastPrice, open24h:+row.openPrice, changePct:+row.priceChangePercent, high24:+row.highPrice, low24:+row.lowPrice };
      } else if (selected === 'gate') {
        const row = (await request(`https://api.gateio.ws/api/v4/futures/usdt/tickers?contract=${gateId()}`))[0];
        if (!row) throw new Error('Gate quote unavailable');
        ticker = { last:+row.last, open24h:+row.last / (1 + (+row.change_percentage || 0) / 100), changePct:+row.change_percentage, high24:+row.high_24h, low24:+row.low_24h };
      } else {
        const payload = await request(`https://api.international.coinbase.com/api/v1/instruments/${coinbaseId()}/quote`, 1_200), row = payload.quote || payload, last = +(row.trade_price || row.mark_price);
        if (!Number.isFinite(last)) throw new Error('Coinbase quote unavailable');
        ticker = { last, open24h:prior?.open24h || last, changePct:prior?.open24h ? (last / prior.open24h - 1) * 100 : 0, high24:Math.max(prior?.high24 || last,last), low24:Math.min(prior?.low24 || last,last) };
      }
      const fresh = { source:selected, coin:currentCoin(), ticker, fetchedAt:Date.now(), cached:false, cacheAgeMs:0, transport:'rest', stale:false };
      remember(key, fresh); persistQuote(selected, ticker, fresh.fetchedAt); return fresh;
    });
    return value;
  } catch (error) {
    if (hit && Date.now() - hit.time <= STALE_QUOTE_MAX_AGE) return { ...cacheResult(hit), transport:hit.value.transport || 'rest', stale:true, fallbackReason:error.name === 'AbortError' ? 'timeout' : error.message };
    throw error;
  }
}
async function marketContext(source = 'okx') {
  const selected = loaders[source] ? source : 'okx', key = coinKey(`market-context:${selected}`);
  const hit = cache.get(key);
  const streamed = selected === 'okx' ? freshOkxContext() : null;
  if (streamed) return streamed;
  if (hit && Date.now() - hit.time < CONTEXT_TTL) return { ...cacheResult(hit), transport:hit.value.transport || 'rest', stale:false };
  try { return await coalesce(key, async () => {
  let value;
  if (selected === 'okx') {
    const [funding, oi, perp, spot] = await Promise.all([
      request(`https://www.okx.com/api/v5/public/funding-rate?instId=${okxSwapId()}`),
      request(`https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=${okxSwapId()}`),
      request(`https://www.okx.com/api/v5/market/ticker?instId=${okxSwapId()}`),
      request(`https://www.okx.com/api/v5/market/ticker?instId=${okxSpotId()}`)
    ]);
    const f = funding.data?.[0], o = oi.data?.[0], p = perp.data?.[0], s = spot.data?.[0];
    if (!f || !o || !p || !s) throw new Error('invalid OKX context payload');
    value = { source:selected, fundingRate:+f.fundingRate, nextFundingRate:+f.nextFundingRate, oi:+o.oiCcy || +o.oi, oiUnit:o.oiCcy ? coinMeta().oiUnit : 'contracts', basisPct:(+p.last / +s.last - 1) * 100, perpPrice:+p.last, spotPrice:+s.last, fetchedAt:Date.now(), cached:false };
  } else if (selected === 'binance') {
    const [premium, oi, perp, spot] = await Promise.all([
      request(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${binanceId()}`),
      request(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${binanceId()}`),
      request(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${binanceId()}`),
      request(`https://api.binance.com/api/v3/ticker/price?symbol=${binanceId()}`)
    ]);
    value = { source:selected, fundingRate:+premium.lastFundingRate, nextFundingRate:+premium.lastFundingRate, oi:+oi.openInterest, oiUnit:coinMeta().oiUnit, basisPct:(+perp.price / +spot.price - 1) * 100, perpPrice:+perp.price, spotPrice:+spot.price, fetchedAt:Date.now(), cached:false };
  } else if (selected === 'coinbase') {
    const [quotePayload, spot] = await Promise.all([
      request(`https://api.international.coinbase.com/api/v1/instruments/${coinbaseId()}/quote`, 8_000),
      request(`https://api.exchange.coinbase.com/products/${normalizeCoin(currentCoin())}-USD/ticker`, 8_000)
    ]);
    const quote = quotePayload.quote || quotePayload, perpPrice=+(quote.trade_price || quote.mark_price), spotPrice=+spot.price;
    value = { source:selected, fundingRate:+quote.predicted_funding, nextFundingRate:+quote.predicted_funding, oi:null, oiUnit:'--', basisPct:(perpPrice / spotPrice - 1) * 100, perpPrice, spotPrice, fetchedAt:Date.now(), cached:false };
  } else {
    const [perpRows, spotRows] = await Promise.all([
      request(`https://api.gateio.ws/api/v4/futures/usdt/tickers?contract=${gateId()}`),
      request(`https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${gateId()}`)
    ]);
    const perp = perpRows[0], spot = spotRows[0]; if (!perp || !spot) throw new Error('invalid Gate context payload');
    const perpPrice=+perp.last, spotPrice=+spot.last;
    value = { source:selected, fundingRate:Number(perp.funding_rate), nextFundingRate:Number(perp.funding_rate), oi:Number(perp.total_size), oiUnit:'contracts', basisPct:(perpPrice / spotPrice - 1) * 100, perpPrice, spotPrice, fetchedAt:Date.now(), cached:false };
  }
  if (selected === 'okx') Object.assign(value, okxDerivativeFeatures());
  value.transport = 'rest'; value.cacheAgeMs = 0; value.stale = false;
  remember(key, value);
  return value;
  }); } catch (error) {
    if (hit && Date.now() - hit.time <= STALE_QUOTE_MAX_AGE) return { ...cacheResult(hit), transport:hit.value.transport || 'rest', stale:true, fallbackReason:error.name === 'AbortError' ? 'timeout' : error.message };
    throw error;
  }
}
function storedFearGreedSentiment(now = Date.now()) {
  const row = latestSentimentSnapshot.get();
  if (!row || !Number.isFinite(+row.value)) return null;
  return {
    value:+row.value, classification:String(row.classification || ''), observedAt:+row.observed_at,
    fetchedAt:now, cached:true, storageCached:true, stale:true, cacheAgeMs:Math.max(0, now - +row.observed_at),
    refreshMs:SENTIMENT_TTL, source:row.source || 'SQLite'
  };
}
async function fearGreedSentiment({ refresh = false } = {}) {
  const key = 'fear-greed-sentiment', hit = cache.get(key), now = Date.now();
  if (!refresh && hit && now - hit.time < SENTIMENT_TTL) return { ...cacheResult(hit, now), stale:false };
  const stored = !refresh && !hit ? storedFearGreedSentiment(now) : null;
  if (stored) return stored;
  try {
    return await coalesce(key, async () => {
      const payload = await request('https://api.alternative.me/fng/?limit=1&format=json', 8_000);
      const row = payload.data?.[0], value = Number(row?.value);
      if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error('invalid fear and greed payload');
      const result = {
        value, classification:String(row.value_classification || ''),
        observedAt:Number(row.timestamp) * 1000 || now,
        nextUpdateSeconds:Number(row.time_until_update) || null,
        fetchedAt:now, cached:false, cacheAgeMs:0, refreshMs:SENTIMENT_TTL
      };
      persistSentimentSnapshot(result, now);
      remember(key, result);
      return result;
    });
  } catch (error) {
    if (hit && now - hit.time <= 3_600_000) return { ...cacheResult(hit, now), stale:true, fallbackReason:error.name === 'AbortError' ? 'timeout' : error.message };
    if (stored) return { ...stored, fallbackReason:error.name === 'AbortError' ? 'timeout' : error.message };
    throw error;
  }
}
const monthIndex = { january:0,february:1,march:2,april:3,may:4,june:5,july:6,august:7,september:8,october:9,november:10,december:11,jan:0,feb:1,mar:2,apr:3,jun:5,jul:6,aug:7,sep:8,sept:8,oct:9,nov:10,dec:11 };
function plainText(html) { return String(html).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim(); }
function dateAtNoon(year, month, day) { return new Date(Date.UTC(year, month, day, 17, 0, 0)); }
// 「墙钟时间」→ UTC 毫秒。BLS / 美联储日历给的是美国东部时间（ET，含夏令时），
// 不能当成 UTC 直接存，否则会整体偏早 4 小时（CPI 8:30 ET 应是北京时间 20:30，而非 16:30）。
// Convert a wall-clock time in `timeZone` to its true UTC instant. BLS/Fed calendars publish in
// US Eastern Time; treating it as UTC would shift every release ~4h early.
function tzOffsetMs(timeZone, date) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour12:false, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit' }).formatToParts(date);
  const m = {}; for (const p of parts) m[p.type] = p.value;
  const asUTC = Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour % 24, +m.minute, +m.second);
  return asUTC - date.getTime();
}
function wallToUtc(year, month, day, hour, minute, timeZone = 'America/New_York') {
  const wallUtc = Date.UTC(year, month, day, hour, minute, 0);
  let t = wallUtc;
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone, hour12:false, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit' });
  // 迭代求出「在某个时区下墙钟显示为 wall 的 UTC 瞬间」。每轮：把该瞬间在目标时区里
  // 显示出的本地时间当作 UTC 还原成 shown，再用 wallUtc - shown 修正。两轮即可跨 DST 收敛。
  // Iterate to the UTC instant whose local time in `timeZone` equals the wall clock.
  for (let i = 0; i < 2; i++) {
    const parts = fmt.formatToParts(new Date(t));
    const m = {}; for (const p of parts) m[p.type] = p.value;
    const shown = Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour % 24, +m.minute, +m.second);
    t += (wallUtc - shown);
  }
  return t;
}
function nearestDate(text, { range = false } = {}) {
  const now = Date.now(), candidates = [];
  const exp = range ? /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:\s*(?:-|–|—|to)\s*\d{1,2})?(?:,?\s*(20\d{2}))?/gi : /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:,?\s*(20\d{2}))?/gi;
  for (const match of text.matchAll(exp)) {
    const month = monthIndex[match[1].toLowerCase()], day = Number(match[2]);
    let year = Number(match[3]) || new Date().getUTCFullYear();
    let at = dateAtNoon(year, month, day).getTime();
    if (!match[3] && at < now - 86_400_000) { year += 1; at = dateAtNoon(year, month, day).getTime(); }
    if (at >= now - 86_400_000 && at < now + 400 * 86_400_000) candidates.push({ at, label:`${match[1]} ${day}, ${year}` });
  }
  candidates.sort((a, b) => a.at - b.at); return candidates[0] || null;
}
// Parse FOMC meeting rows from the Fed page instead of scanning all visible
// dates. The page also contains minutes release dates and next year's calendar;
// a page-wide "nearest date" scan can therefore attach an unrelated date to
// the FOMC event. Monetary-policy decisions are released on the final meeting
// day at 14:00 ET.
function nearestFomcDecision(html, now = Date.now()) {
  const source = String(html || ''), candidates = [];
  const headings = [...source.matchAll(/\b(20\d{2}) FOMC Meetings\b/g)];
  for (let sectionIndex = 0; sectionIndex < headings.length; sectionIndex++) {
    const year = Number(headings[sectionIndex][1]);
    const start = headings[sectionIndex].index + headings[sectionIndex][0].length;
    const end = headings[sectionIndex + 1]?.index ?? source.length;
    const section = source.slice(start, end);
    const rowRe = /fomc-meeting__month[^>]*>\s*<strong>([^<]+)<\/strong>[\s\S]*?fomc-meeting__date[^>]*>\s*([^<]+)/gi;
    for (const match of section.matchAll(rowRe)) {
      const monthLabel = match[1].trim(), dateLabel = match[2].replace(/<[^>]+>/g, '').trim();
      const months = monthLabel.split('/').map(value => monthIndex[value.trim().toLowerCase()]).filter(Number.isInteger);
      const days = [...dateLabel.matchAll(/\d{1,2}/g)].map(value => Number(value[0]));
      if (!months.length || !days.length) continue;
      const decisionDay = days.at(-1);
      const decisionMonth = months.length > 1 && days.length > 1 && decisionDay < days[0] ? months.at(-1) : months[0];
      const at = wallToUtc(year, decisionMonth, decisionDay, 14, 0, 'America/New_York');
      if (at >= now - 86_400_000 && at < now + 400 * 86_400_000) {
        candidates.push({ at, label:`${monthLabel} ${dateLabel.replace(/\*/g, '')}, ${year}` });
      }
    }
  }
  candidates.sort((a, b) => a.at - b.at);
  return candidates[0] || null;
}
// BLS publishes a canonical ICS calendar; parse its Employment Situation event instead of guessing from page prose.
// BLS 提供权威 ICS 日历；非农直接解析 Employment Situation 事件，不再从网页正文猜测日期。
function nearestIcsEvent(text, summaryPattern) { const now=Date.now(), candidates=[];for(const block of String(text).split(/BEGIN:VEVENT/i).slice(1)){const summary=(block.match(/SUMMARY:(.+)/i)||[])[1]||'',date=(block.match(/DTSTART(?:;[^:]*)?:(\d{8})(?:T(\d{2})(\d{2}))?/i)||[]);if(!summaryPattern.test(summary)||!date[1])continue;const year=Number(date[1].slice(0,4)),month=Number(date[1].slice(4,6))-1,day=Number(date[1].slice(6,8)),hour=Number(date[2]||17),minute=Number(date[3]||0),at=wallToUtc(year,month,day,hour,minute,'America/New_York');if(at>=now-86_400_000&&at<now+400*86_400_000)candidates.push({at,label:`${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`})}candidates.sort((a,b)=>a.at-b.at);return candidates[0]||null }
// Fallback only when BLS cannot be reached: Employment Situation is normally released on the first Friday of the following month at 08:30 ET.
// 仅当 BLS 不可达时的回退：非农通常在次月第一个周五 08:30 ET 发布。
function payrollCadenceFallback(now=Date.now()) { const date=new Date(now), year=date.getUTCFullYear(), month=date.getUTCMonth()+1;let candidate=new Date(Date.UTC(year,month,1,12,30));candidate.setUTCDate(1+((5-candidate.getUTCDay()+7)%7));if(candidate.getTime()<now-86_400_000){candidate=new Date(Date.UTC(year,month+1,1,12,30));candidate.setUTCDate(1+((5-candidate.getUTCDay()+7)%7))}return {at:candidate.getTime(),label:`${candidate.getUTCFullYear()}-${String(candidate.getUTCMonth()+1).padStart(2,'0')}-${String(candidate.getUTCDate()).padStart(2,'0')}`,fallback:true} }
// BLS's detail page can temporarily deny automated reads. Keep a visibly
// labelled, conservative fallback rather than removing CPI from the calendar.
// The known September 2026 release is retained from the prior verified page;
// subsequent months use an approximate second-Friday placeholder until BLS
// supplies an official date again.
function cpiCadenceFallback(now=Date.now()) { const known=[Date.UTC(2026,8,11,12,30)];const future=known.find(at=>at>=now-86_400_000);if(future)return {at:future,label:'2026-09-11',fallback:true};const date=new Date(now),year=date.getUTCFullYear(),month=date.getUTCMonth()+1;let candidate=new Date(Date.UTC(year,month,1,12,30));candidate.setUTCDate(1+((5-candidate.getUTCDay()+7)%7)+7);if(candidate.getTime()<now-86_400_000){candidate=new Date(Date.UTC(year,month+1,1,12,30));candidate.setUTCDate(1+((5-candidate.getUTCDay()+7)%7)+7)}return {at:candidate.getTime(),label:`${candidate.getUTCFullYear()}-${String(candidate.getUTCMonth()+1).padStart(2,'0')}-${String(candidate.getUTCDate()).padStart(2,'0')}`,fallback:true} }
// 首屏读取三类宏观日历的最近成功 SQLite 快照，并后台请求官方来源更新它。
// Read the latest successful FOMC/CPI/payroll SQLite snapshots on first paint, then revalidate official sources in the background.
function storedFedCalendar(now = Date.now()) {
  const rows = latestFedCalendarSnapshots.all().filter(row => Number.isFinite(+row.event_at) && +row.event_at >= now - 86_400_000);
  if (!rows.length) return null;
  const observedAt = Math.max(...rows.map(row => +row.observed_at));
  return {
    events:rows.map(row => ({ key:String(row.event_key), name:String(row.event_name), at:+row.event_at, source:String(row.source || 'SQLite'), fallback:Boolean(row.is_fallback) })),
    fetchedAt:observedAt, cached:true, storageCached:true, stale:true, cacheAgeMs:Math.max(0, now-observedAt), refreshMs:FED_CALENDAR_TTL,
    unavailable:[], sources:['SQLite fed_calendar_snapshots']
  };
}
async function refreshFedCalendar(now = Date.now()) {
  return coalesce('fed-calendar-refresh', async () => {
      const pages = await Promise.allSettled([
        requestText('https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm', 8_000),
        requestText('https://www.bls.gov/schedule/news_release/cpi.htm', 8_000),
        requestText('https://www.bls.gov/schedule/news_release/empsit.htm', 8_000),
        requestText('https://www.bls.gov/schedule/news_release/bls.ics', 8_000)
      ]);
      const textAt = index => pages[index].status === 'fulfilled' ? plainText(pages[index].value) : '', rawAt=index=>pages[index].status === 'fulfilled'?String(pages[index].value):'';
      let events = [
        { key:'fomc', name:'FOMC 利率决议', source:'Federal Reserve', ...nearestFomcDecision(rawAt(0), now) },
        // CPI 与非农都优先解析 BLS 统一 ICS 日历，网页明细仅作为兼容回退。
        // Parse both CPI and payrolls from BLS's canonical ICS calendar first; use detail pages only as compatibility fallbacks.
        { key:'cpi', name:'美国 CPI', source:'U.S. Bureau of Labor Statistics', ...(nearestIcsEvent(rawAt(3),/Consumer Price Index/i) || nearestDate(textAt(1)) || cpiCadenceFallback(now)) },
        { key:'payrolls', name:'美国非农就业', source:'U.S. Bureau of Labor Statistics', ...(nearestIcsEvent(rawAt(3),/Employment Situation/i) || nearestDate(textAt(2)) || payrollCadenceFallback(now)) }
      ].filter(event => Number.isFinite(event.at));
      // Keep an event visible through its release window even after calendar
      // pages advance to the next date, so the published value can replace its countdown.
      const recentlyReleased=latestFedCalendarSnapshots.all().filter(row=>Number.isFinite(+row.event_at)&&+row.event_at<=now&&now-(+row.event_at)<24*3_600_000).map(row=>({ key:String(row.event_key),name:String(row.event_name),at:+row.event_at,source:String(row.source||'SQLite'),fallback:Boolean(row.is_fallback) }));
      for(const released of recentlyReleased)if(!events.some(event=>event.key===released.key&&event.at===released.at))events.push(released);
      events=events.sort((a,b)=>a.at-b.at);
      if (!events.length) throw new Error('no upcoming public macro events found');
      const result = { events:events.sort((a,b) => a.at - b.at), fetchedAt:now, cached:false, cacheAgeMs:0, refreshMs:FED_CALENDAR_TTL, unavailable:pages.map((page,index) => page.status === 'rejected' ? ['Federal Reserve','BLS CPI','BLS Employment','BLS calendar'][index] : null).filter(Boolean), sources:['https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm','https://www.bls.gov/schedule/news_release/cpi.htm','https://www.bls.gov/schedule/news_release/empsit.htm','https://www.bls.gov/schedule/news_release/bls.ics'] };
      persistFedCalendarSnapshots(result.events, now);
      remember('fed-calendar', result); return result;
  });
}
async function fedCalendar() {
  const key = 'fed-calendar', hit = cache.get(key), now = Date.now();
  const releaseWindow=events=>Array.isArray(events)&&events.some(event=>Math.abs(Number(event.at)-now)<15*60_000);
  const ttl=releaseWindow(hit?.value?.events)?30_000:FED_CALENDAR_TTL;
  if (hit && now - hit.time < ttl) return { ...cacheResult(hit, now), stale:false };
  const stored = storedFedCalendar(now);
  if (stored) {
    remember(key, stored);
    // 返回数据库内容不等待网络；成功刷新会替换内存缓存，下一次界面轮询即得到新数据。
    // Do not block on the network when returning SQLite data; a successful revalidation replaces cache for the next UI poll.
    refreshFedCalendar(now).catch(error => console.warn('Fed calendar background refresh failed:', error.message));
    return stored;
  }
  try { return await refreshFedCalendar(now); }
  catch (error) {
    if (hit && now - hit.time <= 3_600_000) return { ...cacheResult(hit, now), stale:true, fallbackReason:error.name === 'AbortError' ? 'timeout' : error.message };
    throw error;
  }
}
function dailySignal(key, name, quote, source) {
  const last=Number(quote?.last), previous=Number(quote?.previous);
  if (!Number.isFinite(last) || last <= 0) return { key, name, available:false, source, detail:'公开数据暂不可用' };
  return { key, name, available:true, value:last, changePct:Number.isFinite(previous) && previous ? (last / previous - 1) * 100 : null, source, cadence:'日线' };
}
async function fedMarketSignals() {
  const key='fed-market-signals', hit=cache.get(key), now=Date.now();
  if (hit && now-hit.time<FED_MARKET_SIGNALS_TTL) return cacheResult(hit, now);
  return coalesce(key, async () => {
    const [gold,dxy,wti,vix,coingecko,coinlore] = await Promise.allSettled([
      yahooHistory('GC=F'),
      yahooHistory('DX-Y.NYB'),
      yahooHistory('CL=F'),
      yahooHistory('^VIX'),
      request('https://api.coingecko.com/api/v3/global', 8_000, COINGECKO_API_KEY ? { 'x-cg-demo-api-key':COINGECKO_API_KEY } : {}),
      request('https://api.coinlore.net/api/global/', 8_000)
    ]);
    const market=[];
    market.push(gold.status==='fulfilled' ? dailySignal('gold','黄金指数',gold.value.quote,'Yahoo Finance') : { key:'gold', name:'黄金指数', available:false, source:'Yahoo Finance', detail:'公开行情暂不可用' });
    market.push(dxy.status==='fulfilled' ? dailySignal('dxy','美元指数',dxy.value.quote,'Yahoo Finance') : { key:'dxy', name:'美元指数', available:false, source:'Yahoo Finance', detail:'公开行情暂不可用' });
    market.push(wti.status==='fulfilled' ? dailySignal('wti','WTI 原油',wti.value.quote,'Yahoo Finance') : { key:'wti', name:'WTI 原油', available:false, source:'Yahoo Finance', detail:'公开行情暂不可用' });
    market.push(vix.status==='fulfilled' ? dailySignal('vix','VIX 波动率',vix.value.quote,'Yahoo Finance') : { key:'vix', name:'VIX 波动率', available:false, source:'Yahoo Finance', detail:'公开行情暂不可用' });
    const cg=coingecko.status==='fulfilled' ? coingecko.value?.data : null;
    const cl=coinlore.status==='fulfilled' ? (Array.isArray(coinlore.value) ? coinlore.value[0] : coinlore.value?.data?.[0]) : null;
    const dominance=Number(cg?.market_cap_percentage?.btc ?? cl?.btc_d);
    const source=cg ? 'CoinGecko' : cl ? 'CoinLore' : 'CoinGecko / CoinLore';
    market.push(Number.isFinite(dominance) ? { key:'btc-dominance', name:'BTC 总市值占比', available:true, value:dominance, changePct:null, source, cadence:'快照' } : { key:'btc-dominance', name:'BTC 总市值占比', available:false, source, detail:'公开数据暂不可用' });
    const totalMarketCap=Number(cg?.total_market_cap?.usd ?? cl?.total_mcap);
    const totalVolume=Number(cg?.total_volume?.usd ?? cl?.total_volume);
    const globalChange=Number(cg?.market_cap_change_percentage_24h_usd ?? cl?.mcap_change);
    market.push(Number.isFinite(totalMarketCap) && totalMarketCap > 0 ? { key:'crypto-total-cap', name:'全网加密总市值', available:true, value:totalMarketCap, changePct:globalChange, source, cadence:'24h 快照' } : { key:'crypto-total-cap', name:'全网加密总市值', available:false, source, detail:'公开数据暂不可用' });
    market.push(Number.isFinite(totalVolume) && totalVolume > 0 ? { key:'crypto-volume', name:'全网 24h 成交额', available:true, value:totalVolume, changePct:null, source, cadence:'24h 快照' } : { key:'crypto-volume', name:'全网 24h 成交额', available:false, source, detail:'公开数据暂不可用' });
    // 可靠的免密公开源无法提供完整交易所钱包余额；应明确此限制，不能显示第三方的过期或不可验证数字。
    // Full exchange-wallet balances are not available from a reliable public,
    // keyless source. Expose that limitation rather than showing a stale or
    // unverifiable number from a third-party dashboard.
    market.push({ key:'exchange-btc-reserve', name:'交易所比特币钱包余额', available:false, source:'—', detail:'需要可验证的链上数据订阅；当前未接入 Key' });
    const result={ market, fetchedAt:now, refreshMs:FED_MARKET_SIGNALS_TTL };
    persistMacroMarketSnapshots(market, now);
    remember(key,result); return result;
  });
}
// BLS publishes the nonfarm payroll level as a public time series.  The monthly
// difference is the released headline change; we never invent a result when the
// official series has not updated yet.
async function payrollReleaseActual() {
  const key='bls-payroll-release', hit=cache.get(key), now=Date.now();
  if(hit && now-hit.time<30_000)return cacheResult(hit,now);
  return coalesce(key,async()=>{
    const year=new Date().getUTCFullYear();
    const data=await request(`https://api.bls.gov/publicAPI/v2/timeseries/data/CES0000000001?startyear=${year-1}&endyear=${year}`,8_000);
    const rows=Array.isArray(data?.Results?.series?.[0]?.data)?data.Results.series[0].data:[];
    const monthly=rows.filter(row=>/^M\d{2}$/.test(String(row.period||''))&&Number.isFinite(Number(row.value))).sort((a,b)=>Number(b.year)-Number(a.year)||Number(b.period.slice(1))-Number(a.period.slice(1)));
    if(monthly.length<2)throw new Error('BLS payroll series has insufficient monthly observations');
    const latest=monthly[0],previous=monthly[1],change=Math.round(Number(latest.value)-Number(previous.value));
    const value={ value:`新增非农就业 ${change>=0?'+':''}${change.toLocaleString('en-US')}K`, source:'U.S. Bureau of Labor Statistics', period:`${latest.year}-${latest.period.slice(1)}`, fetchedAt:now };
    remember(key,value);return value;
  });
}
async function attachReleasedMacroActuals(events, now=Date.now()) {
  const payroll=events.find(event=>event.key==='payrolls'&&event.at<=now&&now-event.at<24*3_600_000);
  if(!payroll)return events;
  try {
    const actual=await payrollReleaseActual();
    return events.map(event=>event===payroll?{...event,actual}:event);
  } catch { return events; }
}
// ==================== 宏观事件研究（阶段 2：point-in-time 事件样本）====================
// 把 CPI / 核心 CPI / 非农 / FOMC 的发布时刻、实际值与 BTC 在其窗口内的真实表现对齐，产出多因子
// 模型可以拿去分层的样本。三条方法学边界必须随数据一起标注，不能省略：
//   1. 免费源拿不到市场预期 consensus ⇒ surprise_proxy = actual − previous，含义是「相对上一次
//      发布的意外」。它只用于事后分层，不是发布瞬间可用的预测特征。
//   2. 发布时刻精度分三档：exact（FOMC，Fed 官方决议日 14:00 ET）/ day（非农，次月首个周五
//      08:30 ET 是 BLS 的稳定惯例）/ day-estimated（CPI，BLS 不承诺固定日，按惯例推算，通常
//      差 0–2 日）。因此 1h 窗口只在 exact / day 上解释，day-estimated 只进 1d 窗口。
//   3. FRED 给的是修订后终值，不是发布瞬间的初值。窗口收益不依赖 actual，所以修订只影响
//      「大意外 / 小意外」的分层，不影响窗口收益本身。
// ==================== Macro event study (stage 2, point-in-time) ====================
const MACRO_EVENT_DEFS = [
  { key:'cpi', name:'美国 CPI', unit:'pct-mom', series:'CPIAUCSL', transform:'pctChange', precision:'day-estimated',
    source:'U.S. Bureau of Labor Statistics · FRED CPIAUCSL', note:'BLS 不承诺固定发布日，按惯例推算 ±2 日，只用于 1d 窗口' },
  { key:'core-cpi', name:'美国核心 CPI', unit:'pct-mom', series:'CPILFESL', transform:'pctChange', precision:'day-estimated',
    source:'U.S. Bureau of Labor Statistics · FRED CPILFESL', note:'与 CPI 同日发布，同样只用于 1d 窗口' },
  { key:'nfp', name:'美国非农就业', unit:'k-jobs', series:'PAYEMS', transform:'diff', precision:'day',
    source:'U.S. Bureau of Labor Statistics · FRED PAYEMS', note:'次月首个周五 08:30 ET 是稳定惯例，日级精确' },
  { key:'fomc', name:'FOMC 利率决议', unit:'pct', series:'DFEDTARU', transform:'level', precision:'exact',
    source:'Federal Reserve · FRED DFEDTARU', note:'Fed 官方决议日 14:00 ET，时刻精确' },
];
const MACRO_EVENT_BY_KEY = Object.fromEntries(MACRO_EVENT_DEFS.map(def => [def.key, def]));
let macroEventOutcomeStatement = null;
function macroEventOutcomeUpsert() {
  return macroEventOutcomeStatement ||= stmt(`INSERT INTO macro_event_outcomes
    (event_key, event_at, period, actual, previous, surprise_proxy, surprise_z, unit, date_precision, source,
     before_1d, after_1h, after_4h, after_1d, after_1h_abs, after_1d_abs, realized_vol_1d, baseline_vol_1d, vol_ratio, computed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(event_key, event_at) DO UPDATE SET
      period=excluded.period, actual=excluded.actual, previous=excluded.previous, surprise_proxy=excluded.surprise_proxy,
      unit=excluded.unit, date_precision=excluded.date_precision, source=excluded.source,
      before_1d=excluded.before_1d, after_1h=excluded.after_1h, after_4h=excluded.after_4h, after_1d=excluded.after_1d,
      after_1h_abs=excluded.after_1h_abs, after_1d_abs=excluded.after_1d_abs,
      realized_vol_1d=excluded.realized_vol_1d, baseline_vol_1d=excluded.baseline_vol_1d, vol_ratio=excluded.vol_ratio,
      computed_at=excluded.computed_at`);
}
// FRED 的 fredgraph.csv 端点不需要 API key，且支持一次取全历史。缺少值写成字符 '.'。
async function fredCsvRows(seriesId, timeout = 15_000) {
  const text = await requestText(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(seriesId)}`, timeout);
  return String(text || '').trim().split('\n').slice(1).map(line => {
    const comma = line.indexOf(',');
    if (comma < 0) return null;
    const date = line.slice(0, comma).trim(), raw = line.slice(comma + 1).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    return { date, value: raw === '.' || raw === '' ? null : Number(raw) };
  }).filter(row => row && Number.isFinite(row.value));
}
// 把观测值序列折算成「每次发布时会被报道的那个数字」：环比 %、增量或绝对水平。
// Turn a level series into the number that actually gets reported at each release.
function macroObservations(rows, transform) {
  const changes = [];
  for (let index = 0; index < rows.length; index++) {
    const previousValue = index ? Number(rows[index - 1].value) : null, value = Number(rows[index].value);
    const change = transform === 'level' ? value
      : transform === 'diff' ? (previousValue === null ? null : value - previousValue)
      : (previousValue ? (value / previousValue - 1) * 100 : null);
    if (Number.isFinite(change)) changes.push({ period: String(rows[index].date).slice(0, 7), change });
  }
  const byPeriod = new Map();
  changes.forEach((row, index) => byPeriod.set(row.period, { value: row.change, previous: index ? changes[index - 1].change : null }));
  return byPeriod;
}
// BLS 不承诺 CPI 的固定发布日；历史落在次月 10–16 日之间的工作日。取该区间首个周二~周四作估计。
function cpiReleaseGuess(year, month) {
  for (let day = 10; day <= 16; day++) {
    const weekday = new Date(Date.UTC(year, month, day)).getUTCDay();
    if (weekday >= 2 && weekday <= 4) return wallToUtc(year, month, day, 8, 30);
  }
  return wallToUtc(year, month, 14, 8, 30);
}
function macroReleaseSchedule(fromYear, toYear) {
  const rows = [];
  for (let year = fromYear; year <= toYear; year++) {
    for (let month = 0; month < 12; month++) {
      const observed = new Date(Date.UTC(year, month - 1, 1));
      const period = `${observed.getUTCFullYear()}-${String(observed.getUTCMonth() + 1).padStart(2, '0')}`;
      const friday = 1 + ((5 - new Date(Date.UTC(year, month, 1)).getUTCDay() + 7) % 7);
      rows.push({ key:'nfp', at:wallToUtc(year, month, friday, 8, 30), period, precision:'day' });
      const cpiAt = cpiReleaseGuess(year, month);
      rows.push({ key:'cpi', at:cpiAt, period, precision:'day-estimated' });
      rows.push({ key:'core-cpi', at:cpiAt, period, precision:'day-estimated' });
    }
  }
  return rows;
}
// FOMC 决议日取 Fed 官方页。只用**文件名**里的日期：minutes（fomcminutesYYYYMMDD.pdf）与决议
// 声明（monetaryYYYYMMDD.htm）的命名惯例严格对应会议决议日，且是确定性来源。页面正文里的
// 日期混着 minutes 发布日等非会议日期，用它补充会凭空造出十几个不存在的「决议日」。
// 决议例会在周二/周三，用它再滤一层。
async function fomcDecisionInstants(from, to) {
  const instants = new Set();
  let fetched = false;
  try {
    const html = await requestText('https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm', 15_000);
    for (const match of String(html).matchAll(/fomcminutes(\d{4})(\d{2})(\d{2})\.pdf/gi)) instants.add(wallToUtc(+match[1], +match[2] - 1, +match[3], 14, 0));
    for (const match of String(html).matchAll(/monetary(\d{4})(\d{2})(\d{2})[a-z]?\.htm/gi)) instants.add(wallToUtc(+match[1], +match[2] - 1, +match[3], 14, 0));
    fetched = instants.size > 0;
  } catch { /* Fed 页不可达：走下面的回退 */ }
  // 只在官方页不可达时回退到已入库的决议日——它们已通过同一套文件名校验，不会把旧的污染日期带回来。
  if (!fetched) for (const row of stmt("SELECT event_at FROM macro_event_outcomes WHERE event_key='fomc'").all()) instants.add(Number(row.event_at));
  return [...instants].filter(at => { const weekday = new Date(at).getUTCDay(); return weekday === 2 || weekday === 3; })
    .filter(at => at >= from && at <= to).sort((a, b) => a - b);
}
// FOMC 的 actual 是「决议后的目标利率上限」，previous 是决议前的。DFEDTARU 是日度序列，不能像
// 月度指标那样按「期」聚合——一个月内多次变动会互相覆盖。这里按事件瞬间前后各取一个观测。
function fomcRateChange(rows, at) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const before = rows.filter(row => Date.parse(`${row.date}T00:00:00Z`) < at).at(-1);
  const after = rows.find(row => Date.parse(`${row.date}T00:00:00Z`) > at);
  if (!before || !after) return null;
  return { previous: Number(before.value), actual: Number(after.value) };
}
// 定位「在 at 时刻已经收盘」的最后一根 K 线。日线的收盘时刻是 time + 1d，所以事件当天那根
// 日线在事件发生时尚在运行，绝对不能拿来当事件前的基准——那正是前视偏差的来源。
function lastClosedBar(candles, at, barMs) {
  let low = 0, high = candles.length - 1, found = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (Number(candles[mid].time) + barMs <= at) { found = candles[mid]; low = mid + 1; } else high = mid - 1;
  }
  return found;
}
function closedBarReturn(candles, from, to, barMs) {
  const start = lastClosedBar(candles, from, barMs), end = lastClosedBar(candles, to, barMs);
  if (!start || !end || start === end) return null;
  return Number(end.close) / Number(start.close) - 1;
}
// 事件后窗口的日内已实现波动（15m 口径），折算成「日波动」便于比较。只有 15m 覆盖到的
// 近期事件才有值；更早的事件靠日线幅度口径（见 volRatioFor）。
function candleWindowVolatility(candles, from, to) {
  const slice = candles.filter(candle => Number(candle.time) > from && Number(candle.time) <= to);
  if (slice.length < 8) return null;
  const returns = slice.map(candle => Math.log(Number(candle.close) / Number(candle.open))).filter(Number.isFinite);
  if (returns.length < 8) return null;
  const average = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - average) ** 2, 0) / Math.max(returns.length - 1, 1);
  return Math.sqrt(variance) * Math.sqrt(96);
}
// 波动基线：全部日线 |1d 收益| 的中位数，也就是「平常一天」的幅度。事件窗口幅度 ÷ 这个基线
// 就是「事件被定价了多少」——它比方向命中率稳健得多，也不需要日内数据。
function baselineDailyAbsReturn(daily) {
  const values = [];
  for (let index = 1; index < daily.length; index++) {
    const value = Number(daily[index].close) / Number(daily[index - 1].close) - 1;
    if (Number.isFinite(value)) values.push(Math.abs(value));
  }
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)];
}
const MACRO_BACKFILL_TTL = 6 * 3_600_000;
let macroBackfillAt = 0, macroBackfillPayload = null;
async function backfillMacroEventOutcomes({ refresh = false, months = 30 } = {}) {
  const now = Date.now();
  if (!refresh && macroBackfillPayload && now - macroBackfillAt < MACRO_BACKFILL_TTL) return { ...macroBackfillPayload, cached: true };
  const from = now - months * 30.44 * 86_400_000;
  const series = {}, seriesErrors = {};
  for (const def of MACRO_EVENT_DEFS) {
    try {
      const rows = await fredCsvRows(def.series);
      // FOMC 保留日度原始序列（按事件瞬间前后取值）；月度指标聚合成「每次发布被报道的那个数」。
      series[def.key] = def.transform === 'level' ? rows : macroObservations(rows, def.transform);
    } catch (error) {
      series[def.key] = def.transform === 'level' ? [] : new Map();
      seriesErrors[def.key] = String(error?.message || error);
    }
  }
  const events = [
    ...macroReleaseSchedule(new Date(from).getUTCFullYear() - 1, new Date(now).getUTCFullYear() + 1).filter(row => row.at >= from && row.at <= now),
    ...(await fomcDecisionInstants(from, now)).map(at => ({ key:'fomc', at, period:null, precision:'exact' })),
  ].sort((a, b) => a.at - b.at);
  // 日线承担 1d 窗口（覆盖约 2.8 年），15m 只在它覆盖到的近期补 1h / 4h 与日内已实现波动。
  // 15m 只有约 30 天历史：拿它算 1d 窗口会把回填静默截断成最近一个月。
  const daily = storedCandleRange('1d', from - 10 * 86_400_000, now + 2 * 86_400_000);
  const intraday = storedCandleRange('15m', from - 3 * 86_400_000, now + 86_400_000);
  const dayMs = 86_400_000, barMs = 900_000, baseline = baselineDailyAbsReturn(daily);
  const statement = macroEventOutcomeUpsert();
  // FOMC 的日期完全由官方来源决定：先清掉旧行，否则上一轮混进来的非决议日会永久留在表里。
  stmt("DELETE FROM macro_event_outcomes WHERE event_key='fomc'").run();
  let written = 0, withoutWindow = 0, withoutIntraday = 0;
  for (const event of events) {
    if (event.at + dayMs > now) { withoutWindow++; continue; }   // 窗口还没走完，不写半个样本
    let actual = null, previous = null;
    if (event.key === 'fomc') {
      const change = fomcRateChange(series.fomc, event.at);
      if (change) { actual = change.actual; previous = change.previous; }
    } else {
      const observation = series[event.key]?.get(event.period) || null;
      if (observation) { actual = observation.value; previous = observation.previous; }
    }
    const surprise = actual !== null && previous !== null ? actual - previous : null;
    const after1d = closedBarReturn(daily, event.at, event.at + dayMs, dayMs);
    if (after1d === null) { withoutWindow++; continue; }
    const before1d = closedBarReturn(daily, event.at - dayMs, event.at, dayMs);
    const after1h = closedBarReturn(intraday, event.at, event.at + 3_600_000, barMs)
      , after4h = closedBarReturn(intraday, event.at, event.at + 4 * 3_600_000, barMs);
    if (after1h === null) withoutIntraday++;
    const realized = candleWindowVolatility(intraday, event.at, event.at + dayMs);
    const definition = MACRO_EVENT_BY_KEY[event.key];
    statement.run(event.key, event.at, event.period, actual, previous, surprise, null, definition.unit, event.precision, definition.source,
      before1d, after1h, after4h, after1d, after1h === null ? null : Math.abs(after1h), Math.abs(after1d),
      realized, baseline, baseline ? Math.abs(after1d) / baseline : null, now);
    written++;
  }
  // surprise 的标准化只能在整类样本齐了之后做，否则每次回填标准差都会变。
  for (const def of MACRO_EVENT_DEFS) {
    const rows = stmt('SELECT id, surprise_proxy FROM macro_event_outcomes WHERE event_key=? AND surprise_proxy IS NOT NULL').all(def.key);
    if (rows.length < 4) continue;
    const values = rows.map(row => Number(row.surprise_proxy));
    const average = values.reduce((sum, value) => sum + value, 0) / values.length;
    const deviation = Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / Math.max(values.length - 1, 1));
    const update = stmt('UPDATE macro_event_outcomes SET surprise_z=? WHERE id=?');
    for (const row of rows) update.run(deviation ? (Number(row.surprise_proxy) - average) / deviation : null, row.id);
  }
  macroBackfillAt = now;
  macroBackfillPayload = { generatedAt: now, windowMonths: months, written, skippedIncompleteWindow: withoutWindow,
    withoutIntraday, dailyCandles: daily.length, intradayCandles: intraday.length,
    baselineDailyAbsReturn: baseline, seriesErrors };
  return { ...macroBackfillPayload, cached: false };
}
// 读表出统计。全部分层都建立在「已实现事实」上，不是预测——方向命中率只作事后归因，不能当作策略胜率。
function macroEventStudy() {
  const rows = stmt('SELECT * FROM macro_event_outcomes ORDER BY event_at ASC').all();
  const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const median = values => { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };
  const numeric = (subset, field) => subset.map(row => Number(row[field])).filter(Number.isFinite);
  const byKind = {};
  for (const def of MACRO_EVENT_DEFS) {
    const subset = rows.filter(row => row.event_key === def.key);
    if (!subset.length) { byKind[def.key] = { name:def.name, unit:def.unit, precision:def.precision, note:def.note, source:def.source, samples:0 }; continue; }
    // 1h 窗口对 day-estimated 不可解释：日期本身可能差一两天，小时级归因会变成噪声。
    const hourlyUsable = def.precision !== 'day-estimated';
    const surpriseRows = subset.filter(row => Number.isFinite(Number(row.surprise_z)) && Number(row.surprise_proxy) !== 0);
    const unchangedRows = subset.filter(row => Number.isFinite(Number(row.surprise_z)) && Number(row.surprise_proxy) === 0);
    const positive = surpriseRows.filter(row => Number(row.surprise_z) > 0), negative = surpriseRows.filter(row => Number(row.surprise_z) < 0);
    const after1d = numeric(subset, 'after_1d');
    byKind[def.key] = {
      name:def.name, unit:def.unit, precision:def.precision, note:def.note, source:def.source,
      samples:subset.length, withActual:subset.filter(row => row.actual !== null).length,
      from:subset[0].event_at, to:subset[subset.length - 1].event_at,
      medianAbsReturn:{ h1:hourlyUsable ? median(numeric(subset, 'after_1h_abs')) : null, d1:median(numeric(subset, 'after_1d_abs')) },
      meanReturn:{ h1:hourlyUsable ? mean(numeric(subset, 'after_1h')) : null, h4:hourlyUsable ? mean(numeric(subset, 'after_4h')) : null, d1:mean(after1d) },
      positiveRate:{ h1:hourlyUsable ? (numeric(subset, 'after_1h').filter(value => value > 0).length / Math.max(numeric(subset, 'after_1h').length, 1)) : null,
        d1:after1d.filter(value => value > 0).length / Math.max(after1d.length, 1) },
      volatility:{ medianRatio:median(numeric(subset, 'vol_ratio')), amplifiedShare:numeric(subset, 'vol_ratio').filter(value => value > 1).length / Math.max(numeric(subset, 'vol_ratio').length, 1) },
      surpriseSplit:surpriseRows.length >= 4 ? {
        positive:{ samples:positive.length, meanAfter1d:mean(numeric(positive, 'after_1d')), positiveRate:(() => { const values = numeric(positive, 'after_1d'); return values.filter(value => value > 0).length / Math.max(values.length, 1); })() },
        negative:{ samples:negative.length, meanAfter1d:mean(numeric(negative, 'after_1d')), positiveRate:(() => { const values = numeric(negative, 'after_1d'); return values.filter(value => value > 0).length / Math.max(values.length, 1); })() },
      } : null,
      // 「没有意外」是独立的一类样本，不是小意外。FOMC 多数会议利率不动，把它们塞进正/负
      // 意外分层里，等于按 z 的符号随机分边，结论会凭空冒出来。
      unchanged:unchangedRows.length ? { samples:unchangedRows.length, meanAfter1d:mean(numeric(unchangedRows, 'after_1d')),
        medianVolRatio:median(numeric(unchangedRows, 'vol_ratio')) } : null,
    };
  }
  return { generatedAt:macroBackfillAt || null, total:rows.length, byKind,
    coverage:rows.length ? { from:rows[0].event_at, to:rows[rows.length - 1].event_at } : null,
    methodology:[
      'surprise = 实际值 − 上一次发布值。免费源拿不到市场预期，因此这不是 consensus surprise，只用于事后分层。',
      '1d 窗口用日线序列（覆盖约 2.8 年），基准取「事件时刻前已收盘的最后一根日线」，事件当天那根日线在事件发生时尚未收盘，用它就是前视偏差。',
      '事件当根日线收益 = 事件当日收盘 ÷ 前一日收盘 − 1；1h / 4h 窗口用 15m，仅有约 30 天覆盖，更早的事件这两项为空。',
      '波动放大倍数 = 事件当根日线收益的幅度 ÷ 全部日线 |收益| 的中位数（「平常一天」的幅度）。它是事件是否被定价的直接证据，且方向中性。',
      'CPI 的发布日精度为日级估计（BLS 不承诺固定日），其 1h 窗口不出统计；1d 窗口不受影响。',
      '所有收益都是事件窗口的已实现结果，不含交易成本，也不构成策略胜率。',
    ] };
}
// The model may only use information a trader genuinely had at that instant. Event *dates* are
// published by the Fed and BLS months ahead, so "how many hours until the next FOMC / payrolls /
// CPI print" is known in real time and is safe as a feature — including for events after the bucket
// being scored, because the nearest bracketing dates were already on the calendar back then.
// The printed *values* are a different matter: they exist only from the release instant onward, and
// FRED stamps an observation with the period it describes rather than the moment it became public,
// so aligning values by observation date would leak the future into the past. Values are therefore
// deliberately excluded from the feature set.
// 模型只能用那一刻真实可得的信息。事件「日期」由 Fed / BLS 提前数月公布，因此「距下次 FOMC／非农／
// CPI 还有多少小时」在当时就已知，可以安全入模 —— 包括被评分桶之后的事件，因为当时日历上最靠近的
// 那两个日期早已公布。但「发布值」不同：它们从发布瞬间才存在，而 FRED 用「所描述的时间段」给观测打
// 戳、不是「公开时刻」，按观测日期对齐会把未来泄漏进过去。因此发布值被有意排除在特征之外。
const MACRO_HIGH_IMPACT_KEYS = ['fomc', 'nfp', 'cpi'];
const MACRO_CALENDAR_TTL = 60_000;
let macroCalendarCache = null, macroCalendarCacheAt = 0;
function macroHighImpactCalendar() {
  const now = Date.now();
  if (macroCalendarCache && now - macroCalendarCacheAt < MACRO_CALENDAR_TTL) return macroCalendarCache;
  const placeholders = MACRO_HIGH_IMPACT_KEYS.map(() => '?').join(',');
  // CPI and core CPI print the same day, so the dates are de-duplicated rather than double-counted.
  // CPI 与核心 CPI 同日发布，因此日期去重而不是重复计数。
  const instants = stmt(`SELECT event_at FROM macro_event_outcomes WHERE event_key IN (${placeholders}) GROUP BY event_at ORDER BY event_at ASC`)
    .all(...MACRO_HIGH_IMPACT_KEYS).map(row => Number(row.event_at)).filter(Number.isFinite);
  macroCalendarCache = instants; macroCalendarCacheAt = now;
  return instants;
}
// Hours since the most recent published event. Kept as a top-level helper so the replay can tag
// every sample with it for conditional reporting, rather than only consuming it as a model feature.
// 距最近一次已公布事件的小时数。抽成顶层 helper，好让回放给每条样本打上该标记做条件统计，而不只是
// 把它当作模型特征消耗掉。
function hoursSinceEvent(calendar, at) {
  if (!Array.isArray(calendar) || !calendar.length) return null;
  let low = 0, high = calendar.length - 1, previous = null;
  while (low <= high) { const mid = (low + high) >> 1; if (calendar[mid] <= at) { previous = calendar[mid]; low = mid + 1; } else high = mid - 1; }
  return previous === null ? null : (at - previous) / 3_600_000;
}
// ── Perpetual funding rate (multi-factor candidate) ─────────────────────────────────────────────
// A funding rate is the price of holding a perp: positive means longs pay shorts, which is what a
// crowded long book looks like. It is a candidate factor, not a settled one — the ablation decides.
// 资金费率是持有永续的代价：为正表示多头付钱给空头，也就是多头拥挤的样子。它是候选因子而非已经
// 定论的因子 —— 有没有增量由消融实验决定。
const FUNDING_ENDPOINT = 'https://fapi.binance.com/fapi/v1/fundingRate';
// symbol 不再写死：资金费率历史按当前币种拉取，各币种存在各自的库文件里。
const FUNDING_SOURCE = { exchange: 'binance' };
// The upstream caps a page at 500 rows and there are three settlements a day, so three years takes
// roughly seven requests. The request ceiling is a guard against a paging loop that never converges.
// 上游单页上限 500 行，每天三次结算，三年大约七次请求。请求上限是防止分页循环不收斂的护栏。
const FUNDING_PAGE = 500, FUNDING_MAX_REQUESTS = 40, FUNDING_FEATURE_TTL = 10 * 60_000;
let fundingFeatureCache = null, fundingFeatureCacheAt = 0;

// Pages forward through the funding history and upserts every settlement. Upsert rather than
// insert-or-ignore: an exchange may revise a print, and a stale rate silently feeding a feature is
// worse than rewriting a row.
// 沿资金费率历史向前分页，逐条 upsert。用 upsert 而不是 insert-or-ignore：交易所可能修正某个结算
// 值，而一个过期的费率静默喂进特征，比重写一行更糟。
async function backfillFundingRates({ from, to } = {}) {
  const { exchange } = FUNDING_SOURCE, symbol = instIdFor('binance');
  const start = Number(from) || (Date.now() - 3 * 365 * 86_400_000), end = Number(to) || (Date.now() + 3_600_000);
  const upsert = stmt(`INSERT INTO funding_rate_history(exchange,symbol,funding_at,rate,mark_price,fetched_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(exchange,symbol,funding_at) DO UPDATE SET rate=excluded.rate, mark_price=excluded.mark_price, fetched_at=excluded.fetched_at`);
  let cursor = start, requests = 0, written = 0, firstAt = null, lastAt = null;
  while (cursor < end && requests < FUNDING_MAX_REQUESTS) {
    const page = await request(`${FUNDING_ENDPOINT}?symbol=${symbol}&startTime=${cursor}&endTime=${end}&limit=${FUNDING_PAGE}`, 12_000);
    if (!Array.isArray(page) || !page.length) break;
    const fetchedAt = Date.now();
    for (const item of page) {
      const at = Number(item?.fundingTime), rate = Number(item?.fundingRate);
      if (!Number.isFinite(at) || !Number.isFinite(rate)) continue;
      upsert.run(exchange, symbol, at, rate, Number(item?.markPrice) || null, fetchedAt);
      written += 1;
      if (firstAt === null) firstAt = at;
      lastAt = at;
    }
    requests += 1;
    const advanced = Number(page.at(-1)?.fundingTime);
    if (!Number.isFinite(advanced) || advanced < cursor) break;
    cursor = advanced + 1;
    // The service is single-threaded and a three-year backfill is a dozen sequential round trips.
    // 服务是单线程的，而三年回填是十几次串行的往返请求。
    await new Promise(resolve => setImmediate(resolve));
  }
  fundingFeatureCache = null;
  return { exchange, symbol, requests, written, firstAt, lastAt, stored: fundingRateCount() };
}
function fundingRateCount() { return Number(stmt('SELECT COUNT(*) AS total FROM funding_rate_history').get()?.total) || 0; }

// Every derived value is computed from the settlements that came *before* it, so the whole series can
// be materialised once and then read at any historical instant with no look-ahead risk. Computing the
// rolling statistics at read time instead would re-slice the history for every bucket.
// 每个派生值都只用它**之前**的结算值计算，因此整条序列可以一次算好，之后在任何历史时刻读取都没有
// 前视风险。若改成读取时现算滚动统计，就得在每个桶上重新切一次历史。
function fundingFeatureSeries() {
  const now = Date.now();
  if (fundingFeatureCache && now - fundingFeatureCacheAt < FUNDING_FEATURE_TTL) return fundingFeatureCache;
  const features = buildFundingFeatures(stmt('SELECT funding_at, rate FROM funding_rate_history ORDER BY funding_at ASC').all());
  fundingFeatureCache = features; fundingFeatureCacheAt = now;
  return features;
}
// Binary search for the last settlement at or before `at`, then report it as four numbers: crowding
// z-score, recent tilt, absolute level, and how far into the settlement cycle the bucket sits. A
// bucket predating the whole series returns null so the caller can tell "no data" from "neutral".
// 二分查找 `at` 之前（含）最近的一次结算，并报成四个数字：拥挤度 z 分数、近期斜率、绝对水平，以及
// 该桶落在结算周期的哪个位置。早于整条序列的桶返回 null，调用方因此能区分「没有数据」与「中性」。
// Tied to the length fundingFeaturesAt returns: the column count and the vector it emits must move
// together, so the constant lives next to the function that produces the vector rather than in the
// configuration block, where the two could drift apart without anything noticing.
// 与 fundingFeaturesAt 的返回长度绑定：列数必须与它产出的向量一起变动，所以这个常量紧挨着产出
// 向量的函数，而不是放在配置块里 —— 放在那里两者可能悄悄漂移而无人察觉。

async function fedMonitor() {
  const calendar=await fedCalendar();
  const events=await attachReleasedMacroActuals(calendar.events||[]);
  let signals;
  try { signals=await fedMarketSignals(); }
  catch { signals={ market:[], fetchedAt:Date.now(), refreshMs:FED_MARKET_SIGNALS_TTL }; }
  return { ...calendar, events, marketSignals:signals.market, marketSignalsFetchedAt:signals.fetchedAt, marketSignalsRefreshMs:signals.refreshMs };
}

// A BTC-focused calendar has a paid-feed enhancement path, but never exposes a
// provider key to the browser.  Official Fed/BLS dates remain the dependable
// zero-config baseline; mempool.space supplies the native Bitcoin event.
const INVESTMENT_CALENDAR_TTL = 5 * 60_000;
function calendarImportance(value) {
  const text = String(value || '').toLowerCase();
  if (/high|3|important/.test(text)) return 'high';
  if (/medium|2/.test(text)) return 'medium';
  return 'low';
}
function numberOrText(value) {
  return value === null || value === undefined || value === '' ? null : String(value);
}
function normalizeFinnhubCalendar(rows, now) {
  const keywords = /consumer price|cpi|nonfarm|payroll|fomc|fed interest|pce|producer price|retail sales|gross domestic|jobless/i;
  return (Array.isArray(rows) ? rows : [])
    .filter(row => String(row.country || '').toUpperCase() === 'US' && keywords.test(String(row.event || row.name || '')))
    .map((row, index) => {
      const at = Date.parse(row.time || row.datetime || row.date);
      if (!Number.isFinite(at) || at < now - 24 * 3_600_000) return null;
      return {
        id:`finnhub-${at}-${index}`, at, country:'US', category:'macro',
        title:String(row.event || row.name || '美国宏观数据'), importance:calendarImportance(row.impact),
        actual:numberOrText(row.actual), estimate:numberOrText(row.estimate), previous:numberOrText(row.prev ?? row.previous),
        source:'Finnhub', directional:'等待实际值与预期的偏差确认',
      };
    }).filter(Boolean).sort((a,b) => a.at - b.at).slice(0, 30);
}
function xmlBlocks(text, tag) {
  return [...String(text || '').matchAll(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'gi'))].map(match => match[0]);
}
function newYorkTimestamp(date, time='12:00') {
  const [year, month, day]=String(date).split('-').map(Number), [hour, minute]=String(time).split(':').map(Number);
  if (![year,month,day,hour,minute].every(Number.isFinite)) return NaN;
  const base=Date.UTC(year, month-1, day, hour, minute);
  const zone=new Intl.DateTimeFormat('en-US', { timeZone:'America/New_York', timeZoneName:'longOffset' }).formatToParts(new Date(base)).find(part => part.type==='timeZoneName')?.value || 'GMT-5';
  const offset=zone.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!offset) return base + 5 * 3_600_000;
  const minutes=(Number(offset[2]) * 60 + Number(offset[3] || 0)) * (offset[1] === '+' ? 1 : -1);
  return base - minutes * 60_000;
}
function calendarDate(value) {
  const match=String(value || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  return match ? match[0] : null;
}
function treasuryAuctionKey(date, term, type) {
  return [date, term, type].map(value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase()).join('|');
}
function treasuryPercent(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const number=Number(value);
  return Number.isFinite(number) ? `${number.toFixed(3)}%` : null;
}
function treasuryEasternTime(value) {
  const match=String(value || '').trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return null;
  let hour=Number(match[1]), minute=Number(match[2]);
  if (hour === 12) hour=0;
  if (match[3].toUpperCase() === 'PM') hour += 12;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}
function treasuryAmount(value) {
  const number=Number(value);
  return Number.isFinite(number) && number > 0 ? `$${(number / 1e9).toFixed(1)}B` : null;
}
function parseTreasuryJsonp(text) {
  const payload=String(text || '').match(/^\s*[^\(]*\(([\s\S]*)\)\s*;?\s*$/)?.[1];
  if (!payload) throw new Error('invalid Treasury auction-query response');
  const result=JSON.parse(payload);
  return Array.isArray(result?.securityList) ? result.securityList : [];
}
async function treasuryAuctionResults() {
  // TreasuryDirect's official Auction Query exposes competitive results in a
  // JSONP envelope.  A 100-row window covers the current auction cycle and
  // provides the immediately preceding same-term auction for comparison.
  const text=await requestText('https://www.treasurydirect.gov/TA_WS/securities/jqsearch?format=jsonp&pagesize=100&pagenum=0', 8_000);
  const rows=parseTreasuryJsonp(text).filter(row => /note|bond/i.test(String(row.securityType || '')));
  const byAuction=new Map(), byDateAndType=new Map(), previousByTerm=new Map();
  for (const row of rows) {
    const date=calendarDate(row.auctionDate);
    const term=String(row.securityTerm || '').trim(), type=String(row.securityType || '').trim();
    if (!date || !term || !type) continue;
    const key=treasuryAuctionKey(date, term, type);
    byAuction.set(key, row);
    // Re-openings may be called “9-Year 11-Month” by the results service while
    // the tentative schedule calls them “10-Year”.  Date + security type is
    // unambiguous in this limited coupon-auction calendar.
    byDateAndType.set(treasuryAuctionKey(date, '', type), row);
    const comparableTerm=String(row.originalSecurityTerm || term).trim();
    const termKey=treasuryAuctionKey('', comparableTerm, type);
    const known=previousByTerm.get(termKey) || [];
    known.push(row); previousByTerm.set(termKey, known);
  }
  for (const rowsForTerm of previousByTerm.values()) rowsForTerm.sort((a,b) => String(b.auctionDate || '').localeCompare(String(a.auctionDate || '')));
  return { byAuction, byDateAndType, previousByTerm };
}
function blsMacroEvents(ics, now) {
  const relevant=/consumer price index|producer price index|employment situation|employment cost index|productivity and costs|import and export price/i;
  return String(ics || '').split('BEGIN:VEVENT').slice(1).map((block, index) => {
    const summary=(block.match(/(?:\r?\n|^)SUMMARY(?:;[^:]+)?:([^\r\n]+)/i) || [])[1]?.replace(/\\,/g, ',').trim();
    const rawDate=(block.match(/(?:\r?\n|^)DTSTART(?:;[^:]+)?:([0-9TZ]+)/i) || [])[1];
    if (!summary || !rawDate || !relevant.test(summary)) return null;
    const parts=rawDate.match(/(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2}))?/);
    if (!parts) return null;
    const at=wallToUtc(+parts[1], +parts[2]-1, +parts[3], +(parts[4] || 12), +(parts[5] || 0), 'America/New_York');
    if (at < now - 24 * 3_600_000 || at > now + 50 * 86_400_000) return null;
    const importance=/consumer price index|employment situation/i.test(summary) ? 'high' : /producer price index/i.test(summary) ? 'medium' : 'low';
    return { id:`bls-${at}-${index}`, at, country:'US', category:'macro', title:summary, importance,
      actual:null, estimate:null, previous:null, source:'U.S. Bureau of Labor Statistics',
      directional:'发布前后关注实际值相对市场预期的偏差；避免将单一数据直接当作 BTC 方向信号' };
  }).filter(Boolean);
}
async function treasuryCalendarEvents(now) {
  const page=await requestText('https://home.treasury.gov/policy-issues/financing-the-government/quarterly-refunding/most-recent-quarterly-refunding-documents/', 8_000);
  const auctionUrl=(page.match(/href\s*=\s*["']?([^\s"'>]*TentativeAuctionSchedule[^\s"'>]*\.xml)/i) || [])[1];
  const buybackUrl=(page.match(/href\s*=\s*["']?([^\s"'>]*Tentative-Buyback-Schedule[^\s"'>]*\.xml)/i) || [])[1];
  const fullUrl=value => value && new URL(value, 'https://home.treasury.gov').href;
  const [auctionXml,buybackXml,auctionResults]=await Promise.all([
    auctionUrl ? requestText(fullUrl(auctionUrl), 8_000) : '',
    buybackUrl ? requestText(fullUrl(buybackUrl), 8_000) : '',
    treasuryAuctionResults(),
  ]);
  const events=[];
  for (const [index, block] of xmlBlocks(auctionXml, 'AuctionCalendarDate').entries()) {
    const date=calendarDate(xmlField(block, 'AuctionDate')); if (!date) continue;
    const term=xmlField(block, 'SecurityTermWeekYear') || '美国国债', type=xmlField(block, 'SecurityType');
    const result=auctionResults.byAuction.get(treasuryAuctionKey(date, term, type))
      || auctionResults.byDateAndType.get(treasuryAuctionKey(date, '', type));
    const closingTime=treasuryEasternTime(result?.closingTimeCompetitive);
    const at=newYorkTimestamp(date, closingTime || '12:00');
    if (at < now - 24 * 3_600_000 || at > now + 50 * 86_400_000) continue;
    // Bills are frequent cash-management plumbing.  Keep coupon auctions,
    // which carry more useful duration/liquidity information, on the main BTC timeline.
    if (!/NOTE|BOND/i.test(type)) continue;
    const resultTerm=String(result?.originalSecurityTerm || result?.securityTerm || term);
    const previous=(auctionResults.previousByTerm.get(treasuryAuctionKey('', resultTerm, type)) || [])
      .find(row => calendarDate(row.auctionDate) && calendarDate(row.auctionDate) < date && treasuryPercent(row.highYield));
    const highYield=treasuryPercent(result?.highYield), bidToCover=result?.bidToCoverRatio === '' || result?.bidToCoverRatio === undefined || result?.bidToCoverRatio === null ? NaN : Number(result.bidToCoverRatio);
    const actual=highYield ? `中标收益率 ${highYield}${Number.isFinite(bidToCover) ? ` · 投标倍数 ${bidToCover.toFixed(2)}x` : ''}` : null;
    const previousYield=treasuryPercent(previous?.highYield);
    events.push({ id:`treasury-auction-${date}-${index}`, at, country:'US', category:'liquidity',
      title:`美国 ${term} 国债拍卖${type ? ` · ${type}` : ''}`, importance:/10-Year|20-Year|30-Year/i.test(term) ? 'high' : 'medium', actual,
      estimate:treasuryAmount(result?.offeringAmount) ? `发行规模 ${treasuryAmount(result.offeringAmount)}` : null,
      previous:previousYield ? `上次中标收益率 ${previousYield}` : null,
      source:actual ? 'U.S. TreasuryDirect · Auction Query（官方竞争性拍卖结果）' : closingTime ? `U.S. TreasuryDirect · Auction Query（竞争性投标截止 ${result.closingTimeCompetitive} ET）` : 'U.S. Treasury · Tentative Auction Schedule（官方结果待发布）',
      directional:'关注中标收益率、投标倍数与尾差；拍卖日不是 BTC 的单向交易信号' });
  }
  for (const [index, block] of xmlBlocks(buybackXml, 'BuybackCalendarDate').entries()) {
    const date=calendarDate(xmlField(block, 'OperationDate')); if (!date) continue;
    const at=newYorkTimestamp(date, xmlField(block, 'OperationStartTimeEasternUS') || '12:00');
    if (at < now - 24 * 3_600_000 || at > now + 50 * 86_400_000) continue;
    const bucket=xmlField(block, 'PurchaseBucketName'), operation=xmlField(block, 'OperationType') || 'Treasury Buyback';
    const maximum=Number(xmlField(block, 'MaximumPurchaseAmountDollars'));
    events.push({ id:`treasury-buyback-${date}-${index}`, at, country:'US', category:'liquidity',
      title:`美财政部回购 · ${operation}${bucket ? ` · ${bucket}` : ''}`, importance:/Liquidity Support/i.test(operation) ? 'high' : 'medium', actual:null,
      estimate:Number.isFinite(maximum) ? `最高 $${(maximum / 1e9).toFixed(maximum >= 1e9 ? 1 : 2)}B` : null, previous:null,
      source:'U.S. Treasury · Tentative Buyback Schedule', directional:'财政部回购与美联储回购操作不同；关注公布的规模、期限桶与后续利率反应' });
  }
  return events;
}
function treasuryLongEndBuybackPolicyEvent(now) {
  // This is a one-off policy change, distinct from an individual scheduled
  // operation.  Keep it visible only while the announced refunding-quarter
  // policy is in force, so a historic headline does not become a fake recurring event.
  const effective=Date.UTC(2026, 8, 9, 4), expires=Date.UTC(2026, 10, 5);
  if (now < effective - 21 * 86_400_000 || now > expires) return [];
  return [{ id:'treasury-long-end-buyback-increase-2026q3', at:effective, country:'US', category:'liquidity', timePrecision:'date',
    title:'美财政部长端流动性回购上限至少翻倍', importance:'high', actual:'政策已生效', estimate:'上限 ≥$4.0B / 次', previous:'上限 $2.0B / 次',
    source:'U.S. Treasury · Aug. 19, 2026 policy announcement',
    directional:'适用于 10–20 年与 20–30 年名义票据的流动性支持回购；这是财政部债务管理措施，不是美联储 QE 或 repo' }];
}
function nextWeekdayAt(now, weekday, time) {
  const date=new Date(now), days=(weekday-date.getUTCDay()+7)%7 || 7;
  date.setUTCDate(date.getUTCDate()+days);
  return newYorkTimestamp(date.toISOString().slice(0,10), time);
}
function eiaNextReleaseEvent(schedule, now) {
  const text=String(schedule || '');
  const dateFromText=value => {
    const match=String(value).match(/^([A-Za-z]+)\.?\s+(\d{1,2}),\s*(\d{4})$/);
    const month={january:1,jan:1,february:2,feb:2,march:3,mar:3,april:4,apr:4,may:5,june:6,jun:6,july:7,jul:7,august:8,aug:8,september:9,sep:9,sept:9,october:10,oct:10,november:11,nov:11,december:12,dec:12}[match?.[1]?.toLowerCase()];
    return month ? `${match[3]}-${String(month).padStart(2,'0')}-${String(match[2]).padStart(2,'0')}` : null;
  };
  // The EIA page deliberately publishes the normal Wednesday cadence and a
  // holiday-exception table rather than a single machine-readable next date.
  const exception=[...text.matchAll(/<tr[^>]*>\s*<th[^>]*>\s*[A-Za-z]+\s+\d{1,2},\s+\d{4}\s*<\/th>\s*<td[^>]*>\s*([A-Za-z]+\s+\d{1,2},\s+\d{4})\s*<\/td>\s*<td[^>]*>[^<]*<\/td>\s*<td[^>]*>\s*([^<]+?)\s*<\/td>/gi)]
    .map(match => ({ date:dateFromText(match[1]), time:match[2] })).find(row => row.date && newYorkTimestamp(row.date, /12:00/i.test(row.time) ? '12:00' : /11:00/i.test(row.time) ? '11:00' : '10:30') >= now - 60_000);
  const normal=nextWeekdayAt(now, 3, '10:30');
  const at=exception ? newYorkTimestamp(exception.date, /12:00/i.test(exception.time) ? '12:00' : /11:00/i.test(exception.time) ? '11:00' : '10:30') : normal;
  return Number.isFinite(at) ? { id:`eia-wpsr-${at}`, at, country:'OIL', category:'energy', title:'EIA 美国原油库存周报', importance:'medium', actual:null, estimate:null, previous:null,
    source:'U.S. Energy Information Administration', directional:'库存意外会先影响油价与通胀预期；再观察美元、实际利率和风险偏好联动' } : null;
}
function deribitExpiryEvents(payload, now) {
  const unique=[...new Set((payload?.result || []).map(row => Number(row.expiration_timestamp)).filter(at => Number.isFinite(at) && at > now && at < now + 50 * 86_400_000))].sort((a,b) => a-b);
  const selected=unique.filter((at,index) => index < 2 || new Date(at).getUTCDay() === 5).slice(0, 8);
  return selected.map(at => ({ id:`deribit-btc-expiry-${at}`, at, country:'BTC', category:'crypto', title:'Deribit BTC 期权到期', importance:new Date(at).getUTCDate() > 24 ? 'high' : 'medium', actual:null, estimate:null, previous:null,
    source:'Deribit public API', directional:'到期日可能放大短线对冲与 Gamma 影响；需结合未平仓量和隐含波动率，不预设方向' }));
}
// Domestic, key-free, comprehensive macro calendar via Eastmoney's public
// data-center endpoint. Times arrive as Beijing wall-clock strings (no DST in
// China), so convert to UTC by subtracting a fixed 8 hours.
function parseShanghaiDateTime(value) {
  const match = String(value || '').match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return NaN;
  const [, y, mo, d, h, mi, s] = match;
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0)) - 8 * 3_600_000;
}
const EASTMONEY_COUNTRY = {
  '美国':'US','中国':'CN','中国香港':'HK','中国台湾':'TW','欧盟':'EU','欧元区':'EU','日本':'JP','英国':'UK','德国':'DE','法国':'FR','巴西':'BR','澳大利亚':'AU','新加坡':'SG','加拿大':'CA','韩国':'KR','印度':'IN','俄罗斯':'RU','OPEC':'OPEC','瑞士':'CH','意大利':'IT','西班牙':'ES','墨西哥':'MX','土耳其':'TR','南非':'ZA','新西兰':'NZ',
};
function normalizeEastmoneyCountry(city) {
  const c = String(city || '').trim();
  if (EASTMONEY_COUNTRY[c]) return EASTMONEY_COUNTRY[c];
  if (/[一-龥]/.test(c)) return 'CN';
  if (/^[A-Za-z]{2,4}$/.test(c)) return c.toUpperCase();
  return 'GLOBAL';
}
function cleanEastmoneyTitle(name) {
  return String(name || '').replace(/\(报告期[^)]*\)/g, '').replace(/:/g, ' · ').replace(/\s+/g, ' ').trim();
}
// Eastmoney returns the same macro release split into multiple indicator variants
// (e.g. "美国 · 核心CPI · 季调 · 环比", "美国 · CPI · 非季调 · 同比"). Collapse
// these into a single, recognizable headline so the calendar does not silently
// drop the release behind a wall of near-duplicate rows.
function canonicalEastmoneyTitle(title) {
  const t = String(title || '');
  if (/^美国.*CPI/i.test(t)) return '美国 · CPI · Consumer Price Index';
  if (/^美国.*PPI/i.test(t)) return '美国 · PPI · Producer Price Index';
  if (/^美国.*非农/i.test(t)) return '美国 · 非农就业 · Nonfarm Payrolls';
  if (/^美国.*核心PCE|美国.*PCE/i.test(t)) return '美国 · 核心PCE · Personal Consumption Expenditures';
  if (/^中国.*CPI/i.test(t)) return '中国 · CPI · 消费者价格指数';
  if (/^中国.*PPI/i.test(t)) return '中国 · PPI · 生产者价格指数';
  if (/^欧元区.*CPI/i.test(t)) return '欧元区 · CPI · Harmonised Index of Consumer Prices';
  if (/^英国.*CPI/i.test(t)) return '英国 · CPI · Consumer Price Index';
  if (/^加拿大.*CPI/i.test(t)) return '加拿大 · CPI · Consumer Price Index';
  return title;
}
// The source tags conferences and forums as "important" (STD_TYPE_CODE 1), which
// is noise for a BTC risk calendar. Re-rank by macro relevance so the high-impact
// filter and the risk callout surface actual data releases and central-bank moves.
function eastmoneyImportance(title) {
  const t = String(title || '');
  if (/cpi|消费者价格|非农|失业率|初请|就业人口|就业|pce|gdp|零售销售|利率决议|货币政策|美联储|联储|欧央行|央行|通胀|核心|物价指数|议息|降息|加息/i.test(t)) return 'high';
  if (/贸易帐|pmi|工业产出|新屋|营建|耐用品|消费者信心|收支|进出口|原油库存|api|eia|国债|收益率|制造业|服务业|景气|外储|外匯|m[012]|m[12]供应|社融|信贷/i.test(t)) return 'medium';
  return 'low';
}
async function eastmoneyCalendarEvents(now) {
  const fmt = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
  const start = new Date(now - 7 * 86_400_000), end = new Date(now + 45 * 86_400_000);
  const filter = `(END_DATE>='${fmt(start)}')(START_DATE<'${fmt(end)}')`;
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_CPH_FECALENDAR&columns=ALL&pageSize=300&sortColumns=START_DATE&sortTypes=1&source=WEB&client=WEB&filter=${encodeURIComponent(filter)}`;
  const payload = await request(url, 9_000, { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' });
  const rows = (payload && payload.result && payload.result.data) || [];
  return rows.filter(row => row && row.START_DATE && row.FE_NAME).map((row, index) => {
    const at = parseShanghaiDateTime(row.START_DATE);
    if (!Number.isFinite(at) || at < now - 5 * 86_400_000) return null;
    const title = canonicalEastmoneyTitle(cleanEastmoneyTitle(row.FE_NAME));
    const importance = eastmoneyImportance(title);
    const titleCountry = inferCountryFromTitle(title);
    return {
      id:`em-${row.FE_CODE || at}-${index}`, at, country:titleCountry !== 'GLOBAL' ? titleCountry : normalizeEastmoneyCountry(row.CITY),
      category:'macro',
      title, importance, actual:null, estimate:null, previous:null,
      source:'东方财富 数据研究中心',
      directional:'发布前后关注实际值相对市场预期的偏差；数据本身不构成 BTC 方向信号，结合美元、实际利率与风险偏好综合判断',
    };
  }).filter(Boolean).sort((a,b) => a.at - b.at);
}
function normalizeTvCountry(code) {
  const map = { GB:'UK', UK:'UK', EU:'EU', US:'US', CN:'CN', JP:'JP', DE:'DE', FR:'FR', CA:'CA', AU:'AU', KR:'KR', IN:'IN', RU:'RU', CH:'CH', IT:'IT', ES:'ES', MX:'MX', TR:'TR', ZA:'ZA', NZ:'NZ', SG:'SG', HK:'HK', TW:'TW', BR:'BR' };
  const c = String(code || '').toUpperCase();
  return map[c] || (c.length <= 4 ? c : 'GLOBAL');
}
// A shared keyword signature lets us de-duplicate the same macro release across
// the domestic feed and the supplementary global feeds (TradingView / FinanceCalendar),
// even when their titles differ in language or wording.
const MACRO_KEYWORDS = [
  ['cpi', /cpi|消费者价格|通胀|物价指数|物价|consumer price index|retail price index/i],
  ['ppi', /ppi|生产者价格|生产者物价|producer price index/i],
  ['nfp', /nonfarm|non-farm|payroll|非农|就业人口|employment situation|就业/i],
  ['gdp', /gdp|国内生产总值|gross domestic product/i],
  ['pce', /pce|personal consumption expenditures/i],
  ['retail', /retail|零售/i],
  ['fomc', /fomc|利率决议|rate decision|policy rate|货币政策|interest rate|议息/i],
  ['trade', /trade balance|贸易帐|贸易/i],
  ['pmi', /pmi|制造业|服务业景气|商业活动/i],
  ['jobs', /jobless|初请|失业|claims|失业率/i],
  ['housing', /housing|新屋|营建|房屋|hpi|房价|楼/i],
];
function macroKeyword(title) {
  const t = String(title || '');
  for (const [k, re] of MACRO_KEYWORDS) if (re.test(t)) return k;
  return '';
}
function macroSig(event) {
  const at = Number(event.at);
  if (!Number.isFinite(at)) return '';
  const kw = macroKeyword(event.title);
  if (!kw) return '';
  const day = new Date(at).toISOString().slice(0, 10);
  return `${String(event.country || 'GLOBAL').toUpperCase()}|${kw}|${day}`;
}
function inferCountryFromTitle(title) {
  const t = String(title || '');
  if (/美国|U\.?S\.?(\s|$)|federal reserve|fomc|wall street/i.test(t)) return 'US';
  if (/ecb|欧元区|eurozone|euro area|欧洲央行/i.test(t)) return 'EU';
  if (/英国|U\.?K\.?(\s|$)|bank of england|boe/i.test(t)) return 'UK';
  if (/中国|china|pboc|人民银行/i.test(t)) return 'CN';
  if (/日本|japan|boj|日银/i.test(t)) return 'JP';
  if (/德国|germany|buba/i.test(t)) return 'DE';
  if (/加拿大|canada/i.test(t)) return 'CA';
  if (/澳洲|australia|rba/i.test(t)) return 'AU';
  return 'GLOBAL';
}
// TradingView's public economic-calendar endpoint is key-free and returns actual /
// forecast / previous values the domestic feed lacks. We use it to enrich the
// domestic macro rows and to surface genuinely new high-impact releases.
async function tradingViewEvents(now) {
  const from = new Date(now - 7 * 86_400_000).toISOString();
  const to = new Date(now + 30 * 86_400_000).toISOString();
  const url = `https://economic-calendar.tradingview.com/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&countries=`;
  const payload = await request(url, 12_000, { 'user-agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', 'origin':'https://www.tradingview.com' });
  const rows = (payload && payload.result) || [];
  return rows.filter(r => r && r.date && r.importance !== -1).map((r, index) => {
    const at = Date.parse(r.date);
    if (!Number.isFinite(at) || at < now - 10 * 86_400_000 || at > now + 45 * 86_400_000) return null;
    const title = String(r.title || '').trim();
    return {
      id:`tv-${r.id || at}-${index}`, at, country:normalizeTvCountry(r.country), category:'macro',
      title, importance:eastmoneyImportance(title),
      actual: r.actual != null && r.actual !== '' ? String(r.actual) : null,
      estimate: r.forecast != null && r.forecast !== '' ? String(r.forecast) : null,
      previous: r.previous != null && r.previous !== '' ? String(r.previous) : null,
      source:'TradingView 经济日历',
      directional:'TradingView 全球宏观事件；关注实际值相对预期的偏差，结合美元、实际利率与风险偏好，不单独构成 BTC 方向信号',
    };
  }).filter(Boolean);
}
async function financeCalendarEvents(now) {
  const from = new Date(now - 1 * 86_400_000).toISOString().slice(0, 10);
  const to = new Date(now + 45 * 86_400_000).toISOString().slice(0, 10);
  const url = `https://www.financecalendar.com/wp-json/fc/v1/calendar?from=${from}&to=${to}&impact=high,medium,low&limit=200`;
  const payload = await request(url, 10_000, { 'user-agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' });
  const rows = (payload && payload.events) || [];
  return rows.map((r, index) => {
    const at = Date.parse(r.time_utc || r.date);
    if (!Number.isFinite(at) || at < now - 10 * 86_400_000 || at > now + 45 * 86_400_000) return null;
    const title = String(r.title || r.name || '').trim();
    const imp = String(r.impact || '').toLowerCase() === 'high' ? 'high' : String(r.impact || '').toLowerCase() === 'medium' ? 'medium' : 'low';
    return {
      id:`fc-${r.url || at}-${index}`, at, country:inferCountryFromTitle(title), category:'macro',
      title, importance:imp,
      actual: r.actual != null && r.actual !== '' ? String(r.actual) : null,
      estimate: r.consensus != null && r.consensus !== '' ? String(r.consensus) : null,
      previous: r.prior != null && r.prior !== '' ? String(r.prior) : null,
      source:'FinanceCalendar',
      directional:'FinanceCalendar 整理的央行决议与关键宏观发布；关注实际值与市场共识的偏差',
    };
  }).filter(Boolean);
}
async function investmentCalendar({ refresh = false } = {}) {
  const key = 'investment-calendar', hit = cache.get(key), now = Date.now();
  if (!refresh && hit && now - hit.time < INVESTMENT_CALENDAR_TTL) return cacheResult(hit, now);
  return coalesce(key, async () => {
    const official = await fedCalendar();
    const officialEvents = (official.events || []).map(event => ({
      id:`official-${event.key}-${event.at}`, at:event.at, country:'US', category:'macro',
      key:event.key, title:event.name, importance:'high', actual:event.actual?.value || null, estimate:null, previous:null,
      source:event.source, fallback:Boolean(event.fallback),
      directional:'发布前后波动可能放大；等待实际值与预期的偏差确认',
    }));
    const requests = [
      request('https://mempool.space/api/v1/difficulty-adjustment', 8_000),
      requestText('https://www.bls.gov/schedule/news_release/bls.ics', 8_000),
      treasuryCalendarEvents(now),
      requestText('https://www.eia.gov/petroleum/supply/weekly/schedule.php', 8_000),
      EIA_API_KEY ? request(`https://api.eia.gov/v2/petroleum/pri/spt/data/?api_key=${encodeURIComponent(EIA_API_KEY)}&frequency=weekly&data[0]=value&length=1`,8_000) : Promise.resolve(null),
      request('https://www.deribit.com/api/v2/public/get_instruments?currency=BTC&kind=option&expired=false', 8_000),
      eastmoneyCalendarEvents(now),
      tradingViewEvents(now),
      financeCalendarEvents(now),
    ];
    const [difficulty, blsIcs, treasury, eia, eiaActual, deribit, eastmoney, tradingView, financecal] = await Promise.allSettled(requests);
    const chainEvents = [];
    if (difficulty.status === 'fulfilled') {
      const raw = difficulty.value || {}, at = Number(raw.estimatedRetargetDate);
      if (Number.isFinite(at) && at > now - 24 * 3_600_000) chainEvents.push({
        id:`difficulty-${at}`, at, country:'BTC', category:'chain', title:'BTC 挖矿难度调整', importance:'medium',
        actual:null, estimate:Number.isFinite(Number(raw.difficultyChange)) ? `${Number(raw.difficultyChange).toFixed(2)}%` : null,
        previous:null, source:'mempool.space', directional:'链上供给节奏事件；不单独构成方向信号',
      });
    }
    const macroEvents=blsIcs.status === 'fulfilled' ? blsMacroEvents(blsIcs.value, now) : [];
    const liquidityEvents=treasury.status === 'fulfilled' ? treasury.value : [];
    const policyEvents=treasuryLongEndBuybackPolicyEvent(now);
    const energyEvent=eia.status === 'fulfilled' ? eiaNextReleaseEvent(eia.value, now) : null;
    const eiaRow=eiaActual.status === 'fulfilled' ? (eiaActual.value?.response?.data?.[0] || eiaActual.value?.data?.[0]) : null;
    if(energyEvent && eiaRow?.value !== undefined && eiaRow?.value !== null) { energyEvent.actual=String(eiaRow.value); energyEvent.source='U.S. Energy Information Administration · API Key'; }
    const energyEvents=[energyEvent].filter(Boolean);
    const derivativesEvents=deribit.status === 'fulfilled' ? deribitExpiryEvents(deribit.value, now) : [];
    const cotAt=nextWeekdayAt(now, 5, '15:30');
    const positioningEvents=[{ id:`cftc-cot-${cotAt}`, at:cotAt, country:'GLOBAL', category:'risk', title:'CFTC COT · 黄金/WTI 持仓', importance:'low', actual:null, estimate:null, previous:null,
      source:'U.S. Commodity Futures Trading Commission · publication cadence', directional:'周度持仓用于识别拥挤与跨资产风险偏好，发布滞后于持仓截点，不能作为即时信号' }];

    // The domestic Eastmoney feed is the comprehensive, key-free primary source.
    // Official US Fed/BLS events are merged only to attach released values and,
    // when the domestic feed is unavailable, as a full fallback.
    const domesticEvents = eastmoney.status === 'fulfilled' ? (eastmoney.value || []) : [];
    // Some broad calendars publish the first day of a two-day FOMC meeting,
    // while the market-moving rate decision is on the final day. Prefer the
    // Fed's official decision timestamp and canonical title when the dates are
    // close enough to describe the same meeting.
    const officialFomc = officialEvents.find(event => event.key === 'fomc');
    if (officialFomc) {
      for (const event of domesticEvents) {
        if (macroKeyword(event.title) !== 'fomc' || Math.abs(event.at - officialFomc.at) > 48 * 3_600_000) continue;
        event.at = officialFomc.at;
        event.country = 'US';
        event.title = '美国 · FOMC 利率决议';
        if (!event.source.includes(officialFomc.source)) event.source = `${event.source} · ${officialFomc.source}`;
      }
    }
    const domesticAvailable = domesticEvents.length > 0;
    const macroKeywordRe = /cpi|非农|就业|失业率|pce|gdp|零售|利率|fomc|fed|物价|通胀|央行/i;

    // Supplementary global feeds (TradingView, FinanceCalendar) are key-free and
    // add actual / forecast / previous values the domestic feed lacks, plus a few
    // releases the domestic feed does not carry. De-duplicate by macro signature.
    const supplement = [
      ...(tradingView.status === 'fulfilled' ? (tradingView.value || []) : []),
      ...(financecal.status === 'fulfilled' ? (financecal.value || []) : []),
    ];
    const domesticSigs = new Set(domesticEvents.map(macroSig).filter(Boolean));
    for (const ev of domesticEvents) {
      const sig = macroSig(ev);
      if (!sig) continue;
      const match = supplement.find(s => macroSig(s) === sig);
      if (!match) continue;
      const had = ev.actual ?? ev.estimate ?? ev.previous;
      ev.actual = ev.actual ?? match.actual ?? null;
      ev.estimate = ev.estimate ?? match.estimate ?? null;
      ev.previous = ev.previous ?? match.previous ?? null;
      if (!had && (ev.actual ?? ev.estimate ?? ev.previous) && !ev.source.includes(match.source)) {
        ev.source = `${ev.source} · ${match.source}`;
      }
    }
    const newSupplement = [];
    for (const s of supplement) {
      const sig = macroSig(s);
      if (!sig) continue;
      if (domesticSigs.has(sig)) continue;
      if (s.importance !== 'high' && s.importance !== 'medium') continue;
      domesticSigs.add(sig);
      newSupplement.push(s);
    }

    const merged = [];
    const usedOfficial = new Set();
    if (domesticEvents.length) {
      for (const ev of domesticEvents) {
        const idx = officialEvents.findIndex((o, i) => !usedOfficial.has(i) && Math.abs(o.at - ev.at) < 12 * 3_600_000 && macroKeywordRe.test(`${o.title} ${ev.title}`));
        if (idx >= 0) {
          usedOfficial.add(idx);
          ev.actual = ev.actual ?? officialEvents[idx].actual;
          ev.estimate = ev.estimate ?? officialEvents[idx].estimate;
          ev.previous = ev.previous ?? officialEvents[idx].previous;
        }
        merged.push(ev);
      }
    }
    const extraOfficial = domesticEvents.length
      ? officialEvents.filter((o, i) => !usedOfficial.has(i) && !merged.some(row => Math.abs(row.at - o.at) < 18 * 3_600_000 && macroKeywordRe.test(`${row.title} ${o.title}`)))
      : officialEvents;
    const events = [...merged, ...extraOfficial, ...newSupplement, ...macroEvents, ...policyEvents, ...liquidityEvents, ...energyEvents, ...positioningEvents, ...chainEvents, ...derivativesEvents]
      .filter((event, index, rows) => !rows.slice(0,index).some(row =>
        (Math.abs(row.at-event.at) < 3_600_000 && row.category===event.category && (row.title===event.title || (event.category==='macro' && row.source===event.source)))
        || (event.category==='macro' && row.category==='macro' && macroSig(row) && macroSig(row)===macroSig(event))))
      // Keep a short history window so the client's 昨天 / 本周 views have data,
      // then order strictly by wall clock (the client groups rows by Beijing day
      // and sorts ascending, so a plain ascending sort is what it needs).
      .filter((event) => Number(event.at) >= now - 4 * 86_400_000)
      .sort((a, b) => a.at - b.at)
      // Some official calendars list the same macro release at a placeholder time
      // (e.g. midnight) while the domestic feed has the exact Beijing time. After
      // sorting, drop later duplicates that share country + keyword + Beijing day.
      .filter((event, index, rows) => {
        if (event.category !== "macro") return true;
        const sig = `${event.country || "GLOBAL"}|${macroKeyword(event.title)}|${new Date(event.at + 8 * 3_600_000).toISOString().slice(0, 10)}`;
        return !(sig.includes("|") && !sig.endsWith("|") && rows.slice(0, index).some(row => row.category === "macro" && `${row.country || "GLOBAL"}|${macroKeyword(row.title)}|${new Date(row.at + 8 * 3_600_000).toISOString().slice(0, 10)}` === sig));
      })
      .slice(0, 360);
    const result = { events, fetchedAt:now, refreshMs:INVESTMENT_CALENDAR_TTL, cached:false,
      provider:{ domesticSource:'东方财富 数据研究中心', domesticAvailable, officialSources:official.sources || [], treasuryAvailable:treasury.status === 'fulfilled', energyAvailable:eia.status === 'fulfilled', eiaKeyAvailable:Boolean(EIA_API_KEY) && eiaActual.status === 'fulfilled', derivativesAvailable:deribit.status === 'fulfilled', chainAvailable:difficulty.status === 'fulfilled', finnhubConfigured:false, tradingViewAvailable:tradingView.status === 'fulfilled', financeCalendarAvailable:financecal.status === 'fulfilled' },
      disclaimer:'日历用于识别风险窗口与宏观驱动，不构成投资建议。国内宏观事件由东方财富免费公开接口提供（北京时间），覆盖全球主要经济体数据发布、央行决议与重要会议；TradingView 与 FinanceCalendar 作为全球宏观补充源，回填实际值／预期／前值并补充个别未覆盖的发布；美联储／BLS 官方日程作为补充并回填已公布数值。财政部日程为暂定表，操作规模以当日官方公告为准；所有时间均以 UTC 保存，界面默认显示北京时间，也可切换 UTC/美东。' };
    remember(key, result); return result;
  });
}
async function binanceHistory(interval, limit = 1000) {
  const rows = await request(`https://api.binance.com/api/v3/klines?symbol=${binanceId()}&interval=${interval}&limit=${limit}`, 8_000);
  const candles = rows.map(c => ({ time:+c[0], open:+c[1], high:+c[2], low:+c[3], close:+c[4], volume:+c[5] })).filter(validCandle);
  if (candles.length < 300) throw new Error('insufficient historical candles');
  return candles;
}
async function gateHistory(interval, limit = 1000) {
  const rows = await request(`https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${gateId()}&interval=${interval}&limit=${limit}`, 8_000);
  const candles = rows.map(c => ({ time:+c.t*1000, open:+c.o, high:+c.h, low:+c.l, close:+c.c, volume:+c.v })).filter(validCandle).sort((a,b) => a.time - b.time);
  if (candles.length < 300) throw new Error('insufficient historical candles');
  return candles;
}
async function coinbaseHistory(interval, limit = 1000) {
  const granularity = interval === '15m' ? 900 : interval === '1d' ? 86400 : 0;
  if (!granularity) throw new Error(`unsupported interval ${interval}`);
  const byTime = new Map();
  let end = Date.now();
  for (let page = 0; page < Math.ceil(limit / 290) + 1 && byTime.size < limit; page++) {
    const start = end - granularity * 290 * 1000;
    const params = new URLSearchParams({ granularity:String(granularity), start:new Date(start).toISOString(), end:new Date(end).toISOString() });
    const rows = await request(`https://api.exchange.coinbase.com/products/${normalizeCoin(currentCoin())}-USD/candles?${params}`, 8_000);
    if (!Array.isArray(rows) || !rows.length) break;
    for (const c of rows) {
      const candle = { time:+c[0]*1000, low:+c[1], high:+c[2], open:+c[3], close:+c[4], volume:+c[5] };
      if (validCandle(candle)) byTime.set(candle.time, candle);
    }
    end = start - granularity * 1000;
  }
  const candles = [...byTime.values()].sort((a,b) => a.time - b.time).slice(-limit);
  if (candles.length < 300) throw new Error('insufficient historical candles');
  return candles;
}
const FORECAST_INTERVAL_MS = { '5m':300_000, '15m':900_000, '30m':1_800_000, '1h':3_600_000, '2h':7_200_000, '4h':14_400_000, '1d':86_400_000 };
function forecastIntervalMs(interval) { return FORECAST_INTERVAL_MS[interval] || 900_000; }
// A cached history is only reusable while its last bar is still current.  Row count
// alone is not a freshness test: the daily series once held more than 900 rows while
// silently frozen three weeks in the past, which starved every daily-horizon forecast.
// 缓存历史只有在最后一根 K 线仍然新鲜时才可复用；条数不能当新鲜度判据 —— 日线曾在上千条的情况下静默停在三周前，导致所有日线周期预测失去数据源。
function historyIsFresh(candles, interval, now = Date.now()) {
  const last = Number(candles.at(-1)?.time || 0);
  return candles.length > 0 && last > 0 && now - last <= forecastIntervalMs(interval) * 2;
}
async function forecastHistory(interval) {
  const failures = [], now = Date.now();
  let staleFallback = null;
  for (const [source, loader] of [['coinbase', coinbaseHistory], ['gate', gateHistory], ['binance', binanceHistory]]) {
    const stored = storedCandles(source, interval, 1000);
    if (stored.length >= 900) {
      if (historyIsFresh(stored, interval, now)) return { candles:stored, source, cached:true, storage:'sqlite' };
      // Keep the frozen series usable when every upstream fails, but never present it as current.
      // 上游全部失败时仍保留这份冻结序列，但绝不把它伪装成最新数据。
      if (!staleFallback) staleFallback = { candles:stored, source, cached:true, storage:'sqlite', stale:true, staleReason:'last bar is older than two intervals' };
    }
    try {
      const candles = await loader(interval);
      persistHistory(source, interval, candles);
      return { candles, source, cached:false, storage:'upstream' };
    }
    catch (e) { failures.push(`${source}: ${e.name === 'AbortError' ? 'timeout' : e.message}`); }
  }
  if (staleFallback) return staleFallback;
  throw new Error(failures.join('; '));
}
// 公开新闻只用于给历史价格模型增加有限的环境权重；标题情绪不是事实核验，也不能单独产生交易结论。
// Public headlines only add a limited context weight to the price-history model. Headline sentiment is not fact verification and never produces a trading call by itself.
const newsBullTerms=['etf approval','etf inflow','institutional buy','accumulation','adoption','partnership','bullish','rally','surge','surging','rises','buying','purchases','all-time high','rate cut','regulatory clarity','approval','inflow','买入','增持','采用','合作','利好','上涨','反弹','降息','获批','流入'];
const newsBearTerms=['etf outflow','hack','exploit','breach','lawsuit','ban','crackdown','liquidation','sell-off','selloff','plunge','weakness','outflow','rate hike','fraud','scam','hacked','调查','禁令','监管打击','黑客','漏洞','清算','抛售','下跌','利空','加息','流出','诉讼'];
function newsSentimentScore(title) {
  const normalized=String(title || '').toLowerCase();
  const count=terms => terms.reduce((total, term) => total + (normalized.includes(term) ? 1 : 0), 0);
  const bull=count(newsBullTerms), bear=count(newsBearTerms);
  return clamp((bull-bear)/3,-1,1);
}
function decodeXml(text) { return String(text || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code))).trim(); }
function xmlField(block, tag) { const matched=String(block).match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i')); return matched ? decodeXml(matched[1]).replace(/<[^>]+>/g, '').trim() : ''; }
function normalizedHeadline(title) { return String(title || '').toLowerCase().replace(/\s+[|–—-]\s+[^|–—-]{2,}$/,'').replace(/[^a-z0-9\u4e00-\u9fff]+/g,' ').trim(); }
function headlineSimilarity(a,b) { const left=new Set(normalizedHeadline(a).split(/\s+/).filter(Boolean)), right=new Set(normalizedHeadline(b).split(/\s+/).filter(Boolean)); const union=new Set([...left,...right]).size, overlap=[...left].filter(word=>right.has(word)).length; return union ? overlap/union : 0; }
function classifyNewsEvent(title) { const value=String(title || '').toLowerCase(); if(/etf|inflow|outflow|blackrock|fidelity/.test(value))return 'etf-flow';if(/hack|exploit|breach|scam|fraud|bankrupt/.test(value))return 'security';if(/regulat|sec |lawsuit|ban|approval/.test(value))return 'regulation';if(/whale|wallet|transfer|holder/.test(value))return 'whale-flow';if(/cpi|fomc|rate |fed |inflation/.test(value))return 'macro';return 'market'; }
function sourceWeight(source) { const value=String(source || '').toLowerCase(); if(/reuters|bloomberg|financial times|wall street journal/.test(value))return 1.35;if(/coindesk|the block|cointelegraph/.test(value))return 1.1;if(/yahoo finance|cnbc/.test(value))return .9;if(/motley fool|benzinga/.test(value))return .75;if(/stocktwits|reddit|x\.com|twitter/.test(value))return .5;return .7; }
function eventWeight(category) { return ({'etf-flow':1.3,security:1.25,regulation:1.15,'whale-flow':.8,macro:1.05,market:.7})[category] || .7; }
function parseBitcoinNews(xml) {
  const items=[];
  for (const matched of String(xml).matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block=matched[1], title=xmlField(block, 'title');
    if (!title || items.some(item=>headlineSimilarity(item.title,title)>=.72)) continue;
    const publishedAt=Date.parse(xmlField(block, 'pubDate'));
    const source=xmlField(block, 'source') || 'Google News', category=classifyNewsEvent(title);
    items.push({ title, url:xmlField(block, 'link'), source, publishedAt:Number.isFinite(publishedAt) ? publishedAt : null, sentiment:newsSentimentScore(title), category, sourceWeight:sourceWeight(source), eventWeight:eventWeight(category) });
    if (items.length >= 24) break;
  }
  return items;
}
function storedBitcoinNews(now = Date.now()) {
  const rows=stmt('SELECT title, url, source, published_at AS publishedAt, sentiment FROM btc_news_snapshots WHERE observed_at >= ? ORDER BY COALESCE(published_at, observed_at) DESC LIMIT 24').all(now - 24 * 86_400_000);
  return rows.map(row => { const title=String(row.title), source=row.source || 'SQLite', category=classifyNewsEvent(title); return { title, url:row.url || '', source, publishedAt:Number(row.publishedAt) || null, sentiment:Number(row.sentiment) || 0, category, sourceWeight:sourceWeight(source), eventWeight:eventWeight(category) }; });
}
async function bitcoinNews({ refresh = false } = {}) {
  const key=coinKey('btc-news'), hit=cache.get(key), now=Date.now();
  if (!refresh && hit && now-hit.time<NEWS_TTL) return { ...cacheResult(hit, now), stale:false };
  const stored=storedBitcoinNews(now);
  try {
    return await coalesce(key, async () => {
      const xml=await requestText('https://news.google.com/rss/search?q=Bitcoin%20when%3A1d&hl=en-US&gl=US&ceid=US:en', 8_000);
      const items=parseBitcoinNews(xml);
      if (!items.length) throw new Error('no Bitcoin news headlines found');
      persistNewsSnapshots(items, now);
      const result={ items, fetchedAt:now, refreshMs:NEWS_TTL, source:'Google News RSS', cached:false, cacheAgeMs:0 };
      remember(key,result); return result;
    });
  } catch (error) {
    if (hit && now-hit.time<=3_600_000) return { ...cacheResult(hit, now), stale:true, fallbackReason:error.message };
    if (stored.length) return { items:stored, fetchedAt:now, refreshMs:NEWS_TTL, source:'SQLite news snapshots', cached:true, stale:true, cacheAgeMs:null, fallbackReason:error.message };
    throw error;
  }
}
// ---- Research tuning: single source of truth for every threshold and weight ----
// The research module grades itself against a swarm of constants (the chop band multiple,
// the independent-sample gate, the cost model, the blend weights). Spread across a dozen
// functions they are impossible to review together and impossible to vary per experiment.
// This block is the only place those numbers live. Anything that reads a research threshold
// reads it from here.
//
// Overrides are environment-only, so a running service can never be reconfigured by a client
// request and silently change what a replay means. Set BTC_RESEARCH_TUNING to a JSON object
// shaped like this block; it is deep-merged over the defaults and every override is reported
// back through /api/research-tuning along with a fingerprint that identifies the exact
// configuration a result was produced under.
//
// 研究模块靠一堆常数给自己打分（震荡带倍数、独立样本门槛、成本模型、融合权重）。散在十几个函数里
// 既无法一起审查，也无法按实验调整。这个块是这些数字的唯一所在地，凡读取研究门槛的地方都从这里读。
//
// 覆盖只能走环境变量，运行中的服务绝不会被客户端请求改配置、从而悄悄改变一次回放的含义。
// 把 BTC_RESEARCH_TUNING 设成与本块同形的 JSON 对象即可，它会深合并到默认值之上；
// 每个覆盖项都会通过 /api/research-tuning 回报，并附一个指纹，标明某份结果是在哪套配置下产出的。
// Flatten to leaf paths so a diff can name exactly which numbers a run used.
// 展平成叶子路径，这样 diff 能准确指出一次运行用了哪些数字。
function flattenTuning(value, prefix = '', out = {}) {
  for (const [key, item] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (item && typeof item === 'object' && !Array.isArray(item)) flattenTuning(item, path, out);
    else out[path] = item;
  }
  return out;
}
// A stable, short fingerprint of the effective configuration. Two results may only be compared
// when they carry the same fingerprint; a mismatch means they were not run under equal rules.
// 生效配置的稳定短指纹。只有指纹相同的结果才可互相比较；不一致说明它们不是在同一套规则下跑出来的。
function tuningFingerprint() {
  const flat = flattenTuning(RESEARCH_TUNING), text = Object.keys(flat).sort().map(key => `${key}=${JSON.stringify(flat[key])}`).join('|');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
function researchTuningReport() {
  const effective = flattenTuning(RESEARCH_TUNING), defaults = flattenTuning(RESEARCH_TUNING_DEFAULTS);
  const overrides = Object.keys(effective).filter(key => JSON.stringify(effective[key]) !== JSON.stringify(defaults[key]))
    .map(key => ({ path: key, value: effective[key], default: defaults[key] }));
  return { defaults, effective, overrides, overrideCount: overrides.length, fingerprint: tuningFingerprint(),
    windowVersion: RESEARCH_WINDOW_VERSION, error: RESEARCH_TUNING_ERROR,
    source: RESEARCH_TUNING_OVERRIDE.patch ? 'env:BTC_RESEARCH_TUNING' : 'built-in defaults' };
}
// One chop band, one definition, four call sites: the analogue pool, the trainer's labels, the
// replay's fallback band, and the storage re-grade. If these ever disagree a settled row is graded
// against two different thresholds depending on which path touched it last.
// 一个震荡带、一处定义、四个调用点：近邻池、训练器标签、回放兜底带、库存重评分。它们一旦不一致，
// 同一条已结算的行会因最后被哪条路径碰到而用两套不同阈值评分。
// One horizon table, generated from configuration, so the live path, the replay, the ablation and
// the candidate trainer can never drift apart on what "4h" means. Callers supply only the candles.
// 一张周期表，由配置生成，使实时路径、回放、消融、候选训练四者对「4h 是什么」永远不会漂移。
// 调用方只提供 K 线。
function researchHorizonDefinitions(candlesByInterval) {
  return Object.entries(RESEARCH_TUNING.horizons).map(([key, config]) => ({
    key, label: config.label, horizon: config.horizon, interval: config.interval,
    cap: config.cap, minDirectional: config.minDirectional,
    barMs: forecastIntervalMs(config.interval), candles: candlesByInterval[config.interval],
  }));
}
function historicalProjection(candles, horizon) {
  const closes=candles.map(candle => +candle.close).filter(value => Number.isFinite(value) && value > 0), end=closes.length-1;
  if (end < Math.max(80, horizon + 30)) throw new Error('insufficient price-history samples');
  const analogueCfg=RESEARCH_TUNING.analogue, distanceWeights=analogueCfg.distance, featureWindow=RESEARCH_TUNING.theta.lookback;
  const featureAt=index => { const volatility=closes.slice(Math.max(1,index-featureWindow),index+1).reduce((total,value,offset,rows) => offset ? total + Math.abs(value / rows[offset-1] - 1) : total,0)/featureWindow, trend=percentChange(closes,index,Math.max(20,horizon*4)); return { short:percentChange(closes,index,Math.max(2,Math.round(horizon/2))), medium:percentChange(closes,index,Math.max(6,horizon*2)), volatility, trend, regime:trend>.015?'bull':trend<-.015?'bear':'range' }; };
  const target=featureAt(end), candidates=[];
  for (let index=30;index<=end-horizon;index++) {
    const row=featureAt(index), distance=Math.abs(row.short-target.short)*distanceWeights.short + Math.abs(row.medium-target.medium)*distanceWeights.medium + Math.abs(row.volatility-target.volatility)*distanceWeights.volatility + Math.abs(row.trend-target.trend)*distanceWeights.trend;
    candidates.push({ distance, change:closes[index+horizon]/closes[index]-1, regime:row.regime });
  }
  const sameRegime=candidates.filter(row=>row.regime===target.regime), pool=sameRegime.length>=analogueCfg.regimeMinPool?sameRegime:candidates;
  const sorted=[...pool].sort((a,b)=>a.distance-b.distance), scale=Math.max(.001,sorted[Math.floor(sorted.length*analogueCfg.scaleQuantile)]?.distance || .01);
  const weighted=pool.map(row=>({...row,weight:Math.exp(-row.distance/scale)})), weightTotal=weighted.reduce((sum,row)=>sum+row.weight,0);
  const expected=weighted.reduce((sum,row)=>sum+row.change*row.weight,0)/weightTotal, up=weighted.filter(row=>row.change>0).reduce((sum,row)=>sum+row.weight,0)/weightTotal;
  const normalized=weighted.map(row=>({...row,weight:row.weight/weightTotal})).sort((a,b)=>a.change-b.change), quantile=q=>{let cumulative=0;for(const row of normalized){cumulative+=row.weight;if(cumulative>=q)return row.change}return normalized.at(-1)?.change || 0};
  const effectiveSamples=1/normalized.reduce((sum,row)=>sum+row.weight**2,0), medianDistance=sorted[Math.floor(sorted.length*analogueCfg.medianQuantile)]?.distance || scale;
  // Chop versus direction: one standard deviation of log returns, scaled by the horizon.
  // The band must be identical to the one the trainer and the backfill use, or settled rows
  // would be graded against two different thresholds.
  // 震荡与方向的分界：对数收益的一个标准差按周期缩放。这个带必须与训练器和回填用的完全一致，
  // 否则已结算的行会被两套不同的阈值评分。
  const terminalReturns=[];for(let point=Math.max(1,end-(featureWindow-1));point<=end;point++)terminalReturns.push(Math.log(closes[point]/closes[point-1]));
  const terminalMean=terminalReturns.reduce((sum,value)=>sum+value,0)/Math.max(terminalReturns.length,1);
  const terminalSigma=Math.sqrt(terminalReturns.reduce((sum,value)=>sum+(value-terminalMean)**2,0)/Math.max(terminalReturns.length,1))||.000001;
  const theta=chopThreshold(terminalSigma,horizon);
  const classWeight=key=>weighted.filter(row=>{
    if(key==='up')return row.change>theta;
    if(key==='down')return row.change<-theta;
    return Math.abs(row.change)<=theta;
  }).reduce((sum,row)=>sum+row.weight,0)/weightTotal;
  const classProbabilities={ up:classWeight('up'), flat:classWeight('flat'), down:classWeight('down') };
  return { expectedReturn:Number.isFinite(expected) ? expected : 0, upProbability:up, theta, classProbabilities, samples:Math.round(effectiveSamples), candidateCount:pool.length, momentum:target.medium, volatility:target.volatility, regime:target.regime, matchQuality:clamp(Math.exp(-medianDistance/Math.max(scale,.001)),0,1), distribution:{p10:quantile(analogueCfg.quantiles.p10),p50:quantile(analogueCfg.quantiles.p50),p90:quantile(analogueCfg.quantiles.p90)} };
}
// A forecast must be anchored to a bar that has already closed.  Pricing it off the
// still-forming bar spends future information and shifts every bucket by one interval.
// 预测必须锚定已收盘的 K 线；用正在形成的那根等于花费未来信息，并让每个桶整体位移一个周期。
function lastClosedCandle(candles, barMs, now = Date.now()) {
  for (let index = candles.length - 1; index >= 0; index--) {
    const time = Number(candles[index]?.time || 0);
    if (time > 0 && time + barMs <= now) return candles[index];
  }
  return candles.at(-1) || null;
}
function forecastAnchor(candles, barMs, now = Date.now()) {
  const candle = lastClosedCandle(candles, barMs, now);
  const time = Number(candle?.time || 0);
  return { candle, bucketAt: time > 0 ? time : Math.floor(now / barMs) * barMs, close:Number(candle?.close) || 0 };
}
// The anchor bar closes one interval after its own timestamp, so the horizon starts at
// bucketAt + barMs and ends at bucketAt + (horizon + 1) * barMs.  Using
// bucketAt + horizon * barMs made the realised window one bar short — measured on live rows,
// the 15 minute horizon collapsed to a nominal 0 minutes and settled against a bar that had
// only just opened.  Both the forecast and the settlement must share this definition.
// 锚定 K 线的收盘发生在其时间戳之后一个周期，因此持有期应自 bucketAt + barMs 起算，
// 到 bucketAt + (horizon + 1) * barMs 结算。用 bucketAt + horizon * barMs 会让实际窗口
// 少一整根 K 线——实测 15 分钟周期的名义持有塌缩为 0，且拿刚开盘那根当结算价。
// 预测与结算必须共用这一个定义。
function horizonTargetAt(bucketAt, horizon, barMs) {
  return Number(bucketAt) + (Number(horizon) + 1) * barMs;
}
// Settlement reads the point-in-time price at the target instant: the close of the last bar
// that has fully closed by then.  Matching the first bar *starting* at or after the target
// picked a bar closing one interval later — and, while it was still forming, an intra-bar
// price — so settlement fired immediately on a bar that had barely opened.
// 结算读「结算时刻的时点价格」：在 target_at 之前已收盘的最后一根的收盘价。改为匹配
// 「起点 >= target_at」的第一根，会取到晚一个周期才收盘的 K 线；它尚未收盘时更是残价，
// 于是刚开盘就立刻结算。
function settlementBar(candles, barMs, targetAt) {
  let match = null;
  for (const candle of candles) {
    const time = Number(candle?.time || 0);
    if (time <= 0) continue;
    if (time + barMs <= targetAt) match = candle;
    else break;
  }
  return match;
}
// Three-class verdict: a move only counts as directional once it clears a volatility-scaled
// band.  Anything inside the band is genuine chop, not a small up or a small down.
// 三分类判定：只有越过波动缩放阈值才算有方向；阈值带以内是真正的震荡，不是小幅上涨或下跌。
function outcomeLabel(actualReturn, theta) {
  const move = Number(actualReturn), band = Number(theta);
  if (!Number.isFinite(move)) return null;
  if (!Number.isFinite(band) || band <= 0) return move > 0 ? 'up' : 'down';
  if (Math.abs(move) <= band) return 'flat';
  return move > 0 ? 'up' : 'down';
}
function multiclassBrier(probabilities, label) {
  const keys = ['up', 'flat', 'down'];
  const raw = keys.map(key => Math.max(0, Number(probabilities?.[key]) || 0));
  const total = raw.reduce((sum, value) => sum + value, 0) || 1;
  return raw.reduce((sum, value, index) => sum + (value / total - (label === keys[index] ? 1 : 0)) ** 2, 0);
}
// ---- Shared A/B shadow experiments ---------------------------------------
// 仅保留结算逻辑：历史遗留的 ab_shadow_pairs 未结算行仍按同一真实价格补结算，
// 不再采集任何新实验配对（不建议升级的实验已于 2026-09-19 移除）。
function settleAbExperiments(histories, now=Date.now()) { for(const row of pendingAbShadowPairs.all(now)){const candles=histories[row.candle_interval]||[],target=candles.find(candle=>Number(candle.time)>=Number(row.target_at));if(!target)continue;const settled=Number(target.close), entry=Number(row.entry_price);if(!Number.isFinite(settled)||!entry)continue;const actualReturn=settled/entry-1;settleAbShadowPair.run(now,settled,actualReturn,actualReturn>0?1:0,row.id); } }
function abComparison(experimentKey, minSamples=100) {
  const rows=stmt('SELECT horizon_key AS horizonKey, regime, a_probability AS aProbability, b_probability AS bProbability, actual_return AS actualReturn, is_up AS isUp FROM ab_shadow_pairs WHERE experiment_key=? AND settled_at IS NOT NULL ORDER BY target_at ASC').all(experimentKey).map(row=>({...row,aProbability:Number(row.aProbability),bProbability:Number(row.bProbability),actualReturn:Number(row.actualReturn),isUp:Number(row.isUp)}));
  const horizons=[...new Set(rows.map(row=>row.horizonKey))];
  const perHorizon=Object.fromEntries(horizons.map(key=>{const subset=rows.filter(row=>row.horizonKey===key);return [key,{samples:subset.length,baseline:pairedPredictionMetrics(subset,'aProbability'),candidate:pairedPredictionMetrics(subset,'bProbability')}]}));
  const regimes=Object.fromEntries(['bull','bear','range'].map(key=>{const subset=rows.filter(row=>row.regime===key);return [key,{samples:subset.length,baseline:pairedPredictionMetrics(subset,'aProbability'),candidate:pairedPredictionMetrics(subset,'bProbability')}]}));
  const overall={samples:rows.length,baseline:pairedPredictionMetrics(rows,'aProbability'),candidate:pairedPredictionMetrics(rows,'bProbability')};
  const enough=horizons.length>0&&horizons.every(key=>perHorizon[key].samples>=minSamples)&&Object.values(regimes).filter(row=>row.samples>0).every(row=>row.samples>=minSamples);
  const base=overall.baseline,candidate=overall.candidate;
  const quality=base&&candidate&&candidate.brier<=base.brier*.97&&candidate.logLoss<=base.logLoss*.97;
  const calibration=candidate&&candidate.brierSkill>=0&&candidate.ece<=base.ece*1.05;
  const economics=candidate&&candidate.economic.netReturn>0&&candidate.economic.netReturn>=base.economic.netReturn&&candidate.economic.maxDrawdown>=base.economic.maxDrawdown-0.02;
  const robust=Object.values(regimes).filter(row=>row.samples>=minSamples).every(row=>row.candidate.brier<=row.baseline.brier*.97&&row.candidate.economic.netReturn>0);
  const better=quality&&calibration&&economics&&robust;
  const verdict=!enough?{tone:'yellow',label:'继续影子评估',reason:`每个周期及已覆盖市场状态均需 ${minSamples} 个已结算配对样本。`}:better?{tone:'green',label:'建议人工复核',reason:'候选在严格对照、概率质量、校准、成本后正收益和市场状态稳健性门槛均达标；不会自动切换。'}:{tone:'red',label:'不建议升级',reason:'样本量已达到最低门槛，但候选尚未同时达到正 Brier Skill、成本后正收益与市场状态稳健性要求。'};return {experimentKey,paired:rows.length,minSamples,perHorizon,regimes,overall,criteria:{quality:'Brier 与 Log Loss 均至少优于基线 3%',calibration:'Brier Skill ≥ 0，且 ECE 不恶化超过 5%',economics:'固定 0.08% 往返成本后净收益为正，且不低于基线',robustness:'每个已覆盖市场状态均有足量样本、成本后正收益且 Brier 至少优于基线 3%'},verdict};
}
const abExperimentCatalog=[
  {key:'cross-market',name:'美股联动',kind:'prediction',candidate:'滚动相关、正则化与市场状态过滤',minSamples:30,status:'collecting',note:'等待 BTC、SPY、QQQ 的同步日线快照'},
  {key:'leverage-buffer',name:'强平缓冲',kind:'validation',candidate:'分位数波动与状态自适应缓冲',status:'collecting',note:'按实际触及率验证风险覆盖率，不用方向准确率'},
  {key:'macro-calendar',name:'宏观日历',kind:'validation',candidate:'事件前后波动区间模型',status:'collecting',note:'按波动覆盖率验证，不用涨跌准确率'},
  {key:'data-formulas',name:'图表、周期涨幅、指标明细',kind:'validation',candidate:'数据一致性、缺失率与公式复算',status:'active',note:'描述 / 公式型：不适用方向准确率'}
];
function abExperimentStatus() { return abExperimentCatalog.map(item=>{if(item.status!=='active'||item.kind!=='prediction')return {...item,comparison:null};return {...item,comparison:abComparison(item.key,item.minSamples)};}); }
// Time-ordered lightweight fusion model: price features are trained on earlier rows and validated on later unseen rows.
// 时间顺序轻量融合模型：价格特征仅用较早样本训练、较晚未见样本验证，避免随机切分泄漏。
// Walk-forward replay turns the stored candle history into graded three-class samples instead of
// waiting for the market to hand them over one bucket at a time. Live sampling is rate-limited by
// physics: a daily horizon can only ever produce one independent outcome per day, so a 30-sample
// threshold costs 30 days of wall time. The history already holds ~1000 daily bars, and a replay
// can grade all of them today.
// 历史回放把已存的 K 线历史直接变成已评分的三分类样本，不必再等市场一根一根地交付。实时采样的
// 速率由物理决定 —— 日线周期一天只能产生一个独立结果，30 条门槛就要花 30 天真实时间。历史里已有
// 约 1000 根日线，回放今天就能把它们全部评分。
// No bucket is ever scored by a model that has already seen its own future: each segment trains on
// rows fully realised at the cut, and only then predicts the buckets that follow it.
// 任何桶都不会被「已经看过它未来」的模型评分：每段只用在 cut 处已完全结算的行训练，之后才预测它
// 后面的桶。
// An escape hatch for verification only: with this set, each arm recomputes the analogue projection
// it would otherwise share. Keeping it makes the equivalence of the shared-cache refactor testable
// on demand - both settings must produce byte-identical payloads - instead of resting on an argument.
// 仅供验证的逃生开关：打开后每个臂会重新计算本来共享的近邻投影。留着它，是为了让「共享缓存」这次
// 重构的等价性可以随时被检验 —— 两种设置必须产出逐字节相同的载荷 —— 而不是只靠推理断言。
const RESEARCH_ANALOGUE_CACHE_DISABLED = process.env.BTC_RESEARCH_NO_ANALOGUE_CACHE === '1';
// The replay's warm-up is per horizon for the same reason the promotion gate is: the cost of one bar
// is measured in minutes on one tape and in days on another, so a single number either wastes most
// of the daily history or gives the intraday model almost nothing to learn from.
// 回放的预热长度与升级门槛同理，也是按周期配置的：一根 K 线在一种粒度上是几分钟、在另一种上是几天，
// 所以一个单一数字要么浪费掉大部分日线历史，要么让日内模型几乎没有可学的东西。
function replayMinTrain(key) {
  const overrides = RESEARCH_TUNING.replay.perHorizonMinTrain;
  return Number(overrides?.[key]) || RESEARCH_TUNING.replay.minTrain;
}
async function walkForwardBackfill(horizonKey, horizon, interval, candles, options = {}) {
  const barMs = interval === '1d' ? 86_400_000 : 900_000;
  const series = candles.filter(validCandle);
  const replayCfg=RESEARCH_TUNING.replay, minTrain = Math.max(replayCfg.minTrainFloor, Number(options.minTrain) || replayMinTrain(horizonKey)), segmentLength = Math.max(60, Number(options.segmentLength) || replayCfg.segmentLength), maxSamples = Number(options.maxSamples) || replayCfg.maxSamples;
  const mean = values => values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
  const deviation = values => Math.sqrt(mean(values.map(value => (value - mean(values)) ** 2))) || .000001;
  const samples = [];
  let cut = minTrain, segments = 0, skippedSegments = 0, featureWidth = null, volatilityColumns = null, headDiagnostics = null, directionDiagnostics = null;
  while (cut + horizon < series.length && samples.length < maxSamples) {
    const to = Math.min(cut + segmentLength, series.length - 1);
    // The calendar is passed for tagging even when it is not used as a feature: conditional
    // reporting needs the baseline arm to know which samples sat inside an event window, and the
    // only way to compare the two arms on that subset is for both to carry the same tag.
    // 即便日历不被当特征用，也要传进来打标记：条件统计需要基线臂知道哪些样本落在事件窗口内，而要在
    // 那个子集上比较两臂，唯一办法就是两臂带同一个标记。
    const model = await trainFusionModel(series.slice(0, to + 1), horizon, { trainThrough: cut, minDirectional: options.minDirectional, volatilityHead: options.volatilityHead, macroCalendar: options.useCalendarFeatures ? options.macroCalendar : undefined, fundingFeatures: options.useFundingFeatures ? options.fundingFeatures : undefined });
    if (!model || typeof model.predictAt !== 'function') { skippedSegments += 1; cut += segmentLength; continue; }
    segments += 1;
    featureWidth = Number(model.featureWidth) || featureWidth;
    volatilityColumns = Number(model.volatilityHead?.columns) || volatilityColumns;
    // The head's diagnostics describe the instrument, not the treatment, and the instrument is the
    // same object in every segment - so the most recent fit is the honest thing to report. They travel
    // to the payload because "the head over-predicts big moves" is only actionable once you can see
    // whether the level moved between the slices or the head simply shrank toward 0.5.
    // 这个头的诊断描述的是量具而不是被处理的变量，而量具在每一段里都是同一个对象 —— 所以报最近一次
    // 拟合是诚实的。它们要传到载荷里，因为「这个头会高估大动」只有在能看到「到底是切片之间水位移动了、
    // 还是这个头只是朝 0.5 收缩了」之后才是可行动的。
    if (model.volatilityHead) headDiagnostics = { columns: model.volatilityHead.columns, trainSamples: model.volatilityHead.trainSamples,
      calibrationSamples: model.volatilityHead.calibrationSamples, bigSamples: model.volatilityHead.bigSamples,
      bigRate: model.volatilityHead.bigRate, calibrationBigRate: model.volatilityHead.calibrationBigRate,
      rawTrainRate: model.volatilityHead.rawTrainRate, trainPredictedRate: model.volatilityHead.trainPredictedRate,
      calibrationPredictedRate: model.volatilityHead.calibrationPredictedRate };
    if (model.directionDiagnostics) directionDiagnostics = model.directionDiagnostics;
    for (let index = cut + 1; index <= to; index++) {
      const end = index + horizon;
      if (end >= series.length) break;
      // Yielding keeps this single-threaded service responsive: the replay is pure CPU work and
      // would otherwise freeze every other request for its full duration.
      // 让出事件循环，保证单线程服务的响应性：回放是纯 CPU 计算，否则会在整个运行期间冻结其他请求。
      if ((index - cut) % RESEARCH_TUNING.replay.yieldEvery === 0) await new Promise(resolve => setImmediate(resolve));
      const entry = Number(series[index].close), exitPrice = Number(series[end].close);
      if (!Number.isFinite(entry) || !Number.isFinite(exitPrice) || !entry) continue;
      const actualReturn = exitPrice / entry - 1, returns = [];
      for (let point = Math.max(1, index - 19); point <= index; point++) returns.push(Math.log(Number(series[point].close) / Number(series[point - 1].close)));
      const fallbackTheta = chopThreshold(deviation(returns), horizon);
      // The live path takes its chop probability from the analogue pool, not from the price model:
      // the learned model answers "which way, given that it moves at all". A replay that skipped the
      // analogue step could only ever predict up or down, and would score near zero against a tape
      // that is flat most of the time — measured at 12% before this step was reinstated.
      // 实时路径的震荡概率来自近邻池，而不是价格模型：学习模型回答的是「若真动了，往哪边」。回放若
      // 跳过近邻这一步，就只能预测涨或跌，而行情大部分时间在震荡——实测准确率仅 12%。
      // The analogue projection depends only on the candles, the horizon and the bucket - never on
      // the model, and never on which feature block that model was handed. Every ablation arm
      // therefore computes a bit-identical projection for the same bucket, so a caller that runs
      // several arms over one horizon can hand in a single cache and let them share it. The numbers
      // are identical by construction; what disappears is only the repeated O(n^2) work, which is
      // what made a third factor arm cost as much as the first two together.
      // 近邻投影只取决于 K 线、周期与桶，与模型无关，也与该模型拿到的是哪一块特征无关。因此每个消融臂
      // 在同一个桶上算出的投影逐位相同 —— 调用方只要为同一周期传一份缓存，各臂就能共享。数值在构造上
      // 完全相同，消失的只是被重复执行的 O(n²) 计算，而那正是「加第三个因子臂等于再加前两臂成本」的原因。
      let projection = null;
      const cache = RESEARCH_ANALOGUE_CACHE_DISABLED ? null : options.projectionCache;
      if (cache instanceof Map && cache.has(index)) projection = cache.get(index);
      else {
        try { projection = historicalProjection(series.slice(0, index + 1), horizon); } catch (error) { projection = null; }
        if (cache instanceof Map) cache.set(index, projection);
      }
      const learnedProbability = clamp(model.predictAt(index), .000001, .999999);
      const classProbabilities = projection?.classProbabilities || { up: 0, flat: 0, down: 0 };
      const flatProbability = clamp(Number(classProbabilities.flat) || 0, 0, 1);
      const spread = Number(classProbabilities.up) + Number(classProbabilities.down);
      const analogueProbability = spread > 0 ? Number(classProbabilities.up) / spread : learnedProbability;
      const analogueWeight = projection?.regime === 'range' ? .62 : (Number(projection?.volatility) || 0) > .006 ? .42 : .48;
      const baseProbability = analogueWeight * analogueProbability + (1 - analogueWeight) * learnedProbability;
      const directionalProbability = clamp(sigmoid(logit(baseProbability)), .05, .95);
      const directionalMass = clamp(1 - flatProbability, 0, 1);
      const upProbability = clamp(directionalMass * directionalProbability, .02, .95);
      const downProbability = clamp(Math.max(0, directionalMass - upProbability), .02, .95);
      const theta = Number(projection?.theta) || fallbackTheta, label = Math.abs(actualReturn) <= theta ? 'flat' : (actualReturn > 0 ? 'up' : 'down');
      // The funding vector is read unconditionally, not only when the funding arm is active. That
      // keeps the tag identical across arms, which is the only way the factor can be evaluated on
      // the same subset of buckets it would be compared on.
      // 资金费率向量无条件读取，而不是只在资金费率臂激活时读。这样标记在各臂之间完全一致 —— 只有
      // 这样，因子才能在「它将被比较的那同一批桶」上被评估。
      const bucketAt=Number(series[index].time), fundingVector=fundingFeaturesAt(options.fundingFeatures,bucketAt);
      // The volatility head is scored on the same bucket as the direction head, off the same feature
      // row, so the two readings differ only in what they were asked to predict.
      // 波动头与方向头在同一条桶上、同一行特征上打分，因此两个读数唯一的差别就是它们被要求预测什么。
      const bigProbability = typeof model.predictBigAt === 'function' ? clamp(model.predictBigAt(index), .000001, .999999) : null;
      samples.push({ bucketAt, targetAt: bucketAt + (horizon + 1) * barMs, entry, exitPrice,
        probability: directionalProbability, upProbability, flatProbability, downProbability, theta, actualReturn,
        isUp: actualReturn > 0 ? 1 : 0, direction: dominantDirection({ up: upProbability, flat: flatProbability, down: downProbability }),
        outcomeLabel: label, regime: projection?.regime || null, sinceEventHours: hoursSinceEvent(options.macroCalendar, bucketAt),
        fundingZ: fundingVector?.[0] ?? null, fundingLevel: fundingVector?.[2] ?? null, bigProbability });
    }
    cut += segmentLength;
    await new Promise(resolve => setImmediate(resolve));
  }
  return { horizonKey, samples, segments, skippedSegments, candles: series.length, featureWidth, volatilityColumns, minTrain, volatilityHead: headDiagnostics, directionHead: directionDiagnostics,
    macroCalendarEvents: Array.isArray(options.macroCalendar) ? options.macroCalendar.length : 0,
    fundingSeries: Array.isArray(options.fundingFeatures) ? options.fundingFeatures.length : 0 };
}
// Live buckets overlap by horizon when the sampling grid is finer than the holding period, so a
// headline count overstates how much independent evidence it holds. Greedily take the earliest
// bucket, then skip everything that opens before that pick would have closed.
// 当采样网格比持有期更细时，实时桶之间会重叠，于是统计条数会高估它实际持有的独立证据量。做法是
// 贪心取最早的一个桶，然后跳过所有在该笔尚未平仓之前就开仓的桶。
function independentSubset(rows, barMs) {
  const sorted = [...rows].sort((a, b) => a.bucketAt - b.bucketAt), picked = [];
  let lastTarget = -Infinity;
  for (const row of sorted) {
    if (Number(row.bucketAt) >= lastTarget) { picked.push(row); lastTarget = Number(row.bucketAt) + barMs; }
  }
  return picked;
}
// The promotion chain is gated per horizon. Configuration carries the overrides; the scalar stays
// as the fallback so a horizon that wants the default never has to be written twice.
// 升级链按周期分别把关。覆盖值写在配置里，标量作为兜底，采用默认值的周期不必重复声明。
function requiredIndependentFor(key) {
  const overrides = RESEARCH_TUNING.gates.perHorizonRequirement;
  return Number(overrides?.[key]) || RESEARCH_TUNING.gates.requiredIndependentPerHorizon;
}
// The same gate expressed in wall-clock terms, which is what a person actually waits for: one
// independent sample per holding period. Without this, "20" looks identical across four horizons
// that cost 5 hours and 20 days respectively.
// 同一个门槛折算成真实等待时间 —— 这才是人实际要等的东西：每个持有期只产一个独立样本。没有这层
// 折算，「20」在分别要花 5 小时与 20 天的两个周期上看起来一模一样。
function horizonGateDays(key) { return requiredIndependentFor(key) * horizonBarMs(key) / 86_400_000; }
// Replay refreshes on demand rather than on every page load: it retrains a dozen small models and
// would otherwise dominate the request budget of a research panel nobody is watching.
// 回放按需刷新，而不是每次打开页面都跑：它会重训十几个小模型，否则会占满一个没人盯着的研究面板的
// 请求预算。
const RESEARCH_BACKFILL_TTL = 30 * 60_000;
let researchBackfillCache = null;
async function researchBackfill({ refresh = false } = {}) {
  const now = Date.now();
  if (!refresh && researchBackfillCache && now - researchBackfillCache.time < RESEARCH_BACKFILL_TTL) return { ...researchBackfillCache.payload, cached: true };
  const calendar = macroHighImpactCalendar();
  const intraday = storedCandleRange('15m', 0, now), daily = storedCandleRange('1d', 0, now);
  const definitions = researchHorizonDefinitions({ '15m': intraday, '1d': daily });
  const mean = values => values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
  const brierOf = values => values.length ? mean(values.map(sample => multiclassBrier({ up: Number(sample.upProbability), flat: Number(sample.flatProbability), down: Number(sample.downProbability) }, sample.outcomeLabel))) : null;
  const rows = {};
  for (const definition of definitions) {
    const barMs = definition.barMs;
    // The calendar is attached for tagging only; whether it is also fed to the model is a separate
    // switch, so the headline replay keeps its published definition while samples still know how
    // close they sat to a print.
    // 日历只用于打标记；它是否同时喂给模型由另一个开关控制，这样主口径回放保持既有定义不变，而样本
    // 仍然知道它们距一次发布有多近。
    const replay = await walkForwardBackfill(definition.key, definition.horizon, definition.interval, definition.candles, { minDirectional: definition.minDirectional, macroCalendar: calendar });
    const independent = independentSubset(replay.samples, barMs);
    rows[definition.key] = {
      candles: replay.candles, segments: replay.segments, skippedSegments: replay.skippedSegments,
      samples: replay.samples.length, independent: independent.length,
      calendarEvents: calendar.length, featureWidth: replay.featureWidth ?? null,
      eventWindowSamples: independent.filter(sample => Number.isFinite(Number(sample.sinceEventHours)) && Number(sample.sinceEventHours) <= 24).length,
      from: replay.samples.length ? replay.samples[0].bucketAt : null,
      to: replay.samples.length ? replay.samples[replay.samples.length - 1].bucketAt : null,
      brier: brierOf(replay.samples), independentBrier: brierOf(independent),
      threeClass: threeClassSummary(replay.samples),
      independentThreeClass: threeClassSummary(independent),
    };
  }
  const payload = { rows, generatedAt: now, windowVersion: RESEARCH_WINDOW_VERSION, tuningFingerprint: tuningFingerprint(),
    note: 'Walk-forward replay over stored candles. Each segment trains only on buckets already settled at its cut, so no bucket is graded by a model that has seen its own future.' };
  researchBackfillCache = { time: now, payload };
  return { ...payload, cached: false };
}
// Ablation answers the only question that matters for a new factor: does it buy anything? Both arms
// run the identical replay pipeline over the identical candles and differ solely by the three
// calendar columns, so any gap between them is attributable to those columns and nothing else. The
// headline is deltaVsMajority rather than accuracy: on a tape that is flat most of the time, a high
// accuracy score is reachable by never predicting a direction at all.
// 消融实验回答一个新因子唯一重要的问题：它到底买到了什么？两臂跑完全相同的回放流程、相同的 K 线，
// 唯一差别就是那三列日历特征，因此两者的差距只能归因于这三列。头条指标是 deltaVsMajority 而不是
// accuracy：在大部分时间震荡的行情里，「永不预测方向」就能拿到很高的准确率。
let researchAblationCache = null;
// Every ablation arm differs from the baseline by exactly one block of columns, so a verdict of "no
// difference" is always attributable to that block and to nothing else. Each factor also carries the
// condition that splits its samples into exposed and unexposed: a global average can hide a factor
// that only acts in a narrow regime, and those buckets are a minority of the tape.
// 每个消融臂与基线臂只差正好一块列，因此任何「无差异」结论都只能归因于那一块。每个因子还带着把
// 样本切成「暴露」与「未暴露」的条件：全局均值会掩盖一个只在窄区间起作用的因子，而那些桶只占全部
// 样本的少数。
const ABLATION_FACTORS = [
  { key: 'macro', label: '宏观日程', labelEn: 'macro calendar', columns: 3,
    context: 'macroCalendar', switchOn: { useCalendarFeatures: true },
    note: '距上次事件小时数、距下次事件小时数、是否在事件后 24h 内',
    noteEn: 'hours since the last print, hours until the next, and whether the bucket sits within 24h of one',
    condition: { label: '事件窗口内（24h）', labelEn: 'inside an event window (24h)',
      test: sample => Number.isFinite(Number(sample.sinceEventHours)) && Number(sample.sinceEventHours) <= 24 } },
  { key: 'funding', label: '合约资金费率', labelEn: 'perp funding rate', columns: FUNDING_FEATURE_COLUMNS,
    context: 'fundingFeatures', switchOn: { useFundingFeatures: true },
    note: '资金费率 z 分数、费率斜率、费率绝对水平、距下次结算的位置',
    noteEn: 'funding z-score, rate tilt, absolute rate level, and position within the settlement cycle',
    condition: { label: '费率拥挤极端（|z| > 1）', labelEn: 'crowding extreme (|z| > 1)',
      test: sample => Math.abs(Number(sample.fundingZ) || 0) > 1 } },
];
async function researchAblation({ refresh = false } = {}) {
  const now = Date.now();
  if (!refresh && researchAblationCache && now - researchAblationCache.time < RESEARCH_BACKFILL_TTL) return { ...researchAblationCache.payload, cached: true };
  // Every context is handed to every arm so the per-sample tags come out identical across arms; only
  // the switch decides which block reaches the model. Without that, a factor could not be measured on
  // the same subset of buckets it is about to be compared on.
  // 每个上下文都交给每个臂，使各臂的逐样本标记完全一致；只有开关决定哪一块进入模型。否则因子就无法
  // 在「它将被比较的那同一批桶」上被测量。
  const contexts = { macroCalendar: macroHighImpactCalendar(), fundingFeatures: fundingFeatureSeries() };
  const intraday = storedCandleRange('15m', 0, now), daily = storedCandleRange('1d', 0, now);
  const definitions = researchHorizonDefinitions({ '15m': intraday, '1d': daily });
  const mean = values => values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
  const brierOf = values => values.length ? mean(values.map(sample => multiclassBrier({ up: Number(sample.upProbability), flat: Number(sample.flatProbability), down: Number(sample.downProbability) }, sample.outcomeLabel))) : null;
  const shift = (factor, base) => Number.isFinite(factor) && Number.isFinite(base) ? factor - base : null;
  const directionalCalls = summary => summary ? summary.samples - summary.predictedCounts.flat : null;
  const factorDelta = (factor, base) => factor && base ? {
    deltaVsMajority: shift(factor.threeClass?.deltaVsMajority, base.threeClass?.deltaVsMajority),
    deltaVsFrequency: shift(factor.threeClass?.deltaVsFrequency, base.threeClass?.deltaVsFrequency),
    directionalAccuracy: shift(factor.threeClass?.directionalAccuracy, base.threeClass?.directionalAccuracy),
    missedBreakout: shift(factor.threeClass?.missedBreakout, base.threeClass?.missedBreakout),
    brier: shift(factor.brier, base.brier),
    directionalCalls: shift(directionalCalls(factor.threeClass), directionalCalls(base.threeClass)),
    // The volatility question gets its own block rather than being folded into the numbers above:
    // both are ratios but they answer different questions, and a factor that moves one without the
    // other is exactly the case this module keeps running into.
    // 波动这个问题单独成块，而不是混进上面的数字里：两者都是比例，但回答的是不同问题，而「动了一个、
    // 不动另一个」恰恰是本模块反复遇到的情形。
    volatility: { brierSkill: shift(factor.volatility?.brierSkill, base.volatility?.brierSkill),
      auc: shift(factor.volatility?.auc, base.volatility?.auc),
      brier: shift(factor.volatility?.brier, base.volatility?.brier) },
  } : null;
  // Only a factor that actually carries data earns an arm: an empty calendar would run a second
  // identical pass and report a "no difference" that means nothing.
  // 只有真正带数据的因子才会得到一个臂：空日历会跑出一次完全相同的流程，并报出一个毫无意义的
  // 「无差异」。
  const factors = ABLATION_FACTORS.filter(factor => Array.isArray(contexts[factor.context]) && contexts[factor.context].length);
  const rows = {};
  for (const definition of definitions) {
    // The volatility head is switched on for every arm including the baseline: it is part of the
    // measuring instrument, not part of the treatment. Only the factor's own column block differs
    // between arms, which is what keeps a delta attributable.
    // 波动头对每个臂都打开、包括基线臂：它是量具的一部分，不是被处理的变量。各臂之间唯一的差别仍然是
    // 因子自己那一块列，这才让差值可归因。
    const barMs = definition.barMs, base = { minDirectional: definition.minDirectional, volatilityHead: true, ...contexts };
    // Every arm over this horizon sees the same candles and the same buckets, so they would all
    // compute the identical analogue projection from scratch. One cache per horizon removes that
    // duplication without touching a single number.
    // 同一周期上的每个臂看到的是同一批 K 线与同一批桶，因此会各自从头算一遍完全相同的近邻投影。
    // 每个周期一份缓存即可消除这份重复，且不改变任何一个数值。
    const projectionCache = new Map(), arms = {};
    for (const factor of [{ key: 'baseline', switchOn: {} }, ...factors]) {
      const replay = await walkForwardBackfill(definition.key, definition.horizon, definition.interval, definition.candles, { ...base, ...factor.switchOn, projectionCache });
      const picked = independentSubset(replay.samples, barMs);
      arms[factor.key] = { picked, replay, summary: { samples: picked.length, featureWidth: replay.featureWidth ?? null, volatilityColumns: replay.volatilityColumns ?? null,
        // A skipped segment is a training window the model could not fit at all. It is reported
        // rather than dropped: it is the first thing that moves when a warm-up or a sample floor is
        // lowered, and a silent skip would look like coverage that was never there.
        // 被跳过的段是模型完全拟合不出来的训练窗口。它必须报出来而不是丢掉：只要下调预热长度或样本
        // 下限，它就会第一个变化；静默跳过则会看起来像赢得了从未有过的覆盖。
        minTrain: replay.minTrain ?? null, segments: replay.segments ?? null, skippedSegments: replay.skippedSegments ?? null,
        // The head's own diagnostics ride along: the training rate, the calibration slice's rate and the
        // realised rate side by side are what turn "this head over-predicts" into a diagnosis.
        // 波动头自己的诊断随行下发：训练基率、校准切片基率、实际基率三者并排，才是把「这个头会高估大动」
        // 变成一次诊断的关键。
        volatilityHead: replay.volatilityHead ?? null,
        directionHead: replay.directionHead ?? null,
        brier: brierOf(picked), threeClass: threeClassSummary(picked), volatility: volatilitySummary(picked) } };
    }
    const baseline = arms.baseline.summary, row = { candles: arms.baseline.replay.candles, baseline, factors: {}, deltas: {}, conditions: {} };
    // A delta that holds in one half of the independent samples and reverses in the other is not a
    // finding, it is a coin. Sample count alone cannot tell those two apart, and this module has already
    // been bitten by exactly that: the daily volatility reading flipped direction when its sample grew
    // from 620 to 720. Two summaries per half are O(n) reductions on top of a replay that already
    // refit the model several times, so the cost is not the reason to leave this out.
    // 一个差值如果在独立样本的前半段成立、后半段反向，那它不是一个发现，而是一枚硬币。样本量本身分不出
    // 这两种情况，而本模块已经恰好被这一点咬过一次：日线的波动读数在样本从 620 涨到 720 时就翻了向。
    // 每个半段两次汇总是叠加在「已经重拟合过若干次模型」的回放之上的 O(n) 归约，所以成本不是省掉它的理由。
    const directionBand = RESEARCH_TUNING.ablation.deltaThresholdPp / 100;
    const volatilityBand = RESEARCH_TUNING.ablation.volatilityThresholdPp / 100;
    const aucBand = RESEARCH_TUNING.ablation.volatilityAucThreshold;
    const stabilityOf = (baseRows, armRows, score, band) => {
      // Below this there is no half worth reading; reporting a verdict on 19 samples per half would be
      // the same crying-wolf the band itself exists to prevent. 低于这个数，每一半都没有可读性；对每半
      // 19 个样本给出判定，正是阈值带本身要防的那种虚报。
      if (baseRows.length < 40 || armRows.length !== baseRows.length) return null;
      const mid = Math.floor(baseRows.length / 2);
      const halves = [[0, mid], [mid, baseRows.length]].map(([from, to]) => shift(score(armRows.slice(from, to)), score(baseRows.slice(from, to))));
      if (!halves.every(value => Number.isFinite(value))) return null;
      const [first, second] = halves, loud = value => Math.abs(value) > band;
      return { first, second, band,
        // Both halves must clear the same band that the headline verdict uses. Two sub-band wiggles of
        // opposite sign are noise twice over, not a contradiction worth flagging.
        // 两个半段都必须越过与总结论同一条带。两个都在带内、方向相反的小抖动是双重的噪声，不值得报警。
        sameDirection: loud(first) && loud(second) && Math.sign(first) === Math.sign(second),
        flipped: loud(first) && loud(second) && Math.sign(first) !== Math.sign(second) };
    };
    const scoreDirection = rows => threeClassSummary(rows)?.deltaVsMajority ?? null;
    const scoreSkill = rows => volatilitySummary(rows)?.brierSkill ?? null;
    const scoreAuc = rows => volatilitySummary(rows)?.auc ?? null;
    for (const factor of factors) {
      const arm = arms[factor.key];
      if (!arm) continue;
      row.factors[factor.key] = arm.summary;
      row.deltas[factor.key] = factorDelta(arm.summary, baseline);
      // Same two arms, restricted to the buckets the factor is supposed to act on versus the rest.
      // 同样的两臂，但分别只看「该因子本该起作用的桶」与「其余桶」。
      // Compare the two arms on the same buckets, on both questions at once. `pair` takes two
      // three-class summaries directly and `volatilityPair` takes two volatility summaries - an
      // earlier revision handed `pair` the *wrapped* arm objects, so every delta came out null and
      // the condition split silently reported nothing at all.
      // 在同一批桶上比较两臂，方向与波动两个问题各比一遍。pair 直接接收两份三分类汇总，volatilityPair
      // 接收两份波动汇总 —— 早先的版本把**包装过的**臂对象传了进来，于是所有差值都成了 null，条件分组
      // 静默地什么都没报出来。
      const partitioned = (samples, exposed) => samples.filter(sample => Boolean(factor.condition.test(sample)) === exposed);
      const pair = (baseSummary, factorSummary) => ({ baseline: baseSummary, factor: factorSummary,
        deltaVsMajority: shift(factorSummary?.deltaVsMajority, baseSummary?.deltaVsMajority),
        accuracy: shift(factorSummary?.accuracy, baseSummary?.accuracy),
        directionalAccuracy: shift(factorSummary?.directionalAccuracy, baseSummary?.directionalAccuracy) });
      const volatilityPair = (baseSummary, factorSummary) => ({ baseline: baseSummary, factor: factorSummary,
        brierSkill: shift(factorSummary?.brierSkill, baseSummary?.brierSkill),
        auc: shift(factorSummary?.auc, baseSummary?.auc) });
      const side = exposed => {
        const baseRows = partitioned(arms.baseline.picked, exposed), armRows = partitioned(arm.picked, exposed);
        return { ...pair(threeClassSummary(baseRows), threeClassSummary(armRows)),
          volatility: volatilityPair(volatilitySummary(baseRows), volatilitySummary(armRows)) };
      };
      row.conditions[factor.key] = { label: factor.condition.label, labelEn: factor.condition.labelEn,
        all: { ...pair(baseline.threeClass, arm.summary.threeClass), volatility: volatilityPair(baseline.volatility, arm.summary.volatility) },
        inside: side(true), outside: side(false) };
      // The stability evidence is attached to the delta it is about, in the same units, so a reader never
      // has to consult a second table to find out whether the headline number is a finding or a coin.
      // 稳定性证据挂在它所属的那个差值上、用同样的单位，读者不必再翻第二张表去查这个头条数字到底是发现
      // 还是一枚硬币。
      if (row.deltas[factor.key]) row.deltas[factor.key].stability = {
        direction: stabilityOf(arms.baseline.picked, arm.picked, scoreDirection, directionBand),
        brierSkill: stabilityOf(arms.baseline.picked, arm.picked, scoreSkill, volatilityBand),
        auc: stabilityOf(arms.baseline.picked, arm.picked, scoreAuc, aucBand) };
    }
    rows[definition.key] = row;
  }
  const payload = { rows, generatedAt: now,
    factorMeta: factors.map(factor => ({ key: factor.key, label: factor.label, labelEn: factor.labelEn, columns: factor.columns,
      note: factor.note, noteEn: factor.noteEn, condition: { label: factor.condition.label, labelEn: factor.condition.labelEn } })),
    contexts: { calendarEvents: contexts.macroCalendar.length, fundingSettlements: contexts.fundingFeatures.length },
    tuningFingerprint: tuningFingerprint(),
    // The verdict thresholds travel with the payload so the client cannot disagree with the service
    // about what counts as a difference. Three of them now, and deliberately not one: direction and the
    // volatility level are both read in percentage points, but the AUC gain is not a percentage of
    // anything - it is a bare increment on a 0-to-1 statistic. Sharing one number across the three
    // happened to land on workable values, which is exactly why it had to be split before anyone tried
    // to retune one of them.
    // 判定阈值随载荷下发，客户端与服务端不会各持一套标准。现在是三个，而且是刻意不合成一个：方向与波动
    // 水平都以百分点读，但 AUC 增量不是任何东西的百分比 —— 它是 0 到 1 之间的统计量上的裸增量。三者共用
    // 一个数字恰好落在了可用的数值上，这恰恰是必须在有人想单独调其中一个之前就把它拆开的原因。
    deltaThresholdPp: RESEARCH_TUNING.ablation.deltaThresholdPp,
    volatilityThresholdPp: RESEARCH_TUNING.ablation.volatilityThresholdPp,
    volatilityAucThreshold: RESEARCH_TUNING.ablation.volatilityAucThreshold,
    methodology: [
      '每个因子臂跑完全相同的回放流程与同一批 K 线，唯一差别是它自己那一块特征列。',
      '判定标准是 deltaVsMajority（相对「永远猜多数类」的增量）与方向类指标，不是 accuracy —— 震荡占多数时永远猜震荡就有 75% 以上。',
      '波动口径回答另一个问题：这里有没有东西知道「要动」。为此每个臂额外训练一个波动头 —— 同一批特征列、同样的规则，标签改成「是否离开震荡带」。缺了它这个口子，特征列对波动的影响在架构上不可能被观测到：实时融合的震荡概率完全取自近邻池，任何列都到不了那一侧。',
      '波动口径同时报 Brier 技巧与 AUC：前者看尺度、后者看排序且与阈值无关。二者背离即「排序里有信号、但数值标定不对」，这与「没有信号」是两件事。基准是常数基率，因此一个从不变化的预测其技巧恰好为 0、AUC 恰好为 0.5。',
      '指标基于「互不重叠」的独立样本子集，避免重叠桶把显著性撑大。',
      '每个差值都沿独立样本对半切开重算一次：两半若方向相反，该行会标出「前后段反向」。样本量只说明有多少观察，不说明它们是否指向同一件事 —— 本模块已经栽过一次（日线的波动读数在样本从 620 涨到 720 时翻了向）。标着反向的格子应当读作「还没有结论」，而不是「结论相反」。',
      `判定阈值：方向 ±${RESEARCH_TUNING.ablation.deltaThresholdPp}pp（准确率差）、波动水平 ±${RESEARCH_TUNING.ablation.volatilityThresholdPp}pp（Brier 技巧；这两个都是百分点，前端会先换算成比例再比较）、波动排序 ±${RESEARCH_TUNING.ablation.volatilityAucThreshold}（AUC 增量，无量纲）。低于该幅度在这批样本上与噪声不可区分。无增量只说明在当前的样本、模型与列块下测不出增量，不等于该因子没有信息。`,
      '每个因子另外报告它的「暴露」条件分组：全局均值会掩盖一个只在窄区间起作用的因子。',
      '日历特征只用事件的公布日期（Fed / BLS 提前数月公布）；发布值被有意排除，因为 FRED 按「所描述的时间段」打戳而非「公开时刻」。资金费率在结算瞬间即公开，按 funding_at ≤ 桶时刻 对齐，同样不含前视。',
    ] };
  researchAblationCache = { time: now, payload };
  return { ...payload, cached: false };
}
function horizonBarMs(key) { return key === '1d' ? 86_400_000 : key === '4h' ? 14_400_000 : key === '1h' ? 3_600_000 : 900_000; }
function pairedPredictionMetrics(rows, probabilityKey) {
  if(!rows.length)return null;
  const probabilities=rows.map(row=>Number(row[probabilityKey])), labels=rows.map(row=>Number(row.isUp)), mean=values=>values.reduce((sum,value)=>sum+value,0)/Math.max(values.length,1), baseRate=mean(labels), brier=mean(probabilities.map((probability,index)=>(probability-labels[index])**2)), baselineBrier=mean(labels.map(label=>(baseRate-label)**2)), logLoss=mean(probabilities.map((probability,index)=>-(labels[index]*Math.log(clamp(probability,.000001,.999999))+(1-labels[index])*Math.log(clamp(1-probability,.000001,.999999))))), accuracy=mean(probabilities.map((probability,index)=>+(+(probability>=.5)===+labels[index]))), bins=Array.from({length:10},()=>[]);
  probabilities.forEach((probability,index)=>bins[Math.min(9,Math.floor(probability*10))].push({ probability,label:labels[index] }));
  const ece=bins.reduce((sum,bin)=>sum+(bin.length?Math.abs(mean(bin.map(item=>item.probability))-mean(bin.map(item=>item.label)))*bin.length/rows.length:0),0), signals=rows.filter(row=>Math.abs(Number(row[probabilityKey])-.5)>=RESEARCH_TUNING.economics.signalEdge), directionalAccuracy=signals.length?mean(signals.map(row=>+(+(Number(row[probabilityKey])>=.5)===+Number(row.isUp)))):null, coverage=signals.length/rows.length, returns=signals.map(row=>Number(row.actualReturn)*(Number(row[probabilityKey])>=.5?1:-1)-RESEARCH_TUNING.economics.roundTripCost);let equity=1,peak=1,maxDrawdown=0;for(const value of returns){equity*=1+value;peak=Math.max(peak,equity);maxDrawdown=Math.min(maxDrawdown,equity/peak-1)}const average=mean(returns), deviation=Math.sqrt(mean(returns.map(value=>(value-average)**2)))||0;
  return { samples:rows.length, accuracy, directionalAccuracy, coverage, brier, logLoss, brierSkill:baselineBrier?1-brier/baselineBrier:null, ece, economic:{ trades:signals.length, netReturn:equity-1, maxDrawdown, sharpe:deviation?average/deviation*Math.sqrt(returns.length):null } };
}
function compareCandidateToBaseline(trainingRunId) {
  const pairs=stmt(`SELECT candidate.horizon_key AS horizonKey, candidate.bucket_at AS bucketAt, candidate.probability AS candidateProbability, candidate.is_up AS isUp, candidate.actual_return AS actualReturn, baseline.calibrated_probability AS baselineProbability, baseline.regime AS regime
    FROM research_candidate_forecasts AS candidate
    INNER JOIN research_predictions AS baseline ON baseline.horizon_key=candidate.horizon_key AND baseline.bucket_at=candidate.bucket_at
    WHERE candidate.training_run_id=? AND candidate.settled_at IS NOT NULL AND baseline.settled_at IS NOT NULL
    ORDER BY candidate.target_at ASC`).all(trainingRunId).map(row=>({ ...row, bucketAt:Number(row.bucketAt), isUp:Number(row.isUp), actualReturn:Number(row.actualReturn), candidateProbability:Number(row.candidateProbability), baselineProbability:Number(row.baselineProbability) }));
  // Each horizon carries its own gate and reports it next to the count, so the UI never has to
  // guess the requirement and a per-horizon override is visible rather than implied.
  // 每个周期带上自己的门槛，并与计数并列返回 —— 这样界面不必去猜要求是多少，按周期的覆盖值也是
  // 显式可见的，而不是隐含的。
  const horizons=['15m','1h','4h','1d'], byHorizon=Object.fromEntries(horizons.map(key=>{const rows=pairs.filter(row=>row.horizonKey===key), independent=independentSubset(rows,horizonBarMs(key)).length, required=requiredIndependentFor(key);return [key,{ samples:rows.length, independent, required, gateDays:horizonGateDays(key), ready:independent>=required, baseline:pairedPredictionMetrics(rows,'baselineProbability'), candidate:pairedPredictionMetrics(rows,'candidateProbability') }]}));
  const overall={ samples:pairs.length, baseline:pairedPredictionMetrics(pairs,'baselineProbability'), candidate:pairedPredictionMetrics(pairs,'candidateProbability') }, regimes=Object.fromEntries(['bull','bear','range'].map(regime=>{const rows=pairs.filter(row=>row.regime===regime);return [regime,{ samples:rows.length, baseline:pairedPredictionMetrics(rows,'baselineProbability'), candidate:pairedPredictionMetrics(rows,'candidateProbability') }]}));
  // Promotion used to demand 30 nominal samples in all four horizons at once, which handed the
  // daily horizon veto power over the entire chain: it yields one independent outcome per day, so
  // 30 meant 30 days of wall clock — while 4h's overlapping buckets padded its own count without
  // adding evidence. Each horizon is now judged on its own non-overlapping count.
  // 升级原先要求四个周期同时攒够 30 条名义样本，等于把否决权交给日线：它一天只产生一个独立结果，
  // 30 条就是 30 天真实时间；而 4h 的重叠桶只是把计数撑大、并未增加证据。现在每个周期按自己的不
  // 重叠计数独立判定。
  const gateCfg=RESEARCH_TUNING.gates, readyHorizons=horizons.filter(key=>byHorizon[key].ready), allReady=readyHorizons.length===horizons.length, enough=readyHorizons.length>0, headroom=horizons.map(key=>`${key} ${byHorizon[key].independent}/${byHorizon[key].required}`).join('、'), quality=overall.baseline&&overall.candidate&&overall.candidate.brier<=overall.baseline.brier*gateCfg.quality.brierFactor&&overall.candidate.logLoss<=overall.baseline.logLoss*gateCfg.quality.logLossFactor, calibration=overall.candidate&&Number(overall.candidate.brierSkill)>=gateCfg.calibration.minBrierSkill&&overall.candidate.ece<=overall.baseline.ece*gateCfg.calibration.eceFactor, economics=overall.candidate&&overall.candidate.economic.netReturn>=overall.baseline.economic.netReturn&&overall.candidate.economic.maxDrawdown>=overall.baseline.economic.maxDrawdown-gateCfg.economics.maxDrawdownSlack, robust=Object.values(regimes).filter(row=>row.samples>=gateCfg.robustness.minSamples).every(row=>row.candidate.brier<=row.baseline.brier*gateCfg.robustness.brierFactor);
  const verdict=!enough?{ tone:'yellow', label:'继续影子评估', reason:`尚无周期攒够各自的独立样本门槛（${headroom}）。` }:!allReady?{ tone:'yellow', label:'部分周期可评估', reason:`已达标：${readyHorizons.join('、')}；仍在累积：${horizons.filter(key=>!readyHorizons.includes(key)).join('、')}（${headroom}）。四周期全部达标前不会给出升级结论。` }:quality&&calibration&&economics&&robust?{ tone:'green', label:'建议人工复核', reason:'候选在配对样本的概率质量、校准、成本化表现和已验证市场状态中均达到升级门槛；仍不会自动切换。' }:{ tone:'red', label:'不建议升级', reason:'独立样本已足够，但候选未同时达到预设的概率质量、校准、成本化表现和稳健性门槛。' };
  return { paired:overall.samples, requiredIndependentPerHorizon:gateCfg.requiredIndependentPerHorizon, requiredByHorizon:Object.fromEntries(horizons.map(key=>[key,byHorizon[key].required])), readyHorizons, allHorizonsReady:allReady, byHorizon, overall, regimes, criteria:{ independentPerHorizon:`各周期独立样本门槛：${horizons.map(key=>`${key} ${byHorizon[key].required}（≈${horizonGateDays(key).toFixed(1)} 天）`).join('，')}`, quality:'Brier 与 Log Loss 均至少优于现役 3%', calibration:'BSS ≥ 0 且 ECE 不恶化超过 5%', economics:`固定 ${(RESEARCH_TUNING.economics.roundTripCost*100).toFixed(2)}% 往返成本后净收益不低于现役，最大回撤最多恶化 ${(RESEARCH_TUNING.gates.economics.maxDrawdownSlack*100).toFixed(0)}%`, robustness:'任何样本 ≥10 的市场状态中，Brier 不劣于现役超过 5%' }, verdict, readyForNext:enough, promotionEligible:verdict.tone==='green' };
}
function candidateTrainingStatus() {
  const latest=stmt('SELECT id, started_at, completed_at, status, model_name, metrics_json, samples_json, error FROM research_training_runs ORDER BY id DESC LIMIT 1').get();
  if(!latest)return { inProgress:researchTrainingInProgress, latest:null, shadow:{ totalSettled:0, requiredIndependentPerHorizon:RESEARCH_TUNING.gates.requiredIndependentPerHorizon, requiredByHorizon:Object.fromEntries(['15m','1h','4h','1d'].map(key=>[key,requiredIndependentFor(key)])), promotionEligible:false, reason:'尚未训练候选模型' } };
  const settled=stmt('SELECT horizon_key, probability, is_up AS isUp, brier FROM research_candidate_forecasts WHERE training_run_id=? AND settled_at IS NOT NULL').all(latest.id), pending=stmt('SELECT COUNT(*) AS total FROM research_candidate_forecasts WHERE training_run_id=? AND settled_at IS NULL').get(latest.id);
  const byHorizon={};for(const row of settled)(byHorizon[row.horizon_key] ||= []).push(row);
  const horizonSummary=Object.fromEntries(Object.entries(byHorizon).map(([key,rows])=>[key,{ settled:rows.length, hitRate:rows.reduce((sum,row)=>sum+((Number(row.probability)>=.5)===Boolean(row.isUp)?1:0),0)/rows.length, brier:rows.reduce((sum,row)=>sum+Number(row.brier),0)/rows.length }]));
  const comparison=compareCandidateToBaseline(latest.id), totalSettled=settled.length;
  return { inProgress:researchTrainingInProgress, latest:{ id:latest.id, startedAt:latest.started_at, completedAt:latest.completed_at, status:latest.status, modelName:latest.model_name, metrics:latest.metrics_json?JSON.parse(latest.metrics_json):null, samples:latest.samples_json?JSON.parse(latest.samples_json):null, error:latest.error||null }, shadow:{ totalSettled, pending:Number(pending?.total)||0, byHorizon:horizonSummary, requiredIndependentPerHorizon:comparison.requiredIndependentPerHorizon, requiredByHorizon:comparison.requiredByHorizon, readyForNext:comparison.readyForNext, promotionEligible:comparison.promotionEligible, reason:comparison.verdict.reason }, comparison };
}
async function trainResearchCandidate() {
  if(researchTrainingInProgress)throw Object.assign(new Error('candidate training is already running'),{ statusCode:409 });
  const existing=candidateTrainingStatus();
  if(existing.latest?.status==='shadow'&&!existing.shadow.readyForNext)throw Object.assign(new Error('current candidate is still collecting shadow outcomes; do not create another version yet'),{ statusCode:409 });
  researchTrainingInProgress=true;const startedAt=Date.now(), run=storeResearchTrainingRun.run(startedAt,'running','triple-barrier logistic + local tree candidate');
  try {
    const [intraday,daily]=await Promise.all([forecastHistory('15m'),forecastHistory('1d')]);
    const definitions=researchHorizonDefinitions({ '15m':intraday.candles, '1d':daily.candles });
    const trained=(await Promise.all(definitions.map(async definition=>({ ...definition, fusion:await trainFusionModelAsync(definition.candles,definition.horizon) })))).filter(row=>row.fusion);
    if(trained.length!==definitions.length)throw new Error('insufficient chronological samples for one or more candidate horizons');
    // Snapshot rows must share the baseline's anchor and horizon definition, and must pass the
    // full argument list: bucket_at stamped at the training instant never paired with a baseline
    // row, and the two missing arguments wrote the direction string into flat_probability.
    // 快照行必须与现役共用锚定与持有期定义，且要传全参数：bucket_at 原先盖的是训练时刻，
    // 永远配不上现役行；少传两个参数还把方向字符串写进了 flat_probability。
    for(const row of trained){const barMs=row.interval==='1d'?86_400_000:900_000, anchor=forecastAnchor(row.candles,barMs,startedAt), probability=row.fusion.probability;storeCandidateForecast.run(run.lastInsertRowid,anchor.bucketAt,startedAt,row.key,row.interval,horizonTargetAt(anchor.bucketAt,row.horizon,barMs),anchor.close,probability,null,probability>=.5?'up':'down',Number(row.fusion.theta)||null,RESEARCH_WINDOW_VERSION);}
    const metrics=Object.fromEntries(trained.map(row=>[row.key,{ brier:row.fusion.validation.brier, logLoss:row.fusion.validation.logLoss, brierSkill:row.fusion.validation.brierSkill, ece:row.fusion.validation.ece, auc:row.fusion.validation.auc }]));
    const samples=Object.fromEntries(trained.map(row=>[row.key,row.fusion.validation.samples]));
    completeResearchTrainingRun.run(Date.now(),'shadow',JSON.stringify(metrics),JSON.stringify(samples),null,run.lastInsertRowid);
    return candidateTrainingStatus();
  } catch(error) { completeResearchTrainingRun.run(Date.now(),'failed',null,null,error.message,run.lastInsertRowid);throw error; }
  finally { researchTrainingInProgress=false; }
}
function settleResearchPredictions(histories, now) {
  for (const row of pendingResearchPredictions.all(now)) {
    const barMs = row.candle_interval === '1d' ? 86_400_000 : 900_000, candles = histories[row.candle_interval] || [], target = settlementBar(candles, barMs, Number(row.target_at));
    if (!target) continue;
    const settledPrice = Number(target.close);
    if (!Number.isFinite(settledPrice) || !row.entry_price) continue;
    const actualReturn = settledPrice / row.entry_price - 1, isUp = actualReturn > 0 ? 1 : 0, label = outcomeLabel(actualReturn, row.theta);
    const stored = stmt('SELECT calibrated_probability, flat_probability FROM research_predictions WHERE id=?').get(row.id);
    const upProbability = Number(stored?.calibrated_probability), flatProbability = Number(stored?.flat_probability);
    // Older rows predate the three-class threshold and keep their two-class Brier; newer
    // rows are scored against all three outcomes and are the only ones a scorecard uses.
    // 早于三分类阈值的旧行保留二分类 Brier；新行按三类评分，记分卡只采用新行。
    const brier = Number.isFinite(flatProbability)
      ? multiclassBrier({ up:upProbability, flat:flatProbability, down:Math.max(0, 1 - upProbability - flatProbability) }, label)
      : (upProbability - isUp) ** 2;
    settleResearchPrediction.run(now, settledPrice, actualReturn, isUp, label, brier, row.id);
  }
  for (const row of pendingCandidateForecasts.all(now)) {
    const barMs = row.candle_interval === '1d' ? 86_400_000 : 900_000, candles = histories[row.candle_interval] || [], target = settlementBar(candles, barMs, Number(row.target_at));
    if (!target) continue;
    const settledPrice = Number(target.close);
    if (!Number.isFinite(settledPrice) || !row.entry_price) continue;
    const actualReturn = settledPrice / row.entry_price - 1, isUp = actualReturn > 0 ? 1 : 0, label = outcomeLabel(actualReturn, row.theta);
    const upProbability = Number(row.probability), flatProbability = Number(row.flat_probability);
    const brier = Number.isFinite(flatProbability)
      ? multiclassBrier({ up:upProbability, flat:flatProbability, down:Math.max(0, 1 - upProbability - flatProbability) }, label)
      : (upProbability - isUp) ** 2;
    settleCandidateForecast.run(now, settledPrice, actualReturn, isUp, label, brier, row.id);
  }
}
const RESEARCH_CLASSES=['up','flat','down'];
// Three-class grading.  A model that says "chop" every single time already scores very high,
// so the scorecard has to publish that baseline next to the model or the number means nothing.
// 三分类评分。一个永远说「震荡」的模型本来就能拿高分，所以记分卡必须把这个基线并列展示，否则数字没有意义。
function threeClassSummary(rows) {
  const scored=rows.filter(row=>row.outcomeLabel && row.direction);
  if(!scored.length)return null;
  const confusion=Object.fromEntries(RESEARCH_CLASSES.map(predicted=>[predicted,Object.fromEntries(RESEARCH_CLASSES.map(actual=>[actual,0]))]));
  for(const row of scored){
    if(!confusion[row.direction])continue;
    if(!(row.outcomeLabel in confusion[row.direction]))continue;
    confusion[row.direction][row.outcomeLabel]+=1;
  }
  const counts=Object.fromEntries(RESEARCH_CLASSES.map(key=>[key,scored.filter(row=>row.outcomeLabel===key).length]));
  const predictedCounts=Object.fromEntries(RESEARCH_CLASSES.map(key=>[key,scored.filter(row=>row.direction===key).length]));
  const accuracy=scored.filter(row=>row.direction===row.outcomeLabel).length/scored.length;
  const majority=RESEARCH_CLASSES.reduce((best,key)=>counts[key]>counts[best]?key:best,'flat');
  const majorityAccuracy=counts[majority]/scored.length;
  const frequencyAccuracy=RESEARCH_CLASSES.reduce((sum,key)=>sum+(counts[key]/scored.length)**2,0);
  const perClass=Object.fromEntries(RESEARCH_CLASSES.map(key=>{
    const predicted=predictedCounts[key], actual=counts[key], hit=confusion[key][key]||0;
    return [key,{ predicted, actual, hit, precision:predicted?hit/predicted:null, recall:actual?hit/actual:null }];
  }));
  const flatPredictions=scored.filter(row=>row.direction==='flat');
  const directionalPredictions=scored.filter(row=>row.direction!=='flat');
  return { samples:scored.length, accuracy, majorityLabel:majority, majorityAccuracy, frequencyAccuracy, deltaVsMajority:accuracy-majorityAccuracy, deltaVsFrequency:accuracy-frequencyAccuracy, counts, predictedCounts, confusion, perClass,
    missedBreakout:flatPredictions.length?flatPredictions.filter(row=>row.outcomeLabel!=='flat').length/flatPredictions.length:null,
    directionalAccuracy:directionalPredictions.length?directionalPredictions.filter(row=>row.direction===row.outcomeLabel).length/directionalPredictions.length:null };
}
// The direction summary answers "which way, given that it moves". This one answers the question the
// event studies raised instead, and which nothing in the module could measure before: does any of
// this know that a move is coming at all? Both are read off the same predicted distribution - the
// flat class is already the model's own statement that price stays inside the band, so
// P(move) = 1 - P(flat) needs neither a second model nor a second chop band.
// Two properties make it honest: the baseline is a constant base rate (not 50%), and AUC is
// reported next to the Brier skill because it is threshold-free - a factor can rank big moves
// correctly while being badly scaled, and that distinction is the difference between "no signal" and
// "signal in the wrong units".
// 方向汇总回答的是「若真动了，往哪边」。这个汇总回答的是事件研究提出、而此前模块里没有任何口径能测的
// 另一个问题：这里有东西知道「要动」吗？两者读的是同一个预测分布 —— flat 类本身就是模型对「价格留在
// 带内」的判断，所以 P(动) = 1 - P(flat) 既不需要第二个模型，也不需要第二条震荡带。
// 两点让它诚实：基准是常数基率（不是 50%），以及把 AUC 与 Brier 技巧并列报出 —— 前者与阈值无关，
// 一个因子完全可能把「大动」排序排对、但数值尺度很差，这正是「没有信号」与「信号存在但单位不对」的区别。
function volatilitySummary(rows) {
  // Where the movement probability comes from matters, so it is reported rather than implied. With a
  // head present it is that head's calibrated output; without one the only thing left is the analogue
  // pool's own complement, 1 - P(chop) - which the feature columns cannot influence at all, so every
  // delta computed from it is zero by construction rather than by measurement.
  // 这个「要动」的概率来自哪里必须显式报出，而不是隐含。有波动头时用它校准后的输出；没有头时只剩下
  // 近邻池自己的补集 1 − P(震荡) —— 而特征列根本影响不到它，于是由它算出的任何增量都是「构造上为零」
  // 而不是「测出来为零」。
  const bigScored = rows.filter(row => Number.isFinite(Number(row.bigProbability)));
  const useHead = rows.length > 0 && bigScored.length === rows.length;
  const scored = (useHead ? bigScored : rows).filter(row => Number.isFinite(Number(row.flatProbability)) && Number.isFinite(Number(row.actualReturn)) && Number.isFinite(Number(row.theta)));
  if (!scored.length) return null;
  const mean = values => values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
  const probabilityOf = row => clamp(useHead ? Number(row.bigProbability) : 1 - Number(row.flatProbability), .000001, .999999);
  const labelled = scored.map(row => ({ probability: probabilityOf(row), big: Math.abs(Number(row.actualReturn)) > Number(row.theta) ? 1 : 0 }));
  const bigRate = mean(labelled.map(row => row.big));
  const brier = mean(labelled.map(row => (row.probability - row.big) ** 2));
  // A forecast that never varies scores exactly the base rate's Brier, so this is the honest zero
  // line for "did anything here predict movement".
  // 一条从不变化的预测，其 Brier 恰好等于基率的 Brier，所以这就是「这里有没有东西预测了波动」的零点。
  const baseBrier = bigRate * (1 - bigRate);
  const positives = labelled.filter(row => row.big), negatives = labelled.filter(row => !row.big);
  let auc = null;
  if (positives.length && negatives.length) {
    // Rank-based AUC with ties counted at half, so a model that emits a constant scores exactly 0.5
    // rather than being flattered by whatever order the buckets happened to arrive in.
    // 基于排名的 AUC，同分按半数计，这样输出常数的模型恰好得 0.5，而不会因为桶的到达顺序而被抬高。
    const sorted = [...labelled].sort((a, b) => a.probability - b.probability), ranks = new Map();
    for (let index = 0; index < sorted.length;) {
      let end = index;
      while (end + 1 < sorted.length && sorted[end + 1].probability === sorted[index].probability) end += 1;
      const averageRank = (index + end) / 2 + 1;
      for (let point = index; point <= end; point++) ranks.set(sorted[point], averageRank);
      index = end + 1;
    }
    const rankSum = positives.reduce((sum, row) => sum + ranks.get(row), 0);
    auc = (rankSum - positives.length * (positives.length + 1) / 2) / (positives.length * negatives.length);
  }
  const predictedRate = mean(labelled.map(row => row.probability));
  return { samples: labelled.length, source: useHead ? 'model-head' : 'analogue-complement',
    bigRate, bigSamples: positives.length, predictedRate,
    // `predictedRate / bigRate` is the quickest read on scale: far above 1 means the model calls for
    // movement that does not arrive, far below 1 means it misses most of it.
    // predictedRate / bigRate 是判断尺度最快的方式：远大于 1 说明模型喊动而没动，远小于 1 说明大量漏报。
    rateRatio: bigRate ? predictedRate / bigRate : null, brier, baseBrier,
    brierSkill: baseBrier ? 1 - brier / baseBrier : null, auc,
    logLoss: mean(labelled.map(row => -(row.big * Math.log(row.probability) + (1 - row.big) * Math.log(1 - row.probability)))) };
}
function researchScorecard() {
  const settled=stmt('SELECT horizon_key, bucket_at AS bucketAt, calibrated_probability AS probability, flat_probability AS flatProbability, is_up AS isUp, outcome_label AS outcomeLabel, direction, actual_return AS actualReturn, brier, window_version AS windowVersion FROM research_predictions WHERE settled_at IS NOT NULL ORDER BY settled_at ASC').all(), pending=stmt('SELECT horizon_key, COUNT(*) AS total FROM research_predictions WHERE settled_at IS NULL GROUP BY horizon_key').all(), byKey={};
  for(const row of settled)(byKey[row.horizon_key] ||= []).push({ bucketAt:Number(row.bucketAt), probability:Number(row.probability), flatProbability:Number(row.flatProbability), y:Number(row.isUp), outcomeLabel:row.outcomeLabel||null, direction:row.direction||null, actualReturn:Number(row.actualReturn), brier:Number(row.brier), windowVersion:Number(row.windowVersion)||1 });
  const mean=values=>values.reduce((sum,value)=>sum+value,0)/Math.max(values.length,1), result={};
  for(const [key,rows] of Object.entries(byKey)){
    // Probability quality is only meaningful on rows that actually stored three classes.
    // 概率质量只在真正存了三类概率的行上才有意义。
    // Only rows graded on the current window definition count. Rows settled before the window
    // was pinned to a closed anchor bar were graded against whichever bar happened to be
    // available at the time, so their realised horizon length varies; mixing them in would make
    // the headline accuracy uninterpretable. They are reported separately instead of dropped.
    // 只统计当前窗口定义下行情的样本。窗口固定到「已收盘锚定 K 线」之前结算的行，用的是当时
    // 恰好可用的那根 K 线，实际持有长度不固定；混进来会让准确率无法解释。因此单独报出，不静默丢弃。
    const authoritative=rows.filter(row=>row.windowVersion>=RESEARCH_WINDOW_VERSION), legacy=rows.filter(row=>row.windowVersion<RESEARCH_WINDOW_VERSION);
    const scored=authoritative.filter(row=>row.outcomeLabel&&Number.isFinite(row.flatProbability));
    const pool=scored, baseRate=mean(pool.map(row=>row.y)), baseline=mean(pool.map(row=>(baseRate-row.y)**2)), brier=mean(pool.map(row=>row.brier)), logLoss=mean(pool.map(row=>-(row.y*Math.log(clamp(row.probability,.000001,.999999))+(1-row.y)*Math.log(clamp(1-row.probability,.000001,.999999))))), bins=Array.from({length:10},()=>[]);pool.forEach(row=>bins[Math.min(9,Math.floor(row.probability*10))].push(row));const ece=bins.reduce((sum,bin)=>sum+(bin.length?Math.abs(mean(bin.map(row=>row.probability))-mean(bin.map(row=>row.y)))*bin.length/pool.length:0),0), signals=authoritative.filter(row=>Math.abs(row.probability-.5)>=RESEARCH_TUNING.economics.signalEdge), returns=signals.map(row=>row.actualReturn*(row.probability>=.5?1:-1)-RESEARCH_TUNING.economics.roundTripCost);let equity=1,peak=1,maxDrawdown=0;returns.forEach(value=>{equity*=1+value;peak=Math.max(peak,equity);maxDrawdown=Math.min(maxDrawdown,equity/peak-1)});const average=mean(returns), deviation=Math.sqrt(mean(returns.map(value=>(value-average)**2)))||0, downside=Math.sqrt(mean(returns.filter(value=>value<0).map(value=>value**2)))||0;
    // The headline count is nominal. Buckets sampled every 15 minutes overlap whenever the horizon
    // runs longer than one bar, so 30 "samples" can be two independent outcomes wearing a costume.
    // 统计条数是名义值。只要持有期长于一根 K 线，每 15 分钟采样的桶就会互相重叠，于是 30 条「样本」
    // 可能只是两个独立结果换了身衣服。
    const independent=independentSubset(authoritative,horizonBarMs(key));
    result[key]={ settled:rows.length, authoritative:authoritative.length, legacy:legacy.length, scored:scored.length, independent:{ samples:independent.length, threeClass:threeClassSummary(independent) }, threeClass:threeClassSummary(authoritative), hitRate:pool.length?mean(pool.map(row=>+(+(row.probability>=.5)===+row.y))):null,brier:pool.length?brier:null,logLoss:pool.length?logLoss:null,brierSkill:pool.length&&baseline?1-brier/baseline:null,ece:pool.length?ece:null,meanReturn:mean(rows.map(row=>row.actualReturn)),economic:{assumptions:`${(RESEARCH_TUNING.economics.roundTripCost*100).toFixed(2)}% round-trip cost charged once per signal; ±${(RESEARCH_TUNING.economics.signalEdge*100).toFixed(0)}% probability edge threshold`,trades:signals.length,turnover:rows.length?signals.length/rows.length:null,netReturn:equity-1,maxDrawdown,sharpe:deviation?average/deviation*Math.sqrt(returns.length):null,sortino:downside?average/downside*Math.sqrt(returns.length):null}};
  }
  return { rows:result, pending:Object.fromEntries(pending.map(row=>[row.horizon_key,Number(row.total)])) };
}
function researchFeatureStatus() {
  const row=stmt('SELECT COUNT(*) AS total, MIN(observed_at) AS firstAt, MAX(observed_at) AS lastAt, COUNT(ofi_pct) AS ofiSnapshots FROM derivative_snapshots WHERE source=?').get('okx');
  return { ofiSnapshots:Number(row?.ofiSnapshots)||0, derivativeSnapshots:Number(row?.total)||0, firstAt:Number(row?.firstAt)||null, lastAt:Number(row?.lastAt)||null, readyForTraining:(Number(row?.ofiSnapshots)||0)>=7_200 };
}
function dominantDirection(probabilities) {
  const entries=[['up',Number(probabilities?.up)||0],['flat',Number(probabilities?.flat)||0],['down',Number(probabilities?.down)||0]].sort((a,b)=>b[1]-a[1]);
  return entries[0][1] > 0 ? entries[0][0] : 'flat';
}
// Re-rate the open bucket instead of dropping it: the newest model output is the one the
// page will be graded on, and a settled row must never be rewritten.
// 让未结算的桶重新定价而不是丢弃：页面上要被评分的是最新模型输出，而已结算行永不被改写。
function writeResearchPrediction(window, now) {
  const write=()=>{
    const updated=updateResearchPrediction.run(now,window.targetAt,window.entryPrice,window.rawProbability,window.upProbability,window.flatProbability,window.direction,window.regime,window.theta,RESEARCH_WINDOW_VERSION,window.bucketAt,window.key);
    if(Number(updated?.changes))return;
    storeResearchPrediction.run(window.bucketAt,now,window.key,window.candleInterval,window.targetAt,window.entryPrice,window.rawProbability,window.upProbability,window.flatProbability,window.direction,window.regime,window.theta,RESEARCH_WINDOW_VERSION);
  };
  safelyStore(write);
}
function recordCandidateShadowForecasts(windows, now) {
  const active=stmt("SELECT id FROM research_training_runs WHERE status='shadow' ORDER BY id DESC LIMIT 1").get();
  if(!active)return;
  for(const window of windows){const probability=Number(window.candidateProbability);if(!Number.isFinite(probability))continue;safelyStore(()=>storeCandidateForecast.run(active.id,window.bucketAt,now,window.key,window.candleInterval,window.targetAt,window.entryPrice,probability,Number(window.flatProbability)||null,window.direction,window.theta,RESEARCH_WINDOW_VERSION));}
}
async function researchOutlook({ refresh = false } = {}) {
  const key = coinKey('research-outlook'), hit=cache.get(key), now=Date.now();
  if (!refresh && hit && now-hit.time<NEWS_TTL) return { ...cacheResult(hit, now), stale:false };
  return coalesce(key, async () => {
    const [intraday,daily,news,sentiment,derivatives,calendar,macro]=await Promise.all([forecastHistory('15m'),forecastHistory('1d'),bitcoinNews({ refresh }),fearGreedSentiment({ refresh }).catch(()=>null),marketContext('okx').catch(()=>null),fedCalendar().catch(()=>null),fedMarketSignals().catch(()=>null)]);
    // Read the blend configuration once, before anything that uses it. An earlier version declared
    // these aliases further down the function and the whole outlook path died on a temporal dead
    // zone error - a class of fault `node --check` cannot see, because it is not a syntax error.
    // 融合配置只读一次，且放在所有使用点之前。早先的版本把别名声明在函数靠后的位置，整个 outlook
    // 路径因暂时性死区报错而挂掉 —— 这类错误 `node --check` 看不见，因为它不是语法错误。
    const blendCfg=RESEARCH_TUNING.blend, consistencyCfg=blendCfg.consistency, clampCfg=blendCfg.probabilityClamp, tiltCfg=blendCfg.tilt;
    const newsItems=news.items || [], bullish=newsItems.filter(item=>item.sentiment>0).length, bearish=newsItems.filter(item=>item.sentiment<0).length;
    const newsScore=newsItems.length ? clamp(newsItems.reduce((sum,item)=>{const ageHours=Number.isFinite(item.publishedAt)?Math.max(0,(now-item.publishedAt)/3_600_000):6, timeWeight=Math.exp(-ageHours/4);return sum+item.sentiment*(item.sourceWeight||.7)*(item.eventWeight||.7)*timeWeight},0)/Math.max(1,newsItems.reduce((sum,item)=>sum+(item.sourceWeight||.7),0)),-1,1) : 0;
    const sentimentScore=Number.isFinite(sentiment?.value) ? clamp((sentiment.value-50)/50,-1,1) : 0;
    // Open interest only means something together with the direction of price: rising OI on
    // a rising price is trend confirmation, the same OI on a falling price is not.
    // 未平仓合约只有结合价格方向才有意义：价涨量增是趋势确认，价跌量增不是。
    const priceDirection=(Number(derivatives?.priceChangePct)||0)>=0?1:-1;
    const microstructureScore=derivatives ? clamp((Number(derivatives.orderBook?.imbalancePct)||0)/30*.32 + (Number(derivatives.takerFlow?.imbalancePct)||0)/35*.38 + (Number(derivatives.oiChangePct)||0)/.8*priceDirection*.18 - (Number(derivatives.fundingRate)||0)/.001*.08 - (Number(derivatives.basisPct)||0)/.25*.04,-1,1) : 0;
    const eventRisk=(calendar?.events||[]).filter(event=>event.at-now>=0&&event.at-now<=blendCfg.eventRisk.lookaheadHours*3_600_000).map(event=>event.name), eventRangeMultiplier=eventRisk.length?blendCfg.eventRisk.rangeMultiplier:1;
    const intradayAnchor=forecastAnchor(intraday.candles,forecastIntervalMs('15m'),now), dailyAnchor=forecastAnchor(daily.candles,forecastIntervalMs('1d'),now);
    const last=intradayAnchor.close || dailyAnchor.close;
    settleResearchPredictions({'15m':intraday.candles,'1d':daily.candles},now);

    settleAbExperiments({'15m':intraday.candles,'1d':daily.candles},now);
    // Four horizons share the same historical-feature model; the 15m/1h/4h paths use intraday candles, while 1d uses daily candles.
    // 四个周期共用同一历史特征模型；15 分钟/1 小时/4 小时使用日内 K 线，1 天使用日线。
    const definitions=researchHorizonDefinitions({ '15m':intraday.candles, '1d':daily.candles });
    const windows=await Promise.all(definitions.map(async definition => {
      const anchor=definition.key==='1d'?dailyAnchor:intradayAnchor;
      const bucketAt=anchor.bucketAt, entryPrice=anchor.close, targetAt=horizonTargetAt(bucketAt,definition.horizon,definition.barMs);
      // Yield once before the (synchronous, CPU-heavy) analogue projection so the four horizon
      // windows don't run their projections back-to-back as one ~10s non-yielding block that
      // would freeze the event loop. Each window's projection still runs to completion; we only
      // let other work (in-flight GET / requests) through first.
      // 在（同步、吃 CPU 的）近邻投影前先让出一次事件循环，避免四个周期的投影首尾相接成一段约 10s
      // 不释放主线程的块把事件循环冻住。每个周期的投影仍会跑完，只是先放其它在途请求（GET /）通过。
      await new Promise(resolve => setImmediate(resolve));
      const history=historicalProjection(definition.candles,definition.horizon);
      const fusion=await trainFusionModelAsync(definition.candles,definition.horizon);
      const horizonWeights=blendCfg.horizonWeight[definition.key] || blendCfg.horizonWeight['15m'];
      const newsWeight=horizonWeights.news, sentimentWeight=horizonWeights.sentiment, microWeight=horizonWeights.microstructure;
      const adjustment=(newsScore*newsWeight + sentimentScore*sentimentWeight + microstructureScore*microWeight)*Math.max(history.volatility,consistencyCfg.volatilityFloor);
      const adjustedReturn=clamp(history.expectedReturn + adjustment,-definition.cap,definition.cap), volatilityUnit=Math.max(history.volatility*Math.sqrt(definition.horizon),consistencyCfg.volatilityUnitFloor);
      const classProbabilities=history.classProbabilities || { up:history.upProbability, flat:0, down:1-history.upProbability };
      const flatProbability=clamp(Number(classProbabilities.flat)||0,0,1);
      const analogueSpread=Number(classProbabilities.up)+Number(classProbabilities.down);
      const analogueProbability=analogueSpread>0?Number(classProbabilities.up)/analogueSpread:history.upProbability;
      const learnedProbability=fusion?.probability ?? analogueProbability;
      // Dynamic, rule-based blending avoids fitting a meta-model before there
      // is enough out-of-fold history. Range states favor analogues; stronger
      // trend/volatility states give the nonlinear price model more weight.
      const analogueWeightCfg=blendCfg.analogueWeight;
      const analogueWeight=history.regime==='range'?analogueWeightCfg.range:history.volatility>analogueWeightCfg.volatileThreshold?analogueWeightCfg.volatile:analogueWeightCfg.normal;
      const baseProbability=analogueWeight*analogueProbability+(1-analogueWeight)*learnedProbability;
      // Headlines and microstructure can tilt which way a move breaks, but only the
      // analogue spread decides whether the move breaks out of the chop band at all.
      // 新闻与微观结构能影响走势往哪边破，但能否突破震荡带只由近邻分布决定。
      const microstructureTilt=definition.key==='1d'?tiltCfg.microstructureDaily:tiltCfg.microstructure;
      const directionalProbability=clamp(sigmoid(logit(baseProbability) + newsScore*tiltCfg.news + sentimentScore*tiltCfg.sentiment + microstructureScore*microstructureTilt),clampCfg.low,clampCfg.high);
      const directionalMass=clamp(1-flatProbability,0,1);
      const upProbability=clamp(directionalMass*directionalProbability,clampCfg.classLow,clampCfg.classHigh);
      const downProbability=clamp(Math.max(0,directionalMass-upProbability),clampCfg.classLow,clampCfg.classHigh);
      const rawProbability=directionalProbability;
      const direction=dominantDirection({ up:upProbability, flat:flatProbability, down:downProbability });
      const distribution=Object.fromEntries(Object.entries(history.distribution).map(([key,value])=>[key,clamp(value+adjustment,-definition.cap,definition.cap)]));
      const center=distribution.p50, widened={p10:center+(distribution.p10-center)*eventRangeMultiplier,p50:center,p90:center+(distribution.p90-center)*eventRangeMultiplier};
      return { ...definition, upProbability, downProbability, flatProbability, directionalProbability, rawProbability, candidateProbability:learnedProbability, entryPrice, bucketAt, targetAt, theta:Number(history.theta)||null, expectedReturn:adjustedReturn, expectedMove:last*adjustedReturn, expectedPrice:last*(1+adjustedReturn), direction, samples:history.samples, candidateCount:history.candidateCount, matchQuality:history.matchQuality, regime:history.regime, blend:{analogueWeight,modelWeight:1-analogueWeight}, volatilityUnit, distribution, priceRange:{p10:last*(1+widened.p10),p50:last*(1+widened.p50),p90:last*(1+widened.p90)}, eventRangeMultiplier, candleInterval:definition.interval, validation:fusion?.validation || null };
    }));
    // Damp a lone outlier horizon toward neutral; this is a consistency guard, not an attempt to force one direction.
    // 将孤立周期向中性轻微收缩；这是跨周期一致性保护，不会强行统一方向。
    windows.forEach((window,index)=>{
      const neighbors=windows.filter((_,other)=>Math.abs(other-index)===1).map(item=>item.directionalProbability);
      if(neighbors.length&&Math.abs(window.directionalProbability-neighbors.reduce((sum,value)=>sum+value,0)/neighbors.length)>consistencyCfg.neighbourDelta){
        window.directionalProbability=.5+(window.directionalProbability-.5)*consistencyCfg.dampFactor;
        window.rawProbability=window.directionalProbability;
        const mass=clamp(1-window.flatProbability,0,1);
        window.upProbability=clamp(mass*window.directionalProbability,clampCfg.classLow,clampCfg.classHigh);
        window.downProbability=clamp(Math.max(0,mass-window.upProbability),clampCfg.classLow,clampCfg.classHigh);
      }
      window.direction=dominantDirection({ up:window.upProbability, flat:window.flatProbability, down:window.downProbability });
    });
    for(const window of windows)writeResearchPrediction(window,now);
    recordCandidateShadowForecasts(windows,now);
    const primary=windows[2];
    const rankedNews=[...newsItems].map(item=>{const ageHours=Number.isFinite(item.publishedAt)?Math.max(0,(now-item.publishedAt)/3_600_000):6;return {...item,impact:Math.abs(item.sentiment)*(item.sourceWeight||.7)*(item.eventWeight||.7)*Math.exp(-ageHours/4)}}).sort((a,b)=>b.impact-a.impact || (b.publishedAt||0)-(a.publishedAt||0));
    const dxy=macro?.market?.find(row=>row.key==='dxy');
    // The payload carries the tuning fingerprint so a stored snapshot can be traced back to the
    // exact thresholds that produced it. Only the overrides are inlined, to keep the payload small.
    // 载荷带上调参指纹，使一份存档能追溯回产出它的那套阈值。只内联覆盖项，避免载荷过大。
    const tuning={ fingerprint:tuningFingerprint(), overrides:researchTuningReport().overrides, error:RESEARCH_TUNING_ERROR };
    const result={ price:last, windows, tuning, scorecard:researchScorecard(), training:candidateTrainingStatus(), features:researchFeatureStatus(), news:{ source:news.source, fetchedAt:news.fetchedAt, bullish, bearish, neutral:newsItems.length-bullish-bearish, score:newsScore, halfLifeHours:4, items:rankedNews.slice(0,6) }, sentiment:sentiment?{ value:sentiment.value, source:sentiment.source || 'Alternative.me' }:null, derivatives:derivatives?{ source:derivatives.source, score:microstructureScore, fundingRate:derivatives.fundingRate, oiChangePct:derivatives.oiChangePct, bookImbalancePct:derivatives.orderBook?.imbalancePct, ofiPct:derivatives.orderBook?.ofiPct, takerImbalancePct:derivatives.takerFlow?.imbalancePct, cvdSessionNotional:derivatives.takerFlow?.cvdSessionNotional, coverage:['funding','oi-change','order-book','taker-flow','cvd','basis'], collecting:['OFI / top-5 displayed-liquidity changes'], unavailable:['funding term structure / long-short ratio','options PCR / 25Δ skew / IV term structure','liquidation heatmap','spot ETF net flows','on-chain exchange / whale flows','Coinbase and Kimchi premiums'] }:null, macro:{ dxy:dxy?.available?{value:dxy.value,changePct:dxy.changePct,source:dxy.source}:null, status:'DXY is displayed for context only until time-aligned history is validated.' }, eventRisk, historical:{ intradaySource:intraday.source, dailySource:daily.source, intradaySamples:intraday.candles.length, dailySamples:daily.candles.length }, primary, fetchedAt:now, refreshMs:NEWS_TTL, cached:false, disclaimer:'Calibrated historical-model research only; not investment advice.' };
    remember(key,result); return result;
  });
}
async function yahooHistory(symbol) {
  const raw = await request(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=2y&interval=1d&events=history`);
  const result = raw.chart?.result?.[0]; const closes = result?.indicators?.quote?.[0]?.close;
  if (!result?.timestamp || !closes) throw new Error(`${symbol} history unavailable`);
  // Yahoo 偶尔会把尚未完成的日线附为 null 或 0；忽略它，避免临时占位符被误算为 -100% 涨跌。
  // Yahoo occasionally appends the still-forming daily bar as null or 0.
  // Ignore it so a transient placeholder never turns into a false -100% move.
  const candles = result.timestamp.map((time, i) => ({ time:time * 1000, close:+closes[i] })).filter(x => Number.isFinite(x.close) && x.close > 0);
  const last = candles.at(-1)?.close, previous = candles.at(-2)?.close;
  return { candles, quote:{ last, previous } };
}
async function stooqHistory(symbol) {
  const end = new Date();
  const start = new Date(Date.now() - 3 * 366 * 86400_000);
  const compact = d => d.toISOString().slice(0,10).replaceAll('-', '');
  const raw = await requestText(`https://stooq.com/q/d/l/?s=${symbol.toLowerCase()}.us&i=d&d1=${compact(start)}&d2=${compact(end)}`);
  const candles = raw.trim().split(/\r?\n/).slice(1).map(line => {
    const [date,, , ,close] = line.split(',');
    return { time:Date.parse(`${date}T00:00:00Z`), close:+close };
  }).filter(x => Number.isFinite(x.time) && Number.isFinite(x.close));
  if (candles.length < 300) throw new Error(`${symbol} history unavailable`);
  const last = candles.at(-1)?.close, previous = candles.at(-2)?.close;
  return { candles, quote:{ last, previous } };
}
async function equityHistory(symbol) {
  const failures = [];
  for (const [source, loader] of [['stooq', stooqHistory], ['yahoo', yahooHistory]]) {
    try { return { ...(await loader(symbol)), source }; }
    catch (e) { failures.push(`${source}: ${e.name === 'AbortError' ? 'timeout' : e.message}`); }
  }
  throw new Error(failures.join('; '));
}
async function usMarketState() {
  // 按美东时间推算盘前/盘中/盘后（美股常规交易 09:30–16:00 ET，周一至周五）。
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  if (day === 0 || day === 6) return 'CLOSED';
  const mins = et.getHours() * 60 + et.getMinutes();
  if (mins < 9 * 60 + 30) return 'PRE';
  if (mins <= 16 * 60) return 'REGULAR';
  return 'POST';
}
async function tencentLiveEquityQuote(symbol) {
  // 腾讯财经实时美股（亚洲托管，从 HK 稳定可达）。返回 v_usSPY="...~当前价~昨收~今开~..."。
  const sym = symbol.toUpperCase();
  const raw = await requestText(`https://qt.gtimg.cn/q=us${sym}`, 5_000);
  const m = raw.match(new RegExp(`v_us${sym}="([^"]*)"`));
  if (!m) throw new Error(`${sym} live quote unavailable`);
  const f = m[1].split('~');
  const last = Number(f[3]), previous = Number(f[4]);
  if (!Number.isFinite(last) || !Number.isFinite(previous) || previous <= 0) throw new Error(`${sym} live quote unavailable`);
  const state = usMarketState();
  return { symbol, last, previous, marketState: state, regularSession: state === 'REGULAR', source: 'Tencent (gtimg)' };
}
async function yahooLiveEquityQuote(symbol) {
  const raw = await request(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=1d&interval=1m&includePrePost=false`, 5_000);
  const meta = raw?.chart?.result?.[0]?.meta || {};
  const last = Number(meta.regularMarketPrice), previous = Number(meta.regularMarketPreviousClose ?? meta.previousClose);
  if (!Number.isFinite(last) || !Number.isFinite(previous) || previous <= 0) throw new Error(`${symbol} live quote unavailable`);
  const regular = meta.currentTradingPeriod?.regular, regularSession=Number(regular?.start) * 1000 <= Date.now() && Date.now() < Number(regular?.end) * 1000;
  return { symbol, last, previous, marketState:String(meta.marketState || '').toUpperCase(), regularSession, source:'Yahoo Finance' };
}
async function liveEquityQuote(symbol) {
  // 主源腾讯（亚洲托管，从 HK 稳定可达），失败回退 Yahoo（旧站稳定；新站美源不稳时也可能失败）。
  try { return await tencentLiveEquityQuote(symbol); } catch { /* fall through to Yahoo */ }
  return yahooLiveEquityQuote(symbol);
}
async function usEquityQuotes() {
  const key = 'us-equity-quotes', hit = cache.get(key);
  if (hit && Date.now() - hit.time < 10_000) return cacheResult(hit);
  try {
    const quotes = await Promise.all(['SPY','QQQ'].map(liveEquityQuote));
    const value = { open:quotes.every(quote => quote.marketState === 'REGULAR' || quote.regularSession), quotes, source: quotes[0]?.source || 'Tencent (gtimg)', fetchedAt:Date.now(), cached:false };
    remember(key, value); return value;
  } catch {
    // A missing live quote must not be rendered as a stale or empty market row.
    return { open:false, quotes:[], source:'unavailable', fetchedAt:Date.now(), cached:false };
  }
}
async function market(interval, limit, preferred) {
  const key = coinKey(`${interval}:${limit}:${preferred || 'auto'}`); const hit = cache.get(key);
  const ttl = isSyntheticOkxInterval(interval) ? 1_000 : MARKET_TTL;
  if (hit && Date.now() - hit.time < ttl) return { ...cacheResult(hit), stale:false };
  // Stale-while-revalidate: when a usable (not-too-old) snapshot exists but its TTL has
  // lapsed, serve it IMMEDIATELY and refresh in the background. A slow upstream REST fetch
  // (OKX/Gate can take many seconds through the proxy) must never make the dashboard's chart
  // spin — it simply shows slightly aged candles for one cycle. This also keeps /api/market
  // from piling up behind the research retrain, which would otherwise freeze every tab.
  // 陈旧即重新验证：当存在可用（不算太旧）的快照但 TTL 已过期时，立即返回它并在后台刷新。
  // 缓慢的上游 REST 拉取（经代理时 OKX/Gate 可能要数秒）绝不应让仪表盘图表转圈 —— 它只是
  // 在一个周期内显示略旧的 K 线。这也让 /api/market 不会在研究会重训时排起长队、冻住所有标签页。
  if (hit && Date.now() - hit.time <= STALE_QUOTE_MAX_AGE) {
    refreshMarket(key, interval, limit, preferred).catch(() => {});
    return { ...cacheResult(hit), stale:true, staleServed:true };
  }
  return refreshMarket(key, interval, limit, preferred);
}
function refreshMarket(key, interval, limit, preferred) {
  // 用户选择的数据源需要锁定：上游暂时失败时，报价和图表不能静默切换交易所。
  // A user-selected source is intentionally locked: displayed price and chart
  // must not silently switch exchanges during a temporary upstream failure.
  return coalesce(key, async () => {
    const order = preferred && loaders[preferred] ? [preferred] : sources;
    const failures = {};
    const jobs = order.map(source => loaders[source](interval, limit).then(value => ({ source, value })).catch(e => { failures[source] = e.name === 'AbortError' ? 'timeout (1.2s)' : e.message; throw e; }));
    try {
      const { source, value } = await Promise.any(jobs);
      const candles = value.candles.filter(validCandle).sort((a,b) => a.time - b.time).slice(-limit);
      if (candles.length < 30 || !Number.isFinite(value.ticker.last)) throw new Error('insufficient valid market data');
      const streamedTicker = source === 'okx' ? freshOkxTicker() : null;
      const result = { ...value, ticker:streamedTicker || value.ticker, candles, source, fetchedAt: Date.now(), cached:false, cacheAgeMs:0, stale:false, transport:streamedTicker ? 'websocket' : 'rest', failures };
      remember(key, result);
      // Synthetic candles are already persisted per trade; writing the entire
      // window again on each short refresh would inflate their volume.
      if (!isSyntheticOkxInterval(interval)) persistMarket(result, interval);
      settleAbExperiments({[interval]:candles},result.fetchedAt); return result;
    } catch { throw Object.assign(new Error('All data sources failed'), { failures }); }
  }, MARKET_REQUEST_TIMEOUT).catch(error => {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.time <= STALE_QUOTE_MAX_AGE) return { ...cacheResult(hit), stale:true, fallbackReason:error.message };
    // Keep the chosen exchange's identity intact.  A stale OKX chart is more
    // honest than silently drawing a Coinbase or Gate chart under an OKX label.
    const fallbackSources = preferred && loaders[preferred] ? [preferred] : sources;
    for (const source of fallbackSources) {
      const fallback = storedMarketFallback(source, interval, limit, error.message);
      if (fallback) return fallback;
    }
    throw error;
  });
}
// AI 助手复用本文件已经写好的数据函数，不另起一套采集逻辑。
// The AI assistant reuses the data functions above instead of duplicating them.
const aiChat = createAiChat({
  market, liveQuote, marketContext, fearGreedSentiment, fedMonitor, investmentCalendar,
  currentCoin,
  getCredential: (provider) => (provider === 'qwen' ? qwenCredential() : null),
  getVerification: (provider) => Boolean(apiCredentials._verification?.[provider]?.valid),
  setModel: (model) => setQwenModel(model)
});
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.mjs':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon' };
// 文本是否含可朗读内容（字母 / 数字 / 汉字等）。纯标点、纯符号、纯空白没有任何
// 音素，Edge 语音服务会直接返回空音频——那是请求本身的问题，不是服务不可用。
// Whether the text contains anything pronounceable. Punctuation-, symbol- or
// whitespace-only input carries no phonemes, so Edge returns zero audio.
const hasSpeakableContent = value => /[\p{L}\p{N}]/u.test(value);
// Edge 音色名 → Piper 音色（本地 sidecar，零网络依赖、无解地区问题）。
// 键值是前端仍在用的 Edge 名（前端无需改动），值是 Piper 标准语音 ID。
const EDGE_TO_PIPER = {
  'zh-CN-XiaoxiaoNeural': 'zh_CN-huayan-medium',
  'zh-CN-XiaoyiNeural': 'zh_CN-xiaoyi-medium',
  'zh-CN-liaoning-XiaobeiNeural': 'zh_CN-liaoning-xiaobei-medium',
  'zh-CN-shaanxi-XiaoniNeural': 'zh_CN-shaanxi-xiaoni-medium',
  'zh-TW-HsiaoChenNeural': 'zh_TW-huayu-medium',
  'zh-CN-YunxiNeural': 'zh_CN-yunxi-medium',
  'zh-CN-YunyangNeural': 'zh_CN-yunyang-medium',
  'en-US-AvaNeural': 'en_US-amy-medium',
  'en-US-EmmaNeural': 'en_US-emma-medium',
  'en-US-AnaNeural': 'en_US-ana-medium',
  'en-US-AriaNeural': 'en_US-aria-medium',
  'en-US-JennyNeural': 'en_US-jenny-medium',
  'en-US-MichelleNeural': 'en_US-michelle-medium',
  'en-US-AndrewNeural': 'en_US-andrew-medium',
  'en-US-BrianNeural': 'en_US-brian-medium',
  'en-US-ChristopherNeural': 'en_US-chris-medium',
  'en-US-EricNeural': 'en_US-eric-medium',
  'en-US-GuyNeural': 'en_US-guy-medium',
  'en-US-RogerNeural': 'en_US-ryan-medium',
  'en-US-SteffanNeural': 'en_US-steffan-medium',
};
async function piperTtsAudio(text, voice = 'zh-CN-XiaoxiaoNeural', attempts = 2) {
  if (!hasSpeakableContent(text)) throw Object.assign(new Error('Voice text has no pronounceable content'), { code: 'EMPTY_TEXT' });
  const piperUrl = process.env.PIPER_URL || 'http://piper:8080';
  const piperVoice = EDGE_TO_PIPER[voice] || (voice.startsWith('en') ? 'en_US-lessac-medium' : 'zh_CN-huayan-medium');
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15_000);
      const r = await fetch(`${piperUrl}/api/tts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, voice: piperVoice, outputFormat: 'mp3' }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!r.ok) throw new Error(`Piper HTTP ${r.status}`);
      const audio = Buffer.from(await r.arrayBuffer());
      if (!audio.length) throw new Error('Piper returned no audio');
      return audio;
    } catch (error) {
      if (error.code === 'EMPTY_TEXT') throw error;
      lastError = error;
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 350 * attempt));
    }
  }
  throw lastError;
}
async function edgeTtsAudio(text, voice='zh-CN-XiaoxiaoNeural', attempts=2) {
  if (!hasSpeakableContent(text)) throw Object.assign(new Error('Voice text has no pronounceable content'), { code:'EMPTY_TEXT' });
  let lastError;
  for (let attempt=1; attempt<=attempts; attempt+=1) {
    try {
      const chunks=[];
      for await (const chunk of new Communicate(text, voice, { rate:'+5%' }).stream()) if (chunk.type==='audio') chunks.push(Buffer.from(chunk.data));
      const audio=Buffer.concat(chunks); if(!audio.length) throw new Error('Edge TTS returned no audio'); return audio;
    } catch (error) {
      if (error.code === 'EMPTY_TEXT') throw error;
      // 上游偶发空音频或建连抖动：退避后重试一次，避免把一次抖动直接暴露成失败。
      // Transient upstream hiccups are retried once instead of surfacing as an error.
      lastError = error;
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 350*attempt));
    }
  }
  throw lastError;
}
http.createServer((req, res) => {
 // 币种先于一切解析：?symbol=ETH 就把整条请求链路（缓存键、SQLite、交易所合约）
 // 都切到 ETH。缺省为 BTC，因此不带该参数的老请求与「比特币模式」完全等价。
 // Resolve the coin first: ?symbol=ETH switches the whole request path (cache
 // keys, SQLite file, exchange instrument) to ETH.  Defaulting to BTC keeps
 // every existing request byte-identical to the pre-multi-coin behaviour.
 const requestUrl = new URL(req.url, `http://${req.headers.host}`);
 return coinScope.run({ coin:normalizeCoin(requestUrl.searchParams.get('symbol')) }, () =>
 requestTiming.run({ started:performance.now(), upstreamStarted:null, upstreamEnded:null, upstreamCalls:0 }, async () => {
 try {
 const url = requestUrl;
  if (await aiChat.handle({ req, res, url, readJsonBody:readJson, json, clientKey:req.socket.remoteAddress || 'local' })) return;
  if (url.pathname === '/api/api-center/verify' && req.method === 'POST') {
    let provider=null;
    try { ({ provider } = await readJson(req)); }
    catch(error) { json(res,error.statusCode||400,{error:error.message}); return; }
    if(!await requireApiCenterAccess(req,res,provider)) return;
    try { json(res,200,await verifyApiCredential(provider)); }
    catch(error) { json(res,error.statusCode||500,{error:error.message}); }
    return;
  }
  if (url.pathname === '/api/api-center') {
    try {
      if (req.method === 'GET') { json(res,200,{credentials:apiCredentialStatus(),verification:apiCredentialVerification(),coinGeckoUsage:await coinGeckoUsage()}); return; }
      // API settings control server-side outbound credentials.  Reading their
      // boolean status is safe, but every mutation is an authenticated,
      // HTTPS-only account action.
      if (req.method === 'PUT') {
        const body=await readJson(req);
        if(!await requireApiCenterAccess(req,res,body.provider)) return;
        saveApiCredential(body.provider,body.key,body.url,body.model); json(res,200,{ok:true,credentials:apiCredentialStatus()}); return;
      }
      if (req.method === 'DELETE') {
        const provider=url.searchParams.get('provider');
        if(!await requireApiCenterAccess(req,res,provider)) return;
        deleteApiCredential(provider); json(res,200,{ok:true,credentials:apiCredentialStatus()}); return;
      }
      json(res,405,{error:'GET, PUT or DELETE required'});
    } catch(error) { json(res,error.statusCode||500,{error:error.message}); }
    return;
  }
  if (url.pathname === '/api/alerts/health') { json(res,200,{enabled:alertStore.enabled,reason:alertStore.reason||null}); return; }
  if (url.pathname === '/api/voice/edge' && req.method==='POST') {
    try {
      const {text,voice}=await readJson(req),safeText=String(text||'').trim();
      // 长度校验属于请求问题，直接 400；不要落进下面的上游 catch 被报成 503。
      if(!safeText||safeText.length>240) { json(res,400,{error:'Voice text must be 1–240 characters',detail:'播报文本长度需在 1–240 个字符之间'}); return; }
      const safeVoice=['zh-CN-XiaoxiaoNeural','zh-CN-XiaoyiNeural','zh-CN-liaoning-XiaobeiNeural','zh-CN-shaanxi-XiaoniNeural','zh-TW-HsiaoChenNeural','zh-HK-HiuGaaiNeural','zh-CN-YunxiNeural','zh-CN-YunyangNeural','en-US-AvaNeural','en-US-EmmaNeural','en-US-AnaNeural','en-US-AriaNeural','en-US-JennyNeural','en-US-MichelleNeural','en-US-AndrewNeural','en-US-BrianNeural','en-US-ChristopherNeural','en-US-EricNeural','en-US-GuyNeural','en-US-RogerNeural','en-US-SteffanNeural'].includes(voice)?voice:'zh-CN-XiaoxiaoNeural';
      let audio;
      try {
        audio = await piperTtsAudio(safeText, safeVoice); // 本地 Piper 优先（零网络、无解地区问题）
      } catch (piperErr) {
        if (piperErr.code === 'EMPTY_TEXT') throw piperErr;
        audio = await edgeTtsAudio(safeText, safeVoice); // Piper 不可用时回退 Edge（旧站可用；新站美源不稳可能仍失败）
      }
      res.writeHead(200,{'content-type':'audio/mpeg','cache-control':'no-store','content-length':audio.length});res.end(audio);
    } catch(error) {
      // 文本无可朗读内容属于请求本身的问题，返回 400 并说明原因；只有上游真的
      // 不可用才返回 503，避免把「探针文本选错」误报成服务故障。
      // Unpronounceable text is a bad request, not an upstream outage.
      if (error.code === 'EMPTY_TEXT') json(res,400,{error:'Voice text has no pronounceable content',detail:'文本中没有可朗读的字母、数字或汉字，无法合成语音'});
      else json(res,503,{error:'Edge voice unavailable',detail:error.message});
    }
    return;
  }
  // 语音规则同步：前端保存时 POST 上当前 settings + rules；仅用于页面内状态恢复。
  if (url.pathname === '/api/voice/sync' && req.method === 'POST') {
    try {
      const body = await readJson(req);
      const settingsIn = body && body.settings;
      const entriesIn = Array.isArray(body && body.personalEntries) ? body.personalEntries : [];
      const rulesIn = Array.isArray(body && body.rules) ? body.rules : [];
      // 多币种：记录该次同步属于哪个币种（接力播报关闭，仅状态镜像，但状态本身不再混淆币种）
      if (typeof body?.symbol === 'string' && body.symbol) voiceState.symbol = body.symbol;
      if (settingsIn && typeof settingsIn === 'object') voiceState.settings = settingsIn;
      voiceState.personalEntries = entriesIn.slice(0, 2).flatMap(entry => {
        const price = Number(entry?.price);
        return Number.isFinite(price) && price > 0 ? [{ price, side: entry?.side === 'short' ? 'short' : 'long' }] : [];
      });
      // 同步规则：保留服务端 _lastPrice / lastTriggeredAt 状态（按 id 匹配）
      const prevById = new Map(voiceState.rules.map(rule => [rule.id, rule]));
      voiceState.rules = rulesIn.map(rule => {
        const prev = prevById.get(rule.id) || {};
        return { ...prev, ...rule };
      });
      voiceState.lastHeartbeatAt = Date.now(); // 同步即视为在线
      persistVoiceState();
      json(res, 200, { ok:true, relayed:false, inFlightUntil: voiceState.inFlightUntil });
    } catch (error) {
      json(res, 400, { error: 'Bad voice sync payload', detail: error.message });
    }
    return;
  }
  // 心跳：前端每 30s 一次，断 60s 服务端接管
  if (url.pathname === '/api/voice/heartbeat' && req.method === 'POST') {
    voiceState.lastHeartbeatAt = Date.now();
    persistVoiceState();
    json(res, 200, {
      ok: true,
      relayed: false,
      inFlightUntil: voiceState.inFlightUntil,
      nextRelayWindowMs: VOICE_HEARTBEAT_TIMEOUT_MS,
    });
    return;
  }
  // 状态：前端启动时回拉服务端 lastTriggeredAt / lastSpokenAt
  if (url.pathname === '/api/voice/status' && (req.method === 'GET' || req.method === 'POST')) {
    json(res, 200, {
      ok: true,
      lastHeartbeatAt: voiceState.lastHeartbeatAt,
      lastSpokenAt: voiceState.lastSpokenAt,
      inFlightUntil: voiceState.inFlightUntil,
      rules: voiceState.rules.map(({ _lastPrice, ...rest }) => rest), // 不泄露内部字段
      settings: voiceState.settings,
    });
    return;
  }
  if (url.pathname === '/api/voice/state' && (req.method === 'GET' || req.method === 'POST')) {
    // 历史别名（前端状态回拉使用）
    json(res, 200, {
      rules: voiceState.rules.map(({ _lastPrice, ...rest }) => rest),
      settings: voiceState.settings,
      lastHeartbeatAt: voiceState.lastHeartbeatAt,
      lastSpokenAt: voiceState.lastSpokenAt,
      inFlightUntil: voiceState.inFlightUntil,
    });
    return;
  }
  if (url.pathname === '/api/auth/register' && req.method === 'POST') {
    if(!secureCloudTransport(req,res))return;
    if(!alertStore.enabled){json(res,503,{error:'Cloud alerts unavailable',detail:alertStore.reason});return;}
    try { const result=await alertStore.register(...(({email,password})=>[email,password])(await readJson(req))); setSessionCookie(res,result.session); json(res,201,{user:result.user}); } catch(error) { json(res,error.statusCode||500,{error:error.message}); } return;
  }
  if (url.pathname === '/api/auth/login' && req.method === 'POST') {
    if(!secureCloudTransport(req,res))return;
    if(!alertStore.enabled){json(res,503,{error:'Cloud alerts unavailable',detail:alertStore.reason});return;}
    try { const result=await alertStore.login(...(({email,password})=>[email,password])(await readJson(req))); setSessionCookie(res,result.session); json(res,200,{user:result.user}); } catch(error) { json(res,error.statusCode||500,{error:error.message}); } return;
  }
  if (url.pathname === '/api/auth/logout' && req.method === 'POST') { if(!secureCloudTransport(req,res))return; if(alertStore.enabled) await alertStore.logout(req); clearSessionCookie(res); json(res,204,{}); return; }
  if (url.pathname === '/api/auth/me') { const user=await requireAlertUser(req,res); if(user) json(res,200,{user,hasSendKey:await alertStore.hasSendKey(user.id)}); return; }
  if (url.pathname === '/api/account/profile') {
    const user=await requireAlertUser(req,res); if(!user)return;
    try { if(req.method==='GET'){json(res,200,{profile:await alertStore.getProfile(user.id)});return;} if(req.method==='PUT'){json(res,200,{profile:await alertStore.setProfile(user.id,await readJson(req))});return;} json(res,405,{error:'GET or PUT required'}); } catch(error) { json(res,error.statusCode||500,{error:error.message}); } return;
  }
  if (url.pathname === '/api/alerts/credentials') {
    const user=await requireAlertUser(req,res); if(!user)return;
    try { if(req.method==='PUT'){await alertStore.setSendKey(user.id,(await readJson(req)).sendKey);json(res,204,{});return;} if(req.method==='DELETE'){await alertStore.deleteSendKey(user.id);json(res,204,{});return;} json(res,405,{error:'PUT or DELETE required'}); } catch(error) { json(res,error.statusCode||500,{error:error.message}); } return;
  }
  if (url.pathname === '/api/alerts/test' && req.method === 'POST') {
    const user=await requireAlertUser(req,res); if(!user)return;
    try { json(res,200,await alertStore.testPush(user.id,(await readJson(req)).price)); } catch(error) { json(res,error.statusCode||500,{error:error.message}); } return;
  }
  if (url.pathname === '/api/alerts/rules') {
    const user=await requireAlertUser(req,res); if(!user)return;
    try { if(req.method==='GET'){json(res,200,{rules:await alertStore.listRules(user.id)});return;} if(req.method==='POST'){const id=await alertStore.createRule(user.id,await readJson(req));json(res,201,{id});return;} json(res,405,{error:'GET or POST required'}); } catch(error) { json(res,error.statusCode||500,{error:error.message}); } return;
  }
  if (url.pathname.startsWith('/api/alerts/rules/') && req.method==='DELETE') {
    const user=await requireAlertUser(req,res); if(!user)return;
    try { await alertStore.deleteRule(user.id,url.pathname.slice('/api/alerts/rules/'.length)); json(res,204,{}); } catch(error) { json(res,error.statusCode||500,{error:error.message}); } return;
  }
  // ---- 多渠道推送（v2.10.52）：渠道 CRUD / 验证 / 推送设置 ----
  if (url.pathname === '/api/alerts/channels') {
    const user=await requireAlertUser(req,res); if(!user)return;
    try {
      if(req.method==='GET'){ if(!alertStore.enabled){json(res,503,{error:'Cloud alerts unavailable',detail:alertStore.reason});return;} json(res,200,{channels:await alertStore.listChannels(user.id)});return; }
      if(req.method==='POST'){ if(!alertStore.enabled){json(res,503,{error:'Cloud alerts unavailable',detail:alertStore.reason});return;} const id=await alertStore.saveChannel(user.id,await readJson(req)); json(res,201,{id});return; }
      json(res,405,{error:'GET or POST required'});
    } catch(error) { json(res,error.statusCode||500,{error:error.message}); } return;
  }
  if (url.pathname.startsWith('/api/alerts/channels/')) {
    const user=await requireAlertUser(req,res); if(!user)return;
    const segments=url.pathname.slice('/api/alerts/channels/'.length).split('/');
    const id=decodeURIComponent(segments[0]);
    const action=segments[1] || '';
    try {
      if(action==='verify'&&req.method==='POST'){ if(!alertStore.enabled){json(res,503,{error:'Cloud alerts unavailable',detail:alertStore.reason});return;} json(res,200,await alertStore.verifyChannelById(user.id,id));return; }
      if(!action&&req.method==='PUT'){ const body=await readJson(req); if(body.enabled!==undefined&&body.config===undefined&&body.name===undefined){await alertStore.setChannelEnabled(user.id,id,body.enabled);json(res,204,{});return;} await alertStore.saveChannel(user.id,{...body,id}); json(res,204,{});return; }
      if(!action&&req.method==='DELETE'){ await alertStore.deleteChannel(user.id,id); json(res,204,{});return; }
      json(res,405,{error:'PUT, DELETE or POST verify required'});
    } catch(error) { json(res,error.statusCode||500,{error:error.message}); } return;
  }
  if (url.pathname === '/api/alerts/push-settings') {
    const user=await requireAlertUser(req,res); if(!user)return;
    try {
      if(req.method==='GET'){ if(!alertStore.enabled){json(res,503,{error:'Cloud alerts unavailable',detail:alertStore.reason});return;} json(res,200,{settings:await alertStore.getPushSettings(user.id)});return; }
      if(req.method==='PUT'){ if(!alertStore.enabled){json(res,503,{error:'Cloud alerts unavailable',detail:alertStore.reason});return;} json(res,200,{settings:await alertStore.setPushSettings(user.id,await readJson(req))});return; }
      json(res,405,{error:'GET or PUT required'});
    } catch(error) { json(res,error.statusCode||500,{error:error.message}); } return;
  }
  if (url.pathname === '/api/account' && req.method==='DELETE') {
    const user=await requireAlertUser(req,res); if(!user)return;
    await alertStore.deleteAccount(user.id);clearSessionCookie(res);json(res,204,{});return;
  }
  // 币种注册表：前端据此渲染币种切换器，并保证前后端支持的币种永不脱节。
  // Coin registry: the frontend renders its coin switcher from this, so the two
  // sides can never drift apart.
  if (url.pathname === '/api/coins') {
    json(res, 200, {
      base: BASE_COIN, current: currentCoin(), raw: url.searchParams.get('symbol'),
      coins: COIN_KEYS.map(key => ({
        key, label: COINS[key].label,
        name: COINS[key].name.zh, nameEn: COINS[key].name.en,
        usdt: COINS[key].okx.spot, swap: COINS[key].okx.swap,
        pricePrecision: COINS[key].pricePrecision, qtyPrecision: COINS[key].qtyPrecision
      }))
    });
    return;
  }
  if (url.pathname === '/api/market') {
    const interval = url.searchParams.get('interval') || '4h';
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 180), 30), MAX_MARKET_CANDLES);
    try { json(res, 200, await market(interval, limit, url.searchParams.get('source'))); } catch (e) { json(res, 503, { error:e.message, failures:e.failures || {} }); }
    return;
  }
  if (url.pathname === '/api/quote') {
    try { json(res, 200, await liveQuote(url.searchParams.get('source') || 'okx')); } catch (e) { json(res, 503, { error:e.message }); }
    return;
  }
  if (url.pathname === '/api/status') {
    const now = Date.now();
    json(res, 200, {
      sources, cacheEntries: cache.size, storage:storageStatus(), now,
      refreshPolicy:{ quoteMs:250, marketMs:MARKET_TTL, contextMs:CONTEXT_TTL, historyMs:HISTORY_TTL, sentimentMs:SENTIMENT_TTL, fedCalendarMs:FED_CALENDAR_TTL },
      websocket:{ provider:'OKX', coin:currentCoin(), status:okxStream.status, tickerAgeMs:streamAge(streamFor().tickerAt, now), messageAgeMs:streamAge(okxStream.lastMessageAt, now), contextAgeMs:streamAge(streamFor().contextAt, now), reconnects:okxStream.reconnects, lastError:okxStream.lastError }
    }); return;
  }
  if (url.pathname === '/api/market-context') {
    try { json(res, 200, await marketContext(url.searchParams.get('source') || 'okx')); }
    catch (e) { json(res, 503, { error:'Market context unavailable', detail:e.message }); }
    return;
  }
  if (url.pathname === '/api/sentiment') {
    try { json(res, 200, await fearGreedSentiment({ refresh:url.searchParams.get('refresh') === '1' })); }
    catch (e) { json(res, 503, { error:'Fear and Greed Index unavailable', detail:e.message }); }
    return;
  }
  if (url.pathname === '/api/fed-calendar') {
    try { json(res, 200, await fedMonitor()); }
    catch (e) { json(res, 503, { error:'Federal Reserve calendar unavailable', detail:e.message }); }
    return;
  }
  if (url.pathname === '/api/investment-calendar') {
    try { json(res, 200, await investmentCalendar({ refresh:url.searchParams.get('refresh') === '1' })); }
    catch (e) { json(res, 503, { error:'Investment calendar unavailable', detail:e.message }); }
    return;
  }
  if (url.pathname === '/api/news') {
    try { json(res, 200, await bitcoinNews({ refresh:url.searchParams.get('refresh') === '1' })); }
    catch (e) { json(res, 503, { error:'Bitcoin news unavailable', detail:e.message }); }
    return;
  }
  if (url.pathname === '/api/forecast-history') {
    const key = coinKey('forecast-history'), force = url.searchParams.get('refresh') === '1'; const hit = cache.get(key);
    try {
      if (!force && hit && Date.now() - hit.time < HISTORY_TTL) { json(res, 200, cacheResult(hit)); return; }
      const [intradayResult, dailyResult] = await Promise.all([forecastHistory('15m'), forecastHistory('1d')]);
      const value = { intraday:intradayResult.candles, daily:dailyResult.candles, source:`${intradayResult.source}/${dailyResult.source}`, fetchedAt:Date.now(), cached:false };
      remember(key, value); persistTrainingRun(value, force); json(res, 200, value);
    } catch (e) { json(res, 503, { error:'Forecast history unavailable', detail:e.message }); }
    return;
  }
  if (url.pathname === '/api/research-outlook') {
    try { json(res, 200, await researchOutlook({ refresh:url.searchParams.get('refresh') === '1' })); }
    catch (e) { json(res, 503, { error:'Research outlook unavailable', detail:e.message }); }
    return;
  }
  if (url.pathname === '/api/research-backfill') {
    try { json(res, 200, await researchBackfill({ refresh:url.searchParams.get('refresh') === '1' })); }
    catch (e) { json(res, 503, { error:'Research replay unavailable', detail:e.message }); }
    return;
  }
  // 消融实验：两臂各跑一次完整回放，因此比回放本身慢一倍，只按需触发。
  if (url.pathname === '/api/research-ablation') {
    try { json(res, 200, await researchAblation({ refresh:url.searchParams.get('refresh') === '1' })); }
    catch (e) { json(res, 503, { error:'Research ablation unavailable', detail:e.message }); }
    return;
  }
  // Every research threshold and weight, plus a fingerprint that identifies this exact
  // configuration. Two results may only be compared when their fingerprints match.
  // 全部研究门槛与权重，外加一个标识这套配置的指纹。只有指纹相同的结果才可互相比较。
  if (url.pathname === '/api/research-tuning') {
    try { json(res, 200, researchTuningReport()); }
    catch (e) { json(res, 500, { error:'Research tuning unavailable', detail:e.message }); }
    return;
  }
  // 宏观事件样本：默认读库秒回；refresh=1 才去 FRED / Fed 取数并重算窗口收益。
  if (url.pathname === '/api/macro-outcomes') {
    try {
      const backfill = url.searchParams.get('refresh') === '1' ? await backfillMacroEventOutcomes({ refresh:true }) : null;
      json(res, 200, { ...macroEventStudy(), backfill });
    } catch (e) { json(res, 503, { error:'Macro event study unavailable', detail:e.message }); }
    return;
  }
  // 资金费率历史：默认只读库（秒回），refresh=1 才回交易所分页取数。
  // Funding-rate history: reads the stored series by default and only hits the exchange on refresh.
  if (url.pathname === '/api/funding-rates') {
    try {
      const backfill = url.searchParams.get('refresh') === '1' ? await backfillFundingRates() : null;
      const rows = stmt('SELECT MIN(funding_at) AS firstAt, MAX(funding_at) AS lastAt, COUNT(*) AS total, AVG(rate) AS meanRate FROM funding_rate_history').get();
      json(res, 200, { ...FUNDING_SOURCE, stored: fundingRateCount(), firstAt: Number(rows?.firstAt) || null, lastAt: Number(rows?.lastAt) || null,
        meanRate: Number.isFinite(Number(rows?.meanRate)) ? Number(rows.meanRate) : null,
        featureRows: fundingFeatureSeries().length, coverageDays: Number(rows?.firstAt) && Number(rows?.lastAt) ? (Number(rows.lastAt) - Number(rows.firstAt)) / 86_400_000 : null,
        tuningFingerprint: tuningFingerprint(), backfill });
    } catch (e) { json(res, 503, { error:'Funding-rate history unavailable', detail:e.message }); }
    return;
  }
  if (url.pathname === '/api/research-candidates/train') {
    if(req.method!=='POST'){json(res,405,{error:'POST required'});return;}
    try { json(res, 201, await trainResearchCandidate()); }
    catch (e) { json(res,e.statusCode||503,{error:'Candidate training unavailable',detail:e.message}); }
    return;
  }
  if (url.pathname === '/api/ab-experiments') {
    json(res, 200, { updatedAt:Date.now(), experiments:abExperimentStatus(), policy:{ frozenA:true, autoSwitch:false, pairedSettlement:true } });
    return;
  }
  if (url.pathname === '/api/correlation-history') {
    const key = 'correlation-history'; const hit = cache.get(key);
    try {
      if (hit && Date.now() - hit.time < HISTORY_TTL) { json(res, 200, cacheResult(hit)); return; }
      const [btc, spy, qqq] = await Promise.all([forecastHistory('1d'), equityHistory('SPY'), equityHistory('QQQ')]);
      const value = { btc:btc.candles.map(x=>({time:x.time,close:x.close})), spy:spy.candles, qqq:qqq.candles, indexQuotes:{spy:spy.quote,qqq:qqq.quote}, sources:{btc:btc.source,spy:spy.source,qqq:qqq.source}, fetchedAt:Date.now(), cached:false };
      remember(key, value); json(res, 200, value);
    } catch (e) { json(res, 503, { error:'Correlation history unavailable', detail:e.message }); }
    return;
  }
  if (url.pathname === '/api/us-equity-quotes') {
    json(res, 200, await usEquityQuotes());
    return;
  }
  // 静态资源压缩：对文本类资源按客户端 Accept-Encoding 用 brotli/gzip 下发，
  // 显著减少首屏传输体积（app.js 934KB → ~250KB）。图片等已压缩格式跳过。
  // Static compression: serve text assets brotli/gzip per client Accept-Encoding,
  // cutting first-paint transfer size. Already-compressed binaries are skipped.
  const COMPRESSIBLE_TYPES = new Set([
    'text/html', 'text/css', 'text/javascript', 'application/javascript',
    'application/json', 'application/xml', 'image/svg+xml',
  ]);
  /* 压缩结果缓存 —— 没有它，brotliCompressSync(quality 11) 对 358KB 的 styles.css
     实测要 ~450ms/次，而且每次请求都重压：首屏浏览器并发取 8 个 CSS 时，这些同步
     压缩在 Node 主线程上串行排队，把首屏从几百毫秒拖到 1.7s+（实测 style.css
     91ms 发起→1751ms 才下载完）。缓存键含文件 mtime，改文件自动失效。
     同时把 brotli 质量从默认 11 降到 5：压缩耗时 ~450ms → ~30ms，体积几乎不变
     （styles.css 55KB → 约 60KB），让"首次未命中"也不再卡顿主线程。 */
  const COMPRESSED_CACHE_LIMIT = 96;
  const compressedCache = new Map();
  function cachedCompress(key, body, mode) {
    const hit = compressedCache.get(key);
    if (hit) return hit;
    const out =
      mode === 'br'
        ? brotliCompressSync(body, {
            params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 },
          })
        : gzipSync(body, { level: 6 });
    if (compressedCache.size >= COMPRESSED_CACHE_LIMIT)
      compressedCache.delete(compressedCache.keys().next().value);
    compressedCache.set(key, out);
    return out;
  }
  function sendCompressed(res, body, contentType, cacheControl, acceptEncoding, cacheKey) {
    const baseType = String(contentType || '').split(';')[0].trim();
    const headers = { 'content-type': contentType, 'cache-control': cacheControl };
    const enc = String(acceptEncoding || '').toLowerCase();
    if (COMPRESSIBLE_TYPES.has(baseType) && body.length > 1024) {
      if (enc.includes('br')) {
        const out = cachedCompress(`${cacheKey}|br`, body, 'br');
        headers['content-encoding'] = 'br';
        headers['content-length'] = out.length;
        res.writeHead(200, headers); res.end(out); return;
      }
      if (enc.includes('gzip')) {
        const out = cachedCompress(`${cacheKey}|gz`, body, 'gzip');
        headers['content-encoding'] = 'gzip';
        headers['content-length'] = out.length;
        res.writeHead(200, headers); res.end(out); return;
      }
    }
    headers['content-length'] = body.length;
    res.writeHead(200, headers); res.end(body);
  }
  /* mtime 参与缓存键：静态文件更新后立即重新压缩，不会下发旧内容。 */
  function compressionKey(file) {
    try { return `${file}#${statSync(file).mtimeMs}`; } catch { return `${file}#nostat`; }
  }

  // 显式服务根目录 shared/（前端 app.js 现以 ES Module 消费其中的指标实现，后端同样 import，
  // 保持单一事实来源）。单独路由以绕过 PUBLIC 目录隔离与穿越防护；自带 .. 与目录越界双重防护。
  if (url.pathname.startsWith('/shared/')) {
    const rel = normalize(url.pathname.slice('/shared/'.length)).replace(/^[/\\]+/, '');
    if (rel.includes('..')) { res.writeHead(403); res.end(); return; }
    const sharedRoot = join(process.cwd(), 'shared');
    const file = join(sharedRoot, rel);
    if (file !== sharedRoot && !file.startsWith(sharedRoot + sep)) { res.writeHead(403); res.end(); return; }
    try {
      const body = await readFile(file);
      sendCompressed(res, body, mime[extname(file)] || 'application/octet-stream', 'no-cache', req.headers['accept-encoding'], compressionKey(file));
    } catch { res.writeHead(404); res.end('Not found'); }
    return;
  }
  const relative = url.pathname === '/' ? 'index.html' : normalize(url.pathname).replace(/^[/\\]+/, '');
  if (relative.includes('..')) { res.writeHead(403); res.end(); return; }
  // 显式路径穿越防护：解析后的绝对路径必须仍落在 PUBLIC 目录内（含 PUBLIC 本身）。
  // 不依赖 normalize() 会丢弃越根 .. 的隐式行为——即使未来 URL 解码规则变化，这里也会硬拦。
  // Explicit traversal guard: the resolved absolute path must stay inside PUBLIC
  // (the PUBLIC dir itself included). Kept separate from the '..' check so the
  // protection never hinges on normalize()'s implicit leading-`..` dropping.
  const resolvedPath = resolve(PUBLIC, relative);
  if (resolvedPath !== PUBLIC && !resolvedPath.startsWith(PUBLIC + sep)) { res.writeHead(403); res.end(); return; }
  try {
    const file = join(PUBLIC, relative);
    const body = await readFile(file);
    // The dashboard's legacy HTML uses long-lived version query strings for
    // app.js/styles.css. Keep those two entry assets revalidatable locally so a
    // service restart can deliver feature updates without asking users to clear
    // a browser cache; fingerprinted images/fonts remain immutable.
    const immutable = (url.searchParams.has('v') || url.searchParams.has('t')) && !['app.js', 'styles.css'].includes(relative);
    sendCompressed(res, body, mime[extname(file)] || 'application/octet-stream', immutable ? 'public, max-age=31536000, immutable' : 'no-cache', req.headers['accept-encoding'], compressionKey(file));
  } catch (readError) {
    if (readError && readError.code !== 'ENOENT') console.error('[static]', readError.message);
    res.writeHead(404); res.end('Not found');
  }
  } catch (error) {
    console.error('[fatal] unhandled request error:', error && error.stack || error);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    if (!res.writableEnded) res.end(JSON.stringify({ error: 'Internal server error' }));
  }
})); }).listen(PORT, HOST, () => console.log(`BTC indicator: http://${HOST}:${PORT}`));

// Pre-warm the market cache at startup so the first page load never waits on a slow
// upstream REST fetch (which can take many seconds through the proxy).  Fired in the
// background; failures are ignored and the normal on-demand path still applies.
// 启动时预热市场缓存，让首次页面加载不必等缓慢的上游 REST 拉取（经代理时可能要数秒）。
// 后台触发，失败忽略，按需路径仍兜底。
const PREWARM_INTERVALS = ['15m', '1h', '4h', '1d'];
setTimeout(() => {
  for (const interval of PREWARM_INTERVALS) {
    for (const limit of [180, 300]) {
      for (const source of ['okx', 'gate']) market(interval, limit, source).catch(() => {});
    }
  }
}, 1500).unref?.();

// ---- Research sampling scheduler -----------------------------------------
// Forecasts used to be written only while somebody had the page open, which turned the
// sample into a convenience sample of "who visited".  Sampling and settlement now run on
// their own clock, so every bucket exists and every bucket is graded when it expires.
// 预测过去只在有人打开页面时才写入，样本因此变成「谁来过」的便利样本。
// 采样与结算现在各走自己的时钟：每个桶都会存在，每个桶到期即结算。
// Window definition revision.  2 = entry at the anchor bar close, settlement exactly one
// horizon later on a fully closed bar.  Anything older is not comparable.
// 窗口定义版本。2 = 入场取锚定 K 线收盘，结算恰好在一个持有期之后、且用已收盘的 K 线。
// 更早的行与它不可比。
const RESEARCH_WINDOW_VERSION = 2;
const RESEARCH_CYCLE_MS = 900_000;
const RESEARCH_SETTLE_MS = 60_000;
const RESEARCH_SOURCES = ['coinbase', 'gate', 'binance'];
function storedForecastHistories() {
  const histories = {};
  for (const interval of ['15m', '1d']) {
    for (const source of RESEARCH_SOURCES) {
      const candles = storedCandles(source, interval, 1000);
      if (candles.length) { histories[interval] = candles; break; }
    }
  }
  return histories;
}
function settleResearchFromStorage(now = Date.now()) {
  const histories = storedForecastHistories();
  if (!Object.keys(histories).length) return;
  settleResearchPredictions(histories, now);
}
function runResearchCycle() {
  researchOutlook({ refresh: true }).catch(error => console.warn('research cycle failed:', error && error.message));
}
// Rows that settled before the threshold existed still carry a direction and an actual
// return, so their three-class verdict can be recomputed from stored candles.
// 在阈值机制出现之前就已结算的行仍保留方向与真实收益，因此可以用库存 K 线重算三分类结论。
// The in-memory window only carries the newest 1000 candles, so buckets older than that
// never match an anchor and were silently left unlabelled. Read the stored range instead:
// one query per interval, spanning every pending bucket plus the lookback the volatility
// unit needs.
// 内存窗口只保留最新 1000 根 K 线，早于该窗口的桶匹配不到锚点，会被静默跳过而缺失标签。
// 改为按时间范围读库存 K 线：每个周期只查一次，覆盖全部待回填桶及其波动率回看窗口。
function storedCandleRange(interval, fromTime, toTime) {
  for (const source of RESEARCH_SOURCES) {
    const rows = stmt('SELECT candle_time AS time, open, high, low, close, volume FROM candles WHERE source=? AND interval=? AND candle_time>=? AND candle_time<=? ORDER BY candle_time ASC').all(source, interval, fromTime, toTime);
    const candles = rows.map(row => ({ time:+row.time, open:+row.open, high:+row.high, low:+row.low, close:+row.close, volume:+row.volume })).filter(validCandle);
    if (candles.length) return candles;
  }
  return [];
}
function backfillResearchOutcomeLabels() {
  const rows = stmt('SELECT id, bucket_at, horizon_key, candle_interval, actual_return FROM research_predictions WHERE settled_at IS NOT NULL AND outcome_label IS NULL ORDER BY bucket_at ASC').all();
  if (!rows.length) return 0;
  const statement = stmt('UPDATE research_predictions SET theta=?, outcome_label=? WHERE id=?'), ranges = new Map();
  let updated = 0;
  for (const row of rows) {
    const interval = row.candle_interval, span = interval === '1d' ? 24 * 86_400_000 : 24 * 900_000, bucketAt = Number(row.bucket_at);
    if (!ranges.has(interval)) {
      const bounds = rows.filter(item => item.candle_interval === interval).map(item => Number(item.bucket_at));
      ranges.set(interval, storedCandleRange(interval, Math.min(...bounds) - span, Math.max(...bounds) + 86_400_000));
    }
    const candles = ranges.get(interval) || [], actualReturn = Number(row.actual_return);
    if (!Number.isFinite(actualReturn) || !candles.length) continue;
    const horizon = row.horizon_key === '1d' ? 1 : row.horizon_key === '1h' ? 4 : row.horizon_key === '4h' ? 16 : 1;
    const anchorIndex = candles.findIndex(candle => Number(candle.time) === bucketAt);
    if (anchorIndex < 1) continue;
    const logReturns = [];
    for (let point = Math.max(1, anchorIndex - 19); point <= anchorIndex; point++) logReturns.push(Math.log(candles[point].close / candles[point - 1].close));
    const average = logReturns.reduce((sum, value) => sum + value, 0) / Math.max(logReturns.length, 1);
    const sigma = Math.sqrt(logReturns.reduce((sum, value) => sum + (value - average) ** 2, 0) / Math.max(logReturns.length, 1)) || 0.000001;
    const theta = chopThreshold(sigma, horizon);
    statement.run(theta, outcomeLabel(actualReturn, theta), row.id);
    updated += 1;
  }
  return updated;
}
const researchSettleTimer = setInterval(() => { try { settleResearchFromStorage(); } catch (error) { console.warn('research settle failed:', error && error.message); } }, RESEARCH_SETTLE_MS);
researchSettleTimer.unref?.();
setTimeout(() => {
  runResearchCycle();
  const researchCycleTimer = setInterval(runResearchCycle, RESEARCH_CYCLE_MS);
  researchCycleTimer.unref?.();
}, Math.max(5_000, RESEARCH_CYCLE_MS - (Date.now() % RESEARCH_CYCLE_MS))).unref?.();
try {
  const backfilled = backfillResearchOutcomeLabels();
  if (backfilled) console.log(`research: backfilled ${backfilled} three-class outcome labels`);
} catch (error) { console.warn('research backfill skipped:', error && error.message); }
