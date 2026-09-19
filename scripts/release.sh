#!/bin/bash
# 创建 GitHub Release 并上传 dmg
# 用法: bash scripts/release.sh <GITHUB_TOKEN>
#
# 发布说明放在 release-notes/<tag>.md，由 node 组装成 JSON 后再提交。
# 不要把说明内联进 shell 字符串——里面的反引号会被 shell 当命令替换执行，
# 结果是说明内容被悄悄吃掉（踩过坑）。
set -e
cd "$(dirname "$0")/.."
# 默认走本机 Clash 代理；如网络环境不同，用 RELEASE_PROXY 覆盖
# （注意：不要直接读 HTTPS_PROXY，沙箱/CI 里常被设成一个不可用的本地代理）
export HTTPS_PROXY="${RELEASE_PROXY:-socks5h://127.0.0.1:7890}"
export HTTP_PROXY="${RELEASE_PROXY:-socks5h://127.0.0.1:7890}"
TOKEN="$1"
# node 用于组装/解析 JSON，优先用 PATH 里的，退回到 WorkBuddy 托管版本（不要硬编码版本号）
NODE_BIN="$(command -v node 2>/dev/null || ls -d /Users/hejialiang/.workbuddy/binaries/node/versions/*/bin/node 2>/dev/null | tail -1)"
[ -n "$NODE_BIN" ] || { echo "❌ 找不到可用的 node"; exit 1; }
[ -n "$TOKEN" ] || { echo "用法: bash scripts/release.sh <GITHUB_TOKEN>"; exit 1; }

OWNER="hejialiang-No1"
REPO="QuantDesk"
# 版本号与产物名全部从 package.json 推导，避免「代码发新版、Release 打旧包」
VER="$("$NODE_BIN" -e "process.stdout.write(require('./package.json').version)")"
TAG="v$VER"
RELEASE_NAME="QuantDesk v$VER —— 美股量化终端"
DMG="build/QuantDesk-$VER-arm64.dmg"
NOTES="release-notes/$TAG.md"

[ -f "$DMG" ] || { echo "❌ 找不到安装包 $DMG"; exit 1; }
[ -f "$NOTES" ] || { echo "❌ 找不到发布说明 $NOTES"; exit 1; }

PAYLOAD="$(mktemp -t release_payload)"
trap 'rm -f "$PAYLOAD"' EXIT
"$NODE_BIN" -e '
const fs = require("fs");
const [tag, name, notes, out] = process.argv.slice(1);
fs.writeFileSync(out, JSON.stringify({
  tag_name: tag,
  name: name,
  body: fs.readFileSync(notes, "utf8"),
  draft: false,
  prerelease: false,
}));
' "$TAG" "$RELEASE_NAME" "$NOTES" "$PAYLOAD"

echo "[1/3] 创建 Release $TAG ..."
REL=$(curl -s -m 60 -X POST \
  -H "Authorization: token $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$OWNER/$REPO/releases" \
  --data-binary @"$PAYLOAD")

REL_ID=$(printf '%s' "$REL" | "$NODE_BIN" -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(s);console.log(j.id?j.id:'ERR:'+(j.message||''))}catch(e){console.log('ERR:JSON 解析失败 '+s.slice(0,200))}})")
echo "    Release ID: $REL_ID"

case "$REL_ID" in
  ERR:*) echo "    ❌ 创建失败: ${REL_ID#ERR:}"; exit 1 ;;
esac

echo "[2/3] 上传 dmg ($(du -h "$DMG" | cut -f1)) ..."
curl -s -m 900 --retry 3 --retry-delay 5 \
  -X POST \
  -H "Authorization: token $TOKEN" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @"$DMG" \
  "https://uploads.github.com/repos/$OWNER/$REPO/releases/$REL_ID/assets?name=$(basename "$DMG")" \
  | "$NODE_BIN" -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(s);if(j.id){console.log('    ✅ 上传成功:',j.name,(j.size/1048576).toFixed(1)+'MB','| 下载:',j.browser_download_url)}else{console.log('    ❌',j.message)}}catch(e){console.log('    RAW:',s.slice(0,200))}})"

echo "[3/3] 完成: https://github.com/$OWNER/$REPO/releases/tag/$TAG"
