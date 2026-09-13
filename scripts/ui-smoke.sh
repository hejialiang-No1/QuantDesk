#!/bin/bash
# ui-smoke.sh —— 渲染层自检：启动 Electron 跑完整渲染流程，输出探针结果并判定
#
# 两个环境坑（都踩过，写在这里免得再踩）：
# 1) ELECTRON_RUN_AS_NODE：本机环境默认置 1，Electron 会退化成纯 Node 执行 main.js，
#    报 `Cannot read properties of undefined (reading 'whenReady')`。必须 env -u 掉。
# 2) NODE_OPTIONS：外部注入的调试参数会污染 Electron 启动，一并清掉。
cd "$(dirname "$0")/.." || exit 1

NODE_BIN="$(command -v node || true)"
[ -z "$NODE_BIN" ] && NODE_BIN="$(ls -d "$HOME"/.workbuddy/binaries/node/versions/*/bin/node 2>/dev/null | tail -1)"

APP="${QD_APP:-./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron}"
LOG=/tmp/qd-smoke.log
rm -f "$LOG"

if [ ! -x "$APP" ]; then
  echo "!! 找不到 Electron 可执行文件：$APP"
  echo "   先跑：bash scripts/setup-electron.sh"
  exit 1
fi

env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS "$APP" . --smoke > "$LOG" 2>&1 &
PID=$!
for i in $(seq 1 60); do
  if grep -q "SMOKE_V102\|SMOKE_ERROR" "$LOG" 2>/dev/null; then break; fi
  sleep 1
done
sleep 1
kill $PID 2>/dev/null
pkill -f "Electron . --smoke" 2>/dev/null

echo "===== 渲染层自检结果 ====="
"$NODE_BIN" -e '
const fs = require("fs");
const log = fs.readFileSync(process.argv[1], "utf8");
let fail = 0, pass = 0;
const line = (log.split("\n").find((l) => l.startsWith("SMOKE_RESULT")) || "").replace("SMOKE_RESULT ", "");
if (line) {
  try {
    const r = JSON.parse(line);
    console.log("-- 页面结构 --");
    console.log("  错误数组 window.__errors : " + JSON.stringify(r.errors));
    console.log("  算法模块已挂载          : " + r.modules + " 个");
    console.log("  自选股行数 / 指数条     : " + r.watchRows + " / " + r.indexes);
    console.log("  K 线画布像素 / 可见     : " + r.klinePx + " / " + r.klineVisible + " (" + r.klineClient + ")");
    console.log("  当前视图 / 导航项       : " + r.activeView + " / " + r.activeNav + "（共 " + r.navItems + " 个导航，" + r.views + " 个视图）");
    console.log("  主题 / 背景模糊         : " + r.themeAttr + " / " + (r.backdrop || "无"));
    console.log("  诊股维度 / 风险项       : " + r.diagDims + " / " + r.diagRisks);
    console.log("  期权链路行 / 策略卡     : " + r.optChainRows + " / " + r.optStrategies);
    if (r.errors && r.errors.length) { fail++; console.log("  ❌ 渲染层有未捕获错误"); }
    else { pass++; console.log("  ✅ 渲染层无未捕获错误"); }
  } catch (e) { fail++; console.log("  解析 SMOKE_RESULT 失败：" + e.message); }
} else { fail++; console.log("  ❌ 没有拿到 SMOKE_RESULT"); }

for (const tag of ["SMOKE_CTRL", "SMOKE_V102"]) {
  const l = (log.split("\n").find((x) => x.startsWith(tag)) || "").replace(tag + " ", "");
  if (!l) { fail++; console.log("❌ 缺少 " + tag + " 输出"); continue; }
  let o;
  try { o = JSON.parse(l); } catch (e) { fail++; console.log("❌ " + tag + " 解析失败：" + e.message); continue; }
  console.log("\n-- " + (tag === "SMOKE_CTRL" ? "K 线交互" : "v1.0.2 四个新视图") + " --");
  for (const [name, ok] of o.cases) {
    if (ok) { pass++; console.log("  ✅ " + name); }
    else { fail++; console.log("  ❌ " + name); }
  }
  if (process.env.QD_VERBOSE && (o.state || o.els || o.round)) {
    console.log("  [state] " + JSON.stringify(o.state));
    console.log("  [els]   " + JSON.stringify(o.els));
    console.log("  [round] " + JSON.stringify(o.round));
  }
}

const errLine = log.split("\n").find((l) => l.startsWith("SMOKE_ERROR"));
if (errLine) { fail++; console.log("\n❌ 自检中断：" + errLine); }
console.log("\n===== 通过 " + pass + " 项，失败 " + fail + " 项 =====");
process.exit(fail ? 1 : 0);
' "$LOG"
STATUS=$?

echo "===== 渲染层日志 ====="
grep -E "\[renderer" "$LOG" | head -20 || true
echo "===== 完成 ====="
exit $STATUS
