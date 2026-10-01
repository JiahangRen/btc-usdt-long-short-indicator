// Research hyper-parameter configuration.
// 研究超参配置。
//
// Extracted from server.mjs so the main server AND the training worker thread
// share one source of truth and can never drift apart. This module is pure:
// no database, no network, no mutable module state — safe to evaluate inside a
// Worker thread.
// 从 server.mjs 抽出，让主服务与训练 Worker 线程共用同一份配置、永不漂移。
// 本模块是纯的：无数据库、无网络、无可变模块状态，可在 Worker 线程里安全求值。

const RESEARCH_TUNING_DEFAULTS = {
  // Chop band: |move| <= sigmaMultiple * sigma * sqrt(horizon) is graded flat.
  // 震荡带：|涨跌| <= sigmaMultiple × σ × √周期 判为 flat。
  theta: { sigmaMultiple: 1.15, floor: 0.0005, lookback: 20 },
  // Nearest-neighbour pool (the analogue distribution that owns the flat probability).
  // 近邻池（决定 flat 概率的类比分布）。
  analogue: {
    distance: { short: 20, medium: 12, volatility: 18, trend: 8 },
    regimeMinPool: 60, scaleQuantile: 0.35, medianQuantile: 0.5,
    quantiles: { p10: 0.1, p50: 0.5, p90: 0.9 },
  },
  // Fusion temperature model: logistic + boosted stumps, then Platt scaling.
  // 融合温度模型：逻辑回归 + 提升树桩，再做 Platt 校准。
  fusion: {
    baseWidth: 8, minSeries: 260, minRows: 180, minDirectional: 30, minDirectionalFloor: 6,
    featureLookback: 20, featureStart: 24, standardizeClamp: 6,
    split: { train: 0.6, calibration: 0.8 },
    logistic: { epochs: 180, rate: 0.012, rateDecay: 90 },
    trees: { rounds: 24, rate: 0.14, minLeaf: 20, fractions: [0.2, 0.4, 0.6, 0.8] },
    treeWeight: { trendThreshold: 1.1, volatileThreshold: 0.006, trending: 0.62, normal: 0.5 },
    platt: { epochs: 220, rate: 0.018, rateDecay: 100 },
    calibrationBins: 10,
  },
  // Calendar features (kept for ablation only; they carry no directional edge).
  // 日历特征（仅为消融保留，对方向没有增量）。
  calendarFeatures: { spanHours: 720, activeWindowHours: 24 },
  // Perpetual funding-rate features, kept for the same reason: to be measured, not assumed. The
  // window is counted in settlements, not hours - the exchange settles every eight hours, so 90
  // settlements is a 30-day lookback. `levelScale` maps a raw rate onto (-1,1); BTC perp funding
  // sits near 0.01% in calm tape and reaches ~0.1% at a crowding extreme.
  // 永续资金费率特征，保留它的理由同上：为了被测量，而不是被假定。窗口按结算次数计而不是小时 ——
  // 交易所每 8 小时结算一次，所以 90 次结算即 30 天回看。levelScale 把原始费率映射到 (-1,1)；
  // BTC 永续资金费率在平静行情里约 0.01%，拥挤到极端时能到 0.1% 上下。
  funding: { window: 90, recent: 3, clamp: 4, levelScale: 0.0005, cycleHours: 8 },
  // Per-horizon definitions. cap bounds the expected-return adjustment; minDirectional is the
  // directional-sample floor handed to the trainer (daily tape is flat most of the time).
  // 各周期定义。cap 限制预期收益位移的幅度；minDirectional 是交给训练器的方向样本下限
  // （日线大部分时间在震荡）。
  horizons: {
    '15m': { label: '约 15 分钟', horizon: 1, interval: '15m', cap: 0.015, minDirectional: 30 },
    '1h':  { label: '约 1 小时', horizon: 4, interval: '15m', cap: 0.03,  minDirectional: 30 },
    '4h':  { label: '约 4 小时', horizon: 16, interval: '15m', cap: 0.05, minDirectional: 30 },
    '1d':  { label: '约 1 天', horizon: 1, interval: '1d', cap: 0.12, minDirectional: 12 },
  },
  // Live blend: analogue weight by regime, then a logit tilt from news / sentiment / microstructure.
  // 实时融合：按市场状态给近邻权重，再用新闻 / 情绪 / 微观结构做 logit 位移。
  blend: {
    analogueWeight: { range: 0.62, volatile: 0.42, normal: 0.48, volatileThreshold: 0.006 },
    tilt: { news: 0.22, sentiment: 0.12, microstructure: 0.18, microstructureDaily: 0.07 },
    horizonWeight: {
      '15m': { news: 0.12, sentiment: 0.04, microstructure: 0.14 },
      '1h':  { news: 0.12, sentiment: 0.04, microstructure: 0.12 },
      '4h':  { news: 0.12, sentiment: 0.04, microstructure: 0.09 },
      '1d':  { news: 0.25, sentiment: 0.08, microstructure: 0.025 },
    },
    probabilityClamp: { low: 0.05, high: 0.95, classLow: 0.02, classHigh: 0.95 },
    consistency: { neighbourDelta: 0.18, dampFactor: 0.65, volatilityFloor: 0.002, volatilityUnitFloor: 0.001 },
    eventRisk: { lookaheadHours: 24, rangeMultiplier: 1.35 },
  },
  // 历史上这里还有四组参数：gates（独立样本门槛，v2.12.44 前还承担候选升级判定）、
  // economics（记分卡成本模型）、ablation（消融判定阈值）—— 以及上方的 replay（回放预热）。
  // 回放/消融/宏观事件三个研究面板已随 v2.12.45 整体移除，这些参数没有任何读取方，故删除
  // （见 scripts/check-tuning-wiring.mjs 接线自检；记分卡本身已在 v2.12.44 移除）。
  // Four parameter groups used to live here: gates (independent-sample gate, and until v2.12.44
  // the candidate promotion gate), economics (scorecard cost model), ablation (verdict
  // thresholds) — plus the replay warm-up above. The replay / ablation / macro-event panels were
  // removed outright in v2.12.45, nothing reads these anymore, so they are gone too (see
  // scripts/check-tuning-wiring.mjs; the scorecard itself was removed in v2.12.44).
};
// Deep-merge plain objects; arrays and scalars are replaced wholesale so a caller can shorten a list.
// 深合并普通对象；数组与标量整体替换，这样调用方可以缩短一个列表。
function deepMergeTuning(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? base : patch;
  const out = Array.isArray(base) ? [...base] : { ...(base && typeof base === 'object' ? base : {}) };
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key];
    out[key] = current && typeof current === 'object' && !Array.isArray(current) && value && typeof value === 'object' && !Array.isArray(value)
      ? deepMergeTuning(current, value) : value;
  }
  return out;
}
function deepFreezeTuning(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreezeTuning); Object.freeze(value); }
  return value;
}
function readTuningOverride() {
  const raw = process.env.BTC_RESEARCH_TUNING;
  if (!raw || !raw.trim()) return { patch: null, error: null };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { patch: null, error: 'BTC_RESEARCH_TUNING 必须是 JSON 对象' };
    return { patch: parsed, error: null };
  } catch (error) { return { patch: null, error: `BTC_RESEARCH_TUNING 解析失败：${error.message}` }; }
}
const RESEARCH_TUNING_OVERRIDE = readTuningOverride();
const RESEARCH_TUNING = deepFreezeTuning(RESEARCH_TUNING_OVERRIDE.patch
  ? deepMergeTuning(RESEARCH_TUNING_DEFAULTS, RESEARCH_TUNING_OVERRIDE.patch)
  : RESEARCH_TUNING_DEFAULTS);
const RESEARCH_TUNING_ERROR = RESEARCH_TUNING_OVERRIDE.error;

export { RESEARCH_TUNING, RESEARCH_TUNING_ERROR, RESEARCH_TUNING_DEFAULTS, RESEARCH_TUNING_OVERRIDE };
