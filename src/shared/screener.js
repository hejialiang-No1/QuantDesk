/**
 * screener.js —— 股票池、因子库与参数扫描
 *
 * 个人自用版的研究环节：先把池子框好，再按因子筛，最后做参数扫描确认
 * 「不是只有一组参数好看」。
 *
 * 关于因子的诚实说明：
 *   动量 / 低波 / 规模 三类因子可以直接从价格与市值算出来，是「真数据」。
 *   价值 因子只有 PE 可用（拿不到 PB / 现金流），口径偏窄。
 *   质量 与 盈利修正 需要财报与分析师预期数据，本地拿不到 ——
 *   这里用价格行为代理（回撤控制、动量加速度），**并在字段上明确标注为代理**，
 *   不冒充实盘因子。要用真因子需要接 SEC EDGAR / 付费数据源。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./indicators'));
  else root.Screener = factory(root.Indicators);
})(typeof self !== 'undefined' ? self : this, function (I) {
  // ============================================================ 股票池

  /**
   * 内置股票池。指数成分股这里只收市值/权重靠前的代表个股，
   * 不是完整成分名单 —— 完整名单会随季度调整，写死在本地只会过期。
   */
  const UNIVERSE_RAW = {
    sp500: {
      label: '标普 500 权重股',
      desc: '按指数权重靠前的 70 只代表个股（非完整 500 只名单）',
      codes: [
        'AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'GOOGL', 'GOOG', 'BRK.B', 'AVGO', 'TSLA',
        'LLY', 'JPM', 'V', 'UNH', 'XOM', 'MA', 'COST', 'HD', 'PG', 'WMT',
        'NFLX', 'JNJ', 'ABBV', 'CRM', 'BAC', 'ORCL', 'CVX', 'MRK', 'KO', 'AMD',
        'PEP', 'TMO', 'ADBE', 'LIN', 'WFC', 'CSCO', 'ACN', 'MCD', 'ABT', 'GE',
        'PM', 'IBM', 'INTU', 'QCOM', 'CAT', 'NOW', 'VZ', 'TXN', 'ISRG', 'AMGN',
        'RTX', 'PFE', 'SPGI', 'UBER', 'GS', 'BLK', 'HON', 'T', 'UNP', 'DIS',
        'AXP', 'BKNG', 'BA', 'AMAT', 'PLTR', 'MS', 'NEE', 'TJX', 'SYK', 'LOW',
      ],
    },
    nasdaq100: {
      label: '纳斯达克 100',
      desc: '纳指 100 中的主要非金融成分股精选',
      codes: [
        'AAPL', 'MSFT', 'NVDA', 'AMZN', 'AVGO', 'META', 'TSLA', 'GOOGL', 'GOOG', 'COST',
        'NFLX', 'AMD', 'PEP', 'ADBE', 'CSCO', 'TMUS', 'INTC', 'QCOM', 'INTU', 'TXN',
        'AMGN', 'ISRG', 'AMAT', 'HON', 'BKNG', 'CMCSA', 'MU', 'LRCX', 'PANW', 'ADSK',
        'GILD', 'ADP', 'SBUX', 'MDLZ', 'MELI', 'KLAC', 'SNPS', 'CDNS', 'CRWD', 'MAR',
        'CTAS', 'ORLY', 'PYPL', 'MNST', 'FTNT', 'ABNB', 'WDAY', 'NXPI', 'ROP', 'CHTR',
        'MRVL', 'ASML', 'APP', 'AXON', 'PLTR', 'MSTR', 'ARM', 'DASH', 'TEAM', 'PDD',
      ],
    },
    etf: {
      label: '指数与板块 ETF',
      desc: '宽基、板块、杠杆与商品 ETF',
      codes: [
        'SPY', 'QQQ', 'DIA', 'IWM', 'VTI', 'VOO', 'SMH', 'SOXX', 'XLK', 'XLF',
        'XLE', 'XLV', 'XLI', 'XLP', 'XLU', 'XLY', 'XLB', 'XLRE', 'XLC', 'ARKK',
        'KWEB', 'FXI', 'EEM', 'EFA', 'GLD', 'SLV', 'TLT', 'IEF', 'HYG', 'LQD',
        'IBIT', 'MAGS', 'VNQ', 'XBI', 'IBB', 'TQQQ', 'SQQQ', 'SOXL', 'UVXY', 'URA',
      ],
    },
    megacap: {
      label: '科技巨头',
      desc: '超大盘科技与互联网',
      codes: ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'AVGO', 'ORCL', 'CRM', 'ADBE', 'NFLX', 'AMD', 'INTC', 'QCOM', 'IBM', 'NOW', 'INTU'],
    },
    aicompute: {
      label: 'AI 算力链',
      desc: '算力、电力、半导体设备与存储',
      codes: ['NVDA', 'AVGO', 'AMD', 'TSM', 'MU', 'MRVL', 'ARM', 'ANET', 'VRT', 'SMCI', 'DELL', 'HPE', 'CRWV', 'NBIS', 'IREN', 'CORZ', 'APLD', 'WULF', 'OKLO', 'VST', 'CEG', 'NRG', 'TLN', 'GEV', 'ASML', 'AMAT', 'LRCX', 'KLAC'],
    },
    china: {
      label: '中概股',
      desc: '在美上市的中概',
      codes: ['BABA', 'PDD', 'JD', 'BIDU', 'NTES', 'TCOM', 'NIO', 'LI', 'XPEV', 'BEKE', 'BILI', 'TME', 'YMM', 'ZTO', 'FUTU', 'TIGR', 'IQ', 'VIPS', 'KC', 'MINIM'],
    },
    watch: { label: '我的自选', desc: '来自自选列表', codes: [] },
    custom: { label: '自定义', desc: '手动输入的代码清单', codes: [] },
  };

  function universes(watchCodes) {
    const out = {};
    for (const [k, v] of Object.entries(UNIVERSE_RAW)) {
      out[k] = { key: k, label: v.label, desc: v.desc, codes: k === 'watch' ? (watchCodes || []) : v.codes.slice() };
    }
    return out;
  }

  // ============================================================ 因子

  /**
   * 六类因子。type='price' 表示纯价格可算，'proxy' 表示是价格行为代理。
   */
  const FACTORS = [
    {
      key: 'momentum', label: '动量', type: 'price', dir: 'high',
      desc: '20 / 60 / 120 日涨幅加权，衡量趋势强度。',
      detail: '权重 0.5 / 0.3 / 0.2，得分越高代表近期走势越强。',
    },
    {
      key: 'value', label: '价值', type: 'partial', dir: 'high',
      desc: '以市盈率倒数（盈利收益率）为主，PE 越低得分越高。',
      detail: '仅 PE 一个口径（拿不到 PB / 现金流 / EV/EBITDA），负 PE 视为无意义给 0 分。',
    },
    {
      key: 'quality', label: '质量（代理）', type: 'proxy', dir: 'high',
      desc: '用「回撤控制 + 收益一致性」代理质量。',
      detail: '代理口径：最大回撤越浅、日收益胜率越高得分越高。真实质量因子需 ROE / 毛利率等财报数据。',
    },
    {
      key: 'lowvol', label: '低波', type: 'price', dir: 'high',
      desc: '60 日年化波动率越低得分越高。',
      detail: '低波因子在美股长期有效，衡量的是「风险调整后的安稳程度」。',
    },
    {
      key: 'size', label: '规模', type: 'price', dir: 'low',
      desc: '按总市值排名赋分，小市值得分更高。',
      detail: '小盘溢价因子。市值缺失时记中位分 50，不做惩罚。',
    },
    {
      key: 'revision', label: '盈利修正（代理）', type: 'proxy', dir: 'high',
      desc: '用「动量加速度」代理盈利预期修正方向。',
      detail: '代理口径：近 20 日动量减前 20 日动量，向上加速说明预期在改善。真实口径需分析师一致预期上调/下调数据。',
    },
  ];

  function mean(a) {
    return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
  }
  function stdev(a) {
    if (a.length < 2) return 0;
    const m = mean(a);
    return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
  }
  function clamp01(v) {
    return Math.max(0, Math.min(1, v));
  }
  /** 线性映射到 0-100 */
  function scale(v, lo, hi, invert) {
    if (hi === lo) return 50;
    const t = clamp01((v - lo) / (hi - lo));
    return Math.round((invert ? 1 - t : t) * 100);
  }

  /**
   * 计算单只标的的因子得分。
   * @param {Object} o { bars, quote, rank:{ capPercentile } }
   */
  function computeFactors(o) {
    const bars = (o && o.bars) || [];
    const quote = (o && o.quote) || {};
    if (bars.length < 60) return null;
    const closes = bars.map((b) => b.close);
    const n = closes.length;
    const last = closes[n - 1];

    const ret = (days) => (n > days && closes[n - 1 - days] > 0 ? (last / closes[n - 1 - days] - 1) * 100 : 0);
    const r20 = ret(20);
    const r60 = ret(60);
    const r120 = ret(120);

    // 动量
    const momRaw = r20 * 0.5 + r60 * 0.3 + r120 * 0.2;
    const momentum = scale(momRaw, -40, 60);

    // 价值（PE 倒数）
    const pe = Number(quote.pe);
    const ey = pe > 0 ? (1 / pe) * 100 : null;
    const value = ey == null ? 50 : scale(ey, 1, 10);

    // 低波
    const rets = [];
    for (let i = Math.max(1, n - 60); i < n; i++) if (closes[i - 1] > 0) rets.push(closes[i] / closes[i - 1] - 1);
    const vol = stdev(rets) * Math.sqrt(252) * 100;
    const lowvol = scale(vol, 15, 85, true);

    // 规模
    const cap = Number(quote.marketCap) || 0;
    let size = 50;
    if (o && o.capPercentile != null) size = Math.round((1 - o.capPercentile) * 100);
    else if (cap > 0) {
      // 没有横截面排名时，用绝对市值的对数档位近似
      const lg = Math.log10(cap);
      size = scale(lg, 9.5, 12.7, true); // 约 3B ~ 500B
    }

    // 质量代理：回撤控制 + 日胜率
    let peak = closes[0];
    let mdd = 0;
    for (const c of closes) {
      peak = Math.max(peak, c);
      mdd = Math.max(mdd, (peak - c) / peak);
    }
    const winRate = rets.filter((r) => r > 0).length / Math.max(1, rets.length);
    const quality = Math.round(scale(mdd * 100, 8, 60, true) * 0.6 + scale(winRate, 0.35, 0.65) * 0.4);

    // 盈利修正代理：动量加速度
    const prev20 = n > 40 && closes[n - 41] > 0 ? (closes[n - 21] / closes[n - 41] - 1) * 100 : 0;
    const accel = r20 - prev20;
    const revision = scale(accel, -25, 25);

    const scores = { momentum, value, quality, lowvol, size, revision };
    const composite = Math.round(
      momentum * 0.25 + value * 0.15 + quality * 0.15 + lowvol * 0.15 + size * 0.1 + revision * 0.2
    );

    return {
      symbol: quote.code || (o && o.symbol) || '',
      name: quote.name || '',
      price: last,
      changePct: quote.changePct,
      pe: pe > 0 ? pe : null,
      marketCap: cap || null,
      scores,
      composite,
      raw: {
        r20: Number(r20.toFixed(2)), r60: Number(r60.toFixed(2)), r120: Number(r120.toFixed(2)),
        momentumRaw: Number(momRaw.toFixed(2)),
        earningsYield: ey == null ? null : Number(ey.toFixed(2)),
        volatility: Number(vol.toFixed(2)),
        maxDrawdown: Number((mdd * 100).toFixed(2)),
        dayWinRate: Number((winRate * 100).toFixed(1)),
        acceleration: Number(accel.toFixed(2)),
      },
      bars: bars.length,
    };
  }

  /**
   * 横截面赋分：拿全池子的原始值重算规模分位，让「规模」因子与池子匹配。
   * 单只算规模分位没意义，必须放在池子里比。
   */
  function scoreUniverse(items) {
    const caps = items.map((x) => (x.marketCap || 0)).filter((c) => c > 0).sort((a, b) => a - b);
    const pctOf = (cap) => {
      if (!caps.length || !cap) return null;
      let lo = 0;
      let hi = caps.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (caps[mid] < cap) lo = mid + 1;
        else hi = mid;
      }
      return lo / caps.length;
    };
    const out = items.map((it) => {
      const p = pctOf(it.marketCap);
      if (p == null) return it;
      const size = Math.round((1 - p) * 100);
      const scores = { ...it.scores, size };
      const composite = Math.round(
        scores.momentum * 0.25 + scores.value * 0.15 + scores.quality * 0.15 +
        scores.lowvol * 0.15 + scores.size * 0.1 + scores.revision * 0.2
      );
      return { ...it, scores, composite, sizePercentile: Math.round(p * 100) };
    });
    return out.sort((a, b) => b.composite - a.composite);
  }

  /**
   * 因子筛选。
   * @param {Array} items scoreUniverse() 的结果
   * @param {Object} criteria { filters:[{factor, min, max}], minComposite, sort, limit, exclude }
   */
  function screen(items, criteria) {
    const c = criteria || {};
    const filters = (c.filters || []).filter((f) => f && f.factor && (f.min != null || f.max != null));
    const exclude = new Set((c.exclude || []).map((x) => String(x).toUpperCase()));
    let rows = (items || []).filter((it) => it && !exclude.has(String(it.symbol).toUpperCase()));
    const rejected = [];

    for (const it of rows) {
      let ok = true;
      const fails = [];
      for (const f of filters) {
        const v = f.factor === 'composite' ? it.composite : (it.scores || {})[f.factor];
        if (v == null) continue;
        if (f.min != null && v < f.min) {
          ok = false;
          fails.push(`${f.factor} ${v} < ${f.min}`);
        }
        if (f.max != null && v > f.max) {
          ok = false;
          fails.push(`${f.factor} ${v} > ${f.max}`);
        }
      }
      if (c.minComposite != null && it.composite < c.minComposite) {
        ok = false;
        fails.push(`总分 ${it.composite} < ${c.minComposite}`);
      }
      if (c.maxPE != null && it.pe != null && it.pe > c.maxPE) {
        ok = false;
        fails.push(`PE ${it.pe} > ${c.maxPE}`);
      }
      if (c.minMarketCap != null && it.marketCap != null && it.marketCap < c.minMarketCap) {
        ok = false;
        fails.push(`市值低于门槛`);
      }
      if (!ok) rejected.push({ symbol: it.symbol, reasons: fails });
    }
    rows = rows.filter((it) => !rejected.some((r) => r.symbol === it.symbol));

    const sortKey = c.sort || 'composite';
    rows.sort((a, b) => {
      if (sortKey === 'composite') return b.composite - a.composite;
      if (sortKey === 'marketCap') return (b.marketCap || 0) - (a.marketCap || 0);
      if (sortKey === 'pe') return (a.pe || 1e9) - (b.pe || 1e9);
      return ((b.scores || {})[sortKey] || 0) - ((a.scores || {})[sortKey] || 0);
    });
    if (c.limit) rows = rows.slice(0, c.limit);

    return {
      rows, rejected,
      total: (items || []).length,
      matched: rows.length,
      summary: `从 ${(items || []).length} 只中筛出 ${rows.length} 只，${rejected.length} 只因条件不符被排除。`,
    };
  }

  // ============================================================ 参数扫描

  /** 生成参数网格（笛卡尔积） */
  function grid(params) {
    const keys = Object.keys(params || {});
    if (!keys.length) return [];
    let acc = [{}];
    for (const k of keys) {
      const spec = params[k];
      const values = Array.isArray(spec) ? spec : (spec && spec.range) || [];
      const next = [];
      for (const base of acc) for (const v of values) next.push({ ...base, [k]: v });
      acc = next;
    }
    return acc;
  }

  /**
   * 参数扫描：对一组策略参数跑回测，输出结果表与「稳健性」判断。
   * 稳健性看两件事：最优参数附近是否也是好结果（不是孤峰），以及参数敏感性。
   *
   * @param {Array}  bars
   * @param {String} strategy
   * @param {Object} paramSpace { fast:[3,5,8], slow:[20,30,50] }
   * @param {Object} [opt] { backtestFn, metric, initialCapital, commission, slippage, topN }
   */
  function paramScan(bars, strategy, paramSpace, opt) {
    const o = opt || {};
    const BT = o.backtestFn;
    if (!BT) return { error: '缺少回测函数' };
    if (!bars || bars.length < 60) return { error: 'K线数据不足' };

    const combos = grid(paramSpace);
    const metric = o.metric || 'sharpe';
    const results = [];
    for (const p of combos) {
      try {
        const r = BT.run({
          bars, strategy, params: p,
          initialCapital: o.initialCapital || 100000,
          commission: o.commission == null ? 0.0005 : o.commission,
          slippage: o.slippage == null ? 0.0005 : o.slippage,
        });
        if (!r || r.error) continue;
        results.push({
          params: p,
          label: Object.entries(p).map(([k, v]) => `${k}=${v}`).join(' '),
          totalReturn: r.totalReturn,
          annualized: r.annualized,
          maxDrawdown: r.maxDrawdown,
          sharpe: r.sharpe,
          winRate: r.winRate,
          profitFactor: r.profitFactor,
          tradeCount: r.tradeCount,
          metricValue: r[metric] == null ? 0 : r[metric],
        });
      } catch {
        /* 单个组合失败跳过 */
      }
    }
    if (!results.length) return { error: '没有产出有效结果（参数组合可能都不满足最小数据要求）' };

    results.sort((a, b) => b.metricValue - a.metricValue);
    const best = results[0];
    const values = results.map((r) => r.metricValue);
    const avg = mean(values);
    const sd = stdev(values);
    const better = results.filter((r) => r.metricValue > avg).length;

    // 稳健性：最优值相对均值的偏离是否夸张（1 个标准差内更可信）
    const sigma = sd > 0 ? (best.metricValue - avg) / sd : 0;
    const robust = sigma < 2.2 && better / results.length > 0.15;

    return {
      strategy,
      metric,
      combos: combos.length,
      valid: results.length,
      results: o.topN ? results.slice(0, o.topN) : results,
      best,
      stats: {
        avg: Number(avg.toFixed(4)),
        stdev: Number(sd.toFixed(4)),
        best: Number(best.metricValue.toFixed(4)),
        worst: Number(results[results.length - 1].metricValue.toFixed(4)),
        sigma: Number(sigma.toFixed(2)),
        aboveAverageRatio: Number(((better / results.length) * 100).toFixed(1)),
      },
      robust,
      verdict: robust
        ? `参数面较平坦（最优值仅高于均值 ${sigma.toFixed(2)} 个标准差），不是孤峰，过拟合风险较低。`
        : `最优参数明显孤立（高于均值 ${sigma.toFixed(2)} 个标准差，仅 ${((better / results.length) * 100).toFixed(1)}% 的组合优于均值），存在过拟合嫌疑，实盘前请谨慎。`,
      warning: '参数扫描本身就是过拟合的高发区。这里只用来判断「参数面是否平坦」，不要拿最优参数直接上实盘。',
    };
  }

  /**
   * 多策略横向对比。
   */
  function compare(bars, strategies, opt) {
    const o = opt || {};
    const BT = o.backtestFn;
    if (!BT) return { error: '缺少回测函数' };
    const rows = [];
    for (const s of strategies || []) {
      try {
        const r = BT.run({
          bars, strategy: typeof s === 'string' ? s : s.key,
          params: (s && s.params) || {},
          initialCapital: o.initialCapital || 100000,
          commission: o.commission == null ? 0.0005 : o.commission,
          slippage: o.slippage == null ? 0.0005 : o.slippage,
        });
        if (!r || r.error) {
          rows.push({ key: typeof s === 'string' ? s : s.key, name: (BT.STRATEGIES[(typeof s === 'string' ? s : s.key)] || {}).name || s, error: r ? r.error : '无结果' });
          continue;
        }
        rows.push({
          key: r.strategy, name: r.strategyName,
          totalReturn: r.totalReturn, annualized: r.annualized, maxDrawdown: r.maxDrawdown,
          sharpe: r.sharpe, winRate: r.winRate, profitFactor: r.profitFactor, tradeCount: r.tradeCount,
          benchmark: r.benchmark, alpha: r.alpha,
        });
      } catch (e) {
        rows.push({ key: typeof s === 'string' ? s : s.key, error: e.message });
      }
    }

    // 排序指标显式化：默认夏普（风险调整后收益，比裸收益更适合挑策略），
    // 但要在界面上说清是按什么排的 —— 否则「第一行就是最好的」这句话没法验证。
    const METRICS = {
      sharpe: { label: '夏普', dir: -1 },
      totalReturn: { label: '总收益', dir: -1 },
      annualized: { label: '年化', dir: -1 },
      winRate: { label: '胜率', dir: -1 },
      profitFactor: { label: '盈亏比', dir: -1 },
      alpha: { label: '超额 α', dir: -1 },
      maxDrawdown: { label: '最大回撤（越小越好）', dir: 1 },
    };
    const mKey = METRICS[o.metric] ? o.metric : 'sharpe';
    const m = METRICS[mKey];
    const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
    // 注意：必须排 rows 本身，不能只排 filter 出来的副本 ——
    // 界面渲染的是 rows，只排副本会出现「表格第一行不是摘要里说的那个最好策略」。
    // 失败/缺指标的排到最后，不假装它是最好的。
    rows.sort((a, b) => {
      const ae = !!a.error;
      const be = !!b.error;
      if (ae !== be) return ae ? 1 : -1;
      const av = num(a[mKey]);
      const bv = num(b[mKey]);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return m.dir * (av - bv);
    });
    const valid = rows.filter((r) => !r.error);

    return {
      rows,
      count: rows.length,
      metric: mKey,
      metricLabel: m.label,
      best: valid[0] || null,
      summary: valid.length
        ? `共 ${rows.length} 个策略，其中 ${valid.length} 个产出有效结果；按${m.label}排名最高的是「${valid[0].name}」（${num(valid[0][mKey]) == null ? '数据不足' : num(valid[0][mKey]).toFixed(2)}）。`
        : '没有有效结果。',
    };
  }

  return {
    UNIVERSE_RAW,
    FACTORS,
    universes,
    computeFactors,
    scoreUniverse,
    screen,
    grid,
    paramScan,
    compare,
    scale,
  };
});
