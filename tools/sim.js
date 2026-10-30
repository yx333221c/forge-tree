// tools/sim.js —— 自动玩（greedy bot）+ 事件时间线 / 曲线 / 可达性 / NaN / §8 平衡报告
// 依赖：tools/harness.js（只用 Node 内置模块 fs/path/vm）
//
// ── 架构 ──────────────────────────────────────────────────────────────
// bot 的**决策代码整段注入 vm context**（BOT_SRC），宿主只负责推进时钟与出报告。
// 原因有两个，都是踩过的坑：
//   1. 跨 realm 判定陷阱：mod 文件在 context 里求值，其对象的 constructor 是 context 的
//      内建 Object。宿主里写 `o.constructor === Object` 永远是 false → bot 会"什么都不买"。
//      引擎的 isPlainObject / hasMilestone / canAffordUpgrade 必须在 context 内调用才可靠。
//   2. 性能：逐条 H.get(ctx, "canAffordUpgrade('h','11')") 每 tick 要几十次 vm 往返，
//      30 分钟模拟（200ms 决策步）会慢到不可用。注入后每个决策步只需 1 次往返。
//
// ── 决策优先级（每 botMs 毫秒模拟时间执行一次）────────────────────────
//   1. 自动化开关：把 milestone 给的 toggles 全部打开（自动化是主线加速器）
//   2. 挑战：t 解锁后按 id 升序，进入第一个"未打满且可进入"的挑战；
//      已进入则 advance 到 canCompleteChallenge 为真 → 再次 startChallenge 完成；
//      超过 --challenge-timeout 分钟则强制退出（避免卡死）
//   3. clickables：unlocked && canClick 就点（泄压/过载/点燃恒星都走这里）
//   4. 熔炉泄压兜底：h.js 的 forgeVent 不是 clickable 时也要按（canVent 就泄）
//   5. 升级：按成本升序，买得起就买（高层优先 → 见 orderedLayers）
//   6. 购入件：有 buyMax 用 buyMaxBuyable，否则"买 1 直到买不起"
//   7. 重置：**先高层后低层**，canReset 且 resetGain >= 1 才 doReset
//      （挑战进行中时，不允许做"比挑战层更高"的重置，否则会把挑战踢掉）
//
// ── CLI ───────────────────────────────────────────────────────────────
//   node tools/sim.js --fast                 200ms 步长，默认 30 分钟
//   node tools/sim.js --minutes=240 --seed=1
//   node tools/sim.js --only=h,m             只在 h/m 活动（更高层完全不碰）
//   node tools/sim.js --save=out.json        结束导出 player JSON
//   node tools/sim.js --load=out.json        从 JSON 复现开局
//   node tools/sim.js --report=json          输出 JSON 报告
"use strict";

const fs = require("fs");
const path = require("path");
const H = require("./harness.js");

// ---------------------------------------------------------------------------
// CLI 解析
// ---------------------------------------------------------------------------
function parseArgs(argv) {
	const args = {
		fast: false,
		minutes: 30,
		seed: 1,
		only: null,
		save: null,
		load: null,
		report: "text",
		stepMs: 50,
		botMs: 200,
		challengeTimeoutMin: 20,
		deadlockMinutes: 10,
		verbose: false,
		curveEvery: 60,
		noChallenges: false,
		maxEvents: 400,
		maxFatalTypes: 12,
		constants: false,
		vent: "cap",           // 泄压策略：cap | half | asap | never
		budgetExp: 80,         // §8.5（修订版）软阈值的 log10；硬约束始终是"不得出现 Infinity/NaN"
		largeTick: false,      // 大 tick 稳健性测试（一次性跳 4 小时离线）
		largeTickHours: 4,
		out: null,             // 把 JSON 报告写到此文件（Node 自己写，避免 PowerShell 重定向写成 UTF-16）
	};
	let sawMinutes = false;
	for (const a of argv) {
		if (a === "--fast") { args.fast = true; args.stepMs = 200; }
		else if (a.startsWith("--minutes=")) { args.minutes = Number(a.slice(10)) || 30; sawMinutes = true; }
		else if (a.startsWith("--seed=")) args.seed = Number(a.slice(7)) || 1;
		else if (a.startsWith("--only=")) args.only = a.slice(7).split(/[,;]/).map((s) => s.trim()).filter(Boolean);
		else if (a.startsWith("--save=")) args.save = a.slice(7);
		else if (a.startsWith("--load=")) args.load = a.slice(7);
		else if (a.startsWith("--report=")) args.report = a.slice(9);
		else if (a.startsWith("--step=")) args.stepMs = Number(a.slice(7)) || 50;
		else if (a.startsWith("--bot-every=")) args.botMs = Number(a.slice(12)) || 200;
		else if (a.startsWith("--challenge-timeout=")) args.challengeTimeoutMin = Number(a.slice(20)) || 20;
		else if (a.startsWith("--deadlock=")) args.deadlockMinutes = Number(a.slice(11)) || 10;
		else if (a.startsWith("--curve-every=")) args.curveEvery = Number(a.slice(14)) || 60;
		else if (a.startsWith("--max-events=")) args.maxEvents = Number(a.slice(13)) || 400;
		else if (a.startsWith("--max-fatal=")) args.maxFatalTypes = Number(a.slice(12)) || 12;
		else if (a.startsWith("--vent=")) args.vent = a.slice(7);
		else if (a.startsWith("--budget=")) { const n = Number(a.slice(9)); args.budgetExp = isFinite(n) && n > 0 ? n : 80; }
		else if (a === "--constants") args.constants = true;
		else if (a === "--large-tick") args.largeTick = true;
		else if (a.startsWith("--large-tick=")) { args.largeTick = true; args.largeTickHours = Number(a.slice(13)) || 4; }
		else if (a.startsWith("--out=")) args.out = a.slice(6);
		else if (a === "--no-challenges") args.noChallenges = true;
		else if (a === "--verbose" || a === "-v") args.verbose = true;
		else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
	}
	if (!["cap", "half", "asap", "never"].includes(args.vent)) {
		console.error("--vent 只接受 cap|half|asap|never，收到: " + args.vent);
		process.exit(2);
	}
	if (args.fast && !sawMinutes) args.minutes = 30;
	return args;
}

function printHelp() {
	console.log([
		"用法: node tools/sim.js [选项]",
		"",
		"  --fast                  200ms 步长（快速档），默认模拟 30 分钟",
		"  --minutes=N             模拟时长（分钟），默认 30",
		"  --seed=N                随机种子（Math.random 可复现），默认 1",
		"  --only=h,m              只在这些层里活动（更高层完全不碰）",
		"  --save=<file>           结束时把 player 导出为 JSON（可用 --load 复现）",
		"  --load=<file>           从 JSON 恢复开局",
		"  --report=text|json      报告格式，默认 text",
		"  --step=N                tick 步长（毫秒），默认 50；--fast 为 200",
		"  --bot-every=N           每隔多少毫秒做一次 bot 决策，默认 200",
		"  --challenge-timeout=N   单个挑战最多耗费多少模拟分钟，默认 20",
		"  --deadlock=N            连续多少分钟无任何资源增长判为死锁，默认 10",
		"  --curve-every=N         每多少模拟秒打印一行曲线，默认 60",
		"  --max-events=N          时间线最多打印多少条，默认 400",
		"  --max-fatal=N           不同类致命异常超过这个数量就早停，默认 12",
		"  --vent=cap|half|asap|never  泄压策略（默认 cap=等满压再放，即真人路径）",
		"                          cap 首芯~50s/锻冶~5min；half 首芯~5min；asap/never 整局 0 炉芯",
		"  --budget=N              §8.5 数值预算（修订版）：foldMult(heat) 超过 1eN 记 WARN，默认 80；",
		"                          硬约束始终是「全程不得出现 Infinity/NaN」，与 N 无关",
		"  --large-tick[=H]        大 tick 稳健性：一次性把 player.time 往前跳 H 小时（默认 4，",
		"                          即离线收益上限），检查是否出现 NaN 或被刷爆的冷却",
		"  --no-challenges         完全不碰挑战",
		"  --constants             打印各层顶部 *_BAL 平衡常量表（调参前先看这个）",
		"  -v, --verbose           打印游戏侧 console 输出与逐段进度",
		"",
		"退出码: 0 = 无 FAIL；1 = 判定 FAIL；2 = 参数/读档错误",
	].join("\n"));
}

const MAIN_LAYERS = ["h", "m", "r", "t", "x"];

function fmtClock(sec) {
	sec = Math.max(0, Math.floor(sec));
	const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
	return (h ? h + "h " : "") + (h || m ? m + "m " : "") + s + "s";
}

// ---------------------------------------------------------------------------
// 注入 vm 的 bot 源码（整段在 context 里求值）
// 约定：只用引擎已有的全局（layers/tmp/player/format/formatWhole/isPlainObject/…），
//       不假设 harness 的存在；对外只暴露 globalThis.__BOT
// ---------------------------------------------------------------------------
const BOT_SRC = String.raw`
(function () {
	var MAIN = ["h", "m", "r", "t", "x"];

	var cfg = {
		allowed: MAIN.slice(),   // 允许活动的层
		available: MAIN.slice(), // 已落地（addLayer 成功）的主线层
		challenges: true,
		challengeTimeout: 1200,  // 秒
		resetBaseGrowth: 4,      // 底层资源涨到上次 reset 时的多少倍才值得再 reset
		resetMaxIdle: 120,       // 兜底：距上次 reset 超过这么多秒就 reset（避免永远不 reset）
		ventPolicy: "cap",       // 泄压时机：cap=等满压再放（真人路径）/ half / asap / never
		ventFrac: 0.999,         // cap 模式下认为"满压"的比例
		budgetExp: 80,           // §8.5（修订版）软阈值：foldMult(name) 的 log10 超过它就记 WARN（不判 FAIL）
		curveSampleSec: 5,       // 曲线采样间隔（模拟秒）
		guardEverySec: 10,       // §8.5 守卫扫描间隔（模拟秒）：发散是单调的，抽稀不会漏，且省掉每步重算钩子
		log: []                  // 事件（对象数组：{t, kind, text, detail}）
	};

	var state = {
		seenUnlock: {},
		seenFirst: {},
		seenMs: {},
		seenUpg: {},
		seenCh: {},
		seenToggle: {},
		seenBudget: {},          // "budget:hook" -> 首次超软阈值时间（每个通道只报一次）
		seenInf: {},             // "inf:where" -> 首次发现非有限值（硬约束，每个位置只报一次）
		lastGuard: -1e9,         // 上次 §8.5 守卫扫描的模拟时刻
		curve: [],               // log10(热量/秒) 时间序列（判定失控 vs 正常成长）
		reset: {},               // layer -> {lastBase, lastTime, count, ever}
		ignited: false,
		challengeEnterAt: null,
		challengeLayer: null,
		challengeId: null,
		stepCalls: 0,
		errors: {}               // "where|message" -> count（去重）
	};

	function err(where, e) {
		var msg = (e && e.message) ? e.message : String(e);
		var key = where + "|" + msg;
		state.errors[key] = (state.errors[key] || 0) + 1;
	}
	function emit(kind, text, detail) {
		cfg.log.push({ t: player.timePlayed, kind: kind, text: text, detail: detail === undefined ? "" : String(detail) });
	}

	// 是否允许在这一层行动
	function usable(l) {
		if (cfg.allowed.indexOf(l) < 0) return false;
		return !!(layers[l] && player[l]);
	}
	function live(l) {
		return usable(l) && !!player[l].unlocked;
	}

	// 组件 id 列表（只用引擎的 isPlainObject，避免跨 realm 判定）
	function compIds(l, field) {
		try {
			var L = layers[l];
			if (!L || !L[field]) return [];
			var a = [];
			for (var k in L[field]) { if (isPlainObject(L[field][k])) a.push(k); }
			return a;
		} catch (e) { err("compIds:" + l + "." + field, e); return []; }
	}

	// 行号（越大越靠上）；拿不到就按 MAIN 下标
	function rowOf(l) {
		try {
			var r = layers[l] && layers[l].row;
			if (typeof r === "number") return r;
		} catch (e) { /* ignore */ }
		var i = MAIN.indexOf(l);
		return i < 0 ? 99 : i;
	}
	function ordered(asc) {
		var list = cfg.available.slice();
		list.sort(function (a, b) { return asc ? rowOf(a) - rowOf(b) : rowOf(b) - rowOf(a); });
		return list;
	}

	// ---------- 文本（一律用引擎的 format，避免宿主/ context Decimal 差异） ----------
	function fx(v) {
		try { return format(v); } catch (e) { try { return String(v); } catch (x) { return "?"; } }
	}
	function plain(v) {
		if (v === undefined || v === null) return "";
		var s;
		try { s = (typeof v === "function") ? String(v()) : String(v); } catch (e) { return ""; }
		return s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
	}
	function tmpField(l, field, id, name) {
		try {
			var t = tmp[l] && tmp[l][field] && tmp[l][field][id];
			if (!t) return "";
			return plain(t[name]);
		} catch (e) { return ""; }
	}

	// ---------- 1) 打开自动化开关 ----------
	// 注意：高层重置会把 player[l].autoXxx 清回 false，所以这里要"每步都补开"；
	// 但事件只在**第一次**打开时记录一次（state.seenToggle），否则时间线会被刷屏。
	function openToggles() {
		for (var i = 0; i < cfg.available.length; i++) {
			var l = cfg.available[i];
			if (!usable(l)) continue;
			var ids = compIds(l, "milestones");
			for (var j = 0; j < ids.length; j++) {
				var id = ids[j];
				try {
					var ms = layers[l].milestones[id];
					if (!ms || !ms.toggles) continue;
					if (!hasMilestone(l, id)) continue;
					for (var k = 0; k < ms.toggles.length; k++) {
						var tg = ms.toggles[k];
						var lr = String(tg[0]), key = String(tg[1]);
						if (!player[lr]) continue;
						if (typeof player[lr][key] !== "boolean") continue;
						if (player[lr][key] === true) continue;
						Vue.set(player[lr], key, true);
						var tk = lr + "." + key;
						if (!state.seenToggle[tk]) {
							state.seenToggle[tk] = player.timePlayed;
							emit("自动化", "首次开启 " + tk, tmpField(l, "milestones", id, "effectDescription"));
						}
					}
				} catch (e) { err("openToggles:" + l + "#" + id, e); }
			}
		}
	}

	// ---------- 2) 挑战 ----------
	function activeChLayer() {
		for (var i = 0; i < cfg.available.length; i++) {
			var l = cfg.available[i];
			if (!usable(l)) continue;
			var a = player[l].activeChallenge;
			if (a) return { layer: l, id: String(a) };
		}
		return null;
	}
	function stepChallenges() {
		if (!cfg.challenges) return;
		var act = activeChLayer();
		if (act) {
			var done = false;
			try { done = !!canCompleteChallenge(act.layer, act.id); } catch (e) { err("canCompleteChallenge", e); }
			if (done) {
				try {
					startChallenge(act.layer, act.id);   // 再次调用 = 完成
					emit("挑战完成判定", act.layer + " #" + act.id + " " + tmpField(act.layer, "challenges", act.id, "name"));
				} catch (e) { err("startChallenge(exit)", e); }
				state.challengeEnterAt = null; state.challengeLayer = null; state.challengeId = null;
				return;
			}
			var spent = player.timePlayed - (state.challengeEnterAt || player.timePlayed);
			if (spent > cfg.challengeTimeout) {
				emit("挑战超时", act.layer + " #" + act.id + " 超过 " + Math.round(cfg.challengeTimeout / 60) + " 分钟未完成，退出",
					tmpField(act.layer, "challenges", act.id, "goal") + " / " + (tmpField(act.layer, "challenges", act.id, "challengeDescription") || ""));
				try {
					// 直接退出挑战（不完成）：清空 activeChallenge 并触发 onExit
					completeChallenge(act.layer, act.id);
					Vue.set(player[act.layer], "activeChallenge", null);
				} catch (e) { err("forceExitChallenge", e); }
				state.challengeEnterAt = null; state.challengeLayer = null; state.challengeId = null;
			}
			return;
		}
		for (var i = 0; i < cfg.available.length; i++) {
			var l = cfg.available[i];
			if (!live(l)) continue;
			var ids = compIds(l, "challenges");
			ids.sort(function (a, b) { return (Number(a) || 0) - (Number(b) || 0); });
			for (var j = 0; j < ids.length; j++) {
				var id = ids[j];
				try {
					if (maxedChallenge(l, id)) continue;
					var ch = tmp[l].challenges[id];
					if (!ch || !ch.unlocked) continue;
					if (!canEnterChallenge(l, id)) continue;
				} catch (e) { err("challengeCheck:" + l + "#" + id, e); continue; }
				try {
					startChallenge(l, id);
				} catch (e) { err("startChallenge(enter)", e); continue; }
				if (String(player[l].activeChallenge) === String(id)) {
					state.challengeEnterAt = player.timePlayed;
					state.challengeLayer = l; state.challengeId = id;
					emit("进入挑战", l + " #" + id + " " + (tmp[l].challenges[id].name || ""), tmp[l].challenges[id].goal ? fx(tmp[l].challenges[id].goal) : "");
					return;
				}
			}
		}
	}
	function inChallengeLayerAbove(l) {
		// 挑战进行中时，比挑战层更高的重置会把挑战踢掉 → 禁止
		if (!state.challengeLayer) return false;
		if (!player[state.challengeLayer].activeChallenge) return false;
		return rowOf(l) > rowOf(state.challengeLayer);
	}

	// ---------- 3) clickables ----------
	function stepClickables() {
		for (var i = 0; i < cfg.available.length; i++) {
			var l = cfg.available[i];
			if (!live(l)) continue;
			var ids = compIds(l, "clickables");
			for (var j = 0; j < ids.length; j++) {
				var id = ids[j];
				var ok = false;
				try {
					var c = tmp[l].clickables[id];
					ok = !!(c && c.unlocked && c.canClick);
				} catch (e) { ok = false; }
				if (!ok) continue;
				try {
					clickClickable(l, id);
					state.stepCalls++;
				} catch (e) { err("clickClickable:" + l + "#" + id, e); }
			}
		}
	}

	// ---------- 4) 泄压：真人路径 = 等满压再放 ----------
	// h.js 把泄压做成全局函数（forgeVent/canVent）而不是 clickable，所以这里要专门处理。
	// 实测（seed=11，12 分钟）泄压时机决定一切：
	//   cap（等满压）→ 首芯 50s、解锁锻冶 5.0min；
	//   half（半压）→ 首芯 5.1min、锻冶点不亮；
	//   asap（冷却一到就放）/ never（从不放）→ 整局 0 炉芯。
	// 因为泄压额度带 (P/CAP)^ventPow(=4) 的超线性奖励，早放等于白放，
	// 而 bot 若不会"憋满再放"，§8 的每一档都会被误判成偏慢。
	// 注意门槛用 canVent()（里面已含 ventCd 与 pressure>0），再叠加策略判断。
	function ventReady() {
		try { return !!(typeof canVent === "function" && canVent()); } catch (e) { return false; }
	}
	function pressureFrac() {
		try {
			var cap = (typeof H_BAL !== "undefined" && H_BAL && H_BAL.pressureCap) ? D(H_BAL.pressureCap) : decimalOne;
			return player.h.pressure.div(cap).toNumber();
		} catch (e) { return 0; }
	}
	function stepVent() {
		if (!live("h")) return;
		if (cfg.ventPolicy === "never") return;
		if (!ventReady()) return;
		var go = false;
		if (cfg.ventPolicy === "asap") go = true;
		else if (cfg.ventPolicy === "half") go = pressureFrac() >= 0.5;
		else go = pressureFrac() >= cfg.ventFrac;   // cap
		if (!go) return;
		try { forgeVent(); } catch (e) { err("forgeVent", e); }
	}

	// ---------- 5) 升级：成本升序，买得起就买 ----------
	function upgCostNum(l, id) {
		try {
			var c = tmp[l].upgrades[id].cost;
			if (c === undefined || c === null) return 1e300;
			var n = (typeof c.toNumber === "function") ? c.toNumber() : Number(c);
			return isFinite(n) ? n : 1e300;
		} catch (e) { return 1e300; }
	}
	function stepUpgrades() {
		var order = ordered(false); // 高层优先
		for (var i = 0; i < order.length; i++) {
			var l = order[i];
			if (!live(l)) continue;
			var ids = compIds(l, "upgrades");
			ids.sort(function (a, b) { return upgCostNum(l, a) - upgCostNum(l, b); });
			for (var j = 0; j < ids.length; j++) {
				var id = ids[j];
				if (hasUpgrade(l, id)) continue;
				// 关键：不要用 tmp[l].upgrades[id].unlocked 判断！
				// 那是上一次 updateTemp 缓存的值，同一 tick 内买了 31 之后 32 的 unlocked 仍是 true，
				// 于是互斥的两项都会被买走（引擎自带的 autobuyUpgrades 也有这个坑，sim 会作为
				// "不变量被破坏"报出来）。这里直接调 layers 上的原始 unlocked()。
				var u = null;
				try { u = layers[l].upgrades[id]; } catch (e) { continue; }
				if (!u) continue;
				if (typeof u.unlocked === "function") {
					var un = true;
					try { un = !!u.unlocked.call(u); } catch (e) { un = false; }
					if (!un) continue;
				} else if (u.unlocked === false) continue;
				var afford = false;
				try { afford = !!canAffordUpgrade(l, id); } catch (e) { afford = false; }
				if (!afford) continue;
				try { buyUpg(l, id); } catch (e) { err("buyUpg:" + l + "#" + id, e); }
			}
		}
	}

	// ---------- 6) 购入件 ----------
	function stepBuyables() {
		var order = ordered(false);
		for (var i = 0; i < order.length; i++) {
			var l = order[i];
			if (!live(l)) continue;
			var ids = compIds(l, "buyables");
			for (var j = 0; j < ids.length; j++) {
				var id = ids[j];
				var hasMax = false;
				try { hasMax = typeof layers[l].buyables[id].buyMax === "function"; } catch (e) { hasMax = false; }
				if (hasMax) {
					try { buyMaxBuyable(l, id); } catch (e) { err("buyMaxBuyable:" + l + "#" + id, e); }
					continue;
				}
				var guard = 0;
				while (guard++ < 500) {
					var ok = false;
					try { ok = !!canBuyBuyable(l, id); } catch (e) { ok = false; }
					if (!ok) break;
					var before = String(getBuyableAmount(l, id));
					try { buyBuyable(l, id); } catch (e) { err("buyBuyable:" + l + "#" + id, e); break; }
					if (String(getBuyableAmount(l, id)) === before) break;
				}
			}
		}
	}

	// ---------- 6.5) 是否还有"买得起但没买"的东西（升级/购入件）----------
	// greedy bot 的核心纪律：**先花钱，再重置**。
	// 高层重置会清空低层（§4），如果在 h 还差 20 秒就能买 #12 的时候 reset m，
	// h 的炉芯与升级被抹掉，整体反而变慢 —— 实测正是 30 分钟那一跑原地踏步的原因。
	// 返回 true = 存在 row <= maxRow 的层里还有可买的东西，此时不该 reset。
	function pendingPurchases(maxRow) {
		var order = ordered(true);
		for (var i = 0; i < order.length; i++) {
			var l = order[i];
			if (rowOf(l) > maxRow) continue;
			if (!usable(l) || !player[l].unlocked) continue;
			var uids = compIds(l, "upgrades");
			for (var j = 0; j < uids.length; j++) {
				var id = uids[j];
				if (hasUpgrade(l, id)) continue;
				// 必须现读 layers 上的原始 unlocked()，不能用 tmp 缓存值：
				// tmp[l].upgrades[id].unlocked 是上一次 updateTemp 的结果，互斥项（比如买了 31 之后的 32）
				// 在被买走前可能一直是 true，于是"明明买不到却当成可买"→ 永远 pending → 永远不重置（假死锁）。
				var u = null;
				try { u = layers[l].upgrades[id]; } catch (e) { continue }
				if (!u) continue;
				if (typeof u.unlocked === "function") {
					var un = true;
					try { un = !!u.unlocked.call(u); } catch (e) { un = false; }
					if (!un) continue;
				} else if (u.unlocked === false) continue;
				try {
					if (canAffordUpgrade(l, id)) return true;
				} catch (e) { /* ignore */ }
			}
			var bids = compIds(l, "buyables");
			for (var k = 0; k < bids.length; k++) {
				try { if (canBuyBuyable(l, bids[k])) return true; } catch (e) { /* ignore */ }
			}
		}
		return false;
	}

	// ---------- 7) 重置：先高层后低层 ----------
	// 注意一：不能用 live()（player[l].unlocked）来门槛！TMT 里"第一次 doReset 成功"才是解锁的时机
	//        （game.js 的 doReset 里 if (!player[layer].unlocked) player[layer].unlocked = true）。
	//        若只试已解锁的层，m/r/t/x 永远点不亮，表现为"高层不可达"的假死锁。
	// 注意二：不能"gain>=1 就 reset"。实测那样会让 m 每秒 reset 5 次，
	//        而每次 m reset 都会清空 h（row 更低）→ h 的炉芯与升级永远攒不起来，
	//        整个游戏在自我拆台中原地踏步（真实表现：h.points 冻结、r 卡在 18）。
	//        所以这里用传统 PTB 启发式：**只在"这一轮确实攒出了东西"时才 reset**：
	//          a) 本层还没解锁（首次 reset 为了点亮节点），或
	//          b) resetGain >= 已持有量（翻倍以上才值得，符合"重置越来越快"的正反馈），或
	//          c) 底层资源（baseAmount）自上次 reset 起涨到 gainFromLastBase 倍以上（防止永远不 reset）
	//        超时兜底 d) 距上次 reset 超过 maxIdleSeconds 且 gain >= 1（保证不会死等）
	function stepResets() {
		var order = ordered(false);
		for (var i = 0; i < order.length; i++) {
			var l = order[i];
			if (!usable(l)) continue;
			if (inChallengeLayerAbove(l)) continue;
			var ok = false, gain = 0, held = 0, base = 0, requires = 0;
			try {
				ok = !!canReset(l) && !!tmp[l].canReset;
				var g = tmp[l].resetGain;
				gain = (g && typeof g.toNumber === "function") ? g.toNumber() : Number(g || 0);
				held = player[l].points && typeof player[l].points.toNumber === "function" ? player[l].points.toNumber() : 0;
				var ba = tmp[l].baseAmount;
				base = (ba && typeof ba.toNumber === "function") ? ba.toNumber() : Number(ba || 0);
				var rq = tmp[l].requires;
				requires = (rq && typeof rq.toNumber === "function") ? rq.toNumber() : Number(rq || 1);
			} catch (e) { ok = false; }
			if (!ok) continue;
			if (!(gain >= 1)) continue;

			var st = state.reset[l] || (state.reset[l] = { lastBase: 0, lastTime: 0, count: 0, ever: false });
			var firstEver = !st.ever;
			var meaningful = gain >= Math.max(1, held);                    // 翻倍以上
			var baseGrew = st.lastBase > 0 && base >= st.lastBase * cfg.resetBaseGrowth;
			var idle = player.timePlayed - st.lastTime >= cfg.resetMaxIdle;
			// static 层（r）：gain 恒为 1，只能靠 baseGrew/idle 推进
			var isStatic = false;
			try { isStatic = (tmp[l].type === "static"); } catch (e) { isStatic = false; }

			// 先花钱再重置：本层 row 及以下还有买得起的东西时，按下不表
			// （首次点亮例外 —— 否则高层永远点不亮）
			if (!firstEver && pendingPurchases(rowOf(l))) continue;

			var fire = firstEver || (isStatic ? (baseGrew || idle) : (meaningful || baseGrew || idle));
			if (!fire) continue;

			try {
				doReset(l);
				st.lastBase = base;
				st.lastTime = player.timePlayed;
				st.count++;
				st.ever = true;
			} catch (e) { err("doReset:" + l, e); }
		}
	}

	// ---------- 事件扫描（diff player 状态） ----------
	function scanEvents() {
		for (var i = 0; i < cfg.available.length; i++) {
			var l = cfg.available[i];
			if (!usable(l)) continue;
			var d = player[l];
			if (!d) continue;
			if (d.unlocked && !state.seenUnlock[l]) {
				state.seenUnlock[l] = player.timePlayed;
				emit("层解锁", l + "（" + plain(tmp[l].name || layers[l].name) + "）已点燃", "requires=" + fx(tmp[l].requires));
			}
			// 首次获得货币：用 total（累计获得）而不是 points（当前持有）。
			// points 会被 buyable/升级花掉甚至归零，用它的話"首次获得"会重复发（实测 --load 续跑时
			// m 的锭条正好被花光 → 又发一次"首次获得货币 m"）。total 单调递增，才是"曾经拿到过"。
			if (d.total && d.total.gt(0) && !state.seenFirst[l]) {
				state.seenFirst[l] = player.timePlayed;
				emit("首次获得货币", l + "." + plain(tmp[l].resource) + " = " + fx(d.points), "累计 " + fx(d.total));
			}
			if (Array.isArray(d.milestones)) {
				for (var j = 0; j < d.milestones.length; j++) {
					var mid = String(d.milestones[j]);
					var mk = l + ":" + mid;
					if (state.seenMs[mk]) continue;
					state.seenMs[mk] = player.timePlayed;
					emit("里程碑", l + " #" + mid + " " + tmpField(l, "milestones", mid, "requirementDescription"),
						tmpField(l, "milestones", mid, "effectDescription"));
				}
			}
			if (Array.isArray(d.upgrades)) {
				for (var k = 0; k < d.upgrades.length; k++) {
					var uid = String(d.upgrades[k]);
					var uk = l + ":" + uid;
					if (state.seenUpg[uk]) continue;
					state.seenUpg[uk] = player.timePlayed;
					emit("购买升级", l + " #" + uid + " " + tmpField(l, "upgrades", uid, "title"), "cost=" + fx(upgCostNum(l, uid)));
				}
			}
			if (d.challenges) {
				for (var cid in d.challenges) {
					var n = d.challenges[cid] || 0;
					var ck = l + ":" + cid;
					var prev = state.seenCh[ck] || 0;
					if (n > prev) {
						state.seenCh[ck] = n;
						emit("挑战完成", l + " #" + cid + "（第 " + n + " 次）" + tmpField(l, "challenges", cid, "name"),
							tmpField(l, "challenges", cid, "rewardDescription") || tmpField(l, "challenges", cid, "rewardEffect"));
					}
				}
			}
		}
		if (!state.ignited && player.x && player.x.ignited) {
			state.ignited = true;
			emit("结局", "点燃恒星 ✓", "x.points=" + fx(player.x.points));
		}
	}

	// ---------- 增长指标（死锁检测用） ----------
	// 只统计**单调不减**的量：累计量(total/best)、计数器(resets/vents)、已达成数量(升级/里程碑/挑战/铭刻)、
	// 以及"历史峰值"（peak，见 updatePeaks）。
	// 两个踩过的坑：
	//   1) 绝不能放 player.points / d.points 的**当前值** —— 它们在每次重置时合法地暴跌，
	//      而本指标是和"历史最大值"比较的，稳定的刷圈循环会让当前值长期低于峰值，
	//      于是把正常推进误判成死锁（实测 chunk2 在 89min 的 FAIL(死锁) 就是这个假阳性）。
	//   2) 也不能放 timePlayed —— 时间永远在涨，放了就等于永远检测不到死锁。
	//      早期"只有热量在慢慢攒、还没第一次熔炼"确实算进展，所以用 peak.heat 来体现它。
	var PEAK = { heat: decimalZero, layer: {} };
	function updatePeaks() {
		try {
			// 用 new Decimal 复制一份：引擎的 points 虽然都是"重新赋值"而不是就地修改，
			// 但存引用一旦哪天有人写了就地修改的更新逻辑，峰值就会跟着变，检测器当场失效。
			if (player.points && player.points.gt(PEAK.heat)) PEAK.heat = new Decimal(player.points);
			for (var i = 0; i < cfg.available.length; i++) {
				var l = cfg.available[i];
				var d = player[l];
				if (!d || !d.points) continue;
				if (!PEAK.layer[l]) PEAK.layer[l] = decimalZero;
				if (d.points.gt(PEAK.layer[l])) PEAK.layer[l] = new Decimal(d.points);
			}
		} catch (e) { /* ignore */ }
	}
	function growth() {
		updatePeaks();
		var s = 0;
		function addLog(v) {
			if (v === undefined || v === null) return;
			var n = (typeof v === "number") ? v : (typeof v.toNumber === "function" ? v.toNumber() : NaN);
			if (!isFinite(n) || n <= 0) return;
			s += Math.log10(n);
		}
		addLog(PEAK.heat);                     // 热量历史峰值（单调）
		for (var i = 0; i < cfg.available.length; i++) {
			var l = cfg.available[i];
			var d = player[l];
			if (!d) continue;
			addLog(PEAK.layer[l]);             // 本层货币历史峰值（单调）
			addLog(d.total);
			addLog(d.best);
			if (d.resets !== undefined) addLog(d.resets);
			if (d.vents !== undefined) addLog(d.vents);
			if (Array.isArray(d.upgrades)) s += d.upgrades.length * 2;
			if (Array.isArray(d.milestones)) s += d.milestones.length * 6;
			if (Array.isArray(d.achievements)) s += d.achievements.length * 6;
			if (d.challenges) { for (var c in d.challenges) s += (d.challenges[c] || 0) * 10; }
		}
		return s;
	}

	// ---------- 快照（给宿主出报告） ----------
	function snap() {
		var o = {
			t: player.timePlayed,
			points: fx(player.points),
			pointGen: fx(tmp.pointGen),
			layers: {},
		};
		for (var i = 0; i < MAIN.length; i++) {
			var l = MAIN[i];
			if (!player[l]) { o.layers[l] = null; continue; }
			var d = player[l];
			o.layers[l] = {
				unlocked: !!d.unlocked,
				points: d.points ? fx(d.points) : "-",
				total: d.total ? fx(d.total) : "-",
				resets: d.resets === undefined ? null : fx(d.resets),
				vents: d.vents === undefined ? null : fx(d.vents),
				upgrades: (d.upgrades || []).slice(),
				milestones: (d.milestones || []).slice(),
				achievements: (d.achievements || []).length,
				challenges: d.challenges ? (function () { var c = {}; for (var k in d.challenges) c[k] = d.challenges[k]; return c; })() : {},
				activeChallenge: d.activeChallenge || null,
			};
		}
		o.side = {};
		for (var s in layers) {
			if (MAIN.indexOf(s) >= 0) continue;
			if (!layers[s] || !layers[s].isLayer) continue;
			if (s.indexOf("-") >= 0) continue;   // info-tab 等系统节点跳过
			var dd = player[s];
			if (!dd) continue;
			o.side[s] = { unlocked: !!dd.unlocked, achievements: (dd.achievements || []).length, milestones: (dd.milestones || []).length };
		}
		return o;
	}

	// 不变量检查：玩家持有的、但 unlocked() 现在返回 false 的升级
	// —— 这正是"互斥升级被同时买走"的证据（引擎 autobuyUpgrades 在同一 tick 内不刷新 tmp，
	//    于是 31 与 32 都会被买进去；见 README 的"已知引擎坑"）
	function invariants() {
		var out = [];
		for (var i = 0; i < cfg.available.length; i++) {
			var l = cfg.available[i];
			if (!usable(l)) continue;
			var ids = compIds(l, "upgrades");
			for (var j = 0; j < ids.length; j++) {
				var id = ids[j];
				if (!hasUpgrade(l, id)) continue;
				var un = true;
				try {
					var u = layers[l].upgrades[id];
					if (typeof u.unlocked === "function") un = !!u.unlocked.call(u);
				} catch (e) { un = true; }
				if (!un) out.push({ layer: l, id: id, title: tmpField(l, "upgrades", id, "title") });
			}
		}
		return out;
	}

	// ---------- 数值预算守卫（DESIGN.md §8.5，2026-10-29 修订版）----------
	// 旧规则「点燃时 heat 乘积 ≤ 1e40」已作废 —— 它和 §5 的内容规格自相矛盾
	// （t24 ×100、t31 ×1e4、x12 ×1e8、h24 ×1000 这些**静态**奖励相乘就超 1e40）。
	// 新规则分两层：
	//   硬约束（FAIL）：任意通道 / 任意 player 资源在长程模拟内**不得出现 Infinity 或 NaN**。
	//   软约束（WARN）：foldMult(name) 超过 cfg.budgetExp（默认 1e80，给 1e308 留 17 个数量级余量）
	//                  只报 WARN 并附归因，不判 FAIL —— 判定失控要看曲线形状。
	// 归因用钩子函数名（fn.name 或源码里的 function 名）。
	function hookName(fn) {
		try {
			if (fn && fn.name) return String(fn.name);
			var src = String(fn);
			var m = src.match(/function\s+([A-Za-z0-9_$]+)/);
			if (m) return m[1];
			return src.slice(0, 40).replace(/\s+/g, " ");
		} catch (e) { return "?" }
	}
	function hookReport(name) {
		var out = [];
		try {
			if (typeof HOOKS === "undefined" || !HOOKS[name]) return out;
			var L = HOOKS[name];
			for (var i = 0; i < L.length; i++) {
				var v = "ERR", thrown = false, bad = null;
				try {
					var r = L[i].fn();
					if (r === undefined || r === null) v = "undefined";
					else if (typeof r.isNan === "function" && typeof r.log10 === "function") {
						// Decimal：先看 NaN / Infinity，再取 log10（toNumber 对大数会返回 Infinity，不能当判据）
						if (r.isNan()) { v = "NaN"; bad = "NaN" }
						else if (r.isFinite && !r.isFinite()) { v = "Infinity"; bad = "Infinity" }
						else {
							var lg = r.log10().toNumber();
							v = isFinite(lg) ? "1e" + lg.toFixed(2) : String(r);
						}
					} else if (typeof r.toNumber === "function") {
						var n = r.toNumber();
						v = isFinite(n) ? n : (n > 0 ? "Infinity" : String(n));
						if (!isFinite(n)) bad = n > 0 ? "Infinity" : "NaN";
					} else {
						v = String(r);
						if (typeof r === "number" && !isFinite(r)) bad = r > 0 ? "Infinity" : "NaN";
					}
				} catch (e) { v = "THREW:" + e.message; thrown = true }
				out.push({ i: i, name: hookName(L[i].fn), prio: L[i].priority, value: v, threw: thrown, bad: bad });
			}
		} catch (e) { /* ignore */ }
		return out;
	}
	// 判定一个值是否"发散"（NaN 或 Infinity）—— 这是 §8.5 的硬约束判据。
	// 关键：绝不能拿 log10 的结果来判！log10(0) = -Infinity 是**合法**的（资源就是 0），
	// 早期版本这么写导致开局每个层的 points/total=0 全被误报成"数值发散"。
	function isBadValue(d) {
		try {
			if (d === undefined || d === null) return false;
			if (typeof d === "number") return !isFinite(d);           // NaN / ±Infinity
			if (typeof d.isNan === "function") {
				if (d.isNan()) return true;
				// Decimal 的"无限大"是 layer === Infinity（dInf/dNegInf），isFinite() 可判
				if (typeof d.isFinite === "function" && !d.isFinite()) return true;
				// 双保险：sign 为 0 一定是合法零值
				if (d.sign === 0) return false;
				if (typeof d.layer === "number" && !isFinite(d.layer)) return true;
				if (typeof d.mag === "number" && Number.isNaN(d.mag)) return true;
				return false;
			}
			if (typeof d.toNumber === "function") {
				var n = d.toNumber();
				return !isFinite(n);
			}
			return false;
		} catch (e) { return false }
	}
	// 折叠结果以 10 为底的对数。返回 null 只表示"值本身发散"（由 isBadValue 判）。
	// 坑：break_eternity 里 Decimal(0).log10() 返回 NaN（不是 -Infinity）。
	//   如果照 log10 的结果判有限性，所有"资源恰好为 0"的合法状态都会被误报成数值发散
	//   （实测开局每个层的 points/total 全中，直接判成 FAIL）。
	//   所以必须先判零再取 log10；发散判定一律走 isBadValue（它看的是 Decimal 本体）。
	function log10Of(d) {
		try {
			if (d === undefined || d === null) return 0;
			if (isBadValue(d)) return null;
			// 零 → 数学上是 -Infinity，这里原样返回，调用方自己按 -Infinity 处理
			if (typeof d.eq === "function" && d.eq(0)) return -Infinity;
			if (typeof d.sign === "number" && d.sign === 0) return -Infinity;
			if (typeof d.log10 === "function") {
				var l = d.log10();
				var n = (typeof l.toNumber === "function") ? l.toNumber() : Number(l);
				if (n === Number.NEGATIVE_INFINITY) return -Infinity;
				return isFinite(n) ? n : null;
			}
			var x = (typeof d.toNumber === "function") ? d.toNumber() : Number(d);
			if (!isFinite(x)) return x === 0 ? -Infinity : null;
			return x > 0 ? Math.log10(x) : (x === 0 ? -Infinity : null);
		} catch (e) { return null }
	}
	var BUDGET_HOOKS = ["heat", "coreGain", "ingotGain", "chrononGain", "stellarGain", "startPoints"];
	function reportOf(list) {
		return list.map(function (h) { return "#" + h.i + " " + h.name + "=" + h.value + (h.threw ? "(THREW)" : "") }).join("  ");
	}
	// 硬约束 1：所有乘法通道的折叠值 + 每个钩子的返回值，必须是有限 Decimal
	// 硬约束扫描（**廉价版**）：只看值本体是否发散，不做任何归因/字符串化。
	// 每 bot 步都跑一次昂贵扫描是性能灾难：hookReport 会把 6 个通道的每个钩子函数
	// 再调用一遍（等于把主循环的计算量翻几倍），240 分钟模拟直接跑不完。
	// 发散是单调的（一旦变 Infinity 就回不来），所以按时间抽稀检查不会漏。
	function scanFinite() {
		var hits = [];
		if (typeof foldMult !== "function" || typeof HOOKS === "undefined") return hits;
		for (var i = 0; i < BUDGET_HOOKS.length; i++) {
			var name = BUDGET_HOOKS[i];
			if (!HOOKS[name]) continue;
			var v = null;
			try { v = foldMult(name, 1); } catch (e) { continue }
			if (isBadValue(v)) hits.push({ channel: name, where: "foldMult(" + name + ")", detail: "" });
			else if (log10Of(v) > cfg.budgetExp) hits.push({ channel: name, where: "__soft__", detail: "", soft: log10Of(v) });
		}
		// player 里的资源（含热量）
		var pl = [["points", player.points]];
		for (var k = 0; k < cfg.available.length; k++) {
			var l = cfg.available[k];
			if (player[l] && player[l].points) pl.push([l + ".points", player[l].points]);
			if (player[l] && player[l].total) pl.push([l + ".total", player[l].total]);
		}
		for (var p = 0; p < pl.length; p++) {
			// 一律用 isBadValue（判 Decimal 本体），不要用 log10Of === null：
			// 资源的 0 值是合法的，log10 帮倒忙
			if (isBadValue(pl[p][1])) hits.push({ channel: "player", where: pl[p][0], detail: String(pl[p][1]) });
		}
		return hits;
	}
	// 报告用的完整扫描（可以昂贵，只在收尾调用一次）：带逐项归因
	function checkInfinity() {
		var hits = [];
		if (typeof foldMult !== "function" || typeof HOOKS === "undefined") return hits;
		for (var i = 0; i < BUDGET_HOOKS.length; i++) {
			var name = BUDGET_HOOKS[i];
			if (!HOOKS[name]) continue;
			var v = null;
			try { v = foldMult(name, 1); } catch (e) { continue }
			if (isBadValue(v)) hits.push({ channel: name, where: "foldMult(" + name + ")", detail: reportOf(hookReport(name)) });
			var rep = hookReport(name);
			for (var j = 0; j < rep.length; j++) {
				if (rep[j].bad) hits.push({ channel: name, where: "#" + rep[j].i + " " + rep[j].name, detail: rep[j].bad });
			}
		}
		var pl = [["points", player.points]];
		for (var k = 0; k < cfg.available.length; k++) {
			var l = cfg.available[k];
			if (player[l] && player[l].points) pl.push([l + ".points", player[l].points]);
			if (player[l] && player[l].total) pl.push([l + ".total", player[l].total]);
		}
		for (var p = 0; p < pl.length; p++) {
			if (isBadValue(pl[p][1])) hits.push({ channel: "player", where: pl[p][0], detail: String(pl[p][1]) });
		}
		return hits;
	}
	// 守卫：每 cfg.guardEverySec 模拟秒一次；硬约束=事件，软阈值=WARN（每通道一次）
	function checkBudgets() {
		if (typeof foldMult !== "function" || typeof HOOKS === "undefined") return null;
		if (player.timePlayed - state.lastGuard < cfg.guardEverySec) return null;
		state.lastGuard = player.timePlayed;
		var hits = scanFinite();
		for (var h = 0; h < hits.length; h++) {
			var hit = hits[h];
			if (hit.where === "__soft__") {
				var key = "budget:" + hit.channel;
				if (state.seenBudget[key]) continue;
				state.seenBudget[key] = player.timePlayed;
				emit("超软阈值(§8.5)", hit.channel + " 通道 = 1e" + Math.round(hit.soft) +
					"（软阈值 1e" + Math.round(cfg.budgetExp) + "，仅 WARN）", reportOf(hookReport(hit.channel)));
				continue;
			}
			var ik = "inf:" + hit.where;
			if (state.seenInf[ik]) continue;
			state.seenInf[ik] = player.timePlayed;
			emit("数值发散(§8.5硬约束)", hit.where + " 不是有限值（" + String(hit.detail).slice(0, 40) + "）",
				hit.channel === "player" ? "" : reportOf(hookReport(hit.channel)));
		}
		return null;
	}
	// 曲线形状（判定失控 vs 正常成长）：log10(热量/秒) 时间序列。
	// 按模拟时间抽稀（每 cfg.curveSampleSec 秒一个点），不用"每 bot 步一个点"：
	//   240 分钟 × 5 步/秒 = 7.2 万个点，既吃内存，又要靠截断保命（截断会把起点丢掉，
	//   导致 startLog10 变成"中段起点"，形状判定失真）。抽稀后 4 小时只有几百个点。
	var PEAKCURVE = { lastT: -1e9 };
	function curveShape() {
		var t = player.timePlayed;
		if (t - PEAKCURVE.lastT < cfg.curveSampleSec) return null;
		PEAKCURVE.lastT = t;
		var l10 = log10Of(tmp.pointGen);
		// null = 发散；-Infinity = 产量恰好为 0（合法，但没法参与斜率计算）→ 用 -60 当哨兵值
		var v = (l10 === null) ? 999 : (isFinite(l10) ? l10 : -60);
		state.curve.push({ t: t, v: v });
		if (state.curve.length > 20000) state.curve.splice(0, state.curve.length - 20000);  // 保险丝
		return null;
	}
	// §8.5 规则 1 的静态预算检查：buyable 的 per^limit ≤ 1e6（这条依然有效）。
	// 注：旧版的「先天效果指数 ≤ 0.25」已随 §8.5 修订作废 —— 指数以 §5 内容规格为准，
	// 只要求配 effCap/effSoft 软上限，所以这里不再检查指数。
	function staticBudgets() {
		var out = [];
		for (var i = 0; i < cfg.available.length; i++) {
			var l = cfg.available[i];
			var ids = compIds(l, "buyables");
			for (var j = 0; j < ids.length; j++) {
				var id = ids[j];
				try {
					var lim = layers[l].buyables[id].purchaseLimit;
					var limN = (lim && typeof lim.toNumber === "function") ? lim.toNumber() : Number(lim);
					if (!isFinite(limN) || limN <= 0) continue;   // 无限上限单独看待
					// 效果倍数只能实测：买 1 个与买 0 个的 effect 比值
					var e0 = null, e1 = null;
					try { e0 = layers[l].buyables[id].effect(D(0)); e1 = layers[l].buyables[id].effect(D(1)); } catch (e) { continue }
					var per = perValue(e0, e1);
					if (per === null || per <= 1) continue;
					var total = Math.pow(per, limN);
					if (total > 1e6) {
						out.push({ layer: l, id: id, per: per, limit: limN, total: total,
							text: l + " #" + id + " 每级 ×" + per.toFixed(2) + " × 上限 " + limN + " = " + expo(total) + "（> 1e6 预算）" });
					}
				} catch (e) { /* ignore */ }
			}
		}
		return out;
	}
	// 从 effect(0)/effect(1) 推出"每级倍率"（effect 可能是 Decimal 或 {k:Decimal} 对象）
	function perValue(e0, e1) {
		var best = null;
		var pick = function (o) {
			if (o === null || o === undefined) return [];
			if (typeof o.toNumber === "function") return [o];
			if (typeof o === "number") return [D(o)];
			if (typeof o === "object") {
				var arr = [];
				for (var k in o) { var v = o[k]; if (v && typeof v.toNumber === "function") arr.push(v); }
				return arr;
			}
			return [];
		};
		var a0 = pick(e0), a1 = pick(e1);
		var n = Math.min(a0.length, a1.length);
		for (var i = 0; i < n; i++) {
			try {
				var x0 = a0[i].toNumber(), x1 = a1[i].toNumber();
				if (!isFinite(x0) || !isFinite(x1) || x0 <= 0) continue;
				var r = x1 / x0;
				if (r > 1 && (best === null || r > best)) best = r;
			} catch (e) { /* ignore */ }
		}
		return best;
	}
	function expo(x) {
		if (!isFinite(x)) return "Inf";
		if (Math.abs(x) >= 1e6) return "1e" + Math.round(Math.log10(x));
		return String(Math.round(x));
	}

	// ---------- 从已有 player 预置"已发生"标记 ----------
	// 用 --load 恢复中局时，seen* 是全新的：若不预置，第一次 scanEvents 会把
	// 早已拿到的炉芯/早已点亮的里程碑/早已买过的升级，用**恢复时刻**的时间戳重发一遍，
	// 于是分块续跑（30min × N 段）拼出来的时间线全是假的。
	// 这里把当前 player 里已经存在的东西一律标记为"已见过"，只保留之后真正新发生的事件。
	function seedFromPlayer() {
		for (var i = 0; i < cfg.available.length; i++) {
			var l = cfg.available[i];
			if (!usable(l)) continue;
			var d = player[l];
			if (!d) continue;
			// 解锁标记用 d.unlocked：m/r/t/x 的 startData 显式写了 unlocked:false，
			// 且 FORGE_ALWAYS_KEEP 保留 unlocked → 它是单调的"曾经解锁"信号，比读 total 更准
			// （total 在极端情况下可能被别的逻辑清零，unlocked 不会）。
			// 再加 total>0 兜底，万一某层没写 unlocked:false 也不至于漏标。
			var got = 0;
			try { got = (d.total && typeof d.total.toNumber === "function") ? d.total.toNumber() : 0; } catch (e) { got = 0 }
			if (d.unlocked || got > 0) state.seenUnlock[l] = player.timePlayed;
			if (d.points && d.points.gt(0)) state.seenFirst[l] = player.timePlayed;
			if (Array.isArray(d.milestones)) for (var j = 0; j < d.milestones.length; j++) state.seenMs[l + ":" + d.milestones[j]] = player.timePlayed;
			if (Array.isArray(d.upgrades)) for (var k = 0; k < d.upgrades.length; k++) state.seenUpg[l + ":" + d.upgrades[k]] = player.timePlayed;
			if (d.challenges) for (var c in d.challenges) state.seenCh[l + ":" + c] = d.challenges[c] || 0;
			state.reset[l] = { lastBase: 0, lastTime: player.timePlayed, count: 0, ever: true };
		}
		if (player.x && player.x.ignited) state.ignited = true;
		updatePeaks();   // 峰值也从存档起步，否则续跑第一段会报出一个虚高的"增长"
		return 0;
	}

	// ---------- 对外 ----------
	globalThis.__BOT = {
		configure: function (opts) {
			if (opts.available) cfg.available = opts.available.slice();
			if (opts.allowed) cfg.allowed = opts.allowed.slice();
			if (opts.challenges !== undefined) cfg.challenges = !!opts.challenges;
			if (opts.challengeTimeout !== undefined) cfg.challengeTimeout = opts.challengeTimeout;
			if (opts.ventPolicy !== undefined) cfg.ventPolicy = opts.ventPolicy;
			if (opts.ventFrac !== undefined) cfg.ventFrac = opts.ventFrac;
			if (opts.budgetExp !== undefined) cfg.budgetExp = opts.budgetExp;
			if (opts.resetBaseGrowth !== undefined) cfg.resetBaseGrowth = opts.resetBaseGrowth;
			if (opts.resetMaxIdle !== undefined) cfg.resetMaxIdle = opts.resetMaxIdle;
		},
		// 一个决策步
		step: function () {
			try { openToggles(); } catch (e) { err("openToggles", e); }
			try { stepChallenges(); } catch (e) { err("stepChallenges", e); }
			try { stepClickables(); } catch (e) { err("stepClickables", e); }
			try { stepVent(); } catch (e) { err("stepVent", e); }
			try { stepUpgrades(); } catch (e) { err("stepUpgrades", e); }
			try { stepBuyables(); } catch (e) { err("stepBuyables", e); }
			try { stepResets(); } catch (e) { err("stepResets", e); }
			try { scanEvents(); } catch (e) { err("scanEvents", e); }
			try { curveShape(); } catch (e) { err("curveShape", e); }
			try { checkBudgets(); } catch (e) { err("checkBudgets", e); }
			return 0;
		},
		// 取走并清空累积的事件（宿主每个决策步收一次）
		drainEvents: function () {
			var out = cfg.log;
			cfg.log = [];
			return out;
		},
		hookReport: hookReport,
		staticBudgets: staticBudgets,
		checkInfinity: checkInfinity,
		seedFromPlayer: seedFromPlayer,
		// 曲线形状分析：log10(热量/秒) 序列的斜率与"斜率的变化率"
		// 正常增量成长：斜率持续为正且平滑上升；失控：斜率自己也在指数级变陡
		curveAnalysis: function () {
			var s = state.curve;
			if (!s || s.length < 4) return null;
			// 等距重采样成 40 个点，避免采样密度影响判定
			var n = 40, out = [];
			var t0 = s[0].t, t1 = s[s.length - 1].t;
			if (!(t1 > t0)) return null;
			for (var i = 0; i < n; i++) {
				var target = t0 + (t1 - t0) * i / (n - 1);
				var k = 0;
				while (k < s.length - 1 && s[k + 1].t < target) k++;
				// 必须记 target 而不是 s[k].t：记原始时间等于没做等距重采样，
				// dt 会随采样密度变化，下面的「每秒多少个数量级」判据就跟着漂。
				out.push({ t: target, v: s[k].v });
			}
			var slopes = [], curv = [];
			for (var a = 1; a < out.length; a++) {
				var dt = out[a].t - out[a - 1].t;
				if (dt <= 0) continue;
				slopes.push((out[a].v - out[a - 1].v) / dt);   // 每模拟秒涨多少个数量级
			}
			for (var b = 1; b < slopes.length; b++) curv.push(slopes[b] - slopes[b - 1]);
			var maxSlope = 0;
			for (var c = 0; c < slopes.length; c++) { if (slopes[c] > maxSlope) maxSlope = slopes[c] }
			// 分段统计一律用**中位数**，不用求和/最大值：
			//   「解锁新层」会让 log10 一次跳几十个数量级（台阶），那是合法成长，不是发散。
			//   用 max 或 mean 都会被这一个点主导 —— 实测同一份存档，20 分钟档判失控、
			//   45 分钟档不判，纯粹因为重采样间隔不同导致台阶摊开后的斜率不同。
			var third = Math.max(1, Math.floor(slopes.length / 3));
			function median(arr) {
				var a = arr.slice().sort(function (x, y) { return x - y });
				var m = Math.floor(a.length / 2);
				return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
			}
			var firstThird = median(slopes.slice(0, third));
			var lastThird = median(slopes.slice(slopes.length - third));
			var ratio = firstThird > 0 ? lastThird / firstThird : (lastThird > 0 ? Infinity : 0);
			// 「持续加速」的第二条件：末段里有多大比例的斜率明显高于首段中位数。
			// 单靠 ratio 不够 —— 一次跳档就能把末段中位数抬高，但只有少数区间受影响。
			var tailThresh = Math.max(firstThird * 3, 1e-9);
			var tailArr = slopes.slice(slopes.length - third);
			var tailBig = 0;
			for (var g = 0; g < tailArr.length; g++) if (tailArr[g] > tailThresh) tailBig++
			tailBig = tailArr.length ? tailBig / tailArr.length : 0;
			var maxCurv = 0;
			for (var e = 0; e < curv.length; e++) if (Math.abs(curv[e]) > maxCurv) maxCurv = Math.abs(curv[e]);
			var end = out[out.length - 1];
			// 999 是「产量已发散成 Infinity」的哨兵值，出现即判失控，不走形状分析
			var diverged = s.some(function (p) { return p.v >= 900 });
			return {
				points: out.length,
				sampleSpanSec: (t1 - t0) / (n - 1),
				startLog10: out[0].v,
				endLog10: end.v,
				maxSlopePerSec: maxSlope,
				slopeFirstThird: firstThird,
				slopeLastThird: lastThird,
				slopeRatio: firstThird > 0 ? lastThird / firstThird : null,
				slopeTailShare: tailBig,
				maxCurvature: maxCurv,
				diverged: diverged,
				// 失控 = 末段中位斜率比首段陡 4 倍以上，**且**末段过半区间都在加速。
				// 两个独立条件都要满足，阈值按实测数据校准（不是拍脑袋）：
				//   合法侧最大值  ratio 2.91 / share 0.46（本存档 20 分钟真实曲线）
				//   失控侧最小值  ratio 6.35 / share 0.62（当年 1e73 爆炸的形状）
				// 取 4 与 0.5 让两侧各留约 1.4 倍余量；单靠任一条件都会被
				// 「解锁新层造成的一次跳档」误触发（跳档能把 ratio 抬到 60+）。
				runaway: diverged || (ratio > 4 && tailBig > 0.5),
			};
		},
		budgetSnapshot: function () {
			var o = {};
			for (var i = 0; i < BUDGET_HOOKS.length; i++) {
				var n = BUDGET_HOOKS[i];
				try { o[n] = (typeof HOOKS !== "undefined" && HOOKS[n]) ? log10Of(foldMult(n, 1)) : 0; } catch (e) { o[n] = 0 }
			}
			return o;
		},
		growth: growth,
		snap: snap,
		invariants: invariants,
		botErrors: function () {
			var out = [];
			for (var k in state.errors) {
				var p = k.split("|");
				out.push({ where: p[0], message: p.slice(1).join("|"), count: state.errors[k] });
			}
			return out;
		},
		state: state,
		cfg: cfg,
	};
	return "BOT installed";
})()
`;

// ---------------------------------------------------------------------------
// 模拟主体
// ---------------------------------------------------------------------------
function runSim(args) {
	const api = H.boot({ seed: args.seed, verbose: args.verbose });
	const ctx = api.ctx;

	const report = {
		meta: {
			tool: "sim.js",
			seed: args.seed,
			minutes: args.minutes,
			stepMs: args.stepMs,
			botMs: args.botMs,
			curveEvery: args.curveEvery,
			deadlockMinutes: args.deadlockMinutes,
			challengeTimeoutMin: args.challengeTimeoutMin,
			only: args.only,
			challenges: !args.noChallenges,
			loadedAt: new Date().toISOString(),
			harnessBootMs: api.bootMs,
		},
		missingFiles: api.state.missingFiles.slice(),
		failedFiles: api.state.failedFiles.map((f) => ({ file: f.file, message: f.message, frame: f.frame })),
		warnings: api.state.warnings.slice(),
		layersLoaded: [],
		allowedLayers: [],
		sideLayers: [],
		events: [],
		curve: [],
		balance: [],
		deadlock: null,
		nan: [],
		errors: { fatal: [], hook: [] },
		botErrors: [],
		consoleErrorCount: 0,
		ticks: 0,
		botSteps: 0,
		simSeconds: 0,
		verdict: "UNKNOWN",
	};

	// --- 开局 ---
	if (args.load) {
		const abs = path.resolve(process.cwd(), args.load);
		if (!fs.existsSync(abs)) {
			console.error("读档失败，文件不存在: " + abs);
			report.verdict = "FAIL(读档)";
			report.meta.loadError = abs;
			return report;
		}
		api.loadSaveJson(fs.readFileSync(abs, "utf8"));
	} else {
		api.newGame();
	}

	if (!api.player || !api.tmp) {
		report.verdict = "FAIL(引擎未初始化)";
		report.errors.fatal.push({ severity: "runtime", type: "init", message: "newGame/load 后 player/tmp 仍不存在", stack: "" });
		return report;
	}

	// --- 安装 bot ---
	try {
		vm_run(ctx, BOT_SRC);
	} catch (e) {
		report.verdict = "FAIL(bot注入)";
		report.errors.fatal.push({ severity: "runtime", type: "bot-install", message: (e && e.message) || String(e), stack: H.firstFrames((e && e.stack) || "", 3) });
		return report;
	}
	const BOT = H.get(ctx, "globalThis.__BOT");
	if (!BOT) {
		report.verdict = "FAIL(bot注入)";
		return report;
	}

	const available = MAIN_LAYERS.filter((l) => {
		try { return !!(ctx.layers[l] && api.player[l] && H.get(ctx, "layers['" + l + "'].isLayer === true")); } catch (e) { return false; }
	});
	report.layersLoaded = available.slice();
	report.sideLayers = Object.keys(ctx.layers).filter((l) =>
		!MAIN_LAYERS.includes(l) && !l.includes("-") && ctx.layers[l] && ctx.layers[l].isLayer);

	// --only：只在指定层活动（更高层完全不碰）
	let allowed = available.slice();
	if (args.only && args.only.length) {
		allowed = available.filter((l) => args.only.includes(l));
		if (!allowed.length) {
			report.warnings.push("--only 指定的层都没有落地，回退为全部可用层: " + args.only.join(","));
			allowed = available.slice();
		}
	}
	report.allowedLayers = allowed.slice();

	BOT.configure({
		available,
		allowed,
		challenges: !args.noChallenges,
		challengeTimeout: args.challengeTimeoutMin * 60,
		ventPolicy: args.vent,
		budgetExp: args.budgetExp,
	});
	report.meta.vent = args.vent;
	report.meta.budgetExp = args.budgetExp;

	// --load 续跑：把 player 里"已经发生的事"预置成已见过，
	// 否则第一次 scanEvents 会用恢复时刻的时间戳把旧事件重发一遍，分块拼出的时间线全是假的。
	if (args.load) {
		try { BOT.seedFromPlayer(); report.seededFromSave = true; }
		catch (e) { botFail("seedFromPlayer", e); }
	}

	const progress = args.verbose ? (...a) => console.log("[sim]", ...a) : () => {};

	const botFail = (where, e) => {
		const rec = { severity: "runtime", type: "bot-host", where, message: (e && e.message) || String(e), stack: H.firstFrames((e && e.stack) || "", 2) };
		report.errors.fatal.push(rec);
	};

	// ------------------------------------------------------------------
	// 事件收集：drainEvents 直接拿 context 里的对象（都是宿主可 JSON 化的值）
	// 注意：collectEvents 会被下面的主循环与 largeTickTest 调用，必须定义在 botFail 之后
	//       （botFail 是 const，先前调用会踩 TDZ ReferenceError，被 catch 吞掉 → 事件全丢）
	// ------------------------------------------------------------------
	function collectEvents() {
		let evs = [];
		try { evs = BOT.drainEvents(); } catch (e) { botFail("drainEvents", e); }
		if (!Array.isArray(evs)) return;
		for (const e of evs) {
			report.events.push({
				t: Math.round(Number(e.t) * 100) / 100,
				kind: String(e.kind),
				text: String(e.text),
				detail: String(e.detail || ""),
			});
		}
	}

	// ------------------------------------------------------------------
	// 曲线
	// ------------------------------------------------------------------
	function sampleCurve() {
		let s;
		try { s = BOT.snap(); } catch (e) { botFail("snap", e); return; }
		if (!s) return;
		const row = { t: Math.round(Number(s.t)), points: s.points, pointGen: s.pointGen };
		for (const l of MAIN_LAYERS) row["l_" + l] = s.layers[l] ? s.layers[l].points : "-";
		report.curve.push(row);
		report.finalSnap = s;
	}

	// ------------------------------------------------------------------
	// 主循环
	// ------------------------------------------------------------------
	const totalSeconds = args.minutes * 60;
	const step = args.stepMs / 1000;
	const botEvery = args.botMs / 1000;
	const deadlockLimit = args.deadlockMinutes * 60;

	let elapsed = 0;
	let botAccum = 0;
	let guard = 0;
	let lastGrowth = -Infinity;
	// 用 player.timePlayed 作为基准，而不是 0：
	// --load 续跑时 timePlayed 已经是 3600s，若基准写 0，第一次死锁判断就是
	// 3600 - 0 >= 600 → 立刻误报死锁。曲线同理（否则会把已过去的每一分钟都补一行）。
	let lastGrowthAt = Number(api.player.timePlayed) || 0;
	let igniteAt = null;
	let nextCurve = (Math.floor((Number(api.player.timePlayed) || 0) / args.curveEvery) + 1) * args.curveEvery;
	let lastFatal = api.state.errors.filter((e) => e.severity !== "hook" && e.severity !== "console").length;

	sampleCurve();

	const tStart = Date.now();
	while (elapsed < totalSeconds - 1e-9 && guard < 20000000) {
		const d = Math.min(step, totalSeconds - elapsed);
		H.tick(api, d, null);
		elapsed += d;
		guard++;

		botAccum += d;
		// 用 while 而不是 if：当 --step 大于 --bot-every 时，一个 tick 里欠着好几次决策，
		// 用 if 会静默丢掉（表现为"步长一大就变慢"的假象），用 while 才保持决策频率。
		let botThisTick = 0;
		while (botAccum >= botEvery - 1e-9 && botThisTick < 64) {
			botAccum -= botEvery;
			botThisTick++;
			try { BOT.step(); report.botSteps++; } catch (e) { botFail("BOT.step", e); }
		}
		if (botThisTick) {
			collectEvents();

			// 死锁检测
			let g = 0;
			try { g = Number(BOT.growth()); } catch (e) { g = lastGrowth; }
			if (!(g > lastGrowth + 1e-9)) {
				if (api.player.timePlayed - lastGrowthAt >= deadlockLimit && api.player.timePlayed >= deadlockLimit && !report.deadlock) {
					let s = null;
					try { s = BOT.snap(); } catch (e) { /* ignore */ }
					report.deadlock = {
						at: Math.round(api.player.timePlayed),
						noGrowthSince: Math.round(lastGrowthAt),
						score: g,
						snap: s,
					};
					progress("死锁：", fmtClock(report.deadlock.at));
					break;
				}
			} else {
				lastGrowth = g;
				lastGrowthAt = api.player.timePlayed;
			}
		}

		// 曲线
		if (api.player.timePlayed >= nextCurve) {
			sampleCurve();
			nextCurve += args.curveEvery;
			if (args.verbose) progress("t=" + fmtClock(api.player.timePlayed), "points=" + String(api.player.points), "gen=" + String(api.tmp.pointGen));
		}

		// 引擎自己报了 NaN → 早停
		if (api.player.hasNaN) { report.hasNaNFlag = true; break; }

		// 运行期异常持续刷屏 → 早停。
		// 典型场景：某个侧层（ach/stats）抛 ReferenceError，gameLoop 里 updateAchievements 一炸，
		// 后面所有层都不再 update（炉压不涨、热量不产），表现为"整局 0 产出"的假死锁。
		// harness 已按指纹去重，所以这里比较的是"不同类异常的种类数"。
		const fatalNow = api.state.errors.filter((e) => e.severity !== "hook" && e.severity !== "console").length;
		if (fatalNow - lastFatal > args.maxFatalTypes) {
			report.hardStop = { fatalTypes: fatalNow, at: Math.round(api.player.timePlayed) };
			break;
		}

		// 点燃恒星后再观察 60 秒（验证 keep-going 不炸），然后结束
		const ignitedNow = api.player.x && api.player.x.ignited;
		if (ignitedNow) {
			if (igniteAt === null) igniteAt = api.player.timePlayed;
			else if (api.player.timePlayed > igniteAt + 60) break;
		}
	}

	// ------------------------------------------------------------------
	// 收尾
	// ------------------------------------------------------------------
	collectEvents();
	sampleCurve();
	report.simSeconds = Math.round(api.player.timePlayed);
	report.ticks = api.state.ticks;
	report.wallMs = Date.now() - tStart;
	report.realTimeout = guard >= 20000000;

	try { report.botErrors = BOT.botErrors(); } catch (e) { report.botErrors = []; }

	report.nan = api.nanScan();
	report.consoleErrorCount = api.state.consoleErrorCount;
	report.errors.fatal = report.errors.fatal.concat(api.state.errors.filter((e) => e.severity !== "hook" || e.type === "load-error"));
	report.errors.hook = api.state.errors.filter((e) => e.severity === "hook");

	// §8.5（修订版）守卫：硬约束 = 不得出现 Infinity/NaN；软阈值 = 仅 WARN
	// 必须在主循环刚结束、大 tick 测试之前取：否则快照反映的是"跳过 4 小时之后"的状态。
	report.hookChains = {};
	for (const name of ["heat", "coreGain", "ingotGain", "chrononGain", "stellarGain", "startPoints"]) {
		try {
			const list = BOT.hookReport(name);
			if (list && list.length) report.hookChains[name] = list;
		} catch (e) { /* ignore */ }
	}
	// 收尾时各通道的 log10(foldMult)；null = 非有限（Infinity/NaN），会进 infinityHits
	try { report.budgetSnapshot = BOT.budgetSnapshot(); } catch (e) { report.budgetSnapshot = null; }
	// 硬约束终检（收尾状态）
	try { report.infinityHits = BOT.checkInfinity(); } catch (e) { report.infinityHits = []; }
	// staticBudgets 只读 layers 的定义（per/limit），与运行时状态无关，放在哪儿都一样
	try { report.staticBudgetViolations = BOT.staticBudgets(); } catch (e) { report.staticBudgetViolations = []; }
	// 曲线形状判定（失控 vs 正常成长）
	try { report.curveAnalysis = BOT.curveAnalysis(); } catch (e) { report.curveAnalysis = null; }
	// 主循环里出现过的告警事件（收尾快照看不到的"中途爆炸/中途发散"）
	report.budgetWarnings = report.events.filter((e) => e.kind === "超软阈值(§8.5)");
	report.infinityEvents = report.events.filter((e) => e.kind === "数值发散(§8.5硬约束)");

	// 首次事件时间（喂给 §8 对照）
	const firstOf = (kind, match) => {
		for (const e of report.events) {
			if (e.kind !== kind) continue;
			if (match && e.text.indexOf(match) < 0) continue;
			return e.t;
		}
		return null;
	};
	report.firstTimes = {
		firstResource: {
			h: firstOf("首次获得货币", "h."),
			m: firstOf("首次获得货币", "m."),
			r: firstOf("首次获得货币", "r."),
			t: firstOf("首次获得货币", "t."),
			x: firstOf("首次获得货币", "x."),
		},
		unlocked: {
			h: firstOf("层解锁", "h（"),
			m: firstOf("层解锁", "m（"),
			r: firstOf("层解锁", "r（"),
			t: firstOf("层解锁", "t（"),
			x: firstOf("层解锁", "x（"),
		},
		ignited: firstOf("结局", "点燃恒星"),
	};

	// 注意顺序：constants 必须先取，suggest() 才拿得到真实的 *_BAL 数值
	report.constants = collectConstants(ctx);
	report.balance = checkBalance(report, args);
	report.invariantViolations = collectInvariants(BOT);
	report.verdict = overallVerdict(report);

	if (args.save) {
		const abs = path.resolve(process.cwd(), args.save);
		const json = api.dumpSaveJson();
		if (json) { fs.writeFileSync(abs, json, "utf8"); report.savedTo = abs; }
		else report.warnings.push("导出存档失败（JSON.stringify(player) 抛错）");
	}

	// 大 tick / 离线收益稳健性 —— 只在显式要求时跑，而且放在最后。
	// 之前写成 if (args.largeTickHours > 0)（默认 4）等于**每次模拟都偷偷跳 4 小时**：
	//   --save 存的档带着 +3600s 的时间戳，续跑时时间线全乱；
	//   钩子快照/曲线/最终状态也都变成了"跳完之后"的样子。
	// 现在：默认不跑；--large-tick 才跑，且跑在最后，不影响任何已归档的数据。
	if (args.largeTick) {
		report.largeTick = largeTickTest(api, BOT, args, collectEvents);
		// 大 tick 发现的问题要影响判定（但不改变上面已经算好的 balance/曲线）
		if (report.largeTick && !report.largeTick.ok && report.verdict.indexOf("FAIL") !== 0) {
			report.verdict = "FAIL(大 tick)";
		}
	}

	return report;
}

function vm_run(ctx, src) {
	// 直接用 harness 暴露的方式在 context 里执行一段脚本
	const vm = require("vm");
	return vm.runInContext(src, ctx, { filename: "tools/sim.js:BOT_SRC", displayErrors: true });
}

// ---------------------------------------------------------------------------
// 不变量收集
// ---------------------------------------------------------------------------
function collectInvariants(BOT) {
	try {
		const v = BOT.invariants();
		return Array.isArray(v) ? v : [];
	} catch (e) { return []; }
}

// 读取各层顶部的 *_BAL 常量表（给"具体调参建议"用，避免建议里写死错误的当前值）
function collectConstants(ctx) {
	const names = ["H_BAL", "M_BAL", "R_BAL", "T_BAL", "X_BAL", "FORGE_END", "ACH_BAL", "S_BAL"];
	const out = {};
	for (const n of names) {
		const v = H.get(ctx, "(function(){ try { return (typeof " + n + " === 'object' && " + n + ") ? " + n + " : null } catch(e){ return null } })()");
		if (!v) continue;
		try { out[n] = JSON.parse(JSON.stringify(v)); } catch (e) { /* 函数值会被丢掉，没关系 */ }
	}
	return out;
}

// 从常量表里安全取一个数，支持 "upg.11" 这样的点路径
function kon(C, obj, path, dflt) {
	const o = C[obj];
	if (!o) return dflt;
	let cur = o;
	for (const seg of String(path).split(".")) {
		if (cur === null || cur === undefined) return dflt;
		cur = cur[seg];
	}
	return (typeof cur === "number" && isFinite(cur)) ? cur : dflt;
}

// 各阶段可调的常量（全部读真实 *_BAL，绝不写死）
function knobs(C, key) {
	switch (key) {
		case "firstCore":
			return [
				["H_BAL.requires", kon(C, "H_BAL", "requires", 20)],
				["H_BAL.upg.11（鼓风的炉芯价）", kon(C, "H_BAL", "upg.11", 1)],
				["H_BAL.ventSeconds（泄压给多少秒产量）", kon(C, "H_BAL", "ventSeconds", 15)],
			];
		case "unlockM":
			return [
				["M_BAL.requires", kon(C, "M_BAL", "requires", 50)],
				["H_BAL.requires", kon(C, "H_BAL", "requires", 20)],
				["H_BAL.upg.11", kon(C, "H_BAL", "upg.11", 1)],
			];
		case "unlockR":
			return [
				["R_BAL.requires", kon(C, "R_BAL", "requires", 10)],
				["M_BAL.requires", kon(C, "M_BAL", "requires", 50)],
				["M_BAL.upg.11（锻锤的锭条价）", kon(C, "M_BAL", "upg.11", 1)],
			];
		case "unlockT":
			return [
				["T_BAL.requires", kon(C, "T_BAL", "requires", 10)],
				["R_BAL.requires", kon(C, "R_BAL", "requires", 10)],
				["R_BAL.upg.11", kon(C, "R_BAL", "upg.11", 2)],
			];
		case "unlockX":
			return [
				["X_BAL.requires", kon(C, "X_BAL", "requires", 20)],
				["T_BAL.requires", kon(C, "T_BAL", "requires", 10)],
				["T_BAL.upg.11", kon(C, "T_BAL", "upg.11", 1)],
			];
		case "ignite":
			return [
				["FORGE_END.igniteCost", kon(C, "FORGE_END", "igniteCost", 1000)],
				["FORGE_END.igniteChallenges", kon(C, "FORGE_END", "igniteChallenges", 3)],
				["X_BAL.requires", kon(C, "X_BAL", "requires", 20)],
			];
		default:
			return [];
	}
}

// 「首次熔炼 <15s」这一档要特别处理：DESIGN.md §8 写于炉压重做之前。
// 现在 h.js 把 requires=200 与 ventSeconds=300 配套（第一次满压泄放刚好换到 1 炉芯），
// 而炉压充满需要 pressureCap/pressureRate ≈ 16.7s，所以首芯的物理下限就在 17s 左右。
// checkBalance 会**用这两个常量实时推导**判定上限（不写死数字），常量一改判定自动跟着变；
// 报告里会注明是按哪条路径判定的，不会假装是 §8 原文达标。
const BALANCE_TARGETS = [
	{
		key: "firstCore", label: "首次熔炼（1 炉芯）", min: 0, maxMin: 15 / 60, need: "h", src: "firstResource",
		pathNote: "满压泄压路径",
	},
	{ key: "unlockM", label: "解锁 锻造 m", min: 3, maxMin: 8, need: "m", src: "unlocked", pathNote: "满压泄压路径" },
	{ key: "unlockR", label: "解锁 反应 r", min: 10, maxMin: 20, need: "r", src: "unlocked", pathNote: "满压泄压路径" },
	{ key: "unlockT", label: "解锁 凝时 t", min: 25, maxMin: 50, need: "t", src: "unlocked", pathNote: "满压泄压路径" },
	{ key: "unlockX", label: "首次熔星 x", min: 70, maxMin: 140, need: "x", src: "unlocked", pathNote: "满压泄压路径" },
	{ key: "ignite", label: "点燃恒星（通关）", min: 120, maxMin: 300, need: "x", src: "ignited", pathNote: "自动化后" },
];

function checkBalance(report, args) {
	const rows = [];
	const ft = report.firstTimes || {};
	const toMin = (sec) => (sec === undefined || sec === null ? null : sec / 60);
	const C = report.constants || {};

	// 「首次熔炼」按**满压泄压路径**判定。该路径的物理下限是炉压充满所需的时间
	//   floor = H_BAL.pressureCap / H_BAL.pressureRate
	// 因为 h.js 把 requires 与 ventSeconds 配套成「第一次满压泄放 ≈ 1 炉芯」，首芯不可能早于 floor；
	// 而 §8 的 15s 写在炉压重做之前（那时 floor 远小于 15s）。
	// 判定上限取 max(§8, floor×1.15)，并把 floor 打进报告 —— 常量一改判定自动跟着变，
	// 不是把 §8 的数字偷偷改掉，也不会假装是原文达标。
	let firstCoreFloorSec = null;
	try {
		const cap = kon(C, "H_BAL", "pressureCap", 0);
		const rate = kon(C, "H_BAL", "pressureRate", 0);
		if (cap > 0 && rate > 0) firstCoreFloorSec = cap / rate;
	} catch (e) { firstCoreFloorSec = null; }
	report.firstCoreFloorSec = firstCoreFloorSec;

	for (const tgt of BALANCE_TARGETS) {
		let v = null;
		if (tgt.src === "ignited") v = toMin(ft.ignited);
		else if (tgt.src === "firstResource") v = toMin((ft.firstResource || {})[tgt.need]);
		else v = toMin((ft.unlocked || {})[tgt.need]);

		const landed = report.layersLoaded.includes(tgt.need) && report.allowedLayers.includes(tgt.need);
		// 判定上限（分钟）：firstCore 用物理下限推出的容差，其余一律用 §8 原文
		let judgeMax = tgt.maxMin;
		let judgedBy = "§8 原文";
		if (tgt.key === "firstCore" && firstCoreFloorSec !== null) {
			const j = Math.max(tgt.maxMin, (firstCoreFloorSec * 1.15) / 60);
			if (j > tgt.maxMin) { judgeMax = j; judgedBy = "满压泄压路径（炉压充满下限 " + firstCoreFloorSec.toFixed(1) + "s）"; }
		}
		const regraded = judgeMax !== tgt.maxMin;

		let status, dev;
		if (!landed) { status = "SKIP(未落地)"; dev = null; }
		else if (v === null) { status = "未达成"; dev = null; }
		else if (v > judgeMax) { status = "偏慢"; dev = Math.round(((v - judgeMax) / judgeMax) * 1000) / 10; }
		else if (tgt.min > 0 && v < tgt.min) { status = "偏快"; dev = Math.round(((v - tgt.min) / tgt.min) * 1000) / 10; }
		else { status = regraded ? "OK(按路径)" : "OK"; dev = 0; }

		rows.push({
			key: tgt.key,
			label: tgt.label,
			target: tgt.min === 0
				? "< " + Math.round(tgt.maxMin * 60) + "s" + (regraded ? "（判 " + Math.round(judgeMax * 60) + "s）" : "")
				: tgt.min + "–" + tgt.maxMin + " min",
			actual: v === null ? "—" : (v < 1 ? Math.round(v * 60) + "s" : v.toFixed(2) + " min"),
			status,
			deviation: dev,
			judgedBy,
			path: tgt.pathNote || "",
			suggestion: suggest(tgt, v, report, judgeMax),
		});
	}
	return rows;
}

// §8 是按「满压泄压」的真人路径定的。--vent 不是 cap 时，这些数字只作参考，
// 必须在报告里写清楚，否则会把 requires 一路压小、破坏后面层的节奏。
function balancePathCaveat(report) {
	const vent = (report.meta && report.meta.vent) || "cap";
	if (vent === "cap") return "判定路径：满压泄压（cap）—— 与 DESIGN.md §8 的定档路径一致";
	const hint = {
		half: "半压就放 → 泄压额度只有 (0.5)^ventPow，会系统性偏慢",
		asap: "冷却一到就乱放 → 几乎拿不到泄压收益，前期基本停滞",
		never: "从不手动泄压 → 只能靠引擎的 autoVent（要 milestone 0，而它要首次熔炼才有），前期极慢",
	}[vent] || "";
	return "⚠ 判定路径：" + vent + "（非 §8 的定档路径）" + (hint ? " — " + hint : "") +
		"；下面的「偏慢/建议值」不可直接照抄，请用 --vent=cap 复核";
}

// 对失衡项给具体建议（一律读实际 *_BAL 常量表，绝不写死当前值）
// maxMin 传入的是 checkBalance 实际判定用的上限（可能是按满压路径推出来的），
// 否则会出现"status=OK 但建议说偏慢"的自相矛盾。
function suggest(tgt, v, report, maxMin) {
	const C = report.constants || {};
	const cap = (maxMin === undefined || maxMin === null) ? tgt.maxMin : maxMin;
	if (!report.layersLoaded.includes(tgt.need) || !report.allowedLayers.includes(tgt.need)) {
		return "该层文件还没落地/未被允许，无法评估";
	}
	if (v === null) {
		return "在 " + report.meta.minutes + " 分钟内未达成 → 加长模拟（--minutes=" + Math.max(60, report.meta.minutes * 4) + "）；" +
			"若仍不达成，检查 " + tgt.need + " 的 requires（当前 " + fmtNum(reqOf(C, tgt.need)) + "）与上游产出钩子";
	}
	const over = v > cap;                    // 偏慢
	const fast = tgt.min > 0 && v < tgt.min;  // 偏快
	if (!over && !fast) return "符合 §8";
	const k = over ? (v / cap) : (tgt.min / Math.max(v, 1e-9)); // 需要放大/缩小的倍数

	// 可调常量（读真实值，按影响力排序）
	const list = knobs(C, tgt.key).filter((p) => typeof p[1] === "number" && isFinite(p[1]));
	if (!list.length) return (over ? "偏慢" : "偏快") + "：实测 " + v.toFixed(2) + " 分钟 vs 目标 " + tgt.min + "–" + tgt.maxMin + " 分钟（读不到该阶段的 *_BAL 常量）";

	const [name, val] = list[0];
	const alt = list.slice(1);
	if (over) {
		// 门槛与等待时间大致是**幂律**（normal 层 gain=(base/requires)^exp），
		// 所以"要快 k 倍"通常只需要把 requires 改 k^(1/exp) 倍，这里给保守的线性建议并提醒幂律。
		let s = "偏慢 " + Math.round((k - 1) * 100) + "%（实测 " + v.toFixed(2) + " 分 / 目标上限 " + tgt.maxMin + " 分）→ 把 " +
			name + "（当前 " + fmtNum(val) + "）降到 " + fmtNum(val / k) + "，" +
			"或把上游乘数（对应钩子）放大 " + fmtNum(k) + "×";
		if (alt.length) s += "；次选：" + alt.map((p) => p[0] + " " + fmtNum(p[1]) + " → " + fmtNum(p[1] / k)).join("；");
		s += "。（注意 normal 层是幂律：requires ÷k 带来的加速约为 √k 级，可能要迭代两三轮）";
		return s;
	}
	let s2 = "偏快 " + Math.round((k - 1) * 100) + "%（实测 " + v.toFixed(2) + " 分 / 目标下限 " + tgt.min + " 分）→ 把 " +
		name + "（当前 " + fmtNum(val) + "）提到 " + fmtNum(val * k);
	if (alt.length) s2 += "；或提高 " + alt[0][0] + "（" + fmtNum(alt[0][1]) + " → " + fmtNum(alt[0][1] * k) + "）";
	return s2;
}

function reqOf(C, layer) {
	const map = { h: ["H_BAL", "requires"], m: ["M_BAL", "requires"], r: ["R_BAL", "requires"], t: ["T_BAL", "requires"], x: ["X_BAL", "requires"] };
	const s = map[layer];
	if (!s) return null;
	return kon(C, s[0], s[1], null);
}

function fmtNum(x) {
	if (x === null || x === undefined) return "?";
	if (typeof x !== "number" || !isFinite(x)) return String(x);
	if (Math.abs(x) >= 1e6) {
		const e = Math.floor(Math.log10(Math.abs(x)));
		return (x / Math.pow(10, e)).toFixed(2) + "e" + e;
	}
	return String(Math.round(x * 1000) / 1000);
}

// ---------------------------------------------------------------------------
// 大 tick 稳健性测试
// 目的：验证 maxTickLength() / 离线收益路径不会把游戏搞坏。
// 做法：记下关键状态（炉压、各冷却、过载剩余、泄压次数），然后把 player.time 一次性
//       往前跳 H 小时，再用一个 diff 大于 maxTickLength 的 tick 走引擎的真实离线路径
//       （harness.tick 会按 modInfo.offlineLimit 截断 offTime.remain），检查：
//         1. 没有 NaN
//         2. 泄压次数/熔炼次数没有被刷爆（一次跳 4h 不该等于 4800 次泄压）
//         3. 冷却（ventCd / surgeCdLeft / surgeLeft）仍然是有限非负，且没有"越跳越负"
//         4. 热量与各层货币没有变成 Infinity
//       注意：h.js 的 update 每 tick 把炉压加 rate*diff 并 clamp 到 pressureCap，
//             所以长 tick 只会让压力顶到上限，这是预期行为，不算 bug。
// ---------------------------------------------------------------------------
function largeTickTest(api, BOT, args, collectEvents) {
	const out = { hours: args.largeTickHours, ok: true, problems: [] };
	const p = () => api.player;
	if (!p()) { out.ok = false; out.problems.push("player 不存在"); return out; }

	const readNum = (expr) => {
		const v = H.get(api.ctx, "(function(){ try { var x = " + expr + ";" +
			" if (x === undefined || x === null) return null;" +
			" var n = (typeof x === 'number') ? x : (typeof x.toNumber === 'function' ? x.toNumber() : Number(x));" +
			" return isFinite(n) ? n : (n > 0 ? Infinity : (n < 0 ? -Infinity : NaN));" +
			"} catch(e){ return 'ERR:' + e.message } })()");
		return v;
	};

	const before = {
		timePlayed: p().timePlayed,
		points: readNum("player.points"),
		vents: readNum("player.h && player.h.vents"),
		pressure: readNum("player.h && player.h.pressure"),
		ventCd: readNum("player.h && player.h.ventCd"),
		surgeLeft: readNum("player.t && player.t.surgeLeft"),
		surgeCd: readNum("player.t && player.t.surgeCdLeft"),
		resets: MAIN_LAYERS.reduce((o, l) => { o[l] = readNum("player." + l + " && player." + l + ".resets"); return o; }, {}),
	};

	// 1) 直接调 updateTemp + gameLoop(diff = H 小时)，复刻 index.html 里长 diff 的路径
	const diffSec = args.largeTickHours * 3600;
	api.advanceTime(Math.round(diffSec * 1000));
	// 离线收益：模拟 save.js 的 load() 里那套（remain += 真实经过秒数），
	// 再走 harness.tick 的 offTime 处理（它按 offlineLimit 截断）
	H.get(api.ctx, "(function(){ try { player.offTime = { remain: " + diffSec + " }; } catch(e){} })()");
	H.get(api.ctx, "(function(){ try { options.offlineProd = true; } catch(e){} })()");

	const errBefore = api.state.errors.length;
	// 一个超大 diff 的 tick：gameLoop 内部会被 maxTickLength() 截断
	H.tick(api, diffSec, null);
	collectEvents();
	// 再把 offTime 剩下的分 10 次消化完（引擎就是这么干的）
	for (let i = 0; i < 10; i++) {
		const remain = H.get(api.ctx, "(function(){ try { return player.offTime ? player.offTime.remain : 0 } catch(e){ return 0 } })()");
		if (!(remain > 0)) break;
		const chunk = Math.max(remain / 10, 1);
		api.advanceTime(Math.round(chunk * 1000));
		H.tick(api, chunk, null);
		collectEvents();
	}

	const after = {
		timePlayed: p().timePlayed,
		points: readNum("player.points"),
		vents: readNum("player.h && player.h.vents"),
		pressure: readNum("player.h && player.h.pressure"),
		ventCd: readNum("player.h && player.h.ventCd"),
		surgeLeft: readNum("player.t && player.t.surgeLeft"),
		surgeCd: readNum("player.t && player.t.surgeCdLeft"),
		resets: MAIN_LAYERS.reduce((o, l) => { o[l] = readNum("player." + l + " && player." + l + ".resets"); return o; }, {}),
	};

	out.before = before;
	out.after = after;
	out.newFatalTypes = api.state.errors.slice(errBefore).filter((e) => e.severity !== "hook" && e.severity !== "console");

	const isNum = (x) => typeof x === "number";
	// NaN / Infinity 检查
	for (const k of ["points", "vents", "pressure", "ventCd", "surgeLeft", "surgeCd"]) {
		const v = after[k];
		if (typeof v === "string") { out.ok = false; out.problems.push(k + " 读取失败: " + v); continue; }
		if (v === null || v === undefined) continue;
		if (Number.isNaN(v)) { out.ok = false; out.problems.push(k + " 变成 NaN"); }
		if (v === Infinity) { out.ok = false; out.problems.push(k + " 变成 Infinity（大 tick 数值溢出）"); }
		if (v < 0 && (k === "ventCd" || k === "surgeCd" || k === "surgeLeft" || k === "pressure")) {
			out.ok = false; out.problems.push(k + " 变负 (" + v + ")：冷却被长 tick 刷穿");
		}
	}
	for (const l of MAIN_LAYERS) {
		const v = after.resets[l];
		if (typeof v === "number" && Number.isNaN(v)) { out.ok = false; out.problems.push(l + ".resets 变成 NaN"); }
	}

	// 刷爆检查：4 小时跳一次，不该等于逐帧那么多次泄压/重置
	// 判据：vents 增量 / (diffSec / ventCooldown) 应该 <= 1（因为一次大 tick 只结算一次 update）
	const ventCdBase = readNum("(typeof H_BAL !== 'undefined') ? H_BAL.ventCooldown : 3");
	if (isNum(before.vents) && isNum(after.vents) && isNum(ventCdBase) && ventCdBase > 0) {
		const dv = after.vents - before.vents;
		const perSec = 1 / ventCdBase;
		const naive = diffSec * perSec;    // 逐帧结算会有的次数
		if (dv > 1 && dv > naive * 0.5) {
			out.problems.push("警告：一次 " + args.largeTickHours + "h 的大 tick 让 vents 增加了 " + dv + " 次（逐帧结算是 " + Math.round(naive) + " 次）—— 泄压可能有每 tick 自动触发的路径，在长 tick 下会被放大");
			out.ventAmplified = { delta: dv, naive };
		}
	}
	const nan = api.nanScan();
	if (nan.length) { out.ok = false; out.problems.push("大 tick 后 NaN 扫描发现 " + nan.length + " 处: " + nan.slice(0, 5).map((n) => n.path + "=" + n.value).join(", ")); }
	if (out.newFatalTypes.length) {
		out.ok = false;
		out.problems.push("大 tick 期间新增 " + out.newFatalTypes.length + " 类致命异常: " +
			out.newFatalTypes.slice(0, 3).map((e) => (e.fn || e.file || "") + "|" + e.message).join(" ; "));
	}
	out.timePlayedDelta = isNum(before.timePlayed) && isNum(after.timePlayed) ? after.timePlayed - before.timePlayed : null;
	return out;
}

// ---------------------------------------------------------------------------
// 平衡常量表打印（--constants）
// ---------------------------------------------------------------------------
function printConstants(C) {
	const names = ["H_BAL", "M_BAL", "R_BAL", "T_BAL", "X_BAL", "ACH_BAL", "FORGE_END"];
	console.log("");
	console.log("当前各层顶部的平衡常量表（调参就改这些，别散进公式里）:");
	for (const n of names) {
		const o = C[n];
		if (!o) { console.log("  " + n + ": （该层未落地或不是对象）"); continue; }
		console.log("  ── " + n + " ──");
		const keys = Object.keys(o);
		// 一行 3 个，紧凑排版；嵌套对象（如 upg/buyables/milestones）单独展开一行
		let buf = [];
		for (const k of keys) {
			const v = o[k];
			if (v && typeof v === "object") continue;
			if (typeof v === "function") continue;
			buf.push(k + "=" + fmtNum(v));
			if (buf.length === 3) { console.log("      " + buf.join("  ")); buf = []; }
		}
		if (buf.length) console.log("      " + buf.join("  "));
		for (const k of keys) {
			const v = o[k];
			if (!(v && typeof v === "object")) continue;
			let inner;
			try { inner = JSON.stringify(v); } catch (e) { inner = String(v); }
			if (inner.length > 300) inner = inner.slice(0, 300) + "…";
			console.log("      " + k + " = " + inner);
		}
	}
}

function overallVerdict(report) {
	const fatal = report.errors.fatal || [];
	// 缺文件/加载报错 = 队友文件还没好，属于 FAIL（但会单独标出来）
	// §8.5（2026-10-29 修订版）：只有"出现 Infinity/NaN"才是 FAIL；
	// 超过软阈值（1e80）只算 WARN —— 旧的 1e40 总预算与 §5 内容规格自相矛盾，已作废。
	const infinity = (report.infinityHits || []).length + (report.infinityEvents || []).length;
	const runaway = report.curveAnalysis && report.curveAnalysis.runaway;
	if (report.deadlock) return "FAIL(死锁)";
	if (report.failedFiles.length) return "FAIL(加载报错)";
	if (fatal.length) return "FAIL(运行异常)";
	if (report.nan.length) return "FAIL(NaN)";
	if (report.hasNaNFlag) return "FAIL(NaN标志)";
	if (infinity) return "FAIL(数值发散)";
	if (runaway) return "FAIL(曲线失控)";
	if (report.invariantViolations && report.invariantViolations.length) return "FAIL(不变量被破坏)";
	const softWarn = (report.budgetWarnings || []).length;
	const staticBad = (report.staticBudgetViolations || []).length;
	if (report.consoleErrorCount > 0) return "WARN(console.error)";
	if (softWarn) return "WARN(超软阈值 " + softWarn + " 项，曲线形状正常)";
	if (staticBad) return "WARN(buyable 预算 " + staticBad + " 项)";
	const bad = report.balance.filter((b) => b.status.indexOf("OK") !== 0 && b.status.indexOf("SKIP") !== 0);
	if (bad.length) return "WARN(节奏偏离 " + bad.length + " 项)";
	// 重定档（judgeMax）算达标，报告底部会打印理由，避免看起来像"原文就过了"
	return "PASS";
}

// ---------------------------------------------------------------------------
// 文本报告
// ---------------------------------------------------------------------------
function printTextReport(report, args) {
	const line = (ch) => console.log(String(ch || "─").repeat(118));
	console.log("");
	console.log("《熔炉之树》自动模拟报告  ·  tools/sim.js");
	line();
	console.log("判定: " + report.verdict);
	console.log("模拟: " + report.meta.minutes + " 分钟 → 实际推进 " + fmtClock(report.simSeconds) +
		"  |  tick " + report.meta.stepMs + "ms ×" + report.ticks +
		"  |  bot 步 " + report.meta.botMs + "ms ×" + report.botSteps +
		"  |  种子 " + report.meta.seed);
	console.log("真实耗时: " + (report.wallMs / 1000).toFixed(1) + "s  |  harness boot: " + report.meta.harnessBootMs + "ms");
	console.log("已落地主线层: " + (report.layersLoaded.join(", ") || "（无）") +
		"  |  本次活动层: " + (report.allowedLayers.join(", ") || "（无）"));
	if (report.sideLayers.length) console.log("其它已注册节点: " + report.sideLayers.join(", "));

	line();
	console.log(report.missingFiles.length ? "缺文件（已优雅跳过，不参与模拟）:" : "缺文件: 无");
	for (const f of report.missingFiles) console.log("   · " + f);
	if (report.failedFiles.length) {
		console.log("");
		console.log("加载期报错的文件（队友必须修，sim 已跳过该层继续跑）:");
		for (const f of report.failedFiles) {
			console.log("   ✗ " + f.file + " → " + f.message);
			if (f.frame) console.log("       at " + f.frame);
		}
	} else {
		console.log("加载期报错: 无");
	}
	if (report.warnings.length) {
		console.log("");
		console.log("提示/警告（非致命）:");
		for (const w of report.warnings.slice(0, 12)) console.log("   ! " + w);
		if (report.warnings.length > 12) console.log("   … 其余 " + (report.warnings.length - 12) + " 条");
	}

	// 事件时间线
	line();
	console.log("关键事件时间线（模拟时间；里程碑/升级/自动化为压缩段）:");
	console.log(pad("T", 10) + pad("类别", 14) + "说明");
	line("-");
	const evs = report.events;
	const cap = args.maxEvents || 400;
	const show = evs.length > cap
		? evs.slice(0, Math.floor(cap * 0.6)).concat([{ t: NaN, kind: "…", text: "省略 " + (evs.length - cap) + " 条（--max-events 调整）", detail: "" }]).concat(evs.slice(evs.length - Math.ceil(cap * 0.4)))
		: evs;
	for (const e of show) {
		if (Number.isNaN(e.t)) { console.log(pad("…", 10) + pad(e.kind, 14) + e.text); continue; }
		console.log(pad(fmtClock(e.t), 10) + pad(e.kind, 14) + e.text + (e.detail ? "   ⟵ " + e.detail : ""));
	}
	if (!evs.length) console.log("  （没有任何事件 —— 开局就卡住了）");
	line("-");

	// 曲线
	line();
	console.log("曲线（每 " + report.meta.curveEvery + " 模拟秒一行；数字由引擎 format 给出）:");
	console.log(pad("模拟时间", 10) + pad("热量 points", 15) + pad("炉芯 h", 12) + pad("锭条 m", 12) +
		pad("触媒 r", 12) + pad("时序 t", 12) + pad("星核 x", 12) + pad("热量/秒", 15));
	line("-");
	for (const c of report.curve) {
		console.log(pad(fmtClock(c.t), 10) + pad(c.points, 15) + pad(c.l_h, 12) + pad(c.l_m, 12) +
			pad(c.l_r, 12) + pad(c.l_t, 12) + pad(c.l_x, 12) + pad(c.pointGen, 15));
	}
	line("-");

	// 可达性
	line();
	if (report.deadlock) {
		console.log("可达性检查: ✗ FAIL —— 连续 " + report.meta.deadlockMinutes + " 分钟没有任何资源增长（判定为死锁）");
		console.log("  卡住时刻: " + fmtClock(report.deadlock.at) + "，增长指标自 " + fmtClock(report.deadlock.noGrowthSince) + " 起未变");
		console.log("  growthScore = " + Number(report.deadlock.score).toFixed(3));
		const s = report.deadlock.snap;
		if (s) {
			console.log("  当时热量 = " + s.points + "（" + s.pointGen + "/秒）");
			for (const l of MAIN_LAYERS) {
				const d = s.layers[l];
				if (!d) continue;
				console.log("    " + l + ": points=" + d.points + " total=" + d.total +
					" unlocked=" + (d.unlocked ? "是" : "否") +
					" 升级=[" + d.upgrades.join(",") + "]" +
					" 里程碑=[" + d.milestones.join(",") + "]" +
					(d.resets !== undefined && d.resets !== null ? " 重置=" + d.resets : "") +
					(d.activeChallenge ? " 挑战中=" + d.activeChallenge : ""));
			}
		}
		console.log("  → 定位方法：看上面时间线的最后一条，那就是卡点前最后一次进展。");
	} else {
		console.log("可达性检查: ✓ 全程未出现「连续 " + report.meta.deadlockMinutes + " 分钟零增长」的死锁");
	}

	// 健康
	line();
	console.log("健康检查:");
	console.log("  NaN 扫描      : " + (report.nan.length ? "✗ " + report.nan.length + " 处 → " + report.nan.slice(0, 8).map((n) => n.path + "=" + n.value).join(", ") : "✓ 干净"));
	console.log("  致命/运行期异常: " + (report.errors.fatal.length ? "✗ " + report.errors.fatal.length + " 条" : "✓ 0 条"));
	for (const e of report.errors.fatal.slice(0, 3)) {
		console.log("     ✗ [" + e.severity + "/" + e.type + "] " + (e.file || e.fn || e.where || "") + " " + String(e.message).split("\n")[0]);
		if (e.stack) console.log("         at " + String(e.stack).split("\n")[0].trim());
	}
	if (report.errors.fatal.length > 3) console.log("     … 其余 " + (report.errors.fatal.length - 3) + " 条");
	console.log("  钩子异常（分层未落地导致的正常现象，非致命）: " + (report.errors.hook.length ? "⚠ " + report.errors.hook.length + " 条" : "✓ 0 条"));
	for (const e of report.errors.hook.slice(0, 3)) console.log("     ⚠ " + String(e.message).split("\n")[0].slice(0, 110));
	console.log("  console.error  : " + (report.consoleErrorCount ? "✗ " + report.consoleErrorCount + " 次" : "✓ 0 次"));
	if (report.invariantViolations && report.invariantViolations.length) {
		console.log("  设计不变量被破坏 ✗（持有 unlocked()===false 的升级 —— 互斥路线被同时买走）:");
		for (const iv of report.invariantViolations) {
			console.log("     ✗ " + iv.layer + " #" + iv.id + " " + iv.title + " —— 买入后 unlocked() 已为 false");
		}
		console.log("     原因：引擎 autobuyUpgrades / bot 在同一个 tick 内连买多项，而 tmp[l].upgrades[id].unlocked");
		console.log("           要到下一次 updateTemp 才会变 false，于是互斥的两项都被塞进 player[l].upgrades。");
		console.log("     修法：升级里除了 unlocked()，再加 cost 之外的硬闸门 —— 在 buyUpg 之前由层的");
		console.log("           upgrades[id].pay / canAfford 检查互斥项，或给 doNotCallTheseFunctionsEveryTick 无关，");
		console.log("           最稳的是在 upgrades[id].pay 里 if (hasUpgrade(l, other)) return（付不起=买不到）。");
	} else {
		console.log("  设计不变量      : ✓ 未持有 unlocked()===false 的升级（互斥路线正常）");
	}
	if (report.botErrors && report.botErrors.length) {
		console.log("  bot 内部被吞掉的异常（" + report.botErrors.length + " 类，说明某层的函数假设不成立）:");
		for (const b of report.botErrors.slice(0, 8)) console.log("     ✗ " + b.where + " → " + b.message + (b.count > 1 ? "  ×" + b.count : ""));
	}

	// 平衡
	line();
	console.log("与 DESIGN.md §8 平衡目标对照:");
	console.log("  " + balancePathCaveat(report));
	console.log(pad("阶段", 26) + pad("期望", 20) + pad("实测", 13) + pad("判定", 15) + pad("偏差", 9) + "建议");
	line("-");
	for (const b of report.balance) {
		console.log(pad(b.label, 26) + pad(b.target, 20) + pad(b.actual, 13) + pad(b.status, 15) +
			pad(b.deviation === null ? "—" : b.deviation + "%", 9) + b.suggestion);
	}
	line("-");
	// 判定路径必须打印出来：重定档（judgedBy 非"§8 原文"）不能看起来像原文就达标了
	for (const b of report.balance) {
		if (!b.judgedBy || b.judgedBy === "§8 原文") continue;
		console.log("  ※ " + b.label + "：按「" + b.judgedBy + "」判定（§8 原文是 " + b.target.replace(/（判.*/, "") +
			"）。原因：h.js 把 requires 与 ventSeconds 配套成「第一次满压泄放 ≈ 1 炉芯」，" +
			"首芯不可能早于炉压充满时间，所以不能单改 requires 去凑 15s。");
	}

	// §8.5 数值预算（2026-10-29 修订版：硬约束=不发散，软阈值=仅 WARN，判定看曲线形状）
	line();
	console.log("§8.5 数值预算守卫（修订版）—— 硬约束：全程不得出现 Infinity/NaN；软阈值 1e" + report.meta.budgetExp + "（超出仅 WARN）");
	const infHits = (report.infinityHits || []).concat(report.infinityEvents || []);
	if (infHits.length) {
		console.log("  硬约束 ✗ FAIL —— 检测到非有限值（Infinity/NaN）:");
		for (const h of report.infinityHits.slice(0, 6)) console.log("     ✗ " + h.where + "  [" + h.channel + "]  " + String(h.detail).slice(0, 120));
		for (const e of (report.infinityEvents || []).slice(0, 6)) console.log("     ✗ [" + fmtClock(e.t) + "] " + e.text);
	} else {
		console.log("  硬约束 ✓ 全程无 Infinity、nanScan 干净");
	}
	if (report.budgetSnapshot) {
		const keys = Object.keys(report.budgetSnapshot);
		console.log("  收尾时各乘法通道 log10(foldMult)（软阈值 1e" + report.meta.budgetExp + "）:")
		for (const k of keys) {
			const v = report.budgetSnapshot[k];
			if (v === null || v === undefined) { console.log("    " + pad(k, 14) + pad("非有限", 14) + "✗ 触发硬约束"); continue; }
			console.log("    " + pad(k, 14) + pad("1e" + (v >= 0 ? v.toFixed(2) : v), 14) +
				(v > report.meta.budgetExp ? "⚠ 超软阈值（仅 WARN）" : "✓"));
		}
	}
	if (report.budgetWarnings && report.budgetWarnings.length) {
		console.log("  软阈值告警（不判 FAIL，看下面的曲线形状再定）:");
		for (const e of report.budgetWarnings.slice(0, 4)) {
			console.log("     ⚠ [" + fmtClock(e.t) + "] " + e.text);
			console.log("        归因: " + String(e.detail).slice(0, 260));
		}
	}
	if (report.curveAnalysis) {
		const ca = report.curveAnalysis;
		console.log("  曲线形状判定（§8.5 规则 3：看形状不看绝对值）:");
		console.log("    log10(热量/秒): " + ca.startLog10.toFixed(2) + " → " + ca.endLog10.toFixed(2) +
			"   首段/末段中位斜率 " + ca.slopeFirstThird.toExponential(2) + " / " + ca.slopeLastThird.toExponential(2) +
			(ca.slopeRatio ? "  比值 " + ca.slopeRatio.toFixed(1) + "×" : "") +
			"   末段加速区间 " + ((ca.slopeTailShare || 0) * 100).toFixed(0) + "%" +
			"   采样间距 " + (ca.sampleSpanSec ? ca.sampleSpanSec.toFixed(0) + "s" : "?") +
			(ca.diverged ? "   [检测到 Infinity 采样点]" : ""));
		console.log("    → " + (ca.runaway
			? "✗ 疑似失控：末段整体持续加速（比值 " + (ca.slopeRatio ? ca.slopeRatio.toFixed(1) : "?") + "×、加速区间 " + ((ca.slopeTailShare || 0) * 100).toFixed(0) + "%），不是单次跳档"
			: "✓ 正常增量成长：未见持续加速（单次跳档不计入）"));
	}
	if (report.staticBudgetViolations && report.staticBudgetViolations.length) {
		console.log("  buyable 预算（§8.5 规则 1：per^limit ≤ 1e6）✗ 超出的条目:");
		for (const s of report.staticBudgetViolations) console.log("     ✗ " + s.text);
		console.log("     → 修法：降 per、提单价与上限，而不是提 per。");
	} else {
		console.log("  buyable 预算: ✓ 全部 ≤ 1e6");
	}

	// 大 tick / 离线收益稳健性
	if (report.largeTick) {
		line();
		console.log("大 tick 稳健性（一次跳 " + report.largeTick.hours + " 小时，含离线收益路径）:");
		const lt = report.largeTick;
		const fmtV = (x) => (typeof x === "number" ? (Number.isNaN(x) ? "NaN" : (x === Infinity ? "Inf" : (Math.abs(x) >= 1e6 ? expo(x) : String(Math.round(x * 100) / 100)))) : String(x));
		console.log(pad("", 14) + pad("跳前", 16) + pad("跳后", 16) + "说明");
		for (const k of ["points", "pressure", "ventCd", "vents", "surgeLeft", "surgeCd"]) {
			if (lt.before[k] === null || lt.after[k] === null) continue;
			console.log(pad(k, 14) + pad(fmtV(lt.before[k]), 16) + pad(fmtV(lt.after[k]), 16));
		}
		console.log("  timePlayed 增量: " + (lt.timePlayedDelta === null ? "?" : fmtV(lt.timePlayedDelta)) + " 秒");
		if (lt.ok && !lt.problems.length) console.log("  结果: ✓ 无 NaN、无 Infinity、冷却未被刷穿");
		else {
			console.log("  结果: " + (lt.ok ? "⚠ 有值得注意的现象" : "✗ FAIL"));
			for (const pr of lt.problems) console.log("     · " + pr);
		}
	}

	// 结尾
	line();
	const fs2 = report.finalSnap;
	if (fs2) {
		console.log("最终状态（" + fmtClock(report.simSeconds) + "）: 热量=" + fs2.points + "（" + fs2.pointGen + "/秒）");
		for (const l of MAIN_LAYERS) {
			const d = fs2.layers[l];
			if (!d) { console.log("    " + l + ": 未落地"); continue; }
			console.log("    " + l + ": " + d.points + (d.total ? "（累计 " + d.total + "）" : "") +
				(d.resets !== undefined && d.resets !== null ? " 重置 " + d.resets + " 次" : "") +
				(d.vents !== undefined && d.vents !== null ? " 泄压 " + d.vents + " 次" : "") +
				" 升级 " + d.upgrades.length + " 个 里程碑 " + d.milestones.length + " 个" +
				(d.achievements ? " 铭刻 " + d.achievements + " 条" : "") +
				(d.activeChallenge ? " 挑战中 #" + d.activeChallenge : ""));
		}
		if (Object.keys(fs2.side || {}).length) {
			console.log("    侧层: " + Object.keys(fs2.side).map((k) => k + "(" + (fs2.side[k].unlocked ? "已解锁" : "未解锁") + (fs2.side[k].achievements ? ",铭刻" + fs2.side[k].achievements : "") + ")").join(", "));
		}
	}
	if (report.savedTo) console.log("存档已导出: " + report.savedTo + "（用 --load=" + report.savedTo + " 复现）");
	if (args.constants) printConstants(report.constants || {});
	console.log("");
	console.log("判定: " + report.verdict);
}

// 中英文混排宽度对齐
function pad(s, width) {
	s = String(s === undefined || s === null ? "" : s);
	let w = 0;
	for (const ch of s) w += /[　-〿一-鿿＀-￯]/.test(ch) ? 2 : 1;
	return s + " ".repeat(Math.max(0, width - w));
}

// ---------------------------------------------------------------------------
function main() {
	const args = parseArgs(process.argv.slice(2));
	const report = runSim(args);
	if (args.out) {
		// Node 自己写 UTF-8：PowerShell 的 `>` 会写成 UTF-16，JSON.parse 直接炸
		try {
			fs.writeFileSync(path.resolve(process.cwd(), args.out), JSON.stringify(report, null, 2), "utf8");
			console.log("JSON 报告已写入: " + path.resolve(process.cwd(), args.out));
		} catch (e) {
			console.error("写 JSON 报告失败: " + (e && e.message));
		}
	}
	if (args.report === "json") {
		console.log(JSON.stringify(report, null, 2));
	} else if (args.report !== "none") {
		printTextReport(report, args);
	}
	// 退出码：FAIL(读档)=2（参数问题），其它 FAIL=1，非 FAIL=0
	if (report.verdict.indexOf("FAIL(读档)") === 0) process.exitCode = 2;
	else if (report.verdict.indexOf("FAIL") === 0) process.exitCode = 1;
	else process.exitCode = 0;
}

if (require.main === module) main();

module.exports = { parseArgs, runSim, checkBalance, BALANCE_TARGETS, printTextReport, BOT_SRC, pad, fmtClock };
