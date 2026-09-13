/**
 * store.js —— 本地持久化（JSON 文件）
 * 自选股 / 预警 / 配置 存在 userData/store.json，K线与行情缓存在 userData/cache/
 *
 * v1.0.2 起额外持久化：模拟盘账户快照（paper）、风控阈值与渠道配置（config.risk / config.channels）、
 * 券商适配配置（config.broker）、告警规则（alertRules）与审计日志（auditLog）。
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_STATE = {
  watchlist: [], // [{ secid, code, name, market, addedAt }]
  alerts: [], // [{ id, secid, code, name, type, value, createdAt, triggered, note }]
  config: {
    refreshInterval: 15000, // 行情自动刷新间隔(ms)
    period: 'day',
    fq: 1,
    theme: 'dark',
    scanPreset: 'pool',
    scanTop: 60,
    initialCapital: 100000,
    commission: 0.0005, // 单边手续费率
    slippage: 0.0005, // 滑点

    // ---- v1.0.2：回测口径
    orderType: 'market', // market | moo | moc | loc | twopct | vwap | twap
    useUsFees: true, // true = 按美股真实费用分项（SEC/TAF/交易所/清算/CAT）
    benchName: 'SPY', // 基准：SPY / QQQ / IWM
    constraintsOn: true, // 启用 T+1 / PDT / SSR 约束
    accountSize: 100000, // 用于 PDT 判定的账户净值
    exitStopLoss: 8, // 止损 %（0 = 关闭）
    exitTakeProfit: 0, // 止盈 %（0 = 关闭）
    exitTrailing: 0, // 移动止损回撤 %（0 = 关闭）
    exitMaxHold: 0, // 最大持有天数（0 = 关闭）

    // ---- v1.0.2：模拟盘
    paperCash: 100000,
    paperClock: 'auto', // auto = 跟随真实时段；regular = 强制常规时段（休市时回放用）
    paperSlippageBps: 3,
    paperParticipation: 5, // 单根K线最多吃掉成交量百分比

    // ---- v1.0.2：风控阈值（对应 risk.js DEFAULT_LIMITS 的覆盖项）
    riskLimits: {},

    // ---- v1.0.2：监控告警
    monitorInterval: 30000, // 监控轮询间隔 ms（与 heartbeat 口径一致）
    channels: {}, // { [channelKey]: { enabled, ...字段 } }
    activeChannels: [], // 启用的渠道 key 列表

    // ---- v1.0.2：券商适配
    broker: { venue: 'ibkr', configs: {} },
  },
  scanResults: null,
  lastScanAt: null,

  // ---- v1.0.2 新增持久化字段
  paper: null, // 模拟盘账户快照（PaperAccount.toJSON()）
  alertRules: [], // 告警规则（与 alerts.js RULE_TYPES 对应）
  auditLog: [], // 审计日志（alerts.js auditEntry 产物）
  monitor: { running: false, lastBeatAt: null, ticks: 0, lastError: '' },
};

/** 仅对普通对象做深合并；数组与原始值直接覆盖 */
function deepMerge(base, patch) {
  if (patch == null) return base;
  if (Array.isArray(base) || Array.isArray(patch)) return patch;
  if (typeof base !== 'object' || typeof patch !== 'object') return patch;
  const out = { ...base };
  for (const k of Object.keys(patch)) {
    out[k] = k in base ? deepMerge(base[k], patch[k]) : patch[k];
  }
  return out;
}

class Store {
  constructor(file) {
    this.file = file;
    this.state = JSON.parse(JSON.stringify(DEFAULT_STATE));
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const saved = JSON.parse(raw);
      const next = { ...this.state, ...saved };
      // 配置与新增的嵌套字段做深合并：老版本的 store.json 缺哪个键就补默认值
      next.config = deepMerge(DEFAULT_STATE.config, saved.config || {});
      next.monitor = deepMerge(DEFAULT_STATE.monitor, saved.monitor || {});
      this.state = next;
    } catch {
      this.save();
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
      return true;
    } catch (e) {
      return false;
    }
  }

  get(key) {
    return key ? this.state[key] : this.state;
  }

  set(key, value) {
    this.state[key] = value;
    this.save();
    return value;
  }

  updateConfig(patch) {
    this.state.config = deepMerge(this.state.config, patch || {});
    this.save();
    return this.state.config;
  }
}

module.exports = { Store, DEFAULT_STATE, deepMerge };
