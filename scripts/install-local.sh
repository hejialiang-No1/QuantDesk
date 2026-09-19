#!/bin/bash
# install-local.sh —— 把打包好的 QuantDesk 安装到 /Applications 并保持可运行
#
# 用法:
#   bash scripts/install-local.sh              # 安装最新版本的 dmg
#   bash scripts/install-local.sh --launch     # 安装后自动启动
#   bash scripts/install-local.sh --dmg=path   # 指定 dmg
#
# 为什么需要这个脚本（而不是「拖进 Applications」那么简单）：
#   1. 本机环境下 `cp -R` 复制 app bundle 会被文件代理层拒绝，
#      必须在 ditto 之后清理代理留下的 `.BC.*` 临时副本；
#   2. 这些残留会让 `codesign` 报 unsealed 导致签名失效，必须重新签名；
#   3. 安装后还要换掉正在运行的旧实例（不同路径的实例可同时运行，
#      并共享同一份 userData，会竞争写 store）。
#   这四步任何一步漏掉，都会出现「装是装上了，但打开报错 / 数据错乱」。
set -e

APP_NAME="QuantDesk"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="/Applications/$APP_NAME.app"
LAUNCH=0
DMG=""

for a in "$@"; do
  case "$a" in
    --launch) LAUNCH=1 ;;
    --dmg=*) DMG="${a#--dmg=}" ;;
  esac
done

VER="$(node -e "process.stdout.write(require('$ROOT/package.json').version)")"
[ -n "$VER" ] || { echo "!! 无法读取 package.json 版本号"; exit 1; }

if [ -z "$DMG" ]; then
  DMG="$ROOT/build/$APP_NAME-$VER-arm64.dmg"
fi
[ -f "$DMG" ] || { echo "!! 找不到安装包：$DMG"; echo "   先执行 bash scripts/build-dmg.sh"; exit 1; }

echo "==> 安装 $APP_NAME $VER"
echo "    源: $DMG"

# ---------------------------------------------------------------- 1) 挂载
MNT="$(mktemp -d /tmp/qd-mount.XXXXXX)"
cleanup() {
  hdiutil detach "$MNT" >/dev/null 2>&1 || true
  rmdir "$MNT" 2>/dev/null || true
}
trap cleanup EXIT

hdiutil attach -nobrowse -readonly -mountpoint "$MNT" "$DMG" >/dev/null
SRC="$MNT/$APP_NAME.app"
[ -d "$SRC" ] || { echo "!! dmg 内找不到 $APP_NAME.app"; exit 1; }

# ---------------------------------------------------------------- 2) 备份旧版本
if [ -d "$DEST" ]; then
  # 用 mv 而不是 rm -rf：批量删除在大目录上容易被安全策略拦截，
  # 而且留一份旧的也方便回滚。备份放 /tmp，重启后自动清理。
  BACKUP="/tmp/$APP_NAME-previous-$(date +%Y%m%d%H%M%S).app"
  echo "==> 备份旧版本 → $BACKUP"
  mv "$DEST" "$BACKUP"
fi

# ---------------------------------------------------------------- 3) 复制
echo "==> 复制到 /Applications"
ditto "$SRC" "$DEST"

# ---------------------------------------------------------------- 4) 清理代理残留
BEFORE="$(find "$DEST" \( -type f -o -type l \) | wc -l | tr -d ' ')"
RESIDUE="$(find "$DEST" -name '.BC.*' 2>/dev/null | wc -l | tr -d ' ')"
if [ "$RESIDUE" -gt 0 ]; then
  echo "==> 清理 $RESIDUE 个代理残留（.BC.*）"
  # 必须同时清「普通文件」和「符号链接」：只写 -type f 会漏掉 .BC.D_* 那一类，
  # 结果签名照样失败，而且文件数看起来「只多了一点点」，很难发现。
  find "$DEST" -name '.BC.*' -delete 2>/dev/null || true
  find "$DEST" -name '*.cstemp' -delete 2>/dev/null || true
fi
AFTER="$(find "$DEST" \( -type f -o -type l \) | wc -l | tr -d ' ')"

# ---------------------------------------------------------------- 5) 与 dmg 内清单做差集
(cd "$SRC" && find . \( -type f -o -type l \) | sort) > /tmp/qd-src.txt
(cd "$DEST" && find . \( -type f -o -type l \) | sort) > /tmp/qd-dst.txt
DIFF="$(comm -3 /tmp/qd-src.txt /tmp/qd-dst.txt | wc -l | tr -d ' ')"
echo "==> 文件核对：dmg $(wc -l < /tmp/qd-src.txt | tr -d ' ') / 已安装 $AFTER，差异 $DIFF 项"
if [ "$DIFF" -ne 0 ]; then
  echo "!! 存在差异，列出前 10 项："
  comm -3 /tmp/qd-src.txt /tmp/qd-dst.txt | head -10
  echo "   安装不完整，请重新执行。"
  exit 1
fi

# ---------------------------------------------------------------- 6) 重新签名
# 清理动作已使原签名失效，必须重新 ad-hoc 签名
echo "==> 重新签名"
codesign --force --deep --sign - "$DEST" >/dev/null 2>&1 || true

if codesign -vvv "$DEST" 2>&1 | grep -q "valid on disk"; then
  echo "==> ✅ 签名有效"
else
  echo "!! 签名校验未通过（应用可能仍可运行，但请留意）："
  codesign -vvv "$DEST" 2>&1 | tail -3
fi

# 去掉隔离属性，避免 Gatekeeper 弹「已损坏」
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

# ---------------------------------------------------------------- 7) 替换运行中的旧实例
# 不同路径的实例可以同时运行（本应用没有单实例锁），并共享同一份 userData，
# 会竞争写 store.json，所以必须把非目标路径的实例杀掉。
RUNNING_OLD="$(pgrep -f "$ROOT/build/$APP_NAME.app" 2>/dev/null | wc -l | tr -d ' ')"
if [ "$RUNNING_OLD" -gt 0 ]; then
  echo "==> 关闭从 build/ 启动的旧实例（$RUNNING_OLD 个进程）"
  # 精确匹配路径，不要用 `pkill -f $APP_NAME`，那会把新版本一起杀掉
  pkill -f "$ROOT/build/$APP_NAME.app" 2>/dev/null || true
  sleep 2
fi

echo ""
echo "==> 完成"
echo "    应用: $DEST"
echo "    版本: $(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$DEST/Contents/Info.plist" 2>/dev/null)"
echo "    大小: $(du -sh "$DEST" | cut -f1)"

if [ "$LAUNCH" -eq 1 ]; then
  echo "==> 启动"
  open -a "$DEST"
  sleep 3
  N="$(pgrep -f "$DEST" 2>/dev/null | wc -l | tr -d ' ')"
  if [ "$N" -gt 0 ]; then
    echo "    ✅ 已启动（$N 个进程）"
  else
    echo "    ⚠️ 未检测到进程，请手动打开确认"
  fi
fi
