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
