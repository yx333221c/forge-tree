// tools/preview.js —— 零依赖本地预览服务器 + index.html 资源 404 预检
// 只用 Node 内置模块（http / fs / path / url）。不要 npm install。
//
// 用法：
//   node tools/preview.js                在 8123 端口起服务，打印访问 URL
//   node tools/preview.js --port=8080    换端口
//   node tools/preview.js --open         额外打印可直接点开的 URL（含 index.html）
//   node tools/preview.js --host=0.0.0.0 允许局域网访问（默认 127.0.0.1）
//   node tools/preview.js --check        不启动服务：解析 index.html 里所有 script/link/img 等资源，
//                                        逐个检查本地文件是否存在，打印清单（404 预检）
//   node tools/preview.js --check=other  只检查指定 html 文件（相对仓库根）
//
// 为什么需要 --check：TMT 的 modFiles 是 loader.js 用 <script src> 动态插进去的，
// 拼错一个路径或队友文件还没提交，浏览器里只会看到"Loading... 卡住"，
// 很难一眼看出是哪个文件 404。--check 直接给清单。
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// MIME 表（引擎用到的都齐了）
// ---------------------------------------------------------------------------
const MIME = {
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".mjs": "application/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".webp": "image/webp",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".md": "text/plain; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".wav": "audio/wav",
	".mp3": "audio/mpeg",
};

function mimeOf(file) {
	return MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
}

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
function parseArgs(argv) {
	const args = {
		port: 8123,
		host: "127.0.0.1",
		open: false,
		check: false,
		checkFile: "index.html",
		strict: false,
	};
	for (const a of argv) {
		if (a.startsWith("--port=")) args.port = Number(a.slice(7)) || 8123;
		else if (a.startsWith("--host=")) args.host = a.slice(7);
		else if (a === "--open") args.open = true;
		else if (a === "--check") args.check = true;
		else if (a.startsWith("--check=")) { args.check = true; args.checkFile = a.slice(8); }
		else if (a === "--strict") args.strict = true;
		else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
	}
	return args;
}

function printHelp() {
	console.log([
		"用法: node tools/preview.js [选项]",
		"",
		"  （无选项）          在 http://127.0.0.1:8123/index.html 起静态服务器",
		"  --port=N           换端口（默认 8123）",
		"  --host=ADDR        换监听地址（默认 127.0.0.1；0.0.0.0 允许局域网）",
		"  --open             打印可直接点开的访问 URL",
		"  --check            不起服务：检查 index.html 引用的所有本地资源是否存在（404 预检）",
		"  --check=<file.html> 检查指定 html（相对仓库根，默认 index.html）",
		"  --strict           --check 模式下：把缺失的 modFiles 也计入退出码（CI 用）",
		"",
		"服务器一律带 no-cache 头，改完文件刷新即可生效（不用清缓存）。",
	].join("\n"));
}

// ---------------------------------------------------------------------------
// 路径安全：只允许服务仓库根目录内的文件
// ---------------------------------------------------------------------------
function safeResolve(urlPath) {
	let p;
	try {
		p = decodeURIComponent(urlPath.split("?")[0].split("#")[0]);
	} catch (e) {
		return null;
	}
	if (p === "/" || p === "") p = "/index.html";
	// 去掉开头的斜杠，转成仓库根相对路径
	const rel = p.replace(/^\/+/, "").replace(/\\/g, "/");
	const abs = path.resolve(ROOT, rel);
	// 目录穿越防护
	const rootWithSep = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
	if (abs !== ROOT && !abs.startsWith(rootWithSep)) return null;
	return abs;
}

// ---------------------------------------------------------------------------
// 静态服务器
// ---------------------------------------------------------------------------
function createServer() {
	return http.createServer((req, res) => {
		const started = Date.now();
		const abs = safeResolve(req.url || "/");
		if (!abs) {
			res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("403 Forbidden（只允许访问仓库根目录内的文件）\n");
			log(req, 403, started, "(越界路径)");
			return;
		}
		if (req.method !== "GET" && req.method !== "HEAD") {
			res.writeHead(405, { Allow: "GET, HEAD" });
			res.end("405 Method Not Allowed\n");
			log(req, 405, started, "");
			return;
		}
		fs.stat(abs, (err, st) => {
			if (err || !st.isFile()) {
				// 目录：尝试 index.html
				if (!err && st && st.isDirectory()) {
					const idx = path.join(abs, "index.html");
					return fs.stat(idx, (e2, s2) => {
						if (e2 || !s2.isFile()) return notFound(req, res, started, abs);
						sendFile(req, res, idx, s2, started);
					});
				}
				return notFound(req, res, started, abs);
			}
			sendFile(req, res, abs, st, started);
		});
	});
}

function notFound(req, res, started, abs) {
	res.writeHead(404, {
		"Content-Type": "text/plain; charset=utf-8",
		"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
	});
	const rel = path.relative(ROOT, abs).replace(/\\/g, "/");
	res.end("404 Not Found: /" + rel + "\n（如果你要的是 modFiles 里的文件，说明队友还没提交；跑 node tools/preview.js --check 看清单）\n");
	log(req, 404, started, rel);
}

function sendFile(req, res, abs, st, started) {
	const ext = path.extname(abs).toLowerCase();
	const headers = {
		"Content-Type": mimeOf(abs),
		"Content-Length": st.size,
		// 开发预览：一律不缓存，改完刷新就生效
		"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
		"Pragma": "no-cache",
		"Expires": "0",
		"Last-Modified": st.mtime.toUTCString(),
		"X-Content-Type-Options": "nosniff",
	};
	// 条件请求
	 const inm = req.headers["if-modified-since"];
	if (inm && new Date(inm) >= st.mtime) {
		res.writeHead(304, headers);
		res.end();
		log(req, 304, started, relOf(abs));
		return;
	}
	res.writeHead(200, headers);
	log(req, 200, started, relOf(abs));
	if (req.method === "HEAD") { res.end(); return; }
	const stream = fs.createReadStream(abs);
	stream.pipe(res);
	stream.on("error", () => { try { res.end(); } catch (e) { /* ignore */ } });
}

function relOf(abs) {
	return "/" + path.relative(ROOT, abs).replace(/\\/g, "/");
}

function log(req, code, started, target) {
	const ms = Date.now() - started;
	const stamp = new Date().toTimeString().slice(0, 8);
	console.log(stamp + "  " + String(code).padEnd(4) + " " + (req.method || "GET").padEnd(5) +
		" " + (target || req.url) + "  (" + ms + "ms)");
}

function startServer(args) {
	const server = createServer();
	server.on("error", (e) => {
		if (e.code === "EADDRINUSE") {
			console.error("端口 " + args.port + " 已被占用。换端口：node tools/preview.js --port=" + (args.port + 1));
			process.exitCode = 2;
			return;
		}
		console.error("启动失败: " + (e && e.message ? e.message : e));
		process.exitCode = 2;
	});
	server.listen(args.port, args.host, () => {
		const url = "http://" + args.host + ":" + args.port + "/index.html";
		console.log("《熔炉之树》本地预览服务器已启动");
		console.log("  根目录: " + ROOT);
		console.log("  监听:   " + args.host + ":" + args.port + (args.host === "127.0.0.1" ? "（仅本机）" : "（含局域网）"));
		console.log("  访问:   " + url);
		console.log("  响应头: Cache-Control: no-store, no-cache（改完文件刷新即可，不用清缓存）");
		console.log("  Ctrl+C 停止。注意：Vue 2.7 走的是 index.html 里的 CDN <script>，离线会白屏。");
		if (args.open) {
			console.log("");
			console.log("  ▶ 直接点开: " + url);
			console.log("  ▶ 引擎自检:  node tools/harness.js");
			console.log("  ▶ 资源预检:  node tools/preview.js --check");
		}
	});
	return server;
}

// ---------------------------------------------------------------------------
// --check：解析 index.html 里的资源引用，逐个检查是否存在
// ---------------------------------------------------------------------------
// 需要检查的三类：
//   1. index.html 里的静态 <script src> / <link href> / <img src>
//   2. mod.js 的 modInfo.modFiles（loader.js 动态插入的 js/<file>）—— 这才是最容易出问题的
//   3. mod.js 的 modInfo.modFiles 之外，js/Forge 目录里"已存在但没被 modFiles 列出"的文件（漏登记）
function checkResources(args) {
	const htmlAbs = path.resolve(ROOT, args.checkFile);
	console.log("=== 资源 404 预检: " + args.checkFile + " ===");
	console.log("仓库根目录: " + ROOT);
	console.log("");

	if (!fs.existsSync(htmlAbs)) {
		console.error("找不到 HTML 文件: " + htmlAbs);
		return { ok: false, missing: [args.checkFile], rows: [] };
	}

	const html = stripBom(fs.readFileSync(htmlAbs, "utf8"));
	const rows = [];
	const push = (kind, ref, note) => {
		const url = String(ref || "").trim();
		if (!url) return;
		const external = /^([a-zA-Z][a-zA-Z0-9+.-]*:)?\/\//.test(url);
		const dataUri = /^data:/.test(url);
		const isModFile = kind === "modFile";
		let fsPath = null, exists = null, abs = null;
		if (external || dataUri) {
			note = (note ? note + "；" : "") + (dataUri ? "data URI" : "外链（需要联网/CDN）");
		} else {
			const clean = url.split("?")[0].split("#")[0];
			abs = path.resolve(ROOT, isModFile ? path.join("js", clean) : clean);
			fsPath = isModFile ? "js/" + clean : clean;
			exists = fs.existsSync(abs) && fs.statSync(abs).isFile();
			if (!exists && !isModFile) {
				// 有些引用是相对子目录写的，兜底再试一次
				const alt = path.resolve(path.dirname(htmlAbs), clean);
				if (fs.existsSync(alt) && fs.statSync(alt).isFile()) {
					exists = true; abs = alt;
					note = (note ? note + "；" : "") + "按 HTML 所在目录解析才存在";
				}
			}
		}
		rows.push({ kind, ref: url, fsPath, exists, external, dataUri, note: note || "", abs });
	};

	// 1) <script src="...">
	for (const m of html.matchAll(/<script\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
		push("script", m[1]);
	}
	// 没有 src 的内联 <script>：只提示，不检查
	for (const m of html.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)) {
		const body = (m[1] || "").trim();
		if (body) push("inline-script", "(inline " + body.split("\n")[0].slice(0, 40) + "…)", "内联脚本，不做存在性检查");
	}
	// 2) <link href="...">（只关心 css / icon，字体外链照常列出）
	for (const m of html.matchAll(/<link\b[^>]*?\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
		const tag = m[0];
		const rel = (/rel\s*=\s*["']([^"']*)["']/i.exec(tag) || [])[1] || "";
		push(rel && /stylesheet|icon/i.test(rel) ? "link:" + rel.toLowerCase() : "link", m[1], rel ? ("rel=" + rel) : "");
	}
	// 3) <img src="...">
	for (const m of html.matchAll(/<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) push("img", m[1]);
	// 4) 内联事件里的 url(...) / resources/xxx.png（粒子贴图之类）
	for (const m of html.matchAll(/["'(](resources\/[^"')]+)["')]/gi)) push("resource", m[1]);
	// 5) modInfo.modFiles（loader.js 动态注入的脚本 —— 最常被拼错/漏提交）
	const modFiles = readModFiles();
	if (modFiles.error) {
		console.log("提示：读不到 modInfo.modFiles（" + modFiles.error + "），只检查了 index.html 的静态引用");
	} else {
		for (const f of modFiles.list) push("modFile", f, "loader.js 动态注入");
	}

	// ---- 输出 ----
	const W = 96;
	console.log(pad("状态", 8) + pad("来源", 16) + pad("引用", 40) + "说明");
	console.log("─".repeat(W));
	let missing = 0, external = 0, ok = 0;
	for (const r of rows) {
		let mark;
		if (r.dataUri) mark = "data";
		else if (r.external) { mark = "外链"; external++; }
		else if (r.exists) { mark = "OK"; ok++; }
		else { mark = "缺失"; missing++; }
		console.log(pad(mark, 8) + pad(r.kind, 16) + pad(r.ref.length > 38 ? r.ref.slice(0, 37) + "…" : r.ref, 40) +
			(r.fsPath && !r.exists ? ("→ 期望路径 js/… 或 " + r.fsPath) : "") +
			(r.fsPath && r.exists ? ("→ " + r.fsPath) : "") +
			(r.note ? ("   [" + r.note + "]") : ""));
	}
	console.log("─".repeat(W));

	// 5) 反向检查：js/Forge 下有文件但 modFiles 没登记 → 浏览器里永远不会加载
	const orphans = findForgeOrphans(modFiles.list);
	if (orphans.length) {
		console.log("");
		console.log("⚠ 未登记的层文件（存在但 modInfo.modFiles 没写，浏览器里不会加载）:");
		for (const o of orphans) console.log("   · " + o);
		console.log("   → 修法：在 js/mod.js 的 modFiles 数组里补上（helpers.js 必须在各层之前）");
	}

	console.log("");
	console.log("小结: 本地存在 " + ok + " 个，缺失 " + missing + " 个，外链 " + external + " 个（外链需要联网）。");
	if (missing) {
		console.log("");
		console.log("缺失清单（浏览器会 404，页面可能卡在 Loading…）:");
		for (const r of rows) if (!r.exists && !r.external && !r.dataUri) console.log("   ✗ " + (r.fsPath || r.ref));
	}
	console.log("");
	console.log(missing === 0 ? "预检通过 ✓" : "预检不通过 ✗");
	return { ok: missing === 0, missing: rows.filter((r) => !r.exists && !r.external && !r.dataUri).map((r) => r.fsPath || r.ref), rows, orphans };
}

function stripBom(s) {
	return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

// 从 js/mod.js 里抠出 modFiles 数组（不执行它，避免被别的语法错误带崩）
function readModFiles() {
	const p = path.join(ROOT, "js", "mod.js");
	if (!fs.existsSync(p)) return { list: [], error: "js/mod.js 不存在" };
	const src = stripBom(fs.readFileSync(p, "utf8"));
	// 支持 modFiles: [ "a.js", "b.js" ] 以及跨行写法
	const m = /modFiles\s*:\s*\[([\s\S]*?)\]/.exec(src);
	if (!m) return { list: [], error: "js/mod.js 里找不到 modFiles 数组" };
	const body = m[1];
	const list = [];
	for (const s of body.matchAll(/["']([^"']+)["']/g)) list.push(s[1]);
	return { list, error: null };
}

// js/Forge 下存在、但 modFiles 没列出的 .js
function findForgeOrphans(modFiles) {
	const dir = path.join(ROOT, "js", "Forge");
	if (!fs.existsSync(dir)) return [];
	const listed = new Set(modFiles.map((f) => f.replace(/^js\//, "").replace(/\\/g, "/")));
	const out = [];
	for (const name of fs.readdirSync(dir)) {
		if (!/\.js$/i.test(name)) continue;
		const rel = "Forge/" + name;
		if (!listed.has(rel) && !listed.has("js/" + rel)) out.push("js/" + rel);
	}
	return out;
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
	if (args.check) {
		const r = checkResources(args);
		// 孤儿文件只在 --strict 下算失败
		const fail = !r.ok || (args.strict && r.orphans && r.orphans.length);
		process.exitCode = fail ? 1 : 0;
		return;
	}
	startServer(args);
}

if (require.main === module) main();

module.exports = { parseArgs, createServer, startServer, checkResources, safeResolve, mimeOf, MIME, readModFiles, findForgeOrphans };
