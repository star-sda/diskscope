"use strict";
/** 扫描器性能基准: 对比几种取文件信息的方式。 */
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const ROOT = process.argv[2] || "D:\\software";
const CONC = 32;

function fmt(n) {
  const u = ["B", "KB", "MB", "GB"];
  let i = 0; n = Number(n);
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(1)} ${u[i]}`;
}

/** A: fs.promises.stat + 异步池 (当前实现) */
async function statPromises(root) {
  let files = 0, bytes = 0, dirs = 0;
  const stack = [root];
  const gate = { active: 0, q: [] };
  const enter = async () => { if (gate.active < CONC) { gate.active++; return; } await new Promise(r => gate.q.push(r)); gate.active++; };
  const release = () => { gate.active--; const w = gate.q.shift(); if (w) w(); };
  async function walk(dir) {
    let ents;
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    dirs++;
    const names = [];
    for (const e of ents) {
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) stack.push(path.join(dir, e.name));
      else if (e.isFile()) names.push(e.name);
    }
    const work = names.map(async (n) => {
      try { const s = await fsp.stat(path.join(dir, n)); return s.size; }
      catch { return 0; }
    });
    const sizes = await Promise.all(work);
    for (const s of sizes) { files++; bytes += s; }
  }
  const workers = Array.from({ length: CONC }, async () => {
    while (stack.length) { const d = stack.pop(); await enter(); try { await walk(d); } finally { release(); } }
  });
  await Promise.all(workers);
  return { files, bytes, dirs };
}

/** B: fs.statSync (同步, 无 Promise 开销) */
function statSyncRec(root) {
  let files = 0, bytes = 0, dirs = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    dirs++;
    for (const e of ents) {
      if (e.isSymbolicLink()) continue;
      const full = dir + "\\" + e.name;
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) {
        try { const s = fs.statSync(full); files++; bytes += s.size; } catch { /* 忽略 */ }
      }
    }
  }
  return { files, bytes, dirs };
}

/** C: readdirSync + statSync, 但用 Buffer/字符串拼接避免 path.join */
function statSyncConcat(root) {
  let files = 0, bytes = 0, dirs = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    dirs++;
    for (const e of ents) {
      if (e.isSymbolicLink()) continue;
      const full = dir + "\\" + e.name;
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) {
        try { const s = fs.statSync(full); files++; bytes += s.size; } catch { /* 忽略 */ }
      }
    }
  }
  return { files, bytes, dirs };
}

(async () => {
  console.log("目标: " + ROOT + "\n");
  let t = Date.now();
  const a = await statPromises(ROOT);
  const ta = Date.now() - t;
  console.log(`A) fs.promises.stat + 异步池 (当前实现)`);
  console.log(`   ${a.files} 文件 / ${a.dirs} 目录 / ${fmt(a.bytes)}  用时 ${ta} ms  -> ${Math.round(a.files / ta * 1000)} 文件/秒\n`);

  t = Date.now();
  const b = statSyncRec(ROOT);
  const tb = Date.now() - t;
  console.log(`B) fs.statSync (同步)`);
  console.log(`   ${b.files} 文件 / ${b.dirs} 目录 / ${fmt(b.bytes)}  用时 ${tb} ms  -> ${Math.round(b.files / tb * 1000)} 文件/秒\n`);

  console.log(`对比 B 相对 A 提速: ${(ta / tb).toFixed(2)}x`);
})();
