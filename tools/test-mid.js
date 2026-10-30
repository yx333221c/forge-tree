// tools/test-mid.js —— layers-mid 的回归自检脚本（永久保留）
// 目的：
//   1) 严格「加载期」检查：只提供 addLayer / Decimal / helpers.js，不提供 format / player /
//      tmp / hasUpgrade，验证 js/Forge/m.js 与 js/Forge/r.js 的 addLayer 字面量不求值它们。
//   2) 运行期数值检查：用 mock 的 player/tmp/layers + 引擎同构函数，调用本层的
//      gainExp / gainMult / directMult / cost / effect / 买卖 / doReset，并把结果送进
//      引擎的 normal / static 公式（复刻 js/game.js），在 base=0/1/49/50/1e6/1e30、
//      持有量 x=0/1/40、以及「恶意钩子返回 NaN/0/Infinity」等边界下确认不产生 NaN/Infinity。
// 所有 Decimal 运算都在 vm context 内完成，只有字符串/布尔回到 Node（避免跨 realm 比较）。
// 用法：node tools/test-mid.js
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const BE = read("js/technical/break_eternity.js");

let fails = 0;
function ok(name, cond, extra) {
	if (cond) console.log("  [OK]   " + name);
	else { fails++; console.log("  [FAIL] " + name + (extra ? "  → " + extra : "")); }
}

function makeCtx() {
	// 不给 module/exports：break_eternity 的 UMD 会把 Decimal 挂到 context 的 globalThis 上
	const c = vm.createContext({ console, Math, isFinite, isNaN, parseFloat, parseInt, JSON })
	vm.runInContext(BE, c)
	vm.runInContext("if (typeof Decimal === 'undefined' && typeof globalThis.Decimal !== 'undefined') { var Decimal = globalThis.Decimal }", c)
	return c
}

// ===========================================================================
// 附加模式：node tools/test-mid.js --pacing[=分钟] --policy=cap
// 用真实 harness（tools/harness.js）跑中层节奏，输出：
//   * 锭条 0 → 1e2 / 1e4 / 1e6 的时间
//   * m / r 升级与里程碑的购买时间线
//   * r 的 static 成本曲线（每次反应后的 nextAt 与 gain）
// ===========================================================================
if (process.argv.slice(2).some(a => a.startsWith("--pacing"))) {
	const arg = process.argv.slice(2).find(a => a.startsWith("--pacing"))
	const MIN = Number((arg.split("=")[1]) || 45)
	const POLICY = (process.argv.slice(2).find(a => a.startsWith("--policy=")) || "--policy=cap").split("=")[1]
	const H = require("./harness.js")
	const api = H.boot({ seed: 7 })
	// harness 会注册 process.on("uncaughtException") 吞掉本脚本崩溃 → 必须移除
	process.removeAllListeners("uncaughtException")
	process.removeAllListeners("unhandledRejection")
	const cx = api.ctx
	// 可选：--set="M_BAL.upgCost[21]=8,M_BAL.milestones[0]=5" 做 A/B，不改层文件
	const setArg = (process.argv.slice(2).find(a => a.startsWith("--set=")) || "").slice(6)
	if (setArg) {
		for (const kv of setArg.split(",")) {
			const m = /^([MR]_BAL\.[A-Za-z_]+(?:\[[0-9]+\])?)=(.+)$/.exec(kv.trim())
			if (!m) { console.log("忽略无法解析的 --set 项：" + kv); continue }
			const r = vm.runInContext(`(function(){ try { ${m[1]} = new Decimal(${m[2]}); return "OK " + ${m[1]}.toString() } catch(e) { return "ERR " + e.message } })()`, cx)
			console.log("override: " + m[1] + "=" + m[2] + " → " + r)
		}
	}
	api.newGame()
	vm.runInContext(`
	var __ms = Date.now();
	function __tick(d){ __ms += d*1000; player.time = __ms; updateTemp(); gameLoop(d); }
	`, cx)
	const bot = `(function(){
		for (const L of ["h","m","r"]) {
			if (!layers[L] || !player[L]) continue;
			for (const id in layers[L].upgrades) { if (!isNaN(id) && canAffordUpgrade(L,id) && !hasUpgrade(L,id)) buyUpg(L,id); }
			for (const id in layers[L].buyables) { if (!isNaN(id) && canBuyBuyable(L,id)) buyBuyable(L,id); }
			// 真实玩家：拿到自动化里程碑就打开开关（DESIGN §0.3「里程碑=自动化」）
			for (const msid in layers[L].milestones) {
				var mt = layers[L].milestones[msid].toggles;
				if (!mt) continue;
				if (!hasMilestone(L, msid)) continue;
				for (const tg of mt) { if (player[tg[0]] && !player[tg[0]][tg[1]]) { player[tg[0]][tg[1]] = true; } }
			}
		}
		if (canVent()) {
			var go = ${POLICY === "cap" ? "player.h.pressure.gte(H_BAL.pressureCap*0.999)" : POLICY === "asap" ? "true" : "false"};
			if (go) forgeVent();
		}
		if (canReset("h") && tmp.h.resetGain.gte(3)) doReset("h");
		if (canReset("m") && tmp.m.resetGain.gte(2)) doReset("m");
		if (canReset("r") && tmp.r.resetGain.gte(1)) doReset("r");
	})()`
	const S = (e) => { try { return vm.runInContext(e, cx) } catch (x) { return undefined } }
	const str = (e) => { try { return String(vm.runInContext("String(" + e + ")", cx)) } catch (x) { return "?" } }
	const t = (sim) => (sim < 60 ? Math.round(sim) + "s" : (sim / 60).toFixed(2) + "min")
	const marks = {}
	const upgrades = []
	const rcurve = []
	let prevIngot = 0, prevCat = 0
	let sim = 0
	while (sim < MIN * 60) {
		vm.runInContext("__tick(0.1)", cx)
		sim += 0.1
		vm.runInContext(bot, cx)
		for (const [k, e] of [
			["解锁锻造", "player.m.unlocked"],
			["锭条1e2", "player.m.total.gte(100)"],
			["锭条1e4", "player.m.total.gte(1e4)"],
			["锭条1e6", "player.m.total.gte(1e6)"],
			["解锁反应", "player.r.unlocked"],
			["触媒10", "player.r.total.gte(10)"],
			["触媒30", "player.r.total.gte(30)"],
		]) if (marks[k] === undefined && S(e) === true) marks[k] = sim
		// 升级/里程碑时间线：一次 vm 调用取快照，避免跨 realm 传数组
		const snap = String(S(`(function(){var out=[];for (const L of ["m","r"]){ if(!player[L]) continue; for (const id of player[L].upgrades) out.push("U"+L+"#"+id); for (const id of player[L].milestones) out.push("M"+L+"#"+id); } return out.join(",") })()`) || "")
		for (const tok of snap.split(",")) {
			if (!tok || marks[tok]) continue
			marks[tok] = sim
			if (tok[0] === "U") {
				const L = tok[1], id = tok.split("#")[1]
				upgrades.push(`${t(sim)}  买 ${L} ${id} ${str(`(layers.${L}.upgrades[${id}] && layers.${L}.upgrades[${id}].title) || "?"`)}`)
			} else {
				const L = tok[1], id = tok.split("#")[1]
				console.log(`  ${t(sim)}  里程碑 ${L} ${id} ${str(`(layers.${L}.milestones[${id}] && layers.${L}.milestones[${id}].effectDescription) ? String(layers.${L}.milestones[${id}].effectDescription).slice(0,40) : ""`)}`)
			}
		}
		// r 的成本曲线采样：每次触媒增加就记录
		const cat = Number(S("player.r.points.toNumber()") || 0)
		if (cat > prevCat) {
			prevCat = cat
			rcurve.push(`${t(sim)}  触媒=${cat} 需锭条=${str("tmp.r.nextAtDisp")} 持有锭条=${str("player.m.points")} gain=${str("tmp.r.resetGain")}`)
		}
		prevIngot = Number(S("player.m.points.toNumber()") || 0)
		if (api.errors().length > 8) break
	}
	console.log(`=== 中层节奏（${MIN}min，策略=${POLICY}）===`)
	console.log("里程碑时间：")
	for (const k of ["解锁锻造", "锭条1e2", "锭条1e4", "锭条1e6", "解锁反应", "触媒10", "触媒30"]) {
		console.log(`  ${k.padEnd(10)}: ${marks[k] === undefined ? "未达成" : t(marks[k])}`)
	}
	console.log("\n升级时间线（前 30 条）：")
	upgrades.slice(0, 30).forEach(l => console.log("  " + l))
	console.log("\nr 成本曲线（前 20 个采样）：")
	rcurve.slice(0, 20).forEach(l => console.log("  " + l))
	console.log("\n末态：", str(`"热量=" + player.points + " /s=" + tmp.pointGen + " 炉芯=" + player.h.points + " 锭条=" + player.m.points + " 累计锭条=" + player.m.total + " 触媒=" + player.r.points + " 累计触媒=" + player.r.total + " m重置=" + player.m.resets + " r重置=" + player.r.resets`))
	console.log("NaN:", api.nanScan().length, "错误:", JSON.stringify(api.errors().map(e => (e.file || e.fn || "") + "|" + e.message).slice(0, 4)))
	process.exitCode = 0
} else {

{
	const c1 = makeCtx();
	vm.runInContext(`
		var decimalZero = new Decimal(0), decimalOne = new Decimal(1);
		var UP = 0, DOWN = 1, LEFT = 2, RIGHT = 3;   // layerSupport.js 在 modFiles 之前加载
		var __added = {};
		function addLayer(n, d) { __added[n] = d }
	`, c1);
	vm.runInContext(read("js/Forge/helpers.js"), c1);
	for (const f of ["js/Forge/m.js", "js/Forge/r.js"]) {
		let err = null;
		try { vm.runInContext(read(f), c1, { filename: f }) } catch (e) { err = e.message }
		ok("加载期不依赖 format/player：" + f, !err, err);
	}
	const keys = vm.runInContext("Object.keys(__added).join(',')", c1);
	ok("addLayer 注册了 m 与 r（" + keys + "）", keys.includes("m") && keys.includes("r"));
	console.log("  已注册钩子：" + vm.runInContext("Object.keys(HOOKS).sort().join(', ')", c1));
	console.log("  hookCount：heat=" + vm.runInContext("hookCount('heat')", c1) +
		" coreGain=" + vm.runInContext("hookCount('coreGain')", c1) +
		" ingotGain=" + vm.runInContext("hookCount('ingotGain')", c1) +
		" ingotExpBonus=" + vm.runInContext("hookCount('ingotExpBonus')", c1) +
		" ventValue=" + vm.runInContext("hookCount('ventValue')", c1) +
		" pressureRate=" + vm.runInContext("hookCount('pressureRate')", c1) +
		" hPassiveAdd=" + vm.runInContext("hookCount('hPassiveAdd')", c1) +
		" catalystCost=" + vm.runInContext("hookCount('catalystCost')", c1) +
		" catalystDirect=" + vm.runInContext("hookCount('catalystDirect')", c1));
	// 加载期不许求值 format：以下必须全部抛错（证明我们没在字面量里调它）
	ok("加载期上下文确实没有 format", vm.runInContext("typeof format === 'undefined'", c1));
	ok("加载期上下文确实没有 player", vm.runInContext("typeof player === 'undefined'", c1));
}

// ===========================================================================
// 阶段 2：运行期 mock（引擎同构函数）
// ===========================================================================
console.log("\n=== 2) 运行期数值（mock） ===");
const ctx = makeCtx();
vm.runInContext(`
var decimalZero = new Decimal(0), decimalOne = new Decimal(1);
var UP = 0, DOWN = 1, LEFT = 2, RIGHT = 3;
var layers = {}, tmp = {}, funcs = {}, player = {};
var shiftDown = false, needCanvasUpdate = false;
function addLayer(n, d) { layers[n] = d }
function hasUpgrade(l, id) { return !!(player[l] && player[l].upgrades && (player[l].upgrades.includes(Number(id)) || player[l].upgrades.includes(String(id)))) }
function hasMilestone(l, id) { return !!(player[l] && player[l].milestones && (player[l].milestones.includes(Number(id)) || player[l].milestones.includes(String(id)))) }
function getBuyableAmount(l, id) { return player[l].buyables[id] }
function setBuyableAmount(l, id, a) { player[l].buyables[id] = a }
function addBuyables(l, id, a) { player[l].buyables[id] = player[l].buyables[id].add(a) }
function inChallenge(l, id) { return !!(player[l] && player[l].activeChallenge !== null && player[l].activeChallenge !== undefined && Number(player[l].activeChallenge) === Number(id)) }
function updateBuyableTemp(l) {}
function toNumber(x) { if (x && x.mag !== undefined) return x.toNumber(); if (x + 0 !== x) return parseFloat(x); return x }
function format(x) { try { return (x instanceof Decimal ? x : new Decimal(x || 0)).toString() } catch(e) { return "BAD" } }
function formatWhole(x) { return format(x) }
function formatTime(s) { return Math.floor(s) + "s" }
function canReset(l) { return true }
function doReset(l) {}
function respecBuyables(l) { var b = layers[l].buyables; if (b.respec) b.respec.bind(b)() }
function buyUpg(l, id) { player[l].upgrades.push(Number(id)) }
function buyMaxBuyable(l, id) { var b = layers[l].buyables[id]; if (b.buyMax) b.buyMax.bind(b)() }
function layerDataReset(layer, keep) {
	keep = keep || [];
	var old = player[layer];
	var fresh = layers[layer].startData ? layers[layer].startData() : {};
	var np = {};
	for (var k in fresh) np[k] = fresh[k];
	np.upgrades = []; np.milestones = []; np.achievements = []; np.challenges = {};
	np.buyables = {}; for (var id in layers[layer].buyables) if (!isNaN(id)) np.buyables[id] = new Decimal(0);
	np.spentOnBuyables = new Decimal(0);
	np.unlocked = old.unlocked;
	for (var i = 0; i < keep.length; i++) { var key = keep[i]; if (old[key] !== undefined) np[key] = old[key] }
	player[layer] = np;
}
// —— 引擎公式复刻（js/game.js getResetGain / getNextAt，normal 与 static） ——
// 真实引擎读的是 tmp[layer].requires / exponent / base ...，而 setupTempData 会把**函数属性**
// 每帧求值成 Decimal。requires 现在是函数形式，所以这里也必须先解析函数（用 L_）。
function L_(layer, key) {
	var v = layers[layer][key]
	if (typeof v === "function") return v.call(layers[layer])
	return v
}
function D_(v) { return (v && typeof v.isNan === "function") ? v : new Decimal(v) }
function engGain(layer) {
	var L = layers[layer];
	var req = D_(L_(layer, "requires"));
	if (L.type == "normal") {
		var base = L.baseAmount();
		if (base.lt(req)) return new Decimal(0);
		var sc = D_(L_(layer, "softcap")), sp = D_(L_(layer, "softcapPower"));
		var gain = base.div(req).pow(D_(L_(layer, "exponent"))).times(L.gainMult()).pow(L.gainExp());
		if (gain.gte(sc)) gain = gain.pow(sp).times(sc.pow(new Decimal(1).minus(sp)));
		gain = gain.times(L.directMult());
		return gain.floor().max(0);
	}
	if (L.type == "static") {
		var base2 = L.baseAmount();
		if (!L.canBuyMax() || base2.lt(req)) return new Decimal(1);
		var g = base2.div(req).div(L.gainMult()).max(1).log(Number(L_(layer, "base"))).times(L.gainExp()).pow(new Decimal(1).div(D_(L_(layer, "exponent"))));
		g = g.times(L.directMult());
		return g.floor().sub(player[layer].points).add(1).max(1);
	}
	return new Decimal(0);
}
function engNextAt(layer, canMax) {
	var L = layers[layer];
	var gm = L.gainMult(), ge = L.gainExp(), dm = L.directMult();
	var req = D_(L_(layer, "requires"));
	if (gm.lte(0) || ge.lte(0)) return new Decimal(Infinity);
	if (L.type == "normal") {
		var gain = engGain(layer);
		var sc = D_(L_(layer, "softcap")), sp = D_(L_(layer, "softcapPower"));
		var next = gain.add(1).div(dm);
		if (next.gte(sc)) next = next.div(sc.pow(new Decimal(1).minus(sp))).pow(new Decimal(1).div(sp));
		next = next.root(ge).div(gm).root(D_(L_(layer, "exponent"))).times(req).max(req);
		if (L_(layer, "roundUpCost")) next = next.ceil();
		return next;
	}
	if (L.type == "static") {
		var cmax = Boolean(L.canBuyMax()) && canMax;
		var amt = player[layer].points.plus((cmax && L.baseAmount().gte(req)) ? engGain(layer) : 0).div(dm);
		var extraCost = D_(new Decimal(L_(layer, "base"))).pow(amt.pow(D_(L_(layer, "exponent"))).div(ge)).times(gm);
		var cost = extraCost.times(req).max(req);
		if (L_(layer, "roundUpCost")) cost = cost.ceil();
		return cost;
	}
	return new Decimal(0);
}
`, ctx);
vm.runInContext(read("js/Forge/helpers.js"), ctx);
let loadErr = null;
try { vm.runInContext(read("js/Forge/m.js"), ctx, { filename: "js/Forge/m.js" }) } catch (e) { loadErr = "m.js: " + e.message }
try { vm.runInContext(read("js/Forge/r.js"), ctx, { filename: "js/Forge/r.js" }) } catch (e) { loadErr = (loadErr ? loadErr + " | " : "") + "r.js: " + e.message }
ok("运行期加载 m.js + r.js", !loadErr, loadErr);

vm.runInContext(`
function mkSeed(layer) {
	var d = layers[layer].startData();
	d.upgrades = []; d.milestones = []; d.achievements = []; d.challenges = {};
	d.buyables = {}; for (var id in layers[layer].buyables) if (!isNaN(id)) d.buyables[id] = new Decimal(0);
	d.spentOnBuyables = new Decimal(0);
	return d;
}
player.h = { unlocked: true, points: new Decimal(0), best: new Decimal(0), total: new Decimal(0), resets: new Decimal(0), vents: new Decimal(0), reserveCore: new Decimal(0), upgrades: [], milestones: [], buyables: {} };
player.m = mkSeed("m");
player.r = mkSeed("r");
player.m.unlocked = true;
player.r.unlocked = true;
// 占位层（h/t/x 由别人实现）：forgeDoReset 需要 layers[id].row 存在
layers.h = layers.h || { row: 0, layer: "h", startData: function () { return player.h } };
layers.t = { row: 3, layer: "t", buyables: {}, upgrades: {}, startData: function () { return player.t } };
layers.x = { row: 4, layer: "x", buyables: {}, upgrades: {}, startData: function () { return player.x } };
player.t = { activeChallenge: null, unlocked: true, challenges: {} };
player.x = { unlocked: true, milestones: [], upgrades: [], buyables: {}, points: new Decimal(0) };
player.ach = { achievements: [] };
tmp.h = {}; tmp.m = {}; tmp.r = {};
// 模拟引擎 setupLayer：给层与其组件补 layer/id（js/technical/layerSupport.js）
function emulateSetupLayer(l) {
	layers[l].layer = l;
	for (var group of ["upgrades", "buyables", "milestones", "infoboxes", "bars"]) {
		if (!layers[l][group]) continue;
		layers[l][group].layer = l;
		for (var id in layers[l][group]) {
			if (isPlainObj(layers[l][group][id])) { layers[l][group][id].id = id; layers[l][group][id].layer = l }
		}
	}
	if (layers[l].hotkeys) layers[l].hotkeys.forEach(function (h) { h.layer = l })
}
function isPlainObj(o) { return !!o && o.constructor === Object }
emulateSetupLayer("m"); emulateSetupLayer("r");
`, ctx);

// --- 检查辅助 ---
function V(expr) { return vm.runInContext(expr, ctx) }
function chkNum(expr, label) {
	const r = V(`(function(){ try {
		var v = (${expr});
		if (v === undefined || v === null) return "MISSING";
		if (typeof v !== "object" || typeof v.isNan !== "function") v = new Decimal(v);
		if (v.isNan()) return "NaN";
		if (!v.isFinite()) return "INF:" + v.sign;
		return "OK:" + v.toString();
	} catch(e) { return "THROW:" + e.message } })()`)
	ok(label, r.startsWith("OK:"), r);
	return r.startsWith("OK:") ? r.slice(3) : null;
}

// ===========================================================================
// m 层：normal 公式
// ===========================================================================
console.log("\n--- m 层（normal，§3.5）---");
const MBASES = ["0", "1", "49", "50", "1000", "1e6", "1e30", "1e100"];
for (const b of MBASES) {
	V(`player.h.points = new Decimal("${b}"); player.m.upgrades = []; player.m.buyables["11"] = new Decimal(0); player.m.buyables["12"] = new Decimal(0);`);
	chkNum("layers.m.gainExp()", `m.gainExp（base=${b}）`);
	chkNum("layers.m.gainMult()", `m.gainMult（base=${b}）`);
	chkNum("layers.m.directMult()", `m.directMult（base=${b}）`);
	chkNum("engGain('m')", `m.resetGain（base=${b}）`);
	chkNum("engNextAt('m', false)", `m.nextAt（base=${b}）`);
	ok(`m.nextAt ≥ requires（base=${b}）`, V(`engNextAt('m', false).gte(D_(L_('m','requires')))`));
	ok(`m.gainExp ∈ (0,2]（base=${b}）`, V(`layers.m.gainExp().gt(0) && layers.m.gainExp().lte(2)`));
	V(`player.m.buyables["11"] = new Decimal(40); player.m.buyables["12"] = new Decimal(30);`);
	chkNum("engGain('m')", `m.resetGain（轧辊40/废料30，base=${b}）`);
	chkNum("engNextAt('m', false)", `m.nextAt（轧辊40，base=${b}）`);
	chkNum("foldMult('heat',1)", `heat 钩子（轧辊40/废料30，base=${b}）`);
	chkNum("foldMult('coreGain',1)", `coreGain 钩子（base=${b}）`);
	chkNum("foldMult('ingotGain',1)", `ingotGain 钩子（base=${b}）`);
	chkNum("layers.m.effect().heat", `m.effect().heat（base=${b}）`);
	chkNum("layers.m.effect().core", `m.effect().core（base=${b}）`);
	V(`player.m.buyables["11"] = new Decimal(0); player.m.buyables["12"] = new Decimal(0);`);
}
ok("m.exponent === 1（§3.5：指数交给 gainExp）", V("layers.m.exponent === 1"));
ok("m.requires 函数返回 50", V("layers.m.requires().toNumber() === 50"));
ok("m.type === normal / row === 1", V("layers.m.type === 'normal' && layers.m.row === 1"));
ok("m.gainExp 无加成时 = 0.5", V(`(function(){ player.m.upgrades=[]; return layers.m.gainExp().eq(new Decimal('0.5')) })()`));
ok("m.gainMult = foldMult('ingotGain',1)（轧辊5根 → ×1.5^5）", V(`(function(){
	player.m.buyables["11"] = new Decimal(5);
	var want = new Decimal('1.5').pow(5);
	var got = layers.m.gainMult();
	player.m.buyables["11"] = new Decimal(0);
	return got.eq(want);
})()`));
ok("m23 辊压机提高 gainExp", V(`(function(){ var a = layers.m.gainExp(); player.m.upgrades=[23]; var b = layers.m.gainExp(); player.m.upgrades=[]; return b.gt(a) && b.eq(a.add(new Decimal('0.05'))) })()`));
ok("m11+m21 → coreGain ×15", V(`(function(){
	var base = foldMult('coreGain',1);
	player.m.upgrades=[11,21];
	var v = foldMult('coreGain',1);
	player.m.upgrades=[];
	return v.eq(base.times(15));
})()`));
ok("m14+m24 → heat ×1000", V(`(function(){
	var base = foldMult('heat',1);
	player.m.upgrades=[14,24];
	var v = foldMult('heat',1);
	player.m.upgrades=[];
	return v.eq(base.times(1000));
})()`));
ok("m12 淬火槽 → ventValue ×3", V(`(function(){
	var base = foldMult('ventValue',1);
	player.m.upgrades=[12];
	var v = foldMult('ventValue',1);
	player.m.upgrades=[];
	return v.eq(base.times(3));
})()`));
ok("m13 配重锤 → pressureRate ×1.5（乘法语义）", V(`(function(){
	var base = foldMult('pressureRate',1);
	player.m.upgrades=[13];
	var v = foldMult('pressureRate',1);
	player.m.upgrades=[];
	return v.eq(base.times(new Decimal('1.5')));
})()`));
ok("m31 水力锻机 → hPassiveAdd +0.5", V(`(function(){
	var base = foldAdd('hPassiveAdd',0);
	player.m.upgrades=[31];
	var v = foldAdd('hPassiveAdd',0);
	player.m.upgrades=[];
	return v.eq(base.plus(new Decimal('0.5')));
})()`));
ok("m32 行会盟约 → 热量随泄压次数增长", V(`(function(){
	player.m.upgrades=[32];
	player.h.vents=new Decimal(40); var a = foldMult('heat',1);
	player.h.vents=new Decimal(160); var b = foldMult('heat',1);
	player.m.upgrades=[]; player.h.vents=new Decimal(0);
	return b.gt(a);
})()`));
ok("m2 后 onPrestige 写 player.h.reserveCore=0.5；无 m2 写 0", V(`(function(){
	player.m.milestones=["2"]; layers.m.onPrestige();
	var v = player.h.reserveCore;
	player.m.milestones=[]; layers.m.onPrestige();
	var z = player.h.reserveCore;
	return v.eq(new Decimal('0.5')) && z.eq(0) && v instanceof Decimal;
})()`));
ok("m.onPrestige 递增 player.m.resets", V(`(function(){ var a = player.m.resets.toNumber(); layers.m.onPrestige(); return player.m.resets.toNumber() === a + 1 })()`));

console.log("\n  · m 购入件");
for (const id of ["11", "12"]) {
	V(`player.m.points = new Decimal('1e20'); player.m.spentOnBuyables = new Decimal(0); player.m.buyables["${id}"] = new Decimal(0);`);
	chkNum(`layers.m.buyables[${id}].cost(new Decimal(0))`, `m buy${id} cost(0)`);
	chkNum(`layers.m.buyables[${id}].cost(new Decimal(1))`, `m buy${id} cost(1)`);
	chkNum(`layers.m.buyables[${id}].cost(new Decimal(40))`, `m buy${id} cost(40)`);
	chkNum(`layers.m.buyables[${id}].effect(new Decimal(40))`, `m buy${id} effect(40)`);
	ok(`m buy${id} effect(0) === 1`, V(`layers.m.buyables[${id}].effect(new Decimal(0)).eq(1)`));
	ok(`m buy${id} cost 递增`, V(`layers.m.buyables[${id}].cost(new Decimal(5)).lt(layers.m.buyables[${id}].cost(new Decimal(6)))`));
	const disp = V(`layers.m.buyables[${id}].display.bind(layers.m.buyables[${id}])()`);
	ok(`m buy${id} display 文本健康`, typeof disp === "string" && !/NaN|Infinity|undefined/.test(disp), String(disp).slice(0, 80));
	// buyMax 到上限
	V(`layers.m.buyables[${id}].buyMax.bind(layers.m.buyables[${id}])()`);
	ok(`m buy${id} buyMax 抵达 purchaseLimit`, V(`getBuyableAmount("m","${id}").gte(layers.m.buyables[${id}].purchaseLimit)`));
	ok(`m buy${id} spentOnBuyables > 0`, V(`player.m.spentOnBuyables.gt(0)`));
	// 满限后 buy 不扣钱
	const ptsBefore = V(`player.m.points.toString()`);
	V(`layers.m.buyables[${id}].buy.bind(layers.m.buyables[${id}])()`);
	ok(`m buy${id} 满限后 buy 不扣钱`, V(`player.m.points.toString() === "${ptsBefore}"`));
	// sellAll 归零 + sellOne 在 0 不越界
	V(`layers.m.buyables[${id}].sellAll.bind(layers.m.buyables[${id}])()`);
	ok(`m buy${id} sellAll 归零`, V(`getBuyableAmount("m","${id}").toNumber() === 0`));
	V(`layers.m.buyables[${id}].sellOne.bind(layers.m.buyables[${id}])()`);
	ok(`m buy${id} sellOne 在 0 上不产生负数`, V(`getBuyableAmount("m","${id}").gte(0) && player.m.points.gte(0)`));
	// Shift 批量
	V(`shiftDown = true; player.m.points = new Decimal('1e12'); layers.m.buyables[${id}].buy.bind(layers.m.buyables[${id}])(); shiftDown = false;`);
	ok(`m buy${id} Shift 批量 = 10`, V(`getBuyableAmount("m","${id}").toNumber() === 10`));
	V(`player.m.buyables["${id}"] = new Decimal(0); player.m.spentOnBuyables = new Decimal(0);`);
}
ok("m 成本随 buyableCost 钩子下降（buyableCostFinal）", V(`(function(){
	var a = layers.m.buyables[11].cost(new Decimal(3));
	registerHook('buyableCost', function(){ return new Decimal('0.5') });
	var b = layers.m.buyables[11].cost(new Decimal(3));
	return b.lt(a);
})()`));
ok("m.respec 全额返还 spentOnBuyables 并清空", V(`(function(){
	player.m.points = new Decimal('1e12'); player.m.spentOnBuyables = new Decimal(0);
	player.m.buyables["11"] = new Decimal(0); player.m.buyables["12"] = new Decimal(0);
	layers.m.buyables[11].buyMax(); layers.m.buyables[12].buyMax();
	var pts = player.m.points, spent = player.m.spentOnBuyables;
	layers.m.buyables.respec();
	return player.m.points.eq(pts.add(spent)) && player.m.spentOnBuyables.toNumber() === 0 &&
		getBuyableAmount("m","11").toNumber() === 0 && getBuyableAmount("m","12").toNumber() === 0;
})()`));
ok("m 购入件效果在 t13（贫瘠）中减半", V(`(function(){
	player.t.activeChallenge = null;
	var a = layers.m.buyables[11].effect(new Decimal(4));
	player.t.activeChallenge = 13;
	var b = layers.m.buyables[11].effect(new Decimal(4));
	player.t.activeChallenge = null;
	return b.times(2).eq(a);
})()`));
ok("m 自动化在 t15（独断）中全部停摆（走 autoOn）", V(`(function(){
	player.m.milestones = ["0","1","2","3"]; player.m.autoForge = true; player.m.autoBuy = true; player.m.autoFill = true;
	player.m.points = new Decimal('1e12'); player.m.buyables["11"] = new Decimal(0);
	var pgOn = layers.m.passiveGeneration(), auOn = layers.m.autoUpgrade();
	player.t.activeChallenge = 15;
	var pgOff = layers.m.passiveGeneration(), auOff = layers.m.autoUpgrade();
	layers.m.automate();
	var amtOff = getBuyableAmount("m","11").toNumber();
	player.t.activeChallenge = null;
	layers.m.automate();
	var amtOn = getBuyableAmount("m","11").toNumber();
	return pgOn > 0 && pgOff === 0 && auOn === true && auOff === false && amtOff === 0 && amtOn > 0;
})()`));
ok("m 无里程碑时开关不生效", V(`(function(){
	player.m.milestones = []; player.m.autoForge = true; player.m.autoBuy = true;
	return layers.m.passiveGeneration() === 0 && layers.m.autoUpgrade() === false;
})()`));
ok("m 的 millPassiveAdd 钩子参与 passiveGeneration", V(`(function(){
	player.m.milestones = []; player.m.autoForge = false;
	var base = layers.m.passiveGeneration();
	registerHook('millPassiveAdd', function(){ return new Decimal('0.25') });
	var v = layers.m.passiveGeneration();
	return v === base + 0.25;
})()`));

console.log("\n  · m doReset 保留规则（§4）");
ok("m.doReset('m')：自身锻造不清空本层（§4：m 重置的是 h，不是自己）", V(`(function(){
	player.m.unlocked = true;
	player.m.points = new Decimal(5); player.m.total = new Decimal(999); player.m.best = new Decimal(7);
	player.m.milestones = ["0"]; player.m.resets = new Decimal(3); player.m.upgrades = [11];
	player.m.buyables["11"] = new Decimal(4); player.m.spentOnBuyables = new Decimal(30);
	layers.m.doReset("m");
	return player.m.points.toNumber() === 5 && player.m.upgrades.length === 1 &&
		getBuyableAmount("m","11").toNumber() === 4 && player.m.total.toNumber() === 999 &&
		player.m.milestones.length === 1 && player.m.resets.toNumber() === 3 && player.m.unlocked === true;
})()`));
ok("r21 → m.doReset('r') 保留 upgrades + buyables + spent", V(`(function(){
	player.r.upgrades = [21]; player.m.upgrades = [11]; player.m.buyables["11"] = new Decimal(4); player.m.spentOnBuyables = new Decimal(30);
	layers.m.doReset("r");
	var a = player.m.upgrades.length === 1 && getBuyableAmount("m","11").toNumber() === 4 && player.m.spentOnBuyables.toNumber() === 30;
	player.r.upgrades = []; return a;
})()`));
ok("t12 → m.doReset('t') 只保留 upgrades", V(`(function(){
	player.m.upgrades=[11]; player.m.buyables["11"]=new Decimal(4); player.m.spentOnBuyables=new Decimal(30);
	player.t = { upgrades:[12], activeChallenge:null }; player.r.upgrades = [];
	layers.m.doReset("t");
	var a = player.m.upgrades.length === 1 && getBuyableAmount("m","11").toNumber() === 0;
	player.t.upgrades = []; return a;
})()`));
ok("t22 → m.doReset('t') 保留 buyables", V(`(function(){
	player.m.upgrades=[11]; player.m.buyables["11"]=new Decimal(3); player.t.upgrades=[22];
	layers.m.doReset("t");
	var a = getBuyableAmount("m","11").toNumber() === 3;
	player.t.upgrades = []; return a;
})()`));
ok("无保留来源 → m.doReset('r') 清空 upgrades+buyables", V(`(function(){
	player.m.upgrades=[11]; player.m.buyables["11"]=new Decimal(3); player.r.upgrades=[]; player.t.upgrades=[];
	layers.m.doReset("r");
	return player.m.upgrades.length === 0 && getBuyableAmount("m","11").toNumber() === 0;
})()`));
ok("m 只写 player.h.reserveCore（不越界改 h 的其它字段）", V(`(function(){
	var before = Object.keys(player.h).sort().join(",");
	var p0 = player.h.points.toString(), u0 = player.h.unlocked;
	layers.m.onPrestige();
	return Object.keys(player.h).sort().join(",") === before && player.h.points.toString() === p0 && player.h.unlocked === u0;
})()`));

// ===========================================================================
// r 层：static 公式
// ===========================================================================
console.log("\n--- r 层（static，§3.5）---");
const RCASES = [["0", "0"], ["0", "10"], ["1", "1e6"], ["40", "1e6"], ["40", "1e30"], ["5", "0"], ["120", "1e100"]];
for (const [p, b] of RCASES) {
	V(`player.r.points = new Decimal("${p}"); player.m.points = new Decimal("${b}"); player.r.upgrades = []; player.r.buyables["11"]=new Decimal(0); player.r.buyables["12"]=new Decimal(0); player.r.buyables["13"]=new Decimal(0); player.r.milestones = ["0","1","2","3"];`);
	chkNum("layers.r.gainMult()", `r.gainMult（points=${p}, ingot=${b}）`);
	chkNum("layers.r.gainExp()", `r.gainExp（points=${p}）`);
	chkNum("layers.r.directMult()", `r.directMult（points=${p}）`);
	chkNum("engGain('r')", `r.resetGain（points=${p}, ingot=${b}）`);
	chkNum("engNextAt('r', true)", `r.nextAtDisp（points=${p}, ingot=${b}）`);
	chkNum("engNextAt('r', false)", `r.nextAt（points=${p}, ingot=${b}）`);
	ok(`r.gainMult ∈ [0.05, 20]（points=${p}）`, V(`layers.r.gainMult().gte(new Decimal('0.05')) && layers.r.gainMult().lte(20)`));
	ok(`r.directMult > 0（points=${p}）`, V(`layers.r.directMult().gt(0)`));
	ok(`r.nextAt ≥ requires（points=${p}, ingot=${b}）`, V(`engNextAt('r', true).gte(D_(L_('r','requires')))`));
	ok(`r.resetGain ≥ 1（points=${p}, ingot=${b}）`, V(`engGain('r').gte(1)`));
	chkNum("layers.r.effect().ingot", `r.effect().ingot（points=${p}）`);
	chkNum("layers.r.effect().heat", `r.effect().heat（points=${p}）`);
	chkNum("foldMult('ingotGain',1)", `ingotGain 钩子（points=${p}）`);
	chkNum("foldMult('heat',1)", `heat 钩子（points=${p}）`);
	chkNum("foldMult('catalystCost',1)", `catalystCost 钩子（points=${p}）`);
	chkNum("foldMult('catalystDirect',1)", `catalystDirect 钩子（points=${p}）`);
}
ok("r.type === static / row === 2 / base === 3 / exponent === 1 / roundUpCost === true",
	V("layers.r.type === 'static' && layers.r.row === 2 && layers.r.base === 3 && layers.r.exponent === 1 && layers.r.roundUpCost === true"));
ok("r.requires 函数返回 10", V("layers.r.requires().toNumber() === 10"));
ok("r13 循环泵使 gainMult（成本）下降", V(`(function(){ var a = layers.r.gainMult(); player.r.upgrades=[13]; var b = layers.r.gainMult(); player.r.upgrades=[]; return b.eq(a.times(new Decimal('0.85'))) })()`));
ok("r24 深冷分离使 gainMult（成本）下降", V(`(function(){ var a = layers.r.gainMult(); player.r.upgrades=[24]; var b = layers.r.gainMult(); player.r.upgrades=[]; return b.eq(a.times(new Decimal('0.7'))) })()`));
ok("r14 惰性保护使 directMult（产出）上升", V(`(function(){ var a = layers.r.directMult(); player.r.upgrades=[14]; var b = layers.r.directMult(); player.r.upgrades=[]; return b.eq(a.times(1.5)) })()`));
ok("r12 高压釜提高热量效果", V(`(function(){ player.r.points=new Decimal(100); var a = layers.r.effect().heat; player.r.upgrades=[12]; var b = layers.r.effect().heat; player.r.upgrades=[]; return b.gt(a) })()`));
ok("r11+r22 → ingotGain ×30", V(`(function(){
	var base = foldMult('ingotGain',1);
	player.r.upgrades=[11,22];
	var v = foldMult('ingotGain',1);
	player.r.upgrades=[];
	return v.eq(base.times(30));
})()`));
ok("r.canBuyMax 依赖里程碑 1", V(`(function(){ player.r.milestones=[]; var a = layers.r.canBuyMax(); player.r.milestones=["1"]; var b = layers.r.canBuyMax(); return a === false && b === true })()`));

console.log("\n  · r 购入件（成本 = 锭条）");
for (const id of ["11", "12", "13"]) {
	V(`player.m.points = new Decimal('1e12'); player.r.points = new Decimal(10); player.r.spentOnBuyables = new Decimal(0); player.r.buyables["${id}"] = new Decimal(0); player.r.upgrades = [];`);
	chkNum(`layers.r.buyables[${id}].cost(new Decimal(0))`, `r buy${id} cost(0)`);
	chkNum(`layers.r.buyables[${id}].cost(new Decimal(40))`, `r buy${id} cost(40)`);
	chkNum(`layers.r.buyables[${id}].effect(new Decimal(40))`, `r buy${id} effect(40)`);
	ok(`r buy${id} effect(0) === 1`, V(`layers.r.buyables[${id}].effect(new Decimal(0)).eq(1)`));
	const disp = V(`layers.r.buyables[${id}].display.bind(layers.r.buyables[${id}])()`);
	ok(`r buy${id} display 文本健康`, typeof disp === "string" && !/NaN|Infinity|undefined/.test(disp), String(disp).slice(0, 80));
	const ptsBefore = V(`player.m.points.toString()`);
	const catBefore = V(`player.r.points.toString()`);
	V(`layers.r.buyables[${id}].buyMax.bind(layers.r.buyables[${id}])()`);
	ok(`r buy${id} buyMax 抵达 purchaseLimit`, V(`getBuyableAmount("r","${id}").gte(layers.r.buyables[${id}].purchaseLimit)`));
	ok(`r buy${id} 扣锭条、不动触媒`, V(`player.m.points.lt(new Decimal("${ptsBefore}")) && player.r.points.toString() === "${catBefore}"`));
	chkNum("foldMult('heat',1)", `heat 钩子（buy${id} 满级）`);
	chkNum("foldMult('coreGain',1)", `coreGain 钩子（buy${id} 满级）`);
	chkNum("foldMult('pressureRate',1)", `pressureRate 钩子（buy${id} 满级）`);
	V(`layers.r.buyables[${id}].sellAll.bind(layers.r.buyables[${id}])()`);
	ok(`r buy${id} sellAll 归零`, V(`getBuyableAmount("r","${id}").toNumber() === 0`));
	V(`layers.r.buyables[${id}].sellOne.bind(layers.r.buyables[${id}])()`);
	ok(`r buy${id} sellOne 在 0 上不越界`, V(`getBuyableAmount("r","${id}").gte(0) && player.m.points.gte(0) && player.r.spentOnBuyables.gte(0)`));
	V(`shiftDown = true; player.m.points = new Decimal('1e12'); layers.r.buyables[${id}].buy.bind(layers.r.buyables[${id}])(); shiftDown = false;`);
	ok(`r buy${id} Shift 批量 = 10`, V(`getBuyableAmount("r","${id}").toNumber() === 10`));
	V(`player.r.buyables["${id}"] = new Decimal(0); player.r.spentOnBuyables = new Decimal(0);`);
}
ok("r.respec 全额返还锭条", V(`(function(){
	player.m.points = new Decimal('1e12'); player.r.spentOnBuyables = new Decimal(0);
	for (var id in layers.r.buyables) if (!isNaN(id)) player.r.buyables[id] = new Decimal(0);
	layers.r.buyables[11].buyMax(); layers.r.buyables[12].buyMax(); layers.r.buyables[13].buyMax();
	var pts = player.m.points, spent = player.r.spentOnBuyables;
	layers.r.buyables.respec();
	return player.m.points.eq(pts.add(spent)) && player.r.spentOnBuyables.toNumber() === 0 &&
		getBuyableAmount("r","11").toNumber() === 0;
})()`));
ok("r23 平衡移转使购入件效果 ×1.5", V(`(function(){
	player.r.upgrades=[]; var a = layers.r.buyables[11].effect(new Decimal(5));
	player.r.upgrades=[23]; var b = layers.r.buyables[11].effect(new Decimal(5));
	player.r.upgrades=[]; return b.eq(a.times(new Decimal('1.5')));
})()`));
ok("r23/r24 互斥（unlocked 检查对方）", V(`(function(){
	player.r.upgrades=[24]; var a = layers.r.upgrades[23].unlocked();
	player.r.upgrades=[23]; var b = layers.r.upgrades[24].unlocked();
	player.r.upgrades=[]; return a === false && b === false;
})()`));
ok("m31/m32 互斥（unlocked 检查对方）", V(`(function(){
	player.m.upgrades=[21,22,23,24,32]; var a = layers.m.upgrades[31].unlocked();
	player.m.upgrades=[21,22,23,24,31]; var b = layers.m.upgrades[32].unlocked();
	player.m.upgrades=[]; return a === false && b === false;
})()`));
ok("r 购入件效果在 t13 中减半", V(`(function(){
	player.t.activeChallenge=null; var a = layers.r.buyables[11].effect(new Decimal(3));
	player.t.activeChallenge=13; var b = layers.r.buyables[11].effect(new Decimal(3));
	player.t.activeChallenge=null; return b.times(2).eq(a);
})()`));
ok("r 自动化在 t15 中停摆", V(`(function(){
	player.r.milestones=["0","2","3"]; player.r.autoBuy=true; player.r.autoFill=true; player.r.autoRun=true;
	player.r.points=new Decimal(100); player.m.points=new Decimal('1e12'); player.r.buyables["11"]=new Decimal(0);
	player.t.activeChallenge=15;
	var au = layers.r.autoUpgrade(), ap = layers.r.autoPrestige();
	layers.r.automate(); var amtOff = getBuyableAmount("r","11").toNumber();
	player.t.activeChallenge=null;
	var au2 = layers.r.autoUpgrade(), ap2 = layers.r.autoPrestige();
	layers.r.automate(); var amtOn = getBuyableAmount("r","11").toNumber();
	return au === false && ap === false && amtOff === 0 && au2 === true && ap2 === true && amtOn > 0;
})()`));
ok("t15 未落地（player.t 缺失）时 autoOn 不误伤", V(`(function(){
	var saveT = player.t; player.t = undefined;
	var r = layers.r.autoPrestige();
	player.t = saveT;
	return r === true;
})()`));

console.log("\n  · r doReset 保留规则（§4）");
ok("r.doReset('r')：自身反应不清空本层（static：货币与升级都在反应后保留）", V(`(function(){
	player.r.points=new Decimal(9); player.r.total=new Decimal(77); player.r.best=new Decimal(9);
	player.r.resets=new Decimal(2); player.r.upgrades=[11]; player.r.buyables["11"]=new Decimal(3);
	layers.r.doReset("r");
	return player.r.points.toNumber() === 9 && player.r.upgrades.length === 1 &&
		player.r.total.toNumber() === 77 && player.r.best.toNumber() === 9 && player.r.resets.toNumber() === 2;
})()`));
ok("r.doReset('t')（更高层）清空 points/upgrades，保留 total/best/resets", V(`(function(){
	player.r.points=new Decimal(9); player.r.total=new Decimal(77); player.r.best=new Decimal(9);
	player.r.resets=new Decimal(2); player.r.upgrades=[11]; player.t.upgrades=[];
	layers.r.doReset("t");
	return player.r.points.toNumber() === 0 && player.r.upgrades.length === 0 &&
		player.r.total.toNumber() === 77 && player.r.best.toNumber() === 9 && player.r.resets.toNumber() === 2;
})()`));
ok("x0 → r.doReset('x') 保留 buyables+spent、清空 upgrades", V(`(function(){
	player.x.milestones=["0"]; player.r.upgrades=[11]; player.r.buyables["11"]=new Decimal(3); player.r.spentOnBuyables=new Decimal(40);
	layers.r.doReset("x");
	var a = getBuyableAmount("r","11").toNumber() === 3 && player.r.spentOnBuyables.toNumber() === 40 && player.r.upgrades.length === 0;
	player.x.milestones=[]; return a;
})()`));
ok("无 x0 → r.doReset('x') 清空 buyables", V(`(function(){
	player.x.milestones=[]; player.r.buyables["11"]=new Decimal(3);
	layers.r.doReset("x");
	return getBuyableAmount("r","11").toNumber() === 0;
})()`));
ok("r.onPrestige 递增 player.r.resets", V(`(function(){ var a = player.r.resets.toNumber(); layers.r.onPrestige(); return player.r.resets.toNumber() === a + 1 })()`));

// ===========================================================================
// 恶意钩子防护
// ===========================================================================
console.log("\n--- 恶意钩子防护 ---");
ok("恶意 ingotExpBonus=NaN → m.gainExp 仍有界正数", V(`(function(){
	registerHook('ingotExpBonus', function(){ return new Decimal(NaN) });
	var v = layers.m.gainExp(); return v.gt(0) && v.isFinite() && v.lte(2);
})()`));
ok("恶意 ingotGain=0 → m.gainMult 回落正数", V(`(function(){
	registerHook('ingotGain', function(){ return new Decimal(0) });
	var v = layers.m.gainMult(); return v.gt(0) && v.isFinite();
})()`));
ok("恶意 ingotGain=Infinity → m.gainMult 有界", V(`(function(){
	registerHook('ingotGain', function(){ return new Decimal(Infinity) });
	var v = layers.m.gainMult(); return v.gt(0) && v.isFinite();
})()`));
ok("恶意 catalystCost=0 → r.gainMult 不低于下限（避免除零）", V(`(function(){
	registerHook('catalystCost', function(){ return new Decimal(0) });
	var v = layers.r.gainMult(); return v.gte(new Decimal('0.05')) && v.isFinite();
})()`));
ok("恶意 catalystDirect=0 → r.directMult 仍正（getNextAt 不炸）", V(`(function(){
	registerHook('catalystDirect', function(){ return new Decimal(0) });
	var v = layers.r.directMult(); return v.gt(0) && v.isFinite();
})()`));
ok("恶意 catalystExpBonus=NaN → r.gainExp 仍正", V(`(function(){
	registerHook('catalystExpBonus', function(){ return new Decimal(NaN) });
	var v = layers.r.gainExp(); return v.gt(0) && v.isFinite();
})()`));
ok("恶意 heat=NaN → 本层自身的 heat 贡献仍有界", V(`(function(){
	registerHook('heat', function(){ return new Decimal(NaN) });
	var a = layers.m.effect().heat, b = layers.r.effect().heat;
	return a.isFinite() && b.isFinite() && a.gt(0) && b.gt(0);
})()`));
console.log("\n--- 恶意钩子下的完整公式 ---");
for (const b of MBASES) {
	V(`player.h.points = new Decimal("${b}")`);
	chkNum("engGain('m')", `恶意钩子 m.resetGain（base=${b}）`);
	chkNum("engNextAt('m', false)", `恶意钩子 m.nextAt（base=${b}）`);
}
for (const [p, base] of RCASES) {
	V(`player.r.points = new Decimal("${p}"); player.m.points = new Decimal("${base}")`);
	chkNum("engGain('r')", `恶意钩子 r.resetGain（points=${p}, ingot=${base}）`);
	chkNum("engNextAt('r', true)", `恶意钩子 r.nextAt（points=${p}, ingot=${base}）`);
}

// ===========================================================================
// 文本与结构体检
// ===========================================================================
console.log("\n--- 文本体检（format 就绪后）---");
V(`player.h.points = new Decimal('1e6'); player.m.points = new Decimal(123); player.m.total = new Decimal(5000);
player.m.best = new Decimal(50); player.m.milestones = ["0","1","2","3"]; player.m.upgrades = [];
player.r.points = new Decimal(25); player.r.total = new Decimal(60); player.r.best = new Decimal(25);
player.r.milestones = ["0","1","2","3"]; player.r.upgrades = []; player.r.buyables["11"] = new Decimal(5);
player.h.vents = new Decimal(12);`);
for (const id of ["m", "r"]) {
	const res = V(`(function(){
		var L = layers.${id}; var bad = [];
		function scan(name, t) {
			if (typeof t !== "string") { bad.push(name + ":类型=" + typeof t); return }
			if (/NaN|Infinity|undefined/.test(t)) bad.push(name + " → " + t.slice(0, 80));
			if (!/[\\u4e00-\\u9fff]/.test(t)) bad.push(name + " 无中文");
		}
		try { scan("tooltip", L.tooltip()) } catch(e) { bad.push("tooltip throw " + e.message) }
		try { scan("tooltipLocked", L.tooltipLocked()) } catch(e) { bad.push("tooltipLocked throw " + e.message) }
		try { scan("effectDescription", L.effectDescription.bind(L)()) } catch(e) { bad.push("effectDescription throw " + e.message) }
		scan("resource", L.resource); scan("baseResource", L.baseResource); scan("resetDescription", L.resetDescription);
		scan("name", L.name);
		for (var id in L.upgrades) {
			if (isNaN(id)) continue;
			var u = L.upgrades[id];
			try { scan("upg" + id + ".desc", typeof u.description === "function" ? u.description.bind(u)() : u.description) } catch(e) { bad.push("upg" + id + " desc throw " + e.message) }
			if (typeof u.title === "string") scan("upg" + id + ".title", u.title);
			try { if (u.effectDisplay) scan("upg" + id + ".effDisp", u.effectDisplay.bind(u)()) } catch(e) { bad.push("upg" + id + " effDisp throw " + e.message) }
			try { if (u.effect) { var ev = u.effect.bind(u)(); if (!ev || typeof ev.isNan !== "function") bad.push("upg" + id + ".effect 非 Decimal"); else if (ev.isNan() || !ev.isFinite()) bad.push("upg" + id + ".effect 坏值") } } catch(e) { bad.push("upg" + id + " effect throw " + e.message) }
			try { var c = u.cost(); if (!c || c.isNan() || !c.isFinite() || c.lte(0)) bad.push("upg" + id + ".cost 坏") } catch(e) { bad.push("upg" + id + " cost throw " + e.message) }
			try { u.unlocked.bind(u)() } catch(e) { bad.push("upg" + id + " unlocked throw " + e.message) }
		}
		for (var id in L.milestones) {
			if (isNaN(id)) continue;
			var ms = L.milestones[id];
			try { scan("ms" + id + ".req", typeof ms.requirementDescription === "function" ? ms.requirementDescription.bind(ms)() : ms.requirementDescription) } catch(e) { bad.push("ms" + id + " req throw " + e.message) }
			try { scan("ms" + id + ".eff", typeof ms.effectDescription === "function" ? ms.effectDescription.bind(ms)() : ms.effectDescription) } catch(e) { bad.push("ms" + id + " eff throw " + e.message) }
			try { var d = ms.done(); if (typeof d !== "boolean") bad.push("ms" + id + " done 非 bool") } catch(e) { bad.push("ms" + id + " done throw " + e.message) }
		}
		for (var id in L.buyables) {
			if (isNaN(id)) continue;
			var b = L.buyables[id];
			try { scan("buy" + id + ".display", b.display.bind(b)()) } catch(e) { bad.push("buy" + id + " display throw " + e.message) }
			try { scan("buy" + id + ".title", typeof b.title === "function" ? b.title.bind(b)() : b.title) } catch(e) { bad.push("buy" + id + " title throw " + e.message) }
			try { if (b.tooltip) scan("buy" + id + ".tooltip", typeof b.tooltip === "function" ? b.tooltip.bind(b)() : b.tooltip) } catch(e) { bad.push("buy" + id + " tooltip throw " + e.message) }
			try { var cc = b.cost(getBuyableAmount("${id}", id)); if (!cc || cc.isNan() || !cc.isFinite() || cc.lte(0)) bad.push("buy" + id + " cost 坏") } catch(e) { bad.push("buy" + id + " cost throw " + e.message) }
			try { var ca = b.canAfford.bind(b)(); if (typeof ca !== "boolean") bad.push("buy" + id + " canAfford 非 bool") } catch(e) { bad.push("buy" + id + " canAfford throw " + e.message) }
			if (!b.purchaseLimit || typeof b.purchaseLimit.isNan !== "function") bad.push("buy" + id + " purchaseLimit 非 Decimal");
		}
		for (var id in L.bars) {
			var bar = L.bars[id];
			if (!bar || typeof bar.progress !== "function") continue;
			try { var p = bar.progress(); if (!isFinite(p) || p < 0 || p > 1) bad.push("bar" + id + " progress=" + p) } catch(e) { bad.push("bar" + id + " progress throw " + e.message) }
			try { scan("bar" + id + ".display", bar.display()) } catch(e) { bad.push("bar" + id + " display throw " + e.message) }
		}
		for (var id in L.infoboxes) {
			var ib = L.infoboxes[id];
			if (!ib || ib.constructor !== Object) continue;
			try { scan("info." + id, typeof ib.body === "function" ? ib.body.bind(ib)() : ib.body) } catch(e) { bad.push("info." + id + " throw " + e.message) }
			if (typeof ib.title !== "string" || !/[\\u4e00-\\u9fff]/.test(ib.title)) bad.push("info." + id + ".title 非中文");
		}
		L.hotkeys.forEach(function(h, i) {
			if (!/[\\u4e00-\\u9fff]/.test(h.description)) bad.push("hotkey" + i + " 无中文");
			try { if (h.unlocked && typeof h.unlocked !== "function" && h.unlocked !== true) bad.push("hotkey" + i + " unlocked 类型怪") } catch(e) { bad.push("hotkey" + i + " unlocked throw " + e.message) }
			if (typeof h.onPress !== "function") bad.push("hotkey" + i + " 无 onPress");
		});
		return bad.length ? bad.join(" || ") : "CLEAN";
	})()`)
	ok(`${id} 文本与组件体检`, res === "CLEAN", res);
	// 极端数值下的文本
	const res2 = V(`(function(){
		var L = layers.${id}; var bad = [];
		function scan(name, t) { if (typeof t !== "string") { bad.push(name); return } if (/NaN|Infinity|undefined/.test(t)) bad.push(name + " → " + t.slice(0,60)) }
		player.h.points = new Decimal(0); player.m.points = new Decimal(0); player.m.total = new Decimal(0); player.m.best = new Decimal(0);
		player.r.points = new Decimal(0); player.m.points = new Decimal(0); player.h.vents = new Decimal(0);
		player.m.buyables["11"] = new Decimal(0); player.m.buyables["12"] = new Decimal(0);
		player.r.buyables["11"] = new Decimal(0); player.r.buyables["12"] = new Decimal(0); player.r.buyables["13"] = new Decimal(0);
		try { scan("tooltip", L.tooltip()) } catch(e) { bad.push("tooltip throw " + e.message) }
		try { scan("tooltipLocked", L.tooltipLocked()) } catch(e) { bad.push("tooltipLocked throw " + e.message) }
		try { scan("effectDescription", L.effectDescription.bind(L)()) } catch(e) { bad.push("effectDescription throw " + e.message) }
		for (var i2 in L.buyables) { if (isNaN(i2)) continue; try { scan("buy" + i2, L.buyables[i2].display.bind(L.buyables[i2])()) } catch(e) { bad.push("buy" + i2 + " throw " + e.message) } }
		for (var i2 in L.bars) { var bar2 = L.bars[i2]; if (!bar2 || typeof bar2.display !== "function") continue; try { scan("bar" + i2, bar2.display()); var p = bar2.progress(); if (!isFinite(p) || p < 0 || p > 1) bad.push("bar" + i2 + " progress=" + p) } catch(e) { bad.push("bar" + i2 + " throw " + e.message) } }
		for (var i2 in L.infoboxes) { var ib2 = L.infoboxes[i2]; if (!ib2 || ib2.constructor !== Object) continue; try { scan("info" + i2, typeof ib2.body === "function" ? ib2.body.bind(ib2)() : ib2.body) } catch(e) { bad.push("info" + i2 + " throw " + e.message) } }
		for (var k in L.tabFormat) {
			var content = L.tabFormat[k].content;
			for (var ci = 0; ci < content.length; ci++) {
				var it = content[ci];
				if (!Array.isArray(it)) continue;
				var walkfn = function(f, tag) { try { if (typeof f === "function") { var s = String(f()); if (/NaN|Infinity|undefined/.test(s)) bad.push(k + tag + " → " + s.slice(0,60)) } } catch(e) { bad.push(k + tag + " throw " + e.message) } };
				walkfn(it[1], "#" + ci);
				if (Array.isArray(it[1])) it[1].forEach(function(sub, si) { if (Array.isArray(sub)) walkfn(sub[1], "#" + ci + "/" + si) });
			}
		}
		return bad.length ? bad.join(" || ") : "CLEAN";
	})()`)
	ok(`${id} 零值/极端状态下的文本体检`, res2 === "CLEAN", res2);
}

console.log("\n--- tabFormat 结构 ---");
for (const id of ["m", "r"]) {
	const keys = V(`Object.keys(layers.${id}.tabFormat).join("|")`)
	ok(`${id} tabFormat ≥2 子标签（${keys}）`, V(`Object.keys(layers.${id}.tabFormat).length >= 2`));
	const order = V(`(function(){
		var k = Object.keys(layers.${id}.tabFormat)[0];
		var arr = layers.${id}.tabFormat[k].content.map(function(x){ return Array.isArray(x) ? x[0] : x });
		function idx(n) { return arr.indexOf(n) }
		var need = ["main-display","prestige-button","resource-display","milestones","upgrades","buyables"];
		var got = need.map(idx);
		var mono = true;
		for (var i = 1; i < got.length; i++) if (got[i] < 0 || got[i] <= got[i-1]) mono = false;
		return mono ? "OK" : ("BAD:" + arr.join(","));
	})()`)
	ok(`${id} 主界面组件顺序（main→prestige→resource→ms→upg→buyables）`, order === "OK", order)
	ok(`${id} 详情标签含 infobox/bar/挑战占位文本`, V(`(function(){
		var ks = Object.keys(layers.${id}.tabFormat);
		var d = null;
		for (var i = 0; i < ks.length; i++) if (ks[i].indexOf("详情") >= 0) d = ks[i];
		if (!d) return false;
		var arr = layers.${id}.tabFormat[d].content;
		var names = arr.map(function(x){ return Array.isArray(x) ? x[0] : x });
		var raw = "";
		arr.forEach(function(x){ if (Array.isArray(x) && typeof x[1] === "function") raw += String(x[1]()) })
		return names.indexOf("infobox") >= 0 && names.indexOf("bar") >= 0 && /挑战/.test(raw);
	})()`))
	ok(`${id} startData 数值全 Decimal、开关全 boolean`, V(`(function(){
		var d = layers.${id}.startData();
		var numKeys = ["points","best","total","resets","spentOnBuyables"];
		for (var i = 0; i < numKeys.length; i++) if (!(d[numKeys[i]] instanceof Decimal)) return "BAD:" + numKeys[i];
		var bools = 0;
		for (var k in d) if (typeof d[k] === "boolean") bools++;
		return bools >= 3 && d.buyables && typeof d.buyables === "object" ? true : "NOBOOL";
	})()`))
	ok(`${id} 有 effect()/effectDescription()/doReset()/onPrestige()`, V(`typeof layers.${id}.effect === "function" && typeof layers.${id}.effectDescription === "function" && typeof layers.${id}.doReset === "function" && typeof layers.${id}.onPrestige === "function"`))
	ok(`${id}.doReset 走 forgeDoReset`, V(`String(layers.${id}.doReset).indexOf("forgeDoReset") >= 0`))
	ok(`${id} 有 buyables.respec`, V(`typeof layers.${id}.buyables.respec === "function"`))
	ok(`${id} 每个 buyable 有 cost/effect/display/canAfford/buy/buyMax/sellOne/sellAll/purchaseLimit`, V(`(function(){
		for (var id in layers.${id}.buyables) {
			if (isNaN(id)) continue;
			var b = layers.${id}.buyables[id];
			var need = ["cost","effect","display","canAfford","buy","buyMax","sellOne","sellAll"];
			for (var i = 0; i < need.length; i++) if (typeof b[need[i]] !== "function") return "BAD:" + id + "." + need[i];
			if (!(b.purchaseLimit instanceof Decimal)) return "BAD:" + id + ".purchaseLimit";
		}
		return true;
	})()`))
}
// 互斥描述
ok("m 互斥升级描述写明「互斥」", V(`(function(){
	var a = layers.m.upgrades[31].description, b = layers.m.upgrades[32].description;
	return /互斥/.test(typeof a === "function" ? a.bind(layers.m.upgrades[31])() : a) &&
		/互斥/.test(typeof b === "function" ? b.bind(layers.m.upgrades[32])() : b);
})()`))
ok("r 互斥升级描述写明「互斥」", V(`(function(){
	var a = layers.r.upgrades[23].description, b = layers.r.upgrades[24].description;
	return /互斥/.test(typeof a === "function" ? a.bind(layers.r.upgrades[23])() : a) &&
		/互斥/.test(typeof b === "function" ? b.bind(layers.r.upgrades[24])() : b);
})()`))
ok("跨层升级描述写明影响的层名", V(`(function(){
	var bad = [];
	for (var id in layers.m.upgrades) {
		if (isNaN(id)) continue;
		var u = layers.m.upgrades[id];
		var d = typeof u.description === "function" ? u.description.bind(u)() : u.description;
		if (/炉芯|热量|泄压|炉压|熔炉|passive/.test(d) && !/影响/.test(d) && !/保留/.test(d)) bad.push("m" + id);
	}
	for (var id in layers.r.upgrades) {
		if (isNaN(id)) continue;
		var u = layers.r.upgrades[id];
		var d = typeof u.description === "function" ? u.description.bind(u)() : u.description;
		if (/锭条|触媒成本|触媒产出/.test(d) && !/影响|本层/.test(d)) bad.push("r" + id);
	}
	return bad.length ? bad.join(",") : true;
})()`))

// ===========================================================================
// 源码层面检查
// ===========================================================================
console.log("\n--- 源码层面 ---");
for (const f of ["js/Forge/m.js", "js/Forge/r.js"]) {
	const src = read(f)
	const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "") // 去注释后再扫描
	ok(f + " 顶部集中数值表", (f.endsWith("m.js") ? /var M_BAL = \{/.test(src) : /var R_BAL = \{/.test(src)))
	ok(f + " 无 resetBuyables()（引擎不存在该函数）", !/(?<![A-Za-z])resetBuyables\s*\(/.test(code))
	ok(f + " 无裸 inChallenge（应走 autoOn/buyableDebuff）", !/\binChallenge\s*\(/.test(code))
	ok(f + " 无加载期 format 调用（对象字面量顶层）", (() => {
		// 找出形如 `xxx: "..." + format(` 或 `xxx: format(` 的顶层求值（函数体内部是安全的）
		const lines = code.split("\n")
		const bad = []
		let depth = 0, inFn = 0
		for (let i = 0; i < lines.length; i++) {
			const L = lines[i]
			if (/^\s*[A-Za-z_$][\w$]*\s*:\s*[^(\n]*\bformat(Whole|Small)?\s*\(/.test(L) && !/=>|function|\(\s*\)\s*\{/.test(L)) bad.push((i + 1) + ":" + L.trim().slice(0, 60))
			if (/^\s*[A-Za-z_$][\w$]*\s*:\s*[^(\n]*\bformat(Whole|Small)?\s*\(/.test(L) && /\breturn\b/.test(L) === false && /\{\s*$/.test(L) === false) { /* 已由上一条覆盖 */ }
		}
		return bad.length === 0 ? true : (console.log("     可疑加载期 format：" + bad.join(" | ")), false)
	})())
	// 越界写：只允许 m 写 player.h.reserveCore、r 写 player.r.* 与 player.m.points
	const offenders = []
	const re = /player\.([a-z])\.(points|upgrades|milestones|buyables|best|total|resets|vents|pressure|ventCd|reserveCore|spentOnBuyables|[a-zA-Z]+)\s*=[^=>]/g
	let mm
	while ((mm = re.exec(code))) {
		const lr = mm[1], field = mm[2]
		if (f.endsWith("m.js")) {
			if (lr === "m") continue
			if (lr === "h" && (field === "reserveCore" || field === "reserve")) continue
			offenders.push(mm[0].trim())
		} else {
			if (lr === "r") continue
			if (lr === "m" && field === "points") continue
			offenders.push(mm[0].trim())
		}
	}
	ok(f + " 无越界写别的层数据", offenders.length === 0, offenders.join(" , "))
	ok(f + " 钩子名全部来自 §3.2", (() => {
		const allow = new Set(["heat", "heatFlat", "coreGain", "coreExpBonus", "ingotGain", "ingotExpBonus", "catalystCost", "catalystDirect", "catalystExpBonus", "chrononGain", "stellarGain", "startPoints", "ventValue", "pressureRate", "pressureExp", "buyableCost", "upgradeCost", "hPassiveAdd", "millPassiveAdd"])
		const bad = []
		const re2 = /registerHook\(\s*["']([A-Za-z]+)["']/g
		let m2
		while ((m2 = re2.exec(src))) if (!allow.has(m2[1])) bad.push(m2[1])
		return bad.length === 0 ? true : (console.log("     非法钩子：" + bad.join(",")), false)
	})())
}
// —— 真实引擎里的 requires() 函数形式验证（tmp 解析 / nextAt / canReset / 按钮文本 / 扫参可行性）——
console.log("\n--- 真实引擎：requires 函数形式 ---");
{
	const H = require("./harness.js")
	const api = H.boot({ seed: 5 })
	process.removeAllListeners("uncaughtException")
	process.removeAllListeners("unhandledRejection")
	const cx = api.ctx
	api.newGame()
	const R = (e) => { try { return vm.runInContext(e, cx) } catch (x) { return "THROW:" + x.message } }
	const S = (e) => { try { return String(vm.runInContext("String(" + e + ")", cx)) } catch (x) { return "<err>" } }
	// 解锁两层并给足资源，刷 tmp
	R(`player.m.unlocked = true; player.r.unlocked = true;
	   player.points = new Decimal("1e6"); player.h.points = new Decimal("1e4");
	   player.m.points = new Decimal("1e3"); player.m.total = new Decimal("1e3");
	   player.m.buyables["11"] = new Decimal(3); player.m.buyables["12"] = new Decimal(2);
	   player.r.buyables["11"] = new Decimal(2); updateTemp();`)
	ok("m 是函数 requires", R("typeof layers.m.requires === 'function'"))
	ok("r 是函数 requires", R("typeof layers.r.requires === 'function'"))
	ok("tmp.m.requires 被解析成 Decimal=50", R("String(tmp.m.requires)") === "50", S("tmp.m.requires"))
	ok("tmp.r.requires 被解析成 Decimal=10", R("String(tmp.r.requires)") === "10", S("tmp.r.requires"))
	ok("tmp.m.requires 不是加载期默认 decimalOne", R("tmp.m.requires.eq(50) && !tmp.m.requires.eq(1)"))
	// 公式与 UI 全部现读 tmp
	chk("m resetGain 有限", R("(function(){var g=getResetGain('m'); return !g.isNan() && g.isFinite() })()"))
	chk("m nextAt 有限且 ≥ requires", R("(function(){var n=getNextAt('m'); return !n.isNan() && n.isFinite() && n.gte(tmp.m.requires) })()"))
	chk("m canReset 正常", R("typeof canReset('m') === 'boolean'"))
	chk("r resetGain 有限", R("(function(){var g=getResetGain('r'); return !g.isNan() && g.isFinite() })()"))
	chk("r nextAt 有限且 ≥ requires", R("(function(){var n=getNextAt('r',true); return !n.isNan() && n.isFinite() && n.gte(tmp.r.requires) })()"))
	chk("r canReset 正常", R("typeof canReset('r') === 'boolean'"))
	// 按钮文本（引擎用 tmp.<l>.requires 渲染门槛）
	const bt = S("prestigeButtonText('m')")
	ok("m 按钮文本无 NaN/undefined 且含门槛", !/NaN|undefined/.test(bt) && bt.length > 0, bt.slice(0, 80))
	const rt = S("prestigeButtonText('r')")
	ok("r 按钮文本无 NaN/undefined", !/NaN|undefined/.test(rt) && rt.length > 0, rt.slice(0, 80))
	// 引擎的解锁判定也走 tmp
	ok("m 的 layerShown/解锁门槛可读", R("(function(){ return !isNaN(Number(tmp.m.requires.toNumber())) })()"))
	// 扫参可行性：运行时改 M_BAL.requires 后，刷 tmp 立即生效（这正是 lead 要的）
	R("M_BAL.requires = 80; updateTemp();")
	ok("改 M_BAL.requires → tmp.m.requires 立即变 80（可扫参）", R("tmp.m.requires.eq(80)"), S("tmp.m.requires"))
	R("R_BAL.requires = 16; updateTemp();")
	ok("改 R_BAL.requires → tmp.r.requires 立即变 16（可扫参）", R("tmp.r.requires.eq(16)"), S("tmp.r.requires"))
	chk("改门槛后 m nextAt 仍有限", R("(function(){var n=getNextAt('m'); return !n.isNan() && n.isFinite() })()"))
	chk("改门槛后 r nextAt 仍有限", R("(function(){var n=getNextAt('r',true); return !n.isNan() && n.isFinite() })()"))
	R("M_BAL.requires = 50; R_BAL.requires = 10; updateTemp();")
	// 侧层读取兼容：ach.js 用 readData(layers[l].requires)，函数形式必须也能读
	ok("readData(layers.m.requires) 读到 50", R("(function(){ updateTemp(); return String(readData(layers.m.requires)) })()") === "50")
	ok("引擎错误列表为空", api.errors().filter(e => e.type !== "console.warn").length === 0, JSON.stringify(api.errors().slice(0, 2)))
	ok("NaN 扫描干净", api.nanScan().length === 0)
}

// —— 互斥语义钉死：引擎实时校验后，后买者必须**被拒且不扣钱** ——
console.log("\n--- 互斥语义（先到者胜、后买被拒、不扣钱）---");
{
	const H = require("./harness.js")
	const api = H.boot({ seed: 9 })
	process.removeAllListeners("uncaughtException")
	process.removeAllListeners("unhandledRejection")
	const cx = api.ctx
	api.newGame()
	const R = (e) => { try { return vm.runInContext(e, cx) } catch (x) { return "THROW:" + x.message } }
	const S = (e) => { try { return String(vm.runInContext("String(" + e + ")", cx)) } catch (x) { return "<err>" } }
	R(`player.m.unlocked = true; player.r.unlocked = true;
	   player.m.points = new Decimal("1e9"); player.r.points = new Decimal("1e9"); updateTemp();`)
	// 同 tick 连买（中间不 updateTemp → tmp.unlocked 是陈旧的 true）
	const m1 = R("(function(){ buyUpg('m',31); return String(player.m.points) })()")
	const m2 = R("(function(){ buyUpg('m',32); return String(player.m.points) })()")
	ok("m 买 31 成功（扣 300）", R("hasUpgrade('m',31)") === true && Number(m1) === 1e9 - 300, m1 + " / " + m2)
	ok("m 后买 32 被拒且余额不变", R("hasUpgrade('m',32)") === false && m2 === m1, m1 + " / " + m2)
	ok("m 未同时持有 31/32", !(R("hasUpgrade('m',31)") === true && R("hasUpgrade('m',32)") === true))
	const r1 = R("(function(){ buyUpg('r',24); return String(player.r.points) })()")
	const r2 = R("(function(){ buyUpg('r',23); return String(player.r.points) })()")
	ok("r 买 24 成功", R("hasUpgrade('r',24)") === true, r1 + " / " + r2)
	ok("r 后买 23 被拒且余额不变", R("hasUpgrade('r',23)") === false && r2 === r1, r1 + " / " + r2)
	ok("r 未同时持有 23/24", !(R("hasUpgrade('r',23)") === true && R("hasUpgrade('r',24)") === true))
	// 本层不得再有退款型守卫（lead 决定：删掉，避免退错钱成刷钱口）
	// 注意先剥掉注释：说明性注释里会出现 "onPurchase" 这个词，那不是属性。
	const strip = (s) => s.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "")
	const mc = strip(read("js/Forge/m.js")), rc = strip(read("js/Forge/r.js"))
	ok("m.js 已无 MutexTake / onPurchase 退款守卫", !/MutexTake/.test(mc) && !/onPurchase\s*[:(]/.test(mc))
	ok("r.js 已无 MutexTake / onPurchase 退款守卫", !/MutexTake/.test(rc) && !/onPurchase\s*[:(]/.test(rc))
	ok("m/r 全文不再写 player.<l>.points 于升级购买路径（无退款口）",
		!/player\.m\.points\s*=\s*mNum\(player\.m\.points\)\.add\(mUpgCost/.test(mc) &&
		!/player\.r\.points\s*=\s*rNum\(player\.r\.points\)\.add\(rUpgCost/.test(rc))
	ok("互斥仍由 unlocked() 表达（双方各有对方取反）",
		/unlocked\(\) \{ return .*!mUpg\("m", 32\)/.test(mc) && /unlocked\(\) \{ return .*!mUpg\("m", 31\)/.test(mc) &&
		/unlocked\(\) \{ return .*!rUpg\("r", 24\)/.test(rc) && /unlocked\(\) \{ return .*!rUpg\("r", 23\)/.test(rc))
	// 刷新 tmp 后，被拒的那一项必须变成不可见（unlocked 现算）
	R("updateTemp();")
	ok("刷 tmp 后 32 的 tmp.unlocked 变 false", R("tmp.m.upgrades[32].unlocked") === false, S("tmp.m.upgrades[32].unlocked"))
	ok("刷 tmp 后 23 的 tmp.unlocked 变 false", R("tmp.r.upgrades[23].unlocked") === false, S("tmp.r.upgrades[23].unlocked"))
	ok("无引擎错误", api.errors().filter(e => e.type !== "console.warn").length === 0, JSON.stringify(api.errors().slice(0, 2)))
}

function chk(label, cond) { ok(label, cond === true, String(cond)) }

// §4 唯一例外：m 层只写 player.h.reserveCore（且是 Decimal 比例）
ok("m 层写 player.h.reserveCore 是 §4 允许的唯一例外", /player\.h\.reserveCore\s*=/.test(read("js/Forge/m.js")))
ok("m 层不再写旧的 player.h.reserve", !/player\.h\.reserve\s*=/.test(read("js/Forge/m.js")))
ok("m 层写的 h 字段只有 reserveCore", (() => {
	const s = read("js/Forge/m.js").replace(/\/\/[^\n]*/g, "")
	const re = /player\.h\.([A-Za-z_][\w]*)\s*=[^=>]/g
	let m2, bad = []
	while ((m2 = re.exec(s))) if (m2[1] !== "reserveCore") bad.push(m2[1])
	return bad.length === 0 ? true : (console.log("     越界写 h 字段：" + bad.join(",")), false)
})())


// §8.5 预算自检（源码级）：per^limit ≤ 1e6
console.log("\n--- §8.5 预算自检 ---");
for (const [f, balName] of [["js/Forge/m.js", "M_BAL"], ["js/Forge/r.js", "R_BAL"]]) {
	const src = read(f)
	const body = /var [MR]_BAL = \{([\s\S]*?)\n\}/.exec(src)
	if (!body) { ok(f + " 找到 " + balName + " 表", false, "正则未匹配"); continue }
	// 在 context 里求值这张表，逐条算 per^limit
	const tbl = vm.runInContext("(function(){ var Decimal = globalThis.Decimal; return " + body[0].replace("var " + balName + " =", "") + " })()", ctx)
	const bad = []
	for (const id of Object.keys(tbl.buyables)) {
		const b = tbl.buyables[id]
		const budget = Math.pow(b.per, b.limit)
		const pass = budget <= 1e6
		console.log(`     ${balName}.buyables[${id}] ${b.name}：${b.per}^${b.limit} = ${budget.toExponential(2)} ${pass ? "✓ ≤1e6" : "✗ 超预算"}`)
		if (!pass) bad.push(id)
	}
	ok(f + " 所有 buyable 通道 per^limit ≤ 1e6", bad.length === 0, bad.join(","))
	ok(f + " 先天效果有软上限（effCap/effSoft + Budget）", /effCap/.test(src) && /effSoft/.test(src) && /(?:m|r)Budget\(/.test(src))
	// 升级倍率通道
	const upgChannels = []
	if (tbl.coreMult) upgChannels.push(["coreMult", Object.values(tbl.coreMult).reduce((a, b2) => a * b2, 1)])
	if (tbl.heatMult) upgChannels.push(["heatMult", Object.values(tbl.heatMult).reduce((a, b2) => a * b2, 1)])
	if (tbl.ingotMult) upgChannels.push(["ingotMult", Object.values(tbl.ingotMult).reduce((a, b2) => a * b2, 1)])
	for (const [nm, v] of upgChannels) {
		console.log(`     ${balName}.${nm} 通道合计 = ${v.toExponential(2)} ${v <= 1e6 ? "✓" : "✗"}`)
	}
	ok(f + " 升级倍率通道 ≤ 1e6", upgChannels.every(([, v]) => v <= 1e6))
}
// 运行期：按 §8.5 规则 3，**逐通道**核验本层贡献（不用 foldMult —— 上面的「恶意钩子防护」
// 会往 HOOKS 里永久注册返回 NaN 的钩子，那是测试污染，不是本层代码的问题）。
console.log("\n--- §8.5 规则 3：本层逐通道乘积 ---")
const CH = {
	heat: "mEffHeat().times(mUpgHeatMult()).times(mUpgGuildMult()).times(mBuyEffect('12', mLimit('12'))).times(rEffHeat()).times(rBuyEffect('11', rLimit('11')))",
	coreGain: "mEffCore().times(mUpgCoreMult()).times(rBuyEffect('12', rLimit('12')))",
	ingotGain: "mBuyEffect('11', mLimit('11')).times(rEffIngot()).times(rUpgIngotMult())",
	pressureRate: "mUpgPressureMult().times(rBuyEffect('13', rLimit('13')))",
	ventValue: "mUpgVentMult()",
}
function expoOf(s) { const m = /e(\d+)$/i.exec(s); if (m) return Number(m[1]); const f = parseFloat(s); return f >= 1 ? Math.floor(Math.log10(f)) : 0 }
function runChannels(tag, limitExp) {
	let over = []
	for (const name in CH) {
		const v = chkNum(CH[name], `${tag} ${name}`)
		if (v !== null) {
			const e = expoOf(v)
			console.log(`     ${tag} ${name} = ${v} (10^${e})`)
			if (e > limitExp) over.push(name + "=10^" + e)
		}
	}
	ok(`${tag} 各通道 ≤ 1e${limitExp}`, over.length === 0, over.join(","))
}
// 全升级 + 全部购入件满级
V(`player.m.upgrades = [11,12,13,14,21,22,23,24,32]; player.r.upgrades = [11,12,13,14,21,22,23];
player.m.buyables["11"] = mLimit("11"); player.m.buyables["12"] = mLimit("12");
player.r.buyables["11"] = rLimit("11"); player.r.buyables["12"] = rLimit("12"); player.r.buyables["13"] = rLimit("13");
player.h.vents = new Decimal("1e5");`)
runChannels("现实终局（锭条1e20/触媒500/全升满购）", 40)
V("player.m.points = new Decimal('1e20'); player.r.points = new Decimal(500);")
runChannels("现实终局（锭条1e20/触媒500/全升满购）", 40)
// 荒谬数值：只要求有界（软上限持续压缩，不产生 Infinity）
V(`player.m.points = new Decimal('1e100'); player.r.points = new Decimal(200);`)
for (const name in CH) chkNum(CH[name], `荒谬值 ${name} 有界`)
V(`player.m.points = new Decimal('1e3000000'); player.r.points = new Decimal('1e6'); player.h.vents = new Decimal('1e100');`)
for (const name in CH) chkNum(CH[name], `极端 1e3e6 ${name} 有界`)
V(`player.m.upgrades = []; player.r.upgrades = []; player.m.buyables["11"] = new Decimal(0); player.m.buyables["12"] = new Decimal(0);
player.r.buyables["11"] = new Decimal(0); player.r.buyables["12"] = new Decimal(0); player.r.buyables["13"] = new Decimal(0);
player.m.points = new Decimal(0); player.r.points = new Decimal(0); player.h.vents = new Decimal(0);`)

// 运行期：轧辊/废料箱满级时的通道值
console.log("\n--- 满级购入件的通道值 ---")
V("player.m.buyables['11'] = mLimit('11'); player.m.buyables['12'] = mLimit('12');")
chkNum("mBuyEffect('11', mLimit('11'))", "轧辊满级 → ingotGain")
chkNum("mBuyEffect('12', mLimit('12'))", "废料箱满级 → heat")
V("player.r.buyables['11'] = rLimit('11'); player.r.buyables['12'] = rLimit('12'); player.r.buyables['13'] = rLimit('13');")
chkNum("rBuyEffect('11', rLimit('11'))", "催化塔满级 → heat")
chkNum("rBuyEffect('12', rLimit('12'))", "冷凝器满级 → coreGain")
chkNum("rBuyEffect('13', rLimit('13'))", "催化床满级 → pressureRate")
V(`player.m.buyables['11'] = new Decimal(0); player.m.buyables['12'] = new Decimal(0);
player.r.buyables['11'] = new Decimal(0); player.r.buyables['12'] = new Decimal(0); player.r.buyables['13'] = new Decimal(0);`)

console.log("\n" + (fails === 0 ? "=== 全部通过 ===" : "=== 失败 " + fails + " 项 ==="))
process.exitCode = fails === 0 ? 0 : 1

} // end else（--pacing 模式不走自检）
