"use strict";
/**
 * \u6784\u5efa\u540e\u5904\u7406: \u5199\u5165\u56fe\u6807\u4e0e\u7248\u672c\u4fe1\u606f\u3002
 *
 * \u4e3a\u4ec0\u4e48\u81ea\u5df1\u505a: electron-builder \u81ea\u5df1\u4e5f\u7528 rcedit \u505a\u8fd9\u4ef6\u4e8b,
 * \u4f46\u5b83\u7684\u8c03\u7528\u65f6\u673a\u4e0d\u5bf9 \u2014\u2014 \u521a\u5199\u5b8c\u90a3\u4e2a 180MB \u7684 exe \u7acb\u523b\u5c31\u53bb\u6539\u5b83,
 * \u7ecf\u5e38\u56e0\u4e3a\u6587\u4ef6\u88ab\u5360\u7528 (Defender \u626b\u63cf\u7b49) \u800c\u5931\u8d25,
 * \u4e14\u5931\u8d25\u4f1a\u76f4\u63a5\u628a\u6574\u4e2a\u6784\u5efa\u62c9\u574f\u3002
 *
 * \u8fd9\u91cc\u6211\u4eec\u4e3b\u52a8\u7b49\u4e00\u4e0b\u518d\u6539, \u5e76\u81ea\u5df1\u505a\u91cd\u8bd5\u3002
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const ICON = path.join(ROOT, "build", "icon.ico");
const DESC = "\u76ee\u5f55\u4f53\u79ef + \u65f6\u95f4\u8f74\u6e05\u7406\u5668";
const VERSION = require(path.join(ROOT, "package.json")).version;

/** \u5728 winCodeSign \u7f13\u5b58\u91cc\u627e rcedit\u3002 */
function findRcedit() {
  const cache = path.join(process.env.LOCALAPPDATA || "", "electron-builder", "Cache", "winCodeSign");
  const hits = [];
  const walk = (d) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === "rcedit-x64.exe") hits.push(p);
    }
  };
  walk(cache);
  return hits[0] || null;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function rcedit(rceditExe, target, args, tries) {
  for (let i = 1; i <= tries; i++) {
    try {
      execFileSync(rceditExe, [target, ...args], { stdio: "pipe" });
      return true;
    } catch (ex) {
      const msg = ((ex.stderr || Buffer.from("")) + "").trim();
      if (i >= tries) {
        console.log(`  \u2717 ${path.basename(target)}  ${msg || ex.message}`);
        return false;
      }
      const wait = Math.min(600 * i, 4000);
      console.log(`  \u21bb \u91cd\u8bd5 ${i}/${tries} (${wait}ms) ${path.basename(target)}`);
      sleep(wait);
    }
  }
  return false;
}

function main() {
  const rceditExe = findRcedit();
  if (!rceditExe) {
    console.log("  \u8df3\u8fc7: \u672a\u627e\u5230 rcedit");
    return 0;
  }
  if (!fs.existsSync(ICON)) {
    console.log("  \u8df3\u8fc7: \u7f3a\u5c11 build/icon.ico");
    return 0;
  }

  // 只处\u7406 win-unpacked \u91cc\u7684\u5e94\u7528 exe\u3002
  //
  // 绝\u4e0d\u8981\u5bf9 NSIS \u5b89\u88c5\u7a0b\u5e8f/\u7eff\u8272\u7248\u8fd0\u884c rcedit:
  // \u5b83\u4eec\u662f NSIS \u6253\u5305\u7684, \u538b\u7f29\u8f7d\u8377\u4f5c\u4e3a PE overlay \u8ffd\u52a0\u5728\u6587\u4ef6\u5c3e\u90e8,
  // rcedit \u91cd\u5199 PE \u8d44\u6e90\u65f6\u4f1a\u628a\u90a3\u5757 overlay \u4e22\u6389 \u2014\u2014 \u7ed3\u679c\u662f 78MB \u7684\u5b89\u88c5\u7a0b\u5e8f\u88ab\u526a\u6210 60KB \u7a7a\u58f3\u3002
  // \u5b83\u4eec\u7684\u56fe\u6807\u548c\u7248\u672c\u4fe1\u606f\u7531 electron-builder \u7684 NSIS \u6b65\u9aa4\u8d1f\u8d23, \u4e0d\u7528\u6211\u4eec\u5173\u5fc3\u3002
  const targets = [];
  const unpacked = path.join(DIST, "win-unpacked", "DiskScope.exe");
  if (fs.existsSync(unpacked)) targets.push(unpacked);
  if (!targets.length) { console.log("  \u8df3\u8fc7: dist/win-unpacked \u4e0b\u6ca1\u6709 DiskScope.exe"); return 0; }

  let ok = 0;
  for (const t of targets) {
    const good = rcedit(rceditExe, t, [
      "--set-version-string", "FileDescription", DESC,
      "--set-version-string", "ProductName", "DiskScope",
      "--set-version-string", "LegalCopyright", "DiskScope",
      "--set-version-string", "InternalName", "DiskScope",
      "--set-version-string", "OriginalFilename", "DiskScope.exe",
      "--set-file-version", VERSION,
      "--set-product-version", VERSION + ".0",
      "--set-icon", ICON,
    ], 8);
    if (good) { ok++; console.log(`  \u2713 ${path.basename(t)}`); }
  }
  console.log(`  \u56fe\u6807/\u7248\u672c\u4fe1\u606f\u5199\u5165: ${ok}/${targets.length}`);
  return ok === targets.length ? 0 : 1;
}

process.exit(main());
