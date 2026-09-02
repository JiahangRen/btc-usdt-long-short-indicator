import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import pg from 'pg';
import { createClient } from 'redis';

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
function encrypt(value, key) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}
function decrypt(value, key) {
  const raw = Buffer.from(value, 'base64'), iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), body = raw.subarray(28);
  const cipher = createDecipheriv('aes-256-gcm', key, iv); cipher.setAuthTag(tag);
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
  const redis = createClient({ url:process.env.REDIS_URL || 'redis://redis:6379' });
  redis.on('error', error => console.error('Alert Redis error:', error.message));
  try { await pool.query('SELECT 1'); await redis.connect(); } catch (error) { await pool.end().catch(()=>{}); if(redis.isOpen) await redis.quit().catch(()=>{}); return { enabled:false, reason:`alert infrastructure unavailable: ${error.message}` }; }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS alert_users (id UUID PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS alert_sessions (token_hash TEXT PRIMARY KEY, user_id UUID NOT NULL REFERENCES alert_users(id) ON DELETE CASCADE, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS alert_user_profiles (user_id UUID PRIMARY KEY REFERENCES alert_users(id) ON DELETE CASCADE, profile JSONB NOT NULL DEFAULT '{}'::jsonb, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS alert_credentials (user_id UUID PRIMARY KEY REFERENCES alert_users(id) ON DELETE CASCADE, sendkey_ciphertext TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS alert_rules (id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES alert_users(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('price_reached','price_above','price_below','long_liquidation','short_liquidation')), target_price NUMERIC NOT NULL CHECK(target_price > 0), repeat_enabled BOOLEAN NOT NULL DEFAULT false, cooldown_seconds INTEGER NOT NULL DEFAULT 300 CHECK(cooldown_seconds >= 0), enabled BOOLEAN NOT NULL DEFAULT true, last_triggered_at TIMESTAMPTZ, last_triggered_price NUMERIC, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS alert_rules_active_idx ON alert_rules(enabled, kind, target_price);
    CREATE TABLE IF NOT EXISTS alert_deliveries (id UUID PRIMARY KEY, rule_id UUID REFERENCES alert_rules(id) ON DELETE SET NULL, user_id UUID REFERENCES alert_users(id) ON DELETE SET NULL, queued_at TIMESTAMPTZ NOT NULL DEFAULT now(), sent_at TIMESTAMPTZ, status TEXT NOT NULL, response_json JSONB, push_id TEXT, read_key TEXT, error TEXT);
    CREATE INDEX IF NOT EXISTS alert_deliveries_rule_idx ON alert_deliveries(rule_id, queued_at DESC);
  `);
  const createSession = async userId => { const token=randomBytes(32).toString('base64url'), expires=new Date(Date.now()+30*86400_000); await pool.query('INSERT INTO alert_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)',[tokenHash(token),userId,expires]); return { token, expires }; };
  const userFromRequest = async request => { const token=parseCookies(request.headers.cookie).btc_alert_session; if(!token)return null; const row=(await pool.query('SELECT u.id,u.email FROM alert_sessions s JOIN alert_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()',[tokenHash(token)])).rows[0]; return row || null; };
  const ownRule = async (userId, id) => (await pool.query('SELECT id FROM alert_rules WHERE id=$1 AND user_id=$2',[id,userId])).rowCount>0;
  return {
    enabled:true, pool, redis,
    async register(email,password) { email=String(email||'').trim().toLowerCase(); if(!/^\S+@\S+\.\S+$/.test(email)||String(password).length<12) throw Object.assign(new Error('请使用有效邮箱和至少 12 位密码。'),{statusCode:400}); const id=randomUUID(); try { await pool.query('INSERT INTO alert_users(id,email,password_hash) VALUES($1,$2,$3)',[id,email,await passwordHash(password)]); return { user:{id,email}, session:await createSession(id) }; } catch(error) { if(error.code==='23505') throw Object.assign(new Error('该邮箱已注册。'),{statusCode:409}); throw error; } },
    async login(email,password) { const user=(await pool.query('SELECT id,email,password_hash FROM alert_users WHERE email=$1',[String(email||'').trim().toLowerCase()])).rows[0]; if(!user||!await passwordMatches(password,user.password_hash)) throw Object.assign(new Error('邮箱或密码不正确。'),{statusCode:401}); return { user:{id:user.id,email:user.email}, session:await createSession(user.id) }; },
    async logout(request) { const token=parseCookies(request.headers.cookie).btc_alert_session; if(token) await pool.query('DELETE FROM alert_sessions WHERE token_hash=$1',[tokenHash(token)]); },
    userFromRequest,
    async getProfile(userId) { return (await pool.query('SELECT profile FROM alert_user_profiles WHERE user_id=$1',[userId])).rows[0]?.profile || {}; },
    async setProfile(userId,input) { const entries=input?.personalEntries; if(!Array.isArray(entries)||entries.length!==2||entries.some((entry,index)=>{const price=entry?.price;return !entry||!['long','short'].includes(entry.side)||(price!==null&&(!Number.isFinite(Number(price))||Number(price)<=0||Number(price)>100_000_000))||index!==0&&index!==1;})) throw Object.assign(new Error('买入价资料格式无效。'),{statusCode:400}); const profile={personalEntries:entries.map((entry,index)=>({price:entry.price===null?null:Number(entry.price),side:entry.side==='short'?'short':index===1?'short':'long'}))}; await pool.query('INSERT INTO alert_user_profiles(user_id,profile) VALUES($1,$2::jsonb) ON CONFLICT(user_id) DO UPDATE SET profile=EXCLUDED.profile,updated_at=now()',[userId,json(profile)]); return profile; },
    async setSendKey(userId,sendKey) { if(!/^SCT/i.test(String(sendKey||''))) throw Object.assign(new Error('请输入以 SCT 开头的 SendKey。'),{statusCode:400}); await pool.query('INSERT INTO alert_credentials(user_id,sendkey_ciphertext) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET sendkey_ciphertext=EXCLUDED.sendkey_ciphertext,updated_at=now()',[userId,encrypt(sendKey,key)]); },
    async deleteSendKey(userId) { await pool.query('DELETE FROM alert_credentials WHERE user_id=$1',[userId]); },
    async hasSendKey(userId) { return (await pool.query('SELECT 1 FROM alert_credentials WHERE user_id=$1',[userId])).rowCount>0; },
    async testPush(userId,price) { const row=(await pool.query('SELECT sendkey_ciphertext FROM alert_credentials WHERE user_id=$1',[userId])).rows[0]; if(!row) throw Object.assign(new Error('请先保存云端 SendKey。'),{statusCode:400}); const current=Number(price); if(!Number.isFinite(current)||current<=0) throw Object.assign(new Error('实时价格无效。'),{statusCode:400}); const quote=current.toLocaleString('en-US',{maximumFractionDigits:2}),title=`价格告警【测试】 BTC当前价格 ${quote}`,response=await fetch(`https://sctapi.ftqq.com/${encodeURIComponent(decrypt(row.sendkey_ciphertext,key))}.send`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({title,short:`BTC 当前价格 ${quote} USDT`,desp:`${title}\n\n当前市价 ${quote} USDT\n\n该测试不会创建或触发规则。`})}),payload=await response.json().catch(()=>({})); if(!response.ok||Number(payload.code)!==0) throw Object.assign(new Error(payload.message||'云端测试推送请求失败。'),{statusCode:502}); return {pushId:payload.data?.pushid||null}; },
    async listRules(userId) { return (await pool.query('SELECT id,kind,target_price::float AS "targetPrice",repeat_enabled AS repeat,"cooldown_seconds"/60 AS "cooldownMinutes",enabled,last_triggered_at AS "lastTriggeredAt",last_triggered_price::float AS "lastTriggeredPrice",created_at AS "createdAt" FROM alert_rules WHERE user_id=$1 ORDER BY created_at DESC',[userId])).rows; },
    async createRule(userId,input) { const kind=String(input.kind||''), target=Number(input.targetPrice), repeat=Boolean(input.repeat), cooldown=Math.max(0,Math.round(Number(input.cooldownMinutes||5)*60)); if(!['price_reached','price_above','price_below','long_liquidation','short_liquidation'].includes(kind)||!Number.isFinite(target)||target<=0) throw Object.assign(new Error('规则参数无效。'),{statusCode:400}); const id=randomUUID(); await pool.query('INSERT INTO alert_rules(id,user_id,kind,target_price,repeat_enabled,cooldown_seconds) VALUES($1,$2,$3,$4,$5,$6)',[id,userId,kind,target,repeat,cooldown]); return id; },
    async deleteRule(userId,id) { if(!await ownRule(userId,id)) throw Object.assign(new Error('规则不存在。'),{statusCode:404}); await pool.query('DELETE FROM alert_rules WHERE id=$1 AND user_id=$2',[id,userId]); },
    async deleteAccount(userId) { await pool.query('DELETE FROM alert_users WHERE id=$1',[userId]); },
    async activeRules() { return (await pool.query('SELECT r.id,r.user_id AS "userId",r.kind,r.target_price::float AS "targetPrice",r.repeat_enabled AS repeat,"cooldown_seconds" AS "cooldownSeconds" FROM alert_rules r JOIN alert_credentials c ON c.user_id=r.user_id WHERE r.enabled=true')).rows; },
    async claim(rule, price) { const result=await pool.query(`UPDATE alert_rules SET last_triggered_at=now(),last_triggered_price=$2 WHERE id=$1 AND enabled=true AND (repeat_enabled=true AND (last_triggered_at IS NULL OR last_triggered_at <= now()-(cooldown_seconds * interval '1 second')) OR repeat_enabled=false AND last_triggered_at IS NULL) RETURNING id,user_id AS "userId"`,[rule.id,price]); return result.rows[0] || null; },
    async enqueue(rule, price) { const keyRow=(await pool.query('SELECT sendkey_ciphertext FROM alert_credentials WHERE user_id=$1',[rule.userId])).rows[0]; if(!keyRow) return; const deliveryId=randomUUID(); await pool.query('INSERT INTO alert_deliveries(id,rule_id,user_id,status) VALUES($1,$2,$3,$4)',[deliveryId,rule.id,rule.userId,'queued']); await redis.lPush('btc-alert:push',json({deliveryId,rule,price,sendKey:decrypt(keyRow.sendkey_ciphertext,key)})); },
    async nextPush() { const result=await redis.brPop('btc-alert:push',1); return result ? unjson(result.element) : null; },
    async finishPush(deliveryId,result) { await pool.query('UPDATE alert_deliveries SET status=$2,sent_at=now(),response_json=$3,push_id=$4,read_key=$5,error=$6 WHERE id=$1',[deliveryId,result.ok?'queued_to_serverchan':'failed',json(result.payload),result.payload?.data?.pushid||null,result.payload?.data?.readkey||null,result.error||null]); },
    async close() { await redis.quit(); await pool.end(); }
  };
}
