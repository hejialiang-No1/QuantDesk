#!/bin/bash
# 创建 GitHub Release 并上传 dmg
set -e
cd "$(dirname "$0")/.."
export HTTPS_PROXY=socks5h://127.0.0.1:7890
export HTTP_PROXY=socks5h://127.0.0.1:7890
TOKEN="$1"
OWNER="hejialiang-No1"
REPO="QuantDesk"
TAG="v1.0.1"
DMG="build/QuantDesk-1.0.1-arm64.dmg"

echo "[1/3] 创建 Release $TAG ..."
REL=$(curl -s -m 60 -X POST \
  -H "Authorization: token $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$OWNER/$REPO/releases" \
  -d "{
    \"tag_name\": \"$TAG\",
    \"name\": \"QuantDesk v1.0.1 —— 美股量化终端\",
    \"body\": \"## QuantDesk v1.0.1\\n\\nmacOS 桌面端美股量化终端，国内网络直连可用，无需 API Key。\\n\\n### 本次新增\\n\\n- **推荐买入 / 卖出区间**：买区由前支撑、均线、布林中轨、ATR 回调带取交集密度最高段；卖区分三档（40%/35%/25% 减仓）并给出止损位、盈亏比与建议仓位\\n- **全面诊股**：六维打分（趋势/动量/量能/位置估值/波动/流动性）+ 机会清单 + 风险清单（带等级）+ 8 项体检 + 结论文本，每条结论都带可核对的数值依据\\n- **个股期权策略**：Black-Scholes 定价 + 期权链（含 Δ/IV）+ ±1σ 期望波动区间 + 10 种策略的收益结构与适配度排序\\n- **K 线控制修复**：修掉缩放/平移时可见区间出现小数下标导致绘制崩溃的问题；右边缘锁定、双击复位、Shift+滚轮横向平移、滚轮以光标为锚点、工具条缩放/复位/回到最新\\n- **界面重做**：按 macOS 26/27 Liquid Glass 规范重构，玻璃材质、同心圆角、侧栏延伸到边缘、滚动边缘效果，深色/浅色/跟随系统三态\\n\\n### 其余模块\\n\\n- **自选行情**：实时报价、红涨绿跌、市盈率/市净率/换手率、自动刷新、内置股票池\\n- **个股分析**：K线 + MA/BOLL 主图，成交量/MACD/KDJ 副图\\n- **量化选股**：6 因子打分，支持导出 CSV\\n- **策略回测**：双均线/MACD/RSI/布林带/动量/海龟 + 买入持有基准，含手续费与滑点、防未来函数\\n- **预警监控**：价格上破/下破/涨跌幅超阈，命中触发系统通知\\n\\n### 数据源\\n\\n东方财富 → 腾讯 → 新浪 三源自动降级。估值字段已按市场做优先级解析（美股 f163/f164，A股 f9/f115），无数据统一显示 -- 而非 0.00。\\n\\n### 安装\\n\\n1. 下载下方 \\`QuantDesk-1.0.1-arm64.dmg\\`\\n2. 双击挂载，把 QuantDesk 拖入 Applications\\n3. 若被 Gatekeeper 拦截：\\n\\n\\`\\`\\`bash\\nsudo xattr -dr com.apple.quarantine /Applications/QuantDesk.app\\n\\`\\`\\`\\n\\n或在 Finder 中右键 → 打开\\n\\n### 已知限制\\n\\n- 仅 macOS arm64（Apple Silicon）\\n- 未做 Apple 开发者签名，首次打开需右键打开或 xattr 解锁\\n- 行情延迟约 15 分钟，用于研究而非实时交易\\n- 期权为 Black-Scholes 理论价，未考虑买卖价差与提前行权\\n\\n### 风险提示\\n\\n本工具用于量化研究与回测演练，所有信号、评分、区间、期权策略与回测结果**不构成投资建议**。\",
    \"draft\": false,
    \"prerelease\": false
  }")

REL_ID=$(echo "$REL" | /Users/hejialiang/.workbuddy/binaries/node/versions/22.22.2-2/bin/node -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const j=JSON.parse(s);if(j.id){console.log(j.id)}else{console.log('ERR:'+j.message)}})")
echo "    Release ID: $REL_ID"

if [[ "$REL_ID" == ERR:* ]]; then
  echo "    ❌ 创建失败"
  exit 1
fi

echo "[2/3] 上传 dmg ($(du -h "$DMG" | cut -f1)) ..."
curl -s -m 900 --retry 3 --retry-delay 5 \
  -X POST \
  -H "Authorization: token $TOKEN" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @"$DMG" \
  "https://uploads.github.com/repos/$OWNER/$REPO/releases/$REL_ID/assets?name=QuantDesk-1.0.1-arm64.dmg" \
  | /Users/hejialiang/.workbuddy/binaries/node/versions/22.22.2-2/bin/node -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(s);if(j.id){console.log('    ✅ 上传成功:',j.name,(j.size/1048576).toFixed(1)+'MB','| 下载:',j.browser_download_url)}else{console.log('    ❌',j.message)}}catch(e){console.log('    RAW:',s.slice(0,200))}})"

echo "[3/3] 完成: https://github.com/$OWNER/$REPO/releases/tag/$TAG"
