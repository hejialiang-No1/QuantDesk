/**
 * notify.js —— 告警真实投递
 * 把 alerts.js 生成的 payload 真正发出去：
 *   · Telegram / 企业微信机器人 / 钉钉机器人 / 通用 Webhook → HTTP POST（Node 18+ 原生 fetch）
 *   · 邮件 → 直连 SMTP（465 隐式 TLS 或 587 STARTTLS，自带最简 MIME 组包）
 *   · 系统通知 → 交给主进程的 Notification
 *
 * 设计边界：这里只负责「把一条告警送出去」。规则求值、异常检测都在 alerts.js（纯函数），
 * 本文件不做任何判断，避免告警口径分裂成两套。
 */
const tls = require('tls');
const net = require('net');
const crypto = require('crypto');
const Alerts = require('../shared/alerts');

const HTTP_TIMEOUT_MS = 12000;
const SMTP_TIMEOUT_MS = 20000;
const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');

/** 钉钉加签：timestamp + "\n" + secret 做 HMAC-SHA256，再 base64 + urlencode */
function dingSign(secret, ts) {
  const time = ts || Date.now();
  const sign = crypto.createHmac('sha256', secret).update(`${time}\n${secret}`, 'utf8').digest('base64');
  return { ts: time, sign: encodeURIComponent(sign) };
}

async function httpPost(url, headers, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(headers || {}) },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text().catch(() => '');
    return { ok: res.ok, status: res.status, detail: text.slice(0, 400) };
  } catch (e) {
    return { ok: false, status: 0, detail: e.name === 'AbortError' ? '请求超时（12s）' : String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------ SMTP

/**
 * 最简 SMTP 会话：EHLO → (STARTTLS) → [AUTH LOGIN] → MAIL/RCPT/DATA → QUIT
 * 用显式状态机而不是「发一句等一句」，因为响应可能是多行（如 EHLO 的能力列表）。
 */
function smtpSend(cfg, subject, text) {
  const host = cfg.host;
  const port = Number(cfg.port || 465);
  // 隐式 TLS 的判定：默认看端口（465 = SSL，587 = STARTTLS），
  // 但允许用 cfg.secure 显式覆盖 —— 有些服务商把 SSL 端口放在 8465 或 2525 之类的非标端口上。
  const implicitTLS = cfg.secure != null ? !!cfg.secure : port === 465;
  const from = cfg.user || 'quantdesk@localhost';
  const to = cfg.to;

  return new Promise((resolve) => {
    let socket = null;
    let buffer = '';
    let step = 'connect'; // connect → ehlo → starttls → ehlo(第二次) → auth_user → auth_pass → mail → rcpt → data → body → quit
    let tlsUpgraded = false;
    let done = false;
    const steps = [];

    const finish = (ok, detail) => {
      if (done) return;
      done = true;
      try { socket && socket.end(); } catch { /* 已断开 */ }
      resolve({ ok, detail, steps });
    };

    const timer = setTimeout(
      () => finish(false, `SMTP 超时（${SMTP_TIMEOUT_MS / 1000}s），最后一步 ${step}：${steps[steps.length - 1] || '连接'}`),
      SMTP_TIMEOUT_MS
    );

    const write = (line) => {
      try { socket.write(line + '\r\n'); } catch (e) { finish(false, String(e.message || e)); }
    };

    const buildMessage = () => {
      const head = [
        `From: QuantDesk <${from}>`,
        `To: <${to}>`,
        `Subject: =?UTF-8?B?${b64(subject)}?=`,
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: <${Date.now()}.${crypto.randomBytes(6).toString('hex')}@quantdesk.local>`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
      ].join('\r\n');
      // 正文按 76 列折行（RFC 2045）：部分服务端会截断超长行
      const folded = b64(text).replace(/(.{76})/g, '$1\r\n');
      return `${head}\r\n${folded}\r\n.`;
    };

    const onLine = (line) => {
      steps.push(line.slice(0, 140));
      const code = line.slice(0, 3);
      if (code[0] === '4' || code[0] === '5') {
        // 4xx/5xx 一律当作失败并回报服务端原文，方便用户自己判断（如 535 认证失败）
        finish(false, `SMTP 返回 ${line.slice(0, 180)}`);
        return;
      }
      switch (step) {
        case 'connect':
          if (code === '220') { step = 'ehlo'; write('EHLO quantdesk.local'); }
          break;
        case 'ehlo':
          if (code === '250') {
            // 已经升级过 TLS（第二次 EHLO）或本来就是 465 隐式 TLS，直接进认证
            if (implicitTLS || tlsUpgraded) beginAuth();
            else { step = 'starttls'; write('STARTTLS'); }
          }
          break;
        case 'starttls':
          if (code === '220') upgradeToTLS();
          break;
        case 'auth':
          // AUTH LOGIN 的第一条 334 是 "Username:" 提示 —— 这里才发用户名。
          // （注意：不能在发 AUTH LOGIN 时就把用户名发出去，否则会把密码当成用户名发，
          //   服务端只会回一个 535，看起来像"密码错误"，实际是顺序错了。）
          if (code === '334') { step = 'auth_user'; write(b64(cfg.user)); }
          break;
        case 'auth_user':
          if (code === '334') { step = 'auth_pass'; write(b64(cfg.pass)); }
          break;
        case 'auth_pass':
          if (code === '235') { step = 'mail'; write(`MAIL FROM:<${from}>`); }
          break;
        case 'mail':
          if (code === '250') { step = 'rcpt'; write(`RCPT TO:<${to}>`); }
          break;
        case 'rcpt':
          if (code === '250' || code === '251') { step = 'data'; write('DATA'); }
          break;
        case 'data':
          if (code === '354') { step = 'body'; write(buildMessage()); }
          break;
        case 'body':
          if (code === '250') {
            clearTimeout(timer);
            step = 'quit';
            write('QUIT');
            finish(true, `已投递到 ${to}（${host}:${port}，${implicitTLS ? 'SSL' : 'STARTTLS'}）`);
          }
          break;
        default:
          break;
      }
    };

    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (/^\d{3}-/.test(line)) continue; // 多行响应的续行
        onLine(line);
        if (done) return;
      }
    };

    function beginAuth() {
      if (!cfg.user || !cfg.pass) {
        // 允许无认证的本地中继
        step = 'mail';
        write(`MAIL FROM:<${from}>`);
        return;
      }
      step = 'auth';
      write('AUTH LOGIN');
    }

    function upgradeToTLS() {
      socket.removeListener('data', onData);
      tlsUpgraded = true;
      socket = tls.connect({ socket, ...tlsOpts(), rejectUnauthorized: false }, () => {
        socket.on('data', onData);
        step = 'ehlo';
        write('EHLO quantdesk.local');
      });
      socket.on('error', (e) => finish(false, 'TLS 握手失败：' + String(e.message || e)));
    }

    /** servername 只有传域名才有意义；传 IP 会触发 RFC 6066 弃用告警 */
    const tlsOpts = () => (/^\d+\.\d+\.\d+\.\d+$/.test(host) ? {} : { servername: host });

    try {
      if (implicitTLS) {
        socket = tls.connect({ host, port, ...tlsOpts(), rejectUnauthorized: false }, () => socket.on('data', onData));
      } else {
        socket = net.connect({ host, port }, () => socket.on('data', onData));
      }
      socket.setTimeout(SMTP_TIMEOUT_MS);
      socket.on('timeout', () => finish(false, 'SMTP 连接超时'));
      socket.on('error', (e) => finish(false, 'SMTP 连接失败：' + String(e.message || e)));
    } catch (e) {
      finish(false, String(e.message || e));
    }
  });
}

// ------------------------------------------------------------------ 投递

/**
 * 发送一条告警到指定渠道。
 * @param {String} channelKey telegram | wecom | dingtalk | webhook | email | system
 * @param {Object} cfg 渠道配置（与 alerts.js CHANNELS[].fields 对应）
 * @param {Object} alert { level, title, detail, actual, threshold, hitAt }
 * @param {Object} [deps] { notify } 系统通知的注入实现（由 main.js 传入 Notification）
 */
async function send(channelKey, cfg, alert, deps) {
  const p = Alerts.payload(channelKey, cfg, alert);
  if (!p.ok) return { ok: false, channel: channelKey, detail: p.error || '配置不完整', preview: p.preview || '' };

  if (channelKey === 'email') {
    const r = await smtpSend(cfg, p.headers.subject, p.body.text);
    return { ok: r.ok, channel: p.channel, detail: r.detail, preview: p.preview, steps: r.steps };
  }

  if (channelKey === 'system') {
    const n = deps && deps.notify;
    if (typeof n !== 'function') {
      return { ok: false, channel: p.channel, detail: '系统通知不可用（需在主进程调用）', preview: p.preview };
    }
    try {
      n(p.body.title, p.body.body);
      return { ok: true, channel: p.channel, detail: '已弹出系统通知', preview: p.preview };
    } catch (e) {
      return { ok: false, channel: p.channel, detail: String(e.message || e), preview: p.preview };
    }
  }

  let url = p.url;
  if (channelKey === 'dingtalk' && cfg.secret) {
    const s = dingSign(cfg.secret);
    url += `&timestamp=${s.ts}&sign=${s.sign}`;
  }
  const r = await httpPost(url, p.headers, p.body);
  return {
    ok: r.ok,
    channel: p.channel,
    detail: r.ok ? `HTTP ${r.status} 已送达` : `HTTP ${r.status} ${r.detail}`,
    preview: p.preview,
  };
}

/** 批量投递：单个渠道失败不影响其他渠道 */
async function sendAll(channelKeys, channelsCfg, alert, deps) {
  const out = [];
  for (const key of channelKeys || []) {
    const cfg = (channelsCfg || {})[key] || {};
    try {
      out.push({ key, ...(await send(key, cfg, alert, deps)) });
    } catch (e) {
      out.push({ key, ok: false, detail: String(e.message || e) });
    }
  }
  return out;
}

module.exports = { send, sendAll, smtpSend, dingSign, httpPost };
