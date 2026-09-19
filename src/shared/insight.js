/**
 * insight.js —— 风险点与机会点引擎
 *
 * 这个模块回答两个问题，并且**只回答这两个**：
 *   1. 这只标的有哪些「可核实的」上行理由？（opportunities）
 *   2. 有哪些「可核实的」下行风险？（risks）
 *
 * 每条结论都必须带 evidence（触发它的原始数值）与 threshold（判定阈值），
 * 界面上要能点开看到「因为 RSI=78 > 75 所以判为超买」。
 * 这是本模块与「AI 随口点评」的区别所在 —— **没有数据支撑的判断一律不输出**。
 *
 * 诚实的边界：
 *   · 本模块全部基于**价格与成交量**（+ 可选的新闻/事件/空头/分析师数据）。
 *   · 没有财报明细（营收/毛利率/现金流），所以基本面判断只到「PE 口径」为止。
 *   · 不预测涨跌，只罗列事实与不利/有利的统计特征。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./indicators'));
  else root.Insight = factory(root.Indicators);
})(typeof self !== 'undefined' ? self : this, function (I) {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  /**
   * 成交额格式化。
   * 用 toFixed(1) + M 会让 1 万美元显示成「$0.0M」，看上去像数据缺失 ——
   * 小金额必须降到 K 档，否则用户会误判为「没取到数据」。
   */
  function fmtAmount(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return '--';
    if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
    return `$${n.toFixed(0)}`;
  }

  /** 统一的机会点构造：每条都必须有证据 */
  function opp(key, label, strength, evidence, desc) {
    return { key, label, kind: 'opportunity', strength: Math.round(clamp(strength, 0, 100)), evidence, desc };
  }
  function risk(key, label, severity, evidence, desc) {
    return { key, label, kind: 'risk', severity: Math.round(clamp(severity, 0, 100)), evidence, desc };
  }

  /**
   * @param {Object} o {
   *   bars, quote, ppy,
   *   factors,        // factors.js analyze() 的结果（可选，没有就自己算）
   *   newsSummary,    // newsfeed.js summarize() 的结果（可选）
   *   newsTop,        // 新闻明细（可选，用于抽取最强利多/利空标题）
   *   eventRisk,      // events.js riskProfile() 的结果（可选）
   *   daysToEarnings, // { days, date, epsForecast } | null
   *   shortInterest,  // { latest:{interest,daysToCover,settlementDate}, prev:{...}, trend } | null
   *   analyst,        // { priceTarget, lowPriceTarget, highPriceTarget, buy, hold, sell, trend } | null
   *   benchmark,      // { ret20, ret60 } 基准（如 SPX）收益（可选）
   *   liquidity,      // { amount } 近期日均成交额（美元）
   *   sector,         // 板块名（可选）
   * }
   */
  function analyze(o) {
    const opt = o || {};
    const bars = opt.bars || [];
    const q = opt.quote || {};
    const ppy = opt.ppy || 252;
    if (bars.length < 60) {
      return { error: 'K线不足 60 根，无法做可靠的风险/机会评估', opportunities: [], risks: [] };
    }

    const closes = bars.map((b) => b.close);
    const highs = bars.map((b) => b.high);
    const lows = bars.map((b) => b.low);
    const vols = bars.map((b) => b.volume || 0);
    const n = closes.length - 1;
    const price = Number(q.price) || closes[n];

    const ma20 = I.sma(closes, 20);
    const ma60 = I.sma(closes, 60);
    const ma120 = I.sma(closes, 120);
    const rsiArr = I.rsi(closes, 14);
    const macd = I.macd(closes);
    const boll = I.boll(closes, 20, 2);
    const atrArr = I.atr(highs, lows, closes, 14);
    const vma5 = I.volMa(vols, 5);
    const vma20 = I.volMa(vols, 20);
    const rsi = rsiArr[n];
    const atrPct = atrArr[n] && price ? (atrArr[n] / price) * 100 : null;
    const volRatio = vma20[n] ? vma5[n] / vma20[n] : null;

    const ret = (k) => (closes[n - k] > 0 ? (closes[n] / closes[n - k] - 1) * 100 : null);
    const r5 = ret(5);
    const r20 = ret(20);
    const r60 = ret(60);
    const r120 = n >= 120 ? ret(120) : null;

    const hi52 = I.highest(highs, Math.min(ppy, closes.length));
    const lo52 = I.lowest(lows, Math.min(ppy, closes.length));
    const distHigh = hi52 ? ((price - hi52) / hi52) * 100 : null;
    const distLow = lo52 ? ((price - lo52) / lo52) * 100 : null;

    // 年化波动率
    const rets = [];
    for (let i = Math.max(1, n - 59); i <= n; i++) if (closes[i - 1] > 0) rets.push(closes[i] / closes[i - 1] - 1);
    const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
    const sd = rets.length > 1 ? Math.sqrt(rets.reduce((s, v) => s + (v - mean) ** 2, 0) / (rets.length - 1)) : 0;
    const volat = sd * Math.sqrt(ppy) * 100;

    // 最大回撤
    let peak = closes[0];
    let mdd = 0;
    for (const c of closes) {
      peak = Math.max(peak, c);
      mdd = Math.max(mdd, (peak - c) / peak);
    }
    const dayChange = q.changePct != null ? Number(q.changePct) : (closes[n - 1] ? (closes[n] / closes[n - 1] - 1) * 100 : null);

    // 布林带宽度（squeeze 判定）：当下带宽在近 120 日中的分位
    const widths = [];
    for (let i = 19; i <= n; i++) {
      if (boll.upper[i] != null && boll.mid[i]) widths.push((boll.upper[i] - boll.lower[i]) / boll.mid[i]);
    }
    const curWidth = widths.length ? widths[widths.length - 1] : null;
    const widthPct = curWidth != null && widths.length > 20
      ? widths.filter((w) => w <= curWidth).length / widths.length
      : null;

    // 成交额（流动性代理）：优先用 quote.amount，否则 close×volume
    const recentAmount = [];
    for (let i = Math.max(0, n - 19); i <= n; i++) recentAmount.push((bars[i].amount || closes[i] * (vols[i] || 0)) || 0);
    const avgAmount = recentAmount.length ? recentAmount.reduce((a, b) => a + b, 0) / recentAmount.length : 0;

    const opportunities = [];
    const risks = [];

    // ============================================================ 机会点

    // 1. 均线多头排列
    if (ma20[n] && ma60[n] && price > ma20[n] && ma20[n] > ma60[n]) {
      const s = 55 + (ma120[n] && price > ma120[n] ? 15 : 0) + (ma20[n] > ma60[n] * 1.03 ? 12 : 0);
      opportunities.push(opp('trendUp', '均线多头排列', s,
        `现价 ${price.toFixed(2)} > MA20 ${ma20[n].toFixed(2)} > MA60 ${ma60[n].toFixed(2)}`,
        '价格站上 20 日与 60 日均线且短期均线在上，属于趋势顺风结构，回踩均线常有支撑。'));
    }

    // 2. 接近/创 52 周新高
    if (distHigh != null && distHigh > -3) {
      opportunities.push(opp('nearHigh', distHigh > -0.5 ? '创 52 周新高' : '贴近 52 周高点', distHigh > -0.5 ? 86 : 70,
        `距 52 周高点 ${distHigh.toFixed(2)}%（高点 ${hi52.toFixed(2)}）`,
        '新高附近没有套牢盘，上方阻力最小；但同时也意味着一旦回落，缺乏下方成交密集区支撑。'));
    }

    // 3. 动量加速
    const prev20 = n >= 40 && closes[n - 41] > 0 ? (closes[n - 21] / closes[n - 41] - 1) * 100 : null;
    if (prev20 != null && r20 != null) {
      const accel = r20 - prev20;
      if (accel > 8) {
        opportunities.push(opp('momentumAccel', '动量加速', clamp(50 + accel, 50, 88),
          `近 20 日 ${r20.toFixed(1)}% vs 前 20 日 ${prev20.toFixed(1)}%，加速度 +${accel.toFixed(1)}pt`,
          '上涨速度在加快，说明买盘在增强而不是衰减。注意这个信号对回调同样敏感。'));
      }
    }

    // 4. 放量上涨（量价配合）
    if (volRatio != null && dayChange != null && volRatio > 1.4 && dayChange > 2) {
      opportunities.push(opp('volumeConfirm', '放量上涨', clamp(48 + (volRatio - 1.4) * 22 + dayChange * 2, 48, 88),
        `量比 ${volRatio.toFixed(2)}，当日 ${dayChange > 0 ? '+' : ''}${dayChange.toFixed(2)}%`,
        '上涨伴随成交量放大，说明是有资金参与的突破，比缩量上涨的可信度更高。'));
    }

    // 5. 波动收缩（squeeze）—— 变盘前兆，方向未定，所以只算「机会」，且必须同时提示方向不确定
    if (widthPct != null && widthPct < 0.18) {
      opportunities.push(opp('squeeze', '波动收缩（变盘窗口）', Math.round(60 + (0.18 - widthPct) * 160),
        `布林带宽度处于近 120 日的 ${(widthPct * 100).toFixed(0)}% 分位（越小越紧）`,
        '波动率被压缩到低位，历史上常是大行情的前奏。**但方向未知** —— 向上突破与向下破位概率接近，需要等突破确认。'));
    }

    // 6. 超卖反转迹象
    if (rsi != null && rsi < 45) {
      const kd = I.kdj(highs, lows, closes);
      const golden = kd.k[n] != null && kd.d[n] != null && I.cross(kd.k, kd.d) === 1;
      const aboveBoll = boll.lower[n] != null && closes[n] > boll.lower[n] && closes[n - 1] < boll.lower[n - 1];
      if (golden || aboveBoll || rsi < 32) {
        opportunities.push(opp('oversoldBounce', '超卖反弹机会', clamp(90 - rsi, 45, 80),
          `RSI ${rsi.toFixed(1)}${golden ? '，KDJ 低位金叉' : ''}${aboveBoll ? '，站回布林下轨' : ''}`,
          '短期跌幅已经偏大，出现超卖后的技术性反弹信号。反弹强度取决于大盘环境，不是趋势反转。'));
      }
    }

    // 7. 相对强度领先基准
    if (opt.benchmark && opt.benchmark.ret20 != null && r20 != null) {
      const rs = r20 - opt.benchmark.ret20;
      if (rs > 5) {
        opportunities.push(opp('relativeStrength', '跑赢大盘', clamp(45 + rs * 1.6, 45, 85),
          `近 20 日 ${r20.toFixed(1)}% vs 基准 ${opt.benchmark.ret20.toFixed(1)}%，超额 +${rs.toFixed(1)}pt`,
          '相对强度领先，资金更愿意待在这里。轮动行情里，领涨股继续领涨的概率高于落后的补涨股。'));
      }
    }

    // 8. 分析师一致预期（真实数据，仅在能拿到时输出）
    if (opt.analyst && opt.analyst.priceTarget) {
      const tp = Number(opt.analyst.priceTarget);
      const upside = ((tp - price) / price) * 100;
      const votes = (opt.analyst.buy || 0) + (opt.analyst.hold || 0) + (opt.analyst.sell || 0);
      if (upside > 8) {
        opportunities.push(opp('analystUpside', '分析师目标价上行空间', clamp(40 + upside * 1.2, 40, 88),
          `共识目标价 $${tp.toFixed(2)}（区间 $${(opt.analyst.lowPriceTarget || 0).toFixed(2)} ~ $${(opt.analyst.highPriceTarget || 0).toFixed(2)}），距现价 +${upside.toFixed(1)}%；评级 ${opt.analyst.buy || 0}买/${opt.analyst.hold || 0}持/${opt.analyst.sell || 0}卖（共 ${votes} 家）`,
          '卖方共识目标价高于现价。要注意：目标价滞后于股价，且卖方极少给卖出评级，参考价值有限。'));
      } else if (upside < -8) {
        risks.push(risk('analystDownside', '目标价低于现价', clamp(40 - upside * 1.2, 40, 85),
          `共识目标价 $${tp.toFixed(2)}，距现价 ${upside.toFixed(1)}%`,
          '卖方共识目标价已低于当前股价，说明股价跑在了分析师预期前面，靠估值继续上行的空间被压缩。'));
      }
    }

    // 9. 空头回补潜力
    if (opt.shortInterest && opt.shortInterest.latest && opt.shortInterest.latest.daysToCover != null) {
      const dtc = Number(opt.shortInterest.latest.daysToCover);
      const rising = opt.shortInterest.trend === 'up';
      if (dtc > 3) {
        opportunities.push(opp('shortSqueeze', '空头回补潜力', clamp(45 + dtc * 6, 45, 88),
          `空头持仓 ${Number(opt.shortInterest.latest.interest).toLocaleString()} 股，回补天数 ${dtc.toFixed(2)} 天${rising ? '（且在上升）' : ''}`,
          '空头规模相对成交量偏大，若出现利多催化，被动回补会放大涨幅。这是「可能暴涨」类行情最典型的燃料，但触发条件不可控。'));
      }
    }

    // 10. 新闻催化
    if (opt.newsSummary && opt.newsSummary.sentiment >= 20) {
      opportunities.push(opp('newsCatalyst', '新闻面偏多', clamp(35 + opt.newsSummary.sentiment * 0.8, 35, 85),
        `加权情绪 ${opt.newsSummary.sentiment}（偏多 ${opt.newsSummary.bullish} 条 / 偏空 ${opt.newsSummary.bearish} 条）${opt.newsSummary.topBull ? '；最强利多：' + opt.newsSummary.topBull.title.slice(0, 30) : ''}`,
        '近期新闻整体偏正面。注意新闻情绪是短周期变量，衰减很快（本工具按 3 天半衰期计权）。'));
    }

    // 11. 估值口径（只有 PE，如实标注）
    const pe = Number(q.pe);
    if (pe > 0 && pe < 18) {
      opportunities.push(opp('cheapPE', '估值偏低（PE 口径）', clamp(60 - pe, 35, 78),
        `PE(TTM) ${pe.toFixed(2)}`,
        '市盈率处于相对低位。本工具只有 PE 一个估值口径，拿不到 PB / 现金流 / EV-EBITDA，不要把这一条当成完整的基本面结论。'));
    }

    // ============================================================ 风险点

    // 1. 超买
    if (rsi != null && rsi > 72) {
      risks.push(risk('overbought', 'RSI 超买', clamp(45 + (rsi - 72) * 3.2, 45, 92),
        `RSI(14) = ${rsi.toFixed(1)}`,
        '短期超买，追高的即时风险上升。超买不等于必跌，但在超买区建仓的赔率明显变差。'));
    }

    // 2. 短期涨幅过大
    if (r20 != null && r20 > 35) {
      risks.push(risk('parabolic', '短期涨幅过大', clamp(40 + (r20 - 35) * 1.4, 40, 90),
        `近 20 日涨幅 +${r20.toFixed(1)}%`,
        '涨速过快，获利盘丰厚，任何利空都可能引发集中兑现。历史上这类形态的回撤既快又深。'));
    }

    // 3. 放量下跌
    if (volRatio != null && dayChange != null && volRatio > 1.5 && dayChange < -3) {
      risks.push(risk('volumeSelloff', '放量下跌', clamp(50 + (volRatio - 1.5) * 25 + Math.abs(dayChange) * 2, 50, 92),
        `量比 ${volRatio.toFixed(2)}，当日 ${dayChange.toFixed(2)}%`,
        '下跌伴随放量，说明是主动抛售而非缩量整理的被动下滑。'));
    }

    // 4. 均线空头排列
    if (ma20[n] && ma60[n] && price < ma20[n] && ma20[n] < ma60[n]) {
      risks.push(risk('trendDown', '均线空头排列', 65 + (ma120[n] && price < ma120[n] ? 12 : 0),
        `现价 ${price.toFixed(2)} < MA20 ${ma20[n].toFixed(2)} < MA60 ${ma60[n].toFixed(2)}`,
        '价格在均线下方且短均线在下，属于趋势逆风结构，反弹到均线附近容易遇到抛压。'));
    }

    // 5. 深度回撤
    if (distHigh != null && distHigh < -30) {
      risks.push(risk('deepDrawdown', '距高点深度回撤', clamp(45 + Math.abs(distHigh + 30) * 0.8, 45, 85),
        `距 52 周高点 ${distHigh.toFixed(1)}%`,
        '深度回撤要么是价值机会，要么是基本面恶化的定价。本地没有财报数据判断是哪一种 —— 需要查最近两期财报与指引。'));
    }

    // 6. 逼近 52 周低点
    if (distLow != null && distLow < 8) {
      risks.push(risk('nearLow', '逼近 52 周低点', clamp(55 - distLow * 3, 40, 80),
        `距 52 周低点仅 +${distLow.toFixed(1)}%（低点 ${lo52.toFixed(2)}）`,
        '创新低附近的标的没有支撑参照，下跌趋势中「便宜」往往会更便宜。'));
    }

    // 7. 波动率异常
    if (atrPct != null && atrPct > 8) {
      risks.push(risk('highVol', '波动率异常偏高', clamp(45 + (atrPct - 8) * 5, 45, 90),
        `ATR = 现价的 ${atrPct.toFixed(2)}%，60 日年化波动率 ${volat != null ? volat.toFixed(1) + '%' : '--'}`,
        '单日波幅占比过大，止损容易被正常波动扫掉，仓位必须相应下调。'));
    }

    // 8. 流动性不足
    if (avgAmount > 0 && avgAmount < 2e7) {
      risks.push(risk('illiquid', '流动性不足', clamp(45 + (1 - avgAmount / 2e7) * 35, 45, 85),
        `近 20 日日均成交额约 ${fmtAmount(avgAmount)}`,
        '成交额偏低会导致买卖价差扩大、冲击成本上升，大资金进出会显著影响价格。'));
    }

    // 9. 估值偏高
    if (pe > 0 && pe > 60) {
      risks.push(risk('richPE', '估值偏高（PE 口径）', clamp(40 + (pe - 60) * 0.35, 40, 85),
        `PE(TTM) ${pe.toFixed(2)}`,
        '高 PE 意味着市场已把较乐观的预期计入价格，一旦增速不及预期，估值与业绩会双杀。仅 PE 一个口径，结论强度有限。'));
    }
    if (pe != null && pe < 0) {
      risks.push(risk('negativePE', '当前为亏损（PE 为负）', 60,
        `PE(TTM) ${pe.toFixed(2)}`,
        '公司当前处于亏损状态，估值无法用 PE 衡量，波动会显著高于盈利稳定的同业。'));
    }

    // 10. 财报事件风险
    if (opt.daysToEarnings && opt.daysToEarnings.days != null) {
      const d = opt.daysToEarnings.days;
      if (d <= 14) {
        risks.push(risk('earningsEvent', '财报窗口临近', clamp(d <= 3 ? 88 : d <= 7 ? 78 : 62, 50, 92),
          `距下次财报 ${d} 天（${opt.daysToEarnings.date}${opt.daysToEarnings.time ? ' ' + opt.daysToEarnings.time : ''}${opt.daysToEarnings.epsForecast ? '，市场预期 EPS ' + opt.daysToEarnings.epsForecast : ''}${opt.daysToEarnings.estimated ? '，日期为估算' : ''}）`,
          '财报是单一最大的跳空风险源，盘前/盘后公布意味着你无法在盘中止损。事件前控制仓位是最有效的风控。'));
      }
    }

    // 11. 空头持仓上升
    if (opt.shortInterest && opt.shortInterest.latest && opt.shortInterest.trend === 'up') {
      const cur = Number(opt.shortInterest.latest.interest);
      const prev = opt.shortInterest.prev ? Number(opt.shortInterest.prev.interest) : null;
      if (prev) {
        const chg = ((cur - prev) / prev) * 100;
        if (chg > 5) {
          risks.push(risk('shortInterestUp', '空头持仓上升', clamp(40 + chg * 0.8, 40, 80),
            `最新空头 ${cur.toLocaleString()} 股，较上期 +${chg.toFixed(1)}%`,
            '空头在加仓，说明有一批资金在押注下跌。这既可能是「燃料」（回补推动上涨），也可能是「先知」（基本面确实在恶化）。'));
        }
      }
    }

    // 12. 新闻面偏空
    if (opt.newsSummary && opt.newsSummary.sentiment <= -20) {
      risks.push(risk('newsNegative', '新闻面偏空', clamp(35 + Math.abs(opt.newsSummary.sentiment) * 0.8, 35, 85),
        `加权情绪 ${opt.newsSummary.sentiment}（偏多 ${opt.newsSummary.bullish} 条 / 偏空 ${opt.newsSummary.bearish} 条）${opt.newsSummary.topRisk ? '；最强利空：' + opt.newsSummary.topRisk.title.slice(0, 30) : ''}`,
        '近期新闻整体偏负面，需核实是「一次性事件」还是「趋势性恶化」。前者跌下来是机会，后者是陷阱。'));
    }

    // 13. 宏观事件窗口
    if (opt.eventRisk && opt.eventRisk.score >= 40) {
      risks.push(risk('macroWindow', '宏观事件窗口', clamp(opt.eventRisk.score * 0.75, 30, 80),
        `事件风险分 ${opt.eventRisk.score}（${opt.eventRisk.level}），最近：${opt.eventRisk.nearest ? opt.eventRisk.nearest.event + '（' + opt.eventRisk.nearest.daysAway + ' 天后）' : '--'}`,
        '重大数据或议息会议前后，指数级波动会无差别传导到个股，个股自身的技术形态会被短期打乱。'));
    }

    // 14. 相对弱势
    if (opt.benchmark && opt.benchmark.ret20 != null && r20 != null) {
      const rs = r20 - opt.benchmark.ret20;
      if (rs < -8) {
        risks.push(risk('relativeWeak', '明显跑输大盘', clamp(40 + Math.abs(rs), 40, 80),
          `近 20 日 ${r20.toFixed(1)}% vs 基准 ${opt.benchmark.ret20.toFixed(1)}%，落后 ${rs.toFixed(1)}pt`,
          '资金在流出这只标的。除非有明确的错杀逻辑，否则「跌得多」本身不构成买入理由。'));
      }
    }

    // 15. 长期弱势
    if (r120 != null && r120 < -30) {
      risks.push(risk('longTermWeak', '中期趋势走弱', clamp(40 + Math.abs(r120) * 0.6, 40, 80),
        `近 120 日 ${r120.toFixed(1)}%`,
        '半年级别的下行趋势。趋势的惯性通常强于估值修复的动力，逆势抄底需要更强的理由。'));
    }

    // ============================================================ 汇总

    opportunities.sort((a, b) => b.strength - a.strength);
    risks.sort((a, b) => b.severity - a.severity);

    // 综合：机会取前四加权，风险取前四加权（风险权重略高，保守取向）
    //
    // ★ 关键：分母用**固定权重和**，不是「实际命中项数的权重和」。
    //   早期版本用后者，导致「只有 1 条风险」时那一条被赋予 100% 权重，
    //   一条 90 分的风险直接压过三条机会 → 明明在上升趋势里也判「偏空」。
    //   用固定分母后，命中项少的一侧分数自然低 —— 这符合直觉：
    //   理由越少，说服力越弱；而不是「只有一条理由，所以它特别重要」。
    const W = [1, 0.7, 0.5, 0.35];
    const WSUM = W.reduce((a, b) => a + b, 0);
    const topOpp = opportunities.slice(0, 4);
    const topRisk = risks.slice(0, 4);
    const oppScore = topOpp.reduce((s, x, i) => s + x.strength * W[i], 0) / WSUM;
    const riskScore = topRisk.reduce((s, x, i) => s + x.severity * W[i], 0) / WSUM;
    const net = Math.round(oppScore - riskScore * 1.1);
    // 风险调整：波动率与事件风险都压制净分
    const volPenalty = atrPct != null && atrPct > 7 ? Math.min(15, (atrPct - 7) * 3) : 0;
    const evPenalty = opt.eventRisk ? opt.eventRisk.score * 0.08 : 0;
    const netAdj = Math.round(net - volPenalty - evPenalty);

    const stance =
      netAdj >= 30 ? { key: 'bullish', label: '机会占优', note: '上行理由数量与强度均强于下行风险。仍须按事件窗口调整仓位。' }
        : netAdj >= 10 ? { key: 'lean-bull', label: '略偏多', note: '机会点略多于风险点，属于可观察、可小仓位试错的区间。' }
        : netAdj > -10 ? { key: 'neutral', label: '多空平衡', note: '机会与风险大致相当，缺乏明确优势，等待更好的赔率再动手。' }
        : netAdj > -30 ? { key: 'lean-bear', label: '略偏空', note: '风险点强于机会点，优先考虑规避而非抄底。' }
        : { key: 'bearish', label: '风险占优', note: '下行风险显著强于上行理由。若已持仓，应优先处理仓位而非加仓摊薄。' };

    const summary =
      `机会点 ${opportunities.length} 项 / 风险点 ${risks.length} 项；机会强度均值 ${Math.round(oppScore)}，风险强度均值 ${Math.round(riskScore)}，` +
      `风险调整后净分 ${netAdj}（${stance.label}）。` +
      (topOpp.length ? ` 首要机会：${topOpp.map((x) => x.label).join('、')}。` : '') +
      (topRisk.length ? ` 首要风险：${topRisk.map((x) => x.label).join('、')}。` : '');

    return {
      symbol: q.code || '',
      name: q.name || '',
      price,
      opportunities,
      risks,
      scores: {
        opportunity: Math.round(oppScore),
        risk: Math.round(riskScore),
        net,
        netAdjusted: netAdj,
        volatility: volat == null ? null : Number(volat.toFixed(2)),
        atrPct: atrPct == null ? null : Number(atrPct.toFixed(2)),
        maxDrawdown: Number((mdd * 100).toFixed(2)),
        rsi: rsi == null ? null : Number(rsi.toFixed(1)),
        return20: r20 == null ? null : Number(r20.toFixed(2)),
        return60: r60 == null ? null : Number(r60.toFixed(2)),
        volumeRatio: volRatio == null ? null : Number(volRatio.toFixed(2)),
        distanceToHigh: distHigh == null ? null : Number(distHigh.toFixed(2)),
        distanceToLow: distLow == null ? null : Number(distLow.toFixed(2)),
        avgAmount,
        bollWidthPercentile: widthPct == null ? null : Number((widthPct * 100).toFixed(1)),
      },
      stance,
      summary,
      disclaimer:
        '以上机会点与风险点全部由价格、成交量及公开数据按固定规则生成，用于缩小研究范围，不构成投资建议。' +
        '每条结论都附带了触发它的原始数值，请自行复核；代理口径（如质量、盈利修正）已在描述中标注。',
    };
  }

  return { analyze, opp, risk, fmtAmount };
});
