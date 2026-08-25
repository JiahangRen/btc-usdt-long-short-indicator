import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = join(process.cwd(), 'public');
// A short cache keeps the one-second client refresh responsive without issuing
// duplicate upstream requests from rapid UI interactions.
const TTL = 15_000;
const cache = new Map();
// Keep the automatic market selection aligned with the dashboard default and
// the BTC-USDT perpetual contract used by the owner.
const sources = ['okx', 'gate', 'binance'];

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
function validCandle(c) { return c && [c.time, c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite); }
function intervalFor(source, interval) {
  const map = { '1m':'1m', '5m':'5m', '15m':'15m', '30m':'30m', '1h':'1H', '2h':'2H', '4h':'4H', '1d':'1D', '1w':'1W' };
  if (source === 'gate' || source === 'binance') return interval === '1h' ? '1h' : interval === '2h' ? '2h' : interval === '4h' ? '4h' : interval === '1d' ? '1d' : interval === '1w' ? '1w' : interval;
  return map[interval];
}
async function request(url, timeout = 4_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(timer); }
}
async function requestText(url, timeout = 8_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { accept: 'text/csv,text/plain' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally { clearTimeout(timer); }
}
async function fromGate(interval, limit) {
  const [ticker, rows] = await Promise.all([
    request('https://api.gateio.ws/api/v4/futures/usdt/tickers?contract=BTC_USDT'),
    request(`https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=BTC_USDT&interval=${intervalFor('gate', interval)}&limit=${limit}`)
  ]);
  const d = ticker[0]; if (!d) throw new Error('ticker payload empty');
  return { ticker: { last:+d.last, open24h:+d.last / (1 + (+d.change_percentage || 0) / 100), changePct:+d.change_percentage, high24:+d.high_24h, low24:+d.low_24h }, candles: rows.map(c => ({ time:+c.t*1000, volume:+c.v, close:+c.c, high:+c.h, low:+c.l, open:+c.o })).reverse() };
}
async function fromOKX(interval, limit) {
  const [ticker, rows] = await Promise.all([
    // Keep the dashboard on the same market as the OKX mobile perpetual
    // contract, rather than mixing its price with BTC-USDT spot.
    request('https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT-SWAP'),
    request(`https://www.okx.com/api/v5/market/candles?instId=BTC-USDT-SWAP&bar=${intervalFor('okx', interval)}&limit=${limit}`)
  ]);
  const d = ticker.data?.[0]; if (!d || ticker.code !== '0' || rows.code !== '0') throw new Error(ticker.msg || rows.msg || 'invalid API payload');
  return { ticker: { last:+d.last, open24h:+d.open24h, changePct:(+d.last / +d.open24h - 1) * 100, high24:+d.high24h, low24:+d.low24h }, candles: rows.data.map(c => ({ time:+c[0], open:+c[1], high:+c[2], low:+c[3], close:+c[4], volume:+c[5] })).reverse() };
}
async function fromBinance(interval, limit) {
  const [ticker, rows] = await Promise.all([
    request('https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=BTCUSDT'),
    request(`https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=${intervalFor('binance', interval)}&limit=${limit}`)
  ]);
  return { ticker: { last:+ticker.lastPrice, open24h:+ticker.openPrice, changePct:+ticker.priceChangePercent, high24:+ticker.highPrice, low24:+ticker.lowPrice }, candles: rows.map(c => ({ time:+c[0], open:+c[1], high:+c[2], low:+c[3], close:+c[4], volume:+c[5] })) };
}
const loaders = { gate: fromGate, okx: fromOKX, binance: fromBinance };
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
    try { return { candles:await loader(interval), source }; }
    catch (e) { failures.push(`${source}: ${e.name === 'AbortError' ? 'timeout' : e.message}`); }
  }
  throw new Error(failures.join('; '));
}
async function yahooHistory(symbol) {
  const raw = await request(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=2y&interval=1d&events=history`);
  const result = raw.chart?.result?.[0]; const closes = result?.indicators?.quote?.[0]?.close;
  if (!result?.timestamp || !closes) throw new Error(`${symbol} history unavailable`);
  const candles = result.timestamp.map((time, i) => ({ time:time * 1000, close:+closes[i] })).filter(x => Number.isFinite(x.close));
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
async function market(interval, limit, preferred) {
  const key = `${interval}:${limit}:${preferred || 'auto'}`; const hit = cache.get(key);
  if (hit && Date.now() - hit.time < TTL) return { ...hit.value, cached: true };
  // A user-selected source is intentionally locked: displayed price and chart
  // must not silently switch exchanges during a temporary upstream failure.
  const order = preferred && loaders[preferred] ? [preferred] : sources;
  const failures = {};
  const jobs = order.map(source => loaders[source](interval, limit).then(value => ({ source, value })).catch(e => { failures[source] = e.name === 'AbortError' ? 'timeout (4s)' : e.message; throw e; }));
  try {
    const { source, value } = await Promise.any(jobs);
    const candles = value.candles.filter(validCandle).sort((a,b) => a.time - b.time).slice(-limit);
    if (candles.length < 30 || !Number.isFinite(value.ticker.last)) throw new Error('insufficient valid market data');
    const result = { ...value, candles, source, fetchedAt: Date.now(), cached: false, failures };
    cache.set(key, { time: Date.now(), value: result }); return result;
  } catch { throw Object.assign(new Error('All data sources failed'), { failures }); }
}
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon' };
http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/api/market') {
    const interval = url.searchParams.get('interval') || '4h';
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 180), 30), 300);
    try { json(res, 200, await market(interval, limit, url.searchParams.get('source'))); } catch (e) { json(res, 503, { error:e.message, failures:e.failures || {} }); }
    return;
  }
  if (url.pathname === '/api/status') { json(res, 200, { sources, cacheEntries: cache.size, now:Date.now() }); return; }
  if (url.pathname === '/api/forecast-history') {
    const key = 'forecast-history'; const hit = cache.get(key);
    try {
      if (hit && Date.now() - hit.time < 300_000) { json(res, 200, { ...hit.value, cached:true }); return; }
      const [intradayResult, dailyResult] = await Promise.all([forecastHistory('15m'), forecastHistory('1d')]);
      const value = { intraday:intradayResult.candles, daily:dailyResult.candles, source:`${intradayResult.source}/${dailyResult.source}`, fetchedAt:Date.now(), cached:false };
      cache.set(key, { time:Date.now(), value }); json(res, 200, value);
    } catch (e) { json(res, 503, { error:'Forecast history unavailable', detail:e.message }); }
    return;
  }
  if (url.pathname === '/api/correlation-history') {
    const key = 'correlation-history'; const hit = cache.get(key);
    try {
      if (hit && Date.now() - hit.time < 300_000) { json(res, 200, { ...hit.value, cached:true }); return; }
      const [btc, spy, qqq] = await Promise.all([forecastHistory('1d'), equityHistory('SPY'), equityHistory('QQQ')]);
      const value = { btc:btc.candles.map(x=>({time:x.time,close:x.close})), spy:spy.candles, qqq:qqq.candles, indexQuotes:{spy:spy.quote,qqq:qqq.quote}, sources:{btc:btc.source,spy:spy.source,qqq:qqq.source}, fetchedAt:Date.now(), cached:false };
      cache.set(key, { time:Date.now(), value }); json(res, 200, value);
    } catch (e) { json(res, 503, { error:'Correlation history unavailable', detail:e.message }); }
    return;
  }
  const relative = url.pathname === '/' ? 'index.html' : normalize(url.pathname).replace(/^[/\\]+/, '');
  if (relative.includes('..')) { res.writeHead(403); res.end(); return; }
  try { const file = join(PUBLIC, relative); const body = await readFile(file); res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream' }); res.end(body); }
  catch { res.writeHead(404); res.end('Not found'); }
}).listen(PORT, HOST, () => console.log(`BTC indicator: http://${HOST}:${PORT}`));
