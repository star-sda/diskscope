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

const LOG = path.join(SHOTS, "_uitest.log");   // 跟 SHOTS 走, 打包后 asar 内部不可写
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
  mk(path.join(p, "live-api", "src", "core"), 12, 4000, 0);   // 多加一层, 以便测两层下钻
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

  // 导航: 下钻 -> 上一层 -> 面包屑跳转
  {
    const crumb = () => js("document.querySelector('#timeCrumb').textContent.trim()");
    const links = () => js("document.querySelectorAll('#timeCrumb .crumblink').length");
    const upDisabled = () => js("document.querySelector('#timeUp').hasAttribute('disabled')");

    const rootCrumb = await crumb();
    check((await upDisabled()) === true, "在根目录时「上一层」按钮是禁用的");
    check((await links()) === 0, "在根目录时面包屑没有可点的祖先节点");

    // 下钻一层
    await js("document.querySelectorAll('#growth .grow')[0].click()");
    await sleep(400);
    const one = await crumb();
    check(one !== rootCrumb, "点增长榜可以下钻到下一层", `${rootCrumb} -> ${one}`);
    check((await upDisabled()) === false, "下钻后「上一层」按钮可点");
    check((await links()) === 1, "下钻后面包屑出现 1 个可点的祖先节点");

    // 上一层
    await js("document.querySelector('#timeUp').click()");
    await sleep(400);
    check((await crumb()) === rootCrumb, "点「上一层」能回到根目录", await crumb());
    check((await upDisabled()) === true, "回到根目录后按钮重新禁用");

    // 下钻两层, 再点面包屑第一段直接跳回根
    await js("document.querySelectorAll('#growth .grow')[0].click()");
    await sleep(350);
    await js("document.querySelectorAll('#growth .grow')[0].click()");
    await sleep(350);
    const two = await crumb();
    check((await links()) === 2, "下钻两层后面包屑有 2 个可点祖先节点", two);
    await js("document.querySelectorAll('#timeCrumb .crumblink')[0].click()");
    await sleep(400);
    check((await crumb()) === rootCrumb, "点面包屑第一段可直接跳回根目录", await crumb());

    // 图例与柱体也能下钻
    await js("document.querySelectorAll('#growth .grow')[0].click()");
    await sleep(350);
    const beforeLeg = await crumb();
    await js("document.querySelectorAll('#chartLegend .legenditem')[0].click()");
    await sleep(400);
    check((await crumb()) !== beforeLeg, "点图例可以下钻", `${beforeLeg} -> ${await crumb()}`);
  }
  await shot(win, "02-时间轴");

  // 悬停提示: 下钻导致图表重绘后, 提示框必须消失
  console.log("\n[4.5] 悬停提示");
  {
    const tipVisible = () => js(
      "(() => { const t = document.querySelector('.chart-tip'); return !!t && !t.hidden; })()");
    await js("document.querySelectorAll('#chart rect')[0]" +
             ".dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }))");
    await sleep(250);
    check((await tipVisible()) === true, "悬停柱子时显示提示框");

    // SVG 元素没有 HTMLElement.click() 方法, 只能派发事件
    await js("document.querySelectorAll('#chart rect')[0]" +
             ".dispatchEvent(new MouseEvent('click', { bubbles: true }))");
    await sleep(400);
    check((await tipVisible()) === false, "点击下钻导致重绘后, 提示框已消失 (不残留)");
    const n = await js("document.querySelectorAll('.chart-tip').length");
    check(n <= 1, "页面上最多只有 1 个提示节点 (无孤儿节点)", String(n));

    // 切换页签也不应请残留
    await js("document.querySelectorAll('#chart rect')[0]" +
             ".dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }))");
    await sleep(200);
    await js("document.querySelector('.tabs button[data-tab=\"size\"]').click()");
    await sleep(300);
    check((await tipVisible()) === false, "切换到其他页签时提示框也会消失");
    await js("document.querySelector('.tabs button[data-tab=\"time\"]').click()");
    await sleep(300);
  }

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

  // --- 路径可点: 点一下应该在资源管理器里定位 ---
  console.log("\n[6.5] 路径定位");
  {
    // 自动化测试里不能真开资源管理器, 用桩函数接住
    // 先保存真实的 revealPath, 测完要恢复 —— 否则后面测的都是桩函数, 会掩盖真实问题
    await js("window.__origReveal = window.revealPath; " +
             "window.__revealed = []; window.revealPath = (p) => { window.__revealed.push(p); };");

    const links = await js("document.querySelectorAll('#bigBody .jpath-link').length");
    check(links > 0, "大文件页的路径是可点的", `${links} 个`);
    const attr = await js("(document.querySelector('#bigBody .jpath-link')||{}).dataset ? document.querySelector('#bigBody .jpath-link').dataset.reveal : ''");
    check(!!attr, "路径上带了 data-reveal 属性", attr.slice(-46));
    await js("document.querySelector('#bigBody .jpath-link').click()");
    await sleep(250);
    const got = await js("(window.__revealed||[])[0] || ''");
    check(got === attr, "点路径会调用定位 (Explorer 打开并选中该项)", got.slice(-46));

    await js("document.querySelector('.tabs button[data-tab=\"clean\"]').click()");
    await sleep(400);
    const links2 = await js("document.querySelectorAll('#junkBody .jpath-link').length");
    check(links2 > 0, "清理页的路径是可点的", `${links2} 个`);
    await js("document.querySelector('#junkBody .jpath-link').click()");
    await sleep(250);
    const got2 = await js("(window.__revealed||[])[1] || ''");
    check(!!got2, "清理页点路径也会调用定位", got2.slice(-46));

    // 恢复真实函数 —— 下面要测真实链路
    await js("window.revealPath = window.__origReveal;");
  }

  // --- 真实定位链路: 不打桩, 从渲染进程一路到资源管理器 ---
  console.log("\n[6.6] 真实定位链路");
  {
    const { execFileSync } = require("child_process");
    const ps = (body) => execFileSync("powershell", ["-NoProfile", "-Command", body],
                                      { encoding: "utf8", timeout: 30000 });
    const windows = () => ps("$sh = New-Object -ComObject Shell.Application; " +
      "$sh.Windows() | ForEach-Object { try { $_.LocationURL } catch { '' } }")
      .split("\n").map((x) => x.trim()).filter(Boolean);
    const closeAll = () => {
      try {
        ps("$sh = New-Object -ComObject Shell.Application; " +
           "$sh.Windows() | ForEach-Object { try { $_.Quit() } catch {} }");
      } catch { /* 忽略 */ }
    };

    closeAll();
    const target = path.join(tmp, "docs", "f0.bin");

    // (a) 直接调用 IPC
    const res = await js("window.api.reveal(" + JSON.stringify(target) + ")");
    check(res && res.ok === true, "直接调用定位接口返回成功", JSON.stringify(res));
    await sleep(2500);
    let w = windows();
    check(!!w.find((x) => /docs/i.test(x)), "(a) 资源管理器打开了目标目录", JSON.stringify(w));
    closeAll();
    await sleep(800);

    // (b) 调用页面上真实的 revealPath (这个中间层之前从未被测过)
    await js("window.revealPath(" + JSON.stringify(target) + ")");
    await sleep(2500);
    w = windows();
    check(!!w.find((x) => /docs/i.test(x)), "(b) 页面的 revealPath 真的能打开资源管理器", JSON.stringify(w));
    // (c) 目标已被删除 -> 应该降级到上级目录, 而不是静默无反应
    const gone = path.join(tmp, "不存在的目录", "也没有这个文件.bin");
    const res3 = await js("window.api.reveal(" + JSON.stringify(gone) + ")");
    check(res3 && res3.ok === true && !!res3.fallback,
          "目标已删除时降级到上级目录 (而不是无反应)", JSON.stringify(res3));
    await sleep(2000);
    w = windows();
    check(!!w.find((x) => /diskscope_ui/i.test(x)), "降级后仍然打开了可用的目录", JSON.stringify(w));

    closeAll();
  }

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
