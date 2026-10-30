// ============================================================
// 侧层 · 铭刻 Inscriptions —— 炉壁上刻下的日子
//
// 每点亮一枚铭刻，炉壁就亮一分。本层 row:"side" / type:"none"：
// 没有货币、不参与任何重置，刻下的东西不会消失。
//
// 统一奖励（DESIGN.md §5.6）：
//   heat 钩子 × 1.02^铭刻数；凝时里程碑 5「铭者纪念碑」时该倍数再 ×2。
// 另有 4 枚铭刻带专属 effect()（24 / 32 / 33 / 42），
//   全部由本文件自己注册进 heat / coreGain 钩子，
//   别的层不读取 achievementEffect，避免耦合。
//
// 所有 done() 只读 player 全局状态，并带缺层守卫：
//   m/r/t/x 尚未落地时返回 false，绝不抛异常。
// 加载期约束（DESIGN.md §10）：字符串型 name 里不调用 format()；
//   需要动态值的 goalTooltip / doneTooltip 一律写成函数。
// ============================================================

var ACH_BAL = {
	// ==== 数值预算（DESIGN.md §8.5，强制）====================
	// 本层只开两条乘法通道，各自有**显式上限**，且超额时硬性夹住：
	//   heat 通道   = inscriptionMult × 专属热量铭刻        ≤ budgetHeat（1e3）
	//   coreGain 通道 = 专属炉芯铭刻的乘积                  ≤ budgetCore（3）
	// 「全满」（16 枚 + 凝时里程碑 5）时的理论值：
	//   inscriptionMult = 1.02^16 × 2 = 1.373 × 2 = 2.75
	//   专属热量 = 6 × 10 = 60
	//   heat 合计 ≈ 165，远低于 budgetHeat=1e3，也远低于 §8.5 第 3 条的
	//   「所有 heat 钩子乘积 ≤ 1e40」总盘子 —— 铭刻是锦上添花，不是主引擎。
	// 自检函数：achFullHeatBudget()（理论全满值）/ achHeatChannel()（当前实测值）
	//          / achOverBudget()（是否越预算，stats 层会直接显示）
	budgetHeat: 1e3,        // heat 通道硬夹持
	budgetCore: 3,          // coreGain 通道硬夹持
	budgetInscription: 32,  // 铭刻基础项（1.02^n × 纪念碑）的独立夹持，防止 count 被改大

	// ---- 统一奖励（DESIGN.md §5.6 指定 1.02，不得擅改）----
	perAch: 1.02,          // 每枚铭刻：热量 ×（1.02^16 = 1.37，预算内）
	perAchCeil: 1.15,      // 上限守卫：per 不得超过 1.15（1.15^16 ≈ 9.4）
	monumentMult: 2,       // 凝时里程碑 5：铭刻加成 ×2

	// ---- 专属 effect（4 枚，由本文件注册进钩子）----
	coreTempered: 2,       // 24 百锻成铭：炉芯产出 ×
	heatMillion: 6,        // 32 百万熔炉：热量 ×（原 1e4 越预算，已下调）
	heatTenMillion: 10,    // 33 千万熔炉：热量 ×（原 1e5 越预算，已下调；比 32 高一档）
	corePerfect: 1.5,      // 42 刻度之间：炉芯产出 ×（2 × 1.5 = 3 = budgetCore）

	// ---- 达成阈值（全部可在正常游玩中达到）----
	firstHeat: 1,            // 11 点火：热量 ≥ 1（开局即达成，作为教学白送的刻痕）
	firstCore: 1,            // 12 第一炉：累计炉芯 ≥ 1
	ventOne: 1,              // 23 泄压一次
	ventFifty: 50,           // 31 泄压五十次
	coreResets: 100,         // 24 百锻成铭：熔炼次数
	currencyMillion: 1e6,    // 32 百万熔炉：任意一层货币（h 里程碑 3 同档）
	currencyTenMillion: 1e7, // 33 千万熔炉：同上，再翻十倍
	achTen: 10,              // 34 铭刻十枚：已点亮铭刻数
	// 42 刻度之间：热量读数落在 [exactLo, exactHi] 且**不是整数**
	exactLo: 1e3,
	exactHi: 1e5,
	// 44 守炉人：累计游玩时长达到 ACH_BAL.guardSeconds 秒。
	//   为什么不用炉压当条件：h 层的炉压是**线性涨到 H_BAL.pressureCap 后夹住**（现值 100，
	//   属于 lead 随时会调的数值），绝对阈值有可能变成 unreachable；proportional 阈值又依赖
	//   读到 H_BAL。player.timePlayed 由引擎 addTime() 每 tick 累加、永不回退，
	//   所以「守炉若干分钟」在任何平衡版本下都必然达成。
	guardSeconds: 1800,

	// ---- 各层解锁需求（只用于提示文案，来自 DESIGN.md §5.2-§5.5）----
	requires: { m: 50, r: 10, t: 10, x: 20 },

	// ---- 铭刻墙尺寸：4 行 × 4 列 = 16 格 ----
	rows: 4,
	cols: 4,
	count: 16,
}

// 专属 effect 对应的成就 id（本文件内部使用；别的层不需要知道）
var ACH_EXCL = { coreTempered: 24, heatMillion: 32, heatTenMillion: 33, corePerfect: 42 }

// ============================================================
// 钩子注册：必须在文件顶层（加载期）调用一次，见 DESIGN.md §3.1
//   两条通道都走 achHeatChannel() / achExclusiveCoreMult()，
//   二者内部已按 ACH_BAL.budgetHeat / budgetCore 硬夹持（§8.5）。
// ============================================================
registerHook("heat", function () {
	return achHeatChannel()
})

registerHook("coreGain", function () {
	return achExclusiveCoreMult()
})

addLayer("ach", {
	name: "铭刻",
	symbol: "★",
	position: 0,
	color: "#ffe14d",
	glowColor: "#ffe14d",
	row: "side",
	type: "none",
	resource: "铭刻之力",
	achievementPopups: true,

	startData() {
		return {
			unlocked: true,
			points: decimalZero,
			best: decimalZero,
			total: decimalZero,
		}
	},

	layerShown() { return true },

	tooltip() {
		return "铭刻 " + formatWhole(D(achievementCount())) + " / " + formatWhole(D(ACH_BAL.count)) +
			"　热量通道 " + timesFormat(achHeatChannel())
	},
	tooltipLocked() { return "炉壁上的刻痕一直都在。" },

	// 本层给下游的东西全部通过 heat / coreGain 钩子给出（两条通道都有预算夹持）
	effect() {
		return { heatChannel: achHeatChannel(), inscriptionMult: achInscriptionMult(), coreMult: achExclusiveCoreMult() }
	},
	effectDescription() {
		let m = achHeatChannel()
		return "已点亮 <b>" + formatWhole(D(achievementCount())) + "</b> 枚铭刻，热量 " + timesFormat(m) +
			"（+" + format(D(m).minus(1).times(100)) + "%）" +
			(achMonumentOn() ? "，其中凝时「铭者纪念碑」的 ×2 <b>已生效</b>" : "") +
			"；炉芯产出 " + timesFormat(achExclusiveCoreMult()) +
			"<br>预算：heat 通道上限 " + timesFormat(D(ACH_BAL.budgetHeat)) +
			(achOverBudget() ? "（<b>已顶到上限</b>）" : "（未顶到上限）")
	},

	// ============================================================
	// 16 枚铭刻（id 11..14 / 21..24 / 31..34 / 41..44，见结论说明）
	//   引擎对「未完成」的铭刻用 visibility:hidden：格位占着、但看不见
	//   —— 那就是「未知铭刻」。所以这堵墙永远是整齐的 4×4。
	// ============================================================
	achievements: {
		// ---------- 第一行：第一次呼吸 ----------
		11: {
			name: "点火",
			done() { return achGte(achPoints(), ACH_BAL.firstHeat) },
			goalTooltip() {
				return "让热量的刻度离开零。<br>当前：<b>" + format(achPoints()) + "</b> / " +
					formatWhole(D(ACH_BAL.firstHeat)) + " 热量<br><br>奖励：铭刻基础加成（每枚热量 ×" +
					format(D(ACH_BAL.perAch)) + "）"
			},
			doneTooltip() { return achDoneText("第一缕热量落进炉膛。") },
		},
		12: {
			name: "第一炉",
			done() { return achGte(achTot("h"), ACH_BAL.firstCore) },
			goalTooltip() {
				return "完成第一次熔炼，让炉芯成为你的所有物。<br>当前：炉芯 <b>" +
					formatWhole(achAmt("h")) + "</b>（累计 " + formatWhole(achTot("h")) + " / " +
					formatWhole(D(ACH_BAL.firstCore)) + "）<br><br>奖励：铭刻基础加成"
			},
			doneTooltip() { return achDoneText("炉门开了。里面是更多的炉膛。") },
		},
		13: {
			name: "落锤",
			done() { return achUnlocked("m") },
			goalTooltip() { return achUnlockHint("m", "第一次锻造：把炉芯送上铁砧。") },
			doneTooltip() { return achDoneText("第一锤落下，火星认识了你。") },
		},
		14: {
			name: "引燃",
			done() { return achUnlocked("r") },
			goalTooltip() { return achUnlockHint("r", "第一次反应：让触媒在高压釜里醒来。") },
			doneTooltip() { return achDoneText("反应开始了。它不需要你看着。") },
		},

		// ---------- 第二行：更深的炉膛与手汗 ----------
		21: {
			name: "时序初启",
			done() { return achUnlocked("t") },
			goalTooltip() { return achUnlockHint("t", "第一次凝时：把触媒交给时间。") },
			doneTooltip() { return achDoneText("时间在这里变稠。") },
		},
		22: {
			name: "星之核",
			done() { return achUnlocked("x") },
			goalTooltip() { return achUnlockHint("x", "第一次熔星：把时序压成一颗星核。") },
			doneTooltip() { return achDoneText("你手里有一颗还没点着的太阳。") },
		},
		23: {
			name: "泄压一次",
			done() { return achGte(achCounter("h", "vents"), ACH_BAL.ventOne) },
			goalTooltip() {
				return "拉开一次阀门，把炉压兑换成热量。<br>当前：泄压 <b>" +
					formatWhole(achCounter("h", "vents")) + "</b> / " + formatWhole(D(ACH_BAL.ventOne)) +
					" 次（炉压 " + formatWhole(achCounter("h", "pressure")) + "）<br><br>奖励：铭刻基础加成"
			},
			doneTooltip() { return achDoneText("第一声泄压。此后你爱上了它。") },
		},
		24: {
			name: "百锻成铭",
			done() { return achGte(achCounter("h", "resets"), ACH_BAL.coreResets) },
			goalTooltip() {
				return "熔炼一百次，炉壁自己记下了锤数。<br>当前：熔炼 <b>" +
					formatWhole(achCounter("h", "resets")) + "</b> / " + formatWhole(D(ACH_BAL.coreResets)) +
					" 次<br><br>奖励：<b>炉芯产出 ×" + formatWhole(D(ACH_BAL.coreTempered)) + "</b>（专属）＋铭刻基础加成"
			},
			doneTooltip() { return achDoneText("第一百炉。铁开始认识你的手。") },
			// 专属效果：炉芯产出翻倍（由本文件的 coreGain 钩子施加）
			effect() { return achOwned(ACH_EXCL.coreTempered) ? D(ACH_BAL.coreTempered) : decimalOne },
		},

		// ---------- 第三行：刻度上的数字 ----------
		31: {
			name: "泄压五十次",
			done() { return achGte(achCounter("h", "vents"), ACH_BAL.ventFifty) },
			goalTooltip() {
				return "阀门被拉开五十次。<br>当前：泄压 <b>" +
					formatWhole(achCounter("h", "vents")) + "</b> / " + formatWhole(D(ACH_BAL.ventFifty)) +
					" 次<br><br>奖励：铭刻基础加成"
			},
			doneTooltip() { return achDoneText("五十次白色的汽，刻痕连成了线。") },
		},
		32: {
			name: "百万熔炉",
			done() { return achAnyLayerGte(ACH_BAL.currencyMillion) },
			goalTooltip() {
				return "让某一层炉膛里的东西，数到六位。<br>当前最大读数：<b>" + format(achMaxLayer()) +
					"</b> / " + formatWhole(D(ACH_BAL.currencyMillion)) +
					"<br><br>奖励：<b>热量 ×" + format(D(ACH_BAL.heatMillion)) + "</b>（专属）＋铭刻基础加成"
			},
			doneTooltip() { return achDoneText("百万。数字第一次有了重量。") },
			effect() { return achOwned(ACH_EXCL.heatMillion) ? D(ACH_BAL.heatMillion) : decimalOne },
		},
		33: {
			name: "千万熔炉",
			done() { return achAnyLayerGte(ACH_BAL.currencyTenMillion) },
			goalTooltip() {
				return "把同一个数字再翻十倍。<br>当前最大读数：<b>" + format(achMaxLayer()) +
					"</b> / " + formatWhole(D(ACH_BAL.currencyTenMillion)) +
					"<br><br>奖励：<b>热量 ×" + format(D(ACH_BAL.heatTenMillion)) + "</b>（专属）＋铭刻基础加成"
			},
			doneTooltip() { return achDoneText("千万。你开始相信这台炉子没有顶。") },
			effect() { return achOwned(ACH_EXCL.heatTenMillion) ? D(ACH_BAL.heatTenMillion) : decimalOne },
		},
		34: {
			name: "铭刻十枚",
			done() { return D(achievementCount()).gte(ACH_BAL.achTen) },
			goalTooltip() {
				return "炉壁上亮起的刻痕达到十个。<br>当前：<b>" + formatWhole(D(achievementCount())) +
					"</b> / " + formatWhole(D(ACH_BAL.achTen)) + " 枚<br><i>不必全亮，亮够十个就行。</i>" +
					"<br><br>奖励：铭刻基础加成"
			},
			doneTooltip() { return achDoneText("十枚铭刻。炉壁开始自己发光了。") },
		},

		// ---------- 第四行：需要一点主意（彩蛋区）----------
		41: {
			name: "点燃恒星",
			done() { return achIgnited() },
			goalTooltip() {
				return "把一颗恒星点亮在你的炉膛里。<br>当前：星核 <b>" + formatWhole(achAmt("x")) +
					"</b>，已完成挑战 <b>" + formatWhole(D(achChallengeDone())) + "</b> 个<br>" +
					"<i>那是终点，不是数字墙。</i><br><br>奖励：铭刻基础加成"
			},
			doneTooltip() { return achDoneText("虚空第一次有了别人也能看见的光。") },
		},
		42: {
			name: "刻度之间",
			done() { return achExactBand() },
			goalTooltip() {
				return "热量停在两格之间：一个<b>不是整数</b>的读数，落在 " +
					formatWhole(D(ACH_BAL.exactLo)) + " 与 " + formatWhole(D(ACH_BAL.exactHi)) +
					" 之间。<br>当前读数：<b>" + achExactProgress() + "</b><br><i>整数来得太容易。</i>" +
					"<br><br>奖励：<b>炉芯产出 ×" + format(D(ACH_BAL.corePerfect)) + "</b>（专属）＋铭刻基础加成"
			},
			doneTooltip() { return achDoneText("你停在两格之间。那一格本来就是空的。") },
			effect() { return achOwned(ACH_EXCL.corePerfect) ? D(ACH_BAL.corePerfect) : decimalOne },
		},
		43: {
			name: "手中有锁",
			done() { return achInAnyChallenge() },
			goalTooltip() {
				return "在某个凝时挑战<b>正在进行</b>的时候，让炉壁记下它。<br>当前：<b>" +
					achChallengeProgress() + "</b><br><i>进去以后不必立刻出来——铭刻会在你还锁着的时候亮起。</i>" +
					"<br><br>奖励：铭刻基础加成"
			},
			doneTooltip() { return achDoneText("锁着的时候也能刻字。手要稳。") },
		},
		44: {
			name: "守炉人",
			done() { return D(achTimePlayed()).gte(D(ACH_BAL.guardSeconds)) },
			goalTooltip() {
				return "有一次，别碰阀门，也别急着熔：让炉子自己待一会儿。<br>当前：守炉 <b>" +
					formatTime(Math.floor(achTimePlayed())) + "</b> / " + formatTime(ACH_BAL.guardSeconds) +
					"（炉压 " + formatWhole(achCounter("h", "pressure")) + "，增速 " + format(achPressureRate()) + "/秒）" +
					"<br><i>炉压涨到顶就停。这一枚要的是耐心，不是数字。</i>" +
					"<br><br>奖励：铭刻基础加成"
			},
			doneTooltip() { return achDoneText("你第一次什么都没做，炉子也照样好。") },
		},
	},

	// ============================================================
	// 界面：铭刻墙
	//   注意：["achievements"] 这种「单元素数组」在 column/row 组件里不会被渲染
	//   （引擎只处理 length 2 / 3 的数组），所以必须写成裸字符串 "achievements"：
	//   不带参数 = 全部行（tmp.ach.achievements.rows × cols = 4 × 4）。
	// ============================================================
	tabFormat: {
		"铭刻": {
			content: [
				["display-text", function () { return achHeader() }],
				["h-line", "60%"],
				["blank", "10px"],
				"achievements",
				["blank", "12px"],
				["display-text", function () { return achFooter() }],
			],
		},
	},

	infoboxes: {
		lore: {
			title: "炉边记事 · 刻痕",
			body: "虚空冷得不肯发光，于是你把日子刻在炉壁上。<br><br>" +
				"看不见的格位不是空的——那是<b>未知铭刻</b>：位置就在那里，只是还没被你刻亮。<br>" +
				"把鼠标停在上面，能读出口供与进度；剩下的只能靠猜。<br>" +
				"炉壁不催你。它只是数着。",
			titleStyle: { 'color': "#ffe14d" },
			bodyStyle: { 'color': "#e8dcae" },
		},
	},

	componentStyles: {
		achievement: { 'margin': "5px" },
		achievements: { 'max-width': "460px" },
	},
})

// ============================================================
// 只读助手（缺层 / 缺字段 / NaN / Infinity 一律返回 false 或 0）
// ============================================================

// 为什么要自己写比较：break_eternity 里 Decimal(NaN).gte(x) 返回 **true**
// （NaN 的符号比较是"全 false"，但 gte 走的是 !lt 分支），存档被写坏时
// 会白送成就。这里先验有限性，再做比较 —— 成就宁可漏授也不误授。
function achGte(value, target) {
	let v
	try {
		v = D(value)
	} catch (e) {
		return false
	}
	if (!v.isFinite() || v.isNan()) return false
	try {
		return v.gte(D(target))
	} catch (e) {
		return false
	}
}

// 「铭刻之力」的读数就是加成倍数本身；本层不新增货币，points 永远是 0。
// 预算守卫（§8.5）：per 夹到 [1, perAchCeil]，n 夹到铭刻墙总数，结果夹到 budgetInscription。
function achInscriptionMult() {
	let n = 0
	try { n = achievementCount() || 0 } catch (e) { n = 0 }
	let per = ACH_BAL.perAch
	if (!(per > 1)) per = 1.02
	if (per > ACH_BAL.perAchCeil) per = ACH_BAL.perAchCeil
	let cap = ACH_BAL.count || 16
	if (n > cap) n = cap
	let mult
	try {
		mult = Decimal.pow(D(per), D(n))
		if (!mult.isFinite() || mult.lt(1)) return decimalOne
	} catch (e) {
		return decimalOne
	}
	if (achMonumentOn()) mult = mult.times(ACH_BAL.monumentMult)
	return achClamp(mult, ACH_BAL.budgetInscription)
}

// 本层 heat 通道的完整乘子 = 铭刻基础 × 专属热量铭刻，最后硬夹到 budgetHeat。
// 钩子与展示文本都走这一个函数：玩家看到的与生效的是同一个数字。
function achHeatChannel() {
	let mult = achInscriptionMult()
	if (achOwned(ACH_EXCL.heatMillion)) mult = mult.times(ACH_BAL.heatMillion)
	if (achOwned(ACH_EXCL.heatTenMillion)) mult = mult.times(ACH_BAL.heatTenMillion)
	return achClamp(mult, ACH_BAL.budgetHeat)
}

// 通道内部拆开看（stats / 归因用）
function achHeatExclusivePart() {
	let mult = decimalOne
	if (achOwned(ACH_EXCL.heatMillion)) mult = mult.times(ACH_BAL.heatMillion)
	if (achOwned(ACH_EXCL.heatTenMillion)) mult = mult.times(ACH_BAL.heatTenMillion)
	return mult
}

function achClamp(x, cap) {
	try {
		let c = D(cap)
		if (x.gt(c)) return c
	} catch (e) { /* 夹不住就原样返回 */ }
	return x
}

// ---- 预算自检（lead 要求：写清全满时 heat 乘子，并能被 stats 层显示）----
// 理论「全满」值：所有铭刻点亮 + 纪念碑生效 + 全部专属生效，不做夹持。
// 与 budgetHeat 比较即可判断「预算是否真的够用」。
function achFullHeatBudget() {
	let per = ACH_BAL.perAch
	if (!(per > 1)) per = 1.02
	if (per > ACH_BAL.perAchCeil) per = ACH_BAL.perAchCeil
	let cap = ACH_BAL.count || 16
	let v = Decimal.pow(D(per), D(cap)).times(ACH_BAL.monumentMult)
	v = v.times(ACH_BAL.heatMillion).times(ACH_BAL.heatTenMillion)
	return v
}

// 全满时的 coreGain 乘子（同样算一遍，避免两条通道只核一条）。
function achFullCoreBudget() {
	return D(ACH_BAL.coreTempered).times(ACH_BAL.corePerfect)
}

// 当前实测是否已越过预算（越界=我们夹住了，返回 true 让 stats 提醒）。
function achOverBudget() {
	return achHeatChannel().gte(ACH_BAL.budgetHeat)
}

// 专属效果（coreGain）：24 百锻成铭 × 42 刻度之间，硬夹到 budgetCore。
function achExclusiveCoreMult() {
	let mult = decimalOne
	if (achOwned(ACH_EXCL.coreTempered)) mult = mult.times(ACH_BAL.coreTempered)
	if (achOwned(ACH_EXCL.corePerfect)) mult = mult.times(ACH_BAL.corePerfect)
	return achClamp(mult, ACH_BAL.budgetCore)
}

// 凝时里程碑 5「铭者纪念碑」：铭刻加成 ×2。
// 用 helpers 的 forgeHasMilestone：t 层缺失 / tmp 未就绪时返回 false，不会打断整帧更新。
function achMonumentOn() {
	return forgeHasMilestone("t", 5)
}

// 已拥有的铭刻（本层一定存在，但仍加守卫：加载期 tmp.ach 可能还没建好）
function achOwned(id) {
	try {
		if (typeof player === "undefined" || !player || !player.ach) return false
		if (typeof tmp === "undefined" || !tmp.ach) return false
		return !!hasAchievement("ach", id)
	} catch (e) {
		return false
	}
}

function achPoints() {
	try {
		return D((typeof player !== "undefined" && player) ? player.points : 0)
	} catch (e) {
		return decimalZero
	}
}

function achUnlocked(l) { return forgeHasUnlocked(l) }
function achAmt(l) { return forgeAmt(l) }
function achTot(l) { return forgeTot(l) }

// 安全读取某层的计数字段（vents / resets / pressure …）
function achCounter(l, key) {
	if (!forgeHasLayer(l)) return decimalZero
	try {
		let v = player[l][key]
		if (v === undefined || v === null) return decimalZero
		return D(v)
	} catch (e) {
		return decimalZero
	}
}

// 已完成挑战数（缺 t 层时 0）
function achChallengeDone() {
	try {
		if (!forgeHasLayer("t")) return 0
		return completedChallengeCount()
	} catch (e) {
		return 0
	}
}

// 是否已点燃恒星
function achIgnited() {
	if (!forgeHasLayer("x")) return false
	try {
		return !!player.x.ignited
	} catch (e) {
		return false
	}
}

// 任意一层的货币（当前持有或累计）达到 target。
// 当前值与累计值都算：被高层重置清掉之后也不会“错过”。
function achAnyLayerGte(target) {
	let t = D(target)
	let ids = forgeLayerIds()
	for (let i = 0; i < ids.length; i++) {
		if (achGte(achAmt(ids[i]), t)) return true
		if (achGte(achTot(ids[i]), t)) return true
	}
	return achGte(achPoints(), t)
}

// 五层货币里的最大读数（给进度提示用；NaN / Infinity 跳过）
function achMaxLayer() {
	let best = decimalZero
	let ids = forgeLayerIds()
	for (let i = 0; i < ids.length; i++) {
		let v = achAmt(ids[i])
		if (achIsFinite(v)) best = best.max(v)
		let t = achTot(ids[i])
		if (achIsFinite(t)) best = best.max(t)
	}
	return best
}

function achIsFinite(x) {
	try {
		return D(x).isFinite()
	} catch (e) {
		return false
	}
}

// 彩蛋判定：热量读数落在 [exactLo, exactHi]，而且**不是整数**。
// 热量是连续累加的（每 tick += tmp.pointGen × diff，diff ≈ 0.05s，
// 且炉压/泄压带来的倍数本身就是小数），所以穿过这一段时几乎必然出现小数读数；
// 熔炼把热量清零后它会再次走过那一格。
function achExactBand() {
	let p = achPoints()
	if (!achIsFinite(p)) return false
	if (p.lt(D(ACH_BAL.exactLo)) || p.gt(D(ACH_BAL.exactHi))) return false
	return !p.eq(p.floor())
}

function achExactProgress() {
	let p = achPoints()
	if (p.lt(D(ACH_BAL.exactLo))) {
		return format(p) + "（先让读数离开整数：越过 " + formatWhole(D(ACH_BAL.exactLo)) + " 之后它自然是小数）"
	}
	if (p.gt(D(ACH_BAL.exactHi))) {
		return format(p) + "（读数过头；熔炼一次把热量清零，它会重新走过那一格）"
	}
	return p.toFixed(3) + (p.eq(p.floor()) ? "（此刻是整数，再等半秒）" : "（就是现在）")
}

// 彩蛋判定：正处于任意一个凝时挑战中
function achInAnyChallenge() {
	if (!forgeHasLayer("t")) return false
	try {
		let c = player.t.activeChallenge
		return c !== null && c !== undefined && c !== "" && toNumber(c) > 0
	} catch (e) {
		return false
	}
}

function achChallengeProgress() {
	if (!forgeHasLayer("t")) return "凝时尚未解锁（先完成 21「时序初启」）"
	try {
		let c = player.t.activeChallenge
		if (c === null || c === undefined || c === "") return "当前没有正在进行的挑战"
		let name = String(c)
		if (typeof layers !== "undefined" && layers.t && layers.t.challenges && layers.t.challenges[c] &&
			layers.t.challenges[c].name) {
			name = String(layers.t.challenges[c].name)
		}
		return "正在进行：" + name
	} catch (e) {
		return "正在进行：未知"
	}
}

// 累计游玩时长（秒）。player.timePlayed 是普通 number（引擎 addTime 维护），
// 但存档被写坏时可能是 Decimal / undefined / NaN，所以统一转成有限非负数字。
function achTimePlayed() {
	try {
		let t = (typeof player !== "undefined" && player) ? player.timePlayed : 0
		if (t instanceof Decimal) t = t.toNumber()
		t = Number(t)
		if (!isFinite(t) || t < 0) return 0
		return t
	} catch (e) {
		return 0
	}
}

// 炉压增速（提示用）：优先现读 h 层的 H_BAL.pressureRate，再乘上 pressureRate 钩子。
function achPressureRate() {
	let base = D(6)
	try {
		if (typeof H_BAL !== "undefined" && H_BAL && H_BAL.pressureRate > 0) base = D(H_BAL.pressureRate)
	} catch (e) { /* 用兜底 */ }
	try {
		return base.times(foldMult("pressureRate", 1))
	} catch (e) {
		return base
	}
}

// ============================================================
// 文本
// ============================================================

// 「解锁某层」类成就的通用提示。
// 需求值与基底货币名都**现读**那一层的定义（layers[l].requires / baseResource），
// 读不到才退回 ACH_BAL.requires（DESIGN.md §5.2-§5.5 的约定值）。
// 这样 lead 改 requires 时，提示不会说谎，也不会抛异常。
function achRequires(l) {
	try {
		if (typeof layers !== "undefined" && layers[l] && layers[l].requires !== undefined) {
			let r = D(readData(layers[l].requires))
			if (r.isFinite() && r.gt(0)) return r
		}
	} catch (e) { /* 退回兜底 */ }
	return D(ACH_BAL.requires[l] || 1)
}

function achBaseName(l) {
	try {
		if (typeof layers !== "undefined" && layers[l] && typeof layers[l].baseResource === "string") {
			return layers[l].baseResource
		}
	} catch (e) { /* 退回兜底 */ }
	let bases = { m: "炉芯", r: "锭条", t: "触媒", x: "时序" }
	return bases[l] || ""
}

function achUnlockHint(l, flavor) {
	let names = { m: "锻造", r: "反应", t: "凝时", x: "熔星" }
	let has = decimalZero
	if (l === "m") has = achAmt("h")
	else if (l === "r") has = achAmt("m")
	else if (l === "t") has = achAmt("r")
	else if (l === "x") has = achAmt("t")
	return flavor + "<br>解锁「" + (names[l] || l) + "」需要 <b>" + formatWhole(achRequires(l)) + "</b> " +
		achBaseName(l) + "（当前 " + formatWhole(has) + "）<br><br>奖励：铭刻基础加成"
}

// 已完成铭刻的通用尾注
function achDoneText(flavor) {
	let m = achHeatChannel()
	return flavor + "<br><br>" + fmtTarget(D(achievementCount()), D(ACH_BAL.count), "枚铭刻") +
		"<br>当前铭刻加成：<b>" + timesFormat(m) + "</b> 热量（+" + format(D(m).minus(1).times(100)) + "%）" +
		(achMonumentOn() ? "，×2 <b>已生效</b>" : "") +
		"<br><br><span style='color:#ffe14d'>炉壁替你记着。</span>"
}

function achHeader() {
	let n = achievementCount()
	let total = ACH_BAL.count || 0
	let hidden = Math.max(0, total - n)
	let m = achHeatChannel()
	return "<div style='color:#ffe14d'>" +
		"<h3>炉壁 · 铭刻墙 " + ACH_BAL.rows + " × " + ACH_BAL.cols + "</h3><br>" +
		"已点亮 <b>" + formatWhole(D(n)) + "</b> / " + formatWhole(D(total)) + " 枚，其余 " +
		formatWhole(D(hidden)) + " 枚是<b>未知铭刻</b>（格位占着，只是还没亮）。<br>" +
		"当前加成 <b>+" + format(D(m).minus(1).times(100)) + "%</b>（" + timesFormat(m) + " 热量）" +
		(achMonumentOn() ? "，<b>×2 已生效</b>（凝时里程碑 5「铭者纪念碑」）" : "，×2 尚未生效（需要凝时里程碑 5）") +
		"<br>预算 " + timesFormat(D(ACH_BAL.budgetHeat)) + "　" + achBudgetBar(m) +
		"</div>"
}

// 预算占用条：让「顶到上限」这件事在 UI 上可见，而不是藏在公式里。
function achBudgetBar(cur) {
	let ratio
	try {
		ratio = D(cur).div(D(ACH_BAL.budgetHeat)).min(1).max(0)
	} catch (e) {
		return ""
	}
	return "已用 " + format(ratio.times(100)) + "%"
}

function achFooter() {
	let out = []
	out.push("<div style='color:#c9b45e;text-align:left'>")
	out.push("<b>刻痕的规矩（含数值预算，DESIGN.md §8.5）</b><br>")
	out.push("　每枚铭刻：热量 ×" + format(D(ACH_BAL.perAch)) + "，当前共 " +
		formatWhole(D(achievementCount())) + " 枚 → " + timesFormat(achInscriptionMult()) + "<br>")
	out.push("　凝时里程碑 5：上述倍数再 ×" + formatWhole(D(ACH_BAL.monumentMult)) +
		(achMonumentOn() ? "（已生效）" : "（未生效）") + "<br>")
	out.push("　「百万熔炉」×" + formatWhole(D(ACH_BAL.heatMillion)) + "　「千万熔炉」×" +
		formatWhole(D(ACH_BAL.heatTenMillion)) + "（专属热量）<br>")
	out.push("　「百锻成铭」×" + formatWhole(D(ACH_BAL.coreTempered)) + "＋「刻度之间」×" +
		formatWhole(D(ACH_BAL.corePerfect)) + " → 炉芯产出 " + timesFormat(achExclusiveCoreMult()) +
		"（上限 " + timesFormat(D(ACH_BAL.budgetCore)) + "）<br>")
	out.push("　heat 通道当前 " + timesFormat(achHeatChannel()) + "，硬上限 " + timesFormat(D(ACH_BAL.budgetHeat)) +
		"，全满理论值 " + timesFormat(achFullHeatBudget()) + (achOverBudget() ? "（<b>已顶到上限</b>）" : "") + "<br>")
	out.push("　看不见的格位 = 未知铭刻：把鼠标停在上面，能读出口供。<br>")
	out.push("　铭刻不参与任何重置：刻下的不会消失。")
	out.push("</div>")
	return out.join("")
}
