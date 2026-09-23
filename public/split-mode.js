// split-mode.js — 多分屏模式的「外壳」控制器（v11）。
//
// 职责：在顶部栏注入「多分屏」按钮；点击后弹出全屏覆盖层。每个格子用 iframe
// 加载 /split-pane.html?symbol=<币>&pane=<i>。
//
// v5 新增：
//  - 自定义布局：2 / 3 / 4 个币种（顶栏分段按钮 + 「＋添加币种」）。
//      4 格 = 2×2；3 格 = 左侧大格（纵跨两行）+ 右侧两小格；2 格 = 左右两格。
//  - 拖拽换位：按住某格顶栏拖到另一格上即交换两格配置（币种/周期/时长）。
//  - 每格右上角 ✕ 关闭（最少保留 2 格），关闭后自动切换布局模式。
//  - 放大单看：点击格子 ⤢（简单模式下点图表也可以），弹出大浮层 iframe 加载
//    首页同款详细页（实时价/我的持仓/K线/规则信号）。实现方式：fetch 首页 HTML，
//    摘掉 notification.js / cloud-alerts.js / split-mode.js 三个 <script>（避免重复
//    推送与嵌套分屏），并注入 stub 静音语音朗读与音效，再用 document.write 写入
//    iframe；加载完成后通过 window.btcCoinContext.setCoin() 切到目标币种，
//    关闭浮层时恢复原来的 localStorage 币种持久化键（不影响主页面状态）。
//
// 注意：覆盖层里出现「点一下开浮层」的按钮时，click 必须 stopPropagation()，
// 否则会被任何 document 上的收起监听立刻关掉。

const COIN_ORDER = ['BTC', 'ETH', 'ZEC', 'BNB'];
const INTERVAL_ORDER = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];
// 查看时长（与周期正交）：选定周期后想看多长时间跨度。
const RANGE_ORDER = [
  { key: '4H', label: '4小时' },
  { key: '1D', label: '1天' },
  { key: '2D', label: '2天' },
  { key: '1W', label: '1周' },
  { key: 'ALL', label: '全部' },
];
// v2 单一数据源：cells = [{coin, interval, range}]，长度即布局格数（2~4）。
const CELL_KEY = 'btc_split_cells_v2';
// 语音播报：每个币的开关按币种存到 localStorage（与面板 iframe 同源共享），
// 优先级顺序单独持久化。
const VOICE_MAP_KEY = 'btc_split_voice_v1';
const VOICE_PRIORITY_KEY = 'btc_split_voice_priority_v1';
// v1 旧键（仅用于迁移）。
const PANE_KEY = 'btc_split_panes_v1';
const INTERVAL_KEY = 'btc_split_intervals_v1';
const RANGE_KEY = 'btc_split_ranges_v1';

const isEn = () => localStorage.getItem('btc_lang') === 'en';
const tx = (zh, en) => (isEn() ? en : zh);

function getCells() {
  try {
    const a = JSON.parse(localStorage.getItem(CELL_KEY));
    if (Array.isArray(a) && a.length >= 2 && a.length <= 4 &&
        a.every((c) => c && COIN_ORDER.includes(c.coin) && c.interval && c.range)) {
      return a.map((c) => ({ coin: c.coin, interval: c.interval, range: c.range }));
    }
  } catch {}
  // 迁移 v1：4 格旧配置 → 4 格新配置。
  try {
    const p = JSON.parse(localStorage.getItem(PANE_KEY));
    const iv = JSON.parse(localStorage.getItem(INTERVAL_KEY));
    const rg = JSON.parse(localStorage.getItem(RANGE_KEY));
    if (Array.isArray(p) && p.length === 4) {
      return p.map((coin, i) => ({
        coin,
        interval: (iv && iv[i]) || '15m',
        range: (rg && rg[i]) || '2D',
      }));
    }
  } catch {}
  return COIN_ORDER.map((coin) => ({ coin, interval: '15m', range: '2D' }));
}
function setCells(cells) {
  try { localStorage.setItem(CELL_KEY, JSON.stringify(cells)); } catch {}
}
function unusedCoins(cells) {
  return COIN_ORDER.filter((c) => !cells.some((x) => x.coin === c));
}

let overlay = null, grid = null, built = false, overlayOpen = false, tabHidden = false;
let cells = [];
// 放大浮层（同一时间只开一个）。
let detail = null; // { root, frame, coin, saved: {mode, symbol} }
// 语音播报：顶栏那颗「播报设置」按钮（v2.12.17 起，原先那排 chip 收进它开出来的面板）。
let voiceBtn = null;

// 主题：优先读主站 html 上的 data-theme；否则按 body 背景亮度推断。
function currentTheme() {
  const de = document.documentElement;
  if (de.dataset && (de.dataset.theme === 'light' || de.dataset.theme === 'dark')) return de.dataset.theme;
  try {
    const bg = getComputedStyle(document.body).backgroundColor;
    const m = bg.match(/\d+/g);
    if (m && m.length >= 3) {
      const [r, g, b] = m.map(Number);
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      return lum < 128 ? 'dark' : 'light';
    }
  } catch {}
  return 'dark';
}

function broadcast(type, extra) {
  for (const c of cells) {
    if (c.frame && c.frame.contentWindow) {
      c.frame.contentWindow.postMessage(Object.assign({ type }, extra || {}), location.origin);
    }
  }
}
function postTheme(cell) {
  if (cell.frame && cell.frame.contentWindow) {
    cell.frame.contentWindow.postMessage({ type: 'split:theme', theme: currentTheme() }, location.origin);
  }
}
function frameSrc(cell, i) {
  // pv= 面板页版本号：split-pane.html 本体没有 ?v= 可 bump，改版时把这里 +1，
  // 否则浏览器可能一直吃旧缓存的面板 HTML（本次实测 Chromium 会无视 no-cache）。
  const PANE_HTML_V = 13;
  return `/split-pane.html?symbol=${encodeURIComponent(cell.coin)}&interval=${encodeURIComponent(cell.interval)}` +
    `&range=${encodeURIComponent(cell.range)}&pane=${i}&pv=${PANE_HTML_V}`;
}

// ── 顶栏控件 ──────────────────────────────────────────────────────────────────
function makeSegmented(options, value, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'split-seg';
  for (const opt of options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'split-seg-btn' + (opt.value === value ? ' active' : '');
    b.textContent = opt.label;
    b.title = opt.title || opt.label;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (b.classList.contains('active')) return;
      for (const el of wrap.children) el.classList.remove('active');
      b.classList.add('active');
      onChange(opt.value);
    });
    wrap.appendChild(b);
  }
  return wrap;
}

function buildCellBar(cell, i) {
  const bar = document.createElement('div');
  bar.className = 'split-cell-bar';
  bar.title = tx('按住拖动可与其他格子换位', 'Drag to swap with another pane');

  const sel = document.createElement('select');
  sel.className = 'split-coin-select';
  sel.innerHTML = COIN_ORDER.map((k) => `<option value="${k}">${k} / USDT</option>`).join('');
  sel.value = cell.coin;
  sel.addEventListener('change', () => {
    cell.coin = sel.value;
    setCells(cells);
    cell.frame.src = frameSrc(cell, i);
  });
  bar.appendChild(sel);

  const iv = document.createElement('select');
  iv.className = 'split-coin-select split-interval-select';
  iv.innerHTML = INTERVAL_ORDER.map((k) => `<option value="${k}">${k}</option>`).join('');
  iv.value = cell.interval;
  iv.title = tx('K线周期', 'Candle interval');
  iv.addEventListener('change', () => {
    cell.interval = iv.value;
    setCells(cells);
    cell.frame.src = frameSrc(cell, i);
  });
  bar.appendChild(iv);

  const rg = document.createElement('select');
  rg.className = 'split-coin-select split-range-select';
  rg.innerHTML = RANGE_ORDER.map((r) => `<option value="${r.key}">${r.label}</option>`).join('');
  rg.value = cell.range;
  rg.title = tx('查看时长', 'View span');
  rg.addEventListener('change', () => {
    cell.range = rg.value;
    setCells(cells);
    // 查看时长只改可见窗口（数据已齐），用 postMessage 秒切，避免重载 iframe 重新拉数。
    if (cell.frame.contentWindow) cell.frame.contentWindow.postMessage({ type: 'split:range', range: rg.value }, location.origin);
  });
  bar.appendChild(rg);

  const spacer = document.createElement('span');
  spacer.className = 'split-bar-spacer';
  bar.appendChild(spacer);

  // ⤢ 放大单看：悬浮首页同款详细页。
  const exp = document.createElement('button');
  exp.type = 'button';
  exp.className = 'split-cell-btn';
  exp.textContent = '⤢';
  exp.title = tx('放大单看（首页详细版）', 'Expand (homepage detail)');
  exp.addEventListener('click', (e) => { e.stopPropagation(); openDetail(cell.coin); });
  bar.appendChild(exp);

  // ✕ 关闭该币种（最少保留 2 格）。
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'split-cell-btn split-cell-close';
  x.textContent = '✕';
  x.title = tx('移除该币种', 'Remove this coin');
  x.addEventListener('click', (e) => {
    e.stopPropagation();
    if (cells.length <= 2) return;
    const dead = cells.splice(i, 1)[0];
    dead.frame.remove();
    setCells(cells);
    rebuildGrid();
  });
  bar.appendChild(x);

  return bar;
}

function buildCell(cell, i) {
  const el = document.createElement('div');
  el.className = 'split-cell';
  el.dataset.idx = i;
  const bar = buildCellBar(cell, i);
  el.appendChild(bar);
  el.appendChild(cell.frame);

  // 拖拽换位：以顶栏为把手，整格作为放置目标。
  bar.draggable = true;
  bar.addEventListener('dragstart', (e) => {
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', String(i)); } catch {}
    el.classList.add('dragging');
    window.__splitDragIdx = i;
  });
  bar.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    window.__splitDragIdx = null;
    for (const c of grid.children) c.classList.remove('drag-over');
  });
  el.addEventListener('dragover', (e) => {
    if (window.__splitDragIdx == null || Number(el.dataset.idx) === window.__splitDragIdx) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    el.classList.add('drag-over');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('drag-over');
    const from = window.__splitDragIdx;
    const to = Number(el.dataset.idx);
    if (from == null || !(to >= 0) || from === to) return;
    // 交换两格配置，各自 iframe 用新参数重载。
    const a = cells[from], b = cells[to];
    const tmp = { coin: a.coin, interval: a.interval, range: a.range };
    a.coin = b.coin; a.interval = b.interval; a.range = b.range;
    b.coin = tmp.coin; b.interval = tmp.interval; b.range = tmp.range;
    setCells(cells);
    a.frame.src = frameSrc(a, from);
    b.frame.src = frameSrc(b, to);
    syncBarControls(from);
    syncBarControls(to);
  });
  return el;
}

function syncBarControls(i) {
  const el = grid.children[i];
  if (!el) return;
  const cell = cells[i];
  const [sel, iv, rg] = el.querySelectorAll('select');
  if (sel) sel.value = cell.coin;
  if (iv) iv.value = cell.interval;
  if (rg) rg.value = cell.range;
}

// 重建网格 DOM：复用每个 cell 已有的 iframe（不重载），只重排格子与顶栏。
function rebuildGrid() {
  if (!grid) return;
  grid.dataset.count = String(cells.length);
  grid.textContent = '';
  cells.forEach((cell, i) => {
    grid.appendChild(buildCell(cell, i));
    postTheme(cell);
    // 状态色按上次面板推来的结果复原（拖动换位/增删格子后不必等面板再报一次）。
    applyCellTone(i, cell.tone);
  });
  updateAddBtn();
  refreshVoicePanel();
}

/* 板块状态色（v2.12.18）：面板自己算好「做多/涨 → long（绿）、做空/跌 → short（红）」
   再推过来（它才掌握信号与涨跌），外壳只负责把类挂到格子外框上。 */
function applyCellTone(index, tone) {
  const cell = cells[index];
  if (cell) cell.tone = tone || '';
  const el = grid && grid.children[index];
  if (!el) return;
  el.classList.toggle('is-long', tone === 'long');
  el.classList.toggle('is-short', tone === 'short');
}

let addBtn = null;
function updateAddBtn() {
  if (!addBtn) return;
  const none = unusedCoins(cells).length === 0;
  addBtn.disabled = none || cells.length >= 4;
  addBtn.style.display = cells.length >= 4 ? 'none' : '';
}

// ══ 语音播报：顶部只留一颗「播报设置」按钮，点开是一个设置面板 ══════════════
// v2.12.17：原先顶栏那排「🔊 + 各币 chip + 全部播报」换成一颗按钮。面板里放三件事：
//   ① 总开关 —— 与不分屏页面共用同一个「语音总开关」（同一份设置，关掉两边都停）；
//   ② 播报顺序（按币种）—— 拖动排序，多币种同时触发时按此顺序依次播报；
//   ③ 语音引擎 —— 引擎 / 音色 / 音量，就是主站那一套控件（改这里两边一起变）。
// 发声一律交给主站语音引擎（window.btcVoiceEngine）：各面板把「自己币种的最新价」喂进去，
// 引擎用【该币种自己的语音规则】判定、用【主站同一个引擎】发声 —— 与不分屏页面一致。
/* ⚠️ 参与播报的选择存 **sessionStorage**（本标签页本会话有效），**不写 localStorage**：
   持久状态只能由主站的「语音总开关」决定。v2.12.22 之前用的是 localStorage，于是旧版
   留下的「某币种＝关」记录会一直压住总开关 —— 症状是「主站里播报明明开着、分屏格子却
   永远静音，连刷新都没用」（用户报过）。改成会话级后这种残留不可能再现。
   面板 iframe 与外壳同源，共享同一份 sessionStorage，所以两边读的是同一个 map。 */
function readVoiceMap() { try { return JSON.parse(sessionStorage.getItem(VOICE_MAP_KEY)) || {}; } catch { return {}; } }
function writeVoiceMap(m) { try { sessionStorage.setItem(VOICE_MAP_KEY, JSON.stringify(m)); } catch {} }
function readVoicePriority() { try { const a = JSON.parse(localStorage.getItem(VOICE_PRIORITY_KEY)); return Array.isArray(a) ? a : []; } catch { return []; } }
function writeVoicePriority(a) { try { localStorage.setItem(VOICE_PRIORITY_KEY, JSON.stringify(a)); } catch {} }

// 总开关 = 主站「语音总开关」（#voiceAlertEnabled）本身，不另存一份，避免两处状态打架。
function voiceMasterOn() {
  const box = document.getElementById('voiceAlertEnabled');
  return !!(box && box.checked);
}
function voiceEngineApi() { return window.btcVoiceEngine || null; }
/* 该币种是否参与播报（面板里点亮的圆点）。
   v2.12.20 起：**没单独设置过的币种默认跟随主站「语音总开关」** —— 非分屏模式下播报
   开着，分屏这边就默认一起播（此前默认关，于是主站明明开着、分屏四个格子的喇叭却全是
   静音态，也不往引擎喂价）。在分屏面板里手动点过圆点的币种，以那次点击为准。 */
function coinVoiceOn(coin) {
  const m = readVoiceMap();
  return coin in m ? !!m[coin] : voiceMasterOn();
}
// 真正会不会出声：总开关 × 该币种开关。
function coinVoiceEffective(coin) { return voiceMasterOn() && coinVoiceOn(coin); }

// 顶栏那颗按钮（原来的一整排控件收进它开出来的面板里）。
function buildVoiceButton() {
  voiceBtn = document.createElement('button');
  voiceBtn.type = 'button';
  voiceBtn.id = 'splitVoiceBtn';
  voiceBtn.className = 'topbar-btn split-voice-open';
  voiceBtn.textContent = '🔊 ' + tx('播报设置', 'Voice settings');
  voiceBtn.title = tx(
    '语音播报设置：总开关 · 按币种的播报顺序 · 语音引擎（与不分屏页面同一套）',
    'Voice settings: master switch · per-coin order · engine (same as the main page)',
  );
  voiceBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openVoicePanel();
  });
  return voiceBtn;
}

/* 面板与「全部播报」都按这个顺序列出【当前分屏里的所有币种】。顺序单独持久化。 */
function voiceCoinsInPriority() {
  const coins = cells.map((c) => c.coin);
  const saved = readVoicePriority().filter((c) => coins.includes(c));
  const order = saved.concat(coins.filter((c) => !saved.includes(c)));
  writeVoicePriority(order);
  return order;
}

// 已开启播报、且仍在分屏里的币种（按顺序）——「全部播报」按此顺序依次触发。
function activeVoiceCoins() {
  return voiceCoinsInPriority().filter((c) => coinVoiceOn(c));
}

/* 币种顺序 → 播报排队档位：越靠前越小（越先播）。乘 1e6 让它压过「规则优先级」那一档，
   于是「多个币种同时命中」时严格按面板里排的顺序走。 */
function voiceRankBase(coin) {
  const index = voiceCoinsInPriority().indexOf(coin);
  return (index < 0 ? 99 : index) * 1e6;
}

// 切换某个币是否参与播报：写 localStorage（外壳与面板 iframe 同源共享）+ 通知对应面板图标。
/* ⚠️ 取反要基于**当前有效值**（`coinVoiceOn`）而不是 `!m[coin]`：默认跟随总开关时
   map 里根本没有这个键，`!undefined === true` 会让「点一下关闭」变成「写 true，还是开着」。 */
function toggleCoinVoice(coin) {
  const m = readVoiceMap();
  m[coin] = !coinVoiceOn(coin);
  writeVoiceMap(m);
  pushPaneVoiceState(coin);
  renderVoiceCoinList();
  updateVoicePanelStatus();
}

/* ══ 播报设置面板 ═══════════════════════════════════════════════════════════
   面板本身是挂在 body 上的（不放进覆盖层，z-index 抬到 9999 之上），打开时：
     · 总开关   —— 直接读写主站 #voiceAlertEnabled（同一个开关，非分屏页面同步变化）；
     · 顺序列表 —— 当前分屏的币种，拖动排序（写 VOICE_PRIORITY_KEY）+ 圆点点亮参与播报；
     · 语音引擎 —— 直接镜像主站的引擎 / 音色 / 音量控件，改这里两边一起变。
   引擎控件刻意用「镜像主站控件」而不是另存一份设置：主站的 change 处理里还带着
   保存、状态行刷新、音频上下文预热等副作用，只有让它自己跑才不会漏。 */
let voiceModal = null, voiceCoinList = null, voiceStatusEl = null;
const voiceSpeakingCoins = new Set();

function buildVoiceModal() {
  voiceModal = document.createElement('div');
  voiceModal.id = 'splitVoiceModal';
  voiceModal.className = 'alert-composer voice-settings-modal split-voice-settings';
  voiceModal.hidden = true;
  voiceModal.innerHTML =
    '<section role="dialog" aria-modal="true" aria-labelledby="splitVoiceTitle">' +
    '<header><b id="splitVoiceTitle">' + tx('语音播报设置', 'Voice settings') +
    '</b><span class="voice-settings-coin">' + tx('多分屏', 'Multi-split') +
    '</span><button type="button" aria-label="' + tx('关闭', 'Close') + '" data-close-split-voice>×</button></header>' +
    '<div class="voice-settings-body">' +
    '<div class="voice-panel-toggles split-voice-master">' +
    '<label class="voice-switch"><input id="splitVoiceMaster" type="checkbox"><span>' +
    tx('语音总开关', 'Voice master') + '</span></label>' +
    '<small class="split-voice-note">' +
    tx('与不分屏页面的「语音总开关」是同一个开关：关掉后分屏与主页面都停止播报。',
       'The same master switch as the main page: turning it off stops both.') +
    '</small><small class="split-voice-status" id="splitVoiceStatus"></small>' +
    '</div>' +
    '<section class="voice-priority-panel split-voice-priority">' +
    '<b>' + tx('播报顺序（按币种）', 'Broadcast order (by coin)') + '</b>' +
    '<small>' + tx(
      '按住条目上下拖动即可调整顺序；多个币种同时触发时按此顺序从上到下依次播报，越靠上越优先。左侧圆点亮的币种才参与播报 —— 圆点是<b>本会话</b>的临时静音，重开总开关会全部恢复。',
      'Drag entries to reorder; when several coins fire together they play top to bottom. Only coins with a lit dot broadcast — a dot is a per-session mute; toggling the master switch back on restores all.',
    ) + '</small>' +
    '<ol class="voice-priority-list" id="splitVoiceCoinList"></ol>' +
    '</section>' +
    '<section class="split-voice-section">' +
    '<b>' + tx('语音引擎', 'Voice engine') + '</b>' +
    '<small>' + tx(
      '与不分屏页面共用同一套引擎 / 音色 / 音量设置，这里改动会同步到主页面（反之亦然）。',
      'Shares the engine / voice / volume settings with the main page — changes here apply there too.',
    ) + '</small>' +
    '<div class="split-voice-engine">' +
    '<label>' + tx('播报引擎', 'Engine') + '<select id="splitVoiceEngineSel"></select></label>' +
    '<label>' + tx('音色', 'Voice') + '<select id="splitVoiceVoiceSel"></select></label>' +
    '<label><span class="voice-volume-head">' + tx('语音音量', 'Speech volume') +
    '<output id="splitVoiceSpeechVolumeValue"></output></span>' +
    '<input id="splitVoiceSpeechVolume" type="range" min="0" max="100" step="1"></label>' +
    '<label><span class="voice-volume-head">' + tx('提示音音量', 'Chime volume') +
    '<output id="splitVoiceChimeVolumeValue"></output></span>' +
    '<input id="splitVoiceChimeVolume" type="range" min="0" max="200" step="1"></label>' +
    '</div></section>' +
    '<div class="split-voice-actions">' +
    '<button type="button" id="splitVoiceFollowAll">' +
    tx('全部跟随总开关', 'Follow master for all') + '</button>' +
    '<button type="button" id="splitVoiceBroadcastAll">' +
    tx('全部播报（按顺序试听）', 'Broadcast all (in order)') + '</button>' +
    '<small>' + tx(
      '「全部跟随总开关」＝把每个币种都恢复成跟随主站总开关（主站开着就都播）；「全部播报」＝按上面的顺序把已点亮币种的实时价依次念一遍。',
      '“Follow master for all” restores every coin to follow the master switch; “Broadcast all” speaks each enabled coin’s live price in the order above.',
    ) + '</small></div>' +
    '</div></section>';
  document.body.append(voiceModal);
  voiceCoinList = voiceModal.querySelector('#splitVoiceCoinList');
  voiceStatusEl = voiceModal.querySelector('#splitVoiceStatus');
  voiceModal.querySelector('[data-close-split-voice]').addEventListener('click', closeVoicePanel);
  voiceModal.addEventListener('click', (e) => {
    // 点遮罩关掉面板；点面板内部不关（stopPropagation 由内层容器兜住）。
    if (e.target === voiceModal) closeVoicePanel();
  });
  voiceModal.querySelector('section').addEventListener('click', (e) => e.stopPropagation());
  // 总开关：写回主站那个开关并让它自己跑 change（保存 / 状态行 / 音频预热都在那边）。
  const master = voiceModal.querySelector('#splitVoiceMaster');
  master.addEventListener('change', () => {
    const box = document.getElementById('voiceAlertEnabled');
    if (box) {
      box.checked = master.checked;
      box.dispatchEvent(new Event('change', { bubbles: true }));
    }
    pushAllPaneVoiceStates();
    updateVoicePanelStatus();
  });
  bindEngineMirrors();
  /* 面板开着时，主站那几个「音色相关」控件一变就重新镜像一次 —— 分屏面板显示的必须
     永远等于主站（比特币）那一套。用事件委托而不是绑控件本身：主站语音浮层重建会掉监听。
     分屏面板自己写回主站时也会走到这里，但那时两边的值已经相同，重镜像没有副作用
     （程序化赋值不触发 change）。 */
  document.addEventListener('change', (e) => {
    const id = e.target && e.target.id;
    if (!id || !voiceModal || voiceModal.hidden) return;
    if (id === 'voiceAlertEngine' || id === 'voiceAlertEdgeVoice' ||
        id === 'voiceAlertVoice' || id === 'voiceGenderFilter')
      syncVoicePanelFromMain();
  });
  // 「全部跟随总开关」：清掉本会话里对所有币种的单独静音，回到「总开关开着就都播」。
  voiceModal.querySelector('#splitVoiceFollowAll').addEventListener('click', () => {
    writeVoiceMap({});
    renderVoiceCoinList();
    pushAllPaneVoiceStates();
    updateVoicePanelStatus(
      voiceMasterOn()
        ? tx('已全部恢复为「跟随语音总开关」', 'All coins now follow the master switch')
        : tx('已全部恢复为「跟随总开关」，但总开关当前是关的，先把它打开', 'All coins follow the master switch — but the master switch is off; turn it on first'),
    );
  });
  voiceModal.querySelector('#splitVoiceBroadcastAll').addEventListener('click', () => {
    const { queued, total } = broadcastAllVoice();
    updateVoicePanelStatus(
      queued
        ? tx(`已按顺序依次播报 ${queued} 个币种`, `Broadcast ${queued} coins in order`)
        : total
          ? tx('还没拿到各面板的实时价，等一两秒再点一次', 'No prices yet — wait a second and try again')
          : tx('还没有币种参与播报，先点亮左侧圆点', 'No coin is enabled — tap a dot first'),
    );
  });
}

/* 引擎 / 音色 / 音量：把子面板的控件与主站同名控件双向绑定（子面板只做代理）。 */
function bindEngineMirrors() {
  const pairs = [
    ['splitVoiceEngineSel', 'voiceAlertEngine'],
    ['splitVoiceSpeechVolume', 'voiceSpeechVolume'],
    ['splitVoiceChimeVolume', 'voiceChimeVolume'],
  ];
  pairs.forEach(([mine, theirs]) => {
    const a = voiceModal.querySelector('#' + mine), b = document.getElementById(theirs);
    if (!a || !b) return;
    a.addEventListener('change', () => {
      b.value = a.value;
      b.dispatchEvent(new Event('change', { bubbles: true }));
      if (mine === 'splitVoiceEngineSel') syncVoicePanelFromMain();
    });
    a.addEventListener('input', () => {
      if (a.type !== 'range') return;
      b.value = a.value;
      b.dispatchEvent(new Event('input', { bubbles: true }));
    });
  });
  // 音色下拉：内容随主站引擎变化（云语音看 Azure 列表 / 系统语音看本机音色）。
  const voiceSel = voiceModal.querySelector('#splitVoiceVoiceSel');
  voiceSel.addEventListener('change', () => {
    const target = document.getElementById(currentVoiceSelectId());
    if (!target) return;
    target.value = voiceSel.value;
    target.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
function currentVoiceSelectId() {
  const engine = document.getElementById('voiceAlertEngine');
  return engine && engine.value === 'system' ? 'voiceAlertVoice' : 'voiceAlertEdgeVoice';
}

/* 打开面板时把主站那份设置镜像过来（面板开着时主站那个浮层不会同时开着，所以一次性同步足够）。 */
function syncVoicePanelFromMain() {
  if (!voiceModal) return;
  /* ⚠️ 整份搬过来（含 hidden / disabled 状态），**不要**按 hidden 过滤。
     旧写法跳过 hidden 的选项，于是主站当前选中的音色恰好被隐去时
     （「音色筛选」选了男声/女声，或 HD / MAI 这类本地区不支持的代次被整批隐藏 ——
     服务端日志里那些 `Azure Speech HTTP 400` 就是用户选过这类音色留下的），
     `mine.value = theirs.value` 就设不上，紧接着回落到 `selectedIndex = 0`。
     结果：分屏面板显示成列表里第一条音色，跟主站（比特币）显示的不是同一个 ——
     这正是「其他币种语音播报系统里的音色跟比特币不一样」的由来（v2.12.25 修）。
     现在：hidden / disabled 一并搬过来（列表可见性与主站保持一致），
     并且**选中项绝不回落**——真对不上就把主站当前值补成一项。 */
  const copySelect = (mineId, theirsId) => {
    const mine = voiceModal.querySelector('#' + mineId), theirs = document.getElementById(theirsId);
    if (!mine || !theirs) return;
    mine.textContent = '';
    const cloneOption = (option) => {
      const clone = document.createElement('option');
      clone.value = option.value;
      clone.textContent = option.textContent;
      clone.hidden = !!option.hidden;
      clone.disabled = !!option.disabled;
      return clone;
    };
    [...theirs.children].forEach((node) => {
      if (node.tagName === 'OPTGROUP') {
        const group = document.createElement('optgroup');
        group.label = node.label;
        group.hidden = !!node.hidden;
        [...node.children].forEach((option) => group.appendChild(cloneOption(option)));
        if (group.children.length) mine.appendChild(group);
      } else if (node.tagName === 'OPTION') {
        mine.appendChild(cloneOption(node));
      }
    });
    mine.value = theirs.value;
    /* 兜底：显示成「另一个音色」比留空更糟 —— 用户会以为分屏这边被人改过，
       甚至照着改下去，把主站（比特币）的音色也一起改掉。所以这里补一项，
       而不是退回第一条。 */
    if (mine.value !== theirs.value) {
      const current = theirs.options[theirs.selectedIndex];
      const extra = cloneOption(current || { value: theirs.value, textContent: theirs.value });
      extra.hidden = false;
      extra.disabled = false;
      mine.appendChild(extra);
      mine.value = theirs.value;
    }
  };
  const master = voiceModal.querySelector('#splitVoiceMaster');
  const masterBox = document.getElementById('voiceAlertEnabled');
  if (master) master.checked = !!(masterBox && masterBox.checked);
  copySelect('splitVoiceEngineSel', 'voiceAlertEngine');
  copySelect('splitVoiceVoiceSel', currentVoiceSelectId());
  [['splitVoiceSpeechVolume', 'voiceSpeechVolume', 'splitVoiceSpeechVolumeValue'],
   ['splitVoiceChimeVolume', 'voiceChimeVolume', 'splitVoiceChimeVolumeValue']].forEach(
    ([mineId, theirsId, outId]) => {
      const mine = voiceModal.querySelector('#' + mineId), theirs = document.getElementById(theirsId),
        out = voiceModal.querySelector('#' + outId);
      if (!mine || !theirs) return;
      mine.value = theirs.value;
      if (out) out.textContent = theirs.value + '%';
    },
  );
  // 滑条上的百分比跟着走（自绘滑条用得到 --voice-range-fill）。
  [['splitVoiceSpeechVolume', 'splitVoiceSpeechVolumeValue'],
   ['splitVoiceChimeVolume', 'splitVoiceChimeVolumeValue']].forEach(([mineId, outId]) => {
    const mine = voiceModal.querySelector('#' + mineId), out = voiceModal.querySelector('#' + outId);
    if (!mine || !out) return;
    const paint = () => {
      out.textContent = mine.value + '%';
      const pct = String((Number(mine.value) / Number(mine.max || 100)) * 100) + '%';
      mine.style.setProperty('--voice-range-fill', pct);
    };
    if (!mine.dataset.rangeBound) {
      mine.dataset.rangeBound = '1';
      mine.addEventListener('input', paint);
    }
    paint();
  });
}

/* 顺序列表：当前分屏的币种，拖动排序 + 圆点开关 + 规则入口。 */
function renderVoiceCoinList() {
  if (!voiceCoinList) return;
  const order = voiceCoinsInPriority();
  const api = voiceEngineApi();
  voiceCoinList.textContent = '';
  if (!order.length) {
    const hint = document.createElement('li');
    hint.className = 'split-voice-empty';
    hint.textContent = tx('当前分屏没有币种', 'No coins in this split view');
    voiceCoinList.appendChild(hint);
    return;
  }
  order.forEach((coin, index) => {
    const item = document.createElement('li');
    item.draggable = true;
    item.dataset.coin = coin;
    item.className = (coinVoiceOn(coin) ? 'is-on' : 'is-off') +
      (voiceSpeakingCoins.has(coin) ? ' speaking' : '');

    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'split-voice-dot-btn';
    dot.title = coinVoiceOn(coin)
      ? tx(`${coin}：参与播报（点一下关闭）`, `${coin}: broadcasting (click to turn off)`)
      : tx(`${coin}：不参与播报（点一下开启）`, `${coin}: not broadcasting (click to turn on)`);
    dot.setAttribute('aria-pressed', coinVoiceOn(coin) ? 'true' : 'false');
    dot.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleCoinVoice(coin);
    });

    const grip = document.createElement('span');
    grip.className = 'voice-priority-grip';
    grip.setAttribute('aria-hidden', 'true');
    grip.textContent = '⠿';

    const number = document.createElement('span');
    number.className = 'voice-priority-index';
    number.textContent = index + 1 + '.';

    const name = document.createElement('span');
    name.className = 'split-voice-coin-name';
    name.textContent = coin;

    /* 该币种配了几条语音规则 —— 0 条时只会在「定时播报实时价」开启后才出声，
       这里直接给个入口去配置，省得用户以为是坏的。 */
    const count = api && api.ruleCount ? api.ruleCount(coin) : 0;
    const rules = document.createElement('button');
    rules.type = 'button';
    rules.className = 'split-voice-rules';
    rules.textContent = count
      ? tx(`${count} 条规则`, `${count} rules`)
      : tx('配置规则', 'Set up rules');
    rules.title = tx(
      `打开 ${coin} 的语音规则设置（与不分屏页面同一套规则）`,
      `Open ${coin} voice rules (same as the main page)`,
    );
    rules.addEventListener('click', (e) => {
      e.stopPropagation();
      closeVoicePanel();
      openMainVoiceSettings(coin);
    });

    item.append(dot, grip, number, name, rules);
    bindCoinDrag(item, coin);
    voiceCoinList.appendChild(item);
  });
}

// 拖动排序：实时把被拖项插到目标前后（主站播报优先级列表同款交互），松手落库。
/* ⚠️ 正在拖的币种必须是**共享**变量：dragstart 挂在源条目上、dragover 挂在目标条目上，
   每个条目各持一份局部变量的话，目标那侧读到的永远是 null，拖了等于没拖。 */
let voiceDragCoin = null;
function bindCoinDrag(item, coin) {
  item.addEventListener('dragstart', (e) => {
    voiceDragCoin = coin;
    item.classList.add('is-dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', coin); } catch {}
  });
  item.addEventListener('dragend', () => {
    item.classList.remove('is-dragging');
    voiceCoinList.querySelectorAll('li').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
    const order = [...voiceCoinList.querySelectorAll('li')]
      .map((el) => el.dataset.coin)
      .filter(Boolean);
    if (order.length) writeVoicePriority(order);
    voiceDragCoin = null;
    renderVoiceCoinList();
    syncSplitVoiceScope();
  });
  item.addEventListener('dragover', (e) => {
    if (!voiceDragCoin || voiceDragCoin === coin) return;
    e.preventDefault();
    const rect = item.getBoundingClientRect(),
      before = e.clientY < rect.top + rect.height / 2,
      dragged = voiceCoinList.querySelector(`li[data-coin="${voiceDragCoin}"]`);
    if (!dragged) return;
    if (before) voiceCoinList.insertBefore(dragged, item);
    else voiceCoinList.insertBefore(dragged, item.nextElementSibling);
    // 序号即时刷新，让用户看到排到的名次。
    voiceCoinList.querySelectorAll('li').forEach((el, i) => {
      const idx = el.querySelector('.voice-priority-index');
      if (idx) idx.textContent = i + 1 + '.';
    });
  });
}

/* 状态行：平时显示总开关 / 参与币种数；点「全部播报」后临时换成结果，6 秒后自动回到常态。 */
let voiceStatusTimer = null;
function updateVoicePanelStatus(extra) {
  if (!voiceStatusEl) return;
  const order = voiceCoinsInPriority(),
    on = order.filter((coin) => coinVoiceOn(coin));
  const master = voiceMasterOn();
  let text = master
    ? tx(`总开关已开 · 参与播报 ${on.length}/${order.length} 个币种`,
         `Master on · ${on.length}/${order.length} coins broadcasting`)
    : tx('总开关已关：下面所有币种都不会出声', 'Master off: nothing will be spoken');
  if (master && on.length === 0)
    text = tx('总开关已开，但还没有币种被点亮 —— 点左侧圆点选币种', 'Master on, but no coin is lit — tap a dot to pick coins');
  else if (
    master &&
    !voiceLivePriceEnabled() &&
    on.length > 0 &&
    on.every((c) => (voiceEngineApi()?.ruleCount?.(c) || 0) === 0)
  )
    text += tx('（这些币种既没有语音规则，也没开定时播报实时价）', ' (no rules and timed live price is off)');
  voiceStatusEl.textContent = extra || text;
  clearTimeout(voiceStatusTimer);
  if (extra) voiceStatusTimer = setTimeout(() => updateVoicePanelStatus(), 6000);
}
function voiceLivePriceEnabled() {
  const box = document.getElementById('voiceLivePriceEnabled');
  return !!(box && box.checked);
}

function openVoicePanel() {
  if (!voiceModal) buildVoiceModal();
  // 面板不在覆盖层里，主题要自己带上（--sp-* 变量按主题各定义一份）。
  voiceModal.dataset.theme = currentTheme();
  syncVoicePanelFromMain();
  renderVoiceCoinList();
  updateVoicePanelStatus();
  voiceModal.hidden = false;
  document.body.classList.add('split-voice-open');
}
function closeVoicePanel() {
  if (!voiceModal) return;
  voiceModal.hidden = true;
  document.body.classList.remove('split-voice-open');
}

/* 面板没打开时也要能重建（币种增删 / 主站设置变化时调用）。 */
function refreshVoicePanel() {
  syncSplitVoiceScope();
  pushAllPaneVoiceStates();
  if (voiceModal && !voiceModal.hidden) {
    syncVoicePanelFromMain();
    renderVoiceCoinList();
    updateVoicePanelStatus();
  }
}

/* 分屏开着哪几个币种告诉主站引擎：这些币种的主站循环让位，改由分屏按面板喂价判定。 */
function syncSplitVoiceScope() {
  const api = voiceEngineApi();
  if (api && api.setSplitCoins) api.setSplitCoins(overlayOpen ? cells.map((c) => c.coin) : []);
}

/* 面板喇叭的开关态 = 总开关 × 该币种开关；总开关一变就把所有面板刷新一遍。 */
function pushPaneVoiceState(coin) {
  const cell = cells.find((c) => c.coin === coin);
  if (!cell || !cell.frame || !cell.frame.contentWindow) return;
  cell.frame.contentWindow.postMessage(
    { type: 'split:voice', on: coinVoiceEffective(coin) },
    location.origin,
  );
}
function pushAllPaneVoiceStates() {
  cells.forEach((cell) => pushPaneVoiceState(cell.coin));
}

/* 面板把各自币种的最新价喂进主站引擎（规则判定 + 播报都在主站那一套里做）。 */
function feedVoicePrice(coin, price) {
  const api = voiceEngineApi();
  if (!api || !api.feedPrice || !overlayOpen) return;
  if (!coinVoiceOn(coin)) return;
  api.feedPrice(coin, price, voiceRankBase(coin));
}

/* 「全部播报」：按面板里的顺序，把已点亮币种的实时价依次念一遍（引擎自己排队）。
   返回真正排上队的条数 —— 一条都没有时面板要给出「还没拿到价格」的提示。 */
function broadcastAllVoice() {
  const api = voiceEngineApi();
  const coins = activeVoiceCoins();
  syncSplitVoiceScope();
  if (!api || !api.speakLive) return { queued: 0, total: coins.length };
  let queued = 0;
  coins.forEach((coin) => {
    if (api.speakLive(coin, undefined, { force: true, rankBase: voiceRankBase(coin) })) queued += 1;
  });
  pushAllPaneVoiceStates();
  return { queued, total: coins.length };
}

/* 分屏面板右上角的喇叭 =「普通模式（非分屏）下该币种播报按钮」的软链接：
   调主站 app.js 暴露的 window.btcVoiceSettings.open(coin) —— 打开的就是那套「语音播报设置」，
   并把主站币种临时切到该面板的币种（语音规则按币种隔离存储），关掉设置后自动还原。
   app.js 的语音模块是 setTimeout(…, 0) 才挂上接口的，第一次点得过早时延迟重试一次。 */
function openMainVoiceSettings(coin) {
  const api = window.btcVoiceSettings;
  if (api && typeof api.open === 'function') { api.open(coin); return; }
  setTimeout(() => {
    try { window.btcVoiceSettings?.open(coin); } catch {}
  }, 400);
}

/* 某个币种正在朗读（主站引擎发的 btc:voice-speaking）：面板行 + 对应面板喇叭一起闪。 */
function setCoinSpeaking(coin, speaking) {
  if (!coin) return;
  if (speaking) voiceSpeakingCoins.add(coin); else voiceSpeakingCoins.delete(coin);
  if (voiceCoinList) {
    const row = voiceCoinList.querySelector(`li[data-coin="${coin}"]`);
    if (row) row.classList.toggle('speaking', !!speaking);
  }
  const cell = cells.find((c) => c.coin === coin);
  if (cell && cell.frame && cell.frame.contentWindow) {
    cell.frame.contentWindow.postMessage({ type: 'split:voice-active', speaking: !!speaking }, location.origin);
  }
}

function setLayoutCount(n) {
  n = Math.max(2, Math.min(4, n));
  if (n === cells.length) return;
  if (n < cells.length) {
    for (const dead of cells.splice(n)) dead.frame && dead.frame.remove();
  } else {
    const free = unusedCoins(cells);
    const need = n - cells.length; // 先记下缺口：循环里 push 会改 cells.length
    for (let k = 0; k < need && k < free.length; k++) {
      cells.push(makeCell(free[k]));
    }
  }
  setCells(cells);
  rebuildGrid();
  if (overlayOpen && !tabHidden) broadcast('split:resume');
}

function makeCell(coin) {
  const frame = document.createElement('iframe');
  frame.className = 'split-frame';
  frame.setAttribute('title', `${coin} ${tx('面板', 'panel')}`);
  const cell = { coin, interval: '15m', range: '2D', frame };
  frame.src = frameSrc(cell, cells.length); // src 在 buildCell 时会按最终下标重设
  return cell;
}

function buildOverlay() {
  if (built) return;
  built = true;
  cells = getCells();

  overlay = document.createElement('div');
  overlay.id = 'splitOverlay';
  overlay.hidden = true;

  const top = document.createElement('div');
  top.className = 'split-topbar';
  // 顶栏拆两行，避免控件一多就挤压换行错位：
  //  第 1 行 = 标题 + 说明 + 弹性空隙 + 全屏 + 退出；
  //  第 2 行 = 布局分段 + 添加币种 + 播报设置按钮。
  const row1 = document.createElement('div');
  row1.className = 'split-topbar-row';
  const row2 = document.createElement('div');
  row2.className = 'split-topbar-row split-topbar-row-2';

  const title = document.createElement('span');
  title.className = 'split-title';
  title.textContent = '⊞ ' + tx('多分屏模式', 'Multi-split view');
  const sub = document.createElement('span');
  sub.className = 'split-sub';
  sub.textContent = tx('拖动顶栏换位 · ✕ 移除币种 · ⤢ 放大单看', 'Drag bars to swap · ✕ remove · ⤢ expand');
  const spacer1 = document.createElement('span');
  spacer1.className = 'split-topbar-spacer';
  row1.appendChild(title); row1.appendChild(sub); row1.appendChild(spacer1);

  // ⛶ 全屏：把整个多分屏覆盖层放进浏览器全屏（再点一次或 Esc 退出）。
  const fs = document.createElement('button');
  fs.type = 'button';
  fs.className = 'topbar-btn split-fullscreen';
  fs.textContent = '⛶ ' + tx('全屏', 'Fullscreen');
  fs.title = tx('多分屏全屏显示（Esc 退出）', 'Fullscreen the split view (Esc to exit)');
  fs.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleOverlayFullscreen();
  });
  document.addEventListener('fullscreenchange', () => {
    fs.textContent = document.fullscreenElement
      ? '⛶ ' + tx('退出全屏', 'Exit fullscreen')
      : '⛶ ' + tx('全屏', 'Fullscreen');
  });
  row1.appendChild(fs);

  const close = document.createElement('button');
  close.className = 'topbar-btn split-close';
  close.type = 'button';
  close.textContent = '✕ ' + tx('退出', 'Exit');
  close.addEventListener('click', (e) => { e.stopPropagation(); closeOverlay(); });
  row1.appendChild(close);

  // 布局分段：2 / 3 / 4。
  const layoutSeg = makeSegmented([
    { value: 2, label: '2 ' + tx('格', 'pans') },
    { value: 3, label: '3 ' + tx('格', 'pans') },
    { value: 4, label: '4 ' + tx('格', 'pans') },
  ], cells.length, (v) => setLayoutCount(v));
  layoutSeg.title = tx('同屏币种数', 'Number of coins on screen');
  row2.appendChild(layoutSeg);

  // ＋ 添加币种。
  addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'topbar-btn';
  addBtn.textContent = '＋ ' + tx('添加币种', 'Add coin');
  addBtn.title = tx('加入一个尚未显示的币种', 'Add a coin not yet shown');
  addBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const free = unusedCoins(cells);
    if (!free.length || cells.length >= 4) return;
    cells.push(makeCell(free[0]));
    setCells(cells);
    rebuildGrid();
    if (overlayOpen && !tabHidden) broadcast('split:resume');
  });
  row2.appendChild(addBtn);

  // 语音播报：一颗按钮 → 点开「播报设置」面板（总开关 / 按币种的顺序 / 引擎）。
  row2.appendChild(buildVoiceButton());

  top.appendChild(row1);
  top.appendChild(row2);

  grid = document.createElement('div');
  grid.className = 'split-grid';
  grid.id = 'splitGrid';
  for (const cell of cells) {
    if (!cell.frame) cell.frame = document.createElement('iframe');
    cell.frame.className = 'split-frame';
  }
  // 从存储恢复的 cell 没有 src，必须在这里统一赋值（makeCell 只覆盖新增格）。
  cells.forEach((cell, i) => { cell.frame.src = frameSrc(cell, i); });
  overlay.appendChild(top);
  overlay.appendChild(grid);
  rebuildGrid();

  document.body.appendChild(overlay);

  // 面板就绪后回发主题 / 模式 + 当前 resume/pause 状态（处理懒加载时序）。
  window.addEventListener('message', (e) => {
    const d = e.data || {};
    if (d.type === 'split:ready') {
      const i = Number(d.pane);
      const cell = cells[i];
      if (cell && cell.frame) {
        postTheme(cell);
        cell.frame.contentWindow.postMessage({ type: overlayOpen && !tabHidden ? 'split:resume' : 'split:pause' }, location.origin);
        /* 面板脚本就绪后再补推一次开关态：外壳先前那次推送可能早于 iframe 里的模块执行。 */
        pushPaneVoiceState(cell.coin);
      }
    } else if (d.type === 'split:expand') {
      const i = Number(d.pane);
      if (cells[i]) openDetail(cells[i].coin);
    } else if (d.type === 'split:voice-register') {
      refreshVoicePanel();
    } else if (d.type === 'split:voice-price') {
      /* 面板每次拿到新报价就喂一拍给主站引擎：规则判定与发声都在主站那一套里做。 */
      feedVoicePrice(d.coin, Number(d.price));
    } else if (d.type === 'split:tone') {
      /* 板块状态色：做多/涨 → 绿，做空/跌 → 红（面板算好推过来，见 applyCellTone）。 */
      applyCellTone(Number(d.pane), d.tone);
    } else if (d.type === 'split:voice-open') {
      // 面板右上角的喇叭：打开主站（普通模式）对应币种的语音播报设置。
      openMainVoiceSettings(d.coin);
    } else if (d.type === 'split:voice-speaking') {
      /* 主站引擎正在朗读某个币种：面板对应行 + 该面板喇叭一起闪「播报中」。 */
      setCoinSpeaking(d.coin, d.speaking);
    }
  });

  // 标签页隐藏 / 恢复：隐藏即暂停所有面板。
  document.addEventListener('visibilitychange', () => {
    tabHidden = document.hidden;
    broadcast(tabHidden ? 'split:pause' : overlayOpen ? 'split:resume' : 'split:pause');
  });

  // 主站主题变化时同步给面板。
  if (window.MutationObserver) {
    new MutationObserver(() => { if (overlayOpen) for (const c of cells) postTheme(c); })
      .observe(document.documentElement, { attributes: true });
  }

  /* 主站语音引擎开始/结束朗读某个币种（分屏喂价触发的规则播报）→ 面板行与面板喇叭闪烁。
     引擎与分屏在同一份文档里，所以这里直接听 window 事件即可。 */
  window.addEventListener('btc:voice-speaking', (e) => {
    const d = e.detail || {};
    if (d.coin) setCoinSpeaking(d.coin, d.speaking);
  });

  /* 主站「语音总开关」一变（在主站设置浮层里切、或在分屏面板的镜像开关上切），
     分屏这边要立刻跟上：各面板喇叭图标、圆点行、状态行、以及喂价范围都取决于它
     ——「没单独设置过的币种默认跟随总开关」这条规则的另外半边就在这里。
     用 document 上的委托而不是直接绑那颗 checkbox：主站浮层重建 checkbox 也不会掉监听。 */
  document.addEventListener('change', (e) => {
    if (!e.target || e.target.id !== 'voiceAlertEnabled') return;
    /* 总开关被重新打开 =「全都播」：顺手清掉本会话里单独关掉的币种，免得出现
       「总开关明明开着、某个格子却还是静音」这种让人找不到原因的中间状态。 */
    if (e.target.checked) writeVoiceMap({});
    pushAllPaneVoiceStates();
    renderVoiceCoinList();
    updateVoicePanelStatus();
    syncSplitVoiceScope();
  }, true);
}

function openOverlay() {
  buildOverlay();  overlay.dataset.theme = currentTheme();
  overlay.hidden = false;
  overlayOpen = true;
  // 主站的语音播报设置浮层要能压在覆盖层之上（z-index 由 split.css 按此 class 提升）。
  document.body.classList.add('split-open');
  for (const c of cells) { postTheme(c); c.frame.contentWindow && c.frame.contentWindow.postMessage({ type: 'split:resume' }, location.origin); }
  /* 分屏接管屏上这些币种的语音：登记给主站引擎（主站自己的循环对这些币种让位），
     并把「总开关 × 该币种开关」的当前状态推给各面板喇叭图标。 */
  syncSplitVoiceScope();
  pushAllPaneVoiceStates();
}
/* 全屏：复用主站那一套（`window.btcFullscreen.toggle`）—— 全屏的是整个文档，而分屏
   覆盖层本身就是全屏 fixed 层，所以视觉效果就是「只看到分屏」；主站那边的 `.is-fullscreen`
   处理（隐藏页头）与按钮同步也一并跟着走。
   ⚠️ v2.12.20 之前这个方法**只有调用、没有定义** → 点「全屏」直接抛
   `ReferenceError: toggleOverlayFullscreen is not defined`，静默无效（用户报「全屏按钮没用」）。
   主站接口没就绪时退回自己直接请求（带老版 webkit 前缀）。 */
function toggleOverlayFullscreen() {
  const api = window.btcFullscreen;
  if (api && typeof api.toggle === 'function') { api.toggle(); return; }
  const active = document.fullscreenElement || document.webkitFullscreenElement;
  try {
    if (active) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) exit.call(document);
    } else {
      const el = overlay || document.documentElement;
      const enter = el.requestFullscreen || el.webkitRequestFullscreen;
      if (enter) enter.call(el);
    }
  } catch {}
}

function closeOverlay() {
  if (detail) closeDetail();
  if (!overlay) return;
  overlay.hidden = true;
  overlayOpen = false;
  document.body.classList.remove('split-open');
  closeVoicePanel();
  // 交还语音：主站循环重新接管，各面板喇叭回到静音态（分屏关了就不再播报）。
  syncSplitVoiceScope();
  cells.forEach((c) => {
    if (c.frame && c.frame.contentWindow)
      c.frame.contentWindow.postMessage({ type: 'split:voice', on: false }, location.origin);
  });
  broadcast('split:pause');
}

/* ── 放大单看：首页同款详细浮层 ─────────────────────────────────────────────
 * fetch 首页 HTML → 摘掉 notification.js / cloud-alerts.js / split-mode.js，
 * 注入 stub（静音 speechSynthesis 朗读、Audio/AudioContext 音效、禁用 Notification）
 * 后 document.write 进 iframe。加载完成后用 btcCoinContext 切到目标币种；
 * 关闭时恢复 localStorage 币种键，主页面持久化状态不受影响。 */
const DETAIL_W = 1440, DETAIL_H = 900;

function sanitizeHomeHtml(html, coin) {
  let out = html;
  out = out.replace(/<script[^>]*src="\/notification\.js[^"]*"[^>]*><\/script>/i, '');
  out = out.replace(/<script[^>]*src="\/cloud-alerts\.js[^"]*"[^>]*><\/script>/i, '');
  out = out.replace(/<script[^>]*src="\/split-mode\.js[^"]*"[^>]*><\/script>/i, '');
  // stub：静音朗读与音效，禁用桌面通知（都只在本浮层 iframe 内生效）。
  const stub = `<script>(function(){
    try {
      var noop = new Proxy(function(){}, { get: function(t,k){ return k === Symbol.toPrimitive ? function(){ return 0; } : noop; }, apply: function(){ return noop; } });
      Object.defineProperty(window, 'speechSynthesis', { get: function(){ return { speak:function(){}, cancel:function(){}, pause:function(){}, resume:function(){}, getVoices:function(){return [];}, speaking:false, pending:false, paused:false, addEventListener:function(){}, onvoiceschanged:null }; }, configurable: true });
      window.Audio = function(src){ this.src = src || ''; this.volume = 0; this.loop = false; this.currentTime = 0; this.play = function(){ return Promise.resolve(); }; this.pause = function(){}; this.cloneNode = function(){ return this; }; this.addEventListener = function(){}; this.removeAttribute = function(){}; };
      window.AudioContext = window.webkitAudioContext = function(){ return noop; };
      window.Notification = function(title, opts){ this.close = function(){}; };
      window.Notification.permission = 'denied';
      window.Notification.requestPermission = function(){ return Promise.resolve('denied'); };
      /* 语音端点也拦掉：本浮层里的 app.js 仍会跑自己那套语音规则，若放它去 /api/voice/*
         会白白让服务器合成一遍、还可能和分屏外壳里的同一币种各念一次。静音就该真的静音。 */
      var _f = window.fetch;
      window.fetch = function(u){
        try {
          var s = typeof u === 'string' ? u : (u && u.url) || '';
          if (s.indexOf('/api/voice/') >= 0) return Promise.resolve(new Response('', { status: 200, headers: { 'content-type': 'application/json' } }));
        } catch (e) {}
        return _f.apply(this, arguments);
      };
    } catch (e) {}
  })();</script>`;
  // 注到第一个 <script> 之前，保证先于其它脚本执行。
  const head = out.indexOf('<script');
  out = head >= 0 ? out.slice(0, head) + stub + out.slice(head) : stub + out;
  return out;
}

function openDetail(coin) {
  if (detail) { // 已开着就只切币种。
    switchDetailCoin(coin);
    return;
  }
  const root = document.createElement('div');
  root.id = 'splitDetailModal';
  root.dataset.theme = currentTheme();
  const head = document.createElement('div');
  head.className = 'split-detail-head';
  const t = document.createElement('span');
  t.className = 'split-detail-title';
  t.textContent = `${coin} / USDT · ` + tx('详细视图（首页同款 · 本浮层已静音推送/语音）', 'Detail view (homepage · alerts muted)');
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'topbar-btn';
  x.textContent = '✕ ' + tx('收起', 'Close');
  x.addEventListener('click', (e) => { e.stopPropagation(); closeDetail(); });
  head.appendChild(t); head.appendChild(x);
  const stage = document.createElement('div');
  stage.className = 'split-detail-stage';
  const frame = document.createElement('iframe');
  frame.className = 'split-detail-frame';
  frame.setAttribute('title', `${coin} ${tx('详细视图', 'detail view')}`);
  stage.appendChild(frame);
  root.appendChild(head);
  root.appendChild(stage);
  overlay.appendChild(root);

  // 记录并覆盖币种持久化键（app.js 从 localStorage 读初始币种）。
  const MODE_KEY = 'btc_coin_mode_v1', SYM_KEY = 'btc_coin_symbol_v1';
  const saved = { mode: localStorage.getItem(MODE_KEY), symbol: localStorage.getItem(SYM_KEY) };
  detail = { root, frame, coin, stage, saved, modeKey: MODE_KEY, symKey: SYM_KEY };

  fetch('/', { cache: 'no-store' })
    .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
    .then((html) => {
      if (!detail || detail.frame !== frame) return;
      const doc = frame.contentDocument;
      doc.open();
      doc.write(sanitizeHomeHtml(html, coin));
      doc.close();
      // 加载完成后切币种：app.js 暴露 window.btcCoinContext.setCoin。
      let tries = 0;
      const timer = setInterval(() => {
        tries++;
        const w = frame.contentWindow;
        if (!detail || detail.frame !== frame) { clearInterval(timer); return; }
        if (w && w.btcCoinContext && typeof w.btcCoinContext.setCoin === 'function') {
          clearInterval(timer);
          try {
            if (w.btcCoinContext.mode && w.btcCoinContext.mode() !== 'multi') w.btcCoinContext.setMode('multi');
            w.btcCoinContext.setCoin(coin);
          } catch (err) { /* 切币失败也只是显示默认币 */ }
        } else if (tries > 150) { // ~15s 放弃
          clearInterval(timer);
        }
      }, 100);
    })
    .catch(() => {
      // 兜底：直接整页加载首页（可能双跑推送，但仅浮层打开期间）。
      if (detail && detail.frame === frame) frame.src = '/index.html';
    });

  root.addEventListener('click', (e) => {
    if (e.target === root) closeDetail(); // 点背板收起
  });
  fitDetail();
}

function switchDetailCoin(coin) {
  if (!detail) return;
  detail.coin = coin;
  const t = detail.root.querySelector('.split-detail-title');
  if (t) t.textContent = `${coin} / USDT · ` + tx('详细视图（首页同款 · 本浮层已静音推送/语音）', 'Detail view (homepage · alerts muted)');
  const w = detail.frame.contentWindow;
  if (w && w.btcCoinContext && typeof w.btcCoinContext.setCoin === 'function') {
    try {
      if (w.btcCoinContext.mode && w.btcCoinContext.mode() !== 'multi') w.btcCoinContext.setMode('multi');
      w.btcCoinContext.setCoin(coin);
    } catch {}
  }
}

function fitDetail() {
  if (!detail) return;
  // 铺满舞台：缩放比以「高度塞进 900 逻辑高」为上限（封顶 0.9，保持精致感），
  // 逻辑宽高按舞台实际尺寸反算，避免定宽导致的右侧留黑。
  const sw = detail.stage.clientWidth, sh = detail.stage.clientHeight;
  if (!sw || !sh) return;
  const s = Math.min(sh / DETAIL_H, 0.9);
  detail.frame.style.width = Math.round(sw / s) + 'px';
  detail.frame.style.height = Math.round(sh / s) + 'px';
  detail.frame.style.transform = 'scale(' + s + ')';
}

function closeDetail() {
  if (!detail) return;
  // 恢复币种持久化键，保证主页面下次刷新仍是用户原来的币种/模式。
  try {
    if (detail.saved.mode == null) localStorage.removeItem(detail.modeKey);
    else localStorage.setItem(detail.modeKey, detail.saved.mode);
    if (detail.saved.symbol == null) localStorage.removeItem(detail.symKey);
    else localStorage.setItem(detail.symKey, detail.saved.symbol);
  } catch {}
  detail.root.remove();
  detail = null;
}

window.addEventListener('resize', () => fitDetail());

function injectButton() {
  const controls = document.querySelector('main>header .controls');
  if (!controls || document.getElementById('splitModeBtn')) return;
  const btn = document.createElement('button');
  btn.id = 'splitModeBtn';
  btn.className = 'topbar-btn';
  btn.type = 'button';
  btn.textContent = '⊞ ' + tx('多分屏', 'Split');
  btn.title = tx('开启多分屏模式（2~4 个币种同屏）', 'Open multi-split view (2-4 coins)');
  btn.addEventListener('click', (e) => { e.stopPropagation(); openOverlay(); });
  // v2.12.24：固定排在顶栏最左（「₿ 比特币 / 多币种」切换组之前），原先 appendChild 落在最右。
  // 币种切换组由 app.js 末尾的 IIFE 注入并坚持自己「排第一」，那边已改成以本按钮为锚，
  // 两边都只在位置不对时才动 DOM，因此 MutationObserver 能收敛。
  controls.insertBefore(btn, controls.firstElementChild);
}

function init() {
  if (window.top !== window) return; // 本脚本若被嵌进浮层首页，不注入任何东西
  injectButton();
  // 顶栏可能稍后由其它脚本（coin-mode 注入器）重排，做一次兜底补挂。
  if (!document.getElementById('splitModeBtn')) requestAnimationFrame(injectButton);
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (detail) closeDetail();
    else if (overlayOpen) closeOverlay();
  });
}
init();
