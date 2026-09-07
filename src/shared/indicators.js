/**
 * indicators.js —— 技术指标（纯函数，无依赖，主进程与渲染层共用）
 *
 * 约定：所有序列按时间正序（旧 → 新），长度不足的位置用 null 填充，
 * 这样调用方可以直接按下标对齐画图，不用自己算偏移。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Indicators = api;
})(typeof self !== 'undefined' ? self : this, function () {
  function fill(n) {
    return new Array(n).fill(null);
  }

  /** 简单移动平均 */
  function sma(values, n) {
    const out = fill(values.length);
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= n) sum -= values[i - n];
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  }

  /** 指数移动平均（首值用 SMA 播种，与主流行情软件一致） */
  function ema(values, n) {
    const out = fill(values.length);
    if (values.length < n) return out;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += values[i];
    let prev = sum / n;
    out[n - 1] = prev;
    const k = 2 / (n + 1);
    for (let i = n; i < values.length; i++) {
      prev = values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  /** MACD：返回 { dif, dea, hist }，hist = (dif - dea) * 2 */
  function macd(closes, fast = 12, slow = 26, signal = 9) {
    const ef = ema(closes, fast);
    const es = ema(closes, slow);
    const dif = closes.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
    const validStart = dif.findIndex((v) => v != null);
    const difSlice = dif.slice(validStart);
    const deaSlice = ema(difSlice, signal);
    const dea = fill(closes.length);
    for (let i = 0; i < deaSlice.length; i++) dea[validStart + i] = deaSlice[i];
    const hist = closes.map((_, i) => (dif[i] != null && dea[i] != null ? (dif[i] - dea[i]) * 2 : null));
    return { dif, dea, hist };
  }

  /** RSI（Wilder 平滑） */
  function rsi(closes, n = 14) {
    const out = fill(closes.length);
    if (closes.length <= n) return out;
    let gain = 0;
    let loss = 0;
    for (let i = 1; i <= n; i++) {
      const d = closes[i] - closes[i - 1];
      if (d >= 0) gain += d;
      else loss -= d;
    }
    let ag = gain / n;
    let al = loss / n;
    out[n] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    for (let i = n + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      const g = d > 0 ? d : 0;
      const l = d < 0 ? -d : 0;
      ag = (ag * (n - 1) + g) / n;
      al = (al * (n - 1) + l) / n;
      out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    }
    return out;
  }

  /** 布林带 */
  function boll(closes, n = 20, k = 2) {
    const mid = sma(closes, n);
    const upper = fill(closes.length);
    const lower = fill(closes.length);
    for (let i = n - 1; i < closes.length; i++) {
      let sum = 0;
      for (let j = i - n + 1; j <= i; j++) sum += (closes[j] - mid[i]) ** 2;
      const sd = Math.sqrt(sum / n);
      upper[i] = mid[i] + k * sd;
      lower[i] = mid[i] - k * sd;
    }
    return { mid, upper, lower };
  }

  /** KDJ(9,3,3) */
  function kdj(highs, lows, closes, n = 9, m1 = 3, m2 = 3) {
    const rsv = fill(closes.length);
    for (let i = n - 1; i < closes.length; i++) {
      let hh = -Infinity;
      let ll = Infinity;
      for (let j = i - n + 1; j <= i; j++) {
        if (highs[j] > hh) hh = highs[j];
        if (lows[j] < ll) ll = lows[j];
      }
      rsv[i] = hh === ll ? 50 : ((closes[i] - ll) / (hh - ll)) * 100;
    }
    const k = fill(closes.length);
    const d = fill(closes.length);
    const j = fill(closes.length);
    let pk = 50;
    let pd = 50;
    for (let i = 0; i < closes.length; i++) {
      if (rsv[i] == null) continue;
      pk = (m1 - 1) / m1 * pk + (1 / m1) * rsv[i];
      pd = (m2 - 1) / m2 * pd + (1 / m2) * pk;
      k[i] = pk;
      d[i] = pd;
      j[i] = 3 * pk - 2 * pd;
    }
    return { k, d, j };
  }

  /** ATR（真实波幅均值） */
  function atr(highs, lows, closes, n = 14) {
    const tr = fill(closes.length);
    for (let i = 0; i < closes.length; i++) {
      if (i === 0) tr[i] = highs[i] - lows[i];
      else {
        tr[i] = Math.max(
          highs[i] - lows[i],
          Math.abs(highs[i] - closes[i - 1]),
          Math.abs(lows[i] - closes[i - 1])
        );
      }
    }
    return sma(tr, n);
  }

  /** 量能均线 */
  function volMa(volumes, n) {
    return sma(volumes, n);
  }

  /** 区间收益率：n 个交易日前的收盘 → 最新收盘 */
  function ret(closes, n) {
    if (closes.length <= n) return null;
    const a = closes[closes.length - 1 - n];
    const b = closes[closes.length - 1];
    if (!a) return null;
    return ((b - a) / a) * 100;
  }

  /** 最近 n 日最高 / 最低 */
  function highest(values, n) {
    const s = values.slice(Math.max(0, values.length - n));
    return s.length ? Math.max(...s) : null;
  }
  function lowest(values, n) {
    const s = values.slice(Math.max(0, values.length - n));
    return s.length ? Math.min(...s) : null;
  }

  /** 金叉 / 死叉判定（只看最后两根） */
  function cross(fast, slow) {
    const n = fast.length;
    if (n < 2 || fast[n - 1] == null || slow[n - 1] == null || fast[n - 2] == null || slow[n - 2] == null)
      return 0;
    if (fast[n - 2] <= slow[n - 2] && fast[n - 1] > slow[n - 1]) return 1; // 金叉
    if (fast[n - 2] >= slow[n - 2] && fast[n - 1] < slow[n - 1]) return -1; // 死叉
    return 0;
  }

  /** 年化波动率（日收益标准差 × √252） */
  function volatility(closes, n = 60) {
    if (closes.length < n + 1) return null;
    const rs = [];
    for (let i = closes.length - n; i < closes.length; i++) {
      rs.push(Math.log(closes[i] / closes[i - 1]));
    }
    const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
    const varr = rs.reduce((a, b) => a + (b - mean) ** 2, 0) / (rs.length - 1);
    return Math.sqrt(varr * 252) * 100;
  }

  return { sma, ema, macd, rsi, boll, kdj, atr, volMa, ret, highest, lowest, cross, volatility };
});
