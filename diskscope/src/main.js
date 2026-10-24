"use strict";
/**
 * DiskScope 主进程。
 *
 * 架构上和 Python 版最大的不同: 后端直接跑在主进程里, 渲染进程通过 IPC 取数据,
 * 不再有"本地 HTTP 服务 + 随机 token"那一套 —— 少了一个监听端口, 攻击面小得多。
 */
const { app, BrowserWindow, ipcMain, shell, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;

const { ScanPool } = require("./scanner-pool");
const trash = require("./trash");

const APP_DIR = path.join(__dirname, "..");
const UI_DIR = path.join(__dirname, "ui");
const IS_SELFTEST = process.argv.includes("--selftest");
const IS_UITEST = process.argv.includes("--uitest");
const BENCH_IDX = process.argv.indexOf("--bench");

/* ------------------------------------------------------------------ *
 * 扫描任务
 * ------------------------------------------------------------------ */
const JOBS = new Map();
const JOB_HISTORY_MAX = 8;

/** 完成的任务必须留着 —— 渲染进程是轮询取结果的,
 * 如果完成就删掉, 下一次轮询只会拿到 state:"missing",
 * 前端读 S.result.summary 就会抛错。 */
function retireJob(id) {
  while (JOBS.size > JOB_HISTORY_MAX) {
    const oldest = JOBS.keys().next().value;
    if (oldest === id) break;
    JOBS.delete(oldest);
  }
}

function startScan(root, maxDepth, excludes) {
  const id = require("crypto").randomBytes(6).toString("hex");
  const job = { id, root, state: "running", progress: {}, result: null, error: "", cancelled: false };
  JOBS.set(id, job);

  const pool = new ScanPool(root, {
    maxDepth,
    excludes,
    onProgress: (st) => { job.progress = st; },
    isCancelled: () => job.cancelled,
  });
  job.pool = pool;

  pool.start()
    .then((result) => {
      job.result = result;
      if (job.cancelled) result.summary.cancelled = true;
      job.state = "done";
      job.finishedAt = Date.now();
      retireJob(id);
    })
    .catch((ex) => {
      job.state = "error";
      job.error = `${ex.name}: ${ex.message}`;
      job.finishedAt = Date.now();
      retireJob(id);
    });

  return id;
}

/* ------------------------------------------------------------------ *
 * 目录浏览
 * ------------------------------------------------------------------ */
async function listDir(p) {
  let dir = p ? path.resolve(p) : ".";
  try {
    const st = await fsp.stat(dir);
    if (!st.isDirectory()) dir = path.dirname(dir);
  } catch {
    dir = path.dirname(dir);
  }
  const out = { path: dir, parent: path.dirname(dir.replace(/[\\/]+$/, "")), dirs: [], error: "" };
  try {
    const ents = await fsp.readdir(dir, { withFileTypes: true });
    const { isHardSkip } = require("./rules");
    for (const e of ents) {
      if (e.isDirectory() && !isHardSkip(e.name)) out.dirs.push(e.name);
    }
  } catch (ex) {
    out.error = `${ex.code || ex.name}: ${ex.message}`;
  }
  out.dirs.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  return out;
}

async function listDrives() {
  const drives = [];
  const roots = process.platform === "win32"
    ? [...Array(26)].map((_, i) => String.fromCharCode(65 + i) + ":\\")
    : ["/"];
  for (const root of roots) {
    try {
      await fsp.access(root, fs.constants.F_OK);
    } catch { continue; }
    let total = 0, free = 0;
    try {
      const s = await fsp.statfs(root);
      total = Number(s.blocks) * Number(s.bsize);
      free = Number(s.bavail) * Number(s.bsize);
    } catch { /* 拿不到容量就显示 0 */ }
    drives.push({ root, total, free, used: total - free });
  }
  return drives;
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */
function registerIpc() {
  ipcMain.handle("drives", async () => ({ drives: await listDrives() }));

  ipcMain.handle("list", async (_e, p) => listDir(p || ""));

  ipcMain.handle("scan:start", async (_e, opts = {}) => {
    const root = String(opts.path || "").trim().replace(/^"|"$/g, "");
    if (!root) throw new Error("请填写要扫描的目录");
    const st = await fsp.stat(root).catch(() => null);
    if (!st || !st.isDirectory()) throw new Error(`目录不存在: ${root}`);
    const depth = Math.max(1, Math.min(30, Number(opts.depth) || 12));
    const excludes = String(opts.exclude || "").split(",").map((s) => s.trim()).filter(Boolean);
    return { id: startScan(root, depth, excludes) };
  });

  ipcMain.handle("scan:progress", async (_e, id) => {
    const job = JOBS.get(id);
    if (!job) return { state: "missing" };
    if (job.state === "running") return { state: "running", progress: job.progress };
    return { state: job.state, error: job.error, result: job.result };
  });

  ipcMain.handle("scan:cancel", async (_e, id) => {
    const job = JOBS.get(id);
    if (job) {
      job.cancelled = true;
      // 直接 terminate worker 线程: 停止是即时的, 不看主进程到下一个检查点
      if (job.pool) job.pool.cancel();
    }
    return { ok: true };
  });

  ipcMain.handle("clean:dryrun", async (_e, paths) => {
    const { safe, rejected } = trash.guardPaths(paths || [], APP_DIR);
    const res = await trash.dryRun(safe);
    res.rejected = rejected;
    return res;
  });

  ipcMain.handle("clean", async (_e, { paths, mode } = {}) => {
    const { safe, rejected } = trash.guardPaths(paths || [], APP_DIR);
    if (!safe.length) {
      return { error: "没有可执行的项目", rejected };
    }
    const m = ["recycle", "quarantine", "permanent"].includes(mode) ? mode : "recycle";
    const res = await trash.clean(safe, m);
    res.rejected = rejected;
    return res;
  });

  ipcMain.handle("reveal", async (_e, p) => {
    if (!p) return { ok: false, error: "路径为空" };
    if (fs.existsSync(p)) {
      try {
        shell.showItemInFolder(p);
        return { ok: true };
      } catch (ex) {
        return { ok: false, error: `${ex.name}: ${ex.message}` };
      }
    }
    // 目标已不存在: 扫描结果是旧的, 之后文件被移动/删除/游戏清理了。
    // 不能默默无反应, 而是退而打开最近还存在的上级目录, 让用户看到它原先在哪。
    let dir = path.dirname(p);
    for (let i = 0; i < 40; i++) {
      if (!dir || fs.existsSync(dir)) break;
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    if (dir && fs.existsSync(dir)) {
      try {
        const err = await shell.openPath(dir);
        if (err) return { ok: false, error: err };
        return { ok: true, fallback: dir, error: "目标已不存在, 已打开所在目录" };
      } catch (ex) {
        return { ok: false, error: `${ex.name}: ${ex.message}` };
      }
    }
    return { ok: false, error: "路径不存在, 也没有找到可用的上级目录" };
  });

}

/* ------------------------------------------------------------------ *
 * 窗口
 * ------------------------------------------------------------------ */
function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 880,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: "#0e1116",
    title: "DiskScope",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // 隐藏窗口会被 Chromium 节流, 自检时必须关掉
      backgroundThrottling: false,
    },
  });

  win.once("ready-to-show", () => win.show());
  win.loadFile(path.join(UI_DIR, "index.html"));

  // 外部链接交给系统浏览器, 不在应用内开新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  return win;
}

app.whenReady().then(async () => {
  if (IS_SELFTEST) {
    const { runSelftest } = require("./selftest");
    let code = 1;
    try {
      code = await runSelftest();
    } catch (ex) {
      console.error("[selftest] 异常: " + (ex && ex.stack ? ex.stack : ex));
      code = 2;
    }
    app.exit(code);
    return;
  }
  registerIpc();
  if (BENCH_IDX >= 0) {
    // --bench <dir> : 测一下扫描速度, 用于自定义验证
    const dir = process.argv[BENCH_IDX + 1] || "C:\\";
    const { ScanPool } = require("./scanner-pool");
    const t0 = Date.now();
    const pool = new ScanPool(dir, { maxDepth: 30 });
    const res = await pool.start();
    const el = Date.now() - t0;
    const s = res.summary;
    console.log("扫描 " + dir);
    console.log("  用时      " + el + " ms");
    console.log("  文件      " + s.files.toLocaleString());
    console.log("  目录      " + s.dirs.toLocaleString());
    console.log("  总量      " + (s.bytes / 1073741824).toFixed(2) + " GB");
    console.log("  吞吐      " + Math.round(s.files / (el / 1000)).toLocaleString() + " 文件/秒");
    console.log("  线程      " + pool.workerCount + " 个 worker");
    app.exit(0);
    return;
  }
  if (IS_UITEST) {
    const { runUiTest } = require("./uitest");
    // 看门狗: 任何地方卡住都不能让进程永久挂着
    const watchdog = setTimeout(() => {
      console.error("[uitest] 超时, 强制退出");
      process.exit(3);
    }, 180000);
    let code = 1;
    try {
      code = await runUiTest(createWindow);
    } catch (ex) {
      console.error("[uitest] 异常: " + (ex && ex.stack ? ex.stack : ex));
      code = 2;
    }
    clearTimeout(watchdog);
    app.exit(code);
    return;
  }
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
