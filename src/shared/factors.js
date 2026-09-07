/**
 * factors.js —— 多因子打分与信号识别
 *
 * 设计思路（不是拍脑袋加权，每一档都对应一个可解释的交易逻辑）：
 *   动量 25 分  —— 中期趋势的惯性，美股动量效应长期显著
 *   趋势 25 分  —— 均线结构，决定"顺风还是逆风"
 *   均值回归 15 —— RSI 位置，避免追高、捕捉超卖反弹
 *   量能 15 分  —— 放量是趋势确认的必要条件
 *   波动 10 分  —— 波动过高惩罚（风险），过低说明没资金关注
 *   位置 10 分  —— 距 52 周高点，判断是高位接盘还是回调布局
 */
const I = require('./indicators');

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/** 线性映射到 [0, 1] */
function mapRange(v, lo, hi) {
  if (v == null) return 0;
  return clamp((v - lo) / (hi - lo), 0, 1);
}

/**
 * @param {Array} bars K线数组（时间正序）
 * @param {Object} quote 实时行情（可空）
 */
function analyze(bars, quote) {
  if (!bars || bars.length < 60) return null;
  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const vols = bars.map((b) => b.volume || 0);
  const n = closes.length - 1;

  const price = closes[n];
  const ma5 = I.sma(closes, 5);
  const ma10 = I.sma(closes, 10);
  const ma20 = I.sma(closes, 20);
  const ma60 = I.sma(closes, 60);
  const ma120 = I.sma(closes, 120);
  const macd = I.macd(closes);
  const rsi = I.rsi(closes, 14);
  const boll = I.boll(closes, 20, 2);
  const kd = I.kdj(highs, lows, closes);
  const atr = I.atr(highs, lows, closes, 14);
  const vma5 = I.volMa(vols, 5);
  const vma20 = I.volMa(vols, 20);

  const ret5 = I.ret(closes, 5);
  const ret20 = I.ret(closes, 20);
  const ret60 = I.ret(closes, 60);
  const ret120 = I.ret(closes, 120);
  const hi52 = I.highest(highs, Math.min(252, closes.length));
  const lo52 = I.lowest(lows, Math.min(252, closes.length));
  const distHigh = hi52 ? ((price - hi52) / hi52) * 100 : null;
  const volRatio = vma20[n] ? vma5[n] / vma20[n] : null;
  const atrPct = price && atr[n] ? (atr[n] / price) * 100 : null;
  const vol = I.volatility(closes, 60);
  const lastBar = bars[n];
  const prevBar = bars[n - 1] || lastBar;
  const dayChange = prevBar.close ? ((lastBar.close - prevBar.close) / prevBar.close) * 100 : null;
  const bull = lastBar.close >= lastBar.open;

  // ---------------- 因子打分
  // 1. 动量：20/60 日收益为主，过热(>40%)与深跌(<-25%)都惩罚
  let momentum = 0;
  momentum += mapRange(ret20, -10, 18) * 14;
  momentum += mapRange(ret60, -15, 30) * 8;
  momentum += mapRange(ret120, -20, 50) * 3;
  if (ret20 != null && ret20 > 40) momentum -= (ret20 - 40) * 0.25; // 过热惩罚
  if (ret20 != null && ret20 < -25) momentum -= 4; // 下跌趋势惩罚
  momentum = clamp(momentum, 0, 25);

  // 2. 趋势：均线多头排列 + MACD 状态
  let trend = 0;
  if (ma20[n] && price > ma20[n]) trend += 5;
  if (ma60[n] && price > ma60[n]) trend += 6;
  if (ma120[n] && price > ma120[n]) trend += 4;
  if (ma5[n] && ma20[n] && ma5[n] > ma20[n]) trend += 4;
  if (ma20[n] && ma60[n] && ma20[n] > ma60[n]) trend += 3;
  if (macd.hist[n] != null && macd.hist[n] > 0) trend += 3;
  if (macd.hist[n] != null && macd.hist[n - 1] != null && macd.hist[n] > macd.hist[n - 1]) trend += 2;
  trend = clamp(trend, 0, 25);

  // 3. 均值回归：RSI 40-62 为"健康强势区"，<32 记超卖反弹，>76 记过热
  let reversion = 0;
  const r = rsi[n];
  if (r != null) {
    if (r >= 40 && r <= 62) reversion = 15;
    else if (r < 40) reversion = mapRange(r, 15, 40) * 15;
    else reversion = mapRange(r, 62, 85) * 15;
    if (r > 78) reversion -= 5;
    if (r < 25) reversion += 2; // 极度超卖，反弹赔率高
  }
  reversion = clamp(reversion, 0, 15);

  // 4. 量能：温和放量为佳，爆量(>4x)反而提示分歧
  let volume = 0;
  if (volRatio != null) {
    volume = mapRange(volRatio, 0.7, 2.0) * 12;
    if (volRatio > 4) volume -= 3;
    if (dayChange != null && dayChange > 2 && volRatio > 1.3) volume += 3; // 放量上涨
    if (dayChange != null && dayChange < -2 && volRatio > 1.5) volume -= 3; // 放量下跌
  }
  volume = clamp(volume, 0, 15);

  // 5. 波动：ATR% 2%~6% 为最佳交易区间
  let volScore = 0;
  if (atrPct != null) {
    if (atrPct >= 2 && atrPct <= 6) volScore = 10;
    else if (atrPct < 2) volScore = mapRange(atrPct, 0.3, 2) * 10;
    else volScore = mapRange(atrPct, 6, 15) * 10;
  }
  volScore = clamp(volScore, 0, 10);

  // 6. 位置：贴近高点(>-3%)给高分，深度回撤(-30%以下)减分
  let position = 0;
  if (distHigh != null) {
    if (distHigh > -3) position = 10;
    else if (distHigh > -15) position = 8;
    else if (distHigh > -30) position = 5;
    else position = mapRange(distHigh, -70, -30) * 5;
  }
  position = clamp(position, 0, 10);

  const total = momentum + trend + reversion + volume + volScore + position;

  // ---------------- 信号识别
  const signals = [];
  const c1 = I.cross(macd.dif, macd.dea);
  if (c1 === 1) signals.push({ text: 'MACD金叉', type: 'bull' });
  if (c1 === -1) signals.push({ text: 'MACD死叉', type: 'bear' });
  if (ma5[n] && ma20[n] && I.cross(ma5, ma20) === 1) signals.push({ text: '均线金叉', type: 'bull' });
  if (ma5[n] && ma20[n] && I.cross(ma5, ma20) === -1) signals.push({ text: '均线死叉', type: 'bear' });
  if (ma5[n] && ma20[n] && ma60[n] && ma5[n] > ma20[n] && ma20[n] > ma60[n])
    signals.push({ text: '多头排列', type: 'bull' });
  if (ma5[n] && ma20[n] && ma60[n] && ma5[n] < ma20[n] && ma20[n] < ma60[n])
    signals.push({ text: '空头排列', type: 'bear' });
  if (volRatio != null && volRatio > 1.8 && dayChange != null && dayChange > 3)
    signals.push({ text: '放量突破', type: 'bull' });
  if (volRatio != null && volRatio > 1.5 && dayChange != null && dayChange < -3)
    signals.push({ text: '放量下跌', type: 'bear' });
  if (r != null && r < 30) signals.push({ text: 'RSI超卖', type: 'bull' });
  if (r != null && r > 75) signals.push({ text: 'RSI超买', type: 'bear' });
  if (boll.lower[n] != null && closes[n - 1] < boll.lower[n - 1] && closes[n] > boll.lower[n])
    signals.push({ text: '布林下轨反弹', type: 'bull' });
  if (boll.upper[n] != null && closes[n] > boll.upper[n]) signals.push({ text: '突破布林上轨', type: 'warn' });
  if (kd.k[n] != null && kd.d[n] != null && I.cross(kd.k, kd.d) === 1 && kd.k[n] < 40)
    signals.push({ text: 'KDJ低位金叉', type: 'bull' });
  if (distHigh != null && distHigh > -1) signals.push({ text: '创阶段新高', type: 'bull' });
  if (ma60[n] && closes[n - 1] <= ma60[n - 1] && closes[n] > ma60[n])
    signals.push({ text: '站上60日线', type: 'bull' });
  if (ma60[n] && closes[n - 1] >= ma60[n - 1] && closes[n] < ma60[n])
    signals.push({ text: '跌破60日线', type: 'bear' });
  if (ret20 != null && ret20 > 40) signals.push({ text: '短期涨幅过大', type: 'warn' });
  if (ret20 != null && ret20 < -30) signals.push({ text: '中期弱势', type: 'bear' });

  const bullCount = signals.filter((s) => s.type === 'bull').length;
  const bearCount = signals.filter((s) => s.type === 'bear').length;

  return {
    price,
    changePct: quote?.changePct ?? dayChange,
    score: Math.round(total * 10) / 10,
    factors: {
      momentum: Math.round(momentum * 10) / 10,
      trend: Math.round(trend * 10) / 10,
      reversion: Math.round(reversion * 10) / 10,
      volume: Math.round(volume * 10) / 10,
      volatility: Math.round(volScore * 10) / 10,
      position: Math.round(position * 10) / 10,
    },
    signals,
    bullCount,
    bearCount,
    metrics: {
      rsi: r,
      ma5: ma5[n],
      ma10: ma10[n],
      ma20: ma20[n],
      ma60: ma60[n],
      ma120: ma120[n],
      macdHist: macd.hist[n],
      dif: macd.dif[n],
      dea: macd.dea[n],
      kdjK: kd.k[n],
      kdjD: kd.d[n],
      bollUp: boll.upper[n],
      bollLow: boll.lower[n],
      atr: atr[n],
      atrPct,
      ret5,
      ret20,
      ret60,
      ret120,
      volRatio,
      distHigh,
      volatility: vol,
      hi52,
      lo52,
    },
  };
}

/** 综合评级 */
function rating(score) {
  if (score >= 78) return { label: '强烈看多', cls: 'r1' };
  if (score >= 66) return { label: '看多', cls: 'r2' };
  if (score >= 52) return { label: '中性偏多', cls: 'r3' };
  if (score >= 40) return { label: '中性', cls: 'r4' };
  if (score >= 28) return { label: '偏弱', cls: 'r5' };
  return { label: '回避', cls: 'r6' };
}

module.exports = { analyze, rating, clamp, mapRange };
