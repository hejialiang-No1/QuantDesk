/**
 * datasource.js —— 行情数据源（多源自动降级）
 *
 * 国内访问美股数据的现实情况：
 *   · Yahoo / Alpha Vantage 等境外接口基本不可用（Yahoo 直连返回 sad-panda 拦截页）
 *   · 东方财富 push2 系列国内速度最快，但对单 IP 有 QPS 限流，密集请求会被掐断
 *   · 腾讯 qt.gtimg.cn / web.ifzq.gtimg.cn 与新浪 hq.sinajs.cn 稳定性更高，可作兜底
 *
 * 所以这里做成三源架构：东财(主) → 腾讯(备) → 新浪(备)，任一源失败自动切换，
 * 并叠加：并发队列、指数退避重试、域名轮换、内存+磁盘双级缓存。
 */
const fs = require('fs');
const path = require('path');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BASE_HEADERS = {
  'User-Agent': UA,
  Referer: 'https://quote.eastmoney.com/',
  Accept: '*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};
const SINA_HEADERS = { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn' };

/** 东财 push2 备用域名（被限流时轮换） */
const EM_HOSTS = [
  'https://push2.eastmoney.com',
  'https://1.push2.eastmoney.com',
  'https://82.push2.eastmoney.com',
  'https://push2delay.eastmoney.com',
];
const EM_HIS_HOSTS = ['https://push2his.eastmoney.com', 'https://63.push2his.eastmoney.com'];

const MARKET = { NASDAQ: 105, NYSE: 106, AMEX: 107 };
const MARKET_NAME = { 105: 'NASDAQ', 106: 'NYSE', 107: 'AMEX' };
/** 东财市场号 → 腾讯代码后缀 */
const TX_SUFFIX = { 105: 'OQ', 106: 'N', 107: 'A' };

const PERIOD = { day: 101, week: 102, month: 103, m5: 5, m15: 15, m30: 30, m60: 60 };

// ---------------------------------------------------------------- 工具

function num(v) {
  if (v === null || v === undefined || v === '' || v === '-') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function scaled(v, dec) {
  const n = num(v);
  return n === null ? null : n / Math.pow(10, dec == null ? 2 : dec);
}
function pct100(v) {
  const n = num(v);
  return n === null ? null : n / 100;
}

/**
 * 估值倍数解析：东方财富用 0 表示「该市场没有这个数据」，
 * 但 PE=0 在现实中不存在（亏损股是负数——那个是真实值，要保留）。
 * 所以把 0 归一成 null，让上层显示 "--" 而不是误导性的 "0.00"。
 * 实测（美股，105 市场）：f163≈TTM、f164≈动态、f167=市净率、f165≈市销率。
 */
function ratio(v) {
  const n = num(v);
  if (n === null || n === 0) return null;
  return n / 100;
}
/** 按优先级取第一个有效值，兼容 A股(f9/f115) 与美股(f163/f164) 的不同挂载 */
function pickRatio(...vals) {
  for (const v of vals) {
    const r = ratio(v);
    if (r !== null) return r;
  }
  return null;
}
/** 原始倍数：腾讯/新浪返回的就是最终值，只需把 0 归成 null */
function nonZero(v) {
  const n = num(v);
  return n === null || n === 0 ? null : n;
}
/** clist(fltt=2) 返回的已是格式化浮点数，不能再除以 100 */
function pickFloat(...vals) {
  for (const v of vals) {
    const n = num(v);
    if (n !== null && n !== 0) return n;
  }
  return null;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const makeSecid = (code, market) => `${market || MARKET.NASDAQ}.${String(code).toUpperCase()}`;
const codeOf = (secid) => String(secid || '').split('.').slice(1).join('.');
const marketOf = (secid) => Number(String(secid || '').split('.')[0]) || MARKET.NASDAQ;

let gbkDecoder = null;
function decodeGbk(buf) {
  try {
    if (!gbkDecoder) gbkDecoder = new TextDecoder('gbk');
    return gbkDecoder.decode(buf);
  } catch {
    return Buffer.from(buf).toString('utf8');
  }
}

// ---------------------------------------------------------------- 请求队列

class RequestQueue {
  constructor({ concurrency = 3, minInterval = 180 } = {}) {
    this.concurrency = concurrency;
    this.minInterval = minInterval;
    this.active = 0;
    this.queue = [];
    this.lastStart = 0;
  }
  async run(task) {
    if (this.active >= this.concurrency) await new Promise((r) => this.queue.push(r));
    this.active++;
    try {
      const w = this.minInterval - (Date.now() - this.lastStart);
      if (w > 0) await sleep(w);
      this.lastStart = Date.now();
      return await task();
    } finally {
      this.active--;
      const n = this.queue.shift();
      if (n) n();
    }
  }
}

const queue = new RequestQueue({ concurrency: 3, minInterval: 180 });

async function httpGet(url, { timeout = 15000, retries = 1, headers } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await queue.run(async () => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeout);
        try {
          return await fetch(url, { headers: headers || BASE_HEADERS, signal: ctrl.signal });
        } finally {
          clearTimeout(t);
        }
      });
      const buf = await res.arrayBuffer();
      if (!buf || !buf.byteLength) throw new Error('EMPTY');
      return buf;
    } catch (e) {
      lastErr = e;
      if (i < retries) await sleep(350 * (i + 1) + Math.random() * 200);
    }
  }
  throw lastErr || new Error('FAIL');
}

async function httpJson(url, opts) {
  const buf = await httpGet(url, opts);
  let text;
  try {
    text = new TextDecoder('utf-8').decode(buf);
    return JSON.parse(text);
  } catch {
    text = decodeGbk(buf);
    return JSON.parse(text);
  }
}

/** 多 host 轮换请求 */
async function httpGetHosts(hosts, pathAndQuery, opts) {
  let lastErr;
  for (const h of hosts) {
    try {
      return await httpGet(h + pathAndQuery, { retries: 0, ...(opts || {}) });
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('ALL_HOSTS_FAILED');
}

// ---------------------------------------------------------------- 源健康度

const health = { em: 0, tx: 0, sina: 0 };
const HEALTH_TTL = 6; // 失败 6 次后降到最低优先级
function providerOrder() {
  return Object.keys(health).sort((a, b) => health[a] - health[b]);
}
function markOk(p) {
  health[p] = 0;
}
function markFail(p) {
  health[p] = Math.min(HEALTH_TTL, health[p] + 1);
}

// ---------------------------------------------------------------- 缓存

class Cache {
  constructor(dir) {
    this.dir = dir;
    this.mem = new Map();
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {}
  }
  get(key, maxAge) {
    const hit = this.mem.get(key);
    if (hit && Date.now() - hit.t < maxAge) return hit.v;
    try {
      const f = path.join(this.dir, key.replace(/[^a-zA-Z0-9_.-]/g, '_') + '.json');
      const st = fs.statSync(f);
      if (Date.now() - st.mtimeMs < maxAge) {
        const v = JSON.parse(fs.readFileSync(f, 'utf8'));
        this.mem.set(key, { t: st.mtimeMs, v });
        return v;
      }
    } catch {}
    return null;
  }
  set(key, v) {
    this.mem.set(key, { t: Date.now(), v });
    try {
      fs.writeFile(path.join(this.dir, key.replace(/[^a-zA-Z0-9_.-]/g, '_') + '.json'), JSON.stringify(v));
    } catch {}
  }
  clear() {
    this.mem.clear();
    try {
      for (const f of fs.readdirSync(this.dir)) fs.unlinkSync(path.join(this.dir, f));
    } catch {}
  }
}
let cache = new Cache(path.join(process.cwd(), '.cache'));
function initCache(dir) {
  cache = new Cache(dir);
  return cache;
}

// ---------------------------------------------------------------- 源1：东方财富

const EM_QUOTE_FIELDS = [
  'f43', 'f44', 'f45', 'f46', 'f47', 'f48', 'f57', 'f58', 'f59', 'f60',
  'f86', 'f116', 'f117', 'f162', 'f167', 'f168', 'f169', 'f170', 'f50',
  // 市盈率在不同市场挂在不同字段上：f9/f114/f115 是 A 股口径，
  // 美股要走 f164(动态)/f163(静态) 一类，一并取回来做择优。
  'f9', 'f23', 'f114', 'f115', 'f163', 'f164', 'f165', 'f166', 'f173', 'f174',
].join(',');

function emParse(d, secid) {
  if (!d) return null;
  const dec = num(d.f59) != null ? num(d.f59) : 2;
  const p = Math.pow(10, dec);
  const market = num(d.f13) || marketOf(secid);
  const code = d.f57 || codeOf(secid);
  const price = scaled(d.f43, dec);
  const prevClose = scaled(d.f60, dec);
  let change = scaled(d.f169, dec);
  let changePct = pct100(d.f170);
  if ((change === null || changePct === null) && price !== null && prevClose) {
    change = price - prevClose;
    changePct = (change / prevClose) * 100;
  }
  return {
    secid: makeSecid(code, market), code, name: d.f58 || code, market,
    marketName: MARKET_NAME[market] || 'US',
    price, open: scaled(d.f46, dec), high: scaled(d.f44, dec), low: scaled(d.f45, dec),
    prevClose, change, changePct,
    volume: num(d.f47), amount: num(d.f48),
    marketCap: num(d.f116) || null, floatCap: num(d.f117) || null,
    // 美股 PE 挂在 f163(TTM)/f164(动态)，A股走 f9(动态)/f115(TTM)；f162 作兜底
    pe: pickRatio(d.f163, d.f164, d.f162, d.f115, d.f9),
    pb: pickRatio(d.f167, d.f23),
    turnover: pct100(d.f168),
    ps: ratio(d.f165),
    volumeRatio: pct100(d.f50), ts: num(d.f86), src: 'em', updatedAt: Date.now(),
  };
}

async function emQuote(secid) {
  const buf = await httpGetHosts(
    EM_HOSTS,
    `/api/qt/stock/get?secid=${encodeURIComponent(secid)}&fields=${EM_QUOTE_FIELDS}`
  );
  const j = JSON.parse(new TextDecoder('utf-8').decode(buf));
  const q = emParse(j?.data, secid);
  if (!q || q.price === null) throw new Error('EM_BAD_DATA');
  return q;
}

async function emKline(secid, { period = 'day', limit = 320, fq = 1 }) {
  const klt = PERIOD[period] || 101;
  const buf = await httpGetHosts(
    EM_HIS_HOSTS,
    `/api/qt/stock/kline/get?secid=${encodeURIComponent(secid)}&fields1=f1,f2,f3,f4,f5,f6` +
      `&fields2=f51,f52,f53,f54,f55,f56,f57,f58&klt=${klt}&fqt=${fq}&end=20500101&lmt=${limit}`
  );
  const j = JSON.parse(new TextDecoder('utf-8').decode(buf));
  const d = j?.data;
  if (!d || !Array.isArray(d.klines) || !d.klines.length) throw new Error('EM_NO_KLINE');
  return {
    secid, code: d.code, name: d.name, market: num(d.market), period,
    bars: d.klines.map((l) => {
      const a = String(l).split(',');
      return {
        date: a[0], open: num(a[1]), close: num(a[2]), high: num(a[3]), low: num(a[4]),
        volume: num(a[5]), amount: num(a[6]), amplitude: num(a[7]),
      };
    }).filter((b) => b.close !== null),
    src: 'em',
  };
}

async function emSearch(kw, limit) {
  const buf = await httpGet(
    `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(kw)}&type=14` +
      `&token=D43BF722C8E33BDC906FB84D85E326E8&count=${limit}`
  );
  const j = JSON.parse(new TextDecoder('utf-8').decode(buf));
  const rows = j?.QuotationCodeTable?.Data || [];
  return rows
    .filter((r) => r.SecurityTypeName === '美股' || r.Classify === 'UsStock')
    .map((r) => ({
      code: r.Code, name: r.Name, market: Number(r.MktNum) || MARKET.NASDAQ,
      marketName: r.JYS || '', secid: r.QuoteID || makeSecid(r.Code, r.MktNum),
    }))
    .slice(0, limit);
}

async function emRank({ markets = [105, 106, 107], size = 200, page = 1, sortField = 'f6' }) {
  const fsq = markets.map((m) => `m:${m}`).join(',');
  const buf = await httpGetHosts(
    EM_HOSTS,
    `/api/qt/clist/get?pn=${page}&pz=${size}&po=1&np=1&fltt=2&invt=2&fid=${sortField}` +
      `&fs=${encodeURIComponent(fsq)}&fields=f12,f13,f14,f2,f3,f4,f5,f6,f20,f21,f116,f162,f163,f164`
  );
  const j = JSON.parse(new TextDecoder('utf-8').decode(buf));
  const rows = j?.data?.diff;
  if (!Array.isArray(rows)) throw new Error('EM_NO_RANK');
  return rows.map((r) => ({
    secid: `${num(r.f13) || 105}.${r.f12}`, code: r.f12, market: num(r.f13) || 105,
    name: r.f14, price: num(r.f2), changePct: num(r.f3), change: num(r.f4),
    volume: num(r.f5), amount: num(r.f6), marketCap: num(r.f20),
    pe: pickFloat(r.f163, r.f164, r.f162),
  })).filter((r) => r.code && r.price !== null);
}

// ---------------------------------------------------------------- 源2：腾讯

function txSymbol(secid) {
  const m = marketOf(secid);
  return `us${codeOf(secid)}.${TX_SUFFIX[m] || 'OQ'}`;
}

async function txQuote(secid) {
  const buf = await httpGet(`https://qt.gtimg.cn/q=${txSymbol(secid)}`);
  const text = decodeGbk(buf);
  const m = text.match(/="(.*)"/);
  if (!m) throw new Error('TX_BAD');
  const a = m[1].split('~');
  const price = num(a[3]);
  if (price === null) throw new Error('TX_NO_PRICE');
  const prevClose = num(a[4]);
  return {
    secid, code: codeOf(secid), name: a[1] || codeOf(secid), market: marketOf(secid),
    marketName: MARKET_NAME[marketOf(secid)] || 'US',
    price, open: num(a[5]), high: num(a[32]), low: num(a[33]), prevClose,
    change: num(a[30]), changePct: num(a[31]),
    volume: num(a[6]), amount: num(a[36]),
    marketCap: null, pe: nonZero(a[38]), turnover: nonZero(a[42]),
    high52: num(a[47]), low52: num(a[48]),
    ts: null, src: 'tx', updatedAt: Date.now(),
  };
}

async function txKline(secid, { period = 'day', limit = 320, fq = 1 }) {
  const p = period === 'week' ? 'week' : period === 'month' ? 'month' : 'day';
  const fqKey = fq === 1 ? 'qfq' : fq === 2 ? 'hfq' : '';
  const buf = await httpGet(
    `https://web.ifzq.gtimg.cn/appstock/app/usfqkline/get?_var=k&param=${txSymbol(secid)},${p},,,${limit},${fqKey}`
  );
  const text = decodeGbk(buf);
  const json = text.replace(/^\s*\w+=/, '').trim();
  const j = JSON.parse(json);
  const node = j?.data?.[txSymbol(secid)];
  const arr = node?.[`${fqKey}${p}`] || node?.[p];
  if (!Array.isArray(arr) || !arr.length) throw new Error('TX_NO_KLINE');
  return {
    secid, code: codeOf(secid), name: node?.qtCode || codeOf(secid),
    market: marketOf(secid), period,
    bars: arr.map((r) => ({
      date: r[0], open: num(r[1]), close: num(r[2]), high: num(r[3]), low: num(r[4]),
      volume: num(r[5]), amount: null,
    })).filter((b) => b.close !== null),
    src: 'tx',
  };
}

// ---------------------------------------------------------------- 源3：新浪

async function sinaQuote(secid) {
  const code = codeOf(secid).toLowerCase();
  const buf = await httpGet(`https://hq.sinajs.cn/list=gb_${code}`, { headers: SINA_HEADERS });
  const text = decodeGbk(buf);
  const m = text.match(/="(.*)"/);
  if (!m) throw new Error('SINA_BAD');
  const a = m[1].split(',');
  const price = num(a[1]);
  if (price === null) throw new Error('SINA_NO_PRICE');
  const prevClose = num(a[26]);
  return {
    secid, code: codeOf(secid), name: a[0] || codeOf(secid), market: marketOf(secid),
    marketName: MARKET_NAME[marketOf(secid)] || 'US',
    price, open: num(a[5]), high: num(a[6]), low: num(a[7]), prevClose,
    change: num(a[4]), changePct: num(a[2]),
    volume: num(a[10]), amount: num(a[30]),
    marketCap: num(a[12]), pe: nonZero(a[14]),
    high52: num(a[8]), low52: num(a[9]),
    ts: null, src: 'sina', updatedAt: Date.now(),
  };
}

async function sinaKline(secid, { period = 'day', limit = 320 }) {
  const code = codeOf(secid);
  const buf = await httpGet(
    `https://stock.finance.sina.com.cn/usstock/api/jsonp.php/var%20_K/US_MinKService.getDailyK?symbol=${code}`
  );
  const text = decodeGbk(buf);
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) throw new Error('SINA_NO_KLINE');
  let arr;
  try {
    arr = JSON.parse(m[0]);
  } catch {
    throw new Error('SINA_PARSE');
  }
  let bars = arr
    .map((r) => ({
      date: r.d, open: num(r.o), close: num(r.c), high: num(r.h), low: num(r.l),
      volume: num(r.v),
    }))
    .filter((b) => b.close !== null);
  if (period === 'week' || period === 'month') bars = aggregate(bars, period);
  return {
    secid, code, name: '', market: marketOf(secid), period,
    bars: bars.slice(-limit), src: 'sina',
  };
}

/** 日线聚合为周线 / 月线 */
function aggregate(bars, period) {
  const out = [];
  const keyOf = (d) => {
    const dt = new Date(d);
    if (period === 'month') return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
    const t = new Date(dt);
    const day = (t.getDay() + 6) % 7; // 周一为 0
    t.setDate(t.getDate() - day);
    return t.toISOString().slice(0, 10);
  };
  let cur = null;
  let ck = null;
  for (const b of bars) {
    const k = keyOf(b.date);
    if (k !== ck) {
      if (cur) out.push(cur);
      ck = k;
      cur = { ...b };
    } else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume = (cur.volume || 0) + (b.volume || 0);
    }
  }
  if (cur) out.push(cur);
  return out;
}

// ---------------------------------------------------------------- 统一入口

async function quoteOne(secid) {
  const ck = `q:${secid}`;
  const c = cache.get(ck, 8000);
  if (c) return c;
  let lastErr;
  for (const p of providerOrder()) {
    try {
      const q = p === 'em' ? await emQuote(secid) : p === 'tx' ? await txQuote(secid) : await sinaQuote(secid);
      markOk(p);
      cache.set(ck, q);
      return q;
    } catch (e) {
      markFail(p);
      lastErr = e;
    }
  }
  // 全挂：返回过期缓存兜底
  const stale = cache.get(ck, 30 * 60 * 1000);
  if (stale) return stale;
  throw lastErr || new Error('QUOTE_FAILED');
}

async function quotes(secids, { maxAge = 8000, concurrency = 3 } = {}) {
  const list = [...new Set(secids.filter(Boolean))];
  const out = new Map();
  const need = [];
  for (const s of list) {
    const c = cache.get(`q:${s}`, maxAge);
    if (c) out.set(s, c);
    else need.push(s);
  }
  const pool = new RequestQueue({ concurrency, minInterval: 160 });
  await Promise.all(
    need.map((s) =>
      pool.run(() => quoteOne(s)).then((q) => q && out.set(s, q)).catch(() => {})
    )
  );
  return list.map((s) => out.get(s)).filter(Boolean);
}

async function kline(secid, { period = 'day', limit = 320, fq = 1, fresh = false } = {}) {
  const key = `k:${secid}:${period}:${limit}:${fq}`;
  if (!fresh) {
    const c = cache.get(key, 30 * 60 * 1000);
    if (c) return c;
  }
  let lastErr;
  for (const p of providerOrder()) {
    try {
      const k = p === 'em' ? await emKline(secid, { period, limit, fq })
        : p === 'tx' ? await txKline(secid, { period, limit, fq })
        : await sinaKline(secid, { period, limit });
      if (k && k.bars && k.bars.length >= 20) {
        markOk(p);
        cache.set(key, k);
        return k;
      }
      markFail(p);
    } catch (e) {
      markFail(p);
      lastErr = e;
    }
  }
  const stale = cache.get(key, 24 * 60 * 60 * 1000);
  if (stale) return stale;
  throw lastErr || new Error('KLINE_FAILED');
}

async function search(keyword, limit = 12) {
  const kw = String(keyword || '').trim();
  if (!kw) return [];
  const ck = `s:${kw.toLowerCase()}`;
  const c = cache.get(ck, 30 * 60 * 1000);
  if (c) return c;
  try {
    const r = await emSearch(kw, limit);
    if (r.length) {
      cache.set(ck, r);
      return r;
    }
  } catch {
    markFail('em');
  }
  // 东财搜索不可用时，用内置池模糊匹配兜底
  const { POOL } = require('./pool');
  const low = kw.toLowerCase();
  return POOL.filter(
    (p) => p.code.toLowerCase().includes(low) || (p.name || '').toLowerCase().includes(low)
  ).slice(0, limit).map((p) => ({
    code: p.code, name: p.name, market: p.market, marketName: MARKET_NAME[p.market] || '',
    secid: p.secid,
  }));
}

async function rank(opts) {
  try {
    return await emRank(opts);
  } catch (e) {
    markFail('em');
    throw e;
  }
}

const INDEXES = [
  { secid: '100.NDX', code: 'NDX', name: '纳斯达克100' },
  { secid: '100.DJIA', code: 'DJIA', name: '道琼斯' },
  { secid: '100.SPX', code: 'SPX', name: '标普500' },
];

async function indexQuotes() {
  const out = [];
  for (const idx of INDEXES) {
    try {
      const q = await quoteOne(idx.secid);
      if (q && q.price !== null) out.push({ ...q, code: idx.code, name: idx.name });
    } catch {
      /* 指数失败忽略 */
    }
    await sleep(100);
  }
  return out;
}

/** 当前生效的数据源（用于界面展示） */
function activeSource() {
  const o = providerOrder();
  return { primary: o[0], health: { ...health } };
}

module.exports = {
  MARKET, MARKET_NAME, PERIOD, makeSecid, initCache, activeSource,
  clearCache: () => cache.clear(),
  search, quoteOne, quotes, kline, rank, indexQuotes, num, aggregate,
};
