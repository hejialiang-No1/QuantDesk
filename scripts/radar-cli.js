#!/usr/bin/env node
/**
 * radar-cli.js —— 命令行版「机会雷达」
 *
 * 为什么需要这个脚本：
 *   Electron 应用里的扫描要开 GUI 才能跑，而「策略调参 / 数据核对 / 出报告」
 *   这些事在命令行做效率高得多。更重要的是 —— 它和 App 用的是**同一份**
 *   datasource 与 shared 模块，所以命令行跑出来的结论与界面上看到的必须一致。
 *   如果两边不一致，问题一定出在模块里，而不是「环境不同」。
 *
 * 用法：
 *   node scripts/radar-cli.js --universe=aicompute --limit=25 --news=10 --extras=8
 *   node scripts/radar-cli.js --universe=highbeta --no-news --out=/tmp/radar.json
 *   node scripts/radar-cli.js --secids=105.NVDA,105.PLTR --no-events
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const ds = require(path.join(ROOT, 'src/main/datasource'));
const Screener = require(path.join(ROOT, 'src/shared/screener'));
const Moonshot = require(path.join(ROOT, 'src/shared/moonshot'));
const Insight = require(path.join(ROOT, 'src/shared/insight'));
const Newsfeed = require(path.join(ROOT, 'src/shared/newsfeed'));
const Events = require(path.join(ROOT, 'src/shared/events'));
const { POOL } = require(path.join(ROOT, 'src/main/pool'));

/** 代码 → 中文名（东财以中文报道为主，用中文名搜命中率高得多） */
const NAME_MAP = {};
for (const p of POOL) if (p && p.code) NAME_MAP[String(p.code).toUpperCase()] = p.name || '';

/**
 * 抓某只标的的新闻并做**相关性过滤**。
 * 策略：先用「标题必须命中代码/公司名」的严格口径；命中不足 2 条时，
 * 才放宽到「正文命中」。这样既不会被泛市场新闻污染情绪分，
 * 也不会因为公司名写法不同而一条都抓不到。
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
  return {
    items: Newsfeed.score(used, { keysOf: () => keys }),
    rawCount: parsed.length, keptCount: used.length, strict: strict.length >= 1,
  };
}

// ---------------------------------------------------------------- 参数

function parseArgs(argv) {
  const out = { _: [] };
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) {
      out._.push(a);
      continue;
    }
    const k = m[1];
    const v = m[2];
    if (v === undefined) out[k] = true;
    else if (v === 'false') out[k] = false;
    else if (/^-?\d+(\.\d+)?$/.test(v)) out[k] = Number(v);
    else out[k] = v;
  }
  return out;
}

const args = parseArgs(process.argv);
const UNIVERSE = args.universe || 'highbeta';
const LIMIT = Math.max(3, Number(args.limit) || 25);
const TOP_NEWS = args['no-news'] ? 0 : Math.max(0, Number(args.news || 10));
const TOP_EXTRAS = args['no-extras'] ? 0 : Math.max(0, Number(args.extras || 8));
const EVENT_DAYS = Math.max(0, Number(args['event-days'] == null ? 30 : args['event-days']));
const DO_EVENTS = !args['no-events'] && EVENT_DAYS > 0;
const DO_NEWS = TOP_NEWS > 0;
const DO_EXTRAS = TOP_EXTRAS > 0;
const MIN_AMOUNT = Number(args['min-amount'] || 0);
const OUT = args.out || '';
const QUIET = !!args.quiet;

// 进度一律走 stderr：stdout 要留给纯 JSON，方便 `node radar-cli.js | jq`
function log(...a) {
  if (!QUIET) console.error(...a);
}

// ---------------------------------------------------------------- 主流程

async function poolRun(items, concurrency, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        out[i] = await fn(items[i], i);
      } catch (e) {
        out[i] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  return out;
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
        code: t.code,
        label: t.label,
        secid: t.secid,
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

(async () => {
  const t0 = Date.now();
  ds.initCache(path.join(os.tmpdir(), 'quantdesk-radar-cache'));

  // 候选池
  let candidates;
  if (args.secids) {
    candidates = String(args.secids).split(',').map((s) => {
      const sid = s.includes('.') ? s : `105.${s}`;
      const code = sid.split('.').slice(1).join('.');
      return { secid: sid, altSecid: `106.${code}`, code, name: '' };
    });
  } else {
    const us = Screener.universes([]);
    const u = us[UNIVERSE];
    if (!u) {
      console.error(`未知股票池：${UNIVERSE}。可用：${Object.keys(us).join(', ')}`);
      process.exit(1);
    }
    candidates = u.codes.map((code) => ({
      secid: `105.${code}`, altSecid: `106.${code}`, code, name: '', group: u.label,
    }));
    log(`【股票池】${u.label} —— ${u.desc}（${candidates.length} 只）`);
  }

  const benchmark = await fetchBenchmark();
  log(`【基准】标普500 ${benchmark ? `${benchmark.ret20.toFixed(2)}% (20日) / ${benchmark.ret60.toFixed(2)}% (60日)，截至 ${benchmark.asOf}，源 ${benchmark.src}` : '不可用'}`);

  // 第 1 趟：K线
  log(`【行情】拉取 ${candidates.length} 只日线…`);
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
      } catch {}
    }
    done++;
    if (!QUIET && (done % 10 === 0 || done === candidates.length)) process.stderr.write(`\r  进度 ${done}/${candidates.length}   `);
    if (!k || !k.bars || k.bars.length < 60) return null;
    return { t, k };
  });
  log('');
  const valid = first.filter(Boolean);
  log(`【行情】成功 ${valid.length} / ${candidates.length}`);
  if (!valid.length) {
    console.error('❌ 没有取到足够的K线数据');
    process.exit(1);
  }

  // 实时行情
  try {
    const qt = await ds.quotes(valid.map((v) => v.t.secid), { maxAge: 120000, concurrency: 3 });
    const qmap = new Map(qt.map((q) => [q.secid, q]));
    for (const v of valid) v.quote = qmap.get(v.t.secid) || null;
    log(`【实时行情】${qt.length} 只，源 ${(qt[0] || {}).src || '--'}`);
  } catch (e) {
    log(`【实时行情】失败（不影响因子）：${e.message}`);
  }

  // 因子 + 暴涨分
  const scored = valid.map(({ t, k, quote }) => {
    const q = quote || { code: t.code || k.code, name: t.name || k.name };
    const f = Screener.computeFactors({ bars: k.bars, quote: q, symbol: t.code || k.code, benchmark, ppy: 252 });
    const m = Moonshot.score({ bars: k.bars, quote: q, symbol: t.code || k.code, benchmark, ppy: 252 });
    return { t, k, quote: q, factors: f, moonshot: m };
  }).filter((x) => x.factors);

  // 横截面规模分位
  const cs = Screener.scoreUniverse(scored.map((x) => x.factors), { sort: 'composite' });
  const csMap = new Map(cs.map((x) => [x.symbol, x]));
  for (const x of scored) {
    const c = csMap.get(x.factors.symbol);
    if (c) x.factors = { ...x.factors, scores: c.scores, composite: c.composite, sizePercentile: c.sizePercentile };
  }

  scored.sort((a, b) => (b.moonshot ? b.moonshot.score : 0) - (a.moonshot ? a.moonshot.score : 0));
  const passed = MIN_AMOUNT > 0 ? scored.filter((x) => ((x.factors.raw || {}).avgAmount || 0) >= MIN_AMOUNT) : scored;
  const tops = passed.slice(0, Math.max(LIMIT, TOP_NEWS, TOP_EXTRAS));
  log(`【筛选】通过流动性门槛 ${passed.length} 只，取前 ${tops.length} 只进入深挖`);

  // 事件
  let events = [];
  let eventMeta = null;
  if (DO_EVENTS) {
    log(`【事件】拉取未来 ${EVENT_DAYS} 天财报排期（按天查询，需要一会儿）…`);
    try {
      const b = await ds.calendarBundle({ days: EVENT_DAYS, include: ['earnings'] });
      events = Events.upcoming({ days: EVENT_DAYS, earnings: b.earnings, focusSymbols: tops.map((x) => String(x.factors.symbol)) });
      eventMeta = { fetchedDates: b.fetchedDates, earningsTotal: (b.earnings || []).length, errors: b.errors };
      const hits = events.filter((e) => e.scope === 'company');
      log(`【事件】抓到 ${b.earnings.length} 条财报排期，其中 ${hits.length} 条属于本次候选`);
    } catch (e) {
      eventMeta = { error: e.message };
      log(`【事件】失败：${e.message}`);
    }
  }

  // 新闻
  const newsMap = new Map();
  let newsMeta = null;
  if (DO_NEWS) {
    const targets = tops.slice(0, TOP_NEWS);
    const kws = [];
    for (const x of targets) {
      kws.push(String(x.factors.symbol));
      if (x.quote && x.quote.name && x.quote.name !== x.factors.symbol) kws.push(x.quote.name);
    }
    log(`【新闻】抓取 ${targets.length} 只标的（${kws.length} 个关键词）…`);
    try {
      const nb = await ds.newsBundle(kws, { limit: 12, concurrency: 2 });
      let raw = 0;
      let kept = 0;
      for (const x of targets) {
        const sym = String(x.factors.symbol).toUpperCase();
        const nm = x.quote && x.quote.name ? x.quote.name : '';
        const r = newsForSymbol(nb, sym, nm);
        newsMap.set(sym, r.items);
        raw += r.rawCount;
        kept += r.keptCount;
      }
      newsMeta = { errors: nb.errors, keywords: kws.length, rawHits: raw, afterRelevance: kept };
      log(`【新闻】原始命中 ${raw} 条 → 相关性过滤后 ${kept} 条（已剔除泛市场新闻）`);
    } catch (e) {
      newsMeta = { error: e.message };
      log(`【新闻】失败：${e.message}`);
    }
  }

  // 空头 + 分析师
  const extrasMap = new Map();
  if (DO_EXTRAS) {
    const targets = tops.slice(0, TOP_EXTRAS);
    log(`【增强】拉取 ${targets.length} 只的空头持仓与分析师目标价…`);
    await poolRun(targets, 2, async (x) => {
      const sym = String(x.factors.symbol).toUpperCase();
      const ex = await ds.fundamentalExtras(sym);
      if (ex) extrasMap.set(sym, ex);
    });
    log(`【增强】成功 ${extrasMap.size} 只`);
  }

  // 第 2 趟：完整 insight
  const rows = tops.map((x) => {
    const sym = String(x.factors.symbol).toUpperCase();
    const news = newsMap.get(sym) || [];
    const newsSummary = news.length ? Newsfeed.summarize(news) : null;
    const ex = extrasMap.get(sym) || {};
    const dte = Events.daysToEarnings(sym, events, undefined);
    const companyEvents = events.filter((e) => e.symbol === sym);
    const evRisk = Events.riskProfile([...companyEvents, ...events.filter((e) => e.scope === 'market')], { symbol: sym });
    const ins = Insight.analyze({
      bars: x.k.bars, quote: x.quote, factors: x.factors,
      newsSummary, eventRisk: evRisk, daysToEarnings: dte,
      shortInterest: ex.shortInterest || null, analyst: ex.analyst || null,
      benchmark, ppy: 252,
    });
    // 第二趟重算暴涨潜力分：第一趟只有价格，催化维度拿不到新闻/财报/分析师，
    // 会一律落到中位分 —— 等于把 6% 的权重变成常数。这里用完整上下文重算，
    // 保证表格里显示的分数与用户能看到的证据是同一套输入算出来的。
    const m2 = Moonshot.score({
      bars: x.k.bars, quote: x.quote, symbol: sym, benchmark, ppy: 252,
      newsSummary, daysToEarnings: dte,
      shortInterest: ex.shortInterest || null, analyst: ex.analyst || null,
    });
    return {
      secid: x.t.secid, symbol: sym,
      name: x.factors.name || x.quote.name || sym,
      group: x.t.group || '',
      price: x.factors.price, changePct: x.factors.changePct,
      pe: x.factors.pe, marketCap: x.factors.marketCap,
      factorComposite: x.factors.composite, scores: x.factors.scores, raw: x.factors.raw,
      moonshot: m2 || x.moonshot, insight: ins, news, newsSummary,
      daysToEarnings: dte, events: companyEvents,
      shortInterest: ex.shortInterest || null, analyst: ex.analyst || null,
      extrasErrors: ex.errors || null, bars: x.k.bars.length,
    };
  });
  // 用重算后的分数重排（第一趟的排序基于不完整上下文）
  rows.sort((a, b) => (b.moonshot ? b.moonshot.score : 0) - (a.moonshot ? a.moonshot.score : 0));

  const dist = { A: 0, B: 0, C: 0, D: 0 };
  for (const r of rows) if (r.moonshot) dist[r.moonshot.grade] = (dist[r.moonshot.grade] || 0) + 1;

  const marketEvents = Events.upcoming({ days: Math.max(45, Math.min(EVENT_DAYS || 45, 120)) });
  const allNews = [];
  for (const [, list] of newsMap) allNews.push(...list);

  const payload = {
    rows,
    benchmark,
    universe: UNIVERSE,
    events,
    marketEvents: marketEvents.filter((e) => e.scope === 'market'),
    marketRisk: Events.riskProfile(marketEvents.filter((e) => e.scope === 'market')),
    eventMeta, newsMeta,
    overallNews: Newsfeed.summarize(Newsfeed.score(allNews)),
    moonshotDist: dist,
    sources: ds.activeSource(),
    costMs: Date.now() - t0,
    generatedAt: Date.now(),
  };

  if (OUT) {
    fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
    log(`\n✅ 结果已写入 ${OUT}`);
  } else if (!QUIET) {
    process.stdout.write(JSON.stringify(payload, null, 2));
  }

  log(`\n【完成】耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
})().catch((e) => {
  console.error('❌ 失败：', e && e.stack ? e.stack : e);
  process.exit(1);
});
