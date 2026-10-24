"use strict";
/**
 * DiskScope 后端自检。不需要开窗口, 直接验证核心逻辑。
 *
 *   node src/selftest.js          只跑纯逻辑 (不含回收站)
 *   npm run selftest              在 Electron 里跑, 含真实回收站往返
 *
 * 和 selftest.py 是同一套断言的两个实现, 互为对照, 防止两版行为漂移。
 */
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");

const { MinHeap } = require("./scanner");
const { ScanPool } = require("./scanner-pool");
const rules = require("./rules");
const trash = require("./trash");

const FAILS = [];
let GROUP = "";
function group(g) { GROUP = g; console.log("\n[" + g + "]"); }
function check(cond, label, extra = "") {
  const line = `${cond ? "  [ok]   " : "  [FAIL] "}${label}${extra ? "   " + extra : ""}`;
  console.log(line);
  if (!cond) FAILS.push(GROUP + " / " + label);
}

/* ---------------- fixture ---------------- */
function mkFiles(dir, n, size, ageDays) {
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now() / 1000;
  for (let i = 0; i < n; i++) {
    const f = path.join(dir, `f${i}.bin`);
    fs.writeFileSync(f, Buffer.alloc(size, i % 251));
    const t = (now - ageDays * 86400 - Math.random() * 40000) * 1000;
    fs.utimesSync(f, t / 1000, t / 1000);
  }
}
function mkFile(file, size, ageDays) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(size, 7));
  const t = (Date.now() / 1000 - ageDays * 86400) * 1000;
  fs.utimesSync(file, t / 1000, t / 1000);
}

function buildFixture(root) {
  const proj = path.join(root, "workspace");
  mkFiles(path.join(proj, "old-dashboard", "node_modules", "lodash"), 40, 60000, 200);
  mkFiles(path.join(proj, "old-dashboard", "dist"), 10, 90000, 200);
  mkFiles(path.join(proj, "old-dashboard", "src"), 25, 3000, 150);
  mkFiles(path.join(proj, "live-api", ".venv", "lib"), 120, 22000, 5);
  mkFiles(path.join(proj, "live-api", "__pycache__"), 80, 900, 2);
  mkFiles(path.join(proj, "live-api", "src"), 30, 6000, 1);
  mkFile(path.join(proj, "live-api", "app.log"), 200000, 0);
  mkFile(path.join(proj, "live-api", "debug.pyc"), 3000, 0);
  mkFiles(path.join(proj, "rust-tool", "target", "debug"), 200, 70000, 20);
  mkFiles(path.join(proj, "java-svc", "target"), 40, 50000, 60);       // Maven
  mkFiles(path.join(proj, "gradle-app", "build"), 40, 50000, 60);      // Gradle
  mkFiles(path.join(proj, "cs-app", "bin", "Debug"), 40, 50000, 60);   // .NET
  mkFiles(path.join(proj, "cpp-app", "Debug"), 20, 30000, 30);         // \u66fe\u56e0\u89c4\u5219\u7f3a\u5b57\u6bb5\u9759\u9ed8\u4e22\u5b50\u6811
  mkFiles(path.join(proj, "git-repo", ".git", "objects"), 50, 15000, 90);
  mkFiles(path.join(root, "downloads"), 15, 80000, 5);
  mkFiles(path.join(root, "photos"), 6, 300000, 120);                   // \u5927\u6587\u4ef6
}

const sum = (a, n = a.length) => a.slice(0, n).reduce((s, x) => s + x, 0);
const findNode = (n, name) =>
  n.name === name ? n : (n.children || []).reduce((f, c) => f || findNode(c, name), null);

function hasStub(n) {
  return n.name === "?" || (n.children || []).some(hasStub);
}

async function runSelftest() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "diskscope_selftest_"));
  console.log("\u4e34\u65f6\u76ee\u5f55: " + tmp);
  buildFixture(tmp);

  // ---------------- 1. MinHeap (独立单测) ----------------
  group("MinHeap");
  {
    const h = new MinHeap(5);
    const ref = [];
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < 500; i++) {
      const v = Math.floor(rnd() * 100000);
      h.push([v, `p${i}`, 0]);
      ref.push(v);
    }
    ref.sort((a, b) => b - a);
    const got = h.sortedDesc().map((x) => x[0]);
    const want = ref.slice(0, 5);
    check(got.length === 5, "\u53ea\u4fdd\u7559 5 \u4e2a (\u5bb9\u91cf\u751f\u6548)", `\u5b9e\u9645 ${got.length}`);
    check(JSON.stringify(got) === JSON.stringify(want), "\u7559\u4e0b\u7684\u6b63\u662f\u6700\u5927\u7684 5 \u4e2a",
      `${got.join(",")} vs ${want.join(",")}`);
    check(h.a.length === 5, "\u5185\u90e8\u6570\u7ec4\u957f\u5ea6\u6052\u4e3a 5 (\u5185\u5b58\u4e0d\u968f\u626b\u63cf\u91cf\u589e\u957f)");
  }

  // ---------------- 2. 规则表 ----------------
  group("\u89c4\u5219\u8868");
  {
    const all = rules.DIR_RULES.concat(rules.FILE_RULES);
    const incomplete = all.filter((r) => !r.id || !r.label || r.why === undefined || !r.level);
    check(incomplete.length === 0, "\u6240\u6709\u89c4\u5219\u5b57\u6bb5\u5b8c\u6574 (\u907f\u514d\u626b\u63cf\u65f6 KeyError)",
      incomplete.map((r) => r.id).join(","));
    check(all.every((r) => ["safe", "caution", "never"].includes(r.level)), "level \u53d6\u503c\u5408\u6cd5");
    check(new Set(all.map((r) => r.id)).size === all.length, "\u89c4\u5219 id \u4e0d\u91cd\u590d");
    check(rules.RULE_COUNT > 40, "\u89c4\u5219\u6570\u91cf\u5145\u8db3", `${rules.RULE_COUNT} \u6761`);
    const hit = (n) => rules.DIR_RULES.filter((x) => x.match !== "regex" && x.test(n)).map((x) => x.id);
    check(hit(".github").length === 0, ".github \u4e0d\u4f1a\u88ab\u8bef\u5224\u6210 .git");
    check(hit("builder").length === 0, "builder \u4e0d\u4f1a\u88ab\u8bef\u5224\u6210 build");
  }

  // ---------------- 3. 扫描器 (线程池) ----------------
  group("\u626b\u63cf\u5668");
  const pool = new ScanPool(tmp, { maxDepth: 12 });
  const res = await pool.start();
  const node = res.root;
  const stats = res.summary;
  {
    check(stats.files > 500, "\u626b\u5230\u6587\u4ef6", `${stats.files} \u4e2a`);
    check(stats.errors === 0, "\u65e0\u8bfb\u53d6\u9519\u8bef", `${stats.errors}`);
    check(!hasStub(node), "\u6ca1\u6709\u5360\u4f4d\u8282\u70b9 (? = \u5b50\u6811\u88ab\u9759\u9ed8\u4e22\u5931)");
    check(Math.abs(node.total - stats.bytes) < 1024, "\u5b50\u6811\u603b\u91cf == \u5168\u5c40\u5b57\u8282\u6570", `${node.total}`);
    check(pool.workerCount >= 1, "\u7ebf\u7a0b\u6c60\u5df2\u542f\u52a8", `${pool.workerCount} \u4e2a worker`);
  }

  // ---------------- 4. 垃圾识别 ----------------
  group("\u5783\u573e\u8bc6\u522b");
  {
    const byRule = {};
    for (const j of res.junk) (byRule[j.rule] = byRule[j.rule] || []).push(j);
    for (const need of ["node_modules", "pycache", "build_target", "build_output",
                        "bin_obj", "debug_build", "git", "venv", "dist", "log_files"]) {
      check(Boolean(byRule[need]), "\u8bc6\u522b\u51fa " + need);
    }
    check(!byRule.rust_target && !byRule.maven_target && !byRule.gradle_build,
      "\u5df2\u6e05\u7406\u65e0\u6548\u7684\u8def\u5f84\u89c4\u5219");
    const lvl = Object.fromEntries(rules.DIR_RULES.map((r) => [r.id, r.level]));
    check(lvl.git === "never", ".git \u662f never \u7ea7 (\u6c38\u4e0d\u81ea\u52a8\u52fe\u9009)");
    check(lvl.node_modules === "safe", "node_modules \u662f safe \u7ea7");
    check(res.junk.every((j) => j.key && typeof j.mtime === "number"),
      "\u6bcf\u6761\u5783\u573e\u9879\u90fd\u6709 key/mtime");
  }

  // ---------------- 5. 时间轴 ----------------
  group("\u65f6\u95f4\u8f74");
  {
    const live = findNode(node, "live-api");
    const old = findNode(node, "old-dashboard");
    check(live && sum(live.daily, 7) > 0, "\u8fd1\u671f\u76ee\u5f55 7 \u5929\u5185\u6709\u5199\u5165",
      `${(sum(live.daily, 7) / 1048576).toFixed(1)} MB`);
    check(old && sum(old.daily, 30) === 0, "200 \u5929\u524d\u7684\u76ee\u5f55 30 \u5929\u5185\u65e0\u5199\u5165 (\u5e94\u4e3a 0)");
    check(sum(node.daily) === node.total, "\u76f4\u65b9\u56fe\u603b\u548c == \u76ee\u5f55\u603b\u5927\u5c0f",
      `${sum(node.daily)} == ${node.total}`);
    check(node.daily.length === 31, "\u76f4\u65b9\u56fe\u957f\u5ea6\u6b63\u786e", String(node.daily.length));
  }

  // ---------------- 6. 排除规则 ----------------
  group("\u6392\u9664\u89c4\u5219");
  {
    const p2 = new ScanPool(tmp, { maxDepth: 12, excludes: ["node_modules", ".git"] });
    const r2 = await p2.start();
    check(r2.root.total < node.total, "\u6392\u9664\u540e\u603b\u4f53\u79ef\u53d8\u5c0f",
      `${(node.total / 1048576).toFixed(1)} -> ${(r2.root.total / 1048576).toFixed(1)} MB`);
    const od = findNode(r2.root, "old-dashboard");
    check(od && !od.children.some((c) => c.name === "node_modules"), "node_modules \u672a\u88ab\u904d\u5386");
  }

  // ---------------- 7. 大文件 / 扩展名 ----------------
  group("\u5927\u6587\u4ef6\u4e0e\u6269\u5c55\u540d");
  {
    const big = res.bigfiles;
    check(big.length > 0, "\u8bb0\u4f4f\u4e86\u5927\u6587\u4ef6", `${big.length} \u4e2a`);
    check(big.every((b, i) => i === 0 || big[i - 1].size >= b.size), "\u6309\u4ece\u5927\u5230\u5c0f\u6392\u5e8f");
    check(new Set(big.map((b) => b.key)).size === big.length, "key \u552f\u4e00");
    check(big.every((b) => b.level === "caution"), "\u5168\u662f caution \u7ea7 (\u4e0d\u81ea\u52a8\u52fe\u9009)");
    check(big.slice(0, 20).every((b) => fs.existsSync(b.sample[0])), "\u8def\u5f84\u771f\u5b9e\u5b58\u5728");
    const exts = res.extensions;
    const ec = exts.reduce((s, e) => s + e.count, 0);
    const eb = exts.reduce((s, e) => s + e.bytes, 0);
    check(ec === stats.files, "\u5404\u6269\u5c55\u540d\u4e2a\u6570\u603b\u548c == \u5168\u90e8\u6587\u4ef6\u6570", `${ec} == ${stats.files}`);
    check(eb === stats.bytes, "\u5404\u6269\u5c55\u540d\u5b57\u8282\u603b\u548c == \u5168\u90e8\u5b57\u8282\u6570");
    check(exts.every((e, i) => i === 0 || exts[i - 1].bytes >= e.bytes), "\u6309\u5360\u7528\u4ece\u5927\u5230\u5c0f\u6392\u5e8f");
    check(exts.some((e) => e.ext === ".log"), "\u6269\u5c55\u540d\u6c47\u603b\u5305\u542b .log");

    // \u8def\u5f84\u4e0d\u5f97\u51fa\u73b0\u53cc\u53cd\u53cd\u659c\u6760 (\u76ee\u5f55\u540d\u4e0e\u76f8\u90bb\u76ee\u5f55\u4e4b\u95f4\u591a\u4e86\u4e00\u4e2a \\ )
    const allPaths = []
      .concat(res.bigfiles.map((b) => b.sample[0]))
      .concat(res.junk.map((j) => j.sample[0] || j.dir))
      .concat([res.root.path]);
    const doubled = allPaths.filter((x) => /\\\\/.test(x));
    check(doubled.length === 0, "\u8def\u5f84\u91cc\u6ca1\u6709\u53cc\u53cd\u53cd\u659c\u6760", doubled.slice(0, 2).join(" | "));
  }

  // ---------------- 8. 取消 (关键回归) ----------------
  group("\u53d6\u6d88");
  {
    // \u9020\u4e00\u68f5\u5927\u6811, \u542f\u52a8\u540e\u7acb\u5373\u53d6\u6d88
    const big2 = path.join(tmp, "bigtree");
    for (let i = 0; i < 40; i++) mkFiles(path.join(big2, "d" + i, "sub"), 40, 20000, 10);
    const p3 = new ScanPool(big2, { maxDepth: 12 });
    const promise = p3.start();
    await new Promise((r) => setTimeout(r, 60));
    const t0 = Date.now();
    p3.cancel();
    const r3 = await promise;
    const el = Date.now() - t0;
    check(el < 1500, "\u53d6\u6d88\u540e\u7acb\u5373\u8fd4\u56de (\u4e0d\u9700\u8981\u7b49\u5230\u626b\u63cf\u5b8c)", `${el} ms`);
    check(r3.summary.cancelled === true, "\u7ed3\u679c\u6807\u8bb0\u4e3a\u5df2\u53d6\u6d88");
    check(!!r3.root, "\u4ecd\u7136\u8fd4\u56de\u4e86\u90e8\u5206\u7ed3\u679c (\u4e0d\u662f\u7a7a\u767d)");
    check(p3.workers.length === 0, "worker \u7ebf\u7a0b\u5df2\u5168\u90e8\u7ec8\u6b62");
  }

  // ---------------- 8.5 Electron asar 干扰 ----------------
  group("asar 干扰");
  {
    // Electron 会把 .asar 当包解析: 合法的返回 0, 损坏的直接抛异常。
    // 两种都会让大小统计错误, 必须用 ::$DATA 绕过。
    const asarDir = path.join(tmp, "asarbox");
    fs.mkdirSync(asarDir, { recursive: true });
    const good = path.join(asarDir, "good.asar");
    const bad = path.join(asarDir, "bad.asar");
    const plain = path.join(asarDir, "plain.bin");
    const payload = Buffer.alloc(123456, 7);
    // Electron 会拦截对 .asar 的读也拦截对 .asar 的写, 创建也要用 ::$DATA 绕过
    const writeRaw = (p, data) => {
      // 优先用 ::$DATA, 避免 Electron 拦截时在 stderr 留错误
      try { fs.writeFileSync(p + "::$DATA", data); }
      catch { fs.writeFileSync(p, data); }
    };
    writeRaw(good, payload);
    writeRaw(bad, payload);          // 内容不是合法 asar, 但扩展名是 .asar
    fs.writeFileSync(plain, payload);

    const p4 = new ScanPool(asarDir, { maxDepth: 4 });
    const r4 = await p4.start();
    const total = r4.root.total;
    const expect = payload.length * 3;
    check(total === expect, "三个文件的大小都统计正确",
      `${total} == ${expect}`);
    check(r4.summary.errors === 0, "没有 asar 解析错误", String(r4.summary.errors));
    const exts4 = r4.extensions.map((e) => e.ext);
    check(exts4.includes(".asar"), "扩展名汇总里有 .asar", exts4.join(","));
  }

  // ---------------- 9. dry-run 与删除闸门 ----------------
  group("dry-run \u4e0e\u5220\u9664\u95f8\u95e8");
  {
    const victim = findNode(node, "dist").path;
    const d = await trash.dryRun([victim]);
    check(d.total > 0 && d.count === 1, "dry-run \u7edf\u8ba1\u51fa\u5927\u5c0f", String(d.total));
    check(fs.existsSync(victim), "dry-run \u4e4b\u540e\u76ee\u6807\u76ee\u5f55\u4ecd\u5728");

    const appDir = path.join(__dirname, "..");
    const { safe, rejected } = trash.guardPaths(
      ["C:\\", "D:\\", appDir, path.join(appDir, "main.js")], appDir);
    check(safe.length === 0, "\u78c1\u76d8\u6839\u76ee\u5f55 + \u5de5\u5177\u7a0b\u5e8f\u6587\u4ef6\u88ab\u62e6\u622a", `${rejected.length} \u9879`);
    const s2 = trash.guardPaths([path.join(appDir, "__pycache__")], appDir);
    check(s2.safe.length === 1, "\u5de5\u5177\u76ee\u5f55\u4e0b\u7684 __pycache__ \u4ecd\u7136\u5141\u8bb8\u6e05\u7406");
  }

  // ---------------- 10. 真实删除 (仅 Electron 环境) ----------------
  group("\u771f\u5b9e\u5220\u9664");
  const inElectron = !!(process.versions && process.versions.electron);
  if (!inElectron) {
    console.log("  [skip] \u975e Electron \u73af\u5883, \u56de\u6536\u7ad9\u5f80\u8fd4\u7531 npm run selftest \u8986\u76d6");
  } else {
    const mk = path.join(tmp, "_del_me");
    fs.mkdirSync(path.join(mk, "sub"), { recursive: true });
    fs.writeFileSync(path.join(mk, "a.bin"), Buffer.alloc(4096));
    fs.writeFileSync(path.join(mk, "sub", "b.bin"), Buffer.alloc(2048));
    const r = await trash.clean([mk], "recycle");
    check(r.ok === 1 && !r.failed.length, "\u5220\u9664\u6210\u529f", JSON.stringify(r));
    check(!fs.existsSync(mk), "\u76ee\u5f55\u5df2\u4ece\u539f\u4f4d\u7f6e\u6d88\u5931");
    const q = path.join(tmp, "_quar_me");
    fs.mkdirSync(q, { recursive: true });
    fs.writeFileSync(path.join(q, "d.bin"), Buffer.alloc(4242));
    const rq = await trash.clean([q], "quarantine");
    check(rq.ok === 1, "\u9694\u79bb\u533a\u6a21\u5f0f\u6210\u529f", JSON.stringify(rq));
    check(!fs.existsSync(q), "\u539f\u76ee\u5f55\u5df2\u79fb\u8d70");
  }

  await fsp.rm(tmp, { recursive: true, force: true });

  console.log("\n" + "=".repeat(52));
  if (FAILS.length) {
    console.log(`\u5931\u8d25 ${FAILS.length} \u9879:`);
    for (const f of FAILS) console.log("   - " + f);
    return 1;
  }
  console.log("\u5168\u90e8\u901a\u8fc7");
  return 0;
}

module.exports = { runSelftest };

// \u76f4\u63a5\u7528 node \u8dd1\u65f6\u81ea\u6d4b
if (require.main === module) {
  runSelftest().then((c) => process.exit(c));
}
