/**
 * broker.js —— 券商对接适配层（实盘）
 *
 * 定位：**只做「把订单翻译成各家券商 API 的请求 + 校验 + 导出」，不代下单。**
 * 原因很实在 —— 密钥在本机（加密存储）、网络与合规风险都在用户自己手里，
 * 一个自用软件最不该做的就是背着用户发真实委托。
 * 所以这里提供：
 *   1. 能力矩阵：各家支持什么订单类型、能不能盘前盘后、能不能做空、佣金口径
 *   2. 订单映射：内部订单 → IBKR / Alpaca / Tradier / TradeStation / Schwab / E*TRADE 的实际请求体
 *   3. 前置校验：字段缺失、不支持的组合、最小单位、TIF 合法性
 *   4. 幂等与重连：clientOrderId / 重试策略 / 断线后的对账基线
 *   5. 定时任务定义：开盘、盘中、收盘、财报日
 *
 * 接口路径与字段名按各家公开文档的真实形状写，便于直接拿去用。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Broker = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  /**
   * 券商名录与能力矩阵。
   * commission 描述仅为公开口径的量级参考，实际以券商当期费率为准。
   */
  const VENUES = [
    {
      key: 'ibkr',
      name: 'Interactive Brokers',
      short: 'IBKR',
      note: '功能最强，多市场 / 期权 / 做空都支持，但 API 最复杂（TWS 或 Client Portal Gateway 需常驻）。',
      api: {
        kind: 'REST + Gateway',
        base: 'https://localhost:5000/v1/api',
        auth: 'Client Portal Gateway 会话（需在浏览器完成登录，Cookie 维持）',
        docs: 'https://www.interactivebrokers.com/campus/ibkr-api-page/cpapi-v1/',
        orderPath: '/iserver/account/{accountId}/orders',
        positionPath: '/portfolio/{accountId}/positions/0',
        accountPath: '/iserver/accounts',
      },
      capabilities: {
        extendedHours: true, short: true, options: true, fractional: true, bracket: true, oco: true,
        algo: ['TWAP', 'VWAP', 'Adaptive', 'Iceberg'], moo: true, moc: true,
        minShares: 1, tif: ['DAY', 'GTC', 'OPG', 'IOC', 'FOK', 'GTD'],
      },
      commission: { stock: 0.005, min: 1, note: '每股 $0.005，单笔最低 $1（阶梯式口径）' },
      complexity: 5,
      latency: '低（本机 Gateway）',
    },
    {
      key: 'alpaca',
      name: 'Alpaca',
      short: 'Alpaca',
      note: 'API 最友好，免佣，适合美股自动化；支持 Paper Trading 环境，先把逻辑跑通再切实盘。',
      api: {
        kind: 'REST',
        base: 'https://api.alpaca.markets/v2',
        paperBase: 'https://paper-api.alpaca.markets/v2',
        auth: 'APCA-API-KEY-ID / APCA-API-SECRET-KEY 请求头',
        docs: 'https://docs.alpaca.markets/reference/postorder',
        orderPath: '/orders',
        positionPath: '/positions',
        accountPath: '/account',
      },
      capabilities: {
        extendedHours: true, short: true, options: true, fractional: true, bracket: true, oco: true,
        algo: [], moo: true, moc: true,
        minShares: 1, tif: ['day', 'gtc', 'opg', 'cls', 'ioc', 'fok'],
      },
      commission: { stock: 0, min: 0, note: '美股免佣（SEC 费与 FINRA TAF 仍由交易所代收）' },
      complexity: 2,
      latency: '中',
    },
    {
      key: 'tradier',
      name: 'Tradier',
      short: 'Tradier',
      note: '券商 API 出身，期权数据完整，接口干净；行情需单独订阅。',
      api: {
        kind: 'REST',
        base: 'https://api.tradier.com/v1',
        auth: 'Bearer <access_token>',
        docs: 'https://documentation.tradier.com/brokerage-api/trading/place-equity-order',
        orderPath: '/accounts/{accountId}/orders',
        positionPath: '/accounts/{accountId}/positions',
        accountPath: '/accounts/{accountId}/balances',
      },
      capabilities: {
        extendedHours: true, short: true, options: true, fractional: false, bracket: false, oco: true,
        algo: [], moo: true, moc: true,
        minShares: 1, tif: ['day', 'gtc', 'pre', 'post'],
      },
      commission: { stock: 0, min: 0, note: '股票免佣，期权按张收费' },
      complexity: 3,
      latency: '中',
    },
    {
      key: 'tradestation',
      name: 'TradeStation',
      short: 'TradeStation',
      note: 'API 完整度高，支持订单组与复杂委托，适合需要精细控制执行的人。',
      api: {
        kind: 'REST',
        base: 'https://api.tradestation.com/v3',
        auth: 'OAuth 2.0 Bearer Token',
        docs: 'https://api.tradestation.com/docs/specification',
        orderPath: '/orderexecution/orders',
        positionPath: '/brokerage/accounts/{accountId}/positions',
        accountPath: '/brokerage/accounts',
      },
      capabilities: {
        extendedHours: true, short: true, options: true, fractional: false, bracket: true, oco: true,
        algo: [], moo: true, moc: true,
        minShares: 1, tif: ['DAY', 'GTC', 'GTD', 'OPG', 'IOC', 'FOK'],
      },
      commission: { stock: 0, min: 0, note: '股票与 ETF 免佣' },
      complexity: 3,
      latency: '中',
    },
    {
      key: 'schwab',
      name: 'Charles Schwab',
      short: 'Schwab',
      note: '收购 TD Ameritrade 后统一到 Schwab Trader API，OAuth 授权较重，个人接入门槛偏高。',
      api: {
        kind: 'REST',
        base: 'https://api.schwabapi.com/trader/v1',
        auth: 'OAuth 2.0（授权码 + 刷新令牌，需回调地址）',
        docs: 'https://developer.schwab.com/products/trader-api--individual',
        orderPath: '/accounts/{accountNumber}/orders',
        positionPath: '/accounts/{accountNumber}',
        accountPath: '/accounts/accountNumbers',
      },
      capabilities: {
        extendedHours: true, short: true, options: true, fractional: true, bracket: true, oco: true,
        algo: [], moo: true, moc: true,
        minShares: 1, tif: ['DAY', 'GTC', 'FOK', 'IOC'],
      },
      commission: { stock: 0, min: 0, note: '美股与 ETF 免佣' },
      complexity: 4,
      latency: '中',
    },
    {
      key: 'etrade',
      name: 'E*TRADE (Morgan Stanley)',
      short: 'E*TRADE',
      note: 'API 面向机构与活跃客户开放，个人申请需审核，文档偏旧。',
      api: {
        kind: 'REST + OAuth 1.0a',
        base: 'https://api.etrade.com/v1',
        auth: 'OAuth 1.0a（四步换取 access token）',
        docs: 'https://apisb.etrade.com/docs/api/order/api-order-v1.html',
        orderPath: '/accounts/{accountIdKey}/orders/place',
        positionPath: '/accounts/{accountIdKey}/portfolio',
        accountPath: '/accounts/list',
      },
      capabilities: {
        extendedHours: true, short: true, options: true, fractional: false, bracket: false, oco: true,
        algo: [], moo: false, moc: false,
        minShares: 1, tif: ['GOOD_FOR_DAY', 'GOOD_TILL_CANCEL', 'IMMEDIATE_OR_CANCEL'],
      },
      commission: { stock: 0, min: 0, note: '美股免佣' },
      complexity: 4,
      latency: '中',
    },
  ];

  const VENUE_MAP = {};
  for (const v of VENUES) VENUE_MAP[v.key] = v;

  /** 内部订单类型 → 各券商字段 */
  const TYPE_MAP = {
    ibkr: {
      market: { orderType: 'MKT' }, limit: { orderType: 'LMT' }, stop: { orderType: 'STP' },
      stop_limit: { orderType: 'STP LMT' }, moo: { orderType: 'MKT', tif: 'OPG' },
      moc: { orderType: 'MOC' }, loc: { orderType: 'LOC' }, clo: { orderType: 'LOC' },
      twap: { orderType: 'MKT', algo: 'TWAP' }, vwap: { orderType: 'MKT', algo: 'VWAP' },
      iceberg: { orderType: 'LMT', algo: 'Iceberg' },
    },
    alpaca: {
      market: { type: 'market' }, limit: { type: 'limit' }, stop: { type: 'stop' },
      stop_limit: { type: 'stop_limit' }, moo: { type: 'market', time_in_force: 'opg' },
      moc: { type: 'market', time_in_force: 'cls' }, loc: { type: 'limit', time_in_force: 'cls' },
      clo: { type: 'limit', time_in_force: 'cls' }, twap: { type: 'market' }, vwap: { type: 'market' },
      iceberg: { type: 'limit' },
    },
    tradier: {
      market: { type: 'market' }, limit: { type: 'limit' }, stop: { type: 'stop' },
      stop_limit: { type: 'stop_limit' }, moo: { type: 'market', duration: 'day' },
      moc: { type: 'market', duration: 'day' }, loc: { type: 'limit', duration: 'day' },
      clo: { type: 'limit', duration: 'day' }, twap: { type: 'market' }, vwap: { type: 'market' },
      iceberg: { type: 'limit' },
    },
    tradestation: {
      market: { OrderType: 'Market' }, limit: { OrderType: 'Limit' }, stop: { OrderType: 'StopMarket' },
      stop_limit: { OrderType: 'StopLimit' }, moo: { OrderType: 'Market', TimeInForce: { Duration: 'DAY' } },
      moc: { OrderType: 'Market' }, loc: { OrderType: 'Limit' }, clo: { OrderType: 'Limit' },
      twap: { OrderType: 'Market' }, vwap: { OrderType: 'Market' }, iceberg: { OrderType: 'Limit' },
    },
    schwab: {
      market: { orderType: 'MARKET' }, limit: { orderType: 'LIMIT' }, stop: { orderType: 'STOP' },
      stop_limit: { orderType: 'STOP_LIMIT' }, moo: { orderType: 'MARKET_ON_OPEN' },
      moc: { orderType: 'MARKET_ON_CLOSE' }, loc: { orderType: 'LIMIT_ON_CLOSE' },
      clo: { orderType: 'LIMIT_ON_CLOSE' }, twap: { orderType: 'MARKET' }, vwap: { orderType: 'MARKET' },
      iceberg: { orderType: 'LIMIT' },
    },
    etrade: {
      market: { priceType: 'MARKET' }, limit: { priceType: 'LIMIT' }, stop: { priceType: 'STOP' },
      stop_limit: { priceType: 'STOP_LIMIT' }, moo: { priceType: 'MARKET_ON_OPEN' },
      moc: { priceType: 'MARKET_ON_CLOSE' }, loc: { priceType: 'LIMIT_ON_CLOSE' },
      clo: { priceType: 'LIMIT_ON_CLOSE' }, twap: { priceType: 'MARKET' }, vwap: { priceType: 'MARKET' },
      iceberg: { priceType: 'LIMIT' },
    },
  };

  /** 内部方向 → 各券商字段 */
  const SIDE_MAP = {
    ibkr: { buy: 'BUY', sell: 'SELL', short: 'SELL', cover: 'BUY' },
    alpaca: { buy: 'buy', sell: 'sell', short: 'sell', cover: 'buy' },
    tradier: { buy: 'buy', sell: 'sell', short: 'sell_short', cover: 'buy_to_cover' },
    tradestation: { buy: 'Buy', sell: 'Sell', short: 'SellShort', cover: 'BuyToCover' },
    schwab: { buy: 'BUY', sell: 'SELL', short: 'SELL_SHORT', cover: 'BUY_TO_COVER' },
    etrade: { buy: 'BUY', sell: 'SELL', short: 'SHORT', cover: 'BUY_TO_COVER' },
  };

  /** 各券商要求的 Time-In-Force 合法值 */
  function normalizeTif(venue, tif) {
    const cap = VENUE_MAP[venue] ? VENUE_MAP[venue].capabilities.tif : ['DAY'];
    const t = String(tif || 'day');
    const hit = cap.find((x) => x.toLowerCase() === t.toLowerCase());
    if (hit) return hit;
    if (/^day$/i.test(t)) return cap.includes('DAY') ? 'DAY' : 'day';
    return cap[0];
  }

  /** 取默认券商配置（含未填写项） */
  function configFor(venueKey) {
    const v = VENUE_MAP[venueKey];
    if (!v) return null;
    return {
      venue: venueKey,
      name: v.name,
      enabled: false,
      paper: true, // 默认先跑模拟环境
      accountId: '',
      environment: 'paper',
      credentials: { keyId: '', secret: '', token: '', refreshToken: '', expiresAt: null },
      baseUrl: v.api.paperBase || v.api.base,
      liveBaseUrl: v.api.base,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * 把内部订单映射成某家券商的实际请求。
   * @param {String} venueKey
   * @param {Object} order { symbol, side, type, shares, limitPrice, stopPrice, tif, extendedHours, clientOrderId }
   * @param {Object} [cfg]  券商配置（取 accountId / 环境）
   */
  function mapOrder(venueKey, order, cfg) {
    const v = VENUE_MAP[venueKey];
    if (!v) return { error: `未知券商：${venueKey}` };
    const o = order || {};
    const c = cfg || configFor(venueKey) || {};
    const map = TYPE_MAP[venueKey] || {};
    const t = map[o.type] || map.market || {};
    // 各家字段名大小写不同：IBKR/Alpaca/Tradier 用 orderType/type，TradeStation 用 OrderType，E*TRADE 用 priceType
    if (!t.orderType && !t.type && !t.priceType && !t.OrderType) {
      return { error: `${v.short} 不支持订单类型「${o.type}」。支持的算法单：${(v.capabilities.algo || []).join('、') || '无'}。` };
    }
    const side = (SIDE_MAP[venueKey] || {})[o.side] || o.side;
    const tif = normalizeTif(venueKey, o.tif);
    const qty = Math.abs(Number(o.shares) || 0);
    const limit = Number(o.limitPrice) || 0;
    const stop = Number(o.stopPrice) || 0;
    const clientId = o.clientOrderId || `qd_${o.symbol}_${Date.now().toString(36)}`;

    let path = v.api.orderPath;
    if (c.accountId) path = path.replace('{accountId}', c.accountId).replace('{accountNumber}', c.accountId).replace('{accountIdKey}', c.accountId);
    const base = (c.paper && v.api.paperBase) || (c.environment === 'paper' && v.api.paperBase) || c.baseUrl || v.api.base;
    const url = base.replace(/\/$/, '') + path;

    let body;
    switch (venueKey) {
      case 'ibkr':
        body = {
          orders: [{
            conid: o.conid || null, // IBKR 需要先把代码换成 conid
            secType: 'STK',
            side,
            orderType: t.orderType,
            quantity: qty,
            price: limit || undefined,
            auxPrice: stop || undefined,
            tif: t.tif || tif,
            outsideRTH: !!o.extendedHours,
            ...(t.algo ? { algoStrategy: t.algo } : {}),
          }],
        };
        break;
      case 'alpaca':
        body = {
          symbol: o.symbol,
          qty: String(qty),
          side,
          type: t.type,
          time_in_force: t.time_in_force || tif,
          limit_price: limit ? String(limit) : undefined,
          stop_price: stop ? String(stop) : undefined,
          extended_hours: !!o.extendedHours,
          client_order_id: clientId,
          ...(o.bracket ? {
            order_class: 'bracket',
            take_profit: { limit_price: o.takeProfit ? String(o.takeProfit) : undefined },
            stop_loss: o.stopLoss ? { stop_price: String(o.stopLoss) } : undefined,
          } : {}),
        };
        break;
      case 'tradier':
        body = {
          class: 'equity',
          symbol: o.symbol,
          side,
          quantity: qty,
          type: t.type,
          duration: t.duration || (tif === 'gtc' ? 'gtc' : 'day'),
          price: limit || undefined,
          stop: stop || undefined,
          ...(o.extendedHours ? { duration: 'pre' } : {}),
        };
        break;
      case 'tradestation':
        body = {
          AccountID: c.accountId,
          Symbol: o.symbol,
          Quantity: String(qty),
          OrderType: t.OrderType,
          TradeAction: side,
          TimeInForce: { Duration: tif },
          LimitPrice: limit ? String(limit) : undefined,
          StopPrice: stop ? String(stop) : undefined,
        };
        break;
      case 'schwab':
        body = {
          orderType: t.orderType,
          session: o.extendedHours ? 'SEAMLESS' : 'NORMAL',
          duration: tif === 'GTC' ? 'GOOD_TILL_CANCEL' : 'DAY',
          orderStrategyType: o.bracket ? 'TRIGGER' : 'SINGLE',
          orderLegCollection: [{
            instruction: side,
            quantity: qty,
            instrument: { symbol: o.symbol, assetType: 'EQUITY' },
          }],
          price: limit || undefined,
          stopPrice: stop || undefined,
        };
        break;
      case 'etrade':
        body = {
          PlaceOrderRequest: {
            orderType: 'EQ',
            clientOrderId: clientId,
            Order: [{
              allOrNone: false,
              priceType: t.priceType,
              orderTerm: tif === 'GOOD_TILL_CANCEL' ? 'GOOD_TILL_CANCEL' : 'GOOD_FOR_DAY',
              marketSession: o.extendedHours ? 'EXTENDED' : 'REGULAR',
              Instrument: [{ Product: { securityType: 'EQ', symbol: o.symbol }, orderAction: side, quantityType: 'QUANTITY', quantity: qty }],
              limitPrice: limit || undefined,
              stopPrice: stop || undefined,
            }],
          },
        };
        break;
      default:
        body = {};
    }

    return {
      venue: venueKey, venueName: v.name,
      method: 'POST', url,
      headers: headersFor(venueKey, c),
      body: JSON.parse(JSON.stringify(body)), // 去掉 undefined
      clientOrderId: clientId,
      environment: c.paper || c.environment === 'paper' ? 'paper' : 'live',
      note: `内部订单 ${o.side} ${qty} 股 ${o.symbol}（${o.type}）→ ${v.short} ${t.orderType || t.type || t.priceType}`,
    };
  }

  /** JSON.stringify 会把 undefined 属性丢掉，这里显式清一遍便于展示 */
  function headersFor(venueKey, cfg) {
    const c = cfg || {};
    switch (venueKey) {
      case 'alpaca':
        return {
          'APCA-API-KEY-ID': c.credentials && c.credentials.keyId ? '****' + String(c.credentials.keyId).slice(-4) : '<未配置>',
          'APCA-API-SECRET-KEY': c.credentials && c.credentials.secret ? '<已加密存储>' : '<未配置>',
          'Content-Type': 'application/json',
        };
      case 'tradier':
        return {
          Authorization: c.credentials && c.credentials.token ? 'Bearer ****' : '<未配置>',
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        };
      case 'ibkr':
        return { Cookie: '<Gateway 会话 Cookie，由本地 Gateway 维持>', 'Content-Type': 'application/json' };
      default:
        return {
          Authorization: 'Bearer ' + (c.credentials && c.credentials.token ? '****' : '<未配置>'),
          'Content-Type': 'application/json',
        };
    }
  }

  /**
   * 下单前对券商能力的校验：这些错误如果发出去，轻则拒单重则乱成交。
   */
  function validate(venueKey, order, cfg) {
    const v = VENUE_MAP[venueKey];
    const errors = [];
    const warns = [];
    if (!v) return { ok: false, errors: [{ title: '未知券商', detail: venueKey }], warns: [] };
    const o = order || {};
    const cap = v.capabilities;

    if (!o.symbol) errors.push({ title: '缺少代码', detail: '券商要求 symbol 必填。' });
    if (!(Math.abs(Number(o.shares)) > 0)) errors.push({ title: '数量为空', detail: 'quantity 必须大于 0。' });
    if (!cap.fractional && Math.abs(Number(o.shares)) % 1 !== 0) {
      errors.push({ title: '不支持碎股', detail: `${v.short} 不支持小数股，请取整。` });
    }
    if (['limit', 'stop_limit', 'loc', 'clo'].includes(o.type) && !(Number(o.limitPrice) > 0)) {
      errors.push({ title: '缺限价', detail: `${o.type} 必须提供 limitPrice。` });
    }
    if (['stop', 'stop_limit'].includes(o.type) && !(Number(o.stopPrice) > 0)) {
      errors.push({ title: '缺触发价', detail: `${o.type} 必须提供 stopPrice。` });
    }
    if (o.extendedHours && !cap.extendedHours) {
      errors.push({ title: '不支持盘前盘后', detail: `${v.short} 不支持延长时段委托。` });
    }
    if (o.extendedHours && ['market', 'stop'].includes(o.type)) {
      errors.push({ title: '延长时段只能用限价单', detail: '盘前盘后流动性薄，券商一律只接受限价单。' });
    }
    if (o.side === 'short' && !cap.short) {
      errors.push({ title: '不支持做空', detail: `${v.short} 不支持直接做空该标的。` });
    }
    if (o.bracket && !cap.bracket) {
      errors.push({ title: '不支持括号单', detail: `${v.short} 无原生 Bracket，需要自己拆成三腿分别提交。` });
    }
    if (o.oco && !cap.oco) {
      errors.push({ title: '不支持 OCO', detail: `${v.short} 无原生 OCO。` });
    }
    if (['twap', 'vwap', 'iceberg'].includes(o.type) && !(cap.algo || []).some((a) => a.toLowerCase() === o.type)) {
      warns.push({ title: '券商无原生算法单', detail: `${v.short} 不支持 ${o.type.toUpperCase()}，需要在本地下单器里自己切片后逐笔提交。` });
    }
    if (o.type === 'moo' && !cap.moo) warns.push({ title: '不支持 MOO', detail: `${v.short} 无 MOO，可改用开盘后的市价单。` });
    if (o.type === 'moc' && !cap.moc) warns.push({ title: '不支持 MOC', detail: `${v.short} 无 MOC，可改用收盘前的限价单。` });

    // IBKR Client Portal 用合约号 conid 而不是代码定位标的。
    // 不在这里拦住，请求会带着 conid:null 发出去，由网关回一个看不出所以然的错误 ——
    // 所以必须在本地就把「先去查合约号」这一步说清楚。
    if (venueKey === 'ibkr' && !(Number(o.conid) > 0)) {
      errors.push({
        title: '缺少 conid（合约号）',
        detail: 'IBKR Client Portal 不接受直接用代码下单。先请求 GET /iserver/secdef/search?symbol=XXX 拿到 conid，填进订单的 conid 字段再提交。',
      });
    }
    if (!(cfg && cfg.accountId)) errors.push({ title: '未配置账户号', detail: `${v.short} 的请求路径需要 accountId。` });
    if (!(cfg && cfg.credentials && (cfg.credentials.token || cfg.credentials.keyId))) {
      errors.push({ title: '未配置 API 凭证', detail: '请在设置里填入密钥；密钥只保存在本机加密存储中。' });
    }

    return {
      ok: errors.length === 0,
      errors, warns,
      venue: v.short,
      summary: errors.length ? `${errors.length} 项无法提交` : warns.length ? `可提交，但 ${warns.length} 项需注意` : '校验通过',
    };
  }

  /** 连接状态：根据配置推断（这里不主动联网探活，避免暴露凭证） */
  function connectionState(cfg) {
    if (!cfg || !cfg.enabled) {
      return { state: 'off', label: '未启用', detail: '该券商未启用，仅用于查看订单映射。', tone: 'flat' };
    }
    const hasCred = !!(cfg.credentials && (cfg.credentials.token || cfg.credentials.keyId || cfg.credentials.refreshToken));
    if (!hasCred) return { state: 'nokey', label: '缺凭证', detail: '已启用但未填写 API 密钥。', tone: 'warn' };
    if (cfg.expiresAt && new Date(cfg.expiresAt).getTime() < Date.now()) {
      return { state: 'expired', label: '令牌过期', detail: '访问令牌已过期，需要重新授权。', tone: 'down' };
    }
    return {
      state: 'ready',
      label: cfg.paper || cfg.environment === 'paper' ? '模拟环境就绪' : '实盘就绪',
      detail: `${cfg.name} · 账户 ${cfg.accountId || '未填'} · ${cfg.paper || cfg.environment === 'paper' ? 'Paper' : 'Live'}`,
      tone: cfg.paper || cfg.environment === 'paper' ? 'flat' : 'up',
    };
  }

  /**
   * 断线重连与幂等策略。
   * 实盘最怕「请求发出去了但没收到回执」，所以每次重连后必须先对账再继续。
   */
  function reliability(venueKey) {
    const v = VENUE_MAP[venueKey];
    if (!v) return null;
    return {
      venue: v.short,
      idempotency: {
        field: venueKey === 'alpaca' ? 'client_order_id' : venueKey === 'etrade' ? 'clientOrderId' : '本地去重表（该券商无原生幂等字段）',
        strategy: '每笔订单在本地生成唯一 key，重试时复用同一个 key；券商若拒绝重复 key，说明前一次其实已经受理。',
        localTable: 'orders.idempotency_key（唯一索引）',
      },
      reconnect: {
        backoff: '指数退避：1s → 2s → 4s → 8s → 16s，最多 6 次',
        onReconnect: ['重新拉取账户快照', '拉取当日全部订单状态', '与本地记录逐笔对账', '差异未清零前禁止开新仓'],
        heartbeat: '每 30 秒一次轻量请求（如查账户），连续 3 次失败判定断线',
      },
      pitfalls: [
        '重试前必须先查订单状态，不能直接重发 —— 否则可能重复成交。',
        '盘前盘后挂单在开盘后可能立即成交，撤单要留出缓冲时间。',
        '部分成交后撤单只撤剩余部分，已成交部分无法回滚。',
        '券商侧持仓与本地不一致时，一律以券商为准，本地做修正。',
      ],
    };
  }

  /** 定时任务定义（开盘 / 盘中 / 收盘 / 财报日） */
  function defaultTasks() {
    return [
      { key: 'premarket', name: '盘前准备', at: '09:00 ET', enabled: true, desc: '拉取隔夜行情、检查挂单与持仓、刷新账户快照、确认当日无财报黑窗标的。' },
      { key: 'open', name: '开盘执行', at: '09:30 ET', enabled: true, desc: '执行 MOO 委托结果核对、按计划下达开盘单、启动风控监控。' },
      { key: 'intraday', name: '盘中巡检', at: '每 15 分钟', enabled: true, desc: '刷新持仓与风控指标、检查数据断流、触发预警、必要时执行减仓动作。' },
      { key: 'powerhour', name: '尾盘处理', at: '15:45 ET', enabled: true, desc: '处理 MOC/LOC 委托（15:50 截止）、当日日内交易次数核对、避免误触 PDT。' },
      { key: 'close', name: '收盘归档', at: '16:05 ET', enabled: true, desc: '成交回报归档、持仓对账、净值记录、交易日志落盘、税务流水累加。' },
      { key: 'earnings', name: '财报日检查', at: '财报前一交易日 15:00 ET', enabled: true, desc: '标记持仓中的财报标的，按黑窗规则禁止开新仓、评估是否减仓过财报。' },
    ];
  }

  /** 密钥只在本地加密存储；这里做一层脱敏展示 */
  function maskCredential(value) {
    const s = String(value || '');
    if (!s) return '';
    if (s.length <= 8) return '****';
    return s.slice(0, 3) + '****' + s.slice(-4);
  }

  /** 导出订单指令为可复制的 cURL（方便自己核对或手工执行） */
  function toCurl(mapped) {
    if (!mapped || mapped.error) return '';
    const parts = [`curl -X ${mapped.method} '${mapped.url}'`];
    for (const [k, v] of Object.entries(mapped.headers || {})) parts.push(`  -H '${k}: ${v}'`);
    parts.push(`  -d '${JSON.stringify(mapped.body)}'`);
    return parts.join(' \\\n');
  }

  return {
    VENUES,
    VENUE_MAP,
    TYPE_MAP,
    SIDE_MAP,
    configFor,
    mapOrder,
    validate,
    connectionState,
    reliability,
    defaultTasks,
    normalizeTif,
    maskCredential,
    toCurl,
  };
});
