/**
 * app.js —— 界面主控（v1.0.1）
 * 数据与算法由 preload 注入的 window.qd 提供：行情、指标、因子、回测，
 * 以及本次新增的 支撑压力位 / 交易计划 / 全面诊股 / 期权策略 四个模块。
 */
(function () {
  const { ind, factors, bt } = window.qd;
  const Lv = window.qd.levels;
  const TradePlan = window.qd.tradeplan;
  const Diag = window.qd.diagnose;
  const Opt = window.qd.options;

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  // 周期口径：每年多少根K线 / 一根K线代表的时间单位。
  // 年化波动率、ATR 换算、期权到期时间都依赖这个，选错周期会成倍失真。
  const PERIOD_PPY = { day: 252, week: 52, month: 12, m5: 252 * 78, m15: 252 * 26, m30: 252 * 13, m60: 252 * 6.5 };
  const PERIOD_UNIT = { day: '日', week: '周', month: '月', m5: '5分钟', m15: '15分钟', m30: '30分钟', m60: '小时' };

  const DEFAULT_WATCH = [
    { code: 'NVDA', name: '英伟达', market: 105, secid: '105.NVDA' },
    { code: 'AAPL', name: '苹果', market: 105, secid: '105.AAPL' },
    { code: 'TSLA', name: '特斯拉', market: 105, secid: '105.TSLA' },
    { code: 'MSFT', name: '微软', market: 105, secid: '105.MSFT' },
    { code: 'NBIS', name: 'Nebius', market: 105, secid: '105.NBIS' },
    { code: 'CRWV', name: 'CoreWeave', market: 105, secid: '105.CRWV' },
    { code: 'IREN', name: 'IREN', market: 105, secid: '105.IREN' },
    { code: 'OKLO', name: 'Oklo', market: 105, secid: '105.OKLO' },
  ];

  const state = {
    config: null,
    watchlist: [],
    alerts: [],
    quotes: new Map(),
    scanResults: [],
    scanSort: { key: 'score', dir: -1 },
    watchSort: { key: 'changePct', dir: -1 },
    current: null,
    currentPeriod: 'day',
    chart: null,
    btResult: null,
    analysis: null,       // 当前个股的完整分析结果
    ovOn: true,           // 图表是否叠加买卖区间 / 支撑压力
    optDte: 30,
    optIvOverride: null,
    optShowAll: false,
    themePref: 'dark',
    timers: {},
  };

  // ------------------------------------------------------------ 工具

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove('show'), 2400);
  }

  function setStatus(busy, text) {
    $('#statusDot').className = 'dot' + (busy ? ' busy' : '');
    $('#statusText').textContent = text || (busy ? '请求中…' : '就绪');
  }

  const f2 = (v) => (v == null || !isFinite(v) ? '--' : Number(v).toFixed(2));
  const f0 = (v) => (v == null || !isFinite(v) ? '--' : Number(v).toLocaleString('en-US'));
  function pct(v) {
    if (v == null || !isFinite(v)) return '--';
    return (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%';
  }
  function cls(v) {
    if (v == null || !isFinite(v) || v === 0) return 'flat';
    return v > 0 ? 'up' : 'down';
  }
  /** 美元金额（带正负号，用于期权盈亏） */
  function usd(v, signed) {
    if (v == null || !isFinite(v)) return '--';
    const s = signed && v > 0 ? '+' : v < 0 ? '-' : '';
    return s + '$' + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
  }
  function cap(v) {
    if (v == null || !isFinite(v) || v === 0) return '--';
    const a = Math.abs(v);
    if (a >= 1e12) return (v / 1e12).toFixed(2) + 'T';
    if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    return v.toFixed(0);
  }
  function amount(v) {
    if (v == null || !isFinite(v)) return '--';
    const a = Math.abs(v);
    if (a >= 1e8) return (v / 1e8).toFixed(2) + '亿';
    if (a >= 1e4) return (v / 1e4).toFixed(2) + '万';
    return v.toFixed(0);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // ------------------------------------------------------------ 外观

  function resolveTheme(pref) {
    if (pref === 'light' || pref === 'dark') return pref;
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  function applyTheme(pref) {
    state.themePref = pref || 'dark';
    const t = resolveTheme(state.themePref);
    document.documentElement.setAttribute('data-theme', t);
    if (window.setChartTheme) window.setChartTheme(t);
    $$('#themeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.t === state.themePref));
    const btn = $('#btnTheme');
    if (btn) btn.classList.toggle('on', state.themePref !== 'dark');
    if (state.chart) state.chart.render();
    if (state.btResult) drawEquityPanel();
  }

  function bindTheme() {
    $('#btnTheme').addEventListener('click', () => {
      const order = ['dark', 'light', 'auto'];
      const next = order[(order.indexOf(state.themePref) + 1) % order.length];
      applyTheme(next);
      qd.configUpdate({ theme: next });
      toast({ dark: '深色外观', light: '浅色外观', auto: '跟随系统' }[next]);
    });
    $$('#themeSeg button').forEach((b) =>
      b.addEventListener('click', () => {
        applyTheme(b.dataset.t);
        qd.configUpdate({ theme: b.dataset.t });
      })
    );
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => {
      if (state.themePref === 'auto') applyTheme('auto');
    };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
  }

  /** 滚动边缘效果：内容压到工具栏下方时给工具栏加分隔与投影 */
  function bindScrollEdge() {
    const c = $('#content');
    const upd = () => $('#app').classList.toggle('scrolled', c.scrollTop > 4);
    c.addEventListener('scroll', upd, { passive: true });
    upd();
  }

  // ------------------------------------------------------------ 启动

  async function boot() {
    bindNav();
    bindSearch();
    bindWatch();
    bindAnalyze();
    bindScan();
    bindBacktest();
    bindAlerts();
    bindSettings();
    bindTheme();
    bindScrollEdge();
    startClock();

    state.config = await qd.storeGet('config');
    let wl = await qd.storeGet('watchlist');
    if (!wl || !wl.length) {
      wl = DEFAULT_WATCH.slice();
      await qd.storeSet('watchlist', wl);
    }
    state.watchlist = wl;
    state.alerts = (await qd.storeGet('alerts')) || [];

    applyTheme(state.config.theme || 'dark');

    $('#refreshRate').value = String(state.config.refreshInterval || 15000);
    $('#setFq').value = String(state.config.fq);
    $('#setPeriod').value = state.config.period || 'day';
    state.currentPeriod = state.config.period || 'day';
    setPeriodUI(state.currentPeriod);
    $('#btCapital').value = state.config.initialCapital || 100000;

    const info = await qd.appInfo();
    $('#footVer').textContent = `v${info.version} · Electron ${info.electron}`;
    $('#aboutKpi').innerHTML = [
      ['版本', 'v' + info.version],
      ['Electron', info.electron],
      ['Node', info.node],
      ['架构', info.arch],
    ]
      .map(([k, v]) => `<div class="kpi"><div class="k">${k}</div><div class="v sm">${esc(v)}</div></div>`)
      .join('');

    renderWatch();
    renderAlerts();
    renderPool();
    loadIndexes();
    refreshQuotes();
    scheduleRefresh();
    scheduleAlerts();

    if (state.watchlist.length) {
      $('#anaCode').value = state.watchlist[0].code;
      analyze(state.watchlist[0].secid, true);
    }

    $('#btStrategy').innerHTML = Object.entries(bt.STRATEGIES)
      .map(([k, v]) => `<option value="${k}">${v.name}</option>`)
      .join('');
    renderBtParams();
    $('#btDesc').innerHTML = `<span class="callout-tag">策略</span><span class="callout-text"><b>${esc(
      bt.STRATEGIES.ma_cross.name
    )}</b>：${esc(bt.STRATEGIES.ma_cross.desc)}</span>`;

    // 调试/自检钩子：给主进程的 --smoke 探针一个只读的观察窗口。
    // 只暴露读取与视图操作，不改变任何业务状态。
    window.__qd = {
      chart: () => state.chart,
      analysis: () => state.analysis,
      current: () => state.current,
      period: () => state.currentPeriod,
      view: () => {
        const v = document.querySelector('.view.active');
        return v ? v.id : 'none';
      },
    };
  }

  function startClock() {
    const tick = () => {
      $('#clock').textContent = new Date().toTimeString().slice(0, 8);
    };
    tick();
    setInterval(tick, 1000);
  }

  function bindNav() {
    $$('.nav-item').forEach((it) => {
      it.addEventListener('click', () => {
        $$('.nav-item').forEach((x) => x.classList.remove('active'));
        it.classList.add('active');
        const v = it.dataset.view;
        $$('.view').forEach((x) => x.classList.remove('active'));
        $('#view-' + v).classList.add('active');
        $('#content').scrollTop = 0;
        $('#app').classList.remove('scrolled');
        if (v === 'analyze' && state.chart) state.chart.render();
        if (v === 'backtest' && state.btResult) drawEquityPanel();
      });
    });
  }

  // ------------------------------------------------------------ 搜索

  function bindSearch() {
    const input = $('#searchInput');
    const pop = $('#searchPop');
    let timer = null;
    let items = [];
    let activeIdx = -1;

    input.addEventListener('input', () => {
      clearTimeout(timer);
      const kw = input.value.trim();
      if (!kw) {
        pop.classList.remove('show');
        return;
      }
      timer = setTimeout(async () => {
        try {
          items = await qd.search(kw);
          activeIdx = -1;
          pop.innerHTML = items.length
            ? items
                .map(
                  (r, i) =>
                    `<div class="item" data-i="${i}"><span class="c">${esc(r.code)}</span><span class="n">${esc(
                      r.name
                    )}</span><span class="m">${esc(r.marketName || '')}</span></div>`
                )
                .join('')
            : '<div class="item"><span class="n">未找到相关标的</span></div>';
          pop.classList.add('show');
          $$('#searchPop .item').forEach((el) => {
            el.addEventListener('click', () => pick(items[Number(el.dataset.i)]));
          });
        } catch {
          pop.classList.remove('show');
        }
      }, 240);
    });

    function pick(r) {
      if (!r) return;
      pop.classList.remove('show');
      input.value = '';
      openAnalyze(r.secid, r.code);
    }

    input.addEventListener('keydown', (e) => {
      if (!pop.classList.contains('show') || !items.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        activeIdx = (activeIdx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        $$('#searchPop .item').forEach((el, i) => el.classList.toggle('active', i === activeIdx));
      } else if (e.key === 'Enter') {
        pick(items[activeIdx >= 0 ? activeIdx : 0]);
      } else if (e.key === 'Escape') {
        pop.classList.remove('show');
      }
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.search-box')) pop.classList.remove('show');
    });
  }

  function openAnalyze(secid, code) {
    $$('.nav-item').forEach((x) => x.classList.toggle('active', x.dataset.view === 'analyze'));
    $$('.view').forEach((x) => x.classList.toggle('active', x.id === 'view-analyze'));
    $('#content').scrollTop = 0;
    $('#anaCode').value = code || '';
    analyze(secid);
  }

  // ------------------------------------------------------------ 指数

  async function loadIndexes() {
    try {
      const list = await qd.indexes();
      if (!list.length) return;
      $('#indexStrip').innerHTML = list
        .map(
          (q) =>
            `<div class="idx"><span class="nm">${esc(q.name)}</span><span class="pv">${f2(
              q.price
            )}</span><span class="pc ${cls(q.changePct)}">${pct(q.changePct)}</span></div>`
        )
        .join('');
    } catch {
      /* 指数失败不阻塞 */
    }
  }

  // ------------------------------------------------------------ 自选行情

  function bindWatch() {
    $('#btnAdd').addEventListener('click', () => addByCode($('#addCode').value));
    $('#addCode').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addByCode($('#addCode').value);
    });
    $('#btnRefresh').addEventListener('click', () => refreshQuotes(true));
    $('#refreshRate').addEventListener('change', async () => {
      state.config = await qd.configUpdate({ refreshInterval: Number($('#refreshRate').value) });
      scheduleRefresh();
      toast('刷新间隔已更新');
    });
    $('#autoRefresh').addEventListener('change', () => scheduleRefresh());

    $$('#watchTable th[data-sort]').forEach((th) => {
      th.addEventListener('click', () => {
        const k = th.dataset.sort;
        state.watchSort.dir = state.watchSort.key === k ? -state.watchSort.dir : -1;
        state.watchSort.key = k;
        renderWatch();
      });
    });
  }

  async function addByCode(raw) {
    const code = String(raw || '').trim().toUpperCase();
    if (!code) return;
    setStatus(true, '查询中…');
    try {
      const r = await qd.search(code);
      const hit = r.find((x) => x.code.toUpperCase() === code) || r[0];
      if (!hit) {
        toast('未找到该代码');
        return;
      }
      await addWatch({ secid: hit.secid, code: hit.code, name: hit.name, market: hit.market });
      $('#addCode').value = '';
    } catch {
      toast('查询失败，请稍后重试');
    } finally {
      setStatus(false);
    }
  }

  async function addWatch(item) {
    state.watchlist = await qd.watchlistAdd(item);
    renderWatch();
    refreshQuotes(true);
    toast(`已添加 ${item.code}`);
  }

  async function removeWatch(secid) {
    state.watchlist = await qd.watchlistRemove(secid);
    renderWatch();
    toast('已移除');
  }

  async function refreshQuotes(force) {
    if (!state.watchlist.length) return;
    setStatus(true, '拉取行情…');
    try {
      const list = await qd.quotes(
        state.watchlist.map((w) => w.secid),
        { maxAge: force ? 0 : 8000 }
      );
      state.quotes = new Map(list.map((q) => [q.secid, q]));
      renderWatch();
      setStatus(false, `已更新 ${new Date().toTimeString().slice(0, 8)}`);
      // 若当前正在看的股票有行情，刷新报价头
      if (state.analysis && state.analysis.secid && state.quotes.get(state.analysis.secid)) {
        state.analysis.quote = state.quotes.get(state.analysis.secid);
        renderQuoteHead(state.analysis);
      }
    } catch {
      setStatus(false, '行情获取失败');
    }
  }

  function scheduleRefresh() {
    clearInterval(state.timers.refresh);
    if (!$('#autoRefresh').checked) return;
    const ms = Number($('#refreshRate').value) || 15000;
    state.timers.refresh = setInterval(() => refreshQuotes(true), ms);
  }

  function renderWatch() {
    const tb = $('#watchTable tbody');
    const rows = state.watchlist.map((w) => ({ ...w, q: state.quotes.get(w.secid) }));
    const { key, dir } = state.watchSort;
    rows.sort((a, b) => {
      const va = a.q ? a.q[key] : null;
      const vb = b.q ? b.q[key] : null;
      if (key === 'code') return dir * String(a.code).localeCompare(String(b.code));
      if (va == null) return 1;
      if (vb == null) return -1;
      return dir * (va - vb);
    });

    $('#watchEmpty').style.display = rows.length ? 'none' : 'block';
    tb.innerHTML = rows
      .map((r) => {
        const q = r.q;
        if (!q) {
          return `<tr><td><span class="code">${esc(r.code)}</span> <span class="name">${esc(
            r.name || ''
          )}</span></td><td colspan="10" class="muted">--</td>
          <td><button class="btn sm danger" data-del="${esc(r.secid)}">删除</button></td></tr>`;
        }
        return `<tr>
          <td><span class="code" data-open="${esc(q.secid)}" data-code="${esc(q.code)}">${esc(
          q.code
        )}</span> <span class="name">${esc(q.name)}</span></td>
          <td class="${cls(q.changePct)}"><b>${f2(q.price)}</b></td>
          <td class="${cls(q.changePct)}"><b>${pct(q.changePct)}</b></td>
          <td class="${cls(q.change)}">${q.change == null ? '--' : (q.change > 0 ? '+' : '') + f2(q.change)}</td>
          <td>${f2(q.open)}</td>
          <td class="up">${f2(q.high)}</td>
          <td class="down">${f2(q.low)}</td>
          <td>${f2(q.prevClose)}</td>
          <td>${amount(q.amount)}</td>
          <td>${cap(q.marketCap)}</td>
          <td>${q.pe == null ? '--' : f2(q.pe)}</td>
          <td><button class="btn sm danger" data-del="${esc(q.secid)}">删除</button></td>
        </tr>`;
      })
      .join('');

    tb.querySelectorAll('[data-del]').forEach((b) =>
      b.addEventListener('click', () => removeWatch(b.dataset.del))
    );
    tb.querySelectorAll('[data-open]').forEach((b) =>
      b.addEventListener('click', () => openAnalyze(b.dataset.open, b.dataset.code))
    );
  }

  async function renderPool() {
    try {
      const pool = await qd.pool();
      const picks = pool.slice(0, 64);
      $('#poolChips').innerHTML = picks
        .map(
          (p) =>
            `<button class="btn sm" data-add='${JSON.stringify(p)}' title="${esc(p.group)} · ${esc(
              p.name
            )}">${esc(p.code)}</button>`
        )
        .join('');
      $('#poolChips')
        .querySelectorAll('[data-add]')
        .forEach((b) =>
          b.addEventListener('click', () => {
            const p = JSON.parse(b.dataset.add);
            addWatch({ secid: p.secid, code: p.code, name: p.name, market: p.market });
          })
        );
    } catch {
      /* 池子失败不阻塞 */
    }
  }

  // ------------------------------------------------------------ 个股分析

  function bindAnalyze() {
    $('#btnAnalyze').addEventListener('click', async () => {
      const code = $('#anaCode').value.trim().toUpperCase();
      if (!code) return;
      const r = await qd.search(code);
      const hit = r.find((x) => x.code.toUpperCase() === code) || r[0];
      if (!hit) return toast('未找到该代码');
      analyze(hit.secid);
    });
    $('#anaCode').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('#btnAnalyze').click();
    });
    $('#btnAnaStar').addEventListener('click', () => {
      const q = state.analysis && state.analysis.quote;
      const secid = state.current;
      if (!secid) return;
      if (state.watchlist.some((w) => w.secid === secid)) return toast('已在自选中');
      const code = q ? q.code : secid.split('.')[1];
      addWatch({ secid, code, name: q ? q.name : '', market: Number(secid.split('.')[0]) });
    });

    $$('#periodSeg button').forEach((b) => {
      b.addEventListener('click', () => {
        setPeriodUI(b.dataset.p);
        if (state.current) analyze(state.current, true);
      });
    });
    $('#subInd').addEventListener('change', () => {
      if (state.chart) state.chart.setSub($('#subInd').value);
    });

    // ---- 图表控制（本次修复的重点）
    const chartCx = () => {
      const cv = $('#klineCanvas');
      return cv ? cv.clientWidth / 2 : 200;
    };
    $('#chartZoomIn').addEventListener('click', () => state.chart && state.chart.zoomAt(chartCx(), 1 / 1.25));
    $('#chartZoomOut').addEventListener('click', () => state.chart && state.chart.zoomAt(chartCx(), 1.25));
    $('#chartReset').addEventListener('click', () => state.chart && state.chart.resetView());
    $('#chartLatest').addEventListener('click', () => state.chart && state.chart.zoomToLatest());

    $('#ovToggle').addEventListener('change', () => {
      state.ovOn = $('#ovToggle').checked;
      syncOverlays();
    });

    // ---- 期权参数
    $$('#optDteSeg button').forEach((b) =>
      b.addEventListener('click', () => {
        state.optDte = Number(b.dataset.d);
        $$('#optDteSeg button').forEach((x) => x.classList.toggle('on', x === b));
        rebuildOptions();
      })
    );
    $('#optIv').addEventListener('change', () => {
      const v = parseFloat($('#optIv').value);
      state.optIvOverride = isFinite(v) && v > 0 ? v / 100 : null;
      rebuildOptions();
    });
    $('#btnOptMore').addEventListener('click', () => {
      state.optShowAll = !state.optShowAll;
      $('#btnOptMore').textContent = state.optShowAll ? '收起' : '展开全部';
      if (state.analysis && state.analysis.op) renderOptions(state.analysis.op);
    });

    let rt = null;
    window.addEventListener('resize', () => {
      clearTimeout(rt);
      rt = setTimeout(() => {
        if (state.chart) state.chart.render();
        if (state.btResult) drawEquityPanel();
      }, 120);
    });
  }

  function syncOverlays() {
    if (!state.chart || !state.analysis) return;
    const { lv, pl } = state.analysis;
    state.chart.setOverlays(state.ovOn ? { levels: lv, plan: pl } : null);
  }

  function setPeriodUI(p) {
    state.currentPeriod = p;
    $$('#periodSeg button').forEach((b) => b.classList.toggle('on', b.dataset.p === p));
    qd.configUpdate({ period: p });
  }

  async function analyze(secid, silent) {
    state.current = secid;
    setStatus(true, '加载K线…');
    try {
      const k = await qd.kline(secid, {
        period: state.currentPeriod,
        limit: 400,
        fq: Number(state.config.fq || 1),
      });
      if (!k || !k.bars || k.bars.length < 30) {
        toast('K线数据不足');
        return;
      }
      const bars = k.bars;
      const quote = state.quotes.get(secid) || null;

      const closes = bars.map((b) => b.close);
      const highs = bars.map((b) => b.high);
      const lows = bars.map((b) => b.low);
      const vols = bars.map((b) => b.volume || 0);

      const indicators = {
        ma5: ind.sma(closes, 5),
        ma10: ind.sma(closes, 10),
        ma20: ind.sma(closes, 20),
        ma60: ind.sma(closes, 60),
        macd: ind.macd(closes),
        rsi: ind.rsi(closes, 14),
        kdj: ind.kdj(highs, lows, closes),
        volMa5: ind.volMa(vols, 5),
      };
      const boll = ind.boll(closes, 20, 2);
      indicators.bollUp = boll.upper;
      indicators.bollLow = boll.lower;

      // ---- 周期口径：月线不能按 252 根年化，否则波动率被放大 √21 倍
      const ppy = PERIOD_PPY[state.currentPeriod] || 252;
      const unit = PERIOD_UNIT[state.currentPeriod] || '日';

      // ---- 四个分析模块
      const a = factors.analyze(bars, quote, ppy);
      const lv = Lv.compute(bars, { price: bars[bars.length - 1].close });
      const pl = TradePlan.plan(bars, { quote, levels: lv, factors: a, ppy, unit });
      const dg = Diag.diagnose(bars, { quote, ppy, unit });
      const op = Opt.build(bars, {
        quote,
        ppy,
        score: dg ? dg.score : a ? a.score : 50,
        dte: state.optDte,
        iv: state.optIvOverride,
      });

      state.analysis = { secid, bars, indicators, a, lv, pl, dg, op, quote, name: k.name };

      // ---- 图表
      const cv = $('#klineCanvas');
      if (!state.chart) {
        state.chart = new window.KLineChart(cv, $('#klineTip'));
        state.chart.onViewChange = renderChartRange;
      }
      state.chart.sub = $('#subInd').value;
      state.chart.setData(bars, indicators, $('#subInd').value, { symbol: secid });
      state.chart.onHover = (i, x, y) => showTip(i, bars, indicators, x, y);
      syncOverlays();

      renderQuoteHead(state.analysis);
      if (a) renderAnalysisPanel(a, secid);
      renderPlan(pl);
      renderDiag(dg);
      renderOptions(op);

      const q = quote || state.quotes.get(secid);
      if (q) $('#anaCode').value = q.code;
      if (!silent) toast(`已加载 ${k.name || secid}（${bars.length} 根K线）`);
      setStatus(false, '就绪');
    } catch (e) {
      setStatus(false, '加载失败');
      toast('K线加载失败：' + (e.message || '数据源限流，请稍后重试'));
    }
  }

  /** 只重算期权（改 IV / 期限时用，不重新拉数据） */
  function rebuildOptions() {
    const an = state.analysis;
    if (!an) return;
    const op = Opt.build(an.bars, {
      quote: an.quote,
      score: an.dg ? an.dg.score : an.a ? an.a.score : 50,
      dte: state.optDte,
      iv: state.optIvOverride,
    });
    an.op = op;
    renderOptions(op);
  }

  function renderChartRange(v) {
    const el = $('#chartRange');
    if (!el || !state.chart) return;
    const bars = state.chart.bars;
    if (!bars || !bars.length) {
      el.textContent = '';
      return;
    }
    if (!v) {
      el.textContent = `共 ${bars.length} 根`;
      return;
    }
    el.textContent = `${v.start || '--'} → ${v.end || '--'} · 可见 ${v.bars} 根 / 共 ${v.total} 根${
      v.atLatest ? '' : ' · 已离开最新'
    }`;
  }

  function showTip(i, bars, inds, x, y) {
    const tip = $('#klineTip');
    if (i < 0 || !bars[i]) {
      tip.style.display = 'none';
      return;
    }
    const b = bars[i];
    const c = b.close >= b.open ? 'up' : 'down';
    const ma = (arr) => (arr && arr[i] != null ? f2(arr[i]) : '--');
    tip.innerHTML = `<div>${esc(b.date)}</div>
      <div>开 <span class="${c}">${f2(b.open)}</span> 高 <span class="${c}">${f2(b.high)}</span></div>
      <div>收 <span class="${c}">${f2(b.close)}</span> 低 <span class="${c}">${f2(b.low)}</span></div>
      <div>量 ${amount(b.volume)}</div>
      <div style="margin-top:4px;color:#FFD60A">MA5 ${ma(inds.ma5)}  MA20 ${ma(inds.ma20)}</div>
      <div style="color:#BF5AF2">RSI ${inds.rsi[i] != null ? inds.rsi[i].toFixed(1) : '--'}</div>`;
    tip.style.display = 'block';
    const wrapW = tip.parentElement.clientWidth;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const wrapH = tip.parentElement.clientHeight;
    let left = x + 16;
    if (left + tw > wrapW - 4) left = Math.max(4, x - tw - 16);
    let top = y - th / 2;
    top = Math.max(4, Math.min(wrapH - th - 4, top));
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }

  // ------------------------------------------------------------ 报价头

  function renderQuoteHead(an) {
    const { a, dg, pl, quote, name, secid } = an;
    const price = a ? a.price : quote ? quote.price : null;
    const chg = a ? a.changePct : quote ? quote.changePct : null;
    $('#qhCode').textContent = quote ? quote.code : secid.split('.')[1] || secid;
    $('#qhName').textContent = name || (quote ? quote.name : '') || '';
    $('#qhLast').textContent = f2(price);
    $('#qhLast').className = 'qh-last ' + cls(chg);
    $('#qhChg').textContent = pct(chg);
    $('#qhChg').className = 'qh-chg ' + cls(chg);

    const badges = [];
    if (a) {
      const rt = factors.rating(a.score);
      badges.push(`<span class="pill">综合 ${a.score.toFixed(1)} · ${rt.label}</span>`);
    }
    if (dg) {
      badges.push(`<span class="pill subtle">诊股 ${dg.score} · 风险${dg.riskLevel}</span>`);
      badges.push(`<span class="pill subtle">体检 ${dg.passCount}/8</span>`);
    }
    if (pl) {
      badges.push(
        `<span class="pill ${pl.action.tone === 'up' ? 'up' : pl.action.tone === 'down' ? 'down' : 'subtle'}">${esc(
          pl.action.label
        )}</span>`
      );
    }
    if (quote && quote.pe != null) badges.push(`<span class="pill subtle">PE ${f2(quote.pe)}</span>`);
    if (quote && quote.marketCap) badges.push(`<span class="pill subtle">市值 ${cap(quote.marketCap)}</span>`);
    $('#qhBadges').innerHTML = badges.join('');
  }

  // ------------------------------------------------------------ 交易计划面板

  function renderPlan(pl) {
    if (!pl) {
      $('#planGrid').innerHTML = '<div class="callout warn"><span class="callout-tag">数据不足</span><span class="callout-text">K线样本不足以推导可靠的买卖区间。</span></div>';
      $('#planSplit').innerHTML = '';
      $('#planTriggers').innerHTML = '';
      return;
    }
    $('#planStance').textContent = pl.stance.label;
    $('#planStance').className = 'pill' + (pl.stance.tone === 'up' ? ' up' : pl.stance.tone === 'down' ? ' down' : '');
    $('#planHorizon').textContent = pl.horizon;

    const act = $('#planAction');
    act.className = 'callout ' + (pl.action.tone === 'up' ? 'up' : pl.action.tone === 'down' ? 'down' : pl.action.tone === 'warn' ? 'warn' : 'info');
    act.innerHTML = `<span class="callout-tag">${esc(pl.action.label)}</span><span class="callout-text">${esc(pl.action.text)}</span>`;

    const qBadge = { high: '支撑扎实', mid: '支撑一般', low: '支撑薄弱' }[pl.buy.quality] || '';
    const sBadge = { high: '压力明确', mid: '压力一般', low: '需自行设目标' }[pl.sell.quality] || '';

    $('#planGrid').innerHTML = `
      <div class="plan-card buy">
        <div class="pc-k">推荐买入区间 <span class="muted">${esc(qBadge)}</span></div>
        <div class="pc-v">${f2(pl.buy.low)} – ${f2(pl.buy.high)}</div>
        <div class="pc-n">
          中枢 <b>${f2(pl.buy.ref)}</b> · 区间宽度 <b>${f2(pl.buy.widthPct)}%</b><br />
          ${esc((pl.buy.basis || []).join(' · ') || '—')}
        </div>
      </div>
      <div class="plan-card sell">
        <div class="pc-k">推荐卖出区间 <span class="muted">${esc(sBadge)}</span></div>
        <div class="pc-v">${f2(pl.sell.low)} – ${f2(pl.sell.high)}</div>
        <div class="pc-n">
          T1 涨幅 <b>${pct(pl.sell.targets[0] && pl.sell.targets[0].gainPct)}</b> · T3 涨幅 <b>${pct(
      pl.sell.targets[2] && pl.sell.targets[2].gainPct
    )}</b><br />
          ${esc((pl.sell.basis || []).join(' · ') || '—')}
        </div>
      </div>
      <div class="plan-card stop">
        <div class="pc-k">止损位</div>
        <div class="pc-v">${f2(pl.stop.price)}</div>
        <div class="pc-n">
          相对买区中枢 <b class="up">${f2(pl.stop.pct)}%</b> · 每股风险 <b>$${f2(pl.stop.riskPerShare)}</b><br />
          ${esc(pl.stop.basis)}
        </div>
      </div>
      <div class="plan-card pos">
        <div class="pc-k">盈亏比 / 建议仓位</div>
        <div class="pc-v">${pl.rr == null ? '--' : pl.rr.toFixed(2) + ' : 1'}</div>
        <div class="pc-n">
          T1 盈亏比 <b>${pl.rrT1 == null ? '--' : pl.rrT1.toFixed(2)}</b> · 建议仓位 <b>${pl.position.pct}%</b><br />
          ${esc(pl.position.note)}
        </div>
      </div>`;

    $('#planSplit').innerHTML = `
      <div class="plan-col-title">分批建仓（买区上沿 → 下沿，40% / 35% / 25%）</div>
      ${pl.buy.tranches
        .map(
          (t) => `<div class="split-row">
            <span class="sr-tag">${esc(t.label)}</span>
            <span class="sr-price">${f2(t.price)}</span>
            <span class="sr-w">${t.weight}%</span>
            <span class="sr-basis">相对现价 ${pct(((t.price - pl.price) / pl.price) * 100)}</span>
          </div>`
        )
        .join('')}
      <div class="plan-col-title" style="margin-top:14px">分批止盈目标</div>
      ${pl.sell.targets
        .map(
          (t) => `<div class="split-row">
            <span class="sr-tag">${esc(t.label)} 减 ${t.weight}%</span>
            <span class="sr-price">${f2(t.price)}</span>
            <span class="sr-w up">${pct(t.gainPct)}</span>
            <span class="sr-basis">${esc(t.basis)}</span>
          </div>`
        )
        .join('')}`;

    $('#planTriggers').innerHTML = `
      <div>
        <div class="plan-col-title"><span class="tag bull">买入触发</span></div>
        <ul class="plan-list entry">${pl.triggers.entry.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
      </div>
      <div>
        <div class="plan-col-title"><span class="tag warn">离场条件</span> <span class="tag bear">观点失效</span></div>
        <ul class="plan-list exit">${pl.triggers.exit.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
        <ul class="plan-list invalidate" style="margin-top:6px">${pl.triggers.invalidate
          .map((t) => `<li>${esc(t)}</li>`)
          .join('')}</ul>
      </div>`;
  }

  // ------------------------------------------------------------ 评分 / 因子 / 指标

  function renderAnalysisPanel(a, secid) {
    const rt = factors.rating(a.score);
    $('#anaScore').innerHTML = `
      <div class="big-score">
        <div class="num-big rating ${rt.cls}">${a.score.toFixed(1)}</div>
        <div class="meta">
          <div class="rating ${rt.cls}">${rt.label}</div>
          <div>看多信号 ${a.bullCount} 个 · 看空信号 ${a.bearCount} 个</div>
          <div>现价 ${f2(a.price)} <span class="${cls(a.changePct)}">${pct(a.changePct)}</span></div>
        </div>
      </div>`;

    $('#anaSignals').innerHTML = a.signals.length
      ? a.signals.map((s) => `<span class="tag ${s.type}">${esc(s.text)}</span>`).join('')
      : '<span class="tag gray">无明显信号</span>';

    const FN = {
      momentum: ['动量', 25],
      trend: ['趋势', 25],
      reversion: ['均值回归', 15],
      volume: ['量能', 15],
      volatility: ['波动', 10],
      position: ['位置', 10],
    };
    $('#anaFactors').innerHTML = Object.entries(FN)
      .map(([k, [label, max]]) => {
        const v = a.factors[k] || 0;
        return `<div class="factor-row">
          <span class="fn">${label}</span>
          <span class="ft"><span class="ff" style="width:${(v / max) * 100}%"></span></span>
          <span class="fv">${v.toFixed(1)}</span>
        </div>`;
      })
      .join('');

    const m = a.metrics;
    const px = a.price;
    const kpi = [
      ['RSI(14)', m.rsi == null ? '--' : m.rsi.toFixed(1), m.rsi > 70 ? 'up' : m.rsi < 30 ? 'down' : ''],
      ['MA20', f2(m.ma20), px > m.ma20 ? 'up' : 'down'],
      ['MA60', f2(m.ma60), px > m.ma60 ? 'up' : 'down'],
      ['MA120', f2(m.ma120), px > m.ma120 ? 'up' : 'down'],
      ['MACD柱', m.macdHist == null ? '--' : m.macdHist.toFixed(3), m.macdHist > 0 ? 'up' : 'down'],
      ['KDJ-K', m.kdjK == null ? '--' : m.kdjK.toFixed(1), ''],
      ['5日涨幅', pct(m.ret5), cls(m.ret5)],
      ['20日涨幅', pct(m.ret20), cls(m.ret20)],
      ['60日涨幅', pct(m.ret60), cls(m.ret60)],
      ['距52周高', m.distHigh == null ? '--' : m.distHigh.toFixed(1) + '%', cls(m.distHigh)],
      ['量比(5/20)', m.volRatio == null ? '--' : m.volRatio.toFixed(2), m.volRatio > 1.2 ? 'up' : ''],
      ['ATR%', m.atrPct == null ? '--' : m.atrPct.toFixed(2) + '%', ''],
      ['年化波动', m.volatility == null ? '--' : m.volatility.toFixed(1) + '%', ''],
      ['52周高/低', `${f2(m.hi52)} / ${f2(m.lo52)}`, ''],
    ];
    $('#anaKpi').innerHTML = kpi
      .map(
        ([k, v, c]) => `<div class="kpi"><div class="k">${k}</div><div class="v sm ${c}">${esc(v)}</div></div>`
      )
      .join('');
    void secid;
  }

  // ------------------------------------------------------------ 全面诊股

  function renderDiag(dg) {
    if (!dg) {
      $('#diagDims').innerHTML = '<div class="callout warn"><span class="callout-tag">数据不足</span><span class="callout-text">至少需要 120 根K线才能做全面诊断。</span></div>';
      return;
    }
    $('#diagScorePill').textContent = `诊股 ${dg.score} · ${dg.rating.label}`;
    $('#diagScorePill').className = 'pill';
    $('#diagRiskPill').textContent = `风险等级 ${dg.riskLevel} · ${dg.horizon}`;
    $('#diagRiskPill').className = 'pill ' + (dg.riskLevel === '高' ? 'up' : dg.riskLevel === '偏低' ? 'down' : 'subtle');

    const toneColor = (t) => (t === 'up' ? 'var(--up)' : t === 'warn' ? 'var(--orange)' : t === 'down' ? 'var(--down)' : 'var(--gray)');
    $('#diagDims').innerHTML = dg.dims
      .map(
        (d) => `<div class="dim-card">
          <div class="dim-head">
            <span class="dn">${esc(d.label)}</span>
            <span class="dg" style="color:${toneColor(d.tone)}">${d.score}<span class="muted" style="font-size:10px">/${100}</span></span>
            <span class="pill subtle" style="height:18px;padding:0 7px">${d.g}</span>
          </div>
          <div class="dim-track"><div class="dim-fill" style="width:${d.score}%;background:${toneColor(d.tone)}"></div></div>
          <div class="dim-note">${esc(d.comment)}</div>
        </div>`
      )
      .join('');

    const lvCls = (l) => (l === '高' ? 'high' : l === '中' ? 'mid' : 'low');
    $('#diagOppCount').textContent = dg.opportunities.length;
    $('#diagRiskCount').textContent = dg.risks.length;
    $('#diagOpps').innerHTML = dg.opportunities
      .map(
        (o) => `<div class="diag-item">
          <div class="di-hd">
            <span class="di-t">${esc(o.title)}</span>
            <span class="di-lv ${lvCls(o.level)}">${esc(o.level)}</span>
          </div>
          <div class="di-d">${esc(o.detail)}</div>
          ${o.evidence ? `<div class="di-e">依据：${esc(o.evidence)}</div>` : ''}
        </div>`
      )
      .join('');
    $('#diagRisks').innerHTML = dg.risks
      .map(
        (o) => `<div class="diag-item">
          <div class="di-hd">
            <span class="di-t">${esc(o.title)}</span>
            <span class="di-lv ${lvCls(o.level)}">${esc(o.level)}</span>
          </div>
          <div class="di-d">${esc(o.detail)}</div>
          ${o.evidence ? `<div class="di-e">依据：${esc(o.evidence)}</div>` : ''}
        </div>`
      )
      .join('');

    $('#diagChecks').innerHTML = dg.checks
      .map(
        (c) => `<span class="check ${c.pass ? 'pass' : 'fail'}">
          <span class="ck">${c.pass ? '✓' : '×'}</span>${esc(c.label)}
          <span class="muted" style="font-family:var(--mono);font-size:10px">${esc(c.detail || '')}</span>
        </span>`
      )
      .join('');

    $('#diagSummary').textContent = dg.summary;
  }

  // ------------------------------------------------------------ 期权策略

  function legLabel(l) {
    const act = l.action === 'buy' ? '买入' : '卖出';
    if (l.type === 'stock') return `${act} 100 股正股`;
    return `${act} ${l.type === 'call' ? 'Call' : 'Put'} ${l.K}`;
  }

  function renderOptions(op) {
    if (!op) {
      $('#optSummary').innerHTML = '<div class="callout warn"><span class="callout-tag">数据不足</span><span class="callout-text">至少需要 80 根K线才能估算波动率并生成期权策略。</span></div>';
      $('#optChain tbody').innerHTML = '';
      $('#optStrategies').innerHTML = '';
      $('#optNotes').innerHTML = '';
      return;
    }

    $('#optSummary').innerHTML = `
      <div class="opt-stat">
        <div class="os-k">隐含波动率 IV（估算）</div>
        <div class="os-v">${op.ivPct.toFixed(1)}%</div>
        <div class="os-n">历史波动率 ${op.hvPct.toFixed(1)}% × ${op.ivMult.toFixed(2)}${
      op.ivIsManual ? ' · 已手动覆盖' : ''
    }</div>
      </div>
      <div class="opt-stat">
        <div class="os-k">到期日 / 剩余天数</div>
        <div class="os-v" style="font-size:14px">${esc(op.expiry)}</div>
        <div class="os-n">约 ${op.dte} 天 · 标准月度期权（第三个周五）</div>
      </div>
      <div class="opt-stat">
        <div class="os-k">±1σ 期望波动区间</div>
        <div class="os-v" style="font-size:14px">${f2(op.expectedRange[0])} – ${f2(op.expectedRange[1])}</div>
        <div class="os-n">±${op.sdPct}%（${f2(op.sd)} 美元）· ±2σ 为 ${f2(
      op.expectedRange2[0]
    )} – ${f2(op.expectedRange2[1])}</div>
      </div>
      <div class="opt-stat">
        <div class="os-k">波动率环境 / 多空立场</div>
        <div class="os-v" style="font-size:14px">${esc(op.volRegime.label)} · ${esc(op.viewLabel)}</div>
        <div class="os-n">${esc(op.volRegime.note)}</div>
      </div>`;

    $('#optChain tbody').innerHTML = op.chain
      .map(
        (c) => `<tr>
          <td class="mono"><b>${f2(c.strike)}</b></td>
          <td style="text-align:left;font-family:var(--sans);color:var(--text-3)">${esc(c.moneyness)}</td>
          <td>${f2(c.call)}</td>
          <td>${c.callDelta.toFixed(2)}</td>
          <td>${f2(c.put)}</td>
          <td>${c.putDelta.toFixed(2)}</td>
          <td>${c.iv.toFixed(1)}</td>
        </tr>`
      )
      .join('');

    const list = state.optShowAll ? op.strategies : op.strategies.slice(0, 4);
    $('#optStrategies').innerHTML = list
      .map((s) => {
        const mp = s.maxProfitUnbounded ? '不封顶' : usd(s.maxProfit, true);
        const ml = s.maxLossUnbounded ? '无下限' : usd(s.maxLoss, true);
        return `<div class="strategy-card">
          <div class="sc-head">
            <span class="sc-name">${esc(s.name)}</span>
            <span class="sc-en">${esc(s.nameEn)}</span>
            <span class="pill subtle" style="height:20px">${esc(s.outlook)}</span>
            <span class="sc-fit">适配
              <span class="fit-track"><span class="fit-fill" style="width:${s.fit}%"></span></span>
              <b class="mono">${s.fit}</b>
            </span>
          </div>
          <div class="sc-legs">
            ${s.legs
              .map((l) => `<span class="leg ${l.action}">${esc(legLabel(l))} <span class="muted">@${f2(l.premium)}</span></span>`)
              .join('')}
          </div>
          <div class="sc-metrics">
            <div class="m"><div class="k">净权利金</div><div class="v ${s.netPremium >= 0 ? 'down' : 'flat'}">${usd(
          s.netPremium,
          true
        )}</div></div>
            <div class="m"><div class="k">最大盈利</div><div class="v up">${mp}</div></div>
            <div class="m"><div class="k">最大亏损</div><div class="v down">${ml}</div></div>
            <div class="m"><div class="k">估算胜率</div><div class="v">${s.probProfit.toFixed(1)}%</div></div>
          </div>
          <div class="sc-metrics" style="grid-template-columns:1.4fr 1fr 1fr">
            <div class="m"><div class="k">盈亏平衡</div><div class="v tiny">${
              s.breakevens.length ? s.breakevens.map((b) => f2(b)).join(' / ') : '—'
            }</div></div>
            <div class="m"><div class="k">资金占用</div><div class="v tiny">${usd(s.capitalRequired)}</div></div>
            <div class="m"><div class="k">期望盈亏</div><div class="v tiny ${cls(s.expectedPl)}">${usd(
          s.expectedPl,
          true
        )}</div></div>
          </div>
          <ul class="sc-notes">${s.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
        </div>`;
      })
      .join('');

    $('#optNotes').innerHTML = op.notes.map((n) => `<div>· ${esc(n)}</div>`).join('');
  }

  // ------------------------------------------------------------ 量化选股

  function bindScan() {
    $('#btnScan').addEventListener('click', runScan);
    $('#btnExport').addEventListener('click', exportCsv);
    $('#scanFilter').addEventListener('change', renderScan);
    $$('#scanTable th[data-sort]').forEach((th) => {
      th.addEventListener('click', () => {
        const k = th.dataset.sort;
        state.scanSort.dir = state.scanSort.key === k ? -state.scanSort.dir : -1;
        state.scanSort.key = k;
        renderScan();
      });
    });
  }

  async function runScan() {
    const btn = $('#btnScan');
    btn.disabled = true;
    setStatus(true, '扫描中…');
    const off = qd.onScanProgress((p) => {
      $('#scanBar').style.width = Math.round((p.done / p.total) * 100) + '%';
      $('#scanText').textContent = `${p.done}/${p.total} · ${p.current || ''}`;
    });
    try {
      const res = await qd.scan({
        source: $('#scanSource').value,
        limit: Number($('#scanLimit').value),
      });
      if (res.error) return toast(res.error);
      state.scanResults = res.results || [];
      $('#scanMeta').textContent = `共 ${state.scanResults.length} 只 · 耗时 ${(res.costMs / 1000).toFixed(
        1
      )}s · ${new Date(res.scannedAt).toLocaleString('zh-CN')}`;
      renderScan();
      toast(`扫描完成，命中 ${state.scanResults.length} 只`);
    } catch (e) {
      toast('扫描失败：' + (e.message || '请稍后重试'));
    } finally {
      off();
      btn.disabled = false;
      setStatus(false, '就绪');
    }
  }

  function renderScan() {
    const minScore = Number($('#scanFilter').value);
    let rows = state.scanResults.filter((r) => r.score >= minScore);
    const { key, dir } = state.scanSort;
    const getter = (r) => (key === 'rsi' || key === 'ret20' || key === 'volRatio' ? r.metrics[key] : r[key]);
    rows = rows.slice().sort((a, b) => {
      const va = getter(a);
      const vb = getter(b);
      if (va == null) return 1;
      if (vb == null) return -1;
      return dir * (va - vb);
    });

    const tb = $('#scanTable tbody');
    $('#scanEmpty').style.display = rows.length ? 'none' : 'block';
    tb.innerHTML = rows
      .map((r, i) => {
        const rt = factors.rating(r.score);
        const color = r.score >= 66 ? 'var(--up)' : r.score >= 52 ? 'var(--orange)' : 'var(--gray)';
        return `<tr>
          <td class="muted">${i + 1}</td>
          <td><span class="code" data-open="${esc(r.secid)}" data-code="${esc(r.code)}">${esc(
          r.code
        )}</span> <span class="name">${esc(r.name || '')}</span></td>
          <td><span class="score-bar"><b class="${rt.cls}" style="color:${color}">${r.score.toFixed(
          1
        )}</b><span class="track"><span class="fill" style="width:${r.score}%;background:${color}"></span></span></span></td>
          <td><span class="rating ${rt.cls}">${rt.label}</span></td>
          <td>${f2(r.price)}</td>
          <td class="${cls(r.changePct)}">${pct(r.changePct)}</td>
          <td>${r.metrics.rsi == null ? '--' : r.metrics.rsi.toFixed(1)}</td>
          <td class="${cls(r.metrics.ret20)}">${pct(r.metrics.ret20)}</td>
          <td>${r.metrics.volRatio == null ? '--' : r.metrics.volRatio.toFixed(2)}</td>
          <td style="text-align:left">${(r.signals || [])
            .slice(0, 3)
            .map((s) => `<span class="tag ${s.type}">${esc(s.text)}</span>`)
            .join('')}</td>
          <td><button class="btn sm" data-add="${esc(r.secid)}|${esc(r.code)}|${esc(r.name || '')}">加自选</button></td>
        </tr>`;
      })
      .join('');

    tb.querySelectorAll('[data-open]').forEach((b) =>
      b.addEventListener('click', () => openAnalyze(b.dataset.open, b.dataset.code))
    );
    tb.querySelectorAll('[data-add]').forEach((b) =>
      b.addEventListener('click', () => {
        const [secid, code, name] = b.dataset.add.split('|');
        addWatch({ secid, code, name, market: Number(secid.split('.')[0]) });
      })
    );
  }

  function exportCsv() {
    if (!state.scanResults.length) return toast('没有可导出的结果');
    const head = ['排名', '代码', '名称', '评分', '评级', '现价', '涨跌幅', 'RSI', '20日涨幅', '60日涨幅', '量比', '距高点', '信号'];
    const lines = [head.join(',')];
    state.scanResults.forEach((r, i) => {
      lines.push(
        [
          i + 1, r.code, `"${(r.name || '').replace(/"/g, '')}"`, r.score.toFixed(1), factors.rating(r.score).label,
          f2(r.price), r.changePct == null ? '' : r.changePct.toFixed(2),
          r.metrics.rsi == null ? '' : r.metrics.rsi.toFixed(1),
          r.metrics.ret20 == null ? '' : r.metrics.ret20.toFixed(2),
          r.metrics.ret60 == null ? '' : r.metrics.ret60.toFixed(2),
          r.metrics.volRatio == null ? '' : r.metrics.volRatio.toFixed(2),
          r.metrics.distHigh == null ? '' : r.metrics.distHigh.toFixed(2),
          `"${(r.signals || []).map((s) => s.text).join(' / ')}"`,
        ].join(',')
      );
    });
    const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `quantdesk_scan_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    toast('已导出 CSV');
  }

  // ------------------------------------------------------------ 回测

  function bindBacktest() {
    $('#btStrategy').addEventListener('change', () => {
      renderBtParams();
      const s = bt.STRATEGIES[$('#btStrategy').value];
      $('#btDesc').innerHTML = `<span class="callout-tag">策略</span><span class="callout-text"><b>${esc(
        s.name
      )}</b>：${esc(s.desc)}</span>`;
    });
    $('#btnBacktest').addEventListener('click', runBacktest);
  }

  function renderBtParams() {
    const s = bt.STRATEGIES[$('#btStrategy').value];
    $('#btParams').innerHTML = (s.params || [])
      .map(
        (p) =>
          `<label class="fld">${esc(p.label)}<input class="input num" data-pk="${p.key}" value="${p.def}" style="width:74px" /></label>`
      )
      .join('');
  }

  async function runBacktest() {
    const code = $('#btCode').value.trim().toUpperCase();
    if (!code) return toast('请输入代码');
    setStatus(true, '回测计算中…');
    $('#btnBacktest').disabled = true;
    try {
      const r = await qd.search(code);
      const hit = r.find((x) => x.code.toUpperCase() === code) || r[0];
      if (!hit) return toast('未找到该代码');
      const k = await qd.kline(hit.secid, {
        period: 'day',
        limit: Number($('#btRange').value),
        fq: Number(state.config.fq || 1),
      });
      if (!k || k.bars.length < 60) return toast('历史数据不足');

      const params = {};
      $$('#btParams [data-pk]').forEach((i) => (params[i.dataset.pk] = Number(i.value)));

      const res = bt.run({
        bars: k.bars,
        strategy: $('#btStrategy').value,
        params,
        initialCapital: Number($('#btCapital').value) || 100000,
        commission: (Number($('#btFee').value) || 0.05) / 100,
        slippage: 0.0005,
      });
      if (res.error) return toast(res.error);
      state.btResult = res;
      renderBacktest(res, k);
      toast('回测完成');
    } catch (e) {
      toast('回测失败：' + (e.message || '请稍后重试'));
    } finally {
      $('#btnBacktest').disabled = false;
      setStatus(false, '就绪');
    }
  }

  function renderBacktest(r, k) {
    $('#btResult').style.display = 'block';
    $('#btMeta').textContent = `${k.name || r.strategy} ${r.start} → ${r.end} · ${r.strategyName}`;

    const cards = [
      ['总收益率', pct(r.totalReturn), cls(r.totalReturn), `基准 ${pct(r.benchmark)}`],
      ['超额收益(α)', pct(r.alpha), cls(r.alpha), '相对买入持有'],
      ['年化收益', pct(r.annualized), cls(r.annualized), '复利折算'],
      ['最大回撤', '-' + r.maxDrawdown.toFixed(2) + '%', 'down', '峰值到谷底'],
      ['夏普比率', r.sharpe.toFixed(2), r.sharpe > 1 ? 'up' : '', '年化，无风险利率0'],
      ['胜率', r.winRate.toFixed(1) + '%', r.winRate > 50 ? 'up' : '', `共 ${r.tradeCount} 笔交易`],
      ['盈亏比', r.profitFactor === 99 ? '∞' : r.profitFactor.toFixed(2), r.profitFactor > 1 ? 'up' : 'down', '总盈利/总亏损'],
      ['平均持有', r.avgHoldDays.toFixed(1) + '天', '', `期末 $${f0(r.finalCapital)}`],
    ];
    $('#btMetrics').innerHTML = cards
      .map(
        ([k2, v, c, s]) =>
          `<div class="metric-card"><div class="k">${k2}</div><div class="v ${c}">${v}</div><div class="s">${s}</div></div>`
      )
      .join('');

    drawEquityPanel();

    const tb = $('#btTrades tbody');
    tb.innerHTML = (r.trades || [])
      .map(
        (t, i) =>
          `<tr><td class="muted">${i + 1}</td><td>${esc(t.date)}</td>
        <td class="${t.type === 'buy' ? 'up' : 'down'}">${t.type === 'buy' ? '买入' : '卖出'}${
            t.forced ? '(期末)' : ''
          }</td>
        <td>${f2(t.price)}</td><td>${f0(t.shares)}</td><td>${f0(t.amount)}</td>
        <td class="${t.profit == null ? '' : cls(t.profit)}">${
            t.profit == null ? '--' : (t.profit > 0 ? '+' : '') + f0(t.profit.toFixed(0))
          }</td>
        <td class="${t.profitPct == null ? '' : cls(t.profitPct)}">${t.profitPct == null ? '--' : pct(t.profitPct)}</td>
        <td>${t.holdDays == null ? '--' : t.holdDays}</td></tr>`
      )
      .join('');
    $('#btTradeMeta').textContent = `${r.trades.length} 笔记录`;
  }

  function drawEquityPanel() {
    if (!state.btResult) return;
    window.drawEquity(
      $('#equityCanvas'),
      state.btResult.equity,
      state.btResult.benchmark,
      state.btResult.initialCapital
    );
  }

  // ------------------------------------------------------------ 预警

  function bindAlerts() {
    $('#btnAddAlert').addEventListener('click', async () => {
      const code = $('#alCode').value.trim().toUpperCase();
      const value = Number($('#alValue').value);
      if (!code || !isFinite(value)) return toast('请填写代码与阈值');
      const r = await qd.search(code);
      const hit = r.find((x) => x.code.toUpperCase() === code) || r[0];
      if (!hit) return toast('未找到该代码');
      state.alerts = await qd.alertsAdd({ secid: hit.secid, code: hit.code, name: hit.name, type: $('#alType').value, value });
      $('#alCode').value = '';
      $('#alValue').value = '';
      renderAlerts();
      toast('预警已添加');
    });
  }

  function renderAlerts() {
    const box = $('#alertList');
    const TYPE = {
      above: (v) => `价格上破 ${v}`,
      below: (v) => `价格下破 ${v}`,
      pct_up: (v) => `当日涨幅超过 ${v}%`,
      pct_down: (v) => `当日跌幅超过 ${v}%`,
    };
    $('#alertMeta').textContent = `${state.alerts.length} 条`;
    if (!state.alerts.length) {
      box.innerHTML = '<div class="empty">暂无预警</div>';
      return;
    }
    box.innerHTML = state.alerts
      .map(
        (a) => `<div class="alert-item ${a.lastFire ? 'fired' : ''}">
        <span class="a-code">${esc(a.code)}</span>
        <span class="a-cond">${esc(TYPE[a.type] ? TYPE[a.type](a.value) : a.type)} <span class="muted">${
          a.lastFire ? '· 已于 ' + new Date(a.lastFire).toLocaleString('zh-CN') + ' 触发' : '· 监控中'
        }</span></span>
        <button class="btn sm danger" data-del="${esc(a.id)}">删除</button>
      </div>`
      )
      .join('');
    box.querySelectorAll('[data-del]').forEach((b) =>
      b.addEventListener('click', async () => {
        state.alerts = await qd.alertsRemove(b.dataset.del);
        renderAlerts();
      })
    );
  }

  function scheduleAlerts() {
    clearInterval(state.timers.alerts);
    state.timers.alerts = setInterval(checkAlerts, 30000);
  }

  async function checkAlerts() {
    if (!$('#alarmOn').checked || !state.alerts.length) return;
    const ids = [...new Set(state.alerts.map((a) => a.secid))];
    let quotes = [];
    try {
      quotes = await qd.quotes(ids, { maxAge: 20000, concurrency: 2 });
    } catch {
      return;
    }
    const map = new Map(quotes.map((q) => [q.secid, q]));
    const now = Date.now();
    for (const a of state.alerts) {
      const q = map.get(a.secid);
      if (!q || q.price == null) continue;
      let hit = false;
      let msg = '';
      if (a.type === 'above' && q.price > a.value) {
        hit = true;
        msg = `${a.code} 现价 ${f2(q.price)}，上破 ${a.value}`;
      } else if (a.type === 'below' && q.price < a.value) {
        hit = true;
        msg = `${a.code} 现价 ${f2(q.price)}，下破 ${a.value}`;
      } else if (a.type === 'pct_up' && q.changePct != null && q.changePct > a.value) {
        hit = true;
        msg = `${a.code} 涨幅 ${pct(q.changePct)}，超过 ${a.value}%`;
      } else if (a.type === 'pct_down' && q.changePct != null && q.changePct < -a.value) {
        hit = true;
        msg = `${a.code} 跌幅 ${pct(q.changePct)}，超过 ${a.value}%`;
      }
      if (hit && (!a.lastFire || now - a.lastFire > 600000)) {
        qd.notify('QuantDesk 预警触发', msg);
        state.alerts = await qd.alertsUpdate(a.id, { lastFire: now });
        renderAlerts();
      }
    }
  }

  // ------------------------------------------------------------ 设置

  function bindSettings() {
    $('#setFq').addEventListener('change', async () => {
      state.config = await qd.configUpdate({ fq: Number($('#setFq').value) });
      if (state.current) analyze(state.current, true);
      toast('复权方式已更新');
    });
    $('#setPeriod').addEventListener('change', () => {
      setPeriodUI($('#setPeriod').value);
      if (state.current) analyze(state.current, true);
    });
    $('#btnClearCache').addEventListener('click', async () => {
      await qd.clearCache();
      toast('缓存已清理');
    });
    $('#btnReset').addEventListener('click', async () => {
      if (!confirm('确定清空所有自选、预警与扫描结果？此操作不可恢复。')) return;
      await qd.storeSet('watchlist', DEFAULT_WATCH.slice());
      await qd.storeSet('alerts', []);
      await qd.storeSet('scanResults', null);
      state.watchlist = DEFAULT_WATCH.slice();
      state.alerts = [];
      state.scanResults = [];
      renderWatch();
      renderAlerts();
      renderScan();
      toast('已重置');
    });
  }

  // ------------------------------------------------------------ go

  document.addEventListener('DOMContentLoaded', boot);
})();
