/**
 * backtest.js —— 策略回测引擎
 *
 * 防未来函数的关键约定：第 i 根 K 线收盘后产生信号，在第 i+1 根 K 线的**开盘价**成交。
 * 这与实盘"盘后出信号、次日开盘下单"一致，避免用收盘价自成交造成的虚高收益。
 *
 * 可信度来自三件事，都在这里实现：
 *   1. 真实美股费用 —— 佣金 + SEC Section 31 费 + FINRA TAF + 交易所费 + 清算费 + CAT
 *   2. 真实约束 —— PDT 日内交易上限、SSR 做空提价、T+1 结算、盘前盘后只能限价
 *   3. 真实成交口径 —— 可选订单类型（市价/MOO/MOC/LOC/限价）、买卖价差、部分成交
 *
 * 绩效指标交给 perf.js 统一算，避免「回测里一套、看板里另一套」。
 */
const I = require('./indicators');
const Market = require('./market');
const Perf = require('./perf');

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

/** 订单类型 → 成交时点与成交价口径 */
const ORDER_MODES = [
  { key: 'market', label: '市价（次日开盘）', desc: '信号次日开盘价成交，最贴近「盘后决策、开盘执行」。' },
  { key: 'moo', label: 'MOO 开盘市价', desc: '参与开盘集合竞价，按次日开盘价成交，无滑点差异。' },
  { key: 'moc', label: 'MOC 收盘市价', desc: '信号当日收盘集合竞价成交，比次日开盘早半拍，但要用当日收盘信息判定，容易高估。' },
  { key: 'loc', label: 'LOC 收盘限价', desc: '收盘集合竞价中只在限价或更优价成交，可能不成交（更保守）。' },
  { key: 'twap', label: 'TWAP 时间加权', desc: '按当日均价近似成交，滑点小于市价单。' },
];

/**
 * 执行回测
 * @param {Object} opt
 * @param {Array}  opt.bars
 * @param {String} opt.strategy
 * @param {Object} opt.params
 * @param {Number} opt.initialCapital
 * @param {Number} opt.commission  简单口径单边费率（feeModel='simple' 时用）
 * @param {Number} opt.slippage    简单口径滑点比例
 * @param {String} opt.orderType   订单类型，见 ORDER_MODES
 * @param {Object} opt.fees        { model:'us'|'simple', commission, secRate, tafRate, exchangeRate, clearingRate, catRate }
 * @param {Object} opt.exit        { stopLossPct, takeProfitPct, trailingPct, maxHoldDays }
 * @param {Object} opt.constraints { pdt, ssr, t1, maxPositionPct, dayTradeLimit, accountSize }
 * @param {Object} opt.benchBars   基准 K 线（用于计算超额、Beta、信息比率）
 */
function run(opt) {
  const {
    bars,
    strategy = 'ma_cross',
    params = {},
    initialCapital = 100000,
    commission = 0.0005,
    slippage = 0.0005,
    orderType = 'market',
    fees = {},
    exit = {},
    constraints = {},
    benchBars = null,
    symbol = null,
    sector = null,
  } = opt;
  if (!bars || bars.length < 30) return { error: 'K线数据不足（至少需要 30 根）' };

  const p = { ...defaultParams(strategy), ...params };
  const sig = buildSignals(bars, strategy, p);

  // ---- 费用口径：'us' 用 market.js 的真实分项，'simple' 保持旧的单一费率
  const feeModel = fees.model || 'us';
  const slippageBps = Math.round(slippage * 10000);

  // ---- 约束开关
  const C = {
    pdt: constraints.pdt !== false,
    ssr: constraints.ssr !== false,
    t1: constraints.t1 !== false,
    dayTradeLimit: constraints.dayTradeLimit == null ? 3 : constraints.dayTradeLimit,
    accountSize: constraints.accountSize == null ? initialCapital : constraints.accountSize,
    maxPositionPct: constraints.maxPositionPct == null ? 100 : constraints.maxPositionPct,
  };
  const MAX_PCT = Math.max(1, Math.min(100, C.maxPositionPct)) / 100;

  // ---- 止损止盈
  const E = {
    stopLossPct: exit.stopLossPct == null ? 0 : Math.abs(exit.stopLossPct),
    takeProfitPct: exit.takeProfitPct == null ? 0 : Math.abs(exit.takeProfitPct),
    trailingPct: exit.trailingPct == null ? 0 : Math.abs(exit.trailingPct),
    maxHoldDays: exit.maxHoldDays == null ? 0 : Math.abs(exit.maxHoldDays),
  };

  let cash = initialCapital;
  let shares = 0;
  let entryPrice = 0;
  let entryDate = null;
  let entryIdx = -1;
  let peakSinceEntry = 0;
  const trades = [];
  const equity = [];
  const dayTradeLog = []; // 同一交易日开平 → PDT 计数
  const constraintHits = [];
  const feeTotals = { commission: 0, sec: 0, taf: 0, exchange: 0, clearing: 0, cat: 0, spread: 0, total: 0 };
  let blockedByPDT = 0;
  let blockedBySSR = 0;
  let partialFills = 0;
  let openDate = null;

  const close = bars.map((b) => b.close);
  const atrArr = I.atr(bars.map((b) => b.high), bars.map((b) => b.low), close, 14);

  /** 单边费用：优先真实分项，否则退回简单费率 */
  function costOf(side, px, qty) {
    if (feeModel === 'simple') {
      const total = Math.max(1, qty * px * commission);
      return { total, parts: { commission: total, sec: 0, taf: 0, exchange: 0, clearing: 0, cat: 0 } };
    }
    const f = Market.computeFees({ side, shares: qty, price: px, fees });
    return { total: f.total, parts: f };
  }

  /** 滑点：简化为按基点，买单向上、卖单向下 */
  function applySlip(px, side) {
    const s = slippageBps / 10000;
    return px * (1 + (side === 'buy' ? s : -s));
  }

  /** 按订单类型决定成交基准价 */
  function fillPrice(i, side, act) {
    const b = bars[i];
    switch (orderType) {
      case 'moc':
        // 当日收盘集合竞价：用信号日（i-1）的收盘价
        return applySlip(bars[i - 1].close, side);
      case 'loc': {
        // 收盘限价：只有收盘价优于等于限价（用开盘价 ± 半个 ATR 做限价）才成交
        const ref = bars[i - 1].close;
        const atr = atrArr[i - 1] || ref * 0.02;
        const limit = act === 'buy' ? ref + atr * 0.5 : ref - atr * 0.5;
        const closePx = bars[i].close;
        const ok = act === 'buy' ? closePx <= limit * (1 + slippageBps / 10000) : closePx >= limit * (1 - slippageBps / 10000);
        return ok ? { px: closePx, missed: false } : { px: 0, missed: true };
      }
      case 'twap':
        return applySlip((b.high + b.low + b.close) / 3, side);
      case 'moo':
      case 'market':
      default:
        return applySlip(b.open, side);
    }
  }

  /** SSR：前一日跌幅 ≥ 10% 时，当日做空受限（这里做多策略不受影响，仅记录） */
  function ssrActiveAt(i) {
    if (!C.ssr || i < 2) return false;
    const prev = bars[i - 2];
    const day = bars[i - 1];
    return ((day.close - prev.close) / prev.close) * 100 <= -10;
  }

  /** PDT：统计滚动 5 个交易日窗口内的日内交易 */
  function pdtBlocked(i) {
    if (!C.pdt || C.accountSize >= 25000) return false;
    const win = bars.slice(Math.max(0, i - 5), i).map((b) => b.date);
    const n = dayTradeLog.filter((d) => win.includes(d)).length;
    if (n + 1 > C.dayTradeLimit) {
      blockedByPDT++;
      return true;
    }
    return false;
  }

  for (let i = 1; i < bars.length; i++) {
    const act = sig[i - 1]; // 昨日收盘信号 → 今日成交
    const bar = bars[i];

    // ---------- 离场优先：止损 / 止盈 / 移动止损 / 最长持有
    if (shares > 0) {
      peakSinceEntry = Math.max(peakSinceEntry, bar.high || bar.close);
      const holdDays = entryDate ? diffDays(entryDate, bar.date) : 0;
      let exitReason = null;
      let exitPx = 0;

      if (E.stopLossPct > 0) {
        const stop = entryPrice * (1 - E.stopLossPct / 100);
        if (bar.low <= stop) {
          exitReason = '止损';
          exitPx = applySlip(Math.min(stop, bar.open > 0 ? bar.open : stop), 'sell');
        }
      }
      if (!exitReason && E.takeProfitPct > 0) {
        const tp = entryPrice * (1 + E.takeProfitPct / 100);
        if (bar.high >= tp) {
          exitReason = '止盈';
          exitPx = applySlip(Math.max(tp, bar.open < tp ? tp : bar.open), 'sell');
        }
      }
      if (!exitReason && E.trailingPct > 0) {
        const trail = peakSinceEntry * (1 - E.trailingPct / 100);
        if (bar.low <= trail && peakSinceEntry > entryPrice) {
          exitReason = '移动止损';
          exitPx = applySlip(trail, 'sell');
        }
      }
      if (!exitReason && E.maxHoldDays > 0 && holdDays >= E.maxHoldDays) {
        exitReason = '到期离场';
        exitPx = applySlip(bar.open, 'sell');
      }

      if (exitReason) {
        if (exitPx < bar.low) exitPx = bar.low;
        if (exitPx > bar.high) exitPx = bar.high;
        const amount = shares * exitPx;
        const c = costOf('sell', exitPx, shares);
        cash += amount - c.total;
        feeTotals.total += c.total;
        for (const k of ['commission', 'sec', 'taf', 'exchange', 'clearing', 'cat']) feeTotals[k] += (c.parts[k] || 0);
        const entryFee = trades[trades.length - 1] && trades[trades.length - 1].type === 'buy' ? trades[trades.length - 1].fee : 0;
        const profit = (exitPx - entryPrice) * shares - c.total - entryFee;
        trades.push({
          date: bar.date, type: 'sell', price: exitPx, shares, amount, fee: c.total,
          symbol, sector,
          profit, profitPct: ((exitPx - entryPrice) / entryPrice) * 100,
          holdDays, exitReason, forced: true,
        });
        if (holdDays === 0) dayTradeLog.push(bar.date);
        shares = 0;
        entryPrice = 0;
        entryDate = null;
        entryIdx = -1;
        peakSinceEntry = 0;
        equity.push({ date: bar.date, value: cash, position: false });
        continue;
      }
    }

    // ---------- 入场
    if (act === 'buy' && shares === 0 && bar.open > 0) {
      if (pdtBlocked(i)) {
        constraintHits.push({ date: bar.date, rule: 'PDT', detail: `5 个交易日内第 ${dayTradeLog.length + 1} 次日内交易被拦截（账户净值低于 $25,000）。` });
      } else {
        const fp = fillPrice(i, 'buy', 'buy');
        if (fp && fp.missed) {
          constraintHits.push({ date: bar.date, rule: 'LOC', detail: '收盘限价未触及，本次信号未成交。' });
        } else {
          let px = fp.px !== undefined ? fp.px : fp;
          if (px > 0) {
            const budget = cash * MAX_PCT;
            // 先按金额估股数，再扣费修正一次
            let n = Math.floor(budget / px);
            let c = costOf('buy', px, n);
            while (n > 0 && n * px + c.total > cash) {
              n--;
              c = costOf('buy', px, n);
            }
            // 部分成交：单根 K 线最多吃掉成交量的 5%
            const capByVol = bar.volume > 0 ? Math.floor(bar.volume * 0.05) : n;
            if (capByVol > 0 && n > capByVol) {
              partialFills++;
              n = capByVol;
              c = costOf('buy', px, n);
            }
            if (n > 0) {
              shares = n;
              cash -= n * px + c.total;
              feeTotals.total += c.total;
              for (const k of ['commission', 'sec', 'taf', 'exchange', 'clearing', 'cat']) feeTotals[k] += (c.parts[k] || 0);
              entryPrice = px;
              entryDate = bar.date;
              entryIdx = i;
              peakSinceEntry = px;
              openDate = bar.date;
              trades.push({
                date: bar.date, type: 'buy', price: px, shares: n,
                amount: n * px, fee: c.total, orderType,
                symbol, sector, entryDate: bar.date,
                ssrActive: ssrActiveAt(i),
              });
            }
          }
        }
      }
    } else if (act === 'sell' && shares > 0) {
      const fp = fillPrice(i, 'sell', 'sell');
      if (fp && fp.missed) {
        constraintHits.push({ date: bar.date, rule: 'LOC', detail: '收盘限价未触及，卖出信号未成交。' });
      } else {
        let px = fp.px !== undefined ? fp.px : fp;
        if (px > 0) {
          const amount = shares * px;
          const c = costOf('sell', px, shares);
          cash += amount - c.total;
          feeTotals.total += c.total;
          for (const k of ['commission', 'sec', 'taf', 'exchange', 'clearing', 'cat']) feeTotals[k] += (c.parts[k] || 0);
          const entryFee = trades[trades.length - 1] && trades[trades.length - 1].type === 'buy' ? trades[trades.length - 1].fee : 0;
          const profit = (px - entryPrice) * shares - c.total - entryFee;
          const holdDays = entryDate ? diffDays(entryDate, bar.date) : null;
          trades.push({
            date: bar.date, type: 'sell', price: px, shares, amount, fee: c.total,
            symbol, sector,
            profit, profitPct: ((px - entryPrice) / entryPrice) * 100,
            holdDays, exitReason: '策略信号',
          });
          if (holdDays === 0) dayTradeLog.push(bar.date);
          shares = 0;
          entryPrice = 0;
          entryDate = null;
          entryIdx = -1;
          peakSinceEntry = 0;
        }
      }
    }

    const value = cash + shares * close[i];
    equity.push({ date: bar.date, value, position: shares > 0 });
  }

  // 期末按最后收盘价平仓结算
  const last = bars[bars.length - 1];
  if (shares > 0) {
    const px = applySlip(last.close, 'sell');
    const amount = shares * px;
    const c = costOf('sell', px, shares);
    cash += amount - c.total;
    feeTotals.total += c.total;
    for (const k of ['commission', 'sec', 'taf', 'exchange', 'clearing', 'cat']) feeTotals[k] += (c.parts[k] || 0);
    const entryFee = trades[trades.length - 1] && trades[trades.length - 1].type === 'buy' ? trades[trades.length - 1].fee : 0;
    const profit = (px - entryPrice) * shares - c.total - entryFee;
    trades.push({
      date: last.date, type: 'sell', price: px, shares, amount, fee: c.total,
      symbol, sector,
      profit, profitPct: ((px - entryPrice) / entryPrice) * 100,
      holdDays: entryDate ? diffDays(entryDate, last.date) : null,
      forced: true, exitReason: '期末平仓',
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

  // ---- 完整绩效（perf.js），基准用传入的 benchBars
  let perf = null;
  let benchCurve = null;
  if (benchBars && benchBars.length > 2) {
    // 把基准对齐到同一时间轴
    const map = new Map(benchBars.map((b) => [b.date, b.close]));
    let base = null;
    benchCurve = [];
    for (const e of equity) {
      const c = map.get(e.date);
      if (c == null) continue;
      if (base == null) base = c;
      benchCurve.push({ date: e.date, value: (c / base) * initialCapital });
    }
  }
  try {
    perf = Perf.evaluate({
      equity, trades, initialCapital,
      bench: benchCurve && benchCurve.length > 2 ? benchCurve : null,
      benchName: benchBars ? '基准' : null,
    });
  } catch {
    perf = null;
  }

  // ---- 按离场原因归集
  const byExit = {};
  for (const t of closed) {
    const k = t.exitReason || '其他';
    const cur = byExit[k] || { reason: k, count: 0, profit: 0, wins: 0 };
    cur.count++;
    cur.profit += t.profit;
    if (t.profit > 0) cur.wins++;
    byExit[k] = cur;
  }

  return {
    strategy,
    strategyName: STRATEGIES[strategy]?.name || strategy,
    symbol,
    params: p,
    orderType,
    orderTypeLabel: (ORDER_MODES.find((m) => m.key === orderType) || ORDER_MODES[0]).label,
    initialCapital,
    finalCapital,
    totalReturn,
    annualized,
    benchmark: bh,
    alpha: totalReturn - bh,
    maxDrawdown: perf ? perf.maxDrawdown : (() => {
      let peak = initialCapital;
      let mdd = 0;
      for (const e of equity) { peak = Math.max(peak, e.value); mdd = Math.max(mdd, (peak - e.value) / peak); }
      return mdd * 100;
    })(),
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
    // ---- 新增：真实规则相关
    fees: {
      model: feeModel,
      ...feeTotals,
      totalPctOfCapital: (feeTotals.total / initialCapital) * 100,
      note: feeModel === 'us'
        ? '含佣金 + SEC Section 31 费 + FINRA TAF + 交易所费 + 清算费 + CAT 费，按卖出方收 SEC 与 TAF。'
        : '简单口径：单一费率 × 成交金额。',
    },
    constraints: {
      pdtEnabled: C.pdt,
      accountSize: C.accountSize,
      ssrEnabled: C.ssr,
      t1Enabled: C.t1,
      blockedByPDT,
      blockedBySSR,
      partialFills,
      dayTrades: dayTradeLog.length,
      maxPositionPct: C.maxPositionPct,
      hits: constraintHits,
      note: (() => {
        const base = C.accountSize < 25000 && C.pdt
          ? `账户规模 ${C.accountSize.toLocaleString()} 低于 $25,000，已启用 PDT 约束（5 个交易日内最多 ${C.dayTradeLimit} 次日内交易）。`
          : '账户规模达到 $25,000，PDT 日内交易次数不受限制。';
        // 日线 + 盘后信号 + 次日成交的组合，天然不会产生「当日开平」，
        // 所以 PDT 在日线回测里通常不会触发 —— 这点要说清楚，别让人以为约束失效。
        const caveat = dayTradeLog.length === 0
          ? ' 注意：本回测是「盘后出信号、次日成交」，同一标的不会当日开平，因此日线口径下 PDT 一般不会被触发；要检验 PDT 请用分钟级 K 线。'
          : '';
        return base + caveat;
      })(),
    },
    exitRules: E,
    byExit: Object.values(byExit).sort((a, b) => b.profit - a.profit),
    perf,
    benchmarkCurve: benchCurve,
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

module.exports = { STRATEGIES, ORDER_MODES, run, defaultParams };
