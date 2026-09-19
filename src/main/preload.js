/**
 * preload.js —— 安全桥接
 * 渲染层通过 window.qd 调用主进程能力；算法库直接注入，
 * 保证"扫描用的算法"和"界面上画的指标"是同一份代码。
 *
 * v1.0.2 新增 8 个模块：美股市场规则 / 绩效归因 / 税务 / 风控 / 模拟盘 / 券商适配 / 选股器 / 告警。
 * 这些模块全部是纯函数或纯状态机，放渲染层跑不会碰网络，也不涉及凭证。
 */
const { contextBridge, ipcRenderer } = require('electron');
const Indicators = require('../shared/indicators');
const Factors = require('../shared/factors');
const Backtest = require('../shared/backtest');
const Levels = require('../shared/levels');
const TradePlan = require('../shared/tradeplan');
const Diagnose = require('../shared/diagnose');
const Options = require('../shared/options');
// ---- v1.0.2
const Market = require('../shared/market');
const Perf = require('../shared/perf');
const Tax = require('../shared/tax');
const Risk = require('../shared/risk');
const Paper = require('../shared/paper');
const Broker = require('../shared/broker');
const Screener = require('../shared/screener');
const Alerts = require('../shared/alerts');
// ---- v1.1.0：新闻 / 事件 / 风险机会 / 暴涨雷达（全部纯函数，可离线跑）
const Newsfeed = require('../shared/newsfeed');
const Events = require('../shared/events');
const Insight = require('../shared/insight');
const Moonshot = require('../shared/moonshot');

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
  // v1.2.0：档位（含耗时预估）与取消
  scanLimits: () => ipcRenderer.invoke('scan:limits'),
  scanCancel: () => ipcRenderer.invoke('scan:cancel'),
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

  // ---- v1.0.2：模拟盘账户持久化
  paperLoad: () => ipcRenderer.invoke('paper:load'),
  paperSave: (snap) => ipcRenderer.invoke('paper:save', snap),
  paperReset: (cash) => ipcRenderer.invoke('paper:reset', cash),

  // ---- v1.0.2：告警推送（真正把消息发到 Telegram / 企业微信 / 钉钉 / Webhook / 邮件）
  alertSend: (channelKey, cfg, alert) => ipcRenderer.invoke('alert:send', channelKey, cfg, alert),
  alertTest: (channelKey, cfg) => ipcRenderer.invoke('alert:test', channelKey, cfg),

  // ---- v1.0.2：监控轮询（主进程定时器，窗口最小化也继续跑）
  monitorStart: (opt) => ipcRenderer.invoke('monitor:start', opt),
  monitorStop: () => ipcRenderer.invoke('monitor:stop'),
  monitorStatus: () => ipcRenderer.invoke('monitor:status'),
  monitorTickNow: () => ipcRenderer.invoke('monitor:tickNow'),
  onMonitorTick: (cb) => {
    const h = (_, p) => cb(p);
    ipcRenderer.on('monitor:tick', h);
    return () => ipcRenderer.removeListener('monitor:tick', h);
  },
  onMonitorProgress: (cb) => {
    const h = (_, p) => cb(p);
    ipcRenderer.on('monitor:progress', h);
    return () => ipcRenderer.removeListener('monitor:progress', h);
  },

  // ---- v1.0.2：审计日志
  auditAdd: (entry) => ipcRenderer.invoke('audit:add', entry),
  auditList: () => ipcRenderer.invoke('audit:list'),

  // 算法库（v1.0.1）
  ind: Indicators,
  factors: Factors,
  bt: Backtest,
  levels: Levels,
  tradeplan: TradePlan,
  diagnose: Diagnose,
  options: Options,

  // 算法库（v1.0.2）
  market: Market,
  perf: Perf,
  tax: Tax,
  risk: Risk,
  paper: Paper,
  broker: Broker,
  screener: Screener,
  alerts: Alerts,

  // ---- v1.1.0
  // 机会雷达（一次扫描：行情+因子+风险机会+新闻+事件+暴涨潜力）
  radarRun: (opt) => ipcRenderer.invoke('radar:run', opt || {}),
  radarLast: () => ipcRenderer.invoke('radar:last'),
  newsFetch: (kws, opt) => ipcRenderer.invoke('news:fetch', kws, opt || {}),
  eventsFetch: (opt) => ipcRenderer.invoke('events:fetch', opt || {}),
  eventsMacro: () => ipcRenderer.invoke('events:macro'),
  extrasFetch: (symbol) => ipcRenderer.invoke('extras:fetch', symbol),
  onRadarProgress: (cb) => {
    const h = (_, p) => cb(p);
    ipcRenderer.on('radar:progress', h);
    return () => ipcRenderer.removeListener('radar:progress', h);
  },

  // 纯函数模块（渲染层直接调用，与主进程同一份实现）
  newsfeed: Newsfeed,
  events: Events,
  insight: Insight,
  moonshot: Moonshot,
};

contextBridge.exposeInMainWorld('qd', api);
