// ============================================================
// 《熔炉之树 · The Forge Tree》 —— 全局配置
// 热量（points）的产生、起点、顶栏提示、结局判定都在这里。
// 所有跨层加成交给 js/Forge/helpers.js 的钩子，本文件只负责折叠。
// ============================================================

let modInfo = {
	name: "熔炉之树",
	author: "The Forge Tree Team",
	id: "forge-tree",
	pointsName: "热量",
	modFiles: ["Forge/helpers.js", "Forge/h.js", "Forge/m.js", "Forge/r.js",
		"Forge/t.js", "Forge/x.js", "Forge/ach.js", "Forge/stats.js", "tree.js"],

	discordName: "",
	discordLink: "",
	initialStartPoints: new Decimal(1), // 新玩家与高层重置后的起始热量
	offlineLimit: 4,  // 小时
	allowSmall: true,
}

let VERSION = {
	num: "1.1",
	name: "炉边记事",
}

let changelog = `<h1>更新日志</h1><br>
	<h3>v1.1 —— 炉边记事</h3><br>
	- 修复三个「写了说明却没生效」的自动化：凝时里程碑 3「熔炼全自动」、挑战 16 的熔炉自动熔炼、里程碑 4「自动反应」。点亮后现在真的会工作。<br>
	- 修正自动熔炉的读数：它给的是「每秒完成几次熔炼」，原先误标成「每秒几个炉芯」，现在两处都显示。<br>
	- 界面文案改写：去掉绕弯子的句子，各层「炉边记事」直接交代机制与数值。<br>
	- 移除面向玩家的开发术语（设计文档章节号、内部字段名、数值预算读数等）。<br>
	- 修正三处说明与实际不符：铭刻数量为 16 条；熔星产出的倍率来源；水力锻机的加成数值。<br>
	- 修复引擎缺陷：自动化可在同一帧买走两个互斥升级；页面补上 UTF-8 声明。<br><br>
	<h3>v1.0 —— 点燃恒星</h3><br>
	- 完整主线：熔炉 → 锻冶 → 反应 → 凝时 → 熔星，五层五种重置。<br>
	- 炉压/泄压机制：一个永远值得按的按钮，后期可交给自动化。<br>
	- 6 个时间挑战、16 条铭刻、两条互斥路线。<br>
	- 结局「点燃恒星」，通关后仍可继续强化。<br>
	- 全部界面中文化，所有面板都写明「当前值 / 需求值」。`

let winText = `恒星亮了。<br><br>
	你烧掉一千枚星核，在虚空里点起第一颗属于自己的恒星。<br>
	炉子还在转。星核的效果指数高了一档，剩下的铭刻与挑战也都做得动，随时可以继续。`

// 官方函数引擎已处理；这里登记我们自己写的、有副作用的函数，避免每 tick 被调用。
var doNotCallTheseFunctionsEveryTick = [
	"forgeVent", "forgeBuyRod", "forgeBuyRodMax", "forgeSellRod", "forgeSellRodAll",
	"forgeDoReset", "forgeForceReset", "forgeKeepList", "registerHook",
	"hHeatContrib", "hCoreGainMult", "hPressureRate", "hPressureExp", "hCoreExp",
	"hCoreExpBonus", "hVentValue", "hEmberBonus", "hCoreMult", "hHeatMultFromCore",
	"hPressureHeatMult", "hPressureMultBase", "hUpgHeat", "hAutoPressure",
	"canVent", "forgeVentGain", "forgeRodCost", "forgePressureReport", "forgeTechReport",
	"forgeNextGoalLine", "getPointGen", "getStartPoints", "canGenPoints", "isEndgame",
	"addedPlayerData", "maxTickLength", "fixOldSave",
]

function getStartPoints() {
	return D(modInfo.initialStartPoints).times(foldMult("startPoints", 1))
}

function canGenPoints() {
	return true
}

// 热量 / 秒
function getPointGen() {
	if (!canGenPoints()) return decimalZero
	let gain = D(1).add(foldAdd("heatFlat", 0))
	return gain.times(foldMult("heat", 1))
}

// 非层数据（会被存档）
function addedPlayerData() {
	return {
		forgePeak: decimalZero,   // 历史最高热量/秒（由 h.js 的 update 维护，纯读函数不改状态）
	}
}

// 终局常量（x.js 与 mod.js 共用，务必在此定义）
var FORGE_END = {
	igniteCost: 1000,      // 点燃恒星需要消耗的星核
	igniteChallenges: 3,   // 需要完成的挑战数
}

// ---------- 顶栏：永远告诉玩家「下一步是什么」 ----------
// 防御式写法：displayThings 在 updateTemp 里被直接调用，一旦抛异常会打断整帧更新；
// 分层开发期或某层文件缺失时也必须安全返回。
function forgeHas(layer) {
	return !!(typeof player !== "undefined" && player && player[layer])
}

function forgeNextGoalLine() {
	let line = ""
	try {
		if (!forgeHas("m") || !player.m.unlocked) {
			line = "下一步：熔炼到 " + formatWhole(D(50)) + " 炉芯，点燃「锻冶」（当前 " + formatWhole(player.h.points) + "）"
		} else if (!forgeHas("r") || !player.r.unlocked) {
			line = "下一步：锻出 " + formatWhole(D(10)) + " 锭条，点燃「反应」（当前 " + formatWhole(player.m.points) + "）"
		} else if (!forgeHas("t") || !player.t.unlocked) {
			line = "下一步：合成 " + formatWhole(D(10)) + " 触媒，点燃「凝时」（当前 " + formatWhole(player.r.points) + "）"
		} else if (!forgeHas("x") || !player.x.unlocked) {
			line = "下一步：攒出 " + formatWhole(D(20)) + " 时序，点燃「熔星」（当前 " + formatWhole(player.t.points) + "）"
		} else if (!player.x.ignited) {
			line = "终局：星核 " + formatWhole(player.x.points) + " / " + formatWhole(D(FORGE_END.igniteCost)) +
				"　已完成挑战 " + completedChallengeCount() + " / " + FORGE_END.igniteChallenges
		} else {
			line = "恒星已点燃：继续把星核烧下去"
		}
	} catch (e) {
		line = ""
	}
	return "<span style='color:#ffd9b0'>" + line + "</span>"
}

var displayThings = [
	function () {
		if (!forgeHas("h") || !layerunlocked("h")) return ""
		return "炉压 <b>" + formatWhole(player.h.pressure) + "</b>　泄压可得 <b>" + format(forgeVentGain()) + "</b>"
	},
	function () { return forgeNextGoalLine() },
	function () {
		if (!forgeHas("t") || !player.t.activeChallenge) return ""
		if (typeof tmp === "undefined" || !tmp.t || !tmp.t.challenges) return ""
		let ch = tmp.t.challenges[player.t.activeChallenge]
		if (!ch) return ""
		return "<b style='color:#9b59d6'>挑战中：" + ch.name + "</b>"
	},
	function () {
		if (typeof player === "undefined" || !player || !player.forgePeak || player.forgePeak.lte(0)) return ""
		return "历史峰值产出：" + format(player.forgePeak) + " /秒"
	},
]

// 结局
function isEndgame() {
	return !!(player.x && player.x.ignited)
}

// ---------- 背景 ----------
var backgroundStyle = {
	background: "radial-gradient(circle at 30% 20%, #1a0d05 0%, #0a0603 55%, #000000 100%)",
}

function maxTickLength() {
	return 3600
}

function fixOldSave(oldVersion) {
	// 首版发布，无需处理旧存档
}
