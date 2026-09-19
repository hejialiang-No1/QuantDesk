/**
 * events.js —— 未来事件日历与事件风险
 *
 * 数据来源分层（这点必须说清楚，否则用户会把估算日期当成官方公告）：
 *   · macro  ：官方已公布的日程。来源 Federal Reserve（FOMC）、BLS（CPI/非农/PPI/JOLTS）、
 *              BEA（GDP/PCE）、Census（零售销售）。核对于 2026-09-19。
 *              官方仍可能微调，所以每条都带 source 字段，界面上要显示来源。
 *   · option ：**按规则计算**的日期（每月第三个周五），不是公告。用 thirdFriday() 现算，
 *              不做硬编码，避免过期。
 *   · earnings：来自 nasdaq 财报日历接口的真实排期（含 EPS 一致预期）。抓不到时
 *              降级为「上次财报日 + 91 天」的**估算**，并明确标注 estimated=true。
 *   · 惯例类（ISM / 密歇根）：按月内第 N 个工作日推算，标注 estimated=true。
 *
 * 所有函数纯计算，无网络依赖。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Events = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // ============================================================ 宏观日历（官方）

  /**
   * 2026 剩余的重要宏观日程。
   * 时间均为美东时间（ET）。marketImpact 是本地的经验分级（1 低 / 2 中 / 3 高），
   * 用来决定「要不要提醒用户」，不是官方口径。
   */
  const MACRO_2026 = [
    { date: '2026-09-29', time: '10:00', event: 'JOLTS 职位空缺（8月）', source: 'BLS', marketImpact: 2 },
    { date: '2026-09-30', time: '08:30', event: 'Q2 GDP 终值 + 8月 PCE 物价', source: 'BEA', marketImpact: 3 },
    { date: '2026-10-02', time: '08:30', event: '9月非农就业报告', source: 'BLS', marketImpact: 3 },
    { date: '2026-10-07', time: '14:00', event: 'FOMC 会议纪要（9/15-16）', source: 'Federal Reserve', marketImpact: 2 },
    { date: '2026-10-14', time: '08:30', event: '9月 CPI 通胀数据', source: 'BLS', marketImpact: 3 },
    { date: '2026-10-15', time: '08:30', event: '9月 PPI + 9月零售销售', source: 'BLS / Census', marketImpact: 2 },
    { date: '2026-10-28', time: '14:00', event: 'FOMC 利率决议（10/27-28）', source: 'Federal Reserve', marketImpact: 3 },
    { date: '2026-10-29', time: '08:30', event: 'Q3 GDP 初值 + 9月 PCE 物价', source: 'BEA', marketImpact: 3 },
    { date: '2026-11-03', time: '10:00', event: 'JOLTS 职位空缺（9月）', source: 'BLS', marketImpact: 1 },
    { date: '2026-11-06', time: '08:30', event: '10月非农就业报告', source: 'BLS', marketImpact: 3 },
    { date: '2026-11-10', time: '08:30', event: '10月 CPI 通胀数据', source: 'BLS', marketImpact: 3 },
    { date: '2026-11-13', time: '08:30', event: '10月 PPI', source: 'BLS', marketImpact: 2 },
    { date: '2026-11-17', time: '08:30', event: '10月零售销售', source: 'Census', marketImpact: 2 },
    { date: '2026-11-18', time: '14:00', event: 'FOMC 会议纪要（10/27-28）', source: 'Federal Reserve', marketImpact: 2 },
    { date: '2026-11-25', time: '08:30', event: 'Q3 GDP 修正 + 10月 PCE 物价', source: 'BEA', marketImpact: 2 },
    { date: '2026-12-01', time: '10:00', event: 'JOLTS 职位空缺（10月）', source: 'BLS', marketImpact: 1 },
    { date: '2026-12-04', time: '08:30', event: '11月非农就业报告', source: 'BLS', marketImpact: 3 },
    { date: '2026-12-09', time: '14:00', event: 'FOMC 利率决议 + 点阵图（12/8-9）', source: 'Federal Reserve', marketImpact: 3 },
    { date: '2026-12-10', time: '08:30', event: '11月 CPI 通胀数据', source: 'BLS', marketImpact: 3 },
    { date: '2026-12-15', time: '08:30', event: '11月 PPI', source: 'BLS', marketImpact: 2 },
    { date: '2026-12-16', time: '08:30', event: '11月零售销售', source: 'Census', marketImpact: 2 },
    { date: '2026-12-23', time: '08:30', event: 'Q3 GDP 终值 + 11月 PCE 物价', source: 'BEA', marketImpact: 2 },
  ];

  const SEASONAL = {
    // 美股财报季窗口：银行股打头，通常在 1/4/7/10 月中旬启动，持续约 5 周
    earningsSeason: [
      { from: '2026-10-13', to: '2026-11-20', label: 'Q3 2026 财报季' },
      { from: '2027-01-12', to: '2027-02-19', label: 'Q4 2026 财报季' },
    ],
  };

  // ============================================================ 日期工具

  const DAY = 86400000;

  /**
   * 把 'YYYY-MM-DD' / Date / 时间戳统一转成本地零点时间戳。
   * ★ 必须显式支持 number：upcoming() 默认传的就是 Date.now() 的返回值，
   *   早期版本漏了这一支，于是 from 变成 NaN，所有日期比较都 false ——
   *   表现为「事件日历永远是空的」，而且不报任何错。这是最阴的一类 bug。
   */
  function dayStart(d) {
    if (d instanceof Date) return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    if (typeof d === 'number' && Number.isFinite(d)) return new Date(d).setHours(0, 0, 0, 0);
    const m = String(d == null ? '' : d).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
    const t = Date.parse(d);
    return Number.isFinite(t) ? new Date(t).setHours(0, 0, 0, 0) : NaN;
  }

  function fmtDay(d) {
    const x = new Date(d);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  }

  function daysBetween(a, b) {
    return Math.round((dayStart(b) - dayStart(a)) / DAY);
  }

  /** 某月第 n 个星期五 */
  function nthFriday(year, month /* 1-12 */, n) {
    const first = new Date(year, month - 1, 1);
    const offset = (5 - first.getDay() + 7) % 7; // 5 = Friday
    return new Date(year, month - 1, 1 + offset + (n - 1) * 7);
  }

  /** 标准月度期权到期日：每月第三个星期五 */
  function thirdFriday(year, month) {
    return fmtDay(nthFriday(year, month, 3));
  }

  /**
   * 未来若干个月的标准期权到期日。
   * 三重巫日（股票/指数期权与期货同时到期）落在 3/6/9/12 月，波动通常更大。
   */
  function optionExpiries(from, months, count) {
    const start = new Date(dayStart(from || Date.now()));
    const out = [];
    const n = count || months || 6;
    for (let i = 0; i < n; i++) {
      const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
      const tf = nthFriday(d.getFullYear(), d.getMonth() + 1, 3);
      if (tf.getTime() < dayStart(from || Date.now()) && i === 0) continue;
      const m = d.getMonth() + 1;
      const witching = [3, 6, 9, 12].includes(m);
      out.push({
        date: fmtDay(tf),
        type: witching ? 'tripleWitching' : 'optionExpiry',
        event: witching ? '季度期权到期（三重巫日）' : '月度期权到期日',
        source: '规则计算（每月第三个周五）',
        marketImpact: witching ? 3 : 2,
        estimated: false,
      });
    }
    return out;
  }

  /** 月内第 n 个工作日（周一至周五） */
  function nthWeekday(year, month, n) {
    const d = new Date(year, month - 1, 1);
    let c = 0;
    while (true) {
      const w = d.getDay();
      if (w >= 1 && w <= 5) {
        c++;
        if (c === n) return new Date(d);
      }
      d.setDate(d.getDate() + 1);
      if (d.getMonth() !== month - 1) return null;
    }
  }

  /** 惯例类宏观事件：ISM 制造业/服务业 PMI、密歇根消费者信心 */
  function conventionalEvents(year, month) {
    const out = [];
    const ismMfg = nthWeekday(year, month, 1);
    const ismSvc = nthWeekday(year, month, 3);
    if (ismMfg) out.push({ date: fmtDay(ismMfg), time: '10:00', event: 'ISM 制造业 PMI', source: '惯例推算（月内第 1 个工作日）', marketImpact: 2, estimated: true });
    if (ismSvc) out.push({ date: fmtDay(ismSvc), time: '10:00', event: 'ISM 服务业 PMI', source: '惯例推算（月内第 3 个工作日）', marketImpact: 2, estimated: true });
    const mich = new Date(year, month - 1, 15);
    out.push({ date: fmtDay(mich), time: '10:00', event: '密歇根消费者信心初值', source: '惯例推算（月中）', marketImpact: 1, estimated: true });
    return out;
  }

  // ============================================================ 汇总

  /**
   * 汇总未来 N 天的全部事件。
   * @param {Object} opt {
   *   from, days, includeMacro, includeOptions, includeSeasonal,
   *   earnings: [{symbol,name,date,time,epsForecast,marketCap,estimated}],
   *   dividends: [{symbol,name,date,rate}],
   *   splits: [{symbol,name,date,ratio}],
   *   focusSymbols: [] 只保留这些标的的公司事件（宏观事件始终保留）
   * }
   */
  function upcoming(opt) {
    const o = opt || {};
    const from = o.from ? dayStart(o.from) : dayStart(Date.now());
    const days = o.days == null ? 30 : o.days;
    const to = from + days * DAY;
    const focus = new Set((o.focusSymbols || []).map((s) => String(s).toUpperCase()));
    const out = [];

    if (o.includeMacro !== false) {
      for (const e of MACRO_2026) {
        const t = dayStart(e.date);
        if (t >= from && t <= to) out.push({ ...e, kind: 'macro', scope: 'market' });
      }
      // 惯例类：覆盖 from 到 to 之间的每个月的第 1/3 个工作日
      const cur = new Date(from);
      cur.setDate(1);
      while (cur.getTime() <= to) {
        for (const e of conventionalEvents(cur.getFullYear(), cur.getMonth() + 1)) {
          const t = dayStart(e.date);
          if (t >= from && t <= to) out.push({ ...e, kind: 'macro', scope: 'market', time: e.time || '10:00' });
        }
        cur.setMonth(cur.getMonth() + 1);
      }
    }

    if (o.includeOptions !== false) {
      for (const e of optionExpiries(new Date(from), 0, 6)) {
        const t = dayStart(e.date);
        if (t >= from && t <= to) out.push({ ...e, kind: 'option', scope: 'market', time: '' });
      }
    }

    if (o.includeSeasonal !== false) {
      for (const s of SEASONAL.earningsSeason) {
        const a = dayStart(s.from);
        const b = dayStart(s.to);
        if (b >= from && a <= to) {
          out.push({
            date: fmtDay(Math.max(a, from)), time: '', event: `${s.label}（${s.from} ~ ${s.to}）`,
            source: '季节性规律', marketImpact: 2, estimated: true,
            kind: 'season', scope: 'market',
          });
        }
      }
    }

    const keep = (rows, kind) => {
      for (const r of rows || []) {
        const sym = String(r.symbol || '').toUpperCase();
        if (focus.size && !focus.has(sym)) continue;
        const t = dayStart(r.date);
        if (!(t >= from && t <= to)) continue;
        out.push({ ...r, symbol: sym, kind, scope: 'company' });
      }
    };
    keep(o.earnings, 'earnings');
    keep(o.dividends, 'dividend');
    keep(o.splits, 'split');

    out.sort((a, b) => dayStart(a.date) - dayStart(b.date) || String(a.event || '').localeCompare(String(b.event || '')));
    return out.map((e) => ({ ...e, daysAway: daysBetween(from, e.date) }));
  }

  /**
   * 事件风险评分：把「未来事件」折算成一个 0-100 的风险分 + 说明。
   * 逻辑：越近、影响级别越高、越不确定（财报 > 宏观），风险分越高。
   *
   * ★ 计分方式：只取**权重最高的 3 项**求和，再叠加一个有限的事件密度加成。
   *   早期版本把所有事件累加，结果只要窗口里超过 6 个事件就必定 100 分 ——
   *   分数永远顶格，等于没有区分度（宏观日历本来就密集）。
   */
  function riskProfile(events, opt) {
    const o = opt || {};
    const list = (events || []).filter((e) => e.daysAway >= 0);
    if (!list.length) {
      return { score: 0, level: '低', items: [], note: '未来窗口内没有识别到高影响事件。注意：这不等于没有风险，只说明已知日历里没有。' };
    }
    const items = [];
    for (const e of list) {
      const impact = e.marketImpact || 1;
      // 越近权重越高：0 天 = 1.0，30 天 ≈ 0.25
      const prox = Math.max(0.2, 1 - e.daysAway / 40);
      const base = e.kind === 'earnings' ? impact * 14 : e.kind === 'macro' ? impact * 9 : impact * 6;
      items.push({ ...e, weight: Math.round(base * prox) });
    }
    items.sort((a, b) => b.weight - a.weight);
    const topSum = items.slice(0, 3).reduce((s, x) => s + x.weight, 0);
    // 密度加成：事件越多越难逐个躲开，但封顶 14 分，避免再次顶格
    const breadth = Math.min(14, Math.max(0, (list.length - 3) * 1.6));
    // 最近一项的临近程度单独加权（离得越近越该警惕）
    const nearest = list.slice().sort((a, b) => a.daysAway - b.daysAway)[0];
    const proximity = Math.max(0, 12 - nearest.daysAway) * 0.8;
    const score = Math.min(100, Math.round(topSum + breadth + proximity));

    const level = score >= 62 ? '高' : score >= 34 ? '中' : '低';
    const sortedByDate = list.slice().sort((a, b) => a.daysAway - b.daysAway);
    const next = sortedByDate[0];
    const note =
      level === '高'
        ? `未来窗口事件密集（${list.length} 项），最近的「${next.event}」在 ${next.daysAway} 天后。事件窗口内建议降低杠杆与仓位，避免在数据公布前重仓押方向。`
        : level === '中'
        ? `有事件需要留意（${list.length} 项），最近的「${next.event}」在 ${next.daysAway} 天后。`
        : `事件扰动相对可控，最近的「${next.event}」在 ${next.daysAway} 天后。`;
    return { score, level, items, nearest: next, count: list.length, note };
  }

  /** 距下次财报的天数：有真实排期用真实值，否则返回 null（不猜） */
  function daysToEarnings(symbol, earnings, from) {
    const sym = String(symbol || '').toUpperCase();
    const t0 = dayStart(from || Date.now());
    let best = null;
    for (const e of earnings || []) {
      if (String(e.symbol || '').toUpperCase() !== sym) continue;
      const d = daysBetween(t0, e.date);
      if (d >= 0 && (best == null || d < best.days)) best = { days: d, date: e.date, time: e.time, epsForecast: e.epsForecast, estimated: !!e.estimated };
    }
    return best;
  }

  return {
    MACRO_2026, SEASONAL,
    dayStart, fmtDay, daysBetween, nthFriday, thirdFriday, nthWeekday,
    optionExpiries, conventionalEvents, upcoming, riskProfile, daysToEarnings,
  };
});
