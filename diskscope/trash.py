# -*- coding: utf-8 -*-
"""安全删除: 默认走 Windows 回收站 (可撤销), 失败时降级到隔离区。

三种模式:
  recycle    调用 SHFileOperationW + FOF_ALLOWUNDO, 进回收站, 用户可以还原
  quarantine 移动到隔离目录 <盘符根>/.diskscope_quarantine/<时间戳>/, 只改名不删数据
  permanent  真正删除 —— 必须显式指定, 默认永远不用
"""
from __future__ import annotations

import ctypes
import os
import shutil
import sys
import time
from ctypes import wintypes

FO_DELETE = 0x0003
FOF_SILENT = 0x0004
FOF_NOCONFIRMATION = 0x0010
FOF_ALLOWUNDO = 0x0040
FOF_NOCONFIRMMKDIR = 0x0200
FOF_NOERRORUI = 0x0400

QUARANTINE_DIR = ".diskscope_quarantine"


class _SHFILEOPSTRUCTW(ctypes.Structure):
    _fields_ = [
        ("hwnd", wintypes.HWND),
        ("wFunc", wintypes.UINT),
        ("pFrom", wintypes.LPCWSTR),
        ("pTo", wintypes.LPCWSTR),
        ("fFlags", wintypes.WORD),
        ("fAnyOperationsAborted", wintypes.BOOL),
        ("hNameMappings", ctypes.c_void_p),
        ("lpszProgressTitle", wintypes.LPCWSTR),
    ]


def _to_recycle_bin(paths):
    """把路径列表丢进回收站。返回 (成功数, 失败列表)。"""
    if sys.platform != "win32":
        return 0, list(paths)
    ok, bad = 0, []
    # 逐个处理: 批量提交时只要有一个失败, 整批的状态就说不清了
    for p in paths:
        try:
            op = _SHFILEOPSTRUCTW()
            op.hwnd = None
            op.wFunc = FO_DELETE
            # pFrom 必须是双 NUL 结尾的宽字符串
            op.pFrom = str(p) + "\0\0"
            op.pTo = None
            op.fFlags = (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI
                         | FOF_SILENT | FOF_NOCONFIRMMKDIR)
            op.fAnyOperationsAborted = False
            op.hNameMappings = None
            op.lpszProgressTitle = None
            rc = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op))
            if rc == 0 and not op.fAnyOperationsAborted:
                ok += 1
            else:
                bad.append((p, f"SHFileOperation rc={rc}"))
        except Exception as ex:
            bad.append((p, f"{type(ex).__name__}: {ex}"))
    return ok, bad


def _quarantine_roots(paths):
    """候选隔离区目录, 按优先级排列。

    优先用"目标所在卷的根目录": 这样 shutil.move 是同卷改名 (瞬间完成, 不复制数据)。
    卷根不可写时依次降级到用户目录 / 系统临时目录。
    """
    stamp = time.strftime("%Y%m%d_%H%M%S")
    cands = []
    if paths:
        drive = os.path.splitdrive(paths[0])[0]
        if drive:
            cands.append(os.path.join(drive + os.sep, QUARANTINE_DIR, stamp))
    home = os.path.expanduser("~")
    cands.append(os.path.join(home, QUARANTINE_DIR, stamp))
    cands.append(os.path.join(os.environ.get("TEMP", home), QUARANTINE_DIR, stamp))
    return cands


def _make_quarantine(paths):
    last = None
    for cand in _quarantine_roots(paths):
        try:
            os.makedirs(cand, exist_ok=True)
            probe = os.path.join(cand, ".writable")
            with open(probe, "w") as f:
                f.write("x")
            os.remove(probe)
            return cand
        except Exception as ex:
            last = ex
    raise RuntimeError("找不到可写的隔离区目录: %s" % last)


def _to_quarantine(paths):
    """移动到隔离区而不是删除。数据完好保留, 用户确认后可自行清空隔离区。"""
    root = _make_quarantine(paths)
    ok, bad = 0, []
    for i, p in enumerate(paths):
        try:
            # 路径压平成一个安全的文件名, 保留一点可读性
            flat = p.lstrip("\\/").replace(":", "").replace("\\", "__")
            flat = flat.replace("/", "__")[:120] or ("item_%d" % i)
            dest = os.path.join(root, flat)
            if os.path.exists(dest):
                dest = os.path.join(root, "%d_%s" % (i, os.path.basename(p)[:60]))
            shutil.move(p, dest)
            ok += 1
        except Exception as ex:
            bad.append((p, "%s: %s" % (type(ex).__name__, ex)))
    return ok, bad


def _permanent(paths):
    ok, bad = 0, []
    for p in paths:
        try:
            if os.path.isdir(p) and not os.path.islink(p):
                shutil.rmtree(p)
            else:
                os.remove(p)
            ok += 1
        except Exception as ex:
            bad.append((p, f"{type(ex).__name__}: {ex}"))
    return ok, bad


def dry_run(paths):
    """不碰磁盘, 只统计将会发生什么。"""
    rows, total = [], 0
    for p in paths:
        exists = os.path.exists(p)
        size, n = 0, 0
        if exists:
            if os.path.isdir(p) and not os.path.islink(p):
                for dp, dns, fns in os.walk(p):
                    for f in fns:
                        fp = os.path.join(dp, f)
                        try:
                            size += os.path.getsize(fp)
                            n += 1
                        except OSError:
                            pass
            else:
                try:
                    size = os.path.getsize(p)
                    n = 1
                except OSError:
                    pass
        total += size
        rows.append({"path": p, "exists": exists, "size": size, "count": n})
    return {"mode": "dry-run", "total": total, "count": len(paths), "items": rows}


def clean(paths, mode="recycle"):
    """执行清理。mode: recycle | quarantine | permanent"""
    paths = [p for p in paths if p]
    if not paths:
        return {"mode": mode, "ok": 0, "failed": [], "total_freed": 0, "items": len(paths)}

    if mode == "permanent":
        ok, bad = _permanent(paths)
    elif mode == "quarantine":
        ok, bad = _to_quarantine(paths)
    else:
        ok, bad = _to_recycle_bin(paths)
        if bad:                      # 回收站不可用 (网络盘/禁用/空间不足) -> 降级
            left = [p for p, _ in bad if os.path.exists(p)]
            qok, qbad = _to_quarantine(left)
            ok += qok
            bad = bad[:len(bad) - len(left)] + qbad
            if qok:
                return {"mode": mode + "+quarantine", "ok": ok, "failed": bad,
                        "items": len(paths), "note": "部分路径回收站不可用, 已移入隔离区"}

    return {"mode": mode, "ok": ok, "failed": bad, "items": len(paths)}
