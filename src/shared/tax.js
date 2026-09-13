/**
 * tax.js —— 税务记录与提醒（个人自用版）
 *
 * 定位要说清楚：软件只做「记录 + 归类 + 提醒」，**不产生纳税义务判定**，
 * 也不替代税务师。个人自用最需要的三件事：
 *   1. 洗售规则（Wash Sale）提醒 —— 亏损卖出前后 30 天内买回同一标的，
 *      该笔亏损不得当期抵扣，要递延进新持仓的成本基础；
 *   2. 短期 / 长期资本利得划分 —— 持有超过 1 年为长期，税率档次不同；
 *   3. 股息预扣税 —— 中国税务居民持美股，美国按协定通常预扣 10%（无 W-8BEN 则 30%），
 *      中国境内还需按境外所得申报，已缴外国税款可抵免。
 * 出口口径按 1099-B / 1099-DIV / 1042-S 三类表归类，方便自己整理报税资料。
 *
 * 纯函数，不联网、不落盘。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Tax = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  /** 洗售窗口：法定为「前后各 30 天」 */
  const WASH_WINDOW_DAYS = 30;

  /** 长期资本利得门槛：持有超过 1 年（这里按 365 天判定） */
  const LONG_TERM_DAYS = 365;

  /**
   * 美国长期资本利得税档（单身申报，联邦口径）。
   * 用途：帮助估算「如果按最坏情况全额纳税」的成本量级，不是实际申报依据。
   * 实际适用取决于居民身份与税收协定，多数非居民资本利得不适用美国税。
   */
  const LTCG_BRACKETS = [
    { upTo: 47025, rate: 0 },
    { upTo: 518900, rate: 0.15 },
    { upTo: Infinity, rate: 0.2 },
  ];

  /** 附加净投资收益税（NIIT），高收入档 3.8% */
  const NIIT = { threshold: 200000, rate: 0.038 };

  /** 股息预扣税率：中国税务居民依中美税收协定通常为 10%，未提交 W-8BEN 则 30% */
  const WITHHOLDING = [
    { key: 'cn_treaty', label: '中国税务居民（已提交 W-8BEN，协定税率）', rate: 0.1 },
    { key: 'no_treaty', label: '未提交 W-8BEN（默认税率）', rate: 0.3 },
    { key: 'other', label: '其他 / 自定义', rate: 0.1 },
  ];

  /** 中国境内境外所得口径（财产转让所得 20%，股息利息 20%） */
  const CN_RATES = [
    { key: 'property', label: '财产转让所得（股票买卖差价）', rate: 0.2 },
    { key: 'interest', label: '利息、股息、红利所得', rate: 0.2 },
  ];

  function daysBetween(a, b) {
    try {
      return Math.round((new Date(String(b).slice(0, 10)) - new Date(String(a).slice(0, 10))) / 86400000);
    } catch {
      return 0;
    }
  }

  function keyOf(t) {
    return (t.symbol || t.code || '').toUpperCase();
  }

  /**
   * 统一买卖方向的口径。
   *
   * 为什么需要它：本应用内部（回测 / 模拟盘 / importTrades）用的是 `type: 'buy'|'sell'`，
   * 但券商导出的对账单经常用 `side: 'BUY'|'SELL'`，做空还可能是 `short` / `cover`。
   * 之前这里只认 `type`，字段名对不上时会「静默产出空报告」——不报错但什么也没有，
   * 属于最危险的失败模式。所以这里做一次显式归一：
   *   buy / cover（买平空） → 'buy'
   *   sell / short（开空）  → 'sell'
   */
  function sideOf(t) {
    const raw = String((t && (t.type || t.side)) || '').toLowerCase();
    if (raw === 'buy' || raw === 'cover' || raw === 'b') return 'buy';
    if (raw === 'sell' || raw === 'short' || raw === 's') return 'sell';
    return '';
  }

  /** 把交易明细按「买入—卖出」配成回合（FIFO），得到每笔平仓的持有期与盈亏 */
  function matchLots(trades) {
    const bySym = new Map();
    for (const t of trades || []) {
      const k = keyOf(t);
      if (!bySym.has(k)) bySym.set(k, []);
      bySym.get(k).push(t);
    }
    const lots = [];
    for (const [symbol, list] of bySym) {
      const sorted = list.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
      const open = [];
      for (const t of sorted) {
        const dir = sideOf(t);
        const shares = Math.abs(Number(t.shares) || 0);
        const price = Number(t.price) || 0;
        if (dir === 'buy') {
          open.push({ date: t.date, shares, price, fee: Number(t.fee) || 0, remaining: shares });
        } else if (dir === 'sell') {
          let left = shares;
          let entryCost = 0;
          let entryFee = 0;
          let openDate = null;
          let matched = 0;
          while (left > 0 && open.length) {
            const lot = open[0];
            const take = Math.min(left, lot.remaining);
            const ratio = take / lot.shares;
            entryCost += lot.price * take;
            entryFee += lot.fee * ratio;
            if (openDate == null) openDate = lot.date;
            lot.remaining -= take;
            left -= take;
            matched += take;
            if (lot.remaining <= 1e-9) open.shift();
          }
          const proceeds = price * matched;
          const exitFee = (Number(t.fee) || 0) * (shares > 0 ? matched / shares : 1);
          const cost = entryCost + entryFee;
          const pnl = proceeds - cost - exitFee;
          lots.push({
            symbol,
            openDate,
            closeDate: t.date,
            shares: matched,
            entryPrice: matched > 0 ? entryCost / matched : 0,
            exitPrice: price,
            cost,
            proceeds,
            fee: entryFee + exitFee,
            pnl,
            holdDays: openDate ? daysBetween(openDate, t.date) : 0,
            term: openDate && daysBetween(openDate, t.date) > LONG_TERM_DAYS ? 'long' : 'short',
            source: t,
          });
        }
      }
    }
    lots.sort((a, b) => String(a.closeDate).localeCompare(String(b.closeDate)));
    return lots;
  }

  /**
   * 洗售规则检测。
   * 规则：某笔亏损平仓前后各 30 个自然日内，若买回同一标的（含期权等同标的衍生品），
   * 该亏损被「洗掉」——不得当期抵扣，需加到替代买入的成本基础上，随新持仓递延。
   *
   * @param {Array} trades 交易明细
   * @returns {{lots, cleansed, totalDisallowed, notes}}
   */
  function washSale(trades) {
    const lots = matchLots(trades);
    const losses = lots.filter((l) => l.pnl < 0);
    const result = [];

    for (const loss of losses) {
      const sym = loss.symbol;
      // 同标的、买入日期落在 [平仓日 - 30, 平仓日 + 30] 区间内的买入记为替代买入
      const near = (trades || []).filter((t) => {
        // 必须用 sideOf 而不是 t.type：券商对账单用 side，模拟盘/回测用 type。
        // 只认 type 的话，side 口径下会「检测不到任何洗售」——不报错但结论是错的。
        if (sideOf(t) !== 'buy') return false;
        if (keyOf(t) !== sym) return false;
        const gap = daysBetween(loss.closeDate, t.date);
        return gap >= -WASH_WINDOW_DAYS && gap <= WASH_WINDOW_DAYS;
      });

      if (!near.length) continue;

      const disallowed = Math.abs(loss.pnl);
      const sub = near.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)))[0];
      result.push({
        symbol: sym,
        closeDate: loss.closeDate,
        loss: loss.pnl,
        disallowedLoss: disallowed,
        replacementDate: sub.date,
        replacementPrice: Number(sub.price) || 0,
        replacementShares: Math.abs(Number(sub.shares) || 0),
        // 被否掉的亏损加到替代买入的成本基础上
        adjustedBasisPerShare: (() => {
          const sh = Math.abs(Number(sub.shares) || 0);
          return sh > 0 ? (Number(sub.price) || 0) + disallowed / sh : 0;
        })(),
        holdDays: loss.holdDays,
        term: loss.term,
        withinDays: daysBetween(loss.closeDate, sub.date),
        reason: `${loss.closeDate} 亏损平仓，${sub.date} 又在 ${WASH_WINDOW_DAYS} 天窗口内买回 ${sym}，构成洗售。`,
      });
    }

    const totalDisallowed = result.reduce((s, r) => s + r.disallowedLoss, 0);
    return {
      lots,
      cleansed: result,
      totalDisallowed,
      windowDays: WASH_WINDOW_DAYS,
      notes: result.length
        ? [`检测到 ${result.length} 笔疑似洗售，合计 $${totalDisallowed.toFixed(2)} 的亏损需递延，不能在当期抵扣。`,
           '递延方式：把被否掉的亏损加到替代买入的成本基础上，等新持仓卖出时再体现。',
           '注意：同一标的的买入包括期权、可转债等实质相同证券；IRA 等退休账户的买回也计入。']
        : [`未检测到洗售：所有亏损平仓的前后 ${WASH_WINDOW_DAYS} 天内都没有同标的买回记录。`],
    };
  }

  /**
   * 短期 / 长期资本利得划分与汇总。
   * @param {Array}  lots         matchLots() 的结果
   * @param {Number} [disallowed] 被洗售否掉的亏损额，需加回应税所得
   */
  function classify(lots, disallowed) {
    const short = lots.filter((l) => l.term === 'short');
    const long = lots.filter((l) => l.term === 'long');
    const sum = (a) => a.reduce((s, x) => s + x.pnl, 0);
    const winSum = (a) => a.filter((x) => x.pnl > 0).reduce((s, x) => s + x.pnl, 0);
    const lossSum = (a) => a.filter((x) => x.pnl <= 0).reduce((s, x) => s + x.pnl, 0);

    const detail = (a) => ({
      count: a.length,
      netPnl: sum(a),
      gains: winSum(a),
      losses: lossSum(a),
      winRate: a.length ? (a.filter((x) => x.pnl > 0).length / a.length) * 100 : 0,
      avgHold: a.length ? a.reduce((s, x) => s + x.holdDays, 0) / a.length : 0,
    });

    const dis = Math.max(0, Number(disallowed) || 0);
    const shortD = detail(short);
    const longD = detail(long);
    const totalD = detail(lots);

    // 应税口径：把被洗掉的亏损加回（当期不可抵扣，递延到替代买入）
    const taxableShort = shortD.netPnl + dis;
    const taxableLong = longD.netPnl;

    return {
      shortTerm: shortD,
      longTerm: longD,
      total: totalD,
      netCapitalGain: sum(lots),
      washSaleAddBack: dis,
      taxable: {
        shortTerm: taxableShort,
        longTerm: taxableLong,
        net: taxableShort + taxableLong,
        note: dis > 0 ? `已把 $${dis.toFixed(2)} 的洗售亏损加回应税所得。` : '无洗售调整。',
      },
      thresholdDays: LONG_TERM_DAYS,
      note: `持有超过 ${LONG_TERM_DAYS} 天的按长期资本利得处理，税率档次通常低于短期（短期按普通所得课税）。`,
    };
  }

  /**
   * 估算联邦资本利得税（仅做题量级参考，非申报依据）。
   * @param {Object} c   classify() 的结果
   * @param {Number} otherIncome 其他应税所得，用于确定长期档位
   */
  function estimateFederal(c, otherIncome) {
    const oi = Math.max(0, Number(otherIncome) || 0);
    const shortNet = Math.max(0, (c.taxable ? c.taxable.shortTerm : c.shortTerm.netPnl));
    // 短期按普通所得：这里用 24% 的常见档位做量级估算
    const shortEst = shortNet * 0.24;
    const longNet = Math.max(0, (c.taxable ? c.taxable.longTerm : c.longTerm.netPnl));
    let remain = longNet;
    let cursor = oi;
    let longEst = 0;
    for (const b of LTCG_BRACKETS) {
      if (remain <= 0) break;
      const room = Math.max(0, b.upTo - cursor);
      const take = Math.min(remain, room === Infinity ? remain : room);
      longEst += take * b.rate;
      remain -= take;
      cursor += take;
    }
    const total = shortEst + longEst;
    const netGain = c.taxable ? c.taxable.net : c.netCapitalGain;
    return {
      shortTermTax: shortEst,
      longTermTax: longEst,
      total,
      effectiveOnGain: netGain > 0 ? (total / netGain) * 100 : 0,
      niitEst: netGain > 0 && oi + netGain > NIIT.threshold ? netGain * NIIT.rate : 0,
      note: '按单身申报的联邦长期档位与 24% 短期档位粗估，仅供量级参考。非美国税务居民的证券资本利得通常不适用美国税，实际以你的税务身份与协定为准。',
    };
  }

  /**
   * 股息与预扣税。
   * @param {Array} dividends [{ date, symbol, gross, type:'qualified'|'ordinary' }]
   * @param {Object} opt { withholdingRate, treaty }
   */
  function dividends(dividends, opt) {
    const o = opt || {};
    const rate = o.withholdingRate == null ? 0.1 : o.withholdingRate;
    const list = (dividends || []).map((d) => {
      const gross = Number(d.gross) || 0;
      const wh = gross * rate;
      return {
        date: d.date,
        symbol: d.symbol || '',
        gross,
        type: d.type === 'qualified' ? 'qualified' : 'ordinary',
        withholdingRate: rate * 100,
        withholding: wh,
        net: gross - wh,
      };
    });
    const gross = list.reduce((s, d) => s + d.gross, 0);
    const wh = list.reduce((s, d) => s + d.withholding, 0);
    const qualified = list.filter((d) => d.type === 'qualified').reduce((s, d) => s + d.gross, 0);
    return {
      list,
      gross,
      qualified,
      ordinary: gross - qualified,
      withholding: wh,
      net: gross - wh,
      rate: rate * 100,
      cnTreatment: '境外股息需在中国境内按「利息、股息、红利所得」申报，已在美国缴纳的预扣税可依法抵免。',
      note: `按 ${(rate * 100).toFixed(0)}% 预扣估算。中国税务居民提交 W-8BEN 后适用中美税收协定税率（通常 10%），未提交则默认 30%。`,
    };
  }

  /**
   * 按报税表格归类：1099-B（证券交易）、1099-DIV（股息）、1042-S（非居民所得）。
   */
  function forms(allLots, dividendsResult, year) {
    const lots = year ? allLots.filter((l) => String(l.closeDate).startsWith(String(year))) : allLots;
    const rows1099B = lots.map((l) => ({
      description: `${l.shares} 股 ${l.symbol}`,
      取得日: l.openDate,
      处置日: l.closeDate,
      持有天数: l.holdDays,
      类别: l.term === 'long' ? '长期' : '短期',
      成本: Number(l.cost.toFixed(2)),
      收入: Number(l.proceeds.toFixed(2)),
      盈亏: Number(l.pnl.toFixed(2)),
    }));
    const rows1099Div = ((dividendsResult && dividendsResult.list) || [])
      .filter((d) => !year || String(d.date).startsWith(String(year)))
      .map((d) => ({
        日期: d.date,
        标的: d.symbol,
        类型: d.type === 'qualified' ? '合格股息' : '普通股息',
        毛额: Number(d.gross.toFixed(2)),
        预扣税: Number(d.withholding.toFixed(2)),
        净额: Number(d.net.toFixed(2)),
      }));
    const rows1042S = ((dividendsResult && dividendsResult.list) || [])
      .filter((d) => (d.withholding || 0) > 0 && (!year || String(d.date).startsWith(String(year))))
      .map((d) => ({
        所得类型: '股息 Dividends',
        毛额: Number(d.gross.toFixed(2)),
        预扣税率: d.withholdingRate + '%',
        预扣税额: Number(d.withholding.toFixed(2)),
        协定依据: '中美税收协定第九条',
      }));

    return {
      year: year || '全部',
      b1099: { name: '1099-B 证券买卖', rows: rows1099B, count: rows1099B.length },
      div1099: { name: '1099-DIV 股息', rows: rows1099Div, count: rows1099Div.length },
      s1042: { name: '1042-S 非居民所得', rows: rows1042S, count: rows1042S.length },
    };
  }

  /**
   * 年度汇总：把上面几块拼成一份可核对的报告。
   *
   * 关键顺序：**先对全量成交做 FIFO 配对，再按平仓年份筛选**。
   * 反过来会把上一年建仓、本年度卖出的成本基础整段丢掉，盈亏直接算错。
   *
   * @param {Object} o { trades, dividends, year, otherIncome, withholdingRate, chinaRate }
   */
  function report(o) {
    const opt = o || {};
    const year = opt.year || String(new Date().getFullYear());
    const allTrades = opt.trades || [];

    // 1) 全量配对 → 得到每笔平仓的真实成本与持有期
    const allLots = matchLots(allTrades);
    const lots = allLots.filter((l) => String(l.closeDate).startsWith(String(year)));

    // 2) 洗售在全量成交上判定（跨年的买回同样构成洗售），再按平仓年筛选
    const wsAll = washSale(allTrades);
    const wsCleansed = wsAll.cleansed.filter((c) => String(c.closeDate).startsWith(String(year)));
    const ws = { ...wsAll, cleansed: wsCleansed, totalDisallowed: wsCleansed.reduce((s, c) => s + c.disallowedLoss, 0) };

    // 3) 分类与税额（用应税口径，已加回洗售亏损）
    const cls = classify(lots, ws.totalDisallowed);
    const fed = estimateFederal(cls, opt.otherIncome);
    const div = dividends((opt.dividends || []).filter((d) => String(d.date).startsWith(String(year))), opt);
    const fm = forms(allLots, div, year);

    const taxableNet = cls.taxable.net;
    const cnProperty = taxableNet > 0 ? taxableNet * 0.2 : 0;
    const cnDiv = div.gross * 0.2;
    const foreignCredit = div.withholding;

    return {
      year,
      // 明细：年内已平仓回合（成本、持有期、盈亏、长短期）。界面表格直接用这个。
      lots,
      summary: {
        trades: lots.length,
        realizedPnl: cls.netCapitalGain,
        taxablePnl: taxableNet,
        shortTermPnl: cls.shortTerm.netPnl,
        longTermPnl: cls.longTerm.netPnl,
        dividendGross: div.gross,
        dividendWithholding: div.withholding,
        dividendNet: div.net,
        washSaleDisallowed: ws.totalDisallowed,
      },
      classify: cls,
      federal: fed,
      dividend: div,
      washSale: ws,
      forms: fm,
      china: {
        propertyTax: cnProperty,
        dividendTax: cnDiv,
        foreignTaxCredit: foreignCredit,
        netPayable: Math.max(0, cnProperty + cnDiv - foreignCredit),
        note: '中国税务居民就境外所得在境内申报，财产转让与股息红利均为 20% 比例税率，已在境外缴纳的所得税可抵免（需保留完税凭证）。',
      },
      disclaimer:
        '本模块只做记录、归类与提醒，不构成税务建议，也不替代专业申报。实际纳税义务取决于你的税务居民身份、账户类型（现金/保证金/退休账户）、所在国税法与税收协定，请以券商年报税表与税务师意见为准。',
      generatedAt: new Date().toISOString(),
    };
  }

  /** 导出为 CSV 文本（自行拼字符串，不依赖第三方库） */
  function toCsv(rows) {
    if (!rows || !rows.length) return '';
    const cols = Object.keys(rows[0]);
    const esc = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
  }

  return {
    WASH_WINDOW_DAYS,
    LONG_TERM_DAYS,
    LTCG_BRACKETS,
    WITHHOLDING,
    CN_RATES,
    matchLots,
    sideOf,
    washSale,
    classify,
    estimateFederal,
    dividends,
    forms,
    report,
    toCsv,
  };
});
