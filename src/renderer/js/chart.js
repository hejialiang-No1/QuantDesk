/**
 * chart.js —— Canvas 图表引擎（K线 / 成交量 / 副图指标 / 权益曲线）
 * 纯手写，不依赖任何图表库。支持高 DPI、十字光标、滚轮缩放、拖拽平移。
 */
(function () {
  const C = {
    up: '#f6465d',      // 涨：红
    down: '#0ecb81',    // 跌：绿
    flat: '#7c8aa5',
    grid: 'rgba(255,255,255,.045)',
    axis: '#6f7f9e',
    text: '#a4b1cc',
    panel: '#0e131c',
    ma: { 5: '#f0b90b', 10: '#4a9eff', 20: '#a78bfa', 60: '#0ecb81', 120: '#ff8c5a' },
  };

  function fmt(v, d) {
    if (v == null || !isFinite(v)) return '--';
    return Number(v).toFixed(d == null ? 2 : d);
  }

  function fmtBig(v) {
    if (v == null || !isFinite(v)) return '--';
    const a = Math.abs(v);
    if (a >= 1e12) return (v / 1e12).toFixed(2) + '万亿';
    if (a >= 1e8) return (v / 1e8).toFixed(2) + '亿';
    if (a >= 1e4) return (v / 1e4).toFixed(2) + '万';
    return v.toFixed(0);
  }

  class KLineChart {
    constructor(canvas, tipEl) {
      this.canvas = canvas;
      this.tip = tipEl;
      this.ctx = canvas.getContext('2d');
      this.bars = [];
      this.ind = {};
      this.sub = 'macd';
      this.count = 120;
      this.offset = 0; // 右侧偏移（0 = 贴最新）
      this.hover = -1;
      this.onHover = null;
      this.pad = { l: 8, r: 62, t: 12, b: 22 };
      this._bind();
    }

    setData(bars, ind, sub) {
      this.bars = bars || [];
      this.ind = ind || {};
      if (sub) this.sub = sub;
      this.count = Math.min(this.count || 120, this.bars.length);
      this.offset = 0;
      this.render();
    }

    _bind() {
      const cv = this.canvas;
      cv.addEventListener('mousemove', (e) => {
        const r = cv.getBoundingClientRect();
        const x = e.clientX - r.left;
        const { i } = this._hit(x);
        this.hover = i;
        this.render();
        if (this.onHover) this.onHover(i, e.clientX - r.left, e.clientY - r.top);
      });
      cv.addEventListener('mouseleave', () => {
        this.hover = -1;
        this.render();
        if (this.tip) this.tip.style.display = 'none';
        if (this.onHover) this.onHover(-1);
      });
      cv.addEventListener('wheel', (e) => {
        e.preventDefault();
        const d = e.deltaY > 0 ? 1 : -1;
        this.count = Math.max(30, Math.min(this.bars.length, this.count + d * 8));
        this.offset = Math.max(0, Math.min(this.offset, this.bars.length - this.count));
        this.render();
      }, { passive: false });

      let dragging = false;
      let lastX = 0;
      cv.addEventListener('mousedown', (e) => { dragging = true; lastX = e.clientX; });
      window.addEventListener('mouseup', () => { dragging = false; });
      window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - lastX;
        if (Math.abs(dx) > 6) {
          const step = Math.max(1, Math.round(this.count / 40));
          this.offset = Math.max(0, Math.min(this.bars.length - this.count, this.offset + (dx > 0 ? step : -step)));
          lastX = e.clientX;
          this.render();
        }
      });
    }

    _hit(px) {
      const n = this.bars.length;
      const end = n - this.offset;
      const start = Math.max(0, end - this.count);
      const vis = end - start;
      const geo = this._geo();
      const bw = geo.w / Math.max(vis, 1);
      let i = start + Math.floor((px - this.pad.l) / bw);
      i = Math.max(start, Math.min(end - 1, i));
      return { i, start, end };
    }

    _geo() {
      const dpr = window.devicePixelRatio || 1;
      const w = this.canvas.clientWidth;
      const h = this.canvas.clientHeight;
      this.canvas.width = w * dpr;
      this.canvas.height = h * dpr;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const innerW = w - this.pad.l - this.pad.r;
      const innerH = h - this.pad.t - this.pad.b;
      const volH = Math.max(38, innerH * 0.13);
      const subH = Math.max(46, innerH * 0.2);
      const mainH = innerH - volH - subH - 16;
      return {
        w, h, innerW, innerH,
        main: { y: this.pad.t, h: mainH },
        vol: { y: this.pad.t + mainH + 8, h: volH },
        sub: { y: this.pad.t + mainH + 8 + volH + 8, h: subH },
      };
    }

    render() {
      const { bars, ind } = this;
      const ctx = this.ctx;
      const geo = this._geo();
      ctx.clearRect(0, 0, geo.w, geo.h);
      if (!bars.length) return;

      const n = bars.length;
      const end = n - this.offset;
      const start = Math.max(0, end - this.count);
      const vis = bars.slice(start, end);
      if (!vis.length) return;

      // ---- 主图价格区间（含 MA 与 BOLL）
      let lo = Infinity;
      let hi = -Infinity;
      for (const b of vis) {
        if (b.low < lo) lo = b.low;
        if (b.high > hi) hi = b.high;
      }
      for (const key of ['ma5', 'ma10', 'ma20', 'ma60']) {
        const arr = ind[key];
        if (!arr) continue;
        for (let i = start; i < end; i++) {
          const v = arr[i];
          if (v != null) { if (v < lo) lo = v; if (v > hi) hi = v; }
        }
      }
      if (ind.bollUp) {
        for (let i = start; i < end; i++) {
          if (ind.bollUp[i] != null) hi = Math.max(hi, ind.bollUp[i]);
          if (ind.bollLow[i] != null) lo = Math.min(lo, ind.bollLow[i]);
        }
      }
      const range = hi - lo || 1;
      lo -= range * 0.04;
      hi += range * 0.04;

      const bw = geo.innerW / vis.length;
      const cw = Math.max(1.2, bw * 0.68);

      const yOf = (p, box) => box.y + box.h - ((p - lo) / (hi - lo)) * box.h;
      const xOf = (i) => this.pad.l + (i - start) * bw + bw / 2;

      // ---- 网格 + 价格轴
      ctx.strokeStyle = C.grid;
      ctx.fillStyle = C.axis;
      ctx.font = '10px SF Mono, Menlo, monospace';
      ctx.lineWidth = 1;
      ctx.textAlign = 'left';
      for (let k = 0; k <= 4; k++) {
        const p = lo + ((hi - lo) * k) / 4;
        const y = yOf(p, geo.main);
        ctx.beginPath();
        ctx.moveTo(this.pad.l, y);
        ctx.lineTo(this.pad.l + geo.innerW, y);
        ctx.strokeStyle = C.grid;
        ctx.stroke();
        ctx.fillText(fmt(p), this.pad.l + geo.innerW + 6, y + 3.5);
      }

      // ---- 日期轴
      ctx.textAlign = 'center';
      const stepD = Math.max(1, Math.floor(vis.length / 6));
      for (let j = 0; j < vis.length; j += stepD) {
        const i = start + j;
        const x = xOf(i);
        ctx.fillText(String(bars[i].date).slice(2), x, geo.h - 6);
      }
      ctx.textAlign = 'left';

      // ---- BOLL 填充
      if (ind.bollUp && ind.bollLow) {
        ctx.beginPath();
        let started = false;
        for (let i = start; i < end; i++) {
          if (ind.bollUp[i] == null) continue;
          const x = xOf(i);
          const y = yOf(ind.bollUp[i], geo.main);
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        }
        for (let i = end - 1; i >= start; i--) {
          if (ind.bollLow[i] == null) continue;
          ctx.lineTo(xOf(i), yOf(ind.bollLow[i], geo.main));
        }
        if (started) {
          ctx.closePath();
          ctx.fillStyle = 'rgba(74,158,255,.05)';
          ctx.fill();
        }
      }

      // ---- 蜡烛
      for (let i = start; i < end; i++) {
        const b = bars[i];
        const up = b.close >= b.open;
        const col = up ? C.up : C.down;
        const x = xOf(i);
        ctx.strokeStyle = col;
        ctx.fillStyle = col;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, yOf(b.high, geo.main));
        ctx.lineTo(Math.round(x) + 0.5, yOf(b.low, geo.main));
        ctx.stroke();
        const yo = yOf(b.open, geo.main);
        const yc = yOf(b.close, geo.main);
        const top = Math.min(yo, yc);
        const hgt = Math.max(1, Math.abs(yc - yo));
        ctx.fillRect(x - cw / 2, top, cw, hgt);
      }

      // ---- 均线
      ctx.lineWidth = 1.2;
      for (const key of ['ma5', 'ma10', 'ma20', 'ma60']) {
        const arr = ind[key];
        if (!arr) continue;
        ctx.strokeStyle = C.ma[key.replace('ma', '')] || '#888';
        ctx.beginPath();
        let started = false;
        for (let i = start; i < end; i++) {
          const v = arr[i];
          if (v == null) continue;
          const x = xOf(i);
          const y = yOf(v, geo.main);
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }

      // 最新价虚线 + 标签
      const last = bars[end - 1];
      if (last) {
        const y = yOf(last.close, geo.main);
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = last.close >= last.open ? C.up : C.down;
        ctx.beginPath();
        ctx.moveTo(this.pad.l, y);
        ctx.lineTo(this.pad.l + geo.innerW, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = last.close >= last.open ? C.up : C.down;
        ctx.fillRect(this.pad.l + geo.innerW + 2, y - 8, 56, 15);
        ctx.fillStyle = '#fff';
        ctx.font = '10px SF Mono, Menlo, monospace';
        ctx.fillText(fmt(last.close), this.pad.l + geo.innerW + 6, y + 4);
      }

      // ---- 成交量
      let vmax = 0;
      for (let i = start; i < end; i++) vmax = Math.max(vmax, bars[i].volume || 0);
      const vbox = geo.vol;
      for (let i = start; i < end; i++) {
        const b = bars[i];
        const up = b.close >= b.open;
        const h = ((b.volume || 0) / (vmax || 1)) * vbox.h;
        ctx.fillStyle = up ? 'rgba(246,70,93,.62)' : 'rgba(14,203,129,.62)';
        ctx.fillRect(xOf(i) - cw / 2, vbox.y + vbox.h - h, cw, h);
      }
      if (ind.volMa5) {
        ctx.strokeStyle = '#f0b90b';
        ctx.lineWidth = 1;
        ctx.beginPath();
        let st = false;
        for (let i = start; i < end; i++) {
          const v = ind.volMa5[i];
          if (v == null) continue;
          const y = vbox.y + vbox.h - (v / (vmax || 1)) * vbox.h;
          if (!st) { ctx.moveTo(xOf(i), y); st = true; } else ctx.lineTo(xOf(i), y);
        }
        ctx.stroke();
      }
      ctx.fillStyle = C.axis;
      ctx.font = '9.5px SF Mono, Menlo, monospace';
      ctx.fillText('VOL ' + fmtBig(vmax), this.pad.l + 4, vbox.y + 11);

      // ---- 副图
      const sbox = geo.sub;
      ctx.strokeStyle = C.grid;
      ctx.beginPath();
      ctx.moveTo(this.pad.l, sbox.y);
      ctx.lineTo(this.pad.l + geo.innerW, sbox.y);
      ctx.stroke();

      if (this.sub === 'macd' && ind.macd) {
        let m = 0;
        for (let i = start; i < end; i++) {
          const v = ind.macd.hist[i];
          if (v != null) m = Math.max(m, Math.abs(v));
        }
        m = m || 1;
        const zeroY = sbox.y + sbox.h / 2;
        for (let i = start; i < end; i++) {
          const v = ind.macd.hist[i];
          if (v == null) continue;
          const h = (Math.abs(v) / m) * (sbox.h / 2 - 2);
          ctx.fillStyle = v >= 0 ? 'rgba(246,70,93,.75)' : 'rgba(14,203,129,.75)';
          ctx.fillRect(xOf(i) - cw / 2, v >= 0 ? zeroY - h : zeroY, cw, h);
        }
        const line = (arr, color) => {
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.1;
          ctx.beginPath();
          let st = false;
          for (let i = start; i < end; i++) {
            const v = arr[i];
            if (v == null) continue;
            const y = zeroY - (v / m) * (sbox.h / 2 - 2);
            if (!st) { ctx.moveTo(xOf(i), y); st = true; } else ctx.lineTo(xOf(i), y);
          }
          ctx.stroke();
        };
        line(ind.macd.dif, '#f0b90b');
        line(ind.macd.dea, '#4a9eff');
        ctx.fillStyle = C.axis;
        ctx.font = '9.5px SF Mono, Menlo, monospace';
        ctx.fillText('MACD(12,26,9)', this.pad.l + 4, sbox.y + 11);
      } else if (this.sub === 'rsi' && ind.rsi) {
        const yFor = (v) => sbox.y + sbox.h - ((v - 10) / 80) * sbox.h;
        ctx.setLineDash([2, 3]);
        for (const lv of [30, 50, 70]) {
          ctx.strokeStyle = lv === 50 ? 'rgba(255,255,255,.08)' : 'rgba(240,185,11,.28)';
          ctx.beginPath();
          ctx.moveTo(this.pad.l, yFor(lv));
          ctx.lineTo(this.pad.l + geo.innerW, yFor(lv));
          ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.fillStyle = C.axis;
        ctx.font = '9.5px SF Mono, Menlo, monospace';
        ctx.fillText('70', this.pad.l + geo.innerW + 6, yFor(70) + 3);
        ctx.fillText('30', this.pad.l + geo.innerW + 6, yFor(30) + 3);
        for (const [arr, col] of [[ind.rsi, '#a78bfa']]) {
          ctx.strokeStyle = col;
          ctx.lineWidth = 1.3;
          ctx.beginPath();
          let st = false;
          for (let i = start; i < end; i++) {
            const v = arr[i];
            if (v == null) continue;
            const y = yFor(Math.max(10, Math.min(90, v)));
            if (!st) { ctx.moveTo(xOf(i), y); st = true; } else ctx.lineTo(xOf(i), y);
          }
          ctx.stroke();
        }
        ctx.fillStyle = C.axis;
        ctx.fillText('RSI(14)', this.pad.l + 4, sbox.y + 11);
      } else if (this.sub === 'kdj' && ind.kdj) {
        const yFor = (v) => sbox.y + sbox.h - ((v - 0) / 100) * sbox.h;
        ctx.setLineDash([2, 3]);
        ctx.strokeStyle = 'rgba(255,255,255,.1)';
        ctx.beginPath();
        ctx.moveTo(this.pad.l, yFor(50));
        ctx.lineTo(this.pad.l + geo.innerW, yFor(50));
        ctx.stroke();
        ctx.setLineDash([]);
        for (const [arr, col] of [[ind.kdj.k, '#f0b90b'], [ind.kdj.d, '#4a9eff'], [ind.kdj.j, '#a78bfa']]) {
          ctx.strokeStyle = col;
          ctx.lineWidth = 1.1;
          ctx.beginPath();
          let st = false;
          for (let i = start; i < end; i++) {
            const v = arr[i];
            if (v == null) continue;
            const y = yFor(Math.max(0, Math.min(100, v)));
            if (!st) { ctx.moveTo(xOf(i), y); st = true; } else ctx.lineTo(xOf(i), y);
          }
          ctx.stroke();
        }
        ctx.fillStyle = C.axis;
        ctx.font = '9.5px SF Mono, Menlo, monospace';
        ctx.fillText('KDJ(9,3,3)', this.pad.l + 4, sbox.y + 11);
      } else {
        // 纯成交量放大版
        ctx.fillStyle = C.axis;
        ctx.font = '9.5px SF Mono, Menlo, monospace';
        ctx.fillText('VOLUME', this.pad.l + 4, sbox.y + 11);
      }

      // ---- 十字光标
      if (this.hover >= start && this.hover < end) {
        const x = xOf(this.hover);
        const b = bars[this.hover];
        ctx.setLineDash([2, 2]);
        ctx.strokeStyle = 'rgba(255,255,255,.28)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, this.pad.t);
        ctx.lineTo(x, geo.sub.y + geo.sub.h);
        ctx.stroke();
        const y = yOf(b.close, geo.main);
        ctx.beginPath();
        ctx.moveTo(this.pad.l, y);
        ctx.lineTo(this.pad.l + geo.innerW, y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    /** 供 tooltip 使用：返回当前 hover 的 bar 下标 */
    hoverIndex() {
      return this.hover;
    }
  }

  /** 权益曲线：strategy 与 buy&hold 对比 */
  function drawEquity(canvas, equity, benchmarkPct, initial) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!equity || equity.length < 2) return;

    const pad = { l: 8, r: 66, t: 14, b: 22 };
    const iw = w - pad.l - pad.r;
    const ih = h - pad.t - pad.b;

    const values = equity.map((e) => e.value);
    const bhEnd = initial * (1 + (benchmarkPct || 0) / 100);
    let lo = Math.min(...values, initial, bhEnd);
    let hi = Math.max(...values, initial, bhEnd);
    const rg = hi - lo || 1;
    lo -= rg * 0.08;
    hi += rg * 0.08;

    const xOf = (i) => pad.l + (i / (equity.length - 1)) * iw;
    const yOf = (v) => pad.t + ih - ((v - lo) / (hi - lo)) * ih;

    // 网格
    ctx.font = '10px SF Mono, Menlo, monospace';
    ctx.textAlign = 'left';
    for (let k = 0; k <= 4; k++) {
      const v = lo + ((hi - lo) * k) / 4;
      const y = yOf(v);
      ctx.strokeStyle = C.grid;
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(pad.l + iw, y);
      ctx.stroke();
      ctx.fillStyle = C.axis;
      ctx.fillText((v / 1000).toFixed(1) + 'k', pad.l + iw + 6, y + 3.5);
    }

    // 初始资金参考线
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(255,255,255,.16)';
    ctx.beginPath();
    ctx.moveTo(pad.l, yOf(initial));
    ctx.lineTo(pad.l + iw, yOf(initial));
    ctx.stroke();
    ctx.setLineDash([]);

    // 基准线
    ctx.strokeStyle = '#7c8aa5';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(pad.l, yOf(initial));
    ctx.lineTo(pad.l + iw, yOf(bhEnd));
    ctx.stroke();

    // 策略曲线 + 面积
    ctx.beginPath();
    ctx.moveTo(xOf(0), yOf(values[0]));
    for (let i = 1; i < values.length; i++) ctx.lineTo(xOf(i), yOf(values[i]));
    const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + ih);
    grad.addColorStop(0, 'rgba(74,158,255,.28)');
    grad.addColorStop(1, 'rgba(74,158,255,0)');
    ctx.lineTo(xOf(values.length - 1), pad.t + ih);
    ctx.lineTo(xOf(0), pad.t + ih);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(xOf(0), yOf(values[0]));
    for (let i = 1; i < values.length; i++) ctx.lineTo(xOf(i), yOf(values[i]));
    ctx.strokeStyle = '#4a9eff';
    ctx.lineWidth = 1.8;
    ctx.stroke();

    // 持仓区间高亮
    ctx.fillStyle = 'rgba(240,185,11,.10)';
    let segStart = null;
    for (let i = 0; i < equity.length; i++) {
      if (equity[i].position && segStart === null) segStart = i;
      if ((!equity[i].position || i === equity.length - 1) && segStart !== null) {
        ctx.fillRect(xOf(segStart), pad.t, Math.max(1, xOf(i) - xOf(segStart)), ih);
        segStart = null;
      }
    }

    // 日期轴
    ctx.fillStyle = C.axis;
    ctx.textAlign = 'center';
    const st = Math.max(1, Math.floor(equity.length / 6));
    for (let i = 0; i < equity.length; i += st) {
      ctx.fillText(String(equity[i].date).slice(2), xOf(i), h - 6);
    }
    ctx.textAlign = 'left';
  }

  window.KLineChart = KLineChart;
  window.drawEquity = drawEquity;
  window.ChartUtil = { fmt, fmtBig };
})();
