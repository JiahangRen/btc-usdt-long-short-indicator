// Pure fusion-model training logic.
// 纯融合模型训练逻辑。
//
// Shared between the main server and the training worker thread. Contains NO
// database handle, NO network call, and NO mutable module state, so it is safe
// to evaluate inside a Worker thread. The only shared dependency is the tuning
// config in ./research-tuning.mjs.
// 主服务与训练 Worker 线程共用。不含数据库句柄、网络调用、可变模块状态，
// 可在 Worker 线程里安全求值。唯一共享依赖是 ./research-tuning.mjs 的配置。
//
// NOTE: trainFusionModel's return value carries two function fields
// (predictAt / predictBigAt) that cannot cross the structured-clone boundary.
// The worker (./train-worker.mjs) strips them before posting back. The only
// caller that needs them is the main-thread walk-forward replay, which invokes
// trainFusionModel in-process and keeps the full object.
// 注意：trainFusionModel 返回值带两个函数字段（predictAt / predictBigAt），
// 无法跨 structured-clone 边界。Worker（./train-worker.mjs）在回传前剔除它们。
// 唯一需要它们的调用方是主线程回放结算，它就地调用 trainFusionModel、保留完整对象。

import { RESEARCH_TUNING } from './research-tuning.mjs';

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function validCandle(c) { return c && [c.time, c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite); }
function percentChange(closes, end, span) { const start=closes[Math.max(0,end-span)], current=closes[end]; return Number.isFinite(start) && start > 0 && Number.isFinite(current) ? current / start - 1 : 0; }
function chopThreshold(sigma, horizon) {
  const multiple = RESEARCH_TUNING.theta.sigmaMultiple, floor = RESEARCH_TUNING.theta.floor;
  return Math.max((Number(sigma) || 0) * Math.sqrt(Math.max(0.000001, Number(horizon) || 1)) * multiple, floor);
}
function sigmoid(value) { return 1/(1+Math.exp(-Math.max(-18,Math.min(18,value)))); }
function logit(probability) { const value=clamp(probability,.001,.999); return Math.log(value/(1-value)); }

// Binary search for the last settlement at or before `at`, then report it as four numbers: crowding
// z-score, recent tilt, absolute level, and how far into the settlement cycle the bucket sits. A
// bucket predating the whole series returns null so the caller can tell "no data" from "neutral".
// 二分查找 `at` 之前（含）最近的一次结算，并报成四个数字：拥挤度 z 分数、近期斜率、绝对水平，以及
// 该桶落在结算周期的哪个位置。早于整条序列的桶返回 null，调用方因此能区分「没有数据」与「中性」。
// Tied to the length fundingFeaturesAt returns: the column count and the vector it emits must move
// together, so the constant lives next to the function that produces the vector rather than in the
// configuration block, where the two could drift apart without anything noticing.
// 与 fundingFeaturesAt 的返回长度绑定：列数必须与它产出的向量一起变动，所以这个常量紧挨着产出
// 向量的函数，而不是放在配置块里 —— 放在那里两者可能悄悄漂移而无人察觉。
const FUNDING_FEATURE_COLUMNS = 4;
function fundingFeaturesAt(features, at) {
  if (!Array.isArray(features) || !features.length) return null;
  let low = 0, high = features.length - 1, found = null;
  while (low <= high) { const mid = (low + high) >> 1; if (features[mid].at <= at) { found = features[mid]; low = mid + 1; } else high = mid - 1; }
  if (!found) return null;
  const cycle = RESEARCH_TUNING.funding.cycleHours;
  return [found.z, found.tilt, found.level, clamp((at - found.at) / (cycle * 3_600_000), 0, 1)];
}
function buildFundingFeatures(rows) {
  const cfg = RESEARCH_TUNING.funding;
  const series = rows.map(row => ({ at: Number(row.funding_at ?? row.at), rate: Number(row.rate) }))
    .filter(row => Number.isFinite(row.at) && Number.isFinite(row.rate)).sort((a, b) => a.at - b.at);
  const features = [], window = [];
  for (const row of series) {
    const level = Math.tanh(row.rate / cfg.levelScale);
    if (window.length >= cfg.window) {
      const mean = window.reduce((sum, value) => sum + value, 0) / window.length;
      const deviation = Math.sqrt(window.reduce((sum, value) => sum + (value - mean) ** 2, 0) / window.length) || 1e-9;
      const recent = window.slice(-cfg.recent), recentMean = recent.reduce((sum, value) => sum + value, 0) / recent.length;
      features.push({ at: row.at, z: clamp((row.rate - mean) / deviation, -cfg.clamp, cfg.clamp), tilt: clamp((recentMean - mean) / deviation, -cfg.clamp, cfg.clamp), level });
    } else {
      // Before the window fills there is no baseline to standardise against, so the feature reports
      // "neutral" rather than a number derived from a handful of prints.
      // 窗口填满之前没有可比对的基线，因此特征报「中性」，而不是用寥寥几个结算值算出来的数字。
      features.push({ at: row.at, z: 0, tilt: 0, level });
    }
    window.push(row.rate);
    if (window.length > cfg.window) window.shift();
  }
  return features;
}

async function trainFusionModel(candles,horizon,options={}) {
  const yieldToLoop = () => new Promise(resolve => setImmediate(resolve));
  const fusionCfg=RESEARCH_TUNING.fusion;
  // Hyper-parameter aliases, read once so a mid-run override could never change one number in the
  // middle of a fit. Everything below comes from RESEARCH_TUNING; none of it is inlined here.
  // 超参别名，只读一次，避免一次拟合当中某个数字被改动。下面全部来自 RESEARCH_TUNING，无一处内联。
  const baseWidth=fusionCfg.baseWidth, featureLookback=fusionCfg.featureLookback, featureStart=fusionCfg.featureStart;
  const logisticCfg=fusionCfg.logistic, treeCfg=fusionCfg.trees, treeWeightCfg=fusionCfg.treeWeight, plattCfg=fusionCfg.platt;
  const series=candles.filter(validCandle), closes=series.map(candle=>Number(candle.close));
  if(series.length<fusionCfg.minSeries)return null;
  // Calendar features are opt-in so an ablation can run the identical pipeline with and without
  // them; the only difference between the two arms is then the three extra columns.
  // 日历特征是可选的，这样消融实验能用完全相同的流程跑「有」与「无」两组，两臂之间唯一差别就是那三列。
  const calendar=Array.isArray(options.macroCalendar)&&options.macroCalendar.length?[...options.macroCalendar].sort((a,b)=>a-b):null;
  // Funding features arrive precomputed (see buildFundingFeatures); the trainer only reads them.
  // 资金费率特征以预算好的形式传入（见 buildFundingFeatures），训练器只负责读取。
  const funding=Array.isArray(options.fundingFeatures)&&options.fundingFeatures.length?options.fundingFeatures:null;
  const width=baseWidth+(calendar?3:0)+(funding?FUNDING_FEATURE_COLUMNS:0), calendarSpanHours=RESEARCH_TUNING.calendarFeatures.spanHours, activeWindowHours=RESEARCH_TUNING.calendarFeatures.activeWindowHours;
  const mean=values=>values.reduce((sum,value)=>sum+value,0)/Math.max(values.length,1);
  const deviation=values=>Math.sqrt(mean(values.map(value=>(value-mean(values))**2)))||.000001;
  // Nearest bracketing events only, both taken as published dates. The logarithm stops a three-week
  // gap from swamping a three-hour one; gaps beyond 30 days are all treated as "outside the regime".
  // 只取前后最近的两个事件，都用公布日期。取对数避免「三周」把「三小时」压平；超过 30 天一律视为
  // 「已在事件影响之外」。
  const calendarFeatures=at=>{
    let low=0, high=calendar.length-1, previous=null, next=null;
    while(low<=high){const mid=(low+high)>>1;if(calendar[mid]<=at){previous=calendar[mid];low=mid+1}else{next=calendar[mid];high=mid-1}}
    const sinceHours=previous===null?calendarSpanHours*4:Math.max(0,(at-previous)/3_600_000), untilHours=next===null?calendarSpanHours*4:Math.max(0,(next-at)/3_600_000);
    return [Math.log1p(Math.min(sinceHours,calendarSpanHours))/Math.log1p(calendarSpanHours), Math.log1p(Math.min(untilHours,calendarSpanHours))/Math.log1p(calendarSpanHours), sinceHours<=activeWindowHours?1:0];
  };
  const featureAt=index=>{
    const change=span=>percentChange(closes,index,span), returns=[];
    for(let point=Math.max(1,index-(featureLookback-1));point<=index;point++)returns.push(Math.log(closes[point]/closes[point-1]));
    const volatility=deviation(returns), volumes=series.slice(index-20,index).map(row=>Math.log1p(row.volume));
    const high=Math.max(...series.slice(index-20,index+1).map(row=>row.high)), low=Math.min(...series.slice(index-20,index+1).map(row=>row.low));
    const row=[change(1),change(4),change(12),volatility,change(12)/(volatility*Math.sqrt(12)+.000001),(series[index].high-series[index].low)/closes[index],(series[index].close-series[index].open)/closes[index],(Math.log1p(series[index].volume)-mean(volumes))/deviation(volumes)];
    // Column blocks are appended in a fixed order and each one is opt-in, so an ablation arm differs
    // from the baseline by exactly one block and a delta is attributable to that block alone.
    // 列块按固定顺序追加，且每块各自可开关，因此消融臂与基线臂只差正好一块，任何差值都只能归因于它。
    const at=Number(series[index].time);
    if(calendar)row.push(...calendarFeatures(at));
    if(funding)row.push(...(fundingFeaturesAt(funding,at)||new Array(FUNDING_FEATURE_COLUMNS).fill(0)));
    return row;
  };
  // Labels are terminal three-class outcomes, not barrier touches.  The scorecard grades a
  // forecast on where price ended relative to the volatility band, so training on which
  // barrier was touched first would optimise a different question than the one measured.
  // 标签是终点三分类，不是屏障触及。记分卡按「价格最终落在阈值带的哪一侧」评分，
  // 若继续用「先触及哪一边屏障」训练，优化的就是另一个问题。
  const terminalLabel=(index)=>{
    const history=[];for(let point=Math.max(1,index-(featureLookback-1));point<=index;point++)history.push(Math.log(closes[point]/closes[point-1]));
    const theta=chopThreshold(deviation(history),horizon), end=index+horizon, change=closes[end]/closes[index]-1;
    return { theta, end, change, label:Math.abs(change)<=theta?'flat':(change>0?'up':'down') };
  };
  // A replay trains only on rows whose outcome is already fully realised at the cut, while the
  // feature function stays addressable past the cut so the buckets that follow can be predicted.
  // 回放只用在 cut 处已完成结算的行训练；特征函数仍可寻址 cut 之后的桶，以便预测它们。
  const trainLimit=Number.isFinite(options.trainThrough)?Math.min(series.length,Math.max(0,Math.round(options.trainThrough))):series.length;
  const rows=[];for(let index=featureStart;index+horizon<trainLimit;index++){const outcome=terminalLabel(index);rows.push({ x:featureAt(index), label:outcome.label, end:outcome.end, theta:outcome.theta, futureReturn:outcome.change });if(((index-featureStart)&31)===0)await yieldToLoop();}
  if(rows.length<fusionCfg.minRows)return null;
  const trainEnd=Math.floor(rows.length*fusionCfg.split.train), calibrationEnd=Math.floor(rows.length*fusionCfg.split.calibration), embargo=horizon;
  const splitTrain=rows.slice(0,trainEnd), splitCalibration=rows.slice(trainEnd+embargo,calibrationEnd), splitTest=rows.slice(calibrationEnd+embargo);
  // Only directional rows carry an up/down answer, so the learned model estimates
  // P(up | the move is directional).  Chop is handled by the analogue distribution.
  // 只有方向样本才有涨跌答案，因此学习模型估计的是 P(涨 | 该走势有方向)；震荡由近邻分布给出。
  const flatRate=subset=>subset.length?subset.filter(row=>row.label==='flat').length/subset.length:null;
  const directed=subset=>subset.filter(row=>row.label!=='flat').map(row=>({ ...row, y:row.label==='up'?1:0 }));
  const train=directed(splitTrain), calibration=directed(splitCalibration), test=directed(splitTest);
  const calibrationBaseRate = calibration.length ? mean(calibration.map(row => row.y)) : null;
  // A daily tape is flat most of the time, so a fixed floor of 30 directional rows per split leaves
  // the daily replay with nothing to train on. Callers that replay sparse horizons lower the floor
  // explicitly rather than silently widening it for everyone.
  // 日线大部分时间在震荡，每个切分固定要求 30 条方向样本会让日线回放无样本可训。需要回放稀疏周期的
  // 调用方显式下调该下限，而不是对所有调用方静默放宽。
  const minDirectional=Math.max(fusionCfg.minDirectionalFloor,Number(options.minDirectional)||fusionCfg.minDirectional);if(calibration.length<minDirectional||test.length<minDirectional)return null;
  const means=Array.from({length:width},(_,column)=>mean(train.map(row=>row.x[column]))), scales=Array.from({length:width},(_,column)=>deviation(train.map(row=>row.x[column]))), standardize=x=>x.map((value,column)=>clamp((value-means[column])/scales[column],-fusionCfg.standardizeClamp,fusionCfg.standardizeClamp));
  const weights=Array(width).fill(0);let bias=0;
  for(let epoch=0;epoch<logisticCfg.epochs;epoch++){await yieldToLoop();for(const row of train){const x=standardize(row.x), probability=sigmoid(bias+x.reduce((sum,value,column)=>sum+value*weights[column],0)), error=row.y-probability, rate=logisticCfg.rate/(1+epoch/logisticCfg.rateDecay);bias+=rate*error/train.length;x.forEach((value,column)=>weights[column]+=rate*error*value/train.length)}}
  const logistic=x=>sigmoid(bias+standardize(x).reduce((sum,value,column)=>sum+value*weights[column],0));
  // A shallow boosted-stump comparator supplies nonlinear interactions without
  // claiming a LightGBM dependency is present in this zero-dependency service.
  const scores=train.map(()=>logit(mean(train.map(row=>row.y)))), trees=[];
  for(let round=0;round<treeCfg.rounds;round++){await yieldToLoop();const residual=train.map((row,index)=>row.y-sigmoid(scores[index]));let best=null;for(let column=0;column<width;column++){const values=train.map(row=>row.x[column]).sort((a,b)=>a-b);for(const fraction of treeCfg.fractions){const threshold=values[Math.floor((values.length-1)*fraction)],left=[],right=[];train.forEach((row,index)=>(row.x[column]<=threshold?left:right).push(index));if(left.length<treeCfg.minLeaf||right.length<treeCfg.minLeaf)continue;const leftValue=clamp(mean(left.map(index=>residual[index]))*2,-1,1),rightValue=clamp(mean(right.map(index=>residual[index]))*2,-1,1),loss=left.reduce((sum,index)=>sum+(residual[index]-leftValue)**2,0)+right.reduce((sum,index)=>sum+(residual[index]-rightValue)**2,0);if(!best||loss<best.loss)best={column,threshold,leftValue,rightValue,loss};}}if(!best)break;trees.push(best);train.forEach((row,index)=>{scores[index]+=treeCfg.rate*(row.x[best.column]<=best.threshold?best.leftValue:best.rightValue)})}
  const tree=x=>sigmoid(logit(mean(train.map(row=>row.y)))+trees.reduce((sum,item)=>sum+treeCfg.rate*(x[item.column]<=item.threshold?item.leftValue:item.rightValue),0));
  const raw=x=>{const trend=Math.abs(x[4]),volatile=x[3]>treeWeightCfg.volatileThreshold,treeWeight=(trend>treeWeightCfg.trendThreshold||volatile)?treeWeightCfg.trending:treeWeightCfg.normal;return treeWeight*tree(x)+(1-treeWeight)*logistic(x)};
  let slope=1,intercept=0;for(let epoch=0;epoch<plattCfg.epochs;epoch++){await yieldToLoop();for(const row of calibration){const probability=sigmoid(slope*logit(raw(row.x))+intercept),error=row.y-probability,rate=plattCfg.rate/(1+epoch/plattCfg.rateDecay);slope+=rate*error*logit(raw(row.x))/calibration.length;intercept+=rate*error/calibration.length}}
  // Platt, like the logistic step before it, is fit by a short SGD that under-converges: measured on
  // the replay it left the head reporting a mean of 44.6% on the 4h calibration slice whose own rate is
  // 34.5% - a 10pp over-statement of "up" that flows straight through to the test slice (+11.7pp) and to
  // the live signal. The marginal mean is a known quantity: a calibrated model reproduces the rate of the
  // slice it was fit on. Solving the intercept for that value (slope held at whatever SGD produced) costs
  // one monotone bisection and turns the systematic bias into an invariant that can be re-checked from
  // the diagnostics. The slope, which shapes the reliability curve, is left to SGD - fixing only the
  // intercept is the minimal change that makes the head honest about its base rate.
  // 与前面的逻辑回归一样，Platt 也是用一段会欠收敛的短 SGD 拟合的：在回放上实测它让这个头在校准切片上
  // 报出 44.6% 的均值，而该切片自身的率只有 34.5% —— 对「涨」高估 10pp，直接流到测试切片（+11.7pp）和
  // 线上信号。边际均值是已知的：一个校准好的模型会重现它拟合所在切片的率。把截距解到这个值（slope 保持
  // SGD 给出的结果）只需一次单调二分，并把系统性偏差变成一个可以从诊断里复查的不变量。slope 负责可靠性
  // 曲线的形状，留给 SGD —— 只修截距是让这个头对自己的基率诚实的最小改动。
  if (calibration.length) {
    const meanAtIntercept = icpt => mean(calibration.map(row => sigmoid(slope * logit(raw(row.x)) + icpt)));
    let lo = -14, hi = 14;
    for (let step = 0; step < 40; step += 1) { const guess = (lo + hi) / 2; if (meanAtIntercept(guess) < calibrationBaseRate) lo = guess; else hi = guess; }
    intercept = (lo + hi) / 2;
  }
  const calibrated=x=>sigmoid(slope*logit(raw(x))+intercept), baseRate=mean(train.map(row=>row.y)), predicted=test.map(row=>({...row,probability:calibrated(row.x)})), samples=predicted.length;
  const brier=mean(predicted.map(row=>(row.probability-row.y)**2)), baselineBrier=mean(predicted.map(row=>(baseRate-row.y)**2)), logLoss=mean(predicted.map(row=>-(row.y*Math.log(clamp(row.probability,.000001,.999999))+(1-row.y)*Math.log(clamp(1-row.probability,.000001,.999999))))), accuracy=mean(predicted.map(row=>+(+(row.probability>=.5)===+row.y))), bins=Array.from({length:fusionCfg.calibrationBins},()=>[]);
  predicted.forEach(row=>bins[Math.min(9,Math.floor(row.probability*10))].push(row));const reliability=bins.map((bin,index)=>bin.length?{label:`${index*10}–${index*10+10}%`,samples:bin.length,predicted:mean(bin.map(row=>row.probability)),observed:mean(bin.map(row=>row.y))}:null).filter(Boolean), ece=reliability.reduce((sum,bin)=>sum+Math.abs(bin.predicted-bin.observed)*bin.samples/samples,0);
  const ranked=[...predicted].sort((a,b)=>a.probability-b.probability), positives=ranked.filter(row=>row.y).length, negatives=samples-positives, auc=positives&&negatives?(ranked.reduce((sum,row,index)=>sum+(row.y?(index+1):0),0)-positives*(positives+1)/2)/(positives*negatives):null;
  const latestLabel=terminalLabel(Math.max(horizon,trainLimit-1-horizon));
  // ---- Volatility head (opt-in) ------------------------------------------------------------
  // The direction head answers "which way, given that it moves" and is trained on directional rows
  // only; the live blend reads its chop probability from the analogue pool. No feature column can
  // therefore reach the volatility side of the prediction, which makes the question the event
  // studies raised - does this factor affect movement - unanswerable inside this architecture. This
  // second head exists to answer it: the same columns and the same rules, but its label is "leave
  // the band" instead of "which way", and it trains on every row rather than the directional
  // minority. It is opt-in so the live path and the published replay keep their exact behaviour.
  // 方向头回答「若真动了，往哪边」，且只在方向样本上训练；实时融合的震荡概率取自近邻池。因此任何特征
  // 列都到不了预测的波动那一侧，于是事件研究提出的问题 —— 这个因子影响波动吗 —— 在本架构里无法回答。
  // 第二个头就是为回答它而存在的：同样的列、同样的规则，但标签是「是否离开带」而非「往哪边」，且用全部
  // 行训练，而不只是方向那少数。它默认关闭，因此实时路径与已发布的回放口径保持完全不变。
  const volatilityHead = options.volatilityHead !== true ? null : await (async () => {
    const labelOf = row => Math.abs(row.futureReturn) > row.theta ? 1 : 0;
    const bigTrain = splitTrain.map(labelOf), bigCalibration = splitCalibration.map(labelOf);
    // Both classes must be present, or the head would be asked to learn a constant and its skill
    // score would be a statement about the sample rather than about the features.
    // 两类都必须出现，否则这个头只能学到一个常数，它的技巧分说的就是样本而不是特征。
    if (splitTrain.length < fusionCfg.minRows || !bigTrain.some(value => value) || !bigTrain.some(value => !value)) return null;
    // Standardisation is computed on this head's own rows: the direction head's statistics come from
    // the directional minority, which has a different volatility profile by construction.
    // 标准化用这个头自己的行来算：方向头的统计量来自方向那少数样本，而那一批的波动分布本身就不同。
    const bigMeans = Array.from({length:width},(_,column)=>mean(splitTrain.map(row=>row.x[column])));
    const bigScales = Array.from({length:width},(_,column)=>deviation(splitTrain.map(row=>row.x[column])));
    const bigStandardize = x => x.map((value,column)=>clamp((value-bigMeans[column])/bigScales[column],-fusionCfg.standardizeClamp,fusionCfg.standardizeClamp));
    const bigWeights = Array(width).fill(0); let bigBias = 0;
    for (let epoch=0;epoch<logisticCfg.epochs;epoch++) { await yieldToLoop(); for (let index=0;index<splitTrain.length;index++) {
      const x = bigStandardize(splitTrain[index].x), probability = sigmoid(bigBias+x.reduce((sum,value,column)=>sum+value*bigWeights[column],0)), error = bigTrain[index]-probability, rate = logisticCfg.rate/(1+epoch/logisticCfg.rateDecay);
      bigBias += rate*error/splitTrain.length; x.forEach((value,column)=>{bigWeights[column]+=rate*error*value/splitTrain.length});
    } }
    // Only the intercept has a converged value that is known in advance: at the optimum, the mean
    // predicted probability equals the base rate of the rows the fit saw. This SGD schedule moves it
    // about a quarter of the way there - measured on the replay, the head reported a 43.0% mean on its
    // own training rows against a 22.6% base rate, a 20.4pp gap - and an under-converged intercept is
    // not a small error: it is the entire reason the head claims moves that never arrive. Solving for
    // it costs one monotone scalar search and buys an invariant that can be checked afterwards: the
    // head's mean output on its training rows is the training base rate, by construction.
    // 只有截距有一个事先已知的收敛值：在最优处，平均预测概率等于拟合时所看到的那批行的基率。这套 SGD
    // 方案只把它推到目标的约四分之一 —— 在回放上实测，这个头在自己的训练行上报出 43.0% 的均值，而基率
    // 是 22.6%，差 20.4pp —— 而一个未收敛的截距不是小误差：它正是这个头喊「要动」却不动弹的全部原因。
    // 直接解出来只需一次单调的标量搜索，换来一个事后可检验的不变量：这个头在训练行上的平均输出按构造
    // 等于训练基率。
    const bigBaseRate = mean(bigTrain);
    const meanAtBias = bias => mean(splitTrain.map(row => sigmoid(bias + bigStandardize(row.x).reduce((sum, value, column) => sum + value * bigWeights[column], 0))));
    // Monotone increasing in the bias, so a bisection needs no derivative and cannot wander off.
    // 对 bias 单调递增，所以二分法既不需要导数，也不会跑偏。
    let bigLow = -14, bigHigh = 14;
    for (let step = 0; step < 40; step += 1) {
      const guess = (bigLow + bigHigh) / 2;
      if (meanAtBias(guess) < bigBaseRate) bigLow = guess; else bigHigh = guess;
    }
    bigBias = (bigLow + bigHigh) / 2;
    const bigRaw = x => sigmoid(bigBias+bigStandardize(x).reduce((sum,value,column)=>sum+value*bigWeights[column],0));
    // Same Platt step as the direction head, on the same independent chronological slice, so a
    // Brier-skill comparison between the two heads is a comparison of two calibrated models.
    // 与方向头相同的 Platt 步骤，用同一段独立的时间切片，这样两个头之间的 Brier 技巧比较才是两个已
    // 校准模型的比较。
    let bigSlope = 1, bigIntercept = 0;
    if (bigCalibration.length) for (let epoch=0;epoch<plattCfg.epochs;epoch++) { await yieldToLoop(); for (let index=0;index<splitCalibration.length;index++) {
      const value = bigRaw(splitCalibration[index].x), probability = sigmoid(bigSlope*logit(value)+bigIntercept), error = bigCalibration[index]-probability, rate = plattCfg.rate/(1+epoch/plattCfg.rateDecay);
      bigSlope += rate*error*logit(value)/bigCalibration.length; bigIntercept += rate*error/bigCalibration.length;
    } }
    const calibratedBig = x => sigmoid(bigSlope*logit(bigRaw(x))+bigIntercept);
    return { predictAt:index=>calibratedBig(featureAt(index)), bigRate:mean(bigTrain), trainSamples:splitTrain.length,
      calibrationSamples:bigCalibration.length, bigSamples:bigTrain.filter(value=>value).length, columns:width,
      // The calibration slice's own big-move rate is what separates the two reasons a volatility head can
      // over-predict: the level drifted between the slice it was fitted on and the buckets it is scored on,
      // or the head simply shrank toward 0.5 and the calibration did not undo it. Reporting it next to the
      // training rate and the realised rate makes that a reading instead of a guess.
      // 校准切片自己的大动率，是把「波动头为什么会过预测」的两个原因分开的那把尺子：要么它拟合的那段与
      // 它被打分的那段之间水位漂移了，要么这个头只是朝 0.5 收缩、而校准没能纠正。把它与训练基率、实际
      // 基率并排报出，这件事就从猜测变成读数。
      calibrationBigRate:bigCalibration.length?mean(bigCalibration):null,
      // Three output rates in pipeline order. A converged logistic fit reproduces its own base rate on
      // its own training rows, so if rawTrainRate already sits far above bigRate the fault is in the
      // logistic step; if rawTrainRate is fine but trainPredictedRate is not, the fault is in Platt.
      // Reporting all three turns "the head over-predicts" from a symptom into a location.
      // 三个输出率，按流水线顺序排列。一个收敛的逻辑回归会在自己的训练行上重现自己的基率，所以若
      // rawTrainRate 已经远高于 bigRate，错在逻辑回归这一步；若 rawTrainRate 正常而 trainPredictedRate
      // 不正常，错在 Platt。三者齐报，就把「这个头会高估」从一个症状变成一个位置。
      rawTrainRate:mean(splitTrain.map(row=>bigRaw(row.x))),
      trainPredictedRate:mean(splitTrain.map(row=>calibratedBig(row.x))),
      // The rows, not the labels: bigCalibration is the 0/1 vector produced by labelOf, so reading
      // row.x off it returns undefined and the standardiser throws on the missing array. This is the
      // one place where the two arrays of different shape carry confusingly similar names.
      // 这里要的是**行**而不是标签：bigCalibration 是 labelOf 产出的 0/1 向量，对它取 row.x 只能得到
      // undefined，标准化器随即在一个不存在的数组上抛错。两个形状不同的数组名字太像，就栽在这一处。
      calibrationPredictedRate:bigCalibration.length?mean(splitCalibration.map(row=>calibratedBig(row.x))):null };
  })();
  return { probability:calibrated(featureAt(series.length-1)), predictAt:index=>calibrated(featureAt(index)), theta:latestLabel?.theta ?? null,
    // Reporting the column count keeps an ablation honest: if both arms report 8, the calendar never
    // reached the model and any "no difference" conclusion would be meaningless.
    // 报出列数是让消融实验诚实的前提：若两臂都报 8，说明日历根本没进模型，此时任何「无差异」的结论都没有意义。
    featureWidth:width, calendarColumns:calendar?3:0, fundingColumns:funding?FUNDING_FEATURE_COLUMNS:0,
    // The volatility head is only present when a caller asked for it; its column count travels with
    // it for the same reason featureWidth does - a head that reports 0 columns cannot have been the
    // thing that moved a volatility number.
    // 波动头只在调用方要求时存在；它的列数与 featureWidth 同理随行下发 —— 一个报 0 列的头不可能
    // 是推动波动数字的原因。
    predictBigAt:volatilityHead?volatilityHead.predictAt:null,
    volatilityHead:volatilityHead?{columns:volatilityHead.columns,trainSamples:volatilityHead.trainSamples,calibrationSamples:volatilityHead.calibrationSamples,bigRate:volatilityHead.bigRate,bigSamples:volatilityHead.bigSamples,calibrationBigRate:volatilityHead.calibrationBigRate,rawTrainRate:volatilityHead.rawTrainRate,trainPredictedRate:volatilityHead.trainPredictedRate,calibrationPredictedRate:volatilityHead.calibrationPredictedRate}:null,
    // The direction head is the live signal, so its calibration is worth the same three-stage reading
    // the volatility head got: the bare logistic step, the blended raw, and the Platt output, each taken
    // on the training rows it was fitted on and on the independent calibration slice. A converged bare
    // logistic reproduces its own base rate on its own training rows, so logisticTrainRate sitting far
    // above baseRate is the same under-converged-intercept fault found in the volatility head; if raw is
    // fine but the calibration-slice rate is off, the fault is Platt. Three numbers turn the symptom
    // into a location instead of a guess.
    // 方向头就是线上信号本身，所以它的标定值得和波动头一样做「三段式」读数：裸逻辑回归、混合后 raw、Platt
    // 输出，各自在它拟合所用的训练行上、以及在独立的校准切片上取值。一个收敛的裸逻辑回归会在自己的训练行
    // 上重现自己的基率，所以 logisticTrainRate 远高于 baseRate 就是波动头里那个「截距未收敛」的同一种毛病；
    // 若 raw 正常、校准切片上的率却偏了，错在 Platt。三个数把「这个头会高估」从症状变成位置。
    directionDiagnostics: {
      baseRate: baseRate,
      logisticTrainRate: mean(train.map(row => logistic(row.x))),
      treeTrainRate: mean(train.map(row => tree(row.x))),
      rawTrainRate: mean(train.map(row => raw(row.x))),
      trainPredictedRate: mean(train.map(row => calibrated(row.x))),
      calibrationBaseRate: calibrationBaseRate,
      calibrationPredictedRate: calibration.length ? mean(calibration.map(row => calibrated(row.x))) : null,
      testBaseRate: mean(predicted.map(row => row.y)),
      testPredictedRate: mean(predicted.map(row => row.probability)),
      auc: auc, brier: brier, baselineBrier: baselineBrier, brierSkill: baselineBrier ? 1 - brier / baselineBrier : null, ece: ece,
      rawStd: deviation(test.map(row => raw(row.x))), calibratedStd: deviation(predicted.map(row => row.probability)),
      reliability: reliability
    },
    validation:{ accuracy,brier,logLoss,brierSkill:baselineBrier?1-brier/baselineBrier:null,ece,auc,samples,reliability,flatRate:flatRate(splitTest),flatRateTrain:flatRate(splitTrain),directionalSamples:test.length,totalSamples:rows.length,label:'terminal three-class',split:'chronological 60/20/20 + embargo',embargo,models:['logistic','local boosted-stump baseline'],calibration:'Platt on independent chronological window',scope:'directional rows only; P(up | directional)'}, calibration:{slope,intercept} };
}

export {
  clamp,
  validCandle,
  percentChange,
  chopThreshold,
  sigmoid,
  logit,
  FUNDING_FEATURE_COLUMNS,
  fundingFeaturesAt,
  buildFundingFeatures,
  trainFusionModel,
};
