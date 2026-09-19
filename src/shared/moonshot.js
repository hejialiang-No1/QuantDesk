/**
 * moonshot.js —— 高弹性机会股雷达（"可能暴涨"候选）
 *
 * ★ 先把话说清楚（这个模块最容易被误用，所以写在最前面）：
 *   「可能暴涨」不是一个可以预测的事件，任何声称能预测暴涨的工具都是在骗人。
 *   本模块做的是**统计特征筛选**：把历史上暴涨行情出现前反复出现的特征（波动弹性高、
 *   波动被压缩、量能异动、相对强度领先、空头燃料多、有明确催化）量化成分数，
 *   帮你把「值得盯的 20 只」从「500 只」里挑出来。
 *
 *   · 高分 ≠ 会涨。高分只意味着「如果它动，弹性会很大」，下跌同样会被放大。
 *   · 每只候选都必须同时给出触发条件与失效条件，缺一不可。
 *   · 界面上必须并列展示 riskFlags，禁止只展示收益率想象。
 *
 * 权重设计依据（可质疑、可调）：
 *   弹性 22 —— 没有弹性就谈不上暴涨，这是必要条件
 *   压缩 16 —— 低波动收缩是变盘前兆，提供「时间窗口」信息
 *   量能 14 —— 放量是资金进场的唯一可观测证据
 *   动能 14 —— 已有的强势会延续（动量效应）
 *   位置 12 —— 新高附近阻力最小
 *   相对强度 8 —— 资金偏好
 *   空头燃料 8 —— 被动回补会放大涨幅
 *   催化 6 —— 新闻/事件提供引爆点
 *   流通盘 6 —— 小盘弹性更大（同时风险也更大）
 *   流动性 −上限 —— 成交额过低的直接降级，避免选出无法交易的标的
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./indicators'), require('./insight'));
  else root.Moonshot = factory(root.Indicators, root.Insight);
})(typeof self !== 'undefined' ? self : this, function (I, Insight) {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  /** 线性映射到 0-100，超出范围截断 */
  const map = (v, lo, hi) => (v == null || !Number.isFinite(v) ? 0 : clamp(((v - lo) / (hi - lo)) * 100, 0, 100));

  const WEIGHTS = {
    elasticity: 22, compression: 16, volume: 14, momentum: 14,
    position: 12, relativeStrength: 8, shortFuel: 8, catalyst: 6, float: 6,
  };

  /**
   * 计算单只标的的暴涨潜力。
   * @param {Object} o {
   *   bars, quote, ppy, benchmark:{ret20}, newsSummary, daysToEarnings,
   *   shortInterest, analyst, insight (可选，复用已算好的 insight 结果)
   * }
   */
  function score(o) {
    const opt = o || {};
    const bars = opt.bars || [];
    const q = opt.quote || {};
    if (bars.length < 60) return null;
    const ppy = opt.ppy || 252;
    const closes = bars.map((b) => b.close);
    const highs = bars.map((b) => b.high);
    const lows = bars.map((b) => b.low);
    const vols = bars.map((b) => b.volume || 0);
    const n = closes.length - 1;
    const price = Number(q.price) || closes[n];

    // ---------- 基础量
    const atrArr = I.atr(highs, lows, closes, 14);
    const atrPct = atrArr[n] && price ? (atrArr[n] / price) * 100 : null;
    const rets = [];
    for (let i = Math.max(1, n - 59); i <= n; i++) if (closes[i - 1] > 0) rets.push(closes[i] / closes[i - 1] - 1);
    const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
    const sd = rets.length > 1 ? Math.sqrt(rets.reduce((s, v) => s + (v - mean) ** 2, 0) / (rets.length - 1)) : 0;
    const volat = sd * Math.sqrt(ppy) * 100;

    const boll = I.boll(closes, 20, 2);
    const widths = [];
    for (let i = 19; i <= n; i++) if (boll.upper[i] != null && boll.mid[i]) widths.push((boll.upper[i] - boll.lower[i]) / boll.mid[i]);
    const curWidth = widths.length ? widths[widths.length - 1] : null;
    const widthPct = curWidth != null && widths.length > 20 ? widths.filter((w) => w <= curWidth).length / widths.length : null;

    const vma5 = I.volMa(vols, 5);
    const vma20 = I.volMa(vols, 20);
    const volRatio = vma20[n] ? vma5[n] / vma20[n] : null;
    const vma20Prev = vma20[n - 5] || null;
    const volTrend = vma20Prev ? vma20[n] / vma20Prev : null; // 20 日均量的趋势

    const r5 = closes[n - 5] > 0 ? (closes[n] / closes[n - 5] - 1) * 100 : null;
    const r20 = closes[n - 20] > 0 ? (closes[n] / closes[n - 20] - 1) * 100 : null;
    const r60 = n >= 60 && closes[n - 60] > 0 ? (closes[n] / closes[n - 60] - 1) * 100 : null;
    const prev20 = n >= 40 && closes[n - 41] > 0 ? (closes[n - 21] / closes[n - 41] - 1) * 100 : null;
    const accel = r20 != null && prev20 != null ? r20 - prev20 : null;

    const hi52 = I.highest(highs, Math.min(ppy, closes.length));
    const lo52 = I.lowest(lows, Math.min(ppy, closes.length));
    const distHigh = hi52 ? ((price - hi52) / hi52) * 100 : null;
    const distLow = lo52 ? ((price - lo52) / lo52) * 100 : null;

    const amount = [];
    for (let i = Math.max(0, n - 19); i <= n; i++) amount.push((bars[i].amount || closes[i] * (vols[i] || 0)) || 0);
    const avgAmount = amount.length ? amount.reduce((a, b) => a + b, 0) / amount.length : 0;

    const cap = Number(q.marketCap) || 0;
    const floatCap = Number(q.floatCap) || cap;

    // ---------- 各维度打分（0-100）
    const parts = {};

    // 1. 弹性：ATR% 与年化波动率的合成。ATR 3%~12% 是「能暴涨」的甜点区
    //    低于 1.5% 基本不可能单月翻倍；高于 15% 说明已被爆炒过，进入博弈阶段
    const eAtr = atrPct == null ? 0 : atrPct <= 1.5 ? map(atrPct, 0.3, 1.5) * 0.5 : atrPct <= 12 ? map(atrPct, 1.5, 9) : Math.max(20, 100 - (atrPct - 12) * 6);
    const eVol = volat == null ? 0 : volat <= 30 ? map(volat, 10, 30) * 0.6 : volat <= 90 ? map(volat, 30, 80) : Math.max(25, 100 - (volat - 90) * 1.5);
    parts.elasticity = Math.round(clamp(eAtr * 0.6 + eVol * 0.4, 0, 100));

    // 2. 压缩：布林带宽度分位越低越好（变盘前夜）
    parts.compression = widthPct == null ? 40 : Math.round(clamp((1 - widthPct) * 100, 0, 100));

    // 3. 量能：近期量比 + 20 日均量趋势（持续放量比单日爆量更好）
    //    ★ 分段必须平滑：早期版本在 0.8~1.0 这一段会算出负数并被 clamp 到 0，
    //      于是「量能与均量持平」的标的反而拿 0 分，整个维度集体趴地、毫无区分度。
    const q1 = volRatio == null ? 40
      : volRatio <= 0.6 ? map(volRatio, 0.2, 0.6) * 0.25
      : volRatio <= 1.0 ? 11 + ((volRatio - 0.6) / 0.4) * 34
      : volRatio <= 2.5 ? 45 + ((volRatio - 1) / 1.5) * 55
      : Math.max(35, 100 - (volRatio - 2.5) * 12);
    const q2 = volTrend == null ? 40 : map(volTrend, 0.7, 1.8);
    parts.volume = Math.round(clamp(q1 * 0.6 + q2 * 0.4, 0, 100));

    // 4. 动能：5/20/60 加权 + 加速度
    const m5 = r5 == null ? 0 : r5 <= 0 ? map(r5, -20, 0) * 0.4 : map(r5, 0, 15) * 0.9;
    const m20 = r20 == null ? 0 : r20 <= -20 ? 10 : r20 <= 5 ? map(r20, -20, 5) : map(r20, 5, 45) * 0.95;
    const m60 = r60 == null ? 40 : map(r60, -30, 60) * 0.8;
    const accelScore = accel == null ? 40 : map(accel, -25, 25);
    parts.momentum = Math.round(clamp(m5 * 0.25 + m20 * 0.35 + m60 * 0.2 + accelScore * 0.2, 0, 100));

    // 5. 位置：贴近 52 周高点（突破阻力最小）得分最高；深跌反转次之；阴跌最低
    //    ★ 深回撤必须按深度递减：早期版本把 -25% 与 -55% 一视同仁给 50 分，
    //      结果位置维度成了常数，等于把 12% 的权重白白浪费掉。
    let posScore;
    if (distHigh == null) posScore = 45;
    else if (distHigh > -5) posScore = 92 - Math.abs(distHigh) * 1.2;          // 新高附近
    else if (distHigh > -20) posScore = 65;                                     // 高位整理
    else if (distLow != null && distLow < 15) posScore = 30;                     // 贴着低点，弱势
    else posScore = distHigh > -60 ? 55 - (Math.abs(distHigh) - 20) * 0.75 : 22; // 按深度递减
    parts.position = Math.round(clamp(posScore, 0, 100));

    // 6. 相对强度
    if (opt.benchmark && opt.benchmark.ret20 != null && r20 != null) {
      const rs = r20 - opt.benchmark.ret20;
      parts.relativeStrength = Math.round(clamp(map(rs, -15, 25), 0, 100));
    } else parts.relativeStrength = 50;

    // 7. 空头燃料：回补天数越高越好
    const si = opt.shortInterest && opt.shortInterest.latest;
    if (si && si.daysToCover != null) {
      const dtc = Number(si.daysToCover);
      const rising = opt.shortInterest.trend === 'up' ? 12 : 0;
      parts.shortFuel = Math.round(clamp(map(dtc, 0.5, 6) * 0.88 + rising, 0, 100));
    } else parts.shortFuel = 40;

    // 8. 催化：新闻情绪 + 财报窗口 + 分析师上修空间
    let cat = 40;
    if (opt.newsSummary && opt.newsSummary.count) cat += clamp(opt.newsSummary.sentiment * 0.35, -18, 18);
    if (opt.daysToEarnings && opt.daysToEarnings.days != null && opt.daysToEarnings.days <= 21 && opt.daysToEarnings.days >= 0)
      cat += 14; // 财报本身就是最强的催化剂（双向）
    if (opt.analyst && opt.analyst.priceTarget && price) {
      const upside = ((Number(opt.analyst.priceTarget) - price) / price) * 100;
      cat += clamp(upside * 0.3, -12, 14);
    }
    parts.catalyst = Math.round(clamp(cat, 0, 100));

    // 9. 流通盘：小盘弹性更大
    //    区间取 3e8(8.5) ~ 6e11(11.78)。早期版本上界只到 4e10，
    //    导致所有千亿级大票一律 0 分，整个维度彻底失去区分度（权重白给）。
    if (floatCap > 0) {
      const lg = Math.log10(floatCap);
      let f = map(lg, 8.5, 11.8) * -1 + 100;
      if (floatCap < 5e7) f -= 25;  // 低于 5000 万的微盘，风险过大反过来扣分
      parts.float = Math.round(clamp(f, 0, 100));
    } else parts.float = 40;

    // ---------- 加权总分
    let total = 0;
    for (const [k, w] of Object.entries(WEIGHTS)) total += (parts[k] || 0) * (w / 100);
    total = clamp(total, 0, 100);

    // ---------- 流动性否决：成交额过低直接降级（不做无意义的名次）
    const liquidityOk = avgAmount >= 2e7;
    const fmtAmt = (Insight && Insight.fmtAmount) || ((v) => (v ? `$${(v / 1e6).toFixed(1)}M` : '--'));
    const liquidityNote = avgAmount === 0
      ? '成交额数据缺失，无法评估流动性'
      : avgAmount < 5e6
      ? `日均成交额仅 ${fmtAmt(avgAmount)}，属于难以进出的标的`
      : avgAmount < 2e7
      ? `日均成交额 ${fmtAmt(avgAmount)} 偏低，大额资金进出会有明显冲击成本`
      : null;
    if (!liquidityOk) total = Math.min(total, 55);

    // ---------- 等级
    const grade = total >= 72 ? 'A' : total >= 62 ? 'B' : total >= 52 ? 'C' : 'D';

    // ---------- 触发条件（必须具体到可观察）
    const triggers = [];
    if (distHigh != null && distHigh > -8 && distHigh <= 0) {
      triggers.push(`有效突破 52 周高点 $${hi52.toFixed(2)}（收盘价站上并守住 2 日）`);
    } else if (distHigh != null && distHigh > 0) {
      triggers.push('已在新高区，回踩不破前期高点即视为趋势延续');
    }
    if (widthPct != null && widthPct < 0.25 && boll.upper[n] != null) {
      triggers.push(`放量突破布林上轨 $${boll.upper[n].toFixed(2)}（波动压缩后的方向选择）`);
    }
    if (r20 != null && r20 < 0) triggers.push(`收复 20 日线/前期密集区，扭转短期弱势`);
    if (opt.daysToEarnings && opt.daysToEarnings.days != null && opt.daysToEarnings.days >= 0 && opt.daysToEarnings.days <= 21) {
      triggers.push(`财报（${opt.daysToEarnings.date}，预期 EPS ${opt.daysToEarnings.epsForecast || '--'}）业绩超预期是最直接的引爆点`);
    }
    if (si && Number(si.daysToCover) > 4) triggers.push('出现利多催化时的空头被动回补（回补天数已超过 4 天）');
    if (!triggers.length) triggers.push('暂无明确的近期触发条件，需等待形态/量能变化');

    // ---------- 失效条件
    const invalidation = [];
    if (I.sma(closes, 20)[n] != null) invalidation.push(`跌破 MA20 $${I.sma(closes, 20)[n].toFixed(2)} 且次日无法收回，视为短期逻辑失效`);
    if (I.sma(closes, 60)[n] != null) invalidation.push(`跌破 MA60 $${I.sma(closes, 60)[n].toFixed(2)}，中期结构转弱`);
    if (lo52 != null && distLow != null && distLow < 40) invalidation.push(`跌破近 52 周低点 $${lo52.toFixed(2)}，进入无支撑区间`);
    if (volRatio != null && volRatio < 0.6) invalidation.push('缩量至 20 日均量的 0.6 倍以下，说明资金关注度消退');

    // ---------- 风险标记（必须与收益想象并列展示）
    const riskFlags = [];
    if (atrPct != null && atrPct > 9) riskFlags.push(`单日平均波幅已达 ${atrPct.toFixed(1)}%，正常波动就可能触及止损`);
    if (r20 != null && r20 > 40) riskFlags.push('近 20 日涨幅已超 40%，处于加速末端，回撤风险同步放大');
    if (avgAmount > 0 && avgAmount < 2e7) riskFlags.push('成交额偏低，滑点与冲击成本高');
    if (floatCap > 0 && floatCap < 3e8) riskFlags.push('流通市值偏小（<$3 亿），易被资金操控，波动缺乏基本面锚');
    const peNow = Number(q.pe);
    if (peNow != null && peNow < 0) riskFlags.push('公司当前亏损，缺乏盈利支撑');
    else if (peNow > 80) riskFlags.push(`PE ${peNow.toFixed(1)} 偏高，估值容错空间小`);
    if (si && Number(si.daysToCover) > 4) riskFlags.push('空头仓位偏高 —— 这既是上涨燃料，也说明有专业资金在做空');
    if (opt.daysToEarnings && opt.daysToEarnings.days != null && opt.daysToEarnings.days <= 7 && opt.daysToEarnings.days >= 0)
      riskFlags.push(`财报在 ${opt.daysToEarnings.days} 天内，跳空风险不可对冲`);
    if (opt.newsSummary && opt.newsSummary.sentiment <= -15) riskFlags.push('新闻面偏空，与做多方向相悖');
    if (distHigh != null && distHigh < -35) riskFlags.push('距高点回撤超 35%，属于下跌趋势中的反弹候选，不是突破候选');

    // ---------- 一句话结论（必须包含反向提示）
    const lead = {
      elasticity: '波动弹性充足',
      compression: '波动已被压缩',
      volume: '量能出现异动',
      momentum: '动量结构偏强',
      position: '位置结构有利',
    };
    const topKeys = Object.entries(parts).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => k);
    const topLabels = topKeys.map((k) => lead[k]).filter(Boolean).join('、') || '各维度均不突出';
    const weak = Object.entries(parts).sort((a, b) => a[1] - b[1])[0];
    const weakLabel = { elasticity: '弹性不足', compression: '波动已充分释放', volume: '量能平淡', momentum: '动能偏弱', position: '位置结构不佳', relativeStrength: '跑输大盘', shortFuel: '缺乏空头燃料', catalyst: '缺少明确催化', float: '盘子偏大' }[weak[0]] || '';

    return {
      symbol: q.code || opt.symbol || '',
      name: q.name || '',
      price,
      changePct: q.changePct == null ? null : Number(q.changePct),
      marketCap: cap || null,
      floatCap: floatCap || null,
      grade,
      score: Math.round(total * 10) / 10,
      parts,
      raw: {
        atrPct: atrPct == null ? null : Number(atrPct.toFixed(2)),
        volatility: volat == null ? null : Number(volat.toFixed(2)),
        bollWidthPercentile: widthPct == null ? null : Number((widthPct * 100).toFixed(1)),
        volumeRatio: volRatio == null ? null : Number(volRatio.toFixed(2)),
        volumeTrend: volTrend == null ? null : Number(volTrend.toFixed(2)),
        ret5: r5 == null ? null : Number(r5.toFixed(2)),
        ret20: r20 == null ? null : Number(r20.toFixed(2)),
        ret60: r60 == null ? null : Number(r60.toFixed(2)),
        acceleration: accel == null ? null : Number(accel.toFixed(2)),
        distanceToHigh: distHigh == null ? null : Number(distHigh.toFixed(2)),
        distanceToLow: distLow == null ? null : Number(distLow.toFixed(2)),
        avgAmount,
        daysToCover: si ? si.daysToCover : null,
        shortTrend: opt.shortInterest ? opt.shortInterest.trend : null,
      },
      triggers,
      invalidation,
      riskFlags,
      liquidityNote,
      summary: `${topLabels}${weakLabel ? '，但' + weakLabel : ''}。等级 ${grade}（${Math.round(total)} 分）。${
        grade === 'A' ? '多维度共振，属于重点观察对象；但共振只代表弹性，不代表方向。'
        : grade === 'B' ? '具备部分暴涨特征，需要等待触发条件出现后再考虑。'
        : grade === 'C' ? '仅单一维度突出，只适合放入观察清单，不构成交易理由。'
        : '不具备暴涨特征，不建议按此逻辑参与。'
      }`,
      note:
        '⚠️ 「暴涨潜力分」衡量的是**弹性与形态特征**，不是上涨概率。高分标的同样可能因为同等的弹性而大幅下跌。' +
        '每一只候选都附带了失效条件，请在下单前先确定「什么情况下我承认自己错了」。',
    };
  }

  /**
   * 批量打分并排名。
   * @param {Array} items [{ bars, quote, symbol, newsSummary, daysToEarnings, shortInterest, analyst }]
   * @param {Object} [opt] { benchmark, topN, minScore, gradeIn }
   */
  function rank(items, opt) {
    const o = opt || {};
    const rows = [];
    for (const it of items || []) {
      try {
        const s = score({ ...it, benchmark: o.benchmark, ppy: o.ppy });
        if (s) rows.push(s);
      } catch {
        /* 单只失败跳过，不影响整池 */
      }
    }
    rows.sort((a, b) => b.score - a.score);
    const filtered = o.gradeIn ? rows.filter((r) => o.gradeIn.includes(r.grade)) : rows;
    const cut = o.minScore != null ? filtered.filter((r) => r.score >= o.minScore) : filtered;
    const out = o.topN ? cut.slice(0, o.topN) : cut;

    const dist = { A: 0, B: 0, C: 0, D: 0 };
    for (const r of rows) dist[r.grade] = (dist[r.grade] || 0) + 1;

    const best = out[0];
    return {
      rows: out,
      total: rows.length,
      matched: out.length,
      distribution: dist,
      benchmark: o.benchmark || null,
      summary: rows.length
        ? `在 ${rows.length} 只中，A 级 ${dist.A} 只 / B 级 ${dist.B} 只 / C 级 ${dist.C} 只 / D 级 ${dist.D} 只。` +
          (best ? ` 弹性特征最突出的是 ${best.symbol}（${best.score} 分，${best.grade} 级）。` : '')
        : '没有可评估的标的（K线不足 60 根）。',
      warning:
        '这是「特征筛选」而不是「预测」。请把本页的输出当作观察清单，而不是买入清单；' +
        '任何一只标的在动手前都必须先定义好失效条件与最大可承受亏损。',
    };
  }

  return { score, rank, WEIGHTS };
});
