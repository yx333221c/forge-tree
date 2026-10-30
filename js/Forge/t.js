// ============================================================================
// 《熔炉之树 · The Forge Tree》 —— row 3：凝时（Tempo）
// 实现契约：DESIGN.md §5.4（配合 §3.2 钩子名、§3.5 引擎语义、§4 保留规则、§10 加载期约束）
// 货币：时序 Chronons（base 资源 = 反应层触媒 player.r.points）
//
// 本层内容：
//   * 先天效果（热量 / 炉芯·锭条·时序产出 / 初始热量 / 中层公式指数）
//   * 升级 11..32（31「时之流」与 32「时之滞」互斥）
//   * 里程碑 0..5（全树自动化中枢）
//   * 挑战 11..16（6 个全部实现；进入 = doReset('t', true) 清空 row0-2，本层保留）
//   * clickable 11「过载 Surge」、clickable 12「时之砂 Hourglass」
//   * hotkeys：t（凝时）/ ctrl+t（过载）
//
// 硬约定（全员一致）：
//   * 跨层加成一律 registerHook；绝不直接改写别的层的数据。
//   * 跨层 debuff 判定一律用 helpers 的 inTime(id)（裸 inChallenge 在缺层时会抛）。
//   * 自动化判定一律走 autoOn()（内部已处理挑战 15「独断」）。
//   * 纯读函数（unlocked / canAfford / effect / cost / display / gainMult / gainExp /
//     canComplete / layerShown / tooltip / requirementDescription）无副作用；
//     只有 update / automate / onPrestige / doReset / onClick / onHold / onComplete 写状态。
//   * 加载期（addLayer 字面量求值时）不调用 format / 不读 player / 不调 hasUpgrade。
//   * 进 player 的一律 Decimal（布尔除外）；clickable 的 state 只能是 string/number。
//   * 挑战 debuff 用「本层注册的乘性削弱钩子」实现；绝不使用 deactivated
//     —— 那会连本层奖励与里程碑一起屏蔽，造成永久死档。
//
// 交给 lead 的集成点（本层已把数值备好，各只欠一行接线）：
//   1) h.js 的 passiveGeneration 目前 = foldAdd("hPassiveAdd", 0).toNumber()；
//      契约 §5.4 里程碑 3「熔炼全自动」与挑战 16 奖励需要它 += forgeHearthAutoGen()。
//   2) r.js 的 autoPrestige 目前 = autoOn(rFlag("autoRun") && rMs("r",3))；
//      契约 §5.4 里程碑 4「自动反应（覆盖 r 的 autoPrestige）」需要它 || forgeAutoReaction()。
//   （这两个函数内部已走 autoOn，所以挑战 15「独断」会自动生效。）
// ============================================================================

var T_BAL = {
	// ---------- 凝时公式 ----------
	requires: 10,			// 多少触媒换 1 时序（同时是本层解锁需求）
	baseExp: 0.35,			// 时序公式基础指数（写在 gainExp 里；exponent 字段固定 1）
	expFloor: 0.05,			// 指数下限（NaN 防护）
	multFloor: 1e-300,		// 乘数下限（NaN / 归零防护）
	softcap: "1e75",		// 时序产出软上限
	softcapPower: 0.5,

	// ---------- 先天效果指数（§5.4）----------
	innateBase: 1,			// 先天效果指数的基础值
	heatExp: 0.6,			// 时序 → 热量
	gainExp: 0.3,			// 时序 → 炉芯 / 锭条 / 时序 产出
	startExp: 1,			// 时序 → 初始热量
	midExp: 0.01,			// 时序 → coreExpBonus / ingotExpBonus
	midExpCap: 0.15,		// 上面两项的封顶

	// ---------- 数值预算（§8.5 强制：每条乘法通道必须有显式上限）----------
	// 时序会被高层指数级放大，(1+时序)^指数 不设限就会把全局推爆（实测过 1e73/s）。
	// 超过 cap 后按 effSoft 次幂压缩（多项式尾巴），再套一层硬上限（cap × hardTimes）绝对封顶。
	// 预算分配（最坏情况的硬天花板，供 tools/test-side.js / tools/sim.js 的 §8.5 守卫核对）。
// 注意口径：DESIGN.md §8.5 已修订 —— 旧值「全局 heat 乘积 1e40」作废（与 §5 的静态奖励自相矛盾），
// 现在是「硬约束：全程不得出现 Infinity/NaN；软阈值 1e80」，判失控看曲线形状不看绝对值。
	//   heat 通道本层贡献 ≤ 1e3→1e4(硬) × 升级 1e7 × 奖励 1e5 × 过载 20
	//   coreGain/ingotGain/chrononGain ≤ 1e3→1e4(硬) × 升级 20 × 过载 3
	//   startPoints ≤ 1e6→1e7(硬)
	//   时之砂 ≤ 1.1^100 ≈ 1.4e4（在 chrononGain 通道内）
	effCapHeat: "1e3",		// 时序→热量 通道上限
	effCapGain: "1e3",		// 时序→炉芯/锭条/时序 通道上限
	effCapStart: "1e6",		// 时序→初始热量 通道上限
	effSoft: 0.4,			// 软上限压缩指数（§8.5 建议 0.3–0.5）
	hardTimes: 10,			// 硬上限 = 软上限 × 这个倍数

	// ---------- 升级成本（时序）与数值 ----------
	upgCost: { 11: 1, 12: 2, 13: 3, 14: 5, 21: 10, 22: 15, 23: 25, 24: 40, 31: 60, 32: 60 },
	heat13: 10,				// 13 加速衰变：热量 ×10
	lens14: 0.1,			// 14 Chronon 透镜：先天效果指数 +0.1
	blast21: 0.05,			// 21 相位鼓风：炉芯公式指数 +0.05
	pulse23: 10,			// 23 脉冲回收：泄压收益 ×10
	grain24: 100,			// 24 沧海一粟：热量 ×100
	flow31Rate: 3,			// 31 时之流：炉压增速 ×3
	flow31Heat: 1e4,		// 31 时之流：热量 ×1e4
	drag32Gain: 20,			// 32 时之滞：炉芯 / 锭条产出 ×20
	drag32Cost: 0.6,		// 32 时之滞：buyableCost ×0.6

	// ---------- 里程碑门槛（累计时序）与数值 ----------
	msTotal: [1, 5, 20, 50, 100, 300],
	autoHearthGen: 1,		// 里程碑 3：熔炉每秒自动完成的熔炼次数
	ms5AchBonus: 0.2,		// 里程碑 5：铭刻热量加成 +0.2（ach.js 已有等价实现，本值仅作契约备份）

	// ---------- 挑战 debuff（乘性削弱，全部由本层钩子施加）----------
	t11CoreCut: 0.01,		// 11 冷炉：兜底——其它来源喂给 coreGain 的加成 ×0.01
	t12RateCut: 0.01,		// 12 无压：炉压增速 ×0.01（炉压形同不存在）
	t12VentCut: 0.05,		// 12 无压：泄压收益 ×0.05
	t14HeatCut: 0.01,		// 14 迟缓：热量 ×0.01
	t16HeatCut: 0.1,		// 16 归零：热量 ×0.1
	t16StartCut: 0.01,		// 16 归零：初始热量 ×0.01

	// ---------- 挑战目标与奖励（永久，hasChallenge 判定）----------
	goal11: 1e4,			// 11 冷炉   目标：炉芯
	goal12: 1e3,			// 12 无压   目标：锭条
	goal13: 6,				// 13 贫瘠   目标：触媒
	goal14: 12,				// 14 迟缓   目标：触媒
	goal15: 2,				// 15 独断   目标：单次凝时收益
	goal16: 20,				// 16 归零   目标：触媒
	rw11Heat: 1e3,			// 11 → 热量 ×1e3
	rw12PressureExp: 0.1,	// 12 → 炉压指数 +0.1
	rw13BuyableCost: 0.75,	// 13 → 所有可购项成本 ×0.75
	rw14InnateExp: 0.15,	// 14 → 本层先天效果指数 +0.15
	rw15Chronon: 2,			// 15 → 时序产出 ×2
	rw16Heat: 100,			// 16 → 热量 ×100
	rw16HearthGen: 1,		// 16 → 熔炉 passiveGeneration +1

	// ---------- 过载 Surge ----------
	surgeHeat: 20,			// 持续期内热量 ×20
	surgeCore: 3,			// 持续期内炉芯产出 ×3
	surgeChronon: 2,		// 持续期内时序产出 ×2
	surgeDuration: 30,		// 持续（游戏秒）
	surgeCooldown: 300,		// 冷却（游戏秒）
	surgeShowAfter: 60,		// 冷却剩余多少秒内开始亮起

	// ---------- 时之砂 ----------
	hourglassCost: 3,		// 每颗花费 3 时序
	hourglassMult: 1.1,		// 每颗：时序产出 ×1.1（永久叠加，被更高层重置时清空）
	hourglassCap: 140,		// 计数上限：§8.5 乘法通道预算 1.1^140 ≈ 7.1e5 ≤ 1e6

	// ---------- 解锁 ----------
	unlockTotal: 1,			// 本层累计 1 时序后才开放挑战 11
}

// ---------------- 只读小工具（纯函数，无副作用） ----------------
function tNum(x) { // Decimal | number -> Decimal，坏值归零
	if (x instanceof Decimal) return (x.isNan() || !x.isFinite()) ? decimalZero : x
	if (typeof x === "number") return isFinite(x) ? new Decimal(x) : decimalZero
	return decimalZero
}
function tHas(arr, id) { // upgrades / milestones 存的是字符串 id，两种都认
	if (!arr || !arr.length) return false
	return arr.indexOf(id) >= 0 || arr.indexOf(String(id)) >= 0
}
function tUpg(id) {
	if (typeof player === "undefined" || !player || !player.t) return false
	return tHas(player.t.upgrades, id)
}
function tMs(id) {
	if (typeof player === "undefined" || !player || !player.t) return false
	return tHas(player.t.milestones, id)
}
function tChal(id) { // 完成过（挑战完成计数不会被任何重置清掉）
	if (typeof player === "undefined" || !player || !player.t || !player.t.challenges) return false
	return player.t.challenges[id] > 0
}
function tFlag(name) { return (typeof player !== "undefined" && player && player.t) ? !!player.t[name] : false }
function tFlagText(name, label) { return "「" + label + "」：" + (tFlag(name) ? "<b>已开启</b>" : "未开启") }
function tPoints() { return (typeof player !== "undefined" && player && player.t) ? tNum(player.t.points) : decimalZero }
function tTotal() { return (typeof player !== "undefined" && player && player.t) ? tNum(player.t.total) : decimalZero }
function tBest() { return (typeof player !== "undefined" && player && player.t) ? tNum(player.t.best) : decimalZero }
function tBase() { return forgeAmt("r") }

// 挑战 debuff 判定（helpers 的安全版，缺层不抛）
function tIn(id) { return inTime(id) }

// 乘法夹取：拒绝 NaN / Infinity / 过小
function tClampMult(v) {
	let d = tNum(v)
	if (d.lt(T_BAL.multFloor) || !d.isFinite()) return new Decimal(T_BAL.multFloor)
	return d
}
// 加法夹取：拒绝 NaN / Infinity
function tClampAdd(v) {
	let d = tNum(v)
	if (!d.isFinite()) return decimalZero
	return d
}
function tClampExp(v) {
	let d = tNum(v)
	if (!d.isFinite() || d.lt(T_BAL.expFloor)) return new Decimal(T_BAL.expFloor)
	return d
}
function tFoldMultSafe(name, start) {
	try { return tNum(foldMult(name, start)) } catch (e) { return D(start === undefined ? 1 : start) }
}
function tFoldAddSafe(name, start) {
	try { return tNum(foldAdd(name, start)) } catch (e) { return D(start === undefined ? 0 : start) }
}

// ---------------- 先天效果 ----------------
function tInnateExp() { // 基础 + Chronon 透镜 + 挑战 14 奖励
	let e = new Decimal(T_BAL.innateBase)
	if (tUpg(14)) e = e.plus(T_BAL.lens14)
	if (tChal(14)) e = e.plus(T_BAL.rw14InnateExp) // 熬过迟缓，时间本身更浓
	return tClampAdd(e)
}
function tInnateMult() { return decimalOne.plus(tPoints()).pow(tInnateExp()) }

// §8.5 数值预算：软上限（超过 cap 后按 effSoft 次幂继续长）＋ 硬上限（绝对封顶）。
function tEffSoft(v, cap) {
	let c = D(cap)
	if (!v.isFinite() || v.lte(0)) return decimalOne
	let hard = c.times(T_BAL.hardTimes)
	if (v.gt(hard)) return hard
	if (v.gt(c)) return c.times(v.div(c).pow(new Decimal(T_BAL.effSoft)))
	return v
}

function tEffHeat() { return tEffSoft(tInnateMult().pow(new Decimal(T_BAL.heatExp)), T_BAL.effCapHeat) }
function tEffGain() { return tEffSoft(tInnateMult().pow(new Decimal(T_BAL.gainExp)), T_BAL.effCapGain) }
function tEffStart() { return tEffSoft(tInnateMult().pow(new Decimal(T_BAL.startExp)), T_BAL.effCapStart) }
function tEffMidExp() { return new Decimal(T_BAL.midExp).times(tPoints()).min(T_BAL.midExpCap).max(0) }

function tChalHeatReward() {
	let m = decimalOne
	if (tChal(11)) m = m.times(T_BAL.rw11Heat)
	if (tChal(16)) m = m.times(T_BAL.rw16Heat)
	return m
}

// ---------------- 过载 Surge（倒计时由 update 递减；只用游戏时间，离线不穿帮） ----------------
function tSurgeLeft() { return forgeHasLayer("t") ? tNum(player.t.surgeLeft) : decimalZero }
function tSurgeCdLeft() { return forgeHasLayer("t") ? tNum(player.t.surgeCdLeft) : decimalZero }
function tSurgeActive() { return tSurgeLeft().gt(0) }
function tSurgeCan() {
	if (!forgeHasUnlocked("t") || !tMs(0)) return false
	return tSurgeLeft().lte(0) && tSurgeCdLeft().lte(0)
}
function tSurgeState() { // 状态机字符串（clickable state 只能是 string/number）
	if (tSurgeActive()) return "过载!"
	if (tSurgeCdLeft().gt(0)) return "冷却"
	return "就绪"
}

// ---------------- 时之砂 ----------------
function tHourglassCount() { return forgeHasLayer("t") ? tNum(player.t.hourglasses) : decimalZero }
function tHourglassMult() {
	let n = tHourglassCount().max(0)
	if (n.gt(T_BAL.hourglassCap)) n = new Decimal(T_BAL.hourglassCap)
	return tClampMult(Decimal.pow(new Decimal(T_BAL.hourglassMult), n))
}
function tHourglassCan() { return forgeHasUnlocked("t") && tPoints().gte(new Decimal(T_BAL.hourglassCost)) }

// ---------------- 本层公式 ----------------
function tChrononExp() { // 写在 gainExp 里（§3.5：exponent = 1）
	let e = new Decimal(T_BAL.baseExp).add(tFoldAddSafe("chrononExpBonus", 0))
	return tClampExp(e)
}
function tChrononMult() { // 写在 gainMult 里（§5.4 关键要点）
	return tClampMult(tFoldMultSafe("chrononGain", 1))
}

// ---------------- 钩子实现（每个都是纯读，返回 Decimal） ----------------
// 先天
function tHookHeatInnate() { return tClampMult(tEffHeat()) }
function tHookCoreInnate() { return tClampMult(tEffGain()) }
function tHookIngotInnate() { return tClampMult(tEffGain()) }
function tHookChrononInnate() { return tClampMult(tEffGain()) }
function tHookStartInnate() { return tClampMult(tEffStart()) }
function tHookCoreExpBonus() { return tClampAdd(tEffMidExp().plus(tUpg(21) ? T_BAL.blast21 : 0)) }
function tHookIngotExpBonus() { return tClampAdd(tEffMidExp()) }

// 本层升级
function tHookHeatUpg() {
	let m = decimalOne
	if (tUpg(13)) m = m.times(T_BAL.heat13)
	if (tUpg(24)) m = m.times(T_BAL.grain24)
	if (tUpg(31)) m = m.times(T_BAL.flow31Heat)
	return tClampMult(m)
}
function tHookCoreUpg() { return tClampMult(tUpg(32) ? T_BAL.drag32Gain : 1) }
function tHookIngotUpg() { return tClampMult(tUpg(32) ? T_BAL.drag32Gain : 1) }
function tHookPressureRate() { return tClampMult(tUpg(31) ? T_BAL.flow31Rate : 1) }
function tHookVentValue() { return tClampMult(tUpg(23) ? T_BAL.pulse23 : 1) }
function tHookBuyableCost() {
	let m = decimalOne
	if (tChal(13)) m = m.times(T_BAL.rw13BuyableCost)	// 奖励：贫瘠之后，材料更省
	if (tUpg(32)) m = m.times(T_BAL.drag32Cost)
	return tClampMult(m)
}

// 挑战奖励（永久）
function tHookHeatReward() { return tClampMult(tChalHeatReward()) }
function tHookPressureExp() { return tClampAdd(tChal(12) ? T_BAL.rw12PressureExp : 0) }
function tHookChrononReward() { return tClampMult(tChal(15) ? T_BAL.rw15Chronon : 1) }

// 时之砂 / 过载
function tHookChrononHourglass() { return tHourglassMult() }
function tHookHeatSurge() { return tSurgeActive() ? new Decimal(T_BAL.surgeHeat) : decimalOne }
function tHookCoreSurge() { return tSurgeActive() ? new Decimal(T_BAL.surgeCore) : decimalOne }
function tHookChrononSurge() { return tSurgeActive() ? new Decimal(T_BAL.surgeChronon) : decimalOne }

// 挑战 debuff（乘性削弱）
// 11 冷炉：h.js 的 hCoreGainMult() 已在 inTime(11) 时直接返回 1（熔炉自身的炉芯加成全部归一）。
//    本钩子是兜底：任何别的层折叠 coreGain 时同样被压到 ×0.01。
function tHookCoreT11() { return tIn(11) ? new Decimal(T_BAL.t11CoreCut) : decimalOne }
// 12 无压：h.js 的 hPressureHeatMult() 已在 inTime(12) 时返回 1（炉压倍率失效）；
//    增速与泄压由这两个钩子削弱（这两个 h 层没有早退，所以是真生效）。
function tHookPressureRateT12() { return tIn(12) ? new Decimal(T_BAL.t12RateCut) : decimalOne }
function tHookVentValueT12() { return tIn(12) ? new Decimal(T_BAL.t12VentCut) : decimalOne }
// 14 迟缓 / 16 归零：全局热量削弱；16 同时压初始热量
function tHookHeatT14() { return tIn(14) ? new Decimal(T_BAL.t14HeatCut) : decimalOne }
function tHookHeatT16() { return tIn(16) ? new Decimal(T_BAL.t16HeatCut) : decimalOne }
function tHookStartT16() { return tIn(16) ? new Decimal(T_BAL.t16StartCut) : decimalOne }
// 熔炉自动产出（hPassiveAdd 通道，加法）：把里程碑 3 与挑战 16 的奖励交给 h 层折叠
function tHookHearthAutoGen() { return forgeHearthAutoGen() }
// 13 贫瘠 / 15 独断 由 helpers.buyableDebuff / helpers.autoOn 内置；
// 本层只保证自己的自动化也走 autoOn()（见 automate 与 forgeHearthAutoGen）。

// ---------------- 跨层数值（其它层通过这两个函数读凝时；见文件头集成点） ----------------
function forgeHearthAutoGen() { // 熔炉 passiveGeneration：里程碑 3（需开开关）＋ 挑战 16 奖励（永久）
	if (!autoOn(true)) return 0
	let g = 0
	if (tMs(3) && tFlag("autoHearth")) g += T_BAL.autoHearthGen
	if (tChal(16)) g += T_BAL.rw16HearthGen
	return g
}
function forgeAutoReaction() { // 里程碑 4：覆盖反应层的 autoPrestige
	return autoOn(tFlag("autoReaction") && tMs(4))
}
function forgeAutoAll() { // 里程碑 0 的总开关（低层若想让总开关直接驱动自己的开关，读这个）
	return autoOn(tFlag("autoAll") && tMs(0))
}

// ============================================================
// 层定义
// ============================================================
addLayer("t", {
	name: "凝时",
	symbol: "T",
	position: 1,
	color: "#9b59d6",
	row: 3,
	resource: "时序",
	baseResource: "触媒",
	resetDescription: "凝时，冻结出 ",

	startData() {
		return {
			unlocked: false,
			points: decimalZero,
			best: decimalZero,
			total: decimalZero,
			resets: decimalZero,
			// —— 自动化开关（里程碑解锁；判定全部走 autoOn()）——
			autoAll: false,		// 里程碑 0：总开关
			autoAllSync: false,	// 总开关上一次生效时的状态（用于检测玩家拨动）
			autoFillAll: false,	// 里程碑 2
			autoHearth: false,	// 里程碑 3
			autoReaction: false,// 里程碑 4
			// —— 过载 Surge（倒计时，游戏秒，Decimal）——
			surgeLeft: decimalZero,
			surgeCdLeft: decimalZero,
			// —— 时之砂 ——
			hourglasses: decimalZero,
			// clickable 默认状态（引擎只允许 string/number）
			clickables: { 11: "就绪", 12: "凝砂" },
		}
	},

	// ---------- 公式（normal；§3.5：exponent = 1，指数全交给 gainExp）----------
	type: "normal",
	exponent: 1,
	baseAmount() { return tBase() },
	requires: new Decimal(T_BAL.requires),
	softcap: new Decimal(T_BAL.softcap),
	softcapPower: new Decimal(T_BAL.softcapPower),

	gainExp() { return tChrononExp() },
	gainMult() { return tChrononMult() },
	directMult() { return decimalOne },

	// ---------- 先天效果 ----------
	effect() {
		return {
			heat: tEffHeat(),
			gain: tEffGain(),
			start: tEffStart(),
			midExp: tEffMidExp(),
			innate: tInnateMult(),
		}
	},
	effectDescription() {
		return "时序 " + formatWhole(tPoints()) + "（先天指数 " + format(tInnateExp()) + "）正在把" +
			"热量放大 " + timesFormat(tEffHeat()) +
			"，炉芯／锭条／时序产出放大 " + timesFormat(tEffGain()) +
			"，重置后的初始热量抬高 " + timesFormat(tEffStart()) +
			"，并给炉芯与锭条的公式指数 +" + format(tEffMidExp()) + "（封顶 +" + format(new Decimal(T_BAL.midExpCap)) + "）"
	},

	// ---------- 显示 ----------
	layerShown() { return forgeHasUnlocked("r") || forgeHasUnlocked("t") },
	tooltipLocked() {
		let req = new Decimal(T_BAL.requires)
		let cur = tBase()
		return "需要 <b>" + formatWhole(req) + "</b> 触媒才能点燃凝时（当前 " + formatWhole(cur) + "）<br>" +
			"凝时是全树的自动化中枢，也是六个时间挑战的入口。" +
			(cur.gte(req) ? "<br>已达标：点击节点，把时间冻下来。" : "<br>触媒来自反应（Reactor）层。")
	},
	tooltip() {
		let tip = "时序 " + formatWhole(tPoints()) + "（累计 " + formatWhole(tTotal()) + "）　热量 " +
			timesFormat(tEffHeat()) + "　指数 " + format(tChrononExp())
		if (tMs(0)) {
			if (tSurgeActive()) tip += "<br><b style='color:#ffd700'>过载中：还剩 " + fmtLeft(tSurgeLeft().toNumber()) + "</b>"
			else if (tSurgeCdLeft().gt(0)) tip += "<br>过载冷却：" + fmtLeft(tSurgeCdLeft().toNumber())
			else tip += "<br>过载：就绪"
		}
		return tip
	},
	nodeStyle() { return { 'color': "#d8b4fe", 'text-decoration': "underline" } },
	glowColor: "#9b59d6",

	// ---------- 每 tick（允许副作用）----------
	update(diff) {
		if (!forgeHasLayer("t")) return
		let d = tNum(diff)

		// 过载倒计时
		if (player.t.surgeLeft.gt(0)) player.t.surgeLeft = player.t.surgeLeft.minus(d).max(0)
		if (player.t.surgeCdLeft.gt(0)) player.t.surgeCdLeft = player.t.surgeCdLeft.minus(d).max(0)

		// 状态机字符串同步进 clickable state（只能存 string/number）
		let st = tSurgeState()
		if (player.t.clickables[11] !== st) player.t.clickables[11] = st
		if (tHourglassCount().gt(0)) player.t.clickables[12] = "已凝 " + formatWhole(tHourglassCount())
	},

	// 自动购买本层升级走 automate（引擎的 autoUpgrade 布尔过不了 autoOn()），
	// 这样挑战 15「独断」才真的把自动化断干净。
	autoUpgrade: false,

	automate() {
		if (!forgeHasUnlocked("t")) return

		// 里程碑 0 的总开关：玩家拨动它时，把下面三个分开关一起拧过去
		let all = tFlag("autoAll")
		if (all !== tFlag("autoAllSync")) {
			tAutoAllSet(all)
			player.t.autoAllSync = all
		}

		// 里程碑 1：自动购买本层升级
		if (autoOn(tMs(1))) {
			for (let id in layers.t.upgrades) {
				if (!isNaN(id) && canAffordUpgrade("t", id) && !tUpg(id)) buyUpg("t", id)
			}
		}
		// 里程碑 2：自动加注所有层的可购项（本层没有 buyables，管 h/m/r 三层）
		if (autoOn(tFlag("autoFillAll") && tMs(2))) {
			let targets = ["h", "m", "r"]
			for (let i = 0; i < targets.length; i++) {
				let lr = targets[i]
				if (!forgeHasUnlocked(lr) || !layers[lr] || !layers[lr].buyables) continue
				for (let id in layers[lr].buyables) {
					if (!isNaN(id)) buyMaxBuyable(lr, id)
				}
			}
		}
	},

	// ---------- 重置规则（§4）----------
	doReset(resettingLayer) {
		if (!forgeHasLayer("t")) return

		// 熔星重置：凝时升级由「x 里程碑 0 / x 升级 11」决定保留；其余全清。
		// 【偏离 §4 的一处必要保留】挑战完成数 challenges 也保留：
		//   §5.4 把六个奖励写成「永久」，§5.5 的结局又要求 completedChallengeCount ≥ 3；
		//   而点燃需要「同时」持有 1000 星核——若熔星重置洗掉挑战计数，玩家必须在
		//   点燃前的最后一轮里重打 3 个挑战 + 攒满 1000 星核，且每次冲关失败都清零重来，
		//   等价于 §0.7「绝不出现死路」的反例（sim 实测：4468s 挑战被 x 重置清空后被迫重打）。
		//   奖励的「永久」语义以挑战计数永久为准；里程碑/total/best 的保留本来就是同一逻辑。
		if (resettingLayer === "x") {
			let keepUpg = false
			if (forgeHasLayer("x")) {
				try { keepUpg = hasMilestone("x", 0) || tHas(player.x.upgrades, 11) } catch (e) { keepUpg = false }
			}
			let keep = ["challenges"]
			if (keepUpg) keep.push("upgrades")
			forgeDoReset("t", "x", keep)
			return
		}

		// 自身凝时 / 进入本层挑战：layers.t.row(3) 不小于重置者的行号，
		// forgeDoReset 会直接 return —— 本层货币、升级、里程碑、时之砂、过载全部保留（§4）。
		forgeDoReset("t", resettingLayer)
	},

	onPrestige() {
		if (forgeHasLayer("t")) player.t.resets = tNum(player.t.resets).plus(1)
	},

	// ---------- 快捷键 ----------
	hotkeys: [
		{
			key: "t",
			description: "T：凝时，用触媒冻结出时序（会重置熔炉・锻造・反应）",
			onPress() { if (canReset("t")) doReset("t") },
		},
		{
			key: "ctrl+t",
			description: "Ctrl+T：引爆过载（" + T_BAL.surgeDuration + " 秒狂热，随后 " + T_BAL.surgeCooldown + " 秒冷却）",
			onPress() { tSurgeTrigger() },
			unlocked() { return tMs(0) },
		},
	],

	// ============================================================
	// 升级（成本 = 时序；跨层效果一律写明影响哪个层）
	// ============================================================
	upgrades: {
		11: {
			title: "记忆合金",
			description: "<b>熔炉</b>的升级与燃料棒在更高层的重置中保留下来。",
			cost() { return tUpgCost(11) },
			tooltip: "高层重置不再把熔炉洗白：前期攒下的升级全部留住。",
		},
		12: {
			title: "时序模具",
			description: "<b>锻造</b>的升级在锻冶／反应／凝时／熔星的重置中保留下来。",
			cost() { return tUpgCost(12) },
		},
		13: {
			title: "加速衰变",
			description: "热量 ×" + T_BAL.heat13 + "。<br><i>影响热量（全局）。</i>",
			cost() { return tUpgCost(13) },
		},
		14: {
			title: "Chronon 透镜",
			description() {
				return "凝时先天效果指数 +" + format(new Decimal(T_BAL.lens14)) +
					"（当前 " + format(tInnateExp()) + "）。<br><i>同时抬高热量、锻冶与反应的产出、以及重置后的初始热量。</i>"
			},
			cost() { return tUpgCost(14) },
			tooltip: "指数是凝时最值钱的一档：先天倍数 = (1+时序)^指数。",
		},
		21: {
			title: "相位鼓风",
			description: "<b>熔炉</b>炉芯公式指数 +" + T_BAL.blast21 + "。<br><i>影响熔炉（Hearth）层。</i>",
			cost() { return tUpgCost(21) },
		},
		22: {
			title: "循环锭模",
			description: "<b>反应</b>重置时保留<b>锻造</b>的可购项。",
			cost() { return tUpgCost(22) },
		},
		23: {
			title: "脉冲回收",
			description() { return "<b>熔炉</b>泄压收益 ×" + format(new Decimal(T_BAL.pulse23)) + "。<br><i>影响熔炉（Hearth）层。</i>" },
			cost() { return tUpgCost(23) },
		},
		24: {
			title: "沧海一粟",
			description() { return "热量 ×" + format(new Decimal(T_BAL.grain24)) + "。<br><i>影响热量（全局）。</i>" },
			cost() { return tUpgCost(24) },
		},
		31: {
			title: "时之流",
			description() {
				return "<b>熔炉</b>炉压增速 ×" + format(new Decimal(T_BAL.flow31Rate)) +
					"，且热量 ×" + format(new Decimal(T_BAL.flow31Heat)) +
					"。<br><b>与「时之滞」互斥，二选一。</b><br><i>影响熔炉（Hearth）层与热量。</i>"
			},
			cost() { return tUpgCost(31) },
			unlocked() { return !tUpg(32) },
			branches: [32],
			style() { return tUpg(31) ? { 'background-color': "#6f3f9e" } : {} },
		},
		32: {
			title: "时之滞",
			description() {
				return "<b>熔炉</b>炉芯产出与<b>锻造</b>锭条产出 ×" + format(new Decimal(T_BAL.drag32Gain)) +
					"，且全树可购项成本 ×" + format(new Decimal(T_BAL.drag32Cost)) +
					"。<br><b>与「时之流」互斥，二选一。</b><br><i>影响熔炉／锻造／所有层的可购项。</i>"
			},
			cost() { return tUpgCost(32) },
			unlocked() { return !tUpg(31) },
			style() { return tUpg(32) ? { 'background-color': "#3f5f9e" } : {} },
		},
	},

	// ============================================================
	// 里程碑（累计时序；给的全是自动化 —— 设计哲学第 3 条）
	// ============================================================
	milestones: {
		0: {
			requirementDescription() { return "累计 " + formatWhole(new Decimal(T_BAL.msTotal[0])) + " 时序（当前 " + formatWhole(tTotal()) + "）" },
			done() { return tTotal().gte(T_BAL.msTotal[0]) },
			effectDescription() {
				return "解锁「全局自动化」总开关与「过载」。<br>当前：总开关 " + (tFlag("autoAll") ? "<b>开</b>" : "关") +
					"　自动加注 " + (tFlag("autoFillAll") ? "开" : "关") +
					"　熔炉全自动 " + (tFlag("autoHearth") ? "开" : "关") +
					"　自动反应 " + (tFlag("autoReaction") ? "开" : "关")
			},
			toggles: [["t", "autoAll"]],
			tooltip: "总开关一次拧动全部分开关；各层仍受自己的里程碑与凝时里程碑 1 约束。挑战「独断」期间全部失效。",
		},
		1: {
			requirementDescription() { return "累计 " + formatWhole(new Decimal(T_BAL.msTotal[1])) + " 时序（当前 " + formatWhole(tTotal()) + "）" },
			done() { return tTotal().gte(T_BAL.msTotal[1]) },
			effectDescription: "自动购买<b>所有层</b>的升级（含本层），并解锁「时之砂」。",
			tooltip: "开启后，五层的升级都会自动购买，不必逐层去点。",
		},
		2: {
			requirementDescription() { return "累计 " + formatWhole(new Decimal(T_BAL.msTotal[2])) + " 时序（当前 " + formatWhole(tTotal()) + "）" },
			done() { return tTotal().gte(T_BAL.msTotal[2]) },
			effectDescription: "解锁「自动加注所有可购项」：熔炉燃料棒、锻造与反应的可购项一次拉满。",
			toggles: [["t", "autoFillAll"]],
		},
		3: {
			requirementDescription() { return "累计 " + formatWhole(new Decimal(T_BAL.msTotal[3])) + " 时序（当前 " + formatWhole(tTotal()) + "）" },
			done() { return tTotal().gte(T_BAL.msTotal[3]) },
			effectDescription: "解锁「熔炼全自动」：熔炉每秒自动完成 " + T_BAL.autoHearthGen + " 次熔炼，不必再手动点「熔炼」。",
			toggles: [["t", "autoHearth"]],
			tooltip: "开关在这里；关掉后熔炉就不再自动熔炼。挑战「独断」期间也会停。",
		},
		4: {
			requirementDescription() { return "累计 " + formatWhole(new Decimal(T_BAL.msTotal[4])) + " 时序（当前 " + formatWhole(tTotal()) + "）" },
			done() { return tTotal().gte(T_BAL.msTotal[4]) },
			effectDescription: "解锁「自动反应」：让反应层达到门槛时自己推进。",
			toggles: [["t", "autoReaction"]],
			tooltip: "开启后，反应会自己推进，不必再手动点「反应」。",
		},
		5: {
			requirementDescription() { return "累计 " + formatWhole(new Decimal(T_BAL.msTotal[5])) + " 时序（当前 " + formatWhole(tTotal()) + "）" },
			done() { return tTotal().gte(T_BAL.msTotal[5]) },
			effectDescription: "「铭刻」成就层给成的热量加成 +100%。",
			tooltip: "解锁后，铭刻给成的热量加成翻倍。本层只负责解锁这条里程碑，加成由铭刻层生效。",
		},
	},

	// ============================================================
	// 挑战（6 个；进入 = doReset('t', true)，清空 row0-2，本层保留）
	// 解锁顺序：11（累计 1 时序）→ 12 → 13 → 14 → 15 → 16
	// 目标只读「会被清空」的资源：h.points / m.points / r.points / tmp.t.resetGain
	// ============================================================
	challenges: {
		11: {
			name: "冷炉",
			completionLimit: 1,
			unlocked() { return tTotal().gte(T_BAL.unlockTotal) || tChal(11) },
			challengeDescription() {
				return "<b>限制：</b>一切炉芯加成都失效——熔炉自身的炉芯加成归一（×1），" +
					"其它层喂进来的加成再 ×" + format(new Decimal(T_BAL.t11CoreCut)) +
					"。炉子是冷的，谁也暖不了它。"
			},
			goalDescription() {
				return "攒到 <b>" + formatWhole(new Decimal(T_BAL.goal11)) + "</b> 炉芯（当前 " +
					formatWhole(forgeAmt("h")) + "）"
			},
			canComplete() { return forgeAmt("h").gte(T_BAL.goal11) },
			rewardDescription() { return "永久：热量 ×" + format(new Decimal(T_BAL.rw11Heat)) + "。" },
			rewardEffect() { return tChal(11) ? new Decimal(T_BAL.rw11Heat) : decimalOne },
			rewardDisplay() { return timesFormat(tChal(11) ? new Decimal(T_BAL.rw11Heat) : decimalOne) },
			style() { return tIn(11) ? { 'border': "3px solid #9b59d6", 'box-shadow': "0 0 18px #9b59d6" } : {} },
		},
		12: {
			name: "无压",
			completionLimit: 1,
			unlocked() { return tChal(11) },
			challengeDescription() {
				return "<b>限制：</b>炉压不再提供任何热量倍率（倍率归一），增速 ×" +
					format(new Decimal(T_BAL.t12RateCut)) + "、泄压收益 ×" +
					format(new Decimal(T_BAL.t12VentCut)) + "。阀门被焊死了。"
			},
			goalDescription() {
				return "锻出 <b>" + formatWhole(new Decimal(T_BAL.goal12)) + "</b> 锭条（当前 " +
					formatWhole(forgeAmt("m")) + "）"
			},
			canComplete() { return forgeAmt("m").gte(T_BAL.goal12) },
			rewardDescription() { return "永久：炉压指数 +" + format(new Decimal(T_BAL.rw12PressureExp)) + "。" },
			rewardEffect() { return tChal(12) ? new Decimal(T_BAL.rw12PressureExp) : decimalZero },
			rewardDisplay() { return "+" + format(tChal(12) ? new Decimal(T_BAL.rw12PressureExp) : decimalZero) + " 炉压指数" },
			style() { return tIn(12) ? { 'border': "3px solid #9b59d6", 'box-shadow': "0 0 18px #9b59d6" } : {} },
		},
		13: {
			name: "贫瘠",
			completionLimit: 1,
			unlocked() { return tChal(12) },
			challengeDescription() {
				return "<b>限制：</b>所有层的可购项效果减半，" +
					"燃料棒、轧辊、催化塔全都成了空壳。"
			},
			goalDescription() {
				return "合成 <b>" + formatWhole(new Decimal(T_BAL.goal13)) + "</b> 触媒（当前 " +
					formatWhole(tBase()) + "）"
			},
			canComplete() { return tBase().gte(T_BAL.goal13) },
			rewardDescription() { return "永久：所有层的可购项成本 ×" + format(new Decimal(T_BAL.rw13BuyableCost)) + "。" },
			rewardEffect() { return tChal(13) ? new Decimal(T_BAL.rw13BuyableCost) : decimalOne },
			rewardDisplay() { return timesFormat(tChal(13) ? new Decimal(T_BAL.rw13BuyableCost) : decimalOne) + " 成本" },
			style() { return tIn(13) ? { 'border': "3px solid #9b59d6", 'box-shadow': "0 0 18px #9b59d6" } : {} },
		},
		14: {
			name: "迟缓",
			completionLimit: 1,
			unlocked() { return tChal(13) },
			challengeDescription() {
				return "<b>限制：</b>热量 ×" + format(new Decimal(T_BAL.t14HeatCut)) +
					"。时间像灌了铅，每一秒都很长。"
			},
			goalDescription() {
				return "合成 <b>" + formatWhole(new Decimal(T_BAL.goal14)) + "</b> 触媒（当前 " +
					formatWhole(tBase()) + "）"
			},
			canComplete() { return tBase().gte(T_BAL.goal14) },
			rewardDescription() { return "永久：凝时先天效果指数 +" + format(new Decimal(T_BAL.rw14InnateExp)) + "。" },
			rewardEffect() { return tChal(14) ? new Decimal(T_BAL.rw14InnateExp) : decimalZero },
			rewardDisplay() {
				return "+" + format(tChal(14) ? new Decimal(T_BAL.rw14InnateExp) : decimalZero) +
					"（当前先天指数 " + format(tInnateExp()) + "）"
			},
			style() { return tIn(14) ? { 'border': "3px solid #9b59d6", 'box-shadow': "0 0 18px #9b59d6" } : {} },
		},
		15: {
			name: "独断",
			completionLimit: 1,
			unlocked() { return tChal(14) },
			challengeDescription() {
				return "<b>限制：</b>所有层的自动化全部失效，" +
					"包括凝时自己的总开关，每一件事都得亲手做。"
			},
			goalDescription() {
				let g = decimalZero
				try { if (typeof tmp !== "undefined" && tmp.t) g = tNum(tmp.t.resetGain) } catch (e) { g = decimalZero }
				return "一次凝时冻结出 <b>" + formatWhole(new Decimal(T_BAL.goal15)) + "</b> 时序（当前可凝固：" +
					formatWhole(g) + "；约需 " + formatWhole(new Decimal(T_BAL.requires * T_BAL.goal15)) + " 触媒）"
			},
			canComplete() {
				if (typeof tmp === "undefined" || !tmp.t) return false
				return tNum(tmp.t.resetGain).gte(T_BAL.goal15)
			},
			rewardDescription() { return "永久：时序产出 ×" + format(new Decimal(T_BAL.rw15Chronon)) + "。" },
			rewardEffect() { return tChal(15) ? new Decimal(T_BAL.rw15Chronon) : decimalOne },
			rewardDisplay() { return timesFormat(tChal(15) ? new Decimal(T_BAL.rw15Chronon) : decimalOne) },
			style() { return tIn(15) ? { 'border': "3px solid #9b59d6", 'box-shadow': "0 0 18px #9b59d6" } : {} },
		},
		16: {
			name: "归零",
			completionLimit: 1,
			unlocked() { return tChal(15) },
			challengeDescription() {
				return "<b>限制：</b>高层重置后的初始热量 ×" + format(new Decimal(T_BAL.t16StartCut)) +
					"（几乎归零），且热量 ×" + format(new Decimal(T_BAL.t16HeatCut)) +
					"。一切从冷炉重新开始。"
			},
			goalDescription() {
				return "合成 <b>" + formatWhole(new Decimal(T_BAL.goal16)) + "</b> 触媒（当前 " +
					formatWhole(tBase()) + "）"
			},
			canComplete() { return tBase().gte(T_BAL.goal16) },
			rewardDescription() {
				return "永久：熔炉每秒自动完成 " + T_BAL.rw16HearthGen + " 次熔炼，且热量 ×" +
					format(new Decimal(T_BAL.rw16Heat)) + "。当前挑战奖励合计热量 " + timesFormat(tChalHeatReward()) + "。"
			},
			rewardEffect() { return tChal(16) ? new Decimal(T_BAL.rw16Heat) : decimalOne },
			rewardDisplay() {
				return timesFormat(tChal(16) ? new Decimal(T_BAL.rw16Heat) : decimalOne) +
					"　熔炉自动：" + (tChal(16) ? "已解锁 " + T_BAL.rw16HearthGen + " 次熔炼/秒" : "未解锁")
			},
			style() { return tIn(16) ? { 'border': "3px solid #9b59d6", 'box-shadow': "0 0 18px #9b59d6" } : {} },
		},
	},

	// ============================================================
	// clickable：11 过载 Surge、12 时之砂 Hourglass
	// ============================================================
	clickables: {
		11: {
			title: "过载 Surge",
			unlocked() { return tMs(0) },
			canClick() { return tSurgeCan() },
			onClick() { tSurgeTrigger() },
			effect() { return { active: tSurgeActive(), left: tSurgeLeft(), cd: tSurgeCdLeft() } },
			display() {
				let st = tSurgeState()
				if (tSurgeActive()) {
					return "<b style='color:#ffd700'>" + st + "</b><br>剩余：<b>" + fmtLeft(tSurgeLeft().toNumber()) + "</b><br>" +
						"热量 ×" + T_BAL.surgeHeat + "　炉芯 ×" + T_BAL.surgeCore + "　时序 ×" + T_BAL.surgeChronon
				}
				if (tSurgeCdLeft().gt(0)) {
					return "<b>" + st + "</b><br>冷却剩余：<b>" + fmtLeft(tSurgeCdLeft().toNumber()) + "</b><br>" +
						"冷却结束前无法再次引爆。"
				}
				return "<b style='color:#b6f5b1'>" + st + "</b><br>点击引爆：" + T_BAL.surgeDuration +
					" 秒狂热，随后 " + formatTime(T_BAL.surgeCooldown) + " 冷却。<br>（快捷键 Ctrl+T）"
			},
			style() {
				if (tSurgeActive()) return { 'background-color': "#ff5a2a", 'box-shadow': "0 0 22px #ffd700" }
				if (tSurgeCan()) return { 'background-color': "#6f3f9e" }
				if (tSurgeCdLeft().gt(0) && tSurgeCdLeft().lte(T_BAL.surgeShowAfter)) return { 'box-shadow': "0 0 14px #9b59d6" }
				return {}
			},
			tooltip: "把时间一次烧光：" + T_BAL.surgeDuration + " 秒内热量 ×" + T_BAL.surgeHeat +
				"、炉芯 ×" + T_BAL.surgeCore + "、时序 ×" + T_BAL.surgeChronon + "；随后冷却 " + T_BAL.surgeCooldown + " 秒。",
		},
		12: {
			title: "时之砂 Hourglass",
			unlocked() { return tMs(1) },
			canClick() { return tHourglassCan() },
			onHold() { tHourglassTrigger() },
			effect() { return tHourglassMult() },
			display() {
				return "已有：<b>" + formatWhole(tHourglassCount()) + "</b> 颗<br>" +
					"时序产出：" + timesFormat(tHourglassMult()) + "<br>" +
					"每颗花费 " + T_BAL.hourglassCost + " 时序（当前 " + formatWhole(tPoints()) + "）<br>" +
					"点一下凝一颗；按住可连点"
			},
			style() { return tHourglassCan() ? { 'background-color': "#4b2e6e" } : {} },
			tooltip: "把时序磨成砂：每颗永久让时序产出 ×" + T_BAL.hourglassMult +
				"（可叠加；熔星重置会把砂漏掉）。",
		},
	},

	componentStyles: {
		"prestige-button"() { return { 'width': "250px", 'height': "86px" } },
		"clickable"() { return { 'height': "160px", 'width': "215px" } },
		"challenge"() { return { 'height': "210px", 'width': "250px" } },
	},

	// ============================================================
	// 界面：主界面 ＋ 挑战 ＋ 详情
	// ============================================================
	tabFormat: {
		"主界面": {
			content: [
				"main-display",
				"resource-display",
				["blank", "6px"],
				["raw-html", function () { return tReport() }],
				["blank", "8px"],
				"prestige-button",
				["blank", "6px"],
				"clickables",
				["blank", "10px"],
				"milestones",
				["blank", "10px"],
				"upgrades",
			],
		},
		"挑战": {
			content: [
				["raw-html", function () { return tChalHeader() }],
				["blank", "10px"],
				"challenges",
			],
			glowColor: "#9b59d6",
		},
		"详情": {
			unlocked() { return tTotal().gt(0) },
			content: [
				["bar", "surgeBar"],
				["blank", "10px"],
				["bar", "chalBar"],
				["blank", "14px"],
				["raw-html", function () { return tFormulaReport() }],
				["blank", "12px"],
				["infobox", "lore"],
			],
		},
	},

	bars: {
		surgeBar: {
			fillStyle: { 'background-color': "#ff5a2a" },
			baseStyle: { 'background-color': "#2a1030" },
			textStyle: { 'color': '#f3d9ff' },
			borderStyle() { return { 'border-width': "2px" } },
			direction: RIGHT,
			width: 330,
			height: 30,
			unlocked() { return tMs(0) },
			progress() {
				if (tSurgeActive()) return tSurgeLeft().div(new Decimal(T_BAL.surgeDuration)).toNumber()
				let cd = tSurgeCdLeft().toNumber()
				if (cd > 0) return 1 - Math.min(cd / T_BAL.surgeCooldown, 1)
				return 1
			},
			display() {
				if (tSurgeActive()) return "过载中：剩余 " + fmtLeft(tSurgeLeft().toNumber())
				let cd = tSurgeCdLeft().toNumber()
				if (cd > 0) return "过载冷却：" + fmtLeft(cd)
				return "过载：就绪（Ctrl+T）"
			},
		},
		chalBar: {
			fillStyle: { 'background-color': "#9b59d6" },
			baseStyle: { 'background-color': "#1a1026" },
			textStyle: { 'color': '#e8d5ff' },
			borderStyle() { return { 'border-width': "2px" } },
			direction: RIGHT,
			width: 330,
			height: 26,
			unlocked() { return tTotal().gte(T_BAL.msTotal[0]) },
			progress() { return Math.min(tChalCount() / 6, 1) },
			display() { return "时间挑战：" + tChalCount() + " / 6 已完成" },
		},
	},

	infoboxes: {
		lore: {
			title: "炉边记事 · 凝时",
			body: "凝时把触媒冻成时序，十个起一手。攒下的时序同时抬高热量、炉芯与锭条的产出，" +
				"以及每次重置之后的起始热量。<br><br>" +
				"这一层另有六个挑战。进去会清空熔炉、锻造和反应的进度，只留时序本身；" +
				"每完成一个，换来一份永久生效的奖励。",
			titleStyle: { 'color': "#9b59d6" },
		},
	},
})

// ============================================================
// 本层内部的写操作（只由 onClick / onHold / hotkey / automate 调用）
// ============================================================
function tSurgeTrigger() {
	if (!tSurgeCan()) return
	player.t.surgeLeft = new Decimal(T_BAL.surgeDuration)
	player.t.surgeCdLeft = new Decimal(T_BAL.surgeDuration + T_BAL.surgeCooldown)
	player.t.clickables[11] = "过载!"
	doPopup("milestone", "炉膛在尖叫：热量 ×" + T_BAL.surgeHeat + "，持续 " + T_BAL.surgeDuration + " 秒。", "过载!", 4, "#ffd700")
}

function tHourglassTrigger() {
	if (!tHourglassCan()) return
	let cost = new Decimal(T_BAL.hourglassCost)
	player.t.points = tPoints().minus(cost)
	player.t.hourglasses = tHourglassCount().plus(1)
	player.t.clickables[12] = "已凝 " + formatWhole(player.t.hourglasses)
}

function tAutoAllSet(on) {
	if (!forgeHasLayer("t")) return
	player.t.autoFillAll = !!on
	player.t.autoHearth = !!on
	player.t.autoReaction = !!on
}

// ============================================================
// 文本报告（纯读）
// ============================================================
function tChalCount() {
	try { return completedChallengeCount() } catch (e) { return 0 }
}

function tUpgCost(id) {
	let base = new Decimal(T_BAL.upgCost[id] || 1)
	let v = base
	try { v = tNum(upgradeCostFinal(base)) } catch (e) { v = base }
	if (!v.isFinite() || v.lte(0)) v = base
	return v
}

function tNextMilestone() {
	for (let i = 0; i < T_BAL.msTotal.length; i++) {
		if (!tMs(i)) return { id: i, goal: new Decimal(T_BAL.msTotal[i]) }
	}
	return null
}

function tRouteText() {
	if (tUpg(31)) return "<b>时之流</b>（炉压增速 ×" + T_BAL.flow31Rate + " ＋ 热量 ×" + format(new Decimal(T_BAL.flow31Heat)) + "）"
	if (tUpg(32)) return "<b>时之滞</b>（炉芯与锭条产出 ×" + T_BAL.drag32Gain + " ＋ 可购项成本 ×" + T_BAL.drag32Cost + "）"
	return "尚未选择（第 3 行二选一）"
}

function tChalHeader() {
	let done = tChalCount()
	return "<div style='color:#e8d5ff'><h3>六个时间挑战</h3><br>" +
		"进入挑战会<b>清空熔炉・锻造・反应</b>（凝时自己不动），所以目标只看这三层的东西与单次凝时收益。<br>" +
		"已完成 <b>" + done + " / 6</b>　奖励全部是永久加成。" +
		(done >= 3 ? "<br><b style='color:#ffd700'>已完成 3 个：熔星的「点燃恒星」条件之一达成。</b>"
			: "<br>「点燃恒星」需要至少 " + (typeof FORGE_END !== "undefined" ? FORGE_END.igniteChallenges : 3) + " 个：还差 " +
			((typeof FORGE_END !== "undefined" ? FORGE_END.igniteChallenges : 3) - done) + " 个。") +
		"</div>"
}

function tReport() {
	let lines = []
	lines.push("<div style='color:#e8d5ff'>")
	lines.push("<h3>凝时读数</h3>")
	lines.push("触媒 <b>" + formatWhole(tBase()) + "</b> ／ 门槛 " + formatWhole(new Decimal(T_BAL.requires)) + "<br>")
	lines.push("时序 <b>" + formatWhole(tPoints()) + "</b>（累计 " + formatWhole(tTotal()) + "，最高 " + formatWhole(tBest()) + "）<br>")
	lines.push("公式指数 <b>" + format(tChrononExp()) + "</b>　乘数 <b>" + timesFormat(tChrononMult()) + "</b><br>")
	lines.push("先天指数 <b>" + format(tInnateExp()) + "</b>　先天倍数 <b>" + timesFormat(tInnateMult()) + "</b><br>")
	let sp = decimalOne
	try { sp = D(getStartPoints()) } catch (e) { sp = decimalOne }
	lines.push("重置后初始热量：<b>" + format(sp) + "</b><br>")
	if (tMs(0)) {
		if (tSurgeActive()) lines.push("<b style='color:#ffd700'>过载中：剩余 " + fmtLeft(tSurgeLeft().toNumber()) + "</b><br>")
		else if (tSurgeCdLeft().gt(0)) lines.push("过载冷却：" + fmtLeft(tSurgeCdLeft().toNumber()) + "<br>")
		else lines.push("<b style='color:#b6f5b1'>过载：就绪</b><br>")
	}
	let next = tNextMilestone()
	lines.push("<br>下一个里程碑：" + (next ? fmtTarget(tTotal(), next.goal, "累计时序") : "全部达成") + "<br>")
	lines.push("互斥路线：" + tRouteText() + "<br>")
	lines.push("时间挑战：" + tChalCount() + " / 6　")
	let ac = forgeHasLayer("t") ? player.t.activeChallenge : null
	if (ac) {
		let nm = String(ac)
		try {
			if (typeof tmp !== "undefined" && tmp.t && tmp.t.challenges[ac] && tmp.t.challenges[ac].name) nm = tmp.t.challenges[ac].name
		} catch (e) { nm = String(ac) }
		lines.push("当前进行中：<b style='color:#ff9a3c'>" + nm + "</b><br>")
	} else {
		lines.push("当前无进行中挑战<br>")
	}
	lines.push(tFlagText("autoFillAll", "自动加注") + "　" + tFlagText("autoHearth", "熔炉全自动") +
		"　" + tFlagText("autoReaction", "自动反应") + "<br>")
	lines.push("本层自动购买升级：" + (autoOn(tMs(1)) ? "<b>已开启</b>" : "未开启") +
		(tIn(15) ? "（挑战「独断」中：全部自动化失效）" : ""))
	lines.push("</div>")
	return lines.join("")
}

function tFormulaReport() {
	let s = "<div style='color:#e8d5ff;text-align:left'>"
	s += "<h3>凝时参数</h3>"
	s += "时序 = （触媒 ÷ " + formatWhole(new Decimal(T_BAL.requires)) + "）^ " + format(tChrononExp()) +
		" × 乘数 " + format(tChrononMult()) + "<br>"
	s += "　乘数构成：先天 " + timesFormat(tHookChrononInnate()) +
		"　挑战15奖励 " + timesFormat(tHookChrononReward()) +
		"　时之砂 " + timesFormat(tHookChrononHourglass()) +
		"　过载 " + timesFormat(tHookChrononSurge()) + "<br>"
	s += "　指数 = 基础 " + T_BAL.baseExp + " ＋ 加成 " + format(tFoldAddSafe("chrononExpBonus", 0)) + "<br><br>"

	s += "<b>凝时给前面几层带来的加成</b><br>"
	s += "　热量：" + timesFormat(tEffHeat()) + " × 升级 " + timesFormat(tHookHeatUpg()) +
		" × 挑战奖励 " + timesFormat(tHookHeatReward()) + "<br>"
	s += "　炉芯／锭条产出：" + timesFormat(tEffGain()) + " × 升级 " + timesFormat(tHookCoreUpg()) + "<br>"
	s += "　炉芯／锭条公式指数：+" + format(tEffMidExp()) + "（相位鼓风另 +" + format(new Decimal(T_BAL.blast21)) + "）<br>"
	s += "　初始热量：" + timesFormat(tEffStart()) + "<br>"
	s += "　熔炉自动熔炼：" + forgeHearthAutoGen() + " 次/秒　自动反应：" + (forgeAutoReaction() ? "已开启" : "未开启") + "<br>"
	s += "　可购项成本折扣：" + timesFormat(tHookBuyableCost()) + "<br><br>"

	s += "<b>六个挑战的限制</b><br>"
	s += "　11 冷炉：炉芯不再给热量加成，其余炉芯来源也 ×" + T_BAL.t11CoreCut + "<br>"
	s += "　12 无压：炉压不再给热量加成，涨压 ×" + T_BAL.t12RateCut + "、泄压收益 ×" + T_BAL.t12VentCut + "<br>"
	s += "　13 贫瘠：所有可购项的效果减半<br>"
	s += "　14 迟缓：热量 ×" + T_BAL.t14HeatCut + "<br>"
	s += "　15 独断：所有自动功能停摆<br>"
	s += "　16 归零：重置后的起始热量 ×" + T_BAL.t16StartCut + "、热量 ×" + T_BAL.t16HeatCut + "<br><br>"
	s += "<b>完成后的永久奖励</b><br>"
	s += "　11 → 热量 ×" + T_BAL.rw11Heat + "　12 → 炉压响应指数 +" + T_BAL.rw12PressureExp +
		"　13 → 可购项成本 ×" + T_BAL.rw13BuyableCost + "　14 → 凝时先天效果指数 +" + T_BAL.rw14InnateExp +
		"　15 → 时序产出 ×" + T_BAL.rw15Chronon + "　16 → 热量 ×" + T_BAL.rw16Heat + " 与熔炉自动熔炼<br>"
	s += "</div>"
	return s
}

// ============================================================
// 钩子注册（加载期，一次性；见 DESIGN.md §3.2）
// 顺序：先天 → 升级 → 奖励 → 时之砂/过载 → debuff（priority 更高，排在后面）
// ============================================================
function tRegister(name, fn, priority) {
	try {
		registerHook(name, fn, priority)
	} catch (e) {
		console.error("Forge[t] hook register failed: " + name, e)
	}
}

// 先天
tRegister("heat", tHookHeatInnate)
tRegister("coreGain", tHookCoreInnate)
tRegister("ingotGain", tHookIngotInnate)
tRegister("chrononGain", tHookChrononInnate)
tRegister("startPoints", tHookStartInnate)
tRegister("coreExpBonus", tHookCoreExpBonus)
tRegister("ingotExpBonus", tHookIngotExpBonus)

// 本层升级
tRegister("heat", tHookHeatUpg)
tRegister("coreGain", tHookCoreUpg)
tRegister("ingotGain", tHookIngotUpg)
tRegister("pressureRate", tHookPressureRate)
tRegister("ventValue", tHookVentValue)
tRegister("buyableCost", tHookBuyableCost)

// 挑战奖励（永久）
tRegister("heat", tHookHeatReward)
tRegister("pressureExp", tHookPressureExp)
tRegister("chrononGain", tHookChrononReward)

// 时之砂 / 过载
tRegister("chrononGain", tHookChrononHourglass)
tRegister("heat", tHookHeatSurge)
tRegister("coreGain", tHookCoreSurge)
tRegister("chrononGain", tHookChrononSurge)

// 挑战 debuff（乘性削弱）
tRegister("coreGain", tHookCoreT11, 5)
tRegister("pressureRate", tHookPressureRateT12, 5)
tRegister("ventValue", tHookVentValueT12, 5)
tRegister("heat", tHookHeatT14, 6)
tRegister("heat", tHookHeatT16, 6)
tRegister("startPoints", tHookStartT16, 5)

// 熔炉自动产出：h.js 的 passiveGeneration 折叠的就是这条通道（加法）。
// 里程碑 3 与挑战 16 的奖励此前只在凝时面板里显示、从未接进 h 层，玩家实际拿不到，
// 这里补上注册。（m.js 的「水力锻机」早已注册同名钩子，两者相加。）
tRegister("hPassiveAdd", tHookHearthAutoGen)
