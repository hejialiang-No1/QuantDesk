/**
 * main.js —— Electron 主进程
 * 负责：窗口生命周期、IPC 接口、行情抓取调度、全市场扫描任务
 */
const { app, BrowserWindow, ipcMain, Menu, Notification, shell } = require('electron');
const path = require('path');

const ds = require('./datasource');
const { Store } = require('./store');
const { POOL } = require('./pool');
const Factors = require('../shared/factors');
const Indicators = require('../shared/indicators');
const Backtest = require('../shared/backtest');

const isDev = process.argv.includes('--dev');
let mainWindow = null;
let store = null;

// ---------------------------------------------------------------- 窗口

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1120,
    minHeight: 700,
    title: 'QuantDesk 美股量化终端',
    backgroundColor: '#0b0e14',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
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
  if (isDev || process.argv.includes('--smoke')) {
    mainWindow.webContents.on('console-message', (e, level, message, line, sourceId) => {
      console.log(`[renderer:${level}] ${message}  (${sourceId}:${line})`);
    });
  }

  // 自检模式：启动后自动跑一遍主流程，输出体检结果
  if (process.argv.includes('--smoke')) {
    mainWindow.webContents.on('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const r = await mainWindow.webContents.executeJavaScript(`(function(){
            const q = (s) => document.querySelector(s);
            return {
              errors: window.__errors || [],
              hasQd: typeof window.qd === 'object',
              watchRows: document.querySelectorAll('#watchTable tbody tr').length,
              poolChips: document.querySelectorAll('#poolChips button').length,
              indexes: document.querySelectorAll('#indexStrip .idx').length,
              kpiCells: document.querySelectorAll('#anaKpi .kpi').length,
              factorRows: document.querySelectorAll('#anaFactors .factor-row').length,
              scoreText: (q('#anaScore .num-big')||{}).textContent || '',
              canvasPainted: (function(){
                const c = q('#klineCanvas');
                return !!(c && c.width > 100);
              })(),
            };
          })()`);
          console.log('SMOKE_RESULT ' + JSON.stringify(r));
        } catch (e) {
          console.log('SMOKE_ERROR ' + e.message);
        }
        mainWindow.webContents.executeJavaScript(`window.__errors.length`).catch(() => {});
        setTimeout(() => app.exit(0), 500);
      }, 12000);
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
