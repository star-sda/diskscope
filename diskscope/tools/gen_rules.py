# -*- coding: utf-8 -*-
"""从 rules.py 生成 src/rules.gen.js。

规则表是唯一事实来源, 放在 Python 里 (Python 版仍在用)。
手抄 55 条到 JS 必然出错, 所以这里自动生成, 保证两边永远一致。
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
import rules as P


def glob_to_js_regex(pat):
    """把 shell glob 转成 JS 兼容的正则源码。

    不能直接用 fnmatch.translate(), 它会产出 (?s:...) 作用域标志组和
    (?P<name>...) 命名组, 这两个 JavaScript 都不支持。
    """
    out = ["^"]
    i, n = 0, len(pat)
    while i < n:
        c = pat[i]
        i += 1
        if c == "*":
            out.append(".*")
        elif c == "?":
            out.append(".")
        elif c == "[":
            j = i
            if j < n and pat[j] == "!":
                j += 1
            if j < n and pat[j] == "]":
                j += 1
            while j < n and pat[j] != "]":
                j += 1
            if j >= n:
                out.append(re.escape("["))
            else:
                stuff = pat[i:j]
                i = j + 1
                if stuff.startswith("!"):
                    stuff = "^" + stuff[1:]
                elif stuff.startswith("^"):
                    stuff = "\\" + stuff
                out.append("[" + stuff.replace("\\", "\\\\") + "]")
        else:
            out.append(re.escape(c))
    out.append("$")
    return "".join(out)


def main():
    items = []
    for r in P.DIR_RULES:
        kind = r["match"]
        pattern = r["pattern"]
        rx = None
        if kind == "glob":
            rx = glob_to_js_regex(pattern)
        elif kind == "regex":
            rx = pattern          # 原样带过去, JS/Python 正则语法在这些模式上等价
        items.append({
            "id": r["id"],
            "label": r["label"],
            "why": r["why"],
            "level": r["level"],
            "match": kind,
            "pattern": pattern,
            "rx": rx,
            "isFile": bool(r.get("is_file")),
        })

    def j(o):
        return json.dumps(o, ensure_ascii=False)

    lines = [
        "// 本文件由 tools/gen_rules.py 从 rules.py 自动生成, 请勿手改。",
        "// 改规则请改 rules.py, 然后重新运行:  python tools/gen_rules.py",
        "'use strict';",
        "",
        "const RULE_DATA = [",
    ]
    for it in items:
        parts = [
            "id: " + j(it["id"]),
            "label: " + j(it["label"]),
            "why: " + j(it["why"]),
            "level: " + j(it["level"]),
            "match: " + j(it["match"]),
            "pattern: " + j(it["pattern"]),
        ]
        if it["rx"] is not None:
            parts.append("rx: " + j(it["rx"]))
        if it["isFile"]:
            parts.append("isFile: true")
        lines.append("  { " + ", ".join(parts) + " },")
    lines.append("];")
    lines.append("")
    lines.append("const HARD_SKIP = " + j(sorted(P.HARD_SKIP_NAMES)) + ";")
    lines.append("")
    lines.append("module.exports = { RULE_DATA, HARD_SKIP };")
    lines.append("")

    out = os.path.join(ROOT, "src", "rules.gen.js")
    with open(out, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    files = sum(1 for i in items if i["isFile"])
    print("已生成 %s" % out)
    print("  规则 %d 条 (文件类 %d 条), 硬跳过 %d 项" % (len(items), files, len(P.HARD_SKIP_NAMES)))


if __name__ == "__main__":
    main()
