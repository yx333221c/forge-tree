// tools/harness.js —— Node 端引擎/浏览器桩
// 作用：在 Node 的 vm 沙箱里按 index.html 的顺序加载真实引擎脚本 + mod 脚本，
//       提供最小 DOM/浏览器桩，使游戏逻辑（不含渲染）可以在无浏览器环境下运行。
// 只使用 Node 内置模块：fs / path / vm（Buffer 是 Node 全局）。
// 用法见 tools/README.md。
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

// 仓库根目录（tools/ 的上一级）
const ROOT = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// 加载顺序：复刻 index.html 的 <script> 顺序 + loader.js 注入的 modFiles
//
// 【坑 1｜动态脚本的执行时机】index.html 里 loader.js 用 document.createElement("script")
// 动态插入 modFiles。动态脚本即使 async=false 也要先经历 fetch，因此它的实际执行时机
// 晚于 index.html 中所有 parser-blocking 的静态脚本（含 NumberFormating.js / save.js）。
// 浏览器里的真实顺序是：静态引擎脚本 → modFiles（helpers.js 在最前）。
// js/Forge/h.js 能在 addLayer() 的对象字面量里直接调用 format()，靠的就是这一点。
// 若把 modFiles 紧跟 mod.js 执行，就会报 "format is not defined"。
// 需要诊断「加载期依赖引擎尾部函数」时，传 opts.strictIndexOrder = true 复现理论顺序。
// ---------------------------------------------------------------------------
const ENGINE_HEAD = [
	"js/technical/break_eternity.js",
	"js/technical/layerSupport.js",
];
// loader.js 本身只插入 <script> 标签，harness 里等价执行（不产生状态）
const ENGINE_TAIL = [
	"js/technical/temp.js",
	"js/technical/displays.js",
	"js/game.js",
	"js/utils.js",
	"js/utils/easyAccess.js",
	"js/technical/systemComponents.js",
	"js/components.js",
	"js/technical/canvas.js",
	"js/technical/particleSystem.js",
	"js/utils/NumberFormating.js",
	"js/utils/options.js",
	"js/utils/save.js",
	"js/utils/themes.js",
];
// 兼容旧命名（外部脚本可能引用）
const BEFORE_MOD = ENGINE_HEAD;
const AFTER_MODFILES = ENGINE_TAIL;

// ---------------------------------------------------------------------------
// base64：save.js 用了 btoa/atob，vm 默认没有
// ---------------------------------------------------------------------------
function makeBtoa() {
	return function btoa(bin) {
		return Buffer.from(String(bin), "binary").toString("base64");
	};
}
function makeAtob() {
	return function atob(str) {
		return Buffer.from(String(str), "base64").toString("binary");
	};
}

// ---------------------------------------------------------------------------
// 确定性随机数（mulberry32）：sim 需要可复现
// ---------------------------------------------------------------------------
function makeRng(seed) {
	let a = (seed >>> 0) || 1;
	return function random() {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// ---------------------------------------------------------------------------
// DOM / 浏览器桩
// ---------------------------------------------------------------------------
// 引擎里真正会执行到的 DOM 访问只有：
//   document.createElement / head.insertBefore / getElementById(→null) /
//   body.style.setProperty / body.appendChild|removeChild / execCommand /
//   activeElement.blur / onkeydown|onkeyup / title
//   window.addEventListener / innerWidth / innerHeight / location.reload / onbeforeunload / open
//   localStorage.getItem|setItem|removeItem（save.js）
//   Vue.set / Vue.delete / Vue.component / new Vue({...})（load() 会调 loadVue）
//   btoa / atob（escape/unescape 是 vm 内置的，无需桩）
// canvas 与粒子系统因为 getElementById 返回 null / getContext 返回 null 而提前 return。
function makeElementStub() {
	const style = {
		setProperty() {},
		removeProperty() {},
		getPropertyValue() { return ""; },
	};
	return {
		style,
		classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
		setAttribute() {},
		getAttribute() { return null; },
		removeAttribute() {},
		insertBefore() {},
		appendChild() {},
		removeChild() {},
		select() {},
		setSelectionRange() {},
		focus() {},
		blur() {},
		addEventListener() {},
		removeEventListener() {},
		getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }; },
		value: "",
		textContent: "",
		innerHTML: "",
		href: "",
		width: 0,
		height: 0,
		scrollTop: 0,
		scrollLeft: 0,
		// canvas 元素才会用到；返回 null 让 resizeCanvas/drawTree 提前退出
		getContext() { return null; },
	};
}

function makeDomStub(state) {
	const lsStore = Object.create(null);
	const localStorage = {
		_m: lsStore,
		getItem(k) {
			const key = String(k);
			return Object.prototype.hasOwnProperty.call(lsStore, key) ? lsStore[key] : null;
		},
		setItem(k, v) { lsStore[String(k)] = String(v); },
		removeItem(k) { delete lsStore[String(k)]; },
		clear() { for (const k in lsStore) delete lsStore[k]; },
		get length() { return Object.keys(lsStore).length; },
	};

	const document = {
		createElement: () => makeElementStub(),
		head: { insertBefore() {}, appendChild() {}, removeChild() {} },
		body: {
			appendChild() {},
			removeChild() {},
			style: { setProperty() {}, removeProperty() {} },
			scrollLeft: 0,
			scrollTop: 0,
		},
		documentElement: { style: { setProperty() {} } },
		// 返回 null：canvas/tab 相关函数全部提前 return，模拟"页面还没渲染"
		getElementById() { return null; },
		querySelector() { return null; },
		querySelectorAll() { return []; },
		addEventListener() {},
		removeEventListener() {},
		execCommand() { return true; },
		activeElement: { blur() {}, focus() {}, value: "" },
		onkeydown: null,
		onkeyup: null,
		title: "",
	};

	const window = {
		innerWidth: 1600,
		innerHeight: 900,
		devicePixelRatio: 1,
		location: {
			href: "file:///" + ROOT.replace(/\\/g, "/") + "/index.html",
			reload() { state.reloadRequested = true; },
		},
		addEventListener() {},
		removeEventListener() {},
		open() { return null; },
		scrollTo() {},
		document,
		localStorage,
		onbeforeunload: null,
	};

	// Vue 桩：只接受注册，不做渲染
	function Vue(options) {
		state.vueInstances.push(options || {});
		return { $el: null, $mount() { return this; }, _data: (options && options.data) || {} };
	}
	Vue.set = function set(obj, key, val) {
		if (obj === undefined || obj === null) return val;
		obj[key] = val;
		return val;
	};
	Vue.delete = function del(obj, key) {
		if (obj === undefined || obj === null) return;
		if (Array.isArray(obj)) obj.splice(Number(key), 1);
		else delete obj[key];
	};
	Vue.component = function () {};
	Vue.mixin = function () {};
	Vue.directive = function () {};
	Vue.filter = function () {};
	Vue.use = function () {};
	Vue.observable = (o) => o;
	Vue.nextTick = (f) => { if (typeof f === "function") f(); };
	Vue.version = "2.7.16-stub";
	Vue.config = { performance: false, productionTip: false };

	const navigator = {
		clipboard: { writeText() { return Promise.resolve(); } },
		userAgent: "node-harness",
		language: "zh-CN",
	};

	return { document, window, localStorage, Vue, navigator };
}

// ---------------------------------------------------------------------------
// console 桩：把游戏侧输出收进 state.errors（按严重级别分类）
// ---------------------------------------------------------------------------
// severity 约定：
//   "hook"     —— helpers.js 的 _hookValue 吞掉的钩子异常（开发期分层缺失的正常现象）
//   "console"  —— 游戏自己打的 console.warn/error，不一定是错
//   "runtime"  —— 真实运行期异常
//   "load"     —— 脚本加载/执行期异常（boot 期）
function classifyMessage(message) {
	if (/Forge hook failed/i.test(message)) return "hook";
	return null;
}

function makeConsole(state) {
	const push = (level, args) => {
		const message = args.map((a) => {
			if (a instanceof Error) return (a.stack || a.message);
			if (typeof a === "string") return a;
			try { return String(a); } catch (e) { return Object.prototype.toString.call(a); }
		}).join(" ");
		const tagged = classifyMessage(message);
		if (level === "error") {
			state.consoleErrorCount++;
			recordError(state, {
				severity: tagged || "console",
				type: "console.error",
				message,
				stack: firstFrames(new Error("console.error").stack, 2),
			});
		} else if (level === "warn") {
			recordError(state, { severity: tagged || "console", type: "console.warn", message, stack: "" });
		}
		state.logBuffer.push([level, message]);
	};
	return {
		log(...a) { state.consoleLogCount++; if (state.verbose) console.log("[game]", ...a); },
		info(...a) { if (state.verbose) console.info("[game]", ...a); },
		debug(...a) { if (state.verbose) console.debug("[game]", ...a); },
		warn(...a) { push("warn", a); if (state.verbose) console.warn("[game]", ...a); },
		error(...a) { push("error", a); if (state.verbose) console.error("[game]", ...a); },
		trace(...a) { state.consoleLogCount++; if (state.verbose) console.trace("[game]", ...a); },
		group() {}, groupEnd() {}, table() {}, dir() {},
		assert() {}, time() {}, timeEnd() {}, count() {},
	};
}

// 取栈的前 n 帧（跳过 "Error" 那一行）
function firstFrames(stack, n) {
	if (!stack) return "";
	const lines = String(stack).split("\n").filter((l) => l.trim() && l.trim().indexOf("Error") !== 0);
	return lines.slice(0, n).join("\n");
}

// ---------------------------------------------------------------------------
// 上下文构造
// ---------------------------------------------------------------------------
function createContext(opts = {}) {
	const state = {
		nowMs: (opts.startMs !== undefined ? opts.startMs : 1700000000000), // 虚拟时钟（毫秒）
		errors: [],          // 全部错误（boot + 运行期 + console），带 severity
		bootErrors: [],      // 脚本加载期错误（= failedFiles 的镜像）
		runtimeErrors: [],   // advance/tick 期间的异常
		hookErrors: [],      // 钩子异常（非致命）
		errorIndex: new Map(), // 错误指纹 -> 记录（用于去重）
		warnings: [],        // 缺文件之类的提示
		missingFiles: [],    // 相对路径
		loadedFiles: [],     // 已成功执行的相对路径（按顺序）
		failedFiles: [],     // {file, message, stack}
		consoleErrorCount: 0,
		consoleLogCount: 0,
		alerts: [],
		prompts: [],
		confirmCount: 0,
		reloadRequested: false,
		vueInstances: [],
		logBuffer: [],
		verbose: !!opts.verbose,
		seed: opts.seed === undefined ? 1 : opts.seed >>> 0,
		ticks: 0,
	};

	const dom = makeDomStub(state);

	// Date.now() 走虚拟时钟（引擎用 Date.now() 计算 diff 与离线时间）；其余 Date 行为保持原生
	const RealDate = Date;
	const DateStub = new Proxy(RealDate, {
		get(target, prop) {
			if (prop === "now") return () => state.nowMs;
			const v = Reflect.get(target, prop);
			return typeof v === "function" ? v.bind(target) : v;
		},
		apply(target, thisArg, args) { return Reflect.apply(target, thisArg, args); },
		construct(target, args) { return Reflect.construct(target, args); },
	});

	const sandbox = {
		// ★★★ 坑 2（最致命）：绝对不要把宿主的内建对象塞进 sandbox ★★★
		// 不要注入 Object / Array / Math / JSON / Error / isNaN / isFinite / String / Number /
		// Boolean / RegExp / parseFloat / parseInt —— vm.createContext 自带 context 自己的内建对象。
		// 一旦用宿主 realm 的同名对象覆盖，引擎里这些判定全部失效：
		//   temp.js:    layerData[item].constructor === Object
		//   utils.js:   isPlainObject(obj) => obj.constructor === Object
		// 后果：setupTempData 走最后的 else 分支 → tmp.h === layers.h（tmp 直接引用 layers），
		// updateTemp 往 tmp[layer] 写 resetGain/notify/prestigeNotify 时把 layers 写脏，
		// 于是 prestigeNotify() 读到 undefined 并当函数调用 → 报出与真相无关的假错误。
		// 同理不要写 globalThis: undefined（会覆盖 vm 内建的 globalThis，break_eternity 的 UMD 会炸）。
		console: makeConsole(state),
		document: dom.document,
		window: dom.window,
		localStorage: dom.localStorage,
		Vue: dom.Vue,
		navigator: dom.navigator,
		Date: DateStub,           // 只有 Date 需要覆盖（虚拟时钟），它是函数对象，引擎不做 constructor 比较
		btoa: makeBtoa(),
		atob: makeAtob(),
		// 定时器：一律不执行真实回调，游戏循环由 harness.tick/advance 手动驱动（确定性）
		setInterval: () => 0,
		clearInterval: () => {},
		setTimeout: () => 0,
		clearTimeout: () => {},
		requestAnimationFrame: () => 0,
		cancelAnimationFrame: () => {},
		getComputedStyle: () => ({ getPropertyValue: () => "", setProperty: () => {} }),
		Image: function Image() { this.onload = null; this.onerror = null; this.width = 0; this.height = 0; },
		confirm: (msg) => { state.confirmCount++; state.logBuffer.push(["confirm", msg]); return opts.autoConfirm !== false; },
		prompt: (msg) => { state.prompts.push(msg); return null; },
		alert: (msg) => { state.alerts.push(msg); state.logBuffer.push(["alert", msg]); },
		// harness 自身状态（不可枚举，避免被引擎的 for...in 遍历到）
		__HARNESS_STATE__: state,
		require: undefined,
		process: undefined,
		module: undefined,
		exports: undefined,
		Buffer: undefined,
		fetch: undefined,
	};

	const ctx = vm.createContext(sandbox, {
		name: "tmt-forge-harness",
		codeGeneration: { strings: true, wasm: false },
	});
	Object.defineProperty(sandbox, "__HARNESS_STATE__", { enumerable: false, writable: true, configurable: true });

	setSeed(ctx, state.seed);
	return { ctx, state };
}

// 注入种子随机：在 context 内部覆盖 Math.random（Math 是 context 自己的内建对象，可写）
function setSeed(ctx, seed) {
	const rng = makeRng(seed);
	Object.defineProperty(ctx, "__HARNESS_RANDOM__", { value: rng, enumerable: false, writable: true, configurable: true });
	vm.runInContext("Math.random = globalThis.__HARNESS_RANDOM__;", ctx);
	if (ctx.__HARNESS_STATE__) ctx.__HARNESS_STATE__.seed = seed >>> 0;
	return rng;
}

// ---------------------------------------------------------------------------
// 【坑 3】let/const 顶层绑定不是 vm context 的属性
// vm.runInContext('var vv=1; let ll=2;', c) → c.vv === 1，但 c.ll === undefined。
// 引擎里这些关键全局恰好是 let/const：
//   js/utils/options.js: let options = {}
//   js/mod.js:           let modInfo / let changelog / let winText
//   js/utils/save.js:    let getModID = () => ...
// 所以取它们必须用 get(ctx, "options")，绝不能写 ctx.options。
// 另外 options 会被 loadOptions() 用 Object.assign 重新赋值，缓存引用会失效 → 每次现取。
// var 声明的（player/tmp/layers/Decimal/VERSION…）可以直接用 ctx.xxx。
// ---------------------------------------------------------------------------
function get(ctx, expr) {
	try {
		return vm.runInContext(expr, ctx);
	} catch (e) {
		return undefined;
	}
}
// 抛出异常的版本（sim 需要知道到底炸在哪）
function evalThrow(ctx, expr) {
	return vm.runInContext(expr, ctx);
}

// ---------------------------------------------------------------------------
// 文件读取与执行
// ---------------------------------------------------------------------------
function readScript(rel) {
	return fs.readFileSync(path.join(ROOT, rel), "utf8");
}
function exists(rel) {
	return fs.existsSync(path.join(ROOT, rel));
}

function runScript(ctx, rel, state, tag) {
	const label = tag || rel;
	try {
		const src = readScript(rel);
		vm.runInContext(src, ctx, { filename: rel, lineOffset: 0, displayErrors: true, timeout: 60000 });
		state.loadedFiles.push(label);
		return true;
	} catch (e) {
		const rec = {
			file: label,
			message: (e && e.message) || String(e),
			stack: (e && e.stack) || "",
			frame: firstFrames((e && e.stack) || "", 1),
		};
		state.failedFiles.push(rec);
		recordError(state, { severity: "load", type: "load-error", file: label, message: rec.message, stack: rec.frame });
		return false;
	}
}

// 扫描 js/Forge 目录：helpers.js 永远排在各层之前
function scanForgeFiles() {
	const dir = path.join(ROOT, "js", "Forge");
	const EXPECT = ["helpers.js", "h.js", "m.js", "r.js", "t.js", "x.js", "ach.js", "stats.js"];
	if (!fs.existsSync(dir)) {
		return { present: [], absent: EXPECT.map((f) => "js/Forge/" + f) };
	}
	const names = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".js")).sort();
	const present = names.map((f) => "js/Forge/" + f);
	const absent = EXPECT.filter((f) => !names.includes(f)).map((f) => "js/Forge/" + f);
	present.sort((a, b) => {
		const ah = /helpers\.js$/i.test(a) ? 0 : 1;
		const bh = /helpers\.js$/i.test(b) ? 0 : 1;
		return ah - bh || a.localeCompare(b);
	});
	return { present, absent };
}

function sortWithHelpersFirst(list) {
	const isHelper = (f) => /helpers\.js$/i.test(f);
	return list.filter(isHelper).concat(list.filter((f) => !isHelper(f)));
}

// ---------------------------------------------------------------------------
// boot：加载全部脚本，返回 api
// ---------------------------------------------------------------------------
function boot(opts = {}) {
	const made = createContext(opts);
	const ctx = made.ctx;
	const state = made.state;
	const t0 = Date.now();

	// 1) 引擎头部
	for (const rel of ENGINE_HEAD) {
		if (!exists(rel)) { noteMissing(state, rel, "缺少引擎文件: " + rel); continue; }
		runScript(ctx, rel, state);
	}

	// 2) mod.js
	if (exists("js/mod.js")) {
		runScript(ctx, "js/mod.js", state);
	} else {
		noteMissing(state, "js/mod.js", "缺少 js/mod.js：无法读取 modFiles");
	}

	// 3) 解析 modFiles（必须走 get()：modInfo 是 let 声明）
	let modFiles = get(ctx, "(typeof modInfo !== 'undefined' && modInfo && modInfo.modFiles) ? modInfo.modFiles.slice() : []");
	if (!Array.isArray(modFiles)) modFiles = [];
	const forge = scanForgeFiles();
	let loadList = modFiles.map((f) => String(f)).map((f) => (f.indexOf("js/") === 0 ? f : "js/" + f));
	loadList = sortWithHelpersFirst(loadList);

	// 优雅降级：mod.js 还没写 Forge 文件，但磁盘上已有 → 自动追加并警告
	if (opts.loadForge !== false && !loadList.some((f) => f.indexOf("Forge") >= 0) && forge.present.length) {
		state.warnings.push("提示：modInfo.modFiles 尚未包含 js/Forge/*.js（mod.js 还没更新），harness 已自动追加这些文件");
		loadList = sortWithHelpersFirst(loadList.concat(forge.present));
	}
	// modFiles 声明了但磁盘没有 → 缺文件
	for (const f of loadList) {
		if (!exists(f)) noteMissing(state, f, "缺文件（modFiles 已声明但磁盘没有，已跳过）: " + f);
	}
	// Forge 期望清单里还没落地的文件（即使 modFiles 还没列）
	for (const f of forge.absent) {
		if (state.missingFiles.indexOf(f) < 0) noteMissing(state, f, "缺文件（Forge 目录尚未落地）: " + f);
	}

	const runEngineTail = () => {
		for (const rel of ENGINE_TAIL) {
			if (!exists(rel)) { noteMissing(state, rel, "缺少引擎文件: " + rel); continue; }
			runScript(ctx, rel, state);
		}
	};
	const runModFiles = () => {
		const done = [];
		for (const rel of loadList) {
			if (!exists(rel)) continue;
			if (runScript(ctx, rel, state, rel)) done.push(rel);
		}
		return done;
	};

	// 4) 按浏览器真实时机执行（默认：引擎尾部 → modFiles）
	if (opts.strictIndexOrder) {
		state.warnings.push("strictIndexOrder：按 index.html 字面顺序执行（modFiles 在引擎尾部脚本之前），用于暴露「加载期调用引擎尾部函数」的问题");
		runModFiles();
		runEngineTail();
	} else {
		runEngineTail();
		runModFiles();
	}
	state.modFiles = loadList;
	state.executedModFiles = state.loadedFiles.filter((f) => loadList.indexOf(f) >= 0);

	if (opts.catchUncaught !== false) installUncaughtHook(state);

	const api = makeApi(ctx, state, opts);
	api.loadOrder = state.loadedFiles.slice();
	api.bootMs = Date.now() - t0;
	return api;
}

function noteMissing(state, file, message) {
	if (state.missingFiles.indexOf(file) < 0) state.missingFiles.push(file);
	if (state.warnings.indexOf(message) < 0) state.warnings.push(message);
}

function installUncaughtHook(state) {
	if (state.__uncaughtInstalled) return;
	if (typeof process === "undefined" || !process.on) return;
	const handler = (err) => {
		recordError(state, { severity: "runtime", type: "uncaughtException", message: (err && err.message) || String(err), stack: firstFrames((err && err.stack) || "", 3) });
	};
	process.on("uncaughtException", handler);
	process.on("unhandledRejection", (reason) => {
		recordError(state, { severity: "runtime", type: "unhandledRejection", message: (reason && reason.message) || String(reason), stack: firstFrames((reason && reason.stack) || "", 3) });
	});
	state.__uncaughtInstalled = true;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
function makeApi(ctx, state, opts) {
	// var 声明的全局可以直接取；let/const 必须走 get()
	const api = {
		ctx,
		state,
		get: (expr) => get(ctx, expr),
		eval: (expr) => evalThrow(ctx, expr),

		// —— var 声明的引擎全局 ——
		get player() { return ctx.player; },
		get tmp() { return ctx.tmp; },
		get layers() { return ctx.layers; },
		get Decimal() { return ctx.Decimal; },
		// —— let/const 声明的引擎全局：必须每次现取 ——
		get options() { return get(ctx, "options"); },
		get modInfo() { return get(ctx, "modInfo"); },
		get VERSION() { return get(ctx, "VERSION"); },
		get layoutInfo() { return get(ctx, "layoutInfo"); },
		get LAYERS() { return get(ctx, "LAYERS"); },
		get TREE_LAYERS() { return get(ctx, "TREE_LAYERS"); },
		get OTHER_LAYERS() { return get(ctx, "OTHER_LAYERS"); },
		get HOOKS() { return get(ctx, "(typeof HOOKS !== 'undefined') ? HOOKS : null"); },
		get modID() { return get(ctx, "(typeof getModID === 'function') ? getModID() : null"); },

		fn(name) {
			const v = (typeof ctx[name] !== "undefined") ? ctx[name] : get(ctx, name);
			return v;
		},
		// 安全调用引擎函数：异常记进 runtimeErrors
		// 去重：同一个 (调用点, 消息) 只记一条并累加 count。
		// 否则 ach/stats 这类侧层每 tick 抛一次，2 小时模拟会刷出几十万条错误、
		// 直接把内存吃掉，还把真正的卡点埋在噪声里。
		safe(name, ...args) {
			const f = api.fn(name);
			if (typeof f !== "function") {
				recordError(state, { severity: "runtime", type: "missing-fn", fn: name, message: "引擎函数不存在: " + name, stack: "" });
				return undefined;
			}
			try {
				return f(...args);
			} catch (e) {
				recordError(state, {
					severity: classifySeverity(e) || "runtime",
					type: "runtime",
					fn: name,
					message: (e && e.message) || String(e),
					stack: firstFrames((e && e.stack) || "", 3),
				});
				return undefined;
			}
		},
		callGameLoop(diff) { return api.safe("gameLoop", diff); },
		callUpdateTemp() { return api.safe("updateTemp"); },

		// —— 虚拟时钟 ——
		now: () => state.nowMs,
		setTime(ms) { state.nowMs = ms; },
		advanceTime(ms) { state.nowMs += ms; },

		// —— 生命周期 ——
		load: () => api.safe("load"),
		save: () => api.safe("save", true),
		// 全新开局：清存档 + 复位时钟 + 复位 NaNalert，然后交给引擎自己的 load()
		// 注意：不要在 load() 之前调 setupTemp —— 那时 player 还不存在，setupTemp 会抛
		//       "Cannot read properties of undefined (reading 'points')"，
		//       并且连带产生一个假的 "prestigeNotify is not a function"（tmp 已被写脏）。
		//       load() 内部已经做了 updateLayers/setupModInfo/setupTemp/updateTemp×2/updateTabFormats/loadVue。
		newGame: () => {
			const id = api.modID;
			if (id && ctx.localStorage) {
				try {
					ctx.localStorage.removeItem(id);
					ctx.localStorage.removeItem(id + "_options");
				} catch (e) { /* ignore */ }
			}
			state.nowMs = (opts.startMs === undefined ? 1700000000000 : opts.startMs);
			ctx.player = undefined;   // var player → context 属性，可以这样置空
			ctx.NaNalert = false;     // var NaNalert（temp.js）
			vm.runInContext("try { NaNalert = false } catch (e) {}", ctx);
			api.safe("load");
			return ctx.player;
		},
		// 从 JSON 字符串（JSON.stringify(player) 的结果）恢复
		loadSaveJson: (json) => {
			const id = api.modID;
			if (!id) { state.warnings.push("loadSaveJson: 取不到 modID"); return undefined; }
			// 先把虚拟时钟对齐到存档的 player.time，再交给引擎 load()。
			// 原因：save.js 的 load() 会算 `offTime.remain += (Date.now() - player.time)/1000`。
			// 存档里的 player.time 是"上次跑到的虚拟时刻"，而新 boot 的 Date.now() 从起点重新开始，
			// 两者差几万秒 → remain 变成巨大负数（读起来像"离线收益被吞了"，其实是时钟没对上）。
			try {
				const meta = JSON.parse(json);
				if (meta && typeof meta.time === "number" && isFinite(meta.time) && meta.time > state.nowMs) {
					state.nowMs = meta.time;
				}
			} catch (e) { /* 解析不了就按原样 load，让引擎自己兜 */ }
			// save.js 的读取端是 JSON.parse(decodeURIComponent(escape(atob(get))))，
			// 所以写入必须是 btoa(unescape(encodeURIComponent(json)))。
			// harness 自己实现的 btoa 按 binary string 处理，直接复用即可保证对称。
			const enc = makeBtoa()(unescape(encodeURIComponent(json)));
			ctx.localStorage.setItem(id, enc);
			const r = api.safe("load");
			// 兜底：若 remain 仍非正（存档时间在未来等边界情况），清掉它，别污染后续 tick
			if (ctx.player && ctx.player.offTime && !(ctx.player.offTime.remain > 0)) ctx.player.offTime = undefined;
			return r;
		},
		dumpSaveJson: () => {
			try { return JSON.stringify(ctx.player); } catch (e) { return null; }
		},
		setSeed: (seed) => setSeed(ctx, seed),

		// —— 检查 ——
		nanScan: () => nanScan(api),
		errors: () => state.errors.slice(),
		bootErrors: () => state.bootErrors.slice(),
		runtimeErrors: () => state.runtimeErrors.slice(),
		hookErrors: () => collectHookErrors(state),
		warnings: () => state.warnings.slice(),
		clearErrors: () => {
			state.errors.length = 0;
			state.runtimeErrors.length = 0;
			state.bootErrors.length = 0;
			state.hookErrors.length = 0;
			state.errorIndex.clear();
			state.consoleErrorCount = 0;
		},
		// 严重级别计数（去重后的记录条数，累加 count 才是真实发生次数）
		fatalCount() {
			let n = 0;
			for (const e of state.errors) if (e.severity !== "hook" && e.severity !== "console") n += (e.count || 1);
			return n;
		},
		hookErrorCount() {
			let n = 0;
			for (const e of state.errors) if (e.severity === "hook") n += (e.count || 1);
			return n;
		},

		// —— 推进 ——
		tick: (diff, onStep) => tick(api, diff, onStep),
		advance: (seconds, stepMs, onStep) => advance(api, seconds, stepMs, onStep),
	};
	return api;
}

function collectHookErrors(state) {
	const list = state.errors.filter((e) => e.severity === "hook");
	state.hookErrors = list;
	return list;
}

// 错误记录（带指纹去重）：同一个 (severity/type/fn/file + message) 只保留一条，累加 count。
// 目的：侧层（ach/stats）每 tick 抛同一个 ReferenceError 时，不至于刷出几十万条错误把内存吃掉，
// 也不会让真正的卡点被噪声埋掉。
function recordError(state, rec) {
	const key = (rec.severity || "") + "|" + (rec.type || "") + "|" + (rec.fn || rec.file || "") + "|" + (rec.message || "");
	const hit = state.errorIndex.get(key);
	if (hit) {
		hit.count++;
		return hit;
	}
	rec.count = 1;
	rec.__key = key;
	state.errors.push(rec);
	if (rec.severity === "hook") state.hookErrors.push(rec);
	else if (rec.type === "load-error") state.bootErrors.push(rec);
	else state.runtimeErrors.push(rec);
	state.errorIndex.set(key, rec);
	return rec;
}

// 判断异常是不是 helpers.js 的钩子吞掉的那一类（非致命）
function classifySeverity(err) {
	const msg = (err && err.message) || "";
	if (/Forge hook failed/i.test(msg)) return "hook";
	return null;
}

// ---------------------------------------------------------------------------
// 单帧：复刻 game.js 里 setInterval 回调的逻辑（绕过 Date.now / 真实定时器）
// ---------------------------------------------------------------------------
function tick(api, diff, onStep) {
	const { ctx, state } = api;
	const player = ctx.player;
	const tmp = ctx.tmp;
	if (!player || !tmp) {
		state.warnings.push("tick: player/tmp 未就绪，跳过（请先 newGame()/load()）");
		return;
	}
	if (!(diff > 0)) diff = 1 / 60;

	// 虚拟时钟推进
	state.nowMs += Math.round(diff * 1000);

	// bot 决策点（在 updateTemp 之前跑，这样 buyable/upgradable 的判断基于上一帧的 tmp）
	if (typeof onStep === "function") {
		try {
			onStep(diff, api);
		} catch (e) {
			recordError(state, { severity: "runtime", type: "bot", message: (e && e.message) || String(e), stack: firstFrames((e && e.stack) || "", 4) });
		}
	}

	// —— 离线收益（与 index.html 的 interval 完全一致）——
	// options 是 let 声明，必须每次现取；loadOptions() 会整体重新赋值
	const options = api.options || {};
	if (player.offTime !== undefined) {
		const offlineLimit = (api.modInfo && api.modInfo.offlineLimit ? api.modInfo.offlineLimit : 1) * 3600;
		if (player.offTime.remain > offlineLimit) player.offTime.remain = offlineLimit;
		if (player.offTime.remain > 0) {
			const offlineDiff = Math.max(player.offTime.remain / 10, diff);
			player.offTime.remain -= offlineDiff;
			diff += offlineDiff;
		}
		if (!options.offlineProd || player.offTime.remain <= 0) player.offTime = undefined;
	}
	if (player.devSpeed) diff *= player.devSpeed;
	player.time = state.nowMs;

	// interval 回调里的调用序列
	api.safe("updateTemp");
	api.safe("updateOomps", diff);
	api.safe("updateWidth");
	api.safe("updateTabFormats");
	api.safe("gameLoop", diff);
	api.safe("fixNaNs");
	api.safe("adjustPopupTime", diff);
	api.safe("updateParticles", diff);
	state.ticks++;
}

// 以固定步长跑 seconds 秒模拟时间
function advance(api, seconds, stepMs, onStep) {
	const step = (Math.max(1, Number(stepMs) || 50)) / 1000;
	let remain = Number(seconds);
	if (!(remain > 0)) return api;
	let guard = 0;
	const maxSteps = 20000000;
	while (remain > 1e-9 && guard < maxSteps) {
		const d = Math.min(step, remain);
		tick(api, d, onStep);
		remain -= d;
		guard++;
	}
	return api;
}

// ---------------------------------------------------------------------------
// NaN 扫描：递归检查 player（Decimal 用 isNan()，普通 number 用 isNaN）
// ---------------------------------------------------------------------------
function nanScan(api) {
	const found = [];
	const seen = new Set();
	const walk = (obj, prefix, depth) => {
		if (depth > 14 || found.length > 200) return;
		if (obj === null || obj === undefined) return;
		if (typeof obj === "number") {
			if (isNaN(obj)) found.push({ path: prefix, kind: "number", value: String(obj) });
			return;
		}
		if (typeof obj !== "object") return;
		if (seen.has(obj)) return;
		seen.add(obj);
		// Decimal 在另一个 realm，用鸭子类型识别
		if (typeof obj.isNan === "function" && obj.sign !== undefined) {
			let bad = false;
			try { bad = !!obj.isNan(); } catch (e) { bad = true; }
			if (bad) found.push({ path: prefix, kind: "Decimal", value: safeStr(obj) });
			return;
		}
		if (Array.isArray(obj)) {
			for (let i = 0; i < obj.length; i++) walk(obj[i], prefix + "[" + i + "]", depth + 1);
			return;
		}
		for (const k in obj) {
			if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
			walk(obj[k], prefix ? prefix + "." + k : k, depth + 1);
		}
	};
	walk(api.player, "player", 0);
	return found;
}

function safeStr(x) {
	try { return String(x); } catch (e) { return Object.prototype.toString.call(x); }
}

// ---------------------------------------------------------------------------
// CLI：node tools/harness.js  → 自检
//   --verbose         打印游戏侧 console 输出
//   --strict-order    按 index.html 的字面顺序执行（暴露加载期依赖）
//   --seed=N          种子随机
// ---------------------------------------------------------------------------
function selfTest(argv) {
	const api = boot({
		verbose: argv.includes("--verbose"),
		seed: parseArg(argv, "--seed", 1),
		strictIndexOrder: argv.includes("--strict-order"),
	});
	console.log("=== harness 自检 ===");
	console.log("仓库根目录: " + ROOT);
	console.log("");
	console.log("加载顺序（成功执行的文件）:");
	api.state.loadedFiles.forEach((f, i) => console.log("  " + String(i + 1).padStart(2, " ") + ". " + f));
	printBlock("执行出错的文件（boot 期）", api.state.failedFiles.map((f) => f.file + " → " + f.message + "\n      " + firstFrameOf(f.stack)), api.state.failedFiles.length ? "" : "（无）");
	printBlock("缺文件（已跳过）", api.state.missingFiles, api.state.missingFiles.length ? "" : "（无）");
	printBlock("警告", api.state.warnings, "（无）");

	console.log("");
	console.log("modInfo.name     = " + (api.modInfo ? api.modInfo.name : "(取不到，检查 mod.js)"));
	console.log("modInfo.modFiles = " + JSON.stringify(api.modInfo ? api.modInfo.modFiles : null));
	console.log("modID            = " + api.modID);
	console.log("options（let 全局，走 get）= " + JSON.stringify(api.options));
	console.log("layers           = " + JSON.stringify(Object.keys(api.layers || {})));
	console.log("HOOKS            = " + describeHooks(api));

	api.newGame();
	console.log("");
	console.log("newGame() 后: player.points = " + safeStr(api.player && api.player.points) +
		", tmp.pointGen = " + safeStr(api.tmp && api.tmp.pointGen) +
		", tmp.h === layers.h ? " + (api.tmp && api.layers ? (api.tmp.h === api.layers.h) : "?"));

	const before = safeStr(api.player.points);
	advance(api, 30, 50);
	console.log("推进 30 秒（step 50ms）: timePlayed=" + Number(api.player.timePlayed).toFixed(2) +
		"s points: " + before + " → " + safeStr(api.player.points) +
		" pointGen=" + safeStr(api.tmp.pointGen));
	if (api.player.h) console.log("  h: points=" + safeStr(api.player.h.points) + " pressure=" + safeStr(api.player.h.pressure) + " resets=" + safeStr(api.player.h.resets));

	const nan = api.nanScan();
	console.log("");
	console.log("NaN 扫描: " + (nan.length ? nan.map((n) => n.path + "=" + n.value).join(", ") : "干净"));
	reportErrors(api, 3);
	console.log("自检结束。");
	return api;
}

function firstFrameOf(stack) {
	const lines = String(stack || "").split("\n").map((l) => l.trim()).filter(Boolean);
	return lines.length ? lines[0] : "";
}

function printBlock(title, items, emptyText) {
	console.log("");
	console.log(title + ":");
	if (!items.length) { console.log("  " + (emptyText || "（无）")); return; }
	for (const it of items) console.log("  - " + it);
}

function describeHooks(api) {
	const H = api.HOOKS;
	if (!H) return "(helpers.js 未加载)";
	const keys = Object.keys(H);
	if (!keys.length) return "(空)";
	return keys.map((k) => k + ":" + H[k].length).join(", ");
}

// 默认打印前 3 条错误的栈第一帧
function reportErrors(api, n) {
	const all = api.state.errors;
	const fatal = all.filter((e) => e.severity !== "hook");
	const hooks = all.filter((e) => e.severity === "hook");
	console.log("");
	console.log("错误统计: 致命/运行期 = " + fatal.length + "，钩子（非致命）= " + hooks.length +
		"，console.error 次数 = " + api.state.consoleErrorCount);
	for (const e of fatal.slice(0, n || 3)) {
		console.log("  ✗ [" + e.severity + "/" + e.type + "] " + (e.file || e.fn || "") + " " + e.message);
		if (e.stack) console.log("      " + String(e.stack).split("\n")[0].trim());
	}
	if (fatal.length > (n || 3)) console.log("      … 其余 " + (fatal.length - (n || 3)) + " 条（--verbose 查看全部）");
	for (const e of hooks.slice(0, n || 3)) {
		console.log("  ⚠ [hook] " + e.message.slice(0, 120));
	}
}

function parseArg(argv, name, dflt) {
	for (const a of argv) {
		if (a.indexOf(name + "=") === 0) return a.slice(name.length + 1);
	}
	return dflt;
}

if (require.main === module) {
	selfTest(process.argv.slice(2));
}

module.exports = {
	ROOT,
	boot,
	tick,
	advance,
	nanScan,
	get,
	setSeed,
	scanForgeFiles,
	exists,
	selfTest,
	reportErrors,
	firstFrames,
	ENGINE_HEAD,
	ENGINE_TAIL,
	BEFORE_MOD,
	AFTER_MODFILES,
	makeRng,
	safeStr,
};
