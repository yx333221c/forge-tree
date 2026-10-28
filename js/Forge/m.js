// ============================================================================
// 《熔炉之树 · The Forge Tree》 —— row 1：锻造（Mill）
// 实现契约：DESIGN.md §5.2（配合 §3.2 钩子名、§3.5 引擎语义、§4 保留规则）
// 货币：锭条 Ingots（base 资源 = 熔炉炉芯 player.h.points）
//
// 约定：
//   * 跨层加成一律通过 registerHook 注册（钩子名见 §3.2），绝不直接改写别的层的数据。
//   * 唯一例外（§4）：milestone 2「废钢回炉」在 onPrestige 里写 player.h.reserveCore，
//     由 h 层读取。h 层 startData 已有该字段（默认 decimalZero），即使缺失，直接赋值也不报错。
//   * 纯读函数（unlocked / canAfford / effect / cost / display / gainMult / gainExp）无副作用。
//   * 加载期（addLayer 的对象字面量求值时）不调用 format / 不读 player / 不调 hasUpgrade：
//     所有需要格式化的文案一律写成函数形式，在 tmp 更新时才执行。
//   * 数值进入 player 一律 Decimal，开关一律 boolean。
// ============================================================================

// ---------------- 可调数值（集中在这里，勿散落在公式里） ----------------
var M_BAL = {
	requires: 50,					// 炉芯 → 锭条 的门槛，同时是解锁本层的需求（加载期用 new Decimal 包装）
	baseExp: 0.5,					// 锭条公式基础指数（§3.5：exponent 字段设 1，指数全由 gainExp 给）
	expFloor: 0.05,					// 指数下限（NaN / 变向防护）
	heatExp: 0.4,					// 先天：锭条给热量的指数
	coreExp: 0.25,					// 先天：锭条给炉芯产出的指数
	softcap: "1e15",				// 锭条产出软上限
	softcapPower: 0.5,
	autoForgeGen: 0.5,				// milestone 0「自动锻造」：每次锻造产出的 50% 每秒自动发放
	reserveCore: 0.5,				// milestone 2：锻造时保留的炉芯比例
	shiftBatch: 10,					// 按住 Shift 一次购买的数量
	hydroPassive: 0.5,				// 31 水力锻机：熔炉 passiveGeneration 加成
	guildDiv: 40,					// 32 行会盟约：泄压次数除数
	guildExp: 0.5,					// 32 行会盟约：指数
	ventMult: 3,					// 12 淬火槽：泄压收益倍数
	pressureRateMult: 1.5,			// 13 配重锤：炉压增速倍数
	expBonus: 0.05,					// 23 辊压机：锭条公式指数加成
	coreMult: { 11: 3, 21: 5 },		// 11 锻锤 / 21 连续轧制：炉芯产出倍数
	heatMult: { 14: 10, 24: 100 },	// 14 合金模 / 24 匠魂：热量倍数
	upgCost: { 11: 1, 12: 2, 13: 4, 14: 8, 21: 20, 22: 40, 23: 60, 24: 120, 31: 300, 32: 300 },
	milestones: [10, 100, 500, 2000],	// 累计锭条门槛
	buyables: {
		11: { base: 2, growth: 2.2, per: 1.5, limit: 40, name: "轧辊", unit: "根" },
		12: { base: 3, growth: 2.5, per: 2, limit: 30, name: "废料箱", unit: "只" },
	},
	buyLoopCap: 100,					// 单次批量购买最多循环几次（上限远小于成本可达值，纯保险）
	sellLoopCap: 200,					// 卖出全部最多循环几次
	costCap: "1e30000",					// 成本上限（防止极端数值污染比较）
}

// ---------------- 只读小工具（纯函数，无副作用） ----------------
function mNum(x) { // Decimal | number -> Decimal，坏值归零
	if (x instanceof Decimal) return x.isNan() ? decimalZero : x
	if (typeof x === "number") return isFinite(x) ? new Decimal(x) : decimalZero
	return decimalZero
}
function mLayers(id) { return (typeof layers !== "undefined" && layers && layers[id]) ? layers[id] : null }
function mPoints() { return (typeof player !== "undefined" && player && player.m) ? mNum(player.m.points) : decimalZero }
function mTotal() { return (typeof player !== "undefined" && player && player.m) ? mNum(player.m.total) : decimalZero }
function mBest() { return (typeof player !== "undefined" && player && player.m) ? mNum(player.m.best) : decimalZero }
function mBase() { return (typeof player !== "undefined" && player && player.h) ? mNum(player.h.points) : decimalZero }
function mVents() { return (typeof player !== "undefined" && player && player.h) ? mNum(player.h.vents) : decimalZero }
function mAmt(id) {
	if (typeof player === "undefined" || !player || !player.m || !player.m.buyables) return decimalZero
	return mNum(player.m.buyables[id])
}
function mLimit(id) {
	let b = mLayers("m")
	if (b && b.buyables && b.buyables[id] && b.buyables[id].purchaseLimit !== undefined) {
		return mNum(b.buyables[id].purchaseLimit)
	}
	return new Decimal((M_BAL.buyables[id] || {}).limit || 0)
}
function mUpg(layer, id) { try { return !!hasUpgrade(layer, id) } catch (e) { return false } }
function mMs(layer, id) { try { return !!hasMilestone(layer, id) } catch (e) { return false } }
function mUnlocked() { return (typeof player !== "undefined" && player && player.m) ? !!player.m.unlocked : false }
function mHUnlock() { return (typeof player !== "undefined" && player && player.h) ? !!player.h.unlocked : false }
function mFlag(name) { return (typeof player !== "undefined" && player && player.m) ? !!player.m[name] : false }
function mFlagText(name, on) { return "「" + on + "」：" + (mFlag(name) ? "<b>已开启</b>" : "未开启") }

// 乘法夹取：拒绝 NaN / Infinity / 非正数
function mClampMult(v) {
	let d = mNum(v)
	if (d.lte(0) || !d.isFinite()) return decimalOne
	return d
}
// 指数夹取：拒绝 NaN / Infinity，并给一个正下限（引擎里 gainExp 为 0 会直接产出 0）
function mClampExp(v) {
	let d = mNum(v)
	if (!d.isFinite() || d.lt(M_BAL.expFloor)) return new Decimal(M_BAL.expFloor)
	return d
}
// 效果倍数上限夹取：数值过界时不至于把整条链变成 Infinity
function mCapEff(d) {
	if (!d.isFinite()) return new Decimal(M_BAL.costCap)
	return d
}

// ---------------- 本层公式的组成部分（集中定义，display 与 gain* 共用） ----------------
function mIngotExp() {
	let e
	try { e = new Decimal(M_BAL.baseExp).add(foldAdd("ingotExpBonus", 0)) } catch (err) { e = new Decimal(M_BAL.baseExp) }
	return mClampExp(e)
}
function mIngotMult() {
	let m
	try { m = foldMult("ingotGain", 1) } catch (err) { m = decimalOne }
	return mClampMult(m)
}
// 先天效果（锭条 → 下游）
function mEffHeat() { return mCapEff(decimalOne.add(mPoints()).pow(new Decimal(M_BAL.heatExp))) }
function mEffCore() { return mCapEff(decimalOne.add(mPoints()).pow(new Decimal(M_BAL.coreExp))) }
// 升级贡献
function mUpgCoreMult() {
	let v = decimalOne
	if (mUpg("m", 11)) v = v.times(new Decimal(M_BAL.coreMult[11]))
	if (mUpg("m", 21)) v = v.times(new Decimal(M_BAL.coreMult[21]))
	return v
}
function mUpgHeatMult() {
	let v = decimalOne
	if (mUpg("m", 14)) v = v.times(new Decimal(M_BAL.heatMult[14]))
	if (mUpg("m", 24)) v = v.times(new Decimal(M_BAL.heatMult[24]))
	return v
}
function mUpgGuildMult() {
	if (!mUpg("m", 32)) return decimalOne
	return mCapEff(decimalOne.add(mVents().div(new Decimal(M_BAL.guildDiv)).max(0)).pow(new Decimal(M_BAL.guildExp)))
}
function mUpgVentMult() { return mUpg("m", 12) ? new Decimal(M_BAL.ventMult) : decimalOne }
function mUpgPressureMult() { return mUpg("m", 13) ? new Decimal(M_BAL.pressureRateMult) : decimalOne }
function mUpgExpBonus() { return mUpg("m", 23) ? new Decimal(M_BAL.expBonus) : decimalZero }
function mUpgHPassive() { return mUpg("m", 31) ? new Decimal(M_BAL.hydroPassive) : decimalZero }

// ---------------- 购入件：成本 / 效果 / 买卖 ----------------
function mBuySpec(id) { return M_BAL.buyables[id] || M_BAL.buyables[11] }
function mCostFinal(x) {
	let raw = mNum(x)
	let v = raw
	try { v = mNum(buyableCostFinal(raw)) } catch (e) { v = raw }
	if (!v.isFinite() || v.lte(0)) v = raw
	return v.max(decimalOne).ceil()	// 锭条是整数货币：成本向上取整，判定与显示一致
}
function mBuyCost(id, x) {
	let b = mBuySpec(id)
	let n = mNum(x).max(0)
	let cost = new Decimal(b.base).times(Decimal.pow(new Decimal(b.growth), n))
	if (!cost.isFinite() || cost.gt(M_BAL.costCap)) return new Decimal(M_BAL.costCap)
	return mCostFinal(cost)
}
function mBuyEffect(id, x) { // 已含挑战「贫瘠」的减半（buyableDebuff）
	let b = mBuySpec(id)
	let n = mNum(x).max(0)
	let e = Decimal.pow(new Decimal(b.per), n)
	if (!e.isFinite()) return new Decimal(M_BAL.costCap)
	let d
	try { d = mNum(buyableDebuff(e)) } catch (err) { d = e }
	if (d.lte(0) || !d.isFinite()) return decimalOne
	return d
}
// 买 n 个（自动尊重 purchaseLimit 与余额），返回实际买到几个
function mBuyAmount(id, count) {
	if (typeof player === "undefined" || !player || !player.m || !player.m.buyables) return decimalZero
	let limit = mLimit(id)
	let amount = mAmt(id)
	if (amount.gte(limit)) return decimalZero
	let pts = mNum(player.m.points)
	let spent = mNum(player.m.spentOnBuyables)
	let want = Math.floor(mNum(count).toNumber())
	if (!isFinite(want) || want < 1) want = 1
	if (want > M_BAL.buyLoopCap) want = M_BAL.buyLoopCap
	let bought = decimalZero
	for (let i = 0; i < want; i++) {
		if (amount.add(bought).gte(limit)) break
		let c = mBuyCost(id, amount.add(bought))
		if (pts.lt(c)) break
		pts = pts.sub(c)
		spent = spent.add(c)
		bought = bought.add(1)
	}
	if (bought.gt(0)) {
		addBuyables("m", id, bought)
		player.m.points = pts
		player.m.spentOnBuyables = spent
	}
	return bought
}
function mBuyMax(id) {
	let limit = mLimit(id)
	mBuyAmount(id, limit.add(1))
}
function mSellOne(id) {
	if (typeof player === "undefined" || !player || !player.m || !player.m.buyables) return
	let amt = mAmt(id)
	if (amt.lte(0)) return
	let refund = mBuyCost(id, amt.sub(1))
	setBuyableAmount("m", id, amt.sub(1))
	player.m.points = mNum(player.m.points).add(refund)
	player.m.spentOnBuyables = mNum(player.m.spentOnBuyables).sub(refund).max(decimalZero)
}
function mSellAll(id) {
	let n = Math.min(Math.floor(mAmt(id).toNumber()), M_BAL.sellLoopCap)
	for (let i = 0; i < n; i++) mSellOne(id)
}
function mResetBuyables() {
	let ids = Object.keys(M_BAL.buyables)
	for (let i = 0; i < ids.length; i++) setBuyableAmount("m", ids[i], decimalZero)
}
// 供 tab 上「全部加注」按钮调用（全局函数，只在点击时执行）
function mFillAll() {
	let ids = Object.keys(M_BAL.buyables)
	for (let i = 0; i < ids.length; i++) { try { mBuyMax(ids[i]) } catch (e) { console.error(e) } }
}

// ---------------- 显示辅助（全部是运行期函数） ----------------
function mGoalText(idx) {
	let req = new Decimal(M_BAL.milestones[idx])
	return fmtTarget(mTotal(), req, "锭条")
}
function mNextMilestoneGoal() {
	for (let i = 0; i < M_BAL.milestones.length; i++) {
		if (!mMs("m", i)) return new Decimal(M_BAL.milestones[i])
	}
	return null
}
function mUpgradeRowOpen(row) {
	if (row === 1) return true
	if (row === 2) return mUpg("m", 11) && mUpg("m", 12) && mUpg("m", 13) && mUpg("m", 14)
	if (row === 3) return mUpg("m", 21) && mUpg("m", 22) && mUpg("m", 23) && mUpg("m", 24)
	return false
}
function mUpgCost(id) {
	let base = new Decimal(M_BAL.upgCost[id] || 1)
	let v = base
	try { v = mNum(upgradeCostFinal(base)) } catch (e) { v = base }
	if (!v.isFinite() || v.lte(0)) v = base
	return v.max(decimalOne).ceil()
}
function mRouteText() {
	if (mUpg("m", 31)) return "<b>水力锻机</b>（熔炉自动产出 +" + format(mUpgHPassive()) + "）"
	if (mUpg("m", 32)) return "<b>行会盟约</b>（热量随泄压次数增长，当前 " + timesFormat(mUpgGuildMult()) + "）"
	return "尚未选择（第 3 行二选一）"
}
function mStatusText() {
	let exp = mIngotExp()
	let mult = mIngotMult()
	let req = new Decimal(M_BAL.requires)
	let lines = []
	lines.push("<h3>锻台读数</h3>")
	lines.push("炉芯 <b>" + formatWhole(mBase()) + "</b> ／ 门槛 " + formatWhole(req) +
		(player.m ? "（" + (mBase().gte(req) ? "<b>可锻造</b>" : "还差 " + formatWhole(req.minus(mBase()))) + "）" : "") + "<br>")
	lines.push("锭条 <b>" + formatWhole(mPoints()) + "</b>　累计 " + formatWhole(mTotal()) + "　最高 " + formatWhole(mBest()) + "<br>")
	lines.push("公式：锭条 = （炉芯 ÷ " + formatWhole(req) + "）^" + format(exp) + " × " + format(mult) + "<br>")
	lines.push("指数加成 ingotExpBonus：" + format(exp.minus(new Decimal(M_BAL.baseExp))) + "　产出乘数 ingotGain：" + timesFormat(mult) + "<br>")
	lines.push("<b>先天：</b>热量 " + timesFormat(mEffHeat()) + "，炉芯产出 " + timesFormat(mEffCore()) + "<br>")
	lines.push("<b>购入件：</b>轧辊 " + formatWhole(mAmt("11")) + "/" + formatWhole(mLimit("11")) +
		"（" + timesFormat(mBuyEffect("11", mAmt("11"))) + " 锭条）　废料箱 " + formatWhole(mAmt("12")) + "/" + formatWhole(mLimit("12")) +
		"（" + timesFormat(mBuyEffect("12", mAmt("12"))) + " 热量）<br>")
	let goal = mNextMilestoneGoal()
	lines.push(goal ? ("下一个里程碑：" + fmtTarget(mTotal(), goal, "累计锭条")) : "里程碑全部达成")
	lines.push("<br><b>互斥路线：</b>" + mRouteText())
	lines.push("<br>" + mFlagText("autoForge", "自动锻造") + "　" + mFlagText("autoBuy", "自动购买升级") + "　" + mFlagText("autoFill", "自动加注") + "<br>")
	lines.push("自动锻造速率：" + format(tmp && tmp.m && tmp.m.passiveGeneration !== undefined ? mNum(tmp.m.passiveGeneration) : decimalZero) + " 锭条/秒")
	return lines.join("")
}

// ---------------- 钩子注册（加载期调用 registerHook，函数体在运行期执行） ----------------
function mRegister(name, fn) {
	try {
		registerHook(name, fn)
	} catch (e) {
		console.error("Forge[m] hook register failed: " + name, e)
	}
}
function mHookHeatInnate() { return mEffHeat() }
function mHookHeatUpg() { return mUpgHeatMult().times(mUpgGuildMult()) }
function mHookHeatBuy() { return mBuyEffect("12", mAmt("12")) }
function mHookCoreInnate() { return mEffCore() }
function mHookCoreUpg() { return mUpgCoreMult() }
function mHookIngotBuy() { return mBuyEffect("11", mAmt("11")) }
function mHookIngotExpBonus() { return mUpgExpBonus() }
function mHookVentValue() { return mUpgVentValue() }
function mHookPressureRate() { return mUpgPressureMult() }
function mHookHPassiveAdd() { return mUpgHPassive() }

mRegister("heat", mHookHeatInnate)
mRegister("heat", mHookHeatUpg)
mRegister("heat", mHookHeatBuy)
mRegister("coreGain", mHookCoreInnate)
mRegister("coreGain", mHookCoreUpg)
mRegister("ingotGain", mHookIngotBuy)
mRegister("ingotExpBonus", mHookIngotExpBonus)
mRegister("ventValue", mHookVentValue)
mRegister("pressureRate", mHookPressureRate)
mRegister("hPassiveAdd", mHookHPassiveAdd)

// ---------------- 保留规则（§4 表格：由更高层的重置触发） ----------------
// 锻造升级的保留：r 升级 21（反应再生）或 t 升级 12（时序模具）
function mKeepUpgrades(resettingLayer) {
	if (!resettingLayer || resettingLayer === "m") return false
	if (resettingLayer === "r") return mUpg("r", 21) || mUpg("t", 12)
	if (resettingLayer === "t" || resettingLayer === "x") return mUpg("t", 12)
	return false
}
// 锻造购入件（连同投入）的保留：r 升级 21 或 t 升级 22（循环锭模）
function mKeepBuyables(resettingLayer) {
	if (!resettingLayer || resettingLayer === "m") return false
	if (resettingLayer === "r") return mUpg("r", 21) || mUpg("t", 22)
	if (resettingLayer === "t" || resettingLayer === "x") return mUpg("t", 22)
	return false
}

// ============================================================================
addLayer("m", {
	name: "锻造",
	symbol: "M",
	color: "#4bdc13",
	row: 1,
	position: 0,

	resource: "锭条",
	baseResource: "炉芯",
	baseAmount() { return mBase() },

	type: "normal",
	exponent: 1,							// §3.5：指数完全由 gainExp 提供，此字段必须是 1
	requires: new Decimal(M_BAL.requires),
	softcap: new Decimal(M_BAL.softcap),
	softcapPower: new Decimal(M_BAL.softcapPower),

	gainMult() { return mIngotMult() },		// foldMult("ingotGain", 1) + 坏值夹取
	gainExp() { return mIngotExp() },		// 0.5 + foldAdd("ingotExpBonus", 0)
	directMult() { return decimalOne },

	startData() {
		return {
			unlocked: false,
			points: decimalZero,
			best: decimalZero,
			total: decimalZero,
			resets: decimalZero,
			spentOnBuyables: decimalZero,
			buyables: {},
			autoForge: false,		// milestone 0
			autoBuy: false,			// milestone 1
			autoFill: false,		// milestone 3
		}
	},

	layerShown() { return mUnlocked() || mHUnlock() },

	tooltip() {
		return "锭条：<b>" + formatWhole(mPoints()) + "</b>（累计 " + formatWhole(mTotal()) + "）<br>" +
			"热量 " + timesFormat(mEffHeat()) + "　炉芯产出 " + timesFormat(mEffCore()) + "<br>" +
			"指数 " + format(mIngotExp()) + "　乘数 " + timesFormat(mIngotMult()) + "<br>" +
			"轧辊 " + formatWhole(mAmt("11")) + " 根　废料箱 " + formatWhole(mAmt("12")) + " 只"
	},
	tooltipLocked() {
		let req = new Decimal(M_BAL.requires)
		let cur = mBase()
		return "需要 <b>" + formatWhole(req) + "</b> 炉芯（当前 " + formatWhole(cur) + "）<br>" +
			(cur.gte(req) ? "已达标：点击节点开锻台。" : "还差 " + formatWhole(req.minus(cur)) + " 炉芯。<br>炉芯来自熔炉（Hearth）的熔炼：攒够热量，再落锤。")
	},

	resetDescription: "把炉芯送上锻台，获得 ",
	hotkeys: [
		{
			key: "m",
			description: "M：锻造，用炉芯换锭条（会重置熔炉）",
			onPress() { if (canReset("m")) doReset("m") },
		},
		{
			key: "ctrl+m",
			description: "Ctrl+M：回炉重熔，全额返还锻造购入件",
			unlocked() { return mMs("m", 3) },
			onPress() { respecBuyables("m") },
		},
	],

	effect() {
		return {
			heat: mEffHeat(),
			core: mEffCore(),
		}
	},
	effectDescription() {
		let e = this.effect()
		return "正在把热量放大 " + timesFormat(e.heat) + "，炉芯产出放大 " + timesFormat(e.core) +
			"（锭条越多越强，指数 " + new Decimal(M_BAL.heatExp) + " / " + new Decimal(M_BAL.coreExp) + "）"
	},

	onPrestige() {
		// §4 的唯一例外：把「保留多少炉芯」交给 h 层读取
		let keep = mMs("m", 2) ? new Decimal(M_BAL.reserveCore) : decimalZero
		if (typeof player !== "undefined" && player && player.h) {
			player.h.reserveCore = keep
		}
		if (typeof player !== "undefined" && player && player.m) {
			player.m.resets = mNum(player.m.resets).add(1)
		}
	},

	doReset(resettingLayer) {
		let keep = []
		if (mKeepUpgrades(resettingLayer)) keep.push("upgrades")
		if (mKeepBuyables(resettingLayer)) { keep.push("buyables"); keep.push("spentOnBuyables") }
		forgeDoReset(this.layer, resettingLayer, keep)
	},

	// 自动锻造（milestone 0）+ 别的高层通过 millPassiveAdd 给的加成
	passiveGeneration() {
		let extra = decimalZero
		try { extra = mNum(foldAdd("millPassiveAdd", 0)) } catch (e) { extra = decimalZero }
		if (!extra.isFinite() || extra.lt(0)) extra = decimalZero
		let auto = autoOn(mFlag("autoForge") && mMs("m", 0)) ? new Decimal(M_BAL.autoForgeGen) : decimalZero
		return auto.add(extra).toNumber()
	},
	autoUpgrade() { return autoOn(mFlag("autoBuy") && mMs("m", 1)) },
	automate() {
		if (!mUnlocked()) return
		if (!autoOn(mFlag("autoFill") && mMs("m", 3))) return
		let ids = Object.keys(M_BAL.buyables)
		for (let i = 0; i < ids.length; i++) { try { mBuyMax(ids[i]) } catch (e) { console.error(e) } }
	},

	// ---------------------------------------------------------------- 升级
	upgrades: {
		11: {
			title: "锻锤",
			description: "炉芯产出 ×3。<br><i>影响熔炉（Hearth）层的产芯。</i>",
			cost() { return mUpgCost(11) },
			unlocked() { return mUpgradeRowOpen(1) },
			branches: [21],
			effect() { return new Decimal(M_BAL.coreMult[11]) },
			effectDisplay() { return "炉芯产出 " + timesFormat(mUpgCoreMult()) },
		},
		12: {
			title: "淬火槽",
			description: "泄压收益 ×3。<br><i>影响熔炉（Hearth）层的泄压（Vent）。</i>",
			cost() { return mUpgCost(12) },
			unlocked() { return mUpgradeRowOpen(1) },
			branches: [22],
			effect() { return mUpgVentMult() },
			effectDisplay() { return "泄压收益 " + timesFormat(mUpgVentMult()) },
		},
		13: {
			title: "配重锤",
			description: "炉压增速 ×1.5。<br><i>影响熔炉（Hearth）层的炉压积攒速度。</i>",
			cost() { return mUpgCost(13) },
			unlocked() { return mUpgradeRowOpen(1) },
			branches: [23],
			effect() { return new Decimal(M_BAL.pressureRateMult) },
			effectDisplay() { return "炉压增速 " + timesFormat(mUpgPressureMult()) },
		},
		14: {
			title: "合金模",
			description: "热量 ×10。<br><i>影响全局热量/秒。</i>",
			cost() { return mUpgCost(14) },
			unlocked() { return mUpgradeRowOpen(1) },
			branches: [24],
			effect() { return new Decimal(M_BAL.heatMult[14]) },
			effectDisplay() { return "热量 " + timesFormat(mUpgHeatMult()) },
		},
		21: {
			title: "连续轧制",
			description: "炉芯产出 ×5。<br><i>影响熔炉（Hearth）层的产芯。</i>",
			cost() { return mUpgCost(21) },
			unlocked() { return mUpgradeRowOpen(2) },
			effect() { return new Decimal(M_BAL.coreMult[21]) },
			effectDisplay() { return "炉芯产出 " + timesFormat(mUpgCoreMult()) },
		},
		22: {
			title: "废钢回炉·改",
			description: "锻造重置熔炉时，<b>保留熔炉的全部升级</b>。<br><i>影响熔炉（Hearth）层，由熔炉的重置规则读取。</i>",
			cost() { return mUpgCost(22) },
			unlocked() { return mUpgradeRowOpen(2) },
		},
		23: {
			title: "辊压机",
			description() {
				return "锭条公式指数 +" + M_BAL.expBonus + "。<br>当前指数：" + format(mIngotExp()) +
					"（基础 " + M_BAL.baseExp + " ＋ 加成 " + format(expBonusOf()) + "）"
			},
			cost() { return mUpgCost(23) },
			unlocked() { return mUpgradeRowOpen(2) },
			effect() { return mUpgExpBonus() },
			effectDisplay() { return "指数加成 +" + format(mUpgExpBonus()) },
		},
		24: {
			title: "匠魂",
			description: "热量 ×100。<br><i>影响全局热量/秒。</i>",
			cost() { return mUpgCost(24) },
			unlocked() { return mUpgradeRowOpen(2) },
			effect() { return new Decimal(M_BAL.heatMult[24]) },
			effectDisplay() { return "热量 " + timesFormat(mUpgHeatMult()) },
		},
		31: {
			title: "水力锻机",
			description: "熔炉自动产出 +0.5（每把炉子自己打芯）。<br><i>影响熔炉（Hearth）层的 passiveGeneration。</i><br><b>与「行会盟约」互斥，二选一。</b>",
			cost() { return mUpgCost(31) },
			unlocked() { return mUpgradeRowOpen(3) && !mUpg("m", 32) },
			effect() { return mUpgHPassive() },
			effectDisplay() { return "熔炉自动产出 +" + format(mUpgHPassive()) },
		},
		32: {
			title: "行会盟约",
			description() {
				return "热量按泄压次数增长：×（1 + 泄压 ÷ 40）^0.5。<br>" +
					"当前泄压 " + formatWhole(mVents()) + " 次 → " + timesFormat(mUpgGuildMult()) + " 热量。<br>" +
					"<i>影响全局热量/秒，读取熔炉（Hearth）的泄压次数。</i><br><b>与「水力锻机」互斥，二选一。</b>"
			},
			cost() { return mUpgCost(32) },
			unlocked() { return mUpgradeRowOpen(3) && !mUpg("m", 31) },
			effect() { return mUpgGuildMult() },
			effectDisplay() { return "热量 " + timesFormat(mUpgGuildMult()) },
		},
	},

	// ---------------------------------------------------------------- 里程碑
	milestones: {
		0: {
			requirementDescription() { return "累计 " + formatWhole(new Decimal(M_BAL.milestones[0])) + " 锭条<br>" + mGoalText(0) },
			done() { return mTotal().gte(new Decimal(M_BAL.milestones[0])) },
			effectDescription() { return "解锁<b>自动锻造</b>（每秒自动获得 " + new Decimal(M_BAL.autoForgeGen) + " 倍单次锻造产出）<br>" + mFlagText("autoForge", "自动锻造") },
			toggles: [["m", "autoForge"]],
		},
		1: {
			requirementDescription() { return "累计 " + formatWhole(new Decimal(M_BAL.milestones[1])) + " 锭条<br>" + mGoalText(1) },
			done() { return mTotal().gte(new Decimal(M_BAL.milestones[1])) },
			effectDescription() { return "解锁<b>自动购买锻造升级</b><br>" + mFlagText("autoBuy", "自动购买升级") },
			unlocked() { return mMs("m", 0) },
			toggles: [["m", "autoBuy"]],
		},
		2: {
			requirementDescription() { return "累计 " + formatWhole(new Decimal(M_BAL.milestones[2])) + " 锭条<br>" + mGoalText(2) },
			done() { return mTotal().gte(new Decimal(M_BAL.milestones[2])) },
			effectDescription() {
				return "<b>废钢回炉</b>：锻造时保留 " + formatWhole(new Decimal(M_BAL.reserveCore).times(100)) + "% 的最好一轮炉芯<br>" +
					"（熔炉读取的比例：当前 " + format(player && player.h ? mNum(player.h.reserveCore) : decimalZero) + "）"
			},
			unlocked() { return mMs("m", 1) },
			tooltip: "本层 onPrestige 写入 player.h.reserveCore，由熔炉的重置规则使用。",
		},
		3: {
			requirementDescription() { return "累计 " + formatWhole(new Decimal(M_BAL.milestones[3])) + " 锭条<br>" + mGoalText(3) },
			done() { return mTotal().gte(new Decimal(M_BAL.milestones[3])) },
			effectDescription() { return "解锁<b>自动加注轧辊 / 废料箱</b>（Ctrl+M 回炉重熔）<br>" + mFlagText("autoFill", "自动加注") },
			unlocked() { return mMs("m", 2) },
			toggles: [["m", "autoFill"]],
		},
	},

	// ---------------------------------------------------------------- 购入件
	buyables: {
		showRespec: true,
		respecText: "回炉重熔",
		respecMessage: "确定要把所有锻造购入件全部熔回锭条吗？投入的锭条一分不少地回到你手上。",
		respec() {
			player.m.points = mNum(player.m.points).add(mNum(player.m.spentOnBuyables))
			player.m.spentOnBuyables = decimalZero
			mResetBuyables()
		},
		11: {
			title() { return "轧辊　" + formatWhole(mAmt("11")) + " / " + formatWhole(mLimit("11")) },
			cost(x) { return mBuyCost("11", mNum(x)) },
			effect(x) { return mBuyEffect("11", mNum(x)) },
			unlocked() { return mUnlocked() },
			canAfford() { return mPoints().gte(mBuyCost("11", mAmt("11"))) },
			buy() { mBuyAmount("11", shiftDown ? new Decimal(M_BAL.shiftBatch) : decimalOne) },
			buyMax() { mBuyMax("11") },
			sellOne() { mSellOne("11") },
			sellAll() { mSellAll("11") },
			canSellOne() { return mAmt("11").gt(0) },
			canSellAll() { return mAmt("11").gt(0) },
			purchaseLimit: new Decimal(M_BAL.buyables[11].limit),
			tooltip() { return "每根给锭条产出 ×" + M_BAL.buyables[11].per + "。按住 Shift 一次买 " + M_BAL.shiftBatch + " 根；卖出按最后一根的成本折还。" },
			display() {
				let b = mBuySpec("11")
				let amt = mAmt("11")
				return "每根：锭条产出 ×" + format(new Decimal(b.per)) + "<br>" +
					"当前：" + timesFormat(mBuyEffect("11", amt)) + "<br>" +
					"下一根成本：" + formatWhole(mBuyCost("11", amt)) + " 锭条（持有 " + formatWhole(mPoints()) + "）<br>" +
					fmtTarget(amt, mLimit("11"), "根")
			},
		},
		12: {
			title() { return "废料箱　" + formatWhole(mAmt("12")) + " / " + formatWhole(mLimit("12")) },
			cost(x) { return mBuyCost("12", mNum(x)) },
			effect(x) { return mBuyEffect("12", mNum(x)) },
			unlocked() { return mUnlocked() },
			canAfford() { return mPoints().gte(mBuyCost("12", mAmt("12"))) },
			buy() { mBuyAmount("12", shiftDown ? new Decimal(M_BAL.shiftBatch) : decimalOne) },
			buyMax() { mBuyMax("12") },
			sellOne() { mSellOne("12") },
			sellAll() { mSellAll("12") },
			canSellOne() { return mAmt("12").gt(0) },
			canSellAll() { return mAmt("12").gt(0) },
			purchaseLimit: new Decimal(M_BAL.buyables[12].limit),
			tooltip() { return "每只给热量 ×" + M_BAL.buyables[12].per + "。废料是第二次燃烧。按住 Shift 一次买 " + M_BAL.shiftBatch + " 只。" },
			display() {
				let b = mBuySpec("12")
				let amt = mAmt("12")
				return "每只：热量 ×" + format(new Decimal(b.per)) + "<br>" +
					"当前：" + timesFormat(mBuyEffect("12", amt)) + "<br>" +
					"下一只成本：" + formatWhole(mBuyCost("12", amt)) + " 锭条（持有 " + formatWhole(mPoints()) + "）<br>" +
					fmtTarget(amt, mLimit("12"), "只")
			},
		},
	},

	// ---------------------------------------------------------------- 进度条
	bars: {
		forgeGauge: {
			direction: RIGHT,
			width: 420,
			height: 28,
			fillStyle: { "background-color": "#4bdc13" },
			baseStyle: { "background-color": "#1c2218" },
			textStyle: { "color": "#dff5cf", "text-shadow": "0px 0px 2px #000000" },
			borderStyle() { return { "border-width": "2px" } },
			progress() {
				let goal = mNextMilestoneGoal()
				if (goal === null) return 1
				let p = mTotal().div(goal.max(decimalOne)).toNumber()
				if (!isFinite(p) || p < 0) return 0
				return Math.min(1, p)
			},
			display() {
				let goal = mNextMilestoneGoal()
				if (goal === null) return "里程碑全部达成　累计锭条 " + formatWhole(mTotal())
				return "下一里程碑：" + formatWhole(mTotal()) + " / " + formatWhole(goal) + " 累计锭条"
			},
			unlocked() { return mUnlocked() },
		},
		hammerGauge: {
			direction: RIGHT,
			width: 420,
			height: 22,
			fillStyle: { "background-color": "#8fe36a" },
			baseStyle: { "background-color": "#182014" },
			textStyle: { "color": "#e8ffe0" },
			progress() {
				let p = mBase().div(new Decimal(M_BAL.requires).max(decimalOne)).toNumber()
				if (!isFinite(p) || p < 0) return 0
				return Math.min(1, p)
			},
			display() { return "锻台进料：" + formatWhole(mBase()) + " / " + formatWhole(new Decimal(M_BAL.requires)) + " 炉芯" },
			unlocked() { return mUnlocked() },
		},
	},

	// ---------------------------------------------------------------- 世界观
	infoboxes: {
		lore: {
			title: "炉边记事 · 锻",
			body() {
				return "火只给你形状，锤子才给你名字。<br>" +
					"炉芯是原料，锭条是成品。锻造不创造任何热量，它只是让热量学会排队。<br>" +
					"每一次落锤都在熔炉里记账：芯少了，炉膛空了，但锭条会一直替你说话。"
			},
			titleStyle: { "color": "#4bdc13" },
		},
		ledger: {
			title: "炉边记事 · 锻台账本",
			body() { return mStatusText() },
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
				["bar", "hammerGauge"],
				["bar", "forgeGauge"],
				["blank", "10px"],
				"milestones",
				["blank", "14px"],
				"upgrades",
				["blank", "14px"],
				["row", [
					["raw-html", function() { return "<button class='longUpg can' onclick='mFillAll()'>全部加注</button>" }],
					["blank", ["10px", "10px"]],
					["display-text", function() { return "按住 Shift 一次购买 " + M_BAL.shiftBatch + " 个；点「回炉重熔」全额返还投入。" }],
				]],
				"buyables",
			],
			glowColor: "#4bdc13",
		},
		"详情": {
			content: [
				["infobox", "lore"],
				["blank", "12px"],
				["infobox", "ledger"],
				["blank", "12px"],
				["display-text", function() { return mStatusText() }],
				"h-line",
				["display-text", function() {
					return "本层没有挑战。挑战在凝时（Tempo）层的沙漏里。<br>" +
						"回炉重熔会全额返还投入的锭条；更高层重置时，只有契约允许的升级与购入件能活下来" +
						"（反应「再生」或凝时「模具」）。<br>" +
						"当前保留炉芯比例：" + format(player && player.h ? mNum(player.h.reserveCore) : decimalZero)
				}],
				["blank", "10px"],
				["bar", "forgeGauge"],
			],
		},
	},

	componentStyles: {
		"prestige-button"() { return { "width": "260px", "height": "86px" } },
		"buyable"() { return { "height": "180px", "width": "200px" } },
	},
})

// 升级 23 描述里用的「全部指数加成」（含本层与其它层注册的钩子）
function expBonusOf() {
	let e = decimalZero
	try { e = mIngotExp().minus(new Decimal(M_BAL.baseExp)) } catch (err) { e = decimalZero }
	return e
}
