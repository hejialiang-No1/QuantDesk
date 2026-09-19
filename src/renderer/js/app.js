/**
 * app.js —— 界面主控（v1.0.2）
 * 数据与算法来自两处：preload 注入的 window.qd（行情、指标、因子、回测、
 * 支撑压力位 / 交易计划 / 全面诊股 / 期权策略），以及 index.html 里本地加载的
 * 美股规则 / 绩效 / 税务 / 风控 / 模拟盘 / 券商 / 选股器 / 告警 八个模块
 * （本地加载是为了保住 class 的 new 语义，详见 index.html 里的注释）。
 */
(function () {
  const { ind, factors, bt } = window.qd;
  const Lv = window.qd.levels;
  const TradePlan = window.qd.tradeplan;
  const Diag = window.qd.diagnose;
  const Opt = window.qd.options;
  // ---- v1.0.2
  // 优先用渲染层本地加载的全局（index.html 里的 <script>），退回 contextBridge 注入的代理。
  // 必须优先本地：contextBridge 的函数代理不保留 class 的 new 语义，
  // 直接用 qd.paper 里的 PaperAccount 会报「cannot be invoked without 'new'」。
  const pick = (name, key) => window[name] || window.qd[key];
  const Mkt = pick('Market', 'market');
  const Perf = pick('Perf', 'perf');
  const Tax = pick('Tax', 'tax');
  const Risk = pick('Risk', 'risk');
  const Paper = pick('Paper', 'paper');
  const Broker = pick('Broker', 'broker');
  const Screener = pick('Screener', 'screener');
  const Alerts = pick('Alerts', 'alerts');
  // ---- v1.1.0
  const Newsfeed = pick('Newsfeed', 'newsfeed');
  const Events = pick('Events', 'events');
  const Insight = pick('Insight', 'insight');
  const Moonshot = pick('Moonshot', 'moonshot');

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

    // ---- v1.0.2
    paper: null,          // PaperAccount 实例
    paperMarks: {},       // 最近一次撮合用的 K 线（用于持仓现价）
    paperClocks: {},      // symbol → 最新收盘，用作持仓现价
    risk: null,           // Risk.evaluate 结果
    limits: {},           // 风控阈值
    rules: [],            // 告警规则
    audit: [],            // 审计日志
    channels: {},         // 渠道配置
    activeChannels: [],   // 启用的渠道
    monitor: { on: false, status: null },
    taxReport: null,
    taxForm: 'b1099',
    scanUniverse: 'sp500',
    brokerVenue: 'ibkr',

    // ---- v1.1.0 机会雷达
    radar: null,            // runRadar 的完整返回
    radarUniverse: 'highbeta',
    radarPick: null,        // 当前在看详情的标的 symbol
    radarNewsPick: null,    // 新闻面板当前标的
    radarSort: 'moonshot',
    radarGrade: '',
    preset: '',             // 选股页当前选中的预设策略
    scanColumns: 'classic', // 经典视图 / 因子视图
    screenResult: null,     // 最近一次预设筛选的结果
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
  // 名字叫 f0 就是「0 位小数」。原先写的是 toLocaleString('en-US')，
  // 默认最多保留 3 位小数，于是现金会显示成 $93,000.634 —— 金额/KPI 里不该有分以下的零头，
  // 而且大量调用点被迫写成 f0(x.toFixed(0)) 绕开它。这里直接把口径定死。
  const f0 = (v) => (v == null || !isFinite(v) ? '--' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 }));
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
    bindRadar();
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
    $('#btFee').value = ((state.config.commission || 0.0005) * 100).toFixed(2);

    const info = await qd.appInfo();
    $('#footVer').textContent = `v${info.version} · Electron ${info.electron}`;
    $('#aboutKpi').innerHTML = [
      ['版本', 'v' + info.version],
      ['Electron', info.electron],
      ['Node', info.node],
      ['架构', info.arch],
      ['模块', '19 个算法模块'],
      ['数据', '本地计算 · 不上传'],
    ]
      .map(([k, v]) => `<div class="kpi"><div class="k">${k}</div><div class="v sm">${esc(v)}</div></div>`)
      .join('');

    // v1.1.0：预设策略与机会雷达的初始化（放在股票池数据就绪之后）
    initScanPresets();
    initRadarUniverse();
    // 恢复上次的机会雷达结果（不必重新扫一遍就能看）
    try {
      const last = await qd.radarLast();
      if (last && last.rows) {
        state.radar = last;
        state.radarPick = (last.rows[0] || {}).symbol || null;
        state.radarNewsPick = state.radarPick;
        renderRadarAll();
      }
    } catch {
      /* 没有历史结果就保持空状态 */
    }

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

    // ---- v1.0.2 接线
    bindPaper();
    bindRisk();
    bindMonitor();
    bindTax();
    initScanUniverse();
    await initBacktestExtras();
    await initPaper();
    await initRisk();
    await initMonitor();
    await initTax();

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
      // v1.0.2：给自检探针读取的核心状态（只读快照，不是引用）
      paper: () => (state.paper ? JSON.parse(JSON.stringify(state.paper.toJSON())) : null),
      risk: () => (state.risk ? { level: state.risk.level, score: state.risk.score, blocks: state.risk.blocks.length, warns: state.risk.warns.length, checks: state.risk.checks.length } : null),
      tax: () => (state.taxReport ? { year: state.taxReport.year, lots: state.taxReport.lots.length, taxable: state.taxReport.summary.taxablePnl } : null),
      rules: () => state.rules.length,
      channels: () => state.activeChannels.length,
      monitor: () => state.monitor,
      limits: () => Object.keys(state.limits).length,
      // 回测探针：截图/自检需要知道「按钮点了到底跑没跑出结果」，
      // 光看画面是空的根本分不清是「没点」还是「跑了但失败」。
      bt: () =>
        state.btResult
          ? {
              strategy: state.btResult.strategy,
              name: state.btResult.strategyName,
              totalReturn: state.btResult.totalReturn,
              trades: state.btResult.tradeCount,
              bars: state.btBarsCount || 0,
            }
          : null,
      submit: (o) => paperSubmit(o), // 自检专用：走真实下单路径
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
        // v1.0.2：进入这些视图时按当前状态重画一次，避免看到过期数据
        if (v === 'paper') renderPaper();
        if (v === 'risk') { refreshRisk(); }
        if (v === 'alerts') { renderDashboard(); renderAnomalies(); renderRules(); renderAudit(); }
        if (v === 'tax') renderTax();
        // v1.1.0：机会雷达按当前状态重画，不重复发起网络请求
        if (v === 'radar') renderRadarAll();
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
    $('#scanColumns').addEventListener('change', () => {
      state.scanColumns = $('#scanColumns').value;
      renderScan();
    });
    // 排序表头由 bindScanSort() 绑定 —— 表头会随视图切换被重建，
    // 如果在 bindScan 里绑一次就固定住了，切回经典视图后列头会点不动。
    bindScanSort();
  }

  /** 填充 screener.js 的股票池下拉与因子图例 */
  function initScanUniverse() {
    const us = Screener.universes(state.watchlist.map((w) => w.code));
    const keys = Object.keys(us);
    $('#scanUniverse').innerHTML = keys
      .map((k) => `<option value="${esc(k)}">${esc(us[k].label)} · ${us[k].codes.length} 只</option>`)
      .join('');
    // 默认选池子里成分最多的那个（通常是标普 500 权重股）
    const best = keys.slice().sort((a, b) => us[b].codes.length - us[a].codes.length)[0];
    state.scanUniverse = best;
    $('#scanUniverse').value = best;

    const TYPE = {
      price: { label: '价格实算', tone: 'ok' },
      partial: { label: '部分口径', tone: 'mid' },
      proxy: { label: '代理口径', tone: 'warn' },
    };
    $('#scanFactorLegend').innerHTML = Screener.FACTORS.map((f) => {
      const t = TYPE[f.type] || TYPE.price;
      return `<div class="fl-item" title="${esc(f.detail)}">
        <span class="fl-name">${esc(f.label)}</span>
        <span class="fl-type ${t.tone}">${t.label}</span>
        <span class="fl-desc">${esc(f.desc)}</span>
      </div>`;
    }).join('');
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
        universe: $('#scanUniverse').value,
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

  // 因子视图使用的列定义（顺序即渲染顺序）。抽成常量是为了让表头与单元格
  // 永远用同一份定义驱动 —— 分两处各写一遍是最容易错位的做法。
  const FACTOR_COLS = [
    { key: 'composite', label: '综合' },
    { key: 'trend', label: '趋势' },
    { key: 'breakout', label: '突破' },
    { key: 'volumeSurge', label: '量能' },
    { key: 'elasticity', label: '弹性' },
    { key: 'compression', label: '压缩' },
    { key: 'liquidity', label: '流动性' },
    { key: 'relativeStrength', label: '相对强度' },
  ];

  function renderScan() {
    const minScore = Number($('#scanFilter').value);
    let rows = state.scanResults.filter((r) => r.score >= minScore);
    const { key, dir } = state.scanSort;

    // ---- v1.1.0：预设策略筛选
    let screenRes = null;
    if (state.preset) {
      screenRes = applyPresetFilter();
      if (screenRes && screenRes.empty) {
        rows = [];
      } else if (screenRes) {
        // 用「代码集合」做交集，这样表格拿到的仍然是完整的扫描结果对象，
        // 不需要为因子视图另外准备一份数据
        const allow = new Set(screenRes.rows.map((x) => String(x.symbol).toUpperCase()));
        rows = rows.filter((r) => allow.has(String(r.code).toUpperCase()));
      }
    }

    const factorView = state.scanColumns === 'factors' && rows.some((r) => r.factor);

    if (factorView) {
      rows = rows.slice().sort((a, b) => ((b.factor || {}).composite || 0) - ((a.factor || {}).composite || 0));
    } else {
      const getter = (r) => (key === 'rsi' || key === 'ret20' || key === 'volRatio' ? r.metrics[key] : r[key]);
      rows = rows.slice().sort((a, b) => {
        const va = getter(a);
        const vb = getter(b);
        if (va == null) return 1;
        if (vb == null) return -1;
        return dir * (va - vb);
      });
    }
    state.scanViewRows = rows;

    // 筛选摘要（让用户始终知道「现在看到的这一屏是怎么筛出来的」）
    const sumBox = $('#screenSummary');
    if (screenRes) {
      sumBox.style.display = 'block';
      if (screenRes.empty) {
        sumBox.innerHTML = `<b>${esc(screenRes.summary)}</b>`;
      } else {
        const p = screenRes.preset || {};
        const conds = (p && p.key ? Screener.PRESET_MAP[p.key].filters : [])
          .map((f) => `${(Screener.FACTOR_MAP[f.factor] || {}).label || f.factor}${f.min != null ? ' ≥ ' + f.min : ''}`)
          .join(' · ');
        sumBox.innerHTML =
          `<b>${esc(p.label || '预设')}</b>：${esc(screenRes.summary)}` +
          `<br/>门槛：${esc(conds)}　｜　最大风险提示：<span style="color:var(--orange)">${esc(p.watchOut || '--')}</span>`;
      }
    } else {
      sumBox.style.display = 'none';
      sumBox.innerHTML = '';
    }

    // 表头（两套视图）
    const thead = $('#scanTable thead');
    if (factorView) {
      thead.innerHTML = `<tr><th>#</th><th>代码 / 名称</th>${
        FACTOR_COLS.map((c) => `<th>${esc(c.label)}</th>`).join('')
      }<th>PE</th><th>操作</th></tr>`;
    } else {
      thead.innerHTML = `<tr>
        <th>#</th><th>代码 / 名称</th>
        <th data-sort="score">评分</th><th>评级</th>
        <th data-sort="price">现价</th><th data-sort="changePct">涨跌幅</th>
        <th data-sort="rsi">RSI</th><th data-sort="ret20">20日涨幅</th><th data-sort="volRatio">量比</th>
        <th>信号</th><th>操作</th></tr>`;
      bindScanSort();
    }

    const tb = $('#scanTable tbody');
    $('#scanEmpty').style.display = rows.length ? 'none' : 'block';
    tb.innerHTML = rows
      .map((r, i) => {
        const f = r.factor || null;
        if (factorView) {
          return `<tr>
            <td class="muted">${i + 1}</td>
            <td><span class="code" data-open="${esc(r.secid)}" data-code="${esc(r.code)}">${esc(r.code)}</span> <span class="name">${esc(r.name || '')}</span></td>
            <td><b>${f ? f.composite : '--'}</b></td>
            ${FACTOR_COLS.slice(1)
              .map((c) => `<td>${f && f.scores ? miniBar(f.scores[c.key]) : '<span class="muted">--</span>'}</td>`)
              .join('')}
            <td>${r.pe == null ? '--' : Number(r.pe).toFixed(1)}</td>
            <td><button class="btn sm" data-add="${esc(r.secid)}|${esc(r.code)}|${esc(r.name || '')}">加自选</button></td>
          </tr>`;
        }
        const rt = factors.rating(r.score);
        const color = r.score >= 66 ? 'var(--up)' : r.score >= 52 ? 'var(--orange)' : 'var(--gray)';
        return `<tr>
          <td class="muted">${i + 1}</td>
          <td><span class="code" data-open="${esc(r.secid)}" data-code="${esc(r.code)}">${esc(
          r.code
        )}</span> <span class="name">${esc(r.name || '')}</span>${
          f ? ` <span class="tag gray" title="多因子综合分">因子 ${f.composite}</span>` : ''
        }</td>
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

  /** 经典视图的排序表头（重建表头后必须重新绑定，否则点列头没反应） */
  function bindScanSort() {
    $$('#scanTable th[data-sort]').forEach((th) => {
      th.addEventListener('click', () => {
        const k = th.dataset.sort;
        state.scanSort.dir = state.scanSort.key === k ? -state.scanSort.dir : -1;
        state.scanSort.key = k;
        renderScan();
      });
    });
  }

  function exportCsv() {
    if (!state.scanResults.length) return toast('没有可导出的结果');
    // v1.1.0：导出「当前屏幕上看到的这一屏」（含预设筛选与排序），
    // 而不是全量结果 —— 否则导出的 CSV 和界面对不上，复核时会怀疑是哪边错了。
    const rows = state.scanViewRows && state.scanViewRows.length ? state.scanViewRows : state.scanResults;
    const fcols = FACTOR_COLS.concat([{ key: 'reversal', label: '反转' }, { key: 'health', label: '回撤健康度' }]);
    const head = ['排名', '代码', '名称', '评分', '评级', '现价', '涨跌幅', 'RSI', '20日涨幅', '60日涨幅', '量比', '距高点', '信号']
      .concat(fcols.map((c) => '因子_' + c.label));
    const lines = [head.join(',')];
    rows.forEach((r, i) => {
      const f = r.factor;
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
        ]
          .concat(fcols.map((c) => (f && f.scores && f.scores[c.key] != null ? f.scores[c.key] : '')))
          .join(',')
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
    $('#btOrderType').addEventListener('change', () => {
      const o = bt.ORDER_MODES.find((x) => x.key === $('#btOrderType').value);
      if (o) {
        $('#btDesc').innerHTML = `<span class="callout-tag">订单类型</span><span class="callout-text"><b>${esc(
          o.label
        )}</b>：${esc(o.desc)}</span>`;
      }
    });
    $('#btnBacktest').addEventListener('click', runBacktest);
    $('#btnParamScan').addEventListener('click', runParamScan);
    $('#btnCompare').addEventListener('click', runCompare);
  }

  /** 订单类型与基准下拉：直接从算法模块取，避免界面与引擎枚举对不上 */
  async function initBacktestExtras() {
    $('#btOrderType').innerHTML = bt.ORDER_MODES
      .map((o) => `<option value="${esc(o.key)}">${esc(o.label)}</option>`)
      .join('');
    $('#btOrderType').value = state.config.orderType || 'market';
    $('#btFeeModel').value = state.config.useUsFees === false ? 'simple' : 'us';
    $('#btBench').innerHTML = Perf.BENCHMARKS
      .map((b) => `<option value="${esc(b.key)}">${esc(b.name)}（${esc(b.key)}）</option>`)
      .join('');
    $('#btBench').value = state.config.benchName || 'SPY';
    $('#btStopLoss').value = state.config.exitStopLoss || 0;
    $('#btTakeProfit').value = state.config.exitTakeProfit || 0;
    $('#btTrailing').value = state.config.exitTrailing || 0;
    $('#btMaxHold').value = state.config.exitMaxHold || 0;
    $('#btConstraints').checked = state.config.constraintsOn !== false;
    $('#taxYear').value = String(new Date().getFullYear());
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

  /** 把界面上的设置收拢成一份回测参数 */
  function backtestOpts(k) {
    const params = {};
    $$('#btParams [data-pk]').forEach((i) => (params[i.dataset.pk] = Number(i.value)));
    const useUs = $('#btFeeModel').value === 'us';
    return {
      bars: k.bars,
      strategy: $('#btStrategy').value,
      params,
      initialCapital: Number($('#btCapital').value) || 100000,
      commission: (Number($('#btFee').value) || 0.05) / 100,
      slippage: state.config.slippage || 0.0005,
      orderType: $('#btOrderType').value,
      fees: { model: useUs ? 'us' : 'simple' },
      exit: {
        stopLossPct: Number($('#btStopLoss').value) || 0,
        takeProfitPct: Number($('#btTakeProfit').value) || 0,
        trailingPct: Number($('#btTrailing').value) || 0,
        maxHoldDays: Number($('#btMaxHold').value) || 0,
      },
      constraints: {
        enabled: $('#btConstraints').checked,
        accountSize: Number($('#btCapital').value) || 100000,
      },
      benchName: $('#btBench').value,
      symbol: k.code || null,
    };
  }

  async function loadBtBars() {
    const code = $('#btCode').value.trim().toUpperCase();
    if (!code) {
      toast('请输入代码');
      return null;
    }
    const r = await qd.search(code);
    const hit = r.find((x) => x.code.toUpperCase() === code) || r[0];
    if (!hit) {
      toast('未找到该代码');
      return null;
    }
    const k = await qd.kline(hit.secid, {
      period: 'day',
      limit: Number($('#btRange').value),
      fq: Number(state.config.fq || 1),
    });
    if (!k || k.bars.length < 60) {
      toast('历史数据不足');
      return null;
    }
    // 基准也要拿到真实K线，否则信息比率一类指标算不出来
    let benchBars = null;
    try {
      const b = Perf.BENCHMARKS.find((x) => x.key === $('#btBench').value);
      if (b) {
        const bk = await qd.kline(b.secid, { period: 'day', limit: Number($('#btRange').value), fq: 1 });
        if (bk && bk.bars && bk.bars.length > 30) benchBars = bk.bars;
      }
    } catch {
      /* 基准拿不到就不算相对指标，不编造 */
    }
    return { k, hit, benchBars };
  }

  async function runBacktest() {
    setStatus(true, '回测计算中…');
    $('#btnBacktest').disabled = true;
    try {
      const ctx = await loadBtBars();
      if (!ctx) return;
      const opts = backtestOpts(ctx.k);
      opts.benchBars = ctx.benchBars;
      const res = bt.run(opts);
      if (res.error) return toast(res.error);
      state.btResult = res;
      renderBacktest(res, ctx.k);
      // 记下这次用的口径，下次打开还是同一套
      qd.configUpdate({
        orderType: opts.orderType,
        useUsFees: opts.fees.model === 'us',
        benchName: opts.benchName,
        exitStopLoss: opts.exit.stopLossPct,
        exitTakeProfit: opts.exit.takeProfitPct,
        exitTrailing: opts.exit.trailingPct,
        exitMaxHold: opts.exit.maxHoldDays,
        constraintsOn: opts.constraints.enabled,
      });
      toast('回测完成');
    } catch (e) {
      toast('回测失败：' + (e.message || '请稍后重试'));
    } finally {
      $('#btnBacktest').disabled = false;
      setStatus(false, '就绪');
    }
  }

  async function runParamScan() {
    const strategy = $('#btStrategy').value;
    const s = bt.STRATEGIES[strategy];
    if (!s.params || !s.params.length) return toast('该策略没有可扫描的参数');
    setStatus(true, '参数扫描中…');
    $('#btnParamScan').disabled = true;
    try {
      const ctx = await loadBtBars();
      if (!ctx) return;
      // 参数网格：以当前界面值为中心上下取几档
      const space = {};
      s.params.forEach((p) => {
        const cur = Number($(`#btParams [data-pk="${p.key}"]`).value) || p.def;
        const step = Math.max(1, Math.round(cur * 0.25));
        const vals = [...new Set([cur - step * 2, cur - step, cur, cur + step, cur + step * 2])].filter((v) => v > 0);
        space[p.key] = vals;
      });
      const res = Screener.paramScan(ctx.k.bars, strategy, space, {
        backtestFn: bt,
        metric: $('#psMetric').value,
        initialCapital: Number($('#btCapital').value) || 100000,
      });
      if (res.error) return toast(res.error);
      renderParamScan(res);
      toast(`已扫描 ${res.valid} 个参数组合`);
    } catch (e) {
      toast('参数扫描失败：' + (e.message || ''));
    } finally {
      $('#btnParamScan').disabled = false;
      setStatus(false, '就绪');
    }
  }

  async function runCompare() {
    setStatus(true, '多策略对比中…');
    $('#btnCompare').disabled = true;
    try {
      const ctx = await loadBtBars();
      if (!ctx) return;
      const res = Screener.compare(ctx.k.bars, Object.keys(bt.STRATEGIES), {
        backtestFn: bt,
        initialCapital: Number($('#btCapital').value) || 100000,
      });
      if (res.error) return toast(res.error);
      renderCompare(res);
      toast('对比完成');
    } catch (e) {
      toast('对比失败：' + (e.message || ''));
    } finally {
      $('#btnCompare').disabled = false;
      setStatus(false, '就绪');
    }
  }

  function renderParamScan(res) {
    $('#psResult').style.display = 'block';
    $('#psMeta').textContent = `${res.strategy} · 指标 ${res.metric} · ${res.valid}/${res.combos} 个组合有效`;
    const v = $('#psVerdict');
    v.className = 'callout ' + (res.robust ? 'down' : 'warn');
    v.innerHTML = `<span class="callout-tag">${res.robust ? '参数面平坦' : '疑似过拟合'}</span><span class="callout-text">${esc(res.verdict)}<br><span class="muted">${esc(res.warning)}</span><br>均值 ${res.stats.avg} · 标准差 ${res.stats.stdev} · 最优 ${res.stats.best} · 最差 ${res.stats.worst} · 优于均值比例 ${res.stats.aboveAverageRatio}%</span>`;
    $('#psTable tbody').innerHTML = res.results
      .slice(0, 60)
      .map(
        (r, i) => `<tr>
        <td class="muted">${i + 1}</td>
        <td style="text-align:left" class="mono">${esc(r.label)}</td>
        <td class="${cls(r.totalReturn)}">${pct(r.totalReturn)}</td>
        <td class="${cls(r.annualized)}">${pct(r.annualized)}</td>
        <td class="down">-${f2(r.maxDrawdown)}%</td>
        <td>${f2(r.sharpe)}</td>
        <td>${f2(r.winRate)}%</td>
        <td>${r.profitFactor === 99 ? '∞' : f2(r.profitFactor)}</td>
        <td>${r.tradeCount}</td>
      </tr>`
      )
      .join('');
  }

  function renderCompare(res) {
    $('#cmpResult').style.display = 'block';
    $('#cmpMeta').textContent = `${res.count || 0} 个策略 · ${res.summary || ''}`;
    $('#cmpTable tbody').innerHTML = (res.rows || [])
      .map(
        (r) => `<tr>
        <td style="text-align:left"><b>${esc(r.name || r.key)}</b></td>
        <td class="${cls(r.totalReturn)}">${pct(r.totalReturn)}</td>
        <td class="${cls(r.annualized)}">${pct(r.annualized)}</td>
        <td class="down">-${f2(r.maxDrawdown)}%</td>
        <td>${f2(r.sharpe)}</td>
        <td>${f2(r.winRate)}%</td>
        <td>${r.profitFactor === 99 ? '∞' : f2(r.profitFactor)}</td>
        <td>${r.tradeCount}</td>
        <td>${pct(r.benchmark)}</td>
        <td class="${cls(r.alpha)}">${pct(r.alpha)}</td>
      </tr>`
      )
      .join('');
  }

  function renderBacktest(r, k) {
    $('#btResult').style.display = 'block';
    $('#btMeta').textContent = `${k.name || r.symbol || r.strategy} ${r.start} → ${r.end} · ${r.strategyName} · ${r.orderTypeLabel || ''}`;

    // 主指标卡直接用 perf.js 的统一口径，避免「回测一套、看板另一套」
    const cards = r.perf
      ? Perf.cards(r.perf)
      : [
          ['总收益率', pct(r.totalReturn), cls(r.totalReturn), `基准 ${pct(r.benchmark)}`],
          ['年化收益', pct(r.annualized), cls(r.annualized), '复利折算'],
          ['最大回撤', '-' + f2(r.maxDrawdown) + '%', 'down', '峰值到谷底'],
          ['夏普比率', f2(r.sharpe), r.sharpe > 1 ? 'up' : '', '年化，无风险利率0'],
        ];
    $('#btMetrics').innerHTML = cards
      .map(
        (c) =>
          `<div class="metric-card"><div class="k">${esc(c.label)}</div><div class="v ${c.tone || ''}">${esc(
            c.value
          )}</div><div class="s">${esc(c.sub || '')}</div></div>`
      )
      .join('');

    $('#btExtras').innerHTML = renderBtExtras(r);

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
        <td>${t.holdDays == null ? '--' : t.holdDays}</td>
        <td class="muted" style="text-align:left">${esc(t.exitReason || '—')}</td></tr>`
      )
      .join('');
    $('#btTradeMeta').textContent = `${r.trades.length} 笔记录`;
  }

  /** 费用分项 / 约束命中 / 离场归因 / 归因拆解 */
  function renderBtExtras(r) {
    const parts = [];

    // ---- 费用分项
    if (r.fees) {
      const f = r.fees;
      const rows =
        f.model === 'us'
          ? [
              ['佣金', f.commission],
              ['SEC Section 31', f.sec],
              ['FINRA TAF', f.taf],
              ['交易所费', f.exchange],
              ['清算费', f.clearing],
              ['CAT 费', f.cat],
              ['买卖价差', f.spread],
            ]
          : [['手续费（简单口径）', f.commission]];
      parts.push(`<div class="panel inset">
        <div class="panel-hd"><h3>交易成本拆解</h3><span class="desc">${
          f.model === 'us' ? '美股真实分项' : '简单手续费率'
        } · 合计 $${f2(f.total)}（占本金 ${f2(f.totalPctOfCapital)}%）</span></div>
        <div class="panel-bd">
          <div class="kpi-grid">${rows
            .map(([k, v]) => `<div class="kpi"><div class="k">${k}</div><div class="v sm">$${f2(v)}</div></div>`)
            .join('')}</div>
          <div class="fine-print" style="margin-top:10px">${esc(f.note || '')}</div>
        </div>
      </div>`);
    }

    // ---- 约束命中
    if (r.constraints) {
      const c = r.constraints;
      const tone = c.blockedByPDT || c.blockedBySSR ? 'warn' : 'info';
      parts.push(`<div class="panel inset">
        <div class="panel-hd"><h3>美股规则约束</h3><span class="desc">T+1 / PDT / SSR / 部分成交</span></div>
        <div class="panel-bd">
          <div class="kpi-grid">
            ${[
              ['PDT 拦截', c.blockedByPDT + ' 次', c.blockedByPDT ? 'warn' : ''],
              ['SSR 拦截', c.blockedBySSR + ' 次', c.blockedBySSR ? 'warn' : ''],
              ['部分成交', c.partialFills + ' 次', ''],
              ['日内交易', c.dayTrades + ' 次', ''],
              ['单票上限', f2(c.maxPositionPct) + '%', ''],
              ['约束开关', c.pdtEnabled ? '已启用' : '已关闭', ''],
            ]
              .map(
                ([k, v, t]) => `<div class="kpi"><div class="k">${k}</div><div class="v sm ${t}">${v}</div></div>`
              )
              .join('')}
          </div>
          <div class="callout ${tone}" style="margin-top:10px"><span class="callout-tag">口径说明</span><span class="callout-text">${esc(
            c.note || ''
          )}</span></div>
        </div>
      </div>`);
    }

    // ---- 离场归因
    if (r.byExit && r.byExit.length) {
      parts.push(`<div class="panel inset">
        <div class="panel-hd"><h3>离场原因归因</h3><span class="desc">止损到底有没有替你省钱，看这张表</span></div>
        <div class="panel-bd tight">
          <div class="table-scroll"><table class="grid compact">
            <thead><tr><th>离场原因</th><th>笔数</th><th>盈利笔数</th><th>胜率</th><th>合计盈亏</th></tr></thead>
            <tbody>${r.byExit
              .map(
                (b) => `<tr>
              <td style="text-align:left">${esc(b.reason)}</td>
              <td>${b.count}</td>
              <td>${b.wins}</td>
              <td>${b.count ? ((b.wins / b.count) * 100).toFixed(1) : '0.0'}%</td>
              <td class="${cls(b.profit)}">${(b.profit > 0 ? '+' : '') + f0(b.profit.toFixed(0))}</td>
            </tr>`
              )
              .join('')}</tbody>
          </table></div>
        </div>
      </div>`);
    }

    // ---- 归因与风险
    const p = r.perf;
    if (p && p.attribution) {
      const a = p.attribution;
      const dd = p.drawdown || {};
      const v9 = p.var95 || {};
      parts.push(`<div class="panel inset">
        <div class="panel-hd"><h3>归因与回撤</h3><span class="desc">收益从哪来、风险有多深</span></div>
        <div class="panel-bd">
          <div class="kpi-grid">
            ${[
              ['最大回撤', '-' + f2(dd.maxDrawdown) + '%', 'down'],
              ['回撤谷底', dd.troughDate || '--', ''],
              ['回撤持续', (dd.drawdownDays == null ? '--' : dd.drawdownDays + ' 天'), ''],
              ['恢复用时', dd.recovered ? (dd.recoveryDays == null ? '--' : dd.recoveryDays + ' 天') : '尚未恢复', dd.recovered ? '' : 'warn'],
              ['最长水下', (dd.longestUnderwaterDays == null ? '--' : dd.longestUnderwaterDays + ' 天'), ''],
              ['单日 VaR95', v9.var == null ? '--' : f2(v9.var) + '%', 'warn'],
              ['择时贡献', a.timing == null ? '--' : f0(a.timing.toFixed(0)), cls(a.timing)],
              ['选股贡献', a.selection == null ? '--' : f0(a.selection.toFixed(0)), cls(a.selection)],
              ['换手率(年化)', p.turnover && p.turnover.annual != null ? f2(p.turnover.annual) + '%' : '--', ''],
              ['成本拖累', p.turnover && p.turnover.costDrag != null ? f2(p.turnover.costDrag) + '%' : '--', 'warn'],
              ['Beta', p.vs && p.vs.beta != null ? f2(p.vs.beta) : '--', ''],
              ['超额收益', p.excessReturn == null ? '--' : pct(p.excessReturn), cls(p.excessReturn)],
            ]
              .map(([k, v, t]) => `<div class="kpi"><div class="k">${k}</div><div class="v sm ${t}">${esc(String(v))}</div></div>`)
              .join('')}
          </div>
          ${
            a.topContributor
              ? `<div class="row" style="margin-top:10px;gap:16px;flex-wrap:wrap">
                  <span class="pill up">贡献最大 ${esc(a.topContributor.symbol || '—')} ${
                  a.topContributor.profit != null ? (a.topContributor.profit > 0 ? '+' : '') + f0(a.topContributor.profit.toFixed(0)) : ''
                }</span>
                  <span class="pill down">拖累最大 ${esc(a.worstContributor ? a.worstContributor.symbol || '—' : '—')} ${
                  a.worstContributor && a.worstContributor.profit != null ? (a.worstContributor.profit > 0 ? '+' : '') + f0(a.worstContributor.profit.toFixed(0)) : ''
                }</span>
                  ${
                    a.concentration
                      ? `<span class="pill subtle">集中度 ${esc(a.concentration.level || '')}（前 1 占 ${
                          a.concentration.top1Pct == null ? '--' : f2(a.concentration.top1Pct) + '%'
                        }）</span>`
                      : ''
                  }
                </div>`
              : ''
          }
          <div class="fine-print" style="margin-top:10px">${esc(
            p.vs
              ? `相对 ${p.benchName || '基准'}：Beta ${f2(p.vs.beta)} · Alpha ${pct(p.vs.alpha)} · 跟踪误差 ${f2(
                  p.vs.trackingError
                )}% · 信息比率 ${f2(p.vs.infoRatio)} · 相关性 ${f2(p.vs.corr)}（基准共 ${p.vs.benchDays} 个交易日）`
              : '相对指标需要基准数据；基准K线拿不到时这里留空而不是瞎填 —— 宁可少一个数，也不要一个错的数。'
          )}</div>
        </div>
      </div>`);
    }

    // ---- 交易统计细节
    if (p && p.trades) {
      const t = p.trades;
      parts.push(`<div class="panel inset">
        <div class="panel-hd"><h3>交易统计</h3><span class="desc">胜率之外的细节</span></div>
        <div class="panel-bd">
          <div class="kpi-grid">
            ${[
              ['期望值/笔', t.expectancy == null ? '--' : f0(t.expectancy.toFixed(0))],
              ['盈亏比', t.payoffRatio == null ? '--' : f2(t.payoffRatio)],
              ['平均盈利', t.avgWin == null ? '--' : f0(t.avgWin.toFixed(0))],
              ['平均亏损', t.avgLoss == null ? '--' : f0(t.avgLoss.toFixed(0))],
              ['毛利合计', t.grossProfit == null ? '--' : f0(t.grossProfit.toFixed(0))],
              ['毛亏合计', t.grossLoss == null ? '--' : f0(t.grossLoss.toFixed(0))],
              ['最大连盈', t.maxWinStreak == null ? '--' : t.maxWinStreak + ' 笔'],
              ['最大连亏', t.maxLossStreak == null ? '--' : t.maxLossStreak + ' 笔'],
              ['最好一笔', t.bestTrade == null ? '--' : f0(t.bestTrade.toFixed(0))],
              ['最差一笔', t.worstTrade == null ? '--' : f0(t.worstTrade.toFixed(0))],
              ['平均持有', t.avgHoldDays == null ? '--' : f2(t.avgHoldDays) + ' 天'],
              ['交易笔数', t.count == null ? '--' : t.count + ' 笔'],
            ]
              .map(([k, v]) => `<div class="kpi"><div class="k">${k}</div><div class="v sm">${esc(String(v))}</div></div>`)
              .join('')}
          </div>
          ${
            t.byHold && t.byHold.length
              ? `<div class="table-scroll" style="margin-top:12px"><table class="grid compact">
                  <thead><tr><th>持有期</th><th>笔数</th><th>胜率</th><th>合计盈亏</th></tr></thead>
                  <tbody>${t.byHold
                    .map(
                      (b) => `<tr><td style="text-align:left">${esc(b.label || '')}</td><td>${b.count}</td>
                      <td>${f2(b.winRate)}%</td>
                      <td class="${cls(b.totalProfit)}">${(b.totalProfit > 0 ? '+' : '') + f0(b.totalProfit.toFixed(0))}</td></tr>`
                    )
                    .join('')}</tbody>
                </table></div>`
              : ''
          }
        </div>
      </div>`);
    }

    return parts.join('');
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
    // v1.0.2：预警类型统一到 alerts.js 的规则枚举，避免「页面监控」与「后台监控」两套口径
    const T = (a) => Alerts.RULE_MAP[a.type] || { label: a.type, unit: '' };
    $('#alertMeta').textContent = `${state.alerts.length} 条`;
    if (!state.alerts.length) {
      box.innerHTML = '<div class="empty">暂无预警</div>';
      return;
    }
    box.innerHTML = state.alerts
      .map((a) => {
        const t = T(a);
        const shown = t.unit === '$' ? `$${a.value}` : `${a.value}${t.unit || ''}`;
        return `<div class="alert-item ${a.lastFire ? 'fired' : ''}">
        <span class="a-code">${esc(a.code)}</span>
        <span class="a-cond">${esc(t.label)} ${esc(shown)} <span class="muted">${
          a.lastFire ? '· 已于 ' + new Date(a.lastFire).toLocaleString('zh-CN') + ' 触发' : '· 监控中'
        }</span></span>
        <button class="btn sm danger" data-del="${esc(a.id)}">删除</button>
      </div>`;
      })
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
    const byCode = {};
    for (const q of quotes) {
      byCode[String(q.code).toUpperCase()] = {
        price: q.price,
        changePct: q.changePct,
        volume: q.amount,
        high: q.high,
        low: q.low,
        prevClose: q.prevClose,
      };
    }
    const now = Date.now();
    for (const a of state.alerts) {
      // 用同一份规则求值函数，页面上看到的判定逻辑与后台轮询完全一致
      const hit = Alerts.evalRule(
        { id: a.id, type: a.type, symbol: a.code, value: a.value, severity: 'medium', enabled: true },
        { quotes: byCode }
      );
      if (hit && (!a.lastFire || now - a.lastFire > 600000)) {
        qd.notify('QuantDesk 预警触发', `${hit.title}\n${hit.detail}`);
        state.alerts = await qd.alertsUpdate(a.id, { lastFire: now });
        renderAlerts();
      }
    }
  }

  // ============================================================
  //  模拟交易（v1.0.2）
  // ============================================================

  function bindPaper() {
    // 订单类型下拉按 group 分组呈现，并带上交易所的时段限制说明
    const groups = {};
    Mkt.ORDER_TYPES.forEach((o) => {
      (groups[o.group] = groups[o.group] || []).push(o);
    });
    $('#poType').innerHTML = Object.entries(groups)
      .map(
        ([g, list]) =>
          `<optgroup label="${esc(g)}">${list
            .map((o) => `<option value="${esc(o.key)}" title="${esc(o.desc)}">${esc(o.name)}</option>`)
            .join('')}</optgroup>`
      )
      .join('');
    $('#poType').value = 'market';

    $('#btnPaperOrder').addEventListener('click', () => paperSubmitFromForm());
    $('#btnPaperCancelAll').addEventListener('click', () => {
      const n = state.paper ? state.paper.cancelAll() : 0;
      toast(`已撤销 ${n} 笔挂单`);
      afterPaperChange();
    });
    $('#btnPaperMark').addEventListener('click', paperMark);
    $('#btnPaperSettle').addEventListener('click', () => {
      if (!state.paper) return;
      const r = state.paper.settle(todayStr());
      toast(r.released > 0 ? `结算释放 $${f2(r.released)}` : '暂无到期结算资金');
      afterPaperChange();
    });
    $('#btnPaperReset').addEventListener('click', async () => {
      const cash = Number($('#paperCash').value) || 100000;
      if (!confirm(`确定重置模拟账户？资金回到 $${cash}，所有持仓与流水清空。`)) return;
      state.paper = new Paper.PaperAccount(paperOpts(cash));
      state.paperClocks = {};
      await qd.paperSave(state.paper.toJSON());
      afterPaperChange();
      toast('模拟账户已重置');
    });
    $('#btnPaperImport').addEventListener('click', async () => {
      if (!state.btResult || !state.btResult.trades.length) return toast('先跑一次回测，才能导入成交');
      const r = Paper.importTrades(state.paper, state.btResult.trades, { symbol: state.btResult.symbol });
      afterPaperChange();
      toast(`已导入 ${r.imported} 笔成交（注意：这不是撮合产生的，只用于演示统计）`);
    });
    $('#btnRecon').addEventListener('click', () => {
      if (!state.paper) return;
      let snap;
      try {
        snap = JSON.parse($('#reconJson').value || '{}');
      } catch {
        return toast('快照 JSON 解析失败');
      }
      const r = state.paper.reconcile(snap);
      renderRecon(r);
      afterPaperChange();
    });
    ['#paperSlip', '#paperPart'].forEach((sel) =>
      $(sel).addEventListener('change', async () => {
        if (!state.paper) return;
        state.paper.slippageBps = Number($('#paperSlip').value) || 3;
        state.paper.participationRate = (Number($('#paperPart').value) || 5) / 100;
        await qd.configUpdate({ paperSlippageBps: state.paper.slippageBps, paperParticipation: Number($('#paperPart').value) });
        toast('撮合参数已更新');
      })
    );
    $('#paperClock').addEventListener('change', async () => {
      await qd.configUpdate({ paperClock: $('#paperClock').value });
      renderPaperSession();
      toast('撮合时段已切换');
    });
  }

  function paperOpts(cash) {
    const cfg = state.config || {};
    return {
      initialCash: cash == null ? cfg.paperCash || 100000 : cash,
      slippageBps: cfg.paperSlippageBps == null ? 3 : cfg.paperSlippageBps,
      participationRate: (cfg.paperParticipation == null ? 5 : cfg.paperParticipation) / 100,
      limits: state.limits,
    };
  }

  function todayStr() {
    return new Date().toISOString().slice(0, 10);
  }

  /**
   * 撮合用的时段。
   * 为什么需要「强制常规时段」：周末 / 假期打开软件时，真实时段是休市，
   * 任何市价单都会被拒（这符合真实规则）。但用户想验证下单流程时不该被判死，
   * 所以给一个显式的回放开关，并且这个开关的状态会一直显示在界面上，不会偷偷生效。
   */
  function paperSession() {
    if ($('#paperClock').value === 'regular') {
      return { phase: 'regular', label: '常规（手动回放）', trading: true, et: '10:00', day: {}, synthetic: true };
    }
    return Mkt.session(new Date());
  }

  async function initPaper() {
    const saved = await qd.paperLoad();
    state.paper = saved && saved.initialCash ? Paper.PaperAccount.fromJSON(saved) : new Paper.PaperAccount(paperOpts());
    const cfg = state.config || {};
    $('#paperCash').value = state.paper.initialCash;
    $('#paperSlip').value = state.paper.slippageBps;
    $('#paperPart').value = Math.round(state.paper.participationRate * 100);
    $('#paperClock').value = cfg.paperClock || 'auto';
    state.limits = { ...Risk.DEFAULT_LIMITS, ...(cfg.riskLimits || {}) };
    state.paper.limits = state.limits;
    renderPaper();
  }

  async function afterPaperChange() {
    renderPaper();
    await qd.paperSave(state.paper.toJSON());
    // 账户变了，风控视图的数字也要跟着变
    if (state.risk) refreshRisk();
  }

  function paperQuoteMap() {
    const out = {};
    for (const p of state.paper.positions) {
      const q = [...state.quotes.values()].find((x) => x.code === p.symbol);
      out[p.symbol] = q && q.price ? q.price : state.paperClocks[p.symbol] || p.lastPrice;
      if (q && q.price) state.paperClocks[p.symbol] = q.price;
    }
    return out;
  }

  function renderPaperSession() {
    const s = paperSession();
    const label = {
      pre: '盘前',
      regular: '常规时段',
      after: '盘后',
      closed: '休市',
      holiday: '假期休市',
    }[s.phase] || s.phase;
    $('#paperModePill').textContent = `${label} · ET ${s.et || '--'}${s.synthetic ? '（手动回放）' : ''}`;
    $('#paperModePill').className = 'pill' + (s.phase === 'regular' ? ' up' : s.synthetic ? ' warn' : ' subtle');
    const nb = Mkt.upcoming(new Date());
    $('#paperSessionNote').textContent = `下一交易日 ${nb.nextTradingDay || '--'} · 下一个假期 ${
      nb.nextHoliday ? nb.nextHoliday.date + '（' + nb.nextHoliday.name + '）' : '—'
    } · 距今 ${nb.daysToNextHoliday == null ? '--' : nb.daysToNextHoliday} 天`;
  }

  function renderPaper() {
    if (!state.paper) return;
    renderPaperSession();
    const qm = paperQuoteMap();
    const st = state.paper.stats(qm);
    const eq = st.equity;

    $('#paperKpi').innerHTML = [
      ['净值', '$' + f0(eq.equity), cls(eq.equity - state.paper.initialCash)],
      ['总收益', pct(eq.totalReturnPct), cls(eq.totalReturnPct)],
      ['现金', '$' + f0(eq.cash), ''],
      ['已结算现金', '$' + f0(eq.settledCash), ''],
      ['持仓市值', '$' + f0(eq.marketValue), ''],
      ['浮动盈亏', (eq.unrealizedPnl > 0 ? '+' : '') + '$' + f0(eq.unrealizedPnl), cls(eq.unrealizedPnl)],
      ['已实现盈亏', (st.realizedPnl > 0 ? '+' : '') + '$' + f0(st.realizedPnl), cls(st.realizedPnl)],
      ['累计费用', '$' + f2(st.totalFees), 'warn'],
      ['委托总数', `${st.ordersCount}（挂 ${st.pendingCount}）`, ''],
      ['已成 / 被拒', `${st.filledCount} / ${st.rejectedCount}`, st.rejectedCount ? 'warn' : ''],
      ['已平仓笔数', st.tradeCount, ''],
      ['胜率', f2(st.winRate) + '%', st.winRate >= 50 ? 'up' : 'down'],
      ['日内交易', st.dayTradesUsed + ' 次', st.dayTradesUsed >= 3 ? 'warn' : ''],
      ['待结算资金', '$' + f2(st.pendingSettlements), ''],
    ]
      .map(([k, v, t]) => `<div class="kpi"><div class="k">${k}</div><div class="v sm ${t || ''}">${esc(String(v))}</div></div>`)
      .join('');

    renderPaperPositions(qm);
    renderPaperOrders();
    renderPaperTrades();
    renderPaperLogs();
    renderRecon(state.paper.lastReconcile);
    renderReadiness(Paper.readiness(state.paper));
  }

  function renderPaperPositions(qm) {
    const tb = $('#paperPos tbody');
    const rows = state.paper.positionsValue(qm).rows;
    $('#paperPosEmpty').style.display = rows.length ? 'none' : 'block';
    $('#paperPosMeta').textContent = `${rows.length} 个持仓`;
    tb.innerHTML = rows
      .map((p) => {
        const holdDays = p.openedAt ? Math.round((Date.now() - new Date(p.openedAt).getTime()) / 86400000) : 0;
        const closeSide = p.side === 'short' ? 'cover' : 'sell';
        return `<tr>
          <td style="text-align:left"><b>${esc(p.symbol)}</b> <span class="muted">${esc(p.sector || '')}</span></td>
          <td class="${p.side === 'short' ? 'down' : 'up'}">${p.side === 'short' ? '空头' : '多头'}</td>
          <td>${f0(Math.abs(p.shares))}</td>
          <td>${f2(p.avgPrice)}</td>
          <td>${f2(p.price)}</td>
          <td>${f0(p.value)}</td>
          <td class="${cls(p.pnl)}">${(p.pnl > 0 ? '+' : '') + f0(p.pnl.toFixed(0))}</td>
          <td class="${cls(p.pnlPct)}">${pct(p.pnlPct)}</td>
          <td>${holdDays}</td>
          <td>${p.borrowRate ? f2(p.borrowRate) + '%' : '—'}</td>
          <td><button class="btn sm" data-close="${esc(p.symbol)}|${esc(closeSide)}|${Math.abs(p.shares)}">平仓</button></td>
        </tr>`;
      })
      .join('');
    tb.querySelectorAll('[data-close]').forEach((b) =>
      b.addEventListener('click', () => {
        const [symbol, side, shares] = b.dataset.close.split('|');
        $('#poSymbol').value = symbol;
        $('#poSide').value = side;
        $('#poType').value = 'market';
        $('#poShares').value = shares;
        toast('已填入下单表单，确认后提交');
      })
    );
  }

  function renderPaperOrders() {
    const list = state.paper.orders.slice().reverse().slice(0, 80);
    $('#paperOrdMeta').textContent = `共 ${state.paper.orders.length} 笔委托（显示最近 ${list.length} 笔）`;
    $('#paperOrders tbody').innerHTML = list
      .map((o) => {
        const st = Paper.ORDER_STATUS[o.status] || { label: o.status, tone: '' };
        const canCancel = o.status === 'submitted' || o.status === 'partially_filled';
        return `<tr>
          <td class="mono" style="text-align:left">${esc(String(o.createdAt).slice(11, 19))}</td>
          <td><b>${esc(o.symbol)}</b></td>
          <td class="${o.side === 'buy' || o.side === 'cover' ? 'up' : 'down'}">${
          { buy: '买入', sell: '卖出', short: '开空', cover: '买平' }[o.side] || o.side
        }</td>
          <td>${esc(o.type)}</td>
          <td>${f0(o.shares)}</td>
          <td>${f0(o.filledShares)}</td>
          <td>${o.avgFillPrice ? f2(o.avgFillPrice) : '--'}</td>
          <td class="${st.tone}">${esc(st.label)}</td>
          <td class="muted" style="text-align:left;max-width:220px;overflow:hidden;text-overflow:ellipsis">${esc(
            o.reason || o.notes || '—'
          )}</td>
          <td>${canCancel ? `<button class="btn sm danger" data-cancel="${esc(o.id)}">撤单</button>` : '—'}</td>
        </tr>`;
      })
      .join('');
    $('#paperOrders tbody')
      .querySelectorAll('[data-cancel]')
      .forEach((b) =>
        b.addEventListener('click', () => {
          const r = state.paper.cancel(b.dataset.cancel);
          toast(r && r.ok ? '已撤单' : '撤单失败：' + ((r && r.reason) || '状态已变'));
          afterPaperChange();
        })
      );
  }

  function renderPaperTrades() {
    $('#paperTrades tbody').innerHTML = state.paper.trades
      .slice()
      .reverse()
      .slice(0, 100)
      .map(
        (t) => `<tr>
        <td class="mono">${esc(t.date)}</td>
        <td><b>${esc(t.symbol)}</b></td>
        <td class="${t.type === 'buy' ? 'up' : 'down'}">${t.type === 'buy' ? '买入' : '卖出'}</td>
        <td>${f0(t.shares)}</td>
        <td>${f2(t.price)}</td>
        <td class="${t.profit == null ? '' : cls(t.profit)}">${
          t.profit == null ? '--' : (t.profit > 0 ? '+' : '') + f0(t.profit.toFixed(0))
        }</td>
        <td>${t.holdDays == null ? '--' : t.holdDays}</td>
      </tr>`
      )
      .join('');
  }

  function renderPaperLogs() {
    const logs = state.paper.logs.slice(-60).reverse();
    $('#paperLogs').innerHTML = logs.length
      ? logs
          .map(
            (l) => `<div class="log-row lv-${esc(l.type)}">
        <span class="lg-time mono">${esc(String(l.at).slice(11, 19))}</span>
        <span class="lg-type">${esc(l.type)}</span>
        <span class="lg-msg">${esc(l.detail)}</span>
      </div>`
          )
          .join('')
      : '<div class="empty">暂无日志</div>';
  }

  function renderRecon(r) {
    if (!r) {
      $('#reconResult').innerHTML = '<div class="fine-print">还没对过账。把券商返回的账户快照粘进上面的输入框里执行一次。</div>';
      return;
    }
    const tone = r.ok ? 'down' : r.high ? 'up' : 'warn';
    $('#reconResult').innerHTML = `
      <div class="callout ${tone}">
        <span class="callout-tag">${r.ok ? '一致' : r.high ? '严重不一致' : '轻微不一致'}</span>
        <span class="callout-text">${esc(r.summary)}（检查于 ${new Date(r.checkedAt).toLocaleString('zh-CN')}）</span>
      </div>
      ${
        r.diffs.length
          ? `<div class="table-scroll" style="margin-top:10px"><table class="grid compact">
              <thead><tr><th>类型</th><th>级别</th><th>标的</th><th>本地</th><th>券商</th><th>说明</th></tr></thead>
              <tbody>${r.diffs
                .map(
                  (d) => `<tr>
                <td>${esc(d.type)}</td>
                <td class="${d.level === 'high' ? 'up' : 'warn'}">${d.level === 'high' ? '严重' : '轻微'}</td>
                <td>${esc(d.symbol || '—')}</td>
                <td>${d.local == null ? '—' : esc(String(d.local))}</td>
                <td>${d.remote == null ? '—' : esc(String(d.remote))}</td>
                <td style="text-align:left">${esc(d.detail)}</td>
              </tr>`
                )
                .join('')}</tbody>
            </table></div>`
          : ''
      }`;
  }

  function renderReadiness(r) {
    $('#readyResult').innerHTML = `
      <div class="row" style="justify-content:space-between;margin-bottom:8px">
        <span class="pill ${r.ready ? 'up' : 'warn'}">上线就绪度 ${r.passed}/${r.total}</span>
        <span class="muted" style="font-size:11.5px">${esc(r.verdict)}</span>
      </div>
      <div class="check-grid">${r.items
        .map(
          (i) => `<span class="check ${i.pass ? 'pass' : 'fail'}">
          <span class="ck">${i.pass ? '✓' : '×'}</span>${esc(i.label)}
          <span class="muted" style="font-family:var(--mono);font-size:10px">${esc(i.detail)}</span>
        </span>`
        )
        .join('')}</div>`;
  }

  /** 解析表单并下单（自检探针也会走这条路径） */
  async function paperSubmitFromForm() {
    const symbol = $('#poSymbol').value.trim().toUpperCase();
    if (!symbol) return toast('请输入代码');
    return paperSubmit({
      symbol,
      side: $('#poSide').value,
      type: $('#poType').value,
      shares: Number($('#poShares').value),
      limitPrice: Number($('#poLimit').value) || 0,
      stopPrice: Number($('#poStop').value) || 0,
      tif: $('#poTif').value,
    });
  }

  async function paperSubmit(o) {
    if (!state.paper) return null;
    let code = String(o.symbol || '').toUpperCase();
    let secid = null;
    try {
      const r = await qd.search(code);
      const hit = r.find((x) => x.code.toUpperCase() === code) || r[0];
      if (hit) {
        code = hit.code;
        secid = hit.secid;
      }
    } catch {
      /* 搜索失败不阻塞，下面用代码直连行情 */
    }
    if (!secid) secid = `105.${code}`;

    // 拿一个参考价：市价单用于风控预检估值，限价单用于判断是否穿越
    let px = Number(o.limitPrice) || 0;
    try {
      const qs = await qd.quotes([secid], { maxAge: 30000 });
      const q = qs[0];
      if (q) {
        if (q.price) state.paperClocks[code] = q.price;
        if (!px) px = q.price || 0;
      }
    } catch {
      /* 行情失败也允许下单，只是估值不准 */
    }
    if (!px) px = state.paperClocks[code] || 0;

    const res = state.paper.submit({
      symbol: code,
      secid,
      side: o.side,
      type: o.type,
      shares: Math.abs(o.shares),
      limitPrice: o.limitPrice || 0,
      stopPrice: o.stopPrice || 0,
      price: px,
      tif: o.tif || 'day',
      session: paperSession(),
    });
    renderPaperResult(res, px);
    await afterPaperChange();
    return res;
  }

  function renderPaperResult(res, px) {
    const box = $('#poResult');
    if (!res) {
      box.innerHTML = '';
      return;
    }
    if (res.duplicate) {
      box.innerHTML = `<div class="callout warn"><span class="callout-tag">幂等命中</span><span class="callout-text">同一笔意图已经提交过（幂等键 ${esc(
        res.order.idempotencyKey
      )}），没有重复下单。</span></div>`;
      return;
    }
    if (res.ok) {
      const o = res.order;
      box.innerHTML = `<div class="callout down"><span class="callout-tag">已受理</span><span class="callout-text">${
        { buy: '买入', sell: '卖出', short: '开空', cover: '买平空' }[o.side]
      } ${f0(o.shares)} 股 ${esc(o.symbol)} · ${esc(o.type)} · 参考价 ${f2(px)} · 状态「${
        (Paper.ORDER_STATUS[o.status] || {}).label || o.status
      }」。${
        o.status === 'submitted' ? '已进入撮合队列，点「用最新K线撮合」按下一根日线成交。' : ''
      }</span></div>${
        res.warnings && res.warnings.length
          ? `<div class="callout warn" style="margin-top:8px"><span class="callout-tag">警告</span><span class="callout-text">${res.warnings
              .map((w) => esc(w.title + '：' + w.detail))
              .join('<br>')}</span></div>`
          : ''
      }`;
      return;
    }
    box.innerHTML = `<div class="callout up"><span class="callout-tag">被拒</span><span class="callout-text"><b>${esc(
      res.order.reason || '下单被拒绝'
    )}</b><br>${(res.blocked || []).map((b) => '· ' + esc(b.title) + '：' + esc(b.detail)).join('<br>')}</span></div>`;
    toast('订单被拒：' + (res.order.reason || ''));
  }

  /** 用最新一根日线撮合所有挂单 */
  async function paperMark() {
    if (!state.paper) return;
    const symbols = [...new Set([
      ...state.paper.orders.filter((o) => o.status === 'submitted' || o.status === 'partially_filled').map((o) => o.symbol),
      ...state.paper.positions.map((p) => p.symbol),
    ])];
    if (!symbols.length) return toast('没有挂单或持仓需要撮合');
    setStatus(true, '撮合中…');
    try {
      const bars = {};
      for (const s of symbols) {
        const secid = [...state.paper.orders, ...state.paper.positions].find((x) => x.symbol === s && x.secid)?.secid || `105.${s}`;
        const k = await qd.kline(secid, { period: 'day', limit: 3, fq: 1 });
        const b = k && k.bars && k.bars[k.bars.length - 1];
        if (b) bars[s] = b;
      }
      const r = state.paper.mark(bars, { session: paperSession(), slippageBps: state.paper.slippageBps });
      for (const s of Object.keys(bars)) state.paperClocks[s] = bars[s].close;
      await afterPaperChange();
      toast(r.fills.length ? `成交 ${r.fills.length} 笔` : '本轮没有成交（价格未触及或量能不足）');
    } catch (e) {
      toast('撮合失败：' + (e.message || ''));
    } finally {
      setStatus(false, '就绪');
    }
  }

  // ============================================================
  //  风控中心（v1.0.2）
  // ============================================================

  function bindRisk() {
    $('#btnRiskRefresh').addEventListener('click', () => {
      refreshRisk();
      toast('已按模拟账户当前状态重算');
    });
    $('#btnRiskReset').addEventListener('click', async () => {
      state.limits = { ...Risk.DEFAULT_LIMITS };
      await qd.configUpdate({ riskLimits: state.limits });
      if (state.paper) state.paper.limits = state.limits;
      renderRiskLimits();
      refreshRisk();
      toast('已恢复默认阈值');
    });
    $('#btnRiskSave').addEventListener('click', async () => {
      const patch = {};
      $$('#riskLimits [data-lk]').forEach((i) => {
        const k = i.dataset.lk;
        if (i.type === 'checkbox') patch[k] = i.checked;
        else if (i.dataset.list) patch[k] = i.value.split(/[,，\s]+/).filter(Boolean);
        else {
          const v = Number(i.value);
          if (isFinite(v)) patch[k] = v;
        }
      });
      state.limits = { ...state.limits, ...patch };
      await qd.configUpdate({ riskLimits: state.limits });
      if (state.paper) state.paper.limits = state.limits;
      refreshRisk();
      toast('风控阈值已保存并生效');
    });
    $('#btnPreTrade').addEventListener('click', pretradeCheck);
  }

  async function initRisk() {
    state.limits = { ...Risk.DEFAULT_LIMITS, ...((state.config && state.config.riskLimits) || {}) };
    renderRiskLimits();
    refreshRisk();
  }

  /** 把模拟账户的持仓/资金翻译成 risk.js 认识的账户口径 */
  function riskInput() {
    const qm = state.paper ? paperQuoteMap() : {};
    const eq = state.paper ? state.paper.equity(qm) : { equity: 0, cash: 0, marketValue: 0, unrealizedPnl: 0, positions: [] };
    const hist = state.paper ? state.paper.equityHistory.map((h) => h.value) : [];
    const eqPositions = (eq.positions || []).map((p) => {
      // 波动率没有真实数据来源，用 45% 这类拍脑袋的数会误导人，
      // 所以这里用「该标的日线年化波动率」实算；算不出来就留 null，让风控如实显示「无数据」。
      const bars = state.analysis && state.analysis.secid && state.analysis.secid.endsWith('.' + p.symbol) ? state.analysis.bars : null;
      const vol = bars && bars.length > 60 ? ind.volatility(bars.map((b) => b.close), 60, 252) : null;
      return {
        symbol: p.symbol,
        side: p.side === 'short' ? 'short' : 'long',
        shares: Math.abs(p.shares),
        price: p.price,
        avgCost: p.avgPrice,
        sector: p.sector || Risk.sectorOf({ symbol: p.symbol }),
        beta: null,
        vol,
        borrowRate: p.borrowRate || 0,
        shortInterestPct: p.shortInterestPct || 0,
        openedAt: p.openedAt,
      };
    });
    return {
      account: {
        equity: eq.equity,
        cash: eq.cash,
        buyingPower: state.paper ? state.paper.buyingPower() : 0,
        marketValue: eq.marketValue,
        dayStartEquity: hist.length > 1 ? hist[hist.length - 2] : eq.equity,
        peakEquity: hist.length ? Math.max(...hist, eq.equity) : eq.equity,
        initialCash: state.paper ? state.paper.initialCash : 0,
      },
      positions: eqPositions,
      limits: state.limits,
      recentTrades: state.paper ? state.paper.trades.slice(-50) : [],
      dayTrades: state.paper ? state.paper.dayTrades : [],
    };
  }

  function refreshRisk() {
    const inp = riskInput();
    const ev = Risk.evaluate(inp);
    state.risk = ev;
    renderRisk(ev, inp);
  }

  function renderRisk(ev, inp) {
    const TONE = { ok: 'down', warn: 'warn', danger: 'up' };
    const LIGHT = { ok: '绿灯', warn: '黄灯', danger: '红灯' };
    $('#riskHeadline').className = 'callout ' + (TONE[ev.level] || 'info');
    $('#riskHeadline').innerHTML = `<span class="callout-tag">${LIGHT[ev.level] || ev.level}</span><span class="callout-text">${esc(
      ev.headline
    )} · 安全评分 ${ev.score}/100（越高越安全）· 检查于 ${new Date(ev.evaluatedAt).toLocaleTimeString('zh-CN')}</span>`;

    $('#riskKpi').innerHTML = [
      ['风控等级', LIGHT[ev.level] || ev.level, TONE[ev.level]],
      ['安全评分', ev.score + ' / 100', ev.score >= 80 ? 'down' : ev.score >= 50 ? 'warn' : 'up'],
      ['硬拦截', ev.blocks.length + ' 项', ev.blocks.length ? 'up' : ''],
      ['警告', ev.warns.length + ' 项', ev.warns.length ? 'warn' : ''],
      ['检查项', ev.checks.length + ' 项', ''],
      ['账户净值', '$' + f0(inp.account.equity), ''],
      [
        '当日盈亏',
        (inp.account.equity - inp.account.dayStartEquity >= 0 ? '+' : '') +
          '$' + f0(Math.abs(inp.account.equity - inp.account.dayStartEquity)),
        cls(inp.account.equity - inp.account.dayStartEquity),
      ],
      ['距峰值回撤', f2(ev.account ? ev.account.drawdownPct : 0) + '%', 'warn'],
    ]
      .map(([k, v, t]) => `<div class="kpi"><div class="k">${k}</div><div class="v sm ${t || ''}">${esc(String(v))}</div></div>`)
      .join('');

    const ex = ev.exposure || {};
    const L = ev.limits || state.limits;
    $('#riskExposure').innerHTML = [
      ['总仓位', f2(ex.grossPct) + '%', ex.grossPct > (L.maxGrossExposurePct || 150) ? 'up' : ''],
      ['净仓位', f2(ex.netPct) + '%', ''],
      ['多头', f2(ex.longPct) + '%', ''],
      ['空头', f2(ex.shortPct) + '%', ex.shortPct > 0 ? 'warn' : ''],
      ['现金比例', f2(ex.cashPct) + '%', ex.cashPct < (L.minCashPct || 5) ? 'warn' : ''],
      ['杠杆', f2(ex.leverage) + 'x', ex.leverage > (L.maxLeverage || 2) ? 'up' : ''],
      ['持仓数', ex.positionsCount + ' 个', ex.positionsCount > (L.maxOpenPositions || 12) ? 'warn' : ''],
      ['组合 Beta', ev.strategy && ev.strategy.beta != null ? f2(ev.strategy.beta) : '--', ''],
      ['单日 VaR95', ev.strategy && ev.strategy.var ? f2(ev.strategy.var.varPct) + '%' : '--', 'warn'],
    ]
      .map(([k, v, t]) => `<div class="kpi"><div class="k">${k}</div><div class="v sm ${t || ''}">${esc(String(v))}</div></div>`)
      .join('');

    const secs = (ev.strategy && ev.strategy.sectors) || [];
    const maxPct = Math.max(L.maxSectorPct || 35, ...secs.map((s) => s.pct || 0));
    $('#riskSectors').innerHTML = secs.length
      ? secs
          .map(
            (s) => `<div class="sb-row">
        <span class="sb-name">${esc(s.sector)}</span>
        <span class="sb-track"><span class="sb-fill ${s.pct > (L.maxSectorPct || 35) ? 'over' : ''}" style="width:${(s.pct / maxPct) * 100}%"></span>
          <span class="sb-limit" style="left:${((L.maxSectorPct || 35) / maxPct) * 100}%"></span></span>
        <span class="sb-val">${f2(s.pct)}%</span>
        <span class="sb-syms muted">${esc((s.symbols || []).join(' '))}</span>
      </div>`
          )
          .join('')
      : '<div class="empty">暂无持仓，敞口为空</div>';

    const all = ev.checks.map((c) => ({ ...c, layer: ev.account.checks.includes(c) ? '账户级' : '策略级' }));
    $('#riskCheckMeta').textContent = `${all.length} 项检查 · 通过 ${all.filter((c) => c.passed).length} 项`;
    $('#riskChecks tbody').innerHTML = all
      .map(
        (c) => `<tr>
        <td style="text-align:left" class="muted">${esc(c.layer)}</td>
        <td style="text-align:left"><b>${esc(c.label)}</b></td>
        <td class="${c.passed ? '' : c.level === 'block' ? 'up' : 'warn'}">${esc(fmtLimitValue(c))}</td>
        <td class="muted">${esc(String(c.limit))}</td>
        <td class="${c.passed ? 'down' : c.level === 'block' ? 'up' : 'warn'}">${
          c.passed ? '通过' : c.level === 'block' ? '拦截' : '警告'
        }</td>
        <td style="text-align:left" class="muted">${esc(c.detail)}</td>
      </tr>`
      )
      .join('');

    const pos = ev.strategy && ev.strategy.positions ? ev.strategy.positions : [];
    $('#riskPosMeta').textContent = pos.length ? `${pos.length} 个持仓` : '无持仓';
    $('#riskPositions tbody').innerHTML = pos.length
      ? pos
          .map(
            (p) => `<tr>
        <td><b>${esc(p.symbol)}</b></td>
        <td style="text-align:left">${esc(p.sector || '—')}</td>
        <td class="${p.side === 'short' ? 'down' : 'up'}">${p.side === 'short' ? '空' : '多'}</td>
        <td>${f0(p.shares)}</td>
        <td>${f0(p.mv)}</td>
        <td class="${p.pct > (state.limits.maxSinglePositionPct || 15) ? 'up' : ''}">${f2(p.pct)}%</td>
        <td class="${cls(p.pnl)}">${(p.pnl > 0 ? '+' : '') + f0(p.pnl.toFixed(0))}</td>
        <td>${p.beta == null ? '--' : f2(p.beta)}</td>
        <td>${p.vol == null ? '--' : f2(p.vol) + '%'}</td>
        <td>${p.borrowRate ? f2(p.borrowRate) + '%' : '—'}</td>
        <td>${p.shortInterestPct ? f2(p.shortInterestPct) + '%' : '—'}</td>
        <td>${p.daysToCover ? f2(p.daysToCover) : '—'}</td>
      </tr>`
          )
          .join('')
      : '<tr><td colspan="12" class="muted" style="text-align:center;padding:18px">暂无持仓</td></tr>';

    const shorts = ev.shorts || [];
    $('#riskActions').innerHTML = ev.actions.length
      ? `<div class="action-list">${ev.actions
          .map(
            (a) => `<div class="action-row u-${esc(a.urgency)}">
            <span class="ac-act">${esc(a.action)}</span>
            <span class="ac-urg">${{ high: '紧急', medium: '建议', low: '可忽略' }[a.urgency] || a.urgency}</span>
            <span class="ac-reason">${esc(a.reason)}</span>
            <span class="ac-target muted">${esc(a.target || '')}</span>
          </div>`
          )
          .join('')}</div>`
      : '<div class="empty">当前没有需要动作的风险项</div>';

    if (shorts.length) {
      $('#riskActions').innerHTML += `<div class="table-scroll" style="margin-top:12px"><table class="grid compact">
        <thead><tr><th>做空标的</th><th>借券费率</th><th>空头利率</th><th>回补天数</th><th>30 天预估成本</th><th>结论</th></tr></thead>
        <tbody>${shorts
          .map(
            (s) => `<tr>
          <td><b>${esc(s.symbol)}</b></td><td>${f2(s.borrowRate)}%</td><td>${f2(s.shortInterestPct)}%</td>
          <td>${s.daysToCover ? f2(s.daysToCover) : '--'}</td><td>$${f2(s.estCostPer30d)}</td>
          <td class="${s.level === 'pass' ? 'down' : s.level === 'warn' ? 'warn' : 'up'}">${esc(
              (s.issues && s.issues[0] && s.issues[0].title) || s.level
            )}</td></tr>`
          )
          .join('')}</tbody></table></div>`;
    }
  }

  /**
   * 把风控检查项的「当前值」显示成人能读的形式。
   * 判断口径靠 key 的后缀而不是瞎猜：Pct 结尾 = 百分比，Count/Days/Number 结尾 = 计数，其余按金额。
   */
  function fmtLimitValue(c) {
    if (c.value == null || !isFinite(c.value)) return '--';
    const k = String(c.key || '');
    if (/Pct$/.test(k)) return f2(c.value) + '%';
    if (/(Count|Days|Number|Trades)/.test(k)) return f0(c.value);
    if (/Beta$/.test(k)) return f2(c.value);
    return f0(c.value);
  }

  const LIMIT_LABELS = [
    ['maxDailyLossPct', '单日最大亏损 %', '占日前净值，超了就该停手'],
    ['maxDrawdownPct', '最大回撤 %', '从峰值算，触发停机线'],
    ['maxGrossExposurePct', '总仓位上限 %', '多空绝对值之和 / 净值'],
    ['maxNetExposurePct', '净仓位上限 %', '净头寸 / 净值'],
    ['minCashPct', '最低现金比例 %', '留缓冲，别满仓'],
    ['maxLeverage', '最大杠杆倍数', '个人自用建议 ≤ 1.5'],
    ['maxSinglePositionPct', '单票集中度上限 %', ''],
    ['maxSectorPct', '行业集中度上限 %', ''],
    ['maxOpenPositions', '最大持仓数', ''],
    ['maxSingleTradeRiskPct', '单笔风险上限 %', '入场价与止损价的差 × 股数 / 净值'],
    ['maxPortfolioBeta', '组合 Beta 上限', ''],
    ['maxDailyVaRPct', '单日 VaR 上限 %', ''],
    ['maxShortExposurePct', '空头敞口上限 %', ''],
    ['maxBorrowRatePct', '借券费率上限 %', ''],
    ['minShortInterestPct', '空头利率下限 %', '太低的借券难度大'],
    ['squeezeRiskSiPct', '挤空风险阈值 %', '空头利率高于此值提示挤空风险'],
    ['earningsBlackoutDays', '财报黑窗天数', '财报前后 N 天禁止开新仓'],
    ['maxDayTradesPer5', '5 日内允许日内交易次数', 'PDT 口径'],
  ];

  function renderRiskLimits() {
    const textKeys = [['blacklist', '黑名单代码（逗号分隔）'], ['restrictedSectors', '受限行业（逗号分隔）']];
    $('#riskLimits').innerHTML =
      LIMIT_LABELS.map(
        ([k, label, hint]) => `<label class="lmt">
        <span class="lmt-k">${esc(label)}</span>
        <input class="input num" data-lk="${esc(k)}" value="${state.limits[k] == null ? '' : esc(String(state.limits[k]))}" />
        <span class="lmt-h muted">${esc(hint)}</span>
      </label>`
      ).join('') +
      textKeys
        .map(
          ([k, label]) => `<label class="lmt">
        <span class="lmt-k">${esc(label)}</span>
        <input class="input" data-lk="${esc(k)}" data-list="1" value="${esc(((state.limits[k] || []) || []).join(','))}" />
        <span class="lmt-h muted">留空表示不限制</span>
      </label>`
        )
        .join('');
  }

  async function pretradeCheck() {
    const symbol = $('#ptSymbol').value.trim().toUpperCase();
    if (!symbol) return toast('请输入代码');
    setStatus(true, '预检中…');
    try {
      let secid = `105.${symbol}`;
      try {
        const r = await qd.search(symbol);
        const hit = r.find((x) => x.code.toUpperCase() === symbol) || r[0];
        if (hit) secid = hit.secid;
      } catch { /* 用代码直连 */ }
      let px = Number($('#ptPrice').value) || 0;
      let prevClose = 0;
      let changePct = 0;
      try {
        const qs = await qd.quotes([secid], { maxAge: 20000 });
        if (qs[0]) {
          if (!px) px = qs[0].price;
          prevClose = qs[0].prevClose || 0;
          changePct = qs[0].changePct || 0;
        }
      } catch { /* 没行情就用输入价 */ }
      if (!px) return toast('拿不到现价，请手动填写价格');

      const inp = riskInput();
      const ssr = prevClose ? Mkt.ssrCheck(prevClose, prevClose * (1 + changePct / 100)) : null;
      const res = Risk.preTrade({
        order: { symbol, side: $('#ptSide').value, shares: Number($('#ptShares').value), price: px, stopPrice: Number($('#ptStop').value) || null },
        account: { ...inp.account, equity: inp.account.equity || 100000, cash: inp.account.cash || 0 },
        positions: inp.positions,
        dayTrades: inp.dayTrades,
        limits: state.limits,
        market: {
          ssrActive: ssr ? ssr.active : false,
          price: px,
          prevClose,
          changePct,
          earningsInDays: null,
          avgVolume: null,
        },
        state: {},
      });
      renderPreTrade(res, { symbol, px, ssr });
    } catch (e) {
      toast('预检失败：' + (e.message || ''));
    } finally {
      setStatus(false, '就绪');
    }
  }

  function renderPreTrade(res, ctx) {
    const tone = res.passed ? (res.level === 'warn' ? 'warn' : 'down') : 'up';
    $('#ptResult').innerHTML = `
      <div class="callout ${tone}">
        <span class="callout-tag">${res.passed ? (res.warns.length ? '有警告' : '可以下单') : '被拦截'}</span>
        <span class="callout-text">${esc(ctx.symbol)} @ ${f2(ctx.px)} · ${
      res.blocks.length
    } 项拦截 / ${res.warns.length} 项警告 / ${res.passes.length} 项通过${ctx.ssr && ctx.ssr.active ? ' · <b>SSR 生效中（做空需提价）</b>' : ''}</span>
      </div>
      ${
        res.blocks.length
          ? `<div class="callout up" style="margin-top:8px"><span class="callout-tag">拦截项</span><span class="callout-text">${res.blocks
              .map((b) => '· <b>' + esc(b.title) + '</b>：' + esc(b.detail))
              .join('<br>')}</span></div>`
          : ''
      }
      ${
        res.warns.length
          ? `<div class="callout warn" style="margin-top:8px"><span class="callout-tag">警告项</span><span class="callout-text">${res.warns
              .map((b) => '· <b>' + esc(b.title) + '</b>：' + esc(b.detail))
              .join('<br>')}</span></div>`
          : ''
      }
      <div class="table-scroll" style="margin-top:10px"><table class="grid compact">
        <thead><tr><th>预检项</th><th>结论</th><th>说明</th></tr></thead>
        <tbody>${[...res.blocks, ...res.warns, ...res.passes]
          .map(
            (c) => `<tr>
          <td style="text-align:left">${esc(c.title || '')}</td>
          <td class="${c.level === 'block' ? 'up' : c.level === 'warn' ? 'warn' : 'down'}">${
              c.level === 'block' ? '拦截' : c.level === 'warn' ? '警告' : '通过'
            }</td>
          <td style="text-align:left" class="muted">${esc(c.detail || '')}</td>
        </tr>`
          )
          .join('')}</tbody>
      </table></div>`;
  }

  // ============================================================
  //  监控告警（v1.0.2）
  // ============================================================

  function bindMonitor() {
    // 规则类型下拉按分组呈现
    const groups = {};
    Alerts.RULE_TYPES.forEach((t) => {
      (groups[t.group] = groups[t.group] || []).push(t);
    });
    $('#ruleType').innerHTML = Object.entries(groups)
      .map(
        ([g, list]) =>
          `<optgroup label="${esc(g)}">${list
            .map((t) => `<option value="${esc(t.key)}" data-unit="${esc(t.unit || '')}">${esc(t.label)}</option>`)
            .join('')}</optgroup>`
      )
      .join('');

    $('#btnRuleAdd').addEventListener('click', async () => {
      const key = $('#ruleType').value;
      const t = Alerts.RULE_MAP[key];
      const raw = $('#ruleValue').value.trim();
      const rule = {
        id: `r_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type: key,
        symbol: $('#ruleSymbol').value.trim().toUpperCase(),
        value: raw === '' ? null : Number(raw),
        severity: $('#ruleSeverity').value,
        enabled: true,
        note: t ? t.desc : '',
      };
      if (rule.value == null && !['risk_block', 'order_failed', 'fill'].includes(key)) {
        return toast('该规则需要填阈值');
      }
      state.rules.push(rule);
      await persistRules();
      $('#ruleValue').value = '';
      renderRules();
      toast('规则已添加');
    });

    $('#btnRulePreset').addEventListener('click', async () => {
      const preset = Alerts.defaultRules();
      const have = new Set(state.rules.map((r) => r.type + '|' + r.symbol));
      let added = 0;
      for (const p of preset) {
        if (have.has(p.type + '|' + p.symbol)) continue;
        state.rules.push({ ...p, id: `r_${Date.now()}_${added}` });
        added++;
      }
      await persistRules();
      renderRules();
      toast(added ? `已载入 ${added} 条常用规则` : '常用规则已经在列表里了');
    });

    $('#btnMonTick').addEventListener('click', async () => {
      setStatus(true, '巡检中…');
      try {
        const r = await qd.monitorTickNow();
        renderMonitorTick(r);
        renderDashboard();
        renderAnomalies();
        renderAudit();
        toast(r && r.fired && r.fired.length ? `命中 ${r.fired.length} 条规则` : '本轮没有命中规则');
      } catch (e) {
        toast('巡检失败：' + (e.message || ''));
      } finally {
        setStatus(false, '就绪');
      }
    });

    $('#monOn').addEventListener('change', async () => {
      if ($('#monOn').checked) {
        const r = await qd.monitorStart({ interval: Number($('#monInterval').value) });
        state.monitor.on = true;
        toast(`后台轮询已启动（每 ${Math.round(r.intervalMs / 1000)} 秒）`);
      } else {
        await qd.monitorStop();
        state.monitor.on = false;
        toast('后台轮询已停止');
      }
      renderDashboard();
    });

    $('#monInterval').addEventListener('change', async () => {
      await qd.configUpdate({ monitorInterval: Number($('#monInterval').value) });
      if (state.monitor.on) {
        await qd.monitorStart();
        toast('轮询间隔已更新');
      }
    });

    $('#btnAuditClear').addEventListener('click', async () => {
      await qd.storeSet('auditLog', []);
      state.audit = [];
      renderAudit();
      toast('审计日志已清空');
    });

    qd.onMonitorTick((r) => {
      renderMonitorTick(r);
      renderDashboard();
      renderAnomalies();
      renderAudit();
    });
  }

  async function initMonitor() {
    const cfg = state.config || {};
    state.rules = (await qd.storeGet('alertRules')) || [];
    state.audit = (await qd.storeGet('auditLog')) || [];
    state.channels = cfg.channels || {};
    state.activeChannels = cfg.activeChannels || [];
    $('#monInterval').value = String(cfg.monitorInterval || 30000);
    const st = await qd.monitorStatus();
    state.monitor = { on: st.running, status: st };
    $('#monOn').checked = st.running;
    renderChannelGrid();
    renderRules();
    renderDashboard();
    renderAnomalies();
    renderAudit();
  }

  async function persistRules() {
    await qd.storeSet('alertRules', state.rules);
  }

  function renderRules() {
    const box = $('#ruleList');
    if (!state.rules.length) {
      box.innerHTML = '<div class="empty">还没有规则。点「载入常用规则」先把几条真正有用的加上。</div>';
      return;
    }
    box.innerHTML = `<div class="table-scroll"><table class="grid compact">
      <thead><tr><th>类型</th><th>分组</th><th>标的</th><th>阈值</th><th>级别</th><th>状态</th><th>说明</th><th>操作</th></tr></thead>
      <tbody>${state.rules
        .map((r) => {
          const t = Alerts.RULE_MAP[r.type] || { label: r.type, group: '—', unit: '' };
          const shown = r.value == null ? '—' : t.unit === '$' ? '$' + r.value : r.value + (t.unit || '');
          return `<tr>
          <td style="text-align:left"><b>${esc(t.label)}</b></td>
          <td class="muted">${esc(t.group)}</td>
          <td>${esc(r.symbol || '全部')}</td>
          <td>${esc(String(shown))}</td>
          <td class="${r.severity === 'high' ? 'up' : r.severity === 'medium' ? 'warn' : 'muted'}">${
            { high: '高', medium: '中', info: '提示' }[r.severity] || r.severity
          }</td>
          <td>${r.enabled === false ? '<span class="muted">已停用</span>' : '<span class="down">生效中</span>'}</td>
          <td class="muted" style="text-align:left">${esc(r.note || t.desc || '')}</td>
          <td>
            <button class="btn sm" data-toggle="${esc(r.id)}">${r.enabled === false ? '启用' : '停用'}</button>
            <button class="btn sm danger" data-delrule="${esc(r.id)}">删除</button>
          </td>
        </tr>`;
        })
        .join('')}</tbody></table></div>`;
    box.querySelectorAll('[data-toggle]').forEach((b) =>
      b.addEventListener('click', async () => {
        const r = state.rules.find((x) => x.id === b.dataset.toggle);
        if (r) r.enabled = r.enabled === false;
        await persistRules();
        renderRules();
      })
    );
    box.querySelectorAll('[data-delrule]').forEach((b) =>
      b.addEventListener('click', async () => {
        state.rules = state.rules.filter((x) => x.id !== b.dataset.delrule);
        await persistRules();
        renderRules();
      })
    );
  }

  function renderChannelGrid() {
    $('#chanGrid').innerHTML = Alerts.CHANNELS.map((ch) => {
      const on = state.activeChannels.includes(ch.key);
      const cfg = state.channels[ch.key] || {};
      return `<div class="ch-card ${on ? 'on' : ''}" data-ch="${esc(ch.key)}">
        <div class="ch-head">
          <span class="ch-name">${esc(ch.name)}</span>
          <span class="switch"><input type="checkbox" data-chon="${esc(ch.key)}" ${on ? 'checked' : ''} /><span class="slider"></span></span>
        </div>
        <div class="ch-note muted">${esc(ch.note)}</div>
        <div class="ch-fields">
          ${(ch.fields || [])
            .map(
              (f) => `<label class="chf">
              <span>${esc(f.label)}</span>
              <input class="input" data-chf="${esc(ch.key)}|${esc(f.key)}" type="${f.secret ? 'password' : 'text'}"
                value="${esc(f.secret ? maskCred(cfg[f.key]) : cfg[f.key] || '')}" placeholder="${esc(f.placeholder || '')}" />
            </label>`
            )
            .join('') || '<div class="muted" style="font-size:11px">无需配置</div>'}
        </div>
        <div class="ch-foot">
          <button class="btn sm" data-chsave="${esc(ch.key)}">保存</button>
          <button class="btn sm" data-chtest="${esc(ch.key)}">发一条测试</button>
        </div>
      </div>`;
    }).join('');

    $('#chanGrid')
      .querySelectorAll('[data-chsave]')
      .forEach((b) =>
        b.addEventListener('click', async () => {
          const key = b.dataset.chsave;
          const cfg = { ...(state.channels[key] || {}) };
          $$(`[data-chf^="${key}|"]`).forEach((i) => {
            const fk = i.dataset.chf.split('|')[1];
            const meta = (Alerts.CHANNEL_MAP[key].fields || []).find((f) => f.key === fk);
            // 密码框留空 = 不改动（避免把脱敏值当成新密码存回去）
            if (meta && meta.secret && !i.value) return;
            cfg[fk] = i.value;
          });
          cfg.enabled = true;
          state.channels[key] = cfg;
          if (!state.activeChannels.includes(key)) state.activeChannels.push(key);
          await qd.configUpdate({ channels: state.channels, activeChannels: state.activeChannels });
          renderChannelGrid();
          toast(`${Alerts.CHANNEL_MAP[key].name} 配置已保存`);
        })
      );

    $('#chanGrid')
      .querySelectorAll('[data-chon]')
      .forEach((c) =>
        c.addEventListener('change', async () => {
          const key = c.dataset.chon;
          if (c.checked) {
            if (!state.activeChannels.includes(key)) state.activeChannels.push(key);
          } else {
            state.activeChannels = state.activeChannels.filter((k) => k !== key);
          }
          if (state.channels[key]) state.channels[key].enabled = c.checked;
          await qd.configUpdate({ channels: state.channels, activeChannels: state.activeChannels });
          renderChannelGrid();
        })
      );

    $('#chanGrid')
      .querySelectorAll('[data-chtest]')
      .forEach((b) =>
        b.addEventListener('click', async () => {
          const key = b.dataset.chtest;
          b.disabled = true;
          b.textContent = '发送中…';
          try {
            const r = await qd.alertTest(key, state.channels[key] || {});
            toast(`${r.channel || key}：${r.ok ? '发送成功' : '失败 — ' + r.detail}`);
            if (!r.ok && r.detail) state.audit = (await qd.storeGet('auditLog')) || state.audit;
            renderAudit();
          } catch (e) {
            toast('测试失败：' + (e.message || ''));
          } finally {
            b.disabled = false;
            b.textContent = '发一条测试';
          }
        })
      );
  }

  function maskCred(v) {
    return v ? '••••' + String(v).slice(-4) : '';
  }

  async function renderDashboard() {
    const inp = state.paper ? riskInput() : null;
    const st = state.monitor.status || (await qd.monitorStatus());
    state.monitor.status = st;
    const dash = Alerts.dashboard({
      account: inp
        ? { ...inp.account, initialCash: state.paper.initialCash, peakEquity: inp.account.peakEquity }
        : {},
      positions: inp ? inp.positions : [],
      orders: state.paper ? state.paper.orders : [],
      anomalies: [],
      rules: state.rules,
      latencyMs: st.heartbeat ? 0 : 0,
      heartbeatAt: st.lastBeatAt,
      risk: state.risk,
    });
    const beat = st.heartbeat || Alerts.heartbeat({ lastBeatAt: st.lastBeatAt, intervalMs: st.intervalMs });
    $('#dashBeatPill').textContent = `${beat.label}${st.ticks ? ' · 巡检 ' + st.ticks + ' 次' : ''}`;
    $('#dashBeatPill').className = 'pill ' + (beat.alive ? 'up' : 'subtle');
    $('#dashRiskPill').textContent = state.risk ? `风控 ${state.risk.level} · ${state.risk.score}` : '风控 未评估';
    $('#dashRiskPill').className =
      'pill ' + (state.risk && (state.risk.level === 'danger' || state.risk.level === 'block') ? 'up' : 'subtle');
    $('#dashMeta').textContent = `轮询${state.monitor.on ? '进行中' : '已停止'} · 上次心跳 ${
      st.lastBeatAt ? new Date(st.lastBeatAt).toLocaleTimeString('zh-CN') : '—'
    }`;

    $('#dashKpi').innerHTML = [
      ['净值', dollars(dash.netValue)],
      ['当日盈亏', signedDollars(dash.dayPnl), cls(dash.dayPnl)],
      ['当日涨跌', pct(dash.dayPnlPct), cls(dash.dayPnlPct)],
      ['累计盈亏', signedDollars(dash.totalPnl), cls(dash.totalPnl)],
      ['距峰值回撤', f2(dash.drawdownPct) + '%', dash.drawdownPct > 10 ? 'up' : ''],
      ['现金', dollars(dash.cash)],
      ['购买力', dollars(dash.buyingPower)],
      ['持仓数', dash.positionCount],
      ['挂单数', dash.pendingOrders],
      ['风控等级', state.risk ? state.risk.level : '未评估', state.risk && state.risk.blocks.length ? 'up' : ''],
      ['心跳', beat.label, beat.alive ? 'down' : 'warn'],
      ['异常', (st.lastResult && st.lastResult.anomalies != null ? st.lastResult.anomalies : 0) + ' 项', ''],
    ]
      .map(([k, v, t]) => `<div class="kpi"><div class="k">${k}</div><div class="v sm ${t || ''}">${esc(String(v))}</div></div>`)
      .join('');

    $('#dashMeta').textContent += st.lastError ? ` · 最近错误：${st.lastError}` : '';
  }

  function renderAnomalies(list) {
    const items = list || state.lastAnomalies || [];
    $('#anomMeta').textContent = items.length ? `${items.length} 项异常` : '正常';
    $('#anomList').innerHTML = items.length
      ? items
          .map(
            (a) => `<div class="diag-item">
        <div class="di-hd">
          <span class="di-t">${esc(a.label)}</span>
          <span class="di-lv ${a.level === 'high' ? 'high' : 'mid'}">${a.level === 'high' ? '严重' : '提示'}</span>
          <span class="muted" style="font-size:10px;margin-left:auto">${esc(new Date(a.at).toLocaleTimeString('zh-CN'))}</span>
        </div>
        <div class="di-d">${esc(a.detail)}</div>
        <div class="di-e">含义：${esc(a.hint || '')}</div>
      </div>`
          )
          .join('')
      : '<div class="empty">未检测到异常。要看结果，点右上角「立即巡检」或打开后台轮询。</div>';
  }

  function renderMonitorTick(r) {
    if (!r) return;
    state.lastAnomalies = r.anomalies || [];
    state.lastFired = r.fired || [];
    state.monitor.status = { ...(state.monitor.status || {}), lastBeatAt: r.at, ticks: r.ticks, running: true, intervalMs: state.monitor.status ? state.monitor.status.intervalMs : 30000 };
  }

  async function renderAudit() {
    const list = (await qd.auditList()) || [];
    state.audit = list;
    $('#auditMeta').textContent = `${list.length} 条记录（最多保留 500 条）`;
    $('#auditTable tbody').innerHTML = list.length
      ? list
          .slice()
          .reverse()
          .slice(0, 200)
          .map(
            (a) => `<tr>
        <td class="mono" style="text-align:left">${esc(new Date(a.at).toLocaleString('zh-CN'))}</td>
        <td class="${a.level === 'error' ? 'up' : a.level === 'warn' ? 'warn' : 'muted'}">${esc(a.level)}</td>
        <td>${esc(a.category)}</td>
        <td style="text-align:left">${esc(a.message)}</td>
      </tr>`
          )
          .join('')
      : '<tr><td colspan="4" class="muted" style="text-align:center;padding:18px">暂无日志</td></tr>';
  }

  const dollars = (v) => (v == null || !isFinite(v) ? '--' : '$' + f0(v));
  const signedDollars = (v) => (v == null || !isFinite(v) ? '--' : (v > 0 ? '+' : v < 0 ? '-' : '') + '$' + f0(Math.abs(v)));

  // ============================================================
  //  税务复盘（v1.0.2）
  // ============================================================

  function bindTax() {
    $('#btnTaxCalc').addEventListener('click', runTax);
    $('#btnTaxCsv').addEventListener('click', exportTaxCsv);
    $$('#taxFormTabs button').forEach((b) =>
      b.addEventListener('click', () => {
        state.taxForm = b.dataset.f;
        $$('#taxFormTabs button').forEach((x) => x.classList.toggle('on', x === b));
        renderTaxForm();
      })
    );
  }

  async function initTax() {
    await runTax();
  }

  async function runTax() {
    const year = String($('#taxYear').value || new Date().getFullYear());
    let trades = [];
    let divs = [];
    try {
      trades = $('#taxTrades').value.trim() ? JSON.parse($('#taxTrades').value) : [];
      divs = $('#taxDivs').value.trim() ? JSON.parse($('#taxDivs').value) : [];
    } catch {
      return toast('JSON 解析失败，请检查格式');
    }
    if (!trades.length) {
      // 默认用模拟账户的成交流水（字段名与 tax.js 内部口径一致）
      trades = state.paper ? state.paper.trades.map((t) => ({
        symbol: t.symbol,
        side: t.type === 'buy' ? 'buy' : 'sell',
        shares: t.shares,
        price: t.price,
        date: String(t.date).slice(0, 10),
        fee: t.fee || 0,
      })) : [];
    }
    if (!trades.length) {
      $('#taxKpi').innerHTML = '';
      $('#taxLots tbody').innerHTML = '<tr><td colspan="10" class="muted" style="text-align:center;padding:18px">没有成交记录可算。先去「模拟交易」跑几笔，或把券商对账单 JSON 粘到上面。</td></tr>';
      $('#taxWash').innerHTML = '<div class="empty">无数据</div>';
      $('#taxDiv').innerHTML = '<div class="empty">无数据</div>';
      $('#taxCn').innerHTML = '';
      return;
    }
    const r = Tax.report({ trades, dividends: divs, year });
    state.taxReport = r;
    renderTax(r);
  }

  function renderTax(r) {
    const s = r.summary;
    $('#taxKpi').innerHTML = [
      ['平仓回合数', s.trades + ' 笔'],
      ['已实现盈亏', (s.realizedPnl > 0 ? '+' : '') + '$' + f0(s.realizedPnl), cls(s.realizedPnl)],
      ['应税净额', (s.taxablePnl > 0 ? '+' : '') + '$' + f0(s.taxablePnl), cls(s.taxablePnl)],
      ['短期盈亏', (s.shortTermPnl > 0 ? '+' : '') + '$' + f0(s.shortTermPnl), cls(s.shortTermPnl)],
      ['长期盈亏', (s.longTermPnl > 0 ? '+' : '') + '$' + f0(s.longTermPnl), cls(s.longTermPnl)],
      ['股息毛额', '$' + f0(s.dividendGross)],
      ['股息预扣', '$' + f0(s.dividendWithholding), 'warn'],
      ['股息净额', '$' + f0(s.dividendNet)],
      ['洗售不予抵扣', '$' + f0(s.washSaleDisallowed), s.washSaleDisallowed ? 'warn' : ''],
      ['联邦预估税', '$' + f0(r.federal.total), 'warn'],
      ['中国境内预估', '$' + f0(r.china.netPayable), 'warn'],
    ]
      .map(([k, v, t]) => `<div class="kpi"><div class="k">${k}</div><div class="v sm ${t || ''}">${esc(String(v || ''))}</div></div>`)
      .join('');

    const disallowed = new Set((r.washSale.cleansed || []).map((c) => `${c.symbol}|${c.closeDate}`));
    $('#taxLotMeta').textContent = `${r.lots.length} 个已平仓回合 · 长期门槛 ${r.classify.thresholdDays} 天`;
    $('#taxLots tbody').innerHTML = r.lots.length
      ? r.lots
          .map(
            (l) => `<tr>
        <td><b>${esc(l.symbol)}</b></td>
        <td class="mono">${esc(l.openDate || '—')}</td>
        <td class="mono">${esc(l.closeDate)}</td>
        <td>${f0(l.shares)}</td>
        <td>${f0(l.cost)}</td>
        <td>${f0(l.proceeds)}</td>
        <td class="${cls(l.pnl)}">${(l.pnl > 0 ? '+' : '') + f0(l.pnl.toFixed(0))}</td>
        <td>${l.holdDays}</td>
        <td class="${l.term === 'long' ? 'down' : 'warn'}">${l.term === 'long' ? '长期' : '短期'}</td>
        <td>${disallowed.has(`${l.symbol}|${l.closeDate}`) ? '<span class="up">是</span>' : '—'}</td>
      </tr>`
          )
          .join('')
      : '<tr><td colspan="10" class="muted" style="text-align:center;padding:18px">该年度没有已平仓回合</td></tr>';

    const ws = r.washSale;
    $('#taxWash').innerHTML = `
      <div class="callout ${ws.totalDisallowed ? 'warn' : 'info'}">
        <span class="callout-tag">${ws.totalDisallowed ? '检测到洗售' : '未检测到洗售'}</span>
        <span class="callout-text">窗口：平仓前后各 ${Tax.WASH_WINDOW_DAYS} 个自然日 · 不予抵扣的亏损合计 $${f2(
      ws.totalDisallowed
    )}</span>
      </div>
      <ul class="about-list" style="margin-top:10px">${(ws.notes || []).map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
      ${
        ws.cleansed && ws.cleansed.length
          ? `<div class="table-scroll" style="margin-top:10px"><table class="grid compact">
              <thead><tr><th>标的</th><th>平仓日</th><th>亏损</th><th>被洗金额</th></tr></thead>
              <tbody>${ws.cleansed
                .map(
                  (c) => `<tr><td><b>${esc(c.symbol)}</b></td><td class="mono">${esc(c.closeDate)}</td>
                <td class="down">${f0(c.loss)}</td><td class="warn">${f0(c.disallowedLoss)}</td></tr>`
                )
                .join('')}</tbody></table></div>`
          : ''
      }`;

    const d = r.dividend;
    $('#taxDiv').innerHTML = d.gross
      ? `
      <div class="callout info"><span class="callout-tag">预扣税率 ${d.rate}%</span><span class="callout-text">${esc(d.note)}</span></div>
      <div class="table-scroll" style="margin-top:10px"><table class="grid compact">
        <thead><tr><th>日期</th><th>标的</th><th>类型</th><th>毛额</th><th>预扣</th><th>净额</th></tr></thead>
        <tbody>${d.list
          .map(
            (x) => `<tr><td class="mono">${esc(x.date)}</td><td><b>${esc(x.symbol)}</b></td>
          <td>${x.type === 'qualified' ? '合格股息' : '普通股息'}</td>
          <td>${f0(x.gross)}</td><td class="warn">${f0(x.withholding)}</td><td>${f0(x.net)}</td></tr>`
          )
          .join('')}</tbody></table></div>
      <div class="fine-print" style="margin-top:10px">${esc(d.cnTreatment || '')}</div>`
      : '<div class="empty">该年度没有股息记录。想验证这一块，把股息 JSON 粘到上面的输入框里。</div>';

    renderTaxForm();

    $('#taxCn').innerHTML = `
      <div class="kpi-grid">${[
        ['财产转让所得（20%）', '$' + f0(r.china.propertyTax)],
        ['股息红利所得（20%）', '$' + f0(r.china.dividendTax)],
        ['境外已缴可抵免', '$' + f0(r.china.foreignTaxCredit)],
        ['境内应补税额', '$' + f0(r.china.netPayable)],
      ]
        .map(([k, v]) => `<div class="kpi"><div class="k">${k}</div><div class="v sm">${esc(v)}</div></div>`)
        .join('')}</div>
      <div class="fine-print" style="margin-top:10px">${esc(r.china.note)}</div>
      <div class="fine-print" style="margin-top:10px">联邦口径：短期按普通所得（${r.federal.shortTermTax ? f0(r.federal.shortTermTax) : 0} 美元），长期按优惠税率（${
      r.federal.longTermTax ? f0(r.federal.longTermTax) : 0
    } 美元），另计 NIIT 预估 $${f0(r.federal.niitEst || 0)}。${esc(r.federal.note || '')}</div>`;

    $('#taxDisclaimer').textContent = r.disclaimer;
  }

  function renderTaxForm() {
    if (!state.taxReport) return;
    const f = state.taxReport.forms[state.taxForm];
    if (!f || !f.rows || !f.rows.length) {
      $('#taxForm thead').innerHTML = '';
      $('#taxForm tbody').innerHTML = `<tr><td class="muted" style="text-align:center;padding:18px">${esc(
        (f && f.name) || '无数据'
      )} —— 该年度这项为空</td></tr>`;
      return;
    }
    const cols = Object.keys(f.rows[0]);
    $('#taxForm thead').innerHTML = `<tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>`;
    $('#taxForm tbody').innerHTML = f.rows
      .map((row) => `<tr>${cols.map((c) => `<td>${esc(String(row[c] == null ? '' : row[c]))}</td>`).join('')}</tr>`)
      .join('');
  }

  function exportTaxCsv() {
    if (!state.taxReport || !state.taxReport.lots.length) return toast('没有可导出的数据');
    const csv = Tax.toCsv(state.taxReport.lots);
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `quantdesk_tax_${state.taxReport.year}.csv`;
    a.click();
    toast('已导出税务明细 CSV');
  }

  // ------------------------------------------------------------ 预设选股策略（v1.1.0）
  //
  // 设计意图：把「选股」这件事从「一堆散装因子」提升为「可解释的交易假设」。
  // 每个预设都回答了三个问题：它在赌什么逻辑（rationale）、门槛是什么（filters）、
  // 以及**最容易在哪里亏钱**（watchOut）。第三个问题最重要 —— 没有它，
  // 预设就变成了「点一下就有票」的许愿池。

  function initScanPresets() {
    const list = Screener.PRESETS || [];
    $('#scanPresets').innerHTML = list
      .map(
        (p) =>
          `<div class="preset-item" data-preset="${esc(p.key)}" title="${esc(p.rationale)}">${esc(p.label)}</div>`
      )
      .join('');
    $$('#scanPresets .preset-item').forEach((el) =>
      el.addEventListener('click', () => selectPreset(el.dataset.preset === state.preset ? '' : el.dataset.preset))
    );
  }

  function selectPreset(key) {
    state.preset = key || '';
    $$('#scanPresets .preset-item').forEach((el) => el.classList.toggle('on', el.dataset.preset === state.preset));
    renderPresetDetail();
    if (state.scanResults.length) renderScan();
  }

  function renderPresetDetail() {
    const box = $('#presetDetail');
    const p = state.preset ? Screener.PRESET_MAP[state.preset] : null;
    if (!p) {
      box.classList.remove('show');
      box.innerHTML = '';
      $('#presetDesc').textContent =
        '选择一个预设，可直接筛出对应的候选；也可以只把它当作因子门槛的起点再手动改。';
      return;
    }
    const fmap = Screener.FACTOR_MAP || {};
    const conds = (p.filters || [])
      .map((f) => {
        const label = (fmap[f.factor] || {}).label || f.factor;
        const parts = [];
        if (f.min != null) parts.push(`≥ ${f.min}`);
        if (f.max != null) parts.push(`≤ ${f.max}`);
        return `<code>${esc(label)}</code> ${parts.join(' 且 ')}`;
      })
      .join('　');
    const uni = (Screener.UNIVERSE_RAW[p.universe] || {}).label || p.universe;
    box.innerHTML = `
      <div class="pd-row"><span class="pd-k">交易逻辑</span><span class="pd-v">${esc(p.rationale)}</span></div>
      <div class="pd-row"><span class="pd-k">因子门槛</span><span class="pd-v">${conds || '无（仅排序）'}</span></div>
      <div class="pd-row"><span class="pd-k">建议池子</span><span class="pd-v">${esc(uni)}${p.limit ? `　取前 ${p.limit} 只` : ''}</span></div>
      <div class="pd-row"><span class="pd-k">最大风险</span><span class="pd-v warn">${esc(p.watchOut || '--')}</span></div>`;
    box.classList.add('show');
    $('#presetDesc').textContent = p.desc;
  }

  /**
   * 用当前预设对扫描结果做筛选。
   * 注意：预设的 filters 用的是「因子分（0-100）」，与扫描页原来的总评分（0-100）
   * 是两套口径 —— 前者来自 screener.js 的 16 因子体系，后者来自 factors.js 的 6 维打分。
   * 两套都保留，界面上要标清楚用的是什么，别让人以为是同一个分数。
   */
  function applyPresetFilter() {
    const p = state.preset ? Screener.PRESET_MAP[state.preset] : null;
    if (!p) return null;
    const items = state.scanResults.filter((r) => r.factor).map((r) => ({ ...r.factor, _src: r }));
    if (!items.length) {
      return { rows: [], empty: true, summary: '本次扫描结果里没有因子数据。请重新扫描一次（v1.1.0 起扫描会同时计算多因子分）。' };
    }
    const res = Screener.screen(items, { preset: p });
    return { ...res, items };
  }

  // ------------------------------------------------------------ 机会雷达（v1.1.0）

  function bindRadar() {
    $('#btnRadar').addEventListener('click', runRadarScan);
    $('#btnRadarExport').addEventListener('click', radarExport);
    $('#radarUniverse').addEventListener('change', () => {
      state.radarUniverse = $('#radarUniverse').value;
    });
    $('#radarGradeFilter').addEventListener('change', () => {
      state.radarGrade = $('#radarGradeFilter').value;
      renderRadarTable();
    });
    $('#radarSort').addEventListener('change', () => {
      state.radarSort = $('#radarSort').value;
      renderRadarTable();
    });
    $('#radarInsightPick').addEventListener('change', () => {
      state.radarPick = $('#radarInsightPick').value;
      renderInsightPanel();
    });
    $('#radarNewsPick').addEventListener('change', () => {
      state.radarNewsPick = $('#radarNewsPick').value;
      renderNewsPanel();
    });
    $('#radarNewsSort').addEventListener('change', renderNewsPanel);
    $('#radarEventScope').addEventListener('change', renderEventPanel);
    // 因子/风险/机会点折叠：用事件委托，表格重绘后依然有效
    $('#radarInsightPanel').addEventListener('click', (e) => {
      const hd = e.target.closest('.ins-item > .ii-hd');
      if (hd) hd.parentElement.classList.toggle('open');
    });
  }

  function initRadarUniverse() {
    const us = Screener.universes(state.watchlist.map((w) => w.code));
    const keys = Object.keys(us);
    // 默认用「高贝塔弹性池」：机会雷达的目的就是找弹性，默认池子要匹配用途
    const def = keys.includes('highbeta') ? 'highbeta' : keys.includes('nasdaq100') ? 'nasdaq100' : keys[0];
    $('#radarUniverse').innerHTML = keys
      .map((k) => `<option value="${esc(k)}">${esc(us[k].label)} · ${us[k].codes.length} 只</option>`)
      .join('');
    state.radarUniverse = def;
    $('#radarUniverse').value = def;
  }

  async function runRadarScan() {
    const btn = $('#btnRadar');
    btn.disabled = true;
    setStatus(true, '机会雷达扫描中…');
    $('#radarBar').style.width = '0%';
    const off = qd.onRadarProgress((p) => {
      const pctv = p.total ? Math.round((p.done / p.total) * 100) : 0;
      $('#radarBar').style.width = pctv + '%';
      $('#radarText').textContent = `${p.stage || ''} ${p.done || 0}/${p.total || 0} · ${p.current || ''}`;
    });
    try {
      const res = await qd.radarRun({
        universe: $('#radarUniverse').value,
        limit: Number($('#radarLimit').value),
        includeNews: $('#radarOptNews').checked,
        includeEvents: $('#radarOptEvents').checked,
        includeExtras: $('#radarOptExtras').checked,
        eventDays: Number($('#radarEventDays').value),
        minAmount: Number($('#radarMinAmount').value) || 0,
        newsTop: 12,
        extrasTop: 10,
      });
      if (res.error) return toast(res.error);
      state.radar = res;
      state.radarPick = (res.rows[0] || {}).symbol || null;
      state.radarNewsPick = state.radarPick;
      renderRadarAll();
      toast(`机会雷达完成：${res.rows.length} 只深挖，A/B 级 ${(res.poolMoonshot.distribution.A || 0) + (res.poolMoonshot.distribution.B || 0)} 只`);
    } catch (e) {
      toast('扫描失败：' + (e.message || '请稍后重试'));
    } finally {
      off();
      btn.disabled = false;
      setStatus(false, '就绪');
      $('#radarBar').style.width = '100%';
    }
  }

  function renderRadarAll() {
    renderRadarKpi();
    renderRadarTable();
    renderRadarPickers();
    renderInsightPanel();
    renderNewsPanel();
    renderEventPanel();
  }

  function renderRadarPickers() {
    const r = state.radar;
    const opts = (r ? r.rows : [])
      .map((x) => `<option value="${esc(x.symbol)}">${esc(x.symbol)} ${esc(x.name || '')} · ${x.moonshot ? x.moonshot.grade : '-'} 级</option>`)
      .join('');
    $('#radarInsightPick').innerHTML = opts || '<option value="">（无）</option>';
    $('#radarNewsPick').innerHTML = opts || '<option value="">（无）</option>';
    if (state.radarPick) $('#radarInsightPick').value = state.radarPick;
    if (state.radarNewsPick) $('#radarNewsPick').value = state.radarNewsPick;
  }

  function renderRadarKpi() {
    const box = $('#radarKpi');
    const r = state.radar;
    if (!r) {
      box.innerHTML = '';
      $('#radarTableMeta').textContent = '尚未扫描';
      return;
    }
    const d = r.poolMoonshot ? r.poolMoonshot.distribution : { A: 0, B: 0, C: 0, D: 0 };
    const bench = r.benchmark;
    const mr = r.marketRisk || {};
    const next = (r.marketEvents || [])[0];
    const kpis = [
      ['深挖标的', `${r.rows.length} 只`, ''],
      ['A / B 级', `${(d.A || 0)} / ${(d.B || 0)}`, d.A ? 'up' : ''],
      ['基准 20 日', bench ? pct(bench.ret20) : '--', bench ? cls(bench.ret20) : ''],
      ['基准 60 日', bench ? pct(bench.ret60) : '--', bench ? cls(bench.ret60) : ''],
      ['事件风险', mr.level ? `${mr.level}（${mr.score}）` : '--', mr.level === '高' ? 'down' : ''],
      ['最近事件', next ? `${next.daysAway} 天后` : '--', ''],
      ['新闻覆盖', `${(r.rows || []).filter((x) => (x.news || []).length).length} 只`, ''],
      ['耗时', `${(r.costMs / 1000).toFixed(1)}s`, ''],
    ];
    box.innerHTML = kpis
      .map(
        ([k, v, c]) =>
          `<div class="kpi"><div class="k">${esc(k)}</div><div class="v sm ${c}">${esc(String(v))}</div></div>`
      )
      .join('');
    const degraded = [];
    if (r.degraded && r.degraded.news) degraded.push('新闻');
    if (r.degraded && r.degraded.events) degraded.push('事件日历');
    if (r.degraded && r.degraded.extras) degraded.push('空头/分析师数据');
    $('#radarTableMeta').textContent = degraded.length
      ? `⚠️ ${degraded.join('、')} 本次未取到（数据源不可达），相关结论已在下方标注为缺失 —— 不要把「没有数据」误读成「没有风险」。`
      : `扫描于 ${new Date(r.scannedAt).toLocaleString('zh-CN')} · ${r.rows.length} 只 · ${(r.costMs / 1000).toFixed(1)}s`;
  }

  function miniBar(v, invert) {
    if (v == null) return '<span class="muted">--</span>';
    const val = Math.round(v);
    const lv = val >= 80 ? 5 : val >= 65 ? 4 : val >= 50 ? 3 : val >= 35 ? 2 : 1;
    const colorClass = invert ? `lv${6 - lv}` : `lv${lv}`;
    return `<span class="mini"><span class="mt"><span class="mf ${colorClass}" style="width:${val}%"></span></span><span class="mv">${val}</span></span>`;
  }

  function renderRadarTable() {
    const r = state.radar;
    const tb = $('#radarTable tbody');
    if (!r || !r.rows.length) {
      tb.innerHTML = '';
      $('#radarEmpty').style.display = 'block';
      return;
    }
    $('#radarEmpty').style.display = 'none';
    let rows = r.rows.slice();
    if (state.radarGrade) {
      const allow = new Set(state.radarGrade.split(','));
      rows = rows.filter((x) => x.moonshot && allow.has(x.moonshot.grade));
    }
    const sortKey = state.radarSort;
    rows.sort((a, b) => {
      if (sortKey === 'net') return ((b.insight && b.insight.scores.netAdjusted) || 0) - ((a.insight && a.insight.scores.netAdjusted) || 0);
      if (sortKey === 'opportunity') return ((b.insight && b.insight.scores.opportunity) || 0) - ((a.insight && a.insight.scores.opportunity) || 0);
      if (sortKey === 'factor') return (b.factorComposite || 0) - (a.factorComposite || 0);
      return ((b.moonshot && b.moonshot.score) || 0) - ((a.moonshot && a.moonshot.score) || 0);
    });

    tb.innerHTML = rows
      .map((x) => {
        const m = x.moonshot || {};
        const p = m.parts || {};
        const ins = x.insight && x.insight.scores ? x.insight.scores : {};
        const opp = ins.opportunity;
        const rsk = ins.risk;
        const net = ins.netAdjusted;
        const netCls = net == null ? '' : net >= 10 ? 'up' : net <= -10 ? 'down' : '';
        return `<tr>
          <td><span class="grade ${esc(m.grade || '-')}" title="${esc(m.summary || '')}">${esc(m.grade || '-')}</span></td>
          <td><span class="code" data-open="${esc(x.secid)}" data-code="${esc(x.symbol)}">${esc(x.symbol)}</span> <span class="name">${esc(x.name || '')}</span></td>
          <td><b class="${netCls}">${m.score == null ? '--' : m.score.toFixed(1)}</b></td>
          <td>${miniBar(p.elasticity)}</td>
          <td>${miniBar(p.compression)}</td>
          <td>${miniBar(p.volume)}</td>
          <td>${miniBar(p.momentum)}</td>
          <td>${miniBar(p.position)}</td>
          <td>${miniBar(p.shortFuel)}</td>
          <td class="num"><span class="up">${opp == null ? '--' : opp}</span> / <span class="down">${rsk == null ? '--' : rsk}</span> <span class="muted">(净 ${net == null ? '--' : net})</span></td>
          <td>${f2(x.price)}</td>
          <td class="${cls(x.changePct)}">${pct(x.changePct)}</td>
          <td><button class="btn sm" data-insight="${esc(x.symbol)}">详情</button></td>
        </tr>`;
      })
      .join('');

    tb.querySelectorAll('[data-open]').forEach((b) =>
      b.addEventListener('click', () => openAnalyze(b.dataset.open, b.dataset.code))
    );
    tb.querySelectorAll('[data-insight]').forEach((b) =>
      b.addEventListener('click', () => {
        state.radarPick = b.dataset.insight;
        state.radarNewsPick = b.dataset.insight;
        $('#radarInsightPick').value = state.radarPick;
        $('#radarNewsPick').value = state.radarNewsPick;
        renderInsightPanel();
        renderNewsPanel();
        $('#radarInsightPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
      })
    );
    if (state.radarPick) $('#radarInsightPick').value = state.radarPick;
    if (state.radarNewsPick) $('#radarNewsPick').value = state.radarNewsPick;
  }

  const INS_LIST_LIMIT = 40;

  function insItemHtml(it, kind) {
    const score = kind === 'opp' ? it.strength : it.severity;
    const ev = it.evidence ? `<span class="ev">${esc(it.evidence)}</span>` : '';
    return `<div class="ins-item ${kind}">
      <div class="ii-hd">
        <span class="ii-caret">▶</span>
        <span class="ii-label">${esc(it.label)}</span>
        <span class="ii-bar"><i style="width:${score}%"></i></span>
        <span class="ii-num">${score}</span>
      </div>
      <div class="ii-bd">${ev}<span class="why">${esc(it.desc || '')}</span></div>
    </div>`;
  }

  function renderInsightPanel() {
    const r = state.radar;
    const panel = $('#radarInsightPanel');
    if (!r || !state.radarPick) {
      panel.style.display = 'none';
      return;
    }
    const x = r.rows.find((v) => v.symbol === state.radarPick);
    if (!x) {
      panel.style.display = 'none';
      return;
    }
    panel.style.display = 'block';
    const ins = x.insight || {};
    const s = ins.scores || {};
    const st = ins.stance || {};
    const dte = x.daysToEarnings;
    const si = x.shortInterest;
    const an = x.analyst;

    $('#radarInsightMeta').textContent = `${x.symbol} · ${(ins.opportunities || []).length} 项机会 / ${(ins.risks || []).length} 项风险`;

    const stanceCls = st.key === 'bullish' || st.key === 'lean-bull' ? 'up' : st.key === 'bearish' || st.key === 'lean-bear' ? 'down' : '';
    $('#insightHead').innerHTML = `
      <span class="ih-sym">${esc(x.symbol)}</span>
      <span class="ih-name">${esc(x.name || '')}</span>
      <span class="pill subtle">${esc(x.group || '')}</span>
      <span class="pill ${x.moonshot ? (x.moonshot.grade === 'A' ? 'up' : x.moonshot.grade === 'B' ? 'warn' : 'subtle') : 'subtle'}">暴涨潜力 ${x.moonshot ? x.moonshot.grade + ' · ' + x.moonshot.score.toFixed(1) : '--'}</span>
      <span class="ih-spacer"></span>
      <span class="ih-score"><span class="k">机会</span><span class="v up">${s.opportunity == null ? '--' : s.opportunity}</span></span>
      <span class="ih-score"><span class="k">风险</span><span class="v down">${s.risk == null ? '--' : s.risk}</span></span>
      <span class="ih-score"><span class="k">净分</span><span class="v ${stanceCls}">${s.netAdjusted == null ? '--' : s.netAdjusted}</span></span>
      <span class="ih-score"><span class="k">立场</span><span class="v ${stanceCls}" style="font-size:12px">${esc(st.label || '--')}</span></span>
      <span class="ih-note">
        ${esc(st.note || '')}
        ${dte ? ` ｜ 距下次财报 <b>${dte.days} 天</b>（${esc(dte.date)}${dte.time ? ' ' + esc(dte.time) : ''}${dte.epsForecast ? '，预期 EPS ' + esc(dte.epsForecast) : ''}${dte.estimated ? '，日期为估算' : ''}）` : ' ｜ 未取到财报排期'}
        ${si ? ` ｜ 空头回补天数 <b>${si.latest.daysToCover == null ? '--' : si.latest.daysToCover.toFixed(2)}</b>（${esc(si.latest.settlementDate)}，${si.trend === 'up' ? '上升' : si.trend === 'down' ? '下降' : '持平'}）` : ' ｜ 未取到空头数据'}
        ${an && an.priceTarget ? ` ｜ 共识目标价 <b>$${an.priceTarget.toFixed(2)}</b>（${an.buy || 0}买/${an.hold || 0}持/${an.sell || 0}卖，趋势${an.trend === 'up' ? '上调' : an.trend === 'down' ? '下调' : '持平'}）` : ' ｜ 未取到分析师目标价'}
        ${x.extrasErrors && Object.keys(x.extrasErrors).length ? ` ｜ <span class="muted">部分增强数据缺失：${esc(Object.keys(x.extrasErrors).join('、'))}</span>` : ''}
      </span>`;

    const opps = ins.opportunities || [];
    const rsks = ins.risks || [];
    $('#oppCount').textContent = opps.length;
    $('#riskCount').textContent = rsks.length;
    $('#oppList').innerHTML = opps.length
      ? opps.slice(0, INS_LIST_LIMIT).map((it) => insItemHtml(it, 'opp')).join('')
      : '<div class="empty" style="padding:22px 8px">未触发任何机会阈值。<br/>这不代表没有机会，只说明按当前规则没有可验证的上行理由 —— 而这个结论本身也有价值。</div>';
    $('#riskList').innerHTML = rsks.length
      ? rsks.slice(0, INS_LIST_LIMIT).map((it) => insItemHtml(it, 'rsk')).join('')
      : '<div class="empty" style="padding:22px 8px">未触发任何风险阈值。</div>';

    const ms = x.moonshot || {};
    $('#insightFoot').innerHTML = `
      <div style="margin-bottom:6px"><b style="color:var(--text-2)">触发条件</b>：${(ms.triggers || []).map((t) => esc(t)).join(' ／ ') || '--'}</div>
      <div style="margin-bottom:6px"><b style="color:var(--text-2)">失效条件</b>：${(ms.invalidation || []).map((t) => esc(t)).join(' ／ ') || '--'}</div>
      <div style="margin-bottom:6px"><b style="color:var(--orange)">风险标记</b>：${(ms.riskFlags || []).map((t) => esc(t)).join(' ／ ') || '无'}</div>
      ${ms.liquidityNote ? `<div style="margin-bottom:6px"><b style="color:var(--orange)">流动性</b>：${esc(ms.liquidityNote)}</div>` : ''}
      <div>${esc(ins.disclaimer || '')}</div>`;
  }

  function renderNewsPanel() {
    const r = state.radar;
    if (!r || !state.radarNewsPick) {
      $('#radarNewsList').innerHTML = '';
      $('#radarNewsSummary').innerHTML = '';
      return;
    }
    const x = r.rows.find((v) => v.symbol === state.radarNewsPick);
    if (!x) return;
    let list = (x.news || []).slice();
    const sortKey = $('#radarNewsSort').value;
    if (sortKey === 'senti') list.sort((a, b) => Math.abs(b.senti) - Math.abs(a.senti));
    else list.sort((a, b) => (b.ts || 0) - (a.ts || 0));

    const ns = x.newsSummary;
    if (ns) {
      const moodCls = ns.sentiment >= 8 ? 'pos' : ns.sentiment <= -8 ? 'neg' : '';
      $('#radarNewsSummary').innerHTML =
        `<span class="mood ${moodCls}">情绪 ${ns.sentiment}</span> · ${esc(ns.summary)}` +
        (ns.focus ? `<br/><span class="muted">其中 ${ns.focus.title || 0} 条标题即命中（直接报道），${ns.focus.body || 0} 条为正文提及 —— 提及类新闻的情绪已按 0.7 折算。</span>` : '');
    } else {
      $('#radarNewsSummary').innerHTML =
        '<span class="muted">没有抓到与该标的直接相关的新闻。注意：抓不到 ≠ 没有消息，只说明当前数据源无收录。</span>';
    }

    $('#radarNewsMeta').textContent = `${x.symbol} · ${list.length} 条`;
    $('#radarNewsList').innerHTML = list.length
      ? list
          .map((n) => {
            const sc = n.senti > 8 ? 'pos' : n.senti < -8 ? 'neg' : 'neu';
            const hits = (n.sentiHits || [])
              .slice(0, 4)
              .map((h) => `<span class="tag ${h.weight > 0 ? 'bull' : 'bear'}">${esc(h.word)}</span>`)
              .join('');
            const focusTag =
              n.sentiFocus === 'title'
                ? '<span class="tag warn">直接报道</span>'
                : n.sentiFocus === 'body'
                ? '<span class="tag gray">正文提及</span>'
                : '<span class="tag gray">关联较弱</span>';
            return `<div class="news-item">
              <div class="ni-side"><span class="ni-senti ${sc}">${n.senti > 0 ? '+' : ''}${n.senti}</span><span class="ni-age">${n.ageHours == null ? '' : n.ageHours < 24 ? n.ageHours + 'h' : Math.round(n.ageHours / 24) + 'd'}</span></div>
              <div class="ni-main">
                <div class="ni-title" data-url="${esc(n.url || '')}">${esc(n.title)}</div>
                ${n.sentiSentence ? `<div class="ni-excerpt">命中句：${esc(n.sentiSentence)}</div>` : ''}
                <div class="ni-meta">${focusTag}${n.topicLabel ? `<span class="tag gray">${esc(n.topicLabel)}</span>` : ''}${hits}<span class="muted" style="font-size:10px">${esc(n.date || '')} · ${esc(n.source || '')}</span></div>
              </div>
            </div>`;
          })
          .join('')
      : '<div class="empty" style="padding:26px 8px">没有相关新闻</div>';

    $$('#radarNewsList .ni-title').forEach((el) =>
      el.addEventListener('click', () => {
        const u = el.dataset.url;
        if (u) qd.openExternal(u);
      })
    );
  }

  function renderEventPanel() {
    const r = state.radar;
    if (!r) {
      $('#radarEventList').innerHTML = '';
      $('#radarEventRisk').innerHTML = '';
      return;
    }
    const scope = $('#radarEventScope').value;
    let list = (r.marketEvents || []).concat((r.events || []));
    if (scope === 'market') list = list.filter((e) => e.scope === 'market');
    if (scope === 'company') list = list.filter((e) => e.scope === 'company');
    list = list.slice().sort((a, b) => a.daysAway - b.daysAway);

    const mr = r.marketRisk || {};
    $('#radarEventRisk').innerHTML = mr.level
      ? `<span class="callout-tag">事件风险 ${mr.level}（${mr.score}）</span><span class="callout-text">${esc(mr.note)}</span>`
      : '<span class="callout-text">未取到宏观事件数据。</span>';

    $('#radarEventMeta').textContent = `${list.length} 项 · 宏观来源 Fed/BLS/BEA，财报来自 nasdaq`;
    $('#radarEventList').innerHTML = list.length
      ? list
          .map((e) => {
            const k = e.kind || 'macro';
            const soon = e.daysAway <= 3 ? ' soon' : '';
            const est = e.estimated ? ' <span class="est">（估算）</span>' : '';
            const t = e.time ? esc(e.time) + ' ' : '';
            return `<div class="event-item ${esc(k)}">
              <span class="ei-date">${esc(e.date)}</span>
              <span class="ei-days${soon}">${e.daysAway === 0 ? '今天' : e.daysAway + ' 天'}</span>
              <span class="ei-main">
                <span class="ei-title">${e.symbol ? `<b>${esc(e.symbol)}</b> ` : ''}${esc(e.event || '')}</span>
                <span class="ei-src">${t}${esc(e.source || '')}${est}${e.epsForecast ? ' · 预期 EPS ' + esc(e.epsForecast) : ''}</span>
              </span>
            </div>`;
          })
          .join('')
      : '<div class="empty" style="padding:26px 8px">窗口内没有事件</div>';
  }

  function radarExport() {
    if (!state.radar) return toast('还没有扫描结果');
    const blob = new Blob([JSON.stringify(state.radar, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `QuantDesk-radar-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('已导出 JSON（含全部原始数据，可用于复核）');
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
      if (!confirm('确定清空所有自选、预警、扫描结果、模拟盘与告警规则？此操作不可恢复。')) return;
      await qd.storeSet('watchlist', DEFAULT_WATCH.slice());
      await qd.storeSet('alerts', []);
      await qd.storeSet('scanResults', null);
      await qd.storeSet('alertRules', []);
      await qd.storeSet('auditLog', []);
      await qd.paperReset(state.config.paperCash || 100000);
      state.watchlist = DEFAULT_WATCH.slice();
      state.alerts = [];
      state.scanResults = [];
      state.rules = [];
      state.paper = Paper.PaperAccount.fromJSON(await qd.paperLoad());
      renderWatch();
      renderAlerts();
      renderScan();
      renderRules();
      renderPaper();
      renderAudit();
      toast('已重置');
    });
  }

  // ------------------------------------------------------------ go

  document.addEventListener('DOMContentLoaded', boot);
})();
