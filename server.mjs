import http from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { extname, join, normalize } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Communicate } from 'edge-tts.js';
import { createAiChat, DEFAULT_MODEL as QWEN_DEFAULT_MODEL } from './ai-chat.mjs';
import { createAlertStore } from './alert-store.mjs';

// BTC 指标服务端：负责静态页面、公开数据源、SQLite 快照与实时 OKX 连接。
// BTC indicator backend: serves the UI, public data sources, SQLite snapshots, and the live OKX connection.

// 进程级兜底：任何漏网的 rejection / 异常只记录，不再导致整个行情服务崩溃（launchd 拉起前仍有窗口期）。
// Process-level safety net: a stray rejection or exception is logged, never crashes the whole service.
process.on('unhandledRejection', (reason) => console.error('[fatal] unhandledRejection:', reason));
process.on('uncaughtException', (error) => console.error('[fatal] uncaughtException:', error && error.stack || error));

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
const database = new DatabaseSync(join(DATA_DIR, 'market.sqlite'));
const alertStore = await createAlertStore();
if (!alertStore.enabled) console.warn(`Server-side alerts disabled: ${alertStore.reason}`);
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
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
`);
// 为既有数据库补充日历回退标识，迁移可重复执行。
// Add the calendar fallback flag to existing databases; this migration is safe to rerun.
try { database.exec('ALTER TABLE fed_calendar_snapshots ADD COLUMN is_fallback INTEGER NOT NULL DEFAULT 0'); }
catch (error) { if (!/duplicate column name/i.test(error.message)) throw error; }
try { database.exec('ALTER TABLE derivative_snapshots ADD COLUMN ofi_pct REAL'); }
catch (error) { if (!/duplicate column name/i.test(error.message)) throw error; }
const storeQuote = database.prepare('INSERT INTO quote_snapshots (source, observed_at, last, open24h, change_pct, high24, low24) VALUES (?, ?, ?, ?, ?, ?, ?)');
const storeCandle = database.prepare('INSERT OR IGNORE INTO candles (source, interval, candle_time, open, high, low, close, volume, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
const updateCandle = database.prepare('UPDATE candles SET open=?, high=?, low=?, close=?, volume=?, updated_at=? WHERE source=? AND interval=? AND candle_time=?');
// OKX does not publish sub-minute candles for this perpetual contract.  These
// rows are built strictly from the public OKX trade stream and remain local.
const upsertSyntheticOkxCandle = database.prepare(`INSERT INTO candles
  (source, interval, candle_time, open, high, low, close, volume, updated_at)
  VALUES ('okx', ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(source, interval, candle_time) DO UPDATE SET
    high=MAX(candles.high, excluded.high), low=MIN(candles.low, excluded.low),
    close=excluded.close, volume=candles.volume + excluded.volume,
    updated_at=excluded.updated_at`);
const storeMarketSnapshot = database.prepare('INSERT INTO market_snapshots (source, interval, observed_at, candle_count, last, cached) VALUES (?, ?, ?, ?, ?, ?)');
const storeTrainingRun = database.prepare('INSERT INTO training_runs (observed_at, source, intraday_count, daily_count, forced) VALUES (?, ?, ?, ?, ?)');
const storeDerivativeSnapshot = database.prepare('INSERT INTO derivative_snapshots (source, observed_at, funding_rate, oi, book_imbalance_pct, book_ratio, taker_buy_ratio_pct, taker_trade_count, ofi_pct) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
const storeSentimentSnapshot = database.prepare('INSERT INTO sentiment_snapshots (observed_at, value, classification, source) VALUES (?, ?, ?, ?)');
const storeMacroMarketSnapshot = database.prepare('INSERT INTO macro_market_snapshots (observed_at, metric_key, value, change_pct, available, source, cadence) VALUES (?, ?, ?, ?, ?, ?, ?)');
const storeFedCalendarSnapshot = database.prepare('INSERT INTO fed_calendar_snapshots (observed_at, event_key, event_name, event_at, source, is_fallback) VALUES (?, ?, ?, ?, ?, ?)');
const storeNewsSnapshot = database.prepare('INSERT OR IGNORE INTO btc_news_snapshots (observed_at, published_at, title, url, source, sentiment) VALUES (?, ?, ?, ?, ?, ?)');
const priorOiSnapshot = database.prepare('SELECT observed_at, oi FROM derivative_snapshots WHERE source=? AND observed_at<=? AND oi IS NOT NULL ORDER BY observed_at DESC LIMIT 1');
const priorFundingSnapshot = database.prepare('SELECT observed_at, funding_rate FROM derivative_snapshots WHERE source=? AND observed_at<=? AND funding_rate IS NOT NULL ORDER BY observed_at DESC LIMIT 1');
const priorQuoteSnapshot = database.prepare('SELECT observed_at, last FROM quote_snapshots WHERE source=? AND observed_at<=? AND last IS NOT NULL ORDER BY observed_at DESC LIMIT 1');
const latestQuoteForSource = database.prepare('SELECT observed_at, last, open24h, change_pct, high24, low24 FROM quote_snapshots WHERE source=? ORDER BY observed_at DESC LIMIT 1');
const latestCandleUpdateForSource = database.prepare('SELECT MAX(updated_at) AS updated_at FROM candles WHERE source=? AND interval=?');
const latestSentimentSnapshot = database.prepare('SELECT observed_at, value, classification, source FROM sentiment_snapshots ORDER BY observed_at DESC LIMIT 1');
const latestFedCalendarSnapshots = database.prepare(`SELECT snapshot.observed_at, snapshot.event_key, snapshot.event_name, snapshot.event_at, snapshot.source, snapshot.is_fallback
  FROM fed_calendar_snapshots AS snapshot
  INNER JOIN (SELECT event_key, MAX(observed_at) AS observed_at FROM fed_calendar_snapshots GROUP BY event_key) AS latest
    ON latest.event_key=snapshot.event_key AND latest.observed_at=snapshot.observed_at
  ORDER BY snapshot.event_at ASC`);
const storeResearchPrediction = database.prepare('INSERT OR IGNORE INTO research_predictions (bucket_at, created_at, horizon_key, candle_interval, target_at, entry_price, raw_probability, calibrated_probability, direction, regime) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
const pendingResearchPredictions = database.prepare('SELECT id, horizon_key, candle_interval, target_at, entry_price FROM research_predictions WHERE settled_at IS NULL AND target_at<=? ORDER BY target_at ASC');
const settleResearchPrediction = database.prepare('UPDATE research_predictions SET settled_at=?, settled_price=?, actual_return=?, is_up=?, brier=? WHERE id=?');
const storeResearchTrainingRun = database.prepare('INSERT INTO research_training_runs (started_at, status, model_name) VALUES (?, ?, ?)');
const completeResearchTrainingRun = database.prepare('UPDATE research_training_runs SET completed_at=?, status=?, metrics_json=?, samples_json=?, error=? WHERE id=?');
const storeCandidatePrediction = database.prepare('INSERT OR IGNORE INTO research_candidate_predictions (training_run_id, created_at, horizon_key, candle_interval, target_at, entry_price, probability, direction) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
const pendingCandidatePredictions = database.prepare('SELECT id, training_run_id, candle_interval, target_at, entry_price, probability FROM research_candidate_predictions WHERE settled_at IS NULL AND target_at<=? ORDER BY target_at ASC');
const settleCandidatePrediction = database.prepare('UPDATE research_candidate_predictions SET settled_at=?, settled_price=?, actual_return=?, is_up=?, brier=? WHERE id=?');
const storeCandidateForecast = database.prepare('INSERT OR IGNORE INTO research_candidate_forecasts (training_run_id, bucket_at, created_at, horizon_key, candle_interval, target_at, entry_price, probability, direction) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
const pendingCandidateForecasts = database.prepare('SELECT id, candle_interval, target_at, entry_price, probability FROM research_candidate_forecasts WHERE settled_at IS NULL AND target_at<=? ORDER BY target_at ASC');
const settleCandidateForecast = database.prepare('UPDATE research_candidate_forecasts SET settled_at=?, settled_price=?, actual_return=?, is_up=?, brier=? WHERE id=?');
const storeAbShadowPair = database.prepare('INSERT OR IGNORE INTO ab_shadow_pairs (experiment_key, bucket_at, source, candle_interval, horizon_key, target_at, entry_price, regime, a_probability, a_direction, b_probability, b_direction, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
const pendingAbShadowPairs = database.prepare('SELECT id, candle_interval, target_at, entry_price FROM ab_shadow_pairs WHERE settled_at IS NULL AND target_at<=? ORDER BY target_at ASC');
const settleAbShadowPair = database.prepare('UPDATE ab_shadow_pairs SET settled_at=?, settled_price=?, actual_return=?, is_up=? WHERE id=?');
let lastStorageCleanup = 0;
let researchTrainingInProgress = false;
const lastStoredQuote = new Map();
const lastStoredDerivative = new Map();
function safelyStore(work) { try { work(); } catch (error) { console.error('SQLite storage error:', error.message); } }
function cleanStorage(now) {
  if (now - lastStorageCleanup < 3_600_000) return;
  lastStorageCleanup = now;
  database.prepare('DELETE FROM quote_snapshots WHERE observed_at < ?').run(now - 7 * 86_400_000);
  database.prepare('DELETE FROM market_snapshots WHERE observed_at < ?').run(now - 30 * 86_400_000);
  database.prepare('DELETE FROM candles WHERE updated_at < ?').run(now - 90 * 86_400_000);
  database.prepare('DELETE FROM training_runs WHERE observed_at < ?').run(now - 180 * 86_400_000);
  database.prepare('DELETE FROM derivative_snapshots WHERE observed_at < ?').run(now - 14 * 86_400_000);
  database.prepare('DELETE FROM sentiment_snapshots WHERE observed_at < ?').run(now - 365 * 86_400_000);
  database.prepare('DELETE FROM macro_market_snapshots WHERE observed_at < ?').run(now - 180 * 86_400_000);
  database.prepare('DELETE FROM fed_calendar_snapshots WHERE observed_at < ?').run(now - 180 * 86_400_000);
  database.prepare('DELETE FROM btc_news_snapshots WHERE observed_at < ?').run(now - 30 * 86_400_000);
  database.prepare('DELETE FROM research_predictions WHERE created_at < ?').run(now - 180 * 86_400_000);
  database.exec('PRAGMA wal_checkpoint(PASSIVE)');
}
function persistQuote(source, ticker, observedAt) {
  if (observedAt - (lastStoredQuote.get(source) || 0) < 5_000) return;
  lastStoredQuote.set(source, observedAt);
  safelyStore(() => { storeQuote.run(source, observedAt, ticker.last, ticker.open24h, ticker.changePct, ticker.high24, ticker.low24); cleanStorage(observedAt); });
}
function persistMarket(result, interval) {
  safelyStore(() => {
    const now = result.fetchedAt;
    storeMarketSnapshot.run(result.source, interval, now, result.candles.length, result.ticker.last, 0);
    result.candles.forEach(candle => storeCandle.run(result.source, interval, candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume, now));
    result.candles.slice(-2).forEach(candle => updateCandle.run(candle.open, candle.high, candle.low, candle.close, candle.volume, now, result.source, interval, candle.time));
    persistQuote(result.source, result.ticker, now);
    cleanStorage(now);
  });
}
function persistTrainingRun(value, forced) {
  safelyStore(() => storeTrainingRun.run(value.fetchedAt, value.source, value.intraday.length, value.daily.length, forced ? 1 : 0));
}
function persistDerivativeSnapshot(source, values, observedAt = Date.now()) {
  if (observedAt - (lastStoredDerivative.get(source) || 0) < 10_000) return;
  lastStoredDerivative.set(source, observedAt);
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
  const rows = database.prepare('SELECT candle_time AS time, open, high, low, close, volume FROM candles WHERE source=? AND interval=? ORDER BY candle_time DESC LIMIT ?').all(source, interval, limit);
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
function storageStatus() {
  const count = table => database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total;
  return { engine:'SQLite', quoteSnapshots:count('quote_snapshots'), candles:count('candles'), marketSnapshots:count('market_snapshots'), trainingRuns:count('training_runs'), derivativeSnapshots:count('derivative_snapshots'), sentimentSnapshots:count('sentiment_snapshots'), macroMarketSnapshots:count('macro_market_snapshots'), fedCalendarSnapshots:count('fed_calendar_snapshots'), newsSnapshots:count('btc_news_snapshots') };
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
const QUOTE_TTL = 1_000;
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
const syntheticOkxIntervals = new Map([['5s', 5_000], ['10s', 10_000], ['30s', 30_000]]);
const isSyntheticOkxInterval = interval => syntheticOkxIntervals.has(interval);
function recordSyntheticOkxTrade(trade, receivedAt = Date.now()) {
  const price = Number(trade.px), size = Number(trade.sz);
  // `ts` is the exchange event time.  It keeps bucket boundaries independent
  // of local WebSocket latency.
  const tradeAt = Number(trade.ts) || receivedAt;
  if (!Number.isFinite(price) || !Number.isFinite(size) || size <= 0 || !Number.isFinite(tradeAt)) return;
  for (const [interval, bucketMs] of syntheticOkxIntervals) {
    const bucketAt = Math.floor(tradeAt / bucketMs) * bucketMs;
    safelyStore(() => upsertSyntheticOkxCandle.run(interval, bucketAt, price, price, price, price, size, receivedAt));
  }
}
function streamAge(at, now = Date.now()) { return at ? Math.max(0, now - at) : null; }
function freshOkxTicker(maxAge = 5_000) {
  return okxStream.ticker && streamAge(okxStream.tickerAt) <= maxAge ? { ...okxStream.ticker } : null;
}
function recentTakerFlow(now = Date.now()) {
  const cutoff = now - 60_000;
  okxStream.takerTrades = okxStream.takerTrades.filter(trade => trade.time >= cutoff);
  const buys = okxStream.takerTrades.filter(trade => trade.side === 'buy').reduce((sum, trade) => sum + trade.notional, 0);
  const sells = okxStream.takerTrades.filter(trade => trade.side === 'sell').reduce((sum, trade) => sum + trade.notional, 0);
  const total = buys + sells;
  return total > 0 ? {
    buyNotional:buys, sellNotional:sells, buyRatioPct:buys / total * 100,
    imbalancePct:(buys - sells) / total * 100, tradeCount:okxStream.takerTrades.length,
    cvd60Notional:buys-sells, cvdSessionNotional:okxStream.cvdNotional,
    windowSeconds:60, updatedAt:okxStream.tradeAt || null
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
// 触发判定：状态语义 + 首次/未知价格参考
function ruleMatches(rule, prev, next) {
  if (!Number.isFinite(next)) return false;
  const target = Number(rule.targetPrice);
  const direction = (prev === undefined || prev === null) ? null : (next > prev) ? 'up' : (next < prev ? 'down' : null);
  if (rule.kind === 'price_reached') {
    if (!Number.isFinite(target)) return false;
    if (prev === undefined) return next >= target; // 离目标多近算"接近"
    return (prev - target) * (next - target) <= 0;
  }
  if (rule.kind === 'price_above') {
    if (!Number.isFinite(target)) return false;
    return next >= target; // 状态：到达即满足
  }
  if (rule.kind === 'price_below') {
    if (!Number.isFinite(target)) return false;
    return next <= target;
  }
  if (rule.kind === 'price_tick_move') {
    const delta = prev === undefined ? Math.abs(target) : Math.abs(next - prev);
    return delta >= Math.abs(target);
  }
  if (rule.kind === 'long_liquidation') return next >= target;
  if (rule.kind === 'short_liquidation') return next <= target;
  return false;
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
      const fetched = await fetch('https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT', { signal: AbortSignal.timeout(4_000) });
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
function okxDerivativeFeatures(now = Date.now()) {
  const book = okxStream.orderBook && streamAge(okxStream.bookAt, now) <= 10_000 ? { ...okxStream.orderBook, updatedAt:okxStream.bookAt } : null;
  const takerFlow = recentTakerFlow(now);
  const oiBaseline = priorOiSnapshot.get('okx', now - 300_000);
  const fundingBaseline = priorFundingSnapshot.get('okx', now - 3_600_000);
  const priceBaseline = priorQuoteSnapshot.get('okx', now - 300_000);
  const oiChangePct = Number.isFinite(okxStream.oi) && Number.isFinite(+oiBaseline?.oi) && +oiBaseline.oi !== 0 ? (okxStream.oi / +oiBaseline.oi - 1) * 100 : null;
  const fundingChangePct = Number.isFinite(okxStream.fundingRate) && Number.isFinite(+fundingBaseline?.funding_rate) ? (okxStream.fundingRate - +fundingBaseline.funding_rate) * 100 : null;
  const priceChangePct = Number.isFinite(okxStream.ticker?.last) && Number.isFinite(+priceBaseline?.last) && +priceBaseline.last !== 0 ? (okxStream.ticker.last / +priceBaseline.last - 1) * 100 : null;
  return {
    orderBook:book, takerFlow,
    premiumPct:streamAge(okxStream.premiumAt, now) <= 60_000 ? okxStream.premiumPct : null,
    liquidationHeat:null, topTraderRatio:null,
    oiChangePct, oiChangeWindowSeconds:oiBaseline ? Math.round((now - +oiBaseline.observed_at) / 1000) : null,
    fundingChangePct, fundingChangeWindowSeconds:fundingBaseline ? Math.round((now - +fundingBaseline.observed_at) / 1000) : null,
    priceChangePct, priceChangeWindowSeconds:priceBaseline ? Math.round((now - +priceBaseline.observed_at) / 1000) : null
  };
}
function persistOkxDerivativeSnapshot() {
  const takerFlow = recentTakerFlow(), book = okxStream.orderBook;
  persistDerivativeSnapshot('okx', {
    fundingRate:okxStream.fundingRate, oi:okxStream.oi,
    bookImbalancePct:book?.imbalancePct, bookRatio:book?.ratio,
    takerBuyRatioPct:takerFlow?.buyRatioPct, takerTradeCount:takerFlow?.tradeCount,
    ofiPct:book?.ofiPct
  });
}
function freshOkxContext(maxAge = 30_000) {
  if (!freshOkxTicker(maxAge) || !Number.isFinite(okxStream.spotPrice) || !Number.isFinite(okxStream.fundingRate) || !Number.isFinite(okxStream.oi) || streamAge(okxStream.contextAt) > maxAge) return null;
  const ticker = freshOkxTicker(maxAge);
  return {
    source:'okx', fundingRate:okxStream.fundingRate, nextFundingRate:okxStream.nextFundingRate,
    oi:okxStream.oi, oiUnit:okxStream.oiUnit, basisPct:(ticker.last / okxStream.spotPrice - 1) * 100,
    perpPrice:ticker.last, spotPrice:okxStream.spotPrice, fetchedAt:okxStream.contextAt,
    cached:true, cacheAgeMs:streamAge(okxStream.contextAt), transport:'websocket', ...okxDerivativeFeatures()
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
  if (channel === 'tickers' && instId === 'BTC-USDT-SWAP') {
    const ticker = { last:+row.last, open24h:+row.open24h, changePct:(+row.last / +row.open24h - 1) * 100, high24:+row.high24h, low24:+row.low24h };
    if (Object.values(ticker).every(Number.isFinite)) { okxStream.ticker = ticker; okxStream.tickerAt = now; persistQuote('okx', ticker, now); }
  } else if (channel === 'tickers' && instId === 'BTC-USDT') {
    if (Number.isFinite(+row.last)) { okxStream.spotPrice = +row.last; okxStream.contextAt = now; }
  } else if (channel === 'funding-rate') {
    if (Number.isFinite(+row.fundingRate)) { okxStream.fundingRate = +row.fundingRate; okxStream.nextFundingRate = Number.isFinite(+row.nextFundingRate) ? +row.nextFundingRate : +row.fundingRate; okxStream.contextAt = now; }
  } else if (channel === 'open-interest') {
    const oi = Number.isFinite(+row.oiCcy) ? +row.oiCcy : +row.oi;
    if (Number.isFinite(oi)) { okxStream.oi = oi; okxStream.oiUnit = Number.isFinite(+row.oiCcy) ? 'BTC' : 'contracts'; okxStream.contextAt = now; }
  } else if (channel === 'books5') {
    const depth = values => values.reduce((sum, level) => sum + Math.max(0, +level[0] || 0) * Math.max(0, +level[1] || 0), 0);
    const bidDepth = depth(row.bids || []), askDepth = depth(row.asks || []), total = bidDepth + askDepth;
    const previous=okxStream.orderBook;
    // OFI approximates the signed change in displayed top-of-book liquidity.
    // It is persisted for future time-aligned training, but is not treated as
    // a historical model input until sufficient snapshots have accumulated.
    const previousTotal=(previous?.bidDepth || 0)+(previous?.askDepth || 0);
    const ofiPct=previousTotal>0 ? ((bidDepth-(previous?.bidDepth || 0))-(askDepth-(previous?.askDepth || 0))) / Math.max(total,previousTotal,1)*100 : null;
    const bestBid=+row.bids?.[0]?.[0],bestAsk=+row.asks?.[0]?.[0],mid=(bestBid+bestAsk)/2,spreadBps=Number.isFinite(mid)&&mid>0&&Number.isFinite(bestBid)&&Number.isFinite(bestAsk)?(bestAsk-bestBid)/mid*10_000:null;
    if (total > 0) { okxStream.orderBook = { bidDepth, askDepth, ratio:askDepth ? bidDepth / askDepth : null, imbalancePct:(bidDepth - askDepth) / total * 100, ofiPct, spreadBps }; okxStream.bookAt = now; }
  } else if (channel === 'trades') {
    for (const trade of rows) {
      const price = +trade.px, size = +trade.sz, side = trade.side === 'buy' ? 'buy' : trade.side === 'sell' ? 'sell' : null;
      if (side && Number.isFinite(price) && Number.isFinite(size) && size > 0) { const notional=price*size;okxStream.takerTrades.push({ time:now, side, notional });okxStream.cvdNotional+=side==='buy'?notional:-notional; recordSyntheticOkxTrade(trade, now); }
    }
    okxStream.tradeAt = now;
    recentTakerFlow(now);
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
      socket.send(JSON.stringify({ op:'subscribe', args:[
        { channel:'tickers', instId:'BTC-USDT-SWAP' }, { channel:'tickers', instId:'BTC-USDT' },
        { channel:'funding-rate', instId:'BTC-USDT-SWAP' }, { channel:'open-interest', instType:'SWAP', instId:'BTC-USDT-SWAP' },
        { channel:'books5', instId:'BTC-USDT-SWAP' }, { channel:'trades', instId:'BTC-USDT-SWAP' }
      ] }));
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
  try { const payload=await request('https://www.okx.com/api/v5/public/premium-history?instId=BTC-USDT-SWAP',8_000),row=payload.data?.[0],value=+row?.premium; if(payload.code==='0'&&Number.isFinite(value)){okxStream.premiumPct=value*100;okxStream.premiumAt=Date.now()} } catch { /* Feature remains unavailable; it never becomes a synthetic value. */ }
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
function validCandle(c) { return c && [c.time, c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite); }
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
    request('https://api.gateio.ws/api/v4/futures/usdt/tickers?contract=BTC_USDT'),
    request(`https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=BTC_USDT&interval=${intervalFor('gate', interval)}&limit=${limit}`)
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
    if (limit <= 300) return request(`https://www.okx.com/api/v5/market/history-candles?instId=BTC-USDT-SWAP&bar=${intervalFor('okx', interval)}&limit=${limit}`);
    const pages = [], pageSize = 300;
    let after = '';
    for (let page = 0; page < Math.ceil(limit / pageSize); page++) {
      const suffix = after ? `&after=${after}` : '';
      const payload = await request(`https://www.okx.com/api/v5/market/history-candles?instId=BTC-USDT-SWAP&bar=${intervalFor('okx', interval)}&limit=${pageSize}${suffix}`);
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
    const payload = await request(`https://www.okx.com/api/v5/market/history-candles?instId=BTC-USDT-SWAP&bar=1H&limit=${pageSize}${suffix}`);
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
    const tickerPayload = streamedTicker ? null : await request('https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT-SWAP');
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
    streamedTicker ? Promise.resolve(null) : request('https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT-SWAP'),
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
  const payload = await request(`https://api.international.coinbase.com/api/v1/instruments/BTC-PERP/candles?${params}`, 8_000);
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
    request('https://api.international.coinbase.com/api/v1/instruments/BTC-PERP/quote', 8_000),
    coinbasePerpetualCandles(interval, limit),
    request(`https://api.international.coinbase.com/api/v1/instruments/BTC-PERP/candles?${hourlyParams}`, 8_000)
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
    request('https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=BTCUSDT'),
    request(`https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=${intervalFor('binance', interval)}&limit=${limit}`)
  ]);
  return { ticker: { last:+ticker.lastPrice, open24h:+ticker.openPrice, changePct:+ticker.priceChangePercent, high24:+ticker.highPrice, low24:+ticker.lowPrice }, candles: rows.map(c => ({ time:+c[0], open:+c[1], high:+c[2], low:+c[3], close:+c[4], volume:+c[5] })) };
}
const loaders = { gate: fromGate, okx: fromOKX, coinbase: fromCoinbase, binance: fromBinance };
async function liveQuote(source = 'okx') {
  const selected = loaders[source] ? source : 'okx', key = `quote:${selected}`, hit = cache.get(key);
  const streamed = selected === 'okx' ? freshOkxTicker() : null;
  if (streamed) return { source:selected, ticker:streamed, fetchedAt:okxStream.tickerAt, cached:true, cacheAgeMs:streamAge(okxStream.tickerAt), transport:'websocket', stale:false };
  if (hit && Date.now() - hit.time < QUOTE_TTL) return { ...cacheResult(hit), transport:hit.value.transport || 'rest', stale:false };
  const prior = [...cache.values()].map(entry => entry.value).reverse().find(value => value?.source === selected && value?.ticker)?.ticker;
  try {
    const value = await coalesce(key, async () => {
      let ticker;
      if (selected === 'okx') {
        const payload = await request('https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT-SWAP'), row = payload.data?.[0];
        if (payload.code !== '0' || !row) throw new Error(payload.msg || 'OKX quote unavailable');
        ticker = { last:+row.last, open24h:+row.open24h, changePct:(+row.last / +row.open24h - 1) * 100, high24:+row.high24h, low24:+row.low24h };
      } else if (selected === 'binance') {
        const row = await request('https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=BTCUSDT');
        ticker = { last:+row.lastPrice, open24h:+row.openPrice, changePct:+row.priceChangePercent, high24:+row.highPrice, low24:+row.lowPrice };
      } else if (selected === 'gate') {
        const row = (await request('https://api.gateio.ws/api/v4/futures/usdt/tickers?contract=BTC_USDT'))[0];
        if (!row) throw new Error('Gate quote unavailable');
        ticker = { last:+row.last, open24h:+row.last / (1 + (+row.change_percentage || 0) / 100), changePct:+row.change_percentage, high24:+row.high_24h, low24:+row.low_24h };
      } else {
        const payload = await request('https://api.international.coinbase.com/api/v1/instruments/BTC-PERP/quote', 1_200), row = payload.quote || payload, last = +(row.trade_price || row.mark_price);
        if (!Number.isFinite(last)) throw new Error('Coinbase quote unavailable');
        ticker = { last, open24h:prior?.open24h || last, changePct:prior?.open24h ? (last / prior.open24h - 1) * 100 : 0, high24:Math.max(prior?.high24 || last,last), low24:Math.min(prior?.low24 || last,last) };
      }
      const fresh = { source:selected, ticker, fetchedAt:Date.now(), cached:false, cacheAgeMs:0, transport:'rest', stale:false };
      remember(key, fresh); persistQuote(selected, ticker, fresh.fetchedAt); return fresh;
    });
    return value;
  } catch (error) {
    if (hit && Date.now() - hit.time <= STALE_QUOTE_MAX_AGE) return { ...cacheResult(hit), transport:hit.value.transport || 'rest', stale:true, fallbackReason:error.name === 'AbortError' ? 'timeout' : error.message };
    throw error;
  }
}
async function marketContext(source = 'okx') {
  const selected = loaders[source] ? source : 'okx', key = `market-context:${selected}`;
  const hit = cache.get(key);
  const streamed = selected === 'okx' ? freshOkxContext() : null;
  if (streamed) return streamed;
  if (hit && Date.now() - hit.time < CONTEXT_TTL) return { ...cacheResult(hit), transport:hit.value.transport || 'rest', stale:false };
  try { return await coalesce(key, async () => {
  let value;
  if (selected === 'okx') {
    const [funding, oi, perp, spot] = await Promise.all([
      request('https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP'),
      request('https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=BTC-USDT-SWAP'),
      request('https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT-SWAP'),
      request('https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT')
    ]);
    const f = funding.data?.[0], o = oi.data?.[0], p = perp.data?.[0], s = spot.data?.[0];
    if (!f || !o || !p || !s) throw new Error('invalid OKX context payload');
    value = { source:selected, fundingRate:+f.fundingRate, nextFundingRate:+f.nextFundingRate, oi:+o.oiCcy || +o.oi, oiUnit:o.oiCcy ? 'BTC' : 'contracts', basisPct:(+p.last / +s.last - 1) * 100, perpPrice:+p.last, spotPrice:+s.last, fetchedAt:Date.now(), cached:false };
  } else if (selected === 'binance') {
    const [premium, oi, perp, spot] = await Promise.all([
      request('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT'),
      request('https://fapi.binance.com/fapi/v1/openInterest?symbol=BTCUSDT'),
      request('https://fapi.binance.com/fapi/v1/ticker/price?symbol=BTCUSDT'),
      request('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT')
    ]);
    value = { source:selected, fundingRate:+premium.lastFundingRate, nextFundingRate:+premium.lastFundingRate, oi:+oi.openInterest, oiUnit:'BTC', basisPct:(+perp.price / +spot.price - 1) * 100, perpPrice:+perp.price, spotPrice:+spot.price, fetchedAt:Date.now(), cached:false };
  } else if (selected === 'coinbase') {
    const [quotePayload, spot] = await Promise.all([
      request('https://api.international.coinbase.com/api/v1/instruments/BTC-PERP/quote', 8_000),
      request('https://api.exchange.coinbase.com/products/BTC-USD/ticker', 8_000)
    ]);
    const quote = quotePayload.quote || quotePayload, perpPrice=+(quote.trade_price || quote.mark_price), spotPrice=+spot.price;
    value = { source:selected, fundingRate:+quote.predicted_funding, nextFundingRate:+quote.predicted_funding, oi:null, oiUnit:'--', basisPct:(perpPrice / spotPrice - 1) * 100, perpPrice, spotPrice, fetchedAt:Date.now(), cached:false };
  } else {
    const [perpRows, spotRows] = await Promise.all([
      request('https://api.gateio.ws/api/v4/futures/usdt/tickers?contract=BTC_USDT'),
      request('https://api.gateio.ws/api/v4/spot/tickers?currency_pair=BTC_USDT')
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
  const rows = await request(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}`, 8_000);
  const candles = rows.map(c => ({ time:+c[0], open:+c[1], high:+c[2], low:+c[3], close:+c[4], volume:+c[5] })).filter(validCandle);
  if (candles.length < 300) throw new Error('insufficient historical candles');
  return candles;
}
async function gateHistory(interval, limit = 1000) {
  const rows = await request(`https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=BTC_USDT&interval=${interval}&limit=${limit}`, 8_000);
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
    const rows = await request(`https://api.exchange.coinbase.com/products/BTC-USD/candles?${params}`, 8_000);
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
async function forecastHistory(interval) {
  const failures = [];
  for (const [source, loader] of [['coinbase', coinbaseHistory], ['gate', gateHistory], ['binance', binanceHistory]]) {
    const stored = storedCandles(source, interval, 1000);
    if (stored.length >= 900) return { candles:stored, source, cached:true, storage:'sqlite' };
    try {
      const candles = await loader(interval);
      persistHistory(source, interval, candles);
      return { candles, source, cached:false, storage:'upstream' };
    }
    catch (e) { failures.push(`${source}: ${e.name === 'AbortError' ? 'timeout' : e.message}`); }
  }
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
  const rows=database.prepare('SELECT title, url, source, published_at AS publishedAt, sentiment FROM btc_news_snapshots WHERE observed_at >= ? ORDER BY COALESCE(published_at, observed_at) DESC LIMIT 24').all(now - 24 * 86_400_000);
  return rows.map(row => { const title=String(row.title), source=row.source || 'SQLite', category=classifyNewsEvent(title); return { title, url:row.url || '', source, publishedAt:Number(row.publishedAt) || null, sentiment:Number(row.sentiment) || 0, category, sourceWeight:sourceWeight(source), eventWeight:eventWeight(category) }; });
}
async function bitcoinNews({ refresh = false } = {}) {
  const key='btc-news', hit=cache.get(key), now=Date.now();
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
function percentChange(closes, end, span) { const start=closes[Math.max(0,end-span)], current=closes[end]; return Number.isFinite(start) && start > 0 && Number.isFinite(current) ? current / start - 1 : 0; }
function historicalProjection(candles, horizon) {
  const closes=candles.map(candle => +candle.close).filter(value => Number.isFinite(value) && value > 0), end=closes.length-1;
  if (end < Math.max(80, horizon + 30)) throw new Error('insufficient price-history samples');
  const featureAt=index => { const volatility=closes.slice(Math.max(1,index-20),index+1).reduce((total,value,offset,rows) => offset ? total + Math.abs(value / rows[offset-1] - 1) : total,0)/20, trend=percentChange(closes,index,Math.max(20,horizon*4)); return { short:percentChange(closes,index,Math.max(2,Math.round(horizon/2))), medium:percentChange(closes,index,Math.max(6,horizon*2)), volatility, trend, regime:trend>.015?'bull':trend<-.015?'bear':'range' }; };
  const target=featureAt(end), candidates=[];
  for (let index=30;index<=end-horizon;index++) {
    const row=featureAt(index), distance=Math.abs(row.short-target.short)*20 + Math.abs(row.medium-target.medium)*12 + Math.abs(row.volatility-target.volatility)*18 + Math.abs(row.trend-target.trend)*8;
    candidates.push({ distance, change:closes[index+horizon]/closes[index]-1, regime:row.regime });
  }
  const sameRegime=candidates.filter(row=>row.regime===target.regime), pool=sameRegime.length>=60?sameRegime:candidates;
  const sorted=[...pool].sort((a,b)=>a.distance-b.distance), scale=Math.max(.001,sorted[Math.floor(sorted.length*.35)]?.distance || .01);
  const weighted=pool.map(row=>({...row,weight:Math.exp(-row.distance/scale)})), weightTotal=weighted.reduce((sum,row)=>sum+row.weight,0);
  const expected=weighted.reduce((sum,row)=>sum+row.change*row.weight,0)/weightTotal, up=weighted.filter(row=>row.change>0).reduce((sum,row)=>sum+row.weight,0)/weightTotal;
  const normalized=weighted.map(row=>({...row,weight:row.weight/weightTotal})).sort((a,b)=>a.change-b.change), quantile=q=>{let cumulative=0;for(const row of normalized){cumulative+=row.weight;if(cumulative>=q)return row.change}return normalized.at(-1)?.change || 0};
  const effectiveSamples=1/normalized.reduce((sum,row)=>sum+row.weight**2,0), medianDistance=sorted[Math.floor(sorted.length*.5)]?.distance || scale;
  return { expectedReturn:Number.isFinite(expected) ? expected : 0, upProbability:up, samples:Math.round(effectiveSamples), candidateCount:pool.length, momentum:target.medium, volatility:target.volatility, regime:target.regime, matchQuality:clamp(Math.exp(-medianDistance/Math.max(scale,.001)),0,1), distribution:{p10:quantile(.1),p50:quantile(.5),p90:quantile(.9)} };
}
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function sigmoid(value) { return 1/(1+Math.exp(-Math.max(-18,Math.min(18,value)))); }
function logit(probability) { const value=clamp(probability,.001,.999); return Math.log(value/(1-value)); }
// ---- Shared A/B shadow experiments ---------------------------------------
// These helpers deliberately operate on *closed* candles only.  They are not
// used by any visible live card, which keeps the currently deployed A rules
// frozen while a B rule gathers paired outcomes in the background.
function abEma(values, period) { let value=values[0]||0, alpha=2/(period+1); for(const next of values.slice(1)) value=next*alpha+value*(1-alpha); return value; }
function abRsi(values, period=14) { if(values.length<=period)return 50;let gains=0,losses=0;for(let i=values.length-period;i<values.length;i++){const d=values[i]-values[i-1];gains+=Math.max(0,d);losses+=Math.max(0,-d)}return losses===0?100:100-100/(1+gains/Math.max(losses,.0000001)); }
function abAtr(series, period=14) { const rows=series.slice(-(period+1));if(rows.length<2)return 0;const ranges=[];for(let i=1;i<rows.length;i++)ranges.push(Math.max(rows[i].high-rows[i].low,Math.abs(rows[i].high-rows[i-1].close),Math.abs(rows[i].low-rows[i-1].close)));return ranges.reduce((sum,x)=>sum+x,0)/ranges.length; }
function abRegime(series) { const closes=series.map(row=>Number(row.close)), last=closes.at(-1), trend=last/closes[Math.max(0,closes.length-21)]-1, atrPct=abAtr(series,14)/Math.max(last,1);return Math.abs(trend)<Math.max(.003,atrPct*1.6)?'range':trend>0?'bull':'bear'; }
function abDirection(probability, band=.035) { return probability>=.5+band?'up':probability<=.5-band?'down':'flat'; }
// Exact server-side equivalents of the visible rule card's closed-candle
// score.  Keeping this separate from the older shadow baseline prevents a
// convenient but invalid comparison against a merely similar heuristic.
function ruleEma(values, period) { if(values.length<period)return NaN;let value=values.slice(0,period).reduce((sum,row)=>sum+row,0)/period,alpha=2/(period+1);for(let index=period;index<values.length;index++)value=values[index]*alpha+value*(1-alpha);return value; }
function ruleRsi(values, period=14) { if(values.length<=period)return NaN;let gain=0,loss=0;for(let index=1;index<=period;index++){const delta=values[index]-values[index-1];if(delta>=0)gain+=delta;else loss-=delta;}let averageGain=gain/period,averageLoss=loss/period;for(let index=period+1;index<values.length;index++){const delta=values[index]-values[index-1];averageGain=(averageGain*(period-1)+Math.max(delta,0))/period;averageLoss=(averageLoss*(period-1)+Math.max(-delta,0))/period;}return averageLoss===0?100:100-100/(1+averageGain/averageLoss); }
function ruleAtr(series, period=14) { if(series.length<=period)return NaN;let total=0;for(let index=1;index<=period;index++){const row=series[index],prior=series[index-1];total+=Math.max(row.high-row.low,Math.abs(row.high-prior.close),Math.abs(row.low-prior.close));}let value=total/period;for(let index=period+1;index<series.length;index++){const row=series[index],prior=series[index-1],range=Math.max(row.high-row.low,Math.abs(row.high-prior.close),Math.abs(row.low-prior.close));value=(value*(period-1)+range)/period;}return value; }
function liveRuleMetrics(series) { const closes=series.map(row=>Number(row.close));if(closes.length<200)return null;const close=closes.at(-1),e20=ruleEma(closes,20),e50=ruleEma(closes,50),e200=ruleEma(closes,200),rsi=ruleRsi(closes),macd=ruleEma(closes,12)-ruleEma(closes,26),basis=closes.slice(-20).reduce((sum,row)=>sum+row,0)/20,sd=Math.sqrt(closes.slice(-20).reduce((sum,row)=>sum+(row-basis)**2,0)/20),bb=(close-(basis-2*sd))/(4*sd||1);let score=0;score+=e20>e50?25:-25;score+=close>e50?20:-20;score+=Number.isFinite(e200)?(close>e200?20:-20):0;score+=clamp(macd/(close*.0015)*15,-15,15);score+=clamp((rsi-50)/2.5,-10,10);score+=clamp((bb-.5)*20,-10,10);return {score:Math.round(score),close,e20,e50,e200,rsi,atr:ruleAtr(series,14),bb}; }
function scoreProbability(score) { return clamp(sigmoid(score/35),.08,.92); }
function abRuleProbabilities(series) {
  const closes=series.map(row=>Number(row.close)), close=closes.at(-1), ema20=abEma(closes.slice(-80),20), ema50=abEma(closes.slice(-160),50), ema200=abEma(closes.slice(-220),200), rsi=abRsi(closes), atrPct=abAtr(series,14)/Math.max(close,1), momentum=close/closes[Math.max(0,closes.length-5)]-1;
  // A reproduces the existing card's overlapping EMA-style score.  B counts
  // the trend structure once, filters weak/high-volatility states, and uses a
  // wider neutral band (hysteresis) rather than adding a new ML layer.
  let a=0;a+=ema20>=ema50?25:-25;a+=close>=ema50?20:-20;a+=close>=ema200?20:-20;a+=clamp(momentum/.004,-1,1)*15;a+=clamp((rsi-50)/20,-1,1)*10;
  const trend=close>ema20&&ema20>ema50&&ema50>ema200?1:close<ema20&&ema20<ema50&&ema50<ema200?-1:0;
  const volumeNow=Math.log1p(Number(series.at(-1)?.volume||0)), volumeMean=series.slice(-21,-1).reduce((sum,row)=>sum+Math.log1p(Number(row.volume||0)),0)/20;
  const confirmation=trend&&(rsi>52&&trend>0||rsi<48&&trend<0)&&volumeNow>=volumeMean*.94?trend:0;
  const bScore=confirmation*.9+clamp(momentum/Math.max(atrPct*2,.001),-1,1)*.28+clamp((rsi-50)/28,-1,1)*.18-(atrPct>.012?Math.sign(confirmation)*.12:0);
  return { a:clamp(sigmoid(a/31),.08,.92), b:clamp(sigmoid(bScore*1.25),.08,.92), regime:abRegime(series), meta:{ atrPct, rsi, trend, volumeConfirmation:confirmation!==0 } };
}
function abStrictRuleProbabilities(series) {
  const live=liveRuleMetrics(series);if(!live)return { a:.5,b:.5,regime:abRegime(series),meta:{ready:false} };
  const direction=score=>score>=55?1:score<=-55?-1:0;
  const recent=[2,1,0].map(offset=>liveRuleMetrics(series.slice(0,series.length-offset))).filter(Boolean);
  const consensus=recent.length===3&&recent.every(metric=>direction(metric.score)===direction(live.score)&&direction(metric.score)!==0), trend=live.close>live.e20&&live.e20>live.e50&&live.e50>live.e200?1:live.close<live.e20&&live.e20<live.e50&&live.e50<live.e200?-1:0, volumeNow=Math.log1p(Number(series.at(-1)?.volume||0)),volumeMean=series.slice(-21,-1).reduce((sum,row)=>sum+Math.log1p(Number(row.volume||0)),0)/20,volumeConfirmed=volumeNow>=volumeMean*.94,aligned=consensus&&trend===direction(live.score)&&volumeConfirmed&&((trend>0&&live.rsi>52)||(trend<0&&live.rsi<48));
  return { a:scoreProbability(live.score), b:aligned?scoreProbability(live.score):.5, regime:abRegime(series), meta:{ready:true,score:live.score,threeCloseConsensus:consensus,trendAligned:trend===direction(live.score),volumeConfirmed,aligned} };
}
// GitHub v2.4.0 classified each closed-candle score immediately.  The current
// card first requires two matching directions in the latest three closes and
// then holds that state until the score returns inside the ±28 exit band.  Run
// both state machines chronologically so B never sees a future candle.
function abGithubCurrentRuleProbabilities(series) {
  const live=liveRuleMetrics(series);if(!live)return {a:.5,b:.5,regime:abRegime(series),meta:{ready:false}};
  const direction=score=>score>=45?1:score<=-45?-1:0;
  let held=0,confirmedAt=null;
  for(let end=199;end<series.length;end++){
    const window=series.slice(0,end+1), metric=liveRuleMetrics(window), current=direction(metric.score);
    const recent=[2,1,0].map(offset=>end-offset>=199?direction(liveRuleMetrics(series.slice(0,end-offset+1)).score):0);
    const sustained=current!==0&&recent.filter(value=>value===current).length>=2;
    if(held===0&&sustained){held=current;confirmedAt=Number(series[end].time)}
    else if(held!==0&&sustained&&current!==held){held=current;confirmedAt=Number(series[end].time)}
    else if(held!==0&&Math.abs(metric.score)<=28){held=0;confirmedAt=null}
  }
  const currentProbability=held?scoreProbability(Math.sign(held)*Math.max(45,Math.abs(live.score))):.5;
  return {a:scoreProbability(live.score),b:currentProbability,regime:abRegime(series),meta:{ready:true,githubScore:live.score,currentHeld:held,confirmedAt}};
}
function abProbabilityPair(series, horizon) {
  const closes=series.map(row=>Number(row.close)), last=closes.at(-1), r1=last/closes.at(-2)-1, r4=last/closes[Math.max(0,closes.length-5)]-1, r12=last/closes[Math.max(0,closes.length-13)]-1, vol=abAtr(series,14)/Math.max(last,1);
  // Frozen A mirrors the simple return/EMA heuristic. B is a bounded,
  // volatility-normalised candidate, designed for calibration rather than a
  // claim of sophistication; it is scored only after the same future close.
  const a=clamp(sigmoid((r1*.7+r4*.35+r12*.18+(abEma(closes.slice(-80),20)/abEma(closes.slice(-160),50)-1)*.45)/Math.max(vol,.001)),.08,.92);
  const b=clamp(sigmoid((r4/(Math.max(vol,.001)*Math.sqrt(Math.max(1,horizon)))*.42)+(r12/(Math.max(vol,.001)*.28))+(abRsi(closes)-50)/55*.18),.08,.92);
  return { a,b,regime:abRegime(series),meta:{volatility:vol} };
}
function abResonancePair(series, horizon) { const closes=series.map(row=>Number(row.close)), last=closes.at(-1), spans=[4,16,48], votes=spans.map(span=>Math.sign(last/closes[Math.max(0,closes.length-1-span)]-1)), a=clamp(.5+votes.reduce((s,v)=>s+v,0)/12,.12,.88), atr=abAtr(series,14)/Math.max(last,1), weighted=spans.reduce((sum,span,index)=>sum+(last/closes[Math.max(0,closes.length-1-span)]-1)/(Math.max(atr*Math.sqrt(span),.001))*[.48,.32,.2][index],0);return {a,b:clamp(sigmoid(weighted*.38),.1,.9),regime:abRegime(series),meta:{votes}}; }
function abPatternPair(series) { const closes=series.map(row=>Number(row.close)), last=closes.at(-1), prior=series.slice(-21,-1), high=Math.max(...prior.map(row=>row.high)), low=Math.min(...prior.map(row=>row.low)), atr=abAtr(series,14), volume=Number(series.at(-1)?.volume||0), avgVolume=prior.reduce((sum,row)=>sum+Number(row.volume||0),0)/prior.length, raw=last>high?1:last<low?-1:0, a=clamp(.5+raw*.3,.15,.85), confirmed=raw&&volume>=avgVolume*1.2&&Math.abs(last-(raw>0?high:low))>=atr*.12?raw:0;return {a,b:clamp(.5+confirmed*.34,.12,.88),regime:abRegime(series),meta:{breakout:raw,confirmed:!!confirmed}}; }
function recordAbPair(experimentKey, source, interval, series, horizon, calculator, now=Date.now()) {
  if(series.length<201)return;const closed=series.slice(0,-1), entry=closed.at(-1);if(!entry)return;const values=calculator(closed,horizon), bucketAt=Number(entry.time), unit=({ '1m':60_000,'5m':300_000,'15m':900_000,'30m':1_800_000,'1h':3_600_000,'3h':10_800_000 })[interval]||900_000, targetAt=bucketAt+horizon*unit;
  safelyStore(()=>storeAbShadowPair.run(experimentKey,bucketAt,source,interval,`${interval}:${horizon}`,targetAt,Number(entry.close),values.regime,values.a,abDirection(values.a),values.b,abDirection(values.b,.055),JSON.stringify(values.meta||{}),now));
}
function recordAbExternalPair(experimentKey, source, series, horizon, probabilities, metadata, now=Date.now()) {
  const closed=series.slice(0,-1), entry=closed.at(-1);if(!entry||!Number.isFinite(probabilities?.a)||!Number.isFinite(probabilities?.b))return;const bucketAt=Number(entry.time), targetAt=bucketAt+horizon*900_000;
  safelyStore(()=>storeAbShadowPair.run(experimentKey,bucketAt,source,'15m',`15m:${horizon}`,targetAt,Number(entry.close),abRegime(closed),clamp(probabilities.a,.08,.92),abDirection(probabilities.a),clamp(probabilities.b,.08,.92),abDirection(probabilities.b,.055),JSON.stringify(metadata||{}),now));
}
function captureAbExperiments(source, interval, candles, now=Date.now()) {
  if(interval==='15m') { for(const horizon of [4,16,96])recordAbPair('rule-signal',source,interval,candles,horizon,abRuleProbabilities,now);for(const horizon of [4,16,96])recordAbPair('github-rule-signal-walk-forward',source,interval,candles,horizon,abGithubCurrentRuleProbabilities,now);for(const horizon of [1,4,16])recordAbPair('multi-period-probability',source,interval,candles,horizon,abProbabilityPair,now);for(const horizon of [4,16])recordAbPair('multi-period-resonance',source,interval,candles,horizon,abResonancePair,now);for(const horizon of [4,16])recordAbPair('pattern-key-levels',source,interval,candles,horizon,abPatternPair,now); }
  if(['5m','15m','1h','3h'].includes(interval)) for(const horizon of [4,16,96])recordAbPair('rule-signal-v2',source,interval,candles,horizon,abStrictRuleProbabilities,now);
  if(interval==='1m') for(const horizon of [1,5])recordAbPair('short-horizon-heuristic',source,interval,candles,horizon,abProbabilityPair,now);
}
function settleAbExperiments(histories, now=Date.now()) { for(const row of pendingAbShadowPairs.all(now)){const candles=histories[row.candle_interval]||[],target=candles.find(candle=>Number(candle.time)>=Number(row.target_at));if(!target)continue;const settled=Number(target.close), entry=Number(row.entry_price);if(!Number.isFinite(settled)||!entry)continue;const actualReturn=settled/entry-1;settleAbShadowPair.run(now,settled,actualReturn,actualReturn>0?1:0,row.id); } }
function abComparison(experimentKey, minSamples=100) {
  const rows=database.prepare('SELECT horizon_key AS horizonKey, regime, a_probability AS aProbability, b_probability AS bProbability, actual_return AS actualReturn, is_up AS isUp FROM ab_shadow_pairs WHERE experiment_key=? AND settled_at IS NOT NULL ORDER BY target_at ASC').all(experimentKey).map(row=>({...row,aProbability:Number(row.aProbability),bProbability:Number(row.bProbability),actualReturn:Number(row.actualReturn),isUp:Number(row.isUp)}));
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
  {key:'rule-signal',name:'当前规则信号（旧口径）',kind:'prediction',candidate:'旧版近似基线；仅保留历史参照，不作为升级依据',minSamples:100,status:'active'},
  {key:'github-rule-signal-walk-forward',name:'GitHub 规则信号对照（Walk-forward）',kind:'prediction',candidate:'A：GitHub v2.4.0 即时分数；B：当前 ±45 / ±28 稳定化核心与连续收盘确认。相同 15m 已收盘 K 线、相同 1h / 4h / 24h 结算与 0.08% 往返成本。',minSamples:100,status:'active'},
  {key:'rule-signal-v2',name:'当前规则信号（严格对照）',kind:'prediction',candidate:'线上同分数基线 + 连续 3 根收盘确认 + EMA 排列 / RSI / 成交量确认',minSamples:100,status:'active'},
  {key:'short-horizon-heuristic',name:'短线机器预测',kind:'prediction',candidate:'仅已收盘 K 线的波动归一化候选',minSamples:100,status:'active'},
  {key:'multi-period-probability',name:'多周期概率预测',kind:'prediction',candidate:'时间顺序、波动归一化的校准候选',minSamples:30,status:'active'},
  {key:'multi-period-resonance',name:'多周期共振',kind:'prediction',candidate:'按趋势强度与波动率加权的一致性',minSamples:30,status:'active'},
  {key:'pattern-key-levels',name:'形态与关键位',kind:'prediction',candidate:'突破需成交量、ATR 与收盘确认',minSamples:30,status:'active'},
  {key:'okx-microstructure',name:'OKX 微观结构',kind:'prediction',candidate:'OFI、流动性质量与点差过滤',minSamples:100,status:'active',note:'先以当前可用 OFI 快照记录；深度历史成熟前不作升级结论'},
  {key:'news-fear-greed',name:'恐惧贪婪 / 新闻',kind:'prediction',candidate:'事件分类、时间衰减、价格吸收标记',minSamples:30,status:'active'},
  {key:'cross-market',name:'美股联动',kind:'prediction',candidate:'滚动相关、正则化与市场状态过滤',minSamples:30,status:'collecting',note:'等待 BTC、SPY、QQQ 的同步日线快照'},
  {key:'leverage-buffer',name:'强平缓冲',kind:'validation',candidate:'分位数波动与状态自适应缓冲',status:'collecting',note:'按实际触及率验证风险覆盖率，不用方向准确率'},
  {key:'macro-calendar',name:'宏观日历',kind:'validation',candidate:'事件前后波动区间模型',status:'collecting',note:'按波动覆盖率验证，不用涨跌准确率'},
  {key:'data-formulas',name:'图表、周期涨幅、指标明细',kind:'validation',candidate:'数据一致性、缺失率与公式复算',status:'active',note:'描述 / 公式型：不适用方向准确率'}
];
function abExperimentStatus() { return abExperimentCatalog.map(item=>{if(item.status!=='active'||item.kind!=='prediction')return {...item,comparison:null};return {...item,comparison:abComparison(item.key,item.minSamples)};}); }
// Time-ordered lightweight fusion model: price features are trained on earlier rows and validated on later unseen rows.
// 时间顺序轻量融合模型：价格特征仅用较早样本训练、较晚未见样本验证，避免随机切分泄漏。
function trainFusionModel(candles,horizon) {
  const series=candles.filter(validCandle), closes=series.map(candle=>Number(candle.close)), width=8;
  if(series.length<260)return null;
  const mean=values=>values.reduce((sum,value)=>sum+value,0)/Math.max(values.length,1);
  const deviation=values=>Math.sqrt(mean(values.map(value=>(value-mean(values))**2)))||.000001;
  const featureAt=index=>{
    const change=span=>percentChange(closes,index,span), returns=[];
    for(let point=Math.max(1,index-19);point<=index;point++)returns.push(Math.log(closes[point]/closes[point-1]));
    const volatility=deviation(returns), volumes=series.slice(index-20,index).map(row=>Math.log1p(row.volume));
    const high=Math.max(...series.slice(index-20,index+1).map(row=>row.high)), low=Math.min(...series.slice(index-20,index+1).map(row=>row.low));
    return [change(1),change(4),change(12),volatility,change(12)/(volatility*Math.sqrt(12)+.000001),(series[index].high-series[index].low)/closes[index],(series[index].close-series[index].open)/closes[index],(Math.log1p(series[index].volume)-mean(volumes))/deviation(volumes)];
  };
  const tripleBarrier=(index)=>{
    const history=[];for(let point=Math.max(1,index-19);point<=index;point++)history.push(Math.log(closes[point]/closes[point-1]));
    const entry=closes[index], unit=Math.max(deviation(history)*Math.sqrt(horizon)*1.15,.001), upper=entry*Math.exp(unit), lower=entry*Math.exp(-unit), end=Math.min(series.length-1,index+horizon);
    for(let point=index+1;point<=end;point++){const up=series[point].high>=upper, down=series[point].low<=lower;if(up!==down)return { y:up?1:0,end:point,event:up?'upper':'lower' };if(up&&down)return null;}
    return { y:closes[end]>=entry?1:0,end,event:'vertical' };
  };
  const rows=[];for(let index=24;index<series.length-horizon;index++){const label=tripleBarrier(index);if(label)rows.push({x:featureAt(index),y:label.y,end:label.end,futureReturn:closes[label.end]/closes[index]-1});}
  if(rows.length<180)return null;
  const trainEnd=Math.floor(rows.length*.6), calibrationEnd=Math.floor(rows.length*.8), embargo=horizon;
  const train=rows.slice(0,trainEnd), calibration=rows.slice(trainEnd+embargo,calibrationEnd), test=rows.slice(calibrationEnd+embargo);
  if(calibration.length<30||test.length<30)return null;
  const means=Array.from({length:width},(_,column)=>mean(train.map(row=>row.x[column]))), scales=Array.from({length:width},(_,column)=>deviation(train.map(row=>row.x[column]))), standardize=x=>x.map((value,column)=>clamp((value-means[column])/scales[column],-6,6));
  const weights=Array(width).fill(0);let bias=0;
  for(let epoch=0;epoch<180;epoch++)for(const row of train){const x=standardize(row.x), probability=sigmoid(bias+x.reduce((sum,value,column)=>sum+value*weights[column],0)), error=row.y-probability, rate=.012/(1+epoch/90);bias+=rate*error/train.length;x.forEach((value,column)=>weights[column]+=rate*error*value/train.length)}
  const logistic=x=>sigmoid(bias+standardize(x).reduce((sum,value,column)=>sum+value*weights[column],0));
  // A shallow boosted-stump comparator supplies nonlinear interactions without
  // claiming a LightGBM dependency is present in this zero-dependency service.
  const scores=train.map(()=>logit(mean(train.map(row=>row.y)))), trees=[];
  for(let round=0;round<24;round++){const residual=train.map((row,index)=>row.y-sigmoid(scores[index]));let best=null;for(let column=0;column<width;column++){const values=train.map(row=>row.x[column]).sort((a,b)=>a-b);for(const fraction of [.2,.4,.6,.8]){const threshold=values[Math.floor((values.length-1)*fraction)],left=[],right=[];train.forEach((row,index)=>(row.x[column]<=threshold?left:right).push(index));if(left.length<20||right.length<20)continue;const leftValue=clamp(mean(left.map(index=>residual[index]))*2,-1,1),rightValue=clamp(mean(right.map(index=>residual[index]))*2,-1,1),loss=left.reduce((sum,index)=>sum+(residual[index]-leftValue)**2,0)+right.reduce((sum,index)=>sum+(residual[index]-rightValue)**2,0);if(!best||loss<best.loss)best={column,threshold,leftValue,rightValue,loss};}}if(!best)break;trees.push(best);train.forEach((row,index)=>{scores[index]+=.14*(row.x[best.column]<=best.threshold?best.leftValue:best.rightValue)})}
  const tree=x=>sigmoid(logit(mean(train.map(row=>row.y)))+trees.reduce((sum,item)=>sum+.14*(x[item.column]<=item.threshold?item.leftValue:item.rightValue),0));
  const raw=x=>{const trend=Math.abs(x[4]),volatile=x[3]>.006,treeWeight=(trend>1.1||volatile)?.62:.5;return treeWeight*tree(x)+(1-treeWeight)*logistic(x)};
  let slope=1,intercept=0;for(let epoch=0;epoch<220;epoch++)for(const row of calibration){const probability=sigmoid(slope*logit(raw(row.x))+intercept),error=row.y-probability,rate=.018/(1+epoch/100);slope+=rate*error*logit(raw(row.x))/calibration.length;intercept+=rate*error/calibration.length}
  const calibrated=x=>sigmoid(slope*logit(raw(x))+intercept), baseRate=mean(train.map(row=>row.y)), predicted=test.map(row=>({...row,probability:calibrated(row.x)})), samples=predicted.length;
  const brier=mean(predicted.map(row=>(row.probability-row.y)**2)), baselineBrier=mean(predicted.map(row=>(baseRate-row.y)**2)), logLoss=mean(predicted.map(row=>-(row.y*Math.log(clamp(row.probability,.000001,.999999))+(1-row.y)*Math.log(clamp(1-row.probability,.000001,.999999))))), accuracy=mean(predicted.map(row=>+(+(row.probability>=.5)===+row.y))), bins=Array.from({length:10},()=>[]);
  predicted.forEach(row=>bins[Math.min(9,Math.floor(row.probability*10))].push(row));const reliability=bins.map((bin,index)=>bin.length?{label:`${index*10}–${index*10+10}%`,samples:bin.length,predicted:mean(bin.map(row=>row.probability)),observed:mean(bin.map(row=>row.y))}:null).filter(Boolean), ece=reliability.reduce((sum,bin)=>sum+Math.abs(bin.predicted-bin.observed)*bin.samples/samples,0);
  const ranked=[...predicted].sort((a,b)=>a.probability-b.probability), positives=ranked.filter(row=>row.y).length, negatives=samples-positives, auc=positives&&negatives?(ranked.reduce((sum,row,index)=>sum+(row.y?(index+1):0),0)-positives*(positives+1)/2)/(positives*negatives):null;
  return { probability:calibrated(featureAt(series.length-1)), validation:{accuracy,brier,logLoss,brierSkill:baselineBrier?1-brier/baselineBrier:null,ece,auc,samples,reliability,label:'triple-barrier',split:'chronological 60/20/20 + embargo',embargo,models:['logistic','local boosted-stump baseline'],calibration:'Platt on independent chronological window'}, calibration:{slope,intercept} };
}
function pairedPredictionMetrics(rows, probabilityKey) {
  if(!rows.length)return null;
  const probabilities=rows.map(row=>Number(row[probabilityKey])), labels=rows.map(row=>Number(row.isUp)), mean=values=>values.reduce((sum,value)=>sum+value,0)/Math.max(values.length,1), baseRate=mean(labels), brier=mean(probabilities.map((probability,index)=>(probability-labels[index])**2)), baselineBrier=mean(labels.map(label=>(baseRate-label)**2)), logLoss=mean(probabilities.map((probability,index)=>-(labels[index]*Math.log(clamp(probability,.000001,.999999))+(1-labels[index])*Math.log(clamp(1-probability,.000001,.999999))))), accuracy=mean(probabilities.map((probability,index)=>+(+(probability>=.5)===+labels[index]))), bins=Array.from({length:10},()=>[]);
  probabilities.forEach((probability,index)=>bins[Math.min(9,Math.floor(probability*10))].push({ probability,label:labels[index] }));
  const ece=bins.reduce((sum,bin)=>sum+(bin.length?Math.abs(mean(bin.map(item=>item.probability))-mean(bin.map(item=>item.label)))*bin.length/rows.length:0),0), signals=rows.filter(row=>Math.abs(Number(row[probabilityKey])-.5)>=.06), directionalAccuracy=signals.length?mean(signals.map(row=>+(+(Number(row[probabilityKey])>=.5)===+Number(row.isUp)))):null, coverage=signals.length/rows.length, returns=signals.map(row=>Number(row.actualReturn)*(Number(row[probabilityKey])>=.5?1:-1)-.0008);let equity=1,peak=1,maxDrawdown=0;for(const value of returns){equity*=1+value;peak=Math.max(peak,equity);maxDrawdown=Math.min(maxDrawdown,equity/peak-1)}const average=mean(returns), deviation=Math.sqrt(mean(returns.map(value=>(value-average)**2)))||0;
  return { samples:rows.length, accuracy, directionalAccuracy, coverage, brier, logLoss, brierSkill:baselineBrier?1-brier/baselineBrier:null, ece, economic:{ trades:signals.length, netReturn:equity-1, maxDrawdown, sharpe:deviation?average/deviation*Math.sqrt(returns.length):null } };
}
function compareCandidateToBaseline(trainingRunId) {
  const pairs=database.prepare(`SELECT candidate.horizon_key AS horizonKey, candidate.probability AS candidateProbability, candidate.is_up AS isUp, candidate.actual_return AS actualReturn, baseline.calibrated_probability AS baselineProbability, baseline.regime AS regime
    FROM research_candidate_forecasts AS candidate
    INNER JOIN research_predictions AS baseline ON baseline.horizon_key=candidate.horizon_key AND baseline.bucket_at=candidate.bucket_at
    WHERE candidate.training_run_id=? AND candidate.settled_at IS NOT NULL AND baseline.settled_at IS NOT NULL
    ORDER BY candidate.target_at ASC`).all(trainingRunId).map(row=>({ ...row, isUp:Number(row.isUp), actualReturn:Number(row.actualReturn), candidateProbability:Number(row.candidateProbability), baselineProbability:Number(row.baselineProbability) }));
  const horizons=['15m','1h','4h','1d'], byHorizon=Object.fromEntries(horizons.map(key=>{const rows=pairs.filter(row=>row.horizonKey===key);return [key,{ samples:rows.length, baseline:pairedPredictionMetrics(rows,'baselineProbability'), candidate:pairedPredictionMetrics(rows,'candidateProbability') }]}));
  const overall={ samples:pairs.length, baseline:pairedPredictionMetrics(pairs,'baselineProbability'), candidate:pairedPredictionMetrics(pairs,'candidateProbability') }, regimes=Object.fromEntries(['bull','bear','range'].map(regime=>{const rows=pairs.filter(row=>row.regime===regime);return [regime,{ samples:rows.length, baseline:pairedPredictionMetrics(rows,'baselineProbability'), candidate:pairedPredictionMetrics(rows,'candidateProbability') }]}));
  const requiredPerHorizon=30, enough=horizons.every(key=>byHorizon[key].samples>=requiredPerHorizon), quality=overall.baseline&&overall.candidate&&overall.candidate.brier<=overall.baseline.brier*.97&&overall.candidate.logLoss<=overall.baseline.logLoss*.97, calibration=overall.candidate&&Number(overall.candidate.brierSkill)>=0&&overall.candidate.ece<=overall.baseline.ece*1.05, economics=overall.candidate&&overall.candidate.economic.netReturn>=overall.baseline.economic.netReturn&&overall.candidate.economic.maxDrawdown>=overall.baseline.economic.maxDrawdown-.02, robust=Object.values(regimes).filter(row=>row.samples>=10).every(row=>row.candidate.brier<=row.baseline.brier*1.05);
  const verdict=!enough?{ tone:'yellow', label:'继续影子评估', reason:`每个周期需 ${requiredPerHorizon} 个已配对结算样本；当前样本不足。` }:quality&&calibration&&economics&&robust?{ tone:'green', label:'建议人工复核', reason:'候选在配对样本的概率质量、校准、成本化表现和已验证市场状态中均达到升级门槛；仍不会自动切换。' }:{ tone:'red', label:'不建议升级', reason:'样本已足够，但候选未同时达到预设的概率质量、校准、成本化表现和稳健性门槛。' };
  return { paired:overall.samples, requiredPerHorizon, byHorizon, overall, regimes, criteria:{ quality:'Brier 与 Log Loss 均至少优于现役 3%', calibration:'BSS ≥ 0 且 ECE 不恶化超过 5%', economics:'固定 0.08% 往返成本后净收益不低于现役，最大回撤最多恶化 2%', robustness:'任何样本 ≥10 的市场状态中，Brier 不劣于现役超过 5%' }, verdict, readyForNext:enough, promotionEligible:verdict.tone==='green' };
}
function candidateTrainingStatus() {
  const latest=database.prepare('SELECT id, started_at, completed_at, status, model_name, metrics_json, samples_json, error FROM research_training_runs ORDER BY id DESC LIMIT 1').get();
  if(!latest)return { inProgress:researchTrainingInProgress, latest:null, shadow:{ totalSettled:0, requiredPerHorizon:30, promotionEligible:false, reason:'尚未训练候选模型' } };
  const settled=database.prepare('SELECT horizon_key, probability, is_up AS isUp, brier FROM research_candidate_forecasts WHERE training_run_id=? AND settled_at IS NOT NULL').all(latest.id), pending=database.prepare('SELECT COUNT(*) AS total FROM research_candidate_forecasts WHERE training_run_id=? AND settled_at IS NULL').get(latest.id);
  const byHorizon={};for(const row of settled)(byHorizon[row.horizon_key] ||= []).push(row);
  const horizonSummary=Object.fromEntries(Object.entries(byHorizon).map(([key,rows])=>[key,{ settled:rows.length, hitRate:rows.reduce((sum,row)=>sum+((Number(row.probability)>=.5)===Boolean(row.isUp)?1:0),0)/rows.length, brier:rows.reduce((sum,row)=>sum+Number(row.brier),0)/rows.length }]));
  const comparison=compareCandidateToBaseline(latest.id), totalSettled=settled.length;
  return { inProgress:researchTrainingInProgress, latest:{ id:latest.id, startedAt:latest.started_at, completedAt:latest.completed_at, status:latest.status, modelName:latest.model_name, metrics:latest.metrics_json?JSON.parse(latest.metrics_json):null, samples:latest.samples_json?JSON.parse(latest.samples_json):null, error:latest.error||null }, shadow:{ totalSettled, pending:Number(pending?.total)||0, byHorizon:horizonSummary, requiredPerHorizon:comparison.requiredPerHorizon, readyForNext:comparison.readyForNext, promotionEligible:comparison.promotionEligible, reason:comparison.verdict.reason }, comparison };
}
async function trainResearchCandidate() {
  if(researchTrainingInProgress)throw Object.assign(new Error('candidate training is already running'),{ statusCode:409 });
  const existing=candidateTrainingStatus();
  if(existing.latest?.status==='shadow'&&!existing.shadow.readyForNext)throw Object.assign(new Error('current candidate is still collecting shadow outcomes; do not create another version yet'),{ statusCode:409 });
  researchTrainingInProgress=true;const startedAt=Date.now(), run=storeResearchTrainingRun.run(startedAt,'running','triple-barrier logistic + local tree candidate');
  try {
    const [intraday,daily]=await Promise.all([forecastHistory('15m'),forecastHistory('1d')]);
    const definitions=[{key:'15m',candles:intraday.candles,horizon:1,interval:'15m'},{key:'1h',candles:intraday.candles,horizon:4,interval:'15m'},{key:'4h',candles:intraday.candles,horizon:16,interval:'15m'},{key:'1d',candles:daily.candles,horizon:1,interval:'1d'}];
    const trained=definitions.map(definition=>({ ...definition, fusion:trainFusionModel(definition.candles,definition.horizon) })).filter(row=>row.fusion);
    if(trained.length!==definitions.length)throw new Error('insufficient chronological samples for one or more candidate horizons');
    for(const row of trained){const entry=Number(row.candles.at(-1)?.close), targetAt=Number(row.candles.at(-1)?.time||startedAt)+(row.interval==='1d'?86_400_000:row.horizon*900_000), probability=row.fusion.probability;storeCandidateForecast.run(run.lastInsertRowid,startedAt,startedAt,row.key,row.interval,targetAt,entry,probability,probability>=.5?'up':'down');}
    const metrics=Object.fromEntries(trained.map(row=>[row.key,{ brier:row.fusion.validation.brier, logLoss:row.fusion.validation.logLoss, brierSkill:row.fusion.validation.brierSkill, ece:row.fusion.validation.ece, auc:row.fusion.validation.auc }]));
    const samples=Object.fromEntries(trained.map(row=>[row.key,row.fusion.validation.samples]));
    completeResearchTrainingRun.run(Date.now(),'shadow',JSON.stringify(metrics),JSON.stringify(samples),null,run.lastInsertRowid);
    return candidateTrainingStatus();
  } catch(error) { completeResearchTrainingRun.run(Date.now(),'failed',null,null,error.message,run.lastInsertRowid);throw error; }
  finally { researchTrainingInProgress=false; }
}
function settleResearchPredictions(histories, now) { const rows=pendingResearchPredictions.all(now);for(const row of rows){const candles=histories[row.candle_interval]||[], target=candles.find(candle=>Number(candle.time)>=row.target_at);if(!target)continue;const settledPrice=Number(target.close);if(!Number.isFinite(settledPrice)||!row.entry_price)continue;const actualReturn=settledPrice/row.entry_price-1,isUp=actualReturn>0?1:0,stored=database.prepare('SELECT calibrated_probability FROM research_predictions WHERE id=?').get(row.id),brier=(Number(stored?.calibrated_probability)-isUp)**2;settleResearchPrediction.run(now,settledPrice,actualReturn,isUp,brier,row.id)}for(const row of pendingCandidateForecasts.all(now)){const candles=histories[row.candle_interval]||[],target=candles.find(candle=>Number(candle.time)>=row.target_at);if(!target)continue;const settledPrice=Number(target.close);if(!Number.isFinite(settledPrice)||!row.entry_price)continue;const actualReturn=settledPrice/row.entry_price-1,isUp=actualReturn>0?1:0,brier=(Number(row.probability)-isUp)**2;settleCandidateForecast.run(now,settledPrice,actualReturn,isUp,brier,row.id)}}
function researchScorecard() {
  const settled=database.prepare('SELECT horizon_key, calibrated_probability AS probability, is_up AS isUp, actual_return AS actualReturn, brier FROM research_predictions WHERE settled_at IS NOT NULL ORDER BY settled_at ASC').all(), pending=database.prepare('SELECT horizon_key, COUNT(*) AS total FROM research_predictions WHERE settled_at IS NULL GROUP BY horizon_key').all(), byKey={};
  for(const row of settled)(byKey[row.horizon_key] ||= []).push({probability:Number(row.probability),y:Number(row.isUp),actualReturn:Number(row.actualReturn),brier:Number(row.brier)});
  const mean=values=>values.reduce((sum,value)=>sum+value,0)/Math.max(values.length,1), result={};
  for(const [key,rows] of Object.entries(byKey)){
    const baseRate=mean(rows.map(row=>row.y)), baseline=mean(rows.map(row=>(baseRate-row.y)**2)), brier=mean(rows.map(row=>row.brier)), logLoss=mean(rows.map(row=>-(row.y*Math.log(clamp(row.probability,.000001,.999999))+(1-row.y)*Math.log(clamp(1-row.probability,.000001,.999999))))), bins=Array.from({length:10},()=>[]);rows.forEach(row=>bins[Math.min(9,Math.floor(row.probability*10))].push(row));const ece=bins.reduce((sum,bin)=>sum+(bin.length?Math.abs(mean(bin.map(row=>row.probability))-mean(bin.map(row=>row.y)))*bin.length/rows.length:0),0), signals=rows.filter(row=>Math.abs(row.probability-.5)>=.06), returns=signals.map(row=>row.actualReturn*(row.probability>=.5?1:-1)-.0008);let equity=1,peak=1,maxDrawdown=0;returns.forEach(value=>{equity*=1+value;peak=Math.max(peak,equity);maxDrawdown=Math.min(maxDrawdown,equity/peak-1)});const average=mean(returns), deviation=Math.sqrt(mean(returns.map(value=>(value-average)**2)))||0, downside=Math.sqrt(mean(returns.filter(value=>value<0).map(value=>value**2)))||0;
    result[key]={settled:rows.length,hitRate:mean(rows.map(row=>+(+(row.probability>=.5)===+row.y))),brier,logLoss,brierSkill:baseline?1-brier/baseline:null,ece,meanReturn:mean(rows.map(row=>row.actualReturn)),economic:{assumptions:'0.08% round-trip cost; ±6% probability edge threshold',trades:signals.length,turnover:signals.length/rows.length,netReturn:equity-1,maxDrawdown,sharpe:deviation?average/deviation*Math.sqrt(returns.length):null,sortino:downside?average/downside*Math.sqrt(returns.length):null}};
  }
  return { rows:result, pending:Object.fromEntries(pending.map(row=>[row.horizon_key,Number(row.total)])) };
}
function researchFeatureStatus() {
  const row=database.prepare('SELECT COUNT(*) AS total, MIN(observed_at) AS firstAt, MAX(observed_at) AS lastAt, COUNT(ofi_pct) AS ofiSnapshots FROM derivative_snapshots WHERE source=?').get('okx');
  return { ofiSnapshots:Number(row?.ofiSnapshots)||0, derivativeSnapshots:Number(row?.total)||0, firstAt:Number(row?.firstAt)||null, lastAt:Number(row?.lastAt)||null, readyForTraining:(Number(row?.ofiSnapshots)||0)>=7_200 };
}
function recordCandidateShadowForecasts(windows, now) {
  const active=database.prepare("SELECT id FROM research_training_runs WHERE status='shadow' ORDER BY id DESC LIMIT 1").get();
  if(!active)return;
  for(const window of windows){const bucketAt=Math.floor((Number(window.targetAt)-(window.candleInterval==='1d'?86_400_000:window.horizon*900_000))/900_000)*900_000, probability=Number(window.candidateProbability);if(!Number.isFinite(probability))continue;safelyStore(()=>storeCandidateForecast.run(active.id,bucketAt,now,window.key,window.candleInterval,window.targetAt,window.entryPrice,probability,probability>=.5?'up':'down'));}
}
async function researchOutlook({ refresh = false } = {}) {
  const key='research-outlook', hit=cache.get(key), now=Date.now();
  if (!refresh && hit && now-hit.time<NEWS_TTL) return { ...cacheResult(hit, now), stale:false };
  return coalesce(key, async () => {
    const [intraday,daily,news,sentiment,derivatives,calendar,macro]=await Promise.all([forecastHistory('15m'),forecastHistory('1d'),bitcoinNews({ refresh }),fearGreedSentiment({ refresh }).catch(()=>null),marketContext('okx').catch(()=>null),fedCalendar().catch(()=>null),fedMarketSignals().catch(()=>null)]);
    const newsItems=news.items || [], bullish=newsItems.filter(item=>item.sentiment>0).length, bearish=newsItems.filter(item=>item.sentiment<0).length;
    const newsScore=newsItems.length ? clamp(newsItems.reduce((sum,item)=>{const ageHours=Number.isFinite(item.publishedAt)?Math.max(0,(now-item.publishedAt)/3_600_000):6, timeWeight=Math.exp(-ageHours/4);return sum+item.sentiment*(item.sourceWeight||.7)*(item.eventWeight||.7)*timeWeight},0)/Math.max(1,newsItems.reduce((sum,item)=>sum+(item.sourceWeight||.7),0)),-1,1) : 0;
    const sentimentScore=Number.isFinite(sentiment?.value) ? clamp((sentiment.value-50)/50,-1,1) : 0;
    const microstructureScore=derivatives ? clamp((Number(derivatives.orderBook?.imbalancePct)||0)/30*.32 + (Number(derivatives.takerFlow?.imbalancePct)||0)/35*.38 + (Number(derivatives.oiChangePct)||0)/.8*(Number(derivatives.priceChangePct)||0>=0?1:-1)*.18 - (Number(derivatives.fundingRate)||0)/.001*.08 - (Number(derivatives.basisPct)||0)/.25*.04,-1,1) : 0;
    const eventRisk=(calendar?.events||[]).filter(event=>event.at-now>=0&&event.at-now<=24*3_600_000).map(event=>event.name), eventRangeMultiplier=eventRisk.length?1.35:1;
    const last=intraday.candles.at(-1)?.close || daily.candles.at(-1)?.close;
    settleResearchPredictions({'15m':intraday.candles,'1d':daily.candles},now);
    captureAbExperiments(intraday.source || 'okx','15m',intraday.candles,now);
    // These two candidates are external-feature experiments.  The frozen A
    // uses the simple displayed aggregate; B adds only the stated feature
    // change and is still settled against the very same 15m future close.
    const ofi=Number(derivatives?.orderBook?.ofiPct)||0, book=Number(derivatives?.orderBook?.imbalancePct)||0, taker=Number(derivatives?.takerFlow?.imbalancePct)||0;
    for(const horizon of [1,4])recordAbExternalPair('okx-microstructure',intraday.source || 'okx',intraday.candles,horizon,{a:sigmoid((book*.45+taker*.55)/28),b:sigmoid((ofi*.55+book*.25+taker*.2)/24)},{ofi,book,taker,coverage:derivatives?'snapshot':'missing'},now);
    const recentReturn=Number(intraday.candles.at(-2)?.close)/Math.max(Number(intraday.candles.at(-6)?.close)||1,1)-1, simpleNews=(bullish-bearish)/Math.max(newsItems.length,1), absorbed=Math.abs(recentReturn)>.012&&Math.sign(recentReturn)===Math.sign(newsScore);
    for(const horizon of [4,16])recordAbExternalPair('news-fear-greed',intraday.source || 'okx',intraday.candles,horizon,{a:sigmoid(simpleNews*.75),b:sigmoid(newsScore*(absorbed ? .35 : .82)+sentimentScore*.12)},{newsScore,simpleNews,absorbed,items:newsItems.length},now);
    settleAbExperiments({'15m':intraday.candles,'1d':daily.candles},now);
    // Four horizons share the same historical-feature model; the 15m/1h/4h paths use intraday candles, while 1d uses daily candles.
    // 四个周期共用同一历史特征模型；15 分钟/1 小时/4 小时使用日内 K 线，1 天使用日线。
    const definitions=[{ key:'15m', label:'约 15 分钟', candles:intraday.candles, horizon:1, cap:.015 },{ key:'1h', label:'约 1 小时', candles:intraday.candles, horizon:4, cap:.03 },{ key:'4h', label:'约 4 小时', candles:intraday.candles, horizon:16, cap:.05 },{ key:'1d', label:'约 1 天', candles:daily.candles, horizon:1, cap:.12 }];
    const windows=definitions.map(definition => {
      const history=historicalProjection(definition.candles,definition.horizon);
      const fusion=trainFusionModel(definition.candles,definition.horizon);
      const newsWeight=definition.key==='1d'?.25:.12, sentimentWeight=definition.key==='1d'?.08:.04, microWeight=definition.key==='15m'?.14:definition.key==='1h'?.12:definition.key==='4h'?.09:.025;
      const adjustment=(newsScore*newsWeight + sentimentScore*sentimentWeight + microstructureScore*microWeight)*Math.max(history.volatility,.002);
      const adjustedReturn=clamp(history.expectedReturn + adjustment,-definition.cap,definition.cap), volatilityUnit=Math.max(history.volatility*Math.sqrt(definition.horizon),.001);
      const analogueProbability=history.upProbability, learnedProbability=fusion?.probability ?? analogueProbability;
      // Dynamic, rule-based blending avoids fitting a meta-model before there
      // is enough out-of-fold history. Range states favor analogues; stronger
      // trend/volatility states give the nonlinear price model more weight.
      const analogueWeight=history.regime==='range'?.62:history.volatility>.006?.42:.48;
      const baseProbability=analogueWeight*analogueProbability+(1-analogueWeight)*learnedProbability;
      const rawProbability=sigmoid(logit(baseProbability) + newsScore*.22 + sentimentScore*.12 + microstructureScore*(definition.key==='1d'?.07:.18));
      const upProbability=clamp(rawProbability,.05,.95);
      // A slim probability band is deliberately neutral: a 50%-plus reading is not directional evidence.
      // 概率落在窄幅中性带时刻意显示中性：仅 50% 多并不构成方向证据。
      const direction=upProbability>=.56?'up':upProbability<=.44?'down':'flat';
      const distribution=Object.fromEntries(Object.entries(history.distribution).map(([key,value])=>[key,clamp(value+adjustment,-definition.cap,definition.cap)]));
      const center=distribution.p50, widened={p10:center+(distribution.p10-center)*eventRangeMultiplier,p50:center,p90:center+(distribution.p90-center)*eventRangeMultiplier};
      return { ...definition, upProbability, rawProbability, candidateProbability:learnedProbability, entryPrice:last, expectedReturn:adjustedReturn, expectedMove:last*adjustedReturn, expectedPrice:last*(1+adjustedReturn), direction, samples:history.samples, candidateCount:history.candidateCount, matchQuality:history.matchQuality, regime:history.regime, blend:{analogueWeight,modelWeight:1-analogueWeight}, volatilityUnit, distribution, priceRange:{p10:last*(1+widened.p10),p50:last*(1+widened.p50),p90:last*(1+widened.p90)}, eventRangeMultiplier, candleInterval:definition.key==='1d'?'1d':'15m', targetAt:Number(definition.candles.at(-1)?.time||now)+(definition.key==='1d'?86_400_000:definition.horizon*900_000), validation:fusion?.validation || null };
    });
    // Damp a lone outlier horizon toward neutral; this is a consistency guard, not an attempt to force one direction.
    // 将孤立周期向中性轻微收缩；这是跨周期一致性保护，不会强行统一方向。
    windows.forEach((window,index)=>{const neighbors=windows.filter((_,other)=>Math.abs(other-index)===1).map(item=>item.upProbability);if(neighbors.length&&Math.abs(window.upProbability-neighbors.reduce((sum,value)=>sum+value,0)/neighbors.length)>.18)window.upProbability=.5+(window.upProbability-.5)*.65;window.direction=window.upProbability>=.56?'up':window.upProbability<=.44?'down':'flat'});
    for(const window of windows)safelyStore(()=>storeResearchPrediction.run(Math.floor((Number(window.targetAt)-(window.candleInterval==='1d'?86_400_000:window.horizon*900_000))/900_000)*900_000,now,window.key,window.candleInterval,window.targetAt,last,window.rawProbability,window.upProbability,window.direction,window.regime));
    recordCandidateShadowForecasts(windows,now);
    const primary=windows[2];
    const rankedNews=[...newsItems].map(item=>{const ageHours=Number.isFinite(item.publishedAt)?Math.max(0,(now-item.publishedAt)/3_600_000):6;return {...item,impact:Math.abs(item.sentiment)*(item.sourceWeight||.7)*(item.eventWeight||.7)*Math.exp(-ageHours/4)}}).sort((a,b)=>b.impact-a.impact || (b.publishedAt||0)-(a.publishedAt||0));
    const dxy=macro?.market?.find(row=>row.key==='dxy');
    const result={ price:last, windows, scorecard:researchScorecard(), training:candidateTrainingStatus(), features:researchFeatureStatus(), news:{ source:news.source, fetchedAt:news.fetchedAt, bullish, bearish, neutral:newsItems.length-bullish-bearish, score:newsScore, halfLifeHours:4, items:rankedNews.slice(0,6) }, sentiment:sentiment?{ value:sentiment.value, source:sentiment.source || 'Alternative.me' }:null, derivatives:derivatives?{ source:derivatives.source, score:microstructureScore, fundingRate:derivatives.fundingRate, oiChangePct:derivatives.oiChangePct, bookImbalancePct:derivatives.orderBook?.imbalancePct, ofiPct:derivatives.orderBook?.ofiPct, takerImbalancePct:derivatives.takerFlow?.imbalancePct, cvdSessionNotional:derivatives.takerFlow?.cvdSessionNotional, coverage:['funding','oi-change','order-book','taker-flow','cvd','basis'], collecting:['OFI / top-5 displayed-liquidity changes'], unavailable:['funding term structure / long-short ratio','options PCR / 25Δ skew / IV term structure','liquidation heatmap','spot ETF net flows','on-chain exchange / whale flows','Coinbase and Kimchi premiums'] }:null, macro:{ dxy:dxy?.available?{value:dxy.value,changePct:dxy.changePct,source:dxy.source}:null, status:'DXY is displayed for context only until time-aligned history is validated.' }, eventRisk, historical:{ intradaySource:intraday.source, dailySource:daily.source, intradaySamples:intraday.candles.length, dailySamples:daily.candles.length }, primary, fetchedAt:now, refreshMs:NEWS_TTL, cached:false, disclaimer:'Calibrated historical-model research only; not investment advice.' };
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
async function yahooLiveEquityQuote(symbol) {
  const raw = await request(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=1d&interval=1m&includePrePost=false`, 5_000);
  const meta = raw?.chart?.result?.[0]?.meta || {};
  const last = Number(meta.regularMarketPrice), previous = Number(meta.regularMarketPreviousClose ?? meta.previousClose);
  if (!Number.isFinite(last) || !Number.isFinite(previous) || previous <= 0) throw new Error(`${symbol} live quote unavailable`);
  const regular = meta.currentTradingPeriod?.regular, regularSession=Number(regular?.start) * 1000 <= Date.now() && Date.now() < Number(regular?.end) * 1000;
  return { symbol, last, previous, marketState:String(meta.marketState || '').toUpperCase(), regularSession };
}
async function usEquityQuotes() {
  const key = 'us-equity-quotes', hit = cache.get(key);
  if (hit && Date.now() - hit.time < 10_000) return cacheResult(hit);
  try {
    const quotes = await Promise.all(['SPY','QQQ'].map(yahooLiveEquityQuote));
    const value = { open:quotes.every(quote => quote.marketState === 'REGULAR' || quote.regularSession), quotes, source:'Yahoo Finance', fetchedAt:Date.now(), cached:false };
    remember(key, value); return value;
  } catch {
    // A missing live quote must not be rendered as a stale or empty market row.
    return { open:false, quotes:[], source:'unavailable', fetchedAt:Date.now(), cached:false };
  }
}
async function market(interval, limit, preferred) {
  const key = `${interval}:${limit}:${preferred || 'auto'}`; const hit = cache.get(key);
  const ttl = isSyntheticOkxInterval(interval) ? 1_000 : MARKET_TTL;
  if (hit && Date.now() - hit.time < ttl) return { ...cacheResult(hit), stale:false };
  // 用户选择的数据源需要锁定：上游暂时失败时，报价和图表不能静默切换交易所。
  // A user-selected source is intentionally locked: displayed price and chart
  // must not silently switch exchanges during a temporary upstream failure.
  try { return await coalesce(key, async () => {
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
      captureAbExperiments(source, interval, candles, result.fetchedAt); settleAbExperiments({[interval]:candles},result.fetchedAt); return result;
    } catch { throw Object.assign(new Error('All data sources failed'), { failures }); }
  }, MARKET_REQUEST_TIMEOUT); } catch (error) {
    if (hit && Date.now() - hit.time <= STALE_QUOTE_MAX_AGE) return { ...cacheResult(hit), stale:true, fallbackReason:error.message };
    // Keep the chosen exchange's identity intact.  A stale OKX chart is more
    // honest than silently drawing a Coinbase or Gate chart under an OKX label.
    const fallbackSources = preferred && loaders[preferred] ? [preferred] : sources;
    for (const source of fallbackSources) {
      const fallback = storedMarketFallback(source, interval, limit, error.message);
      if (fallback) return fallback;
    }
    throw error;
  }
}
// AI 助手复用本文件已经写好的数据函数，不另起一套采集逻辑。
// The AI assistant reuses the data functions above instead of duplicating them.
const aiChat = createAiChat({
  market, liveQuote, marketContext, fearGreedSentiment, fedMonitor, investmentCalendar,
  getCredential: (provider) => (provider === 'qwen' ? qwenCredential() : null),
  getVerification: (provider) => Boolean(apiCredentials._verification?.[provider]?.valid),
  setModel: (model) => setQwenModel(model)
});
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon' };
async function edgeTtsAudio(text, voice='zh-CN-XiaoxiaoNeural') {
  const chunks=[];
  for await (const chunk of new Communicate(text, voice, { rate:'+5%' }).stream()) if (chunk.type==='audio') chunks.push(Buffer.from(chunk.data));
  const audio=Buffer.concat(chunks); if(!audio.length) throw new Error('Edge TTS returned no audio'); return audio;
}
http.createServer((req, res) => requestTiming.run({ started:performance.now(), upstreamStarted:null, upstreamEnded:null, upstreamCalls:0 }, async () => {
 try {
 const url = new URL(req.url, `http://${req.headers.host}`);
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
      if(!safeText||safeText.length>240) throw new Error('Voice text must be 1–240 characters');
      const safeVoice=['zh-CN-XiaoxiaoNeural','zh-CN-XiaoyiNeural','zh-CN-liaoning-XiaobeiNeural','zh-CN-shaanxi-XiaoniNeural','zh-TW-HsiaoChenNeural','zh-HK-HiuGaaiNeural','zh-CN-YunxiNeural','zh-CN-YunyangNeural','en-US-AvaNeural','en-US-EmmaNeural','en-US-AnaNeural','en-US-AriaNeural','en-US-JennyNeural','en-US-MichelleNeural','en-US-AndrewNeural','en-US-BrianNeural','en-US-ChristopherNeural','en-US-EricNeural','en-US-GuyNeural','en-US-RogerNeural','en-US-SteffanNeural'].includes(voice)?voice:'zh-CN-XiaoxiaoNeural';
      const audio=await edgeTtsAudio(safeText,safeVoice);
      res.writeHead(200,{'content-type':'audio/mpeg','cache-control':'no-store','content-length':audio.length});res.end(audio);
    } catch(error) { json(res,503,{error:'Edge voice unavailable',detail:error.message}); }
    return;
  }
  // 语音规则同步：前端保存时 POST 上当前 settings + rules；仅用于页面内状态恢复。
  if (url.pathname === '/api/voice/sync' && req.method === 'POST') {
    try {
      const body = await readJson(req);
      const settingsIn = body && body.settings;
      const entriesIn = Array.isArray(body && body.personalEntries) ? body.personalEntries : [];
      const rulesIn = Array.isArray(body && body.rules) ? body.rules : [];
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
  if (url.pathname === '/api/account' && req.method==='DELETE') {
    const user=await requireAlertUser(req,res); if(!user)return;
    await alertStore.deleteAccount(user.id);clearSessionCookie(res);json(res,204,{});return;
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
      refreshPolicy:{ quoteMs:1_000, marketMs:MARKET_TTL, contextMs:CONTEXT_TTL, historyMs:HISTORY_TTL, sentimentMs:SENTIMENT_TTL, fedCalendarMs:FED_CALENDAR_TTL },
      websocket:{ provider:'OKX', status:okxStream.status, tickerAgeMs:streamAge(okxStream.tickerAt, now), messageAgeMs:streamAge(okxStream.lastMessageAt, now), contextAgeMs:streamAge(okxStream.contextAt, now), reconnects:okxStream.reconnects, lastError:okxStream.lastError }
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
    const key = 'forecast-history', force = url.searchParams.get('refresh') === '1'; const hit = cache.get(key);
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
  const relative = url.pathname === '/' ? 'index.html' : normalize(url.pathname).replace(/^[/\\]+/, '');
  if (relative.includes('..')) { res.writeHead(403); res.end(); return; }
  try {
    const file = join(PUBLIC, relative);
    const body = await readFile(file);
    // The dashboard's legacy HTML uses long-lived version query strings for
    // app.js/styles.css. Keep those two entry assets revalidatable locally so a
    // service restart can deliver feature updates without asking users to clear
    // a browser cache; fingerprinted images/fonts remain immutable.
    const immutable = (url.searchParams.has('v') || url.searchParams.has('t')) && !['app.js', 'styles.css'].includes(relative);
    res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream', 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' });
    res.end(body);
  } catch (readError) {
    if (readError && readError.code !== 'ENOENT') console.error('[static]', readError.message);
    res.writeHead(404); res.end('Not found');
  }
  } catch (error) {
    console.error('[fatal] unhandled request error:', error && error.stack || error);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    if (!res.writableEnded) res.end(JSON.stringify({ error: 'Internal server error' }));
  }
})).listen(PORT, HOST, () => console.log(`BTC indicator: http://${HOST}:${PORT}`));
