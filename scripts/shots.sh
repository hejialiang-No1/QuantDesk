#!/bin/bash
# shots.sh —— 逐页抓图，用于人工核对界面
#
# 为什么不用 screencapture：macOS 未授予「屏幕录制」权限时 screencapture 会直接失败，
# 而 Electron 的 webContents.capturePage() 走的是应用自身渲染管线，零系统权限。
set -e
cd "$(dirname "$0")/.." || exit 1

APP="${QD_APP:-./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron}"
DIR="${QD_SHOT_DIR:-$PWD/build/shots}"
LOG=/tmp/qd-shots.log
mkdir -p "$DIR"
export QD_SHOT_DIR="$DIR"

echo "==> 抓图到 $DIR"
env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS "$APP" . --shot > "$LOG" 2>&1 || true

echo "===== 抓图结果 ====="
grep -E "^SHOT" "$LOG" || echo "（无输出，检查 $LOG）"
echo "===== 文件 ====="
ls -la "$DIR"
