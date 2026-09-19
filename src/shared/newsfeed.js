/**
 * newsfeed.js —— 新闻聚合、分类与情绪打分
 *
 * 设计原则（重要）：
 *   1. 情绪分是「关键词命中 + 时效衰减」算出来的**规则分**，不是模型判断，
 *      因此它有明确的偏差：反讽、否定句（「并未超预期」）、多重否定会被算错。
 *      所以每条新闻都保留命中的词与原始标题，让用户能自己复核，不做黑箱。
 *   2. 打分只用于「排序与提示」，不作为买卖依据。界面上的任何结论都必须能
 *      回溯到具体新闻标题 —— 这是本模块存在的唯一理由。
 *   3. 纯函数、无网络依赖：抓取在主进程做，解析与打分的都在这里，
 *      这样渲染层与冒烟测试可以离线跑同一套逻辑。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Newsfeed = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // ============================================================ 词库

  /**
   * 情绪词库。每条 [词, 权重]，权重 = 强度。
   * 同一句里多个词会叠加，最终被 clamp 到 ±100。
   * 注意：词库只收「方向明确」的词，模糊词（如「关注」「或将」）一律不收，
   * 收了会让分数变成噪音。
   */
  const POSITIVE = [
    ['超预期', 26], ['超出预期', 26], ['上调', 20], ['上修', 20], ['调升', 18],
    ['买入评级', 24], ['增持', 18], ['强烈推荐', 22], ['看多', 16], ['看好', 14],
    ['目标价上调', 24], ['新高', 20], ['创新高', 22], ['突破', 16], ['大涨', 18], ['飙升', 20],
    ['涨停', 18], ['暴涨', 22], ['订单', 16], ['中标', 18], ['大单', 14], ['签约', 12],
    ['回购', 18], ['增持计划', 20], ['分红', 12], ['派息', 12], ['拆股', 8],
    ['获批', 20], ['通过审批', 18], ['获得批准', 18], ['许可', 14],
    ['合作', 10], ['战略合作', 14], ['达成协议', 14], ['收购', 10], ['并购', 10],
    ['扩产', 14], ['产能扩张', 14], ['涨价', 14], ['提价', 14], ['供不应求', 20],
    ['业绩预增', 22], ['扭亏', 20], ['盈利改善', 16], ['毛利率提升', 16],
    ['分析师上调', 22], ['上调评级', 22], ['上调目标价', 22],
    ['政策支持', 16], ['补贴', 12], ['降息', 16], ['降准', 14], ['宽松', 12],
    ['资金流入', 14], ['净流入', 14], ['放量上涨', 16], ['机构增持', 18],
    ['AI', 6], ['人工智能', 6], ['算力', 8], ['数据中心', 6], ['大模型', 6],
    ['强劲', 14], ['亮眼', 14], ['超市场预期', 26], ['好于预期', 22],
  ];

  const NEGATIVE = [
    ['不及预期', -26], ['低于预期', -26], ['未达预期', -24], ['逊于预期', -24],
    ['下调', -20], ['下修', -20], ['调降', -18], ['下调评级', -24], ['下调目标价', -24],
    ['卖出评级', -26], ['减持', -18], ['看空', -18], ['悲观', -14],
    ['亏损', -18], ['巨亏', -24], ['业绩预减', -22], ['由盈转亏', -24],
    ['裁员', -18], ['关停', -16], ['停产', -18], ['停工', -14], ['破产', -30], ['倒闭', -30],
    ['退市', -28], ['ST', -14], ['警示函', -18], ['问询函', -14], ['处罚', -20], ['罚款', -18],
    ['诉讼', -16], ['起诉', -14], ['调查', -16], ['监管调查', -22], ['反垄断', -16],
    ['召回', -18], ['事故', -16], ['泄漏', -14], ['隐瞒', -18], ['造假', -30], ['财务造假', -32],
    ['做空', -18], ['空头报告', -22], ['质押', -12], ['违约', -24], ['债务', -12],
    ['延期', -14], ['推迟', -12], ['取消', -14], ['终止', -16], ['撤回', -14],
    ['大跌', -18], ['暴跌', -22], ['跌停', -18], ['崩盘', -26], ['新低', -18], ['创新低', -20],
    ['资金流出', -14], ['净流出', -14], ['放量下跌', -16], ['机构减持', -18],
    ['高管离职', -14], ['CEO辞职', -16], ['辞职', -12], ['离职', -12],
    ['减持计划', -18], ['限售解禁', -12], ['抛售', -18],
    ['高估', -14], ['泡沫', -16], ['风险提示', -10], ['警报', -12],
    ['加息', -14], ['紧缩', -12], ['通胀', -10], ['衰退', -18], ['关税', -14], ['制裁', -20],
    ['不及市场预期', -26], ['差于预期', -22], ['业绩下滑', -18],
  ];

  /** 主题分类规则：按顺序匹配，第一个命中即归类 */
  const TOPICS = [
    { key: 'earnings', label: '财报业绩', words: ['财报', '业绩', '营收', '净利润', 'EPS', '季报', '年报', '预增', '预减', '指引', '毛利', '盈利'] },
    { key: 'analyst', label: '分析师观点', words: ['评级', '目标价', '分析师', '上调', '下调', '维持', '覆盖', '首次覆盖', '估值'] },
    { key: 'product', label: '产品与技术', words: ['发布', '推出', '新品', '芯片', 'GPU', '模型', '技术', '量产', '产能', '订单', '供货'] },
    { key: 'capital', label: '资本运作', words: ['回购', '增发', '配股', '可转债', '并购', '收购', '合并', '分拆', '拆股', '股权', '注资', '融资'] },
    { key: 'insider', label: '股东高管', words: ['高管', '董事', '持股', '减持', '增持', 'Form 144', '内部人', '辞职'] },
    { key: 'regulatory', label: '监管合规', words: ['监管', 'SEC', '诉讼', '调查', '处罚', '罚款', '合规', '反垄断', '禁令', '出口管制', '制裁'] },
    { key: 'macro', label: '宏观政策', words: ['美联储', 'FOMC', '通胀', 'CPI', '非农', '就业', 'GDP', '利率', '关税', '白宫', '国会', '降息', '加息'] },
    { key: 'market', label: '市场行情', words: ['指数', '大盘', '板块', '资金', '成交', '北向', '标普', '纳斯达克', '道琼斯', 'ETF'] },
    { key: 'industry', label: '行业动态', words: ['行业', '产业链', '竞争对手', '市场份额', '需求', '供给', '价格战'] },
  ];

  const TOPIC_LABEL = { other: '其他' };
  for (const t of TOPICS) TOPIC_LABEL[t.key] = t.label;

  // ============================================================ 基础

  function clean(text) {
    return String(text == null ? '' : text)
      .replace(/<[^>]*>/g, '')       // 去 HTML 标签（东财返回里带 <em>）
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function classify(title, content) {
    const s = clean(title) + ' ' + clean(content);
    for (const t of TOPICS) {
      for (const w of t.words) if (s.includes(w)) return { key: t.key, label: t.label };
    }
    return { key: 'other', label: TOPIC_LABEL.other };
  }

  /**
   * ★ 句子级情绪（个股场景的正确口径）。
   *
   * 为什么需要它：一只股票经常只是被「顺带提及」——
   *   例：「段永平：我会卖点 PLTR 的 put」这条新闻标题讲的是段永平，
   *   整篇标题做情绪打分会得出「与 PLTR 无关的中性分」；
   *   而「智谱AI概念大爆发」的标题是空的，正文里却写着
   *   「Palantir 业绩双双超预期，刺激股价盘后涨超 14%」—— 这是明确的利多。
   *
   * 所以：**先定位到提到该标的的那句话，再对那句话打分**。
   * 标题命中 = 主体新闻（权重 1.0）；仅正文命中 = 提及（权重 0.7）。
   */
  function sentences(text) {
    return String(text || '')
      .split(/[。；;！!？?\n]/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 4);
  }

  function sentimentFor(title, content, keys) {
    const t = clean(title);
    const body = clean(content);
    const ks = (keys || []).filter((k) => k && String(k).length >= 2);
    if (!ks.length) {
      const s = sentiment(t, body);
      return { ...s, focus: 'none', matched: [] };
    }
    const titleHit = ks.filter((k) => wordHit(t, k));
    if (titleHit.length) {
      const s = sentiment(t, ''); // 标题已是主体，正文不再叠加，避免同一事件被重复计分
      return { ...s, focus: 'title', matched: titleHit };
    }
    const hitSentences = [];
    const matched = new Set();
    for (const sent of sentences(body)) {
      for (const k of ks) {
        if (wordHit(sent, k)) {
          hitSentences.push(sent);
          matched.add(k);
        }
      }
    }
    if (hitSentences.length) {
      const joined = hitSentences.join('。');
      const s = sentiment('', joined);
      // 提及类新闻：情绪可信度低于主体新闻，整体打 0.7 折
      return {
        score: Math.max(-100, Math.min(100, Math.round(s.score * 0.7))),
        hits: s.hits, pos: s.pos, neg: s.neg,
        focus: 'body',
        matched: [...matched],
        sentence: joined.slice(0, 120),
      };
    }
    const s = sentiment(t, body);
    return { ...s, score: Math.round(s.score * 0.35), focus: 'weak', matched: [] };
  }

  /**
   * 情绪打分。返回 { score, hits, pos, neg }。
   * score 落在 -100 ~ 100，hits 供界面展示「为什么给这个分」。
   */
  function sentiment(title, content) {
    const t = clean(title);
    const body = clean(content);
    const hits = [];
    let raw = 0;
    for (const [w, v] of POSITIVE) {
      const n = t.split(w).length - 1;
      if (n > 0) {
        raw += v * (1 + 0.35 * (n - 1));
        hits.push({ word: w, weight: v, where: 'title', count: n });
      }
    }
    for (const [w, v] of POSITIVE) {
      const n = body.split(w).length - 1;
      if (n > 0) {
        raw += v * 0.45 * (1 + 0.35 * (n - 1)); // 正文权重显著低于标题
        hits.push({ word: w, weight: v, where: 'body', count: n });
      }
    }
    for (const [w, v] of NEGATIVE) {
      const n = t.split(w).length - 1;
      if (n > 0) {
        raw += v * (1 + 0.35 * (n - 1));
        hits.push({ word: w, weight: v, where: 'title', count: n });
      }
    }
    for (const [w, v] of NEGATIVE) {
      const n = body.split(w).length - 1;
      if (n > 0) {
        raw += v * 0.45 * (1 + 0.35 * (n - 1));
        hits.push({ word: w, weight: v, where: 'body', count: n });
      }
    }
    const score = Math.max(-100, Math.min(100, Math.round(raw)));
    const pos = hits.filter((h) => h.weight > 0).length;
    const neg = hits.filter((h) => h.weight < 0).length;
    return { score, hits: hits.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)).slice(0, 8), pos, neg };
  }

  /** 时效衰减：越新权重越高。半衰期 3 天。 */
  function freshness(dateStr, now) {
    const t = toTime(dateStr);
    if (t == null) return 0.45; // 时间未知的给中性偏低的权重，不假装它很新
    const hours = Math.max(0, ((now || Date.now()) - t) / 3600000);
    return Math.pow(0.5, hours / (24 * 3));
  }

  /** 解析多种常见时间格式为毫秒时间戳；失败返回 null */
  function toTime(dateStr) {
    if (dateStr == null) return null;
    if (typeof dateStr === 'number') return dateStr < 1e12 ? dateStr * 1000 : dateStr;
    const s = String(dateStr).trim();
    // 2026-09-19 12:30:22
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime();
    // 09/18/2026 或 Sep 18, 2026
    m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (m) return new Date(+m[3], +m[1] - 1, +m[2]).getTime();
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  }

  /** 去重：标题前 24 字相同即视为同一条（东财同一事件会有多篇转载） */
  function dedupe(list) {
    const seen = new Map();
    const out = [];
    for (const n of list || []) {
      if (!n || !n.title) continue;
      const k = clean(n.title).slice(0, 24);
      if (seen.has(k)) {
        const prev = seen.get(k);
        // 保留信息更全的那条（有正文 / 有来源优先）
        if (!prev.content && n.content) Object.assign(prev, n);
        prev.dupCount = (prev.dupCount || 1) + 1;
        continue;
      }
      const item = { ...n, title: clean(n.title), content: clean(n.content) };
      seen.set(k, item);
      out.push(item);
    }
    return out;
  }

  /**
   * 给一批新闻打分并补充派生字段。
   * @param {Array} list 原始新闻 [{title, content, date, url, source, code, symbol}]
   * @param {Object} [opt] { now, keysOf }
   *   keysOf(item) → 用于定位「这条新闻在讲谁」的关键词数组。
   *   默认取 item.symbol。有了它才能做句子级打分（见 sentimentFor）。
   */
  function score(list, opt) {
    const o = opt || {};
    const now = o.now || Date.now();
    const keysOf = o.keysOf || ((n) => [n.symbol].filter(Boolean));
    const rows = dedupe(list).map((n) => {
      const keys = keysOf(n);
      const s = keys.length ? sentimentFor(n.title, n.content, keys) : { ...sentiment(n.title, n.content), focus: 'none' };
      const topic = classify(n.title, n.content);
      const f = freshness(n.date, now);
      const t = toTime(n.date);
      return {
        ...n,
        topic: topic.key,
        topicLabel: topic.label,
        senti: s.score,
        sentiHits: s.hits,
        sentiFocus: s.focus,        // title = 主体新闻 / body = 仅被提及 / weak = 关联很弱
        sentiSentence: s.sentence || null,
        matched: s.matched || [],
        freshness: Number(f.toFixed(3)),
        // 加权分：情绪 × 时效。用于排序，不用于决策。
        weight: Number((s.score * f).toFixed(2)),
        ts: t,
        ageHours: t == null ? null : Math.round((now - t) / 3600000),
      };
    });
    return rows.sort((a, b) => {
      if (a.ts != null && b.ts != null) return b.ts - a.ts;
      return b.weight - a.weight;
    });
  }

  /**
   * 汇总一批已打分新闻。
   * 主体新闻（标题命中）比「仅被提及」的新闻权重更高 —— 直接权重是 1.0 vs 0.7 vs 0.35。
   * @returns {{sentiment, bullish, bearish, neutral, byTopic, topRisk, topBull, summary}}
   */
  function summarize(rows) {
    const list = rows || [];
    if (!list.length) {
      return {
        count: 0, sentiment: 0, bullish: 0, bearish: 0, neutral: 0,
        byTopic: [], topRisk: null, topBull: null, focus: { title: 0, body: 0, weak: 0 },
        summary: '近 7 日没有抓到与该标的直接相关的新闻。注意：抓不到 ≠ 没有消息，只说明当前数据源无收录。',
      };
    }
    const FOCUS_W = { title: 1, body: 0.7, weak: 0.35, none: 1 };
    let wsum = 0;
    let wtot = 0;
    let bull = 0;
    let bear = 0;
    let neu = 0;
    const byTopic = {};
    const focus = { title: 0, body: 0, weak: 0 };
    for (const r of list) {
      const fw = FOCUS_W[r.sentiFocus] == null ? 1 : FOCUS_W[r.sentiFocus];
      const w = (r.freshness || 0.5) * fw;
      wsum += r.senti * w;
      wtot += w;
      if (r.senti >= 12) bull++;
      else if (r.senti <= -12) bear++;
      else neu++;
      if (focus[r.sentiFocus] != null) focus[r.sentiFocus]++;
      const k = r.topic || 'other';
      if (!byTopic[k]) byTopic[k] = { key: k, label: r.topicLabel || k, count: 0, senti: 0 };
      byTopic[k].count++;
      byTopic[k].senti += r.senti;
    }
    const sentiment = wtot > 0 ? Math.round(wsum / wtot) : 0;
    const sorted = list.slice().sort((a, b) => a.senti - b.senti);
    const topRisk = sorted[0] && sorted[0].senti < -8 ? sorted[0] : null;
    const topBull = sorted[sorted.length - 1] && sorted[sorted.length - 1].senti > 8 ? sorted[sorted.length - 1] : null;

    const mood = sentiment >= 25 ? '明显偏多' : sentiment >= 8 ? '偏多' : sentiment <= -25 ? '明显偏空' : sentiment <= -8 ? '偏空' : '中性';
    const parts = [`近 7 日抓到 ${list.length} 条相关新闻，加权情绪 ${sentiment}（${mood}）`];
    parts.push(`偏多 ${bull} / 偏空 ${bear} / 中性 ${neu}` + (focus.title ? `，其中 ${focus.title} 条为直接报道` : '，均为顺带提及'));
    if (topBull) parts.push(`最强利多：「${topBull.title.slice(0, 36)}」`);
    if (topRisk) parts.push(`最强利空：「${topRisk.title.slice(0, 36)}」`);

    return {
      count: list.length, sentiment,
      bullish: bull, bearish: bear, neutral: neu,
      focus,
      byTopic: Object.values(byTopic).sort((a, b) => b.count - a.count),
      topRisk, topBull,
      summary: parts.join('；') + '。',
    };
  }

  /** 从东财 jsonp 文本里取 JSON（主进程调用后用这个解析） */
  function parseJsonp(text) {
    const s = String(text || '').trim();
    const a = s.indexOf('(');
    const b = s.lastIndexOf(')');
    const body = a >= 0 && b > a ? s.slice(a + 1, b) : s;
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }

  /** 英文词边界匹配（避免 "AI" 命中 "said"、"US" 命中 "because" 这类误伤） */
  function wordHit(text, word) {
    if (!word) return false;
    const w = String(word);
    if (/^[A-Za-z.\-]{1,6}$/.test(w)) {
      const re = new RegExp(`(^|[^A-Za-z0-9])${w.replace(/[.\-]/g, '\\$&')}([^A-Za-z0-9]|$)`, 'i');
      return re.test(text);
    }
    return text.includes(w);
  }

  /**
   * ★ 相关性过滤（这一步非常关键）：
   *   东财搜索是全文检索，搜一个代码会返回大量**泛市场新闻**
   *   （例：搜 PLTR 会返回「智谱AI概念大爆发」这种完全无关的稿子）。
   *   不过滤的话，个股的情绪分会变成大盘情绪分的复读机 ——
   *   看上去有数据，实际上跟这只票毫无关系。这是本模块最容易出错的地方。
   *
   * @param {Array} list 已清洗的新闻
   * @param {Object} target { symbol, name, aliases:[] }
   * @param {Object} [opt] { strict } strict=true 时要求命中标题（默认标题或正文命中即可）
   */
  function relevant(list, target, opt) {
    const t = target || {};
    const o = opt || {};
    const keys = [t.symbol, t.name, ...(t.aliases || [])]
      .filter((x) => x && String(x).trim())
      .map((x) => String(x).trim())
      // 太短或纯数字的标的不参与匹配
      .filter((x) => x.length >= 2);
    if (!keys.length) return list || [];
    return (list || []).filter((n) => {
      const title = clean(n.title);
      const body = clean(n.content);
      for (const k of keys) {
        if (wordHit(title, k)) return true;
        if (!o.strict && wordHit(body, k)) return true;
      }
      return false;
    });
  }

  /**
   * 把东财搜索返回的行转成统一新闻结构。
   * @param {Array} rows 东财 cmsArticleWebOld 数组
   * @param {String} [symbol] 关联标的（用来给每条新闻打标）
   */
  function fromEastmoney(rows, symbol) {
    return (rows || []).map((r) => ({
      title: clean(r.title),
      content: clean(r.content || r.digest || ''),
      date: r.date || r.showTime || r.time || null,
      url: r.url || r.articleUrl || (r.code ? `https://finance.eastmoney.com/a/${r.code}.html` : ''),
      source: r.mediaName || r.source || '东方财富',
      symbol: symbol || null,
      code: r.code || null,
    })).filter((n) => n.title);
  }

  /**
   * 事件级风险提示：把「新闻情绪」翻译成一句可执行的风险描述。
   * 输入是 summarize() 的结果 + 可选的事件上下文（距财报天数等）。
   */
  function riskNote(summary, ctx) {
    const c = ctx || {};
    const notes = [];
    if (summary && summary.sentiment <= -25) notes.push('新闻面明显偏空，短期消息驱动的下跌风险偏高');
    else if (summary && summary.sentiment <= -8) notes.push('新闻面略偏空，留意利空的后续发酵');
    if (c.daysToEarnings != null && c.daysToEarnings >= 0 && c.daysToEarnings <= 7)
      notes.push(`距财报仅 ${c.daysToEarnings} 天，业绩不确定性进入高发窗口（财报前后波动通常显著放大）`);
    if (c.daysToMacro != null && c.daysToMacro >= 0 && c.daysToMacro <= 3)
      notes.push(`距宏观数据/议息仅 ${c.daysToMacro} 天，指数级波动可能传导到个股`);
    return notes;
  }

  return {
    POSITIVE, NEGATIVE, TOPICS, TOPIC_LABEL,
    clean, classify, sentiment, sentimentFor, sentences, freshness, toTime,
    dedupe, score, summarize, parseJsonp, fromEastmoney, riskNote,
    relevant, wordHit,
  };
});
