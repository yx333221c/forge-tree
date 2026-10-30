// ============================================================
// 树布局、跨层分支接线、以及「指南」侧层
// tree.js 是 modFiles 的最后一个文件：所有层都已 addLayer，
// 因此这里可以安全地统一设置 position / branches（避免各层互相依赖）。
// ============================================================

var layoutInfo = {
	startTab: "none",
	startNavTab: "tree-tab",
	showTree: true,
	treeLayout: "",
}

// A "ghost" layer which offsets other layers in the tree
addNode("blank", {
	layerShown: "ghost",
})

// ---------- 跨层接线：节点位置与分支线 ----------
var FORGE_ORDER = ["h", "m", "r", "t", "x"]

var FORGE_BRANCHES = {
	m: [["h", "#ff7a18", 3]],
	r: [["m", "#4bdc13", 3]],
	t: [["r", "#4169e1", 3]],
	x: [["t", "#9b59d6", 3]],
}

for (let i = 0; i < FORGE_ORDER.length; i++) {
	let lr = FORGE_ORDER[i]
	if (!layers[lr]) continue
	layers[lr].position = 1
	if (FORGE_BRANCHES[lr]) layers[lr].branches = FORGE_BRANCHES[lr]
}

// ---------- 主树 ----------
addLayer("tree-tab", {
	tabFormat: [["tree", function () {
		return (layoutInfo.treeLayout ? layoutInfo.treeLayout : TREE_LAYERS)
	}]],
	previousTab: "",
	leftTab: true,
})

// ---------- 指南（侧层，纯只读展示）----------
addLayer("guide", {
	name: "指南",
	symbol: "?",
	color: "#c0c0c0",
	row: "side",
	type: "none",
	resource: "知识",
	layerShown() { return player.h.unlocked },
	tooltip() { return "怎么玩、公式长什么样、每条路线的取舍、当前进度" },

	tabFormat: {
		"怎么玩": {
			content: [["raw-html", function () { return forgeGuideText("play") }]],
		},
		"公式": {
			content: [["raw-html", function () { return forgeGuideText("formula") }]],
		},
		"路线": {
			content: [["raw-html", function () { return forgeGuideText("paths") }]],
		},
		"进度": {
			content: [
				["raw-html", function () { return forgeGuideText("progress") }],
				["blank", "14px"],
				["tree", [["h"], ["m"], ["r"], ["t"], ["x"]]],
			],
		},
	},
})

function forgeGuideRow(name, color, unlocked, desc, next) {
	return "<div style='border-left:3px solid " + color + ";padding-left:10px;margin-bottom:12px;" +
		(unlocked ? "" : "opacity:0.45") + "'>" +
		"<h3 style='color:" + color + "'>" + name + (unlocked ? "" : "（未点燃）") + "</h3><br>" +
		desc + "<br>" +
		"<span style='color:#ffd9b0'>" + next + "</span></div>"
}

function forgeGuideText(which) {
	if (which === "play") {
		return "<div style='text-align:left;max-width:760px'>" +
			"<h2>熔炉之树 · 玩法</h2><br>" +
			"<b>一句话：</b>热量是燃料，向上换更值钱的东西，再用它反哺热量。<br><br>" +
			"1. <b>炉压与泄压</b>：炉压每秒上涨，热量倍率随之升高（倍率 = (1+炉压)^指数）。" +
			"按 <b>V</b> 泄压，立刻拿到「当前每秒热量 × 15 秒」的一笔热量，代价是炉压清零。<br>" +
			"　→ 越晚泄，倍率越高；越早泄，越早推进熔炼。这是前期唯一重要的抉择。<br>" +
			"2. <b>熔炼（H）</b>：把热量熔成炉芯。炉芯是本层永久货币，按 (热量/10)^指数 计算。<br>" +
			"3. <b>向上</b>：锻冶用炉芯换锭条，反应用锭条合成触媒，凝时用触媒凝出时序，熔星用时序烧出星核。<br>" +
			"　每往上一层，下面几层都会被重置——但高层货币永久强化低层，所以每一轮都比上一轮快。<br>" +
			"4. <b>自动化</b>：里程碑给的全是自动化（自动泄压、自动购买、自动补充、自动熔炼）。" +
			"把开关打开，你就能专心规划上一层。<br>" +
			"5. <b>操作习惯</b>：升级买一次永久生效；燃料棒按住 <b>Shift</b> 一次买 10 根；" +
			"「重置分配」会全额退还燃料棒花掉的炉芯。<br>" +
			"6. <b>结局</b>：熔星层的「点燃恒星」需要 " + formatWhole(D(FORGE_END.igniteCost)) + " 星核与 " +
			FORGE_END.igniteChallenges + " 个已完成的凝时挑战。达成后可继续游玩，且星核强化更强。<br>" +
			"</div>"
	}
	if (which === "formula") {
		let ingotExp = D(0.5)
		try { if (typeof mIngotExp === "function") ingotExp = mIngotExp() } catch (e) { }
		let chrononExp = D(0.35)
		try { if (typeof tChrononExp === "function") chrononExp = tChrononExp() } catch (e) { }
		let stellarExp = D(0.3)
		try { if (typeof xStellarExp === "function") stellarExp = xStellarExp() } catch (e) { }

		let s = "<div style='text-align:left;max-width:760px'><h2>公式一览</h2><br>"
		s += "所有层都是同一个形状：<b>产出 = (基础资源 / 需求)^指数 × 乘数</b>。指数永远比乘数值钱。<br><br>"
		s += "<b>热量 / 秒</b> = (1 + 平坦加成) × 炉芯^" + format(D(H_BAL.effHeatExp)) +
			" × (1+炉压)^" + format(hPressureExp()) + " × 升级 × 石墨棒 × 其它层 × 铭刻<br>"
		s += "　当前：<b>" + format(tmp.pointGen) + "</b> /秒<br><br>"
		s += "<b>炉芯</b> = (热量 / " + formatWhole(D(H_BAL.requires)) + ")^" + format(hCoreExp()) +
			" × 乘数 " + timesFormat(hCoreGainMult()) +
			"（指数 = 0.5 ＋ 加成 " + format(hCoreExpBonus()) + "）<br><br>"
		s += "<b>锭条</b> = (炉芯 / " + formatWhole(D(50)) + ")^" + format(ingotExp) + " × 乘数<br><br>"
		s += "<b>触媒</b> = 静态层：第 x 级成本 = 10 × 3^(x^1) × 成本折扣（当前折扣 " +
			timesFormat(foldMult("catalystCost", 1)) + "），产出 × " + timesFormat(foldMult("catalystDirect", 1)) + "<br><br>"
		s += "<b>时序</b> = (触媒 / " + formatWhole(D(10)) + ")^" + format(chrononExp) + " × 乘数<br><br>"
		s += "<b>星核</b> = (时序 / " + formatWhole(D(20)) + ")^" + format(stellarExp) + " × 乘数<br><br>"
		s += "<b>重置后起始热量</b> = " + format(getStartPoints()) + "（由凝时与熔星抬高，所以高层重置不再是硬落地）<br>"
		s += "</div>"
		return s
	}
	if (which === "paths") {
		let s = "<div style='text-align:left;max-width:760px'><h2>互斥路线</h2><br>"
		s += "每条互斥都是<b>真的二选一</b>：买了另一边，它就永久消失。想换路线，只能靠更高层的重置把升级洗掉。<br><br>"

		s += "<b>熔炉</b>："
		s += hasUpgrade("h", 31) ? "已选「熔芯铸造」：炉芯指数 +0.05，产出 ×0.5——利于长期。"
			: hasUpgrade("h", 32) ? "已选「压力回廊」：炉压增速 ×1.25，泄压 ×0.5——利于攒大泄压。"
				: "「熔芯铸造」抬指数，「压力回廊」抬增速。"
		s += "<br><br>"

		s += "<b>锻冶</b>："
		s += forgeHasUpgrade("m", 31) ? "已选「水力锻机」：给熔炉自动产出。"
			: forgeHasUpgrade("m", 32) ? "已选「行会盟约」：按泄压次数成长的热量倍率。"
				: "「水力锻机」= 自动化；「行会盟约」= 只要你还在泄压就越烧越旺。"
		s += "<br><br>"

		s += "<b>反应</b>："
		s += forgeHasUpgrade("r", 23) ? "已选「平衡移转」：本层可购项效果 +50%。"
			: forgeHasUpgrade("r", 24) ? "已选「深冷分离」：触媒成本 ×0.7。"
				: "「平衡移转」强化催化塔等可购项；「深冷分离」直接砍最贵的成本。"
		s += "<br><br>"

		s += "<b>凝时</b>："
		s += forgeHasUpgrade("t", 31) ? "已选「时之流」：炉压增速 ×3 ＋ 热量 ×1e4。"
			: forgeHasUpgrade("t", 32) ? "已选「时之滞」：炉芯/锭条产出 ×20 ＋ 可购项成本 ×0.6。"
				: "「时之流」押热量与炉压；「时之滞」押中层产出与成本。"
		s += "<br><br>"

		s += "<b>提示</b>：热量路线让每一轮更快，中层路线让每一层更厚。通关前值得各试一次。"
		s += "</div>"
		return s
	}

	// progress
	let s = "<div style='text-align:left;max-width:760px'><h2>当前进度</h2><br>"
	s += forgeGuideRow("熔炉", "#ff7a18", player.h.unlocked,
		"炉芯 " + formatWhole(player.h.points) + "（累计 " + formatWhole(player.h.total) + "）　熔炼 " +
		formatWhole(player.h.resets) + " 次　泄压 " + formatWhole(player.h.vents) + " 次",
		player.m.unlocked ? "锻冶已点燃：回头补熔炉升级更划算" : "目标：50 炉芯点燃锻冶（当前 " + formatWhole(player.h.points) + "）")
	s += forgeGuideRow("锻冶", "#4bdc13", player.m.unlocked,
		player.m.unlocked ? "锭条 " + formatWhole(player.m.points) + "（累计 " + formatWhole(player.m.total) + "）" : "把炉芯锻成锭条：(炉芯/50)^0.5",
		player.r.unlocked ? "反应已点燃" : "目标：10 锭条点燃反应" + (player.m.unlocked ? "（当前 " + formatWhole(player.m.points) + "）" : ""))
	s += forgeGuideRow("反应", "#4169e1", player.r.unlocked,
		player.r.unlocked ? "触媒 " + formatWhole(player.r.points) + "　下一级需要 " + formatWhole(tmp.r.nextAtDisp) + " 锭条" : "静态层：花锭条逐级买触媒，成本随持有量上涨",
		player.t.unlocked ? "凝时已点燃" : "目标：10 触媒点燃凝时")
	s += forgeGuideRow("凝时", "#9b59d6", player.t.unlocked,
		player.t.unlocked ? "时序 " + formatWhole(player.t.points) + "（累计 " + formatWhole(player.t.total) + "）　已完成挑战 " + completedChallengeCount() + "/6" : "把触媒凝成时序：(触媒/10)^0.35，这里是自动化的中枢",
		player.x.unlocked ? "熔星已点燃" : "目标：20 时序点燃熔星")
	s += forgeGuideRow("熔星", "#ffd700", player.x.unlocked,
		player.x.unlocked ? "星核 " + formatWhole(player.x.points) + "（累计 " + formatWhole(player.x.total) + "）" + (player.x.ignited ? "　<b style='color:#ffd700'>恒星已点燃</b>" : "") : "最终一层：星核决定一切",
		"终局：" + formatWhole(D(FORGE_END.igniteCost)) + " 星核 ＋ " + FORGE_END.igniteChallenges + " 个挑战 → 点燃恒星")
	s += "<br>铭刻：" + achievementCount() + " 条　　热量产出：" + format(tmp.pointGen) + " /秒"
	s += "</div>"
	return s
}
