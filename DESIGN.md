# 《熔炉之树 · The Forge Tree》 —— 设计案与实现契约

> 本文件是**实现契约**：所有数值、命名、跨层接口以本文为准。
> 若你在实现中发现某个数值明显失衡，请把它写进文件顶部的 `X_BAL` 常量表（不要散落在公式里），并在结论中报告建议值。

## 0. 设计哲学（遵循 TMT / Prestige Tree 的传统）

1. **一条主线，层层向上**：每个 row（层行）是一种新的“重置”，用低层资源换高层资源；高层货币永久强化低层，形成“重置越来越快”的正反馈。
2. **公式全部可读**：所有产出都是 `底数资源^指数 × 乘数` 的形式，玩家永远能回答“我为什么变快了 / 我下一步该做什么”。
3. **里程碑=自动化**：QoL 与自动化一律由 milestones 解锁（并给 ON/OFF 开关），让前期靠操作、后期靠规划、挂机不无聊。
4. **有节奏的主动操作**：row0 的「炉压 / 泄压」机制给玩家一个**永远值得按的按钮**（正向收益，不惩罚挂机），并随自动化解锁而逐步交给系统。
5. **真实抉择**：互斥升级（二选一路线）与时间挑战（debuff 换永久奖励）提供 build 差异。
6. **终点是目标而不是数字墙**：结局是一个可见的终极工程「点燃恒星」，需要 星核 + 挑战进度，达成后仍可继续游玩（keep going 有额外强化）。
7. **绝不出现死路**：任何一层必须可解锁、任何升级必须最终可负担（用 `tools/sim.js` 自动验证）。

## 1. 主题与货币

你在冷寂的虚空中经营一座**恒星熔炉**。

| 内部 id | 显示名 | 符号 | 颜色 | row | 货币（resource） | baseResource | 类型 |
|---|---|---|---|---|---|---|---|
| （points） | 热量 | – | – | – | 热量 Heat | 自动产能 | – |
| `h` | 熔炉 Hearth | H | `#ff7a18` | 0 | 炉芯 Cores | 热量 | normal, exp 0.5 |
| `m` | 锻造 Mill | M | `#4bdc13` | 1 | 锭条 Ingots | 炉芯 | normal, exp 0.5 |
| `r` | 反应 Reactor | R | `#4169e1` | 2 | 触媒 Catalysts | 锭条 | **static** |
| `t` | 凝时 Tempo | T | `#9b59d6` | 3 | 时序 Chronons | 触媒 | normal, exp 0.35 |
| `x` | 熔星 Starforge | X | `#ffd700` | 4 | 星核 Stellar Cores | 时序 | normal, exp 0.3 |
| `ach` | 铭刻 Inscriptions | ★ | `#ffe14d` | side | （成就，无货币） | – | none |
| `stats` | 统计 Statistics | i | `#8fbcbb` | side | – | – | none |

所有面向玩家的文本**使用简体中文**（引擎文本由 i18n 任务统一本地化）。

## 2. 文件与职责（写作用域，请勿越界）

```
js/mod.js              全局：modInfo / getPointGen / getStartPoints / displayThings / isEndgame   [lead]
js/tree.js             树布局、ghost 节点、tree-tab                                              [lead]
js/Forge/helpers.js    跨层接口：HOOKS 注册表、fold、重置规则、格式化、提示                        [lead]
js/Forge/h.js          row0 熔炉（含炉压/泄压核心机制）                                           [lead]
js/Forge/m.js          row1 锻造                                                                 [layers-mid]
js/Forge/r.js          row2 反应                                                                 [layers-mid]
js/Forge/t.js          row3 凝时（含全部挑战 + 过载 clickable）                                   [layers-top]
js/Forge/x.js          row4 熔星（含「点燃恒星」结局 clickable）                                   [layers-top]
js/Forge/ach.js        侧层：成就                                                                [side-layers]
js/Forge/stats.js      侧层：统计                                                                [side-layers]
tools/harness.js       Node 端 DOM/引擎桩，加载真实引擎与 mod 文件                                 [harness]
tools/sim.js           自动玩（greedy bot）+ 曲线/可达性/NaN 报告                                  [harness]
tools/preview.js       本地 http 预览服务器（供真人/无头浏览器打开 index.html）                     [harness]
引擎字符串本地化        js/components.js, js/technical/systemComponents.js, js/technical/displays.js,
                       js/utils.js, js/game.js, index.html 中的**面向玩家的英文字面量**            [i18n]
```

**只改自己负责的文件。** 需要别的层提供数据时，一律通过本文档声明的接口（HOOKS / `player.<layer>` / `hasUpgrade` 等），不要去改别人的文件。

## 3. 跨层接口（helpers.js 提供，lead 实现）

```js
// 3.1 钩子注册表：所有跨层加成都用钩子折叠，避免互相覆盖
registerHook(name, fn, priority)   // fn 返回 Decimal|number；异常被吞并（console.error 一次）
foldMult(name, start = 1)          // 返回 Decimal：start × ∏ fn()
foldAdd(name, start = 0)           // 返回 Decimal：start + Σ fn()
hookCount(name)                    // 已注册的钩子数（调试用）

// 3.2 已约定的钩子名（务必使用这些字符串，不要自创）
"heatFlat"      加法，给 热量/秒 一个平坦增量（默认 0）
"heat"          乘法，热量/秒
"coreGain"      乘法，row0 炉芯产出 gainMult
"coreExpBonus"  加法，炉芯公式指数加成（基础 0.5）
"ingotGain"     乘法，锭条产出 gainMult
"ingotExpBonus" 加法，锭条公式指数加成（基础 0.5）
"catalystCost"  乘法，反应层（static）的 gainMult —— 注意 static 层里它**乘在成本上**，<1 才是变强
"chrononGain"   乘法，时序产出 gainMult
"stellarGain"   乘法，星核产出 gainMult
"startPoints"   乘法，getStartPoints()（被高层重置后的初始热量）
"ventValue"     乘法，泄压获得的额外热量倍数
"pressureRate"  加法，炉压增速加成（基础 3/s）
"pressureExp"   加法，炉压指数加成（基础 0.35）
"buyableCost"   乘法，所有层 buyable 成本折扣（<1 变强）
"upgradeCost"   乘法，所有层 upgrade 成本折扣
"globalAdd"     预留：无

// 3.3 工具
D(x)                 => new Decimal(x)
hasAch(id)           => hasAchievement("ach", id)
achievementCount()   => player.ach.achievements.length
forgeDoReset(layer, resettingLayer, keep)
   // 统一重置规则：仅当 layers[resettingLayer].row > layers[layer].row 时执行 layerDataReset
   // 并且**永远保留** unlocked / total / best / milestones / counters（见 §4）
   // keep 里额外列出的键也会被保留
isChallengeActive(layer, id)     => inChallenge(layer, id)
fmtTarget(text, cur, req)        => 生成 "目标：x / y" 这样的一行 HTML
decimalKeep(layer, keys)         // 内部使用

// 3.4 每条层必须遵守的“计数器”约定（供 stats 层与成就读取；命名固定）
player.<l>.resets    Decimal  本层主动重置（prestige）次数
player.<l>.spends    Decimal  本层货币消费次数（可选）
player.h.vents       Decimal  泄压次数（h 层专用）
```

## 4. 重置规则（务必精确实现）

`doReset(layer)` 时（TMT 原生行为）：`player.points` 归零（row0）或 = `getStartPoints()`（row>0），并对 row..0 调用每层的 `doReset(resettingLayer)`。

**统一约定**：任何被重置的层，都保留 `unlocked / total / best / milestones / resets / vents`（由 `forgeDoReset` 负责）；其余（points、upgrades、buyables、clickables 状态、spentOnBuyables、专属变量）默认清空。特殊保留如下：

| 触发者 | 影响 | 保留规则 |
|---|---|---|
| `h` 自己（熔炼） | 热量归 0，炉压释放 | 炉气压：默认清零；`h` 升级 32（再生炉体）改为减半。保留全部升级/燃料棒/里程碑 |
| `m`（锻造） | 重置 h | h 保留：`points` 的 50%（m 里程碑 2「废钢回炉」），`upgrades`（m 升级 22 或 t 升级 11），`buyables`+`spentOnBuyables`（h 里程碑 2 或 t 升级 11） |
| `r`（反应） | 重置 h, m | m 保留 `upgrades`/`buyables` 由 r 升级 21（保留 m 升级）与 t 升级 12/22 决定；h 同上 |
| `t`（凝时） | 重置 h, m, r | t 自身**不受自己重置影响**（`layers[t].row > this.row` 为 false），进入 t 挑战也即如此 |
| `x`（熔星） | 重置 h, m, r, t | t 的 `upgrades` 由 x 里程碑 0 / 升级 11 决定保留；其余全清 |
| 进入 `t` 的挑战 | `doReset('t', true)` → 清空 row0-2，t 自身保留 | 挑战目标只能读取**会被清空**的资源（`player.points`/`h.points`/`m.points`/`r.points`） |

任何层的 `doReset` 写法模板：

```js
doReset(resettingLayer) {
    if (resettingLayer === this.layer) { /* 自身重置的特殊处理 */ }
    forgeDoReset(this.layer, resettingLayer, /* 额外 keep */ costKeepList())
}
```

## 5. 各层内容规格

### 5.0 通用要求（每层都要有）

- `startData()`：`unlocked / points / best / total / resets` + 本层专属字段（**全部 Decimal**，除布尔开关）。
- `hotkeys`：一个重置键（h/m/r/t/x），中文描述 `"H: 熔炼炉芯"` 形式；自动化相关键另加（如 `ctrl+h`）。
- `layerShown()`：`player.<l-1>.unlocked` 或自身已解锁（首层 true）。
- `tooltipLocked()`：明确告诉玩家解锁条件与当前进度，例：`"需要 50 炉芯（当前 12）"`。
- `tooltip()`：解锁后展示货币与关键加成。
- `resetDescription`：中文，如 `"熔炼，获得 "`。
- `tabFormat`：至少 `"主界面"`（main-display / prestige-button / resource-display / milestones / upgrades / buyables 顺序合理）+ 一个 `"详情"` 子标签放 infobox、bar、challenges。**每个组件都要能让玩家看到“现在多少 / 下一步要多少”**。
- `infoboxes`：1~2 条世界观文案（简短，中文），标题「炉边记事」。
- `bars`：进度条用 `format`/`formatWhole`，并给出 `unlocked()` 条件。
- `effect()` + `effectDescription()`：把本层货币给下游的加成写清楚（含当前数值）。
- 若本层有升级/购买项对**别的层**生效，一律通过 §3 的钩子注册，且**必须**在该升级的 `description` 里写清影响哪个层。
- `unlocked()`/`canAfford()` 等纯读函数**不得有副作用**；只有 `update / automate / onPrestige / doReset / buy / onClick / onPurchase / onComplete / onEnter / onExit` 可以改状态（TMT 每 tick 会调用其他函数）。
- 所有可调数值放文件顶部 `var X_BAL = {...}`（X 为层 id 大写）。

### 5.1 `h` 熔炉（row 0，lead 实现，供参考）

机制：**炉压（Pressure）**
- `player.h.pressure`（Decimal）：每 tick `+diff × foldAdd("pressureRate", 3)`。
- 热量倍率贡献：`foldAdd("pressureExp", 0.35)` 指数 → `registerHook("heat", () => D(player.h.pressure.add(1).pow(pressureExp())))`。
- 「泄压 Vent」clickable（id 11）：立即获得热量 `= tmp.pointGen × H_BAL.ventSeconds(15) × foldMult("ventValue",1)`，压力清零（升级 32：减半），`player.h.vents++`，冷却 2s（`player.h.ventCd`）。
- 自动化：milestone 0 给 `autoVent` 开关（能熔炼时自动泄压）。
- 显示：bar「炉压表」用 log 进度；主界面文本显示 `+X% 热量`。

升级（成本=炉芯）：见 §5.1 表（lead 实现，此处省略细节，参考 `js/Forge/h.js`）。

### 5.2 `m` 锻造（row 1，**layers-mid**）

- `requires: 50`（炉芯），`exponent: 0.5`，`type:"normal"`。
- 先天 `effect()`：锭条 `i` 给
  - 热量 × `(1+i)^0.4` → `registerHook("heat", ...)`
  - 炉芯产出 × `(1+i)^0.25` → `registerHook("coreGain", ...)`
- 升级（成本=锭条），id 行/列 = 11..14 / 21..24 / 31..32：

| id | 名称 | 效果 | 成本 |
|---|---|---|---|
| 11 | 锻锤 | 炉芯产出 ×3（`coreGain`） | 1 |
| 12 | 淬火槽 | 泄压收益 ×3（`ventValue`） | 2 |
| 13 | 配重锤 | 炉压增速 ×1.5（乘在 `pressureRate` 折叠结果上：注册钩子返回 `(1+0.5)`） | 4 |
| 14 | 合金模 | 热量 ×10（`heat`） | 8 |
| 21 | 连续轧制 | 炉芯产出 ×5 | 20 |
| 22 | 废钢回炉·改 | **锻造重置时保留熔炉升级** | 40 |
| 23 | 辊压机 | 锭条公式指数 +0.05（`ingotExpBonus`） | 60 |
| 24 | 匠魂 | 热量 ×100 | 120 |
| 31 | 水力锻机（与 32 互斥） | 熔炉 `passiveGeneration +0.5`（实现：h 层读取 `hasUpgrade('m',31)`，或注册钩子 `"hPassive"` 由 h 自己 fold；**用 `registerHook("hPassiveAdd", fn)`**，h.js 已用 `foldAdd("hPassiveAdd", 0)` 提供，见 §5.1） | 300 |
| 32 | 行会盟约（与 31 互斥） | 热量按泄压次数增长：× `(1+vents/40)^0.5`（`heat` 钩子） | 300 |

  互斥实现：`unlocked(){ return !hasUpgrade('m', other) }`，并在 description 里写明「与「X」互斥，二选一」。
- `buyables`（成本=**锭条**）：
  - 11 轧辊：每根 锭条产出 ×1.5（本层 gainMult），`cost(x)=2×2.2^x×foldMult("buyableCost",1)`，`purchaseLimit 40`
  - 12 废料箱：每根 热量 ×2（`heat` 钩子，`2^x`），`cost(x)=3×2.5^x×foldMult("buyableCost",1)`，`purchaseLimit 30`
  - 必须实现 `buy / buyMax / sellOne / sellAll / display / canAfford / effect`，`buy()` 支持 `shiftDown`（按住 Shift 一次买 10 根）。
  - `respec()`：全额返还 `spentOnBuyables` 并清空本层 buyables（参考 TMT 文档 c.js 的写法）。
- `milestones`（用 `player.m.total`）：
  - 0：`总锭条 10` → 解锁「自动锻造」（`passiveGeneration` 开关 `player.m.autoForge`，toggles: `[["m","autoForge"]]`）
  - 1：`100` → 「自动购买锻造升级」（`player.m.autoBuy`）
  - 2：`500` → 「锻造时保留 50% 炉芯」（实现见 §4，写 `player.h.reserve = 0.5` 由 m 层在 `onPrestige` 里设置；h.js 读取该字段）
  - 3：`2000` → 「自动加注轧辊/废料箱」（`player.m.autoFill`）
- 注意：`m` 自身重置时不清空 `h` 的 `reserve`；`player.m.reserve` 不存在——只用 `player.h.reserve`（h 的 startData 已含 `reserve: 0.5` 默认 **0**，即不保留）。**（lead 会保证 `player.h.reserve` 存在且默认 0）**

### 5.3 `r` 反应（row 2，**layers-mid**）

- `type:"static"`，`base: 3`，`exponent: 1`，`requires: 10`（锭条），`roundUpCost: true`。
- `gainMult(){ return foldMult("catalystCost", 1) }`（static 语义：这是成本倍数 → 玩家变强要让它 <1）
- `gainExp(){ return D(1).add(foldAdd("catalystExpBonus", 0)) }`（若需要；无钩子则 `new Decimal(1)`）
- `canBuyMax(){ return hasMilestone('r',1) }`，`directMult(){ return foldMult("catalystDirect", 1).times(1 + 0*...) }`
- 先天 `effect()`：触媒 `c`（当前持有）给
  - 锭条产出 × `(1+c)^0.6`（`ingotGain`）
  - 热量 × `(1+c)^0.8`（`heat`）
- 升级（成本=触媒）：

| id | 名称 | 效果 | 成本 |
|---|---|---|---|
| 11 | 催化配方 | 锭条产出 ×3 | 2 |
| 12 | 高压釜 | 触媒的热量指数 +0.2（本层 effect 内读取） | 3 |
| 13 | 循环泵 | `catalystCost` ×0.85（成本 −15%） | 5 |
| 14 | 惰性保护 | `catalystDirect` ×1.5（产出 +50%） | 8 |
| 21 | 反应再生 | **反应重置时保留锻造升级与本层以下 buyables** | 12 |
| 22 | 铂网 | 锭条产出 ×10 | 20 |
| 23 | 平衡移转（与 24 互斥） | 本层 buyables 效果 +50% | 30 |
| 24 | 深冷分离（与 23 互斥） | `catalystCost` ×0.7 | 30 |

- `buyables`（成本=**锭条**，注意不是触媒）：
  - 11 催化塔：每根 热量 ×3，`cost=20×2^x`，limit 25
  - 12 冷凝器：每根 炉芯产出 ×1.6，`cost=50×2.4^x`，limit 20
  - 13 催化床：每根 炉压增速 ×1.4，`cost=100×3^x`，limit 10
  - 同样要求 `buyMax`、`shift` 批量、`respec`。
- `milestones`（用 `player.r.points` / `best`）：
  - 0：`5 触媒` → 自动购买反应升级
  - 1：`10` → 解锁 Buy Max 按钮（`canBuyMax`）
  - 2：`20` → 每 tick 自动把 buyables 拉满（`player.r.autoFill` 开关）
  - 3：`30` → 自动反应（`autoPrestige()` 开关 `player.r.autoRun`）
- `bars`：`"转化率"` 显示 `baseAmount / nextAtDisp` 进度（水平）。

### 5.4 `t` 凝时（row 3，**layers-top**）

- `type:"normal"`，`exponent: 0.35`，`requires: 10`（触媒）。
- 先天 `effect()`：时序 `ch` 给
  - 热量 × `(1+ch)^0.6`（`heat`）
  - 炉芯/锭条/时序产出 × `(1+ch)^0.3`（`coreGain`/`ingotGain`/`chrononGain`）
  - 初始热量 × `(1+ch)`（`startPoints`）
  - 指数加成：`coreExpBonus`/`ingotExpBonus` 各 +`0.01×ch`（封顶 +0.15）
- 升级（成本=时序）：

| id | 名称 | 效果 | 成本 |
|---|---|---|---|
| 11 | 记忆合金 | 熔炉升级与燃料棒跨层保留（§4） | 1 |
| 12 | 时序模具 | 锻造升级跨层保留 | 2 |
| 13 | 加速衰变 | 热量 ×10 | 3 |
| 14 | Chronon 透镜 | 时序先天效果指数 +0.1 | 5 |
| 21 | 相位鼓风 | 炉芯公式指数 +0.05 | 10 |
| 22 | 循环锭模 | 反应重置时保留锻造 buyables | 15 |
| 23 | 脉冲回收 | 泄压收益 ×10 | 25 |
| 24 | 沧海一粟 | 热量 ×100 | 40 |
| 31 | 时之流（与 32 互斥） | 炉压增速 ×3，且热量 ×1e4 | 60 |
| 32 | 时之滞（与 31 互斥） | 炉芯/锭条产出 ×20，且 `buyableCost` ×0.6 | 60 |

- `milestones`（用 `player.t.total`）：
  - 0：`1 时序` → 全局自动化开关键位（`player.t.autoAll`，影响 h/m 的自动开关默认值）
  - 1：`5` → 自动购买**所有层**升级（实现：`autoUpgrade` 由每层读取 `hasMilestone('t',1)`；h/m/r 已按此实现）
  - 2：`20` → 自动加注所有 buyables（`player.t.autoFillAll`）
  - 3：`50` → 泄压/熔炼全自动（`player.t.autoHearth`）
  - 4：`100` → 自动反应（覆盖 r 的 autoPrestige）
  - 5：`300` → 「铭刻」成就层给成的加成 +100%（ach 层读取）
- `challenges`（**6 个，全部实现**；进入会清空 row0-2，t 自身保留）：

| id | 名称 | 限制（debuff，需自己生效） | 目标 `canComplete()` | 奖励（`rewardEffect`，需注册钩子） |
|---|---|---|---|---|
| 11 | 冷炉 | `coreGain` 类加成全部失效（在 h 的 gainMult 里检查 `inChallenge('t',11)`）| `player.h.points.gte(1e4)` | 热量 ×1e3（永久，`heat` 钩子） |
| 12 | 无压 | 炉压贡献失效（h 读取 `inChallenge('t',12)`） | `player.m.points.gte(1e3)` | 炉压指数 +0.1（`pressureExp`） |
| 13 | 贫瘠 | 所有 buyables 效果减半 | `player.r.points.gte(6)` | `buyableCost` ×0.75 |
| 14 | 迟缓 | 热量 ×0.01 | `player.r.points.gte(12)` | 时序效果指数 +0.15（`t` 本层 effect 读取 `challengeEffect`） |
| 15 | 独断 | 所有自动化失效（每层自动判断读 `inChallenge('t',15)`） | `player.t.resetGain.gte(2)` | 时序产出 ×2（`chrononGain`） |
| 16 | 归零 | `startPoints` 失效且热量 ×0.1 | `player.r.points.gte(20)` | 熔炉自动（h `passiveGeneration` +1）且热量 ×100 |

  - `completionLimit: 1`（11..16 均 1 次），`rewardDisplay` 用 `format`。
  - 15 号挑战的“自动化失效”必须由 h/m/r/t 各自在自动化判定处 `&& !inChallenge('t',15)`——**h/m/r 已按此约定实现，请照做**。
- `clickables`：
  - 11「过载 Surge」：状态机 `"就绪" / "过载!" / "冷却"`。激活：30s 内 `heat` ×20、`coreGain` ×3（用 `player.t.surgeUntil` 时间戳判定，注册钩子读取它）；冷却 300s（`player.t.surgeCd`）。`display` 必须显示剩余秒数。
  - 12「时之砂 Hourglass」（可选，若实现则：花费 3 时序换 `+1` 永久的 `chrononGain` ×1.1）。

### 5.5 `x` 熔星（row 4，**layers-top**）

- `type:"normal"`，`exponent: 0.3`，`requires: 20`（时序）。重置会清空 row0-3（见 §4）。
- 先天 `effect()`：星核 `s` 给
  - 热量 × `(1+s)^1.2`（`heat`）
  - 炉芯/锭条/触媒/时序产出 × `(1+s)^0.5`
  - `startPoints` × `(1+s)^2`
- 升级（成本=星核）：11 恒星图纸（凝时升级跨熔星保留）成本 1；12 引力透镜（热量 ×1e8）成本 2；13 自动熔星（`autoPrestige`）成本 5；14 余烬循环（`startPoints` ×1e3）成本 10。
- `milestones`：0 `总 5` → 保留反应 buyables 与 h 燃料棒；1 `总 20` → 解锁「点燃恒星」clickable 的可见性；2 `总 100` → 星核效果指数 +0.3。
- `clickables`：
  - 11「点燃恒星 Ignite the Star」：**结局触发器**。
    - `unlocked(){ return hasMilestone('x',1) }`
    - `canClick(){ return player.x.points.gte(X_BAL.igniteCost=1000) && completedChallengeCount() >= X_BAL.igniteChallenges(3) }`
    - `onClick(){ player.x.points = -.1000; player.x.ignited = true; doPopup("challenge","第一颗恒星在你的熔炉中点亮了。","点燃成功！", 8, "#ffd700"); makeParticles? 可选 }`
    - `display()`：明确列出两个条件与当前进度（`formatWhole`）。
    - **注意**：`player.x.ignited` 必须在 `startData()` 中存在（bool，默认 false），`mod.js` 的 `isEndgame()` 读它。点燃后 `keep going`：`x` 的 `effect()` 在 `player.x.ignited` 时把星核效果指数再 +0.5（并在 `effectDescription` 说明）。
- `tabFormat` 子标签「终局」：infobox（世界观收尾）+ 点燃按钮 + bar「点火进度」。

### 5.6 `ach` 铭刻（side，**side-layers**）

- `row:"side"`，`type:"none"`，`symbol:"★"`，`achievementPopups: true`。
- 成就 **14 个**（id 11..14/21..24/31..34/41..44），`done()` 读取全局状态；`goalTooltip`/`doneTooltip` 中文；其中至少 4 个是“彩蛋/条件刁钻”型（例如 热量恰好为某个值、泄压 100 次、进入全部挑战）。
- 统一奖励：每个成就给 `heat` ×1.02（用 `registerHook("heat", () => Decimal.pow(1.02, achievementCount()))`）；`hasMilestone('t',5)` 时该倍数 ×2。另外 4 个成就给专属 `effect()`（由别的层通过 `achievementEffect("ach", id)` 读取；请在 §5 对应层的说明中提供默认值以防 undefined —— 专属效果只加在 `heat`/`coreGain` 钩子里，由 ach.js 自己注册，避免其他层依赖）。
- 部分成就示例（可按此扩展）：首次熔炉/首次锻造/首次反应/首次凝时/首次熔星、泄压 1/50/200 次、任意层货币达到 1e6/1e30、完成 1/3/6 个挑战、拥有 5 个星核、点燃恒星。

### 5.7 `stats` 统计（side，**side-layers**）

- `row:"side"`，`type:"none"`，`symbol:"i"`，`layerShown(){ return player.h.unlocked }`。
- `tabFormat` 单个子标签，用 `["display-text", fn]` 列出：游玩时长（`formatTime(player.timePlayed)`）、热量/秒、各层货币与 total/best、各层 `resets`、泄压次数、已完成挑战数、成就数、当前互斥路线选择、当前生效的挑战。
- 不要新增货币、不要 doReset（side 层默认不受重置影响）。

## 6. mod.js（lead 实现，摘要）

- 热量/秒 = `(1 + foldAdd("heatFlat",0)) × foldMult("heat",1)`。
- `getStartPoints() = D(1).times(foldMult("startPoints",1))`。
- `displayThings`：顶栏常驻「当前目标」行（用 `fmtTarget`），并显示 热量/秒、炉压、过载状态。
- `isEndgame() = !!player.x.ignited`。
- `offlineLimit: 4`，`initialStartPoints: new Decimal(1)`。

## 7. 验收标准（每个任务都必须自检）

1. `node --check js/Forge/<你的文件>.js` 通过。
2. 严格按 §3 钩子名与 §4 保留规则实现；没有裸 Number 进入 `player`（除布尔）。
3. 没有副作用混进 `unlocked/canAfford/effect/gainMult/cost/display` 之类的纯读函数。
4. 所有面向玩家文本为简体中文，且包含“当前值 / 需求值”的可读信息。
5. harness 就绪后：`node tools/sim.js --layers=<你的层>` 无异常、无 NaN，且你的层能被解锁（报告里贴出关键行）。
6. 交付时在结论中写明：实现清单、偏离规格之处（及理由）、建议的平衡常量。

## 8. 平衡目标（sim 会用数据核对）

| 阶段 | 期望用时 |
|---|---|
| 首次熔炼（拿到 1 炉芯） | < 15s |
| 解锁 锻造 | 3–8 min |
| 解锁 反应 | 10–20 min |
| 解锁 凝时 | 25–50 min |
| 首次熔星 | 70–140 min |
| 点燃恒星（通关） | 2–5 h（自动化后） |

离线收益 4h 上限；`maxTickLength()` 保持 3600。
