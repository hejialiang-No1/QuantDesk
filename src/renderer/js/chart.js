/**
 * chart.js —— Canvas 图表引擎（K线 / 成交量 / 副图指标 / 权益曲线）
 * 纯手写，不依赖任何图表库。
 *
 * 交互（v1.0.1 重点修复）
 *   · 十字光标：此前命中测试用画布全宽算每根 K 线的宽度，而绘制用的是去掉坐标轴后的
 *     净宽，两者不一致 → 光标永远偏右十几像素、怎么点都对不上。现在统一走 _barWidth()。
 *   · 缩放：此前滚轮只改可见根数、不动 offset，画面会突然"跳"到最右边。
 *     现在按光标所在的 bar 做锚定缩放，光标下的那根 K 线在缩放前后停在原地。
 *   · 平移：拖拽改为"记录起始 offset + 像素→根数换算"，不再逐帧累加，也不会误选中文本。
 *   · 新增：双击复位、键盘 ←/→/±/0、触控板双指手势、缩放到最新、实时显示可视区间。
 *   · 画布尺寸只在真正变化时重设，避免每次 mousemove 都清空画布重画。
 */
(function () {
  const DARK = {
    up: '#FF453A',      // 涨：红
    down: '#30D158',    // 跌：绿
    flat: '#98989D',
    grid: 'rgba(255,255,255,.055)',
    gridStrong: 'rgba(255,255,255,.10)',
    axis: '#8E8E93',
    text: '#C7C7CC',
    label: 'rgba(28,28,30,.92)',
    cursor: 'rgba(255,255,255,.30)',
    cursorTag: 'rgba(88,88,93,.95)',
    volUp: 'rgba(255,69,58,.62)',
    volDown: 'rgba(48,209,88,.62)',
    bollFill: 'rgba(10,132,255,.055)',
    backdrop: 'rgba(255,255,255,.014)',
    ma: { 5: '#FFD60A', 10: '#0A84FF', 20: '#BF5AF2', 60: '#30D158', 120: '#FF9F0A' },
    buy: '#0A84FF',
    sell: '#FF9F0A',
    stop: '#FF453A',
    support: '#40C8E0',
    resist: '#FF9F0A',
  };

  const LIGHT = {
    up: '#D70015',
    down: '#248A3D',
    flat: '#8E8E93',
    grid: 'rgba(0,0,0,.07)',
    gridStrong: 'rgba(0,0,0,.13)',
    axis: '#6C6C70',
    text: '#3C3C43',
    label: 'rgba(60,60,67,.9)',
    cursor: 'rgba(0,0,0,.32)',
    cursorTag: 'rgba(60,60,67,.92)',
    volUp: 'rgba(215,0,21,.5)',
    volDown: 'rgba(36,138,61,.5)',
    bollFill: 'rgba(0,122,255,.06)',
    backdrop: 'rgba(0,0,0,.012)',
    ma: { 5: '#B25000', 10: '#007AFF', 20: '#8944AB', 60: '#248A3D', 120: '#C93400' },
    buy: '#007AFF',
    sell: '#C93400',
    stop: '#D70015',
    support: '#0071A4',
    resist: '#C93400',
  };

  const C = { ...DARK };

  /** 切换图表主题（深色 / 浅色） */
  function setChartTheme(name) {
    const p = name === 'light' ? LIGHT : DARK;
    Object.assign(C, p, { ma: { ...p.ma } });
  }


  const MIN_BARS = 25;
  const DEFAULT_BARS = 140;

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

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  /** 圆角矩形路径（macOS 风格的价格标签用） */
  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, h / 2, w / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }

  class KLineChart {
    constructor(canvas, tipEl) {
      this.canvas = canvas;
      this.tip = tipEl;
      this.ctx = canvas.getContext('2d');
      this.bars = [];
      this.ind = {};
      this.sub = 'macd';
      this.count = DEFAULT_BARS;
      this.offset = 0; // 右侧偏移（0 = 贴最新）
      this.hover = -1;
      this.onHover = null;
      this.onViewChange = null;
      this.overlays = null; // { levels, plan }
      this.pad = { l: 10, r: 70, t: 14, b: 24 };
      this._w = 0;
      this._h = 0;
      this._dpr = 0;
      this._bind();
    }

    // ------------------------------------------------------------ 尺寸

    /** 只在画布尺寸真的变化时重设，避免频繁清空 */
    _size() {
      const dpr = window.devicePixelRatio || 1;
      const w = this.canvas.clientWidth;
      const h = this.canvas.clientHeight;
      if (w !== this._w || h !== this._h || dpr !== this._dpr) {
        this.canvas.width = Math.max(1, Math.round(w * dpr));
        this.canvas.height = Math.max(1, Math.round(h * dpr));
        this._w = w;
        this._h = h;
        this._dpr = dpr;
      }
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { w, h };
    }

    _geo() {
      const { w, h } = this._size();
      const innerW = Math.max(10, w - this.pad.l - this.pad.r);
      const innerH = Math.max(10, h - this.pad.t - this.pad.b);
      const volH = Math.max(34, innerH * 0.12);
      const subH = Math.max(42, innerH * 0.19);
      const mainH = Math.max(40, innerH - volH - subH - 16);
      return {
        w, h, innerW, innerH, padL: this.pad.l,
        main: { y: this.pad.t, h: mainH },
        vol: { y: this.pad.t + mainH + 8, h: volH },
        sub: { y: this.pad.t + mainH + 8 + volH + 8, h: subH },
      };
    }

    /**
     * 可视区间：返回 {start, end, vis, count}，**start/end 一定是整数**。
     *
     * 为什么必须取整：offset 在拖拽时是小数（这样手感才连续），
     * 而 end = n - offset 会让绘制循环出现 bars[80.099] 这种非整数下标，
     * 取到 undefined 后读 .low / .close 直接抛错——滚动缩放时图表整块消失就是这么来的。
     * 窗口按整根对齐，绘制、命中测试、坐标轴三者才能共用同一套数字。
     */
    _range() {
      const n = this.bars.length;
      const count = clamp(Math.round(this.count) || MIN_BARS, MIN_BARS, Math.max(MIN_BARS, n));
      const maxOff = Math.max(0, n - count);
      const off = clamp(Math.round(this.offset) || 0, 0, maxOff);
      const end = n - off;
      const start = Math.max(0, end - count);
      return { start, end, vis: end - start, count };
    }

    /** 每根 K 线占的屏幕宽度。命中测试与绘制共用这一个函数，保证光标对齐。 */
    _barWidth() {
      const geo = this._geo();
      const { vis } = this._range();
      return geo.innerW / Math.max(1, vis);
    }

    // ------------------------------------------------------------ 交互

    _bind() {
      const cv = this.canvas;

      cv.addEventListener('mousemove', (e) => {
        const r = cv.getBoundingClientRect();
        const x = e.clientX - r.left;
        const y = e.clientY - r.top;
        const { i } = this._hit(x);
        const changed = i !== this.hover;
        this.hover = i;
        if (changed) this.render();
        if (this.onHover) this.onHover(i, x, y);
      });

      cv.addEventListener('mouseleave', () => {
        this.hover = -1;
        this.render();
        if (this.tip) this.tip.style.display = 'none';
        if (this.onHover) this.onHover(-1);
      });

      // 滚轮 / 触控板缩放：以光标为锚点
      cv.addEventListener(
        'wheel',
        (e) => {
          e.preventDefault();
          const r = cv.getBoundingClientRect();
          const x = e.clientX - r.left;
          // 触控板双指捏合在 macOS 上会带 ctrlKey，做更细的步进
          const pinch = e.ctrlKey || e.metaKey;
          const raw = e.deltaY || 0;
          if (e.shiftKey && !pinch) {
            // Shift + 滚轮 = 横向平移
            this.panBy(raw > 0 ? 12 : -12);
            return;
          }
          const factor = raw > 0 ? (pinch ? 1.06 : 1.14) : pinch ? 1 / 1.06 : 1 / 1.14;
          this.zoomAt(x, factor);
        },
        { passive: false }
      );

      // 拖拽平移
      let dragging = false;
      let dragX = 0;
      let dragOffset = 0;

      cv.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        dragging = true;
        dragX = e.clientX;
        dragOffset = this.offset;
        cv.classList.add('dragging');
        e.preventDefault(); // 阻止文本选中 / 原生的图片拖拽
      });

      const endDrag = () => {
        if (!dragging) return;
        dragging = false;
        cv.classList.remove('dragging');
      };
      window.addEventListener('mouseup', endDrag);
      window.addEventListener('blur', endDrag);

      window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const bw = this._barWidth();
        const dx = e.clientX - dragX;
        this._setOffset(dragOffset + dx / Math.max(0.5, bw));
      });

      cv.addEventListener('dblclick', (e) => {
        e.preventDefault();
        this.resetView();
      });

      // 键盘操作（canvas 需 tabindex=0）
      cv.addEventListener('keydown', (e) => {
        const step = Math.max(1, Math.round(this.count * 0.12));
        if (e.key === 'ArrowLeft') {
          this.panBy(step);
        } else if (e.key === 'ArrowRight') {
          this.panBy(-step);
        } else if (e.key === '+' || e.key === '=') {
          this.zoomAt(this._size().w / 2, 1 / 1.2);
        } else if (e.key === '-' || e.key === '_') {
          this.zoomAt(this._size().w / 2, 1.2);
        } else if (e.key === '0') {
          this.resetView();
        } else {
          return;
        }
        e.preventDefault();
      });
    }

    _hit(px) {
      const { start, end } = this._range();
      const bw = this._barWidth();
      let i = start + Math.floor((px - this.pad.l) / bw);
      i = clamp(i, start, Math.max(start, end - 1));
      return { i, start, end };
    }

    _setOffset(v) {
      const n = this.bars.length;
      const max = Math.max(0, n - clamp(this.count, MIN_BARS, Math.max(MIN_BARS, n)));
      const next = clamp(v, 0, max);
      if (Math.abs(next - this.offset) < 0.001) return;
      this.offset = next;
      this.render();
      this._emitView();
    }

    _emitView() {
      if (!this.onViewChange) return;
      const { start, end, vis } = this._range();
      this.onViewChange({
        start: this.bars[start] ? this.bars[start].date : null,
        end: this.bars[end - 1] ? this.bars[end - 1].date : null,
        bars: vis,
        atLatest: this.offset < 1,
        total: this.bars.length,
      });
    }

    /** 以某个屏幕 x 为锚点缩放：该点下的 K 线在缩放前后位置不变 */
    zoomAt(px, factor) {
      const n = this.bars.length;
      if (!n) return;
      const geo = this._geo();
      // 复用 _range()，不要在别处再算一遍 start/end —— 两套算法一旦漂移，
      // 就会出现「缩放后光标下的K线跑位」和越界下标。
      const { start, vis } = this._range();
      if (vis <= 0) return;
      // 已经在最右端时缩放要锁住右边缘：否则光标一旦偏离中心，
      // 视图就会莫名往回跳，用户会觉得「放大把最新K线弄丢了」。
      const atLatest = this.offset < 0.5;
      const frac = clamp((px - this.pad.l) / Math.max(1, geo.innerW), 0, 1);
      const anchor = start + frac * vis; // 光标下的 bar 索引（浮点）

      const nextCount = clamp(Math.round(this.count * factor), MIN_BARS, Math.max(MIN_BARS, n));
      if (nextCount === this.count) return;
      this.count = nextCount;

      if (atLatest) {
        this.offset = 0;
      } else {
        // 让 anchor 在缩放后仍落在同一屏幕比例位置
        const nextStart = anchor - frac * nextCount;
        this.offset = n - nextCount - nextStart;
      }
      this._setOffset(this.offset);
      this.render();
      this._emitView();
    }

    panBy(bars) {
      this._setOffset(this.offset + bars);
    }

    resetView() {
      this.count = Math.min(DEFAULT_BARS, Math.max(MIN_BARS, this.bars.length));
      this.offset = 0;
      this.render();
      this._emitView();
    }

    zoomToLatest() {
      this.offset = 0;
      this.render();
      this._emitView();
    }

    setOverlays(ov) {
      this.overlays = ov || null;
      this.render();
    }

    // ------------------------------------------------------------ 数据

    setData(bars, ind, sub, opts = {}) {
      const keepView = opts.keepView === true;
      const prevSymbol = this._symbol;
      if (opts.symbol) this._symbol = opts.symbol;
      this.bars = bars || [];
      this.ind = ind || {};
      if (sub) this.sub = sub;
      if (!keepView) {
        this.count = Math.min(DEFAULT_BARS, Math.max(MIN_BARS, this.bars.length));
        this.offset = 0;
      } else {
        this.count = clamp(this.count, MIN_BARS, Math.max(MIN_BARS, this.bars.length));
        this.offset = clamp(this.offset, 0, Math.max(0, this.bars.length - this.count));
      }
      this.hover = -1;
      void prevSymbol;
      this.render();
      this._emitView();
    }

    setSub(sub) {
      this.sub = sub;
      this.render();
    }

    // ------------------------------------------------------------ 绘制

    render() {
      const ctx = this.ctx;
      const geo = this._geo();
      ctx.clearRect(0, 0, geo.w, geo.h);
      this._drawBackdrop(geo);
      if (!this.bars.length) return;

      const { bars, ind } = this;
      const { start, end, vis } = this._range();
      if (vis <= 0) return;

      // ---- 主图价格区间（含 MA / BOLL / 叠加区间）
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = start; i < end; i++) {
        const b = bars[i];
        if (!b) continue; // 双保险：_range() 已保证整数下标，这里再挡一次脏数据
        if (b.low < lo) lo = b.low;
        if (b.high > hi) hi = b.high;
      }
      for (const key of ['ma5', 'ma10', 'ma20', 'ma60']) {
        const arr = ind[key];
        if (!arr) continue;
        for (let i = start; i < end; i++) {
          const v = arr[i];
          if (v != null) {
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        }
      }
      if (ind.bollUp) {
        for (let i = start; i < end; i++) {
          if (ind.bollUp[i] != null) hi = Math.max(hi, ind.bollUp[i]);
          if (ind.bollLow[i] != null) lo = Math.min(lo, ind.bollLow[i]);
        }
      }
      // 叠加层（支撑压力 / 买卖区间）也要纳入纵轴范围，否则会被画到画布外
      const ov = this.overlays;
      if (ov) {
        const consider = (p) => {
          if (p == null || !isFinite(p)) return;
          if (p < lo) lo = p;
          if (p > hi) hi = p;
        };
        if (ov.levels) {
          (ov.levels.supports || []).slice(0, 3).forEach((s) => consider(s.price));
          (ov.levels.resistances || []).slice(0, 3).forEach((s) => consider(s.price));
        }
        if (ov.plan) {
          consider(ov.plan.buy && ov.plan.buy.low);
          consider(ov.plan.buy && ov.plan.buy.high);
          consider(ov.plan.sell && ov.plan.sell.high);
          consider(ov.plan.stop && ov.plan.stop.price);
        }
      }
      if (!isFinite(lo) || !isFinite(hi)) return;
      const range = hi - lo || 1;
      lo -= range * 0.05;
      hi += range * 0.05;

      const bw = geo.innerW / vis;
      const cw = Math.max(1.2, Math.min(bw * 0.7, 22));
      const yOf = (p, box) => box.y + box.h - ((p - lo) / (hi - lo)) * box.h;
      const xOf = (i) => this.pad.l + (i - start) * bw + bw / 2;

      // ---- 网格 + 价格轴
      ctx.font = '10px "SF Mono", ui-monospace, Menlo, monospace';
      ctx.textAlign = 'left';
      ctx.lineWidth = 1;
      for (let k = 0; k <= 4; k++) {
        const p = lo + ((hi - lo) * k) / 4;
        const y = Math.round(yOf(p, geo.main)) + 0.5;
        ctx.strokeStyle = k === 0 || k === 4 ? C.gridStrong : C.grid;
        ctx.beginPath();
        ctx.moveTo(this.pad.l, y);
        ctx.lineTo(this.pad.l + geo.innerW, y);
        ctx.stroke();
        ctx.fillStyle = C.axis;
        ctx.fillText(fmt(p), this.pad.l + geo.innerW + 8, y + 3.5);
      }

      // ---- 日期轴
      ctx.textAlign = 'center';
      const stepD = Math.max(1, Math.floor(vis / 6));
      for (let j = 0; j < vis; j += stepD) {
        const i = start + j;
        if (!bars[i]) continue;
        ctx.fillStyle = C.axis;
        ctx.fillText(String(bars[i].date).slice(2), xOf(i), geo.h - 7);
      }
      ctx.textAlign = 'left';

      // ---- 买卖区间 / 止损（画在 K 线之下，作为背景带）
      this._drawZones(ctx, geo, yOf);

      // ---- 支撑 / 压力线
      this._drawLevels(ctx, geo, yOf);

      // ---- BOLL 填充
      if (ind.bollUp && ind.bollLow) {
        ctx.beginPath();
        let started = false;
        for (let i = start; i < end; i++) {
          if (ind.bollUp[i] == null) continue;
          const x = xOf(i);
          const y = yOf(ind.bollUp[i], geo.main);
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else ctx.lineTo(x, y);
        }
        for (let i = end - 1; i >= start; i--) {
          if (ind.bollLow[i] == null) continue;
          ctx.lineTo(xOf(i), yOf(ind.bollLow[i], geo.main));
        }
        if (started) {
          ctx.closePath();
          ctx.fillStyle = C.bollFill;
          ctx.fill();
        }
      }

      // ---- 蜡烛
      for (let i = start; i < end; i++) {
        const b = bars[i];
        const col = b.close >= b.open ? C.up : C.down;
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
        ctx.fillRect(Math.round(x - cw / 2), Math.round(top), Math.max(1, Math.round(cw)), Math.round(hgt));
      }

      // ---- 均线
      ctx.lineWidth = 1.2;
      for (const key of ['ma5', 'ma10', 'ma20', 'ma60']) {
        const arr = ind[key];
        if (!arr) continue;
        ctx.strokeStyle = C.ma[key.replace('ma', '')] || '#8E8E93';
        ctx.beginPath();
        let started = false;
        for (let i = start; i < end; i++) {
          const v = arr[i];
          if (v == null) continue;
          const x = xOf(i);
          const y = yOf(v, geo.main);
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }

      // ---- 最新价虚线 + 右侧价签
      const last = bars[end - 1];
      if (last) {
        const col = last.close >= last.open ? C.up : C.down;
        const y = yOf(last.close, geo.main);
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = col;
        ctx.beginPath();
        ctx.moveTo(this.pad.l, y);
        ctx.lineTo(this.pad.l + geo.innerW, y);
        ctx.stroke();
        ctx.setLineDash([]);
        this._tag(ctx, this.pad.l + geo.innerW + 4, y, fmt(last.close), col, 62);
      }

      // ---- 成交量
      let vmax = 0;
      for (let i = start; i < end; i++) vmax = Math.max(vmax, bars[i].volume || 0);
      const vbox = geo.vol;
      for (let i = start; i < end; i++) {
        const b = bars[i];
        const hh = ((b.volume || 0) / (vmax || 1)) * vbox.h;
        ctx.fillStyle = b.close >= b.open ? C.volUp : C.volDown;
        ctx.fillRect(Math.round(xOf(i) - cw / 2), Math.round(vbox.y + vbox.h - hh), Math.max(1, Math.round(cw)), Math.round(hh));
      }
      if (ind.volMa5) {
        ctx.strokeStyle = C.ma[5];
        ctx.lineWidth = 1;
        ctx.beginPath();
        let st = false;
        for (let i = start; i < end; i++) {
          const v = ind.volMa5[i];
          if (v == null) continue;
          const y = vbox.y + vbox.h - (v / (vmax || 1)) * vbox.h;
          if (!st) {
            ctx.moveTo(xOf(i), y);
            st = true;
          } else ctx.lineTo(xOf(i), y);
        }
        ctx.stroke();
      }
      ctx.fillStyle = C.axis;
      ctx.font = '9.5px "SF Mono", ui-monospace, Menlo, monospace';
      ctx.fillText('VOL ' + fmtBig(vmax), this.pad.l + 4, vbox.y + 11);

      // ---- 副图
      this._drawSub(ctx, geo, { start, end, xOf, bw, cw });

      // ---- 十字光标
      this._drawCrosshair(ctx, geo, { start, end, xOf, yOf });
    }

    _drawBackdrop(geo) {
      const ctx = this.ctx;
      ctx.fillStyle = C.backdrop;
      ctx.fillRect(this.pad.l, geo.main.y, geo.innerW, geo.main.h);
    }

    /** 右侧圆角价格标签 */
    _tag(ctx, x, y, text, bg, w) {
      const h = 16;
      ctx.fillStyle = bg;
      roundRect(ctx, x, y - h / 2, w, h, 4);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = '10px "SF Mono", ui-monospace, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(text, x + w / 2, y + 3.5);
      ctx.textAlign = 'left';
    }

    /** 买卖区间 / 止损带 */
    _drawZones(ctx, geo, yOf) {
      const p = this.overlays && this.overlays.plan;
      if (!p) return;
      const x0 = this.pad.l;
      const x1 = this.pad.l + geo.innerW;
      const band = (a, b, fill, stroke) => {
        if (a == null || b == null || !isFinite(a) || !isFinite(b)) return;
        const yTop = yOf(Math.max(a, b), geo.main);
        const yBot = yOf(Math.min(a, b), geo.main);
        const h = Math.max(2, yBot - yTop);
        ctx.fillStyle = fill;
        ctx.fillRect(x0, yTop, geo.innerW, h);
        ctx.strokeStyle = stroke;
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x0, yTop);
        ctx.lineTo(x1, yTop);
        ctx.moveTo(x0, yBot);
        ctx.lineTo(x1, yBot);
        ctx.stroke();
        ctx.setLineDash([]);
      };
      band(p.buy.low, p.buy.high, 'rgba(10,132,255,.13)', 'rgba(10,132,255,.55)');
      band(p.sell.low, p.sell.high, 'rgba(255,159,10,.11)', 'rgba(255,159,10,.5)');
      if (p.stop && p.stop.price != null) {
        const y = yOf(p.stop.price, geo.main);
        ctx.strokeStyle = C.stop;
        ctx.setLineDash([2, 3]);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x0, y);
        ctx.lineTo(x1, y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // 图上标注
      const label = (price, text, color, above) => {
        if (price == null) return;
        const y = yOf(price, geo.main);
        if (y < geo.main.y + 8 || y > geo.main.y + geo.main.h - 4) return;
        ctx.font = '9.5px -apple-system, "PingFang SC", sans-serif';
        ctx.fillStyle = color;
        ctx.textAlign = 'left';
        ctx.fillText(text, x0 + 6, above ? y - 3 : y + 11);
      };
      label(p.buy.high, '买入区间上沿 ' + fmt(p.buy.high), 'rgba(120,180,255,.95)', true);
      label(p.buy.low, '买入区间下沿 ' + fmt(p.buy.low), 'rgba(120,180,255,.95)', false);
      label(p.sell.low, 'T1 减仓 ' + fmt(p.sell.low), 'rgba(255,190,110,.95)', true);
      label(p.stop.price, '止损 ' + fmt(p.stop.price), 'rgba(255,120,120,.95)', false);
    }

    /** 支撑 / 压力位横线 */
    _drawLevels(ctx, geo, yOf) {
      const lv = this.overlays && this.overlays.levels;
      if (!lv) return;
      const x0 = this.pad.l;
      const x1 = this.pad.l + geo.innerW;
      const draw = (arr, color, prefix) => {
        (arr || []).slice(0, 3).forEach((s, idx) => {
          const y = yOf(s.price, geo.main);
          if (y < geo.main.y - 2 || y > geo.main.y + geo.main.h + 2) return;
          ctx.strokeStyle = color;
          ctx.globalAlpha = idx === 0 ? 0.75 : 0.36;
          ctx.lineWidth = 1;
          ctx.setLineDash(idx === 0 ? [6, 4] : [2, 4]);
          ctx.beginPath();
          ctx.moveTo(x0, Math.round(y) + 0.5);
          ctx.lineTo(x1, Math.round(y) + 0.5);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
        });
      };
      draw(lv.supports, C.support, 'S');
      draw(lv.resistances, C.resist, 'R');
    }

    _drawSub(ctx, geo, view) {
      const { ind } = this;
      const { start, end, xOf, cw } = view;
      const sbox = geo.sub;
      ctx.strokeStyle = C.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(this.pad.l, Math.round(sbox.y) + 0.5);
      ctx.lineTo(this.pad.l + geo.innerW, Math.round(sbox.y) + 0.5);
      ctx.stroke();
      ctx.font = '9.5px "SF Mono", ui-monospace, Menlo, monospace';
      ctx.fillStyle = C.axis;

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
          const h = (Math.abs(v) / m) * (sbox.h / 2 - 3);
          ctx.fillStyle = v >= 0 ? 'rgba(255,69,58,.72)' : 'rgba(48,209,88,.72)';
          ctx.fillRect(Math.round(xOf(i) - cw / 2), Math.round(v >= 0 ? zeroY - h : zeroY), Math.max(1, Math.round(cw)), Math.round(h));
        }
        const line = (arr, color) => {
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.1;
          ctx.beginPath();
          let st = false;
          for (let i = start; i < end; i++) {
            const v = arr[i];
            if (v == null) continue;
            const y = zeroY - (v / m) * (sbox.h / 2 - 3);
            if (!st) {
              ctx.moveTo(xOf(i), y);
              st = true;
            } else ctx.lineTo(xOf(i), y);
          }
          ctx.stroke();
        };
        line(ind.macd.dif, C.ma[5]);
        line(ind.macd.dea, C.ma[10]);
        ctx.fillStyle = C.axis;
        ctx.fillText('MACD(12,26,9)', this.pad.l + 4, sbox.y + 11);
      } else if (this.sub === 'rsi' && ind.rsi) {
        const yFor = (v) => sbox.y + sbox.h - ((v - 10) / 80) * sbox.h;
        ctx.setLineDash([2, 3]);
        for (const lv of [30, 50, 70]) {
          ctx.strokeStyle = lv === 50 ? C.gridStrong : 'rgba(255,214,10,.32)';
          ctx.beginPath();
          ctx.moveTo(this.pad.l, yFor(lv));
          ctx.lineTo(this.pad.l + geo.innerW, yFor(lv));
          ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.fillStyle = C.axis;
        ctx.fillText('70', this.pad.l + geo.innerW + 8, yFor(70) + 3);
        ctx.fillText('30', this.pad.l + geo.innerW + 8, yFor(30) + 3);
        ctx.strokeStyle = C.ma[20];
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        let st = false;
        for (let i = start; i < end; i++) {
          const v = ind.rsi[i];
          if (v == null) continue;
          const y = yFor(clamp(v, 10, 90));
          if (!st) {
            ctx.moveTo(xOf(i), y);
            st = true;
          } else ctx.lineTo(xOf(i), y);
        }
        ctx.stroke();
        ctx.fillStyle = C.axis;
        ctx.fillText('RSI(14)', this.pad.l + 4, sbox.y + 11);
      } else if (this.sub === 'kdj' && ind.kdj) {
        const yFor = (v) => sbox.y + sbox.h - (v / 100) * sbox.h;
        ctx.setLineDash([2, 3]);
        ctx.strokeStyle = C.gridStrong;
        ctx.beginPath();
        ctx.moveTo(this.pad.l, yFor(50));
        ctx.lineTo(this.pad.l + geo.innerW, yFor(50));
        ctx.stroke();
        ctx.setLineDash([]);
        for (const [arr, col] of [[ind.kdj.k, C.ma[5]], [ind.kdj.d, C.ma[10]], [ind.kdj.j, C.ma[20]]]) {
          ctx.strokeStyle = col;
          ctx.lineWidth = 1.1;
          ctx.beginPath();
          let st = false;
          for (let i = start; i < end; i++) {
            const v = arr[i];
            if (v == null) continue;
            const y = yFor(clamp(v, 0, 100));
            if (!st) {
              ctx.moveTo(xOf(i), y);
              st = true;
            } else ctx.lineTo(xOf(i), y);
          }
          ctx.stroke();
        }
        ctx.fillStyle = C.axis;
        ctx.fillText('KDJ(9,3,3)', this.pad.l + 4, sbox.y + 11);
      } else {
        ctx.fillStyle = C.axis;
        ctx.fillText('VOLUME', this.pad.l + 4, sbox.y + 11);
      }
    }

    _drawCrosshair(ctx, geo, view) {
      const { start, end, xOf, yOf } = view;
      if (this.hover < start || this.hover >= end) return;
      const x = xOf(this.hover);
      const b = this.bars[this.hover];
      if (!b) return;
      ctx.setLineDash([2, 2]);
      ctx.strokeStyle = C.cursor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, this.pad.t);
      ctx.lineTo(Math.round(x) + 0.5, geo.sub.y + geo.sub.h);
      ctx.stroke();
      const y = yOf(b.close, geo.main);
      ctx.beginPath();
      ctx.moveTo(this.pad.l, Math.round(y) + 0.5);
      ctx.lineTo(this.pad.l + geo.innerW, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      // 右侧浮动价签 + 底部日期签
      this._tag(ctx, this.pad.l + geo.innerW + 4, y, fmt(b.close), C.cursorTag, 62);
      const dt = String(b.date).slice(5);
      ctx.font = '10px "SF Mono", ui-monospace, Menlo, monospace';
      const tw = ctx.measureText(dt).width + 12;
      ctx.fillStyle = C.cursorTag;
      roundRect(ctx, x - tw / 2, geo.h - 19, tw, 15, 4);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.fillText(dt, x, geo.h - 8.5);
      ctx.textAlign = 'left';
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

    const pad = { l: 10, r: 70, t: 14, b: 24 };
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

    ctx.font = '10px "SF Mono", ui-monospace, Menlo, monospace';
    ctx.textAlign = 'left';
    for (let k = 0; k <= 4; k++) {
      const v = lo + ((hi - lo) * k) / 4;
      const y = Math.round(yOf(v)) + 0.5;
      ctx.strokeStyle = C.grid;
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(pad.l + iw, y);
      ctx.stroke();
      ctx.fillStyle = C.axis;
      ctx.fillText((v / 1000).toFixed(1) + 'k', pad.l + iw + 8, y + 3.5);
    }

    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = C.gridStrong;
    ctx.beginPath();
    ctx.moveTo(pad.l, yOf(initial));
    ctx.lineTo(pad.l + iw, yOf(initial));
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.strokeStyle = C.flat;
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(pad.l, yOf(initial));
    ctx.lineTo(pad.l + iw, yOf(bhEnd));
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(xOf(0), yOf(values[0]));
    for (let i = 1; i < values.length; i++) ctx.lineTo(xOf(i), yOf(values[i]));
    const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + ih);
    grad.addColorStop(0, 'rgba(10,132,255,.3)');
    grad.addColorStop(1, 'rgba(10,132,255,0)');
    ctx.lineTo(xOf(values.length - 1), pad.t + ih);
    ctx.lineTo(xOf(0), pad.t + ih);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(xOf(0), yOf(values[0]));
    for (let i = 1; i < values.length; i++) ctx.lineTo(xOf(i), yOf(values[i]));
    ctx.strokeStyle = C.buy;
    ctx.lineWidth = 1.8;
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,214,10,.10)';
    let segStart = null;
    for (let i = 0; i < equity.length; i++) {
      if (equity[i].position && segStart === null) segStart = i;
      if ((!equity[i].position || i === equity.length - 1) && segStart !== null) {
        ctx.fillRect(xOf(segStart), pad.t, Math.max(1, xOf(i) - xOf(segStart)), ih);
        segStart = null;
      }
    }

    ctx.fillStyle = C.axis;
    ctx.textAlign = 'center';
    const st = Math.max(1, Math.floor(equity.length / 6));
    for (let i = 0; i < equity.length; i += st) {
      ctx.fillText(String(equity[i].date).slice(2), xOf(i), h - 8);
    }
    ctx.textAlign = 'left';
  }

  window.KLineChart = KLineChart;
  window.drawEquity = drawEquity;
  window.ChartUtil = { fmt, fmtBig };
  window.setChartTheme = setChartTheme;
})();
