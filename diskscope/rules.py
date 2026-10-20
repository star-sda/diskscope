# -*- coding: utf-8 -*-
"""构建垃圾 / 可回收目录的识别规则表。

每条规则:
  id       唯一标识
  label    中文名 (界面上显示)
  why      说明: 为什么可以删
  level    'safe'      -> 删掉会自动重建, 默认勾选
            'caution'   -> 会丢东西 (日志/备份/依赖锁), 默认不勾选
            'never'     -> 只提示, 永不自动勾选 (如 .git)
  match    'name'  目录名完全相等
            'glob'  目录名通配符 (fnmatch)
            'regex' 对完整路径做正则搜索
  pattern  匹配用的字符串
  is_file  True 表示这条规则匹配的是文件而不是目录
"""

DIR_RULES = [
    # ---------- 前端 / Node ----------
    dict(id="node_modules", label="node_modules", why="npm 依赖, `npm install` 可完整重建",
         level="safe", match="name", pattern="node_modules"),
    dict(id="pnpm_store", label=".pnpm-store", why="pnpm 内容寻址存储, 可由 `pnpm install` 重建",
         level="safe", match="name", pattern=".pnpm-store"),
    dict(id="next_cache", label=".next / .nuxt / .svelte-kit", why="前端框架构建缓存与产物",
         level="safe", match="name", pattern=".next"),
    dict(id="nuxt", label=".nuxt", why="Nuxt 构建目录", level="safe", match="name", pattern=".nuxt"),
    dict(id="sveltekit", label=".svelte-kit", why="SvelteKit 构建目录", level="safe", match="name", pattern=".svelte-kit"),
    dict(id="parcel", label=".parcel-cache", why="Parcel 缓存", level="safe", match="name", pattern=".parcel-cache"),
    dict(id="turbo", label=".turbo", why="Turborepo 远程缓存", level="safe", match="name", pattern=".turbo"),
    dict(id="webpack_cache", label=".webpack / .eslintcache", why="打包器与 lint 缓存",
         level="safe", match="glob", pattern=".webpack*"),
    dict(id="vite_cache", label="node_modules/.vite", why="Vite 依赖预构建缓存", level="safe", match="name", pattern=".vite"),
    dict(id="coverage", label="coverage", why="测试覆盖率报告", level="safe", match="name", pattern="coverage"),

    # ---------- 通用构建产物 ----------
    dict(id="dist", label="dist", why="构建输出目录 (webpack/vite 默认产物位置)",
         level="safe", match="name", pattern="dist"),
    dict(id="out", label="out", why="构建输出目录", level="safe", match="name", pattern="out"),
    dict(id="output", label=".output", why="构建输出目录", level="safe", match="name", pattern=".output"),
    dict(id="dart_tool", label=".dart_tool", why="Dart/Flutter 构建缓存 (体积很大)",
         level="safe", match="name", pattern=".dart_tool"),
    dict(id="derived_data", label="DerivedData", why="Xcode 编译产物",
         level="safe", match="name", pattern="DerivedData"),
    dict(id="build_output", label="build", why="构建输出目录 (Gradle / C++ / 通用)",
         level="safe", match="name", pattern="build"),
    dict(id="build_target", label="target", why="构建输出目录 (Maven / Rust / Bazel), 常占项目 90% 空间",
         level="safe", match="name", pattern="target"),
    dict(id="stack_work", label=".stack-work", why="Haskell 构建产物",
         level="safe", match="name", pattern=".stack-work"),
    dict(id="angular", label=".angular", why="Angular 缓存", level="safe", match="name", pattern=".angular"),
    dict(id="expo", label=".expo", why="Expo 缓存", level="safe", match="name", pattern=".expo"),
    dict(id="tox", label=".tox", why="tox 测试环境", level="safe", match="name", pattern=".tox"),
    dict(id="sass_cache", label=".sass-cache", why="Sass 缓存",
         level="safe", match="name", pattern=".sass-cache"),
    dict(id="coverage_files", label=".coverage", why="覆盖率数据文件",
         level="safe", match="glob", pattern=".coverage", is_file=True),

    # ---------- Python ----------
    dict(id="pycache", label="__pycache__", why="Python 字节码缓存, 下次运行自动重生成",
         level="safe", match="name", pattern="__pycache__"),
    dict(id="pytest_cache", label=".pytest_cache", why="pytest 缓存", level="safe", match="name", pattern=".pytest_cache"),
    dict(id="mypy_cache", label=".mypy_cache", why="mypy 类型缓存", level="safe", match="name", pattern=".mypy_cache"),
    dict(id="ruff_cache", label=".ruff_cache", why="ruff lint 缓存", level="safe", match="name", pattern=".ruff_cache"),
    dict(id="ipynb_checkpoints", label=".ipynb_checkpoints", why="Notebook 自动检查点快照",
         level="safe", match="name", pattern=".ipynb_checkpoints"),
    dict(id="pyc_files", label="*.pyc / *.pyo", why="编译后的字节码", level="safe", match="glob",
         pattern="*.py[co]", is_file=True),
    dict(id="venv", label=".venv / venv / env", why="Python 虚拟环境, 可由 requirements 重建",
         level="caution", match="name", pattern=".venv"),
    dict(id="venv2", label="venv", why="Python 虚拟环境", level="caution", match="name", pattern="venv"),
    dict(id="egg_info", label="*.egg-info", why="打包元数据", level="safe", match="glob", pattern="*.egg-info"),

    # ---------- Java / JVM ----------
    dict(id="gradle_cache", label=".gradle", why="Gradle 用户缓存 (体积极大)",
         level="safe", match="name", pattern=".gradle"),
    dict(id="idea_modules", label="*.iml / .idea/workspace.xml", why="IDE 本地索引文件",
         level="safe", match="glob", pattern="*.iml", is_file=True),

    # ---------- .NET / C# / C++ ----------
    dict(id="bin_obj", label="bin / obj", why=".NET 编译中间产物",
         level="safe", match="regex", pattern=r"[/\\](bin|obj)[/\\][^/\\]*$"),
    dict(id="cmake_build", label="cmake-build-*", why="CMake 构建目录",
         level="safe", match="glob", pattern="cmake-build-*"),
    dict(id="debug_build", label="Debug / Release (C++ 输出)",
         why="C++ 编译输出目录, 重新编译可重建 (但耗时)",
         level="caution", match="name", pattern="Debug"),
    dict(id="vcpkg", label="vcpkg_installed", why="C++ 依赖包, 体积很大但重建耗时",
         level="caution", match="name", pattern="vcpkg_installed"),

    # ---------- Rust / Go ----------
    dict(id="go_pkg", label="$GOPATH/pkg", why="Go 模块缓存, 可 `go clean -modcache` 重建",
         level="caution", match="regex", pattern=r"[/\\]pkg[/\\](mod|cache)$"),

    # ---------- Ruby / PHP / 其他 ----------
    dict(id="vendor", label="vendor (PHP/Ruby)", why="Composer/Bundler 依赖, 可由 lock 文件重建",
         level="safe", match="name", pattern="vendor"),
    dict(id="pods", label="Pods (iOS)", why="CocoaPods 依赖, `pod install` 重建 (慢)",
         level="safe", match="name", pattern="Pods"),
    dict(id="bower", label="bower_components", why="Bower 依赖", level="safe", match="name", pattern="bower_components"),
    dict(id="terraform_tfstate", label="*.tfstate", why="Terraform 状态文件, 删掉会丢基础设施状态!",
         level="never", match="glob", pattern="*.tfstate", is_file=True),

    # ---------- 编辑器 / IDE ----------
    dict(id="idea", label=".idea", why="PyCharm/IDEA 本地配置, 可重建但会丢个人配置",
         level="caution", match="name", pattern=".idea"),
    dict(id="vscode", label=".vscode", why="VSCode 配置, 含 settings.json 可能有价值",
         level="caution", match="name", pattern=".vscode"),
    dict(id="vs", label=".vs", why="Visual Studio 本地配置", level="caution", match="name", pattern=".vs"),

    # ---------- 缓存 / 临时 ----------
    dict(id="cache_dir", label=".cache", why="通用缓存目录", level="safe", match="name", pattern=".cache"),
    dict(id="npm_cache", label=".npm", why="npm 全局缓存, 可 `npm cache clean`",
         level="caution", match="name", pattern=".npm"),
    dict(id="temp_dirs", label="tmp / temp / Temp", why="临时目录", level="caution",
         match="name", pattern="Temp"),
    dict(id="log_files", label="*.log", why="日志文件 (删掉会丢历史)", level="caution",
         match="glob", pattern="*.log", is_file=True),
    dict(id="tmp_files", label="*.tmp / *.bak / *.old", why="临时与备份残留文件",
         level="caution", match="glob", pattern="*.tmp", is_file=True),
    dict(id="os_junk", label="Thumbs.db / .DS_Store", why="系统缩略图缓存",
         level="safe", match="glob", pattern="Thumbs.db", is_file=True),

    # ---------- 版本控制: 只提示, 永不自动勾选 ----------
    dict(id="git", label=".git", why="Git 仓库数据! 删除会永久丢失全部历史, 仅供查看",
         level="never", match="name", pattern=".git"),
]

# 扫描时永远跳过的目录 (不计入体积, 避免无限递归与无意义耗时)
HARD_SKIP_NAMES = {"$RECYCLE.BIN", "System Volume Information", ".svn", ".hg"}


def build_matchers():
    """把规则编译成 (rule, matcher) 列表, 供扫描器高性能调用。"""
    import fnmatch
    import re

    compiled = []
    for r in DIR_RULES:
        p = r["pattern"]
        if r["match"] == "name":
            fn = (lambda n, _p=p: n == _p)
        elif r["match"] == "glob":
            fn = (lambda n, _p=p: fnmatch.fnmatchcase(n, _p))
        else:
            rx = re.compile(p)
            fn = (lambda path, _rx=rx: _rx.search(path) is not None)
        compiled.append((r, fn))
    return compiled
