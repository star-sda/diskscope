"use strict";
/** 规则表的行为校验。和 Python 自检互为对照, 防止两边漂移。 */
const r = require("../src/rules.js");

const byPath = (p) => r.DIR_RULES.filter((x) => x.match === "regex" && x.test(p)).map((x) => x.id);
const byName = (n) => r.DIR_RULES.filter((x) => x.match !== "regex" && x.test(n)).map((x) => x.id);
const byFile = (n) => r.FILE_RULES.filter((x) => x.test(n)).map((x) => x.id);
const j = (a) => a.join(",");

let bad = 0;
const t = (label, got, want) => {
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? "[ok]  " : "[FAIL]"} ${label.padEnd(30)} -> ${got || "(无)"}`);
};

// --- 目录名匹配 ---
t("node_modules", j(byName("node_modules")), "node_modules");
t("dist", j(byName("dist")), "dist");
t("build (Gradle/C++)", j(byName("build")), "build_output");
t("target (Maven/Rust)", j(byName("target")), "build_target");
t("__pycache__", j(byName("__pycache__")), "pycache");
t("Debug", j(byName("Debug")), "debug_build");
t(".git", j(byName(".git")), "git");
t(".github (不能误判成 .git)", j(byName(".github")), "");
t("builder (不能误判成 build)", j(byName("builder")), "");
t("targets (不能误判成 target)", j(byName("targets")), "");

// --- 路径匹配 (只有 .NET bin/obj 还用正则) ---
t("bin/Debug", j(byPath("D:\\p\\bin\\Debug")), "bin_obj");
t("obj/Release", j(byPath("D:\\p\\obj\\Release")), "bin_obj");
t("不是 bin 的路径", j(byPath("D:\\p\\binary\\x")), "");

// --- 文件名匹配 ---
t("a.pyc", j(byFile("a.pyc")), "pyc_files");
t("x.pyo", j(byFile("x.pyo")), "pyc_files");
t("x.log", j(byFile("x.log")), "log_files");
t("Thumbs.db", j(byFile("Thumbs.db")), "os_junk");
t("s.tfstate", j(byFile("s.tfstate")), "terraform_tfstate");
t("README.md (不该命中)", j(byFile("README.md")), "");

// --- 规则完整性 (Python 版漏字段曾导致扫描时 KeyError) ---
const incomplete = r.DIR_RULES.concat(r.FILE_RULES)
  .filter((x) => !x.id || !x.label || x.why === undefined || !x.level || !x.match || !x.pattern);
t("规则字段完整", j(incomplete.map((x) => x.id)), "");
t("level 取值合法", j(r.DIR_RULES.filter((x) => !["safe", "caution", "never"].includes(x.level)).map((x) => x.id)), "");

// --- 硬跳过 ---
for (const [name, want] of [["$RECYCLE.BIN", true], ["System Volume Information", true],
                            [".svn", true], [".hg", true], ["node_modules", false]]) {
  t(`硬跳过 ${name}`, String(r.isHardSkip(name)), String(want));
}

console.log(bad === 0 ? "\n规则全部匹配预期" : `\n${bad} 项不符`);
process.exit(bad ? 1 : 0);
