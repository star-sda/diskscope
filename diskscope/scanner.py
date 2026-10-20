# -*- coding: utf-8 -*-
"""并行目录扫描器: 体积聚合 + 30 天日粒度时间轴 + 构建垃圾识别。

设计要点:
  * 只有"目录"创建 Node, 文件只累加计数器 —— 内存占用与目录数成正比而非
    文件数成正比, 扫几百万文件的仓库也不会 OOM。
  * 每个目录记录 30 格 daily 直方图 (第 0 格=今天) + 1 格"冷数据",
    自底向上滚动相加, 于是任意层级都能 O(1) 回答"最近 7 天长了多少"。
  * 全局共享一个线程池并发遍历, 避免每层目录各建一次池。
"""
from __future__ import annotations

import fnmatch
import heapq
import os
import time
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

import rules

DAYS = 30                        # 时间轴窗口: 最近 30 天, 每天一格
NDAYS = DAYS + 1                 # 最后一格 = 30 天以前的冷数据
MAX_TRACKED_JUNK_FILES = 2000    # 每条文件规则最多记住多少个路径 (防止内存爆)
MAX_CHILDREN_IN_JSON = 200       # 每层最多输出多少个子节点
TOP_BIG_FILES = 200              # 记住最大的 N 个文件 (有界堆, 内存恒定)


@dataclass
class Node:
    path: str
    name: str
    is_dir: bool = True
    total: int = 0        # 子树总字节 (目录) / 文件字节 (文件)
    own: int = 0          # 本层直属文件字节
    nfiles: int = 0       # 子树文件数
    ndirs: int = 0        # 子树子目录数
    daily: list = field(default_factory=lambda: [0] * NDAYS)
    mtime: float = 0.0    # 子树内最新 mtime
    children: list = field(default_factory=list)
    junk: list = field(default_factory=list)   # 本目录命中的垃圾规则
    error: str = ""
    truncated: bool = False   # 触达深度上限, 大小未计入

    def to_dict(self, cap: int = MAX_CHILDREN_IN_JSON):
        d = {
            "name": self.name, "path": self.path, "total": self.total,
            "nfiles": self.nfiles, "ndirs": self.ndirs,
            "daily": self.daily, "mtime": self.mtime, "junk": self.junk,
        }
        if self.error:
            d["error"] = self.error
        if self.truncated:
            d["truncated"] = True
        if self.is_dir and self.children:
            kids = sorted(self.children, key=lambda c: c.total, reverse=True)[:cap]
            d["children"] = [c.to_dict(cap) for c in kids]
            if len(self.children) > cap:
                d["rest"] = {
                    "count": len(self.children) - cap,
                    "total": sum(c.total for c in self.children[cap:]),
                    "name": "其他目录",
                }
        return d


def _day_slot(age_days: float) -> int:
    return DAYS if age_days >= DAYS else int(age_days)


class Scanner:
    def __init__(self, root, max_depth=12, excludes=(), max_files=4_000_000,
                 max_seconds=900.0, on_progress=None, cancel_event=None):
        self.root = os.path.abspath(root)
        self.max_depth = max_depth
        self.exclude_names = {e.strip().lower() for e in excludes
                              if e and e.strip() and "*" not in e and "?" not in e}
        self.exclude_globs = [e.strip() for e in excludes
                              if e and e.strip() and ("*" in e or "?" in e)]
        self.max_files = max_files
        self.max_seconds = max_seconds
        self.on_progress = on_progress
        self.cancel_event = cancel_event or threading.Event()

        self._lock = threading.Lock()
        self._ref_time = time.time()          # 判定"多久没动"的基准时刻
        self._heap = []                       # (size, path, mtime) 的有界小顶堆
        self.by_ext = {}                      # 扩展名 -> [个数, 字节, 30天内写入字节]
        self.nfiles = 0
        self.nbytes = 0
        self.ndirs = 0
        self.hit_file_cap = False
        self.hit_time_cap = False
        self.depth_capped = 0
        self.errors = 0
        self._t0 = time.monotonic()
        self._last_push = 0.0
        self._deadline = self._t0 + max_seconds

        matchers = rules.build_matchers()
        self.dir_rules = [(r, f) for r, f in matchers if not r.get("is_file")]
        self.file_rules = [(r, f) for r, f in matchers if r.get("is_file")]

    # ---------------- 内部工具 ----------------

    def _excluded(self, name: str) -> bool:
        if name in rules.HARD_SKIP_NAMES:
            return True
        ln = name.lower()
        if ln in self.exclude_names:
            return True
        for g in self.exclude_globs:
            if fnmatch.fnmatchcase(ln, g.lower()):
                return True
        return False

    def _push(self, force=False):
        now = time.monotonic()
        if force or (self.on_progress and now - self._last_push > 0.15):
            self._last_push = now
            try:
                self.on_progress(self.state())
            except Exception:
                pass

    def _stopped(self) -> bool:
        if self.cancel_event.is_set():
            return True
        if time.monotonic() > self._deadline:
            self.hit_time_cap = True
            return True
        return False

    def _count_file(self, st, full_path, fname):
        """累计全局计数, 并顺手把文件喂给"大文件堆"和"按扩展名"两个收集器。

        大文件用有界小顶堆维护: 堆顶始终是当前 Top-N 里最小的那个, 新文件
        比它还小就直接扔掉, 所以无论扫多少文件, 内存都恒定在 N 条。
        """
        size, mt = st.st_size, st.st_mtime
        ext = os.path.splitext(fname)[1].lower() or "(无扩展名)"
        recent = (self._ref_time - mt) < 30 * 86400
        with self._lock:
            self.nfiles += 1
            self.nbytes += size
            if self.nfiles >= self.max_files:
                self.hit_file_cap = True
                self.cancel_event.set()

            h = self._heap
            if len(h) < TOP_BIG_FILES:
                heapq.heappush(h, (size, full_path, mt))
            elif size > h[0][0]:
                heapq.heapreplace(h, (size, full_path, mt))

            e = self.by_ext.get(ext)
            if e is None:
                e = self.by_ext[ext] = [0, 0, 0]
            e[0] += 1
            e[1] += size
            if recent:
                e[2] += size
        return size, mt

    def top_files(self):
        """最大的 N 个文件, 从大到小。"""
        with self._lock:
            items = list(self._heap)
        items.sort(key=lambda x: -x[0])
        return items

    def extensions(self):
        """按扩展名汇总, 从占用大到小。"""
        with self._lock:
            src = [(k, v[0], v[1], v[2]) for k, v in self.by_ext.items()]
        src.sort(key=lambda x: -x[2])
        return src

    def state(self):
        el = time.monotonic() - self._t0
        return {
            "files": self.nfiles, "dirs": self.ndirs, "bytes": self.nbytes,
            "elapsed": el, "rate": self.nbytes / el if el > 0.05 else 0,
            "done": False, "hit_file_cap": self.hit_file_cap,
            "hit_time_cap": self.hit_time_cap, "depth_capped": self.depth_capped,
            "errors": self.errors,
        }

    def _match_file_rules(self, names):
        """返回 [(rule, [命中的文件名])]。"""
        out = []
        for r, fn in self.file_rules:
            hits = [n for n in names if _safe(fn, n)]
            if hits:
                out.append((r, hits))
        return out

    # ---------------- 主遍历 ----------------

    def _walk(self, path, name, depth, pool):
        node = Node(path=path, name=name, is_dir=True)

        # 这个目录本身是不是垃圾目录?
        for r, fn in self.dir_rules:
            try:
                hit = fn(path) if r["match"] == "regex" else fn(name)
            except Exception:
                hit = False
            if hit:
                node.junk.append({"rule": r["id"], "label": r["label"],
                                  "why": r.get("why", ""), "level": r["level"],
                                  "kind": "dir"})

        subdirs = []
        file_names = []
        try:
            with os.scandir(path) as it:
                for e in it:
                    try:
                        if e.is_symlink():
                            continue                      # 跳过软链/联接, 避免环路
                        if e.is_dir(follow_symlinks=False):
                            if not self._excluded(e.name):
                                subdirs.append(e.path)
                        elif e.is_file(follow_symlinks=False):
                            file_names.append(e.name)
                    except OSError:
                        self.errors += 1
        except OSError as ex:
            node.error = f"{type(ex).__name__}: {ex}"
            self.errors += 1
            return node

        # ---- 直属文件 ----
        now = time.time()
        own = 0
        nf = 0
        newest = 0.0
        sizes = {}
        for fn_name in file_names:
            try:
                st = os.stat(os.path.join(path, fn_name), follow_symlinks=False)
            except OSError:
                self.errors += 1
                continue
            if self._stopped():
                break
            sizes[fn_name] = st.st_size
            own += st.st_size
            nf += 1
            if st.st_mtime > newest:
                newest = st.st_mtime
            node.daily[_day_slot(max(0.0, (now - st.st_mtime) / 86400.0))] += st.st_size
            self._count_file(st, os.path.join(path, fn_name), fn_name)

        # ---- 垃圾文件分组 ----
        if self.file_rules and file_names:
            for r, hits in self._match_file_rules(file_names):
                shown = hits[:MAX_TRACKED_JUNK_FILES]
                tot = sum(sizes.get(h, 0) for h in shown)
                entry = {
                    "rule": r["id"], "label": r["label"], "why": r.get("why", ""),
                    "level": r["level"], "kind": "files", "dir": path,
                    "count": len(hits), "size": tot,
                    "sample": [os.path.join(path, h) for h in shown[:20]],
                }
                if len(hits) > len(shown):
                    entry["paths_truncated"] = True
                node.junk.append(entry)

        # ---- 子目录: 并发 ----
        if subdirs:
            # 取消检查必须在递归路径上! 扫大根目录时时间都花在递归上,
            # 只在 stat 文件的循环里检查的话, 取消信号会被完全忽略。
            if self._stopped():
                for p in subdirs:
                    node.children.append(Node(path=p, name=os.path.basename(p),
                                             truncated=True))
                    node.ndirs += 1
                return node
            if depth < self.max_depth:
                futs = [(p, pool.submit(self._walk, p, os.path.basename(p), depth + 1, pool))
                        for p in subdirs]
                for cp, f in futs:
                    if self._stopped():
                        break
                    try:
                        child = f.result()
                    except Exception as ex:
                        # 不要吞掉异常: 保留真实名字和路径, 否则用户只看到个 "?"
                        self.errors += 1
                        child = Node(path=cp, name=os.path.basename(cp),
                                     error="%s: %s" % (type(ex).__name__, ex))
                    node.children.append(child)
                    node.total += child.total
                    node.nfiles += child.nfiles
                    node.ndirs += child.ndirs + 1
                    if child.mtime > newest:
                        newest = child.mtime
                    cb, db = child.daily, node.daily
                    for i in range(NDAYS):
                        db[i] += cb[i]
            else:
                for p in subdirs:
                    node.children.append(
                        Node(path=p, name=os.path.basename(p), truncated=True))
                    node.ndirs += 1
                self.depth_capped += len(subdirs)
                node.truncated = True

        node.total += own
        node.own = own
        node.nfiles += nf
        node.mtime = newest
        with self._lock:
            self.ndirs += 1
        self._push()
        return node

    # ---------------- 入口 ----------------

    def run(self):
        if not os.path.isdir(self.root):
            raise NotADirectoryError(self.root)
        root_name = os.path.basename(self.root.rstrip("\\/")) or self.root
        workers = min(48, (os.cpu_count() or 4) * 6)
        with ThreadPoolExecutor(max_workers=workers) as pool:
            node = pool.submit(self._walk, self.root, root_name, 0, pool).result()
        st = self.state()
        st["done"] = True
        if self.on_progress:
            try:
                self.on_progress(st)
            except Exception:
                pass
        return node, st


def _safe(fn, arg):
    try:
        return bool(fn(arg))
    except Exception:
        return False


def scan_summary(node: Node, st: dict, sc: Scanner = None):
    """把扫描结果打包成 API 结构: 树 + 扁平垃圾清单 + 汇总。"""
    flat = []

    def walk(n):
        for j in n.junk:
            e = dict(j)
            if e["kind"] == "dir":
                e["size"] = n.total
                e["count"] = 1
                e["sample"] = [n.path]
                # 给前端用的稳定标识和新鲜度
                e["key"] = "%s:dir:%s" % (e["rule"], n.path)
            else:
                # 文件垃圾按 (规则, 所在目录) 分组, 前端据此整体勾选或取消
                e["key"] = "%s:files:%s" % (e["rule"], e.get("dir", n.path))
            e["mtime"] = n.mtime          # 前端"30 天未改动"过滤器要用
            e["dir"] = e.get("dir", n.path)
            flat.append(e)
        for c in n.children:
            walk(c)

    walk(node)
    flat.sort(key=lambda e: e.get("size", 0), reverse=True)
    big, exts = [], []
    if sc is not None:
        for size, fpath, mt in sc.top_files():
            ext = os.path.splitext(fpath)[1].lower() or "(无扩展名)"
            big.append({
                "rule": "big_file", "label": "大文件",
                "why": "单个占用较大的文件, 删掉后无法自动重建",
                "level": "caution", "kind": "file",
                "size": size, "count": 1, "sample": [fpath],
                "dir": os.path.dirname(fpath), "mtime": mt, "ext": ext,
                "key": "bigfile:" + fpath,
            })
        for ext, n, nb, recent in sc.extensions():
            exts.append({"ext": ext, "count": n, "bytes": nb, "recent": recent})

    return {
        "root": node.to_dict(),
        "junk": flat[:3000],
        "junk_total": len(flat),
        "bigfiles": big,
        "extensions": exts,
        "summary": {
            "bytes": st["bytes"], "files": st["files"], "dirs": st["dirs"],
            "elapsed": st["elapsed"], "errors": st["errors"],
            "hit_file_cap": st["hit_file_cap"], "hit_time_cap": st["hit_time_cap"],
            "depth_capped": st["depth_capped"], "days": DAYS,
        },
    }
