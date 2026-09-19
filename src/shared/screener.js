/**
 * screener.js —— 股票池、因子库、预设策略与参数扫描
 *
 * 个人自用版的研究环节：先把池子框好，再按因子筛，最后做参数扫描确认
 * 「不是只有一组参数好看」。
 *
 * 关于因子的诚实说明（v1.1.0 更新）：
 *   直接可算的「真数据」因子：
 *     动量 / 趋势 / 低波 / 规模 / 突破 / 量能 / 弹性 / 压缩 / 流动性 / 相对强度 /
 *     短期异动 / 回撤健康度 / 均值回归
 *   只有单一口径的：
 *     价值 —— 只有 PE 可用（拿不到 PB / 现金流 / EV-EBITDA），口径偏窄。
 *   仍是价格行为代理的（**字段上明确标注 proxy，不冒充实盘因子**）：
 *     质量（用回撤控制 + 日胜率代理）、盈利修正（用动量加速度代理）
 *     真实口径需要 ROE / 毛利率 / 分析师一致预期，本地默认拿不到。
 *     ★ v1.1.0 起：若数据源可达 nasdaq 分析师接口，界面上会另外展示真实的
 *       共识目标价与评级分布（见 moonshot/insight），但那不参与本文件的因子分，
 *       避免两种口径混在一起算。
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
    nuclear: {
      label: '核电与铀',
      desc: 'AI 电力缺口的直接受益链条',
      codes: ['OKLO', 'SMR', 'CEG', 'VST', 'NRG', 'TLN', 'LEU', 'CCJ', 'UEC', 'UUUU', 'NNE', 'LTBR', 'BWXT', 'GEV', 'ETN', 'PWR'],
    },
    quantum: {
      label: '量子计算',
      desc: '高波动主题板块，题材驱动为主',
      codes: ['IONQ', 'RGTI', 'QBTS', 'QUBT', 'ARQQ', 'IBM', 'MSFT', 'GOOGL', 'NVDA', 'HON'],
    },
    biotech: {
      label: '生物科技',
      desc: '临床催化密集、单日波动大，高风险高弹性',
      codes: ['LLY', 'NVO', 'MRNA', 'REGN', 'VRTX', 'GILD', 'BIIB', 'AMGN', 'SRPT', 'NTLA', 'BEAM', 'CRSP', 'EDIT', 'VKTX', 'IOVA', 'SANA', 'RXRX', 'TEM', 'INSM', 'AXSM'],
    },
    fintech: {
      label: '金融科技',
      desc: '支付、券商、数字银行',
      codes: ['PYPL', 'SQ', 'COIN', 'HOOD', 'SOFI', 'AFRM', 'UPST', 'NU', 'MELI', 'FUTU', 'TIGR', 'V', 'MA', 'FI', 'TOST', 'BILL'],
    },
    crypto: {
      label: '加密相关',
      desc: '持币公司、矿企与交易所，与 BTC 高度联动',
      codes: ['MSTR', 'COIN', 'HOOD', 'MARA', 'RIOT', 'CLSK', 'HUT', 'BITF', 'CIFR', 'WULF', 'IREN', 'CORZ', 'GLXY', 'IBIT', 'BITO', 'BMNR', 'SBET'],
    },
    robotics: {
      label: '机器人与自动化',
      desc: '人形机器人、工业自动化与传感器',
      codes: ['TSLA', 'ISRG', 'SYM', 'PATH', 'AVAV', 'ZBRA', 'TER', 'ROK', 'ABB', 'EMR', 'ETN', 'NNDM', 'RR', 'PRCT', 'SERV'],
    },
    defense: {
      label: '国防与航天',
      desc: '军工、航天、卫星',
      codes: ['LMT', 'RTX', 'NOC', 'GD', 'BA', 'LHX', 'HWM', 'TDG', 'AXON', 'KTOS', 'RKLB', 'ASTS', 'LUNR', 'PL', 'ACHR', 'JOBY', 'SPCE', 'VSAT', 'IRDM'],
    },
    consumer: {
      label: '消费与零售',
      desc: '必需与可选消费',
      codes: ['WMT', 'COST', 'HD', 'LOW', 'TGT', 'TJX', 'NKE', 'LULU', 'SBUX', 'MCD', 'CMG', 'DPZ', 'YUM', 'PG', 'KO', 'PEP', 'MNST', 'CELH', 'EL', 'DIS'],
    },
    china: {
      label: '中概股',
      desc: '在美上市的中概',
      codes: ['BABA', 'PDD', 'JD', 'BIDU', 'NTES', 'TCOM', 'NIO', 'LI', 'XPEV', 'BEKE', 'BILI', 'TME', 'YMM', 'ZTO', 'FUTU', 'TIGR', 'IQ', 'VIPS', 'KC', 'MINIM'],
    },
    highbeta: {
      label: '高贝塔弹性池',
      desc: '历史波动大、容易出大幅行情的标的（暴涨与暴跌同源，仅适合小仓位）',
      codes: [
        'TSLA', 'PLTR', 'MSTR', 'COIN', 'HOOD', 'SOFI', 'AFRM', 'RBLX', 'U', 'SNAP',
        'CRWV', 'NBIS', 'IREN', 'APLD', 'WULF', 'CIFR', 'OKLO', 'SMR', 'IONQ', 'RGTI',
        'QBTS', 'MARA', 'RIOT', 'CLSK', 'HUT', 'SMCI', 'ARM', 'MRVL', 'AVGO', 'MU',
        'SHOP', 'DASH', 'ABNB', 'SE', 'GRAB', 'NU', 'TOST', 'SOUN', 'BBAI', 'AI',
      ],
    },
    smallcap: {
      label: '中小盘成长',
      desc: '中小市值成长股，弹性大但流动性需逐只核查',
      codes: [
        'SOUN', 'BBAI', 'AI', 'PLTR', 'IONQ', 'RGTI', 'QBTS', 'RKLB', 'ASTS', 'LUNR',
        'ACHR', 'JOBY', 'KTOS', 'TEM', 'RXRX', 'SANA', 'INSM', 'AXSM', 'VKTX', 'CRDO',
        'ALAB', 'MRAM', 'NVMI', 'CAMT', 'AEIS', 'POWL', 'AEHR', 'FORM', 'ONTO', 'UCTT',
        'TMDX', 'HIMS', 'OSCR', 'LMND', 'UPST', 'AFRM', 'TOST', 'BILL', 'RELY', 'PAGS',
      ],
    },
    dividend: {
      label: '高股息防御',
      desc: '现金流稳定、股息率较高的标的，用于降低组合波动',
      codes: ['KO', 'PEP', 'PG', 'JNJ', 'ABBV', 'MRK', 'PFE', 'T', 'VZ', 'MO', 'PM', 'XOM', 'CVX', 'IBM', 'MMM', 'CAT', 'UPS', 'O', 'VICI', 'SCHD'],
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

  /** 池子去重：多个池子叠加时用 */
  function mergeUniverses(keys, watchCodes) {
    const all = universes(watchCodes);
    const set = new Set();
    for (const k of keys || []) {
      const u = all[k];
      if (u) for (const c of u.codes) set.add(c);
    }
    return [...set];
  }

  // ============================================================ 因子

  /**
   * 因子库。type: 'price' 纯价格可算 | 'partial' 口径不全 | 'proxy' 价格行为代理
   * dir: 排序方向偏好（'high' 越高越好 / 'low' 越低越好）—— 仅用于界面默认排序提示。
   */
  const FACTORS = [
    // ---- 原有 6 个（保持键名不变，向后兼容） ----
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

    // ---- v1.1.0 新增 ----
    {
      key: 'trend', label: '趋势结构', type: 'price', dir: 'high',
      desc: '均线多头排列程度 + MACD 状态，衡量「顺风还是逆风」。',
      detail: '价格对 MA20/60/120 的相对位置、均线间距离、MACD 柱状值与方向，合成 0-100 分。与「动量」互补：动量看涨幅，趋势看结构。',
    },
    {
      key: 'breakout', label: '突破强度', type: 'price', dir: 'high',
      desc: '距 52 周高点的位置，越贴近高点得分越高。',
      detail: '新高附近上方无套牢盘，阻力最小；距高点越远得分越低。注意：这一项与「回撤健康度」是一体两面，不要同时当作独立优势看。',
    },
    {
      key: 'volumeSurge', label: '量能异动', type: 'price', dir: 'high',
      desc: '5 日均量 / 20 日均量，放量得分高。',
      detail: '量比在 1.0~2.5 间最理想；超过 4 倍属于分歧极大的爆量，会扣分而不是加分。另计入 20 日均量自身的趋势。',
    },
    {
      key: 'elasticity', label: '波动弹性', type: 'price', dir: 'high',
      desc: 'ATR% 与年化波动率的合成，衡量「动起来能有多大」。',
      detail: '弹性是暴涨的必要条件，但同样放大下跌。ATR% 低于 1.5% 基本不可能出现大幅单月行情；高于 15% 说明已被爆炒过。',
    },
    {
      key: 'compression', label: '波动压缩', type: 'price', dir: 'high',
      desc: '布林带宽度在近 120 日的分位，越窄得分越高（变盘前兆）。',
      detail: '波动率被压缩到低位，历史上常是大行情的前奏。★ 方向未知 —— 向上突破与向下破位概率接近，必须等确认。',
    },
    {
      key: 'reversal', label: '均值回归', type: 'price', dir: 'high',
      desc: 'RSI 位置：40-62 为健康强势区，超卖区得分回升。',
      detail: '避免追高同时捕捉超卖反弹的赔率。RSI > 78 会显著扣分。',
    },
    {
      key: 'runup', label: '短期异动', type: 'price', dir: 'high',
      desc: '近 5 日涨幅，衡量最近一周的资金态度。',
      detail: '与中期动量分开看：5 日强而 60 日弱 = 底部启动；5 日强而 20 日极强 = 加速末端（有风险）。',
    },
    {
      key: 'health', label: '回撤健康度', type: 'price', dir: 'high',
      desc: '距 52 周低点与高点的相对位置，衡量形态是否健康。',
      detail: '既惩罚深度回撤（远离高点），也惩罚贴着低点的弱势。理想的形态是「高位小幅整理」。',
    },
    {
      key: 'liquidity', label: '流动性', type: 'price', dir: 'high',
      desc: '近 20 日日均成交额（美元），越大越容易进出。',
      detail: '成交额低于 2000 万美元的标的，冲击成本会明显吃掉收益；低于 500 万美元基本不适合本工具的仓位模型。',
    },
    {
      key: 'relativeStrength', label: '相对强度', type: 'price', dir: 'high',
      desc: '近 20 日收益相对基准（默认标普 500）的超额。',
      detail: '需要传入基准收益才能计算；没有基准数据时记中位分 50，不做惩罚。',
    },
  ];

  const FACTOR_MAP = {};
  for (const f of FACTORS) FACTOR_MAP[f.key] = f;

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
   * @param {Object} o {
   *   bars, quote, capPercentile, symbol,
   *   benchmark:{ ret20, ret60 }  基准收益（可选，用于相对强度）
   *   ppy 每年K线根数（默认 252）
   * }
   */
  function computeFactors(o) {
    const opt = o || {};
    const bars = opt.bars || [];
    const quote = opt.quote || {};
    const ppy = opt.ppy || 252;
    if (bars.length < 60) return null;

    const closes = bars.map((b) => b.close);
    const highs = bars.map((b) => (b.high == null ? b.close : b.high));
    const lows = bars.map((b) => (b.low == null ? b.close : b.low));
    const volsArr = bars.map((b) => b.volume || 0);
    const n = closes.length - 1;
    const last = closes[n];

    const ret = (days) => (n > days && closes[n - 1 - days] > 0 ? (last / closes[n - 1 - days] - 1) * 100 : 0);
    const r5 = ret(5);
    const r20 = ret(20);
    const r60 = ret(60);
    const r120 = ret(120);

    // ---------------- 原有 6 因子
    const momRaw = r20 * 0.5 + r60 * 0.3 + r120 * 0.2;
    const momentum = scale(momRaw, -40, 60);

    const pe = Number(quote.pe);
    const ey = pe > 0 ? (1 / pe) * 100 : null;
    const value = ey == null ? (pe < 0 ? 0 : 50) : scale(ey, 1, 10);

    const rets = [];
    for (let i = Math.max(1, n - 59); i <= n; i++) if (closes[i - 1] > 0) rets.push(closes[i] / closes[i - 1] - 1);
    const vol = stdev(rets) * Math.sqrt(ppy) * 100;
    const lowvol = scale(vol, 15, 85, true);

    const cap = Number(quote.marketCap) || 0;
    let size = 50;
    if (opt.capPercentile != null) size = Math.round((1 - opt.capPercentile) * 100);
    else if (cap > 0) size = scale(Math.log10(cap), 9.5, 12.7, true);

    let peak = closes[0];
    let mdd = 0;
    for (const c of closes) {
      peak = Math.max(peak, c);
      mdd = Math.max(mdd, (peak - c) / peak);
    }
    const winRate = rets.filter((r) => r > 0).length / Math.max(1, rets.length);
    const quality = Math.round(scale(mdd * 100, 8, 60, true) * 0.6 + scale(winRate, 0.35, 0.65) * 0.4);

    const prev20Raw = n > 40 && closes[n - 41] > 0 ? (closes[n - 21] / closes[n - 41] - 1) * 100 : 0;
    const accel = r20 - prev20Raw;
    const revision = scale(accel, -25, 25);

    // ---------------- v1.1.0 新增因子
    // 趋势结构
    const ma20 = I.sma(closes, 20);
    const ma60 = I.sma(closes, 60);
    const ma120 = I.sma(closes, 120);
    const macd = I.macd(closes);
    let trendRaw = 0;
    if (ma20[n] && last > ma20[n]) trendRaw += 5;
    if (ma60[n] && last > ma60[n]) trendRaw += 6;
    if (ma120[n] && last > ma120[n]) trendRaw += 4;
    if (ma5(closes)[n] && ma20[n] && ma5(closes)[n] > ma20[n]) trendRaw += 4;
    if (ma20[n] && ma60[n] && ma20[n] > ma60[n]) trendRaw += 3;
    if (macd.hist[n] != null && macd.hist[n] > 0) trendRaw += 3;
    if (macd.hist[n] != null && macd.hist[n - 1] != null && macd.hist[n] > macd.hist[n - 1]) trendRaw += 2;
    const trend = Math.round((trendRaw / 27) * 100);

    // 突破强度 & 回撤健康度
    const hi52 = I.highest(highs, Math.min(ppy, closes.length)) || last;
    const lo52 = I.lowest(lows, Math.min(ppy, closes.length)) || last;
    const distHigh = hi52 ? ((last - hi52) / hi52) * 100 : null;
    const distLow = lo52 ? ((last - lo52) / lo52) * 100 : null;
    let breakout;
    if (distHigh == null) breakout = 50;
    else if (distHigh > -1) breakout = 100;
    else if (distHigh > -5) breakout = 88;
    else if (distHigh > -12) breakout = 72;
    else if (distHigh > -25) breakout = 52;
    else if (distHigh > -45) breakout = 32;
    else breakout = scale(distHigh, -80, -45) * 0.35;

    let health;
    if (distHigh == null || distLow == null) health = 50;
    else {
      // 区间位置 0（贴低点）~1（贴高点）
      const range = hi52 - lo52;
      const pos = range > 0 ? (last - lo52) / range : 0.5;
      // 理想：高位（pos 高）且回撤浅；贴着低点(pos<0.15)重罚
      health = Math.round(scale(pos, 0.05, 0.85) * 0.55 + scale(distHigh, -55, 0, false) * 0.45);
      if (pos < 0.12) health = Math.min(health, 22);
    }

    // 量能异动
    const vma5 = I.volMa(volsArr, 5);
    const vma20 = I.volMa(volsArr, 20);
    const volRatio = vma20[n] ? vma5[n] / vma20[n] : null;
    const volTrendRaw = vma20[n - 5] ? vma20[n] / vma20[n - 5] : null;
    let volumeSurge;
    if (volRatio == null) volumeSurge = 45;
    else {
      let a;
      if (volRatio <= 0.7) a = scale(volRatio, 0.2, 0.7) * 0.4;
      else if (volRatio <= 2.5) a = scale(volRatio, 1.0, 2.5) * 0.85 + 15;
      else a = Math.max(35, 100 - (volRatio - 2.5) * 11);
      const b = volTrendRaw == null ? 45 : scale(volTrendRaw, 0.7, 1.8);
      volumeSurge = Math.round(clamp01((a * 0.6 + b * 0.4) / 100) * 100);
    }

    // 波动弹性
    const atr = I.atr(highs, lows, closes, 14);
    const atrPct = atr[n] && last ? (atr[n] / last) * 100 : null;
    let elasticity;
    if (atrPct == null) elasticity = 40;
    else {
      const eA = atrPct <= 1.2 ? scale(atrPct, 0.3, 1.2) * 0.45
        : atrPct <= 12 ? scale(atrPct, 1.2, 9) * 0.95 + 5
        : Math.max(25, 100 - (atrPct - 12) * 6);
      const eV = vol <= 25 ? scale(vol, 8, 25) * 0.55
        : vol <= 85 ? scale(vol, 25, 75) * 0.95 + 5
        : Math.max(25, 100 - (vol - 85) * 1.6);
      elasticity = Math.round(clamp01((eA * 0.6 + eV * 0.4) / 100) * 100);
    }

    // 波动压缩（布林带宽分位）
    const boll = I.boll(closes, 20, 2);
    const widths = [];
    for (let i = 19; i <= n; i++) if (boll.upper[i] != null && boll.mid[i]) widths.push((boll.upper[i] - boll.lower[i]) / boll.mid[i]);
    const curW = widths.length ? widths[widths.length - 1] : null;
    const widthPct = curW != null && widths.length > 20 ? widths.filter((w) => w <= curW).length / widths.length : null;
    const compression = widthPct == null ? 45 : Math.round(clamp01(1 - widthPct) * 100);

    // 均值回归（RSI）
    const rsiArr = I.rsi(closes, 14);
    const rsi = rsiArr[n];
    let reversal = 50;
    if (rsi != null) {
      if (rsi >= 40 && rsi <= 62) reversal = 100;
      else if (rsi < 40) reversal = Math.round(scale(rsi, 15, 40) * 0.72);
      else reversal = Math.round(scale(rsi, 62, 88) * 0.8);
      if (rsi > 78) reversal = Math.max(0, reversal - 28);
      if (rsi < 25) reversal = Math.min(100, reversal + 14);
    }

    // 短期异动
    let runup;
    if (r5 > 25) runup = Math.max(25, 100 - (r5 - 25) * 2.2);      // 一周涨太多 → 加速末端
    else if (r5 >= 0) runup = Math.round(scale(r5, 0, 12) * 0.92 + 8);
    else runup = Math.round(scale(r5, -18, 0) * 0.7);

    // 流动性
    const amounts = [];
    for (let i = Math.max(0, n - 19); i <= n; i++) amounts.push(bars[i].amount || closes[i] * (volsArr[i] || 0));
    const avgAmount = amounts.length ? amounts.reduce((a, b) => a + b, 0) / amounts.length : 0;
    const liquidity = avgAmount <= 0 ? 30 : avgAmount < 1e7 ? scale(Math.log10(Math.max(1, avgAmount)), 5, 7) * 0.5
      : avgAmount < 1e9 ? scale(Math.log10(avgAmount), 7, 9) * 0.9 + 10
      : Math.min(100, scale(Math.log10(avgAmount), 9, 11) * 0.2 + 90);

    // 相对强度
    let relativeStrength = 50;
    if (opt.benchmark && opt.benchmark.ret20 != null) relativeStrength = Math.round(scale(r20 - opt.benchmark.ret20, -15, 25));
    if (opt.benchmark && opt.benchmark.ret60 != null) {
      relativeStrength = Math.round((relativeStrength + scale(r60 - opt.benchmark.ret60, -25, 40)) / 2);
    }

    const scores = {
      momentum, value, quality, lowvol, size, revision,
      trend, breakout, volumeSurge, elasticity, compression, reversal, runup, health, liquidity, relativeStrength,
    };
    const composite = compositeOf(scores);
    const compositeLegacy = Math.round(
      momentum * 0.25 + value * 0.15 + quality * 0.15 + lowvol * 0.15 + size * 0.1 + revision * 0.2
    );

    return {
      symbol: quote.code || opt.symbol || '',
      name: quote.name || '',
      price: last,
      changePct: quote.changePct,
      pe: pe > 0 ? pe : (pe < 0 ? pe : null),
      pb: Number(quote.pb) || null,
      marketCap: cap || null,
      floatCap: Number(quote.floatCap) || null,
      scores,
      composite,
      compositeLegacy,
      raw: {
        r5: Number(r5.toFixed(2)),
        r20: Number(r20.toFixed(2)), r60: Number(r60.toFixed(2)), r120: Number(r120.toFixed(2)),
        momentumRaw: Number(momRaw.toFixed(2)),
        earningsYield: ey == null ? null : Number(ey.toFixed(2)),
        volatility: Number(vol.toFixed(2)),
        maxDrawdown: Number((mdd * 100).toFixed(2)),
        dayWinRate: Number((winRate * 100).toFixed(1)),
        acceleration: Number(accel.toFixed(2)),
        atrPct: atrPct == null ? null : Number(atrPct.toFixed(2)),
        bollWidthPercentile: widthPct == null ? null : Number((widthPct * 100).toFixed(1)),
        volumeRatio: volRatio == null ? null : Number(volRatio.toFixed(2)),
        volumeTrend: volTrendRaw == null ? null : Number(volTrendRaw.toFixed(2)),
        rsi: rsi == null ? null : Number(rsi.toFixed(1)),
        distanceToHigh: distHigh == null ? null : Number(distHigh.toFixed(2)),
        distanceToLow: distLow == null ? null : Number(distLow.toFixed(2)),
        avgAmount,
        ma20: ma20[n] == null ? null : Number(ma20[n].toFixed(2)),
        ma60: ma60[n] == null ? null : Number(ma60[n].toFixed(2)),
        ma120: ma120[n] == null ? null : Number(ma120[n].toFixed(2)),
      },
      bars: bars.length,
    };
  }

  /** 5 日均线的小工具（避免在多处重复调用） */
  function ma5(closes) {
    return I.sma(closes, 5);
  }

  /**
   * 综合分权重（合计 1.00）。
   * v1.1.0 起把「趋势/突破/量能/弹性/压缩/流动性/相对强度」纳入，
   * 让综合分能反映「能不能动」而不只是「贵不贵」。
   */
  const COMPOSITE_WEIGHTS = {
    momentum: 0.11, trend: 0.10, revision: 0.08, relativeStrength: 0.07, runup: 0.04,
    value: 0.08, quality: 0.07, lowvol: 0.05, size: 0.04, liquidity: 0.06,
    breakout: 0.08, volumeSurge: 0.07, elasticity: 0.05, compression: 0.04,
    reversal: 0.04, health: 0.02,
  };

  function compositeOf(scores) {
    let sum = 0;
    let wsum = 0;
    for (const [k, w] of Object.entries(COMPOSITE_WEIGHTS)) {
      const v = (scores || {})[k];
      if (v == null) continue;
      sum += v * w;
      wsum += w;
    }
    return wsum > 0 ? Math.round(sum / wsum) : 0;
  }

  /**
   * 横截面赋分：拿全池子的原始值重算规模分位，让「规模」因子与池子匹配。
   * 单只算规模分位没意义，必须放在池子里比。
   */
  function scoreUniverse(items, opt) {
    const o = opt || {};
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
      return {
        ...it,
        scores,
        composite: compositeOf(scores),
        sizePercentile: Math.round(p * 100),
      };
    });
    const key = o.sort || 'composite';
    out.sort((a, b) => {
      if (key === 'composite') return b.composite - a.composite;
      return ((b.scores || {})[key] || 0) - ((a.scores || {})[key] || 0);
    });
    return out;
  }

  // ============================================================ 预设策略

  /**
   * 预设选股策略。
   * 每个策略 = 一个可解释的交易假设 + 一组因子门槛 + 建议池子。
   * filters 里的 min/max 都是「因子分」（0-100），不是原始值 —— 保持口径统一。
   */
  const PRESETS = [
    {
      key: 'momentumCore', label: '动量核心', universe: 'sp500',
      desc: '买强势的、不买便宜的：趋势与动量双高，配以量能确认。',
      rationale: '动量效应是美股最稳定的异象之一。要求趋势结构也在位，避免只靠一波反弹刷出来的「假动量」。',
      filters: [{ factor: 'momentum', min: 65 }, { factor: 'trend', min: 60 }, { factor: 'liquidity', min: 55 }],
      minComposite: 0, sort: 'composite', limit: 30,
      watchOut: '动量策略在趋势反转时会连续吃亏，务必配合止损纪律；风格切换期（成长→价值）表现最差。',
    },
    {
      key: 'breakout52w', label: '52 周突破', universe: 'nasdaq100',
      desc: '专挑贴着 52 周高点的强势股，等突破确认。',
      rationale: '新高附近没有套牢盘，上方阻力最小；同时处在「所有人都在赚钱」的状态，抛压最轻。',
      filters: [{ factor: 'breakout', min: 85 }, { factor: 'trend', min: 55 }, { factor: 'health', min: 60 }, { factor: 'liquidity', min: 50 }],
      sort: 'breakout', limit: 30,
      watchOut: '假突破是这类策略的主要亏损来源。要等收盘确认，不追盘中冲高；新高失守要快速认错。',
    },
    {
      key: 'volumeIgnition', label: '放量启动', universe: 'sp500',
      desc: '量能先于价格异动，抓资金刚开始进场的标的。',
      rationale: '成交量是资金进场的唯一可观测证据。均量抬升 + 短期小幅上行，常常出现在主升浪之前。',
      filters: [{ factor: 'volumeSurge', min: 70 }, { factor: 'runup', min: 55 }, { factor: 'liquidity', min: 55 }],
      sort: 'volumeSurge', limit: 30,
      watchOut: '爆量也可能是出货。必须同时看价格位置：高位爆量要警惕，低位爆量更可信。',
    },
    {
      key: 'squeezeSetup', label: '波动压缩待爆发', universe: 'highbeta',
      desc: '布林带被压到极窄，等方向选择。',
      rationale: '低波动聚集后往往跟着高波动。这是「时间窗口」信号 —— 告诉你要开始盯这只票了，而不是告诉你会涨。',
      filters: [{ factor: 'compression', min: 80 }, { factor: 'liquidity', min: 50 }],
      sort: 'compression', limit: 25,
      watchOut: '★ 方向未知！向上向下概率接近。必须等突破确认，不要在压缩区里猜方向重仓。',
    },
    {
      key: 'oversoldBounce', label: '超卖反弹', universe: 'sp500',
      desc: '在强势股的回调里找超卖机会。',
      rationale: '要求质量（代理）因子在位，即只做「好公司的坏日子」，不做「坏公司的日常」。',
      filters: [{ factor: 'reversal', min: 45, }, { factor: 'quality', min: 55 }, { factor: 'trend', min: 40 }],
      sort: 'reversal', limit: 25,
      watchOut: '超卖可以更超卖。必须确认下跌的起因是一次性事件而非基本面恶化，否则就是接刀。',
    },
    {
      key: 'smallCapMomo', label: '小盘高弹性', universe: 'smallcap',
      desc: '小市值 + 高弹性 + 动量，追求爆发力。',
      rationale: '小盘股的定价效率更低，一旦被资金发现，弹性远大于大盘股。',
      filters: [{ factor: 'size', min: 65 }, { factor: 'elasticity', min: 60 }, { factor: 'momentum', min: 55 }, { factor: 'liquidity', min: 40 }],
      sort: 'composite', limit: 25,
      watchOut: '流动性风险最大的一类。必须在成交额门槛上卡住，并接受更高的失败率。',
    },
    {
      key: 'aiComputeRotation', label: 'AI 算力链轮动', universe: 'aicompute',
      desc: '在算力链内部找相对强度领先的环节。',
      rationale: '主题行情里资金会在产业链内部轮动，买「当前最强的那一环」通常优于死守一只。',
      filters: [{ factor: 'relativeStrength', min: 55 }, { factor: 'momentum', min: 45 }, { factor: 'liquidity', min: 50 }],
      sort: 'relativeStrength', limit: 20,
      watchOut: '主题板块同涨同跌，集中度过高会让组合变成「一只票的多个马甲」，要注意相关性风险。',
    },
    {
      key: 'lowVolQuality', label: '低波质量', universe: 'sp500',
      desc: '波动低、回撤浅、走势稳，用于降低组合波动。',
      rationale: '低波异象在美股长期有效，且回撤小意味着更容易拿得住。',
      filters: [{ factor: 'lowvol', min: 70 }, { factor: 'quality', min: 65 }],
      sort: 'lowvol', limit: 25,
      watchOut: '收益预期也要相应下调；这类标的不会给你「暴涨」，它的价值在于让组合活得更久。',
    },
    {
      key: 'valueDeep', label: '深度价值', universe: 'sp500',
      desc: 'PE 口径下的低估值标的，配合质量代理过滤。',
      rationale: '估值回归需要时间，因此必须叠加质量过滤，避免掉进「便宜但是会一直便宜」的价值陷阱。',
      filters: [{ factor: 'value', min: 70 }, { factor: 'quality', min: 50 }],
      sort: 'value', limit: 25,
      watchOut: '本工具只有 PE 口径，无法识别「PE 低是因为一次性收益」这类陷阱，务必人工核查财报。',
    },
    {
      key: 'earningsDrift', label: '财报前布局', universe: 'nasdaq100',
      desc: '对即将披露财报、且形态与量能配合的标的做事件前置布局。',
      rationale: '财报漂移效应（PEAD）说明超预期的方向会延续。配合技术面确认可提高胜率。',
      filters: [{ factor: 'trend', min: 50 }, { factor: 'volumeSurge', min: 55 }, { factor: 'liquidity', min: 55 }],
      sort: 'composite', limit: 20,
      eventFilter: 'within21Days',
      watchOut: '★ 财报是最大的跳空风险。事件前重仓等于赌方向，仓位必须显著低于常规。',
    },
    {
      key: 'relativeWinner', label: '相对强度领跑', universe: 'sp500',
      desc: '跑赢标普 500 最多的标的，纯资金流向逻辑。',
      rationale: '资金为什么留在这里不重要，重要的是它确实留在这里了。领涨股继续领涨的概率高于落后股补涨。',
      filters: [{ factor: 'relativeStrength', min: 70 }, { factor: 'liquidity', min: 55 }],
      sort: 'relativeStrength', limit: 25,
      watchOut: '领涨股也是回撤最深的。市场系统性调整时，这类标的的跌幅会显著大于指数。',
    },
    {
      key: 'defensive', label: '防御配置', universe: 'dividend',
      desc: '低波 + 高质量 + 高流动性，用于市场环境不明时的防守。',
      rationale: '在事件密集或趋势不明的窗口，降低组合波动比追求收益更重要。',
      filters: [{ factor: 'lowvol', min: 60 }, { factor: 'liquidity', min: 50 }],
      sort: 'quality', limit: 20,
      watchOut: '防御不等于不亏，只是亏得慢一些。真正的防守是降低总仓位。',
    },
    {
      key: 'moonshotCandidate', label: '高弹性候选', universe: 'highbeta',
      desc: '弹性 + 压缩 + 量能 + 相对强度的多维度共振，用于建立观察清单。',
      rationale: '把「历史上暴涨行情出现前的共同特征」量化后取交集，缩小研究范围。',
      filters: [{ factor: 'elasticity', min: 65 }, { factor: 'compression', min: 60 }, { factor: 'volumeSurge', min: 55 }],
      sort: 'composite', limit: 20,
      watchOut: '★ 这是观察清单不是买入清单。高分只代表弹性大，下跌同样会被放大。',
    },
  ];

  const PRESET_MAP = {};
  for (const p of PRESETS) PRESET_MAP[p.key] = p;

  // ============================================================ 筛选

  /**
   * 因子筛选。
   * @param {Array} items scoreUniverse() 的结果
   * @param {Object} criteria {
   *   filters:[{factor, min, max}], minComposite, maxPE, minPE, minMarketCap, maxMarketCap,
   *   minAmount, sort, limit, exclude, symbols, preset
   * }
   */
  function screen(items, criteria) {
    const c = criteria || {};
    // 支持直接传预设：预设的 filters 与调用方额外给的 filters 合并
    let preset = null;
    if (c.preset) {
      preset = typeof c.preset === 'string' ? PRESET_MAP[c.preset] : c.preset;
    }
    const presetFilters = preset ? (preset.filters || []) : [];
    const userFilters = (c.filters || []).filter((f) => f && f.factor && (f.min != null || f.max != null));
    // 同因子以调用方（用户手改）为准
    const merged = new Map();
    for (const f of presetFilters) merged.set(f.factor, { ...f });
    for (const f of userFilters) merged.set(f.factor, { ...(merged.get(f.factor) || {}), ...f });
    const filters = [...merged.values()];

    const exclude = new Set((c.exclude || []).map((x) => String(x).toUpperCase()));
    const only = c.symbols && c.symbols.length ? new Set(c.symbols.map((x) => String(x).toUpperCase())) : null;
    let rows = (items || []).filter((it) => {
      if (!it) return false;
      const sym = String(it.symbol).toUpperCase();
      if (exclude.has(sym)) return false;
      if (only && !only.has(sym)) return false;
      return true;
    });
    const rejected = [];

    const minComposite = c.minComposite != null ? c.minComposite : (preset ? preset.minComposite : null);

    for (const it of rows) {
      let ok = true;
      const fails = [];
      for (const f of filters) {
        const v = f.factor === 'composite' ? it.composite : (it.scores || {})[f.factor];
        if (v == null) continue;
        if (f.min != null && v < f.min) {
          ok = false;
          fails.push(`${FACTOR_MAP[f.factor] ? FACTOR_MAP[f.factor].label : f.factor} ${v} < ${f.min}`);
        }
        if (f.max != null && v > f.max) {
          ok = false;
          fails.push(`${FACTOR_MAP[f.factor] ? FACTOR_MAP[f.factor].label : f.factor} ${v} > ${f.max}`);
        }
      }
      if (minComposite != null && it.composite < minComposite) {
        ok = false;
        fails.push(`综合分 ${it.composite} < ${minComposite}`);
      }
      if (c.maxPE != null && it.pe != null && it.pe > c.maxPE) {
        ok = false;
        fails.push(`PE ${it.pe} > ${c.maxPE}`);
      }
      if (c.minPE != null && it.pe != null && it.pe < c.minPE) {
        ok = false;
        fails.push(`PE ${it.pe} < ${c.minPE}`);
      }
      if (c.minMarketCap != null && it.marketCap != null && it.marketCap < c.minMarketCap) {
        ok = false;
        fails.push(`市值 $${(it.marketCap / 1e9).toFixed(2)}B 低于门槛 $${(c.minMarketCap / 1e9).toFixed(1)}B`);
      }
      if (c.maxMarketCap != null && it.marketCap != null && it.marketCap > c.maxMarketCap) {
        ok = false;
        fails.push(`市值超过上限`);
      }
      if (c.minAmount != null && it.raw && it.raw.avgAmount != null && it.raw.avgAmount < c.minAmount) {
        ok = false;
        fails.push(`日均成交额 $${(it.raw.avgAmount / 1e6).toFixed(1)}M 低于门槛`);
      }
      if (!ok) rejected.push({ symbol: it.symbol, reasons: fails });
    }
    const rejectedSet = new Set(rejected.map((r) => r.symbol));
    rows = rows.filter((it) => !rejectedSet.has(it.symbol));

    const sortKey = c.sort || (preset ? preset.sort : null) || 'composite';
    rows.sort((a, b) => {
      if (sortKey === 'composite') return b.composite - a.composite;
      if (sortKey === 'marketCap') return (b.marketCap || 0) - (a.marketCap || 0);
      if (sortKey === 'pe') return (a.pe || 1e9) - (b.pe || 1e9);
      if (sortKey === 'amount') return ((b.raw || {}).avgAmount || 0) - ((a.raw || {}).avgAmount || 0);
      return ((b.scores || {})[sortKey] || 0) - ((a.scores || {})[sortKey] || 0);
    });
    const limit = c.limit != null ? c.limit : (preset ? preset.limit : null);
    if (limit) rows = rows.slice(0, limit);

    const summary = preset
      ? `「${preset.label}」从 ${(items || []).length} 只中筛出 ${rows.length} 只，${rejected.length} 只因条件不符被排除。${preset.desc}`
      : `从 ${(items || []).length} 只中筛出 ${rows.length} 只，${rejected.length} 只因条件不符被排除。`;

    return {
      rows,
      rejected,
      total: (items || []).length,
      matched: rows.length,
      preset: preset ? { key: preset.key, label: preset.label, desc: preset.desc, rationale: preset.rationale, watchOut: preset.watchOut } : null,
      summary,
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
    FACTOR_MAP,
    PRESETS,
    PRESET_MAP,
    COMPOSITE_WEIGHTS,
    universes,
    mergeUniverses,
    computeFactors,
    compositeOf,
    scoreUniverse,
    screen,
    grid,
    paramScan,
    compare,
    scale,
  };
});
