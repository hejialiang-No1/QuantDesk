/**
 * diagnose.js —— 单只股票全面诊断（"诊股"）
 *
 * 六个维度各自打 0–100 分，再从量化事实里派生「机会清单」与「风险清单」。
 * 关键点：所有条目都必须能落到一个具体的数值上，不允许出现"走势良好，建议关注"
 * 这类没有信息量的话术。每条结论都带 evidence 字段，界面上可直接展开核对。
 */
const I = require('./indicators');
const Factors = require('./factors');

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
function r2(v) {
  return v == null || !isFinite(v) ? null : Math.round(v * 100) / 100;
}
function norm(v, lo, hi) {
  if (v == null || !isFinite(v)) return 0.5;
  return clamp((v - lo) / (hi - lo), 0, 1);
}

/** 能量潮 OBV */
function obv(closes, vols) {
  const out = new Array(closes.length).fill(0);
  for (let i = 1; i < closes.length; i++) {
    const prev = out[i - 1];
    if (closes[i] > closes[i - 1]) out[i] = prev + (vols[i] || 0);
    else if (closes[i] < closes[i - 1]) out[i] = prev - (vols[i] || 0);
    else out[i] = prev;
  }
  return out;
}

/** 区间最大回撤（%） */
function maxDrawdown(values) {
  let peak = -Infinity;
  let mdd = 0;
  for (const v of values) {
    if (v == null) continue;
    if (v > peak) peak = v;
    if (peak > 0) mdd = Math.max(mdd, ((peak - v) / peak) * 100);
  }
  return mdd;
}

function gradeOf(score) {
  if (score >= 80) return { g: 'A', tone: 'up' };
  if (score >= 65) return { g: 'B', tone: 'up' };
  if (score >= 50) return { g: 'C', tone: 'flat' };
  if (score >= 35) return { g: 'D', tone: 'warn' };
  return { g: 'E', tone: 'down' };
}

function diagnose(bars, opts = {}) {
  if (!bars || bars.length < 120) return null;
  const ppy = opts.ppy || 252;       // 每年多少根K线，决定年化口径
  const unit = opts.unit || '日';     // 文案单位：日 / 周 / 月
  const quote = opts.quote || null;
  const n = bars.length - 1;
  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const vols = bars.map((b) => b.volume || 0);
  const dates = bars.map((b) => b.date);

  const price0 = quote && quote.price ? quote.price : closes[n];
  const lastClose = closes[n];
  // 行情与K线严重背离时以K线为准，避免出现自相矛盾的诊断结论
  const price = lastClose && Math.abs(price0 / lastClose - 1) > 0.2 ? lastClose : price0;
  const f = Factors.analyze(bars, quote, ppy) || { score: 50, factors: {}, metrics: {}, signals: [] };
  const m = f.metrics || {};

  const ma20 = I.sma(closes, 20);
  const ma60 = I.sma(closes, 60);
  const ma120 = I.sma(closes, 120);
  const ma200 = I.sma(closes, 200);
  const atrArr = I.atr(highs, lows, closes, 14);
  const atr = atrArr[n] || price * 0.02;
  const atrPct = (atr / price) * 100;
  const rsiArr = I.rsi(closes, 14);
  const rsi = rsiArr[n];
  const macd = I.macd(closes);
  const obvArr = obv(closes, vols);
  const volMa20 = I.volMa(vols, 20);

  // ---------------- 1. 趋势结构
  let trend = 0;
  const above = [ma20, ma60, ma120, ma200].map((a) => a && a[n] != null && price > a[n]);
  trend += above.filter(Boolean).length * 16; // 4 项 × 16 = 64
  if (ma20[n] && ma120[n] && ma20[n] > ma120[n]) trend += 12;
  if (ma60[n] && ma200[n] && ma60[n] > ma200[n]) trend += 12;
  // MA20 斜率（近 20 日）
  const slope20 = ma20[n] != null && ma20[n - 20] ? ((ma20[n] - ma20[n - 20]) / ma20[n - 20]) * 100 : null;
  if (slope20 != null) trend += clamp(norm(slope20, -8, 8) * 12, 0, 12);
  trend = clamp(trend, 0, 100);

  const trendComment = !above[0] && !above[1]
    ? `价格同时位于 MA20(${r2(ma20[n])}) 与 MA60(${r2(ma60[n])}) 下方，属于逆势结构，反弹先当反抽看待。`
    : above[3]
      ? `价格站上全部主要均线，MA200(${r2(ma200[n])}) 之上属于长期多头格局。`
      : `价格位于 MA20 上方、MA200 下方，属于中期修复、长期尚未转强的结构。`;

  // ---------------- 2. 动量
  let momentum = 0;
  momentum += norm(f.metrics.ret20, -15, 25) * 34;
  momentum += norm(f.metrics.ret60, -20, 40) * 24;
  momentum += norm(f.metrics.ret5, -8, 10) * 12;
  const hist = macd.hist[n];
  const histPrev = macd.hist[n - 1];
  if (hist != null && hist > 0) momentum += 14;
  if (hist != null && histPrev != null && hist > histPrev) momentum += 8;
  if (difAbove(macd, n)) momentum += 8;
  momentum = clamp(momentum, 0, 100);

  function difAbove(macdObj, i) {
    return macdObj.dif[i] != null && macdObj.dea[i] != null && macdObj.dif[i] > macdObj.dea[i];
  }

  const momentumComment =
    m.ret20 == null
      ? '样本不足，动量维度按中性处理。'
      : `近 20 根 ${m.ret20 >= 0 ? '+' : ''}${m.ret20.toFixed(1)}%、近 60 根 ${m.ret60 >= 0 ? '+' : ''}${m.ret60.toFixed(
          1
        )}%；MACD 柱 ${hist > 0 ? '在零轴上方且' : '在零轴下方'}${hist != null && histPrev != null ? (hist > histPrev ? '走强' : '走弱') : ''}。`;

  // ---------------- 3. 量能
  let volume = 0;
  volume += norm(f.metrics.volRatio, 0.6, 2.0) * 40;
  // OBV 20 日斜率（用平均成交量归一化）
  const volAvg = volMa20[n] || 1;
  const obvSlope = (obvArr[n] - obvArr[Math.max(0, n - 20)]) / (volAvg * 20);
  volume += norm(obvSlope, -1.2, 1.2) * 35;
  // 上涨日均量 / 下跌日均量
  let upV = 0;
  let downV = 0;
  let upC = 0;
  let downC = 0;
  for (let i = Math.max(1, n - 29); i <= n; i++) {
    if (closes[i] >= closes[i - 1]) {
      upV += vols[i] || 0;
      upC++;
    } else {
      downV += vols[i] || 0;
      downC++;
    }
  }
  const volBias = downV > 0 && upC ? (upV / Math.max(1, upC)) / Math.max(1, downV / Math.max(1, downC)) : 1;
  volume += norm(volBias, 0.6, 1.7) * 25;
  volume = clamp(volume, 0, 100);

  const volumeComment =
    volBias >= 1.15
      ? `近 30 根中上涨根均量是下跌根的 ${volBias.toFixed(2)} 倍，买盘承接更积极。`
      : volBias <= 0.85
        ? `近 30 根中下跌根成交量反而更大（涨跌量比 ${volBias.toFixed(2)}），说明抛压占优。`
        : `量能分布均衡（涨跌量比 ${volBias.toFixed(2)}），没有明显的资金偏向。`;

  // ---------------- 4. 位置与估值
  let position = 0;
  const hi52 = m.hi52;
  const lo52 = m.lo52;
  const posInRange = hi52 && lo52 && hi52 > lo52 ? ((price - lo52) / (hi52 - lo52)) * 100 : 50;
  // 位置分不是"越高越好"——过高追高风险大，过低趋势弱，40~75 分位最舒服
  position += posInRange <= 75 ? norm(posInRange, 0, 75) * 45 : clamp(45 - (posInRange - 75) * 0.9, 8, 45);
  position += rsi == null ? 20 : rsi >= 45 && rsi <= 68 ? 30 : rsi > 78 ? 6 : rsi < 32 ? 20 : 20;
  if (quote && quote.pe != null && quote.pe > 0) {
    // 美股宽基 PE 中枢约 20，高 PE 扣分
    position += clamp(norm(quote.pe, 60, 12) * 25, 0, 25);
  } else {
    position += 15;
  }
  position = clamp(position, 0, 100);

  const positionComment =
    posInRange >= 88
      ? `现价处于近一年区间的 ${posInRange.toFixed(0)}% 分位（接近区间最高 ${r2(hi52)}），上方没有套牢盘但也没有参照物，追高须严格止损。`
      : posInRange <= 25
        ? `现价处于近一年区间的 ${posInRange.toFixed(0)}% 分位（区间最低 ${r2(lo52)} 附近），估值便宜但趋势尚未确认，适合左侧分批。`
        : `现价处于近一年区间的 ${posInRange.toFixed(0)}% 分位，位置中性${
            quote && quote.pe > 0 ? `，PE(TTM) ${quote.pe.toFixed(1)}` : ''
          }。`;

  // ---------------- 5. 波动与风险
  const seg60 = closes.slice(Math.max(0, n - 59));
  const mdd60 = maxDrawdown(seg60);
  const mdd250 = maxDrawdown(closes.slice(Math.max(0, n - 249)));
  let riskScore = 50;
  // ATR% 2~5 最好（有波动可做），>9 或 <1.2 都扣分
  if (atrPct >= 2 && atrPct <= 5) riskScore = 85;
  else if (atrPct < 2) riskScore = 40 + atrPct * 22;
  else riskScore = clamp(85 - (atrPct - 5) * 6, 15, 85);
  riskScore -= clamp((mdd60 - 15) * 1.2, 0, 30);
  riskScore = clamp(riskScore, 0, 100);

  const riskComment = `ATR 占价格 ${atrPct.toFixed(2)}%（每根K线平均波动约 ${r2(
    atr
  )} 美元），近 60 根最大回撤 ${mdd60.toFixed(1)}%，近一年最大回撤 ${mdd250.toFixed(1)}%。`;

  // ---------------- 6. 流动性与资金
  let flow = 0;
  const amt = quote && quote.amount ? quote.amount : null;
  const amount20 = avg(vols, n, 20) * price;
  flow += amt != null ? norm(Math.log10(Math.max(1, amt)), 6.5, 9.5) * 40 : norm(Math.log10(Math.max(1, amount20)), 6.5, 9.5) * 40;
  const volExp = volMa20[n] && volMa20[Math.max(0, n - 20)] ? volMa20[n] / volMa20[Math.max(0, n - 20)] : null;
  flow += volExp != null ? norm(volExp, 0.5, 1.8) * 30 : 15;
  // 5 日与 20 日均量比
  flow += norm(f.metrics.volRatio, 0.6, 1.8) * 30;
  flow = clamp(flow, 0, 100);

  const flowComment =
    volExp == null
      ? '成交量样本不足。'
      : volExp > 1.25
        ? `近 20 根均量较前 20 根放大 ${((volExp - 1) * 100).toFixed(0)}%，资金关注度在提升。`
        : volExp < 0.8
          ? `近 20 根均量较前 20 根萎缩 ${((1 - volExp) * 100).toFixed(0)}%，人气在退潮，突破容易假。`
          : '成交活跃度与前 20 日基本持平。';

  function avg(arr, end, k) {
    const s = arr.slice(Math.max(0, end - k + 1), end + 1).filter((x) => x != null);
    return s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0;
  }

  // ---------------- 汇总
  const dims = [
    { key: 'trend', label: '趋势结构', score: Math.round(trend), comment: trendComment },
    { key: 'momentum', label: '动量强度', score: Math.round(momentum), comment: momentumComment },
    { key: 'volume', label: '量能配合', score: Math.round(volume), comment: volumeComment },
    { key: 'position', label: '位置估值', score: Math.round(position), comment: positionComment },
    { key: 'risk', label: '波动风险', score: Math.round(riskScore), comment: riskComment },
    { key: 'flow', label: '流动性/资金', score: Math.round(flow), comment: flowComment },
  ].map((d) => ({ ...d, ...gradeOf(d.score) }));

  const diagScore = Math.round(
    dims.reduce((s, d) => s + d.score * ({ trend: 0.26, momentum: 0.22, volume: 0.16, position: 0.14, risk: 0.12, flow: 0.1 }[d.key]), 0)
  );
  const rating = Factors.rating(diagScore);

  // ---------------- 机会
  const opportunities = [];
  const addOpp = (title, detail, level, evidence) => opportunities.push({ title, detail, level, evidence });

  if (above[3]) addOpp('长期趋势健康', `价格位于 MA200（${r2(ma200[n])}）上方，历史上这种结构下的回撤更浅、修复更快。`, '高', `price ${r2(price)} > MA200 ${r2(ma200[n])}`);
  const ma5Arr = I.sma(closes, 5);
  if (ma5Arr[n] && ma20[n] && ma5Arr[n] > ma20[n] && ma20[n] > ma60[n])
    addOpp('均线多头排列', 'MA5 > MA20 > MA60，短期与中期资金方向一致，回调往往是买点而非卖点。', '高', `MA5 ${r2(ma5Arr[n])} > MA20 ${r2(ma20[n])} > MA60 ${r2(ma60[n])}`);
  if (hist != null && hist > 0 && histPrev != null && hist > histPrev)
    addOpp('MACD 红柱放大', '动能仍在增强，趋势延续概率高于反转概率。', '中', `hist ${r2(hist)} > ${r2(histPrev)}`);
  if (rsi != null && rsi < 35) addOpp('超卖反弹窗口', `RSI ${rsi.toFixed(1)}，进入超卖区，短线反弹赔率上升（但不代表趋势反转）。`, '中', `RSI=${rsi.toFixed(1)}`);
  if (volBias >= 1.2) addOpp('买盘承接积极', `上涨日均量是下跌日的 ${volBias.toFixed(2)} 倍，说明有资金在跌时接货。`, '中', `涨跌量比 ${volBias.toFixed(2)}`);
  if (posInRange <= 35 && hi52) addOpp('估值分位偏低', `处于 52 周区间 ${posInRange.toFixed(0)}% 分位，向下空间相对有限。`, '中', `区间 ${r2(lo52)}–${r2(hi52)}`);
  if (mdd250 > 30 && price > closes[n - 20])
    addOpp('深度回撤后的修复', `近一年最大回撤 ${mdd250.toFixed(1)}%，当前已重新走强，属于典型的"跌深反弹转趋势"形态。`, '中', `近20日 ${m.ret20 >= 0 ? '+' : ''}${m.ret20.toFixed(1)}%`);
  if (m.ret20 != null && m.ret20 > 15 && m.ret20 < 40 && f.metrics.volRatio > 1.3)
    addOpp('放量上攻', '涨幅可观且伴随放量，属于有资金推动的上涨，而非缩量虚涨。', '中', `20日 ${m.ret20.toFixed(1)}% · 量比 ${f.metrics.volRatio.toFixed(2)}`);
  if (!opportunities.length)
    addOpp('暂无突出机会', '当前各项指标均未进入优势区间，等待更好的赔率出现再动手。', '低', '');

  // ---------------- 风险
  const risks = [];
  const addRisk = (title, detail, level, evidence) => risks.push({ title, detail, level, evidence });

  if (ma60[n] && price < ma60[n]) addRisk('跌破中期支撑', `价格位于 MA60（${r2(ma60[n])}）下方，中期趋势偏弱，反弹到该位置容易遇阻。`, '高', `price ${r2(price)} < MA60 ${r2(ma60[n])}`);
  if (rsi != null && rsi > 75) addRisk('技术性超买', `RSI ${rsi.toFixed(1)} 已进入超买区，短期获利盘随时可能兑现，追高易接盘。`, '高', `RSI=${rsi.toFixed(1)}`);
  if (posInRange >= 90 && hi52) addRisk('高位风险', `已接近 52 周最高 ${r2(hi52)}，一旦放量滞涨容易形成顶部结构。`, '中', `分位 ${posInRange.toFixed(0)}%`);
  if (hist != null && hist < 0 && histPrev != null && hist < histPrev) addRisk('动能转弱', 'MACD 绿柱放大，下跌动能仍在释放。', '中', `hist ${r2(hist)} < ${r2(histPrev)}`);
  if (m.ret20 != null && m.ret20 > 40) addRisk('短期涨幅过大', `20 日累计 ${m.ret20.toFixed(1)}%，均值回归压力大，此位置买入的盈亏比显著恶化。`, '高', `20日 ${m.ret20.toFixed(1)}%`);
  if (volBias <= 0.85) addRisk('抛压占优', `下跌日成交量大于上涨日（${volBias.toFixed(2)} 倍），反弹缺乏承接。`, '中', `涨跌量比 ${volBias.toFixed(2)}`);
  if (atrPct > 8) addRisk('波动过大', `ATR 占价格 ${atrPct.toFixed(1)}%，单日 5% 以上波动很常见，仓位必须相应压缩。`, '高', `ATR% ${atrPct.toFixed(2)}`);
  if (mdd60 > 20) addRisk('近期回撤较深', `近 60 根最大回撤 ${mdd60.toFixed(1)}%，趋势稳定性差。`, '中', `MDD60 ${mdd60.toFixed(1)}%`);
  if (volExp != null && volExp < 0.75) addRisk('量能萎缩', `近 20 根均量较前 20 根萎缩 ${((1 - volExp) * 100).toFixed(0)}%，资金在撤离。`, '中', `均量比 ${volExp.toFixed(2)}`);
  if (quote && quote.pe != null && quote.pe > 60) addRisk('估值偏高', `PE(TTM) ${quote.pe.toFixed(1)}，处于高位，对业绩不及预期的容忍度低。`, '中', `PE ${quote.pe.toFixed(1)}`);
  if (m.distHigh != null && m.distHigh < -45) addRisk('深度破位', `距近一年高点 -${Math.abs(m.distHigh).toFixed(1)}%，属于深度破位，反弹解套盘压力大。`, '高', `距高点 ${m.distHigh.toFixed(1)}%`);
  if (!risks.length) addRisk('暂无明显风险信号', '各项风险指标均在正常区间，但需注意系统性风险（大盘/利率/汇率）。', '低', '');

  // ---------------- 体检表
  const checks = [
    { label: '站上 MA200', pass: !!above[3], detail: ma200[n] ? `MA200 ${r2(ma200[n])}` : '数据不足' },
    { label: '均线多头排列', pass: !!(ma20[n] && ma60[n] && ma20[n] > ma60[n]), detail: ma60[n] ? `MA20 ${r2(ma20[n])} vs MA60 ${r2(ma60[n])}` : '' },
    { label: 'MACD 在零轴上方', pass: !!(macd.dif[n] > 0 && macd.dea[n] > 0), detail: `DIF ${r2(macd.dif[n])}` },
    { label: 'RSI 未超买', pass: rsi != null && rsi < 72, detail: rsi != null ? `RSI ${rsi.toFixed(1)}` : '' },
    { label: '量价配合（涨跌量比≥1）', pass: volBias >= 1, detail: `比值 ${volBias.toFixed(2)}` },
    { label: '波动可交易（ATR 2–6%）', pass: atrPct >= 2 && atrPct <= 6, detail: `ATR ${atrPct.toFixed(2)}%` },
    { label: '未过度偏离区间高点', pass: posInRange < 92, detail: `分位 ${posInRange.toFixed(0)}%` },
    { label: '流动性充足（成交额≥1亿美元）', pass: (amt != null ? amt : amount20) >= 1e8, detail: `约 ${(((amt != null ? amt : amount20) || 0) / 1e8).toFixed(1)} 亿美元` },
  ];
  const passCount = checks.filter((c) => c.pass).length;

  // ---------------- 结论
  const riskLevel = risks.filter((r) => r.level === '高').length >= 2 ? '高' : risks[0] && risks[0].level === '高' ? '中高' : risks.filter((r) => r.level === '中').length >= 3 ? '中' : '偏低';
  const horizon = atrPct > 6 ? '短线 1–3 周' : atrPct > 3.5 ? '波段 2–8 周' : '中长线 1–3 个月';

  const summary =
    `综合体检 ${passCount}/8 项通过，六维得分 ${diagScore} 分（${rating.label}）。` +
    `趋势上${above[3] ? '处于长期均线上方的健康结构' : above[0] ? '中期修复但长期未转强' : '仍在均线下方运行'}，` +
    `动量的近 20 日表现为 ${m.ret20 == null ? '样本不足' : (m.ret20 >= 0 ? '+' : '') + m.ret20.toFixed(1) + '%'}，` +
    `量能上${volBias >= 1.1 ? '买盘略占优势' : volBias <= 0.9 ? '抛压占优' : '多空均衡'}，` +
    `波动率 ${atrPct.toFixed(1)}%（${atrPct > 8 ? '偏高，需压缩仓位' : atrPct < 1.5 ? '偏低，短线空间有限' : '处于可交易区间'}）。` +
    `风险等级评估为「${riskLevel}」，建议持仓周期 ${horizon}（统计口径：每根K线代表 1 ${unit}）。`;

  const highlights = [
    `多空信号：看多 ${f.bullCount} 条 / 看空 ${f.bearCount} 条`,
    `关键位置：支撑 ${r2(ma60[n])} · 压力 ${r2(hi52)}`,
    `波动预算：每根K线 ±${r2(atr)}（${atrPct.toFixed(1)}%）`,
  ];

  return {
    price: r2(price),
    score: diagScore,
    rating,
    dims,
    opportunities: opportunities.slice(0, 6),
    risks: risks.slice(0, 6),
    checks,
    passCount,
    riskLevel,
    horizon,
    summary,
    highlights,
    facts: {
      rsi: r2(rsi),
      atr,
      atrPct: Math.round(atrPct * 100) / 100,
      mdd60: Math.round(mdd60 * 100) / 100,
      mdd250: Math.round(mdd250 * 100) / 100,
      posInRange: Math.round(posInRange * 10) / 10,
      volBias: Math.round(volBias * 100) / 100,
      ma20: r2(ma20[n]),
      ma60: r2(ma60[n]),
      ma120: r2(ma120[n]),
      ma200: r2(ma200[n]),
      hi52: r2(hi52),
      lo52: r2(lo52),
      pe: quote && quote.pe != null ? quote.pe : null,
      marketCap: quote && quote.marketCap ? quote.marketCap : null,
      span: `${dates[0]} → ${dates[n]}`,
      bars: bars.length,
    },
  };
}

module.exports = { diagnose, obv, maxDrawdown };
