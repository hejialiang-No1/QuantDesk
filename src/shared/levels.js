/**
 * levels.js —— 支撑位 / 压力位识别
 *
 * 三种方法融合，互为印证：
 *   1) 摆动点聚类（swing pivot clustering）—— 真实发生过的转折区，最可靠
 *   2) 经典枢轴点（Pivot Points）—— 由前一日 OHLC 推出的七档日内关键位
 *   3) 斐波那契回撤 —— 反映区间内的成本与技术共识
 *   4) 整数关口 —— 美股期权行权价密集区，天然具备磁吸效应
 *
 * 约定：bars 为时间正序数组，元素形如 {date, open, close, high, low, volume}。
 */
const I = require('./indicators');

const DEFAULTS = {
  swing: 5,        // 摆动点左右各比较的根数
  maxLevels: 6,    // 每侧最多输出几档
  fibLen: 120,     // 斐波那契取样区间
  lookback: 260,   // 摆动点扫描范围（约一年）
};

/** 找局部极值点：左右各 k 根都不超过/不低于它 */
function swingPivots(bars, k, lookback) {
  const from = Math.max(k, bars.length - lookback);
  const to = bars.length - k;
  const highs = [];
  const lows = [];
  for (let i = from; i < to; i++) {
    let isHigh = true;
    let isLow = true;
    const hi = bars[i].high;
    const lo = bars[i].low;
    if (hi == null || lo == null) continue;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      const h = bars[j].high;
      const l = bars[j].low;
      if (h == null || l == null) continue;
      if (h >= hi) isHigh = false;
      if (l <= lo) isLow = false;
      if (!isHigh && !isLow) break;
    }
    // 越靠近当前的转折点权重越高（最近 3 个月内不衰减）
    const recency = 0.55 + 0.45 * Math.min(1, (i - from) / Math.max(1, bars.length * 0.25));
    if (isHigh) highs.push({ price: hi, index: i, date: bars[i].date, recency });
    if (isLow) lows.push({ price: lo, index: i, date: bars[i].date, recency });
  }
  return { highs, lows };
}

/** 价格聚类：把彼此靠近的转折点合并成一档支撑/压力 */
function cluster(points, tol) {
  if (!points.length) return [];
  const sorted = points.slice().sort((a, b) => a.price - b.price);
  const groups = [];
  let cur = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const anchor = cur.reduce((s, p) => s + p.price * p.recency, 0) / cur.reduce((s, p) => s + p.recency, 0);
    if (Math.abs(sorted[i].price - anchor) <= tol) cur.push(sorted[i]);
    else {
      groups.push(cur);
      cur = [sorted[i]];
    }
  }
  groups.push(cur);

  return groups.map((g) => {
    const wsum = g.reduce((s, p) => s + p.recency, 0);
    const price = g.reduce((s, p) => s + p.price * p.recency, 0) / wsum;
    const spread = Math.max(...g.map((p) => p.price)) - Math.min(...g.map((p) => p.price));
    return {
      price,
      touches: g.length,
      strength: Math.round(wsum * 10) / 10,
      lastIndex: Math.max(...g.map((p) => p.index)),
      spread,
      tol,
    };
  });
}

/** 整数关口：按价格量级自适应步长 */
function roundLevels(price) {
  if (!price || !isFinite(price)) return [];
  const mag = Math.pow(10, Math.max(0, Math.floor(Math.log10(Math.abs(price))) - 1));
  const step = price < 100 ? mag * 5 : mag;
  const out = [];
  for (let k = -3; k <= 3; k++) {
    const p = Math.round(price / step + k) * step;
    if (p > 0) out.push({ price: p, step });
  }
  return out;
}

/** 经典枢轴点（由前一根 K 线 OHLC 推出） */
function pivotPoints(bar) {
  if (!bar) return null;
  const H = bar.high;
  const L = bar.low;
  const C = bar.close;
  if (H == null || L == null || C == null) return null;
  const P = (H + L + C) / 3;
  return {
    P,
    R1: 2 * P - L,
    S1: 2 * P - H,
    R2: P + (H - L),
    S2: P - (H - L),
    R3: H + 2 * (P - L),
    S3: L - 2 * (H - P),
  };
}

/** 斐波那契回撤（区间内高点到低点） */
function fibonacci(bars, len) {
  const seg = bars.slice(Math.max(0, bars.length - len));
  if (seg.length < 10) return { hi: null, lo: null, levels: [] };
  const hi = Math.max(...seg.map((b) => b.high));
  const lo = Math.min(...seg.map((b) => b.low));
  const range = hi - lo;
  const ratios = [0.236, 0.382, 0.5, 0.618, 0.786];
  return {
    hi,
    lo,
    range,
    levels: ratios.map((r) => ({ ratio: r, price: hi - range * r })),
  };
}

/**
 * @param {Array} bars 时间正序 K 线
 * @param {Object} opts { price, swing, maxLevels, fibLen, lookback }
 */
function compute(bars, opts = {}) {
  if (!bars || bars.length < 25) return null;
  const o = { ...DEFAULTS, ...opts };
  const n = bars.length - 1;
  const price = opts.price != null && isFinite(opts.price) ? opts.price : bars[n].close;
  if (!price) return null;

  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const closes = bars.map((b) => b.close);
  const atrArr = I.atr(highs, lows, closes, 14);
  const atr = atrArr[n] || price * 0.02;

  const tol = Math.max(atr * 0.75, price * 0.009);

  const piv = swingPivots(bars, o.swing, o.lookback);
  const highsC = cluster(piv.highs, tol);
  const lowsC = cluster(piv.lows, tol);

  const fib = fibonacci(bars, o.fibLen);
  const pivot = pivotPoints(bars[n]);

  // 汇总所有候选位（含来源标签），合并后再按价格排序
  const pool = [];
  for (const c of lowsC) pool.push({ ...c, kind: 'swing', kindLabel: '前低' });
  for (const c of highsC) pool.push({ ...c, kind: 'swing', kindLabel: '前高' });
  for (const f of fib.levels) {
    pool.push({ price: f.price, touches: 1, strength: 0.9 + (1 - Math.abs(f.ratio - 0.5)) * 0.3, lastIndex: n, spread: 0, kind: 'fib', kindLabel: `斐波 ${f.ratio}` });
  }
  if (pivot) {
    for (const [k, v] of Object.entries(pivot)) {
      if (k === 'P') continue;
      pool.push({ price: v, touches: 1, strength: 1.0, lastIndex: n, spread: 0, kind: 'pivot', kindLabel: `枢轴 ${k}` });
    }
  }
  for (const r of roundLevels(price)) {
    pool.push({ price: r.price, touches: 1, strength: 0.7, lastIndex: n, spread: 0, kind: 'round', kindLabel: '整数关口' });
  }

  // 真·合并：把不同来源但价格相近的融成一档，strength 叠加
  const merged = [];
  for (const p of pool.slice().sort((a, b) => a.price - b.price)) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(p.price - last.price) <= tol * 0.85) {
      last.sources.push(p.kindLabel);
      last.strength += p.strength;
      last.touches = Math.max(last.touches, p.touches);
      last.price = (last.price * (last.strength - p.strength) + p.price * p.strength) / last.strength;
      last.spread = Math.max(last.spread, Math.abs(p.price - last.price));
    } else {
      merged.push({
        price: p.price,
        touches: p.touches,
        strength: p.strength,
        spread: p.spread || 0,
        lastIndex: p.lastIndex,
        sources: [p.kindLabel],
      });
    }
  }

  const norm = (arr) =>
    arr
      .map((m) => ({
        price: Math.round(m.price * 100) / 100,
        strength: Math.round(m.strength * 10) / 10,
        touches: m.touches,
        sources: [...new Set(m.sources)],
        distancePct: Math.round(((m.price - price) / price) * 1000) / 10,
      }))
      .sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price));

  const supports = norm(merged.filter((m) => m.price < price * 0.998)).slice(0, o.maxLevels);
  const resistances = norm(merged.filter((m) => m.price > price * 1.002)).slice(0, o.maxLevels);

  // 支撑按由近到远排序后，strength 做一次排序以突出"最硬"的那一档
  const strongestSupport = supports.slice().sort((a, b) => b.strength - a.strength)[0] || null;
  const strongestResistance = resistances.slice().sort((a, b) => b.strength - a.strength)[0] || null;

  return {
    price,
    atr,
    atrPct: Math.round((atr / price) * 10000) / 100,
    tol: Math.round(tol * 100) / 100,
    supports,
    resistances,
    nearestSupport: supports[0] || null,
    nearestResistance: resistances[0] || null,
    strongestSupport,
    strongestResistance,
    pivot: pivot
      ? Object.fromEntries(Object.entries(pivot).map(([k, v]) => [k, Math.round(v * 100) / 100]))
      : null,
    fib: {
      hi: fib.hi != null ? Math.round(fib.hi * 100) / 100 : null,
      lo: fib.lo != null ? Math.round(fib.lo * 100) / 100 : null,
      levels: fib.levels.map((f) => ({ ratio: f.ratio, price: Math.round(f.price * 100) / 100 })),
    },
    swingHigh: highsC.length ? Math.round(Math.max(...highsC.map((c) => c.price)) * 100) / 100 : null,
    swingLow: lowsC.length ? Math.round(Math.min(...lowsC.map((c) => c.price)) * 100) / 100 : null,
    verdict: describe(price, supports, resistances, atr),
  };
}

function describe(price, supports, resistances, atr) {
  const s = supports[0];
  const r = resistances[0];
  if (!s && !r) return { label: '区间待确认', tone: 'flat', text: '历史转折点不足，暂无法给出可靠的支撑压力区间。' };
  const bits = [];
  if (s) bits.push(`下方 ${s.price} 为主要支撑（距现价 ${s.distancePct}%，来源：${s.sources.slice(0, 2).join('/')}）`);
  if (r) bits.push(`上方 ${r.price} 为主要压力（距现价 +${r.distancePct}%，来源：${r.sources.slice(0, 2).join('/')}）`);
  let tone = 'flat';
  let label = '区间震荡';
  if (s && r) {
    const roomUp = (r.price - price) / atr;
    const roomDown = (price - s.price) / atr;
    if (roomUp > roomDown * 1.8) {
      tone = 'up';
      label = '上行空间占优';
    } else if (roomDown > roomUp * 1.8) {
      tone = 'down';
      label = '下行压力占优';
    } else {
      label = '上下空间均衡';
    }
  } else if (r) {
    tone = 'up';
    label = '上方无近压';
  } else if (s) {
    tone = 'down';
    label = '下方无近撑';
  }
  return { label, tone, text: bits.join('；') + '。' };
}

module.exports = { compute, swingPivots, cluster, pivotPoints, fibonacci, roundLevels };
