#!/usr/bin/env node
/**
 * radar-report.js —— 把多次「机会雷达」扫描结果汇总成一份可读报告
 *
 * 为什么单独做汇总而不是在界面上看：
 *   · 界面是「一次扫一个池子」，而机会是全市场比较出来的，需要跨池去重与排序；
 *   · 报告要能把「风险点/机会点/新闻/事件」四类信息按标的对齐，
 *     这是复核时最需要的视角（而不是按模块分开看）。
 *
 * 用法:
 *   node scripts/radar-report.js --in=/tmp/r1.json,/tmp/r2.json --out=build/report/radar.html
 *   node scripts/radar-report.js --in-dir=/tmp --glob=radar- --md
 */
const fs = require('fs');
const path = require('path');

const args = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) args[m[1]] = m[2] === undefined ? true : m[2];
}

const ROOT = path.join(__dirname, '..');
const OUT = args.out || path.join(ROOT, 'build', 'report', 'radar-report.html');
const WANT_MD = !!args.md;

// ---------------------------------------------------------------- 载入

function loadInputs() {
  let files = [];
  if (args.in) files = String(args.in).split(',').map((s) => s.trim()).filter(Boolean);
  else {
    const dir = args['in-dir'] || '/tmp';
    const glob = args.glob || 'radar-';
    files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(glob) && f.endsWith('.json'))
      .filter((f) => !/test|dbg/.test(f))
      .map((f) => path.join(dir, f));
  }
  const scans = [];
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (j && Array.isArray(j.rows)) scans.push({ file: f, data: j });
    } catch (e) {
      console.error(`跳过 ${f}：${e.message}`);
    }
  }
  return scans;
}

const scans = loadInputs();
if (!scans.length) {
  console.error('❌ 没有可用的输入（用 --in=a.json,b.json 或 --in-dir=/tmp）');
  process.exit(1);
}

// ---------------------------------------------------------------- 合并

/** 同一标的可能被多个池子扫到：保留「暴涨潜力分更高」的那一份，并记录所有池子 */
const bySymbol = new Map();
for (const s of scans) {
  for (const r of s.data.rows) {
    const k = String(r.symbol || '').toUpperCase();
    if (!k) continue;
    const prev = bySymbol.get(k);
    const score = r.moonshot ? r.moonshot.score : 0;
    const prevScore = prev && prev.moonshot ? prev.moonshot.score : -1;
    if (!prev) {
      bySymbol.set(k, { ...r, _pools: [s.data.universe], _files: [s.file] });
    } else {
      prev._pools = [...new Set([...prev._pools, s.data.universe])];
      prev._files = [...new Set([...prev._files, s.file])];
      // 新闻/事件/增强数据取并集（不同池子扫描时 extrasTop 覆盖不同标的）
      if (!prev.shortInterest && r.shortInterest) prev.shortInterest = r.shortInterest;
      if (!prev.analyst && r.analyst) prev.analyst = r.analyst;
      if ((!prev.news || !prev.news.length) && r.news && r.news.length) {
        prev.news = r.news;
        prev.newsSummary = r.newsSummary;
      }
      if (score > prevScore) {
        const pools = prev._pools;
        const files = prev._files;
        bySymbol.set(k, { ...r, _pools: pools, _files: files });
      }
    }
  }
}
const rows = [...bySymbol.values()];
rows.sort((a, b) => (b.moonshot ? b.moonshot.score : 0) - (a.moonshot ? a.moonshot.score : 0));

// 基准：取第一个有基准的扫描
const bench = (scans.find((s) => s.data.benchmark) || {}).data?.benchmark || null;
// 市场事件：合并去重
const evMap = new Map();
for (const s of scans) {
  for (const e of s.data.marketEvents || []) evMap.set(`${e.date}|${e.event}`, e);
}
const marketEvents = [...evMap.values()].sort((a, b) => a.daysAway - b.daysAway);
const companyEvents = [];
const ceSeen = new Set();
for (const s of scans) {
  for (const e of s.data.events || []) {
    if (e.scope !== 'company') continue;
    const k = `${e.symbol}|${e.date}|${e.event}`;
    if (ceSeen.has(k)) continue;
    ceSeen.add(k);
    companyEvents.push(e);
  }
}
companyEvents.sort((a, b) => a.daysAway - b.daysAway);

// 汇总风险/机会点（按类型聚合）
function tally(kind) {
  const map = new Map();
  for (const r of rows) {
    const list = (r.insight && r.insight[kind]) || [];
    for (const it of list) {
      const key = it.key || it.label;
      if (!map.has(key)) map.set(key, { key, label: it.label, desc: it.desc, items: [] });
      map.get(key).items.push({ symbol: r.symbol, name: r.name, value: kind === 'opportunities' ? it.strength : it.severity, evidence: it.evidence });
    }
  }
  const out = [...map.values()];
  out.sort((a, b) => b.items.length - a.items.length || Math.max(...b.items.map((x) => x.value)) - Math.max(...a.items.map((x) => x.value)));
  for (const g of out) g.items.sort((a, b) => b.value - a.value);
  return out;
}
const oppGroups = tally('opportunities');
const riskGroups = tally('risks');

// 新闻汇总（按标的）
const newsRows = rows.filter((r) => (r.news || []).length).map((r) => ({
  symbol: r.symbol, name: r.name,
  summary: r.newsSummary,
  items: r.news.slice().sort((a, b) => Math.abs(b.senti) - Math.abs(a.senti)),
}));
newsRows.sort((a, b) => Math.abs((b.summary || {}).sentiment || 0) - Math.abs((a.summary || {}).sentiment || 0));

// 机会股排名：暴涨潜力分与风险调整净分都要看
const opportunities = rows
  .filter((r) => r.moonshot && r.moonshot.grade !== 'D')
  .map((r) => ({
    ...r,
    _net: (r.insight && r.insight.scores && r.insight.scores.netAdjusted) || 0,
    _opp: (r.insight && r.insight.scores && r.insight.scores.opportunity) || 0,
    _rsk: (r.insight && r.insight.scores && r.insight.scores.risk) || 0,
  }))
  .sort((a, b) => {
    // 先用等级分档，再在同档内按风险调整净分排 —— 这样不会出现
    // 「净分很高的 C 级」压过「净分中等的 B 级」这种违反直觉的排序
    const ga = a.moonshot.score, gb = b.moonshot.score;
    if (Math.abs(ga - gb) > 3) return gb - ga;
    return b._net - a._net;
  });

const poolsScanned = [...new Set(scans.map((s) => s.data.universe))];
const totalScanned = scans.reduce((s, x) => s + (x.data.rows || []).length, 0);
const dist = { A: 0, B: 0, C: 0, D: 0 };
for (const r of rows) if (r.moonshot) dist[r.moonshot.grade]++;

// ---------------------------------------------------------------- HTML

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (v, d = 1) => (v == null || !Number.isFinite(Number(v)) ? '--' : Number(v).toFixed(d));
const pctS = (v) => (v == null || !Number.isFinite(Number(v)) ? '--' : (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%');
const clsUp = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
const fmtAmt = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '--';
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
  return '$' + n.toFixed(0);
};

const now = new Date();
const dataDate = bench ? bench.asOf : '--';

function gradeCell(g) {
  const map = { A: 'ga', B: 'gb', C: 'gc', D: 'gd' };
  return `<span class="grade ${map[g] || 'gc'}">${esc(g || '-')}</span>`;
}

function oppCards() {
  return opportunities.slice(0, 24).map((r) => {
    const m = r.moonshot || {};
    const ins = r.insight || {};
    const s = ins.scores || {};
    const dte = r.daysToEarnings;
    const si = r.shortInterest;
    const an = r.analyst;
    const news = (r.news || []).slice(0, 3);
    return `
    <article class="card">
      <header>
        <div class="hd-left">
          ${gradeCell(m.grade)}
          <span class="sym">${esc(r.symbol)}</span>
          <span class="nm">${esc(r.name || '')}</span>
          <span class="pools">${esc((r._pools || []).join(' / '))}</span>
        </div>
        <div class="hd-right">
          <span class="px">$${num(r.price, 2)}</span>
          <span class="${clsUp(r.changePct)}">${pctS(r.changePct)}</span>
        </div>
      </header>
      <div class="bars">
        ${[['弹性', 'elasticity'], ['压缩', 'compression'], ['量能', 'volume'], ['动量', 'momentum'], ['位置', 'position'], ['相对强度', 'relativeStrength'], ['空头燃料', 'shortFuel'], ['催化', 'catalyst'], ['流通盘', 'float']]
          .map(([label, k]) => {
            const v = Math.round((m.parts || {})[k] || 0);
            const lv = v >= 80 ? 'l5' : v >= 65 ? 'l4' : v >= 50 ? 'l3' : v >= 35 ? 'l2' : 'l1';
            return `<div class="bar" title="${label} ${v}"><span class="bl">${label}</span><span class="bt"><i class="${lv}" style="width:${v}%"></i></span><span class="bv">${v}</span></div>`;
          })
          .join('')}
      </div>
      <div class="scores">
        <span class="sc"><i>潜力分</i><b>${num(m.score)}</b></span>
        <span class="sc opp"><i>机会</i><b>${s.opportunity == null ? '--' : s.opportunity}</b></span>
        <span class="sc rsk"><i>风险</i><b>${s.risk == null ? '--' : s.risk}</b></span>
        <span class="sc net"><i>净分</i><b>${s.netAdjusted == null ? '--' : s.netAdjusted}</b></span>
        <span class="sc"><i>立场</i><b class="sm">${esc((ins.stance || {}).label || '--')}</b></span>
        <span class="sc"><i>因子综合</i><b>${r.factorComposite == null ? '--' : r.factorComposite}</b></span>
      </div>
      <div class="grid2">
        <div class="col">
          <h4 class="up-h">机会点（${(ins.opportunities || []).length}）</h4>
          <ul class="ev opp">${(ins.opportunities || []).slice(0, 5).map((o) => `<li><b>${esc(o.label)}</b><span>${o.strength}</span><em>${esc(o.evidence || '')}</em></li>`).join('') || '<li class="none">未触发</li>'}</ul>
        </div>
        <div class="col">
          <h4 class="dn-h">风险点（${(ins.risks || []).length}）</h4>
          <ul class="ev rsk">${(ins.risks || []).slice(0, 5).map((o) => `<li><b>${esc(o.label)}</b><span>${o.severity}</span><em>${esc(o.evidence || '')}</em></li>`).join('') || '<li class="none">未触发</li>'}</ul>
        </div>
      </div>
      <div class="trig">
        <div><b>触发条件</b>${(m.triggers || []).map((t) => `<span class="chip">${esc(t)}</span>`).join('') || '<span class="chip none">--</span>'}</div>
        <div><b>失效条件</b>${(m.invalidation || []).map((t) => `<span class="chip inv">${esc(t)}</span>`).join('') || '<span class="chip none">--</span>'}</div>
        ${(m.riskFlags || []).length ? `<div><b class="warn">风险标记</b>${m.riskFlags.map((t) => `<span class="chip warn">${esc(t)}</span>`).join('')}</div>` : ''}
        ${m.liquidityNote ? `<div><b class="warn">流动性</b><span class="chip warn">${esc(m.liquidityNote)}</span></div>` : ''}
      </div>
      <div class="extra">
        <span>距财报 <b>${dte ? dte.days + ' 天' : '--'}</b>${dte && dte.date ? `（${esc(dte.date)}${dte.time ? ' ' + esc(dte.time) : ''}${dte.epsForecast ? ' · 预期 EPS ' + esc(dte.epsForecast) : ''}）` : ''}</span>
        <span>空头回补 <b>${si && si.latest && si.latest.daysToCover != null ? si.latest.daysToCover.toFixed(2) + ' 天' : '--'}</b>${si ? `（${esc(si.latest.settlementDate)}，${si.trend === 'up' ? '上升' : si.trend === 'down' ? '下降' : '持平'}）` : ''}</span>
        <span>目标价 <b>${an && an.priceTarget ? '$' + an.priceTarget.toFixed(2) : '--'}</b>${an && an.buy != null ? `（${an.buy}买/${an.hold || 0}持/${an.sell || 0}卖）` : ''}</span>
        <span>日均成交额 <b>${fmtAmt((r.raw || {}).avgAmount)}</b></span>
      </div>
      ${news.length ? `<div class="news"><h4>相关新闻</h4>${news.map((n) => `<div class="ni"><span class="ns ${n.senti > 8 ? 'p' : n.senti < -8 ? 'n' : ''}">${n.senti > 0 ? '+' : ''}${n.senti}</span><span class="nt">${esc(n.title)}</span><span class="nd">${esc((n.date || '').slice(0, 10))}</span></div>`).join('')}</div>` : ''}
    </article>`;
  }).join('');
}

function groupTable(groups, kind) {
  return groups.slice(0, 24).map((g) => `
    <div class="grp">
      <div class="gh">
        <span class="gl">${esc(g.label)}</span>
        <span class="gc">${g.items.length} 只</span>
      </div>
      <div class="gd">${esc((g.desc || '').slice(0, 120))}</div>
      <div class="gi">${g.items.slice(0, 12).map((x) => `<span class="chip ${kind === 'opp' ? 'opp' : 'rsk'}">${esc(x.symbol)} <b>${x.value}</b></span>`).join('')}${g.items.length > 12 ? `<span class="chip more">+${g.items.length - 12}</span>` : ''}</div>
    </div>`).join('');
}

function eventRows(list) {
  return list.slice(0, 40).map((e) => {
    const k = e.kind || 'macro';
    return `<tr class="ev-${esc(k)}">
      <td class="mono">${esc(e.date)}</td>
      <td class="mono ${e.daysAway <= 3 ? 'soon' : ''}">${e.daysAway === 0 ? '今天' : e.daysAway + ' 天'}</td>
      <td>${e.symbol ? `<b>${esc(e.symbol)}</b> ` : ''}${esc(e.event || '')}</td>
      <td class="muted">${esc(e.time || '')} ${esc(e.source || '')}${e.estimated ? ' <span class="est">（估算）</span>' : ''}${e.epsForecast ? ' · 预期 EPS ' + esc(e.epsForecast) : ''}</td>
    </tr>`;
  }).join('');
}

const html = `<!DOCTYPE html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>QuantDesk 机会雷达报告 · ${esc(now.toISOString().slice(0, 10))}</title>
<style>
:root{
  --bg:#0a0a0c; --panel:rgba(28,28,32,.6); --card:rgba(255,255,255,.055); --raise:rgba(255,255,255,.1);
  --sunken:rgba(0,0,0,.24); --text:#f5f5f7; --t2:rgba(235,235,245,.72); --t3:rgba(235,235,245,.45); --t4:rgba(235,235,245,.26);
  --up:#ff453a; --down:#30d158; --orange:#ff9f0a; --blue:#0a84ff; --purple:#bf5af2; --yellow:#ffd60a;
  --sep:rgba(255,255,255,.075); --sep2:rgba(255,255,255,.13);
  --mono:"SF Mono",ui-monospace,Menlo,monospace;
  --sans:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Helvetica Neue",sans-serif;
}
[data-theme="light"]{
  --bg:#ececed; --panel:rgba(252,252,253,.75); --card:rgba(255,255,255,.8); --raise:#fff;
  --sunken:rgba(0,0,0,.05); --text:#1c1c1e; --t2:rgba(60,60,67,.78); --t3:rgba(60,60,67,.55); --t4:rgba(60,60,67,.34);
  --sep:rgba(0,0,0,.08); --sep2:rgba(0,0,0,.14);
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:var(--sans);font-size:13.5px;line-height:1.65;-webkit-font-smoothing:antialiased}
.wrap{max-width:1280px;margin:0 auto;padding:32px 24px 80px}
.mono{font-family:var(--mono);font-variant-numeric:tabular-nums}
.up{color:var(--up)}.down{color:var(--down)}.muted{color:var(--t4)}.soon{color:var(--orange);font-weight:600}
h1{font-size:26px;font-weight:700;letter-spacing:-.4px;margin-bottom:6px}
h2{font-size:16px;font-weight:600;margin:34px 0 14px;padding-bottom:9px;border-bottom:1px solid var(--sep);letter-spacing:-.2px}
h3{font-size:14px;font-weight:600;margin:0 0 8px}
.sub{color:var(--t3);font-size:12.5px;margin-bottom:20px}
.disclaimer{background:rgba(255,159,10,.1);border:1px solid rgba(255,159,10,.3);border-radius:12px;padding:14px 16px;font-size:12px;color:var(--t2);line-height:1.75;margin:16px 0 0}
.disclaimer b{color:var(--orange)}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:10px;margin:16px 0}
.kpi{background:var(--card);border-radius:12px;padding:11px 13px;border:1px solid var(--sep)}
.kpi .k{font-size:10.5px;color:var(--t4);margin-bottom:3px}
.kpi .v{font-family:var(--mono);font-size:15px;font-weight:600}
.kpi .v.sm{font-size:12.5px}
.summary{background:var(--panel);border:1px solid var(--sep);border-radius:14px;padding:16px 18px;margin-bottom:18px;font-size:13px;color:var(--t2);line-height:1.8}
.summary b{color:var(--text)}
.cards{display:flex;flex-direction:column;gap:16px}
.card{background:var(--panel);border:1px solid var(--sep);border-radius:16px;padding:16px 18px}
.card header{display:flex;justify-content:space-between;align-items:center;gap:12px;padding-bottom:12px;border-bottom:1px solid var(--sep);margin-bottom:13px;flex-wrap:wrap}
.hd-left{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.hd-right{display:flex;align-items:baseline;gap:10px;font-family:var(--mono)}
.sym{font-family:var(--mono);font-size:17px;font-weight:700;letter-spacing:-.3px}
.nm{color:var(--t2);font-size:12.5px}
.pools{font-size:10.5px;color:var(--t4);background:var(--sunken);padding:2px 8px;border-radius:99px}
.px{font-size:15px;font-weight:600}
.grade{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:6px;font-family:var(--mono);font-size:13px;font-weight:700}
.ga{background:rgba(255,69,58,.22);color:#ff8a94;border:1px solid rgba(255,69,58,.5)}
.gb{background:rgba(255,159,10,.2);color:#ffbf5c;border:1px solid rgba(255,159,10,.46)}
.gc{background:var(--card);color:var(--t3);border:1px solid var(--sep)}
.gd{background:var(--sunken);color:var(--t4);border:1px solid var(--sep)}
.bars{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:6px 14px;margin-bottom:13px}
.bar{display:flex;align-items:center;gap:7px;font-size:11px}
.bl{color:var(--t3);width:54px;flex:0 0 54px}
.bt{flex:1;height:6px;background:var(--sunken);border-radius:99px;overflow:hidden}
.bt i{display:block;height:100%;border-radius:99px}
.l5{background:var(--up)}.l4{background:var(--orange)}.l3{background:var(--yellow)}.l2{background:#6fbf4a}.l1{background:var(--down)}
.bv{font-family:var(--mono);color:var(--t3);width:22px;text-align:right;flex:0 0 22px}
.scores{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px}
.sc{display:flex;flex-direction:column;gap:1px;background:var(--sunken);border-radius:8px;padding:6px 11px;min-width:64px}
.sc i{font-size:10px;color:var(--t4);font-style:normal}
.sc b{font-family:var(--mono);font-size:14px;font-weight:700}
.sc b.sm{font-size:12px}
.sc.opp b{color:var(--up)}.sc.rsk b{color:var(--down)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media(max-width:860px){.grid2{grid-template-columns:1fr}}
h4{font-size:12px;font-weight:600;margin-bottom:7px}
.up-h{color:var(--up)}.dn-h{color:var(--down)}
ul.ev{list-style:none;display:flex;flex-direction:column;gap:5px}
ul.ev li{display:flex;align-items:baseline;gap:7px;font-size:11.5px;padding:5px 9px;border-radius:7px;background:var(--sunken);flex-wrap:wrap}
ul.ev li b{font-weight:600;color:var(--text)}
ul.ev li>span{font-family:var(--mono);font-size:11px;font-weight:600}
ul.ev.opp li>span{color:var(--up)}
ul.ev.rsk li>span{color:var(--down)}
ul.ev li em{font-style:normal;color:var(--t4);font-family:var(--mono);font-size:10.5px;flex:1 1 100%;word-break:break-all}
ul.ev li.none{color:var(--t4);font-size:11px}
.trig{margin-top:13px;display:flex;flex-direction:column;gap:6px;font-size:11.5px}
.trig>b{display:inline-block;width:58px;color:var(--t4);font-weight:400}
.trig b.warn{color:var(--orange)}
.chip{display:inline-block;font-size:11px;padding:3px 9px;border-radius:99px;background:var(--card);border:1px solid var(--sep);margin:0 5px 5px 0;color:var(--t2)}
.chip.opp{color:#ff8a94;border-color:rgba(255,69,58,.35)}
.chip.rsk{color:#5ee89a;border-color:rgba(48,209,88,.32)}
.chip.warn{color:var(--orange);border-color:rgba(255,159,10,.35)}
.chip.inv{color:var(--t3)}
.chip.none{color:var(--t4)}
.chip.more{color:var(--t4)}
.chip b{font-family:var(--mono)}
.extra{margin-top:11px;display:flex;flex-wrap:wrap;gap:6px 18px;font-size:11px;color:var(--t3);padding-top:11px;border-top:1px solid var(--sep)}
.extra b{color:var(--text);font-family:var(--mono)}
.news{margin-top:12px;padding-top:11px;border-top:1px solid var(--sep)}
.ni{display:flex;gap:9px;align-items:baseline;font-size:11.5px;padding:4px 0}
.ns{font-family:var(--mono);font-size:11px;font-weight:700;width:32px;flex:0 0 32px;text-align:right;color:var(--t4)}
.ns.p{color:var(--up)}.ns.n{color:var(--down)}
.nt{flex:1;color:var(--t2)}
.nd{font-family:var(--mono);font-size:10px;color:var(--t4)}
.grp{background:var(--card);border:1px solid var(--sep);border-radius:12px;padding:12px 14px;margin-bottom:10px}
.gh{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px}
.gl{font-size:13px;font-weight:600}
.gc{font-family:var(--mono);font-size:11px;color:var(--t4)}
.gd{font-size:11.5px;color:var(--t4);margin-bottom:8px;line-height:1.6}
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;font-size:10.5px;color:var(--t4);font-weight:500;padding:8px 10px;border-bottom:1px solid var(--sep2)}
td{padding:8px 10px;border-bottom:1px solid var(--sep)}
tr:hover td{background:rgba(10,132,255,.06)}
.est{color:var(--orange)}
.foot{margin-top:40px;padding-top:18px;border-top:1px solid var(--sep);font-size:11px;color:var(--t4);line-height:1.8}
.tools{position:fixed;right:22px;bottom:22px;display:flex;gap:8px}
.tools button{background:var(--panel);border:1px solid var(--sep2);color:var(--t2);border-radius:99px;padding:8px 15px;font-size:12px;cursor:pointer;font-family:inherit;backdrop-filter:blur(20px)}
.tools button:hover{background:var(--raise);color:var(--text)}
</style>
</head>
<body>
<div class="wrap">
  <h1>QuantDesk 机会雷达报告</h1>
  <div class="sub">生成于 ${esc(now.toLocaleString('zh-CN'))} · 行情截至 ${esc(dataDate)} · 扫描池：${esc(poolsScanned.join(' / '))} · 合计 ${rows.length} 只去重标的</div>

  <div class="disclaimer">
    <b>这份报告是什么：</b>把公开行情、成交量、新闻与官方事件日程按固定规则算成结构化结论，用于<b>缩小研究范围</b>。<br/>
    <b>它不是什么：</b>不是投资建议，也不是预测。「暴涨潜力分」衡量的是<b>弹性与形态特征</b>——高分意味着「如果它动，幅度会很大」，但方向未知，下跌同样被放大。<br/>
    新闻情绪为<b>关键词规则分</b>（非模型判断），反讽与否定句会被算错；事件日期可能被官方调整。每条结论都附了触发它的原始数值，请自行复核。
  </div>

  <div class="kpis">
    <div class="kpi"><div class="k">扫描池</div><div class="v sm">${esc(poolsScanned.join(' / '))}</div></div>
    <div class="kpi"><div class="k">去重标的</div><div class="v">${rows.length}</div></div>
    <div class="kpi"><div class="k">A / B 级</div><div class="v">${dist.A} / ${dist.B}</div></div>
    <div class="kpi"><div class="k">C / D 级</div><div class="v">${dist.C} / ${dist.D}</div></div>
    <div class="kpi"><div class="k">基准（${esc((bench || {}).code || '--')}）</div><div class="v sm ${clsUp((bench || {}).ret20)}">${pctS((bench || {}).ret20)}</div></div>
    <div class="kpi"><div class="k">基准 60 日</div><div class="v sm ${clsUp((bench || {}).ret60)}">${pctS((bench || {}).ret60)}</div></div>
    <div class="kpi"><div class="k">未来事件</div><div class="v">${marketEvents.length + companyEvents.length}</div></div>
    <div class="kpi"><div class="k">有新闻标的</div><div class="v">${newsRows.length}</div></div>
  </div>

  <div class="summary">
    <b>一句话结论：</b>在 ${rows.length} 只去重标的里，符合「高弹性 + 形态到位」的 A/B 级共 <b>${dist.A + dist.B}</b> 只，
    其中风险调整后净分为正的 <b>${opportunities.filter((r) => r._net > 0).length}</b> 只。
    机会强度最高的方向集中在 <b>${oppGroups.slice(0, 3).map((g) => g.label).join('、')}</b>；
    最普遍的风险是 <b>${riskGroups.slice(0, 3).map((g) => g.label).join('、')}</b>。
    ${marketEvents.length ? `最近的市场级事件是 <b>${esc(marketEvents[0].event)}</b>（${marketEvents[0].daysAway} 天后，${esc(marketEvents[0].source || '')}）。` : ''}
  </div>

  <h2>一、可能暴涨的机会股（Top ${Math.min(24, opportunities.length)}）</h2>
  <div class="sub">按等级分档 + 档内按风险调整净分排序。每张卡片都并列展示了触发条件、失效条件与风险标记 —— 缺一不可。</div>
  <div class="cards">${oppCards()}</div>

  <h2>二、机会点全景（按类型聚合）</h2>
  <div class="sub">同一类机会在多少只标的上出现，以及出现在哪些标的上。频次高的类型更能反映当前市场的结构性特征。</div>
  ${groupTable(oppGroups, 'opp')}

  <h2>三、风险点全景（按类型聚合）</h2>
  <div class="sub">风险同样按类型聚合。注意：出现频次高不代表该风险一定兑现，只说明这类特征在当前样本里很普遍。</div>
  ${groupTable(riskGroups, 'rsk')}

  <h2>四、新闻汇总（按标的）</h2>
  <div class="sub">只保留与该标的直接相关的报道（标题命中优先，正文命中按 0.7 折算）。情绪为关键词规则分。</div>
  ${newsRows.length ? newsRows.slice(0, 20).map((r) => `
    <div class="grp">
      <div class="gh"><span class="gl">${esc(r.symbol)} ${esc(r.name || '')}</span><span class="gc">情绪 ${esc(String((r.summary || {}).sentiment))}</span></div>
      <div class="gd">${esc((r.summary || {}).summary || '')}</div>
      ${r.items.slice(0, 8).map((n) => `<div class="ni"><span class="ns ${n.senti > 8 ? 'p' : n.senti < -8 ? 'n' : ''}">${n.senti > 0 ? '+' : ''}${n.senti}</span><span class="nt">${esc(n.title)}${n.sentiSentence ? `<br/><span class="muted" style="font-size:10.5px">命中句：${esc(n.sentiSentence.slice(0, 110))}</span>` : ''}</span><span class="nd">${esc((n.date || '').slice(0, 10))}</span></div>`).join('')}
    </div>`).join('') : '<div class="sub">未取到新闻数据。</div>'}

  <h2>五、未来事件日历</h2>
  <div class="sub">宏观日程来源 Federal Reserve / BLS / BEA / Census（官方已公布）；个股财报来自 nasdaq 排期；标注「估算」的是按惯例推算的日期。</div>
  <table>
    <thead><tr><th style="width:110px">日期</th><th style="width:80px">距今</th><th>事件</th><th>来源与细节</th></tr></thead>
    <tbody>${eventRows(marketEvents.concat(companyEvents))}</tbody>
  </table>

  <div class="foot">
    数据源：行情（东方财富 / 腾讯 / 新浪）、新闻（东方财富搜索）、财报日历与空头持仓、分析师目标价（nasdaq）。<br/>
    方法：多因子打分（16 因子，其中「质量」「盈利修正」为价格行为代理口径，已在界面标注）→ 暴涨潜力评分（9 维度加权）→ 风险/机会点规则引擎 → 新闻句子级情绪 → 事件风险评分。<br/>
    生成工具：QuantDesk v1.1.0 · scripts/radar-report.js<br/>
    本报告由本地计算生成，不含任何上传行为。
  </div>
</div>
<div class="tools">
  <button onclick="document.documentElement.setAttribute('data-theme', document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark')">切换主题</button>
  <button onclick="window.print()">打印 / 存 PDF</button>
</div>
</body>
</html>`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html);

// ---------------------------------------------------------------- Markdown

let mdPath = '';
if (WANT_MD) {
  mdPath = OUT.replace(/\.html$/, '.md');
  const L = [];
  L.push(`# QuantDesk 机会雷达报告`);
  L.push('');
  L.push(`生成于 ${now.toLocaleString('zh-CN')} · 行情截至 ${dataDate} · 扫描池 ${poolsScanned.join(' / ')} · 去重 ${rows.length} 只`);
  L.push('');
  L.push('> **这份报告是什么**：把公开行情、成交量、新闻与官方事件日程按固定规则算成结构化结论，用于缩小研究范围。');
  L.push('> **它不是什么**：不是投资建议，也不是预测。「暴涨潜力分」衡量的是弹性与形态特征 —— 高分意味着如果它动，幅度会很大，但方向未知。');
  L.push('');
  L.push(`## 关键数字`);
  L.push('');
  L.push(`| 指标 | 值 |`);
  L.push(`| --- | --- |`);
  L.push(`| 去重标的 | ${rows.length} |`);
  L.push(`| A / B / C / D 级 | ${dist.A} / ${dist.B} / ${dist.C} / ${dist.D} |`);
  L.push(`| 基准 ${(bench || {}).code || '--'} 20/60 日 | ${pctS((bench || {}).ret20)} / ${pctS((bench || {}).ret60)} |`);
  L.push(`| 未来事件数 | ${marketEvents.length + companyEvents.length} |`);
  L.push('');
  L.push(`## 一、可能暴涨的机会股`);
  L.push('');
  L.push('| 代码 | 名称 | 等级 | 潜力分 | 机会 | 风险 | 净分 | 立场 | 首要机会 | 首要风险 | 触发条件 | 失效条件 |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of opportunities.slice(0, 30)) {
    const m = r.moonshot || {};
    const ins = r.insight || {};
    const s = ins.scores || {};
    L.push(
      `| ${r.symbol} | ${r.name || ''} | ${m.grade} | ${num(m.score)} | ${s.opportunity} | ${s.risk} | ${s.netAdjusted} | ${(ins.stance || {}).label || ''} | ` +
      `${(ins.opportunities || [])[0] ? ins.opportunities[0].label : '--'} | ${(ins.risks || [])[0] ? ins.risks[0].label : '--'} | ` +
      `${(m.triggers || [])[0] || '--'} | ${(m.invalidation || [])[0] || '--'} |`
    );
  }
  L.push('');
  L.push(`## 二、机会点全景`);
  L.push('');
  for (const g of oppGroups.slice(0, 20)) {
    L.push(`- **${g.label}**（${g.items.length} 只）：${g.items.slice(0, 10).map((x) => x.symbol).join('、')}`);
  }
  L.push('');
  L.push(`## 三、风险点全景`);
  L.push('');
  for (const g of riskGroups.slice(0, 20)) {
    L.push(`- **${g.label}**（${g.items.length} 只）：${g.items.slice(0, 10).map((x) => x.symbol).join('、')}`);
  }
  L.push('');
  L.push(`## 四、未来事件日历`);
  L.push('');
  L.push('| 日期 | 距今 | 事件 | 来源 |');
  L.push('| --- | --- | --- | --- |');
  for (const e of marketEvents.concat(companyEvents).slice(0, 45)) {
    L.push(`| ${e.date} | ${e.daysAway} 天 | ${e.symbol ? e.symbol + ' ' : ''}${e.event} | ${e.source || ''}${e.estimated ? '（估算）' : ''} |`);
  }
  L.push('');
  L.push(`## 五、新闻汇总`);
  L.push('');
  for (const r of newsRows.slice(0, 15)) {
    L.push(`### ${r.symbol} ${r.name || ''}（情绪 ${(r.summary || {}).sentiment}）`);
    L.push('');
    L.push(`${(r.summary || {}).summary || ''}`);
    L.push('');
    for (const n of r.items.slice(0, 6)) L.push(`- [${n.senti > 0 ? '+' : ''}${n.senti}] ${n.title}（${(n.date || '').slice(0, 10)}）`);
    L.push('');
  }
  L.push('');
  L.push('---');
  L.push('');
  L.push('数据源：行情（东财/腾讯/新浪）、新闻（东财搜索）、财报日历与空头持仓、分析师目标价（nasdaq）。');
  L.push('');
  L.push('本报告由 QuantDesk v1.1.0 本地计算生成，不含任何上传行为。不构成投资建议。');
  fs.writeFileSync(mdPath, L.join('\n'));
}

console.log(`✅ 报告已生成：${OUT}${mdPath ? '\n✅ Markdown：' + mdPath : ''}`);
console.log(`   标的 ${rows.length} 只 · A/B ${dist.A + dist.B} 只 · 机会类型 ${oppGroups.length} 类 · 风险类型 ${riskGroups.length} 类 · 事件 ${marketEvents.length + companyEvents.length} 项`);
