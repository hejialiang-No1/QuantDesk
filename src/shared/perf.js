/**
 * perf.js —— 绩效评估与归因
 *
 * 个人自用版里，回测最容易骗自己的地方就是「只看总收益」。
 * 这里补齐一整套风险调整后指标、回撤结构、基准对比和归因拆解，
 * 让「赚了钱」和「赚得值不值」分开看。
 *
 * 纯函数，输入统一为：
 *   equity  [{ date, value, position? , shares?, cash? }]  按日期升序
 *   bench   [{ date, value }]                              可选，基准净值序列
 *
 * 年化一律按 252 交易日，无风险利率可传（默认 4.3%，贴近近年美元短端）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Perf = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const TRADING_DAYS = 252;

  /** 基准清单：个人自用最常用的三个宽基 */
  const BENCHMARKS = [
    { key: 'SPY', name: '标普 500 ETF', secid: '105.SPY', note: '大盘基准，衡量整体市场环境' },
    { key: 'QQQ', name: '纳斯达克 100 ETF', secid: '105.QQQ', note: '科技成长基准，与高波动科技股相关性高' },
    { key: 'IWM', name: '罗素 2000 ETF', secid: '105.IWM', note: '小盘基准，衡量风险偏好' },
  ];

  function mean(a) {
    if (!a.length) return 0;
    return a.reduce((x, y) => x + y, 0) / a.length;
  }

  function stdev(a) {
    if (a.length < 2) return 0;
    const m = mean(a);
    return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
  }

  function downsideDev(a) {
    if (a.length < 2) return 0;
    const neg = a.filter((v) => v < 0);
    if (!neg.length) return 0;
    return Math.sqrt(neg.reduce((s, v) => s + v * v, 0) / neg.length);
  }

  /** 收益率序列（简单日收益） */
  function returnsOf(series) {
    const out = [];
    for (let i = 1; i < series.length; i++) {
      const a = series[i - 1].value;
      const b = series[i].value;
      if (a > 0) out.push({ date: series[i].date, r: b / a - 1 });
    }
    return out;
  }

  /** 相关系数 */
  function corr(a, b) {
    const n = Math.min(a.length, b.length);
    if (n < 2) return 0;
    const x = a.slice(0, n);
    const y = b.slice(0, n);
    const mx = mean(x);
    const my = mean(y);
    let num = 0;
    let dx = 0;
    let dy = 0;
    for (let i = 0; i < n; i++) {
      num += (x[i] - mx) * (y[i] - my);
      dx += (x[i] - mx) ** 2;
      dy += (y[i] - my) ** 2;
    }
    const d = Math.sqrt(dx * dy);
    return d > 0 ? num / d : 0;
  }

  /**
   * 最大回撤及其结构：幅度、区间、持续天数、恢复天数、水下时长。
   */
  function drawdown(equity) {
    let peak = -Infinity;
    let peakIdx = 0;
    let peakAtMax = 0;
    let maxDD = 0;
    let troughIdx = 0;
    let troughDate = null;
    let curStart = 0;
    const underwater = [];

    for (let i = 0; i < equity.length; i++) {
      const v = equity[i].value;
      if (v > peak) {
        peak = v;
        peakIdx = i;
        curStart = i;
      }
      const dd = peak > 0 ? (peak - v) / peak : 0;
      underwater.push(dd);
      if (dd > maxDD) {
        maxDD = dd;
        troughIdx = i;
        peakAtMax = peakIdx;
        troughDate = equity[i].date;
      }
    }

    // 恢复日：回撤低点之后首次回到前高
    let recoverIdx = -1;
    const peakVal = equity[peakAtMax] ? equity[peakAtMax].value : 0;
    for (let i = troughIdx + 1; i < equity.length; i++) {
      if (equity[i].value >= peakVal) {
        recoverIdx = i;
        break;
      }
    }

    const dayBetween = (a, b) => {
      try {
        return Math.max(0, Math.round((new Date(b) - new Date(a)) / 86400000));
      } catch {
        return 0;
      }
    };

    // 最长水下时间（连续处于回撤状态的最长跨度）
    let longestUW = 0;
    let runStart = -1;
    for (let i = 0; i < underwater.length; i++) {
      if (underwater[i] > 1e-6) {
        if (runStart < 0) runStart = i;
        longestUW = Math.max(longestUW, i - runStart + 1);
      } else {
        runStart = -1;
      }
    }

    return {
      maxDrawdown: maxDD * 100,
      peakDate: equity[peakAtMax] ? equity[peakAtMax].date : null,
      troughDate,
      recoveryDate: recoverIdx >= 0 ? equity[recoverIdx].date : null,
      drawdownDays: peakAtMax < troughIdx ? dayBetween(equity[peakAtMax].date, troughDate) : 0,
      recoveryDays: recoverIdx > troughIdx ? dayBetween(troughDate, equity[recoverIdx].date) : null,
      recovered: recoverIdx >= 0,
      longestUnderwaterDays: longestUW,
      underwater: underwater.map((d, i) => ({ date: equity[i].date, dd: d * 100 })),
    };
  }

  /**
   * VaR / CVaR：历史模拟法（更贴近实际分布）与参数法（正态假设）各给一份。
   * 返回「单日」亏损比例（正数表示可能亏损的百分比）。
   */
  function valueAtRisk(rets, level) {
    const L = level || 0.95;
    if (!rets.length) return { var: 0, cvar: 0, varParam: 0 };
    const sorted = rets.slice().sort((a, b) => a - b);
    const idx = Math.max(0, Math.floor((1 - L) * sorted.length));
    const varHist = -sorted[idx] * 100;
    const tail = sorted.slice(0, Math.max(1, idx + 1));
    const cvar = -mean(tail) * 100;
    const m = mean(rets);
    const s = stdev(rets);
    // 95% → 1.645σ，99% → 2.326σ
    const z = L >= 0.99 ? 2.326 : L >= 0.975 ? 1.96 : 1.645;
    const varParam = Math.max(0, (z * s - m) * 100);
    return {
      level: L,
      var: varHist,
      cvar,
      varParam,
      unit: '单日',
      note: `历史模拟法：单日有 ${(L * 100).toFixed(0)}% 把握亏损不超过 ${varHist.toFixed(2)}%，尾部平均亏损 ${cvar.toFixed(2)}%。`,
    };
  }

  /**
   * 基准相关：Beta、Alpha（年化）、跟踪误差、信息比率、相关系数、涨跌捕获率。
   */
  function vsBenchmark(rets, benchRets, rfAnnual) {
    const rf = (rfAnnual == null ? 0.043 : rfAnnual) / TRADING_DAYS;
    const n = Math.min(rets.length, benchRets.length);
    if (n < 3) {
      return { beta: null, alpha: null, trackingError: null, infoRatio: null, corr: null, upCapture: null, downCapture: null };
    }
    const r = rets.slice(-n);
    const b = benchRets.slice(-n);
    const mb = mean(b);
    const mr = mean(r);

    let cov = 0;
    let varb = 0;
    for (let i = 0; i < n; i++) {
      cov += (r[i] - mr) * (b[i] - mb);
      varb += (b[i] - mb) ** 2;
    }
    cov /= n - 1;
    varb /= n - 1;
    const beta = varb > 0 ? cov / varb : null;

    const rb = r.map((v, i) => v - b[i]);
    const te = stdev(rb) * Math.sqrt(TRADING_DAYS);
    const active = mean(rb) * TRADING_DAYS;
    const alphaDaily = mr - (rf + (beta || 0) * (mb - rf));
    const alpha = alphaDaily * TRADING_DAYS * 100;

    // 涨跌捕获率：基准上涨/下跌时段，策略相对表现
    const up = [];
    const down = [];
    for (let i = 0; i < n; i++) (b[i] >= 0 ? up : down).push({ r: r[i], b: b[i] });
    const capture = (arr) => {
      if (!arr.length) return null;
      const sr = arr.reduce((s, x) => s + x.r, 0);
      const sb = arr.reduce((s, x) => s + x.b, 0);
      return sb !== 0 ? (sr / sb) * 100 : null;
    };

    return {
      beta: beta == null ? null : Number(beta.toFixed(3)),
      alpha: Number(alpha.toFixed(2)),
      trackingError: Number((te * 100).toFixed(2)),
      infoRatio: te > 0 ? Number((active / te).toFixed(3)) : null,
      corr: Number(corr(r, b).toFixed(3)),
      upCapture: capture(up),
      downCapture: capture(down),
      benchDays: n,
    };
  }

  /**
   * 交易统计：胜率、盈亏比、期望值、平均盈亏、连续盈亏、按持有期分布。
   */
  function tradeStats(trades) {
    const closed = (trades || []).filter((t) => t.type === 'sell' && t.profit != null);
    if (!closed.length) {
      return {
        count: 0, winRate: 0, profitFactor: 0, expectancy: 0, avgWin: 0, avgLoss: 0,
        maxWinStreak: 0, maxLossStreak: 0, avgHoldDays: 0, bestTrade: null, worstTrade: null,
        payoffRatio: 0, byHold: [],
      };
    }
    const wins = closed.filter((t) => t.profit > 0);
    const losses = closed.filter((t) => t.profit <= 0);
    const gp = wins.reduce((s, t) => s + t.profit, 0);
    const gl = Math.abs(losses.reduce((s, t) => s + t.profit, 0));
    const avgWin = wins.length ? gp / wins.length : 0;
    const avgLoss = losses.length ? gl / losses.length : 0;

    let ws = 0;
    let ls = 0;
    let mws = 0;
    let mls = 0;
    for (const t of closed) {
      if (t.profit > 0) {
        ws++;
        ls = 0;
      } else {
        ls++;
        ws = 0;
      }
      mws = Math.max(mws, ws);
      mls = Math.max(mls, ls);
    }

    const avgHold = mean(closed.map((t) => t.holdDays || 0));

    // 按持有期分档，看「短线还是中长线更赚钱」
    const buckets = [
      { label: '≤5 个交易日', test: (d) => d <= 5 },
      { label: '6–20 个交易日', test: (d) => d > 5 && d <= 20 },
      { label: '21–60 个交易日', test: (d) => d > 20 && d <= 60 },
      { label: '> 60 个交易日', test: (d) => d > 60 },
    ];
    const byHold = buckets.map((b) => {
      const list = closed.filter((t) => b.test(t.holdDays || 0));
      const w = list.filter((t) => t.profit > 0).length;
      return {
        label: b.label,
        count: list.length,
        winRate: list.length ? (w / list.length) * 100 : 0,
        totalProfit: list.reduce((s, t) => s + t.profit, 0),
      };
    });

    return {
      count: closed.length,
      winRate: (wins.length / closed.length) * 100,
      profitFactor: gl > 0 ? gp / gl : gp > 0 ? 99 : 0,
      payoffRatio: avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? 99 : 0,
      expectancy: (wins.length / closed.length) * avgWin - (losses.length / closed.length) * avgLoss,
      avgWin,
      avgLoss,
      grossProfit: gp,
      grossLoss: gl,
      maxWinStreak: mws,
      maxLossStreak: mls,
      avgHoldDays: avgHold,
      bestTrade: closed.reduce((a, t) => (a == null || t.profit > a.profit ? t : a), null),
      worstTrade: closed.reduce((a, t) => (a == null || t.profit < a.profit ? t : a), null),
      byHold,
    };
  }

  /** 换手率：成交金额 / 平均权益（年化） */
  function turnover(trades, equity) {
    if (!equity || equity.length < 2) return { total: 0, annual: 0, costDrag: 0 };
    const traded = (trades || []).reduce((s, t) => s + Math.abs(t.amount || t.price * t.shares || 0), 0);
    const avgEq = mean(equity.map((e) => e.value));
    const days = equity.length;
    const total = avgEq > 0 ? traded / avgEq : 0;
    const annual = total * (TRADING_DAYS / Math.max(1, days));
    const fees = (trades || []).reduce((s, t) => s + (t.fee || 0), 0);
    return {
      tradedAmount: traded,
      total: total * 100,
      annual: annual * 100,
      feeTotal: fees,
      costDrag: avgEq > 0 ? (fees / avgEq) * 100 * (TRADING_DAYS / Math.max(1, days)) : 0,
    };
  }

  /**
   * 归因拆解。
   * @param {Object} o
   * @param {Array}  o.trades   交易明细（需带 symbol 或 code，可选 sector）
   * @param {Array}  o.equity   净值序列
   * @param {Array}  o.benchRets 基准日收益（可选）
   */
  function attribution(o) {
    const trades = o.trades || [];
    const closed = trades.filter((t) => t.type === 'sell' && t.profit != null);
    const totalProfit = closed.reduce((s, t) => s + t.profit, 0);

    // 1) 按标的贡献
    const bySymbol = new Map();
    for (const t of closed) {
      const k = t.symbol || t.code || '未标注';
      const cur = bySymbol.get(k) || { symbol: k, sector: t.sector || '', profit: 0, count: 0, wins: 0, invested: 0 };
      cur.profit += t.profit;
      cur.count++;
      cur.invested += Math.abs(t.entryAmount || t.amount || 0);
      if (t.profit > 0) cur.wins++;
      bySymbol.set(k, cur);
    }
    const symbols = [...bySymbol.values()]
      .map((s) => ({
        ...s,
        contribution: totalProfit !== 0 ? (s.profit / Math.abs(totalProfit)) * 100 * (totalProfit < 0 ? -1 : 1) : 0,
        winRate: s.count ? (s.wins / s.count) * 100 : 0,
        roi: s.invested > 0 ? (s.profit / s.invested) * 100 : 0,
      }))
      .sort((a, b) => b.profit - a.profit);

    // 2) 按行业贡献
    const bySector = new Map();
    for (const s of symbols) {
      const k = s.sector || '未分类';
      const cur = bySector.get(k) || { sector: k, profit: 0, count: 0, symbols: [] };
      cur.profit += s.profit;
      cur.count += s.count;
      cur.symbols.push(s.symbol);
      bySector.set(k, cur);
    }
    const sectors = [...bySector.values()].sort((a, b) => b.profit - a.profit);

    // 3) 择时 vs 选股：
    //    选股 = 假设始终满仓时，标的相对基准的超额；
    //    择时 = 实际持仓暴露与基准收益的交互。
    let timing = 0;
    let selection = 0;
    const eq = o.equity || [];
    if (eq.length > 1 && o.benchRets && o.benchRets.length) {
      const n = Math.min(eq.length - 1, o.benchRets.length);
      let cashDays = 0;
      for (let i = 0; i < n; i++) {
        const pos = eq[i + 1].position;
        const br = o.benchRets[o.benchRets.length - n + i];
        if (pos) selection += br;
        else {
          cashDays++;
          timing -= br; // 空仓踏空的收益差
        }
      }
      selection *= 100;
      timing *= 100;
    }

    // 4) 按持有期贡献（短线 vs 中长线）
    const holdBuckets = [
      { label: '≤5 日', test: (d) => d <= 5 },
      { label: '6–20 日', test: (d) => d > 5 && d <= 20 },
      { label: '21–60 日', test: (d) => d > 20 && d <= 60 },
      { label: '> 60 日', test: (d) => d > 60 },
    ].map((b) => {
      const list = closed.filter((t) => b.test(t.holdDays || 0));
      return { label: b.label, count: list.length, profit: list.reduce((s, t) => s + t.profit, 0) };
    });

    return {
      totalProfit,
      symbols,
      sectors,
      topContributor: symbols[0] || null,
      worstContributor: symbols[symbols.length - 1] || null,
      timing: Number(timing.toFixed(2)),
      selection: Number(selection.toFixed(2)),
      holdBuckets,
      concentration: (() => {
        if (!symbols.length) return { hhi: 0, level: '无数据', top1Pct: 0 };
        const tot = symbols.reduce((s, x) => s + Math.abs(x.profit), 0);
        if (tot <= 0) return { hhi: 0, level: '无数据', top1Pct: 0 };
        const hhi = symbols.reduce((s, x) => s + (Math.abs(x.profit) / tot) ** 2, 0);
        const top1 = Math.abs(symbols[0].profit) / tot;
        return {
          hhi: Number(hhi.toFixed(3)),
          level: hhi > 0.5 ? '高度集中' : hhi > 0.25 ? '中等集中' : '较为分散',
          top1Pct: Number((top1 * 100).toFixed(1)),
        };
      })(),
    };
  }

  /**
   * 主入口：一次性算出全套绩效。
   * @param {Object} o
   * @param {Array}  o.equity      净值序列 [{date,value,position}]
   * @param {Array}  [o.trades]    交易明细
   * @param {Array}  [o.bench]     基准净值序列 [{date,value}]
   * @param {String} [o.benchName]
   * @param {Number} [o.rf]        年化无风险利率
   * @param {Number} [o.initialCapital]
   */
  function evaluate(o) {
    const equity = (o.equity || []).filter((e) => e && isFinite(e.value));
    if (equity.length < 3) return null;

    const rets = returnsOf(equity).map((x) => x.r);
    const first = o.initialCapital != null ? o.initialCapital : equity[0].value;
    const last = equity[equity.length - 1].value;
    const days = (() => {
      try {
        return Math.max(1, Math.round((new Date(equity[equity.length - 1].date) - new Date(equity[0].date)) / 86400000));
      } catch {
        return equity.length;
      }
    })();
    const years = Math.max(days / 365.25, 1 / 365.25);

    const totalReturn = first > 0 ? (last / first - 1) * 100 : 0;
    const cagr = first > 0 && last > 0 ? (Math.pow(last / first, 1 / years) - 1) * 100 : 0;
    const vol = stdev(rets) * Math.sqrt(TRADING_DAYS) * 100;
    const ddDev = downsideDev(rets) * Math.sqrt(TRADING_DAYS) * 100;
    const rf = o.rf == null ? 0.043 : o.rf;

    const sharpe = vol > 0 ? (cagr - rf * 100) / vol : 0;
    const sortino = ddDev > 0 ? (cagr - rf * 100) / ddDev : 0;

    const ddx = drawdown(equity);
    const calmar = ddx.maxDrawdown > 0 ? cagr / ddx.maxDrawdown : 0;

    const benchRets = o.bench && o.bench.length > 2 ? returnsOf(o.bench).map((x) => x.r) : null;
    const vs = benchRets ? vsBenchmark(rets, benchRets, rf) : null;

    const benchTotal = o.bench && o.bench.length > 1 ? (o.bench[o.bench.length - 1].value / o.bench[0].value - 1) * 100 : null;

    const ts = tradeStats(o.trades);
    const to = turnover(o.trades, equity);
    const var95 = valueAtRisk(rets, 0.95);
    const var99 = valueAtRisk(rets, 0.99);
    const attr = o.trades && o.trades.length ? attribution({ trades: o.trades, equity, benchRets }) : null;

    return {
      start: equity[0].date,
      end: equity[equity.length - 1].date,
      days,
      years: Number(years.toFixed(2)),
      initialCapital: first,
      finalCapital: last,
      totalReturn,
      cagr,
      annualVol: vol,
      downsideVol: ddDev,
      sharpe,
      sortino,
      calmar,
      maxDrawdown: ddx.maxDrawdown,
      drawdown: ddx,
      var95,
      var99,
      benchmark: benchTotal,
      benchName: o.benchName || null,
      excessReturn: benchTotal != null ? totalReturn - benchTotal : null,
      vs,
      trades: ts,
      turnover: to,
      attribution: attr,
    };
  }

  /** 把绩效对象转成「指标卡」数组，供界面直接渲染 */
  function cards(p) {
    if (!p) return [];
    const f = (v, d) => (v == null || !isFinite(v) ? '—' : Number(v).toFixed(d == null ? 2 : d));
    const tone = (v, invert) => {
      if (v == null || !isFinite(v)) return 'flat';
      const good = invert ? v < 0 : v > 0;
      return Math.abs(v) < 1e-9 ? 'flat' : good ? 'up' : 'down';
    };
    const list = [
      { label: '累计收益', value: f(p.totalReturn) + '%', tone: tone(p.totalReturn), sub: `${p.start} → ${p.end}` },
      { label: '年化收益 CAGR', value: f(p.cagr) + '%', tone: tone(p.cagr), sub: `持有 ${p.years} 年` },
      { label: '年化波动率', value: f(p.annualVol) + '%', tone: 'flat', sub: '日收益标准差 ×√252' },
      { label: '夏普比率', value: f(p.sharpe), tone: tone(p.sharpe), sub: `无风险利率 ${(0.043 * 100).toFixed(1)}%` },
      { label: '索提诺比率', value: f(p.sortino), tone: tone(p.sortino), sub: `下行波动 ${f(p.downsideVol)}%` },
      { label: '卡玛比率', value: f(p.calmar), tone: tone(p.calmar), sub: '年化收益 ÷ 最大回撤' },
      { label: '最大回撤', value: '-' + f(p.maxDrawdown) + '%', tone: 'down', sub: `${p.drawdown.peakDate} → ${p.drawdown.troughDate}` },
      { label: '回撤修复', value: p.drawdown.recovered ? '已修复' : '未修复', tone: p.drawdown.recovered ? 'up' : 'down', sub: p.drawdown.recovered ? `用时 ${p.drawdown.recoveryDays} 天` : `已水下 ${p.drawdown.longestUnderwaterDays} 个交易日` },
      { label: '日 VaR(95%)', value: '-' + f(p.var95.var) + '%', tone: 'down', sub: `CVaR -${f(p.var95.cvar)}%` },
      { label: '胜率', value: f(p.trades.winRate, 1) + '%', tone: p.trades.winRate >= 50 ? 'up' : 'down', sub: `${p.trades.count} 笔已平仓` },
      { label: '盈亏比', value: f(p.trades.payoffRatio), tone: p.trades.payoffRatio >= 1 ? 'up' : 'down', sub: `利润因子 ${f(p.trades.profitFactor)}` },
      { label: '换手率（年化）', value: f(p.turnover.annual, 0) + '%', tone: 'flat', sub: `成本拖累 ${f(p.turnover.costDrag)}%/年` },
    ];
    if (p.benchmark != null) {
      list.splice(3, 0, { label: `超额收益 vs ${p.benchName || '基准'}`, value: f(p.excessReturn) + '%', tone: tone(p.excessReturn), sub: `基准 ${f(p.benchmark)}%` });
    }
    if (p.vs && p.vs.beta != null) {
      list.push({ label: 'Beta / Alpha', value: `${f(p.vs.beta, 2)} / ${f(p.vs.alpha)}%`, tone: tone(p.vs.alpha), sub: `跟踪误差 ${f(p.vs.trackingError)}%` });
      list.push({ label: '信息比率', value: f(p.vs.infoRatio), tone: tone(p.vs.infoRatio), sub: `相关性 ${f(p.vs.corr, 2)}` });
    }
    return list;
  }

  return {
    TRADING_DAYS,
    BENCHMARKS,
    returnsOf,
    drawdown,
    valueAtRisk,
    vsBenchmark,
    tradeStats,
    turnover,
    attribution,
    evaluate,
    cards,
    mean,
    stdev,
  };
});
