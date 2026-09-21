/* 币种注册表 / Coin registry
 *
 * 这个模块是「多币种模式」的唯一真源：页面上出现的任何交易对、任何交易所合约 ID，
 * 都必须从这里取，不允许在业务代码里再写死 BTC-USDT-SWAP / BTCUSDT 之类的字面量。
 *
 * 设计约束（很重要）：
 *   1. BTC 必须映射到与多币种改造之前**逐字符相同**的合约 ID。
 *      「比特币模式」因此天然等于旧版页面 —— 不是靠分支兼容，而是同一条代码路径。
 *   2. normalizeCoin 对任何未知/缺失输入都返回 BTC，保证老链接、老书签、
 *      未升级的客户端、以及所有不带 symbol 参数的内部调用，行为与今天完全一致。
 *   3. 注册表只描述「这个币在各交易所叫什么」+「怎么展示」，
 *      不掺任何行情逻辑，便于单独审查与扩展新币种。
 */

export const BASE_COIN = 'BTC';

/** 展示顺序：BTC 永远第一（既是默认也是回退），其余按市值/关注度排列。 */
export const COIN_KEYS = ['BTC', 'ETH', 'ZEC', 'BNB'];

export const COINS = {
  BTC: {
    key: 'BTC',
    label: 'BTC',
    name: { zh: '比特币', en: 'Bitcoin' },
    // 计价单位：OKX open-interest 频道返回 oiCcy 时的单位标签。
    oiUnit: 'BTC',
    // 价格小数位。BTC/ETH/ZEC/BNB 现价都在 10^2~10^5 量级，全站统一 2 位即可，
    // 保留字段是为了将来接 SOL 这类小数币时不必再改格式化代码。
    pricePrecision: 2,
    // 数量小数位：用于「我的持仓」的币本位数量显示。
    qtyPrecision: 6,
    okx: { swap: 'BTC-USDT-SWAP', spot: 'BTC-USDT' },
    binance: 'BTCUSDT',
    gate: 'BTC_USDT',
    coinbase: 'BTC-PERP',
    // 新闻检索关键词：研究预测的新闻情绪通道按它抓 RSS。
    newsQuery: 'bitcoin OR BTC',
  },
  ETH: {
    key: 'ETH',
    label: 'ETH',
    name: { zh: '以太坊', en: 'Ethereum' },
    oiUnit: 'ETH',
    pricePrecision: 2,
    qtyPrecision: 5,
    okx: { swap: 'ETH-USDT-SWAP', spot: 'ETH-USDT' },
    binance: 'ETHUSDT',
    gate: 'ETH_USDT',
    coinbase: 'ETH-PERP',
    newsQuery: 'ethereum OR ETH',
  },
  ZEC: {
    key: 'ZEC',
    label: 'ZEC',
    name: { zh: 'Zcash', en: 'Zcash' },
    oiUnit: 'ZEC',
    pricePrecision: 2,
    qtyPrecision: 5,
    okx: { swap: 'ZEC-USDT-SWAP', spot: 'ZEC-USDT' },
    binance: 'ZECUSDT',
    gate: 'ZEC_USDT',
    coinbase: 'ZEC-PERP',
    newsQuery: 'zcash OR ZEC',
  },
  BNB: {
    key: 'BNB',
    label: 'BNB',
    name: { zh: '币安币', en: 'BNB' },
    oiUnit: 'BNB',
    pricePrecision: 2,
    qtyPrecision: 5,
    okx: { swap: 'BNB-USDT-SWAP', spot: 'BNB-USDT' },
    binance: 'BNBUSDT',
    gate: 'BNB_USDT',
    coinbase: 'BNB-PERP',
    newsQuery: 'BNB OR binance coin',
  },
};

/** 把任意输入（null / 小写 / 未知 / 带空白）收敛成注册表中的币种 key，默认 BTC。 */
export function normalizeCoin(raw) {
  const key = String(raw == null ? '' : raw).trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(COINS, key) ? key : BASE_COIN;
}

export function coinMeta(coin) {
  return COINS[normalizeCoin(coin)];
}

/** OKX 合约 ID。kind: 'swap'（永续，默认）| 'spot'（现货，用于溢价/基差计算）。 */
export function okxInstId(coin, kind = 'swap') {
  const meta = coinMeta(coin);
  return kind === 'spot' ? meta.okx.spot : meta.okx.swap;
}

/** Binance 永续 symbol。 */
export function binanceSymbol(coin) {
  return coinMeta(coin).binance;
}

/** Gate 永续合约名。 */
export function gateContract(coin) {
  return coinMeta(coin).gate;
}

/** Coinbase International 永续 instrument。 */
export function coinbaseInstrument(coin) {
  return coinMeta(coin).coinbase;
}

/**
 * 统一入口：按数据源取该币种的合约标识。
 * 以前这些字符串散落在 server.mjs 里二十多处，改一个币要改二十处；现在只此一处。
 */
export function instrumentId(source, coin, kind = 'swap') {
  const key = normalizeCoin(coin);
  if (source === 'binance') return binanceSymbol(key);
  if (source === 'gate') return gateContract(key);
  if (source === 'coinbase') return coinbaseInstrument(key);
  return okxInstId(key, kind);
}

/** 前端展示用：「BTC / USDT」。 */
export function pairLabel(coin) {
  return `${normalizeCoin(coin)} / USDT`;
}

/** 按当前语言取币种中文/英文全名；未知语言回落到币种代码。 */
export function coinName(coin, lang = 'zh') {
  const meta = coinMeta(coin);
  return lang === 'en' ? meta.name.en : meta.name.zh;
}
