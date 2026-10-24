'use strict';
/* DiskScope 前端。零依赖, 原生 JS。 */

const TOKEN = document.querySelector('meta[name=ds-token]').content;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const S = {
  result: null,
  tmNode: null, tmPath: [],
  timeNode: null, timePath: [],
  junk: [], big: [], exts: [], all: [], extFilter: null,
  sel: new Set(),
  jobId: null, timer: null,
};

// 只有这两个页面能勾选项，底部执行条才有意义
const SELECT_TABS = new Set(['clean', 'big']);
let ACTIVE_TAB = 'size';

/* ---------------- 工具 ---------------- */
function fmt(b) {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0; b = Number(b);
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b < 10 && i > 0 ? b.toFixed(1) : Math.round(b)} ${u[i]}`;
}
function ago(ts) {
  if (!ts) return '—';
  const d = (Date.now() / 1000 - ts) / 86400;
  if (d < 1 / 24) return '今天';
  if (d < 1) return `${Math.round(d * 24)} 小时前`;
  if (d < 30) return `${Math.round(d)} 天前`;
  if (d < 365) return `${Math.round(d / 30)} 个月前`;
  return `${(d / 365).toFixed(1)} 年前`;
}
const sum = (a, n = a.length) => a.slice(0, n).reduce((s, x) => s + x, 0);
const cold = n => n.daily ? sum(n.daily, 30) : 0;
const recent = n => n.daily ? sum(n.daily, 7) : 0;

async function api(path, body) {
  const opt = { headers: { 'X-Diskscope-Token': TOKEN } };
  if (body !== undefined) {
    opt.method = 'POST';
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const r = await fetch(path, opt);
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
let toastT;
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast ' + kind; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 3600);
}
function findNode(root, path) {
  if (!root || root.path === path) return root;
  for (const c of root.children || []) {
    const f = findNode(c, path);
    if (f) return f;
  }
  return null;
}
function levelOf(node) {
  if (!node || !node.junk || !node.junk.length) return 'normal';
  const order = { never: 3, caution: 2, safe: 1 };
  let best = 'normal';
  for (const j of node.junk)
    if ((order[j.level] || 0) > (order[best] || 0)) best = j.level;
  return best;
}
function modal(id, show) { $(id).hidden = !show; }

/* ---------------- 磁盘 ---------------- */
async function loadDrives() {
  try {
    const { drives } = await api('/api/drives');
    $('#drives').innerHTML = drives.map(d => {
      const pct = d.total ? (d.used / d.total * 100) : 0;
      return `<div class="drive" data-root="${d.root}">
        <div class="dn">${d.root}</div>
        <div class="dbar ${pct > 90 ? 'warn' : ''}"><i style="width:${pct.toFixed(1)}%"></i></div>
        <div class="dtxt"><span>已用 ${fmt(d.used)}</span><span>剩 ${fmt(d.free)}</span></div>
      </div>`;
    }).join('');
    $$('#drives .drive').forEach(el =>
      el.onclick = () => { $('#path').value = el.dataset.root; doScan(); });
  } catch (e) { console.warn('drives', e); }
}

/* ---------------- 扫描 ---------------- */
async function doScan() {
  const path = $('#path').value.trim();
  if (!path) return toast('请先填写要扫描的目录', 'bad');
  $('#scan').disabled = true; $('#cancel').hidden = false;
  $('#banner').hidden = true;
  $('#progress').hidden = false;
  $('#progressFill').className = 'indet';
  $('#progressText').textContent = '正在扫描…';
  try {
    const { id } = await api('/api/scan', {
      path, depth: +$('#depth').value, exclude: $('#exclude').value,
    });
    S.jobId = id;
    clearInterval(S.timer);
    S.timer = setInterval(poll, 320);
  } catch (e) {
    finish(); $('#progress').hidden = true; toast(e.message, 'bad');
  }
}

async function poll() {
  let j;
  try { j = await api('/api/scan/' + S.jobId); }
  catch (e) { clearInterval(S.timer); finish(); return toast(e.message, 'bad'); }

  if (j.state === 'running') {
    const p = j.progress || {};
    $('#progressText').textContent =
      `已扫描 ${(p.files || 0).toLocaleString()} 个文件 · ${(p.dirs || 0).toLocaleString()} 个目录`;
    $('#progressMeta').textContent =
      `${fmt(p.bytes)}  ·  ${(p.elapsed || 0).toFixed(1)}s  ·  ${fmt(p.rate || 0)}/s`;
    return;
  }
  clearInterval(S.timer); finish();
  if (j.state === 'error') { $('#progress').hidden = true; return toast(j.error, 'bad'); }

  S.result = j.result;
  const s = S.result.summary;
  $('#progress').hidden = true;

  const warns = [];
  if (s.cancelled) warns.push('扫描被手动停止, 结果不完整');
  if (s.hit_file_cap) warns.push(`已达文件数上限 (${s.files.toLocaleString()}), 结果不完整`);
  if (s.hit_time_cap) warns.push('已达时间上限, 结果不完整');
  if (s.depth_capped) warns.push(`${s.depth_capped.toLocaleString()} 个目录超过深度上限, 其大小未计入`);
  if (s.errors) warns.push(`${s.errors.toLocaleString()} 个文件/目录无权限读取, 已跳过`);
  if (warns.length) {
    const b = $('#banner');
    b.innerHTML = warns.join(' · ');
    b.className = 'banner err'; b.hidden = false;
  }

  renderAll();
  toast(`扫描完成 · ${fmt(s.bytes)} · ${s.files.toLocaleString()} 个文件`, 'good');
}

function finish() {
  $('#scan').disabled = false;
  const cb = $('#cancel');
  cb.hidden = true;
  cb.disabled = false;
  cb.textContent = '停止';
}

function renderAll() {
  S.tmNode = S.result.root; S.tmPath = initPath(S.result.root);
  S.timeNode = S.result.root; S.timePath = initPath(S.result.root);
  S.junk = S.result.junk || [];
  S.big = S.result.bigfiles || [];
  S.exts = S.result.extensions || [];
  S.extFilter = null;
  // 选择集合 = 构建垃圾 + 大文件, 底部清理条统一管管
  S.all = S.junk.concat(S.big);
  S.sel = new Set(S.junk.filter(j => j.level === 'safe').map(j => j.key));
  const safeB = S.junk.filter(j => j.level === 'safe').reduce((s, j) => s + j.size, 0);
  $('#junkBadge').textContent = S.junk.length ? fmt(safeB) : '';
  $('#bigBadge').textContent = S.big.length ? String(S.big.length) : '';
  renderSummary(); renderTreemap(); renderTree();
  renderTime(); renderGrowth(); renderJunk();
  renderBigSummary(); renderExt(); renderBig();
  updateSelBar();
}

/* ---------------- 汇总卡片 ---------------- */
function stat(k, v, cls = '') {
  return `<div class="stat ${cls}"><div class="k">${k}</div><div class="v">${v}</div></div>`;
}
function renderSummary() {
  const s = S.result.summary, r = S.result.root;
  const safeB = S.junk.filter(j => j.level === 'safe').reduce((a, j) => a + j.size, 0);
  const w7 = sum(r.daily, 7), w30 = sum(r.daily, 30);
  $('#sizeSummary').innerHTML =
    stat('总占用', fmt(r.total)) +
    stat('文件 / 目录', `${r.nfiles.toLocaleString()} / ${r.ndirs.toLocaleString()}`) +
    stat('最近 7 天写入', fmt(w7), w7 > r.total * .1 ? 'warnv' : '') +
    stat('最近 30 天写入', fmt(w30)) +
    stat('可释放 (safe)', fmt(safeB), 'good') +
    stat('扫描耗时', s.elapsed.toFixed(2) + 's');

  $('#timeSummary').innerHTML =
    stat('今天写入', fmt(r.daily[0] || 0)) +
    stat('最近 7 天', fmt(w7)) +
    stat('最近 30 天', fmt(w30)) +
    stat('30 天以上没动过', fmt(r.daily[30] || 0)) +
    stat('最活跃的目录', topGrowth());
}
function topGrowth() {
  let best = null;
  (function walk(n) {
    for (const c of n.children || []) {
      const v = recent(c);
      if (!best || v > best.v) best = { v, n: c };
      walk(c);
    }
  })(S.result.root);
  return best && best.v ? `${best.n.name} (${fmt(best.v)})` : '无';
}

/* ---------------- \u8def\u5f84\u6808 (\u9762\u5305\u5c51 / \u4e0a\u4e0b\u94bb) ----------------
   \u4e24\u4e2a\u9875\u7b7e(\u4f53\u79ef\u5206\u5e03 / \u65f6\u95f4\u8f74)\u90fd\u7528\u540c\u4e00\u5957\u8def\u5f84\u6808:
   \u5e95\u5c42\u7684\u8def\u5f84\u5728\u524d, \u70b9\u9762\u5305\u5c51\u7684\u4efb\u610f\u4e00\u6bb5\u90fd\u80fd\u76f4\u63a5\u8df3\u8fc7\u53bb\u3002 */
function initPath(root) { return [{ name: root.name, path: root.path }]; }
function pushPath(stack, node) { stack.push({ name: node.name, path: node.path }); }
function popPath(stack, root) {
  if (stack.length > 1) stack.pop();
  return findNode(root, stack[stack.length - 1].path) || root;
}
function crumbHtml(stack) {
  return stack.map((seg, i) => {
    const last = i === stack.length - 1;
    return last
      ? `<b>${esc(seg.name)}</b>`
      : `<a class="crumblink" data-path="${esc(seg.path)}" href="#">${esc(seg.name)}</a>`;
  }).join(' <span class="sepc">&rsaquo;</span> ');
}
/** \u9762\u5305\u5c51\u91cc\u7684\u7956\u5148\u8282\u70b9\u53ef\u70b9\u3002onPick \u8d1f\u8d23\u5207\u6362\u72b6\u6001\u3002 */
function bindCrumb(sel, onPick) {
  $$(sel + ' .crumblink').forEach(el => el.onclick = (ev) => {
    ev.preventDefault();
    const nd = findNode(S.result.root, el.dataset.path);
    if (nd) onPick(nd, el.dataset.path);
  });
}

/* ---------------- squarified treemap ---------------- */
function worstRatio(areas, thick) {
  let w = 0;
  for (const a of areas) {
    const len = a / thick;
    w = Math.max(w, Math.max(len / thick, thick / len));
  }
  return w;
}
function squarify(items, x, y, w, h) {
  const out = [];
  const total = items.reduce((s, n) => s + n.value, 0);
  if (total <= 0 || w <= 0 || h <= 0) return out;
  const scale = (w * h) / total;
  let i = 0;
  while (i < items.length) {
    const side = Math.min(w, h);
    if (side <= 0.5) break;
    let bestI = i, bestR = Infinity, s = 0;
    for (let j = i; j < items.length; j++) {
      s += items[j].value;
      if (s <= 0) break;
      const thick = s * scale / side;
      if (thick > side * 2) break;
      const r = worstRatio(items.slice(i, j + 1).map(n => n.value * scale), thick);
      if (r < bestR) { bestR = r; bestI = j; }
    }
    const row = items.slice(i, bestI + 1);
    s = row.reduce((a, n) => a + n.value, 0);
    const thick = s * scale / side;
    let off = 0;
    for (const n of row) {
      const len = (n.value * scale) / thick;
      if (w >= h) out.push({ ...n, x, y: y + off, w: thick, h: len });
      else out.push({ ...n, x: x + off, y, w: len, h: thick });
      off += len;
    }
    if (w >= h) { x += thick; w -= thick; } else { y += thick; h -= thick; }
    i = bestI + 1;
  }
  return out;
}
function hue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h % 360;
}
const LVLC = { safe: '#2f9e6b', caution: '#b5822a', never: '#b8434f' };

function renderTreemap() {
  const box = $('#treemap'), node = S.tmNode;
  $('#crumb').innerHTML = crumbHtml(S.tmPath);
  bindCrumb('#crumb', (nd, path) => {
    S.tmNode = nd;
    const i = S.tmPath.findIndex(s => s.path === path);
    if (i >= 0) S.tmPath.length = i + 1;
    renderTreemap();
  });
  if (!node || !(node.children || []).length) {
    box.innerHTML = `<div class="placeholder">${node ? '这个目录下面没有子目录' : '还没有数据'}</div>`;
    return;
  }
  const W = box.clientWidth || 900, H = box.clientHeight || 440;
  let kids = node.children.filter(c => c.total > 0)
    .map(c => ({ value: c.total, node: c }));
  const extra = node.children.length - kids.length;
  kids.sort((a, b) => b.value - a.value);
  const CAP = 70;
  if (kids.length > CAP) {
    const rest = kids.slice(CAP).reduce((s, k) => s + k.value, 0);
    kids = kids.slice(0, CAP);
    kids.push({ value: rest, node: { name: `其他 ${extra > 0 ? extra + ' 个空目录' : '目录'}`, path: node.path, total: rest, _rest: true } });
  }
  const rects = squarify(kids, 0, 0, W, H);
  box.innerHTML = rects.map(r => {
    const lv = levelOf(r.node);
    const bg = lv === 'normal'
      ? `hsl(${hue(r.node.name)} 38% 30%)`
      : LVLC[lv];
    const showLabel = r.w > 58 && r.h > 30;
    const badge = (r.node.junk || [])[0];
    return `<div class="tm" data-path="${esc(r.node.path)}"
      style="left:${r.x}px;top:${r.y}px;width:${Math.max(0, r.w - 1)}px;height:${Math.max(0, r.h - 1)}px;background:${bg}"
      title="${esc(r.node.path)}\n${fmt(r.node.total)} · ${r.node.nfiles} 个文件${badge ? '\n[' + badge.label + '] ' + badge.why : ''}">
      ${badge && r.w > 90 ? `<span class="c">${badge.level === 'safe' ? '可删' : badge.level === 'caution' ? '需确认' : '勿删'}</span>` : ''}
      ${showLabel ? `<div class="n">${esc(r.node.name)}</div><div class="s">${fmt(r.value)}</div>` : ''}
    </div>`;
  }).join('');
  $$('#treemap .tm').forEach(el => el.onclick = () => {
    const p = el.dataset.path;
    const nd = findNode(S.result.root, p);
    if (nd) { S.tmNode = nd; pushPath(S.tmPath, nd); renderTreemap(); }
  });
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ---------------- 目录明细 ---------------- */
const expanded = new Set();
function renderTree() {
  const box = $('#tree'), root = S.result.root;
  const onlyCold = $('#showCold').checked;
  const rows = [];
  (function walk(n, d) {
    const kids = (n.children || []).filter(c => !(onlyCold && c.total > 0 && cold(c) === 0));
    const op = expanded.has(n.path);
    rows.push({ n, d, has: kids.length > 0, op });
    if (op) kids.forEach(c => walk(c, d + 1));
  })(root, 0);

  const parentTotal = n => n.total || 1;
  box.innerHTML = rows.map(({ n, d, has, op }) => {
    const lv = levelOf(n);
    const pct = (n.total / parentTotal(n) * 100).toFixed(1);
    const g = (n.junk || [])[0];
    return `<div class="trow ${cold(n) === 0 && n.total > 0 ? 'cold' : ''}" data-path="${esc(n.path)}"
        style="padding-left:${12 + d * 16}px">
      <span class="tw ${lv}" style="width:${Math.max(2, Math.min(120, pct * 1.2))}px"></span>
      <span class="tnm"><span class="caret">${has ? (op ? '▾' : '▸') : '·'}</span>${esc(n.name)}</span>
      ${g ? `<span class="tg ${g.level}">${g.level === 'safe' ? '可重建' : g.level === 'caution' ? '需确认' : '勿删'}</span>` : ''}
      <span class="tsz">${fmt(n.total)}</span>
      <span class="tpc">${pct}%</span>
      <span class="tsz" style="width:66px;color:#5b6478">${ago(n.mtime)}</span>
    </div>`;
  }).join('');
  $$('#tree .trow').forEach(el => {
    const nd = findNode(root, el.dataset.path);
    el.onclick = () => {
      const p = el.dataset.path;
      if (expanded.has(p)) expanded.delete(p); else expanded.add(p);
      renderTree();
    };
  });
}

/* ---------------- 图表悬停提示 ----------------
   用单个复用的 DOM 节点, 不再每次 hover 都新建一个跟在 body 上。
   之前的写法有个漏洞: 提示框存在 rect 元素上, 而一旦点击柱子导致图表重建,
   旧 rect 就被丢弃了, mouseleave 永远不会触发 —— 提示框永久停留在页面上。
   单个复用节点从根上消除这类泄漏。 */
let _chartTip = null;
function showChartTip(anchor, text) {
  if (!_chartTip) {
    _chartTip = document.createElement('div');
    _chartTip.className = 'toast chart-tip';
    document.body.appendChild(_chartTip);
  }
  const b = anchor.getBoundingClientRect();
  _chartTip.textContent = text;
  _chartTip.style.left = (b.left + b.width / 2) + 'px';
  _chartTip.style.top = Math.max(4, b.top - 4) + 'px';
  _chartTip.style.bottom = 'auto';
  _chartTip.style.transform = 'translateX(-50%)';
  _chartTip.hidden = false;
}
function hideChartTip() { if (_chartTip) _chartTip.hidden = true; }

/* ---------------- 时间轴 ---------------- */
const PALETTE = ['#4f8cff', '#3ecf8e', '#f0b429', '#f0576a', '#a06bff', '#2fc4c4',
  '#ff8a5b', '#8fd14f', '#ff6fa5', '#5b8def'];

function renderTime() {
  hideChartTip();                       // 图表要重画, 旧提示一律清掉
  const node = S.timeNode, days = +$('#timeRange').value;
  $('#timeCrumb').innerHTML = crumbHtml(S.timePath);
  bindCrumb('#timeCrumb', (nd, path) => {
    S.timeNode = nd;
    const i = S.timePath.findIndex(s => s.path === path);
    if (i >= 0) S.timePath.length = i + 1;
    renderTime(); renderGrowth();
  });
  $('#timeUp').disabled = S.timePath.length <= 1;
  const box = $('#chart');
  let kids = (node.children || []).filter(c => c.total > 0)
    .sort((a, b) => sum(b.daily, days) - sum(a.daily, days));
  const act = kids.filter(c => sum(c.daily, days) > 0);
  if (!act.length) {
    box.innerHTML = '<div class="placeholder">最近这段时间这个目录没有任何写入</div>';
    $('#chartLegend').innerHTML = ''; return;
  }
  const TOP = 9;
  const series = act.slice(0, TOP).map((c, i) => ({
    name: c.name, path: c.path, color: PALETTE[i % PALETTE.length], daily: c.daily,
  }));
  const restTot = act.slice(TOP).reduce((s, c) => {
    const d = new Array(days).fill(0);
    for (let i = 0; i < days; i++) d[i] += c.daily[i] || 0;
    return s.map((v, i) => v + d[i]);
  }, new Array(days).fill(0));
  if (restTot.some(v => v > 0))
    series.push({ name: `其他 ${act.length - TOP} 个目录`, color: '#4a5568', daily: restTot });

  const W = Math.max(560, (box.clientWidth || 860) - 32), H = 300;
  const ml = 56, mr = 12, mt = 14, mb = 30;
  const iw = W - ml - mr, ih = H - mt - mb;
  const totals = [];
  for (let d = 0; d < days; d++) totals[d] = series.reduce((s, se) => s + (se.daily[d] || 0), 0);
  const max = Math.max(...totals, 1);
  const bw = iw / days;
  const nice = niceMax(max);
  const ticks = 4;

  let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:${H}px">`;
  for (let t = 0; t <= ticks; t++) {
    const v = nice / ticks * t, y = mt + ih - (v / nice) * ih;
    svg += `<line class="ggrid" x1="${ml}" y1="${y}" x2="${W - mr}" y2="${y}"/>`;
    svg += `<text class="glabel" x="${ml - 7}" y="${y + 3}" text-anchor="end">${fmt(v)}</text>`;
  }
  for (let d = 0; d < days; d++) {
    let acc = 0;
    const x = ml + d * bw;
    for (const se of series) {
      const v = se.daily[d] || 0;
      if (v <= 0) continue;
      const h = (v / nice) * ih;
      acc += h;
      const y = mt + ih - acc;
      svg += `<rect x="${x + 1}" y="${y}" width="${Math.max(1, bw - 2)}" height="${h}"
        fill="${se.color}" opacity=".92" data-d="${d}" data-n="${esc(se.name)}" data-p="${esc(se.path)}" data-v="${v}"><title>${esc(se.name)} · ${ago((Date.now() / 1000) - d * 86400)}\n${fmt(v)}</title></rect>`;
    }
    if (d % Math.ceil(days / 7) === 0 || d === days - 1)
      svg += `<text class="glabel" x="${x + bw / 2}" y="${H - 10}" text-anchor="middle">${
        d === 0 ? '今天' : d + '天前'}</text>`;
  }
  svg += `<line class="gaxis" x1="${ml}" y1="${mt + ih}" x2="${W - mr}" y2="${mt + ih}"/></svg>`;
  box.innerHTML = svg;

  $('#chartLegend').innerHTML = series.map(s =>
    `<span class="legenditem" data-path="${esc(s.path)}" title="点此可下钻到该目录"><i class="sw" style="background:${s.color}"></i>${esc(s.name)} · ${fmt(sum(s.daily, days))}</span>`).join('');
  $$('#chartLegend .legenditem').forEach(el => el.onclick = () => {
    const nd = findNode(S.result.root, el.dataset.path);
    if (nd) { S.timeNode = nd; pushPath(S.timePath, nd); renderTime(); renderGrowth(); }
  });

  $$('#chart rect').forEach(r => {
    r.style.cursor = 'pointer';
    r.onclick = () => {
      const nd = findNode(S.result.root, r.dataset.p);
      if (nd) { S.timeNode = nd; pushPath(S.timePath, nd); renderTime(); renderGrowth(); }
    };
    r.onmouseenter = () => showChartTip(
      r, `${r.dataset.n} · ${r.dataset.d === 0 ? '今天' : r.dataset.d + '天前'} = ${fmt(+r.dataset.v)}`);
  });
  // 移到柱体之间的空白区也要隐藏, 不只是移出柱子时
  $('#chart').onmouseleave = hideChartTip;
}
function niceMax(v) {
  if (v <= 0) return 1;
  const e = Math.pow(10, Math.floor(Math.log10(v)));
  const m = v / e;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * e;
}

function renderGrowth() {
  const node = S.timeNode;
  const kids = (node.children || []).map(c => ({ n: c, v: recent(c) }))
    .filter(x => x.v > 0).sort((a, b) => b.v - a.v).slice(0, 40);
  const box = $('#growth');
  if (!kids.length) { box.innerHTML = '<div class="placeholder">最近 7 天没有写入</div>'; return; }
  const max = kids[0].v, tot = kids.reduce((s, k) => s + k.v, 0);
  box.innerHTML = kids.map(({ n, v }) => `
    <div class="grow" data-path="${esc(n.path)}">
      <span class="gbar" style="width:${Math.max(2, v / max * 320)}px"></span>
      <span class="gname">${esc(n.name)}</span>
      <span class="gpct">${tot ? (v / tot * 100).toFixed(0) : 0}%</span>
      <span class="gval">+${fmt(v)}</span>
    </div>`).join('');
  $$('#growth .grow').forEach(el => el.onclick = () => {
    const nd = findNode(S.result.root, el.dataset.path);
    if (nd) { S.timeNode = nd; pushPath(S.timePath, nd); renderTime(); renderGrowth(); }
  });
}


/* ---------------- 大文件 ---------------- */
const COLD30 = 30 * 86400;
function renderBigSummary() {
  const b = S.big;
  if (!b.length) { $('#bigSummary').innerHTML = ''; return; }
  const total = S.result.summary.bytes || 1;
  const covered = b.reduce((s, f) => s + f.size, 0);
  const coldB = b.filter(f => (Date.now() / 1000 - f.mtime) > COLD30)
                  .reduce((s, f) => s + f.size, 0);
  $('#bigSummary').innerHTML =
    stat('最大单文件', fmt(b[0].size)) +
    stat('前 ' + b.length + ' 个合计', fmt(covered)) +
    stat('占总空间', (covered / total * 100).toFixed(1) + '%',
         covered / total > 0.3 ? 'warnv' : '') +
    stat('文件类型数', String(S.exts.length)) +
    stat('其中 30 天未动', fmt(coldB), coldB > 0 ? 'warnv' : '');
}

function renderExt() {
  const box = $('#extList'), list = S.exts;
  if (!list.length) {
    box.innerHTML = '<div class="placeholder">这个目录里没有文件</div>';
    return;
  }
  const max = list[0].bytes;
  const head = `<div class="extrow exthead">
      <span class="extname">类型</span><span></span>
      <span class="extn">数量</span><span class="extsz">占用</span>
      <span class="extnew">30天内新增</span></div>`;
  box.innerHTML = head + list.slice(0, 80).map(e => `
    <div class="extrow ${S.extFilter === e.ext ? 'on' : ''}" data-ext="${esc(e.ext)}"
         title="${esc(e.ext)}: ${e.count} 个文件, 共 ${fmt(e.bytes)}">
      <span class="extname">${esc(e.ext)}</span>
      <span class="extbar" style="width:${(e.bytes / max * 100).toFixed(2)}%"></span>
      <span class="extn">${e.count} 个</span>
      <span class="extsz">${fmt(e.bytes)}</span>
      <span class="extnew">${e.recent ? '+' + fmt(e.recent) : '—'}</span>
    </div>`).join('');
  $$('#extList .extrow[data-ext]').forEach(el => el.onclick = () => {
    S.extFilter = S.extFilter === el.dataset.ext ? null : el.dataset.ext;
    renderExt(); renderBig();
  });
}

function renderBig() {
  const min = +$('#minSize').value;
  const cold = $('#bigCold').checked;
  const q = $('#bigSearch').value.trim().toLowerCase();
  const rows = S.big.filter(f => {
    if (f.size < min) return false;
    if (cold && (Date.now() / 1000 - f.mtime) <= COLD30) return false;
    if (S.extFilter && f.ext !== S.extFilter) return false;
    if (q && !f.sample[0].toLowerCase().includes(q)) return false;
    return true;
  });
  const body = $('#bigBody');
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="5" class="placeholder">没有符合条件的文件</td></tr>';
    $('#bigCheckAll').checked = false; return;
  }
  body.innerHTML = rows.map(f => {
    const on = S.sel.has(f.key);
    return `<tr class="${on ? 'sel' : ''}" data-key="${esc(f.key)}">
      <td class="c1"><input type="checkbox" ${on ? 'checked' : ''} data-key="${esc(f.key)}"></td>
      <td class="num" style="font-family:var(--mono)">${fmt(f.size)}</td>
      <td><span class="tg caution" style="background:rgba(240,180,41,.18);color:#f0b429">${esc(f.ext)}</span></td>
      <td><div class="jpath jpath-link" data-reveal="${esc(f.sample[0])}"
        title="点击在资源管理器中定位">${esc(f.sample[0])}</div></td>
      <td class="num" style="color:#606a80">${ago(f.mtime)}</td>
    </tr>`;
  }).join('');
  $$('#bigBody .jpath-link').forEach(el => el.onclick = (ev) => {
    ev.stopPropagation();
    revealPath(el.dataset.reveal);
  });
  $$('#bigBody input[type=checkbox]').forEach(cb => cb.onclick = ev => {
    ev.stopPropagation();
    cb.checked ? S.sel.add(cb.dataset.key) : S.sel.delete(cb.dataset.key);
    cb.closest('tr').classList.toggle('sel', cb.checked);
    updateSelBar();
  });
  const vis = rows.map(f => f.key);
  const all = $('#bigCheckAll');
  all.checked = vis.length > 0 && vis.every(k => S.sel.has(k));
  all.onchange = e => {
    vis.forEach(k => e.target.checked ? S.sel.add(k) : S.sel.delete(k));
    renderBig(); updateSelBar();
  };
}

/* ---------------- 在资源管理器中定位 ----------------
   清理页 / 大文件页都显示了文件位置, 能点就应该能直接打开它。 */
function revealPath(p) {
  if (!p) return;
  api('/api/reveal', { path: p }).catch(() => toast('无法打开资源管理器', 'bad'));
}

/* ---------------- 清理 ---------------- */
function renderJunk() {
  const onlySafe = $('#onlySafe').checked, onlyCold = $('#onlyCold').checked;
  const q = $('#junkSearch').value.trim().toLowerCase();
  const rows = S.junk.filter(j => {
    if (onlySafe && j.level !== 'safe') return false;
    if (onlyCold && j.mtime && (Date.now() / 1000 - j.mtime) < 30 * 86400) return false;
    if (q && !(j.sample[0] || j.dir || '').toLowerCase().includes(q)) return false;
    return true;
  });
  const body = $('#junkBody');
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="6" class="placeholder">没有符合条件的项目</td></tr>';
    $('#checkAll').checked = false; return;
  }
  body.innerHTML = rows.map(j => {
    const p = j.sample[0] || j.dir;
    const on = S.sel.has(j.key);
    return `<tr class="${on ? 'sel' : ''} ${j.level === 'never' ? 'locked' : ''}" data-key="${j.key}">
      <td class="c1"><input type="checkbox" ${on ? 'checked' : ''}
        ${j.level === 'never' ? 'disabled' : ''} data-key="${j.key}"></td>
      <td><span class="tg ${j.level}">${j.level === 'safe' ? '可重建' : j.level === 'caution' ? '需确认' : '勿删'}</span>
        <div style="margin-top:3px;color:#9aa4b8">${esc(j.label)}</div></td>
      <td class="num" style="font-family:var(--mono)">${fmt(j.size)}</td>
      <td><div class="jpath jpath-link" data-reveal="${esc(p)}"
        title="点击在资源管理器中定位">${esc(p)}</div>
        ${j.count > 1 ? `<div style="color:#606a80;font-size:11px">共 ${j.count} 个文件</div>` : ''}</td>
      <td><div class="jwhy">${esc(j.why)}</div></td>
      <td class="num" style="color:#606a80">${ago(j.mtime)}</td>
    </tr>`;
  }).join('');

  $$('#junkBody .jpath-link').forEach(el => el.onclick = (ev) => {
    ev.stopPropagation();
    revealPath(el.dataset.reveal);
  });
  $$('#junkBody input[type=checkbox]').forEach(cb => cb.onclick = ev => {
    ev.stopPropagation();
    cb.checked ? S.sel.add(cb.dataset.key) : S.sel.delete(cb.dataset.key);
    cb.closest('tr').classList.toggle('sel', cb.checked);
    updateSelBar();
  });
  const vis = rows.filter(j => j.level !== 'never').map(j => j.key);
  $('#checkAll').checked = vis.length > 0 && vis.every(k => S.sel.has(k));
  $('#checkAll').onchange = e => {
    vis.forEach(k => e.target.checked ? S.sel.add(k) : S.sel.delete(k));
    renderJunk(); updateSelBar();
  };
  updateSelBar();
}

function dedupePaths(paths) {
  const s = [...paths].sort((a, b) => b.length - a.length);
  const out = [];
  for (const p of s) {
    const np = p.replace(/\//g, '\\');
    if (!out.some(q => np.toLowerCase().startsWith(q.replace(/\//g, '\\').toLowerCase() + '\\'))) out.push(p);
  }
  return out;
}
function selectedPaths() {
  return dedupePaths(S.all.filter(j => S.sel.has(j.key)).map(j => j.sample[0] || j.dir).filter(Boolean));
}
function updateSelBar() {
  const paths = selectedPaths();
  const bytes = S.all.filter(j => S.sel.has(j.key)).reduce((s, j) => s + j.size, 0);
  const hasCaution = S.all.some(j => S.sel.has(j.key) && j.level === 'caution');
  const raw = S.all.filter(j => S.sel.has(j.key)).length;
  $('#selCount').textContent = raw;
  $('#selSize').textContent = fmt(bytes);
  $('#selNote').textContent = [
    raw !== paths.length ? `去重后 ${paths.length} 项` : '',
    hasCaution ? '含需确认项' : '',
  ].filter(Boolean).join(' · ');
  $('#doClean').disabled = !paths.length;
  $('#previewBtn').disabled = !paths.length;
  syncCleanbar();
}

/* 底部清理条的显隐策略:
   - 在「清理」/「大文件」页: 完整显示（可预览、可执行）
   - 在其他页且没勾选: 完全隐藏，不占屏稀
   - 在其他页但已有勾选: 收成只读提示条 + 「去清理」按钮
     避免“切到别的页面就看不到自己勾了什么” */
function syncCleanbar() {
  const bar = $('#cleanbar');
  const n = S.all.filter(j => S.sel.has(j.key)).length;
  const canSelect = SELECT_TABS.has(ACTIVE_TAB);
  const slim = !canSelect && n > 0;
  bar.hidden = !(canSelect || slim);
  bar.classList.toggle('slim', slim);
  $('#gotoClean').hidden = !slim;
  $('#selSlimHint').hidden = !slim;
}

function switchTab(name) {
  hideChartTip();
  $$('.tabs button').forEach(x => x.classList.toggle('active', x.dataset.tab === name));
  $$('.tab').forEach(x => x.classList.toggle('active', x.id === 'tab-' + name));
  ACTIVE_TAB = name;
  if (name === 'time') { renderTime(); renderGrowth(); }
  if (name === 'big') { renderBigSummary(); renderExt(); renderBig(); }
  syncCleanbar();
}

/* ---------------- 清理执行 ---------------- */
async function preview() {
  const paths = selectedPaths();
  if (!paths.length) return;
  try {
    const r = await api('/api/clean/dryrun', { paths });
    const lines = r.items.map(i =>
      `${i.exists ? '存在' : '【已不存在】'}  ${fmt(i.size).padStart(9)}  ${i.count} 项  ${i.path}`);
    $('#cfTitle').textContent = `清理预览 (dry-run, 不会删除任何东西)`;
    $('#cfBody').innerHTML =
      `<div>将处理 <b>${r.count}</b> 项, 合计 <b class="cfgood">${fmt(r.total)}</b>。</div>
       ${r.rejected.length ? `<div class="cfwarn">⚠ 已拒绝: ${r.rejected.map(x => esc(x[0]) + ' (' + esc(x[1]) + ')').join('<br>')}</div>` : ''}
       <ul>${lines.map(l => `<li><code>${esc(l)}</code></li>`).join('')}</ul>`;
    $('#cfOk').hidden = true;
    modal('#confirmModal', true);
  } catch (e) { toast(e.message, 'bad'); }
}

async function doCleanFlow() {
  const paths = selectedPaths();
  if (!paths.length) return;
  const mode = $('#cleanMode').value;
  const bytes = S.all.filter(j => S.sel.has(j.key)).reduce((s, j) => s + j.size, 0);
  const warn = [];
  if (S.all.some(j => S.sel.has(j.key) && j.level === 'caution'))
    warn.push('<span class="cfwarn">选中的项目里有"需确认"级别 —— 删掉后需要重新下载或会丢失历史记录。</span>');
  if (mode === 'permanent')
    warn.push('<span class="cfbad">永久删除不可恢复。</span>');
  if (mode === 'quarantine')
    warn.push('<span>会移动到隔离区, 数据保留, 你可以稍后自行确认。</span>');
  else
    warn.push('<span>会移动到 Windows 回收站, 可以随时还原。</span>');

  const sample = paths.slice(0, 8).map(p => `<li><code>${esc(p)}</code></li>`).join('');
  $('#cfTitle').textContent = '确认清理';
  $('#cfBody').innerHTML =
    `<div>即将处理 <b>${paths.length}</b> 项, 预计释放 <b class="cfgood">${fmt(bytes)}</b>。</div>
     ${warn.map(w => `<div style="margin-top:6px">${w}</div>`).join('')}
     <ul>${sample}${paths.length > 8 ? `<li>…以及另外 ${paths.length - 8} 项</li>` : ''}</ul>`;
  $('#cfOk').hidden = false;
  $('#cfOk').textContent = mode === 'permanent' ? '永久删除' : '确认';
  $('#cfOk').className = mode === 'permanent' ? 'danger' : 'danger';
  modal('#confirmModal', true);

  const btn = $('#cfOk');
  const fresh = btn.cloneNode(true);
  btn.parentNode.replaceChild(fresh, btn);
  fresh.onclick = async () => {
    fresh.disabled = true; fresh.textContent = '处理中…';
    try {
      const r = await api('/api/clean', { paths, mode });
      modal('#confirmModal', false);
      const rej = (r.rejected || []).map(x => `拒绝: ${x[0]} (${x[1]})`).join('\n');
      $('#rsBody').textContent =
        `模式: ${r.mode}\n成功: ${r.ok} / ${r.items}\n` +
        (r.note ? `备注: ${r.note}\n` : '') +
        (r.failed && r.failed.length
          ? `失败 ${r.failed.length} 项:\n` + r.failed.slice(0, 20).map(f => `  ${f[0]}\n    ${f[1]}`).join('\n') : '') +
        (rej ? '\n' + rej : '');
      modal('#resultModal', true);
      toast(`清理完成, 成功 ${r.ok} 项`, 'good');
      $('#path').value = $('#path').value; doScan();
    } catch (e) {
      modal('#confirmModal', false); toast(e.message, 'bad');
    }
  };
}

/* ---------------- 目录浏览器 ---------------- */
let browseCur = '';
async function openBrowse() {
  browseCur = $('#path').value.trim() || (await api('/api/drives')).drives[0]?.root || 'C:\\';
  await refreshBrowse(); modal('#browseModal', true);
}
async function refreshBrowse() {
  const r = await api('/api/list?path=' + encodeURIComponent(browseCur));
  browseCur = r.path;
  $('#browsePath').textContent = r.path;
  $('#browseList').innerHTML = (r.error
    ? `<div style="color:#f0576a">${esc(r.error)}</div>` : '') +
    (r.dirs.map(d => `<div data-d="${esc(d)}">📁 ${esc(d)}</div>`).join('') || '<div style="color:#606a80">没有子目录</div>');
  $$('#browseList div[data-d]').forEach(el => el.onclick = async () => {
    browseCur = browseCur.replace(/[\\/]+$/, '') + '\\' + el.dataset.d;
    await refreshBrowse();
  });
}

/* ---------------- 事件绑定 ---------------- */
$('#scan').onclick = doScan;
// 停止立即反馈 (后端扫描器的取消检查已补到目录递归路径)
$('#cancel').onclick = async () => {
  if (!S.jobId) return;
  const btn = $('#cancel');
  btn.disabled = true;
  btn.textContent = '停止中…';
  $('#progressText').textContent = '正在停止扫描…';
  try { await api('/api/cancel/' + S.jobId); } catch (e) { /* 忽略 */ }
};
$('#path').addEventListener('keydown', e => { if (e.key === 'Enter') doScan(); });
$('#browse').onclick = openBrowse;
$('#browseUp').onclick = async () => {
  const p = await api('/api/list?path=' + encodeURIComponent(browseCur));
  if (p.parent && p.parent !== p.path) { browseCur = p.parent; await refreshBrowse(); }
};
$('#browseCancel').onclick = () => modal('#browseModal', false);
$('#browseOk').onclick = () => { $('#path').value = browseCur; modal('#browseModal', false); doScan(); };
$('#tmUp').onclick = () => {
  S.tmNode = popPath(S.tmPath, S.result.root);
  renderTreemap();
};
$$('.tabs button').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
$('#gotoClean').onclick = () => {
  // 只勾了大文件就去大文件页, 否则去清理页
  const big = S.big.some(f => S.sel.has(f.key));
  const junk = S.junk.some(f => S.sel.has(f.key));
  switchTab(big && !junk ? 'big' : 'clean');
};
$('#showCold').onchange = renderTree;
$('#timeRange').onchange = renderTime;
$('#timeUp').onclick = () => {
  S.timeNode = popPath(S.timePath, S.result.root);
  renderTime(); renderGrowth();
};
$('#onlySafe').onchange = renderJunk;
$('#onlyCold').onchange = renderJunk;
$('#junkSearch').oninput = renderJunk;
$('#minSize').onchange = renderBig;
$('#bigCold').onchange = renderBig;
$('#bigSearch').oninput = renderBig;
$('#previewBtn').onclick = preview;
$('#doClean').onclick = doCleanFlow;
$('#cfCancel').onclick = () => modal('#confirmModal', false);
$('#rsOk').onclick = () => modal('#resultModal', false);
window.addEventListener('resize', () => {
  if (S.result && $('#tab-size').classList.contains('active')) renderTreemap();
});

loadDrives();
$('#path').value = 'D:\\';
