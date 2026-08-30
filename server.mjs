import http from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// BTC 指标服务端：负责静态页面、公开数据源、SQLite 快照与实时 OKX 连接。
// BTC indicator backend: serves the UI, public data sources, SQLite snapshots, and the live OKX connection.
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = join(process.cwd(), 'public');
const DATA_DIR = join(process.cwd(), 'data');
mkdirSync(DATA_DIR, { recursive:true });
const database = new DatabaseSync(join(DATA_DIR, 'market.sqlite'));
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
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
    taker_buy_ratio_pct REAL, taker_trade_count INTEGER
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
    event_name TEXT NOT NULL, event_at INTEGER NOT NULL, source TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS fed_calendar_snapshots_event_time ON fed_calendar_snapshots(event_key, observed_at DESC);
  CREATE TABLE IF NOT EXISTS btc_news_snapshots (
    id INTEGER PRIMARY KEY, observed_at INTEGER NOT NULL, published_at INTEGER,
    title TEXT NOT NULL, url TEXT, source TEXT, sentiment INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS btc_news_snapshots_title_time ON btc_news_snapshots(title, published_at);
  CREATE INDEX IF NOT EXISTS btc_news_snapshots_observed_time ON btc_news_snapshots(observed_at DESC);
`);
const storeQuote = database.prepare('INSERT INTO quote_snapshots (source, observed_at, last, open24h, change_pct, high24, low24) VALUES (?, ?, ?, ?, ?, ?, ?)');
const storeCandle = database.prepare('INSERT OR IGNORE INTO candles (source, interval, candle_time, open, high, low, close, volume, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
const updateCandle = database.prepare('UPDATE candles SET open=?, high=?, low=?, close=?, volume=?, updated_at=? WHERE source=? AND interval=? AND candle_time=?');
const storeMarketSnapshot = database.prepare('INSERT INTO market_snapshots (source, interval, observed_at, candle_count, last, cached) VALUES (?, ?, ?, ?, ?, ?)');
const storeTrainingRun = database.prepare('INSERT INTO training_runs (observed_at, source, intraday_count, daily_count, forced) VALUES (?, ?, ?, ?, ?)');
const storeDerivativeSnapshot = database.prepare('INSERT INTO derivative_snapshots (source, observed_at, funding_rate, oi, book_imbalance_pct, book_ratio, taker_buy_ratio_pct, taker_trade_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
const storeSentimentSnapshot = database.prepare('INSERT INTO sentiment_snapshots (observed_at, value, classification, source) VALUES (?, ?, ?, ?)');
const storeMacroMarketSnapshot = database.prepare('INSERT INTO macro_market_snapshots (observed_at, metric_key, value, change_pct, available, source, cadence) VALUES (?, ?, ?, ?, ?, ?, ?)');
const storeFedCalendarSnapshot = database.prepare('INSERT INTO fed_calendar_snapshots (observed_at, event_key, event_name, event_at, source) VALUES (?, ?, ?, ?, ?)');
const storeNewsSnapshot = database.prepare('INSERT OR IGNORE INTO btc_news_snapshots (observed_at, published_at, title, url, source, sentiment) VALUES (?, ?, ?, ?, ?, ?)');
const priorOiSnapshot = database.prepare('SELECT observed_at, oi FROM derivative_snapshots WHERE source=? AND observed_at<=? AND oi IS NOT NULL ORDER BY observed_at DESC LIMIT 1');
const priorFundingSnapshot = database.prepare('SELECT observed_at, funding_rate FROM derivative_snapshots WHERE source=? AND observed_at<=? AND funding_rate IS NOT NULL ORDER BY observed_at DESC LIMIT 1');
const priorQuoteSnapshot = database.prepare('SELECT observed_at, last FROM quote_snapshots WHERE source=? AND observed_at<=? AND last IS NOT NULL ORDER BY observed_at DESC LIMIT 1');
const latestSentimentSnapshot = database.prepare('SELECT observed_at, value, classification, source FROM sentiment_snapshots ORDER BY observed_at DESC LIMIT 1');
let lastStorageCleanup = 0;
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
    storeDerivativeSnapshot.run(source, observedAt, numberOrNull(values.fundingRate), numberOrNull(values.oi), numberOrNull(values.bookImbalancePct), numberOrNull(values.bookRatio), numberOrNull(values.takerBuyRatioPct), Number.isFinite(values.takerTradeCount) ? values.takerTradeCount : null);
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
    for (const event of events) storeFedCalendarSnapshot.run(observedAt, event.key, event.name, event.at, event.source);
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
function coalesce(key, work) {
  const running = inFlight.get(key);
  if (running) return running;
  const promise = Promise.resolve().then(work).finally(() => inFlight.delete(key));
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
  lastMessageAt:0, tickerAt:0, contextAt:0, connectedAt:0,
  reconnects:0, lastError:null, retryMs:1_000, heartbeat:null, retryTimer:null
};
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
    takerBuyRatioPct:takerFlow?.buyRatioPct, takerTradeCount:takerFlow?.tradeCount
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
    if (total > 0) { okxStream.orderBook = { bidDepth, askDepth, ratio:askDepth ? bidDepth / askDepth : null, imbalancePct:(bidDepth - askDepth) / total * 100 }; okxStream.bookAt = now; }
  } else if (channel === 'trades') {
    for (const trade of rows) {
      const price = +trade.px, size = +trade.sz, side = trade.side === 'buy' ? 'buy' : trade.side === 'sell' ? 'sell' : null;
      if (side && Number.isFinite(price) && Number.isFinite(size) && size > 0) { const notional=price*size;okxStream.takerTrades.push({ time:now, side, notional });okxStream.cvdNotional+=side==='buy'?notional:-notional; }
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
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}
function validCandle(c) { return c && [c.time, c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite); }
function intervalFor(source, interval) {
  const map = { '1m':'1m', '5m':'5m', '15m':'15m', '30m':'30m', '1h':'1H', '2h':'2H', '3h':'3H', '4h':'4H', '1d':'1D', '1w':'1W' };
  if (source === 'gate' || source === 'binance') return interval === '1h' ? '1h' : interval === '2h' ? '2h' : interval === '4h' ? '4h' : interval === '1d' ? '1d' : interval === '1w' ? '1w' : interval;
  return map[interval];
}
async function request(url, timeout = UPSTREAM_TIMEOUT) {
  const scope = requestTiming.getStore(), started = performance.now();
  if (scope && scope.upstreamStarted === null) scope.upstreamStarted = started;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
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
  if (interval !== '3h') return request(`https://www.okx.com/api/v5/market/candles?instId=BTC-USDT-SWAP&bar=${intervalFor('okx', interval)}&limit=${limit}`);
  // OKX 没有原生 3 小时 K 线：分页取得足量 1 小时 K 线后，按 UTC 3 小时边界聚合，确保信号仍有 200 根数据。
  // OKX has no native 3H bar. Fetch enough native 1H bars in pages, then
  // aggregate them on a UTC 3-hour boundary so the signal still has 200 bars.
  const pages = [];
  let after = '';
  for (let page = 0; page < 3; page++) {
    const suffix = after ? `&after=${after}` : '';
    const payload = await request(`https://www.okx.com/api/v5/market/candles?instId=BTC-USDT-SWAP&bar=1H&limit=300${suffix}`);
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
async function fedCalendar() {
  const key = 'fed-calendar', hit = cache.get(key), now = Date.now();
  if (hit && now - hit.time < FED_CALENDAR_TTL) return { ...cacheResult(hit, now), stale:false };
  try {
    return await coalesce(key, async () => {
      const pages = await Promise.allSettled([
        requestText('https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm', 8_000),
        requestText('https://www.bls.gov/schedule/news_release/cpi.htm', 8_000),
        requestText('https://www.bls.gov/schedule/news_release/empsit.htm', 8_000)
      ]);
      const textAt = index => pages[index].status === 'fulfilled' ? plainText(pages[index].value) : '';
      const events = [
        { key:'fomc', name:'FOMC 利率决议', source:'Federal Reserve', ...nearestDate(textAt(0), { range:true }) },
        { key:'cpi', name:'美国 CPI', source:'U.S. Bureau of Labor Statistics', ...nearestDate(textAt(1)) },
        { key:'payrolls', name:'美国非农就业', source:'U.S. Bureau of Labor Statistics', ...nearestDate(textAt(2)) }
      ].filter(event => Number.isFinite(event.at));
      if (!events.length) throw new Error('no upcoming public macro events found');
      const result = { events:events.sort((a,b) => a.at - b.at), fetchedAt:now, cached:false, cacheAgeMs:0, refreshMs:FED_CALENDAR_TTL, unavailable:pages.map((page,index) => page.status === 'rejected' ? ['Federal Reserve','BLS CPI','BLS Employment'][index] : null).filter(Boolean), sources:['https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm','https://www.bls.gov/schedule/news_release/cpi.htm','https://www.bls.gov/schedule/news_release/empsit.htm'] };
      persistFedCalendarSnapshots(result.events, now);
      remember(key, result); return result;
    });
  } catch (error) {
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
    const [gold,dxy,coingecko,coinlore] = await Promise.allSettled([
      yahooHistory('GC=F'),
      yahooHistory('DX-Y.NYB'),
      request('https://api.coingecko.com/api/v3/global', 8_000),
      request('https://api.coinlore.net/api/global/', 8_000)
    ]);
    const market=[];
    market.push(gold.status==='fulfilled' ? dailySignal('gold','黄金指数',gold.value.quote,'Yahoo Finance') : { key:'gold', name:'黄金指数', available:false, source:'Yahoo Finance', detail:'公开行情暂不可用' });
    market.push(dxy.status==='fulfilled' ? dailySignal('dxy','美元指数',dxy.value.quote,'Yahoo Finance') : { key:'dxy', name:'美元指数', available:false, source:'Yahoo Finance', detail:'公开行情暂不可用' });
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
async function fedMonitor() {
  const calendar=await fedCalendar();
  let signals;
  try { signals=await fedMarketSignals(); }
  catch { signals={ market:[], fetchedAt:Date.now(), refreshMs:FED_MARKET_SIGNALS_TTL }; }
  return { ...calendar, marketSignals:signals.market, marketSignalsFetchedAt:signals.fetchedAt, marketSignalsRefreshMs:signals.refreshMs };
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
async function researchOutlook({ refresh = false } = {}) {
  const key='research-outlook', hit=cache.get(key), now=Date.now();
  if (!refresh && hit && now-hit.time<NEWS_TTL) return { ...cacheResult(hit, now), stale:false };
  return coalesce(key, async () => {
    const [intraday,daily,news,sentiment,derivatives,calendar]=await Promise.all([forecastHistory('15m'),forecastHistory('1d'),bitcoinNews({ refresh }),fearGreedSentiment({ refresh }).catch(()=>null),marketContext('okx').catch(()=>null),fedCalendar().catch(()=>null)]);
    const newsItems=news.items || [], bullish=newsItems.filter(item=>item.sentiment>0).length, bearish=newsItems.filter(item=>item.sentiment<0).length;
    const newsScore=newsItems.length ? clamp(newsItems.reduce((sum,item)=>{const ageHours=Number.isFinite(item.publishedAt)?Math.max(0,(now-item.publishedAt)/3_600_000):6, timeWeight=Math.exp(-ageHours/4);return sum+item.sentiment*(item.sourceWeight||.7)*(item.eventWeight||.7)*timeWeight},0)/Math.max(1,newsItems.reduce((sum,item)=>sum+(item.sourceWeight||.7),0)),-1,1) : 0;
    const sentimentScore=Number.isFinite(sentiment?.value) ? clamp((sentiment.value-50)/50,-1,1) : 0;
    const microstructureScore=derivatives ? clamp((Number(derivatives.orderBook?.imbalancePct)||0)/30*.32 + (Number(derivatives.takerFlow?.imbalancePct)||0)/35*.38 + (Number(derivatives.oiChangePct)||0)/.8*(Number(derivatives.priceChangePct)||0>=0?1:-1)*.18 - (Number(derivatives.fundingRate)||0)/.001*.08 - (Number(derivatives.basisPct)||0)/.25*.04,-1,1) : 0;
    const eventRisk=(calendar?.events||[]).filter(event=>event.at-now>=0&&event.at-now<=24*3_600_000).map(event=>event.name), eventRangeMultiplier=eventRisk.length?1.35:1;
    const last=intraday.candles.at(-1)?.close || daily.candles.at(-1)?.close;
    const definitions=[{ key:'1h', label:'约 1 小时', candles:intraday.candles, horizon:4, cap:.03 },{ key:'4h', label:'约 4 小时', candles:intraday.candles, horizon:16, cap:.05 },{ key:'1d', label:'约 1 天', candles:daily.candles, horizon:1, cap:.12 }];
    const windows=definitions.map(definition => {
      const history=historicalProjection(definition.candles,definition.horizon);
      const newsWeight=definition.key==='1d'?.25:.12, sentimentWeight=definition.key==='1d'?.08:.04, microWeight=definition.key==='1h'?.12:definition.key==='4h'?.09:.025;
      const adjustment=(newsScore*newsWeight + sentimentScore*sentimentWeight + microstructureScore*microWeight)*Math.max(history.volatility,.002);
      const adjustedReturn=clamp(history.expectedReturn + adjustment,-definition.cap,definition.cap), volatilityUnit=Math.max(history.volatility*Math.sqrt(definition.horizon),.001);
      const rawProbability=history.upProbability + newsScore*.06 + sentimentScore*.025 + microstructureScore*(definition.key==='1d'?.015:.045);
      const upProbability=clamp((rawProbability*Math.max(1,history.samples)+.5*24)/(Math.max(1,history.samples)+24),.05,.95);
      const direction=Math.abs(adjustedReturn)<volatilityUnit*.5?'flat':adjustedReturn>0?'up':'down';
      const distribution=Object.fromEntries(Object.entries(history.distribution).map(([key,value])=>[key,clamp(value+adjustment,-definition.cap,definition.cap)]));
      const center=distribution.p50, widened={p10:center+(distribution.p10-center)*eventRangeMultiplier,p50:center,p90:center+(distribution.p90-center)*eventRangeMultiplier};
      return { ...definition, upProbability, expectedReturn:adjustedReturn, expectedMove:last*adjustedReturn, expectedPrice:last*(1+adjustedReturn), direction, samples:history.samples, candidateCount:history.candidateCount, matchQuality:history.matchQuality, regime:history.regime, volatilityUnit, distribution, priceRange:{p10:last*(1+widened.p10),p50:last*(1+widened.p50),p90:last*(1+widened.p90)}, eventRangeMultiplier };
    });
    const primary=windows[1];
    const rankedNews=[...newsItems].map(item=>{const ageHours=Number.isFinite(item.publishedAt)?Math.max(0,(now-item.publishedAt)/3_600_000):6;return {...item,impact:Math.abs(item.sentiment)*(item.sourceWeight||.7)*(item.eventWeight||.7)*Math.exp(-ageHours/4)}}).sort((a,b)=>b.impact-a.impact || (b.publishedAt||0)-(a.publishedAt||0));
    const result={ price:last, windows, news:{ source:news.source, fetchedAt:news.fetchedAt, bullish, bearish, neutral:newsItems.length-bullish-bearish, score:newsScore, halfLifeHours:4, items:rankedNews.slice(0,6) }, sentiment:sentiment?{ value:sentiment.value, source:sentiment.source || 'Alternative.me' }:null, derivatives:derivatives?{ source:derivatives.source, score:microstructureScore, fundingRate:derivatives.fundingRate, oiChangePct:derivatives.oiChangePct, bookImbalancePct:derivatives.orderBook?.imbalancePct, takerImbalancePct:derivatives.takerFlow?.imbalancePct, cvdSessionNotional:derivatives.takerFlow?.cvdSessionNotional, coverage:['funding','oi-change','order-book','taker-flow','cvd','basis'], unavailable:['funding term structure / long-short ratio','options PCR / 25Δ skew / IV term structure','liquidation heatmap','spot ETF net flows','on-chain exchange / whale flows','Coinbase and Kimchi premiums'] }:null, eventRisk, historical:{ intradaySource:intraday.source, dailySource:daily.source, intradaySamples:intraday.candles.length, dailySamples:daily.candles.length }, primary, fetchedAt:now, refreshMs:NEWS_TTL, cached:false, disclaimer:'Historical-pattern and public-headline research only; not investment advice.' };
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
async function market(interval, limit, preferred) {
  const key = `${interval}:${limit}:${preferred || 'auto'}`; const hit = cache.get(key);
  if (hit && Date.now() - hit.time < MARKET_TTL) return { ...cacheResult(hit), stale:false };
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
      remember(key, result); persistMarket(result, interval); return result;
    } catch { throw Object.assign(new Error('All data sources failed'), { failures }); }
  }); } catch (error) {
    if (hit && Date.now() - hit.time <= STALE_QUOTE_MAX_AGE) return { ...cacheResult(hit), stale:true, fallbackReason:error.message };
    throw error;
  }
}
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon' };
http.createServer((req, res) => requestTiming.run({ started:performance.now(), upstreamStarted:null, upstreamEnded:null, upstreamCalls:0 }, async () => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/api/market') {
    const interval = url.searchParams.get('interval') || '4h';
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 180), 30), 300);
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
  const relative = url.pathname === '/' ? 'index.html' : normalize(url.pathname).replace(/^[/\\]+/, '');
  if (relative.includes('..')) { res.writeHead(403); res.end(); return; }
  try { const file = join(PUBLIC, relative); const body = await readFile(file); res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream' }); res.end(body); }
  catch { res.writeHead(404); res.end('Not found'); }
})).listen(PORT, HOST, () => console.log(`BTC indicator: http://${HOST}:${PORT}`));
