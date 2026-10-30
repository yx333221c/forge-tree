# 熔炉之树（The Forge Tree）

一个用 [The-Modding-Tree](https://github.com/Acamaeda/The-Modding-Tree)（TMT）自制的中文增量游戏。
fork 自 TMT 模板，游戏内容全部为原创，含五层科技树、六个挑战、十六铭刻与一个可验证的结局。

## 怎么玩

游戏机制一句话：**热量每秒自己涨，你要决定什么时候把它放出来。**

炉压随时间线性涨到上限（憋着不放最多也就 ×1.35，不奖励无限等待），而真正的收益在「泄压」——
一次泄压会结算约 300 秒的产量，并按 `(P/CAP)^4` 结算，所以**满压才放比半压放强 16 倍**。
这一条不是靠提示告诉玩家，而是靠数值逼玩家自己发现。

科技树五层，每层用上一层的货币作为重置货币，并反过来给低层注册加成钩子：

| 层 | 名称 | 货币 | 玩法角色 |
|---|---|---|---|
| `h` | 熔炉 | 炉芯 | 教学层：泄压时机的权衡 |
| `m` | 锻造 | 锭条 | 引入互斥路线与跨层保留 |
| `r` | 反应 | 触媒 | static 层，成本曲线开始变陡 |
| `t` | 凝时 | 时序 | **六个挑战全在这里**，并引入过载／时之砂 |
| `x` | 熔星 | 星核 | 结局层：攒够 1000 星核 + 通关 3 个挑战即可**点燃恒星** |

另有 `ach`（铭刻，16 条成就，全部给全局热量倍率）与 `stats`（读数台）两个侧层。
设计契约（分层规格、重置保留规则、数值预算、已验证的引擎语义）见 [DESIGN.md](DESIGN.md)。

## 跑起来

**在线直接玩：<https://yx333221c.github.io/forge-tree/>**（GitHub Pages，无需安装任何东西）

本地跑法有二：

```
node tools/preview.js --port=8123     # 起本地服务，然后打开 http://localhost:8123
node tools/preview.js --check         # 不起服务，静态检查 index.html 的资源是否 404
```

也可以直接用浏览器打开 `index.html`，但注意部分浏览器在 `file://` 下会禁用
localStorage，此时存档无法保存——用上面的本地服务或线上地址更稳。

> 站点由 GitHub Pages 的 legacy 构建发布。仓库根放了空的 `.nojekyll`，
> 让 Pages 跳过 Jekyll、逐字节直传静态文件（`js/`、`css/` 与 `index.html` 全部使用相对路径，
> 因此部署在 `/forge-tree/` 子路径下也能正常加载）。

## 开发与验证

`tools/` 下是一套纯 node、无浏览器、无网络、确定性的测试工具链，用法与所有踩过的坑写在
[tools/README.md](tools/README.md)：

```
node tools/vet.js --selftest        # 编译 + 编码（U+FFFD/BOM/GBK 乱码）总检
node tools/harness.js               # 无头引擎桩自检
node tools/sim.js --minutes=45 --fast --out=r.txt              # 自动玩 + §8 节奏对照
node tools/test-mid.js && node tools/test-top.js && node tools/test-side.js
node tools/test-endgame.js 45       # 通关可达性：6 挑战 → 星核满 1000 → 点燃
```

全部通过时的实测结果（`seed=1`，45 分钟）：

```
首芯 18s → m 2.2min → r 17.3min → t 29.8min → x 33.3min
→ 6/6 挑战（29.8~32.5min）→ 星核满 1000 于 37.3min → 点燃恒星 37.3min
16/16 铭刻全部可达成；Infinity 从未出现；NaN 干净；运行期错误 0
```

## 关于引擎的改动

本项目改了 TMT 的两个引擎文件，都是实测复现的缺陷修复，不改变既有调用约定：

- `js/utils.js` — `buyUpg()` 补一次实时 `unlocked()` 校验。原实现只校验上一帧的
  `tmp.unlocked`，导致同一 tick 内两个**互斥升级**会被自动化同时买走（真人开自动购买就会踩）。
- `js/technical/temp.js` — `setupBuyables()` 加幂等标志。它原地包装 `b.cost`，
  被调用第二次会让 `cost → actualCostFunction → cost` 无限递归爆栈（只在重复初始化时触发）。

## 许可

MIT。Modding Tree 引擎版权归 [Acamaeda](https://github.com/Acamaeda)（见 `LICENSE`）；
本项目内的游戏内容（`js/Forge/`、`js/tree.js`、`DESIGN.md`、`tools/`）为原创，同样以 MIT 授权。
