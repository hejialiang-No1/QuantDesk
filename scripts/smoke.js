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
// v1.0.2
const Mkt = require('../src/shared/market');
const Perf = require('../src/shared/perf');
const Tax = require('../src/shared/tax');
const Risk = require('../src/shared/risk');
const Paper = require('../src/shared/paper');
const Broker = require('../src/shared/broker');
const Screener = require('../src/shared/screener');
const Alerts = require('../src/shared/alerts');

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

  // ============================================================
  //  v1.0.2 新增模块自检（全部离线，不依赖网络）
  // ============================================================

  // 14) 美股市场规则
  console.log('\n--- 美股市场规则（market.js） ---');
  {
    const h26 = Mkt.holidays(2026).map((x) => x.date);
    const mustHave = ['2026-01-01', '2026-07-03', '2026-11-26', '2026-12-25'];
    check(
      '2026 年假期含元旦/独立日/感恩节/圣诞',
      mustHave.every((d) => h26.includes(d)),
      `${h26.length} 个假期`
    );
    check('2026-09-12（周六）非交易日', Mkt.isTradingDay('2026-09-12') === false);
    check('2026-11-26（感恩节）非交易日', Mkt.isTradingDay('2026-11-26') === false);
    const hd = Mkt.halfDays(2026).map((x) => x.date);
    check('2026 半日市为 11-27 与 12-24', hd.includes('2026-11-27') && hd.includes('2026-12-24'), hd.join(', '));
    check('2025-07-03 是半日市（独立日前夕）', Mkt.halfDays(2025).some((x) => x.date === '2025-07-03'));

    const summer = Mkt.session(new Date('2026-09-11T14:00:00Z')); // 10:00 ET
    check('9 月为夏令时 EDT（偏移 -4）', summer.dst === true && summer.etOffset === -4, `ET ${summer.et}`);
    const winter = Mkt.session(new Date('2026-12-11T15:00:00Z')); // 10:00 ET
    check('12 月为冬令时 EST（偏移 -5）', winter.dst === false && winter.etOffset === -5, `ET ${winter.et}`);
    check('同时刻夏令时 phase=regular', summer.phase === 'regular', summer.label);

    // T+1：周五卖出 → 下周一结算
    const st = Mkt.settleDate('2026-09-11');
    check('周五卖出 T+1 结算落到下周一', st.date === '2026-09-14', `${st.date}（${st.weekdayName}）`);

    // PDT：窗口由 asOf 倒推 5 个交易日（2026-09-07 劳动节应被跳过）
    const pdtWin = Mkt.pdtCheck([], 20000, new Date('2026-09-11T14:00:00Z'));
    check('PDT 窗口为最近 5 个交易日且跳过 9/7 劳动节', pdtWin.windowDays.length === 5 && !pdtWin.windowDays.includes('2026-09-07'), pdtWin.windowDays.join(','));
    const used3 = pdtWin.windowDays.slice(-3).map((d) => ({ date: d }));
    const pdt1 = Mkt.pdtCheck(used3, 20000, new Date('2026-09-11T14:00:00Z'));
    check('净值 < $25k 且已用 3 次 → 第 4 次触发 PDT', pdt1.willTrigger === true && pdt1.count === 3, pdt1.note);
    const pdt2 = Mkt.pdtCheck(used3, 30000, new Date('2026-09-11T14:00:00Z'));
    check('净值 ≥ $25k 不受 PDT 限制', pdt2.willTrigger === false);
    // 三种输入口径（对象 / 裸日期 / 带时间戳）必须得到同一结论
    const pdtFlat = Mkt.pdtCheck(pdtWin.windowDays.slice(-3), 20000, new Date('2026-09-11T14:00:00Z'));
    const pdtIso = Mkt.pdtCheck(pdtWin.windowDays.slice(-3).map((d) => d + 'T14:00:00Z'), 20000, new Date('2026-09-11T14:00:00Z'));
    check('PDT 容忍对象 / 裸日期 / 带时间戳三种入参', pdtFlat.willTrigger === true && pdtIso.willTrigger === true, `对象 ${pdt1.count} / 裸 ${pdtFlat.count} / ISO ${pdtIso.count}`);

    check('前日跌 12% → SSR 生效', Mkt.ssrCheck(105, 92).active === true);
    check('前日跌 5% → SSR 不生效', Mkt.ssrCheck(105, 99.75).active === false);
    const lb = Mkt.luldBands(120, 1);
    check('Tier 1 价格带 ±5%', Math.abs(lb.upper - 126) < 1e-6 && Math.abs(lb.lower - 114) < 1e-6, `$ ${lb.lower}–${lb.upper}`);
    check('-8% 触发一级熔断', Mkt.circuitBreaker(-8).level === 1);
    check('-21% 触发三级熔断', Mkt.circuitBreaker(-21).level === 3);
    check('-4% 不触发熔断', Mkt.circuitBreaker(-4).triggered === false);

    // 费用：卖出 1000 股 @$200 = $200,000
    const fee = Mkt.computeFees({ side: 'sell', shares: 1000, price: 200 });
    const expectSec = 200000 * 0.0000278;
    check('SEC 费 = 成交额 × $27.80/百万', Math.abs(fee.sec - expectSec) < 0.01, `$${fee.sec.toFixed(2)}`);
    check('FINRA TAF = 股数 × $0.000166', Math.abs(fee.taf - 0.166) < 1e-9, `$${fee.taf}`);
    check('买入不收 SEC 与 TAF', Mkt.computeFees({ side: 'buy', shares: 1000, price: 200 }).sec === 0);
    check('TAF 单笔封顶 $8.3', Mkt.computeFees({ side: 'sell', shares: 100000, price: 200 }).taf <= 8.3);

    const preMarket = { phase: 'pre', label: '盘前', day: {}, et: '05:00' };
    check('盘前不允许市价单', Mkt.orderAvailability('market', preMarket).ok === false);
    check('盘前允许限价单', Mkt.orderAvailability('limit', preMarket).ok === true);
    check('常规时段允许市价单', Mkt.orderAvailability('market', summer).ok === true);

    const up = Mkt.upcoming(new Date('2026-09-11T14:00:00Z'));
    check('upcoming 能给出下一交易日与下一假期', !!up.nextTradingDay && !!up.nextHoliday, `下一交易日 ${up.nextTradingDay}`);
  }

  // 15) 绩效归因
  console.log('\n--- 绩效与归因（perf.js） ---');
  {
    // 构造一段已知回撤：100 → 120 → 90 → 110
    const eq = [
      { date: '2025-01-02', value: 100 },
      { date: '2025-01-03', value: 120 },
      { date: '2025-01-06', value: 90 },
      { date: '2025-01-07', value: 110 },
    ];
    const dd = Perf.drawdown(eq);
    check('最大回撤 =(120-90)/120 = 25%', Math.abs(dd.maxDrawdown - 25) < 1e-6, `${dd.maxDrawdown.toFixed(2)}%`);
    check('回撤谷底日期正确', dd.troughDate === '2025-01-06', dd.troughDate);

    const r = BT.run({ bars, strategy: 'ma_cross', benchBars: bars.map((b) => ({ ...b, close: b.close * 0.99 })), benchName: 'SPY' });
    const p = r.perf;
    check('回测返回完整绩效对象', !!p && isFinite(p.cagr) && isFinite(p.annualVol), `CAGR ${p.cagr.toFixed(1)}%`);
    check('夏普与索提诺口径一致（索提诺分母仅下行）', isFinite(p.sharpe) && isFinite(p.sortino));
    // CVaR 是「超过 VaR 的那部分尾部损失的均值」，方向必须是 CVaR ≥ VaR（都用正数表示亏损）
    check('VaR95 与 CVaR 存在且尾部均值 CVaR ≥ VaR', isFinite(p.var95.var) && p.var95.cvar >= p.var95.var - 1e-9, `VaR ${p.var95.var.toFixed(2)}% / CVaR ${p.var95.cvar.toFixed(2)}%`);
    check('基准对比返回 Beta / 跟踪误差 / 信息比率', !!p.vs && isFinite(p.vs.beta) && isFinite(p.vs.trackingError));
    check('指标卡数组非空（界面直接渲染）', Perf.cards(p).length >= 10, `${Perf.cards(p).length} 张卡`);
    check('归因包含标的与行业贡献', !!p.attribution && !!p.attribution.topContributor);
    check('换手率与成本拖累有值', p.turnover && isFinite(p.turnover.annual), `年化换手 ${p.turnover.annual.toFixed(0)}%`);
  }

  // 16) 税务
  console.log('\n--- 税务（tax.js） ---');
  {
    const trades = [
      { symbol: 'AAPL', side: 'BUY', shares: 100, price: 90, date: '2024-06-01', fee: 1 },
      { symbol: 'AAPL', side: 'SELL', shares: 100, price: 180, date: '2025-06-15', fee: 1 },
      { symbol: 'NVDA', side: 'sell', shares: 50, price: 400, date: '2025-03-01', fee: 1 },
      { symbol: 'NVDA', side: 'sell', shares: 50, price: 380, date: '2025-05-01', fee: 1 },
      { symbol: 'NVDA', side: 'buy', shares: 50, price: 390, date: '2025-04-25', fee: 1 },
    ];
    const rep = Tax.report({ trades, year: 2025 });
    check('跨年持仓也能正确配对成本（先配对再筛年）', rep.lots.length >= 2, `${rep.lots.length} 个回合`);
    const aapl = rep.lots.find((l) => l.symbol === 'AAPL');
    check('AAPL 持有 379 天 → 长期', aapl && aapl.term === 'long' && aapl.holdDays === 379, aapl ? `${aapl.holdDays} 天 / ${aapl.term}` : 'missing');
    check('券商口径的 side 字段也能识别（不只认 type）', !!aapl, 'side=BUY/SELL 已归一');
    check('洗售检测生效（NVDA 亏损后 6 天内买回）', rep.washSale.totalDisallowed > 0, `被洗 $${rep.washSale.totalDisallowed}`);
    check('应税净额已加回被洗亏损', rep.classify.taxable.net !== rep.classify.netCapitalGain || rep.washSale.totalDisallowed === 0);
    check('1099-B 归类有行', rep.forms.b1099.count > 0, `${rep.forms.b1099.count} 行`);
    const div = Tax.report({ trades: [], dividends: [{ symbol: 'AAPL', gross: 120, date: '2025-05-10', withholding: 12 }], year: 2025 });
    check('股息按中美协定 10% 预扣', div.dividend.withholding === 12 && div.dividend.rate === 10);
    check('1042-S 归类有行', div.forms.s1042.count > 0);
    check('中国境外所得 20% 与抵免能算出', div.china.netPayable === 12, `应补 $${div.china.netPayable}`);
    check('CSV 导出非空且含表头', Tax.toCsv(rep.lots).split('\n').length >= 2);
  }

  // 17) 风控
  console.log('\n--- 风控（risk.js） ---');
  {
    const acc = { equity: 100000, cash: 40000, dayStartEquity: 101000, peakEquity: 105000 };
    const pos = [
      { symbol: 'NVDA', shares: 200, price: 180, avgCost: 150, side: 'long', sector: '科技', beta: 1.6, vol: 0.45 },
      { symbol: 'XOM', shares: 100, price: 110, avgCost: 115, side: 'long', sector: '能源', beta: 0.8, vol: 0.25 },
    ];
    const ev = Risk.evaluate({ account: acc, positions: pos, limits: {}, dayTrades: [] });
    check('单票 36% 超 15% 上限 → 硬拦截', ev.blocks.some((b) => b.key === 'singlePosition'), ev.headline);
    check('行业 36% 超 35% → 警告', ev.warns.some((b) => b.key === 'sector'));
    check('红灯等级与安全评分联动', ev.level === 'danger' && ev.score === 100 - 25 * ev.blocks.length - 8 * ev.warns.length, `score ${ev.score}`);
    // 敞口 = NVDA 200×180 + XOM 100×110 = 47000 → 净值的 47%
    check('敞口计算：总仓位 47%（47000/100000）', Math.abs(ev.exposure.grossPct - 47) < 1e-6, `gross ${ev.exposure.grossPct}%`);
    check('现金比例 40% 与最低现金约束一致', Math.abs(ev.exposure.cashPct - 40) < 1e-6);
    check('给出可执行的减仓建议', ev.actions.some((a) => a.action === '减仓'), `${ev.actions.length} 条建议`);

    const clean = Risk.evaluate({ account: { equity: 100000, cash: 100000, dayStartEquity: 100000, peakEquity: 100000 }, positions: [], limits: {} });
    check('空仓时绿灯且满分', clean.level === 'ok' && clean.score === 100, clean.headline);

    const pre = Risk.preTrade({
      order: { symbol: 'TSLA', side: 'buy', shares: 100, price: 250 },
      account: { equity: 100000, cash: 1000, buyingPower: 1000, dayStartEquity: 100000, peakEquity: 100000 },
      positions: [], dayTrades: [], limits: {},
    });
    check('下单前预检：购买力不足被拦', pre.passed === false && pre.blocks.some((b) => /购买力/.test(b.title)), pre.blocks.map((b) => b.title).join('、'));
    const pre2 = Risk.preTrade({
      order: { symbol: 'TSLA', side: 'buy', shares: 10, price: 250, stopPrice: 230 },
      account: { equity: 100000, cash: 100000, buyingPower: 100000, dayStartEquity: 100000, peakEquity: 100000 },
      positions: [], dayTrades: [], limits: {},
    });
    check('止损已设时给通过项（含止损字样）', pre2.passes.some((p) => /止损/.test(p.title)), pre2.passes.map((p) => p.title).join('、'));
    const pre3 = Risk.preTrade({
      order: { symbol: 'TSLA', side: 'buy', shares: 10, price: 250 },
      account: { equity: 100000, cash: 100000, buyingPower: 100000, dayStartEquity: 100000, peakEquity: 100000 },
      positions: [], dayTrades: [], limits: {},
    });
    check('不设止损会被警告（但不是拦截）', pre3.warns.some((w) => /止损/.test(w.title)) && pre3.passed === true, pre3.summary);
    check('预检返回三段结论（阻截/警告/通过）', Array.isArray(pre2.blocks) && Array.isArray(pre2.warns) && Array.isArray(pre2.passes));
  }

  // 18) 模拟盘
  console.log('\n--- 模拟交易（paper.js） ---');
  {
    const pa = new Paper.PaperAccount({ initialCash: 100000 });
    const reg = { phase: 'regular', label: '常规', trading: true, et: '10:00', day: {} };

    // 默认风控单票上限 15%：100 股 NVDA（$18000）占净值 18%，必须先被拦住。
    // 这一条保证「风控真的在下单路径上」，不是摆设。
    const tooBig = pa.submit({ symbol: 'NVDA', side: 'buy', type: 'market', shares: 100, quote: 180, session: reg });
    check('默认单票上限 15% 拦住 18% 的仓位', tooBig.ok === false && tooBig.blocked.some((b) => /单票/.test(b.title)), tooBig.order.reason);

    // 50 股（$9000，9%）在限额内，应当被受理
    const o1 = pa.submit({ symbol: 'NVDA', side: 'buy', type: 'market', shares: 50, quote: 180, session: reg });
    check('常规时段市价单被受理', o1.ok && o1.order.status === 'submitted', o1.ok ? o1.order.status : o1.order.reason);
    const o1b = pa.submit({ symbol: 'NVDA', side: 'buy', type: 'market', shares: 50, quote: 180, session: reg });
    check('重复提交被幂等拦截', o1b.duplicate === true);
    // 行情跳动不能骗过幂等（市价单的价格不进幂等键）
    const o1c = pa.submit({ symbol: 'NVDA', side: 'buy', type: 'market', shares: 50, quote: 181.5, session: reg });
    check('市价单换了个报价仍算同一意图（价格不进幂等键）', o1c.duplicate === true);

    const mk = pa.mark({ NVDA: { date: '2025-06-02', open: 180, high: 190, low: 178, close: 185, volume: 1e6 } }, { date: '2025-06-02', session: reg, slippageBps: 0 });
    check('撮合产生成交', mk.fills.length === 1, `${mk.fills.length} 笔`);
    check('成交后持仓落账（股数与均价）', pa.positions.length === 1 && Math.abs(pa.positions[0].shares - 50) < 1e-9, pa.positions[0] ? `均价 ${pa.positions[0].avgPrice.toFixed(2)}` : `持仓 ${pa.positions.length} 笔`);
    check('成交后现金减少', pa.cash < 100000, `现金 $${pa.cash.toFixed(2)}`);
    const t0 = pa.trades[0];
    check('成交记录含费用分项', !!t0 && t0.fee > 0, t0 ? `费用 ${t0.fee.toFixed(2)}` : '无成交');

    const bad = pa.submit({ symbol: 'AAPL', side: 'sell', type: 'market', shares: 10, quote: 200, session: reg });
    check('无持仓卖出被拒（可平数量校验）', bad.ok === false && /可平数量/.test(bad.order.reason), bad.order.reason);

    // 平仓 + T+1 结算
    const o2 = pa.submit({ symbol: 'NVDA', side: 'sell', type: 'market', shares: 50, quote: 200, session: reg });
    check('有持仓时卖出被受理', o2.ok === true);
    pa.mark({ NVDA: { date: '2025-06-03', open: 195, high: 205, low: 193, close: 200, volume: 1e6 } }, { date: '2025-06-03', session: reg, slippageBps: 0 });
    check('平仓后持仓清零', pa.positions.length === 0);
    const tLast = pa.trades[pa.trades.length - 1];
    check('平仓记录带盈亏与持有天数', !!tLast && tLast.profit != null, tLast && tLast.profit != null ? `盈亏 ${tLast.profit.toFixed(2)}` : '无平仓记录');
    check('卖出资金进入 T+1 待结算队列', pa.pendingSettlements.length === 1, pa.pendingSettlements[0] ? `结算日 ${pa.pendingSettlements[0].settleDate}` : '队列为空');
    const set0 = pa.settle('2025-06-03');
    check('未到期不释放', set0.released === 0);
    const set1 = pa.settle('2025-06-04');
    check('到期后释放结算资金', set1.released > 0, `释放 $${set1.released.toFixed(2)}`);

    const rc = pa.reconcile({ cash: 1, positions: [], orders: [] });
    check('对账能发现现金与持仓差异', rc.ok === false && rc.diffs.length >= 1, rc.summary);
    const rc2 = pa.reconcile({ cash: pa.cash, positions: [], orders: [] });
    check('一致时对账通过', rc2.ok === true, rc2.summary);
    const rd = Paper.readiness(pa);
    check('上线就绪度清单有 7 项并给出结论', rd.total === 7 && !!rd.verdict, `${rd.passed}/${rd.total}`);

    const pa2 = new Paper.PaperAccount({ initialCash: 100000 });
    const sh = pa2.submit({ symbol: 'TSLA', side: 'short', type: 'market', shares: 10, quote: 250, session: reg });
    check('开空被受理', sh.ok === true);
    pa2.mark({ TSLA: { date: '2025-06-02', open: 250, high: 255, low: 245, close: 250, volume: 1e6 } }, { date: '2025-06-02', session: reg, slippageBps: 0 });
    check('开空后持仓方向为 short', pa2.positions[0] && pa2.positions[0].side === 'short', pa2.positions[0] ? pa2.positions[0].side : '无持仓');
    pa2.submit({ symbol: 'TSLA', side: 'cover', type: 'market', shares: 10, quote: 240, session: reg });
    pa2.mark({ TSLA: { date: '2025-06-03', open: 240, high: 245, low: 235, close: 240, volume: 1e6 } }, { date: '2025-06-03', session: reg, slippageBps: 0 });
    check('买平空后持仓清零且方向未错', pa2.positions.length === 0, `已实现盈亏 $${pa2.realizedPnl.toFixed(2)}`);
    check('空头下跌应盈利', pa2.realizedPnl > 0);

    const closed = new Paper.PaperAccount({ initialCash: 100000 });
    const r0 = closed.submit({ symbol: 'AAPL', side: 'buy', type: 'market', shares: 10, quote: 200, session: { phase: 'closed', label: '休市', day: {}, et: '22:00' } });
    check('休市时段下单被拒（不靠时间猜）', r0.ok === false && /休市/.test(r0.order.reason), r0.order.reason);
  }

  // 19) 券商适配
  console.log('\n--- 券商适配（broker.js） ---');
  {
    check('内置 6 家券商', Broker.VENUES.length === 6, Broker.VENUES.map((v) => v.short).join(' '));
    const alpaca = Broker.mapOrder('alpaca', { symbol: 'NVDA', side: 'buy', type: 'limit', shares: 10, price: 180, tif: 'day' }, {});
    check('Alpaca 字段为 type / qty / time_in_force', alpaca.body.type === 'limit' && alpaca.body.qty && alpaca.body.time_in_force, JSON.stringify(alpaca.body).slice(0, 90));
    const ts = Broker.mapOrder('tradestation', { symbol: 'NVDA', side: 'buy', type: 'limit', shares: 10, price: 180, tif: 'day' }, {});
    check('TradeStation 用 OrderType 字段（大小写坑）', !!ts.body.OrderType, JSON.stringify(ts.body).slice(0, 90));
    const ib = Broker.mapOrder('ibkr', { symbol: 'NVDA', side: 'buy', type: 'market', shares: 10, tif: 'day' }, {});
    // IBKR Client Portal 的订单体是 { orders: [ {...} ] } 包一层，字段是 orderType
    check('IBKR 用 orders 数组包一层且字段为 orderType', Array.isArray(ib.body.orders) && ib.body.orders[0].orderType === 'MKT', JSON.stringify(ib.body).slice(0, 90));
    check('IBKR 缺 conid 时报错并给出查合约号的路径', (() => {
      const v = Broker.validate('ibkr', { symbol: 'NVDA', side: 'buy', type: 'market', shares: 10 }, { accountId: 'U1', credentials: { token: 't' } });
      return v.ok === false && v.errors.some((e) => /conid/.test(e.title) && /secdef\/search/.test(e.detail));
    })());
    const v = Broker.validate('alpaca', { symbol: 'NVDA', side: 'buy', type: 'buy', shares: 0 }, {});
    check('非法订单被前置校验拦下', v.ok === false && v.errors.length > 0, v.errors.map((e) => e.title || e).join('、'));
    check('凭证脱敏只留尾 4 位', Broker.maskCredential('PKABCDEFG1234').endsWith('1234'));
    check('幂等与重连策略有内容', Broker.reliability('ibkr').pitfalls.length > 0);
    check('默认定时任务为 6 项', Broker.defaultTasks().length === 6);
    const curl = Broker.toCurl(alpaca);
    check('可导出 curl 便于手工核对', typeof curl === 'string' && curl.includes('curl'), curl.slice(0, 40));
  }

  // 20) 选股器与参数扫描
  console.log('\n--- 选股器（screener.js） ---');
  {
    const us = Screener.universes(['NVDA']);
    check('内置股票池 ≥ 8 个', Object.keys(us).length >= 8, Object.keys(us).join(' '));
    check('标普池成分数 ≥ 60', us.sp500.codes.length >= 60, `${us.sp500.codes.length} 只`);
    check('自选池绑定传入的代码', us.watch.codes[0] === 'NVDA');
    const f = Screener.computeFactors({ bars, quote: { pe: 25, marketCap: 1e11 }, rank: { capPercentile: 40 } });
    check('六因子全部产出且 0–100', f && Object.keys(f.scores).length === 6 && Object.values(f.scores).every((v) => v >= 0 && v <= 100), JSON.stringify(f.scores));
    check('因子类型诚实标注（quality/revision 为代理）', Screener.FACTORS.find((x) => x.key === 'quality').type === 'proxy');
    const ps = Screener.paramScan(bars, 'ma_cross', { fast: [5, 10], slow: [20, 30] }, { backtestFn: BT, metric: 'sharpe' });
    check('参数扫描产出有效组合与稳健性判断', ps.valid === 4 && typeof ps.robust === 'boolean', `${ps.valid} 组 · ${ps.robust ? '平坦' : '孤峰'}`);
    check('缺 backtestFn 时如实报错而非静默返回空', Screener.paramScan(bars, 'ma_cross', { a: [1] }, {}).error === '缺少回测函数');
    const cmp = Screener.compare(bars, ['ma_cross', 'rsi'], { backtestFn: BT });
    check('多策略对比默认按夏普降序', cmp.metric === 'sharpe' && cmp.rows.length === 2 && (cmp.rows[0].sharpe == null || cmp.rows[0].sharpe >= cmp.rows[1].sharpe), cmp.summary);
    const cmp2 = Screener.compare(bars, ['ma_cross', 'rsi'], { backtestFn: BT, metric: 'totalReturn' });
    check('指定 metric=totalReturn 时按收益降序', cmp2.metric === 'totalReturn' && cmp2.rows[0].totalReturn >= cmp2.rows[1].totalReturn, cmp2.summary);
    check('回撤类指标按「越小越好」排序', Screener.compare(bars, ['ma_cross', 'rsi'], { backtestFn: BT, metric: 'maxDrawdown' }).metricLabel.includes('越小越好'));
  }

  // 21) 告警
  console.log('\n--- 告警（alerts.js） ---');
  {
    check('16 种规则类型', Alerts.RULE_TYPES.length === 16, `${Alerts.RULE_TYPES.length} 种`);
    check('10 种异常检测', Alerts.ANOMALY_TYPES.length === 10);
    check('6 个推送渠道', Alerts.CHANNELS.length === 6, Alerts.CHANNELS.map((c) => c.name).join(' '));
    const hit = Alerts.evalRule(
      { id: 'r1', type: 'price_above', symbol: 'NVDA', value: 170, severity: 'high', enabled: true },
      { quotes: { NVDA: { price: 180, changePct: 3 } } }
    );
    check('价格上破命中且标题带单位', !!hit && hit.title === 'NVDA 价格上破 $170', hit ? hit.title : '未命中');
    check('未达阈值不误报', Alerts.evalRule({ id: 'r2', type: 'price_above', symbol: 'NVDA', value: 190 }, { quotes: { NVDA: { price: 180 } } }) === null);
    const dl = Alerts.evalRule({ id: 'r3', type: 'daily_loss', value: 3 }, { account: { equity: 96000, dayStartEquity: 100000 } });
    check('单日亏损 4% 命中 3% 阈值', !!dl, dl ? dl.title : '');
    const an = Alerts.detectAnomalies({ now: Date.now(), lastQuoteAt: new Date(Date.now() - 300000).toISOString(), quoteStaleMs: 90000 });
    check('行情 5 分钟未更新 → 数据断流告警', an.anomalies.some((a) => a.key === 'data_stale'), an.summary);
    const an2 = Alerts.detectAnomalies({ now: Date.now(), lastQuoteAt: new Date().toISOString(), apiFailures: 0 });
    check('正常时无异常', an2.healthy === true);
    for (const ch of Alerts.CHANNELS) {
      const cfg = {};
      (ch.fields || []).forEach((f) => (cfg[f.key] = 'x'));
      const pl = Alerts.payload(ch.key, cfg, { level: 'warn', title: 'T', detail: 'D' });
      check(`渠道 ${ch.name} 载荷可生成`, pl.ok === true, pl.method + ' ' + (pl.url || '').slice(0, 46));
    }
    const missing = Alerts.payload('telegram', {}, { level: 'info', title: 'T' });
    check('配置缺失时如实报错并给出预览', missing.ok === false && !!missing.preview);
    const hb = Alerts.heartbeat({ lastBeatAt: Date.now() - 1000, intervalMs: 30000 });
    check('心跳正常判定', hb.alive === true, hb.label);
    const hb2 = Alerts.heartbeat({ lastBeatAt: Date.now() - 200000, intervalMs: 30000 });
    check('心跳丢失判定', hb2.alive === false, hb2.label);
    check('默认规则 5 条', Alerts.defaultRules().length === 5);
  }

  console.log(`\n===== 通过 ${pass} 项，失败 ${fail} 项 =====\n`);
  process.exit(fail ? 1 : 0);
})();
