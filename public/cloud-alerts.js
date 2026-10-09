(()=>{
  const tx=(zh,en)=>(localStorage.getItem('btc_lang')==='en'?en:zh);
  const api=async(path,options={})=>{const response=await fetch(path,{...options,headers:{'content-type':'application/json',...(options.headers||{})}}),data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||data.detail||'请求失败');return data};
  const notice=(message,title=tx('账户与云端服务','Account & cloud service'))=>showAppDialog({title,message});
  let account=null,health=null,cloudRules=[];
  const currentCoin=()=>(window.btcCoinContext&&window.btcCoinContext.coin)?window.btcCoinContext.coin():'BTC';
  const accountCard=()=>document.getElementById('accountServiceCard');
  const cloudPanel=()=>document.querySelector('#wechatAlertCard .cloud-alert-panel');
  const finishLogout=async keepLocal=>{try{if(keepLocal){const alerts=await window.btcSecureVault?.get('alerts'),apiCenter=await window.btcSecureVault?.get('api-center');await window.btcSecureVault?.put('logout-backup',{version:1,savedAt:Date.now(),alerts:alerts||{rules:[],sendKey:(sessionStorage.getItem('btc_local_serverchan_sendkey_v1')||'').trim()},apiCenter:apiCenter||{}})}else{await window.btcSecureVault?.remove('alerts');await window.btcSecureVault?.remove('api-center');await window.btcSecureVault?.remove('logout-backup');sessionStorage.removeItem('btc_local_serverchan_sendkey_v1');localStorage.removeItem('btc_local_notification_rules_v1')}await api('/api/auth/logout',{method:'POST'});await refresh();notice(keepLocal?tx('已退出登录。本机已保留 AES-GCM 加密副本。','Signed out. An AES-GCM encrypted local copy was kept.'):tx('已退出登录，且已清除本机规则与 Key 副本。','Signed out and local rules/Key copies were cleared.'))}catch(error){notice(error.message)}};
  const requestLogout=()=>showAppDialog({title:tx('退出登录','Sign out'),message:tx('是否在本机保留加密的推送 Key、规则策略和 API 配置副本？选择“不保留并退出”会永久清除本机副本。','Keep an encrypted local copy of push Key, rules, and API settings? Choosing “Sign out and remove” permanently clears it.'),confirmText:tx('保留加密副本并退出','Keep encrypted copy'),cancelText:tx('不保留并退出','Sign out and remove'),onConfirm:()=>finishLogout(true),onCancel:()=>finishLogout(false)});
  const authMarkup=()=>`<div class="account-auth"><div class="account-auth-tabs" role="tablist"><button type="button" class="active" data-auth-tab="login" role="tab" aria-selected="true">${tx('登录','Sign in')}</button><button type="button" data-auth-tab="register" role="tab" aria-selected="false">${tx('注册','Sign up')}</button></div><form data-auth="login" class="account-auth-form active"><label>${tx('邮箱','Email')}<input name="email" type="email" autocomplete="email" placeholder="name@example.com" required></label><label>${tx('密码','Password')}<input name="password" type="password" autocomplete="current-password" placeholder="${tx('输入密码','Enter password')}" required></label><button class="account-auth-submit">${tx('登录','Sign in')}</button></form><form data-auth="register" class="account-auth-form"><label>${tx('邮箱','Email')}<input name="email" type="email" autocomplete="email" placeholder="name@example.com" required></label><label>${tx('密码','Password')}<input name="password" type="password" autocomplete="new-password" minlength="12" placeholder="${tx('至少 12 位密码','At least 12 characters')}" required></label><button class="account-auth-submit">${tx('注册','Sign up')}</button></form></div>`;
  const accountMarkup=()=>`<section><header><b>${tx('账户与云端服务','Account & cloud service')}</b><button id="closeAccountService" type="button" aria-label="${tx('关闭','Close')}">×</button></header>${!health?.enabled?`<p class="bear">${tx('云端服务暂不可用：','Cloud service unavailable: ')}${health?.reason||tx('请求失败','request failed')}。</p>`:account?`<p class="account-service-desc">${tx('已登录账户可使用云端推送；未来的 AI 实时分析也将在此处授权与展示用量。','Signed-in accounts can use cloud push; future AI realtime analysis will be authorized and shown here.')}</p><div class="account-service-user"><div class="asu-id-row"><span class="asu-avatar">${(account.user?.email||'?').charAt(0).toUpperCase()}</span><b class="asu-email">${account.user?.email||tx('未知账户','Unknown account')}</b><span class="badge bull">${tx('已登录','Signed in')}</span></div><p class="asu-note">${tx('持仓、推送规则与本会话 SendKey 可一键同步；API 中心密钥不会回显到浏览器。','Positions, alert rules, and this-session SendKey can sync at once; API-center keys never return to the browser.')}</p><div class="asu-actions"><button id="accountSyncAll" type="button" class="asu-primary">${tx('一键同步全部','Sync all')}</button><button id="accountLogout" type="button" class="asu-ghost">${tx('退出登录','Sign out')}</button></div></div>`:authMarkup()}</section>`;
  function renderAccount(){const card=accountCard(),toggle=document.getElementById('accountLoginToggle');if(!card)return;if(toggle){toggle.textContent=account?tx('账户','Account'):tx('登录','Sign in');toggle.classList.toggle('active',Boolean(account));toggle.title=account?tx('查看或收起账户与云端服务','View or collapse account & cloud service'):tx('登录账户以使用云端推送与未来 AI 功能','Sign in to use cloud push and future AI features')}try{card.innerHTML=accountMarkup()}catch(error){card.innerHTML=`<section><header><b>${tx('账户与云端服务','Account & cloud service')}</b><button id="closeAccountService" type="button" aria-label="${tx('关闭','Close')}">×</button></header><p class="bear">${tx('渲染失败：','Render failed: ')}${error.message}</p></section>`}card.querySelector('#closeAccountService').onclick=()=>{card.hidden=true};card.onclick=event=>{if(event.target===card)card.hidden=true};const selectAuthTab=kind=>{card.querySelectorAll('[data-auth-tab]').forEach(tab=>{const active=tab.dataset.authTab===kind;tab.classList.toggle('active',active);tab.setAttribute('aria-selected',String(active))});card.querySelectorAll('.account-auth-form').forEach(form=>form.classList.toggle('active',form.dataset.auth===kind))};card.querySelectorAll('[data-auth-tab]').forEach(tab=>tab.onclick=()=>selectAuthTab(tab.dataset.authTab));card.querySelectorAll('[data-auth]').forEach(form=>form.onsubmit=async event=>{event.preventDefault();try{await api(`/api/auth/${form.dataset.auth}`,{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(form)))});card.hidden=false;await refresh()}catch(error){notice(error.message)}});card.querySelector('#accountSyncAll')?.addEventListener('click',()=>syncAll().catch(error=>notice(error.message)));card.querySelector('#accountLogout')?.addEventListener('click',requestLogout)}
  const panelMarkup=()=>{
    /* v2.12.75：放开非 BTC 限制，ETH/ZEC/BNB 云端规则现已支持（钉钉等渠道按币种独立推送）。 */
    return !health?.enabled?`<p class="bear">${tx('云端服务尚未配置，暂不能保存关页推送规则。','Cloud service is not configured; closed-page push rules cannot be saved yet.')}</p>`:!account?`<p>${tx('登录账户后，可把现有本机规则安全同步到服务器，在网页关闭后继续推送。','After signing in, your local rules can be safely synced to the server and keep pushing after the page closes.')}</p><button id="openAccountLogin" type="button">${tx('前往登录','Go to sign in')}</button>`:`<div class="cloud-status-row"><p><b>${tx('云端已同步','Cloud synced')} ${cloudRules.length} ${tx('条规则','rules')}</b><span>${tx('本地 8787 在线时由本地优先推送；本地掉线或关页后由云端后台接管。','Local 8787 takes priority when online; cloud takes over after local goes offline or the page closes.')}</span></p><span class="badge ${account.hasSendKey?'bull':'flat'}">${account.hasSendKey?tx('云端 Key 已就绪','Cloud Key ready'):tx('请在推送设置中配置渠道','Set up a channel in Push settings')}</span></div><div class="cloud-alert-actions"><button id="syncLocalAlerts" type="button">${tx('同步本机规则到云端','Sync local rules to cloud')}</button></div>`;
  };
  function renderCloudPanel(){const box=cloudPanel();if(!box)return;box.innerHTML=panelMarkup();box.querySelector('#openAccountLogin')?.addEventListener('click',()=>{const card=accountCard();if(card)card.hidden=false});box.querySelector('#syncLocalAlerts')?.addEventListener('click',()=>showAppDialog({title:tx('同步到云端','Sync to cloud'),message:tx('将以时间戳较新者为准，双向合并本机与云端的推送规则（同 id 取新、不同 id 并集）。','Bidirectional merge of local and cloud alert rules by newest timestamp (same id keeps newest, different ids unioned).'),confirmText:tx('开始同步','Start sync'),cancelText:tx('取消','Cancel'),onConfirm:()=>syncRules().catch(error=>notice(error.message))}))}
  /* 多币种（v2.12.5）：本机规则 vault 键按币种取（BTC 沿用 'alerts'，其余 'alerts_<COIN>'），
     与 notification.js 的 vaultKeyFor 同一约定；不再写死 'alerts' 把其它币种串到 BTC。 */
  const localVaultKey=()=>{const c=currentCoin();return c==='BTC'?'alerts':'alerts_'+c};
  const localAlertData=async()=>{try{const data=await window.btcSecureVault?.get(localVaultKey());return Array.isArray(data?.rules)?data:{rules:[]}}catch(error){throw new Error(tx('本机加密规则无法读取。','Encrypted local rules cannot be read.'))}};
  const localChannelsKey='btc_local_channels_v1';
  const getLocalSendKey=async()=>{try{const channels=await window.btcSecureVault?.get(localChannelsKey);const serverchan=Array.isArray(channels)?channels.find(c=>c.type==='serverchan'):null;return serverchan?.config?.sendKey?.trim()||''}catch{return ''}};
  const saveLocalAlertData=async rules=>{const sendKey=await getLocalSendKey();await window.btcSecureVault?.put(localVaultKey(),{rules,sendKey});localStorage.removeItem('btc_local_notification_rules_v1')};
  /* v2.12.80：整数位 / 网格 / 波动三类状态型规则也可上云（服务端 alert-worker 已支持评估）。
     custom_grid 同步放行（worker 一起实现），即使用户当前没有网格规则。 */
  const CLOUD_KINDS=['price_reached','price_above','price_below','long_liquidation','short_liquidation','round_number','custom_grid','volatility'];
  const STATEFUL_KINDS=['round_number','custom_grid','volatility'];
  /* 上传载荷：价格类沿用 targetPrice；状态型把私有参数放 params（服务端校验后存 JSONB），
     targetPrice 存主参数（步长/阈值）以满足服务端 NOT NULL>0。状态型冷却下限 1 分钟，与本地评估默认一致。 */
  const ruleSyncPayload=(r,coin)=>{
    const payload={id:r.id,kind:r.kind,repeat:r.repeat!==false,cooldownMinutes:Math.max(STATEFUL_KINDS.includes(r.kind)?1:0,Number(r.cooldownMinutes)||0),coin};
    if(STATEFUL_KINDS.includes(r.kind)){
      payload.targetPrice=Number(r.kind==='volatility'?r.threshold:r.step);
      payload.params=r.kind==='round_number'?{step:Number(r.step),direction:r.direction||'both'}
        :r.kind==='custom_grid'?{basePrice:Number(r.basePrice),step:Number(r.step),direction:r.direction||'both'}
        :{windowMinutes:Number(r.windowMinutes),threshold:Number(r.threshold),direction:r.direction||'both'};
    } else payload.targetPrice=Number(r.targetPrice);
    return payload;
  };
  const tsOf=v=>Number(v&&v.updatedAt)||0;
  const mergeById=(localArr=[],cloudArr=[])=>{const map=new Map();for(const r of cloudArr)if(r&&r.id)map.set(r.id,{...r});for(const r of localArr)if(r&&r.id){const ex=map.get(r.id);if(!ex||tsOf(r)>=tsOf(ex))map.set(r.id,{...r});}return[...map.values()]};
  // v2.12.69：推送规则双向合并（同 id 比时间戳取新，不同 id 并集保留；本地专属类只留本地）
  async function syncRules(){
    const coin=currentCoin();
    const local=await localAlertData();
    const localRules=(Array.isArray(local.rules)?local.rules:[]).map(r=>({...r,coin}));
    const allCloud=(await api('/api/alerts/rules')).rules||[];
    /* 下载侧：把服务端 params JSONB 展开回规则顶层字段（step/direction/windowMinutes/threshold），
       mergeById 与本地规则格式保持一致。 */
    const cloudRules=allCloud.filter(r=>(r.coin||'BTC')===coin).map(r=>({repeat:true,...r,...(r.params&&typeof r.params==='object'?r.params:{})}));
    const merged=mergeById(localRules,cloudRules);
    const localOrigin=new Set(localRules.filter(r=>CLOUD_KINDS.includes(r.kind)).map(r=>r.id));
    for(const r of merged){
      if((r.coin||'BTC')!==coin) continue; // 不触碰其它币种的云端规则
      if(!localOrigin.has(r.id)||!CLOUD_KINDS.includes(r.kind)) continue;
      await api('/api/alerts/rules',{method:'POST',body:JSON.stringify(ruleSyncPayload(r,coin))});
    }
    const localOnly=localRules.filter(r=>r&&!CLOUD_KINDS.includes(r.kind));
    const finalLocal=[...merged.filter(r=>CLOUD_KINDS.includes(r.kind)),...localOnly];
    await saveLocalAlertData(finalLocal);
    window.dispatchEvent(new Event('btc:cloud-rules-synced'));
    await refresh();
    return merged.length;
  }
  // v2.12.69：自动播报（语音规则）双向合并
  async function syncVoiceBidirectional(){
    const local=(window.btcVoiceRulesAccess&&window.btcVoiceRulesAccess.get())||[];
    const remote=(await api('/api/voice/state')).rules||[];
    const merged=mergeById(local,remote);
    if(window.btcVoiceRulesAccess)window.btcVoiceRulesAccess.set(merged);
    await api('/api/voice/sync',{method:'POST',body:JSON.stringify({symbol:currentCoin(),rules:merged.map(({satisfied,...r})=>r)})});
    return merged.length;
  }
  // v2.12.69：持仓双向合并（按集合时间戳整组替换，较新一方整体覆盖）
  async function syncPositionsBidirectional(){
    const localEntries=Array.isArray(window.btcPersonalEntries)?window.btcPersonalEntries:[];
    const localTs=Number(localStorage.getItem('btc_positions_sync_ts_v1')||0);
    const profile=await api('/api/account/profile');
    const cloudEntries=Array.isArray(profile.personalEntries)?profile.personalEntries:[];
    const cloudTs=Number(profile.personalEntriesUpdatedAt)||0;
    if(localTs>=cloudTs){
      const norm=[0,1].map(i=>{const e=localEntries[i];return(e&&Number(e.price)>0)?{price:Number(e.price),side:e.side==='short'?'short':'long'}:{price:null,side:i===0?'long':'short'}});
      await api('/api/account/profile',{method:'PUT',body:JSON.stringify({personalEntries:norm,personalEntriesUpdatedAt:localTs})});
      return{dir:'upload',count:localEntries.filter(e=>e&&Number(e.price)>0).length};
    }
    window.btcPersonalEntries=cloudEntries;
    try{localStorage.setItem('btc_entry_prices_v1',JSON.stringify(cloudEntries))}catch{}
    try{localStorage.setItem('btc_positions_sync_ts_v1',String(cloudTs))}catch{}
    window.dispatchEvent(new CustomEvent('btc:positions-downloaded',{detail:{entries:cloudEntries}}));
    return{dir:'download',count:cloudEntries.filter(e=>e&&Number(e.price)>0).length};
  }
  async function syncAll(){
    if(!account)throw new Error(tx('请先登录。','Please sign in first.'));
    const button=document.getElementById('accountSyncAll');
    if(button){button.disabled=true;button.textContent=tx('同步中…')}
    try{
      const rules=await syncRules();
      const voice=await syncVoiceBidirectional();
      const pos=await syncPositionsBidirectional();
      const sendKey=await getLocalSendKey();
      if(sendKey){if(!/^SCT/i.test(sendKey))throw new Error(tx('本地 SendKey 格式无效，未同步。','The local SendKey is invalid and was not synced.'));await api('/api/alerts/credentials',{method:'PUT',body:JSON.stringify({sendKey})})}
      notice(tx(`双向同步完成：推送规则 ${rules} 条、自动播报 ${voice} 条、持仓${pos.dir==='upload'?'已上传':'已下载'} ${pos.count} 个。`,`Bidirectional sync done: ${rules} alert rules, ${voice} voice alerts, positions ${pos.dir==='upload'?'uploaded':'downloaded'} (${pos.count}).`));
    }finally{if(button){button.disabled=false;button.textContent=tx('一键同步全部','Sync all')}}
  }
  // v2.12.68：登录后提示上传本地数据到云端
  const UPLOAD_PROMPT_KEY='btc_upload_prompt_state';
  const getUploadPromptState=()=>{try{return JSON.parse(localStorage.getItem(UPLOAD_PROMPT_KEY)||'null')}catch{return null}};
  const setUploadPromptState=(state)=>{try{localStorage.setItem(UPLOAD_PROMPT_KEY,JSON.stringify({state,at:Date.now()}))}catch{}};
  let previousAccount=null;
  const uploadPromptModal=()=>document.getElementById('btcUploadPromptModal');
  const createUploadPromptModal=()=>{if(uploadPromptModal())return;const div=document.createElement('div');div.id='btcUploadPromptModal';div.className='alert-composer upload-prompt-modal';div.hidden=true;div.innerHTML=`<section><header><b>${tx('检测到已登录','Signed in detected')}</b><button id="closeUploadPrompt" type="button" aria-label="${tx('关闭','Close')}">×</button></header><div class="upload-prompt-body"><p>${tx('是否双向同步本地与云端数据？以时间戳较新的一方为准（同 id 规则取新、持仓按集合时间戳整组替换、API 密钥仅本地→云端上传）。','Bidirectional sync between local and cloud? The newer timestamp wins (same-id rules keep newest; positions replace by set timestamp; API keys upload local→cloud only).')}</p><div class="upload-prompt-grid"><button type="button" data-sync="rules"><b>1</b><span>${tx('同步推送规则与自动播报','Sync alert rules & auto-broadcast')}</span></button><button type="button" data-sync="ai"><b>2</b><span>${tx('同步 AI 助手/API 设置','Sync AI assistant / API settings')}</span></button><button type="button" data-sync="positions"><b>3</b><span>${tx('同步持仓数据','Sync positions')}</span></button></div></div><div class="upload-prompt-footer"><button type="button" data-upload-dismiss="later" class="asu-ghost">${tx('稍后再说','Later')}</button><button type="button" data-upload-dismiss="never" class="ch-clear">${tx('不再提示','Never ask')}</button></div></section>`;document.body.append(div);div.querySelector('#closeUploadPrompt').onclick=()=>{div.hidden=true};div.onclick=(event)=>{if(event.target===div)div.hidden=true};div.querySelectorAll('[data-sync]').forEach(btn=>btn.onclick=()=>handleSync(btn.dataset.sync));div.querySelectorAll('[data-upload-dismiss]').forEach(btn=>btn.onclick=()=>{if(btn.dataset.uploadDismiss==='never')setUploadPromptState('never');div.hidden=true})};
  const handleSync=async(kind)=>{try{if(kind==='rules'){const n=await syncRules();notice(tx(`推送规则与自动播报已双向同步（${n} 条规则）。`,`Alert rules & auto-broadcast synced (${n} rules).`))}else if(kind==='ai'){await syncAiSettings()}else if(kind==='positions'){const r=await syncPositionsBidirectional();notice(tx(`持仓已${r.dir==='upload'?'上传':'下载'}（${r.count} 个）。`,`Positions ${r.dir==='upload'?'uploaded':'downloaded'} (${r.count}).`))}setUploadPromptState('done');uploadPromptModal().hidden=true}catch(error){notice(error.message)}};
  const handleUpload=handleSync;
  const handleDownload=async()=>{};
  const syncAiSettings=async()=>{const local=await window.btcSecureVault?.get('api-center')||{};const providers=Object.keys(local).filter(k=>local[k]&&(local[k].key||local[k].url));if(!providers.length)throw new Error(tx('本机没有 AI/API 设置可同步。','No local AI/API settings to sync.'));for(const provider of providers){const item=local[provider];await api('/api/api-center',{method:'PUT',body:JSON.stringify({provider,key:item.key||'',url:item.url||'',model:item.model||''})})}notice(tx(`已同步 ${providers.length} 项 API 设置到云端（密钥不回传浏览器，云端→本地下载不可用）。`,`Synced ${providers.length} API setting(s) to the cloud (keys are not returned to the browser, so cloud→local download is unavailable).`))};
  const syncPositionsUp=async()=>{await syncPositionsBidirectional()};
  const downloadPositions=async()=>{await syncPositionsBidirectional()};
  const maybeShowUploadPrompt=()=>{if(!account||previousAccount)return;const state=getUploadPromptState();if(state?.state==='done'||state?.state==='never')return;createUploadPromptModal();const modal=uploadPromptModal();if(modal)modal.hidden=false};
  async function refresh(){try{health=await api('/api/alerts/health');account=health.enabled?await api('/api/auth/me').catch(error=>error.message.includes('登录')?null:Promise.reject(error)):null;cloudRules=account?((await api('/api/alerts/rules')).rules||[]).filter(r=>(r.coin||'BTC')===currentCoin()):[]}catch(error){health={enabled:false,reason:`${tx('接口不可用：','API unavailable: ')}${error.message}`} ;account=null;cloudRules=[]}renderAccount();renderCloudPanel();window.dispatchEvent(new CustomEvent('btc:account-state',{detail:{loggedIn:Boolean(account),hasSendKey:Boolean(account?.hasSendKey)}}));maybeShowUploadPrompt();previousAccount=account}
  function mount(){const main=document.querySelector('main'),alertCard=document.getElementById('wechatAlertCard');if(!main||!alertCard){setTimeout(mount,50);return}if(!accountCard()){const card=document.createElement('div');card.id='accountServiceCard';card.className='alert-composer account-service-card';card.hidden=true;document.body.append(card);const controls=document.querySelector('header .controls'),host=document.getElementById('headerSettingsPanel')||controls,toggle=document.createElement('button');toggle.id='accountLoginToggle';toggle.type='button';toggle.className='account-login-toggle';toggle.textContent=tx('登录','Sign in');toggle.onclick=()=>{card.hidden=!card.hidden};host.prepend(toggle);const apiCenter=document.getElementById('apiCenterToggle');if(apiCenter)toggle.after(apiCenter);if(!alertCard.querySelector('.cloud-alert-panel')){const panel=document.createElement('div');panel.className='cloud-alert-panel';alertCard.append(panel)}}refresh()}
  window.addEventListener('btc:cloud-refresh',()=>refresh());
  window.addEventListener('btc:voice-language-changed',()=>refresh());
  window.addEventListener('btc:coin-changed',()=>refresh());
  setTimeout(mount,20);
})();
