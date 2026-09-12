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
          ['alerts', '05-alerts', 0],
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
            await new Promise((r) => setTimeout(r, view === 'analyze' ? 2200 : 1200));
            const img = await mainWindow.webContents.capturePage();
            fs.writeFileSync(path.join(dir, name + '.png'), img.toPNG());
            console.log('SHOT ' + name);
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

async function runScan(options = {}) {
  if (scanRunning) return { error: '扫描任务正在运行中' };
  scanRunning = true;
  const t0 = Date.now();
  try {
    const { source = 'pool', limit = 80, minPrice = 3, minAmount = 0 } = options;

    // 1) 候选池
    let candidates = [];
    if (source === 'watch') {
      candidates = store.get('watchlist').map((w) => ({ ...w }));
    } else if (source === 'market') {
      // 全市场：按成交额取头部，再过滤低价股
      try {
        const rows = await ds.rank({ size: Math.min(600, Math.max(limit * 6, 200)) });
        candidates = rows
          .filter((r) => (r.price || 0) >= minPrice && (r.amount || 0) >= minAmount)
          .slice(0, limit * 2)
          .map((r) => ({ secid: r.secid, code: r.code, name: r.name }));
      } catch (e) {
        // 排行接口不稳时回退到内置池
        candidates = POOL.slice(0, limit * 2);
      }
    } else {
      candidates = POOL.slice(0, Math.max(limit * 2, 60));
    }

    if (!candidates.length) return { error: '候选池为空' };

    const total = Math.min(candidates.length, Math.max(limit, 20));
    const targets = candidates.slice(0, total);
    const results = [];
    let done = 0;

    // 2) 并发抓 K 线 + 因子计算（并发 3，与数据源限流策略一致）
    const CONC = 3;
    let cursor = 0;
    const worker = async () => {
      while (cursor < targets.length) {
        const idx = cursor++;
        const t = targets[idx];
        try {
          const k = await ds.kline(t.secid, { period: 'day', limit: 260, fq: 1 });
          if (k && k.bars && k.bars.length >= 60) {
            const a = Factors.analyze(k.bars, null);
            if (a) {
              results.push({
                secid: t.secid,
                code: t.code || k.code,
                name: t.name || k.name,
                group: t.group || '',
                ...a,
              });
            }
          }
        } catch {
          /* 单只失败跳过 */
        }
        done++;
        if (mainWindow && mainWindow.webContents && done % 3 === 0) {
          mainWindow.webContents.send('scan:progress', {
            done,
            total: targets.length,
            current: t.code,
          });
        }
      }
    };
    await Promise.all(Array.from({ length: CONC }, worker));

    // 3) 补充实时行情（涨幅 / 成交额），失败不影响主结果
    try {
      const qt = await ds.quotes(results.map((r) => r.secid), { maxAge: 60000, concurrency: 3 });
      const map = new Map(qt.map((q) => [q.secid, q]));
      for (const r of results) {
        const q = map.get(r.secid);
        if (q) {
          r.price = q.price;
          r.changePct = q.changePct;
          r.amount = q.amount;
          r.marketCap = q.marketCap;
          r.pe = q.pe;
        }
      }
    } catch {
      /* 行情补充失败忽略 */
    }

    results.sort((a, b) => b.score - a.score);
    const payload = {
      results,
      scannedAt: Date.now(),
      costMs: Date.now() - t0,
      source,
    };
    store.set('scanResults', payload);
    store.set('lastScanAt', payload.scannedAt);
    return payload;
  } finally {
    scanRunning = false;
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

  ipcMain.handle('ds:search', (_, kw) => ds.search(kw));
  ipcMain.handle('ds:quotes', (_, secids, opt) => ds.quotes(secids, opt || {}));
  ipcMain.handle('ds:kline', (_, secid, opt) => ds.kline(secid, opt || {}));
  ipcMain.handle('ds:indexes', () => ds.indexQuotes());
  ipcMain.handle('ds:rank', (_, opt) => ds.rank(opt || {}));
  ipcMain.handle('ds:pool', () => POOL);
  ipcMain.handle('ds:clearCache', () => {
    ds.clearCache();
    return true;
  });

  ipcMain.handle('scan:run', (_, opt) => runScan(opt || {}));
  ipcMain.handle('scan:last', () => store.get('scanResults'));

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
