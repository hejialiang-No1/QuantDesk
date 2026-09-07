#!/bin/bash
# setup-electron.sh —— 当 npm install 装不上 electron 时手动装配（国内网络场景）
# 用法：bash scripts/setup-electron.sh [版本号]
set -e
VER="${1:-44.2.0}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

MIRROR="https://registry.npmmirror.com/-/binary/electron"
ZIP="/tmp/electron-v${VER}-darwin-arm64.zip"
echo "==> 下载 Electron ${VER} macOS arm64"
curl -fsSL -o "$ZIP" "${MIRROR}/${VER}/electron-v${VER}-darwin-arm64.zip"
echo "==> 下载完成 $(du -h $ZIP | cut -f1)"

mkdir -p node_modules/electron
rm -rf node_modules/electron/dist

# path.txt 是 electron npm 包用来定位二进制相对路径的清单
echo "Electron.app/Contents/MacOS/Electron" > node_modules/electron/path.txt

cat > node_modules/electron/index.js << 'EOF'
'use strict';
var path = require('path');
var fs = require('fs');
var pathFile = path.join(__dirname, 'path.txt');
var pathFileContents;
try { pathFileContents = fs.readFileSync(pathFile, 'utf-8'); } catch (e) {}
var inner = (pathFileContents && pathFileContents.length > 1)
  ? pathFileContents.trim()
  : 'Electron.app/Contents/MacOS/Electron';
module.exports = path.resolve(__dirname, inner);
EOF

# 触发 require('electron') 的安装钩子也被依赖：写一个 install.js（供 npm 重新触发时）
cat > node_modules/electron/install.js << 'EOF'
'use strict';
module.exports = function () { return 0; };
EOF

# 解压二进制
echo "==> 解压到 node_modules/electron/dist"
unzip -q "$ZIP" -d node_modules/electron/dist
ls node_modules/electron/dist/ | head -3
BIN="node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
[ -x "$BIN" ] && echo "==> 二进制就绪：$BIN" || { echo "!! 二进制缺失"; exit 1; }
chmod +x "$BIN"
# 让 ./node_modules/.bin/electron 也能用（npm 默认创建符号链接指向 index.js）
mkdir -p node_modules/.bin
ln -sf ../electron/index.js node_modules/.bin/electron

echo "==> Electron ${VER} 装配完成"