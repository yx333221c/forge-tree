// tools/test-side.js —— side-layers 自检（永久保留，只读校验，不改任何 mod 数据）
// 用法：node tools/test-side.js
//
// 做四件事：
//  1) 用 harness 真实加载引擎 + mod 文件（含 js/Forge/ach.js、js/Forge/stats.js）。
//  2) 对每个成就的 done() 求值：确认「不抛异常」且「返回真正的 boolean」。
//     在三种 player 状态下各跑一遍：
//       A. 全新开局（t/x 层缺失或未解锁）
//       B. mock 的中后期（各层字段齐全、有 vents/resets/挑战进度）
//       C. 极端脏数据（字段为 undefined / NaN / 缺层）—— 守卫是否兜住
//  3) 对每个 goalTooltip()/doneTooltip()/effect()/name 求值：确认返回 string / Decimal，不抛。
//  4) 打印「可达成性」逻辑自查表：每个成就依赖哪些字段、这些字段在正常流程里怎么增长。
//
// 用法：node tools/test-side.js          —— 完整自检
//       node tools/test-side.js --probe —— 只跑炉压增长探针（验证成就 44 可达性）
"use strict";

const path = require("path");
const harness = require(path.resolve(__dirname, "harness.js"));

const ACH_IDS = [11, 12, 13, 14, 21, 22, 23, 24, 31, 32, 33, 34, 41, 42, 43, 44];

// 每个成就的依赖与增长路径（供人工/自动审阅）
const REACH = {
	11: { deps: "player.points", grow: "heat 每 tick 由 getPointGen() 连续累加（mod.js §6）；开局 initialStartPoints 已 ≥1" },
	12: { deps: "player.h.total", grow: "doReset('h') → addPoints('h', gain)：首次熔炼（<15s，§8）即 total ≥ 1" },
	13: { deps: "player.m.unlocked", grow: "h 升级/熔炉产出炉芯 → 50 炉芯后锻造一次解锁（§5.2 requires:50，3-8min）" },
	14: { deps: "player.r.unlocked", grow: "锭条 ≥10 后反应一次解锁（§5.3 requires:10，10-20min）" },
	21: { deps: "player.t.unlocked", grow: "触媒 ≥10 后凝时一次解锁（§5.4 requires:10，25-50min）" },
	22: { deps: "player.x.unlocked", grow: "时序 ≥20 后熔星一次解锁（§5.5 requires:20，70-140min）" },
	23: { deps: "player.h.vents", grow: "forgeVent() 每次 vents+1（h.js:495），手动 V 键或 milestone0 自动泄压" },
	24: { deps: "player.h.resets", grow: "h.onPrestige() 每次熔炼 resets+1（h.js:185），自动化后每分钟数十次" },
	31: { deps: "player.h.vents", grow: "同上，累计 50 次泄压（冷却 2s，挂机 autoVent 也能达成）" },
	32: { deps: "任意层 points/total ≥ 1e6", grow: "h.milestone3 就是 1e6 炉芯（§5.1 done(): player.h.points.gte(1e6)）→ 同档可达" },
	33: { deps: "任意层 points/total ≥ 1e7", grow: "炉芯/锭条软上限之后仍继续增长；total 只增不减，1e7 比 1e6 高一档" },
	34: { deps: "achievementCount() ≥ 10", grow: "本文件前 9 枚（11..24/31..33）在正常流程里全部会亮，第 10 枚自然达成" },
	41: { deps: "player.x.ignited", grow: "x clickable11「点燃恒星」（§5.5，2-5h 可达）" },
	42: { deps: "player.points ∈ [1e3,1e5] 且非整数", grow: "热量按 tmp.pointGen×0.05s 连续累加，读数天然是小数；穿过该区间即达成（可反复穿过）" },
	43: { deps: "player.t.activeChallenge ≠ null", grow: "点击任意 t 挑战「Start」即进入（§5.4 六个挑战均可进入）" },
	44: { deps: "player.timePlayed ≥ ACH_BAL.guardSeconds", grow: "引擎 addTime(diff) 每 tick 累加（game.js:345），只增不减、与任何重置无关 → 守炉 30 分钟必然达成。刻意不用炉压当条件：h.js 把炉压 clamp 在 H_BAL.pressureCap（现值 100），绝对阈值会随平衡调整变成 unreachable" },
};

function isDecimal(x) {
	return !!x && typeof x === "object" && typeof x.add === "function" && typeof x.mul === "function"
}

function main() {
	const api = harness.boot({ verbose: false });
	const bootBad = api.bootErrors().filter((e) => /ach\.js|stats\.js/.test(e.file || ""));
	console.log("=== 加载 ===");
	console.log("ach.js / stats.js boot 错误: " + (bootBad.length ? JSON.stringify(bootBad, null, 1) : "无"));
	const layers = api.layers || {};
	if (!layers.ach || !layers.stats) {
		console.log("FATAL: ach/stats 层没有注册");
		process.exit(1);
	}

	const achDef = layers.ach.achievements;
	const ids = Object.keys(achDef).filter((k) => !isNaN(k)).map(Number).sort();
	console.log("成就 id 数: " + ids.length + " → " + ids.join(","));
	api.safe("updateLayers"); // setRowCol 在 setupLayer 里跑，跑完才有 rows/cols
	const achDef2 = api.layers.ach.achievements;
	console.log("rows/cols: " + achDef2.rows + " × " + achDef2.cols + "（期望 4 × 4，即 4 行、列号 1..4）");
	console.log("layer 属性: row=" + layers.ach.row + " type=" + layers.ach.type + " symbol=" + layers.ach.symbol +
		" color=" + layers.ach.color + " resource=" + layers.ach.resource +
		" achievementPopups=" + layers.ach.achievementPopups);
	console.log("stats 属性: row=" + layers.stats.row + " type=" + layers.stats.type + " symbol=" + layers.stats.symbol +
		" color=" + layers.stats.color);
	console.log("HOOKS: " + JSON.stringify(api.HOOKS ? Object.keys(api.HOOKS).map((k) => k + ":" + api.HOOKS[k].length) : null));

	// 缺 id / 多 id 检查
	const miss = ACH_IDS.filter((i) => ids.indexOf(i) < 0);
	const extra = ids.filter((i) => ACH_IDS.indexOf(i) < 0);
	console.log("缺失 id: " + (miss.length ? miss.join(",") : "无") + "　多余 id: " + (extra.length ? extra.join(",") : "无"));

	api.newGame();

	// ---------- 状态 A：全新开局 ----------
	console.log("");
	console.log("=== A. 全新开局（t/x 尚未落地）===");
	runDone(api, "A");
	// 全新开局下把所有 tooltip 也求值一遍：缺层时文本不能抛
	checkTexts(api, "A");

	// ---------- 状态 B：mock 中后期 ----------
	console.log("");
	console.log("=== B. mock 中后期 ===");
	// 用 harness 的 player 结构补齐各层字段（含尚未落地的 t/x），并塞进成就所需进度
	const p = api.player;
	const Dc = api.Decimal;
	const fill = (l, o) => {
		if (!p[l]) p[l] = { upgrades: [], milestones: [], achievements: [], buyables: {}, clickables: {}, challenges: {} };
		const base = {
			unlocked: true, points: new Dc(0), best: new Dc(0), total: new Dc(0),
			resets: new Dc(0), vents: new Dc(0), pressure: new Dc(0), ventCd: new Dc(0),
			activeChallenge: null, challenges: {}, milestones: [], upgrades: [],
		};
		for (const k in base) if (p[l][k] === undefined) p[l][k] = base[k];
		for (const k in o) p[l][k] = o[k];
		// 关键：h/m/r/t/x 在 player 里已经存在但 unlocked=false（全新档），
		// 上面那行只在 undefined 时才写 → 必须显式强制解锁，才能覆盖 done() 的 true 分支。
		p[l].unlocked = true;
	};
	p.points = new Dc("1234.5");                 // 非整数、在 [1e3,1e5] → 42 应达成
	p.timePlayed = 2000;                         // → 44 守炉人（≥ guardSeconds）
	fill("h", { points: new Dc("5e6"), total: new Dc("1e7"), best: new Dc("5e6"), resets: new Dc(150), vents: new Dc(73), pressure: new Dc(100) });
	fill("m", { points: new Dc(2000), total: new Dc("1e5"), best: new Dc(2000), resets: new Dc(40), upgrades: [32] });
	fill("r", { points: new Dc(30), total: new Dc(300), best: new Dc(30), resets: new Dc(12), upgrades: [24] });
	fill("t", { points: new Dc(8), total: new Dc(60), best: new Dc(8), resets: new Dc(5), activeChallenge: 12, challenges: { 11: 1, 12: 0, 13: 1, 14: 0, 15: 0, 16: 0 }, milestones: [0, 1, 2, 3, 4, 5] });
	fill("x", { points: new Dc(3), total: new Dc(3), best: new Dc(3), resets: new Dc(1), ignited: true, milestones: [0, 1] });
	// 34 铭刻十枚：模拟引擎已授予 10 枚（player.ach.achievements 由引擎维护，这里手工塞）
	p.ach.achievements = [11, 12, 13, 14, 21, 22, 23, 24, 31, 32]
	// 让 tmp 认为 t/ach/stats 存在（hasMilestone/hasAchievement 要读 tmp.<layer>.deactivated）
	api.safe("updateLayers");
	api.safe("updateTemp");
	// t/x 层文件还没落地时，tmp.t / tmp.x 可能不存在 → hasMilestone 会抛；我们的守卫必须兜住
	console.log("tmp.t 存在? " + !!api.get("typeof tmp.t !== 'undefined'") + "　tmp.x 存在? " + !!api.get("typeof tmp.x !== 'undefined'"));
	runDone(api, "B");
	// 统一奖励与专属钩子的实际折叠值
	console.log("foldMult('heat') = " + harness.safeStr(api.eval("foldMult('heat',1)")));
	console.log("foldMult('coreGain') = " + harness.safeStr(api.eval("foldMult('coreGain',1)")));
	console.log("achievementCount() = " + api.eval("achievementCount()"));

	// ---------- 状态 C：脏数据 ----------
	console.log("");
	console.log("=== C. 脏数据（字段 undefined / NaN / 缺层）===");
	const keep = JSON.parse(JSON.stringify({ hPoints: String(p.h.points) }));
	p.h.vents = undefined;
	p.h.resets = new Dc(NaN);
	p.t.activeChallenge = "abc";
	p.x.ignited = undefined;
	p.points = new Dc(NaN);
	runDone(api, "C");
	// 还原并确认钩子不会把 NaN 带进折叠
	p.points = new Dc(10);
	p.h.vents = new Dc(0);
	p.h.resets = new Dc(0);
	p.t.activeChallenge = null;
	console.log("还原后 foldMult('heat') = " + harness.safeStr(api.eval("foldMult('heat',1)")));

	// ---------- 文本与布局 ----------
	console.log("");
	console.log("=== 文本 / tabFormat ===");
	checkTexts(api);
	checkTabFormat(api);

	// ---------- 可达成性表 ----------
	console.log("");
	console.log("=== 可达成性自查（依赖字段 → 正常流程里的增长路径）===");
	for (const id of ACH_IDS) {
		const r = REACH[id];
		const name = achDef[id].name;
		console.log("  " + id + " " + name + "｜" + (r ? r.deps : "?") + "｜" + (r ? r.grow : "?"));
	}

	// ---------- 状态 D：真实游戏循环推进（引擎自己授予成就）----------
	progressTest();

	const fatal = api.errors().filter((e) => e.severity !== "hook");
	console.log("");
	console.log("自检结束。非钩子错误总数: " + fatal.length);
	if (fatal.length) console.log(JSON.stringify(fatal.slice(0, 5), null, 1));
}

// 用真实引擎循环验证：done() 在 updateAchievements 里被反复调用不出错，
// 并且 11/12/23/24/42/44 这几枚在正常操作下确实会亮。
function progressTest(hours) {
	console.log("");
	console.log("=== D. 真实游戏循环（引擎自动授予铭刻）===");
	const api = harness.boot({ verbose: false });
	api.newGame();
	const Dc = api.Decimal;
	const p = api.player;

	const got = () => (p.ach ? p.ach.achievements.slice() : []);
	console.log("  t0  points=" + harness.safeStr(p.points) + " 铭刻=" + JSON.stringify(got()));

	// 1) 挂机 20 秒：热量增长 → 11 亮；炉压增长
	harness.advance(api, 20, 50);
	console.log("  +20s points=" + harness.safeStr(p.points) + " pressure=" + harness.safeStr(p.h.pressure) +
		" 铭刻=" + JSON.stringify(got()));

	// 2) 手动泄压一次 → 23 亮
	api.safe("forgeVent");
	api.safe("updateAchievements", "ach");
	console.log("  vent=" + harness.safeStr(p.h.vents) + " 铭刻=" + JSON.stringify(got()));

	// 3) 熔炼 1 次 → 12 亮（走真实 doReset，检验重置不清 side 层）
	p.points = new Dc("1e6");
	api.safe("doReset", "h");
	api.safe("updateAchievements", "ach");
	console.log("  熔炼后 h.points=" + harness.safeStr(p.h.points) + " resets=" + harness.safeStr(p.h.resets) +
		" 铭刻=" + JSON.stringify(got()));

	// 4) 反复熔炼到 100 次 + 泄压到 50+ → 24 / 31 亮；顺便验证 42（非整数热量）
	//    注意：doReset('h') 在 h.js 的 doReset 里会把 pressure 清零，所以 44 必须靠
	//    「只挂机、不熔炼」来达成（第 5 步）；这里只统计 42 的判定次数。
	let exactSeen = 0;
	for (let i = 0; i < 120; i++) {
		p.points = p.points.add(new Dc("12345.678")); // 人造非整数读数，穿过 [1e3,1e5]
		if (api.eval("layers.ach.achievements[42].done()")) exactSeen++;
		api.safe("doReset", "h");
		if (i % 3 === 0) api.safe("forgeVent");
		harness.tick(api, 0.1);
	}
	api.safe("updateAchievements", "ach");
	console.log("  resets=" + harness.safeStr(p.h.resets) + " vents=" + harness.safeStr(p.h.vents) +
		" 42 判定为 true 的次数=" + exactSeen);
	console.log("  铭刻=" + JSON.stringify(got()));

	// 5) 憋压到 500 → 44
	p.h.vents = new Dc(0);
	harness.advance(api, hours === undefined ? 400 : hours * 3600, 50);
	api.safe("updateAchievements", "ach");
	console.log("  挂机后 pressure=" + harness.safeStr(p.h.pressure) + " 铭刻=" + JSON.stringify(got()));

	console.log("  side 层在多次重置后仍是 unlocked=" + p.ach.unlocked +
		"，铭刻数没被清空=" + (got().length > 0));
	console.log("  钩子折叠：heat=" + harness.safeStr(api.eval("foldMult('heat',1)")) +
		" coreGain=" + harness.safeStr(api.eval("foldMult('coreGain',1)")));
	console.log("  stats 读数台渲染（全新档）：" + (function () {
		try {
			const c = api.layers.stats.tabFormat["统计"].content;
			let n = 0;
			for (const it of c) if (Array.isArray(it) && it[0] === "display-text") { it[1](); n++ }
			return n + " 行全部求值成功"
		} catch (e) { return "✗ " + e.message }
	})());
	const d = api.nanScan();
	const fatal = api.errors().filter((e) => e.severity !== "hook")
		.filter((e) => !/t\.js|x\.js/.test(e.file || ""));
	console.log("  NaN 扫描: " + (d.length ? d.map((n) => n.path).join(",") : "干净") +
		"　非钩子错误（排除未落地的 t/x）: " + fatal.length);
	if (fatal.length) console.log(JSON.stringify(fatal.slice(0, 5), null, 1));
}

function runDone(api, tag) {
	const ach = api.layers.ach.achievements;
	let ok = 0, bad = 0, trues = [];
	for (const id of ACH_IDS) {
		const a = ach[id];
		if (!a || typeof a.done !== "function") { console.log("  " + tag + " ✗ " + id + " 没有 done()"); bad++; continue }
		try {
			const v = a.done();
			if (typeof v !== "boolean") {
				console.log("  " + tag + " ✗ " + id + " " + a.name + " → done() 返回 " + (typeof v) + " = " + harness.safeStr(v));
				bad++;
			} else {
				ok++;
				if (v) trues.push(id + a.name);
			}
		} catch (e) {
			console.log("  " + tag + " ✗ " + id + " " + a.name + " → 抛异常: " + e.message);
			bad++;
		}
	}
	console.log("  " + tag + " 结果: boolean " + ok + " / 异常或非布尔 " + bad);
	console.log("  " + tag + " 已达成: " + (trues.length ? trues.join(", ") : "（无）"));
	return { ok, bad };
}

function checkTexts(api, tag) {
	const ach = api.layers.ach.achievements;
	let issues = 0;
	for (const id of ACH_IDS) {
		const a = ach[id];
		if (typeof a.name !== "string" || !a.name) { console.log("  ✗ " + id + " name 不是非空字符串: " + harness.safeStr(a.name)); issues++ }
		for (const key of ["goalTooltip", "doneTooltip"]) {
			const f = a[key];
			if (f === undefined) { console.log("  ✗ " + id + " 缺少 " + key); issues++; continue }
			try {
				const v = (typeof f === "function") ? f() : f;
				if (typeof v !== "string" || !v) { console.log("  ✗ " + id + " " + key + " 返回 " + (typeof v)); issues++ }
			} catch (e) { console.log("  ✗ " + id + " " + key + " 抛异常: " + e.message); issues++ }
		}
		if (a.effect !== undefined) {
			try {
				const v = (typeof a.effect === "function") ? a.effect() : a.effect;
				if (!isDecimal(v)) { console.log("  ✗ " + id + " effect 不是 Decimal: " + harness.safeStr(v)); issues++ }
			} catch (e) { console.log("  ✗ " + id + " effect 抛异常: " + e.message); issues++ }
		}
	}
	console.log((tag || "") + " 成就文本/专属 effect 检查: " + (issues ? issues + " 处问题" : "全部通过") +
		"　带 effect() 的成就: " + ACH_IDS.filter((i) => ach[i].effect !== undefined).join(","));

	if (tag) return // 文本行只在新开局那一轮打印，中后期轮次只复查成就

	// stats 的 display-text 函数（纯读）逐个求值
	const st = api.layers.stats;
	const content = st.tabFormat["统计"].content;
	let rows = 0, serr = 0;
	for (const item of content) {
		if (Array.isArray(item) && item[0] === "display-text") {
			rows++;
			try {
				const v = item[1]();
				if (typeof v !== "string" || !v) { console.log("  ✗ stats display-text 返回 " + (typeof v)); serr++ }
			} catch (e) { console.log("  ✗ stats display-text 抛异常: " + e.message); serr++ }
		}
	}
	console.log("stats display-text 行数: " + rows + "　异常: " + serr);
}

function checkTabFormat(api) {
	const st = api.layers.ach.tabFormat;
	const keys = Object.keys(st);
	console.log("ach 子标签: " + JSON.stringify(keys));
	const content = st[keys[0]].content;
	const bare = content.filter((c) => c === "achievements").length;
	const arr = content.filter((c) => Array.isArray(c) && c[0] === "achievements").length;
	console.log("components: " + content.map((c) => Array.isArray(c) ? c[0] : c).join(" → "));
	console.log("裸 \"achievements\" 组件: " + bare + "　数组形式 [\"achievements\"]: " + arr +
		"（引擎 column 只渲染 length 2/3 的数组，length 1 会被静默丢弃 → 必须用裸字符串）");
	console.log("ach 侧层不含 doReset: " + (api.layers.ach.doReset === undefined ? "OK" : "有！"));
	console.log("stats 侧层不含 doReset: " + (api.layers.stats.doReset === undefined ? "OK" : "有！"));
	console.log("stats layerShown(): " + api.eval("layers.stats.layerShown()"));
}

// ---------------------------------------------------------------------------
// 探针：炉压是否真的能涨到 ACH_BAL.pressureHigh（成就 44 的可达性）
// 关注三件事：压力增速、h.update 的软上限衰减、以及 autoVent 会不会偷偷泄压。
// ---------------------------------------------------------------------------
function pressureProbe(limit) {
	const api = harness.boot({ verbose: false });
	api.newGame();
	const p = api.player;
	const goal = api.eval("ACH_BAL.pressureHigh");
	console.log("=== 炉压探针（目标 " + goal + "）===");
	console.log("开局 autoVent=" + p.h.autoVent + " autoBuy=" + p.h.autoBuy + " autoFill=" + p.h.autoFill +
		"（未解锁里程碑时全为 false，所以挂机不会自动泄压）");
	let stepSec = 60, total = 0
	while (total < (limit || 7200)) {
		harness.advance(api, stepSec, 50)
		total += stepSec
		const pr = api.eval("player.h.pressure.toNumber()")
		console.log("  t=" + total + "s pressure=" + (typeof pr === "number" ? pr.toFixed(1) : harness.safeStr(api.player.h.pressure)) +
			" vents=" + harness.safeStr(p.h.vents) + " pointGen=" + harness.safeStr(api.tmp.pointGen) +
			" 44=" + api.eval("layers.ach.achievements[44].done()"))
		if (api.eval("player.h.pressure.gte(" + goal + ")")) { console.log("  ✓ 达成于 t=" + total + "s"); break }
	}
	if (!api.eval("player.h.pressure.gte(" + goal + ")")) console.log("  ✗ 在 " + total + "s 内未达到 " + goal)
	console.log("  铭刻=" + JSON.stringify(p.ach.achievements))
	const fatal = api.errors().filter((e) => e.severity !== "hook").filter((e) => !/t\.js|x\.js/.test(e.file || ""))
	console.log("  非钩子错误（排除未落地的 t/x）: " + fatal.length)
}

// ---------------------------------------------------------------------------
// 长跑：greedy bot 真实玩 N 分钟，报告「哪些铭刻真的被引擎授予了」
//   这是可达成性的最终证据：不构造状态，只走正常流程。
//   node tools/test-side.js --long=40
// ---------------------------------------------------------------------------
function longRun(minutes) {
	const api = harness.boot({ seed: 1 })
	process.removeAllListeners("uncaughtException")
	process.removeAllListeners("unhandledRejection")
	const ctx = api.ctx
	const vm = require("vm")
	api.newGame()
	vm.runInContext("var __ms = Date.now();\nfunction __tick(d){ __ms += d*1000; player.time = __ms; updateTemp(); gameLoop(d); }", ctx)
	const bot = `(function(){
		for (const L of ["h","m","r","t","x"]) {
			if (!player[L] || !layers[L] || !layers[L].upgrades) continue;
			for (const id in layers[L].upgrades) {
				if (!isNaN(id) && canAffordUpgrade(L,id) && !hasUpgrade(L,id)) buyUpg(L,id);
			}
		}
		for (const L of ["h","m","r"]) {
			if (!player[L] || !layers[L] || !layers[L].buyables) continue;
			for (const id in layers[L].buyables) {
				if (!isNaN(id) && canBuyBuyable(L,id)) { for (let i=0;i<10;i++){ if(!canBuyBuyable(L,id)) break; buyBuyable(L,id); } }
			}
		}
		if (player.h && player.h.unlocked && canVent() && player.h.pressure.gte(H_BAL.pressureCap*0.999)) forgeVent();
		for (const L of ["x","t","r","m","h"]) { if (player[L] && canReset(L)) doReset(L); }
	})()`
	const step = 0.1
	const T = minutes * 60
	let sim = 0, botThrew = null
	while (sim < T) {
		vm.runInContext("__tick(" + step + ")", ctx)
		sim += step
		try { vm.runInContext(bot, ctx) } catch (e) { botThrew = (sim / 60).toFixed(1) + "min: " + e.message; break }
	}
	const got = api.eval("(player.ach.achievements||[]).join(',')")
	const names = api.eval("(player.ach.achievements||[]).map(function(id){return id+':'+layers.ach.achievements[id].name}).join(' | ')")
	console.log("=== 长跑 " + minutes + "min（greedy bot，正常流程）===")
	console.log("  实际游玩时长(timePlayed)=" + api.eval("Math.round(player.timePlayed)") + "s")
	console.log("  已授予铭刻(" + api.eval("(player.ach.achievements||[]).length") + "): " + got)
	console.log("  名称: " + names)
	for (const id of ACH_IDS) {
		const done = api.eval("layers.ach.achievements[" + id + "].done()")
		console.log("    " + id + " " + api.eval("layers.ach.achievements[" + id + "].name") +
			"  done()=" + done + "  已授予=" + api.eval("(player.ach.achievements||[]).indexOf(" + id + ")>=0"))
	}
	console.log("  heat 折叠=" + harness.safeStr(api.eval("foldMult('heat',1)")) +
		" coreGain=" + harness.safeStr(api.eval("foldMult('coreGain',1)")))
	console.log("  NaN: " + JSON.stringify(api.nanScan()).slice(0, 200))
	const errs = api.errors().filter((e) => e.severity !== "hook" && !/Unexpected|Invalid or unexpected/.test(e.message))
	console.log("  运行期错误: " + (errs.length ? errs.map((e) => (e.file || e.fn || "") + "|" + e.message).slice(0, 8).join("  ") : "无"))
	if (botThrew) console.log("  ✗ BOT THREW " + botThrew)
}

// 逐个调用某钩子注册表里的函数，返回 "[名字]=值" 串（逐钩子归因）
function hookReport(ctx, name) {
	const vm2 = require("vm")
	const fn = `(function(n){
		var L = HOOKS[n] || [], o = [];
		for (var i = 0; i < L.length; i++) {
			var src = String(L[i].fn);
			var m = src.match(/function\\s+([A-Za-z0-9_$]+)/);
			var nm = m ? m[1] : src.slice(0, 34).replace(/\\s+/g, " ");
			var v;
			try { v = String(L[i].fn()) } catch (e) { v = "THREW:" + e.message }
			o.push("#" + i + " [" + nm + "]=" + v);
		}
		return o.join("  ");
	})`
	try { return String(vm2.runInContext(fn + "(" + JSON.stringify(name) + ")", ctx)) } catch (e) { return "报告失败: " + e.message }
}

// ---------------------------------------------------------------------------
// 记账模式：greedy bot 真实玩 N 分钟，**记录每一枚铭刻首次被引擎授予的时刻**，
// 并对到点仍未点亮的铭刻打印当前进度（判断「是否永远无法达成」）。
//   node tools/test-side.js --record=240 [--out=log.txt] [--step=100]
//   为节省时间：--step 是模拟步长（毫秒），默认 100ms。
//   挑战处理：凝时解锁后会主动进一个未完成的挑战并停留若干秒，
//   这是成就 43「手中有锁」的正常玩法路径（玩家点 Start 即达成）。
// ---------------------------------------------------------------------------
function recordRun(minutes, opts) {
	opts = opts || {}
	const stepSec = (opts.stepMs || 100) / 1000
	const log = (...a) => console.log(a.join(" "))
	const api = harness.boot({ seed: 7 })
	process.removeAllListeners("uncaughtException")
	process.removeAllListeners("unhandledRejection")
	const ctx = api.ctx
	const vm = require("vm")
	api.newGame()
	vm.runInContext(`
	var __ms = Date.now();
	function __tick(d){ __ms += d*1000; player.time = __ms; updateTemp(); gameLoop(d); }
	`, ctx)

	// bot：买升级/买满 buyable/满压泄压/按门槛重置；进挑战并完成它（覆盖 43 与挑战计数）
	const bot = `(function(){
		for (const L of ["h","m","r","t","x"]) {
			if (!layers[L] || !player[L]) continue;
			for (const id in layers[L].upgrades) { if (!isNaN(id) && canAffordUpgrade(L,id) && !hasUpgrade(L,id)) buyUpg(L,id); }
			for (const id in layers[L].buyables) { if (!isNaN(id) && canBuyBuyable(L,id)) buyBuyable(L,id); }
		}
		if (player.h && player.h.unlocked && canVent() && player.h.pressure.gte(H_BAL.pressureCap*0.999)) forgeVent();
		// 过载（t clickable 11）：就绪就按，正常玩家会这么做
		try { if (player.t && player.t.unlocked && layers.t && layers.t.clickables && layers.t.clickables[11]) { if (tmp.t.clickables[11].canClick) clickClickable("t", 11); } } catch(e){}
		// 挑战：完成可完成的；超时的强制退出，避免卡死
		if (player.t && player.t.unlocked && layers.t && layers.t.challenges) {
			var act = player.t.activeChallenge;
			if (act !== null && act !== undefined && act !== "") {
				var done = false;
				try { done = canCompleteChallenge("t", act); } catch(e){}
				if (done) { startChallenge("t", act); __chalEnterAt = null; }
				else if (__chalEnterAt !== null && player.timePlayed - __chalEnterAt > 600) {
					completeChallenge("t", act);
					Vue.set(player.t, "activeChallenge", null);
					__chalEnterAt = null;
				}
			}
			if (!player.t.activeChallenge && player.timePlayed >= __chalAfter) {
				for (const id in layers.t.challenges) {
					if (isNaN(id)) continue;
					if (maxedChallenge("t", id)) continue;
					try { if (!canEnterChallenge("t", id)) continue; } catch(e){}
					startChallenge("t", id);
					__chalEnterAt = player.timePlayed;
					break;
				}
			}
		}
		if (canReset("h") && tmp.h.resetGain.gte(3)) doReset("h");
		if (canReset("m") && tmp.m.resetGain.gte(2)) doReset("m");
		if (canReset("r") && tmp.r.resetGain.gte(1)) doReset("r");
		if (!player.t || !player.t.activeChallenge) {
			if (canReset("t") && tmp.t.resetGain.gte(1)) doReset("t");
			if (canReset("x") && tmp.x.resetGain.gte(1)) doReset("x");
		}
		// 结局：点燃恒星（x clickable 11）
		try { if (player.x && player.x.unlocked && layers.x.clickables && layers.x.clickables[11]) { if (tmp.x.clickables[11].canClick) clickClickable("x", 11); } } catch(e){}
	})()`
	vm.runInContext("var __chalEnterAt = null;", ctx)
	// 前 60% 的时间不碰挑战（进挑战会清空 row0-2，导致 x 迟迟解锁不了）；
	// 之后正常进挑战——43「手中有锁」只需要「正处于挑战中」这一瞬间。
	vm.runInContext("var __chalAfter = " + Math.floor((opts.chalAfter === undefined ? minutes * 60 * 0.6 : opts.chalAfter)) + ";", ctx)

	const T = minutes * 60
	let sim = 0
	let botThrew = null
	const unlock = {}          // id -> 达成时刻（秒）
	let nextCheck = 0
	let nextMark = 0
	let heatPeak = 0
	const marks = {}
	const heatPeakExpr = "achHeatChannel().toNumber()"
	while (sim < T) {
		try {
			vm.runInContext("__tick(" + stepSec + ")", ctx)
			sim += stepSec
			vm.runInContext(bot, ctx)
		} catch (e) {
			botThrew = (sim / 60).toFixed(2) + "min: " + e.message + " @" + String(e.stack || "").split("\n")[1]
			break
		}
		if (sim >= nextCheck) {
			nextCheck = sim + 2            // 每 2 秒模拟时间检查一次（省开销）
			const cur = String(vm.runInContext("(player.ach.achievements||[]).join(',')", ctx))
			const set = cur ? cur.split(",") : []
			for (const id of set) if (unlock[id] === undefined) unlock[id] = sim
			let hp = 0
			try { hp = Number(vm.runInContext(heatPeakExpr, ctx)) } catch (e) { hp = 0 }
			if (isFinite(hp) && hp > heatPeak) heatPeak = hp
		}
		if (sim >= nextMark) {
			nextMark = sim + 300           // 每 5 分钟一行进度
			for (const [k, e] of [
				["解锁 m", "player.m && player.m.unlocked"],
				["解锁 r", "player.r && player.r.unlocked"],
				["解锁 t", "player.t && player.t.unlocked"],
				["解锁 x", "player.x && player.x.unlocked"],
				["点燃", "player.x && player.x.ignited"],
			]) if (marks[k] === undefined) { try { if (vm.runInContext("!!(" + e + ")", ctx) === true) marks[k] = sim } catch (x) { } }
			log("[进度] " + (sim / 60).toFixed(1) + "min 热量=" + String(vm.runInContext("String(tmp.pointGen)", ctx)) +
				"/s 铭刻=" + String(vm.runInContext("(player.ach.achievements||[]).length", ctx)) +
				" heat通道=" + String(vm.runInContext("String(achHeatChannel())", ctx)) +
				" 熔炼=" + String(vm.runInContext("String(player.h.resets)", ctx)) +
				" 泄压=" + String(vm.runInContext("String(player.h.vents)", ctx)) +
				" 挑战=" + String(vm.runInContext("String(completedChallengeCount())", ctx)))
		}
	}
	// 收尾：再跑一次 updateAchievements，把最后时刻点亮的补进表里
	try { vm.runInContext("updateAchievements('ach')", ctx) } catch (e) { }
	const finalList = String(vm.runInContext("(player.ach.achievements||[]).join(',')", ctx)).split(",").filter(Boolean)
	for (const id of finalList) if (unlock[id] === undefined) unlock[id] = sim

	log("=== 记账跑 " + minutes + "min（step " + (stepSec * 1000) + "ms，seed 7）===")
	log("实际模拟时长 timePlayed=" + Math.round(vm.runInContext("player.timePlayed", ctx)) + "s")
	log("事件时刻: " + Object.keys(marks).map((k) => k + " @ " + (marks[k] / 60).toFixed(2) + "min").join("　"))
	const done = []
	const undone = []
	for (const id of ACH_IDS) {
		const name = vm.runInContext("layers.ach.achievements[" + id + "].name", ctx)
		if (unlock[String(id)] !== undefined) done.push(id + " " + name + " @ " + (unlock[String(id)] / 60).toFixed(2) + " min")
		else undone.push({ id, name })
	}
	log("已点亮(" + done.length + "/" + ACH_IDS.length + "):")
	done.forEach((d) => log("  ✓ " + d))
	log("未点亮(" + undone.length + ") —— 附当前进度，用于判断是否 unreachable:")
	for (const u of undone) {
		let prog = "?"
		try { prog = String(vm.runInContext("String(layers.ach.achievements[" + u.id + "].goalTooltip()).replace(/<[^>]*>/g,'')", ctx)) } catch (e) { prog = "goalTooltip 求值失败: " + e.message }
		log("  ✗ " + u.id + " " + u.name + " ｜ " + prog.replace(/\s+/g, " ").slice(0, 220))
	}
	log("ach heat 通道峰值 = " + heatPeak + "（预算 " + vm.runInContext("ACH_BAL.budgetHeat", ctx) + "）")
	log("ach heat 全满理论值 = " + String(vm.runInContext("String(achFullHeatBudget())", ctx)))
	log("heat 钩子逐项归因:")
	log("  " + hookReport(ctx, "heat"))
	log("coreGain 钩子逐项归因:")
	log("  " + hookReport(ctx, "coreGain"))
	log("层解锁时刻: " + String(vm.runInContext(`(function(){var o=[];['h','m','r','t','x'].forEach(function(l){o.push(l+"="+(player[l]&&player[l].unlocked?"已解锁":"未"))});return o.join(" ")})()`, ctx)))
	log("资源: " + String(vm.runInContext(`(function(){var o=[];['h','m','r','t','x'].forEach(function(l){o.push(l+" total="+(player[l]&&player[l].total?String(player[l].total):"-"))});o.push("vents="+String(player.h.vents));o.push("resets="+String(player.h.resets));o.push("challenges="+String(completedChallengeCount()));o.push("ignited="+String(!!player.x.ignited));return o.join(" | ")} )()`, ctx)))
	log("NaN: " + JSON.stringify(api.nanScan()).slice(0, 200))
	const errs = api.errors().filter((e) => e.severity !== "hook" && !/Unexpected|Invalid or unexpected/.test(e.message))
	log("运行期错误: " + (errs.length ? errs.map((e) => (e.file || e.fn || "") + "|" + e.message).slice(0, 10).join("  ") : "无"))
	log("钩子错误(非致命): " + api.hookErrors().length)
	if (botThrew) log("✗ BOT THREW " + botThrew)
	log("=== 记账跑结束 ===")
}

if (process.argv.includes("--probe")) {
	let minutes = 120
	for (const a of process.argv) if (a.indexOf("--minutes=") === 0) minutes = Number(a.slice(10)) || 120
	pressureProbe(minutes * 60)
} else if (process.argv.some((a) => a.indexOf("--record=") === 0)) {
	const arg = process.argv.find((a) => a.indexOf("--record=") === 0)
	let stepMs = 100
	for (const a of process.argv) if (a.indexOf("--step=") === 0) stepMs = Number(a.slice(7)) || 100
	recordRun(Number(arg.slice(9)) || 240, { stepMs })
} else if (process.argv.some((a) => a.indexOf("--long=") === 0)) {
	const arg = process.argv.find((a) => a.indexOf("--long=") === 0)
	longRun(Number(arg.slice(7)) || 30)
} else {
	main()
}

