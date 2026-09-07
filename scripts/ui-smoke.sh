#!/bin/bash
# 界面自检：启动 Electron，等待主流程跑完，输出体检结果
cd "$(dirname "$0")/.." || exit 1
export PATH="/Users/hejialiang/.workbuddy/binaries/node/versions/22.22.2-2/bin:$PATH"
LOG=/tmp/qd-smoke.log
rm -f "$LOG"
./node_modules/.bin/electron . --smoke > "$LOG" 2>&1 &
PID=$!
for i in $(seq 1 40); do
  if grep -q "SMOKE_" "$LOG" 2>/dev/null; then break; fi
  sleep 1
done
sleep 1
kill $PID 2>/dev/null
pkill -f "electron . --smoke" 2>/dev/null
echo "===== 自检结果 ====="
grep -E "SMOKE_" "$LOG"
echo "===== 渲染层日志 ====="
grep -E "\[renderer" "$LOG" | head -20
echo "===== 错误 ====="
grep -iE "error|failed|cannot|undefined is not" "$LOG" | grep -v "SMOKE_" | head -15
echo "===== 完成 ====="
