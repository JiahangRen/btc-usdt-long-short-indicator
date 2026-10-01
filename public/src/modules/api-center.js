/* ═══════════════════════════════════════════════════════════════════════════
 * src/modules/api-center.js —— API 接入中心模态 / API Center module
 * ───────────────────────────────────────────────────────────────────────────
 * 职责：管理「数据源 API 接入」模态框（apiCenterModal）及其渲染、校验、保存。
 *   · 自建 modal（document.body.append），由顶栏齿轮面板里的 #apiCenterToggle 触发；
 *   · 渲染已接入凭据、校验状态、CoinGecko 用量、千问 mini 额度卡；
 *   · 各提供商的增删改走 /api/api-center，凭据经 window.btcSecureVault 服务端加密保存。
 *
 * 依赖：tx / uiLang / $ 来自 ../core.js；showAppDialog、btcSecureVault 走 window；
 *   fetch 为浏览器全局。本模块**不触碰**图表共享状态（metrics/classification/state），
 *   也不改写 app.js 的 applyLanguage 绑定（模态仅在打开时整卡重渲，语言切换不装饰）。
 *
 * 导出：initApiCenter() —— 在顶栏初始化函数内、#apiCenterToggle 已入 DOM 后调用一次。
 * ═══════════════════════════════════════════════════════════════════════════ */

import { tx, uiLang, $, calendarEscape } from '../core.js?v=20260928a';

export function initApiCenter() {
  const apiCenterModal=document.createElement("div");
  apiCenterModal.id="apiCenterModal";
  apiCenterModal.className="alert-composer api-center-modal";
  apiCenterModal.hidden=true;
  document.body.append(apiCenterModal);
  const apiCenterRequest=async(path, options={})=>{const response=await fetch(path,{...options,headers:{'content-type':'application/json',...(options.headers||{})}}),body=await response.json().catch(()=>({}));if(!response.ok)throw new Error(body.error||"请求失败");return body;};
  const apiCenterFree=()=>uiLang==='zh'?[['市场行情','OKX · Binance','无需填入'],['宏观日程','美联储 · BLS 日程 · 美国财政部 · EIA 发布时间 · CFTC','无需填入'],['加密与链上','mempool.space · Deribit 公共行情 · CoinLore · Alternative.me','无需填入'],['市场环境','Yahoo Finance（公开入口）','无需填入']]:[['Market quotes','OKX · Binance','No entry needed'],['Macro calendar','Federal Reserve · BLS schedule · US Treasury · EIA releases · CFTC','No entry needed'],['Crypto & on-chain','mempool.space · Deribit public quotes · CoinLore · Alternative.me','No entry needed'],['Market environment','Yahoo Finance (public)','No entry needed']];
  const apiCenterOptional=()=>uiLang==='zh'?[['coingecko','CoinGecko','加密市场总市值、BTC 占比','可以填入高级或升级版的 API key，如果不填，就默认使用已接入的免费版'],['eia','EIA','原油库存的完整实际值与历史数据','可填写免费 EIA API key；不填仍默认使用已接入的 EIA 发布时间日历'],['custom','自定义 HTTPS API','手动订阅的数据源地址与可选 API Key','仅接受 HTTPS 地址；地址和 Key 均以相同的服务端加密逻辑保存，不会回显']]:[['coingecko','CoinGecko','Crypto market cap, BTC dominance','You can enter a premium or higher-tier API key; if left blank, the free version already connected is used'],['eia','EIA','Complete actual & historical crude inventory','Enter a free EIA API key; if blank, the connected EIA release calendar is used'],['custom','Custom HTTPS API','Manually subscribed data source URL and optional API key','Only HTTPS URLs accepted; both URL and key are saved with the same server-side encryption and never echoed back']];
  // 千问 mini 额度卡的渲染：复用 /api/ai/quota，单函数一处渲染全部字段。
  // Qwen mini quota renderer: reuses /api/ai/quota, a single function covers all fields.
  const renderApiQwenQuota=async(card)=>{
    if(!card)return;
    const fill=card.querySelector('.api-qwen-quota-fill');
    const pct=card.querySelector('.api-qwen-quota-pct');
    const meta=card.querySelector('.api-qwen-quota-meta');
    let payload=null;
    try { const res=await fetch('/api/ai/quota'); if(res.ok)payload=await res.json(); } catch {}
    if(!payload||!payload.configured){ card.setAttribute('data-empty','true'); pct.textContent='—'; fill.style.width='0%'; meta.textContent=tx('保存 Key 后再提问一次即可显示额度','Ask once after saving the key to see quota'); return; }
    const remote=payload.remote,local=payload.local||{};
    // 千问 API 不返回实时额度响应头，本地按模型换算表估算 credits 消耗。
    // Qwen API does not surface live quota headers; we estimate from the model conversion table.
    const estimateLimit=2500; // Token Plan Lite 默认值（按截图用户用的是 Lite 套餐）
    const estCredits=Number(local.estimatedCredits||0);
    const estPctRemaining=estCredits>0?Math.max(0,Math.min(100,(1-estCredits/estimateLimit)*100)):null;
    if(remote&&remote.limit!=null&&remote.remaining!=null){
      const remainingPct=Math.max(0,Math.min(100,remote.percentRemaining));
      const usedPct=100-remainingPct;
      fill.style.width=remainingPct+'%';
      fill.setAttribute('data-level',remainingPct>50?'ok':remainingPct>20?'mid':'low');
      card.setAttribute('data-empty','false');
      pct.textContent=remainingPct.toFixed(1)+'%';
      const usedNum=Number.isFinite(remote.used)?remote.used.toLocaleString():'—';
      const limitNum=Number.isFinite(remote.limit)?remote.limit.toLocaleString():'—';
      const cd=local.countdownMs?(()=>{const ms=local.countdownMs,totalMin=Math.floor(ms/60000),d=Math.floor(totalMin/1440),h=Math.floor((totalMin%1440)/60);return d>0?d+'d '+h+'h':h>0?h+'h':Math.max(1,totalMin)+'m';})():null;
      const resetAt=remote.resetAt?(new Date(remote.resetAt)).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):null;
      meta.innerHTML=`${tx('剩余','Remaining')} <b>${remote.remaining.toLocaleString()}</b> / ${limitNum}（${usedNum} ${tx('已用','used')} · ${usedPct.toFixed(1)}%）${resetAt?` · ${tx('重置','reset')} ${resetAt}`:''}${cd?` · ${cd} ${tx('后','later')}`:''} · ${tx('累计','cumulative')} ${local.calls||0} ${tx('次','times')} / ${(local.totalTokens||0).toLocaleString()} tokens`;
    } else if(local.calls){
      // 没有远程响应头，用本地估算显示。进度条按 Lite 套餐 2,500 credits 估算。
      // No remote headers: render the local estimate. The bar compares against the Lite plan's 2,500 credits.
      if(estPctRemaining!=null){
        fill.style.width=estPctRemaining+'%';
        fill.setAttribute('data-level',estPctRemaining>50?'ok':estPctRemaining>20?'mid':'low');
        pct.textContent=estPctRemaining.toFixed(1)+'%';
        card.setAttribute('data-empty','false');
      } else {
        fill.style.width='0%';
        fill.removeAttribute('data-level');
        pct.textContent='—';
        card.setAttribute('data-empty','true');
      }
      const cd=local.countdownMs?(()=>{const ms=local.countdownMs,totalMin=Math.floor(ms/60000),d=Math.floor(totalMin/1440),h=Math.floor((totalMin%1440)/60);return d>0?d+'d '+h+'h':h>0?h+'h':Math.max(1,totalMin)+'m';})():null;
      const resetTxt=local.periodEnd?(new Date(local.periodEnd)).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):null;
      meta.innerHTML=`${tx('估算已用','Est. used')} <b>${estCredits.toFixed(1)}</b> credits / ${estimateLimit}（${tx('本地估算','local estimate')} · Token Plan Lite ${tx('默认','default')}） · ${tx('累计','cumulative')} ${local.calls} ${tx('次','times')} / ${(local.totalTokens||0).toLocaleString()} tokens${resetTxt?` · ${tx('重置','reset')} ${resetTxt}`:''}${cd?`（${cd}）`:''} · <span style="color:#ffcb69">${tx('精确剩余请到 Token Plan 控制台查看','Check exact remaining in the Token Plan console')}</span>`;
    } else {
      card.setAttribute('data-empty','true');
      pct.textContent='—';
      fill.style.width='0%';
      meta.textContent=tx('尚未调用千问，额度无数据','Qwen not called yet; no quota data');
    }
  };
  const renderApiCenter=async()=>{
    let credentials={},verification={},coinGeckoUsage=null; try { const payload=await apiCenterRequest('/api/api-center'); credentials=payload.credentials||{}; verification=payload.verification||{}; coinGeckoUsage=payload.coinGeckoUsage||null; } catch {}
    window.dispatchEvent(new CustomEvent('btc:ai-credential-changed', { detail:{ available:Boolean(credentials.qwen && verification.qwen) } }));
    const free=apiCenterFree().map(([group,name,note])=>`<article class="api-center-row free"><div><b>${group}</b><span>${name}</span></div><em>${note}</em></article>`).join('');
    // 千问配置需要模型列表与当前选择，单独从 AI 配置接口取。
    // The Qwen card needs the model list and current choice, fetched from the AI config endpoint.
    let aiConfig={configured:false,model:'',models:[]}; try { aiConfig=await (await fetch('/api/ai/config')).json(); } catch {}
    // 模型下拉：只列可用于问答的文本模型，并标出额度档位（省 / 中 / 贵）。
    // Model picker: only chat-capable text models, tagged with their credit tier.
    const qwenTierTag={value:tx('省','Econ'),balanced:tx('中','Mid'),flagship:tx('贵','Premium')};
    const qwenModels=(aiConfig.models||[]).filter(entry=>entry.usable!==false).map(entry=>{const tag=qwenTierTag[entry.tier]||'';return `<option value="${calendarEscape(entry.id)}"${entry.id===aiConfig.model?' selected':''}>${calendarEscape(entry.label)}${tag?' · '+tag:''}${entry.recommended?tx('（推荐）',' (recommended)'):''}</option>`;}).join('');
    // 端点快捷选择：千问两套体系（按量付费 / Token Plan 订阅），端点与 Key 必须配套。
    // Endpoint picker: Qwen has two isolated systems and the endpoint must match the key.
    const qwenEndpoints=(aiConfig.endpoints||[]).map(entry=>`<option value="${calendarEscape(entry.baseUrl)}"${entry.baseUrl===aiConfig.baseUrl?' selected':''}>${calendarEscape(entry.label)}</option>`).join('');
    const qwenEndpointNote=aiConfig.baseUrl?`<p class="api-endpoint-note">${tx('当前端点：','Current endpoint: ')}<code>${calendarEscape(aiConfig.baseUrl)}</code> · ${tx('识别为','detected as ')}${aiConfig.keyKind==='token-plan'?tx('Token Plan 订阅 Key（sk-sp-）','Token Plan subscription key (sk-sp-)'):tx('按量付费 Key（sk-）','pay-as-you-go key (sk-)')}${aiConfig.mismatch?'<b class="api-endpoint-warn"> · ⚠️ ' + tx('与 Key 前缀不匹配，调用会返回 401','key prefix mismatch; calls return 401') + '</b>':''}${aiConfig.autoCorrected?'<b class="api-endpoint-warn"> · ' + tx('已自动纠正为匹配端点','auto-corrected to the matching endpoint') + '</b>':''}</p>`:'';
    // 千问额度小卡：进度条 + 剩余 % + 倒计时，与右下角 AI 助手面板同源。
    // Qwen quota mini card: bar + remaining % + countdown, mirrors the chat-panel source.
    const qwenQuotaMarkup=`<div class="api-qwen-quota" data-empty="true"><div class="api-qwen-quota-bar"><div class="api-qwen-quota-fill"></div></div><span class="api-qwen-quota-pct">—</span><span class="api-qwen-quota-meta">${tx('尚未调用千问，额度无数据','Qwen not called yet; no quota data')}</span></div>`;
    const qwen=`<article class="api-center-row api-center-qwen"><div><b>千问 Qwen<small>${tx('AI 行情助手','AI market assistant')}</small>${verification.qwen?'<span class="badge bull api-verified">' + tx('已验证','Verified') + '</span>':''}</b><span>${tx('为右下角 AI 助手提供行情解读与涨跌判断；默认 ','Provides market readouts and trend calls for the bottom-right AI assistant; default ')}<code>${calendarEscape(aiConfig.defaultModel||'qwen3.8-flash')}</code>${tx('，额度消耗约为旗舰的 1/15','; credit cost ≈ 1/15 of the flagship')}</span><div class="api-key-systems"><b>${tx('两种 Key 体系 · 端点必须配套，混用一律 401','Two key systems · endpoint must match, mismatched = 401')}</b><span><code>sk-</code> / <code>sk-ws-</code> ${tx('按量付费 → DashScope 端点','pay-as-you-go → DashScope endpoint')}</span><span><code>sk-sp-</code> ${tx('Token Plan 个人版订阅 → Token Plan 端点','Token Plan personal subscription → Token Plan endpoint')}</span><small>${tx('Token Plan 的 Key 在「我的订阅」页面生成，只完整显示一次；Key 仅以服务端加密方式保存，不会回显。','The Token Plan key is generated on the “My Subscriptions” page and shown in full only once; keys are saved server-side encrypted and never echoed back.')}</small></div>${qwenEndpointNote}${qwenQuotaMarkup}</div><form data-api-provider="qwen" autocomplete="off"><label class="api-qwen-key">${tx('千问 API Key','Qwen API Key')}<input name="key" type="password" autocomplete="new-password" placeholder="${credentials.qwen?tx('已保存，重新填写以更新','Saved — re-enter to update'):tx('sk-… / sk-sp-… 千问 API Key','sk-… / sk-sp-… Qwen API Key')}" data-1p-ignore="true" data-lpignore="true" ${credentials.qwen?'data-saved="true"':''}></label><label>${tx('模型','Model')}<select name="model">${qwenModels}</select></label><label>${tx('端点类型','Endpoint type')}<select name="endpoint" class="qwen-endpoint"><option value="">${tx('按 Key 前缀自动匹配（推荐）','Auto-match by key prefix (recommended)')}</option>${qwenEndpoints}</select></label><label>${tx('API 地址（可选，留空自动匹配；此处不填 Key）','API URL (optional, auto-matched if blank — not the key)')}<input name="url" type="text" inputmode="url" autocomplete="off" aria-label="Qwen compatible endpoint" placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"></label><div class="api-qwen-actions"><button>${credentials.qwen?tx('更新 Key','Update Key'):tx('保存 Key','Save Key')}</button><button type="button" class="api-verify-qwen">${tx('验证 Key','Verify Key')}</button>${credentials.qwen?'<button type="button" class="api-clear">' + tx('清除','Clear') + '</button>':''}</div></form></article>`;
    const coinGeckoUsageMarkup=(()=>{if(!credentials.coingecko)return '<div class="coingecko-usage muted">' + tx('保存 CoinGecko Demo Key 后显示月度额度统计。','Save a CoinGecko Demo Key to see monthly quota stats.') + '</div>';if(!coinGeckoUsage?.available)return `<div class="coingecko-usage error">${tx('额度暂不可用：','Quota temporarily unavailable: ')}${calendarEscape(coinGeckoUsage?.reason||tx('请稍后重试','please retry later'))}</div>`;const used=coinGeckoUsage.used,limit=coinGeckoUsage.monthlyLimit,remaining=coinGeckoUsage.remaining,pct=Number.isFinite(used)&&Number.isFinite(limit)&&limit>0?Math.min(100,used/limit*100):0,next=new Date();next.setMonth(next.getMonth()+1,1);next.setHours(0,0,0,0);return `<div class="coingecko-usage"><div><b>${tx('CoinGecko 月度额度','CoinGecko monthly quota')} · ${calendarEscape(coinGeckoUsage.plan)}</b><strong>${Number.isFinite(pct)?pct.toFixed(1):'--'}%</strong></div><i><span style="width:${pct}%"></span></i><p>${Number.isFinite(used)?used.toLocaleString():'--'} ${tx('已用','used')} · ${Number.isFinite(remaining)?remaining.toLocaleString():'--'} ${tx('剩余','remaining')} · ${tx('月度总额','monthly total')} ${Number.isFinite(limit)?limit.toLocaleString():'--'}</p><small>${coinGeckoUsage.rateLimit?`${tx('限额','limit')} ${coinGeckoUsage.rateLimit}${tx('/分钟','/min')} · `:''}${tx('下次重置','next reset')} ${next.toLocaleDateString(uiLang==='zh'?'zh-CN':'en-US')} · ${tx('统计缓存 5 分钟','stats cached 5 min')}</small></div>`;})();
    const optional=apiCenterOptional().map(([id,name,scope,hint])=>`<article class="api-center-row"><div><b>${name}<small>${tx('可选升级（默认免费）','Optional upgrade (free by default)')}</small>${verification[id]?'<span class="badge bull api-verified">' + tx('已验证','Verified') + '</span>':''}</b><span>${scope}</span><p>${hint}</p>${id==='coingecko'?coinGeckoUsageMarkup:''}</div><form data-api-provider="${id}" autocomplete="off">${id==='custom'?`<label>API URL<input name="url" type="url" inputmode="url" autocomplete="url" aria-label="HTTPS API URL" placeholder="https://api.example.com/v1/data" data-1p-ignore="true" data-lpignore="true" ${credentials[id]?'data-saved="true"':''}></label><label>API Key（${credentials[id]?tx('重新填写以更新','refill to update'):tx('可选','optional')}）<input name="key" type="password" autocomplete="new-password" aria-label="Optional API key" placeholder="${tx('可选 API Key（不会回显）','Optional API key (never echoed)')}" data-1p-ignore="true" data-lpignore="true"></label>`:`<input name="key" type="password" autocomplete="off" placeholder="${hint}" ${credentials[id]?'data-saved="true"':''}>`}<button>${credentials[id]?tx('更新','Update'):tx('保存','Save')}${id==='custom'?tx('配置',' config'):tx(' Key',' Key')}</button>${credentials[id]&&id!=='custom'?'<button type="button" class="api-verify">' + tx('验证 Key','Verify Key') + '</button>':''}${credentials[id]?'<button type="button" class="api-clear">' + tx('清除','Clear') + '</button>':''}</form></article>`).join('');
    apiCenterModal.innerHTML=`<section role="dialog" aria-modal="true" aria-labelledby="apiCenterTitle"><header><div><b id="apiCenterTitle">${tx('API 接入中心','API Center')}</b><small>${tx('密钥仅保存于本机服务端，不会回显到浏览器','Keys are stored server-side only and never echoed back')}</small></div><button type="button" data-close-api-center aria-label="${tx('关闭','Close')}">×</button></header><div class="api-center-body"><h3>${tx('默认免费（无需填入）','Free by default (no entry)')}</h3>${free}<h3>${tx('可选升级（默认免费）','Optional upgrade (free by default)')}</h3>${optional}<h3>${tx('AI 大模型（可选）','AI models (optional)')}</h3>${qwen}<h3>${tx('付费数据（可选）','Paid data (optional)')}</h3><article class="api-center-row required"><div><b>Finnhub Economic Calendar<small>${tx("付费套餐","Paid plan")}</small>${verification.finnhub?'<span class="badge bull api-verified">' + tx("Key 已验证","Key verified") + '</span>':''}</b><span>${tx("宏观实际值、市场一致预期、前值","Actual macro values, market consensus, previous values")}</span><p>${tx("免费 Key 可验证基础行情，但 Economic Calendar 需要付费套餐；未开通时自动使用内置公开宏观日历。","A free key validates basic quotes, but the Economic Calendar needs a paid plan; when unavailable, the built-in public macro calendar is used automatically.")}</p></div><form data-api-provider="finnhub"><input name="key" type="password" autocomplete="off" placeholder="${tx("可选：仅付费套餐可启用 Economic Calendar","Optional: paid plan enables the Economic Calendar")}" ${credentials.finnhub?'data-saved="true"':''}><button>${credentials.finnhub?tx('更新 Key','Update Key'):tx('保存 Key','Save Key')}</button>${credentials.finnhub?'<button type="button" class="api-verify">' + tx('验证 Key','Verify Key') + '</button><button type="button" class="api-clear">' + tx('清除','Clear') + '</button>':''}</form></article></div></section>`;
    apiCenterModal.querySelector('[data-close-api-center]').onclick=()=>{apiCenterModal.hidden=true;};
    apiCenterModal.onclick=event=>{if(event.target===apiCenterModal)apiCenterModal.hidden=true;};
    apiCenterModal.querySelectorAll('form[data-api-provider]').forEach(form=>form.onsubmit=async event=>{event.preventDefault();const provider=form.dataset.apiProvider;let key=(form.elements.key?.value||'').trim(),url=(form.elements.url?.value||'').trim(),model=(form.elements.model?.value||'').trim();if(provider==='qwen'){const normalized=normalizeQwenInputs(form);if(normalized.error){window.showAppDialog({title:tx('API 接入中心','API Center'),message:normalized.error});return;}key=normalized.key;url=normalized.url;}if(provider==='custom'?!url:!key){window.showAppDialog({title:tx('API 接入中心','API Center'),message:provider==='custom'?tx('请填写有效的 HTTPS API 地址。','Enter a valid HTTPS API URL.'):tx('请填写 API Key。','Enter the API Key.')});return;}try{await apiCenterRequest('/api/api-center',{method:'PUT',body:JSON.stringify({provider,key,url,model})});const saved=await window.btcSecureVault?.get('api-center')||{};await window.btcSecureVault?.put('api-center',{...saved,[provider]:{key,url}});await renderApiCenter();}catch(error){window.showAppDialog({title:tx('API 接入中心','API Center'),message:error.message});}});
    apiCenterModal.querySelectorAll('.api-clear').forEach(button=>button.onclick=async()=>{try{const provider=button.closest('form').dataset.apiProvider;await apiCenterRequest(`/api/api-center?provider=${provider}`,{method:'DELETE'});const saved=await window.btcSecureVault?.get('api-center')||{};delete saved[provider];await window.btcSecureVault?.put('api-center',saved);await renderApiCenter();}catch(error){window.showAppDialog({title:tx('API 接入中心','API Center'),message:error.message});}});
    apiCenterModal.querySelectorAll('.api-verify').forEach(button=>button.onclick=async()=>{const provider=button.closest('form').dataset.apiProvider;button.disabled=true;button.textContent=tx('验证中…','Verifying…');try{const result=await apiCenterRequest('/api/api-center/verify',{method:'POST',body:JSON.stringify({provider})});if(result.valid)await renderApiCenter();window.showAppDialog({title:tx('API Key 验证','API Key verification'),message:result.message});}catch(error){window.showAppDialog({title:tx('API Key 验证','API Key verification'),message:error.message});}finally{button.disabled=false;button.textContent=tx('验证 Key','Verify Key');}});
    // 千问验证：输入框里填了新 Key 就先保存再验证，一次点击走完整个流程。
    // Qwen verify: save first when a new key is typed, so one click completes the whole flow.
    // 端点下拉只是填充工具：选中即写入 API 地址输入框；留空表示交给服务端按 Key 前缀自动匹配。
    // The endpoint dropdown only fills the URL field; blank means auto-match by key prefix.
    const qwenEndpointSelect=apiCenterModal.querySelector('.qwen-endpoint');
    if(qwenEndpointSelect)qwenEndpointSelect.onchange=()=>{const form=apiCenterModal.querySelector('form[data-api-provider="qwen"]');if(form?.elements.url)form.elements.url.value=qwenEndpointSelect.value;};
    // 粘贴 Key 立刻提示它属于哪套体系（sk-sp- = Token Plan 订阅）。
    // Typing a key immediately reveals which system it belongs to.
        // v2.12.31：Key 被粘进「API 地址」框时的归一化。
    // 过去这种情况会被浏览器原生 URL 校验直接拦下（只弹英文 “Please enter a URL.”），
    // 用户看到的现象就是「Key 填不进去」。
    // Keys pasted into the URL field are normalised here; the browser used to block it with a
    // native "Please enter a URL." bubble, which reads as "the key cannot be entered".
    const QWEN_KEY_RE=/^sk-[A-Za-z0-9._-]{6,}$/i;
    const normalizeQwenInputs=form=>{
      const keyEl=form.elements.key,urlEl=form.elements.url;
      let key=(keyEl?.value||'').trim(),url=(urlEl?.value||'').trim();
      if(url&&QWEN_KEY_RE.test(url)){
        if(!key){key=url;url='';if(keyEl)keyEl.value=key;if(urlEl)urlEl.value='';if(qwenKeyInput)qwenKeyInput.dispatchEvent(new Event('input'));}
        else if(key!==url)return{error:tx('你把 API Key 填到了「API 地址」框。请把 Key 填在最上面的「千问 API Key」，API 地址留空即可按前缀自动匹配端点。','The key is in the “API URL” field. Put it in the “Qwen API Key” field above and leave the URL blank to auto-match the endpoint.')};
      }
      if(url&&!/^https:\/\//i.test(url))return{error:tx('「API 地址」需要以 https:// 开头（留空则按 Key 前缀自动匹配）。要填 Key 请填在上面的「千问 API Key」。','The API URL must start with https:// (blank = auto-match by key prefix). To enter a key, use the “Qwen API Key” field above.')};
      return{key,url};
    };
const qwenKeyInput=apiCenterModal.querySelector('form[data-api-provider="qwen"] input[name="key"]');
    if(qwenKeyInput&&qwenEndpointSelect){const tokenPlanOption=[...qwenEndpointSelect.options].find(option=>option.value.includes('token-plan'));if(tokenPlanOption)qwenKeyInput.oninput=()=>{qwenEndpointSelect.value=/^sk-sp-/i.test(qwenKeyInput.value.trim())?tokenPlanOption.value:'';};}
    const qwenVerifyButton=apiCenterModal.querySelector('.api-verify-qwen');
    if(qwenVerifyButton)qwenVerifyButton.onclick=async()=>{const form=apiCenterModal.querySelector('form[data-api-provider="qwen"]');let key=(form?.elements.key?.value||'').trim(),model=(form?.elements.model?.value||'').trim(),url=(form?.elements.url?.value||'').trim();const normalizedQwen=normalizeQwenInputs(form);if(normalizedQwen.error){window.showAppDialog({title:'千问 API Key 验证',message:normalizedQwen.error});return;}key=normalizedQwen.key;url=normalizedQwen.url;if(!key&&!credentials.qwen){window.showAppDialog({title:tx('千问 API Key 验证','Qwen API Key verification'),message:tx('请先填写 API Key 再验证。','Enter the API Key before verifying.')});return;}qwenVerifyButton.disabled=true;qwenVerifyButton.textContent=tx('验证中…','Verifying…');try{if(key){await apiCenterRequest('/api/api-center',{method:'PUT',body:JSON.stringify({provider:'qwen',key,url,model})});window.dispatchEvent(new CustomEvent('btc:ai-credential-changed',{detail:{available:false}}));}const result=await apiCenterRequest('/api/api-center/verify',{method:'POST',body:JSON.stringify({provider:'qwen'})});await renderApiCenter();window.showAppDialog({title:'千问 API Key 验证',message:result.message});}catch(error){await renderApiCenter();window.showAppDialog({title:'千问 API Key 验证',message:error.message});}finally{qwenVerifyButton.disabled=false;qwenVerifyButton.textContent=tx('验证 Key','Verify Key');}};

    // 千问额度小卡渲染：与右下角对话窗同源（同一接口），数据保留 60s。
    // Mini Qwen quota card: same endpoint as the chat panel; data cached for 60s.
    const qwenQuotaCard=apiCenterModal.querySelector('.api-qwen-quota');
    if(qwenQuotaCard)renderApiQwenQuota(qwenQuotaCard);
  };
  $("apiCenterToggle").onclick=async()=>{apiCenterModal.hidden=false;await renderApiCenter();};
  // API 中心打开时 60s 拉一次千问额度；关闭后停掉，避免空转。
  // While the API center is open, refresh the Qwen quota card every 60s; stop when hidden.
  let apiQuotaTimer=null;
  const startApiQuotaLoop=()=>{if(apiQuotaTimer)return;const tick=()=>{const card=apiCenterModal.querySelector('.api-qwen-quota');if(card)renderApiQwenQuota(card);};apiQuotaTimer=setInterval(()=>{if(!apiCenterModal.hidden)tick();else{clearInterval(apiQuotaTimer);apiQuotaTimer=null;}},60_000);};
  const stopApiQuotaLoop=()=>{if(apiQuotaTimer){clearInterval(apiQuotaTimer);apiQuotaTimer=null;}};
  const apiCenterCloseBtn=apiCenterModal.querySelector('[data-close-api-center]');
  if(apiCenterCloseBtn){const original=apiCenterCloseBtn.onclick;apiCenterCloseBtn.onclick=(event)=>{stopApiQuotaLoop();if(typeof original==='function')original.call(apiCenterCloseBtn,event);};}
  $("apiCenterToggle").onclick=async()=>{apiCenterModal.hidden=false;await renderApiCenter();startApiQuotaLoop();};
}
