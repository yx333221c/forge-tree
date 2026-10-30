// tools/test-endgame.js —— 通关可达性验收（永久保留）
//
// 这是 sim.js 不管的那一段：sim 只做「攒资源 + 买 + 重置」，不会进挑战、不会点点燃，
// 所以「§8 通关 2–5 小时」这条唯一的实证来源就是这个脚本。
//
// 它模拟一个「什么都自动化、炉压满了才泄压、有一点收益就重置」的激进玩家，并额外：
//   1) 依次进入 t 层 6 个挑战，在挑战内攒够目标后结算（挑战内**只重置 h/m**，
//      需要攒触媒的 13/14/16 连 r 都不重置，否则等于自己把目标拆掉）；
//   2) 条件满足时用正规的 clickClickable("x",11) 点燃恒星；
//   3) 记录 16 条铭刻各自的达成时刻，确认没有「正常玩法永远拿不到」的成就；
//   4) 全程监测 Infinity / NaN / 钩子异常。
//
// 用法：
//   node tools/test-endgame.js [分钟=45] [步长秒=1]
// 退出码：0 = 通关且无失控；1 = 未通关或有异常。
"use strict"

const H = require("./harness.js")

const MIN = Number(process.argv[2] || 45)
const STEP = Number(process.argv[3] || 1)

const api = H.boot({ seed: 1 })
// harness 注册了 uncaughtException 处理器，会吞掉本脚本的崩溃并静默 exit 0 —— 必须摘掉。
process.removeAllListeners("uncaughtException")
process.removeAllListeners("unhandledRejection")

api.newGame()

api.eval(`
	var __ms = Date.now();
	function __tick(d){ __ms += d*1000; player.time = __ms; updateTemp(); gameLoop(d); }

	// 常规一轮：买满买得起的、满压泄压、有收益就重置
	function __buy(){
		for (const L of ["h","m","r","t","x"]) {
			if (!layers[L] || !player[L]) continue;
			for (var id in layers[L].upgrades) if (!isNaN(id) && canAffordUpgrade(L,id) && !hasUpgrade(L,id)) buyUpg(L,id);
			for (var id in layers[L].buyables) if (!isNaN(id) && canBuyBuyable(L,id)) buyBuyable(L,id);
		}
		if (canVent() && player.h.pressure.gte(H_BAL.pressureCap*0.999)) forgeVent();
		if (canReset("h") && tmp.h.resetGain.gte(1)) doReset("h");
		if (canReset("m") && tmp.m.resetGain.gte(1)) doReset("m");
		if (canReset("r") && tmp.r.resetGain.gte(1)) doReset("r");
		// t/x 的 player[L].unlocked 只有「首次 doReset(L)」里引擎才置 true，
		// 所以 bot 必须真的去按；但正在挑战里时按它会退出挑战。
		if (player.t.activeChallenge === null || player.t.activeChallenge === undefined) {
			if (canReset("t") && tmp.t.resetGain.gte(1)) doReset("t");
			if (canReset("x") && tmp.x.resetGain.gte(1)) doReset("x");
		}
	}

	// 挑战：空闲时挑一个「可进入且未完成」的进；在里面达标了就再点一次结算。
	// 引擎 startChallenge(layer, x) 的语义：同一个 x 再调一次 = 完成并退出。
	function __chal(sim, log){
		var act = player.t.activeChallenge;
		if (act !== null && act !== undefined) {
			if (canCompleteChallenge("t", act)) { startChallenge("t", act); log.push("完成t" + act + "@" + Math.round(sim) + "s") }
			for (const L of ["h","m"]) {
				if (!layers[L] || !player[L]) continue;
				for (var id in layers[L].upgrades) if (!isNaN(id) && canAffordUpgrade(L,id) && !hasUpgrade(L,id)) buyUpg(L,id);
				for (var id in layers[L].buyables) if (!isNaN(id) && canBuyBuyable(L,id)) buyBuyable(L,id);
			}
			if (canVent() && player.h.pressure.gte(H_BAL.pressureCap*0.999)) forgeVent();
			if (canReset("h") && tmp.h.resetGain.gte(1)) doReset("h");
			if (canReset("m") && tmp.m.resetGain.gte(1)) doReset("m");
			// 13/14/16 的目标是「攒够触媒」，按 r 会把它清零 —— 这三个挑战里绝不按 r。
			if (act !== 13 && act !== 14 && act !== 16 &&
				act !== "13" && act !== "14" && act !== "16" &&
				canReset("r") && tmp.r.resetGain.gte(1)) doReset("r");
			return;
		}
		for (var cid in layers.t.challenges) {
			if (isNaN(cid) || player.t.challenges[cid]) continue;
			if (!(tmp.t.challenges[cid] && tmp.t.challenges[cid].unlocked)) continue;
			if (!canEnterChallenge("t", cid)) continue;
			startChallenge("t", cid); log.push("进入t" + cid + "@" + Math.round(sim) + "s"); return;
		}
	}
`)

const out = JSON.parse(api.eval(`(function(){
	var MIN=${MIN}, dt=${STEP}, sim=0, log=[], first={}, achAt={}, chalAt={};
	var infAt = null, nanAt = null;
	for(;;){
		__tick(dt); __buy(); if (player.t.unlocked) __chal(sim, log); sim += dt;
		if (player.h.points.gte(1) && first.core===undefined) first.core=sim;
		for (const L of ["m","r","t","x"]) if (player[L].unlocked && first[L]===undefined) first[L]=sim;
		if (player.x.points.gte(FORGE_END.igniteCost) && first.core1000===undefined) first.core1000=sim;
		for (var cid in layers.t.challenges) if (!isNaN(cid) && player.t.challenges[cid] && !chalAt[cid]) chalAt[cid]=sim;
		var nc = 0; for (var c in chalAt) nc++;
		if (nc >= FORGE_END.igniteChallenges && first.chalReq===undefined) first.chalReq=sim;
		if (!player.x.ignited && tmp.x.clickables && tmp.x.clickables[11] &&
			tmp.x.clickables[11].unlocked && tmp.x.clickables[11].canClick) {
			clickClickable("x", 11);
			if (player.x.ignited) { first.ignited=sim; log.push("点燃@"+Math.round(sim)+"s") }
		}
		if (player.ach.achievements) for (var a of player.ach.achievements) if (!achAt[a]) achAt[a]=sim;
		try { if (!tmp.pointGen.isFinite() && infAt===null) infAt=sim } catch(e){}
		if (player.hasNaN && nanAt===null) nanAt=sim;
		if (sim >= MIN*60) break;
	}
	var ids = Object.keys(layers.ach.achievements).filter(function(x){return !isNaN(x)});
	var missing = ids.filter(function(id){ return !player.ach.achievements.some(function(z){ return String(z)===String(id) }) })
		.map(function(id){ return id + " " + String(layers.ach.achievements[id].name) });
	var chalIds = Object.keys(layers.t.challenges).filter(function(x){return !isNaN(x)});
	return JSON.stringify({
		first: first, achAt: achAt, chalAt: chalAt, missing: missing,
		chalTotal: chalIds.length, chalDone: chalIds.filter(function(c){ return player.t.challenges[c] }).length,
		achTotal: ids.length, achGot: player.ach.achievements.length,
		ignited: player.x.ignited, isEnd: isEndgame(),
		inscHeatMult: String(typeof achHeatChannel === "function" ? achHeatChannel() : "n/a"),
		xTotal: String(player.x.total), gen: String(tmp.pointGen),
		infAt: infAt, nanAt: nanAt, sim: sim, log: log
	});
})()`, { timeout: MIN * 60 * 1000 * 12 }))

const fmt = (s) => s === undefined ? "未达成" : s < 60 ? Math.round(s) + "s" : s < 3600 ? (s / 60).toFixed(1) + "min" : (s / 3600).toFixed(2) + "h"
console.log(`=== 通关可达性验收 · ${MIN}min · seed=1 · 激进自动化 bot + 挑战 + 点燃 ===`)
console.log(`层解锁      首芯 ${fmt(out.first.core)} | m ${fmt(out.first.m)} | r ${fmt(out.first.r)} | t ${fmt(out.first.t)} | x ${fmt(out.first.x)}`)
console.log(`挑战        ${out.chalDone}/${out.chalTotal} 完成，最后一个于 ${fmt(out.first.chalReq)}（结局要求 ≥${api.get("FORGE_END.igniteChallenges")}）`)
const ch = Object.keys(out.chalAt).sort().map(k => "t" + k + " " + fmt(out.chalAt[k])).join("  ")
console.log(`            ${ch}`)
console.log(`星核        满 ${api.get("FORGE_END.igniteCost")} 于 ${fmt(out.first.core1000)}；累计 ${out.xTotal}`)
console.log(`点燃恒星    ${out.ignited ? "✓ " + fmt(out.first.ignited) : "✗ 未达成"}   isEndgame()=${out.isEnd}`)
console.log(`铭刻        ${out.achGot}/${out.achTotal} ${out.missing.length ? "✗ 未达成: " + out.missing.join(" | ") : "✓ 全部可达成"}`)
console.log(`            heat 通道铭刻乘子 = ${out.inscHeatMult}`)
console.log(`失控监测    Infinity: ${out.infAt === null ? "✓ 从未" : "✗ @" + fmt(out.infAt)}   NaN: ${out.nanAt === null ? "✓ 从未" : "✗ @" + fmt(out.nanAt)}`)
console.log(`末刻产热    ${out.gen}`)
if (out.log.length) console.log(`事件\n  ${out.log.join("\n  ")}`)

const nan = api.nanScan()
const errs = api.errors().filter(e => e.severity !== "console")
console.log(`\nNaN 扫描 ${nan.length ? "✗ " + nan.slice(0, 6).map(n => n.path).join(", ") : "✓ 干净"}   运行期错误 ${errs.length ? "✗ " + errs.slice(0, 4).map(e => String(e.message).slice(0, 60)).join(" / ") : "✓ 0"}`)

const pass = out.ignited && !out.missing.length && out.chalDone >= out.chalTotal && out.infAt === null && out.nanAt === null && !nan.length && !errs.length
console.log(`\n判定：${pass ? "✓ 通关可达且无失控" : "✗ 不通过"}`)
process.exitCode = pass ? 0 : 1
