import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import pg from 'pg';
import { createClient } from 'redis';
// 多渠道推送的校验/发送/验证/掩码统一在 notification.mjs（v2.10.52 拆分）。
import { validateChannelConfig, maskConfig, isMaskedConfig, sendChannelMessage, verifyChannelConfig, buildAlertMessage, fetchWithTimeout as sharedFetchWithTimeout } from './notification.mjs';
// fetchWithTimeout 原先由本模块导出（alert-worker 引用），拆分后转出口保持兼容。
export const fetchWithTimeout = sharedFetchWithTimeout;

const scrypt = promisify(scryptCallback);
const { Pool } = pg;
const json = value => JSON.stringify(value ?? {});
const unjson = value => { try { return JSON.parse(value || '{}'); } catch { return {}; } };
const tokenHash = token => createHash('sha256').update(token).digest('hex');
const parseCookies = value => Object.fromEntries((value || '').split(';').map(part => part.trim().split('=').map(decodeURIComponent)).filter(parts => parts.length === 2));

function masterKey() {
  const raw = process.env.ALERT_ENCRYPTION_KEY || '';
  const key = raw ? Buffer.from(raw, 'base64') : null;
  if (!key || key.length !== 32) throw new Error('ALERT_ENCRYPTION_KEY must be a 32-byte base64 value');
  return key;
}
// Versioned authenticated envelope.  GCM both encrypts and detects any change
// to the ciphertext; AAD binds a record to its user and purpose so a database
// row cannot be copied into a different account/column and still decrypt.
function encrypt(value, key, aad='') {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `v1.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}`;
}
function decrypt(value, key, aad='') {
  // The no-prefix path supports records written by the previous release and
  // is only used during read-and-rewrite migration.
  const encoded=String(value || ''), raw = Buffer.from(encoded.startsWith('v1.') ? encoded.slice(3) : encoded, 'base64');
  if (raw.length < 29) throw Object.assign(new Error('Encrypted account data is malformed.'),{statusCode:500});
  const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), body = raw.subarray(28);
  const cipher = createDecipheriv('aes-256-gcm', key, iv);
  if (encoded.startsWith('v1.')) cipher.setAAD(Buffer.from(aad, 'utf8'));
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(body), cipher.final()]).toString('utf8');
}
async function passwordHash(password) {
  const salt = randomBytes(16); const hash = await scrypt(password, salt, 64);
  return `${salt.toString('base64')}.${Buffer.from(hash).toString('base64')}`;
}
async function passwordMatches(password, saved) {
  const [salt, hash] = String(saved || '').split('.'); if (!salt || !hash) return false;
  const actual = Buffer.from(await scrypt(password, Buffer.from(salt, 'base64'), 64)), expected = Buffer.from(hash, 'base64');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function createAlertStore() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return { enabled:false, reason:'DATABASE_URL is not configured' };
  let key; try { key = masterKey(); } catch (error) { return { enabled:false, reason:error.message }; }
  const pool = new Pool({ connectionString, max:Number(process.env.ALERT_DB_POOL_SIZE || 10), ssl:process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized:true } : undefined });
  // 空闲连接异常必须监听，否则会冒泡成未处理事件导致进程崩溃。
  // Idle connection errors must be observed; otherwise they surface as unhandled events and crash the process.
  pool.on('error', error => console.error('Alert Postgres pool error:', error.message));
  const redis = createClient({ url:process.env.REDIS_URL || 'redis://redis:6379' });
  redis.on('error', error => console.error('Alert Redis error:', error.message));
  try { await pool.query('SELECT 1'); await redis.connect(); } catch (error) { await pool.end().catch(()=>{}); if(redis.isOpen) await redis.quit().catch(()=>{}); return { enabled:false, reason:`alert infrastructure unavailable: ${error.message}` }; }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS alert_users (id UUID PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS alert_sessions (token_hash TEXT PRIMARY KEY, user_id UUID NOT NULL REFERENCES alert_users(id) ON DELETE CASCADE, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS alert_user_profiles (user_id UUID PRIMARY KEY REFERENCES alert_users(id) ON DELETE CASCADE, profile JSONB NOT NULL DEFAULT '{}'::jsonb, profile_ciphertext TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS alert_credentials (user_id UUID PRIMARY KEY REFERENCES alert_users(id) ON DELETE CASCADE, sendkey_ciphertext TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS alert_rules (id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES alert_users(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('price_reached','price_above','price_below','long_liquidation','short_liquidation')), target_price NUMERIC NOT NULL CHECK(target_price > 0), repeat_enabled BOOLEAN NOT NULL DEFAULT false, cooldown_seconds INTEGER NOT NULL DEFAULT 300 CHECK(cooldown_seconds >= 0), enabled BOOLEAN NOT NULL DEFAULT true, last_triggered_at TIMESTAMPTZ, last_triggered_price NUMERIC, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS alert_rules_active_idx ON alert_rules(enabled, kind, target_price);
    CREATE TABLE IF NOT EXISTS alert_deliveries (id UUID PRIMARY KEY, rule_id UUID REFERENCES alert_rules(id) ON DELETE SET NULL, user_id UUID REFERENCES alert_users(id) ON DELETE SET NULL, queued_at TIMESTAMPTZ NOT NULL DEFAULT now(), sent_at TIMESTAMPTZ, status TEXT NOT NULL, response_json JSONB, push_id TEXT, read_key TEXT, error TEXT);
    CREATE INDEX IF NOT EXISTS alert_deliveries_rule_idx ON alert_deliveries(rule_id, queued_at DESC);
    CREATE TABLE IF NOT EXISTS alert_channels (id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES alert_users(id) ON DELETE CASCADE, type TEXT NOT NULL CHECK(type IN ('serverchan','bark','feishu','dingtalk','webhook')), name TEXT NOT NULL, config_ciphertext TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT true, last_verified_at TIMESTAMPTZ, last_verify_ok BOOLEAN, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS alert_channels_user_idx ON alert_channels(user_id);
    CREATE TABLE IF NOT EXISTS alert_push_settings (user_id UUID PRIMARY KEY REFERENCES alert_users(id) ON DELETE CASCADE, settings JSONB NOT NULL DEFAULT '{}'::jsonb, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
  `);
  // PostgreSQL does not support ADD COLUMN IF NOT EXISTS in very old versions;
  // supported deployments are modern, and this keeps existing accounts online.
  await pool.query('ALTER TABLE alert_user_profiles ADD COLUMN IF NOT EXISTS profile_ciphertext TEXT');
  const createSession = async userId => { const token=randomBytes(32).toString('base64url'), expires=new Date(Date.now()+30*86400_000); await pool.query('INSERT INTO alert_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)',[tokenHash(token),userId,expires]); return { token, expires }; };
  const userFromRequest = async request => { const token=parseCookies(request.headers.cookie).btc_alert_session; if(!token)return null; const row=(await pool.query('SELECT u.id,u.email FROM alert_sessions s JOIN alert_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()',[tokenHash(token)])).rows[0]; return row || null; };
  const ownRule = async (userId, id) => (await pool.query('SELECT id FROM alert_rules WHERE id=$1 AND user_id=$2',[id,userId])).rowCount>0;
  return {
    enabled:true, pool, redis,
    async register(email,password) { email=String(email||'').trim().toLowerCase(); if(!/^\S+@\S+\.\S+$/.test(email)||String(password).length<12) throw Object.assign(new Error('请使用有效邮箱和至少 12 位密码。'),{statusCode:400}); const id=randomUUID(); try { await pool.query('INSERT INTO alert_users(id,email,password_hash) VALUES($1,$2,$3)',[id,email,await passwordHash(password)]); return { user:{id,email}, session:await createSession(id) }; } catch(error) { if(error.code==='23505') throw Object.assign(new Error('该邮箱已注册。'),{statusCode:409}); throw error; } },
    async login(email,password) { const user=(await pool.query('SELECT id,email,password_hash FROM alert_users WHERE email=$1',[String(email||'').trim().toLowerCase()])).rows[0]; if(!user||!await passwordMatches(password,user.password_hash)) throw Object.assign(new Error('邮箱或密码不正确。'),{statusCode:401}); return { user:{id:user.id,email:user.email}, session:await createSession(user.id) }; },
    async logout(request) { const token=parseCookies(request.headers.cookie).btc_alert_session; if(token) await pool.query('DELETE FROM alert_sessions WHERE token_hash=$1',[tokenHash(token)]); },
    userFromRequest,
    async getProfile(userId) { const row=(await pool.query('SELECT profile,profile_ciphertext FROM alert_user_profiles WHERE user_id=$1',[userId])).rows[0]; if(!row)return {}; if(!row.profile_ciphertext){const profile=row.profile || {}, ciphertext=encrypt(json(profile),key,`profile:${userId}`); await pool.query("UPDATE alert_user_profiles SET profile='{}'::jsonb,profile_ciphertext=$2,updated_at=now() WHERE user_id=$1",[userId,ciphertext]); return profile;} try { return unjson(decrypt(row.profile_ciphertext,key,`profile:${userId}`)); } catch { throw Object.assign(new Error('账户加密资料无法验证，请联系支持人员恢复。'),{statusCode:500}); } },
    async setProfile(userId,input) { const entries=input?.personalEntries; if(!Array.isArray(entries)||entries.length!==2||entries.some((entry,index)=>{const price=entry?.price,amount=entry?.amount,margin=entry?.margin,leverage=entry?.leverage;return !entry||!['long','short'].includes(entry.side)||(price!==null&&(!Number.isFinite(Number(price))||Number(price)<=0||Number(price)>100_000_000))||(amount!==null&&amount!==undefined&&(!Number.isFinite(Number(amount))||Number(amount)<=0||Number(amount)>1_000_000_000))||(margin!==null&&margin!==undefined&&(!Number.isFinite(Number(margin))||Number(margin)<=0||Number(margin)>1_000_000_000))||(leverage!==null&&leverage!==undefined&&(!Number.isFinite(Number(leverage))||Number(leverage)<1||Number(leverage)>125))||index!==0&&index!==1;})) throw Object.assign(new Error('持仓资料格式无效。'),{statusCode:400}); const profile={personalEntries:entries.map((entry,index)=>({price:entry.price===null?null:Number(entry.price),amount:entry.amount===null||entry.amount===undefined?null:Number(entry.amount),margin:entry.margin===null||entry.margin===undefined?null:Number(entry.margin),leverage:entry.leverage===null||entry.leverage===undefined?null:Number(entry.leverage),side:entry.side==='short'?'short':'long'}))}; const ciphertext=encrypt(json(profile),key,`profile:${userId}`); await pool.query('INSERT INTO alert_user_profiles(user_id,profile,profile_ciphertext) VALUES($1,$2::jsonb,$3) ON CONFLICT(user_id) DO UPDATE SET profile=$2::jsonb,profile_ciphertext=$3,updated_at=now()',[userId,'{}',ciphertext]); return profile; },
    // ---- 多渠道推送（v2.10.52）：渠道即唯一事实来源，legacy alert_credentials 只作迁移源 ----
    // 老用户首次触达渠道体系时，把 alert_credentials 里的 SendKey 静默迁移成一条 serverchan 渠道。
    async ensureLegacySendKeyMigrated() {
      try {
        const rows = (await pool.query('SELECT c.user_id, c.sendkey_ciphertext FROM alert_credentials c WHERE NOT EXISTS (SELECT 1 FROM alert_channels ch WHERE ch.user_id = c.user_id AND ch.type = \'serverchan\')')).rows;
        for (const row of rows) await pool.query('INSERT INTO alert_channels(id,user_id,type,name,config_ciphertext) VALUES($1,$2,\'serverchan\',\'Server酱\',$3)', [randomUUID(), row.user_id, row.sendkey_ciphertext]);
      } catch (error) { console.error('Legacy SendKey migration failed:', error.message); }
    },
    async listChannels(userId) {
      await this.ensureLegacySendKeyMigrated();
      const rows = (await pool.query('SELECT id,type,name,enabled,config_ciphertext,last_verified_at AS "lastVerifiedAt",last_verify_ok AS "lastVerifyOk",created_at AS "createdAt" FROM alert_channels WHERE user_id=$1 ORDER BY created_at ASC', [userId])).rows;
      return rows.map(row => { let config={}; try { config = unjson(decrypt(row.config_ciphertext,key,`channel:${row.id}`)); } catch {} return { id:row.id, type:row.type, name:row.name, enabled:row.enabled, config:maskConfig(row.type,config), lastVerifiedAt:row.lastVerifiedAt, lastVerifyOk:row.lastVerifyOk, createdAt:row.createdAt }; });
    },
    async channelConfigs(userId) {
      const rows = (await pool.query('SELECT id,type,name,config_ciphertext FROM alert_channels WHERE user_id=$1 AND enabled=true ORDER BY created_at ASC', [userId])).rows;
      return rows.map(row => { let config={}; try { config = unjson(decrypt(row.config_ciphertext,key,`channel:${row.id}`)); } catch {} return { id:row.id, type:row.type, name:row.name, config }; }).filter(row => Object.keys(row.config).length);
    },
    async saveChannel(userId, input) {
      // 编辑时前端对未改动的 secret 字段只回传掩码标记+空值 → 用旧值补齐后整体重加密。
      let oldRow = null, oldConfig = null;
      if (input?.id) {
        oldRow = (await pool.query('SELECT type,config_ciphertext FROM alert_channels WHERE id=$1 AND user_id=$2', [input.id, userId])).rows[0] || null;
        if (oldRow) { try { oldConfig = unjson(decrypt(oldRow.config_ciphertext, key, `channel:${input.id}`)); } catch {} }
      }
      const type = String(input?.type || oldRow?.type || '');
      const configInput = { ...(input?.config || {}) };
      const secretFields = { serverchan:['sendKey'], bark:['deviceKey'], feishu:['secret'], dingtalk:['secret'], webhook:[] }[type] || [];
      for (const field of secretFields) {
        if (configInput[`__masked__${field}`] && !String(configInput[field] || '').trim() && oldConfig?.[field]) configInput[field] = oldConfig[field];
        delete configInput[`__masked__${field}`];
      }
      const config = validateChannelConfig(type, configInput);
      const name = String(input?.name || '').trim() || `推送渠道 ${new Date().toLocaleDateString('zh-CN')}`;
      const enabled = input?.enabled === undefined ? true : Boolean(input.enabled);
      const id = input?.id || randomUUID();
      await pool.query(`INSERT INTO alert_channels(id,user_id,type,name,config_ciphertext,enabled) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(id) DO UPDATE SET type=EXCLUDED.type,name=EXCLUDED.name,config_ciphertext=EXCLUDED.config_ciphertext,enabled=EXCLUDED.enabled,last_verified_at=NULL,last_verify_ok=NULL`, [id, userId, type, name, encrypt(json(config), key, `channel:${id}`), enabled]);
      return id;
    },
    async deleteChannel(userId, id) {
      const result = await pool.query('DELETE FROM alert_channels WHERE id=$1 AND user_id=$2 RETURNING type', [id, userId]);
      if (!result.rowCount) throw Object.assign(new Error('渠道不存在。'), { statusCode: 404 });
      // 清除最后一条 serverchan 渠道时，同步清掉 legacy alert_credentials 里的 SendKey，
      // 否则 listChannels→ensureLegacySendKeyMigrated 会用老 Key 静默复活渠道（表现为「清除后仍显示未验证」）。
      if (result.rows[0].type === 'serverchan' && !(await pool.query("SELECT 1 FROM alert_channels WHERE user_id=$1 AND type='serverchan' LIMIT 1", [userId])).rowCount) await pool.query('DELETE FROM alert_credentials WHERE user_id=$1', [userId]);
    },
    async setChannelEnabled(userId, id, enabled) { const result = await pool.query('UPDATE alert_channels SET enabled=$3 WHERE id=$1 AND user_id=$2', [id, userId, Boolean(enabled)]); if (!result.rowCount) throw Object.assign(new Error('渠道不存在。'), { statusCode: 404 }); },
    async verifyChannelById(userId, id) {
      const row = (await pool.query('SELECT type,config_ciphertext FROM alert_channels WHERE id=$1 AND user_id=$2', [id, userId])).rows[0];
      if (!row) throw Object.assign(new Error('渠道不存在。'), { statusCode: 404 });
      let config = {}; try { config = unjson(decrypt(row.config_ciphertext, key, `channel:${id}`)); } catch {}
      const result = await verifyChannelConfig(row.type, config);
      await pool.query('UPDATE alert_channels SET last_verified_at=now(), last_verify_ok=$3 WHERE id=$1 AND user_id=$2', [id, userId, result.ok]);
      return result;
    },
    // 推送设置：总开关 + 亏损联动（与持仓档案联动的 ROE 阈值）。
    async getPushSettings(userId) {
      const row = (await pool.query('SELECT settings FROM alert_push_settings WHERE user_id=$1', [userId])).rows[0];
      const saved = row?.settings || {};
      const loss = saved.lossPush || {};
      return { masterEnabled: saved.masterEnabled !== false, lossPush: { enabled: Boolean(loss.enabled), warnRoe: Math.min(1000, Math.max(1, Number(loss.warnRoe) || 20)), lossRoe: Math.min(1000, Math.max(1, Number(loss.lossRoe) || 50)), cooldownMinutes: Math.min(1440, Math.max(1, Number(loss.cooldownMinutes) || 30)) } };
    },
    async setPushSettings(userId, patch) {
      const current = await this.getPushSettings(userId);
      const loss = patch?.lossPush || {};
      const settings = {
        masterEnabled: patch?.masterEnabled === undefined ? current.masterEnabled : Boolean(patch.masterEnabled),
        lossPush: {
          enabled: loss.enabled === undefined ? current.lossPush.enabled : Boolean(loss.enabled),
          warnRoe: loss.warnRoe === undefined ? current.lossPush.warnRoe : Math.min(1000, Math.max(1, Number(loss.warnRoe) || 1)),
          lossRoe: loss.lossRoe === undefined ? current.lossPush.lossRoe : Math.min(1000, Math.max(1, Number(loss.lossRoe) || 1)),
          cooldownMinutes: loss.cooldownMinutes === undefined ? current.lossPush.cooldownMinutes : Math.min(1440, Math.max(1, Number(loss.cooldownMinutes) || 1)),
        },
      };
      await pool.query('INSERT INTO alert_push_settings(user_id,settings) VALUES($1,$2::jsonb) ON CONFLICT(user_id) DO UPDATE SET settings=$2::jsonb,updated_at=now()', [userId, JSON.stringify(settings)]);
      return settings;
    },
    // 亏损联动扫描清单：总开关开启 + 启用了亏损推送 + 有持仓档案的账户。
    async lossWatchList() {
      const rows = (await pool.query(`SELECT s.user_id, s.settings, p.profile_ciphertext FROM alert_push_settings s JOIN alert_user_profiles p ON p.user_id = s.user_id WHERE s.settings->>'masterEnabled' <> 'false' AND (s.settings->'lossPush'->>'enabled') = 'true'`)).rows;
      const out = [];
      for (const row of rows) {
        let profile = {}; try { profile = unjson(decrypt(row.profile_ciphertext, key, `profile:${row.user_id}`)); } catch { continue; }
        const entries = (profile.personalEntries || []).filter(entry => entry && Number(entry.price) > 0);
        if (!entries.length) continue;
        out.push({ userId: row.user_id, settings: unjson(json(row.settings)), entries });
      }
      return out;
    },
    // 一次性投递记录（无规则实体，如亏损联动/测试）：只落 alert_deliveries 供追溯。
    async recordDelivery(userId, kindLabel, results) {
      try { await pool.query('INSERT INTO alert_deliveries(id,user_id,status,response_json,error) VALUES($1,$2,$3,$4,$5)', [randomUUID(), userId, results.some(r => r.ok) ? 'delivered' : 'failed', json({ kind: kindLabel, channels: results }), results.every(r => !r.ok) ? (results[0]?.error || '所有渠道投递失败') : null]); } catch {}
    },
    // 向该用户所有启用渠道发送一条消息；返回逐渠道结果。
    async dispatchToChannels(userId, message) {
      const channels = await this.channelConfigs(userId);
      if (!channels.length) return { ok: false, error: '未启用任何推送渠道', results: [] };
      const results = [];
      for (const channel of channels) {
        const result = await sendChannelMessage(channel.type, channel.config, message);
        results.push({ id: channel.id, type: channel.type, name: channel.name, ok: result.ok, error: result.error || (result.ok ? null : `HTTP ${result.status ?? '请求失败'}`) });
      }
      return { ok: results.some(r => r.ok), results };
    },
    async setSendKey(userId,sendKey) { // 兼容旧端点：等价于保存一条 serverchan 渠道。
      const config = validateChannelConfig('serverchan', { sendKey });
      await this.ensureLegacySendKeyMigrated();
      const existing = (await pool.query('SELECT id FROM alert_channels WHERE user_id=$1 AND type=\'serverchan\' ORDER BY created_at ASC LIMIT 1', [userId])).rows[0];
      if (existing) await pool.query('UPDATE alert_channels SET config_ciphertext=$3,last_verified_at=NULL,last_verify_ok=NULL WHERE id=$1 AND user_id=$2', [existing.id, userId, encrypt(json(config), key, `channel:${existing.id}`)]);
      else { const id = randomUUID(); await pool.query('INSERT INTO alert_channels(id,user_id,type,name,config_ciphertext) VALUES($1,$2,\'serverchan\',\'Server酱\',$3)', [id, userId, encrypt(json(config), key, `channel:${id}`)]); }
      await pool.query('INSERT INTO alert_credentials(user_id,sendkey_ciphertext) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET sendkey_ciphertext=EXCLUDED.sendkey_ciphertext,updated_at=now()',[userId,encrypt(config.sendKey,key,`sendkey:${userId}`)]);
    },
    async deleteSendKey(userId) { await pool.query('DELETE FROM alert_channels WHERE user_id=$1 AND type=\'serverchan\'', [userId]); await pool.query('DELETE FROM alert_credentials WHERE user_id=$1',[userId]); },
    // 「已就绪」= 至少启用了一条渠道（总开关在 enqueue 阶段单独判断）。
    async hasSendKey(userId) { await this.ensureLegacySendKeyMigrated(); return (await pool.query('SELECT 1 FROM alert_channels WHERE user_id=$1 AND enabled=true LIMIT 1',[userId])).rowCount > 0; },
    async getSendKey(userId) { await this.ensureLegacySendKeyMigrated(); const row=(await pool.query('SELECT id, config_ciphertext FROM alert_channels WHERE user_id=$1 AND type=\'serverchan\' AND enabled=true ORDER BY created_at ASC LIMIT 1',[userId])).rows[0]; if(!row) return null; try { return unjson(decrypt(row.config_ciphertext,key,`channel:${row.id}`)).sendKey || null; } catch { throw Object.assign(new Error('云端 SendKey 无法验证，请重新保存。'),{statusCode:500}); } },
    async testPush(userId,price) { // 测试推送：发给所有启用渠道，逐渠道回报结果。
      await this.ensureLegacySendKeyMigrated();
      const current=Number(price); if(!Number.isFinite(current)||current<=0) throw Object.assign(new Error('实时价格无效。'),{statusCode:400});
      const quote=current.toLocaleString('en-US',{maximumFractionDigits:2});
      const message=buildAlertMessage({ categoryLabel:'价格', phrase:`BTC当前价格 ${quote}`, current:quote, test:true, note:'该测试不会创建或触发规则。' });
      const { ok, results, error } = await this.dispatchToChannels(userId, message);
      if (!results.length) throw Object.assign(new Error(error || '请先添加并启用至少一个推送渠道。'),{statusCode:400});
      await this.recordDelivery(userId, '测试推送', results);
      if (!ok) throw Object.assign(new Error(results.find(r => r.error)?.error || '所有渠道测试推送均失败。'),{statusCode:502});
      return { ok:true, results };
    },
    async listRules(userId) { return (await pool.query('SELECT id,kind,target_price::float AS "targetPrice",repeat_enabled AS repeat,"cooldown_seconds"/60 AS "cooldownMinutes",enabled,last_triggered_at AS "lastTriggeredAt",last_triggered_price::float AS "lastTriggeredPrice",created_at AS "createdAt" FROM alert_rules WHERE user_id=$1 ORDER BY created_at DESC',[userId])).rows; },
    async createRule(userId,input) { const kind=String(input.kind||''), target=Number(input.targetPrice), repeat=Boolean(input.repeat), cooldown=Math.max(0,Math.round(Number(input.cooldownMinutes||5)*60)); if(!['price_reached','price_above','price_below','long_liquidation','short_liquidation'].includes(kind)||!Number.isFinite(target)||target<=0) throw Object.assign(new Error('规则参数无效。'),{statusCode:400}); const id=randomUUID(); await pool.query('INSERT INTO alert_rules(id,user_id,kind,target_price,repeat_enabled,cooldown_seconds) VALUES($1,$2,$3,$4,$5,$6)',[id,userId,kind,target,repeat,cooldown]); return id; },
    async deleteRule(userId,id) { if(!await ownRule(userId,id)) throw Object.assign(new Error('规则不存在。'),{statusCode:404}); await pool.query('DELETE FROM alert_rules WHERE id=$1 AND user_id=$2',[id,userId]); },
    async deleteAccount(userId) { await pool.query('DELETE FROM alert_users WHERE id=$1',[userId]); },
    async activeRules() { await this.ensureLegacySendKeyMigrated(); return (await pool.query('SELECT r.id,r.user_id AS "userId",r.kind,r.target_price::float AS "targetPrice",r.repeat_enabled AS repeat,"cooldown_seconds" AS "cooldownSeconds" FROM alert_rules r WHERE r.enabled=true AND EXISTS (SELECT 1 FROM alert_channels c WHERE c.user_id=r.user_id AND c.enabled=true)')).rows; },
    async claim(rule, price) { const result=await pool.query(`UPDATE alert_rules SET last_triggered_at=now(),last_triggered_price=$2 WHERE id=$1 AND enabled=true AND (repeat_enabled=true AND (last_triggered_at IS NULL OR last_triggered_at <= now()-(cooldown_seconds * interval '1 second')) OR repeat_enabled=false AND last_triggered_at IS NULL) RETURNING id,user_id AS "userId"`,[rule.id,price]); return result.rows[0] || null; },
    async enqueue(rule, price) { if(!await this.hasSendKey(rule.userId)) return; const deliveryId=randomUUID(); await pool.query('INSERT INTO alert_deliveries(id,rule_id,user_id,status) VALUES($1,$2,$3,$4)',[deliveryId,rule.id,rule.userId,'queued']); await redis.lPush('btc-alert:push',json({deliveryId,rule,price})); },
    async nextPush() { const result=await redis.brPop('btc-alert:push',1); return result ? unjson(result.element) : null; },
    async finishPush(deliveryId,result) { await pool.query('UPDATE alert_deliveries SET status=$2,sent_at=now(),response_json=$3,push_id=$4,read_key=$5,error=$6 WHERE id=$1',[deliveryId,result.ok?'queued_to_serverchan':'failed',json(result.payload),result.payload?.data?.pushid||null,result.payload?.data?.readkey||null,result.error||null]); },
    async close() { await redis.quit(); await pool.end(); }
  };
}
