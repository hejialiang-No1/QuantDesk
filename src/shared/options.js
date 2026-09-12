/**
 * options.js —— 个股期权策略生成器
 *
 * 说明（重要）：
 *   东方财富的公开接口没有美股期权链，所以这里不"猜行情"，而是走严谨的推导路径：
 *     历史波动率 HV  →  IV 估算（HV × 风险溢价系数，默认 1.15）
 *                     →  Black-Scholes 理论定价
 *                     →  按对数正态分布积分求每个策略的胜率与期望盈亏
 *   界面上提供 IV 手动输入框，可以直接把券商里看到的真实 IV 填进来，
 *   所有价格会立刻按真实 IV 重算。这样得到的最大盈利/亏损/盈亏平衡点是精确的，
 *   只有"权利金"一项是理论值。
 *
 * 合约乘数统一按美股标准 100 股/张。
 */
const I = require('./indicators');

const MULT = 100;
const DEFAULTS = {
  r: 0.043,          // 无风险利率（美元短端）
  ivMult: 1.15,      // 隐含波动率相对历史波动率的溢价系数
  ivCap: 2.5,
  ivFloor: 0.08,
};

// ---------------------------------------------------------------- 数学

function normPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/** Abramowitz-Stegun 7.1.26 近似，误差 < 7.5e-8 */
function normCdf(x) {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + sign * y);
}

/** Black-Scholes 定价与希腊字母 */
function bs(S, K, T, r, sigma, type) {
  if (!(S > 0) || !(K > 0) || !(T > 0) || !(sigma > 0)) {
    const intrinsic = type === 'call' ? Math.max(0, S - K) : Math.max(0, K - S);
    return { price: intrinsic, delta: 0, gamma: 0, theta: 0, vega: 0 };
  }
  const sq = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / sq;
  const d2 = d1 - sq;
  const disc = Math.exp(-r * T);
  let price;
  let delta;
  if (type === 'call') {
    price = S * normCdf(d1) - K * disc * normCdf(d2);
    delta = normCdf(d1);
  } else {
    price = K * disc * normCdf(-d2) - S * normCdf(-d1);
    delta = normCdf(d1) - 1;
  }
  const gamma = normPdf(d1) / (S * sq);
  const vega = (S * normPdf(d1) * Math.sqrt(T)) / 100;
  const theta =
    type === 'call'
      ? (-(S * normPdf(d1) * sigma) / (2 * Math.sqrt(T)) - r * K * disc * normCdf(d2)) / 365
      : (-(S * normPdf(d1) * sigma) / (2 * Math.sqrt(T)) + r * K * disc * normCdf(-d2)) / 365;
  return { price, delta, gamma, theta, vega };
}

/** 到期日标准月度期权（第三个周五），取最接近目标日的那一个 */
function monthlyExpiry(targetMs) {
  const d = new Date(targetMs);
  let best = null;
  for (let m = -1; m <= 2; m++) {
    const y = d.getFullYear();
    const mo = d.getMonth() + m;
    const first = new Date(y, mo, 1);
    const dow = first.getDay();
    const offset = (5 - dow + 7) % 7; // 第一个周五
    const third = new Date(y, mo, 1 + offset + 14);
    const diff = Math.abs(third.getTime() - targetMs);
    const isFuture = third.getTime() > Date.now() + 4 * 86400000;
    if (isFuture && (!best || diff < best.diff)) best = { date: third, diff };
  }
  return best ? best.date : new Date(targetMs);
}

function fmtDate(dt) {
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

/** 行权价步长：按价格量级自适应，参考美股常见的 strike 间隔 */
function strikeStep(price) {
  if (price < 25) return 1;
  if (price < 50) return 1;
  if (price < 100) return 2.5;
  if (price < 250) return 5;
  if (price < 500) return 10;
  return 25;
}

function snap(v, step) {
  return Math.round(v / step) * step;
}

function r2(v) {
  return v == null || !isFinite(v) ? null : Math.round(v * 100) / 100;
}

// ---------------------------------------------------------------- 头寸评估

/**
 * 用对数正态分布精确积分，得到最大盈亏、盈亏平衡与胜率
 * legs: [{ action:'buy'|'sell', type:'call'|'put'|'stock', K, qty, premium }]
 *   注：type='stock' 时 K 为 null，premium 填当前股价（买入成本 / 卖出收入），qty=1 代表 100 股。
 *       "备兑看涨""保护性看跌"这类组合必须把正股腿一起算进来，否则最大盈亏是错的。
 */
function evaluate(legs, S0, T, sigma, r) {
  const net = legs.reduce((s, l) => s + (l.action === 'sell' ? 1 : -1) * l.premium * l.qty, 0);

  const payoff = (S) =>
    legs.reduce((s, l) => {
      let intr;
      if (l.type === 'stock') intr = S;
      else if (l.type === 'call') intr = Math.max(0, S - l.K);
      else intr = Math.max(0, l.K - S);
      return s + (l.action === 'buy' ? 1 : -1) * intr * l.qty;
    }, 0);

  const pl = (S) => (payoff(S) + net) * MULT;

  // 极值：扫描网格 + 两端解析极限
  const lo0 = S0 * 0.05;
  const hi0 = S0 * 3.0;
  const steps = 3000;
  const dx = (hi0 - lo0) / steps;
  let maxP = pl(0);
  let minP = pl(0);
  let maxAt = 0;
  let minAt = 0;
  for (let i = 0; i <= steps; i++) {
    const S = lo0 + dx * i;
    const v = pl(S);
    if (v > maxP) {
      maxP = v;
      maxAt = S;
    }
    if (v < minP) {
      minP = v;
      minAt = S;
    }
  }
  const inf = pl(S0 * 20);
  if (inf > maxP) {
    maxP = inf;
    maxAt = Infinity;
  }
  if (inf < minP) {
    minP = inf;
    minAt = Infinity;
  }

  // 概率与期望：按对数正态累计分布精确积分
  const sq = sigma * Math.sqrt(T);
  const mu = Math.log(S0) + (r - 0.5 * sigma * sigma) * T;
  const cdf = (x) => (x > 0 ? normCdf((Math.log(x) - mu) / sq) : 0);
  let probProfit = 0;
  let expected = 0;
  const be = [];
  let prevS = lo0;
  let prevV = pl(lo0);
  if (Math.abs(prevV) < 1e-9) be.push(lo0);
  for (let i = 1; i <= steps; i++) {
    const S = lo0 + dx * i;
    const v = pl(S);
    const p = Math.max(0, cdf(S) - cdf(prevS));
    if (v > 0) probProfit += p;
    expected += v * p;
    if ((prevV < 0 && v > 0) || (prevV > 0 && v < 0)) {
      const t = prevV / (prevV - v);
      be.push(prevS + (S - prevS) * t);
    }
    prevS = S;
    prevV = v;
  }
  // 尾部质量（>3σ）按符号归入盈或亏
  const tailMass = Math.max(0, 1 - cdf(hi0));
  if (pl(hi0) > 0) probProfit += tailMass;

  // 到期时正股趋于无穷时的损益斜率：>0 说明盈利不封顶，<0 说明亏损无下限
  const slopeInf = legs.reduce((s, l) => (l.type === 'put' ? s : s + (l.action === 'buy' ? 1 : -1) * l.qty), 0);

  return {
    netPremium: r2(net * MULT),
    netPerShare: r2(net),
    maxProfit: r2(maxP),
    maxProfitUnbounded: slopeInf > 0,
    maxLoss: r2(minP),
    maxLossUnbounded: slopeInf < 0,
    // 参考情景：股价翻三倍 / 腰斩时的损益，用于给"不封顶"的策略一个可感知的量级
    profitAt3x: r2(pl(S0 * 3)),
    lossAtHalf: r2(pl(S0 * 0.5)),
    maxProfitAt: maxAt === Infinity ? null : r2(maxAt),
    maxLossAt: minAt === Infinity ? null : r2(minAt),
    breakevens: [...new Set(be.map((x) => r2(x)))].sort((a, b) => a - b).slice(0, 3),
    probProfit: Math.round(probProfit * 1000) / 10,
    expectedPl: r2(expected),
  };
}

// ---------------------------------------------------------------- 策略模板

const OUTLOOK_BIAS = {
  long_call: 2,
  bull_call_spread: 1.6,
  csp: 1.1,
  covered_call: 0.7,
  bull_put_spread: 0.8,
  iron_condor: 0,
  long_straddle: 0,
  long_strangle: 0,
  bear_call_spread: -1,
  protective_put: -1,
  bear_put_spread: -1.6,
  long_put: -2,
};

/**
 * @param {Array} bars 日K（时间正序，建议 ≥ 250 根）
 * @param {Object} opts { quote, dte, iv, r, score, levels }
 */
function build(bars, opts = {}) {
  if (!bars || bars.length < 80) return null;
  const o = { ...DEFAULTS, dte: 30, ...opts };
  const ppy = o.ppy || 252; // 每年多少根K线，决定历史波动率的年化口径
  const n = bars.length - 1;
  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);

  let spot = o.quote && o.quote.price ? o.quote.price : closes[n];
  if (!(spot > 0)) return null;
  // 行情与K线严重背离时以K线为准，避免行权价按错误基准生成
  const lastClose = closes[n];
  if (lastClose && Math.abs(spot / lastClose - 1) > 0.2) spot = lastClose;

  // 历史波动率：优先 60 根年化，样本不足退化为 20 根
  const expectBars = Math.min(60, closes.length - 1);
  const hvPct = I.volatility(closes, expectBars, ppy);
  const atrArr = I.atr(highs, lows, closes, 14);
  const atr = atrArr[n] || spot * 0.02;
  // 兜底也要用同一套年化口径，否则周期一变就失真
  const hv = hvPct && hvPct > 0 ? hvPct / 100 : (atr / spot) * Math.sqrt(ppy);
  const iv = Math.max(o.ivFloor, Math.min(o.ivCap, o.iv != null ? o.iv : hv * o.ivMult));

  const dte = o.dte;
  const T = dte / 365;
  const r = o.r;
  const sigma = iv;

  const expiryDate = monthlyExpiry(Date.now() + dte * 86400000);
  const realDte = Math.max(1, Math.round((expiryDate.getTime() - Date.now()) / 86400000));

  const sd = spot * sigma * Math.sqrt(realDte / 252); // 1σ 期望波动（美元）
  const sdPct = (sd / spot) * 100;

  const step = strikeStep(spot);
  const atm = snap(spot, step);

  // 关键行权价：近档约 0.6σ（≈0.25 delta，卖方策略最常用）、中档 1.25σ、远档 2.0σ
  const kUp1 = snap(spot + 0.6 * sd, step);
  const kUp2 = snap(spot + 1.25 * sd, step);
  const kUp3 = snap(spot + 2.0 * sd, step);
  const kDn1 = snap(spot - 0.6 * sd, step);
  const kDn2 = snap(spot - 1.25 * sd, step);
  const kDn3 = snap(spot - 2.0 * sd, step);

  const callAt = (K) => bs(spot, K, T, r, sigma, 'call');
  const putAt = (K) => bs(spot, K, T, r, sigma, 'put');

  const pick = (arr, dir) => (dir > 0 ? Math.max(...arr) : Math.min(...arr));

  // ---- 期权链速查表
  const chain = [kDn3, kDn2, kDn1, atm, kUp1, kUp2, kUp3]
    .filter((v, i, a) => v > 0 && a.indexOf(v) === i)
    .sort((a, b) => a - b)
    .map((K) => {
      const c = callAt(K);
      const p = putAt(K);
      return {
        strike: r2(K),
        moneyness: Math.abs(K - spot) / spot < 0.005 ? 'ATM' : K > spot ? `OTM +${(((K - spot) / spot) * 100).toFixed(1)}%` : `OTM ${(((K - spot) / spot) * 100).toFixed(1)}%`,
        call: r2(c.price),
        callDelta: Math.round(c.delta * 100) / 100,
        put: r2(p.price),
        putDelta: Math.round(p.delta * 100) / 100,
        iv: Math.round(iv * 1000) / 10,
      };
    });

  // ---- 策略生成
  const strategies = [];
  const add = (key, name, nameEn, outlook, legs, extra = {}) => {
    const ev = evaluate(legs, spot, T, sigma, r);
    strategies.push({
      key,
      name,
      nameEn,
      outlook,
      legs: legs.map((l) => ({
        type: l.type,
        action: l.action,
        K: l.K == null ? null : r2(l.K),
        qty: l.qty,
        premium: r2(l.premium),
        cash: r2((l.action === 'buy' ? -1 : 1) * l.premium * MULT * l.qty),
      })),
      ...ev,
      // 资金占用：定义风险策略用最大亏损；卖方/持股类按实际占用给
      capitalRequired: extra.capital != null ? r2(extra.capital) : ev.maxLoss < 0 ? r2(-ev.maxLoss) : 0,
      fit: 50,
      notes: extra.notes || [],
      tag: extra.tag || '',
      hasStockLeg: legs.some((l) => l.type === 'stock'),
    });
  };

  const dteLabel = `约 ${realDte} 天（${fmtDate(expiryDate)}）`;
  const needShares = '需持有 100 股正股';

  // 1) 买入看涨
  add(
    'long_call',
    '买入看涨期权',
    'Long Call',
    '强烈看多',
    [{ action: 'buy', type: 'call', K: atm, qty: 1, premium: callAt(atm).price }],
    {
      capital: r2(callAt(atm).price * MULT),
      tag: '风险有限·杠杆最大',
      notes: ['最大亏损锁定为权利金，不会爆仓', `盈亏平衡 ${r2(atm + callAt(atm).price)}，需在到期前涨过该价位才赚钱`, '时间价值每天流失，不适合横盘'],
    }
  );

  // 2) 牛市看涨价差
  {
    const K1 = atm;
    const K2 = kUp2;
    const c1 = callAt(K1).price;
    const c2 = callAt(K2).price;
    add('bull_call_spread', '牛市看涨价差', 'Bull Call Spread', '看多', [
      { action: 'buy', type: 'call', K: K1, qty: 1, premium: c1 },
      { action: 'sell', type: 'call', K: K2, qty: 1, premium: c2 },
    ], {
      capital: r2((c1 - c2) * MULT),
      tag: '性价比最高的看多表达',
      notes: [`花 ${r2(c1 - c2)} 美元博取 ${r2(K2 - K1)} 美元价差，杠杆约 ${((K2 - K1) / Math.max(0.01, c1 - c2)).toFixed(1)} 倍`, '卖出的高行权价期权替你付了部分权利金', '上行空间封顶在 ' + r2(K2)],
    });
  }

  // 3) 现金担保看跌
  {
    const K = kDn1;
    const p = putAt(K).price;
    add('csp', '现金担保看跌（卖 Put）', 'Cash-Secured Put', '看多/想低价接货', [
      { action: 'sell', type: 'put', K, qty: 1, premium: p },
    ], {
      capital: r2(K * MULT),
      tag: '接货价打折',
      notes: [`被行权时的实际成本 = ${r2(K - p)}，相当于在当前价基础上打了 ${(((spot - (K - p)) / spot) * 100).toFixed(1)}% 折扣`, `需要预留 ${r2(K * MULT)} 美元现金作为保证金`, '股价大跌时亏损与直接持股几乎相同，只是多了权利金缓冲'],
    });
  }

  // 4) 备兑看涨（含正股腿，最大盈亏才是真实持仓口径）
  {
    const K = kUp1;
    const c = callAt(K).price;
    add('covered_call', '备兑看涨（持股卖 Call）', 'Covered Call', '温和看多/看震荡', [
      { action: 'buy', type: 'stock', K: null, qty: 1, premium: spot },
      { action: 'sell', type: 'call', K, qty: 1, premium: c },
    ], {
      capital: spot * MULT,
      tag: '持股增强收益',
      notes: [needShares, `立刻收到 ${r2(c * MULT)} 美元权利金，按 ${realDte} 天折算年化 ${((c / spot) * (365 / realDte) * 100).toFixed(1)}% 的增强收益`, `股价涨过 ${r2(K)} 后正股被行权，上涨收益封顶（最大盈利 ${r2((K - spot + c) * MULT)} 美元）`, '跌破盈亏平衡点后，亏损与单纯持股几乎一致'],
    });
  }

  // 5) 保护性看跌（同样按"持股 + 买保险"的真实口径计算）
  {
    const K = kDn1;
    const p = putAt(K).price;
    add('protective_put', '保护性看跌（持股买保险）', 'Protective Put', '持股防跌', [
      { action: 'buy', type: 'stock', K: null, qty: 1, premium: spot },
      { action: 'buy', type: 'put', K, qty: 1, premium: p },
    ], {
      capital: spot * MULT,
      tag: '给持仓上保险',
      notes: [needShares, `付出 ${r2(p * MULT)} 美元，把最大回撤锁定在 ${(((K - p - spot) / spot) * 100).toFixed(1)}% 以内`, '市场恐慌时 IV 抬升，put 会同步升值，对冲效果更明显', '横盘时保险成本是净损耗，需权衡持有周期'],
    });
  }

  // 6) 熊市看跌价差
  {
    const K1 = atm;
    const K2 = kDn2;
    const p1 = putAt(K1).price;
    const p2 = putAt(K2).price;
    add('bear_put_spread', '熊市看跌价差', 'Bear Put Spread', '看跌', [
      { action: 'buy', type: 'put', K: K1, qty: 1, premium: p1 },
      { action: 'sell', type: 'put', K: K2, qty: 1, premium: p2 },
    ], {
      capital: r2((p1 - p2) * MULT),
      tag: '低成本做空',
      notes: [`净支出 ${r2((p1 - p2) * MULT)} 美元，最大收益 ${r2((K1 - K2 - (p1 - p2)) * MULT)} 美元`, '不需要融券做空，规避借券成本与逼空风险', '下行空间封顶在 ' + r2(K2)],
    });
  }

  // 7) 买入看跌
  add(
    'long_put',
    '买入看跌期权',
    'Long Put',
    '强烈看跌',
    [{ action: 'buy', type: 'put', K: atm, qty: 1, premium: putAt(atm).price }],
    {
      capital: r2(putAt(atm).price * MULT),
      tag: '下跌也能赚钱',
      notes: ['损失以权利金为上限，适合对突发利空的定向押注', `盈亏平衡 ${r2(atm - putAt(atm).price)}`, '同样受时间价值衰减影响'],
    }
  );

  // 8) 铁鹰（中性收租）
  {
    const K = { p1: kDn2, p2: kDn3, c1: kUp2, c2: kUp3 };
    const legs = [
      { action: 'sell', type: 'put', K: K.p1, qty: 1, premium: putAt(K.p1).price },
      { action: 'buy', type: 'put', K: K.p2, qty: 1, premium: putAt(K.p2).price },
      { action: 'sell', type: 'call', K: K.c1, qty: 1, premium: callAt(K.c1).price },
      { action: 'buy', type: 'call', K: K.c2, qty: 1, premium: callAt(K.c2).price },
    ];
    const credit = legs.reduce((s, l) => s + (l.action === 'sell' ? 1 : -1) * l.premium, 0);
    add('iron_condor', '铁鹰（区间收租）', 'Iron Condor', '看震荡', legs, {
      tag: '高胜率·低赔率',
      notes: [`只要到期时股价落在 ${r2(K.p1)}–${r2(K.c1)} 之间就全额收租`, `净收权利金 ${r2(credit * MULT)} 美元，最大亏损被两翼保护封顶（约 ${r2((K.c1 - K.c2 - credit) * MULT)} 美元）`, '胜率高但单次盈利小，最怕单边突破'],
    });
  }

  // 9) 多头跨式 / 宽跨式（押注大波动）
  {
    const c1 = callAt(kUp1).price;
    const p1 = putAt(kDn1).price;
    add('long_strangle', '买入宽跨式', 'Long Strangle', '押注大波动', [
      { action: 'buy', type: 'call', K: kUp1, qty: 1, premium: c1 },
      { action: 'buy', type: 'put', K: kDn1, qty: 1, premium: p1 },
    ], {
      capital: r2((c1 + p1) * MULT),
      tag: '财报/事件驱动',
      notes: [`成本 ${r2((c1 + p1) * MULT)} 美元，需要股价突破 ${r2(kUp1 + c1 + p1)} 或跌破 ${r2(kDn1 - c1 - p1)} 才盈利`, '方向猜错也能赚，只要波动足够大', '若无大事件，双份时间价值同时损耗'],
    });
    const c0 = callAt(atm).price;
    const p0 = putAt(atm).price;
    add('long_straddle', '买入跨式', 'Long Straddle', '押注大波动·更激进', [
      { action: 'buy', type: 'call', K: atm, qty: 1, premium: c0 },
      { action: 'buy', type: 'put', K: atm, qty: 1, premium: p0 },
    ], {
      capital: r2((c0 + p0) * MULT),
      tag: '成本更高·覆盖面更广',
      notes: [`成本 ${r2((c0 + p0) * MULT)} 美元（比宽跨式贵，但触发点更近）`, `只需股价波动超过 ±${(((c0 + p0) / spot) * 100).toFixed(1)}% 即可盈利`, '隐含波动率已经很高时买入，容易被 IV 回落双杀'],
    });
  }

  // ---- 波动率环境判断
  const ivPctile = hv > 0 ? iv / hv : 1;
  const volRegime =
    iv > 0.6
      ? { label: '极高波动', tone: 'down', note: `年化 IV ${(iv * 100).toFixed(0)}%，属于极端区间，卖方策略赔率更佳` }
      : iv > 0.4
        ? { label: '高波动', tone: 'warn', note: `年化 IV ${(iv * 100).toFixed(0)}%，权利金偏贵，优先考虑价差与卖出策略` }
        : iv > 0.22
          ? { label: '中等波动', tone: 'flat', note: `年化 IV ${(iv * 100).toFixed(0)}%，买卖双方相对均衡` }
          : { label: '低波动', tone: 'up', note: `年化 IV ${(iv * 100).toFixed(0)}%，权利金便宜，适合买入期权博方向` };

  // ---- 立场映射
  const score = o.score != null ? o.score : 50;
  const view = score >= 75 ? 2 : score >= 62 ? 1 : score >= 45 ? 0 : score >= 33 ? -1 : -2;
  for (const s of strategies) {
    const bias = OUTLOOK_BIAS[s.key] ?? 0;
    let fit = 100 - Math.abs(bias - view) * 34;
    // 波动率环境微调
    if (['long_call', 'long_put', 'long_straddle', 'long_strangle'].includes(s.key)) fit += iv > 0.4 ? -18 : iv < 0.25 ? 10 : 0;
    if (['covered_call', 'csp', 'iron_condor'].includes(s.key)) fit += iv > 0.45 ? 18 : iv < 0.22 ? -12 : 0;
    s.fit = Math.max(8, Math.min(100, Math.round(fit)));
  }
  strategies.sort((a, b) => b.fit - a.fit);

  return {
    spot: r2(spot),
    hvPct: Math.round(hv * 1000) / 10,
    ivPct: Math.round(iv * 1000) / 10,
    ivMult: ivPctile,
    ivIsManual: opts.iv != null,
    r: r * 100,
    dte: realDte,
    expiry: fmtDate(expiryDate),
    expiryLabel: dteLabel,
    sd: r2(sd),
    sdPct: Math.round(sdPct * 10) / 10,
    expectedRange: [r2(spot - sd), r2(spot + sd)],
    expectedRange2: [r2(spot - 2 * sd), r2(spot + 2 * sd)],
    atmStrike: r2(atm),
    strikeStep: step,
    chain,
    strategies,
    atrPct: Math.round((atr / spot) * 10000) / 100,
    view,
    viewLabel: { 2: '强烈看多', 1: '看多', 0: '中性震荡', '-1': '看跌', '-2': '强烈看跌' }[view],
    volRegime,
    notes: [
      '权利金为 Black-Scholes 理论价，未考虑买卖价差、利息与提前行权，实际成交价请以券商报价为准。',
      '胜率由对数正态分布积分得出，假设收益率服从该分布，与实际市场存在偏差，仅作横向比较用。',
      '期权卖方（卖 Put / 备兑 / 铁鹰）在极端行情下风险可能被放大，请务必确认保证金充足。',
    ],
    disclaimer: '期权属于高杠杆衍生品，可能损失全部本金。本模块仅用于策略教学与研究，不构成投资建议。',
  };
}

module.exports = { build, bs, normCdf, evaluate, monthlyExpiry };
