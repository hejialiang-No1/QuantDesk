/**
 * backtest.js —— 策略回测引擎
 *
 * 防未来函数的关键约定：第 i 根 K 线收盘后产生信号，在第 i+1 根 K 线的**开盘价**成交。
 * 这与实盘"盘后出信号、次日开盘下单"一致，避免用收盘价自成交造成的虚高收益。
 */
const I = require('./indicators');

const STRATEGIES = {
  ma_cross: {
    name: '双均线交叉',
    desc: '短期均线上穿长期均线买入，下穿卖出。最经典的趋势跟踪。',
    params: [
      { key: 'fast', label: '快线', def: 5, min: 2, max: 60 },
      { key: 'slow', label: '慢线', def: 20, min: 5, max: 200 },
    ],
  },
  macd: {
    name: 'MACD 金叉',
    desc: 'DIF 上穿 DEA 买入，下穿卖出。对中期趋势拐点敏感。',
    params: [
      { key: 'fast', label: '快线', def: 12, min: 2, max: 30 },
      { key: 'slow', label: '慢线', def: 26, min: 5, max: 60 },
      { key: 'signal', label: '信号线', def: 9, min: 2, max: 30 },
    ],
  },
  rsi: {
    name: 'RSI 超卖反弹',
    desc: 'RSI 跌破超卖线买入，升破超买线卖出。震荡市有效，单边牛市易踏空。',
    params: [
      { key: 'period', label: '周期', def: 14, min: 5, max: 30 },
      { key: 'oversold', label: '超卖线', def: 30, min: 10, max: 45 },
      { key: 'overbought', label: '超买线', def: 70, min: 55, max: 90 },
    ],
  },
  boll: {
    name: '布林带回归',
    desc: '跌破下轨买入，回到中轨卖出。押注均值回归。',
    params: [
      { key: 'n', label: '周期', def: 20, min: 5, max: 60 },
      { key: 'k', label: '倍数', def: 2, min: 1, max: 3, step: 0.1 },
    ],
  },
  momentum: {
    name: '动量突破',
    desc: 'N 日动量转正且站上均线买入，动量转负卖出。追涨型策略。',
    params: [
      { key: 'n', label: '动量周期', def: 20, min: 5, max: 120 },
      { key: 'ma', label: '过滤均线', def: 60, min: 0, max: 200 },
    ],
  },
  turtle: {
    name: '海龟突破',
    desc: '突破 N 日最高价买入，跌破 M 日最低价卖出。捕捉大趋势。',
    params: [
      { key: 'in', label: '入场周期', def: 20, min: 5, max: 120 },
      { key: 'out', label: '出场周期', def: 10, min: 3, max: 60 },
    ],
  },
  buy_hold: {
    name: '买入持有（基准）',
    desc: '首日买入并一直持有，作为策略对比基准。',
    params: [],
  },
};

function buildSignals(bars, strategy, p) {
  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const sig = new Array(bars.length).fill(null);

  if (strategy === 'buy_hold') {
    // 首个交易日收盘出信号、次日开盘建仓，与基准口径一致
    if (bars.length > 1) sig[0] = 'buy';
    return sig;
  }

  if (strategy === 'ma_cross') {
    const f = I.sma(closes, p.fast);
    const s = I.sma(closes, p.slow);
    for (let i = 1; i < bars.length; i++) {
      if (f[i] == null || s[i] == null || f[i - 1] == null || s[i - 1] == null) continue;
      if (f[i - 1] <= s[i - 1] && f[i] > s[i]) sig[i] = 'buy';
      else if (f[i - 1] >= s[i - 1] && f[i] < s[i]) sig[i] = 'sell';
    }
    return sig;
  }

  if (strategy === 'macd') {
    const m = I.macd(closes, p.fast, p.slow, p.signal);
    for (let i = 1; i < bars.length; i++) {
      if (m.dif[i] == null || m.dea[i] == null || m.dif[i - 1] == null || m.dea[i - 1] == null) continue;
      if (m.dif[i - 1] <= m.dea[i - 1] && m.dif[i] > m.dea[i]) sig[i] = 'buy';
      else if (m.dif[i - 1] >= m.dea[i - 1] && m.dif[i] < m.dea[i]) sig[i] = 'sell';
    }
    return sig;
  }

  if (strategy === 'rsi') {
    const r = I.rsi(closes, p.period);
    for (let i = 1; i < bars.length; i++) {
      if (r[i] == null || r[i - 1] == null) continue;
      if (r[i - 1] >= p.oversold && r[i] < p.oversold) sig[i] = 'buy';
      else if (r[i - 1] <= p.overbought && r[i] > p.overbought) sig[i] = 'sell';
    }
    return sig;
  }

  if (strategy === 'boll') {
    const b = I.boll(closes, p.n, p.k);
    for (let i = 1; i < bars.length; i++) {
      if (b.lower[i] == null || b.mid[i] == null) continue;
      if (closes[i - 1] >= b.lower[i - 1] && closes[i] < b.lower[i]) sig[i] = 'buy';
      else if (closes[i - 1] <= b.mid[i - 1] && closes[i] > b.mid[i]) sig[i] = 'sell';
    }
    return sig;
  }

  if (strategy === 'momentum') {
    const ma = p.ma > 0 ? I.sma(closes, p.ma) : null;
    for (let i = p.n; i < bars.length; i++) {
      const mom = (closes[i] / closes[i - p.n] - 1) * 100;
      const momPrev = (closes[i - 1] / closes[i - 1 - p.n] - 1) * 100;
      const okMa = !ma || ma[i] == null || closes[i] > ma[i];
      if (momPrev <= 0 && mom > 0 && okMa) sig[i] = 'buy';
      else if (momPrev >= 0 && mom < 0) sig[i] = 'sell';
    }
    return sig;
  }

  if (strategy === 'turtle') {
    for (let i = Math.max(p.in, p.out); i < bars.length; i++) {
      const hh = Math.max(...highs.slice(i - p.in + 1, i)); // 不含当日，避免未来函数
      const ll = Math.min(...lows.slice(i - p.out + 1, i));
      if (closes[i] > hh) sig[i] = 'buy';
      else if (closes[i] < ll) sig[i] = 'sell';
    }
    return sig;
  }

  return sig;
}

/**
 * 执行回测
 * @param {Object} opt
 * @param {Array}  opt.bars
 * @param {String} opt.strategy
 * @param {Object} opt.params
 * @param {Number} opt.initialCapital
 * @param {Number} opt.commission 单边费率
 * @param {Number} opt.slippage 滑点比例
 */
function run(opt) {
  const {
    bars,
    strategy = 'ma_cross',
    params = {},
    initialCapital = 100000,
    commission = 0.0005,
    slippage = 0.0005,
  } = opt;
  if (!bars || bars.length < 30) return { error: 'K线数据不足（至少需要 30 根）' };

  const p = { ...defaultParams(strategy), ...params };
  const sig = buildSignals(bars, strategy, p);

  let cash = initialCapital;
  let shares = 0;
  let entryPrice = 0;
  let entryDate = null;
  const trades = [];
  const equity = [];
  let peak = initialCapital;
  let maxDD = 0;

  const close = bars.map((b) => b.close);

  for (let i = 1; i < bars.length; i++) {
    const act = sig[i - 1]; // 昨日收盘信号 → 今日开盘成交
    const openPx = bars[i].open;

    if (act === 'buy' && shares === 0 && openPx > 0) {
      const px = openPx * (1 + slippage);
      const fee = Math.max(1, cash * commission);
      const n = Math.floor((cash - fee) / px);
      if (n > 0) {
        shares = n;
        cash -= n * px + fee;
        entryPrice = px;
        entryDate = bars[i].date;
        trades.push({
          date: bars[i].date,
          type: 'buy',
          price: px,
          shares: n,
          amount: n * px,
          fee,
        });
      }
    } else if (act === 'sell' && shares > 0 && openPx > 0) {
      const px = openPx * (1 - slippage);
      const amount = shares * px;
      const fee = Math.max(1, amount * commission);
      cash += amount - fee;
      const profit = (px - entryPrice) * shares - fee - (trades[trades.length - 1]?.fee || 0);
      trades.push({
        date: bars[i].date,
        type: 'sell',
        price: px,
        shares,
        amount,
        fee,
        profit,
        profitPct: ((px - entryPrice) / entryPrice) * 100,
        holdDays: entryDate ? diffDays(entryDate, bars[i].date) : null,
      });
      shares = 0;
      entryPrice = 0;
      entryDate = null;
    }

    const value = cash + shares * close[i];
    equity.push({ date: bars[i].date, value, position: shares > 0 });
    if (value > peak) peak = value;
    const dd = (peak - value) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  // 期末按最后收盘价平仓结算
  const last = bars[bars.length - 1];
  if (shares > 0) {
    const px = last.close * (1 - slippage);
    const amount = shares * px;
    const fee = Math.max(1, amount * commission);
    cash += amount - fee;
    const profit = (px - entryPrice) * shares - fee - (trades[trades.length - 1]?.fee || 0);
    trades.push({
      date: last.date,
      type: 'sell',
      price: px,
      shares,
      amount,
      fee,
      profit,
      profitPct: ((px - entryPrice) / entryPrice) * 100,
      holdDays: entryDate ? diffDays(entryDate, last.date) : null,
      forced: true,
    });
    shares = 0;
  }

  const finalCapital = cash;
  const totalReturn = ((finalCapital - initialCapital) / initialCapital) * 100;
  const days = diffDays(bars[0].date, last.date) || bars.length;
  const years = Math.max(days / 252, 0.02);
  const annualized = (Math.pow(finalCapital / initialCapital, 1 / years) - 1) * 100;

  // 日收益率序列 → 夏普
  const rets = [];
  for (let i = 1; i < equity.length; i++) {
    rets.push(equity[i].value / equity[i - 1].value - 1);
  }
  const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const variance = rets.length > 1 ? rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1) : 0;
  const std = Math.sqrt(variance);
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  // 基准：买入持有
  const bh = ((last.close - bars[0].open) / bars[0].open) * 100;

  const closed = trades.filter((t) => t.type === 'sell');
  const wins = closed.filter((t) => t.profit > 0);
  const losses = closed.filter((t) => t.profit <= 0);
  const grossProfit = wins.reduce((a, t) => a + t.profit, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.profit, 0));
  const avgHold = closed.length ? closed.reduce((a, t) => a + (t.holdDays || 0), 0) / closed.length : 0;

  return {
    strategy,
    strategyName: STRATEGIES[strategy]?.name || strategy,
    params: p,
    initialCapital,
    finalCapital,
    totalReturn,
    annualized,
    benchmark: bh,
    alpha: totalReturn - bh,
    maxDrawdown: maxDD * 100,
    sharpe,
    winRate: closed.length ? (wins.length / closed.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0,
    tradeCount: closed.length,
    avgHoldDays: avgHold,
    avgWin: wins.length ? grossProfit / wins.length : 0,
    avgLoss: losses.length ? grossLoss / losses.length : 0,
    equity,
    trades,
    start: bars[0].date,
    end: last.date,
  };
}

function defaultParams(strategy) {
  const s = STRATEGIES[strategy];
  const out = {};
  if (s) for (const p of s.params) out[p.key] = p.def;
  return out;
}

function diffDays(a, b) {
  try {
    const d1 = new Date(a);
    const d2 = new Date(b);
    return Math.max(1, Math.round((d2 - d1) / 86400000));
  } catch {
    return 1;
  }
}

module.exports = { STRATEGIES, run, defaultParams };
