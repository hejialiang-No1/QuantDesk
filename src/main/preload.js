/**
 * preload.js —— 安全桥接
 * 渲染层通过 window.qd 调用主进程能力；指标/因子/回测库直接注入，
 * 保证"扫描用的算法"和"界面上画的指标"是同一份代码。
 */
const { contextBridge, ipcRenderer } = require('electron');
const Indicators = require('../shared/indicators');
const Factors = require('../shared/factors');
const Backtest = require('../shared/backtest');
const Levels = require('../shared/levels');
const TradePlan = require('../shared/tradeplan');
const Diagnose = require('../shared/diagnose');
const Options = require('../shared/options');

const api = {
  // 应用
  appInfo: () => ipcRenderer.invoke('app:info'),
  notify: (title, body) => ipcRenderer.send('notify', { title, body }),
  openExternal: (url) => ipcRenderer.send('open:external', url),

  // 数据
  search: (kw) => ipcRenderer.invoke('ds:search', kw),
  quotes: (secids, opt) => ipcRenderer.invoke('ds:quotes', secids, opt),
  kline: (secid, opt) => ipcRenderer.invoke('ds:kline', secid, opt),
  indexes: () => ipcRenderer.invoke('ds:indexes'),
  rank: (opt) => ipcRenderer.invoke('ds:rank', opt),
  pool: () => ipcRenderer.invoke('ds:pool'),
  clearCache: () => ipcRenderer.invoke('ds:clearCache'),

  // 扫描
  scan: (opt) => ipcRenderer.invoke('scan:run', opt),
  lastScan: () => ipcRenderer.invoke('scan:last'),
  onScanProgress: (cb) => {
    const h = (_, p) => cb(p);
    ipcRenderer.on('scan:progress', h);
    return () => ipcRenderer.removeListener('scan:progress', h);
  },

  // 存储
  storeGet: (key) => ipcRenderer.invoke('store:get', key),
  storeSet: (key, val) => ipcRenderer.invoke('store:set', key, val),
  configUpdate: (patch) => ipcRenderer.invoke('config:update', patch),
  watchlistAdd: (item) => ipcRenderer.invoke('watchlist:add', item),
  watchlistRemove: (secid) => ipcRenderer.invoke('watchlist:remove', secid),
  alertsAdd: (a) => ipcRenderer.invoke('alerts:add', a),
  alertsRemove: (id) => ipcRenderer.invoke('alerts:remove', id),
  alertsUpdate: (id, patch) => ipcRenderer.invoke('alerts:update', id, patch),

  // 算法库
  ind: Indicators,
  factors: Factors,
  bt: Backtest,
  levels: Levels,
  tradeplan: TradePlan,
  diagnose: Diagnose,
  options: Options,
};

contextBridge.exposeInMainWorld('qd', api);
