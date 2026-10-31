// ============================================================
// row 0 · 熔炉 Hearth —— 一切开始的地方
// 核心机制：炉压（Pressure）与泄压（Vent）
//   炉压线性上涨到上限后停住（挂机不受惩罚，只是不再变快）。
//   常驻热量倍率是「有界」的（满压只有 ×1.35），所以光憋着并不值钱；
//   泄压额度带 (P/CAP)^4 的超线性奖励 —— 半压只有 1/16，满压才吃满。
//   于是唯一正确的玩法是「等到满压再放」，而且第一次满压泄放刚好换到
//   第一个炉芯：泄压本身就是新手教学。
//   实测（见 DESIGN.md §8 调参记录）：满压才放 vs 从不泄压 = 3.74×，
//   vs 冷却一到就乱放 = 4.37×，vs 半压就放 = 2.69×。
// 跨层加成一律通过 js/Forge/helpers.js 的钩子（DESIGN.md §3）。
// 纯读函数无副作用；只有 update/automate/doReset/onPrestige/buy/sell/respec 会写状态。
// ============================================================

var H_BAL = {
	// —— 熔炼公式 ——
	requires: 200,            // 多少热量换 1 炉芯（第一次满压泄放 ≈ 1 炉芯；50 炉芯约 2.2min）
	baseExp: 0.5,             // 炉芯公式基础指数（exponent 字段固定 1，指数交给 gainExp）
	softcap: "1e50",          // 炉芯产出软上限
	softcapPower: 0.45,
	// —— 炉压：线性涨到上限后停住（不惩罚挂机）——
	pressureRate: 6,          // 每秒炉压增量（约 17 秒充满）
	pressureCap: 100,         // 炉压上限
	pressureMaxBoost: 0.35,   // 满压时的常驻热量倍率（×1.35，有界 → 憋着不放不值钱）
	pressureExp: 1,           // 常驻倍率对压力的响应指数
	// —— 泄压 ——
	ventSeconds: 300,         // 泄压额度 = 每秒热量 × 这么多秒 ×(P/CAP)^ventPow × 阀门加成
	ventPow: 4,               // 超线性：半压只有 1/16，满压才吃满 → 教会玩家「等满压」
	ventKeep: 0,              // 泄压后保留的炉压比例
	ventKeep32: 0.35,         // 升级 32「压力回廊」：泄压后保留更多压力（换取泄压额度下降）
	ventCooldown: 3,          // 泄压冷却（秒）
	ventAutoWait: 20,         // 自动泄压：只在「这笔钱能推进熔炼」时动手
	emberPerReset: 0.02,      // 余烬耙：每次熔炼的泄压加成
	emberCap: 10,
	// —— 燃料棒 ——
	//  每根 ×1.5、上限 25 根 → 满级约 ×2.5e4。
	//  （曾用 ×5/25 根 = ×3e17，实测会把热量彻底压过其它层，让中层形同虚设。）
	rodBase: 1.5, rodCost1: 10, rodScale1: 4, limit1: 25,
	rodBase2: 1.4, rodCost2: 2, rodScale2: 3.2, limit2: 20,
	shiftBatch: 10,
	// —— 升级成本（炉芯）—— 抬高成本，避免熔炉一路碾压后面的层
	upg: { 11: 1, 12: 10, 13: 60, 14: 200, 21: 800, 22: 2500, 23: 8000, 24: 30000, 31: 120000, 32: 120000 },
	// —— 效果数值 ——
	heat11: 10, core14: 2, exp13: 0.05, exp22: 0.03, vent22: 2.5,
	core24: 3, heat24: 1000, chainPerAch: 1.5, chainAchCap: 14,
	pressureRate12: 1.5, pressureRate32: 1.25, vent32: 0.5, exp31: 0.05, core31: 0.5,
	// —— 里程碑阈值 ——
	msCore1: 1e3, msCore2: 1e4,
	// —— 先天效果指数 ——
	effHeatExp: 0.25, effCoreExp: 0.2, effPressureExp: 0.1,
	// —— 先天效果软上限（DESIGN.md §8.5 规则2）——
	// heat 是唯一与自身构成回路的通道（热量→炉芯→热量）：泄压一次给 300 秒产量，
	// 锻造重置又保留 50% 炉芯，于是「炉芯」在每轮循环里被抬高，而本项按炉芯的 0.25 次方
	// 反过来抬高热量 —— 这是一个**多项式棘轮**，不是收敛回路。实测 20 分钟纯自动化跑
	// 会把炉芯顶到 1e38、heat 通道到 1e41（sim.js §8.5 守卫已抓到）。
	// cap=1e4 对应炉芯 1e16：正常推进（点燃时炉芯约 1e12 → 本项仅 1e3）完全不受影响，
	// 只把棘轮的末端掐断。soft=0.35 保证压缩后仍单调、无断点。
	effHeatCap: 1e4, effHeatSoft: 0.35,
	effCoreCap: 1e4, effCoreSoft: 0.35,
}

// 软上限工具：超过 cap 后按 soft 幂次压缩（连续、无断点）
function hSoftCap(v, cap, soft) {
	if (!v.isFinite() || v.lte(cap)) return v
	return D(cap).times(v.div(cap).pow(soft))
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
	return hSoftCap(
		D(player.h.points).add(1).pow(D(H_BAL.effCoreExp).add(foldAdd("coreEffectExp", 0))),
		H_BAL.effCoreCap, H_BAL.effCoreSoft)
}

function hHeatMultFromCore() {
	// 这是全局唯一「自身回路」的通道：热量 →(泄压/熔炼)→ 炉芯 →(本项)→ 热量。
	// 指数 0.25 < 1 时回路收敛，但只要有别的层往 heatCoreExp 里加指数，
	// 边际就可能 >1 变成指数爆炸，所以这里必须硬封顶（见 H_BAL.effHeatCap 注释）。
	return hSoftCap(
		D(player.h.points).add(1).pow(D(H_BAL.effHeatExp).add(foldAdd("heatCoreExp", 0))),
		H_BAL.effHeatCap, H_BAL.effHeatSoft)
}

function hPressureHeatMult() {
	if (inTime(12)) return decimalOne
	// 有界常驻倍率：1 + maxBoost·(P/CAP)，满压 ×1.35。
	// 关键是「有界」——憋着不放最多也就 ×1.35，不足以奖励无限等待；
	// 真正的收益在泄压额度里（见 hVentPressureFactor）。
	let ratio = D(player.h.pressure).div(H_BAL.pressureCap).min(1).max(0)
	let boost = D(H_BAL.pressureMaxBoost).add(foldAdd("pressureMaxBoost", 0))
	return D(1).add(ratio.pow(hPressureExp()).times(boost))
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
	// 自动泄压的触发压力：默认「基本满压」（升级 32 保留压力后，可以更早放）
	if (forgeHasUpgrade("h", 32)) return D(H_BAL.pressureCap).times(0.8)
	return D(H_BAL.pressureCap).times(0.999)
}

function canVent() {
	return player.h.unlocked && player.h.ventCd.lte(0) && player.h.pressure.gt(0)
}

// 泄压额度倍率：(P/CAP)^ventPow —— 半压只有 1/4 额度，满压才吃满
function hVentPressureFactor() {
	let r = D(player.h.pressure).div(H_BAL.pressureCap).min(1).max(0)
	return r.pow(H_BAL.ventPow)
}

function forgeVentGain() {
	return D(tmp.pointGen).times(H_BAL.ventSeconds).times(hVentPressureFactor())
		.times(hVentValue()).times(D(1).add(hEmberBonus()))
}

function forgeVent() {
	if (!canVent()) return decimalZero
	let gain = forgeVentGain()
	player.points = player.points.add(gain)
	let keep = hasUpgrade("h", 32) ? H_BAL.ventKeep32 : H_BAL.ventKeep
	player.h.pressure = D(player.h.pressure).times(keep)
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
		let d = D(diff)
		// 历史峰值产出（供顶栏与统计层读取）
		if (tmp.pointGen instanceof Decimal && tmp.pointGen.gt(player.forgePeak)) player.forgePeak = tmp.pointGen

		// 炉压线性上涨，到上限后停住：挂机不受惩罚，只是不再变快
		let rate = hPressureRate()
		let next = D(player.h.pressure).add(rate.times(d))
		if (next.gt(H_BAL.pressureCap)) next = D(H_BAL.pressureCap)
		player.h.pressure = next

		if (player.h.ventCd.gt(0)) player.h.ventCd = player.h.ventCd.minus(d).max(0)

		// 自动泄压：攒到接近满压、且这笔钱确实能推进熔炼时才动手（不抢玩家手感）
		if (autoOn(player.h.autoVent)) {
			let target = D(H_BAL.ventAutoWait).times(tmp.pointGen)
			if (player.h.ventCd.lte(0) && player.h.pressure.gte(hAutoPressure()) &&
				player.h.points.add(target).gte(tmp.h.nextAt)) {
				forgeVent()
			}
		}
	},

	automate() {
		// §5.4 凝时里程碑 1「自动购买所有层升级」也要覆盖本层。
		// h 层的升级购买在 automate 里（不用引擎的 autoUpgrade 字段），所以在这里并入。
		if (autoOn(player.h.autoBuy || forgeHasMilestone("t", 1))) {
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
		// 自身熔炼：热量由引擎清零（这就是熔炼的代价）；
		// 炉压**不受熔炼影响**——它只被泄压消耗，两者是彼此独立的决策。
		if (resettingLayer === "h") {
			return
		}

		// 被更高层重置：先记住「当前持有量」，再按保留规则清理。
		// 注意：保留量必须基于**本轮持有**而不是历史最佳，否则高层反复重置
		// 会每帧都白送一次 0.5×best，形成无限复制漏洞（实测会让产热在 12 分钟时爆炸）。
		let held = D(player.h.points)
		let ratio = D(player.h.reserveCore)
		let keep = ["vents", "reserveCore", "pressure", "ventCd"]
		if (forgeHasUpgrade("m", 22) || forgeHasUpgrade("t", 11)) keep.push("upgrades")
		if (forgeHasUpgrade("t", 11) || hasMilestone("h", 3) || forgeHasUpgrade("r", 21) || forgeHasMilestone("x", 0)) {
			keep.push("buyables", "spentOnBuyables")
		}
		forgeDoReset("h", resettingLayer, keep)

		// 熔炉里程碑 3 + 锻冶「废料场」：留住本轮炉芯的一部分
		if (hasMilestone("h", 2) && ratio.gt(0)) {
			let kept = ratio.times(held)
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
			body: "这里只有热量是自己涨的，其余都得你动手。<br><br>" +
				"炉压越高，热量涨得越快；泄压一次，结清大约三百秒的产量。压力低时这一笔会大幅缩水——半压只剩十六分之一。<br>" +
				"炉压十七秒左右憋满，之后不再上涨：等着不亏，但也白等。",
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
			description: "泄压后保留 " + String(H_BAL.ventKeep32 * 100) + "% 炉压、炉压增速 ×" + String(H_BAL.pressureRate32) + "，但泄压额度 ×" + String(H_BAL.vent32) + "。与「熔芯铸造」互斥。",
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
				if (!forgeHasMilestone("m", 2)) {
					return "熔炼后保留炉芯——还需锻冶里程碑「废料场」决定比例（当前 " + format(D(player.h.reserveCore).times(100)) + "%）"
				}
				return "熔炼后保留 " + format(D(player.h.reserveCore).times(100)) + "% 的本轮炉芯（按熔炼前的持有量算）"
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
			forgeRespecBuyables("h")
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

// ---------- 燃料棒通用买/卖（委托给 helpers 的通用实现） ----------
function forgeRodCost(base, scale, x) {
	return D(base).times(D(scale).pow(D(x).add(1))).times(buyableCostFinal(1))
}

function forgeBuyRod(id, base, scale) {
	forgeBuyMany("h", id, function (x) { return forgeRodCost(base, scale, x) }, shiftDown ? H_BAL.shiftBatch : 1)
}

function forgeBuyRodMax(id, base, scale) {
	forgeBuyMax("h", id, function (x) { return forgeRodCost(base, scale, x) })
}

function forgeSellRod(id, base, scale) {
	forgeSellOne("h", id, function (x) { return forgeRodCost(base, scale, x) })
}

function forgeSellRodAll(id, base, scale) {
	forgeSellAll("h", id, function (x) { return forgeRodCost(base, scale, x) })
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
	// timesFormat 自带「×」，这里作分隔符不能再写 " × "（会渲染成「3.00× × 余烬」）
	s += "泄压：<b>" + format(H_BAL.ventSeconds) + " 秒产量</b>　阀门 " + timesFormat(hVentValue()) +
		"　余烬 " + timesFormat(D(1).add(hEmberBonus())) + "<br>"
	// 引擎语义（js/game.js: generatePoints 用 resetGain × passiveGeneration）：
	// passiveGeneration 是「每秒完成几次熔炼」，不是「每秒几个炉芯」。单次可得炉芯随进度水涨船高，
	// 所以这里两个数都给出，避免玩家把 1 读成 1 炉芯/秒。
	let autoP = (typeof tmp !== "undefined" && tmp.h) ? D(tmp.h.passiveGeneration) : decimalZero
	if (autoP.gt(0)) {
		let per = tmp.h.resetGain
		// resetGain 为 0 表示热量还不够熔一次，此时别显示「约 0 炉芯/秒」（读起来像坏了）
		s += "自动熔炉：<b>" + format(autoP) + " 次熔炼/秒</b>" +
			((per && per.gt(0)) ? "（当前约 " + format(autoP.times(per)) + " 炉芯/秒）" : "（热量还不够熔一次，暂时停产）") + "<br>"
	} else {
		s += "自动熔炉：未开启<br>"
	}
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
