import { createAlertStore } from './alert-store.mjs';

const store = await createAlertStore();
if (!store.enabled) throw new Error(`Server-side alert worker is disabled: ${store.reason}`);

let previousPrice = null;
const crossed = (rule, from, to) => {
  if (rule.kind === 'price_reached') return (from - rule.targetPrice) * (to - rule.targetPrice) <= 0 && from !== to;
  const up = rule.kind === 'price_above' || rule.kind === 'short_liquidation';
  return up ? from < rule.targetPrice && to >= rule.targetPrice : from > rule.targetPrice && to <= rule.targetPrice;
};
const phrase = (kind, price) => ({ price_reached:`BTC价格达到 ${price}`,price_above:`BTC价格上涨至 ${price}`,price_below:`BTC价格下跌至 ${price}`,long_liquidation:`接近多头爆仓价 ${price}`,short_liquidation:`接近空头爆仓价 ${price}` }[kind] || `BTC价格 ${price}`);
const title = (kind, price) => kind === 'long_liquidation' || kind === 'short_liquidation' ? `【爆仓】${phrase(kind,price)}` : `【价格】${phrase(kind,price)}`;
const short = (kind, price) => kind === 'long_liquidation' ? `多头爆仓价 ${price} USDT` : kind === 'short_liquidation' ? `空头爆仓价 ${price} USDT` : `BTC ${price} USDT`;

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
}
async function consumePushes() {
  for (;;) {
    const job = await store.nextPush(); if (!job) continue;
    const target = Number(job.rule.targetPrice).toLocaleString('en-US',{maximumFractionDigits:2});
    const current = Number(job.price).toLocaleString('en-US',{maximumFractionDigits:2});
    try {
      const response = await fetch(`https://sctapi.ftqq.com/${encodeURIComponent(job.sendKey)}.send`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({title:title(job.rule.kind,target),short:short(job.rule.kind,target),desp:`${title(job.rule.kind,target)}\n\n${phrase(job.rule.kind,target)} USDT\n触发时市价 ${current} USDT`})});
      const payload = await response.json().catch(()=>({}));
      await store.finishPush(job.deliveryId,{ok:response.ok && Number(payload.code)===0,payload,error:response.ok?'':'Server酱请求失败'});
    } catch (error) { await store.finishPush(job.deliveryId,{ok:false,payload:{},error:error.message}); }
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
console.log('Server-side BTC alert worker started');
