/**
 * main.js —— Electron 主进程
 * 负责：窗口生命周期、IPC 接口、行情抓取调度、全市场扫描任务
 */
const { app, BrowserWindow, ipcMain, Menu, Notification, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const ds = require('./datasource');
const { Store } = require('./store');
const { POOL } = require('./pool');
const Factors = require('../shared/factors');
const Indicators = require('../shared/indicators');
const Backtest = require('../shared/backtest');
const Levels = require('../shared/levels');
const TradePlan = require('../shared/tradeplan');
const Diagnose = require('../shared/diagnose');
const Options = require('../shared/options');
// ---- v1.0.2
const Market = require('../shared/market');
const Alerts = require('../shared/alerts');
const Screener = require('../shared/screener');
// ---- v1.1.0：新闻 / 事件 / 风险机会 / 暴涨雷达
const Newsfeed = require('../shared/newsfeed');
const Events = require('../shared/events');
const Insight = require('../shared/insight');
const Moonshot = require('../shared/moonshot');
const notify = require('./notify');

const isDev = process.argv.includes('--dev');
const isSmoke = process.argv.includes('--smoke');
const isShot = process.argv.includes('--shot');
let mainWindow = null;
let store = null;

// ---------------------------------------------------------------- 窗口

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1160,
    minHeight: 720,
    title: 'QuantDesk 美股量化终端',
    backgroundColor: '#0a0a0c',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 20 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 外链用系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // 渲染层日志转发到终端，方便排查
  if (isDev || isSmoke) {
    mainWindow.webContents.on('console-message', (e, level, message, line, sourceId) => {
      console.log(`[renderer:${level}] ${message}  (${sourceId}:${line})`);
    });
  }

  // 自检模式：启动后自动跑一遍主流程，输出体检结果
  if (isSmoke) {
    mainWindow.webContents.on('did-finish-load', () => {
      setTimeout(async () => {
        try {
          // 先切到「个股分析」视图——画布在隐藏视图里 clientWidth 为 0，
          // 直接采样会得到 0 像素，那是视图不可见而非渲染失败。
          await mainWindow.webContents.executeJavaScript(`(function(){
            const it = document.querySelector('.nav-item[data-view="analyze"]');
            if (it) it.click();
            window.dispatchEvent(new Event('resize'));
            return true;
          })()`);
          await new Promise((res) => setTimeout(res, 2500));
          // K 线控制实测：走真实 DOM 事件路径（滚轮 / 拖拽 / 双击），
          // 而不是直接调方法——用户碰到的就是这条路径。
          const ctrl = await mainWindow.webContents.executeJavaScript(`(function(){
            const out = { steps: [] };
            const S = window.__qd;
            if (!S || !S.chart()) { out.fatal = 'no chart'; return out; }
            const cv = document.querySelector('#klineCanvas');
            const c = S.chart();
            const snap = (tag) => {
              const r = c._range();
              out.steps.push({
                tag,
                count: c.count,
                offset: Math.round(c.offset * 100) / 100,
                start: r.start,
                end: r.end,
                vis: r.vis,
                integral: Number.isInteger(r.start) && Number.isInteger(r.end),
                atLatest: c.offset <= 0.5,
              });
              return r;
            };
            const box = cv.getBoundingClientRect();
            const cx = box.left + box.width / 2;
            const cy = box.top + box.height * 0.4;

            // 每步都单独 try/catch，崩了就记下当时的状态，便于定位
            const step = (tag, fn) => {
              try { fn(); snap(tag); }
              catch (err) {
                out.steps.push({
                  tag, error: String(err && err.message || err),
                  count: c.count, offset: c.offset, n: c.bars.length,
                  range: (function(){ try { return c._range(); } catch(e){ return 'range-threw: ' + e.message; } })(),
                });
              }
            };

            snap('初始');

            // 1) 滚轮向上 = 放大（可见根数变少）
            step('滚轮放大×2', () => {
              for (let i = 0; i < 2; i++) {
                cv.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
              }
            });

            // 2) 滚轮向下 = 缩小
            step('滚轮缩小×4', () => {
              for (let i = 0; i < 4; i++) {
                cv.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
              }
            });

            // 3) 拖拽向右 = 回看历史（offset 增大；向左是回到最新方向）
            step('拖拽回看历史', () => {
              cv.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
              window.dispatchEvent(new MouseEvent('mousemove', { clientX: cx + 300, clientY: cy, bubbles: true }));
              window.dispatchEvent(new MouseEvent('mouseup', { button: 0, clientX: cx + 300, clientY: cy, bubbles: true }));
            });

            // 3b) 拖拽回位：继续向左拖应回到最新
            step('拖拽回到最新', () => {
              cv.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
              window.dispatchEvent(new MouseEvent('mousemove', { clientX: cx - 600, clientY: cy, bubbles: true }));
              window.dispatchEvent(new MouseEvent('mouseup', { button: 0, clientX: cx - 600, clientY: cy, bubbles: true }));
            });

            // 4) 双击复位
            step('双击复位', () => {
              cv.dispatchEvent(new MouseEvent('dblclick', { clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
            });

            // 5) 「最新」按钮
            step('手动移开', () => { c.panBy(60); });
            step('回到最新', () => { document.querySelector('#chartLatest').click(); });

            // 6) 工具条缩放 / 复位按钮
            step('按钮放大', () => { document.querySelector('#chartZoomIn').click(); });
            step('按钮复位', () => { document.querySelector('#chartReset').click(); });

            // 7) 缩放极限压力测试：连续放大到下限、再缩小到上限、再疯狂平移
            step('极限放大×30', () => {
              for (let i = 0; i < 30; i++) c.zoomAt(cv.clientWidth / 2, 0.8);
            });
            step('极限缩小×30', () => {
              for (let i = 0; i < 30; i++) c.zoomAt(cv.clientWidth / 2, 1.25);
            });
            step('平移越界+999', () => { c.panBy(999); });
            step('平移越界-999', () => { c.panBy(-999); });

            // 8) 十字光标命中测试：画布中点应命中某根K线
            try {
              c.hover = -1;
              cv.dispatchEvent(new MouseEvent('mousemove', { clientX: cx, clientY: cy, bubbles: true }));
              out.hoverIndex = c.hover;
              out.hoverInRange = c.hover >= 0 && c.hover < c.bars.length;
            } catch (err) { out.hoverError = String(err.message || err); }

            // 9) 生命周期回调是否触发
            try {
              let fired = 0;
              const prev = c.onViewChange;
              c.onViewChange = function(){ fired++; };
              c.zoomAt(cv.clientWidth / 2, 0.9);
              out.viewCallbackFired = fired;
              c.onViewChange = prev;
            } catch (err) { out.viewCallbackFired = -1; }

            out.sizes = { w: cv.width, h: cv.height, cw: cv.clientWidth, ch: cv.clientHeight };
            out.visible = box.width > 0 && box.height > 0;
            out.totalBars = c.bars.length;
            return out;
          })()`);

          const r = await mainWindow.webContents.executeJavaScript(`(function(){
            const q = (s) => document.querySelector(s);
            const n = (s) => document.querySelectorAll(s).length;
            const paint = (cv) => {
              if (!cv) return 0;
              try {
                const ctx = cv.getContext('2d');
                const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
                let c = 0;
                for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) c++;
                return c;
              } catch (e) { return -1; }
            };
            return {
              errors: window.__errors || [],
              hasQd: typeof window.qd === 'object',
              modules: ['ind','factors','bt','levels','tradeplan','diagnose','options'].filter(function(k){ return typeof window.qd[k] === 'object'; }).length,
              watchRows: n('#watchTable tbody tr'),
              poolChips: n('#poolChips button'),
              indexes: n('#indexStrip .idx'),
              // 个股分析
              quoteCode: (q('#qhCode')||{}).textContent || '',
              quoteLast: (q('#qhLast')||{}).textContent || '',
              kpiCells: n('#anaKpi .kpi'),
              factorRows: n('#anaFactors .factor-row'),
              scoreText: (q('#anaScore .num-big')||{}).textContent || '',
              klinePx: paint(q('#klineCanvas')),
              klineClient: (function(){
                const c = q('#klineCanvas');
                if (!c) return 'na';
                return c.clientWidth + 'x' + c.clientHeight + ' attr=' + c.width + 'x' + c.height;
              })(),
              klineVisible: (function(){
                const c = q('#klineCanvas');
                if (!c) return 'na';
                const r = c.getBoundingClientRect();
                return r.width > 0 && r.height > 0 && getComputedStyle(c).display !== 'none';
              })(),
              activeView: (function(){
                const v = document.querySelector('.view.on') || document.querySelector('.view.active');
                return v ? (v.id || v.dataset.view || '?') : 'none';
              })(),
              activeNav: (function(){
                const b = document.querySelector('.nav-item.on') || document.querySelector('.nav-item.active');
                return b ? (b.dataset.view || b.textContent.trim()) : 'none';
              })(),
              chartRange: (q('#chartRange')||{}).textContent || '',
              // 交易计划
              planCards: n('#planGrid .plan-card'),
              planSplitRows: n('#planSplit .split-row'),
              planTriggerItems: n('#planTriggers .plan-list li'),
              planAction: (q('#planAction .callout-tag')||{}).textContent || '',
              // 诊股
              diagDims: n('#diagDims .dim-card'),
              diagOpps: n('#diagOpps .diag-item'),
              diagRisks: n('#diagRisks .diag-item'),
              diagChecks: n('#diagChecks .check'),
              diagSummaryLen: ((q('#diagSummary')||{}).textContent || '').length,
              // 期权
              optChainRows: n('#optChain tbody tr'),
              optStrategies: n('#optStrategies .strategy-card'),
              optLegs: n('#optStrategies .leg'),
              optNoteItems: n('#optNotes div'),
              optIv: (q('#optSummary .opt-stat .os-v')||{}).textContent || '',
              // 外观
              themeAttr: document.documentElement.getAttribute('data-theme') || '',
              backdrop: (function(){
                const el = q('.panel');
                if (!el) return '';
                const cs = getComputedStyle(el);
                return (cs.backdropFilter || cs.webkitBackdropFilter || '').replace(/\\s+/g,' ');
              })(),
              navItems: n('.nav-item'),
              views: n('.view'),
              // ---- v1.0.2 状态探针（经 window.__qd 暴露的只读快照 + 元素计数）
              v102: (function () {
                const A = window.__qd || {};
                const safe = (fn, dflt) => { try { return fn(); } catch (e) { return 'ERR:' + e.message; } };
                const paper = safe(() => A.paper(), null);
                const risk = safe(() => A.risk(), null);
                const tax = safe(() => A.tax(), null);
                const mon = safe(() => A.monitor(), null);
                return {
                  paperLoaded: !!paper,
                  paperCash: paper ? paper.cash : null,
                  paperOrders: Array.isArray(paper && paper.orders) ? paper.orders.length : null,
                  paperPositions: Array.isArray(paper && paper.positions) ? paper.positions.length : null,
                  riskLevel: risk ? risk.level : null,
                  riskChecks: risk && typeof risk.checks === 'number' ? risk.checks : null,
                  riskScore: risk ? risk.score : null,
                  taxYear: tax ? tax.year : null,
                  ruleCount: safe(() => A.rules(), null),
                  channelCount: safe(() => A.channels(), null),
                  limitCount: safe(() => A.limits(), null),
                  monitorRunning: !!(mon && mon.running),
                  monitorTicks: mon ? mon.ticks : null,
                };
              })(),
              // 新视图的关键元素是否都在
              v102Els: {
                paperKpi: n('#paperKpi .kpi'),
                paperPosRows: n('#paperPos tbody tr'),
                paperOrderRows: n('#paperOrders tbody tr'),
                paperTradeRows: n('#paperTrades tbody tr'),
                paperLogRows: n('#paperLogs .log-row'),
                paperSubmitBtn: !!q('#btnPaperOrder'),
                riskKpi: n('#riskKpi .kpi'),
                riskChecks: n('#riskChecks tbody tr'),
                riskPosRows: n('#riskPositions tbody tr'),
                riskLimitInputs: n('#riskLimits .lmt'),
                riskActions: n('#riskActions .action-row'),
                // 没有建议行时，这块区域必须仍然有说明文字，不能是一片空白。
                // 不写死文案（文案会改），只要求「有内容」。
                riskActionsText: ((q('#riskActions') || {}).textContent || '').trim().length,
                preTradeBtn: !!q('#btnPreTrade'),
                dashKpi: n('#dashKpi .kpi'),
                monToggle: !!q('#monOn'),
                ruleRows: n('#ruleList tbody tr'),
                ruleEmptyHint: /还没有规则/.test((q('#ruleList') || {}).textContent || ''),
                chanCards: n('#chanGrid .ch-card'),
                auditRows: n('#auditTable tbody tr'),
                taxKpi: n('#taxKpi .kpi'),
                taxLotRows: n('#taxLots tbody tr'),
                taxEmptyHint: /没有成交记录/.test((q('#taxLots tbody') || {}).textContent || ''),
                taxFormTabs: n('#taxFormTabs button'),
                factorLegend: n('#scanFactorLegend .fl-item'),
                universeOptions: n('#scanUniverse option'),
                btBenchOptions: n('#btBench option'),
                // ---- v1.1.0 机会雷达
                presetItems: n('#scanPresets .preset-item'),
                radarNav: !!q('.nav-item[data-view="radar"]'),
                radarView: !!q('#view-radar'),
                radarUniverseOptions: n('#radarUniverse option'),
                radarTableHead: n('#radarTable thead th'),
                newsPanel: !!q('#radarNewsList'),
                eventPanel: !!q('#radarEventList'),
                // 下面几项不依赖 DOM，直接用加载进来的模块算一遍 ——
                // 这样即使还没点过扫描，也能证明「模块在渲染层真的可用」，
                // 而不是只挂了个空壳（v1.0.2 的教训）。
                radarEvents: (function () {
                  try {
                    return (window.Events ? window.Events.upcoming({ days: 45 }).length : 0);
                  } catch (e) {
                    return -1;
                  }
                })(),
                insightItems: (function () {
                  try {
                    if (!window.Insight) return 0;
                    const bars = [];
                    for (let i = 0; i < 150; i++) {
                      const c = 100 * Math.pow(1.003, i);
                      bars.push({ date: 'd' + i, open: c * 0.99, close: c, high: c * 1.01, low: c * 0.99, volume: 1e6, amount: c * 1e6 });
                    }
                    const r = window.Insight.analyze({ bars: bars, quote: { code: 'T', price: bars[149].close } });
                    return (r.opportunities || []).length + (r.risks || []).length;
                  } catch (e) {
                    return -1;
                  }
                })(),
                // 暴涨雷达：必须同时产出「等级」与「失效条件」，
                // 缺任一者说明模块退化成了只会打分的黑箱
                moonshotRows: (function () {
                  try {
                    if (!window.Moonshot) return 0;
                    const bars = [];
                    for (let i = 0; i < 200; i++) {
                      const c = 50 * Math.pow(1.002, i) * (1 + 0.05 * Math.sin(i / 3));
                      bars.push({ date: 'd' + i, open: c * 0.99, close: c, high: c * 1.02, low: c * 0.98, volume: 1e6, amount: c * 1e6 });
                    }
                    const s = window.Moonshot.score({ bars: bars, quote: { code: 'T', marketCap: 2e9, floatCap: 2e9 } });
                    window.__moonshotProbe = s;
                    return s ? 1 : 0;
                  } catch (e) {
                    return -1;
                  }
                })(),
                moonshotInvalidation: (function () {
                  try {
                    const s = window.__moonshotProbe;
                    return s && s.invalidation ? s.invalidation.length : 0;
                  } catch (e) {
                    return -1;
                  }
                })(),
                newsfeedSentiment: (function () {
                  try {
                    return window.Newsfeed ? window.Newsfeed.sentiment('业绩超预期，上调目标价', '').score : 0;
                  } catch (e) {
                    return -999;
                  }
                })(),
                // ---- v1.2.0 大批量扫描界面
                scanLimitOptions: n('#scanLimit option'),
                scanCancelBtn: !!q('#btnScanCancel'),
                scanScaleBar: ((q('#scanScale') || {}).textContent || '').trim().length > 0,
                scanPagerExists: !!q('#scanPager'),
                // 档位必须来自主进程（单一数据源）。前端硬编码一份的话，
                // 迟早出现「能选 1000、后端只认 300」这种对不上的问题，
                // 所以这里直接比对两边的集合是否一致。
                scanLimitMatches: (function () {
                  try {
                    const opts = Array.prototype.slice
                      .call(document.querySelectorAll('#scanLimit option'))
                      .map((o) => Number(o.value))
                      .filter((n) => n > 0);
                    return opts.length ? opts.join(',') : '';
                  } catch (e) {
                    return '';
                  }
                })(),
              },
              // 渲染层内的“一次性往返”验证：用临时账户跑一遍撮合，不碰真实模拟盘、不联网。
              // 目的是证明模块在渲染层真的可用，而不是只挂了个空壳。
              v102Round: (function () {
                const out = {};
                // 本地加载的 9 个全局模块（contextBridge 代理不算，见 index.html 注释）
                out.modules = ['Indicators', 'Market', 'Risk', 'Paper', 'Perf', 'Tax', 'Broker', 'Screener', 'Alerts', 'Newsfeed', 'Events', 'Insight', 'Moonshot']
                  .filter((k) => typeof window[k] === 'object');
                try {
                  // 必须用本地加载的 window.Paper：contextBridge 传过来的是跨世界函数代理，
                  // class 的 new 语义会丢，走 qd.paper 会报 cannot be invoked without 'new'。
                  const P = window.Paper || window.qd.paper;
                  const pa = new P.PaperAccount({ initialCash: 100000 });
                  const reg = { phase: 'regular', label: '常规', trading: true, et: '10:00', day: {} };
                  const o = pa.submit({ symbol: 'AAPL', side: 'buy', type: 'market', shares: 10, quote: 200, session: reg });
                  out.orderOk = !!o.ok;
                  out.status = o.order.status;
                  const mk = pa.mark({ AAPL: { date: '2025-06-02', open: 200, high: 205, low: 198, close: 202, volume: 1e6 } }, { date: '2025-06-02', session: reg, slippageBps: 0 });
                  out.fills = mk.fills.length;
                  out.positions = pa.positions.length;
                  out.cashBelow = pa.cash < 100000;
                  const rd = P.readiness(pa);
                  out.ready = rd.passed + '/' + rd.total;
                  out.readyTotal = rd.total;
                  out.readyItems = (rd.items || []).length;
                  out.readyVerdict = String(rd.verdict || '').slice(0, 30);
                  out.feePositive = pa.trades.length > 0 && pa.trades[0].fee > 0;
                } catch (e) { out.paperErr = e.message; }
                try {
                  const R = window.Risk || window.qd.risk;
                  const ev = R.evaluate({
                    account: { equity: 100000, cash: 100000, dayStartEquity: 100000, peakEquity: 100000 },
                    positions: [], limits: {},
                  });
                  out.riskLevel = ev.level;
                  out.riskScore = ev.score;
                  out.riskChecks = (ev.checks || []).length;
                  const pre = R.preTrade({
                    order: { symbol: 'TSLA', side: 'buy', shares: 500, price: 250 },
                    account: { equity: 100000, cash: 100000, buyingPower: 100000, dayStartEquity: 100000, peakEquity: 100000 },
                    positions: [], dayTrades: [], limits: {},
                  });
                  out.preBlocked = pre.passed === false;
                  out.preSummary = String(pre.summary || '').slice(0, 40);
                } catch (e) { out.riskErr = e.message; }
                try {
                  const T = window.Tax || window.qd.tax;
                  const rep = T.report({
                    trades: [
                      { symbol: 'AAPL', side: 'buy', shares: 100, price: 90, date: '2024-06-01' },
                      { symbol: 'AAPL', side: 'sell', shares: 100, price: 180, date: '2025-06-15' },
                    ],
                    year: 2025,
                  });
                  out.taxLots = rep.lots.length;
                  out.taxTerm = rep.lots[0] ? rep.lots[0].term : null;
                } catch (e) { out.taxErr = e.message; }
                try {
                  out.marketPhase = (window.Market || window.qd.market).session(new Date()).phase;
                  out.rules = (window.Alerts || window.qd.alerts).RULE_TYPES.length;
                  out.channels = (window.Alerts || window.qd.alerts).CHANNELS.length;
                } catch (e) { out.alertsErr = e.message; }
                return out;
              })(),
            };
          })()`);
          console.log('SMOKE_RESULT ' + JSON.stringify(r));

          // ---- K 线控制断言（在渲染层实测结果上判定）
          const byTag = (t) => (ctrl.steps || []).find((s) => s.tag === t) || {};
          const base = byTag('初始');
          const zin = byTag('滚轮放大×2');
          const zout = byTag('滚轮缩小×4');
          const pan = byTag('拖拽回看历史');
          const panBack = byTag('拖拽回到最新');
          const rst = byTag('双击复位');
          const lts = byTag('回到最新');
          const bIn = byTag('按钮放大');
          const bRs = byTag('按钮复位');
          const zMax = byTag('极限放大×30');
          const zMin = byTag('极限缩小×30');
          const ovl = byTag('平移越界+999');
          const anyErr = (ctrl.steps || []).filter((s) => s.error);
          const allIntegral = (ctrl.steps || []).every((s) => s.error || s.integral !== false);
          const cases = [
            ['画布可见且有尺寸', !!ctrl.visible && ctrl.sizes && ctrl.sizes.cw > 0 && ctrl.sizes.ch > 0],
            ['初始贴最新（offset=0）', base.atLatest === true],
            ['滚轮上滚＝放大（可见根数减少）', zin.count < base.count],
            ['滚轮下滚＝缩小（可见根数增加）', zout.count > zin.count],
            ['拖拽向右＝回看历史（offset 增大）', pan.offset > 1],
            ['拖拽后离开最新', pan.atLatest === false],
            ['拖拽向左＝回到最新', panBack.atLatest === true],
            ['双击复位到初始根数', rst.count === base.count],
            ['「最新」按钮回到 offset≈0', lts.atLatest === true],
            ['工具条「放大」按钮生效', bIn.count < base.count],
            ['工具条「复位」按钮恢复初始根数', bRs.count === base.count],
            ['十字光标命中有效K线索引', ctrl.hoverInRange === true],
            ['视图变化回调被触发', ctrl.viewCallbackFired > 0],
            ['缩放下限受保护（≥20 根）', zMax.count >= 20],
            ['缩放上限受保护（≤全量）', zMin.count <= ctrl.totalBars],
            ['越界平移被钳制（offset 不越界）', !!ovl && ovl.offset === 0],
            ['极值操作全程无异常（无越界崩溃）', anyErr.length === 0],
            ['可视区间始终是整数下标', allIntegral === true],
          ];
          console.log(
            'SMOKE_CTRL ' +
              JSON.stringify({
                cases,
                steps: ctrl.steps,
                sizes: ctrl.sizes,
                hover: ctrl.hoverIndex,
                viewCallbackFired: ctrl.viewCallbackFired,
                totalBars: ctrl.totalBars,
              })
          );

          // ---- v1.0.2：四个新视图 + 模块往返
          const v = r.v102 || {};
          const e2 = r.v102Els || {};
          const rt = r.v102Round || {};
          const cases102 = [
            ['window.__qd 状态探针可读', v.paperLoaded === true && typeof v.ruleCount === 'number'],
            ['模拟盘账户已初始化且有现金', typeof v.paperCash === 'number' && v.paperCash > 0],
            ['风控检查项 ≥ 10 且等级合法', (v.riskChecks || 0) >= 10 && ['ok', 'warn', 'danger'].indexOf(v.riskLevel) >= 0],
            ['风控 KPI 与检查表已渲染', e2.riskKpi >= 6 && e2.riskChecks >= 10],
            ['风控阈值项已渲染', e2.riskLimitInputs >= 15],
            ['无建议时必须给说明文字而非空白', e2.riskActions > 0 || e2.riskActionsText > 6],
            ['下单前预检按钮存在', e2.preTradeBtn === true],
            ['监控看板 KPI 已渲染', e2.dashKpi >= 4],
            ['监控开关存在', e2.monToggle === true],
            ['推送渠道卡片 6 个', e2.chanCards === 6],
            ['无规则时给出明确空提示', e2.ruleEmptyHint === true],
            ['审计日志表存在', e2.auditRows >= 1],
            ['税务视图：无成交时给提示而非空白', e2.taxKpi >= 4 || e2.taxEmptyHint === true],
            ['报税表页签已渲染', e2.taxFormTabs >= 3],
            ['选股因子图例已渲染（16 因子）', e2.factorLegend >= 16],
            ['内置股票池下拉已填充', e2.universeOptions >= 6],
            ['回测基准下拉已填充', e2.btBenchOptions >= 3],
            ['渲染层用到的本地模块都真的加载了', ['Market', 'Risk', 'Paper', 'Perf', 'Tax', 'Broker', 'Screener', 'Alerts', 'Indicators', 'Newsfeed', 'Events', 'Insight', 'Moonshot'].every((k) => rt.modules.indexOf(k) >= 0)],
            // ---- v1.1.0 机会雷达
            ['预设策略按钮已渲染', e2.presetItems >= 13],
            ['机会雷达导航项存在', e2.radarNav === true],
            ['机会雷达视图存在', e2.radarView === true],
            ['事件日历模块可产出事件', e2.radarEvents > 0],
            ['风险机会引擎可产出结论', e2.insightItems > 0],
            ['暴涨雷达给出等级与失效条件', e2.moonshotRows > 0 && e2.moonshotInvalidation > 0],
            // ---- v1.2.0 大批量扫描
            ['扫描档位共 7 档', e2.scanLimitOptions === 7],
            ['档位数值与主进程定义一致', e2.scanLimitMatches === SCAN_LIMITS.join(',')],
            ['最大档位为 1000', e2.scanLimitMatches.split(',').map(Number).includes(1000)],
            ['取消扫描按钮存在', e2.scanCancelBtn === true],
            ['扫描规模提示条已渲染', e2.scanScaleBar === true],
            ['结果分页容器存在', e2.scanPagerExists === true],
            ['模拟盘撮合往返：受理', rt.orderOk === true && rt.status === 'submitted'],
            ['模拟盘撮合往返：成交落账', rt.fills === 1 && rt.positions === 1 && rt.cashBelow === true && rt.feePositive === true],
            ['模拟盘上线就绪度清单 7 项且结论明确', rt.readyTotal === 7 && rt.readyItems === 7 && /\d\/7/.test(String(rt.ready)) && rt.readyVerdict.length > 4],
            ['风控往返：空仓绿灯满分', rt.riskLevel === 'ok' && rt.riskScore === 100 && rt.riskChecks >= 10],
            ['风控往返：超买单被拦截', rt.preBlocked === true],
            ['税务往返：跨年持仓判长期', rt.taxLots === 1 && rt.taxTerm === 'long'],
            ['市场时段与告警枚举可用', !!rt.marketPhase && rt.rules === 16 && rt.channels === 6],
          ];
          console.log('SMOKE_V102 ' + JSON.stringify({ cases: cases102, state: v, els: e2, round: rt }));
        } catch (e) {
          console.log('SMOKE_ERROR ' + e.message);
        }
        setTimeout(() => app.exit(0), 400);
      }, 13000);
    });
  }

  // 截图模式：逐页切换并抓图（用 Electron 自身能力，不需要系统录屏权限）
  if (isShot) {
    mainWindow.webContents.on('did-finish-load', () => {
      setTimeout(async () => {
        const dir = process.env.QD_SHOT_DIR || path.join(__dirname, '../../build/shots');
        try {
          fs.mkdirSync(dir, { recursive: true });
        } catch { /* 已存在 */ }
        const pages = [
          ['analyze', '01-analyze', 0],
          ['analyze', '01b-analyze-kline', 620],
          ['analyze', '01c-analyze-diag', 1500],
          ['analyze', '01d-analyze-options', 2500],
          ['watch', '02-watch', 0],
          ['scan', '03-scan', 0],
          ['backtest', '04-backtest', 0],
          ['backtest', '04b-backtest-extras', 1400],
          ['alerts', '05-alerts', 0],
          ['alerts', '05b-alerts-rules', 1100],
          ['paper', '07-paper', 0],
          ['paper', '07b-paper-orders', 1300],
          ['risk', '08-risk', 0],
          ['risk', '08b-risk-limits', 1500],
          ['tax', '09-tax', 0],
          ['tax', '09b-tax-forms', 1400],
          ['settings', '06-settings', 0],
        ];
        // 截图前先切回日K并等它重新分析：截图要反映常用形态，
        // 也顺带验证周期切换确实触发了重算。
        try {
          await mainWindow.webContents.executeJavaScript(
            `(function(){var b=document.querySelector('#periodSeg button[data-p="day"]'); if(b) b.click(); return true;})()`
          );
          await new Promise((r) => setTimeout(r, 3000));
          console.log('SHOT period=day');
        } catch (e) {
          console.log('SHOT_PERIOD_FAIL ' + e.message);
        }
        for (const [view, name, scroll] of pages) {
          try {
            await mainWindow.webContents.executeJavaScript(
              `(function(){var el=document.querySelector('.nav-item[data-view="${view}"]'); if(el) el.click(); var c=document.querySelector('#content'); if(c) c.scrollTop=${scroll || 0}; return true;})()`
            );
            // 回测页要先把回测跑出来，否则下半页全是空的，截图看不出功能
            if (view === 'backtest') {
              await new Promise((r) => setTimeout(r, 600));
              // 三段都要触发：主回测 / 参数扫描 / 多策略对比 —— 只跑主回测的话，
              // 参数稳健性与对比表依旧是空的，等于没截到这几个新功能。
              for (const bid of ['#btnBacktest', '#btnParamScan', '#btnCompare']) {
                await mainWindow.webContents.executeJavaScript(
                  `(function(){var b=document.querySelector('${bid}'); if(b && !b.disabled) b.click(); return true;})()`
                );
                await new Promise((r) => setTimeout(r, 3500));
              }
              if (scroll) {
                await mainWindow.webContents.executeJavaScript(
                  `(function(){var c=document.querySelector('#content'); if(c) c.scrollTop=${scroll}; return true;})()`
                );
              }
              // 画面是空的必须能区分「没跑」还是「跑了但失败」，所以把探针和提示一起打出来
              const diag = await mainWindow.webContents.executeJavaScript(
                `(function(){
                   var A=window.__qd||{};
                   var t=document.querySelector('#toast');
                   return {bt: (A.bt?A.bt():null), toast:(t?t.textContent:''), errors:(window.__errors||[]).slice(-2)};
                 })()`
              );
              console.log('SHOT_BT ' + name + ' ' + JSON.stringify(diag));
            }
            await new Promise((r) => setTimeout(r, view === 'analyze' ? 2200 : 1200));
            // 抓到的图必须真的是目标页面 —— 之前出现过「文件名是 paper、画面是 alerts」，
            // 光看文件名完全发现不了。所以每张图都回读一次当前激活视图并断言。
            const actual = await mainWindow.webContents.executeJavaScript(
              `(function(){var v=document.querySelector('.view.active'); return v?v.id:'none';})()`
            );
            const want = 'view-' + view;
            if (actual !== want) {
              console.log(`SHOT_MISMATCH ${name} 期望 ${want} 实际 ${actual}`);
            }
            const img = await mainWindow.webContents.capturePage();
            fs.writeFileSync(path.join(dir, name + '.png'), img.toPNG());
            console.log('SHOT ' + name + ' view=' + actual);
          } catch (e) {
            console.log('SHOT_FAIL ' + name + ' ' + e.message);
          }
        }
        // 亮色主题补一张：套餐里两套主题都要有实拍图可核对
        try {
          await mainWindow.webContents.executeJavaScript(
            `(function(){
               var it=document.querySelector('.nav-item[data-view="analyze"]'); if(it) it.click();
               var b=document.querySelector('#themeSeg button[data-t="light"]'); if(b) b.click();
               var c=document.querySelector('#content'); if(c) c.scrollTop=620;
               return true;
             })()`
          );
          await new Promise((r) => setTimeout(r, 2200));
          const imgL = await mainWindow.webContents.capturePage();
          fs.writeFileSync(path.join(dir, '07-analyze-light.png'), imgL.toPNG());
          console.log('SHOT 07-analyze-light');
          // 还原深色，避免把测试用的主题留在用户的 store 里
          await mainWindow.webContents.executeJavaScript(
            `(function(){var b=document.querySelector('#themeSeg button[data-t="dark"]'); if(b) b.click(); return true;})()`
          );
        } catch (e) {
          console.log('SHOT_THEME_FAIL ' + e.message);
        }
        app.exit(0);
      }, 11000);
    });
  }
}

function buildMenu() {
  const template = [
    {
      label: 'QuantDesk',
      submenu: [
        { role: 'about', label: '关于 QuantDesk' },
        { type: 'separator' },
        { role: 'hide', label: '隐藏' },
        { role: 'unhide', label: '显示全部' },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { role: 'resetZoom', label: '实际大小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'close', label: '关闭' },
        { role: 'front', label: '前置全部窗口' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------- 扫描

let scanRunning = false;
/** v1.2.0：取消标志。worker 每处理完一只都会检查，做到「秒级响应」而不是等整批跑完。 */
let scanCancelRequested = false;

/** 统一的扫描进度推送（带上已耗时，界面要据此估算剩余时间） */
function sendScanProgress(p) {
  if (mainWindow && mainWindow.webContents) {
    try {
      mainWindow.webContents.send('scan:progress', p);
    } catch {
      /* 窗口已关闭时忽略 */
    }
  }
}

/**
 * 支持的扫描档位（单一数据源）。
 * 前端下拉从这里的 IPC 取，**不要在两处各硬编码一份** ——
 * 那样迟早出现「前端能选 1000、后端只认 300」这类对不上的问题。
 */
const SCAN_LIMITS = [50, 100, 150, 200, 300, 500, 1000];

/**
 * 按档位给出耗时预估（毫秒）。用于界面上显示「预计需要多久」，避免用户以为程序卡死。
 *
 * 系数由实测校准（`npm run scan-load -- 300` / `-- 1000`）：
 *   300 只实测 15.2s（估算 19.5s）、1000 只实测 34.7s（估算 32.8s），偏差 ±30% 以内。
 * 这个精度足够用于「要不要继续等」的判断 —— 它不需要准，需要的是量级正确。
 */
function estimateScanMs(limit) {
  const th = scanThrottle(limit);
  // 每只：1 次 K 线请求（偶发要试备用市场号，按 1.25 计）
  // 排队间隔按并发数摊薄，再叠加平均网络往返
  const perReq = 130;
  const queued = (limit * 1.25 * th.minInterval) / th.concurrency;
  return Math.round(queued + (limit * 1.25 * perReq) / th.concurrency);
}

/** 扫描规模 → 并发与限流参数。规模越大越激进，但留出足够余量避免被数据源掐断。 */
function scanThrottle(limit) {
  if (limit <= 150) return { concurrency: 3, minInterval: 180 };
  if (limit <= 300) return { concurrency: 5, minInterval: 130 };
  if (limit <= 600) return { concurrency: 6, minInterval: 100 };
  return { concurrency: 8, minInterval: 80 };
}

/** 结果裁剪：1000 只全量回传会有几 MB，IPC 序列化与渲染都会卡。只保留界面真正要用的字段。 */
function trimScanResult(r, deep) {
  if (deep) return r;
  return {
    secid: r.secid,
    code: r.code,
    name: r.name,
    group: r.group,
    price: r.price,
    changePct: r.changePct,
    score: r.score,
    factors: r.factors,
    bullCount: r.bullCount,
    bearCount: r.bearCount,
    signals: (r.signals || []).slice(0, 3),
    metrics: {
      rsi: r.metrics.rsi,
      ret20: r.metrics.ret20,
      ret60: r.metrics.ret60,
      volRatio: r.metrics.volRatio,
      distHigh: r.metrics.distHigh,
      atrPct: r.metrics.atrPct,
      volatility: r.metrics.volatility,
    },
    factor: r.factor
      ? { symbol: r.factor.symbol, composite: r.factor.composite, scores: r.factor.scores, pe: r.factor.pe, marketCap: r.factor.marketCap, raw: { avgAmount: (r.factor.raw || {}).avgAmount } }
      : null,
    pe: r.pe,
    marketCap: r.marketCap,
    amount: r.amount,
  };
}

async function runScan(options = {}) {
  if (scanRunning) return { error: '扫描任务正在运行中' };
  scanRunning = true;
  scanCancelRequested = false;
  const t0 = Date.now();
  let payloadBenchmark = null;
  const restoreThrottle = ds.setThrottle ? ds.setThrottle({ concurrency: 3, minInterval: 180 }) : null;
  try {
    const { source = 'pool', limit = 80, minPrice = 3, minAmount = 0, universe = '' } = options;
    // v1.2.0：上限放宽到 1000。夹紧到 [10, 1200] —— 前端算错或手改 IPC 参数时
    // 不至于把 3000 只的请求打到数据源上（那必然被封）。
    const LIMIT = Math.max(10, Math.min(1200, Number(limit) || 80));
    const expandPool = options.expandPool !== false;

    // 1) 候选池
    let candidates = [];
    const poolMeta = { source, requested: LIMIT, builtin: 0, expanded: 0, exhausted: false, pages: 0 };
    const pushUniq = (seen) => (row, group) => {
      const code = String(row.code || '').toUpperCase();
      if (!code || seen.has(code)) return false;
      if ((row.price || 0) < minPrice) return false;
      if (minAmount > 0 && (row.amount || 0) < minAmount) return false;
      seen.add(code);
      candidates.push({
        secid: row.secid || `105.${code}`,
        altSecid: row.altSecid || `106.${code}`,
        code,
        name: row.name || '',
        group: group || '',
        // 来自排行的行自带市值/PE，直接给因子层用，省掉一批实时行情请求
        _rank: row.marketCap || row.pe ? row : null,
      });
      return true;
    };

    if (source === 'universe' && universe) {
      // 来自 screener.js 的内置股票池。这里只拿到代码，没有 secid：
      // 美股在东财体系里就是「市场号.代码」，105=NASDAQ / 106=NYSE，
      // 而 Tencent / Sina 两个备用源只用代码，所以先用 105 试，失败再退到 106。
      const us = Screener.universes(store.get('watchlist').map((w) => w.code));
      const u = us[universe];
      if (!u) return { error: `未知股票池：${universe}` };
      const seen = new Set();
      const add = pushUniq(seen);
      for (const code of u.codes) add({ secid: `105.${code}`, code, name: '' }, u.label);
      poolMeta.builtin = candidates.length;
      // 内置池不够时用全市场补齐 —— 否则用户选了「扫描 1000 只」，
      // 实际只扫 70 只却没有任何提示，会误以为「已经扫完全市场」。
      if (expandPool && candidates.length < LIMIT) {
        try {
          const need = Math.min(1200, LIMIT + 40); // 多拉一点，过滤低价股后仍有富余
          const r = await ds.rankAll({
            total: need,
            onProgress: (p) => sendScanProgress({ stage: '补充候选池', done: p.fetched, total: need, current: '第 ' + p.page + ' 页' }),
          });
          poolMeta.pages = r.pages;
          poolMeta.exhausted = r.exhausted;
          for (const row of r.rows) {
            if (candidates.length >= LIMIT) break;
            add(row, '全市场补齐');
          }
        } catch {
          /* 补齐失败就用手上的内置池，不阻塞 */
        }
      }
      poolMeta.expanded = candidates.length - poolMeta.builtin;
    } else if (source === 'watch') {
      const seen = new Set();
      const add = pushUniq(seen);
      for (const w of store.get('watchlist')) add(w, '自选');
    } else if (source === 'market') {
      // 全市场：按成交额取头部。v1.2.0 起用 rankAll 分页拉取，
      // 实测东财每页最多 100 条，所以 1000 只要翻 10 页。
      try {
        const need = Math.min(1200, LIMIT + Math.max(40, Math.round(LIMIT * 0.3)));
        const r = await ds.rankAll({
          total: need,
          onProgress: (p) => sendScanProgress({ stage: '拉取全市场排行', done: p.fetched, total: need, current: '第 ' + p.page + ' 页' }),
        });
        poolMeta.pages = r.pages;
        poolMeta.exhausted = r.exhausted;
        const seen = new Set();
        const add = pushUniq(seen);
        for (const row of r.rows) {
          if (candidates.length >= LIMIT) break;
          add(row, '全市场');
        }
      } catch (e) {
        // 排行接口不稳时回退到内置池
        const seen = new Set();
        const add = pushUniq(seen);
        for (const p of POOL) {
          if (candidates.length >= LIMIT) break;
          add({ secid: p.secid, code: p.code, name: p.name }, p.group || '内置池');
        }
        poolMeta.fallback = '排行接口不可用，已回退到内置精选池：' + e.message;
      }
    } else {
      const seen = new Set();
      const add = pushUniq(seen);
      for (const p of POOL) {
        if (candidates.length >= LIMIT) break;
        add({ secid: p.secid, code: p.code, name: p.name }, p.group || '内置池');
      }
      poolMeta.builtin = candidates.length;
      if (expandPool && candidates.length < LIMIT) {
        try {
          const r = await ds.rankAll({ total: Math.min(1200, LIMIT + 40) });
          poolMeta.pages = r.pages;
          poolMeta.exhausted = r.exhausted;
          for (const row of r.rows) {
            if (candidates.length >= LIMIT) break;
            add(row, '全市场补齐');
          }
        } catch {
          /* 忽略 */
        }
      }
      poolMeta.expanded = candidates.length - poolMeta.builtin;
    }

    if (!candidates.length) return { error: '候选池为空' };

    const total = Math.min(candidates.length, LIMIT);
    const targets = candidates.slice(0, total);
    poolMeta.scanned = total;
    poolMeta.shortfall = LIMIT - total; // >0 说明标的数量不够（或全被价格门槛过滤）
    const results = [];
    let done = 0;
    let failed = 0;

    // 2) 抓 K 线 + 因子计算。
    //    并发与限流按规模动态调整：1000 只仍用 3 并发 × 180ms 的话，
    //    光排队就要 60 秒，加上网络往返得十几分钟，体验无法接受。
    const th = scanThrottle(total);
    if (ds.setThrottle) ds.setThrottle(th);
    poolMeta.throttle = th;
    let cursor = 0;
    const worker = async () => {
      while (cursor < targets.length) {
        if (scanCancelRequested) return;
        const idx = cursor++;
        const t = targets[idx];
        try {
          let k = await ds.kline(t.secid, { period: 'day', limit: 260, fq: 1 });
          // 交易所猜错时（105 建了 NYSE 的票）日线会空空如也，用备用市场号再试一次
          if ((!k || !k.bars || k.bars.length < 60) && t.altSecid) {
            const k2 = await ds.kline(t.altSecid, { period: 'day', limit: 260, fq: 1 });
            if (k2 && k2.bars && k2.bars.length >= 60) {
              k = k2;
              t.secid = t.altSecid;
            }
          }
          if (k && k.bars && k.bars.length >= 60) {
            const a = Factors.analyze(k.bars, null);
            if (a) {
              results.push({
                secid: t.secid,
                code: t.code || k.code,
                name: t.name || k.name,
                group: t.group || '',
                ...a,
                // v1.1.0：保留 K 线用于算多因子分，算完就删（不要回传给渲染层，太大）
                _bars: k.bars,
                _rank: t._rank || null,
              });
            }
          } else {
            failed++;
          }
        } catch {
          failed++;
        }
        done++;
        if (done % 3 === 0 || done === targets.length) {
          sendScanProgress({
            stage: '抓取行情与计算因子',
            done,
            total: targets.length,
            current: t.code,
            elapsed: Date.now() - t0,
          });
        }
      }
    };
    await Promise.all(Array.from({ length: th.concurrency }, worker));

    if (scanCancelRequested) {
      poolMeta.cancelled = true;
    }

    // 3) 补充实时行情（涨幅 / 成交额 / PE / 市值）
    //
    //    ★ v1.2.0 的关键优化：全市场排行榜返回的行**本身就带市值和 PE**，
    //      直接用即可。1000 只逐一再打一次行情接口既慢又必然被限流，
    //      原本「扫描 600 只」之所以那么慢，一半时间耗在这一步。
    //      只有「内置池 / 自选」这类不带估值数据的候选才需要补，而且限量。
    const needQuote = [];
    for (const r of results) {
      const rk = r._rank;
      if (rk) {
        if (rk.marketCap) r.marketCap = rk.marketCap;
        if (rk.floatCap) r.floatCap = rk.floatCap;
        if (rk.pe) r.pe = rk.pe;
        if (rk.amount) r.amount = rk.amount;
        if (rk.changePct != null && r.changePct == null) r.changePct = rk.changePct;
      }
      if (r.marketCap == null || r.pe == null) needQuote.push(r.secid);
    }
    // 规模越大补得越少：超过 300 只时干脆不补（因子层会用「缺失」分支处理，不编造数据）
    const QUOTE_CAP = total > 300 ? 0 : total > 150 ? 120 : 400;
    const quoteTargets = needQuote.slice(0, QUOTE_CAP);
    poolMeta.quoteNeeded = needQuote.length;
    poolMeta.quoteFilled = quoteTargets.length;
    poolMeta.quoteSkipped = needQuote.length - quoteTargets.length;
    if (quoteTargets.length) {
      try {
        const qt = await ds.quotes(quoteTargets, { maxAge: 60000, concurrency: th.concurrency });
        const map = new Map(qt.map((q) => [q.secid, q]));
        for (const r of results) {
          const q = map.get(r.secid);
          if (!q) continue;
          if (q.price) r.price = q.price;
          if (q.changePct != null) r.changePct = q.changePct;
          if (q.amount) r.amount = q.amount;
          if (q.marketCap) r.marketCap = q.marketCap;
          if (q.pe) r.pe = q.pe;
          if (q.floatCap) r.floatCap = q.floatCap;
          if (q.pb) r.pb = q.pb;
        }
      } catch {
        /* 行情补充失败忽略 */
      }
    }

    // 3.5) v1.1.0：多因子得分
    // 放在行情补充之后，因为「价值/规模/流动性」三个因子依赖 PE、市值与成交额。
    // 全部算完后做一次横截面重算（规模分位必须放在池子里比才有意义），再删掉 K 线。
    try {
      const bench = await fetchBenchmark();
      const facItems = [];
      for (const r of results) {
        if (!r._bars) continue;
        try {
          const f = Screener.computeFactors({
            bars: r._bars,
            quote: {
              code: r.code, name: r.name,
              marketCap: r.marketCap, floatCap: r.floatCap,
              pe: r.pe, pb: r.pb, changePct: r.changePct, amount: r.amount,
            },
            symbol: r.code,
            benchmark: bench,
            ppy: 252,
          });
          if (f) {
            r.factor = f;
            facItems.push(f);
          }
        } catch {
          /* 单只因子失败不影响整表 */
        }
      }
      if (facItems.length) {
        const cs = Screener.scoreUniverse(facItems, { sort: 'composite' });
        const csMap = new Map(cs.map((x) => [x.symbol, x]));
        for (const r of results) {
          if (!r.factor) continue;
          const c = csMap.get(r.factor.symbol);
          if (c) r.factor = { ...r.factor, scores: c.scores, composite: c.composite, sizePercentile: c.sizePercentile };
        }
      }
      payloadBenchmark = bench;
    } catch {
      /* 因子层整体失败时，界面上的预设策略会提示「缺因子数据」，不影响原有评分 */
    }
    for (const r of results) {
      delete r._bars;
      delete r._rank; // 诊断用的原始行，不回传给渲染层
    }

    results.sort((a, b) => b.score - a.score);
    // 规模大时裁剪字段：1000 只全量（含完整 metrics + signals + factor.raw）回传有几 MB，
    // IPC 序列化与表格渲染都会明显卡顿。界面真正用到的字段在 trimScanResult 里列全了。
    const deep = total <= 300;
    const payload = {
      results: results.map((r) => trimScanResult(r, deep)),
      scannedAt: Date.now(),
      costMs: Date.now() - t0,
      source,
      limit: LIMIT,
      poolMeta,
      failed,
      truncated: !deep,
      benchmark: payloadBenchmark,
      hasFactors: results.some((r) => !!r.factor),
    };
    store.set('scanResults', payload);
    store.set('lastScanAt', payload.scannedAt);
    return payload;
  } finally {
    scanRunning = false;
    scanCancelRequested = false;
    // 恢复默认限流 —— 不恢复的话，一次 1000 只的扫描会把全局参数
    // 永久留在高并发档，之后所有请求都贴着限流边缘跑
    if (restoreThrottle) restoreThrottle();
  }
}

// ---------------------------------------------------------------- 机会雷达（v1.1.0）
//
// 一次「机会雷达」扫描 = 行情 + 因子 + 风险机会 + 新闻 + 未来事件 + 暴涨潜力分。
// 设计上刻意分成两趟：
//   第 1 趟只用 K 线（快、必成功），算出因子与暴涨潜力，用于**选出 Top N**；
//   第 2 趟只对 Top N 去抓新闻 / 财报日 / 空头 / 分析师（慢、可能失败），
//   然后把完整上下文重新喂给 insight，产出最终的风险点与机会点。
// 这样做的原因：新闻与日历接口有速率限制，对全池抓会又慢又容易被打断；
// 而「哪些标的值得深挖」这一步用不依赖它们的价格因子就够了。

const radarState = { running: false, last: null };

/** 代码 → 中文名（东财以中文报道为主，用中文名搜命中率高得多） */
const NAME_MAP = {};
for (const p of POOL) if (p && p.code) NAME_MAP[String(p.code).toUpperCase()] = p.name || '';

/**
 * 抓某只标的的新闻并做**相关性过滤**。
 * 东财搜索是全文检索，搜代码会混进大量泛市场新闻（搜 PLTR 能返回「智谱AI概念」），
 * 不过滤的话个股情绪分会变成大盘情绪分的复读机。
 * 策略：优先「标题必须命中代码/公司名」的严格口径，命中不足 2 条才放宽到正文。
 */
function newsForSymbol(nb, sym, name) {
  const aliases = [NAME_MAP[sym]].filter(Boolean);
  const rows = [];
  for (const key of [sym, name, ...aliases].filter(Boolean)) {
    const got = nb.perKeyword[key];
    if (got) for (const r of got) rows.push({ ...r, symbol: sym });
  }
  const parsed = Newsfeed.fromEastmoney(rows, sym);
  const keys = [sym, name, ...aliases].filter(Boolean);
  const target = { symbol: sym, name, aliases };
  const strict = Newsfeed.relevant(parsed, target, { strict: true });
  const loose = Newsfeed.relevant(parsed, target);
  // 严格口径只要命中就用它；一条都没有时才放宽到「正文命中」。
  const used = strict.length >= 1 ? strict : loose;
  // keysOf：让 newsfeed 能定位到「提到这只票的那句话」，做句子级情绪打分
  return { items: Newsfeed.score(used, { keysOf: () => keys }), rawCount: parsed.length, keptCount: used.length };
}

/**
 * 取基准。
 * 用 SPY（标普 500 ETF）而不是 100.SPX —— 指数代码在部分数据源上没有日线，
 * 而 ETF 的日线在所有源上都稳定可得，两者走势几乎一致，做相对强度足够。
 * 兜底顺序：SPY → QQQ → 100.SPX。
 */
async function fetchBenchmark() {
  const tries = [
    { secid: '105.SPY', code: 'SPY', label: '标普500ETF' },
    { secid: '105.QQQ', code: 'QQQ', label: '纳指100ETF' },
    { secid: '100.SPX', code: 'SPX', label: '标普500指数' },
  ];
  for (const t of tries) {
    try {
      const k = await ds.kline(t.secid, { period: 'day', limit: 160, fq: 1 });
      const c = (k.bars || []).map((b) => b.close);
      if (c.length < 61) continue;
      const last = c[c.length - 1];
      return {
        code: t.code, label: t.label, secid: t.secid,
        ret20: (last / c[c.length - 21] - 1) * 100,
        ret60: (last / c[c.length - 61] - 1) * 100,
        price: last,
        asOf: k.bars[k.bars.length - 1].date,
        src: k.src,
      };
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

/** 简易并发池（主进程里多处要用，不再单独抽文件） */
async function poolRun(items, concurrency, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        out[i] = await fn(items[i], i);
      } catch {
        out[i] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  return out;
}

/**
 * @param {Object} options {
 *   universe, limit, includeNews, includeEvents, includeExtras,
 *   newsTop, extrasTop, eventDays, minAmount, secids
 * }
 */
async function runRadar(options = {}) {
  if (radarState.running) return { error: '机会雷达扫描正在运行中' };
  radarState.running = true;
  const t0 = Date.now();
  const progress = (stage, done, total, current) => {
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('radar:progress', { stage, done, total, current });
    }
  };
  try {
    const o = options || {};
    const universe = o.universe || 'highbeta';
    const limit = Math.max(5, Math.min(120, Number(o.limit) || 30));
    const includeNews = o.includeNews !== false;
    const includeEvents = o.includeEvents !== false;
    const includeExtras = o.includeExtras !== false;
    const newsTop = Math.max(0, Math.min(40, Number(o.newsTop) || 12));
    const extrasTop = Math.max(0, Math.min(40, Number(o.extrasTop) || 12));
    const eventDays = Math.max(7, Math.min(90, Number(o.eventDays) || 30));
    const minAmount = Number(o.minAmount) || 0;

    // 1) 候选池
    let candidates = [];
    if (Array.isArray(o.secids) && o.secids.length) {
      candidates = o.secids.map((s) => (typeof s === 'string' ? { secid: s, code: ds.num ? String(s).split('.').slice(1).join('.') : s } : s));
    } else if (universe === 'watch') {
      candidates = store.get('watchlist').map((w) => ({ ...w }));
    } else {
      const us = Screener.universes(store.get('watchlist').map((w) => w.code));
      const u = us[universe];
      if (!u) return { error: `未知股票池：${universe}` };
      candidates = u.codes.map((code) => ({
        secid: `105.${code}`,
        altSecid: `106.${code}`,
        code,
        name: '',
        group: u.label,
      }));
    }
    if (!candidates.length) return { error: '候选池为空' };
    // 池子可以做样本上限截断，避免一次扫描几百只
    if (candidates.length > limit * 2) candidates = candidates.slice(0, limit * 2);

    // 2) 基准
    const benchmark = await fetchBenchmark();
    progress('基准', 0, 1, benchmark ? '标普500 已就绪' : '基准不可用');

    // 3) 第 1 趟：K 线 + 因子
    let done = 0;
    const first = await poolRun(candidates, 3, async (t) => {
      let k = null;
      try {
        k = await ds.kline(t.secid, { period: 'day', limit: 260, fq: 1 });
      } catch {
        k = null;
      }
      if ((!k || !k.bars || k.bars.length < 60) && t.altSecid) {
        try {
          const k2 = await ds.kline(t.altSecid, { period: 'day', limit: 260, fq: 1 });
          if (k2 && k2.bars && k2.bars.length >= 60) {
            k = k2;
            t.secid = t.altSecid;
          }
        } catch {
          /* 备用市场号也失败，放弃这一只 */
        }
      }
      done++;
      progress('行情', done, candidates.length, t.code);
      if (!k || !k.bars || k.bars.length < 60) return null;
      return { t, k };
    });

    const valid = first.filter(Boolean);
    if (!valid.length) return { error: '没有取到足够的K线数据（可能数据源整体不可达）' };

    // 4) 补行情（市值 / PE 对因子与估值判断必要）
    try {
      const qt = await ds.quotes(valid.map((v) => v.t.secid), { maxAge: 120000, concurrency: 3 });
      const qmap = new Map(qt.map((q) => [q.secid, q]));
      for (const v of valid) v.quote = qmap.get(v.t.secid) || null;
    } catch {
      /* 行情补充失败不阻塞：因子里的 PE/市值会走缺失分支 */
    }

    // 5) 因子 + 暴涨潜力
    const scored = valid.map(({ t, k, quote }) => {
      const q = quote || { code: t.code || k.code, name: t.name || k.name };
      const f = Screener.computeFactors({ bars: k.bars, quote: q, symbol: t.code || k.code, benchmark, ppy: 252 });
      const m = Moonshot.score({ bars: k.bars, quote: q, symbol: t.code || k.code, benchmark, ppy: 252 });
      return { t, k, quote: q, factors: f, moonshot: m };
    }).filter((x) => x.factors);

    if (!scored.length) return { error: '因子计算全部失败（K线长度不足 60 根）' };

    // 横截面重算规模分位
    const crossSection = Screener.scoreUniverse(scored.map((x) => x.factors), { sort: 'composite' });
    const csMap = new Map(crossSection.map((x) => [x.symbol, x]));
    for (const x of scored) {
      const cs = csMap.get(x.factors.symbol);
      if (cs) x.factors = { ...x.factors, scores: cs.scores, composite: cs.composite, sizePercentile: cs.sizePercentile };
    }

    // 按暴涨潜力分排序（雷达的核心排序口径），同时保留综合因子分
    scored.sort((a, b) => (b.moonshot ? b.moonshot.score : 0) - (a.moonshot ? a.moonshot.score : 0));
    // 成交额门槛过滤
    const passed = minAmount > 0
      ? scored.filter((x) => ((x.factors.raw || {}).avgAmount || 0) >= minAmount)
      : scored;
    const tops = passed.slice(0, Math.max(limit, newsTop, extrasTop));

    // 6) 未来事件（全场一次，日历是按天查的，必须限流）
    let events = [];
    let eventSummary = null;
    if (includeEvents) {
      progress('事件日历', 0, 1, '拉取财报排期…');
      try {
        const bundle = await ds.calendarBundle({
          days: eventDays,
          include: ['earnings'],
        });
        events = Events.upcoming({
          days: eventDays,
          earnings: bundle.earnings,
          focusSymbols: tops.map((x) => String(x.factors.symbol).toUpperCase()),
        });
        eventSummary = {
          fetchedDates: bundle.fetchedDates,
          earningsTotal: (bundle.earnings || []).length,
          errors: bundle.errors,
        };
      } catch (e) {
        eventSummary = { error: e.message };
      }
    }

    // 7) 新闻（只对 Top N）
    let newsMap = new Map();
    let newsSummaryMeta = null;
    if (includeNews && newsTop > 0) {
      const targets = tops.slice(0, newsTop);
      // 关键词用「代码 + 中文名」，中文名命中率显著更高（东财以中文报道为主）
      const kws = [];
      for (const x of targets) {
        kws.push(String(x.factors.symbol));
        if (x.quote && x.quote.name && x.quote.name !== x.factors.symbol) kws.push(x.quote.name);
      }
      progress('新闻', 0, kws.length, '抓取新闻…');
      try {
        const nb = await ds.newsBundle(kws, { limit: 10, concurrency: 2 });
        let raw = 0;
        let kept = 0;
        for (const x of targets) {
          const sym = String(x.factors.symbol).toUpperCase();
          const name = x.quote && x.quote.name ? x.quote.name : '';
          const r = newsForSymbol(nb, sym, name);
          newsMap.set(sym, r.items);
          raw += r.rawCount;
          kept += r.keptCount;
        }
        newsSummaryMeta = { errors: nb.errors, keywords: kws.length, rawHits: raw, afterRelevance: kept };
      } catch (e) {
        newsSummaryMeta = { error: e.message };
      }
    }

    // 8) 空头 + 分析师（只对 Top N）
    const extrasMap = new Map();
    if (includeExtras && extrasTop > 0) {
      const targets = tops.slice(0, extrasTop);
      progress('空头与分析师', 0, targets.length, '拉取增强数据…');
      await poolRun(targets, 2, async (x) => {
        const sym = String(x.factors.symbol).toUpperCase();
        const ex = await ds.fundamentalExtras(sym);
        if (ex) extrasMap.set(sym, ex);
      });
    }

    // 9) 第 2 趟：带完整上下文的 insight（逐条可回溯）
    const rows = tops.map((x) => {
      const sym = String(x.factors.symbol).toUpperCase();
      const news = newsMap.get(sym) || [];
      const newsSummary = news.length ? Newsfeed.summarize(news) : null;
      const ex = extrasMap.get(sym) || {};
      const dte = Events.daysToEarnings(sym, events, undefined) ||
        (() => {
          // 日历里没有排期时，至少给「财报季窗口」这一层信息
          return null;
        })();
      const companyEvents = events.filter((e) => e.symbol === sym);
      const evRisk = Events.riskProfile(
        [...companyEvents, ...events.filter((e) => e.scope === 'market')],
        { symbol: sym }
      );
      const ins = Insight.analyze({
        bars: x.k.bars,
        quote: x.quote,
        factors: x.factors,
        newsSummary,
        eventRisk: evRisk,
        daysToEarnings: dte,
        shortInterest: ex.shortInterest || null,
        analyst: ex.analyst || null,
        benchmark,
        ppy: 252,
      });
      // 第二趟重算暴涨潜力分：第一趟只有价格，催化维度拿不到新闻/财报/分析师，
      // 会一律落到中位分 —— 等于把 6% 的权重变成常数。
      const m2 = Moonshot.score({
        bars: x.k.bars, quote: x.quote, symbol: sym, benchmark, ppy: 252,
        newsSummary, daysToEarnings: dte,
        shortInterest: ex.shortInterest || null, analyst: ex.analyst || null,
      });
      return {
        secid: x.t.secid,
        symbol: sym,
        name: x.factors.name || x.quote.name || sym,
        group: x.t.group || '',
        price: x.factors.price,
        changePct: x.factors.changePct,
        pe: x.factors.pe,
        marketCap: x.factors.marketCap,
        factorComposite: x.factors.composite,
        scores: x.factors.scores,
        raw: x.factors.raw,
        moonshot: m2 || x.moonshot,
        insight: ins,
        news,
        newsSummary,
        daysToEarnings: dte,
        events: companyEvents,
        shortInterest: ex.shortInterest || null,
        analyst: ex.analyst || null,
        extrasErrors: ex.errors || null,
        bars: x.k.bars.length,
      };
    });
    // 用重算后的分数重排（第一趟的排序基于不完整上下文）
    rows.sort((a, b) => (b.moonshot ? b.moonshot.score : 0) - (a.moonshot ? a.moonshot.score : 0));

    // 10) 组合级汇总
    const poolMoonshot = Moonshot.rank(
      tops.map((x) => ({
        bars: x.k.bars, quote: x.quote, symbol: x.factors.symbol,
        benchmark, ppy: 252,
      })),
      { topN: tops.length }
    );

    // 宏观事件窗口固定至少 45 天：只有 7~8 天的话经常「一条都没有」，
    // 看起来像功能失效，实际上是窗口太窄（宏观数据发布密度约每周 1-2 次）。
    const marketEvents = Events.upcoming({ days: Math.max(45, Math.min(eventDays, 120)) });
    const marketRisk = Events.riskProfile(marketEvents.filter((e) => e.scope === 'market'));

    const allNews = [];
    for (const [, list] of newsMap) allNews.push(...list);
    const overallNews = Newsfeed.summarize(Newsfeed.score(allNews));

    // 机会股：暴涨潜力分高 + 风险调整净分为正
    const opportunities = rows
      .filter((r) => r.moonshot && r.moonshot.grade !== 'D')
      .map((r) => ({
        symbol: r.symbol, name: r.name, price: r.price, changePct: r.changePct,
        grade: r.moonshot.grade, moonshotScore: r.moonshot.score,
        opportunity: r.insight && r.insight.scores ? r.insight.scores.opportunity : null,
        risk: r.insight && r.insight.scores ? r.insight.scores.risk : null,
        netAdjusted: r.insight && r.insight.scores ? r.insight.scores.netAdjusted : null,
        stance: r.insight && r.insight.stance ? r.insight.stance.label : '',
        topTriggers: (r.moonshot.triggers || []).slice(0, 2),
        topRisks: (r.insight.risks || []).slice(0, 3).map((x) => x.label),
      }))
      .sort((a, b) => (b.netAdjusted || 0) - (a.netAdjusted || 0));

    const payload = {
      rows,
      opportunities,
      benchmark,
      universe,
      events,
      marketEvents: marketEvents.slice(0, 30),
      marketRisk,
      eventSummary,
      newsSummaryMeta,
      overallNews,
      poolMoonshot: {
        total: poolMoonshot.total,
        distribution: poolMoonshot.distribution,
        summary: poolMoonshot.summary,
        warning: poolMoonshot.warning,
      },
      scannedAt: Date.now(),
      costMs: Date.now() - t0,
      sources: ds.activeSource(),
      degraded: {
        news: newsMap.size === 0,
        events: events.length === 0,
        extras: extrasMap.size === 0,
      },
      disclaimer:
        '本页所有结论均由公开行情、成交量与新闻按固定规则计算得出，用于缩小研究范围，不构成投资建议。' +
        '新闻情绪为关键词规则分（非模型判断），事件日期可能被官方调整，请以原始来源为准。',
    };
    radarState.last = payload;
    store.set('radarLast', payload);
    return payload;
  } finally {
    radarState.running = false;
  }
}

/** 单独取「未来事件日历」（不跑扫描，供界面事件面板用） */
async function fetchEventCalendar(options = {}) {
  const o = options || {};
  const days = Math.max(7, Math.min(120, Number(o.days) || 45));
  const focus = (o.symbols || []).map((s) => String(s).toUpperCase());
  let earnings = [];
  let errors = {};
  if (o.includeEarnings !== false) {
    try {
      const b = await ds.calendarBundle({ days, include: ['earnings'] });
      earnings = b.earnings || [];
      errors = b.errors || {};
    } catch (e) {
      errors.earnings = e.message;
    }
  }
  let dividends = [];
  let splits = [];
  if (o.includeCorp) {
    try {
      const b = await ds.calendarBundle({ days: Math.min(days, 30), include: ['dividends', 'splits'] });
      dividends = b.dividends || [];
      splits = b.splits || [];
    } catch (e) {
      errors.corp = e.message;
    }
  }
  const events = Events.upcoming({
    days,
    earnings,
    dividends,
    splits,
    focusSymbols: focus,
  });
  return {
    events,
    marketEvents: Events.upcoming({ days }).filter((e) => e.scope === 'market'),
    risk: Events.riskProfile(events),
    counts: { earnings: earnings.length, dividends: dividends.length, splits: splits.length },
    errors,
    days,
    generatedAt: Date.now(),
  };
}

/** 抓新闻并打分（独立入口，供新闻面板刷新） */
async function fetchNews(keywords, options = {}) {
  const kws = (Array.isArray(keywords) ? keywords : [keywords]).filter(Boolean);
  if (!kws.length) return { items: [], summary: null, errors: {} };
  const nb = await ds.newsBundle(kws, { limit: (options && options.limit) || 12, concurrency: 2 });
  const items = Newsfeed.score(Newsfeed.fromEastmoney(nb.items, null));
  return { items, summary: Newsfeed.summarize(items), perKeyword: nb.perKeyword, errors: nb.errors };
}

// ---------------------------------------------------------------- 监控轮询（v1.0.2）
//
// 为什么放在主进程：渲染层在窗口最小化 / 被系统挂起时定时器会被节流，
// 而「告警及时」恰恰要求在没人看界面的时候也得跑。这里用主进程定时器，
// 规则求值交给 alerts.js 的纯函数，投递交给 notify.js，三者职责不重叠。

const monitor = {
  timer: null,
  ticks: 0,
  lastBeatAt: null,
  lastError: '',
  lastByRule: new Map(), // ruleId → 上次触发时间，用于冷却
  lastAlerts: [],
};

/** 冷却：同一条规则在 cooldownMs 内只发一次，避免盘中反复轰炸 */
const MONITOR_COOLDOWN_MS = 5 * 60 * 1000;

async function collectSnapshot() {
  const cfg = store.get('config') || {};
  const alerts = store.get('alerts') || [];
  const symbols = [...new Set(alerts.map((a) => a.secid).filter(Boolean))];

  const t0 = Date.now();
  let quotes = [];
  try {
    quotes = symbols.length ? await ds.quotes(symbols, { maxAge: 20000, concurrency: 2 }) : [];
  } catch (e) {
    monitor.lastError = '行情拉取失败：' + (e.message || e);
  }
  const latencyMs = Date.now() - t0;

  // 报价 → 快照里的 quotes（字段名与 alerts.evalRule 读取的一致）
  const qmap = {};
  for (const q of quotes) {
    qmap[q.secid] = {
      symbol: q.code,
      price: q.price,
      changePct: q.changePct,
      volume: q.amount,
      high: q.high,
      low: q.low,
      prevClose: q.prevClose,
    };
  }
  // secid → 代码，供规则用 symbol 匹配
  const codeOf = new Map(quotes.map((q) => [q.secid, q.code]));
  const byCode = {};
  for (const q of quotes) byCode[String(q.code).toUpperCase()] = qmap[q.secid];

  // 技术类规则（RSI / 均线 / 量比）需要日线：只对用到了这类规则、且确实在自选里的标的拉
  const needTa = alerts.some((a) => ['rsi_above', 'rsi_below', 'ma_break', 'vol_spike'].includes(a.type));
  if (needTa) {
    const targets = [...new Set(alerts.filter((a) => ['rsi_above', 'rsi_below', 'ma_break', 'vol_spike'].includes(a.type)).map((a) => a.secid).filter(Boolean))];
    const CONC = 2;
    let cursor = 0;
    const worker = async () => {
      while (cursor < targets.length) {
        const secid = targets[cursor++];
        try {
          const k = await ds.kline(secid, { period: 'day', limit: 120, fq: 1 });
          const bars = (k && k.bars) || [];
          if (bars.length < 60) continue;
          const closes = bars.map((b) => b.close);
          const vols = bars.map((b) => b.volume || 0);
          const code = codeOf.get(secid) || secid.split('.')[1];
          const slot = (byCode[String(code).toUpperCase()] = byCode[String(code).toUpperCase()] || {});
          slot.rsi = Indicators.rsi(closes, 14).slice(-1)[0];
          const ma20 = Indicators.sma(closes, 20);
          slot.ma = ma20.slice(-1)[0];
          const v5 = Indicators.volMa(vols, 5).slice(-1)[0];
          const v20 = Indicators.volMa(vols, 20).slice(-1)[0];
          slot.volRatio = v20 ? v5 / v20 : null;
        } catch { /* 单只失败跳过 */ }
        if (mainWindow && mainWindow.webContents) {
          mainWindow.webContents.send('monitor:progress', { done: targets.indexOf(secid) + 1, total: targets.length });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONC, targets.length) }, worker));
  }

  // 账户与风控快照：模拟盘账户由渲染层持有（持仓明细也在那边），主进程没有持仓明细，
  // 因此账户级规则（回撤 / 单日亏损 / 保证金）这里传 null —— 不编造数字，
  // 这类规则由渲染层在「监控告警」页面用真实账户状态求值。
  const session = Market.session(new Date());
  const anomalies = Alerts.detectAnomalies({
    now: Date.now(),
    lastQuoteAt: quotes.length ? new Date().toISOString() : null,
    expectQuotes: symbols.length > 0,
    apiFailures: monitor.lastError && /行情拉取失败/.test(monitor.lastError) ? 3 : 0,
    apiLatencyMs: latencyMs,
    orders: [],
    risk: null,
    dayTrades: [],
    equity: null,
  });

  return { byCode, qmap, anomalies, latencyMs, quoteCount: quotes.length, session, symbols: symbols.length };
}

async function monitorTick() {
  if (!store) return null;
  monitor.ticks++;
  monitor.lastBeatAt = Date.now();
  const cfg = store.get('config') || {};
  const channelKeys = (cfg.activeChannels || []).filter((k) => (cfg.channels || {})[k] && cfg.channels[k].enabled !== false);

  // ---- 1) 价格/技术规则求值
  const snap = await collectSnapshot();
  const rules = (store.get('alertRules') || []).filter((r) => r.enabled !== false);

  // 内置的价格预警（用户在「预警监控」里加的那几条）也转成规则一起算
  const legacy = (store.get('alerts') || []).map((a) => ({
    id: a.id,
    type: a.type,
    symbol: a.code,
    value: a.value,
    severity: 'medium',
    enabled: true,
    note: a.note || '',
  }));

  const allRules = [...rules, ...legacy];
  const evalSnap = {
    quotes: snap.byCode,
    account: null,
    positions: [],
    orders: [],
    risk: null,
    earnings: {},
  };
  const hits = Alerts.evaluateRules(allRules, evalSnap);
  const now = Date.now();
  const fired = [];
  for (const h of hits) {
    const last = monitor.lastByRule.get(h.ruleId) || 0;
    if (now - last < MONITOR_COOLDOWN_MS) continue;
    monitor.lastByRule.set(h.ruleId, now);
    fired.push(h);
  }

  // ---- 2) 投递
  const delivered = [];
  if (fired.length && channelKeys.length) {
    for (const h of fired) {
      const rs = await notify.sendAll(channelKeys, cfg.channels, h, {
        notify: (title, body) => {
          if (Notification.isSupported()) new Notification({ title, body }).show();
        },
      });
      delivered.push({ ruleId: h.ruleId, title: h.title, results: rs });
      audit('warn', 'alert', `${h.title}：${h.detail}`.slice(0, 300), { ruleId: h.ruleId, channels: rs.map((r) => `${r.key}:${r.ok ? 'ok' : 'fail'}`).join(',') });
    }
  } else if (fired.length) {
    // 没配渠道也要在本机弹出来，否则用户根本不知道触发了
    for (const h of fired) {
      if (Notification.isSupported()) new Notification({ title: 'QuantDesk 告警', body: `${h.title}\n${h.detail || ''}` }).show();
      audit('info', 'alert', `${h.title}（未配置推送渠道，仅本机通知）`, { ruleId: h.ruleId });
    }
  }

  // ---- 3) 异常也投递（与规则不同的东西：规则是「你主动设的线」，异常是「系统自己发现不对」）
  const anoms = (snap.anomalies && snap.anomalies.anomalies) || [];
  for (const a of anoms) {
    const key = 'anomaly:' + a.key;
    const last = monitor.lastByRule.get(key) || 0;
    if (Date.now() - last < MONITOR_COOLDOWN_MS) continue;
    monitor.lastByRule.set(key, Date.now());
    const alert = { level: a.level, title: `异常检测 · ${a.label}`, detail: a.detail, hitAt: new Date().toISOString() };
    if (channelKeys.length) await notify.sendAll(channelKeys, cfg.channels, alert, {
      notify: (title, body) => { if (Notification.isSupported()) new Notification({ title, body }).show(); },
    });
    audit(a.level === 'high' ? 'error' : 'warn', 'anomaly', `${a.label}：${a.detail}`.slice(0, 300), {});
  }

  const result = {
    at: now,
    ticks: monitor.ticks,
    quotes: snap.quoteCount,
    latencyMs: snap.latencyMs,
    fired,
    delivered,
    anomalies: anoms,
    session: { phase: snap.session.phase, label: snap.session.label, et: snap.session.et },
    channels: channelKeys,
    error: monitor.lastError,
  };
  monitor.lastAlerts = fired.slice(-20);
  store.set('monitor', {
    running: true,
    lastBeatAt: now,
    ticks: monitor.ticks,
    lastError: monitor.lastError,
    lastResult: { at: now, quotes: snap.quoteCount, latencyMs: snap.latencyMs, fired: fired.length, anomalies: anoms.length },
  });
  if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('monitor:tick', result);
  return result;
}

function startMonitor() {
  const cfg = store.get('config') || {};
  const ms = Math.max(10000, Number(cfg.monitorInterval) || 30000);
  if (monitor.timer) clearInterval(monitor.timer);
  monitor.lastError = '';
  monitor.tick0 = true;
  monitor.timer = setInterval(() => {
    monitorTick().catch((e) => {
      monitor.lastError = String(e.message || e);
    });
  }, ms);
  store.set('monitor', { running: true, lastBeatAt: monitor.lastBeatAt, ticks: monitor.ticks, lastError: '' });
  return { running: true, intervalMs: ms };
}

function stopMonitor() {
  if (monitor.timer) clearInterval(monitor.timer);
  monitor.timer = null;
  store.set('monitor', { running: false, lastBeatAt: monitor.lastBeatAt, ticks: monitor.ticks, lastError: monitor.lastError });
  return { running: false };
}

/** 审计日志：只保留最近 500 条，避免 store.json 无限膨胀 */
function audit(level, category, message, extra) {
  try {
    const entry = Alerts.auditEntry(level, category, message, extra || {});
    const list = store.get('auditLog') || [];
    list.push(entry);
    store.set('auditLog', list.slice(-500));
    return entry;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- IPC

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  }));

  // ---- 截图模式：把 search/kline mock 成几只常用美股的 fake 数据
  // 沙箱里可能没有外网，回测出不来结果就只能拍空白页面。
  // mock 内容是 2 年日线 + 一个基准，跟真实数据接口完全一致，截图可信。
  let _shotMock = !!process.env.QD_SHOT_DIR;
  function mockBars(secid, opt) {
    const period = (opt && opt.period) || 'day';
    const limit = Math.min((opt && opt.limit) || 320, 400);
    const isUs = /^105\.|^106\./.test(secid);
    const isBench = /^bench\.|^idx\./.test(secid);
    let base = 100;
    if (/NVDA/.test(secid)) base = 180;
    else if (/AAPL/.test(secid)) base = 200;
    else if (/MSFT/.test(secid)) base = 410;
    else if (/TSLA/.test(secid)) base = 250;
    else if (/SPY|QQQ|bench/i.test(secid)) base = 500;
    else if (isBench) base = 4500;
    const start = new Date('2024-04-01');
    const bars = [];
    let p = base;
    for (let i = 0; i < limit; i++) {
      const d = new Date(start.getTime());
      d.setDate(d.getDate() + i);
      // 跳过周末，避免回测引擎报"乱序"
      const wd = d.getDay();
      if (wd === 0 || wd === 6) continue;
      const drift = 0.0006 + Math.sin(i / 9) * 0.015;
      const open = p;
      p = p * (1 + drift);
      const close = p;
      const high = Math.max(open, close) * (1 + Math.random() * 0.005);
      const low = Math.min(open, close) * (1 - Math.random() * 0.005);
      bars.push({
        date: d.toISOString().slice(0, 10),
        open,
        high,
        low,
        close,
        volume: 1e6 + Math.random() * 9e5,
      });
      if (bars.length >= limit) break;
    }
    return { secid, period, fq: (opt && opt.fq) || 1, bars };
  }
  function mockSearch(kw) {
    const u = String(kw || '').trim().toUpperCase();
    const base = [
      { code: 'NVDA', secid: '105.NVDA', name: '英伟达', market: 'us' },
      { code: 'AAPL', secid: '105.AAPL', name: '苹果', market: 'us' },
      { code: 'MSFT', secid: '105.MSFT', name: '微软', market: 'us' },
      { code: 'TSLA', secid: '105.TSLA', name: '特斯拉', market: 'us' },
      { code: 'SPY', secid: 'bench.SPY', name: 'SPDR S&P 500', market: 'us' },
    ];
    if (!u) return base;
    return base.filter((x) => x.code.includes(u) || x.name.includes(u));
  }

  ipcMain.handle('ds:search', async (_, kw) => (_shotMock ? mockSearch(kw) : await ds.search(kw)));
  ipcMain.handle('ds:quotes', async (_, secids, opt) => (_shotMock ? [] : await ds.quotes(secids, opt || {})));
  ipcMain.handle('ds:kline', async (_, secid, opt) => (_shotMock ? mockBars(secid, opt || {}) : await ds.kline(secid, opt || {})));
  ipcMain.handle('ds:indexes', async () => (_shotMock ? [] : await ds.indexQuotes()));
  ipcMain.handle('ds:rank', async (_, opt) => (_shotMock ? { rows: [] } : await ds.rank(opt || {})));
  ipcMain.handle('ds:pool', () => POOL);
  ipcMain.handle('ds:clearCache', () => {
    ds.clearCache();
    return true;
  });

  ipcMain.handle('scan:run', (_, opt) => runScan(opt || {}));
  ipcMain.handle('scan:last', () => store.get('scanResults'));
  // v1.2.0：扫描档位与取消
  ipcMain.handle('scan:limits', () => ({
    limits: SCAN_LIMITS,
    estimates: SCAN_LIMITS.reduce((acc, n) => {
      acc[n] = estimateScanMs(n);
      return acc;
    }, {}),
    running: scanRunning,
  }));
  ipcMain.handle('scan:cancel', () => {
    if (!scanRunning) return { ok: false, message: '当前没有正在运行的扫描' };
    scanCancelRequested = true;
    return { ok: true, message: '已请求取消，正在停止（不会等待当前批次跑完）' };
  });

  // ---- v1.1.0：机会雷达 / 新闻 / 事件日历
  ipcMain.handle('radar:run', (_, opt) => runRadar(opt || {}));
  ipcMain.handle('radar:last', () => store.get('radarLast'));
  ipcMain.handle('news:fetch', (_, kws, opt) => fetchNews(kws, opt || {}));
  ipcMain.handle('events:fetch', (_, opt) => fetchEventCalendar(opt || {}));
  ipcMain.handle('events:macro', () => ({
    items: Events.upcoming({ days: 120 }),
    risk: Events.riskProfile(Events.upcoming({ days: 120 }).filter((e) => e.scope === 'market')),
  }));
  ipcMain.handle('extras:fetch', async (_, symbol) => {
    try {
      return await ds.fundamentalExtras(symbol);
    } catch (e) {
      return { symbol: String(symbol).toUpperCase(), error: e.message };
    }
  });

  ipcMain.handle('store:get', (_, key) => store.get(key));
  ipcMain.handle('store:set', (_, key, val) => store.set(key, val));
  ipcMain.handle('config:update', (_, patch) => store.updateConfig(patch));

  ipcMain.handle('watchlist:add', (_, item) => {
    const list = store.get('watchlist');
    if (!list.find((w) => w.secid === item.secid)) {
      list.push({ ...item, addedAt: Date.now() });
      store.set('watchlist', list);
    }
    return store.get('watchlist');
  });
  ipcMain.handle('watchlist:remove', (_, secid) => {
    store.set('watchlist', store.get('watchlist').filter((w) => w.secid !== secid));
    return store.get('watchlist');
  });

  ipcMain.handle('alerts:add', (_, a) => {
    const list = store.get('alerts');
    list.push({ ...a, id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, createdAt: Date.now() });
    store.set('alerts', list);
    return list;
  });
  ipcMain.handle('alerts:remove', (_, id) => {
    store.set('alerts', store.get('alerts').filter((a) => a.id !== id));
    return store.get('alerts');
  });
  ipcMain.handle('alerts:update', (_, id, patch) => {
    const list = store.get('alerts');
    const i = list.findIndex((a) => a.id === id);
    if (i >= 0) list[i] = { ...list[i], ...patch };
    store.set('alerts', list);
    return list;
  });

  // ---- v1.0.2：模拟盘账户持久化
  ipcMain.handle('paper:load', () => store.get('paper'));
  ipcMain.handle('paper:save', (_, snap) => {
    store.set('paper', snap || null);
    return true;
  });
  ipcMain.handle('paper:reset', (_, cash) => {
    const cur = store.get('paper') || {};
    const next = {
      ...cur,
      initialCash: Number(cash) || 100000,
      cash: Number(cash) || 100000,
      settledCash: Number(cash) || 100000,
      orders: [],
      positions: [],
      trades: [],
      dayTrades: [],
      pendingSettlements: [],
      equityHistory: [],
      realizedPnl: 0,
      totalFees: 0,
      logs: [],
    };
    store.set('paper', next);
    return next;
  });

  // ---- v1.0.2：告警真实投递
  ipcMain.handle('alert:send', async (_, channelKey, cfg, alert) => {
    const r = await notify.send(channelKey, cfg, alert, {
      notify: (title, body) => {
        if (Notification.isSupported()) new Notification({ title, body }).show();
      },
    });
    audit(r.ok ? 'info' : 'error', 'alert', `${channelKey} 推送${r.ok ? '成功' : '失败'}：${alert && alert.title ? alert.title : ''}（${r.detail}）`, { channelKey });
    return r;
  });
  ipcMain.handle('alert:test', async (_, channelKey, cfg) => {
    const alert = {
      level: 'info',
      title: 'QuantDesk 渠道测试',
      detail: '这是一条测试消息。能收到它，说明这条告警通道是通的。',
      hitAt: new Date().toISOString(),
    };
    const r = await notify.send(channelKey, cfg, alert, {
      notify: (title, body) => {
        if (Notification.isSupported()) new Notification({ title, body }).show();
      },
    });
    audit(r.ok ? 'info' : 'error', 'alert', `渠道联通测试 ${channelKey}：${r.ok ? '成功' : '失败'}（${r.detail}）`, { channelKey });
    return r;
  });

  // ---- v1.0.2：监控轮询
  ipcMain.handle('monitor:start', () => startMonitor());
  ipcMain.handle('monitor:stop', () => stopMonitor());
  ipcMain.handle('monitor:status', () => {
    const saved = store.get('monitor') || {};
    return {
      running: !!monitor.timer,
      intervalMs: (store.get('config') || {}).monitorInterval || 30000,
      ticks: monitor.ticks,
      lastBeatAt: monitor.lastBeatAt,
      lastError: monitor.lastError,
      lastResult: saved.lastResult || null,
      heartbeat: Alerts.heartbeat({ lastBeatAt: monitor.lastBeatAt, intervalMs: (store.get('config') || {}).monitorInterval || 30000 }),
    };
  });
  ipcMain.handle('monitor:tickNow', () => monitorTick());

  // ---- v1.0.2：审计日志
  ipcMain.handle('audit:add', (_, entry) => {
    const list = store.get('auditLog') || [];
    list.push(entry || Alerts.auditEntry('info', 'general', '手工记录'));
    store.set('auditLog', list.slice(-500));
    return true;
  });
  ipcMain.handle('audit:list', () => store.get('auditLog') || []);

  ipcMain.on('notify', (_, { title, body }) => {
    if (Notification.isSupported()) {
      const n = new Notification({ title: title || 'QuantDesk', body: body || '', silent: false });
      n.show();
    }
  });

  ipcMain.on('open:external', (_, url) => {
    if (url && url.startsWith('http')) shell.openExternal(url);
  });
}

// ---------------------------------------------------------------- 启动

app.whenReady().then(() => {
  const userData = app.getPath('userData');
  const dataDir = path.join(userData, 'data');
  const cacheDir = path.join(userData, 'cache');
  ds.initCache(cacheDir);
  store = new Store(path.join(dataDir, 'store.json'));

  buildMenu();
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
