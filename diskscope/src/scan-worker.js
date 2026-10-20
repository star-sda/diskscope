"use strict";
/**
 * 扫描 worker 线程入口。
 *
 * 每个 worker 领一个目录, 扫完把结果和"子目录清单"发回主进程;
 * 主进程再把子目录派给空闲的 worker。这样天然是动态负载均衡 ——
 * 目录大的 worker 干得多, 目录小的早早空出来去接新活。
 */
const { parentPort } = require("worker_threads");
const { Scanner } = require("./scanner");

let sc = null;
let last = { files: 0, bytes: 0, dirs: 0, errors: 0 };

parentPort.on("message", (m) => {
  if (m.cmd === "init") {
    sc = new Scanner(m.root, m.opts);
    parentPort.postMessage({ cmd: "ready" });
    return;
  }
  if (m.cmd === "dir") {
    if (!sc) return;
    let res;
    try {
      res = sc.scanOne(m.dir, m.name, m.depth);
    } catch (ex) {
      parentPort.postMessage({
        cmd: "result", id: m.id, dir: m.dir,
        node: { path: m.dir, name: m.name, total: 0, own: 0, nfiles: 0, ndirs: 0,
                daily: new Array(31).fill(0), mtime: 0, children: [], junk: [],
                error: `${ex.name}: ${ex.message}`, truncated: false },
        subs: [], delta: { files: 0, bytes: 0, dirs: 0, errors: 1 },
      });
      return;
    }
    const a = sc.agg;
    const delta = {
      files: a.files - last.files, bytes: a.bytes - last.bytes,
      dirs: a.dirs - last.dirs, errors: a.errors - last.errors,
    };
    last = { files: a.files, bytes: a.bytes, dirs: a.dirs, errors: a.errors };
    parentPort.postMessage({ cmd: "result", id: m.id, dir: m.dir, node: res.node, subs: res.subs, delta });
    return;
  }
  if (m.cmd === "agg") {
    // 收尾: 把这个 worker 的最终聚合交回主进程合并
    const a = sc ? sc.agg : null;
    parentPort.postMessage({
      cmd: "agg",
      heap: a ? a.heap.sortedDesc() : [],
      ext: a ? [...a.byExt.entries()].map(([k, v]) => [k, v.n, v.bytes, v.recent]) : [],
      files: a ? a.files : 0, bytes: a ? a.bytes : 0, dirs: a ? a.dirs : 0,
      errors: a ? a.errors : 0, depthCapped: a ? a.depthCapped : 0,
      hitFileCap: a ? a.hitFileCap : false, hitTimeCap: a ? a.hitTimeCap : false,
    });
    return;
  }
  if (m.cmd === "stop") process.exit(0);
});
