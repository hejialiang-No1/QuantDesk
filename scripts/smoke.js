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
const Lv = require('../src/shared/levels');
const TP = require('../src/shared/tradeplan');
const DG = require('../src/shared/diagnose');
const OPT = require('../src/shared/options');

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

  // 7) 支撑压力位
  console.log('\n--- 支撑压力位 ---');
  const lv = Lv.compute(bars, {});
  if (lv) {
    check('返回结构完整', !!lv.verdict && !!lv.pivot && Array.isArray(lv.supports),
      `支撑 ${lv.supports.length} 档 · 压力 ${lv.resistances.length} 档 · ATR ${lv.atr.toFixed(2)}`);
    check('支撑全部低于现价', lv.supports.every((s) => s.price < lv.price), `现价 ${lv.price}`);
    check('压力全部高于现价', lv.resistances.every((s) => s.price > lv.price), `现价 ${lv.price}`);
    check('枢轴点七档齐全', lv.pivot && ['P', 'R1', 'R2', 'R3', 'S1', 'S2', 'S3'].every((k) => lv.pivot[k] != null),
      JSON.stringify(lv.pivot));
    check('支撑由近到远排序',
      lv.supports.every((s, i) => i === 0 || Math.abs(s.price - lv.price) >= Math.abs(lv.supports[i - 1].price - lv.price)));
    console.log('   支撑：', lv.supports.map((s) => `${s.price}(${s.strength})`).join(' '));
    console.log('   压力：', lv.resistances.map((s) => `${s.price}(${s.strength})`).join(' '));
    console.log('   结论：', lv.verdict.label, '—', lv.verdict.text);
  } else {
    check('支撑压力位计算', false);
  }

  // 8) 交易计划（推荐买入 / 卖出区间）
  console.log('\n--- 交易计划 ---');
  const tp = TP.plan(bars, { quote, levels: lv });
  if (tp) {
    check('买入区间有效', tp.buy.low > 0 && tp.buy.high > tp.buy.low, `${tp.buy.low} – ${tp.buy.high}`);
    check('买入区间低于现价', tp.buy.high < tp.price, `现价 ${tp.price} vs 买区上沿 ${tp.buy.high}`);
    check('卖出区间高于现价', tp.sell.low > tp.price, `T1 ${tp.sell.low} vs 现价 ${tp.price}`);
    check('三档目标价严格递增',
      tp.sell.targets[0].price < tp.sell.targets[1].price && tp.sell.targets[1].price < tp.sell.targets[2].price,
      tp.sell.targets.map((t) => t.price).join(' < '));
    check('止损低于买入区间下沿', tp.stop.price < tp.buy.low, `止损 ${tp.stop.price} vs 买区下沿 ${tp.buy.low}`);
    check('止损幅度在 -4% ~ -20% 之间', tp.stop.pct < -4 && tp.stop.pct > -20, `${tp.stop.pct}%`);
    check('盈亏比为正', tp.rr > 0, `rr=${tp.rr}`);
    check('建议仓位在 2% ~ 25%', tp.position.pct >= 2 && tp.position.pct <= 25, `${tp.position.pct}%`);
    check('三笔分批权重合计 100%', tp.buy.tranches.reduce((s, t) => s + t.weight, 0) === 100);
    check('三档止盈权重合计 100%', tp.sell.targets.reduce((s, t) => s + t.weight, 0) === 100);
    check('触发条件非空', tp.triggers.entry.length > 0 && tp.triggers.exit.length > 0 && tp.triggers.invalidate.length > 0,
      `买入 ${tp.triggers.entry.length} · 离场 ${tp.triggers.exit.length} · 失效 ${tp.triggers.invalidate.length}`);
    console.log('   买入区间：', `${tp.buy.low} – ${tp.buy.high}（${tp.buy.quality}）`, '中枢', tp.buy.ref);
    console.log('   卖出区间：', `${tp.sell.low} – ${tp.sell.high}`);
    console.log('   止盈目标：', tp.sell.targets.map((t) => `${t.label} ${t.price}(${t.gainPct}%)`).join('  '));
    console.log('   止损：', tp.stop.price, `${tp.stop.pct}%`, '| 盈亏比', tp.rr, '| 仓位', tp.position.pct + '%');
    console.log('   当前动作：', tp.action.label, '—', tp.action.text);
  } else {
    check('交易计划生成', false);
  }

  // 9) 全面诊股
  console.log('\n--- 全面诊股 ---');
  const dg = DG.diagnose(bars, { quote });
  if (dg) {
    check('六个维度齐全', dg.dims.length === 6, dg.dims.map((d) => `${d.label}:${d.score}`).join(' '));
    check('维度得分均在 0-100', dg.dims.every((d) => d.score >= 0 && d.score <= 100));
    check('综合得分在 0-100', dg.score >= 0 && dg.score <= 100, `${dg.score} / ${dg.rating.label}`);
    check('机会清单非空', dg.opportunities.length > 0, `${dg.opportunities.length} 条`);
    check('风险清单非空', dg.risks.length > 0, `${dg.risks.length} 条`);
    check('每条机会都带说明与依据',
      dg.opportunities.every((o) => o.title && o.detail));
    check('每条风险都带等级',
      dg.risks.every((o) => ['高', '中', '低'].includes(o.level)), dg.risks.map((r) => r.level).join(','));
    check('体检项为 8 项', dg.checks.length === 8, `通过 ${dg.passCount}/8`);
    check('结论文本足够具体', dg.summary.length > 80, `${dg.summary.length} 字`);
    check('给出风险等级与持有周期', !!dg.riskLevel && !!dg.horizon, `${dg.riskLevel} · ${dg.horizon}`);
    console.log('   维度：', dg.dims.map((d) => `${d.label} ${d.score}(${d.g})`).join('  '));
    dg.opportunities.slice(0, 3).forEach((o) => console.log('   机会：', o.title, `[${o.level}]`));
    dg.risks.slice(0, 3).forEach((o) => console.log('   风险：', o.title, `[${o.level}]`));
    console.log('   结论：', dg.summary);
  } else {
    check('全面诊股计算', false);
  }

  // 10) 期权策略
  console.log('\n--- 期权策略 ---');
  // 先用 Black-Scholes 做一次看跌看涨平价校验（这是定价正确性的硬约束）
  {
    const S = 100, K = 105, T = 0.25, r = 0.043, sig = 0.32;
    const c = OPT.bs(S, K, T, r, sig, 'call').price;
    const p = OPT.bs(S, K, T, r, sig, 'put').price;
    const lhs = c - p;
    const rhs = S - K * Math.exp(-r * T);
    check('看跌看涨平价成立（C−P = S−Ke⁻ʳᵗ）', Math.abs(lhs - rhs) < 0.01,
      `C−P=${lhs.toFixed(4)} vs ${rhs.toFixed(4)}`);
    const cAtm = OPT.bs(100, 100, 0.25, 0.043, 0.32, 'call').price;
    check('平值 Call Δ 接近 0.5～0.6', (() => {
      const d = OPT.bs(100, 100, 0.25, 0.043, 0.32, 'call').delta;
      return d > 0.45 && d < 0.65;
    })(), `ATM Call 价 ${cAtm.toFixed(3)}`);
    check('正态分布 CDF 边界正确',
      Math.abs(OPT.normCdf(0) - 0.5) < 1e-6 && OPT.normCdf(-6) < 1e-6 && OPT.normCdf(6) > 1 - 1e-6);
  }

  const op = OPT.build(bars, { quote, dte: 30 });
  if (op) {
    check('期权链至少 5 档', op.chain.length >= 5, `${op.chain.length} 档 · ATM ${op.atmStrike}`);
    check('行权价按升序排列', op.chain.every((c, i) => i === 0 || c.strike > op.chain[i - 1].strike));
    check('ATM 行权价贴近现价', Math.abs(op.atmStrike - op.spot) / op.spot < 0.05,
      `ATM ${op.atmStrike} vs 现价 ${op.spot}`);
    check('隐含波动率在合理区间', op.ivPct > 3 && op.ivPct < 250, `HV ${op.hvPct}% → IV ${op.ivPct}%`);
    check('期望波动区间自洽（下行 < 现价 < 上行）',
      op.expectedRange[0] < op.spot && op.expectedRange[1] > op.spot,
      op.expectedRange.join(' ~ '));
    check('策略数量 ≥ 8', op.strategies.length >= 8, `${op.strategies.length} 个`);
    check('按适配度降序', op.strategies.every((s, i) => i === 0 || s.fit <= op.strategies[i - 1].fit),
      op.strategies.map((s) => s.fit).join(' > '));
    check('每个策略都有腿', op.strategies.every((s) => s.legs.length >= 1));
    check('胜率在 0-100 之间', op.strategies.every((s) => s.probProfit >= 0 && s.probProfit <= 100),
      op.strategies.map((s) => s.probProfit.toFixed(0) + '%').join(' '));
    check('最大亏损不为正数', op.strategies.every((s) => s.maxLoss <= 0.0001));
    check('无界盈亏被正确标记',
      op.strategies.some((s) => s.maxProfitUnbounded),
      op.strategies.filter((s) => s.maxProfitUnbounded).map((s) => s.name).join(' / '));
    check('定义风险策略的最大亏损等于资金占用',
      op.strategies.filter((s) => s.key === 'bull_call_spread' || s.key === 'bear_put_spread' || s.key === 'iron_condor')
        .every((s) => Math.abs(s.capitalRequired - Math.abs(s.maxLoss)) < 1));
    const bc = op.strategies.find((s) => s.key === 'bull_call_spread');
    check('牛市价差最大盈利被高行权价封顶',
      bc && Math.abs(bc.maxProfit - ((bc.legs[1].K - bc.legs[0].K) * 100 - Math.abs(bc.netPremium))) < 1,
      bc ? `最大盈利 ${bc.maxProfit}` : '');
    check('手动覆盖 IV 生效', (() => {
      const o2 = OPT.build(bars, { quote, dte: 30, iv: 0.6 });
      return Math.abs(o2.ivPct - 60) < 0.5 && o2.ivIsManual === true;
    })(), '显式传入 iv=0.6 → 应得 60.0%');
    check('期限切换改变到期日', (() => {
      const a7 = OPT.build(bars, { quote, dte: 7 });
      const a60 = OPT.build(bars, { quote, dte: 60 });
      return a7.expiry !== a60.expiry || a7.dte !== a60.dte;
    })());
    console.log('   现价', op.spot, '| HV', op.hvPct + '%', '→ IV', op.ivPct + '%', '| 到期', op.expiry, `(${op.dte}天)`);
    console.log('   ±1σ 期望区间', op.expectedRange.join(' ~ '));
    console.log('   波动率环境：', op.volRegime.label, '—', op.volRegime.note);
    op.strategies.slice(0, 4).forEach((s) =>
      console.log(`   [适配 ${s.fit}] ${s.name} | 最大盈利 ${s.maxProfitUnbounded ? '不封顶' : s.maxProfit} | 最大亏损 ${s.maxLoss} | 胜率 ${s.probProfit}%`)
    );
  } else {
    check('期权策略生成', false);
  }

  // 11) 回测
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

  // 12) 周期口径：同一段K线按日/周/月解释，年化波动率必须按 √(ppy) 缩放
  //     回归用例：store 里残留 period='month' 曾让年化波动率被放大 √21 倍（IV 250%）
  console.log('\n--- 周期口径（年化波动率 / 期权 IV） ---');
  {
    const dA = Fac.analyze(bars, quote, 252);
    const wA = Fac.analyze(bars, quote, 52);
    const mA = Fac.analyze(bars, quote, 12);
    check(
      '日线年化波动率 > 周线 > 月线',
      dA.metrics.volatility > wA.metrics.volatility && wA.metrics.volatility > mA.metrics.volatility,
      `${dA.metrics.volatility}% > ${wA.metrics.volatility}% > ${mA.metrics.volatility}%`
    );
    // 理论上 vol_daily / vol_weekly = √(252/52) = 2.20x
    const expected = Math.sqrt(252 / 52);
    const actual = dA.metrics.volatility / wA.metrics.volatility;
    check(
      '日/周年化比 ≈ √(252/52)',
      Math.abs(actual - expected) < 0.05,
      `实测 ${actual.toFixed(3)}x vs 理论 ${expected.toFixed(3)}x`
    );
    const opD = OPT.build(bars, { quote, ppy: 252, dte: 30 });
    const opM = OPT.build(bars, { quote, ppy: 12, dte: 30 });
    check(
      '月线口径 IV 回落到合理区间（<100%）',
      opM.ivPct > 0 && opM.ivPct < 100,
      `日线 ${opD.ivPct}% → 月线 ${opM.ivPct}%`
    );
    check(
      '月线/日线 IV 比值 ≈ √(12/252)',
      Math.abs(opM.hvPct / opD.hvPct - Math.sqrt(12 / 252)) < 0.05,
      `${(opM.hvPct / opD.hvPct).toFixed(3)}x vs 理论 ${Math.sqrt(12 / 252).toFixed(3)}x`
    );
    const dgM = DG.diagnose(bars, { quote, ppy: 12, unit: '月' });
    check('诊股接受周期口径且结论注明单位', !!dgM && /每根K线代表 1 月/.test(dgM.summary), (dgM && dgM.summary.slice(-40)) || '');
  }

  // 13) 边界：数据不足
  const short = BT.run({ bars: bars.slice(0, 20), strategy: 'ma_cross' });
  check('数据不足时返回错误提示', !!short.error, short.error || '');

  console.log(`\n===== 通过 ${pass} 项，失败 ${fail} 项 =====\n`);
  process.exit(fail ? 1 : 0);
})();
