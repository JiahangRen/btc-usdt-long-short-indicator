// shared/alert-rule-eval.mjs
//
// 单一事实来源：告警「命中 / 穿越」判定逻辑。
// Single source of truth for alert hit / cross evaluation.
//
// 背景 / Why: 原本 alert-worker.mjs 的 crossed() 与 server.mjs 的 ruleMatches()
// 语义高度重合却各写一遍（见 docs/CODE_AUDIT_REPORT.md 的 F6），且两份对同名
// 规则（如 short_liquidation）的语义其实相反——crossed 是「价格上穿目标」，
// ruleMatches 是「价格已低于目标」。为避免漂移，这里用 purpose 区分两种用途，
// 各自逐字节还原原实现。现有调用方（worker→'cross'，voice relay→'state'）
// 行为必须 100% 不变（已有 parity 测试覆盖）。
//
// purpose:
//  - 'cross' : 检测「上一次价格 → 本次价格」是否穿越目标（一次性推送通知用）。
//             原 alert-worker.mjs crossed()。
//  - 'state' : 判断「当前价格」是否满足规则（语音播报轮询用，含 prev===undefined 特例）。
//             原 server.mjs ruleMatches()。

export function evaluateAlertRule(rule, prev, next, purpose) {
  if (purpose === 'cross') {
    // 价格穿越检测：仅关心 from→to 是否跨过 target。
    if (rule.kind === 'price_reached')
      return (prev - rule.targetPrice) * (next - rule.targetPrice) <= 0 && prev !== next;
    const up = rule.kind === 'price_above' || rule.kind === 'short_liquidation';
    return up ? prev < rule.targetPrice && next >= rule.targetPrice : prev > rule.targetPrice && next <= rule.targetPrice;
  }

  // purpose === 'state'（语音播报轮询）
  if (!Number.isFinite(next)) return false;
  const target = Number(rule.targetPrice);
  if (rule.kind === 'price_reached') {
    if (!Number.isFinite(target)) return false;
    if (prev === undefined) return next >= target; // 离目标多近算"接近"
    return (prev - target) * (next - target) <= 0;
  }
  if (rule.kind === 'price_above') {
    if (!Number.isFinite(target)) return false;
    return next >= target; // 状态：到达即满足
  }
  if (rule.kind === 'price_below') {
    if (!Number.isFinite(target)) return false;
    return next <= target;
  }
  if (rule.kind === 'price_tick_move') {
    const delta = prev === undefined ? Math.abs(target) : Math.abs(next - prev);
    return delta >= Math.abs(target);
  }
  if (rule.kind === 'long_liquidation') return next >= target;
  if (rule.kind === 'short_liquidation') return next <= target;
  return false;
}

// ---- v2.12.80：三类「状态型」规则的云端判定（整数位 / 自定义网格 / 快速波动）----
// 与 public/notification.js 的 evalRound / evalGrid / evalVol 逐语义对齐（单一事实来源沿用本模块）。
// 这三类无法用「prev→next 穿越」表达（需要游标 / 滚动窗口），所以由调用方（alert-worker）
// 为每条规则持有一份 state，本函数纯粹地「喂一个价格、更新 state、返回命中事件」。
// state（调用方持有，可空对象起步）：
//   - round_number: { roundLevel }   当前整数位游标；缺省按 floor(price/step)*step 锚定（与本地一致，锚定不触发）。
//   - custom_grid : { gridIdx }      当前网格索引；缺省锚定当前索引（不触发）。
//   - volatility  : { buffer: [{t,price}] } 滚动窗口采样；重启即清空重新采样（与本地页面刷新一致）。
// 返回：命中事件 { level, dir, move?, start? } 或 null。方向语义与本地相同：up/down/both。
export function evaluateStatefulAlertRule(rule, price, now, state) {
  if (!Number.isFinite(price)) return null;
  const params = rule.params && typeof rule.params === 'object' ? rule.params : {};
  const num = value => { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : null; };
  const dirAllowed = ['up', 'down', 'both'];

  if (rule.kind === 'round_number') {
    const step = num(params.step);
    if (!step) return null;
    const direction = dirAllowed.includes(params.direction) ? params.direction : 'both';
    if (!Number.isFinite(state.roundLevel)) state.roundLevel = Math.floor(price / step) * step;
    let hit = null, dir = null;
    while ((direction === 'up' || direction === 'both') && price >= state.roundLevel + step) {
      state.roundLevel += step; hit = state.roundLevel; dir = 'up';
    }
    while ((direction === 'down' || direction === 'both') && price <= state.roundLevel - step) {
      state.roundLevel -= step; hit = state.roundLevel; dir = 'down';
    }
    return hit == null ? null : { level: hit, dir };
  }

  if (rule.kind === 'custom_grid') {
    const base = num(params.basePrice), step = num(params.step);
    if (!base || !step) return null;
    const direction = dirAllowed.includes(params.direction) ? params.direction : 'both';
    const idx = Math.round((price - base) / step);
    if (!Number.isFinite(state.gridIdx)) { state.gridIdx = idx; return null; }
    if (idx === state.gridIdx) return null;
    if (idx > state.gridIdx && direction === 'down') return null;
    if (idx < state.gridIdx && direction === 'up') return null;
    const dir = idx > state.gridIdx ? 'up' : 'down';
    state.gridIdx = idx;
    return { level: base + idx * step, dir };
  }

  if (rule.kind === 'volatility') {
    const windowMinutes = num(params.windowMinutes), threshold = num(params.threshold);
    if (!windowMinutes || !threshold) return null;
    const direction = dirAllowed.includes(params.direction) ? params.direction : 'both';
    if (!Array.isArray(state.buffer)) state.buffer = [];
    state.buffer.push({ t: now, price });
    const cutoff = now - windowMinutes * 60_000;
    while (state.buffer.length && state.buffer[0].t < cutoff) state.buffer.shift();
    if (state.buffer.length < 2) return null;
    const start = state.buffer[0];
    const move = price - start.price;
    const hit = () => ({ level: price, move, start: start.price, dir: move >= 0 ? 'up' : 'down' });
    if (direction === 'up' && move >= threshold) return hit();
    if (direction === 'down' && move <= -threshold) return hit();
    if (direction === 'both' && Math.abs(move) >= threshold) return hit();
    return null;
  }

  return null;
}
