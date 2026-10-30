// ============================================================
// 侧层 · 统计 Statistics —— 读数台
//
// row:"side" / type:"none"：没有货币、没有重置、没有任何副作用。
// 全部内容用 ["display-text", fn] 逐行列出，函数是**纯读**：
//   只读 player / tmp / layers，缺层与缺字段一律当 0。
// 数值一律走 format / formatWhole / formatTime（见 DESIGN.md §5.7）。
// ============================================================

var ST_BAL = {
	// 各层显示顺序（与 helpers 的 forgeLayerIds 一致，冗余一份以防接口改动）
	order: ["h", "m", "r", "t", "x"],
	// 每层显示名 / 货币名 / 重置动词（只用于文案）
	names: { h: "熔炉", m: "锻造", r: "反应", t: "凝时", x: "熔星" },
	currencies: { h: "炉芯", m: "锭条", r: "触媒", t: "时序", x: "星核" },
	verbs: { h: "熔炼", m: "锻造", r: "反应", t: "凝时", x: "熔星" },
	// 基础炉压增速（与 H_BAL.pressureRate 同值，只在提示里用）
	pressureRate: 3,
}

addLayer("stats", {
	name: "统计",
	symbol: "i",
	position: 1,
	color: "#8fbcbb",
	glowColor: "#8fbcbb",
	row: "side",
	type: "none",
	resource: "读数",

	startData() {
		return {
			unlocked: true,
			points: decimalZero,
		}
	},

	layerShown() {
		if (!forgeHasLayer("h")) return false
		return !!player.h.unlocked
	},

	tooltip() { return "读数台：这里只记录，不交易。" },
	tooltipLocked() { return "先把炉子点着。" },

	// ============================================================
	// 单个子标签「统计」，全部是 display-text（纯读函数）
	// ============================================================
	tabFormat: {
		"统计": {
			content: [
				["display-text", function () { return stHeader() }],
				["h-line", "60%"],
				["blank", "8px"],
				["display-text", function () { return stHeatBlock() }],
				["blank", "6px"],
				["display-text", function () { return stLayerBlock() }],
				["blank", "6px"],
				["display-text", function () { return stCountBlock() }],
				["blank", "6px"],
				["display-text", function () { return stRouteBlock() }],
				["blank", "6px"],
				["display-text", function () { return stChallengeBlock() }],
				["blank", "6px"],
				["display-text", function () { return stEndgameBlock() }],
				["blank", "10px"],
				["display-text", function () { return stFooter() }],
			],
		},
	},

	infoboxes: {
		lore: {
			title: "炉边记事 · 读数台",
			body: "仪表不撒谎，也不安慰人。<br><br>" +
				"这里把整座熔炉的读数抄在一页纸上：时间、热量、每一层炉膛的当前与累计、" +
				"阀门拉过多少次、你选了哪条路、正被哪条锁铐着。<br>" +
				"读数的唯一用途，是让你决定下一步把手放在哪里。",
			titleStyle: { 'color': "#8fbcbb" },
			bodyStyle: { 'color': "#cfe5e2" },
		},
	},
})

// ============================================================
// 只读助手（缺层 / 缺字段 / NaN 一律当 0，绝不抛异常）
// ============================================================
function stAmt(l) { return forgeAmt(l) }
function stTot(l) { return forgeTot(l) }

function stBest(l) {
	if (!forgeHasLayer(l)) return decimalZero
	try {
		let v = D(player[l].best)
		return v.isFinite() ? v : decimalZero
	} catch (e) {
		return decimalZero
	}
}

function stCounter(l, key) {
	if (!forgeHasLayer(l)) return decimalZero
	try {
		let v = player[l][key]
		if (v === undefined || v === null) return decimalZero
		let d = D(v)
		return d.isFinite() ? d : decimalZero
	} catch (e) {
		return decimalZero
	}
}

function stPoints() {
	try {
		let d = D((typeof player !== "undefined" && player) ? player.points : 0)
		return d.isFinite() ? d : decimalZero
	} catch (e) {
		return decimalZero
	}
}

function stPointGen() {
	try {
		let d = D((typeof tmp !== "undefined" && tmp && tmp.pointGen) ? tmp.pointGen : 0)
		return d.isFinite() ? d : decimalZero
	} catch (e) {
		return decimalZero
	}
}

function stTimePlayed() {
	try {
		let t = (typeof player !== "undefined" && player) ? player.timePlayed : 0
		t = (t instanceof Decimal) ? t.toNumber() : Number(t)
		if (!isFinite(t) || t < 0) t = 0
		return t
	} catch (e) {
		return 0
	}
}

// 互斥升级：任何一边被持有就算“已选”。
// 用 helpers 的 forgeHasUpgrade —— 层文件还没落地 / tmp 未就绪时返回 false，不会打断整帧更新。
function stHasUpg(l, id) {
	return forgeHasUpgrade(l, id)
}

function stRoute(pairs) {
	let on = []
	let off = []
	for (let i = 0; i < pairs.length; i++) {
		let p = pairs[i]
		if (stHasUpg(p.l, p.a)) on.push(p.names[0])
		else if (stHasUpg(p.l, p.b)) on.push(p.names[1])
		else off.push(p.group)
	}
	if (on.length === 0) return "未定（" + off.join("／") + "）"
	let text = on.join("　")
	if (off.length > 0) text += "　<i>其余未定：" + off.join("／") + "</i>"
	return text
}

function stChallengeName() {
	if (!forgeHasLayer("t")) return "凝时尚未解锁"
	let c = null
	try { c = player.t.activeChallenge } catch (e) { return "凝时尚未解锁" }
	if (c === null || c === undefined || c === "") return "无（正常状态）"
	let name = String(c)
	try {
		if (typeof layers !== "undefined" && layers.t && layers.t.challenges && layers.t.challenges[c] &&
			layers.t.challenges[c].name) {
			name = String(layers.t.challenges[c].name)
		}
	} catch (e) { /* 拿不到名字就报 id */ }
	return "「" + name + "」"
}

function stNum(x) { return formatWhole(D(x)) }
function stRaw(x) { return format(D(x)) }

// ============================================================
// 各行文本
// ============================================================
function stHeader() {
	return "<div style='color:#8fbcbb'><h3>读数台 · 熔炉总览</h3><br>" +
		"游玩时长：<b>" + formatTime(stTimePlayed()) + "</b>　|　" +
		"版本 " + stVersion() + "</div>"
}

function stVersion() {
	try {
		if (typeof VERSION === "undefined" || !VERSION) return "未知"
		return String(VERSION.num) + "「" + String(VERSION.name) + "」"
	} catch (e) {
		return "未知"
	}
}

function stHeatBlock() {
	let gen = stPointGen()
	return "<div style='text-align:left;color:#dff2ef'>" +
		"<b>主线</b><br>" +
		"　热量：<b>" + stRaw(stPoints()) + "</b>　（" + stRaw(gen) + " / 秒）<br>" +
		"　炉压：" + stNum(stCounter("h", "pressure")) + "　泄压冷却：" + stRaw(stCounter("h", "ventCd")) + " 秒" +
		"</div>"
}

function stLayerBlock() {
	let ids = (ST_BAL.order || forgeLayerIds())
	let out = []
	out.push("<div style='text-align:left;color:#dff2ef'><b>各层炉膛</b>（当前 / 累计 / 最佳　·　重置次数）<br>")
	for (let i = 0; i < ids.length; i++) {
		let l = ids[i]
		let nm = ST_BAL.names[l] || l
		let cur = ST_BAL.currencies[l] || ""
		let verb = ST_BAL.verbs[l] || "重置"
		let shown = forgeHasLayer(l)
		let unlocked = forgeHasUnlocked(l)
		let flag = unlocked ? "已解锁" : (shown ? "未解锁" : "未记录")
		out.push("　" + nm + "（" + cur + "）：<b>" + stRaw(stAmt(l)) + "</b> / " + stRaw(stTot(l)) +
			" / " + stRaw(stBest(l)) + "　·　" + verb + " " + stNum(stCounter(l, "resets")) +
			" 次　<i>" + flag + "</i><br>")
	}
	out.push("</div>")
	return out.join("")
}

function stCountBlock() {
	let done = 0, maxed = 0
	try {
		if (forgeHasLayer("t")) {
			done = completedChallengeCount()
			maxed = maxedChallengeCount()
		}
	} catch (e) { /* 缺 t 层就报 0 */ }
	let total = 0
	try {
		if (typeof layers !== "undefined" && layers.t && layers.t.challenges) {
			total = Object.keys(layers.t.challenges).filter(function (k) { return !isNaN(k) }).length
		}
	} catch (e) { total = 0 }
	return "<div style='text-align:left;color:#dff2ef'><b>计数</b><br>" +
		"　泄压次数：<b>" + stNum(stCounter("h", "vents")) + "</b><br>" +
		"　总重置次数：" + stNum(totalResets()) + "<br>" +
		"　已完成挑战：<b>" + stNum(done) + "</b> / " + stNum(total) + "　·　已满挑战：" + stNum(maxed) + "<br>" +
		"　已点亮铭刻：<b>" + stNum(achievementCount()) + "</b>" +
		"</div>"
}

function stRouteBlock() {
	let groups = [
		{ group: "锻冶路线", l: "m", a: 31, b: 32, names: ["水力锻机", "行会盟约"] },
		{ group: "反应路线", l: "r", a: 23, b: 24, names: ["平衡移转", "深冷分离"] },
		{ group: "凝时路线", l: "t", a: 31, b: 32, names: ["时之流", "时之滞"] },
	]
	let lines = []
	for (let i = 0; i < groups.length; i++) {
		let g = groups[i]
		let chosen = stRoute([g])
		lines.push("　" + g.group + "：<b>" + chosen + "</b>")
	}
	return "<div style='text-align:left;color:#dff2ef'><b>当前所选的互斥路线</b><br>" + lines.join("<br>") + "</div>"
}

function stChallengeBlock() {
	let extra = ""
	try {
		if (forgeHasLayer("t")) {
			let c = player.t.activeChallenge
			if (c !== null && c !== undefined && c !== "") {
				extra = "　<i>锁着的时候，低层的读数是从零重新攒的。</i>"
			}
		}
	} catch (e) { extra = "" }
	return "<div style='text-align:left;color:#dff2ef'><b>所处挑战</b><br>　当前：<b>" +
		stChallengeName() + "</b>" + extra + "</div>"
}

function stEndgameBlock() {
	let ignited = false
	try {
		ignited = forgeHasLayer("x") && !!player.x.ignited
	} catch (e) { ignited = false }
	return "<div style='text-align:left;color:#dff2ef'><b>终局</b><br>　点燃恒星：<b>" +
		(ignited ? "已点亮" : "尚未点亮") + "</b>　（星核 " + stRaw(stAmt("x")) + "）</div>"
}

function stFooter() {
	return "<div style='text-align:left;color:#7fa7a4'>" +
		"读数台不产出任何东西：这里的每一个数字都只是抄写。<br>" +
		"未解锁的层不是零 —— 是还没开始数。" +
		"</div>"
}
