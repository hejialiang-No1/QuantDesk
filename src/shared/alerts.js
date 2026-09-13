/**
 * alerts.js —— 告警规则引擎、异常检测与渠道适配
 *
 * 个人自用最容易忽视的一环：策略在后台跑，人不在电脑前。
 * 告警要解决两个问题 ——
 *   1. 该通知你的时候一定通知到（价格、盈亏、风控、成交）
 *   2. 出问题时自己先发现（数据断流、API 断线、订单失败、持仓对不上）
 *
 * 渠道设计：Telegram / 钉钉 / 企业微信 / 通用 Webhook 都是「一个 HTTP POST 带 JSON」，
 * 格式各不相同，这里统一成 payload 生成器；邮件走 SMTP，需要用户填服务器信息。
 * 所有密钥只存本地。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Alerts = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // ============================================================ 渠道

  const CHANNELS = [
    {
      key: 'telegram',
      name: 'Telegram',
      note: '最省事：建个 Bot 拿 token，找 chat_id，直接发消息。国内需自备网络环境。',
      fields: [
        { key: 'botToken', label: 'Bot Token', placeholder: '123456:ABC-DEF...', secret: true },
        { key: 'chatId', label: 'Chat ID', placeholder: '如 123456789 或 -100...' },
      ],
      endpoint: 'https://api.telegram.org/bot{botToken}/sendMessage',
      docs: 'https://core.telegram.org/bots/api#sendmessage',
    },
    {
      key: 'wecom',
      name: '企业微信机器人',
      note: '群里加「群机器人」，拿 Webhook key。国内直连，最稳。',
      fields: [{ key: 'webhookKey', label: 'Webhook Key', placeholder: '群机器人地址里的 key= 后面那段', secret: true }],
      endpoint: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key={webhookKey}',
      docs: 'https://developer.work.weixin.qq.com/document/path/91770',
    },
    {
      key: 'dingtalk',
      name: '钉钉机器人',
      note: '群机器人 Webhook；若开了「加签」还需填 secret。',
      fields: [
        { key: 'accessToken', label: 'Access Token', placeholder: 'Webhook 地址里的 access_token=', secret: true },
        { key: 'secret', label: '加签 Secret（可选）', placeholder: '启用加签时填写', secret: true },
      ],
      endpoint: 'https://oapi.dingtalk.com/robot/send?access_token={accessToken}',
      docs: 'https://open.dingtalk.com/document/orgapp/custom-robot-access',
    },
    {
      key: 'webhook',
      name: '通用 Webhook',
      note: '向任意地址 POST 一段 JSON，可接自建服务、IFTTT、n8n 等。',
      fields: [
        { key: 'url', label: 'URL', placeholder: 'https://example.com/hook' },
        { key: 'secret', label: '签名密钥（可选）', placeholder: '会放在 X-QD-Sign 头里', secret: true },
      ],
      endpoint: '{url}',
      docs: '',
    },
    {
      key: 'email',
      name: '邮件 (SMTP)',
      note: '直连你的邮箱 SMTP 服务器发送。多数邮箱需要「授权码」而非登录密码。',
      fields: [
        { key: 'host', label: 'SMTP 服务器', placeholder: 'smtp.qq.com' },
        { key: 'port', label: '端口', placeholder: '465（SSL）或 587' },
        { key: 'user', label: '账号', placeholder: 'you@example.com' },
        { key: 'pass', label: '授权码 / 密码', placeholder: '', secret: true },
        { key: 'to', label: '收件人', placeholder: 'you@example.com' },
      ],
      endpoint: '{host}:{port}',
      docs: '',
    },
    {
      key: 'system',
      name: '系统通知',
      note: 'macOS 通知中心横幅，零配置，适合人在电脑前时用。',
      fields: [],
      endpoint: 'local://notification',
      docs: '',
    },
  ];

  const CHANNEL_MAP = {};
  for (const c of CHANNELS) CHANNEL_MAP[c.key] = c;

  // ============================================================ 规则类型

  /**
   * 价格类、持仓类、账户类、策略类的触发条件。
   * field 是快照里的取值路径说明，具体解析在 evaluateRules 里。
   */
  const RULE_TYPES = [
    { key: 'price_above', group: '价格', label: '价格上破', unit: '$', desc: '最新价 ≥ 阈值' },
    { key: 'price_below', group: '价格', label: '价格下破', unit: '$', desc: '最新价 ≤ 阈值' },
    { key: 'pct_up', group: '价格', label: '当日涨幅超过', unit: '%', desc: '涨跌幅 ≥ 阈值' },
    { key: 'pct_down', group: '价格', label: '当日跌幅超过', unit: '%', desc: '涨跌幅 ≤ −阈值' },
    { key: 'vol_spike', group: '价格', label: '成交量放大', unit: '倍', desc: '量比 ≥ 阈值' },
    { key: 'rsi_above', group: '技术', label: 'RSI 高于', unit: '', desc: 'RSI ≥ 阈值（默认 70）' },
    { key: 'rsi_below', group: '技术', label: 'RSI 低于', unit: '', desc: 'RSI ≤ 阈值（默认 30）' },
    { key: 'ma_break', group: '技术', label: '跌破均线', unit: '日', desc: '收盘跌破 N 日均线' },
    { key: 'drawdown', group: '账户', label: '账户回撤超过', unit: '%', desc: '距峰值回撤 ≥ 阈值' },
    { key: 'daily_loss', group: '账户', label: '单日亏损超过', unit: '%', desc: '当日亏损 ≥ 阈值' },
    { key: 'position_gain', group: '持仓', label: '持仓浮盈达到', unit: '%', desc: '单只浮盈 ≥ 阈值' },
    { key: 'position_loss', group: '持仓', label: '持仓浮亏达到', unit: '%', desc: '单只浮亏 ≥ 阈值' },
    { key: 'risk_block', group: '风控', label: '风控触发硬拦截', unit: '', desc: '任一硬约束被突破时告警' },
    { key: 'order_failed', group: '交易', label: '订单被拒', unit: '', desc: '出现拒单时告警' },
    { key: 'fill', group: '交易', label: '成交回报', unit: '', desc: '任意成交发生时告警' },
    { key: 'earnings', group: '事件', label: '财报临近', unit: '天', desc: '距财报日 ≤ N 天' },
  ];

  const RULE_MAP = {};
  for (const r of RULE_TYPES) RULE_MAP[r.key] = r;

  /** 异常检测项 */
  const ANOMALY_TYPES = [
    { key: 'data_stale', label: '数据断流', level: 'high', desc: '行情超过设定时间没有更新，策略基于过期数据做决策非常危险。' },
    { key: 'api_down', label: 'API 断线', level: 'high', desc: '券商接口连续失败，可能已经无法下单或撤单。' },
    { key: 'order_failed', label: '订单失败', level: 'high', desc: '出现被拒订单，需要立即确认原因。' },
    { key: 'position_mismatch', label: '持仓不一致', level: 'high', desc: '本地持仓与券商快照对不上，可能是漏记成交或重复下单。' },
    { key: 'cash_mismatch', label: '资金不一致', level: 'medium', desc: '本地现金与券商余额有差异。' },
    { key: 'no_heartbeat', label: '心跳丢失', level: 'high', desc: '定时任务未按预期运行，可能进程已挂。' },
    { key: 'latency_high', label: '延迟过高', level: 'medium', desc: '接口响应时间明显变长，撮合与撤单可能来不及。' },
    { key: 'risk_limit', label: '风控触线', level: 'high', desc: '账户级或策略级约束被突破。' },
    { key: 'pdt_warning', label: 'PDT 额度告急', level: 'medium', desc: '接近 5 日内 4 次日内交易上限。' },
    { key: 'margin_call', label: '保证金不足', level: 'high', desc: '维持保证金低于要求，可能被强平。' },
  ];

  const ANOMALY_MAP = {};
  for (const a of ANOMALY_TYPES) ANOMALY_MAP[a.key] = a;

  // ============================================================ 规则求值

  function num(v, d) {
    const x = Number(v);
    return isFinite(x) ? x : d == null ? 0 : d;
  }

  /**
   * 求值一条规则。
   * @param {Object} rule { type, symbol, value, enabled, note }
   * @param {Object} snap {
   *   quotes:{SYM:{price,changePct,volRatio,rsi,ma,amount}},
   *   account:{equity,peakEquity,dayStartEquity},
   *   positions:[{symbol,pnlPct}],
   *   risk:{level,blocks},
   *   orders:[{status,symbol,reason,createdAt}],
   *   earnings:{SYM:days}
   * }
   */
  function evalRule(rule, snap) {
    if (!rule || rule.enabled === false) return null;
    const type = rule.type;
    const t = RULE_MAP[type];
    if (!t) return null;
    const s = snap || {};
    const v = num(rule.value);
    const sym = String(rule.symbol || '').toUpperCase();
    const q = (s.quotes || {})[sym] || {};

    const fire = (actual, detail) => {
      // 单位位置：货币符号前置（$210），百分比与计量单位后置（5%、3 天）
      let shown = '';
      if (rule.value != null) {
        shown = t.unit === '$' ? ` $${rule.value}` : ` ${rule.value}${t.unit || ''}`;
      }
      return {
        ruleId: rule.id, type, symbol: sym || null,
        label: t.label,
        title: `${sym ? sym + ' ' : ''}${t.label}${shown}`,
        detail,
        actual,
        threshold: rule.value,
        level: rule.severity || 'info',
        hitAt: new Date().toISOString(),
      };
    };

    switch (type) {
      case 'price_above':
        return q.price > 0 && q.price >= v ? fire(q.price, `最新价 $${q.price} 已上破 $${v}。`) : null;
      case 'price_below':
        return q.price > 0 && q.price <= v ? fire(q.price, `最新价 $${q.price} 已下破 $${v}。`) : null;
      case 'pct_up':
        return q.changePct != null && q.changePct >= v ? fire(q.changePct, `当日涨幅 ${q.changePct}% 超过 ${v}%。`) : null;
      case 'pct_down':
        return q.changePct != null && q.changePct <= -v ? fire(q.changePct, `当日跌幅 ${q.changePct}% 超过 ${v}%。`) : null;
      case 'vol_spike':
        return q.volRatio != null && q.volRatio >= v ? fire(q.volRatio, `量比 ${q.volRatio} 达到 ${v} 倍，成交异常放大。`) : null;
      case 'rsi_above':
        return q.rsi != null && q.rsi >= v ? fire(q.rsi, `RSI ${q.rsi} 高于 ${v}，进入超买区。`) : null;
      case 'rsi_below':
        return q.rsi != null && q.rsi <= v ? fire(q.rsi, `RSI ${q.rsi} 低于 ${v}，进入超卖区。`) : null;
      case 'ma_break':
        return q.price > 0 && q.ma > 0 && q.price < q.ma ? fire(q.price, `收盘价 $${q.price} 跌破 ${rule.value || 20} 日均线 $${q.ma}。`) : null;
      case 'drawdown': {
        const a = s.account || {};
        const peak = num(a.peakEquity);
        if (peak <= 0) return null;
        const dd = ((peak - num(a.equity)) / peak) * 100;
        return dd >= v ? fire(dd, `账户回撤 ${dd.toFixed(2)}%，超过阈值 ${v}%。`) : null;
      }
      case 'daily_loss': {
        const a = s.account || {};
        const start = num(a.dayStartEquity);
        if (start <= 0) return null;
        const loss = ((start - num(a.equity)) / start) * 100;
        return loss >= v ? fire(loss, `当日亏损 ${loss.toFixed(2)}%，超过阈值 ${v}%。`) : null;
      }
      case 'position_gain': {
        const p = (s.positions || []).find((x) => String(x.symbol).toUpperCase() === sym);
        if (!p || p.pnlPct == null) return null;
        return p.pnlPct >= v ? fire(p.pnlPct, `${sym} 浮盈 ${p.pnlPct.toFixed(2)}%，达到 ${v}%。`) : null;
      }
      case 'position_loss': {
        const p = (s.positions || []).find((x) => String(x.symbol).toUpperCase() === sym);
        if (!p || p.pnlPct == null) return null;
        return p.pnlPct <= -Math.abs(v) ? fire(p.pnlPct, `${sym} 浮亏 ${p.pnlPct.toFixed(2)}%，达到 ${-Math.abs(v)}%。`) : null;
      }
      case 'risk_block': {
        const r = s.risk || {};
        const blocks = r.blocks || [];
        return blocks.length ? fire(blocks.length, `风控出现 ${blocks.length} 项硬拦截：${blocks.map((b) => b.title).join('、')}。`) : null;
      }
      case 'order_failed': {
        const list = (s.orders || []).filter((o) => o.status === 'rejected');
        return list.length ? fire(list.length, `有 ${list.length} 笔订单被拒：${list.slice(0, 3).map((o) => `${o.symbol}(${o.reason || '未说明'})`).join('、')}。`) : null;
      }
      case 'fill': {
        const list = (s.orders || []).filter((o) => o.status === 'filled');
        return list.length ? fire(list.length, `新增 ${list.length} 笔成交：${list.slice(0, 3).map((o) => `${o.side} ${o.filledShares} ${o.symbol}`).join('、')}。`) : null;
      }
      case 'earnings': {
        const d = (s.earnings || {})[sym];
        return d != null && d <= v ? fire(d, `${sym} 距财报还有 ${d} 天，波动通常显著放大。`) : null;
      }
      default:
        return null;
    }
  }

  /** 批量求值，返回本次命中的告警 */
  function evaluateRules(rules, snap) {
    const out = [];
    for (const r of rules || []) {
      try {
        const hit = evalRule(r, snap);
        if (hit) out.push(hit);
      } catch {
        /* 单条规则出错不影响其他 */
      }
    }
    return out;
  }

  // ============================================================ 异常检测

  /**
   * 异常检测：这些是「策略自己发现不了、但必须有人知道」的问题。
   * @param {Object} o {
   *   now, lastQuoteAt, quoteStaleMs, apiFailures, apiLatencyMs, latencyLimitMs,
   *   orders, reconcile, account, risk, dayTrades, equity, maintenanceMargin, marginReq
   * }
   */
  function detectAnomalies(o) {
    const s = o || {};
    const now = s.now ? new Date(s.now).getTime() : Date.now();
    const out = [];
    const push = (key, detail, extra) => {
      const t = ANOMALY_MAP[key];
      out.push({
        key, label: t.label, level: t.level, detail: detail || t.desc,
        hint: t.desc, at: new Date(now).toISOString(), ...(extra || {}),
      });
    };

    // 1) 数据断流
    const staleMs = s.quoteStaleMs == null ? 90000 : s.quoteStaleMs;
    if (s.lastQuoteAt) {
      const gap = now - new Date(s.lastQuoteAt).getTime();
      if (gap > staleMs) push('data_stale', `行情已 ${Math.round(gap / 1000)} 秒未更新（阈值 ${Math.round(staleMs / 1000)} 秒）。`, { gapMs: gap });
    } else if (s.expectQuotes) {
      push('data_stale', '还没有成功获取过任何行情。');
    }

    // 2) API 断线
    const fails = num(s.apiFailures);
    if (fails >= 3) push('api_down', `券商接口连续失败 ${fails} 次。`, { failures: fails });

    // 3) 延迟
    const lat = num(s.apiLatencyMs);
    const latLimit = s.latencyLimitMs == null ? 1500 : s.latencyLimitMs;
    if (lat > latLimit) push('latency_high', `接口响应 ${lat}ms，超过 ${latLimit}ms。`, { latency: lat });

    // 4) 订单失败
    const rejected = (s.orders || []).filter((x) => x.status === 'rejected');
    if (rejected.length) push('order_failed', `有 ${rejected.length} 笔订单被拒，最近一笔：${rejected[rejected.length - 1].symbol || ''} ${rejected[rejected.length - 1].reason || ''}`, { orders: rejected.slice(-5) });

    // 5) 持仓 / 资金不一致
    if (s.reconcile && !s.reconcile.ok) {
      const high = (s.reconcile.diffs || []).filter((d) => d.type === 'position');
      const cash = (s.reconcile.diffs || []).filter((d) => d.type === 'cash');
      if (high.length) push('position_mismatch', `${high.length} 处持仓与券商不一致：${high.slice(0, 2).map((d) => d.detail).join(' ')}`, { diffs: high });
      if (cash.length) push('cash_mismatch', cash[0].detail, { diffs: cash });
    }

    // 6) 心跳
    if (s.lastHeartbeatAt) {
      const gap = now - new Date(s.lastHeartbeatAt).getTime();
      const limit = s.heartbeatIntervalMs == null ? 120000 : s.heartbeatIntervalMs * 2;
      if (gap > limit) push('no_heartbeat', `距上次心跳已 ${Math.round(gap / 1000)} 秒（阈值 ${Math.round(limit / 1000)} 秒），进程可能已卡住或退出。`, { gapMs: gap });
    }

    // 7) 风控触线
    if (s.risk && (s.risk.blocks || []).length) {
      push('risk_limit', `风控 ${s.risk.blocks.length} 项硬拦截：${s.risk.blocks.map((b) => b.title).join('、')}。`, { blocks: s.risk.blocks });
    }

    // 8) PDT
    const dt = (s.dayTrades || []).length;
    const equity = num(s.equity);
    if (equity > 0 && equity < 25000 && dt >= 3) {
      push('pdt_warning', `净值 $${equity.toFixed(0)} < $25,000，5 个交易日内已用 ${dt} 次日内交易（上限 3 次）。`, { dayTrades: dt });
    }

    // 9) 保证金
    if (s.maintenanceMargin != null && s.marginReq != null && num(s.maintenanceMargin) < num(s.marginReq)) {
      push('margin_call', `维持保证金 $${num(s.maintenanceMargin).toFixed(0)} 低于要求 $${num(s.marginReq).toFixed(0)}，存在强平风险。`, {});
    }

    const order = { high: 0, medium: 1, low: 2 };
    out.sort((a, b) => order[a.level] - order[b.level]);
    return {
      anomalies: out,
      high: out.filter((x) => x.level === 'high').length,
      medium: out.filter((x) => x.level === 'medium').length,
      healthy: out.length === 0,
      summary: out.length
        ? `检测到 ${out.length} 项异常（${out.filter((x) => x.level === 'high').length} 项严重）。`
        : '各项监控指标正常，未检测到异常。',
      checkedAt: new Date(now).toISOString(),
    };
  }

  // ============================================================ 渠道载荷

  /** 把告警渲染成一段纯文本（各渠道通用） */
  function renderText(alert) {
    const icon = alert.level === 'high' || alert.level === 'danger' ? '🔴' : alert.level === 'medium' || alert.level === 'warn' ? '🟡' : '🔵';
    const lines = [`${icon} QuantDesk 告警`, '', `【${alert.title}】`, alert.detail || ''];
    if (alert.actual != null && alert.threshold != null) {
      lines.push('', `实际值：${typeof alert.actual === 'number' ? alert.actual.toFixed(2) : alert.actual}　阈值：${alert.threshold}`);
    }
    if (alert.hitAt || alert.at) lines.push(`时间：${new Date(alert.hitAt || alert.at).toLocaleString('zh-CN')}`);
    return lines.filter((x) => x !== undefined && x !== null).join('\n');
  }

  /**
   * 生成某渠道的请求。
   * @returns {{ok, channel, method, url, headers, body, preview, error}}
   */
  function payload(channelKey, cfg, alert) {
    const ch = CHANNEL_MAP[channelKey];
    if (!ch) return { ok: false, error: `未知渠道：${channelKey}` };
    const c = cfg || {};
    const miss = (ch.fields || []).filter((f) => !c[f.key]);
    if (miss.length) return { ok: false, channel: channelKey, error: `缺少配置：${miss.map((f) => f.label).join('、')}`, preview: renderText(alert) };

    const text = renderText(alert);
    switch (channelKey) {
      case 'telegram':
        return {
          ok: true, channel: ch.name, method: 'POST',
          url: `https://api.telegram.org/bot${c.botToken}/sendMessage`,
          headers: { 'Content-Type': 'application/json' },
          body: { chat_id: c.chatId, text, disable_web_page_preview: true },
          preview: text,
        };
      case 'wecom':
        return {
          ok: true, channel: ch.name, method: 'POST',
          url: `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${c.webhookKey}`,
          headers: { 'Content-Type': 'application/json' },
          body: { msgtype: 'text', text: { content: text } },
          preview: text,
        };
      case 'dingtalk':
        return {
          ok: true, channel: ch.name, method: 'POST',
          url: `https://oapi.dingtalk.com/robot/send?access_token=${c.accessToken}`,
          headers: { 'Content-Type': 'application/json' },
          body: { msgtype: 'text', text: { content: text } },
          preview: text,
          note: c.secret ? '已在配置里填写加签 secret，发送时需要在 URL 追加 timestamp 与 sign 参数。' : '',
        };
      case 'webhook':
        return {
          ok: true, channel: ch.name, method: 'POST',
          url: c.url,
          headers: { 'Content-Type': 'application/json', ...(c.secret ? { 'X-QD-Sign': '<HMAC-SHA256 签名>' } : {}) },
          body: { source: 'QuantDesk', level: alert.level || 'info', title: alert.title, detail: alert.detail, actual: alert.actual, threshold: alert.threshold, at: alert.hitAt || alert.at, text },
          preview: text,
        };
      case 'email':
        return {
          ok: true, channel: ch.name, method: 'SMTP',
          url: `${c.host}:${c.port || 465}`,
          headers: { from: c.user, to: c.to, subject: `[QuantDesk] ${alert.title}` },
          body: { text },
          preview: text,
        };
      case 'system':
        return { ok: true, channel: ch.name, method: 'LOCAL', url: 'local://notification', headers: {}, body: { title: alert.title, body: alert.detail }, preview: text };
      default:
        return { ok: false, error: '未实现的渠道' };
    }
  }

  // ============================================================ 监控看板

  /**
   * 组装实时看板数据。
   */
  function dashboard(o) {
    const s = o || {};
    const a = s.account || {};
    const lat = s.performance || {};
    const eq = num(a.equity);
    const peak = Math.max(num(a.peakEquity), eq);
    const dayStart = num(a.dayStartEquity, eq);
    return {
      netValue: eq,
      dayPnl: eq - dayStart,
      dayPnlPct: dayStart > 0 ? ((eq - dayStart) / dayStart) * 100 : 0,
      totalPnl: eq - num(a.initialCash, eq),
      totalPnlPct: num(a.initialCash) > 0 ? ((eq - num(a.initialCash)) / num(a.initialCash)) * 100 : 0,
      drawdownPct: peak > 0 ? ((peak - eq) / peak) * 100 : 0,
      cash: num(a.cash),
      buyingPower: num(a.buyingPower),
      marginUsed: num(a.marginUsed),
      positionCount: (s.positions || []).length,
      pendingOrders: (s.orders || []).filter((x) => x.status === 'submitted' || x.status === 'partially_filled').length,
      latencyMs: num(s.latencyMs),
      lastQuoteAt: s.lastQuoteAt || null,
      heartbeatAt: s.heartbeatAt || null,
      riskLevel: (s.risk && s.risk.level) || 'unknown',
      healthScore: s.health != null ? s.health : null,
      performance: lat,
      tasks: s.tasks || [],
    };
  }

  /** 心跳：判断后台任务与数据源是否还活着 */
  function heartbeat(o) {
    const s = o || {};
    const now = Date.now();
    const last = s.lastBeatAt ? new Date(s.lastBeatAt).getTime() : 0;
    const interval = num(s.intervalMs, 30000);
    const missed = last ? Math.floor((now - last) / interval) - 1 : 0;
    const alive = last > 0 && now - last < interval * 2.5;
    return {
      alive,
      lastBeatAt: s.lastBeatAt || null,
      intervalMs: interval,
      missed: Math.max(0, missed),
      uptimeMs: s.startedAt ? now - new Date(s.startedAt).getTime() : 0,
      label: alive ? (missed > 0 ? `心跳正常（漏拍 ${missed} 次）` : '心跳正常') : last ? '心跳丢失' : '尚未开始',
      note: alive
        ? '调度器按预期运行。'
        : last
        ? `距上次心跳已超过 ${(interval * 2.5 / 1000).toFixed(0)} 秒，检查进程是否被系统挂起。`
        : '调度器还没产生第一次心跳。',
    };
  }

  /** 审计日志条目 */
  function auditEntry(level, category, message, extra) {
    return {
      at: new Date().toISOString(),
      level: level || 'info',
      category: category || 'general',
      message,
      ...(extra || {}),
    };
  }

  /** 默认告警规则：新账户预置几条真正有用的 */
  function defaultRules() {
    return [
      { id: 'def_daily_loss', type: 'daily_loss', value: 3, enabled: true, severity: 'high', symbol: '', note: '单日亏损 3% 就通知，别再自己盯盘' },
      { id: 'def_drawdown', type: 'drawdown', value: 15, enabled: true, severity: 'high', symbol: '', note: '回撤 15% 触发停机线' },
      { id: 'def_risk', type: 'risk_block', value: null, enabled: true, severity: 'high', symbol: '', note: '风控硬拦截立即通知' },
      { id: 'def_order_failed', type: 'order_failed', value: null, enabled: true, severity: 'high', symbol: '', note: '拒单必须知道' },
      { id: 'def_fill', type: 'fill', value: null, enabled: true, severity: 'info', symbol: '', note: '成交通知' },
    ];
  }

  return {
    CHANNELS,
    CHANNEL_MAP,
    RULE_TYPES,
    RULE_MAP,
    ANOMALY_TYPES,
    ANOMALY_MAP,
    evalRule,
    evaluateRules,
    detectAnomalies,
    renderText,
    payload,
    dashboard,
    heartbeat,
    auditEntry,
    defaultRules,
  };
});
