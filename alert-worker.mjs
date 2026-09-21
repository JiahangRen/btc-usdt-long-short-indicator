import { createAlertStore } from './alert-store.mjs';
// 多渠道发送与文案统一在 notification.mjs（v2.10.52 拆分）。
import { buildAlertMessage } from './notification.mjs';
// 告警穿越判定抽到共享模块（见 docs/CODE_AUDIT_REPORT.md F6），与 server 共用单一事实来源。
import { evaluateAlertRule } from './shared/alert-rule-eval.mjs';

const store = await createAlertStore();
if (!store.enabled) throw new Error(`Server-side alert worker is disabled: ${store.reason}`);

let previousPrice = null;
// 穿越判定语义原样保留在共享模块（cross 用途），见 shared/alert-rule-eval.mjs。
const crossed = (rule, from, to) => evaluateAlertRule(rule, from, to, 'cross');
const phrase = (kind, price) => ({ price_reached:`BTC价格达到 ${price}`,price_above:`BTC价格上涨至 ${price}`,price_below:`BTC价格下跌至 ${price}`,long_liquidation:`接近多头爆仓价 ${price}`,short_liquidation:`接近空头爆仓价 ${price}` }[kind] || `BTC价格 ${price}`);
const category = kind => kind === 'long_liquidation' || kind === 'short_liquidation' ? '爆仓' : '价格';

// ---- 云端规则投递：逐渠道发送，任一成功即算送达 --------------------------
async function deliver(job) {
  const target = Number(job.rule.targetPrice).toLocaleString('en-US',{maximumFractionDigits:2});
  const current = Number(job.price).toLocaleString('en-US',{maximumFractionDigits:2});
  const message = buildAlertMessage({ categoryLabel: category(job.rule.kind), phrase: phrase(job.rule.kind, target), target, current });
  const { ok, results, error } = await store.dispatchToChannels(job.rule.userId, message);
  await store.finishPush(job.deliveryId, { ok, payload: { channels: results }, error: ok ? '' : (error || '所有渠道投递失败') });
  if (!ok) console.error(`Alert delivery to all channels failed for user ${job.rule.userId}: ${error || 'unknown'}`);
}
async function consumePushes() {
  for (;;) {
    const job = await store.nextPush(); if (!job) continue;
    try { await deliver(job); }
    catch (error) { await store.finishPush(job.deliveryId, { ok:false, payload:{}, error:error.message }).catch(()=>{}); }
  }
}

// ---- 亏损联动推送：与持仓档案（personalEntries）联动，按保证金收益率 ROE 触发 ----
// 冷却状态保存在 worker 内存（进程重启即清零，投递记录仍可在 alert_deliveries 追溯）。
const lossCooldowns = new Map();
let lastLossScanAt = 0;
async function scanLossWatch(price) {
  const watchList = await store.lossWatchList();
  const now = Date.now();
  for (const account of watchList) {
    const { lossPush } = account.settings || {};
    const cooldownMs = Math.max(1, Number(lossPush?.cooldownMinutes) || 30) * 60_000;
    const current = Number(price).toLocaleString('en-US', { maximumFractionDigits: 2 });
    for (let index = 0; index < account.entries.length; index++) {
      const entry = account.entries[index];
      const entryPrice = Number(entry.price);
      if (!(entryPrice > 0)) continue;
      // ROE = 价格变动% × 杠杆（未填杠杆按 1 倍，即价格变动本身）。
      const movePct = entry.side === 'short' ? (entryPrice - Number(price)) / entryPrice * 100 : (Number(price) - entryPrice) / entryPrice * 100;
      const roe = movePct * (Number(entry.leverage) || 1);
      const level = roe <= -Number(lossPush?.lossRoe) ? 'loss' : roe <= -Number(lossPush?.warnRoe) ? 'warn' : null;
      if (!level) continue;
      const cooldownKey = `${account.userId}:${index}:${level}`;
      const lastAt = lossCooldowns.get(cooldownKey) || 0;
      if (now - lastAt < cooldownMs) continue;
      lossCooldowns.set(cooldownKey, now);
      const label = level === 'loss' ? '亏损推送' : '亏损警告';
      const message = {
        title: `【${label}】持仓 ROE ${roe.toFixed(1)}%`,
        short: `${label} ROE ${roe.toFixed(1)}%`,
        body: `${label === 'loss' ? '已达到亏损推送阈值' : '已接近亏损警告值'}。\n\n持仓方向 ${entry.side === 'short' ? '做空' : '做多'}\n开仓价 ${entryPrice.toLocaleString('en-US',{maximumFractionDigits:2})} USDT\n当前市价 ${current} USDT\n保证金收益率 ROE ${roe.toFixed(1)}%（${Number(entry.leverage) || 1}x 杠杆）\n触发时间 ${new Date().toLocaleString('zh-CN',{hour12:false})}`,
      };
      const { results } = await store.dispatchToChannels(account.userId, message);
      await store.recordDelivery(account.userId, `${label}（持仓 #${index + 1}）`, results);
    }
  }
}
async function evaluate(price) {
  if (!Number.isFinite(price)) return;
  if (previousPrice === null) { previousPrice = price; return; }
  const rules = await store.activeRules();
  for (const rule of rules) {
    if (!crossed(rule, previousPrice, price)) continue;
    const claimed = await store.claim(rule, price);
    if (claimed) await store.enqueue({ ...rule, ...claimed }, price);
  }
  previousPrice = price;
  // 亏损联动低频扫描（15 秒一次），不阻塞逐笔规则判定。
  if (Date.now() - lastLossScanAt >= 15_000) {
    lastLossScanAt = Date.now();
    scanLossWatch(price).catch(error => console.error('Loss watch scan failed:', error.message));
  }
}
function startOkxStream() {
  const connect = () => {
    const socket = new WebSocket('wss://ws.okx.com:8443/ws/v5/public');
    socket.addEventListener('open',()=>socket.send(JSON.stringify({op:'subscribe',args:[{channel:'tickers',instId:'BTC-USDT-SWAP'}]})));
    socket.addEventListener('message',event=>{try { const row=JSON.parse(event.data).data?.[0], price=Number(row?.last); evaluate(price).catch(error=>console.error('Alert rule evaluation failed:',error.message)); } catch {} });
    socket.addEventListener('close',()=>setTimeout(connect,2_000)); socket.addEventListener('error',()=>socket.close());
  };
  connect();
}
process.on('SIGTERM',async()=>{await store.close();process.exit(0)});
startOkxStream(); consumePushes().catch(error=>{console.error(error);process.exit(1)});
console.log('Server-side BTC alert worker started (multi-channel push)');
