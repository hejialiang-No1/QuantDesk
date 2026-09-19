#!/usr/bin/env node
/**
 * verify-quotes.js —— 多源行情交叉验证
 *
 * 为什么需要它：
 *   行情错了，后面所有的因子、评分、风险点全是错的，而且**不会报错**。
 *   典型症状是「数字看起来都挺合理，只是全都偏了一点」——这是最危险的故障类型。
 *   本脚本拿同一批标的去问多个独立数据源，把不一致的挑出来。
 *
 * 验证逻辑（不是简单比对字符串）：
 *   1. 取每个源的「最新收盘价」，两两算相对偏差
 *   2. 偏差 < 0.5% 视为一致（不同源的收盘价可能有微小时间差）
 *   3. 只要有一个源与其它源集体不一致，就把该标的标红
 *   4. 单独报告「只有一个源可用」的标的 —— 无法交叉验证 ≠ 数据正确
 *
 * 用法:
 *   node scripts/verify-quotes.js                       # 默认验证一批高关注标的
 *   node scripts/verify-quotes.js --symbols=MU,DELL,AMD
 *   node scripts/verify-quotes.js --universe=aicompute
 */
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const ds = require(path.join(ROOT, 'src/main/datasource'));
const Screener = require(path.join(ROOT, 'src/shared/screener'));

const args = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) args[m[1]] = m[2] === undefined ? true : m[2];
}

const DEFAULT_SYMBOLS = ['NVDA', 'AAPL', 'MU', 'DELL', 'AMD', 'COIN', 'MSTR', 'HUT', 'TSLA', 'PLTR'];

function symbols() {
  if (args.symbols) return String(args.symbols).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (args.universe) {
    const u = Screener.UNIVERSE_RAW[args.universe];
    if (!u) {
      console.error(`未知股票池：${args.universe}。可用：${Object.keys(Screener.UNIVERSE_RAW).join(', ')}`);
      process.exit(1);
    }
    return u.codes.slice(0, Number(args.limit) || 25);
  }
  return DEFAULT_SYMBOLS;
}

/**
 * 逐个数据源直连取「最新收盘价」，绕过 ds 的自动降级 ——
 * 降级机制会掩盖问题：你只会看到「最终拿到了数据」，看不到某个源其实一直在返回错值。
 */
async function bySource(secid) {
  const out = {};
  const code = String(secid).split('.').slice(1).join('.');

  // 东财
  try {
    const r = await ds.kline(secid, { period: 'day', limit: 5, fresh: true });
    if (r && r.src === 'em' && r.bars && r.bars.length) out.em = { price: r.bars[r.bars.length - 1].close, date: r.bars[r.bars.length - 1].date };
  } catch {}

  // 腾讯（直接打接口，避免被降级逻辑接管）
  try {
    // 顺序很重要：带后缀的 `usXXX.OQ/.N` 返回的是干净的 qfqday 数组，
    // 而不带后缀的 `usXXX` 有时会返回「首条日期极早、总条数只有两三条」的拼接脏数组。
    // 两者最后一个元素的收盘价通常一致，但脏数组不可用于任何长度相关的计算（如均线）。
    const syms = [`us${code}.OQ`, `us${code}.N`, `us${code}`];
    for (const sym of syms) {
      const url = `https://web.ifzq.gtimg.cn/appstock/app/usfqkline/get?_var=k&param=${sym},day,,,5,qfq`;
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36' } });
      const text = await res.text();
      const j = JSON.parse(text.replace(/^\s*\w+=/, '').trim());
      const node = j && j.data && j.data[sym];
      const arr = node && (node.qfqday || node.day);
      if (Array.isArray(arr) && arr.length >= 2) {
        const last = arr[arr.length - 1][0];
        const first = arr[0][0];
        // 条数明显少于请求量 → 说明落到的是「拼接数组」分支，后续会换用更干净的写法重试
        const sparse = arr.length < 3 && first < '2020-01-01';
        out.tx = {
          price: Number(arr[arr.length - 1][2]),
          date: last,
          symbol: sym,
          bars: arr.length,
          suspect: sparse ? `拿到 ${arr.length} 条且首条为 ${first}，疑似拼接数组（价格仍可用，但不可用于均线计算）` : null,
        };
        if (!sparse) break;
      }
    }
  } catch {}

  // 新浪
  try {
    const res = await fetch(`https://hq.sinajs.cn/list=gb_${code.toLowerCase()}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://finance.sina.com.cn' },
    });
    const buf = await res.arrayBuffer();
    let text;
    try {
      text = new TextDecoder('gbk').decode(buf);
    } catch {
      text = new TextDecoder('utf-8').decode(buf);
    }
    const m = text.match(/="(.*)"/);
    if (m && m[1]) {
      const a = m[1].split(',');
      const price = Number(a[1]);
      if (Number.isFinite(price) && price > 0) out.sina = { price, date: a[3] || '' };
    }
  } catch {}

  // nasdaq（官方）
  try {
    const today = new Date();
    const from = new Date(today.getTime() - 12 * 86400000);
    const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(code)}/historical?assetclass=stocks&limit=3&fromdate=${fmt(from)}&todate=${fmt(today)}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
        Accept: 'application/json',
      },
    });
    const j = await res.json();
    const rows = j && j.data && j.data.tradesTable && j.data.tradesTable.rows;
    if (Array.isArray(rows) && rows.length) {
      const r = rows[0];
      const price = Number(String(r.close).replace(/[$,]/g, ''));
      if (Number.isFinite(price) && price > 0) out.nasdaq = { price, date: r.date };
    }
  } catch {}

  return out;
}

(async () => {
  ds.initCache(path.join(os.tmpdir(), 'quantdesk-verify-cache'));
  const list = symbols();
  console.log(`\n交叉验证 ${list.length} 只标的（多源取最新收盘价，偏差 > 0.5% 视为不一致）\n`);
  console.log('标的'.padEnd(8) + '东财'.padStart(12) + '腾讯'.padStart(12) + '新浪'.padStart(12) + 'nasdaq'.padStart(12) + '  判定');
  console.log('-'.repeat(76));
  console.log('（显示 -- 表示该数据源本次不可达，不代表数据错误）\n');

  let ok = 0;
  let warn = 0;
  let bad = 0;
  let unverified = 0;
  const problems = [];

  for (const sym of list) {
    const secid = `105.${sym}`;
    const res = await bySource(secid);
    const srcs = Object.keys(res).filter((k) => !res[k].suspect);
    const prices = srcs.map((k) => res[k].price);
    const fm = (v) => (v == null ? '--' : '$' + v.toFixed(2));

    let verdict;
    if (prices.length >= 2) {
      const mx = Math.max(...prices);
      const mn = Math.min(...prices);
      const dev = mx > 0 ? ((mx - mn) / mn) * 100 : 0;
      if (dev <= 0.5) {
        verdict = `✅ 一致（最大偏差 ${dev.toFixed(2)}%）`;
        ok++;
      } else {
        verdict = `❌ 不一致（最大偏差 ${dev.toFixed(1)}%）`;
        bad++;
        problems.push({ sym, res, dev });
      }
    } else if (prices.length === 1) {
      verdict = '⚠️ 仅一个源可用，无法交叉验证';
      unverified++;
      problems.push({ sym, res, dev: null });
    } else {
      verdict = '❌ 所有源都取不到';
      bad++;
      problems.push({ sym, res, dev: null });
    }

    console.log(
      sym.padEnd(8) +
        fm(res.em && res.em.price).padStart(12) +
        fm(res.tx && res.tx.price).padStart(12) +
        fm(res.sina && res.sina.price).padStart(12) +
        fm(res.nasdaq && res.nasdaq.price).padStart(12) +
        '  ' +
        verdict
    );
    if (res.tx && res.tx.suspect) console.log('        └ 腾讯源提示：' + res.tx.suspect);
  }

  console.log('-'.repeat(76));
  console.log(`一致 ${ok} · 不一致 ${bad} · 仅单源 ${unverified}\n`);

  if (problems.length) {
    console.log('需要人工确认的标的：');
    for (const p of problems) {
      const detail = Object.entries(p.res)
        .map(([k, v]) => `${k}=$${v.price}${v.date ? '@' + v.date : ''}${v.suspect ? '（可疑）' : ''}`)
        .join('  ');
      console.log(`  · ${p.sym}：${detail}`);
    }
    console.log(
      '\n注意：不一致 ≠ 一定是数据错误。可能是「不同源的收盘时间差一天」或「复权口径不同」。' +
        '但如果你看到某个源明显偏离一个数量级，那就是真错了 —— 该源的 K 线会污染所有下游计算。\n'
    );
  } else {
    console.log('所有标的均通过交叉验证。\n');
  }

  process.exit(bad ? 1 : 0);
})().catch((e) => {
  console.error('验证失败：', e && e.stack ? e.stack : e);
  process.exit(1);
});
