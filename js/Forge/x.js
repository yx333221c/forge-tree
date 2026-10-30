// ============================================================================
// 《熔炉之树 · The Forge Tree》 —— row 4：熔星（Starforge）
// 实现契约：DESIGN.md §5.5（配合 §3.2 钩子名、§3.5 引擎语义、§4 保留规则、§10 加载期约束）
// 货币：星核 Stellar Cores（base 资源 = 凝时层时序 player.t.points）
//
// 本层内容（§5.5 清单，保持终局简洁：无 buyables）：
//   * 先天效果（热量 / 四层产出 / 初始热量；点燃后再 +0.5 指数）
//   * 升级 11 恒星图纸 / 12 引力透镜 / 13 自动熔星 / 14 余烬循环
//   * 里程碑 0 保留反应可购件与熔炉燃料棒 / 1 开放结局 / 2 星核效果指数 +0.3
//   * clickable 11「点燃恒星 Ignite the Star」＝结局触发器（消耗与条件读全局 FORGE_END）
//   * hotkeys：x（熔星）
//
// 硬约定（与 t.js 一致）：
//   * 跨层加成一律 registerHook；不改写别的层的数据（本层重置的影响由各低层 doReset 负责）。
//   * 结局常量只用全局 FORGE_END.igniteCost / FORGE_END.igniteChallenges（mod.js 定义），
//     不再自定义星核消耗量，避免顶栏与按钮条件不一致。
//   * 自动化判定一律走 autoOn()（挑战 15「独断」期间自动失效）。
//   * 纯读函数无副作用；只有 update / automate / onPrestige / doReset / onClick 写状态。
//   * 加载期（addLayer 字面量求值时）不调用 format / 不读 player / 不调 hasUpgrade。
//   * 进 player 的一律 Decimal（ignited 是 boolean）；clickable state 只能 string/number。
//   * player.x.ignited 必须在 startData 里（mod.js 的 isEndgame() 读它；
//     forge 的 FORGE_ALWAYS_KEEP 也保留了它）。
// ============================================================================

var X_BAL = {
	// ---------- 熔星公式 ----------
	requires: 20,			// 多少时序换 1 星核（同时是本层解锁需求）
	baseExp: 0.3,			// 星核公式基础指数（写在 gainExp 里；exponent 字段固定 1，lead 的分工要求）
	expFloor: 0.05,			// 指数下限（NaN 防护）
	multFloor: 1e-300,		// 乘数下限（NaN / 归零防护）
	softcap: "1e60",		// 星核产出软上限
	softcapPower: 0.5,

	// ---------- 先天效果指数（§5.5）----------
	innateBase: 1,
	heatExp: 1.2,			// 星核 → 热量
	gainExp: 0.5,			// 星核 → 炉芯 / 锭条 / 触媒 / 时序 产出
	startExp: 2,			// 星核 → 初始热量
	igniteBonusExp: 0.5,	// keep going：点燃后上面的指数再 +0.5
	ms2BonusExp: 0.3,		// 里程碑 2：星核效果指数 +0.3

	// ---------- 数值预算（§8.5 修订版：软阈值 1e80，硬约束是「不得出现 Infinity/NaN」）----------
	// 星核是本树最顶层货币，会指数级膨胀；effCap/effSoft 是每条通道自己的形状上限，
	// 不再为全局 heat 总量压缩倍率常量（lead 已用 H_BAL.effHeatCap 封掉唯一的自乘回路）。
	// 本层通道天花板（点燃前后的最坏情况）：
	//   heat        ≤ 1e6 × 升级 1e8      = 1e14（硬 ×10）
	//   gain 四通道  ≤ 1e5                 = 1e6（硬 ×10）
	//   startPoints ≤ 1e9 × 升级 1e3      = 1e12（硬 ×10）
	//   stellarGain ≤ 1e12（只喂本层货币，不进 heat 回路）
	effCapHeat: "1e6",		// 星核 → 热量 通道上限
	effCapGain: "1e5",		// 星核 → 四层产出 通道上限
	effCapStart: "1e9",		// 星核 → 初始热量 通道上限
	effSoft: 0.4,			// 软上限压缩指数（§8.5 建议 0.3–0.5）
	hardTimes: 10,			// 硬上限 = 软上限 × 这个倍数（防 Infinity，不是平衡手段）

	// ---------- 星核产出（stellarGain 通道）----------
	// 引擎语义（§3.5）：星核 = (时序/20)^1 × stellarGain^0.3。指数 0.3 把乘数压缩了
	// 3.3 个数量级：×1e3 只等于 ×10 产出。§5.5 没给熔星任何产出乘数，实测（sim 240min）
	// 每次熔星只落 1–2 枚、一轮 ~300s，攒到 FORGE_END.igniteCost(1000) 需要 30 小时——结局不可达。
	// 所以本层里程碑配「产出乘数」，让 s → 点燃 的终局冲刺落在 §8 的 120–300 min 窗口里。
	// 这条通道**不进 heat 回路**（只影响本层货币），因此预算比 §8.5 的 1e6 宽：
	// 上限 1e12（^0.3 = 1e3.6 ≈ 4000 枚/次），由 xStellarFromMs 硬夹取。
	stellarMs: { 0: 100, 1: 100, 2: 100 },	// 里程碑 0/1/2 各自倍数；累计 = 100 / 1e4 / 1e6（≤1e12 上限）
	capStellar: "1e12",		// stellarGain 通道上限（本层自产，不参与 heat 回路）

	// ---------- 升级成本（星核）与数值（§5.5：1 / 2 / 5 / 10）----------
	upgCost: { 11: 1, 12: 2, 13: 5, 14: 10 },
	heat12: 1e8,			// 12 引力透镜：热量 ×1e8
	start14: 1e3,			// 14 余烬循环：初始热量 ×1e3

	// ---------- 里程碑门槛（累计星核）----------
	// 保持 DESIGN §5.5 原文 5 / 20 / 100。
	// （早期版本这里写成 1/20/100：当时 stellarGain 只有 ×30，bootstrap 每枚星核要等一整轮
	//   h→m→r→t（>10 分钟），结局永远走不到。现在里程碑 0 自带 ×100 产出，5 枚只需 5 轮，
	//   落在 §8「首次熔星 70–140 min → 点燃 120–300 min」的窗口里，不必再偏离契约。）
	msTotal: [5, 20, 100],

	// ---------- 结局（消耗与条件由 mod.js 的 FORGE_END 提供，这里只放兜底值）----------
	endCostFallback: 1000,
	endChalFallback: 3,
}

// ---------------- 只读小工具（纯函数，无副作用） ----------------
function xNum(x) { // Decimal | number -> Decimal，坏值归零
	if (x instanceof Decimal) return (x.isNan() || !x.isFinite()) ? decimalZero : x
	if (typeof x === "number") return isFinite(x) ? new Decimal(x) : decimalZero
	return decimalZero
}
function xHas(arr, id) {
	if (!arr || !arr.length) return false
	return arr.indexOf(id) >= 0 || arr.indexOf(String(id)) >= 0
}
function xUpg(id) {
	if (typeof player === "undefined" || !player || !player.x) return false
	return xHas(player.x.upgrades, id)
}
function xMs(id) {
	if (typeof player === "undefined" || !player || !player.x) return false
	return xHas(player.x.milestones, id)
}
function xPoints() { return forgeAmt("x") }
function xTotal() { return forgeTot("x") }
function xBest() { return forgeHasLayer("x") ? xNum(player.x.best) : decimalZero }
function xBase() { return forgeAmt("t") }
function xIgnited() { return (typeof player !== "undefined" && player && player.x) ? !!player.x.ignited : false }

// 乘法 / 加法 / 指数夹取
function xClampMult(v) {
	let d = xNum(v)
	if (d.lt(X_BAL.multFloor) || !d.isFinite()) return new Decimal(X_BAL.multFloor)
	return d
}
function xClampAdd(v) {
	let d = xNum(v)
	if (!d.isFinite()) return decimalZero
	return d
}
function xClampExp(v) {
	let d = xNum(v)
	if (!d.isFinite() || d.lt(X_BAL.expFloor)) return new Decimal(X_BAL.expFloor)
	return d
}
function xFoldMultSafe(name, start) {
	try { return xNum(foldMult(name, start)) } catch (e) { return D(start === undefined ? 1 : start) }
}

// ---------------- 结局常量（只用全局 FORGE_END；缺失时退回兜底值） ----------------
function xEndCost() {
	let v = (typeof FORGE_END !== "undefined" && FORGE_END) ? FORGE_END.igniteCost : X_BAL.endCostFallback
	let d = xNum(v)
	return d.gt(0) ? d : new Decimal(X_BAL.endCostFallback)
}
function xEndChallenges() {
	let v = (typeof FORGE_END !== "undefined" && FORGE_END) ? FORGE_END.igniteChallenges : X_BAL.endChalFallback
	let n = Math.floor(xNum(v).toNumber())
	return isFinite(n) && n > 0 ? n : X_BAL.endChalFallback
}
function xChalDone() {
	try { return completedChallengeCount() } catch (e) { return 0 }
}

// ---------------- 先天效果 ----------------
// 效果指数：基础 + 里程碑 2（+0.3） + 点燃后 keep going（+0.5）
function xInnateExp() {
	let e = new Decimal(X_BAL.innateBase)
	if (xMs(2)) e = e.plus(X_BAL.ms2BonusExp)
	if (xIgnited()) e = e.plus(X_BAL.igniteBonusExp)
	return xClampAdd(e)
}
function xInnateMult() { return decimalOne.plus(xPoints()).pow(xInnateExp()) }

// §8.5 数值预算：软上限（超过 cap 后按 effSoft 次幂继续长）＋ 硬上限（绝对封顶）。
function xEffSoft(v, cap) {
	let c = D(cap)
	if (!v.isFinite() || v.lte(0)) return decimalOne
	let hard = c.times(X_BAL.hardTimes)
	if (v.gt(hard)) return hard
	if (v.gt(c)) return c.times(v.div(c).pow(new Decimal(X_BAL.effSoft)))
	return v
}

function xEffHeat() { return xEffSoft(xInnateMult().pow(new Decimal(X_BAL.heatExp)), X_BAL.effCapHeat) }
function xEffGain() { return xEffSoft(xInnateMult().pow(new Decimal(X_BAL.gainExp)), X_BAL.effCapGain) }
function xEffStart() { return xEffSoft(xInnateMult().pow(new Decimal(X_BAL.startExp)), X_BAL.effCapStart) }

// 本层里程碑给的星核产出倍数（stellarGain 通道的唯一来源；见 X_BAL.stellarMs 注释）
function xStellarFromMs() {
	let m = decimalOne
	if (xMs(0)) m = m.times(X_BAL.stellarMs[0])
	if (xMs(1)) m = m.times(X_BAL.stellarMs[1])
	if (xMs(2)) m = m.times(X_BAL.stellarMs[2])
	// 显式预算上限（§8.5 第 2 条：乘法通道必须有硬上限）——本层货币自产自销，
	// 走的是 stellarGain 而不是 heat，所以只夹这一条通道，不影响 heat 总预算。
	let cap = new Decimal(X_BAL.capStellar)
	if (m.gt(cap)) m = cap
	return xClampMult(m)
}

// ---------------- 本层公式 ----------------
function xStellarExp() { return xClampExp(new Decimal(X_BAL.baseExp)) }
function xStellarMult() { return xClampMult(xFoldMultSafe("stellarGain", 1)) }

// ---------------- 钩子实现（每个都是纯读，返回 Decimal） ----------------
function xHookHeatInnate() { return xClampMult(xEffHeat()) }
function xHookCoreInnate() { return xClampMult(xEffGain()) }
function xHookIngotInnate() { return xClampMult(xEffGain()) }
function xHookCatalystInnate() { return xClampMult(xEffGain()) }	// static 层：directMult，>1 变强
function xHookChrononInnate() { return xClampMult(xEffGain()) }
function xHookStartInnate() { return xClampMult(xEffStart()) }

function xHookHeatUpg() { return xClampMult(xUpg(12) ? X_BAL.heat12 : 1) }
function xHookStartUpg() { return xClampMult(xUpg(14) ? X_BAL.start14 : 1) }
function xHookStellarMs() { return xStellarFromMs() }

// ============================================================
// 层定义
// ============================================================
addLayer("x", {
	name: "熔星",
	symbol: "X",
	position: 1,
	color: "#ffd700",
	row: 4,
	resource: "星核",
	baseResource: "时序",
	resetDescription: "熔星，压出 ",

	startData() {
		return {
			unlocked: false,
			points: decimalZero,
			best: decimalZero,
			total: decimalZero,
			resets: decimalZero,
			ignited: false,		// 结局标记（mod.js 的 isEndgame() 读它；FORGE_ALWAYS_KEEP 保留它）
			clickables: { 11: "未点燃" },
		}
	},

	// ---------- 公式（normal；§3.5：exponent = 1，指数由 gainExp 提供）----------
	type: "normal",
	exponent: 1,
	baseAmount() { return xBase() },
	requires: new Decimal(X_BAL.requires),
	softcap: new Decimal(X_BAL.softcap),
	softcapPower: new Decimal(X_BAL.softcapPower),

	gainExp() { return xStellarExp() },
	gainMult() { return xStellarMult() },
	directMult() { return decimalOne },

	// ---------- 先天效果 ----------
	effect() {
		return {
			heat: xEffHeat(),
			gain: xEffGain(),
			start: xEffStart(),
			innate: xInnateMult(),
		}
	},
	effectDescription() {
		let s = "星核 " + formatWhole(xPoints()) + "（效果指数 " + format(xInnateExp()) + "）正在把" +
			"热量放大 " + timesFormat(xEffHeat()) +
			"，炉芯／锭条／触媒／时序产出放大 " + timesFormat(xEffGain()) +
			"，重置后的初始热量抬高 " + timesFormat(xEffStart())
		if (xIgnited()) s += "。<br><b style='color:#ffd700'>恒星已经点燃：效果指数再 +" + format(new Decimal(X_BAL.igniteBonusExp)) + "</b>（keep going 强化）"
		else s += "。<br>点燃恒星后，这份放大还会再强 +" + format(new Decimal(X_BAL.igniteBonusExp)) + " 指数"
		return s
	},

	// ---------- 显示 ----------
	layerShown() { return forgeHasUnlocked("t") || forgeHasUnlocked("x") },
	tooltipLocked() {
		let req = new Decimal(X_BAL.requires)
		let cur = xBase()
		return "需要 <b>" + formatWhole(req) + "</b> 时序才能点燃熔星（当前 " + formatWhole(cur) + "）<br>" +
			"熔星是全树的最顶层：星核放大一切，也承载结局「点燃恒星」。" +
			(cur.gte(req) ? "<br>已达标：点击节点，把时间压进核里。" : "<br>时序来自凝时（Tempo）层。")
	},
	tooltip() {
		let tip = "星核 " + formatWhole(xPoints()) + "（累计 " + formatWhole(xTotal()) + "）　热量 " + timesFormat(xEffHeat()) +
			"　效果指数 " + format(xInnateExp())
		if (xIgnited()) tip += "<br><b style='color:#ffd700'>恒星已点燃</b>"
		else if (xMs(1)) tip += "<br>点火条件：星核 " + formatWhole(xPoints()) + " / " + formatWhole(xEndCost()) +
			"　挑战 " + xChalDone() + " / " + xEndChallenges()
		return tip
	},
	nodeStyle() { return { 'color': "#ffe89a", 'text-decoration': "underline" } },
	glowColor: "#ffd700",

	// ---------- 每 tick（本层没有需要计时的事，留给结局后的粒子与未来扩展）----------
	update(diff) {
		if (!forgeHasLayer("x")) return
		// 星核是本层货币，由引擎的 passiveGeneration / doReset 处理；
		// 这里只做一件事：保证结局后的状态字符串与 ignited 一致（纯状态同步，可安全重复）。
		let want = xIgnited() ? "已点燃" : (xIgniteCan() ? "可点燃" : "未点燃")
		if (player.x.clickables[11] !== want) player.x.clickables[11] = want
	},

	// 自动熔星（升级 13）；走 autoOn()，挑战 15「独断」期间失效
	autoPrestige() { return autoOn(xUpg(13)) },
	automate() {
		if (!forgeHasUnlocked("x")) return
		// 凝时里程碑 1 的「自动购买所有层升级」由 hasMilestone('t',1) 约定；
		// 这里自己买本层升级，好让挑战 15 也能真正断掉。
		if (autoOn(xTMs(1))) {
			for (let id in layers.x.upgrades) {
				if (!isNaN(id) && canAffordUpgrade("x", id) && !xUpg(id)) buyUpg("x", id)
			}
		}
	},

	// ---------- 重置规则（§4）----------
	doReset(resettingLayer) {
		if (!forgeHasLayer("x")) return
		// 熔星之上没有更高层：只有「x 自己」会走到这里，而自己的熔星不清自己的星核／升级。
		// 它的影响（清空 row0-3，含凝时的低层）由各层自己的 doReset 负责：
		//   h ← hasMilestone("x",0) 保留燃料棒；t ← x 里程碑 0 / 升级 11 保留凝时升级。
		// 保持调用 forgeDoReset 的语义：同或更低行的重置者不清空本层。
		forgeDoReset("x", resettingLayer)
	},

	onPrestige() {
		if (forgeHasLayer("x")) player.x.resets = xNum(player.x.resets).plus(1)
	},

	// ---------- 快捷键 ----------
	hotkeys: [
		{
			key: "x",
			description: "X：熔星，用时序压出星核（会重置熔炉・锻造・反应・凝时）",
			onPress() { if (canReset("x")) doReset("x") },
		},
	],

	// ============================================================
	// 升级（成本 = 星核；§5.5）
	// ============================================================
	upgrades: {
		11: {
			title: "恒星图纸",
			description: "<b>凝时</b>的升级在熔星重置中保留下来（§4）。<br><i>影响凝时（Tempo）层，由它的 doReset 读取。</i>",
			cost() { return xUpgCost(11) },
			tooltip: "与凝时里程碑 0「保留反应可购件」叠加：任何一条都能留住凝时升级。",
		},
		12: {
			title: "引力透镜",
			description() { return "热量 ×" + format(new Decimal(X_BAL.heat12)) + "。<br><i>影响热量（全局）。</i>" },
			cost() { return xUpgCost(12) },
		},
		13: {
			title: "自动熔星",
			description: "熔星全自动：一达到收益门槛就自己压星核。<br><i>影响本层 autoPrestige；挑战「独断」期间失效。</i>",
			cost() { return xUpgCost(13) },
		},
		14: {
			title: "余烬循环",
			description() { return "重置后的初始热量 ×" + format(new Decimal(X_BAL.start14)) + "。<br><i>影响 startPoints（全局）。</i>" },
			cost() { return xUpgCost(14) },
		},
	},

	// ============================================================
	// 里程碑（累计星核；§5.5）
	// ============================================================
	milestones: {
		0: {
			requirementDescription() { return "累计 " + formatWhole(new Decimal(X_BAL.msTotal[0])) + " 星核（当前 " + formatWhole(xTotal()) + "）" },
			done() { return xTotal().gte(X_BAL.msTotal[0]) },
			effectDescription: "熔星重置时保留<b>反应的可购项</b>与<b>熔炉燃料棒</b>（§4，由 h／r 的 doReset 读取）。",
			tooltip: "同时也保留凝时的升级（与恒星图纸任一条满足即可）。",
		},
		1: {
			requirementDescription() { return "累计 " + formatWhole(new Decimal(X_BAL.msTotal[1])) + " 星核（当前 " + formatWhole(xTotal()) + "）" },
			done() { return xTotal().gte(X_BAL.msTotal[1]) },
			effectDescription() {
				return "解锁终局按钮「点燃恒星」的可见性。<br>当前条件：星核 <b>" + formatWhole(xPoints()) + "</b> / " +
					formatWhole(xEndCost()) + "　已完成挑战 <b>" + xChalDone() + "</b> / " + xEndChallenges()
			},
		},
		2: {
			requirementDescription() { return "累计 " + formatWhole(new Decimal(X_BAL.msTotal[2])) + " 星核（当前 " + formatWhole(xTotal()) + "）" },
			done() { return xTotal().gte(X_BAL.msTotal[2]) },
			effectDescription() { return "星核效果指数 +" + format(new Decimal(X_BAL.ms2BonusExp)) +
				"（当前 " + format(xInnateExp()) + "）。" },
		},
	},

	// ============================================================
	// clickable：11「点燃恒星」＝结局触发器
	// ============================================================
	clickables: {
		11: {
			title: "点燃恒星 Ignite the Star",
			unlocked() { return xMs(1) },
			canClick() { return xIgniteCan() },
			onClick() { xIgniteTrigger() },
			effect() { return { ready: xIgniteCan(), cost: xEndCost(), chals: xChalDone(), need: xEndChallenges() } },
			display() {
				if (xIgnited()) {
					return "<b style='color:#ffd700'>恒星已点燃</b><br>虚空里有了第一颗自己的星。<br>" +
						"效果指数 +" + format(new Decimal(X_BAL.igniteBonusExp)) + "（keep going）<br>" +
						"当前星核效果指数：" + format(xInnateExp())
				}
				let c1 = xPoints().gte(xEndCost())
				let c2 = xChalDone() >= xEndChallenges()
				return "消耗 <b>" + formatWhole(xEndCost()) + "</b> 星核，点亮第一颗恒星。<br>" +
					"① 星核：" + (c1 ? "<b style='color:#b6f5b1'>已满足</b>" : "未满足") + "　" +
					fmtTarget(xPoints(), xEndCost(), "星核") + "<br>" +
					"② 时间挑战：" + (c2 ? "<b style='color:#b6f5b1'>已满足</b>" : "未满足") + "　已完成 " +
					xChalDone() + " / " + xEndChallenges() + "<br>" +
					(c1 && c2 ? "<b style='color:#ffd700'>条件齐备：点火。</b>" : "两项都齐备才能点燃。点燃后仍可继续游玩。")
			},
			style() {
				if (xIgnited()) return { 'background-color': "#8a6d00", 'box-shadow': "0 0 22px #ffd700" }
				if (xIgniteCan()) return { 'background-color': "#ffd700", 'color': "#2b1a00", 'box-shadow': "0 0 26px #ffd700" }
				return {}
			},
			tooltip() { return "结局：消耗 " + formatWhole(xEndCost()) + " 枚星核，并交出凝时的三段记忆，换来一颗真正会发光的星。" },
		},
	},

	componentStyles: {
		"prestige-button"() { return { 'width': "250px", 'height': "86px" } },
		"clickable"() { return { 'height': "190px", 'width': "300px" } },
	},

	// ============================================================
	// 界面：主界面 ＋ 终局
	// ============================================================
	tabFormat: {
		"主界面": {
			content: [
				"main-display",
				"resource-display",
				["blank", "6px"],
				["raw-html", function () { return xReport() }],
				["blank", "8px"],
				"prestige-button",
				["blank", "10px"],
				"milestones",
				["blank", "10px"],
				"upgrades",
				["blank", "10px"],
				["raw-html", function () { return xFormulaReport() }],
			],
		},
		"终局": {
			content: [
				["raw-html", function () { return xEndHeader() }],
				["blank", "10px"],
				["bar", "igniteBar"],
				["blank", "12px"],
				["clickable", 11],
				["blank", "14px"],
				["infobox", "lore"],
			],
			unlocked() { return xTotal().gt(0) },
			glowColor: "#ffd700",
			shouldNotify: true,
		},
	},

	bars: {
		igniteBar: {
			fillStyle: { 'background-color': "#ffd700" },
			baseStyle: { 'background-color': "#2b2200" },
			textStyle: { 'color': '#fff4c2' },
			borderStyle() { return { 'border-width': "2px" } },
			direction: RIGHT,
			width: 340,
			height: 30,
			unlocked() { return xMs(1) },
			progress() {
				if (xIgnited()) return 1
				let a = Math.min(xPoints().div(xEndCost()).toNumber(), 1)
				let b = Math.min(xChalDone() / xEndChallenges(), 1)
				return (a + b) / 2
			},
			display() {
				if (xIgnited()) return "恒星已点燃"
				return "点火进度：星核 " + formatWhole(xPoints()) + " / " + formatWhole(xEndCost()) +
					"　挑战 " + xChalDone() + " / " + xEndChallenges()
			},
		},
	},

	infoboxes: {
		lore: {
			title: "炉边记事 · 熔星",
			body: "熔炉、锻台、反应釜、凝时槽——它们全都是同一件事的四个步骤：<br>" +
				"把冷的那一边往你这边搬。<br><br>" +
				"星核是最后一步。它不产生热量，它<b>决定</b>热量值多少。<br>" +
				"当你手里攒够一千枚星核、并且真的交出了六段时间里的三段，" +
				"你就不必再烧炉子了——你会成为发光的那一个。<br>" +
				"点燃之后炉子还在响。留着它，把剩下的时间也刻完。",
			titleStyle: { 'color': "#ffd700" },
		},
	},
})

// ============================================================
// 结局判定与触发（onClick / update 调用）
// ============================================================
function xIgniteCan() {
	if (!forgeHasUnlocked("x") || !xMs(1) || xIgnited()) return false
	return xPoints().gte(xEndCost()) && xChalDone() >= xEndChallenges()
}

function xIgniteTrigger() {
	if (!xIgniteCan()) return
	player.x.points = xPoints().minus(xEndCost())
	player.x.ignited = true
	player.x.clickables[11] = "已点燃"
	doPopup("challenge", "第一颗恒星在你的熔炉中点亮了。", "点燃成功！", 8, "#ffd700")
}

// ============================================================
// 文本报告（纯读）
// ============================================================
function xUpgCost(id) {
	let base = new Decimal(X_BAL.upgCost[id] || 1)
	let v = base
	try { v = xNum(upgradeCostFinal(base)) } catch (e) { v = base }
	if (!v.isFinite() || v.lte(0)) v = base
	return v
}

function xNextMilestone() {
	for (let i = 0; i < X_BAL.msTotal.length; i++) {
		if (!xMs(i)) return { id: i, goal: new Decimal(X_BAL.msTotal[i]) }
	}
	return null
}

function xEndHeader() {
	let done = xChalDone()
	let need = xEndChallenges()
	let s = "<div style='color:#fff4c2'><h3>点燃恒星</h3><br>"
	if (xIgnited()) {
		return s + "<b style='color:#ffd700'>恒星已点燃。</b>熔炉没有停，只是不再需要被证明了。<br>" +
			"keep going：星核效果指数 +" + format(new Decimal(X_BAL.igniteBonusExp)) + "，当前 " + format(xInnateExp()) + "</div>"
	}
	if (!xMs(1)) {
		return s + "需要先达成里程碑「累计 " + formatWhole(new Decimal(X_BAL.msTotal[1])) + " 星核」，" +
			"结局按钮才会出现（当前累计 " + formatWhole(xTotal()) + "）。</div>"
	}
	s += "两个条件（消耗与挑战数由 mod.js 的 FORGE_END 统一规定）：<br>" +
		"　① 持有星核 " + (xPoints().gte(xEndCost()) ? "<b style='color:#b6f5b1'>已满足</b>" : "未满足") + "：" +
		fmtTarget(xPoints(), xEndCost(), "星核") + "<br>" +
		"　② 已完成凝时挑战 " + (done >= need ? "<b style='color:#b6f5b1'>已满足</b>" : "未满足") + "：" +
		fmtTarget(D(done), D(need), "个") + "<br>" +
		"点燃会扣除 " + formatWhole(xEndCost()) + " 枚星核，但不会毁掉任何东西——你可以继续游玩，而且星核的放大更强。"
	s += "</div>"
	return s
}

function xReport() {
	let lines = []
	lines.push("<div style='color:#fff4c2'>")
	lines.push("<h3>熔星读数</h3>")
	lines.push("时序 <b>" + formatWhole(xBase()) + "</b> ／ 门槛 " + formatWhole(new Decimal(X_BAL.requires)) + "<br>")
	lines.push("星核 <b>" + formatWhole(xPoints()) + "</b>（累计 " + formatWhole(xTotal()) + "，最高 " + formatWhole(xBest()) + "）<br>")
	lines.push("公式指数 <b>" + format(xStellarExp()) + "</b>　乘数 <b>" + timesFormat(xStellarMult()) + "</b><br>")
	lines.push("效果指数 <b>" + format(xInnateExp()) + "</b>　效果倍数 <b>" + timesFormat(xInnateMult()) + "</b><br>")
	let sp = decimalOne
	try { sp = D(getStartPoints()) } catch (e) { sp = decimalOne }
	lines.push("重置后初始热量：<b>" + format(sp) + "</b><br>")
	lines.push("熔炼 " + formatWhole(xResets("h")) + " 次　凝时 " + formatWhole(xResets("t")) +
		" 次　已完成挑战 <b>" + xChalDone() + " / 6</b>　铭刻 <b>" + achCount() + "</b><br>")
	let next = xNextMilestone()
	lines.push("<br>下一个里程碑：" + (next ? fmtTarget(xTotal(), next.goal, "累计星核") : "全部达成") + "<br>")
	lines.push("自动熔星：" + (autoOn(xUpg(13)) ? "<b>已开启</b>" : "未开启") +
		(xUpg(13) && inTime(15) ? "（挑战「独断」中失效）" : "") + "<br>")
	if (xIgnited()) lines.push("<b style='color:#ffd700'>恒星已点燃：效果指数再 +" + format(new Decimal(X_BAL.igniteBonusExp)) + "</b><br>")
	else if (xMs(1)) lines.push("点火条件：星核 " + formatWhole(xPoints()) + " / " + formatWhole(xEndCost()) +
		"　挑战 " + xChalDone() + " / " + xEndChallenges() + "<br>")
	else lines.push("点火条件尚未开放（需累计 " + formatWhole(new Decimal(X_BAL.msTotal[1])) + " 星核）<br>")
	lines.push("</div>")
	return lines.join("")
}

function xFormulaReport() {
	let s = "<div style='color:#fff4c2;text-align:left'>"
	s += "<h3>熔星参数</h3>"
	s += "星核 = （时序 ÷ " + formatWhole(new Decimal(X_BAL.requires)) + "）^ " + format(xStellarExp()) +
		" × 乘数 " + format(xStellarMult()) + "<br>"
	s += "　乘数 = foldMult(\"stellarGain\", 1)（全部来自别的层与本层的钩子）<br><br>"
	s += "<b>本层给下游的加成</b><br>"
	s += "　热量：" + timesFormat(xEffHeat()) + " × 升级 " + timesFormat(xHookHeatUpg()) + "<br>"
	s += "　炉芯／锭条／触媒／时序产出：" + timesFormat(xEffGain()) + "<br>"
	s += "　初始热量：" + timesFormat(xEffStart()) + " × 升级 " + timesFormat(xHookStartUpg()) + "<br>"
	s += "　效果指数 = 1 ＋ 里程碑2 " + (xMs(2) ? format(new Decimal(X_BAL.ms2BonusExp)) : "0") +
		" ＋ 点燃后 " + (xIgnited() ? format(new Decimal(X_BAL.igniteBonusExp)) : "0") + "<br>"
	s += "</div>"
	return s
}

function achCount() {
	try { return achievementCount() } catch (e) { return 0 }
}
function xResets(layer) {
	if (!forgeHasLayer(layer)) return decimalZero
	let v = player[layer].resets
	return v instanceof Decimal ? v : xNum(v)
}
function xTMs(id) {
	if (!forgeHasLayer("t")) return false
	try { return !!hasMilestone("t", id) } catch (e) { return false }
}

// ============================================================
// 钩子注册（加载期，一次性；见 DESIGN.md §3.2）
// ============================================================
function xRegister(name, fn, priority) {
	try {
		registerHook(name, fn, priority)
	} catch (e) {
		console.error("Forge[x] hook register failed: " + name, e)
	}
}

// 先天（§5.5：热量 ^1.2、四层产出 ^0.5、初始热量 ^2）
xRegister("heat", xHookHeatInnate)
xRegister("coreGain", xHookCoreInnate)
xRegister("ingotGain", xHookIngotInnate)
xRegister("catalystDirect", xHookCatalystInnate)	// static 层：directMult 直接乘产出（>1 变强）
xRegister("chrononGain", xHookChrononInnate)
xRegister("startPoints", xHookStartInnate)

// 升级
xRegister("heat", xHookHeatUpg)
xRegister("startPoints", xHookStartUpg)

// 本层里程碑 → 星核产出（stellarGain 通道；§5.5 没给别的乘数，见 X_BAL.stellarMs 注释）
xRegister("stellarGain", xHookStellarMs)
