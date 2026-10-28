// 《熔炉之树 · The Forge Tree》 —— 跨层接口层
// 本文件只提供纯函数与注册表，不含任何层定义。
// 约定（见 DESIGN.md §3）：
//   * 所有跨层加成一律通过钩子（HOOKS）折叠，禁止直接改写别的层的数据。
//   * registerHook 只能在文件顶层（加载期）调用，每个钩子只注册一次。
//   * 钩子函数必须是纯读函数：可返回 Decimal 或 number，不得有副作用。

var HOOKS = {}
var _hookErrors = {}

// ---------- 基础 ----------
function D(x) {
	if (x instanceof Decimal) return x
	return new Decimal(x || 0)
}

function registerHook(name, fn, priority) {
	if (!HOOKS[name]) HOOKS[name] = []
	HOOKS[name].push({ fn: fn, priority: priority || 0 })
	HOOKS[name].sort(function (a, b) { return a.priority - b.priority })
	return name
}

function hookCount(name) {
	return HOOKS[name] ? HOOKS[name].length : 0
}

function _hookValue(hook, name) {
	try {
		return hook.fn()
	} catch (e) {
		if (!_hookErrors[name]) {
			_hookErrors[name] = true
			console.error("Forge hook failed: " + name, e)
		}
		return decimalOne
	}
}

function foldMult(name, start) {
	let out = D(start === undefined ? 1 : start)
	if (!HOOKS[name]) return out
	let list = HOOKS[name]
	for (let i = 0; i < list.length; i++) {
		let v = _hookValue(list[i], name)
		if (v === undefined || v === null) continue
		out = out.times(D(v))
	}
	return out
}

function foldAdd(name, start) {
	let out = D(start === undefined ? 0 : start)
	if (!HOOKS[name]) return out
	let list = HOOKS[name]
	for (let i = 0; i < list.length; i++) {
		let v = _hookValue(list[i], name)
		if (v === undefined || v === null) continue
		out = out.add(D(v))
	}
	return out
}

// ---------- 钩子名清单（文档用，实际是字符串） ----------
var FORGE_HOOKS = [
	"heatFlat", "heat",
	"coreGain", "coreExpBonus",
	"ingotGain", "ingotExpBonus",
	"catalystCost", "catalystDirect", "catalystExpBonus",
	"chrononGain", "stellarGain",
	"startPoints", "ventValue", "pressureRate", "pressureExp",
	"buyableCost", "upgradeCost",
	"hPassiveAdd", "millPassiveAdd",
]

// ---------- 重置 ----------
// 永远保留的字段：解锁状态、累计量、里程碑、计数器
const FORGE_ALWAYS_KEEP = ["unlocked", "total", "best", "milestones", "resets", "vents", "ignited"]

function forgeKeepList(layer, extra) {
	let keep = FORGE_ALWAYS_KEEP.slice()
	let data = player[layer]
	for (let i = 0; i < FORGE_ALWAYS_KEEP.length; i++) {
		// 只保留确实存在的字段，避免 layerDataReset 之后残留 undefined
		if (data[FORGE_ALWAYS_KEEP[i]] === undefined) {
			keep = keep.filter(function (k) { return k !== FORGE_ALWAYS_KEEP[i] })
		}
	}
	if (extra) {
		for (let i = 0; i < extra.length; i++) {
			if (extra[i] && !keep.includes(extra[i])) keep.push(extra[i])
		}
	}
	return keep
}

// 统一的 doReset：只有更高层的重置才会清空本层。
function forgeDoReset(layer, resettingLayer, keep) {
	if (resettingLayer === undefined) return
	if (layers[resettingLayer].row <= layers[layer].row) {
		// 同一行或更低层的重置：默认什么都不做（需要清空时请显式传 force = true）
		if (keep !== "force") return
	}
	layerDataReset(layer, forgeKeepList(layer, keep))
}

// 强制清空本层（保留 FORGE_ALWAYS_KEEP），用于自定义回滚
function forgeForceReset(layer, keep) {
	layerDataReset(layer, forgeKeepList(layer, keep))
}

// ---------- 挑战 debuff 助手 ----------
// 自动化一律走这个函数：这样 "独断" 之类的挑战只要改一处就能全局生效。
// 注意：引擎把 activeChallenge 存成**数字** id（challenge 组件传的是 row*10+col），
// 所以这里必须用宽松/数值比较，不能用 === "15"。
function autoOn(flag) {
	if (!flag) return false
	if (typeof player !== "undefined" && player.t && player.t.activeChallenge !== null &&
		player.t.activeChallenge !== undefined && toNumber(player.t.activeChallenge) === 15) return false
	return true
}

function buyableDebuff(x) {
	// 挑战「贫瘠」：所有层的 buyable 效果减半
	if (forgeInChallenge("t", 13)) return D(x).times(0.5)
	return D(x)
}

function buyableCostFinal(x) {
	// 统一的成本折扣：upgradeCost/buyableCost 钩子 + 挑战
	return D(x).times(foldMult("buyableCost", 1))
}

// 安全的 inChallenge：目标层尚未落地/未解锁时返回 false，而不是抛异常。
// 引擎的 inChallenge 会直接读 player[layer]，在分层开发期（或缺层时）会炸；
// 所有跨层 debuff 判定请一律用这个函数。
function forgeInChallenge(layer, id) {
	try {
		if (typeof player === "undefined" || !player || !player[layer]) return false
		return inChallenge(layer, id)
	} catch (e) {
		return false
	}
}

// 本项目所有挑战都在 t 层，给个短别名
function inTime(id) {
	return forgeInChallenge("t", id)
}

function upgradeCostFinal(x) {
	return D(x).times(foldMult("upgradeCost", 1))
}

// ---------- 全局统计助手（成就/统计层只读这些） ----------
function forgeLayerIds() {
	return ["h", "m", "r", "t", "x"]
}

function completedChallengeCount() {
	let n = 0
	let list = layers.t && layers.t.challenges ? Object.keys(layers.t.challenges) : []
	for (let i = 0; i < list.length; i++) {
		if (player.t.challenges[list[i]] > 0) n++
	}
	return n
}

function maxedChallengeCount() {
	let n = 0
	let list = layers.t && layers.t.challenges ? Object.keys(layers.t.challenges) : []
	for (let i = 0; i < list.length; i++) {
		if (maxedChallenge("t", list[i])) n++
	}
	return n
}

function achievementCount() {
	return player.ach ? player.ach.achievements.length : 0
}

function hasAch(id) {
	return hasAchievement("ach", id)
}

function totalResets() {
	let n = decimalZero
	let list = forgeLayerIds()
	for (let i = 0; i < list.length; i++) {
		let lr = list[i]
		if (player[lr] && player[lr].resets !== undefined) n = n.add(D(player[lr].resets))
	}
	return n
}

// ---------- 显示助手 ----------
function pct(x) {
	return format(D(x).minus(1).times(100)) + "%"
}

function timesFormat(x) {
	return format(x) + "×"
}

// "目标：当前 / 需求" 一行
function fmtTarget(cur, req, unit) {
	return "目标：<b>" + formatWhole(D(cur)) + "</b> / " + formatWhole(D(req)) + (unit ? " " + unit : "")
}

function fmtProgress(name, cur, req, unit) {
	return "<h3>" + name + "</h3><br>" + fmtTarget(cur, req, unit) +
		"<br>进度：" + format(D(cur).div(D(req).max(1)).times(100).min(100)) + "%"
}

// 时间显示（秒）
function fmtLeft(seconds) {
	if (seconds <= 0) return "就绪"
	return formatTime(Math.max(0, Math.ceil(seconds)))
}

function safeGte(value, target) {
	try {
		return D(value).gte(D(target))
	} catch (e) {
		return false
	}
}
