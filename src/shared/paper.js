/**
 * paper.js —— 模拟交易账户（Paper Trading）
 *
 * 个人自用版里，模拟盘的作用不是「假装赚钱」，而是在不冒真金白银的前提下
 * 把下单、撤单、成交、持仓、对账这条链路走通，暴露真实规则带来的摩擦：
 * 限价单挂不上、盘前只能限价、PDT 次数用满、T+1 资金没结算、部分成交。
 *
 * 设计要点：
 *   - 撮合走 market.js 的规则与费用，与回测共用同一套，避免「回测赚、模拟亏」
 *   - 订单状态机：pending → submitted → partially_filled → filled
 *                                             ↘ cancelled / rejected / expired
 *   - 幂等：每单带 idempotencyKey，重复提交直接返回原单，不重复下单
 *   - 资金：区分「可用现金」与「已结算现金」（T+1）
 *   - 可序列化：toJSON / fromJSON，方便存进本地 store
 *
 * 纯本地撮合，不联网、不真实下单。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./market'), require('./risk'));
  } else {
    root.Paper = factory(root.Market, root.Risk);
  }
})(typeof self !== 'undefined' ? self : this, function (Market, Risk) {
  const ORDER_STATUS = {
    pending: { label: '待提交', tone: 'flat' },
    submitted: { label: '已委托', tone: 'flat' },
    partially_filled: { label: '部分成交', tone: 'warn' },
    filled: { label: '已成交', tone: 'up' },
    cancelled: { label: '已撤单', tone: 'flat' },
    rejected: { label: '已拒绝', tone: 'down' },
    expired: { label: '已过期', tone: 'flat' },
  };

  let seq = 0;
  function uid(prefix) {
    seq++;
    return `${prefix || 'id'}_${Date.now().toString(36)}_${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  function n(v, d) {
    const x = Number(v);
    return isFinite(x) ? x : d == null ? 0 : d;
  }

  function today() {
    return new Date().toISOString().slice(0, 10);
  }

  /**
   * 幂等键：同一账户 + 标的 + 方向 + 数量 + 价格 + 当日，视为同一笔意图。
   *
   * 价格只对限价类订单进键：市价单的价格是「下单那一刻的行情」，每秒都在跳，
   * 把它写进键会让「同一意图重复提交」因为价格微变而躲过去重 —— 那正是
   * 幂等要防的重复下单。限价单的价格是用户意图的一部分，必须进键。
   */
  function idemKey(o) {
    const t = o.type || 'market';
    const px = t === 'market' ? 0 : n(o.limitPrice) || n(o.price) || 0;
    return [o.symbol, o.side, t, n(o.shares), px, o.tif || 'day'].join('|');
  }

  class PaperAccount {
    /**
     * @param {Object} opt { initialCash, name, limits, feeOverrides, slippageBps, participationRate }
     */
    constructor(opt) {
      const o = opt || {};
      this.id = o.id || uid('acct');
      this.name = o.name || '模拟账户';
      this.currency = 'USD';
      this.initialCash = n(o.initialCash, 100000);
      this.createdAt = o.createdAt || new Date().toISOString();
      this.cash = n(o.cash, this.initialCash);
      this.settledCash = n(o.settledCash, this.initialCash); // T+1 已结算
      this.orders = o.orders || [];
      this.positions = o.positions || []; // { symbol, side, shares, avgPrice, openedAt, sector, borrowRate, shortInterestPct }
      this.trades = o.trades || [];
      this.dayTrades = o.dayTrades || []; // [{ date, symbol }]
      this.pendingSettlements = o.pendingSettlements || []; // T+1 待结算：[{ date, amount, settleDate }]
      this.equityHistory = o.equityHistory || [];
      this.realizedPnl = n(o.realizedPnl);
      this.totalFees = n(o.totalFees);
      this.slippageBps = o.slippageBps == null ? 3 : o.slippageBps; // 默认 3bps
      this.participationRate = o.participationRate == null ? 0.05 : o.participationRate; // 单根K线最多吃掉 5% 成交量
      this.limits = { ...(Risk ? Risk.DEFAULT_LIMITS : {}), ...(o.limits || {}) };
      this.feeOverrides = o.feeOverrides || {};
      this.logs = o.logs || []; // 事件日志，用于审计
    }

    // ---------------------------------------------------------- 序列化

    toJSON() {
      return {
        id: this.id, name: this.name, currency: this.currency,
        initialCash: this.initialCash, createdAt: this.createdAt,
        cash: this.cash, settledCash: this.settledCash,
        orders: this.orders, positions: this.positions, trades: this.trades,
        dayTrades: this.dayTrades, pendingSettlements: this.pendingSettlements,
        equityHistory: this.equityHistory,
        realizedPnl: this.realizedPnl, totalFees: this.totalFees,
        slippageBps: this.slippageBps, participationRate: this.participationRate,
        limits: this.limits, feeOverrides: this.feeOverrides, logs: this.logs.slice(-400),
      };
    }

    static fromJSON(json) {
      return new PaperAccount(json || {});
    }

    log(type, detail, extra) {
      this.logs.push({ at: new Date().toISOString(), type, detail, ...(extra || {}) });
      if (this.logs.length > 500) this.logs.shift();
    }

    // ---------------------------------------------------------- 查询

    positionOf(symbol) {
      return this.positions.find((p) => p.symbol === symbol) || null;
    }

    /** 持仓市值与浮盈 */
    positionsValue(quotes) {
      const q = quotes || {};
      let mv = 0;
      const rows = this.positions.map((p) => {
        const price = n(q[p.symbol] != null ? q[p.symbol] : p.lastPrice, p.avgPrice);
        const value = Math.abs(p.shares) * price;
        const cost = Math.abs(p.shares) * p.avgPrice;
        const sign = p.side === 'short' ? -1 : 1;
        const pnl = sign * (value - cost);
        mv += sign * value;
        return {
          ...p, price, value, cost, pnl,
          pnlPct: cost > 0 ? (pnl / cost) * 100 : 0,
          weight: 0, // 由 equity() 回填
        };
      });
      return { marketValue: mv, rows };
    }

    /** 账户净值 = 现金 + 持仓市值（空头为负） */
    equity(quotes) {
      const pv = this.positionsValue(quotes);
      const total = this.cash + pv.marketValue;
      const rows = pv.rows.map((r) => ({ ...r, weight: total > 0 ? (r.value / total) * 100 : 0 }));
      return {
        equity: total,
        cash: this.cash,
        settledCash: this.settledCash,
        marketValue: pv.marketValue,
        longValue: rows.filter((r) => r.side !== 'short').reduce((s, r) => s + r.value, 0),
        shortValue: rows.filter((r) => r.side === 'short').reduce((s, r) => s + r.value, 0),
        unrealizedPnl: rows.reduce((s, r) => s + r.pnl, 0),
        realizedPnl: this.realizedPnl,
        totalReturnPct: this.initialCash > 0 ? ((total - this.initialCash) / this.initialCash) * 100 : 0,
        positions: rows,
      };
    }

    /** 可用购买力：现金（现金账户）或 2 倍（保证金口径，个人自用保守取 1x 现金 + 已结算部分） */
    buyingPower() {
      return Math.max(0, this.cash);
    }

    // ---------------------------------------------------------- 下单

    /**
     * 提交订单。
     * @param {Object} order { symbol, side, type, shares, price, limitPrice, stopPrice,
     *                         tif, quote, session, sector, idempotencyKey, parentId, notes }
     * @returns {{ok, order, blocked, warnings, duplicate}}
     */
    submit(order) {
      const o = { ...order };
      o.symbol = String(o.symbol || '').toUpperCase();
      o.side = o.side || 'buy';
      o.type = o.type || 'market';
      o.shares = Math.abs(n(o.shares));
      o.tif = o.tif || 'day';

      // 参考价：市价单用它做风控估值，限价单用它判断是否穿越。
      // 三个字段名都要认 —— 外部脚本习惯传 quote（行情快照），界面传 price（已取到的现价），
      // 只认其中一个会让另一种调用方直接被判「价格无效」，而且看起来像行情没取到。
      const refPrice = n(o.price) || n(o.limitPrice) || n(o.quote) || this._lastPrice(o.symbol) || 0;
      o.refPrice = refPrice;

      // 幂等：同一意图重复提交，直接返回已有订单
      const key = o.idempotencyKey || idemKey(o);
      const dup = this.orders.find((x) => x.idempotencyKey === key && (x.status === 'submitted' || x.status === 'partially_filled'));
      if (dup) {
        this.log('duplicate', `重复提交被忽略：${o.symbol} ${o.side} ${o.shares}`);
        return { ok: true, order: dup, duplicate: true, blocked: [], warnings: [] };
      }

      // 平仓类订单必须先有对应持仓，且不能被在途挂单重复占用
      if (o.side === 'sell' || o.side === 'cover') {
        const wantSide = o.side === 'cover' ? 'short' : 'long';
        const pos = this.positions.find((p) => p.symbol === o.symbol && (p.side === 'short' ? 'short' : 'long') === wantSide);
        const held = pos ? Math.abs(pos.shares) : 0;
        const inFlight = this.orders
          .filter((x) => x.symbol === o.symbol && x.side === o.side && (x.status === 'submitted' || x.status === 'partially_filled'))
          .reduce((s, x) => s + (x.shares - x.filledShares), 0);
        const free = held - inFlight;
        if (free < o.shares) {
          const reason = `可平数量不足：${o.symbol} ${wantSide === 'short' ? '空头' : '多头'}持仓 ${held} 股，在途挂单已占用 ${inFlight} 股，可用 ${Math.max(0, free)} 股，本单需要 ${o.shares} 股。`;
          const rejected = this._reject(o, key, reason);
          return { ok: false, order: rejected, blocked: [{ title: '可平数量不足', detail: reason }], warnings: [] };
        }
      }

      // 时段与订单类型的可用性（美股硬规则）
      const session = o.session || (Market ? Market.session(new Date()) : { phase: 'regular', et: '10:00', day: {} });
      const avail = Market ? Market.orderAvailability(o.type, session) : { ok: true, reason: '' };
      if (!avail.ok) {
        const rejected = this._reject(o, key, avail.reason);
        return { ok: false, order: rejected, blocked: [{ title: '订单类型不可用', detail: avail.reason }], warnings: [] };
      }

      // 风控预检
      let pre = null;
      if (Risk) {
        const eq = this.equity(o.quote);
        pre = Risk.preTrade({
          order: { ...o, price: refPrice },
          account: {
            equity: eq.equity, cash: this.cash, buyingPower: this.buyingPower(),
            dayStartEquity: this._dayStartEquity(), peakEquity: this._peakEquity(),
          },
          positions: this.positions,
          dayTrades: this.dayTrades,
          limits: this.limits,
          market: o.market || {},
          state: o.state || {},
        });
        if (!pre.passed) {
          const rejected = this._reject(o, key, pre.blocks.map((b) => b.title).join('；'));
          this.log('reject', `风控拦截：${rejected.reason}`);
          return { ok: false, order: rejected, blocked: pre.blocks, warnings: pre.warns, pre };
        }
      }

      const ord = {
        id: uid('ord'),
        idempotencyKey: key,
        symbol: o.symbol,
        side: o.side,
        type: o.type,
        shares: o.shares,
        filledShares: 0,
        avgFillPrice: 0,
        limitPrice: n(o.limitPrice),
        stopPrice: n(o.stopPrice),
        price: refPrice,
        tif: o.tif,
        status: 'submitted',
        createdAt: new Date().toISOString(),
        submittedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        session: session.phase,
        sector: o.sector || (Risk ? Risk.sectorOf({ symbol: o.symbol }) : '未分类'),
        parentId: o.parentId || null,
        ocoGroup: o.ocoGroup || null,
        legs: o.legs || null,
        fills: [],
        reason: '',
        notes: o.notes || '',
      };
      this.orders.push(ord);
      this.log('submit', `${ord.side} ${ord.shares} 股 ${ord.symbol}（${ord.type}）`, { orderId: ord.id });
      return { ok: true, order: ord, blocked: [], warnings: pre ? pre.warns : [], pre };
    }

    _reject(o, key, reason) {
      const ord = {
        id: uid('ord'), idempotencyKey: key, symbol: o.symbol, side: o.side, type: o.type,
        shares: o.shares, filledShares: 0, avgFillPrice: 0,
        limitPrice: n(o.limitPrice), stopPrice: n(o.stopPrice), price: n(o.refPrice) || n(o.price),
        tif: o.tif, status: 'rejected', createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(), reason, fills: [],
      };
      this.orders.push(ord);
      return ord;
    }

    /** 撤单 */
    cancel(orderId) {
      const ord = this.orders.find((x) => x.id === orderId);
      if (!ord) return { ok: false, error: '订单不存在' };
      if (ord.status === 'filled' || ord.status === 'cancelled' || ord.status === 'rejected') {
        return { ok: false, error: `订单已是「${ORDER_STATUS[ord.status].label}」状态，无法撤销` };
      }
      ord.status = 'cancelled';
      ord.updatedAt = new Date().toISOString();
      ord.reason = '用户撤单';
      this.log('cancel', `撤单 ${ord.symbol} ${ord.shares} 股`, { orderId: ord.id });
      // OCO：一腿撤销，同组其他腿一并撤销
      if (ord.ocoGroup) {
        for (const other of this.orders) {
          if (other.ocoGroup === ord.ocoGroup && other.id !== ord.id &&
              (other.status === 'submitted' || other.status === 'partially_filled')) {
            other.status = 'cancelled';
            other.reason = 'OCO 同组订单已撤';
            other.updatedAt = new Date().toISOString();
          }
        }
      }
      return { ok: true, order: ord };
    }

    cancelAll(symbol) {
      const list = this.orders.filter(
        (o) => (o.status === 'submitted' || o.status === 'partially_filled') && (!symbol || o.symbol === symbol)
      );
      const done = list.map((o) => this.cancel(o.id));
      return { cancelled: done.filter((d) => d.ok).length, total: list.length };
    }

    // ---------------------------------------------------------- 撮合

    _lastPrice(symbol) {
      const p = this.positionOf(symbol);
      if (p && p.lastPrice) return p.lastPrice;
      const lastTrade = [...this.trades].reverse().find((t) => t.symbol === symbol);
      return lastTrade ? lastTrade.price : 0;
    }

    _dayStartEquity() {
      const d = today();
      const rec = [...this.equityHistory].reverse().find((h) => String(h.date).slice(0, 10) < d);
      return rec ? rec.value : this.cash;
    }

    _peakEquity() {
      if (!this.equityHistory.length) return this.cash;
      return Math.max(...this.equityHistory.map((h) => h.value));
    }

    /**
     * 用最新行情撮合所有挂单，并更新持仓与净值。
     * @param {Object} bars { SYMBOL: { date, open, high, low, close, volume } }
     * @param {Object} [opt] { date, session, slippageBps }
     * @returns {{fills, orders, equity, dayTradesUsed}}
     */
    mark(bars, opt) {
      const o = opt || {};
      const date = o.date || today();
      // 时段口径：一根完整的日线代表「该交易日的常规时段」。
      // 不能用「现在几点」去判定历史 K 线，否则回放时市价单会被按收盘价成交。
      let session = o.session;
      if (!session) {
        const trading = Market ? Market.isTradingDay(date) : true;
        session = trading
          ? Market.session(new Date(`${date}T14:00:00Z`)) // 该交易日 10:00 ET = 常规时段
          : { phase: 'regular', label: '常规（历史交易日回放）', day: {}, et: '10:00' };
      }
      const slip = (o.slippageBps == null ? this.slippageBps : o.slippageBps) / 10000;
      const fills = [];

      for (const ord of this.orders) {
        if (ord.status !== 'submitted' && ord.status !== 'partially_filled') continue;
        const bar = (bars || {})[ord.symbol];
        if (!bar) continue;
        const f = this._matchOne(ord, bar, session, slip, date);
        if (f && f.shares > 0) {
          fills.push(f);
          // 注意：filledShares 是在 _applyFill 里自增的，
          // 不能拿它当「是否成交」的判据（那样永远是 0 > 0，撮合结果会被丢掉）。
          this._applyFill(ord, f, date);
        }
      }

      // 更新持仓最新价并记录净值
      for (const p of this.positions) {
        const bar = (bars || {})[p.symbol];
        if (bar && bar.close > 0) p.lastPrice = bar.close;
      }
      const eq = this.equity(o.quotes);
      const last = this.equityHistory[this.equityHistory.length - 1];
      if (!last || last.date !== date) this.equityHistory.push({ date, value: eq.equity, cash: this.cash, position: this.positions.length > 0 });
      else {
        last.value = eq.equity;
        last.cash = this.cash;
        last.position = this.positions.length > 0;
      }
      if (this.equityHistory.length > 2000) this.equityHistory = this.equityHistory.slice(-2000);

      return { fills, equity: eq, dayTradesUsed: this.dayTrades.length, date, session: session.phase };
    }

    /** 单张订单的撮合逻辑，返回本次成交或 null */
    _matchOne(ord, bar, session, slip, date) {
      const remaining = ord.shares - ord.filledShares;
      if (remaining <= 0) return null;

      const open = n(bar.open), high = n(bar.high), low = n(bar.low), close = n(bar.close);
      if (!(high > 0) || !(low > 0)) return null;

      // 可成交量：单根 K 线最多吃掉成交量的 participationRate
      const vol = n(bar.volume);
      const maxByVolume = vol > 0 ? Math.floor(vol * this.participationRate) : remaining;
      const size = Math.max(0, Math.min(remaining, maxByVolume || remaining));
      if (size <= 0) return null;

      const isBuy = ord.side === 'buy' || ord.side === 'cover';
      let price = null;
      let reason = '';

      switch (ord.type) {
        case 'market':
        case 'moo': {
          // 盘前盘后只能限价单；市价单按开盘价 + 滑点
          const ref = ord.type === 'moo' ? open : (session.phase === 'regular' ? open : close);
          price = ref * (1 + (isBuy ? slip : -slip));
          reason = ord.type === 'moo' ? '开盘集合竞价' : '市价成交';
          break;
        }
        case 'moc': {
          price = close * (1 + (isBuy ? slip : -slip));
          reason = '收盘集合竞价';
          break;
        }
        case 'limit':
        case 'loc':
        case 'clo':
        case 'iceberg': {
          const L = ord.limitPrice;
          if (!(L > 0)) return null;
          const touched = isBuy ? low <= L : high >= L;
          if (!touched) return null;
          // 买单取「限价与开盘价中的较低者」，更贴近真实成交
          price = isBuy ? Math.min(L, open > 0 ? open : L) : Math.max(L, open > 0 ? open : L);
          // 触发方向不对时按限价成交
          if (isBuy && price > L) price = L;
          if (!isBuy && price < L) price = L;
          reason = '限价触及';
          break;
        }
        case 'stop':
        case 'stop_limit': {
          const S = ord.stopPrice;
          if (!(S > 0)) return null;
          const triggered = isBuy ? high >= S : low <= S;
          if (!triggered) return null;
          if (ord.type === 'stop_limit') {
            const L = ord.limitPrice > 0 ? ord.limitPrice : S;
            const touched = isBuy ? low <= L : high >= L;
            if (!touched) return null;
            price = L;
            reason = '止损限价触发';
          } else {
            price = S * (1 + (isBuy ? slip : -slip));
            reason = '止损触发，转市价';
          }
          break;
        }
        case 'twap':
        case 'vwap': {
          // 算法单按当日均价近似，滑点略小
          const vw = (high + low + close) / 3;
          price = vw * (1 + (isBuy ? slip * 0.5 : -slip * 0.5));
          reason = ord.type === 'twap' ? '时间加权均价' : '成交量加权均价';
          break;
        }
        default:
          return null;
      }

      if (!(price > 0)) return null;
      // 价格不能超出当日区间（极端跳空时按区间边界收）
      if (high >= low) price = Math.min(Math.max(price, low), high);

      return {
        orderId: ord.id, symbol: ord.symbol, side: ord.side, shares: size,
        price: Number(price.toFixed(4)), date, reason,
        partial: size < remaining,
        volumeLimited: vol > 0 && size < remaining,
      };
    }

    /** 把成交写进账户：现金、手续费、持仓、交易流水、日内交易计数 */
    _applyFill(ord, fill, date) {
      const side = fill.side;
      const fees = Market
        ? Market.computeFees({
            side: side === 'buy' || side === 'cover' ? 'buy' : 'sell',
            shares: fill.shares, price: fill.price, fees: this.feeOverrides,
          })
        : { total: 0 };
      const gross = fill.shares * fill.price;

      // 四个方向要分清两件事：现金方向 与 持仓方向
      //   buy   加多：现金减    sell  平多：现金加
      //   short 开空：现金加    cover 平空：现金减
      const cashOut = side === 'buy' || side === 'cover';
      const increase = side === 'buy' || side === 'short'; // 是否在扩大持仓
      const targetSide = side === 'short' || side === 'cover' ? 'short' : 'long';

      if (cashOut) this.cash -= gross + fees.total;
      else this.cash += gross - fees.total;
      this.totalFees += fees.total;

      // 加权平均成交价
      const prevQty = ord.filledShares;
      ord.avgFillPrice = (ord.avgFillPrice * prevQty + fill.price * fill.shares) / (prevQty + fill.shares);
      ord.filledShares += fill.shares;
      ord.updatedAt = new Date().toISOString();
      ord.fills.push({ ...fill, fee: fees.total });
      ord.status = ord.filledShares >= ord.shares ? 'filled' : 'partially_filled';

      // 更新持仓
      let pos = this.positions.find((p) => p.symbol === ord.symbol && (p.side === 'short' ? 'short' : 'long') === targetSide);

      if (!pos && increase) {
        pos = {
          symbol: ord.symbol, side: targetSide, shares: 0, avgPrice: 0,
          openedAt: date, lastPrice: fill.price, sector: ord.sector || '未分类',
          borrowRate: n(ord.borrowRate), shortInterestPct: n(ord.shortInterestPct),
        };
        this.positions.push(pos);
      }

      if (pos) {
        const dir = increase ? 1 : -1;
        const newShares = pos.shares + dir * fill.shares;
        if (dir > 0) {
          // 加仓：更新均价
          pos.avgPrice = (pos.avgPrice * pos.shares + fill.price * fill.shares) / (pos.shares + fill.shares);
        }
        // 平仓盈亏
        if (dir < 0) {
          const cost = pos.avgPrice * fill.shares;
          const proceeds = fill.price * fill.shares - fees.total;
          const pnl = pos.side === 'short' ? cost - proceeds : proceeds - cost;
          this.realizedPnl += pnl;
          const openDate = pos.openedAt || date;
          const holdDays = Math.max(
            0,
            Math.round((new Date(date).getTime() - new Date(openDate).getTime()) / 86400000)
          );
          this.trades.push({
            date, symbol: ord.symbol, type: 'sell', side: pos.side,
            shares: fill.shares, price: fill.price, amount: gross, fee: fees.total,
            profit: pnl, profitPct: cost > 0 ? (pnl / cost) * 100 : 0,
            holdDays, entryPrice: pos.avgPrice, entryAmount: cost,
            entryDate: openDate, sector: pos.sector, orderId: ord.id,
          });
          // 日内交易计数（当天开、当天平）
          if (holdDays === 0) this.dayTrades.push({ date, symbol: ord.symbol, orderId: ord.id });
          // T+1 待结算资金
          this.pendingSettlements.push({
            date, amount: Math.max(0, proceeds), symbol: ord.symbol,
            settleDate: Market ? Market.settleDate(date).date : date,
          });
        } else {
          this.trades.push({
            date, symbol: ord.symbol, type: 'buy', side: pos.side,
            shares: fill.shares, price: fill.price, amount: gross, fee: fees.total,
            sector: pos.sector, orderId: ord.id,
          });
        }
        pos.shares = Math.abs(newShares) < 1e-9 ? 0 : newShares;
        pos.lastPrice = fill.price;
        if (Math.abs(pos.shares) < 1e-9) this.positions = this.positions.filter((p) => p !== pos);
      }

      // OCO：一腿成交，同组另一腿撤销
      if (ord.ocoGroup && ord.status === 'filled') {
        for (const other of this.orders) {
          if (other.ocoGroup === ord.ocoGroup && other.id !== ord.id &&
              (other.status === 'submitted' || other.status === 'partially_filled')) {
            other.status = 'cancelled';
            other.reason = 'OCO 同组订单已成交';
            other.updatedAt = new Date().toISOString();
          }
        }
      }

      this.log('fill', `${ord.side} ${fill.shares} 股 ${ord.symbol} @ $${fill.price}（${fill.reason}）`, { orderId: ord.id, fee: fees.total });
    }

    /**
     * 结算：把 T+1 到期的卖出资金转为已结算。
     * 美股自 2024-05-28 起为 T+1，周五卖出下周一结算（遇假期顺延）。
     * @param {String} [asOfDate] 结算基准日（'YYYY-MM-DD'）
     */
    settle(asOfDate) {
      const date = asOfDate || today();
      const stillPending = [];
      let released = 0;
      for (const c of this.pendingSettlements) {
        if (!c.settleDate || c.settleDate <= date) released += c.amount;
        else stillPending.push(c);
      }
      this.pendingSettlements = stillPending;
      this.settledCash = Math.max(0, this.settledCash + released);
      if (released > 0) this.log('settle', `T+1 结算释放 $${released.toFixed(2)}`);
      return {
        released,
        settledCash: this.settledCash,
        pending: this.pendingSettlements.reduce((s, c) => s + c.amount, 0),
        pendingCount: this.pendingSettlements.length,
      };
    }

    // ---------------------------------------------------------- 对账

    /**
     * 与券商快照对账，找出持仓 / 现金差异。
     * @param {Object} snap { cash, positions:[{symbol, shares}], orders:[{id, status}] }
     */
    reconcile(snap) {
      const s = snap || {};
      const diffs = [];

      if (s.cash != null && Math.abs(n(s.cash) - this.cash) > 0.01) {
        diffs.push({
          type: 'cash',
          level: Math.abs(n(s.cash) - this.cash) > this.cash * 0.01 ? 'high' : 'low',
          local: this.cash, remote: n(s.cash), delta: n(s.cash) - this.cash,
          detail: `现金不一致：本地 $${this.cash.toFixed(2)}，券商 $${n(s.cash).toFixed(2)}，差 $${(n(s.cash) - this.cash).toFixed(2)}。`,
        });
      }

      const remote = new Map((s.positions || []).map((p) => [String(p.symbol).toUpperCase(), n(p.shares)]));
      for (const p of this.positions) {
        const r = remote.get(p.symbol);
        if (r == null) {
          diffs.push({ type: 'position', level: 'high', symbol: p.symbol, local: p.shares, remote: null, detail: `${p.symbol} 本地持仓 ${p.shares} 股，券商无此持仓。` });
        } else if (Math.abs(r - p.shares) > 1e-6) {
          diffs.push({ type: 'position', level: 'high', symbol: p.symbol, local: p.shares, remote: r, detail: `${p.symbol} 股数不一致：本地 ${p.shares}，券商 ${r}。` });
          remote.delete(p.symbol);
        } else remote.delete(p.symbol);
      }
      for (const [sym, sh] of remote) {
        if (sh !== 0) diffs.push({ type: 'position', level: 'high', symbol: sym, local: null, remote: sh, detail: `${sym} 券商持有 ${sh} 股，本地无记录。` });
      }

      const remoteOrders = new Map((s.orders || []).map((o) => [o.id, o.status]));
      for (const o of this.orders) {
        const r = remoteOrders.get(o.id);
        if (r && r !== o.status) {
          diffs.push({ type: 'order', level: 'low', orderId: o.id, local: o.status, remote: r, detail: `订单 ${o.id} 状态不一致：本地 ${o.status}，券商 ${r}。` });
        }
      }

      const result = {
        ok: diffs.length === 0,
        diffs,
        high: diffs.filter((d) => d.level === 'high').length,
        low: diffs.filter((d) => d.level === 'low').length,
        summary: diffs.length ? `发现 ${diffs.length} 处不一致（${diffs.filter((d) => d.level === 'high').length} 处严重）。` : '对账一致，本地记录与券商快照完全吻合。',
        checkedAt: new Date().toISOString(),
      };
      this.lastReconcile = result;
      this.log('reconcile', result.summary);
      return result;
    }

    /** 账户统计：给界面用的汇总 */
    stats(quotes) {
      const eq = this.equity(quotes);
      const closed = this.trades.filter((t) => t.type === 'sell');
      const wins = closed.filter((t) => t.profit > 0);
      const pending = this.orders.filter((o) => o.status === 'submitted' || o.status === 'partially_filled');
      return {
        equity: eq,
        ordersCount: this.orders.length,
        pendingCount: pending.length,
        filledCount: this.orders.filter((o) => o.status === 'filled').length,
        rejectedCount: this.orders.filter((o) => o.status === 'rejected').length,
        tradeCount: closed.length,
        winRate: closed.length ? (wins.length / closed.length) * 100 : 0,
        realizedPnl: this.realizedPnl,
        unrealizedPnl: eq.unrealizedPnl,
        totalFees: this.totalFees,
        dayTradesUsed: this.dayTrades.length,
        dayTradeLog: this.dayTrades.slice(-10),
        pendingSettlements: this.pendingSettlements.reduce((s, c) => s + c.amount, 0),
        pending,
      };
    }

    /** 清空交易记录但保留资金（重新开始模拟） */
    reset(initialCash) {
      this.cash = n(initialCash, this.initialCash);
      this.settledCash = this.cash;
      this.orders = [];
      this.positions = [];
      this.trades = [];
      this.dayTrades = [];
      this.equityHistory = [];
      this.realizedPnl = 0;
      this.totalFees = 0;
      this.log('reset', `模拟账户重置，初始资金 $${this.cash.toFixed(2)}`);
      return this;
    }
  }

  /** 从回测结果批量导入成交到模拟盘（用于「把回测策略拉到模拟盘跑」） */
  function importTrades(account, trades, opt) {
    const o = opt || {};
    let imported = 0;
    for (const t of trades || []) {
      const ord = {
        id: uid('ord'), idempotencyKey: 'import_' + uid('k'),
        symbol: t.symbol || o.symbol || 'UNKNOWN', side: t.type === 'buy' ? 'buy' : 'sell',
        type: 'market', shares: Math.abs(n(t.shares)), filledShares: Math.abs(n(t.shares)),
        avgFillPrice: n(t.price), price: n(t.price), tif: 'day',
        status: 'filled', createdAt: new Date(t.date).toISOString(),
        updatedAt: new Date(t.date).toISOString(), session: 'regular',
        sector: t.sector || '未分类', fills: [], reason: '由回测导入', notes: '',
      };
      account.orders.push(ord);
      account.trades.push({
        date: t.date, symbol: ord.symbol, type: t.type, shares: ord.shares,
        price: ord.avgFillPrice, amount: n(t.amount), fee: n(t.fee),
        profit: t.profit, profitPct: t.profitPct, holdDays: t.holdDays,
        sector: ord.sector, orderId: ord.id,
      });
      imported++;
    }
    return { imported };
  }

  /** 生成一份「上线前模拟检查清单」 */
  function readiness(account) {
    const s = account.stats();
    const items = [
      { key: 'orders', label: '完成下单 / 撤单', pass: s.ordersCount >= 10, detail: `累计 ${s.ordersCount} 笔委托，建议至少 10 笔以覆盖各类订单类型。` },
      { key: 'fills', label: '覆盖成交与部分成交', pass: s.filledCount >= 5 && account.orders.some((o) => o.status === 'partially_filled'), detail: `已成交 ${s.filledCount} 笔。` },
      { key: 'reject', label: '验证过被拒绝路径', pass: s.rejectedCount >= 1, detail: s.rejectedCount ? `已产生 ${s.rejectedCount} 笔拒单，说明风控拦截链路有效。` : '还没有遇到拒单，建议主动测试风控拦截。' },
      { key: 'trades', label: '累计足够交易样本', pass: s.tradeCount >= 20, detail: `已平仓 ${s.tradeCount} 笔，建议 ≥20 笔再看胜率。` },
      { key: 'days', label: '持续运行时间', pass: account.equityHistory.length >= 20, detail: `已记录 ${account.equityHistory.length} 个交易日的净值。` },
      { key: 'recon', label: '完成对账', pass: !!(account.lastReconcile && account.lastReconcile.ok), detail: account.lastReconcile ? account.lastReconcile.summary : '尚未执行对账。' },
      { key: 'drawdown', label: '经历过一次回撤', pass: (() => { const h = account.equityHistory.map((x) => x.value); if (h.length < 2) return false; let pk = h[0]; return h.some((v) => { pk = Math.max(pk, v); return (pk - v) / pk > 0.03; }); })(), detail: '回撤是必修课，没经历过的策略上线最容易失控。' },
    ];
    const passed = items.filter((i) => i.pass).length;
    return {
      items,
      passed,
      total: items.length,
      ready: passed >= items.length - 1,
      verdict: passed >= items.length - 1
        ? '模拟盘验证充分，可以考虑小仓位实盘。'
        : passed >= 4
        ? '基本跑通，但还有关键项没验证，建议再跑一段时间。'
        : '验证不足，不建议上实盘。',
    };
  }

  return { PaperAccount, ORDER_STATUS, importTrades, readiness, uid, idemKey };
});
