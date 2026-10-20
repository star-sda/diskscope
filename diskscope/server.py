# -*- coding: utf-8 -*-
"""DiskScope 本地服务。

只监听 127.0.0.1, 且每次启动生成一个随机 token 注入页面。
所有 API 都要求带上 X-Diskscope-Token 头 —— 这样别的网页即使猜到端口,
也无法跨源调用删除接口 (浏览器同源策略 + token 双重保险)。
"""
from __future__ import annotations

import json
import mimetypes
import os
import secrets
import string
import sys
import threading
import time
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote

import scanner
import trash

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

APP_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(APP_DIR, "static")
TOKEN = secrets.token_urlsafe(24)
PORT = int(os.environ.get("DISKSCOPE_PORT", "0"))

JOBS = {}
JOBS_LOCK = threading.Lock()


# --------------------------------------------------------------------------
# 目录浏览 (给界面的"浏览"按钮用)
# --------------------------------------------------------------------------
def list_dir(path):
    path = os.path.abspath(path or ".")
    if not os.path.isdir(path):
        path = os.path.dirname(path)
    out = {"path": path, "parent": os.path.dirname(path.rstrip("\\/")), "dirs": [], "error": ""}
    try:
        with os.scandir(path) as it:
            for e in it:
                try:
                    if e.is_dir(follow_symlinks=False) and e.name not in scanner.rules.HARD_SKIP_NAMES:
                        out["dirs"].append(e.name)
                except OSError:
                    pass
    except OSError as ex:
        out["error"] = str(ex)
    out["dirs"].sort(key=str.lower)
    return out


def list_drives():
    import string as _s
    drives = []
    for letter in _s.ascii_uppercase:
        root = letter + ":\\"
        if os.path.exists(root):
            try:
                import shutil as _sh
                usage = _sh.disk_usage(root)
                drives.append({"root": root, "free": usage.free, "total": usage.total,
                               "used": usage.used})
            except OSError:
                drives.append({"root": root, "free": 0, "total": 0, "used": 0})
    return drives


# --------------------------------------------------------------------------
# 扫描任务
# --------------------------------------------------------------------------
def start_scan(root, max_depth, excludes):
    jid = uuid.uuid4().hex[:12]
    ev = threading.Event()
    job = {"id": jid, "root": root, "state": "running", "progress": {},
           "result": None, "error": "", "cancel": ev, "node": None,
           "started": time.time()}
    with JOBS_LOCK:
        JOBS[jid] = job

    def work():
        try:
            prog = {"files": 0, "dirs": 0, "bytes": 0, "elapsed": 0, "rate": 0,
                    "done": False, "hit_file_cap": False, "hit_time_cap": False,
                    "depth_capped": 0, "errors": 0}

            def on_prog(st):
                job["progress"] = st

            sc = scanner.Scanner(root, max_depth=max_depth, excludes=excludes,
                                 on_progress=on_prog, cancel_event=ev)
            node, st = sc.run()
            job["node"] = node
            job["result"] = scanner.scan_summary(node, st, sc)
            job["state"] = "done"
            if ev.is_set():
                job["result"]["summary"]["cancelled"] = True
        except Exception as ex:
            import traceback
            job["state"] = "error"
            job["error"] = f"{type(ex).__name__}: {ex}"
            traceback.print_exc()

    threading.Thread(target=work, daemon=True, name="scan-" + jid).start()
    return jid


# --------------------------------------------------------------------------
# 删除前的安全闸门
# --------------------------------------------------------------------------
def guard_paths(paths):
    """最后一道闸门。返回 (safe_paths, rejected)。

    只保护工具"本身" —— 它自己的源码、页面和启动脚本。
    工具目录下的其它内容 (比如 __pycache__) 照常可以清理, 否则每次扫描自己的
    项目目录都会看到一个永远删不掉的垃圾项。
    """
    app = os.path.normcase(os.path.abspath(APP_DIR))
    protected = set()
    for f in ("server.py", "scanner.py", "rules.py", "trash.py",
              "selftest.py", "run.bat", "README.md"):
        protected.add(os.path.normcase(os.path.join(APP_DIR, f)))
    protected.add(os.path.normcase(os.path.join(APP_DIR, "static")))

    safe, rejected = [], []
    for p in paths:
        if not p:
            continue
        ap = os.path.normcase(os.path.abspath(p))
        drive, rest = os.path.splitdrive(ap)
        if not rest or rest in ("\\", "/"):
            rejected.append((p, "拒绝操作磁盘根目录"))
            continue
        if ap == app:
            rejected.append((p, "拒绝操作 DiskScope 自身所在目录"))
            continue
        if ap in protected:
            rejected.append((p, "拒绝操作 DiskScope 的程序文件"))
            continue
        safe.append(p)
    return safe, rejected


# --------------------------------------------------------------------------
# HTTP 处理
# --------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = "DiskScope/1.0"

    def log_message(self, fmt, *args):
        pass  # 静默, 免得刷屏

    # ---- helpers ----
    def _send(self, code, body, ctype="application/json; charset=utf-8", extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionAbortedError):
            pass

    def _auth(self):
        return secrets.compare_digest(self.headers.get("X-Diskscope-Token", ""), TOKEN)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            return {}

    # ---- GET ----
    def do_GET(self):
        u = urlparse(self.path)
        path, q = u.path, parse_qs(u.query)

        if path in ("/", "/index.html"):
            return self._serve_index()
        if path.startswith("/static/"):
            return self._serve_static(path[len("/static/"):])
        if not self._auth():
            return self._send(403, {"error": "token 无效"})

        if path == "/api/health":
            return self._send(200, {"ok": True, "app": APP_DIR})
        if path == "/api/drives":
            return self._send(200, {"drives": list_drives()})
        if path == "/api/list":
            return self._send(200, list_dir(unquote(q.get("path", [""])[0])))
        if path.startswith("/api/scan/"):
            jid = path.rsplit("/", 1)[-1]
            with JOBS_LOCK:
                job = JOBS.get(jid)
            if not job:
                return self._send(404, {"error": "任务不存在或已过期"})
            if job["state"] == "running":
                return self._send(200, {"state": "running", "progress": job["progress"]})
            return self._send(200, {"state": job["state"], "error": job["error"],
                                    "result": job["result"]})
        return self._send(404, {"error": "not found"})

    # ---- POST ----
    def do_POST(self):
        u = urlparse(self.path)
        path = u.path
        if not self._auth():
            return self._send(403, {"error": "token 无效"})
        b = self._body()

        if path == "/api/scan":
            root = (b.get("path") or "").strip().strip('"')
            if not root:
                return self._send(400, {"error": "请填写要扫描的目录"})
            if not os.path.isdir(root):
                return self._send(400, {"error": f"目录不存在: {root}"})
            depth = max(1, min(30, int(b.get("depth", 12))))
            excludes = [e for e in (b.get("exclude") or "").split(",") if e.strip()]
            jid = start_scan(os.path.abspath(root), depth, excludes)
            return self._send(200, {"id": jid})

        if path.startswith("/api/cancel/"):
            jid = path.rsplit("/", 1)[-1]
            with JOBS_LOCK:
                job = JOBS.get(jid)
            if job:
                job["cancel"].set()
            return self._send(200, {"ok": True})

        if path == "/api/clean/dryrun":
            safe, rejected = guard_paths(b.get("paths") or [])
            res = trash.dry_run(safe)
            res["rejected"] = rejected
            return self._send(200, res)

        if path == "/api/clean":
            safe, rejected = guard_paths(b.get("paths") or [])
            if not safe:
                return self._send(400, {"error": "没有可执行的项目", "rejected": rejected})
            mode = b.get("mode", "recycle")
            if mode not in ("recycle", "quarantine", "permanent"):
                mode = "recycle"
            res = trash.clean(safe, mode=mode)
            res["rejected"] = rejected
            return self._send(200, res)

        return self._send(404, {"error": "not found"})

    # ---- 静态资源 ----
    def _serve_index(self):
        try:
            with open(os.path.join(STATIC_DIR, "index.html"), "r", encoding="utf-8") as f:
                html = f.read()
        except OSError as ex:
            return self._send(500, f"缺少 index.html: {ex}", "text/plain; charset=utf-8")
        html = html.replace("__TOKEN__", TOKEN)
        return self._send(200, html, "text/html; charset=utf-8")

    def _serve_static(self, rel):
        rel = rel.replace("\\", "/").lstrip("/")
        full = os.path.normpath(os.path.join(STATIC_DIR, rel))
        if not full.startswith(os.path.normpath(STATIC_DIR)):
            return self._send(403, {"error": "forbidden"})
        if not os.path.isfile(full):
            return self._send(404, {"error": "not found"})
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        with open(full, "rb") as f:
            return self._send(200, f.read(), ctype)


def open_default_browser(url):
    """尽最大努力打开默认浏览器。失败时返回 False, 由调用方提示手动访问。

    webbrowser.open() 在某些 Windows 环境(比如没设默认浏览器、或
    关联被改坏)会直接返回 False 甚至抛异常, 这里再加一层
    os.startfile 兜底。
    """
    try:
        if webbrowser.open(url, new=2):
            return True
    except Exception:
        pass
    try:
        if hasattr(os, "startfile"):     # 仅 Windows
            os.startfile(url)
            return True
    except Exception:
        pass
    try:
        os.system('start "" "%s"' % url)
        return True
    except Exception:
        pass
    return False


def main():
    argv = sys.argv[1:]
    open_browser = "--no-browser" not in argv
    for a in argv:
        if a.startswith("--port="):
            globals()["PORT"] = int(a.split("=", 1)[1])

    httpd = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    port = httpd.server_address[1]
    url = f"http://127.0.0.1:{port}/"
    print("=" * 58)
    print("  DiskScope  目录体积 + 时间轴清理器")
    print()
    print(f"    打开这个地址:  {url}")
    print()
    print("  (关掉这个黑窗口就会停止服务)")
    print("=" * 58)
    if open_browser:
        def _open():
            if not open_default_browser(url):
                print("  (没能自动打开浏览器, 请手动访问上面的地址)")
        threading.Timer(0.8, _open).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
