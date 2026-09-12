# QuantDesk —— 美股量化终端

一个本地运行的 macOS 桌面应用，专为中文用户设计，集成 **行情 / 技术分析 / 诊股 / 买卖区间 / 期权策略 / 量化选股 / 策略回测 / 预警** 模块。

数据源走 **东方财富 → 腾讯 → 新浪** 三源自动降级，国内网络直连可用，无需科学上网、无需 API Key。

> 当前版本 **v1.0.1**

## 功能速览

| 模块 | 干啥 |
| --- | --- |
| 自选行情 | 实时报价、涨跌幅（红涨绿跌）、市盈率 / 市净率 / 换手率、自动刷新、快捷股票池一键加自选 |
| 个股分析 | K线 + MA / BOLL 主图，成交量 / MACD / 副图，十字光标、滚轮缩放、拖拽平移、双击复位 |
| 推荐买卖区间 | 买入区间（前支撑 ∪ 均线 ∪ 布林中轨 ∪ ATR 回调带取交集）+ 三档分批止盈目标 + 止损位 + 盈亏比与建议仓位 |
| 全面诊股 | 六维打分（趋势 / 动量 / 量能 / 位置估值 / 波动 / 流动性）+ 机会清单 + 风险清单（带等级）+ 8 项体检 + 结论文本 |
| 个股期权策略 | Black-Scholes 理论定价 + 期权链（含 Δ/IV）+ ±1σ 期望波动区间 + 10 种策略的收益结构与适配度排序 |
| 量化选股 | 多因子打分（动量 / 趋势 / 均值回归 / 量能 / 波动 / 位置），支持导出 CSV |
| 策略回测 | 双均线 / MACD / RSI / 布林带 / 动量 / 海龟，含手续费与滑点，输出权益曲线与绩效卡片 |
| 预警监控 | 价格上破 / 下破 / 涨幅超阈 / 跌幅超阈，命中触发系统通知 |

## 界面风格

按 Apple 人机界面指南的 **macOS 26/27（Liquid Glass）** 语言重做：

- 玻璃材质：`backdrop-filter: blur() saturate()`，面板带镜面高光与更亮的边缘描边
- 统一窗口圆角 + **同心圆角**（子元素圆角 = 父级圆角 − 内边距）
- 侧栏延伸到窗口边缘，图标着色随主题走
- 滚动到顶部时才出现分隔线（scroll edge effect）
- 大尺寸控件用胶囊形，小尺寸控件保持圆角矩形
- 深色 / 浅色 / 跟随系统三态，图表配色跟随主题切换

## 安装与启动

### 直接安装（推荐）

到本仓库的 **[Releases](../../releases)** 页面下载 `QuantDesk-1.0.1-arm64.dmg`，双击挂载，把 QuantDesk 拖入 Applications。

首次打开若被 Gatekeeper 拦截（"已损坏"或"无法验证开发者"）：

```bash
sudo xattr -dr com.apple.quarantine /Applications/QuantDesk.app
```

或者在 Finder 里右键 → 打开（绕过 gatekeeper）。

### 源码启动

```bash
git clone https://github.com/hejialiang-No1/QuantDesk.git
cd QuantDesk
npm install --registry=https://registry.npmmirror.com  # 国内镜像
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm start
```

> 若 npm 安装 electron 二进制失败（GitHub 被墙），改用脚本手动装配：
> `bash scripts/setup-electron.sh 44.2.0`

### 打 dmg

```bash
bash scripts/build-dmg.sh   # 输出 build/QuantDesk-1.0.1-arm64.dmg
```

## 内置指标与算法

**技术指标**：MA（5/10/20/60/120）、EMA、MACD、RSI（Wilder）、BOLL、KDJ、ATR、年化波动率。

**支撑压力位**：摆动高低点聚类 + 经典枢轴点（Pivot Points）+ 斐波那契回撤，输出强度排序。

**推荐买卖区间**：候选支撑按权重聚类取密度最高的一段作为买区；卖区按压力位 + ATR 目标位 + 斐波那契扩展分三档（40% / 35% / 25% 减仓）；止损落在买区下沿再退一个 ATR，且必须位于第二支撑下方。

**全面诊股**：六个维度独立打分后加权汇总，产出机会与风险清单。每条结论都带可核对的数值依据（例如「price 218.29 > MA200 197.1」），不做无根据的定性描述。

**期权定价**：Black-Scholes 欧式定价 + 正态 CDF/PDF；由 60 根历史波动率推隐含波动率，按标的波动率环境生成行权价阶梯（吸附整数关口）；策略覆盖铁鹰 / 备兑看涨 / 保护性看跌 / 牛市价差 / 熊市价差 / 买入跨式 / 买入宽跨式等，逐个给出最大盈利、最大亏损、盈亏平衡点、胜率估算与适配度。

**周期口径**：年化波动率、ATR 换算、52 周窗口都按当前 K 线周期取每年根数（日线 252 / 周线 52 / 月线 12）。这一层做错会让波动率成倍失真——月线按 252 根年化会把 IV 从 10% 放大到 250%。

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

> 估值字段（市盈率 / 市净率）在不同市场挂在不同字段上，已做优先级解析：美股走 `f163`(TTM) / `f164`(动态)，A 股走 `f9` / `f115`。数据源用 `0` 表示「无此数据」，会统一显示为 `--` 而不是误导性的 `0.00`。

## 项目结构

```
QuantDesk/
├── package.json               # electron + electron-builder 配置
├── assets/icon.icns           # 应用图标（手搓生成）
├── src/
│   ├── main/
│   │   ├── main.js             # 主进程、窗口、IPC handlers、--smoke / --shot 自检
│   │   ├── preload.js          # contextBridge 安全桥
│   │   ├── datasource.js       # 多源数据层（限流/重试/缓存）
│   │   ├── store.js            # JSON 本地持久化
│   │   └── pool.js             # 内置股票池
│   ├── shared/
│   │   ├── indicators.js       # 技术指标（主进程与渲染层共用）
│   │   ├── factors.js          # 多因子评分 + metrics 契约
│   │   ├── levels.js           # 支撑压力位 / 枢轴点 / 斐波那契
│   │   ├── tradeplan.js        # 推荐买入区间 / 卖出区间 / 止损 / 仓位
│   │   ├── diagnose.js         # 全面诊股（六维 + 机会风险清单）
│   │   ├── options.js          # Black-Scholes 定价 + 期权策略生成
│   │   └── backtest.js         # 回测引擎
│   └── renderer/
│       ├── index.html          # UI 骨架（6 个主面板 + 顶栏 + 侧栏）
│       ├── css/app.css         # Liquid Glass 主题（深/浅/自动）
│       └── js/
│           ├── chart.js        # Canvas K线 / 权益曲线
│           └── app.js          # UI 主控
├── scripts/
│   ├── smoke.js                # 数据层 + 算法层无头测试（74 项）
│   ├── main-smoke.js           # 主进程无头测试
│   ├── ui-smoke.sh             # 界面自检（含 K 线控制实测）
│   ├── shots.sh                # 逐页截图（Electron capturePage，零系统权限）
│   ├── make-icon.py            # 图标生成（PIL + iconutil）
│   ├── setup-electron.sh       # 手动装配 electron 二进制（绕墙）
│   └── build-dmg.sh            # 自建 .app + hdiutil 打 dmg
└── build/                      # 输出 dmg / app / shots（已 gitignore）
```

> 打包没走 electron-builder：国内 npm 装它的依赖链会被反复拦截，改成直接组装 `.app` + `hdiutil`，几分钟出包，更可控。

## 自检脚本

```bash
npm run smoke      # 数据层 + 算法层（74 项断言）
npm run ui-smoke   # 界面自检：面板填充 + K 线控制实测 + 像素探针
npm run shots      # 逐页截图到 build/shots/
```

界面自检有一个刻意的设计：它会**用真实 DOM 事件**（`WheelEvent` / `MouseEvent`）走一遍滚轮缩放、拖拽平移、双击复位，而不是直接调方法——用户碰到的就是这条路径，直接调方法会掩盖事件绑定层的问题。

## 已知限制

- **只支持 macOS arm64**（Apple Silicon），Intel Mac 请修改 `package.json` 中 `mac.target.arch` 后重新打包。
- **未签名**：dmg 内的 app 未做 Apple 开发者签名，安装后首次打开需右键"打开"或 `xattr` 解锁。
- **K线数量**：日线最长 400 根（约 1.5 年），想看更久请多次运行。
- **指数行情**：纳斯达克 100 / 道指 / 标普 500 实时点位，仅供参考。
- **期权为理论价**：未考虑买卖价差、利息与提前行权，实际成交价请以券商报价为准。
- **估值口径随数据源变化**：三源降级意味着市盈率可能是 TTM 也可能是动态，仅作相对参考。

## 风险提示

本工具用于**量化研究与回测演练**，所有信号、评分、区间、期权策略与回测结果**不构成任何投资建议**。投资有风险，入市需谨慎。
