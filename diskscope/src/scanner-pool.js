"use strict";
/**
 * 扫描线程池: 主进程派活, N 个 worker 并行扫。
 *
 * 为什么要线程池而不是主进程直接扫:
 *   1. 快 —— 实测 16 worker 比单线程快 5.5 倍 (tools/bench3.js)
 *   2. 主进程不被阻塞 —— 界面永远不卡, IPC 永远有响应
 *   3. 取消是"立刻" —— 直接 terminate 线程, 不依赖任何检查点
 *
 * 树的组装在主进程做: worker 只回传"一个目录"的结果和子目录清单,
 * 主进程按 path 把节点挂到父节点上, 顺便累加直方图。
 */
const os = require("os");
const path = require("path");
const { Worker } = require("worker_threads");
const { Aggregate, MinHeap, makeNode, summarize } = require("./scanner");

const WORKER_PATH = path.join(__dirname, "scan-worker.js");

class ScanPool {
  constructor(root, opts = {}) {
    this.root = path.resolve(root);
    this.opts = opts;
    this.maxDepth = opts.maxDepth ?? 12;
    this.maxFiles = opts.maxFiles ?? 4_000_000;
    this.onProgress = opts.onProgress || null;
    this.isCancelled = opts.isCancelled || (() => false);

    const cpus = os.cpus() ? os.cpus().length : 4;
    this.workerCount = Math.max(1, Math.min(opts.workers ?? cpus, 16, cpus * 2));

    this.workers = [];
    this.nodes = new Map();          // path -> node
    this.stack = [];                 // 待派活: {dir, name, depth, parentPath}
    this.busy = new Map();           // worker -> task
    this.agg = new Aggregate();
    this.cancelled = false;
    this.finished = false;
    this._lastPush = 0;
    this._rootNode = null;
    this._id = 0;
    this._taskById = new Map();
    this._aggRequested = false;
    this._aggDone = null;
    this._resolve = null;
    this._reject = null;
    this.promise = new Promise((res, rej) => { this._resolve = res; this._reject = rej; });
  }

  start() {
    const n = this.workerCount;
    let readyCount = 0;
    for (let i = 0; i < n; i++) {
      const w = new Worker(WORKER_PATH);
      w.on("message", (m) => this._onMessage(w, m));
      w.on("error", (ex) => { this.errors = (this.errors || 0) + 1; this._checkDone(); });
      this.workers.push(w);
      w.postMessage({
        cmd: "init", root: this.root,
        opts: { maxDepth: this.maxDepth, maxFiles: this.maxFiles,
                maxSeconds: this.opts.maxSeconds ?? 900,
                excludes: this.opts.excludes || [] },
      });
      readyCount++;
    }
    // 根目录先派出去
    this.stack.push({ dir: this.root, name: path.basename(this.root) || this.root, depth: 0, parentPath: null });
    return this.promise;
  }

  _onMessage(w, m) {
    if (m.cmd === "ready") { this._dispatch(); return; }
    if (m.cmd === "result") { this._onResult(w, m); return; }
    if (m.cmd === "agg") { this._onAgg(m); return; }
  }

  _onResult(w, m) {
    if (this.finished) return;
    this.busy.delete(w);
    const task = this._taskById.get(m.id);
    this._taskById.delete(m.id);

    const node = m.node;
    this.nodes.set(m.dir, node);

    // 挂到父节点
    if (task && task.parentPath) {
      const parent = this.nodes.get(task.parentPath);
      if (parent) parent.children.push(node);
    } else {
      this._rootNode = node;
    }

    // 计数与直方图向上累加
    this.agg.files += m.delta.files;
    this.agg.bytes += m.delta.bytes;
    this.agg.dirs += m.delta.dirs;
    this.agg.errors += m.delta.errors;

    // 子目录继续派活
    const childDepth = task ? task.depth + 1 : 1;
    for (const sub of m.subs) {
      const full = m.dir + "\\" + sub;
      if (childDepth >= this.maxDepth) {
        // 触达深度上限: 建占位节点, 大小不计入
        const stub = makeNode(full, sub);
        stub.truncated = true;
        this.nodes.set(full, stub);
        const parent = this.nodes.get(m.dir);
        if (parent) parent.children.push(stub);
        this.agg.depthCapped++;
      } else {
        this.stack.push({ dir: full, name: sub, depth: childDepth, parentPath: m.dir });
      }
    }

    this._push();
    this._dispatch();
    this._checkDone();
  }

  _onAgg(m) {
    this.aggFinals = (this.aggFinals || 0) + 1;
    for (const v of m.heap) this.agg.heap.push(v);
    for (const [ext, n, bytes, recent] of m.ext) {
      let e = this.agg.byExt.get(ext);
      if (!e) { e = { n: 0, bytes: 0, recent: 0 }; this.agg.byExt.set(ext, e); }
      e.n += n; e.bytes += bytes; e.recent += recent;
    }
    this.agg.hitFileCap = this.agg.hitFileCap || m.hitFileCap;
    this.agg.hitTimeCap = this.agg.hitTimeCap || m.hitTimeCap;
    if (this._aggDone) this._aggDone();
  }

  _dispatch() {
    if (this.cancelled || this.finished) return;
    while (this.stack.length) {
      const w = this.workers.find((x) => !this.busy.has(x));
      if (!w) return;
      const task = this.stack.pop();
      const id = ++this._id;
      this._id = id;
      this._taskById.set(id, task);
      this.busy.set(w, task);
      w.postMessage({ cmd: "dir", id, dir: task.dir, name: task.name, depth: task.depth });
    }
  }

  _checkDone() {
    if (this.finished) return;
    if (this.stack.length || this.busy.size) return;   // 还有活儿
    if (this._aggRequested) return;
    // 派完了 -> 向所有 worker 收聚合数据
    this._aggRequested = true;
    const need = this.workers.length;
    let got = 0;
    this._aggDone = () => { if (++got >= need) this._finish(); };
    for (const w of this.workers) w.postMessage({ cmd: "agg" });
    // 防止 worker 崩殃时收不到回应, 占住永久
    setTimeout(() => { if (!this.finished) this._finish(); }, 2000);
  }

  _finish() {
    if (this.finished) return;
    this.finished = true;
    for (const w of this.workers) { try { w.terminate(); } catch { /* 忽略 */ } }
    this.workers = [];

    if (!this._rootNode) {
      this._rootNode = makeNode(this.root, path.basename(this.root) || this.root);
    }
    // 自底向上补齐 total / nfiles / ndirs / daily (worker 只算了自己的那层)
    const rollup = (n) => {
      let total = n.own, nfiles = n.nfiles, ndirs = 0;
      const daily = n.daily.slice();
      let mtime = n.mtime;
      for (const c of n.children) {
        const r = rollup(c);
        total += r.total; nfiles += r.nfiles; ndirs += r.ndirs + 1;
        for (let i = 0; i < daily.length; i++) daily[i] += r.daily[i];
        if (r.mtime > mtime) mtime = r.mtime;
      }
      n.total = total; n.nfiles = nfiles; n.ndirs = ndirs;
      n.daily = daily; n.mtime = mtime;
      return { total, nfiles, ndirs, daily, mtime };
    };
    rollup(this._rootNode);

    const result = summarize(this._rootNode, this.agg);
    if (this.cancelled) result.summary.cancelled = true;
    this._resolve(result);
  }

  _push() {
    if (!this.onProgress) return;
    const now = Date.now();
    if (now - this._lastPush < 150) return;
    this._lastPush = now;
    try { this.onProgress(this.agg.state(false)); } catch { /* 忽略 */ }
  }

  /**
   * 立刻中止: 直接干掉 worker 线程, 不等检查点。
   *
   * 先向已经在跑的 worker 要一次聚合数据 (给一个短暂的交账机会),
   * 这样中止后仍然能看到已扫到的大文件和扩展名汇总。
   */
  cancel() {
    if (this.finished) return;
    this.cancelled = true;
    const need = this.workers.length;
    let got = 0;
    this._aggRequested = true;
    this._aggDone = () => { if (++got >= need) this._finish(); };
    for (const w of this.workers) {
      try { w.postMessage({ cmd: "agg" }); } catch { /* worker 已退出 */ }
    }
    // 给 worker 一点时间交账, 超时就硬杀
    setTimeout(() => { if (!this.finished) this._finish(); }, 250);
  }
}

module.exports = { ScanPool };
