# DiskScope · 目录体积 + 时间轴清理器

找出"是谁在悄悄吃你的硬盘"，并安全地把构建垃圾清掉。

当前有两个可运行的版本:

| | Electron 版 (主) | Python 版 (备) |
|---|---|---|
| 启动 | `dist\DiskScope-1.0.0-绿色版.exe` | 双击 `run.bat` |
| 形态 | 单文件 exe, 双击即用 | 本地服务 + 浏览器 |
| 体积 | 78 MB | 源码, 无需安装 |
| 后端 | Node.js (主进程 + IPC) | Python 标准库 + HTTP |
| 适合 | 日常使用 / 分发给别人 | 二次开发 / 不想装运行时 |

两套后端是同构实现, 共用同一套界面 (HTML/CSS/JS 一字未改), 自检互为对照。

---

## 快速开始

### 装好的直接用

```
dist\DiskScope-1.0.0-安装程序.exe    # 标准安装, 带桌面和开始菜单快捷方式
dist\DiskScope-1.0.0-绿色版.exe      # 单文件免安装, 放哪都能双击
```

绿色版首次运行会解包到 `%LOCALAPPDATA%`, 稍慢几秒; 之后是秒开。

### 开发模式

```
npm install
npm start           # 起 Electron 窗口
npm run uitest      # 界面自检 (自动截图到 tools/shots/)
npm run selftest    # 后端自检 (含真实回收站往返)
npm run check:rules # 规则表行为校验

npm run bench -- D:\       # 测一下扫描速度 (在自己机器上验证)
```

打包后也可以: `DiskScope.exe --bench D:\`
```

### Python 版

```
run.bat             # 或 python server.py
```

---

## 四个页面

### 体积分布
squarified treemap 点方块下钻, 配可展开的层级明细。
`只看最近 30 天有改动的` 一键滤掉冷目录。

### 时间轴
最近 30 天每天写入量 (堆叠柱状图) + "谁在悄悄长大"排行榜。

这是本工具的核心。`target/`、`node_modules/` 会安静地长到几十 GB, 而总览图上只体现为
"一个大方块" —— 时间轴能直接告诉你它**什么时候**开始长的。

### 清理
按危险级别分组的可清理项, 每条都写清楚为什么能删。默认先 dry-run 预演。

### 大文件
面向**普通文件夹** (照片 / 视频 / 安装包 / 归档)。构建垃圾规则不会匹配这些, 所以单独追踪:

- **最大的文件**: Top 200, 可按大小 / 30 天未改动 / 路径筛选
- **文件类型分布**: 按扩展名汇总, 点一行只看该类型

大文件全是 **黄级 (需确认)**, 不会自动勾选。

---

## 危险分级

| 级别 | 含义 | 例子 |
|---|---|---|
| 🟢 可重建 | 删掉自动重新生成, 默认勾选 | `node_modules` `__pycache__` `target` `dist` `build` |
| 🟡 需确认 | 要重新下载, 或会丢历史, 默认不勾选 | `.venv` `vendor` `Pods` `*.log` `.idea` |
| 🔴 勿删 | 只显示大小, 勾选框**直接禁用** | `.git` `*.tfstate` |

53 条规则, 覆盖 Node / Python / JVM / .NET / Rust / Go / iOS / Flutter。
规则表唯一事实来源是 `rules.py`, JS 版由 `tools/gen_rules.py` 自动生成, 两边不会漂移。

### 安全设计

1. **默认进回收站**, 走 Electron 内置 `shell.trashItem`, 可以随时还原
2. **回收站不可用时自动降级**到隔离区 (`<目标所在卷>\.diskscope_quarantine\`), 只改名不删数据
3. **硬性闸门**: 磁盘根目录、工具自身目录和程序文件, 服务端一律拒绝
4. **Electron 安全基线**: `contextIsolation` 开启、`nodeIntegration` 关闭、渲染进程沙箱、
   preload 只暴露白名单方法、内联 CSP 禁止一切外部请求、拒绝在应用内开新窗口
   —— 比 Python 版那套"本地 HTTP + 随机 token"更收紧 (连端口都不占)
5. **嵌套路径自动去重** (选了 `node_modules` 就不会再单独处理它内部的 `.vite`)

---

## 实现要点

**内存与目录数成正比, 不是文件数。**
只有目录创建节点, 文件只累加计数器。扫几十万文件的仓库也不会 OOM。

**时间轴是滚动相加的。**
每个目录存 31 格直方图 (第 0 格 = 今天, 最后一格 = 30 天以前的冷数据),
自底向上逐层相加, 于是任意层级都能 O(1) 回答"这里最近 7 天长了多少"。

**大文件用有界小顶堆。**
堆顶永远是 Top-200 里最小的那个, 新文件比它还小就丢弃 —— 内存恒定在 200 条,
与扫描总量无关。`src/selftest.js` 里有独立的堆正确性单测。

**扫描跑在 worker 线程池里, 主进程只负责派活。**
主进程只做一件事: 把目录分配给空闲的 worker, 把结果挂回树上。
worker 们动态拉活: 大目录的 worker 干得多, 小目录的早早空出来去接新活。

实测数据 (`tools/bench3.js`, 161k 文件):

| worker 数 | 文件/秒 | 相对单线程 |
|---|---|---|
| 1 | 20,844 | 1.0x |
| 4 | 63,343 | 3.0x |
| 8 | 90,923 | 4.4x |
| 16 | 114,088 | **5.5x** |

实际效果 (打包版, `D:\software`): **161,207 个文件 / 1.7 秒 = 94,000 文件/秒**,
比重写前快 **约 3 倍**。

**停止是“立刻”的, 不是“等下一个检查点”。**
取消就是直接 terminate worker 线程 —— 没有任何等待。
实测: 8 万文件待扫, 点「停止」后 **225 ms** 结束 (自然扫完要 1 秒多)。
停止后仍会交账一次聚合数据, 所以已扫到的大文件/扩展名也不丢。
**有上限, 不会卡死**: 文件数上限、耗时上限、深度上限; 触发时顶部横幅明确提示

**绕过 Electron 的 asar 干扰 (影响磁盘总量准确度的坑)。**
Electron 会把"路径最后一个扩展名是 asar 的文件"当成 asar 包来解析:
合法的 asar 返回 **0 字节** (把包根当成虚拟目录), 损坏的 asar 直接抛 "Invalid package" ——
结果是**所有 .asar 文件的大小都统计不准, 磁盘总量偏小**, 而且 stderr 刷错误。
现在统一加 NTFS 备用数据流后缀 `::$DATA` (指向文件本体) 绕过, 路径最后的扩展名变成 DATA, Electron 就不会去解析 asar 了。
扫一个含 22 个 .asar 的目录: 错误从 24 条降到 **0 条**, 大小全部正确。
"结果不完整", 而不是假装扫完了。

---

## 测试

| 命令 | 覆盖 |
|---|---|
| `npm run selftest` | 40 项: MinHeap / 规则 / 扫描聚合 / 垃圾识别 / 时间轴不变量 / 排除 / 大文件 / 扩展名守恒 / dry-run / 删除闸门 / **真实回收站往返** |
| `npm run uitest` | 20 项: preload 注入 / IPC / 扫描全流程 / treemap 下钻 / 时间轴 / 底栏策略 / 大文件筛选 / dry-run 弹窗 / **渲染进程零报错**, 并自动截图 |
| `python selftest.py` | Python 版同样的 40 项 |
| `npm run check:rules` | 27 项规则行为校验 |
| `npm run bench -- <dir>` | 扫描速度实测 (文件/秒, 线程数) |

两个后端各自的 fixture 和断言一一对应, 防止实现漂移。

---

## 打包

```
npx electron-builder --win --x64
```

产物在 `dist/`。`asar` 打包后应用代码只有 110 KB, 78 MB 几乎全是 Electron 运行时 ——
这是 Electron 的固有成本。如果哪天嫌大, C# + WebView2 能压到几 MB, 代价是后端要重写。

---

## 文件结构

```
src/
  main.js        Electron 主进程: 窗口 / IPC / 扫描任务 / 回收站
  preload.js     contextBridge 白名单
  scanner.js     扫描器: 并发遍历 / 直方图 / 有界堆
  rules.js       规则匹配器 (编译自 rules.gen.js)
  rules.gen.js   [自动生成] 由 rules.py 产出, 勿手改
  trash.js       回收站 / 隔离区 / 永久删除 + 删除闸门
  selftest.js    后端自检
  uitest.js      界面自检 (capturePage 自截图)
  ui/            前端 (与 Python 版完全相同的一套)

rules.py         规则表唯一事实来源 (Python 版与 JS 生成器共用)
tools/
  gen_rules.py   rules.py -> rules.gen.js
  check_rules.js 规则行为校验
  shots/         界面自检截图

server.py / scanner.py / trash.py / selftest.py / run.bat   Python 版
```
