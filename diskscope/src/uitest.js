"use strict";
/**
 * Electron 界面自检。
 *
 * 为什么不用外部浏览器自动化: 这里要验的是"打包前的 Electron 窗口本身",
 * 包括 preload 注入、contextIsolation、IPC 往返。用 capturePage 自己截图,
 * 验的就正好是这个窗口。
 *
 *   npm run uitest  ->  截图落在 tools/shots/
 */
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");

// 打包后 __dirname 在 app.asar 里那是只读的, 输出目录必须改到可写位置
function resolveShots() {
  const dev = path.join(__dirname, "..", "tools", "shots");
  try {
    fs.mkdirSync(dev, { recursive: true });
    fs.accessSync(dev, fs.constants.W_OK);
    return dev;
  } catch {
    const alt = path.join(os.tmpdir(), "diskscope_shots");
    fs.mkdirSync(alt, { recursive: true });
    return alt;
  }
}
const SHOTS = resolveShots();

const LOG = path.join(__dirname, "..", "tools", "shots", "_uitest.log");
function logLine(msg) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, msg + "\n");
  } catch { /* 忽略 */ }
  console.log(msg);
}

/** 单个 js 调用失败不应把整个测试拖死。 */
async function safe(label, fn, fallback = null) {
  try {
    return await fn();
  } catch (ex) {
    const msg = `    !! ${label} 执行失败: ${ex && ex.message ? ex.message : ex}`;
    logLine(msg);
    return fallback;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildFixture(root) {
  const mk = (dir, n, size, ageDays) => {
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < n; i++) {
      const f = path.join(dir, `f${i}.bin`);
      fs.writeFileSync(f, Buffer.alloc(size, i % 251));
      const t = (Date.now() / 1000 - ageDays * 86400 - Math.random() * 30000) * 1000;
      fs.utimesSync(f, t / 1000, t / 1000);
    }
  };
  const one = (f, size, ageDays) => {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, Buffer.alloc(size, 3));
    const t = (Date.now() / 1000 - ageDays * 86400) * 1000;
    fs.utimesSync(f, t / 1000, t / 1000);
  };
  const p = path.join(root, "workspace");
  mk(path.join(p, "old-dashboard", "node_modules", "react"), 30, 60000, 180);
  mk(path.join(p, "old-dashboard", "dist"), 10, 90000, 180);
  mk(path.join(p, "rust-tool", "target", "debug"), 180, 70000, 25);
  mk(path.join(p, "cpp-app", "Debug"), 20, 30000, 30);
  mk(path.join(p, "live-api", "__pycache__"), 40, 900, 3);
  mk(path.join(p, "live-api", "src"), 30, 6000, 1);
  one(path.join(p, "live-api", "app.log"), 180000, 0);
  mk(path.join(root, "docs"), 40, 12000, 45);
  // \u666e\u901a\u5927\u6587\u4ef6 (\u4e0d\u8d70\u89c4\u5219, \u7528\u4f86\u9a8c\u8bc1\u5927\u6587\u4ef6\u9875)
  one(path.join(root, "videos", "screen-recording-2025.mov"), 52_000_000, 160);
  one(path.join(root, "videos", "clip.mp4"), 21_000_000, 110);
  one(path.join(root, "photos", "raw-0001.CR2"), 24_000_000, 380);
  one(path.join(root, "photos", "raw-0002.CR2"), 19_000_000, 340);
  one(path.join(root, "downloads", "installer.exe"), 33_000_000, 300);
  one(path.join(root, "downloads", "dataset.zip"), 12_000_000, 95);
  return root;
}

async function shot(win, name) {
  await fsp.mkdir(SHOTS, { recursive: true });
  const img = await win.webContents.capturePage();
  const file = path.join(SHOTS, name + ".png");
  await fsp.writeFile(file, img.toPNG());
  return file;
}

const FAILS = [];
function check(cond, label, extra = "") {
  logLine(`${cond ? "  [ok]   " : "  [FAIL] "}${label}${extra ? "   " + extra : ""}`);
  if (!cond) FAILS.push(label);
}

async function runUiTest(createWindow) {
  const tmp = buildFixture(await fsp.mkdtemp(path.join(os.tmpdir(), "diskscope_ui_")));
  console.log("样本目录: " + tmp);

  const win = createWindow();
  const wc = win.webContents;

  const consoleErrors = [];
  wc.on("console-message", (_e, level, message) => {
    if (level >= 2) consoleErrors.push(message);
  });

  await new Promise((res) => wc.once("did-finish-load", res));
  await sleep(600);

  // executeJavaScript 任意一处抛错都不能把整个测试拖死,
  // 这里统一吞掉并记录, 让测试继续跑完并最终统计失败项
  const js = async (code) => {
    try {
      return await wc.executeJavaScript(code, true);
    } catch (ex) {
      logLine(`    !! executeJavaScript 失败: ${ex && ex.message ? ex.message : ex}`);
      logLine(`       代码: ${code.replace(/\s+/g, " ").slice(0, 90)}`);
      return null;
    }
  };
  try { fs.rmSync(LOG, { force: true }); } catch { /* 忽略 */ }
  logLine("开始界面自检");

  // --- preload / IPC 是否通 ---
  console.log("\n[1] preload 与 IPC");
  const hasApi = await js("!!window.api");
  check(hasApi === true, "window.api 已由 preload 注入 (contextIsolation 下)");
  const modes = await js("!!(window.api && window.api.scanStart && window.api.cleanDryRun)");
  check(modes === true, "IPC 方法齐全");
  const drives = await js("window.api.drives().then(r => r.drives.length)");
  check(drives >= 1, "drives() 有返回", `${drives} 个盘`);

  // --- 扫描主流程 ---
  console.log("\n[2] 扫描流程");
  await js(`(() => {
    document.querySelector('#path').value = ${JSON.stringify(tmp)};
    document.querySelector('#scan').click();
  })()`);

  let ready = false;
  for (let i = 0; i < 120; i++) {
    await sleep(250);
    ready = await js("document.querySelectorAll('#treemap .tm').length > 0");
    if (ready) break;
  }
  check(ready === true, "扫描完成并渲染出 treemap");
  const stats = await js(`(() => {
    const t = [...document.querySelectorAll('#sizeSummary .stat')].map(e => e.textContent);
    return { n: t.length, joined: t.join(' ') };
  })()`);
  check(stats.n >= 6, "汇总卡片齐全", `${stats.n} 个`);
  const junkBadge = await js("document.querySelector('#junkBadge').textContent");
  check(!!junkBadge, "清理页签显示可释放量", junkBadge);
  const bigBadge = await js("document.querySelector('#bigBadge').textContent");
  check(!!bigBadge, "大文件页签显示数量", bigBadge);
  check((await js("document.querySelector('#scan').disabled")) === false, "扫描按钮已恢复可用");
  await shot(win, "01-体积分布");

  // --- treemap 下钻 ---
  console.log("\n[3] treemap 下钻");
  const before = await js("document.querySelectorAll('#treemap .tm').length");
  await js("document.querySelector('#treemap .tm').click()");
  await sleep(400);
  const after = await js("document.querySelectorAll('#treemap .tm').length");
  check(after !== before, "点击方块后下钻", `${before} -> ${after} 个方块`);

  // --- 时间轴 ---
  console.log("\n[4] 时间轴");
  await js("document.querySelector('.tabs button[data-tab=\"time\"]').click()");
  await sleep(600);
  const bars = await js("document.querySelectorAll('#chart rect').length");
  check(bars > 0, "堆叠柱状图渲染出柱子", `${bars} 根`);
  const growth = await js("document.querySelectorAll('#growth .grow').length");
  check(growth > 0, "增长排行榜有内容", `${growth} 行`);
  await shot(win, "02-时间轴");

  // --- 清理页 + 底栏策略 ---
  console.log("\n[5] 清理页与底栏显隐策略");
  await js("document.querySelector('.tabs button[data-tab=\"clean\"]').click()");
  await sleep(400);
  const rows = await js("document.querySelectorAll('#junkBody tr').length");
  check(rows > 0, "可清理项有内容", `${rows} 行`);
  const barFull = await js("document.querySelector('#cleanbar').className");
  check(!barFull.includes("slim"), "在清理页底栏是完整形态", barFull);
  await shot(win, "03-清理");

  await js("document.querySelector('.tabs button[data-tab=\"size\"]').click()");
  await sleep(400);
  const barSlim = await js("document.querySelector('#cleanbar').className");
  const gotoVisible = await js("getComputedStyle(document.querySelector('#gotoClean')).display !== 'none'");
  check(barSlim.includes("slim"), "在体积页底栏收成 slim", barSlim);
  check(gotoVisible === true, "显示「去清理」跳转按钮");

  // --- 大文件页 ---
  console.log("\n[6] 大文件页");
  await js("document.querySelector('.tabs button[data-tab=\"big\"]').click()");
  await sleep(500);
  const bigRows = await js("document.querySelectorAll('#bigBody tr:not(:has(.placeholder))').length");
  check(bigRows > 0, "大文件清单有内容", `${bigRows} 行`);
  const extRows = await js("document.querySelectorAll('#extList .extrow[data-ext]').length");
  check(extRows > 0, "扩展名分布有内容", `${extRows} 种`);
  await shot(win, "04-大文件");

  // --- 扩展名筛选联动 ---
  await js("document.querySelector('#extList .extrow[data-ext]').click()");
  await sleep(400);
  const filtered = await js("document.querySelectorAll('#bigBody tr:not(:has(.placeholder))').length");
  check(filtered > 0 && filtered < bigRows, "点扩展名后清单被筛选", `${bigRows} -> ${filtered}`);

  // --- dry-run 预演 ---
  console.log("\n[7] dry-run 预演");
  await js("document.querySelector('.tabs button[data-tab=\"clean\"]').click()");
  await sleep(400);
  await js("document.querySelector('#previewBtn').click()");
  await sleep(600);
  const modalOpen = await js("!document.querySelector('#confirmModal').hidden");
  const modalText = await js("document.querySelector('#cfBody').textContent");
  check(modalOpen === true, "dry-run 弹窗打开");
  check(/存在|已不存在/.test(modalText), "弹窗列出了将要处理的条目");
  await shot(win, "05-dryrun预览");
  await js("document.querySelector('#cfCancel').click()");
  await sleep(300);

  // --- 点「停止」能不能真的停下来 ---
  console.log("\n[8] 停止按钮");
  {
    // 造一棵大树, 足够大到不知道要扫多久
    // 文件数量决定扫描时长, 尽量多造一点 (文件小, 不占磁盘)
    const bigTree = path.join(tmp, "bigtree");
    const DIRS = 200, PER = 400;
    for (let i = 0; i < DIRS; i++) {
      const d = path.join(bigTree, "dir" + i, "sub");
      fs.mkdirSync(d, { recursive: true });
      for (let k = 0; k < PER; k++) fs.writeFileSync(path.join(d, "f" + k + ".bin"), Buffer.alloc(1024));
    }
    const total = DIRS * PER;
    await js(`(() => {
      document.querySelector('#path').value = ${JSON.stringify(bigTree)};
      document.querySelector('#scan').click();
    })()`);
    await sleep(200);
    const running = await js("!document.querySelector('#progress').hidden");
    check(running === true, `扫描已启动 (进度区可见, 共 ${total} 个文件待扫)`);

    const t0 = Date.now();
    await js("document.querySelector('#cancel').click()");
    // 等进度区消失
    let stopped = false;
    for (let i = 0; i < 80; i++) {
      await sleep(100);
      if (await js("document.querySelector('#progress').hidden")) { stopped = true; break; }
    }
    const el = Date.now() - t0;
    check(stopped === true, "点「停止」后扫描结束", `${el} ms`);
    check(el < 600, "停止响应很快 (明显快于自然扫完)", `${el} ms`);
    const btnText = await js("document.querySelector('#cancel').textContent");
    check(btnText === "停止", "停止按钮已恢复原样", btnText);
    const bannerText = await js("document.querySelector('#banner').textContent");
    check(/停止|不完整/.test(bannerText), "顶部提示已停止", bannerText.slice(0, 40));
    await shot(win, "06-已停止");
  }

  // --- 渲染进程有无报错 ---
  console.log("\n[9] 渲染进程日志");
  check(consoleErrors.length === 0, "无 console 报错", consoleErrors.slice(0, 3).join(" | "));

  await fsp.rm(tmp, { recursive: true, force: true });
  console.log("\n截图目录: " + SHOTS);
  console.log("=".repeat(52));
  if (FAILS.length) {
    console.log(`失败 ${FAILS.length} 项:`);
    for (const f of FAILS) console.log("   - " + f);
    return 1;
  }
  console.log("界面自检全部通过");
  return 0;
}

module.exports = { runUiTest };
