/**
 * risk.js —— 风控引擎（个人自用版）
 *
 * 个人自用最容易翻车的地方不是策略不行，而是「手滑」和「策略失控」：
 * 一天亏掉计划外的钱、某只票越加越重、做空撞上挤空。
 * 这个模块把风控拆成三层，全部是硬约束，不靠自觉：
 *
 *   账户级  —— 单日最大亏损、最大回撤、总仓位/净仓位、杠杆与购买力、PDT 额度
 *   策略级  —— 单笔风险、单票上限、行业集中度、持仓数量、组合 Beta、单日 VaR
 *   做空    —— 借券费率、locate 可得性、空头利率、逼空风险
 *
 * 输出分三种强度：
 *   block  硬拦截（不允许下单 / 必须动作）
 *   warn   警告（可以下单，但要自己确认）
 *   pass   通过
 *
 * 纯函数，输入输出都不会自己动手改账户 —— 所有「自动动作」只给出建议，
 * 由模拟盘或实盘适配层去执行，避免风控层偷偷改状态导致对不上账。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Risk = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  /** 默认风控阈值（个人自用保守口径，可在设置里改） */
  const DEFAULT_LIMITS = {
    // 账户级
    maxDailyLossPct: 3, // 单日最大亏损（占日前净值）
    maxDrawdownPct: 15, // 从峰值算的最大回撤
    maxGrossExposurePct: 150, // 总仓位（多空绝对值之和 / 净值）
    maxNetExposurePct: 100, // 净仓位（多头 − 空头）
    minCashPct: 5, // 最低现金比例
    maxLeverage: 2, // 最大杠杆倍数
    // 策略级
    maxSinglePositionPct: 15, // 单票市值占净值上限
    maxSectorPct: 35, // 单行业市值占净值上限
    maxOpenPositions: 12, // 最多同时持有标的数
    maxSingleTradeRiskPct: 1, // 单笔最大风险（止损距离 × 仓位 / 净值）
    maxPortfolioBeta: 1.5, // 组合 Beta 上限
    maxDailyVaRPct: 4, // 单日 VaR(95%) 占净值上限
    // 做空
    maxShortExposurePct: 50,
    maxBorrowRatePct: 20, // 借券年费率上限，超过就不值得空
    minShortInterestPct: 0.5, // 空头利率过低说明没什么券可借
    squeezeRiskSiPct: 20, // 空头利率超过此值视为逼空高风险
    // 纪律项
    earningsBlackoutDays: 3, // 财报前后 N 天禁止开新仓
    blacklist: [], // 黑名单代码
    restrictedSectors: [], // 禁止开仓的行业
    maxDayTradesPer5: 3, // PDT 窗口内允许的日内交易次数
  };

  /** 行业大类：用于集中度粗分类（拿不到申万/GICS 时的兜底映射） */
  const SECTOR_HINT = {
    NVDA: '半导体', AMD: '半导体', INTC: '半导体', MU: '半导体', AMAT: '半导体设备', ASML: '半导体设备', TSM: '半导体',
    AAPL: '消费电子', MSFT: '软件', GOOGL: '互联网', GOOG: '互联网', META: '互联网', AMZN: '互联网', NFLX: '互联网',
    CRM: '软件', ADBE: '软件', ORCL: '软件', NOW: '软件', PLTR: '软件', SNOW: '软件', DDOG: '软件',
    TSLA: '汽车', F: '汽车', GM: '汽车', RIVN: '汽车', LCID: '汽车',
    JPM: '金融', BAC: '金融', GS: '金融', MS: '金融', C: '金融', V: '金融', MA: '金融', BRK: '金融',
    XOM: '能源', CVX: '能源', COP: '能源', OXY: '能源',
    UNH: '医疗', JNJ: '医疗', PFE: '医疗', MRK: '医疗', LLY: '医疗', ABBV: '医疗',
    KO: '消费', PEP: '消费', PG: '消费', COST: '消费', WMT: '消费', MCD: '消费',
    IREN: '算力', CRWV: '算力', NBIS: '算力', OKLO: '核电', SMR: '核电', VST: '电力',
  };

  function num(v, d) {
    const n = Number(v);
    return isFinite(n) ? n : d == null ? 0 : d;
  }

  function pct(part, whole) {
    const w = num(whole);
    return w > 0 ? (num(part) / w) * 100 : 0;
  }

  function sectorOf(pos) {
    if (pos && pos.sector) return pos.sector;
    const sym = String((pos && pos.symbol) || '').toUpperCase();
    return SECTOR_HINT[sym] || '未分类';
  }

  /**
   * 组合 Beta：按市值加权。
   * 做空头寸贡献负 Beta。
   */
  function portfolioBeta(positions) {
    let num_ = 0;
    let den = 0;
    for (const p of positions || []) {
      const mv = Math.abs(num(p.shares) * num(p.price));
      const sign = p.side === 'short' ? -1 : 1;
      const b = p.beta == null ? 1 : num(p.beta, 1);
      num_ += sign * mv * b;
      den += mv;
    }
    return den > 0 ? num_ / den : 0;
  }

  /**
   * 组合单日 VaR(95%)。
   * 用行业里常用的相关系数捷径：
   *   σ_p² = ρ(Σ wᵢσᵢ)² + (1−ρ)Σ(wᵢσᵢ)²
   * 相当于假设所有标的平均相关 ρ、各自残差独立 —— 比「直接加总」合理得多，
   * 又不需要估整张协方差矩阵（个人自用拿不到可靠的多资产协方差）。
   */
  function portfolioVaR(positions, equity, opt) {
    const o = opt || {};
    const rho = o.corr == null ? 0.4 : o.corr;
    const z = o.z == null ? 1.645 : o.z; // 95% 单尾
    const list = (positions || []).map((p) => {
      const mv = Math.abs(num(p.shares) * num(p.price));
      const w = equity > 0 ? mv / equity : 0;
      const vol = p.vol == null ? 0.35 : num(p.vol, 0.35); // 年化波动率，缺省 35%
      const sign = p.side === 'short' ? -1 : 1;
      return { symbol: p.symbol, mv, w, vol, sign, ws: w * vol * sign };
    });
    if (!list.length || !(equity > 0)) {
      return { varPct: 0, varAmount: 0, components: [], rho, z, note: '无持仓，VaR 为 0。' };
    }
    const sum = list.reduce((s, x) => s + x.ws, 0);
    const sq = list.reduce((s, x) => s + x.ws * x.ws, 0);
    const varDaily = Math.sqrt(Math.max(0, rho * sum * sum + (1 - rho) * sq)) / Math.sqrt(252);
    const pctV = z * varDaily * 100;
    return {
      varPct: pctV,
      varAmount: (pctV / 100) * equity,
      components: list.map((x) => ({ symbol: x.symbol, weight: x.w * 100, vol: x.vol * 100, contribution: pct((x.ws, sum || 1)) })),
      rho,
      z,
      note: `按平均相关系数 ${rho}、95% 单尾估算：单日有 95% 把握亏损不超过净值的 ${pctV.toFixed(2)}%（约 $${((pctV / 100) * equity).toFixed(0)}）。`,
    };
  }

  /** 账户敞口快照 */
  function exposure(account, positions) {
    const equity = num(account.equity);
    let long = 0;
    let short = 0;
    for (const p of positions || []) {
      const mv = Math.abs(num(p.shares) * num(p.price));
      if (p.side === 'short') short += mv;
      else long += mv;
    }
    const gross = long + short;
    const net = long - short;
    return {
      equity,
      cash: num(account.cash),
      longMV: long,
      shortMV: short,
      grossMV: gross,
      netMV: net,
      grossPct: pct(gross, equity),
      netPct: pct(net, equity),
      longPct: pct(long, equity),
      shortPct: pct(short, equity),
      cashPct: pct(num(account.cash), equity),
      leverage: equity > 0 ? gross / equity : 0,
      positionsCount: (positions || []).filter((p) => Math.abs(num(p.shares)) > 0).length,
    };
  }

  /** 行业集中度 */
  function sectorExposure(account, positions) {
    const equity = num(account.equity);
    const map = new Map();
    for (const p of positions || []) {
      const s = sectorOf(p);
      const mv = Math.abs(num(p.shares) * num(p.price));
      const cur = map.get(s) || { sector: s, mv: 0, symbols: [] };
      cur.mv += mv;
      if (!cur.symbols.includes(p.symbol)) cur.symbols.push(p.symbol);
      map.set(s, cur);
    }
    return [...map.values()]
      .map((x) => ({ ...x, pct: pct(x.mv, equity) }))
      .sort((a, b) => b.mv - a.mv);
  }

  /** 单票集中度 */
  function positionExposure(account, positions) {
    const equity = num(account.equity);
    return (positions || [])
      .filter((p) => Math.abs(num(p.shares)) > 0)
      .map((p) => {
        const mv = Math.abs(num(p.shares) * num(p.price));
        const cost = Math.abs(num(p.shares) * num(p.avgPrice, num(p.price)));
        const pnl = p.side === 'short' ? cost - mv : mv - cost;
        return {
          symbol: p.symbol,
          sector: sectorOf(p),
          side: p.side || 'long',
          shares: num(p.shares),
          price: num(p.price),
          mv,
          pct: pct(mv, equity),
          cost,
          pnl,
          pnlPct: cost > 0 ? (pnl / cost) * 100 : 0,
          daysHeld: num(p.daysHeld),
          borrowRate: num(p.borrowRate),
          shortInterestPct: num(p.shortInterestPct),
        };
      })
      .sort((a, b) => b.mv - a.mv);
}

  /**
   * 做空风险检查。
   * 个人自用做空最容易忽略三件事：券从哪借（locate）、借券费多少、会不会被逼空。
   */
  function shortCheck(pos, opt) {
    const L = { ...DEFAULT_LIMITS, ...(opt && opt.limits) };
    const issues = [];
    const br = num(pos.borrowRate);
    const si = num(pos.shortInterestPct);
    const daysToCover = num(pos.daysToCover);

    if (pos.locate === false) {
      issues.push({ level: 'block', title: '无券可借（locate 失败）', detail: `${pos.symbol} 当前没有可借券源，无法建立或维持空头。` });
    }
    if (br > L.maxBorrowRatePct) {
      issues.push({
        level: 'block',
        title: '借券费过高',
        detail: `${pos.symbol} 年化借券费 ${br}%，超过上限 ${L.maxBorrowRatePct}%。持有成本会持续侵蚀收益，建议平掉。`,
      });
    } else if (br > L.maxBorrowRatePct * 0.5) {
      issues.push({
        level: 'warn',
        title: '借券费偏高',
        detail: `${pos.symbol} 年化借券费 ${br}%，接近上限。按当前费率持有 30 天约消耗市值的 ${((br / 100 / 365) * 30 * 100).toFixed(2)}%。`,
      });
    }
    if (si >= L.squeezeRiskSiPct) {
      issues.push({
        level: 'warn',
        title: '逼空风险高',
        detail: `${pos.symbol} 空头利率 ${si}%（≥${L.squeezeRiskSiPct}%），流通盘被高度做空，一旦利好容易出现轧空式暴涨。`,
      });
    }
    if (daysToCover > 5) {
      issues.push({
        level: 'warn',
        title: '回补天数长',
        detail: `${pos.symbol} 按当前成交量需要 ${daysToCover} 天才能回补全部空头，流动性不足时平仓冲击会很大。`,
      });
    }
    if (si > 0 && si < L.minShortInterestPct) {
      issues.push({
        level: 'warn',
        title: '可借券源紧张',
        detail: `${pos.symbol} 空头利率仅 ${si}%，券源池很浅，可能出现临时召回（buy-in）被迫平仓。`,
      });
    }
    if (!issues.length) {
      issues.push({ level: 'pass', title: '做空条件正常', detail: `${pos.symbol} 借券费 ${br}%、空头利率 ${si}%，未触及风控阈值。` });
    }
    return {
      symbol: pos.symbol,
      borrowRate: br,
      shortInterestPct: si,
      daysToCover,
      issues,
      level: issues.some((i) => i.level === 'block') ? 'block' : issues.some((i) => i.level === 'warn') ? 'warn' : 'pass',
      // 借券成本：按持有天数折算
      estCostPer30d: (num(pos.shares) * num(pos.price) * br) / 100 / 365 * 30,
    };
  }

  /**
   * 账户级评估：单日亏损、回撤、敞口、杠杆、PDT。
   * @param {Object} o { account, positions, equityHistory, dayTrades, limits, now }
   */
  function accountCheck(o) {
    const L = { ...DEFAULT_LIMITS, ...(o.limits || {}) };
    const account = o.account || {};
    const positions = o.positions || [];
    const equity = num(account.equity);
    const exp = exposure(account, positions);
    const checks = [];

    // 1) 单日亏损
    const dayStart = num(account.dayStartEquity, equity);
    const dayPnl = equity - dayStart;
    const dayPnlPct = pct(dayPnl, dayStart);
    const dailyLossHit = dayPnlPct <= -L.maxDailyLossPct;
    checks.push({
      key: 'dailyLoss',
      label: '单日最大亏损',
      limit: -L.maxDailyLossPct,
      value: dayPnlPct,
      passed: !dailyLossHit,
      level: dailyLossHit ? 'block' : dayPnlPct <= -L.maxDailyLossPct * 0.7 ? 'warn' : 'pass',
      detail: `今日 ${dayPnl >= 0 ? '盈利' : '亏损'} $${Math.abs(dayPnl).toFixed(2)}（${dayPnlPct.toFixed(2)}%），阈值 ${-L.maxDailyLossPct}%。`,
    });

    // 2) 最大回撤（优先用净值序列，否则用账户字段）
    let peak = num(account.peakEquity, 0);
    const hist = o.equityHistory || [];
    if (hist.length) peak = Math.max(peak, ...hist.map((h) => num(h.value)));
    if (peak <= 0) peak = equity;
    const ddPct = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
    const ddHit = ddPct >= L.maxDrawdownPct;
    checks.push({
      key: 'drawdown',
      label: '最大回撤',
      limit: L.maxDrawdownPct,
      value: ddPct,
      passed: !ddHit,
      level: ddHit ? 'block' : ddPct >= L.maxDrawdownPct * 0.7 ? 'warn' : 'pass',
      detail: `距峰值回撤 ${ddPct.toFixed(2)}%（峰值 $${peak.toFixed(2)}），阈值 ${L.maxDrawdownPct}%。`,
    });

    // 3) 总仓位
    const grossHit = exp.grossPct > L.maxGrossExposurePct;
    checks.push({
      key: 'gross',
      label: '总仓位上限',
      limit: L.maxGrossExposurePct,
      value: exp.grossPct,
      passed: !grossHit,
      level: grossHit ? 'block' : exp.grossPct > L.maxGrossExposurePct * 0.85 ? 'warn' : 'pass',
      detail: `多空合计敞口 $${exp.grossMV.toFixed(0)}，占净值 ${exp.grossPct.toFixed(1)}%（多头 ${exp.longPct.toFixed(1)}% / 空头 ${exp.shortPct.toFixed(1)}%），阈值 ${L.maxGrossExposurePct}%。`,
    });

    // 4) 净仓位
    const netHit = Math.abs(exp.netPct) > L.maxNetExposurePct;
    checks.push({
      key: 'net',
      label: '净仓位上限',
      limit: L.maxNetExposurePct,
      value: exp.netPct,
      passed: !netHit,
      level: netHit ? 'block' : Math.abs(exp.netPct) > L.maxNetExposurePct * 0.9 ? 'warn' : 'pass',
      detail: `净敞口 ${exp.netPct.toFixed(1)}%，阈值 ±${L.maxNetExposurePct}%。`,
    });

    // 5) 杠杆
    const levHit = exp.leverage > L.maxLeverage;
    checks.push({
      key: 'leverage',
      label: '杠杆倍数',
      limit: L.maxLeverage,
      value: exp.leverage,
      passed: !levHit,
      level: levHit ? 'block' : exp.leverage > L.maxLeverage * 0.8 ? 'warn' : 'pass',
      detail: `总敞口 / 净值 = ${exp.leverage.toFixed(2)} 倍，阈值 ${L.maxLeverage} 倍。购买力 $${num(account.buyingPower).toFixed(0)}。`,
    });

    // 6) 最低现金
    const cashHit = exp.cashPct < L.minCashPct;
    checks.push({
      key: 'cash',
      label: '最低现金比例',
      limit: L.minCashPct,
      value: exp.cashPct,
      passed: !cashHit,
      level: cashHit ? 'warn' : 'pass',
      detail: `现金 $${exp.cash.toFixed(0)}，占净值 ${exp.cashPct.toFixed(1)}%，建议不低于 ${L.minCashPct}%。`,
    });

    // 7) 空头敞口
    const shortHit = exp.shortPct > L.maxShortExposurePct;
    checks.push({
      key: 'shortExposure',
      label: '空头敞口上限',
      limit: L.maxShortExposurePct,
      value: exp.shortPct,
      passed: !shortHit,
      level: shortHit ? 'block' : 'pass',
      detail: `空头市值 $${exp.shortMV.toFixed(0)}，占净值 ${exp.shortPct.toFixed(1)}%，阈值 ${L.maxShortExposurePct}%。`,
    });

    // 8) 持仓数量
    const cntHit = exp.positionsCount > L.maxOpenPositions;
    checks.push({
      key: 'positions',
      label: '持仓数量上限',
      limit: L.maxOpenPositions,
      value: exp.positionsCount,
      passed: !cntHit,
      level: cntHit ? 'warn' : 'pass',
      detail: `当前持有 ${exp.positionsCount} 只，上限 ${L.maxOpenPositions} 只（标的越多越难跟踪）。`,
    });

    return { checks, exposure: exp, peakEquity: peak, dayPnl, dayPnlPct, drawdownPct: ddPct };
  }

  /**
   * 策略级评估：单票、行业、Beta、VaR。
   */
  function strategyCheck(o) {
    const L = { ...DEFAULT_LIMITS, ...(o.limits || {}) };
    const account = o.account || {};
    const positions = o.positions || [];
    const equity = num(account.equity);

    const posExp = positionExposure(account, positions);
    const secExp = sectorExposure(account, positions);
    const beta = portfolioBeta(positions);
    const varP = portfolioVaR(positions, equity, o);

    const checks = [];

    // 单票上限
    const overPos = posExp.filter((p) => p.pct > L.maxSinglePositionPct);
    checks.push({
      key: 'singlePosition',
      label: '单票集中度',
      limit: L.maxSinglePositionPct,
      value: posExp[0] ? posExp[0].pct : 0,
      passed: overPos.length === 0,
      level: overPos.length ? 'block' : posExp[0] && posExp[0].pct > L.maxSinglePositionPct * 0.8 ? 'warn' : 'pass',
      detail: posExp.length
        ? `最大单票 ${posExp[0].symbol} 占净值 ${posExp[0].pct.toFixed(1)}%，上限 ${L.maxSinglePositionPct}%。` + (overPos.length ? ` 超限：${overPos.map((p) => p.symbol).join('、')}。` : '')
        : '无持仓。',
      offenders: overPos,
    });

    // 行业集中度
    const overSec = secExp.filter((s) => s.pct > L.maxSectorPct);
    checks.push({
      key: 'sector',
      label: '行业集中度',
      limit: L.maxSectorPct,
      value: secExp[0] ? secExp[0].pct : 0,
      passed: overSec.length === 0,
      level: overSec.length ? 'warn' : 'pass',
      detail: secExp.length
        ? `最大行业「${secExp[0].sector}」占净值 ${secExp[0].pct.toFixed(1)}%（${secExp[0].symbols.join('、')}），上限 ${L.maxSectorPct}%。`
        : '无持仓。',
      offenders: overSec,
    });

    // 组合 Beta
    const betaHit = Math.abs(beta) > L.maxPortfolioBeta;
    checks.push({
      key: 'beta',
      label: '组合 Beta',
      limit: L.maxPortfolioBeta,
      value: beta,
      passed: !betaHit,
      level: betaHit ? 'warn' : 'pass',
      detail: `按市值加权的组合 Beta = ${beta.toFixed(2)}，阈值 ±${L.maxPortfolioBeta}。${beta > 1 ? '高于市场波动，下跌时放大亏损。' : beta < 0.5 ? '接近市场中立。' : ''}`,
    });

    // 单日 VaR
    const varHit = varP.varPct > L.maxDailyVaRPct;
    checks.push({
      key: 'var',
      label: '单日 VaR(95%)',
      limit: L.maxDailyVaRPct,
      value: varP.varPct,
      passed: !varHit,
      level: varHit ? 'warn' : 'pass',
      detail: varP.note,
    });

    return { checks, positions: posExp, sectors: secExp, beta, var: varP };
  }

  /**
   * 下单前预检 —— 这是风控真正拦得住「手滑」的地方。
   * @param {Object} o
   * @param {Object} o.order   { symbol, side:'buy'|'sell'|'short'|'cover', shares, price, type, sector, stopPrice }
   * @param {Object} o.account { equity, cash, buyingPower, dayStartEquity, peakEquity }
   * @param {Array}  o.positions
   * @param {Array}  [o.dayTrades]
   * @param {Object} [o.limits]
   * @param {Object} [o.market]   { price, earningsDate, halted, ssr, luld, avgVolume }
   * @param {Object} [o.state]    { tradingHalted, noNewPositions }
   */
  function preTrade(o) {
    const L = { ...DEFAULT_LIMITS, ...(o.limits || {}) };
    const order = o.order || {};
    const account = o.account || {};
    const positions = o.positions || [];
    const market = o.market || {};
    const state = o.state || {};
    const symbol = String(order.symbol || '').toUpperCase();
    const side = order.side || 'buy';
    const shares = Math.abs(num(order.shares));
    const price = num(order.price, num(market.price));
    const amount = shares * price;
    const equity = num(account.equity);

    const blocks = [];
    const warns = [];
    const passes = [];
    const add = (level, title, detail) => {
      const item = { level, title, detail, symbol };
      if (level === 'block') blocks.push(item);
      else if (level === 'warn') warns.push(item);
      else passes.push(item);
    };

    if (!symbol) add('block', '缺少标的代码', '无法校验，请先选择标的。');
    if (shares <= 0) add('block', '数量为 0', '下单股数必须大于 0。');
    if (!(price > 0)) add('block', '价格无效', '缺少有效价格，无法计算敞口与风险。');

    // 1) 停机 / 禁止开新仓
    const isOpening = side === 'buy' || side === 'short';
    if (state.tradingHalted && isOpening) {
      add('block', '风控停机中', '账户已触发风控停机，禁止开新仓。需要先人工确认解除。');
    } else if (state.noNewPositions && isOpening) {
      add('block', '已禁止开新仓', '当前处于「只减不增」状态，只能平仓或减仓。');
    }

    // 2) 黑名单与受限行业
    if (isOpening && (L.blacklist || []).map((x) => String(x).toUpperCase()).includes(symbol)) {
      add('block', '标的是黑名单', `${symbol} 在风控黑名单里，禁止开新仓。`);
    }
    const sector = order.sector || market.sector || SECTOR_HINT[symbol] || '未分类';
    if (isOpening && (L.restrictedSectors || []).includes(sector)) {
      add('block', '行业被禁止', `${sector} 在受限行业清单里，禁止开仓。`);
    }

    // 3) 停牌 / 熔断
    if (market.halted) add('block', '标的停牌', `${symbol} 当前处于 LULD 或交易所停牌状态，无法成交。`);

    // 4) PDT 额度
    if (isOpening && (o.dayTrades || []).length) {
      const win = (o.dayTrades || []).length;
      if (equity < 25000 && win >= L.maxDayTradesPer5) {
        add('warn', 'PDT 额度将耗尽', `账户净值 $${equity.toFixed(0)} < $25,000，近 5 个交易日已用满 ${win} 次日内交易额度，再开平仓一次会被冻结 90 天。`);
      }
    }

    // 5) 资金与购买力
    if (isOpening) {
      const need = amount;
      if (need > num(account.buyingPower)) {
        add('block', '购买力不足', `需要 $${need.toFixed(2)}，可用购买力 $${num(account.buyingPower).toFixed(2)}，缺口 $${(need - num(account.buyingPower)).toFixed(2)}。`);
      } else if (need > num(account.buyingPower) * 0.9) {
        add('warn', '购买力接近用尽', `本单将占用可用购买力的 ${pct(need, account.buyingPower).toFixed(1)}%。`);
      }
      const cashAfter = num(account.cash) - (side === 'buy' ? need : 0);
      const cashPctAfter = pct(cashAfter, equity);
      if (cashPctAfter < L.minCashPct) {
        add('warn', '现金比例将跌破下限', `成交后现金 $${cashAfter.toFixed(0)}（${cashPctAfter.toFixed(1)}%），低于建议下限 ${L.minCashPct}%。`);
      }
    }

    // 6) 单票集中度（含本次下单后）
    const before = positions.filter((p) => String(p.symbol).toUpperCase() === symbol);
    const beforeMV = before.reduce((s, p) => s + Math.abs(num(p.shares) * num(p.price)), 0) * (before[0] && before[0].side === 'short' ? 1 : 1);
    let afterMV = beforeMV;
    if (isOpening) afterMV = beforeMV + amount;
    else if (side === 'sell' || side === 'cover') afterMV = Math.max(0, beforeMV - amount);
    const afterPct = pct(afterMV, equity);
    if (isOpening && afterPct > L.maxSinglePositionPct) {
      add('block', '超单票上限', `成交后 ${symbol} 占净值 ${afterPct.toFixed(1)}%，超过上限 ${L.maxSinglePositionPct}%。建议最多买 ${Math.max(0, Math.floor(((L.maxSinglePositionPct / 100) * equity - beforeMV) / price))} 股。`);
    } else if (isOpening && afterPct > L.maxSinglePositionPct * 0.8) {
      add('warn', '接近单票上限', `成交后 ${symbol} 占净值 ${afterPct.toFixed(1)}%，接近上限 ${L.maxSinglePositionPct}%。`);
    }

    // 7) 总仓位与杠杆（含本次下单后）
    const exp = exposure(account, positions);
    const grossAfter = exp.grossMV + (isOpening ? amount : 0);
    const grossAfterPct = pct(grossAfter, equity);
    if (isOpening && grossAfterPct > L.maxGrossExposurePct) {
      add('block', '超总仓位上限', `成交后总敞口占净值 ${grossAfterPct.toFixed(1)}%，超过上限 ${L.maxGrossExposurePct}%。`);
    } else if (isOpening && grossAfterPct > L.maxGrossExposurePct * 0.9) {
      add('warn', '接近总仓位上限', `成交后总敞口占净值 ${grossAfterPct.toFixed(1)}%。`);
    }
    if (isOpening && grossAfter / Math.max(equity, 1) > L.maxLeverage) {
      add('block', '超杠杆上限', `成交后杠杆 ${(grossAfter / Math.max(equity, 1)).toFixed(2)} 倍，超过上限 ${L.maxLeverage} 倍。`);
    }

    // 8) 单笔风险（止损距离 × 仓位 / 净值）
    if (isOpening && num(order.stopPrice) > 0) {
      const stop = num(order.stopPrice);
      const riskPerShare = side === 'short' ? stop - price : price - stop;
      if (riskPerShare <= 0) {
        add('warn', '止损方向不对', side === 'short' ? `做空止损价应高于入场价（当前止损 ${stop} ≤ 现价 ${price}）。` : `做多止损价应低于入场价（当前止损 ${stop} ≥ 现价 ${price}）。`);
      } else {
        const riskAmount = riskPerShare * shares;
        const riskPct = pct(riskAmount, equity);
        if (riskPct > L.maxSingleTradeRiskPct) {
          const allow = Math.max(0, Math.floor(((L.maxSingleTradeRiskPct / 100) * equity) / riskPerShare));
          add('block', '单笔风险超限', `按止损 $${stop} 计算，本单风险 $${riskAmount.toFixed(2)}（净值的 ${riskPct.toFixed(2)}%），超过上限 ${L.maxSingleTradeRiskPct}%。建议最多 ${allow} 股。`);
        } else {
          add('pass', '止损已设，单笔风险合规', `止损 $${stop}、最大亏损 $${riskAmount.toFixed(2)}，占净值 ${riskPct.toFixed(2)}%，在 ${L.maxSingleTradeRiskPct}% 以内。`);
        }
      }
    } else if (isOpening) {
      add('warn', '未设止损', '本单没有止损价，无法计算单笔风险。建议先确定止损位再下单。');
    }

    // 9) 做空专项
    if (side === 'short') {
      const sc = shortCheck({ ...order, sector }, o);
      for (const it of sc.issues) add(it.level === 'pass' ? 'pass' : it.level, it.title, it.detail);
    }

    // 10) 财报窗口
    if (isOpening && market.earningsDate) {
      const gap = Math.abs(Math.round((new Date(market.earningsDate) - new Date()) / 86400000));
      if (gap <= L.earningsBlackoutDays) {
        add('warn', '临近财报', `${symbol} 距财报日还有 ${gap} 天（黑窗 ${L.earningsBlackoutDays} 天）。财报后跳空常直接穿过止损位，实际亏损可能大于计划。`);
      }
    }

    // 11) 流动性
    if (market.avgVolume && market.avgVolume > 0) {
      const shareOfVolume = shares / market.avgVolume;
      if (shareOfVolume > 0.01) {
        add('warn', '冲击成本偏高', `本单 ${shares} 股约为日均成交量的 ${(shareOfVolume * 100).toFixed(2)}%，超过 1% 会明显推高滑点。建议拆单或改用 TWAP/VWAP。`);
      }
    }

    // 12) SSR / LULD 提示
    if (side === 'short' && market.ssr && market.ssr.active) {
      add('warn', 'SSR 生效', `${market.ssr.note}做空需以高于全国最优买价的价格挂单。`);
    }
    if (market.luld && market.luld.upper) {
      const far = price > market.luld.upper || price < market.luld.lower;
      if (far) add('warn', '挂单价超出价格带', `现价 ${price} 已超出 LULD 价格带 ${market.luld.lower} – ${market.luld.upper}，可能无法成交或直接触发熔断。`);
    }

    if (!blocks.length && !warns.length) {
      add('pass', '全部检查通过', `本单 $${amount.toFixed(2)}，占净值 ${pct(amount, equity).toFixed(1)}%，未见风控异常。`);
    }

    return {
      symbol,
      side,
      shares,
      price,
      amount,
      passed: blocks.length === 0,
      level: blocks.length ? 'block' : warns.length ? 'warn' : 'pass',
      blocks,
      warns,
      passes,
      checkedAt: new Date().toISOString(),
      summary: blocks.length
        ? `拦截 ${blocks.length} 项、警告 ${warns.length} 项 —— 本单不可执行。`
        : warns.length
        ? `通过，但有 ${warns.length} 项警告需要注意。`
        : '全部检查通过，可以下单。',
    };
  }

  /**
   * 综合评估：账户 + 策略 + 做空 + 自动动作建议。
   */
  function evaluate(o) {
    const L = { ...DEFAULT_LIMITS, ...(o.limits || {}) };
    const positions = o.positions || [];
    const acc = accountCheck({ ...o, limits: L });
    const strat = strategyCheck({ ...o, limits: L });

    // 做空逐仓检查
    const shorts = positions.filter((p) => p.side === 'short');
    const shortIssues = shorts.map((p) => shortCheck(p, { limits: L }));

    // 汇总所有条目
    const all = [...acc.checks, ...strat.checks];
    const blocks = all.filter((c) => c.level === 'block');
    const warns = all.filter((c) => c.level === 'warn');

    // 自动动作建议
    const actions = [];
    const exp = acc.exposure;
    const addAction = (action, reason, urgency, target) => actions.push({ action, reason, urgency, target });

    const daily = all.find((c) => c.key === 'dailyLoss');
    if (daily && daily.level === 'block') {
      addAction('停机', `单日亏损 ${daily.value.toFixed(2)}% 已触阈值，立即停止开新仓。`, 'high');
      addAction('减仓', `将总敞口压到净值的 ${Math.round(L.maxGrossExposurePct * 0.6)}% 以内。`, 'high', `${exp.grossPct.toFixed(0)}% → ${Math.round(L.maxGrossExposurePct * 0.6)}%`);
    } else if (daily && daily.level === 'warn') {
      addAction('禁止开新仓', `单日亏损已达阈值的 ${((daily.value / -L.maxDailyLossPct) * 100).toFixed(0)}%，今天不要再加仓。`, 'medium');
    }

    const dd = all.find((c) => c.key === 'drawdown');
    if (dd && dd.level === 'block') {
      addAction('停机', `回撤 ${dd.value.toFixed(2)}% 已触及 ${L.maxDrawdownPct}% 上限，暂停策略并复盘。`, 'high');
      addAction('降杠杆', `把总仓位降到净值 ${Math.round(L.maxGrossExposurePct * 0.5)}% 以下再恢复。`, 'high');
    } else if (dd && dd.level === 'warn') {
      addAction('减仓', `回撤 ${dd.value.toFixed(2)}%，建议主动降低风险敞口。`, 'medium');
    }

    const sp = all.find((c) => c.key === 'singlePosition');
    if (sp && sp.offenders && sp.offenders.length) {
      for (const off of sp.offenders) {
        const targetMV = (L.maxSinglePositionPct / 100) * exp.equity;
        const cut = off.mv - targetMV;
        addAction('减仓', `${off.symbol} 占净值 ${off.pct.toFixed(1)}% 超上限，需减持约 $${cut.toFixed(0)}。`, 'medium', `${off.sector} · ${off.symbol}`);
      }
    }

    const sec = all.find((c) => c.key === 'sector');
    if (sec && sec.offenders && sec.offenders.length) {
      for (const off of sec.offenders) {
        addAction('减仓', `行业「${off.sector}」占净值 ${off.pct.toFixed(1)}% 超上限，建议减持 ${off.symbols.slice(0, 2).join('、')} 等。`, 'low', off.sector);
      }
    }

    const lev = all.find((c) => c.key === 'leverage');
    if (lev && lev.value > L.maxLeverage * 0.8) {
      addAction('降杠杆', `杠杆 ${lev.value.toFixed(2)} 倍，接近上限 ${L.maxLeverage} 倍。`, lev.level === 'block' ? 'high' : 'low');
    }

    for (const s of shortIssues) {
      for (const it of s.issues) {
        if (it.level === 'block') addAction('平仓', `做空 ${s.symbol}：${it.detail}`, 'high', s.symbol);
        else if (it.level === 'warn') addAction('关注', `做空 ${s.symbol}：${it.detail}`, 'low', s.symbol);
      }
    }

    const level = blocks.length ? 'danger' : warns.length ? 'warn' : 'ok';
    const score = Math.max(
      0,
      100 - blocks.reduce((s, c) => s + 25, 0) - warns.reduce((s, c) => s + 8, 0)
    );

    return {
      level,
      score,
      blocks,
      warns,
      checks: all,
      account: acc,
      strategy: strat,
      shorts: shortIssues,
      actions,
      exposure: exp,
      limits: L,
      headline:
        level === 'danger'
          ? `风控红灯：${blocks.length} 项硬约束被突破，需要立即处理。`
          : level === 'warn'
          ? `风控黄灯：${warns.length} 项接近阈值，注意仓位纪律。`
          : '风控绿灯：所有账户级与策略级约束都在阈值内。',
      evaluatedAt: new Date().toISOString(),
    };
  }

  return {
    DEFAULT_LIMITS,
    SECTOR_HINT,
    sectorOf,
    exposure,
    sectorExposure,
    positionExposure,
    portfolioBeta,
    portfolioVaR,
    shortCheck,
    accountCheck,
    strategyCheck,
    preTrade,
    evaluate,
  };
});
