/**
 * main-smoke.js —— 主进程无头自检（不开 GUI）
 *
 * 模拟 main.js 的核心流程：加载 datasource、跑一次 scan 与回测，
 * 验证主进程上下文下 require('electron') 正常、数据层与算法层协作无误。
 */
const electron = require('electron');
const { app } = electron;

const path = require('path');
const os = require('os');
const ds = require('../src/main/datasource');
const { Store } = require('../src/main/store');
const Factors = require('../src/shared/factors');
const Backtest = require('../src/shared/backtest');
const { POOL } = require('../src/main/pool');

ds.initCache(path.join(os.tmpdir(), 'quantdesk-mainsmoke'));

function ok(n, c, e) {
  console.log(`${c ? '✅' : '❌'} ${n}${e ? '  ' + e : ''}`);
}

app.whenReady().then(async () => {
  console.log('Electron 主进程 ready，versions=' + JSON.stringify({
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
  }));

  // 数据层
  try {
    const q = await ds.quoteOne('105.NVDA');
    ok('主进程下 NVDA 行情', !!q && q.price > 0, `${q.name} $${q.price} src=${q.src}`);
  } catch (e) {
    ok('主进程下 NVDA 行情', false, e.message);
  }

  try {
    const k = await ds.kline('105.NVDA', { period: 'day', limit: 200 });
    ok('主进程下 NVDA K线', !!k && k.bars.length > 100, `${k.bars.length} 根 src=${k.src}`);
    const a = Factors.analyze(k.bars, null);
    ok('主进程下因子分析', !!a, `评分 ${a.score} 信号 ${a.signals.length}个`);
    const bt = Backtest.run({ bars: k.bars, strategy: 'ma_cross', initialCapital: 100000, commission: 0.0005, slippage: 0.0005 });
    ok('主进程下回测', !bt.error, `收益 ${bt.totalReturn?.toFixed(2)}% 回撤 ${bt.maxDrawdown?.toFixed(2)}%`);
  } catch (e) {
    ok('主进程下 K线/算法', false, e.message);
  }

  // 持久化
  try {
    const tmpFile = path.join(os.tmpdir(), 'quantdesk-store-smoke.json');
    const s1 = new Store(tmpFile);
    s1.set('watchlist', [{ secid: '105.NVDA', code: 'NVDA', name: '英伟达' }]);
    const s2 = new Store(tmpFile);
    const wl = s2.get('watchlist');
    ok('Store 持久化', Array.isArray(wl) && wl[0].code === 'NVDA', `${wl.length} 项`);
  } catch (e) {
    ok('Store', false, e.message);
  }

  // 内置池
  ok('POOL 加载', POOL.length > 100, `${POOL.length} 只股票`);

  console.log('\n==> 主进程自检完成');
  app.exit(0);
});