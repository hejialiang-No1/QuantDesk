/**
 * store.js —— 本地持久化（JSON 文件）
 * 自选股 / 预警 / 配置 存在 userData/store.json，K线与行情缓存在 userData/cache/
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
  },
  scanResults: null,
  lastScanAt: null,
};

class Store {
  constructor(file) {
    this.file = file;
    this.state = { ...DEFAULT_STATE, config: { ...DEFAULT_STATE.config } };
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const saved = JSON.parse(raw);
      this.state = {
        ...this.state,
        ...saved,
        config: { ...this.state.config, ...(saved.config || {}) },
      };
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
    this.state.config = { ...this.state.config, ...patch };
    this.save();
    return this.state.config;
  }
}

module.exports = { Store, DEFAULT_STATE };
