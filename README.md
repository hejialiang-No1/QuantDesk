# QuantDesk —— 美股量化终端

一个本地运行的 macOS 桌面应用，专为中文用户设计，集成 **行情 / 技术分析 / 量化选股 / 策略回测 / 预警** 五大模块。

数据源走 **东方财富 → 腾讯 → 新浪** 三源自动降级，国内网络直连可用，无需科学上网、无需 API Key。

## 功能速览

| 模块 | 干啥 |
| --- | --- |
| 自选行情 | 实时报价、涨跌幅（红涨绿跌）、自动刷新、快捷股票池一键加自选 |
| 个股分析 | K线 + MA / BOLL 主图，成交量 / MACD / RSI / KDJ 副图，十字光标、滚轮缩放、拖拽平移 |
| 量化选股 | 多因子打分（动量 / 趋势 / 均值回归 / 量能 / 波动 / 位置），支持导出 CSV |
| 策略回测 | 双均线 / MACD / RSI / 布林带 / 动量 / 海龟，含手续费与滑点，输出权益曲线与绩效卡片 |
| 预警监控 | 价格上破 / 下破 / 涨幅超阈 / 跌幅超阈，命中触发系统通知 |

## 安装与启动

### 直接安装（推荐）

到本仓库的 **[Releases](../../releases)** 页面下载 `QuantDesk-1.0.0-arm64.dmg`，双击挂载，把 QuantDesk 拖入 Applications。

首次打开若被 Gatekeeper 拦截（"已损坏"或"无法验证开发者"）：

```bash
sudo xattr -dr com.apple.quarantine /Applications/QuantDesk.app
```

或者在 Finder 里右键 → 打开（绕过 gatekeeper）。

### 源码启动

```bash
git clone https://github.com/<USER>/QuantDesk.git
cd QuantDesk
npm install --registry=https://registry.npmmirror.com  # 国内镜像
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm start
```

> 若 npm 安装 electron 二进制失败（GitHub 被墙），改用脚本手动装配：
> `bash scripts/setup-electron.sh 44.2.0`

### 打 dmg

```bash
bash scripts/build-dmg.sh   # 输出 build/QuantDesk-1.0.0-arm64.dmg
```

## 内置指标与策略

**技术指标**：MA（5/10/20/60/120）、EMA、MACD、RSI（Wilder）、BOLL、KDJ、ATR、年化波动率。

**内置策略**：双均线交叉、MACD 金叉、RSI 超卖反弹、布林带回归、动量突破、海龟突破、买入持有（基准）。

回测防未来函数：第 i 根 K 线收盘后产生信号 → 第 i+1 根开盘价成交。

## 数据源

国内访问美股数据的现实：Yahoo / Alpha Vantage 直连基本不可用，**东方财富** push2 接口速度最快但对 IP 有 QPS 限流。

所以软件做三源自动降级：

```
[主]  东方财富 push2  →  [备1] 腾讯 qt.gtimg.cn  →  [备2] 新浪 hq.sinajs.cn
       ↓ 失败自动切换 ↑        ↓                       ↓
   K线 + 排行         行情 + K线（含复权）        行情 + 日K（聚合为周月）
```

任何一源挂掉或限流，下一源接上。失败计数会在 30 秒内降权，避免重复浪费时间在坏源上。

行情延迟约 **15 分钟**（东方财富对境外市场的口径），用于研究而非实时交易。

## 项目结构

```
QuantDesk/
├── package.json               # electron + electron-builder 配置
├── assets/icon.icns           # 应用图标（手搓生成）
├── src/
│   ├── main/
│   │   ├── main.js             # 主进程、窗口、IPC handlers
│   │   ├── preload.js          # contextBridge 安全桥
│   │   ├── datasource.js       # 多源数据层（限流/重试/缓存）
│   │   ├── store.js            # JSON 本地持久化
│   │   └── pool.js             # 内置 147 只股票池
│   ├── shared/
│   │   ├── indicators.js       # 技术指标（主进程与渲染层共用）
│   │   ├── factors.js          # 多因子评分
│   │   └── backtest.js         # 回测引擎
│   └── renderer/
│       ├── index.html          # UI 骨架（5 个主面板 + 顶栏 + 侧栏）
│       ├── css/app.css         # 深色终端主题
│       └── js/
│           ├── chart.js        # Canvas K线 / 权益曲线
│           └── app.js          # UI 主控
├── scripts/
│   ├── smoke.js                # 数据层 + 算法层无头测试（25 项）
│   ├── main-smoke.js           # 主进程无头测试
│   ├── ui-smoke.sh             # 界面自检
│   ├── make-icon.py            # 图标生成（PIL + iconutil）
│   ├── setup-electron.sh       # 手动装配 electron 二进制（绕墙）
│   └── build-dmg.sh            # 自建 .app + hdiutil 打 dmg
└── build/                      # 输出 dmg / app（已 gitignore）
```

> 打包没走 electron-builder：国内 npm 装它的依赖链会被反复拦截，改成直接组装 `.app` + `hdiutil`，5 分钟出 135 MB dmg，更可控。

## 自检脚本

```bash
node scripts/smoke.js                    # 数据层 + 算法层（25 项）
./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  scripts/main-smoke.js --disable-gpu --no-sandbox --headless   # 主进程无头
```

## 已知限制

- **只支持 macOS arm64**（Apple Silicon），Intel Mac 请修改 `package.json` 中 `mac.target.arch` 后重新打包。
- **未签名**：dmg 内的 app 未做 Apple 开发者签名，安装后首次打开需右键"打开"或 `xattr` 解锁。
- **K线数量**：日线最长 400 根（约 1.5 年），想看更久请多次运行。
- **指数行情**：纳斯达克 100 / 道指 / 标普 500 实时点位，仅供参考。

## 风险提示

本工具用于**量化研究与回测演练**，所有信号、评分、回测结果**不构成任何投资建议**。投资有风险，入市需谨慎。