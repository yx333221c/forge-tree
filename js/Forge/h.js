// ============================================================
// row 0 · 熔炉 Hearth —— 一切开始的地方
// 核心机制：炉压（Pressure）与泄压（Vent）
//   炉压每秒稳定上升，给热量产出提供一个幂函数倍率；
//   「泄压」把积累的炉压瞬间兑换成一笔热量，但会清零倍率。
//   → 玩家永远在「等倍率成长」与「立刻兑现」之间取舍。
// 跨层加成一律通过 js/Forge/helpers.js 的钩子（DESIGN.md §3）。
// 纯读函数无副作用；只有 update/automate/doReset/onPrestige/buy/sell/respec 会写状态。
// ============================================================

var H_BAL = {
	// —— 熔炼公式 ——
	requires: 10,             // 多少热量换 1 炉芯
	baseExp: 0.5,             // 炉芯公式基础指数（exponent 字段固定 1，指数交给 gainExp）
	softcap: "1e50",          // 炉芯产出软上限
	softcapPower: 0.45,
	// —— 炉压 ——
	pressureRate: 3,          // 每秒炉压增量（基础）
	pressureExp: 0.35,        // 炉压倍率指数：heat ×(1+P)^exp
	pressureSoftMax: 500,     // 超过这个值，增速衰减（避免无限膨胀）
	// —— 泄压 ——
	ventSeconds: 15,          // 泄压 = 当前每秒热量 × 这么多秒
	ventCooldown: 2,          // 泄压冷却（秒）
	ventAutoPressure: 60,     // 自动泄压的炉压阈值
	ventAutoWait: 20,         // 自动泄压：只在「这笔钱能推进熔炼」时动手
	emberPerReset: 0.02,      // 余烬耙：每次熔炼的泄压加成
	emberCap: 10,
	// —— 燃料棒 ——
	rodBase: 5, rodCost1: 10, rodScale1: 4, limit1: 25,
	rodBase2: 3, rodCost2: 2, rodScale2: 3.2, limit2: 20,
	shiftBatch: 10,
	// —— 升级成本（炉芯）——
	upg: { 11: 1, 12: 3, 13: 8, 14: 20, 21: 45, 22: 90, 23: 180, 24: 400, 31: 1000, 32: 2500 },
	// —— 效果数值 ——
	heat11: 10, core14: 2, exp13: 0.05, exp22: 0.03, vent22: 2.5,
	core24: 3, heat24: 1000, chainPerAch: 2, chainAchCap: 25,
	pressureRate12: 1.5, pressureRate32: 1.25, vent32: 0.5, exp31: 0.05, core31: 0.5,
	// —— 里程碑阈值 ——
	msCore1: 1e3, msCore2: 1e6,
	// —— 先天效果指数 ——
	effHeatExp: 0.4, effCoreExp: 0.2, effPressureExp: 0.1,
}

// ---------- 内部计算（纯读） ----------
function hPressureExp() {
	return D(H_BAL.pressureExp).add(foldAdd("pressureExp", 0))
}

function hCoreExpBonus() {
	let b = foldAdd("coreExpBonus", 0)
	if (hasUpgrade("h", 13)) b = b.add(H_BAL.exp13)
	if (hasUpgrade("h", 22)) b = b.add(H_BAL.exp22)
	if (hasUpgrade("h", 31)) b = b.add(H_BAL.exp31)
	return b
}

function hCoreExp() {
	return D(H_BAL.baseExp).add(hCoreExpBonus())
}

// 炉芯对炉压增速的先天加成（独立函数，避免 effect() 递归调用自身）
function hPressureMultBase() {
	return D(player.h.points).add(1).pow(D(H_BAL.effPressureExp).add(foldAdd("coreEffectExp", 0)))
}

function hPressureRate() {
	let rate = D(H_BAL.pressureRate).times(foldMult("pressureRate", 1))
	if (hasUpgrade("h", 12)) rate = rate.times(H_BAL.pressureRate12)
	if (hasUpgrade("h", 32)) rate = rate.times(H_BAL.pressureRate32)
	return rate.times(hPressureMultBase())
}

function hVentValue() {
	let v = foldMult("ventValue", 1)
	if (hasUpgrade("h", 22)) v = v.times(H_BAL.vent22)
	if (hasUpgrade("h", 32)) v = v.times(H_BAL.vent32)
	return v
}

function hEmberBonus() {
	if (!hasUpgrade("h", 23)) return decimalZero
	return D(player.h.resets).times(H_BAL.emberPerReset).min(H_BAL.emberCap)
}

function hCoreMult() {
	return D(player.h.points).add(1).pow(D(H_BAL.effCoreExp).add(foldAdd("coreEffectExp", 0)))
}

function hHeatMultFromCore() {
	return D(player.h.points).add(1).pow(D(H_BAL.effHeatExp).add(foldAdd("heatCoreExp", 0)))
}

function hPressureHeatMult() {
	if (inTime(12)) return decimalOne
	return D(1).plus(player.h.pressure).pow(hPressureExp())
}

function hUpgHeat() {
	let mult = decimalOne
	if (hasUpgrade("h", 11)) mult = mult.times(H_BAL.heat11)
	if (hasUpgrade("h", 21)) mult = mult.times(D(H_BAL.chainPerAch).pow(Math.min(achievementCount(), H_BAL.chainAchCap)))
	if (hasUpgrade("h", 24)) mult = mult.times(H_BAL.heat24)
	return mult
}

// 熔炉自身贡献给热量的全部倍率（一个钩子搞定）
// 注意：t14「迟缓」/ t16「归零」的全局热量削弱由 t.js 注册 heat 钩子负责；
// 本层只管 t11（炉芯加成失效）与 t12（炉压失效）这两个熔炉自身机制。
function hHeatContrib() {
	let mult = decimalOne
	mult = mult.times(hPressureHeatMult())
	mult = mult.times(hUpgHeat())
	mult = mult.times(hHeatMultFromCore())
	mult = mult.times(buyableEffect("h", 11).heat)
	return mult
}

function hCoreGainMult() {
	if (inTime(11)) return decimalOne
	let mult = foldMult("coreGain", 1)
	if (hasUpgrade("h", 14)) mult = mult.times(H_BAL.core14)
	if (hasUpgrade("h", 24)) mult = mult.times(H_BAL.core24)
	if (hasUpgrade("h", 31)) mult = mult.times(H_BAL.core31)
	mult = mult.times(buyableEffect("h", 12).core)
	return mult
}

function hAutoPressure() {
	return D(H_BAL.ventAutoPressure).times(hasUpgrade("h", 32) ? 2 : 1)
}

function canVent() {
	return player.h.unlocked && player.h.ventCd.lte(0) && player.h.pressure.gt(0)
}

function forgeVentGain() {
	return D(tmp.pointGen).times(H_BAL.ventSeconds).times(hVentValue()).times(D(1).add(hEmberBonus()))
}

function forgeVent() {
	if (!canVent()) return decimalZero
	let gain = forgeVentGain()
	player.points = player.points.add(gain)
	player.h.pressure = decimalZero
	player.h.ventCd = D(H_BAL.ventCooldown)
	player.h.vents = D(player.h.vents).add(1)
	return gain
}

addLayer("h", {
	name: "熔炉",
	symbol: "H",
	position: 1,
	color: "#ff7a18",
	row: 0,
	resource: "炉芯",
	baseResource: "热量",
	resetDescription: "熔炼，获得 ",

	startData() {
		return {
			unlocked: true,
			points: decimalZero,
			best: decimalZero,
			total: decimalZero,
			resets: decimalZero,
			vents: decimalZero,
			pressure: decimalZero,
			ventCd: decimalZero,
			reserveCore: decimalZero,   // 由 m 里程碑 2 写入：熔炼后保留炉芯的比例
			autoVent: false,            // 里程碑 0
			autoBuy: false,             // 里程碑 1
			autoFill: false,            // 里程碑 3
		}
	},

	type: "normal",
	exponent: 1,
	baseAmount() { return player.points },
	requires: D(H_BAL.requires),
	softcap: D(H_BAL.softcap),
	softcapPower: D(H_BAL.softcapPower),

	gainExp() { return hCoreExp() },
	gainMult() { return hCoreGainMult() },
	directMult() { return decimalOne },

	passiveGeneration() { return foldAdd("hPassiveAdd", 0).toNumber() },

	// ---------- 本层货币的先天效果 ----------
	effect() {
		return {
			heatMult: hHeatMultFromCore(),
			coreMult: hCoreMult(),
			pressureMult: hPressureMultBase(),
		}
	},
	effectDescription() {
		let eff = tmp.h.effect
		return "正在将热量放大 " + timesFormat(eff.heatMult) +
			"，炉芯产出 " + timesFormat(eff.coreMult) +
			"，炉压增速 " + timesFormat(eff.pressureMult)
	},

	// ---------- 每 tick ----------
	update(diff) {
		// 历史峰值产出（供顶栏与统计层读取）
		if (tmp.pointGen instanceof Decimal && tmp.pointGen.gt(player.forgePeak)) player.forgePeak = tmp.pointGen

		let d = D(diff)
		let rate = hPressureRate()
		if (player.h.pressure.gt(H_BAL.pressureSoftMax)) {
			let over = player.h.pressure.minus(H_BAL.pressureSoftMax)
			rate = rate.div(over.plus(1).pow(0.5))
		}
		player.h.pressure = player.h.pressure.add(rate.times(d))

		if (player.h.ventCd.gt(0)) player.h.ventCd = player.h.ventCd.minus(d).max(0)

		// 自动泄压：攒够阈值、且这笔钱确实能推进熔炼时才动手（不抢玩家手感）
		if (autoOn(player.h.autoVent)) {
			let target = D(H_BAL.ventAutoWait).times(tmp.pointGen)
			if (player.h.ventCd.lte(0) && player.h.pressure.gte(hAutoPressure()) &&
				player.h.points.add(target).gte(tmp.h.nextAt)) {
				forgeVent()
			}
		}
	},

	automate() {
		if (autoOn(player.h.autoBuy)) {
			for (let id in layers.h.upgrades) {
				if (!isNaN(id) && canAffordUpgrade("h", id) && !hasUpgrade("h", id)) buyUpg("h", id)
			}
		}
		if (autoOn(player.h.autoFill)) {
			for (let id in layers.h.buyables) {
				if (!isNaN(id)) buyMaxBuyable("h", id)
			}
		}
	},

	// ---------- 重置规则（DESIGN.md §4）----------
	doReset(resettingLayer) {
		// 自身熔炼：热量由引擎清零；炉芯是本层货币不清零；只释放炉压
		if (resettingLayer === "h") {
			player.h.pressure = decimalZero
			player.h.ventCd = decimalZero
			return
		}

		// 被更高层重置：先记住最好一轮炉芯，再按保留规则清理
		let best = D(player.h.best)
		let ratio = D(player.h.reserveCore)
		let keep = ["vents", "reserveCore", "pressure", "ventCd"]
		if (hasUpgrade("m", 22) || hasUpgrade("t", 11)) keep.push("upgrades")
		if (hasUpgrade("t", 11) || hasMilestone("h", 3) || hasUpgrade("r", 21) || hasMilestone("x", 0)) {
			keep.push("buyables", "spentOnBuyables")
		}
		forgeDoReset("h", resettingLayer, keep)

		// 熔炉里程碑 3 + 锻冶「废料场」：留住最好一轮炉芯的一部分
		if (hasMilestone("h", 2) && ratio.gt(0)) {
			let kept = ratio.times(best)
			if (kept.gt(player.h.points)) {
				player.h.points = kept
				if (player.h.points.gt(player.h.best)) player.h.best = player.h.points
			}
		}
	},

	onPrestige() {
		player.h.resets = D(player.h.resets).add(1)
	},

	// ---------- 界面 ----------
	tabFormat: {
		"熔炉": {
			content: [
				"main-display",
				"resource-display",
				["blank", "6px"],
				["raw-html", function () { return forgePressureReport() }],
				["blank", "6px"],
				"prestige-button",
				["blank", "12px"],
				"milestones",
				["blank", "10px"],
				"upgrades",
				["blank", "10px"],
				"buyables",
			],
		},
		"技术": {
			unlocked() { return player.h.total.gt(0) },
			content: [
				["bar", "pressureBar"],
				["blank", "14px"],
				["raw-html", function () { return forgeTechReport() }],
				["blank", "12px"],
				["infobox", "lore"],
			],
		},
	},

	bars: {
		pressureBar: {
			fillStyle: { 'background-color': "#ff9a3c" },
			baseStyle: { 'background-color': "#2b1608" },
			textStyle: { 'color': '#ffe0c0' },
			borderStyle() { return { 'border-width': "2px" } },
			direction: RIGHT,
			width: 320,
			height: 30,
			unlocked: true,
			progress() {
				return D(player.h.pressure).add(1).log(10).div(D(1000).log(10)).min(1).toNumber()
			},
			display() {
				return "炉压 " + formatWhole(player.h.pressure) + "（热量 " + pct(hPressureHeatMult()) + "）"
			},
		},
	},

	infoboxes: {
		lore: {
			title: "炉边记事",
			body: "虚空冷得不肯发光。你唯一的热量来源，是这座不知道谁造的炉子。<br><br>" +
				"炉压是它的脾性：憋着，它烧得越旺；泄了，它给你一笔横财，然后重新沉默。<br>" +
				"熔炉不会累。你要学的是什么时候把手从阀门上拿开。",
			titleStyle: { 'color': "#ff7a18" },
		},
	},

	hotkeys: [
		{ key: "h", description: "H：熔炼炉膛（用热量换炉芯）", onPress() { if (canReset("h")) doReset("h") } },
		{ key: "v", description: "V：泄压（把炉压兑换成热量）", onPress() { if (canVent()) forgeVent() } },
	],

	layerShown() { return true },
	tooltip() {
		return "炉芯 " + formatWhole(player.h.points) + "　|　炉压 " + formatWhole(player.h.pressure) +
			"　|　热量 " + timesFormat(hHeatMultFromCore())
	},

	// ---------- 升级 ----------
	upgrades: {
		11: {
			title: "鼓风", description: "热量产出 ×" + String(H_BAL.heat11) + "。",
			cost: D(H_BAL.upg[11]),
			tooltip: "最便宜的一档：把等待时间直接砍到十分之一。",
		},
		12: {
			title: "双重阀门", description: "炉压增速 ×" + String(H_BAL.pressureRate12) + "。",
			cost: D(H_BAL.upg[12]),
			tooltip: "炉压来得越快，倍率与泄压都越早到位。",
		},
		13: {
			title: "深炉膛", description: "炉芯公式指数 +" + String(H_BAL.exp13) + "。",
			cost: D(H_BAL.upg[13]),
			tooltip: "指数是最贵也最值钱的强化。",
		},
		14: {
			title: "耐火砖", description: "炉芯产出 ×" + String(H_BAL.core14) + "。",
			cost: D(H_BAL.upg[14]),
		},
		21: {
			title: "连锁燃烧",
			description() {
				let n = Math.min(achievementCount(), H_BAL.chainAchCap)
				return "热量 ×" + format(D(H_BAL.chainPerAch).pow(n)) + "（按已点亮铭刻数，当前 " + n + " 个）"
			},
			cost: D(H_BAL.upg[21]),
			tooltip: "铭刻越多，这里越值钱；回头补铭刻也立刻生效。",
		},
		22: {
			title: "蓄热室",
			description: "泄压收益 ×" + String(H_BAL.vent22) + "，炉芯公式指数 +" + String(H_BAL.exp22) + "。",
			cost: D(H_BAL.upg[22]),
		},
		23: {
			title: "余烬耙",
			description() { return "泄压额外获得 " + pct(D(1).add(hEmberBonus())) + " 热量（按熔炼次数成长，当前 " + formatWhole(player.h.resets) + " 次）" },
			cost: D(H_BAL.upg[23]),
		},
		24: {
			title: "高炉本体",
			description: "热量 ×" + String(H_BAL.heat24) + "，炉芯产出 ×" + String(H_BAL.core24) + "。",
			cost: D(H_BAL.upg[24]),
		},
		31: {
			title: "熔芯铸造",
			description() { return "炉芯公式指数 +" + format(H_BAL.exp31) + "。<br><b>代价：</b>炉芯产出 ×" + format(H_BAL.core31) + "。与「压力回廊」互斥。" },
			cost: D(H_BAL.upg[31]),
			unlocked() { return !hasUpgrade("h", 32) },
		},
		32: {
			title: "压力回廊",
			description: "炉压增速 ×" + String(H_BAL.pressureRate32) + "，但泄压收益 ×" + String(H_BAL.vent32) + "。与「熔芯铸造」互斥。",
			cost: D(H_BAL.upg[32]),
			unlocked() { return !hasUpgrade("h", 31) },
		},
	},

	// ---------- 里程碑 ----------
	milestones: {
		0: {
			requirementDescription: "熔炼 1 次",
			done() { return player.h.resets.gte(1) },
			effectDescription: "解锁「自动泄压」。",
			toggles: [["h", "autoVent"]],
		},
		1: {
			requirementDescription: "熔炼 5 次",
			done() { return player.h.resets.gte(5) },
			effectDescription: "解锁「自动购买熔炉升级」。",
			toggles: [["h", "autoBuy"]],
		},
		2: {
			requirementDescription() { return "持有 " + formatWhole(D(H_BAL.msCore1)) + " 炉芯（当前 " + formatWhole(player.h.points) + "）" },
			done() { return player.h.points.gte(H_BAL.msCore1) },
			effectDescription() {
				if (!hasMilestone("m", 2)) {
					return "熔炼后保留炉芯——还需锻冶里程碑「废料场」决定比例（当前 " + format(D(player.h.reserveCore).times(100)) + "%）"
				}
				return "熔炼后保留 " + format(D(player.h.reserveCore).times(100)) + "% 的最好一轮炉芯"
			},
			tooltip: "这是熔炉与锻冶的联动：先去点亮锻冶的「废料场」。",
		},
		3: {
			requirementDescription() { return "持有 " + formatWhole(D(H_BAL.msCore2)) + " 炉芯（当前 " + formatWhole(player.h.points) + "）" },
			done() { return player.h.points.gte(H_BAL.msCore2) },
			effectDescription: "解锁「自动补充燃料棒」。",
			toggles: [["h", "autoFill"]],
		},
	},

	// ---------- 燃料棒 ----------
	buyables: {
		respecText: "拆除燃料棒",
		respecMessage: "确定要拆掉所有燃料棒吗？这会重置熔炉。",
		respec() {
			player.h.points = player.h.points.add(player.h.spentOnBuyables)
			for (let id in layers.h.buyables) {
				if (!isNaN(id)) setBuyableAmount("h", id, decimalZero)
			}
			player.h.spentOnBuyables = decimalZero
			doReset("h", true)
		},

		11: {
			title: "石墨棒",
			display() {
				let data = tmp.h.buyables[11]
				return "每根使热量 ×" + format(H_BAL.rodBase) +
					"\n已有：" + formatWhole(getBuyableAmount("h", 11)) + "/" + formatWhole(this.purchaseLimit) +
					"\n花费：" + format(data.cost) + " 炉芯" +
					"\n当前：热量 ×" + format(data.effect.heat)
			},
			cost(x) {
				return D(H_BAL.rodCost1).times(D(H_BAL.rodScale1).pow(D(x).add(1))).times(buyableCostFinal(1))
			},
			effect(x) { return { heat: buyableDebuff(D(H_BAL.rodBase).pow(D(x))) } },
			canAfford() { return player.h.points.gte(tmp.h.buyables[11].cost) },
			buy() { forgeBuyRod(11, H_BAL.rodCost1, H_BAL.rodScale1) },
			buyMax() { forgeBuyRodMax(11, H_BAL.rodCost1, H_BAL.rodScale1) },
			sellOne() { forgeSellRod(11, H_BAL.rodCost1, H_BAL.rodScale1) },
			sellAll() { forgeSellRodAll(11, H_BAL.rodCost1, H_BAL.rodScale1) },
			purchaseLimit: D(H_BAL.limit1),
			branches: [12],
			tooltip: "按住 Shift 一次买 " + H_BAL.shiftBatch + " 根。",
		},

		12: {
			title: "铈棒",
			display() {
				let data = tmp.h.buyables[12]
				return "每根使炉芯产出 ×" + format(H_BAL.rodBase2) +
					"\n已有：" + formatWhole(getBuyableAmount("h", 12)) + "/" + formatWhole(this.purchaseLimit) +
					"\n花费：" + format(data.cost) + " 炉芯" +
					"\n当前：炉芯 ×" + format(data.effect.core)
			},
			cost(x) {
				return D(H_BAL.rodCost2).times(D(H_BAL.rodScale2).pow(D(x).add(1))).times(buyableCostFinal(1))
			},
			effect(x) { return { core: buyableDebuff(D(H_BAL.rodBase2).pow(D(x))) } },
			canAfford() { return player.h.points.gte(tmp.h.buyables[12].cost) },
			buy() { forgeBuyRod(12, H_BAL.rodCost2, H_BAL.rodScale2) },
			buyMax() { forgeBuyRodMax(12, H_BAL.rodCost2, H_BAL.rodScale2) },
			sellOne() { forgeSellRod(12, H_BAL.rodCost2, H_BAL.rodScale2) },
			sellAll() { forgeSellRodAll(12, H_BAL.rodCost2, H_BAL.rodScale2) },
			purchaseLimit: D(H_BAL.limit2),
			tooltip: "按住 Shift 一次买 " + H_BAL.shiftBatch + " 根。",
		},
	},

	componentStyles: {
		"prestige-button"() { return { 'width': "250px", 'height': "86px" } },
		"buyable"() { return { 'height': "190px", 'width': "200px" } },
	},
})

// ---------- 燃料棒通用买/卖（两根棒共用） ----------
function forgeRodCost(base, scale, x) {
	return D(base).times(D(scale).pow(D(x).add(1))).times(buyableCostFinal(1))
}

function forgeBuyRod(id, base, scale) {
	let limit = layers.h.buyables[id].purchaseLimit
	let amount = getBuyableAmount("h", id)
	if (amount.gte(limit)) return
	let bought = decimalZero
	let n = shiftDown ? H_BAL.shiftBatch : 1
	for (let i = 0; i < n; i++) {
		if (amount.add(bought).gte(limit)) break
		let c = forgeRodCost(base, scale, amount.add(bought))
		if (player.h.points.lt(c)) break
		player.h.points = player.h.points.sub(c)
		player.h.spentOnBuyables = player.h.spentOnBuyables.add(c)
		bought = bought.add(1)
	}
	if (bought.gt(0)) addBuyables("h", id, bought)
}

function forgeBuyRodMax(id, base, scale) {
	let limit = layers.h.buyables[id].purchaseLimit
	let amount = getBuyableAmount("h", id)
	let bought = decimalZero
	for (let i = 0; i < 500; i++) {
		if (amount.add(bought).gte(limit)) break
		let c = forgeRodCost(base, scale, amount.add(bought))
		if (player.h.points.lt(c)) break
		player.h.points = player.h.points.sub(c)
		player.h.spentOnBuyables = player.h.spentOnBuyables.add(c)
		bought = bought.add(1)
	}
	if (bought.gt(0)) addBuyables("h", id, bought)
}

function forgeSellRod(id, base, scale) {
	let a = getBuyableAmount("h", id)
	if (a.lte(0)) return
	setBuyableAmount("h", id, a.minus(1))
	let refund = forgeRodCost(base, scale, a.minus(1))
	if (player.h.spentOnBuyables.gt(refund)) player.h.spentOnBuyables = player.h.spentOnBuyables.minus(refund)
	player.h.points = player.h.points.add(refund)
}

function forgeSellRodAll(id, base, scale) {
	let n = Math.min(getBuyableAmount("h", id).toNumber(), 500)
	for (let i = 0; i < n; i++) forgeSellRod(id, base, scale)
}

// ---------- 文本报告 ----------
function forgePressureReport() {
	let gain = forgeVentGain()
	return "<div style='color:#ffd9b0'>" +
		"炉压：<b>" + formatWhole(player.h.pressure) + "</b>　热量倍率：<b>" + timesFormat(hPressureHeatMult()) +
		"</b>　增速：" + format(hPressureRate()) + "/s<br>" +
		"泄压可得：<b>" + format(gain) + "</b> 热量" +
		(player.h.ventCd.gt(0) ? "（冷却 " + format(player.h.ventCd) + "s）" : "（就绪）") +
		"<br>" + fmtTarget(player.points, tmp.h.nextAt, "热量") +
		"</div>"
}

function forgeTechReport() {
	let s = "<div style='color:#ffd9b0;text-align:left'>"
	s += "<h3>熔炉参数</h3><br>"
	s += "炉芯公式指数：<b>" + format(hCoreExp()) + "</b>（基础 " + H_BAL.baseExp + " ＋ 加成 " + format(hCoreExpBonus()) + "）<br>"
	s += "炉芯产出乘数：<b>" + timesFormat(hCoreGainMult()) + "</b><br>"
	s += "炉压增速：<b>" + format(hPressureRate()) + "/s</b>　炉压指数：<b>" + format(hPressureExp()) + "</b><br>"
	s += "泄压：<b>" + format(H_BAL.ventSeconds) + " 秒产量</b> × 阀门 " + timesFormat(hVentValue()) +
		" × 余烬 " + timesFormat(D(1).add(hEmberBonus())) + "<br>"
	s += "自动熔炉：炉芯 " + format(tmp.h.passiveGeneration) + "/s<br>"
	s += "<br><b>热量来源分解</b><br>"
	s += "　炉芯：" + timesFormat(hHeatMultFromCore()) + "<br>"
	s += "　炉压：" + timesFormat(hPressureHeatMult()) + "<br>"
	s += "　石墨棒：" + timesFormat(buyableEffect("h", 11).heat) + "<br>"
	s += "　升级（鼓风/连锁/高炉）：" + timesFormat(hUpgHeat()) + "<br>"
	s += "　其它层与铭刻：" + timesFormat(foldMult("heat", 1).div(hHeatContrib().max("1e-300"))) + "<br>"
	s += "　<b>合计：" + format(tmp.pointGen) + " /s</b>"
	s += "</div>"
	return s
}

// ============================================================
// 钩子注册（加载期，一次性；见 DESIGN.md §3.2）
// ============================================================
registerHook("heat", hHeatContrib, 1)
