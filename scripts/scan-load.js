/**
 * scan-load.js —— 大批量扫描压测（不依赖 Electron）
 *
 * 目的：验证 50~1000 档位在实际网络下的耗时与成功率，避免把「能跑通」当成「能用」。
 * 与主进程 runScan 使用同一套 throttle 规则与降级路径。
 *
 * 用法: node scripts/scan-load.js 300
 */
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ds = require(path.join(ROOT, 'src/main/datasource'));

const N = Math.max(10, Math.min(1200, Number(process.argv[2]) || 300));

/** 与 main.js 的 scanThrottle 保持一致（改一处就要改两处，这里刻意复制以便独立压测） */
function throttle(limit) {
  if (limit <= 150) return { concurrency: 3, minInterval: 180 };
  if (limit <= 300) return { concurrency: 5, minInterval: 130 };
  if (limit <= 600) return { concurrency: 6, minInterval: 100 };
  return { concurrency: 8, minInterval: 80 };
}

(async () => {
  ds.initCache(path.join(os.tmpdir(), 'quantdesk-scanload-cache'));
  const t0 = Date.now();

  const r = await ds.rankAll({ total: Math.min(1200, N + 40) });
  const tRank = Date.now() - t0;
  const cand = r.rows.filter((x) => (x.price || 0) >= 3).slice(0, N);
  console.log(`候选 ${cand.length} 只（分页拉取耗时 ${(tRank / 1000).toFixed(1)}s，${r.pages} 页）`);

  const th = throttle(cand.length);
  const restore = ds.setThrottle(th);
  console.log(`并发 ${th.concurrency} · 请求间隔 ${th.minInterval}ms`);

  const t1 = Date.now();
  let ok = 0;
  let fail = 0;
  let done = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < cand.length) {
      const t = cand[cursor++];
      try {
        let k = await ds.kline(t.secid, { period: 'day', limit: 260, fq: 1 });
        if (!k || !k.bars || k.bars.length < 60) {
          const k2 = await ds.kline(`106.${t.code}`, { period: 'day', limit: 260, fq: 1 }).catch(() => null);
          if (k2 && k2.bars && k2.bars.length >= 60) k = k2;
        }
        if (k && k.bars && k.bars.length >= 60) ok++;
        else fail++;
      } catch {
        fail++;
      }
      done++;
      if (done % 25 === 0 || done === cand.length) {
        const el = Date.now() - t1;
        const eta = (el / done) * (cand.length - done);
        process.stderr.write(`\r  ${done}/${cand.length}  已用 ${(el / 1000).toFixed(0)}s  预计剩余 ${(eta / 1000).toFixed(0)}s   `);
      }
    }
  };
  await Promise.all(Array.from({ length: th.concurrency }, worker));
  process.stderr.write('\n');
  restore();

  const el = Date.now() - t1;
  console.log(`K 线抓取：成功 ${ok} / 失败 ${fail}，耗时 ${(el / 1000).toFixed(1)}s，平均 ${(el / cand.length).toFixed(0)}ms/只`);
  console.log(`总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('数据源健康度:', JSON.stringify(ds.activeSource().health));
})().catch((e) => {
  console.error('压测失败：', e && e.stack ? e.stack : e);
  process.exit(1);
});
