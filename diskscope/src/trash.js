"use strict";
/**
 * 安全删除。三种模式:
 *   recycle    回收站 (可还原) —— 走 Electron 内置 shell.trashItem
 *   quarantine 隔离区 (只改名不删) —— 回收站不可用时的降级方案
 *   permanent  真正删除 —— 必须显式指定
 *
 * trashItem 依赖 electron, 所以延迟 require: 这样 dryRun 和 guardPaths 在
 * 纯 Node 环境 (单测) 下也能跑。
 */
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const QUARANTINE_DIR = ".diskscope_quarantine";

/** 最后一道闸门: 磁盘根目录、工具自身所在目录、工具的程序文件一律拒绝。 */
function guardPaths(paths, appDir) {
  const app = path.resolve(appDir);
  const protectedSet = new Set(
    ["server.py", "scanner.py", "rules.py", "trash.js", "rules.gen.js",
     "main.js", "preload.js", "selftest.py", "run.bat", "README.md"]
      .map((f) => path.join(app, f).toLowerCase())
  );
  protectedSet.add(path.join(app, "static").toLowerCase());

  const safe = [], rejected = [];
  for (const p of paths || []) {
    if (!p) continue;
    const ap = path.resolve(p);
    const parsed = path.parse(ap);
    if (!parsed.root || parsed.root === ap || parsed.dir === ap) {
      rejected.push([p, "拒绝操作磁盘根目录"]);
      continue;
    }
    const low = ap.toLowerCase();
    if (low === app.toLowerCase()) {
      rejected.push([p, "拒绝操作 DiskScope 自身所在目录"]);
      continue;
    }
    if (protectedSet.has(low)) {
      rejected.push([p, "拒绝操作 DiskScope 的程序文件"]);
      continue;
    }
    safe.push(ap);
  }
  return { safe, rejected };
}

/** 不碰磁盘, 只统计将要发生什么。 */
async function dryRun(paths) {
  const items = [];
  let total = 0;
  for (const p of paths) {
    let exists = true, size = 0, count = 0;
    try {
      const st = await fsp.lstat(p);
      if (st.isDirectory()) {
        let sub = 0, n = 0;
        const walk = async (dir) => {
          let ents;
          try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
          for (const e of ents) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) await walk(full);
            else {
              try {
                const s = await fsp.stat(full);
                sub += s.size; n++;
              } catch { /* 忽略 */ }
            }
          }
        };
        await walk(p);
        size = sub; count = n;
      } else {
        size = st.size; count = 1;
      }
    } catch {
      exists = false;
    }
    total += size;
    items.push({ path: p, exists, size, count });
  }
  return { mode: "dry-run", total, count: items.length, items };
}

/** 隔离区候选目录: 优先目标所在卷的根 (同卷改名, 瞬间完成)。 */
function quarantineRoots(targets) {
  const stamp = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const tag = `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}_` +
              `${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`;
  const cands = [];
  if (targets.length) {
    const root = path.parse(path.resolve(targets[0])).root;
    cands.push(path.join(root, QUARANTINE_DIR, tag));
  }
  cands.push(path.join(process.env.LOCALAPPDATA || process.env.TEMP || ".", QUARANTINE_DIR, tag));
  return cands;
}

async function makeQuarantine(targets) {
  let last = null;
  for (const cand of quarantineRoots(targets)) {
    try {
      await fsp.mkdir(cand, { recursive: true });
      const probe = path.join(cand, ".writable");
      await fsp.writeFile(probe, "x");
      await fsp.unlink(probe);
      return cand;
    } catch (ex) { last = ex; }
  }
  throw new Error(`找不到可写的隔离区目录: ${last && last.message}`);
}

async function toRecycleBin(paths) {
  const { shell } = require("electron");
  let ok = 0; const failed = [];
  for (const p of paths) {
    try {
      await shell.trashItem(p);
      ok++;
    } catch (ex) { failed.push([p, `${ex.name}: ${ex.message}`]); }
  }
  return { ok, failed };
}

async function toQuarantine(paths) {
  const root = await makeQuarantine(paths);
  let ok = 0; const failed = [];
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i];
    try {
      let flat = path.resolve(p).replace(/^[a-z]:[\\/]/i, "").replace(/[\\/:]/g, "__");
      flat = flat.slice(0, 110) || `item_${i}`;
      let dest = path.join(root, flat);
      if (fs.existsSync(dest)) dest = path.join(root, `${i}_${path.basename(p).slice(0, 60)}`);
      try {
        await fsp.rename(p, dest);          // 同卷: 瞬间完成, 不复制数据
      } catch {
        await fsp.cp(p, dest, { recursive: true });   // 跨卷: 复制后再删源
        await fsp.rm(p, { recursive: true, force: true });
      }
      ok++;
    } catch (ex) { failed.push([p, `${ex.name}: ${ex.message}`]); }
  }
  return { ok, failed };
}

async function clean(paths, mode = "recycle") {
  const list = (paths || []).filter(Boolean);
  if (!list.length) {
    return { mode, ok: 0, failed: [], items: 0, totalFreed: 0 };
  }
  if (mode === "permanent") {
    let ok = 0; const failed = [];
    for (const p of list) {
      try {
        await fsp.rm(p, { recursive: true, force: true });
        ok++;
      } catch (ex) { failed.push([p, `${ex.name}: ${ex.message}`]); }
    }
    return { mode, ok, failed, items: list.length };
  }
  if (mode === "quarantine") {
    const { ok, failed } = await toQuarantine(list);
    return { mode, ok, failed, items: list.length };
  }
  // recycle: 失败则降级到隔离区
  const r = await toRecycleBin(list);
  if (r.failed.length) {
    const left = r.failed.map(([p]) => p).filter((p) => fs.existsSync(p));
    if (left.length) {
      const q = await toQuarantine(left);
      return {
        mode: "recycle+quarantine", ok: r.ok + q.ok,
        failed: r.failed.filter(([p]) => !left.includes(p)).concat(q.failed),
        items: list.length,
        note: "部分路径回收站不可用, 已移入隔离区",
      };
    }
  }
  return { mode, ok: r.ok, failed: r.failed, items: list.length };
}

module.exports = { dryRun, clean, guardPaths, quarantineRoots };
