// 多渠道推送模块（v2.10.52 从 alert-store / alert-worker 中拆出）。
// Multi-channel push module: one registry of channel types, one sender.
// 渠道类型：serverchan(Server酱/微信)、bark(iOS)、feishu(飞书)、dingtalk(钉钉)、webhook(通用 Web)。
// 本模块不依赖数据库，只负责「配置校验 → 组装请求 → 发送/验证/掩码」，
// 存储加密仍在 alert-store.mjs，投递编排仍在 alert-worker.mjs。

// 统一带超时的 fetch，避免外部推送服务卡住时无限挂起（原实现在 alert-store.mjs，
// 拆分后从本模块导出，alert-store 转出口保持兼容）。
export const fetchWithTimeout = async (url, options = {}, timeout = 8000) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try { return await fetch(url, { ...options, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
};

import { createHmac } from 'node:crypto';

// ---- 渠道类型注册表 -------------------------------------------------------
// 每个渠道声明：label（界面名）、fields（配置字段，secret=true 的字段列表时掩码）、
// 默认配置 defaults。发送逻辑在 CHANNEL_SENDERS。
export const CHANNEL_TYPES = {
  serverchan: {
    label: 'Server酱（微信）',
    hint: '在 sct.ftqq.com 获取 SendKey，推送到微信「Server酱」服务号。',
    fields: [
      { key: 'sendKey', label: 'SendKey', type: 'password', placeholder: 'SCT…', required: true, secret: true },
    ],
    defaults: {},
  },
  bark: {
    label: 'Bark（iOS 推送）',
    hint: 'iOS 安装 Bark App 后复制推送 URL；自建服务器可修改推送地址。',
    fields: [
      { key: 'serverUrl', label: '推送地址', type: 'text', placeholder: 'https://api.day.app', required: false },
      { key: 'deviceKey', label: '设备 Key', type: 'password', placeholder: 'Bark 推送 URL 中的 Key', required: true, secret: true },
    ],
    defaults: { serverUrl: 'https://api.day.app' },
  },
  feishu: {
    label: '飞书自定义机器人',
    hint: '飞书群 → 设置 → 群机器人 → 添加「自定义机器人」，复制 Webhook 地址；开了签名校验就同时填密钥。',
    fields: [
      { key: 'webhookUrl', label: 'Webhook 地址', type: 'text', placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/…', required: true },
      { key: 'secret', label: '签名密钥（可选）', type: 'password', placeholder: '开启签名校验时填写', required: false, secret: true },
    ],
    defaults: {},
  },
  dingtalk: {
    label: '钉钉自定义机器人',
    hint: '钉钉群 → 群设置 → 智能群助手 → 添加「自定义机器人」（安全设置选「加签」最简单）。',
    fields: [
      { key: 'webhookUrl', label: 'Webhook 地址', type: 'text', placeholder: 'https://oapi.dingtalk.com/robot/send?access_token=…', required: true },
      { key: 'secret', label: '加签密钥（SEC 开头，可选）', type: 'password', placeholder: 'SEC…', required: false, secret: true },
    ],
    defaults: {},
  },
  webhook: {
    label: '通用 Webhook',
    hint: '向任意 HTTP 接口 POST JSON：{title, short, body, time}，适合 n8n / 自建网关 / 企业微信应用等。',
    fields: [
      { key: 'url', label: 'Webhook URL', type: 'text', placeholder: 'https://…', required: true },
    ],
    defaults: {},
  },
};

const isHttpUrl = value => /^https?:\/\/.+/i.test(String(value || '').trim());
const trim = value => String(value ?? '').trim();

// ---- 配置校验与归一化 -----------------------------------------------------
// 校验失败抛带 statusCode 的错误（server 直接透传给前端）。
export function validateChannelConfig(type, input) {
  const def = CHANNEL_TYPES[type];
  if (!def) throw Object.assign(new Error('不支持的推送渠道类型。'), { statusCode: 400 });
  const config = { ...def.defaults };
  for (const field of def.fields) {
    const value = trim(input?.[field.key]);
    if (field.required && !value) throw Object.assign(new Error(`「${field.label}」不能为空。`), { statusCode: 400 });
    if (value) config[field.key] = value;
  }
  if (type === 'serverchan' && !/^SCT/i.test(config.sendKey || '')) throw Object.assign(new Error('Server酱 SendKey 需以 SCT 开头。'), { statusCode: 400 });
  if (type === 'bark') {
    if (config.serverUrl && !isHttpUrl(config.serverUrl)) throw Object.assign(new Error('Bark 推送地址必须是 http(s) URL。'), { statusCode: 400 });
    config.serverUrl = (config.serverUrl || 'https://api.day.app').replace(/\/+$/, '');
  }
  if ((type === 'feishu' || type === 'dingtalk' || type === 'webhook') && !isHttpUrl(config.webhookUrl || config.url)) throw Object.assign(new Error('Webhook 地址必须是 http(s) URL。'), { statusCode: 400 });
  return config;
}

// ---- 渠道发送器 -----------------------------------------------------------
// message: { title, short, body }；返回 { ok, status, payload, error }。
const formBody = params => new URLSearchParams(params);

export const SIGN_HELPERS = {
  // 飞书：sign = base64(HmacSHA256(key=`${timestamp}\n${secret}`, message=''))
  feishuSign(secret, timestampSeconds) {
    const stringToSign = `${timestampSeconds}\n${secret}`;
    return createHmac('sha256', stringToSign).update('').digest('base64');
  },
  // 钉钉：sign = base64(HmacSHA256(key=secret, message=`${timestamp}\n${secret}`))，timestamp 毫秒。
  dingtalkSign(secret, timestampMs) {
    const stringToSign = `${timestampMs}\n${secret}`;
    return createHmac('sha256', secret).update(stringToSign).digest('base64');
  },
};

export const CHANNEL_SENDERS = {
  async serverchan(config, message) {
    const response = await fetchWithTimeout(`https://sctapi.ftqq.com/${encodeURIComponent(config.sendKey)}.send`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: formBody({ title: message.title, short: message.short || message.title, desp: message.body }),
    });
    const payload = await response.json().catch(() => ({}));
    return { ok: response.ok && Number(payload.code) === 0, status: response.status, payload };
  },
  async bark(config, message) {
    const response = await fetchWithTimeout(`${config.serverUrl}/push`, {
      method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' },
      // v2.12.62：Bark 无 markdown 渲染，降级成纯文本（剥 ** 加粗 / 链接转「文字：URL」）。
      body: JSON.stringify({ device_key: config.deviceKey, title: message.title, body: `${message.title}\n${plainFromMarkdown(message.body)}`, group: 'btc-indicator' }),
    });
    const payload = await response.json().catch(() => ({}));
    return { ok: response.ok && Number(payload.code) === 200, status: response.status, payload };
  },
  async feishu(config, message) {
    const body = { msg_type: 'text', content: { text: `${message.title}\n${message.body}` } };
    if (config.secret) {
      body.timestamp = Math.floor(Date.now() / 1000).toString();
      body.sign = SIGN_HELPERS.feishuSign(config.secret, body.timestamp);
    }
    const response = await fetchWithTimeout(config.webhookUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    return { ok: response.ok && (payload.code === 0 || payload.StatusCode === 0), status: response.status, payload };
  },
  async dingtalk(config, message) {
    let url = config.webhookUrl;
    if (config.secret) {
      const timestamp = Date.now();
      const sign = encodeURIComponent(SIGN_HELPERS.dingtalkSign(config.secret, timestamp));
      url += `${url.includes('?') ? '&' : '?'}timestamp=${timestamp}&sign=${sign}`;
    }
    // v2.12.62：钉钉从 text 改走 markdown 消息，** 加粗与链接才得以渲染。
    // v2.12.64：换行策略改为段落空行（\n\n）。行尾双空格硬换行在钉钉客户端不稳定，
    // 单 \n 会被折叠成空格导致所有字段挤成一行；\n\n 每个字段独占一行、行间留白，渲染稳定。
    // 过滤空行避免出现连续空段。
    const text = `#### ${message.title}\n\n${message.body.split('\n').filter(line => line.trim()).join('\n\n')}`;
    const response = await fetchWithTimeout(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { title: message.title, text } }),
    });
    const payload = await response.json().catch(() => ({}));
    return { ok: response.ok && Number(payload.errcode) === 0, status: response.status, payload };
  },
  async webhook(config, message) {
    const response = await fetchWithTimeout(config.url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: message.title, short: message.short || message.title, body: message.body, time: new Date().toISOString() }),
    });
    return { ok: response.ok, status: response.status, payload: null };
  },
};

// 统一发送入口。任何异常都收敛成 { ok:false, error }，绝不向上抛。
export async function sendChannelMessage(type, config, message) {
  const sender = CHANNEL_SENDERS[type];
  if (!sender) return { ok: false, error: `未知渠道类型 ${type}` };
  try { return await sender(config, message); }
  catch (error) { return { ok: false, error: error.name === 'AbortError' ? '请求超时（8s）' : error.message }; }
}

// 渠道验证：发一条标注【验证】的测试消息，返回与 sendChannelMessage 同构的结果。
export async function verifyChannelConfig(type, config) {
  return sendChannelMessage(type, config, {
    title: '【验证】BTC 指标器推送渠道',
    short: '渠道验证消息',
    body: `这是一条渠道验证消息。\n发送时间 ${new Date().toLocaleString('zh-CN', { hour12: false })}\n收到即说明该渠道配置可用。`,
  });
}

// ---- 敏感信息掩码 ---------------------------------------------------------
// 列表接口不回传完整密钥：secret 字段保留前 4 后 4，中间用 … 代替。
export function maskConfig(type, config) {
  const def = CHANNEL_TYPES[type];
  if (!def) return {};
  const masked = {};
  for (const field of def.fields) {
    const value = String(config?.[field.key] ?? '');
    if (!field.secret) { masked[field.key] = value; continue; }
    masked[field.key] = value.length > 10 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value ? '••••' : '';
    masked[`__masked__${field.key}`] = true;
  }
  return masked;
}

// 判断前端回传的配置是否只是掩码（编辑时未改动密钥 → 沿用旧值）。
export function isMaskedConfig(type, input) {
  const def = CHANNEL_TYPES[type];
  if (!def) return false;
  return def.fields.some(field => field.secret && Boolean(input?.[`__masked__${field.key}`]) && !trim(input?.[field.key]));
}

// ---- 消息文案 -------------------------------------------------------------
// 告警类消息的统一文案组装，本地规则/云端规则/亏损联动共用同一套标题语义。
// 站点链接（v2.12.62）：告警正文末尾附醒目蓝链（钉钉/飞书/Server酱 的 markdown 均渲染为可点蓝色链接）。
export const SITE_LINK = '[🔗 jeffereyreng.site · 查看实时行情](https://jeffereyreng.site/)';
// 把 markdown 文案降级成纯文本（Bark 无渲染，** 与 [t](u) 会裸露）。
export const plainFromMarkdown = s => String(s || '')
  .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1：$2')
  .replace(/\*\*([^*]+)\*\*/g, '$1')
  .replace(/(^|\n)#{1,6}\s*/g, '$1');
export function buildAlertMessage({ categoryLabel = '价格', phrase, target, current, test = false, note = '', direction = null, coin = 'BTC' } = {}) {
  // categoryLabel 允许传 '价格' 或 '价格告警'；统一成带「告警」的标签，避免重复（价格告警告警）或缺失（【价格】）。
  const label = categoryLabel.endsWith('告警') ? categoryLabel : `${categoryLabel}告警`;
  // 红跌绿涨色标（v2.12.63）：
  //   优先用显式 direction（'up'绿/'down'红/'none'中立）—— 由调用方按告警语义给出，最准确；
  //   未传时回退到短语方向词推断（兼容旧调用方）。爆仓语义修正：多头爆仓=价格下跌=红、空头爆仓=价格上涨=绿，
  //   旧正则把「接近多头爆仓价」误判成绿色，本次一并修掉。
  const dot = direction === 'up' ? '🟢'
    : direction === 'down' ? '🔴'
    : /空头爆仓|short liquidation|涨破|上涨|上破|升穿|逼近空头/.test(phrase) ? '🟢'
    : /多头爆仓|long liquidation|跌破|下跌|下破|回落|逼近多头/.test(phrase) ? '🔴'
    : '⚠️';
  const title = test ? `${label}【测试】${dot} ${phrase}` : `【${label}】${dot} ${phrase}`;
  const short = target ? `${coin} ${target} USDT` : `${coin} 当前价格 ${current} USDT`;
  // note（客户端组装的完整明细）自带站点链接，不再重复拼接标题/短语；
  // 无 note 时就地组装：当前价 → 站点链接（触发短语只保留在标题里，避免正文重复）。
  const bodyParts = note
    ? [note]
    : [...(current ? [`当前价：**${current} USDT**`] : []), '', SITE_LINK];
  return { title, short, body: bodyParts.join('\n') };
}
