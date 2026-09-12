/**
 * tradeplan.js —— 推荐买入区间 / 卖出区间 / 止损 / 仓位
 *
 * 设计原则：区间不是拍出来的，每一档都必须能指到"为什么在这里"。
 * 买入区间 = 前支撑 ∪ 均线支撑 ∪ 布林中轨 ∪ ATR 回调带宽，取交集密度最高的一段；
 * 卖出区间 = 上方压力 ∪ ATR 目标位 ∪ 斐波那契扩展，分三档按 40/35/25 减仓；
 * 止损 = 买区下沿再退一个 ATR，且必须落在第二支撑下方或 -4%~-18% 之间。
 *
 * 所有价格均以美股「不复权 / 前复权」K线为基准，不构成投资建议。
 */
const Levels = require('./levels');
const Factors = require('./factors');
const I = require('./indicators');

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function r2(v) {
  return v == null || !isFinite(v) ? null : Math.round(v * 100) / 100;
}

function pctOf(a, b) {
  if (a == null || b == null || !b) return null;
  return Math.round(((a - b) / b) * 10000) / 100;
}

function plan(bars, opts = {}) {
  if (!bars || bars.length < 60) return null;
  const quote = opts.quote || null;
  const ppy = opts.ppy || 252;
  const unit = opts.unit || '日';
  const levels = opts.levels || Levels.compute(bars, {});
  if (!levels) return null;
  const f = opts.factors || Factors.analyze(bars, quote, ppy);

  const n = bars.length - 1;
  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);

  let price = quote && quote.price ? quote.price : levels.price;
  const lastClose = bars[n].close;
  // 行情与K线严重背离时（如数据源串了标的）以K线为准，避免算出"现价 147、MA60 227"这类自相矛盾的区间
  if (lastClose && Math.abs(price / lastClose - 1) > 0.2) price = lastClose;
  const atr = levels.atr || price * 0.02;
  const atrPct = (atr / price) * 100;

  const ma20 = I.sma(closes, 20)[n];
  const ma60 = I.sma(closes, 60)[n];
  const ma120 = I.sma(closes, 120)[n];
  const ma200 = closes.length >= 200 ? I.sma(closes, 200)[n] : null;
  const boll = I.boll(closes, 20, 2);
  const bollMid = boll.mid[n];
  const bollLow = boll.lower[n];
  const rsi = I.rsi(closes, 14)[n];
  const score = f ? f.score : 50;

  // ---------------------------------------------------------------- 买入区间
  // 候选支撑：每个候选带上"这个位置有多硬"的权重
  const cands = [];
  const push = (p, tag, weight) => {
    if (p == null || !isFinite(p) || p <= 0) return;
    if (p > price * 0.995 || p < price * 0.80) return; // 只取现价下方 0.5%~20% 的候选
    cands.push({ price: p, tag, weight });
  };
  levels.supports.forEach((s, i) => {
    if (i > 2) return;
    push(s.price, `前${i === 0 ? '支撑' : '低点'} ${r2(s.price)}`, 3.2 - i * 0.7 + Math.min(1.6, s.strength / 6));
  });
  push(ma20, 'MA20', 2.2);
  push(ma60, 'MA60', 2.6);
  push(ma120, 'MA120', 2.4);
  push(ma200, 'MA200', 2.8);
  push(bollMid, '布林中轨', 1.6);
  push(bollLow, '布林下轨', 1.4);

  const conf = cands.length ? Math.max(...cands.map((c) => c.weight)) : 0;
  const dense = cands.filter((c) => c.weight >= conf * 0.62);

  let buyHigh;
  let buyLow;
  let buyBasis;
  let quality;

  if (dense.length) {
    const top = dense.reduce((a, b) => (b.price > a.price ? b : a));
    const bot = dense.reduce((a, b) => (b.price < a.price ? b : a));
    // 上沿不追高：不超过现价 -0.45 ATR，也不高于最近支撑 1.6%
    buyHigh = Math.min(top.price * 1.016, price - 0.45 * atr);
    // 下沿留出波动空间，但不超过现价下方 15%
    buyLow = Math.max(bot.price - 0.55 * atr, price * 0.85, price - 3.4 * atr);
    buyBasis = [...new Set(dense.map((c) => c.tag))];
    quality = conf >= 4 ? 'high' : conf >= 2.8 ? 'mid' : 'low';
  } else {
    // 没有任何近端支撑 → 只能用 ATR 回调带，且明确标注"无支撑依托"
    buyHigh = price - 0.9 * atr;
    buyLow = Math.max(price * 0.85, price - 3.1 * atr);
    buyBasis = [`ATR 回调带（下方无近端支撑）`];
    quality = 'low';
  }

  if (buyLow > buyHigh) {
    const mid = (buyLow + buyHigh) / 2;
    buyLow = mid * 0.985;
    buyHigh = mid * 1.015;
  }
  buyLow = r2(buyLow);
  buyHigh = r2(buyHigh);
  const buyRef = r2((buyLow + buyHigh) / 2);

  // 是否在追高：现价明显高于买区上沿
  const chaseGap = ((price - buyHigh) / buyHigh) * 100;
  const chase = chaseGap > 4.5;

  // 分批：上沿 40% / 中枢 35% / 下沿 25%
  const tranches = [
    { label: '首笔（试探）', price: r2(buyHigh * 0.998), weight: 40 },
    { label: '第二笔（确认）', price: buyRef, weight: 35 },
    { label: '第三笔（跌破后回补）', price: r2(buyLow * 1.002), weight: 25 },
  ];

  // ---------------------------------------------------------------- 卖出区间
  const res = levels.resistances;
  const ext127 = levels.fib && levels.fib.lo != null ? levels.fib.lo + (levels.fib.hi - levels.fib.lo) * 1.272 : null;
  const ext161 = levels.fib && levels.fib.lo != null ? levels.fib.lo + (levels.fib.hi - levels.fib.lo) * 1.618 : null;

  const tCands = [];
  if (res[0]) tCands.push({ price: res[0].price, tag: `压力位 ${r2(res[0].price)}` });
  if (res[1]) tCands.push({ price: res[1].price, tag: `压力位 ${r2(res[1].price)}` });
  if (res[2]) tCands.push({ price: res[2].price, tag: `压力位 ${r2(res[2].price)}` });
  tCands.push({ price: price + 2.0 * atr, tag: '2×ATR 目标' });
  tCands.push({ price: price + 4.0 * atr, tag: '4×ATR 目标' });
  tCands.push({ price: price + 6.5 * atr, tag: '6.5×ATR 目标' });
  if (ext127) tCands.push({ price: ext127, tag: '斐波 1.272 扩展' });
  if (ext161) tCands.push({ price: ext161, tag: '斐波 1.618 扩展' });
  if (levels.swingHigh) tCands.push({ price: levels.swingHigh, tag: '区间高点' });

  const tSorted = [...new Set(tCands.map((t) => Math.round(t.price * 100)))]
    .map((k) => {
      const v = k / 100;
      const hit = tCands.filter((t) => Math.round(t.price * 100) === k).map((t) => t.tag);
      return { price: v, tags: hit };
    })
    .filter((t) => t.price > price * 1.025)
    .sort((a, b) => a.price - b.price);

  const picked = [];
  for (const t of tSorted) {
    if (picked.length >= 3) break;
    const last = picked[picked.length - 1];
    // 相邻目标至少拉开 0.9 ATR，避免三档挤在一起
    if (last && t.price - last.price < atr * 0.9) continue;
    picked.push(t);
  }
  while (picked.length < 3) {
    const base = picked.length ? picked[picked.length - 1].price : price;
    picked.push({ price: base + 2.2 * atr, tags: ['ATR 推算'] });
  }

  const T = picked.map((p, i) => ({
    label: `T${i + 1}`,
    price: r2(p.price),
    gainPct: pctOf(p.price, price),
    weight: [40, 35, 25][i],
    basis: p.tags.join(' / '),
  }));

  const sellLow = T[0].price;
  const sellHigh = T[1].price;
  const sellQuality = res.length >= 2 ? 'high' : res.length === 1 ? 'mid' : 'low';

  // ---------------------------------------------------------------- 止损
  const s2 = levels.supports[1];
  let stop = buyLow - 1.05 * atr;
  if (s2 && s2.price < buyLow) stop = Math.min(stop, s2.price - 0.5 * atr);
  // 兜底：止损不能太紧（<4%）也不能太松（>18%）
  stop = Math.min(stop, buyRef * 0.96);
  stop = Math.max(stop, buyRef * 0.82);
  stop = r2(stop);
  const stopPct = pctOf(stop, buyRef);

  // ---------------------------------------------------------------- 盈亏比 / 仓位
  const rr = stopPct && T[1].price ? Math.round(((T[1].price - buyRef) / (buyRef - stop)) * 100) / 100 : null;
  const rrT1 = stopPct && T[0].price ? Math.round(((T[0].price - buyRef) / (buyRef - stop)) * 100) / 100 : null;

  const riskPerTrade = 1; // 单笔最大亏损 = 本金的 1%
  const rawPos = stopPct ? (riskPerTrade / Math.abs(stopPct)) * 100 : 10;
  const conviction = clamp(0.55 + (score / 100) * 0.9, 0.55, 1.25);
  const posPct = clamp(Math.round(rawPos * conviction), 2, 25);

  // ---------------------------------------------------------------- 当前动作
  let action;
  if (price >= sellLow) {
    action = {
      label: '已进入卖出区间',
      tone: 'down',
      text: `现价 ${r2(price)} 已触及 T1 ${T[0].price}，建议按 40%/35%/25% 分三档减仓，剩余仓位止损上移到成本价。`,
    };
  } else if (price > buyHigh) {
    action = {
      label: chase ? '追高风险偏高' : '等待回落',
      tone: chase ? 'warn' : 'flat',
      text: chase
        ? `现价高于买区上沿 ${chaseGap.toFixed(1)}%，短期追入性价比低。${
            T[0].price ? `要么等回落到 ${buyLow}–${buyHigh}，要么等站稳 ${T[0].price} 后右侧跟进。` : ''
          }`
        : `现价距买区上沿仅 ${chaseGap.toFixed(1)}%，可小仓试探，回落至 ${buyRef} 附近再加。`,
    };
  } else if (price >= buyLow) {
    action = {
      label: '处于买入区间',
      tone: 'up',
      text: `现价落在推荐买入区间 ${buyLow}–${buyHigh} 内，可按 ${tranches[0].weight}%/${tranches[1].weight}%/${tranches[2].weight}% 分批建仓，止损 ${stop}（${stopPct}%）。`,
    };
  } else {
    action = {
      label: '跌破买区下沿',
      tone: 'down',
      text: `现价已跌破 ${buyLow}，若之后 2 根K线不能收回该位置，说明支撑失效，切勿补仓摊薄。`,
    };
  }

  // ---------------------------------------------------------------- 触发条件
  const entry = [];
  entry.push(`日线收在 ${buyHigh} 之下、且缩量（量比 < 1.2）时，执行首笔`);
  if (ma20 && ma20 > buyLow && ma20 < buyHigh) entry.push(`回踩 MA20（${r2(ma20)}）不破是较优的加仓点`);
  entry.push(`RSI 回落至 ${rsi && rsi > 60 ? '50–60' : '35–50'} 区间时买入胜率更高`);
  if (chase) entry.push(`若放量突破 ${T[0].price} 并收在其上，可改为右侧小仓跟进`);

  const exit = [];
  exit.push(`触及 T1 ${T[0].price}（${T[0].gainPct}%）减 40%`);
  exit.push(`触及 T2 ${T[1].price}（${T[1].gainPct}%）再减 35%`);
  exit.push(`触及 T3 ${T[2].price}（${T[2].gainPct}%）清仓或留 25% 趋势仓`);
  if (rsi != null && rsi > 75) exit.push('RSI 已进超买区（>75），可提前减仓一半');

  const invalidate = [];
  invalidate.push(`收盘跌破 ${stop}（相对买区中枢 ${stopPct}%）→ 观点失效，无条件离场`);
  if (levels.nearestSupport) invalidate.push(`跌破 ${levels.nearestSupport.price} 且次日不能收回 → 支撑转压力`);
  if (levels.swingLow) invalidate.push(`跌破区间低点 ${levels.swingLow} → 中期趋势走坏`);

  // ---------------------------------------------------------------- 持有周期
  const horizon = atrPct > 6 ? '1–3 周（高波动，宜短打）' : atrPct > 3.5 ? '2–6 周' : '1–3 个月（低波动，适合波段持有）';

  // ---------------------------------------------------------------- 结论
  const stance =
    score >= 66 && price >= buyLow && price <= sellLow
      ? { label: '偏多 · 可分批建仓', tone: 'up' }
      : score >= 52
        ? { label: '中性偏多 · 等回调', tone: 'flat' }
        : score >= 40
          ? { label: '中性 · 区间对待', tone: 'flat' }
          : { label: '偏弱 · 以防守为主', tone: 'down' };

  return {
    price: r2(price),
    atr: r2(atr),
    atrPct: Math.round(atrPct * 100) / 100,
    buy: {
      low: buyLow,
      high: buyHigh,
      ref: buyRef,
      widthPct: pctOf(buyHigh, buyLow),
      quality,
      basis: buyBasis,
      tranches,
      chaseGapPct: Math.round(chaseGap * 100) / 100,
      chasing: chase,
    },
    sell: {
      low: sellLow,
      high: sellHigh,
      quality: sellQuality,
      targets: T,
      basis: [...new Set(picked.flatMap((p) => p.tags))].slice(0, 4),
    },
    stop: {
      price: stop,
      pct: stopPct,
      riskPerShare: r2(buyRef - stop),
      basis: s2 && s2.price < buyLow ? `买区下沿 ${buyLow} 再退 1×ATR，且位于第二支撑 ${r2(s2.price)} 下方` : `买区下沿 ${buyLow} 再退 1×ATR`,
    },
    rr,
    rrT1,
    position: {
      pct: posPct,
      riskPerTrade,
      note: `按单笔风险 ${riskPerTrade}% 本金、止损 ${Math.abs(stopPct)}% 反推，建议最大仓位 ${posPct}% 资金`,
    },
    action,
    triggers: { entry, exit, invalidate },
    horizon,
    stance,
    levels,
    disclaimer: '区间由历史量价统计推得，非投资建议；美股无涨跌停限制，跳空风险需自行控制仓位。',
  };
}

module.exports = { plan };
