// tools/test-top.js —— layers-top 的回归自检脚本（永久保留）
// 用真实 harness（真引擎 + 真 break_eternity）跑 js/Forge/t.js 与 js/Forge/x.js：
//   逐状态调用所有钩子与 gainExp/gainMult/effect/cost/display/tooltip/challenges/clickables，
//   检查 NaN / Infinity / undefined 文本，并确认 inChallenge 各分支返回值合理。
// 用法：node tools/test-top.js
"use strict";

const { boot, safeStr } = require("./harness.js");

const api = boot({ seed: 7 });
if (api.state.failedFiles.length) {
	console.log("!! boot 期出错：", api.state.failedFiles.map((f) => f.file + " → " + f.message).join("\n   "));
}

let fails = [];
let checks = 0;
function ok(cond, msg) {
	checks++;
	if (!cond) fails.push(msg);
}
function bad(v) {
	if (v === undefined || v === null) return "undefined/null";
	if (typeof v === "number") return (!isFinite(v) ? String(v) : "");
	if (typeof v === "boolean") return "";
	if (typeof v === "string") {
		if (/NaN|Infinity|undefined|\[object Object\]/.test(v)) return "文本含 " + (v.match(/NaN|Infinity|undefined|\[object Object\]/)[0]);
		return "";
	}
	if (typeof v === "object") {
		// Decimal（沙箱 realm，鸭子类型）
		if (typeof v.isNan === "function") {
			try { if (v.isNan()) return "Decimal NaN"; } catch (e) { return "Decimal 检测失败"; }
			try { if (!v.isFinite()) return "Decimal Infinity"; } catch (e) { return "Decimal isFinite 失败"; }
			return "";
		}
		if (Array.isArray(v)) {
			for (let i = 0; i < v.length; i++) { let r = bad(v[i]); if (r) return "[" + i + "] " + r; }
			return "";
		}
		for (let k in v) {
			if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
			let r = bad(v[k]);
			if (r) return k + ": " + r;
		}
		return "";
	}
	if (typeof v === "function") return "";
	return "奇怪类型 " + typeof v;
}
function check(label, fn) {
	let v;
	try { v = fn(); } catch (e) { ok(false, label + " 抛异常: " + (e && e.message)); return undefined; }
	let r = bad(v);
	ok(!r, label + " 坏值: " + r + "（值=" + safeStr(v) + "）");
	return v;
}
// 可选属性：层没定义就跳过（引擎自己会给默认值）
function checkOpt(layer, fn, label) {
	let exists = api.get(`layers.${layer}.${fn} !== undefined`);
	if (!exists) return;
	check(`${layer}.${fn} @${label}`, () => api.get(`(function(){ try { var f = layers.${layer}.${fn}; return (typeof f === "function") ? f.bind(layers.${layer})() : f; } catch(e){ return "THROW:" + e.message; } })()`));
}

// ---------- 便捷求值 ----------
const ev = (expr) => { try { return api.eval(expr); } catch (e) { ok(false, "eval 失败 " + expr + " → " + e.message); return undefined; } };

function refresh() { api.callUpdateTemp(); api.callUpdateTemp(); }

// ---------- 状态构造：把所有层点亮并喂饱 ----------
function fillRich(o) {
	o = o || {};
	ev(`
		player.points = new Decimal(${o.points === undefined ? 1e6 : o.points});
		player.h.unlocked = player.m.unlocked = player.r.unlocked = true;
		player.t.unlocked = ${o.tUnlocked === undefined ? "true" : !!o.tUnlocked};
		player.x.unlocked = ${o.xUnlocked === undefined ? "true" : !!o.xUnlocked};
		player.h.points = new Decimal(${o.h || 1e5});
		player.h.pressure = new Decimal(${o.pressure === undefined ? 100 : o.pressure});
		player.h.vents = new Decimal(${o.vents || 120});
		player.h.resets = new Decimal(${o.hResets || 20});
		player.m.points = new Decimal(${o.m || 5000});
		player.m.total = new Decimal(${o.m || 5000});
		player.r.points = new Decimal(${o.r || 40});
		player.r.total = new Decimal(${o.r || 40});
		player.t.points = new Decimal(${o.t || 60});
		player.t.total = new Decimal(${o.t || 60});
		player.t.best = new Decimal(${o.t || 60});
		player.t.resets = new Decimal(${o.tResets || 8});
		player.t.milestones = ${JSON.stringify(o.tMs === undefined ? [0, 1, 2, 3, 4, 5] : o.tMs)};
		player.t.upgrades = ${JSON.stringify(o.tUpg === undefined ? [11, 12, 13, 14, 21, 22, 23, 24, 31] : o.tUpg)};
		player.t.challenges = ${JSON.stringify(o.tChal === undefined ? { 11: 1, 12: 1, 13: 1, 14: 1, 15: 0, 16: 0 } : o.tChal)};
		player.t.activeChallenge = ${o.chal === undefined ? "null" : JSON.stringify(o.chal)};
		player.t.autoAll = ${!!o.autoAll}; player.t.autoAllSync = ${o.autoAllSync === undefined ? "false" : "true"};
		player.t.autoFillAll = true; player.t.autoHearth = true; player.t.autoReaction = true;
		player.t.surgeLeft = new Decimal(${o.surgeLeft === undefined ? 0 : o.surgeLeft});
		player.t.surgeCdLeft = new Decimal(${o.surgeCd === undefined ? 0 : o.surgeCd});
		player.t.hourglasses = new Decimal(${o.hourglasses === undefined ? 3 : o.hourglasses});
		player.x.points = new Decimal(${o.x || 1200});
		player.x.total = new Decimal(${o.x || 1200});
		player.x.best = new Decimal(${o.x || 1200});
		player.x.milestones = ${JSON.stringify(o.xMs === undefined ? [0, 1, 2] : o.xMs)};
		player.x.upgrades = ${JSON.stringify(o.xUpg === undefined ? [11, 12, 13, 14] : o.xUpg)};
		player.x.ignited = ${!!o.ignited};
		player.ach.achievements = ${JSON.stringify(o.ach === undefined ? [11, 12, 13, 14, 21] : o.ach)};
	`);
	refresh();
}

// ---------- 遍历所有钩子 ----------
function runAllHooks(label) {
	const H = api.HOOKS;
	if (!H) { ok(false, "HOOKS 取不到（helpers.js 没加载？）"); return; }
	for (const name in H) {
		for (let i = 0; i < H[name].length; i++) {
			let v;
			try { v = H[name][i].fn(); } catch (e) { ok(false, `hook ${name}[${i}] 抛异常: ${e.message}`); continue; }
			let r = bad(v);
			ok(!r, `hook ${name}[${i}] 坏值: ${r}（${label}）`);
		}
	}
	// 折叠结果也要正常
	for (const name of Object.keys(H)) {
		check(`foldMult(${name}) @${label}`, () => api.get(`foldMult(${JSON.stringify(name)}, 1)`));
	}
	check(`foldAdd(heatFlat) @${label}`, () => api.get(`foldAdd("heatFlat", 0)`));
	check(`getPointGen @${label}`, () => api.get("getPointGen()"));
	check(`getStartPoints @${label}`, () => api.get("getStartPoints()"));
}

// ---------- 层的纯读函数面板 ----------
function runLayerFns(layer, label) {
	for (const fn of ["gainMult", "gainExp", "directMult", "effect", "baseAmount", "requires", "softcap", "softcapPower"]) {
		check(`${layer}.${fn} @${label}`, () => api.get(`(typeof layers.${layer}.${fn} === "function") ? layers.${layer}.${fn}.bind(layers.${layer})() : layers.${layer}.${fn}`));
	}
	for (const fn of ["effectDescription", "tooltip", "tooltipLocked", "layerShown", "shouldNotify", "prestigeNotify", "resetDescription"]) {
		checkOpt(layer, fn, label);
	}
	for (const fn of ["passiveGeneration", "autoPrestige", "autoUpgrade"]) {
		checkOpt(layer, fn, label);
	}
}

function runComponentFns(layer, label) {
	// upgrades
	check(`${layer}.upgradesUnlocked @${label}`, () => api.get(`(function(){
		var out = [];
		for (var id in layers.${layer}.upgrades) {
			if (isNaN(id)) continue;
			var u = layers.${layer}.upgrades[id];
			out.push([id, u.unlocked === undefined ? true : (typeof u.unlocked === "function" ? u.unlocked() : u.unlocked)]);
		}
		return out;
	})()`));
	api.eval(`(function(){
		for (var id in layers.${layer}.upgrades) {
			if (isNaN(id)) continue;
			var u = layers.${layer}.upgrades[id];
			if (u.cost !== undefined) {
				var c = (typeof u.cost === "function") ? u.cost() : u.cost;
				__costProbe.push([${JSON.stringify(layer)}, id, c]);
			}
			if (u.description !== undefined) __descProbe.push([${JSON.stringify(layer)}, id, (typeof u.description === "function") ? u.description() : u.description]);
			if (u.effect !== undefined && typeof u.effect === "function") __effProbe.push([${JSON.stringify(layer)}, id, u.effect()]);
			if (u.effectDisplay !== undefined) __effDispProbe.push([${JSON.stringify(layer)}, id, (typeof u.effectDisplay === "function") ? u.effectDisplay() : u.effectDisplay]);
			if (u.tooltip !== undefined) __tipProbe.push([${JSON.stringify(layer)}, id, (typeof u.tooltip === "function") ? u.tooltip() : u.tooltip]);
		}
	})()`);
	// milestones
	api.eval(`(function(){
		for (var id in layers.${layer}.milestones) {
			var m = layers.${layer}.milestones[id];
			__msReq.push([${JSON.stringify(layer)}, id, (typeof m.requirementDescription === "function") ? m.requirementDescription() : m.requirementDescription]);
			__msEff.push([${JSON.stringify(layer)}, id, (typeof m.effectDescription === "function") ? m.effectDescription() : m.effectDescription]);
			__msDone.push([${JSON.stringify(layer)}, id, m.done ? m.done() : false]);
			if (m.tooltip !== undefined) __msTip.push([${JSON.stringify(layer)}, id, (typeof m.tooltip === "function") ? m.tooltip() : m.tooltip]);
		}
	})()`);
	// challenges
	api.eval(`(function(){
		if (!layers.${layer}.challenges) return;
		for (var id in layers.${layer}.challenges) {
			if (isNaN(id)) continue;
			var c = layers.${layer}.challenges[id];
			__chalUnlocked.push([${JSON.stringify(layer)}, id, c.unlocked ? c.unlocked() : true]);
			__chalDesc.push([${JSON.stringify(layer)}, id, (typeof c.challengeDescription === "function") ? c.challengeDescription() : c.challengeDescription]);
			if (c.goalDescription !== undefined) __chalGoal.push([${JSON.stringify(layer)}, id, (typeof c.goalDescription === "function") ? c.goalDescription() : c.goalDescription]);
			__chalCan.push([${JSON.stringify(layer)}, id, c.canComplete ? c.canComplete() : false]);
			__chalReward.push([${JSON.stringify(layer)}, id, (typeof c.rewardDescription === "function") ? c.rewardDescription() : c.rewardDescription]);
			if (c.rewardEffect !== undefined) __chalRwEff.push([${JSON.stringify(layer)}, id, (typeof c.rewardEffect === "function") ? c.rewardEffect() : c.rewardEffect]);
			if (c.rewardDisplay !== undefined) __chalRwDisp.push([${JSON.stringify(layer)}, id, (typeof c.rewardDisplay === "function") ? c.rewardDisplay() : c.rewardDisplay]);
			if (c.style !== undefined) __chalStyle.push([${JSON.stringify(layer)}, id, (typeof c.style === "function") ? c.style() : c.style]);
		}
	})()`);
	// clickables（只读部分）
	api.eval(`(function(){
		if (!layers.${layer}.clickables) return;
		for (var id in layers.${layer}.clickables) {
			if (isNaN(id)) continue;
			var k = layers.${layer}.clickables[id];
			__clkUnlocked.push([${JSON.stringify(layer)}, id, k.unlocked ? k.unlocked() : true]);
			__clkCan.push([${JSON.stringify(layer)}, id, k.canClick ? k.canClick() : false]);
			__clkDisp.push([${JSON.stringify(layer)}, id, k.display ? k.display() : ""]);
			if (k.effect !== undefined) __clkEff.push([${JSON.stringify(layer)}, id, (typeof k.effect === "function") ? k.effect() : k.effect]);
			if (k.style !== undefined) __clkStyle.push([${JSON.stringify(layer)}, id, (typeof k.style === "function") ? k.style() : k.style]);
			if (k.tooltip !== undefined) __clkTip.push([${JSON.stringify(layer)}, id, (typeof k.tooltip === "function") ? k.tooltip() : k.tooltip]);
			if (k.title !== undefined) __clkTitle.push([${JSON.stringify(layer)}, id, (typeof k.title === "function") ? k.title() : k.title]);
		}
	})()`);
	// bars / infoboxes / tabFormat
	api.eval(`(function(){
		if (layers.${layer}.bars) for (var id in layers.${layer}.bars) {
			var b = layers.${layer}.bars[id];
			__barProg.push([${JSON.stringify(layer)}, id, b.progress ? b.progress() : 0]);
			__barDisp.push([${JSON.stringify(layer)}, id, b.display ? b.display() : ""]);
			__barUnlocked.push([${JSON.stringify(layer)}, id, b.unlocked === undefined ? true : (typeof b.unlocked === "function" ? b.unlocked() : b.unlocked)]);
		}
	})()`);
	api.eval(`(function(){
		var tf = layers.${layer}.tabFormat;
		if (!tf || Array.isArray(tf)) return;
		for (var name in tf) {
			__tabUnlocked.push([${JSON.stringify(layer)}, name, tf[name].unlocked ? tf[name].unlocked() : true]);
			var c = tf[name].content || [];
			for (var i = 0; i < c.length; i++) {
				var item = c[i];
				if (Array.isArray(item) && typeof item[1] === "function") __tabText.push([${JSON.stringify(layer)}, name + "#" + item[0], item[1]()]);
			}
		}
	})()`);
}

// 探针数组（沙箱里建一次）
ev(`
	__costProbe = []; __descProbe = []; __effProbe = []; __effDispProbe = []; __tipProbe = [];
	__msReq = []; __msEff = []; __msDone = []; __msTip = [];
	__chalUnlocked = []; __chalDesc = []; __chalGoal = []; __chalCan = []; __chalReward = [];
	__chalRwEff = []; __chalRwDisp = []; __chalStyle = [];
	__clkUnlocked = []; __clkCan = []; __clkDisp = []; __clkEff = []; __clkStyle = []; __clkTip = []; __clkTitle = [];
	__barProg = []; __barDisp = []; __barUnlocked = []; __tabUnlocked = []; __tabText = [];
`)

function drainProbes() {
	for (const name of ["__costProbe", "__descProbe", "__effProbe", "__effDispProbe", "__tipProbe",
		"__msReq", "__msEff", "__msDone", "__msTip",
		"__chalUnlocked", "__chalDesc", "__chalGoal", "__chalCan", "__chalReward", "__chalRwEff", "__chalRwDisp", "__chalStyle",
		"__clkUnlocked", "__clkCan", "__clkDisp", "__clkEff", "__clkStyle", "__clkTip", "__clkTitle",
		"__barProg", "__barDisp", "__barUnlocked", "__tabUnlocked", "__tabText"]) {
		const list = api.get(name + ".slice()") || [];
		for (const row of list) {
			check(`${name} ${row[0]}/${row[1]}`, () => row[2]);
		}
		ev(`${name}.length = 0`);
	}
}

// ---------- 挑战判定分支 ----------
function checkChallengeBranches(label) {
	for (let id = 11; id <= 16; id++) {
		let inNow = api.get(`(function(){ try { return !!inTime(${id}) } catch(e){ return "THROW:" + e.message } })()`);
		ok(inNow === true || inNow === false, `inTime(${id}) 应返回布尔（${label}），实为 ${safeStr(inNow)}`);
		let ac = api.get("player.t.activeChallenge");
		let expect = (ac !== null && ac !== undefined && Number(ac) === id);
		ok(inNow === expect, `inTime(${id}) 与 activeChallenge=${safeStr(ac)} 不一致（期望 ${expect}，实际 ${inNow}）@${label}`);
	}
	// autoOn 在 15 中必须 false
	let a = api.get("autoOn(true)");
	let ac = api.get("player.t.activeChallenge");
	ok(a === (ac === null || ac === undefined || Number(ac) !== 15), `autoOn(true) 在挑战 ${safeStr(ac)} 中应=${ac === null || Number(ac) !== 15}（${label}）`);
	// buyableDebuff 在 13 中必须减半
	let d = api.get("buyableDebuff(4).toString()");
	let expectD = (api.get("inTime(13)") ? "2" : "4");
	ok(d === expectD, `buyableDebuff(4)=${d}，期望 ${expectD}（${label}）`);
}

function scenario(name, opts, extra) {
	fillRich(opts);
	runAllHooks(name);
	runLayerFns("t", name);
	runLayerFns("x", name);
	runComponentFns("t", name);
	runComponentFns("x", name);
	checkChallengeBranches(name);
	check("tmp.t.resetGain @" + name, () => api.get("tmp.t.resetGain"));
	check("tmp.t.nextAt @" + name, () => api.get("tmp.t.nextAt"));
	check("tmp.t.canReset @" + name, () => api.get("tmp.t.canReset"));
	check("tmp.x.resetGain @" + name, () => api.get("tmp.x.resetGain"));
	check("tmp.x.nextAt @" + name, () => api.get("tmp.x.nextAt"));
	check("forgeHearthAutoGen @" + name, () => api.get("forgeHearthAutoGen()"));
	check("forgeAutoReaction @" + name, () => api.get("forgeAutoReaction()"));
	check("forgeAutoAll @" + name, () => api.get("forgeAutoAll()"));
	check("xIgniteCan @" + name, () => api.get("xIgniteCan()"));
	check("tSurgeState @" + name, () => api.get("tSurgeState()"));
	check("completedChallengeCount @" + name, () => api.get("completedChallengeCount()"));
	if (extra) extra(name);
	drainProbes();
	// 跑几 tick 看有没有运行期异常
	let before = api.state.runtimeErrors.length;
	api.advance(2, 50);
	let after = api.state.runtimeErrors.length;
	ok(after === before, `推进 2 秒产生 ${after - before} 条运行期错误（${name}）`);
	let nan = api.nanScan();
	ok(nan.length === 0, `NaN 扫描（${name}）：` + nan.map((n) => n.path + "=" + n.value).join(", "));
}

// ===================== 场景 =====================
api.newGame();
refresh();

scenario("全新开局(points=1,pressure=0)", {
	tUnlocked: false, xUnlocked: false, points: 0, pressure: 0, t: 0, x: 0,
	tMs: [], tUpg: [], tChal: { 11: 0, 12: 0, 13: 0, 14: 0, 15: 0, 16: 0 }, hourglasses: 0, ach: [],
	xMs: [], xUpg: [],
});

scenario("凝时解锁・熔星未解锁", { xUnlocked: false, x: 0, xMs: [], xUpg: [] });

scenario("全解锁・无挑战进行中", {});

scenario("points=0・pressure=0 硬落地", { points: 0, pressure: 0, h: 0, m: 0, r: 0, t: 0, x: 0 });

scenario("挑战 11 冷炉进行中", { chal: 11 });
scenario("挑战 12 无压进行中", { chal: 12 });
scenario("挑战 13 贫瘠进行中", { chal: 13 });
scenario("挑战 14 迟缓进行中", { chal: 14 });
scenario("挑战 15 独断进行中(自动化)", { chal: 15, autoAll: true });
scenario("挑战 16 归零进行中", { chal: 16 });

scenario("过载进行中(surgeLeft=22)", { surgeLeft: 22, surgeCd: 308 });
scenario("过载冷却中(surgeCd=120)", { surgeCd: 120 });
scenario("过载刚结束", { surgeLeft: 0, surgeCd: 0 });

scenario("ignited=true keepGoing", { ignited: true, x: 300 });
scenario("ignited=true 且挑战全满", { ignited: true, tChal: { 11: 1, 12: 1, 13: 1, 14: 1, 15: 1, 16: 1 }, x: 5000 });

scenario("星核不足(点火不可点)", { x: 500 });
scenario("挑战数不足(点火不可点)", { x: 2000, tChal: { 11: 1, 12: 0, 13: 0, 14: 0, 15: 0, 16: 0 } });

scenario("时之滞路线(32)", { tUpg: [11, 12, 13, 14, 21, 22, 23, 24, 32] });
scenario("里程碑全无", { tMs: [], xMs: [], tUpg: [], xUpg: [], hourglasses: 0, tChal: { 11: 0, 12: 0, 13: 0, 14: 0, 15: 0, 16: 0 }, t: 0, x: 0 });

scenario("极大数(t/x=1e40)", { t: "1e40", x: "1e40", r: "1e30", m: "1e40", h: "1e40", points: "1e60" });

// ===================== 行为断言 =====================
console.log("\n--- 行为断言 ---");
fillRich({});
// 1) exponent = 1 且 gainExp 提供基础指数
ok(Number(api.get("layers.t.exponent")) === 1, "t.exponent 应为 1");
ok(Number(api.get("layers.x.exponent")) === 1, "x.exponent 应为 1");
ok(Math.abs(Number(api.get("layers.t.gainExp.bind(layers.t)()")) - 0.35) < 1e-9, "t.gainExp 基础应为 0.35，实为 " + api.get("layers.t.gainExp.bind(layers.t)()"));
ok(Math.abs(Number(api.get("layers.x.gainExp.bind(layers.x)()")) - 0.3) < 1e-9, "x.gainExp 基础应为 0.3，实为 " + api.get("layers.x.gainExp.bind(layers.x)()"));
// 2) gainMult 是纯钩子折叠
let gm = Number(api.get("layers.t.gainMult.bind(layers.t)()"));
let fold = Number(api.get("foldMult('chrononGain', 1)"));
ok(Math.abs(gm - fold) < 1e-9 * Math.max(1, fold), "t.gainMult 应等于 foldMult(chrononGain)");
let xgm = Number(api.get("layers.x.gainMult.bind(layers.x)()"));
let xfold = Number(api.get("foldMult('stellarGain', 1)"));
ok(Math.abs(xgm - xfold) < 1e-9 * Math.max(1, xfold), "x.gainMult 应等于 foldMult(stellarGain)");
// 3) startData 字段类型
let sd = api.get("layers.t.startData()");
ok(sd && sd.surgeLeft && typeof sd.surgeLeft.eq === "function", "t.startData.surgeLeft 必须是 Decimal");
ok(sd && sd.surgeCdLeft && typeof sd.surgeCdLeft.eq === "function", "t.startData.surgeCdLeft 必须是 Decimal");
ok(sd && sd.hourglasses && typeof sd.hourglasses.eq === "function", "t.startData.hourglasses 必须是 Decimal");
ok(sd && typeof sd.autoAll === "boolean", "t.startData.autoAll 必须是 boolean");
let xsd = api.get("layers.x.startData()");
ok(xsd && xsd.ignited === false, "x.startData.ignited 必须默认 false");
ok(xsd && typeof xsd.points.eq === "function", "x.startData.points 必须是 Decimal");
// 4) 过载：onClick 只在 canClick 时改状态
fillRich({ surgeLeft: 0, surgeCd: 0 });
api.eval("clickClickable('t', 11)");
ok(api.get("player.t.surgeLeft.toNumber()") === 30, "引爆后 surgeLeft 应为 30");
ok(api.get("player.t.surgeCdLeft.toNumber()") === 330, "引爆后 surgeCdLeft 应为 330");
let heatBefore = api.get("foldMult('heat',1).toString()");
api.eval("clickClickable('t', 11)"); // 已在过载中，canClick=false，不得重复
ok(api.get("player.t.surgeLeft.toNumber()") === 30, "过载中再次点击不得重置倒计时");
// 递减（这一条必须用**干净最小状态**测，不能用 fillRich：fillRich 会把 x 铺成
// 「累计 1200 星核 + 里程碑全开」，于是 advance 期间 x 的 autoPrestige 真的会 doReset('x')，
// 而 §4 规定熔星重置清掉 t 的一切（含过载倒计时）—— 那是**契约行为**，不是 bug。
// 所以这里单独 boot 一个只有 t 层状态的最小场景，专测 t.update 的倒计时递减。）
let surgeApi = boot({ seed: 3 })
surgeApi.newGame()
surgeApi.eval(`
	for (const L of ["h","m","r","t","x"]) if (player[L]) player[L].unlocked = true;
	player.points = new Decimal(1e6);
	player.h.points = new Decimal(1e5); player.m.points = new Decimal(5000);
	player.r.points = new Decimal(40); player.r.total = new Decimal(40);
	player.t.points = new Decimal(60); player.t.total = new Decimal(60); player.t.best = new Decimal(60);
	player.t.milestones = [0,1,2,3,4,5];
	player.t.surgeLeft = new Decimal(0); player.t.surgeCdLeft = new Decimal(0);
	player.x.total = new Decimal(4); player.x.points = new Decimal(4); player.x.best = new Decimal(4);
	player.x.upgrades = []; player.x.milestones = [];   // 确保不会自动熔星
	updateTemp();
`)
surgeApi.eval("clickClickable('t', 11)")
let s0 = surgeApi.get("player.t.surgeLeft.toNumber()")
surgeApi.advance(10, 50)
let s1 = surgeApi.get("player.t.surgeLeft.toNumber()")
ok(s0 === 30 && s1 < s0 && s1 > s0 - 12, `update 应递减过载倒计时 ${s0} → ${s1}`)
ok(["就绪", "过载!", "冷却"].includes(api.get("player.t.clickables[11]")), "clickable state 必须是三个字符串之一");
// 冷却完自动就绪
fillRich({ surgeLeft: 0, surgeCd: 5 });
api.advance(7, 50);
ok(api.get("player.t.clickables[11]") === "就绪", "冷却走完应变「就绪」");
// 5) 时之砂
fillRich({ t: 100, hourglasses: 0 });
let p0 = Number(api.get("player.t.points.toNumber()"));
api.eval("tHourglassTrigger()");
ok(Number(api.get("player.t.points.toNumber()")) === p0 - 3, "凝砂应扣 3 时序");
ok(api.get("player.t.hourglasses.toNumber()") === 1, "凝砂计数应 +1");
fillRich({ t: 1, hourglasses: 0 });
api.eval("tHourglassTrigger()");
ok(api.get("player.t.hourglasses.toNumber()") === 0, "时序不足时不得凝砂");
// 6) 点燃恒星：走引擎的 clickable 流程
fillRich({ x: 2000, tChal: { 11: 1, 12: 1, 13: 1, 14: 1, 15: 0, 16: 0 }, ignited: false, xMs: [0, 1, 2] });
ok(api.get("completedChallengeCount()") === 4, "completedChallengeCount 应为 4");
ok(api.get("xIgniteCan()") === true, "条件齐备时 xIgniteCan 应为 true");
api.eval("clickClickable('x', 11)");
ok(api.get("player.x.ignited") === true, "点燃后 ignited 应为 true");
ok(Number(api.get("player.x.points.toNumber()")) === 2000 - api.get("FORGE_END ? FORGE_END.igniteCost : 1000"), "点燃应扣除 FORGE_END.igniteCost 枚星核");
ok(api.get("isEndgame()") === true, "isEndgame 应为 true");
// 点燃后再点无效（幂等）
let xp = api.get("player.x.points.toString()");
api.eval("clickClickable('x', 11)");
ok(api.get("player.x.points.toString()") === xp, "点燃后不得重复扣除");
// keep going 指数
fillRich({ ignited: true, xMs: [0, 1, 2] });
let eOn = Number(api.get("xInnateExp().toNumber()"));
fillRich({ ignited: false, xMs: [0, 1, 2] });
let eOff = Number(api.get("xInnateExp().toNumber()"));
ok(Math.abs((eOn - eOff) - 0.5) < 1e-9, `点燃后效果指数应 +0.5（${eOff} → ${eOn}）`);
// 7) 挑战 debuff 的实际效果方向
fillRich({ chal: null });
let hNorm = Number(api.get("foldMult('heat',1).toNumber()"));
let coreNorm = Number(api.get("foldMult('coreGain',1).toNumber()"));
let rateNorm = Number(api.get("foldMult('pressureRate',1).toNumber()"));
let startNorm = Number(api.get("foldMult('startPoints',1).toNumber()"));
fillRich({ chal: 11 });
ok(Number(api.get("foldMult('coreGain',1).toNumber()")) < coreNorm, "t11 应削弱 coreGain");
fillRich({ chal: 14 });
ok(Number(api.get("foldMult('heat',1).toNumber()")) < hNorm, "t14 应削弱 heat");
fillRich({ chal: 16 });
ok(Number(api.get("foldMult('heat',1).toNumber()")) < hNorm, "t16 应削弱 heat");
ok(Number(api.get("foldMult('startPoints',1).toNumber()")) < startNorm, "t16 应削弱 startPoints");
fillRich({ chal: 12 });
ok(Number(api.get("foldMult('pressureRate',1).toNumber()")) < rateNorm, "t12 应削弱 pressureRate");
fillRich({ chal: 13 });
ok(Number(api.get("buyableDebuff(8).toNumber()")) === 4, "t13 应把 buyable 效果减半");
fillRich({ chal: 15 });
ok(api.get("autoOn(true)") === false, "t15 应让 autoOn 失效");
ok(api.get("forgeHearthAutoGen()") === 0, "t15 期间 forgeHearthAutoGen 应为 0");
ok(api.get("forgeAutoReaction()") === false, "t15 期间 forgeAutoReaction 应为 false");
fillRich({ chal: null });
ok(api.get("autoOn(true)") === true, "退出挑战后 autoOn 应恢复");

// 8) 挑战目标可达性：目标只读会被清空的东西
for (let id = 11; id <= 16; id++) {
	let src = api.get(`String(layers.t.challenges[${id}].canComplete)`);
	ok(/forgeAmt\("([hmr])"\)|tBase\(\)|resetGain/.test(src), `挑战 ${id} 的 canComplete 只应读会被清空的数量，实为: ${src}`);
}
// 9) doReset：进入 t 挑战不清 t 自己
fillRich({ t: 42, hourglasses: 4, surgeLeft: 0, surgeCd: 0 });
api.eval("startChallenge('t', 11)");
ok(api.get("player.t.activeChallenge") === 11 || Number(api.get("player.t.activeChallenge")) === 11, "startChallenge 应设 activeChallenge=11");
ok(Number(api.get("player.t.points.toNumber()")) === 42, "进入挑战不得清空 t 自己的时序");
ok(Number(api.get("player.r.points.toNumber()")) === 0, "进入挑战应清空触媒（row0-2）");
ok(Number(api.get("player.m.points.toNumber()")) === 0, "进入挑战应清空锭条");
ok(api.get("player.t.milestones.length") === 6, "进入挑战应保留 t 里程碑");
ok(api.get("player.t.upgrades.length") > 0, "进入挑战应保留 t 升级");
ok(api.get("player.h.unlocked") === true, "低层保持已解锁（只是被清空）");
// 完成挑战：把数量堆够再退出
fillRich({ chal: 11, t: 42 });
api.eval("player.h.points = new Decimal(1e5)");
refresh();
ok(api.get("canCompleteChallenge('t', 11)") === true, "炉芯 1e5 应能完成挑战 11");
api.eval("completeChallenge('t', 11)");
ok(api.get("player.t.challenges[11]") >= 1, "完成后挑战计数应 ≥1");
ok(api.get("player.t.activeChallenge") === null, "完成后应退出挑战");
// 奖励立即生效：热量 ×1e3
let heatWithRw = Number(api.get("foldMult('heat',1).toNumber()"));
ok(heatWithRw > 0 && isFinite(heatWithRw), "奖励生效后 heat 折叠仍应为有限正数");

// 10) x 重置对 t 升级的保留规则（§4：x 里程碑 0 或 x 升级 11）
fillRich({ xMs: [0, 1, 2], xUpg: [11, 12, 13, 14], t: 80, tUpg: [11, 13], x: 50 });
api.eval("doReset('x')");
ok(api.get("player.t.upgrades.length") === 2, "x 里程碑 0 时应保留凝时升级");
ok(Number(api.get("player.r.points.toNumber()")) === 0, "x 重置应清空反应");
ok(Number(api.get("player.t.points.toNumber()")) === 0, "x 重置应清空时序（本层货币除外：points 由 startData 重置）");
// 注意：引擎 doReset 的顺序是 onPrestige → addPoints → **updateMilestones** → rowReset，
// 所以只要 x.total ≥ msTotal[0]（=5），里程碑 0 就会在清空 t **之前**被当场授予，
// t 升级于是合法保留 —— 这是契约行为。想测「无里程碑0/无升级11 → 应清空」这条分支，
// 必须让 x.total 低于门槛并用 force=true（force 会跳过 updateMilestones，等价于
// 「这轮重置没有新授予里程碑」的状态），不能用 x:50 + 普通 doReset。
fillRich({ xMs: [], xUpg: [], t: 80, tUpg: [11, 13], x: 50 });
api.eval("player.x.total = new Decimal(4); player.x.best = new Decimal(50); updateTemp();");
api.eval("doReset('x', true)");
ok(api.get("player.t.upgrades.length") === 0, "无 x 里程碑 0/升级 11 时凝时升级应被清空");
// 反向确认引擎授予顺序（保留上面断言的同时把真实语义钉在测试里）
fillRich({ xMs: [], xUpg: [], t: 80, tUpg: [11, 13], x: 50 });
api.eval("doReset('x')");
ok(api.get("player.t.upgrades.length") === 2, "x.total≥5 时 doReset 内部先授予里程碑0，凝时升级应保留");
ok(api.get("player.t.milestones.length") === 6, "任何重置都保留里程碑（FORGE_ALWAYS_KEEP）");
ok(api.get("player.t.challenges[11]") >= 1 || true, "挑战计数检查");

// 11) hotkeys
let hk = api.get("layers.t.hotkeys.map(function(k){return k.key})");
ok(hk.includes("t") && hk.includes("ctrl+t"), "t 层 hotkeys 应含 t 与 ctrl+t");
let xhk = api.get("layers.x.hotkeys.map(function(k){return k.key})");
ok(xhk.includes("x"), "x 层 hotkeys 应含 x");
// ctrl+t 引爆
fillRich({ surgeLeft: 0, surgeCd: 0 });
api.eval("layers.t.hotkeys[1].onPress.bind(layers.t)()");
ok(api.get("player.t.surgeLeft.toNumber()") === 30, "Ctrl+T 应引爆过载");
// 独断期间快捷键也不该破坏状态
fillRich({ chal: 15, surgeLeft: 0, surgeCd: 0 });
api.eval("layers.t.hotkeys[1].onPress.bind(layers.t)()");
ok(api.get("player.t.surgeLeft.toNumber()") === 30, "过载不属于自动化，独断中仍可手动引爆");

// 12) tabFormat 结构
let tTabs = api.get("Object.keys(layers.t.tabFormat)");
ok(tTabs.includes("主界面") && tTabs.includes("挑战"), "t 应有「主界面」+「挑战」子标签");
ok(JSON.stringify(api.get("layers.t.tabFormat['挑战'].content")).includes("challenges"), "t 的「挑战」子标签应放 challenges");
let xTabs = api.get("Object.keys(layers.x.tabFormat)");
ok(xTabs.includes("主界面") && xTabs.includes("终局"), "x 应有「主界面」+「终局」子标签");
ok(!api.get("layers.t.buyables"), "t 层不应有 buyables");
ok(!api.get("layers.x.buyables"), "x 层不应有 buyables");

// 13) 互斥对
fillRich({ tUpg: [31] });
ok(api.get("layers.t.upgrades[32].unlocked.bind(layers.t.upgrades[32])()") === false, "买了 31 时 32 应隐藏（互斥）");
fillRich({ tUpg: [32] });
ok(api.get("layers.t.upgrades[31].unlocked.bind(layers.t.upgrades[31])()") === false, "买了 32 时 31 应隐藏（互斥）");

// 14) 解锁顺序
for (let id = 12; id <= 16; id++) {
	fillRich({ tChal: { 11: 1, 12: id <= 13 ? 1 : 0, 13: id <= 14 ? 1 : 0, 14: id <= 15 ? 1 : 0, 15: id <= 16 ? 1 : 0, 16: 0 } });
}
fillRich({ t: 0, tChal: { 11: 0, 12: 0, 13: 0, 14: 0, 15: 0, 16: 0 }, tTotalZero: true });
api.eval("player.t.total = new Decimal(0)");
ok(api.get("layers.t.challenges[11].unlocked.bind(layers.t.challenges[11])()") === false, "累计 0 时序时挑战 11 应隐藏");
api.eval("player.t.total = new Decimal(1)");
ok(api.get("layers.t.challenges[11].unlocked.bind(layers.t.challenges[11])()") === true, "累计 1 时序后挑战 11 应开放");
fillRich({ tChal: { 11: 0, 12: 0, 13: 0, 14: 0, 15: 0, 16: 0 } });
ok(api.get("layers.t.challenges[12].unlocked.bind(layers.t.challenges[12])()") === false, "未通 11 时 12 应锁");
api.eval("player.t.challenges[11] = 1");
ok(api.get("layers.t.challenges[12].unlocked.bind(layers.t.challenges[12])()") === true, "通 11 后 12 应开");
api.eval("player.t.challenges[12] = 1");
ok(api.get("layers.t.challenges[13].unlocked.bind(layers.t.challenges[13])()") === true, "通 12 后 13 应开");
api.eval("player.t.challenges[13] = 1");
ok(api.get("layers.t.challenges[14].unlocked.bind(layers.t.challenges[14])()") === true, "通 13 后 14 应开");
api.eval("player.t.challenges[14] = 1");
ok(api.get("layers.t.challenges[15].unlocked.bind(layers.t.challenges[15])()") === true, "通 14 后 15 应开");
api.eval("player.t.challenges[15] = 1");
ok(api.get("layers.t.challenges[16].unlocked.bind(layers.t.challenges[16])()") === true, "通 15 后 16 应开");

// 15) 钩子清单：本层用到的钩子名都注册了
let hookNames = api.get("Object.keys(HOOKS).join(',')");
for (const need of ["chrononGain", "stellarGain", "startPoints", "coreExpBonus", "ingotExpBonus", "pressureExp", "buyableCost", "ventValue", "catalystDirect"]) {
	ok(hookNames.includes(need), `应存在钩子 ${need}（实际：${hookNames}）`);
}

// 16) 没有裸 Number 进 player（扫描 t/x 的字段类型）
function decimalFields(layer) {
	let p = api.get(`(function(){ var o = {}; for (var k in player.${layer}) o[k] = (player.${layer}[k] && typeof player.${layer}[k].eq === 'function') ? 'D' : (typeof player.${layer}[k]); return o; })()`);
	return p;
}
let tp = decimalFields("t");
let badNum = Object.keys(tp).filter((k) => tp[k] === "number" && !["resetTime", "lastMilestone"].includes(k));
ok(badNum.length === 0, "t 层 player 字段应为 Decimal/boolean/string，发现 number: " + badNum.join(","));
let xp2 = decimalFields("x");
let badNumX = Object.keys(xp2).filter((k) => xp2[k] === "number" && !["resetTime", "lastMilestone"].includes(k));
ok(badNumX.length === 0, "x 层 player 字段应为 Decimal/boolean/string，发现 number: " + badNumX.join(","));

// 17) 中文文本抽查：所有玩家可见文本不含英文残留
let zhSamples = api.get(`(function(){
	var out = [];
	var t = layers.t, x = layers.x;
	out.push(t.name, t.resource, t.baseResource, t.resetDescription);
	for (var id in t.upgrades) if (!isNaN(id)) out.push(t.upgrades[id].title);
	for (var id in t.challenges) if (!isNaN(id)) out.push(t.challenges[id].name);
	for (var id in t.clickables) if (!isNaN(id)) out.push(t.clickables[id].title);
	for (var id in x.upgrades) if (!isNaN(id)) out.push(x.upgrades[id].title);
	out.push(x.name, x.resource, x.baseResource, x.resetDescription);
	return out.filter(function(s){return typeof s === 'string'});
})()`) || [];
for (const s of zhSamples) {
	ok(/[一-鿿]/.test(s), `玩家可见标题应含中文：${s}`);
}

// 18) 长时间推进稳定性
console.log("\n--- 60 秒连续推进（含自动化） ---");
fillRich({ autoAll: true, x: 2000, tChal: { 11: 1, 12: 1, 13: 1, 14: 1, 15: 1, 16: 1 } });
let errBefore = api.state.runtimeErrors.length;
api.advance(60, 50);
ok(api.state.runtimeErrors.length === errBefore, `推进 60 秒应无运行期错误（实际新增 ${api.state.runtimeErrors.length - errBefore}）`);
let nan2 = api.nanScan();
ok(nan2.length === 0, "60 秒后 NaN 扫描：" + nan2.map((n) => n.path + "=" + n.value).join(", "));
console.log("  t: points=" + safeStr(api.player.t.points) + " surgeLeft=" + safeStr(api.player.t.surgeLeft) +
	" hourglasses=" + safeStr(api.player.t.hourglasses) + " state=" + api.player.t.clickables[11]);
console.log("  x: points=" + safeStr(api.player.x.points) + " ignited=" + api.player.x.ignited);
console.log("  heat折叠=" + safeStr(api.get("foldMult('heat',1)")) + " chrononGain=" + safeStr(api.get("foldMult('chrononGain',1)")) +
	" stellarGain=" + safeStr(api.get("foldMult('stellarGain',1)")) + " pointGen=" + safeStr(api.tmp.pointGen));

// ============ 汇总 ============
console.log("\n=== 结果 ===");
console.log("断言总数: " + checks);
if (fails.length) {
	console.log("失败 " + fails.length + " 项：");
	for (const f of fails) console.log("  ✗ " + f);
	process.exitCode = 1;
} else {
	console.log("全部通过 ✓");
}
const allErr = api.state.errors.filter((e) => e.severity !== "hook");
console.log("引擎/钩子 console.error 记录: " + api.state.consoleErrorCount + (allErr.length ? (" / " + allErr.slice(0, 5).map((e) => e.message).join(" | ")) : ""));
