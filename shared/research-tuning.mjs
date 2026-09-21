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
  // Walk-forward replay.
  // `minTrain` is the warm-up a replay must see before its first prediction. One constant cannot be
  // right for both tape types: 400 bars is a fifth of the intraday history but two fifths of the
  // daily one, so the daily horizon silently discarded 40% of the only daily history that exists -
  // 401 of 1022 bars - while the trainer's own floors ask for far less. The daily override buys that
  // history back; the floor stops an override from starving the trainer.
  // minTrain 是回放做出第一条预测之前必须看到的预热长度。一个常数不可能同时适合两种行情粒度：
  // 400 根只占日内历史的五分之一，却占日线历史的五分之二 —— 于是日线周期静默丢掉了唯一那份日线
  // 历史里的 40%（1022 根里的 401 根），而训练器自己的下限要的远少于这个数。日线覆盖值把这段历史
  // 换回来；下限则防止覆盖值把训练器饿死。
  replay: { minTrain: 400, minTrainFloor: 200, perHorizonMinTrain: { '1d': 300 }, segmentLength: 300, maxSamples: 6000, yieldEvery: 40 },
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
  // Promotion gates. A horizon counts as ready on its own; promotion needs all four.
  // 升级门槛。单个周期可独立达标；升级需要四个周期全部达标。
  gates: {
    requiredIndependentPerHorizon: 20,
    // A single count cannot be right for four horizons at once. An independent sample costs one
    // holding period, so 20 of them mean ~5 hours at 15m, ~3.3 days at 4h and 20 full days at 1d —
    // the daily horizon was the only remaining serial constraint on the promotion chain, and it
    // held the other three hostage for three weeks. The daily count is therefore lowered to ten
    // days of evidence as a deliberate trade of statistical power for a decision cadence measured
    // in weeks. It cannot cause a premature promotion on its own: the quality, calibration and
    // robustness gates still have to pass on that same ten-sample pairing.
    // 一个数字不可能同时适合四个周期。一个独立样本的代价是一个持有期，所以 20 条在 15m 约 5 小时、
    // 在 4h 约 3.3 天、在 1d 却是整整 20 天 —— 后者曾是升级链上唯一的串行约束，把另外三个周期一起
    // 拖了三周。因此把日线门槛降到十天证据，这是有意用统计功效换取「以周而非以月计」的决策节奏。
    // 它本身不会导致提前升级：质量、校准与稳健三道门仍要在这同一批十条配对样本上通过。
    perHorizonRequirement: { '1d': 10 },
    quality: { brierFactor: 0.97, logLossFactor: 0.97 },
    calibration: { minBrierSkill: 0, eceFactor: 1.05 },
    economics: { maxDrawdownSlack: 0.02 },
    robustness: { minSamples: 10, brierFactor: 1.05 },
    // There is deliberately no `pairedMinSamples` here. The paired A/B experiment path was retired
    // on 2026-09-19 (no new pairs are collected), so a threshold for it would be a parameter that
    // nothing reads - the first thing this file's wiring check flagged. Per-experiment sample
    // floors now live in abExperimentCatalog, next to the experiment they belong to.
    // 这里刻意没有 pairedMinSamples。配对 A/B 实验路径已于 2026-09-19 停用（不再采集新配对），
    // 为它保留门槛就是一个没有任何读取方的参数 —— 正是接线自检抓到的第一项。各实验的样本下限
    // 现在放在 abExperimentCatalog 里，紧挨着它所描述的实验。
  },
  // Cost model used by the scorecard's economic block (P2 metric, not a promotion gate on its own).
  // 记分卡经济块使用的成本模型（P2 指标，本身不是升级门槛）。
  economics: { roundTripCost: 0.0008, signalEdge: 0.06 },
  // A verdict of "no difference" is only meaningful if the difference was measurable.
  // 只有差异本身可测量时，「无差异」这个结论才有意义。
  // Two thresholds, one per question the ablation asks. Both are in percentage points so the client
  // handles them identically: direction is judged on deltaVsMajority (a ratio), volatility on the
  // gain in Brier skill over a constant base rate and on AUC - also ratios.
  // 两个阈值，对应消融提出的两个问题。两者都以百分点表示，客户端处理方法一致：方向看
  // deltaVsMajority（比例），波动看相对常数基准的 Brier 技巧增量与 AUC —— 同样是比例。
  ablation: { deltaThresholdPp: 0.5, volatilityThresholdPp: 0.5, volatilityAucThreshold: 0.005 },
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
