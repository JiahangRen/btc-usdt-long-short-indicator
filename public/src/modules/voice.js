// (h) 语音功能模块 —— 浏览器原生 TTS，完全本地，不上传任何音频。
// 职责：把某个币种的最新价喂进来，按【该币种自己的规则】判定并排队播报。
//   · 主站自身：每 1s 取 state.ticker.last（当前币种）；
//   · 分屏（多币种并行监控）：每个面板把各自币种价格经 window.btcVoiceEngine.feedPrice 喂入。
// 运行态（上一拍价 / 61 秒价格历史）按币种各存一份，跨币种互不干扰；播报本身共用主站引擎设置。
import {
  state, tx, normalizeCoin, activeCoin, coinLabel, coinPair, coinStorageSuffix,
  VOICE_LIST_POPULATE_DELAY_MS, money, pct, time, uiLang, $,
} from '../core.js?v=20260928a';

// 分屏当前接管播报的币种集合：这些币种的主站播报循环让位（由 window.btcVoiceEngine.setSplitCoins 写入）。
const splitHandledCoins = new Set();

export function initVoiceEngine() {
/* Browser speech uses the device's native voice and stays entirely local. */
setTimeout(() => {
  const priceCard = $("price")?.parentElement;
  if (!priceCard) return;
  const store = "btc_voice_quote_settings_v1";
  let settings = {
    enabled: false,
    livePriceEnabled: false,
    livePriceConcise: false,
    interval: 60,
    lastSpokenAt: 0,
    voiceURI: "",
    engine: "edge",
    edgeVoice: "zh-CN-XiaoxiaoNeural",
    chimeType: "station",
    riseChimeType: "rise",
    dropChimeType: "drop",
    liquidationChimeType: "warning",
    chimeVolume: 100,
    speechVolume: 100,
    /* 音色列表的性别筛选：all / male / female（只影响下拉里列出的音色，不改动当前音色）。 */
    voiceGenderFilter: "all",
  };
  try {
    settings = {
      ...settings,
      ...JSON.parse(localStorage.getItem(store) || "{}"),
    };
  } catch {}
  if (
    ![15, 30, 60, 300, 600, 900, 1800, 3600].includes(Number(settings.interval))
  )
    settings.interval = 300;
  if (!["all", "male", "female"].includes(settings.voiceGenderFilter))
    settings.voiceGenderFilter = "all";
  const supported =
    "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
  const voicePlaybackAvailable = supported || "Audio" in window;
  const save = () => localStorage.setItem(store, JSON.stringify(settings));
  /* 播报优先级：多条语音同时触发时按此顺序依次播报（设置面板可自定义排序）。 */
  const speechPriorityDefault = [
    "liquidation",
    "speed",
    "price",
    "move",
    "tick",
    "gap",
    "live",
  ];
  settings.speakPriority = Array.isArray(settings.speakPriority)
    ? [
        ...new Set(
          settings.speakPriority.filter((key) =>
            speechPriorityDefault.includes(key),
          ),
        ),
      ]
    : [];
  speechPriorityDefault.forEach((key) => {
    if (!settings.speakPriority.includes(key))
      settings.speakPriority.push(key);
  });
  const speechRankOfKey = (key) => {
      const index = settings.speakPriority.indexOf(key);
      return index < 0 ? speechPriorityDefault.length : index;
    },
    speechCategoryOfRule = (rule) =>
      rule?.kind === "long_liquidation" || rule?.kind === "short_liquidation"
        ? "liquidation"
        : rule?.kind === "price_speed"
          ? "speed"
          : rule?.kind === "price_move"
            ? "move"
            : rule?.kind === "price_tick_move"
              ? "tick"
              : rule?.kind === "theoretical_liquidation_gap"
                ? "gap"
                : "price",
    speechRankOfRule = (rule) => speechRankOfKey(speechCategoryOfRule(rule));
  const speechQueue = [];
  let speechQueueBusy = false;
  const drainSpeechQueue = () => {
      if (speechQueueBusy || !speechQueue.length) return;
      const item = speechQueue.shift();
      speechQueueBusy = true;
      const done = () => {
        speechQueueBusy = false;
        window.setTimeout(drainSpeechQueue, 300);
      };
      /* say 返回 false（总开关已关）时放弃整条队列，避免 busy 永久卡住。
         ⚠️ 队尾回调必须串起来：调用方给的 onEnded/onFailure（分屏靠它给面板打「播报中」
         动效）若被这里的 done 直接覆盖掉，就会「开始闪了但永远不灭」。 */
      const chained = (hook) => () => {
        try { hook?.(); } catch {}
        done();
      };
      if (!say(item.text, {
        ...item.options,
        onEnded: chained(item.options.onEnded),
        onFailure: chained(item.options.onFailure),
      })) {
        speechQueueBusy = false;
        speechQueue.length = 0;
      }
    },
    enqueueSpeech = (text, options = {}, rank = 0) => {
      speechQueue.push({ text, options, rank });
      speechQueue.sort((a, b) => a.rank - b.rank);
      drainSpeechQueue();
      return true;
    };
  let voices = [],
    audioContext = null,
    currentAudio = null,
    isSpeaking = false,
    /* 正在/最近一次播报的规则名：设置面板状态行据此显示「正在播报：xxx」。 */
    speakingLabel = null,
    speechSequence = 0,
    lastLiveSpokenPrice = null;
  let setSpeaking = () => {};
  const volume = (value) => {
    const normalized = Math.max(0, Math.min(1, Number(value) / 100));
    return normalized * normalized;
  };
  const chimePresets = {
    station: { notes: [523.25, 659.25, 783.99], wave: "sine", gap: 0.15 },
    airport: { notes: [880, 1046.5, 1318.5], wave: "sine", gap: 0.13 },
    gentle: { notes: [392, 493.88, 587.33], wave: "triangle", gap: 0.2 },
    alert: { notes: [740, 740, 988, 988], wave: "square", gap: 0.11 },
    rise: { notes: [440, 554.37, 659.25], wave: "triangle", gap: 0.14 },
    drop: { notes: [659.25, 554.37, 440], wave: "sine", gap: 0.14 },
    warning: { notes: [880, 880, 660, 880], wave: "square", gap: 0.12 },
    siren: { notes: [740, 988, 740, 988, 740], wave: "sawtooth", gap: 0.12 },
    critical: { notes: [1046.5, 1046.5, 1046.5, 740], wave: "square", gap: 0.1 },
  };
  const playChime = (chimeType = settings.chimeType) => {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return 0;
    audioContext ||= new Context();
    audioContext.resume?.().catch(() => {});
    const preset = chimePresets[chimeType] || chimePresets.station,
      level = Math.max(0, Math.min(1, Number(settings.chimeVolume) / 100)),
      peak = Math.max(0.0001, Math.min(1, 0.72 * Math.pow(level, 1.35))),
      start = audioContext.currentTime + 0.02;
    preset.notes.forEach((frequency, index) => {
      const oscillator = audioContext.createOscillator(),
        gain = audioContext.createGain(),
        at = start + index * preset.gap;
      oscillator.type = preset.wave;
      oscillator.frequency.setValueAtTime(frequency, at);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(peak, at + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.start(at);
      oscillator.stop(at + 0.18);
    });
    return preset.notes.length * preset.gap * 1000 + 290;
  };
  const saySystem = (text, { onStarted, onEnded, onFailure } = {}) => {
    if (!supported) return false;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text),
      voice = voices.find((item) => item.voiceURI === settings.voiceURI);
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    } else utterance.lang = uiLang === "zh" ? "zh-CN" : "en-US";
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.volume = volume(settings.speechVolume);
    utterance.onstart = onStarted;
    utterance.onend = onEnded;
    utterance.onerror = onFailure;
    window.speechSynthesis.speak(utterance);
    return true;
  };
  const sayEdge = async (text, { onStarted, onEnded, onFailure } = {}) => {
    const response = await fetch("/api/voice/edge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, voice: settings.edgeVoice }),
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      throw new Error(failure.detail || failure.error || "Edge voice unavailable");
    }
    currentAudio?.pause();
    const audio = new Audio(URL.createObjectURL(await response.blob()));
    currentAudio = audio;
    audio.volume = volume(settings.speechVolume);
    audio.onplay = onStarted;
    audio.onended = () => {
      URL.revokeObjectURL(audio.src);
      onEnded?.();
    };
    audio.onerror = onFailure;
    /* 自动播放许可缺失 / 音频通道被抢占时 play() 会 reject，而这会一路走到 say() 的
       「本机系统语音」兜底 —— 用户听到的就成了另一个嗓（与他选的云音色完全不是一个人）。
       重试一次能吸收这类瞬时失败：两句之间只隔 200ms，仍在同一个用户手势的有效期内。 */
    for (let attempt = 1; ; attempt += 1) {
      try {
        await audio.play();
        break;
      } catch (error) {
        if (attempt >= 2) throw error;
        await new Promise((resolve) => window.setTimeout(resolve, 200));
      }
    }
    return true;
  };
  const say = (text, { force = false, chimeType, noChime = false, engine: engineOverride, fallback = true, label, onStarted, onEnded, onFailure } = {}) => {
    if (!settings.enabled && !force) return false;
    // Edge TTS does not depend on the browser's system speech API.  Some
    // embedded browsers omit speechSynthesis entirely, so only touch it when
    // it exists; otherwise the exception prevented the Edge request as well.
    const sequence = ++speechSequence;
    if (supported) window.speechSynthesis.cancel();
    currentAudio?.pause();
    const started = () => {
        if (sequence !== speechSequence) return;
        setSpeaking(true, label);
        onStarted?.();
      },
      /* 被更高优先级的插队打断时也要回调 onEnded/onFailure，语音队列才能继续。 */
      ended = () => {
        if (sequence === speechSequence) setSpeaking(false);
        onEnded?.();
      },
      failed = (error) => {
        if (sequence === speechSequence) setSpeaking(false);
        onFailure?.(error);
      };
    const delay = noChime ? 0 : playChime(chimeType);
    window.setTimeout(() => {
      if (sequence !== speechSequence) {
        onEnded?.();
        return;
      }
      /* engineOverride：音色试听专用 —— 用户点的是 Azure 下拉里的音色，就算当前「播报引擎」
         选的是本机系统语音，也必须用那条音色自己念一遍，否则试听等于没试。 */
      if ((engineOverride || settings.engine) === "edge") {
        sayEdge(text, { onStarted: started, onEnded: ended, onFailure: failed })
          .catch((error) => {
            /* fallback:false（音色试听）时不用本机系统语音顶替：那会「点任何音色都念同一个
               系统嗓」，用户以为自己选错了音色，实际是这里悄悄换了声。 */
            if (fallback && saySystem(text, { onStarted: started, onEnded: ended, onFailure: failed })) return;
            failed(error);
          });
      } else if (!saySystem(text, { onStarted: started, onEnded: ended, onFailure: failed }))
        failed(new Error("System speech is unavailable"));
    }, delay);
    return true;
  };
  /* 取某个币种的持仓组：当前币种用内存里那份（随输入实时更新），其余币种直接读该币种
     自己的存储键 —— 分屏替别的币种播报时也必须用它自己的持仓，否则会拿 BTC 的仓位去
     说 ETH 的价格。 */
  const personalEntriesForCoin = (coin) => {
    if (!coin || normalizeCoin(coin) === activeCoin())
      return Array.isArray(window.btcPersonalEntries)
        ? window.btcPersonalEntries
        : typeof personalEntries !== "undefined"
          ? personalEntries
          : [];
    try {
      const stored = JSON.parse(
        localStorage.getItem(
          "btc_personal_entry_prices_v3" + coinStorageSuffix(coin),
        ) || "[]",
      );
      return Array.isArray(stored)
        ? stored.filter((entry) => Number(entry?.price) > 0)
        : [];
    } catch {
      return [];
    }
  };
  const personalEntryComparisons = (value, coin) => {
    const entries = personalEntriesForCoin(coin).filter(
        (entry) =>
          Number.isFinite(Number(entry?.price)) && Number(entry.price) > 0,
      ),
      current = Number(value);
    return entries.map((entry) => {
      const entryPrice = Number(entry.price),
        delta = current - entryPrice,
        isShort = entry.side === "short",
        // 价格相对买入价的变动和仓位盈亏是两个概念：空头下跌时
        // 价格是“下跌”，但仓位仍是盈利，不能用盈亏方向替代价格方向。
        // Price movement and P&L direction are distinct for short positions.
        priceUp = delta >= 0,
        pnlDelta = isShort ? -delta : delta,
        inProfit = pnlDelta >= 0,
        amount = Math.abs(delta).toLocaleString("en-US", {
          maximumFractionDigits: 2,
        }),
        percent = Math.abs((delta / entryPrice) * 100).toFixed(2),
        positionSize = Number(entry.amount),
        actualPnl =
          Number.isFinite(positionSize) && positionSize > 0
            ? positionSize * (pnlDelta / entryPrice)
            : null,
        actualPnlText =
          actualPnl === null
            ? ""
            : Math.abs(actualPnl).toLocaleString("en-US", {
                maximumFractionDigits: 2,
              }),
        sideZh = isShort ? "做空" : "做多",
        sideEn = isShort ? "Short" : "Long",
        labelZh = isShort ? "做空买入价" : "做多买入价",
        labelEn = isShort ? "short entry price" : "long entry price";
      return uiLang === "zh"
        ? `相对${labelZh} ${entryPrice.toLocaleString("en-US", { maximumFractionDigits: 2 })}，现价${priceUp ? "上涨" : "下跌"} ${amount}，${priceUp ? "涨幅" : "跌幅"} ${percent}%。差价 ${amount} 美元。${sideZh}${inProfit ? "盈利中" : "亏损中"}${actualPnlText ? `，${inProfit ? "盈利" : "亏损"} ${actualPnlText} 美元` : ""}。`
        : `Compared with your ${labelEn} of ${entryPrice.toLocaleString("en-US", { maximumFractionDigits: 2 })}, price is ${priceUp ? "up" : "down"} ${amount}, a ${priceUp ? "gain" : "drop"} of ${percent} percent. The price difference is ${amount} USD. ${sideEn} ${inProfit ? "is in profit" : "is at a loss"}${actualPnlText ? `, ${inProfit ? "profit" : "loss"} ${actualPnlText} USD` : ""}.`;
    });
  };
  /* 多币种播报（v2.12.10）：语音文本一律先说币种，且币种只用英文代码（BTC / ETH /
     ZEC / BNB），不用「比特币」这类中文名 —— 中文名下再跟「实时价格」极易听混，
     读成「比特币 实时价格」还容易被当成行情类型而不是资产。
     可选入参 coin：分屏替某个面板播报时要按「面板的币种」起头，不能跟当前币种走。 */
  const voiceCoinLabel = (coin) => coinLabel(coin || undefined);
  const priceText = (value, coin) => {
    const current = Number(value).toLocaleString("en-US", {
        maximumFractionDigits: 2,
      }),
      label = voiceCoinLabel(coin),
      comparisons = personalEntryComparisons(value, coin);
    return uiLang === "zh"
      ? `当前 ${label} 价格，${current}。${comparisons.join("")}`
      : `Current ${label} price, ${current}. ${comparisons.join(" ")}`;
  };
  /* 精简版播报语：只报「当前 BTC 实时价格 + 数字」这一句，不带结尾句号和持仓对比。
     数字不加千分位（76287.5 而非 76,287.5），避免 TTS 把逗号读成停顿。 */
  const concisePriceText = (value, coin) =>
    uiLang === "zh"
      ? `当前 ${voiceCoinLabel(coin)} 实时价格 ${Number(value).toLocaleString("en-US", { maximumFractionDigits: 2, useGrouping: false })}`
      : `Current ${voiceCoinLabel(coin)} live price ${Number(value).toLocaleString("en-US", { maximumFractionDigits: 2, useGrouping: false })}`;
  const trigger = document.createElement("button");
  trigger.id = "voiceQuickToggle";
  trigger.type = "button";
  trigger.className = "voice-quick-toggle";
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.setAttribute("aria-expanded", "false");
  trigger.innerHTML = `<span class="voice-pulse voice-pulse-one" aria-hidden="true"></span><span class="voice-pulse voice-pulse-two" aria-hidden="true"></span><svg viewBox="0 0 64 64" aria-hidden="true"><path d="M8 25h13l18-14v42L21 39H8z"/><path class="voice-wave" d="M46 23c5 5 5 13 0 18M52 16c10 10 10 22 0 32"/><line class="voice-mute" x1="9" y1="10" x2="55" y2="54"/></svg><span class="voice-quick-toggle-label" aria-hidden="true"></span>`;
  priceCard.append(trigger);
  setSpeaking = (playing, label = null) => {
    isSpeaking = Boolean(playing);
    /* speakingLabel 只在拿到新 label 时更新；播报结束后保留，
       状态行才能持续显示「已播报：<规则名>」。 */
    if (isSpeaking && label) speakingLabel = label;
    trigger.classList.toggle("is-speaking", isSpeaking);
    trigger.classList.toggle("is-muted", !settings.enabled);
    trigger.disabled = !voicePlaybackAvailable;
    const label2 = !voicePlaybackAvailable
      ? tx("当前环境不支持语音播报", "Voice broadcast is unavailable")
      : isSpeaking
        ? tx("语音播报设置（正在播报）", "Voice settings (speaking)")
        : tx("打开语音播报设置", "Open voice settings");
    trigger.setAttribute("aria-label", label2);
    trigger.title = label2;
    trigger.querySelector(".voice-quick-toggle-label").textContent = isSpeaking
      ? tx("播报中", "Speaking")
      : "";
    paintVoiceSpeaking();
  };
  const settingsModal = document.createElement("div");
  settingsModal.id = "voiceSettingsModal";
  settingsModal.className = "alert-composer voice-settings-modal";
  settingsModal.hidden = true;
  settingsModal.innerHTML = `<section role="dialog" aria-modal="true" aria-labelledby="voiceSettingsTitle"><header><b id="voiceSettingsTitle">${tx("语音播报设置", "Voice alert settings")}</b><span id="voiceSettingsCoinTag" class="voice-settings-coin" hidden></span><button type="button" aria-label="${tx("关闭", "Close")}" data-close-voice-settings>×</button></header><div class="voice-settings-body"></div></section>`;
  document.body.append(settingsModal);
  const settingsBody = settingsModal.querySelector(".voice-settings-body");
  const panel = document.createElement("section");
  panel.className = "voice-alert-panel";
  panel.innerHTML = `<div class="voice-panel-head"><div><b>${tx("语音播报", "Voice alerts")}</b><small id="voiceAlertStatus"></small></div></div><div class="voice-panel-grid"><section class="voice-panel-group voice-panel-toggles"><label class="voice-switch"><input id="voiceAlertEnabled" type="checkbox"><span>${tx("语音总开关", "Voice master")}</span></label><label class="voice-switch"><input id="voiceLivePriceEnabled" type="checkbox"><span>${tx("定时播报实时价", "Speak live price")}</span></label><label class="voice-switch voice-switch-sub" title="${tx("开启后定时播报只报一句播报语（如「当前实时价 76287.5」），不带持仓对比", "When on, timed speech says only one short phrase (e.g. 'Live price 76287.5'), without position comparison")}"><input id="voiceLivePriceConcise" type="checkbox"><span>${tx("定时播报实时价精简版", "Concise live price")}</span></label><label class="voice-live-interval">${tx("播报间隔", "Interval")}<select id="voiceAlertInterval"><option value="15">15 ${tx("秒", "sec")}</option><option value="30">30 ${tx("秒", "sec")}</option><option value="60">1 ${tx("分钟", "min")}</option><option value="300">5 ${tx("分钟", "min")}</option></select><small id="voiceLastSpokenAt" class="voice-last-spoken"></small></label></section><section class="voice-panel-group"><label>${tx("播报引擎", "Engine")}<select id="voiceAlertEngine" title="${tx("微软云语音：服务器调用微软 Azure AI Speech 合成，音色最好、可选 400+ 音色；本机系统语音：直接使用你电脑/手机自带的声音，不联网但音质较机械。", "Microsoft cloud: the server synthesizes via Azure AI Speech (best quality, 400+ voices). System voice: your device's built-in voice, offline but robotic.")}"><option value="edge">${tx("微软云语音（Azure Speech）", "Microsoft cloud (Azure Speech)")}</option><option value="system">${tx("本机系统语音", "System voice")}</option></select></label><label>${tx("音色筛选", "Voice filter")}<select id="voiceGenderFilter"><option value="all">${tx("全部", "All")}</option><option value="male">${tx("男声", "Male")}</option><option value="female">${tx("女声", "Female")}</option></select></label><label>${tx("音色", "Voice")}<select id="voiceAlertEdgeVoice"><optgroup label="${tx("自然女声", "Female (natural)")}"><option value="zh-CN-XiaoxiaoNeural">${tx("小晓 · 普通话", "Xiaoxiao · Mandarin")}</option><option value="zh-CN-XiaoyiNeural">${tx("小艺 · 普通话", "Xiaoyi · Mandarin")}</option><option value="zh-CN-liaoning-XiaobeiNeural">${tx("小北 · 辽宁口音", "Xiaobei · Liaoning")}</option><option value="zh-CN-shaanxi-XiaoniNeural">${tx("小妮 · 陕西口音", "Xiaoni · Shaanxi")}</option><option value="zh-TW-HsiaoChenNeural">${tx("晓臻 · 台湾国语", "HsiaoChen · Taiwanese")}</option><option value="zh-HK-HiuGaaiNeural">${tx("晓佳 · 粤语", "HiuGaai · Cantonese")}</option></optgroup><optgroup label="${tx("自然男声", "Male (natural)")}"><option value="zh-CN-YunxiNeural">${tx("云希 · 普通话", "Yunxi · Mandarin")}</option><option value="zh-CN-YunyangNeural">${tx("云扬 · 普通话", "Yunyang · Mandarin")}</option></optgroup></select></label><label class="system-voice-label">${tx("系统回退", "System fallback")}<select id="voiceAlertVoice"><option>${tx("正在加载系统语音…", "Loading system voices…")}</option></select></label><label><span class="voice-volume-head">${tx("提示音音量", "Chime volume")}<output id="voiceChimeVolumeValue"></output></span><input id="voiceChimeVolume" type="range" min="0" max="200" step="1"></label><label><span class="voice-volume-head">${tx("语音音量", "Speech volume")}<output id="voiceSpeechVolumeValue"></output></span><input id="voiceSpeechVolume" type="range" min="0" max="100" step="1"></label></section><section class="voice-panel-group voice-panel-actions"><button type="button" id="voiceAlertAddRule">＋ ${tx("配置语音规则", "Voice rules")}</button><button type="button" id="voiceAlertTest">${tx("试听", "Test voice")}</button></section></div><small class="voice-rule-note">${tx("语音规则支持价格达到、上涨、下跌及爆仓价；在“添加预警”中勾选“触发时语音播报”。", "Voice rules support reached, rise, fall and liquidation prices; enable Speak when triggered in Add alert.")}</small>`;
  settingsBody.append(panel);
  const voicePanelGrid = panel.querySelector(".voice-panel-grid"),
    voicePanelToggles = panel.querySelector(".voice-panel-toggles"),
    voicePanelActions = panel.querySelector(".voice-panel-actions");
  voicePanelToggles.append(voicePanelActions);
  /* 播报优先级排序面板：多条语音同时触发时，按此列表从上到下依次播报。 */
  /* 优先级标签与「配置语音规则 → 播报条件」下拉项保持一致，避免用户对排序对象产生歧义。 */
  const speechPriorityLabels = {
    liquidation: ["做多 / 做空爆仓价", "Long / short liquidation price"],
    speed: ["短时间急涨／急跌", "Rapid move in a short window"],
    price: ["价格达到", "Price reached"],
    move: ["每上涨／下跌指定金额", "Every rise or drop by amount"],
    tick: ["与前一次报价变动差", "Difference from previous quote"],
    gap: ["距理论强平价警告", "Theoretical liquidation distance"],
    live: ["定时播报实时价", "Timed live price"],
  };
  const priorityPanel = document.createElement("section");
  priorityPanel.className = "voice-priority-panel";
  priorityPanel.innerHTML =
    `<b>${tx("播报优先级", "Speech priority")}</b><small>${tx(
      "按住条目上下拖动即可调整顺序；多条语音同时触发时按此顺序从上到下依次播报，越靠上越优先。",
      "Drag entries up or down to reorder; when several alerts fire together they play top to bottom, higher entries first.",
    )}</small><ol class="voice-priority-list"></ol>`;
  voicePanelToggles.append(priorityPanel);
  const priorityList = priorityPanel.querySelector(".voice-priority-list");
  /* 拖拽排序：按住条目上下拖动，松手即按新顺序保存。 */
  let dragKey = null,
    renderPriority;
  renderPriority = () => {
    priorityList.innerHTML = settings.speakPriority
      .map((key, index) => {
        const label = speechPriorityLabels[key]
          ? tx(speechPriorityLabels[key][0], speechPriorityLabels[key][1])
          : key;
        return (
          '<li draggable="true" data-priority-key="' +
          key +
          '"><span class="voice-priority-grip" aria-hidden="true">⠿</span><span class="voice-priority-index">' +
          (index + 1) +
          ".</span><span>" +
          label +
          "</span></li>"
        );
      })
      .join("");
    priorityList.querySelectorAll("li").forEach((item) => {
      item.addEventListener("dragstart", (event) => {
        dragKey = item.dataset.priorityKey;
        item.classList.add("is-dragging");
        event.dataTransfer.effectAllowed = "move";
        /* Firefox 需要显式 setData 才会启动拖拽。 */
        try {
          event.dataTransfer.setData("text/plain", dragKey);
        } catch {}
      });
      item.addEventListener("dragend", () => {
        item.classList.remove("is-dragging");
        dragKey = null;
        priorityList.querySelectorAll("li").forEach((el) =>
          el.classList.remove("drop-before", "drop-after"),
        );
        /* 松手：按当前 DOM 顺序写回设置并保存。 */
        const order = [...priorityList.querySelectorAll("li")].map(
          (el) => el.dataset.priorityKey,
        );
        if (
          order.length === settings.speakPriority.length &&
          order.some((key, i) => key !== settings.speakPriority[i])
        ) {
          settings.speakPriority = order;
          save();
        }
        renderPriority();
      });
      item.addEventListener("dragover", (event) => {
        if (!dragKey || item.dataset.priorityKey === dragKey) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        const rect = item.getBoundingClientRect(),
          before = event.clientY < rect.top + rect.height / 2;
        const draggingEl = priorityList.querySelector(
          '[data-priority-key="' + dragKey + '"]',
        );
        if (!draggingEl) return;
        /* 实时预览：把拖拽项移动到目标前/后，形成无级插入。 */
        if (before && draggingEl.nextElementSibling !== item) {
          priorityList.insertBefore(draggingEl, item);
        } else if (
          !before &&
          (item.nextElementSibling !== draggingEl ||
            item.nextElementSibling === null)
        ) {
          if (item.nextElementSibling !== draggingEl)
            priorityList.insertBefore(draggingEl, item.nextElementSibling);
        }
        /* 序号即时更新，让用户看到生效后的排名。 */
        priorityList.querySelectorAll("li").forEach((el, i) => {
          const idx = el.querySelector(".voice-priority-index");
          if (idx) idx.textContent = i + 1 + ".";
        });
      });
    });
  };
  renderPriority();
  const enabled = $("voiceAlertEnabled"),
    livePriceEnabled = $("voiceLivePriceEnabled"),
    livePriceConcise = $("voiceLivePriceConcise"),
    engine = $("voiceAlertEngine"),
    genderFilter = $("voiceGenderFilter"),
    edgeVoice = $("voiceAlertEdgeVoice"),
    interval = $("voiceAlertInterval"),
    lastSpokenAtLabel = $("voiceLastSpokenAt"),
    voiceSelect = $("voiceAlertVoice"),
    chimeVolume = $("voiceChimeVolume"),
    speechVolume = $("voiceSpeechVolume"),
    chimeVolumeValue = $("voiceChimeVolumeValue"),
    speechVolumeValue = $("voiceSpeechVolumeValue"),
    status = $("voiceAlertStatus"),
    test = $("voiceAlertTest");
  /* 面板头部状态行：默认显示引擎/音色摘要；播报进行中改显「正在播报：<规则名>」，
     播报结束保留「已播报：<规则名>」，总开关关闭时始终显示「已静音」。 */
  const voiceStatusLine = () => {
      const selected = voices.find(
          (voice) => voice.voiceURI === settings.voiceURI,
        ),
        name =
          settings.engine === "edge"
            ? edgeVoice.options[edgeVoice.selectedIndex]?.text
            : selected?.name || tx("系统语音", "system voice");
      return settings.enabled
        ? `${tx("已开启：", "On: ")}${name}${settings.livePriceEnabled ? ` · ${tx("定时价位播报", "Live price on")}` : ""}`
        : tx("已静音", "Muted");
    },
    paintVoiceSpeaking = () => {
      if (!status) return;
      if (isSpeaking && speakingLabel) {
        status.textContent = tx(
          `正在播报：${speakingLabel}`,
          `Speaking: ${speakingLabel}`,
        );
        status.classList.add("is-speaking-label");
      } else if (speakingLabel && settings.enabled) {
        status.textContent = tx(
          `已播报：${speakingLabel}`,
          `Spoke: ${speakingLabel}`,
        );
        status.classList.remove("is-speaking-label");
      } else {
        status.textContent = voiceStatusLine();
        status.classList.remove("is-speaking-label");
      }
    };
  edgeVoice.insertAdjacentHTML(
    "beforeend",
    '<optgroup data-voice-language="en" label="American English · Female"><option value="en-US-AvaNeural">Ava · American female</option><option value="en-US-EmmaNeural">Emma · American female</option><option value="en-US-AnaNeural">Ana · American female</option><option value="en-US-AriaNeural">Aria · American female</option><option value="en-US-JennyNeural">Jenny · American female</option><option value="en-US-MichelleNeural">Michelle · American female</option></optgroup><optgroup data-voice-language="en" label="American English · Male"><option value="en-US-AndrewNeural">Andrew · American male</option><option value="en-US-BrianNeural">Brian · American male</option><option value="en-US-ChristopherNeural">Christopher · American male</option><option value="en-US-EricNeural">Eric · American male</option><option value="en-US-GuyNeural">Guy · American male</option><option value="en-US-RogerNeural">Roger · American male</option><option value="en-US-SteffanNeural">Steffan · American male</option></optgroup>',
  );
  edgeVoice
    .querySelectorAll("optgroup:not([data-voice-language])")
    .forEach((group) => (group.dataset.voiceLanguage = "zh"));
  /* Azure Speech 音色表：配置过 Azure 后，把该区域的全部中文 / 英文音色接进来
     （含粤语、台湾国语与各方言），仍然按界面语言分组、复用下面的 filterEdgeVoices；
     未配置 Azure 或拉取失败时，静默沿用上面的静态列表（Edge 可用的那批）。

     ⚠️ Azure 只给「经典」音色配了中文名：HD / MAI 这类新代音色的 DisplayName 和
     LocalName 返回的是同一串英文，原样显示会出现「Xiaoxiao Dragon HD Flash Latest ·
     Xiaoxiao Dragon HD Flash Latest」这种自我重复。所以这里补一张人名对照表和版本后缀表，
     中文界面统一显示「晓晓 · 女声 · 多语言」这类可读名称，并把同一位配音员的多个版本
     按代次排在一起 —— 让「同名多版本」一眼可辨，而不是看着像重复条目。 */
  const AZURE_PERSON_ZH = {
    Xiaoxiao:"晓晓", Xiaoxiao2:"晓晓 2", Xiaoyi:"晓伊", Xiaochen:"晓辰", Xiaohan:"晓涵",
    Xiaoke:"晓珂", Xiaomeng:"晓梦", Xiaomo:"晓墨", Xiaoqi:"晓琪", Xiaoqiu:"晓秋",
    Xiaorou:"晓柔", Xiaorui:"晓睿", Xiaoshuang:"晓双", Xiaoyan:"晓颜", Xiaoyou:"晓悠",
    Xiaoyu:"晓宇", Xiaozhen:"晓甄", Xiaobei:"晓北", Xiaoni:"晓妮",
    Yunxi:"云希", Yunxiao:"云晓", Yunjian:"云健", Yunyang:"云扬", Yunyi:"云逸",
    Yunze:"云泽", Yunhao:"云皓", Yunfeng:"云枫", Yunxia:"云夏", Yunye:"云野",
    Yunjie:"云杰", Yunfan:"云帆", Yunhan:"云瀚", Yunqi:"云奇", Yundeng:"云登",
    Yunbiao:"云彪", Yunxiang:"云翔",
    Bo:"博", Lan:"岚", Mei:"梅", Wei:"薇",
    HiuMaan:"曉曼", WanLung:"雲龍", HiuGaai:"曉佳", HsiaoChen:"曉臻", YunJhe:"雲哲", HsiaoYu:"曉雨",
  };
  // [短名里的版本标识, 中文标签, 英文标签]，顺序即下拉里的排列顺序。
  const AZURE_VARIANTS = [
    ["classic", "经典", "standard"],
    ["Multilingual", "多语言", "multilingual"],
    ["Dialects", "方言", "dialects"],
    ["DragonLatest", "HD 超清", "HD"],
    ["DragonHDFlashLatest", "HD 超清 · 极速", "HD flash"],
    ["MAI-Voice-2-Flash", "MAI 二代 · 极速", "MAI 2 flash"],
    ["MAI-Voice-2", "MAI 二代", "MAI 2"],
  ];
  /* 短名拆成「配音员 + 版本」：
     zh-CN-Xiaoxiao:DragonHDFlashLatestNeural → Xiaoxiao / DragonHDFlashLatest；
     zh-CN-XiaoxiaoMultilingualNeural → Xiaoxiao / Multilingual。 */
  const parseAzureVoice = (name) => {
    const body = String(name || "").replace(/^[a-z]{2}-[A-Za-z]{2}(-[a-z]+)?-/, "");
    const colon = body.indexOf(":");
    const head = colon >= 0 ? body.slice(0, colon) : body;
    let person = head.replace(/Neural$/, "");
    let variant = (colon >= 0 ? body.slice(colon + 1) : "").replace(/Neural$/, "");
    if (/Multilingual$/.test(person)) { person = person.replace(/Multilingual$/, ""); variant = "Multilingual"; }
    else if (/Dialects$/.test(person)) { person = person.replace(/Dialects$/, ""); variant = "Dialects"; }
    return { person, variant: variant || "classic" };
  };
  const azureVoiceLabel = (item) => {
    const parsed = parseAzureVoice(item.name),
      genderOf = item.gender === "Male" ? tx("男声", "male") : item.gender === "Female" ? tx("女声", "female") : "",
      variant = AZURE_VARIANTS.find((entry) => entry[0] === parsed.variant);
    if (uiLang === "en") return [item.display || parsed.person, genderOf].filter(Boolean).join(" · ");
    // 方言音色（zh-CN-sichuan / -liaoning 等）在 Azure 里的 LocalName 自带地名
    // （「云希 四川」），直接用它可以避免与普通话版的同名音色在列表里撞名。
    if (/^[a-z]{2}-[A-Z]{2}-[a-z]+/.test(String(item.locale)) && /[\u4e00-\u9fa5]/.test(String(item.local || "")))
      return [...new Set([String(item.local).trim(), genderOf].filter(Boolean))].join(" · ");
    // 官方中文名 → 人名对照表 → （万一都没有）英文原名，逐级兜底。
    const zhName = AZURE_PERSON_ZH[parsed.person]
      || (/[\u4e00-\u9fa5]/.test(String(item.local || "")) ? item.local : item.display || parsed.person);
    return [...new Set([zhName, genderOf, variant ? variant[1] : ""].filter(Boolean))].join(" · ");
  };
  const escapeVoiceAttr = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  /* 本地区合成不了的音色（HD／极速／MAI 代次）**不出现在下拉里**。Azure 只在
     southeastasia、eastus 等少数区域提供它们（eastasia 不在其中），列出来只能是
     「选了必然失败」的选项 —— 用户要的是一份能用的清单。去掉几条要写清楚，
     否则音色凭空少了会让人以为坏了：说明行给出条数与恢复办法（换区域即出现）。 */
  const hdVoiceNote = (() => {
    edgeVoice.insertAdjacentHTML(
      "afterend",
      `<small class="voice-rule-note" style="display:none;margin:4px 0 0;"></small>`,
    );
    return edgeVoice.nextElementSibling;
  })();
  const paintHdVoiceNote = (hiddenCount) => {
    if (!hdVoiceNote) return;
    const show = Number(hiddenCount) > 0;
    hdVoiceNote.style.display = show ? "block" : "none";
    if (show)
      hdVoiceNote.textContent = tx(
        `已隐藏 ${hiddenCount} 个本地区不支持的音色（HD 超清／极速／MAI 二代）。Azure 只在 southeastasia、eastus 等区域提供这些代次，把 Azure Speech 的区域换成其中之一即可全部出现。`,
        `${hiddenCount} voices unavailable in this region are hidden (HD / flash / MAI generations). Azure serves those generations only in regions such as southeastasia or eastus — switch the Azure Speech region to make them appear.`,
      );
  };
  const applyAzureVoices = (list, hdSupported = true) => {
    if (!Array.isArray(list) || !list.length) return false;
    /* 带代次的音色 ShortName 里有冒号（zh-CN-Yunhan:DragonHDLatestNeural），区域不支持时
       按冒号整批判掉，剩下的才是本地区真能合成的清单。被去掉的条数只统计**本来会出现在
       下拉里的语言**（zh / en），否则说明行会报出整个音色表（含几百条本来就看不到的语种）
       的隐藏数，与用户实际少掉的条目对不上。 */
    const listed = (item) => ["zh", "en"].includes(String(item && item.locale).split("-")[0].toLowerCase());
    const usable = hdSupported === false
      ? list.filter((item) => !/:/.test(String(item && item.name)))
      : list;
    paintHdVoiceNote(
      hdSupported === false
        ? list.filter((item) => listed(item) && /:/.test(String(item && item.name))).length
        : 0,
    );
    const buckets = new Map();
    usable.forEach((item) => {
      const name = item && item.name, locale = item && item.locale;
      if (!name || !locale) return;
      const lang = String(locale).split("-")[0].toLowerCase();
      if (lang !== "zh" && lang !== "en") return;
      if (!buckets.has(lang)) buckets.set(lang, new Map());
      if (!buckets.get(lang).has(locale)) buckets.get(lang).set(locale, []);
      buckets.get(lang).get(locale).push(item);
    });
    // 组内按「配音员 + 代次」排序，同一人的经典 / 多语言 / 方言 / HD 依次相邻；
    // MAI 系列是 Azure 最新的实验音色（只有音译名），整体沉到组尾，不挤在列表最上面。
    const orderOf = (item) => {
      const { person, variant } = parseAzureVoice(item.name),
        index = AZURE_VARIANTS.findIndex((entry) => entry[0] === variant),
        tail = /^MAI-Voice/.test(variant) ? "1" : "0";
      return `${tail}|${person}|${String(index < 0 ? 99 : index).padStart(2, "0")}`;
    };
    const html = [...buckets.entries()]
      .map(([lang, groups]) =>
        [...groups.entries()]
          .map(([locale, items]) => {
            const label = items[0].localeName ? `${locale} · ${items[0].localeName}` : locale;
            const options = [...items]
              .sort((a, b) => orderOf(a).localeCompare(orderOf(b)))
              .map((item) => {
                /* data-gender 取自 Azure 音色表（权威），供「音色筛选」按性别过滤；
                   静态回退列表没有这个属性时，再由标签文字兜底判断。 */
                const gender =
                  item.gender === "Male" ? "male" : item.gender === "Female" ? "female" : "";
                return `<option value="${escapeVoiceAttr(item.name)}"${gender ? ` data-gender="${gender}"` : ""}>${escapeVoiceAttr(azureVoiceLabel(item))}</option>`;
              })
              .join("");
            return `<optgroup data-voice-language="${lang}" label="${escapeVoiceAttr(label)}">${options}</optgroup>`;
          })
          .join(""),
      )
      .join("");
    if (!html) return false;
    edgeVoice.innerHTML = html;
    return true;
  };
  (async () => {
    try {
      const response = await fetch("/api/voice/azure/voices");
      if (!response.ok) return;
      const payload = await response.json();
      if (!applyAzureVoices(payload && payload.voices, payload?.hdSupported !== false)) return;
      filterEdgeVoices();
      save();
    } catch {
      /* 未配置 Azure：保留静态列表 */
    }
  })();
  chimeVolume
    .closest("label")
    .insertAdjacentHTML(
      "beforebegin",
      `<label>${tx("默认提示音", "Default chime")}<select id="voiceChimeType">${Object.keys(chimePresets).map((key) => `<option value="${key}">${({ station: tx("车站三音", "Station three-tone"), airport: tx("机场登机", "Airport boarding"), gentle: tx("轻柔提示", "Gentle chime"), alert: tx("短促提醒", "Short alert"), rise: tx("上涨音", "Rising tone"), drop: tx("下跌音", "Falling tone"), warning: tx("警示音", "Warning"), siren: tx("警报器", "Siren"), critical: tx("紧急警报", "Critical alert") })[key]}</option>`).join("")}</select></label><label>${tx("上涨提示音", "Rise chime")}<select id="voiceRiseChimeType"></select></label><label>${tx("下跌提示音", "Drop chime")}<select id="voiceDropChimeType"></select></label><label>${tx("爆仓警示音", "Liquidation alert")}<select id="voiceLiquidationChimeType"></select></label>`,
    );
  const chimeType = $("voiceChimeType"),
    riseChimeType = $("voiceRiseChimeType"),
    dropChimeType = $("voiceDropChimeType"),
    liquidationChimeType = $("voiceLiquidationChimeType");
  [riseChimeType, dropChimeType, liquidationChimeType].forEach((select) => {
    select.innerHTML = chimeType.innerHTML;
  });
  chimeType.value = settings.chimeType;
  riseChimeType.value = settings.riseChimeType;
  dropChimeType.value = settings.dropChimeType;
  liquidationChimeType.value = settings.liquidationChimeType;
  const normalizeChimeType = (value, fallback) =>
    chimePresets[value] ? value : fallback;
  settings.chimeType = normalizeChimeType(settings.chimeType, "station");
  settings.riseChimeType = normalizeChimeType(settings.riseChimeType, "rise");
  settings.dropChimeType = normalizeChimeType(settings.dropChimeType, "drop");
  settings.liquidationChimeType = normalizeChimeType(
    settings.liquidationChimeType,
    "warning",
  );
  chimeVolume.max = "100";
  interval.innerHTML = `<option value="15">15 ${tx("秒", "sec")}</option><option value="30">30 ${tx("秒", "sec")}</option><option value="60">1 ${tx("分钟", "min")}</option><option value="300">5 ${tx("分钟", "min")}</option><option value="600">10 ${tx("分钟", "min")}</option><option value="900">15 ${tx("分钟", "min")}</option><option value="1800">30 ${tx("分钟", "min")}</option><option value="3600">1 ${tx("小时", "hour")}</option>`;
  panel.querySelector(".voice-rule-note").textContent = tx(
    "语音规则独立保存，可设置价格达到、上涨或下跌后的单次／重复播报。首页保持打开时即由浏览器监听并播报，无需打开本设置面板；关闭页面或电脑重启后停止播报。重复播报的冷却下限为 30 秒。",
    "Voice rules are independent and support one-time or repeated reached, rise and fall alerts. They monitor and speak while the home page is open; this settings panel does not need to remain open. Speech stops after the page closes or the computer restarts. Repeated alerts cool down at least 30 seconds.",
  );
  const populateVoices = () => {
    if (!supported) return;
    voices = window.speechSynthesis.getVoices();
    const preferred = voices.filter((voice) => /^zh/i.test(voice.lang)),
      items = preferred.length ? preferred : voices;
    if (!items.length) return;
    const chosen = items.some((voice) => voice.voiceURI === settings.voiceURI)
      ? settings.voiceURI
      : (
          items.find((voice) =>
            /Ting-Ting|Mei-Jia|Sin-Ji|Xiaoxiao|Xiaoyi/i.test(voice.name),
          ) || items[0]
        ).voiceURI;
    settings.voiceURI = chosen;
    voiceSelect.innerHTML = items
      .map(
        (voice) =>
          `<option value="${voice.voiceURI}">${voice.name} · ${voice.lang}</option>`,
      )
      .join("");
    voiceSelect.value = chosen;
    save();
    render();
  };
  /* 一条音色的性别：Azure 音色表里带性别（data-gender），静态回退列表只能从标签文字
     （「男声 / 女声 / male / female」）反推；两者都认不出就返回空串，选中「全部」时才显示。 */
  const optionGenderOf = (option) =>
    option.dataset.gender ||
    (/女声|女生|female/i.test(option.text) ? "female" : /男声|男生|male/i.test(option.text) ? "male" : "");
  const filterEdgeVoices = () => {
    const desired = uiLang === "en" ? "en" : "zh",
      gender = settings.voiceGenderFilter || "all";
    edgeVoice.querySelectorAll("optgroup").forEach((group) => {
      const visible = group.dataset.voiceLanguage === desired;
      group.hidden = !visible;
      group.querySelectorAll("option").forEach((option) => {
        /* 语言与性别两道筛选叠加：任一条不满足都从下拉里隐去并置灰。 */
        const usable = visible && (gender === "all" || optionGenderOf(option) === gender);
        option.hidden = !usable;
        option.disabled = !usable;
      });
    });
    const selected = [...edgeVoice.options].find(
      (option) => option.value === settings.edgeVoice,
    );
    /* 选中的音色若不在当前语言组（换过语言，或它已随「本地区不支持」被整批隐藏），
       落到本语言组第一条。**性别筛选不算数**：它只是帮你挑音色的过滤器，不该在
       你只是「看一眼男声有哪些」的时候把你正在用的女声悄悄改掉。 */
    if (
      !selected ||
      selected.parentElement?.dataset.voiceLanguage !== desired
    ) {
      settings.edgeVoice =
        [...edgeVoice.options].find(
          (option) => option.parentElement?.dataset.voiceLanguage === desired,
        )?.value || settings.edgeVoice;
      save();
    }
    edgeVoice.value = settings.edgeVoice;
  };
  /* ── 音色试听（v2.12.12）────────────────────────────────────────────────
     在音色下拉里点选一个音色就立刻念一句自我介绍，不用先保存、再点「试听」才知道
     自己选的是谁。文案从**下拉里显示的那个名字**反推，而不是去猜 voice.name，
     所以念出来的永远和用户眼睛看到的一致：
       「晓晓 · 女声 · 经典」          → 我是晓晓，这是我的声音。
       「云帆 · 男声 · HD 超清 · 极速」 → 我是云帆，超清极速，这是我的声音。
     三条规则：① 性别不念（男声/女声/male/female）；②「经典 / standard」是默认代次，
     念出来纯属噪音，跳过；③ 其余代次去掉 HD 前缀、抹掉「 · 」分隔后连读。 */
  const VOICE_GENDER_TOKEN = /^(?:女声|男声)$|\b(?:male|female)\b/i;
  const voiceIntroParts = (option) => {
    const raw = String(option?.text || "")
      .split(" · ")
      .map((part) => part.trim())
      .filter(Boolean);
    return {
      name: raw[0] || "",
      variant: raw
        .slice(1)
        .filter((part) => !VOICE_GENDER_TOKEN.test(part))
        .join(" · "),
      lang: /^zh/i.test(String(option?.value ?? "")) ? "zh" : "en",
    };
  };
  const voiceIntroText = (name, variant, lang) => {
    if (!name) return "";
    /* 方言音色的显示名是「云希 四川」，念成「云希，四川」比连读清楚；但空格两侧都
       要挑：中文名后的空格才断开（「晓晓 2」后面是数字会被念成「晓晓，2」），
       而「William Multilingual」这种多词拉丁名一个空格都不能动。 */
    const spoken =
      lang === "en"
        ? String(name)
        : String(name).replace(/([\u4e00-\u9fa5])\s+(?=\D)/g, "$1，");
    if (lang === "en")
      return `I'm ${spoken}${variant ? ", " + variant : ""}. This is my voice.`;
    const tail = variant
      .replace(/\bHD\b/gi, "")
      .replace(/经典|standard/gi, "")
      .split(" · ")
      .map((part) => part.trim())
      .filter(Boolean)
      .join("");
    return `我是${spoken}${tail ? "，" + tail : ""}，这是我的声音。`;
  };
  const previewVoice = ({ name, variant, lang }, engineOverride) => {
    const text = voiceIntroText(name, variant, lang);
    if (!text) return;
    /* 试听是用户主动点的：不受「语音总开关」限制（静音状态下也能试音色），也不播提示音，
       点完直接开口。**失败时不回退到本机系统语音**（fallback:false）—— 否则「点任何音色
       都念同一个系统嗓」，用户会以为自己挑错了音色，而真正的原因被吞掉。这里如实报错。 */
    say(text, {
      force: true,
      noChime: true,
      engine: engineOverride,
      fallback: false,
      label: name,
      onFailure: (error) => {
        if (!status) return;
        status.textContent = tx(
          `试听失败：${error?.message || "语音服务不可用"}。音色设置已保存，未改动。`,
          `Preview failed: ${error?.message || "voice service unavailable"}. Your voice choice is saved.`,
        );
      },
    });
  };
  const formatLastSpokenAt = (ts) => {
    if (!ts) return tx("从未", "Never");
    const date = new Date(ts);
    const now = new Date();
    const sameDay =
      date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate();
    const timeStr = date.toLocaleTimeString(uiLang === "zh" ? "zh-CN" : "en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    if (sameDay) return timeStr;
    const dateStr = date.toLocaleDateString(uiLang === "zh" ? "zh-CN" : "en-US", {
      month: "short",
      day: "numeric",
    });
    return uiLang === "zh" ? `${dateStr} ${timeStr}` : `${dateStr}, ${timeStr}`;
  };
  const render = () => {
    enabled.checked = Boolean(settings.enabled);
    livePriceEnabled.checked = Boolean(settings.livePriceEnabled);
    livePriceConcise.checked = Boolean(settings.livePriceConcise);
    engine.value = settings.engine;
    edgeVoice.value = settings.edgeVoice;
    interval.value = String(settings.interval);
    lastSpokenAtLabel.textContent = `${tx("上次播报：", "Last spoken: ")}${formatLastSpokenAt(settings.lastSpokenAt)}`;
    chimeType.value = settings.chimeType;
    riseChimeType.value = settings.riseChimeType;
    dropChimeType.value = settings.dropChimeType;
    liquidationChimeType.value = settings.liquidationChimeType;
    settings.chimeVolume = Math.max(0, Math.min(100, Number(settings.chimeVolume) || 0));
    chimeVolume.value = String(settings.chimeVolume);
    speechVolume.value = String(settings.speechVolume);
    const paintRange = (input) => {
      const minimum = Number(input.min) || 0;
      const maximum = Number(input.max) || 100;
      const value = Math.max(minimum, Math.min(maximum, Number(input.value) || 0));
      input.style.setProperty(
        "--voice-range-fill",
        `${((value - minimum) / (maximum - minimum || 1)) * 100}%`,
      );
    };
    paintRange(chimeVolume);
    paintRange(speechVolume);
    chimeVolumeValue.value = `${settings.chimeVolume}%`;
    chimeVolumeValue.textContent = `${settings.chimeVolume}%`;
    speechVolumeValue.value = `${settings.speechVolume}%`;
    speechVolumeValue.textContent = `${settings.speechVolume}%`;
    genderFilter.value = settings.voiceGenderFilter;
    panel.classList.toggle("is-enabled", Boolean(settings.enabled));
    /* 定时播报关闭时，播报间隔一并置灰，避免“调了却不生效”的困惑。 */
    interval.disabled = !settings.livePriceEnabled;
    livePriceConcise.disabled = !settings.livePriceEnabled;
    panel.classList.toggle("uses-edge", settings.engine === "edge");
    /* 状态行文字统一由 paintVoiceSpeaking 决定（含「正在播报/已播报」态）。 */
    setSpeaking(isSpeaking);
  };
  const speakPrice = (force) => {
    const current = state?.ticker?.last,
      now = Date.now();
    if (
      !Number.isFinite(current) ||
      !settings.enabled ||
      !settings.livePriceEnabled
    )
      return;
    if (
      force ||
      now - settings.lastSpokenAt >= Number(settings.interval) * 1000
    ) {
      const chimeType =
        !Number.isFinite(lastLiveSpokenPrice) || current === lastLiveSpokenPrice
          ? settings.chimeType
          : current > lastLiveSpokenPrice
            ? settings.riseChimeType
            : settings.dropChimeType;
      /* 精简版：只报「当前实时价 76287.5」这类播报语，不带持仓对比。 */
      const spokenText = settings.livePriceConcise
        ? concisePriceText(current)
        : priceText(current);
      if (
        enqueueSpeech(
          spokenText,
          {
            chimeType,
            label: tx("定时播报实时价", "Timed live price"),
          },
          speechRankOfKey("live"),
        )
      ) {
        settings.lastSpokenAt = now;
        lastLiveSpokenPrice = current;
        save();
        lastSpokenAtLabel.textContent = `${tx("上次播报：", "Last spoken: ")}${formatLastSpokenAt(settings.lastSpokenAt)}`;
      }
    }
  };
  /* 分屏版的「定时播报实时价」：每个币种各自计时（主站那个用的是全局 lastSpokenAt，
     多币种共用会互相把间隔顶掉）。间隔 / 精简版 / 引擎全部沿用同一份设置。
     force = 手动试听（分屏面板里的「全部播报」）：不受「定时播报」开关与间隔约束，
     也不需要总开关打开（与主站「试听」同一个口气，是一次明确的用户动作）。 */
  const speakLiveFor = (coin, price, { force = false, rankBase = 0 } = {}) => {
    const slot = runtimeFor(coin),
      now = Date.now();
    if (!Number.isFinite(price)) return false;
    /* force = 手动试听（分屏面板的「全部播报」）：不受「定时播报」开关、间隔与总开关
       约束 —— 与主站「试听」同一口径，点的是明确的试听动作就该出声。 */
    if (!force && (!settings.enabled || !settings.livePriceEnabled)) return false;
    if (!force && now - (slot.lastLiveAt || 0) < Number(settings.interval) * 1000) return false;
    const chimeType =
      !Number.isFinite(slot.lastLivePrice) || price === slot.lastLivePrice
        ? settings.chimeType
        : price > slot.lastLivePrice
          ? settings.riseChimeType
          : settings.dropChimeType;
    const spokenText = settings.livePriceConcise
      ? concisePriceText(price, coin)
      : priceText(price, coin);
    const queued = enqueueSpeech(
      spokenText,
      {
        chimeType,
        label: tx("定时播报实时价", "Timed live price"),
        /* force 会把这次播报送出总开关之外（say 的 force 分支）—— 手动试听专用。 */
        force,
        onStarted: () => announceVoiceSpeaking(coin, true),
        onEnded: () => announceVoiceSpeaking(coin, false),
        onFailure: () => announceVoiceSpeaking(coin, false),
      },
      rankBase + speechRankOfKey("live"),
    );
    if (queued) {
      slot.lastLiveAt = now;
      slot.lastLivePrice = price;
    }
    return queued;
  };
  enabled.onchange = () => {
    settings.enabled = enabled.checked;
    settings.lastSpokenAt = 0;
    save();
    render();
    syncVoiceToServer();
    if (settings.enabled) primeAudioContext();
  };
  livePriceEnabled.onchange = () => {
    settings.livePriceEnabled = livePriceEnabled.checked;
    settings.lastSpokenAt = 0;
    save();
    render();
    syncVoiceToServer();
    if (settings.enabled && settings.livePriceEnabled) {
      primeAudioContext();
      speakPrice(true);
    }
  };
  /* 精简版只影响本地播报文本格式，无需同步服务端。 */
  livePriceConcise.onchange = () => {
    settings.livePriceConcise = livePriceConcise.checked;
    save();
    render();
    if (settings.enabled && settings.livePriceEnabled) {
      primeAudioContext();
      speakPrice(true);
    }
  };
  engine.onchange = () => {
    settings.engine = engine.value;
    save();
    render();
  };
  /* 音色筛选（全部 / 男声 / 女声）：只改变下拉里列出的音色，不动当前正在用的音色。 */
  genderFilter.onchange = () => {
    settings.voiceGenderFilter = ["all", "male", "female"].includes(genderFilter.value)
      ? genderFilter.value
      : "all";
    save();
    filterEdgeVoices();
    render();
  };
  edgeVoice.onchange = () => {
    settings.edgeVoice = edgeVoice.value;
    save();
    render();
    syncVoiceToServer();
    /* 选完就地试听：用刚选中的这条 Azure 音色念它的自我介绍。 */
    previewVoice(voiceIntroParts(edgeVoice.options[edgeVoice.selectedIndex]), "edge");
  };
  interval.onchange = () => {
    settings.interval = Math.max(15, Number(interval.value) || 60);
    save();
    render();
  };
  let lastChimePreviewAt = 0,
    pendingChimePreview = null;
  const previewChimeVolume = () => {
    const minimumGap = 550,
      wait = minimumGap - (Date.now() - lastChimePreviewAt),
      play = () => {
        pendingChimePreview = null;
        lastChimePreviewAt = Date.now();
        // Three short notes make the current slider volume immediately audible.
        playChime();
      };
    if (wait <= 0) play();
    else if (!pendingChimePreview) pendingChimePreview = window.setTimeout(play, wait);
  };
  chimeVolume.oninput = () => {
    settings.chimeVolume = Math.max(0, Math.min(100, Number(chimeVolume.value) || 0));
    save();
    render();
    previewChimeVolume();
  };
  chimeType.onchange = () => {
    settings.chimeType = chimeType.value;
    save();
    render();
    playChime(settings.chimeType);
  };
  riseChimeType.onchange = () => {
    settings.riseChimeType = riseChimeType.value;
    save();
    render();
    playChime(settings.riseChimeType);
  };
  dropChimeType.onchange = () => {
    settings.dropChimeType = dropChimeType.value;
    save();
    render();
    playChime(settings.dropChimeType);
  };
  liquidationChimeType.onchange = () => {
    settings.liquidationChimeType = liquidationChimeType.value;
    save();
    render();
    playChime(settings.liquidationChimeType);
  };
  speechVolume.oninput = () => {
    settings.speechVolume = Number(speechVolume.value);
    save();
    render();
  };
  voiceSelect.onchange = () => {
    settings.voiceURI = voiceSelect.value;
    save();
    render();
    /* 系统语音同理试听；音色名后带「· zh-CN」这类语言后缀，试听只念名字本身
       （macOS 会给出「Eddy (中文（中国大陆）)」这种带括号的全名，括号到行尾一并去掉，
       贪婪匹配对「X (Chinese (China))」这种嵌套括号也不会只切一半）。 */
    const picked = voices.find((item) => item.voiceURI === settings.voiceURI),
      name = String(picked?.name || "")
        .split(" · ")[0]
        .replace(/\s*\(.*\)\s*$/, "")
        .trim();
    previewVoice(
      { name, variant: "", lang: /^zh/i.test(String(picked?.lang)) ? "zh" : "en" },
      "system",
    );
  };
  /* 分屏面板右上角的喇叭把本面板当作「普通模式下该币种的播报按钮」：
     打开时把主站临时切到目标币种（语音规则按币种隔离存储，不切币就列不出该币种的规则），
     关闭时原样还原 —— 在分屏里「看一眼某个币的播报设置」不该改变主站视图。 */
  let voiceSettingsCoinSnapshot = null;
  const restoreVoiceSettingsCoin = () => {
    const snap = voiceSettingsCoinSnapshot;
    voiceSettingsCoinSnapshot = null;
    paintVoiceSettingsCoinTag(null);
    const ctx = window.btcCoinContext;
    if (!snap || !ctx) return;
    try {
      if (snap.coin && ctx.coin() !== snap.coin) ctx.setCoin(snap.coin);
      if (snap.mode && ctx.mode() !== snap.mode) ctx.setMode(snap.mode);
    } catch {}
  };
  /* 标题旁的币种标识：分屏里点不同面板的喇叭会来回切币种，需要一眼看出「这是哪个币的设置」。
     样式内联 —— 这个浮层的样式集中在 styles.css，别为一个标签再动那份大文件。 */
  const paintVoiceSettingsCoinTag = (coin) => {
    const tag = $("voiceSettingsCoinTag");
    if (!tag) return;
    tag.style.cssText =
      "color:#6f9de9;font-weight:600;font-size:12px;margin-left:8px;";
    tag.textContent = coin ? coinPair(coin) : "";
    tag.hidden = !coin;
  };
  const showVoiceSettings = (open) => {
    settingsModal.hidden = !open;
    trigger.setAttribute("aria-expanded", String(open));
    if (open) render();
    else restoreVoiceSettingsCoin();
  };
  const primeAudioContext = () => {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return;
    audioContext ||= new Context();
    audioContext.resume?.().catch(() => {});
    const silent = audioContext.createGain();
    silent.gain.value = 0;
    silent.connect(audioContext.destination);
    try {
      const oscillator = audioContext.createOscillator();
      oscillator.frequency.value = 1;
      oscillator.connect(silent);
      oscillator.start();
      oscillator.stop(audioContext.currentTime + 0.001);
    } catch {}
  };
  trigger.onclick = () => {
    // 只打开设置面板，不自动开启语音总开关；
    // 是否启用由面板内的「语音总开关」控制。
    paintVoiceSettingsCoinTag(activeCoin());
    primeAudioContext();
    showVoiceSettings(true);
  };
  /* 供分屏面板调用：面板右上角的喇叭 = 普通模式下该币种播报按钮的软链接。
     点它出来的就是这套「语音播报设置」，且规则列表对应该面板的币种。 */
  window.btcVoiceSettings = {
    open: (coin) => {
      const ctx = window.btcCoinContext;
      const target = coin ? normalizeCoin(coin) : null;
      if (ctx && target) {
        const snapshot = { coin: ctx.coin(), mode: ctx.mode() };
        if (snapshot.coin !== target || snapshot.mode !== "multi") {
          /* `||=` 而非直接赋值：连续点不同面板的喇叭时，保住更深一层、尚未还原的那个快照。 */
          voiceSettingsCoinSnapshot ||= snapshot;
          try {
            if (snapshot.mode !== "multi") ctx.setMode("multi");
            if (ctx.coin() !== target) ctx.setCoin(target);
          } catch {}
        }
      }
      paintVoiceSettingsCoinTag(target);
      primeAudioContext();
      showVoiceSettings(true);
    },
    close: () => showVoiceSettings(false),
    isOpen: () => !settingsModal.hidden,
  };
  settingsModal.querySelector("[data-close-voice-settings]").onclick = () =>
    showVoiceSettings(false);
  settingsModal.onclick = (event) => {
    if (event.target === settingsModal) showVoiceSettings(false);
  };
  test.onclick = () => {
    primeAudioContext();
    // The previous check accidentally disabled the selected Edge engine on
    // browsers that lack local speechSynthesis, even though Edge TTS works
    // through our audio endpoint.  Only the system-voice option needs it.
    if (settings.engine === "system" && !supported) {
      status.textContent = tx(
        "当前浏览器不支持语音",
        "Speech is unavailable in this browser",
      );
      return;
    }
    const current = state?.ticker?.last;
    if (!Number.isFinite(current)) {
      status.textContent = tx("实时价格尚未加载", "Live price is not loaded");
      return;
    }
    /* 试听也尊重「精简版」开关：开启时只报「当前实时价 76287.5」这句播报语。 */
    const previewText = settings.livePriceConcise
      ? concisePriceText(current)
      : priceText(current);
    const wasEnabled = settings.enabled;
    settings.enabled = true;
    say(previewText, {
      onStarted: () => {
        status.textContent = tx("正在播放试听", "Playing test");
      },
      onFailure: () => {
        status.textContent = tx(
          "试听失败：请检查本机音量，或切换为本机系统语音后重试。",
          "Test failed: check local volume or switch to system voice and try again.",
        );
      },
    });
    settings.enabled = wasEnabled;
    status.textContent = tx("正在连接语音服务…", "Connecting to voice service…");
  };
  $("voiceAlertAddRule").onclick = () => $("openLocalAlert")?.click();
  /* 多币种（v2.12.5）：语音规则按币种独立存储 —— BTC 沿用旧键保留历史数据，
     其余币种各用 btc_voice_alert_rules_v1_<COIN>；没设置过的币种就是空，不借 BTC 的规则。
     分屏（v2.12.17）要按「面板的币种」取用，所以这里带可选的 coin 入参。 */
  const voiceRuleStoreKey = (coin) =>
    "btc_voice_alert_rules_v1" + coinStorageSuffix(coin);
  const parseVoiceRules = (raw) => {
    try {
      const stored = JSON.parse(raw || "[]");
      if (!Array.isArray(stored)) return [];
      return stored
        .filter((rule) => rule && rule.id && Number(rule.targetPrice) > 0)
        .slice(0, 30)
        .map((rule) => ({
          ...rule,
          kind: [
            "price_reached",
            "price_above",
            "price_below",
            "long_liquidation",
            "short_liquidation",
            "price_move",
            "price_speed",
            "price_tick_move",
            "theoretical_liquidation_gap",
          ].includes(rule.kind)
            ? rule.kind
            : "price_reached",
          direction: ["down", "both"].includes(rule.direction)
            ? rule.direction
            : "up",
          positionSide: rule.positionSide === "short" ? "short" : "long",
          anchorPrice: Number(rule.anchorPrice) || null,
          windowSeconds: Math.min(
            60,
            Math.max(1, Number(rule.windowSeconds) || 3),
          ),
          repeat: Boolean(rule.repeat),
          cooldownMinutes: Math.max(0, Number(rule.cooldownMinutes) || 0),
        }));
    } catch {
      return [];
    }
  };
  const loadVoiceRulesFromStorage = () =>
    parseVoiceRules(localStorage.getItem(voiceRuleStoreKey()));
  let voiceRules = loadVoiceRulesFromStorage(),
    voiceRuleEditingId = null;
  /* 每币种一套「跑动状态」：上一拍价 + 最近 61 秒的价格历史。主站当前币种用一份，分屏里
     每个面板的币种各用一份 —— 跨币种价格量级差得远，共用基准会把切换瞬间当成暴涨暴跌。 */
  const voiceRuntime = new Map();
  const runtimeFor = (coin) => {
    const key = normalizeCoin(coin);
    let slot = voiceRuntime.get(key);
    if (!slot) {
      slot = { prev: null, history: [], lastLiveAt: 0, lastLivePrice: null };
      voiceRuntime.set(key, slot);
    }
    return slot;
  };
  const activeRuntime = () => runtimeFor(activeCoin());
  /* 分屏正在替哪些币种喂价（由 split-mode.js 随分屏开关登记）。这些币种的主站循环让位，
     否则「主站按当前币种 1s 一拍」与「分屏按面板喂价」会把同一个币种播两遍。 */
  const splitHandledCoins = new Set();
  /* 分屏用：按币种取规则（当前币种直接用内存里那份，改动即时生效；其余币种每次现读，
     保证在主站改动后立刻跟上）。 */
  const loadVoiceRulesFor = (coin) =>
    normalizeCoin(coin) === activeCoin()
      ? voiceRules
      : parseVoiceRules(localStorage.getItem(voiceRuleStoreKey(coin)));
  const saveVoiceRules = () => {
    localStorage.setItem(voiceRuleStoreKey(), JSON.stringify(voiceRules));
    /* 同步页面设置供状态恢复；服务端不执行关闭页面后的接力播报。 */
    syncVoiceToServer();
  };
  /* v2.12.69：登录双向同步用 —— 直接读写内存中的语音规则并落盘。 */
  window.btcVoiceRulesAccess = { get: () => voiceRules, set: (arr) => { if (Array.isArray(arr)) { voiceRules = arr; saveVoiceRules(); } } };
  const syncVoiceToServer = () => {
    fetch("/api/voice/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        symbol: activeCoin(),
        settings: {
          enabled: Boolean(settings.enabled),
          livePriceEnabled: Boolean(settings.livePriceEnabled),
          interval: Number(settings.interval),
          voice: settings.edgeVoice,
        },
        personalEntries: Array.isArray(window.btcPersonalEntries)
          ? window.btcPersonalEntries
          : [],
        rules: voiceRules.map(({ satisfied, ...rule }) => rule),
      }),
    }).catch(() => {});
  };
  window.addEventListener("btc:personal-entries-changed", syncVoiceToServer);
  /* 心跳仅用于页面会话状态；心跳停止后服务端不会接力播报。 */
  setInterval(() => {
    if (settings.enabled)
      fetch("/api/voice/heartbeat", { method: "POST" }).catch(() => {});
  }, 5_000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && settings.enabled)
      fetch("/api/voice/heartbeat", { method: "POST" }).catch(() => {});
  });
  /* 读取已保存状态以便在当前页面恢复规则显示。 */
  setInterval(() => {
    fetch("/api/voice/state")
      .then((response) => response.json())
      .then((remoteState) => {
        let changed = false;
        for (const remote of remoteState?.rules || []) {
          const rule = voiceRules.find((item) => item.id === remote.id);
          if (
            rule &&
            remote.lastTriggeredAt &&
            rule.lastTriggeredAt !== remote.lastTriggeredAt
          ) {
            rule.lastTriggeredAt = remote.lastTriggeredAt;
            changed = true;
          }
        }
        if (changed) {
          localStorage.setItem(voiceRuleStoreKey(), JSON.stringify(voiceRules));
          renderVoiceRules();
        }
      })
      .catch(() => {});
  }, 10_000);
  /* 多币种：切换币种时重读该币种自己的语音规则。价格基准与短窗历史不再重置 —— 它们
     已改成「按币种各存一份」（runtimeFor），切回来时基准仍在，也不会跨币种误触发。 */
  window.addEventListener("btc:coin-changed", () => {
    voiceRules = loadVoiceRulesFromStorage();
    voiceRuleEditingId = null;
    renderVoiceRules();
    syncVoiceToServer();
  });
  const voiceRuleName = (kind, direction, positionSide = "long") =>
    ({
      price_reached: tx("价格达到", "Price reached"),
      price_above: tx("价格上涨至", "Price rises to"),
      price_below: tx("价格下跌至", "Price falls to"),
      long_liquidation: tx("做多爆仓价", "Long liquidation"),
      short_liquidation: tx("做空爆仓价", "Short liquidation"),
      price_move:
        direction === "both"
          ? tx("每上涨或下跌", "Every rise or drop of")
          : direction === "down"
            ? tx("每下跌", "Every drop of")
            : tx("每上涨", "Every rise of"),
      price_speed:
        direction === "both"
          ? tx("短时急涨／急跌", "Rapid move")
          : direction === "down"
            ? tx("短时急跌", "Rapid drop")
            : tx("短时急涨", "Rapid rise"),
      price_tick_move:
        direction === "both"
          ? tx("较前一次报价变动", "Difference from previous quote")
          : direction === "down"
            ? tx("较前一次报价下跌", "Drop since previous quote")
            : tx("较前一次报价上涨", "Rise since previous quote"),
      theoretical_liquidation_gap:
        positionSide === "short"
          ? tx("距做空理论强平价", "Distance from short theoretical liquidation")
          : tx("距做多理论强平价", "Distance from long theoretical liquidation"),
    })[kind] || tx("价格达到", "Price reached");
  const voiceRuleList = document.createElement("section");
  voiceRuleList.className = "voice-rule-list";
  voicePanelGrid.append(voiceRuleList);
  /* 左／中／右三栏宽度自由拖拽：拖动分隔条调节，宽度本地记忆，双击复位。 */
  const columnStore = "btc_voice_panel_columns_v1",
    columnDefaults = { left: 200, mid: 208 },
    columnMin = { left: 150, mid: 150, right: 210 },
    columnGap = 8,
    columnResizer = 8,
    panelColumns = { ...columnDefaults };
  try {
    Object.assign(
      panelColumns,
      JSON.parse(localStorage.getItem(columnStore) || "{}"),
    );
  } catch {}
  const saveColumns = () =>
      localStorage.setItem(columnStore, JSON.stringify(panelColumns)),
    applyColumns = () => {
      voicePanelGrid.style.setProperty(
        "--voice-col-left",
        `${Math.round(panelColumns.left)}px`,
      );
      voicePanelGrid.style.setProperty(
        "--voice-col-mid",
        `${Math.round(panelColumns.mid)}px`,
      );
    },
    clampColumns = () => {
      const total =
        voicePanelGrid.getBoundingClientRect().width ||
        voicePanelGrid.parentElement?.getBoundingClientRect().width ||
        0;
      const usable =
        total - columnGap * 4 - columnResizer * 2 - columnMin.right;
      if (usable < columnMin.left + columnMin.mid) return;
      panelColumns.left = Math.max(
        columnMin.left,
        Math.min(panelColumns.left, usable - columnMin.mid),
      );
      panelColumns.mid = Math.max(
        columnMin.mid,
        Math.min(panelColumns.mid, usable - panelColumns.left),
      );
    },
    setColumns = (left, mid) => {
      panelColumns.left = left;
      panelColumns.mid = mid;
      clampColumns();
      applyColumns();
    };
  const makeResizer = (key) => {
    const resizer = document.createElement("div");
    resizer.className = "voice-grid-resizer";
    resizer.dataset.resize = key;
    resizer.setAttribute("role", "separator");
    resizer.setAttribute("aria-orientation", "vertical");
    resizer.tabIndex = 0;
    resizer.title = tx(
      "拖动调节左右栏宽度，双击恢复默认",
      "Drag to resize columns, double-click to reset",
    );
    return resizer;
  };
  /* 注意 :scope > ——「配置语音规则/试听」那块也带 .voice-panel-group 类，
     但它嵌套在左栏内部；不限直接子元素会匹配到它导致 insertBefore 抛错，
     整个语音模块初始化中断（规则列表变空白）。 */
  const engineGroup = voicePanelGrid.querySelector(
      ":scope > .voice-panel-group:not(.voice-panel-toggles)",
    ),
    leftResizer = makeResizer("left"),
    midResizer = makeResizer("mid");
  voicePanelGrid.insertBefore(leftResizer, engineGroup || voiceRuleList);
  voicePanelGrid.insertBefore(midResizer, voiceRuleList);
  [leftResizer, midResizer].forEach((resizer) => {
    const isLeft = resizer.dataset.resize === "left";
    resizer.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      resizer.setPointerCapture?.(event.pointerId);
      resizer.classList.add("is-dragging");
      document.body.classList.add("voice-grid-resizing");
      const startX = event.clientX,
        startLeft = panelColumns.left,
        startMid = panelColumns.mid;
      const onMove = (moveEvent) => {
          const delta = moveEvent.clientX - startX;
          if (isLeft) setColumns(startLeft + delta, startMid);
          else setColumns(startLeft, startMid + delta);
        },
        onUp = () => {
          resizer.releasePointerCapture?.(event.pointerId);
          resizer.classList.remove("is-dragging");
          document.body.classList.remove("voice-grid-resizing");
          resizer.removeEventListener("pointermove", onMove);
          resizer.removeEventListener("pointerup", onUp);
          resizer.removeEventListener("pointercancel", onUp);
          saveColumns();
        };
      resizer.addEventListener("pointermove", onMove);
      resizer.addEventListener("pointerup", onUp);
      resizer.addEventListener("pointercancel", onUp);
    });
    resizer.addEventListener("keydown", (event) => {
      const step =
        event.key === "ArrowLeft" ? -12 : event.key === "ArrowRight" ? 12 : 0;
      if (!step) return;
      event.preventDefault();
      if (isLeft) setColumns(panelColumns.left + step, panelColumns.mid);
      else setColumns(panelColumns.left, panelColumns.mid + step);
      saveColumns();
    });
    resizer.addEventListener("dblclick", () => {
      setColumns(columnDefaults.left, columnDefaults.mid);
      saveColumns();
    });
  });
  const resyncColumns = () => {
    clampColumns();
    applyColumns();
  };
  if ("ResizeObserver" in window)
    new ResizeObserver(resyncColumns).observe(voicePanelGrid);
  else window.addEventListener("resize", resyncColumns);
  resyncColumns();
  const cooldownText = (value) => {
    const minutes = Number(value) || 0;
    if (minutes === 0) return tx("不冷却", "No cooldown");
    const duration =
      minutes === 0.5
        ? `30 ${tx("秒", "sec")}`
        : `${minutes} ${tx("分钟", "min")}`;
    return `${tx("冷却", "Cooldown")} ${duration}`;
  };
  const voiceRuleSpeechState = (rule) =>
    rule.lastTriggeredAt
      ? tx("等待下次播报", "Waiting for next alert")
      : tx("待触发", "Armed");
  const voiceRuleSpeechTitle = (rule) =>
    rule.lastTriggeredAt
      ? tx("此规则最近已触发播报；重复规则仍会继续监听。", "This rule has spoken recently; repeating rules remain armed.")
      : tx("此规则正在等待触发。", "This rule is armed and waiting to trigger.");
  const renderVoiceRules = () => {
    const rows = voiceRules
      .map(
        (rule) =>
          "<article" +
          (!rule.repeat && rule.lastTriggeredAt ? ' class="is-done"' : "") +
          '><span><b>' +
          voiceRuleName(rule.kind, rule.direction, rule.positionSide) +
          " " +
          Number(rule.targetPrice).toLocaleString("en-US", {
            maximumFractionDigits: 2,
          }) +
          "</b><small>" +
          (rule.kind === "price_move"
            ? tx(
                "以保存时的市价为起点；每次播报后重新计量。",
                "Starts from the saved market price and measures again after each alert. ",
              )
            : rule.kind === "price_speed"
              ? tx(
                  "在 " + rule.windowSeconds + " 秒观察窗口内触发。",
                  "Triggers within a " +
                    rule.windowSeconds +
                    " second window. ",
                )
              : rule.kind === "price_tick_move"
                ? tx(
                    "与连续收到的前一次报价比较。",
                    "Compares with the immediately previous received quote. ",
                  )
                : "") +
          (rule.repeat
            ? "重复播报 · " + cooldownText(rule.cooldownMinutes)
            : "仅播报一次") +
          (rule.lastTriggeredAt
            ? (rule.repeat
              ? " · 上次播报 "
              : " · 已播报 ") +
              new Date(rule.lastTriggeredAt).toLocaleTimeString("zh-CN", {
                hour12: false,
              })
            : "") +
          '</small></span><em class="' +
          (rule.lastTriggeredAt ? "muted" : "bull") +
          '" title="' +
          voiceRuleSpeechTitle(rule) +
          '">' +
          voiceRuleSpeechState(rule) +
          '</em><button type="button" class="rule-test" data-test-voice-rule="' +
          rule.id +
          '">测试触发</button><button type="button" class="rule-edit" data-edit-voice-rule="' +
          rule.id +
          '">编辑</button><button type="button" class="rule-remove" data-remove-voice-rule="' +
          rule.id +
          '">删除</button></article>',
      )
      .join("");
    voiceRuleList.innerHTML =
      "<div><b>" +
      tx("语音规则", "Voice rules") +
      "</b><small>" +
      tx(
        "首页保持打开时即由浏览器播报，无需打开本设置面板；页面关闭或电脑重启后停止播报。",
        "Speech runs while the home page is open; this settings panel does not need to remain open. It stops after the page closes or the computer restarts.",
      ) +
      "</small></div>" +
      (voiceRules.length
        ? '<div class="notification-rule-list">' + rows + "</div>"
        : "<small>" +
          tx("尚未配置语音规则。", "No voice rules configured.") +
          "</small>");
    voiceRuleList.querySelectorAll("[data-edit-voice-rule]").forEach(
      (button) =>
        (button.onclick = () =>
          showVoiceRuleModal(
            true,
            voiceRules.find((rule) => rule.id === button.dataset.editVoiceRule),
          )),
    );
    voiceRuleList.querySelectorAll("[data-test-voice-rule]").forEach(
      (button) =>
        (button.onclick = () => {
          const rule = voiceRules.find(
            (item) => item.id === button.dataset.testVoiceRule,
          );
          if (rule) testVoiceRule(rule);
        }),
    );
    voiceRuleList.querySelectorAll("[data-remove-voice-rule]").forEach(
      (button) =>
        (button.onclick = () => {
          voiceRules = voiceRules.filter(
            (rule) => rule.id !== button.dataset.removeVoiceRule,
          );
          saveVoiceRules();
          renderVoiceRules();
        }),
    );
  };
  const voiceRuleModal = document.createElement("div");
  voiceRuleModal.className = "alert-composer voice-rule-composer";
  voiceRuleModal.hidden = true;
  voiceRuleModal.innerHTML = `<section><header><b>${tx("配置语音规则", "Configure voice rule")}</b><button type="button" data-close-voice-rule>×</button></header><p class="alert-symbol">◉ <b>${tx("语音播报预警", "Voice alert")}</b></p><form id="voiceRuleForm"><label>${tx("播报条件", "Condition")}<select name="kind"><option value="price_reached">${tx("价格达到", "Price reached")}</option><option value="price_above">${tx("价格上涨至", "Price rises to")}</option><option value="price_below">${tx("价格下跌至", "Price falls to")}</option><option value="long_liquidation">${tx("做多爆仓价", "Long liquidation")}</option><option value="short_liquidation">${tx("做空爆仓价", "Short liquidation")}</option><option value="price_move">${tx("每上涨／下跌指定金额", "Every move by amount")}</option><option value="price_speed">${tx("短时间急涨／急跌", "Rapid move in a short window")}</option><option value="price_tick_move">${tx("与前一次报价变动差", "Difference from previous quote")}</option></select></label><label id="voiceRuleDirection" hidden>${tx("变动方向", "Move direction")}<select name="direction"><option value="up">${tx("上涨", "Up")}</option><option value="down">${tx("下跌", "Down")}</option><option value="both">${tx("上涨或下跌", "Up or down")}</option></select></label><label id="voiceRuleWindow" hidden>${tx("观察窗口", "Time window")}<input name="windowSeconds" type="number" inputmode="numeric" min="1" max="60" step="1" value="3"><em>${tx("秒", "sec")}</em></label><label><span id="voiceRuleTargetLabel">${tx("目标价格", "Target price")}</span><input name="target" type="number" inputmode="decimal" min="0" step="0.01" required placeholder="80000"><em id="voiceRuleTargetUnit">USDT</em></label><label>${tx("播报方式", "Playback")}<select name="repeat"><option value="once">${tx("仅播报一次", "Speak once")}</option><option value="repeat">${tx("重复播报", "Repeat")}</option></select></label><label id="voiceRuleCooldown" hidden>${tx("冷却时间", "Cooldown")}<select name="cooldown"><option value="0">${tx("不冷却", "No cooldown")}</option><option value="0.5">30 ${tx("秒", "sec")}</option><option value="1">1 ${tx("分钟", "min")}</option><option value="5">5 ${tx("分钟", "min")}</option><option value="10">10 ${tx("分钟", "min")}</option><option value="30">30 ${tx("分钟", "min")}</option></select></label><button class="alert-submit">${tx("保存语音规则", "Save voice rule")}</button></form></section>`;
  document.body.append(voiceRuleModal);
  voiceRuleModal
    .querySelector(".alert-symbol")
    .insertAdjacentHTML(
      "afterend",
      '<section id="voiceEntrySummary" class="voice-entry-summary"><div><b>市价</b><strong>--</strong></div><div class="voice-entry-values"></div></section>',
    );
  voiceRuleModal
    .querySelector('[name="kind"]')
    .insertAdjacentHTML(
      "beforeend",
      `<option value="theoretical_liquidation_gap">${tx("距理论强平价警告", "Theoretical liquidation distance")}</option>`,
    );
  voiceRuleModal
    .querySelector('[name="direction"]')
    .closest("label")
    .insertAdjacentHTML(
      "afterend",
      `<label id="voiceRulePositionSide" hidden>${tx("持仓方向", "Position side")}<select name="positionSide"><option value="long">${tx("做多", "Long")}</option><option value="short">${tx("做空", "Short")}</option></select></label>`,
    );
  const voiceRuleForm = voiceRuleModal.querySelector("#voiceRuleForm"),
    voiceRuleCooldown = voiceRuleModal.querySelector("#voiceRuleCooldown"),
    voiceRuleDirection = voiceRuleModal.querySelector("#voiceRuleDirection"),
    voiceRulePositionSide = voiceRuleModal.querySelector(
      "#voiceRulePositionSide",
    ),
    voiceRuleWindow = voiceRuleModal.querySelector("#voiceRuleWindow"),
    voiceEntrySummary = voiceRuleModal.querySelector("#voiceEntrySummary"),
    voiceRuleTargetLabel = voiceRuleModal.querySelector(
      "#voiceRuleTargetLabel",
    ),
    voiceRuleTargetUnit = voiceRuleModal.querySelector("#voiceRuleTargetUnit"),
    voiceRuleSubmit = voiceRuleModal.querySelector(".alert-submit");
  /* 理论强平价按「该币种自己的持仓」算（可选 coin：分屏替某个面板判定时必须传）。 */
  const theoreticalLiquidation = (side, coin) => {
    const entry = personalEntriesForCoin(coin).find(
      (item) => item?.side === side && Number(item?.price) > 0,
    );
    if (!entry) return null;
    const price = Number(entry.price),
      amount = Number(entry.amount),
      margin = Number(entry.margin),
      leverage = Number(entry.leverage),
      collateral =
        Number.isFinite(margin) && margin > 0
          ? margin
          : Number.isFinite(amount) && amount > 0 && leverage > 0
            ? amount / leverage
            : null,
      effectiveLeverage =
        Number.isFinite(amount) && amount > 0 && collateral
          ? amount / collateral
          : null;
    if (!Number.isFinite(effectiveLeverage) || effectiveLeverage <= 0)
      return null;
    return side === "short"
      ? price * (1 + 1 / effectiveLeverage - 0.005)
      : price * (1 - 1 / effectiveLeverage + 0.005);
  };
  const updateVoiceEntrySummary = () => {
    const current = Number(state?.ticker?.last),
      entries = (
        Array.isArray(window.btcPersonalEntries)
          ? window.btcPersonalEntries
          : typeof personalEntries !== "undefined"
            ? personalEntries
            : []
      ).filter(
        (entry) =>
          Number.isFinite(Number(entry?.price)) && Number(entry.price) > 0,
      );
    voiceEntrySummary.querySelector("b").textContent = tx(
      "市价",
      "Market price",
    );
    voiceEntrySummary.querySelector("strong").textContent = Number.isFinite(
      current,
    )
      ? current.toLocaleString("en-US", { maximumFractionDigits: 2 })
      : "--";
    voiceEntrySummary.querySelector(".voice-entry-values").innerHTML = entries
      .map((entry) => {
        const side = entry.side === "short" ? "short" : "long",
          liquidation = theoreticalLiquidation(side),
          entryText =
            side === "short"
              ? tx("做空买入价", "Short entry price")
              : tx("做多买入价", "Long entry price"),
          liqText =
            side === "short"
              ? tx("做空理论强平价", "Short theoretical liquidation")
              : tx("做多理论强平价", "Long theoretical liquidation");
        return `<span class="${side}">${entryText} <b>${Number(entry.price).toLocaleString("en-US", { maximumFractionDigits: 2 })}</b></span>${Number.isFinite(liquidation) ? `<button type="button" class="voice-theoretical-liquidation ${side}" data-voice-theoretical-liquidation="${side}" title="${tx("带入为爆仓价格规则", "Use as liquidation-price rule")}">${liqText} <b>${liquidation.toLocaleString("en-US", { maximumFractionDigits: 2 })}</b></button>` : ""}`;
      })
      .join("");
    voiceEntrySummary
      .querySelectorAll("[data-voice-theoretical-liquidation]")
      .forEach((button) => {
        button.onclick = () => {
          const side = button.dataset.voiceTheoreticalLiquidation,
            liquidation = theoreticalLiquidation(side);
          if (!Number.isFinite(liquidation)) return;
          voiceRuleForm.elements.kind.value =
            side === "short" ? "short_liquidation" : "long_liquidation";
          voiceRuleForm.elements.target.value = liquidation.toFixed(2);
          syncVoiceRuleForm();
        };
      });
  };
  const useVoiceMarketPrice = () => {
    if (
      [
        "price_move",
        "price_speed",
        "price_tick_move",
        "theoretical_liquidation_gap",
      ].includes(
        voiceRuleForm.elements.kind.value,
      )
    )
      return;
    const current = Number(state?.ticker?.last);
    if (Number.isFinite(current))
      voiceRuleForm.elements.target.value = current.toFixed(2);
  };
  voiceEntrySummary.querySelector("strong").title = tx(
    "点击填入目标价格",
    "Click to use as target price",
  );
  voiceEntrySummary.querySelector("strong").tabIndex = 0;
  voiceEntrySummary.querySelector("strong").onclick = useVoiceMarketPrice;
  voiceEntrySummary.querySelector("strong").onkeydown = (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      useVoiceMarketPrice();
    }
  };
  const syncVoiceRuleForm = () => {
    const kind = voiceRuleForm.elements.kind.value,
      move = kind === "price_move",
      speed = kind === "price_speed",
      tick = kind === "price_tick_move",
      theoreticalGap = kind === "theoretical_liquidation_gap",
      relative = move || speed || tick;
    if (relative && voiceRuleForm.elements.repeat.value === "once")
      voiceRuleForm.elements.repeat.value = "repeat";
    voiceRuleDirection.hidden = !relative;
    voiceRulePositionSide.hidden = !theoreticalGap;
    voiceRuleWindow.hidden = !speed;
    voiceRuleCooldown.hidden = voiceRuleForm.elements.repeat.value !== "repeat";
    voiceRuleTargetLabel.textContent = relative
      ? tx("涨跌金额", "Move amount")
      : theoreticalGap
        ? tx("距理论强平价的警戒差额", "Warning distance from theoretical liquidation")
      : kind.includes("liquidation")
        ? tx("爆仓价格", "Liquidation price")
        : tx("目标价格", "Target price");
    voiceRuleTargetUnit.textContent = "USDT";
    voiceRuleForm.elements.target.placeholder = speed
      ? "500"
      : relative
        ? "100"
        : theoreticalGap
          ? "500"
        : kind.includes("liquidation")
          ? "75000"
          : "80000";
    voiceEntrySummary.querySelector("strong").title = theoreticalGap
      ? tx(
          "系统会实时重算所选持仓的理论强平价；填写距强平价的警戒差额，例如 500。",
          "The app recalculates the selected position's theoretical liquidation price; enter a warning distance, e.g. 500.",
        )
      : relative
      ? speed
        ? tx(
            "此规则比较当前价格与设定秒数前的价格；填写涨跌金额，例如 500。",
            "This rule compares the current price with the price from the selected number of seconds ago; enter a move amount, e.g. 500.",
          )
        : tick
          ? tx(
              "此规则比较当前价格与本页连续收到的前一次报价；填写差额，例如 100。",
              "This rule compares the current price with the immediately previous quote received on this page; enter a difference, e.g. 100.",
            )
          : tx(
              "此规则保存时自动采用市价作为基准；此处填写涨跌金额，例如 100。",
              "This rule uses the market price at save time as its baseline; enter a move amount here, e.g. 100.",
            )
      : tx("点击填入目标价格", "Click to use as target price");
  };
  const showVoiceRuleModal = (open, rule = null) => {
    voiceRuleModal.hidden = !open;
    if (!open) {
      voiceRuleEditingId = null;
      return;
    }
    voiceRuleForm.reset();
    voiceRuleEditingId = rule?.id || null;
    if (rule) {
      voiceRuleForm.elements.kind.value = rule.kind;
      voiceRuleForm.elements.direction.value = rule.direction || "up";
      voiceRuleForm.elements.positionSide.value =
        rule.positionSide === "short" ? "short" : "long";
      voiceRuleForm.elements.target.value = rule.targetPrice;
      voiceRuleForm.elements.windowSeconds.value = rule.windowSeconds || 3;
      voiceRuleForm.elements.repeat.value = rule.repeat ? "repeat" : "once";
      voiceRuleForm.elements.cooldown.value = rule.cooldownMinutes || 0;
    }
    voiceRuleSubmit.textContent = rule
      ? tx("保存修改", "Save changes")
      : tx("保存语音规则", "Save voice rule");
    syncVoiceRuleForm();
    updateVoiceEntrySummary();
  };
  voiceRuleModal.querySelector("[data-close-voice-rule]").onclick = () =>
    showVoiceRuleModal(false);
  voiceRuleModal.onclick = (event) => {
    if (event.target === voiceRuleModal) showVoiceRuleModal(false);
  };
  voiceRuleForm.elements.repeat.onchange = () => {
    voiceRuleCooldown.hidden = voiceRuleForm.elements.repeat.value !== "repeat";
  };
  voiceRuleForm.elements.kind.onchange = syncVoiceRuleForm;
  voiceRuleForm.onsubmit = (event) => {
    event.preventDefault();
    const targetPrice = Number(voiceRuleForm.elements.target.value),
      kind = voiceRuleForm.elements.kind.value,
      repeat = voiceRuleForm.elements.repeat.value === "repeat",
      cooldownMinutes = repeat
        ? Math.max(0, Number(voiceRuleForm.elements.cooldown.value) || 0)
        : 0,
      windowSeconds = Math.min(
        60,
        Math.max(1, Number(voiceRuleForm.elements.windowSeconds.value) || 3),
      ),
      existing = voiceRules.find((rule) => rule.id === voiceRuleEditingId),
      direction = ["down", "both"].includes(
        voiceRuleForm.elements.direction.value,
      )
        ? voiceRuleForm.elements.direction.value
        : "up",
      positionSide =
        voiceRuleForm.elements.positionSide.value === "short"
          ? "short"
          : "long";
    if (!Number.isFinite(targetPrice) || targetPrice <= 0) return;
    if (
      kind === "theoretical_liquidation_gap" &&
      !Number.isFinite(theoreticalLiquidation(positionSide))
    ) {
      status.textContent = tx(
        "请先在“我的持仓”中填写该方向的开仓价、持仓量及保证金或杠杆。",
        "Set that position's entry price, size, and margin or leverage in My Position first.",
      );
      return;
    }
    const anchorPrice =
      kind === "price_move" ? Number(state?.ticker?.last) : null;
    if (kind === "price_move" && !Number.isFinite(anchorPrice)) return;
    const updated = {
      id: existing?.id || crypto.randomUUID(),
      updatedAt: Date.now(),
      kind,
      targetPrice,
      direction,
      positionSide,
      anchorPrice,
      windowSeconds,
      repeat,
      cooldownMinutes,
      lastTriggeredAt: null,
    };
    if (existing)
      voiceRules = voiceRules.map((rule) =>
        rule.id === existing.id ? updated : rule,
      );
    else voiceRules.push(updated);
    saveVoiceRules();
    showVoiceRuleModal(false);
    renderVoiceRules();
  };
  $("voiceAlertAddRule").onclick = () => showVoiceRuleModal(true);
  // 各规则种类的「命中」判定：抽出为查表，替代长 if 链（见 CODE_AUDIT_REPORT.md Step 5）。
  // 表内每个分支与原有 if 块逐字节等价；表外的默认兜底处理 price_above /
  // price_below / long_liquidation / short_liquidation 这一组「价格越过类」规则，
  // 语义与原 if 链完全一致。
  /* 匹配器统一签名 (rule, from, to, now, amount, coin)；coin 只在分屏替某个面板判定时
     才非空 —— 理论强平价要用该币种自己的持仓算。 */
  const VOICE_MATCHERS = {
    theoretical_liquidation_gap(rule, from, to, now, amount, coin) {
      const side = rule.positionSide === "short" ? "short" : "long",
        liquidation = theoreticalLiquidation(side, coin);
      if (!Number.isFinite(liquidation)) return false;
      const satisfied =
        side === "short" ? to >= liquidation - amount : to <= liquidation + amount;
      if (!satisfied) return false;
      // 双仓场景：若反方向也接近强平，只播报当前价格离得更近（更危险）的一边，
      // 避免价格上涨时做空盈利一边的语音播报干扰。
      const otherSide = side === "short" ? "long" : "short",
        otherLiquidation = theoreticalLiquidation(otherSide, coin);
      if (Number.isFinite(otherLiquidation)) {
        const myGap = Math.abs(to - liquidation),
          otherGap = Math.abs(to - otherLiquidation);
        if (otherGap < myGap) return false;
      }
      return true;
    },
    price_move(rule, from, to, now, amount) {
      const anchor = Number(rule.anchorPrice),
        delta = to - anchor;
      return (
        Number.isFinite(anchor) &&
        (rule.direction === "both"
          ? Math.abs(delta) >= amount
          : rule.direction === "down"
            ? delta <= -amount
            : delta >= amount)
      );
    },
    price_speed(rule, from, to, now, amount, coin, history) {
      const cutoff =
          now -
          Math.min(60, Math.max(1, Number(rule.windowSeconds) || 3)) * 1_000,
        base = (history || (coin ? runtimeFor(coin).history : activeRuntime().history)).find(
          (point) => point.ts >= cutoff,
        ),
        delta = base ? to - base.price : 0;
      return (
        base &&
        (rule.direction === "both"
          ? Math.abs(delta) >= amount
          : rule.direction === "down"
            ? delta <= -amount
            : delta >= amount)
      );
    },
    price_tick_move(rule, from, to, now, amount) {
      const delta = to - from;
      return rule.direction === "both"
        ? Math.abs(delta) >= amount
        : rule.direction === "down"
          ? delta <= -amount
          : delta >= amount;
    },
    price_reached(rule, from, to, now, amount) {
      return (
        from === rule.targetPrice ||
        to === rule.targetPrice ||
        (from - rule.targetPrice) * (to - rule.targetPrice) < 0
      );
    },
  };
  /* coin / history 只在分屏替某个面板判定时传入；主站自己不传，走当前币种。 */
  const voiceMatched = (rule, from, to, now, coin, history) => {
    const amount = Number(rule.targetPrice);
    const matcher = VOICE_MATCHERS[rule.kind];
    if (matcher) return matcher(rule, from, to, now, amount, coin, history);
    /* 价格越过类规则按“状态”而非“穿越瞬间”判定：创建规则时价格已在目标之外
       （例如现价已高于“上涨至 79865”的目标）也必须立即播报，否则规则会静默失效。 */
    const up = rule.kind === "price_above" || rule.kind === "short_liquidation";
    return up ? to >= rule.targetPrice : to <= rule.targetPrice;
  };
  const voiceDirection = (rule, from, to, now, coin, history) => {
    if (rule.kind === "theoretical_liquidation_gap")
      return rule.positionSide === "short" ? "up" : "down";
    if (
      rule.kind === "price_below" ||
      rule.kind === "long_liquidation"
    )
      return "down";
    if (
      rule.kind === "price_above" ||
      rule.kind === "short_liquidation"
    )
      return "up";
    if (rule.kind === "price_reached") return to >= from ? "up" : "down";
    if (rule.direction === "up" || rule.direction === "down")
      return rule.direction;
    if (rule.kind === "price_move")
      return to >= Number(rule.anchorPrice) ? "up" : "down";
    if (rule.kind === "price_speed") {
      const cutoff =
          now -
          Math.min(60, Math.max(1, Number(rule.windowSeconds) || 3)) * 1_000,
        base = (history || (coin ? runtimeFor(coin).history : activeRuntime().history)).find(
          (point) => point.ts >= cutoff,
        );
      return !base || to >= base.price ? "up" : "down";
    }
    return to >= from ? "up" : "down";
  };
  // 强平类规则（含理论强平）共用一套提示音；其余按涨跌方向选音。
  // Centralised so the kind list isn't duplicated across the voice engine.
  const LIQUIDATION_KINDS = new Set([
    "long_liquidation",
    "short_liquidation",
    "theoretical_liquidation_gap",
  ]);
  const voiceChimeFor = (rule, direction) => {
    if (LIQUIDATION_KINDS.has(rule.kind)) return settings.liquidationChimeType;
    return direction === "down" ? settings.dropChimeType : settings.riseChimeType;
  };
  /* 可选入参 coin：分屏替某个面板播报时传入该面板的币种 —— 播报语里的币种代码、理论
     强平价与持仓对比句都按那个币种取，不能跟当前币种走。 */
  const voiceRuleMessage = (rule, current, direction, coinParam) => {
    const target = Number(rule.targetPrice).toLocaleString("en-US", {
        maximumFractionDigits: 2,
      }),
      currentText = Number(current).toLocaleString("en-US", {
        maximumFractionDigits: 2,
      }),
      /* 多币种播报（v2.12.10）：规则播报语一律带币种英文代码，规则名与「当前价格」
         两处都带上，单独听到一句也能判断是哪个币种触发的。 */
      coin = voiceCoinLabel(coinParam);
    const comparisonText = personalEntryComparisons(current, coinParam).join(" ");
    let message;
    if (rule.kind === "theoretical_liquidation_gap") {
      const side = rule.positionSide === "short" ? "short" : "long",
        liquidation = theoreticalLiquidation(side, coinParam),
        gap = Number.isFinite(liquidation)
          ? Math.abs(current - liquidation).toLocaleString("en-US", {
              maximumFractionDigits: 2,
            })
          : "--";
      // 若持仓填写了名义金额，可估算当前亏损。
      const entry = personalEntriesForCoin(coinParam).find(
          (item) => item?.side === side && Number(item?.price) > 0,
        ),
        entryPrice = entry ? Number(entry.price) : null,
        notional =
          entry &&
          Number.isFinite(Number(entry.amount)) &&
          Number(entry.amount) > 0
            ? Number(entry.amount)
            : null;
      let lossText = "";
      if (
        Number.isFinite(entryPrice) &&
        entryPrice > 0 &&
        Number.isFinite(notional) &&
        notional > 0
      ) {
        const pnl =
          side === "short"
            ? (notional * (entryPrice - current)) / entryPrice
            : (notional * (current - entryPrice)) / entryPrice;
        const loss = -pnl;
        if (loss > 0) {
          const lossAmount = loss.toLocaleString("en-US", {
            maximumFractionDigits: 2,
          });
          lossText =
            uiLang === "zh"
              ? `约亏损 ${lossAmount} 美元。`
              : `Estimated loss ${lossAmount} USD. `;
        }
      }
      message = uiLang === "zh"
        ? `${coin} ${side === "short" ? "做空" : "做多"}理论强平价警告。理论强平价 ${Number.isFinite(liquidation) ? liquidation.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "暂不可用"}。当前 ${coin} 价格 ${currentText}，距强平价 ${gap}。${lossText}`
        : `${coin} ${side === "short" ? "Short" : "Long"} theoretical liquidation warning. The theoretical liquidation price is ${Number.isFinite(liquidation) ? liquidation.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "unavailable"}. Current ${coin} price is ${currentText}, ${gap} from liquidation. ${lossText}`;
    } else if (rule.kind === "price_tick_move")
      message = uiLang === "zh"
        ? `${coin} 价格跳动提醒。当前 ${coin} 价格，${currentText}。较前一次报价${direction === "down" ? "下跌" : "上涨"} ${target}。`
        : `${coin} price jump alert. Current ${coin} price is ${currentText}. It moved ${direction === "down" ? "down" : "up"} ${target} from the previous quote.`;
    else if (rule.kind === "price_speed")
      message = uiLang === "zh"
        ? `${coin} 快速价格变动提醒。当前 ${coin} 价格，${currentText}。价格在 ${rule.windowSeconds} 秒内${direction === "down" ? "急跌" : "急涨"} ${target}。`
        : `${coin} rapid price movement alert. Current ${coin} price is ${currentText}. Price moved ${direction === "down" ? "down" : "up"} ${target} within ${rule.windowSeconds} seconds.`;
    else if (rule.kind === "price_move")
      message = uiLang === "zh"
        ? `${coin} 价格变动提醒。当前 ${coin} 价格，${currentText}。价格已${direction === "down" ? "下跌" : "上涨"} ${target}。`
        : `${coin} price movement alert. Current ${coin} price is ${currentText}. Price has moved ${direction === "down" ? "down" : "up"} ${target}.`;
    else
      message = uiLang === "zh"
        ? `${coin} 价格预警。当前 ${coin} 价格，${currentText}。已触发${voiceRuleName(rule.kind)}，${target}。`
        : `${coin} price alert. Current ${coin} price is ${currentText}. ${voiceRuleName(rule.kind)} ${target} triggered.`;
    return comparisonText ? `${message}${comparisonText}` : message;
  };
  /* 规则的展示名（与规则列表标题一致）：「正在播报/已播报」状态行复用。 */
  const voiceRuleLabel = (rule) =>
    `${voiceRuleName(rule.kind, rule.direction, rule.positionSide)} ${Number(rule.targetPrice).toLocaleString("en-US", {
      maximumFractionDigits: 2,
    })}`;
  /* 规则真实触发时更新状态文字；播报按钮由实际播放开始／结束事件同步。 */
  const announceVoiceTrigger = (rule) => {
    status.textContent = tx(`已播报：${voiceRuleLabel(rule)}`, `Spoke: ${voiceRuleLabel(rule)}`);
  };
  const testVoiceRule = (rule) => {
    const current = Number(state?.ticker?.last);
    if (!Number.isFinite(current)) {
      status.textContent = tx("实时价格尚未加载", "Live price is not loaded");
      return;
    }
    const direction = voiceDirection(
      rule,
      current,
      current,
      Date.now(),
    ),
      wasEnabled = settings.enabled;
    settings.enabled = true;
    say(voiceRuleMessage(rule, current, direction), {
      chimeType: voiceChimeFor(rule, direction),
      label: voiceRuleLabel(rule),
      onFailure: () => {
        status.textContent = tx(
          "规则测试失败：请检查本机音量或切换系统语音。",
          "Rule test failed: check local volume or switch to system voice.",
        );
      },
    });
    settings.enabled = wasEnabled;
    status.textContent = tx("正在测试该规则…", "Testing this rule…");
  };
  /* ══ 语音引擎的「一拍」═══════════════════════════════════════════════════════
   * 把某个币种的最新价喂进来，按【该币种自己的规则】判定并排队播报。两条路都走这里：
   *   · 主站自己：每 1s 拿 state.ticker.last（当前币种）；
   *   · 分屏（多币种并行监控）：每个面板把各自币种的价格喂进来（window.btcVoiceEngine.feedPrice）。
   * 运行态（上一拍价 / 61 秒价格历史）按币种各存一份，跨币种互不干扰；播报本身一律走
   * 同一个引擎（引擎 / 音色 / 音量 / 提示音全部共用主站设置）。
   * rankBase：分屏里按「币种顺序」把某个币种的整体优先级垫高/压低（越小越先播）。 */
  const runVoiceTick = ({ coin, current, rules, persist, rankBase = 0, applyUi = false }) => {
    const slot = runtimeFor(coin),
      now = Date.now();
    slot.history.push({ ts: now, price: current });
    slot.history = slot.history.filter((point) => point.ts >= now - 61_000);
    if (slot.prev === null) {
      slot.prev = current;
      return 0;
    }
    /* 异常报价跳变保护：单拍价格不可能合法地跳 3% 以上，只有「页面刚打开时先拿到本地
       快照价（或行情源短暂串到别的币种）」这类坏读数才会如此。坏读数一旦进入规则判定，
       所有「价格达到／越过」类规则会在同一拍被同时判成穿越 —— 实测 09:44:39.433 有 6 条
       规则在同一毫秒全部播报（当时 BTC 实际 81,43x，不可能同时穿越 74,500~80,300 六个
       价位）。这一拍只用来把基准对齐到新价格，不参与任何规则判定。 */
    if (slot.prev > 0 && Math.abs(current - slot.prev) / slot.prev > 0.03) {
      slot.prev = current;
      return 0;
    }
    const prev = slot.prev,
      triggeredBatch = [];
    if (settings.enabled)
      for (const rule of rules) {
        if (!rule.repeat && rule.lastTriggeredAt) continue;
        const satisfied = voiceMatched(rule, prev, current, now, coin, slot.history);
        /* 冷却时间对「重复播报」规则是唯一的闸门 —— 包括每一次新的边沿。
           曾经的写法是 freshEdge（“上一拍不满足、这一拍满足”）直接短路冷却：对状态类
           规则（上涨至／下跌至，持续满足时 satisfied 恒为真）没问题，但 price_reached
           （价格达到）这类穿越规则的 satisfied 只在穿越那一拍为真、紧接着就回到 false，
           于是价格在目标位附近来回震荡时每一次穿越都被当成“新边沿”立即播报，冷却形同
           虚设（实测设了 5 分钟冷却的「价格达到 81,000」在 18 秒内播报两次；当时价格在
           81,000 上下 ±40 反复穿越，32 分钟内穿越 15 次）。现在：重复规则首次触发照旧
           立即出声，之后一律等冷却（不冷却也为 30 秒下限）；一次性规则语义不变，仍由
           上面的 continue 保证只播一次。 */
        const cooldown = rule.repeat
          ? Math.max(
              30_000,
              Math.max(0, Number(rule.cooldownMinutes) || 0) * 60_000,
            )
          : 0;
        const cooldownReady =
          !rule.lastTriggeredAt || now - rule.lastTriggeredAt >= cooldown;
        /* 一次性规则到这一步时 lastTriggeredAt 必为空（上面已 continue），恒为真。 */
        if (satisfied && (rule.repeat ? cooldownReady : true)) {
          const direction = voiceDirection(rule, prev, current, now, coin, slot.history);
          rule.lastTriggeredAt = now;
          if (rule.kind === "price_move" && rule.repeat)
            rule.anchorPrice = current;
          persist?.(rules);
          triggeredBatch.push({ rule, direction });
        }
        rule.satisfied = satisfied;
      }
    /* 同一秒内多条规则同时命中：按「播报优先级」排序后依次入队播报，
       而不是互相掐掉（此前数组靠后的规则会直接 cancel 前面的）。
       分屏里 rankBase 把「币种顺序」放在规则优先级之前（1e6 一档）。 */
    triggeredBatch
      .map((item, index) => ({
        ...item,
        rank: rankBase + speechRankOfRule(item.rule) * 1000 + index,
      }))
      .sort((a, b) => a.rank - b.rank)
      .forEach(({ rule, direction, rank }) => {
        enqueueSpeech(voiceRuleMessage(rule, current, direction, coin), {
          chimeType: voiceChimeFor(rule, direction),
          label: voiceRuleLabel(rule),
          onStarted: () => announceVoiceSpeaking(coin, true),
          onEnded: () => announceVoiceSpeaking(coin, false),
          onFailure: () => announceVoiceSpeaking(coin, false),
        }, rank);
        announceVoiceTrigger(rule);
      });
    if (triggeredBatch.length && applyUi) renderVoiceRules();
    slot.prev = current;
    return triggeredBatch.length;
  };
  /* 分屏里某个币种的播报开始 / 结束 —— 面板喇叭的「播报中」动效与设置面板的高亮都听它。 */
  const announceVoiceSpeaking = (coin, speaking) => {
    try {
      window.dispatchEvent(
        new CustomEvent("btc:voice-speaking", { detail: { coin: normalizeCoin(coin), speaking: !!speaking } }),
      );
    } catch {}
  };
  setInterval(() => {
    updateVoiceEntrySummary();
    const current = state?.ticker?.last;
    if (!Number.isFinite(current)) return;
    const coin = activeCoin();
    /* 分屏打开且这个币种正由分屏喂价时，跳过主站这条 —— 否则同一个币种会被两条路各播一次。 */
    if (splitHandledCoins.has(coin)) return;
    runVoiceTick({ coin, current, rules: voiceRules, persist: saveVoiceRules, applyUi: true });
  }, 1_000);
  window.addEventListener("btc:voice-language-changed", () => {
    filterEdgeVoices();
    renderPriority();
    render();
  });
  /* 「添加预警」里勾选“触发时语音播报”的规则在触发时会派发该事件——
     此前没有任何监听者，语音从不发声。这里补上播报。 */
  window.addEventListener("btc:voice-alert", (event) => {
    const rule = event.detail?.rule;
    if (!rule || !settings.enabled) return;
    const price = Number(event.detail?.price),
      current = Number.isFinite(price) ? price : state?.ticker?.last;
    if (!Number.isFinite(current)) return;
    const direction =
      rule.kind === "price_below" || rule.kind === "long_liquidation"
        ? "down"
        : "up";
    say(voiceRuleMessage({ ...rule, direction }, current, direction), {
      chimeType: voiceChimeFor(rule, direction),
      label: voiceRuleLabel({ ...rule, direction }),
    });
  });
  if (supported) {
    window.speechSynthesis.addEventListener?.("voiceschanged", populateVoices);
    populateVoices();
    setTimeout(populateVoices, VOICE_LIST_POPULATE_DELAY_MS);
  }
  setInterval(() => {
    /* 分屏打开时，屏幕上的币种由分屏按各自面板喂价播报（含定时实时价），主站这条让位，
       否则同一个币种的实时价会被念两遍。 */
    if (splitHandledCoins.has(activeCoin())) return;
    speakPrice(false);
  }, 1_000);
  filterEdgeVoices();
  renderVoiceRules();
  render();
  syncVoiceToServer();

  /* ══ 供分屏（多币种并行监控）调用的接口 ══════════════════════════════════════
   * 分屏的每个面板把「自己币种的最新价」喂进 feedPrice()，这里就用【该币种自己的语音
   * 规则】判定、用【主站这一套引擎 / 音色 / 音量 / 提示音】发声 —— 与不分屏页面完全同源；
   * 多个币种同时触发时，按 split-mode.js 给的币种顺序（rankBase）依次播报。
   * 分屏设置面板里的引擎控件直接读写主站那几个控件（同一份设置），所以两边永远一致。 */
  window.btcVoiceEngine = {
    /* 分屏开着哪些币种：这些币种的主站循环让位（分屏接管）。 */
    setSplitCoins(coins) {
      splitHandledCoins.clear();
      (Array.isArray(coins) ? coins : []).forEach((coin) => {
        try {
          splitHandledCoins.add(normalizeCoin(coin));
        } catch {}
      });
    },
    /* 喂一拍价：返回本条命中的规则数。rankBase = 币种顺序 × 1e6（越小越先播）。 */
    feedPrice(coin, price, rankBase = 0) {
      let key;
      try {
        key = normalizeCoin(coin);
      } catch {
        return 0;
      }
      const value = Number(price);
      if (!Number.isFinite(value) || value <= 0) return 0;
      /* 记下最近一次喂进来的价：面板的「全部播报」要在没开定时播报时也能念出这个价。 */
      runtimeFor(key).lastPrice = value;
      const fired = runVoiceTick({
        coin: key,
        current: value,
        rules: loadVoiceRulesFor(key),
        rankBase,
        persist:
          key === activeCoin()
            ? saveVoiceRules
            : (rules) =>
                localStorage.setItem(voiceRuleStoreKey(key), JSON.stringify(rules)),
      });
      /* 定时播报实时价也按币种各自计时（共用 lastSpokenAt 会互相顶掉间隔）。 */
      speakLiveFor(key, value, { rankBase });
      return fired;
    },
    /* 立刻念一句该币种的实时价（分屏「全部播报」/ 单币试听）。price 省略时用最近一次喂价。 */
    speakLive(coin, price, { force = true, rankBase = 0 } = {}) {
      let key;
      try {
        key = normalizeCoin(coin);
      } catch {
        return false;
      }
      const value = Number.isFinite(Number(price))
        ? Number(price)
        : runtimeFor(key).lastPrice;
      return speakLiveFor(key, value, { force, rankBase });
    },
    /* 只读：该币种配置了几条语音规则（分屏面板据此提示「未配置规则」）。 */
    ruleCount: (coin) => {
      try {
        return loadVoiceRulesFor(normalizeCoin(coin)).length;
      } catch {
        return 0;
      }
    },
    master: () => Boolean(settings.enabled),
    /* 只读诊断：当前有哪些币种由分屏接管（主站循环对这些币种让位）。 */
    splitCoins: () => [...splitHandledCoins],
  };
}, 0);
}
