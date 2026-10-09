import { createAlertStore } from './alert-store.mjs';
// 多渠道发送与文案统一在 notification.mjs（v2.10.52 拆分）。
import { buildAlertMessage, SITE_LINK } from './notification.mjs';
// 告警穿越判定抽到共享模块（见 docs/CODE_AUDIT_REPORT.md F6），与 server 共用单一事实来源。
import { evaluateAlertRule } from './shared/alert-rule-eval.mjs';
import { COIN_KEYS, okxInstId } from './shared/coins.mjs'; // 多币种行情订阅（v2.12.75）

const store = await createAlertStore();
if (!store.enabled) throw new Error(`Server-side alert worker is disabled: ${store.reason}`);

const previousByCoin = new Map(); // v2.12.75：按币种分别记录上一笔价格
// 穿越判定语义原样保留在共享模块（cross 用途），见 shared/alert-rule-eval.mjs。
const crossed = (rule, from, to) => evaluateAlertRule(rule, from, to, 'cross');
// v2.12.63：文案与前端 buildMessage 对齐（逼近多头/空头爆仓价、涨破/跌破），并显式给出方向用于精准着色。
const phrase = (kind, price, coin = 'BTC') => ({ price_reached:`${coin}/USDT 到达 ${price}`,price_above:`${coin}/USDT 涨破 ${price}`,price_below:`${coin}/USDT 跌破 ${price}`,long_liquidation:`逼近多头爆仓价 ${price}`,short_liquidation:`逼近空头爆仓价 ${price}` }[kind] || `${coin}/USDT 价格 ${price}`);
const category = kind => kind === 'long_liquidation' || kind === 'short_liquidation' ? '爆仓' : kind === 'price_above' ? '上涨' : kind === 'price_below' ? '下跌' : '价格';
// 红跌绿涨方向：多头爆仓=价跌(红)/空头爆仓=价涨(绿)；上涨绿、下跌红。
const directionOf = kind => kind === 'long_liquidation' ? 'down' : kind === 'short_liquidation' ? 'up' : kind === 'price_above' ? 'up' : kind === 'price_below' ? 'down' : 'none';

// ---- 云端规则投递：逐渠道发送，任一成功即算送达 --------------------------
async function deliver(job) {
  const target = Number(job.rule.targetPrice).toLocaleString('en-US',{maximumFractionDigits:2});
  const current = Number(job.price).toLocaleString('en-US',{maximumFractionDigits:2});
  const message = buildAlertMessage({ categoryLabel: category(job.rule.kind), phrase: phrase(job.rule.kind, target, job.rule.coin || 'BTC'), target, current, direction: directionOf(job.rule.kind), coin: job.rule.coin || 'BTC' });
  const { ok, results, error } = await store.dispatchToChannels(job.rule.userId, message);
  await store.finishPush(job.deliveryId, { ok, payload: { channels: results, message }, error: ok ? '' : (error || '所有渠道投递失败') });
  if (!ok) console.error(`Alert delivery to all channels failed for user ${job.rule.userId}: ${error || 'unknown'}`);
}
async function consumePushes() {
  for (;;) {
    const job = await store.nextPush(); if (!job) continue;
    try { await deliver(job); }
    catch (error) { await store.finishPush(job.deliveryId, { ok:false, payload:{}, error:error.message }).catch(()=>{}); }
  }
}

// ---- 亏损联动推送：与持仓档案（personalEntries）联动，按三维度阈值触发 ----
// 维度：亏损百分比、亏损额、距离强平价百分比；任一维度达到推送/警告线即触发。
// 冷却状态保存在 worker 内存（进程重启即清零，投递记录仍可在 alert_deliveries 追溯）。
const lossCooldowns = new Map();
let lastLossScanAt = 0;
function calcLiquidation(entry) {
  const price = Number(entry.price);
  const leverage = Number(entry.leverage) || (Number(entry.amount) > 0 && Number(entry.margin) > 0 ? Number(entry.amount) / Number(entry.margin) : null);
  if (!(price > 0) || !(leverage > 0)) return null;
  const mmr = 0.005;
  return entry.side === 'short'
    ? price * (1 + 1 / leverage - mmr)
    : price * (1 - 1 / leverage + mmr);
}
async function scanLossWatch(price) {
  const watchList = await store.lossWatchList();
  const now = Date.now();
  for (const account of watchList) {
    const { lossPush } = account.settings || {};
    const cooldownMs = Math.max(1, Number(lossPush?.cooldownMinutes) || 30) * 60_000;
    const current = Number(price);
    const currentFmt = current.toLocaleString('en-US', { maximumFractionDigits: 2 });
    // v2.12.67：单阈值（警告与推送同时）。亏损以金额(USDT)为基准作用于每个仓位；强平以距强平价%为基准。
    const lossThresholdAmount = Math.max(0.01, Number(lossPush?.lossThresholdAmount) || 500);
    const liqThresholdPct = Math.max(0.01, Number(lossPush?.liqDistancePct) || 10);
    for (let index = 0; index < account.entries.length; index++) {
      const entry = account.entries[index];
      const entryPrice = Number(entry.price);
      if (!(entryPrice > 0)) continue;
      const side = entry.side === 'short' ? 'short' : 'long';
      const amount = Number(entry.amount) || 0;
      const movePct = side === 'short' ? (entryPrice - current) / entryPrice * 100 : (current - entryPrice) / entryPrice * 100;
      const lossPct = Math.max(0, -movePct);
      const lossAmount = amount > 0 ? amount * (lossPct / 100) : 0;
      const liqPrice = calcLiquidation(entry);
      const liqDistancePct = liqPrice > 0 ? Math.abs(current - liqPrice) / liqPrice * 100 : null;
      // 单阈值命中：亏损额达到金额阈值，或距强平价进入阈值，即同时「页面警示 + 外推」。
      const hit = lossAmount >= lossThresholdAmount || (liqDistancePct !== null && liqDistancePct <= liqThresholdPct);
      if (!hit) continue;
      const cooldownKey = `${account.userId}:${index}`;
      const lastAt = lossCooldowns.get(cooldownKey) || 0;
      if (now - lastAt < cooldownMs) continue;
      lossCooldowns.set(cooldownKey, now);
      const label = '亏损预警';
      const lines = [
        `已达到亏损预警阈值，将同时推送并页面警示。`,
        '',
        `持仓方向 ${side === 'short' ? '做空' : '做多'}`,
        `开仓价 ${entryPrice.toLocaleString('en-US', { maximumFractionDigits: 2 })} USDT`,
        `当前市价 ${currentFmt} USDT`,
        `亏损百分比 ${lossPct.toFixed(2)}%`,
        amount > 0 ? `亏损额约 ${lossAmount.toLocaleString('en-US', { maximumFractionDigits: 2 })} USDT（阈值 ${lossThresholdAmount.toLocaleString('en-US', { maximumFractionDigits: 2 })} USDT）` : null,
        liqPrice > 0 ? `理论强平价 ${liqPrice.toLocaleString('en-US', { maximumFractionDigits: 2 })} USDT（距 ${liqDistancePct.toFixed(2)}%，阈值 ${liqThresholdPct.toFixed(2)}%）` : null,
        `触发时间 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
        '',
        SITE_LINK,
      ].filter(Boolean);
      const message = {
        title: `【${label}】🔴 ${side === 'short' ? '做空' : '做多'} 仓位#${index + 1} 触及阈值`,
        short: `${label} ${side === 'short' ? '做空' : '做多'} #${index + 1}`,
        body: lines.join('\n'),
      };
      const { results } = await store.dispatchToChannels(account.userId, message);
      await store.recordDelivery(account.userId, `${label}（持仓 #${index + 1}）`, results, message);
    }
  }
}
async function evaluate(coin, price) {
  if (!Number.isFinite(price)) return;
  const prev = previousByCoin.get(coin);
  if (prev === undefined) { previousByCoin.set(coin, price); return; }
  const rules = await store.activeRules(coin);
  for (const rule of rules) {
    if (!crossed(rule, prev, price)) continue;
    const claimed = await store.claim(rule, price);
    if (claimed) await store.enqueue({ ...rule, ...claimed }, price);
  }
  previousByCoin.set(coin, price);
  // 亏损联动低频扫描（15 秒一次）仅 BTC 持仓触发，不阻塞逐笔规则判定。
  if (coin === 'BTC' && Date.now() - lastLossScanAt >= 15_000) {
    lastLossScanAt = Date.now();
    scanLossWatch(price).catch(error => console.error('Loss watch scan failed:', error.message));
  }
}
const instIdToCoin = new Map(COIN_KEYS.map(c => [okxInstId(c), c]));
function startOkxStream() {
  const connect = () => {
    const socket = new WebSocket('wss://ws.okx.com:8443/ws/v5/public');
    const args = COIN_KEYS.map(c => ({ channel:'tickers', instId: okxInstId(c) }));
    socket.addEventListener('open',()=>socket.send(JSON.stringify({op:'subscribe',args})));
    socket.addEventListener('message',event=>{try { const row=JSON.parse(event.data).data?.[0]; const coin=instIdToCoin.get(row?.instId); if(!coin)return; const price=Number(row?.last); evaluate(coin, price).catch(error=>console.error(`Alert rule evaluation failed for ${coin}:`,error.message)); } catch {} });
    socket.addEventListener('close',()=>setTimeout(connect,2_000)); socket.addEventListener('error',()=>console.error('OKX ticker stream error (reconnect on close)'));
  };
  connect();
}
process.on('SIGTERM',async()=>{await store.close();process.exit(0)});
startOkxStream(); consumePushes().catch(error=>{console.error(error);process.exit(1)});
console.log('Server-side multi-coin alert worker started (multi-channel push)');
