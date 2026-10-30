# 熔炉之树 · 开发工具（永久保留）

四个脚本都只依赖 `tools/harness.js`，无需浏览器、无需网络，全部确定性（同 seed 同结果）。

## harness.js —— 无头引擎桩
把整个 TMT 引擎（Vue/break_eternity/技术层/我们的 mod 文件）装进一个 `vm` context，
用假 DOM、假定时器、虚拟时钟驱动 `gameLoop`，并把 console 与异常收进 `state.errors`。

```
node tools/harness.js              # 自检：加载顺序、modInfo、layers、钩子表、推进 30 秒、NaN 扫描
```

编程用法：

```js
const H = require("./tools/harness.js")
const api = H.boot({ seed: 11 })
api.newGame()
api.eval("updateTemp(); gameLoop(0.1)")
api.get("String(tmp.pointGen)")
api.nanScan()      // 递归查 player 里的 NaN
api.errors()       // 致命/运行期 + 钩子 + console.error
api.advance(秒, 步长ms)
```

⚠️ **`harness.js` 注册了 `process.on("uncaughtException")`**，它会吞掉调用方脚本的崩溃并
让进程静默 `exit 0`。任何外部脚本在 `boot()` 之后必须立刻：

```js
process.removeAllListeners("uncaughtException")
process.removeAllListeners("unhandledRejection")
```

⚠️ **每个场景请重新 `boot()`，不要对同一个 api 调两次 `newGame()`。**
`newGame()` 会重跑 `load()` → `setupTemp()` → `setupBuyables()`，而 `setupBuyables` 是
**原地包装** `b.cost`（`js/technical/temp.js`）。二次包装会让 `cost → actualCostFunction → cost`
无限递归爆栈。已在引擎里加 `__costWrapped` 幂等保护，但仍应以「一场景一 boot」为习惯。

## sim.js —— 自动玩 + 平衡报告

```
node tools/sim.js --minutes=60 --fast --out=out.txt
```

| 参数 | 说明 |
|---|---|
| `--minutes=N` | 模拟时长，默认 30 |
| `--fast` | 大步长（模拟 1 秒/帧）。`updateTemp` 是每帧大头，长跑必须带 |
| `--vent=cap\|half\|asap\|never` | 泄压策略，默认 `cap`（等炉压满才放）——**这是唯一占优的路径**，其余三种会明显变慢甚至整局 0 炉芯 |
| `--seed=N` | 随机种子，默认 1 |
| `--budget=N` | §8.5 软阈值（log10），默认 80；硬约束与它无关，见下 |
| `--large-tick[=H]` | 一次性把 `player.time` 前跳 H 小时（默认 4），测离线稳健性。**默认关闭**，只在显式指定时执行，且在 `--save` 之后，避免污染存档 |
| `--layers=h,m,r` | 只跑指定层 |
| `--save=file` / `--load=file` | 分段续跑（长于工具超时的模拟用它拆段） |
| `--out=file` | **用这个写文件**。PowerShell 的 `> x.txt` 会输出 UTF-16，`JSON.parse` 直接炸 |

输出三块：关键事件时间线、§8 节奏对照表（含偏快/偏慢百分比与建议常量）、§8.5 数值预算守卫。

### §8.5 守卫的口径（2026-10-29 修订）
旧规则「点燃时 heat 乘积 ≤ 1e40」**已作废** —— 它和 §5 的内容规格自相矛盾
（t24 ×100、t31 ×1e4、x12 ×1e8、h24 ×1000 这些静态奖励相乘就超 1e40）。现在：

* **硬约束（FAIL）**：任意通道 / 任意 `player` 资源全程**不得出现 Infinity 或 NaN**。
* **软约束（WARN）**：`foldMult(name, 1)` 超过 `--budget`（默认 1e80）才记 WARN。1e308 上限前留 17 个数量级余量。
* `per^limit ≤ 1e6` 的 buyable 预算检查保留不变。
* 判「失控 vs 正常成长」看**曲线形状**，不看绝对值。唯一的自乘回路是
  `热量 →(泄压/熔炼)→ 炉芯 →(hHeatMultFromCore 的 0.25 次方)→ 热量`，
  已由 `js/Forge/h.js` 的 `H_BAL.effHeatCap` 硬封顶。

## 各层回归自检（永久保留）

| 命令 | 覆盖 |
|---|---|
| `node tools/test-mid.js` | m/r 层：严格加载期（禁 format/player/tmp/hasUpgrade）、恶意钩子（NaN/0/Infinity）、§4 重置保留规则、§8.5 逐通道预算、互斥不变量、文本无 NaN/undefined。附 `--pacing=<分> --policy=cap --set="M_BAL.upgCost[21]=15"` 真实节奏模式。结尾打印 `[OK]` 明细 + `=== 全部通过 ===` |
| `node tools/test-top.js` | t/x 层：**5924 项断言**，钩子/公式/挑战/可点击项逐状态调用，另加 60 秒连续推进 |
| `node tools/test-side.js` | ach/stats 层：16 条铭刻可达性、heat 通道乘子、stats 读数台渲染；结尾打印 `NaN 扫描 / 非钩子错误总数`。附 `--long=N`、`--record=N --out=` 记录模式 |
| `node tools/test-endgame.js` | **通关可达性**（§8「2–5 小时」唯一的实证来源，sim 不进挑战也不点燃）：6 个挑战逐个进入并结算、星核满 1000、`clickClickable("x",11)` 点燃、16 条铭刻达成时刻、全程 Infinity/NaN 监测。退出码 0=通关。用法 `node tools/test-endgame.js [分钟=45] [步长秒=1]` |

实测（`node tools/test-endgame.js 45`，seed=1）：首芯 18s → m 2.2min → r 17.3min → t 29.8min → x 33.3min →
6/6 挑战（29.8~32.5min）→ 星核满 1000 于 37.3min → **点燃 37.3min**，16/16 铭刻全可达成，
Infinity 从未出现、NaN 干净、运行期错误 0，`isEndgame()` 为 true。

`test-top.js` 里有两条断言刻意**不用** `fillRich` 铺的富状态，而是另开最小场景：
`fillRich` 会把 x 铺成「累计 1200 星核 + 里程碑全开」，`advance` 期间 x 的 `autoPrestige`
会真的 `doReset('x')`，而 §4 规定熔星重置清空 t 的一切（含过载倒计时）——那是**契约行为**。
同理 `doReset('x')` 的引擎顺序是 `onPrestige → addPoints → updateMilestones → rowReset`，
只要 `x.total ≥ 5`，里程碑 0 会在清空 t **之前**被当场授予，于是凝时升级合法保留。
要测「无里程碑 0 → 应清空」这条分支，必须让 `x.total` 低于门槛并用 `doReset('x', true)`
（force 跳过 `updateMilestones`）。

## preview.js —— 本地预览 + 资源预检

```
node tools/preview.js --check           # 静态检查 index.html 引用的每个文件是否存在（不需要起服务器）
node tools/preview.js --port=8123       # 起 HTTP 服务
```
`--check` 已验证：本地 36 项 script/link 全部存在、缺失 0；另有 **2 个外链**需联网 ——
`unpkg.com/vue@2.7.16`（**承重**：Vue 取不到就白屏）与 `fonts.googleapis.com` 的 Inconsolata 字体（非承重，取不到只是字形回退）。

## 交稿前的最小验收串

```
node tools/harness.js
node tools/sim.js --minutes=45 --fast
node tools/test-mid.js && node tools/test-top.js && node tools/test-side.js
node tools/preview.js --check
```
