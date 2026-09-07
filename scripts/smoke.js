/**
 * 冒烟测试：验证数据层与算法层（不需要 Electron 即可运行）
 * 用法：node scripts/smoke.js
 */
const path = require('path');
const os = require('os');
const ds = require('../src/main/datasource');
const Ind = require('../src/shared/indicators');
const Fac = require('../src/shared/factors');
const BT = require('../src/shared/backtest');

ds.initCache(path.join(os.tmpdir(), 'quantdesk-smoke-cache'));

function ok(name, cond, extra) {
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`);
  return cond;
}

(async () => {
  let pass = 0;
  let fail = 0;
  const check = (n, c, e) => (ok(n, c, e) ? pass++ : fail++);

  // 1) 搜索
  console.log('\n--- 搜索接口 ---');
  try {
    const r = await ds.search('NVDA');
    check('搜索 NVDA 返回结果', r.length > 0, JSON.stringify(r[0] || {}));
    const hit = r.find((x) => x.code === 'NVDA');
    check('命中 NVDA 且带市场号', !!hit && !!hit.secid, hit ? hit.secid : '');
  } catch (e) {
    check('搜索接口', false, e.message);
  }

  // 2) 实时行情
  console.log('\n--- 实时行情 ---');
  let quote = null;
  try {
    quote = await ds.quoteOne('105.NVDA');
    check('NVDA 行情返回', !!quote && quote.price > 0,
      quote ? `${quote.name} $${quote.price} (${quote.changePct}%)` : '');
    check('昨收与涨跌幅自洽',
      quote && Math.abs((quote.price - quote.prevClose) / quote.prevClose * 100 - quote.changePct) < 0.5,
      quote ? `现价${quote.price} 昨收${quote.prevClose} 涨幅${quote.changePct}%` : '');
  } catch (e) {
    check('实时行情', false, e.message);
  }

  // 3) 批量行情
  console.log('\n--- 批量行情 ---');
  try {
    const t0 = Date.now();
    const list = await ds.quotes(['105.NVDA', '105.AAPL', '105.TSLA', '105.MSFT'], { maxAge: 0 });
    check('批量返回 4 只', list.length === 4, `耗时 ${Date.now() - t0}ms`);
    check('批量数据完整', list.every((q) => q.price > 0), list.map((q) => `${q.code}:${q.price}`).join(' '));
  } catch (e) {
    check('批量行情', false, e.message);
  }

  // 4) K线
  console.log('\n--- K线 ---');
  let k = null;
  try {
    k = await ds.kline('105.NVDA', { period: 'day', limit: 300, fq: 1 });
    check('K线返回', !!k && k.bars.length > 200, k ? `${k.bars.length} 根，最新 ${k.bars[k.bars.length - 1].date}` : '');
    const b = k.bars[k.bars.length - 1];
    check('OHLC 合理', b.high >= b.low && b.close > 0, JSON.stringify(b));
    check('K线时间正序', k.bars[0].date < b.date, `${k.bars[0].date} → ${b.date}`);
  } catch (e) {
    check('K线接口', false, e.message);
  }

  if (!k) {
    console.log('\nK线失败，后续算法测试中止');
    process.exit(1);
  }

  const bars = k.bars;
  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);

  // 5) 指标
  console.log('\n--- 技术指标 ---');
  const ma20 = Ind.sma(closes, 20);
  check('MA20 计算', ma20[ma20.length - 1] > 0, `MA20=${ma20[ma20.length - 1].toFixed(2)}`);
  const macd = Ind.macd(closes);
  check('MACD 计算', macd.dif[closes.length - 1] != null,
    `DIF=${macd.dif[closes.length - 1].toFixed(3)} DEA=${macd.dea[closes.length - 1].toFixed(3)}`);
  const rsi = Ind.rsi(closes, 14);
  const rv = rsi[closes.length - 1];
  check('RSI 在 0-100', rv != null && rv >= 0 && rv <= 100, `RSI=${rv.toFixed(1)}`);
  const kd = Ind.kdj(highs, lows, closes);
  check('KDJ 计算', kd.k[closes.length - 1] != null, `K=${kd.k[closes.length - 1].toFixed(1)}`);
  const boll = Ind.boll(closes, 20, 2);
  check('布林带上轨 > 下轨', boll.upper[closes.length - 1] > boll.lower[closes.length - 1],
    `UP=${boll.upper[closes.length - 1].toFixed(2)} LOW=${boll.lower[closes.length - 1].toFixed(2)}`);

  // 6) 因子
  console.log('\n--- 因子评分 ---');
  const a = Fac.analyze(bars, quote);
  check('因子分析返回', !!a, a ? `评分 ${a.score}` : '');
  if (a) {
    check('评分在 0-100', a.score >= 0 && a.score <= 100, `score=${a.score}`);
    const sum = Object.values(a.factors).reduce((x, y) => x + y, 0);
    check('分项之和 ≈ 总分', Math.abs(sum - a.score) < 1.5, `分项和=${sum.toFixed(1)} 总分=${a.score}`);
    console.log('   因子：', JSON.stringify(a.factors));
    console.log('   信号：', a.signals.map((s) => s.text).join(' / ') || '无');
    console.log('   评级：', Fac.rating(a.score).label);
  }

  // 7) 回测
  console.log('\n--- 策略回测 ---');
  for (const s of Object.keys(BT.STRATEGIES)) {
    try {
      const r = BT.run({ bars, strategy: s, initialCapital: 100000, commission: 0.0005, slippage: 0.0005 });
      if (r.error) {
        check(`策略 ${s}`, false, r.error);
        continue;
      }
      const valid =
        isFinite(r.totalReturn) && isFinite(r.maxDrawdown) && r.maxDrawdown >= 0 && isFinite(r.sharpe);
      check(
        `策略 ${BT.STRATEGIES[s].name}`,
        valid,
        `收益 ${r.totalReturn.toFixed(2)}% | 基准 ${r.benchmark.toFixed(2)}% | 回撤 ${r.maxDrawdown.toFixed(
          2
        )}% | 交易 ${r.tradeCount} 笔 | 胜率 ${r.winRate.toFixed(1)}%`
      );
    } catch (e) {
      check(`策略 ${s}`, false, e.message);
    }
  }

  // 8) 边界：数据不足
  const short = BT.run({ bars: bars.slice(0, 20), strategy: 'ma_cross' });
  check('数据不足时返回错误提示', !!short.error, short.error || '');

  console.log(`\n===== 通过 ${pass} 项，失败 ${fail} 项 =====\n`);
  process.exit(fail ? 1 : 0);
})();
