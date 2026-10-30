// tools/vet.js —— 交稿前必跑的「编译 + 编码」总检（DESIGN.md §7.1 / §9.1）
//
// 为什么需要它：本项目所有源文件都含简体中文。PowerShell 的 Set-Content / Out-File / `>`
// 会以 ANSI 或 UTF-16 重写，把中文变成 U+FFFD 替换字符（本项目实测损坏过一次）。
// 所以任何人（含自动化）改完文件后都要用这个脚本逐字节确认没有 U+FFFD / BOM，
// 同时确认每个文件仍能编译。纯 node，不写任何文件。
//
// 用法：
//   node tools/vet.js          # 检查全部交付文件（mod + 引擎改动 + tools）
//   node tools/vet.js --all    # 额外检查 js/ 下所有 .js（含引擎全量）
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const REPL = String.fromCharCode(0xFFFD)
const REPL_RE = new RegExp(REPL, "g")
// 「UTF-8 字节流被当 GBK 读、再写回 UTF-8」会产出一批极罕见的汉字（U+FFFD 的 GBK
// 形态连成的三字节串就是最常见的一种）。这里用码点构造特征表，避免本脚本源码自己含这些字。
// 出现 ≥3 个才判乱码：单个生僻字可能是正常用字。
const MOJI_CHARS = [0x951F, 0x65A4, 0x62F7, 0x9352, 0x9428, 0x9411, 0x93C6, 0x6D63, 0x934F, 0x951B]
const MOJI_RE = new RegExp("[" + MOJI_CHARS.map((c) => "\\u" + c.toString(16).padStart(4, "0")).join("") + "]", "g")

// 交付清单：mod 本体 + 我们动过的引擎文件 + 工具
const FILES = [
	"js/mod.js", "js/tree.js", "js/Forge/helpers.js",
	"js/Forge/h.js", "js/Forge/m.js", "js/Forge/r.js", "js/Forge/t.js", "js/Forge/x.js",
	"js/Forge/ach.js", "js/Forge/stats.js",
	"js/utils.js", "js/technical/temp.js",            //  lead 的两处引擎修复
	"css/system-style.css", "index.html", "DESIGN.md", "README.md", "tools/README.md",
	"tools/harness.js", "tools/sim.js", "tools/preview.js", "tools/vet.js",
	"tools/test-mid.js", "tools/test-side.js", "tools/test-top.js", "tools/test-endgame.js",
]

const ALL = process.argv.includes("--all")
const list = FILES.slice()
if (ALL) {
	const walk = (d) => {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, e.name).split(path.sep).join("/")
			if (e.isDirectory()) { if (!/node_modules|\.git|Demo/.test(p)) walk(p) }
			else if (/\.js$/.test(p) && !list.includes(p)) list.push(p)
		}
	}
	walk("js")
}

let bad = 0
const isJs = (f) => /\.js$/.test(f)

for (const f of list) {
	if (!fs.existsSync(f)) { console.log("MISS " + f + "   （文件不在，交付不完整）"); bad++; continue }
	const buf = fs.readFileSync(f)
	const src = buf.toString("utf8")
	const repl = (src.match(REPL_RE) || []).length
	const bom = buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF
	const mojiHits = (src.match(MOJI_RE) || []).length
	const moji = mojiHits >= 3            // 单个生僻字可能是正常用字，成片出现才是编码事故
	let note = ""
	if (repl) note += "  [U+FFFD x" + repl + "]"
	if (bom) note += "  [有 BOM]"
	if (moji) note += "  [疑似 GBK 往返乱码 x" + mojiHits + "]"

	if (isJs(f)) {
		try {
			new vm.Script(src, { filename: f })
			console.log((note ? "WARN " : "OK   ") + f + note)
			if (note) bad++
		} catch (e) {
			console.log("FAIL " + f + " :: " + e.message)
			const m = String(e.stack || "").match(new RegExp(f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ":(\\d+)"))
			if (m) {
				const ln = Number(m[1])
				const lines = src.split(/\r?\n/)
				for (let i = Math.max(0, ln - 3); i < Math.min(lines.length, ln + 2); i++)
					console.log("      " + (i + 1) + (i + 1 === ln ? " >> " : "    ") + lines[i])
			}
			bad++
		}
	} else {
		console.log((note ? "WARN " : "OK   ") + f + note)
		if (note) bad++
	}
}

console.log("\n检查 " + list.length + " 个文件，问题文件 " + bad + " 个")
console.log(bad ? "✗ 不可交稿" : "✓ 编译与编码全部干净")
if (!process.argv.includes("--selftest")) process.exitCode = bad ? 1 : 0

// --selftest：确认这套检测本身有效（永不失败的守卫等于没有守卫）
if (process.argv.includes("--selftest")) {
	const cases = [
		["正常中文", Buffer.from("// 热量每回合翻倍\n", "utf8"), false],
		["U+FFFD 损坏", Buffer.concat([Buffer.from("// ", "utf8"), Buffer.from([0xEF, 0xBF, 0xBD])]), true],
		["UTF-8 带 BOM", Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from("// x", "utf8")]), true],
		["GBK 往返乱码（成片）", Buffer.from("// " + String.fromCharCode(0x9352, 0x77BB, 0x74D4, 0x8459, 0x9428, 0x5F6D, 0x5442, 0x951B, 0x9500, 0x93C9) + "\n", "utf8"), true],
		["单个生僻字（不应误判）", Buffer.from("// " + String.fromCharCode(0x951F) + "\n", "utf8"), false],
		["语法错误", Buffer.from("function ( {", "utf8"), "syntax"],
	]
	let pass = 0
	console.log("\n=== 自检 ===")
	for (const [name, buf, expect] of cases) {
		const src = buf.toString("utf8")
		const r = (src.match(REPL_RE) || []).length
		const b = buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF
		const m = (src.match(MOJI_RE) || []).length >= 3
		const flagged = !!(r || b || m)
		let okc
		if (expect === "syntax") {
			let threw = false
			try { new vm.Script(src, { filename: "selftest" }) } catch (e) { threw = true }
			okc = threw
			console.log("  " + (okc ? "✓" : "✗") + " " + name + " → 编译抛错=" + threw)
		} else {
			okc = flagged === expect
			console.log("  " + (okc ? "✓" : "✗") + " " + name + " → 标记=" + flagged + " 期望=" + expect)
		}
		if (okc) pass++
	}
	console.log("  自检 " + pass + "/" + cases.length + (pass === cases.length ? " ✓" : " ✗ 检测器不可靠！"))
	if (pass !== cases.length) process.exitCode = 1
}
