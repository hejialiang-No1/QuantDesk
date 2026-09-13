/**
 * market.js —— 美股市场规则引擎（个人自用版）
 *
 * 个人自用版最容易被忽略、却最影响回测可信度的部分：美股的真实交易规则。
 * 这里把「什么时候能交易、什么单能下、下单要交多少钱」集中实现，
 * 让回测、模拟盘、风控三处共用同一份规则，避免各算各的。
 *
 * 覆盖：
 *   - 交易时段：盘前 04:00 / 常规 09:30 / 盘后 20:00（美东），半日市 13:00 收
 *   - 假期表 + 夏令时（EST/EDT）自动换算
 *   - T+1 结算（2024-05-28 起美股由 T+2 改为 T+1）
 *   - PDT 日内交易者规则（净值 < $25,000 时 5 日内第 4 次日内交易触发）
 *   - SSR 做空提价规则（Reg SHO Rule 201，前日跌 ≥10% 触发）
 *   - LULD 个股涨跌停价格带 + 市场级熔断（-7% / -13% / -20%）
 *   - 订单类型：市价/限价/止损/止损限价/OCO/Bracket + MOO/MOC/LOC/CLO/TWAP/VWAP/冰山
 *   - 费用模型：佣金、SEC Section 31 费、FINRA TAF、交易所费、清算费、CAT 费
 *
 * 全部为纯函数，无外部依赖；时间一律以美东（America/New_York）为准。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Market = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // ============================================================ 常量

  /** 常规时段（美东，分钟数自 0:00 起） */
  const SESSION = {
    preStart: 4 * 60, // 04:00 盘前开始
    open: 9 * 60 + 30, // 09:30 开盘
    close: 16 * 60, // 16:00 收盘
    afterEnd: 20 * 60, // 20:00 盘后结束
    halfClose: 13 * 60, // 13:00 半日市收盘
    halfAfterEnd: 17 * 60, // 17:00 半日市盘后结束
  };

  /**
   * 费用默认值。
   * 这些费率由监管机构与交易所调整，且券商各不相同 —— 全部做成可覆盖项，
   * 默认值取长期沿用的口径，用来做「量级正确」的成本估计，不以分毫为准。
   */
  const FEE_DEFAULTS = {
    commission: 0, // 每股佣金（$）；主流互联网券商美股为 0
    commissionMin: 0, // 单笔最低佣金
    secRate: 0.0000278, // SEC Section 31：卖出金额 × $27.80/百万
    tafRate: 0.000166, // FINRA TAF：卖出股数 × $0.000166
    tafCap: 8.3, // FINRA TAF 单笔上限
    exchangeRate: 0.00003, // 交易所费：成交金额比例
    clearingRate: 0.000002, // 清算费：股数比例
    catRate: 0.000003, // CAT 费：股数
    shortBorrowRate: 0.03, // 借券年费率（做空持仓，按年化折算到持有天数）
    spreadBps: 2, // 默认买卖价差（基点），行情里拿不到盘口时的替代
  };

  /** 订单类型清单：个人自用版需要能区分「什么时候以什么价格成交」 */
  const ORDER_TYPES = [
    { key: 'market', name: '市价单', group: '基础', desc: '立即以对手价成交，不保证价格。回测按次日开盘价 + 滑点成交。' },
    { key: 'limit', name: '限价单', group: '基础', desc: '只在指定价或更优价成交，可能不成交。回测按当日价格区间判定能否触及。' },
    { key: 'stop', name: '止损单', group: '基础', desc: '价格穿越触发价后转为市价单，滑点风险较大。' },
    { key: 'stop_limit', name: '止损限价单', group: '基础', desc: '触发后转为限价单，可控制成交价但可能完全无法成交。' },
    { key: 'oco', name: 'OCO 一单撤一', group: '组合', desc: '止盈止损同时挂，一边成交另一边自动撤销。' },
    { key: 'bracket', name: 'Bracket 括号单', group: '组合', desc: '入场单 + 止盈 + 止损三腿，成交后自动挂出保护腿。' },
    { key: 'moo', name: 'MOO 开盘市价', group: '美股特色', desc: '以开盘集合竞价成交。需在开盘前提交，回测按次日开盘价成交。' },
    { key: 'moc', name: 'MOC 收盘市价', group: '美股特色', desc: '以收盘集合竞价成交。交易所通常要求在 15:50 前提交。' },
    { key: 'loc', name: 'LOC 收盘限价', group: '美股特色', desc: '收盘集合竞价中，只在限价或更优价成交，可能不成交。' },
    { key: 'clo', name: 'CLO 收盘限价（NYSE）', group: '美股特色', desc: '与 LOC 同类，纽交所口径的收盘限价单。' },
    { key: 'twap', name: 'TWAP 时间加权', group: '算法单', desc: '把大单按时间均匀切片，降低对盘口的冲击。' },
    { key: 'vwap', name: 'VWAP 成交量加权', group: '算法单', desc: '按历史成交量分布切片，贴近市场均价成交。' },
    { key: 'iceberg', name: '冰山单', group: '算法单', desc: '只显示部分数量，成交后自动补足，隐藏真实委托量。' },
  ];

  const ORDER_TYPE_MAP = {};
  for (const o of ORDER_TYPES) ORDER_TYPE_MAP[o.key] = o;

  // ============================================================ 日历

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  /** 把 Date 或 'YYYY-MM-DD' 归一化成 {y,m,d}（m 为 1-12） */
  function ymd(input) {
    if (input instanceof Date) {
      // 用美东口径取年月日，避免用本机时区切日期
      const p = etParts(input);
      return { y: p.y, m: p.m, d: p.d };
    }
    const s = String(input || '').slice(0, 10);
    const [y, m, d] = s.split('-').map(Number);
    return { y, m, d };
  }

  function iso({ y, m, d }) {
    return `${y}-${pad(m)}-${pad(d)}`;
  }

  /** 该月的第 n 个星期 w（w: 0=周日 … 6=周六） */
  function nthWeekday(y, m, w, n) {
    const first = new Date(Date.UTC(y, m - 1, 1));
    const shift = (w - first.getUTCDay() + 7) % 7;
    return 1 + shift + (n - 1) * 7;
  }

  /** 该月最后一个星期 w */
  function lastWeekday(y, m, w) {
    const last = new Date(Date.UTC(y, m, 0));
    const shift = (last.getUTCDay() - w + 7) % 7;
    return last.getUTCDate() - shift;
  }

  /** 某日期的星期几（0=周日） */
  function weekdayOf({ y, m, d }) {
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  }

  /** 复活节（Meeus/Jones/Butcher 算法，用于推算耶稣受难日） */
  function easter(y) {
    const a = y % 19;
    const b = Math.floor(y / 100);
    const c = y % 100;
    const dd = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - dd - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const mm = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * mm + 114) / 31);
    const day = ((h + l - 7 * mm + 114) % 31) + 1;
    return { y, m: month, d: day };
  }

  // 假期表按年缓存
  const holidayCache = new Map();

  /**
   * 某年的美股休市日（含规则说明）。
   * 固定日期落在周六 → 前挪到周五；落在周日 → 后挪到周一（与 NYSE 规则一致）。
   */
  function holidays(year) {
    if (holidayCache.has(year)) return holidayCache.get(year);

    const shift = (m, d, name) => {
      let dt = new Date(Date.UTC(year, m - 1, d));
      const w = dt.getUTCDay();
      let note = '';
      if (w === 6) {
        dt = new Date(Date.UTC(year, m - 1, d - 1));
        note = '（周六顺延至周五）';
      } else if (w === 0) {
        dt = new Date(Date.UTC(year, m - 1, d + 1));
        note = '（周日顺延至周一）';
      }
      return {
        date: iso({ y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() }),
        name,
        note,
      };
    };

    const eg = easter(year);
    const goodFriday = new Date(Date.UTC(eg.y, eg.m - 1, eg.d - 2));

    const list = [
      shift(1, 1, '元旦 New Year\'s Day'),
      { date: iso({ y: year, m: 1, d: nthWeekday(year, 1, 1, 3) }), name: '马丁·路德·金日 MLK Day', note: '1 月第 3 个周一' },
      { date: iso({ y: year, m: 2, d: nthWeekday(year, 2, 1, 3) }), name: '华盛顿诞辰日 Presidents\' Day', note: '2 月第 3 个周一' },
      {
        date: iso({ y: goodFriday.getUTCFullYear(), m: goodFriday.getUTCMonth() + 1, d: goodFriday.getUTCDate() }),
        name: '耶稣受难日 Good Friday',
        note: '复活节前的周五',
      },
      { date: iso({ y: year, m: 5, d: lastWeekday(year, 5, 1) }), name: '阵亡将士纪念日 Memorial Day', note: '5 月最后一个周一' },
      shift(6, 19, '六月节 Juneteenth'),
      shift(7, 4, '独立日 Independence Day'),
      { date: iso({ y: year, m: 9, d: nthWeekday(year, 9, 1, 1) }), name: '劳动节 Labor Day', note: '9 月第 1 个周一' },
      { date: iso({ y: year, m: 11, d: nthWeekday(year, 11, 4, 4) }), name: '感恩节 Thanksgiving', note: '11 月第 4 个周四' },
      shift(12, 25, '圣诞节 Christmas'),
    ];

    list.sort((a, b) => a.date.localeCompare(b.date));
    holidayCache.set(year, list);
    return list;
  }

  /**
   * 某年的半日市（13:00 收盘）。
   * 固定为：感恩节次日、圣诞前夕（仅当 12/24 为工作日时）。
   */
  function halfDays(year) {
    const out = [];
    const tg = nthWeekday(year, 11, 4, 4);
    const nextDay = new Date(Date.UTC(year, 10, tg + 1));
    if (nextDay.getUTCDay() >= 1 && nextDay.getUTCDay() <= 5) {
      out.push({
        date: iso({ y: year, m: nextDay.getUTCMonth() + 1, d: nextDay.getUTCDate() }),
        name: '感恩节次日（黑色星期五）',
        close: '13:00',
      });
    }
    const dt = new Date(Date.UTC(year, 11, 24));
    const w = dt.getUTCDay();
    if (w >= 1 && w <= 5 && !holidayMap(year).has(iso({ y: year, m: 12, d: 24 }))) {
      out.push({ date: iso({ y: year, m: 12, d: 24 }), name: '圣诞前夕', close: '13:00' });
    }
    // 独立日前夕：仅当 7/3 本身是工作日且未被顺延占用时才提前收盘
    const jul3 = new Date(Date.UTC(year, 6, 3));
    const j3key = iso({ y: year, m: 7, d: 3 });
    if (jul3.getUTCDay() >= 1 && jul3.getUTCDay() <= 5 && !holidayMap(year).has(j3key)) {
      out.push({ date: j3key, name: '独立日前夕', close: '13:00' });
    }
    out.sort((a, b) => a.date.localeCompare(b.date));
    return out;
  }

  // ============================================================ 时区

  /** 3 月第 2 个周日 */
  function dstStart(y) {
    return nthWeekday(y, 3, 0, 2);
  }
  /** 11 月第 1 个周日 */
  function dstEnd(y) {
    return nthWeekday(y, 11, 0, 1);
  }

  /**
   * 美东相对 UTC 的偏移（小时）。夏令时 -4，冬令时 -5。
   * @param {Date} utc  以 UTC 解读的时刻
   */
  function etOffset(utc) {
    const y = utc.getUTCFullYear();
    const m = utc.getUTCMonth() + 1;
    const d = utc.getUTCDate();
    const h = utc.getUTCHours();
    const ds = dstStart(y);
    const de = dstEnd(y);

    // 边界日按当地时间 02:00 切换
    const cur = m * 1000000 + d * 10000 + h * 100;
    if (m > 3 && m < 11) return -4;
    if (m < 3 || m > 11) return -5;
    if (m === 3) {
      if (d > ds) return -4;
      if (d < ds) return -5;
      return h >= 6 ? -4 : -5; // 02:00 EST = 07:00 UTC，取近似
    }
    // m === 11
    if (d < de) return -4;
    if (d > de) return -5;
    return h >= 6 ? -5 : -4;
  }

  /** 把一个 UTC 时刻拆成美东的 年月日时分 */
  function etParts(utc) {
    const off = etOffset(utc);
    const t = new Date(utc.getTime() + off * 3600000);
    return {
      y: t.getUTCFullYear(),
      m: t.getUTCMonth() + 1,
      d: t.getUTCDate(),
      hh: t.getUTCHours(),
      mm: t.getUTCMinutes(),
      w: t.getUTCDay(),
      off,
      date: iso({ y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }),
      minutes: t.getUTCHours() * 60 + t.getUTCMinutes(),
      text: `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`,
      dst: off === -4,
    };
  }

  /** 反向：美东某天某分钟 → UTC Date（用于算「下一个开盘时刻」） */
  function etToUtc(y, m, d, minutes) {
    const guess = new Date(Date.UTC(y, m - 1, d, 12, 0)); // 先用正午探偏移
    const off = etOffset(guess);
    const hh = Math.floor(minutes / 60);
    const mm = minutes % 60;
    return new Date(Date.UTC(y, m - 1, d, hh - off, mm));
  }

  // ============================================================ 交易日判定

  function holidayMap(year) {
    const m = new Map();
    for (const h of holidays(year)) m.set(h.date, h);
    return m;
  }

  /** 是否交易日（非周末、非假期） */
  function isTradingDay(input) {
    const { y, m, d } = ymd(input);
    const w = weekdayOf({ y, m, d });
    if (w === 0 || w === 6) return false;
    return !holidayMap(y).has(iso({ y, m, d }));
  }

  /** 交易日信息：是否交易、假期名、是否半日市 */
  function dayInfo(input) {
    const { y, m, d } = ymd(input);
    const key = iso({ y, m, d });
    const w = weekdayOf({ y, m, d });
    const hol = holidayMap(y).get(key);
    const half = halfDays(y).find((h) => h.date === key);
    const weekend = w === 0 || w === 6;
    return {
      date: key,
      weekday: w,
      weekdayName: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][w],
      isTradingDay: !weekend && !hol,
      isWeekend: weekend,
      isHoliday: !!hol,
      holidayName: hol ? hol.name : '',
      holidayNote: hol ? hol.note : '',
      isHalfDay: !!half,
      halfDayName: half ? half.name : '',
      closeMinute: half ? SESSION.halfClose : SESSION.close,
      afterEndMinute: half ? SESSION.halfAfterEnd : SESSION.afterEnd,
    };
  }

  /** UTC 时刻是否落在夏令时 */
  function isDST(input) {
    const dt = input instanceof Date ? input : new Date(input);
    return etOffset(dt) === -4;
  }

  /**
   * 当前美股时段。
   * @param {Date} [now] 默认取本机当前时间
   * @returns {{phase,label,open,trading,day,minutesToOpen,minutesToClose,nextOpenAt,nextCloseAt,dst}}
   */
  function session(now) {
    const t = now instanceof Date ? now : new Date(now || Date.now());
    const p = etParts(t);
    const info = dayInfo(p.date);
    const mins = p.minutes;
    const closeM = info.closeMinute;
    const afterM = info.afterEndMinute;

    let phase = 'closed';
    let label = '休市';
    if (info.isTradingDay) {
      if (mins >= SESSION.preStart && mins < SESSION.open) {
        phase = 'pre';
        label = '盘前';
      } else if (mins >= SESSION.open && mins < closeM) {
        phase = 'regular';
        label = info.isHalfDay ? '常规（半日市）' : '常规';
      } else if (mins >= closeM && mins < afterM) {
        phase = 'after';
        label = '盘后';
      } else if (mins < SESSION.preStart) {
        phase = 'closed';
        label = '休市（待盘前）';
      } else {
        phase = 'closed';
        label = '休市（已收盘）';
      }
    } else {
      label = info.isWeekend ? '休市（周末）' : '休市（假期）';
    }

    const trading = phase === 'pre' || phase === 'regular' || phase === 'after';
    let minutesToOpen = null;
    let minutesToClose = null;
    if (phase === 'regular') minutesToClose = closeM - mins;
    else if (phase === 'pre') minutesToOpen = SESSION.open - mins;
    else if (phase === 'after') minutesToClose = 0;

    // 下一个开盘 / 收盘时刻（UTC）
    let nd = { y: p.y, m: p.m, d: p.d };
    for (let i = 0; i < 400; i++) {
      const c = new Date(Date.UTC(nd.y, nd.m - 1, nd.d + i));
      const ck = iso({ y: c.getUTCFullYear(), m: c.getUTCMonth() + 1, d: c.getUTCDate() });
      const di = dayInfo(ck);
      if (!di.isTradingDay) continue;
      const openAt = etToUtc(di.date.slice(0, 4) | 0, di.date.slice(5, 7) | 0, di.date.slice(8, 10) | 0, SESSION.open);
      if (openAt.getTime() > t.getTime()) {
        nd = { y: c.getUTCFullYear(), m: c.getUTCMonth() + 1, d: c.getUTCDate(), openAt };
        break;
      }
      if (i === 0 && phase === 'regular') {
        nd = { y: c.getUTCFullYear(), m: c.getUTCMonth() + 1, d: c.getUTCDate(), openAt };
        break;
      }
    }

    return {
      phase,
      label,
      trading,
      et: p.text,
      etDate: p.date,
      etOffset: p.off,
      dst: p.dst,
      day: info,
      minutesToOpen,
      minutesToClose,
      nextOpenDate: nd.openAt ? iso({ y: nd.y, m: nd.m, d: nd.d }) : null,
      nextOpenAt: nd.openAt ? iso({ y: nd.y, m: nd.m, d: nd.d }) + ' 09:30 ET' : null,
      zoned: `${p.text} ET (${p.off === -4 ? 'EDT 夏令时' : 'EST 冬令时'})`,
      sessionNote: info.isHalfDay ? `半日市：${info.halfDayName}，13:00 提前收盘` : '',
    };
  }

  // ============================================================ 结算 / 交易约束

  /** T+1 结算日（美股 2024-05-28 起由 T+2 改为 T+1） */
  function settleDate(tradeDate) {
    const { y, m, d } = ymd(tradeDate);
    for (let i = 1; i <= 10; i++) {
      const c = new Date(Date.UTC(y, m - 1, d + i));
      const key = iso({ y: c.getUTCFullYear(), m: c.getUTCMonth() + 1, d: c.getUTCDate() });
      if (isTradingDay(key)) return { date: key, t: i };
    }
    return { date: null, t: null };
  }

  /**
   * PDT 日内交易者规则检查。
   * 规则：保证金账户净值 < $25,000 时，任何滚动 5 个交易日内第 4 次日内交易
   * 会把账户标记为 Pattern Day Trader 并限制交易 90 天。
   * @param {Array} dayTrades  [{date}] 每个元素代表一次「当日开平仓」；也接受裸日期字符串
   * @param {Number} equity    账户净值
   * @param {Date}   [asOf]    检查基准日
   */
  function pdtCheck(dayTrades, equity, asOf) {
    const limit = 25000;
    const maxIn5 = 3; // 5 个交易日内最多 3 次；第 4 次触发
    // 归一成日期字符串：调用方可能传 [{date}]、['2026-09-10'] 或 ['2026-09-10T14:00Z']。
    // 不归一的话 String(undefined) 会得到 "undefined"，与窗口永不匹配 → 统计恒为 0 次，
    // 于是「已经超限」被读成「还有额度」，这是最不该出错的方向。
    const dateOf = (t) => (t && typeof t === 'object' ? t.date : t);
    const list = (dayTrades || [])
      .map((t) => String(dateOf(t) || '').slice(0, 10))
      .filter(Boolean)
      .sort();
    const ref = asOf ? ymd(asOf) : null;

    // 取最近 5 个交易日窗口
    const windowDays = [];
    if (ref) {
      for (let i = 0; i < 20 && windowDays.length < 5; i++) {
        const c = new Date(Date.UTC(ref.y, ref.m - 1, ref.d - i));
        const key = iso({ y: c.getUTCFullYear(), m: c.getUTCMonth() + 1, d: c.getUTCDate() });
        if (isTradingDay(key)) windowDays.push(key);
      }
      windowDays.reverse();
    }
    const inWindow = ref ? list.filter((d) => windowDays.includes(d)) : list;

    const underMin = equity < limit;
    const count = inWindow.length;
    const willTrigger = underMin && count + 1 > maxIn5;

    return {
      limit,
      equity,
      underMinimum: underMin,
      windowDays,
      count,
      maxAllowed: maxIn5,
      remaining: Math.max(0, maxIn5 - count),
      willTrigger,
      isPDT: underMin && count >= maxIn5,
      label: underMin ? '受限账户（净值 < $25,000）' : '不受 PDT 限制',
      note: willTrigger
        ? `5 个交易日内已完成 ${count} 次日内交易，本次为第 ${count + 1} 次，将触发 PDT 限制（冻结 90 天）。`
        : underMin
        ? `5 个交易日内剩余 ${Math.max(0, maxIn5 - count)} 次日内交易额度。`
        : '账户净值达到 $25,000，不受日内交易次数限制。',
    };
  }

  /**
   * SSR 做空提价规则（Reg SHO Rule 201）。
   * 前一日收盘跌幅 ≥ 10% → 当日与次日的做空只能以高于当前最优买价成交。
   */
  function ssrCheck(prevClose, close) {
    if (!prevClose || !close) return { active: false, changePct: 0, label: '数据不足', note: '' };
    const chg = ((close - prevClose) / prevClose) * 100;
    const active = chg <= -10;
    return {
      active,
      changePct: Number(chg.toFixed(2)),
      threshold: -10,
      label: active ? 'SSR 已触发（做空提价限制）' : 'SSR 未触发',
      note: active
        ? `前一日跌幅 ${chg.toFixed(2)}% ≤ -10%，今日做空必须以高于全国最优买价的价格成交，且次日继续适用。`
        : `前一日跌幅 ${chg.toFixed(2)}%，未达 -10% 门槛，做空不受提价规则限制。`,
    };
  }

  /**
   * LULD 个股涨跌停价格带。
   * Tier 1（标普500/罗素1000 成分且价格 > $3）±5%；Tier 2（其他 > $3）±10%；
   * $0.75–$3 区间 ±20%；低于 $0.75 使用更宽的双档规则。
   */
  function luldBands(price, tier) {
    const p = Number(price) || 0;
    let pct;
    let tierLabel;
    if (p < 0.75) {
      pct = 0.75;
      tierLabel = '低价股档（< $0.75）';
    } else if (p <= 3) {
      pct = 0.2;
      tierLabel = '低价股档（$0.75 – $3）';
    } else if (tier === 1) {
      pct = 0.05;
      tierLabel = 'Tier 1（标普500 / 罗素1000 成分）';
    } else {
      pct = 0.1;
      tierLabel = 'Tier 2（其他）';
    }
    return {
      price: p,
      tier: tierLabel,
      pct: pct * 100,
      lower: Number((p * (1 - pct)).toFixed(4)),
      upper: Number((p * (1 + pct)).toFixed(4)),
      pauseSeconds: 15,
      note: `价格带 ±${(pct * 100).toFixed(1)}%，越界进入 15 秒限制期；15 秒内未回到带内则暂停交易 5 分钟。`,
    };
  }

  /**
   * 市场级熔断（基于标普 500 相对前收盘的跌幅）。
   * Level 1 -7% / Level 2 -13%：各停 15 分钟，15:25 后不再触发；
   * Level 3 -20%：当日剩余时间休市。
   */
  function circuitBreaker(spxChangePct) {
    const c = Number(spxChangePct) || 0;
    if (c <= -20) {
      return {
        level: 3,
        label: '三级熔断',
        triggered: true,
        action: '当日剩余时间全部市场休市，次日恢复。',
        color: 'danger',
      };
    }
    if (c <= -13) {
      return {
        level: 2,
        label: '二级熔断',
        triggered: true,
        action: '全市场暂停交易 15 分钟；若在 15:25 之后触发则不执行。',
        color: 'warn',
      };
    }
    if (c <= -7) {
      return {
        level: 1,
        label: '一级熔断',
        triggered: true,
        action: '全市场暂停交易 15 分钟；若在 15:25 之后触发则不执行。',
        color: 'warn',
      };
    }
    return {
      level: 0,
      label: '未触发',
      triggered: false,
      distanceToL1: Number((c + 7).toFixed(2)),
      action: `距一级熔断（-7%）还有 ${Math.abs(c + 7).toFixed(2)} 个百分点。`,
      color: 'ok',
    };
  }

  // ============================================================ 订单可提交性

  /**
   * 判断某订单类型在给定时段能否提交。
   * 个人自用最容易踩的坑：盘前盘后只能挂限价单，MOO/MOC 有截止时间。
   */
  function orderAvailability(typeKey, phaseInfo) {
    const type = ORDER_TYPE_MAP[typeKey];
    if (!type) return { ok: false, reason: '未知订单类型' };
    const phase = phaseInfo && phaseInfo.phase;
    const half = phaseInfo && phaseInfo.day && phaseInfo.day.isHalfDay;
    const et = (phaseInfo && phaseInfo.et) || '';
    const mins = et ? Number(et.slice(0, 2)) * 60 + Number(et.slice(3, 5)) : 0;

    if (phase === 'closed') {
      return { ok: false, reason: '当前休市，仅可预约下一交易日的订单。' };
    }
    if (phase === 'pre' || phase === 'after') {
      if (typeKey === 'market' || typeKey === 'stop') {
        return {
          ok: false,
          reason: `${type.name}在盘前盘后不可用：此时段流动性差、价差大，券商只接受限价单。请改用限价单。`,
        };
      }
      if (typeKey === 'moc' || typeKey === 'loc' || typeKey === 'clo') {
        return { ok: false, reason: `${type.name}只能在常规时段提交。` };
      }
      if (typeKey === 'moo') {
        return { ok: phase === 'pre' && !half, reason: phase === 'pre' ? '盘前提交，开盘集合竞价成交。' : 'MOO 需在开盘前提交。' };
      }
      return { ok: true, reason: `${type.name}可在${phase === 'pre' ? '盘前' : '盘后'}时段提交（限价单）。` };
    }
    // 常规时段
    const mocCut = half ? 12 * 60 + 45 : 15 * 60 + 50;
    if (typeKey === 'moc' || typeKey === 'loc' || typeKey === 'clo') {
      if (mins > mocCut) {
        return { ok: false, reason: `${type.name} 已于 ${Math.floor(mocCut / 60)}:${pad(mocCut % 60)} 截止提交。` };
      }
      return { ok: true, reason: `${type.name}将于收盘集合竞价成交，提交截止 ${Math.floor(mocCut / 60)}:${pad(mocCut % 60)}。` };
    }
    if (typeKey === 'moo') return { ok: false, reason: 'MOO 只能在开盘前提交。' };
    return { ok: true, reason: `${type.name}在常规时段可用。` };
  }

  // ============================================================ 费用

  /**
   * 单笔成交的费用明细。
   * @param {Object} o
   * @param {'buy'|'sell'} o.side
   * @param {Number} o.shares
   * @param {Number} o.price
   * @param {Object} [o.fees] 覆盖 FEE_DEFAULTS
   * @param {Number} [o.holdDays] 做空持仓天数，用于借券费
   * @param {Boolean} [o.short]
   */
  function computeFees(o) {
    const side = o.side === 'sell' ? 'sell' : 'buy';
    const shares = Math.abs(Number(o.shares) || 0);
    const price = Number(o.price) || 0;
    const f = { ...FEE_DEFAULTS, ...(o.fees || {}) };
    const amount = shares * price;
    const out = {};

    // 佣金：按股计，且不低于最低值
    out.commission = Math.max(f.commission * shares, shares > 0 ? f.commissionMin : 0);

    // SEC 费与 FINRA TAF 只在卖出方收取
    out.sec = side === 'sell' ? amount * f.secRate : 0;
    out.taf = side === 'sell' ? Math.min(shares * f.tafRate, f.tafCap) : 0;

    // 交易所费、清算费、CAT 费双边都收
    out.exchange = amount * f.exchangeRate;
    out.clearing = shares * f.clearingRate;
    out.cat = shares * f.catRate;

    // 借券费：做空持仓按年费率折算
    const holdDays = Number(o.holdDays) || 0;
    out.borrow = o.short && holdDays > 0 ? (amount * f.shortBorrowRate * holdDays) / 365 : 0;

    out.total =
      out.commission + out.sec + out.taf + out.exchange + out.clearing + out.cat + out.borrow;
    out.amount = amount;
    out.side = side;
    out.shares = shares;
    out.price = price;
    out.bpsOfAmount = amount > 0 ? Number(((out.total / amount) * 10000).toFixed(3)) : 0;
    return out;
  }

  /** 买卖价差成本（拿不到盘口时用基点估算） */
  function spreadCost(price, shares, bps) {
    const b = Number(bps == null ? FEE_DEFAULTS.spreadBps : bps);
    const half = (Number(price) || 0) * (b / 10000) / 2;
    return { perShare: half, total: half * (Number(shares) || 0), bps: b };
  }

  // ============================================================ 交易日历工具

  /** 从某天起往后取 n 个交易日 */
  function nextTradingDays(from, n) {
    const { y, m, d } = ymd(from);
    const out = [];
    for (let i = 0; i < n * 3 + 12 && out.length < n; i++) {
      const c = new Date(Date.UTC(y, m - 1, d + i));
      const key = iso({ y: c.getUTCFullYear(), m: c.getUTCMonth() + 1, d: c.getUTCDate() });
      if (isTradingDay(key)) out.push(key);
    }
    return out;
  }

  /** 两个日期之间的交易日数量 */
  function tradingDaysBetween(a, b) {
    const A = ymd(a);
    const B = ymd(b);
    const d1 = Date.UTC(A.y, A.m - 1, A.d);
    const d2 = Date.UTC(B.y, B.m - 1, B.d);
    if (d2 < d1) return -tradingDaysBetween(b, a);
    let n = 0;
    for (let t = d1; t < d2; t += 86400000) {
      const c = new Date(t);
      if (isTradingDay(iso({ y: c.getUTCFullYear(), m: c.getUTCMonth() + 1, d: c.getUTCDate() }))) n++;
    }
    return n;
  }

  /** 判断某个 'YYYY-MM-DD' 是否假期并给出名称（无则 null） */
  function holidayOf(input) {
    const { y, m, d } = ymd(input);
    const h = holidayMap(y).get(iso({ y, m, d }));
    return h || null;
  }

  /** 某时间段内的假期清单（用于回测「假期不交易」核对） */
  function holidaysBetween(a, b) {
    const A = ymd(a);
    const B = ymd(b);
    const out = [];
    for (let y = A.y; y <= B.y; y++) for (const h of holidays(y)) if (h.date >= iso(A) && h.date <= iso(B)) out.push(h);
    return out.sort((x, y2) => x.date.localeCompare(y2.date));
  }

  /** 后续交易日场景：下一个交易日、下一假期、下一半日市 */
  function upcoming(now) {
    const t = now instanceof Date ? now : new Date(now || Date.now());
    const p = etParts(t);
    const next = nextTradingDays(p.date, 2);
    const y = p.y;
    const nxtHoliday = [...holidays(y), ...holidays(y + 1)].find((h) => h.date > p.date);
    const nxtHalf = [...halfDays(y), ...halfDays(y + 1)].find((h) => h.date >= p.date);
    return {
      today: p.date,
      todayIsTradingDay: isTradingDay(p.date),
      nextTradingDay: next[0] || null,
      followingTradingDay: next[1] || null,
      nextHoliday: nxtHoliday || null,
      nextHalfDay: nxtHalf || null,
      daysToNextHoliday: nxtHoliday ? tradingDaysBetween(p.date, nxtHoliday.date) : null,
    };
  }

  return {
    SESSION,
    FEE_DEFAULTS,
    ORDER_TYPES,
    ORDER_TYPE_MAP,
    // 日历
    holidays,
    halfDays,
    isTradingDay,
    dayInfo,
    holidayOf,
    holidaysBetween,
    // 时区
    etOffset,
    etParts,
    isDST,
    session,
    upcoming,
    // 规则
    settleDate,
    pdtCheck,
    ssrCheck,
    luldBands,
    circuitBreaker,
    orderAvailability,
    // 费用
    computeFees,
    spreadCost,
    // 工具
    nextTradingDays,
    tradingDaysBetween,
    weekdayOf,
    nthWeekday,
  };
});
