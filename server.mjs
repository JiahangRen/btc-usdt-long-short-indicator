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
const MARKET_REQUEST_TIMEOUT = 2_200;
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
    if (total > 0) { okxStream.orderBook = { bidDepth, askDepth, ratio:askDepth ? bidDepth / askDepth : null, imbalancePct:(bidDepth - askDepth) / total * 100, ofiPct }; okxStream.bookAt = now; }
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
// BLS publishes a canonical ICS calendar; parse its Employment Situation event instead of guessing from page prose.
// BLS 提供权威 ICS 日历；非农直接解析 Employment Situation 事件，不再从网页正文猜测日期。
function nearestIcsEvent(text, summaryPattern) { const now=Date.now(), candidates=[];for(const block of String(text).split(/BEGIN:VEVENT/i).slice(1)){const summary=(block.match(/SUMMARY:(.+)/i)||[])[1]||'',date=(block.match(/DTSTART(?:;[^:]*)?:(\d{8})(?:T(\d{2})(\d{2}))?/i)||[]);if(!summaryPattern.test(summary)||!date[1])continue;const year=Number(date[1].slice(0,4)),month=Number(date[1].slice(4,6))-1,day=Number(date[1].slice(6,8)),hour=Number(date[2]||17),minute=Number(date[3]||0),at=Date.UTC(year,month,day,hour,minute);if(at>=now-86_400_000&&at<now+400*86_400_000)candidates.push({at,label:`${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`})}candidates.sort((a,b)=>a.at-b.at);return candidates[0]||null }
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
      const events = [
        { key:'fomc', name:'FOMC 利率决议', source:'Federal Reserve', ...nearestDate(textAt(0), { range:true }) },
        // CPI 与非农都优先解析 BLS 统一 ICS 日历，网页明细仅作为兼容回退。
        // Parse both CPI and payrolls from BLS's canonical ICS calendar first; use detail pages only as compatibility fallbacks.
        { key:'cpi', name:'美国 CPI', source:'U.S. Bureau of Labor Statistics', ...(nearestIcsEvent(rawAt(3),/Consumer Price Index/i) || nearestDate(textAt(1)) || cpiCadenceFallback(now)) },
        { key:'payrolls', name:'美国非农就业', source:'U.S. Bureau of Labor Statistics', ...(nearestIcsEvent(rawAt(3),/Employment Situation/i) || nearestDate(textAt(2)) || payrollCadenceFallback(now)) }
      ].filter(event => Number.isFinite(event.at));
      if (!events.length) throw new Error('no upcoming public macro events found');
      const result = { events:events.sort((a,b) => a.at - b.at), fetchedAt:now, cached:false, cacheAgeMs:0, refreshMs:FED_CALENDAR_TTL, unavailable:pages.map((page,index) => page.status === 'rejected' ? ['Federal Reserve','BLS CPI','BLS Employment','BLS calendar'][index] : null).filter(Boolean), sources:['https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm','https://www.bls.gov/schedule/news_release/cpi.htm','https://www.bls.gov/schedule/news_release/empsit.htm','https://www.bls.gov/schedule/news_release/bls.ics'] };
      persistFedCalendarSnapshots(result.events, now);
      remember('fed-calendar', result); return result;
  });
}
async function fedCalendar() {
  const key = 'fed-calendar', hit = cache.get(key), now = Date.now();
  if (hit && now - hit.time < FED_CALENDAR_TTL) return { ...cacheResult(hit, now), stale:false };
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
  if(series.length<201)return;const closed=series.slice(0,-1), entry=closed.at(-1);if(!entry)return;const values=calculator(closed,horizon), bucketAt=Number(entry.time), unit=interval==='1m'?60_000:interval==='5m'?300_000:interval==='1h'?3_600_000:900_000, targetAt=bucketAt+horizon*unit;
  safelyStore(()=>storeAbShadowPair.run(experimentKey,bucketAt,source,interval,`${interval}:${horizon}`,targetAt,Number(entry.close),values.regime,values.a,abDirection(values.a),values.b,abDirection(values.b,.055),JSON.stringify(values.meta||{}),now));
}
function recordAbExternalPair(experimentKey, source, series, horizon, probabilities, metadata, now=Date.now()) {
  const closed=series.slice(0,-1), entry=closed.at(-1);if(!entry||!Number.isFinite(probabilities?.a)||!Number.isFinite(probabilities?.b))return;const bucketAt=Number(entry.time), targetAt=bucketAt+horizon*900_000;
  safelyStore(()=>storeAbShadowPair.run(experimentKey,bucketAt,source,'15m',`15m:${horizon}`,targetAt,Number(entry.close),abRegime(closed),clamp(probabilities.a,.08,.92),abDirection(probabilities.a),clamp(probabilities.b,.08,.92),abDirection(probabilities.b,.055),JSON.stringify(metadata||{}),now));
}
function captureAbExperiments(source, interval, candles, now=Date.now()) {
  if(interval==='15m') { for(const horizon of [4,16,96])recordAbPair('rule-signal',source,interval,candles,horizon,abRuleProbabilities,now);for(const horizon of [1,4,16])recordAbPair('multi-period-probability',source,interval,candles,horizon,abProbabilityPair,now);for(const horizon of [4,16])recordAbPair('multi-period-resonance',source,interval,candles,horizon,abResonancePair,now);for(const horizon of [4,16])recordAbPair('pattern-key-levels',source,interval,candles,horizon,abPatternPair,now); }
  if(interval==='1m') for(const horizon of [1,5])recordAbPair('short-horizon-heuristic',source,interval,candles,horizon,abProbabilityPair,now);
}
function settleAbExperiments(histories, now=Date.now()) { for(const row of pendingAbShadowPairs.all(now)){const candles=histories[row.candle_interval]||[],target=candles.find(candle=>Number(candle.time)>=Number(row.target_at));if(!target)continue;const settled=Number(target.close), entry=Number(row.entry_price);if(!Number.isFinite(settled)||!entry)continue;const actualReturn=settled/entry-1;settleAbShadowPair.run(now,settled,actualReturn,actualReturn>0?1:0,row.id); } }
function abComparison(experimentKey, minSamples=30) {
  const rows=database.prepare('SELECT horizon_key AS horizonKey, regime, a_probability AS aProbability, b_probability AS bProbability, actual_return AS actualReturn, is_up AS isUp FROM ab_shadow_pairs WHERE experiment_key=? AND settled_at IS NOT NULL ORDER BY target_at ASC').all(experimentKey).map(row=>({...row,aProbability:Number(row.aProbability),bProbability:Number(row.bProbability),actualReturn:Number(row.actualReturn),isUp:Number(row.isUp)}));
  const horizons=[...new Set(rows.map(row=>row.horizonKey))];const perHorizon=Object.fromEntries(horizons.map(key=>{const subset=rows.filter(row=>row.horizonKey===key);return [key,{samples:subset.length,baseline:pairedPredictionMetrics(subset,'aProbability'),candidate:pairedPredictionMetrics(subset,'bProbability')}]}));const overall={samples:rows.length,baseline:pairedPredictionMetrics(rows,'aProbability'),candidate:pairedPredictionMetrics(rows,'bProbability')};const enough=horizons.length>0&&horizons.every(key=>perHorizon[key].samples>=minSamples), base=overall.baseline,candidate=overall.candidate, better=base&&candidate&&candidate.brier<=base.brier*.97&&candidate.logLoss<=base.logLoss*.97&&candidate.ece<=base.ece*1.05&&candidate.economic.netReturn>=base.economic.netReturn;const verdict=!enough?{tone:'yellow',label:'继续观察',reason:`每个周期需 ${minSamples} 个同桶已结算样本。`}:better?{tone:'green',label:'建议人工复核',reason:'候选在已配对样本中同时满足概率质量、校准与成本后表现门槛；不会自动切换。'}:{tone:'red',label:'不建议升级',reason:'样本足够，但候选没有同时达到预设门槛。'};return {experimentKey,paired:rows.length,minSamples,perHorizon,overall,verdict};
}
const abExperimentCatalog=[
  {key:'rule-signal',name:'当前规则信号',kind:'prediction',candidate:'去重趋势计票 + 波动状态 + 滞回确认 + 成交量确认',minSamples:30,status:'active'},
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
  const ece=bins.reduce((sum,bin)=>sum+(bin.length?Math.abs(mean(bin.map(item=>item.probability))-mean(bin.map(item=>item.label)))*bin.length/rows.length:0),0), signals=rows.filter(row=>Math.abs(Number(row[probabilityKey])-.5)>=.06), returns=signals.map(row=>Number(row.actualReturn)*(Number(row[probabilityKey])>=.5?1:-1)-.0008);let equity=1,peak=1,maxDrawdown=0;for(const value of returns){equity*=1+value;peak=Math.max(peak,equity);maxDrawdown=Math.min(maxDrawdown,equity/peak-1)}const average=mean(returns), deviation=Math.sqrt(mean(returns.map(value=>(value-average)**2)))||0;
  return { samples:rows.length, accuracy, brier, logLoss, brierSkill:baselineBrier?1-brier/baselineBrier:null, ece, economic:{ trades:signals.length, netReturn:equity-1, maxDrawdown, sharpe:deviation?average/deviation*Math.sqrt(returns.length):null } };
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
      remember(key, result); persistMarket(result, interval); captureAbExperiments(source, interval, candles, result.fetchedAt); settleAbExperiments({[interval]:candles},result.fetchedAt); return result;
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
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon' };
http.createServer((req, res) => requestTiming.run({ started:performance.now(), upstreamStarted:null, upstreamEnded:null, upstreamCalls:0 }, async () => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/api/market') {
    const interval = url.searchParams.get('interval') || '4h';
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 180), 30), 500);
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
  const relative = url.pathname === '/' ? 'index.html' : normalize(url.pathname).replace(/^[/\\]+/, '');
  if (relative.includes('..')) { res.writeHead(403); res.end(); return; }
  try { const file = join(PUBLIC, relative); const body = await readFile(file); res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream' }); res.end(body); }
  catch { res.writeHead(404); res.end('Not found'); }
})).listen(PORT, HOST, () => console.log(`BTC indicator: http://${HOST}:${PORT}`));
