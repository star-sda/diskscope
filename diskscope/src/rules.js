'use strict';
/**
 * 把生成的规则表编译成可调用的匹配器。
 * rules.gen.js 由 tools/gen_rules.py 从 rules.py 产出, 是唯一事实来源。
 */
const { RULE_DATA, HARD_SKIP } = require('./rules.gen.js');

function compile(r) {
  const out = Object.assign({}, r);
  if (r.match === 'name') {
    out.test = (s) => s === r.pattern;
  } else if (r.rx) {
    const re = new RegExp(r.rx);
    // regex 规则作用于完整路径, glob/name 规则作用于名字
    out.test = r.match === 'regex' ? (p) => re.test(p) : (n) => re.test(n);
  } else {
    out.test = () => false;
  }
  return out;
}

const COMPILED = RULE_DATA.map(compile);
const DIR_RULES = COMPILED.filter((r) => !r.isFile);
const FILE_RULES = COMPILED.filter((r) => r.isFile);

// 精确匹配 (和 Python 版一致), 另外留一份小写表兜底
const HARD_SKIP_SET = new Set(HARD_SKIP);
const HARD_SKIP_LOWER = new Set(HARD_SKIP.map((s) => s.toLowerCase()));

function isHardSkip(name) {
  return HARD_SKIP_SET.has(name) || HARD_SKIP_LOWER.has(name.toLowerCase());
}

module.exports = { DIR_RULES, FILE_RULES, HARD_SKIP_SET, HARD_SKIP_LOWER, isHardSkip, RULE_COUNT: RULE_DATA.length };
