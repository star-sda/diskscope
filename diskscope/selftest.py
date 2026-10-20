# -*- coding: utf-8 -*-
"""DiskScope 自检。不需要启动服务, 直接验证核心逻辑。

    python selftest.py
"""
import os
import pathlib
import random
import shutil
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rules
import scanner
import trash

FAILS = []


def check(cond, label, extra=""):
    print(("  [ok]   " if cond else "  [FAIL] ") + label + ("   " + extra if extra else ""))
    if not cond:
        FAILS.append(label)


def build_fixture(root):
    """造一棵结构上像真实项目的树, 文件时间戳分布在过去 200 天内。"""
    random.seed(7)
    now = time.time()

    def mk(p, n, size, age_days):
        p.mkdir(parents=True, exist_ok=True)
        for i in range(n):
            f = p / ("f%d.bin" % i)
            f.write_bytes(os.urandom(size))
            t = now - age_days * 86400 - random.randint(0, 40000)
            os.utime(f, (t, t))

    proj = root / "workspace"
    mk(proj / "old-dashboard" / "node_modules" / "lodash", 40, 60000, 200)
    mk(proj / "old-dashboard" / "dist", 10, 90000, 200)
    mk(proj / "live-api" / ".venv" / "lib", 120, 22000, 5)
    mk(proj / "live-api" / "__pycache__", 80, 900, 2)
    mk(proj / "live-api" / "src", 30, 6000, 1)
    (proj / "live-api" / "app.log").write_bytes(b"x" * 200000)
    mk(proj / "rust-tool" / "target" / "debug", 300, 70000, 20)
    mk(proj / "java-svc" / "target", 40, 50000, 60)          # Maven
    mk(proj / "gradle-app" / "build", 40, 50000, 60)         # Gradle
    mk(proj / "cs-app" / "bin" / "Debug", 40, 50000, 60)     # .NET
    mk(proj / "cpp-app" / "Debug", 20, 30000, 30)     # 回归用: 规则表缺字段会静默丢掉它
    mk(proj / "git-repo" / ".git" / "objects", 50, 15000, 90)
    mk(root / "downloads", 15, 80000, 5)


def main():
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="diskscope_selftest_"))
    try:
        print("临时目录:", tmp)
        build_fixture(tmp)

        # ---------- 规则表 ----------
        print("\n[1] 规则表")
        m = rules.build_matchers()
        names = {r["id"] for r, _ in m}
        check(len(m) > 40, "规则数量充足", "%d 条" % len(m))
        for need in ("node_modules", "pycache", "build_target", "build_output", "git", "venv", "dist"):
            check(need in names, "包含规则 " + need)
        bad = [r.get("id") for r in rules.DIR_RULES
               if any(k not in r for k in ("id", "label", "why", "level", "match", "pattern"))]
        check(not bad, "所有规则字段完整 (避免扫描时 KeyError)", str(bad))
        check(all(r.get("level") in ("safe", "caution", "never") for r in rules.DIR_RULES),
              "level 取值合法")
        check(len({r["id"] for r in rules.DIR_RULES}) == len(rules.DIR_RULES), "规则 id 不重复")

        by_name = {r["id"]: f for r, f in m if r["match"] == "name"}
        check(by_name["git"](".git"), ".git 会被识别")
        check(not by_name["git"](".github"), ".github 不会被误判成 .git")

        # ---------- 扫描器 ----------
        print("\n[2] 扫描器")
        t0 = time.time()
        sc = scanner.Scanner(str(tmp), max_depth=12)
        node, st = sc.run()
        el = time.time() - t0
        check(st["files"] > 500, "扫到文件", "%d 个" % st["files"])
        check(st["errors"] == 0, "无读取错误")

        def has_stub(n):
            if n.name == "?":
                return True
            return any(has_stub(c) for c in n.children)

        check(not has_stub(node),
              "没有占位节点 (? = 子树被静默丢失)",
              str([c.name for c in node.children if c.name == "?"]))
        check(node.total > 0 and abs(node.total - st["bytes"]) < 1024,
              "子树总量 == 全局字节数", "%d" % node.total)

        res = scanner.scan_summary(node, st, sc)
        junk = res["junk"]
        by_rule = {}
        for j in junk:
            by_rule.setdefault(j["rule"], []).append(j)
        for need in ("node_modules", "pycache", "build_target", "build_output",
                     "bin_obj", "git", "venv", "dist", "log_files"):
            check(need in by_rule, "识别出 " + need)
        check("rust_target" not in by_rule and "maven_target" not in by_rule
              and "gradle_build" not in by_rule,
              "已清理无效的路径规则")
        check(all("key" in j and "mtime" in j for j in junk), "每条垃圾项都有 key/mtime")

        levels = {r["id"]: r["level"] for r, _ in m}
        check(levels["git"] == "never", ".git 是 never 级 (永不自动勾选)")
        check(levels["node_modules"] == "safe", "node_modules 是 safe 级")

        # ---------- 时间轴 ----------
        print("\n[3] 时间轴")
        def find(n, name):
            if n.name == name:
                return n
            for c in n.children:
                r = find(c, name)
                if r:
                    return r
            return None

        live = find(node, "live-api")
        old = find(node, "old-dashboard")
        check(live is not None and sum(live.daily[:7]) > 0,
              "近期目录 7 天内有写入", "%.1f MB" % (sum(live.daily[:7]) / 1048576))
        check(old is not None and sum(old.daily[:30]) == 0,
              "200 天前的目录 30 天内无写入 (应为 0)")
        check(sum(node.daily) == node.total,
              "直方图总和 == 目录总大小",
              "%d == %d" % (sum(node.daily), node.total))
        check(len(node.daily) == 31, "直方图长度正确", str(len(node.daily)))

        # ---------- 排除 ----------
        print("\n[4] 排除规则")
        n2, _ = scanner.Scanner(str(tmp), max_depth=12,
                                excludes=["node_modules", ".git"]).run()
        check(n2.total < node.total, "排除后总体积变小",
              "%.1f -> %.1f MB" % (node.total / 1048576, n2.total / 1048576))
        check(not any(c.name == "node_modules" for c in find(n2, "old-dashboard").children),
              "node_modules 未被遍历")

        # ---------- 取消 ----------
        print("\n[5] 取消")
        import threading
        big = tmp / "bigtree"
        for i in range(40):
            d = big / ("d%d" % i) / "sub"
            d.mkdir(parents=True, exist_ok=True)
            for k in range(300):
                (d / ("f%d.bin" % k)).write_bytes(b"x" * 1024)

        ev = threading.Event()
        holder = {}

        def run_scanned():
            sc = scanner.Scanner(str(big), max_depth=12, cancel_event=ev)
            holder["res"] = sc.run()

        th = threading.Thread(target=run_scanned)
        t0 = time.time()
        th.start()
        time.sleep(0.15)
        ev.set()          # 取消信号
        th.join(timeout=20)
        el = time.time() - t0
        check(not th.is_alive(), "取消后扫描线程退出", f"{el:.2f}s")
        check(el < 15, "取消后很快返回", f"{el:.2f}s")
        if "res" in holder:
            n2, st2 = holder["res"]
            check(n2.total > 0, "仍然返回了部分结果", str(n2.total))

        # ---------- dry-run ----------
        print("\n[6] dry-run 不碰磁盘")
        victim = find(node, "dist").path
        d = trash.dry_run([victim])
        check(d["total"] > 0 and d["count"] == 1, "dry-run 统计出大小", str(d["total"]))
        check(os.path.isdir(victim), "dry-run 之后目标目录仍在")

        # ---------- 删除安全性 ----------
        print("\n[7] 删除安全性")
        import server
        app = os.path.dirname(os.path.abspath(__file__))
        safe, rejected = server.guard_paths(
            ["C:\\", "D:\\", app, os.path.join(app, "scanner.py")])
        check(not safe, "磁盘根目录 + 工具程序文件被拦截", f"{len(rejected)} 项")
        # 工具目录下的普通内容 (比如 __pycache__) 仍然应该允许清理
        safe2, _ = server.guard_paths([os.path.join(app, "__pycache__")])
        check(len(safe2) == 1, "工具目录下的 __pycache__ 仍然允许清理")

        # ---------- 回收站往返 ----------
        print("\n[8] 回收站往返")
        if sys.platform == "win32":
            trashme = tmp / "_del_me"
            trashme.mkdir()
            (trashme / "a.bin").write_bytes(b"z" * 4096)
            (trashme / "sub").mkdir()
            (trashme / "sub" / "b.bin").write_bytes(b"z" * 2048)
            r = trash.clean([str(trashme)], mode="recycle")
            check(r["ok"] == 1 and not r["failed"], "删除成功", str(r))
            check(not trashme.exists(), "目录已从原位置消失")
        else:
            print("  [skip] 非 Windows")

        # ---------- 大文件 / 扩展名 ----------
        print("\n[9] 大文件与扩展名")
        big = res["bigfiles"]
        check(len(big) > 0, "记住了大文件", "%d 个" % len(big))
        check(all(big[i]["size"] >= big[i + 1]["size"] for i in range(len(big) - 1)),
              "大文件按从大到小排序")
        check(len({b["key"] for b in big}) == len(big), "大文件 key 唯一")
        check(all(b["level"] == "caution" for b in big),
              "大文件全是 caution 级 (不自动勾选)")
        check(all(b["sample"] and os.path.isfile(b["sample"][0]) for b in big[:20]),
              "大文件路径真实存在")
        check(any(b["size"] == max(x["size"] for x in big) for b in big),
              "最大的那个文件在列")

        exts = res["extensions"]
        byext = {e["ext"]: e for e in exts}
        check(".bin" in byext, "扩展名汇总包含 .bin")
        check(".log" in byext, "扩展名汇总包含 .log")
        check(sum(e["count"] for e in exts) == st["files"],
              "各扩展名个数总和 == 全部文件数",
              "%d == %d" % (sum(e["count"] for e in exts), st["files"]))
        check(sum(e["bytes"] for e in exts) == st["bytes"],
              "各扩展名字节总和 == 全部字节数")
        check(all(exts[i]["bytes"] >= exts[i + 1]["bytes"] for i in range(len(exts) - 1)),
              "扩展名按占用从大到小排序")
        # 边界: sc=None 时不应报错
        r2 = scanner.scan_summary(node, st)
        check("bigfiles" in r2 and r2["bigfiles"] == [], "sc=None 时不报错 (兼容旧调用)")

    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("\n" + "=" * 52)
    if FAILS:
        print("失败 %d 项:" % len(FAILS))
        for f in FAILS:
            print("   -", f)
        return 1
    print("全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
