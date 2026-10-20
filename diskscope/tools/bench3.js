"use strict";
/** 正确分片的并行基准: 主线程派活, N 个 worker 各扫各的目录。 */
const fs = require("fs");
const path = require("path");
const { Worker, isMainThread, parentPort } = require("worker_threads");

const ROOT = process.argv[2] || "D:\\software";
const N = Number(process.argv[3] || 4);

if (!isMainThread) {
  parentPort.on("message", async (m) => {
    if (m.cmd !== "dir") return;
    const dir = m.dir;
    let files = 0, bytes = 0, subs = [], names = [];
    try {
      const ents = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of ents) {
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) subs.push(dir + "\\" + e.name);
        else if (e.isFile()) names.push(dir + "\\" + e.name);
      }
    } catch { parentPort.postMessage({ files, bytes, subs }); return; }
    for (const full of names) {
      try { const s = fs.statSync(full); files++; bytes += s.size; } catch { /* 忽略 */ }
    }
    parentPort.postMessage({ files, bytes, subs });
  });
} else {
  (async () => {
    const t0 = Date.now();
    const workers = [];
    for (let i = 0; i < N; i++) workers.push(new Worker(__filename));
    let total = { files: 0, bytes: 0, dirs: 0 };
    const stack = [ROOT];
    const pending = new Map();

    await new Promise((resolve) => {
      const dispatch = () => {
        while (stack.length) {
          const w = workers.find((x) => !pending.has(x));
          if (!w) return;
          const dir = stack.pop();
          pending.set(w, dir);
          w.postMessage({ cmd: "dir", dir });
        }
        if (pending.size === 0) resolve();
      };
      for (const w of workers) {
        w.on("message", (m) => {
          total.files += m.files; total.bytes += m.bytes; total.dirs += 1;
          for (const s of m.subs) stack.push(s);
          pending.delete(w);
          dispatch();
        });
      }
      dispatch();
    });
    for (const w of workers) w.terminate();
    const el = Date.now() - t0;
    console.log(`${String(N).padStart(2)} 个 worker: ${total.files} 文件 / ${total.dirs} 目录  用时 ${el} ms  -> ${Math.round(total.files/el*1000)} 文件/秒`);
  })();
}
