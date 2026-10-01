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
import { RESEARCH_TUNING } from './shared/research-tuning.mjs';
import { clamp, validCandle, percentChange, chopThreshold, sigmoid, logit } from './shared/ml-train.mjs';
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
    // 兜底：Key 被粘进「API 地址」框时自动收回当作 Key（旧缓存副本的前端可能还没归一化）。
    // Fallback: a key pasted into the URL field is moved back into the key slot.
    let qwenKey=value,qwenEndpoint=String(url||'').trim();
    if(qwenEndpoint&&/^sk-[A-Za-z0-9._-]{6,}$/i.test(qwenEndpoint)&&(!qwenKey||qwenKey===qwenEndpoint)){qwenKey=qwenEndpoint;qwenEndpoint='';}
    if (!qwenKey || qwenKey.length > 512) throw Object.assign(new Error('千问 API Key 必填，且不能超过 512 个字符'),{statusCode:400});
    // 端点留空时按 Key 前缀自动匹配（sk-sp- → Token Plan，否则 → DashScope）。
    // When the endpoint is blank, auto-match it from the key prefix.
    const baseUrl=qwenEndpoint ? validApiUrl(qwenEndpoint) : inferQwenBaseUrl(qwenKey);
    if (qwenEndpoint && !baseUrl) throw Object.assign(new Error('千问 API 地址必须是有效 HTTPS URL，且不能包含用户名或密码。'),{statusCode:400});
    const chosenModel=String(model || '').trim() || QWEN_DEFAULT_MODEL;
    if (chosenModel.length > 64) throw Object.assign(new Error('模型名称过长'),{statusCode:400});
    const verification={...(apiCredentials._verification||{})}; delete verification.qwen;
    apiCredentials={...apiCredentials,qwen:{key:qwenKey,baseUrl,model:chosenModel},_verification:verification}; saveApiCredentialsFile(); return;
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
  CREATE INDEX IF NOT EXISTS fed_calendar_snapshots_event_time ON fed_calendar_snapshots(event_key, observed_at DESC);
  CREATE TABLE IF NOT EXISTS btc_news_snapshots (
    id INTEGER PRIMARY KEY, observed_at INTEGER NOT NULL, published_at INTEGER,
    title TEXT NOT NULL, url TEXT, source TEXT, sentiment INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS btc_news_snapshots_title_time ON btc_news_snapshots(title, published_at);
  CREATE INDEX IF NOT EXISTS btc_news_snapshots_observed_time ON btc_news_snapshots(observed_at DESC);
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
let lastStorageCleanup = 0;
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
const FED_MARKET_SIGNALS_TTL = 120_000;
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
  orderBook:null, takerTrades:[], cvdNotional:0, flowBuy:0, flowSell:0, flowCache:null, flowComputedAt:0, bookAt:0, tradeAt:0,
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
    oi:null, oiUnit:coin, orderBook:null, takerTrades:[], cvdNotional:0, flowBuy:0, flowSell:0, flowCache:null, flowComputedAt:0,
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
// ── L1: 服务端 → 浏览器 SSE 实时推送 ──────────────────────────────────────
// 浏览器经 /api/stream 长连接订阅；每次 OKX WebSocket 推来新 ticker 即广播给所有
// 连接，消除「浏览器每 2s 轮询」的滞后，使报价延迟降到亚秒级、基本与 OKX 官网同步。
// 既有 /api/quote 的 2s 轮询保留为 SSE 断连时的降级。
const sseClients = new Set();
function broadcastSse(obj) {
  if (!sseClients.size) return;
  const data = `data: ${JSON.stringify(obj)}\n\n`;
  for (const client of sseClients) {
    if (client.symbol && client.symbol !== obj.coin) continue;
    try { client.res.write(data); } catch { /* 写失败者于 close 事件清理 */ }
  }
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
function recentTakerFlow(now = Date.now(), coin = currentCoin(), { force = false } = {}) {
  const st = streamFor(coin);
  const cutoff = now - 60_000;
  // 增量裁剪：只从队首弹出 60s 窗口外的旧成交，并同步扣减 running sum。
  // 每个成交在其生命周期内被弹出一次，平摊 O(1)；彻底消除「每条 trades 消息整体
  // filter+reduce 一遍 60s 窗口」的 O(N·消息率) 开销——高成交量时该开销撑爆单线程
  // 事件循环、拖慢 ticker→SSE 广播，即用户感知的 websocket 延迟飙升。
  const buf = st.takerTrades;
  let drop = 0;
  while (drop < buf.length && buf[drop].time < cutoff) {
    const t = buf[drop];
    if (t.side === 'buy') st.flowBuy -= t.notional; else if (t.side === 'sell') st.flowSell -= t.notional;
    drop++;
  }
  if (drop > 0) buf.splice(0, drop);
  // 节流：聚合数字对人眼无差别，热路径每条 trades 消息都调用本函数，但返回快照至多每
  // 250ms 重算一次；需强一致（如 REST /api/market）的调用方传 { force:true }。
  if (!force && st.flowCache && now - st.flowComputedAt < 250) return st.flowCache;
  const buys = st.flowBuy, sells = st.flowSell, total = buys + sells;
  const result = total > 0 ? {
    buyNotional:buys, sellNotional:sells, buyRatioPct:buys / total * 100,
    imbalancePct:(buys - sells) / total * 100, tradeCount:buf.length,
    cvd60Notional:buys - sells, cvdSessionNotional:st.cvdNotional,
    windowSeconds:60, updatedAt:st.tradeAt || null
  } : null;
  st.flowCache = result; st.flowComputedAt = now;
  return result;
}
// Voice rules are evaluated and spoken by the browser only.  The local server
// may retain settings for the active page, but must never speak after a tab
// closes or after macOS restarts.
const VOICE_STATE_FILE = join(DATA_DIR, 'voice_state.json');
const VOICE_HEARTBEAT_TIMEOUT_MS = 60_000; // 保留会话状态读数；不触发服务端接力
const VOICE_RELAY_INTERVAL_MS = 2_000;
const SERVER_VOICE_RELAY_ENABLED = false;
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
  // 音色来自前端下拉（Azure 音色表）：格式非法时这里**记一条告警再用默认音色** ——
  // 这是无人值守的服务端接力播报，出声比沉默重要；但绝不静默，日志里必须留痕。
  let safeVoice;
  try { safeVoice = resolveAzureVoice(voice); }
  catch (error) { console.warn(`[voice] relay ${error.message} → 回退默认音色`); safeVoice = 'zh-CN-XiaoxiaoNeural'; }
  const { audio } = await speechAudio(text.slice(0, 240), safeVoice);
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
    if (Object.values(ticker).every(Number.isFinite)) { st.ticker = ticker; st.tickerAt = now; inCoin(() => persistQuote('okx', ticker, now)); broadcastSse({ type:'ticker', coin, ticker:{ ...ticker }, tickerAt: now, serverTime: now }); }
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
      if (side && Number.isFinite(price) && Number.isFinite(size) && size > 0) {
        const notional = price * size;
        st.takerTrades.push({ time: now, side, notional });
        st.cvdNotional += side === 'buy' ? notional : -notional;
        if (side === 'buy') st.flowBuy += notional; else st.flowSell += notional;
        recordSyntheticOkxTrade(trade, coin, now);
      }
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
// ── 连通性真延时探测 ────────────────────────────────────────────────────────
// 面板过去显示的「上游 0 ms」是缓存短路造成的假象：业务端点命中缓存就直接返回，
// 根本不会发起上游请求，upstreamMs 自然恒为 0（绿灯也因而是假的）。这里绕开所有
// 业务缓存，由服务器直接向各服务商的真实端点发请求并计时，拿到的就是
// 「服务器 → 服务商」的真实往返延时 —— 慢的会显示成秒级并转红。
const CONNECTIVITY_PROBES = [
  { group: 'exchange', name: 'OKX', host: 'www.okx.com', url: 'https://www.okx.com/api/v5/public/time' },
  { group: 'exchange', name: 'Binance', host: 'api.binance.com', url: 'https://api.binance.com/api/v3/time' },
  { group: 'exchange', name: 'Coinbase', host: 'api.exchange.coinbase.com', url: 'https://api.exchange.coinbase.com/time' },
  { group: 'exchange', name: 'Gate.io', host: 'api.gateio.ws', url: 'https://api.gateio.ws/api/v4/spot/currencies?limit=1' },
  { group: 'exchange', name: 'Deribit', host: 'api.deribit.com', url: 'https://api.deribit.com/api/v2/public/time' },
  { group: 'macro', name: 'FRED 美联储经济数据', host: 'fred.stlouisfed.org', url: 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=UNRATE' },
  { group: 'macro', name: 'BLS 劳工统计局', host: 'api.bls.gov', url: 'https://api.bls.gov/publicAPI/v2/status' },
  { group: 'macro', name: '美国财政部 Treasury', host: 'home.treasury.gov', url: 'https://home.treasury.gov/' },
  { group: 'macro', name: '东方财富数据中心', host: 'datacenter-web.eastmoney.com', url: 'https://datacenter-web.eastmoney.com/api/data/v1/get' },
  { group: 'sentiment', name: '恐惧&贪婪 Alternative.me', host: 'api.alternative.me', url: 'https://api.alternative.me/fng/' },
  { group: 'sentiment', name: 'CoinGecko', host: 'api.coingecko.com', url: 'https://api.coingecko.com/api/v3/ping' },
  { group: 'sentiment', name: 'mempool.space 链上', host: 'mempool.space', url: 'https://mempool.space/api/blocks/tip/height' },
  { group: 'service', name: 'Google News', host: 'news.google.com', url: 'https://news.google.com/rss/search?q=bitcoin' },
  { group: 'service', name: 'Yahoo Finance', host: 'query1.finance.yahoo.com', url: 'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1d&interval=1d' },
  // DashScope 不带凭据会回 401、语音实际走的是下面的 WebSocket 网关：
  // 非 2xx 同样说明服务端连得上，探测看的是「到服务端的往返」，不是这条路径有没有数据。
  { group: 'service', name: '阿里云通义 DashScope', host: 'dashscope.aliyuncs.com', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/models' },
  { group: 'service', name: 'Microsoft Azure AI Speech', host: 'eastasia.tts.speech.microsoft.com', url: 'https://eastasia.tts.speech.microsoft.com/tts/cognitiveservices/voices/list' },
];
const CONNECTIVITY_PROBE_TIMEOUT = 8_000;
async function probeSingleConnectivity(probe) {
  const started = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONNECTIVITY_PROBE_TIMEOUT);
  try {
    const r = await fetch(probe.url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { accept: 'application/json,text/plain,*/*', 'user-agent': 'BTC-Indicator/ConnectivityProbe' },
    });
    const ms = Math.round(performance.now() - started);
    // 延时算到「拿到响应头」为止：不要接着读 body，否则大文件会把下载时间也算进去，
    // 探测出来的就不是网络往返了。
    try { await r.arrayBuffer(); } catch { /* 只用于释放连接，不影响已记录的耗时 */ }
    return { ...probe, ms, ok: true, status: r.status };
  } catch (error) {
    return {
      ...probe,
      ms: Math.round(performance.now() - started),
      ok: false,
      status: 0,
      error: error?.name === 'AbortError' ? `timeout ${CONNECTIVITY_PROBE_TIMEOUT}ms` : String(error?.message || error),
    };
  } finally {
    clearTimeout(timer);
  }
}
async function runConnectivityProbe() {
  return Promise.all(CONNECTIVITY_PROBES.map(probeSingleConnectivity));
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
    // 根因修复（K 线抖动）：合成蜡烛的最后一根是「正在形成」的蜡烛，其 close 停留在上一次
    // flush（≤1s）或最后一笔成交价，落后于实时 ticker。把实时价对齐到最后一根，使 REST
    // 快照本身即携带 live close；浏览器 loadCurrent 整体替换 state.candles 时不再把实时长阳线
    // 打回旧快照，消除「长线忽然出现/消失」的抖动（客户端另有冗余防线）。
    if (Number.isFinite(ticker.last) && candles.length) {
      const last = candles[candles.length - 1];
      const px = ticker.last;
      last.close = px;
      if (px > last.high) last.high = px;
      if (px < last.low) last.low = px;
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
  // ⚠️ 实测（2026-10-01）：Yahoo 的 ^TNX 现在直接报收益率百分比（5.293 = 5.29%），
  // 不再是历史上的「收益率 ×10」量纲 —— 直接透传，不做换算。
  const us10YieldSignal = (quote) => {
    const last = Number(quote?.last), previous = Number(quote?.previous);
    if (!Number.isFinite(last) || last <= 0) return { key:'us10y', name:'美国10年期国债收益率', available:false, source:'Yahoo Finance', detail:'公开行情暂不可用' };
    return { key:'us10y', name:'美国10年期国债收益率', available:true, value:last, changePct:Number.isFinite(previous) && previous ? (last / previous - 1) * 100 : null, source:'Yahoo Finance', cadence:'日线' };
  };
  const key='fed-market-signals', hit=cache.get(key), now=Date.now();
  if (hit && now-hit.time<FED_MARKET_SIGNALS_TTL) return cacheResult(hit, now);
  return coalesce(key, async () => {
    // v2.12.53：按用户对照表补齐缺失的实时宏观指标 —— 纳指100 / 标普500 / 美10Y收益率 /
    // 美元兑离岸人民币 / 布伦特原油。全部走 Yahoo Finance 免费日线（与既有四路同源同口径）。
    // ⚠️ ^TNX 直接报收益率百分比（5.293 = 5.29%），见下方 us10YieldSignal 注释。
    const [gold,dxy,ndx,spx,us10y,wti,brent,cnh,vix,coingecko,coinlore] = await Promise.allSettled([
      yahooHistory('GC=F'),
      yahooHistory('DX-Y.NYB'),
      yahooHistory('^NDX'),
      yahooHistory('^GSPC'),
      yahooHistory('^TNX'),
      yahooHistory('CL=F'),
      yahooHistory('BZ=F'),
      yahooHistory('CNH=X'),
      yahooHistory('^VIX'),
      request('https://api.coingecko.com/api/v3/global', 8_000, COINGECKO_API_KEY ? { 'x-cg-demo-api-key':COINGECKO_API_KEY } : {}),
      request('https://api.coinlore.net/api/global/', 8_000)
    ]);
    const unavailable=(name)=>({ key:name, name, available:false, source:'Yahoo Finance', detail:'公开行情暂不可用' });
    const market=[];
    market.push(gold.status==='fulfilled' ? dailySignal('gold','黄金指数',gold.value.quote,'Yahoo Finance') : unavailable('黄金指数'));
    market.push(dxy.status==='fulfilled' ? dailySignal('dxy','美元指数',dxy.value.quote,'Yahoo Finance') : unavailable('美元指数'));
    market.push(ndx.status==='fulfilled' ? dailySignal('ndx','纳斯达克100',ndx.value.quote,'Yahoo Finance') : unavailable('纳斯达克100'));
    market.push(spx.status==='fulfilled' ? dailySignal('spx','标普 500',spx.value.quote,'Yahoo Finance') : unavailable('标普 500'));
    market.push(us10y.status==='fulfilled' ? us10YieldSignal(us10y.value.quote) : { key:'us10y', name:'美国10年期国债收益率', available:false, source:'Yahoo Finance', detail:'公开行情暂不可用' });
    market.push(wti.status==='fulfilled' ? dailySignal('wti','WTI 原油',wti.value.quote,'Yahoo Finance') : unavailable('WTI 原油'));
    market.push(brent.status==='fulfilled' ? dailySignal('brent','布伦特原油',brent.value.quote,'Yahoo Finance') : unavailable('布伦特原油'));
    market.push(cnh.status==='fulfilled' ? dailySignal('cnh','美元/离岸人民币',cnh.value.quote,'Yahoo Finance') : unavailable('美元/离岸人民币'));
    market.push(vix.status==='fulfilled' ? dailySignal('vix','VIX 波动率',vix.value.quote,'Yahoo Finance') : unavailable('VIX 波动率'));
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
// Persistent memory of expected / previous values per macro event signature.
// The domestic Eastmoney feed carries no estimates / previous; those come from the
// supplementary TradingView / FinanceCalendar feeds. When those briefly fail
// (Promise.allSettled rejects), every macro card blanks its numbers. We cache the
// last good estimate / previous per signature and backfill on outage. Only
// estimate / previous are cached — actual values are published facts and are
// never backfilled.
const macroValueMemory = new Map();
const MACRO_VALUE_MEMORY_FILE = join(DATA_DIR, 'macro-values-cache.json');
(function loadMacroValueMemory() {
  try {
    const raw = readFileSync(MACRO_VALUE_MEMORY_FILE, 'utf8');
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) {
        if (v && typeof v === 'object') macroValueMemory.set(k, { estimate: v.estimate ?? null, previous: v.previous ?? null });
      }
    }
  } catch {}
})();
function persistMacroValueMemory() {
  try {
    const cutoff = Date.now() - 40 * 86_400_000;
    const obj = {};
    for (const [k, v] of macroValueMemory) {
      const day = String(k).split('|').pop();
      const t = day ? Date.parse(day) : NaN;
      if (Number.isFinite(t) && t < cutoff) { macroValueMemory.delete(k); continue; }
      obj[k] = v;
    }
    writeFileSync(MACRO_VALUE_MEMORY_FILE, JSON.stringify(obj));
  } catch {}
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
    // Memory layer: refresh the cache with this round's successful values, then
    // backfill any still-missing estimate / previous from the last good fetch.
    for (const ev of domesticEvents) {
      const sig = macroSig(ev);
      if (!sig) continue;
      const est = ev.estimate ?? null, prev = ev.previous ?? null;
      if (est || prev) {
        const existing = macroValueMemory.get(sig) || {};
        macroValueMemory.set(sig, { estimate: est ?? existing.estimate ?? null, previous: prev ?? existing.previous ?? null });
      }
    }
    persistMacroValueMemory();
    for (const ev of domesticEvents) {
      const sig = macroSig(ev);
      if (!sig) continue;
      const mem = macroValueMemory.get(sig);
      if (!mem) continue;
      const had = ev.actual ?? ev.estimate ?? ev.previous;
      ev.estimate = ev.estimate ?? mem.estimate ?? null;
      ev.previous = ev.previous ?? mem.previous ?? null;
      if (!had && (ev.estimate ?? ev.previous) && !ev.source.includes('·')) {
        ev.source = `${ev.source} · 缓存回填`;
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
// request and silently change what the research outlook means. Set BTC_RESEARCH_TUNING to a
// JSON object shaped like this block; it is deep-merged over the defaults at startup.
//
// 研究模块靠一堆常数给自己打分（震荡带倍数、独立样本门槛、成本模型、融合权重）。散在十几个函数里
// 既无法一起审查，也无法按实验调整。这个块是这些数字的唯一所在地，凡读取研究门槛的地方都从这里读。
//
// 覆盖只能走环境变量，运行中的服务绝不会被客户端请求改配置、从而悄悄改变研究预测的含义。
// 把 BTC_RESEARCH_TUNING 设成与本块同形的 JSON 对象即可，它会在启动时深合并到默认值之上。
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
function dominantDirection(probabilities) {
  const entries=[['up',Number(probabilities?.up)||0],['flat',Number(probabilities?.flat)||0],['down',Number(probabilities?.down)||0]].sort((a,b)=>b[1]-a[1]);
  return entries[0][1] > 0 ? entries[0][0] : 'flat';
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
      return { ...definition, upProbability, downProbability, flatProbability, directionalProbability, rawProbability, entryPrice, bucketAt, targetAt, theta:Number(history.theta)||null, expectedReturn:adjustedReturn, expectedMove:last*adjustedReturn, expectedPrice:last*(1+adjustedReturn), direction, samples:history.samples, candidateCount:history.candidateCount, matchQuality:history.matchQuality, regime:history.regime, blend:{analogueWeight,modelWeight:1-analogueWeight}, volatilityUnit, distribution, priceRange:{p10:last*(1+widened.p10),p50:last*(1+widened.p50),p90:last*(1+widened.p90)}, eventRangeMultiplier, candleInterval:definition.interval, validation:fusion?.validation || null };
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
    const primary=windows[2];
    const rankedNews=[...newsItems].map(item=>{const ageHours=Number.isFinite(item.publishedAt)?Math.max(0,(now-item.publishedAt)/3_600_000):6;return {...item,impact:Math.abs(item.sentiment)*(item.sourceWeight||.7)*(item.eventWeight||.7)*Math.exp(-ageHours/4)}}).sort((a,b)=>b.impact-a.impact || (b.publishedAt||0)-(a.publishedAt||0));
    const dxy=macro?.market?.find(row=>row.key==='dxy');
    const result={ price:last, windows, news:{ source:news.source, fetchedAt:news.fetchedAt, bullish, bearish, neutral:newsItems.length-bullish-bearish, score:newsScore, halfLifeHours:4, items:rankedNews.slice(0,6) }, sentiment:sentiment?{ value:sentiment.value, source:sentiment.source || 'Alternative.me' }:null, derivatives:derivatives?{ source:derivatives.source, score:microstructureScore, fundingRate:derivatives.fundingRate, oiChangePct:derivatives.oiChangePct, bookImbalancePct:derivatives.orderBook?.imbalancePct, ofiPct:derivatives.orderBook?.ofiPct, takerImbalancePct:derivatives.takerFlow?.imbalancePct, cvdSessionNotional:derivatives.takerFlow?.cvdSessionNotional, coverage:['funding','oi-change','order-book','taker-flow','cvd','basis'], collecting:['OFI / top-5 displayed-liquidity changes'], unavailable:['funding term structure / long-short ratio','options PCR / 25Δ skew / IV term structure','liquidation heatmap','spot ETF net flows','on-chain exchange / whale flows','Coinbase and Kimchi premiums'] }:null, macro:{ dxy:dxy?.available?{value:dxy.value,changePct:dxy.changePct,source:dxy.source}:null, status:'DXY is displayed for context only until time-aligned history is validated.' }, eventRisk, historical:{ intradaySource:intraday.source, dailySource:daily.source, intradaySamples:intraday.candles.length, dailySamples:daily.candles.length }, primary, fetchedAt:now, refreshMs:NEWS_TTL, cached:false, disclaimer:'Calibrated historical-model research only; not investment advice.' };
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
function usMarketState() {
  // 按美东时间推算盘前/盘中/盘后（美股常规交易 09:30–16:00 ET，周一至周五）。
  // ⚠️ 必须保持「同步」：调用方 tencentLiveEquityQuote 直接取返回值塞进 marketState。
  // 这里若改成 async，漏掉 await 会把 Promise 序列化成 {}，使 marketState 永远不等于
  // 'REGULAR'、open 恒为 false —— 顶部美股条在盘中永远不出现（2026-09-22 踩过这个坑）。
  // 用 formatToParts + hourCycle:'h23' 取字段，避免 new Date(toLocaleString(...)) 对非 ISO 串的宽松解析。
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const get = type => parts.find(x => x.type === type)?.value;
  if (['Sat', 'Sun'].includes(get('weekday'))) return 'CLOSED';
  const mins = Number(get('hour')) * 60 + Number(get('minute'));
  if (mins < 9 * 60 + 30) return 'PRE';
  if (mins < 16 * 60) return 'REGULAR';
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
      return result;
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
// ---------------------------------------------------------------------------
// 语音合成：Azure AI Speech Service（微软官方 REST 服务，主链路）
// 兜底：Edge TTS（同为微软服务，无 key 或 Azure 失败时使用）
// 本地 Piper 已彻底移除：它需要 sidecar 容器、音质差，而 compose 里从未部署过它，
// 所以这条分支一直在打一个不存在的地址。
// 凭据优先级：环境变量 AZURE_SPEECH_KEY / AZURE_SPEECH_REGION → 加密凭据文件（含 region）。
// ---------------------------------------------------------------------------
const AZURE_TTS_TIMEOUT_MS = 15_000;
const AZURE_TTS_OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const AZURE_VOICES_TTL_MS = 24 * 60 * 60 * 1000;
const AZURE_VOICES_CACHE_FILE = join(DATA_DIR, 'azure-voices.json');
let azureVoicesCache = null;
function azureSpeechCredential() {
  const saved = apiCredentials.azureSpeech && typeof apiCredentials.azureSpeech === 'object' ? apiCredentials.azureSpeech : {};
  const key = String(process.env.AZURE_SPEECH_KEY || saved.key || '').trim();
  const region = String(process.env.AZURE_SPEECH_REGION || saved.region || '').trim();
  return key && region ? { key, region } : null;
}
// 播报文本会被拼进 XML 节点、音色名拼进 XML 属性：文本必须转义、音色名必须格式校验。
// 否则一段带尖括号的行情文案就能把整条 SSML 冲垮，或让 Azure 直接返回 400。
const escapeSsml = value => String(value).replace(/[&<>"']/g, ch => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;' }[ch]));
const AZURE_VOICE_PATTERN = /^[a-z]{2}-[A-Za-z0-9-]{2,60}(?::[A-Za-z0-9-]{2,60})?$/;
/* ⚠️ 白名单必须放行冒号：Azure 的 ShortName 有两种形态 —— 经典 `zh-CN-YunhaoNeural`，
   以及带代次后缀的 `zh-CN-Yunhan:DragonHDLatestNeural`（HD 超清 / 极速 / MAI 二代中文音色
   全是这种冒号写法）。旧表 /^[a-z]{2}-[A-Za-z0-9-]{2,60}$/ 把带代次的音色全判成非法，
   再「静默替换成 zh-CN-XiaoxiaoNeural」—— 症状是「点任何 HD 男声都念同一个女声」，
   与其它故障极难区分（2026-09-22 实测：云瀚 / 云泽 HD 与晓晓的音频字节长度完全相同，
   而真正生效的经典音色长度各不相同）。校验只为挡 SSML 注入，故只须禁掉空白与引号尖括号。
   Voice names for HD/MAI Chinese voices contain a colon; the old pattern silently downgraded
   every one of them to Xiaoxiao (female), which is impossible to distinguish from other bugs. */
/* 音色解析：**没给名字**才用默认；给了但格式非法一律报错，绝不悄悄换成另一个音色 ——
   让用户听到的不是他选的音色，这类静默降级比直接失败危险得多。 */
const resolveAzureVoice = voice => {
  const name = String(voice || '').trim();
  if (!name) return 'zh-CN-XiaoxiaoNeural';
  if (!AZURE_VOICE_PATTERN.test(name))
    throw Object.assign(new Error(`Invalid Azure voice name: ${name.slice(0, 60)}`), { code: 'INVALID_VOICE', statusCode: 400 });
  return name;
};
// zh-CN → zh-CN、zh-CN-liaoning-XiaobeiNeural → zh-CN（locale 永远取前两段）。
const azureVoiceLocale = voice => (/^[a-z]{2}-[A-Za-z]{2}/.exec(String(voice)) || ['en-US'])[0];
async function azureTtsAudio(text, voice = 'zh-CN-XiaoxiaoNeural', attempts = 2) {
  if (!hasSpeakableContent(text)) throw Object.assign(new Error('Voice text has no pronounceable content'), { code: 'EMPTY_TEXT' });
  const credential = azureSpeechCredential();
  if (!credential) throw Object.assign(new Error('Azure Speech key/region not configured'), { code: 'NO_CREDENTIAL' });
  const safeVoice = resolveAzureVoice(voice);
  const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${azureVoiceLocale(safeVoice)}'>`
    + `<voice name='${escapeSsml(safeVoice)}'><prosody rate='+5%'>${escapeSsml(text)}</prosody></voice></speak>`;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), AZURE_TTS_TIMEOUT_MS);
    try {
      const response = await fetch(`https://${credential.region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': credential.key,
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': AZURE_TTS_OUTPUT_FORMAT,
          'User-Agent': 'btc-indicator',
        },
        body: ssml,
        signal: ctrl.signal,
      });
      const body = Buffer.from(await response.arrayBuffer());
      if (!response.ok) throw new Error(`Azure Speech HTTP ${response.status}${body.length ? ` ${body.toString('utf8').slice(0, 200)}` : ''}`);
      if (!body.length) throw new Error('Azure Speech returned no audio');
      return body;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 350 * attempt));
    } finally { clearTimeout(timer); }
  }
  throw lastError;
}
// 统一合成入口：Azure 优先，失败回退 Edge，engine 会随响应头发回给前端便于诊断。
async function speechAudio(text, voice) {
  try { return { audio: await azureTtsAudio(text, voice), engine: 'azure' }; }
  catch (error) {
    if (error.code === 'EMPTY_TEXT' || error.code === 'INVALID_VOICE') throw error;
    // 没配凭据时不算故障，静默走 Edge；配了却失败才告警，便于定位 key/额度问题。
    if (azureSpeechCredential()) console.warn(`[voice] Azure Speech failed, falling back to Edge: ${error.message}`);
    try { return { audio: await edgeTtsAudio(text, voice), engine: 'edge' }; }
    catch (edgeError) {
      // 两条链路都失败时把 Azure 的原因也带上：Edge 的报错常是「WebSocket closed abnormally:
      // [object Object]」这类糊状信息，单看它无从判断是音色不可用、额度还是网络。
      throw Object.assign(new Error(`Azure: ${error.message} / Edge: ${edgeError.message}`), { code: error.code });
    }
  }
}
// 音色清单：Azure 区域可用的全部音色。官方路径带 /tts 前缀，个别区域仍收旧路径，两条都试。
async function azureVoices(force = false) {
  const credential = azureSpeechCredential();
  if (!credential) throw Object.assign(new Error('尚未配置 Azure Speech 的密钥与区域'), { code: 'NO_CREDENTIAL', statusCode: 400 });
  if (!force && azureVoicesCache && Date.now() - azureVoicesCache.fetchedAt < AZURE_VOICES_TTL_MS) return azureVoicesCache.voices;
  if (!force && !azureVoicesCache) {
    try {
      const cached = JSON.parse(readFileSync(AZURE_VOICES_CACHE_FILE, 'utf8'));
      if (cached?.voices?.length && Date.now() - cached.fetchedAt < AZURE_VOICES_TTL_MS) { azureVoicesCache = cached; return azureVoicesCache.voices; }
    } catch { /* 无缓存或缓存过期：重新拉取 */ }
  }
  const urls = [
    `https://${credential.region}.tts.speech.microsoft.com/tts/cognitiveservices/voices/list`,
    `https://${credential.region}.tts.speech.microsoft.com/cognitiveservices/voices/list`,
  ];
  let voices = null, lastError = null;
  for (const endpoint of urls) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    try {
      const response = await fetch(endpoint, { headers: { 'Ocp-Apim-Subscription-Key': credential.key }, signal: ctrl.signal });
      if (!response.ok) { lastError = new Error(`Azure voices HTTP ${response.status} via ${endpoint}`); continue; }
      const raw = await response.json();
      voices = raw
        .map(item => ({
          name: item.ShortName, display: item.DisplayName, local: item.LocalName,
          locale: item.Locale, localeName: item.LocaleName, gender: item.Gender,
          type: item.VoiceType, styles: item.StyleList || [], sampleRate: item.SampleRateHertz,
        }))
        .filter(item => item.name);
      break;
    } catch (error) { lastError = error; }
    finally { clearTimeout(timer); }
  }
  if (!voices) throw lastError || new Error('Azure voices list unavailable');
  azureVoicesCache = { fetchedAt: Date.now(), voices };
  try { writeFileSync(AZURE_VOICES_CACHE_FILE, JSON.stringify(azureVoicesCache), { mode: 0o600 }); } catch { /* 缓存写失败不影响主流程 */ }
  return voices;
}
/* 带代次的音色（ShortName 里带冒号：DragonHD… / MAI-Voice…）只在少数区域可用 ——
   官方文档列的可用区域是 southeastasia、centralindia、swedencentral、westeurope、
   eastus、eastus2、westus2，**eastasia 不在其中**：这些音色在 TTS 接口上一律回 400
   （响应体为空），可音色清单里照样列着它们 →「列表里有、选了却合成不出来」，
   旧代码更会静默换成晓晓（女声）。这里用一次 6 个字符的探测把「本区域能否合成 HD」
   变成可下发的事实，前端据此把不可用的音色置灰并说明原因。探测结果缓存一天，
   失败也只是一次请求，不影响清单下发。 */
const AZURE_HD_PROBE_VOICE = 'en-US-Ava:DragonHDLatestNeural';
let azureHdProbe = null;
async function azureHdSupported() {
  if (azureHdProbe && Date.now() - azureHdProbe.at < AZURE_VOICES_TTL_MS) return azureHdProbe.supported;
  let supported = false;
  try { await azureTtsAudio('Voice test', AZURE_HD_PROBE_VOICE, 1); supported = true; }
  catch { supported = false; }
  azureHdProbe = { supported, at: Date.now() };
  return supported;
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
  // Kronos 推理服务反向代理：/api/kronos/* 转发到 KRONOS_SERVICE_URL（默认 127.0.0.1:8799），
  // 绕开 CORS、统一出口；生产 Docker 内由 app 服务的环境变量指向 http://kronos:8799。
  if (url.pathname.startsWith('/api/kronos')) {
    try {
      const target = `${process.env.KRONOS_SERVICE_URL || 'http://127.0.0.1:8799'}${req.url}`;
      // Kronos 推理/回测可能冷算很久：forecast 加载模型+推理约 40~80 秒，daily backtest 30 锚点约 6~9 分钟。
      // 服务端代理超时必须覆盖这个耗时，否则前端 FETCH_TIMEOUT 还没触发，服务端就先 abort 返回 502。
      const isBacktest = url.pathname === '/api/kronos/backtest';
      const timeoutMs = isBacktest ? 600_000 : 120_000;
      const upstream = await fetch(target, { method: req.method, signal: AbortSignal.timeout(timeoutMs) });
      const body = await upstream.text();
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8' });
      res.end(body);
    } catch (e) {
      json(res, 502, { error: 'Kronos service unreachable', detail: e.message });
    }
    return;
  }
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
  // 连通性面板的「服务器 → 服务商」真实延时。这里刻意不使用 request()/requestText()，
  // 也不读任何业务缓存：每次都真打到上面的服务商端点，慢的会如实显示在秒级。
  if (url.pathname === '/api/connectivity-probe') {
    try { json(res,200,{ probes: await runConnectivityProbe(), timeoutMs: CONNECTIVITY_PROBE_TIMEOUT }); }
    catch(error) { json(res,500,{ error:'connectivity probe failed', detail:String(error?.message||error) }); }
    return;
  }
  // Azure Speech 音色清单：前端据此按界面语言接入全部中文 / 英文音色（含粤语、方言）。
  if (url.pathname === '/api/voice/azure/voices' && req.method === 'GET') {
    try {
      const voices = await azureVoices(url.searchParams.get('refresh') === '1');
      // hdSupported 只作提示（前端据此置灰不可用音色）；探测本身失败不影响清单下发。
      const hdSupported = await azureHdSupported().catch(() => false);
      json(res,200,{ voices, count:voices.length, engine:'azure', hdSupported });
    } catch(error) {
      if (error.code === 'NO_CREDENTIAL') json(res,400,{ error:'Azure Speech not configured', configured:false });
      else json(res,502,{ error:'Azure voices unavailable', detail:String(error?.message||error) });
    }
    return;
  }
  // 语音链路自检：合成一句极短音频，回报真实使用的引擎与耗时，方便分辨走了 Azure 还是 Edge。
  if (url.pathname === '/api/voice/azure/verify' && req.method === 'POST') {
    try {
      const started = performance.now();
      const { audio, engine } = await speechAudio('Azure 语音服务连接正常', 'zh-CN-XiaoxiaoNeural');
      json(res,200,{ ok:true, engine, ms:Math.round(performance.now()-started), bytes:audio.length });
    } catch(error) { json(res,502,{ ok:false, error:'Voice synthesis failed', detail:String(error?.message||error) }); }
    return;
  }
  if (url.pathname === '/api/voice/edge' && req.method==='POST') {
    try {
      const {text,voice}=await readJson(req),safeText=String(text||'').trim();
      // 长度校验属于请求问题，直接 400；不要落进下面的上游 catch 被报成 503。
      if(!safeText||safeText.length>240) { json(res,400,{error:'Voice text must be 1–240 characters',detail:'播报文本长度需在 1–240 个字符之间'}); return; }
      // 音色名会拼进 SSML 属性：Azure 有 400+ 音色（含各方言与 HD/MAI 代次），这里只做格式白名单校验，
      // 且**非法即报 400，不替换**（替换会让人听到并非自己选的音色）。
      const safeVoice=resolveAzureVoice(voice);
      const { audio, engine } = await speechAudio(safeText, safeVoice);
      res.writeHead(200,{'content-type':'audio/mpeg','cache-control':'no-store','content-length':audio.length,'x-voice-engine':engine});res.end(audio);
    } catch(error) {
      // 文本无可朗读内容属于请求本身的问题，返回 400 并说明原因；只有上游真的
      // 不可用才返回 503，避免把「探针文本选错」误报成服务故障。
      // Unpronounceable text is a bad request, not an upstream outage.
      if (error.code === 'EMPTY_TEXT') json(res,400,{error:'Voice text has no pronounceable content',detail:'文本中没有可朗读的字母、数字或汉字，无法合成语音'});
      else if (error.code === 'INVALID_VOICE') json(res,400,{error:'Voice name rejected',detail:'音色名格式非法（只接受 Azure 音色表里的 ShortName）'});
      else json(res,503,{error:'Voice synthesis unavailable',detail:error.message});
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
  if (url.pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.setTimeout(0);
    res.write('retry: 3000\n\n');
    res.write(': connected\n\n');
    const symbol = (url.searchParams.get('symbol') || '').toUpperCase() || null;
    const client = { res, symbol };
    sseClients.add(client);
    // 连接即推一帧当前快照，浏览器无需空等下一个 tick。
    try {
      const st = streamFor(symbol || currentCoin());
      if (st.ticker) res.write(`data: ${JSON.stringify({ type:'ticker', coin: symbol || currentCoin(), ticker:{ ...st.ticker }, tickerAt: st.tickerAt, serverTime: Date.now() })}\n\n`);
    } catch { /* 快照缺失不致命 */ }
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15_000);
    ping.unref?.();
    req.on('close', () => { clearInterval(ping); sseClients.delete(client); });
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
const RESEARCH_CYCLE_MS = 900_000;
function runResearchCycle() {
  researchOutlook({ refresh: true }).catch(error => console.warn('research cycle failed:', error && error.message));
}
setTimeout(() => {
  runResearchCycle();
  const researchCycleTimer = setInterval(runResearchCycle, RESEARCH_CYCLE_MS);
  researchCycleTimer.unref?.();
}, Math.max(5_000, RESEARCH_CYCLE_MS - (Date.now() % RESEARCH_CYCLE_MS))).unref?.();
