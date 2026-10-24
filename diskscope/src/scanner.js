"use strict";
/**
 * 目录扫描核心。
 *
 * 分成两层:
 *   Scanner.scanOne()  只负责"一个目录": 读它的文件、列出它的子目录, 不递归。
 *                       递归由外部驱动 (scanner-pool.js 用 worker 线程池并行驱动)。
 *
 * 这么拆是因为两个原因:
 *   1. 快 —— 实测多 worker 并行比单线程快 5.5 倍 (见 tools/bench3.js)。
 *   2. 取消干净 —— 取消 = 直接 terminate worker 线程, 立刻生效, 不依赖任何检查点。
 *
 * 关键设计 (和之前的 Python 版一致):
 *   - 内存与"目录数"成正比, 不是"文件数"。文件只累加计数器, 只有目录创建节点。
 *   - 时间轴是滚动相加的: 每个目录存 31 格直方图 (第 0 格=今天, 最后一格=30天前的冷数据),
 *     自底向上逐层相加, 于是任意层级都能 O(1) 回答"这里最近 7 天长了多少"。
 */
const fs = require("fs");
const path = require("path");
const { DIR_RULES, FILE_RULES, isHardSkip } = require("./rules");

const DAYS = 30;
const NDAYS = DAYS + 1;
const MAX_TRACKED_JUNK_FILES = 2000;
const MAX_CHILDREN_IN_JSON = 200;
const TOP_BIG_FILES = 200;
const DAY_SEC = 86400;

const daySlot = (ageDays) => (ageDays >= DAYS ? DAYS : Math.floor(ageDays));

/* ------------------------------------------------------------------ *
 * 有界小顶堆: 只留最大的 N 个文件。堆顶永远是 Top-N 里最小的那个,
 * 新文件比它还小就丢弃, 所以内存恒定在 N 条, 与扫描总量无关。
 * ------------------------------------------------------------------ */
class MinHeap {
  constructor(cap) { this.a = []; this.cap = cap; }
  push(v) {
    const a = this.a;
    if (a.length < this.cap) { a.push(v); this._up(a.length - 1); }
    else if (v[0] > a[0][0]) { a[0] = v; this._down(0); }
  }
  _less(i, j) {
    const x = this.a[i], y = this.a[j];
    return x[0] < y[0] || (x[0] === y[0] && x[1] < y[1]);
  }
  _up(i) {
    const a = this.a;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this._less(i, p)) break;
      const t = a[i]; a[i] = a[p]; a[p] = t; i = p;
    }
  }
  _down(i) {
    const a = this.a, n = a.length;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < n && this._less(l, m)) m = l;
      if (r < n && this._less(r, m)) m = r;
      if (m === i) break;
      const t = a[i]; a[i] = a[m]; a[m] = t; i = m;
    }
  }
  sortedDesc() { return this.a.slice().sort((x, y) => y[0] - x[0]); }
  static merge(heaps, cap) {
    const h = new MinHeap(cap);
    for (const x of heaps) for (const v of x.a) h.push(v);
    return h;
  }
}

/* ------------------------------------------------------------------ *
 * 节点
 * ------------------------------------------------------------------ */
function makeNode(p, name) {
  return {
    path: p, name, isDir: true,
    total: 0, own: 0, nfiles: 0, ndirs: 0,
    daily: new Array(NDAYS).fill(0),
    mtime: 0,                 // 秒, 前端按秒算
    children: [], junk: [], error: "", truncated: false,
  };
}

function toDict(n, cap = MAX_CHILDREN_IN_JSON) {
  const d = {
    name: n.name, path: n.path, total: n.total, nfiles: n.nfiles, ndirs: n.ndirs,
    daily: n.daily, mtime: n.mtime, junk: n.junk,
  };
  if (n.error) d.error = n.error;
  if (n.truncated) d.truncated = true;
  if (n.isDir && n.children.length) {
    const kids = n.children.slice().sort((a, b) => b.total - a.total).slice(0, cap);
    d.children = kids.map((c) => toDict(c, cap));
    if (n.children.length > cap) {
      d.rest = {
        name: "其他目录",
        count: n.children.length - cap,
        total: n.children.reduce((s, c) => s + c.total, 0) -
               kids.reduce((s, c) => s + c.total, 0),
      };
    }
  }
  return d;
}

/**
 * 取文件元数据。
 *
 * Electron 会把"路径最后一个扩展名是 asar 的文件"当成 asar 包来解析:
 *   合法的 asar -> statSync 返回 0 (把包根当成虚拟目录)
 *   损坏的 asar -> statSync 直接抛 "Invalid package"
 * 结果就是: 所有 .asar 文件的大小都统计不准 (盘总量偏小), 而且 stderr 刷一堆错误。
 *
 * 绕过办法: 加 NTFS 备用数据流后缀 ::$DATA (指向文件本体),
 * 这样路径最后的扩展名变成 DATA, Electron 就不会去解析 asar 了。
 * 非 NTFS 文件系统上这个后缀无效, 所以保留退回。
 */
function statFile(fullPath) {
  if (/\.asar$/i.test(fullPath)) {
    try { return fs.statSync(fullPath + "::$DATA"); } catch { /* 退回普通方式 */ }
  }
  return fs.statSync(fullPath);
}

/* ------------------------------------------------------------------ *
 * 全局聚合器: 每个 worker 各有一个, 最后由主进程合并
 * ------------------------------------------------------------------ */
class Aggregate {
  constructor() {
    this.heap = new MinHeap(TOP_BIG_FILES);
    this.byExt = new Map();
    this.files = 0; this.bytes = 0; this.dirs = 0; this.errors = 0;
    this.depthCapped = 0; this.hitFileCap = false; this.hitTimeCap = false;
    this.t0 = Date.now();
  }
  absorb(other) {
    for (const v of other.heap.a) this.heap.push(v);
    for (const [ext, v] of other.byExt) {
      let e = this.byExt.get(ext);
      if (!e) { e = { n: 0, bytes: 0, recent: 0 }; this.byExt.set(ext, e); }
      e.n += v.n; e.bytes += v.bytes; e.recent += v.recent;
    }
    this.files += other.files; this.bytes += other.bytes; this.dirs += other.dirs;
    this.errors += other.errors; this.depthCapped += other.depthCapped;
    this.hitFileCap = this.hitFileCap || other.hitFileCap;
    this.hitTimeCap = this.hitTimeCap || other.hitTimeCap;
    this.t0 = Math.min(this.t0, other.t0);
  }
  state(done = false) {
    const el = (Date.now() - this.t0) / 1000;
    return {
      files: this.files, dirs: this.dirs, bytes: this.bytes,
      elapsed: el, rate: el > 0.05 ? this.bytes / el : 0,
      done, hitFileCap: this.hitFileCap, hitTimeCap: this.hitTimeCap,
      depthCapped: this.depthCapped, errors: this.errors,
    };
  }
  topFiles() { return this.heap.sortedDesc(); }
  extensions() {
    return [...this.byExt.entries()]
      .map(([ext, v]) => ({ ext, count: v.n, bytes: v.bytes, recent: v.recent }))
      .sort((a, b) => b.bytes - a.bytes);
  }
}

/* ------------------------------------------------------------------ *
 * 扫描器
 * ------------------------------------------------------------------ */
class Scanner {
  constructor(root, opts = {}) {
    this.root = path.resolve(root);
    this.maxDepth = opts.maxDepth ?? 12;
    this.maxFiles = opts.maxFiles ?? 4_000_000;
    this.maxSeconds = opts.maxSeconds ?? 900;
    this.isCancelled = opts.isCancelled || (() => false);

    const ex = (opts.excludes || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
    this.excludeNames = new Set(ex.filter((s) => !s.includes("*") && !s.includes("?")));
    this.excludeGlobs = ex.filter((s) => s.includes("*") || s.includes("?"));

    this.agg = new Aggregate();
    this._refTime = Date.now() / 1000;
    this.deadline = this._refTime + this.maxSeconds;
  }

  _excluded(name) {
    if (isHardSkip(name)) return true;
    const ln = name.toLowerCase();
    if (this.excludeNames.has(ln)) return true;
    for (const g of this.excludeGlobs) if (globMatch(ln, g)) return true;
    return false;
  }

  _stopped() {
    if (this.isCancelled()) return true;
    if (Date.now() / 1000 > this.deadline) { this.agg.hitTimeCap = true; return true; }
    return false;
  }

  /**
   * 扫一个目录 (不递归)。
   * 返回 { node, subs } —— subs 是子目录名列表, 由外部决定怎么派活。
   *
   * 这里用同步 IO: 扫描跑在专用 worker 线程里, 阻塞该线程不会影响主进程,
   * 而省掉 Promise/线程池的往返开销实测快 1.4 倍。
   */
  scanOne(dirPath, name, depth) {
    const node = makeNode(dirPath, name);
    const agg = this.agg;

    // 这个目录本身是不是垃圾目录?
    for (const r of DIR_RULES) {
      let hit = false;
      try { hit = r.test(r.match === "regex" ? dirPath : name); } catch { hit = false; }
      if (hit) {
        node.junk.push({
          rule: r.id, label: r.label, why: r.why || "",
          level: r.level, kind: "dir",
        });
      }
    }

    let entries;
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch (ex) {
      node.error = `${ex.code || ex.name}: ${ex.message}`;
      agg.errors++;
      return { node, subs: [] };
    }

    const subs = [];
    const fileNames = [];
    for (const e of entries) {
      const nm = e.name;
      if (e.isSymbolicLink()) continue;            // 跳过软链/联接, 避免环路
      if (e.isDirectory()) {
        if (!this._excluded(nm)) subs.push(nm);
      } else if (e.isFile()) {
        fileNames.push(nm);
      }
    }

    // ---- 直属文件 ----
    const nowSec = Date.now() / 1000;
    let own = 0, nf = 0, newest = 0;
    const sizes = new Map();

    for (const fn of fileNames) {
      if (this._stopped()) break;
      // 用 path.join 而不是字符串相加: 根目录 "D:\" 本身就带尾随分隔符,
      // 直接拼会得到 "D:\\software" 这种双反斜杠的路径
      const full = path.join(dirPath, fn);
      let st;
      try { st = statFile(full); } catch { agg.errors++; continue; }
      sizes.set(fn, st.size);
      own += st.size; nf++;
      const mt = st.mtimeMs / 1000;
      if (mt > newest) newest = mt;
      node.daily[daySlot(Math.max(0, (nowSec - mt) / DAY_SEC))] += st.size;

      agg.files++; agg.bytes += st.size;
      if (agg.files >= this.maxFiles) { agg.hitFileCap = true; break; }
      agg.heap.push([st.size, full, mt]);

      const dot = fn.lastIndexOf(".");
      const ext = (dot > 0 ? fn.slice(dot) : "").toLowerCase() || "(无扩展名)";
      let e = agg.byExt.get(ext);
      if (!e) { e = { n: 0, bytes: 0, recent: 0 }; agg.byExt.set(ext, e); }
      e.n++; e.bytes += st.size;
      if (nowSec - mt < 30 * DAY_SEC) e.recent += st.size;
    }

    // ---- 垃圾文件分组 ----
    if (FILE_RULES.length && fileNames.length) {
      for (const r of FILE_RULES) {
        const hits = fileNames.filter((n) => r.test(n));
        if (!hits.length) continue;
        const shown = hits.slice(0, MAX_TRACKED_JUNK_FILES);
        let tot = 0;
        for (const h of shown) tot += sizes.get(h) || 0;
        const e = {
          rule: r.id, label: r.label, why: r.why || "", level: r.level,
          kind: "files", dir: dirPath, count: hits.length, size: tot,
          sample: shown.slice(0, 20).map((h) => path.join(dirPath, h)),
        };
        if (hits.length > shown.length) e.pathsTruncated = true;
        node.junk.push(e);
      }
    }

    node.total = own;
    node.own = own;
    node.nfiles = nf;
    node.mtime = newest;
    agg.dirs++;
    return { node, subs };
  }
}

/** 极简 glob: 支持 * 和 ? (排除项用)。 */
function globMatch(s, pat) {
  let re = "";
  for (const c of pat) re += c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("^" + re + "$").test(s);
}

/* ------------------------------------------------------------------ *
 * 结果打包 (结构与 Python 版 scan_summary 一致, 前端不用改)
 * ------------------------------------------------------------------ */
function summarize(node, agg) {
  const flat = [];
  (function walk(n) {
    for (const j of n.junk) {
      const e = Object.assign({}, j);
      if (e.kind === "dir") {
        e.size = n.total;
        e.count = 1;
        e.sample = [n.path];
        e.key = `${e.rule}:dir:${n.path}`;
      } else {
        e.key = `${e.rule}:files:${e.dir || n.path}`;
      }
      e.mtime = n.mtime;
      e.dir = e.dir || n.path;
      flat.push(e);
    }
    for (const c of n.children) walk(c);
  })(node);
  flat.sort((a, b) => (b.size || 0) - (a.size || 0));

  const bigfiles = agg.topFiles().map(([size, fpath, mt]) => ({
    rule: "big_file", label: "大文件",
    why: "单个占用较大的文件, 删掉后无法自动重建",
    level: "caution", kind: "file",
    size, count: 1, sample: [fpath], dir: path.dirname(fpath),
    mtime: mt, ext: path.extname(fpath).toLowerCase() || "(无扩展名)",
    key: "bigfile:" + fpath,
  }));

  const st = agg.state(true);
  return {
    root: toDict(node),
    junk: flat.slice(0, 3000),
    junkTotal: flat.length,
    bigfiles,
    extensions: agg.extensions(),
    summary: {
      bytes: st.bytes, files: st.files, dirs: st.dirs, elapsed: st.elapsed,
      errors: st.errors, hitFileCap: st.hitFileCap, hitTimeCap: st.hitTimeCap,
      depthCapped: st.depthCapped, days: DAYS,
    },
  };
}

module.exports = {
  Scanner, Aggregate, MinHeap, summarize, toDict, makeNode, statFile,
  NDAYS, DAYS, TOP_BIG_FILES, globMatch,
};
