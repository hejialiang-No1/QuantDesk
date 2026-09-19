/**
 * api-push.js —— 当 git push 通道不通时，用 GitHub Contents API 提交单个文件
 *
 * 背景：本机网络对 github.com 的 git 协议极不稳定（CONNECT tunnel failed 502 /
 * HTTP2 framing error / 直连超时），但 api.github.com 可以直连。
 * 于是用 Contents API 提交改动 —— 它同样会生成一个正常的 commit。
 *
 * 用法: node scripts/api-push.js <文件相对路径> <commit标题> [commit正文...]
 *   令牌从 git 凭据助手取（与 git push 用同一份凭据），不额外读取钥匙串。
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OWNER = 'hejialiang-No1';
const REPO = 'QuantDesk';
const BRANCH = 'main';

const rel = process.argv[2];
const title = process.argv[3];
const bodyLines = process.argv.slice(4);
if (!rel || !title) {
  console.error('用法: node scripts/api-push.js <文件相对路径> <commit标题> [正文...]');
  process.exit(1);
}

const abs = path.join(ROOT, rel);
if (!fs.existsSync(abs)) {
  console.error('文件不存在：' + abs);
  process.exit(1);
}

function token() {
  const out = execSync(`printf "protocol=https\\nhost=github.com\\n\\n" | git -c http.proxy= credential fill`, {
    encoding: 'utf8',
    cwd: ROOT,
  });
  const m = out.match(/^password=(.+)$/m);
  if (!m) throw new Error('未能从 git 凭据助手取得令牌');
  return m[1].trim();
}

async function api(method, apiPath, payload) {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}${apiPath}`, {
    method,
    headers: {
      Authorization: `token ${token()}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'quantdesk-api-push',
      'Content-Type': 'application/json',
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应 */
  }
  return { status: res.status, json, text };
}

(async () => {
  // 1) 取当前文件 sha（Contents API 更新时必须带上，否则会报 422）
  //    新建文件时接口返回 404，此时**不能**带 sha，否则会把「创建」当成「更新不存在的内容」而失败。
  const cur = await api('GET', `/contents/${encodeURIComponent(rel)}?ref=${BRANCH}`);
  let sha = null;
  if (cur.status === 200) {
    sha = cur.json.sha;
  } else if (cur.status === 404) {
    console.log('   远端尚无此文件 → 按新建提交');
  } else {
    console.error('❌ 读取远端文件失败：HTTP ' + cur.status + ' ' + (cur.json && cur.json.message));
    process.exit(1);
  }
  const content = fs.readFileSync(abs).toString('base64');

  // 2) 提交
  const message = [title, ...bodyLines].join('\n\n');
  const payload = {
    message,
    content,
    branch: BRANCH,
    committer: { name: 'hejialiang', email: 'hejialiang@users.noreply.github.com' },
  };
  if (sha) payload.sha = sha;
  const put = await api('PUT', `/contents/${encodeURIComponent(rel)}`, payload);

  if (put.status === 200 || put.status === 201) {
    const c = put.json.commit;
    console.log('✅ 已通过 API 提交');
    console.log('   commit :', c.sha.slice(0, 12));
    console.log('   内容   :', (c.message || '').split('\n')[0]);
    console.log('   链接   :', put.json.commit.html_url);
    console.log('');
    console.log('   注意：本地 git 历史未包含这个 commit（SHA 与本地不同但内容一致）。');
    console.log('   网络恢复后建议执行：git fetch origin && git reset --hard origin/main');
  } else {
    console.error('❌ 提交失败：HTTP ' + put.status);
    console.error('   ' + (put.json ? put.json.message : put.text.slice(0, 200)));
    process.exit(1);
  }
})().catch((e) => {
  console.error('❌ 失败：', e.message);
  process.exit(1);
});
