#!/usr/bin/env node
/* BTC 指示器 MCP 服务器（stdio · JSON-RPC 2.0 · 零依赖）
 * 把本地看板已经采集好的行情数据暴露成 MCP 工具，供支持 MCP 的 AI 客户端调用。
 * Exposes the dashboard's already-collected market data as MCP tools for any MCP-capable client.
 *
 * 设计选择 / Design choice
 * 这里不重复采集，而是转发到已运行的看板服务（默认 127.0.0.1:8787）。
 * 好处：数据口径与页面完全一致，缓存、多源降级、SQLite 落库全部复用。
 * It forwards to the running dashboard instead of re-fetching, so the numbers
 * always match the page: same cache, same fallback chain, same storage.
 *
 * 安装 / Install: 写入 ~/.workbuddy/mcp.json 后重启 WorkBuddy 并信任该连接器。
 */

const BASE = (process.env.BTC_INDICATOR_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const SERVER_INFO = { name:'btc-indicator', version:'1.0.0' };

async function callApi(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${BASE}${path}`, { signal:controller.signal, headers:{ accept:'application/json' } });
    if (!response.ok) throw new Error(`看板服务返回 HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`请求看板服务超时（20 秒）：${BASE}`);
    if (error.cause?.code === 'ECONNREFUSED') throw new Error(`看板服务未运行，请先启动本地服务：${BASE}`);
    throw error;
  } finally { clearTimeout(timer); }
}

const TOOLS = [
  {
    name:'get_market_snapshot',
    description:'获取 BTC/USDT 的完整分析快照：多周期（1d/4h/1h）K 线与技术指标（EMA/MACD/RSI/布林/ATR）、实时报价、资金费率、持仓量、期现基差、恐惧贪婪指数、宏观日程。做行情判断前先调用它。',
    inputSchema:{ type:'object', properties:{ source:{ type:'string', enum:['okx','binance','coinbase','gate'], description:'数据源，默认 okx' } }, required:[] }
  },
  {
    name:'get_price',
    description:'获取 BTC/USDT 最新价格、24 小时涨跌幅与高低点。',
    inputSchema:{ type:'object', properties:{ source:{ type:'string', enum:['okx','binance','coinbase','gate'], description:'数据源，默认 okx' } }, required:[] }
  },
  {
    name:'get_indicators',
    description:'获取指定周期的技术指标画像：EMA20/50/200、RSI14、MACD、布林带、ATR、区间位置、量能比、多空打分。',
    inputSchema:{ type:'object', properties:{ timeframe:{ type:'string', enum:['1d','4h','1h'], description:'周期，默认 1d' }, source:{ type:'string', enum:['okx','binance','coinbase','gate'], description:'数据源，默认 okx' } }, required:[] }
  },
  {
    name:'get_sentiment',
    description:'获取市场情绪：恐惧贪婪指数、资金费率、下期费率、持仓量、期现基差。',
    inputSchema:{ type:'object', properties:{ source:{ type:'string', enum:['okx','binance','coinbase','gate'], description:'数据源，默认 okx' } }, required:[] }
  },
  {
    name:'get_macro_calendar',
    description:'获取即将公布的宏观事件（美联储日程、CPI、非农、国债拍卖等），这些时点通常会放大 BTC 波动。',
    inputSchema:{ type:'object', properties:{}, required:[] }
  }
];

function text(value) {
  return JSON.stringify(value, null, 2);
}

async function runTool(name, args) {
  const source = args?.source || 'okx';
  if (name === 'get_price') {
    const data = await callApi(`/api/ai/snapshot?source=${encodeURIComponent(source)}`);
    return text({ source:data.snapshot.source, generatedAt:data.snapshot.generatedAt, price:data.snapshot.price });
  }
  if (name === 'get_indicators') {
    const timeframe = args?.timeframe || '1d';
    const data = await callApi(`/api/ai/snapshot?source=${encodeURIComponent(source)}`);
    const profile = data.snapshot.timeframes[timeframe];
    if (!profile) throw new Error(`暂无 ${timeframe} 周期数据`);
    // K 线数组较长，工具调用时按需裁剪，保留最近 20 根。
    // Trim the candle array for tool calls; 20 recent bars are enough.
    return text({ ...profile, candles:profile.candles.slice(-20) });
  }
  if (name === 'get_sentiment') {
    const data = await callApi(`/api/ai/snapshot?source=${encodeURIComponent(source)}`);
    return text({ sentiment:data.snapshot.sentiment, derivatives:data.snapshot.derivatives });
  }
  if (name === 'get_macro_calendar') {
    const data = await callApi('/api/ai/snapshot');
    return text(data.snapshot.macro);
  }
  if (name === 'get_market_snapshot') {
    const data = await callApi(`/api/ai/snapshot?source=${encodeURIComponent(source)}`);
    return text(data.snapshot);
  }
  throw new Error(`未知工具：${name}`);
}

function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }

async function handle(message) {
  const { id, method, params } = message || {};
  if (method === 'initialize') {
    send({ jsonrpc:'2.0', id, result:{ protocolVersion:'2024-11-05', capabilities:{ tools:{} }, serverInfo:SERVER_INFO } });
    return;
  }
  if (method === 'ping') { send({ jsonrpc:'2.0', id, result:{} }); return; }
  if (method === 'tools/list') { send({ jsonrpc:'2.0', id, result:{ tools:TOOLS } }); return; }
  if (method === 'tools/call') {
    try {
      const output = await runTool(params?.name, params?.arguments || {});
      send({ jsonrpc:'2.0', id, result:{ content:[{ type:'text', text:output }] } });
    } catch (error) {
      send({ jsonrpc:'2.0', id, result:{ content:[{ type:'text', text:`错误：${error.message}` }], isError:true } });
    }
    return;
  }
  // 通知类消息（notifications/*）不需要响应。Notifications must not be answered.
  if (typeof method === 'string' && method.startsWith('notifications/')) return;
  if (id !== undefined) send({ jsonrpc:'2.0', id, error:{ code:-32601, message:`不支持的方法：${method}` } });
}

let buffer = '';
let pending = 0, stdinEnded = false;
// stdin 关闭后仍要等所有在途请求返回，否则异步工具调用会被截断。
// After stdin closes we still wait for in-flight requests, or async tool calls get truncated.
function maybeExit() { if (stdinEnded && pending === 0) process.exit(0); }
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed;
    try { parsed = JSON.parse(trimmed); } catch { continue; }
    pending += 1;
    Promise.resolve(handle(parsed))
      .catch(error => {
        if (parsed.id !== undefined) send({ jsonrpc:'2.0', id:parsed.id, error:{ code:-32603, message:String(error?.message || error) } });
      })
      .finally(() => { pending -= 1; maybeExit(); });
  }
});
process.stdin.on('end', () => { stdinEnded = true; maybeExit(); });
process.on('unhandledRejection', () => { /* 保持 stdio 会话存活 / keep the stdio session alive */ });
