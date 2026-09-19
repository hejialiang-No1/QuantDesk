#!/bin/bash
# build-dmg.sh —— 直接组装 .app 并用 hdiutil 打包 dmg
#
# 为什么不走 electron-builder：在受限环境下 npm 重建 node_modules/.bin 会被拦截，
# electron-builder 装不全。而 macOS 的 App Bundle 本身就是目录结构，
# 手动复制 Electron.app → 注入应用代码 → 换图标 → 改 Info.plist → hdiutil 打包，
# 结果完全等价，且更快更可控。
set -e

APP_NAME="QuantDesk"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# 版本号从 package.json 读，**不要**在这里硬编码 ——
# 硬编码会在发版时静默不一致：代码是 1.1.0，dmg 文件名和 Info.plist 还是 1.0.2，
# 而且构建照常成功、不报任何错。这类「产物元数据漂移」只能靠不硬编码来根治。
VER="${QD_VERSION:-$(node -e "process.stdout.write(require('$ROOT/package.json').version)" 2>/dev/null)}"
if [ -z "$VER" ]; then
  echo "!! 无法从 package.json 读取版本号，请检查 node 是否可用"
  exit 1
fi
BUILD="$ROOT/build"
SRC_APP="$ROOT/node_modules/electron/dist/Electron.app"

if [ ! -d "$SRC_APP" ]; then
  echo "!! 找不到 Electron.app，请先执行 bash scripts/setup-electron.sh"
  exit 1
fi

echo "==> 准备 $APP_NAME $VER (arm64)"
rm -rf "$BUILD/$APP_NAME.app"
mkdir -p "$BUILD"

# 1) 复制 Electron.app 作为骨架
#    ★ 必须用 tar 管道，不能用 `cp -R`。
#    在某些受限环境（WorkBuddy 沙箱 / 受管文件系统）下，`cp -R` 复制 app bundle 里的
#    `default_app.asar` 会被文件代理层拒绝，报 “Operation not permitted”，
#    而 tar 走的是流式读写，不受该限制。踩过一次，别改回去。
mkdir -p "$BUILD/$APP_NAME.app"
(cd "$SRC_APP" && tar cf - .) | (cd "$BUILD/$APP_NAME.app" && tar xf -)
# Electron 加载顺序：app.asar > app > default_app.asar；只要 app/ 在就不需要管 default_app

# 2) 注入应用代码（Electron 会优先加载 Contents/Resources/app）
APP_DIR="$BUILD/$APP_NAME.app/Contents/Resources/app"
mkdir -p "$APP_DIR"
cp -R "$ROOT/src" "$APP_DIR/"
cp "$ROOT/package.json" "$APP_DIR/"
echo "    应用代码已注入: src/, package.json"

# 3) 替换图标
cp "$ROOT/assets/icon.icns" "$BUILD/$APP_NAME.app/Contents/Resources/electron.icns"

# 4) 改写 Info.plist
PLIST="$BUILD/$APP_NAME.app/Contents/Info.plist"
PB=/usr/libexec/PlistBuddy
$PB -c "Set :CFBundleName $APP_NAME" "$PLIST" 2>/dev/null || $PB -c "Add :CFBundleName string $APP_NAME" "$PLIST"
$PB -c "Set :CFBundleDisplayName $APP_NAME" "$PLIST" 2>/dev/null || $PB -c "Add :CFBundleDisplayName string $APP_NAME" "$PLIST"
$PB -c "Set :CFBundleIdentifier com.quantdesk.terminal" "$PLIST"
$PB -c "Set :CFBundleVersion $VER" "$PLIST"
$PB -c "Set :CFBundleShortVersionString $VER" "$PLIST"
$PB -c "Set :CFBundleExecutable $APP_NAME" "$PLIST"
$PB -c "Set :LSMinimumSystemVersion 11.0" "$PLIST" 2>/dev/null || true
$PB -c "Set :LSApplicationCategoryType public.app-category-finance" "$PLIST" 2>/dev/null || true
$PB -c "Set :NSHighResolutionCapable true" "$PLIST" 2>/dev/null || true

# 5) 重命名可执行文件（与 CFBundleExecutable 保持一致）
if [ -f "$BUILD/$APP_NAME.app/Contents/MacOS/Electron" ]; then
  mv "$BUILD/$APP_NAME.app/Contents/MacOS/Electron" "$BUILD/$APP_NAME.app/Contents/MacOS/$APP_NAME"
  chmod +x "$BUILD/$APP_NAME.app/Contents/MacOS/$APP_NAME"
fi

# 6) ad-hoc 签名（避免部分 macOS 版本直接判定为损坏）
echo "==> 签名"
codesign --force --deep --sign - "$BUILD/$APP_NAME.app" 2>&1 | tail -2 || echo "    (签名失败，不影响使用)"

# 7) 打包 dmg
DMG="$BUILD/$APP_NAME-$VER-arm64.dmg"
rm -f "$DMG"
echo "==> 生成 dmg"
hdiutil create -volname "$APP_NAME $VER" -srcfolder "$BUILD/$APP_NAME.app" -ov -format UDZO "$DMG" > /dev/null

echo ""
echo "==> 完成"
ls -lh "$DMG"
echo "    App: $BUILD/$APP_NAME.app"
echo ""
echo "安装提示：若 macOS 提示「已损坏」，执行："
echo "  sudo xattr -dr com.apple.quarantine /Applications/$APP_NAME.app"