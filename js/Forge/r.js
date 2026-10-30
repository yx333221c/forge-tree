// ============================================================================
// 《熔炉之树 · The Forge Tree》 —— row 2：反应（Reactor）
// 实现契约：DESIGN.md §5.3（配合 §3.2 钩子名、§3.5 引擎语义、§4 保留规则）
// 货币：触媒 Catalysts（base 资源 = 锭条 player.m.points）
//
// static 层的引擎语义（§3.5 第 2 条）：
//   * gainMult / gainExp 作用在**成本**上 → foldMult("catalystCost",1) 越小越强；
//   * directMult 直接乘**产出** → foldMult("catalystDirect",1) 越大越强。
//   两者都必须是有界正数：引擎要除它们，0 或 NaN 会立刻产生 Infinity/NaN。
//   （见 rClampCost / rClampDirect / rClampExp）
//
// 与其它层的分工：
//   * 跨层加成一律 registerHook；本层不改写别的层的数据（只读 player.m / player.h）。
//   * 本层购入件的货币是**锭条**（player.m.points），而 helpers 的 forgeBuyMany/forgeSellOne/
//     forgeRespecBuyables 写死了扣 player[layer].points。所以这里用下面的“异层货币”版本
//     （逻辑与 helpers 同构，只是把付款账户换成 player.m.points）。
//   * 加载期（addLayer 的对象字面量求值时）不调用 format / 不读 player / 不调 hasUpgrade。
// ============================================================================

var R_BAL = {
	requires: 10,					// 锭条 → 触媒 的单位门槛（static 层），同时是解锁需求
	base: 3,						// static 公式底数：成本 ≈ 3^(已持有触媒)（§5.3 规格值；
									//   实测把 base 降到 2.4 并不改善「触媒卡在个位数」，
									//   真正的瓶颈是上游锭条供给，见结论中的 M_BAL 建议）
	costExp: 1,						// static 成本指数（gainExp 的基础值）
	ingotExp: 0.6,					// 先天：触媒给锭条产出的指数
	heatExp: 0.8,					// 先天：触媒给热量的指数
	heatExpBonus: 0.2,				// 12 高压釜：上面的热量指数 +0.2
	costClampLow: "0.05",			// catalystCost 下限（防止成本归零 → 除零/NaN）
	costClampHigh: 20,				// catalystCost 上限（防止成本爆炸）
	directClampLow: "0.01",			// catalystDirect 下限（getNextAt 要除它）
	shiftBatch: 10,					// 按住 Shift 一次购买的数量
	buyLoopCap: 100,				// 单次批量最多买几个
	costCap: "1e30000",				// 数值上限夹取
	// —— 先天效果预算（§8.5 规则 2）——
	//    触媒是 static 货币，成本按 3^持有 上涨，天然停留在小规模；
	//    指数 0.6/0.8 按 §5.3 保留，effCap/effSoft 兜底。若 §8.5 复核仍超预算，只动这两个键。
	effCap: "1e12",					// 先天效果软上限（§8.5 建议 1e12）
	effSoft: 0.35,					// 超上限后的压缩指数（§8.5 建议 0.3–0.5）
	upgCost: { 11: 2, 12: 3, 13: 5, 14: 8, 21: 12, 22: 20, 23: 30, 24: 30 },
	milestones: [5, 10, 20, 30],	// 持有触媒门槛
	balShift: 1.5,					// 23 平衡移转：本层购入件效果 ×1.5
	costCut13: 0.85,				// 13 循环泵：成本 −15%
	costCut24: 0.7,					// 24 深冷分离：成本 −30%
	direct14: 1.5,					// 14 惰性保护：产出 +50%
	ingotMult: { 11: 3, 22: 10 },	// 11 催化配方 / 22 铂网：锭条产出倍数（通道 3×10=30 ≤ 1e6 ✓）
	// —— 购入件预算自检（§8.5 规则 1：per^limit ≤ 1e6，要更强就降上限提价，不要提 per）——
	//   催化塔 3^12   = 5.3e5 ≤ 1e6 ✓（§5.3 原 limit 25 → 3^25=8.5e11 超预算，已降上限；这是实测压垮 heat 的元凶）
	//   冷凝器 1.6^20 = 1.9e4 ≤ 1e6 ✓
	//   催化床 1.4^10 = 2.9   ≤ 1e6 ✓
	buyables: {
		11: { base: 20, growth: 2, per: 3, limit: 12, name: "催化塔", unit: "座" },
		12: { base: 50, growth: 2.4, per: 1.6, limit: 20, name: "冷凝器", unit: "台" },
		13: { base: 100, growth: 3, per: 1.4, limit: 10, name: "催化床", unit: "层" },
	},
}

// ---------------- 只读小工具（纯函数，无副作用） ----------------
function rNum(x) { // Decimal | number -> Decimal，坏值归零
	if (x instanceof Decimal) return x.isNan() ? decimalZero : x
	if (typeof x === "number") return isFinite(x) ? new Decimal(x) : decimalZero
	return decimalZero
}
function rPoints() { return forgeAmt("r") }
function rTotal() { return forgeTot("r") }
function rBest() { return forgeHasLayer("r") ? rNum(player.r.best) : decimalZero }
function rResets() { return forgeHasLayer("r") ? rNum(player.r.resets) : decimalZero }
function rIngot() { return forgeAmt("m") }			// 本层的 base 资源 = 锭条
function rAmt(id) { return getBuyableAmount("r", id) }
function rSpent() { return forgeHasLayer("r") ? rNum(player.r.spentOnBuyables) : decimalZero }
function rLimit(id) {
	let b = (typeof layers !== "undefined" && layers.r) ? layers.r.buyables[id] : null
	return b ? rNum(b.purchaseLimit) : new Decimal((R_BAL.buyables[id] || {}).limit || 0)
}
function rUpg(layer, id) { return forgeHasUpgrade(layer, id) }
function rMs(layer, id) { return forgeHasMilestone(layer, id) }
function rUnlocked() { return forgeHasUnlocked("r") }
function rFlag(name) { return forgeHasLayer("r") ? !!player.r[name] : false }
function rFlagText(name, on) { return "「" + on + "」：" + (rFlag(name) ? "<b>已开启</b>" : "未开启") }

// 成本倍数夹取：static 层里它乘在成本上，必须是有界正数
function rClampCost(v) {
	let d = rNum(v)
	if (!d.isFinite() || d.lte(0)) return decimalOne
	let lo = new Decimal(R_BAL.costClampLow)
	let hi = new Decimal(R_BAL.costClampHigh)
	if (d.lt(lo)) return lo
	if (d.gt(hi)) return hi
	return d
}
// 产出倍数夹取：getNextAt 会除以它，必须是有界正数
function rClampDirect(v) {
	let d = rNum(v)
	if (!d.isFinite() || d.lte(0)) return decimalOne
	let lo = new Decimal(R_BAL.directClampLow)
	if (d.lt(lo)) return lo
	if (d.gt(R_BAL.costCap)) return new Decimal(R_BAL.costCap)
	return d
}
// 成本指数夹取
function rClampExp(v) {
	let d = rNum(v)
	if (!d.isFinite() || d.lte(0)) return decimalOne
	if (d.gt(10)) return new Decimal(10)
	return d
}
// 预算软上限（§8.5 规则 2）：本层先天指数（0.6/0.8）高于 ≤0.25 的建议值，
// 因此**必须**带软上限；超过 effCap 后按 x^effSoft 压缩，永不产生 Infinity。
function rBudget(v) {
	let d = rNum(v)
	if (!d.isFinite() || d.lte(0)) return decimalOne
	let c = new Decimal(R_BAL.effCap)
	if (d.gt(c)) d = c.times(d.div(c).pow(new Decimal(R_BAL.effSoft)))
	if (!d.isFinite() || d.lte(0)) return decimalOne
	return d
}
// 兼容旧名字：只挡 Infinity/NaN，预算交给 rBudget
function rCapEff(d) {
	if (!d.isFinite()) return new Decimal(R_BAL.costCap)
	return d
}

// ---------------- 本层公式组成 ----------------
function rCostMult() {
	let m
	try { m = foldMult("catalystCost", 1) } catch (e) { m = decimalOne }
	return rClampCost(m)
}
function rCostExp() {
	let e
	try { e = new Decimal(R_BAL.costExp).add(foldAdd("catalystExpBonus", 0)) } catch (err) { e = new Decimal(R_BAL.costExp) }
	return rClampExp(e)
}
function rDirectMult() {
	let d
	try { d = foldMult("catalystDirect", 1) } catch (e) { d = decimalOne }
	return rClampDirect(d)
}
// 先天效果
function rHeatExp() {
	let e = new Decimal(R_BAL.heatExp)
	if (rUpg("r", 12)) e = e.add(new Decimal(R_BAL.heatExpBonus))
	return e
}
function rEffIngot() { return rBudget(decimalOne.add(rPoints()).pow(new Decimal(R_BAL.ingotExp))) }
function rEffHeat() { return rBudget(decimalOne.add(rPoints()).pow(rHeatExp())) }

// 升级贡献
function rUpgIngotMult() {
	let v = decimalOne
	if (rUpg("r", 11)) v = v.times(new Decimal(R_BAL.ingotMult[11]))
	if (rUpg("r", 22)) v = v.times(new Decimal(R_BAL.ingotMult[22]))
	return v
}
function rUpgCostMult() {
	let v = decimalOne
	if (rUpg("r", 13)) v = v.times(new Decimal(R_BAL.costCut13))
	if (rUpg("r", 24)) v = v.times(new Decimal(R_BAL.costCut24))
	return rClampCost(v)
}
function rUpgDirectMult() { return rUpg("r", 14) ? new Decimal(R_BAL.direct14) : decimalOne }
function rUpgBuyShift() { return rUpg("r", 23) ? new Decimal(R_BAL.balShift) : decimalOne }

// ---------------- 购入件（成本货币 = 锭条 player.m.points） ----------------
function rBuySpec(id) { return R_BAL.buyables[id] || R_BAL.buyables[11] }
function rCostFinal(x) {
	let raw = rNum(x)
	let v = raw
	try { v = rNum(buyableCostFinal(raw)) } catch (e) { v = raw }
	if (!v.isFinite() || v.lte(0)) v = raw
	return v.max(decimalOne).ceil()		// 锭条是整数：成本向上取整，判定与显示一致
}
function rBuyCost(id, x) {
	let b = rBuySpec(id)
	let n = rNum(x).max(0)
	let cost = new Decimal(b.base).times(Decimal.pow(new Decimal(b.growth), n))
	if (!cost.isFinite() || cost.gt(R_BAL.costCap)) return new Decimal(R_BAL.costCap)
	return rCostFinal(cost)
}
function rBuyEffect(id, x) { // 含 23「平衡移转」与挑战「贫瘠」的减半
	let b = rBuySpec(id)
	let n = rNum(x).max(0)
	let e = Decimal.pow(new Decimal(b.per), n)
	if (!e.isFinite()) return new Decimal(R_BAL.costCap)
	e = e.times(rUpgBuyShift())
	let d
	try { d = rNum(buyableDebuff(e)) } catch (err) { d = e }
	if (d.lte(0) || !d.isFinite()) return decimalOne
	return d
}

// —— 异层货币版买/卖/返还：付的是锭条（player.m.points），投入记在本层 spentOnBuyables ——
function rBuyMany(id, n) {
	if (!rUnlocked() || !forgeHasLayer("m")) return decimalZero
	let limit = rLimit(id)
	let amount = rAmt(id)
	if (amount.gte(limit)) return decimalZero
	let pts = rIngot()
	let spent = rSpent()
	let bought = decimalZero
	let want = Math.floor(rNum(n).toNumber())
	if (!isFinite(want) || want < 1) want = 1
	if (want > R_BAL.buyLoopCap) want = R_BAL.buyLoopCap
	for (let i = 0; i < want; i++) {
		if (amount.add(bought).gte(limit)) break
		let c = rBuyCost(id, amount.add(bought))
		if (!c.isFinite() || c.lte(0)) break
		if (pts.lt(c)) break
		pts = pts.sub(c)
		spent = spent.add(c)
		bought = bought.add(1)
	}
	if (bought.gt(0)) {
		addBuyables("r", id, bought)
		player.m.points = pts
		player.r.spentOnBuyables = spent
	}
	return bought
}
function rBuyMax(id) { return rBuyMany(id, rLimit(id)) }
function rSellOne(id) {
	if (!rUnlocked() || !forgeHasLayer("m")) return decimalZero
	let a = rAmt(id)
	if (a.lte(0)) return decimalZero
	let refund = rBuyCost(id, a.sub(1))
	setBuyableAmount("r", id, a.sub(1))
	player.m.points = rIngot().add(refund)
	player.r.spentOnBuyables = rSpent().gt(refund) ? rSpent().sub(refund) : decimalZero
	return refund
}
function rSellAll(id) {
	let n = Math.min(Math.floor(rAmt(id).toNumber()), R_BAL.buyLoopCap)
	for (let i = 0; i < n; i++) rSellOne(id)
}
// 全额返还（退还的仍是锭条）
function rRespec() {
	if (!rUnlocked() || !forgeHasLayer("m")) return
	let refund = rSpent()
	let ids = Object.keys(R_BAL.buyables)
	for (let i = 0; i < ids.length; i++) setBuyableAmount("r", ids[i], decimalZero)
	player.r.spentOnBuyables = decimalZero
	player.m.points = rIngot().add(refund)
	updateBuyableTemp("r")
}

// ---------------- 显示辅助（运行期函数） ----------------
function rUpgCost(id) {
	let base = new Decimal(R_BAL.upgCost[id] || 1)
	let v = base
	try { v = rNum(upgradeCostFinal(base)) } catch (e) { v = base }
	if (!v.isFinite() || v.lte(0)) v = base
	return v.max(decimalOne).ceil()
}
// 升级可见性：§5.3 没有规定行锁，h.js 也只对互斥对做 unlocked()，所以一律可见，
// 由成本（2→30）决定购买顺序；互斥仍由 23/24 的 !rUpg(对方) 处理。
function rUpgradeRowOpen(row) { return true }
// 互斥语义（DESIGN §5.3）：只用 unlocked() 表达「二选一」，不做退款式兜底。
// 引擎层（js/utils.js buyUpg）已补实时 unlocked() 校验 → 同一 tick 内后买者被**拒绝**，
// 语义固定为「先到者胜、后买被拒、不扣钱」。
// 曾有 onPurchase「顶替+退款」守卫，已删除：退款按 rUpgCost(otherId) 当下重算，
// 而成本随 upgradeCost 钩子变化，绕过 buyUpg 的路径下会退错钱，是刷钱口。
function rNextMilestoneIdx() {
	for (let i = 0; i < R_BAL.milestones.length; i++) {
		if (!rMs("r", i)) return i
	}
	return -1
}
function rMilestoneHold() { return rPoints().max(rBest()) }	// 判定用「当前/历史最高」两者
function rMilestoneText(idx) {
	return fmtTarget(rMilestoneHold(), new Decimal(R_BAL.milestones[idx]), "触媒")
}
function rRouteText() {
	if (rUpg("r", 23)) return "<b>平衡移转</b>（购入件效果 ×" + format(rUpgBuyShift()) + "）"
	if (rUpg("r", 24)) return "<b>深冷分离</b>（触媒成本 ×" + format(new Decimal(R_BAL.costCut24)) + "）"
	return "尚未选择（第 2 行二选一）"
}
function rNextAtText() {
	let req = new Decimal(R_BAL.requires)
	if (typeof tmp !== "undefined" && tmp.r && tmp.r.nextAtDisp !== undefined) {
		return rNum(tmp.r.nextAtDisp).max(req)
	}
	return req
}
function rGainText() {
	if (typeof tmp !== "undefined" && tmp.r && tmp.r.resetGain !== undefined) return rNum(tmp.r.resetGain)
	return decimalZero
}
function rStatusText() {
	let cost = rCostMult()
	let direct = rDirectMult()
	let req = new Decimal(R_BAL.requires)
	let lines = []
	lines.push("<h3>反应读数</h3>")
	lines.push("原料锭条 <b>" + formatWhole(rIngot()) + "</b>　持有触媒 <b>" + formatWhole(rPoints()) +
		"</b>　最高 " + formatWhole(rBest()) + "　累计 " + formatWhole(rTotal()) + "　反应 " + formatWhole(rResets()) + " 次<br>")
	lines.push("成本模型：下一手需 " + formatWhole(req) + " × " + timesFormat(cost) + " × " +
		format(new Decimal(R_BAL.base)) + "^（持有 ÷ 产出倍数） 锭条　<b>成本倍数 &lt;1 才是变强</b><br>")
	lines.push("产出倍数：" + timesFormat(direct) + "（越大越好）　成本指数：" + format(rCostExp()) + "<br>")
	lines.push("下一手：需 " + formatWhole(rNextAtText()) + " 锭条 → <b>" + formatWhole(rGainText()) + "</b> 触媒" +
		(rMs("r", 1) ? "（一次买满已解锁）" : "（一次买满未解锁）") + "<br>")
	lines.push("<b>先天：</b>锭条产出 " + timesFormat(rEffIngot()) + "，热量 " + timesFormat(rEffHeat()) +
		"（热量指数 " + format(rHeatExp()) + (rUpg("r", 12) ? "，含高压釜 +0.2" : "") + "）<br>")
	lines.push("<b>购入件（付锭条）：</b>催化塔 " + formatWhole(rAmt("11")) + "/" + formatWhole(rLimit("11")) +
		"（" + timesFormat(rBuyEffect("11", rAmt("11"))) + " 热量）　冷凝器 " + formatWhole(rAmt("12")) + "/" + formatWhole(rLimit("12")) +
		"（" + timesFormat(rBuyEffect("12", rAmt("12"))) + " 炉芯）　催化床 " + formatWhole(rAmt("13")) + "/" + formatWhole(rLimit("13")) +
		"（" + timesFormat(rBuyEffect("13", rAmt("13"))) + " 炉压增速）<br>")
	let idx = rNextMilestoneIdx()
	lines.push(idx < 0 ? "里程碑全部达成" : ("下一个里程碑：" + rMilestoneText(idx)))
	lines.push("<br><b>互斥路线：</b>" + rRouteText())
	lines.push("<br>" + rFlagText("autoBuy", "自动购买升级") + "　" + rFlagText("autoFill", "自动加注") + "　" + rFlagText("autoRun", "自动反应") + "<br>")
	lines.push("购入件已投入 " + formatWhole(rSpent()) + " 锭条；「放空管线」全额返还（锭条在锻造层，若已被重置就无货可退）。")
	return lines.join("")
}

// ---------------- 钩子注册（registerHook 在加载期执行，函数体在运行期执行） ----------------
function rRegister(name, fn) {
	try {
		registerHook(name, fn)
	} catch (e) {
		console.error("Forge[r] hook register failed: " + name, e)
	}
}
function rHookIngotInnate() { return rEffIngot() }
function rHookIngotUpg() { return rUpgIngotMult() }
function rHookHeatInnate() { return rEffHeat() }
function rHookHeatBuy() { return rBuyEffect("11", rAmt("11")) }
function rHookCoreBuy() { return rBuyEffect("12", rAmt("12")) }
function rHookPressureBuy() { return rBuyEffect("13", rAmt("13")) }
function rHookCatalystCost() { return rUpgCostMult() }
function rHookCatalystDirect() { return rUpgDirectMult() }

rRegister("ingotGain", rHookIngotInnate)			// 触媒先天 → 锭条产出
rRegister("ingotGain", rHookIngotUpg)			// 催化配方 / 铂网
rRegister("heat", rHookHeatInnate)				// 触媒先天 → 热量
rRegister("heat", rHookHeatBuy)					// 催化塔
rRegister("coreGain", rHookCoreBuy)				// 冷凝器 → 炉芯产出
rRegister("pressureRate", rHookPressureBuy)		// 催化床 → 炉压增速（乘法倍数）
rRegister("catalystCost", rHookCatalystCost)	// 循环泵 / 深冷分离（乘在成本上）
rRegister("catalystDirect", rHookCatalystDirect)	// 惰性保护（直接乘产出）

// ---------------- 保留规则（§4）----------------
// 反应被更高层重置时：本层升级没有跨层保留的契约 → 一律清空；
// 购入件（连同投入的锭条）由 x 里程碑 0 决定保留。
function rKeepBuyables(resettingLayer) {
	if (!resettingLayer || resettingLayer === "r") return false
	if (resettingLayer === "x") return rMs("x", 0)
	return false
}

// 供 tab 上「全部加注」按钮调用
function rFillAll() {
	if (!rUnlocked()) return
	let ids = Object.keys(R_BAL.buyables)
	for (let i = 0; i < ids.length; i++) {
		try { rBuyMax(ids[i]) } catch (e) { console.error(e) }
	}
}

// ============================================================================
addLayer("r", {
	name: "反应",
	symbol: "R",
	color: "#4169e1",
	row: 2,
	position: 0,

	resource: "触媒",
	baseResource: "锭条",
	baseAmount() { return rIngot() },

	type: "static",
	base: R_BAL.base,						// 引擎加载期会检查 base > 1
	exponent: 1,
	// requires 用**函数**形式（引擎支持；见 js/Demo/layers/f.js:19 与 docs/layer-features.md）：
	// 字面量 new Decimal(...) 会被加载期捕获，之后改 R_BAL.requires 不再生效，
	// tools/sim.js / --set 就无法扫参门槛。static 层里 requires 是「单位成本」，
	// 引擎每帧通过 tmp.r.requires 读取（game.js getNextAt/getResetGain/canReset/doReset）。
	requires() { return new Decimal(R_BAL.requires) },
	roundUpCost: true,

	gainMult() { return rCostMult() },			// foldMult("catalystCost",1)：作用在**成本**上
	gainExp() { return rCostExp() },			// 1 + foldAdd("catalystExpBonus",0)：成本指数
	directMult() { return rDirectMult() },		// foldMult("catalystDirect",1)：作用在**产出**上
	canBuyMax() { return rMs("r", 1) },

	startData() {
		return {
			unlocked: false,
			points: decimalZero,
			best: decimalZero,
			total: decimalZero,
			resets: decimalZero,
			spentOnBuyables: decimalZero,		// 记录投入的**锭条**（购入件货币是锭条）
			buyables: {},
			autoBuy: false,		// milestone 0
			autoFill: false,	// milestone 2
			autoRun: false,		// milestone 3
		}
	},

	layerShown() { return rUnlocked() || forgeHasUnlocked("m") },

	tooltip() {
		return "触媒：<b>" + formatWhole(rPoints()) + "</b>（最高 " + formatWhole(rBest()) + "）<br>" +
			"锭条产出 " + timesFormat(rEffIngot()) + "　热量 " + timesFormat(rEffHeat()) + "<br>" +
			"成本倍数 " + timesFormat(rCostMult()) + "　产出倍数 " + timesFormat(rDirectMult()) + "<br>" +
			"催化塔 " + formatWhole(rAmt("11")) + " 座　冷凝器 " + formatWhole(rAmt("12")) + " 台　催化床 " + formatWhole(rAmt("13")) + " 层"
	},
	tooltipLocked() {
		let req = new Decimal(R_BAL.requires)
		let cur = rIngot()
		return "需要 <b>" + formatWhole(req) + "</b> 锭条（当前 " + formatWhole(cur) + "）<br>" +
			(cur.gte(req) ? "已达标：点击节点通气。" :
				"还差 " + formatWhole(req.minus(cur)) + " 锭条。<br>锭条来自锻造（Mill）层。先攒够料，再开反应。")
	},

	resetDescription: "向锭条中通入触媒，获得 ",
	hotkeys: [
		{
			key: "r",
			description: "R：反应，用锭条换触媒（会重置熔炉与锻造）",
			onPress() { if (canReset("r")) doReset("r") },
		},
		{
			key: "ctrl+r",
			description: "Ctrl+R：放空管线，全额返还反应购入件",
			unlocked() { return rMs("r", 2) },
			onPress() { respecBuyables("r") },
		},
	],

	effect() {
		return {
			ingot: rEffIngot(),
			heat: rEffHeat(),
		}
	},
	effectDescription() {
		let e = this.effect()
		return "正在把锭条产出放大 " + timesFormat(e.ingot) + "，热量放大 " + timesFormat(e.heat) +
			"（触媒越多越强；热量指数 " + format(rHeatExp()) + (rUpg("r", 12) ? "，含高压釜加成" : "") + "）"
	},

	onPrestige() {
		if (forgeHasLayer("r")) {
			player.r.resets = rNum(player.r.resets).add(1)
		}
	},

	doReset(resettingLayer) {
		let keep = []
		if (rKeepBuyables(resettingLayer)) { keep.push("buyables"); keep.push("spentOnBuyables") }
		forgeDoReset(this.layer, resettingLayer, keep)
	},

	// §5.4 凝时里程碑 1「自动购买所有层升级」同样要覆盖本层（forgeHasMilestone 跨层安全）
	autoUpgrade() { return autoOn((rFlag("autoBuy") && rMs("r", 0)) || forgeHasMilestone("t", 1)) },
	// §5.4 里程碑 4「自动反应」要求它能覆盖本层的 autoPrestige。
	// forgeAutoReaction 定义在 t.js（加载顺序在本文件之后），因此必须做存在性守卫。
	autoPrestige() {
		let own = rFlag("autoRun") && rMs("r", 3)
		let fromTempo = (typeof forgeAutoReaction === "function") ? forgeAutoReaction() : false
		return autoOn(own || fromTempo)
	},
	automate() {
		if (!rUnlocked()) return
		if (!autoOn(rFlag("autoFill") && rMs("r", 2))) return
		let ids = Object.keys(R_BAL.buyables)
		for (let i = 0; i < ids.length; i++) {
			try { rBuyMax(ids[i]) } catch (e) { console.error(e) }
		}
	},

	// ---------------------------------------------------------------- 升级
	upgrades: {
		11: {
			title: "催化配方",
			description: "锭条产出 ×3。<br><i>影响锻造（Mill）层的锭条产出。</i>",
			cost() { return rUpgCost(11) },
			unlocked() { return rUpgradeRowOpen(1) },
			branches: [21],
			effect() { return new Decimal(R_BAL.ingotMult[11]) },
			effectDisplay() { return "锭条产出 " + timesFormat(rUpgIngotMult()) },
		},
		12: {
			title: "高压釜",
			description() {
				return "触媒的热量指数 +0.2。<br>当前热量指数：" + format(rHeatExp()) + "（基础 " + R_BAL.heatExp + "）"
			},
			cost() { return rUpgCost(12) },
			unlocked() { return rUpgradeRowOpen(1) },
			branches: [22],
			effect() { return new Decimal(R_BAL.heatExpBonus) },
			effectDisplay() { return "热量指数 " + format(rHeatExp()) },
		},
		13: {
			title: "循环泵",
			description: "触媒成本 ×0.85（成本 −15%）。<br><i>只影响本层的成本倍数。</i>",
			cost() { return rUpgCost(13) },
			unlocked() { return rUpgradeRowOpen(1) },
			branches: [23],
			effect() { return new Decimal(R_BAL.costCut13) },
			effectDisplay() { return "触媒成本 " + timesFormat(rUpgCostMult()) },
		},
		14: {
			title: "惰性保护",
			description: "触媒产出 ×1.5（+50%）。<br><i>影响本层的产出倍数。</i>",
			cost() { return rUpgCost(14) },
			unlocked() { return rUpgradeRowOpen(1) },
			branches: [24],
			effect() { return new Decimal(R_BAL.direct14) },
			effectDisplay() { return "触媒产出 " + timesFormat(rUpgDirectMult()) },
		},
		21: {
			title: "反应再生",
			description: "反应重置时，<b>保留锻造的全部升级与本层以下的购入件</b>（含熔炉购入件）。",
			cost() { return rUpgCost(21) },
			unlocked() { return rUpgradeRowOpen(2) },
		},
		22: {
			title: "铂网",
			description: "锭条产出 ×10。<br><i>影响锻造（Mill）层的锭条产出。</i>",
			cost() { return rUpgCost(22) },
			unlocked() { return rUpgradeRowOpen(2) },
			effect() { return new Decimal(R_BAL.ingotMult[22]) },
			effectDisplay() { return "锭条产出 " + timesFormat(rUpgIngotMult()) },
		},
		23: {
			title: "平衡移转",
			description() {
				return "本层购入件效果 ×1.5。<br>当前移转系数：" + timesFormat(rUpgBuyShift()) +
					"　催化塔现在给 " + timesFormat(rBuyEffect("11", rAmt("11"))) + " 热量。<br><b>与「深冷分离」互斥，二选一。</b>"
			},
			cost() { return rUpgCost(23) },
			unlocked() { return rUpgradeRowOpen(2) && !rUpg("r", 24) },
			effect() { return rUpgBuyShift() },
			effectDisplay() { return "购入件效果 " + timesFormat(rUpgBuyShift()) },
		},
		24: {
			title: "深冷分离",
			description() {
				return "触媒成本 ×0.7（−30%）。<br>当前成本倍数：" + timesFormat(rCostMult()) +
					"（越小越便宜）<br><b>与「平衡移转」互斥，二选一。</b>"
			},
			cost() { return rUpgCost(24) },
			unlocked() { return rUpgradeRowOpen(2) && !rUpg("r", 23) },
			effect() { return new Decimal(R_BAL.costCut24) },
			effectDisplay() { return "触媒成本 " + timesFormat(rUpgCostMult()) },
		},
	},

	// ---------------------------------------------------------------- 里程碑
	milestones: {
		0: {
			requirementDescription() { return "持有 5 触媒<br>" + rMilestoneText(0) },
			done() { return rMilestoneHold().gte(new Decimal(R_BAL.milestones[0])) },
			effectDescription() { return "解锁<b>自动购买反应升级</b><br>" + rFlagText("autoBuy", "自动购买升级") },
			toggles: [["r", "autoBuy"]],
		},
		1: {
			requirementDescription() { return "持有 10 触媒<br>" + rMilestoneText(1) },
			done() { return rMilestoneHold().gte(new Decimal(R_BAL.milestones[1])) },
			effectDescription() {
				return "解锁<b>一次买满</b>（Buy Max，反应按钮直接买满）<br>当前：" + (rMs("r", 1) ? "<b>已解锁</b>" : "未解锁")
			},
			unlocked() { return rMs("r", 0) },
		},
		2: {
			requirementDescription() { return "持有 20 触媒<br>" + rMilestoneText(2) },
			done() { return rMilestoneHold().gte(new Decimal(R_BAL.milestones[2])) },
			effectDescription() { return "解锁<b>每 tick 自动加注购入件</b>（Ctrl+R 放空管线）<br>" + rFlagText("autoFill", "自动加注") },
			unlocked() { return rMs("r", 1) },
			toggles: [["r", "autoFill"]],
		},
		3: {
			requirementDescription() { return "持有 30 触媒<br>" + rMilestoneText(3) },
			done() { return rMilestoneHold().gte(new Decimal(R_BAL.milestones[3])) },
			effectDescription() { return "解锁<b>自动反应</b>（够本就让管线自己走）<br>" + rFlagText("autoRun", "自动反应") },
			unlocked() { return rMs("r", 2) },
			toggles: [["r", "autoRun"]],
		},
	},

	// ---------------------------------------------------------------- 购入件（成本：锭条）
	buyables: {
		showRespec: true,
		respecText: "放空管线",
		respecMessage: "确定要放空所有反应购入件吗？投入的锭条会全额返还（锭条在锻造层，若已被重置就无货可退）。",
		respec() {
			rRespec()	// 不用 forgeRespecBuyables：本层购入件付的是锭条，不是触媒
		},
		11: {
			title() { return "催化塔　" + formatWhole(rAmt("11")) + " / " + formatWhole(rLimit("11")) },
			cost(x) { return rBuyCost("11", rNum(x)) },
			effect(x) { return rBuyEffect("11", rNum(x)) },
			unlocked() { return rUnlocked() },
			canAfford() { return rIngot().gte(rBuyCost("11", rAmt("11"))) },
			buy() { rBuyMany("11", shiftDown ? R_BAL.shiftBatch : 1) },
			buyMax() { rBuyMax("11") },
			sellOne() { rSellOne("11") },
			sellAll() { rSellAll("11") },
			canSellOne() { return rAmt("11").gt(0) },
			canSellAll() { return rAmt("11").gt(0) },
			purchaseLimit: new Decimal(R_BAL.buyables[11].limit),
			tooltip() { return "每座给热量 ×3，成本付<b>锭条</b>。按住 Shift 一次买 " + R_BAL.shiftBatch + " 座。" },
			display() {
				let b = rBuySpec("11")
				let amt = rAmt("11")
				return "每座：热量 ×" + format(new Decimal(b.per)) + "<br>" +
					"当前：" + timesFormat(rBuyEffect("11", amt)) + "<br>" +
					"下一座成本：" + formatWhole(rBuyCost("11", amt)) + " 锭条（持有 " + formatWhole(rIngot()) + "）<br>" +
					fmtTarget(amt, rLimit("11"), "座")
			},
		},
		12: {
			title() { return "冷凝器　" + formatWhole(rAmt("12")) + " / " + formatWhole(rLimit("12")) },
			cost(x) { return rBuyCost("12", rNum(x)) },
			effect(x) { return rBuyEffect("12", rNum(x)) },
			unlocked() { return rUnlocked() },
			canAfford() { return rIngot().gte(rBuyCost("12", rAmt("12"))) },
			buy() { rBuyMany("12", shiftDown ? R_BAL.shiftBatch : 1) },
			buyMax() { rBuyMax("12") },
			sellOne() { rSellOne("12") },
			sellAll() { rSellAll("12") },
			canSellOne() { return rAmt("12").gt(0) },
			canSellAll() { return rAmt("12").gt(0) },
			purchaseLimit: new Decimal(R_BAL.buyables[12].limit),
			tooltip() { return "每台给炉芯产出 ×1.6（影响熔炉层），成本付<b>锭条</b>。回流的蒸汽不是浪费。" },
			display() {
				let b = rBuySpec("12")
				let amt = rAmt("12")
				return "每台：炉芯产出 ×" + format(new Decimal(b.per)) + "<br>" +
					"当前：" + timesFormat(rBuyEffect("12", amt)) + "<br>" +
					"下一台成本：" + formatWhole(rBuyCost("12", amt)) + " 锭条（持有 " + formatWhole(rIngot()) + "）<br>" +
					fmtTarget(amt, rLimit("12"), "台")
			},
		},
		13: {
			title() { return "催化床　" + formatWhole(rAmt("13")) + " / " + formatWhole(rLimit("13")) },
			cost(x) { return rBuyCost("13", rNum(x)) },
			effect(x) { return rBuyEffect("13", rNum(x)) },
			unlocked() { return rUnlocked() },
			canAfford() { return rIngot().gte(rBuyCost("13", rAmt("13"))) },
			buy() { rBuyMany("13", shiftDown ? R_BAL.shiftBatch : 1) },
			buyMax() { rBuyMax("13") },
			sellOne() { rSellOne("13") },
			sellAll() { rSellAll("13") },
			canSellOne() { return rAmt("13").gt(0) },
			canSellAll() { return rAmt("13").gt(0) },
			purchaseLimit: new Decimal(R_BAL.buyables[13].limit),
			tooltip() { return "每层给炉压增速 ×1.4（影响熔炉层的炉压积攒），成本付<b>锭条</b>。压力是最古老的催化剂。" },
			display() {
				let b = rBuySpec("13")
				let amt = rAmt("13")
				return "每层：炉压增速 ×" + format(new Decimal(b.per)) + "<br>" +
					"当前：" + timesFormat(rBuyEffect("13", amt)) + "<br>" +
					"下一层成本：" + formatWhole(rBuyCost("13", amt)) + " 锭条（持有 " + formatWhole(rIngot()) + "）<br>" +
					fmtTarget(amt, rLimit("13"), "层")
			},
		},
	},

	// ---------------------------------------------------------------- 进度条
	bars: {
		conversion: {
			direction: RIGHT,
			width: 420,
			height: 28,
			fillStyle: { "background-color": "#4169e1" },
			baseStyle: { "background-color": "#141a2b" },
			textStyle: { "color": "#d7e4ff", "text-shadow": "0px 0px 2px #000000" },
			borderStyle() { return { "border-width": "2px" } },
			progress() {
				let goal = rNextAtText().max(new Decimal(R_BAL.requires))
				let p = rIngot().div(goal).toNumber()
				if (!isFinite(p) || p < 0) return 0
				return Math.min(1, p)
			},
			display() {
				return "转化率：" + formatWhole(rIngot()) + " / " + formatWhole(rNextAtText()) +
					" 锭条 → " + formatWhole(rGainText()) + " 触媒"
			},
			unlocked() { return rUnlocked() },
		},
		yield: {
			direction: RIGHT,
			width: 420,
			height: 22,
			fillStyle: { "background-color": "#7fa8ff" },
			baseStyle: { "background-color": "#101725" },
			textStyle: { "color": "#e8efff" },
			progress() {
				let idx = rNextMilestoneIdx()
				if (idx < 0) return 1
				let p = rPoints().div(new Decimal(R_BAL.milestones[idx]).max(decimalOne)).toNumber()
				if (!isFinite(p) || p < 0) return 0
				return Math.min(1, p)
			},
			display() {
				let idx = rNextMilestoneIdx()
				if (idx < 0) return "里程碑全部达成　触媒 " + formatWhole(rPoints())
				return "下一里程碑：" + formatWhole(rPoints()) + " / " + formatWhole(new Decimal(R_BAL.milestones[idx])) + " 触媒"
			},
			unlocked() { return rUnlocked() },
		},
	},

	// ---------------------------------------------------------------- 世界观
	infoboxes: {
		lore: {
			title: "炉边记事 · 反",
			body() {
				return "反应把锭条换成触媒：十个起一手，之后每多持有一个，下一个就要贵三倍。<br>" +
					"触媒同时抬高热量和锭条产出，所以它贵得有道理。<br>" +
					"反应会重置熔炉与锻造，留不留得住东西，取决于你点开了哪些升级和里程碑。"
			},
			titleStyle: { "color": "#4169e1" },
		},
		ledger: {
			title: "炉边记事 · 反应台账",
			body() { return rStatusText() },
		},
	},

	// ---------------------------------------------------------------- 布局
	tabFormat: {
		"主界面": {
			content: [
				"main-display",
				"prestige-button",
				"resource-display",
				["blank", "8px"],
				["bar", "conversion"],
				["bar", "yield"],
				["blank", "10px"],
				"milestones",
				["blank", "14px"],
				"upgrades",
				["blank", "14px"],
				["row", [
					["raw-html", function() { return "<button class='longUpg can' onclick='rFillAll()'>全部加注</button>" }],
					["blank", ["10px", "10px"]],
					["display-text", function() { return "购入件付的是<b>锭条</b>；按住 Shift 一次买 " + R_BAL.shiftBatch + " 个；「放空管线」全额返还。" }],
				]],
				"buyables",
			],
			glowColor: "#4169e1",
		},
		"详情": {
			content: [
				["infobox", "lore"],
				["blank", "12px"],
				["infobox", "ledger"],
				["blank", "12px"],
				["display-text", function() { return rStatusText() }],
				"h-line",
				["display-text", function() {
					return "本层没有挑战。挑战在凝时（Tempo）层的沙漏里。<br>" +
						"反应层看的是合成成本，不是产量：下面两个读数，<b>成本倍数越小越便宜，产出倍数越大越划算</b>。<br>" +
						"当前成本倍数 " + timesFormat(rCostMult()) + "，产出倍数 " + timesFormat(rDirectMult()) + "<br>" +
						"更高层重置时，本层购入件只有在熔星里程碑 0 之后才留得住；本层升级一律清空。<br>" +
						"挑战「独断」进行中时，本层的全部自动化都会停摆。"
				}],
				["blank", "10px"],
				["bar", "conversion"],
			],
		},
	},

	componentStyles: {
		"prestige-button"() { return { "width": "260px", "height": "86px" } },
		"buyable"() { return { "height": "180px", "width": "200px" } },
	},
})
